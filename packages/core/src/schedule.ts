import { randomUUID } from "node:crypto";

import {
  binConfigurationSettingsSchema,
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
  schedules,
  type Database,
  type Transaction,
} from "@binny/db";
import { CronExpressionParser } from "cron-parser";
import { and, eq, lte, sql } from "drizzle-orm";

import { validateSourceAdapterActionParameters } from "./bin-configuration.ts";
import { createQueuedRunInTransaction } from "./manual-run.ts";

type ScheduleStore = ScheduleOperations & {
  readonly processDueSchedules: () => Promise<void>;
};

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

function toSchedule(row: typeof schedules.$inferSelect): Schedule {
  return scheduleSchema.parse({
    scheduleId: row.scheduleId,
    binId: row.binId,
    expression: row.expression,
    timeZone: row.timeZone,
    action: row.action,
    params: row.params,
    enabled: row.enabled,
    nextDueAt: row.nextDueAt.toISOString(),
    ...(row.lastError === null
      ? {}
      : { lastError: scheduleLastErrorSchema.parse(row.lastError) }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function scheduleActionError(
  bin: {
    readonly id: string;
    readonly sourceAdapter: unknown;
    readonly identityId: string;
    readonly config: unknown;
  },
  action: string,
  params: unknown,
): ScheduleApiError | undefined {
  const configuredBin = binConfigurationSettingsSchema.parse(bin);
  const checkedParams = jsonObjectSchema.safeParse(params);
  if (!checkedParams.success) {
    return {
      code: "invalid_input",
      message: "计划参数必须是 JSON 对象。",
      path: ["params"],
    };
  }
  const result = validateSourceAdapterActionParameters(
    configuredBin.sourceAdapter,
    action,
    checkedParams.data,
  );
  if (result.ok) return undefined;
  if (
    result.code === "action_not_found" ||
    result.code === "invalid_action_parameters"
  ) {
    return {
      code: result.code,
      message: result.message,
      ...(result.path === undefined ? {} : { path: [...result.path] }),
    };
  }
  return {
    code: "invalid_input",
    message: result.message,
    ...(result.path === undefined ? {} : { path: [...result.path] }),
  };
}

function readBinForRun(transaction: Transaction, binId: string) {
  return transaction
    .select({
      id: binConfigurations.id,
      sourceAdapter: binConfigurations.sourceAdapter,
      identityId: binConfigurations.identityId,
      config: binConfigurations.config,
      status: binConfigurations.status,
    })
    .from(binConfigurations)
    .where(eq(binConfigurations.id, binId))
    .for("update");
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
        return { ok: true, value: rows.map(toSchedule) };
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
        return row === undefined
          ? failure(404, "schedule_not_found", "没有找到这个采集计划。", [
              "scheduleId",
            ])
          : { ok: true, value: toSchedule(row) };
      });
    },

    async createSchedule(binId, input) {
      const checked = scheduleCreateInputSchema.safeParse(input);
      if (!checked.success) return inputFailure(checked.error);
      const scheduleId = randomUUID();
      return await database.transaction(async (transaction) => {
        const [bin] = await readBinForRun(transaction, binId);
        if (bin === undefined) {
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        }
        const actionError = scheduleActionError(
          bin,
          checked.data.action,
          checked.data.params,
        );
        if (actionError !== undefined) {
          return { ok: false, status: 400, error: actionError };
        }
        const nextDue = computeNextDue(
          checked.data.expression,
          checked.data.timeZone,
          scheduleId,
          new Date(),
        );
        if (!nextDue.ok)
          return { ok: false, status: 400, error: nextDue.error };
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
        const updated = {
          expression: checked.data.expression ?? current.expression,
          timeZone: checked.data.timeZone ?? current.timeZone,
          action: checked.data.action ?? current.action,
          params: checked.data.params ?? current.params,
        };
        const actionError = scheduleActionError(
          bin,
          updated.action,
          updated.params,
        );
        if (actionError !== undefined) {
          return { ok: false, status: 400, error: actionError };
        }
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
        return { ok: true, value: toSchedule(row) };
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
        return { ok: true, value: toSchedule(row) };
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
