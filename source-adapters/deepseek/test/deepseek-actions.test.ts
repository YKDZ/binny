import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
  sourceAdapter,
  type DeepSeekConfig,
} from "../src/index.ts";
import {
  executeDeepSeekCheck,
  executeDeepSeekCollect,
  executeDeepSeekSync,
  extractNewsSlug,
  isHomepageFallback,
  normalizeDate,
} from "../src/source-adapter.ts";

function createTestContext(
  config: DeepSeekConfig,
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

  const runContext: SourceAdapterRunContext<DeepSeekConfig> = {
    binId: "deepseek-test-bin",
    identityId: "deepseek-test-identity",
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

  const context = createSourceAdapterContext(
    mockClient,
    runContext,
    sourceAdapter.extensionsSchema,
  );

  return { context, submissions, uploadedResources };
}

void test("DeepSeek source adapter unit and action tests", async (t) => {
  let updatesVersion = 1;
  const requestCounts = new Map<string, number>();

  function trackRequest(path: string) {
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
  }

  function getRequestCount(path: string): number {
    return requestCounts.get(path) ?? 0;
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    trackRequest(path);

    if (path === "/zh-cn/updates.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      const newSection =
        updatesVersion >= 2
          ? "## 2026-11-01\n- DeepSeek-R2 Preview 正式上线，详见 [DeepSeek-R2 预览公告](/zh-cn/news/news261101)。\n\n"
          : "";
      res.end(
        `# DeepSeek API 更新日志\n\n${newSection}## 2026-10-20\n- 发布 DeepSeek-V3.5，详见 [发布新闻](/zh-cn/news/news261020)。\n- 优化提示词缓存与流式推理性能。\n\n| 模型 | 输入价格 (每百万 token) | 输出价格 (每百万 token) |\n| --- | --- | --- |\n| deepseek-chat | 1 元 | 2 元 |\n\n\`\`\`python\nfrom openai import OpenAI\nclient = OpenAI(api_key="...", base_url="https://api.deepseek.com")\n\`\`\`\n\n## 2026-05-28\n- 模型定价调整，详见 [定价说明](/zh-cn/news/news250528)。\n`,
      );
      return;
    }

    if (path === "/updates.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      const newSection =
        updatesVersion >= 2
          ? "## 2026-11-01\n- DeepSeek-R2 Preview is released. See [DeepSeek-R2 Announcement](/news/news261101).\n\n"
          : "";
      res.end(
        `# DeepSeek API Updates\n\n${newSection}## 2026-10-20\n- DeepSeek-V3.5 is now generally available. See [Announcement](/news/news261020).\n- Improved prompt caching and streaming performance.\n\n| Model | Input Price | Output Price |\n| --- | --- | --- |\n| deepseek-chat | $0.14 | $0.28 |\n\n\`\`\`python\nfrom openai import OpenAI\nclient = OpenAI(api_key="...", base_url="https://api.deepseek.com")\n\`\`\`\n\n## 2026-05-28\n- Price reduction for API tokens. See [Details](/news/news250528).\n`,
      );
      return;
    }

    if (path === "/zh-cn/news/news261020.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(
        `---\ntitle: DeepSeek-V3.5 正式发布\ndate: "2026-10-20T17:30:00+08:00"\n---\n\n# DeepSeek-V3.5 正式发布\n\n我们很高兴宣布 DeepSeek-V3.5 模型正式上线。\n\n\`\`\`python\n# Sample code\nresponse = client.chat.completions.create(model="deepseek-chat")\n\`\`\`\n\n![架构图](/images/architecture.png)\n`,
      );
      return;
    }

    if (path === "/news/news261020.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(
        `# DeepSeek-V3.5 Official Announcement\n\nDate: 2026-10-20\n\nDeepSeek-V3.5 is now generally available.\n\n\`\`\`python\n# Sample code\nresponse = client.chat.completions.create(model="deepseek-chat")\n\`\`\`\n\n![Architecture Diagram](/images/architecture.png)\n`,
      );
      return;
    }

    // Notice: /zh-cn/news/news250528.md will 404, falling back to HTML route /zh-cn/news/news250528
    if (path === "/zh-cn/news/news250528") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!DOCTYPE html><html><head><title>DeepSeek V3 定价调整</title></head><body><article><h1>DeepSeek V3 定价调整</h1><p>2026-05-28</p><p>大幅降低 API 价格，详情如下。</p><table><thead><tr><th>模型</th><th>价格</th></tr></thead><tbody><tr><td>deepseek-chat</td><td>1元</td></tr></tbody></table></article></body></html>`,
      );
      return;
    }

    if (path === "/news/news250528.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(
        `# DeepSeek Price Update\n\nDate: 2026-05-28\n\nNew pricing for DeepSeek API tokens.\n`,
      );
      return;
    }

    if (
      path === "/zh-cn/news/news261101.md" ||
      path === "/news/news261101.md"
    ) {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(
        `# DeepSeek-R2 Preview\n\nDate: 2026-11-01\n\nDeepSeek-R2 Preview reasoning model is now accessible.\n`,
      );
      return;
    }

    if (path === "/images/architecture.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }

    if (path === "/fallback/updates.md") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!DOCTYPE html><html><head><title>Your First API Call</title></head><body><h1>Your First API Call</h1><p>Docs homepage fallback</p></body></html>`,
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  const testConfig: DeepSeekConfig = {
    sources: [
      {
        id: "zh-cn",
        language: "zh-CN",
        updatesUrl: `${baseUrl}/zh-cn/updates.md`,
        title: "DeepSeek API 更新日志",
      },
      {
        id: "en",
        language: "en",
        updatesUrl: `${baseUrl}/updates.md`,
        title: "DeepSeek API Updates",
      },
    ],
  };

  await t.test("config validation and helper functions", () => {
    // Default empty config parses out of the box
    const parsedDefault = configSchema.parse({});
    assert.equal(parsedDefault.sources.length, 2);
    assert.equal(parsedDefault.sources[0]?.id, "zh-cn");
    assert.equal(parsedDefault.sources[1]?.id, "en");

    // Rejects duplicate source identifiers
    assert.throws(() => {
      configSchema.parse({
        sources: [
          {
            id: "en",
            language: "en",
            updatesUrl: "https://api-docs.deepseek.com/updates.md",
          },
          {
            id: "en",
            language: "en-US",
            updatesUrl: "https://api-docs.deepseek.com/en-us/updates.md",
          },
        ],
      });
    });

    // Helper functions
    assert.equal(extractNewsSlug("/news/news250528"), "news250528");
    assert.equal(extractNewsSlug("/zh-cn/news/news250528.md"), "news250528");
    assert.equal(extractNewsSlug("/news/news250528/"), "news250528");
    assert.equal(
      extractNewsSlug("https://api-docs.deepseek.com/news/news261020"),
      "news261020",
    );
    assert.equal(extractNewsSlug("/news"), undefined);
    assert.equal(extractNewsSlug("/zh-cn/news"), undefined);

    assert.equal(isHomepageFallback("Your First API Call"), true);
    assert.equal(isHomepageFallback("Welcome: 首次调用 API"), true);
    assert.equal(isHomepageFallback("Regular Article Title"), false);

    assert.equal(normalizeDate("2026-10-20"), "2026-10-20");
    assert.equal(normalizeDate("2026-5-8"), "2026-05-08");
    assert.equal(normalizeDate("2026年10月20日"), "2026-10-20");
    assert.equal(normalizeDate("2026-10"), "2026-10");
    assert.equal(
      normalizeDate("2026-10-20T17:30:00+08:00"),
      "2026-10-20T17:30:00+08:00",
    );
    assert.equal(normalizeDate("2026-13-01"), undefined);
    assert.equal(
      sourceAdapter.extensionsSchema.safeParse({
        region: "unpartitioned",
        language: "en",
        kind: "changelog",
        latestUpdateDate: "2026-10",
        latestUpdateDatePrecision: "month",
      }).success,
      true,
    );
    assert.equal(
      sourceAdapter.extensionsSchema.safeParse({
        region: "unpartitioned",
        language: "en",
        kind: "news",
        publishedDate: "2026-10-20",
      }).success,
      false,
    );
  });

  await t.test(
    "archives bilingual updates and linked news with language-scoped keys, unpartitioned region, and no body.html",
    async () => {
      updatesVersion = 1;
      const { context, submissions, uploadedResources } =
        createTestContext(testConfig);

      const result = await executeDeepSeekCollect(context, {});
      assert.deepEqual(result.completedScopes, ["zh-cn", "en"]);
      assert(submissions.length >= 4);

      // Verify each submission item
      for (const sub of submissions) {
        for (const item of sub.items) {
          // Rule: No duplicate body.html
          assert.equal(
            (item.body as Record<string, unknown> | undefined)?.html,
            undefined,
            "Submitted item must not contain body.html",
          );
          assert(
            typeof item.body?.markdown === "string",
            "Submitted item must have markdown body",
          );
          if (item.resources !== undefined) {
            assert(Array.isArray(item.resources), "Resources must be an array");
          }

          const extensions = item.extensions as Record<string, unknown>;
          assert.equal(
            extensions.region,
            "unpartitioned",
            "Region must be unpartitioned",
          );

          if (item.sourceKey.namespace === "deepseek:zh-cn") {
            assert.equal(extensions.language, "zh-CN");
          } else if (item.sourceKey.namespace === "deepseek:en") {
            assert.equal(extensions.language, "en");
          } else {
            assert.fail(
              `Unexpected sourceKey namespace: ${item.sourceKey.namespace}`,
            );
          }
        }
      }

      // Verify specific distinct keys exist
      const zhUpdates = submissions
        .flatMap((s) => s.items)
        .find(
          (it) =>
            it.sourceKey.namespace === "deepseek:zh-cn" &&
            it.sourceKey.key === "changelog:updates",
        );
      assert(zhUpdates !== undefined, "Chinese changelog must be archived");
      assert.equal(
        (zhUpdates.extensions as Record<string, unknown>).kind,
        "changelog",
      );

      const enUpdates = submissions
        .flatMap((s) => s.items)
        .find(
          (it) =>
            it.sourceKey.namespace === "deepseek:en" &&
            it.sourceKey.key === "changelog:updates",
        );
      assert(enUpdates !== undefined, "English changelog must be archived");
      assert.equal(
        (enUpdates.extensions as Record<string, unknown>).kind,
        "changelog",
      );

      const zhNews = submissions
        .flatMap((s) => s.items)
        .find(
          (it) =>
            it.sourceKey.namespace === "deepseek:zh-cn" &&
            it.sourceKey.key === "news:news261020",
        );
      assert(zhNews !== undefined, "Chinese news article must be archived");
      assert.equal((zhNews.extensions as Record<string, unknown>).kind, "news");

      const enNews = submissions
        .flatMap((s) => s.items)
        .find(
          (it) =>
            it.sourceKey.namespace === "deepseek:en" &&
            it.sourceKey.key === "news:news261020",
        );
      assert(enNews !== undefined, "English news article must be archived");
      assert.equal((enNews.extensions as Record<string, unknown>).kind, "news");

      // Verify media resource upload
      assert(uploadedResources.length > 0, "Image must be uploaded");
    },
  );

  await t.test(
    "detects soft fallbacks and 500 errors, reporting failure instead of archiving",
    async () => {
      // 1. Updates URL is a soft fallback to docs homepage
      const fallbackConfig: DeepSeekConfig = {
        sources: [
          {
            id: "fallback-src",
            language: "en",
            updatesUrl: `${baseUrl}/fallback/updates.md`,
          },
        ],
      };
      const { context: ctx1 } = createTestContext(fallbackConfig);
      const checkRes1 = await executeDeepSeekCheck(ctx1, {});
      assert.equal(checkRes1.availability, "unavailable");
      assert(checkRes1.problems.length > 0);

      // 2. Action collect rejects soft fallback and 500 news items
      const badArticleServer: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/updates.md") {
          res.writeHead(200, {
            "content-type": "text/markdown; charset=utf-8",
          });
          res.end(
            `# Updates\n\n## 2026-10-20\n- Broken link: [Fallback](/news/news-fallback)\n- Error link: [Error](/news/news-error)\n`,
          );
          return;
        }
        if (
          url.pathname === "/news/news-fallback.md" ||
          url.pathname === "/news/news-fallback"
        ) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            `<!DOCTYPE html><html><head><title>Your First API Call</title></head><body><h1>Your First API Call</h1></body></html>`,
          );
          return;
        }
        if (
          url.pathname === "/news/news-error.md" ||
          url.pathname === "/news/news-error"
        ) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("Internal Server Error");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      badArticleServer.listen(0, "127.0.0.1");
      await once(badArticleServer, "listening");
      const badPort = (badArticleServer.address() as { port: number }).port;
      const badConfig: DeepSeekConfig = {
        sources: [
          {
            id: "bad-src",
            language: "en",
            updatesUrl: `http://127.0.0.1:${badPort}/updates.md`,
          },
        ],
      };

      const { context: ctx2 } = createTestContext(badConfig);
      await assert.rejects(
        () => executeDeepSeekCollect(ctx2, {}),
        (error: unknown) => {
          assert(isSourceAdapterActionError(error));
          return true;
        },
      );
      badArticleServer.close();
      await once(badArticleServer, "close");
    },
  );

  await t.test(
    "sync establishes baseline on first run without archive commits, syncs without changes, and detects updates",
    async () => {
      updatesVersion = 1;
      requestCounts.clear();

      let storedState: unknown = undefined;
      const persistentState = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = structuredClone(state);
        },
      };

      // 1. Initial Sync: Baseline established
      const { context: syncCtx1, submissions: subs1 } = createTestContext(
        testConfig,
        {
          persistentState,
        },
      );

      const syncResult1 = await executeDeepSeekSync(syncCtx1, {});
      assert.deepEqual(syncResult1.completedScopes, ["zh-cn", "en"]);
      assert.deepEqual(syncResult1.initializedScopes, ["zh-cn", "en"]);

      // 0 archive commits during initial baseline sync!
      assert.equal(
        subs1.length,
        0,
        "Initial baseline sync must not submit archives",
      );

      // 0 news detail requests during initial baseline sync!
      assert.equal(
        getRequestCount("/news/news261020.md"),
        0,
        "Initial baseline sync must not fetch news details",
      );
      assert.equal(
        getRequestCount("/zh-cn/news/news261020.md"),
        0,
        "Initial baseline sync must not fetch news details",
      );

      // Verify persistentState was populated
      const state1 = storedState as IncrementalSyncState;
      assert(state1.scopes["en"] !== undefined);
      assert(
        state1.scopes["en"].ongoingDocuments?.["changelog:updates"] !==
          undefined,
      );
      assert(state1.scopes["en"].entries["news:news261020"] !== undefined);
      assert.equal(
        state1.scopes["en"].entries["news:news261020"]?.archivedCompleteness,
        "baseline",
      );

      // 2. Subsequent Sync with NO changes
      requestCounts.clear();
      const { context: syncCtx2, submissions: subs2 } = createTestContext(
        testConfig,
        {
          persistentState,
        },
      );

      const syncResult2 = await executeDeepSeekSync(syncCtx2, {});
      assert.deepEqual(syncResult2.completedScopes, ["zh-cn", "en"]);
      assert.equal(syncResult2.initializedScopes, undefined);

      // Still 0 archive commits because content did not change!
      assert.equal(
        subs2.length,
        0,
        "Sync without changes must not submit archives",
      );

      // 0 news detail fetches!
      assert.equal(
        getRequestCount("/news/news261020.md"),
        0,
        "Unchanged news articles must not be re-fetched",
      );
      assert.equal(
        getRequestCount("/zh-cn/news/news261020.md"),
        0,
        "Unchanged news articles must not be re-fetched",
      );

      // 3. Subsequent Sync with updates: updatesVersion = 2 adds a new release + news link
      updatesVersion = 2;
      requestCounts.clear();
      const { context: syncCtx3, submissions: subs3 } = createTestContext(
        testConfig,
        {
          persistentState,
        },
      );

      const syncResult3 = await executeDeepSeekSync(syncCtx3, {
        sourceIds: ["en"],
      });
      assert.deepEqual(syncResult3.completedScopes, ["en"]);

      // Unchanged old news must NOT be fetched!
      assert.equal(
        getRequestCount("/news/news261020.md"),
        0,
        "Old news article must not be re-fetched",
      );
      assert.equal(
        getRequestCount("/news/news250528.md"),
        0,
        "Old news article must not be re-fetched",
      );

      // Newly added news article WAS fetched!
      assert.equal(
        getRequestCount("/news/news261101.md"),
        1,
        "Newly discovered news article must be fetched",
      );

      // Archives BOTH the updated changelog and the new independent news item!
      assert(subs3.length >= 2, "Must submit updated changelog and new news");
      const updatedChangelog = subs3
        .flatMap((s) => s.items)
        .find(
          (it) =>
            it.sourceKey.namespace === "deepseek:en" &&
            it.sourceKey.key === "changelog:updates",
        );
      assert(
        updatedChangelog !== undefined,
        "Updated changelog revision must be submitted",
      );

      const newNews = subs3
        .flatMap((s) => s.items)
        .find(
          (it) =>
            it.sourceKey.namespace === "deepseek:en" &&
            it.sourceKey.key === "news:news261101",
        );
      assert(newNews !== undefined, "New news article must be submitted");

      // Verify persistentState updated
      const state3 = storedState as IncrementalSyncState;
      assert.equal(
        state3.scopes["en"]?.entries["news:news261101"]?.archivedCompleteness,
        "complete",
      );
    },
  );

  await t.test(
    "collect preserves code blocks, pricing tables, media resources, and day-precision dates",
    async () => {
      updatesVersion = 1;
      const { context, submissions, uploadedResources } =
        createTestContext(testConfig);

      const result = await executeDeepSeekCollect(context, {
        sourceIds: ["zh-cn"],
      });
      assert.deepEqual(result.completedScopes, ["zh-cn"]);

      const zhChangelog = submissions
        .flatMap((s) => s.items)
        .find((it) => it.sourceKey.key === "changelog:updates");
      assert(zhChangelog !== undefined);

      const changelogExtensions = zhChangelog.extensions as Record<
        string,
        unknown
      >;
      assert.equal(changelogExtensions.latestUpdateDate, "2026-10-20");
      assert.equal(changelogExtensions.latestUpdateDatePrecision, "day");
      assert.equal(zhChangelog.sourcePublishedAt, null);
      assert.equal(zhChangelog.sourceModifiedAt, null);

      // Preserves markdown table
      assert(
        zhChangelog.body?.markdown?.includes("输入价格 (每百万 token)"),
        "Changelog must preserve table contents",
      );
      assert(
        zhChangelog.body?.markdown?.includes("deepseek-chat"),
        "Changelog must preserve table rows",
      );

      // Preserves code block
      assert(
        zhChangelog.body?.markdown?.includes("```python") &&
          zhChangelog.body?.markdown?.includes("OpenAI("),
        "Changelog must preserve code block",
      );

      // Preserves media resource in news article
      const zhNews = submissions
        .flatMap((s) => s.items)
        .find((it) => it.sourceKey.key === "news:news261020");
      assert(zhNews !== undefined);
      assert.deepEqual(zhNews.sourcePublishedAt, {
        precision: "instant",
        value: "2026-10-20T17:30:00+08:00",
      });
      assert.equal(zhNews.sourceModifiedAt, null);

      assert(
        zhNews.body?.markdown?.includes("```python"),
        "News article must preserve code block",
      );
      assert(
        uploadedResources.length > 0,
        "Media resource must be uploaded to archive",
      );
      assert(
        zhNews.resources !== undefined && zhNews.resources.length > 0,
        "News article must reference uploaded archive resource",
      );
    },
  );

  await t.test("check action succeeds when sources are available", async () => {
    updatesVersion = 1;
    const { context } = createTestContext(testConfig);
    const result = await executeDeepSeekCheck(context, {});
    assert.equal(result.availability, "available");
    assert.equal(result.problems.length, 0);
    assert.deepEqual(result.scope, ["zh-cn", "en"]);
  });
});
