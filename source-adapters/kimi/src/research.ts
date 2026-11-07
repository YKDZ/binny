// Kimi regional research articles fetching, extraction, date preservation, and sync/collect actions.
import { createHash } from "node:crypto";

import {
  cleanContent,
  hasIncrementalEntryChanged,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  submitCleanedArticle,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  type CleanContentResult,
  type IncrementalEntryRecord,
  type IncrementalSyncState,
  type JsonObject,
  type ManualRunFailure,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import * as parse5 from "parse5";
import type { z } from "zod";

import type {
  ActionParams,
  checkOutputSchema,
  KimiConfig,
  KimiSourceDefinition,
} from "./changelog.ts";
import { MONTH_NAMES } from "./changelog.ts";

export type CheckProblem = z.infer<
  typeof checkOutputSchema
>["problems"][number];

/** Checks whether an HTML response is an SPA empty shell or an error page. */
export function isResearchHtmlSpaShellOrErrorPage(text: string): boolean {
  if (
    /<div\s+id=["'](root|app|__next)["']\s*>\s*<\/div>/iu.test(text) &&
    !/<(main|article)[\s>]/iu.test(text)
  ) {
    return true;
  }
  if (
    /<title[^>]*>.*?(404|not\s+found|error|forbidden|access\s+denied|页面不存在|错误).*?<\/title>/iu.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

export type InSiteResearchArticle = {
  readonly isExternal: false;
  readonly slug: string;
  readonly url: string;
  readonly title: string;
  readonly publishedDate?: string | undefined;
};

export type ExternalResearchCard = {
  readonly isExternal: true;
  readonly url: string;
  readonly title: string;
  readonly publishedDate?: string | undefined;
};

export type DiscoveredResearchBlogList = {
  readonly inSiteArticles: readonly InSiteResearchArticle[];
  readonly externalCards: readonly ExternalResearchCard[];
};

export type ExtractedResearchArticle = {
  readonly title: string;
  readonly cleanResult: CleanContentResult;
  readonly canonicalUrl?: string | undefined;
  readonly dateModified?: string | undefined;
  readonly datePublished?: string | undefined;
};

/** Computes a SHA-256 fingerprint from JSON-serializable item metadata. */
export function computeFingerprint(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

/** Builds strict regional and language separated sourceKey for research articles. */
export function buildResearchSourceKey(
  source: KimiSourceDefinition,
  slug: string,
): {
  readonly namespace: string;
  readonly key: string;
} {
  return {
    namespace: `kimi:${source.region}:${source.language}`,
    key: `research:${slug}`,
  };
}

/** Parses day-precision date strings (YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD, Chinese/English formats). */
export function parseDayDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();

  // 1. ISO string with time e.g. 2026-10-24T...
  const isoFullMatch = trimmed.match(/^(20\d\d)-(\d{2})-(\d{2})T/u);
  if (isoFullMatch?.[1] && isoFullMatch[2] && isoFullMatch[3]) {
    return `${isoFullMatch[1]}-${isoFullMatch[2]}-${isoFullMatch[3]}`;
  }

  // 2. YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD
  const isoDayMatch = trimmed.match(
    /(?:^|\D)(20\d\d)[-./](\d{1,2})[-./](\d{1,2})(?:$|\D)/u,
  );
  if (isoDayMatch?.[1] && isoDayMatch[2] && isoDayMatch[3]) {
    return `${isoDayMatch[1]}-${isoDayMatch[2].padStart(2, "0")}-${isoDayMatch[3].padStart(2, "0")}`;
  }

  // 3. YYYY年MM月DD日
  const cnDayMatch = trimmed.match(
    /(?:^|\D)(20\d\d)年(\d{1,2})月(\d{1,2})日?(?:$|\D)/u,
  );
  if (cnDayMatch?.[1] && cnDayMatch[2] && cnDayMatch[3]) {
    return `${cnDayMatch[1]}-${cnDayMatch[2].padStart(2, "0")}-${cnDayMatch[3].padStart(2, "0")}`;
  }

  // 4. Month DD, YYYY
  const enDayMatch = trimmed.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/iu,
  );
  if (enDayMatch?.[1] && enDayMatch[2] && enDayMatch[3]) {
    const m = MONTH_NAMES[enDayMatch[1].toLowerCase()];
    if (m !== undefined) {
      return `${enDayMatch[3]}-${m}-${enDayMatch[2].padStart(2, "0")}`;
    }
  }

  return undefined;
}

type Node = parse5.DefaultTreeAdapterMap["node"];
type Element = parse5.DefaultTreeAdapterMap["element"];
type ParentNode = parse5.DefaultTreeAdapterMap["parentNode"];

function isElement(node: Node): node is Element {
  return parse5.defaultTreeAdapter.isElementNode(node);
}

function isParentNode(node: Node): node is ParentNode {
  return (
    "childNodes" in node &&
    Array.isArray((node as { childNodes?: unknown }).childNodes)
  );
}

function getNodeAttr(node: Node, attrName: string): string | undefined {
  if (!isElement(node)) return undefined;
  return node.attrs.find((a) => a.name === attrName)?.value;
}

function getNodeText(node: Node): string {
  if (parse5.defaultTreeAdapter.isTextNode(node)) {
    return node.value;
  }
  if (!isParentNode(node)) return "";
  const childNodes = parse5.defaultTreeAdapter.getChildNodes(node);
  if (!childNodes || childNodes.length === 0) return "";
  return childNodes.map(getNodeText).join("");
}

function findNodes(
  node: Node,
  predicate: (node: Node) => boolean,
  result: Node[] = [],
): Node[] {
  if (predicate(node)) {
    result.push(node);
  }
  if (isParentNode(node)) {
    const childNodes = parse5.defaultTreeAdapter.getChildNodes(node);
    for (const child of childNodes) {
      findNodes(child, predicate, result);
    }
  }
  return result;
}

function removeNodes(node: Node, predicate: (node: Node) => boolean): void {
  if (!isParentNode(node)) return;
  const childNodes = parse5.defaultTreeAdapter.getChildNodes(node);
  for (let i = childNodes.length - 1; i >= 0; i--) {
    const child = childNodes[i];
    if (!child) continue;
    if (predicate(child)) {
      childNodes.splice(i, 1);
    } else {
      removeNodes(child, predicate);
    }
  }
}

/** Fetches HTML text from Kimi research endpoints. */
export async function fetchResearchHtml(
  url: string,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ readonly rawText: string; readonly contentType: string | null }> {
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "text/html, application/xhtml+xml, */*",
        "user-agent": "Binny SourceAdapter/1.0 (Kimi)",
      },
      signal: requestSignal,
    });
  } catch (error) {
    throw new Error(
      `网络请求失败（${url}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new Error(`请求「${url}」返回 HTTP ${response.status}。`);
  }
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  return { rawText: text, contentType };
}

/** Parses research blog list HTML, identifying in-site articles vs external project cards. */
export function parseResearchBlogList(
  html: string,
  baseUrl: string,
  source: KimiSourceDefinition,
): DiscoveredResearchBlogList {
  if (isResearchHtmlSpaShellOrErrorPage(html)) {
    throw new Error(
      `信源「${source.id}」返回了 HTML SPA 外壳或错误页，而非研究博客列表。`,
    );
  }

  const doc = parse5.parse(html);
  const mains = findNodes(doc, (n) => isElement(n) && n.nodeName === "main");
  const root = mains[0] ?? doc;

  const links = findNodes(root, (n) => isElement(n) && n.nodeName === "a");
  const base = new URL(baseUrl);

  const inSiteArticles: InSiteResearchArticle[] = [];
  const externalCards: ExternalResearchCard[] = [];
  const seenSlugs = new Set<string>();
  const seenExternalUrls = new Set<string>();

  for (const a of links) {
    const href = getNodeAttr(a, "href")?.trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
      continue;
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(href, base);
    } catch {
      continue;
    }

    const cleanPath = targetUrl.pathname.replace(/\/+$/u, "");
    const baseCleanPath = base.pathname.replace(/\/+$/u, "");
    // Ignore global navigation, language switchers, and home links
    if (
      cleanPath === "" ||
      cleanPath === "/blog" ||
      cleanPath === "/en/blog" ||
      cleanPath === "/en" ||
      cleanPath === "/zh" ||
      cleanPath === "/feed" ||
      cleanPath === "/rss" ||
      cleanPath === baseCleanPath
    ) {
      continue;
    }

    const container = parse5.defaultTreeAdapter.getParentNode(a) ?? a;

    // Title extraction from container or anchor
    const titleEl = findNodes(
      container,
      (n) =>
        isElement(n) &&
        (getNodeAttr(n, "class")?.includes("card-title") ?? false),
    )[0];
    const ariaLabel = getNodeAttr(a, "aria-label")?.trim();
    const headingEl = findNodes(
      container,
      (n) =>
        isElement(n) &&
        ["h1", "h2", "h3", "h4", "h5", "h6"].includes(n.nodeName),
    )[0];
    const textInside = getNodeText(a).trim();

    const title =
      (titleEl ? getNodeText(titleEl).trim() : null) ||
      ariaLabel ||
      (headingEl ? getNodeText(headingEl).trim() : null) ||
      (textInside.length > 0 ? textInside : null) ||
      "Untitled";

    // Date extraction from card-date element or container text
    const dateEl = findNodes(
      container,
      (n) =>
        isElement(n) &&
        (getNodeAttr(n, "class")?.includes("card-date") ?? false),
    )[0];
    const rawDateText = dateEl ? getNodeText(dateEl) : getNodeText(container);
    const publishedDate = parseDayDate(rawDateText);

    // Identity check: in-site article vs external card
    const isSameHost =
      targetUrl.host === base.host ||
      (targetUrl.hostname.endsWith("kimi.com") &&
        base.hostname.endsWith("kimi.com")) ||
      (targetUrl.hostname.endsWith("kimi.ai") &&
        base.hostname.endsWith("kimi.ai"));

    const inSiteMatch = targetUrl.pathname.match(
      /(?:^|\/)(?:en\/)?blog\/([a-zA-Z0-9_.-]+)\/?$/u,
    );

    if (
      isSameHost &&
      inSiteMatch?.[1] &&
      !["blog", "en", "tags", "categories"].includes(inSiteMatch[1])
    ) {
      const slug = inSiteMatch[1];
      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        inSiteArticles.push({
          isExternal: false,
          slug,
          url: targetUrl.href,
          title,
          ...(publishedDate !== undefined ? { publishedDate } : {}),
        });
      }
    } else {
      if (!seenExternalUrls.has(targetUrl.href)) {
        seenExternalUrls.add(targetUrl.href);
        externalCards.push({
          isExternal: true,
          url: targetUrl.href,
          title,
          ...(publishedDate !== undefined ? { publishedDate } : {}),
        });
      }
    }
  }

  return { inSiteArticles, externalCards };
}

/** Extracts article content, dates, and canonical tags from in-site research article detail HTML. */
export function extractResearchArticle(
  html: string,
  articleUrl: string,
  fallbackTitle?: string,
): ExtractedResearchArticle {
  if (isResearchHtmlSpaShellOrErrorPage(html)) {
    throw new Error(`文章「${articleUrl}」返回了 HTML SPA 外壳或错误页。`);
  }

  const doc = parse5.parse(html);

  // 1. Observed canonical URL
  const canonicalLink = findNodes(
    doc,
    (n) =>
      isElement(n) &&
      n.nodeName === "link" &&
      getNodeAttr(n, "rel") === "canonical",
  )[0];
  const canonicalUrl = canonicalLink
    ? getNodeAttr(canonicalLink, "href")?.trim()
    : undefined;

  // 2. Structured data from JSON-LD
  let dateModified: string | undefined;
  let datePublished: string | undefined;
  let ldHeadline: string | undefined;

  const ldScripts = findNodes(
    doc,
    (n) =>
      isElement(n) &&
      n.nodeName === "script" &&
      getNodeAttr(n, "type") === "application/ld+json",
  );

  for (const script of ldScripts) {
    try {
      const parsed = JSON.parse(getNodeText(script)) as unknown;
      const candidates: unknown[] = [];
      if (
        parsed &&
        typeof parsed === "object" &&
        "@graph" in parsed &&
        Array.isArray(parsed["@graph"])
      ) {
        candidates.push(...parsed["@graph"]);
      } else {
        candidates.push(parsed);
      }

      for (const item of candidates) {
        if (!item || typeof item !== "object") continue;
        const itemRecord = item as Record<string, unknown>;
        const rawType = itemRecord["@type"];
        const typeStr = typeof rawType === "string" ? rawType : "";
        if (
          ["Article", "NewsArticle", "TechArticle", "BlogPosting"].includes(
            typeStr,
          )
        ) {
          if (
            typeof itemRecord["dateModified"] === "string" &&
            itemRecord["dateModified"].length > 0
          ) {
            dateModified = parseDayDate(itemRecord["dateModified"]);
          }
          if (
            typeof itemRecord["datePublished"] === "string" &&
            itemRecord["datePublished"].length > 0
          ) {
            datePublished = parseDayDate(itemRecord["datePublished"]);
          }
          if (
            typeof itemRecord["headline"] === "string" &&
            itemRecord["headline"].length > 0
          ) {
            ldHeadline = itemRecord["headline"].trim();
          }
        }
      }
    } catch {
      // Ignore JSON parse errors in invalid JSON-LD scripts
    }
  }

  // 3. Fallback meta dates
  if (dateModified === undefined) {
    const metaMod = findNodes(
      doc,
      (n) =>
        isElement(n) &&
        n.nodeName === "meta" &&
        getNodeAttr(n, "property") === "article:modified_time",
    )[0];
    if (metaMod) {
      dateModified = parseDayDate(getNodeAttr(metaMod, "content"));
    }
  }

  if (datePublished === undefined) {
    const metaPub = findNodes(
      doc,
      (n) =>
        isElement(n) &&
        n.nodeName === "meta" &&
        getNodeAttr(n, "property") === "article:published_time",
    )[0];
    if (metaPub) {
      datePublished = parseDayDate(getNodeAttr(metaPub, "content"));
    }
  }

  // 4. Locate article container
  const mainContainers = findNodes(
    doc,
    (n) => isElement(n) && (n.nodeName === "main" || n.nodeName === "article"),
  );
  const container = mainContainers[0];
  if (!container || !isElement(container)) {
    throw new Error(
      `信源文章「${articleUrl}」中未找到 <main> 或 <article> 正文容器。`,
    );
  }

  // 5. Title extraction
  const h1 = findNodes(
    container,
    (n) => isElement(n) && n.nodeName === "h1",
  )[0];
  const titleEl = findNodes(
    doc,
    (n) => isElement(n) && n.nodeName === "title",
  )[0];
  const docTitle = titleEl
    ? getNodeText(titleEl)
        .replace(/\s*[-|]\s*Kimi.*$/iu, "")
        .trim()
    : undefined;

  const title =
    (h1 ? getNodeText(h1).trim() : null) ||
    ldHeadline ||
    (docTitle && docTitle.length > 0 ? docTitle : null) ||
    fallbackTitle ||
    "Untitled";

  // 6. Strip unwanted elements (scripts, styles, headers, navs, footers, mini-navs, language switchers)
  removeNodes(container, (n) => {
    if (!isElement(n)) return false;
    if (["script", "style", "header", "nav", "footer"].includes(n.nodeName)) {
      return true;
    }
    const cls = getNodeAttr(n, "class") ?? "";
    if (
      cls.includes("miniNav") ||
      cls.includes("BlogV2MiniNav") ||
      cls.includes("lang-switch") ||
      cls.includes("language-switch")
    ) {
      return true;
    }
    return false;
  });

  const bodyHtml = parse5.serialize(container);
  const cleanResult = cleanContent(bodyHtml, {
    format: "html",
    baseUrl: articleUrl,
  });

  if (
    !cleanResult.hasSubstantialContent ||
    cleanResult.text.trim().length === 0
  ) {
    throw new Error(`文章「${articleUrl}」正文内容为空或未包含实质性正文。`);
  }

  return {
    title,
    cleanResult,
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    ...(dateModified !== undefined ? { dateModified } : {}),
    ...(datePublished !== undefined ? { datePublished } : {}),
  };
}

/** Checks research source accessibility and verifies sample article extraction. */
export async function checkResearchSource(
  source: KimiSourceDefinition,
  context: SourceAdapterContext<KimiConfig>,
  problems: CheckProblem[],
): Promise<void> {
  let listHtml: string;
  try {
    const { rawText } = await fetchResearchHtml(source.url, context.signal);
    if (isResearchHtmlSpaShellOrErrorPage(rawText)) {
      throw new Error(`信源「${source.id}」返回了 HTML SPA 外壳或错误页。`);
    }
    listHtml = rawText;
  } catch (error) {
    problems.push({
      code: "kimi_research_unavailable",
      message:
        error instanceof Error
          ? error.message
          : `信源「${source.id}」列表页访问失败。`,
      impact: `Kimi 研究信源「${source.id}」当前不可达或响应格式错误。`,
      path: ["sources", source.id],
      suggestion: "检查信源 URL 是否可访问以及网络连通性。",
      requiresHuman: false,
    });
    return;
  }

  let blogList: DiscoveredResearchBlogList;
  try {
    blogList = parseResearchBlogList(listHtml, source.url, source);
  } catch (error) {
    problems.push({
      code: "kimi_research_unavailable",
      message:
        error instanceof Error
          ? error.message
          : `信源「${source.id}」列表解析失败。`,
      impact: `未能从「${source.id}」提取任何博客卡片。`,
      path: ["sources", source.id],
      suggestion: "检查 Kimi 研究博客列表页的 HTML 结构。",
      requiresHuman: false,
    });
    return;
  }

  if (blogList.inSiteArticles.length === 0) {
    problems.push({
      code: "kimi_research_unavailable",
      message: `信源「${source.id}」列表页未发现任何站内研究文章。`,
      impact: `信源「${source.id}」无可用文章。`,
      path: ["sources", source.id],
      suggestion: "检查页面是否包含可识别的站内文章卡片。",
      requiresHuman: false,
    });
    return;
  }

  // Validate the first in-site article
  const sampleArticle = blogList.inSiteArticles[0]!;
  try {
    const { rawText: articleHtml } = await fetchResearchHtml(
      sampleArticle.url,
      context.signal,
    );
    if (isResearchHtmlSpaShellOrErrorPage(articleHtml)) {
      throw new Error(
        `文章「${sampleArticle.url}」返回了 HTML SPA 外壳或错误页。`,
      );
    }
    const extracted = extractResearchArticle(
      articleHtml,
      sampleArticle.url,
      sampleArticle.title,
    );
    if (
      !extracted.cleanResult.hasSubstantialContent ||
      extracted.cleanResult.text.trim().length === 0
    ) {
      throw new Error(`文章「${sampleArticle.url}」正文为空或无实质性内容。`);
    }
  } catch (error) {
    problems.push({
      code: "kimi_research_unavailable",
      message:
        error instanceof Error
          ? error.message
          : `信源「${source.id}」抽样文章解析失败。`,
      impact: `文章「${sampleArticle.url}」无法提取有效正文。`,
      path: ["sources", source.id, sampleArticle.slug],
      suggestion: "检查文章页面 HTML 结构与提取规则。",
      requiresHuman: false,
    });
  }
}

/** Synchronizes Kimi research articles: establishes baseline on first run without detail fetch, or archives new/modified articles. */
export async function syncResearchSource(
  source: KimiSourceDefinition,
  context: SourceAdapterContext<KimiConfig>,
  state: IncrementalSyncState,
  initializedScopes: string[],
  completedScopes: string[],
  problems: ManualRunFailure[],
): Promise<void> {
  const isInitialized = isIncrementalScopeInitialized(
    state,
    source.id,
    source.url,
  );

  let listHtml: string;
  try {
    const { rawText } = await fetchResearchHtml(source.url, context.signal);
    if (isResearchHtmlSpaShellOrErrorPage(rawText)) {
      throw new Error(`信源「${source.id}」返回了 HTML SPA 外壳或错误页。`);
    }
    listHtml = rawText;
  } catch (error) {
    problems.push({
      code: "kimi_sync_incomplete",
      message: `信源「${source.id}」同步失败：${error instanceof Error ? error.message : String(error)}`,
      impact: `信源「${source.id}」列表页获取失败，未推进增量状态。`,
      path: ["sources", source.id],
      suggestion: "检查网络连通性后重试。",
      requiresHuman: false,
    });
    return;
  }

  const blogList = parseResearchBlogList(listHtml, source.url, source);

  if (!isInitialized) {
    // Initial sync establishes baseline WITHOUT fetching detail HTML or archiving
    const entries: Record<string, IncrementalEntryRecord> = {};
    for (const item of blogList.inSiteArticles) {
      const fingerprint = computeFingerprint({
        slug: item.slug,
        title: item.title,
        publishedDate: item.publishedDate,
      });
      entries[item.slug] = {
        fingerprint,
        ...(item.publishedDate ? { publishedAt: item.publishedDate } : {}),
        archivedCompleteness: "baseline",
      };
    }

    initializeIncrementalScope(state, source.id, {
      scopeUrl: source.url,
      initializedAt: context.referenceTime,
      entries,
    });
    initializedScopes.push(source.id);
    completedScopes.push(source.id);
    return;
  }

  // Subsequent sync: only fetch and archive new or changed in-site articles
  let hasArticleFailure = false;
  for (const item of blogList.inSiteArticles) {
    const previousEntry = state.scopes[source.id]?.entries[item.slug];
    const fingerprint = computeFingerprint({
      slug: item.slug,
      title: item.title,
      publishedDate: item.publishedDate,
    });

    const changed = hasIncrementalEntryChanged(previousEntry, fingerprint);

    if (!changed) {
      continue;
    }

    try {
      const { rawText: articleHtml } = await fetchResearchHtml(
        item.url,
        context.signal,
      );
      if (isResearchHtmlSpaShellOrErrorPage(articleHtml)) {
        throw new Error(`文章「${item.url}」返回了 HTML SPA 外壳或错误页。`);
      }
      const extracted = extractResearchArticle(
        articleHtml,
        item.url,
        item.title,
      );

      const metadata: JsonObject = {
        documentKind: "research",
        region: source.region,
        language: source.language,
        slug: item.slug,
        ...(item.publishedDate !== undefined
          ? { publishedDate: item.publishedDate }
          : {}),
        ...(extracted.dateModified !== undefined
          ? { modifiedDate: extracted.dateModified }
          : {}),
        ...(extracted.canonicalUrl !== undefined
          ? { canonicalUrl: extracted.canonicalUrl }
          : {}),
        datePrecision: "day",
      };

      await submitCleanedArticle(context, {
        sourceKey: buildResearchSourceKey(source, item.slug),
        sourceRef: item.url,
        title: extracted.title,
        sourceModifiedAt: undefined,
        metadata,
        properties: {
          title: extracted.title,
        },
        cleanResult: extracted.cleanResult,
        captureScope: {
          sourceId: source.id,
          region: source.region,
          kind: source.kind,
          url: item.url,
        },
      });

      upsertIncrementalScopeEntry(state, source.id, item.slug, {
        fingerprint,
        ...(item.publishedDate !== undefined
          ? { publishedAt: item.publishedDate }
          : {}),
        archivedCompleteness: "complete",
      });
    } catch (error) {
      hasArticleFailure = true;
      problems.push({
        code: "kimi_sync_incomplete",
        message: `文章「${item.url}」同步采集失败：${error instanceof Error ? error.message : String(error)}`,
        impact: `文章「${item.slug}」未能归档，状态未更新。`,
        path: ["sources", source.id, item.slug],
        suggestion: "检查文章页面是否可达且包含实质正文。",
        requiresHuman: false,
      });
    }
  }

  updateIncrementalScopeValidators(state, source.id, {
    scopeUrl: source.url,
  });

  if (!hasArticleFailure) {
    completedScopes.push(source.id);
  }
}

/** Collects Kimi research articles immediately with optional itemUrls or maxItems filters. */
export async function collectResearchSource(
  source: KimiSourceDefinition,
  context: SourceAdapterContext<KimiConfig>,
  state: IncrementalSyncState | undefined,
  params: ActionParams,
  completedScopes: string[],
  problems: ManualRunFailure[],
): Promise<void> {
  let listHtml: string;
  try {
    const { rawText } = await fetchResearchHtml(source.url, context.signal);
    if (isResearchHtmlSpaShellOrErrorPage(rawText)) {
      throw new Error(`信源「${source.id}」返回了 HTML SPA 外壳或错误页。`);
    }
    listHtml = rawText;
  } catch (error) {
    problems.push({
      code: "kimi_collection_incomplete",
      message: `信源「${source.id}」采集失败：${error instanceof Error ? error.message : String(error)}`,
      impact: `信源「${source.id}」列表页获取失败。`,
      path: ["sources", source.id],
      suggestion: "检查网络连通性后重试。",
      requiresHuman: false,
    });
    return;
  }

  const blogList = parseResearchBlogList(listHtml, source.url, source);
  let candidates = [...blogList.inSiteArticles];

  if (params.itemUrls !== undefined && params.itemUrls.length > 0) {
    candidates = candidates.filter((item) =>
      params.itemUrls!.includes(item.url),
    );
  }

  if (params.maxItems !== undefined && params.maxItems > 0) {
    candidates = candidates.slice(0, params.maxItems);
  }

  let hasArticleFailure = false;
  for (const item of candidates) {
    try {
      const { rawText: articleHtml } = await fetchResearchHtml(
        item.url,
        context.signal,
      );
      if (isResearchHtmlSpaShellOrErrorPage(articleHtml)) {
        throw new Error(`文章「${item.url}」返回了 HTML SPA 外壳或错误页。`);
      }
      const extracted = extractResearchArticle(
        articleHtml,
        item.url,
        item.title,
      );

      const metadata: JsonObject = {
        documentKind: "research",
        region: source.region,
        language: source.language,
        slug: item.slug,
        ...(item.publishedDate !== undefined
          ? { publishedDate: item.publishedDate }
          : {}),
        ...(extracted.dateModified !== undefined
          ? { modifiedDate: extracted.dateModified }
          : {}),
        ...(extracted.canonicalUrl !== undefined
          ? { canonicalUrl: extracted.canonicalUrl }
          : {}),
        datePrecision: "day",
      };

      await submitCleanedArticle(context, {
        sourceKey: buildResearchSourceKey(source, item.slug),
        sourceRef: item.url,
        title: extracted.title,
        sourceModifiedAt: undefined,
        metadata,
        properties: {
          title: extracted.title,
        },
        cleanResult: extracted.cleanResult,
        captureScope: {
          sourceId: source.id,
          region: source.region,
          kind: source.kind,
          url: item.url,
        },
      });

      if (state !== undefined) {
        const fingerprint = computeFingerprint({
          slug: item.slug,
          title: item.title,
          publishedDate: item.publishedDate,
        });
        upsertIncrementalScopeEntry(state, source.id, item.slug, {
          fingerprint,
          ...(item.publishedDate !== undefined
            ? { publishedAt: item.publishedDate }
            : {}),
          archivedCompleteness: "complete",
        });
      }
    } catch (error) {
      hasArticleFailure = true;
      problems.push({
        code: "kimi_collection_incomplete",
        message: `文章「${item.url}」采集失败：${error instanceof Error ? error.message : String(error)}`,
        impact: `文章「${item.slug}」未能归档。`,
        path: ["sources", source.id, item.slug],
        suggestion: "检查文章页面是否可达且包含实质正文。",
        requiresHuman: false,
      });
    }
  }

  if (!hasArticleFailure) {
    completedScopes.push(source.id);
  }
}
