import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import type {
  ArchiveResourceMetadata,
  IncrementalEntryRecord,
  IncrementalSyncState,
  JsonObject,
  SourceAdapterApiClient,
  SourceAdapterArchiveSubmission,
  SourceAdapterRunContext,
} from "@binny/source-adapter-sdk";
import {
  createActionCancelledReason,
  createSourceAdapterContext,
  isActionCancelledReason,
  isSourceAdapterActionError,
  sourceAdapterManifest,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import { extractArticle } from "../src/html-extractor.ts";
import sourceAdapter from "../src/index.ts";
import type { HuggingFaceConfig } from "../src/source-adapter.ts";

type HuggingFaceExtensions = z.output<typeof sourceAdapter.extensionsSchema>;
type HuggingFaceSubmission =
  SourceAdapterArchiveSubmission<HuggingFaceExtensions>;

void test("Hugging Face blog source adapter manifest and defaults", () => {
  assert.equal(sourceAdapter.id, "huggingface");
  assert.equal(sourceAdapter.version, "0.1.0");

  const parsedConfig = sourceAdapter.configSchema.parse({});
  assert.equal(parsedConfig.feedUrl, "https://huggingface.co/blog/feed.xml");
  assert.equal(parsedConfig.defaultCollectMaxItems, undefined);
  assert.equal(
    sourceAdapter.configSchema.parse({ defaultCollectMaxItems: 5 })
      .defaultCollectMaxItems,
    5,
  );

  const manifest = sourceAdapterManifest(sourceAdapter);
  assert.equal(manifest.extensionsSchema.additionalProperties, false);
  const extensionFields = manifest.extensionsSchema.properties as Record<
    string,
    { readonly description?: string }
  >;
  for (const field of Object.values(extensionFields)) {
    assert.ok(field.description);
  }
});

void test("Hugging Face blog incremental sync, content extraction, and collection", async () => {
  let storedPersistentState: IncrementalSyncState | undefined;
  const persistentState = {
    async load() {
      return storedPersistentState as unknown as JsonObject | undefined;
    },
    async save(state: JsonObject) {
      storedPersistentState = state as unknown as IncrementalSyncState;
    },
  };

  const requestLog: string[] = [];
  const submissions: HuggingFaceSubmission[] = [];
  const uploadedResources: ArchiveResourceMetadata[] = [];
  let commitSequence = 0;

  let feedItemsCount = 55;
  let includeNewItem = false;
  let feedEtag = '"feed-v1"';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    requestLog.push(path);

    if (path === "/blog/feed.xml") {
      if (req.headers["if-none-match"] === feedEtag) {
        res.writeHead(304, { etag: feedEtag });
        res.end();
        return;
      }

      const items: string[] = [];
      if (includeNewItem) {
        items.push(`
          <item>
            <title>New Diffusion Model Release</title>
            <link>${origin}/blog/article-new</link>
            <guid>${origin}/blog/article-new</guid>
            <pubDate>Fri, 10 May 2024 14:00:00 GMT</pubDate>
            <category>nlp</category>
            <category>diffusion</category>
          </item>
        `);
      }

      for (let i = 1; i <= feedItemsCount; i += 1) {
        const publishedDate =
          i === 1
            ? "Mon, 01 Jan 2024 00:00:00 +0530"
            : "Mon, 01 Jan 2024 00:00:00 GMT";
        items.push(`
          <item>
            <title>Historical Post ${i}</title>
            <link>${origin}/blog/history-${i}</link>
            <guid>urn:hf:blog:history-${i}</guid>
            <pubDate>${publishedDate}</pubDate>
            <category>research</category>
          </item>
        `);
      }

      res.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        etag: feedEtag,
      });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Hugging Face - Blog</title>
            <link>${origin}/blog</link>
            <description>The Hugging Face Blog</description>
            ${items.join("\n")}
          </channel>
        </rss>
      `);
      return;
    }

    if (path === "/blog/article-new") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
        <head>
          <title>New Diffusion Model Release - Hugging Face</title>
          <meta name="author" content="Sylvain Gugger">
          <meta property="article:author" content="https://huggingface.co/sylvaing">
          <meta property="article:tag" content="deep-learning">
        </head>
        <body>
          <nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
          <article>
            <header>
              <div class="breadcrumb"><a href="/blog">Back to blog</a></div>
              <h1>New Diffusion Model Release</h1>
              <div class="authors">
                <a href="/sylvaing">Sylvain Gugger</a>
              </div>
              <time datetime="2024-05-10T16:00:00+02:00">May 10, 2024</time>
            </header>
            <div class="blog-content">
              <p>We are introducing a new diffusion model.</p>
              <img src="/images/architecture.png" alt="Architecture Diagram" />
              <pre><code>import torch\nmodel = load_model()</code></pre>
            </div>
            <div class="upvote-button">
              <button aria-label="Upvote this post">Upvote 128</button>
            </div>
            <div class="community-comments">
              <h2>Community</h2>
              <p>User comment: Looks great!</p>
            </div>
            <div class="more-articles">
              <h3>More articles from our Blog</h3>
              <a href="/blog/history-1">Historical Post 1</a>
            </div>
          </article>
          <footer>Footer copyright info</footer>
        </body>
        </html>
      `);
      return;
    }

    if (path === "/images/architecture.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
      return;
    }

    if (path === "/blog/article-empty") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
        <body>
          <nav><a href="/blog">Back to blog</a></nav>
          <div class="community-comments"><h3>Comments</h3></div>
          <footer>Footer</footer>
        </body>
        </html>
      `);
      return;
    }

    if (path === "/blog/article-404") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (path.startsWith("/blog/history-")) {
      const id = path.replace("/blog/history-", "");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
        <head>
          <title>Historical Post ${id} - Hugging Face</title>
        </head>
        <body>
          <div class="blog-content">
            <h1>Historical Post ${id}</h1>
            <p>Content for historical post ${id}.</p>
          </div>
        </body>
        </html>
      `);
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

  const client = {
    archives: {
      async $post({ json }: { json: HuggingFaceSubmission }) {
        submissions.push(json);
        commitSequence += 1;
        return {
          status: 201,
          async json() {
            return {
              commitId: randomUUID(),
              archiveSeq: String(commitSequence),
              binId: "huggingface-test-bin",
              runId: runContext.runId,
              sourceAdapterVersion: sourceAdapter.version,
              observedAt: "2026-11-07T12:00:00.000Z",
              recordedAt: "2026-11-07T12:00:00.000Z",
              items: json.items.map((it) => ({
                itemId: randomUUID(),
                revisionId: randomUUID(),
                sourceKey: it.sourceKey,
              })),
              relations: [],
            };
          },
        };
      },
    },
    resources: {
      async $post(
        { header }: { header: Record<string, string> },
        { init }: { init: { body?: BodyInit } },
      ) {
        const bytes = init?.body
          ? Buffer.from(await (init.body as Blob).arrayBuffer())
          : Buffer.alloc(0);
        const resourceId = randomUUID();
        const meta: ArchiveResourceMetadata = {
          resourceId,
          sha256: "0".repeat(64),
          mediaType: header["content-type"] ?? "application/octet-stream",
          size: bytes.byteLength,
        };
        uploadedResources.push(meta);
        return {
          status: 201,
          async json() {
            return meta;
          },
        };
      },
      resolve: {
        async $post() {
          return {
            status: 200,
            async json() {
              return { resources: [], items: [], mediaByUrl: {} };
            },
          };
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  const runContext: SourceAdapterRunContext<HuggingFaceConfig> = {
    binId: "huggingface-test-bin",
    identityId: "huggingface-test-identity",
    runId: randomUUID(),
    referenceTime: "2026-11-07T12:00:00.000Z",
    sourceAdapterVersion: sourceAdapter.version,
    config: {
      feedUrl: `${origin}/blog/feed.xml`,
      defaultCollectMaxItems: 20,
    },
    signal: new AbortController().signal,
    persistentState,
    report: async () => {},
  };

  const context = createSourceAdapterContext(
    client,
    runContext,
    sourceAdapter.extensionsSchema,
  );

  try {
    // -------------------------------------------------------------
    // Test 1: Check action verifies feed parsing and sample article
    // -------------------------------------------------------------
    const checkResult = await sourceAdapter.actions.check.execute(context, {});
    assert.equal(checkResult.availability, "available");
    assert.deepEqual(checkResult.scope, ["blog"]);
    assert.equal(checkResult.problems.length, 0);

    // -------------------------------------------------------------
    // Test 2: Initial sync establishes baseline for all 55 items with ONLY 1 HTTP request
    // -------------------------------------------------------------
    requestLog.length = 0;
    submissions.length = 0;

    const initialSyncResult = await sourceAdapter.actions.sync.execute(
      context,
      {},
    );
    assert.deepEqual(initialSyncResult.completedScopes, ["blog"]);
    assert.deepEqual(initialSyncResult.initializedScopes, ["blog"]);

    // Exactly 1 HTTP request made to /blog/feed.xml
    assert.equal(requestLog.length, 1);
    assert.equal(requestLog[0], "/blog/feed.xml");
    // 0 article HTML detail requests made
    assert.equal(
      requestLog.some((p) => p.startsWith("/blog/history-")),
      false,
    );
    // 0 items submitted to archive during initial baseline sync
    assert.equal(submissions.length, 0);

    // All 55 items recorded in state with archivedCompleteness: "baseline"
    const blogScope = storedPersistentState?.scopes["blog"];
    assert.ok(blogScope !== undefined);
    assert.equal(Object.keys(blogScope.entries).length, 55);
    for (let i = 1; i <= 55; i += 1) {
      const itemEntry: IncrementalEntryRecord | undefined =
        blogScope.entries[`history-${i}`];
      assert.ok(
        itemEntry !== undefined,
        `history-${i} should exist in baseline`,
      );
      assert.equal(itemEntry.archivedCompleteness, "baseline");
      if (i === 1) {
        assert.equal(itemEntry.publishedAt, "Mon, 01 Jan 2024 00:00:00 +0530");
      }
    }

    // -------------------------------------------------------------
    // Test 3: Subsequent sync with no changes makes ONLY 1 HTTP request
    // -------------------------------------------------------------
    requestLog.length = 0;
    submissions.length = 0;

    const unchangedSyncResult = await sourceAdapter.actions.sync.execute(
      context,
      {},
    );
    assert.deepEqual(unchangedSyncResult.completedScopes, ["blog"]);
    // Exactly 1 HTTP request to feed.xml, 0 article requests
    assert.equal(requestLog.length, 1);
    assert.equal(requestLog[0], "/blog/feed.xml");
    assert.equal(submissions.length, 0);

    // -------------------------------------------------------------
    // Test 4: Subsequent sync when 1 new item is added
    // Fetches ONLY that 1 new article, cleans HTML, archives it, and uploads media
    // -------------------------------------------------------------
    requestLog.length = 0;
    submissions.length = 0;
    uploadedResources.length = 0;
    includeNewItem = true;
    feedEtag = '"feed-v2"';

    const newSyncResult = await sourceAdapter.actions.sync.execute(context, {});
    assert.deepEqual(newSyncResult.completedScopes, ["blog"]);

    // Exactly 1 feed request, 1 article request, and 1 media request
    assert.equal(requestLog.filter((p) => p === "/blog/feed.xml").length, 1);
    assert.equal(requestLog.filter((p) => p === "/blog/article-new").length, 1);
    assert.equal(
      requestLog.filter((p) => p === "/images/architecture.png").length,
      1,
    );
    // None of the 55 historical items were fetched
    assert.equal(
      requestLog.some((p) => p.startsWith("/blog/history-")),
      false,
    );

    // Exactly 1 article submitted to archive
    assert.equal(submissions.length, 1);
    const submittedItem = submissions[0]!.items[0]!;
    assert.deepEqual(submittedItem.sourceKey, {
      namespace: "huggingface:blog",
      key: "article-new",
    });
    assert.equal(submittedItem.sourceRef, `${origin}/blog/article-new`);
    assert.ok(
      submittedItem.body?.searchText?.includes("New Diffusion Model Release"),
    );

    // Body content verification
    const markdown = submittedItem.body?.markdown ?? "";
    assert.ok(markdown.includes("We are introducing a new diffusion model."));
    assert.ok(markdown.includes("import torch"));
    assert.ok(markdown.includes("binny://resource/"));

    // Excluded sections verification: navigation, comments, recommendations, upvotes
    assert.equal(markdown.includes("Back to blog"), false);
    assert.equal(markdown.includes("Community"), false);
    assert.equal(markdown.includes("User comment"), false);
    assert.equal(markdown.includes("More articles from our Blog"), false);
    assert.equal(markdown.includes("Upvote"), false);
    assert.equal(markdown.includes("Footer copyright"), false);

    assert.equal(submittedItem.title, "New Diffusion Model Release");
    assert.deepEqual(submittedItem.sourcePublishedAt, {
      precision: "instant",
      value: "2024-05-10T16:00:00+02:00",
    });
    assert.equal(submittedItem.sourceModifiedAt, null);
    assert.ok(Array.isArray(submittedItem.extensions.authors));
    assert.equal(submittedItem.extensions.authors.length, 1);
    assert.deepEqual(submittedItem.extensions.authors[0], {
      name: "Sylvain Gugger",
      handle: "sylvaing",
      url: "https://huggingface.co/sylvaing",
    });

    assert.ok(submittedItem.extensions.categories.includes("nlp"));
    assert.ok(submittedItem.extensions.categories.includes("diffusion"));
    assert.ok(submittedItem.extensions.categories.includes("deep-learning"));
    assert.equal(submittedItem.extensions.region, "international");
    assert.equal(submittedItem.extensions.language, "en");
    assert.equal(
      Object.hasOwn(submittedItem.extensions, "articlePublishedAt"),
      false,
    );

    // Media resources verification
    assert.equal(submittedItem.resources?.length, 1);
    assert.equal(submittedItem.capture.completeness, "complete");

    // State entry updated for new item
    const newEntry =
      storedPersistentState?.scopes["blog"]?.entries["article-new"];
    assert.ok(newEntry !== undefined);
    assert.equal(newEntry.archivedCompleteness, "complete");

    // -------------------------------------------------------------
    // Test 5: Collect with explicit itemUrls
    // -------------------------------------------------------------
    submissions.length = 0;
    const collectUrlsResult = await sourceAdapter.actions.collect.execute(
      context,
      {
        itemUrls: [`${origin}/blog/history-1`, `${origin}/blog/history-2`],
      },
    );
    assert.deepEqual(collectUrlsResult.completedScopes, ["blog"]);
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0]!.items[0]!.sourceKey.key, "history-1");
    assert.equal(submissions[1]!.items[0]!.sourceKey.key, "history-2");

    // -------------------------------------------------------------
    // Test 6: Collect with maxItems limits items and omits truncated scope from completedScopes
    // -------------------------------------------------------------
    submissions.length = 0;
    const collectMaxResult = await sourceAdapter.actions.collect.execute(
      context,
      {
        maxItems: 3,
      },
    );
    assert.deepEqual(collectMaxResult.completedScopes, []);
    assert.equal(submissions.length, 3);

    // -------------------------------------------------------------
    // Test 7: Collect without parameters does not silently truncate to 20 items
    // -------------------------------------------------------------
    submissions.length = 0;
    const collectDefaultResult = await sourceAdapter.actions.collect.execute(
      context,
      {},
    );
    assert.deepEqual(collectDefaultResult.completedScopes, ["blog"]);
    assert.equal(submissions.length, 56);

    // -------------------------------------------------------------
    // Test 8: Subsequent sync with 304 Not Modified triggers 0 article fetches
    // -------------------------------------------------------------
    requestLog.length = 0;
    submissions.length = 0;
    const sync304Result = await sourceAdapter.actions.sync.execute(context, {});
    assert.deepEqual(sync304Result.completedScopes, ["blog"]);
    assert.equal(requestLog.length, 1);
    assert.equal(requestLog[0], "/blog/feed.xml");
    assert.equal(submissions.length, 0);

    // -------------------------------------------------------------
    // Test 9: Reject failed / empty articles without creating title-only fallback
    // -------------------------------------------------------------
    submissions.length = 0;
    await assert.rejects(
      async () => {
        await sourceAdapter.actions.collect.execute(context, {
          itemUrls: [`${origin}/blog/article-404`],
        });
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "article_fetch_failed");
        return true;
      },
    );
    // Never archive a title-only fallback on 404
    assert.equal(submissions.length, 0);

    await assert.rejects(
      async () => {
        await sourceAdapter.actions.collect.execute(context, {
          itemUrls: [`${origin}/blog/article-empty`],
        });
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "article_content_empty");
        return true;
      },
    );
    // Never archive a title-only fallback on empty content
    assert.equal(submissions.length, 0);

    // -------------------------------------------------------------
    // Test 10: Check failure when feed is unreachable
    // -------------------------------------------------------------
    const brokenContext = createSourceAdapterContext(
      client,
      {
        ...runContext,
        config: {
          feedUrl: `http://127.0.0.1:59999/blog/feed.xml`,
          defaultCollectMaxItems: 20,
        },
      },
      sourceAdapter.extensionsSchema,
    );
    const brokenCheckResult = await sourceAdapter.actions.check.execute(
      brokenContext,
      {},
    );
    assert.equal(brokenCheckResult.availability, "unavailable");
    assert.equal(brokenCheckResult.problems.length, 1);
    assert.equal(brokenCheckResult.problems[0]!.code, "feed_unavailable");
  } finally {
    server.close();
  }
});

void test("Hugging Face blog HTML extractor strips unwanted sections and preserves structure and metadata", () => {
  const html = `<!doctype html>
    <html>
    <head>
      <title>Fine-Tuning Techniques - Hugging Face</title>
      <meta name="author" content="Philipp Schmid">
      <meta property="article:author" content="https://huggingface.co/philschmid">
      <meta property="article:tag" content="llm">
      <meta property="article:tag" content="training">
    </head>
    <body>
      <nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
      <article>
        <header>
          <div class="breadcrumb"><a href="/blog">Back to blog</a></div>
          <h1>Fine-Tuning Techniques</h1>
          <div class="authors">
            <a href="/philschmid">Philipp Schmid</a>
          </div>
          <time datetime="2024-06-15">June 15, 2024</time>
        </header>
        <div class="blog-content">
          <p>Introductory paragraph with an <a href="https://example.com/ref">external reference</a>.</p>
          <h2>Code Example</h2>
          <pre><code class="language-python">def train_epoch(model, loader):
    for batch in loader:
        loss = model(batch)
        loss.backward()</code></pre>
          <h2>Benchmark Results</h2>
          <table>
            <thead>
              <tr><th>Method</th><th>Score</th></tr>
            </thead>
            <tbody>
              <tr><td>Full</td><td>89.2</td></tr>
              <tr><td>LoRA</td><td>88.9</td></tr>
            </tbody>
          </table>
          <img src="/assets/benchmark.png" alt="Benchmark Chart" />
        </div>
        <div class="upvote-button">
          <button aria-label="Upvote this post">Upvote 256</button>
        </div>
        <div class="community-comments">
          <h2>Community</h2>
          <p>Great findings!</p>
        </div>
        <div class="more-articles">
          <h3>More articles from our Blog</h3>
          <a href="/blog/prev">Previous post</a>
        </div>
      </article>
      <footer>Footer contents</footer>
    </body>
    </html>`;

  const extracted = extractArticle(
    html,
    "https://huggingface.co/blog/fine-tuning",
  );
  assert.ok(extracted !== undefined);
  assert.equal(extracted.title, "Fine-Tuning Techniques");
  assert.equal(extracted.cleanResult.hasSubstantialContent, true);

  // Factual authors and tags
  assert.deepEqual(extracted.authors, [
    {
      name: "Philipp Schmid",
      handle: "philschmid",
      url: "https://huggingface.co/philschmid",
    },
  ]);
  assert.ok(extracted.categories.includes("llm"));
  assert.ok(extracted.categories.includes("training"));

  // Exact date precision preserved
  assert.equal(extracted.articlePublishedAt, "2024-06-15");

  // Content verification
  const md = extracted.cleanResult.markdown;
  assert.ok(md.includes("Introductory paragraph"));
  assert.ok(md.includes("def train_epoch(model, loader):"));
  assert.ok(md.includes("loss.backward()"));
  assert.ok(md.includes("Method"));
  assert.ok(md.includes("LoRA"));
  assert.ok(md.includes("https://example.com/ref"));
  assert.ok(
    md.includes(
      "![Benchmark Chart](https://huggingface.co/assets/benchmark.png)",
    ),
  );

  // Stripped sections
  assert.equal(md.includes("Back to blog"), false);
  assert.equal(md.includes("Community"), false);
  assert.equal(md.includes("Great findings"), false);
  assert.equal(md.includes("More articles from our Blog"), false);
  assert.equal(md.includes("Upvote"), false);
  assert.equal(md.includes("Footer contents"), false);

  // Media candidates
  assert.equal(extracted.cleanResult.media.length, 1);
  assert.equal(
    extracted.cleanResult.media[0]!.url,
    "https://huggingface.co/assets/benchmark.png",
  );
});

void test("Hugging Face sync reports bodyGaps and partial completion for A/B/C, skips unchanged B on 304 and 200, and heals via fingerprint update", async () => {
  let storedPersistentState: IncrementalSyncState | undefined;
  const persistentState = {
    async load() {
      return storedPersistentState as unknown as JsonObject | undefined;
    },
    async save(state: JsonObject) {
      storedPersistentState = state as unknown as IncrementalSyncState;
    },
  };

  let feedVersion: 1 | 2 | 3 = 1;
  let serveEtag = true;
  let itemBMode: "503" | "empty" | "ok" = "503";
  let fetchCountA = 0;
  let fetchCountB = 0;
  let fetchCountC = 0;
  const seenIfNoneMatch: (string | undefined)[] = [];

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/blog/feed.xml") {
      const etag = `"hf-partial-v${feedVersion}"`;
      seenIfNoneMatch.push(req.headers["if-none-match"]);
      if (serveEtag && req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      const items = [
        `<item><title>Base</title><link>${origin}/blog/base</link><guid>base</guid></item>`,
      ];
      if (feedVersion >= 2) {
        items.push(
          `<item><title>Post A</title><link>${origin}/blog/post-a</link><guid>post-a</guid></item>`,
          `<item><title>${feedVersion === 3 ? "Post B Updated" : "Post B"}</title><link>${origin}/blog/post-b</link><guid>post-b</guid><pubDate>${feedVersion === 3 ? "Tue, 07 May 2024 10:30:00 +0530" : "Mon, 06 May 2024 09:30:00 +0530"}</pubDate><category>engineering</category></item>`,
          `<item><title>Post C</title><link>${origin}/blog/post-c</link><guid>post-c</guid></item>`,
        );
      }
      res.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        ...(serveEtag ? { etag } : {}),
      });
      res.end(
        `<rss version="2.0"><channel><title>HF</title>${items.join("")}</channel></rss>`,
      );
      return;
    }
    if (path === "/blog/post-a") {
      fetchCountA += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<div class='blog-content'><h1>Post A</h1><p>Body for Post A.</p></div>",
      );
      return;
    }
    if (path === "/blog/post-b") {
      fetchCountB += 1;
      if (itemBMode === "503") {
        res.writeHead(503);
        res.end("Upstream 503");
        return;
      }
      if (itemBMode === "empty") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body><nav>Nav only</nav></body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<article><header><h1>Post B</h1><time datetime="2024-05-10T16:00:00+02:00">May 10, 2024</time></header><div class='blog-content'><p>Body for Post B.</p><span class="tag">systems</span></div></article>`,
      );
      return;
    }
    if (path === "/blog/post-c") {
      fetchCountC += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<div class='blog-content'><h1>Post C</h1><p>Body for Post C.</p></div>",
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

  const submissions: HuggingFaceSubmission[] = [];
  const client = {
    archives: {
      async $post({ json }: { json: HuggingFaceSubmission }) {
        submissions.push(json);
        return {
          status: 201,
          async json() {
            return {
              commitId: randomUUID(),
              archiveSeq: String(submissions.length),
              binId: "hf-partial-bin",
              runId: randomUUID(),
              sourceAdapterVersion: sourceAdapter.version,
              observedAt: "2026-11-07T12:00:00.000Z",
              recordedAt: "2026-11-07T12:00:00.000Z",
              items: json.items.map((it) => ({
                itemId: randomUUID(),
                revisionId: randomUUID(),
                sourceKey: it.sourceKey,
              })),
              relations: [],
            };
          },
        };
      },
    },
    resources: {
      async $post() {
        return {
          status: 201,
          async json() {
            return {};
          },
        };
      },
      resolve: {
        async $post() {
          return {
            status: 200,
            async json() {
              return { resources: [], items: [], mediaByUrl: {} };
            },
          };
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  const makeContext = (signal = new AbortController().signal) =>
    createSourceAdapterContext(
      client,
      {
        binId: "hf-partial-bin",
        identityId: "hf-partial-id",
        runId: randomUUID(),
        referenceTime: "2026-11-07T12:00:00.000Z",
        sourceAdapterVersion: sourceAdapter.version,
        config: { feedUrl: `${origin}/blog/feed.xml` },
        signal,
        persistentState,
        report: async () => {},
      },
      sourceAdapter.extensionsSchema,
    );

  try {
    const baseRes = await sourceAdapter.actions.sync.execute(makeContext(), {});
    assert.equal(baseRes.collectionCompleteness, "complete");
    assert.deepEqual(baseRes.completedScopes, ["blog"]);
    assert.equal(
      storedPersistentState?.scopes["blog"]?.etag,
      '"hf-partial-v1"',
    );

    // Feed updates to v2: A succeeds, B returns 503, C succeeds
    feedVersion = 2;
    itemBMode = "503";
    const gapSync = await sourceAdapter.actions.sync.execute(makeContext(), {});
    assert.equal(gapSync.collectionCompleteness, "partial");
    assert.deepEqual(gapSync.completedScopes, []);
    assert.deepEqual(gapSync.incompleteScopes, [
      {
        scope: "blog",
        reasonCode: "article_body_unavailable",
        message:
          "1 of 3 changed feed items had unavailable article body; 2 items were archived.",
      },
    ]);
    assert.deepEqual(gapSync.bodyGaps, [
      {
        scope: "blog",
        itemKey: "post-b",
        url: `${origin}/blog/post-b`,
        stage: "fetching-article",
        code: "article_http_error",
        reason: "Article HTTP request returned status 503.",
        httpStatus: 503,
      },
    ]);

    assert.equal(fetchCountA, 1);
    assert.equal(fetchCountB, 1);
    assert.equal(fetchCountC, 1);
    assert.equal(submissions.length, 2);
    assert.equal(
      storedPersistentState?.scopes["blog"]?.entries["post-a"]
        ?.archivedCompleteness,
      "complete",
    );
    assert.equal(
      storedPersistentState?.scopes["blog"]?.entries["post-c"]
        ?.archivedCompleteness,
      "complete",
    );
    const gapEntryB = storedPersistentState?.scopes["blog"]?.entries["post-b"];
    assert.ok(gapEntryB !== undefined);
    assert.equal(gapEntryB.archivedCompleteness, undefined);
    assert.equal(gapEntryB.bodyGap?.httpStatus, 503);
    assert.equal(
      storedPersistentState?.scopes["blog"]?.etag,
      '"hf-partial-v2"',
    );

    // Unchanged sync with 304 skips B
    const sync304 = await sourceAdapter.actions.sync.execute(makeContext(), {});
    assert.equal(sync304.collectionCompleteness, "complete");
    assert.deepEqual(sync304.completedScopes, ["blog"]);
    assert.equal(seenIfNoneMatch.at(-1), '"hf-partial-v2"');
    assert.equal(fetchCountA, 1);
    assert.equal(fetchCountB, 1);
    assert.equal(fetchCountC, 1);

    // Unchanged sync with 200 XML (no ETag) also skips B
    serveEtag = false;
    const sync200 = await sourceAdapter.actions.sync.execute(makeContext(), {});
    assert.equal(sync200.collectionCompleteness, "complete");
    assert.deepEqual(sync200.completedScopes, ["blog"]);
    assert.equal(fetchCountA, 1);
    assert.equal(fetchCountB, 1);
    assert.equal(fetchCountC, 1);

    // Fingerprint updates on v3 while B is empty -> records extraction gap; then explicit collect heals B and subsequent 200 sync skips B even when page <time> differs from RSS <pubDate>
    feedVersion = 3;
    itemBMode = "empty";
    const emptySync = await sourceAdapter.actions.sync.execute(
      makeContext(),
      {},
    );
    assert.equal(emptySync.collectionCompleteness, "partial");
    assert.equal(emptySync.bodyGaps?.[0]?.stage, "extracting-article");
    assert.equal(emptySync.bodyGaps?.[0]?.code, "article_content_empty");
    assert.equal(fetchCountB, 2);

    // Backfill B via collect({ itemUrls }) -> subsequent non-304 200 sync skips B (0 re-fetches!)
    itemBMode = "ok";
    const collectRes = await sourceAdapter.actions.collect.execute(
      makeContext(),
      { itemUrls: [emptySync.bodyGaps[0].url] },
    );
    assert.deepEqual(collectRes.completedScopes, ["blog"]);
    assert.equal(fetchCountB, 3);
    assert.equal(submissions.length, 3);
    assert.equal(submissions[2]?.items[0]?.sourceKey.key, "post-b");
    assert.equal(
      storedPersistentState?.scopes["blog"]?.entries["post-b"]?.bodyGap,
      undefined,
    );
    assert.equal(
      storedPersistentState?.scopes["blog"]?.entries["post-b"]
        ?.archivedCompleteness,
      "complete",
    );

    const postBackfillSync = await sourceAdapter.actions.sync.execute(
      makeContext(),
      {},
    );
    assert.equal(postBackfillSync.collectionCompleteness, "complete");
    assert.deepEqual(postBackfillSync.completedScopes, ["blog"]);
    assert.equal(
      fetchCountB,
      3,
      "Post-backfill sync must not re-fetch B when page <time> differs from RSS <pubDate>",
    );

    // Also verify auto-healing via fingerprint change on sync
    feedVersion = 2;
    itemBMode = "503";
    const gapAgain = await sourceAdapter.actions.sync.execute(
      makeContext(),
      {},
    );
    assert.equal(gapAgain.collectionCompleteness, "partial");
    assert.equal(fetchCountB, 4);

    feedVersion = 3;
    itemBMode = "ok";
    const healedBySync = await sourceAdapter.actions.sync.execute(
      makeContext(),
      {},
    );
    assert.equal(healedBySync.collectionCompleteness, "complete");
    assert.deepEqual(healedBySync.completedScopes, ["blog"]);
    assert.equal(healedBySync.bodyGaps, undefined);
    assert.equal(fetchCountB, 5);
    assert.equal(
      storedPersistentState?.scopes["blog"]?.entries["post-b"]?.bodyGap,
      undefined,
    );
  } finally {
    server.close();
  }
});

void test("Hugging Face explicit collect aligns fingerprint even when feed is unreachable and preserves retry on feed/cancel/archive errors", async () => {
  let storedPersistentState: IncrementalSyncState | undefined;
  const currentState = () => storedPersistentState;
  const persistentState = {
    async load() {
      return storedPersistentState as unknown as JsonObject | undefined;
    },
    async save(state: JsonObject) {
      storedPersistentState = state as unknown as IncrementalSyncState;
    },
  };

  let feedVersion: 1 | 2 = 1;
  let feedMode: "ok" | "500" | "invalid-xml" = "ok";
  let itemBFails = true;
  let fetchCountB = 0;
  let cancelOnB = false;
  let archiveShouldFailOnKey: string | undefined;
  let controller = new AbortController();

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/blog/feed.xml") {
      if (feedMode === "500") {
        res.writeHead(500);
        res.end("Feed 500");
        return;
      }
      if (feedMode === "invalid-xml") {
        res.writeHead(200, { "content-type": "application/rss+xml" });
        res.end("<rss><unclosed");
        return;
      }
      const etag = `"hf-retry-v${feedVersion}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      const items = [
        `<item><title>Base</title><link>${origin}/blog/base</link><guid>base</guid></item>`,
      ];
      if (feedVersion === 2) {
        items.push(
          `<item><title>Post A</title><link>${origin}/blog/post-a</link><guid>post-a</guid></item>`,
          `<item><title>Post B</title><link>${origin}/blog/post-b</link><guid>post-b</guid><pubDate>Mon, 06 May 2024 09:30:00 +0530</pubDate><category>engineering</category></item>`,
          `<item><title>Post C</title><link>${origin}/blog/post-c</link><guid>post-c</guid></item>`,
        );
      }
      res.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        etag,
      });
      res.end(
        `<rss version="2.0"><channel><title>HF</title>${items.join("")}</channel></rss>`,
      );
      return;
    }
    if (path === "/blog/post-a") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<div class='blog-content'><h1>Post A</h1><p>Body A.</p></div>");
      return;
    }
    if (path === "/blog/post-b") {
      fetchCountB += 1;
      if (cancelOnB) {
        controller.abort(createActionCancelledReason());
      }
      if (itemBFails) {
        res.writeHead(503);
        res.end("Unavailable");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<article><header><h1>Post B</h1><time datetime="2024-05-12T16:00:00+02:00">May 12, 2024</time></header><div class='blog-content'><p>Body B.</p><span class="tag">systems</span></div></article>`,
      );
      return;
    }
    if (path === "/blog/post-c") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<div class='blog-content'><h1>Post C</h1><p>Body C.</p></div>");
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

  const submissions: HuggingFaceSubmission[] = [];
  const client = {
    archives: {
      async $post({ json }: { json: HuggingFaceSubmission }) {
        const key = json.items[0]?.sourceKey.key;
        if (
          archiveShouldFailOnKey !== undefined &&
          key === archiveShouldFailOnKey
        ) {
          return {
            status: 503,
            async json() {
              return {
                error: {
                  code: "archive_unavailable",
                  message: "Archive unavailable.",
                },
              };
            },
          };
        }
        submissions.push(json);
        return {
          status: 201,
          async json() {
            return {
              commitId: randomUUID(),
              archiveSeq: String(submissions.length),
              binId: "hf-retry-bin",
              runId: randomUUID(),
              sourceAdapterVersion: sourceAdapter.version,
              observedAt: "2026-11-07T12:00:00.000Z",
              recordedAt: "2026-11-07T12:00:00.000Z",
              items: json.items.map((it) => ({
                itemId: randomUUID(),
                revisionId: randomUUID(),
                sourceKey: it.sourceKey,
              })),
              relations: [],
            };
          },
        };
      },
    },
    resources: {
      async $post() {
        return {
          status: 201,
          async json() {
            return {};
          },
        };
      },
      resolve: {
        async $post() {
          return {
            status: 200,
            async json() {
              return { resources: [], items: [], mediaByUrl: {} };
            },
          };
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  const makeContext = () =>
    createSourceAdapterContext(
      client,
      {
        binId: "hf-retry-bin",
        identityId: "hf-retry-id",
        runId: randomUUID(),
        referenceTime: "2026-11-07T12:00:00.000Z",
        sourceAdapterVersion: sourceAdapter.version,
        config: { feedUrl: `${origin}/blog/feed.xml` },
        signal: controller.signal,
        persistentState,
        report: async () => {},
      },
      sourceAdapter.extensionsSchema,
    );

  try {
    await sourceAdapter.actions.sync.execute(makeContext(), {});

    // 1. Feed 500 & invalid XML preserve etag and retry opportunity
    feedVersion = 2;
    feedMode = "500";
    await assert.rejects(
      () => sourceAdapter.actions.sync.execute(makeContext(), {}),
      (error: unknown) => isSourceAdapterActionError(error),
    );
    assert.equal(currentState()?.scopes["blog"]?.etag, '"hf-retry-v1"');

    feedMode = "invalid-xml";
    await assert.rejects(
      () => sourceAdapter.actions.sync.execute(makeContext(), {}),
      (error: unknown) => isSourceAdapterActionError(error),
    );
    assert.equal(currentState()?.scopes["blog"]?.etag, '"hf-retry-v1"');

    // 2. Cancellation during B preserves A, leaves B & C unrecorded, and keeps etag at v1
    feedMode = "ok";
    cancelOnB = true;
    await assert.rejects(
      () => sourceAdapter.actions.sync.execute(makeContext(), {}),
      (error: unknown) => isActionCancelledReason(error),
    );
    assert.equal(
      currentState()?.scopes["blog"]?.entries["post-a"]?.archivedCompleteness,
      "complete",
    );
    assert.equal(currentState()?.scopes["blog"]?.entries["post-b"], undefined);
    assert.equal(currentState()?.scopes["blog"]?.entries["post-c"], undefined);
    assert.equal(currentState()?.scopes["blog"]?.etag, '"hf-retry-v1"');

    // 3. Archive submit failure on B leaves B & C unrecorded (no bodyGap) and keeps etag at v1
    cancelOnB = false;
    itemBFails = false;
    controller = new AbortController();
    archiveShouldFailOnKey = "post-b";
    await assert.rejects(
      () => sourceAdapter.actions.sync.execute(makeContext(), {}),
      (error: unknown) => isSourceAdapterActionError(error),
    );
    assert.equal(currentState()?.scopes["blog"]?.entries["post-b"], undefined);
    assert.equal(currentState()?.scopes["blog"]?.entries["post-c"], undefined);
    assert.equal(currentState()?.scopes["blog"]?.etag, '"hf-retry-v1"');

    // 4. B fails on fetch -> bodyGap recorded; then explicit collect while feed is 500 uses scope.entries fingerprint so next 200 sync skips B
    archiveShouldFailOnKey = undefined;
    itemBFails = true;
    const gapSync = await sourceAdapter.actions.sync.execute(makeContext(), {});
    assert.equal(gapSync.collectionCompleteness, "partial");
    assert.equal(gapSync.bodyGaps?.length, 1);
    const fetchesAtGap = fetchCountB;

    itemBFails = false;
    feedMode = "500";
    const offlineCollect = await sourceAdapter.actions.collect.execute(
      makeContext(),
      { itemUrls: [gapSync.bodyGaps[0]!.url] },
    );
    assert.deepEqual(offlineCollect.completedScopes, ["blog"]);
    assert.equal(fetchCountB, fetchesAtGap + 1);
    assert.equal(
      currentState()?.scopes["blog"]?.entries["post-b"]?.bodyGap,
      undefined,
    );

    feedMode = "ok";
    const postOfflineCollectSync = await sourceAdapter.actions.sync.execute(
      makeContext(),
      {},
    );
    assert.equal(postOfflineCollectSync.collectionCompleteness, "complete");
    assert.equal(
      fetchCountB,
      fetchesAtGap + 1,
      "Offline-feed explicit collect must keep feed fingerprint so subsequent sync skips B",
    );
  } finally {
    server.close();
  }
});

void test("Hugging Face adapter classifies per-request timeout and propagates user cancellation", async () => {
  const client = {
    archives: {
      async $post() {
        throw new Error("unused");
      },
    },
    resources: {
      async $post() {
        throw new Error("unused");
      },
      resolve: {
        async $post() {
          return {
            status: 200,
            async json() {
              return {};
            },
          };
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  const controller = new AbortController();
  const context = createSourceAdapterContext(
    client,
    {
      binId: "hf-diag-bin",
      identityId: "hf-diag-id",
      runId: randomUUID(),
      referenceTime: "2026-11-07T12:00:00.000Z",
      sourceAdapterVersion: sourceAdapter.version,
      config: { feedUrl: "https://example.test/blog/feed.xml" },
      signal: controller.signal,
      persistentState: {
        async load() {
          return undefined;
        },
        async save() {},
      },
      report: async () => {},
    },
    sourceAdapter.extensionsSchema,
  );

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new DOMException("signal timed out", "TimeoutError");
    };
    await assert.rejects(
      () => sourceAdapter.actions.sync.execute(context, {}),
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.abortCause, "source_request_timeout");
        return true;
      },
    );

    globalThis.fetch = async (_input, init) => {
      controller.abort(createActionCancelledReason());
      throw init?.signal?.reason ?? createActionCancelledReason();
    };
    await assert.rejects(
      () => sourceAdapter.actions.sync.execute(context, {}),
      (error: unknown) => isActionCancelledReason(error),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
