// Source adapter implementation for Hugging Face Blog.
import { createHash } from "node:crypto";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  feedSyncOutputSchema,
  fetchSourceResponse,
  hasIncrementalEntryChanged,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  isSourceAdapterActionError,
  loadIncrementalSyncState,
  readFailureDiagnosticContext,
  recordIncrementalArchivedEntry,
  recordIncrementalBaselineEntry,
  recordIncrementalBodyGapEntry,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  sourceTimeFrom,
  submitCleanedArticle,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  type FeedBodyGap,
  type FeedIncompleteScope,
  type IncrementalEntryRecord,
  type IncrementalSyncState,
  type ManualRunAbortCause,
  type ManualRunFailure,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { parseFeed } from "@rowanmanning/feed-parser";
import { z } from "zod";

import { extractArticle, type ExtractedArticle } from "./html-extractor.ts";

const configSchema = z.object({
  feedUrl: z.url().default("https://huggingface.co/blog/feed.xml"),
  defaultCollectMaxItems: z.number().int().positive().optional(),
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

const syncOutputSchema = feedSyncOutputSchema;

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

  const response = await fetchSourceResponse({
    url: feedUrl,
    signal,
    stage: "fetching-feed",
    headers,
  });

  if (response.status === 304) {
    await response.cancelBody();
    return {
      status: "not-modified",
      etag: response.headers.get("etag") ?? validators?.etag,
      lastModified:
        response.headers.get("last-modified") ?? validators?.lastModified,
    };
  }

  if (response.status !== 200) {
    await response.cancelBody();
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

/** Fetches full HTML of an article page without throwing on HTTP status codes. */
async function fetchArticleHtml(
  url: string,
  signal: AbortSignal,
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly html: string;
}> {
  const response = await fetchSourceResponse({
    url,
    signal,
    stage: "fetching-article",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Binny SourceAdapter/1.0",
    },
  });

  if (!response.ok) {
    await response.cancelBody();
    return { ok: false, status: response.status, html: "" };
  }

  const html = await response.text();
  return { ok: true, status: response.status, html };
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

function normalizeComparableUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).href;
  } catch {
    return rawUrl;
  }
}

function findExistingEntryForUrl(
  state: IncrementalSyncState | undefined,
  scopeId: string,
  itemUrl: string,
  feedItem: ParsedFeedItem | undefined,
):
  | { readonly key: string; readonly entry: IncrementalEntryRecord }
  | undefined {
  const entries = state?.scopes[scopeId]?.entries;
  if (entries === undefined) return undefined;

  if (feedItem !== undefined) {
    const feedKey = extractSlugOrKey(feedItem.url, feedItem.id);
    const byFeedKey = entries[feedKey];
    if (byFeedKey !== undefined) {
      return { key: feedKey, entry: byFeedKey };
    }
  }

  const normalizedTarget = normalizeComparableUrl(itemUrl);
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.articleUrl === itemUrl) {
      return { key, entry };
    }
    if (
      entry.articleUrl !== undefined &&
      normalizeComparableUrl(entry.articleUrl) === normalizedTarget
    ) {
      return { key, entry };
    }
  }

  const slugKey = extractSlugOrKey(itemUrl, feedItem?.id);
  const bySlugKey = entries[slugKey];
  if (bySlugKey !== undefined) {
    return { key: slugKey, entry: bySlugKey };
  }
  return undefined;
}

type FetchAndExtractArticleResult =
  | {
      readonly ok: true;
      readonly extracted: ExtractedArticle;
    }
  | {
      readonly ok: false;
      readonly gap: {
        readonly stage: "fetching-article" | "extracting-article";
        readonly code:
          | "article_fetch_failed"
          | "article_http_error"
          | "article_extraction_failed"
          | "article_content_empty";
        readonly reason: string;
        readonly httpStatus?: number;
        readonly abortCause?: ManualRunAbortCause;
        readonly target?: string;
      };
    };

/** Fetches and extracts article HTML without submitting to the archive. */
async function fetchAndExtractArticle(
  itemUrl: string,
  signal: AbortSignal,
): Promise<FetchAndExtractArticleResult> {
  let articleRes: {
    readonly ok: boolean;
    readonly status: number;
    readonly html: string;
  };
  try {
    articleRes = await fetchArticleHtml(itemUrl, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    const diag = readFailureDiagnosticContext(error);
    if (
      diag.abortCause === "user_cancelled" ||
      diag.abortCause === "action_budget_exhausted"
    ) {
      throw error;
    }
    return {
      ok: false,
      gap: {
        stage: "fetching-article",
        code: "article_fetch_failed",
        reason: `Failed to fetch article at ${itemUrl}: ${error instanceof Error ? error.message : String(error)}`,
        ...(diag.target === undefined
          ? { target: itemUrl }
          : { target: diag.target }),
        ...(diag.abortCause === undefined
          ? {}
          : { abortCause: diag.abortCause }),
      },
    };
  }

  if (!articleRes.ok) {
    return {
      ok: false,
      gap: {
        stage: "fetching-article",
        code: "article_http_error",
        reason: `Article HTTP request returned status ${String(articleRes.status)}.`,
        ...(articleRes.status >= 100 && articleRes.status <= 599
          ? { httpStatus: articleRes.status }
          : {}),
        target: itemUrl,
      },
    };
  }

  let extracted: ExtractedArticle | undefined;
  try {
    extracted = extractArticle(articleRes.html, itemUrl);
  } catch (error) {
    return {
      ok: false,
      gap: {
        stage: "extracting-article",
        code: "article_extraction_failed",
        reason: `Failed to extract article HTML at ${itemUrl}: ${error instanceof Error ? error.message : String(error)}`,
        target: itemUrl,
      },
    };
  }

  if (
    !extracted ||
    !extracted.cleanResult.hasSubstantialContent ||
    extracted.cleanResult.text.trim().length === 0
  ) {
    return {
      ok: false,
      gap: {
        stage: "extracting-article",
        code: "article_content_empty",
        reason: `Article at ${itemUrl} has no substantial content after cleaning.`,
        target: itemUrl,
      },
    };
  }

  return { ok: true, extracted };
}

function failureFromArticleGap(
  itemUrl: string,
  gap: Extract<FetchAndExtractArticleResult, { ok: false }>["gap"],
): ManualRunFailure {
  const code =
    gap.code === "article_http_error" ? "article_fetch_failed" : gap.code;
  return {
    code,
    message: gap.reason,
    impact:
      gap.stage === "fetching-article"
        ? "Article was not fetched and will not be archived."
        : "Article was not archived.",
    requiresHuman: false,
    stage: gap.stage,
    target: gap.target ?? itemUrl,
    ...(gap.abortCause === undefined ? {} : { abortCause: gap.abortCause }),
  };
}

/** Submits an extracted article to the Core archive and returns aligned index metadata. */
async function submitExtractedArticle(
  context: SourceAdapterContext<
    HuggingFaceConfig,
    never,
    HuggingFaceExtensions
  >,
  itemUrl: string,
  extracted: ExtractedArticle,
  options?: {
    readonly feedItem?: ParsedFeedItem | undefined;
    readonly matchedKey?: string | undefined;
    readonly previousEntry?: IncrementalEntryRecord | undefined;
  },
): Promise<{
  readonly key: string;
  readonly fingerprint: string;
  readonly publishedAt?: string | undefined;
  readonly articleUrl: string;
  readonly completeness: "complete" | "partial";
}> {
  const feedItem = options?.feedItem;
  const previousEntry = options?.previousEntry;
  const key = options?.matchedKey ?? extractSlugOrKey(itemUrl, feedItem?.id);
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

  // Preserve the feed's index fingerprint (or prior recorded fingerprint during offline backfill)
  // so explicit collect does not diverge from RSS <pubDate>/<category> on the next sync.
  const fingerprint = feedItem
    ? computeFeedItemFingerprint({
        title: feedItem.title,
        url: feedItem.url,
        published: feedPublishedAt,
        categories: feedItem.categories,
      })
    : previousEntry !== undefined
      ? previousEntry.fingerprint
      : computeFeedItemFingerprint({
          title,
          url: itemUrl,
          published: publishedDate,
          categories,
        });

  const recordedPublishedAt = feedItem
    ? feedPublishedAt
    : previousEntry !== undefined
      ? previousEntry.publishedAt
      : publishedDate;
  const recordedArticleUrl =
    feedItem?.url ?? previousEntry?.articleUrl ?? itemUrl;

  return {
    key,
    fingerprint,
    ...(recordedPublishedAt === undefined
      ? {}
      : { publishedAt: recordedPublishedAt }),
    articleUrl: recordedArticleUrl,
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
    if (context.signal.aborted) throw context.signal.reason ?? error;
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
    if (context.signal.aborted) throw context.signal.reason ?? error;
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
    const articleRes = await fetchArticleHtml(sample.url, context.signal);
    if (!articleRes.ok) {
      return {
        availability: "unavailable",
        scope: [scopeId],
        basis: `Sample article check failed: Article request to ${sample.url} returned HTTP ${articleRes.status}`,
        problems: [
          {
            code: "sample_fetch_failed",
            message: `Article request to ${sample.url} returned HTTP ${articleRes.status}`,
            impact: "Sample article HTML could not be fetched.",
            suggestion: "Check sample article URL accessibility.",
            requiresHuman: false,
          },
        ],
      };
    }
    const extracted = extractArticle(articleRes.html, sample.url);
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
    if (context.signal.aborted) throw context.signal.reason ?? error;
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

function failureFromProblems(
  problems: readonly ManualRunFailure[],
  completedScopes: readonly string[],
) {
  const first = problems[0]!;
  if (problems.length === 1) {
    return sourceAdapterActionError(first, completedScopes);
  }
  const summary = problems
    .slice(0, 8)
    .map((problem) => problem.message)
    .join("; ");
  const more =
    problems.length > 8 ? `; and ${problems.length - 8} more problems` : "";
  return sourceAdapterActionError(
    {
      ...first,
      message: `${summary}${more}`,
    },
    completedScopes,
  );
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
    if (context.signal.aborted) throw context.signal.reason ?? error;
    const diag = readFailureDiagnosticContext(error);
    throw sourceAdapterActionError({
      code: "feed_request_failed",
      message: `Failed to fetch feed at ${context.config.feedUrl}: ${error instanceof Error ? error.message : String(error)}`,
      impact: "Incremental sync could not be completed.",
      requiresHuman: false,
      ...(diag.stage === undefined ? {} : { stage: diag.stage }),
      ...(diag.target === undefined ? {} : { target: diag.target }),
      ...(diag.abortCause === undefined ? {} : { abortCause: diag.abortCause }),
    });
  }

  if (feedResult.status === "not-modified") {
    updateIncrementalScopeValidators(state, scopeId, {
      etag: feedResult.etag,
      lastModified: feedResult.lastModified,
    });
    await saveIncrementalSyncState(context, state);
    return {
      collectionCompleteness: "complete",
      completedScopes: [scopeId],
    };
  }

  let items: ParsedFeedItem[];
  try {
    items = parseFeedItems(feedResult.text, context.config.feedUrl);
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason ?? error;
    throw sourceAdapterActionError({
      code: "feed_parse_failed",
      message: `Failed to parse feed XML at ${context.config.feedUrl}: ${error instanceof Error ? error.message : String(error)}`,
      impact:
        "Incremental sync could not parse feed items; feed validators were not advanced.",
      requiresHuman: false,
      stage: "parsing-feed",
      target: context.config.feedUrl,
    });
  }

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
      entries[key] = recordIncrementalBaselineEntry({
        fingerprint,
        publishedAt: pubDate,
        articleUrl: item.url,
      });
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
      collectionCompleteness: "complete",
      completedScopes: [scopeId],
      initializedScopes: [scopeId],
    };
  }

  // 2. Subsequent sync:
  // Compares against state entries, fetching article HTML ONLY for newly added or modified feed items.
  const scope = state.scopes[scopeId]!;
  const changedItems: {
    readonly item: ParsedFeedItem;
    readonly key: string;
    readonly fingerprint: string;
  }[] = [];

  for (const item of items) {
    const key = extractSlugOrKey(item.url, item.id);
    const fingerprint = computeFeedItemFingerprint({
      title: item.title,
      url: item.url,
      published: item.published ?? undefined,
      categories: item.categories,
    });
    const existing = scope.entries[key];
    if (hasIncrementalEntryChanged(existing, fingerprint)) {
      changedItems.push({ item, key, fingerprint });
    }
  }

  const bodyGaps: FeedBodyGap[] = [];
  let archivedCount = 0;

  for (const { item, key, fingerprint } of changedItems) {
    if (context.signal.aborted) throw context.signal.reason;

    const existing = scope.entries[key];
    const fetchExtract = await fetchAndExtractArticle(item.url, context.signal);
    if (!fetchExtract.ok) {
      const gapRecord = {
        url: item.url,
        stage: fetchExtract.gap.stage,
        code: fetchExtract.gap.code,
        reason: fetchExtract.gap.reason,
        ...(fetchExtract.gap.httpStatus === undefined
          ? {}
          : { httpStatus: fetchExtract.gap.httpStatus }),
        ...(fetchExtract.gap.abortCause === undefined
          ? {}
          : { abortCause: fetchExtract.gap.abortCause }),
      };
      upsertIncrementalScopeEntry(
        state,
        scopeId,
        key,
        recordIncrementalBodyGapEntry(existing, {
          fingerprint,
          publishedAt: item.published ?? undefined,
          articleUrl: item.url,
          gap: gapRecord,
        }),
      );
      // Persist body gap immediately so unchanged subsequent syncs do not re-fetch it.
      await saveIncrementalSyncState(context, state);
      bodyGaps.push({
        scope: scopeId,
        itemKey: key,
        ...gapRecord,
      });
      continue;
    }

    try {
      const submitted = await submitExtractedArticle(
        context,
        item.url,
        fetchExtract.extracted,
        {
          feedItem: item,
          matchedKey: key,
          previousEntry: existing,
        },
      );
      upsertIncrementalScopeEntry(
        state,
        scopeId,
        submitted.key,
        recordIncrementalArchivedEntry(existing, {
          fingerprint: submitted.fingerprint,
          publishedAt: submitted.publishedAt,
          articleUrl: submitted.articleUrl,
          completeness: submitted.completeness,
        }),
      );
      // Persist each archived article immediately so partial failures do not drop committed progress.
      await saveIncrementalSyncState(context, state);
      archivedCount += 1;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      const diag = readFailureDiagnosticContext(error);
      if (
        diag.abortCause === "user_cancelled" ||
        diag.abortCause === "action_budget_exhausted"
      ) {
        throw error;
      }
      if (isSourceAdapterActionError(error)) {
        throw error;
      }
      throw sourceAdapterActionError({
        code: "article_sync_failed",
        message: `Failed to submit article at ${item.url}: ${error instanceof Error ? error.message : String(error)}`,
        impact: "Article was not archived; feed validators were not advanced.",
        requiresHuman: false,
        ...(diag.stage === undefined ? {} : { stage: diag.stage }),
        ...(diag.target === undefined ? {} : { target: diag.target }),
        ...(diag.abortCause === undefined
          ? {}
          : { abortCause: diag.abortCause }),
      });
    }
  }

  updateIncrementalScopeValidators(state, scopeId, {
    etag: feedResult.etag,
    lastModified: feedResult.lastModified,
  });
  await saveIncrementalSyncState(context, state);

  if (bodyGaps.length > 0) {
    const incompleteScopes: FeedIncompleteScope[] = [
      {
        scope: scopeId,
        reasonCode: "article_body_unavailable",
        message: `${String(bodyGaps.length)} of ${String(changedItems.length)} changed feed items had unavailable article body; ${String(archivedCount)} items were archived.`,
      },
    ];
    return {
      collectionCompleteness: "partial",
      completedScopes: [],
      incompleteScopes,
      bodyGaps,
    };
  }

  return {
    collectionCompleteness: "complete",
    completedScopes: [scopeId],
  };
}

/** Collect action: collects explicitly requested URLs or feed items (optionally limited by maxItems). */
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

  const problems: ManualRunFailure[] = [];
  let truncatedByMaxItems = false;

  if (params.itemUrls && params.itemUrls.length > 0) {
    // Non-fatally load feed items so explicit URL collection aligns with feed keys and fingerprints when reachable.
    let feedItems: readonly ParsedFeedItem[] = [];
    try {
      const feedResult = await fetchFeedXml(
        context.config.feedUrl,
        context.signal,
      );
      if (feedResult.status === "ok") {
        feedItems = parseFeedItems(feedResult.text, context.config.feedUrl);
      }
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      feedItems = [];
    }

    for (const itemUrl of params.itemUrls) {
      if (context.signal.aborted) throw context.signal.reason;
      const normalizedItemUrl = normalizeComparableUrl(itemUrl);
      const feedItem = feedItems.find(
        (candidate) =>
          candidate.url === itemUrl ||
          normalizeComparableUrl(candidate.url) === normalizedItemUrl,
      );
      const existingMatch = findExistingEntryForUrl(
        state,
        scopeId,
        itemUrl,
        feedItem,
      );

      const fetchExtract = await fetchAndExtractArticle(
        itemUrl,
        context.signal,
      );
      if (!fetchExtract.ok) {
        problems.push(failureFromArticleGap(itemUrl, fetchExtract.gap));
        continue;
      }

      try {
        const submitted = await submitExtractedArticle(
          context,
          itemUrl,
          fetchExtract.extracted,
          {
            feedItem,
            matchedKey: existingMatch?.key,
            previousEntry: existingMatch?.entry,
          },
        );
        if (state) {
          upsertIncrementalScopeEntry(
            state,
            scopeId,
            submitted.key,
            recordIncrementalArchivedEntry(existingMatch?.entry, {
              fingerprint: submitted.fingerprint,
              publishedAt: submitted.publishedAt,
              articleUrl: submitted.articleUrl,
              completeness: submitted.completeness,
            }),
          );
          await saveIncrementalSyncState(context, state);
        }
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        const diag = readFailureDiagnosticContext(error);
        if (
          diag.abortCause === "user_cancelled" ||
          diag.abortCause === "action_budget_exhausted"
        ) {
          throw error;
        }
        if (isSourceAdapterActionError(error)) {
          problems.push(error.failure);
        } else {
          problems.push({
            code: "article_collect_failed",
            message: `Failed to collect article at ${itemUrl}: ${error instanceof Error ? error.message : String(error)}`,
            impact: "Article was not archived.",
            requiresHuman: false,
            ...(diag.stage === undefined ? {} : { stage: diag.stage }),
            ...(diag.target === undefined ? {} : { target: diag.target }),
            ...(diag.abortCause === undefined
              ? {}
              : { abortCause: diag.abortCause }),
          });
        }
      }
    }
  } else {
    // Fetch feed and collect all items unless params.maxItems is explicitly set
    let feedResult: FeedFetchResult;
    try {
      feedResult = await fetchFeedXml(context.config.feedUrl, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      const diag = readFailureDiagnosticContext(error);
      throw sourceAdapterActionError({
        code: "feed_request_failed",
        message: `Failed to fetch feed at ${context.config.feedUrl}: ${error instanceof Error ? error.message : String(error)}`,
        impact: "Collection could not discover feed articles.",
        suggestion: "Check feed URL and connectivity.",
        requiresHuman: false,
        ...(diag.stage === undefined ? {} : { stage: diag.stage }),
        ...(diag.target === undefined ? {} : { target: diag.target }),
        ...(diag.abortCause === undefined
          ? {}
          : { abortCause: diag.abortCause }),
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

    let items: ParsedFeedItem[];
    try {
      items = parseFeedItems(feedResult.text, context.config.feedUrl);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      throw sourceAdapterActionError({
        code: "feed_parse_failed",
        message: `Failed to parse feed XML at ${context.config.feedUrl}: ${error instanceof Error ? error.message : String(error)}`,
        impact: "Collection could not parse feed articles.",
        requiresHuman: false,
        stage: "parsing-feed",
        target: context.config.feedUrl,
      });
    }

    const selected =
      params.maxItems !== undefined ? items.slice(0, params.maxItems) : items;
    truncatedByMaxItems =
      params.maxItems !== undefined && selected.length < items.length;

    for (const item of selected) {
      if (context.signal.aborted) throw context.signal.reason;
      const key = extractSlugOrKey(item.url, item.id);
      const existing = state?.scopes[scopeId]?.entries[key];

      const fetchExtract = await fetchAndExtractArticle(
        item.url,
        context.signal,
      );
      if (!fetchExtract.ok) {
        problems.push(failureFromArticleGap(item.url, fetchExtract.gap));
        continue;
      }

      try {
        const submitted = await submitExtractedArticle(
          context,
          item.url,
          fetchExtract.extracted,
          {
            feedItem: item,
            matchedKey: key,
            previousEntry: existing,
          },
        );
        if (state) {
          upsertIncrementalScopeEntry(
            state,
            scopeId,
            submitted.key,
            recordIncrementalArchivedEntry(existing, {
              fingerprint: submitted.fingerprint,
              publishedAt: submitted.publishedAt,
              articleUrl: submitted.articleUrl,
              completeness: submitted.completeness,
            }),
          );
          await saveIncrementalSyncState(context, state);
        }
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        const diag = readFailureDiagnosticContext(error);
        if (
          diag.abortCause === "user_cancelled" ||
          diag.abortCause === "action_budget_exhausted"
        ) {
          throw error;
        }
        if (isSourceAdapterActionError(error)) {
          problems.push(error.failure);
        } else {
          problems.push({
            code: "article_collect_failed",
            message: `Failed to collect article at ${item.url}: ${error instanceof Error ? error.message : String(error)}`,
            impact: "Article was not archived.",
            requiresHuman: false,
            ...(diag.stage === undefined ? {} : { stage: diag.stage }),
            ...(diag.target === undefined ? {} : { target: diag.target }),
            ...(diag.abortCause === undefined
              ? {}
              : { abortCause: diag.abortCause }),
          });
        }
      }
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems(problems, []);
  }

  return { completedScopes: truncatedByMaxItems ? [] : [scopeId] };
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
