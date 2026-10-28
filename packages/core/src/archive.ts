import { createHash, randomUUID } from "node:crypto";

import {
  archiveCommitSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveItemStateSchema,
  archiveRevisionReadSchema,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
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
  type ArchiveSearchRequest,
  type ArchiveSubmissionInput,
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
  readonly revision_id: string;
  readonly ordinal: number;
  readonly source_modified_at: string | null;
};

type SearchRow = {
  readonly result_id: string;
  readonly result_unit: "item" | "revision" | "observation";
  readonly item_id: string;
  readonly root_revision_id: string | null;
  readonly root_commit_id: string | null;
  readonly root_ordinal: number | null;
  readonly namespace: string;
  readonly source_key: string;
  readonly sort_values: readonly (string | null)[];
  readonly bin_id: string;
  readonly revision_id: string;
  readonly archive_seq: string;
  readonly run_id: string | null;
  readonly collector_version: string | null;
  readonly source_modified_at: string | null;
  readonly observed_at: Date;
  readonly recorded_at: Date;
  readonly hit_start: number;
  readonly hit_end: number;
  readonly context_start: number;
  readonly context_end: number;
  readonly context_text: string;
};

type ResolvedSnapshot = {
  readonly asOf: string;
  readonly mode: "current" | "asOf";
};

type RevisionReadRow = RevisionRow & ItemRow;

type PreparedItem = {
  readonly itemId: string;
  readonly revisionId: string;
  readonly sourceKey: ArchiveSubmissionInput["items"][number]["sourceKey"];
  readonly state: ReturnType<typeof archiveItemStateSchema.parse>;
  readonly diagnostics: ArchiveSubmissionInput["items"][number]["diagnostics"];
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
  readonly version: 1;
  readonly queryHash: string;
  readonly snapshot: ResolvedSnapshot;
  readonly sortValues: readonly (string | null)[];
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
    if (!("version" in value) || value.version !== 1) return undefined;
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
    if (!("sortValues" in value) || !Array.isArray(value.sortValues))
      return undefined;
    if (
      value.sortValues.some(
        (entry) => entry !== null && typeof entry !== "string",
      )
    ) {
      return undefined;
    }
    if (!("resultId" in value) || typeof value.resultId !== "string")
      return undefined;
    if (value.resultId.length === 0 || value.resultId.length > 128)
      return undefined;
    return {
      version: 1,
      queryHash: value.queryHash,
      snapshot: {
        asOf: checkedSequence.data,
        mode: snapshot.mode,
      },
      sortValues: value.sortValues,
      resultId: value.resultId,
    };
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
    const fields: Record<string, postgres.JSONValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      fields[key] = postgresJsonValue(entry);
    }
    return fields;
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

  const rows = await transaction<TimelineRow[]>`
    SELECT
      commit.commit_id,
      commit.archive_seq::text AS archive_seq,
      commit.bin_id,
      commit.run_id,
      commit.collector_version,
      commit.observed_at,
      commit.recorded_at,
      observation.revision_id,
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
      AND (
        ${after?.archiveSeq ?? null}::bigint IS NULL
        OR (commit.archive_seq, observation.ordinal, commit.commit_id) > (
          ${after?.archiveSeq ?? null}::bigint,
          ${after?.ordinal ?? null}::integer,
          ${after?.commitId ?? null}::uuid
        )
      )
    ORDER BY commit.archive_seq, observation.ordinal, commit.commit_id
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
      observations: pageRows.map((row) => ({
        commitId: row.commit_id,
        archiveSeq: row.archive_seq,
        ordinal: row.ordinal,
        binId: row.bin_id,
        ...optionalText("runId", row.run_id),
        ...optionalText("collectorVersion", row.collector_version),
        revisionId: row.revision_id,
        ...(row.source_modified_at === null
          ? {}
          : { sourceModifiedAt: row.source_modified_at }),
        observedAt: isoTimestamp(row.observed_at),
        recordedAt: isoTimestamp(row.recorded_at),
      })),
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

function searchFieldExpression(
  field: ArchiveSearchField,
): SearchFieldExpression {
  switch (field) {
    case "sourceKey.namespace":
      return { sql: "item.namespace", kind: "text" };
    case "sourceKey.key":
      return { sql: "item.source_key", kind: "text" };
    case "sourceRef":
      return { sql: "revision.state_data->>'sourceRef'", kind: "text" };
    case "sourceModifiedAt":
      return {
        sql: "(revision.state_data->>'sourceModifiedAt')::timestamptz",
        kind: "timestamp",
      };
    case "capture.completeness":
      return {
        sql: "revision.state_data->'capture'->>'completeness'",
        kind: "text",
      };
    case "body.searchText":
      return {
        sql: "revision.state_data->'body'->>'searchText'",
        kind: "text",
      };
    case "binId":
      return { sql: "latest.bin_id", kind: "text" };
    case "runId":
      return { sql: "latest.run_id", kind: "text" };
    case "collectorVersion":
      return { sql: "latest.collector_version", kind: "text" };
    case "observedAt":
      return { sql: "latest.observed_at", kind: "timestamp" };
    case "recordedAt":
      return { sql: "latest.recorded_at", kind: "timestamp" };
  }
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

async function readCurrentSearchPage(
  transaction: ArchiveTransaction,
  snapshot: ResolvedSnapshot,
  input: ReturnType<typeof archiveSearchInputSchema.parse>,
  cursor: SearchCursor | undefined,
  queryHash: string,
): Promise<ReturnType<typeof archiveSearchPageSchema.parse>> {
  const parameters: (string | null)[] = [];
  const bind = (value: string | null): string => {
    parameters.push(value);
    return "$" + parameters.length.toString(10);
  };
  const asOf = bind(snapshot.asOf);
  const binPredicate =
    input.scope.binId === undefined
      ? ""
      : " AND commit.bin_id = " + bind(input.scope.binId) + "::text";
  const compileFilter = (filter: ArchiveSearchFilter): string => {
    if (filter.type === "and" || filter.type === "or") {
      const operator = filter.type === "and" ? " AND " : " OR ";
      return "(" + filter.conditions.map(compileFilter).join(operator) + ")";
    }
    if (filter.type === "not")
      return "NOT (" + compileFilter(filter.condition) + ")";

    const field = searchFieldExpression(filter.field);
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
  const filterPredicate =
    input.where === undefined ? "TRUE" : compileFilter(input.where);
  let matchPredicate: string;
  let hitStart: string;
  let hitEnd: string;
  if (input.text.kind === "literal") {
    const value = bind(input.text.value);
    const pattern = bind("%" + escapeLikeLiteral(input.text.value) + "%");
    matchPredicate =
      "revision.state_data->'body'->>'searchText' LIKE " +
      pattern +
      " ESCAPE E'\\\\'";
    hitStart = "strpos(search_text, " + value + ") - 1";
    hitEnd = "hit_start + char_length(" + value + ")";
  } else {
    const pattern = bind(input.text.pattern);
    matchPredicate = "revision.state_data->'body'->>'searchText' ~ " + pattern;
    hitStart = "regexp_instr(search_text, " + pattern + ", 1, 1, 0, 'c') - 1";
    hitEnd = "regexp_instr(search_text, " + pattern + ", 1, 1, 1, 'c') - 1";
  }
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
  const selectSortExpression = (field: string): string => {
    switch (field) {
      case "itemId":
        return "item_id::text";
      case "sourceKey.namespace":
        return "namespace";
      case "sourceKey.key":
        return "source_key";
      case "sourceModifiedAt":
        return '(array_agg(source_modified_at ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]';
      case "binId":
        return '(array_agg(bin_id ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]';
      case "revisionId":
        return '(array_agg(revision_id::text ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]';
      case "archiveSeq":
        return "(array_agg(lpad(archive_seq, 19, '0') ORDER BY bin_id COLLATE \"C\", archive_seq::bigint, ordinal, commit_id))[1]";
      case "runId":
        return '(array_agg(run_id ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]';
      case "collectorVersion":
        return '(array_agg(collector_version ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]';
      case "observedAt":
        return '(array_agg(to_char(observed_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]';
      case "recordedAt":
        return '(array_agg(to_char(recorded_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') ORDER BY bin_id COLLATE "C", archive_seq::bigint, ordinal, commit_id))[1]';
      default:
        throw new Error("搜索排序字段未声明。");
    }
  };
  const sortExpressions = input.orderBy.map(({ field }) =>
    selectSortExpression(field),
  );
  const pageOrdering = input.orderBy
    .map(
      ({ direction }, index) =>
        `sort_${index.toString(10)} COLLATE "C" ${direction.toUpperCase()} NULLS LAST`,
    )
    .concat(['result_id COLLATE "C" ASC'])
    .join(", ");
  let cursorPredicate = "TRUE";
  if (cursor !== undefined) {
    const afterBranches: string[] = [];
    const equalPrefix: string[] = [];
    for (const [index, sort] of input.orderBy.entries()) {
      const alias = `sort_${index.toString(10)}`;
      const cursorValue = cursor.sortValues[index];
      if (cursorValue === undefined) {
        throw new Error("搜索游标排序值与请求排序不同步。");
      }
      if (cursorValue !== null) {
        const comparison = bind(cursorValue);
        const operator = sort.direction === "asc" ? ">" : "<";
        afterBranches.push(
          `(${equalPrefix.join(" AND ")}${equalPrefix.length > 0 ? " AND " : ""}(${alias} IS NULL OR ${alias} COLLATE "C" ${operator} ${comparison}::text COLLATE "C"))`,
        );
      }
      const equality = bind(cursorValue);
      equalPrefix.push(
        `${alias} IS NOT DISTINCT FROM ${equality}::text COLLATE "C"`,
      );
    }
    const afterId = bind(cursor.resultId);
    afterBranches.push(
      `(${equalPrefix.join(" AND ")} AND result_id COLLATE "C" > ${afterId}::text COLLATE "C")`,
    );
    cursorPredicate = "(" + afterBranches.join(" OR ") + ")";
  }
  const limit = bind(String(input.limit + 1));
  const resultSortValues = input.orderBy
    .map((_, index) => `page.sort_${index.toString(10)}`)
    .join(", ");
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
        revision.state_data->'body'->>'searchText' AS search_text,
        ${resultIdExpression} AS result_id
      FROM latest
      JOIN archive_item AS item ON item.item_id = latest.item_id
      JOIN archive_revision AS revision
        ON revision.item_id = latest.item_id
        AND revision.revision_id = latest.revision_id
      WHERE ${matchPredicate} AND ${filterPredicate}
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
        ${sortExpressions.map((expression, index) => `${expression} AS sort_${index.toString(10)}`).join(",\n        ")}
      FROM contextual
      GROUP BY result_id, item_id, namespace, source_key
    ),
    page AS (
      SELECT
        roots.*,
        row_number() OVER (ORDER BY ${pageOrdering}) AS result_rank
      FROM roots
      WHERE ${cursorPredicate}
      ORDER BY ${pageOrdering}
      LIMIT ${limit}::integer
    )
    SELECT
      page.result_id,
      page.result_unit,
      page.root_revision_id,
      page.root_commit_id,
      page.root_ordinal,
      ARRAY[${resultSortValues}]::text[] AS sort_values,
      contextual.item_id AS item_id,
      contextual.namespace AS namespace,
      contextual.source_key AS source_key,
      contextual.bin_id AS bin_id,
      contextual.revision_id AS revision_id,
      contextual.archive_seq AS archive_seq,
      contextual.run_id AS run_id,
      contextual.collector_version AS collector_version,
      contextual.source_modified_at AS source_modified_at,
      contextual.observed_at AS observed_at,
      contextual.recorded_at AS recorded_at,
      contextual.hit_start AS hit_start,
      contextual.hit_end AS hit_end,
      contextual.context_start AS context_start,
      contextual.context_end AS context_end,
      substring(
        contextual.search_text FROM contextual.context_start + 1 FOR contextual.context_end - contextual.context_start
      ) AS context_text
    FROM page
    JOIN contextual ON contextual.result_id = page.result_id
    ORDER BY page.result_rank, contextual.bin_id COLLATE "C", contextual.archive_seq::bigint
  `;
  const rows = await transaction.unsafe<SearchRow[]>(query, parameters);

  const selected = new Set(input.select);
  const results = new Map<
    string,
    {
      readonly result: SearchResult;
      readonly sortValues: readonly (string | null)[];
    }
  >();
  for (const row of rows) {
    const match: SearchMatch = {
      binId: row.bin_id,
      revisionId: row.revision_id,
      archiveSeq: row.archive_seq,
      ...(selected.has("sourceModifiedAt") && row.source_modified_at !== null
        ? { sourceModifiedAt: row.source_modified_at }
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
      hit: {
        field: "body.searchText",
        representation: "searchText",
        position: {
          encoding: "unicode-code-point",
          start: row.hit_start,
          end: row.hit_end,
        },
        ...(selected.has("hit.context")
          ? {
              context: {
                start: row.context_start,
                end: row.context_end,
                text: row.context_text,
              },
            }
          : {}),
      },
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
      results.set(row.result_id, {
        result: created,
        sortValues: row.sort_values,
      });
    } else {
      result.result.matches.push(match);
    }
  }

  const orderedResults = [...results.values()];
  const hasMore = orderedResults.length > input.limit;
  const pageResults = orderedResults.slice(0, input.limit);
  const last = pageResults.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeSearchCursor({
          version: 1,
          queryHash,
          snapshot,
          sortValues: last.sortValues,
          resultId: last.result.resultId,
        })
      : undefined;

  return archiveSearchPageSchema.parse({
    unit: resultUnit,
    snapshot,
    results: pageResults.map(({ result }) => result),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
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
      const { requestId, ...payload } = submission;
      const payloadHash = hashJson(payload);
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
          for (const item of submission.items) {
            const identities = await transaction<
              {
                readonly item_id: string;
              }[]
            >`
              SELECT item_id
              FROM archive_item
              WHERE namespace = ${item.sourceKey.namespace}
                AND source_key = ${item.sourceKey.key}
            `;
            let itemId = identities[0]?.item_id;
            if (itemId === undefined) {
              itemId = randomUUID();
              await transaction`
                INSERT INTO archive_item (item_id, namespace, source_key)
                VALUES (
                  ${itemId},
                  ${item.sourceKey.namespace},
                  ${item.sourceKey.key}
                )
              `;
            }

            const state = stateForItem(item);
            const stateJson = canonicalJson(state);
            const stateHash = createHash("sha256")
              .update(stateJson)
              .digest("hex");
            const revisions = await transaction<RevisionRow[]>`
              SELECT revision_id, state_hash, state_data
              FROM archive_revision
              WHERE item_id = ${itemId}
                AND state_hash = ${stateHash}
            `;
            const existingRevision = revisions[0];
            let revisionId: string;
            if (existingRevision === undefined) {
              revisionId = randomUUID();
              await transaction`
                INSERT INTO archive_revision (
                  revision_id,
                  item_id,
                  state_hash,
                  state_data
                ) VALUES (
                  ${revisionId},
                  ${itemId},
                  ${stateHash},
                  ${transaction.json(postgresJsonValue(state))}
                )
              `;
            } else {
              if (canonicalJson(existingRevision.state_data) !== stateJson) {
                throw new Error("归档状态哈希冲突，不能复用现有版本。");
              }
              revisionId = existingRevision.revision_id;
            }

            for (const [ordinal, resource] of (
              state.resources ?? []
            ).entries()) {
              await transaction`
                INSERT INTO archive_revision_resource (
                  revision_id,
                  resource_id,
                  ordinal
                ) VALUES (
                  ${revisionId},
                  ${resource.resourceId},
                  ${ordinal}
                ) ON CONFLICT (revision_id, resource_id) DO NOTHING
              `;
            }

            preparedItems.push({
              itemId,
              revisionId,
              sourceKey: item.sourceKey,
              state,
              diagnostics: item.diagnostics,
            });
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
            value: archiveCommitSchema.parse({
              commitId,
              archiveSeq,
              binId: submission.binId,
              ...(submission.runId === undefined
                ? {}
                : { runId: submission.runId }),
              ...(submission.collectorVersion === undefined
                ? {}
                : { collectorVersion: submission.collectorVersion }),
              observedAt,
              recordedAt: isoTimestamp(recordedAt),
              items: preparedItems.map((item) => ({
                itemId: item.itemId,
                revisionId: item.revisionId,
                sourceKey: item.sourceKey,
              })),
            }),
          };
        },
      );
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
      if (
        requestedCursor !== undefined &&
        (decodedCursor === undefined ||
          decodedCursor.queryHash !== queryHash ||
          decodedCursor.sortValues.length !== checked.data.orderBy.length ||
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
          return {
            ok: true,
            value: await readCurrentSearchPage(
              transaction,
              fixedSnapshot,
              checked.data,
              decodedCursor,
              queryHash,
            ),
          };
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
        if (
          checked.data.text.kind === "regex" &&
          postgresErrorCode(error) === "2201B"
        ) {
          return {
            ok: false,
            status: 400,
            error: {
              code: "invalid_input",
              message: "PostgreSQL ARE 正则表达式无效。",
              path: ["text", "pattern"],
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
