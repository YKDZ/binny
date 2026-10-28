import { createHash } from "node:crypto";

import {
  archiveSearchInputSchema,
  archiveSearchJsonProjectionResultSchema,
  archiveSearchPageSchema,
  archiveRelationStateSchema,
  archiveSnapshotSequenceSchema,
  postgresTextSchema,
  type ArchiveOperations,
  type ArchiveSearchField,
  type ArchiveSearchFilter,
  type ArchiveSearchJsonFilter,
  type ArchiveSearchJsonProjection,
  type ArchiveSearchOperation,
  type ArchiveSearchRelationFilter,
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
  countDistinct,
  desc,
  eq,
  exists,
  getColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  ne,
  not,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { canonicalJson, isoTimestamp, optionalText } from "./archive-common.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import { resolveSnapshot, type ResolvedSnapshot } from "./archive-read.ts";

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

type SearchFields = {
  readonly item: {
    readonly itemId: SQLWrapper;
    readonly namespace: SQLWrapper;
    readonly sourceKey: SQLWrapper;
  };
  readonly revision: {
    readonly stateData: SQLWrapper;
  };
  readonly latest: {
    readonly binId: SQLWrapper;
    readonly runId: SQLWrapper;
    readonly collectorVersion: SQLWrapper;
    readonly observedAt: SQLWrapper;
    readonly recordedAt: SQLWrapper;
  };
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

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function searchTextExpression(stateData: SQLWrapper): SQL {
  // RC 没有 jsonb 的 ->/->> 类型化运算符；状态仍由 schema 列引用。
  return sql`${stateData}->'body'->>'searchText'`;
}

function searchJsonPathExpression(
  stateData: SQLWrapper,
  field: ArchiveSearchJsonProjection["field"],
  path: readonly (string | number)[],
): SQL {
  // RC 没有 JSON 路径运算符；每段键保持参数化，数字段按 PostgreSQL 数组下标处理。
  let expression = sql`(${stateData}->${field})`;
  for (const segment of path) {
    const cast = typeof segment === "number" ? sql`integer` : sql`text`;
    expression = sql`(${expression}->${String(segment)}::${cast})`;
  }
  return expression;
}

function searchJsonValue(value: unknown): SQL {
  // RC 不编码 jsonb 标量；包入对象后绑定原生 Jsonb Param，再解包保留 null、布尔和数组。
  return sql`(${sql.param({ value }, archiveRevisions.stateData)}::jsonb -> 'value')`;
}

function decodeCaptureCompleteness(value: unknown): "complete" | "partial" {
  if (value === "complete" || value === "partial") return value;
  throw new Error("归档状态包含无效的完整性标记。");
}

function searchFieldExpression(
  field: ArchiveSearchField,
  fields: SearchFields,
): { readonly expression: SQLWrapper; readonly kind: "text" | "timestamp" } {
  // JSON 提取与文本 collation 在 RC 中没有原生表达式；基础表和字段仍使用 schema 引用。
  switch (field) {
    case "sourceKey.namespace":
      return { expression: fields.item.namespace, kind: "text" };
    case "sourceKey.key":
      return { expression: fields.item.sourceKey, kind: "text" };
    case "sourceRef":
      return {
        expression: sql`${fields.revision.stateData}->>'sourceRef'`,
        kind: "text",
      };
    case "sourceModifiedAt":
      return {
        expression: sql`(${fields.revision.stateData}->>'sourceModifiedAt')::timestamptz`,
        kind: "timestamp",
      };
    case "capture.completeness":
      return {
        expression: sql`${fields.revision.stateData}->'capture'->>'completeness'`,
        kind: "text",
      };
    case "body.searchText":
      return {
        expression: searchTextExpression(fields.revision.stateData),
        kind: "text",
      };
    case "binId":
      return { expression: fields.latest.binId, kind: "text" };
    case "runId":
      return { expression: fields.latest.runId, kind: "text" };
    case "collectorVersion":
      return { expression: fields.latest.collectorVersion, kind: "text" };
    case "observedAt":
      return { expression: fields.latest.observedAt, kind: "timestamp" };
    case "recordedAt":
      return { expression: fields.latest.recordedAt, kind: "timestamp" };
  }
}

function compileJsonFilter(
  filter: ArchiveSearchJsonFilter,
  stateData: SQLWrapper,
): SQL {
  const expression = searchJsonPathExpression(
    stateData,
    filter.field,
    filter.path,
  );
  if (filter.operator === "exists") {
    return filter.value === true ? isNotNull(expression) : isNull(expression);
  }
  if (filter.valueType === undefined) {
    throw new Error("JSON 路径比较缺少预期类型。");
  }

  // RC 未声明 jsonb_typeof 与 COLLATE；二者只构成局部类型判别和 C 序比较。
  const matchesType = eq(sql`jsonb_typeof(${expression})`, filter.valueType);
  const comparedExpression =
    filter.valueType === "string"
      ? sql`(${expression} #>> '{}') COLLATE "C"`
      : expression;
  const parameter = (value: unknown): SQL =>
    filter.valueType === "string"
      ? sql`${String(value)}::text COLLATE "C"`
      : searchJsonValue(value);
  let comparison: SQL;
  if (filter.operator === "in" || filter.operator === "notIn") {
    const values = (filter.values ?? []).map(parameter);
    comparison =
      filter.operator === "in"
        ? inArray(comparedExpression, values)
        : notInArray(comparedExpression, values);
  } else if (filter.operator === "between") {
    comparison = and(
      gte(comparedExpression, parameter(filter.lower)),
      lte(comparedExpression, parameter(filter.upper)),
    )!;
  } else {
    const value = parameter(filter.value);
    switch (filter.operator) {
      case "eq":
        comparison = eq(comparedExpression, value);
        break;
      case "ne":
        comparison = ne(comparedExpression, value);
        break;
      case "gt":
        comparison = gt(comparedExpression, value);
        break;
      case "gte":
        comparison = gte(comparedExpression, value);
        break;
      case "lt":
        comparison = lt(comparedExpression, value);
        break;
      case "lte":
        comparison = lte(comparedExpression, value);
        break;
      default:
        throw new Error("JSON 路径比较操作符未声明。");
    }
  }

  // RC 没有 COALESCE 条件构造；缺失路径和类型不符必须继续按 false 参与 not/in 组合。
  return sql`COALESCE((${matchesType} AND ${comparison}), FALSE)`;
}

function compileFieldFilter(
  filter: Extract<
    ArchiveSearchFilter | ArchiveSearchTargetFilter,
    { type: "field" }
  >,
  fields: SearchFields,
): SQL {
  const { expression, kind } = searchFieldExpression(filter.field, fields);
  if (filter.operator === "exists") {
    return filter.value === true ? isNotNull(expression) : isNull(expression);
  }
  // RC 未提供 COLLATE 表达式；时间仍显式按 timestamptz 参数比较。
  const comparedExpression =
    kind === "text" ? sql`${expression} COLLATE "C"` : expression;
  const parameter = (value: string): SQL =>
    kind === "text"
      ? sql`${value}::text COLLATE "C"`
      : sql`${value}::timestamptz`;
  const present = isNotNull(expression);
  if (filter.operator === "in" || filter.operator === "notIn") {
    const values = (filter.values ?? []).map(parameter);
    return and(
      present,
      filter.operator === "in"
        ? inArray(comparedExpression, values)
        : notInArray(comparedExpression, values),
    )!;
  }
  if (filter.operator === "between") {
    return and(
      present,
      gte(comparedExpression, parameter(filter.lower ?? "")),
      lte(comparedExpression, parameter(filter.upper ?? "")),
    )!;
  }
  const value = parameter(String(filter.value));
  switch (filter.operator) {
    case "eq":
      return and(present, eq(comparedExpression, value))!;
    case "ne":
      return and(present, ne(comparedExpression, value))!;
    case "gt":
      return and(present, gt(comparedExpression, value))!;
    case "gte":
      return and(present, gte(comparedExpression, value))!;
    case "lt":
      return and(present, lt(comparedExpression, value))!;
    case "lte":
      return and(present, lte(comparedExpression, value))!;
    default:
      throw new Error("搜索字段比较操作符未声明。");
  }
}

function searchRegexPatterns(input: SearchInput): SearchRegexPattern[] {
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
  return patterns;
}

async function invalidSearchRegexPath(
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
  const asOf = BigInt(snapshot.asOf);
  const scopeKind = input.scope.kind;
  const resultUnit =
    scopeKind === "revisions"
      ? "revision"
      : scopeKind === "observations"
        ? "observation"
        : "item";
  const latestSelection = {
    itemId: archiveObservations.itemId,
    revisionId: archiveObservations.revisionId,
    commitId: archiveCommits.commitId,
    archiveSequence: archiveCommits.archiveSequence,
    binId: archiveCommits.binId,
    runId: archiveCommits.runId,
    collectorVersion: archiveCommits.collectorVersion,
    observedAt: archiveCommits.observedAt,
    recordedAt: archiveCommits.recordedAt,
    ordinal: archiveObservations.ordinal,
    stateData: archiveRevisions.stateData,
  };
  const latestPredicate = and(
    lte(archiveCommits.archiveSequence, asOf),
    input.scope.binId === undefined
      ? undefined
      : eq(archiveCommits.binId, input.scope.binId),
  );
  const distinctOn: SQLWrapper[] =
    scopeKind === "revisions"
      ? [
          archiveObservations.itemId,
          archiveCommits.binId,
          archiveObservations.revisionId,
        ]
      : [archiveObservations.itemId, archiveCommits.binId];
  const latestOrdering = [
    ...distinctOn.map((column) => asc(column)),
    desc(archiveCommits.archiveSequence),
    desc(archiveObservations.ordinal),
    desc(archiveCommits.commitId),
  ];
  const latestRows =
    scopeKind === "observations"
      ? transaction
          .select(latestSelection)
          .from(archiveObservations)
          .innerJoin(
            archiveCommits,
            eq(archiveCommits.commitId, archiveObservations.commitId),
          )
          .innerJoin(
            archiveRevisions,
            and(
              eq(archiveRevisions.itemId, archiveObservations.itemId),
              eq(archiveRevisions.revisionId, archiveObservations.revisionId),
            ),
          )
          .where(latestPredicate)
          .orderBy(...latestOrdering)
      : transaction
          .selectDistinctOn(distinctOn, latestSelection)
          .from(archiveObservations)
          .innerJoin(
            archiveCommits,
            eq(archiveCommits.commitId, archiveObservations.commitId),
          )
          .innerJoin(
            archiveRevisions,
            and(
              eq(archiveRevisions.itemId, archiveObservations.itemId),
              eq(archiveRevisions.revisionId, archiveObservations.revisionId),
            ),
          )
          .where(latestPredicate)
          .orderBy(...latestOrdering);
  const latest = transaction.$with("latest").as(latestRows);

  const textConditions: ArchiveSearchText[] = [];
  const rootFields: SearchFields = {
    item: {
      itemId: archiveItems.itemId,
      namespace: archiveItems.namespace,
      sourceKey: archiveItems.sourceKey,
    },
    revision: { stateData: archiveRevisions.stateData },
    latest: {
      binId: latest.binId,
      runId: latest.runId,
      collectorVersion: latest.collectorVersion,
      observedAt: latest.observedAt,
      recordedAt: latest.recordedAt,
    },
  };
  const compileText = (
    text: ArchiveSearchText,
    fields: SearchFields,
    includeHit: boolean,
  ): SQL => {
    const searchText = searchTextExpression(fields.revision.stateData);
    if (includeHit) textConditions.push(text);
    // RC 不提供 LIKE ESCAPE 或 PostgreSQL ARE 条件构造；模式值仍由插值绑定。
    if (text.kind === "literal") {
      const pattern = `%${escapeLikeLiteral(text.value)}%`;
      return and(
        isNotNull(searchText),
        sql`${searchText} LIKE ${pattern} ESCAPE E'\\\\'`,
      )!;
    }
    return and(isNotNull(searchText), sql`${searchText} ~ ${text.pattern}`)!;
  };
  const compileFilter = (
    filter: ArchiveSearchFilter | ArchiveSearchTargetFilter,
    fields: SearchFields,
    includeHit = true,
  ): SQL => {
    if (filter.type === "and" || filter.type === "or") {
      const conditions = filter.conditions.map((condition) =>
        compileFilter(condition, fields, includeHit),
      );
      return (filter.type === "and" ? and(...conditions) : or(...conditions))!;
    }
    if (filter.type === "not") {
      return not(compileFilter(filter.condition, fields, includeHit))!;
    }
    if (filter.type === "text") {
      return compileText(filter.text, fields, includeHit);
    }
    if (filter.type === "json") {
      return compileJsonFilter(filter, fields.revision.stateData);
    }
    if (filter.type === "field") {
      return compileFieldFilter(filter, fields);
    }
    return compileRelationFilter(filter, fields);
  };

  let relationAliasIndex = 0;
  const compileRelationFilter = (
    filter: ArchiveSearchRelationFilter,
    fields: SearchFields,
  ): SQL => {
    const suffix = relationAliasIndex.toString(10);
    relationAliasIndex += 1;
    const relation = alias(archiveRelations, `search_relation_${suffix}`);
    const relationObservation = alias(
      archiveRelationObservations,
      `search_relation_observation_${suffix}`,
    );
    const relationRevision = alias(
      archiveRelationRevisions,
      `search_relation_revision_${suffix}`,
    );
    const latestRelation = transaction
      .select({
        relationRevisionId: relationObservation.relationRevisionId,
      })
      .from(relationObservation)
      .where(
        and(
          eq(relationObservation.relationId, relation.relationId),
          eq(relationObservation.binId, fields.latest.binId),
          lte(relationObservation.archiveSequence, asOf),
        ),
      )
      .orderBy(
        desc(relationObservation.archiveSequence),
        desc(relationObservation.ordinal),
        desc(relationObservation.commitId),
      )
      .limit(1)
      .as(`search_relation_latest_${suffix}`);
    // RC 没有 CASE/COALESCE 构造器；表达式保留逻辑对端及 item/sourceRef 身份供同一 bin/K 筛选和去重。
    const relatedItemId: SQLWrapper =
      filter.direction === "outgoing"
        ? relation.targetItemId
        : filter.direction === "incoming"
          ? relation.fromItemId
          : sql`CASE WHEN ${relation.fromItemId} = ${fields.item.itemId} THEN ${relation.targetItemId} ELSE ${relation.fromItemId} END`;
    const relatedSourceRef: SQLWrapper =
      filter.direction === "outgoing"
        ? relation.targetSourceRef
        : filter.direction === "incoming"
          ? sql`NULL::text`
          : sql`CASE WHEN ${relation.fromItemId} = ${fields.item.itemId} THEN ${relation.targetSourceRef} ELSE NULL::text END`;
    const relationIdentity = sql`COALESCE('item:' || ${relatedItemId}::text, 'sourceRef:' || ${relatedSourceRef})`;
    const endpointCondition =
      filter.direction === "outgoing"
        ? eq(relation.fromItemId, fields.item.itemId)
        : filter.direction === "incoming"
          ? eq(relation.targetItemId, fields.item.itemId)
          : or(
              eq(relation.fromItemId, fields.item.itemId),
              eq(relation.targetItemId, fields.item.itemId),
            );
    const conditions: SQL[] = [
      endpointCondition!,
      lte(relation.createdSequence, asOf),
    ];
    if (filter.name !== undefined) {
      // RC 未提供 JSON ->> 与 COLLATE 表达式；关系名仍以 C 序比较。
      conditions.push(
        sql`${relationRevision.stateData}->>'name' COLLATE "C" = ${filter.name}::text COLLATE "C"`,
      );
    }
    if (filter.properties !== undefined) {
      conditions.push(
        compileJsonFilter(filter.properties, relationRevision.stateData),
      );
    }

    const relationRows = transaction
      .select({ identity: relationIdentity.as("identity") })
      .from(relation)
      .innerJoinLateral(latestRelation, sql`true`)
      .innerJoin(
        relationRevision,
        and(
          eq(relationRevision.relationId, relation.relationId),
          eq(
            relationRevision.relationRevisionId,
            latestRelation.relationRevisionId,
          ),
        ),
      );
    const compareRelationCount = (countExpression: SQL): SQL => {
      if (filter.count === undefined) {
        throw new Error("关系数量条件缺少比较符和值。");
      }
      switch (filter.count.operator) {
        case "eq":
          return eq(countExpression, filter.count.value);
        case "gt":
          return gt(countExpression, filter.count.value);
        case "gte":
          return gte(countExpression, filter.count.value);
        case "lt":
          return lt(countExpression, filter.count.value);
        case "lte":
          return lte(countExpression, filter.count.value);
      }
    };

    if (filter.target === undefined) {
      const matchingRelations = relationRows
        .where(and(...conditions))!
        .as(`search_matching_relations_${suffix}`);
      if (filter.operator === "exists") {
        return exists(
          transaction.select({ present: sql`1` }).from(matchingRelations),
        );
      }
      if (filter.operator === "notExists") {
        return notExists(
          transaction.select({ present: sql`1` }).from(matchingRelations),
        );
      }
      const countQuery = transaction
        .select({ count: countDistinct(matchingRelations.identity) })
        .from(matchingRelations);
      return compareRelationCount(sql`(${countQuery})`);
    }

    const targetObservation = alias(
      archiveObservations,
      `search_target_observation_${suffix}`,
    );
    const targetCommit = alias(
      archiveCommits,
      `search_target_commit_${suffix}`,
    );
    const targetItem = alias(archiveItems, `search_target_item_${suffix}`);
    const targetRevision = alias(
      archiveRevisions,
      `search_target_revision_${suffix}`,
    );
    const targetLatest = transaction
      .select({
        revisionId: targetObservation.revisionId,
        binId: targetCommit.binId,
        runId: targetCommit.runId,
        collectorVersion: targetCommit.collectorVersion,
        observedAt: targetCommit.observedAt,
        recordedAt: targetCommit.recordedAt,
      })
      .from(targetObservation)
      .innerJoin(
        targetCommit,
        eq(targetCommit.commitId, targetObservation.commitId),
      )
      .where(
        and(
          eq(targetObservation.itemId, relatedItemId),
          eq(targetCommit.binId, fields.latest.binId),
          lte(targetCommit.archiveSequence, asOf),
        ),
      )
      .orderBy(
        desc(targetCommit.archiveSequence),
        desc(targetObservation.ordinal),
        desc(targetCommit.commitId),
      )
      .limit(1)
      .as(`search_target_latest_${suffix}`);
    const targetFields: SearchFields = {
      item: {
        itemId: targetItem.itemId,
        namespace: targetItem.namespace,
        sourceKey: targetItem.sourceKey,
      },
      revision: { stateData: targetRevision.stateData },
      latest: {
        binId: targetLatest.binId,
        runId: targetLatest.runId,
        collectorVersion: targetLatest.collectorVersion,
        observedAt: targetLatest.observedAt,
        recordedAt: targetLatest.recordedAt,
      },
    };
    const matchingRelations = relationRows
      .innerJoinLateral(targetLatest, sql`true`)
      .innerJoin(targetItem, eq(targetItem.itemId, relatedItemId))
      .innerJoin(
        targetRevision,
        and(
          eq(targetRevision.itemId, targetItem.itemId),
          eq(targetRevision.revisionId, targetLatest.revisionId),
        ),
      )
      .where(
        and(...conditions, compileFilter(filter.target, targetFields, false)),
      )!
      .as(`search_matching_relations_${suffix}`);
    if (filter.operator === "exists") {
      return exists(
        transaction.select({ present: sql`1` }).from(matchingRelations),
      );
    }
    if (filter.operator === "notExists") {
      return notExists(
        transaction.select({ present: sql`1` }).from(matchingRelations),
      );
    }
    const countQuery = transaction
      .select({ count: countDistinct(matchingRelations.identity) })
      .from(matchingRelations);
    return compareRelationCount(sql`(${countQuery})`);
  };

  const filters: ArchiveSearchFilter[] = [
    ...(input.text === undefined
      ? []
      : [{ type: "text" as const, text: input.text }]),
    ...(input.where === undefined ? [] : [input.where]),
  ];
  if (filters.length === 0) {
    throw new Error("搜索条件至少需要一个文本或字段谓词。");
  }
  const matchPredicate =
    filters.length === 1
      ? compileFilter(filters[0]!, rootFields)
      : and(...filters.map((filter) => compileFilter(filter, rootFields)))!;
  // 公共 resultId 由多列文本组成，RC 未提供 PostgreSQL ::text 与 || 的类型化表达式。
  const resultIdExpression =
    resultUnit === "item"
      ? sql`${latest.itemId}::text`.mapWith(String)
      : resultUnit === "revision"
        ? sql`${latest.itemId}::text || ':' || ${latest.revisionId}::text`.mapWith(
            String,
          )
        : sql`${latest.commitId}::text || ':' || ${latest.ordinal}::text`.mapWith(
            String,
          );
  const matched = transaction.$with("matched").as(
    transaction
      .select({
        ...getColumns(latest),
        namespace: archiveItems.namespace,
        sourceKey: archiveItems.sourceKey,
        sourceRef: sql`${archiveRevisions.stateData}->>'sourceRef'`
          .mapWith(String)
          .nullable()
          .as("sourceRef"),
        sourceModifiedAt:
          sql`${archiveRevisions.stateData}->>'sourceModifiedAt'`
            .mapWith(String)
            .nullable()
            .as("sourceModifiedAt"),
        completeness:
          sql`${archiveRevisions.stateData}->'capture'->>'completeness'`
            .mapWith(decodeCaptureCompleteness)
            .nullable()
            .as("completeness"),
        searchText: searchTextExpression(archiveRevisions.stateData)
          .mapWith(String)
          .nullable()
          .as("searchText"),
        resultId: resultIdExpression.as("resultId"),
      })
      .from(latest)
      .innerJoin(archiveItems, eq(archiveItems.itemId, latest.itemId))
      .innerJoin(
        archiveRevisions,
        and(
          eq(archiveRevisions.itemId, latest.itemId),
          eq(archiveRevisions.revisionId, latest.revisionId),
        ),
      )
      .where(matchPredicate),
  );
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
