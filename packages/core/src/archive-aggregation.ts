import { createHash } from "node:crypto";

import {
  archiveAggregationInputSchema,
  archiveAggregationResultSchema,
  archiveJsonValueSchema,
  archiveSnapshotSequenceSchema,
  type ArchiveAggregationHaving,
  type ArchiveAggregationMetric,
  type ArchiveAggregationOperation,
  type ArchiveAggregationRequest,
  type ArchiveAggregationResult,
  type ArchiveAggregationSelector,
  type ArchiveAggregationUnit,
  type ArchiveOperations,
} from "@binny/contracts";
import {
  archiveCommits,
  archiveRelationRevisions,
  archiveRevisions,
  databaseErrorCode,
  postgresTimeZones,
  type Database,
} from "@binny/db";
import {
  and,
  asc,
  avg,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  or,
  sql,
  sum,
  type SQL,
  type SQLWrapper,
  type WithSubquery,
} from "drizzle-orm";

import { canonicalJson } from "./archive-common.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import { resolveSnapshot, type ResolvedSnapshot } from "./archive-read.ts";
import {
  buildArchiveMatchedQuery,
  searchJsonPathExpression,
} from "./archive-search-query.ts";
import {
  invalidSearchRegexPath,
  searchRegexPatterns,
} from "./archive-search.ts";

type AggregationInput = ReturnType<typeof archiveAggregationInputSchema.parse>;

type AggregationCursor = {
  readonly version: 1;
  readonly queryHash: string;
  readonly snapshot: ResolvedSnapshot;
  readonly offset: number;
};

type JsonValueDecoder = {
  mapFromDriverValue(
    value: unknown,
  ): ReturnType<typeof archiveJsonValueSchema.parse>;
};

const jsonValueDecoder: JsonValueDecoder = {
  mapFromDriverValue(value) {
    return archiveJsonValueSchema.parse(value);
  },
};

type AggregateUnitColumns = {
  readonly itemId: SQLWrapper;
  readonly revisionId: SQLWrapper;
  readonly commitId: SQLWrapper;
  readonly ordinal: SQLWrapper;
  readonly relationId: SQLWrapper;
  readonly stateData: SQLWrapper;
  readonly namespace: SQLWrapper;
  readonly sourceKey: SQLWrapper;
  readonly binId: SQLWrapper;
  readonly runId: SQLWrapper;
  readonly collectorVersion: SQLWrapper;
  readonly observedAt: SQLWrapper;
  readonly recordedAt: SQLWrapper;
  readonly archiveSequence: SQLWrapper;
  readonly relationStateData: SQLWrapper;
  readonly fromItemId: SQLWrapper;
  readonly targetItemId: SQLWrapper;
  readonly targetSourceRef: SQLWrapper;
};

type AggregateGroupExpressions = {
  readonly status: SQL<string>;
  readonly value: SQL;
  readonly bucketStart: SQL<Date | null>;
  readonly bucketEnd: SQL<Date | null>;
  readonly timeBucket: boolean;
};

type AggregateValueSelector = Extract<
  ArchiveAggregationMetric,
  { readonly op: "distinct" | "sum" | "avg" | "min" | "max" }
>["value"];

type AggregateUnitRows = WithSubquery & AggregateUnitColumns;

function encodeAggregationCursor(cursor: AggregationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeAggregationCursor(
  cursor: string,
): AggregationCursor | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) return undefined;
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return undefined;
    if (
      !("version" in value) ||
      value.version !== 1 ||
      !("queryHash" in value) ||
      typeof value.queryHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.queryHash) ||
      !("offset" in value) ||
      typeof value.offset !== "number" ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      !("snapshot" in value) ||
      typeof value.snapshot !== "object" ||
      value.snapshot === null ||
      !("asOf" in value.snapshot) ||
      !("mode" in value.snapshot)
    ) {
      return undefined;
    }
    const sequence = archiveSnapshotSequenceSchema.safeParse(
      value.snapshot.asOf,
    );
    if (
      !sequence.success ||
      (value.snapshot.mode !== "current" && value.snapshot.mode !== "asOf")
    ) {
      return undefined;
    }
    return {
      version: 1,
      queryHash: value.queryHash,
      snapshot: { asOf: sequence.data, mode: value.snapshot.mode },
      offset: value.offset,
    };
  } catch {
    return undefined;
  }
}

function invalidAggregationCursor() {
  return {
    ok: false as const,
    status: 400 as const,
    error: {
      code: "invalid_input" as const,
      message: "聚合游标无效，或不属于当前查询。",
      path: ["cursor"],
    },
  };
}

function nullJsonValue(): SQL {
  return sql`NULL::jsonb`.mapWith(jsonValueDecoder).nullable();
}

function nullTimestamp(): SQL<Date | null> {
  return sql`NULL::timestamptz`.mapWith(archiveCommits.observedAt).nullable();
}

function selectedText(expression: SQLWrapper, alias: string) {
  return sql`${expression}`.mapWith(String).as(alias);
}

function selectedNullableText(expression: SQLWrapper, alias: string) {
  return sql`${expression}`.mapWith(String).nullable().as(alias);
}

function selectedJsonValue(expression: SQLWrapper, alias: string) {
  return sql`${expression}`.mapWith(jsonValueDecoder).nullable().as(alias);
}

function selectedTimestamp(expression: SQLWrapper, alias: string) {
  return sql`${expression}`
    .mapWith(archiveCommits.observedAt)
    .nullable()
    .as(alias);
}

function jsonbValue(expression: SQLWrapper): SQL {
  return sql`${expression}`.mapWith(jsonValueDecoder).nullable();
}

function scalarAsJsonb(expression: SQLWrapper): SQL {
  return sql`to_jsonb(${expression})`.mapWith(jsonValueDecoder).nullable();
}

function contentFieldValue(
  field: string,
  units: AggregateUnitColumns,
): SQLWrapper | undefined {
  switch (field) {
    case "itemId":
      return units.itemId;
    case "revisionId":
      return units.revisionId;
    case "commitId":
      return units.commitId;
    case "archiveSeq":
      return sql`${units.archiveSequence}::text`;
    case "ordinal":
      return units.ordinal;
    case "sourceKey.namespace":
      return units.namespace;
    case "sourceKey.key":
      return units.sourceKey;
    case "sourceRef":
      return sql`${units.stateData}->>'sourceRef'`;
    case "sourceModifiedAt":
      return sql`${units.stateData}->>'sourceModifiedAt'`;
    case "capture.completeness":
      return sql`${units.stateData}->'capture'->>'completeness'`;
    case "body.searchText":
      return sql`${units.stateData}->'body'->>'searchText'`;
    case "binId":
      return units.binId;
    case "runId":
      return units.runId;
    case "collectorVersion":
      return units.collectorVersion;
    case "observedAt":
      return sql`to_char(${units.observedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    case "recordedAt":
      return sql`to_char(${units.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    default:
      return undefined;
  }
}

function relationFieldValue(
  field: string,
  units: AggregateUnitColumns,
): SQLWrapper | undefined {
  switch (field) {
    case "relationId":
      return units.relationId;
    case "name":
      return sql`${units.relationStateData}->>'name'`;
    case "cascade":
      return sql`${units.relationStateData}->'cascade'`;
    case "from.itemId":
      return units.fromItemId;
    case "to.itemId":
      return units.targetItemId;
    case "to.sourceRef":
      return units.targetSourceRef;
    case "binId":
      return units.binId;
    case "runId":
      return units.runId;
    case "collectorVersion":
      return units.collectorVersion;
    case "observedAt":
      return sql`to_char(${units.observedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    case "recordedAt":
      return sql`to_char(${units.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    default:
      return undefined;
  }
}

function selectorJsonbValue(
  selector: ArchiveAggregationSelector | AggregateValueSelector,
  units: AggregateUnitColumns,
  unit: ArchiveAggregationUnit,
): SQL {
  if (selector.type === "json") {
    const stateData =
      unit === "relation" ? units.relationStateData : units.stateData;
    return jsonbValue(
      searchJsonPathExpression(stateData, selector.field, selector.path),
    );
  }
  if (selector.type === "timeBucket") {
    return nullJsonValue();
  }
  const value =
    unit === "relation"
      ? relationFieldValue(selector.field, units)
      : contentFieldValue(selector.field, units);
  if (value === undefined) {
    throw new Error("聚合字段未映射到所选统计单位。");
  }
  return scalarAsJsonb(value);
}

function selectorGroupExpressions(
  selector: ArchiveAggregationSelector,
  units: AggregateUnitColumns,
  unit: ArchiveAggregationUnit,
): AggregateGroupExpressions {
  if (selector.type === "timeBucket") {
    const timestamp =
      selector.field === "sourceModifiedAt"
        ? sql`(${units.stateData}->>'sourceModifiedAt')::timestamptz`
        : selector.field === "observedAt"
          ? units.observedAt
          : units.recordedAt;
    const start = sql`date_trunc(${selector.grain}::text, ${timestamp}, ${selector.timeZone}::text)`;
    const interval =
      selector.grain === "day"
        ? sql`interval '1 day'`
        : selector.grain === "week"
          ? sql`interval '1 week'`
          : sql`interval '1 month'`;
    // RC 无原生 PostgreSQL 日历分桶函数；两个局部表达式显式使用同一时区的日历截点。
    const end = sql`((date_trunc(${selector.grain}::text, ${timestamp}, ${selector.timeZone}::text) AT TIME ZONE ${selector.timeZone}::text) + ${interval}) AT TIME ZONE ${selector.timeZone}::text`;
    return {
      status:
        sql`CASE WHEN ${timestamp} IS NULL THEN 'missing'::text ELSE 'value'::text END`.mapWith(
          String,
        ),
      value: nullJsonValue(),
      bucketStart: sql`${start}`.mapWith(archiveCommits.observedAt).nullable(),
      bucketEnd: sql`${end}`.mapWith(archiveCommits.observedAt).nullable(),
      timeBucket: true,
    };
  }

  const rawValue =
    selector.type === "json"
      ? searchJsonPathExpression(
          unit === "relation" ? units.relationStateData : units.stateData,
          selector.field,
          selector.path,
        )
      : (unitFieldValue(selector.field, units) ??
        (() => {
          throw new Error("聚合字段未映射到所选统计单位。");
        })());
  const value =
    selector.type === "json" ? jsonbValue(rawValue) : scalarAsJsonb(rawValue);
  return {
    status:
      sql`CASE WHEN ${rawValue} IS NULL THEN 'missing'::text ELSE 'value'::text END`.mapWith(
        String,
      ),
    value,
    bucketStart: nullTimestamp(),
    bucketEnd: nullTimestamp(),
    timeBucket: false,
  };
}

function unitFieldValue(
  field: string,
  units: AggregateUnitColumns,
): SQLWrapper | undefined {
  return relationFieldValue(field, units) ?? contentFieldValue(field, units);
}

function metricValueSelector(
  metric: Extract<
    ArchiveAggregationMetric,
    { readonly op: "distinct" | "sum" | "avg" | "min" | "max" }
  >,
  units: AggregateUnitColumns,
  unit: ArchiveAggregationUnit,
): SQL {
  return selectorJsonbValue(metric.value, units, unit);
}

function createUnitRows(
  transaction: ArchiveTransaction,
  matchedQuery: ReturnType<typeof buildArchiveMatchedQuery>,
  input: AggregationInput,
) {
  const { matched } = matchedQuery;
  if (input.unit === "relation") {
    const relationStep = matchedQuery.buildRelationStepRows(
      input.relations!,
      matched.itemId,
      matched.binId,
    );
    return transaction.$with("aggregation_units").as(
      transaction
        .select({
          itemId: sql`NULL::uuid`.mapWith(String).nullable().as("itemId"),
          revisionId: sql`NULL::uuid`
            .mapWith(String)
            .nullable()
            .as("revisionId"),
          commitId: sql`${relationStep.commitId}`.as("commitId"),
          ordinal: sql`${relationStep.ordinal}`.as("ordinal"),
          relationId: sql`${relationStep.relationId}`.as("relationId"),
          stateData: sql`NULL::jsonb`
            .mapWith(archiveRevisions.stateData)
            .nullable()
            .as("stateData"),
          namespace: sql`NULL::text`.mapWith(String).nullable().as("namespace"),
          sourceKey: sql`NULL::text`.mapWith(String).nullable().as("sourceKey"),
          binId: sql`${relationStep.binId}`.as("binId"),
          runId: sql`${relationStep.runId}`.as("runId"),
          collectorVersion: sql`${relationStep.collectorVersion}`.as(
            "collectorVersion",
          ),
          observedAt: sql`${relationStep.observedAt}`.as("observedAt"),
          recordedAt: sql`${relationStep.recordedAt}`.as("recordedAt"),
          archiveSequence: sql`${relationStep.archiveSequence}`.as(
            "archiveSequence",
          ),
          relationStateData: sql`${relationStep.relationStateData}`.as(
            "relationStateData",
          ),
          fromItemId: sql`${relationStep.fromItemId}`.as("fromItemId"),
          targetItemId: sql`${relationStep.targetItemId}`.as("targetItemId"),
          targetSourceRef: sql`${relationStep.targetSourceRef}`.as(
            "targetSourceRef",
          ),
        })
        .from(matched)
        .innerJoinLateral(relationStep, sql`true`),
    );
  }

  return transaction.$with("aggregation_units").as(
    transaction
      .select({
        itemId: sql`${matched.itemId}`.as("itemId"),
        revisionId: sql`${matched.revisionId}`.as("revisionId"),
        commitId: sql`${matched.commitId}`.as("commitId"),
        ordinal: sql`${matched.ordinal}`.as("ordinal"),
        relationId: sql`NULL::text`.mapWith(String).nullable().as("relationId"),
        stateData: sql`${matched.stateData}`.as("stateData"),
        namespace: sql`${matched.namespace}`.as("namespace"),
        sourceKey: sql`${matched.sourceKey}`.as("sourceKey"),
        binId: sql`${matched.binId}`.as("binId"),
        runId: sql`${matched.runId}`.as("runId"),
        collectorVersion: sql`${matched.collectorVersion}`.as(
          "collectorVersion",
        ),
        observedAt: sql`${matched.observedAt}`.as("observedAt"),
        recordedAt: sql`${matched.recordedAt}`.as("recordedAt"),
        archiveSequence: sql`${matched.archiveSequence}`.as("archiveSequence"),
        relationStateData: sql`NULL::jsonb`
          .mapWith(archiveRelationRevisions.stateData)
          .nullable()
          .as("relationStateData"),
        fromItemId: sql`NULL::uuid`.mapWith(String).nullable().as("fromItemId"),
        targetItemId: sql`NULL::uuid`
          .mapWith(String)
          .nullable()
          .as("targetItemId"),
        targetSourceRef: sql`NULL::text`
          .mapWith(String)
          .nullable()
          .as("targetSourceRef"),
      })
      .from(matched),
  );
}

function groupSlotExpressions(
  input: AggregationInput,
  units: AggregateUnitColumns,
): AggregateGroupExpressions[] {
  return input.groupBy.map((grouping) =>
    selectorGroupExpressions(grouping, units, input.unit),
  );
}

function prepareAggregationRows(
  transaction: ArchiveTransaction,
  units: AggregateUnitRows,
  input: AggregationInput,
) {
  const groups = groupSlotExpressions(input, units);
  const metrics = input.metrics.map((metric) =>
    metric.op === "count"
      ? nullJsonValue()
      : metricValueSelector(metric, units, input.unit),
  );
  const emptyGroup: AggregateGroupExpressions = {
    status: sql`'unused'::text`.mapWith(String),
    value: nullJsonValue(),
    bucketStart: nullTimestamp(),
    bucketEnd: nullTimestamp(),
    timeBucket: false,
  };
  const group0 = groups[0] ?? emptyGroup;
  const group1 = groups[1] ?? emptyGroup;
  const group2 = groups[2] ?? emptyGroup;
  const group3 = groups[3] ?? emptyGroup;
  const group4 = groups[4] ?? emptyGroup;
  return transaction.$with("aggregation_prepared").as(
    transaction
      .select({
        itemId: sql`${units.itemId}`.as("itemId"),
        revisionId: sql`${units.revisionId}`.as("revisionId"),
        commitId: sql`${units.commitId}`.as("commitId"),
        ordinal: sql`${units.ordinal}`.as("ordinal"),
        relationId: sql`${units.relationId}`.as("relationId"),
        stateData: sql`${units.stateData}`.as("stateData"),
        namespace: sql`${units.namespace}`.as("namespace"),
        sourceKey: sql`${units.sourceKey}`.as("sourceKey"),
        binId: sql`${units.binId}`.as("binId"),
        runId: sql`${units.runId}`.as("runId"),
        collectorVersion: sql`${units.collectorVersion}`.as("collectorVersion"),
        observedAt: sql`${units.observedAt}`.as("observedAt"),
        recordedAt: sql`${units.recordedAt}`.as("recordedAt"),
        archiveSequence: sql`${units.archiveSequence}`.as("archiveSequence"),
        relationStateData: sql`${units.relationStateData}`.as(
          "relationStateData",
        ),
        fromItemId: sql`${units.fromItemId}`.as("fromItemId"),
        targetItemId: sql`${units.targetItemId}`.as("targetItemId"),
        targetSourceRef: sql`${units.targetSourceRef}`.as("targetSourceRef"),
        group0Status: group0.status.as("group0Status"),
        group0Value: group0.value.as("group0Value"),
        group0BucketStart: group0.bucketStart.as("group0BucketStart"),
        group0BucketEnd: group0.bucketEnd.as("group0BucketEnd"),
        group1Status: group1.status.as("group1Status"),
        group1Value: group1.value.as("group1Value"),
        group1BucketStart: group1.bucketStart.as("group1BucketStart"),
        group1BucketEnd: group1.bucketEnd.as("group1BucketEnd"),
        group2Status: group2.status.as("group2Status"),
        group2Value: group2.value.as("group2Value"),
        group2BucketStart: group2.bucketStart.as("group2BucketStart"),
        group2BucketEnd: group2.bucketEnd.as("group2BucketEnd"),
        group3Status: group3.status.as("group3Status"),
        group3Value: group3.value.as("group3Value"),
        group3BucketStart: group3.bucketStart.as("group3BucketStart"),
        group3BucketEnd: group3.bucketEnd.as("group3BucketEnd"),
        group4Status: group4.status.as("group4Status"),
        group4Value: group4.value.as("group4Value"),
        group4BucketStart: group4.bucketStart.as("group4BucketStart"),
        group4BucketEnd: group4.bucketEnd.as("group4BucketEnd"),
        metric0Input: (metrics[0] ?? nullJsonValue()).as("metric0Input"),
        metric1Input: (metrics[1] ?? nullJsonValue()).as("metric1Input"),
        metric2Input: (metrics[2] ?? nullJsonValue()).as("metric2Input"),
        metric3Input: (metrics[3] ?? nullJsonValue()).as("metric3Input"),
        metric4Input: (metrics[4] ?? nullJsonValue()).as("metric4Input"),
        metric5Input: (metrics[5] ?? nullJsonValue()).as("metric5Input"),
        metric6Input: (metrics[6] ?? nullJsonValue()).as("metric6Input"),
        metric7Input: (metrics[7] ?? nullJsonValue()).as("metric7Input"),
        metric8Input: (metrics[8] ?? nullJsonValue()).as("metric8Input"),
        metric9Input: (metrics[9] ?? nullJsonValue()).as("metric9Input"),
      })
      .from(units),
  );
}

type PreparedAggregationRows = ReturnType<typeof prepareAggregationRows>;

function aggregationGroupColumns(
  rows: PreparedAggregationRows,
  input: AggregationInput,
): SQLWrapper[] {
  const slots: readonly (readonly [SQLWrapper, SQLWrapper])[] = [
    [
      rows.group0Status,
      input.groupBy[0]?.type === "timeBucket"
        ? rows.group0BucketStart
        : rows.group0Value,
    ],
    [
      rows.group1Status,
      input.groupBy[1]?.type === "timeBucket"
        ? rows.group1BucketStart
        : rows.group1Value,
    ],
    [
      rows.group2Status,
      input.groupBy[2]?.type === "timeBucket"
        ? rows.group2BucketStart
        : rows.group2Value,
    ],
    [
      rows.group3Status,
      input.groupBy[3]?.type === "timeBucket"
        ? rows.group3BucketStart
        : rows.group3Value,
    ],
    [
      rows.group4Status,
      input.groupBy[4]?.type === "timeBucket"
        ? rows.group4BucketStart
        : rows.group4Value,
    ],
  ];
  return slots
    .slice(0, input.groupBy.length)
    .flatMap(([status, value]) => [status, value]);
}

function deduplicateUnits(
  transaction: ArchiveTransaction,
  rows: PreparedAggregationRows,
  input: AggregationInput,
) {
  const groupColumns = aggregationGroupColumns(rows, input);
  const identities = unitIdentityExpressions(rows, input.unit);
  const ordering: SQL[] = [
    ...groupColumns.map((column) => asc(column)),
    ...identities.map((column) => asc(column)),
    asc(sql`${rows.binId} COLLATE "C"`),
    desc(sql`${rows.archiveSequence}`),
    desc(sql`${rows.ordinal}`),
    desc(sql`${rows.commitId}`),
  ];
  return transaction.$with("aggregation_deduplicated").as(
    transaction
      .selectDistinctOn([...groupColumns, ...identities], {
        unitItemId: sql`${rows.itemId}`.as("unitItemId"),
        unitRevisionId: sql`${rows.revisionId}`.as("unitRevisionId"),
        unitCommitId: sql`${rows.commitId}`.as("unitCommitId"),
        unitOrdinal: sql`${rows.ordinal}`.as("unitOrdinal"),
        unitRelationId: sql`${rows.relationId}`.as("unitRelationId"),
        representativeBinId: sql`${rows.binId}`.as("representativeBinId"),
        representativeArchiveSequence: sql`${rows.archiveSequence}`.as(
          "representativeArchiveSequence",
        ),
        representativeOrdinal: sql`${rows.ordinal}`.as("representativeOrdinal"),
        representativeCommitId: sql`${rows.commitId}`.as(
          "representativeCommitId",
        ),
        group0Status: selectedText(rows.group0Status, "group0Status"),
        group0Value: selectedJsonValue(rows.group0Value, "group0Value"),
        group0BucketStart: selectedTimestamp(
          rows.group0BucketStart,
          "group0BucketStart",
        ),
        group0BucketEnd: selectedTimestamp(
          rows.group0BucketEnd,
          "group0BucketEnd",
        ),
        group1Status: selectedText(rows.group1Status, "group1Status"),
        group1Value: selectedJsonValue(rows.group1Value, "group1Value"),
        group1BucketStart: selectedTimestamp(
          rows.group1BucketStart,
          "group1BucketStart",
        ),
        group1BucketEnd: selectedTimestamp(
          rows.group1BucketEnd,
          "group1BucketEnd",
        ),
        group2Status: selectedText(rows.group2Status, "group2Status"),
        group2Value: selectedJsonValue(rows.group2Value, "group2Value"),
        group2BucketStart: selectedTimestamp(
          rows.group2BucketStart,
          "group2BucketStart",
        ),
        group2BucketEnd: selectedTimestamp(
          rows.group2BucketEnd,
          "group2BucketEnd",
        ),
        group3Status: selectedText(rows.group3Status, "group3Status"),
        group3Value: selectedJsonValue(rows.group3Value, "group3Value"),
        group3BucketStart: selectedTimestamp(
          rows.group3BucketStart,
          "group3BucketStart",
        ),
        group3BucketEnd: selectedTimestamp(
          rows.group3BucketEnd,
          "group3BucketEnd",
        ),
        group4Status: selectedText(rows.group4Status, "group4Status"),
        group4Value: selectedJsonValue(rows.group4Value, "group4Value"),
        group4BucketStart: selectedTimestamp(
          rows.group4BucketStart,
          "group4BucketStart",
        ),
        group4BucketEnd: selectedTimestamp(
          rows.group4BucketEnd,
          "group4BucketEnd",
        ),
        metric0Input: selectedJsonValue(rows.metric0Input, "metric0Input"),
        metric1Input: selectedJsonValue(rows.metric1Input, "metric1Input"),
        metric2Input: selectedJsonValue(rows.metric2Input, "metric2Input"),
        metric3Input: selectedJsonValue(rows.metric3Input, "metric3Input"),
        metric4Input: selectedJsonValue(rows.metric4Input, "metric4Input"),
        metric5Input: selectedJsonValue(rows.metric5Input, "metric5Input"),
        metric6Input: selectedJsonValue(rows.metric6Input, "metric6Input"),
        metric7Input: selectedJsonValue(rows.metric7Input, "metric7Input"),
        metric8Input: selectedJsonValue(rows.metric8Input, "metric8Input"),
        metric9Input: selectedJsonValue(rows.metric9Input, "metric9Input"),
      })
      .from(rows)
      .orderBy(...ordering),
  );
}

type DeduplicatedRows = ReturnType<typeof deduplicateUnits>;

function unitIdentityExpressions(
  units: AggregateUnitColumns,
  unit: ArchiveAggregationUnit,
): SQLWrapper[] {
  switch (unit) {
    case "item":
      return [units.itemId];
    case "revision":
      return [units.itemId, units.revisionId];
    case "observation":
      return [units.commitId, units.ordinal];
    case "relation":
      return [units.relationId];
  }
}

function aggregationGroupingColumns(
  rows: DeduplicatedRows,
  input: AggregationInput,
): SQL[] {
  const slots: readonly (readonly [SQLWrapper, SQLWrapper])[] = [
    [
      rows.group0Status,
      input.groupBy[0]?.type === "timeBucket"
        ? rows.group0BucketStart
        : rows.group0Value,
    ],
    [
      rows.group1Status,
      input.groupBy[1]?.type === "timeBucket"
        ? rows.group1BucketStart
        : rows.group1Value,
    ],
    [
      rows.group2Status,
      input.groupBy[2]?.type === "timeBucket"
        ? rows.group2BucketStart
        : rows.group2Value,
    ],
    [
      rows.group3Status,
      input.groupBy[3]?.type === "timeBucket"
        ? rows.group3BucketStart
        : rows.group3Value,
    ],
    [
      rows.group4Status,
      input.groupBy[4]?.type === "timeBucket"
        ? rows.group4BucketStart
        : rows.group4Value,
    ],
  ];
  return slots
    .slice(0, input.groupBy.length)
    .flatMap(([status, value]) => [sql`${status}`, sql`${value}`]);
}

function numericInput(value: SQLWrapper): SQL<string | null> {
  // 在 PostgreSQL 本地确认 JSON 数字，再以 numeric 保留聚合、having 和排序的精度。
  return sql`CASE WHEN jsonb_typeof(${value}) = 'number' THEN (${value} #>> '{}')::numeric END`
    .mapWith(String)
    .nullable();
}

function distinctInput(
  value: SQLWrapper,
  metric: ArchiveAggregationMetric,
): SQL {
  const typeCondition =
    metric.op === "distinct" &&
    metric.value.type === "json" &&
    metric.value.valueType !== undefined
      ? sql`jsonb_typeof(${value}) = ${metric.value.valueType}`
      : sql`TRUE`;
  // 缺失和 JSON null 均不计入 distinct；不同选择器类型不会折叠为相同文本。
  return sql`CASE WHEN ${value} IS NOT NULL AND ${value} <> 'null'::jsonb AND ${typeCondition} THEN ${value} END`
    .mapWith(jsonValueDecoder)
    .nullable();
}

function metricExpression(
  metric: ArchiveAggregationMetric,
  value: SQLWrapper,
): SQL {
  switch (metric.op) {
    case "count":
      return count().mapWith(String);
    case "distinct":
      return countDistinct(distinctInput(value, metric)).mapWith(String);
    case "sum":
      return sum(numericInput(value));
    case "avg":
      return avg(numericInput(value));
    case "min":
      return min(numericInput(value));
    case "max":
      return max(numericInput(value));
  }
}

function normalizeDecimal(value: string): string {
  const normalized = value.includes(".")
    ? value.replace(/0+$/u, "").replace(/\.$/u, "")
    : value;
  return /^-0(?:\.0*)?$/u.test(normalized) ? "0" : normalized;
}

function aggregateGroups(
  transaction: ArchiveTransaction,
  deduplicated: DeduplicatedRows,
  input: AggregationInput,
) {
  const grouping = aggregationGroupingColumns(deduplicated, input);
  const metricColumns: readonly SQLWrapper[] = [
    deduplicated.metric0Input,
    deduplicated.metric1Input,
    deduplicated.metric2Input,
    deduplicated.metric3Input,
    deduplicated.metric4Input,
    deduplicated.metric5Input,
    deduplicated.metric6Input,
    deduplicated.metric7Input,
    deduplicated.metric8Input,
    deduplicated.metric9Input,
  ];
  const metrics = input.metrics.map((metric, index) =>
    metricExpression(metric, metricColumns[index]!),
  );
  const groupSelection = groupOutputSelection(deduplicated, input);
  const aggregateSelection = {
    ...groupSelection,
    metric0Value: selectedNullableText(
      metrics[0] ?? sql`NULL::text`,
      "metric0Value",
    ),
    metric1Value: selectedNullableText(
      metrics[1] ?? sql`NULL::text`,
      "metric1Value",
    ),
    metric2Value: selectedNullableText(
      metrics[2] ?? sql`NULL::text`,
      "metric2Value",
    ),
    metric3Value: selectedNullableText(
      metrics[3] ?? sql`NULL::text`,
      "metric3Value",
    ),
    metric4Value: selectedNullableText(
      metrics[4] ?? sql`NULL::text`,
      "metric4Value",
    ),
    metric5Value: selectedNullableText(
      metrics[5] ?? sql`NULL::text`,
      "metric5Value",
    ),
    metric6Value: selectedNullableText(
      metrics[6] ?? sql`NULL::text`,
      "metric6Value",
    ),
    metric7Value: selectedNullableText(
      metrics[7] ?? sql`NULL::text`,
      "metric7Value",
    ),
    metric8Value: selectedNullableText(
      metrics[8] ?? sql`NULL::text`,
      "metric8Value",
    ),
    metric9Value: selectedNullableText(
      metrics[9] ?? sql`NULL::text`,
      "metric9Value",
    ),
  };
  const aggregationQuery =
    grouping.length === 0
      ? transaction.select(aggregateSelection).from(deduplicated)
      : transaction
          .select(aggregateSelection)
          .from(deduplicated)
          .groupBy(...grouping);
  return transaction.$with("aggregation_grouped").as(aggregationQuery);
}

function groupOutputSelection(rows: DeduplicatedRows, input: AggregationInput) {
  return {
    group0Status: selectedText(
      input.groupBy[0] ? rows.group0Status : sql`'unused'::text`,
      "group0Status",
    ),
    group0Value: selectedJsonValue(
      input.groupBy[0] !== undefined && input.groupBy[0].type !== "timeBucket"
        ? rows.group0Value
        : sql`NULL::jsonb`,
      "group0Value",
    ),
    group0BucketStart: selectedTimestamp(
      input.groupBy[0]?.type === "timeBucket"
        ? rows.group0BucketStart
        : sql`NULL::timestamptz`,
      "group0BucketStart",
    ),
    group0BucketEnd: selectedTimestamp(
      input.groupBy[0]?.type === "timeBucket"
        ? min(rows.group0BucketEnd)
        : sql`NULL::timestamptz`,
      "group0BucketEnd",
    ),
    group1Status: selectedText(
      input.groupBy[1] ? rows.group1Status : sql`'unused'::text`,
      "group1Status",
    ),
    group1Value: selectedJsonValue(
      input.groupBy[1] !== undefined && input.groupBy[1].type !== "timeBucket"
        ? rows.group1Value
        : sql`NULL::jsonb`,
      "group1Value",
    ),
    group1BucketStart: selectedTimestamp(
      input.groupBy[1]?.type === "timeBucket"
        ? rows.group1BucketStart
        : sql`NULL::timestamptz`,
      "group1BucketStart",
    ),
    group1BucketEnd: selectedTimestamp(
      input.groupBy[1]?.type === "timeBucket"
        ? min(rows.group1BucketEnd)
        : sql`NULL::timestamptz`,
      "group1BucketEnd",
    ),
    group2Status: selectedText(
      input.groupBy[2] ? rows.group2Status : sql`'unused'::text`,
      "group2Status",
    ),
    group2Value: selectedJsonValue(
      input.groupBy[2] !== undefined && input.groupBy[2].type !== "timeBucket"
        ? rows.group2Value
        : sql`NULL::jsonb`,
      "group2Value",
    ),
    group2BucketStart: selectedTimestamp(
      input.groupBy[2]?.type === "timeBucket"
        ? rows.group2BucketStart
        : sql`NULL::timestamptz`,
      "group2BucketStart",
    ),
    group2BucketEnd: selectedTimestamp(
      input.groupBy[2]?.type === "timeBucket"
        ? min(rows.group2BucketEnd)
        : sql`NULL::timestamptz`,
      "group2BucketEnd",
    ),
    group3Status: selectedText(
      input.groupBy[3] ? rows.group3Status : sql`'unused'::text`,
      "group3Status",
    ),
    group3Value: selectedJsonValue(
      input.groupBy[3] !== undefined && input.groupBy[3].type !== "timeBucket"
        ? rows.group3Value
        : sql`NULL::jsonb`,
      "group3Value",
    ),
    group3BucketStart: selectedTimestamp(
      input.groupBy[3]?.type === "timeBucket"
        ? rows.group3BucketStart
        : sql`NULL::timestamptz`,
      "group3BucketStart",
    ),
    group3BucketEnd: selectedTimestamp(
      input.groupBy[3]?.type === "timeBucket"
        ? min(rows.group3BucketEnd)
        : sql`NULL::timestamptz`,
      "group3BucketEnd",
    ),
    group4Status: selectedText(
      input.groupBy[4] ? rows.group4Status : sql`'unused'::text`,
      "group4Status",
    ),
    group4Value: selectedJsonValue(
      input.groupBy[4] !== undefined && input.groupBy[4].type !== "timeBucket"
        ? rows.group4Value
        : sql`NULL::jsonb`,
      "group4Value",
    ),
    group4BucketStart: selectedTimestamp(
      input.groupBy[4]?.type === "timeBucket"
        ? rows.group4BucketStart
        : sql`NULL::timestamptz`,
      "group4BucketStart",
    ),
    group4BucketEnd: selectedTimestamp(
      input.groupBy[4]?.type === "timeBucket"
        ? min(rows.group4BucketEnd)
        : sql`NULL::timestamptz`,
      "group4BucketEnd",
    ),
  };
}

function compileHaving(
  having: ArchiveAggregationHaving,
  grouped: ReturnType<typeof aggregateGroups>,
  metricIndex: ReadonlyMap<string, number>,
): SQL {
  if (having.type === "and" || having.type === "or") {
    const conditions = having.conditions.map((condition) =>
      compileHaving(condition, grouped, metricIndex),
    );
    return (having.type === "and" ? and(...conditions) : or(...conditions))!;
  }
  if (having.type === "not") {
    return not(compileHaving(having.condition, grouped, metricIndex))!;
  }
  const index = metricIndex.get(having.metric);
  if (index === undefined) throw new Error("having 指标未在请求中声明。");
  const metricColumns: readonly SQLWrapper[] = [
    grouped.metric0Value,
    grouped.metric1Value,
    grouped.metric2Value,
    grouped.metric3Value,
    grouped.metric4Value,
    grouped.metric5Value,
    grouped.metric6Value,
    grouped.metric7Value,
    grouped.metric8Value,
    grouped.metric9Value,
  ];
  const value = metricColumns[index]!;
  if (having.operator === "isNull") return isNull(value);
  if (having.operator === "isNotNull") return isNotNull(value);
  if (!("value" in having)) throw new Error("having 数值比较缺少阈值。");
  const numericValue = sql`${value}::numeric`;
  const parameter = sql`${having.value}::numeric`;
  switch (having.operator) {
    case "eq":
      return eq(numericValue, parameter);
    case "ne":
      return ne(numericValue, parameter);
    case "gt":
      return gt(numericValue, parameter);
    case "gte":
      return gte(numericValue, parameter);
    case "lt":
      return lt(numericValue, parameter);
    case "lte":
      return lte(numericValue, parameter);
  }
}

function metricSortColumn(
  grouped: ReturnType<typeof aggregateGroups>,
  index: number,
): SQLWrapper {
  const columns: readonly SQLWrapper[] = [
    grouped.metric0Value,
    grouped.metric1Value,
    grouped.metric2Value,
    grouped.metric3Value,
    grouped.metric4Value,
    grouped.metric5Value,
    grouped.metric6Value,
    grouped.metric7Value,
    grouped.metric8Value,
    grouped.metric9Value,
  ];
  return columns[index]!;
}

function groupSortColumns(
  grouped: ReturnType<typeof aggregateGroups>,
  input: AggregationInput,
  index: number,
): readonly SQLWrapper[] {
  const status: readonly SQLWrapper[] = [
    grouped.group0Status,
    grouped.group1Status,
    grouped.group2Status,
    grouped.group3Status,
    grouped.group4Status,
  ];
  const value: readonly SQLWrapper[] = [
    grouped.group0Value,
    grouped.group1Value,
    grouped.group2Value,
    grouped.group3Value,
    grouped.group4Value,
  ];
  const start: readonly SQLWrapper[] = [
    grouped.group0BucketStart,
    grouped.group1BucketStart,
    grouped.group2BucketStart,
    grouped.group3BucketStart,
    grouped.group4BucketStart,
  ];
  return [
    status[index]!,
    input.groupBy[index]?.type === "timeBucket" ? start[index]! : value[index]!,
  ];
}

function orderingForGroups(
  grouped: ReturnType<typeof aggregateGroups>,
  input: AggregationInput,
): SQL[] {
  const order: SQL[] = [];
  for (const requested of input.orderBy) {
    const metricIndex = input.metrics.findIndex(
      ({ key }) => key === requested.key,
    );
    if (metricIndex >= 0) {
      const value = sql`${metricSortColumn(grouped, metricIndex)}::numeric`;
      order.push(
        sql`${requested.direction === "asc" ? asc(value) : desc(value)} NULLS LAST`,
      );
      continue;
    }
    const groupIndex = input.groupBy.findIndex(
      ({ key }) => key === requested.key,
    );
    for (const [columnIndex, column] of groupSortColumns(
      grouped,
      input,
      groupIndex,
    ).entries()) {
      order.push(
        columnIndex === 0
          ? asc(column)
          : requested.direction === "asc"
            ? asc(column)
            : desc(column),
      );
    }
  }
  for (let index = 0; index < input.groupBy.length; index += 1) {
    const columns = groupSortColumns(grouped, input, index);
    for (const column of columns) {
      order.push(asc(column));
    }
  }
  return order;
}

function groupResultColumns(row: {
  readonly group0Status: string;
  readonly group0Value: unknown;
  readonly group0BucketStart: Date | null;
  readonly group0BucketEnd: Date | null;
  readonly group1Status: string;
  readonly group1Value: unknown;
  readonly group1BucketStart: Date | null;
  readonly group1BucketEnd: Date | null;
  readonly group2Status: string;
  readonly group2Value: unknown;
  readonly group2BucketStart: Date | null;
  readonly group2BucketEnd: Date | null;
  readonly group3Status: string;
  readonly group3Value: unknown;
  readonly group3BucketStart: Date | null;
  readonly group3BucketEnd: Date | null;
  readonly group4Status: string;
  readonly group4Value: unknown;
  readonly group4BucketStart: Date | null;
  readonly group4BucketEnd: Date | null;
}) {
  return [
    {
      status: row.group0Status,
      value: row.group0Value,
      start: row.group0BucketStart,
      end: row.group0BucketEnd,
    },
    {
      status: row.group1Status,
      value: row.group1Value,
      start: row.group1BucketStart,
      end: row.group1BucketEnd,
    },
    {
      status: row.group2Status,
      value: row.group2Value,
      start: row.group2BucketStart,
      end: row.group2BucketEnd,
    },
    {
      status: row.group3Status,
      value: row.group3Value,
      start: row.group3BucketStart,
      end: row.group3BucketEnd,
    },
    {
      status: row.group4Status,
      value: row.group4Value,
      start: row.group4BucketStart,
      end: row.group4BucketEnd,
    },
  ] as const;
}

function metricResultColumns(row: {
  readonly metric0Value: string | null;
  readonly metric1Value: string | null;
  readonly metric2Value: string | null;
  readonly metric3Value: string | null;
  readonly metric4Value: string | null;
  readonly metric5Value: string | null;
  readonly metric6Value: string | null;
  readonly metric7Value: string | null;
  readonly metric8Value: string | null;
  readonly metric9Value: string | null;
}) {
  return [
    row.metric0Value,
    row.metric1Value,
    row.metric2Value,
    row.metric3Value,
    row.metric4Value,
    row.metric5Value,
    row.metric6Value,
    row.metric7Value,
    row.metric8Value,
    row.metric9Value,
  ] as const;
}

async function validateTimeZones(
  transaction: ArchiveTransaction,
  input: AggregationInput,
): Promise<(string | number)[] | undefined> {
  const buckets = input.groupBy.flatMap((grouping, index) =>
    grouping.type === "timeBucket"
      ? [
          {
            key: grouping.key,
            timeZone: grouping.timeZone,
            path: ["groupBy", index, "timeZone"],
          },
        ]
      : [],
  );
  const zones = [...new Set(buckets.map(({ timeZone }) => timeZone))];
  if (zones.length === 0) return undefined;
  const knownZones = await transaction
    .select({ name: postgresTimeZones.name })
    .from(postgresTimeZones)
    .where(inArray(postgresTimeZones.name, zones));
  const known = new Set(knownZones.map(({ name }) => name));
  return buckets.find(({ timeZone }) => !known.has(timeZone))?.path;
}

function aggregationSelection(grouped: ReturnType<typeof aggregateGroups>) {
  return {
    group0Status: grouped.group0Status,
    group0Value: grouped.group0Value,
    group0BucketStart: grouped.group0BucketStart,
    group0BucketEnd: grouped.group0BucketEnd,
    group1Status: grouped.group1Status,
    group1Value: grouped.group1Value,
    group1BucketStart: grouped.group1BucketStart,
    group1BucketEnd: grouped.group1BucketEnd,
    group2Status: grouped.group2Status,
    group2Value: grouped.group2Value,
    group2BucketStart: grouped.group2BucketStart,
    group2BucketEnd: grouped.group2BucketEnd,
    group3Status: grouped.group3Status,
    group3Value: grouped.group3Value,
    group3BucketStart: grouped.group3BucketStart,
    group3BucketEnd: grouped.group3BucketEnd,
    group4Status: grouped.group4Status,
    group4Value: grouped.group4Value,
    group4BucketStart: grouped.group4BucketStart,
    group4BucketEnd: grouped.group4BucketEnd,
    metric0Value: grouped.metric0Value,
    metric1Value: grouped.metric1Value,
    metric2Value: grouped.metric2Value,
    metric3Value: grouped.metric3Value,
    metric4Value: grouped.metric4Value,
    metric5Value: grouped.metric5Value,
    metric6Value: grouped.metric6Value,
    metric7Value: grouped.metric7Value,
    metric8Value: grouped.metric8Value,
    metric9Value: grouped.metric9Value,
  };
}

async function readAggregationPage(
  transaction: ArchiveTransaction,
  snapshot: ResolvedSnapshot,
  input: AggregationInput,
  offset: number,
  queryHash: string,
): Promise<ArchiveAggregationOperation<ArchiveAggregationResult>> {
  const matchedQuery = buildArchiveMatchedQuery(
    transaction,
    snapshot,
    input,
    true,
  );
  const { matched } = matchedQuery;
  const units = createUnitRows(transaction, matchedQuery, input);
  const prepared = prepareAggregationRows(transaction, units, input);
  const deduplicated = deduplicateUnits(transaction, prepared, input);
  const grouped = aggregateGroups(transaction, deduplicated, input);
  const metricIndex = new Map(
    input.metrics.map((metric, index) => [metric.key, index] as const),
  );
  const orderBy = orderingForGroups(grouped, input);
  const having =
    input.having === undefined
      ? undefined
      : compileHaving(input.having, grouped, metricIndex);
  const query = transaction
    .with(matchedQuery.latest, matched, units, prepared, deduplicated, grouped)
    .select(aggregationSelection(grouped))
    .from(grouped)
    .where(having)
    .orderBy(...orderBy)
    .limit(input.limit + 1)
    .offset(offset);
  const rows = await query;
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const groups = page.map((row) => {
    const keyColumns = groupResultColumns(row);
    const metricColumns = metricResultColumns(row);
    return {
      keys: input.groupBy.map((grouping, index) => {
        const value = keyColumns[index]!;
        const result =
          value.status === "missing"
            ? { status: "missing" as const }
            : grouping.type === "timeBucket"
              ? {
                  status: "bucket" as const,
                  start: value.start!.toISOString(),
                  end: value.end!.toISOString(),
                }
              : { status: "value" as const, value: value.value };
        return { key: grouping.key, result };
      }),
      metrics: input.metrics.map((metric, index) => {
        const value = metricColumns[index] ?? null;
        return {
          key: metric.key,
          op: metric.op,
          value:
            value !== null &&
            (metric.op === "sum" ||
              metric.op === "avg" ||
              metric.op === "min" ||
              metric.op === "max")
              ? normalizeDecimal(value)
              : value,
        };
      }),
    };
  });
  const nextOffset = offset + input.limit;
  const nextCursor = hasMore
    ? encodeAggregationCursor({
        version: 1,
        queryHash,
        snapshot,
        offset: nextOffset,
      })
    : undefined;
  return {
    ok: true,
    value: archiveAggregationResultSchema.parse({
      unit: input.unit,
      scope: input.scope,
      snapshot,
      timeBuckets: input.groupBy.flatMap((grouping) =>
        grouping.type === "timeBucket"
          ? [
              {
                key: grouping.key,
                field: grouping.field,
                grain: grouping.grain,
                timeZone: grouping.timeZone,
                boundary: "[start,end)",
              },
            ]
          : [],
      ),
      groups,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
  };
}

export function createArchiveAggregationOperation(
  database: Database,
): Pick<ArchiveOperations, "aggregateArchive"> {
  return {
    async aggregateArchive(
      request: ArchiveAggregationRequest,
    ): Promise<ArchiveAggregationOperation<ArchiveAggregationResult>> {
      const checked = archiveAggregationInputSchema.safeParse(request);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return {
          ok: false,
          status: 400,
          error: {
            code: "invalid_input",
            message: issue?.message ?? "归档聚合请求格式无效。",
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

      const input = checked.data;
      const { cursor: requestedCursor, ...queryInput } = input;
      const queryHash = createHash("sha256")
        .update(canonicalJson(queryInput))
        .digest("hex");
      const decodedCursor =
        requestedCursor === undefined
          ? undefined
          : decodeAggregationCursor(requestedCursor);
      const requestedAsOf =
        "asOf" in input.scope ? input.scope.asOf : undefined;
      const expectedMode = requestedAsOf === undefined ? "current" : "asOf";
      if (
        requestedCursor !== undefined &&
        (decodedCursor === undefined ||
          decodedCursor.queryHash !== queryHash ||
          decodedCursor.snapshot.mode !== expectedMode ||
          (requestedAsOf !== undefined &&
            decodedCursor.snapshot.asOf !== requestedAsOf))
      ) {
        return invalidAggregationCursor();
      }

      const regexPatterns = searchRegexPatterns({
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.where === undefined ? {} : { where: input.where }),
        ...(input.relations === undefined
          ? {}
          : { relations: input.relations }),
      });
      try {
        return await database.transaction(
          async (transaction) => {
            // 时区、正则和聚合各条 PostgreSQL 语句均单独受此超时限制。
            await transaction.execute(
              sql`SELECT set_config('statement_timeout', ${String(input.budgetMs) + "ms"}, true)`,
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
            const timeZonePath = await validateTimeZones(transaction, input);
            if (timeZonePath !== undefined) {
              return {
                ok: false,
                status: 400,
                error: {
                  code: "invalid_input",
                  message: "时间分桶时区无效。",
                  path: timeZonePath,
                },
              };
            }
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
            return readAggregationPage(
              transaction,
              fixedSnapshot,
              input,
              decodedCursor?.offset ?? 0,
              queryHash,
            );
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (databaseErrorCode(error) === "57014") {
          return {
            ok: false,
            status: 422,
            error: {
              code: "query_budget_exceeded",
              message: "聚合超过请求预算，未返回部分分组。",
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
