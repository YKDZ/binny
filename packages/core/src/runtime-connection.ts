import { isDeepStrictEqual } from "node:util";

import {
  sourceAdapterManifestStoredSchema,
  jsonObjectSchema,
  runtimeDisconnectInputSchema,
  runtimeEnvironmentSchema,
  runtimeEnvironmentStoredSchema,
  runtimeHeartbeatInputSchema,
  runtimeHeartbeatTimeoutMs,
  runtimeProtocolVersion,
  type BinError,
  type BinOperation,
  type SourceAdapterManifest,
  type JsonObject,
  type RuntimeConnectionOperations,
  type RuntimeEnvironment,
  type RuntimeExecution,
  type RuntimeHeartbeatResult,
  type RuntimeHeartbeatInput,
} from "@binny/contracts";
import {
  binConfigurations,
  runtimeConnections,
  type Database,
  type Transaction,
} from "@binny/db";
import { and, eq, sql } from "drizzle-orm";

import { validateSourceAdapterConfiguration } from "./bin-configuration.ts";
import type { BrowserCapacityCoordinator } from "./browser-capacity.ts";
import { applyRuntimeHumanSessionHeartbeat } from "./human-session.ts";
import {
  confirmManualRunOwnerStopped,
  interruptExpiredManualRuns,
  interruptReplacedManualRuns,
} from "./manual-run-fencing.ts";
import { validateConfigurationAtRuntime } from "./runtime-configuration-validation.ts";

const runtimeSelection = {
  binId: binConfigurations.id,
  configuredSourceAdapter: binConfigurations.sourceAdapter,
  config: binConfigurations.config,
  configNativeValid: binConfigurations.configNativeValid,
  browserIdleTimeoutSeconds: binConfigurations.browserIdleTimeoutSeconds,
  runtimeId: runtimeConnections.runtimeId,
  runtimeSourceAdapter: runtimeConnections.sourceAdapter,
  environment: runtimeConnections.environment,
  lastHeartbeatAt: runtimeConnections.lastHeartbeatAt,
  disconnected: runtimeConnections.disconnected,
  ownerState: runtimeConnections.ownerState,
  ownerGeneration: runtimeConnections.ownerGeneration,
  protocolVersion: runtimeConnections.protocolVersion,
  runtimeControlUrl: runtimeConnections.runtimeControlUrl,
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
  configuredSourceAdapter: SourceAdapterManifest,
  config: JsonObject,
  configNativeValid: boolean,
  runtimeSourceAdapter: SourceAdapterManifest,
  environment: RuntimeEnvironment,
): RuntimeCompatibilityError | undefined {
  if (!configNativeValid) {
    return {
      code: "runtime_configuration_incompatible",
      message: "首次原生配置不完整；请先在核心中填写并验证长期配置。",
      path: ["config"],
    };
  }
  const checkedRuntimeManifest =
    sourceAdapterManifestStoredSchema.safeParse(runtimeSourceAdapter);
  if (!checkedRuntimeManifest.success) {
    const issue = checkedRuntimeManifest.error.issues[0];
    return {
      code: "runtime_manifest_mismatch",
      message: "运行器提供的信源适配器清单格式无效。",
      path: ["sourceAdapter", ...pathParts(issue?.path ?? [])],
    };
  }

  const configValidation = validateSourceAdapterConfiguration(
    runtimeSourceAdapter,
    config,
  );
  if (configValidation?.code === "invalid_manifest") {
    return {
      code: "runtime_manifest_mismatch",
      message: "运行器提供的配置声明无法验证。",
      path: configValidation.path ?? ["sourceAdapter", "configSchema"],
    };
  }
  if (configValidation !== undefined) {
    return {
      code: "runtime_configuration_incompatible",
      message: "已配置的长期配置不符合运行器当前信源适配器声明。",
      path: configValidation.path ?? ["config"],
    };
  }

  if (
    configuredSourceAdapter.environment.browser.required &&
    !environment.browser.available
  ) {
    return {
      code: "runtime_environment_incompatible",
      message: "该信源适配器需要浏览器，但运行环境没有提供浏览器能力。",
      path: ["sourceAdapter", "environment", "browser", "required"],
    };
  }
  if (
    configuredSourceAdapter.environment.browser.profileReuseAfterRestart &&
    !environment.browser.profileReuseAfterRestart
  ) {
    return {
      code: "runtime_environment_incompatible",
      message: "该信源适配器需要重启后复用浏览器配置文件，但运行环境不支持。",
      path: [
        "sourceAdapter",
        "environment",
        "browser",
        "profileReuseAfterRestart",
      ],
    };
  }

  const manifestDifference = differencePath(
    configuredSourceAdapter,
    runtimeSourceAdapter,
  );
  if (manifestDifference !== undefined) {
    return {
      code: "runtime_manifest_mismatch",
      message: "运行器信源适配器清单与已配置版本不一致。",
      path: ["sourceAdapter", ...manifestDifference],
    };
  }
  return undefined;
}

function offline(
  reason:
    | "runtime_not_connected"
    | "heartbeat_expired"
    | "runtime_protocol_outdated",
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
    row.runtimeSourceAdapter === null ||
    row.environment === null ||
    row.lastHeartbeatAt === null
  ) {
    return offline("runtime_not_connected", row);
  }

  if (row.protocolVersion !== runtimeProtocolVersion) {
    return offline("runtime_protocol_outdated", row);
  }

  const configuredSourceAdapter = sourceAdapterManifestStoredSchema.parse(
    row.configuredSourceAdapter,
  );
  const runtimeSourceAdapter = sourceAdapterManifestStoredSchema.parse(
    row.runtimeSourceAdapter,
  );
  const config = jsonObjectSchema.parse(row.config);
  const storedEnvironment = runtimeEnvironmentStoredSchema.parse(
    row.environment,
  );

  if (storedEnvironment.browser.power === undefined) {
    if (row.disconnected === true) return offline("runtime_not_connected", row);
    // 旧协议快照没有报告浏览器电源状态，不能据此推断已停止或就绪。
    return offline("runtime_protocol_outdated", row);
  }

  const environment = runtimeEnvironmentSchema.parse(storedEnvironment);
  const error = compatibilityError(
    configuredSourceAdapter,
    config,
    row.configNativeValid,
    runtimeSourceAdapter,
    environment,
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
    environment,
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
  browserCapacity: BrowserCapacityCoordinator,
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

      const incoming = checked.data;
      const before = await selectRuntimeConnection(database, binId);
      let registration:
        | {
            readonly kind: "create";
            readonly config: JsonObject;
            readonly nativeValid: boolean;
          }
        | {
            readonly kind: "manifest-update";
            readonly sourceAdapter: SourceAdapterManifest;
            readonly config: JsonObject;
            readonly configNativeValid: boolean;
            readonly runtimeId: string | null;
            readonly ownerGeneration: bigint | null;
            readonly protocolVersion: number | null;
            readonly runtimeControlUrl: string | null;
            readonly runtimeSourceAdapter: unknown;
          }
        | undefined;

      if (before === undefined) {
        if (incoming.protocolVersion !== runtimeProtocolVersion) {
          return failure(409, {
            code: "runtime_configuration_validation_unavailable",
            message: "首次登记必须使用支持内部原生配置校验的运行器协议。",
            path: ["protocolVersion"],
          });
        }
        const sourceAdapter = sourceAdapterManifestStoredSchema.parse(
          incoming.sourceAdapter,
        );
        const validation = await validateConfigurationAtRuntime(
          incoming.runtimeControlUrl,
          sourceAdapter,
          jsonObjectSchema.parse({}),
        );
        if (!validation.ok && validation.kind === "unavailable") {
          return failure(409, validation.error);
        }
        registration = {
          kind: "create",
          config: jsonObjectSchema.parse({}),
          nativeValid: validation.ok,
        };
      } else if (
        !isDeepStrictEqual(
          before.configuredSourceAdapter,
          incoming.sourceAdapter,
        )
      ) {
        if (incoming.protocolVersion !== runtimeProtocolVersion) {
          return failure(409, {
            code: "runtime_configuration_validation_unavailable",
            message: "旧版运行器不能更新已登记的源码声明。",
            path: ["protocolVersion"],
          });
        }
        const sourceAdapter = sourceAdapterManifestStoredSchema.parse(
          incoming.sourceAdapter,
        );
        const config = jsonObjectSchema.parse(before.config);
        const validation = await validateConfigurationAtRuntime(
          incoming.runtimeControlUrl,
          sourceAdapter,
          config,
        );
        if (!validation.ok && validation.kind === "unavailable") {
          return failure(409, validation.error);
        }
        registration = {
          kind: "manifest-update",
          sourceAdapter,
          config,
          configNativeValid: validation.ok,
          runtimeId: before.runtimeId,
          ownerGeneration: before.ownerGeneration,
          protocolVersion: before.protocolVersion,
          runtimeControlUrl: before.runtimeControlUrl,
          runtimeSourceAdapter: before.runtimeSourceAdapter,
        };
      }

      return await database.transaction(async (transaction) => {
        let [bin] = await transaction
          .select({
            id: binConfigurations.id,
            sourceAdapter: binConfigurations.sourceAdapter,
            config: binConfigurations.config,
          })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined) {
          if (registration?.kind !== "create") {
            return failure(409, {
              code: "configuration_changed",
              message: "bin 在心跳准备期间发生变化，请重试。",
              path: ["binId"],
            });
          }
          const [created] = await transaction
            .insert(binConfigurations)
            .values({
              id: binId,
              sourceAdapter: incoming.sourceAdapter,
              identityId: binId,
              config: registration.config,
              configNativeValid: registration.nativeValid,
              browserIdleTimeoutSeconds: 300,
              status: "active",
            })
            .onConflictDoNothing({ target: binConfigurations.id })
            .returning({
              id: binConfigurations.id,
              sourceAdapter: binConfigurations.sourceAdapter,
              config: binConfigurations.config,
            });
          [bin] =
            created === undefined
              ? await transaction
                  .select({
                    id: binConfigurations.id,
                    sourceAdapter: binConfigurations.sourceAdapter,
                    config: binConfigurations.config,
                  })
                  .from(binConfigurations)
                  .where(eq(binConfigurations.id, binId))
                  .for("update")
              : [created];
          if (bin === undefined) throw new Error("自注册后没有找到 bin。");
          if (
            !isDeepStrictEqual(bin.sourceAdapter, incoming.sourceAdapter) ||
            !isDeepStrictEqual(bin.config, registration.config)
          ) {
            return failure(409, {
              code: "configuration_changed",
              message: "另一个运行器已使用相同 bin 身份完成注册。",
              path: ["binId"],
            });
          }
        } else if (registration?.kind === "create") {
          if (
            !isDeepStrictEqual(bin.sourceAdapter, incoming.sourceAdapter) ||
            !isDeepStrictEqual(bin.config, registration.config)
          ) {
            return failure(409, {
              code: "configuration_changed",
              message: "bin 在首次原生校验期间已被其他操作改变。",
              path: ["binId"],
            });
          }
        } else if (registration?.kind === "manifest-update") {
          if (
            !isDeepStrictEqual(bin.sourceAdapter, registration.sourceAdapter) &&
            !isDeepStrictEqual(
              bin.sourceAdapter,
              before?.configuredSourceAdapter,
            )
          ) {
            return failure(409, {
              code: "configuration_changed",
              message: "源码声明在原生校验期间发生变化，请重试。",
              path: ["sourceAdapter"],
            });
          }
          if (
            !isDeepStrictEqual(bin.config, registration.config) ||
            !isDeepStrictEqual(
              bin.sourceAdapter,
              before?.configuredSourceAdapter,
            )
          ) {
            return failure(409, {
              code: "configuration_changed",
              message: "配置或源码声明在原生校验期间发生变化，请重试。",
              path: ["config"],
            });
          }
        }

        const [current] = await transaction
          .select({
            runtimeId: runtimeConnections.runtimeId,
            ownerState: runtimeConnections.ownerState,
            ownerGeneration: runtimeConnections.ownerGeneration,
            environment: runtimeConnections.environment,
            sourceAdapter: runtimeConnections.sourceAdapter,
            runtimeControlUrl: runtimeConnections.runtimeControlUrl,
            protocolVersion: runtimeConnections.protocolVersion,
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
          if (current.ownerGeneration !== undefined) {
            // 更高代际只有在取得同卷 flock 后才能首个心跳；正式镜像以此进程作为 PID1，
            // 旧容器进程树已退出，故可回收旧 owner 的浏览器容量占位。
            await browserCapacity.releaseReplacedOwner(transaction, {
              binId,
              runtimeId: current.runtimeId,
              ownerGeneration: current.ownerGeneration,
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

        if (registration?.kind === "manifest-update") {
          const runtimeUnchanged =
            current?.runtimeId === registration.runtimeId &&
            current?.ownerGeneration === registration.ownerGeneration &&
            current?.protocolVersion === registration.protocolVersion &&
            current?.runtimeControlUrl === registration.runtimeControlUrl &&
            isDeepStrictEqual(
              current?.sourceAdapter,
              registration.runtimeSourceAdapter,
            );
          if (!runtimeUnchanged) {
            return failure(409, {
              code: "configuration_changed",
              message: "运行器所有者在原生校验期间发生变化，请重试。",
              path: ["runtimeId"],
            });
          }
          if (
            ownerState !== "confirmed" ||
            checked.data.activeRunId !== null ||
            checked.data.claimInFlight
          ) {
            return failure(409, {
              code: "runtime_owner_mismatch",
              message: "更新源码声明前必须确认旧动作已停止。",
              path: ["activeRunId"],
            });
          }
          await transaction
            .update(binConfigurations)
            .set({
              sourceAdapter: registration.sourceAdapter,
              configNativeValid: registration.configNativeValid,
              updatedAt: sql`now()`,
            })
            .where(eq(binConfigurations.id, binId));
        }

        await transaction
          .insert(runtimeConnections)
          .values({
            binId,
            runtimeId: checked.data.runtimeId,
            sourceAdapter: checked.data.sourceAdapter,
            environment: checked.data.environment,
            protocolVersion: checked.data.protocolVersion,
            runtimeControlUrl: checked.data.runtimeControlUrl,
            disconnected: false,
            ownerState,
            ownerGeneration: incomingGeneration,
          })
          .onConflictDoUpdate({
            target: runtimeConnections.binId,
            set: {
              runtimeId: checked.data.runtimeId,
              sourceAdapter: checked.data.sourceAdapter,
              environment: checked.data.environment,
              protocolVersion: checked.data.protocolVersion,
              runtimeControlUrl: checked.data.runtimeControlUrl,
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
        if (
          execution.status === "online" &&
          checked.data.browserPowerEvent !== undefined
        ) {
          const owner = {
            binId,
            runtimeId: checked.data.runtimeId,
            ownerGeneration: checked.data.ownerGeneration,
          };
          const event = checked.data.browserPowerEvent;
          const accepted =
            event.event === "not_started"
              ? await browserCapacity.confirmNotStarted(
                  transaction,
                  owner,
                  event.reservationId,
                )
              : await browserCapacity.reportPower(
                  transaction,
                  owner,
                  event.reservationId,
                  event.event,
                );
          if (!accepted) {
            return failure(409, {
              code: "browser_reservation_mismatch",
              message: "浏览器预约阶段已改变；运行器必须先确认当前尝试。",
              path: ["browserPowerEvent"],
            });
          }
        }
        const humanSession =
          checked.data.browserPowerEvent !== undefined
            ? undefined
            : await applyRuntimeHumanSessionHeartbeat(
                transaction,
                {
                  binId,
                  runtimeId: checked.data.runtimeId,
                  ownerGeneration: checked.data.ownerGeneration,
                  ownerConfirmed:
                    ownerState === "confirmed" && execution.status === "online",
                  supportsReservationId: true,
                  ...(checked.data.humanSessionEvent === undefined
                    ? {}
                    : { event: checked.data.humanSessionEvent }),
                },
                browserCapacity,
              );
        return execution.status === "incompatible"
          ? { ok: false, status: 409, error: execution.error }
          : {
              ok: true,
              value: {
                ...execution,
                browserIdleTimeoutSeconds: row.browserIdleTimeoutSeconds,
                ...(humanSession === undefined ? {} : { humanSession }),
              } satisfies RuntimeHeartbeatResult,
            };
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
