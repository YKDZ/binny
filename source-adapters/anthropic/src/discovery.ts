// Discovery rules for Anthropic News, Research, and Engineering section list pages.
import { createHash } from "node:crypto";

import { sourceTimeFrom } from "@binny/source-adapter-sdk";
import { parse, type DefaultTreeAdapterMap } from "parse5";

import type { DiscoveredArticle } from "./types.ts";

const EXCLUDED_CANONICAL_PATHS = new Set([
  "/",
  "/news",
  "/research",
  "/engineering",
  "/news/announcements",
  "/news/features",
  "/news/partnerships",
  "/news/product",
  "/news/policy",
  "/news/safeguards",
  "/news/security",
  "/science",
  "/press-kit",
  "/company",
  "/contact",
  "/pricing",
  "/legal",
  "/terms",
  "/privacy",
]);

const EXCLUDED_PREFIXES = [
  "/research/team/",
  "/careers",
  "/legal/",
  "/privacy/",
  "/terms/",
  "/pricing/",
  "/login",
  "/console",
  "/search",
];

export function parseCardDate(text: string): string | undefined {
  return sourceTimeFrom(text)?.value;
}

export function isExcludedPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/u, "") || "/";
  if (EXCLUDED_CANONICAL_PATHS.has(normalized)) {
    return true;
  }
  for (const prefix of EXCLUDED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function normalizeCanonicalPath(
  rawHref: string,
  baseUrl: string,
): string | undefined {
  if (
    !rawHref ||
    rawHref.startsWith("#") ||
    rawHref.startsWith("mailto:") ||
    rawHref.startsWith("tel:")
  ) {
    return undefined;
  }

  try {
    const parsedBase = new URL(baseUrl);
    const targetUrl = new URL(rawHref, baseUrl);

    // Only allow URLs from same host or anthropic.com domains
    const baseHost = parsedBase.hostname.toLowerCase();
    const targetHost = targetUrl.hostname.toLowerCase();
    const isSameHost = targetHost === baseHost;
    const isAnthropicDomain =
      targetHost === "anthropic.com" || targetHost.endsWith(".anthropic.com");

    if (!isSameHost && !isAnthropicDomain) {
      return undefined;
    }

    // Exclude third-party subdomains like support, console, or claude.ai
    if (
      targetHost === "claude.ai" ||
      targetHost.endsWith(".claude.ai") ||
      targetHost === "support.claude.com" ||
      targetHost === "console.anthropic.com"
    ) {
      return undefined;
    }

    const pathname = targetUrl.pathname.replace(/\/+$/u, "") || "/";
    if (isExcludedPath(pathname)) {
      return undefined;
    }

    return pathname;
  } catch {
    return undefined;
  }
}

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

/** Parses section list page HTML and extracts discovered article cards inside `<main>`. */
export function discoverSectionArticles(
  html: string,
  sectionId: string,
  sectionUrl: string,
): DiscoveredArticle[] {
  const document = parse(html);

  const mains = findElements(document, (element) => element.tagName === "main");
  const mainNode: DefaultTreeAdapterMap["node"] = mains[0] ?? document;

  const links = findElements(mainNode, (element) => element.tagName === "a");
  const discoveredMap = new Map<string, DiscoveredArticle>();

  for (const a of links) {
    const href = getAttribute(a, "href");
    if (!href) continue;

    const canonicalPath = normalizeCanonicalPath(href, sectionUrl);
    if (!canonicalPath) continue;

    // Find enclosing card container by traversing ancestors up to mainNode
    let card: DefaultTreeAdapterMap["element"] = a;
    let current = a.parentNode;
    while (current && current !== mainNode && isElement(current)) {
      const cls = (getAttribute(current, "class") ?? "").toLowerCase();
      if (
        current.tagName === "article" ||
        cls.includes("card") ||
        cls.includes("tile") ||
        cls.includes("expander") ||
        cls.includes("featured") ||
        cls.includes("slide") ||
        cls.includes("row") ||
        cls.includes("item")
      ) {
        card = current;
        break;
      }
      current = current.parentNode;
    }

    // Extract visible date from card container
    const times = findElements(card, (el) => el.tagName === "time");
    let cardDate: string | undefined;
    const firstTime = times[0];
    if (firstTime) {
      const datetime = getAttribute(firstTime, "datetime");
      if (datetime) {
        cardDate = parseCardDate(datetime);
      }
      if (!cardDate) {
        cardDate = parseCardDate(getText(firstTime));
      }
    }
    if (!cardDate) {
      cardDate = parseCardDate(getText(card));
    }

    // Extract title from headings or anchor text
    const headings = findElements(card, (el) =>
      ["h1", "h2", "h3", "h4", "h5"].includes(el.tagName),
    );
    const firstHeading = headings[0];
    let title = firstHeading ? getText(firstHeading).trim() : "";
    if (!title) {
      title = getText(a).trim();
    }
    title = title.replace(/\s+/gu, " ");

    // Extract category if available
    let category: string | undefined;
    const categoryLinks = findElements(card, (el) => {
      const cls = (getAttribute(el, "class") ?? "").toLowerCase();
      return (
        cls.includes("eyebrow") ||
        cls.includes("category") ||
        cls.includes("label")
      );
    });
    const firstCategoryLink = categoryLinks[0];
    if (firstCategoryLink) {
      const catText = getText(firstCategoryLink).trim().replace(/\s+/gu, " ");
      if (catText.length > 0) {
        category = catText;
      }
    }

    const fullUrl = new URL(canonicalPath, sectionUrl).toString();

    const existing = discoveredMap.get(canonicalPath);
    if (existing === undefined) {
      discoveredMap.set(canonicalPath, {
        canonicalPath,
        url: fullUrl,
        title,
        cardDate,
        category,
        sectionId,
      });
    } else {
      // Merge best available title and date
      const mergedTitle =
        existing.title.length >= title.length ? existing.title : title;
      const mergedDate = existing.cardDate ?? cardDate;
      const mergedCategory = existing.category ?? category;
      discoveredMap.set(canonicalPath, {
        canonicalPath,
        url: fullUrl,
        title: mergedTitle,
        cardDate: mergedDate,
        category: mergedCategory,
        sectionId,
      });
    }
  }

  return [...discoveredMap.values()];
}

/** Parses sitemap XML and extracts URL to lastmod mapping. */
export function parseSitemap(xml: string): Map<string, string> {
  const result = new Map<string, string>();
  const urlRegex = /<url>([\s\S]*?)<\/url>/giu;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(xml)) !== null) {
    const block = match[1] ?? "";
    const locMatch = block.match(/<loc>([^<]+)<\/loc>/iu);
    const lastmodMatch = block.match(/<lastmod>([^<]+)<\/lastmod>/iu);

    if (locMatch && locMatch[1]) {
      const loc = locMatch[1].trim();
      const lastmod =
        lastmodMatch && lastmodMatch[1] ? lastmodMatch[1].trim() : undefined;
      if (lastmod) {
        result.set(loc, lastmod);
        try {
          const pathname = new URL(loc).pathname.replace(/\/+$/u, "") || "/";
          result.set(pathname, lastmod);
        } catch {
          // Ignore URL parse error for sitemap entry
        }
      }
    }
  }

  return result;
}

/** Computes stable fingerprint for article change detection. */
export function computeArticleFingerprint(
  title: string,
  cardDate?: string,
  sitemapLastMod?: string,
): string {
  return createHash("sha256")
    .update(`${title.trim()}|${cardDate ?? ""}|${sitemapLastMod ?? ""}`)
    .digest("hex");
}
