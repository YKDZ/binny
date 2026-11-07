// Source adapter definition for Qoder regional announcements, events, changelogs, and blog.
import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  incrementalSyncStateSchema,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import {
  checkCnAnnouncementsEvents,
  CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
  collectCnAnnouncementsEvents,
  DEFAULT_CN_DOCS_INDEX_URL,
  syncCnAnnouncementsEvents,
} from "./cn-announcements-events.ts";
import {
  checkInternationalBlog,
  collectInternationalBlog,
  DEFAULT_INTERNATIONAL_BLOG_URL,
  INTERNATIONAL_BLOG_SCOPE_ID,
  syncInternationalBlog,
} from "./international-blog.ts";
import {
  checkCnChangelogs,
  checkInternationalChangelogs,
  CN_CHANGELOGS_SCOPE_ID,
  collectCnChangelogs,
  collectInternationalChangelogs,
  DEFAULT_CN_CHANGELOG_URL,
  DEFAULT_INTERNATIONAL_CHANGELOG_URL,
  INTERNATIONAL_CHANGELOGS_SCOPE_ID,
  syncCnChangelogs,
  syncInternationalChangelogs,
} from "./regional-changelogs.ts";

export { CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID, DEFAULT_CN_DOCS_INDEX_URL };
export { DEFAULT_INTERNATIONAL_BLOG_URL, INTERNATIONAL_BLOG_SCOPE_ID };
export {
  CN_CHANGELOGS_SCOPE_ID,
  DEFAULT_CN_CHANGELOG_URL,
  DEFAULT_INTERNATIONAL_CHANGELOG_URL,
  INTERNATIONAL_CHANGELOGS_SCOPE_ID,
};

export const configSchema = z
  .object({
    blogListUrl: z.string().url().default(DEFAULT_INTERNATIONAL_BLOG_URL),
    cnDocsIndexUrl: z.string().url().default(DEFAULT_CN_DOCS_INDEX_URL),
    intChangelogIndexUrl: z
      .string()
      .url()
      .default(DEFAULT_INTERNATIONAL_CHANGELOG_URL),
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

/**
 * Determines which scopes to activate based on explicit parameters and configuration.
 */
export function determineActiveScopes(
  config: QoderConfig,
  requestedScopes?: readonly string[],
): string[] {
  if (requestedScopes && requestedScopes.length > 0) {
    return [...requestedScopes];
  }
  const isCustomBlog =
    config.blogListUrl !== undefined &&
    config.blogListUrl !== DEFAULT_INTERNATIONAL_BLOG_URL;
  const isCustomCn =
    config.cnDocsIndexUrl !== undefined &&
    config.cnDocsIndexUrl !== DEFAULT_CN_DOCS_INDEX_URL;
  const isCustomIntChangelog =
    config.intChangelogIndexUrl !== undefined &&
    config.intChangelogIndexUrl !== DEFAULT_INTERNATIONAL_CHANGELOG_URL;

  if (isCustomBlog && !isCustomCn && !isCustomIntChangelog) {
    return [INTERNATIONAL_BLOG_SCOPE_ID];
  }
  if (isCustomIntChangelog && !isCustomBlog && !isCustomCn) {
    return [INTERNATIONAL_CHANGELOGS_SCOPE_ID];
  }
  if (isCustomCn && !isCustomBlog && !isCustomIntChangelog) {
    return [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID];
  }

  // Default: if none are customized, all 4 scopes are active
  if (!isCustomBlog && !isCustomCn && !isCustomIntChangelog) {
    return [
      INTERNATIONAL_BLOG_SCOPE_ID,
      CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
      CN_CHANGELOGS_SCOPE_ID,
      INTERNATIONAL_CHANGELOGS_SCOPE_ID,
    ];
  }

  // Multiple customizations:
  const scopes: string[] = [];
  if (isCustomBlog) scopes.push(INTERNATIONAL_BLOG_SCOPE_ID);
  if (isCustomCn) {
    scopes.push(CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID);
    scopes.push(CN_CHANGELOGS_SCOPE_ID);
  }
  if (isCustomIntChangelog) scopes.push(INTERNATIONAL_CHANGELOGS_SCOPE_ID);
  return scopes;
}

async function executeCheck(
  context: SourceAdapterContext<QoderConfig>,
  params: QoderCheckParams,
): Promise<QoderCheckOutput> {
  const activeScopes = determineActiveScopes(context.config, params.scopes);
  const results: QoderCheckOutput[] = [];

  if (activeScopes.includes(INTERNATIONAL_BLOG_SCOPE_ID)) {
    results.push(await checkInternationalBlog(context));
  }
  if (activeScopes.includes(CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID)) {
    results.push(await checkCnAnnouncementsEvents(context));
  }
  if (activeScopes.includes(CN_CHANGELOGS_SCOPE_ID)) {
    results.push(await checkCnChangelogs(context));
  }
  if (activeScopes.includes(INTERNATIONAL_CHANGELOGS_SCOPE_ID)) {
    results.push(await checkInternationalChangelogs(context));
  }

  const allProblems = results.flatMap((r) => r.problems);
  const allScopes = results.flatMap((r) => r.scope);
  const isAvailable =
    results.length > 0 && results.every((r) => r.availability === "available");

  return {
    availability: isAvailable ? "available" : "unavailable",
    scope: allScopes,
    basis: results.map((r) => r.basis).join(" | "),
    problems: allProblems,
  };
}

async function executeSync(
  context: SourceAdapterContext<QoderConfig>,
  params: QoderSyncParams,
): Promise<QoderSyncOutput> {
  const activeScopes = determineActiveScopes(context.config, params.scopes);
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];
  const actionErrors: unknown[] = [];

  if (activeScopes.includes(INTERNATIONAL_BLOG_SCOPE_ID)) {
    try {
      const res = await syncInternationalBlog(context);
      completedScopes.push(...res.completedScopes);
      if (res.initializedScopes) {
        initializedScopes.push(...res.initializedScopes);
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      actionErrors.push(error);
    }
  }
  if (activeScopes.includes(CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID)) {
    try {
      const res = await syncCnAnnouncementsEvents(context);
      completedScopes.push(...res.completedScopes);
      if (res.initializedScopes) {
        initializedScopes.push(...res.initializedScopes);
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      actionErrors.push(error);
    }
  }
  if (activeScopes.includes(CN_CHANGELOGS_SCOPE_ID)) {
    try {
      const res = await syncCnChangelogs(context);
      completedScopes.push(...res.completedScopes);
      if (res.initializedScopes) {
        initializedScopes.push(...res.initializedScopes);
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      actionErrors.push(error);
    }
  }
  if (activeScopes.includes(INTERNATIONAL_CHANGELOGS_SCOPE_ID)) {
    try {
      const res = await syncInternationalChangelogs(context);
      completedScopes.push(...res.completedScopes);
      if (res.initializedScopes) {
        initializedScopes.push(...res.initializedScopes);
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      actionErrors.push(error);
    }
  }

  if (actionErrors.length > 0) {
    throw actionErrors[0];
  }

  return {
    completedScopes,
    ...(initializedScopes.length > 0 ? { initializedScopes } : {}),
  };
}

async function executeCollect(
  context: SourceAdapterContext<QoderConfig>,
  params: QoderCollectParams,
): Promise<QoderCollectOutput> {
  const activeScopes = determineActiveScopes(context.config, params.scopes);
  const completedScopes: string[] = [];
  const actionErrors: unknown[] = [];

  if (activeScopes.includes(INTERNATIONAL_BLOG_SCOPE_ID)) {
    try {
      const res = await collectInternationalBlog(context, params);
      completedScopes.push(...res.completedScopes);
    } catch (error) {
      if (context.signal.aborted) throw error;
      actionErrors.push(error);
    }
  }
  if (activeScopes.includes(CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID)) {
    try {
      const res = await collectCnAnnouncementsEvents(context, params);
      completedScopes.push(...res.completedScopes);
    } catch (error) {
      if (context.signal.aborted) throw error;
      actionErrors.push(error);
    }
  }
  if (activeScopes.includes(CN_CHANGELOGS_SCOPE_ID)) {
    try {
      const res = await collectCnChangelogs(context, params);
      completedScopes.push(...res.completedScopes);
    } catch (error) {
      if (context.signal.aborted) throw error;
      actionErrors.push(error);
    }
  }
  if (activeScopes.includes(INTERNATIONAL_CHANGELOGS_SCOPE_ID)) {
    try {
      const res = await collectInternationalChangelogs(context, params);
      completedScopes.push(...res.completedScopes);
    } catch (error) {
      if (context.signal.aborted) throw error;
      actionErrors.push(error);
    }
  }

  if (actionErrors.length > 0) {
    throw actionErrors[0];
  }

  return {
    completedScopes,
  };
}

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
      execute: (context, params) => executeCheck(context, params),
    }),
    collect: defineSourceAdapterAction(configSchema, {
      description: "Collect Qoder source items.",
      params: collectParamsSchema,
      output: collectOutputSchema,
      execute: (context, params) => executeCollect(context, params),
    }),
    sync: defineSourceAdapterAction(configSchema, {
      description: "Incrementally synchronize Qoder source items.",
      params: syncParamsSchema,
      output: syncOutputSchema,
      execute: (context, params) => executeSync(context, params),
    }),
  },
});
