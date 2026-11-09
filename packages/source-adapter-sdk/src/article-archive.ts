// Shared media downloading, validation, resource uploading, and cleaned article submission helpers.
import { Buffer } from "node:buffer";

import type {
  ArchiveCommit,
  ArchiveResourceMetadata,
  ArchiveResourceReference,
  JsonObject,
  SourceTime,
} from "@binny/contracts";

import {
  validateMediaResponse,
  type CleanContentMediaCandidate,
  type CleanContentResult,
} from "./content-cleaner.ts";
import {
  archiveResourceManifest,
  type SourceAdapterArchiveSubmission,
  type SourceAdapterContext,
} from "./index.ts";

const defaultMaximumMediaBytes = 32 * 1024 * 1024;
const defaultMediaFetchTimeoutMs = 20_000;

export class MediaFetchError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "MediaFetchError";
    this.statusCode = statusCode;
  }
}

export type MediaFetchOptions = {
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly userAgent?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maximumBytes?: number | undefined;
};

/** Downloads and validates a single media or attachment candidate. */
export async function fetchValidatedMedia(
  candidate: CleanContentMediaCandidate,
  signal: AbortSignal,
  options: MediaFetchOptions = {},
): Promise<{ readonly body: Blob; readonly mediaType: string }> {
  const timeoutMs = options.timeoutMs ?? defaultMediaFetchTimeoutMs;
  const maximumBytes = options.maximumBytes ?? defaultMaximumMediaBytes;
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);

  let response: Response;
  try {
    response = await fetch(candidate.url, {
      method: "GET",
      headers: {
        accept: "*/*",
        "user-agent": options.userAgent ?? "Binny SourceAdapter/1.0",
        ...options.headers,
      },
      signal: requestSignal,
    });
  } catch (error) {
    throw new MediaFetchError("媒体请求未能完成。", undefined, error);
  }

  if (response.status !== 200) {
    await response.body?.cancel();
    throw new MediaFetchError(
      `媒体源返回 HTTP ${response.status}。`,
      response.status,
    );
  }
  if (response.body === null) {
    throw new MediaFetchError("媒体响应没有字节内容。", response.status);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body.cancel();
    throw new MediaFetchError(
      `媒体超过 ${Math.floor(maximumBytes / 1024 / 1024)} MiB，未将其加入归档。`,
      413,
    );
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
        throw new MediaFetchError(
          `媒体超过 ${Math.floor(maximumBytes / 1024 / 1024)} MiB，未将其加入归档。`,
          413,
        );
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
      : (candidate.mediaType ?? "application/octet-stream");
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

  let bodyText: string | undefined;
  const lowerMedia = mediaType.toLowerCase();
  if (
    lowerMedia.includes("html") ||
    lowerMedia.includes("json") ||
    lowerMedia.startsWith("text/") ||
    bytes.byteLength < 4096
  ) {
    try {
      bodyText = new TextDecoder("utf-8", { fatal: false }).decode(
        bytes.subarray(0, 4096),
      );
    } catch {
      bodyText = undefined;
    }
  }

  const validation = validateMediaResponse(candidate, mediaType, bodyText);
  if (!validation.ok) {
    throw new MediaFetchError(
      validation.reason ?? "媒体响应内容不符合归档要求。",
      response.status,
    );
  }

  return {
    body: new Blob([bytes], { type: mediaType }),
    mediaType,
  };
}

export type UploadedCleanMediaResult = {
  readonly uploaded: ReadonlyMap<string, ArchiveResourceMetadata>;
  readonly resources: readonly ArchiveResourceReference[];
  readonly missing: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
  readonly problems: readonly string[];
  readonly hasMediaFailures: boolean;
};

/** Downloads and uploads all media candidates extracted by cleanContent, recording any missing media. */
export async function uploadCleanedMedia(
  context: Pick<SourceAdapterContext, "signal" | "resources">,
  cleanResult: CleanContentResult,
  options: MediaFetchOptions = {},
): Promise<UploadedCleanMediaResult> {
  const uploaded = new Map<string, ArchiveResourceMetadata>();
  const missing: { path: string; reason: string }[] = [];
  const problems: string[] = [];
  let hasMediaFailures = false;

  for (const [index, rawUrl] of cleanResult.invalidMedia.entries()) {
    const reason = `媒体地址不是可访问的 HTTP/HTTPS URL：${rawUrl}`;
    missing.push({ path: `media.invalid.${index}`, reason });
    problems.push(reason);
    hasMediaFailures = true;
  }

  for (const [index, candidate] of cleanResult.media.entries()) {
    if (context.signal.aborted) throw context.signal.reason;
    try {
      const response = await fetchValidatedMedia(
        candidate,
        context.signal,
        options,
      );
      const result = await context.resources.upload(
        response.body,
        response.mediaType,
      );
      if (!result.ok) {
        const reason = `媒体「${candidate.url}」未能写入归档：${result.error.message}`;
        missing.push({ path: `media.${index}`, reason });
        problems.push(reason);
        hasMediaFailures = true;
        continue;
      }
      uploaded.set(candidate.url, result.resource);
    } catch (error) {
      if (context.signal.aborted) throw error;
      const reason =
        error instanceof MediaFetchError
          ? `媒体「${candidate.url}」：${error.message}`
          : `媒体「${candidate.url}」本次未能取得或归档。`;
      missing.push({ path: `media.${index}`, reason });
      problems.push(reason);
      hasMediaFailures = true;
    }
  }

  return {
    uploaded,
    resources: [...archiveResourceManifest([...uploaded.values()])],
    missing,
    problems,
    hasMediaFailures,
  };
}

/**
 * Cleaned article facts and extension values submitted by `submitCleanedArticle`.
 * The extension type is inferred from the adapter schema at the action seam.
 */
export type SubmitCleanedArticleInput<TExtensions extends object> = {
  readonly sourceKey: { readonly namespace: string; readonly key: string };
  readonly sourceRef?: string | undefined;
  /** Source title, or `null` when it was not available. */
  readonly title: string | null;
  /** Source publication time, preserving exact instant/day/month/year precision. */
  readonly sourcePublishedAt: SourceTime | null;
  /** Source modification time, preserving exact instant/day/month/year precision. */
  readonly sourceModifiedAt: SourceTime | null;
  /** Structured source facts declared by the adapter's extension schema. */
  readonly extensions: TExtensions;
  readonly cleanResult: CleanContentResult;
  readonly captureScope: JsonObject;
  readonly extraMissing?:
    | readonly { readonly path: string; readonly reason: string }[]
    | undefined;
  readonly relations?: SourceAdapterArchiveSubmission<TExtensions>["relations"];
  readonly mediaOptions?: MediaFetchOptions | undefined;
};

export type SubmitCleanedArticleResult = UploadedCleanMediaResult & {
  readonly commit: ArchiveCommit;
};

/**
 * Uploads media, renders `binny://resource/<id>` references into Markdown/text,
 * and submits the item without an HTML body copy. A failed formal submission
 * rejects with the same archive error as `context.archive.submit`.
 */
export async function submitCleanedArticle<TExtensions extends object>(
  context: Pick<
    SourceAdapterContext<unknown, never, TExtensions>,
    "signal" | "resources" | "archive"
  >,
  input: SubmitCleanedArticleInput<TExtensions>,
): Promise<SubmitCleanedArticleResult> {
  const mediaResult = await uploadCleanedMedia(
    context,
    input.cleanResult,
    input.mediaOptions,
  );
  const bodyWithResources = input.cleanResult.renderArchiveBody(
    mediaResult.uploaded,
  );
  const renderedMarkdown = bodyWithResources.markdown;
  const cleanedText = input.cleanResult.text;
  const searchText = [input.title?.trim(), cleanedText.trim()]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n");

  const allMissing = [...(input.extraMissing ?? []), ...mediaResult.missing];

  const hasBody =
    renderedMarkdown.length > 0 ||
    cleanedText.length > 0 ||
    searchText.length > 0;

  const item: SourceAdapterArchiveSubmission<TExtensions>["items"][number] = {
    sourceKey: input.sourceKey,
    ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
    title: input.title,
    sourcePublishedAt: input.sourcePublishedAt,
    sourceModifiedAt: input.sourceModifiedAt,
    extensions: input.extensions,
    ...(hasBody
      ? {
          body: {
            ...(renderedMarkdown.length === 0
              ? {}
              : { markdown: renderedMarkdown }),
            ...(cleanedText.length === 0 ? {} : { text: cleanedText }),
            ...(searchText.length === 0 ? {} : { searchText }),
          },
        }
      : {}),
    ...(mediaResult.resources.length === 0
      ? {}
      : { resources: [...mediaResult.resources] }),
    capture: {
      scope: {
        ...input.captureScope,
        archivedMediaCount: mediaResult.uploaded.size,
      },
      completeness: allMissing.length === 0 ? "complete" : "partial",
      missing: allMissing,
    },
  };

  const commit = await context.archive.submit({
    items: [item],
    ...(input.relations === undefined ? {} : { relations: input.relations }),
  });
  return {
    ...mediaResult,
    missing: allMissing,
    commit,
  };
}
