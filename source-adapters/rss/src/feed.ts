import { Readability } from "@mozilla/readability";
import { parseFeed } from "@rowanmanning/feed-parser";
import { JSDOM } from "jsdom";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

type FeedParserJson = ReturnType<ReturnType<typeof parseFeed>["toJSON"]>;
type FeedParserItem = ReturnType<typeof parseFeed>["items"][number];
type FeedParserElement = FeedParserItem["element"];

export type ParsedFeedItem = FeedParserJson["items"][number] & {
  readonly contentType?: string;
  readonly descriptionType?: string;
};
export type ParsedFeed = Omit<FeedParserJson, "items"> & {
  readonly items: ParsedFeedItem[];
};

export interface FeedDefinition {
  readonly id: string;
  readonly url: string;
  readonly title?: string | undefined;
}

export interface FeedValidators {
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
}

export type FeedRequestResult =
  | {
      readonly status: "not-modified";
      readonly validators: FeedValidators;
    }
  | {
      readonly status: "ok";
      readonly feed: ParsedFeed;
      readonly validators: FeedValidators;
    };

export class FeedRequestError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "FeedRequestError";
    this.statusCode = statusCode;
  }
}

export type InlineMediaReference = {
  readonly kind: "media";
  readonly url: string;
  readonly alt: string;
  readonly display: "image" | "link";
};

export type BodyPart = string | InlineMediaReference;

export interface MediaCandidate {
  readonly url: string;
  readonly mediaType?: string | undefined;
  readonly title?: string | undefined;
}

export interface PreparedBody {
  readonly html: string;
  readonly text: string;
  readonly type: string;
  readonly source: "content" | "summary" | "static-html";
  readonly parts: readonly BodyPart[];
  readonly media: readonly MediaCandidate[];
  readonly invalidMedia: readonly string[];
  rewriteHtml(references: ReadonlyMap<string, string>): string;
}

export type StaticArticleResult =
  | {
      readonly status: "extracted";
      readonly requestedUrl: string;
      readonly finalUrl: string;
      readonly title: string | null;
      readonly html: string;
    }
  | {
      readonly status: "unavailable";
      readonly requestedUrl: string;
      readonly reason: string;
      readonly suggestion: string;
    };

const maximumFeedBytes = 10 * 1024 * 1024;
const maximumStaticPageBytes = 8 * 1024 * 1024;
const maximumMediaBytes = 32 * 1024 * 1024;
const minimumStaticArticleTextLength = 100;
const fetchTimeoutMs = 20_000;
const feedAccept =
  "application/atom+xml, application/rss+xml, application/xml, text/xml, application/*+xml;q=0.9, */*;q=0.8";

function atomTextConstructType(
  item: FeedParserItem,
  name: "content" | "summary",
): string | undefined {
  const construct = item.element.findElementWithName(name);
  if (construct === null) return undefined;
  return construct.getAttribute("type")?.trim().toLowerCase() || "text";
}

function atomTextConstructValue(
  item: FeedParserItem,
  name: "content" | "summary",
): string | null {
  const construct = item.element.findElementWithName(name);
  if (construct === null) return null;
  if (atomTextConstructType(item, name) === "xhtml") {
    const div = construct.findElementWithName("div");
    if (div !== null) return div.children.map(serializeXhtmlChild).join("");
  }
  return construct.textContent;
}

function parsedRssItem(item: FeedParserItem): ParsedFeedItem {
  const value = item.toJSON();
  const encodedContent = item.element.findElementWithName("encoded");
  const description = item.element.findElementWithName("description");
  return {
    ...value,
    content:
      encodedContent?.namespace === "content" &&
      encodedContent.textContent.length > 0
        ? encodedContent.textContent
        : value.content,
    description: description?.textContent || value.description,
  };
}

function serializeXhtmlChild(child: string | FeedParserElement): string {
  if (typeof child === "string") return htmlText(child);
  const attributes = Object.entries(child.attributes)
    .map(
      ([name, value]) =>
        ` ${name}="${htmlText(value).replaceAll('"', "&quot;")}"`,
    )
    .join("");
  const content = child.children.map(serializeXhtmlChild).join("");
  return `<${child.name}${attributes}>${content}</${child.name}>`;
}

function parsedFeedWithBodyTypes(source: string): ParsedFeed {
  const parsed = parseFeed(source);
  const json = parsed.toJSON();
  if (parsed.meta.type === "rss") {
    return { ...json, items: parsed.items.map(parsedRssItem) };
  }
  if (parsed.meta.type !== "atom") return json;
  return {
    ...json,
    items: parsed.items.map((item) => {
      const value = item.toJSON();
      const contentType = atomTextConstructType(item, "content");
      const descriptionType = atomTextConstructType(item, "summary");
      return {
        ...value,
        content: atomTextConstructValue(item, "content"),
        description:
          atomTextConstructValue(item, "summary") ?? value.description,
        ...(contentType === undefined ? {} : { contentType }),
        ...(descriptionType === undefined ? {} : { descriptionType }),
      };
    }),
  };
}

function htmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isHtmlTextConstruct(type: string | undefined): boolean {
  return (
    type === undefined ||
    type === "html" ||
    type === "xhtml" ||
    type === "text/html" ||
    type === "application/xhtml+xml"
  );
}

function responseValidators(response: Response): FeedValidators {
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]);
}

async function readLimitedText(
  response: Response,
  maximumBytes = maximumFeedBytes,
  contentName = "RSS/Atom feed",
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel();
    throw new FeedRequestError(
      `${contentName}超过 ${Math.floor(maximumBytes / 1024 / 1024)} MiB，未读取其正文。`,
      413,
    );
  }

  if (response.body === null) {
    throw new FeedRequestError("RSS/Atom feed 响应没有正文。", response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new FeedRequestError(
          `${contentName}超过 ${Math.floor(maximumBytes / 1024 / 1024)} MiB，未读取其正文。`,
          413,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const contentType = response.headers.get("content-type") ?? "";
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/iu.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FeedRequestError(
      `${contentName}正文不是可识别的文本编码。`,
      response.status,
      error,
    );
  }
}

function staticArticleUnavailable(
  requestedUrl: string,
  reason: string,
): StaticArticleResult {
  return {
    status: "unavailable",
    requestedUrl,
    reason:
      `${reason} 页面可能需要登录、脚本渲染或特殊交互，` +
      "本次保留 feed 摘要并将其标记为 partial。",
    suggestion:
      "检查页面是否无需登录即可直接读取正文；需要脚本或特殊交互时，请提供可公开访问的静态正文来源。",
  };
}

export async function fetchStaticArticle(
  requestedUrl: string,
  signal: AbortSignal,
): Promise<StaticArticleResult> {
  const normalizedUrl = httpUrl(requestedUrl, requestedUrl);
  if (normalizedUrl === undefined) {
    return staticArticleUnavailable(
      requestedUrl,
      "条目链接不是可读取的 HTTP/HTTPS 页面。",
    );
  }

  let response: Response;
  try {
    response = await fetch(normalizedUrl, {
      method: "GET",
      headers: {
        accept: "text/html, application/xhtml+xml;q=0.9",
        "user-agent": "Binny RSS sourceAdapter/1.0",
      },
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return staticArticleUnavailable(
      normalizedUrl,
      "公开文章页面本次无法访问。",
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    return staticArticleUnavailable(
      normalizedUrl,
      `公开文章页面返回 HTTP ${response.status}。`,
    );
  }

  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    await response.body?.cancel();
    return staticArticleUnavailable(
      normalizedUrl,
      "公开文章页面没有返回 HTML 正文。",
    );
  }

  let source: string;
  try {
    source = await readLimitedText(
      response,
      maximumStaticPageBytes,
      "静态文章页面",
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const reason =
      error instanceof Error ? error.message : "公开文章页面本次无法读取。";
    return staticArticleUnavailable(normalizedUrl, reason);
  }

  const finalUrl = httpUrl(response.url, normalizedUrl);
  if (finalUrl === undefined) {
    return staticArticleUnavailable(
      normalizedUrl,
      "公开文章页面跳转到了不可读取的地址。",
    );
  }

  let page: JSDOM;
  try {
    page = new JSDOM(source, { url: finalUrl });
  } catch {
    return staticArticleUnavailable(
      normalizedUrl,
      "公开文章页面无法解析为静态正文。",
    );
  }
  try {
    const document = page.window.document;
    const hasPasswordInput =
      document.querySelector('input[type="password"]') !== null;
    // 逐段预筛选会漏掉短段落组成的完整文章，改用解析后的总正文长度判断。
    const article = new Readability(document, {
      charThreshold: minimumStaticArticleTextLength,
    }).parse();
    const text = article?.textContent?.trim();
    if (
      article === null ||
      article.content === null ||
      article.content === undefined ||
      text === undefined ||
      text.length < minimumStaticArticleTextLength
    ) {
      return staticArticleUnavailable(
        normalizedUrl,
        hasPasswordInput
          ? "公开文章页面提示需要登录，且没有足够正文可供提取。"
          : "页面没有足够的静态文章正文可供提取。",
      );
    }
    return {
      status: "extracted",
      requestedUrl: normalizedUrl,
      finalUrl,
      title: article.title?.trim() || null,
      html: article.content,
    };
  } catch {
    return staticArticleUnavailable(
      normalizedUrl,
      "公开文章页面的正文提取未能完成。",
    );
  } finally {
    page.window.close();
  }
}

export async function requestFeed(
  url: string,
  validators: FeedValidators,
  signal: AbortSignal,
): Promise<FeedRequestResult> {
  const headers = new Headers({
    accept: feedAccept,
    "user-agent": "Binny RSS sourceAdapter/1.0",
  });
  if (validators.etag !== undefined) {
    headers.set("if-none-match", validators.etag);
  }
  if (validators.lastModified !== undefined) {
    headers.set("if-modified-since", validators.lastModified);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: requestSignal(signal),
    });
  } catch (error) {
    throw new FeedRequestError(
      "RSS/Atom feed 请求未能完成。",
      undefined,
      error,
    );
  }

  const responseHeaders = responseValidators(response);
  if (response.status === 304) {
    return { status: "not-modified", validators: responseHeaders };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FeedRequestError(
      `RSS/Atom feed 返回 HTTP ${response.status}。`,
      response.status,
    );
  }

  const source = await readLimitedText(response);
  try {
    return {
      status: "ok",
      feed: parsedFeedWithBodyTypes(source),
      validators: responseHeaders,
    };
  } catch (error) {
    if (error instanceof FeedRequestError) throw error;
    throw new FeedRequestError(
      "响应不是可解析的 RSS/Atom feed。",
      response.status,
      error,
    );
  }
}

export async function fetchMedia(
  url: string,
  fallbackMediaType: string | undefined,
  signal: AbortSignal,
): Promise<{ readonly body: Blob; readonly mediaType: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "*/*", "user-agent": "Binny RSS sourceAdapter/1.0" },
      signal: requestSignal(signal),
    });
  } catch (error) {
    throw new FeedRequestError("媒体请求未能完成。", undefined, error);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new FeedRequestError(
      `媒体源返回 HTTP ${response.status}。`,
      response.status,
    );
  }
  if (response.body === null) {
    throw new FeedRequestError("媒体响应没有字节内容。", response.status);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumMediaBytes) {
    await response.body.cancel();
    throw new FeedRequestError("媒体超过 32 MiB，未将其加入归档。", 413);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumMediaBytes) {
        await reader.cancel();
        throw new FeedRequestError("媒体超过 32 MiB，未将其加入归档。", 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const headerMediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  const mediaType =
    headerMediaType !== undefined &&
    /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(headerMediaType)
      ? headerMediaType
      : (fallbackMediaType ?? "application/octet-stream");
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    body: new Blob([bytes], { type: mediaType }),
    mediaType,
  };
}

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

function updateAttribute(
  element: DefaultTreeAdapterMap["element"],
  name: string,
  value: string,
): void {
  const attribute = element.attrs.find((current) => current.name === name);
  if (attribute === undefined) {
    element.attrs.push({ name, value });
  } else {
    attribute.value = value;
  }
}

function httpUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
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

function addMediaCandidate(
  media: Map<string, MediaCandidate>,
  invalidMedia: string[],
  rawUrl: string,
  baseUrl: string,
  mediaType?: string | null,
  title?: string | null,
): string | undefined {
  if (rawUrl.startsWith("data:")) return undefined;
  const url = httpUrl(rawUrl, baseUrl);
  if (url === undefined) {
    invalidMedia.push(rawUrl);
    return undefined;
  }
  const previous = media.get(url);
  media.set(url, {
    url,
    ...(mediaType === null || mediaType === undefined
      ? previous?.mediaType === undefined
        ? {}
        : { mediaType: previous.mediaType }
      : { mediaType }),
    ...(title === null || title === undefined
      ? previous?.title === undefined
        ? {}
        : { title: previous.title }
      : { title }),
  });
  return url;
}

export function prepareBody(
  item: ParsedFeedItem,
  baseUrl: string,
  source: "feed" | "static-html" = "feed",
): PreparedBody {
  const hasContent = (item.content?.trim().length ?? 0) > 0;
  const bodyText = hasContent ? (item.content ?? "") : (item.description ?? "");
  const type =
    source === "static-html"
      ? "html"
      : hasContent
        ? item.contentType
        : item.descriptionType;
  const html = isHtmlTextConstruct(type) ? bodyText : htmlText(bodyText);
  const bodySource =
    source === "static-html"
      ? "static-html"
      : hasContent
        ? "content"
        : "summary";

  const fragment = parseFragment(html);
  const parts: BodyPart[] = [];
  const textParts: string[] = [];
  const media = new Map<string, MediaCandidate>();
  const invalidMedia: string[] = [];
  const inlineReferences: {
    element: DefaultTreeAdapterMap["element"];
    attribute: string;
    url: string;
  }[] = [];

  function appendInline(
    element: DefaultTreeAdapterMap["element"],
    attribute: string | undefined,
    rawUrl: string,
    display: "image" | "link",
    alt: string,
  ): void {
    const url = addMediaCandidate(media, invalidMedia, rawUrl, baseUrl);
    if (url === undefined) {
      if (!rawUrl.startsWith("data:")) {
        parts.push({ kind: "media", url: rawUrl, alt, display });
      }
      return;
    }
    if (attribute !== undefined)
      inlineReferences.push({ element, attribute, url });
    parts.push({ kind: "media", url, alt, display });
  }

  function walk(node: DefaultTreeAdapterMap["childNode"]): void {
    if (!isElement(node)) {
      if (node.nodeName === "#text") {
        parts.push(node.value);
        textParts.push(node.value);
      }
      return;
    }

    const tag = node.tagName;
    if (tag === "script" || tag === "style" || tag === "noscript") return;
    if (
      ["p", "div", "section", "article", "blockquote", "pre", "li"].includes(
        tag,
      )
    ) {
      parts.push("\n\n");
      textParts.push(" ");
    }
    const alt = getAttribute(node, "alt") ?? getAttribute(node, "title") ?? "";
    if (tag === "img") {
      const sourceUrl = getAttribute(node, "src");
      if (sourceUrl !== undefined)
        appendInline(node, "src", sourceUrl, "image", alt);
      const sourceSet = getAttribute(node, "srcset");
      if (sourceSet !== undefined) {
        for (const candidate of parseSrcset(sourceSet)) {
          appendInline(node, undefined, candidate.url, "image", alt);
        }
      }
      if (alt.length > 0) textParts.push(alt);
    } else if (["audio", "source", "track", "video"].includes(tag)) {
      const sourceUrl = getAttribute(node, "src");
      if (sourceUrl !== undefined)
        appendInline(node, "src", sourceUrl, "link", alt);
      const poster = getAttribute(node, "poster");
      if (poster !== undefined)
        appendInline(node, "poster", poster, "image", alt);
    } else if (tag === "object") {
      const sourceUrl = getAttribute(node, "data");
      if (sourceUrl !== undefined)
        appendInline(node, "data", sourceUrl, "link", alt);
    } else if (tag === "a" && getAttribute(node, "download") !== undefined) {
      const sourceUrl = getAttribute(node, "href");
      if (sourceUrl !== undefined)
        appendInline(node, "href", sourceUrl, "link", alt);
    }

    for (const child of node.childNodes) walk(child);
    if (
      ["p", "div", "section", "article", "blockquote", "pre", "li"].includes(
        tag,
      )
    ) {
      parts.push("\n\n");
      textParts.push(" ");
    }
  }

  for (const child of fragment.childNodes) walk(child);

  for (const mediaItem of item.media) {
    addMediaCandidate(
      media,
      invalidMedia,
      mediaItem.url,
      baseUrl,
      mediaItem.mimeType,
      mediaItem.title,
    );
  }
  if (item.image !== null) {
    addMediaCandidate(
      media,
      invalidMedia,
      item.image.url,
      baseUrl,
      null,
      item.image.title,
    );
  }

  const text = textParts.join("").replace(/\s+/gu, " ").trim();
  return {
    html,
    text,
    type: type ?? "html",
    source: bodySource,
    parts,
    media: [...media.values()],
    invalidMedia,
    rewriteHtml(references) {
      for (const reference of inlineReferences) {
        const archivedReference = references.get(reference.url);
        if (archivedReference !== undefined) {
          updateAttribute(
            reference.element,
            reference.attribute,
            archivedReference,
          );
        }
      }
      for (const child of fragment.childNodes) {
        const stack: DefaultTreeAdapterMap["childNode"][] = [child];
        while (stack.length > 0) {
          const current = stack.pop();
          if (current === undefined || !isElement(current)) continue;
          const sourceSet = getAttribute(current, "srcset");
          if (sourceSet !== undefined) {
            const rewritten = parseSrcset(sourceSet).map(
              ({ url, descriptor }) => {
                const normalizedUrl = httpUrl(url, baseUrl);
                const archivedReference =
                  normalizedUrl === undefined
                    ? undefined
                    : references.get(normalizedUrl);
                return `${archivedReference ?? url}${descriptor.length === 0 ? "" : ` ${descriptor}`}`;
              },
            );
            updateAttribute(current, "srcset", rewritten.join(", "));
          }
          stack.push(...current.childNodes);
        }
      }
      return serialize(fragment);
    },
  };
}

export function stableEntryIdentity(
  item: ParsedFeedItem,
  baseUrl?: string,
):
  | { readonly kind: "id"; readonly value: string }
  | { readonly kind: "url"; readonly value: string }
  | undefined {
  const id = item.id?.trim();
  if (id !== undefined && id.length > 0) return { kind: "id", value: id };
  if (item.url === null) return undefined;
  const url = httpUrl(item.url, baseUrl ?? item.url);
  if (url === undefined) return undefined;
  return { kind: "url", value: url };
}

export function normalizeMediaUrl(
  value: string,
  baseUrl: string,
): string | undefined {
  return httpUrl(value, baseUrl);
}
