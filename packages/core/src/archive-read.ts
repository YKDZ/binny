import {
  archiveCommitSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveRelationCursorSchema,
  archiveRelationEntrySchema,
  archiveRelationPageSchema,
  archiveRelationStateSchema,
  archiveRevisionReadSchema,
  archiveSnapshotSequenceSchema,
  archiveTimelineCursorSchema,
  archiveTimelinePageSchema,
  binIdSchema,
  type ArchiveCommit,
  type ArchiveItemRead,
  type ArchiveOperation,
  type ArchiveOperations,
  type ArchiveRelationEntry,
  type ArchiveRelationOptions,
} from "@binny/contracts";

import {
  failure,
  isoTimestamp,
  optionalText,
  validationFailure,
} from "./archive-common.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import type { CoreDatabase } from "./database.ts";

type CommitRow = {
  readonly commit_id: string;
  readonly archive_seq: string;
  readonly bin_id: string;
  readonly run_id: string | null;
  readonly collector_version: string | null;
  readonly observed_at: Date;
  readonly recorded_at: Date;
};

type ClockRow = {
  readonly last_seq: string;
};

type CommitItemRow = {
  readonly item_id: string;
  readonly revision_id: string;
  readonly namespace: string;
  readonly source_key: string;
};

type CommitItemGapRow = {
  readonly item_id: string;
  readonly ordinal: number;
  readonly namespace: string;
  readonly source_key: string;
};

type CommitRelationGapRow = {
  readonly relation_id: string;
  readonly ordinal: number;
};

type ItemRow = {
  readonly item_id: string;
  readonly namespace: string;
  readonly source_key: string;
};

type RevisionRow = {
  readonly revision_id: string;
  readonly state_hash: string;
  readonly state_data: unknown;
};

type ViewRow = CommitRow & {
  readonly revision_id: string;
  readonly diagnostics: unknown;
  readonly state_data: unknown;
};

type ObservationRow = CommitRow & {
  readonly revision_id: string;
  readonly diagnostics: unknown;
  readonly ordinal: number;
  readonly source_modified_at: string | null;
};

type TimelineRow = CommitRow & {
  readonly kind: "item" | "relation" | "gap";
  readonly item_id: string | null;
  readonly relation_id: string | null;
  readonly relation_revision_id: string | null;
  readonly relation_state_data: unknown;
  readonly revision_id: string | null;
  readonly ordinal: number;
  readonly source_modified_at: string | null;
  readonly gap_subject_kind: "item" | "relation" | null;
  readonly gap_namespace: string | null;
  readonly gap_source_key: string | null;
};

type RelationIdentityRow = {
  readonly relation_id: string;
  readonly from_item_id: string;
  readonly target_item_id: string | null;
  readonly target_source_ref: string | null;
  readonly created_seq: string;
};

type RelationReadRow = RelationIdentityRow & {
  readonly state_status: "observed" | "withdrawn" | "unknown" | "deleted";
  readonly relation_revision_id: string | null;
  readonly state_data: unknown;
  readonly relation_commit_id: string | null;
  readonly relation_archive_seq: string | null;
  readonly relation_ordinal: number | null;
  readonly relation_observed_at: Date | null;
  readonly relation_recorded_at: Date | null;
  readonly relation_run_id: string | null;
  readonly relation_collector_version: string | null;
};

type EndpointRow = ItemRow & {
  readonly revision_id: string | null;
};

export type ResolvedSnapshot = {
  readonly asOf: string;
  readonly mode: "current" | "asOf";
};

type RevisionReadRow = RevisionRow & ItemRow;

export async function resolveSnapshot(
  transaction: ArchiveTransaction,
  requestedAsOf?: string,
): Promise<ArchiveOperation<ResolvedSnapshot>> {
  // 先读共享写时钟以固定可重复读快照；以后提交的观察序号一定大于此截点。
  await transaction.unsafe(
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
  );
  const clocks = await transaction<ClockRow[]>`
    SELECT last_seq::text AS last_seq
    FROM archive_write_clock
    WHERE clock_id = 1
  `;
  const currentSequence = clocks[0]?.last_seq;
  if (currentSequence === undefined) {
    throw new Error("归档写入时钟尚未初始化。");
  }
  const checkedAsOf =
    requestedAsOf === undefined
      ? undefined
      : archiveSnapshotSequenceSchema.safeParse(requestedAsOf);
  if (checkedAsOf !== undefined && !checkedAsOf.success) {
    return validationFailure(
      checkedAsOf.error.issues.map((issue) => ({
        message: issue.message,
        path: ["asOf", ...issue.path],
      })),
    );
  }
  const asOf = checkedAsOf?.data ?? currentSequence;
  if (BigInt(asOf) > BigInt(currentSequence)) {
    return failure(400, "invalid_input", "归档截点不能晚于当前已记录的资料。", [
      "asOf",
    ]);
  }
  return {
    ok: true,
    value: {
      asOf,
      mode: requestedAsOf === undefined ? "current" : "asOf",
    },
  };
}

function encodeTimelineCursor(
  cursor: ReturnType<typeof archiveTimelineCursorSchema.parse>,
): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeTimelineCursor(
  cursor: string,
): ReturnType<typeof archiveTimelineCursorSchema.parse> | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) return undefined;
    return archiveTimelineCursorSchema.parse(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

function encodeRelationCursor(
  cursor: ReturnType<typeof archiveRelationCursorSchema.parse>,
): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeRelationCursor(
  cursor: string,
): ReturnType<typeof archiveRelationCursorSchema.parse> | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) return undefined;
    return archiveRelationCursorSchema.parse(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

function optionalDiagnostics(value: unknown): {
  readonly diagnostics?: unknown;
} {
  return value === null ? {} : { diagnostics: value };
}

export async function readCommit(
  transaction: ArchiveTransaction,
  commitId: string,
): Promise<ArchiveCommit> {
  const rows = await transaction<CommitRow[]>`
    SELECT
      commit_id,
      archive_seq::text AS archive_seq,
      bin_id,
      run_id,
      collector_version,
      observed_at,
      recorded_at
    FROM archive_commit
    WHERE commit_id = ${commitId}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("幂等回执引用的归档提交不存在。");
  }

  const items = await transaction<CommitItemRow[]>`
    SELECT
      observation.item_id,
      observation.revision_id,
      item.namespace,
      item.source_key
    FROM archive_observation AS observation
    JOIN archive_item AS item ON item.item_id = observation.item_id
    WHERE observation.commit_id = ${commitId}
    ORDER BY observation.ordinal
  `;
  const relations = await transaction<
    {
      readonly relation_id: string;
      readonly ordinal: number;
      readonly relation_revision_id: string | null;
      readonly state_data: unknown;
    }[]
  >`
    SELECT
      observation.relation_id,
      observation.ordinal,
      observation.relation_revision_id,
      revision.state_data
    FROM archive_relation_observation AS observation
    LEFT JOIN archive_relation_revision AS revision
      ON revision.relation_id = observation.relation_id
      AND revision.relation_revision_id = observation.relation_revision_id
    WHERE observation.commit_id = ${commitId}
    ORDER BY observation.ordinal
  `;
  const itemGaps = await transaction<CommitItemGapRow[]>`
    SELECT
      gap.item_id,
      gap.ordinal,
      deletion.namespace,
      deletion.source_key
    FROM archive_item_observation_gap AS gap
    JOIN archive_item_deletion AS deletion ON deletion.item_id = gap.item_id
    WHERE gap.commit_id = ${commitId}
    ORDER BY gap.ordinal
  `;
  const relationGaps = await transaction<CommitRelationGapRow[]>`
    SELECT relation_id, ordinal
    FROM archive_relation_observation_gap
    WHERE commit_id = ${commitId}
    ORDER BY ordinal
  `;

  return archiveCommitSchema.parse({
    commitId: row.commit_id,
    archiveSeq: row.archive_seq,
    binId: row.bin_id,
    ...optionalText("runId", row.run_id),
    ...optionalText("collectorVersion", row.collector_version),
    observedAt: isoTimestamp(row.observed_at),
    recordedAt: isoTimestamp(row.recorded_at),
    items: items.map((item) => ({
      itemId: item.item_id,
      revisionId: item.revision_id,
      sourceKey: { namespace: item.namespace, key: item.source_key },
    })),
    relations: relations.map((relation) =>
      relation.relation_revision_id === null
        ? {
            relationId: relation.relation_id,
            ordinal: relation.ordinal,
            status: "withdrawn" as const,
          }
        : {
            relationId: relation.relation_id,
            ordinal: relation.ordinal,
            status: "observed" as const,
            revisionId: relation.relation_revision_id,
            state: relation.state_data,
          },
    ),
    ...(itemGaps.length === 0 && relationGaps.length === 0
      ? {}
      : {
          gaps: {
            items: itemGaps.map((item) => ({
              itemId: item.item_id,
              ordinal: item.ordinal,
              sourceKey: { namespace: item.namespace, key: item.source_key },
            })),
            relations: relationGaps.map((relation) => ({
              relationId: relation.relation_id,
              ordinal: relation.ordinal,
            })),
          },
        }),
  });
}

async function readItem(
  transaction: ArchiveTransaction,
  itemId: string,
  snapshot: ResolvedSnapshot,
  binId?: string,
): Promise<ArchiveOperation<ArchiveItemRead>> {
  const items = await transaction<ItemRow[]>`
    SELECT item_id, namespace, source_key
    FROM archive_item
    WHERE item_id = ${itemId}
  `;
  const item = items[0];
  if (item === undefined) {
    const deletions = await transaction<{ readonly item_id: string }[]>`
      SELECT item_id
      FROM archive_item_deletion
      WHERE item_id = ${itemId}
    `;
    if (deletions[0] !== undefined) {
      return failure(
        404,
        "item_deleted",
        "这个条目已硬删除；历史只保留删除缺口，原资料不再可读。",
        ["itemId"],
      );
    }
    return failure(404, "item_not_found", "没有找到这个归档条目。", ["itemId"]);
  }

  const visibleRows = await transaction<{ readonly item_id: string }[]>`
    SELECT observation.item_id
    FROM archive_observation AS observation
    JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
    WHERE observation.item_id = ${itemId}
      AND commit.archive_seq <= ${snapshot.asOf}::bigint
    LIMIT 1
  `;
  if (visibleRows[0] === undefined) {
    return failure(404, "item_not_found", "这个条目在所选归档截点尚未记录。", [
      "itemId",
    ]);
  }

  const revisionRows = await transaction<
    { readonly revision_id: string; readonly state_hash: string }[]
  >`
    SELECT
      revision.revision_id,
      revision.state_hash,
      MIN(commit.archive_seq) AS first_archive_seq
    FROM archive_revision AS revision
    JOIN archive_observation AS observation
      ON observation.item_id = revision.item_id
      AND observation.revision_id = revision.revision_id
    JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
    WHERE observation.item_id = ${itemId}
      AND commit.archive_seq <= ${snapshot.asOf}::bigint
      AND (${binId ?? null}::text IS NULL OR commit.bin_id = ${binId ?? null})
    GROUP BY revision.revision_id, revision.state_hash
    ORDER BY first_archive_seq, revision.revision_id
  `;
  const observationRows = await transaction<ObservationRow[]>`
    SELECT
      commit.commit_id,
      commit.archive_seq::text AS archive_seq,
      commit.bin_id,
      commit.run_id,
      commit.collector_version,
      commit.observed_at,
      commit.recorded_at,
      observation.revision_id,
      observation.diagnostics,
      observation.ordinal,
      revision.state_data->>'sourceModifiedAt' AS source_modified_at
    FROM archive_observation AS observation
    JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
    JOIN archive_revision AS revision
      ON revision.item_id = observation.item_id
      AND revision.revision_id = observation.revision_id
    WHERE observation.item_id = ${itemId}
      AND commit.archive_seq <= ${snapshot.asOf}::bigint
      AND (${binId ?? null}::text IS NULL OR commit.bin_id = ${binId ?? null})
    ORDER BY commit.archive_seq, observation.ordinal, commit.commit_id
  `;
  const viewRows = await transaction<ViewRow[]>`
    SELECT DISTINCT ON (commit.bin_id)
      commit.commit_id,
      commit.archive_seq::text AS archive_seq,
      commit.bin_id,
      commit.run_id,
      commit.collector_version,
      commit.observed_at,
      commit.recorded_at,
      observation.revision_id,
      observation.diagnostics,
      revision.state_data
    FROM archive_observation AS observation
    JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
    JOIN archive_revision AS revision
      ON revision.item_id = observation.item_id
      AND revision.revision_id = observation.revision_id
    WHERE observation.item_id = ${itemId}
      AND commit.archive_seq <= ${snapshot.asOf}::bigint
      AND (${binId ?? null}::text IS NULL OR commit.bin_id = ${binId ?? null})
    ORDER BY
      commit.bin_id,
      commit.archive_seq DESC,
      observation.ordinal DESC,
      commit.commit_id DESC
  `;

  return {
    ok: true,
    value: archiveItemReadSchema.parse({
      itemId: item.item_id,
      sourceKey: { namespace: item.namespace, key: item.source_key },
      snapshot,
      views: viewRows.map((row) => ({
        binId: row.bin_id,
        archiveSeq: row.archive_seq,
        revisionId: row.revision_id,
        observedAt: isoTimestamp(row.observed_at),
        recordedAt: isoTimestamp(row.recorded_at),
        ...optionalText("runId", row.run_id),
        ...optionalText("collectorVersion", row.collector_version),
        state: row.state_data,
        ...optionalDiagnostics(row.diagnostics),
      })),
      revisions: revisionRows.map((revision) => ({
        revisionId: revision.revision_id,
        stateHash: revision.state_hash,
      })),
      observations: observationRows.map((row) => ({
        commitId: row.commit_id,
        archiveSeq: row.archive_seq,
        ordinal: row.ordinal,
        binId: row.bin_id,
        revisionId: row.revision_id,
        ...(row.source_modified_at === null
          ? {}
          : { sourceModifiedAt: row.source_modified_at }),
        observedAt: isoTimestamp(row.observed_at),
        recordedAt: isoTimestamp(row.recorded_at),
        ...optionalText("runId", row.run_id),
        ...optionalText("collectorVersion", row.collector_version),
        ...optionalDiagnostics(row.diagnostics),
      })),
    }),
  };
}

async function readTimelinePage(
  transaction: ArchiveTransaction,
  itemId: string,
  snapshot: ResolvedSnapshot,
  binId: string | undefined,
  after:
    | ReturnType<typeof archiveTimelineCursorSchema.parse>["after"]
    | undefined,
  limit: number,
): Promise<
  ArchiveOperation<ReturnType<typeof archiveTimelinePageSchema.parse>>
> {
  const visibleRows = await transaction<{ readonly item_id: string }[]>`
    SELECT ${itemId}::uuid AS item_id
    FROM archive_observation AS observation
    JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
    WHERE observation.item_id = ${itemId}
      AND commit.archive_seq <= ${snapshot.asOf}::bigint
    UNION ALL
    SELECT ${itemId}::uuid AS item_id
    FROM archive_relation_observation AS observation
    JOIN archive_relation AS relation
      ON relation.relation_id = observation.relation_id
    WHERE (
      relation.from_item_id = ${itemId}
      OR relation.target_item_id = ${itemId}
    )
      AND observation.archive_seq <= ${snapshot.asOf}::bigint
    UNION ALL
    SELECT ${itemId}::uuid AS item_id
    FROM archive_item_observation_gap AS gap
    JOIN archive_commit AS commit ON commit.commit_id = gap.commit_id
    WHERE gap.item_id = ${itemId}
      AND commit.archive_seq <= ${snapshot.asOf}::bigint
    UNION ALL
    SELECT ${itemId}::uuid AS item_id
    FROM archive_relation_observation_gap AS gap
    JOIN archive_commit AS commit ON commit.commit_id = gap.commit_id
    WHERE (
      gap.from_item_id = ${itemId}
      OR gap.target_item_id = ${itemId}
    )
      AND commit.archive_seq <= ${snapshot.asOf}::bigint
    LIMIT 1
  `;
  if (visibleRows[0] === undefined) {
    return failure(404, "item_not_found", "这个条目在所选归档截点尚未记录。", [
      "itemId",
    ]);
  }

  const rows = await transaction<TimelineRow[]>`
    SELECT event.*
    FROM (
      SELECT
        'item'::text AS kind,
        commit.commit_id,
        commit.archive_seq::text AS archive_seq,
        commit.bin_id,
        commit.run_id,
        commit.collector_version,
        commit.observed_at,
        commit.recorded_at,
        observation.item_id,
        NULL::text AS relation_id,
        NULL::uuid AS relation_revision_id,
        NULL::jsonb AS relation_state_data,
        observation.revision_id,
        observation.ordinal,
        revision.state_data->>'sourceModifiedAt' AS source_modified_at,
        NULL::text AS gap_subject_kind,
        NULL::text AS gap_namespace,
        NULL::text AS gap_source_key
      FROM archive_observation AS observation
      JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
      JOIN archive_revision AS revision
        ON revision.item_id = observation.item_id
        AND revision.revision_id = observation.revision_id
      WHERE observation.item_id = ${itemId}
        AND commit.archive_seq <= ${snapshot.asOf}::bigint
        AND (${binId ?? null}::text IS NULL OR commit.bin_id = ${binId ?? null})

      UNION ALL

      SELECT
        'relation'::text AS kind,
        commit.commit_id,
        commit.archive_seq::text AS archive_seq,
        commit.bin_id,
        commit.run_id,
        commit.collector_version,
        commit.observed_at,
        commit.recorded_at,
        NULL::uuid AS item_id,
        observation.relation_id,
        observation.relation_revision_id,
        relation_revision.state_data AS relation_state_data,
        observation.relation_revision_id AS revision_id,
        observation.ordinal,
        NULL::text AS source_modified_at,
        NULL::text AS gap_subject_kind,
        NULL::text AS gap_namespace,
        NULL::text AS gap_source_key
      FROM archive_relation_observation AS observation
      JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
      JOIN archive_relation AS relation
        ON relation.relation_id = observation.relation_id
      LEFT JOIN archive_relation_revision AS relation_revision
        ON relation_revision.relation_id = observation.relation_id
        AND relation_revision.relation_revision_id = observation.relation_revision_id
      WHERE (
        relation.from_item_id = ${itemId}
        OR relation.target_item_id = ${itemId}
      )
        AND observation.archive_seq <= ${snapshot.asOf}::bigint
        AND (${binId ?? null}::text IS NULL OR observation.bin_id = ${binId ?? null})

      UNION ALL

      SELECT
        'gap'::text AS kind,
        commit.commit_id,
        commit.archive_seq::text AS archive_seq,
        commit.bin_id,
        commit.run_id,
        commit.collector_version,
        commit.observed_at,
        commit.recorded_at,
        gap.item_id AS item_id,
        NULL::text AS relation_id,
        NULL::uuid AS relation_revision_id,
        NULL::jsonb AS relation_state_data,
        NULL::uuid AS revision_id,
        gap.ordinal,
        NULL::text AS source_modified_at,
        'item'::text AS gap_subject_kind,
        deletion.namespace AS gap_namespace,
        deletion.source_key AS gap_source_key
      FROM archive_item_observation_gap AS gap
      JOIN archive_commit AS commit ON commit.commit_id = gap.commit_id
      JOIN archive_item_deletion AS deletion ON deletion.item_id = gap.item_id
      WHERE gap.item_id = ${itemId}
        AND commit.archive_seq <= ${snapshot.asOf}::bigint
        AND (${binId ?? null}::text IS NULL OR commit.bin_id = ${binId ?? null})

      UNION ALL

      SELECT
        'gap'::text AS kind,
        commit.commit_id,
        commit.archive_seq::text AS archive_seq,
        commit.bin_id,
        commit.run_id,
        commit.collector_version,
        commit.observed_at,
        commit.recorded_at,
        NULL::uuid AS item_id,
        gap.relation_id,
        NULL::uuid AS relation_revision_id,
        NULL::jsonb AS relation_state_data,
        NULL::uuid AS revision_id,
        gap.ordinal,
        NULL::text AS source_modified_at,
        'relation'::text AS gap_subject_kind,
        NULL::text AS gap_namespace,
        NULL::text AS gap_source_key
      FROM archive_relation_observation_gap AS gap
      JOIN archive_commit AS commit ON commit.commit_id = gap.commit_id
      WHERE (
        gap.from_item_id = ${itemId}
        OR gap.target_item_id = ${itemId}
      )
        AND commit.archive_seq <= ${snapshot.asOf}::bigint
        AND (${binId ?? null}::text IS NULL OR commit.bin_id = ${binId ?? null})
    ) AS event
    WHERE (
      ${after?.archiveSeq ?? null}::bigint IS NULL
      OR (event.archive_seq::bigint, event.ordinal, event.commit_id) > (
        ${after?.archiveSeq ?? null}::bigint,
        ${after?.ordinal ?? null}::integer,
        ${after?.commitId ?? null}::uuid
      )
    )
    ORDER BY event.archive_seq::bigint, event.ordinal, event.commit_id
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeTimelineCursor({
          version: 1,
          itemId,
          binId: binId ?? null,
          snapshot: { asOf: snapshot.asOf, mode: "asOf" },
          after: {
            archiveSeq: last.archive_seq,
            ordinal: last.ordinal,
            commitId: last.commit_id,
          },
        })
      : undefined;

  return {
    ok: true,
    value: archiveTimelinePageSchema.parse({
      itemId,
      snapshot,
      events: pageRows.map((row) => {
        const metadata = {
          commitId: row.commit_id,
          archiveSeq: row.archive_seq,
          ordinal: row.ordinal,
          binId: row.bin_id,
          ...optionalText("runId", row.run_id),
          ...optionalText("collectorVersion", row.collector_version),
          observedAt: isoTimestamp(row.observed_at),
          recordedAt: isoTimestamp(row.recorded_at),
        };
        if (row.kind === "item") {
          return {
            ...metadata,
            kind: "item" as const,
            itemId: row.item_id!,
            revisionId: row.revision_id!,
            ...(row.source_modified_at === null
              ? {}
              : { sourceModifiedAt: row.source_modified_at }),
          };
        }
        if (row.kind === "gap") {
          const subject =
            row.gap_subject_kind === "item"
              ? {
                  kind: "item" as const,
                  itemId: row.item_id!,
                  sourceKey: {
                    namespace: row.gap_namespace!,
                    key: row.gap_source_key!,
                  },
                }
              : {
                  kind: "relation" as const,
                  relationId: row.relation_id!,
                };
          return { ...metadata, kind: "gap" as const, subject };
        }
        if (row.relation_revision_id === null) {
          return {
            ...metadata,
            kind: "relation" as const,
            relationId: row.relation_id!,
            status: "withdrawn" as const,
          };
        }
        return {
          ...metadata,
          kind: "relation" as const,
          relationId: row.relation_id!,
          status: "observed" as const,
          revisionId: row.relation_revision_id,
          state: row.relation_state_data,
        };
      }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
  };
}

async function readRelationsPage(
  transaction: ArchiveTransaction,
  itemId: string,
  binId: string,
  direction: ArchiveRelationOptions["direction"],
  snapshot: ResolvedSnapshot,
  after: string | undefined,
  limit: number,
): Promise<
  ArchiveOperation<ReturnType<typeof archiveRelationPageSchema.parse>>
> {
  const rows = await transaction<RelationReadRow[]>`
    WITH relevant_relation_ids AS (
      SELECT relation.relation_id
      FROM archive_relation AS relation
      WHERE (
        (${direction}::text = 'outgoing' AND relation.from_item_id = ${itemId})
        OR (${direction}::text = 'incoming' AND relation.target_item_id = ${itemId})
      )
        AND relation.created_seq <= ${snapshot.asOf}::bigint
      UNION ALL
      SELECT gap.relation_id
      FROM archive_relation_observation_gap AS gap
      JOIN archive_commit AS commit ON commit.commit_id = gap.commit_id
      WHERE (
        (${direction}::text = 'outgoing' AND gap.from_item_id = ${itemId})
        OR (${direction}::text = 'incoming' AND gap.target_item_id = ${itemId})
      )
        AND commit.bin_id = ${binId}
        AND commit.archive_seq <= ${snapshot.asOf}::bigint
    ), gaps AS (
      SELECT DISTINCT ON (gap.relation_id)
        gap.relation_id,
        gap.from_item_id,
        gap.target_item_id,
        NULL::text AS target_source_ref,
        commit.archive_seq::text AS created_seq,
        'deleted'::text AS state_status,
        NULL::uuid AS relation_revision_id,
        NULL::jsonb AS state_data,
        commit.commit_id AS relation_commit_id,
        commit.archive_seq::text AS relation_archive_seq,
        gap.ordinal AS relation_ordinal,
        commit.observed_at AS relation_observed_at,
        commit.recorded_at AS relation_recorded_at,
        commit.run_id AS relation_run_id,
        commit.collector_version AS relation_collector_version
      FROM archive_relation_observation_gap AS gap
      JOIN archive_commit AS commit ON commit.commit_id = gap.commit_id
      WHERE gap.relation_id IN (
        SELECT relation_id FROM relevant_relation_ids
      )
        AND commit.bin_id = ${binId}
        AND commit.archive_seq <= ${snapshot.asOf}::bigint
        AND NOT EXISTS (
          SELECT 1
          FROM archive_relation_observation AS later
          WHERE later.relation_id = gap.relation_id
            AND later.bin_id = ${binId}
            AND later.archive_seq > commit.archive_seq
            AND later.archive_seq <= ${snapshot.asOf}::bigint
        )
      ORDER BY
        gap.relation_id,
        commit.archive_seq DESC,
        gap.ordinal DESC,
        gap.commit_id DESC
    ), active AS (
      SELECT
        relation.relation_id,
        relation.from_item_id,
        relation.target_item_id,
        relation.target_source_ref,
        relation.created_seq::text AS created_seq,
        CASE
          WHEN latest.commit_id IS NULL THEN 'unknown'
          WHEN latest.relation_revision_id IS NULL THEN 'withdrawn'
          ELSE 'observed'
        END AS state_status,
        latest.relation_revision_id,
        revision.state_data,
        latest.commit_id AS relation_commit_id,
        latest.archive_seq::text AS relation_archive_seq,
        latest.ordinal AS relation_ordinal,
        latest.observed_at AS relation_observed_at,
        latest.recorded_at AS relation_recorded_at,
        latest.run_id AS relation_run_id,
        latest.collector_version AS relation_collector_version
      FROM archive_relation AS relation
      LEFT JOIN LATERAL (
        SELECT
          observation.commit_id,
          observation.archive_seq,
          observation.ordinal,
          observation.relation_revision_id,
          commit.observed_at,
          commit.recorded_at,
          commit.run_id,
          commit.collector_version
        FROM archive_relation_observation AS observation
        JOIN archive_commit AS commit
          ON commit.commit_id = observation.commit_id
        WHERE observation.relation_id = relation.relation_id
          AND observation.bin_id = ${binId}
          AND observation.archive_seq <= ${snapshot.asOf}::bigint
        ORDER BY
          observation.archive_seq DESC,
          observation.ordinal DESC,
          observation.commit_id DESC
        LIMIT 1
      ) AS latest ON TRUE
      LEFT JOIN archive_relation_revision AS revision
        ON revision.relation_id = relation.relation_id
        AND revision.relation_revision_id = latest.relation_revision_id
      WHERE (
        (${direction}::text = 'outgoing' AND relation.from_item_id = ${itemId})
        OR (${direction}::text = 'incoming' AND relation.target_item_id = ${itemId})
      )
        AND relation.created_seq <= ${snapshot.asOf}::bigint
        AND NOT EXISTS (
          SELECT 1
          FROM gaps
          WHERE gaps.relation_id = relation.relation_id
        )
    ), candidates AS (
      SELECT * FROM active
      UNION ALL
      SELECT * FROM gaps
      WHERE (
        (${direction}::text = 'outgoing' AND from_item_id = ${itemId})
        OR (${direction}::text = 'incoming' AND target_item_id = ${itemId})
      )
    )
    SELECT *
    FROM candidates
    WHERE ${after ?? null}::text IS NULL OR relation_id > ${after ?? null}
    ORDER BY relation_id
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeRelationCursor({
          version: 1,
          itemId,
          binId,
          direction,
          snapshot: { asOf: snapshot.asOf, mode: "asOf" },
          after: { relationId: last.relation_id },
        })
      : undefined;

  const endpointIds = [
    ...new Set(
      pageRows.flatMap((row) =>
        row.state_status === "deleted"
          ? []
          : row.target_item_id === null
            ? [row.from_item_id]
            : [row.from_item_id, row.target_item_id],
      ),
    ),
  ];
  const endpointRows =
    endpointIds.length === 0
      ? []
      : await transaction<EndpointRow[]>`
          SELECT
            item.item_id,
            item.namespace,
            item.source_key,
            latest.revision_id
          FROM archive_item AS item
          LEFT JOIN LATERAL (
            SELECT observation.revision_id
            FROM archive_observation AS observation
            JOIN archive_commit AS commit
              ON commit.commit_id = observation.commit_id
            WHERE observation.item_id = item.item_id
              AND commit.bin_id = ${binId}
              AND commit.archive_seq <= ${snapshot.asOf}::bigint
            ORDER BY
              commit.archive_seq DESC,
              observation.ordinal DESC,
              commit.commit_id DESC
            LIMIT 1
          ) AS latest ON TRUE
          WHERE item.item_id = ANY(${transaction.array(endpointIds, 2950)})
        `;
  const endpoints = new Map(
    endpointRows.map((row) => [row.item_id, row] as const),
  );

  const relations: ArchiveRelationEntry[] = pageRows.map((row) => {
    const stateStatus = row.state_status;
    const relationObservation = () => {
      const relationCommitId = row.relation_commit_id;
      const relationArchiveSeq = row.relation_archive_seq;
      const relationOrdinal = row.relation_ordinal;
      const relationObservedAt = row.relation_observed_at;
      const relationRecordedAt = row.relation_recorded_at;
      if (
        relationCommitId === null ||
        relationArchiveSeq === null ||
        relationOrdinal === null ||
        relationObservedAt === null ||
        relationRecordedAt === null
      ) {
        throw new Error("关系观察缺少提交溯源信息。");
      }
      return {
        commitId: relationCommitId,
        archiveSeq: relationArchiveSeq,
        ordinal: relationOrdinal,
        observedAt: isoTimestamp(relationObservedAt),
        recordedAt: isoTimestamp(relationRecordedAt),
        ...optionalText("runId", row.relation_run_id),
        ...optionalText("collectorVersion", row.relation_collector_version),
      };
    };
    if (row.state_status === "deleted") {
      return archiveRelationEntrySchema.parse({
        relationId: row.relation_id,
        status: "deleted",
        observation: relationObservation(),
      });
    }
    const fromRow = endpoints.get(row.from_item_id);
    if (fromRow === undefined) {
      throw new Error("关系来源端点在读取期间消失。");
    }
    const endpoint = (item: EndpointRow) => ({
      kind: "item" as const,
      itemId: item.item_id,
      sourceKey: { namespace: item.namespace, key: item.source_key },
      status:
        item.revision_id === null
          ? ("unknown" as const)
          : ("observed" as const),
      ...(item.revision_id === null ? {} : { revisionId: item.revision_id }),
    });
    const to =
      row.target_item_id === null
        ? {
            kind: "sourceRef" as const,
            sourceRef: row.target_source_ref!,
          }
        : (() => {
            const targetRow = endpoints.get(row.target_item_id);
            if (targetRow === undefined) {
              throw new Error("关系目标端点在读取期间消失。");
            }
            return endpoint(targetRow);
          })();
    if (stateStatus === "unknown") {
      return archiveRelationEntrySchema.parse({
        relationId: row.relation_id,
        status: stateStatus,
        from: endpoint(fromRow),
        to,
      });
    }
    if (stateStatus === "withdrawn") {
      return archiveRelationEntrySchema.parse({
        relationId: row.relation_id,
        status: stateStatus,
        from: endpoint(fromRow),
        to,
        observation: relationObservation(),
      });
    }
    const revisionId = row.relation_revision_id;
    if (revisionId === null) {
      throw new Error("已观察关系缺少不可变关系版本。");
    }
    return archiveRelationEntrySchema.parse({
      relationId: row.relation_id,
      status: stateStatus,
      from: endpoint(fromRow),
      to,
      revisionId,
      state: archiveRelationStateSchema.parse(row.state_data),
      observation: relationObservation(),
    });
  });

  return {
    ok: true,
    value: archiveRelationPageSchema.parse({
      itemId,
      binId,
      direction,
      snapshot,
      relations,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
  };
}

export function createArchiveReadOperations(
  database: CoreDatabase,
): Pick<
  ArchiveOperations,
  | "getArchiveItem"
  | "getArchiveRelations"
  | "getArchiveRevision"
  | "getArchiveTimeline"
  | "getArchiveCommit"
> {
  return {
    async getArchiveItem(itemId, options) {
      const checkedId = archiveIdentifierSchema.safeParse(itemId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["itemId", ...issue.path],
          })),
        );
      }
      const checkedBinId =
        options?.binId === undefined
          ? undefined
          : binIdSchema.safeParse(options.binId);
      if (checkedBinId !== undefined && !checkedBinId.success) {
        return validationFailure(
          checkedBinId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["binId", ...issue.path],
          })),
        );
      }
      return await database.begin(async (transaction) => {
        const snapshot = await resolveSnapshot(transaction, options?.asOf);
        if (!snapshot.ok) return snapshot;
        return await readItem(
          transaction,
          checkedId.data,
          snapshot.value,
          checkedBinId?.data,
        );
      });
    },

    async getArchiveRelations(itemId, options) {
      const checkedId = archiveIdentifierSchema.safeParse(itemId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["itemId", ...issue.path],
          })),
        );
      }
      const checkedBinId = binIdSchema.safeParse(options.binId);
      if (!checkedBinId.success) {
        return validationFailure(
          checkedBinId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["binId", ...issue.path],
          })),
        );
      }
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return failure(400, "invalid_input", "关系每页必须读取 1 到 100 项。", [
          "limit",
        ]);
      }

      const cursor =
        options.cursor === undefined
          ? undefined
          : decodeRelationCursor(options.cursor);
      if (options.cursor !== undefined && cursor === undefined) {
        return failure(400, "invalid_input", "关系游标格式无效。", ["cursor"]);
      }
      if (cursor !== undefined && cursor.itemId !== checkedId.data) {
        return failure(400, "invalid_input", "关系游标不属于这个条目。", [
          "cursor",
        ]);
      }
      if (
        cursor !== undefined &&
        (cursor.binId !== checkedBinId.data ||
          cursor.direction !== options.direction)
      ) {
        return failure(400, "invalid_input", "关系游标的来源或方向不匹配。", [
          "cursor",
        ]);
      }
      if (
        cursor !== undefined &&
        options.asOf !== undefined &&
        options.asOf !== cursor.snapshot.asOf
      ) {
        return failure(400, "invalid_input", "关系游标的归档截点不匹配。", [
          "asOf",
        ]);
      }

      const requestedAsOf = cursor?.snapshot.asOf ?? options.asOf;
      return await database.begin(async (transaction) => {
        const snapshot = await resolveSnapshot(transaction, requestedAsOf);
        if (!snapshot.ok) return snapshot;
        const items = await transaction<{ readonly item_id: string }[]>`
          SELECT item_id
          FROM archive_item
          WHERE item_id = ${checkedId.data}
          UNION ALL
          SELECT item_id
          FROM archive_item_deletion
          WHERE item_id = ${checkedId.data}
        `;
        if (items[0] === undefined) {
          return failure(404, "item_not_found", "没有找到这个归档条目。", [
            "itemId",
          ]);
        }
        return await readRelationsPage(
          transaction,
          checkedId.data,
          checkedBinId.data,
          options.direction,
          snapshot.value,
          cursor?.after.relationId,
          limit,
        );
      });
    },

    async getArchiveRevision(revisionId) {
      const checkedId = archiveIdentifierSchema.safeParse(revisionId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["revisionId", ...issue.path],
          })),
        );
      }
      return await database.begin(async (transaction) => {
        await transaction.unsafe(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        const rows = await transaction<RevisionReadRow[]>`
          SELECT
            revision.revision_id,
            revision.state_hash,
            revision.state_data,
            item.item_id,
            item.namespace,
            item.source_key
          FROM archive_revision AS revision
          JOIN archive_item AS item ON item.item_id = revision.item_id
          WHERE revision.revision_id = ${checkedId.data}
        `;
        const row = rows[0];
        if (row === undefined) {
          return failure(404, "revision_not_found", "没有找到这个内容版本。", [
            "revisionId",
          ]);
        }
        return {
          ok: true,
          value: archiveRevisionReadSchema.parse({
            revisionId: row.revision_id,
            itemId: row.item_id,
            sourceKey: { namespace: row.namespace, key: row.source_key },
            stateHash: row.state_hash,
            state: row.state_data,
          }),
        };
      });
    },

    async getArchiveTimeline(itemId, options) {
      const checkedId = archiveIdentifierSchema.safeParse(itemId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["itemId", ...issue.path],
          })),
        );
      }
      const checkedBinId =
        options?.binId === undefined
          ? undefined
          : binIdSchema.safeParse(options.binId);
      if (checkedBinId !== undefined && !checkedBinId.success) {
        return validationFailure(
          checkedBinId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["binId", ...issue.path],
          })),
        );
      }
      const limit = options?.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return failure(
          400,
          "invalid_input",
          "时间线每页必须读取 1 到 100 条观察。",
          ["limit"],
        );
      }

      const cursor =
        options?.cursor === undefined
          ? undefined
          : decodeTimelineCursor(options.cursor);
      if (options?.cursor !== undefined && cursor === undefined) {
        return failure(400, "invalid_input", "时间线游标格式无效。", [
          "cursor",
        ]);
      }
      if (cursor !== undefined && cursor.itemId !== checkedId.data) {
        return failure(400, "invalid_input", "时间线游标不属于这个条目。", [
          "cursor",
        ]);
      }
      if (
        cursor !== undefined &&
        checkedBinId?.data !== undefined &&
        checkedBinId.data !== (cursor.binId ?? undefined)
      ) {
        return failure(400, "invalid_input", "时间线游标的来源范围不匹配。", [
          "binId",
        ]);
      }
      if (
        cursor !== undefined &&
        options?.asOf !== undefined &&
        options.asOf !== cursor.snapshot.asOf
      ) {
        return failure(400, "invalid_input", "时间线游标的归档截点不匹配。", [
          "asOf",
        ]);
      }

      const binId = cursor?.binId ?? checkedBinId?.data;
      const requestedAsOf = cursor?.snapshot.asOf ?? options?.asOf;
      return await database.begin(async (transaction) => {
        const snapshot = await resolveSnapshot(transaction, requestedAsOf);
        if (!snapshot.ok) return snapshot;
        if (
          cursor !== undefined &&
          BigInt(cursor.after.archiveSeq) > BigInt(snapshot.value.asOf)
        ) {
          return failure(400, "invalid_input", "时间线游标超出归档截点。", [
            "cursor",
          ]);
        }
        return await readTimelinePage(
          transaction,
          checkedId.data,
          snapshot.value,
          binId,
          cursor?.after,
          limit,
        );
      });
    },

    async getArchiveCommit(commitId) {
      const checkedId = archiveIdentifierSchema.safeParse(commitId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["commitId", ...issue.path],
          })),
        );
      }
      return await database.begin(async (transaction) => {
        await transaction.unsafe(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        const rows = await transaction<{ readonly commit_id: string }[]>`
          SELECT commit_id
          FROM archive_commit
          WHERE commit_id = ${checkedId.data}
        `;
        if (rows[0] === undefined) {
          return failure(404, "commit_not_found", "没有找到这个归档提交。", [
            "commitId",
          ]);
        }
        return {
          ok: true,
          value: await readCommit(transaction, checkedId.data),
        };
      });
    },
  };
}
