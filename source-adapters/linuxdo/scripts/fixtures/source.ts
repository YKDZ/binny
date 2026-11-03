import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

type SourceState = {
  readonly nativeChallenge: boolean;
  readonly nativeChallengeWait: boolean;
  readonly nativeChallengeNoReload: boolean;
  readonly nativeChallengePersistent: boolean;
  readonly nativeChallengeMedia: boolean;
  readonly nativeChallengePaths: readonly string[];
  readonly nativeChallengeNavigationDelayMs: number;
  readonly nativeChallengeStatus: number;
  readonly navigationRace: boolean;
  readonly challengePage: boolean;
  readonly challengeTopic: boolean;
  readonly challengePosts: boolean;
  readonly challengeMedia: boolean;
  readonly topicVisible: boolean;
  readonly legacyTags: boolean;
  readonly targetUnavailablePage: number | null;
  readonly targetChallengePage: number | null;
  readonly targetInvalidResponsePage: number | null;
  readonly targetPaginationLoopPage: number | null;
  readonly targetInvalidPaginationUrlPage: number | null;
  readonly targetEarlyEndPage: number | null;
  readonly categoriesUnavailable: boolean;
  readonly categoriesInvalidResponse: boolean;
  readonly dailyCollectionEnabled: boolean;
  readonly dailyParentIncludesChild: boolean;
  readonly dailyTopicOverlapCount: number;
  readonly postRangeEnabled: boolean;
  readonly postRangeAddAfterFirstPage: boolean;
  readonly postRangeRepeatPage: boolean;
  readonly postRangeInvalidPage: number | null;
  readonly postRangeResponseStatus: number | null;
  readonly postRangeRetryAfter: string | null;
  readonly postRangePageSize: number;
  readonly paginationOrderMutationEnabled: boolean;
  readonly invalidCreatedAtTopicIds: readonly number[];
  readonly topicVersion: number;
  readonly replyVersion: number;
  readonly addedReply: boolean;
  readonly discoveryAddedReply: boolean;
  readonly syncScenarioStage: number;
  readonly omittedPostIds: readonly number[];
  readonly unavailableTopicIds: readonly number[];
  readonly unavailableMedia: readonly string[];
  readonly unavailableMediaStatus: number;
  readonly topicCreatedAtOverrides?: Readonly<Record<number, string>>;
  readonly siteHomeDelayMs?: number;
  readonly topicListDelayMs?: number;
  readonly mediaResponseDelayMs?: number;
  readonly rateLimitPath: string | null;
  readonly rateLimitStatus: 429 | 503;
  readonly retryAfterHeader: string;
  readonly rateLimitRemaining: number;
};

type SourceEvent = {
  readonly at: number;
  readonly action: string;
  readonly path: string;
  readonly authenticated?: boolean;
  readonly topicIds?: readonly number[];
  readonly moreTopicsUrl?: string | null;
  readonly activeMediaRequests?: number;
};

const rootPostId = 240_001;
const firstReplyId = 240_002;
const secondReplyId = 240_003;
const thirdReplyId = 240_004;
const photoPath = "/uploads/default/original/2X/topic-photo.png";
const lightboxDownloadPath = "/topic-photo-download-hash";
const smallPhotoCandidate =
  "/uploads/default/original/2X/topic-photo-small.webp";
const largePhotoCandidate =
  "/uploads/default/original/2X/topic-photo-large.webp";
const replyPhotoPath = "/uploads/default/original/2X/reply-photo.png";
const attachmentPath = "/uploads/default/original/2X/topic-notes.pdf";
const jsonAttachmentPath = "/uploads/default/original/2X/topic-metadata.json";
const challengeMediaPath = "/uploads/default/original/2X/login-challenge.html";
const photoBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9S8AAAAASUVORK5CYII=",
  "base64",
);
const attachmentBytes = Buffer.from("%PDF-1.4\n% Linux.do fixture\n%%EOF\n");
const jsonAttachmentBytes = Buffer.from(
  JSON.stringify({ topic: "linuxdo-fixture" }),
);

let activeState: SourceState = {
  nativeChallenge: false,
  nativeChallengeWait: false,
  nativeChallengeNoReload: false,
  nativeChallengePersistent: false,
  nativeChallengeMedia: false,
  nativeChallengePaths: [],
  nativeChallengeNavigationDelayMs: 0,
  nativeChallengeStatus: 403,
  navigationRace: false,
  challengePage: false,
  challengeTopic: false,
  challengePosts: false,
  challengeMedia: false,
  topicVisible: true,
  legacyTags: false,
  targetUnavailablePage: null,
  targetChallengePage: null,
  targetInvalidResponsePage: null,
  targetPaginationLoopPage: null,
  targetInvalidPaginationUrlPage: null,
  targetEarlyEndPage: null,
  categoriesUnavailable: false,
  categoriesInvalidResponse: false,
  dailyCollectionEnabled: false,
  dailyParentIncludesChild: false,
  dailyTopicOverlapCount: 1,
  postRangeEnabled: false,
  postRangeAddAfterFirstPage: false,
  postRangeRepeatPage: false,
  postRangeInvalidPage: null,
  postRangeResponseStatus: null,
  postRangeRetryAfter: null,
  postRangePageSize: 2,
  paginationOrderMutationEnabled: false,
  invalidCreatedAtTopicIds: [],
  topicVersion: 1,
  replyVersion: 1,
  addedReply: false,
  discoveryAddedReply: false,
  syncScenarioStage: 0,
  omittedPostIds: [],
  unavailableTopicIds: [],
  unavailableMedia: [],
  unavailableMediaStatus: 503,
  topicCreatedAtOverrides: {},
  siteHomeDelayMs: 0,
  topicListDelayMs: 0,
  mediaResponseDelayMs: 0,
  rateLimitPath: null,
  rateLimitStatus: 429,
  retryAfterHeader: "1",
  rateLimitRemaining: 0,
};
const events: SourceEvent[] = [];
let navigationRequested = false;
let activeMediaRequests = 0;
let postRangeReadCount = 0;

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, max-age=60",
  });
  response.end(JSON.stringify(value));
}

async function readBody(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

function isAuthenticated(
  request: import("node:http").IncomingMessage,
): boolean {
  return (request.headers.cookie ?? "")
    .split(";")
    .some((value) => value.trim() === "binny-discovery_session=fixture");
}

function record(
  action: string,
  path: string,
  authenticated?: boolean,
  pagination?: {
    readonly topicIds: readonly number[];
    readonly moreTopicsUrl: string | null;
  },
  media?: { readonly activeMediaRequests: number },
): void {
  events.push({
    at: Date.now(),
    action,
    path,
    ...(authenticated === undefined ? {} : { authenticated }),
    ...(pagination === undefined ? {} : pagination),
    ...(media === undefined ? {} : media),
  });
  if (events.length > 10_000) events.shift();
}

async function responseHasFinished(
  response: import("node:http").ServerResponse,
): Promise<void> {
  if (response.writableFinished || response.destroyed) return;
  await new Promise<void>((resolve) => {
    response.once("finish", resolve);
    response.once("close", resolve);
  });
}

async function serveMedia(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  pathname: string,
  authenticated: boolean,
): Promise<void> {
  activeMediaRequests++;
  record("media", pathname, authenticated, undefined, {
    activeMediaRequests,
  });
  try {
    await delay(activeState.mediaResponseDelayMs ?? 0);
    if (!authenticated && request.headers.host !== "linuxdo-e2e-media:8081") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (pathname === challengeMediaPath && activeState.challengeMedia) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end("<!doctype html><html><title>登录挑战</title></html>");
      return;
    }
    if (activeState.unavailableMedia.includes(pathname)) {
      response.writeHead(activeState.unavailableMediaStatus, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("受控媒体暂时不可用。");
      return;
    }
    const bytes =
      pathname === attachmentPath
        ? attachmentBytes
        : pathname === jsonAttachmentPath
          ? jsonAttachmentBytes
          : photoBytes;
    response.writeHead(200, {
      "content-type":
        pathname === attachmentPath
          ? "application/pdf"
          : pathname === jsonAttachmentPath
            ? "application/json; charset=utf-8"
            : "image/png",
    });
    response.end(bytes);
  } finally {
    await responseHasFinished(response);
    activeMediaRequests--;
  }
}

function post(
  id: number,
  postNumber: number,
  cooked: string,
  updatedAt: string,
  replyToPostNumber?: number,
): Record<string, unknown> {
  return {
    id,
    topic_id: 2401,
    post_number: postNumber,
    username:
      postNumber === 1 ? "fixture-author" : `fixture-reply-${postNumber}`,
    name: postNumber === 1 ? "Linux.do 示例作者" : `示例回复 ${postNumber}`,
    created_at: `2026-10-28T0${postNumber}:00:00.000Z`,
    updated_at: updatedAt,
    cooked,
    ...(replyToPostNumber === undefined
      ? {}
      : { reply_to_post_number: String(replyToPostNumber) }),
  };
}

function posts(): readonly Record<string, unknown>[] {
  const rootTitle = `受控主题标题版本 ${String(activeState.topicVersion)}`;
  const replyText = `回复正文版本 ${String(activeState.replyVersion)}`;
  return [
    post(
      rootPostId,
      1,
      `<p>主题正文版本 ${String(activeState.topicVersion)}</p><div class="lightbox-wrapper"><a class="lightbox" href="${photoPath}" data-download-href="${lightboxDownloadPath}"><picture><source type="image/webp" srcset="${smallPhotoCandidate} 1x, ${largePhotoCandidate} 2x"><img src="${photoPath}" srcset="${smallPhotoCandidate} 1x, ${largePhotoCandidate} 2x" alt="主题封面"></picture></a></div><p><a class="attachment" href="http://linuxdo-e2e-media:8081${attachmentPath}">主题资料.pdf</a></p><p><a class="attachment" href="${jsonAttachmentPath}">主题元数据.json</a></p>${activeState.challengeMedia ? `<p><a class="attachment" href="${challengeMediaPath}">登录挑战.html</a></p>` : ""}`,
      `2026-10-28T00:00:0${String(activeState.topicVersion)}.000Z`,
    ),
    post(
      firstReplyId,
      2,
      `<p>${replyText}</p><img src="${replyPhotoPath}" alt="回复插图">`,
      `2026-10-28T01:00:0${String(activeState.replyVersion)}.000Z`,
      1,
    ),
    post(
      secondReplyId,
      3,
      "<p>保持不变的另一条回复。</p>",
      "2026-10-28T02:00:00.000Z",
      1,
    ),
    ...(activeState.addedReply
      ? [
          post(
            thirdReplyId,
            4,
            "<p>后来新增的回复。</p>",
            "2026-10-28T03:00:00.000Z",
            1,
          ),
        ]
      : []),
    ...(activeState.discoveryAddedReply
      ? [
          post(
            240_005,
            5,
            "<p>发现后新增的回复。</p>",
            "2026-10-28T05:00:00.000Z",
            1,
          ),
        ]
      : []),
    ...(activeState.syncScenarioStage >= 1
      ? [
          {
            ...post(
              240_010,
              6,
              "<p>sync 第一轮发现的旧主题新回复。</p>",
              "2026-10-28T02:45:00.000Z",
              1,
            ),
            created_at: "2026-10-28T02:45:00.000Z",
          },
        ]
      : []),
    ...(activeState.syncScenarioStage >= 2
      ? [
          {
            ...post(
              240_011,
              7,
              "<p>sync 第二轮发现的旧主题新回复。</p>",
              "2026-10-28T03:30:00.000Z",
              1,
            ),
            created_at: "2026-10-28T03:30:00.000Z",
          },
        ]
      : []),
  ].map((value, index) =>
    index === 0 ? { ...value, title: rootTitle } : value,
  );
}

function postRangeFixtures(
  includeInserted: boolean,
): Record<string, unknown>[] {
  const existing = posts();
  const firstReply = existing[1];
  const secondReply = existing[2];
  const root = existing[0];
  if (
    firstReply === undefined ||
    secondReply === undefined ||
    root === undefined
  )
    throw new Error("帖子区间夹具缺少受控主题正文。");
  const newTopic = discoveredTopic(2499) as {
    readonly post_stream: {
      readonly posts: readonly Record<string, unknown>[];
    };
  };
  const newTopicRoot = newTopic.post_stream.posts[0];
  if (newTopicRoot === undefined)
    throw new Error("帖子区间夹具缺少新主题主帖。");
  const insertion = {
    ...newTopicRoot,
    id: 249_901,
    post_number: 2,
    reply_to_post_number: 1,
    created_at: "2026-10-28T03:30:00.000Z",
    updated_at: "2026-10-28T03:30:00.000Z",
    cooked: "<p>扫描期间插入的区间回复。</p>",
  };
  const values: Record<string, unknown>[] = [
    {
      ...newTopicRoot,
      created_at: "2026-10-28T02:30:00.000Z",
      updated_at: "2026-10-28T02:30:00.000Z",
    },
    {
      ...secondReply,
      id: 240_009,
      post_number: 6,
      created_at: "2026-10-28T04:00:00.000Z",
      updated_at: "2026-10-28T04:00:00.000Z",
      cooked: "<p>终点边界之外的帖子。</p>",
    },
    {
      ...firstReply,
      id: 240_008,
      post_number: 5,
      created_at: "2026-10-28T01:30:00.000Z",
      updated_at: "2026-10-28T01:30:00.000Z",
      cooked: "<p>早于起点的旧时间戳帖子甲。</p>",
    },
    {
      ...firstReply,
      id: 240_007,
      post_number: 4,
      created_at: "2026-10-28T01:00:00.000Z",
      updated_at: "2026-10-28T01:00:00.000Z",
      cooked: "<p>早于起点的旧时间戳帖子乙。</p>",
    },
    {
      ...firstReply,
      id: 240_006,
      post_number: 4,
      created_at: "2026-10-28T03:30:00.000Z",
      updated_at: "2026-10-28T03:30:00.000Z",
      cooked: `<p>区间新增回复内容。</p><img src="${replyPhotoPath}" alt="区间回复插图">`,
    },
    {
      ...firstReply,
      id: 240_005,
      post_number: 3,
      created_at: "2026-10-28T01:00:00.000Z",
      updated_at: "2026-10-28T01:00:00.000Z",
      cooked: "<p>早于起点的旧时间戳帖子丙。</p>",
    },
    {
      ...secondReply,
      created_at: "2026-10-28T03:00:00.000Z",
      updated_at: "2026-10-28T03:00:00.000Z",
    },
    {
      ...firstReply,
      created_at: "2026-10-28T02:00:00.000Z",
      updated_at: "2026-10-28T02:00:00.000Z",
    },
    {
      ...root,
      created_at: "2026-10-28T01:00:00.000Z",
      updated_at: "2026-10-28T01:00:00.000Z",
    },
  ];
  const syncTopic: Record<string, unknown>[] = [];
  if (activeState.syncScenarioStage >= 1) {
    const syncTopicRoot = (
      discoveredTopic(2500) as {
        readonly post_stream: {
          readonly posts: readonly Record<string, unknown>[];
        };
      }
    ).post_stream.posts[0];
    if (syncTopicRoot === undefined)
      throw new Error("sync 夹具缺少新增主题主帖。");
    syncTopic.push({
      ...syncTopicRoot,
      created_at: "2026-10-28T02:30:00.000Z",
      updated_at: "2026-10-28T02:30:00.000Z",
    });
  }
  const syncReplies = existing.filter(
    ({ id }) => id === 240_010 || id === 240_011,
  );
  const oldSyncReply: Record<string, unknown>[] =
    activeState.syncScenarioStage >= 3
      ? [
          {
            ...post(
              240_012,
              8,
              "<p>超过一小时范围的旧回复。</p>",
              "2026-10-28T04:30:00.000Z",
              1,
            ),
            created_at: "2026-10-28T04:30:00.000Z",
          },
        ]
      : [];
  const dailyChildReply: Record<string, unknown>[] =
    activeState.dailyCollectionEnabled && activeState.syncScenarioStage >= 1
      ? [
          {
            ...post(
              70_040_001,
              2,
              "<p>全日子板块范围重叠回复。</p>",
              "2026-11-02T00:15:00.000Z",
              1,
            ),
            topic_id: 700_400,
            created_at: "2026-11-02T00:15:00.000Z",
          },
        ]
      : [];
  return [
    ...(includeInserted ? [insertion] : []),
    ...dailyChildReply,
    ...syncTopic,
    ...syncReplies,
    ...oldSyncReply,
    ...values,
  ].toSorted((first, second) => Number(second.id) - Number(first.id));
}

function legacyTopicCreatedAt(topicId: number): string {
  const minuteByTopicId = new Map([
    [2401, 10],
    [2403, 9],
    [2402, 8],
    [2404, 7],
    [2405, 6],
    [2406, 5],
    [2407, 4],
    [2408, 3],
    [2409, 2],
    [2410, 1],
    [2499, 0],
  ]);
  const minute = minuteByTopicId.get(topicId) ?? 0;
  return `2026-10-28T00:${String(minute).padStart(2, "0")}:00.000Z`;
}

function discoveredTopic(topicId: number): Record<string, unknown> {
  const paginationTopic = paginationOrderTopicDetails(topicId);
  if (paginationTopic !== undefined) {
    const postId = topicId * 100;
    const topicName = "排序变更前受控主题 " + String(topicId);
    return {
      id: topicId,
      title: topicName,
      slug: "pagination-order-topic-" + String(topicId),
      created_at: paginationTopic.createdAt,
      category_id: 42,
      post_stream: {
        posts: [
          {
            id: postId,
            topic_id: topicId,
            post_number: 1,
            username: "fixture-pagination-author",
            name: "分页排序示例作者",
            created_at: paginationTopic.createdAt,
            updated_at: paginationTopic.createdAt,
            cooked: "<p>" + topicName + " 的正文。</p>",
          },
        ],
        stream: [postId],
      },
    };
  }

  const dailyTopic = dailyTopicDetails(topicId);
  if (dailyTopic !== undefined) {
    const postId = topicId * 100;
    const topicName = `全日受控主题 ${String(topicId)}`;
    return {
      id: topicId,
      title: topicName,
      slug: `daily-controlled-topic-${String(topicId)}`,
      ...(activeState.invalidCreatedAtTopicIds.includes(topicId)
        ? { created_at: "not-a-date" }
        : { created_at: dailyTopic.createdAt }),
      category_id: dailyTopic.categoryId,
      post_stream: {
        posts: [
          {
            id: postId,
            topic_id: topicId,
            post_number: 1,
            username: "fixture-daily-author",
            name: "日采示例作者",
            created_at: dailyTopic.createdAt,
            updated_at: dailyTopic.createdAt,
            cooked: `<p>${topicName} 的正文。</p>`,
          },
        ],
        stream: [postId],
      },
    };
  }

  const defaultCreatedAt = "2026-10-28T00:00:00.000Z";
  const createdAt =
    activeState.topicCreatedAtOverrides?.[topicId] ??
    (topicId === 2401 ? defaultCreatedAt : legacyTopicCreatedAt(topicId));
  if (topicId === 2401) {
    const availablePosts = posts();
    return {
      id: topicId,
      title: `受控主题标题版本 ${String(activeState.topicVersion)}`,
      slug: "controlled-linuxdo-topic",
      created_at: createdAt,
      updated_at: `2026-10-28T00:00:0${String(activeState.topicVersion)}.000Z`,
      posts_count: availablePosts.length,
      reply_count: availablePosts.length - 1,
      category_id: 42,
      tags: activeState.legacyTags
        ? ["受控", "归档"]
        : [
            { id: 42, name: "受控", slug: "controlled" },
            { id: 43, name: "归档", slug: "archive" },
          ],
      post_stream: {
        posts: [availablePosts[0]],
        stream: availablePosts.map(({ id }) => id),
      },
    };
  }

  const postId = topicId * 100;
  const topicName = `发现主题 ${String(topicId)}`;
  return {
    id: topicId,
    title: topicName,
    slug: `controlled-topic-${String(topicId)}`,
    created_at: createdAt,
    category_id: 42,
    post_stream: {
      posts: [
        {
          id: postId,
          topic_id: topicId,
          post_number: 1,
          username: "fixture-discovery-author",
          name: "发现主题作者",
          created_at: createdAt,
          updated_at: createdAt,
          cooked: `<p>${topicName} 的正文。</p>`,
        },
      ],
      stream: [postId],
    },
  };
}

function discoveredTopicList(
  category: boolean,
  page: number,
  perPage: number,
  childCategory = false,
  categoryId?: number,
): Record<string, unknown> {
  if (activeState.paginationOrderMutationEnabled && !category) {
    const rows = [
      { id: 800_001, createdAt: "2026-11-01T09:00:00.000Z" },
      { id: 800_002, createdAt: "2026-10-31T23:00:00.000Z" },
      { id: 800_003, createdAt: "2026-11-01T08:00:00.000Z" },
    ];
    const row = rows[page];
    const moreTopicsUrl =
      page < rows.length - 1
        ? "/latest.json?page=" +
          String(page + 1) +
          "&order=activity&ascending=false"
        : undefined;
    return {
      topic_list: {
        topics:
          row === undefined ? [] : [{ id: row.id, created_at: row.createdAt }],
        more_topics_url: moreTopicsUrl,
      },
    };
  }

  if (activeState.dailyCollectionEnabled) {
    const pathname =
      categoryId === 45
        ? "/c/daily/45/l/latest.json"
        : categoryId === 46
          ? "/c/daily/daily-child/46/l/latest.json"
          : categoryId === 47
            ? "/c/another/47/l/latest.json"
            : categoryId === 44
              ? "/c/other/44/l/latest.json"
              : pathnameForLegacyTarget(category, childCategory);
    let rows =
      categoryId === 45 || categoryId === 46 || categoryId === 47
        ? dailyTopicsForCategory(categoryId)
        : categoryId === undefined
          ? dailyTopicsForAllVisibleCategories()
          : [];
    if (categoryId === 45 && activeState.dailyParentIncludesChild) {
      rows = [...rows, ...dailyTopicsForCategory(46)].toSorted(
        (first, second) => second.createdAt.localeCompare(first.createdAt),
      );
    }
    const overlapCount = perPage === 1 ? 0 : activeState.dailyTopicOverlapCount;
    const offset = page === 0 ? 0 : page * (perPage - overlapCount);
    const pageRows = rows.slice(offset, offset + perPage);
    const hasMore = offset + perPage < rows.length;
    return topicListResponse(
      pathname,
      page,
      pageRows.map(({ id, createdAt }) => ({ id, createdAt })),
      hasMore,
    );
  }

  const pathname = childCategory
    ? "/c/controlled/child/43/l/latest.json"
    : category
      ? "/c/controlled/42/l/latest.json"
      : "/latest.json";
  const topicRows = (
    childCategory
      ? [2499]
      : [2401, 2403, 2402, 2404, 2405, 2406, 2407, 2408, 2409, 2410, 2410]
  )
    .map((id) => ({
      id,
      createdAt:
        activeState.topicCreatedAtOverrides?.[id] ?? legacyTopicCreatedAt(id),
    }))
    .toSorted((first, second) =>
      second.createdAt.localeCompare(first.createdAt),
    );
  const pageRows = topicRows.slice(page * perPage, (page + 1) * perPage);
  return topicListResponse(
    pathname,
    page,
    pageRows,
    (page + 1) * perPage < topicRows.length,
  );
}

function pathnameForLegacyTarget(category: boolean, childCategory: boolean) {
  return childCategory
    ? "/c/controlled/child/43/l/latest.json"
    : category
      ? "/c/controlled/42/l/latest.json"
      : "/latest.json";
}

function dailyTopicDetails(topicId: number):
  | {
      readonly id: number;
      readonly categoryId: number;
      readonly createdAt: string;
    }
  | undefined {
  if (topicId === 700502) {
    return {
      id: topicId,
      categoryId: 45,
      createdAt: "2026-11-02T00:00:00.000Z",
    };
  }
  if (topicId === 699999) {
    return {
      id: topicId,
      categoryId: 45,
      createdAt: "2026-10-31T23:59:59.999Z",
    };
  }
  if (topicId < 700001 || topicId > 700501) return undefined;
  const categoryId = topicId <= 700200 ? 45 : topicId <= 700400 ? 46 : 47;
  const offset = topicId - 700001;
  const createdAt = new Date(
    Date.parse("2026-11-01T00:00:00.000Z") + offset * 160_000,
  ).toISOString();
  return { id: topicId, categoryId, createdAt };
}

function dailyTopicsForCategory(categoryId: number) {
  if (categoryId === 45) {
    return [
      dailyTopicDetails(700502)!,
      ...Array.from({ length: 200 }, (_, index) =>
        dailyTopicDetails(700200 - index)!,
      ),
      dailyTopicDetails(699999)!,
    ];
  }
  if (categoryId === 46) {
    return Array.from({ length: 200 }, (_, index) =>
      dailyTopicDetails(700400 - index)!,
    );
  }
  if (categoryId === 47) {
    return Array.from({ length: 101 }, (_, index) =>
      dailyTopicDetails(700501 - index)!,
    );
  }
  return [];
}

function paginationOrderTopicDetails(
  topicId: number,
): { readonly id: number; readonly createdAt: string } | undefined {
  const topics = new Map([
    [800_001, "2026-11-01T09:00:00.000Z"],
    [800_002, "2026-10-31T23:00:00.000Z"],
    [800_003, "2026-11-01T08:00:00.000Z"],
  ]);
  const createdAt = topics.get(topicId);
  return createdAt === undefined ? undefined : { id: topicId, createdAt };
}

function dailyTopicsForAllVisibleCategories() {
  return [
    ...dailyTopicsForCategory(45),
    ...dailyTopicsForCategory(46),
    ...dailyTopicsForCategory(47),
  ].toSorted((first, second) =>
    second.createdAt.localeCompare(first.createdAt),
  );
}

function topicListResponse(
  pathname: string,
  page: number,
  topics: readonly { readonly id: number; readonly createdAt: string }[],
  hasMore: boolean,
) {
  const moreTopicsUrl =
    activeState.targetPaginationLoopPage === page
      ? `${pathname.replace(/\.json$/u, "")}?page=${String(page)}`
      : activeState.targetEarlyEndPage === page
        ? `${pathname.replace(/\.json$/u, "")}?page=${String(page + 1)}`
        : activeState.targetInvalidPaginationUrlPage === page
          ? `https://example.invalid${pathname}?page=${String(page + 1)}`
          : hasMore
            ? `${pathname.replace(/\.json$/u, "")}?page=${String(page + 1)}`
            : null;
  return {
    topic_list: {
      topics: (activeState.targetEarlyEndPage === page ? [] : topics).map(
        ({ id, createdAt }) => ({
          id,
          created_at: activeState.invalidCreatedAtTopicIds.includes(id)
            ? "not-a-date"
            : createdAt,
        }),
      ),
      ...(moreTopicsUrl === null ? {} : { more_topics_url: moreTopicsUrl }),
    },
  };
}

function updateState(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const updates = value as Record<string, unknown>;
  for (const key of ["topicVersion", "replyVersion"] as const) {
    if (
      key in updates &&
      (!Number.isSafeInteger(updates[key]) || Number(updates[key]) < 1)
    ) {
      return false;
    }
  }
  if (
    "syncScenarioStage" in updates &&
    (!Number.isSafeInteger(updates.syncScenarioStage) ||
      Number(updates.syncScenarioStage) < 0 ||
      Number(updates.syncScenarioStage) > 3)
  ) {
    return false;
  }
  for (const key of [
    "targetUnavailablePage",
    "targetChallengePage",
    "targetInvalidResponsePage",
    "targetPaginationLoopPage",
    "targetInvalidPaginationUrlPage",
    "targetEarlyEndPage",
  ] as const) {
    if (
      key in updates &&
      updates[key] !== null &&
      (!Number.isSafeInteger(updates[key]) || Number(updates[key]) < 0)
    ) {
      return false;
    }
  }
  for (const key of [
    "siteHomeDelayMs",
    "topicListDelayMs",
    "mediaResponseDelayMs",
  ] as const) {
    if (
      key in updates &&
      (!Number.isSafeInteger(updates[key]) || Number(updates[key]) < 0)
    ) {
      return false;
    }
  }
  for (const key of [
    "nativeChallenge",
    "nativeChallengeWait",
    "nativeChallengeNoReload",
    "navigationRace",
    "nativeChallengePersistent",
    "nativeChallengeMedia",
    "challengePage",
    "challengeTopic",
    "challengePosts",
    "challengeMedia",
    "topicVisible",
    "legacyTags",
    "addedReply",
    "discoveryAddedReply",
    "categoriesUnavailable",
    "categoriesInvalidResponse",
    "dailyCollectionEnabled",
    "dailyParentIncludesChild",
    "postRangeEnabled",
    "postRangeAddAfterFirstPage",
    "postRangeRepeatPage",
    "paginationOrderMutationEnabled",
  ] as const) {
    if (key in updates && typeof updates[key] !== "boolean") return false;
  }
  if (
    "postRangePageSize" in updates &&
    (!Number.isSafeInteger(updates.postRangePageSize) ||
      Number(updates.postRangePageSize) < 1 ||
      Number(updates.postRangePageSize) > 50)
  ) {
    return false;
  }
  if (
    "postRangeInvalidPage" in updates &&
    updates.postRangeInvalidPage !== null &&
    (!Number.isSafeInteger(updates.postRangeInvalidPage) ||
      Number(updates.postRangeInvalidPage) < 1)
  ) {
    return false;
  }
  if (
    "postRangeResponseStatus" in updates &&
    updates.postRangeResponseStatus !== null &&
    updates.postRangeResponseStatus !== 429 &&
    updates.postRangeResponseStatus !== 503
  ) {
    return false;
  }
  if (
    "postRangeRetryAfter" in updates &&
    updates.postRangeRetryAfter !== null &&
    (typeof updates.postRangeRetryAfter !== "string" ||
      updates.postRangeRetryAfter.length > 256)
  ) {
    return false;
  }
  if (
    "dailyTopicOverlapCount" in updates &&
    (!Number.isSafeInteger(updates.dailyTopicOverlapCount) ||
      Number(updates.dailyTopicOverlapCount) < 1 ||
      Number(updates.dailyTopicOverlapCount) > 99)
  ) {
    return false;
  }
  if (
    "topicCreatedAtOverrides" in updates &&
    (typeof updates.topicCreatedAtOverrides !== "object" ||
      updates.topicCreatedAtOverrides === null ||
      Array.isArray(updates.topicCreatedAtOverrides) ||
      Object.entries(updates.topicCreatedAtOverrides).some(
        ([topicId, createdAt]) =>
          !/^[1-9]\d*$/u.test(topicId) ||
          typeof createdAt !== "string" ||
          !Number.isFinite(Date.parse(createdAt)),
      ))
  ) {
    return false;
  }
  if (
    "nativeChallengeStatus" in updates &&
    (!Number.isSafeInteger(updates.nativeChallengeStatus) ||
      Number(updates.nativeChallengeStatus) < 400 ||
      Number(updates.nativeChallengeStatus) > 599)
  )
    return false;
  if (
    "nativeChallengeNavigationDelayMs" in updates &&
    (!Number.isSafeInteger(updates.nativeChallengeNavigationDelayMs) ||
      Number(updates.nativeChallengeNavigationDelayMs) < 0 ||
      Number(updates.nativeChallengeNavigationDelayMs) > 60_000)
  )
    return false;
  if (
    "topicListDelayMs" in updates &&
    (!Number.isSafeInteger(updates.topicListDelayMs) ||
      Number(updates.topicListDelayMs) < 0 ||
      Number(updates.topicListDelayMs) > 30_000)
  ) {
    return false;
  }
  if (
    "mediaResponseDelayMs" in updates &&
    (!Number.isSafeInteger(updates.mediaResponseDelayMs) ||
      Number(updates.mediaResponseDelayMs) < 0 ||
      Number(updates.mediaResponseDelayMs) > 30_000)
  ) {
    return false;
  }
  for (const key of [
    "nativeChallengePaths",
    "omittedPostIds",
    "unavailableMedia",
    "invalidCreatedAtTopicIds",
  ] as const) {
    const entriesMustBeNumbers =
      key === "omittedPostIds" || key === "invalidCreatedAtTopicIds";
    if (
      key in updates &&
      (!Array.isArray(updates[key]) ||
        updates[key].some(
          (entry) =>
            typeof entry !== (entriesMustBeNumbers ? "number" : "string"),
        ))
    ) {
      return false;
    }
  }
  if (
    "unavailableMediaStatus" in updates &&
    (!Number.isSafeInteger(updates.unavailableMediaStatus) ||
      Number(updates.unavailableMediaStatus) < 400 ||
      Number(updates.unavailableMediaStatus) > 599)
  ) {
    return false;
  }
  if (
    "rateLimitPath" in updates &&
    updates.rateLimitPath !== null &&
    (typeof updates.rateLimitPath !== "string" ||
      !updates.rateLimitPath.startsWith("/") ||
      updates.rateLimitPath.length > 512)
  ) {
    return false;
  }
  if (
    "rateLimitStatus" in updates &&
    updates.rateLimitStatus !== 429 &&
    updates.rateLimitStatus !== 503
  ) {
    return false;
  }
  if (
    "retryAfterHeader" in updates &&
    (typeof updates.retryAfterHeader !== "string" ||
      updates.retryAfterHeader.length > 256)
  ) {
    return false;
  }
  if (
    "rateLimitRemaining" in updates &&
    (!Number.isSafeInteger(updates.rateLimitRemaining) ||
      Number(updates.rateLimitRemaining) < 0 ||
      Number(updates.rateLimitRemaining) > 10)
  ) {
    return false;
  }
  if (updates.navigationRace === true) navigationRequested = false;
  postRangeReadCount = 0;
  activeState = {
    ...activeState,
    ...updates,
  } as SourceState;
  return true;
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://linuxdo-e2e-source");
    const pathname = url.pathname;
    const authenticated = isAuthenticated(request);

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { process: "ready" });
      return;
    }
    if (request.method === "GET" && pathname === "/__navigation/status") {
      sendJson(response, 200, { ready: navigationRequested });
      return;
    }
    if (request.method === "GET" && pathname === "/__navigation/ready") {
      record("navigation-race", pathname, authenticated);
      activeState = { ...activeState, navigationRace: false };
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html><body>页面导航完成。</body></html>");
      return;
    }
    if (request.method === "GET" && pathname === "/") {
      record("site-home", pathname, authenticated);
      await delay(activeState.siteHomeDelayMs ?? 0);
      if (!activeState.navigationRace) {
        response.writeHead(404);
        response.end("Linux.do 受控首页。");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body><script>
        const timer = setInterval(async () => {
          const state = await (await fetch('/__navigation/status', {cache: 'no-store'})).json();
          if (state.ready) { clearInterval(timer); location.replace('/__navigation/ready'); }
        }, 10);
      </script></body></html>`);
      return;
    }
    if (request.method === "GET" && pathname === "/__control/state") {
      sendJson(response, 200, { state: activeState, events: [...events] });
      return;
    }
    if (request.method === "POST" && pathname === "/__control/clear-events") {
      events.length = 0;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "POST" && pathname === "/__control/state") {
      let value: unknown;
      try {
        value = JSON.parse(await readBody(request)) as unknown;
      } catch {
        sendJson(response, 400, { error: "控制状态不是有效 JSON。" });
        return;
      }
      if (!updateState(value)) {
        sendJson(response, 400, { error: "控制状态格式无效。" });
        return;
      }
      sendJson(response, 200, { state: activeState, events: [...events] });
      return;
    }
    if (
      activeState.rateLimitPath === pathname &&
      activeState.rateLimitRemaining > 0
    ) {
      const { rateLimitStatus, retryAfterHeader } = activeState;
      activeState = {
        ...activeState,
        rateLimitRemaining: activeState.rateLimitRemaining - 1,
      };
      record(`rate-limit-${String(rateLimitStatus)}`, pathname, authenticated);
      response.writeHead(rateLimitStatus, {
        "content-type": "application/json; charset=utf-8",
        "retry-after": retryAfterHeader,
      });
      response.end(JSON.stringify({ errors: ["受控来源请求受限。"] }));
      return;
    }
    if (request.method === "POST" && pathname === "/__challenge/complete") {
      record(
        url.searchParams.get("mode") === "wait"
          ? "challenge-wait"
          : "challenge-click",
        pathname,
        authenticated,
      );
      activeState = {
        ...activeState,
        nativeChallenge:
          activeState.nativeChallenge && activeState.nativeChallengePersistent,
        nativeChallengeMedia:
          activeState.nativeChallengeMedia &&
          activeState.nativeChallengePersistent,
        nativeChallengePaths: activeState.nativeChallengePaths.filter(
          (path) => path !== url.searchParams.get("target"),
        ),
      };
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && pathname === "/login") {
      record("login-page", pathname);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html><body><form method="post" action="/login"><label>用户名<input name="username" autocomplete="username"></label><label>密码<input name="password" type="password" autocomplete="current-password"></label><button>登录</button></form></body></html>',
      );
      return;
    }
    if (request.method === "POST" && pathname === "/login") {
      const form = new URLSearchParams(await readBody(request));
      if (
        form.get("username") !== "binny-discovery-user" ||
        form.get("password") !== "linuxdo-fixture"
      ) {
        record("login-rejected", pathname);
        response.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("受控登录信息无效。");
        return;
      }
      record("login-complete", pathname);
      response.writeHead(303, {
        location: "/",
        "set-cookie":
          "binny-discovery_session=fixture; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && pathname === "/logout") {
      record("logout", pathname, authenticated);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie":
          "binny-discovery_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
      });
      response.end("<!doctype html><html><body>已退出登录。</body></html>");
      return;
    }
    if (
      request.method === "GET" &&
      ((pathname === "/session/current.json" && activeState.nativeChallenge) ||
        (pathname === photoPath && activeState.nativeChallengeMedia) ||
        activeState.nativeChallengePaths.includes(pathname))
    ) {
      record(
        pathname === photoPath ? "media" : "session-current",
        pathname,
        authenticated,
      );
      if (
        request.headers["sec-fetch-mode"] === "navigate" ||
        request.headers.accept?.includes("text/html")
      ) {
        record("challenge-navigation", pathname, authenticated);
        await delay(activeState.nativeChallengeNavigationDelayMs);
      }
      response.writeHead(activeState.nativeChallengeStatus, {
        "content-type": "text/html; charset=utf-8",
        "cf-mitigated": "challenge",
      });
      response.end(`<!doctype html><html><head><title>Just a moment...</title></head><body>
          <div id="challenge-running">Cloudflare</div>
          ${activeState.nativeChallengeWait ? "" : '<label><input type="checkbox">Verify you are human</label>'}
          <script>window._cf_chl_opt = {};
          async function complete(mode) {
            await fetch('/__challenge/complete?mode=' + mode + '&target=' + encodeURIComponent(${JSON.stringify(pathname)}), {method: 'POST'});
            ${activeState.nativeChallengeNoReload ? "document.querySelector('label')?.remove();" : "location.reload();"}
          }
          ${
            activeState.nativeChallengeWait
              ? "setTimeout(() => complete('wait'), 1500);"
              : "document.querySelector('input').addEventListener('change', () => complete('click'));"
          }
          </script></body></html>`);
      return;
    }
    if (request.method === "GET" && pathname === "/session/current.json") {
      record("session-current", pathname, authenticated);
      if (activeState.navigationRace) {
        navigationRequested = true;
        await delay(5_000);
      }
      if (activeState.challengePage) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body>受控挑战页面</body></html>");
        return;
      }
      if (!authenticated) {
        response.writeHead(404);
        response.end();
        return;
      }
      sendJson(response, 200, {
        current_user: { id: 24, username: "binny-discovery-user" },
      });
      return;
    }
    if (request.method === "GET" && pathname === "/categories.json") {
      record(
        "categories",
        `${pathname}?${url.searchParams.toString()}`,
        authenticated,
      );
      if (!authenticated) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (activeState.categoriesUnavailable) {
        sendJson(response, 503, { errors: ["板块暂不可用。"] });
        return;
      }
      if (activeState.categoriesInvalidResponse) {
        sendJson(response, 200, { category_list: { categories: [{}] } });
        return;
      }
      sendJson(response, 200, {
        category_list: {
          categories: [
            {
              id: 42,
              name: "受控板块",
              slug: "controlled",
              parent_category_id: null,
              position: 1,
            },
            {
              id: 43,
              name: "可见子板块",
              slug: "child",
              parent_category_id: 42,
              position: 1,
            },
            {
              id: 44,
              name: "另一可见板块",
              slug: "other",
              parent_category_id: null,
              position: 2,
            },
            ...(activeState.dailyCollectionEnabled
              ? [
                  {
                    id: 45,
                    name: "全日父板块",
                    slug: "daily",
                    parent_category_id: null,
                    position: 3,
                  },
                  {
                    id: 46,
                    name: "全日子板块",
                    slug: "daily-child",
                    parent_category_id: 45,
                    position: 1,
                  },
                  {
                    id: 47,
                    name: "全日另一板块",
                    slug: "another",
                    parent_category_id: null,
                    position: 4,
                  },
                ]
              : []),
          ],
        },
      });
      return;
    }
    if (request.method === "GET" && pathname === "/posts.json") {
      record(
        "post-list",
        `${pathname}?${url.searchParams.toString()}`,
        authenticated,
      );
      if (!authenticated || !activeState.postRangeEnabled) {
        response.writeHead(404);
        response.end();
        return;
      }
      postRangeReadCount += 1;
      if (activeState.postRangeResponseStatus !== null) {
        response.writeHead(activeState.postRangeResponseStatus, {
          "content-type": "application/json; charset=utf-8",
          ...(activeState.postRangeRetryAfter === null
            ? {}
            : { "retry-after": activeState.postRangeRetryAfter }),
        });
        response.end(JSON.stringify({ errors: ["受控来源暂时限流。"] }));
        return;
      }
      if (activeState.postRangeInvalidPage === postRangeReadCount) {
        sendJson(response, 200, {});
        return;
      }
      const beforeValue = url.searchParams.get("before");
      const before = beforeValue === null ? undefined : Number(beforeValue);
      if (before !== undefined && !Number.isSafeInteger(before)) {
        sendJson(response, 400, { errors: ["before 游标无效。"] });
        return;
      }
      const feed = postRangeFixtures(
        activeState.postRangeAddAfterFirstPage && postRangeReadCount > 1,
      );
      const eligible =
        activeState.postRangeRepeatPage && before !== undefined
          ? feed
          : feed.filter(
              ({ id }) => before === undefined || Number(id) < before,
            );
      sendJson(response, 200, {
        latest_posts: eligible.slice(0, activeState.postRangePageSize),
      });
      return;
    }
    const topicJsonMatch = /^\/t\/(\d+)\.json$/u.exec(pathname);
    if (topicJsonMatch !== null && request.method === "GET") {
      const topicId = Number(topicJsonMatch[1]);
      record("topic", pathname, authenticated);
      if (!authenticated) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (topicId === 2401 && activeState.challengeTopic) {
        response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body>受控主题挑战页</body></html>");
        return;
      }
      if (
        (topicId === 2401 && !activeState.topicVisible) ||
        activeState.unavailableTopicIds.includes(topicId)
      ) {
        sendJson(response, 404, { errors: ["主题当前不可见。"] });
        return;
      }
      sendJson(response, 200, discoveredTopic(topicId));
      return;
    }
    const topicListMatch =
      pathname === "/latest.json"
        ? { category: false, childCategory: false, categoryId: undefined }
        : pathname === "/c/controlled/42/l/latest.json"
          ? { category: true, childCategory: false, categoryId: 42 }
          : pathname === "/c/controlled/child/43/l/latest.json"
            ? { category: true, childCategory: true, categoryId: 43 }
            : pathname === "/c/daily/45/l/latest.json"
              ? { category: true, childCategory: false, categoryId: 45 }
              : pathname === "/c/daily/daily-child/46/l/latest.json"
                ? { category: true, childCategory: false, categoryId: 46 }
                : pathname === "/c/another/47/l/latest.json"
                  ? { category: true, childCategory: false, categoryId: 47 }
                  : pathname === "/c/other/44/l/latest.json"
                    ? { category: true, childCategory: false, categoryId: 44 }
                    : undefined;
    if (topicListMatch !== undefined && request.method === "GET") {
      record(
        "topic-list",
        `${pathname}?${url.searchParams.toString()}`,
        authenticated,
      );
      if (!authenticated) {
        response.writeHead(404);
        response.end();
        return;
      }
      const topicListDelayMs = activeState.topicListDelayMs ?? 0;
      if (topicListDelayMs > 0) await delay(topicListDelayMs);
      const listPage = Number(url.searchParams.get("page") ?? "0");
      if (activeState.targetUnavailablePage === listPage) {
        sendJson(response, 404, { errors: ["列表目标当前不可见。"] });
        return;
      }
      if (activeState.targetChallengePage === listPage) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body>受控列表挑战页</body></html>");
        return;
      }
      if (activeState.targetInvalidResponsePage === listPage) {
        sendJson(response, 200, {});
        return;
      }
      const responseBody = discoveredTopicList(
        topicListMatch.category,
        listPage,
        Number(url.searchParams.get("per_page") ?? "30"),
        topicListMatch.childCategory,
        topicListMatch.categoryId,
      );
      const listedTopics = responseBody as {
        readonly topic_list: {
          readonly topics: readonly { readonly id: number }[];
          readonly more_topics_url?: string | null;
        };
      };
      record(
        "topic-list-payload",
        pathname + "?" + url.searchParams.toString(),
        authenticated,
        {
          topicIds: listedTopics.topic_list.topics.map(({ id }) => id),
          moreTopicsUrl: listedTopics.topic_list.more_topics_url ?? null,
        },
      );
      sendJson(response, 200, responseBody);
      return;
    }
    const postsMatch = /^\/t\/(\d+)\/posts\.json$/u.exec(pathname);
    if (postsMatch !== null && request.method === "GET") {
      const topicId = Number(postsMatch[1]);
      record(
        "posts",
        `${pathname}?${url.searchParams.toString()}`,
        authenticated,
      );
      if (!authenticated) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (topicId === 2401 && activeState.challengePosts) {
        response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><html><body>受控帖子补取挑战页</body></html>",
        );
        return;
      }
      if (topicId === 2401 && !activeState.topicVisible) {
        sendJson(response, 404, { errors: ["主题当前不可见。"] });
        return;
      }
      const requestedIds = url.searchParams
        .getAll("post_ids[]")
        .map(Number)
        .filter(Number.isSafeInteger);
      const selectedPosts =
        topicId === 2401
          ? posts().filter(
              ({ id }) =>
                requestedIds.includes(Number(id)) &&
                !activeState.omittedPostIds.includes(Number(id)),
            )
          : [];
      sendJson(response, 200, {
        post_stream: { posts: selectedPosts },
      });
      return;
    }
    if (pathname.startsWith("/uploads/") && request.method === "GET") {
      await serveMedia(request, response, pathname, authenticated);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("没有找到受控 Discourse 兼容路由。");
  })().catch((error: unknown) => {
    if (!response.headersSent) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "受控信源内部错误。",
      });
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
});

const port = Number(process.env.BINNY_DISCOVERY_SOURCE_PORT ?? "8081");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("受控 Linux.do 信源端口配置无效。");
}
server.listen(port, "0.0.0.0");
