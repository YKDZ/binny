import * as z from "zod";

import {
  binIdSchema,
  sourceAdapterActionNameSchema,
} from "./bin-configuration.ts";
import {
  manualRunSchema,
  manualRunStatusSchema,
  type ManualRunApiError,
} from "./manual-run.ts";
import {
  postgresTextSchema,
  registerPostgresJsonSchemaProjection,
  withPostgresJsonSchemaProjection,
} from "./postgres-text.ts";

const timestampSchema = z.iso.datetime({ offset: true });

export const manualRunListQuerySchema = withPostgresJsonSchemaProjection(
  z
    .object({
      binId: binIdSchema.optional(),
      action: sourceAdapterActionNameSchema.optional(),
      status: manualRunStatusSchema.optional(),
      createdFrom: timestampSchema.optional(),
      createdBefore: timestampSchema.optional(),
      limit: z
        .string()
        .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
        .optional(),
      cursor: z.string().min(1).max(4096).optional(),
    })
    .strict()
    .superRefine(({ createdFrom, createdBefore }, context) => {
      if (
        createdFrom !== undefined &&
        createdBefore !== undefined &&
        Date.parse(createdFrom) >= Date.parse(createdBefore)
      ) {
        context.addIssue({
          code: "custom",
          path: ["createdBefore"],
          message:
            "The run creation-time upper bound must be later than the lower bound.",
        });
      }
    }),
);

export const manualRunTriggerTypeSchema = z.enum(["manual", "schedule"]);

const manualRunListSummaryFieldsSchema = manualRunSchema
  .pick({
    runId: true,
    binId: true,
    action: true,
    status: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
  })
  .extend({
    triggerType: manualRunTriggerTypeSchema,
    stopReasonCode: postgresTextSchema.min(1).optional(),
  })
  .strict();

const manualRunListSummaryCheckedSchema =
  manualRunListSummaryFieldsSchema.superRefine((summary, context) => {
    const terminal =
      summary.status === "completed" ||
      summary.status === "failed" ||
      summary.status === "cancelled";
    if (terminal && summary.stopReasonCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["stopReasonCode"],
        message: "Terminal runs must include a stopReasonCode.",
      });
    } else if (!terminal && summary.stopReasonCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["stopReasonCode"],
        message: "Non-terminal runs must not include a stopReasonCode.",
      });
    }
  });

registerPostgresJsonSchemaProjection(
  manualRunListSummaryFieldsSchema,
  manualRunListSummaryCheckedSchema,
  manualRunListSummaryFieldsSchema,
);

/** List projection; parameters, reports, and results remain on run detail. */
export const manualRunListSummarySchema = withPostgresJsonSchemaProjection(
  manualRunListSummaryCheckedSchema,
);

export const manualRunListPageSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      runs: z.array(manualRunListSummarySchema),
      nextCursor: z.string().min(1).max(4096).optional(),
    })
    .strict(),
);

const manualRunListCursorFilterSchema = z
  .object({
    binId: binIdSchema.optional(),
    action: sourceAdapterActionNameSchema.optional(),
    status: manualRunStatusSchema.optional(),
    createdFrom: timestampSchema.optional(),
    createdBefore: timestampSchema.optional(),
    limit: z.int().min(1).max(100),
  })
  .strict();

export const manualRunListCursorSchema = z
  .object({
    version: z.literal(1),
    filter: manualRunListCursorFilterSchema,
    before: z
      .object({
        createdAt: timestampSchema,
        binId: binIdSchema,
        runId: z.string().uuid(),
      })
      .strict(),
  })
  .strict();

export type ManualRunListQuery = z.infer<typeof manualRunListQuerySchema>;
export type ManualRunListSummary = z.infer<typeof manualRunListSummarySchema>;
export type ManualRunListPage = z.infer<typeof manualRunListPageSchema>;
export type ManualRunListCursor = z.infer<typeof manualRunListCursorSchema>;
export type ManualRunListFilter = z.infer<
  typeof manualRunListCursorFilterSchema
>;

export type ManualRunListOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400;
      readonly error: ManualRunApiError;
    };

export type ManualRunListOperations = {
  /**
   * List every bin by default in pages of 20 (maximum 100). Combine optional
   * bin, action, status, and creation-time filters with AND. Order is createdAt,
   * binId, and runId descending. `createdFrom` is inclusive and
   * `createdBefore` is exclusive. A cursor continues the same filters and page
   * size; invalid filters or mismatched cursors return a 400 input error.
   */
  listRuns(
    input: ManualRunListQuery,
  ): Promise<ManualRunListOperation<ManualRunListPage>>;
};
