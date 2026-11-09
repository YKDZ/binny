import { createHash } from "node:crypto";

import { sourceTimeFrom } from "@binny/source-adapter-sdk";
import { parse, serialize } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

type ElementNode = DefaultTreeAdapterMap["element"];
type ChildNode = DefaultTreeAdapterMap["childNode"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

export function isElement(node: ChildNode | ParentNode): node is ElementNode {
  return (
    "tagName" in node &&
    typeof (node as { tagName?: unknown }).tagName === "string"
  );
}

export function getAttr(
  element: ElementNode,
  name: string,
): string | undefined {
  return element.attrs.find((a) => a.name.toLowerCase() === name.toLowerCase())
    ?.value;
}

export function hasAttr(element: ElementNode, name: string): boolean {
  return element.attrs.some((a) => a.name.toLowerCase() === name.toLowerCase());
}

export function getTextContent(node: ChildNode | ParentNode): string {
  if (
    "value" in node &&
    typeof (node as { value?: unknown }).value === "string"
  ) {
    return (node as { value: string }).value;
  }
  if (
    "childNodes" in node &&
    Array.isArray((node as { childNodes?: unknown }).childNodes)
  ) {
    return (node as { childNodes: ChildNode[] }).childNodes
      .map(getTextContent)
      .join("");
  }
  return "";
}

export function findElement(
  root: ChildNode | ParentNode,
  predicate: (el: ElementNode) => boolean,
): ElementNode | undefined {
  if (isElement(root) && predicate(root)) {
    return root;
  }
  if (
    "childNodes" in root &&
    Array.isArray((root as { childNodes?: unknown }).childNodes)
  ) {
    for (const child of (root as { childNodes: ChildNode[] }).childNodes) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

export function findAllElements(
  root: ChildNode | ParentNode,
  predicate: (el: ElementNode) => boolean,
): ElementNode[] {
  const results: ElementNode[] = [];
  function walk(node: ChildNode | ParentNode) {
    if (isElement(node) && predicate(node)) {
      results.push(node);
    }
    if (
      "childNodes" in node &&
      Array.isArray((node as { childNodes?: unknown }).childNodes)
    ) {
      for (const child of (node as { childNodes: ChildNode[] }).childNodes) {
        walk(child);
      }
    }
  }
  walk(root);
  return results;
}

export function removeMatchingElements(
  root: ChildNode | ParentNode,
  shouldRemove: (el: ElementNode) => boolean,
): void {
  if (
    "childNodes" in root &&
    Array.isArray((root as { childNodes?: unknown }).childNodes)
  ) {
    const parent = root as { childNodes: ChildNode[] };
    parent.childNodes = parent.childNodes.filter((child) => {
      if (isElement(child) && shouldRemove(child)) {
        return false;
      }
      removeMatchingElements(child, shouldRemove);
      return true;
    });
  }
}

export type AccessFailureResult =
  | { readonly failed: true; readonly code: string; readonly message: string }
  | { readonly failed: false };

/** Detects Cloudflare challenge, 403, or soft fallback redirect. */
export function detectOpenAiAccessFailure(
  response: Response,
  html: string,
  targetUrl: string,
): AccessFailureResult {
  if (response.status !== 200) {
    return {
      failed: true,
      code: "openai_news_challenge_or_forbidden",
      message: `OpenAI article request returned HTTP ${response.status}`,
    };
  }

  const cfMitigated = response.headers.get("cf-mitigated");
  if (cfMitigated?.toLowerCase() === "challenge") {
    return {
      failed: true,
      code: "openai_news_challenge_or_forbidden",
      message:
        "OpenAI response intercepted by Cloudflare challenge (cf-mitigated: challenge)",
    };
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : "";
  if (
    title.toLowerCase().includes("just a moment...") ||
    html.includes("Just a moment...")
  ) {
    return {
      failed: true,
      code: "openai_news_challenge_or_forbidden",
      message:
        'OpenAI article response is a Cloudflare challenge page ("Just a moment...")',
    };
  }

  if (
    html.includes("_cf_chl_opt") ||
    html.includes("challenges.cloudflare.com") ||
    html.includes("cf-chl-widget") ||
    (html.includes("/cdn-cgi/challenge-platform/") &&
      !html.includes("<article") &&
      !html.includes("data-toc-content"))
  ) {
    return {
      failed: true,
      code: "openai_news_challenge_or_forbidden",
      message: "OpenAI article response contains Cloudflare challenge script",
    };
  }

  if (response.url) {
    try {
      const responsePath = new URL(response.url).pathname.replace(/\/+$/, "");
      const targetPath = new URL(targetUrl).pathname.replace(/\/+$/, "");
      if (
        (responsePath === "/news" ||
          responsePath === "/index" ||
          responsePath === "") &&
        targetPath !== responsePath &&
        targetPath !== "/news" &&
        targetPath !== "/index"
      ) {
        return {
          failed: true,
          code: "openai_news_body_unavailable",
          message: `OpenAI article URL redirected to index page (${response.url}) instead of canonical article path`,
        };
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  return { failed: false };
}

export type ExtractedNewsArticle = {
  readonly bodyHtml: string;
  readonly title: string;
  readonly canonicalPath: string;
  readonly publishedAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly authors: readonly string[];
  readonly categories: readonly string[];
};

/** Extracts OpenAI News article body container and page metadata. */
export function extractOpenAiNewsArticle(
  html: string,
  articleUrl: string,
): ExtractedNewsArticle | undefined {
  const document = parse(html);

  // 1. Locate canonical URL
  let canonicalPath: string | undefined;
  const canonicalLink = findElement(
    document,
    (el) => el.tagName === "link" && getAttr(el, "rel") === "canonical",
  );
  if (canonicalLink) {
    const href = getAttr(canonicalLink, "href");
    if (href) {
      try {
        const u = new URL(href, articleUrl);
        canonicalPath = u.pathname;
      } catch {
        // Ignore URL error
      }
    }
  }
  if (!canonicalPath) {
    try {
      const u = new URL(articleUrl);
      canonicalPath = u.pathname;
    } catch {
      canonicalPath = articleUrl;
    }
  }

  // 2. Locate title
  let title = "";
  const ogTitle = findElement(
    document,
    (el) => el.tagName === "meta" && getAttr(el, "property") === "og:title",
  );
  if (ogTitle) {
    title = getAttr(ogTitle, "content")?.trim() ?? "";
  }
  if (!title) {
    const titleEl = findElement(document, (el) => el.tagName === "title");
    if (titleEl) {
      title = getTextContent(titleEl)
        .replace(/\s*[|—–]\s*OpenAI.*$/i, "")
        .trim();
    }
  }
  if (!title) {
    const h1El = findElement(document, (el) => el.tagName === "h1");
    if (h1El) {
      title = getTextContent(h1El).trim();
    }
  }

  // 3. Extract dates
  let publishedAt: string | undefined;
  let updatedAt: string | undefined;

  const pubMeta = findElement(
    document,
    (el) =>
      el.tagName === "meta" &&
      (getAttr(el, "property") === "article:published_time" ||
        getAttr(el, "name") === "publish-date"),
  );
  if (pubMeta) {
    publishedAt = getAttr(pubMeta, "content")?.trim();
  }

  const modMeta = findElement(
    document,
    (el) =>
      el.tagName === "meta" &&
      (getAttr(el, "property") === "article:modified_time" ||
        getAttr(el, "name") === "modified-date"),
  );
  if (modMeta) {
    updatedAt = getAttr(modMeta, "content")?.trim();
  }

  // Check visible time elements if meta not found
  if (!publishedAt) {
    const timeEl = findElement(document, (el) => el.tagName === "time");
    if (timeEl) {
      publishedAt =
        getAttr(timeEl, "datetime")?.trim() || getTextContent(timeEl).trim();
    }
  }

  // 4. Extract authors
  const authors: string[] = [];
  const authorMetas = findAllElements(
    document,
    (el) => el.tagName === "meta" && getAttr(el, "name") === "author",
  );
  for (const meta of authorMetas) {
    const content = getAttr(meta, "content")?.trim();
    if (content && !authors.includes(content)) authors.push(content);
  }

  // 5. Extract categories/tags
  const categories: string[] = [];
  const tagMetas = findAllElements(
    document,
    (el) =>
      el.tagName === "meta" &&
      (getAttr(el, "property") === "article:tag" ||
        getAttr(el, "name") === "category"),
  );
  for (const meta of tagMetas) {
    const content = getAttr(meta, "content")?.trim();
    if (content && !categories.includes(content)) categories.push(content);
  }

  // 6. Locate article body container
  // Priority: [data-toc-content] inside article or main -> article inside main -> article -> main
  let container: ElementNode | undefined = findElement(document, (el) =>
    hasAttr(el, "data-toc-content"),
  );

  if (!container) {
    const mainEl = findElement(document, (el) => el.tagName === "main");
    if (mainEl) {
      container =
        findElement(mainEl, (el) => el.tagName === "article") ?? mainEl;
    } else {
      container = findElement(document, (el) => el.tagName === "article");
    }
  }

  if (!container) {
    return undefined;
  }

  // 7. Strip table of contents, audio player chrome, author bio cards, and keep reading sections
  removeMatchingElements(container, (el) => {
    // Nav / TOC
    if (
      el.tagName === "nav" &&
      (getAttr(el, "aria-label")?.toLowerCase().includes("table of contents") ||
        hasAttr(el, "data-show-toc"))
    ) {
      return true;
    }

    const className = (getAttr(el, "class") ?? "").toLowerCase();
    const ariaLabel = (getAttr(el, "aria-label") ?? "").toLowerCase();
    const text = getTextContent(el).trim().toLowerCase();

    // Audio player chrome ("Listen to article")
    if (
      ariaLabel.includes("listen to article") ||
      className.includes("audio-player") ||
      className.includes("listen-to-article") ||
      text === "listen to article" ||
      text.startsWith("listen to article")
    ) {
      return true;
    }

    // Author bio footer cards
    if (
      className.includes("author-bio") ||
      className.includes("author-card") ||
      (el.tagName === "section" && text.startsWith("author"))
    ) {
      return true;
    }

    // "Keep reading" / related articles
    if (
      className.includes("keep-reading") ||
      className.includes("related-articles") ||
      ariaLabel.includes("keep reading") ||
      ariaLabel.includes("related articles") ||
      (el.tagName === "section" && text.startsWith("keep reading"))
    ) {
      return true;
    }

    return false;
  });

  const bodyHtml = serialize(container);
  return {
    bodyHtml,
    title,
    canonicalPath,
    publishedAt,
    updatedAt,
    authors,
    categories,
  };
}

export type DevelopersBlogPostListing = {
  readonly slug: string;
  readonly url: string;
  readonly title: string;
  readonly publishedDate?: string | undefined;
  readonly categories: readonly string[];
  readonly authors: readonly string[];
};

/** Parses /blog list HTML to discover blog posts. */
export function parseDevelopersBlogList(
  html: string,
  listUrl: string,
): DevelopersBlogPostListing[] {
  const document = parse(html);
  const items: DevelopersBlogPostListing[] = [];
  const seenSlugs = new Set<string>();

  const links = findAllElements(document, (el) => {
    if (el.tagName !== "a") return false;
    const href = getAttr(el, "href");
    if (!href) return false;
    const match = href.match(
      /^(?:https?:\/\/[^/]+)?\/blog\/([a-zA-Z0-9_-]+)\/?(?:\?.*)?(?:#.*)?$/,
    );
    if (!match || !match[1]) return false;
    const slug = match[1];
    return (
      slug !== "blog" &&
      slug !== "rss.xml" &&
      slug !== "tag" &&
      slug !== "category" &&
      slug !== "author"
    );
  });

  for (const link of links) {
    const href = getAttr(link, "href");
    if (!href) continue;
    const match = href.match(
      /^(?:https?:\/\/[^/]+)?\/blog\/([a-zA-Z0-9_-]+)\/?(?:\?.*)?(?:#.*)?$/,
    );
    if (!match || !match[1]) continue;
    const slug = match[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    const articleUrl = new URL(`/blog/${slug}`, listUrl).href;

    let title = "";
    const headingInside = findElement(link, (el) =>
      /^h[1-6]$/i.test(el.tagName),
    );
    if (headingInside) {
      title = getTextContent(headingInside).trim();
    } else {
      const linkText = getTextContent(link).trim();
      if (linkText.length > 0) {
        title = linkText;
      }
    }

    // Find nearest enclosing card or list item
    let card: ElementNode | undefined;
    let curr: ParentNode | undefined = (link as { parentNode?: ParentNode })
      .parentNode;
    while (curr && isElement(curr)) {
      if (
        curr.tagName === "article" ||
        curr.tagName === "li" ||
        (getAttr(curr, "class") ?? "").includes("card") ||
        (getAttr(curr, "class") ?? "").includes("post") ||
        (getAttr(curr, "class") ?? "").includes("item")
      ) {
        card = curr;
        break;
      }
      curr = (curr as { parentNode?: ParentNode }).parentNode;
    }

    const searchRoot: ParentNode =
      card ?? (link as { parentNode?: ParentNode }).parentNode ?? link;

    let publishedDate: string | undefined;
    const categories: string[] = [];
    const authors: string[] = [];

    if (!title) {
      const h = findElement(searchRoot, (el) => /^h[1-6]$/i.test(el.tagName));
      if (h) title = getTextContent(h).trim();
    }

    const timeEl = findElement(searchRoot, (el) => el.tagName === "time");
    if (timeEl) {
      const dt = getAttr(timeEl, "datetime") || getTextContent(timeEl).trim();
      if (dt) publishedDate = dt;
    } else {
      const text = getTextContent(searchRoot);
      const dateMatch =
        text.match(/\b([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})\b/) ||
        text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (dateMatch) {
        publishedDate = dateMatch[1];
      }
    }

    const authorEl = findElement(
      searchRoot,
      (el) =>
        getAttr(el, "rel") === "author" ||
        (getAttr(el, "class") ?? "").includes("author"),
    );
    if (authorEl) {
      const aText = getTextContent(authorEl).trim();
      if (aText && !authors.includes(aText)) authors.push(aText);
    }

    const tagEls = findAllElements(
      searchRoot,
      (el) =>
        (getAttr(el, "class") ?? "").includes("tag") ||
        (getAttr(el, "class") ?? "").includes("category") ||
        (getAttr(el, "href") ?? "").includes("/tag/") ||
        (getAttr(el, "href") ?? "").includes("/category/"),
    );
    for (const tagEl of tagEls) {
      const tText = getTextContent(tagEl).trim();
      if (tText && !categories.includes(tText)) categories.push(tText);
    }

    if (!title) {
      title = slug.replace(/-/g, " ");
    }

    items.push({
      slug,
      url: articleUrl,
      title,
      publishedDate,
      categories,
      authors,
    });
  }

  return items;
}

export type ExtractedDevelopersBlogArticle = {
  readonly bodyHtml: string;
  readonly title: string;
  readonly publishedDate?: string | undefined;
  readonly categories: readonly string[];
  readonly authors: readonly string[];
};

/** Extracts Developers Blog HTML article body and metadata. */
export function extractDevelopersBlogArticle(
  html: string,
  _articleUrl?: string,
): ExtractedDevelopersBlogArticle | undefined {
  const document = parse(html);

  let title = "";
  const ogTitle = findElement(
    document,
    (el) => el.tagName === "meta" && getAttr(el, "property") === "og:title",
  );
  if (ogTitle) {
    title = getAttr(ogTitle, "content")?.trim() ?? "";
  }
  if (!title) {
    const h1El = findElement(document, (el) => el.tagName === "h1");
    if (h1El) title = getTextContent(h1El).trim();
  }

  let publishedDate: string | undefined;
  const timeEl = findElement(document, (el) => el.tagName === "time");
  if (timeEl) {
    publishedDate =
      getAttr(timeEl, "datetime")?.trim() || getTextContent(timeEl).trim();
  }

  const authors: string[] = [];
  const authorMetas = findAllElements(
    document,
    (el) => el.tagName === "meta" && getAttr(el, "name") === "author",
  );
  for (const meta of authorMetas) {
    const c = getAttr(meta, "content")?.trim();
    if (c && !authors.includes(c)) authors.push(c);
  }

  const categories: string[] = [];
  const tagMetas = findAllElements(
    document,
    (el) =>
      el.tagName === "meta" &&
      (getAttr(el, "property") === "article:tag" ||
        getAttr(el, "name") === "category"),
  );
  for (const meta of tagMetas) {
    const c = getAttr(meta, "content")?.trim();
    if (c && !categories.includes(c)) categories.push(c);
  }

  let container: ElementNode | undefined = findElement(
    document,
    (el) => el.tagName === "article",
  );
  if (!container) {
    container = findElement(document, (el) => el.tagName === "main");
  }

  if (!container) {
    return undefined;
  }

  // Strip site nav, header, footer, sidebar, related links
  removeMatchingElements(container, (el) => {
    if (el.tagName === "nav" || getAttr(el, "role") === "navigation")
      return true;
    if (el.tagName === "header" || getAttr(el, "role") === "banner")
      return true;
    if (el.tagName === "footer" || getAttr(el, "role") === "contentinfo")
      return true;
    if (el.tagName === "aside" || getAttr(el, "role") === "complementary")
      return true;

    const className = (getAttr(el, "class") ?? "").toLowerCase();
    const ariaLabel = (getAttr(el, "aria-label") ?? "").toLowerCase();
    if (className.includes("sidebar")) return true;
    if (className.includes("related") || ariaLabel.includes("related"))
      return true;
    return false;
  });

  const bodyHtml = serialize(container);
  return {
    bodyHtml,
    title,
    publishedDate,
    categories,
    authors,
  };
}

export type ParsedDatePrecision = {
  readonly publishedDate: string;
  readonly datePrecision: "day" | "month" | "year" | "second";
  readonly fullIso?: string | undefined;
};

/** Preserves dates at their true precision without fabricating timestamps. */
export function parseDatePrecision(raw: string): ParsedDatePrecision | null {
  const parsed = sourceTimeFrom(raw);
  if (parsed === null) return null;
  const datePrecision =
    parsed.precision === "instant" ? "second" : parsed.precision;
  return {
    publishedDate: parsed.value,
    datePrecision,
    ...(parsed.precision === "instant" ? { fullIso: parsed.value } : {}),
  };
}

export function computeFingerprint(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

/** Prepares markdown content so image references are recognized by content cleaning. */
export function prepareMarkdownContent(markdown: string): string {
  const lines = markdown.split("\n");
  let inCode = false;
  const processed: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      processed.push(line);
      continue;
    }
    if (inCode) {
      processed.push(line);
      continue;
    }
    const converted = line.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, alt, url) => {
        return `<img src="${url.trim()}" alt="${alt.trim()}" />`;
      },
    );
    processed.push(converted);
  }

  return processed.join("\n");
}
