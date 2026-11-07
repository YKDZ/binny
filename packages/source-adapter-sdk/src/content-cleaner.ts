import type {
  ArchiveResourceMetadata,
  ArchiveResourceReference,
} from "@binny/contracts";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import { archiveBodyWithResources, archivedMedia } from "./index.ts";

export type ContentInputFormat = "html" | "xhtml" | "markdown" | "text";

export type CleanContentMediaKind =
  | "inline-image"
  | "inline-media"
  | "attachment";

export interface CleanContentMediaCandidate {
  readonly url: string;
  readonly kind: CleanContentMediaKind;
  readonly mediaType?: string | undefined;
  readonly title?: string | undefined;
  readonly alt?: string | undefined;
}

export interface CleanContentOptions {
  readonly format?: ContentInputFormat | undefined;
  readonly baseUrl?: string | undefined;
  readonly customDropElement?: (
    element: DefaultTreeAdapterMap["element"],
  ) => boolean;
  readonly extraMedia?: readonly CleanContentMediaCandidate[] | undefined;
}

type MediaToken = {
  readonly kind: "media-token";
  readonly candidate: CleanContentMediaCandidate;
  readonly display: "image" | "link";
  readonly alt: string;
};

type ContentToken = string | MediaToken;

export interface CleanContentResult {
  readonly text: string;
  readonly markdown: string;
  readonly media: readonly CleanContentMediaCandidate[];
  readonly invalidMedia: readonly string[];
  readonly hasSubstantialContent: boolean;
  renderArchiveBody(
    uploadedResources: ReadonlyMap<string, ArchiveResourceMetadata>,
  ): {
    readonly markdown: string;
    readonly resources: readonly ArchiveResourceReference[];
  };
}

const noiseTagNames = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "nav",
  "header",
  "footer",
  "form",
]);

function isElement(
  node: DefaultTreeAdapterMap["childNode"],
): node is DefaultTreeAdapterMap["element"] {
  return "tagName" in node;
}

function getAttribute(
  element: DefaultTreeAdapterMap["element"],
  name: string,
): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function hasAttribute(
  element: DefaultTreeAdapterMap["element"],
  name: string,
): boolean {
  return element.attrs.some((attribute) => attribute.name === name);
}

function getClassNames(element: DefaultTreeAdapterMap["element"]): string[] {
  const classValue = getAttribute(element, "class") ?? "";
  return classValue.split(/\s+/u).filter((name) => name.length > 0);
}

function httpUrl(value: string, baseUrl?: string): string | undefined {
  if (value.startsWith("data:")) return undefined;
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const candidates: { url: string; descriptor: string }[] = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\s,]/u.test(value[position] ?? "")) {
      position += 1;
    }
    if (position >= value.length) break;

    const start = position;
    const isDataUrl =
      value.slice(position, position + 5).toLowerCase() === "data:";
    while (
      position < value.length &&
      !/\s/u.test(value[position] ?? "") &&
      (isDataUrl || value[position] !== ",")
    ) {
      position += 1;
    }
    let url = value.slice(start, position);
    const endedWithComma = url.endsWith(",");
    if (endedWithComma) url = url.slice(0, -1);
    if (url.length === 0) continue;

    while (position < value.length && /\s/u.test(value[position] ?? "")) {
      position += 1;
    }
    const descriptorStart = position;
    if (!endedWithComma) {
      while (position < value.length && value[position] !== ",") {
        position += 1;
      }
    }
    const descriptor = value.slice(descriptorStart, position).trim();
    candidates.push({ url, descriptor });
    if (value[position] === ",") position += 1;
  }
  return candidates;
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownSafeText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

function getTextContent(node: DefaultTreeAdapterMap["childNode"]): string {
  if (!isElement(node)) {
    return node.nodeName === "#text" ? node.value : "";
  }
  return node.childNodes.map(getTextContent).join("");
}

function findDescendantElement(
  node: DefaultTreeAdapterMap["childNode"],
  predicate: (element: DefaultTreeAdapterMap["element"]) => boolean,
): DefaultTreeAdapterMap["element"] | undefined {
  if (!isElement(node)) return undefined;
  if (predicate(node)) return node;
  for (const child of node.childNodes) {
    const found = findDescendantElement(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function cleanContent(
  content: string,
  options: CleanContentOptions = {},
): CleanContentResult {
  const format = options.format ?? "html";
  const baseUrl = options.baseUrl;

  if (format === "text") {
    return cleanPlainText(content, options);
  }

  const fragment = parseFragment(content);
  const mediaMap = new Map<string, CleanContentMediaCandidate>();
  const invalidMedia: string[] = [];

  for (const extra of options.extraMedia ?? []) {
    const url = httpUrl(extra.url, options.baseUrl);
    if (url !== undefined) {
      mediaMap.set(url, { ...extra, url });
    }
  }

  function addMediaCandidate(
    rawUrl: string,
    kind: CleanContentMediaKind,
    title?: string,
    alt?: string,
    mediaType?: string,
  ): CleanContentMediaCandidate | undefined {
    if (rawUrl.startsWith("data:")) return undefined;
    const url = httpUrl(rawUrl, baseUrl);
    if (url === undefined) {
      invalidMedia.push(rawUrl);
      return undefined;
    }
    const existing = mediaMap.get(url);
    const candidate: CleanContentMediaCandidate = {
      url,
      kind,
      mediaType: mediaType ?? existing?.mediaType,
      title: title ?? existing?.title,
      alt: alt ?? existing?.alt,
    };
    mediaMap.set(url, candidate);
    return candidate;
  }

  const tokens: ContentToken[] = [];
  const textPieces: string[] = [];
  const inlinedUrls = new Set<string>();

  function walkElement(
    node: DefaultTreeAdapterMap["childNode"],
    context: {
      readonly inPre: boolean;
      readonly inQuote: boolean;
      readonly listLevel: number;
    },
  ): void {
    if (!isElement(node)) {
      if (node.nodeName === "#text") {
        const text = node.value;
        if (text.length > 0) {
          textPieces.push(text);
          tokens.push(context.inPre ? text : escapeMarkdownText(text));
        }
      }
      return;
    }

    const element = node;
    const tag = element.tagName;

    if (noiseTagNames.has(tag)) return;

    if (options.customDropElement?.(element)) return;

    const classes = getClassNames(element);

    if (tag === "aside") {
      const isQuote =
        classes.includes("quote") ||
        hasAttribute(element, "data-post") ||
        hasAttribute(element, "data-topic");
      if (!isQuote) return;

      renderDiscourseQuote(element, context);
      return;
    }

    if (tag === "blockquote") {
      renderStandardQuote(element, context);
      return;
    }

    if (tag === "pre") {
      renderPreBlock(element);
      return;
    }

    if (tag === "code" && !context.inPre) {
      const codeText = getTextContent(element);
      textPieces.push(codeText);
      tokens.push(`\`${codeText.replaceAll("`", "\\`")}\``);
      return;
    }

    if (tag === "table") {
      renderTable(element);
      return;
    }

    if (tag === "details") {
      renderDetails(element, context);
      return;
    }

    if (/^h[1-6]$/u.test(tag)) {
      const level = Number(tag[1]);
      tokens.push(`\n\n${"#".repeat(level)} `);
      textPieces.push(" ");
      for (const child of element.childNodes) {
        walkElement(child, context);
      }
      tokens.push("\n\n");
      textPieces.push(" ");
      return;
    }

    if (["p", "div", "article", "section"].includes(tag)) {
      tokens.push("\n\n");
      textPieces.push(" ");
      for (const child of element.childNodes) {
        walkElement(child, context);
      }
      tokens.push("\n\n");
      textPieces.push(" ");
      return;
    }

    if (tag === "ul" || tag === "ol") {
      renderList(element, context);
      return;
    }

    if (tag === "img") {
      renderImage(element);
      return;
    }

    if (tag === "picture") {
      for (const child of element.childNodes) {
        if (isElement(child) && child.tagName === "source") {
          const srcset = getAttribute(child, "srcset");
          if (srcset !== undefined) {
            for (const item of parseSrcset(srcset)) {
              addMediaCandidate(
                item.url,
                "inline-image",
                undefined,
                undefined,
                getAttribute(child, "type"),
              );
            }
          }
        }
      }
      const imgChild = findDescendantElement(
        element,
        (el) => el.tagName === "img",
      );
      if (imgChild !== undefined) {
        renderImage(imgChild);
      }
      return;
    }

    if (["audio", "video", "source", "track", "object"].includes(tag)) {
      renderInlineMedia(element);
      return;
    }

    if (tag === "a") {
      if (classes.includes("lightbox") && hasAttribute(element, "href")) {
        renderLightbox(element);
        return;
      }

      const isAttachment =
        hasAttribute(element, "download") ||
        classes.includes("attachment") ||
        hasAttribute(element, "data-download-href");

      const href =
        getAttribute(element, "data-download-href") ??
        getAttribute(element, "href");

      if (isAttachment && href !== undefined) {
        const linkText = getTextContent(element).trim();
        const candidate = addMediaCandidate(
          href,
          "attachment",
          linkText.length > 0 ? linkText : undefined,
        );
        if (candidate !== undefined) {
          inlinedUrls.add(candidate.url);
          tokens.push({
            kind: "media-token",
            candidate,
            display: "link",
            alt: linkText.length > 0 ? linkText : "附件",
          });
          textPieces.push(linkText);
          return;
        }
      }

      if (href !== undefined) {
        const normalizedHref = httpUrl(href, baseUrl) ?? href;
        tokens.push("[");
        for (const child of element.childNodes) {
          walkElement(child, context);
        }
        tokens.push(`](${normalizedHref})`);
        return;
      }
    }

    if (tag === "br") {
      tokens.push("\n");
      textPieces.push(" ");
      return;
    }

    if (tag === "strong" || tag === "b") {
      tokens.push("**");
      for (const child of element.childNodes) walkElement(child, context);
      tokens.push("**");
      return;
    }

    if (tag === "em" || tag === "i") {
      tokens.push("*");
      for (const child of element.childNodes) walkElement(child, context);
      tokens.push("*");
      return;
    }

    if (tag === "del" || tag === "s" || tag === "strike") {
      tokens.push("~~");
      for (const child of element.childNodes) walkElement(child, context);
      tokens.push("~~");
      return;
    }

    if (tag === "hr") {
      tokens.push("\n\n---\n\n");
      textPieces.push(" ");
      return;
    }

    for (const child of element.childNodes) {
      walkElement(child, context);
    }
  }

  function renderImage(element: DefaultTreeAdapterMap["element"]): void {
    const src = getAttribute(element, "src");
    const alt =
      getAttribute(element, "alt") ?? getAttribute(element, "title") ?? "";
    const classes = getClassNames(element);

    const isEmoji =
      classes.includes("emoji") ||
      (src !== undefined && /\/(?:emoji|_avatar)(?:\/|\.)/iu.test(src));
    if (isEmoji) {
      const emojiText = alt || getAttribute(element, "title") || "";
      if (emojiText.length > 0) {
        tokens.push(escapeMarkdownText(emojiText));
        textPieces.push(emojiText);
      }
      return;
    }

    if (src !== undefined) {
      const candidate = addMediaCandidate(src, "inline-image", undefined, alt);
      if (candidate !== undefined) {
        inlinedUrls.add(candidate.url);
        tokens.push({
          kind: "media-token",
          candidate,
          display: "image",
          alt,
        });
      } else {
        tokens.push(`![${markdownSafeText(alt)}](${src})`);
      }
      if (alt.length > 0) textPieces.push(alt);
    }

    const srcset = getAttribute(element, "srcset");
    if (srcset !== undefined) {
      for (const item of parseSrcset(srcset)) {
        addMediaCandidate(item.url, "inline-image", undefined, alt);
      }
    }
  }

  function renderLightbox(element: DefaultTreeAdapterMap["element"]): void {
    const originalHref = getAttribute(element, "href");
    if (originalHref === undefined) return;

    const img = findDescendantElement(element, (el) => el.tagName === "img");
    const alt =
      img !== undefined
        ? (getAttribute(img, "alt") ?? getAttribute(img, "title") ?? "")
        : (getAttribute(element, "title") ?? "");

    const candidate = addMediaCandidate(
      originalHref,
      "inline-image",
      undefined,
      alt,
    );
    if (candidate !== undefined) {
      inlinedUrls.add(candidate.url);
      tokens.push({
        kind: "media-token",
        candidate,
        display: "image",
        alt,
      });
    } else {
      tokens.push(`![${markdownSafeText(alt)}](${originalHref})`);
    }
    if (alt.length > 0) textPieces.push(alt);
  }

  function renderInlineMedia(element: DefaultTreeAdapterMap["element"]): void {
    const tag = element.tagName;
    const src = getAttribute(element, "src") ?? getAttribute(element, "data");
    const alt = getAttribute(element, "title") ?? tag;
    const poster = getAttribute(element, "poster");

    if (poster !== undefined) {
      addMediaCandidate(poster, "inline-image");
    }

    if (src !== undefined) {
      const candidate = addMediaCandidate(
        src,
        "inline-media",
        undefined,
        alt,
        getAttribute(element, "type"),
      );
      if (candidate !== undefined) {
        inlinedUrls.add(candidate.url);
        tokens.push({
          kind: "media-token",
          candidate,
          display: "link",
          alt,
        });
      }
      textPieces.push(alt);
    }

    for (const child of element.childNodes) {
      if (isElement(child) && child.tagName === "source") {
        const sourceSrc = getAttribute(child, "src");
        if (sourceSrc !== undefined) {
          addMediaCandidate(
            sourceSrc,
            "inline-media",
            undefined,
            undefined,
            getAttribute(child, "type"),
          );
        }
      }
    }
  }

  function renderPreBlock(element: DefaultTreeAdapterMap["element"]): void {
    const codeElement = findDescendantElement(
      element,
      (el) => el.tagName === "code",
    );
    let lang = "";
    if (codeElement !== undefined) {
      const classes = getClassNames(codeElement);
      for (const cls of classes) {
        const match = /^(?:lang|language)-(\w+)$/iu.exec(cls);
        if (match?.[1]) {
          lang = match[1];
          break;
        }
      }
    }
    const codeText = getTextContent(element);
    textPieces.push(codeText);
    tokens.push(`\n\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`);
  }

  function renderStandardQuote(
    element: DefaultTreeAdapterMap["element"],
    context: {
      readonly inPre: boolean;
      readonly inQuote: boolean;
      readonly listLevel: number;
    },
  ): void {
    const subCleaned = cleanSubtree(element.childNodes, {
      ...context,
      inQuote: true,
    });
    tokens.push(prefixQuote(subCleaned.markdown));
    textPieces.push(subCleaned.text);
  }

  function renderDiscourseQuote(
    element: DefaultTreeAdapterMap["element"],
    context: {
      readonly inPre: boolean;
      readonly inQuote: boolean;
      readonly listLevel: number;
    },
  ): void {
    const titleDiv = element.childNodes.find(
      (child) =>
        isElement(child) &&
        child.tagName === "div" &&
        getClassNames(child).includes("title"),
    );
    let headerText = "";
    if (titleDiv !== undefined && isElement(titleDiv)) {
      headerText = getTextContent(titleDiv).replace(/\s+/gu, " ").trim();
    } else {
      const username = getAttribute(element, "data-username");
      if (username) headerText = `${username}:`;
    }

    const blockquoteElement = element.childNodes.find(
      (child) => isElement(child) && child.tagName === "blockquote",
    );
    const bodyNodes =
      blockquoteElement !== undefined && isElement(blockquoteElement)
        ? blockquoteElement.childNodes
        : element.childNodes.filter((child) => child !== titleDiv);

    const subCleaned = cleanSubtree(bodyNodes, {
      ...context,
      inQuote: true,
    });

    tokens.push("\n\n");
    if (headerText.length > 0) {
      tokens.push(`> **${headerText}**\n`);
      textPieces.push(headerText, " ");
    }
    tokens.push(prefixQuote(subCleaned.markdown.trim()));
    tokens.push("\n\n");
    textPieces.push(subCleaned.text);
  }

  function renderList(
    element: DefaultTreeAdapterMap["element"],
    context: {
      readonly inPre: boolean;
      readonly inQuote: boolean;
      readonly listLevel: number;
    },
  ): void {
    const isOrdered = element.tagName === "ol";
    let index = 1;
    tokens.push("\n\n");
    textPieces.push(" ");

    for (const child of element.childNodes) {
      if (!isElement(child) || child.tagName !== "li") continue;
      const indent = "  ".repeat(context.listLevel);
      const prefix = isOrdered ? `${String(index)}. ` : "- ";
      tokens.push(`${indent}${prefix}`);
      index += 1;

      for (const liChild of child.childNodes) {
        walkElement(liChild, {
          ...context,
          listLevel: context.listLevel + 1,
        });
      }
      tokens.push("\n");
      textPieces.push(" ");
    }
    tokens.push("\n");
  }

  function renderTable(element: DefaultTreeAdapterMap["element"]): void {
    const rows: { isHeader: boolean; cells: string[] }[] = [];
    function collectRows(node: DefaultTreeAdapterMap["childNode"]): void {
      if (!isElement(node)) return;
      if (node.tagName === "tr") {
        const cells: string[] = [];
        let hasTh = false;
        for (const child of node.childNodes) {
          if (
            isElement(child) &&
            (child.tagName === "th" || child.tagName === "td")
          ) {
            if (child.tagName === "th") hasTh = true;
            const cellText = getTextContent(child)
              .replace(/\s+/gu, " ")
              .trim()
              .replaceAll("|", "\\|");
            cells.push(cellText);
          }
        }
        if (cells.length > 0) rows.push({ isHeader: hasTh, cells });
      } else {
        for (const child of node.childNodes) collectRows(child);
      }
    }
    collectRows(element);

    if (rows.length === 0) return;

    tokens.push("\n\n");
    textPieces.push(" ");

    const firstRow = rows[0];
    if (firstRow) {
      tokens.push(`| ${firstRow.cells.join(" | ")} |\n`);
      tokens.push(`| ${firstRow.cells.map(() => "---").join(" | ")} |\n`);
      textPieces.push(firstRow.cells.join(" "), " ");
    }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row) {
        tokens.push(`| ${row.cells.join(" | ")} |\n`);
        textPieces.push(row.cells.join(" "), " ");
      }
    }
    tokens.push("\n");
  }

  function renderDetails(
    element: DefaultTreeAdapterMap["element"],
    context: {
      readonly inPre: boolean;
      readonly inQuote: boolean;
      readonly listLevel: number;
    },
  ): void {
    const summaryEl = findDescendantElement(
      element,
      (el) => el.tagName === "summary",
    );
    const summaryText = summaryEl
      ? getTextContent(summaryEl).replace(/\s+/gu, " ").trim()
      : "Details";
    const bodyNodes = element.childNodes.filter((c) => c !== summaryEl);
    const bodyCleaned = cleanSubtree(bodyNodes, context);

    tokens.push(
      `\n\n<details>\n<summary>${escapeMarkdownText(summaryText)}</summary>\n\n`,
    );
    tokens.push(bodyCleaned.markdown.trim());
    tokens.push("\n\n</details>\n\n");

    textPieces.push(summaryText, " ", bodyCleaned.text);
  }

  function cleanSubtree(
    childNodes: readonly DefaultTreeAdapterMap["childNode"][],
    subContext: {
      readonly inPre: boolean;
      readonly inQuote: boolean;
      readonly listLevel: number;
    },
  ): { readonly markdown: string; readonly text: string } {
    const savedTokensLength = tokens.length;
    const savedTextLength = textPieces.length;

    for (const child of childNodes) {
      walkElement(child, subContext);
    }

    const subTokens = tokens.splice(savedTokensLength);
    const subText = textPieces.splice(savedTextLength).join("");
    const subMarkdown = tokensToMarkdown(subTokens, new Map());
    return { markdown: subMarkdown, text: subText };
  }

  function prefixQuote(markdown: string): string {
    const lines = markdown.trim().split("\n");
    return `\n\n${lines.map((l) => `> ${l}`).join("\n")}\n\n`;
  }

  for (const child of fragment.childNodes) {
    walkElement(child, { inPre: false, inQuote: false, listLevel: 0 });
  }

  const rawText = textPieces.join("").replace(/\s+/gu, " ").trim();
  const allMedia = [...mediaMap.values()];
  const hasSubstantial = rawText.length > 0 || allMedia.length > 0;

  function renderArchiveBody(
    uploadedResources: ReadonlyMap<string, ArchiveResourceMetadata>,
  ): {
    readonly markdown: string;
    readonly resources: readonly ArchiveResourceReference[];
  } {
    const parts: (string | ReturnType<typeof archivedMedia>)[] = [];

    for (const token of tokens) {
      if (typeof token === "string") {
        parts.push(token);
      } else {
        const resource = uploadedResources.get(token.candidate.url);
        const alt = markdownSafeText(token.alt);
        if (token.display === "image") {
          parts.push(`![${alt}](`);
          parts.push(
            resource === undefined
              ? token.candidate.url
              : archivedMedia(resource),
          );
          parts.push(")");
        } else {
          parts.push(`[${alt}](`);
          parts.push(
            resource === undefined
              ? token.candidate.url
              : archivedMedia(resource),
          );
          parts.push(")");
        }
      }
    }

    const attachments = allMedia.filter((m) => !inlinedUrls.has(m.url));
    if (attachments.length > 0) {
      parts.push("\n\n附件：");
      for (const [index, candidate] of attachments.entries()) {
        if (index > 0) parts.push("；");
        const resource = uploadedResources.get(candidate.url);
        const title = markdownSafeText(candidate.title ?? `媒体 ${index + 1}`);
        parts.push(title, " (");
        parts.push(
          resource === undefined ? candidate.url : archivedMedia(resource),
        );
        parts.push(")");
      }
    }

    const bodyWithResources = archiveBodyWithResources(parts);
    const normalizedMarkdown = normalizeMarkdownSpacing(
      bodyWithResources.content,
    );
    return {
      markdown: normalizedMarkdown,
      resources: bodyWithResources.resources,
    };
  }

  const defaultMarkdown = renderArchiveBody(new Map()).markdown;

  return {
    text: rawText,
    markdown: defaultMarkdown,
    media: allMedia,
    invalidMedia,
    hasSubstantialContent: hasSubstantial,
    renderArchiveBody,
  };
}

function cleanPlainText(
  content: string,
  options: CleanContentOptions,
): CleanContentResult {
  const escapedMarkdown = escapeMarkdownText(content);
  const mediaMap = new Map<string, CleanContentMediaCandidate>();
  for (const extra of options.extraMedia ?? []) {
    const url = httpUrl(extra.url, options.baseUrl);
    if (url !== undefined) {
      mediaMap.set(url, { ...extra, url });
    }
  }
  const allMedia = [...mediaMap.values()];

  function renderArchiveBody(
    uploadedResources: ReadonlyMap<string, ArchiveResourceMetadata>,
  ): {
    readonly markdown: string;
    readonly resources: readonly ArchiveResourceReference[];
  } {
    const parts: (string | ReturnType<typeof archivedMedia>)[] = [
      escapedMarkdown,
    ];
    if (allMedia.length > 0) {
      parts.push("\n\n附件：");
      for (const [index, candidate] of allMedia.entries()) {
        if (index > 0) parts.push("；");
        const resource = uploadedResources.get(candidate.url);
        const title = markdownSafeText(candidate.title ?? `媒体 ${index + 1}`);
        parts.push(title, " (");
        parts.push(
          resource === undefined ? candidate.url : archivedMedia(resource),
        );
        parts.push(")");
      }
    }
    const bodyWithResources = archiveBodyWithResources(parts);
    return {
      markdown: normalizeMarkdownSpacing(bodyWithResources.content),
      resources: bodyWithResources.resources,
    };
  }

  return {
    text: content,
    markdown: renderArchiveBody(new Map()).markdown,
    media: allMedia,
    invalidMedia: [],
    hasSubstantialContent: content.trim().length > 0 || allMedia.length > 0,
    renderArchiveBody,
  };
}

function tokensToMarkdown(
  tokens: readonly ContentToken[],
  uploaded: ReadonlyMap<string, ArchiveResourceMetadata>,
): string {
  let md = "";
  for (const token of tokens) {
    if (typeof token === "string") {
      md += token;
    } else {
      const resource = uploaded.get(token.candidate.url);
      const ref =
        resource === undefined
          ? token.candidate.url
          : `binny://resource/${resource.resourceId}`;
      const alt = markdownSafeText(token.alt);
      if (token.display === "image") {
        md += `![${alt}](${ref})`;
      } else {
        md += `[${alt}](${ref})`;
      }
    }
  }
  return normalizeMarkdownSpacing(md);
}

function normalizeMarkdownSpacing(md: string): string {
  return md
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

const challengeHtmlPatterns = [
  /_cf_chl_opt/iu,
  /\/cdn-cgi\/challenge-platform\//iu,
  /challenges\.cloudflare\.com/iu,
  /cf-turnstile/iu,
  /turnstile/iu,
  /hcaptcha/iu,
  /recaptcha/iu,
  /<form[^>]*>[\s\S]*?<input[^>]+type=["']?password["']?/iu,
  /<input[^>]+type=["']?password["']?/iu,
  /<title>\s*(?:Just a moment\.\.\.|Attention Required!|Security Check|Cloudflare)\s*<\/title>/iu,
];

export function isAcceptableMediaResponse(
  candidate: CleanContentMediaCandidate,
  mediaType: string,
  bodyText?: string,
): { readonly acceptable: boolean; readonly reason?: string } {
  const normalizedMediaType =
    mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const isHtml =
    normalizedMediaType === "text/html" ||
    normalizedMediaType === "application/xhtml+xml";
  const isJson =
    normalizedMediaType === "application/json" ||
    normalizedMediaType.endsWith("+json");

  if (candidate.kind === "inline-image" || candidate.kind === "inline-media") {
    if (isHtml || isJson) {
      return {
        acceptable: false,
        reason: `内嵌媒体「${candidate.url}」返回了 ${normalizedMediaType} 正文而非媒体字节。`,
      };
    }
    return { acceptable: true };
  }

  // Explicit attachment
  let pathname = "";
  try {
    pathname = new URL(candidate.url).pathname.toLowerCase();
  } catch {
    pathname = candidate.url.toLowerCase();
  }

  const isExplicitHtmlAttachment =
    pathname.endsWith(".html") ||
    pathname.endsWith(".htm") ||
    candidate.mediaType === "text/html" ||
    candidate.mediaType === "application/xhtml+xml";

  const isExplicitJsonAttachment =
    pathname.endsWith(".json") ||
    candidate.mediaType === "application/json" ||
    candidate.mediaType?.endsWith("+json");

  if (isHtml) {
    if (!isExplicitHtmlAttachment) {
      return {
        acceptable: false,
        reason: `附件「${candidate.url}」不是 HTML 附件但响应返回了 text/html。`,
      };
    }
    if (
      bodyText !== undefined &&
      challengeHtmlPatterns.some((p) => p.test(bodyText))
    ) {
      return {
        acceptable: false,
        reason: `HTML 附件「${candidate.url}」是人机验证或登录错误页面。`,
      };
    }
    return { acceptable: true };
  }

  if (isJson) {
    if (!isExplicitJsonAttachment) {
      return {
        acceptable: false,
        reason: `附件「${candidate.url}」不是 JSON 附件但响应返回了 application/json。`,
      };
    }
    if (bodyText !== undefined && bodyText.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        if (
          (parsed.error !== undefined &&
            parsed.error !== null &&
            parsed.error !== false) ||
          parsed.errors !== undefined ||
          ("code" in parsed && "message" in parsed) ||
          (typeof parsed.statusCode === "number" && parsed.statusCode >= 400)
        ) {
          return {
            acceptable: false,
            reason: `JSON 附件「${candidate.url}」是错误响应负载。`,
          };
        }
      } catch {
        // Not valid JSON
      }
    }
    return { acceptable: true };
  }

  return { acceptable: true };
}

export function validateMediaResponse(
  candidate: CleanContentMediaCandidate,
  mediaType: string,
  bodyText?: string,
): { readonly ok: boolean; readonly reason?: string } {
  const result = isAcceptableMediaResponse(candidate, mediaType, bodyText);
  return {
    ok: result.acceptable,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}
