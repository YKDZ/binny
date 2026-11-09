import {
  scheduleListCursorSchema,
  scheduleListPageSchema,
  scheduleListQuerySchema,
  scheduleListSummarySchema,
  type ScheduleListCursor,
  type ScheduleListFilter,
  type ScheduleListOperation,
  type ScheduleListOperations,
} from "@binny/contracts";
import { schedules, type Database } from "@binny/db";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";

function invalidCursor(): ScheduleListOperation<never> {
  return {
    ok: false,
    status: 400,
    error: {
      code: "invalid_input",
      message:
        "The schedule-list cursor is invalid or does not match these filters.",
      path: ["cursor"],
    },
  };
}

function decodeCursor(value: string): ScheduleListCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== value) return undefined;
    const checked = scheduleListCursorSchema.safeParse(JSON.parse(decoded));
    return checked.success ? checked.data : undefined;
  } catch {
    return undefined;
  }
}

function encodeCursor(value: ScheduleListCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function filterForCursor(
  input: ReturnType<typeof scheduleListQuerySchema.parse>,
  limit: number,
): ScheduleListFilter {
  return {
    ...(input.binId === undefined ? {} : { binId: input.binId }),
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.enabled === undefined
      ? {}
      : { enabled: input.enabled === "true" }),
    limit,
  };
}

function cursorMatches(
  cursor: ScheduleListCursor,
  filter: ScheduleListFilter,
): boolean {
  return (
    cursor.filter.binId === filter.binId &&
    cursor.filter.action === filter.action &&
    cursor.filter.enabled === filter.enabled &&
    cursor.filter.limit === filter.limit
  );
}

/** Returns identity and scheduling status only; saved action params stay on detail reads. */
export function createScheduleListStore(
  database: Database,
): ScheduleListOperations {
  return {
    async listScheduleSummaries(input) {
      const checkedInput = scheduleListQuerySchema.safeParse(input);
      if (!checkedInput.success) {
        const issue = checkedInput.error.issues[0];
        return {
          ok: false,
          status: 400,
          error: {
            code: "invalid_input",
            message: issue?.message ?? "Schedule list filters are invalid.",
            ...(issue === undefined
              ? {}
              : {
                  path: issue.path.map((part) =>
                    typeof part === "symbol" ? String(part) : part,
                  ),
                }),
          },
        };
      }

      const query = checkedInput.data;
      const limit = Number(query.limit ?? "20");
      const filter = filterForCursor(query, limit);
      const cursor =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (
        query.cursor !== undefined &&
        (cursor === undefined || !cursorMatches(cursor, filter))
      ) {
        return invalidCursor();
      }

      const conditions = [];
      if (query.binId !== undefined)
        conditions.push(eq(schedules.binId, query.binId));
      if (query.action !== undefined)
        conditions.push(eq(schedules.action, query.action));
      if (query.enabled !== undefined)
        conditions.push(eq(schedules.enabled, query.enabled === "true"));
      if (cursor !== undefined) {
        const cursorCreatedAt = sql`${cursor.before.createdAt}::timestamptz`;
        conditions.push(
          or(
            gt(schedules.createdAt, cursorCreatedAt),
            and(
              eq(schedules.createdAt, cursorCreatedAt),
              gt(schedules.binId, cursor.before.binId),
            ),
            and(
              eq(schedules.createdAt, cursorCreatedAt),
              eq(schedules.binId, cursor.before.binId),
              gt(schedules.scheduleId, cursor.before.scheduleId),
            ),
          )!,
        );
      }

      const rows = await database
        .select({
          scheduleId: schedules.scheduleId,
          binId: schedules.binId,
          action: schedules.action,
          enabled: schedules.enabled,
          nextDueAt: schedules.nextDueAt,
          // Retain PostgreSQL microseconds in the continuation key.
          createdAt: sql<string>`to_char(${schedules.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(schedules)
        .where(and(...conditions))
        .orderBy(
          asc(schedules.createdAt),
          asc(schedules.binId),
          asc(schedules.scheduleId),
        )
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const scheduleSummaries = pageRows.map((row) =>
        scheduleListSummarySchema.parse({
          scheduleId: row.scheduleId,
          binId: row.binId,
          action: row.action,
          enabled: row.enabled,
          nextDueAt: row.nextDueAt.toISOString(),
          createdAt: row.createdAt,
        }),
      );
      const lastRow = pageRows.at(-1);
      const nextCursor =
        hasMore && lastRow !== undefined
          ? encodeCursor({
              version: 1,
              filter,
              before: {
                createdAt: lastRow.createdAt,
                binId: lastRow.binId,
                scheduleId: lastRow.scheduleId,
              },
            })
          : undefined;

      return {
        ok: true,
        value: scheduleListPageSchema.parse({
          schedules: scheduleSummaries,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        }),
      };
    },
  };
}
