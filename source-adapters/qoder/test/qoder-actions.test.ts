// Comprehensive tests for Qoder International Blog adapter.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { describe } from "node:test";

import type {
  ArchiveCommit,
  ArchiveResourceMetadata,
  IncrementalSyncState,
  SourceAdapterArchiveSubmission,
  SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { isSourceAdapterActionError } from "@binny/source-adapter-sdk";

import {
  extractBlogSlug,
  normalizeDateToDay,
  parseArticleDate,
} from "../src/international-blog.ts";
import { sourceAdapter, type QoderConfig } from "../src/source-adapter.ts";

void describe("Qoder International Blog Source Adapter", () => {
  void test("exports manifest id and metadata", () => {
    assert.equal(sourceAdapter.id, "qoder");
    assert.equal(sourceAdapter.version, "0.1.0");
    assert.ok(sourceAdapter.actions.check !== undefined);
    assert.ok(sourceAdapter.actions.collect !== undefined);
    assert.ok(sourceAdapter.actions.sync !== undefined);
  });

  void test("extractBlogSlug normalizes various blog paths and ignores invalid routes", () => {
    assert.equal(
      extractBlogSlug("/blog/introducing-qoder-cli"),
      "introducing-qoder-cli",
    );
    assert.equal(
      extractBlogSlug("/en/blog/introducing-qoder-cli"),
      "introducing-qoder-cli",
    );
    assert.equal(
      extractBlogSlug("https://qoder.com/blog/introducing-qoder-cli"),
      "introducing-qoder-cli",
    );
    assert.equal(
      extractBlogSlug("https://qoder.com/en/blog/introducing-qoder-cli/"),
      "introducing-qoder-cli",
    );
    assert.equal(
      extractBlogSlug("/blog/qoder-fasttech.html"),
      "qoder-fasttech",
    );

    // Negative cases
    assert.equal(extractBlogSlug("/blog"), undefined);
    assert.equal(extractBlogSlug("/blog/"), undefined);
    assert.equal(extractBlogSlug("/en/blog"), undefined);
    assert.equal(extractBlogSlug("/events"), undefined);
    assert.equal(extractBlogSlug("/events/purchase-offer"), undefined);
    assert.equal(extractBlogSlug("/blog/category/tech"), undefined);
    assert.equal(extractBlogSlug("/blog/tag/cli"), undefined);
  });

  void test("normalizeDateToDay and parseArticleDate handle day precision without timestamp fabrication", () => {
    assert.equal(normalizeDateToDay("2026-10-20"), "2026-10-20");
    assert.equal(normalizeDateToDay("October 20, 2026"), "2026-10-20");
    assert.equal(normalizeDateToDay("Oct 20, 2026"), "2026-10-20");

    const dayOnly = parseArticleDate("2026-10-20");
    assert.equal(dayOnly.publishedDate, "2026-10-20");
    assert.equal(dayOnly.sourceModifiedAt, undefined);

    const fullIso = parseArticleDate("2026-10-20T14:30:00Z");
    assert.equal(fullIso.publishedDate, "2026-10-20");
    assert.equal(fullIso.sourceModifiedAt, "2026-10-20T14:30:00Z");
  });

  void test("full action flow: body extraction without article tag, canonical normalization, sync baseline, and error rejection", async () => {
    let blogListVersion = 1;
    const detailRequests: string[] = [];
    const mediaRequests: string[] = [];
    const submissions: SourceAdapterArchiveSubmission[] = [];
    const uploadedResources: ArchiveResourceMetadata[] = [];

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/blog") {
        let itemsHtml = `
          <div class="blog-card">
            <span class="category">Technology</span>
            <h2><a href="/blog/introducing-qoder-cli">Introducing Qoder CLI</a></h2>
            <time datetime="2026-10-20">2026-10-20</time>
            <p class="summary">The all-new command line tool for developer workflows.</p>
          </div>
          <div class="blog-card">
            <span class="category">Research</span>
            <h2><a href="/en/blog/completion-model-benchmark">Completion Model Benchmark</a></h2>
            <time datetime="2026-10-22">2026-10-22</time>
            <p class="summary">Evaluating code generation and completion accuracy.</p>
          </div>
        `;

        if (blogListVersion >= 3) {
          itemsHtml += `
            <div class="blog-card">
              <span class="category">Product</span>
              <h2><a href="/blog/qoder-lite">Qoder Lite Released</a></h2>
              <time datetime="2026-10-25">2026-10-25</time>
              <p class="summary">Lightweight agentic coding in your terminal.</p>
            </div>
          `;
        }

        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Qoder Blog</title></head>
          <body>
            <header><nav><a href="/">Home</a><a href="/events">Events</a></nav></header>
            <main>
              <h1>Blog Articles</h1>
              <div class="blog-grid">${itemsHtml}</div>
            </main>
            <footer><p>Footer content</p></footer>
          </body>
          </html>
        `);
        return;
      }

      if (path === "/blog/introducing-qoder-cli") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        // Realistic Qoder detail page markup WITHOUT an <article> tag.
        response.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Introducing Qoder CLI - Qoder Blog</title>
            <link rel="canonical" href="https://qoder.com/en/blog/introducing-qoder-cli" />
            <meta property="og:title" content="Introducing Qoder CLI" />
          </head>
          <body>
            <header>
              <nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
            </header>
            <main class="blog-post-page">
              <aside class="sidebar-toc">
                <nav>
                  <ul>
                    <li><a href="#overview">Overview</a></li>
                    <li><a href="#install">Install</a></li>
                  </ul>
                </nav>
              </aside>
              <div class="blog-detail-content">
                <h1>Introducing Qoder CLI</h1>
                <div class="post-meta">
                  <span class="author">Qoder Team</span>
                  <time datetime="2026-10-20">2026-10-20</time>
                  <span class="category">Technology</span>
                </div>
                <p>Today we are excited to introduce Qoder CLI to streamline developer workflows.</p>
                <h2>Getting Started</h2>
                <pre><code>npm install -g @qoder/cli
qoder login
qoder init</code></pre>
                <h2>Performance Comparison</h2>
                <table>
                  <thead>
                    <tr><th>Model</th><th>Pass@1</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>Qoder Engine</td><td>91.8%</td></tr>
                  </tbody>
                </table>
                <img src="/media/cli-demo.png" alt="CLI Demo Screenshot" />
                <div class="share-buttons">
                  <button>Share to Twitter</button>
                </div>
              </div>
              <div class="related-posts">
                <h3>Related Posts</h3>
                <a href="/blog/completion-model-benchmark">Benchmark Post</a>
              </div>
            </main>
            <footer><p>&copy; 2026 Qoder All Rights Reserved</p></footer>
          </body>
          </html>
        `);
        return;
      }

      if (path === "/blog/completion-model-benchmark") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Completion Model Benchmark</title>
            <link rel="canonical" href="https://qoder.com/en/blog/completion-model-benchmark" />
          </head>
          <body>
            <main>
              <div class="blog-detail-content">
                <h1>Completion Model Benchmark</h1>
                <div class="post-meta">
                  <span class="author">Research Lab</span>
                  <time datetime="2026-10-22">2026-10-22</time>
                </div>
                <p>Comprehensive benchmarking of coding LLMs across multiple languages.</p>
                <img src="/media/benchmark.png" alt="Benchmark Chart" />
              </div>
            </main>
          </body>
          </html>
        `);
        return;
      }

      if (path === "/blog/qoder-lite") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Qoder Lite Released</title>
          </head>
          <body>
            <main>
              <div class="blog-detail-content">
                <h1>Qoder Lite Released</h1>
                <time datetime="2026-10-25">2026-10-25</time>
                <p>A fast, lightweight model for everyday coding assistance.</p>
              </div>
            </main>
          </body>
          </html>
        `);
        return;
      }

      if (path === "/blog/empty-shell") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(`
          <!DOCTYPE html>
          <html><head><title>App Shell</title></head><body><div id="root"></div></body></html>
        `);
        return;
      }

      if (path === "/blog/server-error") {
        detailRequests.push(path);
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("Internal Server Error");
        return;
      }

      if (path === "/media/cli-demo.png" || path === "/media/benchmark.png") {
        mediaRequests.push(path);
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }

      response.writeHead(404);
      response.end("Not Found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    let storedState: IncrementalSyncState | undefined;
    const persistentStateStore = {
      async load() {
        return storedState;
      },
      async save(state: unknown) {
        storedState = state as IncrementalSyncState;
      },
    };

    let commitSeq = 0;
    function createContext(
      config: QoderConfig,
    ): SourceAdapterContext<QoderConfig> {
      const runId = randomUUID();
      return {
        binId: "qoder-test-bin",
        identityId: "qoder-test-identity",
        runId,
        referenceTime: "2026-11-07T12:00:00.000Z",
        sourceAdapterVersion: sourceAdapter.version,
        config,
        signal: new AbortController().signal,
        persistentState: persistentStateStore,
        archive: {
          async submit(input) {
            submissions.push(input);
            commitSeq += 1;
            return {
              commitId: randomUUID(),
              archiveSeq: String(commitSeq),
              binId: "qoder-test-bin",
              runId,
              sourceAdapterVersion: sourceAdapter.version,
              observedAt: "2026-11-07T12:00:00.000Z",
              recordedAt: "2026-11-07T12:00:00.000Z",
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
          async resolve() {
            return { resources: [], items: [], mediaByUrl: {} };
          },
          async upload(body, mediaType) {
            const bytes = await new Response(body).arrayBuffer();
            const resource = {
              resourceId: randomUUID(),
              sha256: "0".repeat(64),
              mediaType,
              size: bytes.byteLength,
            } satisfies ArchiveResourceMetadata;
            uploadedResources.push(resource);
            return { ok: true, resource } as const;
          },
        },
      };
    }

    try {
      const context = createContext({
        blogListUrl: `${origin}/blog`,
      });

      // 1. Check Action
      const checkResult = await sourceAdapter.actions.check.execute(
        context,
        {},
      );
      assert.equal(checkResult.availability, "available");
      assert.deepEqual(checkResult.scope, ["int-blog"]);
      assert.equal(checkResult.problems.length, 0);

      // Verify check failure when URL is unreachable
      const brokenContext = createContext({
        blogListUrl: "http://127.0.0.1:1/nonexistent",
      });
      const failedCheck = await sourceAdapter.actions.check.execute(
        brokenContext,
        {},
      );
      assert.equal(failedCheck.availability, "unavailable");
      assert.ok(failedCheck.problems.length > 0);

      // Reset request trackers
      detailRequests.length = 0;
      submissions.length = 0;

      // 2. Initial Sync establishes baseline WITHOUT fetching historical detail pages
      const initialSync = await sourceAdapter.actions.sync.execute(context, {});
      assert.deepEqual(initialSync, {
        completedScopes: ["int-blog"],
        initializedScopes: ["int-blog"],
      });
      // CRITICAL: Baseline sync must NOT fetch historical article detail pages!
      assert.equal(detailRequests.length, 0);
      assert.equal(submissions.length, 0);

      // Verify persistent state baseline entries
      assert.ok(storedState !== undefined);
      const scopeState = storedState.scopes["int-blog"];
      assert.ok(scopeState !== undefined);
      assert.equal(scopeState.scopeUrl, `${origin}/blog`);
      assert.equal(
        scopeState.entries["introducing-qoder-cli"]?.archivedCompleteness,
        "baseline",
      );
      assert.equal(
        scopeState.entries["completion-model-benchmark"]?.archivedCompleteness,
        "baseline",
      );

      // 3. Subsequent Sync with no changes makes 0 detail requests and 0 submissions
      blogListVersion = 2;
      detailRequests.length = 0;
      submissions.length = 0;

      const noChangeSync = await sourceAdapter.actions.sync.execute(
        context,
        {},
      );
      assert.deepEqual(noChangeSync, {
        completedScopes: ["int-blog"],
      });
      assert.equal(detailRequests.length, 0);
      assert.equal(submissions.length, 0);

      // 4. Subsequent Sync with a new article fetches ONLY the new article detail page
      blogListVersion = 3; // Adds qoder-lite
      detailRequests.length = 0;
      submissions.length = 0;

      const newArticleSync = await sourceAdapter.actions.sync.execute(
        context,
        {},
      );
      assert.deepEqual(newArticleSync, {
        completedScopes: ["int-blog"],
      });
      // Fetched ONLY qoder-lite, not historical articles!
      assert.deepEqual(detailRequests, ["/blog/qoder-lite"]);
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0]?.items[0]?.sourceKey.key, "qoder-lite");
      assert.equal(
        storedState.scopes["int-blog"]?.entries["qoder-lite"]
          ?.archivedCompleteness,
        "complete",
      );

      // 5. Collect Action with specific articleUrls
      detailRequests.length = 0;
      submissions.length = 0;
      uploadedResources.length = 0;

      const collectResult = await sourceAdapter.actions.collect.execute(
        context,
        {
          articleUrls: [`${origin}/blog/introducing-qoder-cli`],
        },
      );
      assert.deepEqual(collectResult, {
        completedScopes: ["int-blog"],
      });
      assert.equal(detailRequests.length, 1);
      assert.equal(submissions.length, 1);

      const submission = submissions[0]!;
      const item = submission.items[0]!;

      // Verify stable sourceKey, region, language, and metadata
      assert.deepEqual(item.sourceKey, {
        namespace: "qoder:int-blog",
        key: "introducing-qoder-cli",
      });
      assert.equal(item.metadata?.title, "Introducing Qoder CLI");
      // Day precision date must be preserved in metadata without fabricating sourceModifiedAt
      assert.equal(item.sourceModifiedAt, undefined);
      assert.equal(item.metadata?.region, "international");
      assert.equal(item.metadata?.language, "en");
      assert.equal(item.metadata?.publishedDate, "2026-10-20");
      assert.equal(
        item.metadata?.canonicalUrl,
        "https://qoder.com/en/blog/introducing-qoder-cli",
      );
      assert.deepEqual(item.metadata?.authors, ["Qoder Team"]);

      // Verify article content extraction from page WITHOUT <article> tag
      const body = item.body as {
        markdown: string;
        text: string;
        searchText: string;
      };
      assert.ok(typeof body.markdown === "string");
      // Headings
      assert.match(body.markdown, /# Introducing Qoder CLI/u);
      assert.match(body.markdown, /## Getting Started/u);
      assert.match(body.markdown, /## Performance Comparison/u);
      // Code block with indentation
      assert.match(
        body.markdown,
        /```\s*npm install -g @qoder\/cli\s*qoder login\s*qoder init\s*```/u,
      );
      // Table
      assert.match(body.markdown, /\|\s*Model\s*\|\s*Pass@1\s*\|/u);
      assert.match(body.markdown, /\|\s*Qoder Engine\s*\|\s*91\.8%\s*\|/u);
      // Resource reference
      assert.match(body.markdown, /binny:\/\/resource\//u);

      // Noise elements stripped
      assert.doesNotMatch(body.markdown, /Overview/u); // TOC stripped
      assert.doesNotMatch(body.markdown, /Share to Twitter/u); // Share buttons stripped
      assert.doesNotMatch(body.markdown, /Related Posts/u); // Related section stripped
      assert.doesNotMatch(body.markdown, /All Rights Reserved/u); // Footer stripped

      // Media resource uploaded
      assert.equal(uploadedResources.length, 1);

      // 6. Collect rejects empty shell without falling back to summary
      detailRequests.length = 0;
      submissions.length = 0;

      await assert.rejects(
        async () => {
          await sourceAdapter.actions.collect.execute(context, {
            articleUrls: [`${origin}/blog/empty-shell`],
          });
        },
        (error: unknown) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.match(
            error.failure.message,
            /empty shell|no extractable article body/iu,
          );
          return true;
        },
      );
      // No fallback archive submission was made!
      assert.equal(submissions.length, 0);

      // 7. Collect rejects 500 error detail page without falling back to summary
      await assert.rejects(
        async () => {
          await sourceAdapter.actions.collect.execute(context, {
            articleUrls: [`${origin}/blog/server-error`],
          });
        },
        (error: unknown) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.match(error.failure.message, /HTTP 500/iu);
          return true;
        },
      );
      assert.equal(submissions.length, 0);
    } finally {
      server.close();
    }
  });
});
