// Mistral News source adapter definition and actions.
import { createHash } from "node:crypto";

import {
  cleanContent,
  defineSourceAdapter,
  defineSourceAdapterAction,
  hasIncrementalEntryChanged,
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
  type IncrementalSyncState,
  type SourceAdapterActionError,
  type SourceAdapterContext,
  type SubmitCleanedArticleResult,
} from "@binny/source-adapter-sdk";
import { parseFeed } from "@rowanmanning/feed-parser";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";

const configSchema = z
  .object({
    rssUrl: z
      .url()
      .default("https://mistral.ai/news/rss")
      .describe("Mistral News RSS feed URL."),
  })
  .strict();

const paramsSchema = z
  .object({
    itemUrls: z.array(z.url()).max(100).optional(),
    maxItems: z.number().int().positive().max(1000).optional(),
  })
  .strict();

const checkProblemSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    impact: z.string().min(1),
    path: z.array(z.union([z.string(), z.number()])).optional(),
    suggestion: z.string().min(1),
    requiresHuman: z.boolean(),
  })
  .strict();

const checkOutputSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string()),
    basis: z.string().min(1),
    problems: z.array(checkProblemSchema),
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

type MistralConfig = z.output<typeof configSchema>;
type MistralParams = z.output<typeof paramsSchema>;

const extensionsSchema = z
  .object({
    region: z.string().describe("Geographic region assigned to Mistral News."),
    language: z.string().describe("Language used by the published article."),
    categories: z
      .array(z.string())
      .describe(
        "Categories assigned by the Mistral News feed or article page.",
      ),
    authors: z
      .array(z.string())
      .describe("Author names identified on the Mistral article or RSS feed."),
    rssDescription: z
      .string()
      .optional()
      .describe("Article summary text supplied by the Mistral RSS feed."),
  })
  .strict();

type MistralExtensions = z.output<typeof extensionsSchema>;

interface ParsedMistralFeedItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly published: string | null;
  readonly updated: string | null;
  readonly description: string | null;
  readonly categories: readonly string[];
  readonly authors: readonly string[];
}

type FeedItem = ReturnType<typeof parseFeed>["items"][number];

function rawFeedDate(item: FeedItem, names: readonly string[]): string | null {
  for (const name of names) {
    const value = item.element.findElementWithName(name)?.textContentNormalized;
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return null;
}

interface ExtractedArticleMetadata {
  readonly articlePublishedAt?: string | undefined;
  readonly articleUpdatedAt?: string | undefined;
  readonly visibleDate?: string | undefined;
  readonly authors: readonly string[];
  readonly categories: readonly string[];
  readonly language: string;
}

function getAttr(
  element: DefaultTreeAdapterMap["element"],
  name: string,
): string | undefined {
  return element.attrs?.find((a) => a.name === name)?.value;
}

function getNodeText(node: DefaultTreeAdapterMap["node"]): string {
  if (!("tagName" in node)) {
    return node.nodeName === "#text" ? (node as { value: string }).value : "";
  }
  return (node.childNodes ?? []).map(getNodeText).join("");
}

function findHeading(
  node: DefaultTreeAdapterMap["node"],
): DefaultTreeAdapterMap["element"] | undefined {
  if ("tagName" in node) {
    if (/^h[1-6]$/iu.test(node.tagName)) return node;
    for (const child of node.childNodes ?? []) {
      const found = findHeading(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function extractSlugOrGuid(url: string, guid?: string | null): string {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/news\/([^/]+)/u);
    if (match?.[1]) {
      return match[1];
    }
    const cleanPath = parsed.pathname.replace(/^\/+/u, "").replace(/\/+$/u, "");
    if (cleanPath.length > 0) {
      return cleanPath.replaceAll("/", "-");
    }
  } catch {
    // Ignore invalid URL
  }

  if (guid !== null && guid !== undefined && guid.length > 0) {
    try {
      const parsed = new URL(guid);
      const match = parsed.pathname.match(/\/news\/([^/]+)/u);
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // Non-URL guid
    }
    return guid;
  }

  return url;
}

export function computeFeedFingerprint(item: {
  readonly title?: string | null;
  readonly url?: string | null;
  readonly published?: string | null;
  readonly updated?: string | null;
  readonly description?: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: item.title ?? "",
        url: item.url ?? "",
        published: item.published ?? "",
        updated: item.updated ?? "",
        description: item.description ?? "",
      }),
    )
    .digest("hex");
}

export function isMistralDropElement(
  element: DefaultTreeAdapterMap["element"],
): boolean {
  const tag = element.tagName.toLowerCase();
  const cls = (getAttr(element, "class") ?? "").toLowerCase();
  const id = (getAttr(element, "id") ?? "").toLowerCase();
  const aria = (getAttr(element, "aria-label") ?? "").toLowerCase();

  // Noise tags and custom site shell components
  if (
    tag === "header" ||
    tag === "nav" ||
    tag === "footer" ||
    tag === "button"
  ) {
    return true;
  }
  if (
    tag.startsWith("global-navigation") ||
    tag.startsWith("global-footer") ||
    tag.startsWith("mistral-section-blog-footer") ||
    tag.includes("copy-clipboard") ||
    tag.includes("button-tooltip")
  ) {
    return true;
  }

  // Site nav/footer classes
  if (
    cls.includes("site-header") ||
    cls.includes("site-footer") ||
    cls.includes("site-nav")
  ) {
    return true;
  }

  // Share buttons and tools
  if (
    cls.includes("share") ||
    cls.includes("social-share") ||
    cls.includes("copy-url") ||
    cls.includes("copy-clipboard") ||
    cls.includes("share-button") ||
    id.includes("share") ||
    aria.includes("share")
  ) {
    return true;
  }

  // Author / CTA banners
  if (
    cls.includes("author-banner") ||
    cls.includes("author-card") ||
    cls.includes("author-info") ||
    cls.includes("author-bio") ||
    cls.includes("cta-banner") ||
    cls.includes("cta-section") ||
    cls.includes("model-card") ||
    id.includes("author-banner") ||
    id.includes("cta-banner")
  ) {
    return true;
  }

  // Mistral model card sidebar in article flex layout
  if (cls.includes("w-96") && cls.includes("shrink-0")) {
    return true;
  }

  // Related articles and more news cards
  if (
    cls.includes("related-articles") ||
    cls.includes("related-posts") ||
    cls.includes("more-news") ||
    cls.includes("more-articles") ||
    cls.includes("recommended") ||
    id.includes("related-articles") ||
    id.includes("more-news")
  ) {
    return true;
  }

  // Generic containers with heading matching related articles / more news
  if (tag === "div" || tag === "section" || tag === "aside") {
    const heading = findHeading(element);
    if (heading !== undefined) {
      const headingText = getNodeText(heading).toLowerCase().trim();
      if (
        headingText.includes("related article") ||
        headingText.includes("related post") ||
        headingText.includes("more news") ||
        headingText.includes("more article") ||
        headingText === "related"
      ) {
        return true;
      }
    }
  }

  // Check element text for exact share button or back link labels
  if (
    tag === "a" ||
    tag === "div" ||
    tag === "p" ||
    tag === "span" ||
    tag === "label"
  ) {
    const text = getNodeText(element).toLowerCase().trim();
    if (
      text === "share this post" ||
      text === "copy url to clipboard" ||
      text === "copy url" ||
      text === "copied" ||
      text === "back to blog"
    ) {
      return true;
    }
  }

  return false;
}

export function extractArticleMetadata(html: string): ExtractedArticleMetadata {
  const doc = parse(html);
  let articlePublishedAt: string | undefined;
  let articleUpdatedAt: string | undefined;
  let visibleDate: string | undefined;
  const authors: string[] = [];
  const categories: string[] = [];
  let language = "en";

  function parseJsonLdNode(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (
      "@graph" in node &&
      Array.isArray((node as { "@graph": unknown[] })["@graph"])
    ) {
      for (const item of (node as { "@graph": unknown[] })["@graph"]) {
        parseJsonLdNode(item);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        parseJsonLdNode(item);
      }
      return;
    }

    const obj = node as Record<string, unknown>;

    if (
      typeof obj.datePublished === "string" &&
      articlePublishedAt === undefined
    ) {
      articlePublishedAt = obj.datePublished;
    }
    if (
      typeof obj.dateModified === "string" &&
      articleUpdatedAt === undefined
    ) {
      articleUpdatedAt = obj.dateModified;
    }
    if (typeof obj.inLanguage === "string") {
      language = obj.inLanguage;
    }
    if (obj.author !== undefined) {
      const a = obj.author;
      if (typeof a === "string" && !authors.includes(a)) {
        authors.push(a);
      } else if (Array.isArray(a)) {
        for (const item of a) {
          if (typeof item === "string" && !authors.includes(item)) {
            authors.push(item);
          } else if (
            item !== null &&
            typeof item === "object" &&
            "name" in item &&
            typeof (item as { name: unknown }).name === "string"
          ) {
            const name = (item as { name: string }).name;
            if (!authors.includes(name)) authors.push(name);
          }
        }
      } else if (
        a !== null &&
        typeof a === "object" &&
        "name" in a &&
        typeof (a as { name: unknown }).name === "string"
      ) {
        const name = (a as { name: string }).name;
        if (!authors.includes(name)) authors.push(name);
      }
    }
    if (
      typeof obj.articleSection === "string" &&
      !categories.includes(obj.articleSection)
    ) {
      categories.push(obj.articleSection);
    } else if (Array.isArray(obj.articleSection)) {
      for (const s of obj.articleSection) {
        if (typeof s === "string" && !categories.includes(s)) {
          categories.push(s);
        }
      }
    }
    if (typeof obj.keywords === "string") {
      for (const k of obj.keywords.split(",")) {
        const trimmed = k.trim();
        if (trimmed.length > 0 && !categories.includes(trimmed)) {
          categories.push(trimmed);
        }
      }
    } else if (Array.isArray(obj.keywords)) {
      for (const k of obj.keywords) {
        if (typeof k === "string") {
          const trimmed = k.trim();
          if (trimmed.length > 0 && !categories.includes(trimmed)) {
            categories.push(trimmed);
          }
        }
      }
    }
  }

  function walk(node: DefaultTreeAdapterMap["node"]): void {
    if ("tagName" in node) {
      const tag = node.tagName.toLowerCase();
      if (tag === "html") {
        const lang = getAttr(node, "lang");
        if (lang !== undefined && lang.length > 0) {
          language = lang;
        }
      }
      if (tag === "script") {
        const type = getAttr(node, "type");
        if (type === "application/ld+json") {
          const text = getNodeText(node);
          if (text.length > 0) {
            try {
              const data = JSON.parse(text);
              parseJsonLdNode(data);
            } catch {
              // Ignore invalid JSON-LD
            }
          }
        }
      }
      if (tag === "meta") {
        const prop = (
          getAttr(node, "property") ??
          getAttr(node, "name") ??
          ""
        ).toLowerCase();
        const content = getAttr(node, "content");
        if (content !== undefined && content.length > 0) {
          if (
            (prop === "article:published_time" ||
              prop === "og:published_time") &&
            articlePublishedAt === undefined
          ) {
            articlePublishedAt = content;
          }
          if (
            (prop === "article:modified_time" || prop === "og:updated_time") &&
            articleUpdatedAt === undefined
          ) {
            articleUpdatedAt = content;
          }
          if (prop === "author" && !authors.includes(content)) {
            authors.push(content);
          }
          if (prop === "article:tag" && !categories.includes(content)) {
            categories.push(content);
          }
        }
      }
      if (tag === "time" && visibleDate === undefined) {
        const dt = getAttr(node, "datetime");
        const text = getNodeText(node).trim();
        visibleDate =
          dt !== undefined && dt.length > 0
            ? dt
            : text.length > 0
              ? text
              : undefined;
      }
      const cls = (getAttr(node, "class") ?? "").toLowerCase();
      if (
        visibleDate === undefined &&
        (cls.includes("published-date") ||
          cls.includes("post-date") ||
          cls.includes("article-date"))
      ) {
        const text = getNodeText(node).trim();
        if (text.length > 0) visibleDate = text;
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }

  walk(doc);

  return {
    articlePublishedAt,
    articleUpdatedAt,
    visibleDate,
    authors,
    categories,
    language,
  };
}

export function extractArticleContainerHtml(html: string): string {
  const doc = parse(html);
  let articleNode: DefaultTreeAdapterMap["element"] | undefined;
  let mainNode: DefaultTreeAdapterMap["element"] | undefined;

  function findContainers(node: DefaultTreeAdapterMap["node"]): void {
    if ("tagName" in node) {
      if (node.tagName === "article" && articleNode === undefined) {
        articleNode = node;
      }
      if (node.tagName === "main" && mainNode === undefined) {
        mainNode = node;
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        findContainers(child);
      }
    }
  }

  findContainers(doc);
  const container = articleNode ?? mainNode ?? doc;
  return serialize(container);
}

export async function requestFeed(
  rssUrl: string,
  signal: AbortSignal,
  validators?: {
    readonly etag?: string;
    readonly lastModified?: string;
  },
): Promise<
  | { readonly status: "not-modified" }
  | {
      readonly status: "ok";
      readonly items: readonly ParsedMistralFeedItem[];
      readonly etag?: string;
      readonly lastModified?: string;
    }
> {
  const headers: Record<string, string> = {
    accept:
      "application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain, */*",
    "user-agent": "Binny SourceAdapter/1.0",
  };
  if (validators?.etag !== undefined) {
    headers["if-none-match"] = validators.etag;
  }
  if (validators?.lastModified !== undefined) {
    headers["if-modified-since"] = validators.lastModified;
  }

  const response = await fetch(rssUrl, {
    headers,
    signal,
  });

  if (response.status === 304) {
    return { status: "not-modified" };
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Feed request returned HTTP ${response.status}`);
  }

  const text = await response.text();
  let parsedFeed: ReturnType<typeof parseFeed>;
  try {
    parsedFeed = parseFeed(text);
  } catch (error) {
    throw new Error(
      `Failed to parse RSS XML feed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;

  const items: ParsedMistralFeedItem[] = parsedFeed.items.map((item) => {
    const rawCategories = item.categories ?? [];
    const categories: string[] = rawCategories
      .map((c) =>
        typeof c === "string"
          ? c
          : ((c as { label?: string; term?: string })?.label ??
            (c as { term?: string })?.term ??
            ""),
      )
      .filter((c) => c.length > 0);
    const rawAuthors = item.authors ?? [];
    const authors: string[] = rawAuthors
      .map((a) =>
        typeof a === "string" ? a : ((a as { name?: string })?.name ?? ""),
      )
      .filter((a) => a.length > 0);

    return {
      id: item.id ?? item.url ?? "",
      title: item.title ?? "",
      url: item.url ?? item.id ?? "",
      published: rawFeedDate(item, ["pubdate", "published", "issued", "date"]),
      updated: rawFeedDate(item, ["updated", "modified"]),
      description: item.description ?? null,
      categories,
      authors,
    };
  });

  return {
    status: "ok",
    items,
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  };
}

export async function fetchArticleHtml(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,*/*",
      "user-agent": "Binny SourceAdapter/1.0",
    },
    signal,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Article fetch returned HTTP ${response.status}`);
  }

  return await response.text();
}

async function processAndSubmitArticle(
  context: SourceAdapterContext<MistralConfig, never, MistralExtensions>,
  articleUrl: string,
  feedItem?: ParsedMistralFeedItem,
): Promise<{
  readonly key: string;
  readonly submitResult: SubmitCleanedArticleResult;
}> {
  const articleHtml = await fetchArticleHtml(articleUrl, context.signal);
  const articleMeta = extractArticleMetadata(articleHtml);
  const containerHtml = extractArticleContainerHtml(articleHtml);

  const cleanResult = cleanContent(containerHtml, {
    format: "html",
    baseUrl: articleUrl,
    customDropElement: isMistralDropElement,
  });

  if (!cleanResult.hasSubstantialContent) {
    throw new Error(
      `Article HTML at ${articleUrl} yielded empty body after cleaning.`,
    );
  }

  const key = extractSlugOrGuid(articleUrl, feedItem?.id);
  const feedPublishedAt = feedItem?.published ?? undefined;

  const allCategories = [
    ...new Set([...(feedItem?.categories ?? []), ...articleMeta.categories]),
  ];
  const allAuthors = [
    ...new Set([...(feedItem?.authors ?? []), ...articleMeta.authors]),
  ];

  const extensions: MistralExtensions = {
    region: "international",
    language: articleMeta.language ?? "en",
    categories: allCategories,
    authors: allAuthors,
    ...(feedItem?.description ? { rssDescription: feedItem.description } : {}),
  };

  const title = feedItem?.title?.trim() || null;

  const submitResult = await submitCleanedArticle(context, {
    sourceKey: { namespace: "mistral:news", key },
    sourceRef: articleUrl,
    title,
    sourcePublishedAt: sourceTimeFrom(
      articleMeta.articlePublishedAt ??
        articleMeta.visibleDate ??
        feedPublishedAt,
    ),
    sourceModifiedAt: sourceTimeFrom(articleMeta.articleUpdatedAt),
    extensions,
    cleanResult,
    captureScope: {
      scope: "news",
      feedUrl: context.config.rssUrl,
      slug: key,
    },
  });

  return { key, submitResult };
}

function failureFromProblems(
  actionName: string,
  problems: readonly {
    readonly key?: string;
    readonly message: string;
    readonly path?: readonly (string | number)[];
  }[],
  completedScopes: readonly string[] = [],
): SourceAdapterActionError {
  const examples = problems
    .slice(0, 5)
    .map((p) => (p.key ? `[${p.key}] ${p.message}` : p.message));
  const more =
    problems.length > examples.length
      ? ` (and ${problems.length - examples.length} more)`
      : "";

  return sourceAdapterActionError(
    {
      code: "mistral_action_incomplete",
      message: `Mistral News ${actionName} failed: ${examples.join("; ")}${more}`,
      impact:
        "One or more articles failed to fetch or extract; items were not archived.",
      suggestion:
        "Check network connectivity and article HTML structure, then retry.",
      requiresHuman: false,
    },
    completedScopes,
  );
}

async function checkMistralNews(
  context: SourceAdapterContext<MistralConfig, never, MistralExtensions>,
  params: MistralParams,
): Promise<z.infer<typeof checkOutputSchema>> {
  let feedResult: Awaited<ReturnType<typeof requestFeed>>;
  try {
    feedResult = await requestFeed(context.config.rssUrl, context.signal);
  } catch (error) {
    return {
      availability: "unavailable",
      scope: ["news"],
      basis: "Mistral News RSS feed could not be fetched or parsed.",
      problems: [
        {
          code: "mistral_feed_unavailable",
          message: error instanceof Error ? error.message : String(error),
          impact: "Cannot discover articles from Mistral News RSS feed.",
          path: ["rssUrl"],
          suggestion:
            "Verify network access to mistral.ai and valid RSS XML response.",
          requiresHuman: false,
        },
      ],
    };
  }

  if (feedResult.status !== "ok" || feedResult.items.length === 0) {
    return {
      availability: "unavailable",
      scope: ["news"],
      basis: "Mistral News RSS feed contained no items.",
      problems: [
        {
          code: "mistral_feed_empty",
          message: "RSS feed contains zero items.",
          impact: "No articles to discover or check.",
          path: ["rssUrl"],
          suggestion:
            "Check if the feed URL is active and contains news items.",
          requiresHuman: false,
        },
      ],
    };
  }

  // Pick sample item to validate HTML body extraction
  const targetUrl = params.itemUrls?.[0] ?? feedResult.items[0]?.url;

  if (!targetUrl) {
    return {
      availability: "unavailable",
      scope: ["news"],
      basis: "No article URL available to validate.",
      problems: [
        {
          code: "mistral_no_sample",
          message: "Could not find a valid article URL to check.",
          impact: "Cannot validate article body extraction.",
          suggestion:
            "Provide an itemUrl in params or ensure feed items have valid URLs.",
          requiresHuman: false,
        },
      ],
    };
  }

  try {
    const articleHtml = await fetchArticleHtml(targetUrl, context.signal);
    const containerHtml = extractArticleContainerHtml(articleHtml);
    const cleanResult = cleanContent(containerHtml, {
      format: "html",
      baseUrl: targetUrl,
      customDropElement: isMistralDropElement,
    });

    if (!cleanResult.hasSubstantialContent) {
      return {
        availability: "unavailable",
        scope: ["news"],
        basis: "Sample article HTML body extraction yielded empty content.",
        problems: [
          {
            code: "mistral_empty_body",
            message: `Article at ${targetUrl} yielded no substantial text.`,
            impact: "Article extraction would fail during collection.",
            path: ["items", targetUrl],
            suggestion:
              "Verify that mistral.ai article page structure matches selectors.",
            requiresHuman: false,
          },
        ],
      };
    }
  } catch (error) {
    return {
      availability: "unavailable",
      scope: ["news"],
      basis: "Sample article HTML fetch or extraction failed.",
      problems: [
        {
          code: "mistral_article_failed",
          message: error instanceof Error ? error.message : String(error),
          impact: "Cannot read full article text from sample page.",
          path: ["items", targetUrl],
          suggestion: "Check article URL reachability and HTTP status.",
          requiresHuman: false,
        },
      ],
    };
  }

  return {
    availability: "available",
    scope: ["news"],
    basis:
      "Successfully fetched RSS feed and validated full-text article extraction on sample item.",
    problems: [],
  };
}

async function syncMistralNews(
  context: SourceAdapterContext<MistralConfig, never, MistralExtensions>,
  params: MistralParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  const state = await loadIncrementalSyncState(context);
  const isInitialized = isIncrementalScopeInitialized(state, "news");
  const scopeState = state.scopes["news"];

  let feedResult: Awaited<ReturnType<typeof requestFeed>>;
  try {
    feedResult = await requestFeed(
      context.config.rssUrl,
      context.signal,
      isInitialized && scopeState
        ? {
            ...(scopeState.etag !== undefined ? { etag: scopeState.etag } : {}),
            ...(scopeState.lastModified !== undefined
              ? { lastModified: scopeState.lastModified }
              : {}),
          }
        : undefined,
    );
  } catch (error) {
    throw failureFromProblems("sync", [
      {
        message: `RSS feed request failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]);
  }

  if (feedResult.status === "not-modified") {
    return { completedScopes: ["news"] };
  }

  const items = feedResult.items;

  // 1. Initial sync: establish baseline without fetching historical article HTML pages
  if (!isInitialized) {
    const entries: Record<string, IncrementalEntryRecord> = {};
    for (const item of items) {
      const itemUrl = item.url || item.id;
      if (!itemUrl) continue;
      const key = extractSlugOrGuid(itemUrl, item.id);
      const fingerprint = computeFeedFingerprint(item);
      entries[key] = {
        fingerprint,
        ...(item.published ? { publishedAt: item.published } : {}),
        ...(item.updated ? { updatedAt: item.updated } : {}),
        archivedCompleteness: "baseline",
      };
    }

    initializeIncrementalScope(state, "news", {
      scopeUrl: context.config.rssUrl,
      initializedAt: context.referenceTime,
      etag: feedResult.etag,
      lastModified: feedResult.lastModified,
      entries,
    });
    await saveIncrementalSyncState(context, state);

    return {
      completedScopes: ["news"],
      initializedScopes: ["news"],
    };
  }

  // 2. Subsequent sync: fetch and archive only new or modified items
  const problems: { key?: string; message: string }[] = [];
  let candidateItems = items;
  if (params.maxItems !== undefined && params.maxItems > 0) {
    candidateItems = candidateItems.slice(0, params.maxItems);
  }

  for (const item of candidateItems) {
    const itemUrl = item.url || item.id;
    if (!itemUrl) continue;
    const key = extractSlugOrGuid(itemUrl, item.id);
    const fingerprint = computeFeedFingerprint(item);
    const previous = scopeState?.entries[key];

    const hasChanged = hasIncrementalEntryChanged(
      previous,
      fingerprint,
      item.updated ?? undefined,
    );

    if (!hasChanged) {
      continue;
    }

    try {
      const { submitResult } = await processAndSubmitArticle(
        context,
        itemUrl,
        item,
      );

      upsertIncrementalScopeEntry(state, "news", key, {
        fingerprint,
        ...(item.published ? { publishedAt: item.published } : {}),
        ...(item.updated ? { updatedAt: item.updated } : {}),
        archivedCompleteness: submitResult.hasMediaFailures
          ? "partial"
          : "complete",
      });
      await saveIncrementalSyncState(context, state);
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push({
        key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems("sync", problems);
  }

  updateIncrementalScopeValidators(state, "news", {
    etag: feedResult.etag,
    lastModified: feedResult.lastModified,
  });
  await saveIncrementalSyncState(context, state);

  return { completedScopes: ["news"] };
}

async function collectMistralNews(
  context: SourceAdapterContext<MistralConfig, never, MistralExtensions>,
  params: MistralParams,
): Promise<z.infer<typeof collectOutputSchema>> {
  let targetItems: {
    url: string;
    feedItem?: ParsedMistralFeedItem;
  }[] = [];

  if (params.itemUrls !== undefined && params.itemUrls.length > 0) {
    let feedItems: readonly ParsedMistralFeedItem[] = [];
    try {
      const feedResult = await requestFeed(
        context.config.rssUrl,
        context.signal,
      );
      if (feedResult.status === "ok") {
        feedItems = feedResult.items;
      }
    } catch {
      // Feed fetch failure is non-fatal when explicit itemUrls are provided
    }

    targetItems = params.itemUrls.map((url) => {
      const feedItem = feedItems.find(
        (item) => item.url === url || item.id === url,
      );
      return { url, ...(feedItem !== undefined ? { feedItem } : {}) };
    });
  } else {
    let feedResult: Awaited<ReturnType<typeof requestFeed>>;
    try {
      feedResult = await requestFeed(context.config.rssUrl, context.signal);
    } catch (error) {
      throw failureFromProblems("collect", [
        {
          message: `RSS feed request failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    }

    if (feedResult.status !== "ok") {
      throw failureFromProblems("collect", [
        { message: "RSS feed returned not-modified during collect." },
      ]);
    }

    let items = feedResult.items;
    if (params.maxItems !== undefined && params.maxItems > 0) {
      items = items.slice(0, params.maxItems);
    }

    targetItems = items.map((item) => ({
      url: item.url || item.id,
      feedItem: item,
    }));
  }

  const problems: { key?: string; message: string }[] = [];
  let state: IncrementalSyncState | undefined;
  try {
    if (context.persistentState !== undefined) {
      state = await loadIncrementalSyncState(context);
    }
  } catch {
    // If state load fails during collect, proceed without updating state
  }

  for (const target of targetItems) {
    if (!target.url) continue;
    const key = extractSlugOrGuid(target.url, target.feedItem?.id);
    try {
      const { submitResult } = await processAndSubmitArticle(
        context,
        target.url,
        target.feedItem,
      );

      if (state !== undefined && isIncrementalScopeInitialized(state, "news")) {
        const fingerprint = target.feedItem
          ? computeFeedFingerprint(target.feedItem)
          : (state.scopes["news"]?.entries[key]?.fingerprint ??
            "collect-direct");
        upsertIncrementalScopeEntry(state, "news", key, {
          fingerprint,
          ...(target.feedItem?.published
            ? { publishedAt: target.feedItem.published }
            : {}),
          ...(target.feedItem?.updated
            ? { updatedAt: target.feedItem.updated }
            : {}),
          archivedCompleteness: submitResult.hasMediaFailures
            ? "partial"
            : "complete",
        });
        await saveIncrementalSyncState(context, state);
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push({
        key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems("collect", problems);
  }

  return { completedScopes: ["news"] };
}

export const sourceAdapter = defineSourceAdapter({
  id: "mistral",
  version: "0.1.0",
  description: "Mistral News source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Check Mistral News availability and sample article extraction.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: checkMistralNews,
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Collect and archive Mistral News articles.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: collectMistralNews,
    }),
    sync: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Incrementally sync Mistral News articles.",
      params: paramsSchema,
      output: syncOutputSchema,
      execute: syncMistralNews,
    }),
  },
});
