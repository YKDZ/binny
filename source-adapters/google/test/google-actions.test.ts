import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  createSourceAdapterContext,
  isSourceAdapterActionError,
  sourceAdapterManifest,
  type ArchiveResourceMetadata,
  type IncrementalSyncState,
  type SourceAdapterApiClient,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import { sourceAdapter } from "../src/index.ts";

type GoogleConfig = z.output<typeof sourceAdapter.configSchema>;
type GoogleExtensions = z.output<typeof sourceAdapter.extensionsSchema>;
type GoogleContext = SourceAdapterContext<
  GoogleConfig,
  never,
  GoogleExtensions
>;
type GoogleSubmission = Parameters<GoogleContext["archive"]["submit"]>[0];

function createMockClient(
  submissions: GoogleSubmission[],
  resources: ArchiveResourceMetadata[],
): SourceAdapterApiClient {
  return {
    archives: {
      $post: (async ({ json }: { json: any }) => {
        submissions.push(json);
        return {
          status: 201,
          json: async () => ({
            commitId: randomUUID(),
            archiveSeq: String(submissions.length),
            binId: json.binId,
            runId: json.runId,
            sourceAdapterVersion: json.sourceAdapterVersion,
            observedAt: new Date().toISOString(),
            recordedAt: new Date().toISOString(),
            items: json.items.map((i: any) => ({
              itemId: randomUUID(),
              revisionId: randomUUID(),
              sourceKey: i.sourceKey,
            })),
            relations: [],
          }),
        };
      }) as any,
    },
    resources: {
      $post: (async (
        { header }: { header: Record<string, string> },
        { init }: { init: any },
      ) => {
        const bytes = await new Response(init.body).arrayBuffer();
        const resource: ArchiveResourceMetadata = {
          resourceId: randomUUID(),
          sha256: "0".repeat(64),
          mediaType: header["content-type"] ?? "application/octet-stream",
          size: bytes.byteLength,
        };
        resources.push(resource);
        return {
          status: 201,
          json: async () => resource,
        };
      }) as any,
      resolve: {
        $post: (async () => ({
          status: 200,
          json: async () => ({ resources: [], items: [], mediaByUrl: {} }),
        })) as any,
      },
    },
  } as unknown as SourceAdapterApiClient;
}

await test("Google AI and DeepMind RSS discovery + dedicated HTML body extraction with no body.html", async () => {
  const manifest = sourceAdapterManifest(sourceAdapter);
  assert.equal(manifest.extensionsSchema.additionalProperties, false);
  const extensionFields = manifest.extensionsSchema.properties as Record<
    string,
    { readonly description?: string }
  >;
  for (const field of Object.values(extensionFields)) {
    assert.ok(field.description);
  }

  const submissions: GoogleSubmission[] = [];
  const resources: ArchiveResourceMetadata[] = [];
  let persistentStateData: IncrementalSyncState | undefined;

  const persistentState = {
    async load() {
      return persistentStateData;
    },
    async save(state: unknown) {
      persistentStateData = state as IncrementalSyncState;
    },
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/google-ai/rss") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(`
        <rss version="2.0">
          <channel>
            <title>Google AI Blog</title>
            <item>
              <guid>urn:google:ai:1</guid>
              <title>Google AI Breakthrough</title>
              <link>${origin}/google-ai/article-1</link>
              <description><![CDATA[<p>RSS description summary only</p>]]></description>
              <pubDate>Mon, 02 Nov 2026 17:45:00 GMT</pubDate>
              <author>Google Research Team</author>
              <category>Machine Learning</category>
            </item>
          </channel>
        </rss>
      `);
      return;
    }

    if (path === "/deepmind/rss") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(`
        <rss version="2.0">
          <channel>
            <title>Google DeepMind Blog</title>
            <item>
              <guid>urn:deepmind:1</guid>
              <title>DeepMind Breakthrough</title>
              <link>${origin}/deepmind/article-1</link>
              <description><![CDATA[<p>DeepMind summary only</p>]]></description>
              <pubDate>Tue, 03 Nov 2026 12:00:00 +0530</pubDate>
              <author>DeepMind Team</author>
              <category>Cheminformatics</category>
            </item>
          </channel>
        </rss>
      `);
      return;
    }

    if (path === "/google-ai/article-1") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`
        <!doctype html>
        <html>
          <head>
            <title>Google AI Breakthrough - Full Story</title>
            <meta property="article:published_time" content="2026-11-02" />
          </head>
          <body>
            <header class="uni-header">
              <nav class="site-nav"><a href="/">Home</a></nav>
            </header>
            <main>
              <article class="uni-blog-article">
                <header class="article-header">
                  <h1>Google AI Breakthrough</h1>
                </header>
                <div class="social-share">
                  <button>Share on X</button>
                </div>
                <div class="uni-audio-player" data-component="audio-player">
                  <button>Listen to this article</button>
                </div>
                <div class="article-body">
                  <p>Substantive article paragraph for Google AI.</p>
                  <h2>Technical Architecture</h2>
                  <pre><code>const answer = 42;</code></pre>
                  <table>
                    <thead><tr><th>Metric</th><th>Score</th></tr></thead>
                    <tbody><tr><td>MMLU</td><td>92.5</td></tr></tbody>
                  </table>
                  <img src="/media/google-ai.png" alt="Google AI Diagram" />
                </div>
                <section class="related-stories">
                  <h2>Related stories</h2>
                  <ul><li><a href="/other">Other story</a></li></ul>
                </section>
                <div class="newsletter-signup" data-component="newsletter">
                  <input type="email" placeholder="Subscribe" />
                </div>
              </article>
            </main>
            <footer class="uni-footer"><p>&copy; 2026 Google</p></footer>
          </body>
        </html>
      `);
      return;
    }

    if (path === "/deepmind/article-1") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`
        <!doctype html>
        <html>
          <head>
            <title>DeepMind Breakthrough - Full Story</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "BlogPosting",
                "headline": "DeepMind Breakthrough",
                "datePublished": "2026-11-03T15:00:00+05:30",
                "dateModified": "2026-11-03T16:00:00+05:30",
                "author": [{ "@type": "Person", "name": "Demis Hassabis" }]
              }
            </script>
          </head>
          <body>
            <nav class="c-nav"><a href="/">DeepMind Home</a></nav>
            <main>
              <article>
                <h1>DeepMind Breakthrough</h1>
                <div class="social-share c-share"><button>Share</button></div>
                <div class="author-social"><a href="https://x.com/author">Author Twitter</a></div>
                <p>Substantive article paragraph for DeepMind.</p>
                <h2>Research Methods</h2>
                <pre><code>def compute(): pass</code></pre>
                <table>
                  <thead><tr><th>Benchmark</th><th>Result</th></tr></thead>
                  <tbody><tr><td>Alpha</td><td>98.5%</td></tr></tbody>
                </table>
                <img src="/media/deepmind.png" alt="DeepMind Plot" />
                <section class="related-posts further-reading">
                  <h2>Further reading</h2>
                  <div><a href="/reading">Reading</a></div>
                </section>
              </article>
            </main>
            <footer><p>&copy; 2026 DeepMind</p></footer>
          </body>
        </html>
      `);
      return;
    }

    if (path.startsWith("/media/")) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
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

  const client = createMockClient(submissions, resources);
  const runId = randomUUID();

  const context = createSourceAdapterContext<
    GoogleConfig,
    typeof sourceAdapter.extensionsSchema,
    never
  >(
    client,
    {
      binId: "google-test-bin",
      identityId: "google-test-identity",
      runId,
      referenceTime: "2026-11-07T00:00:00.000Z",
      sourceAdapterVersion: sourceAdapter.version,
      config: {
        sources: [
          {
            id: "google-ai",
            url: `${origin}/google-ai/rss`,
            title: "Google AI Blog",
          },
          {
            id: "deepmind",
            url: `${origin}/deepmind/rss`,
            title: "Google DeepMind Blog",
          },
        ],
      },
      signal: new AbortController().signal,
      persistentState,
    },
    sourceAdapter.extensionsSchema,
  );

  try {
    // 1. Check action validates feeds and sample HTML extraction
    const checkResult = await sourceAdapter.actions.check.execute(context, {});
    assert.equal(checkResult.availability, "available");
    assert.deepEqual(checkResult.scope, ["google-ai", "deepmind"]);
    assert.equal(checkResult.problems.length, 0);

    // 2. Collect action extracts full text HTML with no body.html
    const collectResult = await sourceAdapter.actions.collect.execute(
      context,
      {},
    );
    assert.deepEqual(collectResult.completedScopes, ["google-ai", "deepmind"]);
    assert.equal(submissions.length, 2);

    // Google AI submission verification
    const googleAiSub = submissions[0]!;
    assert.equal(googleAiSub.items.length, 1);
    const googleAiItem = googleAiSub.items[0]!;
    assert.deepEqual(googleAiItem.sourceKey, {
      namespace: "google:google-ai",
      key: "urn:google:ai:1",
    });
    assert.equal(googleAiItem.sourceRef, `${origin}/google-ai/article-1`);
    assert.deepEqual(googleAiItem.sourcePublishedAt, {
      precision: "day",
      value: "2026-11-02",
    });
    assert.equal(googleAiItem.sourceModifiedAt, null);
    assert.ok(googleAiItem.body);
    assert.equal(
      "html" in (googleAiItem.body as any),
      false,
      "Must not archive body.html",
    );

    const googleAiMd = googleAiItem.body.markdown ?? "";
    assert.ok(googleAiMd.includes("# Google AI Breakthrough"));
    assert.ok(
      googleAiMd.includes("Substantive article paragraph for Google AI."),
    );
    assert.ok(googleAiMd.includes("## Technical Architecture"));
    assert.ok(googleAiMd.includes("const answer = 42;"));
    assert.ok(googleAiMd.includes("| Metric | Score |"));
    assert.ok(googleAiMd.includes("![Google AI Diagram](binny://resource/"));

    // Noise stripping verification for Google AI
    assert.equal(googleAiMd.includes("Share on X"), false);
    assert.equal(googleAiMd.includes("Listen to this article"), false);
    assert.equal(googleAiMd.includes("Related stories"), false);
    assert.equal(googleAiMd.includes("Other story"), false);
    assert.equal(googleAiMd.includes("Subscribe"), false);
    assert.equal(googleAiMd.includes("RSS description summary only"), false);

    // DeepMind submission verification
    const deepmindSub = submissions[1]!;
    assert.equal(deepmindSub.items.length, 1);
    const deepmindItem = deepmindSub.items[0]!;
    assert.deepEqual(deepmindItem.sourceKey, {
      namespace: "google:deepmind",
      key: "urn:deepmind:1",
    });
    assert.equal(deepmindItem.sourceRef, `${origin}/deepmind/article-1`);
    assert.ok(deepmindItem.body);
    assert.equal(
      "html" in (deepmindItem.body as any),
      false,
      "Must not archive body.html",
    );

    const deepmindMd = deepmindItem.body.markdown ?? "";
    assert.ok(deepmindMd.includes("# DeepMind Breakthrough"));
    assert.ok(
      deepmindMd.includes("Substantive article paragraph for DeepMind."),
    );
    assert.ok(deepmindMd.includes("## Research Methods"));
    assert.ok(deepmindMd.includes("def compute(): pass"));
    assert.ok(deepmindMd.includes("| Benchmark | Result |"));
    assert.ok(deepmindMd.includes("![DeepMind Plot](binny://resource/"));
    assert.deepEqual(deepmindItem.sourcePublishedAt, {
      precision: "instant",
      value: "2026-11-03T15:00:00+05:30",
    });
    assert.deepEqual(deepmindItem.sourceModifiedAt, {
      precision: "instant",
      value: "2026-11-03T16:00:00+05:30",
    });

    // Noise stripping verification for DeepMind
    assert.equal(deepmindMd.includes("DeepMind Home"), false);
    assert.equal(deepmindMd.includes("Author Twitter"), false);
    assert.equal(deepmindMd.includes("Further reading"), false);
    assert.equal(deepmindMd.includes("Reading"), false);
    assert.equal(deepmindMd.includes("DeepMind summary only"), false);
  } finally {
    server.close();
  }
});

await test("Preserves page publication precision and actual modification facts", async () => {
  const submissions: GoogleSubmission[] = [];
  const resources: ArchiveResourceMetadata[] = [];
  let persistentStateData: IncrementalSyncState | undefined;

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/feed") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(`
        <rss version="2.0">
          <channel>
            <title>Google AI</title>
            <item>
              <guid>urn:google:ai:date-test</guid>
              <title>Date Test Article</title>
              <link>${origin}/article-date</link>
              <pubDate>Mon, 02 Nov 2026 17:45:00 GMT</pubDate>
            </item>
          </channel>
        </rss>
      `);
      return;
    }

    if (path === "/article-date") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`
        <!doctype html>
        <html>
          <head>
            <title>Date Test Article</title>
            <meta property="article:published_time" content="2026-11-02" />
          </head>
          <body>
            <article class="uni-blog-article">
              <h1>Date Test Article</h1>
              <p>Content with day-precision page date.</p>
            </article>
          </body>
        </html>
      `);
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

  const client = createMockClient(submissions, resources);
  const context = createSourceAdapterContext<
    GoogleConfig,
    typeof sourceAdapter.extensionsSchema,
    never
  >(
    client,
    {
      binId: "google-test-bin",
      identityId: "google-test-identity",
      runId: randomUUID(),
      referenceTime: "2026-11-07T00:00:00.000Z",
      sourceAdapterVersion: sourceAdapter.version,
      config: {
        sources: [
          { id: "google-ai", url: `${origin}/feed`, title: "Google AI Blog" },
        ],
      },
      signal: new AbortController().signal,
      persistentState: {
        async load() {
          return persistentStateData;
        },
        async save(state: unknown) {
          persistentStateData = state as IncrementalSyncState;
        },
      },
    },
    sourceAdapter.extensionsSchema,
  );

  try {
    await sourceAdapter.actions.collect.execute(context, {});
    assert.equal(submissions.length, 1);
    const item = submissions[0]!.items[0]!;

    assert.deepEqual(item.sourcePublishedAt, {
      precision: "day",
      value: "2026-11-02",
    });
    assert.equal(item.sourceModifiedAt, null);
    assert.deepEqual(item.extensions, {
      sourceId: "google-ai",
      region: "international",
      language: "en",
      authors: [],
      categories: [],
    });
  } finally {
    server.close();
  }
});

await test("Incremental sync: initial baseline establishes state without archiving, subsequent skip, and archiving new/modified items", async () => {
  const submissions: GoogleSubmission[] = [];
  const resources: ArchiveResourceMetadata[] = [];
  let persistentStateData: IncrementalSyncState | undefined;
  let feedVersion = 1;
  let articleFetches = 0;

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/sync/rss") {
      const etag = `"sync-v${feedVersion}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }

      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        etag,
      });

      const items = [
        `
        <item>
          <guid>urn:google:sync:1</guid>
          <title>Sync Baseline Article 1</title>
          <link>${origin}/sync/article-1</link>
          <pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate>
        </item>
        `,
      ];

      if (feedVersion >= 3) {
        items.push(`
          <item>
            <guid>urn:google:sync:2</guid>
            <title>Sync New Article 2</title>
            <link>${origin}/sync/article-2</link>
          <pubDate>Tue, 03 Nov 2026 12:00:00 +0530</pubDate>
          </item>
        `);
      }

      response.end(`
        <rss version="2.0">
          <channel>
            <title>Google AI Sync</title>
            ${items.join("")}
          </channel>
        </rss>
      `);
      return;
    }

    if (path === "/sync/article-1") {
      articleFetches += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<article><p>Article 1 content</p></article>");
      return;
    }

    if (path === "/sync/article-2") {
      articleFetches += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<article><p>Article 2 content</p></article>");
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

  const client = createMockClient(submissions, resources);
  const context = createSourceAdapterContext<
    GoogleConfig,
    typeof sourceAdapter.extensionsSchema,
    never
  >(
    client,
    {
      binId: "google-test-bin",
      identityId: "google-test-identity",
      runId: randomUUID(),
      referenceTime: "2026-11-07T00:00:00.000Z",
      sourceAdapterVersion: sourceAdapter.version,
      config: {
        sources: [
          {
            id: "google-ai",
            url: `${origin}/sync/rss`,
            title: "Google AI Blog",
          },
        ],
      },
      signal: new AbortController().signal,
      persistentState: {
        async load() {
          return persistentStateData;
        },
        async save(state: unknown) {
          persistentStateData = state as IncrementalSyncState;
        },
      },
    },
    sourceAdapter.extensionsSchema,
  );

  try {
    // Phase 1: Initial sync establishes baseline only (0 article fetches, 0 submissions)
    feedVersion = 1;
    const initialSyncRes = await sourceAdapter.actions.sync.execute(
      context,
      {},
    );
    assert.deepEqual(initialSyncRes.completedScopes, ["google-ai"]);
    assert.deepEqual(initialSyncRes.initializedScopes, ["google-ai"]);
    assert.equal(
      articleFetches,
      0,
      "Initial sync must not fetch historical article HTML pages",
    );
    assert.equal(
      submissions.length,
      0,
      "Initial sync must not archive baseline items",
    );

    assert.ok(persistentStateData?.scopes["google-ai"]);
    const baselineEntry =
      persistentStateData.scopes["google-ai"]?.entries["urn:google:sync:1"];
    assert.equal(baselineEntry?.archivedCompleteness, "baseline");

    // Phase 2: Subsequent sync with no changes returns 304 (0 fetches, 0 submissions)
    feedVersion = 1;
    const noChangeSyncRes = await sourceAdapter.actions.sync.execute(
      context,
      {},
    );
    assert.deepEqual(noChangeSyncRes.completedScopes, ["google-ai"]);
    assert.equal(
      articleFetches,
      0,
      "Subsequent unchanged sync must not fetch articles",
    );
    assert.equal(
      submissions.length,
      0,
      "Subsequent unchanged sync must not archive items",
    );

    // Phase 3: Subsequent sync with new article 2
    feedVersion = 3;
    const newArticleSyncRes = await sourceAdapter.actions.sync.execute(
      context,
      {},
    );
    assert.deepEqual(newArticleSyncRes.completedScopes, ["google-ai"]);
    assert.equal(
      articleFetches,
      1,
      "Only new article HTML page should be fetched",
    );
    assert.equal(submissions.length, 1, "Only new article should be archived");

    const newEntry =
      persistentStateData.scopes["google-ai"]?.entries["urn:google:sync:2"];
    assert.equal(newEntry?.archivedCompleteness, "complete");
    const newItem = submissions[0]?.items[0];
    assert.ok(newItem);
    assert.deepEqual(newItem.sourcePublishedAt, {
      precision: "instant",
      value: "2026-11-03T12:00:00+05:30",
    });
    assert.equal(newItem.sourceModifiedAt, null);
  } finally {
    server.close();
  }
});

await test("Article full-text failure fails scope without falling back to summary, and partial media failure records completeness partial", async () => {
  const submissions: GoogleSubmission[] = [];
  const resources: ArchiveResourceMetadata[] = [];
  let persistentStateData: IncrementalSyncState | undefined;

  let mode: "500" | "empty" | "partial-media" = "500";

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/fail/rss") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(`
        <rss version="2.0">
          <channel>
            <title>Fail Test Feed</title>
            <item>
              <guid>urn:google:fail:1</guid>
              <title>Failing Article</title>
              <link>${origin}/fail/article</link>
              <description><![CDATA[<p>Summary fallback candidate that must NEVER be archived</p>]]></description>
              <pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>
      `);
      return;
    }

    if (path === "/fail/article") {
      if (mode === "500") {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("Internal Server Error");
        return;
      }
      if (mode === "empty") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<html><body><main><nav>Nav only</nav></main></body></html>",
        );
        return;
      }
      if (mode === "partial-media") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`
          <article>
            <h1>Partial Media Article</h1>
            <p>Article with one valid and one broken image.</p>
            <img src="/media/ok.png" alt="Valid Image" />
            <img src="/media/broken.png" alt="Broken Image" />
          </article>
        `);
        return;
      }
    }

    if (path === "/media/ok.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      return;
    }

    if (path === "/media/broken.png") {
      response.writeHead(404);
      response.end("Not Found");
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

  const client = createMockClient(submissions, resources);
  const context = createSourceAdapterContext<
    GoogleConfig,
    typeof sourceAdapter.extensionsSchema,
    never
  >(
    client,
    {
      binId: "google-test-bin",
      identityId: "google-test-identity",
      runId: randomUUID(),
      referenceTime: "2026-11-07T00:00:00.000Z",
      sourceAdapterVersion: sourceAdapter.version,
      config: {
        sources: [
          {
            id: "google-ai",
            url: `${origin}/fail/rss`,
            title: "Google AI Blog",
          },
        ],
      },
      signal: new AbortController().signal,
      persistentState: {
        async load() {
          return persistentStateData;
        },
        async save(state: unknown) {
          persistentStateData = state as IncrementalSyncState;
        },
      },
    },
    sourceAdapter.extensionsSchema,
  );

  try {
    // 1. HTTP 500 fails the scope without archiving RSS summary
    mode = "500";
    await assert.rejects(
      async () => {
        await sourceAdapter.actions.collect.execute(context, {});
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "google_collection_incomplete");
        return true;
      },
    );
    assert.equal(
      submissions.length,
      0,
      "Must never archive RSS summary when article returns 500",
    );

    // 2. Empty shell fails the scope without archiving RSS summary
    mode = "empty";
    await assert.rejects(
      async () => {
        await sourceAdapter.actions.collect.execute(context, {});
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        return true;
      },
    );
    assert.equal(
      submissions.length,
      0,
      "Must never archive RSS summary when article yields no content",
    );

    // 3. Partial media failure records completeness "partial"
    mode = "partial-media";
    const collectRes = await sourceAdapter.actions.collect.execute(context, {});
    assert.deepEqual(collectRes.completedScopes, ["google-ai"]);
    assert.equal(submissions.length, 1);

    const item = submissions[0]!.items[0]!;
    assert.equal(item.capture?.completeness, "partial");
    assert.ok(
      item.capture?.missing?.some(
        (m) => m.reason.includes("broken.png") || m.path.includes("media"),
      ),
    );
    assert.ok(
      item.body?.markdown?.includes("binny://resource/"),
      "Valid image must be rewritten",
    );

    const entry =
      persistentStateData?.scopes["google-ai"]?.entries["urn:google:fail:1"];
    assert.equal(entry?.archivedCompleteness, "partial");
  } finally {
    server.close();
  }
});
