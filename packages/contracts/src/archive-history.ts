import * as z from "zod";

import {
  archiveIdentifierSchema,
  archiveSequenceSchema,
  archiveSnapshotSchema,
  archiveSnapshotSequenceSchema,
  archiveRelationStateSchema,
  type ArchiveCommit,
  type ArchiveOperation,
  type ArchiveReadOptions,
} from "./archive.ts";
import { binIdSchema } from "./bin-configuration.ts";

const nonEmptyText = z.string().min(1).max(4096);
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
  collectorVersion: nonEmptyText.max(256).optional(),
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

export const archiveTimelineRelationObservedEventSchema = z
  .object({
    ...archiveTimelineRelationEventFields,
    status: z.literal("observed"),
    revisionId: archiveIdentifierSchema,
    state: archiveRelationStateSchema,
  })
  .strict();

export const archiveTimelineRelationWithdrawnEventSchema = z
  .object({
    ...archiveTimelineRelationEventFields,
    status: z.literal("withdrawn"),
  })
  .strict();

export const archiveTimelineRelationEventSchema = z.union([
  archiveTimelineRelationObservedEventSchema,
  archiveTimelineRelationWithdrawnEventSchema,
]);

export const archiveTimelineEventSchema = z.union([
  archiveTimelineItemEventSchema,
  archiveTimelineRelationEventSchema,
]);

/** 混合条目与关系事件，并按归档序号、批内序号和 commit ID 升序分页。 */
export const archiveTimelinePageSchema = z
  .object({
    itemId: archiveIdentifierSchema,
    snapshot: archiveSnapshotSchema,
    events: z.array(archiveTimelineEventSchema),
    nextCursor: z.string().min(1).max(4096).optional(),
  })
  .strict();

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
