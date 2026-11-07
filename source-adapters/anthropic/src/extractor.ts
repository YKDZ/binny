// Detail page content, date, and metadata extractor for Anthropic articles.
import { cleanContent } from "@binny/source-adapter-sdk";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

import { parseCardDate } from "./discovery.ts";
import type { ExtractionResult } from "./types.ts";

function isElement(
  node: DefaultTreeAdapterMap["node"],
): node is DefaultTreeAdapterMap["element"] {
  return "tagName" in node;
}

function getAttribute(
  element: DefaultTreeAdapterMap["element"],
  name: string,
): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function getText(node: DefaultTreeAdapterMap["node"]): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("childNodes" in node && Array.isArray(node.childNodes)) {
    return node.childNodes.map(getText).join(" ");
  }
  return "";
}

function findElements(
  node: DefaultTreeAdapterMap["node"],
  predicate: (element: DefaultTreeAdapterMap["element"]) => boolean,
  results: DefaultTreeAdapterMap["element"][] = [],
): DefaultTreeAdapterMap["element"][] {
  if (isElement(node) && predicate(node)) {
    results.push(node);
  }
  if ("childNodes" in node && Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      findElements(child, predicate, results);
    }
  }
  return results;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/iu.test(
    value.trim(),
  );
}

interface ParsedMetaInfo {
  readonly title?: string | undefined;
  readonly metaPublishedTime?: string | undefined;
  readonly metaModifiedTime?: string | undefined;
  readonly jsonLdPublishedTime?: string | undefined;
  readonly jsonLdModifiedTime?: string | undefined;
  readonly jsonLdHeadline?: string | undefined;
}

function extractMetaInfo(
  document: DefaultTreeAdapterMap["node"],
): ParsedMetaInfo {
  let metaPublishedTime: string | undefined;
  let metaModifiedTime: string | undefined;
  let ogTitle: string | undefined;

  const metas = findElements(document, (el) => el.tagName === "meta");
  for (const meta of metas) {
    const property = (getAttribute(meta, "property") ?? "").toLowerCase();
    const name = (getAttribute(meta, "name") ?? "").toLowerCase();
    const content = getAttribute(meta, "content")?.trim();

    if (!content) continue;

    if (
      property === "article:published_time" ||
      name === "article:published_time"
    ) {
      metaPublishedTime = content;
    } else if (
      property === "article:modified_time" ||
      name === "article:modified_time"
    ) {
      metaModifiedTime = content;
    } else if (property === "og:title" || name === "og:title") {
      ogTitle = content;
    }
  }

  // Parse JSON-LD scripts
  let jsonLdPublishedTime: string | undefined;
  let jsonLdModifiedTime: string | undefined;
  let jsonLdHeadline: string | undefined;

  const scripts = findElements(
    document,
    (el) =>
      el.tagName === "script" &&
      getAttribute(el, "type") === "application/ld+json",
  );

  for (const script of scripts) {
    const rawText = getText(script).trim();
    if (!rawText) continue;
    try {
      const parsed: unknown = JSON.parse(rawText);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (typeof item === "object" && item !== null) {
          const record = item as Record<string, unknown>;
          const rawType = record["@type"];
          const type = typeof rawType === "string" ? rawType : "";
          if (
            [
              "Article",
              "NewsArticle",
              "TechArticle",
              "BlogPosting",
              "WebPage",
            ].includes(type)
          ) {
            if (
              typeof record["datePublished"] === "string" &&
              !jsonLdPublishedTime
            ) {
              jsonLdPublishedTime = record["datePublished"].trim();
            }
            if (
              typeof record["dateModified"] === "string" &&
              !jsonLdModifiedTime
            ) {
              jsonLdModifiedTime = record["dateModified"].trim();
            }
            if (typeof record["headline"] === "string" && !jsonLdHeadline) {
              jsonLdHeadline = record["headline"].trim();
            }
          }
        }
      }
    } catch {
      // Ignore JSON parse errors in script tags
    }
  }

  return {
    title: jsonLdHeadline ?? ogTitle,
    metaPublishedTime,
    metaModifiedTime,
    jsonLdPublishedTime,
    jsonLdModifiedTime,
    jsonLdHeadline,
  };
}

function isTestimonialCard(element: DefaultTreeAdapterMap["element"]): boolean {
  if (element.tagName !== "article") return false;
  const cls = (getAttribute(element, "class") ?? "").toLowerCase();
  if (
    cls.includes("card") ||
    cls.includes("testimonial") ||
    cls.includes("quote")
  ) {
    return true;
  }
  // Check if article contains blockquote and does not nest other articles
  const childArticles = findElements(
    element,
    (n) => n !== element && n.tagName === "article",
  );
  if (childArticles.length > 0) return false;

  const blockquotes = findElements(element, (n) => n.tagName === "blockquote");
  if (blockquotes.length > 0 && getText(element).length < 2000) {
    return true;
  }
  return false;
}

function createAnthropicDropFilter(isStandardLayout: boolean) {
  return (element: DefaultTreeAdapterMap["element"]): boolean => {
    const cls = (getAttribute(element, "class") ?? "").toLowerCase();
    const role = (getAttribute(element, "role") ?? "").toLowerCase();
    const ariaLabel = (getAttribute(element, "aria-label") ?? "").toLowerCase();

    // Drop breadcrumbs, navigation, and side table of contents
    if (
      role === "navigation" ||
      ariaLabel.includes("breadcrumb") ||
      cls.includes("breadcrumb") ||
      cls.includes("side-toc") ||
      cls.includes("table-of-contents")
    ) {
      return true;
    }

    // Drop social sharing and author social links
    if (
      cls.includes("share") ||
      cls.includes("social") ||
      cls.includes("author-social") ||
      cls.includes("author-links")
    ) {
      return true;
    }

    // Drop recommendation and keep-reading footers
    if (
      cls.includes("related") ||
      cls.includes("keep-reading") ||
      cls.includes("recommendation") ||
      cls.includes("more-articles")
    ) {
      return true;
    }

    if (!isStandardLayout) {
      // In model release / landing layout:
      // Drop testimonial article cards
      if (isTestimonialCard(element)) {
        return true;
      }

      // Drop quote carousels and testimonial sections
      if (
        cls.includes("carousel") ||
        cls.includes("testimonial") ||
        cls.includes("quote-card") ||
        cls.includes("quote_card")
      ) {
        return true;
      }

      // Drop call-to-action banners, pricing sections, and prefooters
      if (
        cls.includes("cta") ||
        cls.includes("banner") ||
        cls.includes("pricing") ||
        cls.includes("prefooter") ||
        cls.includes("get-started")
      ) {
        return true;
      }
    }

    return false;
  };
}

/** Extracts and cleans article body, dates, and metadata from detail page HTML. */
export function extractArticleContent(
  html: string,
  articleUrl: string,
  cardDate?: string,
  fallbackTitle?: string,
): ExtractionResult {
  const document = parse(html);
  const metaInfo = extractMetaInfo(document);

  const mains = findElements(document, (el) => el.tagName === "main");
  const mainNode: DefaultTreeAdapterMap["element"] | undefined = mains[0];

  const articlesInMain = mainNode
    ? findElements(mainNode, (el) => el.tagName === "article")
    : findElements(document, (el) => el.tagName === "article");

  // Distinguish standard article vs model release / product landing layout
  // Standard article has exactly 1 <article> inside <main> that is not a testimonial card
  const isSingleArticle = articlesInMain.length === 1;
  const firstArticle = articlesInMain[0];
  const singleArticleIsCard =
    isSingleArticle && firstArticle ? isTestimonialCard(firstArticle) : false;

  const isStandardLayout: boolean = Boolean(
    isSingleArticle && firstArticle && !singleArticleIsCard,
  );
  const targetNode:
    | DefaultTreeAdapterMap["element"]
    | DefaultTreeAdapterMap["document"] =
    isStandardLayout && firstArticle ? firstArticle : (mainNode ?? document);

  // Resolve article title
  let title = metaInfo.title;
  if (!title) {
    const h1s = findElements(targetNode, (el) => el.tagName === "h1");
    if (h1s.length > 0 && h1s[0]) {
      title = getText(h1s[0]).trim();
    }
  }
  if (!title) {
    const docTitles = findElements(document, (el) => el.tagName === "title");
    if (docTitles.length > 0 && docTitles[0]) {
      title = getText(docTitles[0]).trim();
    }
  }
  if (!title) {
    title = fallbackTitle ?? "";
  }
  title = title.replace(/\s+/gu, " ");

  // Resolve dates and precision
  const isoPublished =
    metaInfo.metaPublishedTime ?? metaInfo.jsonLdPublishedTime;
  const isoModified = metaInfo.metaModifiedTime ?? metaInfo.jsonLdModifiedTime;

  let publishedAt: string | undefined;
  let publishedDate: string | undefined;
  let datePrecision: "second" | "day" | undefined;
  let sourceModifiedAt: string | undefined;

  if (isoPublished && isIsoTimestamp(isoPublished)) {
    publishedAt = new Date(isoPublished).toISOString();
    datePrecision = "second";
  } else if (cardDate) {
    publishedDate = cardDate;
    datePrecision = "day";
  } else {
    // Check for visible date in detail page
    const times = findElements(document, (el) => el.tagName === "time");
    for (const time of times) {
      const dt = getAttribute(time, "datetime");
      const parsed = dt ? parseCardDate(dt) : parseCardDate(getText(time));
      if (parsed) {
        publishedDate = parsed;
        datePrecision = "day";
        break;
      }
    }
    if (!publishedDate) {
      const earlyText = getText(targetNode).slice(0, 1000);
      const parsed = parseCardDate(earlyText);
      if (parsed) {
        publishedDate = parsed;
        datePrecision = "day";
      }
    }
  }

  if (isoModified && isIsoTimestamp(isoModified)) {
    sourceModifiedAt = new Date(isoModified).toISOString();
  }

  // Clean HTML content
  const customDropElement = createAnthropicDropFilter(isStandardLayout);
  const serializedHtml = serialize(targetNode);
  const cleanResult = cleanContent(serializedHtml, {
    format: "html",
    baseUrl: articleUrl,
    customDropElement,
  });

  const hasContent =
    cleanResult.hasSubstantialContent ||
    cleanResult.text.trim().length > 0 ||
    cleanResult.markdown.trim().length > 0;

  if (!hasContent) {
    return {
      ok: false,
      reason: `Detail page at "${articleUrl}" yielded no substantial article content.`,
    };
  }

  return {
    ok: true,
    article: {
      title,
      cleanResult,
      publishedAt,
      publishedDate,
      datePrecision,
      sourceModifiedAt,
      isStandardLayout,
    },
  };
}
