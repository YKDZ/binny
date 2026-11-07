import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  createSourceAdapterContext,
  isSourceAdapterActionError,
  type ArchiveResourceMetadata,
  type ArchiveSubmissionInput,
  type IncrementalSyncState,
  type SourceAdapterApiClient,
  type SourceAdapterContext,
  type SourceAdapterRunContext,
} from "@binny/source-adapter-sdk";

import {
  configSchema,
  DEFAULT_KIMI_CHANGELOG_SOURCES,
  DEFAULT_KIMI_RESEARCH_SOURCES,
  DEFAULT_KIMI_SOURCES,
  type KimiConfig,
} from "../src/index.ts";
import sourceAdapter from "../src/index.ts";

function createTestContext(
  config: KimiConfig,
  options?: {
    persistentState?: {
      load(): Promise<unknown>;
      save(state: unknown): Promise<void>;
    };
    signal?: AbortSignal;
  },
) {
  let commitSequence = 0;
  let resourceSequence = 0;
  const submissions: ArchiveSubmissionInput[] = [];
  const uploadedResources: ArchiveResourceMetadata[] = [];

  const mockClient = {
    archives: {
      async $post({ json }: { json: ArchiveSubmissionInput }) {
        submissions.push(json);
        return {
          status: 201 as const,
          json: async () => ({
            commitId: `commit-${++commitSequence}`,
            committedAt: "2026-11-07T00:00:00.000Z",
            itemCount: json.items.length,
            revisionCount: json.items.length,
          }),
        };
      },
    },
    resources: {
      async $post(
        { header }: { header: { "content-type": string } },
        init: { init: RequestInit },
      ) {
        const body = init.init.body as Blob;
        const resource: ArchiveResourceMetadata = {
          resourceId: `res-${++resourceSequence}`,
          mediaType: header["content-type"],
          size: body?.size ?? 128,
          sha256: `sha-${resourceSequence}`,
        };
        uploadedResources.push(resource);
        return {
          status: 201 as const,
          json: async () => resource,
        };
      },
      resolve: {
        async $post() {
          return {
            status: 200 as const,
            json: async () => ({
              resolved: [],
              missing: [],
            }),
          };
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  const runContext: SourceAdapterRunContext<KimiConfig> = {
    binId: "kimi-test-bin",
    identityId: "kimi-test-identity",
    runId: randomUUID(),
    referenceTime: "2026-11-07T12:00:00.000Z",
    sourceAdapterVersion: sourceAdapter.version,
    config,
    signal: options?.signal ?? new AbortController().signal,
    report: async () => {},
    ...(options?.persistentState !== undefined
      ? {
          persistentState: options.persistentState as unknown as NonNullable<
            SourceAdapterContext["persistentState"]
          >,
        }
      : {}),
  };

  const context = createSourceAdapterContext(mockClient, runContext);

  return { context, submissions, uploadedResources };
}

void test("Kimi platform changelogs source adapter actions and ongoing documents", async (t) => {
  let cnPlatformChangelogVersion = 1;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/docs/changelog/index.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      const v2Content =
        cnPlatformChangelogVersion >= 2
          ? "## 2026年11月\n\n- Kimi K2.5 模型深度推理发布。\n\n"
          : "";
      response.end(
        `---\ntitle: Kimi 开放平台更新日志\n---\n\n${v2Content}# 2026年10月\n\n- 支持 Kimi K2 模型流式输出与深度推理。\n- 开放 Function Calling 结构化输出能力。\n\n## 2026年9月\n\n- 开放平台基础能力正式上线。\n`,
      );
      return;
    }

    if (path === "/docs/platform-changelog.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      response.end(
        `# October 2026\n\n- Moonshot AI platform introduces global API endpoints.\n- Latency optimizations for context caching.\n\n# September 2026\n\n- Initial international developer platform release.\n`,
      );
      return;
    }

    if (path === "/docs/hosted-agents/changelog.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      response.end(
        `# Kimi Hosted Agents 更新日志\n\n## 2026-10-14\n\n- 支持长任务托管 Agent 自动恢复机制。\n- 优化了 Agent 会话保持与工具调用超时重试。\n\n## 2026-09-25\n\n- Hosted Agents Beta 内部测试版上线。\n`,
      );
      return;
    }

    if (path === "/docs/media-changelog.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      response.end(
        `# Kimi 带媒体更新日志\n\n## 2026-10-20\n\n架构图展示：\n\n![架构示意图](/media/arch.png)\n\n失效图片：\n\n![不存在图片](/media/missing.png)\n\n错误页伪装：\n\n![错误页图片](/media/error-page.png)\n`,
      );
      return;
    }

    if (path === "/media/arch.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      return;
    }

    if (path === "/media/error-page.png") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body>500 Internal Error</body></html>",
      );
      return;
    }

    if (path === "/docs/spa-shell.md") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!DOCTYPE html><html><head><title>SPA</title></head><body><div id="root"></div></body></html>',
      );
      return;
    }

    if (path === "/docs/empty.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      response.end("");
      return;
    }

    if (path === "/docs/500.md") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("Internal Server Error");
      return;
    }

    if (path === "/docs/403.md") {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Forbidden");
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const validConfig: KimiConfig = {
    sources: [
      {
        id: "cn-platform-changelog",
        kind: "changelog",
        region: "cn",
        language: "zh-CN",
        url: `${origin}/docs/changelog/index.md`,
        title: "Kimi 开放平台更新日志",
      },
      {
        id: "int-platform-changelog",
        kind: "changelog",
        region: "international",
        language: "en",
        url: `${origin}/docs/platform-changelog.md`,
        title: "Moonshot AI Platform Changelog",
      },
      {
        id: "cn-hosted-agents-changelog",
        kind: "changelog",
        region: "cn",
        language: "zh-CN",
        url: `${origin}/docs/hosted-agents/changelog.md`,
        title: "Kimi Hosted Agents 更新日志",
      },
    ],
  };

  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  await t.test(
    "check action reports availability and catches invalid sources",
    async () => {
      const { context } = createTestContext(validConfig);
      const result = await sourceAdapter.actions.check.execute(context, {});

      assert.equal(result.availability, "available");
      assert.deepEqual(result.scope, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      assert.equal(result.problems.length, 0);

      // Test with invalid sources (SPA shell, 500 error, 404)
      const invalidConfig: KimiConfig = {
        sources: [
          {
            id: "spa-source",
            kind: "changelog",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/docs/spa-shell.md`,
          },
          {
            id: "error-source",
            kind: "changelog",
            region: "international",
            language: "en",
            url: `${origin}/docs/500.md`,
          },
        ],
      };

      const { context: invalidCtx } = createTestContext(invalidConfig);
      const invalidResult = await sourceAdapter.actions.check.execute(
        invalidCtx,
        {},
      );
      assert.equal(invalidResult.availability, "unavailable");
      assert.equal(invalidResult.problems.length, 2);
      assert.equal(
        invalidResult.problems[0]?.code,
        "kimi_changelog_unavailable",
      );
      assert.equal(
        invalidResult.problems[1]?.code,
        "kimi_changelog_unavailable",
      );
    },
  );

  await t.test(
    "distinct sourceKeys, exact date precision, and clean Markdown without body.html",
    async () => {
      let storedState: IncrementalSyncState | undefined;
      const persistentState = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = state as IncrementalSyncState;
        },
      };

      const { context, submissions } = createTestContext(validConfig, {
        persistentState,
      });

      const collectResult = await sourceAdapter.actions.collect.execute(
        context,
        {},
      );
      assert.deepEqual(collectResult.completedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);

      assert.equal(submissions.length, 3);

      // Verify CN Platform Changelog
      const cnPlatformSub = submissions[0];
      assert.ok(cnPlatformSub !== undefined);
      assert.equal(cnPlatformSub.items.length, 1);
      const cnItem = cnPlatformSub.items[0];
      assert.ok(cnItem !== undefined);
      assert.deepEqual(cnItem.sourceKey, {
        namespace: "kimi:cn",
        key: "changelog:cn-platform-changelog",
      });
      assert.equal(cnItem.sourceRef, `${origin}/docs/changelog/index.md`);
      assert.equal(cnItem.properties?.["title"], "Kimi 开放平台更新日志");
      assert.equal(
        cnItem.sourceModifiedAt,
        undefined,
        "month precision date must not fabricate timestamp",
      );
      assert.equal(cnItem.metadata?.["documentKind"], "changelog");
      assert.equal(cnItem.metadata?.["region"], "cn");
      assert.equal(cnItem.metadata?.["language"], "zh-CN");
      assert.equal(cnItem.metadata?.["datePrecision"], "month");
      assert.equal(cnItem.metadata?.["latestDate"], "2026-10");
      assert.deepEqual(cnItem.metadata?.["observedDates"], [
        "2026-10",
        "2026-09",
      ]);
      assert.ok(cnItem.body?.markdown?.includes("Kimi K2"));
      assert.ok(cnItem.body?.text?.includes("Kimi K2"));
      assert.equal(
        (cnItem.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
        "must not produce body.html",
      );

      // Verify International Platform Changelog
      const intPlatformSub = submissions[1];
      assert.ok(intPlatformSub !== undefined);
      const intItem = intPlatformSub.items[0];
      assert.ok(intItem !== undefined);
      assert.deepEqual(intItem.sourceKey, {
        namespace: "kimi:international",
        key: "changelog:int-platform-changelog",
      });
      assert.equal(intItem.sourceRef, `${origin}/docs/platform-changelog.md`);
      assert.equal(
        intItem.sourceModifiedAt,
        undefined,
        "month precision date must not fabricate timestamp",
      );
      assert.equal(intItem.metadata?.["documentKind"], "changelog");
      assert.equal(intItem.metadata?.["region"], "international");
      assert.equal(intItem.metadata?.["language"], "en");
      assert.equal(intItem.metadata?.["datePrecision"], "month");
      assert.equal(intItem.metadata?.["latestDate"], "2026-10");
      assert.deepEqual(intItem.metadata?.["observedDates"], [
        "2026-10",
        "2026-09",
      ]);
      assert.equal(
        (intItem.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
      );

      // Verify CN Hosted Agents Changelog
      const hostedSub = submissions[2];
      assert.ok(hostedSub !== undefined);
      const hostedItem = hostedSub.items[0];
      assert.ok(hostedItem !== undefined);
      assert.deepEqual(hostedItem.sourceKey, {
        namespace: "kimi:cn",
        key: "changelog:cn-hosted-agents-changelog",
      });
      assert.equal(
        hostedItem.sourceRef,
        `${origin}/docs/hosted-agents/changelog.md`,
      );
      assert.equal(
        hostedItem.sourceModifiedAt,
        undefined,
        "day precision date must not fabricate timestamp",
      );
      assert.equal(hostedItem.metadata?.["documentKind"], "changelog");
      assert.equal(hostedItem.metadata?.["region"], "cn");
      assert.equal(hostedItem.metadata?.["language"], "zh-CN");
      assert.equal(hostedItem.metadata?.["datePrecision"], "day");
      assert.equal(hostedItem.metadata?.["latestDate"], "2026-10-14");
      assert.deepEqual(hostedItem.metadata?.["observedDates"], [
        "2026-10-14",
        "2026-09-25",
      ]);
      assert.equal(
        (hostedItem.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
      );

      // Source keys between CN and International must be strictly distinct
      assert.notEqual(cnItem.sourceKey.namespace, intItem.sourceKey.namespace);
      assert.notEqual(cnItem.sourceKey.key, intItem.sourceKey.key);
      assert.notEqual(hostedItem.sourceKey.key, cnItem.sourceKey.key);
    },
  );

  await t.test(
    "sync baseline, unchanged skip, and revision detection lifecycle",
    async () => {
      let storedState: IncrementalSyncState | undefined;
      const persistentState = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = state as IncrementalSyncState;
        },
      };

      // 1. First sync run on uninitialized state establishes baseline with 0 archive submissions
      const { context: ctx1, submissions: sub1 } = createTestContext(
        validConfig,
        {
          persistentState,
        },
      );
      const syncResult1 = await sourceAdapter.actions.sync.execute(ctx1, {});

      assert.equal(
        sub1.length,
        0,
        "first sync establishing baseline must make 0 archive submissions",
      );
      assert.deepEqual(syncResult1.completedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      assert.deepEqual(syncResult1.initializedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      assert.ok(storedState !== undefined);
      assert.ok(
        storedState.scopes["cn-platform-changelog"]?.ongoingDocuments?.[
          "cn-platform-changelog"
        ]?.contentHash,
      );

      // 2. Second sync run with unchanged content makes 0 archive submissions
      const { context: ctx2, submissions: sub2 } = createTestContext(
        validConfig,
        {
          persistentState,
        },
      );
      const syncResult2 = await sourceAdapter.actions.sync.execute(ctx2, {});

      assert.equal(
        sub2.length,
        0,
        "subsequent sync with unchanged content must make 0 archive submissions",
      );
      assert.deepEqual(syncResult2.completedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      assert.equal(syncResult2.initializedScopes, undefined);

      // 3. Edit changelog content on server and run third sync
      cnPlatformChangelogVersion = 2; // Server now serves 2026年11月 entry

      const { context: ctx3, submissions: sub3 } = createTestContext(
        validConfig,
        {
          persistentState,
        },
      );
      const syncResult3 = await sourceAdapter.actions.sync.execute(ctx3, {});

      assert.equal(
        sub3.length,
        1,
        "sync after content change must submit whole-page revision",
      );
      assert.deepEqual(syncResult3.completedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      const revisionItem = sub3[0]?.items[0];
      assert.ok(revisionItem !== undefined);
      assert.deepEqual(revisionItem.sourceKey, {
        namespace: "kimi:cn",
        key: "changelog:cn-platform-changelog",
      });
      assert.ok(revisionItem.body?.markdown?.includes("2026年11月"));
      assert.equal(revisionItem.metadata?.["latestDate"], "2026-11");
    },
  );

  await t.test(
    "collect archives referenced media and records partial media failures",
    async () => {
      const mediaConfig: KimiConfig = {
        sources: [
          {
            id: "media-changelog",
            kind: "changelog",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/docs/media-changelog.md`,
            title: "带媒体更新日志",
          },
        ],
      };

      const { context, submissions, uploadedResources } =
        createTestContext(mediaConfig);
      const result = await sourceAdapter.actions.collect.execute(context, {});

      assert.deepEqual(result.completedScopes, ["media-changelog"]);
      assert.equal(submissions.length, 1);
      assert.equal(
        uploadedResources.length,
        1,
        "successful image should be uploaded",
      );

      const item = submissions[0]?.items[0];
      assert.ok(item !== undefined);
      assert.ok(item.body?.markdown?.includes("binny://resource/res-1"));
      assert.equal(
        (item.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
      );

      // Missing array should record partial failures (404 missing.png, error-page.png)
      assert.ok(item.capture.missing.length >= 2);
      const missingUrls = item.capture.missing.map(
        (m: { readonly reason: string }) => m.reason,
      );
      assert.ok(
        missingUrls.some((r: string) => r.includes("/media/missing.png")),
      );
      assert.ok(
        missingUrls.some((r: string) => r.includes("/media/error-page.png")),
      );
    },
  );

  await t.test(
    "error handling does not advance state or create fallback summaries",
    async () => {
      let storedState: IncrementalSyncState | undefined;
      const persistentState = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = state as IncrementalSyncState;
        },
      };

      const failConfig: KimiConfig = {
        sources: [
          {
            id: "fail-403",
            kind: "changelog",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/docs/403.md`,
          },
        ],
      };

      const { context, submissions } = createTestContext(failConfig, {
        persistentState,
      });

      await assert.rejects(
        async () => sourceAdapter.actions.sync.execute(context, {}),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "kimi_sync_incomplete");
          return true;
        },
      );

      assert.equal(
        submissions.length,
        0,
        "failure must not create archive submissions",
      );
      assert.equal(
        storedState?.scopes["fail-403"],
        undefined,
        "failed scope must not establish or advance state",
      );

      await assert.rejects(
        async () => sourceAdapter.actions.collect.execute(context, {}),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "kimi_collection_incomplete");
          return true;
        },
      );
      assert.equal(submissions.length, 0);
    },
  );
});

void test("Kimi regional research articles source adapter actions and lifecycle", async (t) => {
  let cnZhVersion = 1;
  const requestedPaths: string[] = [];
  let detailK31Requests = 0;
  let detailK32Requests = 0;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    requestedPaths.push(path);

    // CN Chinese Blog list
    if (path === "/cn-zh/blog") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      const extraCard =
        cnZhVersion >= 2
          ? `<div class="card">
               <a href="/cn-zh/blog/kimi-k3-2" class="card-link" aria-label="Kimi K3.2">
                 <span class="card-title">Kimi K3.2</span>
                 <span class="card-date">2026-11-05</span>
               </a>
             </div>`
          : "";
      response.end(`<!doctype html>
<html>
<head><title>Kimi 研究</title></head>
<body>
  <main>
    <div class="card">
      <a href="/cn-zh/blog/kimi-k3-1-pro" class="card-link" aria-label="Kimi K3.1 Pro">
        <span class="card-title">Kimi K3.1 Pro</span>
        <span class="card-date">2026.10.25</span>
      </a>
    </div>
    <div class="card">
      <a href="https://github.com/MoonshotAI/Kimi-Dev" class="card-link">
        <span class="card-title">Kimi-Dev</span>
        <span class="card-date">2025-06-17</span>
      </a>
    </div>
    <div class="card">
      <a href="https://huggingface.co/moonshotai/Kimi-K2-Instruct-0905" class="card-link">
        <span class="card-title">Kimi-K2-Instruct-0905</span>
        <span class="card-date">2025-09-05</span>
      </a>
    </div>
    <div class="card">
      <a href="https://moonshotai.github.io/Kimi-Researcher/" class="card-link">
        <span class="card-title">Kimi-Researcher</span>
        <span class="card-date">2025-06-20</span>
      </a>
    </div>
    ${extraCard}
  </main>
</body>
</html>`);
      return;
    }

    // CN English Blog list
    if (path === "/cn-en/blog") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html>
<html>
<head><title>Kimi Research</title></head>
<body>
  <main>
    <div class="card">
      <a href="/cn-en/blog/kimi-k3-1-pro" class="card-link" aria-label="Kimi K3.1 Pro">
        <span class="card-title">Kimi K3.1 Pro</span>
        <span class="card-date">2026-10-25</span>
      </a>
    </div>
    <div class="card">
      <a href="https://github.com/MoonshotAI/Kimi-Dev" class="card-link">
        <span class="card-title">Kimi-Dev</span>
        <span class="card-date">2025-06-17</span>
      </a>
    </div>
  </main>
</body>
</html>`);
      return;
    }

    // International Blog list
    if (path === "/int/blog") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html>
<html>
<head><title>Moonshot AI Research</title></head>
<body>
  <main>
    <div class="card">
      <a href="/int/blog/kimi-k3-1-pro" class="card-link" aria-label="Kimi K3.1 Pro">
        <span class="card-title">Kimi K3.1 Pro</span>
        <span class="card-date">2026-10-25</span>
      </a>
    </div>
  </main>
</body>
</html>`);
      return;
    }

    // CN Chinese article detail
    if (path === "/cn-zh/blog/kimi-k3-1-pro") {
      detailK31Requests++;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html>
<html>
<head>
  <title>Kimi K3.1 Pro | Kimi</title>
  <link rel="canonical" href="https://www.kimi.ai/blog/kimi-k3-1-pro" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Kimi K3.1 Pro 技术博客",
    "dateModified": "2026-10-28"
  }
  </script>
</head>
<body>
  <header>Global Header</header>
  <nav class="lang-switch"><a href="/cn-en/blog">English</a></nav>
  <main>
    <div class="BlogV2MiniNav-module__miniNav">Mini Nav</div>
    <h1>Kimi K3.1 Pro 技术博客</h1>
    <p>Kimi K3.1 Pro 是我们最新的 3T 级开源权重模型，支持 100 万 token 上下文。</p>
    <p>相关链接：<a href="https://github.com/ashemag/human-atlas">Human Atlas</a>、<a href="https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017">DeepSeek 比较</a> 与 <a href="https://www.swe-marathon.org/">SWE Marathon 评测</a>。</p>
  </main>
  <footer>Global Footer</footer>
</body>
</html>`);
      return;
    }

    // CN English article detail
    if (path === "/cn-en/blog/kimi-k3-1-pro") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html>
<html>
<head>
  <title>Kimi K3.1 Pro English | Kimi</title>
  <link rel="canonical" href="https://www.kimi.ai/blog/kimi-k3-1-pro" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Kimi K3.1 Pro Technical Blog",
    "dateModified": "2026-10-28"
  }
  </script>
</head>
<body>
  <main>
    <h1>Kimi K3.1 Pro Technical Blog</h1>
    <p>English article on CN site with 1M token context.</p>
  </main>
</body>
</html>`);
      return;
    }

    // International article detail
    if (path === "/int/blog/kimi-k3-1-pro") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html>
<html>
<head>
  <title>Moonshot AI Kimi K3.1 Pro | Moonshot AI</title>
  <link rel="canonical" href="https://www.kimi.ai/blog/kimi-k3-1-pro" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Moonshot AI Kimi K3.1 Pro",
    "dateModified": "2026-10-28"
  }
  </script>
</head>
<body>
  <main>
    <h1>Moonshot AI Kimi K3.1 Pro</h1>
    <p>International article on kimi.ai with global availability.</p>
  </main>
</body>
</html>`);
      return;
    }

    // Article 2 for sync tests
    if (path === "/cn-zh/blog/kimi-k3-2") {
      detailK32Requests++;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html>
<html>
<head>
  <title>Kimi K3.2 | Kimi</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Kimi K3.2 发布",
    "dateModified": "2026-11-06"
  }
  </script>
</head>
<body>
  <main>
    <h1>Kimi K3.2 发布</h1>
    <p>进一步提升多模态与数学推理能力。</p>
  </main>
</body>
</html>`);
      return;
    }

    // Failure routes
    if (path === "/fail/500/blog") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        `<!doctype html><html><body><main><div class="card"><a href="/fail/500/blog/kimi-500"><span class="card-title">Fail 500</span></a></div></main></body></html>`,
      );
      return;
    }

    if (path === "/fail/500/blog/kimi-500") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("Internal Server Error");
      return;
    }

    if (path === "/fail/spa/blog") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        `<!doctype html><html><body><main><div class="card"><a href="/fail/spa/blog/kimi-spa"><span class="card-title">Fail SPA</span></a></div></main></body></html>`,
      );
      return;
    }

    if (path === "/fail/spa/blog/kimi-spa") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        `<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div></body></html>`,
      );
      return;
    }

    if (path === "/fail/empty/blog") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html><html><body><main></main></body></html>`);
      return;
    }

    if (path === "/fail/404/blog") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not Found");
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  t.after(() => {
    server.close();
  });

  await t.test(
    "default configuration includes both changelogs and research sources",
    () => {
      const parsed = configSchema.parse({});
      assert.equal(parsed.sources.length, 6);
      assert.equal(DEFAULT_KIMI_CHANGELOG_SOURCES.length, 3);
      assert.equal(DEFAULT_KIMI_RESEARCH_SOURCES.length, 3);
      assert.equal(DEFAULT_KIMI_SOURCES.length, 6);
      const sourceIds = parsed.sources.map((s) => s.id);
      assert.deepEqual(sourceIds, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
        "cn-research-zh",
        "cn-research-en",
        "int-research",
      ]);
    },
  );

  await t.test(
    "check action validates research blog list and sample article",
    async () => {
      const checkConfig: KimiConfig = {
        sources: [
          {
            id: "cn-research-zh",
            kind: "research",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/cn-zh/blog`,
          },
          {
            id: "fail-404",
            kind: "research",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/fail/404/blog`,
          },
        ],
      };
      const { context } = createTestContext(checkConfig);
      const result = await sourceAdapter.actions.check.execute(context, {
        sourceIds: ["cn-research-zh"],
      });
      assert.equal(result.availability, "available");
      assert.equal(result.problems.length, 0);

      const failResult = await sourceAdapter.actions.check.execute(context, {
        sourceIds: ["fail-404"],
      });
      assert.equal(failResult.availability, "unavailable");
      assert.ok(
        failResult.problems.some((p) => p.code === "kimi_research_unavailable"),
      );
    },
  );

  await t.test(
    "independent sourceKeys and separate canonicalUrl without cross-domain identity merge",
    async () => {
      const multiRegionConfig: KimiConfig = {
        sources: [
          {
            id: "cn-research-zh",
            kind: "research",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/cn-zh/blog`,
          },
          {
            id: "cn-research-en",
            kind: "research",
            region: "cn",
            language: "en",
            url: `${origin}/cn-en/blog`,
          },
          {
            id: "int-research",
            kind: "research",
            region: "international",
            language: "en",
            url: `${origin}/int/blog`,
          },
        ],
      };
      const { context, submissions } = createTestContext(multiRegionConfig);
      const collectResult = await sourceAdapter.actions.collect.execute(
        context,
        {},
      );
      assert.equal(collectResult.completedScopes.length, 3);
      assert.equal(submissions.length, 3);

      const zhItem = submissions.find(
        (s) => s.items[0]?.metadata?.["language"] === "zh-CN",
      )?.items[0];
      const cnEnItem = submissions.find(
        (s) =>
          s.items[0]?.metadata?.["region"] === "cn" &&
          s.items[0]?.metadata?.["language"] === "en",
      )?.items[0];
      const intEnItem = submissions.find(
        (s) => s.items[0]?.metadata?.["region"] === "international",
      )?.items[0];

      assert.ok(zhItem && cnEnItem && intEnItem);

      // Distinct sourceKeys
      assert.deepEqual(zhItem.sourceKey, {
        namespace: "kimi:cn:zh-CN",
        key: "research:kimi-k3-1-pro",
      });
      assert.deepEqual(cnEnItem.sourceKey, {
        namespace: "kimi:cn:en",
        key: "research:kimi-k3-1-pro",
      });
      assert.deepEqual(intEnItem.sourceKey, {
        namespace: "kimi:international:en",
        key: "research:kimi-k3-1-pro",
      });

      // sourceRefs retain actual fetched URLs, never overwritten by canonical
      assert.equal(zhItem.sourceRef, `${origin}/cn-zh/blog/kimi-k3-1-pro`);
      assert.equal(cnEnItem.sourceRef, `${origin}/cn-en/blog/kimi-k3-1-pro`);
      assert.equal(intEnItem.sourceRef, `${origin}/int/blog/kimi-k3-1-pro`);

      // Observed canonicalUrl preserved as fact in metadata
      assert.equal(
        zhItem.metadata?.["canonicalUrl"],
        "https://www.kimi.ai/blog/kimi-k3-1-pro",
      );
      assert.equal(
        cnEnItem.metadata?.["canonicalUrl"],
        "https://www.kimi.ai/blog/kimi-k3-1-pro",
      );
      assert.equal(
        intEnItem.metadata?.["canonicalUrl"],
        "https://www.kimi.ai/blog/kimi-k3-1-pro",
      );
    },
  );

  await t.test(
    "external project cards are not recursively fetched while in-site article reference links are preserved",
    async () => {
      requestedPaths.length = 0;
      const testConfig: KimiConfig = {
        sources: [
          {
            id: "cn-research-zh",
            kind: "research",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/cn-zh/blog`,
          },
        ],
      };
      const { context, submissions } = createTestContext(testConfig);
      await sourceAdapter.actions.collect.execute(context, {});

      // Exactly 1 in-site article submitted
      assert.equal(submissions.length, 1);
      const item = submissions[0]?.items[0];
      assert.ok(item !== undefined);

      // Server never received external requests to github or huggingface
      assert.ok(
        !requestedPaths.some(
          (p) => p.includes("github.com") || p.includes("huggingface.co"),
        ),
      );

      // No body.html in submission
      assert.equal(
        (item.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
      );

      // In-site article markdown preserves reference links to GitHub, HuggingFace, and benchmark papers
      const markdown = item.body?.markdown ?? "";
      assert.ok(markdown.includes("https://github.com/ashemag/human-atlas"));
      assert.ok(
        markdown.includes(
          "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017",
        ),
      );
      assert.ok(markdown.includes("https://www.swe-marathon.org/"));
    },
  );

  await t.test(
    "list card publication date and detail page dateModified are preserved separately at day precision",
    async () => {
      const testConfig: KimiConfig = {
        sources: [
          {
            id: "cn-research-zh",
            kind: "research",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/cn-zh/blog`,
          },
        ],
      };
      const { context, submissions } = createTestContext(testConfig);
      await sourceAdapter.actions.collect.execute(context, {});
      const item = submissions[0]?.items[0];
      assert.ok(item !== undefined);

      // List card publication date normalized from 2026.10.25 to 2026-10-25
      assert.equal(item.metadata?.["publishedDate"], "2026-10-25");
      // Detail page JSON-LD dateModified preserved separately
      assert.equal(item.metadata?.["modifiedDate"], "2026-10-28");
      assert.equal(item.metadata?.["datePrecision"], "day");
      assert.notEqual(
        item.metadata?.["publishedDate"],
        item.metadata?.["modifiedDate"],
      );

      // sourceModifiedAt is undefined when date precision is day-only
      assert.equal(item.sourceModifiedAt, undefined);
    },
  );

  await t.test(
    "sync baseline, unchanged skip, subsequent new articles, and failure handling",
    async () => {
      let storedState: IncrementalSyncState | undefined;
      const persistentState = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = state as IncrementalSyncState;
        },
      };

      const syncConfig: KimiConfig = {
        sources: [
          {
            id: "cn-research-zh",
            kind: "research",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/cn-zh/blog`,
          },
        ],
      };

      // 1. First sync establishes baseline: 0 detail page requests, 0 archive submissions
      detailK31Requests = 0;
      detailK32Requests = 0;
      const { context: context1, submissions: submissions1 } =
        createTestContext(syncConfig, { persistentState });
      const syncOutput1 = await sourceAdapter.actions.sync.execute(
        context1,
        {},
      );
      assert.deepEqual(syncOutput1.initializedScopes, ["cn-research-zh"]);
      assert.deepEqual(syncOutput1.completedScopes, ["cn-research-zh"]);
      assert.equal(
        submissions1.length,
        0,
        "first sync baseline must not commit articles",
      );
      assert.equal(
        detailK31Requests,
        0,
        "first sync baseline must not fetch detail pages",
      );

      const entry =
        storedState?.scopes["cn-research-zh"]?.entries["kimi-k3-1-pro"];
      assert.ok(entry !== undefined);
      assert.equal(entry.archivedCompleteness, "baseline");
      assert.equal(entry.publishedAt, "2026-10-25");

      // 2. Subsequent sync without changes: 0 detail page requests, 0 archive submissions
      const { context: context2, submissions: submissions2 } =
        createTestContext(syncConfig, { persistentState });
      const syncOutput2 = await sourceAdapter.actions.sync.execute(
        context2,
        {},
      );
      assert.deepEqual(syncOutput2.completedScopes, ["cn-research-zh"]);
      assert.equal(
        submissions2.length,
        0,
        "unchanged sync must not commit articles",
      );
      assert.equal(
        detailK31Requests,
        0,
        "unchanged sync must not fetch detail pages",
      );

      // 3. Subsequent sync with new article added to list: only new article detail fetched and committed
      cnZhVersion = 2; // enables kimi-k3-2
      const { context: context3, submissions: submissions3 } =
        createTestContext(syncConfig, { persistentState });
      const syncOutput3 = await sourceAdapter.actions.sync.execute(
        context3,
        {},
      );
      assert.deepEqual(syncOutput3.completedScopes, ["cn-research-zh"]);
      assert.equal(
        submissions3.length,
        1,
        "only the newly added article is committed",
      );
      assert.equal(
        submissions3[0]?.items[0]?.sourceKey.key,
        "research:kimi-k3-2",
      );
      assert.equal(
        detailK31Requests,
        0,
        "existing article detail page must not be fetched",
      );
      assert.equal(
        detailK32Requests,
        1,
        "new article detail page must be fetched exactly once",
      );

      const entry2 =
        storedState?.scopes["cn-research-zh"]?.entries["kimi-k3-2"];
      assert.ok(entry2 !== undefined);
      assert.equal(entry2.archivedCompleteness, "complete");

      // 4. Failure handling when detail page returns 500 or SPA shell
      const failConfig: KimiConfig = {
        sources: [
          {
            id: "fail-500",
            kind: "research",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/fail/500/blog`,
          },
        ],
      };
      const { context: failContext, submissions: failSubmissions } =
        createTestContext(failConfig, { persistentState });
      await assert.rejects(
        async () => sourceAdapter.actions.collect.execute(failContext, {}),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "kimi_collection_incomplete");
          return true;
        },
      );
      assert.equal(
        failSubmissions.length,
        0,
        "failure must not produce partial archive submissions",
      );
      assert.equal(
        storedState?.scopes["fail-500"],
        undefined,
        "failure must not advance scope state",
      );

      const failSpaConfig: KimiConfig = {
        sources: [
          {
            id: "fail-spa",
            kind: "research",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/fail/spa/blog`,
          },
        ],
      };
      const { context: failSpaContext, submissions: failSpaSubmissions } =
        createTestContext(failSpaConfig, { persistentState });
      await assert.rejects(
        async () => sourceAdapter.actions.collect.execute(failSpaContext, {}),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "kimi_collection_incomplete");
          return true;
        },
      );
      assert.equal(failSpaSubmissions.length, 0);
      assert.equal(storedState?.scopes["fail-spa"], undefined);
    },
  );

  await t.test("collect with itemUrls and maxItems filter", async () => {
    const filterConfig: KimiConfig = {
      sources: [
        {
          id: "cn-research-zh",
          kind: "research",
          region: "cn",
          language: "zh-CN",
          url: `${origin}/cn-zh/blog`,
        },
      ],
    };
    const { context, submissions } = createTestContext(filterConfig);
    await sourceAdapter.actions.collect.execute(context, {
      itemUrls: [`${origin}/cn-zh/blog/kimi-k3-1-pro`],
      maxItems: 1,
    });
    assert.equal(submissions.length, 1);
    assert.equal(
      submissions[0]?.items[0]?.sourceKey.key,
      "research:kimi-k3-1-pro",
    );
  });
});
