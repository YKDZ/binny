import * as z from "zod";

import {
  binIdSchema,
  sourceAdapterActionNameSchema,
  identityIdSchema,
  jsonObjectSchema,
} from "./bin-configuration.ts";
import {
  postgresTextSchema,
  toPostgresJsonSchema,
  withPostgresJsonSchemaProjection,
} from "./postgres-text.ts";

const runIdSchema = z.string().uuid();
const failurePathSchema = z.array(z.union([postgresTextSchema, z.number()]));
const apiErrorPathSchema = z.array(z.union([z.string(), z.number()]));

export const manualRunStatusSchema = z.enum([
  "queued",
  "executing",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

export const manualRunTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z
    .object({
      kind: z.literal("schedule"),
      scheduleId: runIdSchema,
      scheduledFor: z.iso.datetime(),
    })
    .strict(),
]);

export const manualRunQueueReasonSchema = z.enum([
  "runtime_offline",
  "earlier_run_active",
  "earlier_run_queued",
  "previous_execution_unconfirmed",
  "human_session_active",
  "browser_capacity_exhausted",
  "bin_busy",
  "runtime_protocol_outdated",
]);

export const manualRunTriggerInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      action: sourceAdapterActionNameSchema,
      params: jsonObjectSchema,
    })
    .strict(),
);

export const manualRunFailureSchema = z
  .object({
    code: postgresTextSchema.min(1).max(128),
    message: postgresTextSchema.min(1),
    impact: postgresTextSchema.min(1),
    path: failurePathSchema.optional(),
    suggestion: postgresTextSchema.min(1).optional(),
    requiresHuman: z.boolean(),
  })
  .strict();

const manualRunCheckFieldsSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(postgresTextSchema.min(1)),
    basis: postgresTextSchema.min(1),
    problems: z.array(
      z
        .object({
          code: postgresTextSchema.min(1).max(128),
          message: postgresTextSchema.min(1),
          impact: postgresTextSchema.min(1),
          path: failurePathSchema.optional(),
          suggestion: postgresTextSchema.min(1),
          requiresHuman: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

function requireCheckProblemWhenUnavailable(
  check: z.infer<typeof manualRunCheckFieldsSchema>,
  context: z.RefinementCtx,
): void {
  if (check.availability !== "available" && check.problems.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["problems"],
      message: "不可用或无法判断时必须说明问题和处理建议。",
    });
  }
}

export const manualRunCheckInputSchema = withPostgresJsonSchemaProjection(
  manualRunCheckFieldsSchema.superRefine(requireCheckProblemWhenUnavailable),
);

export const manualRunCheckResultSchema = withPostgresJsonSchemaProjection(
  manualRunCheckFieldsSchema
    .extend({ checkedAt: z.iso.datetime() })
    .superRefine(requireCheckProblemWhenUnavailable),
);

export const manualRunCompletionSchema = z.discriminatedUnion("status", [
  withPostgresJsonSchemaProjection(
    z
      .object({
        status: z.literal("completed"),
        completedScopes: z.array(postgresTextSchema),
        check: manualRunCheckInputSchema.optional(),
      })
      .strict(),
  ),
  withPostgresJsonSchemaProjection(
    z
      .object({
        status: z.literal("failed"),
        completedScopes: z.array(postgresTextSchema),
        error: manualRunFailureSchema,
      })
      .strict(),
  ),
]);

export const manualRunCompleteInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      runtimeId: postgresTextSchema.min(1),
      completion: manualRunCompletionSchema,
    })
    .strict(),
);

export const manualRunClaimInputSchema = withPostgresJsonSchemaProjection(
  z.object({ runtimeId: postgresTextSchema.min(1) }).strict(),
);

export const manualRunCommitLocatorSchema = z
  .object({
    commitId: z.string().uuid(),
    archiveSeq: z.string().regex(/^[1-9][0-9]*$/u),
    items: z.array(
      z
        .object({
          itemId: z.string().uuid(),
          revisionId: z.string().uuid(),
        })
        .strict(),
    ),
  })
  .strict();

export const manualRunResultSchema = z
  .object({
    completedScopes: z.array(postgresTextSchema),
    commits: z.array(manualRunCommitLocatorSchema),
    check: manualRunCheckResultSchema.optional(),
    stopReason: z
      .object({
        code: postgresTextSchema.min(1),
        message: postgresTextSchema.min(1),
      })
      .strict(),
    error: manualRunFailureSchema.optional(),
  })
  .strict();

export const manualRunSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      runId: runIdSchema,
      binId: binIdSchema,
      action: sourceAdapterActionNameSchema,
      sourceAdapterId: postgresTextSchema.min(1),
      sourceAdapterVersion: postgresTextSchema.min(1),
      status: manualRunStatusSchema,
      trigger: manualRunTriggerSchema,
      queueReason: manualRunQueueReasonSchema.optional(),
      cancellationRequestedAt: z.iso.datetime().optional(),
      stopConfirmedAt: z.iso.datetime().optional(),
      createdAt: z.iso.datetime(),
      startedAt: z.iso.datetime().optional(),
      finishedAt: z.iso.datetime().optional(),
      result: manualRunResultSchema.optional(),
    })
    .strict(),
);

export const manualRunExecutionSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      runId: runIdSchema,
      binId: binIdSchema,
      identityId: identityIdSchema,
      sourceAdapterId: postgresTextSchema.min(1),
      sourceAdapterVersion: postgresTextSchema.min(1),
      action: sourceAdapterActionNameSchema,
      params: jsonObjectSchema,
      config: jsonObjectSchema,
      targets: z.array(z.unknown()),
      browserReservationId: z.string().uuid().optional(),
    })
    .strict(),
);

export const manualRunClaimSchema = withPostgresJsonSchemaProjection(
  z.object({ run: manualRunExecutionSchema.nullable() }).strict(),
);

export const manualRunErrorSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      error: z
        .object({
          code: z.enum([
            "invalid_input",
            "bin_not_found",
            "bin_disabled",
            "action_not_found",
            "invalid_action_parameters",
            "run_not_found",
            "runtime_not_connected",
            "runtime_mismatch",
            "runtime_owner_unconfirmed",
            "run_not_executing",
            "run_not_cancellable",
            "run_cancellation_pending",
          ]),
          message: postgresTextSchema,
          path: apiErrorPathSchema.optional(),
        })
        .strict(),
    })
    .strict(),
);

export type ManualRunTriggerInput = z.infer<typeof manualRunTriggerInputSchema>;
export type ManualRunFailure = z.infer<typeof manualRunFailureSchema>;
export type ManualRunCompletion = z.infer<typeof manualRunCompletionSchema>;
export type ManualRun = z.infer<typeof manualRunSchema>;
export type ManualRunTrigger = z.infer<typeof manualRunTriggerSchema>;
export type ManualRunExecution = z.infer<typeof manualRunExecutionSchema>;
export type ManualRunCheckInput = z.infer<typeof manualRunCheckInputSchema>;
export type ManualRunCheckResult = z.infer<typeof manualRunCheckResultSchema>;
export type ManualRunClaim = z.infer<typeof manualRunClaimSchema>;
export type ManualRunCommitLocator = z.infer<
  typeof manualRunCommitLocatorSchema
>;
export type ManualRunResult = z.infer<typeof manualRunResultSchema>;
export type ManualRunApiError = z.infer<typeof manualRunErrorSchema>["error"];
export type ManualRunOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 409;
      readonly error: ManualRunApiError;
    };

export type ManualRunOperations = {
  triggerRun(
    binId: string,
    input: ManualRunTriggerInput,
  ): Promise<ManualRunOperation<ManualRun>>;
  getRun(binId: string, runId: string): Promise<ManualRunOperation<ManualRun>>;
  cancelRun(
    binId: string,
    runId: string,
  ): Promise<ManualRunOperation<ManualRun>>;
  claimRun(
    binId: string,
    input: z.infer<typeof manualRunClaimInputSchema>,
  ): Promise<ManualRunOperation<ManualRunExecution | null>>;
  completeRun(
    binId: string,
    runId: string,
    input: z.infer<typeof manualRunCompleteInputSchema>,
  ): Promise<ManualRunOperation<ManualRun>>;
};

export const manualRunApiSchemas = {
  trigger: toPostgresJsonSchema(manualRunTriggerInputSchema, "input"),
  claim: toPostgresJsonSchema(manualRunClaimInputSchema, "input"),
  complete: toPostgresJsonSchema(manualRunCompleteInputSchema, "input"),
  claimOutput: toPostgresJsonSchema(manualRunClaimSchema, "output"),
  run: toPostgresJsonSchema(manualRunSchema, "output"),
  error: toPostgresJsonSchema(manualRunErrorSchema, "output"),
};
