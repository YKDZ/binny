// DeepSeek bilingual news and updates changelog source adapter implementation.
import { createHash } from "node:crypto";

import {
  cleanContent,
  computeOngoingDocumentHash,
  defineSourceAdapter,
  defineSourceAdapterAction,
  getIncrementalScopeOngoingDocument,
  hasIncrementalEntryChanged,
  hasOngoingDocumentChanged,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  submitCleanedArticle,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  upsertIncrementalScopeOngoingDocument,
  type CleanContentResult,
  type IncrementalEntryRecord,
  type IncrementalSyncState,
  type JsonObject,
  type ManualRunFailure,
  type SourceAdapterContext,
  type SubmitCleanedArticleResult,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

export const deepSeekSourceDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1, "Source identifier cannot be empty.")
      .max(128, "Source identifier cannot exceed 128 characters.")
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u,
        "Source identifier must contain only alphanumeric characters, dots, underscores, or hyphens.",
      ),
    language: z.string().min(1).max(32),
    updatesUrl: z.string().url("Updates URL must be a valid URL."),
    title: z.string().min(1).max(512).optional(),
  })
  .strict();

export type DeepSeekSourceDefinition = z.infer<
  typeof deepSeekSourceDefinitionSchema
>;

export const DEFAULT_DEEPSEEK_SOURCES: readonly DeepSeekSourceDefinition[] = [
  {
    id: "zh-cn",
    language: "zh-CN",
    updatesUrl: "https://api-docs.deepseek.com/zh-cn/updates.md",
    title: "DeepSeek API 更新日志",
  },
  {
    id: "en",
    language: "en",
    updatesUrl: "https://api-docs.deepseek.com/updates.md",
    title: "DeepSeek API Updates",
  },
];

export const configSchema = z
  .object({
    sources: z
      .array(deepSeekSourceDefinitionSchema)
      .default(() => [...DEFAULT_DEEPSEEK_SOURCES]),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    for (const [index, source] of config.sources.entries()) {
      if (seen.has(source.id)) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "id"],
          message: "Duplicate source identifier in configuration.",
        });
      }
      seen.add(source.id);
    }
  });

export type DeepSeekConfig = z.infer<typeof configSchema>;

export const paramsSchema = z
  .object({
    sourceIds: z.array(z.string().min(1)).max(64).optional(),
    itemUrls: z.array(z.string().min(1)).optional(),
    maxItems: z.number().int().positive().optional(),
  })
  .strict();

export type DeepSeekParams = z.infer<typeof paramsSchema>;

export const checkOutputSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string()),
    basis: z.string(),
    problems: z.array(z.unknown()),
  })
  .strict();

export const collectOutputSchema = z
  .object({
    completedScopes: z.array(z.string()).readonly(),
  })
  .strict();

export const syncOutputSchema = z
  .object({
    completedScopes: z.array(z.string()).readonly(),
    initializedScopes: z.array(z.string()).readonly().optional(),
  })
  .strict();

export interface DiscoveredNewsArticle {
  readonly slug: string;
  readonly url: string;
  readonly linkText: string;
  readonly date?: string | undefined;
  readonly fingerprint: string;
}

export interface FetchedNewsArticle {
  readonly title: string;
  readonly cleanResult: CleanContentResult;
  readonly format: "markdown" | "html";
  readonly publishedDate?: string | undefined;
  readonly datePrecision?: "day" | "month" | undefined;
}

export function selectedSources(
  config: DeepSeekConfig,
  params: DeepSeekParams,
): {
  readonly sources: readonly DeepSeekSourceDefinition[];
  readonly missing: readonly string[];
} {
  if (params.sourceIds === undefined) {
    return { sources: config.sources, missing: [] };
  }
  const byId = new Map(config.sources.map((s) => [s.id, s]));
  const sources: DeepSeekSourceDefinition[] = [];
  const missing: string[] = [];
  for (const id of params.sourceIds) {
    const source = byId.get(id);
    if (source !== undefined) {
      sources.push(source);
    } else {
      missing.push(id);
    }
  }
  return { sources, missing };
}

export function createActionFailure(
  code: string,
  message: string,
  impact: string,
  suggestion = "Check source network availability and content format.",
  path?: (string | number)[],
): ManualRunFailure {
  return {
    code,
    message,
    impact,
    suggestion,
    path,
    requiresHuman: false,
  };
}

export function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

export function normalizeDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  const match1 = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match1?.[1] && match1[2] && match1[3]) {
    const year = match1[1];
    const month = match1[2].padStart(2, "0");
    const day = match1[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const match2 = trimmed.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (match2?.[1] && match2[2] && match2[3]) {
    const year = match2[1];
    const month = match2[2].padStart(2, "0");
    const day = match2[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const match3 = trimmed.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (match3?.[1] && match3[2]) {
    const year = match3[1];
    const month = match3[2].padStart(2, "0");
    return `${year}-${month}`;
  }
  const match4 = trimmed.match(/^(\d{4})年(\d{1,2})月$/);
  if (match4?.[1] && match4[2]) {
    const year = match4[1];
    const month = match4[2].padStart(2, "0");
    return `${year}-${month}`;
  }
  return undefined;
}

export function extractNewsSlug(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const match = pathname.match(
      /(?:\/zh-cn)?\/news\/(news[a-zA-Z0-9._-]+?)(?:\.md|\/)?$/i,
    );
    if (match?.[1]) {
      return match[1].replace(/\.md$/i, "");
    }
  } catch {
    const match = url.match(
      /(?:\/zh-cn)?\/news\/(news[a-zA-Z0-9._-]+?)(?:\.md|\/)?$/i,
    );
    if (match?.[1]) {
      return match[1].replace(/\.md$/i, "");
    }
  }
  return undefined;
}

export function isHomepageFallback(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    text.includes("Your First API Call") ||
    lower.includes("your first api call") ||
    text.includes("首次调用 API") ||
    text.includes("首次调用API")
  );
}

export function isHtmlSpaShellOrErrorPage(
  text: string,
  contentType: string | null,
): boolean {
  const isHtmlType = contentType?.toLowerCase().includes("text/html") ?? false;
  const hasHtmlTag = /<(!doctype\s+html|html|head)[\s>]/iu.test(text);

  if (isHtmlType || hasHtmlTag) {
    const hasSpaRoot =
      /<div\s+id=["'](root|app|__next)["']\s*>\s*<\/div>/iu.test(text);
    if (hasSpaRoot) {
      const stripped = text.replace(/<[^>]+>/g, " ").trim();
      if (stripped.length < 50) {
        return true;
      }
    }
    if (
      /<title[^>]*>.*?(404|not\s+found|error|forbidden|access\s+denied|页面不存在|错误).*?<\/title>/iu.test(
        text,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function preprocessMarkdown(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;
  const resultLines: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      resultLines.push(line);
      continue;
    }
    if (inCodeBlock) {
      resultLines.push(line);
      continue;
    }
    const replaced = line.replaceAll(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/gu,
      (_match, alt, url, title) => {
        const titleAttr = title ? ` title="${title}"` : "";
        return `<img src="${url}" alt="${alt}"${titleAttr} />`;
      },
    );
    resultLines.push(replaced);
  }
  return resultLines.join("\n");
}

export function extractMarkdownTitle(markdown: string): string | undefined {
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch?.[1]) {
    const titleMatch = fmMatch[1].match(/^title:\s*["']?([^"'\n\r]+)["']?/m);
    if (titleMatch?.[1]) {
      return titleMatch[1].trim();
    }
  }
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  if (h1Match?.[1]) {
    return h1Match[1].trim();
  }
  return undefined;
}

export function extractHtmlTitle(html: string): string | undefined {
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    const text = h1Match[1].replace(/<[^>]+>/g, "").trim();
    if (text.length > 0) return text;
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const text = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

export function extractArticleDate(
  markdown: string,
): { readonly date: string; readonly precision: "day" | "month" } | undefined {
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch?.[1]) {
    const dateMatch = fmMatch[1].match(/^date:\s*["']?([^"'\n\r]+)["']?/m);
    if (dateMatch?.[1]) {
      const norm = normalizeDate(dateMatch[1]);
      if (norm) {
        return {
          date: norm,
          precision: norm.length === 10 ? "day" : "month",
        };
      }
    }
  }
  const lineMatch = markdown.match(
    /(?:^#+\s+|\*\*|^)(\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{4}年\d{1,2}月(?:\d{1,2}日)?)/m,
  );
  if (lineMatch?.[1]) {
    const norm = normalizeDate(lineMatch[1]);
    if (norm) {
      return {
        date: norm,
        precision: norm.length === 10 ? "day" : "month",
      };
    }
  }
  return undefined;
}

export function extractHtmlDate(
  html: string,
): { readonly date: string; readonly precision: "day" | "month" } | undefined {
  const timeMatch = html.match(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/i);
  if (timeMatch?.[1]) {
    const norm = normalizeDate(timeMatch[1]);
    if (norm) {
      return {
        date: norm,
        precision: norm.length === 10 ? "day" : "month",
      };
    }
  }
  const metaMatch = html.match(
    /<meta\s+(?:property|name)=["'](?:article:published_time|date)["']\s+content=["']([^"']+)["']/i,
  );
  if (metaMatch?.[1]) {
    const norm = normalizeDate(metaMatch[1]);
    if (norm) {
      return {
        date: norm,
        precision: norm.length === 10 ? "day" : "month",
      };
    }
  }
  const textMatch = html.match(
    /(\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{4}年\d{1,2}月(?:\d{1,2}日)?)/,
  );
  if (textMatch?.[1]) {
    const norm = normalizeDate(textMatch[1]);
    if (norm) {
      return {
        date: norm,
        precision: norm.length === 10 ? "day" : "month",
      };
    }
  }
  return undefined;
}

export function discoverNewsArticles(
  rawMarkdown: string,
  updatesUrl: string,
): {
  readonly articles: readonly DiscoveredNewsArticle[];
  readonly latestChangelogDate?:
    | { readonly date: string; readonly precision: "day" | "month" }
    | undefined;
} {
  const lines = rawMarkdown.split("\n");
  let currentDateContext:
    | { readonly date: string; readonly precision: "day" | "month" }
    | undefined;
  let latestChangelogDate:
    | { readonly date: string; readonly precision: "day" | "month" }
    | undefined;
  const articles: DiscoveredNewsArticle[] = [];
  const seenSlugs = new Set<string>();

  for (const line of lines) {
    const dateMatch = line.match(
      /(?:^#+\s+|\*\*|^)(\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{4}年\d{1,2}月(?:\d{1,2}日)?)/,
    );
    if (dateMatch?.[1]) {
      const norm = normalizeDate(dateMatch[1]);
      if (norm) {
        const precision: "day" | "month" = norm.length === 10 ? "day" : "month";
        currentDateContext = { date: norm, precision };
        if (!latestChangelogDate) {
          latestChangelogDate = currentDateContext;
        }
      }
    }

    const mdMatches = line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
    for (const match of mdMatches) {
      const text = match[1] ?? "";
      const href = match[2] ?? "";
      const resolved = resolveUrl(href, updatesUrl);
      const slug = extractNewsSlug(resolved);
      if (slug && !seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        const cleanUrl = resolved.replace(/\.md$/i, "").replace(/\/+$/, "");
        const fingerprint = createHash("sha256")
          .update(
            `${slug}:${cleanUrl}:${currentDateContext?.date ?? ""}:${text.trim()}`,
          )
          .digest("hex");
        articles.push({
          slug,
          url: cleanUrl,
          linkText: text.trim(),
          date: currentDateContext?.date,
          fingerprint,
        });
      }
    }

    const htmlMatches = line.matchAll(
      /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
    );
    for (const match of htmlMatches) {
      const href = match[1] ?? "";
      const text = (match[2] ?? "").replace(/<[^>]+>/g, "");
      const resolved = resolveUrl(href, updatesUrl);
      const slug = extractNewsSlug(resolved);
      if (slug && !seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        const cleanUrl = resolved.replace(/\.md$/i, "").replace(/\/+$/, "");
        const fingerprint = createHash("sha256")
          .update(
            `${slug}:${cleanUrl}:${currentDateContext?.date ?? ""}:${text.trim()}`,
          )
          .digest("hex");
        articles.push({
          slug,
          url: cleanUrl,
          linkText: text.trim(),
          date: currentDateContext?.date,
          fingerprint,
        });
      }
    }
  }

  return { articles, latestChangelogDate };
}

export async function fetchText(
  url: string,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<{
  readonly rawText: string;
  readonly contentType: string | null;
  readonly status: number;
}> {
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "text/markdown, text/plain, text/html, */*",
        "user-agent": "Binny SourceAdapter/1.0 (DeepSeek)",
      },
      signal: requestSignal,
    });
  } catch (error) {
    throw new Error(
      `Network request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} when requesting ${url}.`);
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  return { rawText: text, contentType, status: response.status };
}

export async function fetchNewsArticle(
  articleUrl: string,
  _updatesUrl: string,
  signal: AbortSignal,
  discoveredMeta?: {
    readonly linkText?: string | undefined;
    readonly date?: string | undefined;
    readonly datePrecision?: "day" | "month" | undefined;
  },
): Promise<FetchedNewsArticle> {
  const cleanUrl = articleUrl.replace(/\.md$/i, "").replace(/\/+$/, "");
  const mdUrl = `${cleanUrl}.md`;

  try {
    const mdRes = await fetch(mdUrl, {
      method: "GET",
      headers: {
        accept: "text/markdown, text/plain, */*",
        "user-agent": "Binny SourceAdapter/1.0 (DeepSeek)",
      },
      signal,
    });
    if (mdRes.status === 200) {
      const text = await mdRes.text();
      const contentType = mdRes.headers.get("content-type");
      if (
        !isHomepageFallback(text) &&
        !isHtmlSpaShellOrErrorPage(text, contentType)
      ) {
        const preprocessed = preprocessMarkdown(text);
        const clean = cleanContent(preprocessed, {
          format: "markdown",
          baseUrl: mdUrl,
        });
        if (clean.hasSubstantialContent && clean.text.trim().length > 0) {
          const extractedDate =
            extractArticleDate(text) ??
            (discoveredMeta?.date
              ? {
                  date: discoveredMeta.date,
                  precision: discoveredMeta.datePrecision ?? "day",
                }
              : undefined);
          const title =
            extractMarkdownTitle(text) ??
            discoveredMeta?.linkText ??
            extractNewsSlug(articleUrl) ??
            "DeepSeek News";
          return {
            title,
            cleanResult: clean,
            format: "markdown",
            publishedDate: extractedDate?.date,
            datePrecision: extractedDate?.precision,
          };
        }
      }
    }
  } catch {
    // Fall back to HTML
  }

  const htmlRes = await fetch(cleanUrl, {
    method: "GET",
    headers: {
      accept: "text/html, application/xhtml+xml, */*",
      "user-agent": "Binny SourceAdapter/1.0 (DeepSeek)",
    },
    signal,
  });
  if (htmlRes.status !== 200) {
    throw new Error(
      `News article at ${cleanUrl} returned HTTP ${htmlRes.status}.`,
    );
  }
  const htmlText = await htmlRes.text();
  if (isHomepageFallback(htmlText)) {
    throw new Error(
      `News article at ${cleanUrl} returned documentation homepage fallback ("Your First API Call" / "首次调用 API").`,
    );
  }
  const contentType = htmlRes.headers.get("content-type");
  if (isHtmlSpaShellOrErrorPage(htmlText, contentType)) {
    throw new Error(
      `News article at ${cleanUrl} returned HTML SPA shell without article body or error page.`,
    );
  }
  const clean = cleanContent(htmlText, {
    format: "html",
    baseUrl: cleanUrl,
  });
  if (!clean.hasSubstantialContent || clean.text.trim().length === 0) {
    throw new Error(
      `News article at ${cleanUrl} has no substantial article content.`,
    );
  }
  const extractedDate =
    extractHtmlDate(htmlText) ??
    (discoveredMeta?.date
      ? {
          date: discoveredMeta.date,
          precision: discoveredMeta.datePrecision ?? "day",
        }
      : undefined);
  const title =
    extractHtmlTitle(htmlText) ??
    discoveredMeta?.linkText ??
    extractNewsSlug(articleUrl) ??
    "DeepSeek News";
  return {
    title,
    cleanResult: clean,
    format: "html",
    publishedDate: extractedDate?.date,
    datePrecision: extractedDate?.precision,
  };
}

async function submitChangelogArticle(
  context: SourceAdapterContext<DeepSeekConfig>,
  source: DeepSeekSourceDefinition,
  cleanResult: CleanContentResult,
  latestChangelogDate?: {
    readonly date: string;
    readonly precision: "day" | "month";
  },
): Promise<SubmitCleanedArticleResult> {
  const changelogTitle =
    source.title ??
    (source.language === "zh-CN"
      ? "DeepSeek API 更新日志"
      : "DeepSeek API Updates");
  const metadata: JsonObject = {
    region: "unpartitioned",
    language: source.language,
    kind: "changelog",
    title: changelogTitle,
    ...(latestChangelogDate
      ? {
          publishedDate: latestChangelogDate.date,
          datePrecision: latestChangelogDate.precision,
        }
      : {}),
  };
  const properties: JsonObject = {
    title: changelogTitle,
    ...(latestChangelogDate ? { publishedDate: latestChangelogDate.date } : {}),
  };

  return await submitCleanedArticle(context, {
    sourceKey: {
      namespace: `deepseek:${source.id}`,
      key: "changelog:updates",
    },
    sourceRef: source.updatesUrl,
    title: changelogTitle,
    sourceModifiedAt: undefined,
    metadata,
    properties,
    cleanResult,
    captureScope: {
      sourceId: source.id,
      language: source.language,
      kind: "changelog",
      url: source.updatesUrl,
    },
  });
}

async function submitNewsArticle(
  context: SourceAdapterContext<DeepSeekConfig>,
  source: DeepSeekSourceDefinition,
  article: DiscoveredNewsArticle,
  fetchedNews: FetchedNewsArticle,
): Promise<SubmitCleanedArticleResult> {
  const metadata: JsonObject = {
    region: "unpartitioned",
    language: source.language,
    kind: "news",
    title: fetchedNews.title,
    ...(fetchedNews.publishedDate
      ? {
          publishedDate: fetchedNews.publishedDate,
          datePrecision: fetchedNews.datePrecision ?? "day",
        }
      : {}),
  };
  const properties: JsonObject = {
    title: fetchedNews.title,
    ...(fetchedNews.publishedDate
      ? { publishedDate: fetchedNews.publishedDate }
      : {}),
  };

  return await submitCleanedArticle(context, {
    sourceKey: {
      namespace: `deepseek:${source.id}`,
      key: `news:${article.slug}`,
    },
    sourceRef: article.url,
    title: fetchedNews.title,
    sourceModifiedAt: undefined,
    metadata,
    properties,
    cleanResult: fetchedNews.cleanResult,
    captureScope: {
      sourceId: source.id,
      language: source.language,
      kind: "news",
      url: article.url,
      slug: article.slug,
    },
  });
}

export async function executeDeepSeekCheck(
  context: SourceAdapterContext<DeepSeekConfig>,
  params: DeepSeekParams,
): Promise<z.infer<typeof checkOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const problems: ManualRunFailure[] = [];
  const scope: string[] = [];

  for (const missingId of missing) {
    problems.push(
      createActionFailure(
        "deepseek_source_not_found",
        `Configured source "${missingId}" was not found.`,
        `Source "${missingId}" cannot be checked.`,
        "Check if the sourceIds in action parameters match the configuration.",
        ["sources", missingId],
      ),
    );
  }

  for (const source of sources) {
    scope.push(source.id);
    try {
      const { rawText, contentType } = await fetchText(
        source.updatesUrl,
        context.signal,
      );
      if (isHomepageFallback(rawText)) {
        throw new Error(
          `Updates URL for "${source.id}" returned documentation homepage fallback ("Your First API Call" / "首次调用 API").`,
        );
      }
      if (isHtmlSpaShellOrErrorPage(rawText, contentType)) {
        throw new Error(
          `Updates URL for "${source.id}" returned HTML SPA shell or error page instead of markdown.`,
        );
      }
      const preprocessed = preprocessMarkdown(rawText);
      const cleanResult = cleanContent(preprocessed, {
        format: "markdown",
        baseUrl: source.updatesUrl,
      });
      if (
        !cleanResult.hasSubstantialContent ||
        cleanResult.text.trim().length === 0
      ) {
        throw new Error(
          `Updates document for "${source.id}" has no substantial content.`,
        );
      }

      const { articles } = discoverNewsArticles(rawText, source.updatesUrl);
      if (articles.length > 0) {
        const sample = articles[0]!;
        await fetchNewsArticle(sample.url, source.updatesUrl, context.signal, {
          linkText: sample.linkText,
          date: sample.date,
          datePrecision: "day",
        });
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push(
        createActionFailure(
          "deepseek_check_failed",
          `Availability check failed for source "${source.id}": ${error instanceof Error ? error.message : String(error)}`,
          `Source "${source.id}" is unavailable.`,
          "Check network connectivity, URL configuration, and page content.",
          ["sources", source.id],
        ),
      );
    }
  }

  const availability = problems.length === 0 ? "available" : "unavailable";
  const basis =
    problems.length === 0
      ? `Successfully verified DeepSeek updates and linked news for ${scope.join(", ")}.`
      : `DeepSeek availability check failed: ${problems.map((p) => p.message).join("; ")}`;

  return {
    availability,
    scope,
    basis,
    problems,
  };
}

export async function executeDeepSeekSync(
  context: SourceAdapterContext<DeepSeekConfig>,
  params: DeepSeekParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const problems: ManualRunFailure[] = [];
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];

  for (const missingId of missing) {
    problems.push(
      createActionFailure(
        "deepseek_source_not_found",
        `Configured source "${missingId}" was not found.`,
        `Source "${missingId}" cannot be synchronized.`,
        "Check if the sourceIds in action parameters match the configuration.",
        ["sources", missingId],
      ),
    );
  }

  const state = await loadIncrementalSyncState(context);

  for (const source of sources) {
    const scopeId = source.id;
    try {
      const isInitialized = isIncrementalScopeInitialized(
        state,
        scopeId,
        source.updatesUrl,
      );
      const { rawText, contentType } = await fetchText(
        source.updatesUrl,
        context.signal,
      );
      if (isHomepageFallback(rawText)) {
        throw new Error(
          `Updates URL for "${source.id}" returned documentation homepage fallback ("Your First API Call" / "首次调用 API").`,
        );
      }
      if (isHtmlSpaShellOrErrorPage(rawText, contentType)) {
        throw new Error(
          `Updates URL for "${source.id}" returned HTML SPA shell or error page instead of markdown.`,
        );
      }
      const preprocessed = preprocessMarkdown(rawText);
      const cleanResult = cleanContent(preprocessed, {
        format: "markdown",
        baseUrl: source.updatesUrl,
      });
      if (
        !cleanResult.hasSubstantialContent ||
        cleanResult.text.trim().length === 0
      ) {
        throw new Error(
          `Updates document for "${source.id}" has no substantial content.`,
        );
      }
      const contentHash = computeOngoingDocumentHash(
        cleanResult.markdown,
        cleanResult.text,
      );
      const { articles, latestChangelogDate } = discoverNewsArticles(
        rawText,
        source.updatesUrl,
      );

      if (!isInitialized) {
        const initialEntries: Record<string, IncrementalEntryRecord> = {};
        for (const article of articles) {
          initialEntries[`news:${article.slug}`] = {
            fingerprint: article.fingerprint,
            archivedCompleteness: "baseline",
            ...(article.date ? { publishedAt: article.date } : {}),
          };
        }
        initializeIncrementalScope(state, scopeId, {
          scopeUrl: source.updatesUrl,
          initializedAt: context.referenceTime,
          ongoingDocuments: {
            "changelog:updates": {
              contentHash,
              updatedAt: context.referenceTime,
            },
          },
          entries: initialEntries,
        });
        initializedScopes.push(scopeId);
        completedScopes.push(scopeId);
      } else {
        const previousDoc = getIncrementalScopeOngoingDocument(
          state,
          scopeId,
          "changelog:updates",
        );
        const changelogChanged = hasOngoingDocumentChanged(
          previousDoc,
          contentHash,
        );
        if (changelogChanged) {
          await submitChangelogArticle(
            context,
            source,
            cleanResult,
            latestChangelogDate,
          );
          upsertIncrementalScopeOngoingDocument(
            state,
            scopeId,
            "changelog:updates",
            {
              contentHash,
              updatedAt: context.referenceTime,
            },
          );
        }

        let hasArticleFailure = false;
        const scopeState = state.scopes[scopeId]!;
        for (const article of articles) {
          const newsKey = `news:${article.slug}`;
          const previousEntry = scopeState.entries[newsKey];
          const isChanged = hasIncrementalEntryChanged(
            previousEntry,
            article.fingerprint,
          );
          if (!isChanged) {
            continue;
          }
          try {
            const fetchedNews = await fetchNewsArticle(
              article.url,
              source.updatesUrl,
              context.signal,
              {
                linkText: article.linkText,
                date: article.date,
                datePrecision: "day",
              },
            );
            const submitResult = await submitNewsArticle(
              context,
              source,
              article,
              fetchedNews,
            );
            upsertIncrementalScopeEntry(state, scopeId, newsKey, {
              fingerprint: article.fingerprint,
              ...(fetchedNews.publishedDate
                ? { publishedAt: fetchedNews.publishedDate }
                : {}),
              archivedCompleteness: submitResult.hasMediaFailures
                ? "partial"
                : "complete",
              updatedAt: context.referenceTime,
            });
          } catch (articleError) {
            if (context.signal.aborted) throw articleError;
            hasArticleFailure = true;
            problems.push(
              createActionFailure(
                "deepseek_article_sync_failed",
                `Failed to fetch or archive news article "${article.slug}": ${articleError instanceof Error ? articleError.message : String(articleError)}`,
                `News article "${article.slug}" could not be archived during sync.`,
                "Verify news detail URL availability and content format.",
                ["sources", source.id, "news", article.slug],
              ),
            );
          }
        }

        if (!hasArticleFailure) {
          updateIncrementalScopeValidators(state, scopeId, {
            scopeUrl: source.updatesUrl,
          });
          completedScopes.push(scopeId);
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push(
        createActionFailure(
          "deepseek_sync_failed",
          `Failed to synchronize source "${source.id}": ${error instanceof Error ? error.message : String(error)}`,
          `Scope "${source.id}" could not complete synchronization.`,
          "Verify updatesUrl availability and content format.",
          ["sources", source.id],
        ),
      );
    }
  }

  await saveIncrementalSyncState(context, state);

  if (problems.length > 0) {
    const first = problems[0]!;
    throw sourceAdapterActionError(first, completedScopes);
  }

  return {
    completedScopes,
    ...(initializedScopes.length > 0 ? { initializedScopes } : {}),
  };
}

export async function executeDeepSeekCollect(
  context: SourceAdapterContext<DeepSeekConfig>,
  params: DeepSeekParams,
): Promise<z.infer<typeof collectOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const problems: ManualRunFailure[] = [];
  const completedScopes: string[] = [];

  for (const missingId of missing) {
    problems.push(
      createActionFailure(
        "deepseek_source_not_found",
        `Configured source "${missingId}" was not found.`,
        `Source "${missingId}" cannot be collected.`,
        "Check if the sourceIds in action parameters match the configuration.",
        ["sources", missingId],
      ),
    );
  }

  let state: IncrementalSyncState | undefined;
  if (context.persistentState !== undefined) {
    try {
      state = await loadIncrementalSyncState(context);
    } catch {
      // Ignore state load errors during explicit collect if optional
    }
  }

  for (const source of sources) {
    try {
      const { rawText, contentType } = await fetchText(
        source.updatesUrl,
        context.signal,
      );
      if (isHomepageFallback(rawText)) {
        throw new Error(
          `Updates URL for "${source.id}" returned documentation homepage fallback ("Your First API Call" / "首次调用 API").`,
        );
      }
      if (isHtmlSpaShellOrErrorPage(rawText, contentType)) {
        throw new Error(
          `Updates URL for "${source.id}" returned HTML SPA shell or error page instead of markdown.`,
        );
      }
      const preprocessed = preprocessMarkdown(rawText);
      const cleanResult = cleanContent(preprocessed, {
        format: "markdown",
        baseUrl: source.updatesUrl,
      });
      if (
        !cleanResult.hasSubstantialContent ||
        cleanResult.text.trim().length === 0
      ) {
        throw new Error(
          `Updates document for "${source.id}" has no substantial content.`,
        );
      }
      const contentHash = computeOngoingDocumentHash(
        cleanResult.markdown,
        cleanResult.text,
      );
      const { articles, latestChangelogDate } = discoverNewsArticles(
        rawText,
        source.updatesUrl,
      );

      let shouldArchiveChangelog = true;
      let articlesToCollect = articles;

      if (params.itemUrls && params.itemUrls.length > 0) {
        const urlSet = new Set(params.itemUrls);
        shouldArchiveChangelog = urlSet.has(source.updatesUrl);
        articlesToCollect = articles.filter(
          (a) => urlSet.has(a.url) || urlSet.has(`${a.url}.md`),
        );
      } else if (params.maxItems !== undefined && params.maxItems > 0) {
        articlesToCollect = articles.slice(0, params.maxItems);
      }

      if (shouldArchiveChangelog) {
        await submitChangelogArticle(
          context,
          source,
          cleanResult,
          latestChangelogDate,
        );
        if (state !== undefined) {
          upsertIncrementalScopeOngoingDocument(
            state,
            source.id,
            "changelog:updates",
            {
              contentHash,
              updatedAt: context.referenceTime,
            },
          );
        }
      }

      let hasArticleFailure = false;
      for (const article of articlesToCollect) {
        try {
          const fetchedNews = await fetchNewsArticle(
            article.url,
            source.updatesUrl,
            context.signal,
            {
              linkText: article.linkText,
              date: article.date,
              datePrecision: "day",
            },
          );
          const submitResult = await submitNewsArticle(
            context,
            source,
            article,
            fetchedNews,
          );
          if (state !== undefined) {
            upsertIncrementalScopeEntry(
              state,
              source.id,
              `news:${article.slug}`,
              {
                fingerprint: article.fingerprint,
                ...(fetchedNews.publishedDate
                  ? { publishedAt: fetchedNews.publishedDate }
                  : {}),
                archivedCompleteness: submitResult.hasMediaFailures
                  ? "partial"
                  : "complete",
                updatedAt: context.referenceTime,
              },
            );
          }
        } catch (articleError) {
          if (context.signal.aborted) throw articleError;
          hasArticleFailure = true;
          problems.push(
            createActionFailure(
              "deepseek_article_collect_failed",
              `Failed to collect news article "${article.slug}": ${articleError instanceof Error ? articleError.message : String(articleError)}`,
              `News article "${article.slug}" could not be archived.`,
              "Verify news detail URL and content format.",
              ["sources", source.id, "news", article.slug],
            ),
          );
        }
      }

      if (!hasArticleFailure) {
        completedScopes.push(source.id);
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push(
        createActionFailure(
          "deepseek_collect_failed",
          `Failed to collect source "${source.id}": ${error instanceof Error ? error.message : String(error)}`,
          `Scope "${source.id}" could not be collected.`,
          "Verify updatesUrl and network connectivity.",
          ["sources", source.id],
        ),
      );
    }
  }

  if (state !== undefined && context.persistentState !== undefined) {
    await saveIncrementalSyncState(context, state);
  }

  if (problems.length > 0) {
    const first = problems[0]!;
    throw sourceAdapterActionError(first, completedScopes);
  }

  return { completedScopes };
}

export const sourceAdapter = defineSourceAdapter({
  id: "deepseek",
  version: "0.1.0",
  description: "DeepSeek bilingual news and updates changelog source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, {
      description: "Check DeepSeek changelog and news source availability.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: executeDeepSeekCheck,
    }),
    collect: defineSourceAdapterAction(configSchema, {
      description:
        "Collect DeepSeek updates changelog and linked news articles.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: executeDeepSeekCollect,
    }),
    sync: defineSourceAdapterAction(configSchema, {
      description:
        "Incrementally sync DeepSeek updates changelog and newly published news articles.",
      params: paramsSchema,
      output: syncOutputSchema,
      execute: executeDeepSeekSync,
    }),
  },
});
