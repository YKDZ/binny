import {
  collectorManifestSchema,
  runtimeDisconnectInputSchema,
  runtimeHeartbeatInputSchema,
  runtimeHeartbeatTimeoutMs,
  type BinError,
  type BinOperation,
  type CollectorManifest,
  type JsonObject,
  type RuntimeConnectionOperations,
  type RuntimeEnvironment,
  type RuntimeExecution,
  type RuntimeHeartbeatInput,
} from "@binny/contracts";

import { validateCollectorConfiguration } from "./bin-configuration.ts";
import type { CoreDatabase, CoreTransaction } from "./database.ts";

type RuntimeConnectionRow = {
  readonly bin_id: string;
  readonly configured_collector: CollectorManifest;
  readonly config: JsonObject;
  readonly runtime_id: string | null;
  readonly runtime_collector: CollectorManifest | null;
  readonly environment: RuntimeEnvironment | null;
  readonly last_heartbeat_at: Date | null;
  readonly disconnected: boolean | null;
};

const tableName = "runtime_connections";
const jsonbType = 3802;
type RuntimeCompatibilityError = {
  readonly code:
    | "runtime_manifest_mismatch"
    | "runtime_configuration_incompatible"
    | "runtime_environment_incompatible";
  readonly message: string;
  readonly path: (string | number)[];
};

function jsonbParameter(database: CoreDatabase, value: unknown) {
  return database.typed(value, jsonbType);
}

function failure<T>(status: 400 | 404 | 409, error: BinError): BinOperation<T> {
  return { ok: false, status, error };
}

function pathParts(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((part) => (typeof part === "symbol" ? String(part) : part));
}

function differencePath(
  expected: unknown,
  actual: unknown,
  prefix: readonly (string | number)[] = [],
): readonly (string | number)[] | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  ) {
    return prefix;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return prefix;
    if (expected.length !== actual.length) return [...prefix, "length"];
    for (let index = 0; index < expected.length; index += 1) {
      const nested = differencePath(expected[index], actual[index], [
        ...prefix,
        index,
      ]);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = [
    ...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]),
  ].sort();
  for (const key of keys) {
    if (!(key in expectedRecord) || !(key in actualRecord))
      return [...prefix, key];
    const nested = differencePath(expectedRecord[key], actualRecord[key], [
      ...prefix,
      key,
    ]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function compatibilityError(
  configuredCollector: CollectorManifest,
  config: JsonObject,
  runtimeCollector: CollectorManifest,
  environment: RuntimeEnvironment,
): RuntimeCompatibilityError | undefined {
  const checkedRuntimeManifest =
    collectorManifestSchema.safeParse(runtimeCollector);
  if (!checkedRuntimeManifest.success) {
    const issue = checkedRuntimeManifest.error.issues[0];
    return {
      code: "runtime_manifest_mismatch",
      message: "运行器提供的采集器清单格式无效。",
      path: ["collector", ...pathParts(issue?.path ?? [])],
    };
  }

  const configValidation = validateCollectorConfiguration(
    runtimeCollector,
    config,
  );
  if (configValidation?.code === "invalid_manifest") {
    return {
      code: "runtime_manifest_mismatch",
      message: "运行器提供的配置声明无法验证。",
      path: configValidation.path ?? ["collector", "configSchema"],
    };
  }
  if (configValidation !== undefined) {
    return {
      code: "runtime_configuration_incompatible",
      message: "已配置的长期配置不符合运行器当前采集器声明。",
      path: configValidation.path ?? ["config"],
    };
  }

  if (
    configuredCollector.environment.browser.required &&
    !environment.browser.available
  ) {
    return {
      code: "runtime_environment_incompatible",
      message: "该采集器需要浏览器，但运行环境没有提供浏览器能力。",
      path: ["collector", "environment", "browser", "required"],
    };
  }
  if (
    configuredCollector.environment.browser.profileReuseAfterRestart &&
    !environment.browser.profileReuseAfterRestart
  ) {
    return {
      code: "runtime_environment_incompatible",
      message: "该采集器需要重启后复用浏览器配置文件，但运行环境不支持。",
      path: ["collector", "environment", "browser", "profileReuseAfterRestart"],
    };
  }

  const manifestDifference = differencePath(
    configuredCollector,
    runtimeCollector,
  );
  if (manifestDifference !== undefined) {
    return {
      code: "runtime_manifest_mismatch",
      message: "运行器采集器清单与已配置版本不一致。",
      path: ["collector", ...manifestDifference],
    };
  }
  return undefined;
}

function offline(
  reason: "runtime_not_connected" | "heartbeat_expired",
  row?: RuntimeConnectionRow,
): RuntimeExecution {
  return {
    status: "offline",
    reason,
    ...(row?.runtime_id === null || row?.runtime_id === undefined
      ? {}
      : { runtimeId: row.runtime_id }),
    ...(row?.last_heartbeat_at === null || row?.last_heartbeat_at === undefined
      ? {}
      : { lastHeartbeatAt: row.last_heartbeat_at.toISOString() }),
  };
}

function rowExecution(row: RuntimeConnectionRow): RuntimeExecution {
  if (
    row.runtime_id === null ||
    row.runtime_collector === null ||
    row.environment === null ||
    row.last_heartbeat_at === null
  ) {
    return offline("runtime_not_connected", row);
  }

  const error = compatibilityError(
    row.configured_collector,
    row.config,
    row.runtime_collector,
    row.environment,
  );
  if (error !== undefined) {
    return {
      status: "incompatible",
      runtimeId: row.runtime_id,
      lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
      error,
    };
  }
  if (row.disconnected === true) return offline("runtime_not_connected", row);
  if (Date.now() - row.last_heartbeat_at.getTime() > runtimeHeartbeatTimeoutMs)
    return offline("heartbeat_expired", row);

  return {
    status: "online",
    runtimeId: row.runtime_id,
    environment: row.environment,
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
  };
}

async function selectRuntimeConnection(
  database: CoreDatabase | CoreTransaction,
  binId: string,
): Promise<RuntimeConnectionRow | undefined> {
  const rows = await database.unsafe<RuntimeConnectionRow[]>(
    "SELECT b.id AS bin_id, b.collector AS configured_collector, b.config, " +
      "r.runtime_id, r.collector AS runtime_collector, r.environment, " +
      "r.last_heartbeat_at, r.disconnected FROM bin_configurations b " +
      "LEFT JOIN " +
      tableName +
      " r ON r.bin_id = b.id WHERE b.id = $1",
    [binId],
  );
  return rows[0];
}

export async function readRuntimeExecution(
  database: CoreDatabase | CoreTransaction,
  binId: string,
): Promise<BinOperation<RuntimeExecution>> {
  const row = await selectRuntimeConnection(database, binId);
  return row === undefined
    ? failure(404, {
        code: "bin_not_found",
        message: "没有找到这个 bin。",
        path: ["binId"],
      })
    : { ok: true, value: rowExecution(row) };
}

export function createRuntimeConnectionStore(
  database: CoreDatabase,
): RuntimeConnectionOperations {
  return {
    async getExecution(binId) {
      return await readRuntimeExecution(database, binId);
    },

    async heartbeat(binId, input: RuntimeHeartbeatInput) {
      const checked = runtimeHeartbeatInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return failure(400, {
          code: "invalid_input",
          message: issue?.message ?? "运行器心跳格式无效。",
          ...(issue === undefined ? {} : { path: pathParts(issue.path) }),
        });
      }
      const current = await selectRuntimeConnection(database, binId);
      if (current === undefined) {
        return failure(404, {
          code: "bin_not_found",
          message: "没有找到这个 bin。",
          path: ["binId"],
        });
      }

      await database.unsafe(
        "INSERT INTO " +
          tableName +
          " (bin_id, runtime_id, collector, environment, last_heartbeat_at, disconnected) " +
          "VALUES ($1, $2, $3, $4, now(), false) " +
          "ON CONFLICT (bin_id) DO UPDATE SET runtime_id = EXCLUDED.runtime_id, " +
          "collector = EXCLUDED.collector, environment = EXCLUDED.environment, " +
          "last_heartbeat_at = now(), disconnected = false",
        [
          binId,
          checked.data.runtimeId,
          jsonbParameter(database, checked.data.collector),
          jsonbParameter(database, checked.data.environment),
        ],
      );

      const row = await selectRuntimeConnection(database, binId);
      if (row === undefined) {
        throw new Error("心跳写入后 bin 配置意外消失。");
      }
      const execution = rowExecution(row);
      return execution.status === "incompatible"
        ? { ok: false, status: 409, error: execution.error }
        : { ok: true, value: execution };
    },

    async disconnect(binId, input) {
      const checked = runtimeDisconnectInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return failure(400, {
          code: "invalid_input",
          message: issue?.message ?? "运行器断开信息无效。",
          ...(issue === undefined ? {} : { path: pathParts(issue.path) }),
        });
      }
      await database.unsafe(
        "UPDATE " +
          tableName +
          " SET disconnected = true WHERE bin_id = $1 AND runtime_id = $2",
        [binId, checked.data.runtimeId],
      );
      const current = await selectRuntimeConnection(database, binId);
      if (current === undefined) {
        return failure(404, {
          code: "bin_not_found",
          message: "没有找到这个 bin。",
          path: ["binId"],
        });
      }
      // 旧运行器退出时不能覆盖同一 bin 新运行器的在线状态。
      return { ok: true, value: rowExecution(current) };
    },
  };
}
