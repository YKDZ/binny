// Source adapter definition for Google AI and Google DeepMind blogs.
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
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { parseFeed } from "@rowanmanning/feed-parser";
import { z } from "zod";

import { extractArticle } from "./article-extractor.ts";

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

export const syncOutputSchema = feedSyncOutputSchema;

export type GoogleConfig = z.output<typeof configSchema>;
export type GoogleParams = z.output<typeof paramsSchema>;
export type GoogleSourceDefinition = z.output<
  typeof googleSourceDefinitionSchema
>;

const extensionsSchema = z
  .object({
    sourceId: z
      .string()
      .describe("Configured Google publication feed that supplied this page."),
    region: z
      .string()
      .describe("Geographic region assigned to this Google publication."),
    language: z.string().describe("Language used by the published article."),
    authors: z
      .array(z.string())
      .describe("Author names shown by the article or its feed."),
    categories: z
      .array(z.string())
      .describe("Categories or tags assigned to the article by its source."),
  })
  .strict();

type GoogleExtensions = z.output<typeof extensionsSchema>;

type FeedItem = ReturnType<typeof parseFeed>["items"][number];

function rawFeedDate(
  item: FeedItem,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = item.element.findElementWithName(name)?.textContentNormalized;
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

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
  readonly stage?: string | undefined;
  readonly target?: string | undefined;
  readonly abortCause?: ManualRunAbortCause | undefined;
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

  const response = await fetchSourceResponse({
    url,
    signal,
    stage: "fetching-feed",
    headers,
  });

  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  const resValidators = {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };

  if (response.status === 304) {
    await response.cancelBody();
    return { status: 304, validators: resValidators };
  }

  if (!response.ok) {
    await response.cancelBody();
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
    const published = rawFeedDate(rawItem, [
      "pubdate",
      "published",
      "issued",
      "date",
    ]);
    const updated = rawFeedDate(rawItem, ["updated", "modified"]);

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
  const response = await fetchSourceResponse({
    url,
    signal,
    stage: "fetching-article",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Binny Google SourceAdapter/1.0",
    },
  });

  if (!response.ok) {
    await response.cancelBody();
    return { ok: false, status: response.status, html: "" };
  }

  const html = await response.text();
  return { ok: true, status: response.status, html };
}

function problemDiagnostics(
  error: unknown,
): Pick<ActionProblem, "stage" | "target" | "abortCause"> {
  const diag = readFailureDiagnosticContext(error);
  return {
    ...(diag.stage === undefined ? {} : { stage: diag.stage }),
    ...(diag.target === undefined ? {} : { target: diag.target }),
    ...(diag.abortCause === undefined ? {} : { abortCause: diag.abortCause }),
  };
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
      ...(first?.stage === undefined ? {} : { stage: first.stage }),
      ...(first?.target === undefined ? {} : { target: first.target }),
      ...(first?.abortCause === undefined
        ? {}
        : { abortCause: first.abortCause }),
    },
    completedScopes,
  );
}

async function check(
  context: SourceAdapterContext<GoogleConfig, never, GoogleExtensions>,
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

function normalizeComparableUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).href;
  } catch {
    return rawUrl;
  }
}

function findMatchedEntryByUrl(
  state: IncrementalSyncState,
  sourceId: string,
  targetUrl: string,
):
  | { readonly itemKey: string; readonly entry: IncrementalEntryRecord }
  | undefined {
  const entries = state.scopes[sourceId]?.entries;
  if (entries === undefined) return undefined;
  const normalizedTarget = normalizeComparableUrl(targetUrl);
  for (const [itemKey, entry] of Object.entries(entries)) {
    if (entry.articleUrl === targetUrl || itemKey === targetUrl) {
      return { itemKey, entry };
    }
    if (
      entry.articleUrl !== undefined &&
      normalizeComparableUrl(entry.articleUrl) === normalizedTarget
    ) {
      return { itemKey, entry };
    }
  }
  return undefined;
}

function resolveSourceForUrl(
  url: string,
  selectedSources: readonly GoogleSourceDefinition[],
  feedsBySourceId: ReadonlyMap<string, FeedFetchResult | undefined>,
  state: IncrementalSyncState,
):
  | {
      readonly source: GoogleSourceDefinition;
      readonly item: ParsedFeedItemData;
    }
  | undefined {
  const normalizedTarget = normalizeComparableUrl(url);

  for (const source of selectedSources) {
    const feedRes = feedsBySourceId.get(source.id);
    if (feedRes?.status === 200) {
      const feedItem = feedRes.items.find(
        (item) =>
          item.articleUrl === url ||
          normalizeComparableUrl(item.articleUrl) === normalizedTarget,
      );
      if (feedItem !== undefined) {
        return { source, item: feedItem };
      }
    }
  }

  for (const source of selectedSources) {
    const matched = findMatchedEntryByUrl(state, source.id, url);
    if (matched !== undefined) {
      return {
        source,
        item: {
          itemKey: matched.itemKey,
          articleUrl: url,
          published: matched.entry.publishedAt,
          updated: matched.entry.updatedAt,
          authors: [],
          categories: [],
          fingerprint: matched.entry.fingerprint,
        },
      };
    }
  }

  const fallbackSource = (() => {
    if (url.includes("blog.google")) {
      return selectedSources.find((s) => s.id === "google-ai");
    }
    if (url.includes("deepmind.google")) {
      return selectedSources.find((s) => s.id === "deepmind");
    }
    if (selectedSources.length === 1) {
      return selectedSources[0];
    }
    try {
      const targetParsed = new URL(url);
      const pathMatches = selectedSources.filter((s) => {
        const sourceParsed = new URL(s.url);
        if (sourceParsed.origin !== targetParsed.origin) return false;
        const dir = sourceParsed.pathname.replace(/[^/]*$/u, "");
        return dir.length > 1 && targetParsed.pathname.startsWith(dir);
      });
      if (pathMatches.length === 1) {
        return pathMatches[0];
      }
    } catch {
      // Ignore malformed URLs during heuristic source matching.
    }
    return undefined;
  })();

  if (fallbackSource === undefined) return undefined;
  return {
    source: fallbackSource,
    item: {
      itemKey: url,
      articleUrl: url,
      authors: [],
      categories: [],
      fingerprint: createHash("sha256").update(url).digest("hex"),
    },
  };
}

type FetchAndExtractResult =
  | {
      readonly ok: true;
      readonly extracted: NonNullable<ReturnType<typeof extractArticle>>;
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
        readonly problemMessage: string;
      };
    };

async function fetchAndExtractForArticle(
  articleUrl: string,
  sourceId: string,
  signal: AbortSignal,
): Promise<FetchAndExtractResult> {
  let articleRes: { ok: boolean; status: number; html: string };
  try {
    articleRes = await fetchArticleHtml(articleUrl, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    const diag = readFailureDiagnosticContext(error);
    if (
      diag.abortCause === "user_cancelled" ||
      diag.abortCause === "action_budget_exhausted"
    ) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      gap: {
        stage: "fetching-article",
        code: "article_fetch_failed",
        reason: detail,
        ...(diag.abortCause === undefined
          ? {}
          : { abortCause: diag.abortCause }),
        problemMessage: `Article "${articleUrl}" fetch failed: ${detail}`,
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
        problemMessage: `Article "${articleUrl}" returned HTTP ${articleRes.status}.`,
      },
    };
  }

  let extracted: ReturnType<typeof extractArticle>;
  try {
    extracted = extractArticle(articleRes.html, articleUrl, sourceId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      gap: {
        stage: "extracting-article",
        code: "article_extraction_failed",
        reason: detail,
        problemMessage: `Article "${articleUrl}" extraction failed: ${detail}`,
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
        reason: "Article page yielded no extractable article body.",
        problemMessage: `Article "${articleUrl}" yielded no extractable article body.`,
      },
    };
  }

  return { ok: true, extracted };
}

async function sync(
  context: SourceAdapterContext<GoogleConfig, never, GoogleExtensions>,
  params: GoogleParams,
) {
  const selected = selectSources(context.config, params);
  const state = await loadIncrementalSyncState(context);
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];
  const incompleteScopes: FeedIncompleteScope[] = [];
  const bodyGaps: FeedBodyGap[] = [];
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
        if (context.signal.aborted) throw context.signal.reason ?? error;
        problems.push({
          sourceId: source.id,
          message: `Failed to fetch feed on baseline sync: ${error instanceof Error ? error.message : String(error)}`,
          ...problemDiagnostics(error),
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
        baselineEntries[item.itemKey] = recordIncrementalBaselineEntry({
          fingerprint: item.fingerprint,
          publishedAt: item.published,
          updatedAt: item.updated,
          articleUrl: item.articleUrl,
        });
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
    const validators = {
      etag: scopeState.etag,
      lastModified: scopeState.lastModified,
    };

    let feedRes: FeedFetchResult;
    try {
      feedRes = await fetchFeed(source.url, validators, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      problems.push({
        sourceId: source.id,
        message: `Failed to fetch feed on incremental sync: ${error instanceof Error ? error.message : String(error)}`,
        ...problemDiagnostics(error),
      });
      continue;
    }

    if (feedRes.status === 304) {
      completedScopes.push(source.id);
      continue;
    }

    const changedItems = feedRes.items.filter((item) =>
      hasIncrementalEntryChanged(
        scopeState.entries[item.itemKey],
        item.fingerprint,
        item.updated,
      ),
    );

    let scopeSubmitFailed = false;
    let gapCountForScope = 0;
    let archivedCountForScope = 0;

    for (const item of changedItems) {
      if (context.signal.aborted) throw context.signal.reason;

      const previous = scopeState.entries[item.itemKey];
      const fetchExtract = await fetchAndExtractForArticle(
        item.articleUrl,
        source.id,
        context.signal,
      );
      if (!fetchExtract.ok) {
        const gapRecord = {
          url: item.articleUrl,
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
          source.id,
          item.itemKey,
          recordIncrementalBodyGapEntry(previous, {
            fingerprint: item.fingerprint,
            updatedAt: item.updated,
            publishedAt: item.published,
            articleUrl: item.articleUrl,
            gap: gapRecord,
          }),
        );
        // Persist body gap immediately so unchanged subsequent syncs do not re-fetch it.
        await saveIncrementalSyncState(context, state);
        bodyGaps.push({
          scope: source.id,
          itemKey: item.itemKey,
          ...gapRecord,
        });
        gapCountForScope += 1;
        continue;
      }

      const { extracted } = fetchExtract;
      const combinedAuthors = Array.from(
        new Set([...extracted.pageMetadata.authors, ...item.authors]),
      );
      const combinedCategories = Array.from(
        new Set([...extracted.pageMetadata.categories, ...item.categories]),
      );

      try {
        const submitResult = await submitCleanedArticle(context, {
          sourceKey: { namespace: `google:${source.id}`, key: item.itemKey },
          sourceRef: item.articleUrl,
          title: extracted.pageMetadata.title ?? item.title ?? null,
          sourcePublishedAt: sourceTimeFrom(
            extracted.pageMetadata.articlePublishedAt ?? item.published,
          ),
          sourceModifiedAt: sourceTimeFrom(
            extracted.pageMetadata.articleUpdatedAt,
          ),
          extensions: {
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

        upsertIncrementalScopeEntry(
          state,
          source.id,
          item.itemKey,
          recordIncrementalArchivedEntry(previous, {
            fingerprint: item.fingerprint,
            updatedAt: item.updated,
            publishedAt: item.published,
            articleUrl: item.articleUrl,
            completeness: submitResult.hasMediaFailures
              ? "partial"
              : "complete",
          }),
        );
        // Persist immediately after each archived article so partial failures do not drop committed progress.
        await saveIncrementalSyncState(context, state);
        archivedCountForScope += 1;
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        const diag = readFailureDiagnosticContext(error);
        if (
          diag.abortCause === "user_cancelled" ||
          diag.abortCause === "action_budget_exhausted"
        ) {
          throw error;
        }
        scopeSubmitFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Failed to submit article "${item.articleUrl}": ${error instanceof Error ? error.message : String(error)}`,
          ...problemDiagnostics(error),
        });
        // Stop this scope on archive submission failure so untried items keep retry eligibility.
        break;
      }
    }

    if (!scopeSubmitFailed) {
      updateIncrementalScopeValidators(state, source.id, {
        etag: feedRes.validators.etag,
        lastModified: feedRes.validators.lastModified,
      });
      await saveIncrementalSyncState(context, state);
      if (gapCountForScope > 0) {
        incompleteScopes.push({
          scope: source.id,
          reasonCode: "article_body_unavailable",
          message: `${String(gapCountForScope)} of ${String(changedItems.length)} changed feed items had unavailable article body; ${String(archivedCountForScope)} items were archived.`,
        });
      } else {
        completedScopes.push(source.id);
      }
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems(problems, completedScopes);
  }

  return {
    collectionCompleteness:
      incompleteScopes.length > 0
        ? ("partial" as const)
        : ("complete" as const),
    completedScopes,
    initializedScopes,
    ...(incompleteScopes.length > 0 ? { incompleteScopes } : {}),
    ...(bodyGaps.length > 0 ? { bodyGaps } : {}),
  };
}

async function collect(
  context: SourceAdapterContext<GoogleConfig, never, GoogleExtensions>,
  params: GoogleParams,
) {
  const selected = selectSources(context.config, params);
  const state = await loadIncrementalSyncState(context);
  const completedScopes: string[] = [];
  const problems: ActionProblem[] = selected.missing.map((id) => ({
    sourceId: id,
    message: `Requested source "${id}" is not configured.`,
  }));

  const explicitUrlsMode = Boolean(
    params.itemUrls && params.itemUrls.length > 0,
  );
  const itemsBySourceId = new Map<string, ParsedFeedItemData[]>();

  if (explicitUrlsMode && params.itemUrls) {
    const feedsBySourceId = new Map<string, FeedFetchResult | undefined>();
    for (const source of selected.sources) {
      if (context.signal.aborted) throw context.signal.reason;
      try {
        feedsBySourceId.set(
          source.id,
          await fetchFeed(source.url, {}, context.signal),
        );
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        feedsBySourceId.set(source.id, undefined);
      }
      itemsBySourceId.set(source.id, []);
    }

    for (const url of params.itemUrls) {
      const resolved = resolveSourceForUrl(
        url,
        selected.sources,
        feedsBySourceId,
        state,
      );
      if (resolved === undefined) {
        problems.push({
          sourceId: selected.sources[0]?.id ?? "google",
          message: `Article URL "${url}" did not match any selected Google source.`,
        });
        continue;
      }
      itemsBySourceId.get(resolved.source.id)!.push(resolved.item);
    }
  }

  for (const source of selected.sources) {
    if (context.signal.aborted) throw context.signal.reason;

    let itemsToCollect: ParsedFeedItemData[] = [];
    let truncatedByMaxItems = false;

    if (explicitUrlsMode) {
      itemsToCollect = itemsBySourceId.get(source.id) ?? [];
      if (itemsToCollect.length === 0) {
        continue;
      }
    } else {
      let feedRes: FeedFetchResult;
      try {
        feedRes = await fetchFeed(source.url, {}, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        problems.push({
          sourceId: source.id,
          message: `Failed to fetch feed on collect: ${error instanceof Error ? error.message : String(error)}`,
          ...problemDiagnostics(error),
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
        truncatedByMaxItems = itemsToCollect.length < feedRes.items.length;
      }
    }

    let scopeFailed = false;
    for (const item of itemsToCollect) {
      if (context.signal.aborted) throw context.signal.reason;

      const fetchExtract = await fetchAndExtractForArticle(
        item.articleUrl,
        source.id,
        context.signal,
      );
      if (!fetchExtract.ok) {
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: fetchExtract.gap.problemMessage,
          stage: fetchExtract.gap.stage,
          target: item.articleUrl,
          ...(fetchExtract.gap.abortCause === undefined
            ? {}
            : { abortCause: fetchExtract.gap.abortCause }),
        });
        continue;
      }

      const { extracted } = fetchExtract;
      const combinedAuthors = Array.from(
        new Set([...extracted.pageMetadata.authors, ...item.authors]),
      );
      const combinedCategories = Array.from(
        new Set([...extracted.pageMetadata.categories, ...item.categories]),
      );

      try {
        const submitResult = await submitCleanedArticle(context, {
          sourceKey: { namespace: `google:${source.id}`, key: item.itemKey },
          sourceRef: item.articleUrl,
          title: extracted.pageMetadata.title ?? item.title ?? null,
          sourcePublishedAt: sourceTimeFrom(
            extracted.pageMetadata.articlePublishedAt ?? item.published,
          ),
          sourceModifiedAt: sourceTimeFrom(
            extracted.pageMetadata.articleUpdatedAt,
          ),
          extensions: {
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

        const previousEntry = state.scopes[source.id]?.entries[item.itemKey];
        upsertIncrementalScopeEntry(
          state,
          source.id,
          item.itemKey,
          recordIncrementalArchivedEntry(previousEntry, {
            fingerprint: item.fingerprint,
            updatedAt: item.updated,
            publishedAt: item.published,
            articleUrl: item.articleUrl,
            completeness: submitResult.hasMediaFailures
              ? "partial"
              : "complete",
          }),
        );
        await saveIncrementalSyncState(context, state);
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        const diag = readFailureDiagnosticContext(error);
        if (
          diag.abortCause === "user_cancelled" ||
          diag.abortCause === "action_budget_exhausted"
        ) {
          throw error;
        }
        scopeFailed = true;
        problems.push({
          sourceId: source.id,
          message: `Failed to submit article "${item.articleUrl}": ${error instanceof Error ? error.message : String(error)}`,
          ...problemDiagnostics(error),
        });
        continue;
      }
    }

    if (!scopeFailed && !truncatedByMaxItems) {
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
  extensionsSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Check Google AI and DeepMind sources availability.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: check,
    }),
    sync: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Incrementally sync Google AI and DeepMind articles.",
      params: paramsSchema,
      output: syncOutputSchema,
      execute: sync,
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Collect and archive Google AI and DeepMind articles.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: collect,
    }),
  },
});
