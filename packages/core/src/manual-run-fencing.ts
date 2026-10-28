import {
  runtimeHeartbeatTimeoutMs,
  manualRunFailureSchema,
} from "@binny/contracts";
import { and, eq, exists, gt, inArray, isNull, not, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { CoreTransaction } from "./database.ts";
import { manualRuns, runtimeConnections } from "./schema.ts";

const activeStatuses = ["executing", "cancelling"] as const;

const interruptedFailure = {
  code: "runtime_interrupted",
  message: "运行器失联或被替换，本次运行未恢复执行。",
  impact: "本次运行已终结；确认旧执行者停止前，同一 bin 不会开始新运行。",
  suggestion: "检查运行器后重新触发新的运行。",
  requiresHuman: false,
} as const;

const activeRunOwner = alias(runtimeConnections, "active_run_owner");

/**
 * 心跳超时只终结运行，不代表远端进程已退出；owner_state 会继续阻止领取。
 */
export async function interruptExpiredManualRuns(
  transaction: CoreTransaction,
  binId?: string,
): Promise<readonly string[]> {
  const conditions = [
    inArray(manualRuns.status, activeStatuses),
    not(
      exists(
        transaction
          .select({ binId: activeRunOwner.binId })
          .from(activeRunOwner)
          .where(
            and(
              eq(activeRunOwner.binId, manualRuns.binId),
              eq(activeRunOwner.runtimeId, manualRuns.runtimeId),
              eq(activeRunOwner.disconnected, false),
              gt(
                activeRunOwner.lastHeartbeatAt,
                sql`clock_timestamp() - ${runtimeHeartbeatTimeoutMs} * interval '1 millisecond'`,
              ),
            ),
          ),
      ),
    ),
  ];
  if (binId !== undefined) conditions.push(eq(manualRuns.binId, binId));

  const rows = await transaction
    .update(manualRuns)
    .set({
      status: "failed",
      failure: interruptedFailure,
      finishedAt: sql`clock_timestamp()`,
    })
    .where(and(...conditions))
    .returning({ runId: manualRuns.runId, binId: manualRuns.binId });

  const affectedBinIds = [...new Set(rows.map((row) => row.binId))];
  if (affectedBinIds.length > 0) {
    await transaction
      .update(runtimeConnections)
      .set({ ownerState: "unconfirmed" })
      .where(inArray(runtimeConnections.binId, affectedBinIds));
  }
  return rows.map((row) => row.runId);
}

/** 新 controller 已取得同一 OS 锁，旧 worker 已关闭继承的锁 fd。 */
export async function interruptReplacedManualRuns(
  transaction: CoreTransaction,
  binId: string,
  previousRuntimeId: string,
): Promise<void> {
  const activeRunsForOwner = await transaction
    .select({
      runId: manualRuns.runId,
      cancelRequestedAt: manualRuns.cancelRequestedAt,
    })
    .from(manualRuns)
    .where(
      and(
        eq(manualRuns.binId, binId),
        eq(manualRuns.runtimeId, previousRuntimeId),
        inArray(manualRuns.status, activeStatuses),
      ),
    );
  for (const run of activeRunsForOwner) {
    await transaction
      .update(manualRuns)
      .set({
        status: run.cancelRequestedAt === null ? "failed" : "cancelled",
        failure: run.cancelRequestedAt === null ? interruptedFailure : null,
        finishedAt: sql`clock_timestamp()`,
        stopConfirmedAt: sql`clock_timestamp()`,
      })
      .where(eq(manualRuns.runId, run.runId));
  }

  const interruptedRuns = await transaction
    .select({
      runId: manualRuns.runId,
      cancelRequestedAt: manualRuns.cancelRequestedAt,
      failure: manualRuns.failure,
    })
    .from(manualRuns)
    .where(
      and(
        eq(manualRuns.binId, binId),
        eq(manualRuns.runtimeId, previousRuntimeId),
        eq(manualRuns.status, "failed"),
        isNull(manualRuns.stopConfirmedAt),
      ),
    );
  for (const run of interruptedRuns) {
    const checkedFailure = manualRunFailureSchema.safeParse(run.failure);
    if (
      !checkedFailure.success ||
      checkedFailure.data.code !== "runtime_interrupted"
    )
      continue;
    await transaction
      .update(manualRuns)
      .set({
        ...(run.cancelRequestedAt === null
          ? {}
          : {
              status: "cancelled",
              failure: null,
              finishedAt: sql`clock_timestamp()`,
            }),
        stopConfirmedAt: sql`clock_timestamp()`,
      })
      .where(eq(manualRuns.runId, run.runId));
  }
}

/** 当前运行器拥有有效心跳，且未被旧执行者停止确认状态阻塞。 */
export async function isRuntimeOwnerWritable(
  transaction: CoreTransaction,
  binId: string,
  runtimeId: string,
): Promise<boolean> {
  const [owner] = await transaction
    .select({ writable: runtimeConnections.runtimeId })
    .from(runtimeConnections)
    .where(
      and(
        eq(runtimeConnections.binId, binId),
        eq(runtimeConnections.runtimeId, runtimeId),
        eq(runtimeConnections.ownerState, "confirmed"),
        eq(runtimeConnections.disconnected, false),
        gt(
          runtimeConnections.lastHeartbeatAt,
          sql`clock_timestamp() - ${runtimeHeartbeatTimeoutMs} * interval '1 millisecond'`,
        ),
      ),
    );
  return owner !== undefined;
}

/**
 * 取消接受与新归档写共用运行行锁；receipt 命中后的只读重放不调用此函数。
 */
export async function lockManualRunForArchiveWrite(
  transaction: CoreTransaction,
  runId: string,
): Promise<boolean> {
  const [run] = await transaction
    .select({
      runId: manualRuns.runId,
      binId: manualRuns.binId,
      runtimeId: manualRuns.runtimeId,
      status: manualRuns.status,
    })
    .from(manualRuns)
    .where(eq(sql`${manualRuns.runId}::text`, runId))
    .for("update");
  if (run === undefined) return true;
  if (run.status !== "executing" || run.runtimeId === null) return false;
  if (await isRuntimeOwnerWritable(transaction, run.binId, run.runtimeId))
    return true;

  await transaction
    .update(manualRuns)
    .set({
      status: "failed",
      failure: interruptedFailure,
      finishedAt: sql`clock_timestamp()`,
    })
    .where(
      and(eq(manualRuns.runId, run.runId), eq(manualRuns.status, "executing")),
    );
  await transaction
    .update(runtimeConnections)
    .set({ ownerState: "unconfirmed" })
    .where(eq(runtimeConnections.binId, run.binId));
  return false;
}

/** 只在 controller 等待指定 worker 真实退出后，由其心跳确认停止。 */
export async function confirmManualRunOwnerStopped(
  transaction: CoreTransaction,
  binId: string,
  runtimeId: string,
  runId: string,
): Promise<boolean> {
  const [run] = await transaction
    .select({
      status: manualRuns.status,
      cancelRequestedAt: manualRuns.cancelRequestedAt,
      stopConfirmedAt: manualRuns.stopConfirmedAt,
      failure: manualRuns.failure,
    })
    .from(manualRuns)
    .where(
      and(
        eq(manualRuns.binId, binId),
        eq(manualRuns.runtimeId, runtimeId),
        eq(manualRuns.runId, runId),
      ),
    )
    .for("update");
  if (run === undefined) return false;

  let confirmed = run.stopConfirmedAt !== null;
  if (run.status === "executing" || run.status === "cancelling") {
    await transaction
      .update(manualRuns)
      .set({
        status: run.cancelRequestedAt === null ? "failed" : "cancelled",
        failure: run.cancelRequestedAt === null ? interruptedFailure : null,
        finishedAt: sql`clock_timestamp()`,
        stopConfirmedAt: sql`clock_timestamp()`,
      })
      .where(eq(manualRuns.runId, runId));
    confirmed = true;
  } else if (run.status === "failed" && run.stopConfirmedAt === null) {
    const checkedFailure = manualRunFailureSchema.safeParse(run.failure);
    if (
      checkedFailure.success &&
      checkedFailure.data.code === "runtime_interrupted"
    ) {
      await transaction
        .update(manualRuns)
        .set({
          ...(run.cancelRequestedAt === null
            ? {}
            : {
                status: "cancelled",
                failure: null,
                finishedAt: sql`clock_timestamp()`,
              }),
          stopConfirmedAt: sql`clock_timestamp()`,
        })
        .where(eq(manualRuns.runId, runId));
      confirmed = true;
    }
  }
  if (!confirmed) return false;

  const unresolvedRuns = await transaction
    .select({
      status: manualRuns.status,
      failure: manualRuns.failure,
      stopConfirmedAt: manualRuns.stopConfirmedAt,
    })
    .from(manualRuns)
    .where(eq(manualRuns.binId, binId));
  const unresolved = unresolvedRuns.some((candidate) => {
    if (candidate.status === "executing" || candidate.status === "cancelling")
      return true;
    if (candidate.status !== "failed" || candidate.stopConfirmedAt !== null)
      return false;
    const checkedFailure = manualRunFailureSchema.safeParse(candidate.failure);
    return (
      checkedFailure.success &&
      checkedFailure.data.code === "runtime_interrupted"
    );
  });
  if (unresolved) return false;

  const owners = await transaction
    .update(runtimeConnections)
    .set({ ownerState: "confirmed" })
    .where(
      and(
        eq(runtimeConnections.binId, binId),
        eq(runtimeConnections.runtimeId, runtimeId),
      ),
    )
    .returning({ binId: runtimeConnections.binId });
  return owners.length > 0;
}
