// Qoder International Blog discovery, article extraction, and synchronization.
import { createHash } from "node:crypto";

import type {
  IncrementalEntryRecord,
  SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import {
  cleanContent,
  hasIncrementalEntryChanged,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  sourceTimeFrom,
  submitCleanedArticle,
  upsertIncrementalScopeEntry,
  type CleanContentResult,
} from "@binny/source-adapter-sdk";
import * as parse5 from "parse5";

import type {
  QoderCheckOutput,
  QoderCollectOutput,
  QoderCollectParams,
  QoderConfig,
  QoderExtensions,
  QoderSyncOutput,
} from "./source-adapter.ts";

export const INTERNATIONAL_BLOG_SCOPE_ID = "int-blog";
export const DEFAULT_INTERNATIONAL_BLOG_URL = "https://qoder.com/blog";

type Element = parse5.DefaultTreeAdapterMap["element"];
type Node = parse5.DefaultTreeAdapterMap["node"];
type ChildNode = parse5.DefaultTreeAdapterMap["childNode"];
type ParentNode = parse5.DefaultTreeAdapterMap["parentNode"];

export type DiscoveredBlogArticle = {
  readonly slug: string;
  readonly url: string;
  readonly title: string | null;
  readonly publishedDate?: string | undefined;
  readonly category?: string | undefined;
  readonly summary?: string | undefined;
};

export type ExtractedBlogArticle = {
  readonly slug: string;
  readonly url: string;
  readonly title: string | null;
  readonly sourcePublishedAt: ReturnType<typeof sourceTimeFrom>;
  readonly sourceModifiedAt: ReturnType<typeof sourceTimeFrom>;
  readonly canonicalUrl?: string | undefined;
  readonly authors?: readonly string[] | undefined;
  readonly categories?: readonly string[] | undefined;
  readonly cleanResult: CleanContentResult;
};

function isElement(node: Node | ChildNode | ParentNode): node is Element {
  return typeof node === "object" && node !== null && "tagName" in node;
}

function getAttribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function getText(node: Node | ChildNode): string {
  if (!isElement(node)) {
    return node.nodeName === "#text" ? (node as { value: string }).value : "";
  }
  return node.childNodes.map(getText).join("");
}

function findElements(
  root: Node,
  predicate: (el: Element) => boolean,
): Element[] {
  const matches: Element[] = [];
  function walk(node: Node | ChildNode) {
    if (isElement(node)) {
      if (predicate(node)) {
        matches.push(node);
      }
      for (const child of node.childNodes) {
        walk(child);
      }
    } else if ("childNodes" in node) {
      for (const child of (node as ParentNode).childNodes) {
        walk(child);
      }
    }
  }
  walk(root);
  return matches;
}

function findFirstElement(
  root: Node,
  predicate: (el: Element) => boolean,
): Element | undefined {
  if (isElement(root) && predicate(root)) return root;
  if ("childNodes" in root) {
    for (const child of (root as ParentNode).childNodes) {
      const found = findFirstElement(child, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

/** Extracts article slug from /blog/<slug> or /en/blog/<slug>. */
export function extractBlogSlug(urlOrPath: string): string | undefined {
  try {
    const rawPath =
      urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")
        ? new URL(urlOrPath).pathname
        : (urlOrPath.split("?")[0]?.split("#")[0] ?? "");
    const decoded = decodeURIComponent(rawPath);
    const match = decoded.match(
      /^(?:\/[a-zA-Z]{2}(?:-[a-zA-Z]{2})?)?\/blog\/([^/?#]+?)(?:\.html)?\/?$/i,
    );
    if (!match || !match[1]) return undefined;
    const slug = match[1].trim();
    if (
      [
        "category",
        "tag",
        "page",
        "author",
        "archive",
        "events",
        "activities",
      ].includes(slug.toLowerCase())
    ) {
      return undefined;
    }
    return slug;
  } catch {
    return undefined;
  }
}

/** Normalizes article URL to origin /blog/<slug>. */
export function buildNormalizedArticleUrl(
  slug: string,
  baseUrl: string,
): string {
  const base = new URL(baseUrl);
  return new URL(`/blog/${slug}`, base.origin).href;
}

/** Normalizes an unsupported display date to day precision for list matching. */
export function normalizeDateToDay(rawDate: string): string | undefined {
  const trimmed = rawDate.trim();
  const ymdMatch = trimmed.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (ymdMatch && ymdMatch[1] && ymdMatch[2] && ymdMatch[3]) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, "0");
    const day = ymdMatch[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const monthNames = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const monthMatch = trimmed.match(
    /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/,
  );
  if (monthMatch && monthMatch[1] && monthMatch[2] && monthMatch[3]) {
    const monthIdx = monthNames.findIndex((m) =>
      monthMatch[1]!.toLowerCase().startsWith(m),
    );
    if (monthIdx !== -1) {
      const year = monthMatch[3];
      const month = String(monthIdx + 1).padStart(2, "0");
      const day = monthMatch[2].padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return undefined;
}

/** Preserves source precision and offset while rejecting invalid calendar values. */
export function parseArticleDate(raw: string): {
  readonly sourcePublishedAt: ReturnType<typeof sourceTimeFrom>;
} {
  return {
    sourcePublishedAt:
      sourceTimeFrom(raw) ?? sourceTimeFrom(normalizeDateToDay(raw)),
  };
}

/** Returns a validated source date for list fingerprints without adding precision. */
function sourceDateValue(raw: string): string | undefined {
  return (
    sourceTimeFrom(raw)?.value ?? sourceTimeFrom(normalizeDateToDay(raw))?.value
  );
}

/** Computes stable incremental fingerprint for an article card. */
export function computeArticleFingerprint(
  slug: string,
  title: string | null,
  publishedDate?: string,
): string {
  return createHash("sha256")
    .update(`${slug}\n${title ?? ""}\n${publishedDate ?? ""}`)
    .digest("hex");
}

/** Identifies noise elements such as header, nav, footer, sidebar TOC, share buttons, and recommendations. */
export function isNoiseElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (
    tagName === "header" ||
    tagName === "nav" ||
    tagName === "footer" ||
    tagName === "aside" ||
    tagName === "form"
  ) {
    return true;
  }

  const classAttr = getAttribute(element, "class") ?? "";
  const idAttr = getAttribute(element, "id") ?? "";
  const roleAttr = getAttribute(element, "role") ?? "";
  const ariaLabel = getAttribute(element, "aria-label") ?? "";
  const combined =
    `${classAttr} ${idAttr} ${roleAttr} ${ariaLabel}`.toLowerCase();

  if (
    /(?:^|\s|-|_)(?:toc|table-of-contents|sidebar|share|social|related|recommend|more-posts|newsletter|comments)(?:$|\s|-|_)/i.test(
      combined,
    )
  ) {
    return true;
  }

  if (tagName === "section" || tagName === "div") {
    const heading = findFirstElement(element, (child) =>
      ["h1", "h2", "h3", "h4", "h5", "h6"].includes(
        child.tagName.toLowerCase(),
      ),
    );
    if (heading) {
      const headingText = getText(heading).trim().toLowerCase();
      if (
        /^(?:related\s+(?:posts|articles|stories)|recommendations?|you\s+(?:may|might)\s+also\s+like)/i.test(
          headingText,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

/** Parses HTML list page into discovered article cards. */
export function discoverInternationalBlogArticles(
  html: string,
  baseUrl: string,
): readonly DiscoveredBlogArticle[] {
  const doc = parse5.parse(html);
  const parentMap = new Map<Node, Element>();

  function buildParents(node: Node | ChildNode) {
    if (isElement(node) || "childNodes" in node) {
      const parentEl = isElement(node) ? node : undefined;
      for (const child of (node as ParentNode).childNodes) {
        if (parentEl) parentMap.set(child, parentEl);
        buildParents(child);
      }
    }
  }
  buildParents(doc);

  const anchorElements = findElements(
    doc,
    (el) => el.tagName.toLowerCase() === "a",
  );
  const discoveredMap = new Map<string, DiscoveredBlogArticle>();

  for (const anchor of anchorElements) {
    const href = getAttribute(anchor, "href");
    if (!href) continue;

    const slug = extractBlogSlug(href);
    if (!slug) continue;

    const articleUrl = buildNormalizedArticleUrl(slug, baseUrl);

    let cardContainer: Element = anchor;
    let curr: Node | undefined = parentMap.get(anchor);
    while (curr && isElement(curr)) {
      const tag = curr.tagName.toLowerCase();
      if (tag === "body" || tag === "html" || tag === "main") break;

      const classAttr = (getAttribute(curr, "class") ?? "").toLowerCase();
      const isCardBoundary =
        tag === "article" ||
        tag === "li" ||
        /(?:card|item|post|entry|blog-list)/i.test(classAttr);

      if (isCardBoundary) {
        cardContainer = curr;
        break;
      }
      cardContainer = curr;
      curr = parentMap.get(curr);
    }

    let title = "";
    const headingEl = findFirstElement(cardContainer, (el) =>
      ["h1", "h2", "h3", "h4", "h5", "h6"].includes(el.tagName.toLowerCase()),
    );
    if (headingEl) {
      title = getText(headingEl).trim();
    }
    if (!title) {
      title = getText(anchor).trim();
    }
    const sourceTitle = title || null;

    let publishedDate: string | undefined;
    const timeEl = findFirstElement(
      cardContainer,
      (el) => el.tagName.toLowerCase() === "time",
    );
    if (timeEl) {
      const dt = getAttribute(timeEl, "datetime") ?? getText(timeEl);
      publishedDate = sourceDateValue(dt);
    }
    if (!publishedDate) {
      const cardText = getText(cardContainer);
      publishedDate = sourceDateValue(cardText);
    }

    let category: string | undefined;
    const catEl = findFirstElement(cardContainer, (el) => {
      const cls = (getAttribute(el, "class") ?? "").toLowerCase();
      return /(?:category|tag|badge|label)/i.test(cls);
    });
    if (catEl) {
      const text = getText(catEl).trim();
      if (text && text !== sourceTitle && text !== publishedDate) {
        category = text;
      }
    }

    let summary: string | undefined;
    const pEl = findFirstElement(
      cardContainer,
      (el) => el.tagName.toLowerCase() === "p",
    );
    if (pEl) {
      const pText = getText(pEl).trim();
      if (pText && pText !== sourceTitle && pText !== publishedDate) {
        summary = pText;
      }
    }

    const existing = discoveredMap.get(slug);
    if (!existing) {
      discoveredMap.set(slug, {
        slug,
        url: articleUrl,
        title: sourceTitle,
        publishedDate,
        category,
        summary,
      });
    } else {
      discoveredMap.set(slug, {
        slug,
        url: articleUrl,
        title: existing.title ?? sourceTitle,
        publishedDate: existing.publishedDate ?? publishedDate,
        category: existing.category ?? category,
        summary: existing.summary ?? summary,
      });
    }
  }

  return [...discoveredMap.values()];
}

/** Recursively removes noise nodes from an AST element. */
function stripNoiseFromElement(element: Element): void {
  element.childNodes = element.childNodes.filter((child) => {
    if (isElement(child)) {
      if (isNoiseElement(child)) return false;
      stripNoiseFromElement(child);
    }
    return true;
  });
}

/** Locates main article content container in a detail page. */
function locateArticleContainer(doc: Node): Element | undefined {
  const specificContainer = findFirstElement(doc, (el) => {
    const classAttr = (getAttribute(el, "class") ?? "").toLowerCase();
    const idAttr = (getAttribute(el, "id") ?? "").toLowerCase();
    const combined = `${classAttr} ${idAttr}`;
    return /(?:blog-detail-content|blog-post-content|blog-content|post-content|post-detail|article-content|entry-content)/i.test(
      combined,
    );
  });
  if (specificContainer) return specificContainer;

  const mainEl = findFirstElement(
    doc,
    (el) => el.tagName.toLowerCase() === "main",
  );
  if (mainEl) {
    const innerContent = findFirstElement(mainEl, (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "header" || tag === "nav" || tag === "footer") return false;
      const cls = (getAttribute(el, "class") ?? "").toLowerCase();
      return /(?:content|detail|post|body)/i.test(cls);
    });
    return innerContent ?? mainEl;
  }

  const h1El = findFirstElement(doc, (el) => el.tagName.toLowerCase() === "h1");
  if (h1El) {
    const parentMap = new Map<Node, Element>();
    function buildParents(node: Node | ChildNode) {
      if (isElement(node) || "childNodes" in node) {
        const parentEl = isElement(node) ? node : undefined;
        for (const child of (node as ParentNode).childNodes) {
          if (parentEl) parentMap.set(child, parentEl);
          buildParents(child);
        }
      }
    }
    buildParents(doc);

    let curr: Element | undefined = parentMap.get(h1El);
    while (curr) {
      const tag = curr.tagName.toLowerCase();
      if (tag === "body" || tag === "html") break;
      const paragraphs = findElements(
        curr,
        (el) => el.tagName.toLowerCase() === "p",
      );
      if (paragraphs.length > 0) return curr;
      curr = parentMap.get(curr);
    }
  }

  return undefined;
}

/** Extracts full article body and metadata from detail page HTML. */
export function extractInternationalBlogArticle(
  html: string,
  articleUrl: string,
  card?: DiscoveredBlogArticle,
): ExtractedBlogArticle {
  const doc = parse5.parse(html);
  const slug = extractBlogSlug(articleUrl) ?? card?.slug ?? "article";

  let canonicalUrl: string | undefined;
  const canonicalEl = findFirstElement(doc, (el) => {
    return (
      el.tagName.toLowerCase() === "link" &&
      getAttribute(el, "rel")?.toLowerCase() === "canonical"
    );
  });
  if (canonicalEl) {
    canonicalUrl = getAttribute(canonicalEl, "href");
  }

  let title = "";
  const h1El = findFirstElement(doc, (el) => el.tagName.toLowerCase() === "h1");
  if (h1El) {
    title = getText(h1El).trim();
  }
  if (!title) {
    const ogTitle = findFirstElement(doc, (el) => {
      return (
        el.tagName.toLowerCase() === "meta" &&
        getAttribute(el, "property")?.toLowerCase() === "og:title"
      );
    });
    if (ogTitle) {
      title = (getAttribute(ogTitle, "content") ?? "").trim();
    }
  }
  if (!title) {
    const titleEl = findFirstElement(
      doc,
      (el) => el.tagName.toLowerCase() === "title",
    );
    if (titleEl) {
      const rawTitle = getText(titleEl).trim();
      title = rawTitle.replace(/\s*[-|]\s*Qoder.*$/iu, "").trim();
    }
  }
  if (!title) {
    title = card?.title ?? "";
  }

  const metadataContent = (acceptedNames: ReadonlySet<string>) => {
    for (const meta of findElements(doc, (el) => {
      if (el.tagName.toLowerCase() !== "meta") return false;
      const names = [
        getAttribute(el, "property"),
        getAttribute(el, "name"),
        getAttribute(el, "itemprop"),
      ];
      return names.some((name) =>
        acceptedNames.has(name?.trim().toLowerCase() ?? ""),
      );
    })) {
      const content = getAttribute(meta, "content")?.trim();
      if (content) return content;
    }
    return undefined;
  };

  const publishedMetadata = metadataContent(
    new Set([
      "article:published_time",
      "og:published_time",
      "date",
      "datepublished",
    ]),
  );
  let sourcePublishedAt = publishedMetadata
    ? parseArticleDate(publishedMetadata).sourcePublishedAt
    : null;
  const modifiedMetadata = metadataContent(
    new Set(["article:modified_time", "og:updated_time", "datemodified"]),
  );
  const sourceModifiedAt = modifiedMetadata
    ? parseArticleDate(modifiedMetadata).sourcePublishedAt
    : null;

  if (publishedMetadata === undefined) {
    const publicationTimes = findElements(
      doc,
      (el) => el.tagName.toLowerCase() === "time",
    );
    const parentMap = new Map<Node, Element>();
    function buildParents(node: Node | ChildNode) {
      if (isElement(node) || "childNodes" in node) {
        const parentElement = isElement(node) ? node : undefined;
        for (const child of (node as ParentNode).childNodes) {
          if (parentElement) parentMap.set(child, parentElement);
          buildParents(child);
        }
      }
    }
    buildParents(doc);
    const publicationTime = publicationTimes.find((time) => {
      if (getAttribute(time, "itemprop")?.toLowerCase() === "datepublished") {
        return true;
      }
      let parent: Element | undefined = parentMap.get(time);
      while (parent) {
        const className = getAttribute(parent, "class")?.toLowerCase() ?? "";
        if (
          /(?:post-meta|article-meta|publication|publish-date|published)/u.test(
            className,
          )
        ) {
          return true;
        }
        parent = parentMap.get(parent);
      }
      return false;
    });
    if (publicationTime) {
      const rawDate =
        getAttribute(publicationTime, "datetime") ?? getText(publicationTime);
      sourcePublishedAt = parseArticleDate(rawDate).sourcePublishedAt;
    } else if (card?.publishedDate) {
      sourcePublishedAt = parseArticleDate(
        card.publishedDate,
      ).sourcePublishedAt;
    }
  }

  const authors: string[] = [];
  const authorMeta = findFirstElement(doc, (el) => {
    if (el.tagName.toLowerCase() !== "meta") return false;
    const prop = (
      getAttribute(el, "name") ??
      getAttribute(el, "property") ??
      ""
    ).toLowerCase();
    return prop === "author" || prop === "article:author";
  });
  if (authorMeta) {
    const content = (getAttribute(authorMeta, "content") ?? "").trim();
    if (content) authors.push(content);
  }
  if (authors.length === 0) {
    const authorEl = findFirstElement(doc, (el) => {
      const cls = (getAttribute(el, "class") ?? "").toLowerCase();
      return /(?:author-name|post-author|\bauthor\b)/i.test(cls);
    });
    if (authorEl) {
      const name = getText(authorEl).trim();
      if (name && name !== title) authors.push(name);
    }
  }

  const categories: string[] = [];
  const tagMeta = findFirstElement(doc, (el) => {
    if (el.tagName.toLowerCase() !== "meta") return false;
    const prop = (
      getAttribute(el, "property") ??
      getAttribute(el, "name") ??
      ""
    ).toLowerCase();
    return prop === "article:tag" || prop === "keywords";
  });
  if (tagMeta) {
    const content = (getAttribute(tagMeta, "content") ?? "").trim();
    if (content) {
      for (const item of content.split(",")) {
        const trimmed = item.trim();
        if (trimmed) categories.push(trimmed);
      }
    }
  }
  if (categories.length === 0 && card?.category) {
    categories.push(card.category);
  }

  const container = locateArticleContainer(doc);
  if (!container) {
    throw new Error(
      `Detail page for "${slug}" has no extractable article body.`,
    );
  }

  stripNoiseFromElement(container);
  const containerHtml = parse5.serialize(container);

  const cleanResult = cleanContent(containerHtml, {
    format: "html",
    baseUrl: articleUrl,
    customDropElement: isNoiseElement,
  });

  if (!cleanResult.hasSubstantialContent) {
    throw new Error(
      `Detail page for "${slug}" has no extractable article body (empty shell).`,
    );
  }

  return {
    slug,
    url: articleUrl,
    title: title || null,
    sourcePublishedAt,
    sourceModifiedAt,
    canonicalUrl,
    authors: authors.length > 0 ? authors : undefined,
    categories: categories.length > 0 ? categories : undefined,
    cleanResult,
  };
}

/** Fetches HTML content with abort signal and user agent. */
async function fetchHtml(url: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "Binny SourceAdapter/1.0 (+https://github.com/binny)",
      },
      signal,
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return await response.text();
}

function failureFromProblems(
  problems: readonly { slug: string; message: string }[],
  completedScopes: readonly string[],
) {
  const examples = problems
    .slice(0, 5)
    .map((p) => `${p.slug}: ${p.message}`)
    .join("; ");
  return sourceAdapterActionError(
    {
      code: "qoder_international_blog_collection_incomplete",
      message: `Qoder international blog collection incomplete: ${examples}`,
      impact:
        "Affected blog articles were not archived or their incremental progress was not advanced.",
      suggestion:
        "Check blog list accessibility, detail page status, and media availability.",
      requiresHuman: false,
    },
    completedScopes,
  );
}

/** Checks Qoder international blog list and samples article body extraction. */
export async function checkInternationalBlog(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
): Promise<QoderCheckOutput> {
  const blogListUrl =
    context.config.blogListUrl ?? DEFAULT_INTERNATIONAL_BLOG_URL;
  const problems: QoderCheckOutput["problems"] = [];

  let listHtml: string;
  try {
    listHtml = await fetchHtml(blogListUrl, context.signal);
  } catch (error) {
    return {
      availability: "unavailable",
      scope: [INTERNATIONAL_BLOG_SCOPE_ID],
      basis: `Failed to fetch blog list from ${blogListUrl}.`,
      problems: [
        {
          code: "qoder_blog_list_unreachable",
          message: error instanceof Error ? error.message : String(error),
          impact: "Cannot discover international blog articles.",
          suggestion:
            "Check network connectivity and blogListUrl configuration.",
          requiresHuman: false,
        },
      ],
    };
  }

  const discovered = discoverInternationalBlogArticles(listHtml, blogListUrl);
  if (discovered.length === 0) {
    return {
      availability: "unavailable",
      scope: [INTERNATIONAL_BLOG_SCOPE_ID],
      basis: `No blog articles discovered in ${blogListUrl}.`,
      problems: [
        {
          code: "qoder_blog_no_articles_discovered",
          message: `Zero articles found on ${blogListUrl}.`,
          impact: "No blog articles available for collection.",
          suggestion: "Verify blogListUrl HTML structure and article links.",
          requiresHuman: false,
        },
      ],
    };
  }

  const sampleCard = discovered[0]!;
  try {
    const detailHtml = await fetchHtml(sampleCard.url, context.signal);
    const extracted = extractInternationalBlogArticle(
      detailHtml,
      sampleCard.url,
      sampleCard,
    );
    if (!extracted.cleanResult.hasSubstantialContent) {
      throw new Error(
        `Sample article "${sampleCard.slug}" has no substantial content.`,
      );
    }
  } catch (error) {
    return {
      availability: "unavailable",
      scope: [INTERNATIONAL_BLOG_SCOPE_ID],
      basis: `Sample article extraction failed for "${sampleCard.slug}".`,
      problems: [
        {
          code: "qoder_blog_sample_article_failed",
          message: error instanceof Error ? error.message : String(error),
          impact: "Detail page extraction could not be validated.",
          suggestion: "Check sample article detail page availability.",
          requiresHuman: false,
        },
      ],
    };
  }

  return {
    availability: "available",
    scope: [INTERNATIONAL_BLOG_SCOPE_ID],
    basis: `Successfully discovered ${discovered.length} articles and verified sample extraction.`,
    problems,
  };
}

/** Synchronizes Qoder international blog incrementally. */
export async function syncInternationalBlog(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
): Promise<QoderSyncOutput> {
  const blogListUrl =
    context.config.blogListUrl ?? DEFAULT_INTERNATIONAL_BLOG_URL;
  const state = await loadIncrementalSyncState(context);
  const listHtml = await fetchHtml(blogListUrl, context.signal);
  const discovered = discoverInternationalBlogArticles(listHtml, blogListUrl);

  const isInitialized = isIncrementalScopeInitialized(
    state,
    INTERNATIONAL_BLOG_SCOPE_ID,
    blogListUrl,
  );

  if (!isInitialized) {
    const entries: Record<string, IncrementalEntryRecord> = {};
    for (const card of discovered) {
      const fingerprint = computeArticleFingerprint(
        card.slug,
        card.title,
        card.publishedDate,
      );
      entries[card.slug] = {
        fingerprint,
        ...(card.publishedDate ? { publishedAt: card.publishedDate } : {}),
        archivedCompleteness: "baseline",
      };
    }
    initializeIncrementalScope(state, INTERNATIONAL_BLOG_SCOPE_ID, {
      scopeUrl: blogListUrl,
      initializedAt: context.referenceTime,
      entries,
    });
    await saveIncrementalSyncState(context, state);
    return {
      completedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
      initializedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
    };
  }

  const scopeState = state.scopes[INTERNATIONAL_BLOG_SCOPE_ID]!;
  const problems: { slug: string; message: string }[] = [];
  let hasFailures = false;

  for (const card of discovered) {
    const previous = scopeState.entries[card.slug];
    const fingerprint = computeArticleFingerprint(
      card.slug,
      card.title,
      card.publishedDate,
    );
    const changed = hasIncrementalEntryChanged(
      previous,
      fingerprint,
      card.publishedDate,
    );

    if (!changed) {
      continue;
    }

    try {
      const detailHtml = await fetchHtml(card.url, context.signal);
      const extracted = extractInternationalBlogArticle(
        detailHtml,
        card.url,
        card,
      );

      const submitResult = await submitCleanedArticle(context, {
        sourceKey: {
          namespace: "qoder:int-blog",
          key: card.slug,
        },
        sourceRef: card.url,
        title: extracted.title,
        sourcePublishedAt: extracted.sourcePublishedAt,
        sourceModifiedAt: extracted.sourceModifiedAt,
        extensions: {
          region: "international",
          language: "en",
          category: "blog",
          ...(extracted.canonicalUrl
            ? { canonicalUrl: extracted.canonicalUrl }
            : {}),
          ...(extracted.authors && extracted.authors.length > 0
            ? { authors: [...extracted.authors] }
            : {}),
          ...(extracted.categories && extracted.categories.length > 0
            ? { categories: [...extracted.categories] }
            : {}),
          ...(card.summary ? { summary: card.summary } : {}),
        },
        cleanResult: extracted.cleanResult,
        captureScope: {
          scopeId: INTERNATIONAL_BLOG_SCOPE_ID,
          scopeUrl: blogListUrl,
        },
      });

      upsertIncrementalScopeEntry(
        state,
        INTERNATIONAL_BLOG_SCOPE_ID,
        card.slug,
        {
          fingerprint,
          ...(card.publishedDate ? { publishedAt: card.publishedDate } : {}),
          archivedCompleteness: submitResult.hasMediaFailures
            ? "partial"
            : "complete",
        },
      );
      await saveIncrementalSyncState(context, state);

      if (submitResult.problems.length > 0) {
        for (const msg of submitResult.problems) {
          problems.push({ slug: card.slug, message: msg });
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      hasFailures = true;
      problems.push({
        slug: card.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hasFailures || problems.length > 0) {
    throw failureFromProblems(
      problems,
      hasFailures ? [] : [INTERNATIONAL_BLOG_SCOPE_ID],
    );
  }

  return {
    completedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
  };
}

/** Collects Qoder international blog articles. */
export async function collectInternationalBlog(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
  params: QoderCollectParams,
): Promise<QoderCollectOutput> {
  const blogListUrl =
    context.config.blogListUrl ?? DEFAULT_INTERNATIONAL_BLOG_URL;
  const state = await loadIncrementalSyncState(context);

  let targetArticles: {
    slug: string;
    url: string;
    card?: DiscoveredBlogArticle | undefined;
  }[] = [];

  if (params.articleUrls && params.articleUrls.length > 0) {
    for (const url of params.articleUrls) {
      const slug = extractBlogSlug(url);
      if (slug) {
        targetArticles.push({
          slug,
          url: buildNormalizedArticleUrl(slug, blogListUrl),
        });
      }
    }
  } else {
    const listHtml = await fetchHtml(blogListUrl, context.signal);
    const discovered = discoverInternationalBlogArticles(listHtml, blogListUrl);
    const limited =
      params.maxItems !== undefined && params.maxItems > 0
        ? discovered.slice(0, params.maxItems)
        : discovered;
    targetArticles = limited.map((card) => ({
      slug: card.slug,
      url: card.url,
      card,
    }));
  }

  const problems: { slug: string; message: string }[] = [];
  let hasFailures = false;

  for (const item of targetArticles) {
    try {
      const detailHtml = await fetchHtml(item.url, context.signal);
      const extracted = extractInternationalBlogArticle(
        detailHtml,
        item.url,
        item.card,
      );

      const submitResult = await submitCleanedArticle(context, {
        sourceKey: {
          namespace: "qoder:int-blog",
          key: item.slug,
        },
        sourceRef: item.url,
        title: extracted.title,
        sourcePublishedAt: extracted.sourcePublishedAt,
        sourceModifiedAt: extracted.sourceModifiedAt,
        extensions: {
          region: "international",
          language: "en",
          category: "blog",
          ...(extracted.canonicalUrl
            ? { canonicalUrl: extracted.canonicalUrl }
            : {}),
          ...(extracted.authors && extracted.authors.length > 0
            ? { authors: [...extracted.authors] }
            : {}),
          ...(extracted.categories && extracted.categories.length > 0
            ? { categories: [...extracted.categories] }
            : {}),
          ...(item.card?.summary ? { summary: item.card.summary } : {}),
        },
        cleanResult: extracted.cleanResult,
        captureScope: {
          scopeId: INTERNATIONAL_BLOG_SCOPE_ID,
          scopeUrl: blogListUrl,
        },
      });

      const fingerprint = computeArticleFingerprint(
        item.slug,
        extracted.title,
        extracted.sourcePublishedAt?.value,
      );
      upsertIncrementalScopeEntry(
        state,
        INTERNATIONAL_BLOG_SCOPE_ID,
        item.slug,
        {
          fingerprint,
          ...(extracted.sourcePublishedAt
            ? { publishedAt: extracted.sourcePublishedAt.value }
            : {}),
          archivedCompleteness: submitResult.hasMediaFailures
            ? "partial"
            : "complete",
        },
      );
      await saveIncrementalSyncState(context, state);

      if (submitResult.problems.length > 0) {
        for (const msg of submitResult.problems) {
          problems.push({ slug: item.slug, message: msg });
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      hasFailures = true;
      problems.push({
        slug: item.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hasFailures || problems.length > 0) {
    throw failureFromProblems(
      problems,
      hasFailures ? [] : [INTERNATIONAL_BLOG_SCOPE_ID],
    );
  }

  return {
    completedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
  };
}
