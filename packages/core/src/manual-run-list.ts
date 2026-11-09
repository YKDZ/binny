import {
  manualRunListCursorSchema,
  manualRunListPageSchema,
  manualRunListQuerySchema,
  manualRunListSummarySchema,
  type ManualRunListCursor,
  type ManualRunListFilter,
  type ManualRunListOperation,
  type ManualRunListOperations,
} from "@binny/contracts";
import { manualRuns, type Database } from "@binny/db";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";

function invalidCursor(): ManualRunListOperation<never> {
  return {
    ok: false,
    status: 400,
    error: {
      code: "invalid_input",
      message:
        "The run-list cursor is invalid or does not match these filters.",
      path: ["cursor"],
    },
  };
}

function decodeCursor(value: string): ManualRunListCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== value) return undefined;
    const checked = manualRunListCursorSchema.safeParse(JSON.parse(decoded));
    return checked.success ? checked.data : undefined;
  } catch {
    return undefined;
  }
}

function encodeCursor(value: ManualRunListCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function filterForCursor(
  input: ReturnType<typeof manualRunListQuerySchema.parse>,
  limit: number,
): ManualRunListFilter {
  return {
    ...(input.binId === undefined ? {} : { binId: input.binId }),
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.createdFrom === undefined
      ? {}
      : { createdFrom: input.createdFrom }),
    ...(input.createdBefore === undefined
      ? {}
      : { createdBefore: input.createdBefore }),
    limit,
  };
}

function cursorMatches(
  cursor: ManualRunListCursor,
  filter: ManualRunListFilter,
): boolean {
  return (
    cursor.filter.binId === filter.binId &&
    cursor.filter.action === filter.action &&
    cursor.filter.status === filter.status &&
    cursor.filter.createdFrom === filter.createdFrom &&
    cursor.filter.createdBefore === filter.createdBefore &&
    cursor.filter.limit === filter.limit
  );
}

/** Pages all bins in stable creation order; the compound cursor keeps newer runs out of later pages. */
export function createManualRunListStore(
  database: Database,
): ManualRunListOperations {
  return {
    async listRuns(input) {
      const checkedInput = manualRunListQuerySchema.safeParse(input);
      if (!checkedInput.success) {
        const issue = checkedInput.error.issues[0];
        return {
          ok: false,
          status: 400,
          error: {
            code: "invalid_input",
            message: issue?.message ?? "Run list filters are invalid.",
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
        conditions.push(eq(manualRuns.binId, query.binId));
      if (query.action !== undefined)
        conditions.push(eq(manualRuns.action, query.action));
      if (query.status !== undefined)
        conditions.push(eq(manualRuns.status, query.status));
      // Cast the original ISO string so Date conversion does not truncate filter microseconds.
      if (query.createdFrom !== undefined) {
        conditions.push(
          sql`${manualRuns.createdAt} >= ${query.createdFrom}::timestamptz`,
        );
      }
      if (query.createdBefore !== undefined) {
        conditions.push(
          sql`${manualRuns.createdAt} < ${query.createdBefore}::timestamptz`,
        );
      }
      if (cursor !== undefined) {
        const cursorCreatedAt = sql`${cursor.before.createdAt}::timestamptz`;
        conditions.push(
          or(
            lt(manualRuns.createdAt, cursorCreatedAt),
            and(
              eq(manualRuns.createdAt, cursorCreatedAt),
              lt(manualRuns.binId, cursor.before.binId),
            ),
            and(
              eq(manualRuns.createdAt, cursorCreatedAt),
              eq(manualRuns.binId, cursor.before.binId),
              lt(manualRuns.runId, cursor.before.runId),
            ),
          )!,
        );
      }

      const rows = await database
        .select({
          runId: manualRuns.runId,
          binId: manualRuns.binId,
          action: manualRuns.action,
          status: manualRuns.status,
          startedAt: manualRuns.startedAt,
          finishedAt: manualRuns.finishedAt,
          // 保留 PostgreSQL 微秒精度，避免游标边界退化为 JavaScript 毫秒。
          createdAt: sql<string>`to_char(${manualRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(manualRuns)
        .where(and(...conditions))
        .orderBy(
          desc(manualRuns.createdAt),
          desc(manualRuns.binId),
          desc(manualRuns.runId),
        )
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const runs = pageRows.map((row) =>
        manualRunListSummarySchema.parse({
          runId: row.runId,
          binId: row.binId,
          action: row.action,
          status: row.status,
          createdAt: row.createdAt,
          ...(row.startedAt === null
            ? {}
            : { startedAt: row.startedAt.toISOString() }),
          ...(row.finishedAt === null
            ? {}
            : { finishedAt: row.finishedAt.toISOString() }),
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
                runId: lastRow.runId,
              },
            })
          : undefined;

      return {
        ok: true,
        value: manualRunListPageSchema.parse({
          runs,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        }),
      };
    },
  };
}
