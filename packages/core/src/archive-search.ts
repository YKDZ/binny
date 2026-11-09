import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  archiveIdentifierSchema,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
  archiveSnapshotSchema,
  type ArchiveOperations,
  type ArchiveSearchOperation,
  type ArchiveSearchRequest,
} from "@binny/contracts";
import { databaseErrorCode, type CancellableQueryExecutor } from "@binny/db";
import { sql, type SQL } from "drizzle-orm";

import { canonicalJson } from "./archive-common.ts";

type SearchCursor = {
  readonly version: 1;
  readonly queryHash: string;
  readonly snapshot: ReturnType<typeof archiveSnapshotSchema.parse>;
  readonly observedAt: string;
  readonly itemId: string;
};
type SearchInput = ReturnType<typeof archiveSearchInputSchema.parse>;
type SearchPageRow = {
  readonly snapshotAsOf: string;
  readonly snapshotMode: string;
  readonly invalidSnapshot: boolean;
  readonly results: unknown;
};

class SearchBudgetExceeded extends Error {}

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeSearchCursor(cursor: string): SearchCursor | undefined {
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
      !("snapshot" in value) ||
      !("observedAt" in value) ||
      typeof value.observedAt !== "string" ||
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
      itemId: itemId.data,
    };
  } catch {
    return undefined;
  }
}

function invalidInput(message: string, path: readonly (string | number)[]) {
  return {
    ok: false as const,
    status: 400 as const,
    error: { code: "invalid_input" as const, message, path: [...path] },
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

function remainingBudgetMs(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new SearchBudgetExceeded();
  return remaining;
}

function queryHash(input: SearchInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        bins: input.bins ?? null,
        text: input.text ?? null,
      }),
    )
    .digest("hex");
}

function textMatches(input: SearchInput) {
  if (input.text === undefined) return sql`true`;

  const groups = input.text.groups.map((group) => {
    const terms = group.map((term) => {
      const titleMatch = sql`strpos(lower(coalesce(latest.state_data->>'title', '')), lower(${term})) > 0`;
      // Check stored body representations independently; joining them can create
      // a literal match that no individual representation contains.
      // `searchText` is a body fallback only when no rendered representation
      // exists, because some producers include the title in that field.
      const bodyMatch = sql`(
        strpos(lower(coalesce(latest.state_data->'body'->>'text', '')), lower(${term})) > 0
        OR strpos(lower(coalesce(latest.state_data->'body'->>'markdown', '')), lower(${term})) > 0
        OR strpos(lower(coalesce(latest.state_data->'body'->>'html', '')), lower(${term})) > 0
        OR (
          NOT (
            coalesce(latest.state_data->'body' ? 'text', false)
            OR coalesce(latest.state_data->'body' ? 'markdown', false)
            OR coalesce(latest.state_data->'body' ? 'html', false)
          )
          AND strpos(lower(coalesce(latest.state_data->'body'->>'searchText', '')), lower(${term})) > 0
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

/**
 * Read the write clock and the full page in one MVCC statement. Archive
 * observations are append-only; filtering both CTEs by this sequence fixes the
 * logical snapshot without an uncancellable transaction-start queue wait.
 */
function pageQuery(
  input: SearchInput,
  snapshot: SearchCursor["snapshot"] | undefined,
  cursor: SearchCursor | undefined,
) {
  const snapshotSequence =
    snapshot === undefined
      ? sql`clock.current_sequence`
      : sql`${BigInt(snapshot.asOf)}::bigint`;
  const snapshotMode = snapshot?.mode ?? "current";
  const latestConditions = [
    sql`NOT fixed_snapshot.invalid`,
    sql`commit.archive_seq <= fixed_snapshot.archive_sequence`,
  ];
  if (input.bins !== undefined) {
    latestConditions.push(
      sql`commit.bin_id IN (${sql.join(
        input.bins.map((binId) => sql`${binId}`),
        sql`, `,
      )})`,
    );
  }

  const afterCursor =
    cursor === undefined
      ? sql`true`
      : sql`(items.observed_at < ${new Date(cursor.observedAt)}::timestamptz OR (items.observed_at = ${new Date(cursor.observedAt)}::timestamptz AND items.item_id > ${cursor.itemId}::uuid))`;

  return sql<SearchPageRow[]>`
    WITH clock AS (
      SELECT last_seq AS current_sequence
      FROM archive_write_clock
      WHERE clock_id = 1
    ), fixed_snapshot AS (
      SELECT
        ${snapshotSequence} AS archive_sequence,
        ${snapshotMode}::text AS mode,
        ${snapshotSequence} > clock.current_sequence AS invalid
      FROM clock
    ), latest AS (
      SELECT DISTINCT ON (observation.item_id, commit.bin_id)
        observation.item_id,
        observation.revision_id,
        commit.bin_id,
        commit.archive_seq,
        commit.observed_at,
        commit.recorded_at,
        item.namespace,
        item.source_key,
        revision.state_data
      FROM archive_observation AS observation
      JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
      JOIN archive_item AS item ON item.item_id = observation.item_id
      JOIN archive_revision AS revision
        ON revision.item_id = observation.item_id
       AND revision.revision_id = observation.revision_id
      CROSS JOIN fixed_snapshot
      WHERE ${sql.join(latestConditions, sql` AND `)}
      ORDER BY observation.item_id, commit.bin_id, commit.archive_seq DESC, commit.commit_id DESC, observation.ordinal DESC
    ), matched AS (
      SELECT latest.*
      FROM latest
      WHERE ${textMatches(input)}
    ), items AS (
      SELECT
        matched.item_id,
        matched.namespace,
        matched.source_key,
        max(matched.observed_at) AS observed_at,
        jsonb_agg(
          jsonb_build_object(
            'binId', matched.bin_id,
            'revisionId', matched.revision_id,
            'archiveSeq', matched.archive_seq::text,
            'observedAt', matched.observed_at,
            'recordedAt', matched.recorded_at,
            'title', matched.state_data->'title',
            'sourcePublishedAt', matched.state_data->'sourcePublishedAt',
            'sourceModifiedAt', matched.state_data->'sourceModifiedAt'
          ) || CASE
            WHEN matched.state_data ? 'sourceRef'
            THEN jsonb_build_object('sourceRef', matched.state_data->'sourceRef')
            ELSE '{}'::jsonb
          END
          ORDER BY matched.observed_at DESC, matched.bin_id COLLATE "C" ASC
        ) AS matches
      FROM matched
      GROUP BY matched.item_id, matched.namespace, matched.source_key
    ), selected AS (
      SELECT items.*
      FROM items
      CROSS JOIN fixed_snapshot
      WHERE NOT fixed_snapshot.invalid AND ${afterCursor}
      ORDER BY items.observed_at DESC, items.item_id ASC
      LIMIT ${input.limit + 1}
    ), page AS (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'itemId', selected.item_id,
            'sourceKey', jsonb_build_object(
              'namespace', selected.namespace,
              'key', selected.source_key
            ),
            'title', selected.matches->0->'title',
            'sourcePublishedAt', selected.matches->0->'sourcePublishedAt',
            'sourceModifiedAt', selected.matches->0->'sourceModifiedAt',
            'observedAt', selected.observed_at,
            'matches', selected.matches
          )
          ORDER BY selected.observed_at DESC, selected.item_id ASC
        ),
        '[]'::jsonb
      ) AS results
      FROM selected
    )
    SELECT
      fixed_snapshot.archive_sequence::text AS "snapshotAsOf",
      fixed_snapshot.mode AS "snapshotMode",
      fixed_snapshot.invalid AS "invalidSnapshot",
      page.results
    FROM fixed_snapshot
    CROSS JOIN page
  `;
}

function decodeSearchResults(value: unknown): unknown[] {
  const decoded =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(decoded)) {
    throw new Error("Search query returned an invalid result page.");
  }
  return decoded;
}

async function queryWithinBudget<Row extends Record<string, unknown>>(
  executeQuery: CancellableQueryExecutor,
  query: SQL<Row[]>,
  deadline: number,
): Promise<readonly Row[]> {
  const remaining = remainingBudgetMs(deadline);
  const pending = executeQuery<Row>(query);
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    pending.rows.then(
      (rows) => ({ kind: "rows" as const, rows }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), remaining);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome.kind === "timeout") {
    pending.cancel();
    throw new SearchBudgetExceeded();
  }
  if (outcome.kind === "error") throw outcome.error;
  remainingBudgetMs(deadline);
  return outcome.rows as readonly Row[];
}

/** Build the fixed archive search operation with one server-side request budget. */
export function createArchiveSearchOperation(
  executeQuery: CancellableQueryExecutor,
  budgetMs: number,
): Pick<ArchiveOperations, "searchArchive"> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) {
    throw new RangeError("Search request budget must be a positive integer.");
  }
  return {
    async searchArchive(
      request: ArchiveSearchRequest,
    ): Promise<
      ArchiveSearchOperation<ReturnType<typeof archiveSearchPageSchema.parse>>
    > {
      const deadline = performance.now() + budgetMs;
      const checked = archiveSearchInputSchema.safeParse(request);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return invalidInput(
          issue?.message ?? "Search request is invalid.",
          (issue?.path ?? []).map((part) =>
            typeof part === "symbol" ? String(part) : part,
          ),
        );
      }

      const input = checked.data;
      const hash = queryHash(input);
      const requestedCursor = input.cursor;
      const cursor =
        requestedCursor === undefined
          ? undefined
          : decodeSearchCursor(requestedCursor);
      if (
        requestedCursor !== undefined &&
        (cursor === undefined ||
          cursor.queryHash !== hash ||
          (input.asOf !== undefined && cursor.snapshot.asOf !== input.asOf))
      ) {
        return invalidInput(
          "Search cursor is invalid or belongs to another query.",
          ["cursor"],
        );
      }

      const snapshot =
        cursor?.snapshot ??
        (input.asOf === undefined
          ? undefined
          : { asOf: input.asOf, mode: "asOf" as const });

      try {
        const [row] = await queryWithinBudget<SearchPageRow>(
          executeQuery,
          pageQuery(input, snapshot, cursor),
          deadline,
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
        const resolvedSnapshot = archiveSnapshotSchema.parse({
          asOf: row.snapshotAsOf,
          mode: row.snapshotMode,
        });
        const rows = decodeSearchResults(row.results);
        const hasMore = rows.length > input.limit;
        const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
        const page = archiveSearchPageSchema.parse({
          snapshot: resolvedSnapshot,
          results: pageRows,
          hasMore,
        });
        const last = page.results.at(-1);
        const nextCursor =
          hasMore && last !== undefined
            ? encodeSearchCursor({
                version: 1,
                queryHash: hash,
                snapshot: resolvedSnapshot,
                observedAt: new Date(last.observedAt).toISOString(),
                itemId: last.itemId,
              })
            : undefined;
        const completedPage = archiveSearchPageSchema.parse({
          ...page,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        });
        remainingBudgetMs(deadline);
        return { ok: true, value: completedPage };
      } catch (error) {
        if (
          error instanceof SearchBudgetExceeded ||
          databaseErrorCode(error) === "57014"
        ) {
          return budgetFailure(budgetMs);
        }
        throw error;
      }
    },
  };
}
