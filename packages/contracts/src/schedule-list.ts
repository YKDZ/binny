import * as z from "zod";

import {
  binIdSchema,
  sourceAdapterActionNameSchema,
} from "./bin-configuration.ts";
import { withPostgresJsonSchemaProjection } from "./postgres-text.ts";
import type { ScheduleApiError } from "./schedule.ts";

const timestampSchema = z.iso.datetime({ offset: true });

export const scheduleListQuerySchema = withPostgresJsonSchemaProjection(
  z
    .object({
      binId: binIdSchema.optional(),
      action: sourceAdapterActionNameSchema.optional(),
      enabled: z.enum(["true", "false"]).optional(),
      limit: z
        .string()
        .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
        .optional(),
      cursor: z.string().min(1).max(4096).optional(),
    })
    .strict(),
);

/** List projection; saved action parameters remain available through schedule detail. */
export const scheduleListSummarySchema = z
  .object({
    scheduleId: z.string().uuid(),
    binId: binIdSchema,
    action: sourceAdapterActionNameSchema,
    enabled: z.boolean(),
    nextDueAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const scheduleListPageSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      schedules: z.array(scheduleListSummarySchema),
      nextCursor: z.string().min(1).max(4096).optional(),
    })
    .strict(),
);

const scheduleListCursorFilterSchema = z
  .object({
    binId: binIdSchema.optional(),
    action: sourceAdapterActionNameSchema.optional(),
    enabled: z.boolean().optional(),
    limit: z.int().min(1).max(100),
  })
  .strict();

export const scheduleListCursorSchema = z
  .object({
    version: z.literal(1),
    filter: scheduleListCursorFilterSchema,
    before: z
      .object({
        createdAt: timestampSchema,
        binId: binIdSchema,
        scheduleId: z.string().uuid(),
      })
      .strict(),
  })
  .strict();

export type ScheduleListQuery = z.infer<typeof scheduleListQuerySchema>;
export type ScheduleListSummary = z.infer<typeof scheduleListSummarySchema>;
export type ScheduleListPage = z.infer<typeof scheduleListPageSchema>;
export type ScheduleListCursor = z.infer<typeof scheduleListCursorSchema>;
export type ScheduleListFilter = z.infer<typeof scheduleListCursorFilterSchema>;
export type ScheduleListOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400;
      readonly error: ScheduleApiError;
    };

export type ScheduleListOperations = {
  /**
   * List every bin by default in pages of 20 (maximum 100). Combine the
   * optional bin, action, and enabled filters with AND. Pages are ordered by
   * creation time, bin ID, then schedule ID ascending. The cursor continues the
   * same filters and page size; invalid filters or mismatched cursors return a
   * 400 input error.
   */
  listScheduleSummaries(
    input: ScheduleListQuery,
  ): Promise<ScheduleListOperation<ScheduleListPage>>;
};
