import assert from "node:assert/strict";
import test from "node:test";

import type { ArchiveResourceMetadata } from "@binny/source-adapter-sdk";
import type { APIRequestContext, Page } from "patchright-core";

import {
  archivePost,
  bindPageSourceAccessForTest,
} from "../src/source-adapter.ts";

const siteOrigin = new URL("https://linux.do");
const siteNamespace = "linuxdo";

function createMockEnvironment(options?: {
  fetchHandler?: (href: string) => {
    status: number;
    contentType: string;
    body: Buffer;
  };
}) {
  let resourceCounter = 0;
  const uploadedResources = new Map<string, ArchiveResourceMetadata>();

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
      async upload(blob: Blob, mediaType: string) {
        resourceCounter += 1;
        const resourceId = `res-${String(resourceCounter).padStart(4, "0")}`;
        const metadata: ArchiveResourceMetadata = {
          resourceId,
          sha256: "0".repeat(63) + String(resourceCounter),
          mediaType,
          size: blob.size,
        };
        uploadedResources.set(resourceId, metadata);
        return { ok: true as const, resource: metadata };
      },
    },
    archive: {
      async submit() {
        throw new Error("archive.submit should not be called directly");
      },
    },
  } as unknown as Parameters<typeof archivePost>[2];

  const mockPage = {
    url() {
      return "https://linux.do";
    },
    isClosed() {
      return false;
    },
    async evaluate(_fn: unknown, arg: unknown) {
      if (arg && typeof arg === "object" && "href" in arg) {
        const fetchArg = arg as { href: string; bodyType: "text" | "base64" };
        const response = options?.fetchHandler?.(fetchArg.href) ?? {
          status: 200,
          contentType: "image/png",
          body: Buffer.from([1, 2, 3, 4]),
        };
        return {
          status: response.status,
          contentType: response.contentType,
          body: response.body.toString("base64"),
          bodyType: fetchArg.bodyType,
        };
      }
      return {};
    },
  } as unknown as Page;

  bindPageSourceAccessForTest(mockPage, "https://linux.do");

  const mockRequest = {
    async get() {
      throw new Error("External request.get not expected");
    },
  } as unknown as APIRequestContext;

  return { mockContext, mockPage, mockRequest, uploadedResources };
}

const defaultTopic = {
  id: 10,
  title: "Linux.do 正文清洗测试主题",
  slug: "clean-content-test",
  category_id: 1,
  tags: ["test"],
  post_stream: { posts: [] },
};

void test("archivePost cleans Discourse aside.quote and standard blockquote", async () => {
  const { mockContext, mockPage, mockRequest } = createMockEnvironment();
  const mediaCache = new Map();

  const cooked = `
    <aside class="quote" data-post="1" data-topic="10">
      <div class="title">
        <div class="quote-controls"></div>
        <img class="avatar" src="/user_avatar/user1.png" alt=""> alice:
      </div>
      <blockquote>
        <p>这是被引用的原帖内容第一行<br>这是被引用的第二行</p>
      </blockquote>
    </aside>
    <blockquote>
      <p>这是标准 blockquote 引用</p>
    </blockquote>
    <p>回复正文。</p>
  `;

  const result = await archivePost(
    mockPage,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    defaultTopic,
    {
      id: 10001,
      post_number: 1,
      cooked,
      updated_at: "2026-10-28T00:00:00.000Z",
      version: 1,
      reply_to_post_number: null,
    },
    [],
    mediaCache,
  );

  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.match(result.state.body?.markdown ?? "", /> \*\*alice:\*\*/u);
  assert.match(
    result.state.body?.markdown ?? "",
    /> 这是被引用的原帖内容第一行/u,
  );
  assert.match(
    result.state.body?.markdown ?? "",
    /> 这是标准 blockquote 引用/u,
  );
  assert.match(result.state.body?.markdown ?? "", /回复正文。/u);
});

void test("archivePost preserves <pre><code> with multi-line code indentation and language", async () => {
  const { mockContext, mockPage, mockRequest } = createMockEnvironment();
  const mediaCache = new Map();

  const cooked = `
    <p>代码示例：</p>
    <pre><code class="lang-typescript">function add(a: number, b: number): number {
  const sum = a + b;
  return sum;
}</code></pre>
  `;

  const result = await archivePost(
    mockPage,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    defaultTopic,
    {
      id: 10002,
      post_number: 2,
      cooked,
      updated_at: "2026-10-28T01:00:00.000Z",
      version: 1,
      reply_to_post_number: 1,
    },
    [],
    mediaCache,
  );

  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.match(
    result.state.body?.markdown ?? "",
    /```typescript\nfunction add\(a: number, b: number\): number \{\n  const sum = a \+ b;\n  return sum;\n\}\n```/u,
  );
});

void test("archivePost preserves GFM <table> formatting", async () => {
  const { mockContext, mockPage, mockRequest } = createMockEnvironment();
  const mediaCache = new Map();

  const cooked = `
    <table>
      <thead>
        <tr><th>指标</th><th>基准</th><th>实际</th></tr>
      </thead>
      <tbody>
        <tr><td>延迟</td><td>50ms</td><td>32ms</td></tr>
        <tr><td>吞吐</td><td>1000</td><td>1250</td></tr>
      </tbody>
    </table>
  `;

  const result = await archivePost(
    mockPage,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    defaultTopic,
    {
      id: 10003,
      post_number: 3,
      cooked,
      updated_at: "2026-10-28T02:00:00.000Z",
      version: 1,
      reply_to_post_number: 1,
    },
    [],
    mediaCache,
  );

  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.match(
    result.state.body?.markdown ?? "",
    /\| 指标 \| 基准 \| 实际 \|/u,
  );
  assert.match(result.state.body?.markdown ?? "", /\| --- \| --- \| --- \|/u);
  assert.match(
    result.state.body?.markdown ?? "",
    /\| 延迟 \| 50ms \| 32ms \|/u,
  );
  assert.match(
    result.state.body?.markdown ?? "",
    /\| 吞吐 \| 1000 \| 1250 \|/u,
  );
});

void test("archivePost preserves <details><summary> folded content", async () => {
  const { mockContext, mockPage, mockRequest } = createMockEnvironment();
  const mediaCache = new Map();

  const cooked = `
    <details>
      <summary>点击查看排查详情</summary>
      <p>折叠的内部诊断日志第一条</p>
      <p>折叠的内部诊断日志第二条</p>
    </details>
  `;

  const result = await archivePost(
    mockPage,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    defaultTopic,
    {
      id: 10004,
      post_number: 4,
      cooked,
      updated_at: "2026-10-28T03:00:00.000Z",
      version: 1,
      reply_to_post_number: 1,
    },
    [],
    mediaCache,
  );

  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.match(
    result.state.body?.markdown ?? "",
    /<details>\n<summary>点击查看排查详情<\/summary>\n\n折叠的内部诊断日志第一条\n\n折叠的内部诊断日志第二条\n\n<\/details>/u,
  );
});

void test("archivePost rewrites lightbox original image without duplicating as attachment or leaking div.meta", async () => {
  const { mockContext, mockPage, mockRequest } = createMockEnvironment({
    fetchHandler(href) {
      if (href.endsWith("photo-orig.png")) {
        return {
          status: 200,
          contentType: "image/png",
          body: Buffer.from([1, 2, 3]),
        };
      }
      throw new Error(`Unexpected fetch for ${href}`);
    },
  });
  const mediaCache = new Map();

  const cooked = `
    <div class="lightbox-wrapper">
      <a class="lightbox" href="/uploads/photo-orig.png" title="大图展示" data-download-href="/uploads/photo-download">
        <picture>
          <source srcset="/uploads/photo-small.webp 1x, /uploads/photo-large.webp 2x" type="image/webp">
          <img src="/uploads/photo-thumb.png" alt="架构拓扑图" srcset="/uploads/photo-small.webp 1x, /uploads/photo-large.webp 2x">
        </picture>
        <div class="meta">
          <span class="filename">topology.png</span>
          <span class="informations">1920×1080 340 KB</span>
        </div>
      </a>
    </div>
  `;

  const result = await archivePost(
    mockPage,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    defaultTopic,
    {
      id: 10005,
      post_number: 5,
      cooked,
      updated_at: "2026-10-28T04:00:00.000Z",
      version: 1,
      reply_to_post_number: 1,
    },
    [],
    mediaCache,
  );

  assert.equal(result.complete, true);
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );
  assert.equal(result.state.resources?.length, 1);
  const resourceId = result.state.resources?.[0]?.resourceId;
  assert.ok(resourceId !== undefined);

  assert.match(
    result.state.body?.markdown ?? "",
    new RegExp(`!\\[架构拓扑图\\]\\(binny://resource/${resourceId}\\)`, "u"),
  );
  // Ensure thumbnail, download hash, dimensions, and attachment duplication are NOT present
  assert.ok(!result.state.body?.markdown?.includes("photo-thumb.png"));
  assert.ok(!result.state.body?.markdown?.includes("photo-download"));
  assert.ok(!result.state.body?.markdown?.includes("1920×1080"));
  assert.ok(!result.state.body?.markdown?.includes("340 KB"));
  assert.ok(!result.state.body?.markdown?.includes("附件："));
});

void test("archivePost archives genuine JSON/HTML attachments and reports challenge and 503 errors in missing & diagnostics", async () => {
  const jsonPath = "/uploads/report.json";
  const htmlPath = "/uploads/benchmark.html";
  const challengePath = "/uploads/login-challenge.html";
  const failingImagePath = "/uploads/broken.png";

  const { mockContext, mockPage, mockRequest } = createMockEnvironment({
    fetchHandler(href) {
      if (href.endsWith(jsonPath)) {
        return {
          status: 200,
          contentType: "application/json; charset=utf-8",
          body: Buffer.from(JSON.stringify({ status: "success", count: 42 })),
        };
      }
      if (href.endsWith(htmlPath)) {
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: Buffer.from(
            "<!doctype html><html><head><title>基准测试报告</title></head><body><h1>报告正文</h1></body></html>",
          ),
        };
      }
      if (href.endsWith(challengePath)) {
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: Buffer.from(
            "<!doctype html><html><title>登录挑战</title></html>",
          ),
        };
      }
      if (href.endsWith(failingImagePath)) {
        return {
          status: 503,
          contentType: "text/plain; charset=utf-8",
          body: Buffer.from("Service Unavailable"),
        };
      }
      throw new Error(`Unexpected URL requested: ${href}`);
    },
  });
  const mediaCache = new Map();

  const cooked = `
    <p>附件列表与配图：</p>
    <p><a class="attachment" href="${jsonPath}">性能数据.json</a></p>
    <p><a class="attachment" href="${htmlPath}">基准测试报告.html</a></p>
    <p><a class="attachment" href="${challengePath}">受限附件.html</a></p>
    <p><img src="${failingImagePath}" alt="故障配图"></p>
  `;

  const result = await archivePost(
    mockPage,
    mockRequest,
    mockContext,
    siteOrigin,
    siteNamespace,
    defaultTopic,
    {
      id: 10006,
      post_number: 6,
      cooked,
      updated_at: "2026-10-28T05:00:00.000Z",
      version: 1,
      reply_to_post_number: 1,
    },
    [],
    mediaCache,
  );

  assert.equal(result.complete, false);
  assert.equal(result.state.capture.completeness, "partial");
  assert.equal(
    (result.state.body as { html?: string } | undefined)?.html,
    undefined,
  );

  // 2 successful attachments: JSON and HTML
  assert.equal(result.state.resources?.length, 2);

  const markdown = result.state.body?.markdown ?? "";
  assert.match(markdown, /\[性能数据\.json\]\(binny:\/\/resource\/res-0001\)/u);
  assert.match(
    markdown,
    /\[基准测试报告\.html\]\(binny:\/\/resource\/res-0002\)/u,
  );
  // Challenge attachment was not rewritten to binny://resource
  assert.ok(!markdown.includes("binny://resource/res-0003"));
  // 503 image was not rewritten
  assert.match(
    markdown,
    /!\[故障配图\]\(https:\/\/linux\.do\/uploads\/broken\.png\)/u,
  );

  // Missing candidates
  assert.ok(
    result.state.capture.missing.some(
      ({ path, reason }) =>
        path === "body.attachments[2]" && reason === "媒体资源未能归档。",
    ),
  );
  assert.ok(
    result.state.capture.missing.some(
      ({ path, reason }) =>
        path === "body.images[0]" && reason === "媒体资源未能归档。",
    ),
  );

  // Diagnostics
  const challengeDiag = result.state.diagnostics?.find(
    (d) => d.details?.path === "body.attachments[2]",
  );
  assert.ok(challengeDiag !== undefined);
  assert.equal(challengeDiag.code, "linuxdo_media_unavailable");
  assert.ok(challengeDiag.message.includes("页面"));

  const img503Diag = result.state.diagnostics?.find(
    (d) => d.details?.path === "body.images[0]",
  );
  assert.ok(img503Diag !== undefined);
  assert.equal(img503Diag.code, "linuxdo_media_unavailable");
  assert.ok(img503Diag.message.includes("503"));
});
