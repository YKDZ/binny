// MiniMax regional model releases and first-party blog details source adapter tests.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  discoverArticleLinks,
  extractModelsReleaseDates,
  parseDateString,
  preprocessModelsMarkdown,
  sourceAdapter,
  type MinimaxConfig,
} from "../src/source-adapter.ts";

function createTestContext(
  config: MinimaxConfig,
  options?: {
    persistentState?: {
      load(): Promise<unknown>;
      save(state: unknown): Promise<void>;
    };
    signal?: AbortSignal;
    referenceTime?: string;
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

  const runContext: SourceAdapterRunContext<MinimaxConfig> = {
    binId: "minimax-test-bin",
    identityId: "minimax-test-identity",
    runId: randomUUID(),
    referenceTime: options?.referenceTime ?? "2026-11-07T12:00:00.000Z",
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

void test("Default configuration schema produces CN and International sources", () => {
  const parsed = configSchema.parse({});
  assert.equal(parsed.sources.length, 2);

  const cn = parsed.sources[0];
  assert.ok(cn);
  assert.equal(cn.id, "cn");
  assert.equal(cn.region, "cn");
  assert.equal(cn.language, "zh-CN");
  assert.equal(
    cn.modelsReleaseUrl,
    "https://platform.minimax.cn/docs/release-notes/models.md",
  );
  assert.deepEqual(cn.allowedArticleHosts, [
    "www.minimax.cn",
    "minimax.cn",
    "platform.minimax.cn",
  ]);

  const intl = parsed.sources[1];
  assert.ok(intl);
  assert.equal(intl.id, "international");
  assert.equal(intl.region, "international");
  assert.equal(intl.language, "en");
  assert.equal(
    intl.modelsReleaseUrl,
    "https://platform.minimax.io/docs/release-notes/models.md",
  );
  assert.deepEqual(intl.allowedArticleHosts, [
    "www.minimax.io",
    "minimax.io",
    "platform.minimax.io",
  ]);
});

void test("Preprocessing models.md strips Mintlify boilerplate and MDX wrappers while preserving content", () => {
  const raw = `> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimax.io/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Models

<Card title="Overview">
Stay updated on MiniMax model releases.
</Card>

## 2026-10-29

> [card] [MiniMax M3.1 Flash](https://www.minimax.io/blog/minimax-m31f)
>
> An ultra-efficient open-weight model.

<Note>
External reference: [GitHub](https://github.com/MiniMax-AI)
</Note>
`;

  const preprocessed = preprocessModelsMarkdown(raw);
  assert.ok(!preprocessed.includes("Documentation Index"));
  assert.ok(!preprocessed.includes("<Card"));
  assert.ok(!preprocessed.includes("</Card>"));
  assert.ok(!preprocessed.includes("<Note"));
  assert.ok(!preprocessed.includes("</Note>"));
  assert.ok(!preprocessed.includes("[card]"));
  assert.ok(preprocessed.includes("# Models"));
  assert.ok(preprocessed.includes("## 2026-10-29"));
  assert.ok(preprocessed.includes("[MiniMax M3.1 Flash]"));
  assert.ok(preprocessed.includes("An ultra-efficient open-weight model."));
  assert.ok(preprocessed.includes("[GitHub](https://github.com/MiniMax-AI)"));
});

void test("Date extraction preserves day precision, month precision, and regional differences without fabrication", () => {
  const cnMarkdown = `
# 模型发布

## 2026 年 10 月 29 日
> [MiniMax M3.1 Flash](https://www.minimax.cn/blog/minimax-m31f)

## 2026 年 8 月
> [MiniMax Music-2.8](https://www.minimax.cn/news/music-28)

## 2026 年 3 月 18 日
> [MiniMax M2.7](https://www.minimax.cn/news/minimax-m27-zh)
`;

  const intlMarkdown = `
# Models

#### Oct. 28, 2026
> [MiniMax M3.1 Flash](https://www.minimax.io/blog/minimax-m31f)

#### August 2026
> [MiniMax Music-2.8](https://www.minimax.io/news/music-28)

#### Mar. 18, 2026
> [MiniMax M2.7](https://www.minimax.io/news/minimax-m27-en)
`;

  const cnDates = extractModelsReleaseDates(cnMarkdown);
  assert.equal(cnDates.latestDate, "2026-10-29");
  assert.equal(cnDates.datePrecision, "day");
  assert.deepEqual(cnDates.observedDates, [
    "2026-10-29",
    "2026-08",
    "2026-03-18",
  ]);

  const intlDates = extractModelsReleaseDates(intlMarkdown);
  assert.equal(intlDates.latestDate, "2026-10-28");
  assert.equal(intlDates.datePrecision, "day");
  assert.deepEqual(intlDates.observedDates, [
    "2026-10-28",
    "2026-08",
    "2026-03-18",
  ]);

  // Regional difference is preserved: CN has 2026-10-29 while International has 2026-10-28
  assert.notEqual(cnDates.latestDate, intlDates.latestDate);

  // Pure month precision markdown
  const monthOnly = `
# Models
## 2026-08
> [Model A](https://www.minimax.io/blog/a)
## Apr. 2026
> [Model B](https://www.minimax.io/blog/b)
`;
  const monthDates = extractModelsReleaseDates(monthOnly);
  assert.equal(monthDates.latestDate, "2026-08");
  assert.equal(monthDates.datePrecision, "month");
  assert.deepEqual(monthDates.observedDates, ["2026-08", "2026-04"]);

  assert.deepEqual(parseDateString("2026-10-20T14:15:00+08:00"), {
    date: "2026-10-20T14:15:00+08:00",
    precision: "instant",
  });
  assert.equal(parseDateString("2026-13-01T14:15:00+08:00"), undefined);
  assert.equal(
    sourceAdapter.extensionsSchema.safeParse({
      kind: "article",
      region: "cn",
      language: "zh-CN",
      modelsReleaseDate: "2026-10-29",
      modelsReleaseDatePrecision: "day",
    }).success,
    true,
  );
  assert.equal(
    sourceAdapter.extensionsSchema.safeParse({
      kind: "article",
      region: "cn",
      language: "zh-CN",
      articleDate: "2026-10-29",
    }).success,
    false,
  );
});

void test("Article link discovery filters out external links and old APIs", () => {
  const markdown = `
# Models

## 2026-10-19
> [MiniMax M3.1 Flash](https://www.minimax.cn/blog/minimax-m31f)
> Check code at [GitHub](https://github.com/MiniMax-AI)
> Check weights at [Hugging Face](https://huggingface.co/MiniMaxAI)
> Check API updates at [API Release Notes](https://platform.minimax.cn/docs/release-notes/apis.md)
> Check music docs at [Music Guide](https://platform.minimax.cn/docs/guides/music-generation)

## 2026-04
> [Music-2.6](https://www.minimax.cn/news/music-26)
`;

  const source = {
    id: "cn",
    region: "cn" as const,
    language: "zh-CN",
    modelsReleaseUrl:
      "https://platform.minimax.cn/docs/release-notes/models.md",
    allowedArticleHosts: [
      "www.minimax.cn",
      "minimax.cn",
      "platform.minimax.cn",
    ],
  };

  const discovered = discoverArticleLinks(markdown, source);
  assert.equal(discovered.length, 2);

  assert.equal(discovered[0]?.title, "MiniMax M3.1 Flash");
  assert.equal(discovered[0]?.url, "https://www.minimax.cn/blog/minimax-m31f");
  assert.equal(discovered[0]?.articlePath, "blog/minimax-m31f");
  assert.equal(discovered[0]?.releaseDate, "2026-10-19");
  assert.equal(discovered[0]?.releaseDatePrecision, "day");

  assert.equal(discovered[1]?.title, "Music-2.6");
  assert.equal(discovered[1]?.url, "https://www.minimax.cn/news/music-26");
  assert.equal(discovered[1]?.articlePath, "news/music-26");
  assert.equal(discovered[1]?.releaseDate, "2026-04");
  assert.equal(discovered[1]?.releaseDatePrecision, "month");
});

void test("MiniMax check, sync, and collect actions against mock server", async (t) => {
  let cnModelsVersion = 1;
  let cnDetailArticleFetchCount = 0;
  let intlDetailArticleFetchCount = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/cn/models.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      let md = `> ## Documentation Index
> Complete index at https://platform.minimax.cn/docs/llms.txt

# 模型发布

## 2026 年 10 月 29 日
> [MiniMax M3.1 Flash](/cn/blog/minimax-m31f)
> 一个面向真实工作的日常高效主力模型

## 2026 年 8 月
> [Music-2.8](/cn/news/music-28)
> 新一代音乐模型
`;
      if (cnModelsVersion >= 2) {
        md =
          `## 2026 年 11 月 07 日
> [MiniMax M4](/cn/news/minimax-m4)
> 最新推理旗舰模型

` + md;
      }
      res.end(md);
      return;
    }

    if (path === "/international/models.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      const md = `> ## Documentation Index
> Complete index at https://platform.minimax.io/docs/llms.txt

# Models

#### Oct. 28, 2026
> [MiniMax M3.1 Flash](/international/blog/minimax-m31f)
> An ultra-efficient open-weight model.

#### August 2026
> [Music-2.8](/international/news/music-28)
> Next-generation music model.
`;
      res.end(md);
      return;
    }

    if (path === "/cn/blog/minimax-m31f") {
      cnDetailArticleFetchCount += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <title>MiniMax M3.1 Flash：重新定义 Agent 的性能与成本 - MiniMax</title>
  <meta property="article:published_time" content="2026-10-20T14:15:00+08:00" />
  <meta property="article:modified_time" content="2026-10-21T09:30:00-04:00" />
</head>
<body>
  <header class="site-header"><nav><a href="/">Home</a></nav></header>
  <article>
    <header>
      <h1>MiniMax M3.1 Flash：重新定义 Agent 的性能与成本</h1>
      <time datetime="2026-12-01">公开演示日期</time>
    </header>
    <div class="content">
      <p>今天，我们正式更新 MiniMax M3.1 Flash。</p>
      <img src="http://${req.headers.host}/images/m31f-chart.png" alt="Architecture Chart" />
    </div>
    <div class="share-buttons">Share on social media</div>
    <div class="related-posts"><h3>Related Articles</h3></div>
  </article>
  <footer class="site-footer"><p>Copyright 2026 MiniMax</p></footer>
</body>
</html>`);
      return;
    }

    if (path === "/cn/news/music-28") {
      cnDetailArticleFetchCount += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<body>
  <article>
    <h1>Music 2.8 发布</h1>
    <time>2026-08</time>
    <p>全新的音乐生成体验。</p>
  </article>
</body>
</html>`);
      return;
    }

    if (path === "/cn/news/minimax-m4") {
      cnDetailArticleFetchCount += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<body>
  <article>
    <h1>MiniMax M4 正式发布</h1>
    <time datetime="2026-11-07">2026-11-07</time>
    <p>全面突破推理界限的旗舰模型。</p>
  </article>
</body>
</html>`);
      return;
    }

    if (path === "/international/blog/minimax-m31f") {
      intlDetailArticleFetchCount += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <title>MiniMax M3.1 Flash: Redefining Agent Performance - MiniMax</title>
</head>
<body>
  <article>
    <h1>MiniMax M3.1 Flash: Redefining Agent Performance</h1>
    <time datetime="2026-10-28">October 28, 2026</time>
    <p>Today we officially roll out MiniMax M3.1 Flash.</p>
  </article>
</body>
</html>`);
      return;
    }

    if (path === "/international/news/music-28") {
      intlDetailArticleFetchCount += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<body>
  <article>
    <h1>Music 2.8 Released</h1>
    <time>August 2026</time>
    <p>Experience the next generation music synthesis.</p>
  </article>
</body>
</html>`);
      return;
    }

    if (path === "/images/m31f-chart.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }

    if (path === "/error/models.md") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  const testConfig: MinimaxConfig = {
    sources: [
      {
        id: "cn",
        region: "cn",
        language: "zh-CN",
        modelsReleaseUrl: `${origin}/cn/models.md`,
        allowedArticleHosts: ["127.0.0.1", "localhost"],
      },
      {
        id: "international",
        region: "international",
        language: "en",
        modelsReleaseUrl: `${origin}/international/models.md`,
        allowedArticleHosts: ["127.0.0.1", "localhost"],
      },
    ],
  };

  await t.test(
    "check action validates availability and sample extraction",
    async () => {
      const { context } = createTestContext(testConfig);
      const result = await sourceAdapter.actions.check.execute(context, {});
      assert.equal(result.availability, "available");
      assert.deepEqual(result.scope, ["cn", "international"]);
      assert.equal(result.problems.length, 0);

      // Failing source check
      const failingConfig: MinimaxConfig = {
        sources: [
          {
            id: "failing",
            region: "cn",
            language: "zh-CN",
            modelsReleaseUrl: `${origin}/error/models.md`,
            allowedArticleHosts: ["127.0.0.1"],
          },
        ],
      };
      const { context: failingContext } = createTestContext(failingConfig);
      const failingResult = await sourceAdapter.actions.check.execute(
        failingContext,
        {},
      );
      assert.equal(failingResult.availability, "unavailable");
      assert.equal(failingResult.problems.length, 1);
      assert.equal(
        failingResult.problems[0]?.code,
        "minimax_source_unavailable",
      );
    },
  );

  await t.test(
    "sync initial baseline, no-change skip, and subsequent incremental update",
    async () => {
      let storedState: IncrementalSyncState | undefined;
      const persistentStore = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = state as IncrementalSyncState;
        },
      };

      cnDetailArticleFetchCount = 0;
      intlDetailArticleFetchCount = 0;

      // 1. Initial sync establishes baseline WITHOUT fetching detail articles or archiving items
      const { context: initCtx, submissions: initSubmissions } =
        createTestContext(testConfig, { persistentState: persistentStore });

      const initResult = await sourceAdapter.actions.sync.execute(initCtx, {});
      assert.deepEqual(initResult.completedScopes, ["cn", "international"]);
      assert.deepEqual(initResult.initializedScopes, ["cn", "international"]);

      // 0 detail article HTTP requests made
      assert.equal(cnDetailArticleFetchCount, 0);
      assert.equal(intlDetailArticleFetchCount, 0);
      // 0 archive submissions
      assert.equal(initSubmissions.length, 0);

      // Verify stored state
      assert.ok(storedState);
      const cnScope = storedState.scopes["cn"];
      assert.ok(cnScope);
      assert.ok(
        cnScope.ongoingDocuments?.["release-notes:models"]?.contentHash,
      );
      assert.equal(
        cnScope.entries["article:cn/blog/minimax-m31f"]?.archivedCompleteness,
        "baseline",
      );
      assert.equal(
        cnScope.entries["article:cn/news/music-28"]?.archivedCompleteness,
        "baseline",
      );

      const intlScope = storedState.scopes["international"];
      assert.ok(intlScope);
      assert.ok(
        intlScope.ongoingDocuments?.["release-notes:models"]?.contentHash,
      );
      assert.equal(
        intlScope.entries["article:international/blog/minimax-m31f"]
          ?.archivedCompleteness,
        "baseline",
      );

      // 2. Subsequent sync with no changes skips archiving and re-fetching
      const { context: noChangeCtx, submissions: noChangeSubmissions } =
        createTestContext(testConfig, { persistentState: persistentStore });

      const noChangeResult = await sourceAdapter.actions.sync.execute(
        noChangeCtx,
        {},
      );
      assert.deepEqual(noChangeResult.completedScopes, ["cn", "international"]);
      assert.equal(noChangeResult.initializedScopes, undefined);
      assert.equal(noChangeSubmissions.length, 0);
      assert.equal(cnDetailArticleFetchCount, 0);
      assert.equal(intlDetailArticleFetchCount, 0);

      // 3. Subsequent sync with new model release and new detail article link
      cnModelsVersion = 2; // Adds MiniMax M4 to CN models.md
      const { context: updateCtx, submissions: updateSubmissions } =
        createTestContext(testConfig, { persistentState: persistentStore });

      const updateResult = await sourceAdapter.actions.sync.execute(
        updateCtx,
        {},
      );
      assert.deepEqual(updateResult.completedScopes, ["cn", "international"]);

      // Only the NEW article (/cn/news/minimax-m4) was fetched! Historical articles were NOT re-fetched!
      assert.equal(cnDetailArticleFetchCount, 1);
      assert.equal(intlDetailArticleFetchCount, 0);

      // Submissions: 1 revision for release-notes:models and 1 for article:cn/news/minimax-m4
      assert.equal(updateSubmissions.length, 2);

      const modelsSubmission = updateSubmissions.find(
        (s) => s.items[0]?.sourceKey.key === "release-notes:models",
      );
      assert.ok(modelsSubmission);
      assert.deepEqual(modelsSubmission.items[0]?.sourceKey, {
        namespace: "minimax:cn",
        key: "release-notes:models",
      });

      const articleSubmission = updateSubmissions.find(
        (s) => s.items[0]?.sourceKey.key === "article:cn/news/minimax-m4",
      );
      assert.ok(articleSubmission);
      assert.deepEqual(articleSubmission.items[0]?.sourceKey, {
        namespace: "minimax:cn",
        key: "article:cn/news/minimax-m4",
      });
      assert.equal(articleSubmission.items[0]?.title, "MiniMax M4 正式发布");
      assert.equal(articleSubmission.items[0]?.sourcePublishedAt, null);
      assert.equal(articleSubmission.items[0]?.sourceModifiedAt, null);
      assert.equal(
        articleSubmission.items[0]?.extensions["modelsReleaseDate"],
        "2026-11-07",
      );
      assert.equal(
        articleSubmission.items[0]?.extensions["articleContentDate"],
        "2026-11-07",
      );

      // Verify stored state entry was updated to complete
      assert.equal(
        storedState.scopes["cn"]?.entries["article:cn/news/minimax-m4"]
          ?.archivedCompleteness,
        "complete",
      );
    },
  );

  await t.test(
    "collect archives release notes and first-party articles with independent regional keys",
    async () => {
      cnModelsVersion = 1;
      const { context, submissions, uploadedResources } =
        createTestContext(testConfig);

      const result = await sourceAdapter.actions.collect.execute(context, {});
      assert.deepEqual(result.completedScopes, ["cn", "international"]);

      // CN: 1 models doc + 2 articles = 3 submissions
      // International: 1 models doc + 2 articles = 3 submissions
      // Total: 6 submissions
      assert.equal(submissions.length, 6);

      // Verify CN models release notes item
      const cnModelsDoc = submissions.find(
        (s) =>
          s.items[0]?.sourceKey.namespace === "minimax:cn" &&
          s.items[0]?.sourceKey.key === "release-notes:models",
      )?.items[0];
      assert.ok(cnModelsDoc);
      assert.equal(cnModelsDoc.sourceRef, `${origin}/cn/models.md`);
      assert.equal(cnModelsDoc.sourcePublishedAt, null);
      assert.equal(cnModelsDoc.sourceModifiedAt, null);
      assert.equal(cnModelsDoc.extensions["kind"], "release-notes");
      assert.equal(cnModelsDoc.extensions["region"], "cn");
      assert.equal(cnModelsDoc.extensions["language"], "zh-CN");
      assert.equal(
        cnModelsDoc.extensions["latestReleaseEntryDate"],
        "2026-10-29",
      );
      assert.equal(
        cnModelsDoc.extensions["latestReleaseEntryDatePrecision"],
        "day",
      );
      assert.ok(cnModelsDoc.body?.markdown);
      assert.ok(!cnModelsDoc.body.markdown.includes("Documentation Index"));

      // Verify International models release notes item
      const intlModelsDoc = submissions.find(
        (s) =>
          s.items[0]?.sourceKey.namespace === "minimax:international" &&
          s.items[0]?.sourceKey.key === "release-notes:models",
      )?.items[0];
      assert.ok(intlModelsDoc);
      assert.equal(
        intlModelsDoc.sourceRef,
        `${origin}/international/models.md`,
      );
      assert.equal(intlModelsDoc.sourcePublishedAt, null);
      assert.equal(intlModelsDoc.sourceModifiedAt, null);
      assert.equal(intlModelsDoc.extensions["kind"], "release-notes");
      assert.equal(intlModelsDoc.extensions["region"], "international");
      assert.equal(intlModelsDoc.extensions["language"], "en");
      assert.equal(
        intlModelsDoc.extensions["latestReleaseEntryDate"],
        "2026-10-28",
      );
      assert.equal(
        intlModelsDoc.extensions["latestReleaseEntryDatePrecision"],
        "day",
      );

      // Independent regional namespaces and keys
      assert.notEqual(
        cnModelsDoc.sourceKey.namespace,
        intlModelsDoc.sourceKey.namespace,
      );

      // Verify CN detail article item with image upload and cleaned container
      const cnArticle = submissions.find(
        (s) =>
          s.items[0]?.sourceKey.namespace === "minimax:cn" &&
          s.items[0]?.sourceKey.key === "article:cn/blog/minimax-m31f",
      )?.items[0];
      assert.ok(cnArticle);
      assert.equal(
        cnArticle.title,
        "MiniMax M3.1 Flash：重新定义 Agent 的性能与成本",
      );
      assert.equal(cnArticle.sourceRef, `${origin}/cn/blog/minimax-m31f`);
      assert.deepEqual(cnArticle.sourcePublishedAt, {
        precision: "instant",
        value: "2026-10-20T14:15:00+08:00",
      });
      assert.deepEqual(cnArticle.sourceModifiedAt, {
        precision: "instant",
        value: "2026-10-21T09:30:00-04:00",
      });
      assert.equal(cnArticle.extensions["kind"], "article");
      assert.equal(cnArticle.extensions["region"], "cn");
      assert.equal(cnArticle.extensions["language"], "zh-CN");
      assert.equal(cnArticle.extensions["modelsReleaseDate"], "2026-10-29");
      assert.equal(cnArticle.extensions["articleContentDate"], "2026-12-01");

      // Stripped share buttons, related posts, site header/footer
      assert.ok(cnArticle.body?.markdown);
      assert.ok(!cnArticle.body.markdown.includes("Share on social media"));
      assert.ok(!cnArticle.body.markdown.includes("Related Articles"));
      assert.ok(!cnArticle.body.markdown.includes("Copyright 2026"));

      // Media asset uploaded and rewritten
      assert.equal(uploadedResources.length, 1);
      assert.ok(
        cnArticle.body.markdown.includes(
          `binny://resource/${uploadedResources[0]?.resourceId}`,
        ),
      );

      // Verify International detail article item
      const intlArticle = submissions.find(
        (s) =>
          s.items[0]?.sourceKey.namespace === "minimax:international" &&
          s.items[0]?.sourceKey.key ===
            "article:international/blog/minimax-m31f",
      )?.items[0];
      assert.ok(intlArticle);
      assert.equal(
        intlArticle.title,
        "MiniMax M3.1 Flash: Redefining Agent Performance",
      );
      assert.equal(intlArticle.sourcePublishedAt, null);
      assert.equal(intlArticle.sourceModifiedAt, null);
      assert.equal(intlArticle.extensions["region"], "international");
      assert.equal(intlArticle.extensions["language"], "en");
      assert.equal(intlArticle.extensions["modelsReleaseDate"], "2026-10-28");
      assert.equal(intlArticle.extensions["articleContentDate"], "2026-10-28");

      // Verify parameter limits: maxItems
      const { context: maxCtx, submissions: maxSubmissions } =
        createTestContext(testConfig);
      const maxResult = await sourceAdapter.actions.collect.execute(maxCtx, {
        maxItems: 1,
        sourceIds: ["cn"],
      });
      assert.deepEqual(maxResult.completedScopes, ["cn"]);
      // 1 models doc + 1 article = 2 submissions
      assert.equal(maxSubmissions.length, 2);

      // Verify parameter filtering: itemUrls
      const targetArticleUrl = `${origin}/cn/news/music-28`;
      const { context: itemUrlsCtx, submissions: itemUrlsSubmissions } =
        createTestContext(testConfig);
      const itemUrlsResult = await sourceAdapter.actions.collect.execute(
        itemUrlsCtx,
        {
          itemUrls: [targetArticleUrl],
          sourceIds: ["cn"],
        },
      );
      assert.deepEqual(itemUrlsResult.completedScopes, ["cn"]);
      // Only the target article was submitted (models doc excluded because not in itemUrls)
      assert.equal(itemUrlsSubmissions.length, 1);
      assert.equal(
        itemUrlsSubmissions[0]?.items[0]?.sourceKey.key,
        "article:cn/news/music-28",
      );

      // Verify error on unknown source ID
      const { context: unknownCtx } = createTestContext(testConfig);
      await assert.rejects(
        async () => {
          await sourceAdapter.actions.collect.execute(unknownCtx, {
            sourceIds: ["non-existent"],
          });
        },
        (err: unknown) => isSourceAdapterActionError(err),
      );
    },
  );
});
