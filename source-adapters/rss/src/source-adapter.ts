import { createHash } from "node:crypto";

import {
  archiveResourceManifest,
  defineSourceAdapter,
  defineSourceAdapterAction,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  type ArchiveResourceMetadata,
  type IncrementalEntryRecord,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import * as z from "zod";

import {
  FeedRequestError,
  fetchMedia,
  normalizeMediaUrl,
  prepareFeedItem,
  requestFeed,
  stableEntryIdentity,
  type FeedDefinition,
  type FeedRequestResult,
  type ParsedFeedItem,
  type PreparedFeedItem,
} from "./feed.ts";

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
  .describe("RSS/Atom feed 地址。信源适配器读取正文，不归档整份 feed 响应。");

const feedDefinitionSchema = z
  .object({
    id: feedIdSchema.describe(
      "信源稳定标识。同一 feed 在不同 bin 与地址编辑后必须沿用相同标识；不同信源使用不同标识。",
    ),
    url: feedUrlSchema,
    title: z.string().min(1).max(512).optional(),
    bodyField: z
      .enum(["auto", "content", "summary"])
      .default("auto")
      .optional(),
  })
  .strict();

const sourceAdapterConfigSchema = z
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

type SourceAdapterConfig = z.output<typeof sourceAdapterConfigSchema>;
type ActionParams = z.output<typeof actionParamsSchema>;
const checkOutputSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string()),
    basis: z.string().min(1),
    problems: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          impact: z.string().min(1),
          path: z.array(z.union([z.string(), z.number()])).optional(),
          suggestion: z.string().min(1),
          requiresHuman: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
const collectOutputSchema = z
  .object({ completedScopes: z.array(z.string()).readonly() })
  .strict();
const syncOutputSchema = z
  .object({
    completedScopes: z.array(z.string()).readonly(),
    initializedScopes: z.array(z.string()).readonly().optional(),
  })
  .strict();

function selectedFeeds(
  config: SourceAdapterConfig,
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
  key: string,
  prepared: PreparedFeedItem,
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
    body: {
      source: prepared.bodySource,
      type: prepared.bodyType,
      markdown: prepared.cleanResult.markdown,
      text: prepared.cleanResult.text,
      media: prepared.cleanResult.media,
      invalidMedia: prepared.cleanResult.invalidMedia,
    },
  });
  return createHash("sha256").update(snapshot).digest("hex");
}

function entryMetadata(
  feed: FeedDefinition,
  parsedFeed: FeedRequestResult & { readonly status: "ok" },
  item: ParsedFeedItem,
  prepared: PreparedFeedItem,
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
      bodyType: prepared.bodyType,
      bodySource: prepared.bodySource,
      authors: item.authors,
      categories: item.categories,
      image: item.image,
    },
    media: prepared.cleanResult.media.map(({ url, mediaType, title }) => ({
      url,
      mediaType: mediaType ?? null,
      title: title ?? null,
    })),
  };
}

async function submitEntry(
  context: SourceAdapterContext,
  feed: FeedDefinition,
  parsedFeed: FeedRequestResult & { readonly status: "ok" },
  item: ParsedFeedItem,
  key: string,
  prepared: PreparedFeedItem,
): Promise<{
  readonly hasMediaFailures: boolean;
  readonly problems: readonly string[];
}> {
  const uploaded = new Map<string, ArchiveResourceMetadata>();
  const missing: { path: string; reason: string }[] = [];
  const failures: string[] = [];

  if (!prepared.isComplete && prepared.missingReason !== undefined) {
    missing.push({ path: "body.fullText", reason: prepared.missingReason });
  }

  for (const [index, rawUrl] of prepared.cleanResult.invalidMedia.entries()) {
    const reason = `媒体地址不是可访问的 HTTP/HTTPS URL：${rawUrl}`;
    missing.push({ path: `media.invalid.${index}`, reason });
    failures.push(reason);
  }

  let hasMediaFailures = false;
  for (const [index, candidate] of prepared.cleanResult.media.entries()) {
    if (context.signal.aborted) throw context.signal.reason;
    try {
      const response = await fetchMedia(candidate, context.signal);
      const result = await context.resources.upload(
        response.body,
        response.mediaType,
      );
      if (!result.ok) {
        const reason = `媒体「${candidate.url}」未能写入归档：${result.error.message}`;
        missing.push({ path: `media.${index}`, reason });
        failures.push(reason);
        hasMediaFailures = true;
        continue;
      }
      uploaded.set(candidate.url, result.resource);
    } catch (error) {
      if (context.signal.aborted) throw error;
      const reason =
        error instanceof FeedRequestError
          ? `媒体「${candidate.url}」本次未能取得或归档：${error.message}`
          : `媒体「${candidate.url}」本次未能取得或归档。`;
      missing.push({ path: `media.${index}`, reason });
      failures.push(reason);
      hasMediaFailures = true;
    }
  }

  const bodyWithResources = prepared.cleanResult.renderArchiveBody(uploaded);
  const resources = [...archiveResourceManifest([...uploaded.values()])];
  const sourceModifiedAt = item.updated ?? item.published ?? undefined;
  const renderedMarkdown = bodyWithResources.markdown;
  const cleanedText = prepared.cleanResult.text;
  const searchText = [item.title?.trim(), cleanedText.trim()]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n");
  const hasBodyRepresentation =
    renderedMarkdown.length > 0 ||
    cleanedText.length > 0 ||
    searchText.length > 0;

  const state = {
    sourceKey: { namespace: `rss:${feed.id}`, key },
    sourceRef: sourceRef(feed, item),
    ...(sourceModifiedAt === undefined ? {} : { sourceModifiedAt }),
    metadata: entryMetadata(feed, parsedFeed, item, prepared),
    ...(hasBodyRepresentation
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
    ...(resources.length === 0 ? {} : { resources }),
    capture: {
      scope: {
        feedId: feed.id,
        feedUrl: feed.url,
        entryIdentity: key,
        bodySource: prepared.bodySource,
        archivedMediaCount: uploaded.size,
      },
      completeness:
        missing.length === 0 ? ("complete" as const) : ("partial" as const),
      missing,
    },
  };

  await context.archive.submit({ items: [state] });
  return {
    hasMediaFailures,
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
  context: SourceAdapterContext<SourceAdapterConfig>,
  params: ActionParams,
) {
  const selected = selectedFeeds(context.config, params);
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

      let emptyBodyCount = 0;
      let summaryOnlyCount = 0;

      for (const entry of entries.entries) {
        if (entry.duplicate) continue;
        const baseUrl = sourceRef(feed, entry.item);
        const prepared = prepareFeedItem(feed, entry.item, baseUrl);
        if (
          prepared.bodySource === "none" ||
          (prepared.cleanResult.text.trim().length === 0 &&
            prepared.cleanResult.media.length === 0)
        ) {
          emptyBodyCount += 1;
        } else if (!prepared.isComplete && prepared.bodySource === "summary") {
          summaryOnlyCount += 1;
        }
      }

      if (emptyBodyCount > 0) {
        unavailable = true;
        problems.push(
          feedProblem(
            feed.id,
            "rss_entry_body_unavailable",
            `${emptyBodyCount} 个条目没有正文或有效内容。`,
            "检查 feed 是否提供条目正文或有效摘要。",
          ),
        );
      }

      if (summaryOnlyCount > 0) {
        unavailable = true;
        problems.push(
          feedProblem(
            feed.id,
            "rss_feed_summary_only",
            `${summaryOnlyCount} 个条目只提供纯文本短摘要。`,
            "确认 feed 是否能直接提供完整正文，或配置 feed 的 bodyField 为 summary。",
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
      "读取并解析所选 RSS/Atom feed，检查条目身份与正文范围。本次检查不下载媒体、不上传资源、不归档或写入增量状态。",
    problems,
  };
}

function failureFromProblems(
  problems: readonly {
    readonly feedId: string;
    readonly message: string;
    readonly path?: readonly (string | number)[];
    readonly suggestion?: string;
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
  return sourceAdapterActionError(
    {
      code: "rss_collection_incomplete",
      message: `RSS/Atom 采集未完整完成：${examples.join("；")}${more}`,
      impact: `${completed}已成功提交的资料不会回滚；受影响 feed 的增量状态不会前移。`,
      ...(first?.path === undefined ? {} : { path: [...first.path] }),
      suggestion:
        first?.suggestion ??
        "检查问题 feed 与媒体来源后重新触发 collect；已归档的相同条目会按稳定信源键处理。",
      requiresHuman: false,
    },
    completedScopes,
  );
}

async function collectFeeds(
  context: SourceAdapterContext<SourceAdapterConfig>,
  params: ActionParams,
): Promise<{ readonly completedScopes: readonly string[] }> {
  const selected = selectedFeeds(context.config, params);
  const problems: {
    feedId: string;
    message: string;
    path?: readonly (string | number)[];
    suggestion?: string;
  }[] = selected.missing.map((feedId) => ({
    feedId,
    message: `本次参数选择了未配置的 feed「${feedId}」。`,
    path: ["feedIds", feedId],
  }));

  const state = await loadIncrementalSyncState(context);
  const completedScopes: string[] = [];

  for (const feed of selected.feeds) {
    if (context.signal.aborted) throw context.signal.reason;

    const scopeState = state.scopes[feed.id];
    const sameFeedUrl =
      scopeState !== undefined && scopeState.scopeUrl === feed.url;
    const entriesList =
      scopeState !== undefined ? Object.values(scopeState.entries) : [];
    const allComplete =
      sameFeedUrl &&
      entriesList.length > 0 &&
      entriesList.every((entry) => entry.archivedCompleteness === "complete");
    const validators = allComplete
      ? { etag: scopeState?.etag, lastModified: scopeState?.lastModified }
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
        validators.etag === undefined &&
        validators.lastModified === undefined
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

    const duplicateSeen = new Set<string>();

    for (const entry of entries.entries) {
      if (entry.key === undefined) continue;
      if (entry.duplicate || duplicateSeen.has(entry.key)) continue;
      duplicateSeen.add(entry.key);
      const baseUrl = sourceRef(feed, entry.item);
      const prepared = prepareFeedItem(feed, entry.item, baseUrl);
      const fingerprint = contentFingerprint(
        feed,
        response,
        entry.item,
        entry.key,
        prepared,
      );
      const previous = scopeState?.entries[entry.key];
      if (
        previous?.fingerprint === fingerprint &&
        previous.archivedCompleteness === "complete" &&
        prepared.cleanResult.invalidMedia.length === 0
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
          prepared,
        );
        const entryRecord: IncrementalEntryRecord = {
          fingerprint,
          ...(entry.item.updated ? { updatedAt: entry.item.updated } : {}),
          ...(entry.item.published
            ? { publishedAt: entry.item.published }
            : {}),
          archivedCompleteness: archived.hasMediaFailures
            ? "partial"
            : "complete",
        };
        upsertIncrementalScopeEntry(state, feed.id, entry.key, entryRecord);
        await saveIncrementalSyncState(context, state);

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

    if (!feedFailed) {
      if (scopeState === undefined || !sameFeedUrl) {
        initializeIncrementalScope(state, feed.id, {
          scopeUrl: feed.url,
          initializedAt: context.referenceTime,
          etag: response.validators.etag,
          lastModified: response.validators.lastModified,
          entries: state.scopes[feed.id]?.entries,
        });
      } else {
        updateIncrementalScopeValidators(state, feed.id, {
          etag: response.validators.etag,
          lastModified: response.validators.lastModified,
        });
      }
      await saveIncrementalSyncState(context, state);
      completedScopes.push(`feed:${feed.id}`);
    }
  }

  if (problems.length > 0) throw failureFromProblems(problems, completedScopes);
  return { completedScopes };
}

async function syncFeeds(
  context: SourceAdapterContext<SourceAdapterConfig>,
  params: ActionParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  const selected = selectedFeeds(context.config, params);
  const problems: {
    feedId: string;
    message: string;
    path?: readonly (string | number)[];
    suggestion?: string;
  }[] = selected.missing.map((feedId) => ({
    feedId,
    message: `本次参数选择了未配置的 feed「${feedId}」。`,
    path: ["feedIds", feedId],
  }));

  const state = await loadIncrementalSyncState(context);
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];

  for (const feed of selected.feeds) {
    if (context.signal.aborted) throw context.signal.reason;

    const isInitialized = isIncrementalScopeInitialized(
      state,
      feed.id,
      feed.url,
    );
    const scopeState = state.scopes[feed.id];

    if (!isInitialized || scopeState === undefined) {
      // Initial sync: establish baseline only without archiving items
      let response: FeedRequestResult;
      try {
        response = await requestFeed(feed.url, {}, context.signal);
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
        problems.push({
          feedId: feed.id,
          message:
            "首次建立基线时未发送条件头，但 feed 返回 304，无法确认条目内容。",
          path: ["feeds", feed.id],
        });
        continue;
      }

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

      let emptyBodyCount = 0;
      let summaryOnlyCount = 0;
      const baselineEntries: Record<string, IncrementalEntryRecord> = {};
      const duplicateSeen = new Set<string>();

      for (const entry of entries.entries) {
        if (
          entry.key === undefined ||
          entry.duplicate ||
          duplicateSeen.has(entry.key)
        ) {
          continue;
        }
        duplicateSeen.add(entry.key);
        const baseUrl = sourceRef(feed, entry.item);
        const prepared = prepareFeedItem(feed, entry.item, baseUrl);
        if (
          prepared.bodySource === "none" ||
          (prepared.cleanResult.text.trim().length === 0 &&
            prepared.cleanResult.media.length === 0)
        ) {
          emptyBodyCount += 1;
        } else if (!prepared.isComplete && prepared.bodySource === "summary") {
          summaryOnlyCount += 1;
        }

        const fingerprint = contentFingerprint(
          feed,
          response,
          entry.item,
          entry.key,
          prepared,
        );
        baselineEntries[entry.key] = {
          fingerprint,
          ...(entry.item.updated ? { updatedAt: entry.item.updated } : {}),
          ...(entry.item.published
            ? { publishedAt: entry.item.published }
            : {}),
          archivedCompleteness: "baseline",
        };
      }

      if (emptyBodyCount > 0) {
        feedFailed = true;
        problems.push({
          feedId: feed.id,
          message: `${emptyBodyCount} 个条目没有正文或有效内容。`,
          path: ["feeds", feed.id],
          suggestion: "检查 feed 是否提供条目正文或有效摘要。",
        });
      }

      if (summaryOnlyCount > 0) {
        feedFailed = true;
        problems.push({
          feedId: feed.id,
          message: `${summaryOnlyCount} 个条目只提供纯文本短摘要。`,
          path: ["feeds", feed.id],
          suggestion:
            "确认 feed 是否能直接提供完整正文，或配置 feed 的 bodyField 为 summary。",
        });
      }

      if (feedFailed) {
        continue;
      }

      initializeIncrementalScope(state, feed.id, {
        scopeUrl: feed.url,
        initializedAt: context.referenceTime,
        etag: response.validators.etag,
        lastModified: response.validators.lastModified,
        entries: baselineEntries,
      });
      await saveIncrementalSyncState(context, state);
      completedScopes.push(`feed:${feed.id}`);
      initializedScopes.push(`feed:${feed.id}`);
      continue;
    }

    // Initialized scope: conditional request and incremental archiving
    const validators = {
      etag: scopeState.etag,
      lastModified: scopeState.lastModified,
    };
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
        validators.etag === undefined &&
        validators.lastModified === undefined
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

    const duplicateSeen = new Set<string>();
    for (const entry of entries.entries) {
      if (
        entry.key === undefined ||
        entry.duplicate ||
        duplicateSeen.has(entry.key)
      ) {
        continue;
      }
      duplicateSeen.add(entry.key);
      const baseUrl = sourceRef(feed, entry.item);
      const prepared = prepareFeedItem(feed, entry.item, baseUrl);
      const fingerprint = contentFingerprint(
        feed,
        response,
        entry.item,
        entry.key,
        prepared,
      );

      const previous = scopeState.entries[entry.key];
      if (previous?.fingerprint === fingerprint) {
        // Skip unchanged items
        continue;
      }

      try {
        const archived = await submitEntry(
          context,
          feed,
          response,
          entry.item,
          entry.key,
          prepared,
        );
        const record: IncrementalEntryRecord = {
          fingerprint,
          ...(entry.item.updated ? { updatedAt: entry.item.updated } : {}),
          ...(entry.item.published
            ? { publishedAt: entry.item.published }
            : {}),
          archivedCompleteness: archived.hasMediaFailures
            ? "partial"
            : "complete",
        };
        upsertIncrementalScopeEntry(state, feed.id, entry.key, record);
        await saveIncrementalSyncState(context, state);

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

    if (!feedFailed) {
      updateIncrementalScopeValidators(state, feed.id, {
        etag: response.validators.etag,
        lastModified: response.validators.lastModified,
      });
      await saveIncrementalSyncState(context, state);
      completedScopes.push(`feed:${feed.id}`);
    }
  }

  if (problems.length > 0) throw failureFromProblems(problems, completedScopes);
  return { completedScopes, initializedScopes };
}

export const sourceAdapter = defineSourceAdapter({
  id: "rss-atom",
  version: "1.0.1",
  description: "读取多个 RSS/Atom feed，保存直接提供的正文、结构和可取得媒体。",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema: sourceAdapterConfigSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(sourceAdapterConfigSchema, {
      description: "检查所选 RSS/Atom feed 的可达性、条目身份和正文范围。",
      params: actionParamsSchema,
      output: checkOutputSchema,
      execute: checkFeeds,
    }),
    collect: defineSourceAdapterAction(sourceAdapterConfigSchema, {
      description: "读取所选 feed 的新内容和编辑，并归档正文与可取得媒体。",
      params: actionParamsSchema,
      output: collectOutputSchema,
      execute: collectFeeds,
    }),
    sync: defineSourceAdapterAction(sourceAdapterConfigSchema, {
      description: "增量同步所选 feed 的新内容和变更；首次运行仅建立基线。",
      params: actionParamsSchema,
      output: syncOutputSchema,
      execute: syncFeeds,
    }),
  },
});
