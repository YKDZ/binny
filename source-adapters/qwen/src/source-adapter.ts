// Source adapter definition for Qwen bilingual research articles.
import { createHash } from "node:crypto";

import {
  cleanContent,
  defineSourceAdapter,
  defineSourceAdapterAction,
  fetchSourceResponse,
  hasIncrementalEntryChanged,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  isSourceAdapterActionError,
  loadIncrementalSyncState,
  readFailureDiagnosticContext,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  sourceTimeFrom,
  submitCleanedArticle,
  upsertIncrementalScopeEntry,
  type FetchedSourceResponse,
  type IncrementalEntryRecord,
  type ManualRunFailure,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

export const qwenLanguageSchema = z.enum(["zh-CN", "en-US"]);
export type QwenLanguage = z.infer<typeof qwenLanguageSchema>;

const defaultQwenConfig = {
  languages: ["zh-CN", "en-US"] as const,
  endpointUrl: "https://qwen.ai/api/v2/article/retrieval",
  articleType: "qwen_ai",
  siteBaseUrl: "https://qwen.ai",
};

export const qwenConfigSchema = z
  .object({
    languages: z
      .array(qwenLanguageSchema)
      .min(1)
      .default([...defaultQwenConfig.languages]),
    endpointUrl: z.string().url().default(defaultQwenConfig.endpointUrl),
    articleType: z.string().min(1).default(defaultQwenConfig.articleType),
    siteBaseUrl: z.string().url().default(defaultQwenConfig.siteBaseUrl),
  })
  .strict()
  .default({
    languages: [...defaultQwenConfig.languages],
    endpointUrl: defaultQwenConfig.endpointUrl,
    articleType: defaultQwenConfig.articleType,
    siteBaseUrl: defaultQwenConfig.siteBaseUrl,
  });

export type QwenConfig = z.infer<typeof qwenConfigSchema>;

export const qwenParamsSchema = z
  .object({
    languages: z.array(qwenLanguageSchema).min(1).optional(),
    paths: z.array(z.string().min(1)).optional(),
    maxItems: z.number().int().positive().optional(),
  })
  .strict()
  .default({});

export type QwenParams = z.infer<typeof qwenParamsSchema>;

const extensionsSchema = z
  .object({
    language: z
      .string()
      .describe("Language of the Qwen article returned for this request."),
    region: z
      .literal("global")
      .describe("Geographic region assigned to the Qwen article."),
    canonicalUrl: z
      .string()
      .optional()
      .describe("Canonical URL linked from the Qwen article content."),
    qwenArticleId: z
      .string()
      .optional()
      .describe("Article identifier returned by the Qwen retrieval API."),
    author: z
      .string()
      .optional()
      .describe("Author name supplied by the Qwen retrieval API."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags supplied by the Qwen retrieval API."),
    gitUrl: z
      .string()
      .optional()
      .describe("Source repository URL supplied by the Qwen retrieval API."),
    coverUrl: z
      .string()
      .optional()
      .describe("Cover image URL supplied by the Qwen retrieval API."),
    introduction: z
      .string()
      .optional()
      .describe("Introduction text supplied by the Qwen retrieval API."),
    description: z
      .string()
      .optional()
      .describe("Description supplied by the Qwen retrieval API."),
  })
  .strict();

type QwenExtensions = z.output<typeof extensionsSchema>;

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

export interface RawQwenExtra {
  readonly date?: string;
  readonly author?: string;
  readonly tags?: readonly string[];
  readonly git_url?: string;
  readonly cover_small?: string;
  readonly introduction?: string;
  readonly description?: string;
  readonly readTime?: number;
  readonly wordCount?: number;
  readonly [key: string]: unknown;
}

export interface RawQwenArticle {
  readonly id?: string;
  readonly path?: string;
  readonly title?: string;
  readonly content?: string;
  readonly language?: string;
  readonly type?: string;
  readonly date?: string;
  readonly extra?: RawQwenExtra;
  readonly [key: string]: unknown;
}

/** Extracts the articles array from Qwen API JSON responses across supported envelope structures. */
export function extractArticles(json: unknown): RawQwenArticle[] | undefined {
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const obj = json as Record<string, unknown>;
  let list: unknown;
  if (Array.isArray(obj.articles)) {
    list = obj.articles;
  } else if (
    typeof obj.data === "object" &&
    obj.data !== null &&
    Array.isArray((obj.data as Record<string, unknown>).articles)
  ) {
    list = (obj.data as Record<string, unknown>).articles;
  } else if (Array.isArray(obj.results)) {
    list = obj.results;
  } else if (Array.isArray(obj.data)) {
    list = obj.data;
  }

  if (!Array.isArray(list)) {
    return undefined;
  }
  return list as RawQwenArticle[];
}

/** Constructs the retrieval endpoint URL for a given language. */
export function buildRetrievalUrl(
  endpointUrl: string,
  articleType: string,
  language: string,
): string {
  const url = new URL(endpointUrl);
  url.searchParams.set("type", articleType);
  url.searchParams.set("language", language);
  return url.toString();
}

/** Constructs the canonical public reading URL on the Qwen site for an article path. */
export function buildArticleReadingUrl(
  siteBaseUrl: string,
  path: string,
): string {
  const base = siteBaseUrl.replace(/\/+$/, "");
  return `${base}/blog?id=${encodeURIComponent(path)}`;
}

/** Extracts embedded canonical link URL from raw HTML content if present. */
export function extractCanonicalUrl(content: string): string | undefined {
  const linkTags = content.match(/<link\b[^>]*>/gi);
  if (!linkTags) return undefined;
  for (const tag of linkTags) {
    if (/\brel=["']?canonical["']?/i.test(tag)) {
      const match = /\bhref=["']?([^"'\s>]+)/i.exec(tag);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return undefined;
}

/** Preserves the source publication date for SourceTime validation at submission. */
export function parseArticleDate(rawDate?: string): {
  readonly publishedDate?: string;
} {
  if (rawDate === undefined || rawDate.trim().length === 0) {
    return {};
  }
  const trimmed = rawDate.trim();
  return {
    publishedDate: trimmed,
  };
}

function qwenExtensions(
  article: RawQwenArticle,
  language: QwenLanguage,
  canonicalUrl: string | undefined,
): QwenExtensions {
  return {
    language,
    region: "global",
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    ...(article.id !== undefined ? { qwenArticleId: article.id } : {}),
    ...(article.extra?.author !== undefined
      ? { author: article.extra.author }
      : {}),
    ...(article.extra?.tags !== undefined
      ? { tags: [...article.extra.tags] }
      : {}),
    ...(article.extra?.git_url !== undefined
      ? { gitUrl: article.extra.git_url }
      : {}),
    ...(article.extra?.cover_small !== undefined
      ? { coverUrl: article.extra.cover_small }
      : {}),
    ...(article.extra?.introduction !== undefined
      ? { introduction: article.extra.introduction }
      : {}),
    ...(article.extra?.description !== undefined
      ? { description: article.extra.description }
      : {}),
  };
}

/** Computes a SHA-256 fingerprint from title, date, cleaned markdown, and cleaned text. */
export function computeArticleFingerprint(
  title: string,
  date: string,
  cleanedMarkdown: string,
  cleanedText: string,
): string {
  return createHash("sha256")
    .update(`${title}\n${date}\n${cleanedMarkdown}\n${cleanedText}`)
    .digest("hex");
}

/** Fetches articles from the Qwen retrieval API for a single language. */
export async function fetchQwenArticleList(
  endpointUrl: string,
  articleType: string,
  language: string,
  signal: AbortSignal,
): Promise<{
  readonly url: string;
  readonly articles: readonly RawQwenArticle[];
}> {
  const url = buildRetrievalUrl(endpointUrl, articleType, language);
  let response: FetchedSourceResponse;
  try {
    response = await fetchSourceResponse({
      url,
      signal,
      stage: "fetching-index",
      headers: {
        accept: "application/json",
        "user-agent": "Binny SourceAdapter/1.0",
      },
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    const diag = readFailureDiagnosticContext(error);
    throw sourceAdapterActionError({
      code: "qwen_source_invalid_response",
      message: `Failed to fetch Qwen articles from ${url}: ${error instanceof Error ? error.message : String(error)}`,
      impact: `Retrieval for language "${language}" failed.`,
      requiresHuman: false,
      ...(diag.stage === undefined ? {} : { stage: diag.stage }),
      ...(diag.target === undefined ? {} : { target: diag.target }),
      ...(diag.abortCause === undefined ? {} : { abortCause: diag.abortCause }),
    });
  }

  if (response.status !== 200) {
    await response.cancelBody();
    throw sourceAdapterActionError({
      code: "qwen_source_invalid_response",
      message: `Qwen retrieval endpoint returned HTTP ${response.status}.`,
      impact: `Retrieval for language "${language}" failed.`,
      requiresHuman: false,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    const diag = readFailureDiagnosticContext(error);
    throw sourceAdapterActionError({
      code: "qwen_source_invalid_response",
      message: `Qwen retrieval response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      impact: `Retrieval for language "${language}" failed.`,
      requiresHuman: false,
      ...(diag.stage === undefined ? {} : { stage: diag.stage }),
      ...(diag.target === undefined ? {} : { target: diag.target }),
      ...(diag.abortCause === undefined ? {} : { abortCause: diag.abortCause }),
    });
  }

  const articles = extractArticles(json);
  if (articles === undefined || articles.length === 0) {
    throw sourceAdapterActionError({
      code: "qwen_source_invalid_response",
      message: `Qwen retrieval response does not contain a non-empty articles array.`,
      impact: `Retrieval for language "${language}" failed.`,
      requiresHuman: false,
    });
  }

  return { url, articles };
}

async function checkAction(
  context: SourceAdapterContext<QwenConfig>,
  params: QwenParams,
): Promise<z.infer<typeof checkOutputSchema>> {
  const languages = params.languages ?? context.config.languages;
  const scope = languages.map((lang) => `lang:${lang}`);
  const problems: z.infer<typeof checkOutputSchema>["problems"] = [];

  for (const language of languages) {
    if (context.signal.aborted) throw context.signal.reason;
    const url = buildRetrievalUrl(
      context.config.endpointUrl,
      context.config.articleType,
      language,
    );
    try {
      const response = await fetchSourceResponse({
        url,
        signal: context.signal,
        stage: "fetching-index",
        headers: {
          accept: "application/json",
          "user-agent": "Binny SourceAdapter/1.0",
        },
      });

      if (response.status !== 200) {
        await response.cancelBody();
        problems.push({
          code: "qwen_source_invalid_response",
          message: `Qwen endpoint for language "${language}" returned HTTP ${response.status}.`,
          impact: `Scope "lang:${language}" is unavailable.`,
          requiresHuman: false,
        });
        continue;
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        problems.push({
          code: "qwen_source_invalid_response",
          message: `Qwen endpoint for language "${language}" did not return valid JSON.`,
          impact: `Scope "lang:${language}" cannot be parsed.`,
          requiresHuman: false,
        });
        continue;
      }

      const articles = extractArticles(json);
      if (articles === undefined || articles.length === 0) {
        problems.push({
          code: "qwen_source_invalid_response",
          message: `Qwen endpoint for language "${language}" missing or empty articles array.`,
          impact: `Scope "lang:${language}" contains no articles.`,
          requiresHuman: false,
        });
        continue;
      }

      for (const [index, article] of articles.entries()) {
        if (!article.path || typeof article.path !== "string") {
          problems.push({
            code: "qwen_source_invalid_response",
            message: `Article at index ${index} lacks a valid path string.`,
            impact: `Article identity missing in scope "lang:${language}".`,
            path: ["articles", index, "path"],
            requiresHuman: false,
          });
          break;
        }
        if (typeof article.content !== "string") {
          problems.push({
            code: "qwen_source_invalid_response",
            message: `Article "${article.path}" lacks inline HTML content string.`,
            impact: `Article content cannot be cleaned in scope "lang:${language}".`,
            path: ["articles", index, "content"],
            requiresHuman: false,
          });
          break;
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push({
        code: "qwen_source_invalid_response",
        message: `Failed to request Qwen endpoint for language "${language}": ${error instanceof Error ? error.message : String(error)}`,
        impact: `Scope "lang:${language}" is unavailable.`,
        requiresHuman: false,
      });
    }
  }

  const availability = problems.length === 0 ? "available" : "unavailable";
  const basis =
    problems.length === 0
      ? `Successfully verified Qwen retrieval endpoints for ${languages.join(", ")}.`
      : `Failed availability checks for Qwen retrieval endpoints: ${problems.map((p) => p.message).join("; ")}`;

  return {
    availability,
    scope,
    basis,
    problems,
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
  return sourceAdapterActionError(
    {
      ...first,
      message: `${problems
        .slice(0, 8)
        .map((p) => p.message)
        .join(
          "; ",
        )}${problems.length > 8 ? `; and ${problems.length - 8} more problems` : ""}`,
    },
    completedScopes,
  );
}

async function syncAction(
  context: SourceAdapterContext<QwenConfig>,
  params: QwenParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  const state = await loadIncrementalSyncState(context);
  const languages = params.languages ?? context.config.languages;
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];
  const problems: ManualRunFailure[] = [];

  for (const language of languages) {
    if (context.signal.aborted) throw context.signal.reason;
    const scopeId = `lang:${language}`;
    const isInitialized = isIncrementalScopeInitialized(state, scopeId);

    let url: string;
    let articles: readonly RawQwenArticle[];
    try {
      const listResult = await fetchQwenArticleList(
        context.config.endpointUrl,
        context.config.articleType,
        language,
        context.signal,
      );
      url = listResult.url;
      articles = listResult.articles;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      if (isSourceAdapterActionError(error)) {
        problems.push(error.failure);
      } else {
        const diag = readFailureDiagnosticContext(error);
        problems.push({
          code: "qwen_source_invalid_response",
          message: `Failed to fetch Qwen articles for "${language}": ${error instanceof Error ? error.message : String(error)}`,
          impact: `Retrieval for language "${language}" failed.`,
          requiresHuman: false,
          ...(diag.stage === undefined ? {} : { stage: diag.stage }),
          ...(diag.target === undefined ? {} : { target: diag.target }),
          ...(diag.abortCause === undefined
            ? {}
            : { abortCause: diag.abortCause }),
        });
      }
      continue;
    }

    if (!isInitialized) {
      const baselineEntries: Record<string, IncrementalEntryRecord> = {};
      for (const article of articles) {
        if (!article.path || typeof article.path !== "string") continue;
        const sourceRef = buildArticleReadingUrl(
          context.config.siteBaseUrl,
          article.path,
        );
        const cleanResult = cleanContent(article.content ?? "", {
          format: "html",
          baseUrl: sourceRef,
        });
        const rawDate = article.extra?.date ?? article.date;
        const dateInfo = parseArticleDate(rawDate);
        const sourcePublishedAt = sourceTimeFrom(dateInfo.publishedDate);
        const fingerprint = computeArticleFingerprint(
          article.title ?? "",
          rawDate ?? "",
          cleanResult.markdown,
          cleanResult.text,
        );
        baselineEntries[article.path] = {
          fingerprint,
          ...(sourcePublishedAt !== null
            ? { publishedAt: sourcePublishedAt.value }
            : {}),
          archivedCompleteness: "baseline",
        };
      }

      initializeIncrementalScope(state, scopeId, {
        initializedAt: new Date().toISOString(),
        scopeUrl: url,
        entries: baselineEntries,
      });
      await saveIncrementalSyncState(context, state);
      initializedScopes.push(scopeId);
      completedScopes.push(scopeId);
    } else {
      let scopeFailed = false;
      for (const article of articles) {
        if (context.signal.aborted) throw context.signal.reason;
        if (!article.path || typeof article.path !== "string") continue;

        const sourceRef = buildArticleReadingUrl(
          context.config.siteBaseUrl,
          article.path,
        );
        const cleanResult = cleanContent(article.content ?? "", {
          format: "html",
          baseUrl: sourceRef,
        });
        const rawDate = article.extra?.date ?? article.date;
        const dateInfo = parseArticleDate(rawDate);
        const sourcePublishedAt = sourceTimeFrom(dateInfo.publishedDate);
        const fingerprint = computeArticleFingerprint(
          article.title ?? "",
          rawDate ?? "",
          cleanResult.markdown,
          cleanResult.text,
        );

        const previousEntry = state.scopes[scopeId]?.entries[article.path];
        const changed = hasIncrementalEntryChanged(
          previousEntry,
          fingerprint,
          sourcePublishedAt?.value,
        );

        if (changed) {
          const canonicalUrl = extractCanonicalUrl(article.content ?? "");
          try {
            const submitResult = await submitCleanedArticle(context, {
              sourceKey: {
                namespace: `qwen:${language}`,
                key: article.path,
              },
              sourceRef,
              title: article.title?.trim() || null,
              sourcePublishedAt,
              sourceModifiedAt: null,
              extensions: qwenExtensions(article, language, canonicalUrl),
              cleanResult,
              captureScope: {
                language,
                region: "global",
                articleType: context.config.articleType,
                path: article.path,
              },
            });

            upsertIncrementalScopeEntry(state, scopeId, article.path, {
              fingerprint,
              ...(sourcePublishedAt !== null
                ? { publishedAt: sourcePublishedAt.value }
                : {}),
              archivedCompleteness: submitResult.hasMediaFailures
                ? "partial"
                : "complete",
            });
            await saveIncrementalSyncState(context, state);
          } catch (error) {
            if (context.signal.aborted) throw context.signal.reason ?? error;
            scopeFailed = true;
            if (isSourceAdapterActionError(error)) {
              problems.push(error.failure);
            } else {
              problems.push({
                code: "qwen_article_sync_failed",
                message: `Failed to submit Qwen article "${article.path}" (${language}): ${error instanceof Error ? error.message : String(error)}`,
                impact: `Article "${article.path}" was not archived.`,
                path: ["languages", language, article.path],
                requiresHuman: false,
              });
            }
          }
        }
      }

      if (!scopeFailed) {
        completedScopes.push(scopeId);
      }
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems(problems, completedScopes);
  }

  return {
    completedScopes,
    ...(initializedScopes.length > 0 ? { initializedScopes } : {}),
  };
}

async function collectAction(
  context: SourceAdapterContext<QwenConfig>,
  params: QwenParams,
): Promise<z.infer<typeof collectOutputSchema>> {
  const state = await loadIncrementalSyncState(context);
  const languages = params.languages ?? context.config.languages;
  const completedScopes: string[] = [];
  const problems: ManualRunFailure[] = [];

  for (const language of languages) {
    if (context.signal.aborted) throw context.signal.reason;
    const scopeId = `lang:${language}`;

    let articles: readonly RawQwenArticle[];
    try {
      const listResult = await fetchQwenArticleList(
        context.config.endpointUrl,
        context.config.articleType,
        language,
        context.signal,
      );
      articles = listResult.articles;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      if (isSourceAdapterActionError(error)) {
        problems.push(error.failure);
      } else {
        const diag = readFailureDiagnosticContext(error);
        problems.push({
          code: "qwen_source_invalid_response",
          message: `Failed to fetch Qwen articles for "${language}": ${error instanceof Error ? error.message : String(error)}`,
          impact: `Retrieval for language "${language}" failed.`,
          requiresHuman: false,
          ...(diag.stage === undefined ? {} : { stage: diag.stage }),
          ...(diag.target === undefined ? {} : { target: diag.target }),
          ...(diag.abortCause === undefined
            ? {}
            : { abortCause: diag.abortCause }),
        });
      }
      continue;
    }

    let targetArticles = articles.filter(
      (a): a is RawQwenArticle & { path: string } =>
        typeof a.path === "string" && a.path.length > 0,
    );

    if (params.paths !== undefined && params.paths.length > 0) {
      const allowedPaths = new Set(params.paths);
      targetArticles = targetArticles.filter((a) => allowedPaths.has(a.path));
    }

    const beforeLimitCount = targetArticles.length;
    if (params.maxItems !== undefined && params.maxItems > 0) {
      targetArticles = targetArticles.slice(0, params.maxItems);
    }
    const truncatedByMaxItems = targetArticles.length < beforeLimitCount;

    let scopeFailed = false;
    for (const article of targetArticles) {
      if (context.signal.aborted) throw context.signal.reason;
      const sourceRef = buildArticleReadingUrl(
        context.config.siteBaseUrl,
        article.path,
      );
      const cleanResult = cleanContent(article.content ?? "", {
        format: "html",
        baseUrl: sourceRef,
      });
      const rawDate = article.extra?.date ?? article.date;
      const dateInfo = parseArticleDate(rawDate);
      const sourcePublishedAt = sourceTimeFrom(dateInfo.publishedDate);
      const canonicalUrl = extractCanonicalUrl(article.content ?? "");

      try {
        const submitResult = await submitCleanedArticle(context, {
          sourceKey: {
            namespace: `qwen:${language}`,
            key: article.path,
          },
          sourceRef,
          title: article.title?.trim() || null,
          sourcePublishedAt,
          sourceModifiedAt: null,
          extensions: qwenExtensions(article, language, canonicalUrl),
          cleanResult,
          captureScope: {
            language,
            region: "global",
            articleType: context.config.articleType,
            path: article.path,
          },
        });

        const fingerprint = computeArticleFingerprint(
          article.title ?? "",
          rawDate ?? "",
          cleanResult.markdown,
          cleanResult.text,
        );

        upsertIncrementalScopeEntry(state, scopeId, article.path, {
          fingerprint,
          ...(sourcePublishedAt !== null
            ? { publishedAt: sourcePublishedAt.value }
            : {}),
          archivedCompleteness: submitResult.hasMediaFailures
            ? "partial"
            : "complete",
        });
        await saveIncrementalSyncState(context, state);
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        scopeFailed = true;
        if (isSourceAdapterActionError(error)) {
          problems.push(error.failure);
        } else {
          problems.push({
            code: "qwen_article_collect_failed",
            message: `Failed to submit Qwen article "${article.path}" (${language}): ${error instanceof Error ? error.message : String(error)}`,
            impact: `Article "${article.path}" was not archived.`,
            path: ["languages", language, article.path],
            requiresHuman: false,
          });
        }
      }
    }

    if (!scopeFailed && !truncatedByMaxItems) {
      completedScopes.push(scopeId);
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems(problems, completedScopes);
  }

  return { completedScopes };
}

export const sourceAdapter = defineSourceAdapter({
  id: "qwen",
  version: "0.1.0",
  description: "Qwen bilingual research articles source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema: qwenConfigSchema,
  extensionsSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(qwenConfigSchema, extensionsSchema, {
      description: "Check Qwen bilingual retrieval endpoints availability.",
      params: qwenParamsSchema,
      output: checkOutputSchema,
      execute: checkAction,
    }),
    collect: defineSourceAdapterAction(qwenConfigSchema, extensionsSchema, {
      description: "Collect Qwen bilingual research articles.",
      params: qwenParamsSchema,
      output: collectOutputSchema,
      execute: collectAction,
    }),
    sync: defineSourceAdapterAction(qwenConfigSchema, extensionsSchema, {
      description: "Incrementally sync Qwen bilingual research articles.",
      params: qwenParamsSchema,
      output: syncOutputSchema,
      execute: syncAction,
    }),
  },
});

export default sourceAdapter;
