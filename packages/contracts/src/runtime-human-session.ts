import * as z from "zod";

import { postgresTextSchema } from "./postgres-text.ts";

/**
 * Standard VNC Authentication (RFC 6143 §7.2.2) silently truncates passwords
 * beyond 8 ASCII bytes, so session passwords are fixed to 8 alphanumeric chars.
 */
export const vncPasswordSchema = z.string().regex(/^[A-Za-z0-9]{8}$/u);

export const runtimeActiveHumanSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    phase: z.enum(["opening", "ready"]),
    clientConnected: z.boolean(),
  })
  .strict();

export const runtimeHumanSessionEventSchema = z
  .object({
    sessionId: z.string().uuid(),
    event: z.enum(["ready", "closed", "failed", "expired"]),
    failure: z
      .object({
        code: postgresTextSchema.min(1).max(128),
        message: postgresTextSchema.min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const runtimeHumanSessionControlSchema = z.discriminatedUnion("action", [
  z
    .object({
      sessionId: z.string().uuid(),
      action: z.literal("open"),
      password: vncPasswordSchema,
      connectTimeoutMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      sessionId: z.string().uuid(),
      action: z.literal("close"),
    })
    .strict(),
]);

export type RuntimeActiveHumanSession = z.infer<
  typeof runtimeActiveHumanSessionSchema
>;
export type RuntimeHumanSessionEvent = z.infer<
  typeof runtimeHumanSessionEventSchema
>;
export type RuntimeHumanSessionControl = z.infer<
  typeof runtimeHumanSessionControlSchema
>;
