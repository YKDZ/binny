import { isDeepStrictEqual } from "node:util";

import {
  jsonObjectSchema,
  runtimeActionParametersValidationInputSchema,
  runtimeActionParametersValidationPath,
  runtimeActionParametersValidationResultSchema,
  runtimeControlUrlSchema,
  runtimeHeartbeatTimeoutMs,
  sourceAdapterManifestStoredSchema,
  type JsonObject,
  type SourceAdapterManifest,
} from "@binny/contracts";
import {
  binConfigurations,
  runtimeConnections,
  type Database,
  type Transaction,
} from "@binny/db";
import { eq } from "drizzle-orm";

import { readRuntimeExecution } from "./runtime-connection.ts";

export type RuntimeActionValidationError = {
  readonly code:
    | "action_not_found"
    | "invalid_action_parameters"
    | "runtime_action_validation_unavailable";
  readonly message: string;
  readonly path?: (string | number)[];
};

export type RuntimeActionValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "unavailable";
      readonly error: RuntimeActionValidationError;
    };

type ActionInputSnapshot = {
  readonly binId: string;
  readonly identityId: string;
  readonly sourceAdapter: unknown;
  readonly config: unknown;
  readonly configNativeValid: boolean;
  readonly status: "active" | "disabled";
  readonly runtimeId: string | null;
  readonly runtimeSourceAdapter: unknown;
  readonly runtimeControlUrl: string | null;
  readonly protocolVersion: number | null;
  readonly ownerState: "confirmed" | "unconfirmed" | null;
  readonly ownerGeneration: bigint | null;
  readonly disconnected: boolean | null;
  readonly lastHeartbeatAt: Date | null;
};

export type ActionInputPreflight =
  | { readonly ok: true; readonly snapshot: ActionInputSnapshot }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 409;
      readonly error: {
        readonly code:
          | "bin_not_found"
          | "bin_disabled"
          | "invalid_configuration"
          | "action_not_found"
          | "invalid_action_parameters"
          | "runtime_action_validation_unavailable";
        readonly message: string;
        readonly path?: (string | number)[];
      };
    };

type ActionInputPreflightError = Extract<
  ActionInputPreflight,
  { readonly ok: false }
>["error"];

function unavailable(message: string): RuntimeActionValidationResult {
  return {
    ok: false,
    kind: "unavailable",
    error: {
      code: "runtime_action_validation_unavailable",
      message,
      path: ["params"],
    },
  };
}

/** 请当前运行器按 SDK 声明解析原始动作参数。 */
export async function validateActionParametersAtRuntime(
  controlUrl: string,
  sourceAdapter: SourceAdapterManifest,
  action: string,
  params: JsonObject,
): Promise<RuntimeActionValidationResult> {
  const checkedUrl = runtimeControlUrlSchema.safeParse(controlUrl);
  if (!checkedUrl.success)
    return unavailable("运行器没有提供可用的内部控制地址。");

  const checkedInput = runtimeActionParametersValidationInputSchema.safeParse({
    sourceAdapterId: sourceAdapter.id,
    sourceAdapterVersion: sourceAdapter.version,
    action,
    params,
  });
  if (!checkedInput.success) {
    return {
      ok: false,
      kind: "invalid",
      error: {
        code: "invalid_action_parameters",
        message: checkedInput.error.issues[0]?.message ?? "动作参数格式无效。",
        path: ["params"],
      },
    };
  }

  try {
    const response = await fetch(
      new URL(runtimeActionParametersValidationPath, checkedUrl.data),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkedInput.data),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const result = runtimeActionParametersValidationResultSchema.safeParse(
      await response.json(),
    );
    if (!result.success)
      return unavailable("运行器返回了无法识别的动作参数校验结果。");
    if (result.data.valid) {
      return response.status === 200
        ? { ok: true }
        : unavailable("运行器返回的动作参数校验状态不匹配。");
    }
    if (result.data.error.code === "source_adapter_version_mismatch") {
      return response.status === 409
        ? unavailable(result.data.error.message)
        : unavailable("运行器返回的动作参数校验状态不匹配。");
    }
    if (response.status !== 422)
      return unavailable("运行器返回了无法识别的动作参数校验状态。");

    return {
      ok: false,
      kind: "invalid",
      error: {
        code: result.data.error.code,
        message: result.data.error.message,
        path:
          result.data.error.path === undefined
            ? result.data.error.code === "action_not_found"
              ? ["action"]
              : ["params"]
            : result.data.error.code === "action_not_found"
              ? result.data.error.path
              : ["params", ...result.data.error.path],
      },
    };
  } catch {
    return unavailable(
      "无法连接当前运行器验证动作参数；请确认运行器在线后重试。",
    );
  }
}

async function selectActionInputSnapshot(
  database: Database | Transaction,
  binId: string,
): Promise<ActionInputSnapshot | undefined> {
  const [row] = await database
    .select({
      binId: binConfigurations.id,
      identityId: binConfigurations.identityId,
      sourceAdapter: binConfigurations.sourceAdapter,
      config: binConfigurations.config,
      configNativeValid: binConfigurations.configNativeValid,
      status: binConfigurations.status,
      runtimeId: runtimeConnections.runtimeId,
      runtimeSourceAdapter: runtimeConnections.sourceAdapter,
      runtimeControlUrl: runtimeConnections.runtimeControlUrl,
      protocolVersion: runtimeConnections.protocolVersion,
      ownerState: runtimeConnections.ownerState,
      ownerGeneration: runtimeConnections.ownerGeneration,
      disconnected: runtimeConnections.disconnected,
      lastHeartbeatAt: runtimeConnections.lastHeartbeatAt,
    })
    .from(binConfigurations)
    .leftJoin(
      runtimeConnections,
      eq(runtimeConnections.binId, binConfigurations.id),
    )
    .where(eq(binConfigurations.id, binId));
  return row;
}

function failure(
  status: 400 | 404 | 409,
  code: ActionInputPreflightError["code"],
  message: string,
  path?: readonly (string | number)[],
): ActionInputPreflight {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      ...(path === undefined ? {} : { path: [...path] }),
    },
  };
}

/** 新参数写入事务前，先由运行器执行完整原生校验。 */
export async function preflightActionInput(
  database: Database,
  binId: string,
  action: string,
  params: JsonObject,
): Promise<ActionInputPreflight> {
  const { snapshot, execution } = await database.transaction(
    async (transaction) => {
      const currentSnapshot = await selectActionInputSnapshot(
        transaction,
        binId,
      );
      const runtimeExecution = await readRuntimeExecution(transaction, binId);
      return { snapshot: currentSnapshot, execution: runtimeExecution };
    },
  );
  if (snapshot === undefined)
    return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
  if (snapshot.status === "disabled")
    return failure(409, "bin_disabled", "这个 bin 已停用，不能接受新动作。", [
      "binId",
    ]);
  if (!snapshot.configNativeValid)
    return failure(
      400,
      "invalid_configuration",
      "长期配置尚未通过当前运行器的原生校验，请先更新配置。",
      ["config"],
    );
  if (
    !execution.ok ||
    execution.value.status !== "online" ||
    snapshot.runtimeId === null ||
    snapshot.runtimeControlUrl === null ||
    snapshot.ownerState !== "confirmed" ||
    snapshot.disconnected !== false ||
    snapshot.lastHeartbeatAt === null ||
    Date.now() - snapshot.lastHeartbeatAt.getTime() > runtimeHeartbeatTimeoutMs
  ) {
    return failure(
      409,
      "runtime_action_validation_unavailable",
      "当前运行器离线或不兼容，不能验证新的动作参数。",
      ["params"],
    );
  }

  const sourceAdapter = sourceAdapterManifestStoredSchema.parse(
    snapshot.sourceAdapter,
  );
  const native = await validateActionParametersAtRuntime(
    snapshot.runtimeControlUrl,
    sourceAdapter,
    action,
    jsonObjectSchema.parse(params),
  );
  if (!native.ok) {
    return failure(
      native.kind === "invalid" ? 400 : 409,
      native.error.code,
      native.error.message,
      native.error.path,
    );
  }
  return { ok: true, snapshot };
}

/** 保存前重新确认预检使用的配置、清单和运行器仍未变化。 */
export async function actionInputSnapshotStillCurrent(
  transaction: Transaction,
  previous: ActionInputSnapshot,
): Promise<boolean> {
  const current = await selectActionInputSnapshot(transaction, previous.binId);
  if (current === undefined) return false;
  const execution = await readRuntimeExecution(transaction, previous.binId);
  if (!execution.ok || execution.value.status !== "online") return false;
  if (
    current.runtimeId === null ||
    current.runtimeControlUrl === null ||
    current.ownerState !== "confirmed" ||
    current.disconnected !== false ||
    current.lastHeartbeatAt === null ||
    Date.now() - current.lastHeartbeatAt.getTime() > runtimeHeartbeatTimeoutMs
  ) {
    return false;
  }

  return isDeepStrictEqual(
    {
      binId: previous.binId,
      identityId: previous.identityId,
      sourceAdapter: previous.sourceAdapter,
      config: previous.config,
      configNativeValid: previous.configNativeValid,
      status: previous.status,
      runtimeId: previous.runtimeId,
      runtimeSourceAdapter: previous.runtimeSourceAdapter,
      runtimeControlUrl: previous.runtimeControlUrl,
      protocolVersion: previous.protocolVersion,
      ownerState: previous.ownerState,
      ownerGeneration: previous.ownerGeneration,
      disconnected: previous.disconnected,
    },
    {
      binId: current.binId,
      identityId: current.identityId,
      sourceAdapter: current.sourceAdapter,
      config: current.config,
      configNativeValid: current.configNativeValid,
      status: current.status,
      runtimeId: current.runtimeId,
      runtimeSourceAdapter: current.runtimeSourceAdapter,
      runtimeControlUrl: current.runtimeControlUrl,
      protocolVersion: current.protocolVersion,
      ownerState: current.ownerState,
      ownerGeneration: current.ownerGeneration,
      disconnected: current.disconnected,
    },
  );
}
