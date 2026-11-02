import { randomUUID } from "node:crypto";

import {
  binConfigurationSettingsSchema,
  sourceAdapterManifestStoredSchema,
  manualRunClaimInputSchema,
  manualRunCompleteInputSchema,
  manualRunErrorSchema,
  manualRunFailureSchema,
  manualRunExecutionSchema,
  manualRunSchema,
  manualRunTriggerInputSchema,
  manualRunTriggerSchema,
  runtimeHeartbeatTimeoutMs,
  runtimeProtocolVersion,
  type ManualRunCommitLocator,
  type ManualRun,
  type ManualRunCompletion,
  type ManualRunApiError,
  type ManualRunFailure,
  type ManualRunOperation,
  type ManualRunOperations,
  type ManualRunResult,
  type ManualRunTrigger,
  type ManualRunTriggerInput,
} from "@binny/contracts";
import {
  archiveCommits,
  archiveObservations,
  binConfigurations,
  humanSessions,
  manualRuns,
  runtimeConnections,
  type Database,
  type Transaction,
} from "@binny/db";
import { and, eq, exists, gt, inArray, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { validateSourceAdapterActionParameters } from "./bin-configuration.ts";
import type { BrowserCapacityCoordinator } from "./browser-capacity.ts";
import { hasActiveHumanSession } from "./human-session.ts";
import {
  interruptExpiredManualRuns,
  isRuntimeOwnerWritable,
} from "./manual-run-fencing.ts";
import {
  actionInputSnapshotStillCurrent,
  preflightActionInput,
} from "./runtime-action-validation.ts";
import { readRuntimeExecution } from "./runtime-connection.ts";

const runSelection = {
  runId: manualRuns.runId,
  binId: manualRuns.binId,
  sourceAdapterId: manualRuns.sourceAdapterId,
  sourceAdapterVersion: manualRuns.sourceAdapterVersion,
  action: manualRuns.action,
  status: manualRuns.status,
  triggerType: manualRuns.triggerType,
  scheduleId: manualRuns.scheduleId,
  scheduledFor: manualRuns.scheduledFor,
  cancelRequestedAt: manualRuns.cancelRequestedAt,
  stopConfirmedAt: manualRuns.stopConfirmedAt,
  createdAt: manualRuns.createdAt,
  referenceTime: manualRuns.referenceTime,
  startedAt: manualRuns.startedAt,
  finishedAt: manualRuns.finishedAt,
  completedScopes: manualRuns.completedScopes,
  failure: manualRuns.failure,
  output: manualRuns.output,
};

const activeRuns = alias(manualRuns, "active_runs");
const earlierRuns = alias(manualRuns, "earlier_runs");

function failure<T>(
  status: 400 | 404 | 409,
  code: ManualRunApiError["code"],
  message: string,
  path?: readonly (string | number)[],
): ManualRunOperation<T> {
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

function pathParts(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((part) => (typeof part === "symbol" ? String(part) : part));
}

function serializeFailure(value: ManualRunFailure): ManualRunFailure {
  return manualRunFailureSchema.parse(value);
}

function statusReason(
  status: ManualRun["status"],
  failureValue: ManualRunFailure | null,
  startedAt: Date | null,
) {
  if (status === "cancelled") {
    return startedAt === null
      ? { code: "cancelled_before_execution", message: "运行在开始前已取消。" }
      : { code: "cancelled", message: "执行进程已停止，运行取消完成。" };
  }
  return failureValue === null
    ? { code: "completed", message: "动作已完成。" }
    : { code: failureValue.code, message: failureValue.message };
}

async function readCommitLocators(
  database: Database | Transaction,
  runId: string,
  binId: string,
): Promise<ManualRunResult["commits"]> {
  const rows = await database
    .select({
      commitId: archiveCommits.commitId,
      archiveSequence: archiveCommits.archiveSequence,
      itemId: archiveObservations.itemId,
      revisionId: archiveObservations.revisionId,
    })
    .from(archiveCommits)
    .leftJoin(
      archiveObservations,
      eq(archiveObservations.commitId, archiveCommits.commitId),
    )
    .where(
      and(eq(archiveCommits.runId, runId), eq(archiveCommits.binId, binId)),
    )
    .orderBy(archiveCommits.archiveSequence, archiveObservations.ordinal);

  const commits = new Map<
    string,
    { archiveSeq: string; items: ManualRunCommitLocator["items"][number][] }
  >();
  for (const row of rows) {
    const existing = commits.get(row.commitId);
    const commit = existing ?? {
      archiveSeq: row.archiveSequence.toString(),
      items: [],
    };
    if (existing === undefined) commits.set(row.commitId, commit);
    if (row.itemId !== null && row.revisionId !== null) {
      commit.items.push({ itemId: row.itemId, revisionId: row.revisionId });
    }
  }
  return Array.from(commits, ([commitId, value]) => ({ commitId, ...value }));
}

async function readRun(
  database: Database | Transaction,
  binId: string,
  runId: string,
  browserCapacity: BrowserCapacityCoordinator,
) {
  const [row] = await database
    .select({
      ...runSelection,
      sourceAdapterSnapshot: manualRuns.sourceAdapterSnapshot,
      runtimeOnline: exists(
        database
          .select({ binId: runtimeConnections.binId })
          .from(runtimeConnections)
          .where(
            and(
              eq(runtimeConnections.binId, manualRuns.binId),
              eq(runtimeConnections.disconnected, false),
              // 心跳时限依赖 PostgreSQL 服务端时钟，Drizzle 无原生 interval 算子。
              gt(
                runtimeConnections.lastHeartbeatAt,
                sql`now() - ${runtimeHeartbeatTimeoutMs} * interval '1 millisecond'`,
              ),
            ),
          ),
      ),
      earlierRunActive: exists(
        database
          .select({ runId: activeRuns.runId })
          .from(activeRuns)
          .where(
            and(
              eq(activeRuns.binId, manualRuns.binId),
              inArray(activeRuns.status, ["executing", "cancelling"]),
            ),
          ),
      ),
      previousExecutionUnconfirmed: exists(
        database
          .select({ binId: runtimeConnections.binId })
          .from(runtimeConnections)
          .where(
            and(
              eq(runtimeConnections.binId, manualRuns.binId),
              eq(runtimeConnections.ownerState, "unconfirmed"),
            ),
          ),
      ),
      humanSessionActive: exists(
        database
          .select({ sessionId: humanSessions.sessionId })
          .from(humanSessions)
          .where(
            and(
              eq(humanSessions.binId, manualRuns.binId),
              inArray(humanSessions.status, [
                "pending",
                "opening",
                "ready",
                "closing",
              ]),
            ),
          ),
      ),
      earlierRunQueued: exists(
        database
          .select({ runId: earlierRuns.runId })
          .from(earlierRuns)
          .where(
            and(
              eq(earlierRuns.binId, manualRuns.binId),
              eq(earlierRuns.status, "queued"),
              or(
                lt(earlierRuns.createdAt, manualRuns.createdAt),
                and(
                  eq(earlierRuns.createdAt, manualRuns.createdAt),
                  lt(earlierRuns.runId, manualRuns.runId),
                ),
              ),
            ),
          ),
      ),
    })
    .from(manualRuns)
    .where(and(eq(manualRuns.binId, binId), eq(manualRuns.runId, runId)));
  if (row === undefined) return undefined;

  let queueReason =
    row.status !== "queued"
      ? null
      : row.previousExecutionUnconfirmed
        ? "previous_execution_unconfirmed"
        : !row.runtimeOnline
          ? "runtime_offline"
          : row.humanSessionActive
            ? "human_session_active"
            : row.earlierRunActive
              ? "earlier_run_active"
              : row.earlierRunQueued
                ? "earlier_run_queued"
                : null;
  if (
    queueReason === null &&
    sourceAdapterManifestStoredSchema.parse(row.sourceAdapterSnapshot)
      .environment.browser.required
  ) {
    const [owner] = await database
      .select({
        runtimeId: runtimeConnections.runtimeId,
        ownerGeneration: runtimeConnections.ownerGeneration,
        protocolVersion: runtimeConnections.protocolVersion,
      })
      .from(runtimeConnections)
      .where(eq(runtimeConnections.binId, binId));
    if (owner !== undefined) {
      queueReason =
        (await browserCapacity.queueReason(
          database,
          {
            binId,
            runtimeId: owner.runtimeId,
            ownerGeneration: owner.ownerGeneration,
          },
          owner.protocolVersion >= runtimeProtocolVersion,
        )) ?? null;
    }
  }
  return { ...row, queueReason };
}

type RunRow = NonNullable<Awaited<ReturnType<typeof readRun>>>;
type RunOutputRow = Pick<RunRow, keyof typeof runSelection> & {
  readonly queueReason: RunRow["queueReason"];
};

function runTrigger(row: RunOutputRow): ManualRunTrigger {
  if (row.triggerType === "manual") return { kind: "manual" };
  if (row.scheduleId === null || row.scheduledFor === null) {
    throw new Error("计划触发的运行缺少不可变来源信息。");
  }
  return {
    kind: "schedule",
    scheduleId: row.scheduleId,
    scheduledFor: row.scheduledFor.toISOString(),
  };
}

async function rowToRun(
  database: Database | Transaction,
  row: RunOutputRow,
): Promise<ManualRun> {
  const commits = await readCommitLocators(database, row.runId, row.binId);
  const hasResult =
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "cancelled";
  const failureValue =
    row.failure === null ? null : manualRunFailureSchema.parse(row.failure);
  return manualRunSchema.parse({
    runId: row.runId,
    binId: row.binId,
    action: row.action,
    trigger: runTrigger(row),
    sourceAdapterId: row.sourceAdapterId,
    sourceAdapterVersion: row.sourceAdapterVersion,
    status: row.status,
    ...(row.queueReason === null ? {} : { queueReason: row.queueReason }),
    ...(row.cancelRequestedAt === null
      ? {}
      : { cancellationRequestedAt: row.cancelRequestedAt.toISOString() }),
    ...(row.stopConfirmedAt === null
      ? {}
      : { stopConfirmedAt: row.stopConfirmedAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
    referenceTime: row.referenceTime.toISOString(),
    ...(row.startedAt === null
      ? {}
      : { startedAt: row.startedAt.toISOString() }),
    ...(row.finishedAt === null
      ? {}
      : { finishedAt: row.finishedAt.toISOString() }),
    ...(!hasResult
      ? {}
      : {
          result: {
            completedScopes: row.completedScopes,
            commits,
            ...(row.output === null ? {} : { output: row.output }),
            stopReason: statusReason(row.status, failureValue, row.startedAt),
            ...(failureValue === null ? {} : { error: failureValue }),
          },
        }),
  });
}

type RunBinSnapshot = {
  readonly id: string;
  readonly sourceAdapter: unknown;
  readonly identityId: string;
  readonly config: unknown;
  readonly configNativeValid: boolean;
  readonly status: "active" | "disabled";
};

/** 手动与计划触发共用同一套动作校验、快照和排队记录。 */
export async function createQueuedRunInTransaction(
  transaction: Transaction,
  bin: RunBinSnapshot,
  input: ManualRunTriggerInput,
  trigger: ManualRunTrigger,
): Promise<ManualRunOperation<ManualRun>> {
  const checkedInput = manualRunTriggerInputSchema.safeParse(input);
  if (!checkedInput.success) {
    const issue = checkedInput.error.issues[0];
    return failure(
      400,
      "invalid_input",
      issue?.message ?? "运行请求格式无效。",
      issue === undefined ? undefined : pathParts(issue.path),
    );
  }
  const checkedTrigger = manualRunTriggerSchema.safeParse(trigger);
  if (!checkedTrigger.success) {
    const issue = checkedTrigger.error.issues[0];
    return failure(
      400,
      "invalid_input",
      issue?.message ?? "运行触发来源无效。",
      issue === undefined ? undefined : pathParts(issue.path),
    );
  }
  if (bin.status === "disabled") {
    return failure(409, "bin_disabled", "这个 bin 已停用，不能触发新的运行。", [
      "binId",
    ]);
  }
  if (!bin.configNativeValid) {
    return failure(
      400,
      "invalid_configuration",
      "长期配置尚未通过当前运行器的原生校验，请先更新配置。",
      ["config"],
    );
  }

  const configuredBin = binConfigurationSettingsSchema.parse({
    id: bin.id,
    sourceAdapter: bin.sourceAdapter,
    identityId: bin.identityId,
    config: bin.config,
  });
  const action = validateSourceAdapterActionParameters(
    configuredBin.sourceAdapter,
    checkedInput.data.action,
    checkedInput.data.params,
  );
  if (!action.ok) {
    const apiError = manualRunErrorSchema.shape.error.safeParse({
      code: action.code,
      message: action.message,
      ...(action.path === undefined ? {} : { path: action.path }),
    });
    if (apiError.success) {
      return { ok: false, status: 400, error: apiError.data };
    }
    return failure(400, "invalid_input", action.message, action.path);
  }

  const triggerSource = checkedTrigger.data;
  const [row] = await transaction
    .insert(manualRuns)
    .values({
      runId: randomUUID(),
      binId: bin.id,
      identityId: configuredBin.identityId,
      sourceAdapterSnapshot: configuredBin.sourceAdapter,
      sourceAdapterId: configuredBin.sourceAdapter.id,
      sourceAdapterVersion: configuredBin.sourceAdapter.version,
      action: checkedInput.data.action,
      params: checkedInput.data.params,
      configSnapshot: configuredBin.config,
      triggerType: triggerSource.kind,
      scheduleId:
        triggerSource.kind === "schedule" ? triggerSource.scheduleId : null,
      scheduledFor:
        triggerSource.kind === "schedule"
          ? new Date(triggerSource.scheduledFor)
          : null,
      referenceTime:
        triggerSource.kind === "schedule"
          ? new Date(triggerSource.scheduledFor)
          : sql`statement_timestamp()`,
      ...(triggerSource.kind === "manual"
        ? { createdAt: sql`statement_timestamp()` }
        : {}),
      status: "queued",
    })
    .returning(runSelection);
  if (row === undefined) throw new Error("运行创建后没有返回记录。");
  return {
    ok: true,
    value: await rowToRun(transaction, { ...row, queueReason: null }),
  };
}

export function createManualRunStore(
  database: Database,
  browserCapacity: BrowserCapacityCoordinator,
): ManualRunOperations {
  return {
    async triggerRun(binId, input) {
      const checked = manualRunTriggerInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return failure(
          400,
          "invalid_input",
          issue?.message ?? "运行请求格式无效。",
          issue === undefined ? undefined : pathParts(issue.path),
        );
      }

      const preflight = await preflightActionInput(
        database,
        binId,
        checked.data.action,
        checked.data.params,
      );
      if (!preflight.ok) return preflight;

      return await database.transaction(async (transaction) => {
        const [bin] = await transaction
          .select({
            id: binConfigurations.id,
            sourceAdapter: binConfigurations.sourceAdapter,
            identityId: binConfigurations.identityId,
            config: binConfigurations.config,
            configNativeValid: binConfigurations.configNativeValid,
            status: binConfigurations.status,
          })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined)
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);

        if (
          !(await actionInputSnapshotStillCurrent(
            transaction,
            preflight.snapshot,
          ))
        ) {
          return failure(
            409,
            "action_input_changed",
            "长期配置或运行器在动作参数原生校验期间发生变化，请重新提交。",
            ["params"],
          );
        }

        await interruptExpiredManualRuns(transaction, binId);
        const created = await createQueuedRunInTransaction(
          transaction,
          bin,
          checked.data,
          { kind: "manual" },
        );
        if (!created.ok) return created;
        if (
          !sourceAdapterManifestStoredSchema.parse(bin.sourceAdapter)
            .environment.browser.required
        )
          return created;
        const row = await readRun(
          transaction,
          binId,
          created.value.runId,
          browserCapacity,
        );
        if (row === undefined)
          throw new Error("新建运行后没有找到其排队状态。");
        return { ok: true, value: await rowToRun(transaction, row) };
      });
    },

    async getRun(binId, runId) {
      return await database.transaction(async (transaction) => {
        await interruptExpiredManualRuns(transaction, binId);
        const row = await readRun(transaction, binId, runId, browserCapacity);
        return row === undefined
          ? failure(404, "run_not_found", "没有找到这个运行。", ["runId"])
          : { ok: true, value: await rowToRun(transaction, row) };
      });
    },

    async cancelRun(binId, runId) {
      return await database.transaction(async (transaction) => {
        await interruptExpiredManualRuns(transaction, binId);
        const [current] = await transaction
          .select({ status: manualRuns.status })
          .from(manualRuns)
          .where(and(eq(manualRuns.binId, binId), eq(manualRuns.runId, runId)))
          .for("update");
        if (current === undefined)
          return failure(404, "run_not_found", "没有找到这个运行。", ["runId"]);

        if (current.status === "queued") {
          await transaction
            .update(manualRuns)
            .set({
              status: "cancelled",
              cancelRequestedAt: sql`clock_timestamp()`,
              stopConfirmedAt: sql`clock_timestamp()`,
              finishedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(manualRuns.binId, binId),
                eq(manualRuns.runId, runId),
                eq(manualRuns.status, "queued"),
              ),
            );
        } else if (current.status === "executing") {
          await transaction
            .update(manualRuns)
            .set({
              status: "cancelling",
              cancelRequestedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(manualRuns.binId, binId),
                eq(manualRuns.runId, runId),
                eq(manualRuns.status, "executing"),
              ),
            );
        } else if (
          current.status !== "cancelling" &&
          current.status !== "cancelled"
        ) {
          return failure(
            409,
            "run_not_cancellable",
            "这个运行已经终结，不能再请求取消。",
            ["runId"],
          );
        }

        const row = await readRun(transaction, binId, runId, browserCapacity);
        if (row === undefined) throw new Error("取消运行后记录意外消失。");
        return { ok: true, value: await rowToRun(transaction, row) };
      });
    },

    async claimRun(binId, input) {
      const checked = manualRunClaimInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return failure(
          400,
          "invalid_input",
          issue?.message ?? "运行器领取请求无效。",
          issue === undefined ? undefined : pathParts(issue.path),
        );
      }

      return await database.transaction(async (transaction) => {
        const [bin] = await transaction
          .select({
            id: binConfigurations.id,
            status: binConfigurations.status,
            sourceAdapter: binConfigurations.sourceAdapter,
          })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined)
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);

        if (bin.status === "disabled") {
          await failQueuedRuns(transaction, binId, "bin_disabled");
          return { ok: true, value: null };
        }

        await interruptExpiredManualRuns(transaction, binId);
        const [owner] = await transaction
          .select({ ownerState: runtimeConnections.ownerState })
          .from(runtimeConnections)
          .where(eq(runtimeConnections.binId, binId));
        if (owner?.ownerState !== "confirmed") return { ok: true, value: null };
        if (await hasActiveHumanSession(transaction, binId)) {
          return { ok: true, value: null };
        }

        const sourceAdapter = sourceAdapterManifestStoredSchema.parse(
          bin.sourceAdapter,
        );
        const [active] = await transaction
          .select({ runId: manualRuns.runId })
          .from(manualRuns)
          .where(
            and(
              eq(manualRuns.binId, binId),
              inArray(manualRuns.status, ["executing", "cancelling"]),
            ),
          )
          .limit(1);
        if (active !== undefined) return { ok: true, value: null };

        const [run] = await transaction
          .select({
            ...runSelection,
            identityId: manualRuns.identityId,
            sourceAdapterSnapshot: manualRuns.sourceAdapterSnapshot,
            params: manualRuns.params,
            configSnapshot: manualRuns.configSnapshot,
          })
          .from(manualRuns)
          .where(
            and(eq(manualRuns.binId, binId), eq(manualRuns.status, "queued")),
          )
          .orderBy(manualRuns.createdAt, manualRuns.runId)
          .for("update", { skipLocked: true })
          .limit(1);
        if (run === undefined) return { ok: true, value: null };

        // sourceAdapter 更新后，排队中的旧动作不能被新版本代码误执行。
        const [snapshot] = await transaction
          .select({
            matches: eq(manualRuns.sourceAdapterSnapshot, sourceAdapter),
          })
          .from(manualRuns)
          .where(eq(manualRuns.runId, run.runId));
        if (snapshot?.matches !== true) {
          await failOneQueuedRun(transaction, run.runId, {
            code: "source_adapter_changed_before_execution",
            message: "信源适配器清单在运行排队期间发生变化，本次动作没有执行。",
            impact: "本次运行未执行。",
            suggestion: "确认信源适配器版本后重新触发。",
            requiresHuman: false,
          });
          return { ok: true, value: null };
        }

        const runtimeStatus = await readRuntimeExecution(transaction, binId);
        if (
          !runtimeStatus.ok ||
          runtimeStatus.value.status !== "online" ||
          runtimeStatus.value.runtimeId !== checked.data.runtimeId
        ) {
          return { ok: true, value: null };
        }

        const runSourceAdapter = sourceAdapterManifestStoredSchema.parse(
          run.sourceAdapterSnapshot,
        );
        const [runtimeConnection] = await transaction
          .select({
            runtimeId: runtimeConnections.runtimeId,
            ownerGeneration: runtimeConnections.ownerGeneration,
            protocolVersion: runtimeConnections.protocolVersion,
            ownerState: runtimeConnections.ownerState,
            matches: eq(runtimeConnections.sourceAdapter, runSourceAdapter),
          })
          .from(runtimeConnections)
          .where(eq(runtimeConnections.binId, binId));
        if (
          runtimeConnection === undefined ||
          runtimeConnection.runtimeId !== checked.data.runtimeId ||
          runtimeConnection.ownerState !== "confirmed" ||
          runtimeConnection.matches !== true
        ) {
          return { ok: true, value: null };
        }

        let browserReservationId: string | undefined;
        if (runSourceAdapter.environment.browser.required) {
          const reservation = await browserCapacity.reserve(
            transaction,
            {
              binId,
              runtimeId: runtimeConnection.runtimeId,
              ownerGeneration: runtimeConnection.ownerGeneration,
            },
            runtimeConnection.protocolVersion >= runtimeProtocolVersion,
          );
          if (reservation.kind !== "reserved") return { ok: true, value: null };
          browserReservationId = reservation.reservationId;
        }

        const [updated] = await transaction
          .update(manualRuns)
          .set({
            status: "executing",
            runtimeId: checked.data.runtimeId,
            // 运行开始时间使用 PostgreSQL 墙钟，而非事务开始时间。
            startedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(manualRuns.runId, run.runId),
              eq(manualRuns.status, "queued"),
            ),
          )
          .returning({ runId: manualRuns.runId });
        if (updated === undefined) return { ok: true, value: null };

        const value = manualRunExecutionSchema.parse({
          runId: run.runId,
          binId: run.binId,
          identityId: run.identityId,
          sourceAdapterId: run.sourceAdapterId,
          sourceAdapterVersion: run.sourceAdapterVersion,
          action: run.action,
          params: run.params,
          config: run.configSnapshot,
          referenceTime: run.referenceTime.toISOString(),
          ...(browserReservationId === undefined ||
          runtimeConnection.protocolVersion < runtimeProtocolVersion
            ? {}
            : { browserReservationId }),
        });
        return { ok: true, value };
      });
    },

    async completeRun(binId, runId, input) {
      const checked = manualRunCompleteInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return failure(
          400,
          "invalid_input",
          issue?.message ?? "运行结果格式无效。",
          issue === undefined ? undefined : pathParts(issue.path),
        );
      }

      const completionResult = await database.transaction<
        ManualRunOperation<string>
      >(async (transaction) => {
        await interruptExpiredManualRuns(transaction, binId);
        const [current] = await transaction
          .select({
            status: manualRuns.status,
            runtimeId: manualRuns.runtimeId,
          })
          .from(manualRuns)
          .where(and(eq(manualRuns.binId, binId), eq(manualRuns.runId, runId)))
          .for("update");
        if (current === undefined)
          return failure(404, "run_not_found", "没有找到这个运行。", ["runId"]);
        if (current.status === "cancelling")
          return failure(
            409,
            "run_cancellation_pending",
            "取消请求已受理；确认执行进程停止前不能提交其他结果。",
            ["runId"],
          );
        if (current.status !== "executing")
          return failure(
            409,
            "run_not_executing",
            "这个运行当前不能提交结果。",
            ["runId"],
          );
        if (current.runtimeId !== checked.data.runtimeId)
          return failure(
            409,
            "runtime_mismatch",
            "运行器不能提交其他运行器的结果。",
            ["runtimeId"],
          );
        if (
          !(await isRuntimeOwnerWritable(
            transaction,
            binId,
            checked.data.runtimeId,
          ))
        )
          return failure(
            409,
            "runtime_owner_unconfirmed",
            "运行器尚未确认它仍持有这个 bin 的执行权。",
            ["runtimeId"],
          );

        const completion: ManualRunCompletion = checked.data.completion;
        const runFailure =
          completion.status === "failed"
            ? serializeFailure(completion.error)
            : null;
        await transaction
          .update(manualRuns)
          .set({
            status: completion.status,
            completedScopes:
              completion.status === "failed" ? completion.completedScopes : [],
            failure: runFailure,
            output:
              completion.status === "completed" ? completion.output : null,
            // 结果终结时间使用 PostgreSQL 墙钟，而非事务开始时间。
            finishedAt: sql`clock_timestamp()`,
            stopConfirmedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(manualRuns.runId, runId), eq(manualRuns.binId, binId)));
        return { ok: true as const, value: runId };
      });
      if (!completionResult.ok) return completionResult;
      const row = await readRun(
        database,
        binId,
        completionResult.value,
        browserCapacity,
      );
      if (row === undefined) throw new Error("运行结果提交后记录意外消失。");
      return { ok: true, value: await rowToRun(database, row) };
    },
  };
}

async function failOneQueuedRun(
  transaction: Transaction,
  runId: string,
  failureValue: ManualRunFailure,
): Promise<void> {
  await transaction
    .update(manualRuns)
    .set({
      status: "failed",
      failure: failureValue,
      // 运行终结时间使用 PostgreSQL 墙钟，而非事务开始时间。
      finishedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(manualRuns.runId, runId), eq(manualRuns.status, "queued")));
}

async function failQueuedRuns(
  transaction: Transaction,
  binId: string,
  code: string,
): Promise<void> {
  const failureValue: ManualRunFailure = {
    code,
    message: "bin 已停用，排队中的运行没有执行。",
    impact: "排队中的运行已结束。",
    suggestion: "重新启用后可创建新的运行。",
    requiresHuman: false,
  };
  await transaction
    .update(manualRuns)
    .set({
      status: "failed",
      failure: failureValue,
      // 运行终结时间使用 PostgreSQL 墙钟，而非事务开始时间。
      finishedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(manualRuns.binId, binId), eq(manualRuns.status, "queued")));
}
