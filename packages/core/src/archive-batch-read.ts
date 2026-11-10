import {
  archiveBatchReadInputSchema,
  archiveBatchReadMaxResponseBytes,
  archiveBatchReadResponseSchema,
  archiveRevisionReadSchema,
  type ArchiveOperationContext,
  type ArchiveBatchReadItemResult,
  type ArchiveBatchReadOperation,
  type ArchiveBatchReadRequest,
  type ArchiveOperations,
} from "@binny/contracts";
import { databaseErrorCode, type CancellableQueryExecutor } from "@binny/db";
import { sql } from "drizzle-orm";

import { archiveJsonStringifyByteLength } from "./archive-json-size.ts";
import {
  ArchiveRequestCancelled,
  ArchiveQueryBudgetExceeded,
  assertArchiveQueryActive,
  createArchiveQueryDeadline,
  executeArchiveQueryWithinDeadline,
} from "./archive-query-budget.ts";
import type { ArchiveResourceStorage } from "./archive-resource-storage.ts";

type BatchReadRow = {
  readonly referenceIndex: number;
  readonly itemId: string | null;
  readonly namespace: string | null;
  readonly sourceKey: string | null;
  readonly deletionSequence: string | null;
  readonly revisionId: string | null;
  readonly revisionItemId: string | null;
  readonly stateHash: string | null;
  readonly observedArchiveSeq: string | null;
};

type ArchiveRevisionStateRow = {
  readonly stateData: unknown;
};

type CurrentItemStatusRow = {
  readonly itemId: string | null;
  readonly deletionSequence: string | null;
};

type ReadableReferenceGroup = {
  readonly row: BatchReadRow;
  readonly referenceIndexes: number[];
};

type ReadableRevision = {
  readonly revision: ReturnType<typeof archiveRevisionReadSchema.parse>;
  readonly serializedBytes: number;
  readonly resourceIds: readonly string[];
  readonly minimumResourcesBytes: number;
  resources?: {
    readonly resourceId: string;
    readonly status: "available" | "missing";
  }[];
  resourceBytes?: number;
};

function payloadTooLarge(): ArchiveBatchReadOperation<never> {
  return {
    ok: false,
    status: 413,
    error: {
      code: "payload_too_large",
      message: `The complete batch response exceeds ${String(archiveBatchReadMaxResponseBytes)} bytes. Split the references into smaller requests; if one revision alone exceeds this limit, read it with archive revision <revision-id>.`,
    },
  };
}

function budgetFailure(budgetMs: number): ArchiveBatchReadOperation<never> {
  return {
    ok: false,
    status: 422,
    error: {
      code: "query_budget_exceeded",
      message: `Batch read exceeded the server request budget of ${String(budgetMs)} ms; no partial results were returned.`,
    },
  };
}

function invalidInput(
  message: string,
  path: readonly (string | number)[],
): ArchiveBatchReadOperation<never> {
  return {
    ok: false,
    status: 400,
    error: { code: "invalid_input", message, path: [...path] },
  };
}

/**
 * Read selected immutable item views through bounded, cancellable queries with
 * one shared deadline covering resource checks and complete result assembly.
 */
export function createArchiveBatchReadOperation(
  resourceStorage: ArchiveResourceStorage,
  executeQuery: CancellableQueryExecutor,
  budgetMs: number,
): Pick<ArchiveOperations, "readArchiveBatch"> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) {
    throw new RangeError("Archive request budget must be a positive integer.");
  }

  return {
    async readArchiveBatch(
      request: ArchiveBatchReadRequest,
      context?: ArchiveOperationContext,
    ): Promise<
      ArchiveBatchReadOperation<
        ReturnType<typeof archiveBatchReadResponseSchema.parse>
      >
    > {
      const deadline =
        context?.deadline ?? createArchiveQueryDeadline(budgetMs);
      const signal = context?.signal;
      assertArchiveQueryActive(deadline, signal);
      const checked = archiveBatchReadInputSchema.safeParse(request);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return invalidInput(
          issue?.message ?? "Batch read request is invalid.",
          issue?.path.map((part) =>
            typeof part === "symbol" ? String(part) : part,
          ) ?? [],
        );
      }

      try {
        const requestJson = JSON.stringify(
          checked.data.references.map((reference, index) => ({
            reference_index: index,
            item_id: reference.itemId.toLowerCase(),
            bin_id: reference.binId,
            revision_id: reference.revisionId.toLowerCase(),
            archive_seq: reference.archiveSeq,
          })),
        );
        const rows = await executeArchiveQueryWithinDeadline(
          executeQuery,
          // Resolve references without copying revision bodies into every result row.
          sql<BatchReadRow[]>`
            WITH requested AS (
              SELECT *
              FROM jsonb_to_recordset(${requestJson}::text::jsonb) AS reference(
                reference_index integer,
                item_id uuid,
                bin_id text,
                revision_id uuid,
                archive_seq text
              )
            )
            SELECT
              requested.reference_index AS "referenceIndex",
              item.item_id::text AS "itemId",
              item.namespace AS "namespace",
              item.source_key AS "sourceKey",
              deletion.deletion_seq::text AS "deletionSequence",
              revision.revision_id::text AS "revisionId",
              revision.item_id::text AS "revisionItemId",
              revision.state_hash AS "stateHash",
              observed_commit.archive_seq::text AS "observedArchiveSeq"
            FROM requested
            LEFT JOIN archive_item AS item
              ON item.item_id = requested.item_id
            LEFT JOIN archive_item_deletion AS deletion
              ON deletion.item_id = requested.item_id
            LEFT JOIN archive_revision AS revision
              ON revision.revision_id = requested.revision_id
            LEFT JOIN archive_commit AS observed_commit
              ON observed_commit.archive_seq = requested.archive_seq::bigint
             AND observed_commit.bin_id = requested.bin_id
             AND EXISTS (
               SELECT 1
               FROM archive_observation AS observation
               WHERE observation.commit_id = observed_commit.commit_id
                 AND observation.item_id = requested.item_id
                 AND observation.revision_id = requested.revision_id
             )
            ORDER BY requested.reference_index
          `,
          deadline,
          signal,
        );
        if (rows.length !== checked.data.references.length) {
          throw new Error("Batch read did not resolve every input reference.");
        }

        const resultsByIndex = new Map<number, ArchiveBatchReadItemResult>();
        const readableGroups = new Map<string, ReadableReferenceGroup>();
        for (const row of rows) {
          assertArchiveQueryActive(deadline, signal);
          const reference = checked.data.references[row.referenceIndex];
          if (reference === undefined) {
            throw new Error("Batch read returned an unknown reference index.");
          }

          const unreadableReason =
            row.itemId === null
              ? row.deletionSequence === null
                ? "not_found"
                : "deleted"
              : row.revisionId === null
                ? "not_found"
                : row.revisionItemId?.toLowerCase() !==
                      reference.itemId.toLowerCase() ||
                    row.observedArchiveSeq !== reference.archiveSeq
                  ? "reference_mismatch"
                  : undefined;
          if (unreadableReason !== undefined) {
            resultsByIndex.set(row.referenceIndex, {
              index: row.referenceIndex,
              reference,
              status: "unreadable",
              reason: unreadableReason,
            });
            continue;
          }

          if (
            row.itemId === null ||
            row.namespace === null ||
            row.sourceKey === null ||
            row.revisionId === null ||
            row.revisionItemId === null ||
            row.stateHash === null
          ) {
            throw new Error(
              "Batch read resolved incomplete revision metadata.",
            );
          }
          const group = readableGroups.get(row.revisionId);
          if (group === undefined) {
            readableGroups.set(row.revisionId, {
              row,
              referenceIndexes: [row.referenceIndex],
            });
          } else {
            group.referenceIndexes.push(row.referenceIndex);
          }
        }

        const revisionsById = new Map<string, ReadableRevision>();
        const resourceIds: string[] = [];
        const assertActive = () => assertArchiveQueryActive(deadline, signal);
        const emptyResponseBytes = archiveJsonStringifyByteLength(
          { results: [] },
          archiveBatchReadMaxResponseBytes,
          assertActive,
        );
        if (emptyResponseBytes === undefined) {
          throw new Error(
            "Batch read response framing exceeds its byte limit.",
          );
        }

        // Unloaded references stay out until classified so a concurrent deletion cannot overstate this lower bound.
        const minimumResponseExceedsLimit = (): boolean => {
          let bytes =
            emptyResponseBytes +
            Math.max(0, checked.data.references.length - 1);
          for (
            let index = 0;
            index < checked.data.references.length;
            index += 1
          ) {
            assertActive();
            const result = resultsByIndex.get(index);
            if (result?.status === "unreadable") {
              const resultBytes = archiveJsonStringifyByteLength(
                result,
                archiveBatchReadMaxResponseBytes,
                assertActive,
              );
              if (resultBytes === undefined) return true;
              bytes += resultBytes;
            } else {
              const reference = checked.data.references[index];
              if (reference === undefined) {
                throw new Error(
                  "Batch read returned an unknown reference index.",
                );
              }
              const revision = revisionsById.get(
                reference.revisionId.toLowerCase(),
              );
              if (revision === undefined) continue;
              const baseBytes = archiveJsonStringifyByteLength(
                {
                  index,
                  reference,
                  status: "readable",
                  revision: {},
                  resources: [],
                },
                archiveBatchReadMaxResponseBytes,
                assertActive,
              );
              if (baseBytes === undefined) return true;
              bytes +=
                baseBytes -
                2 -
                2 +
                revision.serializedBytes +
                revision.minimumResourcesBytes;
            }
            if (bytes > archiveBatchReadMaxResponseBytes) return true;
          }
          return false;
        };

        for (const [revisionId, group] of readableGroups) {
          assertActive();
          const { row } = group;
          if (
            row.itemId === null ||
            row.revisionId === null ||
            row.stateHash === null
          ) {
            throw new Error(
              "Batch read resolved incomplete revision metadata.",
            );
          }
          const revisionRows = await executeArchiveQueryWithinDeadline(
            executeQuery,
            sql<ArchiveRevisionStateRow[]>`
              SELECT revision.state_data AS "stateData"
              FROM archive_revision AS revision
              WHERE revision.revision_id = ${row.revisionId}::uuid
                AND revision.item_id = ${row.itemId}::uuid
                AND revision.state_hash = ${row.stateHash}
            `,
            deadline,
            signal,
          );
          const revisionRow = revisionRows[0];
          if (revisionRow === undefined) {
            const currentItemRows = await executeArchiveQueryWithinDeadline(
              executeQuery,
              sql<CurrentItemStatusRow[]>`
                SELECT
                  item.item_id::text AS "itemId",
                  deletion.deletion_seq::text AS "deletionSequence"
                FROM (SELECT ${row.itemId}::uuid AS item_id) AS requested
                LEFT JOIN archive_item AS item
                  ON item.item_id = requested.item_id
                LEFT JOIN archive_item_deletion AS deletion
                  ON deletion.item_id = requested.item_id
              `,
              deadline,
              signal,
            );
            const currentItem = currentItemRows[0];
            const reason =
              currentItem !== undefined &&
              currentItem.itemId === null &&
              currentItem.deletionSequence !== null
                ? "deleted"
                : "not_found";
            for (const referenceIndex of group.referenceIndexes) {
              const reference = checked.data.references[referenceIndex];
              if (reference === undefined) {
                throw new Error(
                  "Batch read returned an unknown reference index.",
                );
              }
              resultsByIndex.set(referenceIndex, {
                index: referenceIndex,
                reference,
                status: "unreadable",
                reason,
              });
            }
            continue;
          }
          if (revisionRows.length !== 1) {
            throw new Error("Batch read resolved a revision more than once.");
          }
          const revision = archiveRevisionReadSchema.parse({
            revisionId: row.revisionId,
            itemId: row.itemId,
            sourceKey: { namespace: row.namespace, key: row.sourceKey },
            stateHash: row.stateHash,
            state: revisionRow.stateData,
          });
          const serializedBytes = archiveJsonStringifyByteLength(
            revision,
            archiveBatchReadMaxResponseBytes,
            assertActive,
          );
          if (serializedBytes === undefined) return payloadTooLarge();
          const revisionResourceIds = (revision.state.resources ?? []).map(
            ({ resourceId }) => resourceId,
          );
          // Missing is the shorter status, keeping this precheck a safe lower bound.
          const minimumResources = revisionResourceIds.map((resourceId) => ({
            resourceId,
            status: "missing" as const,
          }));
          const minimumResourcesBytes = archiveJsonStringifyByteLength(
            minimumResources,
            archiveBatchReadMaxResponseBytes,
            assertActive,
          );
          if (minimumResourcesBytes === undefined) return payloadTooLarge();
          revisionsById.set(revisionId, {
            revision,
            serializedBytes,
            resourceIds: revisionResourceIds,
            minimumResourcesBytes,
          });
          for (const resourceId of revisionResourceIds) {
            assertActive();
            resourceIds.push(resourceId);
          }
          if (minimumResponseExceedsLimit()) return payloadTooLarge();
        }

        const resourceAvailability = await resourceStorage.inspectAvailability(
          resourceIds,
          executeQuery,
          deadline,
          signal,
        );
        for (const [revisionId, readableRevision] of revisionsById) {
          assertActive();
          const resources = readableRevision.resourceIds.map((resourceId) => ({
            resourceId,
            status:
              resourceAvailability.get(resourceId.toLowerCase()) === true
                ? ("available" as const)
                : ("missing" as const),
          }));
          const resourceBytes = archiveJsonStringifyByteLength(
            resources,
            archiveBatchReadMaxResponseBytes,
            assertActive,
          );
          if (resourceBytes === undefined) return payloadTooLarge();
          readableRevision.resources = resources;
          readableRevision.resourceBytes = resourceBytes;
          revisionsById.set(revisionId, readableRevision);
        }

        const results: ArchiveBatchReadItemResult[] = [];
        let responseBytes = emptyResponseBytes;
        for (
          let index = 0;
          index < checked.data.references.length;
          index += 1
        ) {
          assertActive();
          const unreadableResult = resultsByIndex.get(index);
          let result: ArchiveBatchReadItemResult;
          let resultBytes: number | undefined;
          if (unreadableResult?.status === "unreadable") {
            result = unreadableResult;
            resultBytes = archiveJsonStringifyByteLength(
              result,
              archiveBatchReadMaxResponseBytes,
              assertActive,
            );
          } else {
            const reference = checked.data.references[index];
            if (reference === undefined) {
              throw new Error(
                "Batch read returned an unknown reference index.",
              );
            }
            const readableRevision = revisionsById.get(
              reference.revisionId.toLowerCase(),
            );
            if (
              readableRevision === undefined ||
              readableRevision.resources === undefined ||
              readableRevision.resourceBytes === undefined
            ) {
              throw new Error("Batch read did not load a readable revision.");
            }
            const baseBytes = archiveJsonStringifyByteLength(
              {
                index,
                reference,
                status: "readable",
                revision: {},
                resources: [],
              },
              archiveBatchReadMaxResponseBytes,
              assertActive,
            );
            if (baseBytes === undefined) return payloadTooLarge();
            resultBytes =
              baseBytes -
              2 -
              2 +
              readableRevision.serializedBytes +
              readableRevision.resourceBytes;
            result = {
              index,
              reference,
              status: "readable",
              revision: readableRevision.revision,
              resources: readableRevision.resources,
            };
          }
          if (resultBytes === undefined) return payloadTooLarge();
          responseBytes += resultBytes + (index > 0 ? 1 : 0);
          if (responseBytes > archiveBatchReadMaxResponseBytes) {
            return payloadTooLarge();
          }
          results.push(result);
        }
        assertActive();
        // Parsed revisions and references are shared; parsing the aggregate again would copy duplicate bodies.
        const response = {
          results,
        } satisfies ReturnType<typeof archiveBatchReadResponseSchema.parse>;
        return { ok: true, value: response };
      } catch (error) {
        if (signal?.aborted || error instanceof ArchiveRequestCancelled) {
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
