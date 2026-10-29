import { createServer } from "node:http";

type SourceState = {
  readonly challengePage: boolean;
  readonly challengeTopic: boolean;
  readonly challengePosts: boolean;
  readonly challengeMedia: boolean;
  readonly topicVisible: boolean;
  readonly legacyTags: boolean;
  readonly topicVersion: number;
  readonly replyVersion: number;
  readonly addedReply: boolean;
  readonly discoveryAddedReply: boolean;
  readonly omittedPostIds: readonly number[];
  readonly unavailableTopicIds: readonly number[];
  readonly unavailableMedia: readonly string[];
  readonly unavailableMediaStatus: number;
};

type SourceEvent = {
  readonly action: string;
  readonly path: string;
  readonly authenticated?: boolean;
};

const rootPostId = 240_001;
const firstReplyId = 240_002;
const secondReplyId = 240_003;
const thirdReplyId = 240_004;
const photoPath = "/uploads/default/original/2X/topic-photo.png";
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
  challengePage: false,
  challengeTopic: false,
  challengePosts: false,
  challengeMedia: false,
  topicVisible: true,
  legacyTags: false,
  topicVersion: 1,
  replyVersion: 1,
  addedReply: false,
  discoveryAddedReply: false,
  omittedPostIds: [],
  unavailableTopicIds: [],
  unavailableMedia: [],
  unavailableMediaStatus: 503,
};
const events: SourceEvent[] = [];

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
    .some((value) => value.trim() === "binny25_session=fixture");
}

function record(action: string, path: string, authenticated?: boolean): void {
  events.push({
    action,
    path,
    ...(authenticated === undefined ? {} : { authenticated }),
  });
  if (events.length > 500) events.shift();
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
      `<p>主题正文版本 ${String(activeState.topicVersion)}</p><div class="lightbox-wrapper"><a class="lightbox" href="${photoPath}"><picture><source type="image/webp" srcset="${smallPhotoCandidate} 1x, ${largePhotoCandidate} 2x"><img src="${photoPath}" srcset="${smallPhotoCandidate} 1x, ${largePhotoCandidate} 2x" alt="主题封面"></picture></a></div><p><a class="attachment" href="${attachmentPath}">主题资料.pdf</a></p><p><a class="attachment" href="${jsonAttachmentPath}">主题元数据.json</a></p>${activeState.challengeMedia ? `<p><a class="attachment" href="${challengeMediaPath}">登录挑战.html</a></p>` : ""}`,
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
  ].map((value, index) =>
    index === 0 ? { ...value, title: rootTitle } : value,
  );
}

function discoveredTopic(topicId: number): Record<string, unknown> {
  const createdAt =
    topicId === 2401
      ? "2026-10-28T00:00:00.000Z"
      : topicId === 2402
        ? "2026-10-27T00:00:00.000Z"
        : "2026-10-26T00:00:00.000Z";
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
): Record<string, unknown> {
  const topicIds =
    page === 0
      ? (category
          ? [2402, 2403, 2401, 2404, 2405, 2406, 2407, 2408, 2409, 2410]
          : [2401, 2403, 2402, 2404, 2405, 2406, 2407, 2408, 2409, 2410]
        ).slice(0, perPage)
      : category
        ? [2403, 2401].slice(0, perPage)
        : [2402, 2403].slice(0, perPage);
  const pathname = category ? "/c/controlled/42/l/latest.json" : "/latest.json";
  return {
    topic_list: {
      topics: topicIds.map((id) => {
        const createdAt =
          id === 2401
            ? "2026-10-28T00:00:00.000Z"
            : id === 2402
              ? "2026-10-27T00:00:00.000Z"
              : "2026-10-26T00:00:00.000Z";
        return { id, created_at: createdAt };
      }),
      ...(page === 0 && topicIds.length === perPage
        ? { more_topics_url: `${pathname}?page=1` }
        : {}),
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
  for (const key of [
    "challengePage",
    "challengeTopic",
    "challengePosts",
    "challengeMedia",
    "topicVisible",
    "legacyTags",
    "addedReply",
    "discoveryAddedReply",
  ] as const) {
    if (key in updates && typeof updates[key] !== "boolean") return false;
  }
  for (const key of ["omittedPostIds", "unavailableMedia"] as const) {
    if (
      key in updates &&
      (!Array.isArray(updates[key]) ||
        updates[key].some(
          (entry) =>
            typeof entry !== (key === "omittedPostIds" ? "number" : "string"),
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
    if (request.method === "GET" && pathname === "/__control/state") {
      sendJson(response, 200, { state: activeState, events: [...events] });
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
        form.get("username") !== "binny25-user" ||
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
          "binny25_session=fixture; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && pathname === "/logout") {
      record("logout", pathname, authenticated);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie":
          "binny25_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
      });
      response.end("<!doctype html><html><body>已退出登录。</body></html>");
      return;
    }
    if (request.method === "GET" && pathname === "/session/current.json") {
      record("session-current", pathname, authenticated);
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
        current_user: { id: 24, username: "binny25-user" },
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
        ? { category: false }
        : pathname === "/c/controlled/42/l/latest.json"
          ? { category: true }
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
      sendJson(
        response,
        200,
        discoveredTopicList(
          topicListMatch.category,
          Number(url.searchParams.get("page") ?? "0"),
          Number(url.searchParams.get("per_page") ?? "30"),
        ),
      );
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
      record("media", pathname, authenticated);
      if (!authenticated) {
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

const port = Number(process.env.BINNY25_SOURCE_PORT ?? "8081");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("受控 Linux.do 信源端口配置无效。");
}
server.listen(port, "0.0.0.0");
