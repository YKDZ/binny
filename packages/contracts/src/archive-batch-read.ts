import * as z from "zod";

import {
  archiveIdentifierSchema,
  archiveRevisionReadSchema,
  archiveSequenceSchema,
  withArchiveJsonSchemaProjection,
  type ArchiveError,
} from "./archive.ts";
import { binIdSchema } from "./bin-configuration.ts";

/** Maximum number of selected archive views accepted by one batch request. */
export const archiveBatchReadMaxReferences = 50;

/** Maximum serialized success response size; larger batches must be split. */
export const archiveBatchReadMaxResponseBytes = 16 * 1024 * 1024;

/** One exact content version as observed by one bin in one archive commit. */
export const archiveBatchReadReferenceSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      itemId: archiveIdentifierSchema,
      binId: binIdSchema,
      revisionId: archiveIdentifierSchema,
      archiveSeq: archiveSequenceSchema,
    })
    .strict(),
);

export type ArchiveBatchReadReference = z.infer<
  typeof archiveBatchReadReferenceSchema
>;

/**
 * Read selected immutable versions by their complete search reference. A
 * repeated reference remains a separate result at its original zero-based
 * index. Requests accept up to 50 references; complete responses are limited
 * to 16 MiB and must be split when that limit is exceeded.
 */
export const archiveBatchReadInputSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      references: z
        .array(archiveBatchReadReferenceSchema)
        .min(1, "Provide at least one archive reference.")
        .max(
          archiveBatchReadMaxReferences,
          `Read at most ${String(archiveBatchReadMaxReferences)} references per request; split the remaining references into another request.`,
        ),
    })
    .strict(),
);

export type ArchiveBatchReadInput = z.infer<typeof archiveBatchReadInputSchema>;
export type ArchiveBatchReadRequest = z.input<
  typeof archiveBatchReadInputSchema
>;

const archiveBatchReadResourceSchema = z
  .object({
    resourceId: archiveIdentifierSchema,
    status: z.enum(["available", "missing"]),
  })
  .strict();

const archiveBatchReadItemResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      index: z.int().nonnegative(),
      reference: archiveBatchReadReferenceSchema,
      status: z.literal("readable"),
      revision: archiveRevisionReadSchema,
      resources: z.array(archiveBatchReadResourceSchema),
    })
    .strict(),
  z
    .object({
      index: z.int().nonnegative(),
      reference: archiveBatchReadReferenceSchema,
      status: z.literal("unreadable"),
      reason: z.enum(["deleted", "not_found", "reference_mismatch"]),
    })
    .strict(),
]);

/** One result per input reference, in input order, with complete stored body data. */
export const archiveBatchReadResponseSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      results: z.array(archiveBatchReadItemResultSchema),
    })
    .strict(),
);

export type ArchiveBatchReadItemResult = z.infer<
  typeof archiveBatchReadItemResultSchema
>;
export type ArchiveBatchReadResponse = z.infer<
  typeof archiveBatchReadResponseSchema
>;

/** The batch read can fail as a whole; individual unreadable items are results. */
export type ArchiveBatchReadOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 413 | 422 | 503;
      readonly error: ArchiveError;
    };
