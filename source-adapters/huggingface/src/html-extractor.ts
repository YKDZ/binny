// HTML extraction and cleaning rules for Hugging Face Blog.
import {
  cleanContent,
  type CleanContentResult,
} from "@binny/source-adapter-sdk";
import type { DefaultTreeAdapterMap } from "parse5";
import * as parse5 from "parse5";

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
type TextNode = DefaultTreeAdapterMap["textNode"];

export interface ExtractedAuthor {
  readonly name: string;
  readonly handle?: string | undefined;
  readonly url?: string | undefined;
}

export interface ExtractedArticle {
  readonly title?: string | undefined;
  readonly authors: readonly ExtractedAuthor[];
  readonly categories: readonly string[];
  readonly articlePublishedAt?: string | undefined;
  readonly cleanResult: CleanContentResult;
}

export function isElement(node: Node | undefined | null): node is Element {
  return (
    node !== undefined &&
    node !== null &&
    "tagName" in node &&
    typeof (node as Element).tagName === "string"
  );
}

export function isTextNode(node: Node | undefined | null): node is TextNode {
  return (
    node !== undefined &&
    node !== null &&
    node.nodeName === "#text" &&
    "value" in node
  );
}

export function getAttr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name.toLowerCase() === name.toLowerCase())
    ?.value;
}

export function getClassList(el: Element): string[] {
  const cls = getAttr(el, "class");
  return cls ? cls.split(/\s+/u).filter(Boolean) : [];
}

export function getText(node: Node): string {
  if (isTextNode(node)) {
    return node.value;
  }
  if (isElement(node)) {
    return node.childNodes.map(getText).join("");
  }
  return "";
}

export function findElement(
  root: Node,
  predicate: (el: Element) => boolean,
): Element | undefined {
  if (isElement(root) && predicate(root)) {
    return root;
  }
  if ("childNodes" in root && Array.isArray(root.childNodes)) {
    for (const child of root.childNodes) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

export function findAllElements(
  root: Node,
  predicate: (el: Element) => boolean,
): Element[] {
  const results: Element[] = [];
  function walk(node: Node) {
    if (isElement(node) && predicate(node)) {
      results.push(node);
    }
    if ("childNodes" in node && Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }
  walk(root);
  return results;
}

const systemPathPrefixes = new Set([
  "blog",
  "models",
  "datasets",
  "spaces",
  "docs",
  "pricing",
  "login",
  "join",
  "settings",
  "search",
  "organizations",
  "posts",
  "privacy",
  "terms",
  "about",
  "front-end",
]);

/**
 * Checks whether an element should be stripped from the blog post body.
 * Drops site navigation, headers, footers, breadcrumbs, community comments,
 * recommendations ("More articles from our Blog"), and like/share buttons.
 */
export function isUnwantedElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "nav" || tag === "header" || tag === "footer") {
    return true;
  }

  const classList = getClassList(element);
  const classString = classList.join(" ").toLowerCase();
  const id = (getAttr(element, "id") ?? "").toLowerCase();
  const ariaLabel = (getAttr(element, "aria-label") ?? "").toLowerCase();

  // 1. Breadcrumbs & "Back to blog" navigation
  if (
    classString.includes("breadcrumb") ||
    id.includes("breadcrumb") ||
    classString.includes("back-to-blog")
  ) {
    return true;
  }
  if (tag === "a" || tag === "div" || tag === "span" || tag === "p") {
    const text = getText(element).trim().toLowerCase();
    if (text.includes("back to blog")) {
      return true;
    }
  }

  // 2. Community comments & discussions widget
  if (
    id === "community" ||
    id === "comments" ||
    id === "discussion" ||
    id === "discussions" ||
    id.includes("comment-widget") ||
    id.includes("community-widget")
  ) {
    return true;
  }
  if (
    classString.includes("comment-widget") ||
    classString.includes("comments-section") ||
    classString.includes("community-comments") ||
    classString.includes("blog-comments") ||
    classString.includes("discussion-section") ||
    classList.some(
      (c) =>
        c === "comments" ||
        c === "community" ||
        c === "discussion" ||
        c === "discussions",
    )
  ) {
    return true;
  }

  // Heading check for Community / Comments / Recommendations containers
  if (tag === "section" || tag === "div" || tag === "aside") {
    const headings = findAllElements(element, (el) =>
      /^h[1-6]$/i.test(el.tagName),
    );
    for (const h of headings) {
      const hText = getText(h).trim().toLowerCase();
      if (
        hText === "community" ||
        hText === "comments" ||
        hText.startsWith("community comments") ||
        hText === "discussions"
      ) {
        return true;
      }
      if (
        hText.includes("more articles from our blog") ||
        hText.includes("more articles from the blog") ||
        hText.includes("related articles") ||
        hText.includes("related posts")
      ) {
        return true;
      }
    }
  }

  // 3. Recommendation cards / "More articles from our Blog"
  if (
    classString.includes("more-articles") ||
    classString.includes("more-posts") ||
    classString.includes("related-articles") ||
    classString.includes("related-posts") ||
    classString.includes("recommendation") ||
    id.includes("more-articles") ||
    id.includes("related-articles") ||
    id.includes("recommendations")
  ) {
    return true;
  }

  // 4. Upvote / like buttons / share buttons
  if (
    classString.includes("upvote") ||
    classString.includes("like-button") ||
    classString.includes("like-count") ||
    classString.includes("like-btn") ||
    classString.includes("share-button") ||
    classString.includes("share-widget") ||
    classString.includes("social-share") ||
    id.includes("upvote") ||
    id.includes("like-button") ||
    id.includes("share-button")
  ) {
    return true;
  }
  if (tag === "button" || tag === "a") {
    if (
      ariaLabel.includes("upvote") ||
      ariaLabel.includes("like") ||
      ariaLabel.includes("share")
    ) {
      return true;
    }
    const text = getText(element).trim().toLowerCase();
    if (
      text === "upvote" ||
      text === "like" ||
      text === "share" ||
      text.startsWith("share on")
    ) {
      return true;
    }
  }

  return false;
}

/** Recursively strips unwanted child nodes from an AST node in place. */
export function stripUnwantedNodes(node: Node): void {
  if (!("childNodes" in node) || !Array.isArray(node.childNodes)) {
    return;
  }
  node.childNodes = node.childNodes.filter((child) => {
    if (isElement(child)) {
      if (isUnwantedElement(child)) {
        return false;
      }
      stripUnwantedNodes(child);
    }
    return true;
  });
}

/** Locates the main blog post content container in the parsed document. */
export function findMainContainer(doc: Node): Element | undefined {
  // 1. Element with class containing "blog-content"
  const blogContent = findElement(doc, (el) => {
    const cls = getClassList(el);
    return cls.some((c) => c === "blog-content" || c.includes("blog-content"));
  });
  if (blogContent) return blogContent;

  // 2. <article>
  const article = findElement(
    doc,
    (el) => el.tagName.toLowerCase() === "article",
  );
  if (article) return article;

  // 3. <main>
  const main = findElement(doc, (el) => el.tagName.toLowerCase() === "main");
  if (main) return main;

  // 4. Element with class "prose"
  const prose = findElement(doc, (el) => {
    const cls = getClassList(el);
    return cls.includes("prose");
  });
  if (prose) return prose;

  // 5. <body>
  const body = findElement(doc, (el) => el.tagName.toLowerCase() === "body");
  if (body) return body;

  return undefined;
}

/** Extracts authors from byline, author links, and meta tags. */
export function extractAuthorsFromDoc(doc: Node): ExtractedAuthor[] {
  const authors: ExtractedAuthor[] = [];

  function addAuthor(name: string, handle?: string) {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 100) return;
    const cleanHandle = handle?.trim();
    const nameKey = cleanName.toLowerCase();
    const handleKey = cleanHandle?.toLowerCase();

    const existingIndex = authors.findIndex(
      (a) =>
        (handleKey !== undefined && a.handle?.toLowerCase() === handleKey) ||
        a.name.toLowerCase() === nameKey,
    );

    if (existingIndex !== -1) {
      const existing = authors[existingIndex]!;
      if (!existing.handle && cleanHandle) {
        authors[existingIndex] = {
          name: existing.name,
          handle: cleanHandle,
          url: `https://huggingface.co/${cleanHandle}`,
        };
      }
      return;
    }

    authors.push({
      name: cleanName,
      ...(cleanHandle
        ? { handle: cleanHandle, url: `https://huggingface.co/${cleanHandle}` }
        : {}),
    });
  }

  // 1. Look for author containers (e.g. .authors, .byline)
  const authorContainers = findAllElements(doc, (el) => {
    const cls = getClassList(el).join(" ").toLowerCase();
    const id = (getAttr(el, "id") ?? "").toLowerCase();
    return (
      cls.includes("author") ||
      cls.includes("byline") ||
      id.includes("author") ||
      id.includes("byline")
    );
  });

  for (const container of authorContainers) {
    const links = findAllElements(
      container,
      (el) => el.tagName.toLowerCase() === "a",
    );
    for (const a of links) {
      const href = getAttr(a, "href") ?? "";
      const match =
        /^(?:https?:\/\/huggingface\.co)?\/([a-zA-Z0-9._-]+)\/?$/u.exec(href);
      if (match && match[1]) {
        const handle = match[1];
        if (!systemPathPrefixes.has(handle.toLowerCase())) {
          const name = getText(a).trim() || handle;
          addAuthor(name, handle);
        }
      }
    }

    if (links.length === 0) {
      const text = getText(container)
        .replace(/^by\s+/iu, "")
        .trim();
      if (text.length > 0 && text.length < 100) {
        addAuthor(text);
      }
    }
  }

  // 2. Standalone author links with rel="author" or class="author"
  const standaloneAuthorLinks = findAllElements(doc, (el) => {
    if (el.tagName.toLowerCase() !== "a") return false;
    const rel = (getAttr(el, "rel") ?? "").toLowerCase();
    const cls = getClassList(el).join(" ").toLowerCase();
    return rel.includes("author") || cls.includes("author");
  });

  for (const a of standaloneAuthorLinks) {
    const href = getAttr(a, "href") ?? "";
    const match =
      /^(?:https?:\/\/huggingface\.co)?\/([a-zA-Z0-9._-]+)\/?$/u.exec(href);
    if (match && match[1]) {
      const handle = match[1];
      if (!systemPathPrefixes.has(handle.toLowerCase())) {
        const name = getText(a).trim() || handle;
        addAuthor(name, handle);
      }
    } else {
      const name = getText(a).trim();
      if (name.length > 0 && name.length < 100) {
        addAuthor(name);
      }
    }
  }

  // 3. Meta tags: <meta name="author" content="..."> or <meta property="article:author" ...>
  const metaTags = findAllElements(
    doc,
    (el) => el.tagName.toLowerCase() === "meta",
  );
  for (const meta of metaTags) {
    const name = (getAttr(meta, "name") ?? "").toLowerCase();
    const property = (getAttr(meta, "property") ?? "").toLowerCase();
    const content = getAttr(meta, "content")?.trim();
    if (!content) continue;

    if (name === "author" || property === "article:author") {
      const match =
        /^(?:https?:\/\/huggingface\.co)?\/([a-zA-Z0-9._-]+)\/?$/u.exec(
          content,
        );
      if (
        match &&
        match[1] &&
        !systemPathPrefixes.has(match[1].toLowerCase())
      ) {
        const handle = match[1];
        addAuthor(handle, handle);
      } else {
        addAuthor(content);
      }
    }
  }

  return authors;
}

/** Extracts categories and tags from page tag links and meta tags. */
export function extractCategoriesFromDoc(doc: Node): string[] {
  const categories: string[] = [];
  const seen = new Set<string>();

  // 1. Meta tags: <meta property="article:tag" content="...">
  const metaTags = findAllElements(
    doc,
    (el) => el.tagName.toLowerCase() === "meta",
  );
  for (const meta of metaTags) {
    const property = (getAttr(meta, "property") ?? "").toLowerCase();
    if (property === "article:tag") {
      const content = getAttr(meta, "content")?.trim();
      if (content && !seen.has(content.toLowerCase())) {
        seen.add(content.toLowerCase());
        categories.push(content);
      }
    }
  }

  // 2. Tag links (e.g. href="/blog?tag=..." or href="/blog/tags/...")
  const links = findAllElements(doc, (el) => el.tagName.toLowerCase() === "a");
  for (const a of links) {
    const href = getAttr(a, "href") ?? "";
    const match =
      /^\/blog\?(?:.*&)?tag=([^&]+)/iu.exec(href) ??
      /^\/blog\/tags\/([^/?#]+)/iu.exec(href);
    if (match && match[1]) {
      try {
        const tag = decodeURIComponent(match[1]).trim();
        if (tag.length > 0 && !seen.has(tag.toLowerCase())) {
          seen.add(tag.toLowerCase());
          categories.push(tag);
        }
      } catch {
        // Ignore URI decode errors
      }
    }
  }

  return categories;
}

/** Extracts published date from <time>, meta tags, or date elements, preserving original precision. */
export function extractDateFromDoc(doc: Node): string | undefined {
  // 1. <time datetime="...">
  const timeElements = findAllElements(
    doc,
    (el) => el.tagName.toLowerCase() === "time",
  );
  for (const time of timeElements) {
    const dt = getAttr(time, "datetime")?.trim();
    if (dt && dt.length > 0) {
      return dt;
    }
    const text = getText(time).trim();
    if (text.length > 0) {
      return text;
    }
  }

  // 2. Meta article:published_time
  const metaTags = findAllElements(
    doc,
    (el) => el.tagName.toLowerCase() === "meta",
  );
  for (const meta of metaTags) {
    const property = (getAttr(meta, "property") ?? "").toLowerCase();
    if (property === "article:published_time") {
      const content = getAttr(meta, "content")?.trim();
      if (content) return content;
    }
  }

  // 3. Elements with class "date" or "published"
  const dateElements = findAllElements(doc, (el) => {
    const cls = getClassList(el).join(" ").toLowerCase();
    return cls.includes("date") || cls.includes("published");
  });
  for (const el of dateElements) {
    const text = getText(el).trim();
    if (text.length > 0 && text.length < 50) {
      return text;
    }
  }

  return undefined;
}

/** Extracts article title from og:title, twitter:title, <h1>, or <title>. */
export function extractTitleFromDoc(doc: Node): string | undefined {
  // 1. Meta og:title / twitter:title
  const metaTags = findAllElements(
    doc,
    (el) => el.tagName.toLowerCase() === "meta",
  );
  for (const meta of metaTags) {
    const property = (getAttr(meta, "property") ?? "").toLowerCase();
    const name = (getAttr(meta, "name") ?? "").toLowerCase();
    if (property === "og:title" || name === "twitter:title") {
      const content = getAttr(meta, "content")?.trim();
      if (content) return content;
    }
  }

  // 2. First <h1>
  const h1 = findElement(doc, (el) => el.tagName.toLowerCase() === "h1");
  if (h1) {
    const text = getText(h1).trim();
    if (text) return text;
  }

  // 3. <title>
  const title = findElement(doc, (el) => el.tagName.toLowerCase() === "title");
  if (title) {
    const text = getText(title)
      .trim()
      .replace(/\s*[-–|]\s*Hugging Face$/iu, "");
    if (text) return text;
  }

  return undefined;
}

/**
 * Extracts and cleans a Hugging Face blog post from HTML.
 * Strips comments, navigation, recommendations, breadcrumbs, and like/upvote buttons.
 */
export function extractArticle(
  html: string,
  articleUrl: string,
): ExtractedArticle | undefined {
  if (!html || html.trim().length === 0) {
    return undefined;
  }

  const doc = parse5.parse(html);

  // Extract metadata from full document before stripping
  const title = extractTitleFromDoc(doc);
  const authors = extractAuthorsFromDoc(doc);
  const categories = extractCategoriesFromDoc(doc);
  const articlePublishedAt = extractDateFromDoc(doc);

  // Locate the main body container
  const container = findMainContainer(doc);
  if (!container) {
    return undefined;
  }

  // Strip unwanted elements from container AST
  stripUnwantedNodes(container);

  // Serialize cleaned container HTML
  const serializedHtml = parse5.serialize(container);

  // Clean using SDK cleaner with custom drop handler
  const cleanResult = cleanContent(serializedHtml, {
    format: "html",
    baseUrl: articleUrl,
    customDropElement: isUnwantedElement,
  });

  return {
    title,
    authors,
    categories,
    articlePublishedAt,
    cleanResult,
  };
}
