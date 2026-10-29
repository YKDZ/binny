import * as z from "zod";

import { binIdSchema } from "./bin-configuration.ts";
import { postgresTextSchema } from "./postgres-text.ts";

const sessionIdSchema = z.string().uuid();

export const humanSessionStatusSchema = z.enum([
  "pending",
  "opening",
  "ready",
  "closing",
  "closed",
  "failed",
]);

export const humanSessionFailureSchema = z
  .object({
    code: postgresTextSchema.min(1).max(128),
    message: postgresTextSchema.min(1),
  })
  .strict();

export const humanSessionSchema = z
  .object({
    sessionId: sessionIdSchema,
    binId: binIdSchema,
    status: humanSessionStatusSchema,
    requestedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    readyAt: z.iso.datetime().optional(),
    closedAt: z.iso.datetime().optional(),
    failure: humanSessionFailureSchema.optional(),
  })
  .strict();

/** 新建会话时只返回一次的临时入口；数据库只保存其摘要。 */
export const humanSessionCreatedSchema = humanSessionSchema.extend({
  viewerPath: postgresTextSchema.min(1),
});

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
export type HumanSession = z.infer<typeof humanSessionSchema>;
export type HumanSessionCreated = z.infer<typeof humanSessionCreatedSchema>;
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
