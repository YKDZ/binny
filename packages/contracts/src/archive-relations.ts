import * as z from "zod";

import {
  archiveIdentifierSchema,
  archiveRelationStateSchema,
  archiveSnapshotSchema,
  archiveSnapshotSequenceSchema,
  withArchiveJsonSchemaProjection,
  type ArchiveOperation,
  type ArchiveReadOptions,
} from "./archive.ts";
import { binIdSchema } from "./bin-configuration.ts";
import { postgresTextSchema } from "./postgres-text.ts";

const nonEmptyText = postgresTextSchema.min(1).max(4096);
const timestampSchema = z.iso.datetime({ offset: true });
const sourceKeySchema = z
  .object({ namespace: nonEmptyText.max(256), key: nonEmptyText.max(1024) })
  .strict();

export const archiveRelationReadQuerySchema = z
  .object({
    direction: z.enum(["outgoing", "incoming"]),
    binId: binIdSchema,
    asOf: archiveSnapshotSequenceSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
      .optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();

const archiveRelationItemEndpointSchema = z
  .object({
    kind: z.literal("item"),
    itemId: archiveIdentifierSchema,
    sourceKey: sourceKeySchema,
    status: z.enum(["observed", "unknown"]),
    revisionId: archiveIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((endpoint, context) => {
    if (endpoint.status === "observed" && endpoint.revisionId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["revisionId"],
        message: "已观察对象必须关联内容版本。",
      });
    }
    if (endpoint.status === "unknown" && endpoint.revisionId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["revisionId"],
        message: "未知对象视图不能关联内容版本。",
      });
    }
  });

const archiveRelationSourceRefEndpointSchema = z
  .object({
    kind: z.literal("sourceRef"),
    sourceRef: nonEmptyText.max(4096),
  })
  .strict();

const archiveRelationReadEndpointSchema = z.discriminatedUnion("kind", [
  archiveRelationItemEndpointSchema,
  archiveRelationSourceRefEndpointSchema,
]);

const archiveRelationObservationProvenanceSchema = z
  .object({
    commitId: archiveIdentifierSchema,
    archiveSeq: z.string().regex(/^[1-9][0-9]*$/u),
    ordinal: z.number().int().nonnegative(),
    observedAt: timestampSchema,
    recordedAt: timestampSchema,
    runId: nonEmptyText.max(128).optional(),
    sourceAdapterVersion: nonEmptyText.max(256).optional(),
  })
  .strict();

const archiveRelationEntryFields = {
  relationId: nonEmptyText.max(256),
  from: archiveRelationItemEndpointSchema,
  to: archiveRelationReadEndpointSchema,
};

export const archiveRelationEntrySchema = withArchiveJsonSchemaProjection(
  z.union([
    z
      .object({
        ...archiveRelationEntryFields,
        status: z.literal("observed"),
        revisionId: archiveIdentifierSchema,
        state: archiveRelationStateSchema,
        observation: archiveRelationObservationProvenanceSchema,
      })
      .strict(),
    z
      .object({
        ...archiveRelationEntryFields,
        status: z.literal("withdrawn"),
        observation: archiveRelationObservationProvenanceSchema,
      })
      .strict(),
    z
      .object({
        relationId: nonEmptyText.max(256),
        status: z.literal("deleted"),
        observation: archiveRelationObservationProvenanceSchema,
      })
      .strict(),
    z
      .object({
        ...archiveRelationEntryFields,
        status: z.literal("unknown"),
      })
      .strict(),
  ]),
);

export const archiveRelationCursorSchema = z
  .object({
    version: z.literal(1),
    itemId: archiveIdentifierSchema,
    binId: binIdSchema,
    direction: z.enum(["outgoing", "incoming"]),
    snapshot: archiveSnapshotSchema,
    after: z.object({ relationId: nonEmptyText.max(256) }).strict(),
  })
  .strict();

export const archiveRelationPageSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      itemId: archiveIdentifierSchema,
      binId: binIdSchema,
      direction: z.enum(["outgoing", "incoming"]),
      snapshot: archiveSnapshotSchema,
      relations: z.array(archiveRelationEntrySchema),
      nextCursor: z.string().min(1).max(4096).optional(),
    })
    .strict(),
);

export type ArchiveRelationEntry = z.infer<typeof archiveRelationEntrySchema>;
export type ArchiveRelationPage = z.infer<typeof archiveRelationPageSchema>;
export type ArchiveRelationOptions = ArchiveReadOptions & {
  readonly binId: z.infer<typeof binIdSchema>;
  readonly direction: "outgoing" | "incoming";
  readonly limit?: number;
  readonly cursor?: string;
};

export type ArchiveRelationsOperations = {
  getArchiveRelations(
    itemId: string,
    options: ArchiveRelationOptions,
  ): Promise<ArchiveOperation<ArchiveRelationPage>>;
};
