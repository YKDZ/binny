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
import { withPostgresJsonSchemaProjection } from "./postgres-text.ts";

const timestampSchema = z.iso.datetime({ offset: true });

export const manualRunListQuerySchema = withPostgresJsonSchemaProjection(
  z
    .object({
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
          message: "运行创建时间上界必须晚于下界。",
        });
      }
    }),
);

export const manualRunListSummarySchema = manualRunSchema.pick({
  runId: true,
  action: true,
  status: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
});

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
    binId: binIdSchema,
    filter: manualRunListCursorFilterSchema,
    before: z
      .object({
        createdAt: timestampSchema,
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
  listRuns(
    binId: string,
    input: ManualRunListQuery,
  ): Promise<ManualRunListOperation<ManualRunListPage>>;
};
