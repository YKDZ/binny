// Article extraction and cleaning for Google AI and DeepMind blogs.
import {
  cleanContent,
  type CleanContentResult,
} from "@binny/source-adapter-sdk";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

export interface ExtractedPageMetadata {
  readonly title?: string | undefined;
  readonly articlePublishedAt?: string | undefined;
  readonly articleUpdatedAt?: string | undefined;
  readonly authors: readonly string[];
  readonly categories: readonly string[];
}

export interface ExtractedArticle {
  readonly cleanResult: CleanContentResult;
  readonly pageMetadata: ExtractedPageMetadata;
  readonly extractedHtml: string;
}

const noiseTagNames = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "nav",
  "footer",
  "form",
]);

export function isElement(
  node: DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["node"],
): node is DefaultTreeAdapterMap["element"] {
  return "tagName" in node;
}

export function getAttribute(
  element: DefaultTreeAdapterMap["element"],
  name: string,
): string | undefined {
  return element.attrs?.find(
    (attr) => attr.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

export function getClasses(
  element: DefaultTreeAdapterMap["element"],
): string[] {
  const value = getAttribute(element, "class") ?? "";
  return value.split(/\s+/u).filter((name) => name.length > 0);
}

export function getElementText(
  node: DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["node"],
): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("childNodes" in node && Array.isArray(node.childNodes)) {
    return node.childNodes.map(getElementText).join(" ");
  }
  return "";
}

export function findElement(
  node: DefaultTreeAdapterMap["node"],
  predicate: (element: DefaultTreeAdapterMap["element"]) => boolean,
): DefaultTreeAdapterMap["element"] | undefined {
  if (isElement(node) && predicate(node)) {
    return node;
  }
  if ("childNodes" in node && Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      const found = findElement(child, predicate);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function findElements(
  node: DefaultTreeAdapterMap["node"],
  predicate: (element: DefaultTreeAdapterMap["element"]) => boolean,
): DefaultTreeAdapterMap["element"][] {
  const matches: DefaultTreeAdapterMap["element"][] = [];
  function walk(current: DefaultTreeAdapterMap["node"]): void {
    if (isElement(current) && predicate(current)) {
      matches.push(current);
    }
    if ("childNodes" in current && Array.isArray(current.childNodes)) {
      for (const child of current.childNodes) {
        walk(child);
      }
    }
  }
  walk(node);
  return matches;
}

export function isRelatedStoriesHeading(
  element: DefaultTreeAdapterMap["element"],
): boolean {
  const tag = element.tagName.toLowerCase();
  if (!/^h[1-6]$/u.test(tag)) return false;
  const text = getElementText(element).trim();
  return /related stories|more from (?:the )?keyword|related posts|further reading/iu.test(
    text,
  );
}

export function shouldDropElement(
  element: DefaultTreeAdapterMap["element"],
  sourceType: "google-ai" | "deepmind" | "generic",
): boolean {
  const tagName = element.tagName.toLowerCase();

  if (noiseTagNames.has(tagName)) {
    return true;
  }

  const role = getAttribute(element, "role")?.toLowerCase();
  if (role === "navigation" || role === "banner" || role === "contentinfo") {
    return true;
  }

  const classAttr = (getAttribute(element, "class") ?? "").toLowerCase();
  const idAttr = (getAttribute(element, "id") ?? "").toLowerCase();
  const dataComponent = (
    getAttribute(element, "data-component") ?? ""
  ).toLowerCase();
  const dataShare = getAttribute(element, "data-share");
  const ariaLabel = (getAttribute(element, "aria-label") ?? "").toLowerCase();

  // Social share toolbars / share buttons
  if (
    dataShare !== undefined ||
    dataComponent === "share" ||
    dataComponent === "social-share" ||
    /\b(social-share|share-tools|share-buttons|social-sharing|c-share)\b/u.test(
      classAttr,
    ) ||
    /\b(social-share|share-tools|share-buttons)\b/u.test(idAttr) ||
    ariaLabel.includes("share")
  ) {
    return true;
  }

  // Google AI specific rules:
  if (sourceType === "google-ai" || sourceType === "generic") {
    // 1. Site header / nav / footer
    if (
      /\b(site-header|uni-header|global-header|site-footer|uni-footer|site-nav|glue-header|glue-footer)\b/u.test(
        classAttr,
      ) ||
      /\b(site-header|uni-header|site-footer|uni-footer)\b/u.test(idAttr)
    ) {
      return true;
    }

    // 2. Audio player widgets
    if (
      dataComponent === "audio-player" ||
      /\b(audio-player|uni-audio-player|listen-to-article)\b/u.test(
        classAttr,
      ) ||
      /\b(audio-player|uni-audio-player)\b/u.test(idAttr)
    ) {
      return true;
    }

    // 3. Related stories / More from the Keyword sections
    if (
      dataComponent === "related-articles" ||
      dataComponent === "related-stories" ||
      /\b(related-stories|more-stories|related-articles|more-from-keyword)\b/u.test(
        classAttr,
      ) ||
      /\b(related-stories|more-stories|related-articles)\b/u.test(idAttr)
    ) {
      return true;
    }

    // 4. Newsletter signup blocks
    if (
      dataComponent === "newsletter" ||
      /\b(newsletter-signup|subscribe-box|uni-newsletter|newsletter)\b/u.test(
        classAttr,
      ) ||
      /\b(newsletter-signup|subscribe-box)\b/u.test(idAttr)
    ) {
      return true;
    }
  }

  // DeepMind specific rules:
  if (sourceType === "deepmind" || sourceType === "generic") {
    // 1. Site navigation
    if (/\b(c-nav|site-nav|navigation)\b/u.test(classAttr)) {
      return true;
    }

    // 2. Share buttons
    if (/\b(share|social-share|c-share|share-buttons)\b/u.test(classAttr)) {
      return true;
    }

    // 3. Author social links
    if (
      /\b(author-social|social-links|author__social|c-social)\b/u.test(
        classAttr,
      ) ||
      /\b(author-social|social-links)\b/u.test(idAttr)
    ) {
      return true;
    }

    // 4. Related posts / Further reading cards
    if (
      /\b(related-posts|further-reading|related-articles|c-related|related-cards)\b/u.test(
        classAttr,
      ) ||
      /\b(related-posts|further-reading)\b/u.test(idAttr)
    ) {
      return true;
    }
  }

  // Check section/aside/div with heading matching related stories / further reading
  if (tagName === "section" || tagName === "aside" || tagName === "div") {
    if (hasRelatedHeading(element)) {
      return true;
    }
  }

  return false;
}

function hasRelatedHeading(
  element: DefaultTreeAdapterMap["element"],
  depth = 0,
): boolean {
  if (depth > 2) return false;
  if (!("childNodes" in element) || !Array.isArray(element.childNodes)) {
    return false;
  }
  for (const child of element.childNodes) {
    if (isElement(child)) {
      if (isRelatedStoriesHeading(child)) {
        return true;
      }
      if (
        child.tagName.toLowerCase() === "div" ||
        child.tagName.toLowerCase() === "header"
      ) {
        if (hasRelatedHeading(child, depth + 1)) return true;
      }
    }
  }
  return false;
}

export function findContainer(
  doc: DefaultTreeAdapterMap["document"],
  sourceType: "google-ai" | "deepmind" | "generic",
): DefaultTreeAdapterMap["element"] | undefined {
  if (sourceType === "google-ai") {
    const uniArticle = findElement(doc, (el) =>
      getClasses(el).some((c) => c.toLowerCase() === "uni-blog-article"),
    );
    if (uniArticle) return uniArticle;

    const article = findElement(
      doc,
      (el) => el.tagName.toLowerCase() === "article",
    );
    if (article) return article;

    const main = findElement(doc, (el) => el.tagName.toLowerCase() === "main");
    if (main) {
      const innerArticle = findElement(
        main,
        (el) => el.tagName.toLowerCase() === "article",
      );
      return innerArticle ?? main;
    }
  } else if (sourceType === "deepmind") {
    const article = findElement(
      doc,
      (el) => el.tagName.toLowerCase() === "article",
    );
    if (article) return article;

    const main = findElement(doc, (el) => el.tagName.toLowerCase() === "main");
    if (main) {
      const innerArticle = findElement(
        main,
        (el) => el.tagName.toLowerCase() === "article",
      );
      return innerArticle ?? main;
    }
  } else {
    const article = findElement(
      doc,
      (el) =>
        el.tagName.toLowerCase() === "article" ||
        getClasses(el).some((c) => c.toLowerCase() === "uni-blog-article"),
    );
    if (article) return article;
    return findElement(doc, (el) => el.tagName.toLowerCase() === "main");
  }

  return undefined;
}

export function cleanContainerTree(
  container: DefaultTreeAdapterMap["element"],
  sourceType: "google-ai" | "deepmind" | "generic",
): void {
  function walk(node: DefaultTreeAdapterMap["childNode"]): void {
    if (!("childNodes" in node) || !Array.isArray(node.childNodes)) {
      return;
    }
    const filtered: DefaultTreeAdapterMap["childNode"][] = [];
    let droppingFollowingSiblings = false;

    for (const child of node.childNodes) {
      if (droppingFollowingSiblings) {
        continue;
      }
      if (isElement(child)) {
        if (isRelatedStoriesHeading(child)) {
          droppingFollowingSiblings = true;
          continue;
        }
        if (shouldDropElement(child, sourceType)) {
          continue;
        }
        if (child.tagName.toLowerCase() === "header") {
          child.tagName = "div";
        }
        walk(child);
      }
      filtered.push(child);
    }
    node.childNodes = filtered;
  }

  walk(container);
}

export function normalizeDateString(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // Day precision YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return trimmed;
  }
  // Month precision YYYY-MM
  if (/^\d{4}-\d{2}$/u.test(trimmed)) {
    return trimmed;
  }
  // Year precision YYYY
  if (/^\d{4}$/u.test(trimmed)) {
    return trimmed;
  }

  // Full timestamp ISO with timezone (Z or +/-offset)
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/iu.test(
      trimmed,
    )
  ) {
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
    return trimmed;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    const hasTime = /(?:\d{1,2}:\d{2}|GMT|UTC|[+-]\d{2})/iu.test(trimmed);
    if (hasTime) {
      return new Date(parsed).toISOString();
    }
    const date = new Date(parsed);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return trimmed;
}

export function toFullIsoTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/iu.test(
      trimmed,
    )
  ) {
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

interface JsonLdEntry {
  headline?: string | undefined;
  name?: string | undefined;
  datePublished?: string | undefined;
  dateModified?: string | undefined;
  authors: string[];
  categories: string[];
}

function extractFromJsonLd(
  obj: unknown,
  callback: (entry: JsonLdEntry) => void,
): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractFromJsonLd(item, callback);
    }
    return;
  }

  const record = obj as Record<string, unknown>;
  if (Array.isArray(record["@graph"])) {
    for (const item of record["@graph"]) {
      extractFromJsonLd(item, callback);
    }
    return;
  }

  const authors: string[] = [];
  const categories: string[] = [];

  const authorVal = record.author;
  if (typeof authorVal === "string") {
    authors.push(authorVal.trim());
  } else if (Array.isArray(authorVal)) {
    for (const a of authorVal) {
      if (typeof a === "string") {
        authors.push(a.trim());
      } else if (a && typeof a === "object" && "name" in a) {
        const name = (a as { name: unknown }).name;
        if (typeof name === "string") authors.push(name.trim());
      }
    }
  } else if (
    authorVal &&
    typeof authorVal === "object" &&
    "name" in authorVal
  ) {
    const name = (authorVal as { name: unknown }).name;
    if (typeof name === "string") authors.push(name.trim());
  }

  const keywordsVal = record.keywords ?? record.articleSection;
  if (typeof keywordsVal === "string") {
    for (const k of keywordsVal.split(/[,;]/u)) {
      const trimmed = k.trim();
      if (trimmed) categories.push(trimmed);
    }
  } else if (Array.isArray(keywordsVal)) {
    for (const k of keywordsVal) {
      if (typeof k === "string") {
        const trimmed = k.trim();
        if (trimmed) categories.push(trimmed);
      }
    }
  }

  callback({
    headline:
      typeof record.headline === "string" ? record.headline.trim() : undefined,
    name: typeof record.name === "string" ? record.name.trim() : undefined,
    datePublished:
      typeof record.datePublished === "string"
        ? record.datePublished.trim()
        : undefined,
    dateModified:
      typeof record.dateModified === "string"
        ? record.dateModified.trim()
        : undefined,
    authors: authors.filter((a) => a.length > 0),
    categories: categories.filter((c) => c.length > 0),
  });
}

export function extractPageMetadata(
  doc: DefaultTreeAdapterMap["document"],
): ExtractedPageMetadata {
  let title: string | undefined;
  let articlePublishedAt: string | undefined;
  let articleUpdatedAt: string | undefined;
  const authors = new Set<string>();
  const categories = new Set<string>();

  // 1. Meta tags
  const metaElements = findElements(
    doc,
    (el) => el.tagName.toLowerCase() === "meta",
  );
  for (const meta of metaElements) {
    const prop = (getAttribute(meta, "property") ?? "").toLowerCase();
    const name = (getAttribute(meta, "name") ?? "").toLowerCase();
    const content = getAttribute(meta, "content")?.trim();
    if (!content) continue;

    if (
      prop === "article:published_time" ||
      prop === "og:article:published_time" ||
      name === "article:published_time" ||
      name === "publish-date" ||
      name === "publication-date"
    ) {
      if (!articlePublishedAt) {
        articlePublishedAt = normalizeDateString(content);
      }
    } else if (
      prop === "article:modified_time" ||
      prop === "og:article:modified_time" ||
      name === "article:modified_time"
    ) {
      if (!articleUpdatedAt) {
        articleUpdatedAt = normalizeDateString(content);
      }
    } else if (prop === "article:author" || name === "author") {
      authors.add(content);
    } else if (prop === "article:tag" || name === "keywords") {
      for (const tag of content.split(/[,;]/u)) {
        const trimmed = tag.trim();
        if (trimmed) categories.add(trimmed);
      }
    } else if (prop === "og:title" || name === "twitter:title") {
      if (!title) title = content;
    }
  }

  // 2. <title> tag
  if (!title) {
    const titleEl = findElement(
      doc,
      (el) => el.tagName.toLowerCase() === "title",
    );
    if (titleEl) {
      const text = getElementText(titleEl).trim();
      if (text) title = text;
    }
  }

  // 3. JSON-LD scripts
  const scriptElements = findElements(
    doc,
    (el) =>
      el.tagName.toLowerCase() === "script" &&
      getAttribute(el, "type")?.toLowerCase() === "application/ld+json",
  );
  for (const script of scriptElements) {
    const text = getElementText(script).trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      extractFromJsonLd(parsed, (entry) => {
        if (!title && entry.headline) title = entry.headline;
        if (!title && entry.name) title = entry.name;
        if (!articlePublishedAt && entry.datePublished) {
          articlePublishedAt = normalizeDateString(entry.datePublished);
        }
        if (!articleUpdatedAt && entry.dateModified) {
          articleUpdatedAt = normalizeDateString(entry.dateModified);
        }
        for (const author of entry.authors) {
          authors.add(author);
        }
        for (const category of entry.categories) {
          categories.add(category);
        }
      });
    } catch {
      // Ignore JSON parse errors in script tags
    }
  }

  // 4. <time> elements
  const timeElements = findElements(
    doc,
    (el) => el.tagName.toLowerCase() === "time",
  );
  for (const time of timeElements) {
    const datetime = getAttribute(time, "datetime")?.trim();
    const itemprop = (getAttribute(time, "itemprop") ?? "").toLowerCase();
    const classAttr = (getAttribute(time, "class") ?? "").toLowerCase();
    const isUpdated =
      itemprop.includes("modified") ||
      classAttr.includes("modified") ||
      classAttr.includes("updated");

    const dateVal = datetime
      ? normalizeDateString(datetime)
      : normalizeDateString(getElementText(time).trim());
    if (dateVal) {
      if (isUpdated) {
        if (!articleUpdatedAt) articleUpdatedAt = dateVal;
      } else {
        if (!articlePublishedAt) articlePublishedAt = dateVal;
      }
    }
  }

  return {
    title,
    articlePublishedAt,
    articleUpdatedAt,
    authors: Array.from(authors),
    categories: Array.from(categories),
  };
}

export function extractArticle(
  html: string,
  articleUrl: string,
  sourceId: string,
): ExtractedArticle | undefined {
  const doc = parse(html);
  const sourceType =
    sourceId === "google-ai"
      ? "google-ai"
      : sourceId === "deepmind"
        ? "deepmind"
        : "generic";

  const pageMetadata = extractPageMetadata(doc);
  const container = findContainer(doc, sourceType);
  if (!container) {
    return undefined;
  }

  cleanContainerTree(container, sourceType);
  const extractedHtml = serialize(container);

  const cleanResult = cleanContent(extractedHtml, {
    format: "html",
    baseUrl: articleUrl,
    customDropElement: (el) => shouldDropElement(el, sourceType),
  });

  if (
    !cleanResult.hasSubstantialContent ||
    cleanResult.text.trim().length === 0
  ) {
    return undefined;
  }

  return {
    cleanResult,
    pageMetadata,
    extractedHtml,
  };
}
