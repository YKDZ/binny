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
  type ArchiveSearchRequest,
  type ArchiveSearchTargetFilter,
  type ArchiveSearchText,
} from "@binny/contracts";
import type postgres from "postgres";

import { canonicalJson, isoTimestamp, optionalText } from "./archive-common.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import { resolveSnapshot, type ResolvedSnapshot } from "./archive-read.ts";
import type { CoreDatabase } from "./database.ts";

type SearchCursor = {
  readonly version: 1 | 2;
  readonly queryHash: string;
  readonly snapshot: ResolvedSnapshot;
  readonly resultId: string;
};

type SearchResultRow = {
  readonly cursor_missing: false;
  readonly result_id: string;
  readonly result_unit: "item" | "revision" | "observation";
  readonly item_id: string;
  readonly root_revision_id: string | null;
  readonly root_commit_id: string | null;
  readonly root_ordinal: number | null;
  readonly namespace: string;
  readonly source_key: string;
  readonly bin_id: string;
  readonly revision_id: string;
  readonly archive_seq: string;
  readonly run_id: string | null;
  readonly collector_version: string | null;
  readonly source_ref: string | null;
  readonly source_modified_at: string | null;
  readonly completeness: "complete" | "partial" | null;
  readonly observed_at: Date;
  readonly recorded_at: Date;
  readonly hit_start: number | null;
  readonly hit_end: number | null;
  readonly context_start: number | null;
  readonly context_end: number | null;
  readonly context_text: string | null;
  readonly json_projections: unknown;
};

type SearchRow = SearchResultRow | { readonly cursor_missing: true };

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
    if (!("queryHash" in value) || typeof value.queryHash !== "string")
      return undefined;
    if (!/^[a-f0-9]{64}$/u.test(value.queryHash)) return undefined;
    if (!("snapshot" in value) || typeof value.snapshot !== "object")
      return undefined;
    const snapshot = value.snapshot;
    if (snapshot === null || !("asOf" in snapshot) || !("mode" in snapshot))
      return undefined;
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
      if (!("sortValues" in value) || !Array.isArray(value.sortValues))
        return undefined;
      if (
        value.sortValues.some(
          (entry) =>
            entry !== null && !postgresTextSchema.safeParse(entry).success,
        )
      ) {
        return undefined;
      }
    }
    if (!("resultId" in value) || typeof value.resultId !== "string")
      return undefined;
    if (
      value.resultId.length === 0 ||
      value.resultId.length > 128 ||
      !postgresTextSchema.safeParse(value.resultId).success
    )
      return undefined;
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

type SearchFieldExpression = {
  readonly sql: string;
  readonly kind: "text" | "timestamp";
};

type SearchViewAliases = {
  readonly item: string;
  readonly revision: string;
  readonly latest: string;
};

function searchFieldExpression(
  field: ArchiveSearchField,
  aliases: SearchViewAliases = {
    item: "item",
    revision: "revision",
    latest: "latest",
  },
): SearchFieldExpression {
  switch (field) {
    case "sourceKey.namespace":
      return { sql: aliases.item + ".namespace", kind: "text" };
    case "sourceKey.key":
      return { sql: aliases.item + ".source_key", kind: "text" };
    case "sourceRef":
      return {
        sql: aliases.revision + ".state_data->>'sourceRef'",
        kind: "text",
      };
    case "sourceModifiedAt":
      return {
        sql:
          "(" +
          aliases.revision +
          ".state_data->>'sourceModifiedAt')::timestamptz",
        kind: "timestamp",
      };
    case "capture.completeness":
      return {
        sql: aliases.revision + ".state_data->'capture'->>'completeness'",
        kind: "text",
      };
    case "body.searchText":
      return {
        sql: aliases.revision + ".state_data->'body'->>'searchText'",
        kind: "text",
      };
    case "binId":
      return { sql: aliases.latest + ".bin_id", kind: "text" };
    case "runId":
      return { sql: aliases.latest + ".run_id", kind: "text" };
    case "collectorVersion":
      return { sql: aliases.latest + ".collector_version", kind: "text" };
    case "observedAt":
      return { sql: aliases.latest + ".observed_at", kind: "timestamp" };
    case "recordedAt":
      return { sql: aliases.latest + ".recorded_at", kind: "timestamp" };
  }
}

function searchJsonPathExpression(
  stateExpression: string,
  field: ArchiveSearchJsonProjection["field"],
  path: readonly (string | number)[],
  bind: (value: postgres.JSONValue) => string,
): string {
  let expression = `(${stateExpression}->'${field}')`;
  for (const segment of path) {
    const indexType = typeof segment === "number";
    expression = `(${expression} -> ${bind(String(segment))}::${indexType ? "integer" : "text"})`;
  }
  return expression;
}

function searchJsonValueParameter(
  value: unknown,
  bind: (value: postgres.JSONValue | postgres.Parameter) => string,
  jsonParameter: (value: postgres.JSONValue) => postgres.Parameter,
): string {
  if (value === null) return "'null'::jsonb";
  return bind(jsonParameter(value as postgres.JSONValue)) + "::jsonb";
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

type SearchResult = ReturnType<
  typeof archiveSearchPageSchema.parse
>["results"][number];
type SearchMatch = SearchResult["matches"][number];
type SearchExpansion = NonNullable<SearchMatch["expansions"]>[number];
type SearchExpansionRelation = SearchExpansion["relations"][number];

type SearchExpansionRow = {
  readonly result_id: string;
  readonly bin_id: string;
  readonly relation_id: string;
  readonly direction: "outgoing" | "incoming";
  readonly status: "observed" | "withdrawn" | "deleted";
  readonly from_item_id: string | null;
  readonly from_namespace: string | null;
  readonly from_source_key: string | null;
  readonly from_revision_id: string | null;
  readonly target_item_id: string | null;
  readonly target_source_ref: string | null;
  readonly target_namespace: string | null;
  readonly target_source_key: string | null;
  readonly target_revision_id: string | null;
  readonly relation_revision_id: string | null;
  readonly state_data: unknown;
  readonly relation_commit_id: string;
  readonly relation_archive_seq: string;
  readonly relation_ordinal: number;
  readonly relation_observed_at: Date;
  readonly relation_recorded_at: Date;
  readonly relation_run_id: string | null;
  readonly relation_collector_version: string | null;
};

type SearchRegexPattern = {
  readonly pattern: string;
  readonly path: (string | number)[];
};

function searchRegexPatterns(
  input: ReturnType<typeof archiveSearchInputSchema.parse>,
): SearchRegexPattern[] {
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
  // PostgreSQL 的 2201B 只标识整条查询；多正则需分别交给 ARE 校验才能定位字段。
  for (const { pattern, path } of patterns) {
    try {
      await transaction.savepoint(async (savepoint) => {
        await savepoint`SELECT ''::text ~ ${pattern}::text`;
      });
    } catch (error) {
      if (postgresErrorCode(error) === "2201B") return path;
      throw error;
    }
  }
  return undefined;
}

async function readCurrentSearchPage(
  transaction: ArchiveTransaction,
  snapshot: ResolvedSnapshot,
  input: ReturnType<typeof archiveSearchInputSchema.parse>,
  cursor: SearchCursor | undefined,
  queryHash: string,
): Promise<
  ArchiveSearchOperation<ReturnType<typeof archiveSearchPageSchema.parse>>
> {
  const parameters: (postgres.JSONValue | postgres.Parameter)[] = [];
  const bind = (value: postgres.JSONValue | postgres.Parameter): string => {
    parameters.push(value);
    return "$" + parameters.length.toString(10);
  };
  const asOf = bind(snapshot.asOf);
  const binPredicate =
    input.scope.binId === undefined
      ? ""
      : " AND commit.bin_id = " + bind(input.scope.binId) + "::text";
  const textConditions: {
    readonly predicate: string;
    readonly hitPredicate: string;
    readonly hitStart: string;
    readonly hitEnd: string;
  }[] = [];
  const rootAliases: SearchViewAliases = {
    item: "item",
    revision: "revision",
    latest: "latest",
  };
  const compileText = (
    text: ArchiveSearchText,
    aliases: SearchViewAliases,
    includeRootHit: boolean,
  ): string => {
    const searchTextExpression =
      aliases.revision + ".state_data->'body'->>'searchText'";
    let predicate: string;
    let hitPredicate: string;
    let hitStart: string;
    let hitEnd: string;
    if (text.kind === "literal") {
      const value = includeRootHit ? bind(text.value) : "";
      const pattern = bind("%" + escapeLikeLiteral(text.value) + "%");
      predicate =
        searchTextExpression +
        " IS NOT NULL AND " +
        searchTextExpression +
        " LIKE " +
        pattern +
        " ESCAPE E'\\\\'";
      hitPredicate =
        "search_text IS NOT NULL AND search_text LIKE " +
        pattern +
        " ESCAPE E'\\\\'";
      hitStart = includeRootHit
        ? "strpos(search_text, " + value + ") - 1"
        : "NULL::integer";
      hitEnd = includeRootHit
        ? "hit_start + char_length(" + value + ")"
        : "NULL::integer";
    } else {
      const pattern = bind(text.pattern);
      predicate =
        searchTextExpression +
        " IS NOT NULL AND " +
        searchTextExpression +
        " ~ " +
        pattern;
      hitPredicate = "search_text IS NOT NULL AND search_text ~ " + pattern;
      hitStart = includeRootHit
        ? "regexp_instr(search_text, " + pattern + ", 1, 1, 0, 'c') - 1"
        : "NULL::integer";
      hitEnd = includeRootHit
        ? "regexp_instr(search_text, " + pattern + ", 1, 1, 1, 'c') - 1"
        : "NULL::integer";
    }
    if (includeRootHit) {
      textConditions.push({ predicate, hitPredicate, hitStart, hitEnd });
    }
    return "(" + predicate + ")";
  };
  const compileJsonFilter = (
    filter: ArchiveSearchJsonFilter,
    stateExpression: string,
    bindParameter: (
      value: postgres.JSONValue | postgres.Parameter,
    ) => string = bind,
  ): string => {
    const expression = searchJsonPathExpression(
      stateExpression,
      filter.field,
      filter.path,
      (value) => bindParameter(value),
    );
    if (filter.operator === "exists") {
      return expression + (filter.value === true ? " IS NOT NULL" : " IS NULL");
    }
    if (filter.valueType === undefined) {
      throw new Error("JSON 路径比较缺少预期类型。");
    }
    const valueType = filter.valueType;
    const matchesType = `jsonb_typeof(${expression}) = ${bindParameter(valueType)}::text`;
    const comparedExpression =
      valueType === "string"
        ? `(${expression} #>> '{}') COLLATE "C"`
        : expression;
    const parameter = (value: unknown): string =>
      valueType === "string"
        ? bindParameter(String(value)) + '::text COLLATE "C"'
        : searchJsonValueParameter(value, bindParameter, (jsonValue) =>
            transaction.json(jsonValue),
          );
    if (filter.operator === "in" || filter.operator === "notIn") {
      const values = (filter.values ?? []).map(parameter).join(", ");
      return (
        "COALESCE((" +
        matchesType +
        " AND " +
        comparedExpression +
        (filter.operator === "in" ? " IN (" : " NOT IN (") +
        values +
        ")), FALSE)"
      );
    }
    if (filter.operator === "between") {
      return (
        "COALESCE((" +
        matchesType +
        " AND " +
        comparedExpression +
        " >= " +
        parameter(filter.lower) +
        " AND " +
        comparedExpression +
        " <= " +
        parameter(filter.upper) +
        "), FALSE)"
      );
    }
    const operator = {
      eq: "=",
      ne: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    }[filter.operator];
    return (
      "COALESCE((" +
      matchesType +
      " AND " +
      comparedExpression +
      " " +
      operator +
      " " +
      parameter(filter.value) +
      "), FALSE)"
    );
  };
  const compileFilter = (
    filter: ArchiveSearchFilter | ArchiveSearchTargetFilter,
    aliases: SearchViewAliases = rootAliases,
    includeRootHit = true,
  ): string => {
    if (filter.type === "and" || filter.type === "or") {
      const operator = filter.type === "and" ? " AND " : " OR ";
      return (
        "(" +
        filter.conditions
          .map((condition) => compileFilter(condition, aliases, includeRootHit))
          .join(operator) +
        ")"
      );
    }
    if (filter.type === "not")
      return (
        "NOT (" + compileFilter(filter.condition, aliases, includeRootHit) + ")"
      );
    if (filter.type === "text")
      return compileText(filter.text, aliases, includeRootHit);
    if (filter.type === "json") {
      return compileJsonFilter(filter, aliases.revision + ".state_data");
    }

    if (filter.type === "relation") {
      const relatedItemId =
        filter.direction === "outgoing"
          ? "relation_filter.target_item_id"
          : filter.direction === "incoming"
            ? "relation_filter.from_item_id"
            : `CASE
                WHEN relation_filter.from_item_id = ${aliases.item}.item_id
                THEN relation_filter.target_item_id
                ELSE relation_filter.from_item_id
              END`;
      const relatedSourceRef =
        filter.direction === "outgoing"
          ? "relation_filter.target_source_ref"
          : filter.direction === "incoming"
            ? "NULL::text"
            : `CASE
                WHEN relation_filter.from_item_id = ${aliases.item}.item_id
                THEN relation_filter.target_source_ref
                ELSE NULL::text
              END`;
      const relationConditions = [
        filter.direction === "outgoing"
          ? `relation_filter.from_item_id = ${aliases.item}.item_id`
          : filter.direction === "incoming"
            ? `relation_filter.target_item_id = ${aliases.item}.item_id`
            : `(relation_filter.from_item_id = ${aliases.item}.item_id OR relation_filter.target_item_id = ${aliases.item}.item_id)`,
        `relation_filter.created_seq <= ${asOf}::bigint`,
        ...(filter.name === undefined
          ? []
          : [
              `relation_revision.state_data->>'name' COLLATE "C" = ${bind(filter.name)}::text COLLATE "C"`,
            ]),
        ...(filter.properties === undefined
          ? []
          : [
              compileJsonFilter(
                filter.properties,
                "relation_revision.state_data",
              ),
            ]),
      ];
      const relationFrom = `
        FROM archive_relation AS relation_filter
        JOIN LATERAL (
          SELECT observation.relation_revision_id
          FROM archive_relation_observation AS observation
          WHERE observation.relation_id = relation_filter.relation_id
            AND observation.bin_id = ${aliases.latest}.bin_id
            AND observation.archive_seq <= ${asOf}::bigint
          ORDER BY
            observation.archive_seq DESC,
            observation.ordinal DESC,
            observation.commit_id DESC
          LIMIT 1
        ) AS relation_latest
          ON relation_latest.relation_revision_id IS NOT NULL
        JOIN archive_relation_revision AS relation_revision
          ON relation_revision.relation_id = relation_filter.relation_id
          AND relation_revision.relation_revision_id = relation_latest.relation_revision_id
        ${
          filter.target === undefined
            ? ""
            : `
        JOIN LATERAL (
          SELECT
            observation.revision_id,
            commit.bin_id,
            commit.run_id,
            commit.collector_version,
            commit.observed_at,
            commit.recorded_at
          FROM archive_observation AS observation
          JOIN archive_commit AS commit
            ON commit.commit_id = observation.commit_id
          WHERE observation.item_id = ${relatedItemId}
            AND commit.bin_id = ${aliases.latest}.bin_id
            AND commit.archive_seq <= ${asOf}::bigint
          ORDER BY
            commit.archive_seq DESC,
            observation.ordinal DESC,
            commit.commit_id DESC
          LIMIT 1
        ) AS target_latest
          ON ${relatedItemId} IS NOT NULL
        JOIN archive_item AS target_item
          ON target_item.item_id = ${relatedItemId}
        JOIN archive_revision AS target_revision
          ON target_revision.item_id = target_item.item_id
          AND target_revision.revision_id = target_latest.revision_id
        `
        }
      `;
      const relationPredicate = relationConditions.join(" AND ");
      const targetPredicate =
        filter.target === undefined
          ? "TRUE"
          : compileFilter(
              filter.target,
              {
                item: "target_item",
                revision: "target_revision",
                latest: "target_latest",
              },
              false,
            );
      const matchingRelations = `SELECT
          ${relatedItemId} AS target_item_id,
          ${relatedSourceRef} AS target_source_ref
        ${relationFrom}
        WHERE ${relationPredicate} AND (${targetPredicate})`;
      if (filter.operator === "exists") {
        return `EXISTS (SELECT 1 FROM (${matchingRelations}) AS matching_relation)`;
      }
      if (filter.operator === "notExists") {
        return `NOT EXISTS (SELECT 1 FROM (${matchingRelations}) AS matching_relation)`;
      }
      const count = filter.count;
      if (count === undefined) {
        throw new Error("关系数量条件缺少比较符和值。");
      }
      const countOperator = {
        eq: "=",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      }[count.operator];
      return `(SELECT count(DISTINCT COALESCE(
          'item:' || matching_relation.target_item_id::text,
          'sourceRef:' || matching_relation.target_source_ref
        )) FROM (${matchingRelations}) AS matching_relation) ${countOperator} ${bind(String(count.value))}::bigint`;
    }

    const field = searchFieldExpression(filter.field, aliases);
    if (filter.operator === "exists") {
      return field.sql + (filter.value === true ? " IS NOT NULL" : " IS NULL");
    }
    const expression =
      field.kind === "text" ? "(" + field.sql + ') COLLATE "C"' : field.sql;
    const parameter = (value: string): string =>
      field.kind === "text"
        ? bind(value) + '::text COLLATE "C"'
        : bind(value) + "::timestamptz";
    const present = field.sql + " IS NOT NULL AND ";
    if (filter.operator === "in" || filter.operator === "notIn") {
      const values = (filter.values ?? []).map(parameter).join(", ");
      return (
        present +
        expression +
        (filter.operator === "in" ? " IN (" : " NOT IN (") +
        values +
        ")"
      );
    }
    if (filter.operator === "between") {
      return (
        present +
        expression +
        " >= " +
        parameter(filter.lower ?? "") +
        " AND " +
        expression +
        " <= " +
        parameter(filter.upper ?? "")
      );
    }
    const operator = {
      eq: "=",
      ne: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    }[filter.operator];
    return (
      present +
      expression +
      " " +
      operator +
      " " +
      parameter(String(filter.value))
    );
  };
  const filters: ArchiveSearchFilter[] = [
    ...(input.text === undefined
      ? []
      : [{ type: "text" as const, text: input.text }]),
    ...(input.where === undefined ? [] : [input.where]),
  ];
  const firstFilter = filters[0];
  if (firstFilter === undefined) {
    throw new Error("搜索条件至少需要一个文本或字段谓词。");
  }
  const queryFilter: ArchiveSearchFilter =
    filters.length === 1 ? firstFilter : { type: "and", conditions: filters };
  const matchPredicate = compileFilter(queryFilter);
  const hitStart =
    textConditions.length === 0
      ? "NULL::integer"
      : "CASE " +
        textConditions
          .map(
            ({ hitPredicate, hitStart: start }) =>
              `WHEN (${hitPredicate}) THEN ${start}`,
          )
          .join(" ") +
        " ELSE NULL::integer END";
  const hitEnd =
    textConditions.length === 0
      ? "NULL::integer"
      : "CASE " +
        textConditions
          .map(
            ({ hitPredicate, hitEnd: end }) =>
              `WHEN (${hitPredicate}) THEN ${end}`,
          )
          .join(" ") +
        " ELSE NULL::integer END";
  const scopeKind = input.scope.kind;
  const resultUnit =
    scopeKind === "revisions"
      ? "revision"
      : scopeKind === "observations"
        ? "observation"
        : "item";
  const distinctOn =
    scopeKind === "revisions"
      ? "observation.item_id, commit.bin_id, observation.revision_id"
      : "observation.item_id, commit.bin_id";
  const sourceOrder =
    scopeKind === "revisions"
      ? "observation.item_id, commit.bin_id, observation.revision_id, "
      : "observation.item_id, commit.bin_id, ";
  const sourceSelection =
    scopeKind === "observations" ? "" : `DISTINCT ON (${distinctOn})`;
  const resultIdExpression =
    resultUnit === "item"
      ? "latest.item_id::text"
      : resultUnit === "revision"
        ? "latest.item_id::text || ':' || latest.revision_id::text"
        : "latest.commit_id::text || ':' || latest.ordinal::text";
  const rootRevisionExpression =
    resultUnit === "revision" ? "min(revision_id::text)" : "NULL::text";
  const rootCommitExpression =
    resultUnit === "observation" ? "min(commit_id::text)" : "NULL::text";
  const rootOrdinalExpression =
    resultUnit === "observation" ? "min(ordinal)" : "NULL::integer";
  type SearchOrder = (typeof input.orderBy)[number];
  type SearchSortKind = "text" | "jsonb";
  type SearchSortExpression = {
    readonly sql: string;
    readonly kind: SearchSortKind;
  };
  const selectSortExpression = (sort: SearchOrder): SearchSortExpression => {
    if (sort.field === "metadata" || sort.field === "properties") {
      if (sort.path === undefined || sort.valueType === undefined) {
        throw new Error("JSON 路径排序缺少路径或预期类型。");
      }
      const expression = searchJsonPathExpression(
        "state_data",
        sort.field,
        sort.path,
        bind,
      );
      const typeName = sort.valueType;
      const value =
        typeName === "number"
          ? `CASE WHEN jsonb_typeof(${expression}) = 'number' THEN ${expression} END`
          : `CASE WHEN jsonb_typeof(${expression}) = '${typeName}' THEN ${expression} #>> '{}' END`;
      return {
        sql: `(array_agg(${value} ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]`,
        kind: typeName === "number" ? "jsonb" : "text",
      };
    }
    const aggregate = (expression: string): string =>
      `(array_agg(${expression} ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]`;
    switch (sort.field) {
      case "itemId":
        return { sql: "item_id::text", kind: "text" };
      case "sourceKey.namespace":
        return { sql: "namespace", kind: "text" };
      case "sourceKey.key":
        return { sql: "source_key", kind: "text" };
      case "sourceRef":
        return { sql: aggregate("source_ref"), kind: "text" };
      case "sourceModifiedAt":
        return { sql: aggregate("source_modified_at"), kind: "text" };
      case "capture.completeness":
        return { sql: aggregate("completeness"), kind: "text" };
      case "binId":
        return { sql: aggregate("bin_id"), kind: "text" };
      case "revisionId":
        return { sql: aggregate("revision_id::text"), kind: "text" };
      case "archiveSeq":
        return { sql: aggregate("lpad(archive_seq, 19, '0')"), kind: "text" };
      case "runId":
        return { sql: aggregate("run_id"), kind: "text" };
      case "collectorVersion":
        return { sql: aggregate("collector_version"), kind: "text" };
      case "observedAt":
        return {
          sql: aggregate(
            "to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
          ),
          kind: "text",
        };
      case "recordedAt":
        return {
          sql: aggregate(
            "to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
          ),
          kind: "text",
        };
    }
    throw new Error("搜索排序字段未声明。");
  };
  const sortExpressions = input.orderBy.map(selectSortExpression);
  const pageOrdering = input.orderBy
    .map(
      ({ direction }, index) =>
        `sort_${index.toString(10)}${sortExpressions[index]?.kind === "text" ? ' COLLATE "C"' : ""} ${direction.toUpperCase()} NULLS LAST`,
    )
    .concat(['result_id COLLATE "C" ASC'])
    .join(", ");
  let cursorPredicate = "TRUE";
  let cursorRootCte = "";
  let cursorMissingPageRow = "";
  if (cursor !== undefined) {
    const cursorResultId = bind(cursor.resultId);
    cursorRootCte = `cursor_root AS (SELECT * FROM roots WHERE result_id = ${cursorResultId}::text),`;
    const nullSortValues = sortExpressions
      .map(({ kind }) => (kind === "jsonb" ? "NULL::jsonb" : "NULL::text"))
      .join(", ");
    cursorMissingPageRow = `UNION ALL
      SELECT
        true AS cursor_missing,
        NULL::text AS result_id,
        '${resultUnit}'::text AS result_unit,
        NULL AS item_id,
        NULL::text AS root_revision_id,
        NULL::text AS root_commit_id,
        NULL::integer AS root_ordinal,
        NULL AS namespace,
        NULL AS source_key,
        ${nullSortValues},
        NULL::bigint AS result_rank
      WHERE NOT EXISTS (SELECT 1 FROM cursor_root)`;
    const afterBranches: string[] = [];
    const equalPrefix: string[] = [];
    for (const [index, sort] of input.orderBy.entries()) {
      const alias = `roots.sort_${index.toString(10)}`;
      const cursorAlias = `cursor_root.sort_${index.toString(10)}`;
      const comparison =
        sortExpressions[index]?.kind === "text"
          ? `${alias} COLLATE "C"`
          : alias;
      const cursorComparison =
        sortExpressions[index]?.kind === "text"
          ? `${cursorAlias} COLLATE "C"`
          : cursorAlias;
      const operator = sort.direction === "asc" ? ">" : "<";
      afterBranches.push(
        `(${equalPrefix.join(" AND ")}${equalPrefix.length > 0 ? " AND " : ""}${cursorAlias} IS NOT NULL AND (${alias} IS NULL OR (${alias} IS NOT NULL AND ${comparison} ${operator} ${cursorComparison})))`,
      );
      equalPrefix.push(`${alias} IS NOT DISTINCT FROM ${cursorAlias}`);
    }
    afterBranches.push(
      `(${equalPrefix.join(" AND ")} AND roots.result_id COLLATE "C" > cursor_root.result_id COLLATE "C")`,
    );
    cursorPredicate =
      "EXISTS (SELECT 1 FROM cursor_root WHERE " +
      afterBranches.join(" OR ") +
      ")";
  }
  const limit = bind(String(input.limit + 1));
  const jsonSelectors = input.select.filter(
    (selector): selector is ArchiveSearchJsonProjection =>
      typeof selector !== "string",
  );
  const jsonProjectionExpression =
    jsonSelectors.length === 0
      ? "'[]'::jsonb"
      : "jsonb_build_array(" +
        jsonSelectors
          .map((selector) => {
            const expression = searchJsonPathExpression(
              "contextual.state_data",
              selector.field,
              selector.path,
              bind,
            );
            const field = bind(selector.field);
            const path = bind(selector.path);
            return `CASE WHEN ${expression} IS NULL THEN jsonb_build_object('field', ${field}::text, 'path', ${path}::jsonb, 'exists', false) ELSE jsonb_build_object('field', ${field}::text, 'path', ${path}::jsonb, 'exists', true, 'value', ${expression}) END`;
          })
          .join(", ") +
        ")";
  const query = `
    WITH latest AS (
      SELECT ${sourceSelection}
        observation.item_id,
        observation.revision_id,
        commit.commit_id,
        commit.archive_seq::text AS archive_seq,
        commit.bin_id,
        commit.run_id,
        commit.collector_version,
        commit.observed_at,
        commit.recorded_at,
        observation.ordinal,
        revision.state_data->>'sourceRef' AS source_ref,
        revision.state_data->'capture'->>'completeness' AS completeness,
        revision.state_data->>'sourceModifiedAt' AS source_modified_at
      FROM archive_observation AS observation
      JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
      JOIN archive_revision AS revision
        ON revision.item_id = observation.item_id
        AND revision.revision_id = observation.revision_id
      WHERE commit.archive_seq <= ${asOf}::bigint${binPredicate}
      ORDER BY
        ${sourceOrder}
        commit.archive_seq DESC,
        observation.ordinal DESC,
        commit.commit_id DESC
    ),
    matched AS (
      SELECT
        latest.*,
        item.namespace,
        item.source_key,
        revision.state_data AS state_data,
        revision.state_data->'body'->>'searchText' AS search_text,
        ${resultIdExpression} AS result_id
      FROM latest
      JOIN archive_item AS item ON item.item_id = latest.item_id
      JOIN archive_revision AS revision
        ON revision.item_id = latest.item_id
        AND revision.revision_id = latest.revision_id
      WHERE ${matchPredicate}
    ),
    located AS (
      SELECT matched.*, ${hitStart} AS hit_start
      FROM matched
    ),
    bounded AS (
      SELECT
        located.*,
        ${hitEnd} AS hit_end
      FROM located
    ),
    contextual AS (
      SELECT
        bounded.*,
        greatest(0, hit_start - 80) AS context_start,
        least(
          char_length(search_text),
          hit_end + 80
        ) AS context_end
      FROM bounded
    ),
    roots AS (
      SELECT
        result_id,
        '${resultUnit}'::text AS result_unit,
        item_id,
        ${rootRevisionExpression} AS root_revision_id,
        ${rootCommitExpression} AS root_commit_id,
        ${rootOrdinalExpression} AS root_ordinal,
        namespace,
        source_key,
        ${sortExpressions.map(({ sql }, index) => `${sql} AS sort_${index.toString(10)}`).join(",\n        ")}
      FROM contextual
      GROUP BY result_id, item_id, namespace, source_key
    ),
    ${cursorRootCte}
    limited_page AS (
      SELECT
        roots.*,
        row_number() OVER (ORDER BY ${pageOrdering}) AS result_rank
      FROM roots
      WHERE ${cursorPredicate}
      ORDER BY ${pageOrdering}
      LIMIT ${limit}::integer
    ),
    page AS (
      SELECT false AS cursor_missing, limited_page.*
      FROM limited_page
      ${cursorMissingPageRow}
    )
    SELECT
      page.cursor_missing,
      page.result_id,
      page.result_unit,
      page.root_revision_id,
      page.root_commit_id,
      page.root_ordinal,
      contextual.item_id AS item_id,
      contextual.namespace AS namespace,
      contextual.source_key AS source_key,
      contextual.bin_id AS bin_id,
      contextual.revision_id AS revision_id,
      contextual.archive_seq AS archive_seq,
      contextual.run_id AS run_id,
      contextual.collector_version AS collector_version,
      contextual.source_ref AS source_ref,
      contextual.source_modified_at AS source_modified_at,
      contextual.completeness AS completeness,
      contextual.observed_at AS observed_at,
      contextual.recorded_at AS recorded_at,
      contextual.hit_start AS hit_start,
      contextual.hit_end AS hit_end,
      contextual.context_start AS context_start,
      contextual.context_end AS context_end,
      substring(
        contextual.search_text FROM contextual.context_start + 1 FOR contextual.context_end - contextual.context_start
      ) AS context_text,
      ${jsonProjectionExpression} AS json_projections
    FROM page
    LEFT JOIN contextual ON contextual.result_id = page.result_id
    ORDER BY page.cursor_missing, page.result_rank, contextual.bin_id COLLATE "C", contextual.archive_seq::bigint
  `;
  const rows = await transaction.unsafe<SearchRow[]>(query, parameters);

  const selected = new Set(input.select);
  const results = new Map<string, SearchResult>();
  for (const row of rows) {
    if (row.cursor_missing) {
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
    const match: SearchMatch = {
      binId: row.bin_id,
      revisionId: row.revision_id,
      archiveSeq: row.archive_seq,
      ...(selected.has("sourceModifiedAt") && row.source_modified_at !== null
        ? { sourceModifiedAt: row.source_modified_at }
        : {}),
      ...(selected.has("sourceRef") && row.source_ref !== null
        ? { sourceRef: row.source_ref }
        : {}),
      ...(selected.has("capture.completeness") && row.completeness !== null
        ? { completeness: row.completeness }
        : {}),
      ...(selected.has("observedAt")
        ? { observedAt: isoTimestamp(row.observed_at) }
        : {}),
      ...(selected.has("recordedAt")
        ? { recordedAt: isoTimestamp(row.recorded_at) }
        : {}),
      ...(selected.has("runId") ? optionalText("runId", row.run_id) : {}),
      ...(selected.has("collectorVersion")
        ? optionalText("collectorVersion", row.collector_version)
        : {}),
      ...(row.hit_start === null || row.hit_end === null
        ? {}
        : {
            hit: {
              field: "body.searchText" as const,
              representation: "searchText" as const,
              position: {
                encoding: "unicode-code-point" as const,
                start: row.hit_start,
                end: row.hit_end,
              },
              ...(selected.has("hit.context") &&
              row.context_start !== null &&
              row.context_end !== null &&
              row.context_text !== null
                ? {
                    context: {
                      start: row.context_start,
                      end: row.context_end,
                      text: row.context_text,
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
              .parse(row.json_projections),
          }),
    };
    const result = results.get(row.result_id);
    if (result === undefined) {
      const created: SearchResult = {
        resultId: row.result_id,
        itemId: row.item_id,
        ...(selected.has("sourceKey")
          ? { sourceKey: { namespace: row.namespace, key: row.source_key } }
          : {}),
        ...(row.root_revision_id === null
          ? {}
          : { revisionId: row.root_revision_id }),
        ...(row.root_commit_id === null
          ? {}
          : {
              commitId: row.root_commit_id,
              ordinal: row.root_ordinal ?? 0,
            }),
        matches: [match],
      };
      results.set(row.result_id, created);
    } else {
      result.matches.push(match);
    }
  }

  const orderedResults = [...results.values()];
  const hasMore = orderedResults.length > input.limit;
  const pageResults = orderedResults.slice(0, input.limit);
  const expansions = input.expand ?? [];
  if (expansions.length > 0) {
    const views = pageResults.flatMap((result) =>
      result.matches.map((match) => ({
        result_id: result.resultId,
        item_id: result.itemId,
        bin_id: match.binId,
      })),
    );
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

    if (views.length > 0) {
      const keyForView = (resultId: string, binId: string): string =>
        JSON.stringify([resultId, binId]);
      for (const selector of expansions) {
        const expansionParameters: (postgres.JSONValue | postgres.Parameter)[] =
          [];
        const bindExpansion = (
          value: postgres.JSONValue | postgres.Parameter,
        ): string => {
          expansionParameters.push(value);
          return "$" + expansionParameters.length.toString(10);
        };
        const viewsParameter = bindExpansion(
          transaction.json(views as unknown as postgres.JSONValue),
        );
        const expansionAsOf = bindExpansion(snapshot.asOf);
        const relationEndpointCondition =
          selector.direction === "outgoing"
            ? "relation.from_item_id = views.item_id"
            : selector.direction === "incoming"
              ? "relation.target_item_id = views.item_id"
              : "(relation.from_item_id = views.item_id OR relation.target_item_id = views.item_id)";
        const gapEndpointCondition =
          selector.direction === "outgoing"
            ? "gap.from_item_id = views.item_id"
            : selector.direction === "incoming"
              ? "gap.target_item_id = views.item_id"
              : "(gap.from_item_id = views.item_id OR gap.target_item_id = views.item_id)";
        const selectedRelationConditions = [
          ...(selector.name === undefined
            ? []
            : [
                `relation_revision.state_data->>'name' COLLATE "C" = ${bindExpansion(selector.name)}::text COLLATE "C"`,
              ]),
          ...(selector.properties === undefined
            ? []
            : [
                compileJsonFilter(
                  selector.properties,
                  "relation_revision.state_data",
                  bindExpansion,
                ),
              ]),
        ];
        const activeSelection =
          selectedRelationConditions.length === 0
            ? ""
            : `AND latest.relation_revision_id IS NOT NULL AND ${selectedRelationConditions.join(" AND ")}`;
        const relationLimit = selector.limit + 1;
        const query = `
          WITH views AS (
            SELECT DISTINCT request.result_id, request.item_id, request.bin_id
            FROM jsonb_to_recordset(${viewsParameter}::jsonb)
              AS request(result_id text, item_id uuid, bin_id text)
          ), latest_gaps AS (
            SELECT DISTINCT ON (views.result_id, views.bin_id, gap.relation_id)
              views.result_id,
              views.bin_id,
              gap.relation_id,
              CASE
                WHEN gap.from_item_id = views.item_id THEN 'outgoing'
                ELSE 'incoming'
              END AS direction,
              gap.from_item_id,
              gap.target_item_id,
              commit.commit_id,
              commit.archive_seq::text AS archive_seq,
              gap.ordinal,
              commit.observed_at,
              commit.recorded_at,
              commit.run_id,
              commit.collector_version
            FROM views
            JOIN archive_relation_observation_gap AS gap
              ON ${gapEndpointCondition}
            JOIN archive_commit AS commit
              ON commit.commit_id = gap.commit_id
              AND commit.bin_id = views.bin_id
            WHERE commit.archive_seq <= ${expansionAsOf}::bigint
              AND NOT EXISTS (
                SELECT 1
                FROM archive_relation_observation AS later
                WHERE later.relation_id = gap.relation_id
                  AND later.bin_id = views.bin_id
                  AND later.archive_seq > commit.archive_seq
                  AND later.archive_seq <= ${expansionAsOf}::bigint
              )
            ORDER BY
              views.result_id,
              views.bin_id,
              gap.relation_id,
              commit.archive_seq DESC,
              gap.ordinal DESC,
              gap.commit_id DESC
          ), active_relations AS (
            SELECT
              views.result_id,
              views.bin_id,
              relation.relation_id,
              CASE
                WHEN relation.from_item_id = views.item_id THEN 'outgoing'
                ELSE 'incoming'
              END AS direction,
              CASE
                WHEN latest.relation_revision_id IS NULL THEN 'withdrawn'
                ELSE 'observed'
              END AS status,
              relation.from_item_id,
              relation.target_item_id,
              relation.target_source_ref,
              latest.relation_revision_id,
              relation_revision.state_data,
              latest.commit_id,
              latest.archive_seq::text AS archive_seq,
              latest.ordinal,
              latest.observed_at,
              latest.recorded_at,
              latest.run_id,
              latest.collector_version
            FROM views
            JOIN archive_relation AS relation
              ON ${relationEndpointCondition}
            JOIN LATERAL (
              SELECT
                observation.relation_revision_id,
                observation.commit_id,
                observation.archive_seq,
                observation.ordinal,
                commit.observed_at,
                commit.recorded_at,
                commit.run_id,
                commit.collector_version
              FROM archive_relation_observation AS observation
              JOIN archive_commit AS commit
                ON commit.commit_id = observation.commit_id
              WHERE observation.relation_id = relation.relation_id
                AND observation.bin_id = views.bin_id
                AND observation.archive_seq <= ${expansionAsOf}::bigint
              ORDER BY
                observation.archive_seq DESC,
                observation.ordinal DESC,
                observation.commit_id DESC
              LIMIT 1
            ) AS latest ON TRUE
            LEFT JOIN archive_relation_revision AS relation_revision
              ON relation_revision.relation_id = relation.relation_id
              AND relation_revision.relation_revision_id = latest.relation_revision_id
            WHERE relation.created_seq <= ${expansionAsOf}::bigint
              AND NOT EXISTS (
                SELECT 1
                FROM latest_gaps
                WHERE latest_gaps.result_id = views.result_id
                  AND latest_gaps.bin_id = views.bin_id
                  AND latest_gaps.relation_id = relation.relation_id
              )
              ${activeSelection}
          ), candidates AS (
            SELECT
              active_relations.result_id,
              active_relations.bin_id,
              active_relations.relation_id,
              active_relations.direction,
              active_relations.status,
              active_relations.from_item_id,
              active_relations.target_item_id,
              active_relations.target_source_ref,
              active_relations.relation_revision_id,
              active_relations.state_data,
              active_relations.commit_id,
              active_relations.archive_seq,
              active_relations.ordinal,
              active_relations.observed_at,
              active_relations.recorded_at,
              active_relations.run_id,
              active_relations.collector_version
            FROM active_relations
            UNION ALL
            SELECT
              latest_gaps.result_id,
              latest_gaps.bin_id,
              latest_gaps.relation_id,
              latest_gaps.direction,
              'deleted'::text AS status,
              NULL::uuid AS from_item_id,
              NULL::uuid AS target_item_id,
              NULL::text AS target_source_ref,
              NULL::uuid AS relation_revision_id,
              NULL::jsonb AS state_data,
              latest_gaps.commit_id,
              latest_gaps.archive_seq,
              latest_gaps.ordinal,
              latest_gaps.observed_at,
              latest_gaps.recorded_at,
              latest_gaps.run_id,
              latest_gaps.collector_version
            FROM latest_gaps
            WHERE ${selectedRelationConditions.length === 0 ? "TRUE" : "FALSE"}
          ), ranked AS (
            SELECT
              candidates.*,
              row_number() OVER (
                PARTITION BY candidates.result_id, candidates.bin_id
                ORDER BY candidates.relation_id COLLATE "C", candidates.direction
              ) AS expansion_rank
            FROM candidates
          ), limited AS (
            SELECT *
            FROM ranked
            WHERE expansion_rank <= ${relationLimit}
          )
          SELECT
            limited.result_id,
            limited.bin_id,
            limited.relation_id,
            limited.direction,
            limited.status,
            limited.from_item_id,
            from_item.namespace AS from_namespace,
            from_item.source_key AS from_source_key,
            from_latest.revision_id AS from_revision_id,
            limited.target_item_id,
            limited.target_source_ref,
            target_item.namespace AS target_namespace,
            target_item.source_key AS target_source_key,
            target_latest.revision_id AS target_revision_id,
            limited.relation_revision_id,
            limited.state_data,
            limited.commit_id AS relation_commit_id,
            limited.archive_seq AS relation_archive_seq,
            limited.ordinal AS relation_ordinal,
            limited.observed_at AS relation_observed_at,
            limited.recorded_at AS relation_recorded_at,
            limited.run_id AS relation_run_id,
            limited.collector_version AS relation_collector_version
          FROM limited
          LEFT JOIN archive_item AS from_item
            ON from_item.item_id = limited.from_item_id
          LEFT JOIN LATERAL (
            SELECT observation.revision_id
            FROM archive_observation AS observation
            JOIN archive_commit AS commit
              ON commit.commit_id = observation.commit_id
            WHERE observation.item_id = limited.from_item_id
              AND commit.bin_id = limited.bin_id
              AND commit.archive_seq <= ${expansionAsOf}::bigint
            ORDER BY
              commit.archive_seq DESC,
              observation.ordinal DESC,
              commit.commit_id DESC
            LIMIT 1
          ) AS from_latest ON TRUE
          LEFT JOIN archive_item AS target_item
            ON target_item.item_id = limited.target_item_id
          LEFT JOIN LATERAL (
            SELECT observation.revision_id
            FROM archive_observation AS observation
            JOIN archive_commit AS commit
              ON commit.commit_id = observation.commit_id
            WHERE observation.item_id = limited.target_item_id
              AND commit.bin_id = limited.bin_id
              AND commit.archive_seq <= ${expansionAsOf}::bigint
            ORDER BY
              commit.archive_seq DESC,
              observation.ordinal DESC,
              commit.commit_id DESC
            LIMIT 1
          ) AS target_latest ON TRUE
          ORDER BY
            limited.result_id COLLATE "C",
            limited.bin_id COLLATE "C",
            limited.expansion_rank
        `;
        const rows = await transaction.unsafe<SearchExpansionRow[]>(
          query,
          expansionParameters,
        );
        const rowsByView = new Map<string, SearchExpansionRow[]>();
        for (const row of rows) {
          const key = keyForView(row.result_id, row.bin_id);
          const groupedRows = rowsByView.get(key);
          if (groupedRows === undefined) rowsByView.set(key, [row]);
          else groupedRows.push(row);
        }
        const relationForRow = (
          row: SearchExpansionRow,
        ): SearchExpansionRelation => {
          const observation = {
            commitId: row.relation_commit_id,
            archiveSeq: row.relation_archive_seq,
            ordinal: row.relation_ordinal,
            observedAt: isoTimestamp(row.relation_observed_at),
            recordedAt: isoTimestamp(row.relation_recorded_at),
            ...optionalText("runId", row.relation_run_id),
            ...optionalText("collectorVersion", row.relation_collector_version),
          };
          if (row.status === "deleted") {
            return {
              relationId: row.relation_id,
              direction: row.direction,
              status: row.status,
              observation,
            };
          }
          if (
            row.from_item_id === null ||
            row.from_namespace === null ||
            row.from_source_key === null
          ) {
            throw new Error("关系展开缺少来源端点。 ");
          }
          const from = {
            kind: "item" as const,
            itemId: row.from_item_id,
            sourceKey: {
              namespace: row.from_namespace,
              key: row.from_source_key,
            },
            status:
              row.from_revision_id === null
                ? ("unknown" as const)
                : ("observed" as const),
            ...(row.from_revision_id === null
              ? {}
              : { revisionId: row.from_revision_id }),
          };
          const to =
            row.target_item_id === null
              ? {
                  kind: "sourceRef" as const,
                  sourceRef: row.target_source_ref!,
                }
              : (() => {
                  if (
                    row.target_namespace === null ||
                    row.target_source_key === null
                  ) {
                    throw new Error("关系展开缺少目标端点。 ");
                  }
                  return {
                    kind: "item" as const,
                    itemId: row.target_item_id,
                    sourceKey: {
                      namespace: row.target_namespace,
                      key: row.target_source_key,
                    },
                    status:
                      row.target_revision_id === null
                        ? ("unknown" as const)
                        : ("observed" as const),
                    ...(row.target_revision_id === null
                      ? {}
                      : { revisionId: row.target_revision_id }),
                  };
                })();
          if (row.status === "withdrawn") {
            return {
              relationId: row.relation_id,
              direction: row.direction,
              status: row.status,
              from,
              to,
              observation,
            };
          }
          if (row.relation_revision_id === null) {
            throw new Error("已观察关系缺少不可变关系版本。 ");
          }
          return {
            relationId: row.relation_id,
            direction: row.direction,
            status: row.status,
            from,
            to,
            revisionId: row.relation_revision_id,
            state: archiveRelationStateSchema.parse(row.state_data),
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
              throw new Error("关系展开结果缺少对应选择器。 ");
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
  database: CoreDatabase,
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
        return await database.begin(async (transaction) => {
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
          await transaction`
            SELECT set_config(
              'statement_timeout',
              ${String(checked.data.budgetMs) + "ms"},
              true
            )
          `;
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
          return await readCurrentSearchPage(
            transaction,
            fixedSnapshot,
            checked.data,
            decodedCursor,
            queryHash,
          );
        });
      } catch (error) {
        if (postgresErrorCode(error) === "57014") {
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
          postgresErrorCode(error) === "2201B" && regexPatterns.length === 1
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
