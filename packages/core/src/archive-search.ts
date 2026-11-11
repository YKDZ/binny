import { createHash } from "node:crypto";

import {
  archiveIdentifierSchema,
  archiveSearchInputSchema,
  archiveSearchInputIssue,
  archiveSearchInputDiagnostic,
  archiveSearchPageSchema,
  archiveSearchDistributionPageSchema,
  archiveSnapshotSchema,
  discoverSourceAdapterExtensionFields,
  postgresTextSchema,
  sourceAdapterManifestStoredSchema,
  type ArchiveOperationContext,
  type ArchiveOperations,
  type ArchiveExtensionFieldFilter,
  type ArchiveSearchDiagnostic,
  type ArchiveSearchDistributionRequest,
  type ArchiveSearchOperation,
  type ArchiveSearchRequest,
  type SourceAdapterManifest,
} from "@binny/contracts";
import {
  archiveCommits,
  archiveItems,
  archiveObservations,
  archiveRevisions,
  archiveWriteClock,
  binConfigurations,
  databaseErrorCode,
  type CancellableQueryExecutor,
  type Database,
} from "@binny/db";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  lte,
  not,
  sql,
  type SQL,
  type SQLWrapper,
  type WithSubquery,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import { canonicalJson } from "./archive-common.ts";
import {
  ArchiveRequestCancelled,
  ArchiveQueryBudgetExceeded,
  assertArchiveQueryActive,
  createArchiveQueryDeadline,
  executeArchiveQueryWithinDeadline,
} from "./archive-query-budget.ts";
import {
  canonicalizeArchiveTimeZone,
  archiveTimeZoneAliases,
  localDateBoundarySql,
  sourceTimeBoundsSql,
  sourceTimeFieldSql,
  sourceTimeWindowDecisionSql,
  type ArchiveTimeZoneAliases,
} from "./archive-search-time.ts";

type SearchCursor = {
  readonly version: 1;
  readonly queryHash: string;
  readonly snapshot: ReturnType<typeof archiveSnapshotSchema.parse>;
  readonly observedAt: string;
  readonly timeSortValue?: string | null;
  readonly itemId: string;
};
type SearchDistributionCursor = {
  readonly version: 1;
  readonly queryHash: string;
  readonly snapshot: ReturnType<typeof archiveSnapshotSchema.parse>;
  readonly groupKey: string;
};
type SearchInput = ReturnType<typeof archiveSearchInputSchema.parse>;
type SearchPageRow = {
  readonly snapshotAsOf: string;
  readonly snapshotMode: string;
  readonly invalidSnapshot: boolean;
  readonly results: unknown;
  readonly extensionBins: unknown;
  readonly certainItems?: string;
  readonly undeterminedItems?: string;
  readonly distributionGroups: unknown;
  readonly distributionTotalItems: string | null;
};

type ExtensionScopeBin = {
  readonly binId: string;
  readonly sourceAdapter: SourceAdapterManifest;
};

type SearchZoneRow = {
  readonly snapshotAsOf: string;
  readonly snapshotMode: string;
  readonly invalidSnapshot: boolean;
  readonly timeZones: unknown;
};

const searchTimeSortValuePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/u;

// Validate calendar fields directly so the original six fractional digits stay intact.
function isValidSearchTimeSortValue(value: string): boolean {
  const parts = searchTimeSortValuePattern.exec(value);
  if (parts === null) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function encodeSearchDistributionCursor(
  cursor: SearchDistributionCursor,
): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeSearchCursor(cursor: string): SearchCursor | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) return undefined;
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return undefined;
    const timeSortValue =
      "timeSortValue" in value ? value.timeSortValue : undefined;
    if (
      !("version" in value) ||
      value.version !== 1 ||
      !("queryHash" in value) ||
      typeof value.queryHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.queryHash) ||
      !("snapshot" in value) ||
      !("observedAt" in value) ||
      typeof value.observedAt !== "string" ||
      (timeSortValue !== undefined &&
        timeSortValue !== null &&
        (typeof timeSortValue !== "string" ||
          !isValidSearchTimeSortValue(timeSortValue))) ||
      !("itemId" in value) ||
      typeof value.itemId !== "string"
    ) {
      return undefined;
    }
    const snapshot = archiveSnapshotSchema.safeParse(value.snapshot);
    const itemId = archiveIdentifierSchema.safeParse(value.itemId);
    const observedAt = new Date(value.observedAt);
    if (
      !snapshot.success ||
      !itemId.success ||
      Number.isNaN(observedAt.getTime()) ||
      observedAt.toISOString() !== value.observedAt
    ) {
      return undefined;
    }
    return {
      version: 1,
      queryHash: value.queryHash,
      snapshot: snapshot.data,
      observedAt: value.observedAt,
      ...(typeof timeSortValue === "string" || timeSortValue === null
        ? { timeSortValue }
        : {}),
      itemId: itemId.data,
    };
  } catch {
    return undefined;
  }
}

function decodeSearchDistributionCursor(
  cursor: string,
): SearchDistributionCursor | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) return undefined;
    const value: unknown = JSON.parse(json);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("queryHash" in value) ||
      typeof value.queryHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.queryHash) ||
      !("snapshot" in value) ||
      !("groupKey" in value) ||
      typeof value.groupKey !== "string"
    ) {
      return undefined;
    }
    const snapshot = archiveSnapshotSchema.safeParse(value.snapshot);
    const groupKey = postgresTextSchema.safeParse(value.groupKey);
    if (!snapshot.success || !groupKey.success) return undefined;
    return {
      version: 1,
      queryHash: value.queryHash,
      snapshot: snapshot.data,
      groupKey: groupKey.data,
    };
  } catch {
    return undefined;
  }
}

function invalidInput(
  message: string,
  path: readonly (string | number)[],
  diagnostic?: ArchiveSearchDiagnostic,
) {
  return {
    ok: false as const,
    status: 400 as const,
    error: {
      code: "invalid_input" as const,
      message,
      path: [...path],
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
  };
}

function budgetFailure(budgetMs: number): ArchiveSearchOperation<never> {
  return {
    ok: false,
    status: 422,
    error: {
      code: "query_budget_exceeded",
      message: `Search exceeded the server request budget of ${budgetMs} ms; no partial results were returned.`,
    },
  };
}

function queryHash(input: SearchInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        bins: input.bins ?? null,
        text: input.text ?? null,
        extensions: input.extensions ?? null,
        ...(input.timeWindow === undefined
          ? {}
          : { timeWindow: input.timeWindow }),
      }),
    )
    .digest("hex");
}

function distributionQueryHash(
  input: SearchInput,
  distribution: ArchiveSearchDistributionRequest,
): string {
  const { cursor: _cursor, limit: _limit, ...dimension } = distribution;
  return createHash("sha256")
    .update(
      canonicalJson({
        query: queryHash(input),
        distribution: dimension,
      }),
    )
    .digest("hex");
}

function textMatches(input: SearchInput, stateData: SQL) {
  if (input.text === undefined) return sql`true`;

  const groups = input.text.groups.map((group) => {
    const terms = group.map((term) => {
      const titleMatch = sql`strpos(lower(coalesce(${stateData}->>'title', '')), lower(${term})) > 0`;
      // Check stored body representations independently; joining them can create
      // a literal match that no individual representation contains.
      // `searchText` is a body fallback only when no rendered representation
      // exists, because some producers include the title in that field.
      const bodyMatch = sql`(
        strpos(lower(coalesce(${stateData}->'body'->>'text', '')), lower(${term})) > 0
        OR strpos(lower(coalesce(${stateData}->'body'->>'markdown', '')), lower(${term})) > 0
        OR strpos(lower(coalesce(${stateData}->'body'->>'html', '')), lower(${term})) > 0
        OR (
          NOT (
            coalesce(${stateData}->'body' ? 'text', false)
            OR coalesce(${stateData}->'body' ? 'markdown', false)
            OR coalesce(${stateData}->'body' ? 'html', false)
          )
          AND strpos(lower(coalesce(${stateData}->'body'->>'searchText', '')), lower(${term})) > 0
        )
      )`;
      if (input.text!.in === "title") return titleMatch;
      if (input.text!.in === "body") return bodyMatch;
      return sql`(${titleMatch} OR ${bodyMatch})`;
    });
    return sql`(${sql.join(terms, sql` OR `)})`;
  });
  return sql`(${sql.join(groups, sql` AND `)})`;
}

function extensionMatches(input: SearchInput, stateData: SQL) {
  if (input.extensions === undefined) return sql`true`;
  const fieldMatches = Object.entries(input.extensions.filters).map(
    ([fieldName, filter]) => {
      const field = sql`${stateData}->'extensions'->${fieldName}`;
      if (filter.op === "eq")
        return sql`${field} = ${JSON.stringify(filter.value)}::text::jsonb`;
      if (filter.op === "in")
        return sql`(${sql.join(
          filter.values.map(
            (value) => sql`${field} = ${JSON.stringify(value)}::text::jsonb`,
          ),
          sql` OR `,
        )})`;
      return sql`(${sql.join(
        (filter.op === "has" ? [filter.value] : filter.values).map(
          (value) => sql`${field} @> ${JSON.stringify([value])}::text::jsonb`,
        ),
        sql` OR `,
      )})`;
    },
  );
  return sql`(${sql.join(fieldMatches, sql` AND `)})`;
}

function timeZoneSql(timeZone: string): SQL {
  const canonical = canonicalizeArchiveTimeZone(timeZone);
  return /^(?:[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/u.test(canonical)
    ? sql`${canonical}::interval`
    : sql`${canonical}::text`;
}

function dateDistributionCtes(
  database: Database,
  selectedViews: WithSubquery & {
    readonly item_id: SQLWrapper;
    readonly observed_at: SQLWrapper;
    readonly state_data: SQLWrapper;
  },
  distribution: Extract<
    NonNullable<SearchInput["distribution"]>,
    { by: "date" }
  >,
  cursor: SearchDistributionCursor | undefined,
  aliases: ArchiveTimeZoneAliases,
) {
  const zone = timeZoneSql(distribution.timeZone);
  const sourceTime =
    distribution.field === "observedAt"
      ? undefined
      : sourceTimeFieldSql(
          sql`${selectedViews.state_data}`,
          distribution.field,
        );
  const bounds =
    sourceTime === undefined
      ? undefined
      : sourceTimeBoundsSql(sourceTime, aliases);
  const dateRanges = database.$with("date_ranges").as(
    database
      .select({
        item_id: sql`${selectedViews.item_id}`.as("item_id"),
        precision:
          bounds?.precision.as("precision") ??
          sql`'instant'::text`.as("precision"),
        value:
          bounds?.value.as("value") ??
          sql`${selectedViews.observed_at}::text`.as("value"),
        time_zone:
          bounds?.timeZone.as("time_zone") ?? sql`NULL::text`.as("time_zone"),
        start_at:
          bounds?.start.as("start_at") ??
          sql`${selectedViews.observed_at}`.as("start_at"),
        end_at:
          bounds?.end.as("end_at") ??
          sql`${selectedViews.observed_at}`.as("end_at"),
        possible_start:
          bounds?.possibleStart.as("possible_start") ??
          sql`${selectedViews.observed_at}`.as("possible_start"),
        possible_end:
          bounds?.possibleEnd.as("possible_end") ??
          sql`${selectedViews.observed_at}`.as("possible_end"),
      })
      .from(selectedViews),
  );
  const dateCandidates = database.$with("date_candidates").as(
    database
      .select({
        item_id: sql`${dateRanges.item_id}`.as("item_id"),
        precision: sql`${dateRanges.precision}`.as("precision"),
        value: sql`${dateRanges.value}`.as("value"),
        time_zone: sql`${dateRanges.time_zone}`.as("time_zone"),
        start_at: sql`${dateRanges.start_at}`.as("start_at"),
        end_at: sql`${dateRanges.end_at}`.as("end_at"),
        possible_start: sql`${dateRanges.possible_start}`.as("possible_start"),
        possible_end: sql`${dateRanges.possible_end}`.as("possible_end"),
        range_start: sql`CASE
          WHEN ${dateRanges.precision} <> 'instant' AND ${dateRanges.time_zone} IS NULL
          THEN ${dateRanges.possible_start}
          ELSE ${dateRanges.start_at}
        END`.as("range_start"),
        range_end: sql`CASE
          WHEN ${dateRanges.precision} = 'instant' THEN ${dateRanges.start_at}
          WHEN ${dateRanges.time_zone} IS NULL THEN ${dateRanges.possible_end}
          ELSE ${dateRanges.end_at}
        END`.as("range_end"),
      })
      .from(dateRanges),
  );
  const bucketLocalStart = sql`date_trunc(
    ${distribution.period}::text,
    (${dateCandidates.range_start} AT TIME ZONE ${zone})
  )`;
  const periodInterval = sql`CASE ${distribution.period}::text
    WHEN 'day' THEN interval '1 day'
    WHEN 'month' THEN interval '1 month'
    ELSE interval '1 year'
  END`;
  const dateBucketed = database.$with("date_bucketed").as(
    database
      .select({
        item_id: sql`${dateCandidates.item_id}`.as("item_id"),
        precision: sql`${dateCandidates.precision}`.as("precision"),
        value: sql`${dateCandidates.value}`.as("value"),
        time_zone: sql`${dateCandidates.time_zone}`.as("time_zone"),
        range_start: sql`${dateCandidates.range_start}`.as("range_start"),
        range_end: sql`${dateCandidates.range_end}`.as("range_end"),
        bucket_local_start: bucketLocalStart.as("bucket_local_start"),
        bucket_start: sql`(${bucketLocalStart}) AT TIME ZONE ${zone}`.as(
          "bucket_start",
        ),
        bucket_end:
          sql`(${bucketLocalStart} + ${periodInterval}) AT TIME ZONE ${zone}`.as(
            "bucket_end",
          ),
      })
      .from(dateCandidates),
  );
  const dateDecisions = database.$with("date_decisions").as(
    database
      .select({
        item_id: sql`${dateBucketed.item_id}`.as("item_id"),
        date_value: sql`CASE ${distribution.period}::text
          WHEN 'day' THEN to_char(${dateBucketed.bucket_local_start}, 'YYYY-MM-DD')
          WHEN 'month' THEN to_char(${dateBucketed.bucket_local_start}, 'YYYY-MM')
          ELSE to_char(${dateBucketed.bucket_local_start}, 'YYYY')
        END`.as("date_value"),
        group_kind: sql`CASE
          WHEN ${dateBucketed.value} IS NULL THEN 'undetermined'
          WHEN ${dateBucketed.precision} = 'instant'
            AND ${dateBucketed.range_start} >= ${dateBucketed.bucket_start}
            AND ${dateBucketed.range_start} < ${dateBucketed.bucket_end}
          THEN 'date'
          WHEN ${dateBucketed.precision} = 'instant' THEN 'undetermined'
          WHEN ${dateBucketed.range_start} >= ${dateBucketed.bucket_start}
            AND ${dateBucketed.range_end} <= ${dateBucketed.bucket_end}
          THEN 'date'
          ELSE 'undetermined'
        END`.as("group_kind"),
        reason: sql`CASE
          WHEN ${dateBucketed.value} IS NULL THEN 'missingTime'
          WHEN ${dateBucketed.precision} = 'instant' THEN NULL::text
          WHEN ${dateBucketed.time_zone} IS NULL
            AND NOT (
              ${dateBucketed.range_start} >= ${dateBucketed.bucket_start}
              AND ${dateBucketed.range_end} <= ${dateBucketed.bucket_end}
            )
          THEN 'missingTimeZone'
          WHEN ${dateBucketed.range_start} >= ${dateBucketed.bucket_start}
            AND ${dateBucketed.range_end} <= ${dateBucketed.bucket_end}
          THEN NULL::text
          ELSE 'precisionOverlapsBoundary'
        END`.as("reason"),
      })
      .from(dateBucketed),
  );
  const dateAssigned = database.$with("date_assigned").as(
    database
      .select({
        item_id: sql`${dateDecisions.item_id}`.as("item_id"),
        group_kind: sql`${dateDecisions.group_kind}`.as("group_kind"),
        date_value: sql`CASE
          WHEN ${dateDecisions.group_kind} = 'date' THEN ${dateDecisions.date_value}
          ELSE NULL::text
        END`.as("date_value"),
        reason: sql`${dateDecisions.reason}`.as("reason"),
        group_key: sql`CASE ${dateDecisions.group_kind}
          WHEN 'date' THEN 'date:' || ${dateDecisions.date_value}
          ELSE 'undetermined:' || ${dateDecisions.reason}
        END COLLATE "C"`.as("group_key"),
      })
      .from(dateDecisions),
  );
  const distributionBase = database.$with("distribution_base").as(
    database
      .select({
        group_key: sql`${dateAssigned.group_key}`.as("group_key"),
        group_kind: sql`${dateAssigned.group_kind}`.as("group_kind"),
        date_value: sql`${dateAssigned.date_value}`.as("date_value"),
        reason: sql`${dateAssigned.reason}`.as("reason"),
        item_count: sql`count(DISTINCT ${dateAssigned.item_id})::text`.as(
          "item_count",
        ),
      })
      .from(dateAssigned)
      .groupBy(
        dateAssigned.group_key,
        dateAssigned.group_kind,
        dateAssigned.date_value,
        dateAssigned.reason,
      ),
  );
  const distributionTotal = database.$with("distribution_total").as(
    database
      .select({
        total_items: sql`count(DISTINCT ${selectedViews.item_id})::text`.as(
          "total_items",
        ),
      })
      .from(selectedViews),
  );
  const afterCursor =
    cursor === undefined
      ? sql`true`
      : sql`${distributionBase.group_key} COLLATE "C" > ${cursor.groupKey} COLLATE "C"`;
  const distributionSelected = database.$with("distribution_selected").as(
    database
      .select()
      .from(distributionBase)
      .where(afterCursor)
      .orderBy(asc(sql`${distributionBase.group_key} COLLATE "C"`))
      .limit(distribution.limit + 1),
  );
  const distributionGroups = database.$with("distribution_groups").as(
    database
      .select({
        groups: sql`coalesce(
          jsonb_agg(
            CASE ${distributionSelected.group_kind}
              WHEN 'date' THEN jsonb_build_object(
                'kind', 'date'::text,
                'value', ${distributionSelected.date_value},
                'itemCount', ${distributionSelected.item_count},
                '__distributionKey', ${distributionSelected.group_key}
              )
              ELSE jsonb_build_object(
                'kind', 'undetermined'::text,
                'reason', ${distributionSelected.reason},
                'itemCount', ${distributionSelected.item_count},
                '__distributionKey', ${distributionSelected.group_key}
              )
            END ORDER BY ${distributionSelected.group_key} COLLATE "C" ASC
          ),
          '[]'::jsonb
        )`.as("groups"),
      })
      .from(distributionSelected),
  );
  const distributionSummary = database.$with("distribution_summary").as(
    database
      .select({
        total_items: sql`${distributionTotal.total_items}`.as("total_items"),
        groups: sql`${distributionGroups.groups}`.as("groups"),
      })
      .from(distributionTotal)
      .crossJoin(distributionGroups),
  );
  return {
    queries: [
      dateRanges,
      dateCandidates,
      dateBucketed,
      dateDecisions,
      dateAssigned,
      distributionBase,
      distributionTotal,
      distributionSelected,
      distributionGroups,
      distributionSummary,
    ] as const,
    summary: distributionSummary,
  };
}

function extensionDistributionCtes(
  database: Database,
  selectedViews: WithSubquery & {
    readonly item_id: SQLWrapper;
    readonly state_data: SQLWrapper;
  },
  distribution: Extract<
    NonNullable<SearchInput["distribution"]>,
    { by: "extension" }
  >,
  cursor: SearchDistributionCursor | undefined,
) {
  const extensionValue = sql`${selectedViews.state_data}->'extensions'->${distribution.field}`;
  const expandedValues = sql`jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(${extensionValue}) = 'array' THEN ${extensionValue}
      WHEN ${extensionValue} IS NULL OR ${extensionValue} = 'null'::jsonb
      THEN '[]'::jsonb
      ELSE jsonb_build_array(${extensionValue})
    END
  ) AS extension_value(value)`;
  const extensionValues = database.$with("extension_values").as(
    database
      .select({
        item_id: sql`${selectedViews.item_id}`.as("item_id"),
        group_value: sql`extension_value.value`.as("group_value"),
      })
      .from(selectedViews)
      .crossJoinLateral(expandedValues),
  );
  const extensionCounts = database.$with("extension_counts").as(
    database
      .select({
        group_value: sql`${extensionValues.group_value}`.as("group_value"),
        item_count: sql`count(DISTINCT ${extensionValues.item_id})::text`.as(
          "item_count",
        ),
      })
      .from(extensionValues)
      .groupBy(extensionValues.group_value),
  );
  const extensionMissing = database.$with("extension_missing").as(
    database
      .selectDistinct({
        item_id: sql`${selectedViews.item_id}`.as("item_id"),
      })
      .from(selectedViews)
      .where(
        sql`${extensionValue} IS NULL
          OR ${extensionValue} = 'null'::jsonb
          OR CASE
            WHEN jsonb_typeof(${extensionValue}) = 'array'
            THEN jsonb_array_length(${extensionValue}) = 0
            ELSE false
          END`,
      ),
  );
  const extensionGroupRows = database
    .select({
      group_key:
        sql`('extension:' || ${extensionCounts.group_value}::text) COLLATE "C"`.as(
          "group_key",
        ),
      group_kind: sql`'extension'::text`.as("group_kind"),
      group_value: sql`${extensionCounts.group_value}`.as("group_value"),
      item_count: sql`${extensionCounts.item_count}`.as("item_count"),
    })
    .from(extensionCounts);
  const missingGroupRows = database
    .select({
      group_key: sql`'missing:'::text COLLATE "C"`.as("group_key"),
      group_kind: sql`'missing'::text`.as("group_kind"),
      group_value: sql`NULL::jsonb`.as("group_value"),
      item_count: sql`count(DISTINCT ${extensionMissing.item_id})::text`.as(
        "item_count",
      ),
    })
    .from(extensionMissing)
    .having(sql`count(DISTINCT ${extensionMissing.item_id}) > 0`);
  const distributionBase = database
    .$with("distribution_base")
    .as(unionAll(extensionGroupRows, missingGroupRows));
  const distributionTotal = database.$with("distribution_total").as(
    database
      .select({
        total_items: sql`count(DISTINCT ${selectedViews.item_id})::text`.as(
          "total_items",
        ),
      })
      .from(selectedViews),
  );
  const afterCursor =
    cursor === undefined
      ? sql`true`
      : sql`${distributionBase.group_key} COLLATE "C" > ${cursor.groupKey} COLLATE "C"`;
  const distributionSelected = database.$with("distribution_selected").as(
    database
      .select()
      .from(distributionBase)
      .where(afterCursor)
      .orderBy(asc(sql`${distributionBase.group_key} COLLATE "C"`))
      .limit(distribution.limit + 1),
  );
  const distributionGroups = database.$with("distribution_groups").as(
    database
      .select({
        groups: sql`coalesce(
          jsonb_agg(
            CASE ${distributionSelected.group_kind}
              WHEN 'extension' THEN jsonb_build_object(
                'kind', 'extension'::text,
                'value', ${distributionSelected.group_value},
                'itemCount', ${distributionSelected.item_count},
                '__distributionKey', ${distributionSelected.group_key}
              )
              ELSE jsonb_build_object(
                'kind', 'missing'::text,
                'itemCount', ${distributionSelected.item_count},
                '__distributionKey', ${distributionSelected.group_key}
              )
            END ORDER BY ${distributionSelected.group_key} COLLATE "C" ASC
          ),
          '[]'::jsonb
        )`.as("groups"),
      })
      .from(distributionSelected),
  );
  const distributionSummary = database.$with("distribution_summary").as(
    database
      .select({
        total_items: sql`${distributionTotal.total_items}`.as("total_items"),
        groups: sql`${distributionGroups.groups}`.as("groups"),
      })
      .from(distributionTotal)
      .crossJoin(distributionGroups),
  );
  return {
    queries: [
      extensionValues,
      extensionCounts,
      extensionMissing,
      distributionBase,
      distributionTotal,
      distributionSelected,
      distributionGroups,
      distributionSummary,
    ] as const,
    summary: distributionSummary,
  };
}

function binDistributionCtes(
  database: Database,
  selectedViews: WithSubquery & {
    readonly bin_id: SQLWrapper;
    readonly item_id: SQLWrapper;
  },
  distribution: Extract<
    NonNullable<SearchInput["distribution"]>,
    { by: "bin" }
  >,
  cursor: SearchDistributionCursor | undefined,
) {
  const distributionBase = database.$with("distribution_base").as(
    database
      .select({
        group_key: sql`${selectedViews.bin_id} COLLATE "C"`.as("group_key"),
        bin_id: sql`${selectedViews.bin_id}`.as("bin_id"),
        item_count: sql`count(DISTINCT ${selectedViews.item_id})::text`.as(
          "item_count",
        ),
      })
      .from(selectedViews)
      .groupBy(sql`${selectedViews.bin_id}`),
  );
  const distributionTotal = database.$with("distribution_total").as(
    database
      .select({
        total_items: sql`count(DISTINCT ${selectedViews.item_id})::text`.as(
          "total_items",
        ),
      })
      .from(selectedViews),
  );
  const afterCursor =
    cursor === undefined
      ? sql`true`
      : sql`${distributionBase.group_key} COLLATE "C" > ${cursor.groupKey} COLLATE "C"`;
  const distributionSelected = database.$with("distribution_selected").as(
    database
      .select()
      .from(distributionBase)
      .where(afterCursor)
      .orderBy(asc(sql`${distributionBase.group_key} COLLATE "C"`))
      .limit(distribution.limit + 1),
  );
  const distributionGroups = database.$with("distribution_groups").as(
    database
      .select({
        groups: sql`coalesce(
          jsonb_agg(
            jsonb_build_object(
              'kind', 'bin'::text,
              'binId', ${distributionSelected.bin_id},
              'itemCount', ${distributionSelected.item_count},
              '__distributionKey', ${distributionSelected.group_key}
            ) ORDER BY ${distributionSelected.group_key} COLLATE "C" ASC
          ),
          '[]'::jsonb
        )`.as("groups"),
      })
      .from(distributionSelected),
  );
  const distributionSummary = database.$with("distribution_summary").as(
    database
      .select({
        total_items: sql`${distributionTotal.total_items}`.as("total_items"),
        groups: sql`${distributionGroups.groups}`.as("groups"),
      })
      .from(distributionTotal)
      .crossJoin(distributionGroups),
  );
  return {
    queries: [
      distributionBase,
      distributionTotal,
      distributionSelected,
      distributionGroups,
      distributionSummary,
    ] as const,
    summary: distributionSummary,
  };
}

function emptyDistributionCtes(
  database: Database,
  fixedSnapshot: WithSubquery,
) {
  const summary = database.$with("distribution_summary").as(
    database
      .select({
        total_items: sql`NULL::text`.as("total_items"),
        groups: sql`'[]'::jsonb`.as("groups"),
      })
      .from(fixedSnapshot),
  );
  return { queries: [summary] as const, summary };
}

function decodeJsonValue(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function extensionScopeBins(value: unknown): ExtensionScopeBin[] {
  const decoded = decodeJsonValue(value);
  if (!Array.isArray(decoded))
    throw new Error("Search query returned an invalid extension scope.");
  return decoded.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("binId" in entry) ||
      typeof entry.binId !== "string" ||
      !("sourceAdapter" in entry)
    ) {
      throw new Error("Search query returned an invalid extension scope bin.");
    }
    return {
      binId: entry.binId,
      sourceAdapter: sourceAdapterManifestStoredSchema.parse(
        entry.sourceAdapter,
      ),
    };
  });
}

function extensionFilterValues(filter: ArchiveExtensionFieldFilter) {
  return "value" in filter
    ? [{ value: filter.value, path: ["value"] as const }]
    : filter.values.map((value, index) => ({
        value,
        path: ["values", index] as const,
      }));
}

function extensionFilterValueMatches(
  value: string | number | boolean,
  type: string | undefined,
  allowedValues: readonly (string | number | boolean)[] | undefined,
) {
  const matchesType =
    type === "string"
      ? typeof value === "string"
      : type === "number"
        ? typeof value === "number"
        : type === "integer"
          ? typeof value === "number" && Number.isInteger(value)
          : type === "boolean"
            ? typeof value === "boolean"
            : false;
  return (
    matchesType &&
    (allowedValues === undefined ||
      allowedValues.some((allowedValue) => Object.is(allowedValue, value)))
  );
}

function validateExtensionScope(
  input: SearchInput,
  value: unknown,
): ArchiveSearchOperation<never> | undefined {
  const extensions = input.extensions;
  const distribution =
    input.distribution?.by === "extension" ? input.distribution : undefined;
  const sourceAdapterId =
    extensions?.sourceAdapterId ?? distribution?.sourceAdapterId;
  if (sourceAdapterId === undefined) return undefined;
  const adapterPath =
    extensions === undefined
      ? (["distribution", "sourceAdapterId"] as const)
      : (["extensions", "sourceAdapterId"] as const);
  const bins = extensionScopeBins(value);
  if (bins.length === 0) {
    return invalidInput("No configured bin uses the selected source adapter.", [
      ...adapterPath,
    ]);
  }
  if (input.bins !== undefined && bins.length !== input.bins.length) {
    return invalidInput(
      "Every selected bin must exist and use the declared source adapter.",
      ["bins"],
    );
  }

  for (const bin of bins) {
    if (bin.sourceAdapter.id !== sourceAdapterId) {
      return invalidInput(
        "Extension operations require bins from the declared source adapter only.",
        ["bins"],
      );
    }
    const discovery = {
      sourceAdapterId: bin.sourceAdapter.id,
      sourceAdapterVersion: bin.sourceAdapter.version,
      binId: bin.binId,
    };
    const fields = discoverSourceAdapterExtensionFields({
      sourceAdapterId: bin.sourceAdapter.id,
      sourceAdapterVersion: bin.sourceAdapter.version,
      extensionsSchema: bin.sourceAdapter.extensionsSchema,
    }).fields;
    if (extensions !== undefined) {
      for (const [fieldName, filter] of Object.entries(extensions.filters)) {
        const path = ["extensions", "filters", fieldName] as const;
        const field = fields[fieldName];
        if (field === undefined) {
          return invalidInput(
            `The selected adapter does not declare the top-level extension field "${fieldName}".`,
            path,
            { discovery },
          );
        }
        if (!field.operations.includes(filter.op)) {
          return invalidInput(
            `The extension field "${fieldName}" does not support "${filter.op}"; allowed operations: ${field.operations.join(", ") || "none"}.`,
            [...path, "op"],
            { allowedOperations: [...field.operations], discovery },
          );
        }
        const itemOperation = filter.op === "has" || filter.op === "hasAny";
        const type = itemOperation ? field.itemType : field.type;
        const allowedValues = itemOperation
          ? field.allowedItemValues
          : field.allowedValues;
        for (const candidate of extensionFilterValues(filter)) {
          if (
            !extensionFilterValueMatches(candidate.value, type, allowedValues)
          ) {
            return invalidInput(
              `The value for extension field "${fieldName}" must match its declared ${type ?? "scalar"} type${allowedValues === undefined ? "" : ` and allowed values ${JSON.stringify(allowedValues)}`}.`,
              [...path, ...candidate.path],
              {
                ...(allowedValues === undefined
                  ? {}
                  : itemOperation
                    ? { allowedItemValues: [...allowedValues] }
                    : { allowedValues: [...allowedValues] }),
                allowedOperations: [...field.operations],
                discovery,
              },
            );
          }
        }
      }
    }
    if (distribution !== undefined) {
      const path = ["distribution", "field"] as const;
      const field = fields[distribution.field];
      if (field === undefined) {
        return invalidInput(
          `The selected adapter does not declare the top-level extension field "${distribution.field}".`,
          path,
          { discovery },
        );
      }
      if (field.operations.length === 0) {
        return invalidInput(
          `The extension field "${distribution.field}" is not a scalar or scalar list.`,
          path,
          { discovery },
        );
      }
    }
  }
  return undefined;
}

/**
 * Read the write clock and the full page in one MVCC statement. Archive
 * observations are append-only; filtering both CTEs by this sequence fixes the
 * logical snapshot without an uncancellable transaction-start queue wait.
 */
function pageQuery(
  database: Database,
  input: SearchInput,
  snapshot: SearchCursor["snapshot"] | undefined,
  cursor: SearchCursor | undefined,
  distributionCursor: SearchDistributionCursor | undefined,
  aliases: ArchiveTimeZoneAliases,
) {
  const clock = database.$with("clock").as(
    database
      .select({
        current_sequence: sql`${archiveWriteClock.lastSequence}`.as(
          "current_sequence",
        ),
      })
      .from(archiveWriteClock)
      .where(eq(archiveWriteClock.clockId, 1)),
  );
  const snapshotSequence =
    snapshot === undefined
      ? sql`${clock.current_sequence}`
      : sql`${BigInt(snapshot.asOf)}::bigint`;
  const snapshotMode = snapshot?.mode ?? "current";
  const fixedSnapshot = database.$with("fixed_snapshot").as(
    database
      .select({
        archive_sequence: sql`${snapshotSequence}`.as("archive_sequence"),
        mode: sql`${snapshotMode}::text`.as("mode"),
        invalid: sql`${snapshotSequence} > ${clock.current_sequence}`.as(
          "invalid",
        ),
      })
      .from(clock),
  );
  const extensionScopeBinFilter =
    input.extensions === undefined
      ? input.distribution?.by === "extension"
        ? inArray(binConfigurations.id, input.bins!)
        : sql`false`
      : input.bins === undefined
        ? sql`${binConfigurations.sourceAdapter}->>'id' = ${input.extensions.sourceAdapterId}`
        : inArray(binConfigurations.id, input.bins);
  const extensionScopeBins = database.$with("extension_scope_bins").as(
    database
      .select({
        id: sql`${binConfigurations.id}`.as("id"),
        source_adapter: sql`${binConfigurations.sourceAdapter}`.as(
          "source_adapter",
        ),
      })
      .from(binConfigurations)
      .where(extensionScopeBinFilter),
  );
  const extensionScope = database.$with("extension_scope").as(
    database
      .select({
        bins: sql`coalesce(
          jsonb_agg(
            jsonb_build_object(
              'binId', ${extensionScopeBins.id},
              'sourceAdapter', ${extensionScopeBins.source_adapter}
            ) ORDER BY ${extensionScopeBins.id} COLLATE "C" ASC
          ),
          '[]'::jsonb
        )`.as("bins"),
      })
      .from(extensionScopeBins),
  );
  const latestConditions: SQL[] = [
    sql`${fixedSnapshot.invalid} IS FALSE`,
    lte(archiveCommits.archiveSequence, fixedSnapshot.archive_sequence),
  ];
  if (input.bins !== undefined) {
    latestConditions.push(inArray(archiveCommits.binId, input.bins));
  } else if (input.extensions !== undefined) {
    latestConditions.push(
      exists(
        database
          .select({ found: sql`1` })
          .from(extensionScopeBins)
          .where(eq(extensionScopeBins.id, archiveCommits.binId)),
      ),
    );
  }
  const latest = database.$with("latest").as(
    database
      .selectDistinctOn([archiveObservations.itemId, archiveCommits.binId], {
        item_id: sql`${archiveObservations.itemId}`.as("item_id"),
        revision_id: sql`${archiveObservations.revisionId}`.as("revision_id"),
        bin_id: sql`${archiveCommits.binId}`.as("bin_id"),
        archive_seq: sql`${archiveCommits.archiveSequence}`.as("archive_seq"),
        observed_at: sql`${archiveCommits.observedAt}`.as("observed_at"),
        recorded_at: sql`${archiveCommits.recordedAt}`.as("recorded_at"),
        namespace: sql`${archiveItems.namespace}`.as("namespace"),
        source_key: sql`${archiveItems.sourceKey}`.as("source_key"),
        state_data: sql`${archiveRevisions.stateData}`.as("state_data"),
      })
      .from(archiveObservations)
      .innerJoin(
        archiveCommits,
        eq(archiveCommits.commitId, archiveObservations.commitId),
      )
      .innerJoin(
        archiveItems,
        eq(archiveItems.itemId, archiveObservations.itemId),
      )
      .innerJoin(
        archiveRevisions,
        and(
          eq(archiveRevisions.itemId, archiveObservations.itemId),
          eq(archiveRevisions.revisionId, archiveObservations.revisionId),
        ),
      )
      .crossJoin(fixedSnapshot)
      .where(and(...latestConditions) ?? sql`true`)
      .orderBy(
        asc(archiveObservations.itemId),
        asc(archiveCommits.binId),
        desc(archiveCommits.archiveSequence),
        desc(archiveCommits.commitId),
        desc(archiveObservations.ordinal),
      ),
  );
  const latestStateData = sql`${latest.state_data}`;

  const decision =
    input.timeWindow === undefined
      ? undefined
      : input.timeWindow.field === "observedAt"
        ? {
            status: sql`CASE WHEN ${latest.observed_at} >= ${localDateBoundarySql(input.timeWindow.from, input.timeWindow.timeZone)} AND ${latest.observed_at} < ${localDateBoundarySql(input.timeWindow.until, input.timeWindow.timeZone)} THEN 'certain' ELSE 'outside' END`,
            reason: sql`NULL::text`,
            sortValue: sql`${latest.observed_at}`,
          }
        : sourceTimeWindowDecisionSql(
            sourceTimeFieldSql(latestStateData, input.timeWindow.field),
            input.timeWindow,
            aliases,
          );
  const classified = database.$with("classified").as(
    database
      .select({
        item_id: sql`${latest.item_id}`.as("item_id"),
        revision_id: sql`${latest.revision_id}`.as("revision_id"),
        bin_id: sql`${latest.bin_id}`.as("bin_id"),
        archive_seq: sql`${latest.archive_seq}`.as("archive_seq"),
        observed_at: sql`${latest.observed_at}`.as("observed_at"),
        recorded_at: sql`${latest.recorded_at}`.as("recorded_at"),
        namespace: sql`${latest.namespace}`.as("namespace"),
        source_key: sql`${latest.source_key}`.as("source_key"),
        state_data: latestStateData.as("state_data"),
        time_status: (decision?.status ?? sql`NULL::text`).as("time_status"),
        time_reason: (decision?.reason ?? sql`NULL::text`).as("time_reason"),
        sort_value:
          decision?.sortValue === undefined
            ? sql`NULL::timestamptz`.as("sort_value")
            : decision.sortValue.as("sort_value"),
      })
      .from(latest)
      .where(
        and(
          textMatches(input, latestStateData),
          extensionMatches(input, latestStateData),
        ),
      ),
  );
  const selectedViews = database.$with("selected_views").as(
    database
      .select()
      .from(classified)
      .where(
        input.timeWindow === undefined
          ? sql`true`
          : eq(classified.time_status, input.timeWindow.review),
      ),
  );
  const items = database.$with("items").as(
    database
      .select({
        item_id: sql`${selectedViews.item_id}`.as("item_id"),
        namespace: sql`${selectedViews.namespace}`.as("namespace"),
        source_key: sql`${selectedViews.source_key}`.as("source_key"),
        observed_at: sql`max(${selectedViews.observed_at})`.as("observed_at"),
        sort_value:
          input.timeWindow === undefined
            ? sql`NULL::timestamptz`.as("sort_value")
            : sql`max(${selectedViews.sort_value})`.as("sort_value"),
      })
      .from(selectedViews)
      .groupBy(
        selectedViews.item_id,
        selectedViews.namespace,
        selectedViews.source_key,
      ),
  );
  const afterCursor =
    cursor === undefined || !input.includeCandidates
      ? sql`true`
      : input.timeWindow === undefined
        ? sql`(${items.observed_at} < ${new Date(cursor.observedAt)}::timestamptz OR (${items.observed_at} = ${new Date(cursor.observedAt)}::timestamptz AND ${items.item_id} > ${cursor.itemId}::uuid))`
        : cursor.timeSortValue === null
          ? sql`(${items.sort_value} IS NULL AND ${items.item_id} > ${cursor.itemId}::uuid)`
          : sql`(${items.sort_value} < ${cursor.timeSortValue}::timestamptz OR (${items.sort_value} = ${cursor.timeSortValue}::timestamptz AND ${items.item_id} > ${cursor.itemId}::uuid) OR ${items.sort_value} IS NULL)`;
  const selectedOrder =
    input.timeWindow === undefined
      ? [desc(items.observed_at), asc(items.item_id)]
      : [sql`${items.sort_value} DESC NULLS LAST`, asc(items.item_id)];
  const selected = database.$with("selected").as(
    database
      .select({
        item_id: sql`${items.item_id}`.as("item_id"),
        namespace: sql`${items.namespace}`.as("namespace"),
        source_key: sql`${items.source_key}`.as("source_key"),
        observed_at: sql`${items.observed_at}`.as("observed_at"),
        sort_value: sql`${items.sort_value}`.as("sort_value"),
      })
      .from(items)
      .crossJoin(fixedSnapshot)
      .where(
        and(
          not(fixedSnapshot.invalid),
          input.includeCandidates ? afterCursor : sql`false`,
        ),
      )
      .orderBy(...selectedOrder)
      .limit(input.limit + 1),
  );
  const distribution = input.distribution;
  const distributionCtes =
    distribution === undefined
      ? emptyDistributionCtes(database, fixedSnapshot)
      : distribution.by === "bin"
        ? binDistributionCtes(
            database,
            selectedViews,
            distribution,
            distributionCursor,
          )
        : distribution.by === "date"
          ? dateDistributionCtes(
              database,
              selectedViews,
              distribution,
              distributionCursor,
              aliases,
            )
          : extensionDistributionCtes(
              database,
              selectedViews,
              distribution,
              distributionCursor,
            );
  const distributionResult = database.$with("distribution_result").as(
    database
      .select({
        total_items: sql`${distributionCtes.summary.total_items}`.as(
          "total_items",
        ),
        groups: sql`${distributionCtes.summary.groups}`.as("groups"),
      })
      .from(distributionCtes.summary),
  );
  const selectedTimeMatch =
    input.timeWindow === undefined
      ? sql`'{}'::jsonb`
      : sql`jsonb_build_object(
        'timeMatch', CASE ${selectedViews.time_status}
          WHEN 'certain' THEN jsonb_build_object('status', 'certain')
          WHEN 'undetermined' THEN jsonb_build_object(
            'status', 'undetermined',
            'reason', ${selectedViews.time_reason}
          )
          ELSE '{}'::jsonb
        END
      )`;
  const selectedResultTime =
    input.timeWindow === undefined
      ? sql`'{}'::jsonb`
      : sql`jsonb_build_object(
        'timeStatus', ${input.timeWindow.review}::text,
        '__searchTimeSortValue', to_char(
          ${selected.sort_value} AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      )`;
  const selectedMatches = database.$with("selected_matches").as(
    database
      .select({
        item_id: sql`${selectedViews.item_id}`.as("item_id"),
        matches: sql`jsonb_agg(
          jsonb_build_object(
            'binId', ${selectedViews.bin_id},
            'revisionId', ${selectedViews.revision_id},
            'archiveSeq', ${selectedViews.archive_seq}::text,
            'observedAt', ${selectedViews.observed_at},
            'recordedAt', ${selectedViews.recorded_at},
            'title', ${selectedViews.state_data}->'title',
            'sourcePublishedAt', ${selectedViews.state_data}->'sourcePublishedAt',
            'sourceModifiedAt', ${selectedViews.state_data}->'sourceModifiedAt'
          ) || CASE
            WHEN ${selectedViews.state_data} ? 'sourceRef'
            THEN jsonb_build_object('sourceRef', ${selectedViews.state_data}->'sourceRef')
            ELSE '{}'::jsonb
          END || ${selectedTimeMatch}
          ORDER BY ${selectedViews.observed_at} DESC, ${selectedViews.bin_id} COLLATE "C" ASC
        )`.as("matches"),
      })
      .from(selectedViews)
      .innerJoin(selected, eq(selected.item_id, selectedViews.item_id))
      .groupBy(selectedViews.item_id),
  );
  const selectedAggregateOrder =
    input.timeWindow === undefined
      ? sql`${selected.observed_at} DESC, ${selected.item_id} ASC`
      : sql`${selected.sort_value} DESC NULLS LAST, ${selected.item_id} ASC`;
  const page = database.$with("page").as(
    database
      .select({
        results: sql`coalesce(
          jsonb_agg(
            jsonb_build_object(
              'itemId', ${selected.item_id},
              'sourceKey', jsonb_build_object(
                'namespace', ${selected.namespace},
                'key', ${selected.source_key}
              ),
              'title', ${selectedMatches.matches}->0->'title',
              'sourcePublishedAt', ${selectedMatches.matches}->0->'sourcePublishedAt',
              'sourceModifiedAt', ${selectedMatches.matches}->0->'sourceModifiedAt',
              'observedAt', ${selected.observed_at},
              'matches', ${selectedMatches.matches}
            ) || ${selectedResultTime}
            ORDER BY ${selectedAggregateOrder}
          ),
          '[]'::jsonb
        )`.as("results"),
      })
      .from(selected)
      .innerJoin(
        selectedMatches,
        eq(selectedMatches.item_id, selected.item_id),
      ),
  );
  const timeSummary = database.$with("time_summary").as(
    database
      .select({
        certain_items: sql`count(DISTINCT ${classified.item_id}) FILTER (
          WHERE ${classified.time_status} = 'certain'
        )::text`.as("certain_items"),
        undetermined_items: sql`count(DISTINCT ${classified.item_id}) FILTER (
          WHERE ${classified.time_status} = 'undetermined'
        )::text`.as("undetermined_items"),
      })
      .from(classified),
  );

  return database
    .with(
      clock,
      fixedSnapshot,
      extensionScopeBins,
      extensionScope,
      latest,
      classified,
      selectedViews,
      items,
      selected,
      selectedMatches,
      page,
      timeSummary,
      ...distributionCtes.queries,
      distributionResult,
    )
    .select({
      snapshotAsOf: sql`${fixedSnapshot.archive_sequence}::text`.as(
        "snapshotAsOf",
      ),
      snapshotMode: sql`${fixedSnapshot.mode}`.as("snapshotMode"),
      invalidSnapshot: sql`${fixedSnapshot.invalid}`.as("invalidSnapshot"),
      results: sql`${page.results}`.as("results"),
      extensionBins: sql`${extensionScope.bins}`.as("extensionBins"),
      certainItems: sql`${timeSummary.certain_items}`.as("certainItems"),
      undeterminedItems: sql`${timeSummary.undetermined_items}`.as(
        "undeterminedItems",
      ),
      distributionGroups: sql`${distributionResult.groups}`.as(
        "distributionGroups",
      ),
      distributionTotalItems: sql`${distributionResult.total_items}`.as(
        "distributionTotalItems",
      ),
    })
    .from(fixedSnapshot)
    .crossJoin(page)
    .crossJoin(extensionScope)
    .crossJoin(timeSummary)
    .crossJoin(distributionResult);
}

/** Resolve archive-local aliases without changing stored SourceTime values. */
function timeZoneDiscoveryQuery(
  database: Database,
  input: SearchInput,
  snapshot: SearchCursor["snapshot"] | undefined,
  fields: readonly ("sourcePublishedAt" | "sourceModifiedAt")[],
) {
  const clock = database.$with("clock").as(
    database
      .select({
        current_sequence: sql`${archiveWriteClock.lastSequence}`.as(
          "current_sequence",
        ),
      })
      .from(archiveWriteClock)
      .where(eq(archiveWriteClock.clockId, 1)),
  );
  const snapshotSequence =
    snapshot === undefined
      ? sql`${clock.current_sequence}`
      : sql`${BigInt(snapshot.asOf)}::bigint`;
  const snapshotMode = snapshot?.mode ?? "current";
  const fixedSnapshot = database.$with("fixed_snapshot").as(
    database
      .select({
        archive_sequence: sql`${snapshotSequence}`.as("archive_sequence"),
        mode: sql`${snapshotMode}::text`.as("mode"),
        invalid: sql`${snapshotSequence} > ${clock.current_sequence}`.as(
          "invalid",
        ),
      })
      .from(clock),
  );
  const latestConditions: SQL[] = [
    sql`${fixedSnapshot.invalid} IS FALSE`,
    lte(archiveCommits.archiveSequence, fixedSnapshot.archive_sequence),
  ];
  if (input.bins !== undefined) {
    latestConditions.push(inArray(archiveCommits.binId, input.bins));
  }
  const latest = database.$with("latest").as(
    database
      .selectDistinctOn([archiveObservations.itemId, archiveCommits.binId], {
        item_id: sql`${archiveObservations.itemId}`.as("item_id"),
        bin_id: sql`${archiveCommits.binId}`.as("bin_id"),
        state_data: sql`${archiveRevisions.stateData}`.as("state_data"),
      })
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
      .crossJoin(fixedSnapshot)
      .where(and(...latestConditions) ?? sql`true`)
      .orderBy(
        asc(archiveObservations.itemId),
        asc(archiveCommits.binId),
        desc(archiveCommits.archiveSequence),
        desc(archiveCommits.commitId),
        desc(archiveObservations.ordinal),
      ),
  );
  const zoneQueries = fields.map((field) =>
    database
      .select({
        time_zone: sql`${latest.state_data}->${field}->>'timeZone'`.as(
          "time_zone",
        ),
      })
      .from(latest),
  );
  const firstZoneQuery = zoneQueries[0];
  if (firstZoneQuery === undefined) {
    throw new Error("Search time-zone query requires at least one field.");
  }
  const secondZoneQuery = zoneQueries[1];
  const sourceTimeZoneQuery =
    secondZoneQuery === undefined
      ? firstZoneQuery
      : unionAll(firstZoneQuery, secondZoneQuery, ...zoneQueries.slice(2));
  const sourceTimeZones = database
    .$with("source_time_zones")
    .as(sourceTimeZoneQuery);
  const timeZones = database.$with("time_zones").as(
    database
      .select({
        time_zones: sql`coalesce(
          jsonb_agg(
            DISTINCT
            ${sourceTimeZones.time_zone}
            ORDER BY ${sourceTimeZones.time_zone}
          ) FILTER (WHERE ${sourceTimeZones.time_zone} IS NOT NULL),
          '[]'::jsonb
        )`.as("time_zones"),
      })
      .from(sourceTimeZones),
  );

  return database
    .with(clock, fixedSnapshot, latest, sourceTimeZones, timeZones)
    .select({
      snapshotAsOf: sql`${fixedSnapshot.archive_sequence}::text`.as(
        "snapshotAsOf",
      ),
      snapshotMode: sql`${fixedSnapshot.mode}`.as("snapshotMode"),
      invalidSnapshot: sql`${fixedSnapshot.invalid}`.as("invalidSnapshot"),
      timeZones: sql`${timeZones.time_zones}`.as("timeZones"),
    })
    .from(fixedSnapshot)
    .crossJoin(timeZones);
}

function decodeSearchResults(value: unknown): unknown[] {
  const decoded =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(decoded)) {
    throw new Error("Search query returned an invalid result page.");
  }
  return decoded;
}

/** Build the fixed archive search operation with one server-side request budget. */
export function createArchiveSearchOperation(
  database: Database,
  executeQuery: CancellableQueryExecutor,
  budgetMs: number,
): Pick<ArchiveOperations, "searchArchive"> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) {
    throw new RangeError("Search request budget must be a positive integer.");
  }
  return {
    async searchArchive(
      request: ArchiveSearchRequest,
      context?: ArchiveOperationContext,
    ): Promise<
      ArchiveSearchOperation<ReturnType<typeof archiveSearchPageSchema.parse>>
    > {
      const deadline =
        context?.deadline ?? createArchiveQueryDeadline(budgetMs);
      const signal = context?.signal;
      assertArchiveQueryActive(deadline, signal);
      const checked = archiveSearchInputSchema.safeParse(request);
      if (!checked.success) {
        const issue = archiveSearchInputIssue(request, checked.error.issues);
        return invalidInput(
          issue?.message ?? "Search request is invalid.",
          (issue?.path ?? []).map((part) =>
            typeof part === "symbol" ? String(part) : part,
          ),
          archiveSearchInputDiagnostic(request, issue),
        );
      }

      const input = checked.data;
      const hash = queryHash(input);
      const requestedCursor = input.cursor;
      const cursor =
        requestedCursor === undefined
          ? undefined
          : decodeSearchCursor(requestedCursor);
      const distribution = input.distribution;
      const requestedDistributionCursor = distribution?.cursor;
      const distributionCursor =
        requestedDistributionCursor === undefined
          ? undefined
          : decodeSearchDistributionCursor(requestedDistributionCursor);
      const distributionHash =
        distribution === undefined
          ? undefined
          : distributionQueryHash(input, distribution);
      if (
        requestedCursor !== undefined &&
        (cursor === undefined ||
          cursor.queryHash !== hash ||
          (input.timeWindow !== undefined &&
            cursor !== undefined &&
            !("timeSortValue" in cursor)) ||
          (input.asOf !== undefined && cursor.snapshot.asOf !== input.asOf))
      ) {
        return invalidInput(
          "Search cursor is invalid or belongs to another query.",
          ["cursor"],
        );
      }
      if (
        requestedDistributionCursor !== undefined &&
        (distributionCursor === undefined ||
          distributionHash === undefined ||
          distributionCursor.queryHash !== distributionHash ||
          (input.asOf !== undefined &&
            distributionCursor.snapshot.asOf !== input.asOf))
      ) {
        return invalidInput(
          "Distribution cursor is invalid or belongs to another query.",
          ["distribution", "cursor"],
        );
      }
      if (
        cursor !== undefined &&
        distributionCursor !== undefined &&
        cursor.snapshot.asOf !== distributionCursor.snapshot.asOf
      ) {
        return invalidInput(
          "Candidate and distribution cursors must use the same archive cut.",
          ["distribution", "cursor"],
        );
      }

      const snapshot =
        cursor?.snapshot ??
        distributionCursor?.snapshot ??
        (input.asOf === undefined
          ? undefined
          : { asOf: input.asOf, mode: "asOf" as const });

      try {
        let resolvedQuerySnapshot = snapshot;
        let aliases: ArchiveTimeZoneAliases = new Map();
        const timeZoneFields = new Set<
          "sourcePublishedAt" | "sourceModifiedAt"
        >();
        if (
          input.timeWindow !== undefined &&
          input.timeWindow.field !== "observedAt"
        ) {
          timeZoneFields.add(input.timeWindow.field);
        }
        if (
          input.distribution?.by === "date" &&
          input.distribution.field !== "observedAt"
        ) {
          timeZoneFields.add(input.distribution.field);
        }
        if (timeZoneFields.size > 0) {
          const [zoneRow] =
            await executeArchiveQueryWithinDeadline<SearchZoneRow>(
              executeQuery,
              timeZoneDiscoveryQuery(database, input, snapshot, [
                ...timeZoneFields,
              ]),
              deadline,
              signal,
            );
          if (zoneRow === undefined) {
            throw new Error("Search time-zone query returned no snapshot row.");
          }
          if (zoneRow.invalidSnapshot) {
            return invalidInput(
              cursor === undefined
                ? "Archive cut cannot be later than the current sequence."
                : "Search cursor is invalid or belongs to another query.",
              [cursor === undefined ? "asOf" : "cursor"],
            );
          }
          resolvedQuerySnapshot = archiveSnapshotSchema.parse({
            asOf: zoneRow.snapshotAsOf,
            mode: zoneRow.snapshotMode,
          });
          const timeZones = decodeSearchResults(zoneRow.timeZones).filter(
            (timeZone): timeZone is string => typeof timeZone === "string",
          );
          aliases = archiveTimeZoneAliases(timeZones);
        }
        const [row] = await executeArchiveQueryWithinDeadline<SearchPageRow>(
          executeQuery,
          pageQuery(
            database,
            input,
            resolvedQuerySnapshot,
            cursor,
            distributionCursor,
            aliases,
          ),
          deadline,
          signal,
        );
        if (row === undefined) {
          throw new Error("Search query did not return its snapshot row.");
        }
        if (row.invalidSnapshot) {
          return invalidInput(
            cursor === undefined
              ? "Archive cut cannot be later than the current sequence."
              : "Search cursor is invalid or belongs to another query.",
            [cursor === undefined ? "asOf" : "cursor"],
          );
        }
        const extensionScopeFailure = validateExtensionScope(
          input,
          row.extensionBins,
        );
        if (extensionScopeFailure !== undefined) return extensionScopeFailure;
        const resolvedSnapshot = archiveSnapshotSchema.parse({
          asOf: row.snapshotAsOf,
          mode: row.snapshotMode,
        });
        const rows = decodeSearchResults(row.results);
        const candidateHasMore =
          input.includeCandidates && rows.length > input.limit;
        const selectedRows = candidateHasMore
          ? rows.slice(0, input.limit)
          : input.includeCandidates
            ? rows
            : [];
        const lastSelected = selectedRows.at(-1);
        const timeSortValue =
          input.timeWindow === undefined
            ? undefined
            : lastSelected !== undefined &&
                typeof lastSelected === "object" &&
                lastSelected !== null &&
                !Array.isArray(lastSelected) &&
                "__searchTimeSortValue" in lastSelected
              ? typeof (lastSelected as Record<string, unknown>)[
                  "__searchTimeSortValue"
                ] === "string"
                ? ((lastSelected as Record<string, unknown>)[
                    "__searchTimeSortValue"
                  ] as string)
                : null
              : null;
        const pageRows = selectedRows.map((result) => {
          if (
            typeof result !== "object" ||
            result === null ||
            Array.isArray(result)
          ) {
            return result;
          }
          const { __searchTimeSortValue: _internalSortValue, ...publicResult } =
            result as Record<string, unknown>;
          return publicResult;
        });
        const page = archiveSearchPageSchema.parse({
          snapshot: resolvedSnapshot,
          candidatesIncluded: input.includeCandidates,
          results: pageRows,
          ...(input.timeWindow === undefined
            ? {}
            : {
                timeSummary: {
                  certainItems: row.certainItems ?? "0",
                  undeterminedItems: row.undeterminedItems ?? "0",
                },
              }),
          hasMore: candidateHasMore,
        });
        const last = page.results.at(-1);
        const nextCursor =
          candidateHasMore && last !== undefined
            ? encodeSearchCursor({
                version: 1,
                queryHash: hash,
                snapshot: resolvedSnapshot,
                observedAt: new Date(last.observedAt).toISOString(),
                ...(input.timeWindow === undefined
                  ? {}
                  : { timeSortValue: timeSortValue ?? null }),
                itemId: last.itemId,
              })
            : undefined;
        const rawDistributionGroups = decodeSearchResults(
          row.distributionGroups,
        );
        const distributionHasMore =
          distribution !== undefined &&
          rawDistributionGroups.length > distribution.limit;
        const selectedDistributionGroups = distributionHasMore
          ? rawDistributionGroups.slice(0, distribution!.limit)
          : rawDistributionGroups;
        let nextDistributionCursor: string | undefined;
        const lastDistributionGroup = selectedDistributionGroups.at(-1);
        const lastDistributionGroupKey =
          typeof lastDistributionGroup === "object" &&
          lastDistributionGroup !== null &&
          !Array.isArray(lastDistributionGroup)
            ? (lastDistributionGroup as Record<string, unknown>)[
                "__distributionKey"
              ]
            : undefined;
        if (
          distributionHasMore &&
          distributionHash !== undefined &&
          typeof lastDistributionGroupKey === "string"
        ) {
          nextDistributionCursor = encodeSearchDistributionCursor({
            version: 1,
            queryHash: distributionHash,
            snapshot: resolvedSnapshot,
            groupKey: lastDistributionGroupKey,
          });
        }
        const publicDistributionGroups = selectedDistributionGroups.map(
          (group) => {
            if (
              typeof group !== "object" ||
              group === null ||
              Array.isArray(group)
            ) {
              return group;
            }
            const record = group as Record<string, unknown>;
            const { __distributionKey: _internalKey, ...publicGroup } = record;
            return publicGroup;
          },
        );
        const completedDistribution =
          distribution === undefined
            ? undefined
            : archiveSearchDistributionPageSchema.parse({
                ...(distribution.by === "date"
                  ? {
                      by: distribution.by,
                      field: distribution.field,
                      period: distribution.period,
                      timeZone: distribution.timeZone,
                    }
                  : distribution.by === "extension"
                    ? {
                        by: distribution.by,
                        sourceAdapterId: distribution.sourceAdapterId,
                        field: distribution.field,
                      }
                    : { by: distribution.by }),
                totalItems: row.distributionTotalItems ?? "0",
                groups: publicDistributionGroups,
                hasMore: distributionHasMore,
                ...(nextDistributionCursor === undefined
                  ? {}
                  : { nextCursor: nextDistributionCursor }),
              });
        const completedPage = archiveSearchPageSchema.parse({
          ...page,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          ...(completedDistribution === undefined
            ? {}
            : { distribution: completedDistribution }),
        });
        assertArchiveQueryActive(deadline, signal);
        return { ok: true, value: completedPage };
      } catch (error) {
        if (
          context?.signal?.aborted ||
          error instanceof ArchiveRequestCancelled
        ) {
          throw new ArchiveRequestCancelled();
        }
        if (
          error instanceof ArchiveQueryBudgetExceeded ||
          databaseErrorCode(error) === "57014"
        ) {
          return budgetFailure(budgetMs);
        }
        throw error;
      }
    },
  };
}
