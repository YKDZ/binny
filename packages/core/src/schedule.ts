import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  jsonObjectSchema,
  scheduleCreateInputSchema,
  scheduleLastErrorSchema,
  scheduleSchema,
  scheduleUpdateInputSchema,
  type Schedule,
  type ScheduleApiError,
  type ScheduleOperation,
  type ScheduleOperations,
} from "@binny/contracts";
import {
  binConfigurations,
  manualRuns,
  schedules,
  type Database,
  type ReservedDatabaseConnection,
  type Transaction,
} from "@binny/db";
import { CronExpressionParser } from "cron-parser";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { createQueuedRunInTransaction } from "./manual-run.ts";
import {
  actionInputSnapshotStillCurrent,
  preflightActionInput,
} from "./runtime-action-validation.ts";

type ScheduleStore = ScheduleOperations & {
  readonly processDueSchedules: () => Promise<void>;
  readonly skipOverdueSchedules: () => Promise<void>;
};

export type ScheduleDispatcher = {
  readonly close: () => Promise<void>;
  readonly ensureActiveSession: () => Promise<void>;
};

const scheduleAdvisoryNamespace = 0x4249_4e59;
const scheduleBootstrapLockKey = 1;
const scheduleLifecycleLockKey = 2;

type DueResult =
  | { readonly ok: true; readonly value: Date }
  | { readonly ok: false; readonly error: ScheduleApiError };

function failure<T>(
  status: 400 | 404 | 409,
  code: ScheduleApiError["code"],
  message: string,
  path?: readonly (string | number)[],
): ScheduleOperation<T> {
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

type ZodIssueLike = {
  readonly message: string;
  readonly path: readonly PropertyKey[];
};

function inputFailure<T>(error: { readonly issues: readonly ZodIssueLike[] }) {
  const issue = error.issues[0];
  const path = issue === undefined ? undefined : pathParts(issue.path);
  return failure<T>(
    400,
    "invalid_input",
    issue?.message ?? "计划请求格式无效。",
    path,
  );
}

function computeNextDue(
  expression: string,
  timeZone: string,
  scheduleId: string,
  after: Date,
): DueResult {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone });
    formatter.format(after);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_time_zone",
        message: "时区必须是有效的 IANA 时区名称。",
        path: ["timeZone"],
      },
    };
  }

  try {
    // 固定 H 字段的种子；DST 跳时和重复时段沿用 cron-parser 的时区规则。
    const iterator = CronExpressionParser.parse(expression, {
      currentDate: after,
      hashSeed: scheduleId,
      strict: true,
      tz: timeZone,
    });
    return { ok: true, value: iterator.next().toDate() };
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_schedule_expression",
        message:
          "表达式必须符合 cron-parser 的 strict 规则，且日期与星期不能同时指定。",
        path: ["expression"],
      },
    };
  }
}

async function latestScheduleRunIds(
  database: Database | Transaction,
  binId: string,
  scheduleIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (scheduleIds.length === 0) return new Map();
  const rows = await database
    .select({
      scheduleId: manualRuns.scheduleId,
      runId: manualRuns.runId,
    })
    .from(manualRuns)
    .where(
      and(
        eq(manualRuns.binId, binId),
        inArray(manualRuns.scheduleId, scheduleIds),
      ),
    )
    .orderBy(
      asc(manualRuns.scheduleId),
      desc(manualRuns.createdAt),
      desc(manualRuns.runId),
    );
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (row.scheduleId !== null && !latest.has(row.scheduleId)) {
      latest.set(row.scheduleId, row.runId);
    }
  }
  return latest;
}

function toSchedule(
  row: typeof schedules.$inferSelect,
  lastRunId?: string,
): Schedule {
  return scheduleSchema.parse({
    scheduleId: row.scheduleId,
    binId: row.binId,
    expression: row.expression,
    timeZone: row.timeZone,
    action: row.action,
    params: row.params,
    enabled: row.enabled,
    nextDueAt: row.nextDueAt.toISOString(),
    ...(lastRunId === undefined ? {} : { lastRunId }),
    ...(row.lastError === null
      ? {}
      : { lastError: scheduleLastErrorSchema.parse(row.lastError) }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function readBinForRun(transaction: Transaction, binId: string) {
  return transaction
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
}

async function unlockScheduleAdvisoryLock(
  session: ReservedDatabaseConnection,
  lockKey: number,
  shared: boolean,
): Promise<void> {
  const rows = shared
    ? await session.database.execute<{ readonly unlocked: boolean }>(
        sql`select pg_advisory_unlock_shared(${scheduleAdvisoryNamespace}, ${lockKey}) as unlocked`,
        "objects",
      )
    : await session.database.execute<{ readonly unlocked: boolean }>(
        sql`select pg_advisory_unlock(${scheduleAdvisoryNamespace}, ${lockKey}) as unlocked`,
        "objects",
      );
  if (rows[0]?.unlocked !== true)
    throw new Error(
      "采集计划 dispatcher 没有持有预期的 PostgreSQL advisory lock。",
    );
}

type ScheduleSessionMarker = {
  readonly pid: number;
  readonly backendStart: string;
};

async function readScheduleSessionMarker(
  session: ReservedDatabaseConnection,
): Promise<ScheduleSessionMarker> {
  const rows = await session.database.execute<{
    readonly pid: number;
    readonly backendStart: string;
  }>(
    // backend_start 转成文本可保留 PostgreSQL 的微秒精度。
    sql`select pid, backend_start::text as "backendStart" from pg_stat_activity where pid = pg_backend_pid()`,
    "objects",
  );
  const marker = rows[0];
  if (marker === undefined)
    throw new Error("无法读取采集计划 dispatcher 的 PostgreSQL session 标记。");
  return { pid: Number(marker.pid), backendStart: marker.backendStart };
}

async function hasSharedScheduleSessionMarker(
  database: Database,
  marker: ScheduleSessionMarker,
): Promise<boolean> {
  // PostgreSQL 重启后旧 reservation 可能失效，只能通过普通池查询目录。
  const rows = await database.execute<{ readonly active: boolean }>(
    sql`select exists (
      select 1
      from pg_stat_activity as activity
      join pg_locks as locks on locks.pid = activity.pid
      where activity.pid = ${marker.pid}
        and activity.backend_start = ${marker.backendStart}::timestamptz
        and locks.locktype = 'advisory'
        and locks.classid = ${scheduleAdvisoryNamespace}::oid
        and locks.objid = ${scheduleLifecycleLockKey}::oid
        and locks.objsubid = 2
        and locks.mode = 'ShareLock'
        and locks.granted
    ) as active`,
    "objects",
  );
  return rows[0]?.active === true;
}

/** 通过保留的同池 PostgreSQL session 判断其他 core 是否仍在运行。 */
export async function startScheduleDispatcher(
  schedulesStore: Pick<ScheduleStore, "skipOverdueSchedules">,
  database: Database,
  reserveSession: () => Promise<ReservedDatabaseConnection>,
): Promise<ScheduleDispatcher> {
  let session = await reserveSession();
  let sessionMarker: ScheduleSessionMarker | undefined;
  let hasExclusiveLifecycleLock = false;
  let hasSharedLifecycleLock = false;
  let closed = false;

  try {
    await session.database.execute(
      sql`select pg_advisory_lock(${scheduleAdvisoryNamespace}, ${scheduleBootstrapLockKey})`,
    );
    const lockRows = await session.database.execute<{
      readonly acquired: boolean;
    }>(
      sql`select pg_try_advisory_lock(${scheduleAdvisoryNamespace}, ${scheduleLifecycleLockKey}) as acquired`,
      "objects",
    );
    hasExclusiveLifecycleLock = lockRows[0]?.acquired === true;

    if (hasExclusiveLifecycleLock) await schedulesStore.skipOverdueSchedules();

    await session.database.execute(
      sql`select pg_advisory_lock_shared(${scheduleAdvisoryNamespace}, ${scheduleLifecycleLockKey})`,
    );
    hasSharedLifecycleLock = true;
    if (hasExclusiveLifecycleLock) {
      await unlockScheduleAdvisoryLock(
        session,
        scheduleLifecycleLockKey,
        false,
      );
      hasExclusiveLifecycleLock = false;
    }
    sessionMarker = await readScheduleSessionMarker(session);
    await unlockScheduleAdvisoryLock(session, scheduleBootstrapLockKey, false);

    return {
      ensureActiveSession: async () => {
        if (closed) throw new Error("采集计划 dispatcher 已关闭。");
        if (
          sessionMarker !== undefined &&
          (await hasSharedScheduleSessionMarker(database, sessionMarker))
        )
          return;

        // 当前 core 仍在轮询；恢复时只重建 shared 标记，不跳过到期计划。
        hasSharedLifecycleLock = false;
        const replacement = await reserveSession();
        try {
          await replacement.database.execute(
            sql`select pg_advisory_lock_shared(${scheduleAdvisoryNamespace}, ${scheduleLifecycleLockKey})`,
          );
          const replacementMarker =
            await readScheduleSessionMarker(replacement);
          session = replacement;
          sessionMarker = replacementMarker;
          hasSharedLifecycleLock = true;
        } catch (error) {
          replacement.release();
          throw error;
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (
          !hasSharedLifecycleLock ||
          sessionMarker === undefined ||
          !(await hasSharedScheduleSessionMarker(database, sessionMarker))
        )
          return;
        await unlockScheduleAdvisoryLock(
          session,
          scheduleLifecycleLockKey,
          true,
        );
        hasSharedLifecycleLock = false;
        session.release();
      },
    };
  } catch (error) {
    await session.database
      .execute(sql`select pg_advisory_unlock_all()`)
      .catch(() => undefined);
    session.release();
    throw error;
  }
}

export function createScheduleStore(database: Database): ScheduleStore {
  return {
    async listSchedules(binId) {
      return await database.transaction(async (transaction) => {
        const [bin] = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId));
        if (bin === undefined) {
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        }
        const rows = await transaction
          .select()
          .from(schedules)
          .where(eq(schedules.binId, binId))
          .orderBy(schedules.createdAt, schedules.scheduleId);
        const lastRunIds = await latestScheduleRunIds(
          transaction,
          binId,
          rows.map(({ scheduleId }) => scheduleId),
        );
        return {
          ok: true,
          value: rows.map((row) =>
            toSchedule(row, lastRunIds.get(row.scheduleId)),
          ),
        };
      });
    },

    async getSchedule(binId, scheduleId) {
      return await database.transaction(async (transaction) => {
        const [bin] = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId));
        if (bin === undefined) {
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        }
        const rows = await transaction
          .select()
          .from(schedules)
          .where(
            and(
              eq(schedules.binId, binId),
              eq(schedules.scheduleId, scheduleId),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (row === undefined) {
          return failure(404, "schedule_not_found", "没有找到这个采集计划。", [
            "scheduleId",
          ]);
        }
        const lastRunIds = await latestScheduleRunIds(transaction, binId, [
          row.scheduleId,
        ]);
        return {
          ok: true,
          value: toSchedule(row, lastRunIds.get(row.scheduleId)),
        };
      });
    },

    async createSchedule(binId, input) {
      const checked = scheduleCreateInputSchema.safeParse(input);
      if (!checked.success) return inputFailure(checked.error);
      const scheduleId = randomUUID();
      const initialNextDue = computeNextDue(
        checked.data.expression,
        checked.data.timeZone,
        scheduleId,
        new Date(),
      );
      if (!initialNextDue.ok)
        return { ok: false, status: 400, error: initialNextDue.error };
      const preflight = await preflightActionInput(
        database,
        binId,
        checked.data.action,
        checked.data.params,
      );
      if (!preflight.ok) return preflight;
      const nextDue = computeNextDue(
        checked.data.expression,
        checked.data.timeZone,
        scheduleId,
        new Date(),
      );
      if (!nextDue.ok) return { ok: false, status: 400, error: nextDue.error };

      return await database.transaction(async (transaction) => {
        const [bin] = await readBinForRun(transaction, binId);
        if (bin === undefined) {
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        }
        if (
          !(await actionInputSnapshotStillCurrent(
            transaction,
            preflight.snapshot,
          ))
        ) {
          return failure(
            409,
            "action_input_changed",
            "长期配置或运行器在计划参数原生校验期间发生变化，请重新提交。",
            ["params"],
          );
        }
        const [row] = await transaction
          .insert(schedules)
          .values({
            scheduleId,
            binId,
            expression: checked.data.expression,
            timeZone: checked.data.timeZone,
            action: checked.data.action,
            params: checked.data.params,
            enabled: checked.data.enabled ?? true,
            nextDueAt: nextDue.value,
          })
          .returning();
        if (row === undefined) throw new Error("采集计划创建后没有返回记录。");
        return { ok: true, value: toSchedule(row) };
      });
    },

    async updateSchedule(binId, scheduleId, input) {
      const checked = scheduleUpdateInputSchema.safeParse(input);
      if (!checked.success) return inputFailure(checked.error);
      const initial = await database.transaction(async (transaction) => {
        const [bin] = await readBinForRun(transaction, binId);
        if (bin === undefined) return { error: "bin_not_found" as const };
        const [current] = await transaction
          .select()
          .from(schedules)
          .where(
            and(
              eq(schedules.binId, binId),
              eq(schedules.scheduleId, scheduleId),
            ),
          )
          .limit(1);
        return current === undefined
          ? { error: "schedule_not_found" as const }
          : { current };
      });
      if ("error" in initial) {
        return initial.error === "bin_not_found"
          ? failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"])
          : failure(404, "schedule_not_found", "没有找到这个采集计划。", [
              "scheduleId",
            ]);
      }

      const hasInputChange =
        checked.data.action !== undefined || checked.data.params !== undefined;
      const initialUpdated = {
        expression: checked.data.expression ?? initial.current.expression,
        timeZone: checked.data.timeZone ?? initial.current.timeZone,
        action: checked.data.action ?? initial.current.action,
        params:
          checked.data.params ?? jsonObjectSchema.parse(initial.current.params),
      };
      const initialNextDue = computeNextDue(
        initialUpdated.expression,
        initialUpdated.timeZone,
        initial.current.scheduleId,
        new Date(),
      );
      if (!initialNextDue.ok)
        return { ok: false, status: 400, error: initialNextDue.error };

      const preflight = hasInputChange
        ? await preflightActionInput(
            database,
            binId,
            initialUpdated.action,
            initialUpdated.params,
          )
        : undefined;
      if (preflight !== undefined && !preflight.ok) return preflight;

      return await database.transaction(async (transaction) => {
        const [bin] = await readBinForRun(transaction, binId);
        if (bin === undefined) {
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        }
        const rows = await transaction
          .select()
          .from(schedules)
          .where(
            and(
              eq(schedules.binId, binId),
              eq(schedules.scheduleId, scheduleId),
            ),
          )
          .for("update")
          .limit(1);
        const current = rows[0];
        if (current === undefined) {
          return failure(404, "schedule_not_found", "没有找到这个采集计划。", [
            "scheduleId",
          ]);
        }
        if (
          hasInputChange &&
          (preflight === undefined ||
            current.action !== initial.current.action ||
            !isDeepStrictEqual(current.params, initial.current.params) ||
            !(await actionInputSnapshotStillCurrent(
              transaction,
              preflight.snapshot,
            )))
        ) {
          return failure(
            409,
            "action_input_changed",
            "计划参数、长期配置或运行器在原生校验期间发生变化，请重新提交。",
            ["params"],
          );
        }
        const updated = {
          expression: checked.data.expression ?? current.expression,
          timeZone: checked.data.timeZone ?? current.timeZone,
          action: checked.data.action ?? current.action,
          params: checked.data.params ?? current.params,
        };
        const nextDue = computeNextDue(
          updated.expression,
          updated.timeZone,
          current.scheduleId,
          new Date(),
        );
        if (!nextDue.ok)
          return { ok: false, status: 400, error: nextDue.error };
        const [row] = await transaction
          .update(schedules)
          .set({
            ...updated,
            nextDueAt: nextDue.value,
            lastError: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schedules.scheduleId, scheduleId))
          .returning();
        if (row === undefined) throw new Error("采集计划修改后没有返回记录。");
        const lastRunIds = await latestScheduleRunIds(transaction, binId, [
          scheduleId,
        ]);
        return {
          ok: true,
          value: toSchedule(row, lastRunIds.get(scheduleId)),
        };
      });
    },

    async setScheduleEnabled(binId, scheduleId, enabled) {
      return await database.transaction(async (transaction) => {
        const [bin] = await readBinForRun(transaction, binId);
        if (bin === undefined) {
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        }
        const rows = await transaction
          .select()
          .from(schedules)
          .where(
            and(
              eq(schedules.binId, binId),
              eq(schedules.scheduleId, scheduleId),
            ),
          )
          .for("update")
          .limit(1);
        const current = rows[0];
        if (current === undefined) {
          return failure(404, "schedule_not_found", "没有找到这个采集计划。", [
            "scheduleId",
          ]);
        }
        const nextDue = computeNextDue(
          current.expression,
          current.timeZone,
          current.scheduleId,
          new Date(),
        );
        if (!nextDue.ok)
          return { ok: false, status: 400, error: nextDue.error };
        const [row] = await transaction
          .update(schedules)
          .set({
            enabled,
            nextDueAt: nextDue.value,
            ...(enabled ? { lastError: null } : {}),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schedules.scheduleId, scheduleId))
          .returning();
        if (row === undefined)
          throw new Error("采集计划状态修改后没有返回记录。");
        const lastRunIds = await latestScheduleRunIds(transaction, binId, [
          scheduleId,
        ]);
        return {
          ok: true,
          value: toSchedule(row, lastRunIds.get(scheduleId)),
        };
      });
    },

    async deleteSchedule(binId, scheduleId) {
      return await database.transaction(async (transaction) => {
        const [bin] = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined) {
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        }
        const [row] = await transaction
          .delete(schedules)
          .where(
            and(
              eq(schedules.binId, binId),
              eq(schedules.scheduleId, scheduleId),
            ),
          )
          .returning({ scheduleId: schedules.scheduleId });
        if (row === undefined) {
          return failure(404, "schedule_not_found", "没有找到这个采集计划。", [
            "scheduleId",
          ]);
        }
        return {
          ok: true,
          value: { removed: true as const, scheduleId: row.scheduleId },
        };
      });
    },

    async skipOverdueSchedules() {
      const now = new Date();
      const dueRows = await database
        .select({ binId: schedules.binId, scheduleId: schedules.scheduleId })
        .from(schedules)
        .where(and(eq(schedules.enabled, true), lte(schedules.nextDueAt, now)))
        .orderBy(schedules.nextDueAt, schedules.binId, schedules.scheduleId);

      for (const due of dueRows) {
        await database.transaction(async (transaction) => {
          const [bin] = await readBinForRun(transaction, due.binId);
          if (bin === undefined) return;
          const rows = await transaction
            .select()
            .from(schedules)
            .where(
              and(
                eq(schedules.binId, due.binId),
                eq(schedules.scheduleId, due.scheduleId),
                eq(schedules.enabled, true),
                lte(schedules.nextDueAt, now),
              ),
            )
            .for("update")
            .limit(1);
          const current = rows[0];
          if (current === undefined) return;

          const nextDue = computeNextDue(
            current.expression,
            current.timeZone,
            current.scheduleId,
            now,
          );
          if (!nextDue.ok) {
            await transaction
              .update(schedules)
              .set({
                enabled: false,
                lastError: nextDue.error,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(schedules.scheduleId, current.scheduleId));
            return;
          }

          // 该到期点没有对应运行，因此推进计划以跳过它，并保留已有排队运行。
          await transaction
            .update(schedules)
            .set({
              nextDueAt: nextDue.value,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(schedules.scheduleId, current.scheduleId));
        });
      }
    },

    async processDueSchedules() {
      const now = new Date();
      const dueRows = await database
        .select({ binId: schedules.binId, scheduleId: schedules.scheduleId })
        .from(schedules)
        .where(and(eq(schedules.enabled, true), lte(schedules.nextDueAt, now)))
        .orderBy(schedules.nextDueAt, schedules.binId, schedules.scheduleId);

      for (const due of dueRows) {
        await database.transaction(async (transaction) => {
          // 所有计划路径都遵守 bin → schedule → run 的锁序，避免配置与到期处理互锁。
          const [bin] = await readBinForRun(transaction, due.binId);
          if (bin === undefined) return;
          const rows = await transaction
            .select()
            .from(schedules)
            .where(
              and(
                eq(schedules.binId, due.binId),
                eq(schedules.scheduleId, due.scheduleId),
                eq(schedules.enabled, true),
                lte(schedules.nextDueAt, now),
              ),
            )
            .for("update")
            .limit(1);
          const current = rows[0];
          if (current === undefined) return;

          const nextDue = computeNextDue(
            current.expression,
            current.timeZone,
            current.scheduleId,
            now,
          );
          if (!nextDue.ok) {
            await transaction
              .update(schedules)
              .set({
                enabled: false,
                lastError: nextDue.error,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(schedules.scheduleId, current.scheduleId));
            return;
          }

          const run = await createQueuedRunInTransaction(
            transaction,
            bin,
            {
              action: current.action,
              params: jsonObjectSchema.parse(current.params),
            },
            {
              kind: "schedule",
              scheduleId: current.scheduleId,
              scheduledFor: current.nextDueAt.toISOString(),
            },
          );
          // 停用 bin 或参数已失效时不创建 run，记录原因并推进，避免停用期间反复积压。
          // 只补一个最早尚未处理的到期点；创建运行和跳过后续错过点在同一事务提交。
          const lastError = run.ok
            ? null
            : {
                code: run.error.code,
                message: run.error.message,
                ...(run.error.path === undefined
                  ? {}
                  : { path: run.error.path }),
              };
          await transaction
            .update(schedules)
            .set({
              nextDueAt: nextDue.value,
              lastError,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(schedules.scheduleId, current.scheduleId));
        });
      }
    },
  };
}
