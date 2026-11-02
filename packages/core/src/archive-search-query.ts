import {
  type ArchiveSearchField,
  type ArchiveSearchFilter,
  type ArchiveSearchJsonFilter,
  type ArchiveSearchJsonProjection,
  type ArchiveSearchPathFilter,
  type ArchiveSearchPathStep,
  type ArchiveSearchRelationFilter,
  type ArchiveSearchRequest,
  type ArchiveSearchTargetFilter,
  type ArchiveSearchText,
} from "@binny/contracts";
import {
  archiveCommits,
  archiveItems,
  archiveObservations,
  archiveRelationRevisions,
  archiveRelations,
  archiveRevisions,
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
  ne,
  not,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
  type WithSubquery,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ArchiveTransaction } from "./archive-lock.ts";
import type { ResolvedSnapshot } from "./archive-read.ts";
import {
  latestArchiveItemObservation,
  latestArchiveRelationObservation,
  latestCurrentRelationObservationGap,
} from "./archive-relation-view.ts";

type ArchiveMatchedInput = Pick<
  ArchiveSearchRequest,
  "scope" | "text" | "where"
>;

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
    readonly sourceAdapterVersion: SQLWrapper;
    readonly observedAt: SQLWrapper;
    readonly recordedAt: SQLWrapper;
  };
};

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export function searchTextExpression(stateData: SQLWrapper): SQL {
  // RC 没有 jsonb 的 ->/->> 类型化运算符；状态仍由 schema 列引用。
  return sql`${stateData}->'body'->>'searchText'`;
}

export function searchJsonPathExpression(
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

export function searchJsonValue(value: unknown): SQL {
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
    case "sourceAdapterVersion":
      return { expression: fields.latest.sourceAdapterVersion, kind: "text" };
    case "observedAt":
      return { expression: fields.latest.observedAt, kind: "timestamp" };
    case "recordedAt":
      return { expression: fields.latest.recordedAt, kind: "timestamp" };
  }
}

export function compileJsonFilter(
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
    if (!("value" in filter)) {
      throw new Error("JSON 路径比较缺少单个 value。");
    }
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

export function buildArchiveMatchedQuery(
  transaction: ArchiveTransaction,
  snapshot: ResolvedSnapshot,
  input: ArchiveMatchedInput,
  allowEmptyFilter = false,
) {
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
    sourceAdapterVersion: archiveCommits.sourceAdapterVersion,
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
      sourceAdapterVersion: latest.sourceAdapterVersion,
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
  let relationAliasIndex = 0;
  let pathAliasIndex = 0;
  const buildRelationStepRows = (
    step: ArchiveSearchPathStep,
    currentItemId: SQLWrapper,
    binId: SQLWrapper,
    includeEvidence = false,
  ) => {
    const suffix = relationAliasIndex.toString(10);
    relationAliasIndex += 1;
    const relation = alias(archiveRelations, `search_relation_${suffix}`);
    const relationRevision = alias(
      archiveRelationRevisions,
      `search_relation_revision_${suffix}`,
    );
    const relationLatestName = `search_relation_latest_${suffix}`;
    const latestRelation = latestArchiveRelationObservation(
      transaction,
      relation.relationId,
      binId,
      asOf,
      relationLatestName,
    );
    const currentGap = latestCurrentRelationObservationGap(
      transaction,
      relation.relationId,
      binId,
      asOf,
      `search_relation_gap_${suffix}`,
    );
    // CASE 与 COALESCE 是局部方向和身份表达式；关系和观察列仍来自 schema。
    const relatedItemId: SQLWrapper =
      step.direction === "outgoing"
        ? relation.targetItemId
        : step.direction === "incoming"
          ? relation.fromItemId
          : sql`CASE WHEN ${relation.fromItemId} = ${currentItemId} THEN ${relation.targetItemId} ELSE ${relation.fromItemId} END`;
    const relatedSourceRef: SQLWrapper =
      step.direction === "outgoing"
        ? relation.targetSourceRef
        : step.direction === "incoming"
          ? sql`NULL::text`
          : sql`CASE WHEN ${relation.fromItemId} = ${currentItemId} THEN ${relation.targetSourceRef} ELSE NULL::text END`;
    const endpointIdentity = sql`COALESCE('item:' || ${relatedItemId}::text, 'sourceRef:' || ${relatedSourceRef})`;
    const endpointCondition =
      step.direction === "outgoing"
        ? eq(relation.fromItemId, currentItemId)
        : step.direction === "incoming"
          ? eq(relation.targetItemId, currentItemId)
          : or(
              eq(relation.fromItemId, currentItemId),
              eq(relation.targetItemId, currentItemId),
            );
    const conditions: SQL[] = [
      endpointCondition!,
      lte(relation.createdSequence, asOf),
      isNull(currentGap.commitId)!,
    ];
    if (step.name !== undefined) {
      conditions.push(
        sql`${relationRevision.stateData}->>'name' COLLATE "C" = ${step.name}::text COLLATE "C"`,
      );
    }
    if (step.properties !== undefined) {
      conditions.push(
        compileJsonFilter(step.properties, relationRevision.stateData),
      );
    }

    const targetItem = alias(archiveItems, `search_target_item_${suffix}`);
    const targetRevision = alias(
      archiveRevisions,
      `search_target_revision_${suffix}`,
    );
    const targetLatest = latestArchiveItemObservation(
      transaction,
      relatedItemId,
      binId,
      asOf,
      `search_target_latest_${suffix}`,
    );
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
        sourceAdapterVersion: targetLatest.sourceAdapterVersion,
        observedAt: targetLatest.observedAt,
        recordedAt: targetLatest.recordedAt,
      },
    };
    const sourceItem = alias(archiveItems, `search_source_item_${suffix}`);
    const sourceLatest = latestArchiveItemObservation(
      transaction,
      relation.fromItemId,
      binId,
      asOf,
      `search_source_latest_${suffix}`,
    );
    const endpointTargetItem = alias(
      archiveItems,
      `search_endpoint_target_item_${suffix}`,
    );
    const endpointTargetLatest = latestArchiveItemObservation(
      transaction,
      relation.targetItemId,
      binId,
      asOf,
      `search_endpoint_target_latest_${suffix}`,
    );
    const relationDirection =
      step.direction === "either"
        ? sql`CASE WHEN ${relation.fromItemId} = ${currentItemId} THEN 'outgoing' ELSE 'incoming' END`
        : sql`${step.direction}::text`;
    const fromJson = sql`jsonb_strip_nulls(jsonb_build_object(
      'kind', 'item',
      'itemId', ${relation.fromItemId},
      'sourceKey', jsonb_build_object('namespace', ${sourceItem.namespace}, 'key', ${sourceItem.sourceKey}),
      'status', CASE WHEN ${sourceLatest.revisionId} IS NULL THEN 'unknown' ELSE 'observed' END,
      'revisionId', ${sourceLatest.revisionId}
    ))`;
    const toJson = sql`CASE WHEN ${relation.targetItemId} IS NULL THEN
      jsonb_build_object('kind', 'sourceRef', 'sourceRef', ${relation.targetSourceRef})
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'kind', 'item',
      'itemId', ${relation.targetItemId},
      'sourceKey', jsonb_build_object('namespace', ${endpointTargetItem.namespace}, 'key', ${endpointTargetItem.sourceKey}),
      'status', CASE WHEN ${endpointTargetLatest.revisionId} IS NULL THEN 'unknown' ELSE 'observed' END,
      'revisionId', ${endpointTargetLatest.revisionId}
    )) END`;
    const observationJson = sql`jsonb_strip_nulls(jsonb_build_object(
      'commitId', ${latestRelation.commitId},
      'archiveSeq', ${latestRelation.archiveSequence}::text,
      'ordinal', ${latestRelation.ordinal},
      'observedAt', ${latestRelation.observedAt},
      'recordedAt', ${latestRelation.recordedAt},
      'runId', ${latestRelation.runId},
      'sourceAdapterVersion', ${latestRelation.sourceAdapterVersion}
    ))`;
    // JSON 只作为路径依据的局部投影；archiveSeq 在数据库端转成文本后再序列化。
    const evidence = includeEvidence
      ? sql`jsonb_build_object(
          'relationId', ${relation.relationId},
          'direction', ${relationDirection},
          'status', 'observed',
          'from', ${fromJson},
          'to', ${toJson},
          'revisionId', ${latestRelation.relationRevisionId},
          'state', ${relationRevision.stateData},
          'observation', ${observationJson}
        )`
      : sql`NULL::jsonb`;
    let rows = transaction
      .select({
        identity: endpointIdentity.mapWith(String).as("identity"),
        nextItemId: sql`${relatedItemId}`
          .mapWith(String)
          .nullable()
          .as("nextItemId"),
        relationId: relation.relationId,
        relationRevisionId: latestRelation.relationRevisionId,
        relationStateData: relationRevision.stateData,
        fromItemId: relation.fromItemId,
        targetItemId: relation.targetItemId,
        targetSourceRef: relation.targetSourceRef,
        binId: sql`${binId}`.mapWith(String).as("binId"),
        archiveSequence: latestRelation.archiveSequence,
        commitId: latestRelation.commitId,
        ordinal: latestRelation.ordinal,
        observedAt: latestRelation.observedAt,
        recordedAt: latestRelation.recordedAt,
        runId: latestRelation.runId,
        sourceAdapterVersion: latestRelation.sourceAdapterVersion,
        direction: relationDirection.as("direction"),
        evidence: evidence.mapWith(archiveRevisions.stateData).as("evidence"),
      })
      .from(relation)
      .innerJoinLateral(latestRelation, sql`true`)
      .leftJoinLateral(currentGap, sql`true`)
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
    if (includeEvidence) {
      rows = rows
        .leftJoin(sourceItem, eq(sourceItem.itemId, relation.fromItemId))
        .leftJoinLateral(sourceLatest, sql`true`)
        .leftJoin(
          endpointTargetItem,
          eq(endpointTargetItem.itemId, relation.targetItemId),
        )
        .leftJoinLateral(endpointTargetLatest, sql`true`);
    }
    if (step.target !== undefined) {
      rows = rows
        .innerJoinLateral(targetLatest, sql`true`)
        .innerJoin(targetItem, eq(targetItem.itemId, relatedItemId))
        .innerJoin(
          targetRevision,
          and(
            eq(targetRevision.itemId, targetItem.itemId),
            eq(targetRevision.revisionId, targetLatest.revisionId),
          ),
        );
      conditions.push(compileFilter(step.target, targetFields, false));
    }
    return rows.where(and(...conditions))!.as(`search_relation_step_${suffix}`);
  };

  function compileFilter(
    filter: ArchiveSearchFilter | ArchiveSearchTargetFilter,
    fields: SearchFields,
    includeHit = true,
  ): SQL {
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
    if (filter.type === "relation") {
      return compileRelationFilter(filter, fields);
    }
    return compilePathFilter(filter, fields);
  }

  const buildPathRows = (
    steps: readonly ArchiveSearchPathStep[],
    startItemId: SQLWrapper,
    startBinId: SQLWrapper,
    includeEvidence: boolean,
    anchor?: {
      readonly source: WithSubquery;
      readonly resultId: SQLWrapper;
      readonly itemId: SQLWrapper;
      readonly binId: SQLWrapper;
    },
  ) => {
    const prefix = `search_path_${pathAliasIndex.toString(10)}`;
    pathAliasIndex += 1;
    const ctes: WithSubquery[] = [];
    let previous: WithSubquery | undefined;
    let currentItemId = anchor?.itemId ?? startItemId;
    let currentBinId = anchor?.binId ?? startBinId;
    let currentResultId: SQLWrapper =
      anchor?.resultId ?? sql`NULL::text`.mapWith(String).nullable();
    let currentPathData: SQLWrapper = sql`NULL::jsonb`;
    let currentIdentity: SQLWrapper = sql`NULL::text`;
    let finalPath: WithSubquery | undefined;

    for (const [index, step] of steps.entries()) {
      const stepRows = buildRelationStepRows(
        step,
        currentItemId,
        currentBinId,
        includeEvidence,
      );
      const nextPathData =
        includeEvidence && index > 0
          ? sql`${currentPathData} || jsonb_build_array(${stepRows.evidence})`
          : includeEvidence
            ? sql`jsonb_build_array(${stepRows.evidence})`
            : sql`NULL::jsonb`;
      const selectFields = {
        resultId: sql`${currentResultId}`
          .mapWith(String)
          .nullable()
          .as("resultId"),
        binId: sql`${currentBinId}`.mapWith(String).as("binId"),
        identity: stepRows.identity,
        nextItemId: stepRows.nextItemId,
        pathData: nextPathData
          .mapWith(archiveRevisions.stateData)
          .as("pathData"),
      };
      const query =
        previous === undefined
          ? anchor === undefined
            ? transaction.select(selectFields).from(stepRows)
            : transaction
                .select(selectFields)
                .from(anchor.source)
                .innerJoinLateral(stepRows, sql`true`)
          : transaction
              .select(selectFields)
              .from(previous)
              .innerJoinLateral(stepRows, sql`true`);
      const cte = transaction.$with(`${prefix}_${index}`).as(query);
      ctes.push(cte);
      previous = cte;
      finalPath = cte;
      currentItemId = cte.nextItemId;
      currentBinId = cte.binId;
      currentResultId = cte.resultId;
      currentPathData = cte.pathData;
      currentIdentity = cte.identity;
    }
    if (finalPath === undefined) {
      throw new Error("有限关系路径至少需要一个步骤。");
    }
    return {
      ctes,
      finalPath,
      identity: currentIdentity,
      resultId: currentResultId,
      binId: currentBinId,
      pathData: currentPathData,
    };
  };

  const compareRelationCount = (
    count: ArchiveSearchRelationFilter["count"],
    countExpression: SQL,
    errorMessage: string,
  ): SQL => {
    if (count === undefined) throw new Error(errorMessage);
    switch (count.operator) {
      case "eq":
        return eq(countExpression, count.value);
      case "gt":
        return gt(countExpression, count.value);
      case "gte":
        return gte(countExpression, count.value);
      case "lt":
        return lt(countExpression, count.value);
      case "lte":
        return lte(countExpression, count.value);
    }
  };

  function compileRelationFilter(
    filter: ArchiveSearchRelationFilter,
    fields: SearchFields,
  ): SQL {
    const matchingRelations = buildRelationStepRows(
      filter,
      fields.item.itemId,
      fields.latest.binId,
    );
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
    return compareRelationCount(
      filter.count,
      sql`(${countQuery})`,
      "关系数量条件缺少比较符和值。",
    );
  }

  function compilePathFilter(
    filter: ArchiveSearchPathFilter,
    fields: SearchFields,
  ): SQL {
    const pathRows = buildPathRows(
      filter.steps,
      fields.item.itemId,
      fields.latest.binId,
      false,
    );
    if (filter.operator === "exists") {
      return exists(
        transaction
          .with(...pathRows.ctes)
          .select({ present: sql`1` })
          .from(pathRows.finalPath),
      );
    }
    if (filter.operator === "notExists") {
      return notExists(
        transaction
          .with(...pathRows.ctes)
          .select({ present: sql`1` })
          .from(pathRows.finalPath),
      );
    }
    const countQuery = transaction
      .with(...pathRows.ctes)
      .select({ count: countDistinct(pathRows.identity) })
      .from(pathRows.finalPath);
    return compareRelationCount(
      filter.count,
      sql`(${countQuery})`,
      "路径数量条件缺少比较符和值。",
    );
  }

  const filters: ArchiveSearchFilter[] = [
    ...(input.text === undefined
      ? []
      : [{ type: "text" as const, text: input.text }]),
    ...(input.where === undefined ? [] : [input.where]),
  ];
  if (filters.length === 0 && !allowEmptyFilter) {
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
  return {
    asOf,
    resultUnit,
    latest,
    matched,
    rootFields,
    textConditions,
    compileText,
    buildRelationStepRows,
    buildPathRows,
  };
}
