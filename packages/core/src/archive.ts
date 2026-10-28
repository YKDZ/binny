import { createHash, randomUUID } from "node:crypto";

import {
  archiveIdentifierSchema,
  archiveItemDeletionResultSchema,
  archiveItemStateSchema,
  archiveRelationStateSchema,
  archiveSubmissionInputSchema,
  type ArchiveOperations,
  type ArchiveRelationState,
  type ArchiveSubmissionInput,
} from "@binny/contracts";
import type postgres from "postgres";

import { canonicalJson, failure, validationFailure } from "./archive-common.ts";
import {
  advanceArchiveSequence,
  withArchiveWriteLock,
} from "./archive-lock.ts";
import { createArchiveReadOperations, readCommit } from "./archive-read.ts";
import { createArchiveResourceStorage } from "./archive-resource-storage.ts";
import { createArchiveSearchOperation } from "./archive-search.ts";
import type { CoreDatabase } from "./database.ts";

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

export type ArchiveStoreOptions = {
  readonly resourceDirectory: string;
  readonly unreferencedResourceAgeMs?: number;
  readonly resourceCleanupIntervalMs?: number;
};

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
  const readOperations = createArchiveReadOperations(database);
  const searchOperations = createArchiveSearchOperation(database);
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

    ...searchOperations,

    ...readOperations,
  };
}
