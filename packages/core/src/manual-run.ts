import { randomUUID } from "node:crypto";

import {
  binCreateInputSchema,
  collectorManifestSchema,
  manualRunClaimInputSchema,
  manualRunCompleteInputSchema,
  manualRunCheckInputSchema,
  manualRunCheckResultSchema,
  manualRunErrorSchema,
  manualRunFailureSchema,
  manualRunExecutionSchema,
  manualRunSchema,
  manualRunTriggerInputSchema,
  runtimeHeartbeatTimeoutMs,
  type ManualRunCommitLocator,
  type ManualRun,
  type ManualRunCompletion,
  type ManualRunApiError,
  type ManualRunFailure,
  type ManualRunOperation,
  type ManualRunOperations,
  type ManualRunResult,
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

import { validateCollectorActionParameters } from "./bin-configuration.ts";
import { hasActiveHumanSession } from "./human-session.ts";
import {
  interruptExpiredManualRuns,
  isRuntimeOwnerWritable,
} from "./manual-run-fencing.ts";
import { readRuntimeExecution } from "./runtime-connection.ts";

const runSelection = {
  runId: manualRuns.runId,
  binId: manualRuns.binId,
  collectorId: manualRuns.collectorId,
  collectorVersion: manualRuns.collectorVersion,
  action: manualRuns.action,
  status: manualRuns.status,
  cancelRequestedAt: manualRuns.cancelRequestedAt,
  stopConfirmedAt: manualRuns.stopConfirmedAt,
  createdAt: manualRuns.createdAt,
  startedAt: manualRuns.startedAt,
  finishedAt: manualRuns.finishedAt,
  completedScopes: manualRuns.completedScopes,
  failure: manualRuns.failure,
  checkResult: manualRuns.checkResult,
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
) {
  const [row] = await database
    .select({
      ...runSelection,
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

  const queueReason =
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
  return { ...row, queueReason };
}

type RunRow = NonNullable<Awaited<ReturnType<typeof readRun>>>;
type RunOutputRow = Pick<RunRow, keyof typeof runSelection> & {
  readonly queueReason: RunRow["queueReason"];
};

async function rowToRun(
  database: Database | Transaction,
  row: RunOutputRow,
): Promise<ManualRun> {
  const commits = await readCommitLocators(database, row.runId, row.binId);
  const hasResult =
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "cancelled";
  if (
    row.action === "check" &&
    row.status === "completed" &&
    row.checkResult === null
  ) {
    throw new Error("已完成的 check 运行缺少诊断结果。");
  }
  if (row.checkResult !== null && row.finishedAt === null) {
    throw new Error("check 诊断结果缺少检查完成时间。");
  }
  const failureValue =
    row.failure === null ? null : manualRunFailureSchema.parse(row.failure);
  const checkInput =
    row.checkResult === null
      ? null
      : manualRunCheckInputSchema.parse(row.checkResult);
  const checkResult =
    checkInput === null || row.finishedAt === null
      ? undefined
      : manualRunCheckResultSchema.parse({
          ...checkInput,
          checkedAt: row.finishedAt.toISOString(),
        });
  return manualRunSchema.parse({
    runId: row.runId,
    binId: row.binId,
    action: row.action,
    collectorId: row.collectorId,
    collectorVersion: row.collectorVersion,
    status: row.status,
    ...(row.queueReason === null ? {} : { queueReason: row.queueReason }),
    ...(row.cancelRequestedAt === null
      ? {}
      : { cancellationRequestedAt: row.cancelRequestedAt.toISOString() }),
    ...(row.stopConfirmedAt === null
      ? {}
      : { stopConfirmedAt: row.stopConfirmedAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
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
            ...(checkResult === undefined ? {} : { check: checkResult }),
            stopReason: statusReason(row.status, failureValue, row.startedAt),
            ...(failureValue === null ? {} : { error: failureValue }),
          },
        }),
  });
}

export function createManualRunStore(database: Database): ManualRunOperations {
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

      return await database.transaction(async (transaction) => {
        const [bin] = await transaction
          .select({
            id: binConfigurations.id,
            collector: binConfigurations.collector,
            identityId: binConfigurations.identityId,
            config: binConfigurations.config,
            targets: binConfigurations.targets,
            status: binConfigurations.status,
          })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined)
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        if (bin.status === "disabled")
          return failure(
            409,
            "bin_disabled",
            "这个 bin 已停用，不能触发新的运行。",
            ["binId"],
          );

        await interruptExpiredManualRuns(transaction, binId);

        const configuredBin = binCreateInputSchema.parse({
          id: bin.id,
          collector: bin.collector,
          identityId: bin.identityId,
          config: bin.config,
          targets: bin.targets,
        });
        const action = validateCollectorActionParameters(
          configuredBin.collector,
          checked.data.action,
          checked.data.params,
        );
        if (!action.ok) {
          const apiError = manualRunErrorSchema.shape.error.safeParse({
            code: action.code,
            message: action.message,
            ...(action.path === undefined ? {} : { path: action.path }),
          });
          if (apiError.success) {
            const status = action.code === "action_not_found" ? 400 : 400;
            return { ok: false as const, status, error: apiError.data };
          }
          return failure(400, "invalid_input", action.message, action.path);
        }

        const runId = randomUUID();
        const [row] = await transaction
          .insert(manualRuns)
          .values({
            runId,
            binId,
            identityId: configuredBin.identityId,
            collectorSnapshot: configuredBin.collector,
            collectorId: configuredBin.collector.id,
            collectorVersion: configuredBin.collector.version,
            action: checked.data.action,
            params: checked.data.params,
            configSnapshot: configuredBin.config,
            targetsSnapshot: configuredBin.targets,
            status: "queued",
          })
          .returning(runSelection);
        if (row === undefined) throw new Error("运行创建后没有返回记录。");
        return {
          ok: true,
          value: await rowToRun(transaction, { ...row, queueReason: null }),
        };
      });
    },

    async getRun(binId, runId) {
      return await database.transaction(async (transaction) => {
        await interruptExpiredManualRuns(transaction, binId);
        const row = await readRun(transaction, binId, runId);
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

        const row = await readRun(transaction, binId, runId);
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
            collector: binConfigurations.collector,
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

        const collector = collectorManifestSchema.parse(bin.collector);
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
            collectorSnapshot: manualRuns.collectorSnapshot,
            params: manualRuns.params,
            configSnapshot: manualRuns.configSnapshot,
            targetsSnapshot: manualRuns.targetsSnapshot,
          })
          .from(manualRuns)
          .where(
            and(eq(manualRuns.binId, binId), eq(manualRuns.status, "queued")),
          )
          .orderBy(manualRuns.createdAt, manualRuns.runId)
          .for("update", { skipLocked: true })
          .limit(1);
        if (run === undefined) return { ok: true, value: null };

        // collector 更新后，排队中的旧动作不能被新版本代码误执行。
        const [snapshot] = await transaction
          .select({ matches: eq(manualRuns.collectorSnapshot, collector) })
          .from(manualRuns)
          .where(eq(manualRuns.runId, run.runId));
        if (snapshot?.matches !== true) {
          await failOneQueuedRun(transaction, run.runId, {
            code: "collector_changed_before_execution",
            message: "采集器清单在运行排队期间发生变化，本次动作没有执行。",
            impact: "本次运行未执行。",
            suggestion: "确认采集器版本后重新触发。",
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

        const runCollector = collectorManifestSchema.parse(
          run.collectorSnapshot,
        );
        const [runtimeConnection] = await transaction
          .select({
            runtimeId: runtimeConnections.runtimeId,
            ownerState: runtimeConnections.ownerState,
            matches: eq(runtimeConnections.collector, runCollector),
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
          collectorId: run.collectorId,
          collectorVersion: run.collectorVersion,
          action: run.action,
          params: run.params,
          config: run.configSnapshot,
          targets: run.targetsSnapshot,
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
            action: manualRuns.action,
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
        if (
          current.action === "check" &&
          completion.status === "completed" &&
          completion.check === undefined
        ) {
          return failure(
            400,
            "invalid_input",
            "check 必须提交结构化诊断结果。",
            ["completion", "check"],
          );
        }
        if (
          current.action !== "check" &&
          completion.status === "completed" &&
          completion.check !== undefined
        ) {
          return failure(
            400,
            "invalid_input",
            "只有 check 动作可以提交可用性诊断结果。",
            ["completion", "check"],
          );
        }
        const runFailure =
          completion.status === "failed"
            ? serializeFailure(completion.error)
            : null;
        await transaction
          .update(manualRuns)
          .set({
            status: completion.status,
            completedScopes: completion.completedScopes,
            failure: runFailure,
            checkResult:
              completion.status === "completed" &&
              completion.check !== undefined
                ? completion.check
                : null,
            // 结果终结时间使用 PostgreSQL 墙钟，而非事务开始时间。
            finishedAt: sql`clock_timestamp()`,
            stopConfirmedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(manualRuns.runId, runId), eq(manualRuns.binId, binId)));
        return { ok: true as const, value: runId };
      });
      if (!completionResult.ok) return completionResult;
      const row = await readRun(database, binId, completionResult.value);
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
