// Tests for Mistral News source adapter actions and content extraction.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  createSourceAdapterContext,
  isSourceAdapterActionError,
  type ArchiveCommit,
  type ArchiveResourceMetadata,
  type IncrementalSyncState,
  type SourceAdapterApiClient,
  sourceAdapterManifest,
  type SourceAdapterRunContext,
} from "@binny/source-adapter-sdk";
import type { z } from "zod";

import { sourceAdapter } from "../src/index.ts";

type MistralConfig = z.output<typeof sourceAdapter.configSchema>;

void test("Mistral News source adapter end-to-end actions and extraction", async (t) => {
  let feedPhase = 1;
  let articleFetchCounts = {
    rich: 0,
    dateConflict: 0,
    emptyBody: 0,
    serverError: 0,
    mediaFail: 0,
    newItem: 0,
    modifiedItem: 0,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/news/rss") {
      const etag = `"mistral-rss-v${feedPhase}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }

      // CRITICAL: Mistral News RSS is served with text/plain; charset=utf-8
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        etag,
        "last-modified": "Wed, 04 Nov 2026 12:00:00 GMT",
      });

      if (feedPhase === 1) {
        // Initial baseline feed with two items
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mistral News</title>
    <link>${origin}/news/</link>
    <description>Latest news from Mistral AI</description>
    <item>
      <title>Mistral Rich Article</title>
      <link>${origin}/news/article-rich</link>
      <guid isPermaLink="true">${origin}/news/article-rich</guid>
      <description>Rich article summary description in RSS feed.</description>
      <pubDate>Thu, 29 Oct 2026 12:00:00 GMT</pubDate>
      <category>Engineering</category>
    </item>
    <item>
      <title>Mistral Date Conflict Article</title>
      <link>${origin}/news/article-date-conflict</link>
      <guid isPermaLink="true">${origin}/news/article-date-conflict</guid>
      <description>Date conflict article RSS description.</description>
      <pubDate>Thu, 29 Oct 2026 12:00:07 GMT</pubDate>
      <category>Models</category>
    </item>
  </channel>
</rss>`);
        return;
      }

      if (feedPhase === 2) {
        // Feed phase 2: Identical to phase 1 (no changes)
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mistral News</title>
    <link>${origin}/news/</link>
    <description>Latest news from Mistral AI</description>
    <item>
      <title>Mistral Rich Article</title>
      <link>${origin}/news/article-rich</link>
      <guid isPermaLink="true">${origin}/news/article-rich</guid>
      <description>Rich article summary description in RSS feed.</description>
      <pubDate>Thu, 29 Oct 2026 12:00:00 GMT</pubDate>
      <category>Engineering</category>
    </item>
    <item>
      <title>Mistral Date Conflict Article</title>
      <link>${origin}/news/article-date-conflict</link>
      <guid isPermaLink="true">${origin}/news/article-date-conflict</guid>
      <description>Date conflict article RSS description.</description>
      <pubDate>Thu, 29 Oct 2026 12:00:07 GMT</pubDate>
      <category>Models</category>
    </item>
  </channel>
</rss>`);
        return;
      }

      if (feedPhase === 3) {
        // Feed phase 3: article-rich modified, and new-item added
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mistral News</title>
    <link>${origin}/news/</link>
    <description>Latest news from Mistral AI</description>
    <item>
      <title>Mistral Rich Article Updated</title>
      <link>${origin}/news/article-rich</link>
      <guid isPermaLink="true">${origin}/news/article-rich</guid>
      <description>Updated RSS description for rich article.</description>
      <pubDate>Thu, 29 Oct 2026 12:00:00 GMT</pubDate>
      <category>Engineering</category>
    </item>
    <item>
      <title>Mistral Date Conflict Article</title>
      <link>${origin}/news/article-date-conflict</link>
      <guid isPermaLink="true">${origin}/news/article-date-conflict</guid>
      <description>Date conflict article RSS description.</description>
      <pubDate>Thu, 29 Oct 2026 12:00:07 GMT</pubDate>
      <category>Models</category>
    </item>
    <item>
      <title>Mistral Brand New Item</title>
      <link>${origin}/news/new-item</link>
      <guid isPermaLink="true">${origin}/news/new-item</guid>
      <description>Brand new item description.</description>
      <pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate>
      <category>Announcements</category>
    </item>
  </channel>
</rss>`);
        return;
      }

      if (feedPhase === 4) {
        // Feed phase 4: includes items that fail on article HTML fetch
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mistral News</title>
    <link>${origin}/news/</link>
    <description>Latest news from Mistral AI</description>
    <item>
      <title>Article with Server Error 500</title>
      <link>${origin}/news/article-500</link>
      <guid isPermaLink="true">${origin}/news/article-500</guid>
      <description>This description MUST NOT be archived as body.</description>
      <pubDate>Sat, 31 Oct 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`);
        return;
      }

      if (feedPhase === 5) {
        // Feed phase 5: includes item with empty body
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mistral News</title>
    <link>${origin}/news/</link>
    <description>Latest news from Mistral AI</description>
    <item>
      <title>Article with Empty Body</title>
      <link>${origin}/news/article-empty-body</link>
      <guid isPermaLink="true">${origin}/news/article-empty-body</guid>
      <description>Empty body fallback attempt description.</description>
      <pubDate>Sun, 01 Nov 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`);
        return;
      }

      if (feedPhase === 6) {
        // Feed phase 6: item with media fetch failure
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mistral News</title>
    <link>${origin}/news/</link>
    <description>Latest news from Mistral AI</description>
    <item>
      <title>Article with Media Failure</title>
      <link>${origin}/news/article-media-fail</link>
      <guid isPermaLink="true">${origin}/news/article-media-fail</guid>
      <description>Media failure description.</description>
      <pubDate>Mon, 02 Nov 2026 10:00:00 +0230</pubDate>
    </item>
  </channel>
</rss>`);
        return;
      }
    }

    if (path === "/news/article-rich") {
      articleFetchCounts.rich += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Mistral Large 4 Released | Mistral</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": "Mistral Large 4 Released",
    "datePublished": "2026-10-29T12:00:00.000Z",
    "dateModified": "2026-10-29T14:30:00.000Z",
    "author": { "@type": "Person", "name": "Arthur Mensch" },
    "articleSection": "Engineering"
  }
  </script>
</head>
<body>
  <global-navigation>
    <header class="site-header">
      <nav class="site-nav"><a href="/news/">Back to Blog</a></nav>
    </header>
  </global-navigation>

  <main id="main">
    <article id="blogpost">
      <section class="h-[90svh]">
        <div class="share-buttons">
          <button>Share on Twitter</button>
          <mistral-atom-button-copy-clipboard data-text="https://mistral.ai/news/article-rich">Copy url to clipboard</mistral-atom-button-copy-clipboard>
          <a href="/news/">Back to Blog</a>
        </div>
      </section>

      <div class="lg:border-b border-border-primary">
        <div class="relative lg:flex lg:gap-10">
          <div class="flex flex-col gap-4 w-full">
            <h1>Mistral Large 4 Released</h1>
            <p>Mistral Large 4 is our latest flagship open-weight multimodal model for coding and reasoning.</p>
            <pre><code class="language-python">from mistralai import Mistral
client = Mistral()
response = client.chat.complete(model="mistral-large-4", messages=[{"role": "user", "content": "Hello"}])</code></pre>
            <p>Here are the benchmark results compared to previous generations:</p>
            <table>
              <thead>
                <tr><th>Model</th><th>HumanEval</th><th>MMLU</th></tr>
              </thead>
              <tbody>
                <tr><td>Mistral Large 4</td><td>92.4%</td><td>88.6%</td></tr>
                <tr><td>Mistral Large 2</td><td>84.5%</td><td>84.5%</td></tr>
              </tbody>
            </table>
            <p>System architecture diagram:</p>
            <img src="/media/diagram.png" alt="Architecture Diagram" />
          </div>

          <div class="w-full lg:w-96 shrink-0 border-border-primary">
            <div class="author-banner">
              <p>Mistral Large 4 Model Card</p>
              <button>Deploy on Le Chat</button>
            </div>
          </div>
        </div>
      </div>

      <div class="related-articles">
        <h2>Related articles</h2>
        <ul>
          <li><a href="/news/voxtral">Voxtral 3 Announcement</a></li>
        </ul>
      </div>

      <mistral-section-blog-footer>
        <span>0%</span>
      </mistral-section-blog-footer>
    </article>
  </main>

  <global-footer>
    <footer class="site-footer">
      <p>Copyright 2026 Mistral AI</p>
    </footer>
  </global-footer>
</body>
</html>`);
      return;
    }

    if (path === "/news/article-date-conflict") {
      articleFetchCounts.dateConflict += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Voxtral 3: Real-Time Audio | Mistral</title>
  <script type="application/ld+json">
  {
    "@graph": [
      {
        "@type": "BlogPosting",
        "headline": "Voxtral 3: Speech-to-Text, TTS & Voice Agents",
        "datePublished": "2026-10-31T09:00:00+02:00",
        "dateModified": "2026-11-01T15:30:00+02:00",
        "author": { "name": "Mistral Speech Team" },
        "articleSection": "Product Announcements",
        "keywords": "voice agent, speech, transcription"
      }
    ]
  }
  </script>
  <meta property="article:published_time" content="2026-10-31T09:00:00+02:00" />
  <meta property="article:modified_time" content="2026-11-01T15:30:00+02:00" />
</head>
<body>
  <main>
    <article>
      <time datetime="2026-10-31">October 31, 2026</time>
      <h1>Voxtral 3: Speech and Audio AI</h1>
      <p>Voxtral 3 brings real-time multi-step conversations across 50 languages.</p>
    </article>
  </main>
</body>
</html>`);
      return;
    }

    if (path === "/news/new-item") {
      articleFetchCounts.newItem += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Brand New Article</title></head>
<body>
  <article>
    <h1>Brand New Mistral Article</h1>
    <p>This is a brand new article added in a subsequent sync run.</p>
  </article>
</body>
</html>`);
      return;
    }

    if (path === "/news/article-500") {
      articleFetchCounts.serverError += 1;
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }

    if (path === "/news/article-empty-body") {
      articleFetchCounts.emptyBody += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Empty</title></head>
<body>
  <main>
    <article>
      <header>Site Header</header>
      <div class="share-buttons"><button>Share</button></div>
      <div class="related-articles"><h3>Related articles</h3></div>
      <footer>Site Footer</footer>
    </article>
  </main>
</body>
</html>`);
      return;
    }

    if (path === "/news/article-media-fail") {
      articleFetchCounts.mediaFail += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Media Fail</title></head>
<body>
  <article>
    <h1>Article with Failed Media</h1>
    <p>This article contains a media image that fails to download.</p>
    <img src="/media/broken-image.png" alt="Broken Diagram" />
  </article>
</body>
</html>`);
      return;
    }

    if (path === "/media/diagram.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]));
      return;
    }

    if (path === "/media/broken-image.png") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
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

  let storedPersistentState: IncrementalSyncState | undefined;
  const persistentState = {
    async load() {
      return storedPersistentState;
    },
    async save(state: unknown) {
      storedPersistentState = state as IncrementalSyncState;
    },
  };

  type ApiArchiveSubmission = Parameters<
    SourceAdapterApiClient["archives"]["$post"]
  >[0]["json"];
  const submissions: ApiArchiveSubmission[] = [];
  let commitCount = 0;

  const mockApiClient = {
    archives: {
      $post: async ({ json }: { json: ApiArchiveSubmission }) => {
        submissions.push(json);
        commitCount += 1;
        const commit: ArchiveCommit = {
          commitId: randomUUID(),
          archiveSeq: String(commitCount),
          binId: json.binId,
          runId: json.runId,
          sourceAdapterVersion: json.sourceAdapterVersion,
          observedAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          items: json.items.map((item) => ({
            itemId: randomUUID(),
            revisionId: randomUUID(),
            sourceKey: item.sourceKey,
          })),
          relations: [],
        };
        return new Response(JSON.stringify(commit), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    },
    resources: {
      $post: async (_params: unknown, options: { init?: RequestInit }) => {
        const bytes = options?.init?.body
          ? await new Response(options.init.body as BodyInit).arrayBuffer()
          : new ArrayBuffer(0);
        const resource: ArchiveResourceMetadata = {
          resourceId: randomUUID(),
          sha256: "0".repeat(64),
          mediaType: "image/png",
          size: bytes.byteLength,
        };
        return new Response(JSON.stringify(resource), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
      resolve: {
        $post: async () => {
          return new Response(
            JSON.stringify({ resources: [], items: [], mediaByUrl: {} }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  function createTestContext(config: MistralConfig) {
    const runContext: SourceAdapterRunContext<MistralConfig, never> = {
      binId: "mistral-test-bin",
      identityId: "mistral-test-identity",
      runId: randomUUID(),
      referenceTime: "2026-11-07T12:00:00.000Z",
      sourceAdapterVersion: sourceAdapter.version,
      config,
      signal: new AbortController().signal,
      persistentState,
    };
    return createSourceAdapterContext(
      mockApiClient,
      runContext,
      sourceAdapter.extensionsSchema,
    );
  }

  const defaultContext = createTestContext({ rssUrl: `${origin}/news/rss` });

  try {
    // Test 1: Adapter manifest and action exports
    await t.test("mistral adapter exports correct manifest and actions", () => {
      assert.equal(sourceAdapter.id, "mistral");
      assert.equal(sourceAdapter.version, "0.1.0");
      assert.ok(sourceAdapter.actions.check);
      assert.ok(sourceAdapter.actions.collect);
      assert.ok(sourceAdapter.actions.sync);

      const manifest = sourceAdapterManifest(sourceAdapter);
      assert.equal(manifest.extensionsSchema.additionalProperties, false);
      const extensionFields = manifest.extensionsSchema.properties as Record<
        string,
        { readonly description?: string }
      >;
      for (const field of Object.values(extensionFields)) {
        assert.ok(field.description);
      }

      // Verify default configSchema accepts {}
      const parsedConfig = sourceAdapter.configSchema.parse({});
      assert.equal(parsedConfig.rssUrl, "https://mistral.ai/news/rss");
    });

    // Test 2: Check action discovers feed with text/plain Content-Type and validates HTML extraction
    await t.test(
      "check action discovers feed with text/plain Content-Type and validates sample HTML extraction",
      async () => {
        const result = await sourceAdapter.actions.check.execute(
          defaultContext,
          {},
        );
        assert.equal(result.availability, "available");
        assert.deepEqual(result.scope, ["news"]);
        assert.equal(result.problems.length, 0);
        assert.ok(articleFetchCounts.rich >= 1);
      },
    );

    // Test 3: Collect action extracts HTML preserving headings, code, tables, media; stripping noise; NO body.html
    await t.test(
      "collect action extracts article HTML preserving structure and media without body.html, stripping nav/footer/cards",
      async () => {
        submissions.length = 0;
        const result = await sourceAdapter.actions.collect.execute(
          defaultContext,
          {
            itemUrls: [`${origin}/news/article-rich`],
          },
        );

        assert.deepEqual(result.completedScopes, ["news"]);
        assert.equal(submissions.length, 1);

        const item = submissions[0]?.items[0];
        assert.ok(item);
        assert.deepEqual(item.sourceKey, {
          namespace: "mistral:news",
          key: "article-rich",
        });
        assert.equal(item.sourceRef, `${origin}/news/article-rich`);
        assert.equal(item.title, "Mistral Rich Article");
        assert.deepEqual(item.sourcePublishedAt, {
          precision: "instant",
          value: "2026-10-29T12:00:00.000Z",
        });
        assert.deepEqual(item.sourceModifiedAt, {
          precision: "instant",
          value: "2026-10-29T14:30:00.000Z",
        });
        const extensions = item.extensions as {
          readonly region: string;
          readonly language: string;
          readonly categories: readonly string[];
          readonly authors: readonly string[];
          readonly rssDescription?: string;
        };
        assert.deepEqual(extensions, {
          region: "international",
          language: "en",
          categories: ["Engineering"],
          authors: ["Arthur Mensch"],
          rssDescription: "Rich article summary description in RSS feed.",
        });

        // NO body.html allowed!
        assert.equal((item.body as Record<string, unknown>).html, undefined);

        const markdown = item.body?.markdown ?? "";

        // Preserved markdown structures
        assert.ok(
          markdown.includes("# Mistral Large 4 Released"),
          "Preserves headings",
        );
        assert.ok(
          markdown.includes("from mistralai import Mistral"),
          "Preserves code block text",
        );
        assert.ok(
          markdown.includes("| Model | HumanEval | MMLU |") ||
            (markdown.includes("Model") && markdown.includes("HumanEval")),
          "Preserves table headers",
        );
        assert.ok(markdown.includes("92.4%"), "Preserves table cells");
        assert.ok(
          markdown.includes("binny://resource/"),
          "Renders internal media reference in markdown",
        );
        assert.equal(item.resources?.length, 1);
        assert.equal(item.capture.completeness, "complete");

        // Stripped navigation, footers, share buttons, author cards, related cards
        assert.equal(markdown.includes("Site Header"), false);
        assert.equal(markdown.includes("Back to Blog"), false);
        assert.equal(markdown.includes("Share on Twitter"), false);
        assert.equal(markdown.includes("Copy url to clipboard"), false);
        assert.equal(markdown.includes("Model Card"), false);
        assert.equal(markdown.includes("Deploy on Le Chat"), false);
        assert.equal(markdown.includes("Related articles"), false);
        assert.equal(markdown.includes("Voxtral 3 Announcement"), false);
        assert.equal(markdown.includes("Copyright 2026 Mistral AI"), false);
        assert.equal(markdown.includes("0%"), false);
      },
    );

    // Test 4: Public date fields follow page JSON-LD publication and modification dates
    await t.test(
      "uses page JSON-LD publication and modification dates without duplicating dates in extensions",
      async () => {
        submissions.length = 0;
        const result = await sourceAdapter.actions.collect.execute(
          defaultContext,
          {
            itemUrls: [`${origin}/news/article-date-conflict`],
          },
        );

        assert.deepEqual(result.completedScopes, ["news"]);
        assert.equal(submissions.length, 1);

        const item = submissions[0]?.items[0];
        assert.ok(item);
        assert.equal(item.title, "Mistral Date Conflict Article");
        assert.deepEqual(item.sourcePublishedAt, {
          precision: "instant",
          value: "2026-10-31T09:00:00+02:00",
        });
        assert.deepEqual(item.sourceModifiedAt, {
          precision: "instant",
          value: "2026-11-01T15:30:00+02:00",
        });
        const extensions = item.extensions as {
          readonly region: string;
          readonly language: string;
          readonly categories: readonly string[];
          readonly authors: readonly string[];
        };
        assert.deepEqual(extensions.region, "international");
        assert.deepEqual(extensions.language, "en");
        assert.ok(extensions.categories.includes("Models"));
        assert.ok(extensions.categories.includes("Product Announcements"));
        assert.ok(extensions.authors.includes("Mistral Speech Team"));
        assert.equal("articlePublishedAt" in extensions, false);
        assert.equal("articleUpdatedAt" in extensions, false);
        assert.equal("visibleDate" in extensions, false);
      },
    );

    // Test 5: Initial sync establishes baseline with 0 article HTML fetches
    await t.test(
      "sync initial baseline establishes entries without fetching historical article HTML pages",
      async () => {
        storedPersistentState = undefined;
        submissions.length = 0;
        articleFetchCounts.rich = 0;
        articleFetchCounts.dateConflict = 0;
        feedPhase = 1;

        const result = await sourceAdapter.actions.sync.execute(
          defaultContext,
          {},
        );

        assert.deepEqual(result.completedScopes, ["news"]);
        assert.deepEqual(result.initializedScopes, ["news"]);

        // Zero article HTML fetches and zero submissions on baseline sync
        assert.equal(articleFetchCounts.rich, 0);
        assert.equal(articleFetchCounts.dateConflict, 0);
        assert.equal(submissions.length, 0);

        // State is initialized and recorded
        assert.ok(storedPersistentState !== undefined);
        const currentState = storedPersistentState as IncrementalSyncState;
        const newsScope = currentState.scopes["news"];
        assert.ok(newsScope);
        assert.ok(newsScope.initializedAt);
        assert.equal(
          newsScope.entries["article-rich"]?.archivedCompleteness,
          "baseline",
        );
        assert.equal(
          newsScope.entries["article-date-conflict"]?.archivedCompleteness,
          "baseline",
        );
      },
    );

    // Test 6: Subsequent sync with unchanged feed skips article fetches
    await t.test(
      "subsequent sync with unchanged feed skips article HTML fetches and submissions",
      async () => {
        submissions.length = 0;
        articleFetchCounts.rich = 0;
        articleFetchCounts.dateConflict = 0;
        feedPhase = 2; // Same feed items

        const result = await sourceAdapter.actions.sync.execute(
          defaultContext,
          {},
        );

        assert.deepEqual(result.completedScopes, ["news"]);
        assert.equal(articleFetchCounts.rich, 0);
        assert.equal(articleFetchCounts.dateConflict, 0);
        assert.equal(submissions.length, 0);
      },
    );

    // Test 7: Subsequent sync with modified and new items fetches and archives only those items
    await t.test(
      "subsequent sync fetches and archives only new and modified items",
      async () => {
        submissions.length = 0;
        articleFetchCounts.rich = 0;
        articleFetchCounts.dateConflict = 0;
        articleFetchCounts.newItem = 0;
        feedPhase = 3; // article-rich updated description, new-item added, date-conflict unchanged

        const result = await sourceAdapter.actions.sync.execute(
          defaultContext,
          {},
        );

        assert.deepEqual(result.completedScopes, ["news"]);

        // Exactly 1 fetch for modified item, 1 fetch for new item, 0 for unchanged item
        assert.equal(articleFetchCounts.rich, 1);
        assert.equal(articleFetchCounts.newItem, 1);
        assert.equal(articleFetchCounts.dateConflict, 0);
        assert.equal(submissions.length, 2);

        const submittedKeys = submissions.map((s) => s.items[0]?.sourceKey.key);
        assert.ok(submittedKeys.includes("article-rich"));
        assert.ok(submittedKeys.includes("new-item"));
        assert.equal(submittedKeys.includes("article-date-conflict"), false);

        // Sync state updated
        const newsScope = storedPersistentState?.scopes["news"];
        assert.equal(
          newsScope?.entries["article-rich"]?.archivedCompleteness,
          "complete",
        );
        assert.equal(
          newsScope?.entries["new-item"]?.archivedCompleteness,
          "complete",
        );
      },
    );

    // Test 8: Failure handling - article HTML 500 error does NOT fall back to RSS summary
    await t.test(
      "article HTML 500 failure records problem and never falls back to archiving RSS summary",
      async () => {
        submissions.length = 0;
        feedPhase = 4; // article-500

        await assert.rejects(
          async () => {
            await sourceAdapter.actions.collect.execute(defaultContext, {});
          },
          (error: unknown) => {
            assert.ok(isSourceAdapterActionError(error));
            assert.equal(error.failure.code, "mistral_action_incomplete");
            return true;
          },
        );

        // Crucial requirement: NEVER archive the RSS summary as article body!
        assert.equal(submissions.length, 0);
      },
    );

    // Test 9: Failure handling - article yielding empty body does NOT fall back to RSS summary
    await t.test(
      "article yielding empty body fails and never falls back to archiving RSS summary",
      async () => {
        submissions.length = 0;
        feedPhase = 5; // article-empty-body

        await assert.rejects(
          async () => {
            await sourceAdapter.actions.collect.execute(defaultContext, {});
          },
          (error: unknown) => {
            assert.ok(isSourceAdapterActionError(error));
            assert.equal(error.failure.code, "mistral_action_incomplete");
            return true;
          },
        );

        // No submission occurred
        assert.equal(submissions.length, 0);
      },
    );

    // Test 10: Media failure marks capture.completeness as partial
    await t.test(
      "media download failure marks capture.completeness as partial and records missing media",
      async () => {
        submissions.length = 0;
        feedPhase = 6; // article-media-fail with broken-image.png

        const result = await sourceAdapter.actions.collect.execute(
          defaultContext,
          {
            itemUrls: [`${origin}/news/article-media-fail`],
          },
        );

        assert.deepEqual(result.completedScopes, ["news"]);
        assert.equal(submissions.length, 1);

        const item = submissions[0]?.items[0];
        assert.ok(item);
        assert.equal(item.title, "Article with Media Failure");
        assert.deepEqual(item.sourcePublishedAt, {
          precision: "instant",
          value: "2026-11-02T10:00:00+02:30",
        });
        assert.equal(item.sourceModifiedAt, null);
        assert.equal(item.capture.completeness, "partial");
        assert.ok(item.capture.missing.length >= 1);
        assert.ok(
          item.capture.missing.some((m: { reason: string }) =>
            m.reason.includes("404"),
          ),
        );
      },
    );
  } finally {
    server.close();
  }
});
