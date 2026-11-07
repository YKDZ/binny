// Source adapter definition for Qoder regional announcements, events, changelogs, and blog.
import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  incrementalSyncStateSchema,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import {
  checkInternationalBlog,
  collectInternationalBlog,
  DEFAULT_INTERNATIONAL_BLOG_URL,
  syncInternationalBlog,
} from "./international-blog.ts";

export const configSchema = z
  .object({
    blogListUrl: z.string().url().default(DEFAULT_INTERNATIONAL_BLOG_URL),
  })
  .strict();

export const checkParamsSchema = z
  .object({
    scopes: z.array(z.string()).optional(),
  })
  .strict();

export const collectParamsSchema = z
  .object({
    articleUrls: z.array(z.string().url()).optional(),
    maxItems: z.number().int().positive().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .strict();

export const syncParamsSchema = z
  .object({
    scopes: z.array(z.string()).optional(),
  })
  .strict();

export const checkOutputSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string()),
    basis: z.string(),
    problems: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          impact: z.string().min(1),
          path: z.array(z.union([z.string(), z.number()])).optional(),
          suggestion: z.string().min(1),
          requiresHuman: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const collectOutputSchema = z
  .object({ completedScopes: z.array(z.string()).readonly() })
  .strict();

export const syncOutputSchema = z
  .object({
    completedScopes: z.array(z.string()).readonly(),
    initializedScopes: z.array(z.string()).readonly().optional(),
  })
  .strict();

export type QoderConfig = z.infer<typeof configSchema>;
export type QoderCheckParams = z.infer<typeof checkParamsSchema>;
export type QoderCollectParams = z.infer<typeof collectParamsSchema>;
export type QoderSyncParams = z.infer<typeof syncParamsSchema>;
export type QoderCheckOutput = z.infer<typeof checkOutputSchema>;
export type QoderCollectOutput = z.infer<typeof collectOutputSchema>;
export type QoderSyncOutput = z.infer<typeof syncOutputSchema>;

export const sourceAdapter = defineSourceAdapter({
  id: "qoder",
  version: "0.1.0",
  description:
    "Qoder regional announcements, events, changelogs, and blog source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, {
      description: "Check Qoder source availability.",
      params: checkParamsSchema,
      output: checkOutputSchema,
      execute: (context) => checkInternationalBlog(context),
    }),
    collect: defineSourceAdapterAction(configSchema, {
      description: "Collect Qoder source items.",
      params: collectParamsSchema,
      output: collectOutputSchema,
      execute: (context, params) => collectInternationalBlog(context, params),
    }),
    sync: defineSourceAdapterAction(configSchema, {
      description: "Incrementally synchronize Qoder source items.",
      params: syncParamsSchema,
      output: syncOutputSchema,
      execute: (context) => syncInternationalBlog(context),
    }),
  },
});
