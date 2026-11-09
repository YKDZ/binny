// OpenAI News and Developers Blog source adapter.
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
  upsertIncrementalScopeEntry,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { parseFeed } from "@rowanmanning/feed-parser";
import { z } from "zod";

import {
  computeFingerprint,
  detectOpenAiAccessFailure,
  extractDevelopersBlogArticle,
  extractOpenAiNewsArticle,
  parseDevelopersBlogList,
  prepareMarkdownContent,
  type DevelopersBlogPostListing,
} from "./extractor.ts";

export const scopeIdSchema = z.enum(["news", "developers-blog"]);
export type OpenAIScopeId = z.infer<typeof scopeIdSchema>;

export const newsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    rssUrl: z.string().url().default("https://openai.com/news/rss.xml"),
    userAgent: z
      .string()
      .min(1)
      .default(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
      ),
  })
  .default({
    enabled: true,
    rssUrl: "https://openai.com/news/rss.xml",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  });

export const developersBlogConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    listUrl: z.string().url().default("https://developers.openai.com/blog"),
    preferMarkdown: z.boolean().default(true),
  })
  .default({
    enabled: true,
    listUrl: "https://developers.openai.com/blog",
    preferMarkdown: true,
  });

export const configSchema = z
  .object({
    news: newsConfigSchema,
    developersBlog: developersBlogConfigSchema,
  })
  .default({
    news: {
      enabled: true,
      rssUrl: "https://openai.com/news/rss.xml",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    },
    developersBlog: {
      enabled: true,
      listUrl: "https://developers.openai.com/blog",
      preferMarkdown: true,
    },
  });

export type OpenAIConfig = z.output<typeof configSchema>;

const extensionsSchema = z
  .object({
    region: z
      .string()
      .describe("Geographic region assigned to this OpenAI publication."),
    language: z.string().describe("Language used by the published article."),
    section: z
      .enum(["news", "developers-blog"])
      .describe("OpenAI publication area where the article appeared."),
    categories: z
      .array(z.string())
      .describe("Categories or tags assigned to the article by its source."),
    authors: z
      .array(z.string())
      .describe("Author names shown by the article source."),
  })
  .strict();

type OpenAIExtensions = z.output<typeof extensionsSchema>;

export const paramsSchema = z
  .object({
    scopes: z.array(scopeIdSchema).optional(),
    itemUrls: z.array(z.string().url()).optional(),
    maxItems: z.number().int().positive().optional(),
  })
  .strict();

export type OpenAIActionParams = z.output<typeof paramsSchema>;

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

type Problem = {
  readonly code: string;
  readonly message: string;
  readonly impact: string;
  readonly path?: (string | number)[] | undefined;
  readonly suggestion: string;
  readonly requiresHuman: boolean;
};

function selectedScopes(
  config: OpenAIConfig,
  params: OpenAIActionParams,
): readonly OpenAIScopeId[] {
  if (params.scopes && params.scopes.length > 0) {
    return params.scopes.filter((scope) => {
      if (scope === "news") return config.news.enabled;
      if (scope === "developers-blog") return config.developersBlog.enabled;
      return false;
    });
  }
  const scopes: OpenAIScopeId[] = [];
  if (config.news.enabled) scopes.push("news");
  if (config.developersBlog.enabled) scopes.push("developers-blog");
  return scopes;
}

function getNewsKey(
  item: {
    readonly id?: string | null | undefined;
    readonly url?: string | null | undefined;
  },
  canonicalPath?: string,
): string {
  if (canonicalPath && canonicalPath !== "/") return canonicalPath;
  if (item.url) {
    try {
      const u = new URL(item.url);
      if (u.pathname && u.pathname !== "/") return u.pathname;
    } catch {
      // Ignore URL parsing error
    }
  }
  if (item.id) {
    try {
      const u = new URL(item.id);
      if (u.pathname && u.pathname !== "/") return u.pathname;
    } catch {
      // Non-URL guid
    }
    return item.id;
  }
  return item.url || "unknown";
}

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

type FeedDiscoveryItem = {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly published?: string | undefined;
  readonly updated?: string | undefined;
  readonly categories?: readonly string[] | undefined;
};

async function fetchNewsRssItems(
  rssUrl: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<FeedDiscoveryItem[]> {
  const response = await fetch(rssUrl, {
    headers: {
      "User-Agent": userAgent,
      Accept: "application/rss+xml, application/xml, text/xml, */*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal,
  });

  if (response.status !== 200) {
    throw new Error(
      `OpenAI News RSS feed request returned HTTP ${response.status}`,
    );
  }

  const xmlText = await response.text();
  const parsed = parseFeed(xmlText);

  return parsed.items.map((rawItem) => {
    const item = rawItem.toJSON();
    return {
      id: item.id || undefined,
      url: item.url || undefined,
      title: item.title || undefined,
      published: rawFeedDate(rawItem, [
        "pubdate",
        "published",
        "issued",
        "date",
      ]),
      updated: rawFeedDate(rawItem, ["updated", "modified"]),
      categories: item.categories
        ? item.categories
            .map((c) => (typeof c === "string" ? c : (c.label ?? c.term)))
            .filter((v): v is string => typeof v === "string" && v.length > 0)
        : undefined,
    };
  });
}

type NewsArticleArchiveResult =
  | {
      readonly ok: true;
      readonly key: string;
      readonly hasMediaFailures: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

async function fetchAndArchiveNewsArticle(
  context: SourceAdapterContext<OpenAIConfig, never, OpenAIExtensions>,
  feedItem: FeedDiscoveryItem,
  articleUrl: string,
): Promise<NewsArticleArchiveResult> {
  const userAgent = context.config.news.userAgent;
  const newsHeaders = {
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  let response: Response;
  try {
    response = await fetch(articleUrl, {
      headers: newsHeaders,
      signal: context.signal,
    });
  } catch (error) {
    return {
      ok: false,
      code: "openai_news_challenge_or_forbidden",
      message: `Failed to request article at ${articleUrl}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const html = await response.text();
  const accessFailure = detectOpenAiAccessFailure(response, html, articleUrl);
  if (accessFailure.failed) {
    return {
      ok: false,
      code: accessFailure.code,
      message: accessFailure.message,
    };
  }

  const extracted = extractOpenAiNewsArticle(html, articleUrl);
  if (!extracted) {
    return {
      ok: false,
      code: "openai_news_body_unavailable",
      message: `OpenAI article body container could not be found for ${articleUrl}`,
    };
  }

  const cleanResult = cleanContent(extracted.bodyHtml, {
    format: "html",
    baseUrl: articleUrl,
  });

  if (
    !cleanResult.hasSubstantialContent &&
    cleanResult.text.trim().length === 0
  ) {
    return {
      ok: false,
      code: "openai_news_body_unavailable",
      message: `Cleaned OpenAI article body is empty for ${articleUrl}`,
    };
  }

  const key = getNewsKey(feedItem, extracted.canonicalPath);
  const publishedAt = extracted.publishedAt;
  const updatedAt = extracted.updatedAt;
  const feedPublishedAt = feedItem.published;

  const submitResult = await submitCleanedArticle(context, {
    sourceKey: { namespace: "openai:news", key },
    sourceRef: articleUrl,
    title: feedItem.title || extracted.title || null,
    sourcePublishedAt: sourceTimeFrom(publishedAt ?? feedPublishedAt),
    sourceModifiedAt: sourceTimeFrom(updatedAt),
    extensions: {
      region: "international",
      language: "en",
      section: "news",
      categories: [...(feedItem.categories ?? extracted.categories)],
      authors: [...extracted.authors],
    },
    cleanResult,
    captureScope: {
      scope: "news",
      format: "html",
    },
    mediaOptions: {
      userAgent,
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
  });

  return {
    ok: true,
    key,
    hasMediaFailures: submitResult.hasMediaFailures,
  };
}

async function fetchDevelopersBlogList(
  listUrl: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<DevelopersBlogPostListing[]> {
  const response = await fetch(listUrl, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal,
  });

  if (response.status !== 200) {
    throw new Error(
      `Developers blog list request returned HTTP ${response.status}`,
    );
  }

  const html = await response.text();
  return parseDevelopersBlogList(html, listUrl);
}

type DevelopersBlogArchiveResult =
  | {
      readonly ok: true;
      readonly key: string;
      readonly hasMediaFailures: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

async function fetchAndArchiveDevelopersBlogArticle(
  context: SourceAdapterContext<OpenAIConfig, never, OpenAIExtensions>,
  listing: DevelopersBlogPostListing,
): Promise<DevelopersBlogArchiveResult> {
  const userAgent = context.config.news.userAgent;
  const preferMarkdown = context.config.developersBlog.preferMarkdown;

  let rawBody: string | undefined;
  let isMarkdown = false;
  let pageTitle = listing.title;
  let pageDate = listing.publishedDate;
  let pageAuthors = [...listing.authors];
  let pageCategories = [...listing.categories];

  if (preferMarkdown) {
    const mdUrl = `${listing.url}.md`;
    try {
      const mdResponse = await fetch(mdUrl, {
        headers: {
          "User-Agent": userAgent,
          Accept: "text/markdown, text/plain, */*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: context.signal,
      });

      if (mdResponse.status === 200) {
        const contentType = (
          mdResponse.headers.get("content-type") ?? ""
        ).toLowerCase();
        const text = await mdResponse.text();
        if (
          !contentType.includes("text/html") &&
          !text.trim().startsWith("<!doctype html") &&
          !text.trim().startsWith("<html")
        ) {
          rawBody = text;
          isMarkdown = true;
        }
      }
    } catch {
      // Fallback to HTML
    }
  }

  if (rawBody === undefined) {
    let htmlResponse: Response;
    try {
      htmlResponse = await fetch(listing.url, {
        headers: {
          "User-Agent": userAgent,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: context.signal,
      });
    } catch (error) {
      return {
        ok: false,
        code: "openai_developers_blog_body_unavailable",
        message: `Failed to request developers blog at ${listing.url}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (htmlResponse.status !== 200) {
      return {
        ok: false,
        code: "openai_developers_blog_body_unavailable",
        message: `Developers blog article request returned HTTP ${htmlResponse.status}`,
      };
    }

    const html = await htmlResponse.text();
    const extracted = extractDevelopersBlogArticle(html, listing.url);
    if (!extracted) {
      return {
        ok: false,
        code: "openai_developers_blog_body_unavailable",
        message: `Developers blog body container could not be found for ${listing.url}`,
      };
    }

    rawBody = extracted.bodyHtml;
    isMarkdown = false;
    if (!pageTitle && extracted.title) pageTitle = extracted.title;
    if (!pageDate && extracted.publishedDate)
      pageDate = extracted.publishedDate;
    if (pageAuthors.length === 0 && extracted.authors.length > 0) {
      pageAuthors = [...extracted.authors];
    }
    if (pageCategories.length === 0 && extracted.categories.length > 0) {
      pageCategories = [...extracted.categories];
    }
  }

  const bodyForCleaning = isMarkdown
    ? prepareMarkdownContent(rawBody)
    : rawBody;
  const cleanResult = cleanContent(bodyForCleaning, {
    format: isMarkdown ? "markdown" : "html",
    baseUrl: listing.url,
  });

  if (
    !cleanResult.hasSubstantialContent &&
    cleanResult.text.trim().length === 0
  ) {
    return {
      ok: false,
      code: "openai_developers_blog_body_unavailable",
      message: `Cleaned developers blog body is empty for ${listing.url}`,
    };
  }

  const submitResult = await submitCleanedArticle(context, {
    sourceKey: { namespace: "openai:developers-blog", key: listing.slug },
    sourceRef: listing.url,
    title: pageTitle ?? null,
    sourcePublishedAt: sourceTimeFrom(pageDate),
    sourceModifiedAt: null,
    extensions: {
      region: "international",
      language: "en",
      section: "developers-blog",
      categories: pageCategories,
      authors: pageAuthors,
    },
    cleanResult,
    captureScope: {
      scope: "developers-blog",
      format: isMarkdown ? "markdown" : "html",
    },
    mediaOptions: {
      userAgent,
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
  });

  return {
    ok: true,
    key: listing.slug,
    hasMediaFailures: submitResult.hasMediaFailures,
  };
}

export const sourceAdapter = defineSourceAdapter({
  id: "openai",
  version: "0.1.0",
  description: "OpenAI News and Developers Blog source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Check availability of OpenAI News and Developers Blog sources.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: async (context, params) => {
        const scopes = selectedScopes(context.config, params);
        const problems: Problem[] = [];

        for (const scope of scopes) {
          if (context.signal.aborted) throw context.signal.reason;

          if (scope === "news") {
            let feedItems: FeedDiscoveryItem[];
            try {
              feedItems = await fetchNewsRssItems(
                context.config.news.rssUrl,
                context.config.news.userAgent,
                context.signal,
              );
            } catch (error) {
              problems.push({
                code: "openai_news_rss_unavailable",
                message: `Failed to fetch OpenAI News RSS feed: ${error instanceof Error ? error.message : String(error)}`,
                impact: "Cannot discover new articles from OpenAI News.",
                path: ["news", "rssUrl"],
                suggestion:
                  "Check OpenAI network reachability or user agent configuration.",
                requiresHuman: false,
              });
              continue;
            }

            if (feedItems.length === 0) {
              problems.push({
                code: "openai_news_no_items",
                message: "OpenAI News RSS feed returned 0 items.",
                impact: "No articles found to check.",
                path: ["news", "rssUrl"],
                suggestion: "Verify that the RSS URL provides valid items.",
                requiresHuman: false,
              });
              continue;
            }

            const candidateItem =
              params.itemUrls && params.itemUrls.length > 0
                ? (feedItems.find(
                    (item) => item.url && params.itemUrls?.includes(item.url),
                  ) ?? feedItems[0]!)
                : feedItems[0]!;

            if (!candidateItem.url) {
              problems.push({
                code: "openai_news_body_unavailable",
                message: "First RSS item has no article link.",
                impact: "Cannot check article extraction.",
                path: ["news", "rssUrl"],
                suggestion: "Verify that feed items contain valid URL links.",
                requiresHuman: false,
              });
              continue;
            }

            let response: Response;
            try {
              response = await fetch(candidateItem.url, {
                headers: {
                  "User-Agent": context.config.news.userAgent,
                  Accept:
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                  "Accept-Language": "en-US,en;q=0.9",
                },
                signal: context.signal,
              });
            } catch (error) {
              problems.push({
                code: "openai_news_challenge_or_forbidden",
                message: `Failed to fetch OpenAI News article HTML: ${error instanceof Error ? error.message : String(error)}`,
                impact: "Cannot access OpenAI News article page.",
                path: ["news", candidateItem.url],
                suggestion:
                  "Check network connectivity or Cloudflare challenge.",
                requiresHuman: false,
              });
              continue;
            }

            const html = await response.text();
            const failure = detectOpenAiAccessFailure(
              response,
              html,
              candidateItem.url,
            );
            if (failure.failed) {
              problems.push({
                code: failure.code,
                message: failure.message,
                impact:
                  "OpenAI News article is blocked by Cloudflare challenge or forbidden response.",
                path: ["news", candidateItem.url],
                suggestion:
                  "Inspect Cloudflare mitigation rules or verify user agent.",
                requiresHuman: false,
              });
              continue;
            }

            const extracted = extractOpenAiNewsArticle(html, candidateItem.url);
            if (!extracted) {
              problems.push({
                code: "openai_news_body_unavailable",
                message:
                  "OpenAI News article body container could not be found.",
                impact: "Cannot extract article content from layout.",
                path: ["news", candidateItem.url],
                suggestion: "Update article body selector to match new layout.",
                requiresHuman: false,
              });
              continue;
            }

            const cleanResult = cleanContent(extracted.bodyHtml, {
              format: "html",
              baseUrl: candidateItem.url,
            });
            if (
              !cleanResult.hasSubstantialContent &&
              cleanResult.text.trim().length === 0
            ) {
              problems.push({
                code: "openai_news_body_unavailable",
                message:
                  "Extracted article body has empty text after cleaning.",
                impact: "Article would be archived without readable content.",
                path: ["news", candidateItem.url],
                suggestion: "Check content cleaning rules for OpenAI News.",
                requiresHuman: false,
              });
            }
          }

          if (scope === "developers-blog") {
            let blogItems: DevelopersBlogPostListing[];
            try {
              blogItems = await fetchDevelopersBlogList(
                context.config.developersBlog.listUrl,
                context.config.news.userAgent,
                context.signal,
              );
            } catch (error) {
              problems.push({
                code: "openai_developers_blog_list_unavailable",
                message: `Failed to fetch OpenAI Developers Blog list: ${error instanceof Error ? error.message : String(error)}`,
                impact: "Cannot discover blog posts.",
                path: ["developersBlog", "listUrl"],
                suggestion:
                  "Check network reachability for developers.openai.com/blog.",
                requiresHuman: false,
              });
              continue;
            }

            if (blogItems.length === 0) {
              problems.push({
                code: "openai_developers_blog_no_items",
                message: "OpenAI Developers Blog list page returned 0 posts.",
                impact: "No blog posts found to check.",
                path: ["developersBlog", "listUrl"],
                suggestion: "Verify developers.openai.com/blog page structure.",
                requiresHuman: false,
              });
              continue;
            }

            const candidatePost =
              params.itemUrls && params.itemUrls.length > 0
                ? (blogItems.find((item) =>
                    params.itemUrls?.includes(item.url),
                  ) ?? blogItems[0]!)
                : blogItems[0]!;

            let rawBody: string | undefined;
            let isMarkdown = false;

            if (context.config.developersBlog.preferMarkdown) {
              try {
                const mdResponse = await fetch(`${candidatePost.url}.md`, {
                  headers: {
                    "User-Agent": context.config.news.userAgent,
                    Accept: "text/markdown, text/plain, */*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                  },
                  signal: context.signal,
                });
                if (mdResponse.status === 200) {
                  const contentType = (
                    mdResponse.headers.get("content-type") ?? ""
                  ).toLowerCase();
                  const text = await mdResponse.text();
                  if (
                    !contentType.includes("text/html") &&
                    !text.trim().startsWith("<!doctype html") &&
                    !text.trim().startsWith("<html")
                  ) {
                    rawBody = text;
                    isMarkdown = true;
                  }
                }
              } catch {
                // Fallback to HTML
              }
            }

            if (rawBody === undefined) {
              let htmlResponse: Response;
              try {
                htmlResponse = await fetch(candidatePost.url, {
                  headers: {
                    "User-Agent": context.config.news.userAgent,
                    Accept:
                      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                  },
                  signal: context.signal,
                });
              } catch (error) {
                problems.push({
                  code: "openai_developers_blog_body_unavailable",
                  message: `Failed to fetch Developers blog HTML: ${error instanceof Error ? error.message : String(error)}`,
                  impact: "Cannot access Developers blog post.",
                  path: ["developersBlog", candidatePost.url],
                  suggestion: "Check network connectivity.",
                  requiresHuman: false,
                });
                continue;
              }

              if (htmlResponse.status !== 200) {
                problems.push({
                  code: "openai_developers_blog_body_unavailable",
                  message: `Developers blog article request returned HTTP ${htmlResponse.status}`,
                  impact: "Blog post cannot be fetched.",
                  path: ["developersBlog", candidatePost.url],
                  suggestion: "Verify post URL.",
                  requiresHuman: false,
                });
                continue;
              }

              const html = await htmlResponse.text();
              const extracted = extractDevelopersBlogArticle(
                html,
                candidatePost.url,
              );
              if (!extracted) {
                problems.push({
                  code: "openai_developers_blog_body_unavailable",
                  message: "Developers blog body container could not be found.",
                  impact: "Cannot extract blog content.",
                  path: ["developersBlog", candidatePost.url],
                  suggestion:
                    "Update selectors for developers.openai.com/blog layout.",
                  requiresHuman: false,
                });
                continue;
              }
              rawBody = extracted.bodyHtml;
            }

            const bodyForCleaning = isMarkdown
              ? prepareMarkdownContent(rawBody)
              : rawBody;
            const cleanResult = cleanContent(bodyForCleaning, {
              format: isMarkdown ? "markdown" : "html",
              baseUrl: candidatePost.url,
            });
            if (
              !cleanResult.hasSubstantialContent &&
              cleanResult.text.trim().length === 0
            ) {
              problems.push({
                code: "openai_developers_blog_body_unavailable",
                message: "Cleaned developers blog body is empty.",
                impact: "Blog post would be archived without readable content.",
                path: ["developersBlog", candidatePost.url],
                suggestion: "Check cleaning rules for developers blog.",
                requiresHuman: false,
              });
            }
          }
        }

        return {
          availability:
            problems.length === 0
              ? ("available" as const)
              : ("unavailable" as const),
          scope: [...scopes],
          basis:
            problems.length === 0
              ? "All checked OpenAI scopes are accessible and articles can be extracted."
              : "One or more OpenAI scopes encountered errors or access restrictions.",
          problems,
        };
      },
    }),

    sync: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Incrementally synchronize OpenAI News and Developers Blog articles.",
      params: paramsSchema,
      output: syncOutputSchema,
      execute: async (context, params) => {
        const scopes = selectedScopes(context.config, params);
        const state = await loadIncrementalSyncState(context);
        const completedScopes: string[] = [];
        const initializedScopes: string[] = [];
        const problems: Problem[] = [];

        for (const scope of scopes) {
          if (context.signal.aborted) throw context.signal.reason;

          const scopeUrl =
            scope === "news"
              ? context.config.news.rssUrl
              : context.config.developersBlog.listUrl;
          const isInitialized = isIncrementalScopeInitialized(
            state,
            scope,
            scopeUrl,
          );

          if (!isInitialized) {
            // Initial sync: establish baseline without fetching article details
            if (scope === "news") {
              let feedItems: FeedDiscoveryItem[];
              try {
                feedItems = await fetchNewsRssItems(
                  context.config.news.rssUrl,
                  context.config.news.userAgent,
                  context.signal,
                );
              } catch (error) {
                problems.push({
                  code: "openai_news_rss_unavailable",
                  message: `Initial sync failed to fetch RSS feed: ${error instanceof Error ? error.message : String(error)}`,
                  impact: "News scope baseline could not be established.",
                  path: ["news", "rssUrl"],
                  suggestion: "Check network connectivity to OpenAI News RSS.",
                  requiresHuman: false,
                });
                continue;
              }

              const baselineEntries: Record<
                string,
                z.infer<
                  typeof incrementalSyncStateSchema
                >["scopes"][string]["entries"][string]
              > = {};
              for (const item of feedItems) {
                const key = getNewsKey(item);
                const fingerprint = computeFingerprint({
                  id: item.id,
                  url: item.url,
                  title: item.title,
                  published: item.published,
                  updated: item.updated,
                  categories: item.categories,
                });
                baselineEntries[key] = {
                  fingerprint,
                  ...(item.updated ? { updatedAt: item.updated } : {}),
                  ...(item.published ? { publishedAt: item.published } : {}),
                  archivedCompleteness: "baseline",
                };
              }

              initializeIncrementalScope(state, scope, {
                scopeUrl,
                initializedAt: context.referenceTime,
                entries: baselineEntries,
              });
              await saveIncrementalSyncState(context, state);
              completedScopes.push(scope);
              initializedScopes.push(scope);
            }

            if (scope === "developers-blog") {
              let blogItems: DevelopersBlogPostListing[];
              try {
                blogItems = await fetchDevelopersBlogList(
                  context.config.developersBlog.listUrl,
                  context.config.news.userAgent,
                  context.signal,
                );
              } catch (error) {
                problems.push({
                  code: "openai_developers_blog_list_unavailable",
                  message: `Initial sync failed to fetch blog list: ${error instanceof Error ? error.message : String(error)}`,
                  impact:
                    "Developers blog scope baseline could not be established.",
                  path: ["developersBlog", "listUrl"],
                  suggestion:
                    "Check network connectivity to developers.openai.com/blog.",
                  requiresHuman: false,
                });
                continue;
              }

              const baselineEntries: Record<
                string,
                z.infer<
                  typeof incrementalSyncStateSchema
                >["scopes"][string]["entries"][string]
              > = {};
              for (const item of blogItems) {
                const key = item.slug;
                const fingerprint = computeFingerprint({
                  slug: item.slug,
                  url: item.url,
                  title: item.title,
                  publishedDate: item.publishedDate,
                  categories: item.categories,
                  authors: item.authors,
                });
                baselineEntries[key] = {
                  fingerprint,
                  ...(item.publishedDate
                    ? { publishedAt: item.publishedDate }
                    : {}),
                  archivedCompleteness: "baseline",
                };
              }

              initializeIncrementalScope(state, scope, {
                scopeUrl,
                initializedAt: context.referenceTime,
                entries: baselineEntries,
              });
              await saveIncrementalSyncState(context, state);
              completedScopes.push(scope);
              initializedScopes.push(scope);
            }

            continue;
          }

          // Subsequent sync: incremental archiving of new or changed items
          const scopeState = state.scopes[scope]!;
          let scopeFailed = false;

          if (scope === "news") {
            let feedItems: FeedDiscoveryItem[];
            try {
              feedItems = await fetchNewsRssItems(
                context.config.news.rssUrl,
                context.config.news.userAgent,
                context.signal,
              );
            } catch (error) {
              problems.push({
                code: "openai_news_rss_unavailable",
                message: `Subsequent sync failed to fetch RSS feed: ${error instanceof Error ? error.message : String(error)}`,
                impact: "Could not discover new articles.",
                path: ["news", "rssUrl"],
                suggestion: "Check network connectivity.",
                requiresHuman: false,
              });
              continue;
            }

            for (const item of feedItems) {
              if (context.signal.aborted) throw context.signal.reason;
              if (!item.url) continue;

              const key = getNewsKey(item);
              const fingerprint = computeFingerprint({
                id: item.id,
                url: item.url,
                title: item.title,
                published: item.published,
                updated: item.updated,
                categories: item.categories,
              });

              const previousEntry = scopeState.entries[key];
              if (
                !hasIncrementalEntryChanged(
                  previousEntry,
                  fingerprint,
                  item.updated,
                )
              ) {
                continue;
              }

              const archiveResult = await fetchAndArchiveNewsArticle(
                context,
                item,
                item.url,
              );
              if (!archiveResult.ok) {
                scopeFailed = true;
                problems.push({
                  code: archiveResult.code,
                  message: `Article ${item.url} sync failed: ${archiveResult.message}`,
                  impact:
                    "Item was not archived and incremental state was not advanced for it.",
                  path: ["news", item.url],
                  suggestion: "Check access restrictions or Cloudflare status.",
                  requiresHuman: false,
                });
                continue;
              }

              upsertIncrementalScopeEntry(state, scope, key, {
                fingerprint,
                ...(item.updated ? { updatedAt: item.updated } : {}),
                ...(item.published ? { publishedAt: item.published } : {}),
                archivedCompleteness: archiveResult.hasMediaFailures
                  ? "partial"
                  : "complete",
              });
              await saveIncrementalSyncState(context, state);
            }
          }

          if (scope === "developers-blog") {
            let blogItems: DevelopersBlogPostListing[];
            try {
              blogItems = await fetchDevelopersBlogList(
                context.config.developersBlog.listUrl,
                context.config.news.userAgent,
                context.signal,
              );
            } catch (error) {
              problems.push({
                code: "openai_developers_blog_list_unavailable",
                message: `Subsequent sync failed to fetch blog list: ${error instanceof Error ? error.message : String(error)}`,
                impact: "Could not discover new blog posts.",
                path: ["developersBlog", "listUrl"],
                suggestion: "Check network connectivity.",
                requiresHuman: false,
              });
              continue;
            }

            for (const item of blogItems) {
              if (context.signal.aborted) throw context.signal.reason;

              const key = item.slug;
              const fingerprint = computeFingerprint({
                slug: item.slug,
                url: item.url,
                title: item.title,
                publishedDate: item.publishedDate,
                categories: item.categories,
                authors: item.authors,
              });

              const previousEntry = scopeState.entries[key];
              if (!hasIncrementalEntryChanged(previousEntry, fingerprint)) {
                continue;
              }

              const archiveResult = await fetchAndArchiveDevelopersBlogArticle(
                context,
                item,
              );
              if (!archiveResult.ok) {
                scopeFailed = true;
                problems.push({
                  code: archiveResult.code,
                  message: `Blog post ${item.url} sync failed: ${archiveResult.message}`,
                  impact:
                    "Item was not archived and incremental state was not advanced for it.",
                  path: ["developersBlog", item.url],
                  suggestion: "Check post availability.",
                  requiresHuman: false,
                });
                continue;
              }

              upsertIncrementalScopeEntry(state, scope, key, {
                fingerprint,
                ...(item.publishedDate
                  ? { publishedAt: item.publishedDate }
                  : {}),
                archivedCompleteness: archiveResult.hasMediaFailures
                  ? "partial"
                  : "complete",
              });
              await saveIncrementalSyncState(context, state);
            }
          }

          if (!scopeFailed) {
            completedScopes.push(scope);
          }
        }

        if (problems.length > 0) {
          throw sourceAdapterActionError(
            {
              code: "openai_sync_incomplete",
              message: `OpenAI sync finished with problems: ${problems.map((p) => p.message).join("; ")}`,
              impact:
                "Some items were not synchronized. Incremental state was not advanced for failed items.",
              suggestion:
                "Check network reachability, Cloudflare challenge, or article selectors and re-run.",
              requiresHuman: false,
            },
            completedScopes,
          );
        }

        return {
          completedScopes,
          ...(initializedScopes.length > 0 ? { initializedScopes } : {}),
        };
      },
    }),

    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Collect and archive OpenAI News and Developers Blog articles.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: async (context, params) => {
        const scopes = selectedScopes(context.config, params);
        const state = await loadIncrementalSyncState(context);
        const completedScopes: string[] = [];
        const problems: Problem[] = [];

        for (const scope of scopes) {
          if (context.signal.aborted) throw context.signal.reason;
          let scopeFailed = false;

          if (scope === "news") {
            let feedItems: FeedDiscoveryItem[];
            try {
              feedItems = await fetchNewsRssItems(
                context.config.news.rssUrl,
                context.config.news.userAgent,
                context.signal,
              );
            } catch (error) {
              problems.push({
                code: "openai_news_rss_unavailable",
                message: `Collect failed to fetch RSS feed: ${error instanceof Error ? error.message : String(error)}`,
                impact: "Could not discover news articles.",
                path: ["news", "rssUrl"],
                suggestion: "Check RSS feed URL or network reachability.",
                requiresHuman: false,
              });
              continue;
            }

            let candidateItems = feedItems;
            if (params.itemUrls && params.itemUrls.length > 0) {
              candidateItems = candidateItems.filter(
                (item) => item.url && params.itemUrls?.includes(item.url),
              );
            }
            if (params.maxItems !== undefined && params.maxItems > 0) {
              candidateItems = candidateItems.slice(0, params.maxItems);
            }

            for (const item of candidateItems) {
              if (context.signal.aborted) throw context.signal.reason;
              if (!item.url) continue;

              const archiveResult = await fetchAndArchiveNewsArticle(
                context,
                item,
                item.url,
              );
              if (!archiveResult.ok) {
                scopeFailed = true;
                problems.push({
                  code: archiveResult.code,
                  message: `Collect failed for ${item.url}: ${archiveResult.message}`,
                  impact: "Item could not be collected.",
                  path: ["news", item.url],
                  suggestion: "Check article URL or Cloudflare mitigation.",
                  requiresHuman: false,
                });
                continue;
              }

              const key = getNewsKey(item);
              const fingerprint = computeFingerprint({
                id: item.id,
                url: item.url,
                title: item.title,
                published: item.published,
                updated: item.updated,
                categories: item.categories,
              });

              upsertIncrementalScopeEntry(state, scope, key, {
                fingerprint,
                ...(item.updated ? { updatedAt: item.updated } : {}),
                ...(item.published ? { publishedAt: item.published } : {}),
                archivedCompleteness: archiveResult.hasMediaFailures
                  ? "partial"
                  : "complete",
              });
              await saveIncrementalSyncState(context, state);
            }
          }

          if (scope === "developers-blog") {
            let blogItems: DevelopersBlogPostListing[];
            try {
              blogItems = await fetchDevelopersBlogList(
                context.config.developersBlog.listUrl,
                context.config.news.userAgent,
                context.signal,
              );
            } catch (error) {
              problems.push({
                code: "openai_developers_blog_list_unavailable",
                message: `Collect failed to fetch developers blog list: ${error instanceof Error ? error.message : String(error)}`,
                impact: "Could not discover blog posts.",
                path: ["developersBlog", "listUrl"],
                suggestion: "Check developers blog list URL.",
                requiresHuman: false,
              });
              continue;
            }

            let candidateItems = blogItems;
            if (params.itemUrls && params.itemUrls.length > 0) {
              candidateItems = candidateItems.filter((item) =>
                params.itemUrls?.includes(item.url),
              );
            }
            if (params.maxItems !== undefined && params.maxItems > 0) {
              candidateItems = candidateItems.slice(0, params.maxItems);
            }

            for (const item of candidateItems) {
              if (context.signal.aborted) throw context.signal.reason;

              const archiveResult = await fetchAndArchiveDevelopersBlogArticle(
                context,
                item,
              );
              if (!archiveResult.ok) {
                scopeFailed = true;
                problems.push({
                  code: archiveResult.code,
                  message: `Collect failed for ${item.url}: ${archiveResult.message}`,
                  impact: "Item could not be collected.",
                  path: ["developersBlog", item.url],
                  suggestion: "Check blog post URL or structure.",
                  requiresHuman: false,
                });
                continue;
              }

              const key = item.slug;
              const fingerprint = computeFingerprint({
                slug: item.slug,
                url: item.url,
                title: item.title,
                publishedDate: item.publishedDate,
                categories: item.categories,
                authors: item.authors,
              });

              upsertIncrementalScopeEntry(state, scope, key, {
                fingerprint,
                ...(item.publishedDate
                  ? { publishedAt: item.publishedDate }
                  : {}),
                archivedCompleteness: archiveResult.hasMediaFailures
                  ? "partial"
                  : "complete",
              });
              await saveIncrementalSyncState(context, state);
            }
          }

          if (!scopeFailed) {
            completedScopes.push(scope);
          }
        }

        if (problems.length > 0) {
          throw sourceAdapterActionError(
            {
              code: "openai_collection_incomplete",
              message: `OpenAI collection finished with problems: ${problems.map((p) => p.message).join("; ")}`,
              impact: "Some items could not be collected.",
              suggestion:
                "Check network reachability, Cloudflare challenge, or article selectors and re-run.",
              requiresHuman: false,
            },
            completedScopes,
          );
        }

        return { completedScopes };
      },
    }),
  },
});
