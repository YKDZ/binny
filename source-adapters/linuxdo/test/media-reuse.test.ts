import assert from "node:assert/strict";
import test from "node:test";

import type {
  ArchiveResourceMetadata,
  ArchiveResourceResolveItem,
  ArchiveResourceResolveRequest,
  ArchiveResourceResolveResult,
  SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import type { APIRequestContext, Page } from "patchright-core";

import {
  hashContent,
  isDiscourseImmutableMediaUrl,
  isOpUnchanged,
} from "../src/media-reuse.ts";
import {
  archivePost,
  bindPageSourceAccessForTest,
} from "../src/source-adapter.ts";

const siteOrigin = new URL("https://linux.do");
const siteNamespace = "linuxdo";

const immutableUrl1 =
  "https://linux.do/uploads/default/original/2X/a/b/0123456789abcdef0123456789abcdef01234567.png";
const immutableUrl2 =
  "https://linux.do/uploads/default/optimized/1X/0123456789abcdef0123456789abcdef01234567_2_690x388.jpeg";
const mutableUrl =
  "https://linux.do/uploads/default/original/2X/topic-photo.png";
const externalUrl = "https://example.com/photo.png";

void test("isDiscourseImmutableMediaUrl verifies Discourse 40-hex SHA-1 content identity", () => {
  assert.ok(isDiscourseImmutableMediaUrl(immutableUrl1, siteOrigin));
  assert.ok(isDiscourseImmutableMediaUrl(immutableUrl2, siteOrigin));
  assert.ok(
    isDiscourseImmutableMediaUrl(
      "/uploads/default/original/2X/0123456789abcdef0123456789abcdef01234567.png",
      siteOrigin,
    ),
  );
  assert.equal(
    isDiscourseImmutableMediaUrl(
      "https://cdn3.ldstatic.com/original/4X/9/0/3/903f6360af259fe24b6b91e24af4616676685a71.jpeg",
      "https://linux.do",
    ),
    true,
  );
  assert.equal(
    isDiscourseImmutableMediaUrl(
      "https://cdn3.ldstatic.com/optimized/4X/e/6/a/e6a4acfa4b49585295f73b5aacb95988bd1228ad_2_690x388.png",
      "https://linux.do",
    ),
    true,
  );

  // Mutable and external paths must NOT be treated as immutable.
  assert.equal(isDiscourseImmutableMediaUrl(mutableUrl, siteOrigin), false);
  assert.equal(isDiscourseImmutableMediaUrl(externalUrl, siteOrigin), false);
  assert.equal(
    isDiscourseImmutableMediaUrl(
      "/uploads/default/original/2X/avatar.jpg",
      siteOrigin,
    ),
    false,
  );
  assert.equal(isDiscourseImmutableMediaUrl("invalid-url", siteOrigin), false);
});

void test("isOpUnchanged detects unchanged and modified OP posts and topic metadata", () => {
  const topic = {
    id: 100,
    title: "Linux.do 架构探讨",
    slug: "linuxdo-architecture",
    category_id: 4,
    tags: ["tech", "core"],
  };

  const post = {
    id: 1001,
    post_number: 1,
    cooked: "<p>主帖正文内容</p>",
    updated_at: "2026-10-28T00:00:00.000Z",
    version: 1,
  };

  const verifiedResource: ArchiveResourceMetadata = {
    resourceId: "00000000-0000-0000-0000-000000000001",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    mediaType: "image/png",
    size: 1024,
  };

  const archivedOp: ArchiveResourceResolveItem = {
    sourceKey: { namespace: "linuxdo", key: "post:1001" },
    state: {
      sourceRef: "https://linux.do/t/linuxdo-architecture/100/1",
      sourceModifiedAt: "2026-10-28T00:00:00.000Z",
      metadata: {
        topicId: 100,
        postId: 1001,
        postNumber: 1,
        postVersion: 1,
        cookedHash: hashContent("<p>主帖正文内容</p>"),
        topic: {
          title: "Linux.do 架构探讨",
          slug: "linuxdo-architecture",
          categoryId: 4,
          tags: ["tech", "core"],
        },
      },
      body: {
        markdown:
          "主帖正文内容：![封面](binny://resource/00000000-0000-0000-0000-000000000001)",
        text: "主帖正文内容",
        searchText: "Linux.do 架构探讨\n主帖正文内容",
      },
      resources: [{ resourceId: verifiedResource.resourceId }],
      capture: {
        scope: { topicId: 100, postId: 1001 },
        completeness: "complete",
        missing: [],
      },
    },
    resourceMetadata: [verifiedResource],
  };

  // 1. Matches completely
  assert.equal(isOpUnchanged(topic, post, archivedOp), true);

  // 2. Title changed (e.g. topicVersion bump)
  assert.equal(
    isOpUnchanged({ ...topic, title: "标题已更新" }, post, archivedOp),
    false,
  );

  // 3. Category changed
  assert.equal(
    isOpUnchanged({ ...topic, category_id: 99 }, post, archivedOp),
    false,
  );

  // 4. Tags changed
  assert.equal(
    isOpUnchanged({ ...topic, tags: ["new-tag"] }, post, archivedOp),
    false,
  );

  // 5. Updated_at changed
  assert.equal(
    isOpUnchanged(
      topic,
      { ...post, updated_at: "2026-10-28T01:00:00.000Z" },
      archivedOp,
    ),
    false,
  );

  // 6. Cooked body changed
  assert.equal(
    isOpUnchanged(
      topic,
      { ...post, cooked: "<p>正文发生修改</p>" },
      archivedOp,
    ),
    false,
  );

  // 7. Post version bumped
  assert.equal(
    isOpUnchanged(topic, { ...post, version: 2 }, archivedOp),
    false,
  );

  // 8. Capture was partial
  const partialArchivedOp: ArchiveResourceResolveItem = {
    ...archivedOp,
    state: {
      ...archivedOp.state,
      capture: {
        scope: { topicId: 100 },
        completeness: "partial",
        missing: [{ path: "body.images[0]", reason: "下载失败" }],
      },
    },
  };
  assert.equal(isOpUnchanged(topic, post, partialArchivedOp), false);
});

function createMockPage(
  prepared: {
    html: string;
    text: string;
    media: {
      index: number;
      kind: "image" | "attachment";
      url: string;
      path: string;
    }[];
  },
  options?: {
    onFetch?: (href: string) => void;
    fetchResponse?: (href: string) => {
      status: number;
      contentType: string;
      body: string;
    };
  },
): { readonly page: Page; evaluateCount: () => number } {
  let count = 0;
  const page = {
    url() {
      return "https://linux.do";
    },
    isClosed() {
      return false;
    },
    async evaluate(_fn: unknown, arg: unknown) {
      count += 1;
      if (typeof arg === "string") {
        return prepared;
      }
      if (arg && typeof arg === "object" && "href" in arg) {
        const fetchArg = arg as { href: string; bodyType: "text" | "base64" };
        options?.onFetch?.(fetchArg.href);
        const resp = options?.fetchResponse?.(fetchArg.href) ?? {
          status: 200,
          contentType: "image/png",
          body: Buffer.from([1, 2, 3, 4]).toString("base64"),
        };
        return {
          status: resp.status,
          contentType: resp.contentType,
          body: resp.body,
          bodyType: fetchArg.bodyType,
        };
      }
      const payload = arg as {
        source?: string;
        replacements?: [number, string][];
      };
      const replacements = payload?.replacements ?? [];
      let rewritten = payload?.source ?? prepared.html;
      for (const [idx, ref] of replacements) {
        rewritten = rewritten.replaceAll(
          `data-binny-media-index="${String(idx)}"`,
          `src="${ref}"`,
        );
      }
      return { html: rewritten, text: prepared.text };
    },
  } as unknown as Page;
  bindPageSourceAccessForTest(page, "https://linux.do");
  return { page, evaluateCount: () => count };
}

void test("Unchanged OP context in sync and collect reuses Core-verified resources without re-requesting OP media", async () => {
  const verifiedResource: ArchiveResourceMetadata = {
    resourceId: "11111111-1111-1111-1111-111111111111",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mediaType: "image/png",
    size: 2048,
  };

  const archivedOp: ArchiveResourceResolveItem = {
    sourceKey: { namespace: "linuxdo", key: "post:2001" },
    state: {
      sourceRef: "https://linux.do/t/test/200/1",
      sourceModifiedAt: "2026-10-28T00:00:00.000Z",
      metadata: {
        topicId: 200,
        postId: 2001,
        postNumber: 1,
        postVersion: 1,
        cookedHash: hashContent("<p>旧主帖正文</p>"),
        media: [
          { url: immutableUrl1, resourceId: verifiedResource.resourceId },
        ],
        topic: {
          title: "测试主题",
          slug: "test",
          categoryId: 1,
          tags: ["test"],
        },
      },
      body: {
        markdown: `旧主帖正文：![封面](binny://resource/${verifiedResource.resourceId})`,
        text: "旧主帖正文",
        searchText: "测试主题\n旧主帖正文",
      },
      resources: [{ resourceId: verifiedResource.resourceId }],
      capture: {
        scope: { topicId: 200, postId: 2001, postNumber: 1 },
        completeness: "complete",
        missing: [],
      },
    },
    resourceMetadata: [verifiedResource],
  };

  let resolveCount = 0;
  let uploadCount = 0;
  let sourceDownloadCount = 0;

  const mockContext = {
    binId: "binny-test-bin",
    identityId: "test-identity",
    runId: "test-run",
    referenceTime: "2026-10-28T00:00:00.000Z",
    sourceAdapterVersion: "1.0.0",
    config: { origin: "https://linux.do" },
    signal: new AbortController().signal,
    resources: {
      async resolve(
        input: ArchiveResourceResolveRequest,
      ): Promise<ArchiveResourceResolveResult> {
        resolveCount += 1;
        assert.equal(input.sourceKeys?.[0]?.key, "post:2001");
        return {
          resources: [],
          items: [archivedOp],
          mediaByUrl: {},
        };
      },
      async upload() {
        uploadCount += 1;
        throw new Error("不应执行资源上传");
      },
    },
    archive: {
      async submit() {
        throw new Error("未调用");
      },
    },
  } as unknown as SourceAdapterContext;

  const mockPage = createMockPage({
    html: `<p>旧主帖正文：<img src="${immutableUrl1}"></p>`,
    text: "旧主帖正文",
    media: [
      {
        index: 0,
        kind: "image",
        url: immutableUrl1,
        path: "body.images[0]",
      },
    ],
  });

  const mockRequest = {
    async get() {
      sourceDownloadCount += 1;
      throw new Error("不应向源站发起源站媒体下载请求");
    },
  } as unknown as APIRequestContext;

  const mediaCache = new Map();

  const result = await archivePost(
    mockPage.page,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    {
      id: 200,
      title: "测试主题",
      slug: "test",
      category_id: 1,
      tags: ["test"],
      post_stream: { posts: [] },
    },
    {
      id: 2001,
      post_number: 1,
      cooked: "<p>旧主帖正文</p>",
      updated_at: "2026-10-28T00:00:00.000Z",
      version: 1,
      reply_to_post_number: null,
    },
    [],
    mediaCache,
  );

  assert.equal(resolveCount, 1);
  assert.equal(sourceDownloadCount, 0);
  assert.equal(uploadCount, 0);
  assert.equal(mockPage.evaluateCount(), 0);
  assert.equal(result.complete, true);
  assert.equal(result.state.sourceKey.key, "post:2001");
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.ok(
    result.state.body?.markdown?.includes(
      `binny://resource/${verifiedResource.resourceId}`,
    ),
  );
  assert.deepEqual(result.state.resources, [
    { resourceId: verifiedResource.resourceId },
  ]);
  assert.ok(mediaCache.has(immutableUrl1));
});

void test("Unchanged OP post with mutable media URL does not skip source download while immutable media is reused", async () => {
  const verifiedImmutableResource: ArchiveResourceMetadata = {
    resourceId: "11111111-1111-1111-1111-111111111111",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mediaType: "image/png",
    size: 2048,
  };
  const uploadedMutableResource: ArchiveResourceMetadata = {
    resourceId: "22222222-2222-2222-2222-222222222222",
    sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    mediaType: "image/png",
    size: 4096,
  };

  const oldMutableResourceId = "00000000-0000-0000-0000-000000000000";
  const opCooked = `<p>主帖正文：<img src="${immutableUrl1}"><img src="${mutableUrl}"></p>`;

  const archivedOp: ArchiveResourceResolveItem = {
    sourceKey: { namespace: "linuxdo", key: "post:2002" },
    state: {
      sourceRef: "https://linux.do/t/test/200/1",
      sourceModifiedAt: "2026-10-28T00:00:00.000Z",
      metadata: {
        topicId: 200,
        postId: 2002,
        postNumber: 1,
        postVersion: 1,
        cookedHash: hashContent(opCooked),
        media: [
          {
            url: immutableUrl1,
            resourceId: verifiedImmutableResource.resourceId,
          },
          { url: mutableUrl, resourceId: oldMutableResourceId },
        ],
        topic: {
          title: "测试主题",
          slug: "test",
          categoryId: 1,
          tags: ["test"],
        },
      },
      body: {
        markdown: `旧主帖正文：![不可变](binny://resource/${verifiedImmutableResource.resourceId})![可变](binny://resource/${oldMutableResourceId})`,
        text: "旧主帖正文",
        searchText: "测试主题\n旧主帖正文",
      },
      resources: [
        { resourceId: verifiedImmutableResource.resourceId },
        { resourceId: oldMutableResourceId },
      ],
      capture: {
        scope: { topicId: 200, postId: 2002, postNumber: 1 },
        completeness: "complete",
        missing: [],
      },
    },
    resourceMetadata: [
      verifiedImmutableResource,
      {
        resourceId: oldMutableResourceId,
        sha256:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        mediaType: "image/png",
        size: 1024,
      },
    ],
  };

  const topic = {
    id: 200,
    title: "测试主题",
    slug: "test",
    category_id: 1,
    tags: ["test"],
    post_stream: { posts: [] },
  };

  const post = {
    id: 2002,
    post_number: 1,
    cooked: opCooked,
    updated_at: "2026-10-28T00:00:00.000Z",
    version: 1,
    reply_to_post_number: null,
  };

  // Verify that the OP is strictly unchanged according to isOpUnchanged.
  assert.equal(isOpUnchanged(topic, post, archivedOp), true);

  let resolveCount = 0;
  let uploadCount = 0;
  let sourceDownloadCount = 0;

  const mockContext = {
    binId: "binny-test-bin",
    identityId: "test-identity",
    runId: "test-run",
    referenceTime: "2026-10-28T00:00:00.000Z",
    sourceAdapterVersion: "1.0.0",
    config: { origin: "https://linux.do" },
    signal: new AbortController().signal,
    resources: {
      async resolve(
        input: ArchiveResourceResolveRequest,
      ): Promise<ArchiveResourceResolveResult> {
        resolveCount += 1;
        assert.equal(input.sourceKeys?.[0]?.key, "post:2002");
        return {
          resources: [],
          items: [archivedOp],
          mediaByUrl: {},
        };
      },
      async upload(_body: BodyInit, mediaType: string) {
        uploadCount += 1;
        assert.equal(mediaType, "image/png");
        return { ok: true as const, resource: uploadedMutableResource };
      },
    },
    archive: {
      async submit() {
        throw new Error("未调用");
      },
    },
  } as unknown as SourceAdapterContext;

  const mockPage = createMockPage(
    {
      html: `<p>旧主帖正文：<img data-binny-media-index="0" src="${immutableUrl1}"><img data-binny-media-index="1" src="${mutableUrl}"></p>`,
      text: "旧主帖正文",
      media: [
        {
          index: 0,
          kind: "image",
          url: immutableUrl1,
          path: "body.images[0]",
        },
        {
          index: 1,
          kind: "image",
          url: mutableUrl,
          path: "body.images[1]",
        },
      ],
    },
    {
      onFetch(href) {
        sourceDownloadCount += 1;
        // Only mutable URL should trigger source download; immutable URL is reused from mediaCache
        assert.equal(href, mutableUrl);
      },
    },
  );

  const mockRequest = {
    async get() {
      sourceDownloadCount += 1;
      throw new Error("不应向未配置的 request 发送请求");
    },
  } as unknown as APIRequestContext;

  const mediaCache = new Map();

  const result = await archivePost(
    mockPage.page,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    topic,
    post,
    [],
    mediaCache,
  );

  assert.equal(resolveCount, 1);
  assert.equal(sourceDownloadCount, 1);
  assert.equal(uploadCount, 1);
  assert.equal(result.complete, true);
  assert.equal(result.state.sourceKey.key, "post:2002");
  // Immutable media was reused from cache
  assert.ok(mediaCache.has(immutableUrl1));
  // Mutable media was freshly uploaded and both resources are present
  assert.deepEqual(result.state.resources, [
    { resourceId: verifiedImmutableResource.resourceId },
    { resourceId: uploadedMutableResource.resourceId },
  ]);
  assert.ok(
    result.state.body?.markdown?.includes(
      `binny://resource/${verifiedImmutableResource.resourceId}`,
    ),
  );
  assert.ok(
    result.state.body?.markdown?.includes(
      `binny://resource/${uploadedMutableResource.resourceId}`,
    ),
  );
});

void test("Immutable 40-hex SHA-1 Discourse upload URLs reuse Core-verified ArchiveResourceMetadata without re-downloading", async () => {
  const verifiedResource: ArchiveResourceMetadata = {
    resourceId: "22222222-2222-2222-2222-222222222222",
    sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    mediaType: "image/png",
    size: 4096,
  };

  let resolveCount = 0;
  let sourceDownloadCount = 0;
  let uploadCount = 0;

  const mockContext = {
    binId: "binny-test-bin",
    identityId: "test-identity",
    runId: "test-run",
    referenceTime: "2026-10-28T00:00:00.000Z",
    sourceAdapterVersion: "1.0.0",
    config: { origin: "https://linux.do" },
    signal: new AbortController().signal,
    resources: {
      async resolve(
        input: ArchiveResourceResolveRequest,
      ): Promise<ArchiveResourceResolveResult> {
        resolveCount += 1;
        assert.ok(
          input.immutableMediaUrls?.some((item) => item.url === immutableUrl1),
        );
        return {
          resources: [],
          items: [],
          mediaByUrl: { [immutableUrl1]: verifiedResource },
        };
      },
      async upload() {
        uploadCount += 1;
        throw new Error("不可变媒体已验证，不应上传");
      },
    },
    archive: {
      async submit() {
        throw new Error("未调用");
      },
    },
  } as unknown as SourceAdapterContext;

  const mockPage = createMockPage({
    html: `<p>回复配图：<img data-binny-media-index="0" src="${immutableUrl1}"></p>`,
    text: "回复配图",
    media: [
      {
        index: 0,
        kind: "image",
        url: immutableUrl1,
        path: "body.images[0]",
      },
    ],
  });

  const mockRequest = {
    async get() {
      sourceDownloadCount += 1;
      throw new Error("已验证的不可变媒体不应向源站发起源站媒体下载");
    },
  } as unknown as APIRequestContext;

  const mediaCache = new Map();

  const result = await archivePost(
    mockPage.page,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    {
      id: 300,
      title: "回复主题",
      slug: "reply-topic",
      category_id: 1,
      tags: [],
      post_stream: { posts: [] },
    },
    {
      id: 3002,
      post_number: 2,
      cooked: `<p>回复配图：<img src="${immutableUrl1}"></p>`,
      updated_at: "2026-10-28T02:00:00.000Z",
      version: 1,
      reply_to_post_number: 1,
    },
    [],
    mediaCache,
  );

  assert.equal(resolveCount, 1);
  assert.equal(sourceDownloadCount, 0);
  assert.equal(uploadCount, 0);
  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.deepEqual(result.state.resources, [
    { resourceId: verifiedResource.resourceId },
  ]);
  assert.ok(
    result.state.body?.markdown?.includes(
      `binny://resource/${verifiedResource.resourceId}`,
    ),
  );
  assert.deepEqual(result.state.metadata?.media, [
    { url: immutableUrl1, resourceId: verifiedResource.resourceId },
  ]);
});

void test("Mutable and non-hashed URLs on edited/new posts download normally from source server", async () => {
  let resolveCount = 0;
  let sourceDownloadCount = 0;
  let uploadCount = 0;

  const uploadedResource: ArchiveResourceMetadata = {
    resourceId: "33333333-3333-3333-3333-333333333333",
    sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    mediaType: "image/png",
    size: 512,
  };

  const mockContext = {
    binId: "binny-test-bin",
    identityId: "test-identity",
    runId: "test-run",
    referenceTime: "2026-10-28T00:00:00.000Z",
    sourceAdapterVersion: "1.0.0",
    config: { origin: "https://linux.do" },
    signal: new AbortController().signal,
    resources: {
      async resolve(input: ArchiveResourceResolveRequest) {
        resolveCount += 1;
        // Non-hashed URL should NOT be queried as immutable
        assert.equal(
          input.immutableMediaUrls?.some((item) => item.url === mutableUrl),
          false,
        );
        return { resources: [], items: [], mediaByUrl: {} };
      },
      async upload(body: BodyInit, mediaType: string) {
        uploadCount += 1;
        assert.equal(mediaType, "image/png");
        return { ok: true as const, resource: uploadedResource };
      },
    },
    archive: {
      async submit() {
        throw new Error("未调用");
      },
    },
  } as unknown as SourceAdapterContext;

  const mockPage = createMockPage(
    {
      html: `<p>编辑后的可变封面：<img data-binny-media-index="0" src="${mutableUrl}"></p>`,
      text: "编辑后的可变封面",
      media: [
        {
          index: 0,
          kind: "image",
          url: mutableUrl,
          path: "body.images[0]",
        },
      ],
    },
    {
      onFetch(href) {
        sourceDownloadCount += 1;
        assert.equal(href, mutableUrl);
      },
    },
  );

  const mockRequest = {
    async get(url: string) {
      sourceDownloadCount += 1;
      assert.equal(url, mutableUrl);
      return {
        status: () => 200,
        headers: () => ({ "content-type": "image/png" }),
        body: async () => Buffer.from([1, 2, 3, 4]),
      };
    },
  } as unknown as APIRequestContext;

  const mediaCache = new Map();

  const result = await archivePost(
    mockPage.page,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    {
      id: 400,
      title: "可变媒体主题",
      slug: "mutable-topic",
      category_id: 1,
      tags: [],
      post_stream: { posts: [] },
    },
    {
      id: 4001,
      post_number: 1,
      cooked: `<p>编辑后的可变封面：<img src="${mutableUrl}"></p>`,
      updated_at: "2026-10-28T03:00:00.000Z",
      version: 2,
      reply_to_post_number: null,
    },
    [],
    mediaCache,
  );

  assert.equal(sourceDownloadCount, 1);
  assert.equal(uploadCount, 1);
  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.deepEqual(result.state.resources, [
    { resourceId: uploadedResource.resourceId },
  ]);
  assert.ok(
    result.state.body?.markdown?.includes(
      `binny://resource/${uploadedResource.resourceId}`,
    ),
  );
  assert.deepEqual(result.state.metadata?.media, [
    { url: mutableUrl, resourceId: uploadedResource.resourceId },
  ]);
});

void test("When Core reports resource is missing or disk file unavailable, adapter falls back to normal download and upload", async () => {
  let sourceDownloadCount = 0;
  let uploadCount = 0;

  const freshlyUploadedResource: ArchiveResourceMetadata = {
    resourceId: "44444444-4444-4444-4444-444444444444",
    sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    mediaType: "image/png",
    size: 1000,
  };

  const mockContext = {
    binId: "binny-test-bin",
    identityId: "test-identity",
    runId: "test-run",
    referenceTime: "2026-10-28T00:00:00.000Z",
    sourceAdapterVersion: "1.0.0",
    config: { origin: "https://linux.do" },
    signal: new AbortController().signal,
    resources: {
      async resolve(): Promise<ArchiveResourceResolveResult> {
        // Core reports empty mediaByUrl (file missing on disk or not ready in DB)
        return {
          resources: [],
          items: [],
          mediaByUrl: {},
        };
      },
      async upload(body: BodyInit, mediaType: string) {
        uploadCount += 1;
        assert.equal(mediaType, "image/png");
        return { ok: true as const, resource: freshlyUploadedResource };
      },
    },
    archive: {
      async submit() {
        throw new Error("未调用");
      },
    },
  } as unknown as SourceAdapterContext;

  const mockPage = createMockPage(
    {
      html: `<p>缺失物理文件恢复：<img data-binny-media-index="0" src="${immutableUrl1}"></p>`,
      text: "缺失物理文件恢复",
      media: [
        {
          index: 0,
          kind: "image",
          url: immutableUrl1,
          path: "body.images[0]",
        },
      ],
    },
    {
      onFetch(href) {
        sourceDownloadCount += 1;
        assert.equal(href, immutableUrl1);
      },
    },
  );

  const mockRequest = {
    async get(url: string) {
      sourceDownloadCount += 1;
      assert.equal(url, immutableUrl1);
      return {
        status: () => 200,
        headers: () => ({ "content-type": "image/png" }),
        body: async () => Buffer.from([9, 8, 7, 6]),
      };
    },
  } as unknown as APIRequestContext;

  const mediaCache = new Map();

  const result = await archivePost(
    mockPage.page,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    {
      id: 500,
      title: "物理文件丢失恢复主题",
      slug: "recovery-topic",
      category_id: 1,
      tags: [],
      post_stream: { posts: [] },
    },
    {
      id: 5001,
      post_number: 1,
      cooked: `<p>缺失物理文件恢复：<img src="${immutableUrl1}"></p>`,
      updated_at: "2026-10-28T04:00:00.000Z",
      version: 1,
      reply_to_post_number: null,
    },
    [],
    mediaCache,
  );

  assert.equal(sourceDownloadCount, 1);
  assert.equal(uploadCount, 1);
  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.ok(
    result.state.body?.markdown?.includes(
      `binny://resource/${freshlyUploadedResource.resourceId}`,
    ),
  );
  assert.deepEqual(result.state.resources, [
    { resourceId: freshlyUploadedResource.resourceId },
  ]);
  assert.deepEqual(result.state.metadata?.media, [
    { url: immutableUrl1, resourceId: freshlyUploadedResource.resourceId },
  ]);
});

void test("Cross-origin external media downloads via request.get and uploads to storage", async () => {
  const externalUrl = "https://external-cdn.example.com/images/photo.png";
  let requestGetCount = 0;
  let uploadCount = 0;

  const uploadedResource: ArchiveResourceMetadata = {
    resourceId: "55555555-5555-5555-5555-555555555555",
    sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    mediaType: "image/png",
    size: 2000,
  };

  const mockContext = {
    binId: "binny-test-bin",
    identityId: "test-identity",
    runId: "test-run",
    referenceTime: "2026-10-28T00:00:00.000Z",
    sourceAdapterVersion: "1.0.0",
    config: { origin: "https://linux.do" },
    signal: new AbortController().signal,
    resources: {
      async resolve() {
        return { resources: [], items: [], mediaByUrl: {} };
      },
      async upload(body: BodyInit, mediaType: string) {
        uploadCount += 1;
        assert.equal(mediaType, "image/png");
        return { ok: true as const, resource: uploadedResource };
      },
    },
    archive: {
      async submit() {
        throw new Error("未调用");
      },
    },
  } as unknown as SourceAdapterContext;

  const mockPage = createMockPage({
    html: `<p>外链图片：<img data-binny-media-index="0" src="${externalUrl}"></p>`,
    text: "外链图片",
    media: [
      {
        index: 0,
        kind: "image",
        url: externalUrl,
        path: "body.images[0]",
      },
    ],
  });

  const mockRequest = {
    async get(url: string) {
      requestGetCount += 1;
      assert.equal(url, externalUrl);
      return {
        status: () => 200,
        headers: () => ({ "content-type": "image/png" }),
        body: async () => Buffer.from([1, 2, 3]),
      };
    },
  } as unknown as APIRequestContext;

  const mediaCache = new Map();

  const result = await archivePost(
    mockPage.page,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    {
      id: 600,
      title: "外链测试主题",
      slug: "external-topic",
      category_id: 1,
      tags: [],
      post_stream: { posts: [] },
    },
    {
      id: 6001,
      post_number: 1,
      cooked: `<p>外链图片：<img src="${externalUrl}"></p>`,
      updated_at: "2026-10-28T05:00:00.000Z",
      version: 1,
      reply_to_post_number: null,
    },
    [],
    mediaCache,
  );

  assert.equal(requestGetCount, 1);
  assert.equal(uploadCount, 1);
  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.ok(
    result.state.body?.markdown?.includes(
      `binny://resource/${uploadedResource.resourceId}`,
    ),
  );
  assert.deepEqual(result.state.resources, [
    { resourceId: uploadedResource.resourceId },
  ]);
  assert.deepEqual(result.state.metadata?.media, [
    { url: externalUrl, resourceId: uploadedResource.resourceId },
  ]);
});
