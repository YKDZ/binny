import { Buffer } from "node:buffer";

import {
  cleanContent,
  validateMediaResponse,
  type CleanContentMediaCandidate,
  type CleanContentResult,
} from "@binny/source-adapter-sdk";
import { parseFeed } from "@rowanmanning/feed-parser";

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
  readonly bodyField?: "auto" | "content" | "summary" | undefined;
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

const maximumFeedBytes = 10 * 1024 * 1024;
const maximumMediaBytes = 32 * 1024 * 1024;
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

function isAtomTextConstruct(type: string | undefined): boolean {
  return type === "text" || type === "text/plain";
}

function isAtomXhtmlConstruct(type: string | undefined): boolean {
  return type === "xhtml" || type === "application/xhtml+xml";
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
  candidateOrUrl: CleanContentMediaCandidate | string,
  fallbackOrSignal?: string | AbortSignal,
  maybeSignal?: AbortSignal,
): Promise<{ readonly body: Blob; readonly mediaType: string }> {
  const isCandidateObject = typeof candidateOrUrl !== "string";
  const url = isCandidateObject ? candidateOrUrl.url : candidateOrUrl;
  const fallbackMediaType = isCandidateObject
    ? candidateOrUrl.mediaType
    : typeof fallbackOrSignal === "string"
      ? fallbackOrSignal
      : undefined;
  const signal =
    fallbackOrSignal instanceof AbortSignal
      ? fallbackOrSignal
      : maybeSignal instanceof AbortSignal
        ? maybeSignal
        : new AbortController().signal;

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

  const candidate: CleanContentMediaCandidate = isCandidateObject
    ? candidateOrUrl
    : {
        url,
        kind: "attachment",
        mediaType: fallbackMediaType,
      };

  let bodyText: string | undefined;
  if (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json")
  ) {
    try {
      bodyText = bytes.toString("utf8");
    } catch {
      // Body is not text
    }
  }

  const validation = validateMediaResponse(candidate, mediaType, bodyText);
  if (!validation.ok) {
    throw new FeedRequestError(
      validation.reason ?? `媒体「${url}」返回了不受支持的内容类型。`,
      response.status,
    );
  }

  return {
    body: new Blob([bytes], { type: mediaType }),
    mediaType,
  };
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

export interface PreparedFeedItem {
  readonly bodySource: "content" | "summary" | "none";
  readonly bodyType: string;
  readonly cleanResult: CleanContentResult;
  readonly isComplete: boolean;
  readonly missingReason?: string | undefined;
}

export function prepareFeedItem(
  feed: FeedDefinition,
  item: ParsedFeedItem,
  baseUrl: string,
): PreparedFeedItem {
  const mode = feed.bodyField ?? "auto";

  const extraMedia: CleanContentMediaCandidate[] = [];
  for (const media of item.media) {
    if (media.url) {
      extraMedia.push({
        url: media.url,
        kind: "attachment",
        mediaType: media.mimeType ?? undefined,
        title: media.title ?? undefined,
      });
    }
  }
  if (item.image?.url) {
    extraMedia.push({
      url: item.image.url,
      kind: "attachment",
      title: item.image.title ?? undefined,
    });
  }

  const hasContent =
    item.content !== null &&
    item.content !== undefined &&
    item.content.trim().length > 0;
  const hasDescription =
    item.description !== null &&
    item.description !== undefined &&
    item.description.trim().length > 0;

  if (mode === "summary") {
    if (!hasDescription && !hasContent) {
      const emptyResult = cleanContent("", {
        baseUrl,
        format: "text",
        extraMedia,
      });
      return {
        bodySource: "none",
        bodyType: "text",
        cleanResult: emptyResult,
        isComplete: false,
        missingReason: "feed 条目没有可读取的正文或摘要。",
      };
    }
    const raw = hasDescription ? item.description! : item.content!;
    const type = hasDescription
      ? (item.descriptionType ?? "html")
      : (item.contentType ?? "html");
    const format = isAtomTextConstruct(type)
      ? "text"
      : isAtomXhtmlConstruct(type)
        ? "xhtml"
        : "html";
    const cleaned = cleanContent(raw, { baseUrl, format, extraMedia });
    const isEmpty =
      cleaned.text.trim().length === 0 && cleaned.media.length === 0;
    if (isEmpty) {
      return {
        bodySource: "summary",
        bodyType: type,
        cleanResult: cleaned,
        isComplete: false,
        missingReason: "feed 条目没有可读取的正文或摘要。",
      };
    }
    return {
      bodySource: "summary",
      bodyType: type,
      cleanResult: cleaned,
      isComplete: true,
    };
  }

  if (mode === "content") {
    if (!hasContent) {
      const emptyResult = cleanContent("", {
        baseUrl,
        format: "text",
        extraMedia,
      });
      return {
        bodySource: "none",
        bodyType: "text",
        cleanResult: emptyResult,
        isComplete: false,
        missingReason:
          "feed 配置要求使用 content 字段，但该条目未提供 content 正文。",
      };
    }
    const raw = item.content!;
    const type = item.contentType ?? "html";
    const format = isAtomTextConstruct(type)
      ? "text"
      : isAtomXhtmlConstruct(type)
        ? "xhtml"
        : "html";
    const cleaned = cleanContent(raw, { baseUrl, format, extraMedia });
    const isEmpty =
      cleaned.text.trim().length === 0 && cleaned.media.length === 0;
    if (isEmpty) {
      return {
        bodySource: "content",
        bodyType: type,
        cleanResult: cleaned,
        isComplete: false,
        missingReason: "feed 条目没有可读取的正文或摘要。",
      };
    }
    return {
      bodySource: "content",
      bodyType: type,
      cleanResult: cleaned,
      isComplete: true,
    };
  }

  // mode === "auto"
  if (hasContent) {
    const raw = item.content!;
    const type = item.contentType ?? "html";
    const format = isAtomTextConstruct(type)
      ? "text"
      : isAtomXhtmlConstruct(type)
        ? "xhtml"
        : "html";
    const cleaned = cleanContent(raw, { baseUrl, format, extraMedia });
    const isEmpty =
      cleaned.text.trim().length === 0 && cleaned.media.length === 0;
    if (!isEmpty) {
      return {
        bodySource: "content",
        bodyType: type,
        cleanResult: cleaned,
        isComplete: true,
      };
    }
  }

  if (hasDescription) {
    const raw = item.description!;
    const type = item.descriptionType ?? "html";
    const format = isAtomTextConstruct(type)
      ? "text"
      : isAtomXhtmlConstruct(type)
        ? "xhtml"
        : "html";
    const cleaned = cleanContent(raw, { baseUrl, format, extraMedia });
    const isEmpty =
      cleaned.text.trim().length === 0 && cleaned.media.length === 0;
    if (isEmpty) {
      return {
        bodySource: "summary",
        bodyType: type,
        cleanResult: cleaned,
        isComplete: false,
        missingReason: "feed 条目没有可读取的正文或摘要。",
      };
    }
    return {
      bodySource: "summary",
      bodyType: type,
      cleanResult: cleaned,
      isComplete: true,
    };
  }

  const emptyResult = cleanContent("", {
    baseUrl,
    format: "text",
    extraMedia,
  });
  return {
    bodySource: "none",
    bodyType: "text",
    cleanResult: emptyResult,
    isComplete: false,
    missingReason: "feed 条目没有可读取的正文或摘要。",
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
