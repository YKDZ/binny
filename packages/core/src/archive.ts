import { createHash, randomUUID } from "node:crypto";

import {
  archiveCommitSchema,
  archiveIdentifierSchema,
  archiveItemInputSchema,
  archiveItemReadSchema,
  archiveItemStateSchema,
  archiveRevisionReadSchema,
  archiveSubmissionInputSchema,
  type ArchiveCommit,
  type ArchiveError,
  type ArchiveItemRead,
  type ArchiveOperation,
  type ArchiveOperations,
  type ArchiveRevisionRead,
  type ArchiveSubmissionInput,
} from "@binny/contracts";
import type postgres from "postgres";

import type { CoreDatabase } from "./database.ts";

type ArchiveTransaction = postgres.TransactionSql;

type ClockRow = {
  readonly last_seq: string;
};

type CommitRow = {
  readonly commit_id: string;
  readonly archive_seq: string;
  readonly bin_id: string;
  readonly run_id: string | null;
  readonly collector_version: string | null;
  readonly observed_at: Date;
  readonly recorded_at: Date;
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
  readonly diagnostics: unknown | null;
  readonly state_data: unknown;
};

type ObservationRow = CommitRow & {
  readonly revision_id: string;
  readonly diagnostics: unknown | null;
};

type RevisionReadRow = RevisionRow & ItemRow;

type PreparedItem = {
  readonly itemId: string;
  readonly revisionId: string;
  readonly sourceKey: ArchiveSubmissionInput["items"][number]["sourceKey"];
  readonly state: ReturnType<typeof archiveItemStateSchema.parse>;
  readonly diagnostics:
    | ArchiveSubmissionInput["items"][number]["diagnostics"]
    | undefined;
};

function failure<T>(
  status: 400 | 404 | 409,
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

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isoTimestamp(value: Date): string {
  return value.toISOString();
}

function optionalText<Name extends "runId" | "collectorVersion">(
  name: Name,
  value: string | null,
): Partial<Record<Name, string>> {
  return value === null ? {} : { [name]: value };
}

function optionalDiagnostics(value: unknown | null): {
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

/**
 * 每个归档写事务首先锁定同一时钟行；后续归档能力须复用此入口，
 * 以便身份合并、提交序号与未来的引用变更使用一致的写入顺序。
 */
export async function withArchiveWriteLock<T>(
  database: CoreDatabase,
  operation: (
    transaction: ArchiveTransaction,
    currentSequence: bigint,
  ) => Promise<T>,
): Promise<T> {
  return await database.begin(async (transaction) => {
    const clocks = await transaction<ClockRow[]>`
      SELECT last_seq::text AS last_seq
      FROM archive_write_clock
      WHERE clock_id = 1
      FOR UPDATE
    `;
    const clock = clocks[0];
    if (clock === undefined) {
      throw new Error("归档写入时钟尚未初始化。");
    }
    return await operation(transaction, BigInt(clock.last_seq));
  });
}

/** 仅在同一写事务中提交新的归档观察时推进全局序号。 */
export async function advanceArchiveSequence(
  transaction: ArchiveTransaction,
  currentSequence: bigint,
): Promise<string> {
  const nextSequence = (currentSequence + 1n).toString();
  const rows = await transaction<{ readonly last_seq: string }[]>`
    UPDATE archive_write_clock
    SET last_seq = ${nextSequence}::bigint
    WHERE clock_id = 1
    RETURNING last_seq::text AS last_seq
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("无法推进归档写入时钟。");
  }
  return row.last_seq;
}

/** 初始化文本归档表；bin_id 保留为来源值，不建立会级联删除的外键。 */
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

  const revisionRows = await transaction<RevisionRow[]>`
    SELECT revision_id, state_hash, state_data
    FROM archive_revision
    WHERE item_id = ${itemId}
    ORDER BY created_at, revision_id
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
      observation.diagnostics
    FROM archive_observation AS observation
    JOIN archive_commit AS commit ON commit.commit_id = observation.commit_id
    WHERE observation.item_id = ${itemId}
    ORDER BY commit.archive_seq, observation.ordinal
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
    ORDER BY commit.bin_id, commit.archive_seq DESC, observation.ordinal DESC
  `;

  return {
    ok: true,
    value: archiveItemReadSchema.parse({
      itemId: item.item_id,
      sourceKey: { namespace: item.namespace, key: item.source_key },
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
        binId: row.bin_id,
        revisionId: row.revision_id,
        observedAt: isoTimestamp(row.observed_at),
        recordedAt: isoTimestamp(row.recorded_at),
        ...optionalText("runId", row.run_id),
        ...optionalText("collectorVersion", row.collector_version),
        ...optionalDiagnostics(row.diagnostics),
      })),
    }),
  };
}

/** 创建使用共享 PostgreSQL 连接的原子文本归档操作。 */
export function createArchiveStore(database: CoreDatabase): ArchiveOperations {
  return {
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
                  ${transaction.json(state)}
                )
              `;
            } else {
              if (canonicalJson(existingRevision.state_data) !== stateJson) {
                throw new Error("归档状态哈希冲突，不能复用现有版本。");
              }
              revisionId = existingRevision.revision_id;
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
                    : transaction.json(item.diagnostics)
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

    async getArchiveItem(itemId) {
      const checkedId = archiveIdentifierSchema.safeParse(itemId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["itemId", ...issue.path],
          })),
        );
      }
      return await database.begin(async (transaction) => {
        await transaction.unsafe(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        return await readItem(transaction, checkedId.data);
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
  };
}
