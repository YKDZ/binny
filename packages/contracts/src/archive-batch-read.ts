import * as z from "zod";

import {
  archiveBatchReadMaxReferences,
  archiveBatchReadReferenceSchema,
  archiveErrorDiagnosticSchema,
  archiveIdentifierSchema,
  archiveRevisionReadSchema,
  withArchiveJsonSchemaProjection,
  type ArchiveError,
  type ArchiveErrorDiagnostic,
} from "./archive.ts";

export {
  archiveBatchReadMaxReferences,
  archiveBatchReadMaxResponseBytes,
  archiveBatchReadReferenceSchema,
  type ArchiveBatchReadReference,
} from "./archive.ts";

/**
 * Read selected immutable versions by their complete search reference. A
 * repeated reference remains a separate result at its original zero-based
 * index. Requests accept up to 50 references; complete responses are limited
 * to 16 MiB.
 */
export const archiveBatchReadInputSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      references: z
        .array(archiveBatchReadReferenceSchema)
        .min(1, "Provide at least one archive reference.")
        .max(
          archiveBatchReadMaxReferences,
          `Batch read accepts at most ${String(archiveBatchReadMaxReferences)} references per request.`,
        ),
    })
    .strict(),
);

/**
 * Extract structured limit facts when a batch-read request exceeds the maximum
 * number of references per request.
 */
export function archiveBatchReadInputDiagnostic(
  input: unknown,
  issue: z.core.$ZodIssue | undefined,
): ArchiveErrorDiagnostic | undefined {
  if (issue === undefined || issue.path[0] !== "references") return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const references = (input as { readonly references?: unknown }).references;
  if (
    !Array.isArray(references) ||
    references.length <= archiveBatchReadMaxReferences
  ) {
    return undefined;
  }
  return archiveErrorDiagnosticSchema.parse({
    maxReferences: archiveBatchReadMaxReferences,
    requestedReferences: references.length,
  });
}

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
