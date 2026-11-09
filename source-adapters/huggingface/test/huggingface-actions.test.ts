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
  createSourceAdapterContext,
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
  assert.equal(parsedConfig.defaultCollectMaxItems, 20);

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
    // Test 6: Collect with maxItems limits the number of collected items
    // -------------------------------------------------------------
    submissions.length = 0;
    const collectMaxResult = await sourceAdapter.actions.collect.execute(
      context,
      {
        maxItems: 3,
      },
    );
    assert.deepEqual(collectMaxResult.completedScopes, ["blog"]);
    assert.equal(submissions.length, 3);

    // -------------------------------------------------------------
    // Test 7: Collect without parameters defaults to defaultCollectMaxItems (20)
    // -------------------------------------------------------------
    submissions.length = 0;
    const collectDefaultResult = await sourceAdapter.actions.collect.execute(
      context,
      {},
    );
    assert.deepEqual(collectDefaultResult.completedScopes, ["blog"]);
    assert.equal(submissions.length, 20);

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
