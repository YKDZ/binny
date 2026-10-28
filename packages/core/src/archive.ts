import { createHash, randomUUID } from "node:crypto";

import {
  archiveCommitSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveItemDeletionResultSchema,
  archiveItemStateSchema,
  archiveRevisionReadSchema,
  archiveRelationEntrySchema,
  archiveRelationCursorSchema,
  archiveRelationPageSchema,
  archiveRelationStateSchema,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
  archiveSearchJsonProjectionResultSchema,
  archiveSnapshotSequenceSchema,
  archiveTimelineCursorSchema,
  archiveTimelinePageSchema,
  archiveSubmissionInputSchema,
  binIdSchema,
  type ArchiveCommit,
  type ArchiveError,
  type ArchiveItemRead,
  type ArchiveOperation,
  type ArchiveOperations,
  type ArchiveSearchOperation,
  type ArchiveSearchField,
  type ArchiveSearchFilter,
  type ArchiveSearchJsonFilter,
  type ArchiveSearchJsonProjection,
  type ArchiveSearchRequest,
  type ArchiveSearchTargetFilter,
  type ArchiveSearchText,
  type ArchiveRelationOptions,
  type ArchiveRelationEntry,
  type ArchiveRelationState,
  type ArchiveSubmissionInput,
  postgresTextSchema,
} from "@binny/contracts";
import type postgres from "postgres";

import {
  advanceArchiveSequence,
  withArchiveWriteLock,
} from "./archive-lock.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import { createArchiveResourceStorage } from "./archive-resource-storage.ts";
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

type RelationIdentityRow = {
  readonly relation_id: string;
  readonly from_item_id: string;
  readonly target_item_id: string | null;
  readonly target_source_ref: string | null;
  readonly created_seq: string;
};

type RelationRevisionRow = {
  readonly relation_revision_id: string;
  readonly state_hash: string;
  readonly state_data: unknown;
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

type ResolvedSnapshot = {
  readonly asOf: string;
  readonly mode: "current" | "asOf";
};

type RevisionReadRow = RevisionRow & ItemRow;

type PreparedItem = {
  readonly itemId: string;
  readonly isNew: boolean;
  readonly isNewRevision: boolean;
  readonly revisionId: string;
  readonly sourceKey: ArchiveSubmissionInput["items"][number]["sourceKey"];
  readonly state: ReturnType<typeof archiveItemStateSchema.parse>;
  readonly diagnostics: ArchiveSubmissionInput["items"][number]["diagnostics"];
  readonly stateHash: string;
  readonly stateJson: string;
};

type PreparedRelation = {
  readonly relationId: string;
  readonly ordinal: number;
  readonly fromItemId: string;
  readonly targetItemId: string | null;
  readonly targetSourceRef: string | null;
  readonly state: ArchiveRelationState | null;
  readonly stateHash?: string;
  revisionId?: string;
  isNew: boolean;
};

function failure<T>(
  status: 400 | 404 | 409 | 503,
  code: ArchiveError["code"],
  message: string,
  path?: readonly (string | number)[],
): ArchiveOperation<T> {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      ...(path === undefined ? {} : { path: [...path] }),
    },
  };
}

function validationFailure<T>(
  issues: readonly {
    readonly message: string;
    readonly path: readonly PropertyKey[];
  }[],
): ArchiveOperation<T> {
  const issue = issues[0];
  return failure(
    400,
    "invalid_input",
    issue?.message ?? "归档请求格式无效。",
    issue?.path.map((part) => (typeof part === "symbol" ? String(part) : part)),
  );
}

async function resolveSnapshot(
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

type SearchCursor = {
  readonly version: 1 | 2;
  readonly queryHash: string;
  readonly snapshot: ResolvedSnapshot;
  readonly resultId: string;
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

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON 数字必须是有限值。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("归档状态必须是 JSON 值。");
}

function postgresJsonValue(value: unknown): postgres.JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new TypeError("归档 JSON 数字超出支持范围。");
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry) => postgresJsonValue(entry));
  if (typeof value === "object") {
    const fields: [string, postgres.JSONValue][] = [];
    for (const [key, entry] of Object.entries(value)) {
      fields.push([key, postgresJsonValue(entry)]);
    }
    return Object.fromEntries(fields);
  }
  throw new TypeError("归档状态必须是 JSON 值。");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isoTimestamp(value: Date): string {
  return value.toISOString();
}

function optionalText(
  name: "runId" | "collectorVersion",
  value: string | null,
): { readonly runId?: string; readonly collectorVersion?: string } {
  if (value === null) return {};
  return name === "runId" ? { runId: value } : { collectorVersion: value };
}

function optionalDiagnostics(value: unknown): {
  readonly diagnostics?: unknown;
} {
  return value === null ? {} : { diagnostics: value };
}

function stateForItem(
  item: ArchiveSubmissionInput["items"][number],
): ReturnType<typeof archiveItemStateSchema.parse> {
  const { sourceKey: _sourceKey, diagnostics: _diagnostics, ...state } = item;
  return archiveItemStateSchema.parse(state);
}

function sourceKeyIdentity(sourceKey: {
  readonly namespace: string;
  readonly key: string;
}): string {
  return JSON.stringify([sourceKey.namespace, sourceKey.key]);
}

/** 初始化归档表；bin_id 保留为来源值，不建立会级联删除的外键。 */
export async function initializeArchiveSchema(
  database: CoreDatabase,
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_write_clock (" +
        "clock_id smallint PRIMARY KEY CHECK (clock_id = 1), " +
        "last_seq bigint NOT NULL CHECK (last_seq >= 0)" +
        ")",
    );
    await transaction.unsafe(
      "INSERT INTO archive_write_clock (clock_id, last_seq) " +
        "VALUES (1, 0) ON CONFLICT (clock_id) DO NOTHING",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_item (" +
        "item_id uuid PRIMARY KEY, " +
        "namespace text NOT NULL, " +
        "source_key text NOT NULL, " +
        "created_at timestamptz NOT NULL DEFAULT clock_timestamp(), " +
        "UNIQUE (namespace, source_key)" +
        ")",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_item_deletion (" +
        "item_id uuid PRIMARY KEY, " +
        "namespace text NOT NULL, " +
        "source_key text NOT NULL, " +
        "deletion_seq bigint NOT NULL CHECK (deletion_seq > 0)" +
        ")",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_resource (" +
        "resource_id uuid PRIMARY KEY, " +
        "sha256 text NOT NULL CHECK (length(sha256) = 64), " +
        "media_type text NOT NULL, " +
        "byte_size bigint NOT NULL CHECK (byte_size >= 0), " +
        "storage_key uuid NOT NULL UNIQUE, " +
        "status text NOT NULL CHECK (status IN ('ready', 'deleting')), " +
        "uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp()" +
        ")",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_resource_digest_idx " +
        "ON archive_resource (sha256, byte_size) WHERE status = 'ready'",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_resource_cleanup_idx " +
        "ON archive_resource (uploaded_at) WHERE status = 'ready'",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_revision (" +
        "revision_id uuid PRIMARY KEY, " +
        "item_id uuid NOT NULL REFERENCES archive_item(item_id) ON DELETE RESTRICT, " +
        "state_hash text NOT NULL CHECK (length(state_hash) = 64), " +
        "state_data jsonb NOT NULL, " +
        "created_at timestamptz NOT NULL DEFAULT clock_timestamp(), " +
        "UNIQUE (item_id, state_hash), " +
        "UNIQUE (item_id, revision_id)" +
        ")",
    );
    await transaction.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_revision_search_text_trgm_idx " +
        "ON archive_revision USING gin " +
        "((state_data->'body'->>'searchText') gin_trgm_ops)",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_revision_resource (" +
        "revision_id uuid NOT NULL REFERENCES archive_revision(revision_id) ON DELETE RESTRICT, " +
        "resource_id uuid NOT NULL REFERENCES archive_resource(resource_id) ON DELETE RESTRICT, " +
        "ordinal integer NOT NULL CHECK (ordinal >= 0), " +
        "PRIMARY KEY (revision_id, resource_id), " +
        "UNIQUE (revision_id, ordinal)" +
        ")",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_revision_resource_resource_idx " +
        "ON archive_revision_resource (resource_id, revision_id)",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_commit (" +
        "commit_id uuid PRIMARY KEY, " +
        "archive_seq bigint NOT NULL UNIQUE CHECK (archive_seq > 0), " +
        "bin_id text NOT NULL, " +
        "run_id text, " +
        "collector_version text, " +
        "observed_at timestamptz NOT NULL, " +
        "recorded_at timestamptz NOT NULL" +
        ")",
    );
    await transaction.unsafe(
      "CREATE UNIQUE INDEX IF NOT EXISTS archive_commit_id_bin_seq_idx " +
        "ON archive_commit (commit_id, bin_id, archive_seq)",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_observation (" +
        "commit_id uuid NOT NULL REFERENCES archive_commit(commit_id) ON DELETE RESTRICT, " +
        "ordinal integer NOT NULL CHECK (ordinal >= 0), " +
        "item_id uuid NOT NULL REFERENCES archive_item(item_id) ON DELETE RESTRICT, " +
        "revision_id uuid NOT NULL, " +
        "diagnostics jsonb, " +
        "PRIMARY KEY (commit_id, ordinal), " +
        "UNIQUE (commit_id, item_id), " +
        "FOREIGN KEY (item_id, revision_id) " +
        "REFERENCES archive_revision(item_id, revision_id) ON DELETE RESTRICT" +
        ")",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_observation_item_commit_idx " +
        "ON archive_observation (item_id, commit_id)",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_item_observation_gap (" +
        "commit_id uuid NOT NULL REFERENCES archive_commit(commit_id) ON DELETE RESTRICT, " +
        "ordinal integer NOT NULL CHECK (ordinal >= 0), " +
        "item_id uuid NOT NULL REFERENCES archive_item_deletion(item_id) ON DELETE RESTRICT, " +
        "PRIMARY KEY (commit_id, ordinal)" +
        ")",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_item_observation_gap_item_commit_idx " +
        "ON archive_item_observation_gap (item_id, commit_id)",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_commit_bin_sequence_idx " +
        "ON archive_commit (bin_id, archive_seq DESC)",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_request_receipt (" +
        "request_id text PRIMARY KEY, " +
        "payload_hash text NOT NULL CHECK (length(payload_hash) = 64), " +
        "commit_id uuid NOT NULL REFERENCES archive_commit(commit_id) ON DELETE RESTRICT, " +
        "created_at timestamptz NOT NULL DEFAULT clock_timestamp()" +
        ")",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_relation (" +
        "relation_id text PRIMARY KEY, " +
        "from_item_id uuid NOT NULL REFERENCES archive_item(item_id) ON DELETE RESTRICT, " +
        "target_item_id uuid REFERENCES archive_item(item_id) ON DELETE RESTRICT, " +
        "target_source_ref text, " +
        "created_seq bigint NOT NULL REFERENCES archive_commit(archive_seq) ON DELETE RESTRICT, " +
        "CHECK ((target_item_id IS NULL) <> (target_source_ref IS NULL))" +
        ")",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_relation_from_item_idx " +
        "ON archive_relation (from_item_id, relation_id)",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_relation_to_item_idx " +
        "ON archive_relation (target_item_id, relation_id) " +
        "WHERE target_item_id IS NOT NULL",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_relation_revision (" +
        "relation_revision_id uuid PRIMARY KEY, " +
        "relation_id text NOT NULL REFERENCES archive_relation(relation_id) ON DELETE RESTRICT, " +
        "state_hash text NOT NULL CHECK (length(state_hash) = 64), " +
        "state_data jsonb NOT NULL, " +
        "created_at timestamptz NOT NULL DEFAULT clock_timestamp(), " +
        "UNIQUE (relation_id, state_hash), " +
        "UNIQUE (relation_id, relation_revision_id)" +
        ")",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_relation_observation (" +
        "commit_id uuid NOT NULL, " +
        "ordinal integer NOT NULL CHECK (ordinal >= 0), " +
        "relation_id text NOT NULL REFERENCES archive_relation(relation_id) ON DELETE RESTRICT, " +
        "bin_id text NOT NULL, " +
        "archive_seq bigint NOT NULL, " +
        "relation_revision_id uuid, " +
        "PRIMARY KEY (commit_id, ordinal), " +
        "FOREIGN KEY (commit_id, bin_id, archive_seq) " +
        "REFERENCES archive_commit(commit_id, bin_id, archive_seq) ON DELETE RESTRICT, " +
        "FOREIGN KEY (relation_id, relation_revision_id) " +
        "REFERENCES archive_relation_revision(relation_id, relation_revision_id) ON DELETE RESTRICT" +
        ")",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_relation_observation_latest_idx " +
        "ON archive_relation_observation " +
        "(relation_id, bin_id, archive_seq DESC, ordinal DESC, commit_id DESC)",
    );
    await transaction.unsafe(
      "CREATE TABLE IF NOT EXISTS archive_relation_observation_gap (" +
        "commit_id uuid NOT NULL REFERENCES archive_commit(commit_id) ON DELETE RESTRICT, " +
        "ordinal integer NOT NULL CHECK (ordinal >= 0), " +
        "relation_id text NOT NULL, " +
        "from_item_id uuid NOT NULL, " +
        "target_item_id uuid, " +
        "PRIMARY KEY (commit_id, ordinal)" +
        ")",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_relation_observation_gap_from_idx " +
        "ON archive_relation_observation_gap (from_item_id, relation_id)",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_relation_observation_gap_to_idx " +
        "ON archive_relation_observation_gap (target_item_id, relation_id) " +
        "WHERE target_item_id IS NOT NULL",
    );
    await transaction.unsafe(
      "CREATE INDEX IF NOT EXISTS archive_relation_observation_gap_id_commit_idx " +
        "ON archive_relation_observation_gap (relation_id, commit_id)",
    );
  });
}

async function readCommit(
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

export type ArchiveStoreOptions = {
  readonly resourceDirectory: string;
  readonly unreferencedResourceAgeMs?: number;
  readonly resourceCleanupIntervalMs?: number;
};

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
          WHERE observation.item_id = relation_filter.target_item_id
            AND commit.bin_id = ${aliases.latest}.bin_id
            AND commit.archive_seq <= ${asOf}::bigint
          ORDER BY
            commit.archive_seq DESC,
            observation.ordinal DESC,
            commit.commit_id DESC
          LIMIT 1
        ) AS target_latest
          ON relation_filter.target_item_id IS NOT NULL
        JOIN archive_item AS target_item
          ON target_item.item_id = relation_filter.target_item_id
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
          relation_filter.target_item_id,
          relation_filter.target_source_ref
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

export type ArchiveStore = ArchiveOperations & {
  readonly initializeResourceStorage: () => Promise<void>;
  readonly close: () => Promise<void>;
};

/** 创建共享 PostgreSQL 与持久资源目录的原子归档操作。 */
export function createArchiveStore(
  database: CoreDatabase,
  options: ArchiveStoreOptions,
): ArchiveStore {
  const resourceStorage = createArchiveResourceStorage(database, {
    directory: options.resourceDirectory,
    unreferencedAgeMs: options.unreferencedResourceAgeMs ?? 24 * 60 * 60 * 1000,
    cleanupIntervalMs: options.resourceCleanupIntervalMs ?? 60 * 60 * 1000,
  });
  return {
    initializeResourceStorage: () => resourceStorage.initialize(),
    close: () => resourceStorage.close(),
    uploadArchiveResource: (body, mediaType) =>
      resourceStorage.upload(body, mediaType),
    getArchiveResource: (resourceId) => resourceStorage.get(resourceId),
    async submitArchive(input) {
      const checked = archiveSubmissionInputSchema.safeParse(input);
      if (!checked.success) return validationFailure(checked.error.issues);

      const submission = checked.data;
      const { requestId, relations, ...payload } = submission;
      const payloadForHash =
        relations.length === 0 ? payload : { ...payload, relations };
      const payloadHash = hashJson(payloadForHash);
      const observedAt = submission.observedAt ?? new Date().toISOString();

      return await withArchiveWriteLock(
        database,
        async (transaction, currentSequence) => {
          const receipts = await transaction<
            { readonly payload_hash: string; readonly commit_id: string }[]
          >`
            SELECT payload_hash, commit_id
            FROM archive_request_receipt
            WHERE request_id = ${requestId}
          `;
          const receipt = receipts[0];
          if (receipt !== undefined) {
            if (receipt.payload_hash !== payloadHash) {
              return failure(
                409,
                "archive_request_conflict",
                "这个请求标识已经用于不同的归档负载。",
                ["requestId"],
              );
            }
            return {
              ok: true,
              value: await readCommit(transaction, receipt.commit_id),
            };
          }

          if (submission.runId !== undefined) {
            const matchingRuns = await transaction<
              { readonly action: string }[]
            >`
              SELECT action
              FROM manual_runs
              WHERE run_id::text = ${submission.runId}
            `;
            if (matchingRuns[0]?.action === "check") {
              return failure(
                409,
                "check_run_archive_forbidden",
                "可用性检查运行不能提交归档资料。",
                ["runId"],
              );
            }
          }

          const bins = await transaction<{ readonly id: string }[]>`
            SELECT id
            FROM bin_configurations
            WHERE id = ${submission.binId}
          `;
          if (bins[0] === undefined) {
            return failure(404, "bin_not_found", "没有找到提交所声明的 bin。", [
              "binId",
            ]);
          }

          for (const [itemIndex, item] of submission.items.entries()) {
            for (const [resourceIndex, resource] of (
              item.resources ?? []
            ).entries()) {
              if (
                !(await resourceStorage.isAvailable(
                  transaction,
                  resource.resourceId,
                ))
              ) {
                return failure(
                  400,
                  "resource_not_found",
                  "内容版本引用的归档资源尚未上传或已不可用。",
                  [
                    "items",
                    itemIndex,
                    "resources",
                    resourceIndex,
                    "resourceId",
                  ],
                );
              }
            }
          }

          const preparedItems: PreparedItem[] = [];
          const itemIdsBySourceKey = new Map<string, string>();
          for (const item of submission.items) {
            const identities = await transaction<
              { readonly item_id: string }[]
            >`
              SELECT item_id
              FROM archive_item
              WHERE namespace = ${item.sourceKey.namespace}
                AND source_key = ${item.sourceKey.key}
            `;
            const isNew = identities[0] === undefined;
            const itemId = identities[0]?.item_id ?? randomUUID();
            itemIdsBySourceKey.set(sourceKeyIdentity(item.sourceKey), itemId);

            const state = stateForItem(item);
            const stateJson = canonicalJson(state);
            const stateHash = createHash("sha256")
              .update(stateJson)
              .digest("hex");
            const revisions = isNew
              ? []
              : await transaction<RevisionRow[]>`
                  SELECT revision_id, state_hash, state_data
                  FROM archive_revision
                  WHERE item_id = ${itemId}
                    AND state_hash = ${stateHash}
                `;
            const existingRevision = revisions[0];
            if (
              existingRevision !== undefined &&
              canonicalJson(existingRevision.state_data) !== stateJson
            ) {
              throw new Error("归档状态哈希冲突，不能复用现有版本。");
            }
            preparedItems.push({
              itemId,
              isNew,
              isNewRevision: existingRevision === undefined,
              revisionId: existingRevision?.revision_id ?? randomUUID(),
              sourceKey: item.sourceKey,
              state,
              diagnostics: item.diagnostics,
              stateHash,
              stateJson,
            });
          }

          const resolveItemId = async (sourceKey: {
            readonly namespace: string;
            readonly key: string;
          }): Promise<string | undefined> => {
            const batchItemId = itemIdsBySourceKey.get(
              sourceKeyIdentity(sourceKey),
            );
            if (batchItemId !== undefined) return batchItemId;
            const rows = await transaction<{ readonly item_id: string }[]>`
              SELECT item_id
              FROM archive_item
              WHERE namespace = ${sourceKey.namespace}
                AND source_key = ${sourceKey.key}
            `;
            return rows[0]?.item_id;
          };

          const preparedRelations: PreparedRelation[] = [];
          for (const [index, inputRelation] of submission.relations.entries()) {
            const existingRows = await transaction<RelationIdentityRow[]>`
              SELECT
                relation_id,
                from_item_id,
                target_item_id,
                target_source_ref,
                created_seq::text AS created_seq
              FROM archive_relation
              WHERE relation_id = ${inputRelation.relationId}
            `;
            const existing = existingRows[0];
            if (inputRelation.value === null) {
              if (existing === undefined) {
                return failure(
                  404,
                  "relation_not_found",
                  "没有找到要撤回的关系。",
                  ["relations", index, "relationId"],
                );
              }
              preparedRelations.push({
                relationId: inputRelation.relationId,
                ordinal: preparedItems.length + index,
                fromItemId: existing.from_item_id,
                targetItemId: existing.target_item_id,
                targetSourceRef: existing.target_source_ref,
                state: null,
                isNew: false,
              });
              continue;
            }

            const state = archiveRelationStateSchema.parse(inputRelation.value);
            const fromItemId = await resolveItemId(state.from);
            if (fromItemId === undefined) {
              return failure(
                400,
                "invalid_input",
                "关系来源端点尚未归档，也未出现在本批资料中。",
                ["relations", index, "value", "from"],
              );
            }

            let targetItemId: string | null = null;
            let targetSourceRef: string | null = null;
            if ("sourceKey" in state.to) {
              const resolvedTarget = await resolveItemId(state.to.sourceKey);
              if (resolvedTarget === undefined) {
                return failure(
                  400,
                  "invalid_input",
                  "关系目标端点尚未归档，也未出现在本批资料中。",
                  ["relations", index, "value", "to", "sourceKey"],
                );
              }
              targetItemId = resolvedTarget;
            } else {
              targetSourceRef = state.to.sourceRef;
            }

            if (
              existing !== undefined &&
              (existing.from_item_id !== fromItemId ||
                existing.target_item_id !== targetItemId ||
                existing.target_source_ref !== targetSourceRef)
            ) {
              return failure(
                409,
                "relation_endpoint_conflict",
                "关系标识已经绑定到其他端点；更改端点时请使用新的关系标识。",
                ["relations", index, "relationId"],
              );
            }

            const stateJson = canonicalJson(state);
            preparedRelations.push({
              relationId: inputRelation.relationId,
              ordinal: preparedItems.length + index,
              fromItemId,
              targetItemId,
              targetSourceRef,
              state,
              stateHash: createHash("sha256").update(stateJson).digest("hex"),
              isNew: existing === undefined,
            });
          }

          for (const item of preparedItems) {
            if (item.isNew) {
              await transaction`
                INSERT INTO archive_item (item_id, namespace, source_key)
                VALUES (
                  ${item.itemId},
                  ${item.sourceKey.namespace},
                  ${item.sourceKey.key}
                )
              `;
            }
            if (item.isNewRevision) {
              await transaction`
                INSERT INTO archive_revision (
                  revision_id,
                  item_id,
                  state_hash,
                  state_data
                ) VALUES (
                  ${item.revisionId},
                  ${item.itemId},
                  ${item.stateHash},
                  ${transaction.json(postgresJsonValue(item.state))}
                )
              `;
            }
            for (const [ordinal, resource] of (
              item.state.resources ?? []
            ).entries()) {
              await transaction`
                INSERT INTO archive_revision_resource (
                  revision_id,
                  resource_id,
                  ordinal
                ) VALUES (
                  ${item.revisionId},
                  ${resource.resourceId},
                  ${ordinal}
                ) ON CONFLICT (revision_id, resource_id) DO NOTHING
              `;
            }
          }

          const archiveSeq = await advanceArchiveSequence(
            transaction,
            currentSequence,
          );
          const commitId = randomUUID();
          const recordedRows = await transaction<
            { readonly recorded_at: Date }[]
          >`SELECT clock_timestamp() AS recorded_at`;
          const recordedAt = recordedRows[0]?.recorded_at;
          if (recordedAt === undefined) {
            throw new Error("无法读取归档记录时间。");
          }

          await transaction`
            INSERT INTO archive_commit (
              commit_id,
              archive_seq,
              bin_id,
              run_id,
              collector_version,
              observed_at,
              recorded_at
            ) VALUES (
              ${commitId},
              ${archiveSeq}::bigint,
              ${submission.binId},
              ${submission.runId ?? null},
              ${submission.collectorVersion ?? null},
              ${observedAt},
              ${recordedAt}
            )
          `;

          for (const relation of preparedRelations) {
            if (relation.isNew) {
              await transaction`
                INSERT INTO archive_relation (
                  relation_id,
                  from_item_id,
                  target_item_id,
                  target_source_ref,
                  created_seq
                ) VALUES (
                  ${relation.relationId},
                  ${relation.fromItemId},
                  ${relation.targetItemId},
                  ${relation.targetSourceRef},
                  ${archiveSeq}::bigint
                )
              `;
            }
            if (relation.state !== null) {
              const stateHash = relation.stateHash;
              if (stateHash === undefined) {
                throw new Error("关系状态缺少规范化哈希。");
              }
              const stateJson = canonicalJson(relation.state);
              const revisions = await transaction<RelationRevisionRow[]>`
                SELECT relation_revision_id, state_hash, state_data
                FROM archive_relation_revision
                WHERE relation_id = ${relation.relationId}
                  AND state_hash = ${stateHash}
              `;
              const existingRevision = revisions[0];
              if (existingRevision === undefined) {
                relation.revisionId = randomUUID();
                await transaction`
                  INSERT INTO archive_relation_revision (
                    relation_revision_id,
                    relation_id,
                    state_hash,
                    state_data
                  ) VALUES (
                    ${relation.revisionId},
                    ${relation.relationId},
                    ${stateHash},
                    ${transaction.json(postgresJsonValue(relation.state))}
                  )
                `;
              } else {
                if (canonicalJson(existingRevision.state_data) !== stateJson) {
                  throw new Error("关系状态哈希冲突，不能复用现有版本。");
                }
                relation.revisionId = existingRevision.relation_revision_id;
              }
            }
          }

          for (const [ordinal, item] of preparedItems.entries()) {
            await transaction`
              INSERT INTO archive_observation (
                commit_id,
                ordinal,
                item_id,
                revision_id,
                diagnostics
              ) VALUES (
                ${commitId},
                ${ordinal},
                ${item.itemId},
                ${item.revisionId},
                ${
                  item.diagnostics === undefined
                    ? null
                    : transaction.json(postgresJsonValue(item.diagnostics))
                }
              )
            `;
          }

          for (const relation of preparedRelations) {
            await transaction`
              INSERT INTO archive_relation_observation (
                commit_id,
                ordinal,
                relation_id,
                bin_id,
                archive_seq,
                relation_revision_id
              ) VALUES (
                ${commitId},
                ${relation.ordinal},
                ${relation.relationId},
                ${submission.binId},
                ${archiveSeq}::bigint,
                ${relation.revisionId ?? null}
              )
            `;
          }

          await transaction`
            INSERT INTO archive_request_receipt (
              request_id,
              payload_hash,
              commit_id
            ) VALUES (
              ${requestId},
              ${payloadHash},
              ${commitId}
            )
          `;

          return {
            ok: true,
            value: await readCommit(transaction, commitId),
          };
        },
      );
    },

    async deleteArchiveItem(itemId) {
      const checkedId = archiveIdentifierSchema.safeParse(itemId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["itemId", ...issue.path],
          })),
        );
      }

      const deletion = await withArchiveWriteLock(
        database,
        async (transaction, currentSequence) => {
          const items = await transaction<ItemRow[]>`
            SELECT item_id, namespace, source_key
            FROM archive_item
            WHERE item_id = ${checkedId.data}
            FOR UPDATE
          `;
          const item = items[0];
          if (item === undefined) {
            const previousDeletions = await transaction<
              { readonly item_id: string }[]
            >`
              SELECT item_id
              FROM archive_item_deletion
              WHERE item_id = ${checkedId.data}
            `;
            return {
              ok: false as const,
              operation:
                previousDeletions[0] === undefined
                  ? failure<never>(
                      404,
                      "item_not_found",
                      "没有找到要删除的归档条目。",
                      ["itemId"],
                    )
                  : failure<never>(
                      404,
                      "item_deleted",
                      "这个条目已经硬删除；历史只保留删除缺口。",
                      ["itemId"],
                    ),
            };
          }

          const relations = await transaction<
            {
              readonly relation_id: string;
              readonly from_item_id: string;
              readonly target_item_id: string | null;
            }[]
          >`
            SELECT relation_id, from_item_id, target_item_id
            FROM archive_relation
            WHERE from_item_id = ${item.item_id}
              OR target_item_id = ${item.item_id}
            FOR UPDATE
          `;
          const relationIds = relations.map(({ relation_id }) => relation_id);
          const resourceRows = await transaction<
            { readonly resource_id: string }[]
          >`
            SELECT DISTINCT reference.resource_id
            FROM archive_revision AS revision
            JOIN archive_revision_resource AS reference
              ON reference.revision_id = revision.revision_id
            WHERE revision.item_id = ${item.item_id}
          `;
          const resourceIds = resourceRows.map(
            ({ resource_id }) => resource_id,
          );
          const deletionSeq = await advanceArchiveSequence(
            transaction,
            currentSequence,
          );

          await transaction`
            INSERT INTO archive_item_deletion (
              item_id,
              namespace,
              source_key,
              deletion_seq
            ) VALUES (
              ${item.item_id},
              ${item.namespace},
              ${item.source_key},
              ${deletionSeq}::bigint
            )
          `;
          await transaction`
            INSERT INTO archive_item_observation_gap (
              commit_id,
              ordinal,
              item_id
            )
            SELECT commit_id, ordinal, item_id
            FROM archive_observation
            WHERE item_id = ${item.item_id}
          `;
          if (relationIds.length > 0) {
            await transaction`
              INSERT INTO archive_relation_observation_gap (
                commit_id,
                ordinal,
                relation_id,
                from_item_id,
                target_item_id
              )
              SELECT
                observation.commit_id,
                observation.ordinal,
                relation.relation_id,
                relation.from_item_id,
                relation.target_item_id
              FROM archive_relation_observation AS observation
              JOIN archive_relation AS relation
                ON relation.relation_id = observation.relation_id
              WHERE relation.relation_id = ANY(
                ${transaction.array(relationIds, 25)}
              )
            `;
            await transaction`
              DELETE FROM archive_relation_observation AS observation
              USING archive_relation AS relation
              WHERE relation.relation_id = observation.relation_id
                AND relation.relation_id = ANY(
                  ${transaction.array(relationIds, 25)}
                )
            `;
            await transaction`
              DELETE FROM archive_relation_revision
              WHERE relation_id = ANY(${transaction.array(relationIds, 25)})
            `;
            await transaction`
              DELETE FROM archive_relation
              WHERE relation_id = ANY(${transaction.array(relationIds, 25)})
            `;
          }
          await transaction`
            DELETE FROM archive_observation
            WHERE item_id = ${item.item_id}
          `;
          await transaction`
            DELETE FROM archive_revision_resource
            WHERE revision_id IN (
              SELECT revision_id
              FROM archive_revision
              WHERE item_id = ${item.item_id}
            )
          `;
          await transaction`
            DELETE FROM archive_revision
            WHERE item_id = ${item.item_id}
          `;
          await transaction`
            DELETE FROM archive_item
            WHERE item_id = ${item.item_id}
          `;
          if (resourceIds.length > 0) {
            await transaction`
              UPDATE archive_resource
              SET status = 'deleting'
              WHERE resource_id = ANY(
                ${transaction.array(resourceIds, 2950)}
              )
                AND status = 'ready'
                AND NOT EXISTS (
                  SELECT 1
                  FROM archive_revision_resource AS reference
                  WHERE reference.resource_id = archive_resource.resource_id
                )
            `;
          }

          return {
            ok: true as const,
            value: archiveItemDeletionResultSchema.parse({
              itemId: item.item_id,
              deletionSeq,
              deleted: true,
            }),
            resourceIds,
          };
        },
      );

      if (!deletion.ok) return deletion.operation;
      try {
        await resourceStorage.collectUnreferencedResources(
          deletion.resourceIds,
        );
      } catch (error) {
        console.error("硬删除后的归档资源回收失败：", error);
      }
      return { ok: true, value: deletion.value };
    },

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
