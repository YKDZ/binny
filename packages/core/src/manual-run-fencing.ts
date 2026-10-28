import { runtimeHeartbeatTimeoutMs } from "@binny/contracts";

import type { CoreTransaction } from "./database.ts";

const interruptedFailure = {
  code: "runtime_interrupted",
  message: "运行器失联或被替换，本次运行未恢复执行。",
  impact: "本次运行已终结；确认旧执行者停止前，同一 bin 不会开始新运行。",
  suggestion: "检查运行器后重新触发新的运行。",
  requiresHuman: false,
} as const;

/**
 * heartbeat 过期会终结 run，但不会确认远端进程退出；owner_state 继续阻止 claim。
 */
export async function interruptExpiredManualRuns(
  transaction: CoreTransaction,
  binId?: string,
): Promise<readonly string[]> {
  const timeoutParameter = binId === undefined ? "$2" : "$3";
  const rows = await transaction.unsafe<
    { readonly run_id: string; readonly bin_id: string }[]
  >(
    "UPDATE manual_runs AS run SET status = 'failed', failure = $1, " +
      "finished_at = clock_timestamp() " +
      "WHERE run.status IN ('executing', 'cancelling') " +
      (binId === undefined ? "" : "AND run.bin_id = $2 ") +
      "AND NOT EXISTS (SELECT 1 FROM runtime_connections AS owner " +
      "WHERE owner.bin_id = run.bin_id AND owner.runtime_id = run.runtime_id " +
      "AND owner.disconnected = false " +
      "AND owner.last_heartbeat_at > clock_timestamp() - (" +
      timeoutParameter +
      " * interval '1 millisecond')) " +
      "RETURNING run.run_id, run.bin_id",
    binId === undefined
      ? [transaction.json(interruptedFailure), runtimeHeartbeatTimeoutMs]
      : [
          transaction.json(interruptedFailure),
          binId,
          runtimeHeartbeatTimeoutMs,
        ],
  );

  for (const affectedBinId of new Set(rows.map((row) => row.bin_id))) {
    await transaction.unsafe(
      "UPDATE runtime_connections SET owner_state = 'unconfirmed' " +
        "WHERE bin_id = $1",
      [affectedBinId],
    );
  }
  return rows.map((row) => row.run_id);
}

/**
 * 新 controller 已持有同一 OS lock；旧 worker 必然已关闭继承的锁 fd。
 */
export async function interruptReplacedManualRuns(
  transaction: CoreTransaction,
  binId: string,
  previousRuntimeId: string,
): Promise<void> {
  await transaction.unsafe(
    "UPDATE manual_runs SET status = CASE WHEN cancel_requested_at IS NULL " +
      "THEN 'failed' ELSE 'cancelled' END, " +
      "failure = CASE WHEN cancel_requested_at IS NULL THEN $3 ELSE NULL END, " +
      "finished_at = clock_timestamp(), stop_confirmed_at = clock_timestamp() " +
      "WHERE bin_id = $1 AND runtime_id = $2 " +
      "AND status IN ('executing', 'cancelling')",
    [binId, previousRuntimeId, transaction.json(interruptedFailure)],
  );
  await transaction.unsafe(
    "UPDATE manual_runs SET status = CASE WHEN cancel_requested_at IS NULL " +
      "THEN status ELSE 'cancelled' END, " +
      "failure = CASE WHEN cancel_requested_at IS NULL THEN failure ELSE NULL END, " +
      "finished_at = CASE WHEN cancel_requested_at IS NULL THEN finished_at ELSE clock_timestamp() END, " +
      "stop_confirmed_at = clock_timestamp() " +
      "WHERE bin_id = $1 AND runtime_id = $2 AND status = 'failed' " +
      "AND failure->>'code' = 'runtime_interrupted' AND stop_confirmed_at IS NULL",
    [binId, previousRuntimeId],
  );
}

/**
 * 取消接受与归档新写共用 run 行锁；已命中 receipt 的只读重放不调用此函数。
 */
export async function lockManualRunForArchiveWrite(
  transaction: CoreTransaction,
  runId: string,
): Promise<boolean> {
  const rows = await transaction.unsafe<
    {
      readonly run_id: string;
      readonly bin_id: string;
      readonly runtime_id: string;
      readonly status: string;
      readonly cancel_requested_at: Date | null;
    }[]
  >(
    "SELECT run.run_id, run.bin_id, run.runtime_id, run.status, " +
      "run.cancel_requested_at FROM manual_runs AS run " +
      "WHERE run.run_id::text = $1 FOR UPDATE",
    [runId],
  );
  const run = rows[0];
  if (run === undefined) return true;
  if (run.status !== "executing") return false;

  const owners = await transaction.unsafe<{ readonly writable: boolean }[]>(
    "SELECT (owner.runtime_id = $2 AND owner.owner_state = 'confirmed' " +
      "AND owner.disconnected = false " +
      "AND owner.last_heartbeat_at > clock_timestamp() - ($3 * interval '1 millisecond')) " +
      "AS writable FROM runtime_connections AS owner WHERE owner.bin_id = $1",
    [run.bin_id, run.runtime_id, runtimeHeartbeatTimeoutMs],
  );
  if (owners[0]?.writable === true) return true;

  await transaction.unsafe(
    "UPDATE manual_runs SET status = 'failed', failure = $2, " +
      "finished_at = clock_timestamp() WHERE run_id = $1 AND status = 'executing'",
    [run.run_id, transaction.json(interruptedFailure)],
  );
  await transaction.unsafe(
    "UPDATE runtime_connections SET owner_state = 'unconfirmed' WHERE bin_id = $1",
    [run.bin_id],
  );
  return false;
}

/** 仅在 controller 已等待指定 run 的真实 worker 退出后，由 runtime heartbeat 调用。 */
export async function confirmManualRunOwnerStopped(
  transaction: CoreTransaction,
  binId: string,
  runtimeId: string,
  runId: string,
): Promise<boolean> {
  const rows = await transaction.unsafe<
    {
      readonly status: string;
      readonly cancel_requested_at: Date | null;
      readonly stop_confirmed_at: Date | null;
      readonly failure: { readonly code?: unknown } | null;
    }[]
  >(
    "SELECT status, cancel_requested_at, stop_confirmed_at, failure " +
      "FROM manual_runs WHERE bin_id = $1 AND runtime_id = $2 AND run_id = $3 FOR UPDATE",
    [binId, runtimeId, runId],
  );
  const run = rows[0];
  if (run === undefined) return false;

  let confirmed = run.stop_confirmed_at !== null;
  if (run.status === "executing" || run.status === "cancelling") {
    await transaction.unsafe(
      "UPDATE manual_runs SET status = CASE WHEN cancel_requested_at IS NULL " +
        "THEN 'failed' ELSE 'cancelled' END, " +
        "failure = CASE WHEN cancel_requested_at IS NULL THEN $2 ELSE NULL END, " +
        "finished_at = clock_timestamp(), stop_confirmed_at = clock_timestamp() " +
        "WHERE bin_id = $1 AND runtime_id = $3 AND run_id = $4 " +
        "AND status IN ('executing', 'cancelling')",
      [binId, transaction.json(interruptedFailure), runtimeId, runId],
    );
    confirmed = true;
  }
  if (
    run.status === "failed" &&
    run.failure?.code === "runtime_interrupted" &&
    run.stop_confirmed_at === null
  ) {
    const updated = await transaction.unsafe<{ readonly run_id: string }[]>(
      "UPDATE manual_runs SET status = CASE WHEN cancel_requested_at IS NULL " +
        "THEN status ELSE 'cancelled' END, " +
        "failure = CASE WHEN cancel_requested_at IS NULL THEN failure ELSE NULL END, " +
        "finished_at = CASE WHEN cancel_requested_at IS NULL THEN finished_at ELSE clock_timestamp() END, " +
        "stop_confirmed_at = clock_timestamp() " +
        "WHERE bin_id = $1 AND runtime_id = $2 AND run_id = $3 " +
        "AND status = 'failed' AND failure->>'code' = 'runtime_interrupted' " +
        "AND stop_confirmed_at IS NULL RETURNING run_id",
      [binId, runtimeId, runId],
    );
    confirmed = updated.length > 0;
  }
  if (!confirmed) return false;

  const unresolvedRuns = await transaction.unsafe<
    { readonly run_id: string }[]
  >(
    "SELECT run_id FROM manual_runs WHERE bin_id = $1 AND (" +
      "status IN ('executing', 'cancelling') OR " +
      "(status = 'failed' AND failure->>'code' = 'runtime_interrupted' " +
      "AND stop_confirmed_at IS NULL)) LIMIT 1",
    [binId],
  );
  if (unresolvedRuns.length > 0) return false;
  const owners = await transaction.unsafe<{ readonly bin_id: string }[]>(
    "UPDATE runtime_connections SET owner_state = 'confirmed' " +
      "WHERE bin_id = $1 AND runtime_id = $2 RETURNING bin_id",
    [binId, runtimeId],
  );
  return owners.length > 0;
}
