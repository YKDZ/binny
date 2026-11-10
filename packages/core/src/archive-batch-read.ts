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
  readonly stateData: unknown;
  readonly observedArchiveSeq: string | null;
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

/** Read selected immutable item views through one bounded, cancellable query. */
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
          // A JSON recordset keeps duplicate references and their input indexes in one cancellable query.
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
              revision.state_data AS "stateData",
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

        const results: ArchiveBatchReadItemResult[] = [];
        const resourceIds: string[] = [];
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
            results.push({
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
            row.stateHash === null ||
            row.stateData === null
          ) {
            throw new Error(
              "Batch read resolved an incomplete archive revision.",
            );
          }
          const revision = archiveRevisionReadSchema.parse({
            revisionId: row.revisionId,
            itemId: row.itemId,
            sourceKey: { namespace: row.namespace, key: row.sourceKey },
            stateHash: row.stateHash,
            state: row.stateData,
          });
          results.push({
            index: row.referenceIndex,
            reference,
            status: "readable",
            revision,
            resources: [],
          });
          resourceIds.push(
            ...(revision.state.resources ?? []).map(
              ({ resourceId }) => resourceId,
            ),
          );
        }

        const resourceAvailability = await resourceStorage.inspectAvailability(
          resourceIds,
          executeQuery,
          deadline,
          signal,
        );
        const response = archiveBatchReadResponseSchema.parse({
          results: results.map((result) =>
            result.status === "unreadable"
              ? result
              : {
                  ...result,
                  resources: (result.revision.state.resources ?? []).map(
                    ({ resourceId }) => ({
                      resourceId,
                      status:
                        resourceAvailability.get(resourceId.toLowerCase()) ===
                        true
                          ? ("available" as const)
                          : ("missing" as const),
                    }),
                  ),
                },
          ),
        });
        assertArchiveQueryActive(deadline, signal);
        if (
          Buffer.byteLength(JSON.stringify(response), "utf8") >
          archiveBatchReadMaxResponseBytes
        ) {
          return payloadTooLarge();
        }
        assertArchiveQueryActive(deadline, signal);
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
