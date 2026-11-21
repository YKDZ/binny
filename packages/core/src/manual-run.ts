import { randomUUID } from "node:crypto";

import {
  binConfigurationSettingsSchema,
  sourceAdapterManifestStoredSchema,
  manualRunClaimInputSchema,
  manualRunCompleteInputSchema,
  manualRunReportInputSchema,
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
  type RuntimeWakeError,
} from "@binny/contracts";
import {
  archiveCommits,
  archiveObservations,
  binConfigurations,
  humanSessions,
  manualRuns,
  runtimeConnections,
  runtimeContainers,
  type Database,
  type Transaction,
} from "@binny/db";
import { and, eq, exists, gt, inArray, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { validateSourceAdapterActionParameters } from "./bin-configuration.ts";
import { hasActiveHumanSession } from "./human-session.ts";
import {
  interruptExpiredManualRuns,
  isRuntimeBrowserBusy,
  isRuntimeOwnerWritable,
  parseStoredManualRunFailure,
} from "./manual-run-fencing.ts";
import {
  actionInputSnapshotStillCurrent,
  checkActionPreflightPreconditions,
  preflightActionInput,
} from "./runtime-action-validation.ts";
import { readRuntimeExecution } from "./runtime-connection.ts";
import {
  parseContainerWakeError,
  type RuntimeContainerCoordinator,
} from "./runtime-container.ts";

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
  report: manualRuns.report,
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

/** Derives the stop reason code for terminal runs using the same rules as `run get`. */
export function deriveManualRunStopReasonCode(input: {
  readonly status: ManualRun["status"];
  readonly startedAt: Date | null;
  readonly failure: unknown;
}): string | undefined {
  if (
    input.status !== "completed" &&
    input.status !== "failed" &&
    input.status !== "cancelled"
  ) {
    return undefined;
  }
  if (input.status === "cancelled") {
    return input.startedAt === null
      ? "cancelled_before_execution"
      : "cancelled";
  }
  const failureValue =
    input.failure === null ? null : parseStoredManualRunFailure(input.failure);
  if (failureValue !== null) return failureValue.code;
  return input.status === "failed" ? "failed" : "completed";
}

function statusReason(
  status: ManualRun["status"],
  failureValue: ManualRunFailure | null,
  startedAt: Date | null,
) {
  const code = deriveManualRunStopReasonCode({
    status,
    startedAt,
    failure: failureValue,
  });
  if (code === undefined) {
    throw new Error("Non-terminal runs do not have a stop reason.");
  }
  if (status === "cancelled") {
    return {
      code,
      message:
        startedAt === null
          ? "运行在开始前已取消。"
          : "执行进程已停止，运行取消完成。",
    };
  }
  return failureValue === null
    ? { code, message: "动作已完成。" }
    : { code, message: failureValue.message };
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

  if (row.status !== "queued") {
    return {
      ...row,
      queueReason: null,
      lastWakeError: undefined,
    };
  }

  const [container] = await database
    .select({
      lifecyclePhase: runtimeContainers.lifecyclePhase,
      lastWakeError: runtimeContainers.lastWakeError,
    })
    .from(runtimeContainers)
    .where(eq(runtimeContainers.binId, binId));

  let queueReason = deriveQueueReason({
    previousExecutionUnconfirmed: Boolean(row.previousExecutionUnconfirmed),
    runtimeOnline: Boolean(row.runtimeOnline),
    containerLifecyclePhase: container?.lifecyclePhase,
    humanSessionActive: Boolean(row.humanSessionActive),
    earlierRunActive: Boolean(row.earlierRunActive),
    earlierRunQueued: Boolean(row.earlierRunQueued),
  });
  if (
    queueReason === null &&
    sourceAdapterManifestStoredSchema.parse(row.sourceAdapterSnapshot)
      .environment.browser.required
  ) {
    const [owner] = await database
      .select({
        protocolVersion: runtimeConnections.protocolVersion,
        environment: runtimeConnections.environment,
      })
      .from(runtimeConnections)
      .where(eq(runtimeConnections.binId, binId));
    if (owner !== undefined) {
      if (owner.protocolVersion < runtimeProtocolVersion) {
        queueReason = "runtime_protocol_outdated";
      } else if (isRuntimeBrowserBusy(owner.environment)) {
        queueReason = "bin_busy";
      }
    }
  }
  const lastWakeError = !row.runtimeOnline
    ? parseContainerWakeError(container?.lastWakeError)
    : undefined;
  return { ...row, queueReason, lastWakeError };
}

type QueueReason = ManualRun["queueReason"];

function deriveQueueReason(input: {
  readonly previousExecutionUnconfirmed: boolean;
  readonly runtimeOnline: boolean;
  readonly containerLifecyclePhase:
    | "running"
    | "waking"
    | "stopping"
    | "sleeping"
    | "offline"
    | undefined;
  readonly humanSessionActive: boolean;
  readonly earlierRunActive: boolean;
  readonly earlierRunQueued: boolean;
}): NonNullable<QueueReason> | null {
  if (input.previousExecutionUnconfirmed) {
    return "previous_execution_unconfirmed";
  }
  if (!input.runtimeOnline) {
    if (input.containerLifecyclePhase === "waking") return "runtime_waking";
    if (
      input.containerLifecyclePhase === "sleeping" ||
      input.containerLifecyclePhase === "stopping"
    ) {
      return "runtime_sleeping";
    }
    return "runtime_offline";
  }
  if (input.humanSessionActive) return "human_session_active";
  if (input.earlierRunActive) return "earlier_run_active";
  if (input.earlierRunQueued) return "earlier_run_queued";
  return null;
}

/** Resolves queue reasons and wake errors for queued rows in `run list`. */
export async function resolveQueuedRunDetails(
  database: Database,
  queuedRuns: readonly {
    readonly runId: string;
    readonly binId: string;
    readonly createdAtIso: string;
    readonly sourceAdapterSnapshot: unknown;
  }[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly queueReason?: NonNullable<QueueReason>;
      readonly lastWakeError?: RuntimeWakeError;
    }
  >
> {
  const result = new Map<
    string,
    {
      readonly queueReason?: NonNullable<QueueReason>;
      readonly lastWakeError?: RuntimeWakeError;
    }
  >();
  if (queuedRuns.length === 0) return result;

  const binIds = [...new Set(queuedRuns.map((run) => run.binId))];
  const [connections, containers, sessions, binRuns] = await Promise.all([
    database
      .select({
        binId: runtimeConnections.binId,
        disconnected: runtimeConnections.disconnected,
        ownerState: runtimeConnections.ownerState,
        protocolVersion: runtimeConnections.protocolVersion,
        environment: runtimeConnections.environment,
        heartbeatFresh: gt(
          runtimeConnections.lastHeartbeatAt,
          sql`now() - ${runtimeHeartbeatTimeoutMs} * interval '1 millisecond'`,
        ),
      })
      .from(runtimeConnections)
      .where(inArray(runtimeConnections.binId, binIds)),
    database
      .select({
        binId: runtimeContainers.binId,
        lifecyclePhase: runtimeContainers.lifecyclePhase,
        lastWakeError: runtimeContainers.lastWakeError,
      })
      .from(runtimeContainers)
      .where(inArray(runtimeContainers.binId, binIds)),
    database
      .select({ binId: humanSessions.binId })
      .from(humanSessions)
      .where(
        and(
          inArray(humanSessions.binId, binIds),
          inArray(humanSessions.status, [
            "pending",
            "opening",
            "ready",
            "closing",
          ]),
        ),
      ),
    database
      .select({
        runId: manualRuns.runId,
        binId: manualRuns.binId,
        status: manualRuns.status,
        createdAtIso: sql<string>`to_char(${manualRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(manualRuns)
      .where(
        and(
          inArray(manualRuns.binId, binIds),
          inArray(manualRuns.status, ["queued", "executing", "cancelling"]),
        ),
      ),
  ]);

  const connectionByBin = new Map(connections.map((c) => [c.binId, c]));
  const containerByBin = new Map(containers.map((c) => [c.binId, c]));
  const activeSessionBins = new Set(sessions.map((s) => s.binId));
  const activeRunBins = new Set<string>();
  const queuedRunsByBin = new Map<
    string,
    { readonly runId: string; readonly createdAtIso: string }[]
  >();
  for (const r of binRuns) {
    if (r.status === "executing" || r.status === "cancelling") {
      activeRunBins.add(r.binId);
    } else if (r.status === "queued") {
      const list = queuedRunsByBin.get(r.binId) ?? [];
      list.push({ runId: r.runId, createdAtIso: r.createdAtIso });
      queuedRunsByBin.set(r.binId, list);
    }
  }

  for (const row of queuedRuns) {
    const conn = connectionByBin.get(row.binId);
    const container = containerByBin.get(row.binId);
    const runtimeOnline =
      conn !== undefined && !conn.disconnected && Boolean(conn.heartbeatFresh);
    const binQueued = queuedRunsByBin.get(row.binId) ?? [];
    const earlierRunQueued = binQueued.some(
      (other) =>
        other.createdAtIso < row.createdAtIso ||
        (other.createdAtIso === row.createdAtIso && other.runId < row.runId),
    );
    let queueReason = deriveQueueReason({
      previousExecutionUnconfirmed: conn?.ownerState === "unconfirmed",
      runtimeOnline,
      containerLifecyclePhase: container?.lifecyclePhase,
      humanSessionActive: activeSessionBins.has(row.binId),
      earlierRunActive: activeRunBins.has(row.binId),
      earlierRunQueued,
    });
    if (
      queueReason === null &&
      conn !== undefined &&
      sourceAdapterManifestStoredSchema.parse(row.sourceAdapterSnapshot)
        .environment.browser.required
    ) {
      if (conn.protocolVersion < runtimeProtocolVersion) {
        queueReason = "runtime_protocol_outdated";
      } else if (isRuntimeBrowserBusy(conn.environment)) {
        queueReason = "bin_busy";
      }
    }
    const lastWakeError = !runtimeOnline
      ? parseContainerWakeError(container?.lastWakeError)
      : undefined;
    result.set(row.runId, {
      ...(queueReason === null ? {} : { queueReason }),
      ...(lastWakeError === undefined ? {} : { lastWakeError }),
    });
  }
  return result;
}

type RunRow = NonNullable<Awaited<ReturnType<typeof readRun>>>;
type RunOutputRow = Pick<RunRow, keyof typeof runSelection> & {
  readonly queueReason: RunRow["queueReason"];
  readonly lastWakeError?: RuntimeWakeError | undefined;
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
    row.failure === null ? null : parseStoredManualRunFailure(row.failure);
  const [activeHumanSession] = await database
    .select({
      sessionId: humanSessions.sessionId,
      status: humanSessions.status,
    })
    .from(humanSessions)
    .where(
      and(
        eq(humanSessions.binId, row.binId),
        inArray(humanSessions.status, [
          "pending",
          "opening",
          "ready",
          "closing",
        ]),
      ),
    )
    .limit(1);
  const humanSession =
    activeHumanSession !== undefined &&
    (activeHumanSession.status === "pending" ||
      activeHumanSession.status === "opening" ||
      activeHumanSession.status === "ready" ||
      activeHumanSession.status === "closing")
      ? {
          status: activeHumanSession.status,
          sessionId: activeHumanSession.sessionId,
        }
      : failureValue?.requiresHuman === true
        ? { status: "none" as const }
        : undefined;
  return manualRunSchema.parse({
    runId: row.runId,
    binId: row.binId,
    action: row.action,
    trigger: runTrigger(row),
    sourceAdapterId: row.sourceAdapterId,
    sourceAdapterVersion: row.sourceAdapterVersion,
    status: row.status,
    ...(row.queueReason === null ? {} : { queueReason: row.queueReason }),
    ...(row.lastWakeError === undefined
      ? {}
      : { lastWakeError: row.lastWakeError }),
    ...(humanSession === undefined ? {} : { humanSession }),
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
    ...(row.report === null ? {} : { report: row.report }),
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
      "长期配置尚未通过当前运行器的原生校验。",
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
  options?: { readonly containerCoordinator?: RuntimeContainerCoordinator },
): ManualRunOperations {
  const containerCoordinator = options?.containerCoordinator;
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

      const executeTrigger = async (): Promise<
        ManualRunOperation<ManualRun>
      > => {
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
            return failure(404, "bin_not_found", "没有找到这个 bin。", [
              "binId",
            ]);

          if (
            !(await actionInputSnapshotStillCurrent(
              transaction,
              preflight.snapshot,
            ))
          ) {
            return failure(
              409,
              "action_input_changed",
              "长期配置或运行器在动作参数原生校验期间发生变化，本次运行未创建。",
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
          const row = await readRun(transaction, binId, created.value.runId);
          if (row === undefined)
            throw new Error("新建运行后没有找到其排队状态。");
          return { ok: true, value: await rowToRun(transaction, row) };
        });
      };

      if (containerCoordinator !== undefined) {
        const preconditionFailure = await checkActionPreflightPreconditions(
          database,
          binId,
        );
        if (preconditionFailure !== undefined) return preconditionFailure;
        const wake = await containerCoordinator.ensureAwakeAndRun(
          binId,
          executeTrigger,
        );
        if (!wake.ok) {
          return failure(
            409,
            "runtime_action_validation_unavailable",
            wake.message,
            ["params"],
          );
        }
        return wake.value;
      }

      return await executeTrigger();
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
      let cancelledQueued = false;
      const result = await database.transaction(async (transaction) => {
        await interruptExpiredManualRuns(transaction, binId);
        const [current] = await transaction
          .select({ status: manualRuns.status })
          .from(manualRuns)
          .where(and(eq(manualRuns.binId, binId), eq(manualRuns.runId, runId)))
          .for("update");
        if (current === undefined)
          return failure<ManualRun>(
            404,
            "run_not_found",
            "没有找到这个运行。",
            ["runId"],
          );

        if (current.status === "queued") {
          cancelledQueued = true;
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
          return failure<ManualRun>(
            409,
            "run_not_cancellable",
            "这个运行已经终结，不能再请求取消。",
            ["runId"],
          );
        }

        const row = await readRun(transaction, binId, runId);
        if (row === undefined) throw new Error("取消运行后记录意外消失。");
        return { ok: true as const, value: await rowToRun(transaction, row) };
      });
      if (result.ok && cancelledQueued) {
        await containerCoordinator?.markWorkCompleted(binId);
      }
      return result;
    },

    async reportRun(binId, runId, input) {
      const checked = manualRunReportInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return failure(
          400,
          "invalid_input",
          issue?.message ?? "运行报告格式无效。",
          issue === undefined ? undefined : pathParts(issue.path),
        );
      }

      return await database.transaction(async (transaction) => {
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
        if (current.status !== "executing" && current.status !== "cancelling")
          return failure(
            409,
            "run_not_executing",
            "只有仍由运行器执行或正在停止的运行可以更新报告。",
            ["runId"],
          );
        if (current.runtimeId !== checked.data.runtimeId)
          return failure(
            409,
            "runtime_mismatch",
            "运行器不能更新其他运行器的报告。",
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

        await transaction
          .update(manualRuns)
          .set({ report: checked.data.report })
          .where(and(eq(manualRuns.runId, runId), eq(manualRuns.binId, binId)));
        const row = await readRun(transaction, binId, runId);
        if (row === undefined) throw new Error("运行报告写入后记录意外消失。");
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
        const [container] = await transaction
          .select({ lifecyclePhase: runtimeContainers.lifecyclePhase })
          .from(runtimeContainers)
          .where(eq(runtimeContainers.binId, binId));
        if (
          container?.lifecyclePhase === "stopping" ||
          container?.lifecyclePhase === "sleeping"
        ) {
          return { ok: true, value: null };
        }
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
            environment: runtimeConnections.environment,
            matches: eq(runtimeConnections.sourceAdapter, runSourceAdapter),
          })
          .from(runtimeConnections)
          .where(eq(runtimeConnections.binId, binId));
        if (
          runtimeConnection === undefined ||
          runtimeConnection.runtimeId !== checked.data.runtimeId ||
          runtimeConnection.ownerState !== "confirmed" ||
          runtimeConnection.protocolVersion < runtimeProtocolVersion ||
          runtimeConnection.matches !== true
        ) {
          return { ok: true, value: null };
        }

        if (
          runSourceAdapter.environment.browser.required &&
          isRuntimeBrowserBusy(runtimeConnection.environment)
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
          sourceAdapterId: run.sourceAdapterId,
          sourceAdapterVersion: run.sourceAdapterVersion,
          action: run.action,
          params: run.params,
          config: run.configSnapshot,
          referenceTime: run.referenceTime.toISOString(),
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
      await containerCoordinator?.markWorkCompleted(binId);
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
