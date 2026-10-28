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
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import { canonicalJson, failure, validationFailure } from "./archive-common.ts";
import {
  advanceArchiveSequence,
  withArchiveWriteLock,
} from "./archive-lock.ts";
import { createArchiveReadOperations, readCommit } from "./archive-read.ts";
import { createArchiveResourceStorage } from "./archive-resource-storage.ts";
import { createArchiveSearchOperation } from "./archive-search.ts";
import type { CoreDatabase, CoreTransaction } from "./database.ts";
import {
  archiveCommits,
  archiveItemDeletions,
  archiveItemObservationGaps,
  archiveItems,
  archiveObservations,
  archiveRelationObservationGaps,
  archiveRelationObservations,
  archiveRelationRevisions,
  archiveRelations,
  archiveRequestReceipts,
  archiveResources,
  archiveRevisionResources,
  archiveRevisions,
  archiveWriteClock,
  binConfigurations,
  manualRuns,
} from "./schema.ts";

// Drizzle 的 inArray 将每个 ID 展开为参数；分批避开 PostgreSQL 单条语句参数上限。
const inArrayChunkSize = 5_000;

type PreparedItem = {
  readonly itemId: string;
  readonly isNew: boolean;
  readonly isNewRevision: boolean;
  readonly revisionId: string;
  readonly sourceKey: ArchiveSubmissionInput["items"][number]["sourceKey"];
  readonly state: ReturnType<typeof archiveItemStateSchema.parse>;
  readonly diagnostics: ArchiveSubmissionInput["items"][number]["diagnostics"];
  readonly stateHash: string;
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

async function findCascadeItemIds(
  transaction: CoreTransaction,
  rootItemId: string,
): Promise<string[]> {
  const visited = new Set([rootItemId]);
  let frontier = [rootItemId];

  while (frontier.length > 0) {
    const targetsByRelation = new Map<string, string>();
    for (let offset = 0; offset < frontier.length; offset += inArrayChunkSize) {
      const frontierBatch = frontier.slice(offset, offset + inArrayChunkSize);
      const outgoingRelations = await transaction
        .select({
          relationId: archiveRelations.relationId,
          targetItemId: archiveRelations.targetItemId,
        })
        .from(archiveRelations)
        .where(
          and(
            inArray(archiveRelations.fromItemId, frontierBatch),
            isNotNull(archiveRelations.targetItemId),
          ),
        )
        .orderBy(asc(archiveRelations.relationId));
      for (const relation of outgoingRelations) {
        if (relation.targetItemId !== null) {
          targetsByRelation.set(relation.relationId, relation.targetItemId);
        }
      }
    }

    const relationIds = [...targetsByRelation.keys()];
    const nextFrontier = new Set<string>();
    for (
      let offset = 0;
      offset < relationIds.length;
      offset += inArrayChunkSize
    ) {
      const relationIdBatch = relationIds.slice(
        offset,
        offset + inArrayChunkSize,
      );
      const latestObservations = transaction
        .$with("latest_relation_observations")
        .as(
          transaction
            .selectDistinctOn(
              [
                archiveRelationObservations.relationId,
                archiveRelationObservations.binId,
              ],
              {
                relationId: archiveRelationObservations.relationId,
                relationRevisionId:
                  archiveRelationObservations.relationRevisionId,
              },
            )
            .from(archiveRelationObservations)
            .where(
              inArray(archiveRelationObservations.relationId, relationIdBatch),
            )
            .orderBy(
              asc(archiveRelationObservations.relationId),
              asc(archiveRelationObservations.binId),
              desc(archiveRelationObservations.archiveSequence),
              desc(archiveRelationObservations.ordinal),
              desc(archiveRelationObservations.commitId),
            ),
        );
      const currentStates = await transaction
        .with(latestObservations)
        .select({
          relationId: latestObservations.relationId,
          stateData: archiveRelationRevisions.stateData,
        })
        .from(latestObservations)
        .leftJoin(
          archiveRelationRevisions,
          and(
            eq(
              archiveRelationRevisions.relationId,
              latestObservations.relationId,
            ),
            eq(
              archiveRelationRevisions.relationRevisionId,
              latestObservations.relationRevisionId,
            ),
          ),
        );

      for (const currentState of currentStates) {
        if (currentState.stateData === null) continue;
        if (!archiveRelationStateSchema.parse(currentState.stateData).cascade) {
          continue;
        }
        const targetItemId = targetsByRelation.get(currentState.relationId);
        if (targetItemId !== undefined && !visited.has(targetItemId)) {
          visited.add(targetItemId);
          nextFrontier.add(targetItemId);
        }
      }
    }
    frontier = [...nextFrontier];
  }

  return [...visited].toSorted();
}

async function deleteArchiveItems(
  transaction: CoreTransaction,
  currentSequence: bigint,
  itemIds: readonly string[],
): Promise<{ readonly deletionSeq: string; readonly resourceIds: string[] }> {
  const items: {
    readonly itemId: string;
    readonly namespace: string;
    readonly sourceKey: string;
  }[] = [];
  for (let offset = 0; offset < itemIds.length; offset += inArrayChunkSize) {
    const itemIdBatch = itemIds.slice(offset, offset + inArrayChunkSize);
    items.push(
      ...(await transaction
        .select({
          itemId: archiveItems.itemId,
          namespace: archiveItems.namespace,
          sourceKey: archiveItems.sourceKey,
        })
        .from(archiveItems)
        .where(inArray(archiveItems.itemId, itemIdBatch))
        .for("update")),
    );
  }

  const relationIds = new Set<string>();
  for (let offset = 0; offset < itemIds.length; offset += inArrayChunkSize) {
    const itemIdBatch = itemIds.slice(offset, offset + inArrayChunkSize);
    const relations = await transaction
      .select({ relationId: archiveRelations.relationId })
      .from(archiveRelations)
      .where(
        or(
          inArray(archiveRelations.fromItemId, itemIdBatch),
          inArray(archiveRelations.targetItemId, itemIdBatch),
        ),
      )
      .for("update");
    for (const relation of relations) relationIds.add(relation.relationId);
  }
  const relationIdList = [...relationIds].toSorted();

  const resourceIds = new Set<string>();
  for (let offset = 0; offset < itemIds.length; offset += inArrayChunkSize) {
    const itemIdBatch = itemIds.slice(offset, offset + inArrayChunkSize);
    const resourceRows = await transaction
      .selectDistinct({
        resourceId: archiveRevisionResources.resourceId,
      })
      .from(archiveRevisions)
      .innerJoin(
        archiveRevisionResources,
        eq(archiveRevisionResources.revisionId, archiveRevisions.revisionId),
      )
      .where(inArray(archiveRevisions.itemId, itemIdBatch));
    for (const resource of resourceRows) resourceIds.add(resource.resourceId);
  }
  const resourceIdList = [...resourceIds].toSorted();
  const deletionSeq = await advanceArchiveSequence(
    transaction,
    currentSequence,
  );

  for (let offset = 0; offset < items.length; offset += inArrayChunkSize) {
    const itemBatch = items.slice(offset, offset + inArrayChunkSize);
    await transaction.insert(archiveItemDeletions).values(
      itemBatch.map((item) => ({
        itemId: item.itemId,
        namespace: item.namespace,
        sourceKey: item.sourceKey,
        deletionSequence: BigInt(deletionSeq),
      })),
    );
  }
  for (let offset = 0; offset < itemIds.length; offset += inArrayChunkSize) {
    const itemIdBatch = itemIds.slice(offset, offset + inArrayChunkSize);
    await transaction.insert(archiveItemObservationGaps).select((query) =>
      query
        .select({
          commitId: archiveObservations.commitId,
          ordinal: archiveObservations.ordinal,
          itemId: archiveObservations.itemId,
        })
        .from(archiveObservations)
        .where(inArray(archiveObservations.itemId, itemIdBatch)),
    );
  }

  for (
    let offset = 0;
    offset < relationIdList.length;
    offset += inArrayChunkSize
  ) {
    const relationIdBatch = relationIdList.slice(
      offset,
      offset + inArrayChunkSize,
    );
    await transaction.insert(archiveRelationObservationGaps).select((query) =>
      query
        .select({
          commitId: archiveRelationObservations.commitId,
          ordinal: archiveRelationObservations.ordinal,
          relationId: archiveRelations.relationId,
          fromItemId: archiveRelations.fromItemId,
          targetItemId: archiveRelations.targetItemId,
        })
        .from(archiveRelationObservations)
        .innerJoin(
          archiveRelations,
          eq(
            archiveRelations.relationId,
            archiveRelationObservations.relationId,
          ),
        )
        .where(inArray(archiveRelations.relationId, relationIdBatch)),
    );
    await transaction
      .delete(archiveRelationObservations)
      .where(inArray(archiveRelationObservations.relationId, relationIdBatch));
    await transaction
      .delete(archiveRelationRevisions)
      .where(inArray(archiveRelationRevisions.relationId, relationIdBatch));
    await transaction
      .delete(archiveRelations)
      .where(inArray(archiveRelations.relationId, relationIdBatch));
  }

  for (let offset = 0; offset < itemIds.length; offset += inArrayChunkSize) {
    const itemIdBatch = itemIds.slice(offset, offset + inArrayChunkSize);
    await transaction
      .delete(archiveObservations)
      .where(inArray(archiveObservations.itemId, itemIdBatch));
    await transaction
      .delete(archiveRevisionResources)
      .where(
        inArray(
          archiveRevisionResources.revisionId,
          transaction
            .select({ revisionId: archiveRevisions.revisionId })
            .from(archiveRevisions)
            .where(inArray(archiveRevisions.itemId, itemIdBatch)),
        ),
      );
    await transaction
      .delete(archiveRevisions)
      .where(inArray(archiveRevisions.itemId, itemIdBatch));
    await transaction
      .delete(archiveItems)
      .where(inArray(archiveItems.itemId, itemIdBatch));
  }

  for (
    let offset = 0;
    offset < resourceIdList.length;
    offset += inArrayChunkSize
  ) {
    const resourceIdBatch = resourceIdList.slice(
      offset,
      offset + inArrayChunkSize,
    );
    await transaction
      .update(archiveResources)
      .set({ status: "deleting" })
      .where(
        and(
          inArray(archiveResources.resourceId, resourceIdBatch),
          eq(archiveResources.status, "ready"),
          notExists(
            transaction
              .select({ resourceId: archiveRevisionResources.resourceId })
              .from(archiveRevisionResources)
              .where(
                eq(
                  archiveRevisionResources.resourceId,
                  archiveResources.resourceId,
                ),
              ),
          ),
        ),
      );
  }

  return { deletionSeq, resourceIds: resourceIdList };
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
          const receipts = await transaction
            .select({
              payloadHash: archiveRequestReceipts.payloadHash,
              commitId: archiveRequestReceipts.commitId,
            })
            .from(archiveRequestReceipts)
            .where(eq(archiveRequestReceipts.requestId, requestId));
          const receipt = receipts[0];
          if (receipt !== undefined) {
            if (receipt.payloadHash !== payloadHash) {
              return failure(
                409,
                "archive_request_conflict",
                "这个请求标识已经用于不同的归档负载。",
                ["requestId"],
              );
            }
            return {
              ok: true,
              value: await readCommit(transaction, receipt.commitId),
            };
          }

          if (submission.runId !== undefined) {
            // runId 在提交契约中是不透明文本；按 UUID 文本比较可保留无效格式只是不匹配的旧行为。
            const matchingRuns = await transaction
              .select({ action: manualRuns.action })
              .from(manualRuns)
              .where(eq(sql`${manualRuns.runId}::text`, submission.runId));
            if (matchingRuns[0]?.action === "check") {
              return failure(
                409,
                "check_run_archive_forbidden",
                "可用性检查运行不能提交归档资料。",
                ["runId"],
              );
            }
          }

          const bins = await transaction
            .select({ id: binConfigurations.id })
            .from(binConfigurations)
            .where(eq(binConfigurations.id, submission.binId));
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
            const identities = await transaction
              .select({ itemId: archiveItems.itemId })
              .from(archiveItems)
              .where(
                and(
                  eq(archiveItems.namespace, item.sourceKey.namespace),
                  eq(archiveItems.sourceKey, item.sourceKey.key),
                ),
              );
            const isNew = identities[0] === undefined;
            const itemId = identities[0]?.itemId ?? randomUUID();
            itemIdsBySourceKey.set(sourceKeyIdentity(item.sourceKey), itemId);

            const state = stateForItem(item);
            const stateJson = canonicalJson(state);
            const stateHash = createHash("sha256")
              .update(stateJson)
              .digest("hex");
            const revisions = isNew
              ? []
              : await transaction
                  .select({
                    revisionId: archiveRevisions.revisionId,
                    stateHash: archiveRevisions.stateHash,
                    stateData: archiveRevisions.stateData,
                  })
                  .from(archiveRevisions)
                  .where(
                    and(
                      eq(archiveRevisions.itemId, itemId),
                      eq(archiveRevisions.stateHash, stateHash),
                    ),
                  );
            const existingRevision = revisions[0];
            if (
              existingRevision !== undefined &&
              canonicalJson(existingRevision.stateData) !== stateJson
            ) {
              throw new Error("归档状态哈希冲突，不能复用现有版本。");
            }
            preparedItems.push({
              itemId,
              isNew,
              isNewRevision: existingRevision === undefined,
              revisionId: existingRevision?.revisionId ?? randomUUID(),
              sourceKey: item.sourceKey,
              state,
              diagnostics: item.diagnostics,
              stateHash,
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
            const rows = await transaction
              .select({ itemId: archiveItems.itemId })
              .from(archiveItems)
              .where(
                and(
                  eq(archiveItems.namespace, sourceKey.namespace),
                  eq(archiveItems.sourceKey, sourceKey.key),
                ),
              );
            return rows[0]?.itemId;
          };

          const preparedRelations: PreparedRelation[] = [];
          for (const [index, inputRelation] of submission.relations.entries()) {
            const existingRows = await transaction
              .select({
                relationId: archiveRelations.relationId,
                fromItemId: archiveRelations.fromItemId,
                targetItemId: archiveRelations.targetItemId,
                targetSourceRef: archiveRelations.targetSourceRef,
              })
              .from(archiveRelations)
              .where(eq(archiveRelations.relationId, inputRelation.relationId));
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
                fromItemId: existing.fromItemId,
                targetItemId: existing.targetItemId,
                targetSourceRef: existing.targetSourceRef,
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
              (existing.fromItemId !== fromItemId ||
                existing.targetItemId !== targetItemId ||
                existing.targetSourceRef !== targetSourceRef)
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
              await transaction.insert(archiveItems).values({
                itemId: item.itemId,
                namespace: item.sourceKey.namespace,
                sourceKey: item.sourceKey.key,
              });
            }
            if (item.isNewRevision) {
              await transaction.insert(archiveRevisions).values({
                revisionId: item.revisionId,
                itemId: item.itemId,
                stateHash: item.stateHash,
                stateData: item.state,
              });
            }
            for (const [ordinal, resource] of (
              item.state.resources ?? []
            ).entries()) {
              await transaction
                .insert(archiveRevisionResources)
                .values({
                  revisionId: item.revisionId,
                  resourceId: resource.resourceId,
                  ordinal,
                })
                .onConflictDoNothing({
                  target: [
                    archiveRevisionResources.revisionId,
                    archiveRevisionResources.resourceId,
                  ],
                });
            }
          }

          const archiveSeq = await advanceArchiveSequence(
            transaction,
            currentSequence,
          );
          const archiveSequence = BigInt(archiveSeq);
          const commitId = randomUUID();
          // PostgreSQL 的 now() 固定为事务开始时刻；归档记录时间沿用墙钟时间。
          // 该 SQL 表达式没有时间列 codec，复用 recorded_at 列解码为 Date。
          const recordedRows = await transaction
            .select({
              recordedAt: sql`clock_timestamp()`.mapWith(
                archiveCommits.recordedAt,
              ),
            })
            .from(archiveWriteClock);
          const recordedAt = recordedRows[0]?.recordedAt;
          if (!(recordedAt instanceof Date)) {
            throw new Error("无法读取归档记录时间。");
          }

          await transaction.insert(archiveCommits).values({
            commitId,
            archiveSequence,
            binId: submission.binId,
            runId: submission.runId ?? null,
            collectorVersion: submission.collectorVersion ?? null,
            observedAt: new Date(observedAt),
            recordedAt,
          });

          for (const relation of preparedRelations) {
            if (relation.isNew) {
              await transaction.insert(archiveRelations).values({
                relationId: relation.relationId,
                fromItemId: relation.fromItemId,
                targetItemId: relation.targetItemId,
                targetSourceRef: relation.targetSourceRef,
                createdSequence: archiveSequence,
              });
            }
            if (relation.state !== null) {
              const stateHash = relation.stateHash;
              if (stateHash === undefined) {
                throw new Error("关系状态缺少规范化哈希。");
              }
              const stateJson = canonicalJson(relation.state);
              const revisions = await transaction
                .select({
                  relationRevisionId:
                    archiveRelationRevisions.relationRevisionId,
                  stateHash: archiveRelationRevisions.stateHash,
                  stateData: archiveRelationRevisions.stateData,
                })
                .from(archiveRelationRevisions)
                .where(
                  and(
                    eq(
                      archiveRelationRevisions.relationId,
                      relation.relationId,
                    ),
                    eq(archiveRelationRevisions.stateHash, stateHash),
                  ),
                );
              const existingRevision = revisions[0];
              if (existingRevision === undefined) {
                relation.revisionId = randomUUID();
                await transaction.insert(archiveRelationRevisions).values({
                  relationRevisionId: relation.revisionId,
                  relationId: relation.relationId,
                  stateHash,
                  stateData: relation.state,
                });
              } else {
                if (canonicalJson(existingRevision.stateData) !== stateJson) {
                  throw new Error("关系状态哈希冲突，不能复用现有版本。");
                }
                relation.revisionId = existingRevision.relationRevisionId;
              }
            }
          }

          for (const [ordinal, item] of preparedItems.entries()) {
            await transaction.insert(archiveObservations).values({
              commitId,
              ordinal,
              itemId: item.itemId,
              revisionId: item.revisionId,
              diagnostics: item.diagnostics ?? null,
            });
          }

          for (const relation of preparedRelations) {
            await transaction.insert(archiveRelationObservations).values({
              commitId,
              ordinal: relation.ordinal,
              relationId: relation.relationId,
              binId: submission.binId,
              archiveSequence,
              relationRevisionId: relation.revisionId ?? null,
            });
          }

          await transaction.insert(archiveRequestReceipts).values({
            requestId,
            payloadHash,
            commitId,
          });

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
          const items = await transaction
            .select({
              itemId: archiveItems.itemId,
              namespace: archiveItems.namespace,
              sourceKey: archiveItems.sourceKey,
            })
            .from(archiveItems)
            .where(eq(archiveItems.itemId, checkedId.data))
            .for("update");
          const item = items[0];
          if (item === undefined) {
            const previousDeletions = await transaction
              .select({ itemId: archiveItemDeletions.itemId })
              .from(archiveItemDeletions)
              .where(eq(archiveItemDeletions.itemId, checkedId.data));
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

          const deletedItemIds = await findCascadeItemIds(
            transaction,
            item.itemId,
          );
          const deletion = await deleteArchiveItems(
            transaction,
            currentSequence,
            deletedItemIds,
          );

          return {
            ok: true as const,
            value: archiveItemDeletionResultSchema.parse({
              itemId: item.itemId,
              deletedItemIds,
              deletionSeq: deletion.deletionSeq,
              deleted: true,
            }),
            resourceIds: deletion.resourceIds,
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
