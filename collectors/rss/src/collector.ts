import { createHash } from "node:crypto";

import {
  archiveBodyWithResources,
  archiveResourceManifest,
  archivedMedia,
  collectorActionError,
  defineCollector,
  defineCollectorAction,
  defineCollectorCheckAction,
  type ArchiveResourceMetadata,
  type CollectorCheckContext,
  type CollectorContext,
} from "@binny/collector-sdk";
import * as z from "zod";

import {
  FeedRequestError,
  fetchMedia,
  normalizeMediaUrl,
  prepareBody,
  requestFeed,
  stableEntryIdentity,
  type FeedDefinition,
  type FeedRequestResult,
  type MediaCandidate,
  type ParsedFeedItem,
} from "./feed.ts";
import {
  hasPendingMedia,
  readFeedState,
  upsertFeedEntry,
  writeFeedState,
  type FeedEntryState,
  type FeedState,
} from "./state.ts";

const feedIdSchema = z
  .string()
  .min(1, "feed 稳定标识不能为空。")
  .max(128, "feed 稳定标识不能超过 128 个字符。")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u,
    "feed 稳定标识只能包含字母、数字、点、下划线和连字符。",
  );

const feedUrlSchema = z
  .url("feed 地址必须是有效 URL。")
  .max(4096, "feed 地址不能超过 4096 个字符。")
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "feed 地址必须使用 HTTP 或 HTTPS。")
  .refine((value) => {
    const url = new URL(value);
    return url.username.length === 0 && url.password.length === 0;
  }, "feed 地址不能包含用户名或密码。")
  .describe("RSS/Atom feed 地址。采集器读取正文，不归档整份 feed 响应。");

const feedDefinitionSchema = z
  .object({
    id: feedIdSchema.describe(
      "信源稳定标识。同一 feed 在不同 bin 与地址编辑后必须沿用相同标识；不同信源使用不同标识。",
    ),
    url: feedUrlSchema,
    title: z.string().min(1).max(512).optional(),
  })
  .strict();

const collectorConfigSchema = z
  .object({ feeds: z.array(feedDefinitionSchema).min(1).max(64) })
  .strict()
  .superRefine((config, context) => {
    const feedIds = new Set<string>();
    for (const [index, feed] of config.feeds.entries()) {
      if (feedIds.has(feed.id)) {
        context.addIssue({
          code: "custom",
          path: ["feeds", index, "id"],
          message: "同一配置不能重复使用 feed 稳定标识。",
        });
      }
      feedIds.add(feed.id);
    }
  });

const actionParamsSchema = z
  .object({ feedIds: z.array(feedIdSchema).max(64).optional() })
  .strict()
  .superRefine((params, context) => {
    const feedIds = new Set<string>();
    for (const [index, feedId] of (params.feedIds ?? []).entries()) {
      if (feedIds.has(feedId)) {
        context.addIssue({
          code: "custom",
          path: ["feedIds", index],
          message: "本次运行参数不能重复选择同一个 feed。",
        });
      }
      feedIds.add(feedId);
    }
  });

type CollectorConfig = z.infer<typeof collectorConfigSchema>;
type ActionParams = z.infer<typeof actionParamsSchema>;
function collectorStateDirectory(): string {
  return (
    process.env.BINNY_COLLECTOR_STATE_DIRECTORY ??
    "/var/lib/binny/collector-state"
  );
}

function parseConfig(value: unknown): CollectorConfig {
  const checked = collectorConfigSchema.safeParse(value);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw collectorActionError({
      code: "rss_configuration_invalid",
      message: issue?.message ?? "RSS/Atom 采集配置无效。",
      impact: "本次运行没有读取或归档任何 feed。",
      ...(issue === undefined
        ? {}
        : { path: issue.path.map((part) => String(part)) }),
      suggestion: "检查 feeds 中的稳定标识与 HTTP/HTTPS 地址。",
      requiresHuman: false,
    });
  }
  return checked.data;
}

function selectedFeeds(
  config: CollectorConfig,
  params: ActionParams,
): {
  readonly feeds: readonly FeedDefinition[];
  readonly missing: readonly string[];
} {
  if (params.feedIds === undefined) return { feeds: config.feeds, missing: [] };
  const byId = new Map(config.feeds.map((feed) => [feed.id, feed]));
  const feeds: FeedDefinition[] = [];
  const missing: string[] = [];
  for (const feedId of params.feedIds) {
    const feed = byId.get(feedId);
    if (feed === undefined) missing.push(feedId);
    else feeds.push(feed);
  }
  return { feeds, missing };
}

function feedProblem(
  feedId: string,
  code: string,
  message: string,
  suggestion: string,
) {
  return {
    code,
    message,
    impact: `RSS/Atom feed「${feedId}」无法按当前范围完整检查。`,
    path: ["feeds", feedId],
    suggestion,
    requiresHuman: false,
  };
}

function identityKey(
  feed: FeedDefinition,
  item: ParsedFeedItem,
): { readonly key: string; readonly kind: "id" | "url" } | undefined {
  const identity = stableEntryIdentity(item, feed.url);
  if (identity === undefined) return undefined;
  const key = `${identity.kind}:${identity.value}`;
  if (key.length > 1024 || key.includes("\u0000")) return undefined;
  return { key, kind: identity.kind };
}

function sourceRef(feed: FeedDefinition, item: ParsedFeedItem): string {
  if (item.url !== null) {
    const normalized = normalizeMediaUrl(item.url, feed.url);
    if (normalized !== undefined) return normalized;
  }
  return feed.url;
}

function contentFingerprint(
  feed: FeedDefinition,
  parsedFeed: FeedRequestResult & { readonly status: "ok" },
  item: ParsedFeedItem,
  body: ReturnType<typeof prepareBody>,
  key: string,
): string {
  const snapshot = JSON.stringify({
    key,
    feed: {
      id: feed.id,
      url: feed.url,
      title: feed.title ?? parsedFeed.feed.title,
      format: parsedFeed.feed.meta,
    },
    item: {
      id: item.id,
      url: item.url,
      title: item.title,
      description: item.description,
      content: item.content,
      published: item.published,
      updated: item.updated,
      authors: item.authors,
      categories: item.categories,
      image: item.image,
      media: item.media,
    },
    body:
      body === undefined
        ? null
        : { source: body.source, type: body.type, html: body.html },
  });
  return createHash("sha256").update(snapshot).digest("hex");
}

function entryMetadata(
  feed: FeedDefinition,
  parsedFeed: FeedRequestResult & { readonly status: "ok" },
  item: ParsedFeedItem,
  body: ReturnType<typeof prepareBody>,
  media: readonly MediaCandidate[],
): Record<string, unknown> {
  return {
    feed: {
      id: feed.id,
      url: feed.url,
      title: feed.title ?? parsedFeed.feed.title,
      description: parsedFeed.feed.description,
      link: parsedFeed.feed.url,
      language: parsedFeed.feed.language,
      format: parsedFeed.feed.meta,
      generator: parsedFeed.feed.generator,
    },
    item: {
      id: item.id,
      url: item.url,
      title: item.title,
      published: item.published,
      updated: item.updated,
      bodyType: body.type,
      authors: item.authors,
      categories: item.categories,
      image: item.image,
    },
    media: media.map(({ url, mediaType, title }) => ({
      url,
      mediaType: mediaType ?? null,
      title: title ?? null,
    })),
  };
}

function markdownText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

function markdownPlainText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownParts(
  body: ReturnType<typeof prepareBody>,
  uploaded: ReadonlyMap<string, ArchiveResourceMetadata>,
  candidates: readonly MediaCandidate[],
): (string | ReturnType<typeof archivedMedia>)[] {
  const parts: (string | ReturnType<typeof archivedMedia>)[] = [];
  const inlineUrls = new Set<string>();
  if (body !== undefined) {
    for (const part of body.parts) {
      if (typeof part === "string") {
        parts.push(markdownPlainText(part));
        continue;
      }
      inlineUrls.add(part.url);
      const resource = uploaded.get(part.url);
      const alt = markdownText(part.alt || "媒体");
      if (part.display === "image") {
        parts.push(`![${alt}](`);
        parts.push(resource === undefined ? part.url : archivedMedia(resource));
        parts.push(")");
      } else {
        parts.push(`[${alt}](`);
        parts.push(resource === undefined ? part.url : archivedMedia(resource));
        parts.push(")");
      }
    }
  }

  const attachments = candidates.filter(({ url }) => !inlineUrls.has(url));
  if (attachments.length > 0) {
    parts.push("\n\n附件：");
    for (const [index, candidate] of attachments.entries()) {
      if (index > 0) parts.push("；");
      const resource = uploaded.get(candidate.url);
      parts.push(markdownText(candidate.title ?? `媒体 ${index + 1}`), " (");
      parts.push(
        resource === undefined ? candidate.url : archivedMedia(resource),
      );
      parts.push(")");
    }
  }
  return parts;
}

async function submitEntry(
  context: CollectorContext,
  feed: FeedDefinition,
  parsedFeed: FeedRequestResult & { readonly status: "ok" },
  item: ParsedFeedItem,
  key: string,
): Promise<{
  readonly pendingMedia: boolean;
  readonly problems: readonly string[];
}> {
  const body = prepareBody(item, sourceRef(feed, item));
  const media = new Map<string, MediaCandidate>();
  for (const candidate of body?.media ?? [])
    media.set(candidate.url, candidate);
  const invalidUrls = body?.invalidMedia ?? [];
  const uploaded = new Map<string, ArchiveResourceMetadata>();
  const missing: { path: string; reason: string }[] = [];
  const failures: string[] = [];

  if (
    body === undefined ||
    body.html.trim().length === 0 ||
    body.source === "summary"
  ) {
    missing.push({
      path: "body.fullText",
      reason:
        body === undefined || body.html.trim().length === 0
          ? "feed 条目没有正文或摘要字段。"
          : "feed 只提供 description/summary；本次仅归档摘要，不能声称已取得全文。",
    });
  }
  for (const [index, rawUrl] of invalidUrls.entries()) {
    const reason = `媒体地址不是可访问的 HTTP/HTTPS URL：${rawUrl}`;
    missing.push({ path: `media.invalid.${index}`, reason });
    failures.push(reason);
  }

  for (const [index, candidate] of [...media.values()].entries()) {
    if (context.signal.aborted) throw context.signal.reason;
    try {
      const response = await fetchMedia(
        candidate.url,
        candidate.mediaType,
        context.signal,
      );
      const result = await context.resources.upload(
        response.body,
        response.mediaType,
      );
      if (!result.ok) {
        const reason = `媒体「${candidate.url}」未能写入归档：${result.error.message}`;
        missing.push({
          path: `media.${index}`,
          reason,
        });
        failures.push(reason);
        continue;
      }
      uploaded.set(candidate.url, result.resource);
    } catch (error) {
      if (context.signal.aborted) throw error;
      const reason = `媒体「${candidate.url}」本次未能取得或归档。`;
      missing.push({ path: `media.${index}`, reason });
      failures.push(reason);
    }
  }

  const feedResourceReferences = new Map(
    [...uploaded].map(([url, resource]) => [
      url,
      archivedMedia(resource).reference,
    ]),
  );
  const bodyWithResources = archiveBodyWithResources(
    markdownParts(body, uploaded, [...media.values()]),
  );
  const resources = [...archiveResourceManifest([...uploaded.values()])];
  const sourceModifiedAt = item.updated ?? item.published ?? undefined;
  const html = body?.rewriteHtml(feedResourceReferences);
  const state = {
    sourceKey: { namespace: `rss:${feed.id}`, key },
    sourceRef: sourceRef(feed, item),
    ...(sourceModifiedAt === undefined ? {} : { sourceModifiedAt }),
    metadata: entryMetadata(feed, parsedFeed, item, body, [...media.values()]),
    ...(body === undefined && bodyWithResources.content.length === 0
      ? {}
      : {
          body: {
            ...(html === undefined || html.length === 0 ? {} : { html }),
            ...(body?.text === undefined || body.text.length === 0
              ? {}
              : { text: body.text }),
            ...(bodyWithResources.content.length === 0
              ? {}
              : { markdown: bodyWithResources.content }),
            ...(body?.text === undefined || body.text.length === 0
              ? {}
              : { searchText: body.text }),
          },
        }),
    ...(resources.length === 0 ? {} : { resources }),
    capture: {
      scope: {
        feedId: feed.id,
        feedUrl: feed.url,
        entryIdentity: key,
        bodySource: body?.source ?? "none",
        archivedMediaCount: uploaded.size,
      },
      completeness:
        missing.length === 0 ? ("complete" as const) : ("partial" as const),
      missing,
    },
  };

  await context.archive.submit({ items: [state] });
  return {
    pendingMedia: failures.length > 0,
    problems: failures,
  };
}

function feedItemsWithIdentity(
  feed: FeedDefinition,
  items: readonly ParsedFeedItem[],
): {
  readonly entries: readonly {
    readonly item: ParsedFeedItem;
    readonly key: string | undefined;
    readonly kind: "id" | "url" | undefined;
    readonly duplicate: boolean;
  }[];
  readonly problems: readonly string[];
} {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const identities = items.map((item) => {
    const identity = identityKey(feed, item);
    if (identity === undefined) return undefined;
    if (seen.has(identity.key)) duplicates.add(identity.key);
    seen.add(identity.key);
    return identity;
  });
  const problems: string[] = [];
  const entries = items.map((item, index) => {
    const identity = identities[index];
    if (identity === undefined) {
      problems.push(
        "条目没有可验证的 RSS GUID/Atom ID，也没有可作为稳定身份的 HTTP 链接。",
      );
      return { item, key: undefined, kind: undefined, duplicate: false };
    }
    const duplicate = duplicates.has(identity.key);
    if (duplicate) {
      problems.push(`同一 feed 中出现重复信源身份「${identity.key}」。`);
    }
    return { item, key: identity.key, kind: identity.kind, duplicate };
  });
  return { entries, problems };
}

function feedReadFailure(
  feedId: string,
  error: unknown,
): { readonly message: string; readonly unavailable: boolean } {
  if (!(error instanceof FeedRequestError)) {
    return {
      message: `RSS/Atom feed「${feedId}」读取失败。`,
      unavailable: false,
    };
  }
  const status = error.statusCode;
  const unavailable =
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429;
  return {
    message: `RSS/Atom feed「${feedId}」检查失败：${error.message}`,
    unavailable,
  };
}

async function checkFeeds(
  context: CollectorCheckContext,
  params: ActionParams,
) {
  let config: CollectorConfig;
  try {
    config = parseConfig(context.config);
  } catch (error) {
    return {
      availability: "unknown" as const,
      scope: [],
      basis: "无法根据当前配置确定要检查的 feed。",
      problems: [
        feedProblem(
          "配置",
          "rss_configuration_invalid",
          error instanceof Error ? error.message : "RSS/Atom 采集配置无效。",
          "检查 feeds 中的稳定标识与 HTTP/HTTPS 地址。",
        ),
      ],
    };
  }

  const selected = selectedFeeds(config, params);
  const problems = selected.missing.map((feedId) =>
    feedProblem(
      feedId,
      "rss_feed_not_configured",
      `本次参数选择了未配置的 feed「${feedId}」。`,
      "只选择当前 bin 已配置的 feed 稳定标识。",
    ),
  );
  let unavailable = selected.missing.length > 0;
  let unknown = false;

  for (const feed of selected.feeds) {
    if (context.signal.aborted) throw context.signal.reason;
    try {
      const response = await requestFeed(feed.url, {}, context.signal);
      if (response.status === "not-modified") {
        unknown = true;
        problems.push(
          feedProblem(
            feed.id,
            "rss_feed_body_unavailable",
            "feed 没有返回本次检查所需的正文。",
            "检查信源是否允许无条件读取 RSS/Atom 正文。",
          ),
        );
        continue;
      }
      const entries = feedItemsWithIdentity(feed, response.feed.items);
      if (entries.problems.length > 0) {
        unavailable = true;
        for (const message of entries.problems) {
          problems.push(
            feedProblem(
              feed.id,
              "rss_entry_identity_unavailable",
              message,
              "为每个条目提供稳定的 RSS GUID、Atom ID 或唯一 HTTP 链接。",
            ),
          );
        }
      }
      const noBody = response.feed.items.filter(
        (item) =>
          (item.content?.trim().length ?? 0) === 0 &&
          (item.description?.trim().length ?? 0) === 0,
      ).length;
      if (noBody > 0) {
        unavailable = true;
        problems.push(
          feedProblem(
            feed.id,
            "rss_entry_body_unavailable",
            `${noBody} 个条目没有正文或摘要字段。`,
            "检查 feed 是否提供条目正文或摘要。",
          ),
        );
      }
      const summaryOnly = response.feed.items.filter(
        (item) =>
          (item.content?.trim().length ?? 0) === 0 &&
          (item.description?.trim().length ?? 0) !== 0,
      ).length;
      if (summaryOnly > 0) {
        problems.push(
          feedProblem(
            feed.id,
            "rss_feed_summary_only",
            `${summaryOnly} 个条目只提供摘要；采集结果会将其标记为 partial。`,
            "确认 feed 是否能直接提供完整正文；静态页面补采由后续采集能力处理。",
          ),
        );
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      const failure = feedReadFailure(feed.id, error);
      unavailable ||= failure.unavailable;
      unknown ||= !failure.unavailable;
      problems.push(
        feedProblem(
          feed.id,
          "rss_feed_unavailable",
          failure.message,
          "检查 feed 地址、信源访问状态与网络连接。",
        ),
      );
    }
  }

  return {
    availability: unavailable
      ? ("unavailable" as const)
      : unknown
        ? ("unknown" as const)
        : ("available" as const),
    scope: selected.feeds.map(({ id }) => id),
    basis:
      "读取并解析所选 RSS/Atom feed，检查条目身份与正文范围；本次检查不执行采集、资源上传、归档或增量状态写入。",
    problems,
  };
}

function failureFromProblems(
  problems: readonly {
    readonly feedId: string;
    readonly message: string;
    readonly path?: readonly (string | number)[];
  }[],
  completedScopes: readonly string[],
) {
  const examples = problems
    .slice(0, 8)
    .map(({ feedId, message }) => `${feedId}：${message}`);
  const more =
    problems.length > examples.length
      ? `；另有 ${problems.length - examples.length} 个问题`
      : "";
  const completed =
    completedScopes.length === 0
      ? ""
      : `已保留成功 feed：${completedScopes.map((scope) => scope.slice("feed:".length)).join("、")}。`;
  const first = problems[0];
  return collectorActionError({
    code: "rss_collection_incomplete",
    message: `RSS/Atom 采集未完整完成：${examples.join("；")}${more}`,
    impact: `${completed}已成功提交的资料不会回滚；受影响 feed 的增量状态不会前移。`,
    ...(first?.path === undefined ? {} : { path: [...first.path] }),
    suggestion:
      "检查问题 feed 与媒体来源后重新触发 collect；已归档的相同条目会按稳定信源键处理。",
    requiresHuman: false,
  });
}

async function collectFeeds(
  context: CollectorContext,
  params: ActionParams,
): Promise<{ readonly completedScopes: readonly string[] }> {
  const config = parseConfig(context.config);
  const selected = selectedFeeds(config, params);
  const problems: {
    feedId: string;
    message: string;
    path?: readonly (string | number)[];
  }[] = selected.missing.map((feedId) => ({
    feedId,
    message: `本次参数选择了未配置的 feed「${feedId}」。`,
    path: ["feedIds", feedId],
  }));
  const completedScopes: string[] = [];

  for (const feed of selected.feeds) {
    if (context.signal.aborted) throw context.signal.reason;
    let state: FeedState;
    try {
      state = await readFeedState(collectorStateDirectory(), feed.id, feed.url);
    } catch (error) {
      problems.push({
        feedId: feed.id,
        message:
          error instanceof Error ? error.message : "无法读取 feed 持久状态。",
        path: ["feeds", feed.id, "state"],
      });
      continue;
    }

    const sameFeedUrl = state.feedUrl === feed.url;
    const validators =
      sameFeedUrl && !hasPendingMedia(state)
        ? { etag: state.etag, lastModified: state.lastModified }
        : {};
    let response: FeedRequestResult;
    try {
      response = await requestFeed(feed.url, validators, context.signal);
    } catch (error) {
      const failure = feedReadFailure(feed.id, error);
      problems.push({
        feedId: feed.id,
        message: failure.message,
        path: ["feeds", feed.id],
      });
      continue;
    }

    if (response.status === "not-modified") {
      if (
        hasPendingMedia(state) ||
        (validators.etag === undefined && validators.lastModified === undefined)
      ) {
        problems.push({
          feedId: feed.id,
          message: "feed 在未发送有效条件头时返回 304，无法确认条目内容。",
          path: ["feeds", feed.id],
        });
      } else {
        completedScopes.push(`feed:${feed.id}`);
      }
      continue;
    }

    let workingState = sameFeedUrl
      ? state
      : {
          ...state,
          feedUrl: feed.url,
          etag: undefined,
          lastModified: undefined,
        };
    const entries = feedItemsWithIdentity(feed, response.feed.items);
    let feedFailed = false;
    for (const message of entries.problems) {
      feedFailed = true;
      problems.push({
        feedId: feed.id,
        message,
        path: ["feeds", feed.id, "items"],
      });
    }
    const currentKeys = new Set(
      entries.entries.flatMap(({ key }) => (key === undefined ? [] : [key])),
    );
    workingState = {
      ...workingState,
      entries: workingState.entries.filter(
        (entry) => !entry.pendingMedia || currentKeys.has(entry.identity),
      ),
    };
    const previousEntries = new Map(
      workingState.entries.map((entry) => [entry.identity, entry]),
    );
    const duplicateSeen = new Set<string>();

    for (const entry of entries.entries) {
      if (entry.key === undefined) continue;
      if (entry.duplicate || duplicateSeen.has(entry.key)) continue;
      duplicateSeen.add(entry.key);
      const body = prepareBody(entry.item, sourceRef(feed, entry.item));
      const fingerprint = contentFingerprint(
        feed,
        response,
        entry.item,
        body,
        entry.key,
      );
      const previous = previousEntries.get(entry.key);
      if (
        previous?.fingerprint === fingerprint &&
        !previous.pendingMedia &&
        (body?.invalidMedia.length ?? 0) === 0
      ) {
        continue;
      }

      try {
        const archived = await submitEntry(
          context,
          feed,
          response,
          entry.item,
          entry.key,
        );
        const entryState: FeedEntryState = {
          identity: entry.key,
          fingerprint,
          pendingMedia: archived.pendingMedia,
        };
        workingState = upsertFeedEntry(workingState, entryState);
        previousEntries.set(entry.key, entryState);
        await writeFeedState(collectorStateDirectory(), feed.id, workingState);
        if (archived.problems.length > 0) {
          feedFailed = true;
          for (const message of archived.problems) {
            problems.push({
              feedId: feed.id,
              message: `条目「${entry.key}」${message}`,
              path: ["feeds", feed.id, "items", entry.key],
            });
          }
        }
      } catch (error) {
        if (context.signal.aborted) throw error;
        feedFailed = true;
        problems.push({
          feedId: feed.id,
          message:
            error instanceof Error
              ? `条目「${entry.key}」提交失败：${error.message}`
              : `条目「${entry.key}」提交失败。`,
          path: ["feeds", feed.id, "items", entry.key],
        });
      }
    }

    workingState = {
      ...workingState,
      feedUrl: feed.url,
      ...(feedFailed || hasPendingMedia(workingState)
        ? {}
        : {
            etag: response.validators.etag,
            lastModified: response.validators.lastModified,
          }),
    };
    await writeFeedState(
      collectorStateDirectory(),
      feed.id,
      workingState,
    ).catch((error: unknown) => {
      feedFailed = true;
      problems.push({
        feedId: feed.id,
        message:
          error instanceof Error ? error.message : "无法保存 feed 状态。",
        path: ["feeds", feed.id, "state"],
      });
    });

    if (feedFailed || hasPendingMedia(workingState)) {
      continue;
    }
    completedScopes.push(`feed:${feed.id}`);
  }

  if (problems.length > 0) throw failureFromProblems(problems, completedScopes);
  return { completedScopes };
}

export const collector = defineCollector({
  id: "rss-atom",
  version: "1.0.0",
  description: "读取多个 RSS/Atom feed，保存直接提供的正文、结构和可取得媒体。",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema: collectorConfigSchema,
  actions: {
    check: defineCollectorCheckAction({
      description: "检查所选 RSS/Atom feed 的可达性、条目身份和正文范围。",
      params: actionParamsSchema,
      execute: checkFeeds,
    }),
    collect: defineCollectorAction({
      description: "读取所选 feed 的新内容和编辑，并归档正文与可取得媒体。",
      params: actionParamsSchema,
      execute: collectFeeds,
    }),
  },
});
