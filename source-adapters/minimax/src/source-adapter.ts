// MiniMax regional model releases and first-party blog details source adapter.
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
  sourceTimeFrom,
  submitCleanedArticle,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  upsertIncrementalScopeOngoingDocument,
  type CleanContentResult,
  type IncrementalEntryRecord,
  type IncrementalSyncState,
  type ManualRunFailure,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import * as parse5 from "parse5";
import { z } from "zod";

export const minimaxRegionSchema = z.enum(["cn", "international"]);
export type MinimaxRegion = z.infer<typeof minimaxRegionSchema>;

export const minimaxSourceSchema = z
  .object({
    id: z
      .string()
      .min(1, "Source identifier must not be empty.")
      .max(128, "Source identifier must not exceed 128 characters.")
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u,
        "Source identifier may only contain alphanumeric characters, dots, underscores, and hyphens.",
      ),
    region: minimaxRegionSchema,
    language: z.string().min(1).max(32),
    modelsReleaseUrl: z.string().url("Models release URL must be a valid URL."),
    allowedArticleHosts: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type MinimaxSourceDefinition = z.infer<typeof minimaxSourceSchema>;

export const DEFAULT_MINIMAX_SOURCES: readonly MinimaxSourceDefinition[] = [
  {
    id: "cn",
    region: "cn",
    language: "zh-CN",
    modelsReleaseUrl:
      "https://platform.minimax.cn/docs/release-notes/models.md",
    allowedArticleHosts: [
      "www.minimax.cn",
      "minimax.cn",
      "platform.minimax.cn",
    ],
  },
  {
    id: "international",
    region: "international",
    language: "en",
    modelsReleaseUrl:
      "https://platform.minimax.io/docs/release-notes/models.md",
    allowedArticleHosts: [
      "www.minimax.io",
      "minimax.io",
      "platform.minimax.io",
    ],
  },
];

export const configSchema = z
  .object({
    sources: z
      .array(minimaxSourceSchema)
      .default(() => [...DEFAULT_MINIMAX_SOURCES]),
  })
  .strict();

export type MinimaxConfig = z.infer<typeof configSchema>;

export const paramsSchema = z
  .object({
    sourceIds: z.array(z.string().min(1)).optional(),
    itemUrls: z.array(z.string().min(1)).optional(),
    maxItems: z.number().int().positive().optional(),
  })
  .strict();

export type MinimaxParams = z.infer<typeof paramsSchema>;

const extensionsSchema = z
  .object({
    kind: z
      .enum(["release-notes", "article"])
      .describe("Kind of MiniMax source content archived in this item."),
    region: minimaxRegionSchema.describe(
      "Geographic region assigned to this MiniMax source.",
    ),
    language: z
      .string()
      .describe("Language used by the MiniMax source content."),
    latestReleaseEntryDate: z
      .string()
      .optional()
      .describe(
        "Latest dated entry heading found in the whole models release document.",
      ),
    latestReleaseEntryDatePrecision: z
      .enum(["instant", "day", "month", "year"])
      .optional()
      .describe("Known precision of the latest entry heading date."),
    observedReleaseEntryDates: z
      .array(z.string())
      .optional()
      .describe(
        "Distinct dated entry headings in the whole models release document.",
      ),
    modelsReleaseDate: z
      .string()
      .optional()
      .describe(
        "Release date heading associated with this article in models.md.",
      ),
    modelsReleaseDatePrecision: z
      .enum(["instant", "day", "month", "year"])
      .optional()
      .describe(
        "Known precision of the models.md heading associated with this article.",
      ),
    latestArticleContentDate: z
      .string()
      .optional()
      .describe("Latest dated heading found inside the article body."),
    latestArticleContentDatePrecision: z
      .enum(["instant", "day", "month", "year"])
      .optional()
      .describe(
        "Known precision of the latest dated heading in the article body.",
      ),
    observedArticleContentDates: z
      .array(z.string())
      .optional()
      .describe("Distinct dated headings found inside the article body."),
    articleContentDate: z
      .string()
      .optional()
      .describe(
        "Date shown by a non-publication time element in the article content.",
      ),
    articleContentDatePrecision: z
      .enum(["instant", "day", "month", "year"])
      .optional()
      .describe(
        "Known precision of the date shown by a non-publication time element.",
      ),
  })
  .strict();

type MinimaxExtensions = z.output<typeof extensionsSchema>;
type MinimaxDatePrecision = "instant" | "day" | "month" | "year";

function validatedDate(
  value: string,
):
  | { readonly date: string; readonly precision: MinimaxDatePrecision }
  | undefined {
  const sourceTime = sourceTimeFrom(value);
  return sourceTime === null
    ? undefined
    : { date: sourceTime.value, precision: sourceTime.precision };
}

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

const MONTH_NAMES: Readonly<Record<string, string>> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

/** Parses valid source dates while retaining exact instants and stated precision. */
export function parseDateString(
  text: string,
):
  | { readonly date: string; readonly precision: MinimaxDatePrecision }
  | undefined {
  const trimmed = text.trim();
  const exact = validatedDate(trimmed);
  if (exact !== undefined) return exact;
  if (/^20\d\d-\d{2}-\d{2}T/iu.test(trimmed)) return undefined;

  // 1. Day precision checks
  // 1a: YYYY-MM-DD or YYYY/MM/DD
  const isoDay = text.match(
    /(?:^|\D)(20\d\d)[-/](\d{1,2})[-/](\d{1,2})(?:$|\D)/u,
  );
  if (isoDay?.[1] && isoDay[2] && isoDay[3]) {
    return {
      date: `${isoDay[1]}-${isoDay[2].padStart(2, "0")}-${isoDay[3].padStart(2, "0")}`,
      precision: "day",
    };
  }

  // 1b: YYYY年MM月DD日
  const cnDay = text.match(
    /(?:^|\D)(20\d\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u,
  );
  if (cnDay?.[1] && cnDay[2] && cnDay[3]) {
    return {
      date: `${cnDay[1]}-${cnDay[2].padStart(2, "0")}-${cnDay[3].padStart(2, "0")}`,
      precision: "day",
    };
  }

  // 1c: Month DD, YYYY or Month. DD, YYYY
  const enDay1 = text.match(
    /\b([a-zA-Z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/u,
  );
  if (enDay1?.[1] && enDay1[2] && enDay1[3]) {
    const monthNum = MONTH_NAMES[enDay1[1].toLowerCase()];
    if (monthNum !== undefined) {
      return {
        date: `${enDay1[3]}-${monthNum}-${enDay1[2].padStart(2, "0")}`,
        precision: "day",
      };
    }
  }

  // 1d: DD Month YYYY
  const enDay2 = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+)\.?,?\s+(20\d\d)\b/u,
  );
  if (enDay2?.[1] && enDay2[2] && enDay2[3]) {
    const monthNum = MONTH_NAMES[enDay2[2].toLowerCase()];
    if (monthNum !== undefined) {
      return {
        date: `${enDay2[3]}-${monthNum}-${enDay2[1].padStart(2, "0")}`,
        precision: "day",
      };
    }
  }

  // 2. Month precision checks
  // 2a: YYYY年MM月
  const cnMonth = text.match(/(?:^|\D)(20\d\d)\s*年\s*(\d{1,2})\s*月/u);
  if (cnMonth?.[1] && cnMonth[2]) {
    return {
      date: `${cnMonth[1]}-${cnMonth[2].padStart(2, "0")}`,
      precision: "month",
    };
  }

  // 2b: Month YYYY (e.g. "Apr. 2026", "August 2026")
  const enMonth = text.match(/\b([a-zA-Z]+)\.?\s+(20\d\d)\b/u);
  if (enMonth?.[1] && enMonth[2]) {
    const monthNum = MONTH_NAMES[enMonth[1].toLowerCase()];
    if (monthNum !== undefined) {
      return {
        date: `${enMonth[2]}-${monthNum}`,
        precision: "month",
      };
    }
  }

  // 2c: YYYY-MM or YYYY/MM
  const isoMonth = text.match(/(?:^|\D)(20\d\d)[-/](\d{1,2})(?:$|[^\d/-])/u);
  if (isoMonth?.[1] && isoMonth[2]) {
    return {
      date: `${isoMonth[1]}-${isoMonth[2].padStart(2, "0")}`,
      precision: "month",
    };
  }

  return undefined;
}

/** Preprocesses models.md to strip Mintlify boilerplate, frontmatter, and MDX wrappers while preserving content. */
export function preprocessModelsMarkdown(raw: string): string {
  let content = raw;

  // 1. Strip YAML frontmatter
  if (content.startsWith("---")) {
    const endMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u);
    if (endMatch) {
      content = content.slice(endMatch[0].length);
    }
  }

  // 2. Strip HTML comments
  content = content.replaceAll(/<!--[\s\S]*?-->/gu, "");

  // 3. Strip Mintlify `> ## Documentation Index` boilerplate blockquote
  content = content.replace(
    /(?:^|\r?\n)>\s*##\s*Documentation Index[^\r\n]*(?:\r?\n>[^\r\n]*)*/gi,
    "",
  );

  // 4. Strip MDX component wrappers like <Card ...>, </Card>, <Note ...>, etc.
  content = content.replace(
    /<\/?(?:Card|CardGroup|Note|Tip|Warning|Info|Accordion|AccordionGroup|Steps|Step|Tabs|Tab)\b[^>]*>/gi,
    "",
  );

  // 5. Strip `[card]` tags from blockquotes
  content = content.replace(/(?:^|\r?\n)>\s*\[card\]\s*/gi, "\n> ");
  content = content.replace(/\[card\]\s*/gi, "");

  return content.trim();
}

export type ExtractedReleaseDates = {
  readonly latestDate?: string | undefined;
  readonly datePrecision?: MinimaxDatePrecision | undefined;
  readonly observedDates: readonly string[];
};

/** Extracts date facts from headings in markdown content without fabricating timestamps or days. */
export function extractModelsReleaseDates(
  markdown: string,
): ExtractedReleaseDates {
  const lines = markdown.split("\n");
  let inCodeBlock = false;
  const observed: {
    date: string;
    precision: MinimaxDatePrecision;
  }[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (/^#{1,6}\s+/u.test(trimmed)) {
      const headingText = trimmed.replace(/^#{1,6}\s+/u, "").trim();
      const parsed = parseDateString(headingText);
      if (parsed !== undefined) {
        observed.push(parsed);
      }
    }
  }

  if (observed.length === 0) {
    return { observedDates: [] };
  }

  const seen = new Set<string>();
  const uniqueDates: string[] = [];
  for (const item of observed) {
    if (!seen.has(item.date)) {
      seen.add(item.date);
      uniqueDates.push(item.date);
    }
  }

  const sorted = [...uniqueDates].sort((a, b) => b.localeCompare(a));
  const latestDate = sorted[0];
  const datePrecision = observed.find(
    (item) => item.date === latestDate,
  )?.precision;

  return {
    ...(latestDate !== undefined ? { latestDate } : {}),
    datePrecision,
    observedDates: uniqueDates,
  };
}

export type DiscoveredArticle = {
  readonly title: string;
  readonly url: string;
  readonly pathname: string;
  readonly articlePath: string;
  readonly releaseDate?: string | undefined;
  readonly releaseDatePrecision?: MinimaxDatePrecision | undefined;
};

/** Discovers first-party detail article links from models.md, excluding external hosts and old APIs. */
export function discoverArticleLinks(
  markdown: string,
  source: MinimaxSourceDefinition,
): readonly DiscoveredArticle[] {
  const lines = markdown.split("\n");
  let inCode = false;
  let currentDate: string | undefined;
  let currentPrecision: MinimaxDatePrecision | undefined;
  const discovered: DiscoveredArticle[] = [];
  const seenUrls = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    // Track heading date context
    if (/^#{1,6}\s+/u.test(trimmed)) {
      const headingText = trimmed.replace(/^#{1,6}\s+/u, "").trim();
      const parsedDate = parseDateString(headingText);
      if (parsedDate !== undefined) {
        currentDate = parsedDate.date;
        currentPrecision = parsedDate.precision;
      }
    }

    // Match markdown links: [text](href)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/gu;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(line)) !== null) {
      const linkTitle = match[1]?.trim() ?? "";
      const href = match[2]?.trim() ?? "";
      if (!href) continue;

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(href, source.modelsReleaseUrl);
      } catch {
        continue;
      }

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        continue;
      }

      // Host must belong to allowedArticleHosts
      if (!source.allowedArticleHosts.includes(parsedUrl.hostname)) {
        continue;
      }

      // Explicitly exclude APIs release notes
      if (parsedUrl.pathname.includes("/docs/release-notes/apis")) {
        continue;
      }

      // Must point to /news/... or /blog/...
      if (!/(?:^|\/)(?:news|blog)\b/iu.test(parsedUrl.pathname)) {
        continue;
      }

      const fullUrl = parsedUrl.href;
      if (seenUrls.has(fullUrl)) {
        continue;
      }
      seenUrls.add(fullUrl);

      const articlePath = parsedUrl.pathname.replace(/^\/+/u, "");

      discovered.push({
        title: linkTitle,
        url: fullUrl,
        pathname: parsedUrl.pathname,
        articlePath,
        ...(currentDate !== undefined ? { releaseDate: currentDate } : {}),
        ...(currentPrecision !== undefined
          ? { releaseDatePrecision: currentPrecision }
          : {}),
      });
    }
  }

  return discovered;
}

type Element = parse5.DefaultTreeAdapterMap["element"];
type Node = parse5.DefaultTreeAdapterMap["node"];
type ParentNode = parse5.DefaultTreeAdapterMap["parentNode"];

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && "tagName" in node;
}

function getAttribute(el: Element, name: string): string | undefined {
  return el.attrs?.find((a) => a.name === name)?.value;
}

function getText(node: Node): string {
  if (!isElement(node)) {
    return node.nodeName === "#text" ? (node as { value: string }).value : "";
  }
  return (node.childNodes ?? []).map(getText).join("");
}

function findElements(
  root: Node | ParentNode,
  predicate: (el: Element) => boolean,
): Element[] {
  const matches: Element[] = [];
  function walk(node: Node) {
    if (isElement(node)) {
      if (predicate(node)) matches.push(node);
      for (const child of node.childNodes ?? []) {
        walk(child);
      }
    }
  }
  if ("childNodes" in root && Array.isArray(root.childNodes)) {
    for (const child of root.childNodes) {
      walk(child);
    }
  } else if (isElement(root as Node)) {
    walk(root as Node);
  }
  return matches;
}

function findMainArticleContainer(
  doc: parse5.DefaultTreeAdapterMap["document"],
): Element | undefined {
  const articles = findElements(doc, (el) => el.tagName === "article");
  if (articles[0] !== undefined) return articles[0];

  const mains = findElements(doc, (el) => el.tagName === "main");
  if (mains[0] !== undefined) return mains[0];

  const roleMains = findElements(
    doc,
    (el) => getAttribute(el, "role") === "main",
  );
  if (roleMains[0] !== undefined) return roleMains[0];

  const contentDivs = findElements(
    doc,
    (el) =>
      el.tagName === "div" &&
      (getAttribute(el, "id") === "content" ||
        getAttribute(el, "id") === "main" ||
        getAttribute(el, "class")?.includes("article") === true),
  );
  if (contentDivs[0] !== undefined) return contentDivs[0];

  const bodies = findElements(doc, (el) => el.tagName === "body");
  return bodies[0];
}

function stripUnwantedElements(container: Element): void {
  function walk(node: ParentNode) {
    if (!node.childNodes) return;
    node.childNodes = node.childNodes.filter((child) => {
      if (!isElement(child)) return true;
      const tag = child.tagName.toLowerCase();
      if (
        tag === "nav" ||
        tag === "footer" ||
        tag === "aside" ||
        tag === "script" ||
        tag === "style" ||
        tag === "noscript"
      ) {
        return false;
      }
      const cls = getAttribute(child, "class") ?? "";
      const id = getAttribute(child, "id") ?? "";
      const role = getAttribute(child, "role") ?? "";
      const combined = `${cls} ${id} ${role}`.toLowerCase();
      if (
        /\b(share|social-share|share-buttons|share-container|related|related-posts|recommend|recommendations|site-header|site-footer|global-nav)\b/iu.test(
          combined,
        )
      ) {
        return false;
      }
      return true;
    });
    for (const child of node.childNodes) {
      if (isElement(child)) {
        walk(child);
      }
    }
  }
  walk(container);
}

function extractHtmlTitle(
  doc: parse5.DefaultTreeAdapterMap["document"],
  fallbackTitle?: string,
): string | null {
  const h1s = findElements(doc, (el) => el.tagName === "h1");
  for (const h1 of h1s) {
    const text = getText(h1).trim();
    if (text.length > 0) return text;
  }
  const metas = findElements(doc, (el) => el.tagName === "meta");
  for (const m of metas) {
    const prop = (
      getAttribute(m, "property") ?? getAttribute(m, "name")
    )?.toLowerCase();
    const content = getAttribute(m, "content")?.trim();
    if ((prop === "og:title" || prop === "twitter:title") && content) {
      const cleaned = content.replace(/\s*[-–|]\s*MiniMax.*$/iu, "").trim();
      if (cleaned.length > 0) return cleaned;
    }
  }
  const titles = findElements(doc, (el) => el.tagName === "title");
  for (const t of titles) {
    const text = getText(t).trim();
    if (text.length > 0) {
      const cleaned = text.replace(/\s*[-–|]\s*MiniMax.*$/iu, "").trim();
      if (cleaned.length > 0) return cleaned;
    }
  }
  return fallbackTitle?.trim() || null;
}

interface ExtractedHtmlArticleDates {
  readonly sourcePublishedAt?: string | undefined;
  readonly sourceModifiedAt?: string | undefined;
  readonly articleContentDate?: string | undefined;
  readonly articleContentDatePrecision?: MinimaxDatePrecision | undefined;
}

function extractHtmlArticleDates(
  doc: parse5.DefaultTreeAdapterMap["document"],
): ExtractedHtmlArticleDates {
  let sourcePublishedAt: string | undefined;
  let sourceModifiedAt: string | undefined;
  let articleContentDate: string | undefined;
  let articleContentDatePrecision: MinimaxDatePrecision | undefined;

  const metas = findElements(doc, (el) => el.tagName === "meta");
  for (const meta of metas) {
    const property = (
      getAttribute(meta, "property") ?? getAttribute(meta, "name")
    )?.toLowerCase();
    const content = getAttribute(meta, "content")?.trim();
    if (property === undefined || content === undefined) continue;

    const parsed = parseDateString(content);
    if (parsed === undefined) continue;
    if (
      property === "article:published_time" ||
      property === "og:published_time" ||
      property === "publish-date" ||
      property === "pubdate"
    ) {
      sourcePublishedAt ??= parsed.date;
    } else if (
      property === "article:modified_time" ||
      property === "date-modified" ||
      property === "last-modified"
    ) {
      sourceModifiedAt ??= parsed.date;
    } else if (property === "date") {
      articleContentDate ??= parsed.date;
      articleContentDatePrecision ??= parsed.precision;
    }
  }

  const times = findElements(doc, (el) => el.tagName === "time");
  for (const time of times) {
    const dt = getAttribute(time, "datetime");
    const txt = getText(time).trim();
    const candidate = dt || txt;
    if (!candidate) continue;
    const parsed = parseDateString(candidate);
    if (parsed === undefined) continue;

    const itemprop = getAttribute(time, "itemprop")?.toLowerCase();
    const isPublished =
      itemprop === "datepublished" ||
      getAttribute(time, "pubdate") !== undefined;
    const isModified = itemprop === "datemodified";

    if (isPublished) {
      sourcePublishedAt ??= parsed.date;
    } else if (isModified) {
      sourceModifiedAt ??= parsed.date;
    } else {
      articleContentDate ??= parsed.date;
      articleContentDatePrecision ??= parsed.precision;
    }
  }

  return {
    ...(sourcePublishedAt !== undefined ? { sourcePublishedAt } : {}),
    ...(sourceModifiedAt !== undefined ? { sourceModifiedAt } : {}),
    ...(articleContentDate !== undefined ? { articleContentDate } : {}),
    ...(articleContentDatePrecision !== undefined
      ? { articleContentDatePrecision }
      : {}),
  };
}

async function fetchText(
  url: string,
  signal: AbortSignal,
  accept = "*/*",
  timeoutMs = 20_000,
): Promise<{ text: string; contentType: string | null }> {
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept,
        "user-agent": "Binny SourceAdapter/1.0 (MiniMax)",
      },
      signal: requestSignal,
    });
  } catch (error) {
    throw new Error(
      `Network request failed (${url}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} returned from ${url}`);
  }
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  return { text, contentType };
}

export type ExtractedArticle = {
  readonly title: string | null;
  readonly sourcePublishedAt?: string | undefined;
  readonly sourceModifiedAt?: string | undefined;
  readonly cleanResult: CleanContentResult;
  readonly extensions: MinimaxExtensions;
};

export async function extractArticleContent(
  article: DiscoveredArticle,
  source: MinimaxSourceDefinition,
  signal: AbortSignal,
): Promise<ExtractedArticle> {
  const { text, contentType } = await fetchText(
    article.url,
    signal,
    "text/html, application/xhtml+xml, text/markdown, text/plain, */*",
  );

  const isMarkdown =
    contentType?.toLowerCase().includes("text/markdown") ||
    contentType?.toLowerCase().includes("text/plain") ||
    article.url.endsWith(".md");

  if (isMarkdown) {
    const preprocessed = preprocessModelsMarkdown(text);
    const cleanResult = cleanContent(preprocessed, {
      format: "markdown",
      baseUrl: article.url,
    });
    if (
      !cleanResult.hasSubstantialContent ||
      cleanResult.text.trim().length === 0
    ) {
      throw new Error(`Article content at ${article.url} is empty.`);
    }

    const pageDates = extractModelsReleaseDates(text);
    const extensions: MinimaxExtensions = {
      kind: "article",
      region: source.region,
      language: source.language,
      ...(article.releaseDate !== undefined
        ? { modelsReleaseDate: article.releaseDate }
        : {}),
      ...(article.releaseDatePrecision !== undefined
        ? { modelsReleaseDatePrecision: article.releaseDatePrecision }
        : {}),
      ...(pageDates.latestDate !== undefined
        ? { latestArticleContentDate: pageDates.latestDate }
        : {}),
      ...(pageDates.datePrecision !== undefined
        ? { latestArticleContentDatePrecision: pageDates.datePrecision }
        : {}),
      ...(pageDates.observedDates.length > 0
        ? { observedArticleContentDates: [...pageDates.observedDates] }
        : {}),
    };

    return {
      title: article.title || null,
      cleanResult,
      extensions,
    };
  }

  // HTML content
  const doc = parse5.parse(text);

  // Extract title before modifying tree
  const title = extractHtmlTitle(doc, article.title);

  // Extract page date
  const pageDates = extractHtmlArticleDates(doc);

  // Locate container
  const container = findMainArticleContainer(doc);
  if (!container) {
    throw new Error(
      `Could not locate article container in HTML from ${article.url}`,
    );
  }

  // Strip unwanted elements
  stripUnwantedElements(container);

  const serialized = parse5.serialize(container);
  const cleanResult = cleanContent(serialized, {
    format: "html",
    baseUrl: article.url,
  });

  if (
    !cleanResult.hasSubstantialContent ||
    cleanResult.text.trim().length === 0
  ) {
    throw new Error(
      `Article content at ${article.url} is empty after cleaning.`,
    );
  }

  const extensions: MinimaxExtensions = {
    kind: "article",
    region: source.region,
    language: source.language,
    ...(article.releaseDate !== undefined
      ? { modelsReleaseDate: article.releaseDate }
      : {}),
    ...(article.releaseDatePrecision !== undefined
      ? { modelsReleaseDatePrecision: article.releaseDatePrecision }
      : {}),
    ...(pageDates.articleContentDate !== undefined
      ? { articleContentDate: pageDates.articleContentDate }
      : {}),
    ...(pageDates.articleContentDatePrecision !== undefined
      ? { articleContentDatePrecision: pageDates.articleContentDatePrecision }
      : {}),
  };

  return {
    title,
    sourcePublishedAt: pageDates.sourcePublishedAt,
    sourceModifiedAt: pageDates.sourceModifiedAt,
    cleanResult,
    extensions,
  };
}

export function selectedSources(
  config: MinimaxConfig,
  params: MinimaxParams,
): {
  readonly sources: readonly MinimaxSourceDefinition[];
  readonly missing: readonly string[];
} {
  if (params.sourceIds === undefined) {
    return { sources: config.sources, missing: [] };
  }
  const byId = new Map(config.sources.map((s) => [s.id, s]));
  const sources: MinimaxSourceDefinition[] = [];
  const missing: string[] = [];
  for (const id of params.sourceIds) {
    const found = byId.get(id);
    if (found === undefined) {
      missing.push(id);
    } else {
      sources.push(found);
    }
  }
  return { sources, missing };
}

export async function executeMinimaxCheck(
  context: SourceAdapterContext<MinimaxConfig, never, MinimaxExtensions>,
  params: MinimaxParams,
): Promise<z.infer<typeof checkOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const scope: string[] = [];
  const problems: z.infer<typeof checkOutputSchema>["problems"] = [];

  for (const missingId of missing) {
    problems.push({
      code: "minimax_source_not_found",
      message: `Configured source "${missingId}" was not found.`,
      impact: `Source "${missingId}" cannot be checked.`,
      path: ["sources", missingId],
      suggestion:
        "Check whether sourceIds in params match configured source IDs.",
      requiresHuman: false,
    });
  }

  for (const source of sources) {
    scope.push(source.id);
    try {
      const { text: rawModels } = await fetchText(
        source.modelsReleaseUrl,
        context.signal,
        "text/markdown, text/plain, */*",
      );
      const preprocessed = preprocessModelsMarkdown(rawModels);
      const cleanResult = cleanContent(preprocessed, {
        format: "markdown",
        baseUrl: source.modelsReleaseUrl,
      });
      if (
        !cleanResult.hasSubstantialContent ||
        cleanResult.text.trim().length === 0
      ) {
        throw new Error(
          `Models release document for "${source.id}" is empty after cleaning.`,
        );
      }

      // Discover linked first-party articles and validate extraction on the first one if present
      const discovered = discoverArticleLinks(rawModels, source);
      if (discovered[0] !== undefined) {
        await extractArticleContent(discovered[0], source, context.signal);
      }
    } catch (error) {
      problems.push({
        code: "minimax_source_unavailable",
        message:
          error instanceof Error
            ? error.message
            : `Availability check failed for source "${source.id}".`,
        impact: `MiniMax source "${source.id}" is currently unreachable or has invalid content.`,
        path: ["sources", source.id],
        suggestion:
          "Verify network accessibility and document formatting for the source.",
        requiresHuman: false,
      });
    }
  }

  const availability =
    problems.length === 0 ? ("available" as const) : ("unavailable" as const);
  return {
    availability,
    scope,
    basis:
      problems.length === 0
        ? `Successfully checked ${scope.length} MiniMax regional sources and sample content.`
        : `MiniMax availability check encountered ${problems.length} problem(s).`,
    problems,
  };
}

export async function executeMinimaxSync(
  context: SourceAdapterContext<MinimaxConfig, never, MinimaxExtensions>,
  params: MinimaxParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];
  const problems: ManualRunFailure[] = [];

  for (const missingId of missing) {
    problems.push({
      code: "minimax_source_not_found",
      message: `Configured source "${missingId}" was not found.`,
      impact: `Source "${missingId}" cannot be synchronized.`,
      path: ["sources", missingId],
      suggestion:
        "Check whether sourceIds in params match configured source IDs.",
      requiresHuman: false,
    });
  }

  const state = await loadIncrementalSyncState(context);

  for (const source of sources) {
    try {
      const isInitialized = isIncrementalScopeInitialized(
        state,
        source.id,
        source.modelsReleaseUrl,
      );

      const { text: rawModels } = await fetchText(
        source.modelsReleaseUrl,
        context.signal,
        "text/markdown, text/plain, */*",
      );
      const preprocessed = preprocessModelsMarkdown(rawModels);
      const cleanResult = cleanContent(preprocessed, {
        format: "markdown",
        baseUrl: source.modelsReleaseUrl,
      });
      if (
        !cleanResult.hasSubstantialContent ||
        cleanResult.text.trim().length === 0
      ) {
        throw new Error(
          `Models release document for "${source.id}" is empty after cleaning.`,
        );
      }

      const contentHash = computeOngoingDocumentHash(
        cleanResult.markdown,
        cleanResult.text,
      );
      const dates = extractModelsReleaseDates(rawModels);
      const discoveredArticles = discoverArticleLinks(rawModels, source);

      const releaseNotesTitle =
        source.region === "cn"
          ? "MiniMax 模型发布记录"
          : "MiniMax Model Release Notes";

      const releaseNotesExtensions: MinimaxExtensions = {
        kind: "release-notes",
        region: source.region,
        language: source.language,
        ...(dates.latestDate !== undefined
          ? { latestReleaseEntryDate: dates.latestDate }
          : {}),
        ...(dates.datePrecision !== undefined
          ? { latestReleaseEntryDatePrecision: dates.datePrecision }
          : {}),
        ...(dates.observedDates.length > 0
          ? { observedReleaseEntryDates: [...dates.observedDates] }
          : {}),
      };

      if (!isInitialized) {
        // First sync establishes baseline state WITHOUT submitting archive items or fetching historical detail articles
        const initialEntries: Record<string, IncrementalEntryRecord> = {};
        for (const article of discoveredArticles) {
          const articleKey = `article:${article.articlePath}`;
          const fingerprint = computeOngoingDocumentHash(
            article.url,
            (article.title ?? "") + (article.releaseDate ?? ""),
          );
          initialEntries[articleKey] = {
            fingerprint,
            archivedCompleteness: "baseline",
          };
        }

        initializeIncrementalScope(state, source.id, {
          scopeUrl: source.modelsReleaseUrl,
          initializedAt: context.referenceTime,
          ongoingDocuments: {
            "release-notes:models": {
              contentHash,
              updatedAt: context.referenceTime,
            },
          },
          entries: initialEntries,
        });
        initializedScopes.push(source.id);
        completedScopes.push(source.id);
      } else {
        // Subsequent sync: check if models.md ongoing document changed
        const previousDoc = getIncrementalScopeOngoingDocument(
          state,
          source.id,
          "release-notes:models",
        );
        const modelsChanged = hasOngoingDocumentChanged(
          previousDoc,
          contentHash,
        );

        if (modelsChanged) {
          await submitCleanedArticle(context, {
            sourceKey: {
              namespace: `minimax:${source.region}`,
              key: "release-notes:models",
            },
            sourceRef: source.modelsReleaseUrl,
            title: releaseNotesTitle,
            sourcePublishedAt: null,
            sourceModifiedAt: null,
            extensions: releaseNotesExtensions,
            cleanResult,
            captureScope: {
              sourceId: source.id,
              region: source.region,
              kind: "release-notes",
              url: source.modelsReleaseUrl,
            },
          });
          upsertIncrementalScopeOngoingDocument(
            state,
            source.id,
            "release-notes:models",
            {
              contentHash,
              updatedAt: context.referenceTime,
            },
          );
        }

        // For any newly added or fingerprint-changed first-party article link in models.md, fetch and submit it
        const currentScopeEntries = state.scopes[source.id]?.entries ?? {};
        for (const article of discoveredArticles) {
          const articleKey = `article:${article.articlePath}`;
          const fingerprint = computeOngoingDocumentHash(
            article.url,
            (article.title ?? "") + (article.releaseDate ?? ""),
          );
          const previousEntry = currentScopeEntries[articleKey];
          const entryChanged = hasIncrementalEntryChanged(
            previousEntry,
            fingerprint,
          );

          if (entryChanged) {
            const articleContent = await extractArticleContent(
              article,
              source,
              context.signal,
            );
            await submitCleanedArticle(context, {
              sourceKey: {
                namespace: `minimax:${source.region}`,
                key: articleKey,
              },
              sourceRef: article.url,
              title: articleContent.title,
              sourcePublishedAt: sourceTimeFrom(
                articleContent.sourcePublishedAt,
              ),
              sourceModifiedAt: sourceTimeFrom(articleContent.sourceModifiedAt),
              extensions: articleContent.extensions,
              cleanResult: articleContent.cleanResult,
              captureScope: {
                sourceId: source.id,
                region: source.region,
                kind: "article",
                url: article.url,
                articlePath: article.articlePath,
              },
            });
            upsertIncrementalScopeEntry(state, source.id, articleKey, {
              fingerprint,
              updatedAt: context.referenceTime,
              archivedCompleteness: "complete",
            });
          }
        }

        updateIncrementalScopeValidators(state, source.id, {
          scopeUrl: source.modelsReleaseUrl,
        });
        completedScopes.push(source.id);
      }
    } catch (error) {
      problems.push({
        code: "minimax_sync_incomplete",
        message: `Synchronization failed for source "${source.id}": ${error instanceof Error ? error.message : String(error)}`,
        impact: `Source "${source.id}" failed to complete incremental sync.`,
        path: ["sources", source.id],
        suggestion:
          "Verify network accessibility and source formatting before retrying.",
        requiresHuman: false,
      });
    }
  }

  await saveIncrementalSyncState(context, state);

  if (problems.length > 0) {
    const firstProblem = problems[0];
    if (firstProblem !== undefined) {
      throw sourceAdapterActionError(firstProblem, completedScopes);
    }
  }

  return {
    completedScopes,
    ...(initializedScopes.length > 0 ? { initializedScopes } : {}),
  };
}

export async function executeMinimaxCollect(
  context: SourceAdapterContext<MinimaxConfig, never, MinimaxExtensions>,
  params: MinimaxParams,
): Promise<z.infer<typeof collectOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const completedScopes: string[] = [];
  const problems: ManualRunFailure[] = [];

  for (const missingId of missing) {
    problems.push({
      code: "minimax_source_not_found",
      message: `Configured source "${missingId}" was not found.`,
      impact: `Source "${missingId}" cannot be collected.`,
      path: ["sources", missingId],
      suggestion:
        "Check whether sourceIds in params match configured source IDs.",
      requiresHuman: false,
    });
  }

  let state: IncrementalSyncState | undefined;
  if (context.persistentState !== undefined) {
    try {
      state = await loadIncrementalSyncState(context);
    } catch {
      // Optional or uninitialized persistent state during explicit collect
    }
  }

  for (const source of sources) {
    try {
      const { text: rawModels } = await fetchText(
        source.modelsReleaseUrl,
        context.signal,
        "text/markdown, text/plain, */*",
      );
      const preprocessed = preprocessModelsMarkdown(rawModels);
      const cleanResult = cleanContent(preprocessed, {
        format: "markdown",
        baseUrl: source.modelsReleaseUrl,
      });
      if (
        !cleanResult.hasSubstantialContent ||
        cleanResult.text.trim().length === 0
      ) {
        throw new Error(
          `Models release document for "${source.id}" is empty after cleaning.`,
        );
      }

      const contentHash = computeOngoingDocumentHash(
        cleanResult.markdown,
        cleanResult.text,
      );
      const dates = extractModelsReleaseDates(rawModels);
      const discoveredArticles = discoverArticleLinks(rawModels, source);

      const releaseNotesTitle =
        source.region === "cn"
          ? "MiniMax 模型发布记录"
          : "MiniMax Model Release Notes";

      const releaseNotesExtensions: MinimaxExtensions = {
        kind: "release-notes",
        region: source.region,
        language: source.language,
        ...(dates.latestDate !== undefined
          ? { latestReleaseEntryDate: dates.latestDate }
          : {}),
        ...(dates.datePrecision !== undefined
          ? { latestReleaseEntryDatePrecision: dates.datePrecision }
          : {}),
        ...(dates.observedDates.length > 0
          ? { observedReleaseEntryDates: [...dates.observedDates] }
          : {}),
      };

      // Archive whole-page models release notes unless itemUrls excludes it
      const shouldArchiveModelsDoc =
        params.itemUrls === undefined ||
        params.itemUrls.includes(source.modelsReleaseUrl);

      if (shouldArchiveModelsDoc) {
        await submitCleanedArticle(context, {
          sourceKey: {
            namespace: `minimax:${source.region}`,
            key: "release-notes:models",
          },
          sourceRef: source.modelsReleaseUrl,
          title: releaseNotesTitle,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: releaseNotesExtensions,
          cleanResult,
          captureScope: {
            sourceId: source.id,
            region: source.region,
            kind: "release-notes",
            url: source.modelsReleaseUrl,
          },
        });

        if (state !== undefined) {
          upsertIncrementalScopeOngoingDocument(
            state,
            source.id,
            "release-notes:models",
            {
              contentHash,
              updatedAt: context.referenceTime,
            },
          );
        }
      }

      // Filter articles by itemUrls if specified
      let targetArticles = discoveredArticles;
      if (params.itemUrls !== undefined) {
        targetArticles = targetArticles.filter((a) =>
          params.itemUrls!.includes(a.url),
        );
      }
      if (params.maxItems !== undefined) {
        targetArticles = targetArticles.slice(0, params.maxItems);
      }

      for (const article of targetArticles) {
        const articleContent = await extractArticleContent(
          article,
          source,
          context.signal,
        );
        const articleKey = `article:${article.articlePath}`;
        await submitCleanedArticle(context, {
          sourceKey: {
            namespace: `minimax:${source.region}`,
            key: articleKey,
          },
          sourceRef: article.url,
          title: articleContent.title,
          sourcePublishedAt: sourceTimeFrom(articleContent.sourcePublishedAt),
          sourceModifiedAt: sourceTimeFrom(articleContent.sourceModifiedAt),
          extensions: articleContent.extensions,
          cleanResult: articleContent.cleanResult,
          captureScope: {
            sourceId: source.id,
            region: source.region,
            kind: "article",
            url: article.url,
            articlePath: article.articlePath,
          },
        });

        if (state !== undefined) {
          const fingerprint = computeOngoingDocumentHash(
            article.url,
            (article.title ?? "") + (article.releaseDate ?? ""),
          );
          upsertIncrementalScopeEntry(state, source.id, articleKey, {
            fingerprint,
            updatedAt: context.referenceTime,
            archivedCompleteness: "complete",
          });
        }
      }

      completedScopes.push(source.id);
    } catch (error) {
      problems.push({
        code: "minimax_collection_incomplete",
        message: `Collection failed for source "${source.id}": ${error instanceof Error ? error.message : String(error)}`,
        impact: `Source "${source.id}" failed to complete collection.`,
        path: ["sources", source.id],
        suggestion:
          "Verify network accessibility and content formatting before retrying.",
        requiresHuman: false,
      });
    }
  }

  if (state !== undefined && context.persistentState !== undefined) {
    await saveIncrementalSyncState(context, state);
  }

  if (problems.length > 0) {
    const firstProblem = problems[0];
    if (firstProblem !== undefined) {
      throw sourceAdapterActionError(firstProblem, completedScopes);
    }
  }

  return { completedScopes };
}

export const sourceAdapter = defineSourceAdapter({
  id: "minimax",
  version: "0.1.0",
  description:
    "MiniMax regional model releases and first-party blog details source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Check MiniMax model releases and article availability.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: executeMinimaxCheck,
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Collect MiniMax model releases and linked first-party articles.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: executeMinimaxCollect,
    }),
    sync: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Incrementally synchronize MiniMax model releases and new first-party articles.",
      params: paramsSchema,
      output: syncOutputSchema,
      execute: executeMinimaxSync,
    }),
  },
});
