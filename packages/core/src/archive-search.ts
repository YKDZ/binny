import { createHash } from "node:crypto";

import {
  archiveSearchInputSchema,
  archiveSearchJsonProjectionResultSchema,
  archiveSearchPageSchema,
  archiveSearchPathExpansionPathSchema,
  archiveRelationStateSchema,
  archiveSnapshotSequenceSchema,
  postgresTextSchema,
  type ArchiveOperations,
  type ArchiveSearchFilter,
  type ArchiveSearchJsonProjection,
  type ArchiveSearchOperation,
  type ArchiveSearchPathStep,
  type ArchiveSearchRequest,
  type ArchiveSearchTargetFilter,
  type ArchiveSearchText,
} from "@binny/contracts";
import {
  archiveCommits,
  archiveItems,
  archiveObservations,
  archiveRelationObservationGaps,
  archiveRelationObservations,
  archiveRelationRevisions,
  archiveRelations,
  archiveRevisions,
  databaseErrorCode,
  type Database,
} from "@binny/db";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getColumns,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notExists,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { canonicalJson, isoTimestamp, optionalText } from "./archive-common.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import { resolveSnapshot, type ResolvedSnapshot } from "./archive-read.ts";
import {
  buildArchiveMatchedQuery,
  compileJsonFilter,
  searchJsonPathExpression,
  searchJsonValue,
  searchTextExpression,
} from "./archive-search-query.ts";

type SearchInput = ReturnType<typeof archiveSearchInputSchema.parse>;
type SearchResult = ReturnType<
  typeof archiveSearchPageSchema.parse
>["results"][number];
type SearchMatch = SearchResult["matches"][number];
type SearchExpansion = NonNullable<SearchMatch["expansions"]>[number];
type SearchExpansionRelation = SearchExpansion["relations"][number];

type SearchCursor = {
  readonly version: 1 | 2;
  readonly queryHash: string;
  readonly snapshot: ResolvedSnapshot;
  readonly resultId: string;
};

type SearchSort = SearchInput["orderBy"][number];
type SearchSortKind = "text" | "jsonb";

type SearchRegexPattern = {
  readonly pattern: string;
  readonly path: (string | number)[];
};

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeSearchCursor(cursor: string): SearchCursor | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) return undefined;
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return undefined;
    if (!("version" in value) || (value.version !== 1 && value.version !== 2)) {
      return undefined;
    }
    const version = value.version;
    if (!("queryHash" in value) || typeof value.queryHash !== "string") {
      return undefined;
    }
    if (!/^[a-f0-9]{64}$/u.test(value.queryHash)) return undefined;
    if (!("snapshot" in value) || typeof value.snapshot !== "object") {
      return undefined;
    }
    const snapshot = value.snapshot;
    if (snapshot === null || !("asOf" in snapshot) || !("mode" in snapshot)) {
      return undefined;
    }
    const checkedSequence = archiveSnapshotSequenceSchema.safeParse(
      snapshot.asOf,
    );
    if (
      !checkedSequence.success ||
      (snapshot.mode !== "current" && snapshot.mode !== "asOf")
    ) {
      return undefined;
    }
    if (version === 1) {
      if (!("sortValues" in value) || !Array.isArray(value.sortValues)) {
        return undefined;
      }
      if (
        value.sortValues.some(
          (entry) =>
            entry !== null && !postgresTextSchema.safeParse(entry).success,
        )
      ) {
        return undefined;
      }
    }
    if (!("resultId" in value) || typeof value.resultId !== "string") {
      return undefined;
    }
    if (
      value.resultId.length === 0 ||
      value.resultId.length > 128 ||
      !postgresTextSchema.safeParse(value.resultId).success
    ) {
      return undefined;
    }
    return {
      version,
      queryHash: value.queryHash,
      snapshot: {
        asOf: checkedSequence.data,
        mode: snapshot.mode,
      },
      resultId: value.resultId,
    };
  } catch {
    return undefined;
  }
}

export function searchRegexPatterns(input: {
  readonly text?: ArchiveSearchText | undefined;
  readonly where?: ArchiveSearchFilter | undefined;
  readonly expandPaths?:
    | readonly { readonly steps: readonly ArchiveSearchPathStep[] }[]
    | undefined;
}): SearchRegexPattern[] {
  const patterns: SearchRegexPattern[] =
    input.text?.kind === "regex"
      ? [{ pattern: input.text.pattern, path: ["text", "pattern"] }]
      : [];
  const visit = (
    filter: ArchiveSearchFilter,
    path: (string | number)[],
  ): void => {
    if (filter.type === "text") {
      if (filter.text.kind === "regex") {
        patterns.push({
          pattern: filter.text.pattern,
          path: [...path, "text", "pattern"],
        });
      }
      return;
    }
    if (filter.type === "not") {
      visit(filter.condition, [...path, "condition"]);
      return;
    }
    if (filter.type === "and" || filter.type === "or") {
      for (const [index, condition] of filter.conditions.entries()) {
        visit(condition, [...path, "conditions", index]);
      }
      return;
    }
    if (filter.type === "relation" && filter.target !== undefined) {
      visitTarget(filter.target, [...path, "target"]);
      return;
    }
    if (filter.type === "path") {
      for (const [index, step] of filter.steps.entries()) {
        if (step.target !== undefined) {
          visitTarget(step.target, [...path, "steps", index, "target"]);
        }
      }
    }
  };
  const visitTarget = (
    filter: ArchiveSearchTargetFilter,
    path: (string | number)[],
  ): void => {
    if (filter.type === "text") {
      if (filter.text.kind === "regex") {
        patterns.push({
          pattern: filter.text.pattern,
          path: [...path, "text", "pattern"],
        });
      }
      return;
    }
    if (filter.type === "not") {
      visitTarget(filter.condition, [...path, "condition"]);
      return;
    }
    if (filter.type === "and" || filter.type === "or") {
      for (const [index, condition] of filter.conditions.entries()) {
        visitTarget(condition, [...path, "conditions", index]);
      }
    }
  };
  if (input.where !== undefined) visit(input.where, ["where"]);
  for (const [index, expansion] of (input.expandPaths ?? []).entries()) {
    for (const [stepIndex, step] of expansion.steps.entries()) {
      if (step.target !== undefined) {
        visitTarget(step.target, [
          "expandPaths",
          index,
          "steps",
          stepIndex,
          "target",
        ]);
      }
    }
  }
  return patterns;
}

export async function invalidSearchRegexPath(
  transaction: ArchiveTransaction,
  patterns: readonly SearchRegexPattern[],
): Promise<(string | number)[] | undefined> {
  // PostgreSQL 2201B 只标识整条查询；savepoint 分别校验模式以定位字段。
  for (const { pattern, path } of patterns) {
    try {
      await transaction.transaction(async (savepoint) => {
        await savepoint.execute(sql`SELECT ''::text ~ ${pattern}::text`);
      });
    } catch (error) {
      if (databaseErrorCode(error) === "2201B") return path;
      throw error;
    }
  }
  return undefined;
}

async function readCurrentSearchPage(
  transaction: ArchiveTransaction,
  snapshot: ResolvedSnapshot,
  input: SearchInput,
  cursor: SearchCursor | undefined,
  queryHash: string,
): Promise<
  ArchiveSearchOperation<ReturnType<typeof archiveSearchPageSchema.parse>>
> {
  const matchedQuery = buildArchiveMatchedQuery(transaction, snapshot, input);
  const {
    asOf,
    resultUnit,
    latest,
    matched,
    rootFields,
    textConditions,
    compileText,
    buildPathRows,
  } = matchedQuery;
  const hitPosition = (
    text: ArchiveSearchText,
    stateData: SQLWrapper,
    edge: "start" | "end",
  ): SQL => {
    const searchText = searchTextExpression(stateData);
    if (text.kind === "literal") {
      const start = sql`strpos(${searchText}, ${text.value}) - 1`;
      return edge === "start"
        ? start.mapWith(Number).nullable()
        : sql`${start} + char_length(${text.value})`.mapWith(Number).nullable();
    }
    // RC 未声明 PostgreSQL ARE、regexp_instr 与字符位置函数；数据库端位置按 Unicode 码点计算。
    return edge === "start"
      ? sql`regexp_instr(${searchText}, ${text.pattern}, 1, 1, 0, 'c') - 1`
          .mapWith(Number)
          .nullable()
      : sql`regexp_instr(${searchText}, ${text.pattern}, 1, 1, 1, 'c') - 1`
          .mapWith(Number)
          .nullable();
  };
  // CASE 选取逻辑遍历中首个命中文本条件；RC 没有 CASE 构造器。
  const hitStart =
    textConditions.length === 0
      ? sql`NULL::integer`.mapWith(Number).nullable()
      : sql`CASE ${sql.join(
          textConditions.map(
            (text) =>
              sql`WHEN ${compileText(
                text,
                {
                  ...rootFields,
                  revision: { stateData: matched.stateData },
                },
                false,
              )} THEN ${hitPosition(text, matched.stateData, "start")}`,
          ),
          sql` `,
        )} ELSE NULL::integer END`
          .mapWith(Number)
          .nullable();
  const located = transaction.$with("located").as(
    transaction
      .select({
        ...getColumns(matched),
        hitStart: hitStart.as("hitStart"),
      })
      .from(matched),
  );
  const hitEnd =
    textConditions.length === 0
      ? sql`NULL::integer`.mapWith(Number).nullable()
      : sql`CASE ${sql.join(
          textConditions.map(
            (text) =>
              sql`WHEN ${compileText(
                text,
                {
                  ...rootFields,
                  revision: { stateData: located.stateData },
                },
                false,
              )} THEN ${hitPosition(text, located.stateData, "end")}`,
          ),
          sql` `,
        )} ELSE NULL::integer END`
          .mapWith(Number)
          .nullable();
  const bounded = transaction.$with("bounded").as(
    transaction
      .select({
        ...getColumns(located),
        hitEnd: hitEnd.as("hitEnd"),
      })
      .from(located),
  );
  // RC 未提供 greatest/least/substring 构造器；范围与上下文仍在数据库按码点计算。
  const contextual = transaction.$with("contextual").as(
    transaction
      .select({
        ...getColumns(bounded),
        contextStart: sql`greatest(0, ${bounded.hitStart} - 80)`
          .mapWith(Number)
          .nullable()
          .as("contextStart"),
        contextEnd:
          sql`least(char_length(${bounded.searchText}), ${bounded.hitEnd} + 80)`
            .mapWith(Number)
            .nullable()
            .as("contextEnd"),
      })
      .from(bounded),
  );

  const aggregateByView = (value: SQLWrapper): SQL =>
    // RC 未声明有序 array_agg；它只负责每个根排序列，分组与查询仍由构建器表达。
    sql`(array_agg(${value} ORDER BY ${contextual.binId} COLLATE "C", ${contextual.archiveSequence}, ${contextual.ordinal}, ${contextual.commitId}))[1]`;
  // JSON 类型分支、lpad 与 to_char 是排序列的 PostgreSQL 局部表达式，用于保留原排序语义。
  const selectSortExpression = (
    sort: SearchSort,
  ): { readonly expression: SQLWrapper; readonly kind: SearchSortKind } => {
    if (sort.field === "metadata" || sort.field === "properties") {
      if (sort.path === undefined || sort.valueType === undefined) {
        throw new Error("JSON 路径排序缺少路径或预期类型。");
      }
      const expression = searchJsonPathExpression(
        contextual.stateData,
        sort.field,
        sort.path,
      );
      const typedValue =
        sort.valueType === "number"
          ? sql`CASE WHEN jsonb_typeof(${expression}) = 'number' THEN ${expression} END`
          : sql`CASE WHEN jsonb_typeof(${expression}) = ${sort.valueType} THEN ${expression} #>> '{}'\n            END`;
      return {
        expression: aggregateByView(typedValue),
        kind: sort.valueType === "number" ? "jsonb" : "text",
      };
    }
    switch (sort.field) {
      case "itemId":
        return {
          expression: sql`${contextual.itemId}::text`,
          kind: "text",
        };
      case "sourceKey.namespace":
        return { expression: contextual.namespace, kind: "text" };
      case "sourceKey.key":
        return { expression: contextual.sourceKey, kind: "text" };
      case "sourceRef":
        return {
          expression: aggregateByView(contextual.sourceRef),
          kind: "text",
        };
      case "sourceModifiedAt":
        return {
          expression: aggregateByView(contextual.sourceModifiedAt),
          kind: "text",
        };
      case "capture.completeness":
        return {
          expression: aggregateByView(contextual.completeness),
          kind: "text",
        };
      case "binId":
        return {
          expression: aggregateByView(contextual.binId),
          kind: "text",
        };
      case "revisionId":
        return {
          expression: aggregateByView(sql`${contextual.revisionId}::text`),
          kind: "text",
        };
      case "archiveSeq":
        return {
          expression: aggregateByView(
            sql`lpad(${contextual.archiveSequence}::text, 19, '0')`,
          ),
          kind: "text",
        };
      case "runId":
        return {
          expression: aggregateByView(contextual.runId),
          kind: "text",
        };
      case "collectorVersion":
        return {
          expression: aggregateByView(contextual.collectorVersion),
          kind: "text",
        };
      case "observedAt":
        return {
          expression: aggregateByView(
            sql`to_char(${contextual.observedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          ),
          kind: "text",
        };
      case "recordedAt":
        return {
          expression: aggregateByView(
            sql`to_char(${contextual.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          ),
          kind: "text",
        };
    }
  };
  const sortExpressions = input.orderBy.map(selectSortExpression);
  // 未使用的排序槽显式给 text 空值类型，让嵌套 CTE 的固定选择保持可推导。
  const sortColumn = (index: number): SQL.Aliased =>
    sql`${sortExpressions[index]?.expression ?? sql`NULL::text`}`.as(
      `sort${index}`,
    );
  // 非对应搜索单位使用有类型的 NULL；历史单位的标识由原生 min 聚合保留。
  const rootRevisionId =
    resultUnit === "revision"
      ? min(sql`${contextual.revisionId}::text`)
      : sql`NULL::text`.mapWith(String).nullable();
  const rootCommitId =
    resultUnit === "observation"
      ? min(sql`${contextual.commitId}::text`)
      : sql`NULL::text`.mapWith(String).nullable();
  const rootOrdinal =
    resultUnit === "observation"
      ? min(contextual.ordinal)
      : sql`NULL::integer`.mapWith(Number).nullable();
  const roots = transaction.$with("roots").as(
    transaction
      .select({
        resultId: contextual.resultId,
        itemId: contextual.itemId,
        rootRevisionId: rootRevisionId.as("rootRevisionId"),
        rootCommitId: rootCommitId.as("rootCommitId"),
        rootOrdinal: rootOrdinal.as("rootOrdinal"),
        namespace: contextual.namespace,
        sourceKey: contextual.sourceKey,
        sort: {
          sort0: sortColumn(0),
          sort1: sortColumn(1),
          sort2: sortColumn(2),
          sort3: sortColumn(3),
          sort4: sortColumn(4),
        },
      })
      .from(contextual)
      .groupBy(
        contextual.resultId,
        contextual.itemId,
        contextual.namespace,
        contextual.sourceKey,
      ),
  );
  const rootSortValues: SQLWrapper[] = [
    roots.sort.sort0,
    roots.sort.sort1,
    roots.sort.sort2,
    roots.sort.sort3,
    roots.sort.sort4,
  ];
  const rootOrdering = (sortValues: readonly SQLWrapper[]): SQL[] =>
    input.orderBy.map((sort, index) => {
      const value = sortValues[index]!;
      const orderedValue =
        sortExpressions[index]?.kind === "text"
          ? sql`${value} COLLATE "C"`
          : value;
      // RC 的 SELECT 排序构造器没有 NULLS LAST；该后缀与方向一起用于每个根排序列。
      return sql`${sort.direction === "asc" ? asc(orderedValue) : desc(orderedValue)} NULLS LAST`;
    });
  const cursorRoot = transaction.$with("cursor_root").as(
    transaction
      .select()
      .from(roots)
      .where(
        cursor === undefined ? sql`FALSE` : eq(roots.resultId, cursor.resultId),
      ),
  );
  let cursorCondition: SQL | undefined;
  if (cursor !== undefined) {
    const cursorRows = await transaction
      .with(latest, matched, located, bounded, contextual, roots)
      .select({ resultId: roots.resultId })
      .from(roots)
      .where(eq(roots.resultId, cursor.resultId))
      .limit(1);
    if (cursorRows[0] === undefined) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "invalid_input",
          message: "搜索游标已失效，请重新查询。",
          path: ["cursor"],
        },
      };
    }
    const cursorSortValues: SQLWrapper[] = [
      cursorRoot.sort.sort0,
      cursorRoot.sort.sort1,
      cursorRoot.sort.sort2,
      cursorRoot.sort.sort3,
      cursorRoot.sort.sort4,
    ];
    const afterBranches: SQL[] = [];
    const equalPrefix: SQL[] = [];
    for (const [index, sort] of input.orderBy.entries()) {
      const rootValue = rootSortValues[index]!;
      const cursorValue = cursorSortValues[index]!;
      const rootComparison =
        sortExpressions[index]?.kind === "text"
          ? sql`${rootValue} COLLATE "C"`
          : rootValue;
      const cursorComparison =
        sortExpressions[index]?.kind === "text"
          ? sql`${cursorValue} COLLATE "C"`
          : cursorValue;
      const comparison =
        sort.direction === "asc"
          ? gt(rootComparison, cursorComparison)
          : lt(rootComparison, cursorComparison);
      afterBranches.push(
        and(
          ...equalPrefix,
          isNotNull(cursorValue),
          or(isNull(rootValue), and(isNotNull(rootValue), comparison)),
        )!,
      );
      // RC 没有 IS NOT DISTINCT FROM 条件构造；它保留 NULL 排序值的游标相等前缀。
      equalPrefix.push(
        sql`${rootComparison} IS NOT DISTINCT FROM ${cursorComparison}`,
      );
    }
    afterBranches.push(
      and(
        ...equalPrefix,
        sql`${roots.resultId} COLLATE "C" > ${cursorRoot.resultId} COLLATE "C"`,
      )!,
    );
    const afterCursor = or(...afterBranches)!;
    cursorCondition = exists(
      transaction
        .select({ present: sql`1` })
        .from(cursorRoot)
        .where(afterCursor),
    );
  }
  const limitedPage = transaction.$with("limited_page").as(
    transaction
      .select()
      .from(roots)
      .where(cursorCondition)
      .orderBy(
        ...rootOrdering(rootSortValues),
        asc(sql`${roots.resultId} COLLATE "C"`),
      )
      .limit(input.limit + 1),
  );

  const selectedFields = new Set(input.select);
  const jsonSelectors = input.select.filter(
    (selector): selector is ArchiveSearchJsonProjection =>
      typeof selector !== "string",
  );
  // RC 未声明 jsonb_build_array/object；只在最终投影列中构造契约 JSON。
  const jsonProjections =
    jsonSelectors.length === 0
      ? sql`'[]'::jsonb`
      : sql`jsonb_build_array(${sql.join(
          jsonSelectors.map((selector) => {
            const expression = searchJsonPathExpression(
              contextual.stateData,
              selector.field,
              selector.path,
            );
            const field = sql`${selector.field}::text`;
            const path = searchJsonValue(selector.path);
            return sql`CASE WHEN ${isNull(expression)} THEN jsonb_build_object('field', ${field}, 'path', ${path}, 'exists', false) ELSE jsonb_build_object('field', ${field}, 'path', ${path}, 'exists', true, 'value', ${expression}) END`;
          }),
          sql`, `,
        )})`;
  const pageOrdering = rootOrdering([
    limitedPage.sort.sort0,
    limitedPage.sort.sort1,
    limitedPage.sort.sort2,
    limitedPage.sort.sort3,
    limitedPage.sort.sort4,
  ]);
  const rows = await transaction
    .with(
      latest,
      matched,
      located,
      bounded,
      contextual,
      roots,
      cursorRoot,
      limitedPage,
    )
    .select({
      resultId: limitedPage.resultId,
      rootRevisionId: limitedPage.rootRevisionId,
      rootCommitId: limitedPage.rootCommitId,
      rootOrdinal: limitedPage.rootOrdinal,
      itemId: contextual.itemId,
      namespace: contextual.namespace,
      sourceKey: contextual.sourceKey,
      binId: contextual.binId,
      revisionId: contextual.revisionId,
      archiveSequence: contextual.archiveSequence,
      runId: contextual.runId,
      collectorVersion: contextual.collectorVersion,
      sourceRef: contextual.sourceRef,
      sourceModifiedAt: contextual.sourceModifiedAt,
      completeness: contextual.completeness,
      observedAt: contextual.observedAt,
      recordedAt: contextual.recordedAt,
      hitStart: contextual.hitStart,
      hitEnd: contextual.hitEnd,
      contextStart: contextual.contextStart,
      contextEnd: contextual.contextEnd,
      contextText:
        sql`substring(${contextual.searchText} FROM ${contextual.contextStart} + 1 FOR ${contextual.contextEnd} - ${contextual.contextStart})`
          .mapWith(String)
          .nullable(),
      jsonProjections,
    })
    .from(limitedPage)
    .innerJoin(contextual, eq(contextual.resultId, limitedPage.resultId))
    .orderBy(
      ...pageOrdering,
      // 与分页锚点使用相同的同值根顺序，避免 join 后按观察序号重排 Map。
      asc(sql`${limitedPage.resultId} COLLATE "C"`),
      asc(sql`${contextual.binId} COLLATE "C"`),
      asc(contextual.archiveSequence),
      asc(contextual.ordinal),
      asc(contextual.commitId),
    );

  const results = new Map<string, SearchResult>();
  for (const row of rows) {
    const match: SearchMatch = {
      binId: row.binId,
      revisionId: row.revisionId,
      archiveSeq: row.archiveSequence.toString(),
      ...(selectedFields.has("sourceModifiedAt") &&
      row.sourceModifiedAt !== null
        ? { sourceModifiedAt: row.sourceModifiedAt }
        : {}),
      ...(selectedFields.has("sourceRef") && row.sourceRef !== null
        ? { sourceRef: row.sourceRef }
        : {}),
      ...(selectedFields.has("capture.completeness") &&
      row.completeness !== null
        ? { completeness: row.completeness }
        : {}),
      ...(selectedFields.has("observedAt")
        ? { observedAt: isoTimestamp(row.observedAt) }
        : {}),
      ...(selectedFields.has("recordedAt")
        ? { recordedAt: isoTimestamp(row.recordedAt) }
        : {}),
      ...(selectedFields.has("runId") ? optionalText("runId", row.runId) : {}),
      ...(selectedFields.has("collectorVersion")
        ? optionalText("collectorVersion", row.collectorVersion)
        : {}),
      ...(row.hitStart === null || row.hitEnd === null
        ? {}
        : {
            hit: {
              field: "body.searchText" as const,
              representation: "searchText" as const,
              position: {
                encoding: "unicode-code-point" as const,
                start: row.hitStart,
                end: row.hitEnd,
              },
              ...(selectedFields.has("hit.context") &&
              row.contextStart !== null &&
              row.contextEnd !== null &&
              row.contextText !== null
                ? {
                    context: {
                      start: row.contextStart,
                      end: row.contextEnd,
                      text: row.contextText,
                    },
                  }
                : {}),
            },
          }),
      ...(jsonSelectors.length === 0
        ? {}
        : {
            json: archiveSearchJsonProjectionResultSchema
              .array()
              .parse(row.jsonProjections),
          }),
    };
    const result = results.get(row.resultId);
    if (result === undefined) {
      const created: SearchResult = {
        resultId: row.resultId,
        itemId: row.itemId,
        ...(selectedFields.has("sourceKey")
          ? { sourceKey: { namespace: row.namespace, key: row.sourceKey } }
          : {}),
        ...(row.rootRevisionId === null
          ? {}
          : { revisionId: row.rootRevisionId }),
        ...(row.rootCommitId === null
          ? {}
          : {
              commitId: row.rootCommitId,
              ordinal: row.rootOrdinal ?? 0,
            }),
        matches: [match],
      };
      results.set(row.resultId, created);
    } else {
      result.matches.push(match);
    }
  }
  const orderedResults = [...results.values()];
  const hasMore = orderedResults.length > input.limit;
  const pageResults = orderedResults.slice(0, input.limit);
  const expansions = input.expand ?? [];
  const pathExpansions = input.expandPaths ?? [];
  if (expansions.length > 0) {
    for (const result of pageResults) {
      for (const match of result.matches) {
        match.expansions = expansions.map(({ key, direction, name }) => ({
          key,
          direction,
          ...(name === undefined ? {} : { name }),
          relations: [],
          hasMore: false,
        }));
      }
    }
  }
  if (pathExpansions.length > 0) {
    for (const result of pageResults) {
      for (const match of result.matches) {
        match.pathExpansions = pathExpansions.map(({ key }) => ({
          key,
          paths: [],
          hasMore: false,
        }));
      }
    }
  }
  if (expansions.length > 0) {
    const views = pageResults.flatMap((result) =>
      result.matches.map((match) => ({
        result_id: result.resultId,
        item_id: result.itemId,
        bin_id: match.binId,
      })),
    );
    if (views.length > 0) {
      const keyForView = (resultId: string, binId: string): string =>
        JSON.stringify([resultId, binId]);
      const decodeDirection = (value: unknown): "outgoing" | "incoming" => {
        if (value === "outgoing" || value === "incoming") return value;
        throw new Error("关系展开返回未知方向。");
      };
      const decodeStatus = (
        value: unknown,
      ): "observed" | "withdrawn" | "deleted" => {
        if (
          value === "observed" ||
          value === "withdrawn" ||
          value === "deleted"
        ) {
          return value;
        }
        throw new Error("关系展开返回未知状态。");
      };
      for (const selector of expansions) {
        // RC 没有 JSON 记录集的表值函数类型；此处仅声明页内有界输入列，再立即生成类型化 CTE。
        const requestRows = sql`jsonb_to_recordset(${searchJsonValue(views)}) AS request(result_id text, item_id uuid, bin_id text)`;
        const viewsCte = transaction.$with("views").as(
          transaction
            .selectDistinct({
              resultId: sql`request.result_id`.mapWith(String).as("resultId"),
              itemId: sql`request.item_id`.mapWith(String).as("itemId"),
              binId: sql`request.bin_id`.mapWith(String).as("binId"),
            })
            .from(requestRows),
        );
        const gap = alias(archiveRelationObservationGaps, "expanded_gap");
        const gapCommit = alias(archiveCommits, "expanded_gap_commit");
        const laterObservation = alias(
          archiveRelationObservations,
          "expanded_later_observation",
        );
        const gapEndpoint =
          selector.direction === "outgoing"
            ? eq(gap.fromItemId, viewsCte.itemId)
            : selector.direction === "incoming"
              ? eq(gap.targetItemId, viewsCte.itemId)
              : or(
                  eq(gap.fromItemId, viewsCte.itemId),
                  eq(gap.targetItemId, viewsCte.itemId),
                );
        const laterObservationExists = notExists(
          transaction
            .select({ present: sql`1` })
            .from(laterObservation)
            .where(
              and(
                eq(laterObservation.relationId, gap.relationId),
                eq(laterObservation.binId, viewsCte.binId),
                gt(laterObservation.archiveSequence, gapCommit.archiveSequence),
                lte(laterObservation.archiveSequence, asOf),
              ),
            ),
        );
        // RC 没有 CASE 构造器；方向由当前 match 与 gap 的声明端点决定。
        const latestGaps = transaction.$with("latest_gaps").as(
          transaction
            .selectDistinctOn(
              [viewsCte.resultId, viewsCte.binId, gap.relationId],
              {
                resultId: viewsCte.resultId,
                binId: viewsCte.binId,
                relationId: gap.relationId,
                direction:
                  sql`CASE WHEN ${gap.fromItemId} = ${viewsCte.itemId} THEN 'outgoing' ELSE 'incoming' END`
                    .mapWith(decodeDirection)
                    .as("direction"),
                fromItemId: gap.fromItemId,
                targetItemId: gap.targetItemId,
                commitId: gapCommit.commitId,
                archiveSequence: gapCommit.archiveSequence,
                ordinal: gap.ordinal,
                observedAt: gapCommit.observedAt,
                recordedAt: gapCommit.recordedAt,
                runId: gapCommit.runId,
                collectorVersion: gapCommit.collectorVersion,
              },
            )
            .from(viewsCte)
            .innerJoin(gap, gapEndpoint!)
            .innerJoin(
              gapCommit,
              and(
                eq(gapCommit.commitId, gap.commitId),
                eq(gapCommit.binId, viewsCte.binId),
              ),
            )
            .where(
              and(lte(gapCommit.archiveSequence, asOf), laterObservationExists),
            )
            .orderBy(
              asc(viewsCte.resultId),
              asc(viewsCte.binId),
              asc(gap.relationId),
              desc(gapCommit.archiveSequence),
              desc(gap.ordinal),
              desc(gap.commitId),
            ),
        );

        const relation = alias(archiveRelations, "expanded_relation");
        const relationObservation = alias(
          archiveRelationObservations,
          "expanded_relation_observation",
        );
        const relationCommit = alias(
          archiveCommits,
          "expanded_relation_commit",
        );
        const relationRevision = alias(
          archiveRelationRevisions,
          "expanded_relation_revision",
        );
        const relationLatest = transaction
          .select({
            relationRevisionId: relationObservation.relationRevisionId,
            commitId: relationObservation.commitId,
            archiveSequence: relationObservation.archiveSequence,
            ordinal: relationObservation.ordinal,
            observedAt: relationCommit.observedAt,
            recordedAt: relationCommit.recordedAt,
            runId: relationCommit.runId,
            collectorVersion: relationCommit.collectorVersion,
          })
          .from(relationObservation)
          .innerJoin(
            relationCommit,
            eq(relationCommit.commitId, relationObservation.commitId),
          )
          .where(
            and(
              eq(relationObservation.relationId, relation.relationId),
              eq(relationObservation.binId, viewsCte.binId),
              lte(relationObservation.archiveSequence, asOf),
            ),
          )
          .orderBy(
            desc(relationObservation.archiveSequence),
            desc(relationObservation.ordinal),
            desc(relationObservation.commitId),
          )
          .limit(1)
          .as("expanded_relation_latest");
        const relationEndpoint =
          selector.direction === "outgoing"
            ? eq(relation.fromItemId, viewsCte.itemId)
            : selector.direction === "incoming"
              ? eq(relation.targetItemId, viewsCte.itemId)
              : or(
                  eq(relation.fromItemId, viewsCte.itemId),
                  eq(relation.targetItemId, viewsCte.itemId),
                );
        const noLaterGap = notExists(
          transaction
            .select({ present: sql`1` })
            .from(latestGaps)
            .where(
              and(
                eq(latestGaps.resultId, viewsCte.resultId),
                eq(latestGaps.binId, viewsCte.binId),
                eq(latestGaps.relationId, relation.relationId),
              ),
            ),
        );
        const relationStateConditions: SQL[] = [];
        if (selector.name !== undefined) {
          // RC 未提供 JSON ->> 与 COLLATE 表达式；关系名仍以 C 序比较。
          relationStateConditions.push(
            sql`${relationRevision.stateData}->>'name' COLLATE "C" = ${selector.name}::text COLLATE "C"`,
          );
        }
        if (selector.properties !== undefined) {
          relationStateConditions.push(
            compileJsonFilter(selector.properties, relationRevision.stateData),
          );
        }
        const activeRelations = transaction.$with("active_relations").as(
          transaction
            .select({
              resultId: viewsCte.resultId,
              binId: viewsCte.binId,
              relationId: relation.relationId,
              // CASE 将 match 的逻辑端点映射为展示方向和关系状态；RC 没有 CASE 构造器。
              direction:
                sql`CASE WHEN ${relation.fromItemId} = ${viewsCte.itemId} THEN 'outgoing' ELSE 'incoming' END`
                  .mapWith(decodeDirection)
                  .as("direction"),
              status:
                sql`CASE WHEN ${relationLatest.relationRevisionId} IS NULL THEN 'withdrawn' ELSE 'observed' END`
                  .mapWith(decodeStatus)
                  .as("status"),
              fromItemId: relation.fromItemId,
              targetItemId: relation.targetItemId,
              targetSourceRef: relation.targetSourceRef,
              relationRevisionId: relationLatest.relationRevisionId,
              stateData: relationRevision.stateData,
              commitId: relationLatest.commitId,
              archiveSequence: relationLatest.archiveSequence,
              ordinal: relationLatest.ordinal,
              observedAt: relationLatest.observedAt,
              recordedAt: relationLatest.recordedAt,
              runId: relationLatest.runId,
              collectorVersion: relationLatest.collectorVersion,
            })
            .from(viewsCte)
            .innerJoin(relation, relationEndpoint!)
            .innerJoinLateral(relationLatest, sql`true`)
            .leftJoin(
              relationRevision,
              and(
                eq(relationRevision.relationId, relation.relationId),
                eq(
                  relationRevision.relationRevisionId,
                  relationLatest.relationRevisionId,
                ),
              ),
            )
            .where(
              and(
                lte(relation.createdSequence, asOf),
                noLaterGap,
                ...(relationStateConditions.length === 0
                  ? []
                  : [
                      isNotNull(relationLatest.relationRevisionId),
                      ...relationStateConditions,
                    ]),
              ),
            ),
        );
        const activeCandidates = transaction
          .select({
            resultId: activeRelations.resultId,
            binId: activeRelations.binId,
            relationId: activeRelations.relationId,
            direction: activeRelations.direction,
            status: activeRelations.status,
            fromItemId: sql`${activeRelations.fromItemId}`
              .mapWith(String)
              .nullable()
              .as("fromItemId"),
            targetItemId: activeRelations.targetItemId,
            targetSourceRef: activeRelations.targetSourceRef,
            relationRevisionId: activeRelations.relationRevisionId,
            stateData: activeRelations.stateData,
            commitId: activeRelations.commitId,
            archiveSequence: activeRelations.archiveSequence,
            ordinal: activeRelations.ordinal,
            observedAt: activeRelations.observedAt,
            recordedAt: activeRelations.recordedAt,
            runId: activeRelations.runId,
            collectorVersion: activeRelations.collectorVersion,
          })
          .from(activeRelations);
        const includeGaps =
          selector.name === undefined && selector.properties === undefined;
        // UNION 两侧以显式 PG 类型对齐已删除关系的空端点和状态列。
        const candidateRows = includeGaps
          ? activeCandidates.unionAll(
              transaction
                .select({
                  resultId: latestGaps.resultId,
                  binId: latestGaps.binId,
                  relationId: latestGaps.relationId,
                  direction: latestGaps.direction,
                  status: sql`'deleted'::text`
                    .mapWith(decodeStatus)
                    .as("status"),
                  fromItemId: sql`NULL::uuid`
                    .mapWith(String)
                    .nullable()
                    .as("fromItemId"),
                  targetItemId: sql`NULL::uuid`
                    .mapWith(String)
                    .nullable()
                    .as("targetItemId"),
                  targetSourceRef: sql`NULL::text`
                    .mapWith(String)
                    .nullable()
                    .as("targetSourceRef"),
                  relationRevisionId: sql`NULL::uuid`
                    .mapWith(String)
                    .nullable()
                    .as("relationRevisionId"),
                  stateData: sql`NULL::jsonb`.nullable().as("stateData"),
                  commitId: latestGaps.commitId,
                  archiveSequence: latestGaps.archiveSequence,
                  ordinal: latestGaps.ordinal,
                  observedAt: latestGaps.observedAt,
                  recordedAt: latestGaps.recordedAt,
                  runId: latestGaps.runId,
                  collectorVersion: latestGaps.collectorVersion,
                })
                .from(latestGaps),
            )
          : activeCandidates;
        const candidates = transaction.$with("candidates").as(candidateRows);
        // RC 未声明窗口 row_number；窗口只负责每个返回视图内的展开上限。
        const ranked = transaction.$with("ranked").as(
          transaction
            .select({
              ...getColumns(candidates),
              expansionRank:
                sql`row_number() OVER (PARTITION BY ${candidates.resultId}, ${candidates.binId} ORDER BY ${candidates.relationId} COLLATE "C", ${candidates.direction})`
                  .mapWith(Number)
                  .as("expansionRank"),
            })
            .from(candidates),
        );
        const limited = transaction.$with("limited").as(
          transaction
            .select()
            .from(ranked)
            .where(lte(ranked.expansionRank, selector.limit + 1)),
        );

        const fromItem = alias(archiveItems, "expanded_from_item");
        const fromObservation = alias(
          archiveObservations,
          "expanded_from_observation",
        );
        const fromCommit = alias(archiveCommits, "expanded_from_commit");
        const fromLatest = transaction
          .select({ revisionId: fromObservation.revisionId })
          .from(fromObservation)
          .innerJoin(
            fromCommit,
            eq(fromCommit.commitId, fromObservation.commitId),
          )
          .where(
            and(
              eq(fromObservation.itemId, limited.fromItemId),
              eq(fromCommit.binId, limited.binId),
              lte(fromCommit.archiveSequence, asOf),
            ),
          )
          .orderBy(
            desc(fromCommit.archiveSequence),
            desc(fromObservation.ordinal),
            desc(fromCommit.commitId),
          )
          .limit(1)
          .as("expanded_from_latest");
        const targetItem = alias(archiveItems, "expanded_target_item");
        const targetObservation = alias(
          archiveObservations,
          "expanded_target_observation",
        );
        const targetCommit = alias(archiveCommits, "expanded_target_commit");
        const targetLatest = transaction
          .select({ revisionId: targetObservation.revisionId })
          .from(targetObservation)
          .innerJoin(
            targetCommit,
            eq(targetCommit.commitId, targetObservation.commitId),
          )
          .where(
            and(
              eq(targetObservation.itemId, limited.targetItemId),
              eq(targetCommit.binId, limited.binId),
              lte(targetCommit.archiveSequence, asOf),
            ),
          )
          .orderBy(
            desc(targetCommit.archiveSequence),
            desc(targetObservation.ordinal),
            desc(targetCommit.commitId),
          )
          .limit(1)
          .as("expanded_target_latest");
        const rows = await transaction
          .with(
            viewsCte,
            latestGaps,
            activeRelations,
            candidates,
            ranked,
            limited,
          )
          .select({
            resultId: limited.resultId,
            binId: limited.binId,
            relationId: limited.relationId,
            direction: limited.direction,
            status: limited.status,
            fromItemId: limited.fromItemId,
            fromNamespace: fromItem.namespace,
            fromSourceKey: fromItem.sourceKey,
            fromRevisionId: fromLatest.revisionId,
            targetItemId: limited.targetItemId,
            targetSourceRef: limited.targetSourceRef,
            targetNamespace: targetItem.namespace,
            targetSourceKey: targetItem.sourceKey,
            targetRevisionId: targetLatest.revisionId,
            relationRevisionId: limited.relationRevisionId,
            stateData: limited.stateData,
            relationCommitId: limited.commitId,
            relationArchiveSequence: limited.archiveSequence,
            relationOrdinal: limited.ordinal,
            relationObservedAt: limited.observedAt,
            relationRecordedAt: limited.recordedAt,
            relationRunId: limited.runId,
            relationCollectorVersion: limited.collectorVersion,
          })
          .from(limited)
          .leftJoin(fromItem, eq(fromItem.itemId, limited.fromItemId))
          .leftJoinLateral(fromLatest, sql`true`)
          .leftJoin(targetItem, eq(targetItem.itemId, limited.targetItemId))
          .leftJoinLateral(targetLatest, sql`true`)
          .orderBy(
            asc(sql`${limited.resultId} COLLATE "C"`),
            asc(sql`${limited.binId} COLLATE "C"`),
            asc(limited.expansionRank),
          );
        const rowsByView = new Map<string, (typeof rows)[number][]>();
        for (const row of rows) {
          const key = keyForView(row.resultId, row.binId);
          const groupedRows = rowsByView.get(key);
          if (groupedRows === undefined) rowsByView.set(key, [row]);
          else groupedRows.push(row);
        }
        const relationForRow = (
          row: (typeof rows)[number],
        ): SearchExpansionRelation => {
          const observation = {
            commitId: row.relationCommitId,
            archiveSeq: row.relationArchiveSequence.toString(),
            ordinal: row.relationOrdinal,
            observedAt: isoTimestamp(row.relationObservedAt),
            recordedAt: isoTimestamp(row.relationRecordedAt),
            ...optionalText("runId", row.relationRunId),
            ...optionalText("collectorVersion", row.relationCollectorVersion),
          };
          if (row.status === "deleted") {
            return {
              relationId: row.relationId,
              direction: row.direction,
              status: row.status,
              observation,
            };
          }
          if (
            row.fromItemId === null ||
            row.fromNamespace === null ||
            row.fromSourceKey === null
          ) {
            throw new Error("关系展开缺少来源端点。");
          }
          const from = {
            kind: "item" as const,
            itemId: row.fromItemId,
            sourceKey: {
              namespace: row.fromNamespace,
              key: row.fromSourceKey,
            },
            status:
              row.fromRevisionId === null
                ? ("unknown" as const)
                : ("observed" as const),
            ...(row.fromRevisionId === null
              ? {}
              : { revisionId: row.fromRevisionId }),
          };
          let to:
            | {
                readonly kind: "sourceRef";
                readonly sourceRef: string;
              }
            | {
                readonly kind: "item";
                readonly itemId: string;
                readonly sourceKey: {
                  readonly namespace: string;
                  readonly key: string;
                };
                readonly status: "unknown" | "observed";
                readonly revisionId?: string;
              };
          if (row.targetItemId === null) {
            if (row.targetSourceRef === null) {
              throw new Error("关系展开缺少目标源引用。");
            }
            to = {
              kind: "sourceRef",
              sourceRef: row.targetSourceRef,
            };
          } else {
            if (row.targetNamespace === null || row.targetSourceKey === null) {
              throw new Error("关系展开缺少目标端点。");
            }
            to = {
              kind: "item",
              itemId: row.targetItemId,
              sourceKey: {
                namespace: row.targetNamespace,
                key: row.targetSourceKey,
              },
              status: row.targetRevisionId === null ? "unknown" : "observed",
              ...(row.targetRevisionId === null
                ? {}
                : { revisionId: row.targetRevisionId }),
            };
          }
          if (row.status === "withdrawn") {
            return {
              relationId: row.relationId,
              direction: row.direction,
              status: row.status,
              from,
              to,
              observation,
            };
          }
          if (row.relationRevisionId === null) {
            throw new Error("已观察关系缺少不可变关系版本。");
          }
          return {
            relationId: row.relationId,
            direction: row.direction,
            status: row.status,
            from,
            to,
            revisionId: row.relationRevisionId,
            state: archiveRelationStateSchema.parse(row.stateData),
            observation,
          };
        };
        for (const result of pageResults) {
          for (const match of result.matches) {
            const groupedRows =
              rowsByView.get(keyForView(result.resultId, match.binId)) ?? [];
            const expansion = match.expansions?.find(
              ({ key }) => key === selector.key,
            );
            if (expansion === undefined) {
              throw new Error("关系展开结果缺少对应选择器。");
            }
            expansion.relations = groupedRows
              .slice(0, selector.limit)
              .map(relationForRow);
            expansion.hasMore = groupedRows.length > selector.limit;
          }
        }
      }
    }
  }

  if (pathExpansions.length > 0) {
    const views = pageResults.flatMap((result) =>
      result.matches.map((match) => ({
        result_id: result.resultId,
        item_id: result.itemId,
        bin_id: match.binId,
      })),
    );
    if (views.length > 0) {
      const keyForView = (resultId: string, binId: string): string =>
        JSON.stringify([resultId, binId]);
      for (const [selectorIndex, selector] of pathExpansions.entries()) {
        // 页内根视图是唯一输入；每个选择器的有限路径在独立受限语句中展开。
        const requestRows = sql`jsonb_to_recordset(${searchJsonValue(views)}) AS request(result_id text, item_id uuid, bin_id text)`;
        const viewsCte = transaction.$with("path_views").as(
          transaction
            .selectDistinct({
              resultId: sql`request.result_id`.mapWith(String).as("resultId"),
              itemId: sql`request.item_id`.mapWith(String).as("itemId"),
              binId: sql`request.bin_id`.mapWith(String).as("binId"),
            })
            .from(requestRows),
        );
        const pathRows = buildPathRows(
          selector.steps,
          viewsCte.itemId,
          viewsCte.binId,
          true,
          {
            source: viewsCte,
            resultId: viewsCte.resultId,
            itemId: viewsCte.itemId,
            binId: viewsCte.binId,
          },
        );
        // 数组下标明确转为整数，逐步比较原始文本可避开 JSON 转义导致的错序。
        const pathOrderBy = sql.join(
          selector.steps.flatMap((_, stepIndex) => [
            sql`(${pathRows.pathData}->${stepIndex}::integer->>'relationId') COLLATE "C"`,
            sql`(${pathRows.pathData}->${stepIndex}::integer->>'direction') COLLATE "C"`,
          ]),
          sql`, `,
        );
        const ranked = transaction
          .$with(`path_ranked_${selectorIndex.toString(10)}`)
          .as(
            transaction
              .select({
                resultId: sql`${pathRows.resultId}`
                  .mapWith(String)
                  .as("resultId"),
                binId: sql`${pathRows.binId}`.mapWith(String).as("binId"),
                pathData: sql`${pathRows.pathData}`
                  .mapWith(archiveRevisions.stateData)
                  .as("pathData"),
                pathRank: sql`row_number() OVER (
                  PARTITION BY ${pathRows.resultId}, ${pathRows.binId}
                  ORDER BY ${pathOrderBy}
                )`
                  .mapWith(Number)
                  .as("pathRank"),
              })
              .from(pathRows.finalPath),
          );
        const limited = transaction
          .$with(`path_limited_${selectorIndex.toString(10)}`)
          .as(
            transaction
              .select()
              .from(ranked)
              .where(lte(ranked.pathRank, selector.limit + 1)),
          );
        const rows = await transaction
          .with(viewsCte, ...pathRows.ctes, ranked, limited)
          .select({
            resultId: limited.resultId,
            binId: limited.binId,
            pathData: limited.pathData,
          })
          .from(limited)
          .orderBy(
            asc(sql`${limited.resultId} COLLATE "C"`),
            asc(sql`${limited.binId} COLLATE "C"`),
            asc(limited.pathRank),
          );
        const rowsByView = new Map<string, (typeof rows)[number][]>();
        for (const row of rows) {
          const key = keyForView(row.resultId, row.binId);
          const groupedRows = rowsByView.get(key);
          if (groupedRows === undefined) rowsByView.set(key, [row]);
          else groupedRows.push(row);
        }
        for (const result of pageResults) {
          for (const match of result.matches) {
            const groupedRows =
              rowsByView.get(keyForView(result.resultId, match.binId)) ?? [];
            const expansion = match.pathExpansions?.find(
              ({ key }) => key === selector.key,
            );
            if (expansion === undefined) {
              throw new Error("路径展开结果缺少对应选择器。");
            }
            expansion.paths = groupedRows
              .slice(0, selector.limit)
              .map(({ pathData }) =>
                archiveSearchPathExpansionPathSchema.parse({
                  steps: pathData,
                }),
              );
            expansion.hasMore = groupedRows.length > selector.limit;
          }
        }
      }
    }
  }

  const last = pageResults.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeSearchCursor({
          version: 2,
          queryHash,
          snapshot,
          resultId: last.resultId,
        })
      : undefined;
  return {
    ok: true,
    value: archiveSearchPageSchema.parse({
      unit: resultUnit,
      snapshot,
      results: pageResults,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
  };
}

export function createArchiveSearchOperation(
  database: Database,
): Pick<ArchiveOperations, "searchArchive"> {
  return {
    async searchArchive(
      input: ArchiveSearchRequest,
    ): Promise<
      ArchiveSearchOperation<ReturnType<typeof archiveSearchPageSchema.parse>>
    > {
      const checked = archiveSearchInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return {
          ok: false,
          status: 400,
          error: {
            code: "invalid_input",
            message: issue?.message ?? "归档搜索请求格式无效。",
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
      const { cursor: requestedCursor, ...queryInput } = checked.data;
      const queryHash = createHash("sha256")
        .update(canonicalJson(queryInput))
        .digest("hex");
      const decodedCursor =
        requestedCursor === undefined
          ? undefined
          : decodeSearchCursor(requestedCursor);
      const requestedAsOf =
        "asOf" in checked.data.scope ? checked.data.scope.asOf : undefined;
      const expectedMode = requestedAsOf === undefined ? "current" : "asOf";
      const regexPatterns = searchRegexPatterns(checked.data);
      if (
        requestedCursor !== undefined &&
        (decodedCursor === undefined ||
          decodedCursor.queryHash !== queryHash ||
          decodedCursor.snapshot.mode !== expectedMode ||
          (requestedAsOf !== undefined &&
            decodedCursor.snapshot.asOf !== requestedAsOf))
      ) {
        return {
          ok: false,
          status: 400,
          error: {
            code: "invalid_input",
            message: "搜索游标无效，或不属于当前查询。",
            path: ["cursor"],
          },
        };
      }
      try {
        return await database.transaction(
          async (transaction) => {
            // statement_timeout 是 PostgreSQL 局部会话函数，保证搜索和展开语句采用同一预算。
            await transaction.execute(
              sql`SELECT set_config('statement_timeout', ${String(checked.data.budgetMs) + "ms"}, true)`,
            );
            const snapshot = await resolveSnapshot(
              transaction,
              decodedCursor?.snapshot.asOf ?? requestedAsOf,
            );
            if (!snapshot.ok) {
              return {
                ok: false,
                status: 400,
                error: snapshot.error,
              };
            }
            const fixedSnapshot: ResolvedSnapshot =
              decodedCursor === undefined
                ? snapshot.value
                : { ...snapshot.value, mode: decodedCursor.snapshot.mode };
            const regexPath =
              regexPatterns.length > 1
                ? await invalidSearchRegexPath(transaction, regexPatterns)
                : undefined;
            if (regexPath !== undefined) {
              return {
                ok: false,
                status: 400,
                error: {
                  code: "invalid_input",
                  message: "PostgreSQL ARE 正则表达式无效。",
                  path: regexPath,
                },
              };
            }
            return readCurrentSearchPage(
              transaction,
              fixedSnapshot,
              checked.data,
              decodedCursor,
              queryHash,
            );
          },
          {
            isolationLevel: "repeatable read",
            accessMode: "read only",
          },
        );
      } catch (error) {
        if (databaseErrorCode(error) === "57014") {
          return {
            ok: false,
            status: 422,
            error: {
              code: "query_budget_exceeded",
              message: "搜索超过请求预算，未返回部分结果。",
            },
          };
        }
        const regexPath =
          databaseErrorCode(error) === "2201B" && regexPatterns.length === 1
            ? regexPatterns[0]?.path
            : undefined;
        if (regexPath !== undefined) {
          return {
            ok: false,
            status: 400,
            error: {
              code: "invalid_input",
              message: "PostgreSQL ARE 正则表达式无效。",
              path: regexPath,
            },
          };
        }
        throw error;
      }
    },
  };
}
