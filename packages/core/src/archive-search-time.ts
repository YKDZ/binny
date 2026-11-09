import type { ArchiveSearchTimeWindow } from "@binny/contracts";
import { sql, type SQL } from "drizzle-orm";

const fixedOffsetPattern = "^(?:[+-](?:0[0-9]|1[0-3]):[0-5][0-9]|[+-]14:00)$";

export type ArchiveTimeZoneAliases = ReadonlyMap<string, string>;

export type SourceTimeBoundsSql = {
  readonly precision: SQL;
  readonly value: SQL;
  readonly timeZone: SQL;
  readonly localStart: SQL;
  readonly localEnd: SQL;
  readonly start: SQL;
  readonly end: SQL;
  readonly possibleStart: SQL;
  readonly possibleEnd: SQL;
  readonly sortValue: SQL;
};

/** Resolve aliases for calculations without changing a stored source fact. */
export function canonicalizeArchiveTimeZone(timeZone: string): string {
  if (/^(?:[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/u.test(timeZone)) {
    return timeZone;
  }
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions()
    .timeZone;
}

/** Build an internal-only map for zone aliases present in the archive snapshot. */
export function archiveTimeZoneAliases(
  timeZones: readonly string[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const timeZone of new Set(timeZones)) {
    const canonical = canonicalizeArchiveTimeZone(timeZone);
    if (canonical !== timeZone) aliases.set(timeZone, canonical);
  }
  return aliases;
}

function normalizedTimeZoneSql(
  timeZone: SQL,
  aliases: ArchiveTimeZoneAliases,
): SQL {
  const mappings = [...aliases].map(
    ([alias, canonical]) => sql`WHEN ${alias} THEN ${canonical}`,
  );
  if (mappings.length === 0) return timeZone;
  return sql`CASE ${timeZone} ${sql.join(mappings, sql` `)} ELSE ${timeZone} END`;
}

function localTimestampAtZone(
  localTimestamp: SQL,
  timeZone: SQL,
  aliases: ArchiveTimeZoneAliases,
): SQL {
  const normalizedTimeZone = normalizedTimeZoneSql(timeZone, aliases);
  return sql`CASE
    WHEN ${timeZone} ~ ${fixedOffsetPattern}
    THEN (${localTimestamp}) AT TIME ZONE ((${timeZone})::interval)
    ELSE (${localTimestamp}) AT TIME ZONE ((${normalizedTimeZone})::text)
  END`;
}

/** Return the real absolute interval represented by one stored SourceTime. */
export function sourceTimeBoundsSql(
  sourceTime: SQL,
  aliases: ArchiveTimeZoneAliases,
): SourceTimeBoundsSql {
  const precision = sql`${sourceTime}->>'precision'`;
  const value = sql`${sourceTime}->>'value'`;
  const timeZone = sql`${sourceTime}->>'timeZone'`;
  const localStartDate = sql`CASE ${precision}
    WHEN 'day' THEN (${value})::date
    WHEN 'month' THEN (${value} || '-01')::date
    WHEN 'year' THEN (${value} || '-01-01')::date
    ELSE NULL::date
  END`;
  const localStart = sql`${localStartDate}::timestamp`;
  const periodLength = sql`CASE ${precision}
    WHEN 'day' THEN interval '1 day'
    WHEN 'month' THEN interval '1 month'
    WHEN 'year' THEN interval '1 year'
    ELSE NULL::interval
  END`;
  const localEnd = sql`${localStart} + ${periodLength}`;
  // A zone-free calendar value may map anywhere in this conservative envelope.
  // It is used only to prove disjointness/containment and to order written dates.
  const possibleStart = sql`((${localStart}) AT TIME ZONE 'UTC') - interval '24 hours'`;
  const possibleEnd = sql`((${localEnd}) AT TIME ZONE 'UTC') + interval '24 hours'`;
  const start = sql`CASE
    WHEN ${value} IS NULL THEN NULL::timestamptz
    WHEN ${precision} = 'instant' THEN (${value})::timestamptz
    WHEN ${timeZone} IS NULL THEN NULL::timestamptz
    ELSE ${localTimestampAtZone(localStart, timeZone, aliases)}
  END`;
  const end = sql`CASE
    WHEN ${precision} = 'instant' OR ${timeZone} IS NULL THEN NULL::timestamptz
    ELSE ${localTimestampAtZone(localEnd, timeZone, aliases)}
  END`;
  const sortValue = sql`CASE
    WHEN ${value} IS NULL THEN NULL::timestamptz
    WHEN ${precision} = 'instant' THEN ${start}
    WHEN ${timeZone} IS NULL THEN (${localStart}) AT TIME ZONE 'UTC'
    ELSE ${start}
  END`;
  return {
    precision,
    value,
    timeZone,
    localStart,
    localEnd,
    start,
    end,
    possibleStart,
    possibleEnd,
    sortValue,
  };
}

/** Convert a local date boundary to an instant using the supplied zone rules. */
export function localDateBoundarySql(date: string, timeZone: string): SQL {
  const zone = canonicalizeArchiveTimeZone(timeZone);
  const zoneSql = /^(?:[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/u.test(zone)
    ? sql`${zone}::interval`
    : sql`${zone}::text`;
  return sql`(${date}::date::timestamp AT TIME ZONE ${zoneSql})`;
}

/**
 * Classify one source time against a half-open local calendar window. Coarse
 * source values match only when their whole represented period is contained.
 */
export function sourceTimeWindowDecisionSql(
  sourceTime: SQL,
  window: ArchiveSearchTimeWindow,
  aliases: ArchiveTimeZoneAliases,
): {
  readonly status: SQL;
  readonly reason: SQL;
  readonly sortValue: SQL;
} {
  const bounds = sourceTimeBoundsSql(sourceTime, aliases);
  const windowStart = localDateBoundarySql(window.from, window.timeZone);
  const windowEnd = localDateBoundarySql(window.until, window.timeZone);
  const status = sql`CASE
    WHEN ${bounds.value} IS NULL THEN 'undetermined'
    WHEN ${bounds.precision} = 'instant'
      AND ${bounds.start} >= ${windowStart}
      AND ${bounds.start} < ${windowEnd}
    THEN 'certain'
    WHEN ${bounds.precision} = 'instant' THEN 'outside'
    WHEN ${bounds.timeZone} IS NULL
      AND (${bounds.possibleEnd} <= ${windowStart}
        OR ${bounds.possibleStart} >= ${windowEnd})
    THEN 'outside'
    WHEN ${bounds.timeZone} IS NULL
      AND ${bounds.possibleStart} >= ${windowStart}
      AND ${bounds.possibleEnd} <= ${windowEnd}
    THEN 'certain'
    WHEN ${bounds.timeZone} IS NULL THEN 'undetermined'
    WHEN ${bounds.start} >= ${windowStart}
      AND ${bounds.end} <= ${windowEnd}
    THEN 'certain'
    WHEN ${bounds.end} <= ${windowStart}
      OR ${bounds.start} >= ${windowEnd}
    THEN 'outside'
    ELSE 'undetermined'
  END`;
  const reason = sql`CASE
    WHEN ${bounds.value} IS NULL THEN 'missingTime'
    WHEN ${bounds.precision} <> 'instant' AND ${bounds.timeZone} IS NULL
    THEN 'missingTimeZone'
    WHEN ${bounds.precision} <> 'instant' THEN 'precisionOverlapsBoundary'
    ELSE NULL
  END`;
  return { status, reason, sortValue: bounds.sortValue };
}

/** Return the fields needed to classify a SourceTime window in a fixed view. */
export function sourceTimeFieldSql(
  stateData: SQL,
  field: Extract<
    ArchiveSearchTimeWindow["field"],
    "sourcePublishedAt" | "sourceModifiedAt"
  >,
): SQL {
  return sql`${stateData}->${field}`;
}
