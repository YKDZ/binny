// Source adapter definition for Google AI and Google DeepMind blogs.
import { createHash } from "node:crypto";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  hasIncrementalEntryChanged,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  submitCleanedArticle,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  type IncrementalEntryRecord,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { parseFeed } from "@rowanmanning/feed-parser";
import { z } from "zod";

import { extractArticle, toFullIsoTimestamp } from "./article-extractor.ts";

export const defaultSources = [
  {
    id: "google-ai",
    url: "https://blog.google/innovation-and-ai/technology/ai/rss/",
    title: "Google AI Blog",
  },
  {
    id: "deepmind",
    url: "https://deepmind.google/blog/rss.xml",
    title: "Google DeepMind Blog",
  },
];

const googleSourceDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u,
        "Source ID must contain only alphanumeric characters, dots, underscores, and dashes.",
      ),
    url: z.string().url("Source URL must be a valid HTTP/HTTPS URL."),
    title: z.string().min(1).max(512).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    sources: z
      .array(googleSourceDefinitionSchema)
      .min(1)
      .max(64)
      .default(() => [...defaultSources]),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, source] of config.sources.entries()) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "id"],
          message: "Duplicate source ID in configuration.",
        });
      }
      ids.add(source.id);
    }
  });

export const paramsSchema = z
  .object({
    sourceIds: z.array(z.string()).max(64).optional(),
    itemUrls: z.array(z.string().url()).max(512).optional(),
    maxItems: z.number().int().positive().max(1000).optional(),
  })
  .strict();

export const checkOutputSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string()),
    basis: z.string().min(1),
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

export type GoogleConfig = z.output<typeof configSchema>;
export type GoogleParams = z.output<typeof paramsSchema>;
export type GoogleSourceDefinition = z.output<
  typeof googleSourceDefinitionSchema
>;

interface ParsedFeedItemData {
  readonly itemKey: string;
  readonly articleUrl: string;
  readonly title?: string | undefined;
  readonly published?: string | undefined;
  readonly updated?: string | undefined;
  readonly authors: readonly string[];
  readonly categories: readonly string[];
  readonly fingerprint: string;
}

type FeedFetchResult =
  | {
      readonly status: 304;
      readonly validators: {
        readonly etag?: string | undefined;
        readonly lastModified?: string | undefined;
      };
    }
  | {
      readonly status: 200;
      readonly validators: {
        readonly etag?: string | undefined;
        readonly lastModified?: string | undefined;
      };
      readonly items: readonly ParsedFeedItemData[];
    };

interface ActionProblem {
  readonly sourceId: string;
  readonly message: string;
  readonly path?: readonly (string | number)[] | undefined;
  readonly suggestion?: string | undefined;
}

interface CheckProblem {
  readonly code: string;
  readonly message: string;
  readonly impact: string;
  readonly suggestion: string;
  readonly requiresHuman: boolean;
  readonly path?: (string | number)[] | undefined;
}

function selectSources(
  config: GoogleConfig,
  params: GoogleParams,
): {
  readonly sources: readonly GoogleSourceDefinition[];
  readonly missing: readonly string[];
} {
  if (!params.sourceIds || params.sourceIds.length === 0) {
    return { sources: config.sources, missing: [] };
  }
  const configuredMap = new Map(config.sources.map((s) => [s.id, s]));
  const sources: GoogleSourceDefinition[] = [];
  const missing: string[] = [];

  for (const id of params.sourceIds) {
    const found = configuredMap.get(id);
    if (found) {
      sources.push(found);
    } else {
      missing.push(id);
    }
  }

  return { sources, missing };
}

async function fetchFeed(
  url: string,
  validators: { etag?: string | undefined; lastModified?: string | undefined },
  signal: AbortSignal,
): Promise<FeedFetchResult> {
  const headers: Record<string, string> = {
    accept:
      "application/atom+xml, application/rss+xml, application/xml, text/xml, */*",
    "user-agent": "Binny Google SourceAdapter/1.0",
  };
  if (validators.etag) {
    headers["if-none-match"] = validators.etag;
  }
  if (validators.lastModified) {
    headers["if-modified-since"] = validators.lastModified;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal,
  });

  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  const resValidators = {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };

  if (response.status === 304) {
    return { status: 304, validators: resValidators };
  }

  if (!response.ok) {
    throw new Error(`Feed request returned HTTP ${response.status}.`);
  }

  const text = await response.text();
  const feed = parseFeed(text);

  const items: ParsedFeedItemData[] = [];
  for (const rawItem of feed.items) {
    const itemJson = rawItem.toJSON();
    const rawUrl = (rawItem.url ?? itemJson.url ?? "").trim();
    if (!rawUrl) continue;

    let articleUrl = rawUrl;
    try {
      articleUrl = new URL(rawUrl, url).href;
    } catch {
      // Keep raw URL if cannot resolve
    }

    const itemKey = (rawItem.id ?? itemJson.id ?? articleUrl).trim();
    if (!itemKey) continue;

    const title = (rawItem.title ?? itemJson.title ?? "").trim();
    const published =
      itemJson.published ??
      (rawItem.published
        ? new Date(rawItem.published).toISOString()
        : undefined);
    const updated =
      itemJson.updated ??
      (rawItem.updated ? new Date(rawItem.updated).toISOString() : undefined);

    const authors = (itemJson.authors ?? [])
      .map((a: unknown) =>
        typeof a === "string" ? a : ((a as { name?: string }).name ?? ""),
      )
      .filter((a: string) => a.length > 0);

    const categories = (itemJson.categories ?? [])
      .map((c: unknown) =>
        typeof c === "string" ? c : ((c as { term?: string }).term ?? ""),
      )
      .filter((c: string) => c.length > 0);

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          id: itemKey,
          url: articleUrl,
          title,
          published,
          updated,
          description: itemJson.description,
        }),
      )
      .digest("hex");

    items.push({
      itemKey,
      articleUrl,
      title: title || undefined,
      published: published || undefined,
      updated: updated || undefined,
      authors,
      categories,
      fingerprint,
    });
  }

  return {
    status: 200,
    validators: resValidators,
    items,
  };
}

async function fetchArticleHtml(
  url: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; html: string }> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Binny Google SourceAdapter/1.0",
    },
    signal,
  });

  if (!response.ok) {
    return { ok: false, status: response.status, html: "" };
  }

  const html = await response.text();
  return { ok: true, status: response.status, html };
}

function failureFromProblems(
  problems: readonly ActionProblem[],
  completedScopes: readonly string[],
) {
  const examples = problems
    .slice(0, 8)
    .map(({ sourceId, message }) => `${sourceId}: ${message}`);
  const more =
    problems.length > examples.length
      ? `; and ${problems.length - examples.length} more problems`
      : "";
  const completed =
    completedScopes.length === 0
      ? ""
      : `Successfully archived scopes: ${completedScopes.join(", ")}. `;
  const first = problems[0];

  return sourceAdapterActionError(
    {
      code: "google_collection_incomplete",
      message: `Google AI / DeepMind collection incomplete: ${examples.join("; ")}${more}`,
      impact: `${completed}Archived data will not roll back; affected source sync state was not advanced.`,
      suggestion:
        first?.suggestion ??
        "Check failing article URLs or media sources and re-run. Already archived items will be deduplicated by source key.",
      requiresHuman: false,
    },
    completedScopes,
  );
}

async function check(
  context: SourceAdapterContext<GoogleConfig>,
  params: GoogleParams,
) {
  const selected = selectSources(context.config, params);
  const problems: CheckProblem[] = selected.missing.map((id) => ({
    code: "google_source_not_configured",
    message: `Requested source "${id}" is not configured.`,
    impact: "The requested source scope cannot be checked.",
    suggestion: "Check the sourceIds parameter or adapter configuration.",
    requiresHuman: false,
    path: ["sourceIds", id],
  }));

  for (const source of selected.sources) {
    if (context.signal.aborted) throw context.signal.reason;

    try {
      const feedRes = await fetchFeed(source.url, {}, context.signal);
      if (feedRes.status === 304) {
        problems.push({
          code: "google_feed_empty",
          message: `Source "${source.id}" returned 304 on unconditional check request.`,
          impact: "Cannot verify sample article extraction.",
          suggestion: "Verify source URL and feed availability.",
          requiresHuman: false,
          path: ["sources", source.id],
        });
        continue;
      }
      if (feedRes.items.length === 0) {
        problems.push({
          code: "google_feed_empty",
          message: `Source "${source.id}" feed contains no items.`,
          impact: "Cannot verify sample article extraction.",
          suggestion: "Verify that the feed is publishing items.",
          requiresHuman: false,
          path: ["sources", source.id],
        });
        continue;
      }

      const sampleItem = feedRes.items[0];
      if (!sampleItem || !sampleItem.articleUrl) {
        problems.push({
          code: "google_sample_missing_url",
          message: `Sample item in source "${source.id}" has no article URL.`,
          impact: "Cannot verify article page extraction.",
          suggestion: "Verify feed format and article link elements.",
          requiresHuman: false,
          path: ["sources", source.id, "items", 0],
        });
        continue;
      }

      const articleRes = await fetchArticleHtml(
        sampleItem.articleUrl,
        context.signal,
      );
      if (!articleRes.ok) {
        problems.push({
          code: "google_sample_article_unavailable",
          message: `Sample article "${sampleItem.articleUrl}" returned HTTP ${articleRes.status}.`,
          impact: "Full-text extraction cannot be verified.",
          suggestion: "Verify article URL reachability and network connection.",
          requiresHuman: false,
          path: ["sources", source.id, "items", 0],
        });
        continue;
      }

      const extracted = extractArticle(
        articleRes.html,
        sampleItem.articleUrl,
        source.id,
      );
      if (
        !extracted ||
        !extracted.cleanResult.hasSubstantialContent ||
        extracted.cleanResult.text.trim().length === 0
      ) {
        problems.push({
          code: "google_sample_article_extraction_failed",
          message: `Sample article "${sampleItem.articleUrl}" yielded no extractable article body.`,
          impact: "Full-text extraction cannot be verified.",
          suggestion: "Verify article HTML structure and selectors.",
          requiresHuman: false,
          path: ["sources", source.id, "items", 0],
        });
        continue;
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push({
        code: "google_source_unavailable",
        message: `Failed to check source "${source.id}": ${error instanceof Error ? error.message : String(error)}`,
        impact: "Source availability could not be verified.",
        suggestion: "Check network connectivity and source URL.",
        requiresHuman: false,
        path: ["sources", source.id],
      });
    }
  }

  return {
    availability:
      problems.length > 0 ? ("unavailable" as const) : ("available" as const),
    scope: selected.sources.map((s) => s.id),
    basis:
      "Validated RSS feed discovery and sample full-text HTML extraction. No archives or persistent state were committed.",
    problems,
  };
}

async function sync(
  context: SourceAdapterContext<GoogleConfig>,
  params: GoogleParams,
) {
  const selected = selectSources(context.config, params);
  const state = await loadIncrementalSyncState(context);
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];
  const problems: ActionProblem[] = selected.missing.map((id) => ({
    sourceId: id,
    message: `Requested source "${id}" is not configured.`,
  }));

  for (const source of selected.sources) {
    if (context.signal.aborted) throw context.signal.reason;

    const isInitialized = isIncrementalScopeInitialized(
      state,
      source.id,
      source.url,
    );
    const scopeState = state.scopes[source.id];

    if (!isInitialized || scopeState === undefined) {
      // First sync on uninitialized scope: establish baseline only!
      let feedRes: FeedFetchResult;
      try {
        feedRes = await fetchFeed(source.url, {}, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw error;
        problems.push({
          sourceId: source.id,
          message: `Failed to fetch feed on baseline sync: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (feedRes.status === 304) {
        problems.push({
          sourceId: source.id,
          message: "Feed returned 304 on unconditional baseline request.",
        });
        continue;
      }

      const baselineEntries: Record<string, IncrementalEntryRecord> = {};
      for (const item of feedRes.items) {
        baselineEntries[item.itemKey] = {
          fingerprint: item.fingerprint,
          ...(item.published ? { publishedAt: item.published } : {}),
          ...(item.updated ? { updatedAt: item.updated } : {}),
          archivedCompleteness: "baseline",
        };
      }

      initializeIncrementalScope(state, source.id, {
        scopeUrl: source.url,
        initializedAt: context.referenceTime,
        etag: feedRes.validators.etag,
        lastModified: feedRes.validators.lastModified,
        entries: baselineEntries,
      });

      await saveIncrementalSyncState(context, state);
      completedScopes.push(source.id);
      initializedScopes.push(source.id);
      continue;
    }

    // Initialized scope: conditional request & incremental archiving
    const hasPartial = Object.values(scopeState.entries).some(
      (entry) => entry.archivedCompleteness === "partial",
    );
    const validators = hasPartial
      ? {}
      : { etag: scopeState.etag, lastModified: scopeState.lastModified };

    let feedRes: FeedFetchResult;
    try {
      feedRes = await fetchFeed(source.url, validators, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push({
        sourceId: source.id,
        message: `Failed to fetch feed on incremental sync: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (feedRes.status === 304) {
      completedScopes.push(source.id);
      continue;
    }

    let scopeFailed = false;
    for (const item of feedRes.items) {
      if (context.signal.aborted) throw context.signal.reason;

      const previous = scopeState.entries[item.itemKey];
      const changed = hasIncrementalEntryChanged(
        previous,
        item.fingerprint,
        item.updated,
      );

      if (!changed) {
        continue;
      }

      let articleRes: { ok: boolean; status: number; html: string };
      try {
        articleRes = await fetchArticleHtml(item.articleUrl, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw error;
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Article "${item.articleUrl}" fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (!articleRes.ok) {
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Article "${item.articleUrl}" returned HTTP ${articleRes.status}.`,
        });
        continue;
      }

      const extracted = extractArticle(
        articleRes.html,
        item.articleUrl,
        source.id,
      );
      if (
        !extracted ||
        !extracted.cleanResult.hasSubstantialContent ||
        extracted.cleanResult.text.trim().length === 0
      ) {
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Article "${item.articleUrl}" yielded no extractable article body.`,
        });
        continue;
      }

      const combinedAuthors = Array.from(
        new Set([...extracted.pageMetadata.authors, ...item.authors]),
      );
      const combinedCategories = Array.from(
        new Set([...extracted.pageMetadata.categories, ...item.categories]),
      );

      const sourceModifiedAt =
        toFullIsoTimestamp(extracted.pageMetadata.articleUpdatedAt) ??
        toFullIsoTimestamp(extracted.pageMetadata.articlePublishedAt);

      try {
        const submitResult = await submitCleanedArticle(context, {
          sourceKey: { namespace: `google:${source.id}`, key: item.itemKey },
          sourceRef: item.articleUrl,
          title: extracted.pageMetadata.title ?? item.title ?? undefined,
          sourceModifiedAt,
          metadata: {
            feedPublishedAt: item.published ?? undefined,
            articlePublishedAt:
              extracted.pageMetadata.articlePublishedAt ?? undefined,
            articleUpdatedAt:
              extracted.pageMetadata.articleUpdatedAt ?? undefined,
            sourceId: source.id,
            region: "international",
            language: "en",
            authors: combinedAuthors,
            categories: combinedCategories,
          },
          cleanResult: extracted.cleanResult,
          captureScope: {
            sourceId: source.id,
            sourceUrl: source.url,
            articleUrl: item.articleUrl,
          },
        });

        upsertIncrementalScopeEntry(state, source.id, item.itemKey, {
          fingerprint: item.fingerprint,
          ...(item.published ? { publishedAt: item.published } : {}),
          ...(item.updated ? { updatedAt: item.updated } : {}),
          archivedCompleteness: submitResult.hasMediaFailures
            ? "partial"
            : "complete",
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Failed to submit article "${item.articleUrl}": ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }

    if (!scopeFailed) {
      updateIncrementalScopeValidators(state, source.id, {
        etag: feedRes.validators.etag,
        lastModified: feedRes.validators.lastModified,
      });
      await saveIncrementalSyncState(context, state);
      completedScopes.push(source.id);
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems(problems, completedScopes);
  }

  return { completedScopes, initializedScopes };
}

async function collect(
  context: SourceAdapterContext<GoogleConfig>,
  params: GoogleParams,
) {
  const selected = selectSources(context.config, params);
  const state = await loadIncrementalSyncState(context);
  const completedScopes: string[] = [];
  const problems: ActionProblem[] = selected.missing.map((id) => ({
    sourceId: id,
    message: `Requested source "${id}" is not configured.`,
  }));

  for (const source of selected.sources) {
    if (context.signal.aborted) throw context.signal.reason;

    let itemsToCollect: {
      itemKey: string;
      articleUrl: string;
      title?: string | undefined;
      published?: string | undefined;
      updated?: string | undefined;
      authors: readonly string[];
      categories: readonly string[];
      fingerprint: string;
    }[] = [];

    if (params.itemUrls && params.itemUrls.length > 0) {
      let feedRes: FeedFetchResult | undefined;
      try {
        feedRes = await fetchFeed(source.url, {}, context.signal);
      } catch {
        // Feed fetch optional when direct URLs are provided
      }

      for (const url of params.itemUrls) {
        const feedItem =
          feedRes?.status === 200
            ? feedRes.items.find((item) => item.articleUrl === url)
            : undefined;

        if (feedItem) {
          itemsToCollect.push(feedItem);
        } else {
          const isGoogleAi =
            source.id === "google-ai" && url.includes("blog.google");
          const isDeepMind =
            source.id === "deepmind" && url.includes("deepmind.google");
          const isOther =
            !url.includes("blog.google") && !url.includes("deepmind.google");

          if (isGoogleAi || isDeepMind || isOther) {
            itemsToCollect.push({
              itemKey: url,
              articleUrl: url,
              authors: [],
              categories: [],
              fingerprint: createHash("sha256").update(url).digest("hex"),
            });
          }
        }
      }
    } else {
      let feedRes: FeedFetchResult;
      try {
        feedRes = await fetchFeed(source.url, {}, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw error;
        problems.push({
          sourceId: source.id,
          message: `Failed to fetch feed on collect: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (feedRes.status === 304) {
        completedScopes.push(source.id);
        continue;
      }

      itemsToCollect = [...feedRes.items];
      if (params.maxItems !== undefined && params.maxItems > 0) {
        itemsToCollect = itemsToCollect.slice(0, params.maxItems);
      }
    }

    let scopeFailed = false;
    for (const item of itemsToCollect) {
      if (context.signal.aborted) throw context.signal.reason;

      let articleRes: { ok: boolean; status: number; html: string };
      try {
        articleRes = await fetchArticleHtml(item.articleUrl, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw error;
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Article "${item.articleUrl}" fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (!articleRes.ok) {
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Article "${item.articleUrl}" returned HTTP ${articleRes.status}.`,
        });
        continue;
      }

      const extracted = extractArticle(
        articleRes.html,
        item.articleUrl,
        source.id,
      );
      if (
        !extracted ||
        !extracted.cleanResult.hasSubstantialContent ||
        extracted.cleanResult.text.trim().length === 0
      ) {
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Article "${item.articleUrl}" yielded no extractable article body.`,
        });
        continue;
      }

      const combinedAuthors = Array.from(
        new Set([...extracted.pageMetadata.authors, ...item.authors]),
      );
      const combinedCategories = Array.from(
        new Set([...extracted.pageMetadata.categories, ...item.categories]),
      );

      const sourceModifiedAt =
        toFullIsoTimestamp(extracted.pageMetadata.articleUpdatedAt) ??
        toFullIsoTimestamp(extracted.pageMetadata.articlePublishedAt);

      try {
        const submitResult = await submitCleanedArticle(context, {
          sourceKey: { namespace: `google:${source.id}`, key: item.itemKey },
          sourceRef: item.articleUrl,
          title: extracted.pageMetadata.title ?? item.title ?? undefined,
          sourceModifiedAt,
          metadata: {
            feedPublishedAt: item.published ?? undefined,
            articlePublishedAt:
              extracted.pageMetadata.articlePublishedAt ?? undefined,
            articleUpdatedAt:
              extracted.pageMetadata.articleUpdatedAt ?? undefined,
            sourceId: source.id,
            region: "international",
            language: "en",
            authors: combinedAuthors,
            categories: combinedCategories,
          },
          cleanResult: extracted.cleanResult,
          captureScope: {
            sourceId: source.id,
            sourceUrl: source.url,
            articleUrl: item.articleUrl,
          },
        });

        upsertIncrementalScopeEntry(state, source.id, item.itemKey, {
          fingerprint: item.fingerprint,
          ...(item.published ? { publishedAt: item.published } : {}),
          ...(item.updated ? { updatedAt: item.updated } : {}),
          archivedCompleteness: submitResult.hasMediaFailures
            ? "partial"
            : "complete",
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Failed to submit article "${item.articleUrl}": ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }

    if (!scopeFailed) {
      await saveIncrementalSyncState(context, state);
      completedScopes.push(source.id);
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems(problems, completedScopes);
  }

  return { completedScopes };
}

export const sourceAdapter = defineSourceAdapter({
  id: "google",
  version: "0.1.0",
  description: "Google AI and Google DeepMind blog source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, {
      description: "Check Google AI and DeepMind sources availability.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: check,
    }),
    sync: defineSourceAdapterAction(configSchema, {
      description: "Incrementally sync Google AI and DeepMind articles.",
      params: paramsSchema,
      output: syncOutputSchema,
      execute: sync,
    }),
    collect: defineSourceAdapterAction(configSchema, {
      description: "Collect and archive Google AI and DeepMind articles.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: collect,
    }),
  },
});
