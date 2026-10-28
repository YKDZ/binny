import * as z from "zod";

import {
  binIdSchema,
  collectorActionNameSchema,
  identityIdSchema,
  jsonObjectSchema,
} from "./bin-configuration.ts";

const runIdSchema = z.string().uuid();
const errorPathSchema = z.array(z.union([z.string(), z.number()]));

export const manualRunStatusSchema = z.enum([
  "queued",
  "executing",
  "completed",
  "failed",
]);

export const manualRunQueueReasonSchema = z.enum([
  "runtime_offline",
  "earlier_run_active",
  "earlier_run_queued",
]);

export const manualRunTriggerInputSchema = z
  .object({
    action: collectorActionNameSchema,
    params: jsonObjectSchema,
  })
  .strict();

export const manualRunFailureSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().min(1),
    impact: z.string().min(1),
    path: errorPathSchema.optional(),
    suggestion: z.string().min(1).optional(),
    requiresHuman: z.boolean(),
  })
  .strict();

export const manualRunCompletionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      completedScopes: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      completedScopes: z.array(z.string()),
      error: manualRunFailureSchema,
    })
    .strict(),
]);

export const manualRunCompleteInputSchema = z
  .object({
    runtimeId: z.string().min(1),
    completion: manualRunCompletionSchema,
  })
  .strict();

export const manualRunClaimInputSchema = z
  .object({ runtimeId: z.string().min(1) })
  .strict();

export const manualRunCommitLocatorSchema = z
  .object({
    commitId: z.string().uuid(),
    archiveSeq: z.string().regex(/^[1-9][0-9]*$/u),
    items: z
      .array(
        z
          .object({
            itemId: z.string().uuid(),
            revisionId: z.string().uuid(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const manualRunResultSchema = z
  .object({
    completedScopes: z.array(z.string()),
    commits: z.array(manualRunCommitLocatorSchema),
    stopReason: z
      .object({ code: z.string().min(1), message: z.string().min(1) })
      .strict(),
    error: manualRunFailureSchema.optional(),
  })
  .strict();

export const manualRunSchema = z
  .object({
    runId: runIdSchema,
    binId: binIdSchema,
    action: collectorActionNameSchema,
    collectorId: z.string().min(1),
    collectorVersion: z.string().min(1),
    status: manualRunStatusSchema,
    queueReason: manualRunQueueReasonSchema.optional(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    result: manualRunResultSchema.optional(),
  })
  .strict();

export const manualRunExecutionSchema = z
  .object({
    runId: runIdSchema,
    binId: binIdSchema,
    identityId: identityIdSchema,
    collectorId: z.string().min(1),
    collectorVersion: z.string().min(1),
    action: collectorActionNameSchema,
    params: jsonObjectSchema,
    config: jsonObjectSchema,
    targets: z.array(z.unknown()),
  })
  .strict();

export const manualRunClaimSchema = z
  .object({ run: manualRunExecutionSchema.nullable() })
  .strict();

export const manualRunErrorSchema = z
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
          "run_not_executing",
        ]),
        message: z.string(),
        path: errorPathSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type ManualRunTriggerInput = z.infer<typeof manualRunTriggerInputSchema>;
export type ManualRunFailure = z.infer<typeof manualRunFailureSchema>;
export type ManualRunCompletion = z.infer<typeof manualRunCompletionSchema>;
export type ManualRun = z.infer<typeof manualRunSchema>;
export type ManualRunExecution = z.infer<typeof manualRunExecutionSchema>;
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
