import * as z from "zod";

import { postgresTextSchema } from "./postgres-text.ts";

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

export const runtimeHumanSessionControlSchema = z
  .object({
    sessionId: z.string().uuid(),
    action: z.enum(["open", "close"]),
  })
  .strict();

export type RuntimeHumanSessionEvent = z.infer<
  typeof runtimeHumanSessionEventSchema
>;
export type RuntimeHumanSessionControl = z.infer<
  typeof runtimeHumanSessionControlSchema
>;
