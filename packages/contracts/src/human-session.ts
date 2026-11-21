import * as z from "zod";

import { binIdSchema, runtimeWakeErrorSchema } from "./bin-configuration.ts";
import { postgresTextSchema } from "./postgres-text.ts";
import { vncPasswordSchema } from "./runtime-human-session.ts";

const sessionIdSchema = z.string().uuid();

export const vncPortSchema = z.number().int().min(1).max(65_535);

export const humanSessionStatusSchema = z.enum([
  "pending",
  "opening",
  "ready",
  "closing",
  "closed",
  "failed",
]);

export const humanSessionQueueReasonSchema = z.enum([
  "runtime_offline",
  "runtime_sleeping",
  "runtime_waking",
  "bin_busy",
  "runtime_protocol_outdated",
]);

export const humanSessionFailureSchema = z
  .object({
    code: postgresTextSchema.min(1).max(128),
    message: postgresTextSchema.min(1),
  })
  .strict();

/** Pure human session state without connection endpoints or credentials. */
export const humanSessionStateSchema = z
  .object({
    sessionId: sessionIdSchema,
    binId: binIdSchema,
    status: humanSessionStatusSchema,
    queueReason: humanSessionQueueReasonSchema.optional(),
    lastWakeError: runtimeWakeErrorSchema.optional(),
    requestedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    readyAt: z.iso.datetime().optional(),
    closedAt: z.iso.datetime().optional(),
    failure: humanSessionFailureSchema.optional(),
  })
  .strict();

/**
 * HTTP status response for a human session. Includes the live Docker-mapped
 * host `port` when `status === "ready"`, never `password` or `host`.
 */
export const humanSessionSchema = humanSessionStateSchema
  .extend({
    port: vncPortSchema.optional(),
  })
  .strict();

/** HTTP `POST /bins/:binId/human-sessions` response returning the one-time VNC password. */
export const humanSessionCreatedSchema = humanSessionStateSchema
  .extend({
    password: vncPasswordSchema,
  })
  .strict();

/** Streamed waiting record emitted by `binny human open` while queuing or waking. */
export const humanOpenWaitingRecordSchema = z
  .object({
    sessionId: sessionIdSchema,
    binId: binIdSchema,
    status: z.enum(["pending", "opening"]),
    queueReason: humanSessionQueueReasonSchema.optional(),
    lastWakeError: runtimeWakeErrorSchema.optional(),
  })
  .strict();

/** Streamed terminal record emitted by `binny human open` once VNC is ready. */
export const humanOpenReadyRecordSchema = z
  .object({
    sessionId: sessionIdSchema,
    binId: binIdSchema,
    status: z.literal("ready"),
    host: postgresTextSchema.min(1),
    port: vncPortSchema,
    password: vncPasswordSchema,
    requestedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    readyAt: z.iso.datetime(),
  })
  .strict();

export const humanSessionErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "invalid_input",
          "bin_not_found",
          "human_session_not_found",
          "browser_not_required",
          "human_session_active",
        ]),
        message: postgresTextSchema,
        path: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .strict(),
  })
  .strict();

export type HumanSessionStatus = z.infer<typeof humanSessionStatusSchema>;
export type HumanSessionState = z.infer<typeof humanSessionStateSchema>;
export type HumanSession = z.infer<typeof humanSessionSchema>;
export type HumanSessionCreated = z.infer<typeof humanSessionCreatedSchema>;
export type HumanOpenWaitingRecord = z.infer<
  typeof humanOpenWaitingRecordSchema
>;
export type HumanOpenReadyRecord = z.infer<typeof humanOpenReadyRecordSchema>;
export type HumanSessionFailure = z.infer<typeof humanSessionFailureSchema>;
export type HumanSessionApiError = z.infer<
  typeof humanSessionErrorSchema
>["error"];
export type HumanSessionOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 409;
      readonly error: HumanSessionApiError;
    };

export type HumanSessionOperations = {
  requestHumanSession(
    binId: string,
  ): Promise<HumanSessionOperation<HumanSessionCreated>>;
  getHumanSession(
    binId: string,
    sessionId: string,
  ): Promise<HumanSessionOperation<HumanSession>>;
  closeHumanSession(
    binId: string,
    sessionId: string,
  ): Promise<HumanSessionOperation<HumanSession>>;
};
