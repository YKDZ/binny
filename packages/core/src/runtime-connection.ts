import {
  collectorManifestSchema,
  jsonObjectSchema,
  runtimeDisconnectInputSchema,
  runtimeEnvironmentSchema,
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
import {
  binConfigurations,
  runtimeConnections,
  type Database,
  type Transaction,
} from "@binny/db";
import { and, eq, sql } from "drizzle-orm";

import { validateCollectorConfiguration } from "./bin-configuration.ts";
import {
  confirmManualRunOwnerStopped,
  interruptExpiredManualRuns,
  interruptReplacedManualRuns,
} from "./manual-run-fencing.ts";

const runtimeSelection = {
  binId: binConfigurations.id,
  configuredCollector: binConfigurations.collector,
  config: binConfigurations.config,
  runtimeId: runtimeConnections.runtimeId,
  runtimeCollector: runtimeConnections.collector,
  environment: runtimeConnections.environment,
  lastHeartbeatAt: runtimeConnections.lastHeartbeatAt,
  disconnected: runtimeConnections.disconnected,
  ownerState: runtimeConnections.ownerState,
  ownerGeneration: runtimeConnections.ownerGeneration,
};

type RuntimeCompatibilityError = {
  readonly code:
    | "runtime_manifest_mismatch"
    | "runtime_configuration_incompatible"
    | "runtime_environment_incompatible";
  readonly message: string;
  readonly path: (string | number)[];
};

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
    ...(row?.runtimeId === null || row?.runtimeId === undefined
      ? {}
      : { runtimeId: row.runtimeId }),
    ...(row?.lastHeartbeatAt === null || row?.lastHeartbeatAt === undefined
      ? {}
      : { lastHeartbeatAt: row.lastHeartbeatAt.toISOString() }),
  };
}

function rowExecution(row: RuntimeConnectionRow): RuntimeExecution {
  if (
    row.runtimeId === null ||
    row.runtimeCollector === null ||
    row.environment === null ||
    row.lastHeartbeatAt === null
  ) {
    return offline("runtime_not_connected", row);
  }

  const error = compatibilityError(
    collectorManifestSchema.parse(row.configuredCollector),
    jsonObjectSchema.parse(row.config),
    collectorManifestSchema.parse(row.runtimeCollector),
    runtimeEnvironmentSchema.parse(row.environment),
  );
  if (error !== undefined) {
    return {
      status: "incompatible",
      runtimeId: row.runtimeId,
      lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
      error,
    };
  }
  if (row.disconnected === true) return offline("runtime_not_connected", row);
  if (Date.now() - row.lastHeartbeatAt.getTime() > runtimeHeartbeatTimeoutMs)
    return offline("heartbeat_expired", row);

  return {
    status: "online",
    runtimeId: row.runtimeId,
    environment: runtimeEnvironmentSchema.parse(row.environment),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
  };
}

async function selectRuntimeConnection(
  database: Database | Transaction,
  binId: string,
) {
  const [row] = await database
    .select(runtimeSelection)
    .from(binConfigurations)
    .leftJoin(
      runtimeConnections,
      eq(runtimeConnections.binId, binConfigurations.id),
    )
    .where(eq(binConfigurations.id, binId));
  return row;
}

type RuntimeConnectionRow = NonNullable<
  Awaited<ReturnType<typeof selectRuntimeConnection>>
>;

export async function readRuntimeExecution(
  database: Database | Transaction,
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
  database: Database,
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
      return await database.transaction(async (transaction) => {
        const [bin] = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined) {
          return failure(404, {
            code: "bin_not_found",
            message: "没有找到这个 bin。",
            path: ["binId"],
          });
        }

        const [current] = await transaction
          .select({
            runtimeId: runtimeConnections.runtimeId,
            ownerState: runtimeConnections.ownerState,
            ownerGeneration: runtimeConnections.ownerGeneration,
          })
          .from(runtimeConnections)
          .where(eq(runtimeConnections.binId, binId));
        const incomingGeneration = BigInt(checked.data.ownerGeneration);
        const currentGeneration = current?.ownerGeneration;
        // 在 bin 行锁下比较已记录代际，使未登记的旧首包也会被新 owner 淘汰。
        if (
          current !== undefined &&
          currentGeneration !== undefined &&
          incomingGeneration < currentGeneration
        ) {
          return failure(409, {
            code: "runtime_owner_mismatch",
            message: "运行器所有权代际已过期，不能覆盖当前所有者。",
            path: ["ownerGeneration"],
          });
        }
        if (
          current !== undefined &&
          currentGeneration !== undefined &&
          incomingGeneration === currentGeneration &&
          current.runtimeId !== checked.data.runtimeId
        ) {
          return failure(409, {
            code: "runtime_owner_mismatch",
            message: "相同所有权代际只能由原运行器继续持有。",
            path: ["ownerGeneration"],
          });
        }
        if (
          current !== undefined &&
          currentGeneration !== undefined &&
          incomingGeneration > currentGeneration &&
          current.runtimeId === checked.data.runtimeId
        ) {
          return failure(409, {
            code: "runtime_owner_mismatch",
            message: "运行器身份不能切换到新的所有权代际。",
            path: ["ownerGeneration"],
          });
        }

        const expiredRunIds = await interruptExpiredManualRuns(
          transaction,
          binId,
        );
        let ownerState: "confirmed" | "unconfirmed" =
          current?.ownerState === "unconfirmed" || expiredRunIds.length > 0
            ? "unconfirmed"
            : "confirmed";

        if (
          current !== undefined &&
          current.runtimeId !== checked.data.runtimeId
        ) {
          if (
            checked.data.activeRunId !== null ||
            checked.data.claimInFlight ||
            checked.data.stoppedRunId !== undefined
          ) {
            return failure(409, {
              code: "runtime_owner_mismatch",
              message: "新运行器尚未确认旧执行进程已经退出。",
              path: ["activeRunId"],
            });
          }
          await interruptReplacedManualRuns(
            transaction,
            binId,
            current.runtimeId,
          );
          ownerState = "confirmed";
        } else if (checked.data.stoppedRunId !== undefined) {
          const stopped = await confirmManualRunOwnerStopped(
            transaction,
            binId,
            checked.data.runtimeId,
            checked.data.stoppedRunId,
          );
          if (stopped) ownerState = "confirmed";
        }

        await transaction
          .insert(runtimeConnections)
          .values({
            binId,
            runtimeId: checked.data.runtimeId,
            collector: checked.data.collector,
            environment: checked.data.environment,
            disconnected: false,
            ownerState,
            ownerGeneration: incomingGeneration,
          })
          .onConflictDoUpdate({
            target: runtimeConnections.binId,
            set: {
              runtimeId: checked.data.runtimeId,
              collector: checked.data.collector,
              environment: checked.data.environment,
              // 保持 PostgreSQL 服务端时钟语义。
              lastHeartbeatAt: sql`clock_timestamp()`,
              disconnected: false,
              ownerState,
              ownerGeneration: incomingGeneration,
            },
          });

        const row = await selectRuntimeConnection(transaction, binId);
        if (row === undefined) throw new Error("心跳写入后 bin 配置意外消失。");
        const execution = rowExecution(row);
        return execution.status === "incompatible"
          ? { ok: false, status: 409, error: execution.error }
          : { ok: true, value: execution };
      });
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
      return await database.transaction(async (transaction) => {
        const [bin] = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined) {
          return failure(404, {
            code: "bin_not_found",
            message: "没有找到这个 bin。",
            path: ["binId"],
          });
        }
        await transaction
          .update(runtimeConnections)
          .set({ disconnected: true })
          .where(
            and(
              eq(runtimeConnections.binId, binId),
              eq(runtimeConnections.runtimeId, checked.data.runtimeId),
            ),
          );
        const current = await selectRuntimeConnection(transaction, binId);
        if (current === undefined)
          throw new Error("运行器断开后 bin 配置意外消失。");
        // 旧运行器退出时不能覆盖同一 bin 新运行器的在线状态。
        return { ok: true, value: rowExecution(current) };
      });
    },
  };
}
