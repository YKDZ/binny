// Source adapter implementation for Hugging Face Blog.
import { createHash } from "node:crypto";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  sourceTimeFrom,
  submitCleanedArticle,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  type IncrementalEntryRecord,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { parseFeed } from "@rowanmanning/feed-parser";
import { z } from "zod";

import { extractArticle, type ExtractedArticle } from "./html-extractor.ts";

const configSchema = z.object({
  feedUrl: z.url().default("https://huggingface.co/blog/feed.xml"),
  defaultCollectMaxItems: z.number().int().positive().default(20),
});

const paramsSchema = z
  .object({
    itemUrls: z.array(z.url()).optional(),
    maxItems: z.number().int().positive().optional(),
  })
  .strict();

const checkOutputSchema = z
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

const collectOutputSchema = z
  .object({ completedScopes: z.array(z.string()).readonly() })
  .strict();

const syncOutputSchema = z
  .object({
    completedScopes: z.array(z.string()).readonly(),
    initializedScopes: z.array(z.string()).readonly().optional(),
  })
  .strict();

export type HuggingFaceConfig = z.output<typeof configSchema>;
export type HuggingFaceParams = z.output<typeof paramsSchema>;

const extensionsSchema = z
  .object({
    authors: z
      .array(
        z
          .object({
            name: z.string(),
            handle: z.string().optional(),
            url: z.url().optional(),
          })
          .strict(),
      )
      .describe(
        "Author names and profile links identified on the Hugging Face article page.",
      ),
    categories: z
      .array(z.string())
      .describe("Categories and tags assigned to the blog article."),
    region: z
      .string()
      .describe("Geographic region assigned to the Hugging Face publication."),
    language: z.string().describe("Language used by the published article."),
  })
  .strict();

type HuggingFaceExtensions = z.output<typeof extensionsSchema>;

export interface ParsedFeedItem {
  readonly id: string | null;
  readonly url: string;
  readonly title: string | null;
  readonly published: string | null;
  readonly categories: readonly string[];
}

/** Extracts the post slug or fallback key from an article URL or guid. */
export function extractSlugOrKey(url: string, guid?: string | null): string {
  try {
    const parsed = new URL(url);
    const match = /^\/blog\/(.+?)\/?$/u.exec(parsed.pathname);
    if (match && match[1]) {
      return match[1];
    }
    const cleanPath = parsed.pathname.replace(/^\/+/u, "").replace(/\/+$/u, "");
    if (cleanPath.length > 0) {
      return cleanPath;
    }
  } catch {
    // Non-URL string
  }
  if (guid && guid.trim().length > 0) {
    return guid.trim();
  }
  return url;
}

/** Computes a feed item fingerprint using title, url, pubDate, and categories. */
export function computeFeedItemFingerprint(item: {
  readonly title?: string | null | undefined;
  readonly url?: string | null | undefined;
  readonly published?: string | null | undefined;
  readonly categories?: readonly string[] | undefined;
}): string {
  const data = JSON.stringify({
    title: item.title?.trim() ?? "",
    url: item.url?.trim() ?? "",
    published: item.published?.trim() ?? "",
    categories: [...(item.categories ?? [])].sort(),
  });
  return createHash("sha256").update(data).digest("hex");
}

type FeedFetchResult =
  | {
      readonly status: "not-modified";
      readonly etag?: string | undefined;
      readonly lastModified?: string | undefined;
    }
  | {
      readonly status: "ok";
      readonly etag?: string | undefined;
      readonly lastModified?: string | undefined;
      readonly text: string;
    };

/** Fetches feed XML with conditional HTTP headers. */
async function fetchFeedXml(
  feedUrl: string,
  signal: AbortSignal,
  validators?: {
    readonly etag?: string | undefined;
    readonly lastModified?: string | undefined;
  },
): Promise<FeedFetchResult> {
  const headers: Record<string, string> = {
    accept:
      "application/atom+xml, application/rss+xml, application/xml, text/xml, */*;q=0.8",
    "user-agent": "Binny SourceAdapter/1.0",
  };
  if (validators?.etag) {
    headers["if-none-match"] = validators.etag;
  }
  if (validators?.lastModified) {
    headers["if-modified-since"] = validators.lastModified;
  }

  const response = await fetch(feedUrl, {
    method: "GET",
    headers,
    signal,
  });

  if (response.status === 304) {
    return {
      status: "not-modified",
      etag: response.headers.get("etag") ?? validators?.etag,
      lastModified:
        response.headers.get("last-modified") ?? validators?.lastModified,
    };
  }

  if (response.status !== 200) {
    throw new Error(
      `Feed request to ${feedUrl} returned HTTP ${response.status}`,
    );
  }

  const text = await response.text();
  return {
    status: "ok",
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    text,
  };
}

/** Fetches full HTML of an article page. */
async function fetchArticleHtml(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Binny SourceAdapter/1.0",
    },
    signal,
  });

  if (response.status !== 200) {
    throw new Error(
      `Article request to ${url} returned HTTP ${response.status}`,
    );
  }

  return await response.text();
}

/** Parses feed items from XML string. */
type FeedItem = ReturnType<typeof parseFeed>["items"][number];

function rawFeedDate(item: FeedItem, names: readonly string[]): string | null {
  for (const name of names) {
    const value = item.element.findElementWithName(name)?.textContentNormalized;
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return null;
}

function parseFeedItems(xmlText: string, baseUrl: string): ParsedFeedItem[] {
  const parsed = parseFeed(xmlText);
  return parsed.items.map((item) => {
    let rawUrl = item.url ?? "";
    try {
      rawUrl = new URL(rawUrl, baseUrl).href;
    } catch {
      // Keep original url
    }
    const categories = item.categories
      .map((c) => (typeof c === "string" ? c : (c.label ?? c.term)))
      .filter((c): c is string => Boolean(c));
    return {
      id: item.id,
      url: rawUrl,
      title: item.title,
      published: rawFeedDate(item, ["pubdate", "published", "issued", "date"]),
      categories,
    };
  });
}

/** Processes, extracts, cleans, and submits an article; rejects failed/empty pages. */
async function processAndSubmitArticle(
  context: SourceAdapterContext<
    HuggingFaceConfig,
    never,
    HuggingFaceExtensions
  >,
  itemUrl: string,
  feedItem: ParsedFeedItem | undefined,
): Promise<{
  readonly key: string;
  readonly fingerprint: string;
  readonly publishedAt?: string | undefined;
  readonly completeness: "complete" | "partial";
}> {
  let html: string;
  try {
    html = await fetchArticleHtml(itemUrl, context.signal);
  } catch (error) {
    throw sourceAdapterActionError({
      code: "article_fetch_failed",
      message: `Failed to fetch article at ${itemUrl}: ${error instanceof Error ? error.message : String(error)}`,
      impact: "Article was not fetched and will not be archived.",
      suggestion: "Check article URL accessibility.",
      requiresHuman: false,
    });
  }

  let extracted: ExtractedArticle | undefined;
  try {
    extracted = extractArticle(html, itemUrl);
  } catch (error) {
    throw sourceAdapterActionError({
      code: "article_extraction_failed",
      message: `Failed to extract article HTML at ${itemUrl}: ${error instanceof Error ? error.message : String(error)}`,
      impact: "Article content could not be parsed and will not be archived.",
      suggestion: "Check article DOM structure.",
      requiresHuman: false,
    });
  }

  if (!extracted || !extracted.cleanResult.hasSubstantialContent) {
    throw sourceAdapterActionError({
      code: "article_content_empty",
      message: `Article at ${itemUrl} has no substantial content after cleaning. Title-only archiving is rejected.`,
      impact: "Article was not archived.",
      suggestion: "Verify that the article contains main content.",
      requiresHuman: false,
    });
  }

  const key = extractSlugOrKey(itemUrl, feedItem?.id);
  const feedPublishedAt = feedItem?.published ?? undefined;
  const articlePublishedAt = extracted.articlePublishedAt;
  const publishedDate = articlePublishedAt ?? feedPublishedAt;

  // Combine categories from feed and article page
  const categorySet = new Set<string>();
  for (const c of feedItem?.categories ?? []) {
    categorySet.add(c);
  }
  for (const c of extracted.categories) {
    categorySet.add(c);
  }
  const categories = [...categorySet];

  // Preserved factual authors
  const authors = [...extracted.authors];

  const title = extracted.title ?? feedItem?.title ?? undefined;

  const extensions: HuggingFaceExtensions = {
    authors,
    categories,
    region: "international",
    language: "en",
  };

  const result = await submitCleanedArticle(context, {
    sourceKey: { namespace: "huggingface:blog", key },
    sourceRef: itemUrl,
    title: title ?? null,
    sourcePublishedAt: sourceTimeFrom(publishedDate),
    sourceModifiedAt: null,
    extensions,
    cleanResult: extracted.cleanResult,
    captureScope: {
      scope: "blog",
      feedUrl: context.config.feedUrl,
      articleUrl: itemUrl,
    },
  });

  const fingerprint = feedItem
    ? computeFeedItemFingerprint({
        title: feedItem.title,
        url: feedItem.url,
        published: feedPublishedAt,
        categories: feedItem.categories,
      })
    : computeFeedItemFingerprint({
        title,
        url: itemUrl,
        published: publishedDate,
        categories,
      });

  return {
    key,
    fingerprint,
    ...(publishedDate === undefined ? {} : { publishedAt: publishedDate }),
    completeness: result.hasMediaFailures ? "partial" : "complete",
  };
}

/** Check action: verifies feed parsing and validates extraction on 1 sample article. */
async function checkHuggingFace(
  context: SourceAdapterContext<
    HuggingFaceConfig,
    never,
    HuggingFaceExtensions
  >,
  params: HuggingFaceParams,
): Promise<z.infer<typeof checkOutputSchema>> {
  void params;
  const scopeId = "blog";
  let feedResult: FeedFetchResult;
  try {
    feedResult = await fetchFeedXml(context.config.feedUrl, context.signal);
  } catch (error) {
    return {
      availability: "unavailable",
      scope: [scopeId],
      basis: `Feed request failed: ${error instanceof Error ? error.message : String(error)}`,
      problems: [
        {
          code: "feed_unavailable",
          message: error instanceof Error ? error.message : String(error),
          impact: "Hugging Face Blog feed could not be fetched.",
          suggestion: "Check feed URL and network connection.",
          requiresHuman: false,
        },
      ],
    };
  }

  let items: ParsedFeedItem[];
  try {
    items = parseFeedItems(
      feedResult.status === "ok" ? feedResult.text : "",
      context.config.feedUrl,
    );
  } catch (error) {
    return {
      availability: "unavailable",
      scope: [scopeId],
      basis: `Feed XML parsing failed: ${error instanceof Error ? error.message : String(error)}`,
      problems: [
        {
          code: "feed_parse_failed",
          message: error instanceof Error ? error.message : String(error),
          impact: "Hugging Face Blog feed format is unreadable.",
          suggestion: "Verify that the feed is valid RSS/Atom XML.",
          requiresHuman: false,
        },
      ],
    };
  }

  if (items.length === 0) {
    return {
      availability: "unavailable",
      scope: [scopeId],
      basis: "Feed contains no items.",
      problems: [
        {
          code: "feed_empty",
          message: "No articles found in feed XML.",
          impact: "No content available for discovery.",
          suggestion: "Check feed contents.",
          requiresHuman: false,
        },
      ],
    };
  }

  // Validate full-text HTML extraction on 1 sample item
  const sample = items[0]!;
  try {
    const html = await fetchArticleHtml(sample.url, context.signal);
    const extracted = extractArticle(html, sample.url);
    if (!extracted || !extracted.cleanResult.hasSubstantialContent) {
      return {
        availability: "unavailable",
        scope: [scopeId],
        basis: `Sample article ${sample.url} extraction failed to yield substantial content.`,
        problems: [
          {
            code: "sample_extraction_failed",
            message: "Extracted article content is empty or incomplete.",
            impact: "Full text cannot be extracted from sample article.",
            suggestion: "Check blog HTML structure and extractor selectors.",
            requiresHuman: false,
          },
        ],
      };
    }
  } catch (error) {
    return {
      availability: "unavailable",
      scope: [scopeId],
      basis: `Sample article check failed: ${error instanceof Error ? error.message : String(error)}`,
      problems: [
        {
          code: "sample_fetch_failed",
          message: error instanceof Error ? error.message : String(error),
          impact: "Sample article HTML could not be fetched.",
          suggestion: "Check sample article URL accessibility.",
          requiresHuman: false,
        },
      ],
    };
  }

  return {
    availability: "available",
    scope: [scopeId],
    basis: `Feed parsed successfully with ${items.length} items; sample article extraction verified on "${sample.title ?? sample.url}".`,
    problems: [],
  };
}

/** Sync action: records baseline on initial sync without HTML requests; syncs only new/modified items on subsequent syncs. */
async function syncHuggingFace(
  context: SourceAdapterContext<
    HuggingFaceConfig,
    never,
    HuggingFaceExtensions
  >,
  params: HuggingFaceParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  void params;
  const state = await loadIncrementalSyncState(context);
  const scopeId = "blog";
  const isInitialized = isIncrementalScopeInitialized(
    state,
    scopeId,
    context.config.feedUrl,
  );

  const validators = isInitialized
    ? {
        etag: state.scopes[scopeId]?.etag,
        lastModified: state.scopes[scopeId]?.lastModified,
      }
    : undefined;

  let feedResult: FeedFetchResult;
  try {
    feedResult = await fetchFeedXml(
      context.config.feedUrl,
      context.signal,
      validators,
    );
  } catch (error) {
    throw sourceAdapterActionError({
      code: "feed_request_failed",
      message: `Failed to fetch feed at ${context.config.feedUrl}: ${error instanceof Error ? error.message : String(error)}`,
      impact: "Incremental sync could not be completed.",
      suggestion: "Check feed URL and connectivity.",
      requiresHuman: false,
    });
  }

  if (feedResult.status === "not-modified") {
    updateIncrementalScopeValidators(state, scopeId, {
      etag: feedResult.etag,
      lastModified: feedResult.lastModified,
    });
    await saveIncrementalSyncState(context, state);
    return { completedScopes: [scopeId] };
  }

  const items = parseFeedItems(feedResult.text, context.config.feedUrl);

  // 1. Initial sync (baseline):
  // Records ALL discovered feed items in state with archivedCompleteness: "baseline"
  // WITHOUT making ANY article HTML detail requests or submitting to archive.
  if (!isInitialized) {
    const entries: Record<string, IncrementalEntryRecord> = {};
    for (const item of items) {
      const key = extractSlugOrKey(item.url, item.id);
      const pubDate = item.published ?? undefined;
      const fingerprint = computeFeedItemFingerprint({
        title: item.title,
        url: item.url,
        published: pubDate,
        categories: item.categories,
      });
      entries[key] = {
        fingerprint,
        ...(pubDate === undefined ? {} : { publishedAt: pubDate }),
        archivedCompleteness: "baseline",
      };
    }

    initializeIncrementalScope(state, scopeId, {
      scopeUrl: context.config.feedUrl,
      initializedAt: context.referenceTime,
      ...(feedResult.etag === undefined ? {} : { etag: feedResult.etag }),
      ...(feedResult.lastModified === undefined
        ? {}
        : { lastModified: feedResult.lastModified }),
      entries,
    });
    await saveIncrementalSyncState(context, state);
    return {
      completedScopes: [scopeId],
      initializedScopes: [scopeId],
    };
  }

  // 2. Subsequent sync:
  // Compares against state entries, fetching article HTML ONLY for newly added or modified feed items.
  const scope = state.scopes[scopeId]!;
  const toProcess: ParsedFeedItem[] = [];

  for (const item of items) {
    const key = extractSlugOrKey(item.url, item.id);
    const fingerprint = computeFeedItemFingerprint({
      title: item.title,
      url: item.url,
      published: item.published ?? undefined,
      categories: item.categories,
    });
    const existing = scope.entries[key];
    if (existing === undefined || existing.fingerprint !== fingerprint) {
      toProcess.push(item);
    }
  }

  for (const item of toProcess) {
    const processed = await processAndSubmitArticle(context, item.url, item);
    upsertIncrementalScopeEntry(state, scopeId, processed.key, {
      fingerprint: processed.fingerprint,
      ...(processed.publishedAt === undefined
        ? {}
        : { publishedAt: processed.publishedAt }),
      archivedCompleteness: processed.completeness,
    });
  }

  updateIncrementalScopeValidators(state, scopeId, {
    etag: feedResult.etag,
    lastModified: feedResult.lastModified,
  });
  await saveIncrementalSyncState(context, state);

  return { completedScopes: [scopeId] };
}

/** Collect action: collects explicitly requested URLs or up to maxItems from feed. */
async function collectHuggingFace(
  context: SourceAdapterContext<
    HuggingFaceConfig,
    never,
    HuggingFaceExtensions
  >,
  params: HuggingFaceParams,
): Promise<z.infer<typeof collectOutputSchema>> {
  const scopeId = "blog";
  const state =
    context.persistentState !== undefined
      ? await loadIncrementalSyncState(context)
      : undefined;

  if (params.itemUrls && params.itemUrls.length > 0) {
    // Process explicit itemUrls
    for (const itemUrl of params.itemUrls) {
      const processed = await processAndSubmitArticle(
        context,
        itemUrl,
        undefined,
      );
      if (state) {
        upsertIncrementalScopeEntry(state, scopeId, processed.key, {
          fingerprint: processed.fingerprint,
          ...(processed.publishedAt === undefined
            ? {}
            : { publishedAt: processed.publishedAt }),
          archivedCompleteness: processed.completeness,
        });
      }
    }
  } else {
    // Fetch feed and select up to maxItems or defaultCollectMaxItems
    let feedResult: FeedFetchResult;
    try {
      feedResult = await fetchFeedXml(context.config.feedUrl, context.signal);
    } catch (error) {
      throw sourceAdapterActionError({
        code: "feed_request_failed",
        message: `Failed to fetch feed at ${context.config.feedUrl}: ${error instanceof Error ? error.message : String(error)}`,
        impact: "Collection could not discover feed articles.",
        suggestion: "Check feed URL and connectivity.",
        requiresHuman: false,
      });
    }

    if (feedResult.status !== "ok") {
      throw sourceAdapterActionError({
        code: "feed_not_available",
        message:
          "Feed returned not modified or empty content during collection.",
        impact: "No items collected.",
        suggestion: "Ensure feed returns full XML content.",
        requiresHuman: false,
      });
    }

    const items = parseFeedItems(feedResult.text, context.config.feedUrl);
    const limit = params.maxItems ?? context.config.defaultCollectMaxItems;
    const selected = items.slice(0, limit);

    for (const item of selected) {
      const processed = await processAndSubmitArticle(context, item.url, item);
      if (state) {
        upsertIncrementalScopeEntry(state, scopeId, processed.key, {
          fingerprint: processed.fingerprint,
          ...(processed.publishedAt === undefined
            ? {}
            : { publishedAt: processed.publishedAt }),
          archivedCompleteness: processed.completeness,
        });
      }
    }
  }

  if (state && context.persistentState !== undefined) {
    await saveIncrementalSyncState(context, state);
  }

  return { completedScopes: [scopeId] };
}

export const sourceAdapter = defineSourceAdapter({
  id: "huggingface",
  version: "0.1.0",
  description: "Hugging Face Blog source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Check Hugging Face blog feed availability and full-text extraction.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: checkHuggingFace,
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Collect Hugging Face blog articles by URLs or limit.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: collectHuggingFace,
    }),
    sync: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Incrementally synchronize new or updated Hugging Face blog posts.",
      params: paramsSchema,
      output: syncOutputSchema,
      execute: syncHuggingFace,
    }),
  },
});
