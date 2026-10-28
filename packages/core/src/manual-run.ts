import { randomUUID } from "node:crypto";

import {
  manualRunClaimInputSchema,
  manualRunCompleteInputSchema,
  manualRunCheckResultSchema,
  manualRunErrorSchema,
  manualRunFailureSchema,
  manualRunSchema,
  manualRunTriggerInputSchema,
  runtimeHeartbeatTimeoutMs,
  type CollectorManifest,
  type JsonObject,
  type ManualRun,
  type ManualRunCompletion,
  type ManualRunCheckInput,
  type ManualRunApiError,
  type ManualRunExecution,
  type ManualRunFailure,
  type ManualRunOperation,
  type ManualRunOperations,
  type ManualRunResult,
} from "@binny/contracts";

import { validateCollectorActionParameters } from "./bin-configuration.ts";
import type { CoreDatabase, CoreTransaction } from "./database.ts";
import { interruptExpiredManualRuns } from "./manual-run-fencing.ts";
import { readRuntimeExecution } from "./runtime-connection.ts";

type RunRow = {
  readonly run_id: string;
  readonly bin_id: string;
  readonly collector_id: string;
  readonly collector_version: string;
  readonly action: string;
  readonly status: ManualRun["status"];
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly cancellation_requested_at: Date | null;
  readonly stop_confirmed_at: Date | null;
  readonly completed_scopes: readonly string[];
  readonly failure: ManualRunFailure | null;
  readonly check_result: ManualRunCheckInput | null;
  readonly queue_reason: ManualRun["queueReason"] | null;
};

type RunSnapshotRow = RunRow & {
  readonly identity_id: string;
  readonly collector_snapshot: CollectorManifest;
  readonly config_snapshot: JsonObject;
  readonly targets_snapshot: readonly unknown[];
  readonly params: JsonObject;
};

type CommitLocatorRow = {
  readonly commit_id: string;
  readonly archive_seq: string;
  readonly items: readonly {
    readonly item_id: string | null;
    readonly revision_id: string | null;
  }[];
};

const tableName = "manual_runs";
const jsonbType = 3802;

function jsonbParameter(database: CoreDatabase, value: unknown) {
  return database.typed(value, jsonbType);
}

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
  if (status === "cancelled")
    return startedAt === null
      ? {
          code: "cancelled_before_execution",
          message: "排队运行已取消，没有启动执行进程。",
        }
      : { code: "cancelled", message: "执行进程已停止，运行取消完成。" };
  return failureValue === null
    ? { code: "completed", message: "动作已完成。" }
    : { code: failureValue.code, message: failureValue.message };
}

async function readCommitLocators(
  database: CoreDatabase | CoreTransaction,
  runId: string,
  binId: string,
): Promise<ManualRunResult["commits"]> {
  const rows = await database.unsafe<CommitLocatorRow[]>(
    "SELECT c.commit_id, c.archive_seq::text AS archive_seq, " +
      "COALESCE(jsonb_agg(jsonb_build_object('item_id', o.item_id, " +
      "'revision_id', o.revision_id) ORDER BY o.ordinal) " +
      "FILTER (WHERE o.item_id IS NOT NULL), '[]'::jsonb) AS items " +
      "FROM archive_commit c " +
      "LEFT JOIN archive_observation o ON o.commit_id = c.commit_id " +
      "WHERE c.run_id = $1 AND c.bin_id = $2 " +
      "GROUP BY c.commit_id, c.archive_seq ORDER BY c.archive_seq",
    [runId, binId],
  );
  return rows.map((row) => ({
    commitId: row.commit_id,
    archiveSeq: row.archive_seq,
    items: row.items.flatMap((item) =>
      item.item_id === null || item.revision_id === null
        ? []
        : [{ itemId: item.item_id, revisionId: item.revision_id }],
    ),
  }));
}

async function readRun(
  database: CoreDatabase | CoreTransaction,
  binId: string,
  runId: string,
): Promise<RunRow | undefined> {
  const rows = await database.unsafe<RunRow[]>(
    "SELECT run_id, bin_id, collector_id, collector_version, action, status, " +
      "created_at, started_at, finished_at, cancel_requested_at AS cancellation_requested_at, " +
      "stop_confirmed_at, completed_scopes, failure, check_result, " +
      "CASE WHEN status <> 'queued' THEN NULL " +
      "WHEN EXISTS (SELECT 1 FROM runtime_connections owner " +
      "WHERE owner.bin_id = manual_runs.bin_id AND owner.owner_state = 'unconfirmed') " +
      "THEN 'previous_execution_unconfirmed' " +
      "WHEN NOT EXISTS (SELECT 1 FROM runtime_connections r " +
      "WHERE r.bin_id = manual_runs.bin_id AND r.disconnected = false " +
      "AND r.last_heartbeat_at > now() - interval '8 seconds') " +
      "THEN 'runtime_offline' " +
      "WHEN EXISTS (SELECT 1 FROM manual_runs active " +
      "WHERE active.bin_id = manual_runs.bin_id " +
      "AND active.status IN ('executing', 'cancelling')) " +
      "THEN 'earlier_run_active' " +
      "WHEN EXISTS (SELECT 1 FROM manual_runs earlier " +
      "WHERE earlier.bin_id = manual_runs.bin_id AND earlier.status = 'queued' " +
      "AND (earlier.created_at, earlier.run_id) < (manual_runs.created_at, manual_runs.run_id)) " +
      "THEN 'earlier_run_queued' ELSE NULL END AS queue_reason " +
      "FROM " +
      tableName +
      " WHERE bin_id = $1 AND run_id = $2",
    [binId, runId],
  );
  return rows[0];
}

async function rowToRun(
  database: CoreDatabase | CoreTransaction,
  row: RunRow,
): Promise<ManualRun> {
  const commits = await readCommitLocators(database, row.run_id, row.bin_id);
  const hasResult =
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "cancelled";
  if (
    row.action === "check" &&
    row.status === "completed" &&
    row.check_result === null
  ) {
    throw new Error("已完成的 check 运行缺少诊断结果。");
  }
  if (row.check_result !== null && row.finished_at === null) {
    throw new Error("check 诊断结果缺少检查完成时间。");
  }
  const checkResult =
    row.check_result === null || row.finished_at === null
      ? undefined
      : manualRunCheckResultSchema.parse({
          ...row.check_result,
          checkedAt: row.finished_at.toISOString(),
        });
  return manualRunSchema.parse({
    runId: row.run_id,
    binId: row.bin_id,
    action: row.action,
    collectorId: row.collector_id,
    collectorVersion: row.collector_version,
    status: row.status,
    ...(row.queue_reason === null ? {} : { queueReason: row.queue_reason }),
    ...(row.cancellation_requested_at === null
      ? {}
      : {
          cancellationRequestedAt: row.cancellation_requested_at.toISOString(),
        }),
    ...(row.stop_confirmed_at === null
      ? {}
      : { stopConfirmedAt: row.stop_confirmed_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
    ...(row.started_at === null
      ? {}
      : { startedAt: row.started_at.toISOString() }),
    ...(row.finished_at === null
      ? {}
      : { finishedAt: row.finished_at.toISOString() }),
    ...(!hasResult
      ? {}
      : {
          result: {
            completedScopes: row.completed_scopes,
            commits,
            ...(checkResult === undefined ? {} : { check: checkResult }),
            stopReason: statusReason(row.status, row.failure, row.started_at),
            ...(row.failure === null ? {} : { error: row.failure }),
          },
        }),
  });
}

export async function initializeManualRunSchema(
  database: CoreDatabase,
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS " +
        tableName +
        " (" +
        "run_id uuid PRIMARY KEY, " +
        "bin_id text NOT NULL, " +
        "identity_id text NOT NULL, " +
        "collector_snapshot jsonb NOT NULL, " +
        "collector_id text NOT NULL, " +
        "collector_version text NOT NULL, " +
        "action text NOT NULL, " +
        "params jsonb NOT NULL, " +
        "config_snapshot jsonb NOT NULL, " +
        "targets_snapshot jsonb NOT NULL, " +
        "status text NOT NULL CHECK (status IN ('queued', 'executing', 'cancelling', 'completed', 'failed', 'cancelled')), " +
        "runtime_id text, " +
        "completed_scopes jsonb NOT NULL DEFAULT '[]'::jsonb, " +
        "failure jsonb, " +
        "cancel_requested_at timestamptz, " +
        "stop_confirmed_at timestamptz, " +
        "created_at timestamptz NOT NULL DEFAULT clock_timestamp(), " +
        "started_at timestamptz, " +
        "finished_at timestamptz" +
        ")",
    );
    await transaction.unsafe(
      "ALTER TABLE " +
        tableName +
        " ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz",
    );
    await transaction.unsafe(
      "ALTER TABLE " +
        tableName +
        " ADD COLUMN IF NOT EXISTS stop_confirmed_at timestamptz",
    );
    await transaction.unsafe(
      "ALTER TABLE " +
        tableName +
        " ADD COLUMN IF NOT EXISTS check_result jsonb",
    );
    await transaction.unsafe(
      "ALTER TABLE " +
        tableName +
        " DROP CONSTRAINT IF EXISTS manual_runs_status_check",
    );
    await transaction.unsafe(
      "ALTER TABLE " +
        tableName +
        " ADD CONSTRAINT manual_runs_status_check CHECK (status IN ('queued', 'executing', 'cancelling', 'completed', 'failed', 'cancelled'))",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS manual_runs_bin_queue_idx " +
        "ON " +
        tableName +
        " (bin_id, created_at, run_id) WHERE status = 'queued'",
    );
    await transaction.unsafe(
      "DROP INDEX IF EXISTS manual_runs_one_executing_bin_idx",
    );
    await transaction.unsafe(
      "CREATE UNIQUE INDEX manual_runs_one_executing_bin_idx " +
        "ON " +
        tableName +
        " (bin_id) WHERE status IN ('executing', 'cancelling')",
    );
    await transaction.unsafe(
      "UPDATE runtime_connections SET owner_state = 'unconfirmed' " +
        "WHERE EXISTS (SELECT 1 FROM " +
        tableName +
        " run " +
        "WHERE run.bin_id = runtime_connections.bin_id " +
        "AND run.status IN ('executing', 'cancelling'))",
    );
  });
}

export function createManualRunStore(
  database: CoreDatabase,
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

      return await database.begin(async (transaction) => {
        const bins = await transaction.unsafe<
          {
            readonly id: string;
            readonly collector: CollectorManifest;
            readonly identity_id: string;
            readonly config: JsonObject;
            readonly targets: readonly unknown[];
            readonly status: "active" | "disabled";
          }[]
        >(
          "SELECT id, collector, identity_id, config, targets, status " +
            "FROM bin_configurations WHERE id = $1 FOR UPDATE",
          [binId],
        );
        const bin = bins[0];
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

        const action = validateCollectorActionParameters(
          bin.collector,
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
        const rows = await transaction.unsafe<RunRow[]>(
          "INSERT INTO " +
            tableName +
            " (run_id, bin_id, identity_id, collector_snapshot, collector_id, " +
            "collector_version, action, params, config_snapshot, targets_snapshot, status) " +
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued') " +
            "RETURNING run_id, bin_id, collector_id, collector_version, action, status, " +
            "created_at, started_at, finished_at, NULL AS cancellation_requested_at, " +
            "NULL AS stop_confirmed_at, completed_scopes, failure, " +
            "NULL AS check_result, NULL AS queue_reason",
          [
            runId,
            binId,
            bin.identity_id,
            jsonbParameter(database, bin.collector),
            bin.collector.id,
            bin.collector.version,
            checked.data.action,
            jsonbParameter(database, checked.data.params),
            jsonbParameter(database, bin.config),
            jsonbParameter(database, bin.targets),
          ],
        );
        const row = rows[0];
        if (row === undefined) throw new Error("运行创建后没有返回记录。");
        return { ok: true, value: await rowToRun(transaction, row) };
      });
    },

    async getRun(binId, runId) {
      return await database.begin(async (transaction) => {
        await interruptExpiredManualRuns(transaction, binId);
        const row = await readRun(transaction, binId, runId);
        return row === undefined
          ? failure(404, "run_not_found", "没有找到这个运行。", ["runId"])
          : { ok: true, value: await rowToRun(transaction, row) };
      });
    },

    async cancelRun(binId, runId) {
      return await database.begin(async (transaction) => {
        await interruptExpiredManualRuns(transaction, binId);
        const rows = await transaction.unsafe<
          { readonly status: ManualRun["status"] }[]
        >(
          "SELECT status FROM " +
            tableName +
            " WHERE bin_id = $1 AND run_id = $2 FOR UPDATE",
          [binId, runId],
        );
        const current = rows[0];
        if (current === undefined)
          return failure(404, "run_not_found", "没有找到这个运行。", ["runId"]);

        if (current.status === "queued") {
          await transaction.unsafe(
            "UPDATE " +
              tableName +
              " SET status = 'cancelled', cancel_requested_at = clock_timestamp(), " +
              "stop_confirmed_at = clock_timestamp(), finished_at = clock_timestamp() " +
              "WHERE bin_id = $1 AND run_id = $2 AND status = 'queued'",
            [binId, runId],
          );
        } else if (current.status === "executing") {
          await transaction.unsafe(
            "UPDATE " +
              tableName +
              " SET status = 'cancelling', cancel_requested_at = clock_timestamp() " +
              "WHERE bin_id = $1 AND run_id = $2 AND status = 'executing'",
            [binId, runId],
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

      return await database.begin(async (transaction) => {
        const bins = await transaction.unsafe<
          {
            readonly id: string;
            readonly status: "active" | "disabled";
            readonly collector: CollectorManifest;
          }[]
        >(
          "SELECT id, status, collector FROM bin_configurations " +
            "WHERE id = $1 FOR UPDATE",
          [binId],
        );
        const bin = bins[0];
        if (bin === undefined)
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);

        if (bin.status === "disabled") {
          await failQueuedRuns(transaction, binId, "bin_disabled");
          return { ok: true, value: null };
        }

        await interruptExpiredManualRuns(transaction, binId);
        const owners = await transaction.unsafe<
          { readonly owner_state: "confirmed" | "unconfirmed" }[]
        >("SELECT owner_state FROM runtime_connections WHERE bin_id = $1", [
          binId,
        ]);
        if (owners[0]?.owner_state !== "confirmed")
          return { ok: true, value: null };

        const active = await transaction.unsafe<{ readonly run_id: string }[]>(
          "SELECT run_id FROM " +
            tableName +
            " WHERE bin_id = $1 AND status IN ('executing', 'cancelling') LIMIT 1",
          [binId],
        );
        if (active.length > 0) return { ok: true, value: null };

        const pending = await transaction.unsafe<RunSnapshotRow[]>(
          "SELECT run_id, bin_id, identity_id, collector_snapshot, collector_id, " +
            "collector_version, action, params, config_snapshot, targets_snapshot, " +
            "status, created_at, started_at, finished_at, " +
            "cancel_requested_at AS cancellation_requested_at, stop_confirmed_at, " +
            "completed_scopes, failure, check_result, " +
            "NULL AS queue_reason FROM " +
            tableName +
            " WHERE bin_id = $1 AND status = 'queued' " +
            "ORDER BY created_at, run_id FOR UPDATE SKIP LOCKED LIMIT 1",
          [binId],
        );
        const run = pending[0];
        if (run === undefined) return { ok: true, value: null };

        // collector 更新后，排队中的旧动作不能被新版本代码误执行。
        const snapshotMatches = await transaction.unsafe<
          { readonly matches: boolean }[]
        >(
          "SELECT collector_snapshot = $2 AS matches FROM " +
            tableName +
            " WHERE run_id = $1",
          [run.run_id, jsonbParameter(database, bin.collector)],
        );
        if (snapshotMatches[0]?.matches !== true) {
          await failOneQueuedRun(transaction, run.run_id, {
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

        const execution = await transaction.unsafe<
          {
            readonly runtime_id: string | null;
            readonly runtime_collector: CollectorManifest | null;
          }[]
        >(
          "SELECT runtime_id, collector AS runtime_collector " +
            "FROM runtime_connections WHERE bin_id = $1",
          [binId],
        );
        const runtimeConnection = execution[0];
        if (runtimeConnection?.runtime_id !== checked.data.runtimeId) {
          return { ok: true, value: null };
        }
        if (runtimeConnection.runtime_collector === null)
          return { ok: true, value: null };

        const runtimeMatches = await transaction.unsafe<
          { readonly matches: boolean }[]
        >("SELECT $1::jsonb = $2::jsonb AS matches", [
          jsonbParameter(database, runtimeConnection.runtime_collector),
          jsonbParameter(database, run.collector_snapshot),
        ]);
        if (runtimeMatches[0]?.matches !== true)
          return { ok: true, value: null };

        const updated = await transaction.unsafe<RunRow[]>(
          "UPDATE " +
            tableName +
            " SET status = 'executing', runtime_id = $2, started_at = clock_timestamp() " +
            "WHERE run_id = $1 AND status = 'queued' RETURNING run_id, bin_id, " +
            "collector_id, collector_version, action, status, created_at, started_at, " +
            "finished_at, NULL AS cancellation_requested_at, NULL AS stop_confirmed_at, " +
            "completed_scopes, failure, check_result, NULL AS queue_reason",
          [run.run_id, checked.data.runtimeId],
        );
        if (updated[0] === undefined) return { ok: true, value: null };

        const value: ManualRunExecution = {
          runId: run.run_id,
          binId: run.bin_id,
          identityId: run.identity_id,
          collectorId: run.collector_id,
          collectorVersion: run.collector_version,
          action: run.action,
          params: run.params,
          config: run.config_snapshot,
          targets: [...run.targets_snapshot],
        };
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

      const completionResult = await database.begin<ManualRunOperation<string>>(
        async (transaction) => {
          await interruptExpiredManualRuns(transaction, binId);
          const rows = await transaction.unsafe<
            {
              readonly status: ManualRun["status"];
              readonly action: string;
              readonly runtime_id: string | null;
            }[]
          >(
            "SELECT status, action, runtime_id FROM " +
              tableName +
              " WHERE bin_id = $1 AND run_id = $2 FOR UPDATE",
            [binId, runId],
          );
          const current = rows[0];
          if (current === undefined)
            return failure(404, "run_not_found", "没有找到这个运行。", [
              "runId",
            ]);
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
          if (current.runtime_id !== checked.data.runtimeId)
            return failure(
              409,
              "runtime_mismatch",
              "运行器不能提交其他运行器的结果。",
              ["runtimeId"],
            );
          const owner = await transaction.unsafe<
            { readonly writable: boolean }[]
          >(
            "SELECT (runtime_id = $2 AND owner_state = 'confirmed' " +
              "AND disconnected = false " +
              "AND last_heartbeat_at > clock_timestamp() - ($3 * interval '1 millisecond')) " +
              "AS writable FROM runtime_connections WHERE bin_id = $1",
            [binId, checked.data.runtimeId, runtimeHeartbeatTimeoutMs],
          );
          if (owner[0]?.writable !== true)
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
          await transaction.unsafe(
            "UPDATE " +
              tableName +
              " SET status = $3, completed_scopes = $4, failure = $5, " +
              "check_result = $6, finished_at = clock_timestamp(), " +
              "stop_confirmed_at = clock_timestamp() " +
              "WHERE run_id = $1 AND bin_id = $2",
            [
              runId,
              binId,
              completion.status,
              jsonbParameter(database, completion.completedScopes),
              runFailure === null ? null : jsonbParameter(database, runFailure),
              completion.status === "completed" &&
              completion.check !== undefined
                ? jsonbParameter(database, completion.check)
                : null,
            ],
          );
          return { ok: true as const, value: runId };
        },
      );
      if (!completionResult.ok) return completionResult;
      const row = await readRun(database, binId, completionResult.value);
      if (row === undefined) throw new Error("运行结果提交后记录意外消失。");
      return { ok: true, value: await rowToRun(database, row) };
    },
  };
}

async function failOneQueuedRun(
  transaction: CoreTransaction,
  runId: string,
  failureValue: ManualRunFailure,
): Promise<void> {
  await transaction.unsafe(
    "UPDATE " +
      tableName +
      " SET status = 'failed', failure = $2, finished_at = clock_timestamp() " +
      "WHERE run_id = $1 AND status = 'queued'",
    [runId, transaction.json(failureValue)],
  );
}

async function failQueuedRuns(
  transaction: CoreTransaction,
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
  await transaction.unsafe(
    "UPDATE " +
      tableName +
      " SET status = 'failed', failure = $2, finished_at = clock_timestamp() " +
      "WHERE bin_id = $1 AND status = 'queued'",
    [binId, transaction.json(failureValue)],
  );
}
