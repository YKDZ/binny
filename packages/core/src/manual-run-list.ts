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
      message: "运行列表游标无效或与当前筛选条件不匹配。",
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
  binId: string,
  filter: ManualRunListFilter,
): boolean {
  return (
    cursor.binId === binId &&
    cursor.filter.action === filter.action &&
    cursor.filter.status === filter.status &&
    cursor.filter.createdFrom === filter.createdFrom &&
    cursor.filter.createdBefore === filter.createdBefore &&
    cursor.filter.limit === filter.limit
  );
}

/** 按运行创建顺序读取历史，游标固定复合键以排除页间新增记录。 */
export function createManualRunListStore(
  database: Database,
): ManualRunListOperations {
  return {
    async listRuns(binId, input) {
      const checkedInput = manualRunListQuerySchema.safeParse(input);
      if (!checkedInput.success) {
        const issue = checkedInput.error.issues[0];
        return {
          ok: false,
          status: 400,
          error: {
            code: "invalid_input",
            message: issue?.message ?? "运行记录筛选条件无效。",
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
        (cursor === undefined || !cursorMatches(cursor, binId, filter))
      ) {
        return invalidCursor();
      }

      const conditions = [eq(manualRuns.binId, binId)];
      if (query.action !== undefined)
        conditions.push(eq(manualRuns.action, query.action));
      if (query.status !== undefined)
        conditions.push(eq(manualRuns.status, query.status));
      // 使用原始 ISO 字符串转换时区，避免 Date 模式截断筛选时间的微秒。
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
              lt(manualRuns.runId, cursor.before.runId),
            ),
          )!,
        );
      }

      const rows = await database
        .select({
          runId: manualRuns.runId,
          action: manualRuns.action,
          status: manualRuns.status,
          startedAt: manualRuns.startedAt,
          finishedAt: manualRuns.finishedAt,
          // 保留 PostgreSQL 微秒精度，避免游标边界退化为 JavaScript 毫秒。
          createdAt: sql<string>`to_char(${manualRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(manualRuns)
        .where(and(...conditions))
        .orderBy(desc(manualRuns.createdAt), desc(manualRuns.runId))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const runs = pageRows.map((row) =>
        manualRunListSummarySchema.parse({
          runId: row.runId,
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
              binId,
              filter,
              before: {
                createdAt: lastRow.createdAt,
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
