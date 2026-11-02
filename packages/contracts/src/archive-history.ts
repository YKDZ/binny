import * as z from "zod";

import {
  archiveIdentifierSchema,
  archiveSequenceSchema,
  archiveSnapshotSchema,
  archiveSnapshotSequenceSchema,
  archiveRelationStateSchema,
  withArchiveJsonSchemaProjection,
  type ArchiveCommit,
  type ArchiveOperation,
  type ArchiveReadOptions,
} from "./archive.ts";
import { binIdSchema } from "./bin-configuration.ts";
import { postgresTextSchema } from "./postgres-text.ts";

const nonEmptyText = postgresTextSchema.min(1).max(4096);
const timestampSchema = z.iso.datetime({ offset: true });

export const archiveTimelineQuerySchema = z
  .object({
    binId: binIdSchema.optional(),
    asOf: archiveSnapshotSequenceSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
      .optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const archiveItemReadQuerySchema = z
  .object({
    binId: binIdSchema.optional(),
    asOf: archiveSnapshotSequenceSchema.optional(),
  })
  .strict();

const archiveTimelineMetadata = {
  commitId: archiveIdentifierSchema,
  archiveSeq: archiveSequenceSchema,
  ordinal: z.number().int().nonnegative(),
  binId: binIdSchema,
  runId: nonEmptyText.max(128).optional(),
  sourceAdapterVersion: nonEmptyText.max(256).optional(),
  observedAt: timestampSchema,
  recordedAt: timestampSchema,
};

export const archiveTimelineItemEventSchema = z
  .object({
    ...archiveTimelineMetadata,
    kind: z.literal("item"),
    itemId: archiveIdentifierSchema,
    revisionId: archiveIdentifierSchema,
    sourceModifiedAt: timestampSchema.optional(),
  })
  .strict();

const archiveTimelineRelationEventFields = {
  ...archiveTimelineMetadata,
  kind: z.literal("relation"),
  relationId: nonEmptyText.max(256),
};

export const archiveTimelineRelationObservedEventSchema =
  withArchiveJsonSchemaProjection(
    z
      .object({
        ...archiveTimelineRelationEventFields,
        status: z.literal("observed"),
        revisionId: archiveIdentifierSchema,
        state: archiveRelationStateSchema,
      })
      .strict(),
  );

export const archiveTimelineRelationWithdrawnEventSchema = z
  .object({
    ...archiveTimelineRelationEventFields,
    status: z.literal("withdrawn"),
  })
  .strict();

const archiveTimelineGapSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("item"),
      itemId: archiveIdentifierSchema,
      sourceKey: z
        .object({
          namespace: postgresTextSchema.min(1).max(256),
          key: postgresTextSchema.min(1).max(1024),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ kind: z.literal("relation"), relationId: nonEmptyText.max(256) })
    .strict(),
]);

export const archiveTimelineGapEventSchema = z
  .object({
    ...archiveTimelineMetadata,
    kind: z.literal("gap"),
    subject: archiveTimelineGapSubjectSchema,
  })
  .strict();

export const archiveTimelineRelationEventSchema =
  withArchiveJsonSchemaProjection(
    z.union([
      archiveTimelineRelationObservedEventSchema,
      archiveTimelineRelationWithdrawnEventSchema,
    ]),
  );

export const archiveTimelineEventSchema = withArchiveJsonSchemaProjection(
  z.union([
    archiveTimelineItemEventSchema,
    archiveTimelineRelationEventSchema,
    archiveTimelineGapEventSchema,
  ]),
);

/** 混合条目与关系事件，并按归档序号、批内序号和 commit ID 升序分页。 */
export const archiveTimelinePageSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      itemId: archiveIdentifierSchema,
      snapshot: archiveSnapshotSchema,
      events: z.array(archiveTimelineEventSchema),
      nextCursor: z.string().min(1).max(4096).optional(),
    })
    .strict(),
);

export const archiveTimelineCursorSchema = z
  .object({
    version: z.literal(1),
    itemId: archiveIdentifierSchema,
    binId: binIdSchema.nullable(),
    snapshot: archiveSnapshotSchema,
    after: z
      .object({
        archiveSeq: archiveSequenceSchema,
        ordinal: z.number().int().nonnegative(),
        commitId: archiveIdentifierSchema,
      })
      .strict(),
  })
  .strict();

export type ArchiveTimelineItemEvent = z.infer<
  typeof archiveTimelineItemEventSchema
>;
export type ArchiveTimelineRelationEvent = z.infer<
  typeof archiveTimelineRelationEventSchema
>;
export type ArchiveTimelineGapEvent = z.infer<
  typeof archiveTimelineGapEventSchema
>;
export type ArchiveTimelineEvent = z.infer<typeof archiveTimelineEventSchema>;
export type ArchiveTimelinePage = z.infer<typeof archiveTimelinePageSchema>;
export type ArchiveTimelineOptions = ArchiveReadOptions & {
  readonly limit?: number;
  readonly cursor?: string;
};

export type ArchiveHistoryOperations = {
  getArchiveTimeline(
    itemId: string,
    options?: ArchiveTimelineOptions,
  ): Promise<ArchiveOperation<ArchiveTimelinePage>>;
  getArchiveCommit(commitId: string): Promise<ArchiveOperation<ArchiveCommit>>;
};
