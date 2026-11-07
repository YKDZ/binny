import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  isSourceAdapterActionError,
  type ArchiveCommit,
  type ArchiveResourceMetadata,
  type IncrementalSyncState,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";

import sourceAdapter, { type QwenConfig } from "../src/source-adapter.ts";

function createSourceAdapterContext(options: {
  origin: string;
  config?: Partial<QwenConfig>;
  initialState?: IncrementalSyncState;
  signal?: AbortSignal;
  uploadedResources?: ArchiveResourceMetadata[];
}): {
  context: SourceAdapterContext<QwenConfig>;
  submissions: Parameters<SourceAdapterContext["archive"]["submit"]>[0][];
  getState: () => IncrementalSyncState | undefined;
} {
  let storedState = options.initialState;
  const submissions: Parameters<
    SourceAdapterContext["archive"]["submit"]
  >[0][] = [];
  let commitCount = 0;
  const runId = randomUUID();

  const persistentState = {
    async load() {
      return storedState;
    },
    async save(state: unknown) {
      storedState = state as IncrementalSyncState;
    },
  };

  const fullConfig: QwenConfig = {
    languages: ["zh-CN", "en-US"],
    endpointUrl: `${options.origin}/api/v2/article/retrieval`,
    articleType: "qwen_ai",
    siteBaseUrl: `${options.origin}`,
    ...options.config,
  };

  const context: SourceAdapterContext<QwenConfig> = {
    binId: "qwen-test-bin",
    identityId: "qwen-test-identity",
    runId,
    referenceTime: "2026-11-04T00:00:00.000Z",
    sourceAdapterVersion: sourceAdapter.version,
    config: fullConfig,
    signal: options.signal ?? new AbortController().signal,
    persistentState,
    archive: {
      async submit(input) {
        submissions.push(input);
        commitCount += 1;
        return {
          commitId: randomUUID(),
          archiveSeq: String(commitCount),
          binId: "qwen-test-bin",
          runId,
          sourceAdapterVersion: sourceAdapter.version,
          observedAt: "2026-11-04T00:00:00.000Z",
          recordedAt: "2026-11-04T00:00:00.000Z",
          items: input.items.map((item) => ({
            itemId: randomUUID(),
            revisionId: randomUUID(),
            sourceKey: item.sourceKey,
          })),
          relations: [],
        } satisfies ArchiveCommit;
      },
    },
    resources: {
      async upload(body, mediaType) {
        const resource: ArchiveResourceMetadata = {
          resourceId: randomUUID(),
          mediaType,
          size: 4,
          sha256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        };
        options.uploadedResources?.push(resource);
        return { ok: true, resource };
      },
      async resolve() {
        return {
          resources: [],
          items: [],
          mediaByUrl: {},
        };
      },
    },
  };

  return {
    context,
    submissions,
    getState: () => storedState,
  };
}

void test("exports expected adapter metadata", () => {
  assert.equal(sourceAdapter.id, "qwen");
  assert.equal(sourceAdapter.version, "0.1.0");
  assert.ok(sourceAdapter.actions.check !== undefined);
  assert.ok(sourceAdapter.actions.collect !== undefined);
  assert.ok(sourceAdapter.actions.sync !== undefined);
});

void test("config schema provides valid defaults for empty configuration", () => {
  const parsed = sourceAdapter.configSchema.parse({});
  assert.deepEqual(parsed.languages, ["zh-CN", "en-US"]);
  assert.equal(parsed.endpointUrl, "https://qwen.ai/api/v2/article/retrieval");
  assert.equal(parsed.articleType, "qwen_ai");
  assert.equal(parsed.siteBaseUrl, "https://qwen.ai");
});

void test("archives zh-CN and en-US articles with independent identities, sourceRef, cleaned markdown and facts", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v2/article/retrieval") {
      const language = url.searchParams.get("language");
      if (language === "zh-CN") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              articles: [
                {
                  id: "uuid-zh-1",
                  path: "qwen3.8-livetranslate",
                  title: "Qwen3.8-LiveTranslate：实时翻译模型",
                  language: "zh-CN",
                  type: "qwen_ai",
                  content: `
                    <!doctype html>
                    <html>
                    <head>
                      <link rel="canonical" href="https://qwenlm.github.io/zh/blog/qwen3.8-livetranslate/" />
                      <script>console.log("bad script");</script>
                      <style>body { color: red; }</style>
                    </head>
                    <body>
                      <header class="post-header"><h1>旧博客标题</h1></header>
                      <nav><a href="/home">首页导航</a></nav>
                      <h2>模型架构与评测</h2>
                      <p>这是正文第一段，包含<a href="https://example.com/paper">技术论文</a>链接。</p>
                      <pre><code>const translate = liveTranslate();</code></pre>
                      <table>
                        <thead><tr><th>语言</th><th>BLEU</th></tr></thead>
                        <tbody><tr><td>中英</td><td>42.5</td></tr></tbody>
                      </table>
                    </body>
                    </html>
                  `,
                  extra: {
                    date: "2026-09-18T17:30:00+08:00",
                    author: "Qwen Team",
                    tags: ["Translation", "Release"],
                    git_url: "https://code.alibaba-inc.com/qwen/blog/index.md",
                    cover_small: "https://img.alicdn.com/cover.png",
                  },
                },
              ],
            },
          }),
        );
        return;
      }

      if (language === "en-US") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              articles: [
                {
                  id: "uuid-en-1",
                  path: "qwen3.8-livetranslate",
                  title: "Qwen3.8-LiveTranslate: Real-time Translation Model",
                  language: "en-US",
                  type: "qwen_ai",
                  content: `
                    <!doctype html>
                    <html>
                    <head>
                      <link rel="canonical" href="https://qwenlm.github.io/blog/qwen3.8-livetranslate/" />
                      <script>console.log("bad script");</script>
                    </head>
                    <body>
                      <header class="post-header"><h1>Old Title</h1></header>
                      <h2>Model Architecture</h2>
                      <p>English article paragraph with <a href="https://example.com/paper-en">paper link</a>.</p>
                      <pre><code>const translate = liveTranslate();</code></pre>
                    </body>
                    </html>
                  `,
                  extra: {
                    date: "2026-09-18",
                    author: "Qwen Team",
                    tags: ["Translation"],
                  },
                },
              ],
            },
          }),
        );
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const { context, submissions } = createSourceAdapterContext({ origin });
    const result = await sourceAdapter.actions.collect.execute(context, {});

    assert.deepEqual(result.completedScopes, ["lang:zh-CN", "lang:en-US"]);
    assert.equal(submissions.length, 2);

    // Verify zh-CN submission
    const zhSubmission = submissions[0];
    assert.ok(zhSubmission !== undefined);
    assert.equal(zhSubmission.items.length, 1);
    const zhItem = zhSubmission.items[0];
    assert.ok(zhItem !== undefined);

    assert.deepEqual(zhItem.sourceKey, {
      namespace: "qwen:zh-CN",
      key: "qwen3.8-livetranslate",
    });
    assert.equal(zhItem.sourceRef, `${origin}/blog?id=qwen3.8-livetranslate`);
    assert.equal(zhItem.body?.html, undefined);
    assert.ok(zhItem.body?.markdown !== undefined);
    assert.ok(zhItem.body.markdown.includes("模型架构与评测"));
    assert.ok(
      zhItem.body.markdown.includes("const translate = liveTranslate();"),
    );
    assert.ok(zhItem.body.markdown.includes("https://example.com/paper"));
    assert.ok(!zhItem.body.markdown.includes("<script>"));
    assert.ok(!zhItem.body.markdown.includes("<style>"));
    assert.ok(!zhItem.body.markdown.includes("首页导航"));
    assert.ok(zhItem.body?.text !== undefined);

    assert.equal(zhItem.metadata?.region, "global");
    assert.equal(zhItem.metadata?.language, "zh-CN");
    assert.equal(
      zhItem.metadata?.canonicalUrl,
      "https://qwenlm.github.io/zh/blog/qwen3.8-livetranslate/",
    );
    assert.equal(zhItem.metadata?.qwenArticleId, "uuid-zh-1");
    assert.equal(zhItem.metadata?.publishedDate, "2026-09-18T17:30:00+08:00");
    assert.equal(zhItem.metadata?.datePrecision, "second");
    assert.equal(zhItem.sourceModifiedAt, "2026-09-18T09:30:00.000Z");
    assert.equal(zhItem.metadata?.author, "Qwen Team");

    // Verify en-US submission has independent identity and does not overwrite zh-CN
    const enSubmission = submissions[1];
    assert.ok(enSubmission !== undefined);
    assert.equal(enSubmission.items.length, 1);
    const enItem = enSubmission.items[0];
    assert.ok(enItem !== undefined);

    assert.deepEqual(enItem.sourceKey, {
      namespace: "qwen:en-US",
      key: "qwen3.8-livetranslate",
    });
    assert.equal(enItem.sourceRef, `${origin}/blog?id=qwen3.8-livetranslate`);
    assert.equal(enItem.body?.html, undefined);
    assert.ok(enItem.body?.markdown !== undefined);
    assert.ok(enItem.body.markdown.includes("Model Architecture"));
    assert.equal(enItem.metadata?.region, "global");
    assert.equal(enItem.metadata?.language, "en-US");
    assert.equal(
      enItem.metadata?.canonicalUrl,
      "https://qwenlm.github.io/blog/qwen3.8-livetranslate/",
    );
    assert.equal(enItem.metadata?.qwenArticleId, "uuid-en-1");
    // Date with day precision only
    assert.equal(enItem.metadata?.publishedDate, "2026-09-18");
    assert.equal(enItem.metadata?.datePrecision, "day");
    assert.equal(enItem.sourceModifiedAt, undefined);
  } finally {
    server.close();
  }
});

void test("fetches list once per language without per-article detail requests and scans entire unsorted array", async () => {
  const requestCounts: Record<string, number> = {};

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requestCounts[url.pathname] = (requestCounts[url.pathname] ?? 0) + 1;

    if (url.pathname === "/api/v2/article/retrieval") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            articles: [
              {
                id: "art-1",
                path: "newer-1",
                title: "Newer Article 1",
                content: "<p>Content of newer article 1</p>",
                extra: { date: "2026-09-20" },
              },
              {
                id: "art-2",
                path: "older-item",
                title: "Older Article In Between",
                content: "<p>Content of older article</p>",
                extra: { date: "2025-11-13" },
              },
              {
                id: "art-3",
                path: "newer-2",
                title: "Newer Article After Older",
                content: "<p>Content of newer article 2</p>",
                extra: { date: "2026-10-01" },
              },
            ],
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const { context, submissions } = createSourceAdapterContext({
      origin,
      config: { languages: ["en-US"] },
    });

    const result = await sourceAdapter.actions.collect.execute(context, {});
    assert.deepEqual(result.completedScopes, ["lang:en-US"]);

    // Exactly 1 list retrieval request was made
    assert.equal(requestCounts["/api/v2/article/retrieval"], 1);
    // No per-article detail requests were made
    assert.equal(requestCounts["/api/v2/article/"], undefined);

    // All 3 items discovered despite older date in the middle
    assert.equal(submissions.length, 3);
    const submittedKeys = submissions.map((s) => s.items[0]?.sourceKey.key);
    assert.deepEqual(submittedKeys, ["newer-1", "older-item", "newer-2"]);
  } finally {
    server.close();
  }
});

void test("sync baseline establishment, no-change skip, and incremental detection of new and revised articles", async () => {
  let articlesPayload: unknown[] = [
    {
      id: "uuid-1",
      path: "article-alpha",
      title: "Article Alpha",
      content: "<p>Alpha body content version 1</p>",
      extra: { date: "2026-08-01" },
    },
    {
      id: "uuid-2",
      path: "article-beta",
      title: "Article Beta",
      content: "<p>Beta body content version 1</p>",
      extra: { date: "2026-07-01" },
    },
  ];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v2/article/retrieval") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            articles: articlesPayload,
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const { context, submissions, getState } = createSourceAdapterContext({
      origin,
      config: { languages: ["zh-CN"] },
    });

    // 1. Initial sync establishes baseline without submitting historical articles
    const firstSync = await sourceAdapter.actions.sync.execute(context, {});
    assert.deepEqual(firstSync.completedScopes, ["lang:zh-CN"]);
    assert.deepEqual(firstSync.initializedScopes, ["lang:zh-CN"]);
    assert.equal(submissions.length, 0);

    const stateAfterFirst = getState();
    assert.ok(stateAfterFirst !== undefined);
    const scopeState = stateAfterFirst.scopes["lang:zh-CN"];
    assert.ok(scopeState !== undefined);
    assert.equal(
      scopeState.entries["article-alpha"]?.archivedCompleteness,
      "baseline",
    );
    assert.equal(
      scopeState.entries["article-beta"]?.archivedCompleteness,
      "baseline",
    );

    // 2. Subsequent sync with unchanged articles makes zero archive commits
    const secondSync = await sourceAdapter.actions.sync.execute(context, {});
    assert.deepEqual(secondSync.completedScopes, ["lang:zh-CN"]);
    assert.equal(secondSync.initializedScopes, undefined);
    assert.equal(submissions.length, 0);

    // 3. Subsequent sync with a revised article and a new article at the end
    articlesPayload = [
      {
        id: "uuid-1",
        path: "article-alpha",
        title: "Article Alpha",
        content: "<p>Alpha body content version 2 with revision</p>",
        extra: { date: "2026-08-01" },
      },
      {
        id: "uuid-2",
        path: "article-beta",
        title: "Article Beta",
        content: "<p>Beta body content version 1</p>",
        extra: { date: "2026-07-01" },
      },
      {
        id: "uuid-3",
        path: "article-gamma",
        title: "Article Gamma (New)",
        content: "<p>Brand new gamma article body</p>",
        extra: { date: "2026-10-15" },
      },
    ];

    const thirdSync = await sourceAdapter.actions.sync.execute(context, {});
    assert.deepEqual(thirdSync.completedScopes, ["lang:zh-CN"]);
    assert.equal(submissions.length, 2);

    const submittedKeys = submissions.map((s) => s.items[0]?.sourceKey.key);
    assert.deepEqual(submittedKeys, ["article-alpha", "article-gamma"]);

    const stateAfterThird = getState();
    const updatedEntries = stateAfterThird?.scopes["lang:zh-CN"]?.entries;
    assert.equal(
      updatedEntries?.["article-alpha"]?.archivedCompleteness,
      "complete",
    );
    assert.equal(
      updatedEntries?.["article-gamma"]?.archivedCompleteness,
      "complete",
    );
    assert.equal(
      updatedEntries?.["article-beta"]?.archivedCompleteness,
      "baseline",
    );
  } finally {
    server.close();
  }
});

void test("fails cleanly on HTTP 500, invalid JSON, or empty articles array without archiving raw responses", async () => {
  let serverMode: "500" | "invalid_json" | "empty_articles" = "500";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v2/article/retrieval") {
      if (serverMode === "500") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }
      if (serverMode === "invalid_json") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><html><body>Gateway Timeout</body></html>");
        return;
      }
      if (serverMode === "empty_articles") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { articles: [] } }));
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    // Mode 1: HTTP 500
    serverMode = "500";
    const ctx500 = createSourceAdapterContext({ origin });
    await assert.rejects(
      async () => {
        await sourceAdapter.actions.collect.execute(ctx500.context, {});
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "qwen_source_invalid_response");
        return true;
      },
    );
    assert.equal(ctx500.submissions.length, 0);

    const check500 = await sourceAdapter.actions.check.execute(
      ctx500.context,
      {},
    );
    assert.equal(check500.availability, "unavailable");
    assert.ok(
      check500.problems.some((p) => p.code === "qwen_source_invalid_response"),
    );

    // Mode 2: Invalid JSON
    serverMode = "invalid_json";
    const ctxJson = createSourceAdapterContext({ origin });
    await assert.rejects(
      async () => {
        await sourceAdapter.actions.sync.execute(ctxJson.context, {});
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "qwen_source_invalid_response");
        return true;
      },
    );
    assert.equal(ctxJson.submissions.length, 0);

    const checkJson = await sourceAdapter.actions.check.execute(
      ctxJson.context,
      {},
    );
    assert.equal(checkJson.availability, "unavailable");
    assert.ok(
      checkJson.problems.some((p) => p.code === "qwen_source_invalid_response"),
    );

    // Mode 3: Empty articles array
    serverMode = "empty_articles";
    const ctxEmpty = createSourceAdapterContext({ origin });
    await assert.rejects(
      async () => {
        await sourceAdapter.actions.collect.execute(ctxEmpty.context, {});
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "qwen_source_invalid_response");
        return true;
      },
    );
    assert.equal(ctxEmpty.submissions.length, 0);

    const checkEmpty = await sourceAdapter.actions.check.execute(
      ctxEmpty.context,
      {},
    );
    assert.equal(checkEmpty.availability, "unavailable");
    assert.ok(
      checkEmpty.problems.some(
        (p) => p.code === "qwen_source_invalid_response",
      ),
    );
  } finally {
    server.close();
  }
});

void test("check action reports available on valid endpoints", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v2/article/retrieval") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            articles: [
              {
                id: "test-id",
                path: "test-path",
                title: "Test Title",
                content: "<p>Sample cleanable paragraph</p>",
                extra: { date: "2026-10-20" },
              },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const { context } = createSourceAdapterContext({ origin });
    const checkResult = await sourceAdapter.actions.check.execute(context, {});
    assert.equal(checkResult.availability, "available");
    assert.deepEqual(checkResult.scope, ["lang:zh-CN", "lang:en-US"]);
    assert.equal(checkResult.problems.length, 0);
  } finally {
    server.close();
  }
});

void test("collect action supports filtering by paths and maxItems", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v2/article/retrieval") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            articles: [
              {
                path: "item-1",
                title: "Item 1",
                content: "<p>Item 1 content</p>",
              },
              {
                path: "item-2",
                title: "Item 2",
                content: "<p>Item 2 content</p>",
              },
              {
                path: "item-3",
                title: "Item 3",
                content: "<p>Item 3 content</p>",
              },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    // Filter by path
    const ctxPath = createSourceAdapterContext({
      origin,
      config: { languages: ["en-US"] },
    });
    await sourceAdapter.actions.collect.execute(ctxPath.context, {
      paths: ["item-2"],
    });
    assert.equal(ctxPath.submissions.length, 1);
    assert.equal(ctxPath.submissions[0]?.items[0]?.sourceKey.key, "item-2");

    // Filter by maxItems
    const ctxMax = createSourceAdapterContext({
      origin,
      config: { languages: ["en-US"] },
    });
    await sourceAdapter.actions.collect.execute(ctxMax.context, {
      maxItems: 2,
    });
    assert.equal(ctxMax.submissions.length, 2);
    assert.equal(ctxMax.submissions[0]?.items[0]?.sourceKey.key, "item-1");
    assert.equal(ctxMax.submissions[1]?.items[0]?.sourceKey.key, "item-2");
  } finally {
    server.close();
  }
});
