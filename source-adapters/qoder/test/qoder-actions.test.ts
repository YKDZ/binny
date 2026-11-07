// Comprehensive tests for Qoder adapter (International Blog and CN Announcements & Events).
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
  buildCanonicalDocUrl,
  buildFetchMdUrl,
  CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
  DEFAULT_CN_DOCS_INDEX_URL,
  discoverCnAnnouncementDocs,
  extractDocKey,
  extractEffectiveDate,
  isAnnouncementOrEventSectionHeading,
} from "../src/cn-announcements-events.ts";
import {
  extractBlogSlug,
  INTERNATIONAL_BLOG_SCOPE_ID,
  normalizeDateToDay,
  parseArticleDate,
} from "../src/international-blog.ts";
import {
  CN_CHANGELOGS_SCOPE_ID,
  DEFAULT_CN_CHANGELOG_URL,
  DEFAULT_INTERNATIONAL_CHANGELOG_URL,
  discoverCnChangelogDocs,
  discoverInternationalChangelogDocs,
  extractCardLinks,
  extractVersion,
  INTERNATIONAL_CHANGELOGS_SCOPE_ID,
  isChangelogSectionHeading,
  isNavigationDocKey,
  isNavigationPageContent,
  parseChangelogMetadata,
  parseUpdateDate,
} from "../src/regional-changelogs.ts";
import {
  configSchema,
  determineActiveScopes,
  sourceAdapter,
  type QoderConfig,
} from "../src/source-adapter.ts";

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
            <p class="summary">Evaluating coding models across languages.</p>
          </div>
        `;
        if (blogListVersion >= 3) {
          itemsHtml += `
            <div class="blog-card">
              <span class="category">Product</span>
              <h2><a href="/blog/qoder-lite">Qoder Lite Released</a></h2>
              <time datetime="2026-10-25">2026-10-25</time>
              <p class="summary">Fast and lightweight assistant model.</p>
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
            <header><nav><a href="/">Home</a></nav></header>
            <main>
              <div class="blog-list">
                ${itemsHtml}
              </div>
            </main>
            <footer><p>© 2026 Qoder</p></footer>
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
      rawConfig: Partial<QoderConfig>,
    ): SourceAdapterContext<QoderConfig> {
      const config = configSchema.parse(rawConfig);
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
      assert.deepEqual(checkResult.scope, [INTERNATIONAL_BLOG_SCOPE_ID]);
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
        completedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
        initializedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
      });
      // CRITICAL: Baseline sync must NOT fetch historical article detail pages!
      assert.equal(detailRequests.length, 0);
      assert.equal(submissions.length, 0);

      // Verify persistent state baseline entries
      assert.ok(storedState !== undefined);
      const scopeState = storedState.scopes[INTERNATIONAL_BLOG_SCOPE_ID];
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
        completedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
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
        completedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
      });
      // Only the new article was fetched!
      assert.deepEqual(detailRequests, ["/blog/qoder-lite"]);
      assert.equal(submissions.length, 1);
      assert.deepEqual(submissions[0]?.items[0]?.sourceKey, {
        namespace: "qoder:int-blog",
        key: "qoder-lite",
      });

      // 5. Collect Action with specific article URL
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
        completedScopes: [INTERNATIONAL_BLOG_SCOPE_ID],
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

void describe("Qoder CN Announcements and Events Source Adapter", () => {
  void test("extractDocKey, buildCanonicalDocUrl, buildFetchMdUrl, and discoverCnAnnouncementDocs handle diverse routes", () => {
    // Normalization of various paths
    assert.equal(
      extractDocKey("/events/purchase-offer.md"),
      "events/purchase-offer",
    );
    assert.equal(
      extractDocKey("/events/purchase-offer"),
      "events/purchase-offer",
    );
    assert.equal(
      extractDocKey("https://docs.qoder.cn/events/purchase-offer.md"),
      "events/purchase-offer",
    );
    assert.equal(extractDocKey("/zh/announcement"), "zh/announcement");
    assert.equal(
      extractDocKey("product-overview/fast-mode-announcement.md"),
      "product-overview/fast-mode-announcement",
    );

    // Canonical and fetch URLs
    assert.equal(
      buildCanonicalDocUrl(
        "events/purchase-offer",
        "https://docs.qoder.cn/llms.txt",
      ),
      "https://docs.qoder.cn/events/purchase-offer",
    );
    assert.equal(
      buildFetchMdUrl(
        "/events/purchase-offer",
        "https://docs.qoder.cn/llms.txt",
      ),
      "https://docs.qoder.cn/events/purchase-offer.md",
    );
    assert.equal(
      buildFetchMdUrl(
        "https://docs.qoder.cn/events/purchase-offer.md",
        "https://docs.qoder.cn/llms.txt",
      ),
      "https://docs.qoder.cn/events/purchase-offer.md",
    );

    // Section headings matcher
    assert.equal(isAnnouncementOrEventSectionHeading("产品公告"), true);
    assert.equal(isAnnouncementOrEventSectionHeading("公告"), true);
    assert.equal(isAnnouncementOrEventSectionHeading("事件"), true);
    assert.equal(isAnnouncementOrEventSectionHeading("最新活动"), true);
    assert.equal(isAnnouncementOrEventSectionHeading("Announcements"), true);
    assert.equal(isAnnouncementOrEventSectionHeading("Events"), true);
    assert.equal(isAnnouncementOrEventSectionHeading("计费"), false);
    assert.equal(isAnnouncementOrEventSectionHeading("产品概述"), false);
    assert.equal(isAnnouncementOrEventSectionHeading("API 参考"), false);

    // Discovery from llms.txt structure
    const sampleLlmsTxt = `
# Qoder CN

## 产品概述
- [产品介绍](https://docs.qoder.cn/product-overview/introduction-of-qodercn.md)

## 产品公告
- [Fast 档位上线](https://docs.qoder.cn/product-overview/fast-mode-announcement.md)
- [旧版通知](/zh/announcement)

## 计费
- [计费说明](https://docs.qoder.cn/product-overview/billing-description.md)

## 事件
- [限时特价：专业版月付首购 19.9 元](https://docs.qoder.cn/events/purchase-offer.md): 首购特惠活动
- [每日领取 100 Credits](/events/100credits.md)
`;

    const discovered = discoverCnAnnouncementDocs(
      sampleLlmsTxt,
      "https://docs.qoder.cn/llms.txt",
    );

    assert.equal(discovered.length, 4);
    assert.deepEqual(
      discovered.map((d) => d.docKey),
      [
        "product-overview/fast-mode-announcement",
        "zh/announcement",
        "events/purchase-offer",
        "events/100credits",
      ],
    );
    assert.equal(discovered[2]?.title, "限时特价：专业版月付首购 19.9 元");
    assert.equal(discovered[2]?.description, "首购特惠活动");
    assert.equal(discovered[2]?.section, "事件");
  });

  void test("extractEffectiveDate extracts event business dates without fabricating publishedAt or sourceModifiedAt", () => {
    // Range format
    const text1 = "活动时间：2026年11月2日—2026年11月16日。请及时参加。";
    assert.equal(extractEffectiveDate(text1), "2026年11月2日—2026年11月16日");

    // Time line with Beijing time
    const text2 =
      "1. **活动时间**：自 2026 年 10 月 31 日 10:00（北京时间，UTC+8）开始，结束时间将提前在本页公告。";
    assert.equal(
      extractEffectiveDate(text2),
      "自 2026 年 10 月 31 日 10:00（北京时间，UTC+8）开始，结束时间将提前在本页公告",
    );

    // Single date
    const text3 = "上线时间：2026-10-16。";
    assert.equal(extractEffectiveDate(text3), "2026-10-16");

    // Empty when no date present
    const textNoDate = "本页面不包含任何时间规则。";
    assert.equal(extractEffectiveDate(textNoDate), undefined);
  });

  void test("active directory ongoing-document lifecycle: baseline, in-place change detection, and directory pruning", async () => {
    let llmsTxtMode = 1; // 1: initial active docs, 2: purchase-offer rules changed in-place, 3: purchase-offer removed from active directory
    let purchaseOfferContentVersion = 1;
    const detailRequests: string[] = [];
    const submissions: SourceAdapterArchiveSubmission[] = [];
    const uploadedResources: ArchiveResourceMetadata[] = [];

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/llms.txt") {
        let eventLinks = `
- [限时特价：专业版月付首购 19.9 元](/events/purchase-offer.md): 双十一首购活动
- [每日领取 100 Credits](/events/100credits.md)
        `;
        if (llmsTxtMode === 3) {
          // In mode 3, purchase-offer is removed from the active directory!
          eventLinks = `
- [每日领取 100 Credits](/events/100credits.md)
          `;
        }

        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(`
# Qoder CN

## 产品公告
- [Fast 档位上线](/product-overview/fast-mode-announcement.md)
- [关于 Cloud Agents SSE 调整公告](/zh/announcement.md)

## 计费
- [计费说明](/product-overview/billing.md)

## 事件
${eventLinks}
        `);
        return;
      }

      if (path === "/events/purchase-offer.md") {
        detailRequests.push(path);
        let pricingText = "专业版首次月付订阅：首月从 59 元直降至 19.9 元";
        let dateText = "自 2026 年 10 月 31 日 10:00（北京时间，UTC+8）开始";
        if (purchaseOfferContentVersion >= 2) {
          pricingText =
            "专业版首次月付订阅：首月从 59 元直降至 29.9 元（规则已于 11 月 5 日调整）";
          dateText = "自 2026 年 11 月 5 日 10:00（北京时间，UTC+8）起生效";
        }

        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`> ## Documentation Index
> Fetch the complete documentation index at: https://docs.qoder.cn/llms.txt
> Use this file to discover all available pages before exploring further.

# 限时特价：专业版月付首购活动

<Note>
  限时特价：CN 个人用户首购专享优惠。
</Note>

- **活动时间**：${dateText}。
- ${pricingText}。

<a id="pricing-table" style={{ display: "block" }} />

| 订阅计划 | 价格 | 加赠额度 |
| --- | --- | --- |
| 专业版 | 19.9 元 | 1000 Credits |

<Accordion title="常见问题解答">
  历史付费用户不能参与本首购活动，请参考续费活动。
</Accordion>

![Event Poster](/media/offer-poster.png)
`);
        return;
      }

      if (path === "/events/100credits.md") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`
# 每日领取 100 Credits

每日登录桌面端即可领取 100 Credits。
`);
        return;
      }

      if (path === "/product-overview/fast-mode-announcement.md") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`
# Fast 档位上线

Fast 档位现已面向 Qoder 桌面端全部用户上线。
`);
        return;
      }

      if (path === "/zh/announcement.md") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`
# 关于 Cloud Agents SSE 调整公告

<Card title="Cloud Agents 更新日志" href="/zh/changelog">
  查看完整协议更新细节。
</Card>
`);
        return;
      }

      if (path === "/media/offer-poster.png") {
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
      rawConfig: Partial<QoderConfig>,
    ): SourceAdapterContext<QoderConfig> {
      const config = configSchema.parse(rawConfig);
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
        cnDocsIndexUrl: `${origin}/llms.txt`,
      });

      // 1. Check Action
      const checkResult = await sourceAdapter.actions.check.execute(
        context,
        {},
      );
      assert.equal(checkResult.availability, "available");
      assert.deepEqual(checkResult.scope, [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID]);
      assert.equal(checkResult.problems.length, 0);

      // Verify check failure when index URL is unreachable
      const brokenContext = createContext({
        cnDocsIndexUrl: "http://127.0.0.1:1/nonexistent.txt",
      });
      const failedCheck = await sourceAdapter.actions.check.execute(
        brokenContext,
        {},
      );
      assert.equal(failedCheck.availability, "unavailable");
      assert.ok(failedCheck.problems.length > 0);

      // 2. First Sync establishes baseline WITHOUT archiving any historical items (0 archive commits)
      detailRequests.length = 0;
      submissions.length = 0;

      const initialSync = await sourceAdapter.actions.sync.execute(context, {});
      assert.deepEqual(initialSync, {
        completedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
        initializedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
      });
      // CRITICAL: 0 archive submissions on baseline sync!
      assert.equal(submissions.length, 0);

      // Verify ongoing documents hashes recorded in persistent state
      assert.ok(storedState !== undefined);
      const scopeState = storedState.scopes[CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID];
      assert.ok(scopeState !== undefined);
      assert.ok(scopeState.ongoingDocuments !== undefined);
      assert.ok(
        scopeState.ongoingDocuments["events/purchase-offer"]?.contentHash !==
          undefined,
      );
      assert.ok(
        scopeState.ongoingDocuments["events/100credits"]?.contentHash !==
          undefined,
      );
      assert.ok(
        scopeState.ongoingDocuments["product-overview/fast-mode-announcement"]
          ?.contentHash !== undefined,
      );
      assert.ok(
        scopeState.ongoingDocuments["zh/announcement"]?.contentHash !==
          undefined,
      );

      // 3. Second Sync with unchanged .md pages makes 0 archive commits
      detailRequests.length = 0;
      submissions.length = 0;

      const repeatSync = await sourceAdapter.actions.sync.execute(context, {});
      assert.deepEqual(repeatSync, {
        completedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
      });
      assert.equal(submissions.length, 0);

      // 4. Third Sync when /events/purchase-offer.md rules change in-place
      // Changes content without any HTTP modification timestamp
      purchaseOfferContentVersion = 2;
      detailRequests.length = 0;
      submissions.length = 0;

      const modifiedSync = await sourceAdapter.actions.sync.execute(
        context,
        {},
      );
      assert.deepEqual(modifiedSync, {
        completedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
      });
      // Exactly 1 new archive commit for the modified document!
      assert.equal(submissions.length, 1);

      const submission = submissions[0]!;
      const item = submission.items[0]!;
      assert.deepEqual(item.sourceKey, {
        namespace: "qoder:cn-docs",
        key: "events/purchase-offer",
      });
      assert.equal(item.sourceRef, `${origin}/events/purchase-offer`);
      // CRITICAL: effective date is separated from publication timestamp!
      assert.equal(item.sourceModifiedAt, undefined);
      assert.equal(item.metadata?.publishedAt, undefined);
      assert.ok(typeof item.metadata?.effectiveDate === "string");
      assert.match(
        item.metadata.effectiveDate as string,
        /2026 年 11 月 5 日/u,
      );
      assert.equal(item.metadata?.region, "cn");
      assert.equal(item.metadata?.language, "zh-CN");
      assert.equal(item.metadata?.section, "事件");

      // Verify transformed body structure: MDX components converted to semantic Markdown
      const body = item.body as { markdown: string; text: string };
      assert.ok(typeof body.markdown === "string");
      assert.match(body.markdown, /# 限时特价：专业版月付首购活动/u);
      assert.match(body.markdown, /直降至 29\.9 元/u);
      assert.match(
        body.markdown,
        /\|\s*订阅计划\s*\|\s*价格\s*\|\s*加赠额度\s*\|/u,
      );
      assert.match(body.markdown, /### 常见问题解答/u);
      assert.match(body.markdown, /历史付费用户不能参与/u);
      // Noise elements stripped
      assert.doesNotMatch(body.markdown, /Documentation Index/u);
      assert.doesNotMatch(body.markdown, /<Note>/u);
      assert.doesNotMatch(body.markdown, /<style>/u);
      assert.doesNotMatch(body.markdown, /<a id=/u);

      // 5. Fourth Sync: when /events/purchase-offer.md is removed from llms.txt active directory
      // Prunes it from ongoingDocuments so it is no longer checked on future syncs
      llmsTxtMode = 3;
      detailRequests.length = 0;
      submissions.length = 0;

      const prunedSync = await sourceAdapter.actions.sync.execute(context, {});
      assert.deepEqual(prunedSync, {
        completedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
      });
      // No new archive commit made
      assert.equal(submissions.length, 0);
      // /events/purchase-offer.md is no longer fetched!
      assert.ok(!detailRequests.includes("/events/purchase-offer.md"));
      // Verified pruned from ongoingDocuments state
      assert.equal(
        storedState?.scopes[CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID]
          ?.ongoingDocuments?.["events/purchase-offer"],
        undefined,
      );
      // Remaining active docs still present in ongoingDocuments state
      assert.ok(
        storedState?.scopes[CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID]
          ?.ongoingDocuments?.["events/100credits"] !== undefined,
      );

      // 6. Explicit Collect can still collect any specific announcement/event doc
      detailRequests.length = 0;
      submissions.length = 0;

      const collectResult = await sourceAdapter.actions.collect.execute(
        context,
        {
          articleUrls: [`${origin}/events/purchase-offer.md`],
        },
      );
      assert.deepEqual(collectResult, {
        completedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
      });
      assert.equal(submissions.length, 1);
      assert.deepEqual(submissions[0]?.items[0]?.sourceKey, {
        namespace: "qoder:cn-docs",
        key: "events/purchase-offer",
      });
    } finally {
      server.close();
    }
  });
});

void describe("Qoder Scope Resolution and Regional Changelogs Unit Tests", () => {
  void test("determineActiveScopes activates appropriate scopes based on config and requestedScopes", () => {
    // Default config activates all 4 scopes
    const defaultConfig = configSchema.parse({});
    assert.deepEqual(determineActiveScopes(defaultConfig), [
      INTERNATIONAL_BLOG_SCOPE_ID,
      CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
      CN_CHANGELOGS_SCOPE_ID,
      INTERNATIONAL_CHANGELOGS_SCOPE_ID,
    ]);

    // Explicit requestedScopes overrides config
    assert.deepEqual(
      determineActiveScopes(defaultConfig, [CN_CHANGELOGS_SCOPE_ID]),
      [CN_CHANGELOGS_SCOPE_ID],
    );
    assert.deepEqual(
      determineActiveScopes(defaultConfig, [
        CN_CHANGELOGS_SCOPE_ID,
        INTERNATIONAL_CHANGELOGS_SCOPE_ID,
      ]),
      [CN_CHANGELOGS_SCOPE_ID, INTERNATIONAL_CHANGELOGS_SCOPE_ID],
    );

    // Custom blogListUrl only activates blog
    const blogConfig = configSchema.parse({
      blogListUrl: "https://example.com/custom-blog",
    });
    assert.deepEqual(determineActiveScopes(blogConfig), [
      INTERNATIONAL_BLOG_SCOPE_ID,
    ]);

    // Custom cnDocsIndexUrl only activates cn announcements/events (backward compat with ticket 10)
    const cnDocsConfig = configSchema.parse({
      cnDocsIndexUrl: "https://example.com/custom-llms.txt",
    });
    assert.deepEqual(determineActiveScopes(cnDocsConfig), [
      CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
    ]);

    // Custom intChangelogIndexUrl activates international changelogs
    const intChangelogConfig = configSchema.parse({
      intChangelogIndexUrl: "https://example.com/custom-changelog.txt",
    });
    assert.deepEqual(determineActiveScopes(intChangelogConfig), [
      INTERNATIONAL_CHANGELOGS_SCOPE_ID,
    ]);

    // Multiple custom URLs activate matching scopes
    const multiConfig = configSchema.parse({
      cnDocsIndexUrl: "https://example.com/custom-llms.txt",
      intChangelogIndexUrl: "https://example.com/custom-changelog.txt",
    });
    assert.deepEqual(determineActiveScopes(multiConfig), [
      CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
      CN_CHANGELOGS_SCOPE_ID,
      INTERNATIONAL_CHANGELOGS_SCOPE_ID,
    ]);
  });

  void test("isChangelogSectionHeading identifies changelog sections and ignores other sections", () => {
    assert.equal(isChangelogSectionHeading("更新日志"), true);
    assert.equal(isChangelogSectionHeading("变更日志"), true);
    assert.equal(isChangelogSectionHeading("Changelogs"), true);
    assert.equal(isChangelogSectionHeading("Release Notes"), true);
    assert.equal(isChangelogSectionHeading("产品公告"), false);
    assert.equal(isChangelogSectionHeading("事件"), false);
    assert.equal(isChangelogSectionHeading("计费"), false);
  });

  void test("isNavigationDocKey and isNavigationPageContent identify overview pages and protect actual changelogs", () => {
    // Navigation overview keys
    assert.equal(
      isNavigationDocKey("product-overview/qoder-cn-update-log"),
      true,
    );
    assert.equal(
      isNavigationDocKey("zh/release-notes/qoder-cn-update-log"),
      true,
    );
    assert.equal(isNavigationDocKey("changelogs"), true);
    assert.equal(isNavigationDocKey("content/overview"), true);

    // Actual changelog keys MUST NOT be matched as navigation
    assert.equal(
      isNavigationDocKey("product-overview/qoder-update-log"),
      false,
    );
    assert.equal(isNavigationDocKey("product-overview/qoder-cn-cli"), false);
    assert.equal(isNavigationDocKey("content/changelog"), false);
    assert.equal(isNavigationDocKey("content/changelog-cli"), false);

    // Navigation content with <Card> and no <Update>
    const navContent = `
# 更新日志汇总
<CardGroup>
  <Card title="Qoder 桌面端" href="/product-overview/qoder-update-log.md">桌面端更新</Card>
  <Card title="CLI" href="/product-overview/qoder-cn-cli.md">CLI更新</Card>
</CardGroup>
`;
    assert.equal(isNavigationPageContent(navContent), true);

    // Actual changelog content with <Update>
    const changelogContent = `
# Qoder CLI 更新日志
<Update label="2026-11-03" description="1.1.82">
  - Added new login command.
</Update>
`;
    assert.equal(isNavigationPageContent(changelogContent), false);
  });

  void test("extractCardLinks extracts card href and title from MDX", () => {
    const mdx = `
<Card title="Qoder IDE" href="/product-overview/qoder-update-log.md">
  Qoder IDE 更新日志
</Card>
<Card href="/product-overview/qoder-cn-cli.md">
  Qoder CLI 工具
</Card>
`;
    const cards = extractCardLinks(mdx);
    assert.equal(cards.length, 2);
    assert.equal(cards[0]?.title, "Qoder IDE");
    assert.equal(cards[0]?.href, "/product-overview/qoder-update-log.md");
    assert.equal(cards[1]?.title, "Qoder CLI 工具");
    assert.equal(cards[1]?.href, "/product-overview/qoder-cn-cli.md");
  });

  void test("parseUpdateDate, extractVersion, and parseChangelogMetadata preserve date precision without timestamp fabrication", () => {
    // Day precision: YYYY-MM-DD
    const dayResult = parseUpdateDate("2026-10-29");
    assert.deepEqual(dayResult, { date: "2026-10-29", precision: "day" });

    // Day precision: dot notation
    const dotResult = parseUpdateDate("2026.11.03");
    assert.deepEqual(dotResult, { date: "2026-11-03", precision: "day" });

    // Day precision: Chinese
    const cnResult = parseUpdateDate("2026年10月29日");
    assert.deepEqual(cnResult, { date: "2026-10-29", precision: "day" });

    // Month precision: English
    const monthResult = parseUpdateDate("October 2026");
    assert.deepEqual(monthResult, { date: "2026-10", precision: "month" });

    // Month precision: YYYY-MM
    const ymResult = parseUpdateDate("2026-10");
    assert.deepEqual(ymResult, { date: "2026-10", precision: "month" });

    // extractVersion
    assert.equal(extractVersion("CLI 1.1.82"), "1.1.82");
    assert.equal(extractVersion("Qoder 0.5.3"), "0.5.3");
    assert.equal(extractVersion("v0.2.30"), "0.2.30");

    // parseChangelogMetadata with Update items
    const meta1 = parseChangelogMetadata(
      [{ label: "2026-10-29", description: "0.2.30" }],
      "",
    );
    assert.equal(meta1.latestUpdateLabel, "2026-10-29");
    assert.equal(meta1.latestUpdateDate, "2026-10-29");
    assert.equal(meta1.datePrecision, "day");
    assert.equal(meta1.latestVersion, "0.2.30");

    const meta2 = parseChangelogMetadata(
      [{ label: "October 2026", description: "Qoder 0.5.3" }],
      "",
    );
    assert.equal(meta2.latestUpdateLabel, "October 2026");
    assert.equal(meta2.latestUpdateDate, "2026-10");
    assert.equal(meta2.datePrecision, "month");
    assert.equal(meta2.latestVersion, "0.5.3");
  });

  void test("discoverCnChangelogDocs traverses navigation overview page to discover linked changelogs and excludes navigation page", async () => {
    const mockLlmsTxt = `
# Qoder CN Docs

## 产品公告
- [Fast 模式上线](/product-overview/fast-mode-announcement.md)

## 更新日志
- [Qoder CN 更新日志汇总](/product-overview/qoder-cn-update-log.md): 导航汇总
- [Qoder Quest 更新日志](/product-overview/qoder-cn-quest.md): Quest 产品日志
`;
    const mockNavMd = `
# Qoder CN 更新日志

<CardGroup>
  <Card title="Qoder 桌面端" href="/product-overview/qoder-update-log.md">桌面端日志</Card>
  <Card title="Qoder CLI" href="/product-overview/qoder-cn-cli.md">CLI 日志</Card>
</CardGroup>
`;

    const fetchMock = async (url: string) => {
      if (url.includes("qoder-cn-update-log")) {
        return mockNavMd;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const docs = await discoverCnChangelogDocs(
      mockLlmsTxt,
      "https://docs.qoder.cn/llms.txt",
      fetchMock,
    );

    // CRITICAL: qoder-cn-update-log must NOT be in the returned changelog docs!
    const docKeys = docs.map((d) => d.docKey);
    assert.ok(!docKeys.includes("product-overview/qoder-cn-update-log"));

    // Linked product changelogs discovered from Card elements:
    assert.ok(docKeys.includes("product-overview/qoder-update-log"));
    assert.ok(docKeys.includes("product-overview/qoder-cn-cli"));
    // Direct product changelog from llms.txt:
    assert.ok(docKeys.includes("product-overview/qoder-cn-quest"));
    assert.equal(docs.length, 3);
  });

  void test("discoverInternationalChangelogDocs extracts changelog documents from international index", async () => {
    assert.equal(
      DEFAULT_INTERNATIONAL_CHANGELOG_URL,
      "https://changelog.qoder.com/llms.txt",
    );

    const intLlmsTxt = `
# Qoder International Changelogs

## Changelogs
- [Qoder IDE](https://changelog.qoder.com/content/changelog.md): Desktop IDE updates
- [CLI Tool](https://changelog.qoder.com/content/changelog-cli.md): Command line tool
`;
    const docs = await discoverInternationalChangelogDocs(
      intLlmsTxt,
      DEFAULT_INTERNATIONAL_CHANGELOG_URL,
    );
    assert.equal(docs.length, 2);
    assert.equal(docs[0]?.docKey, "content/changelog");
    assert.equal(docs[0]?.title, "Qoder IDE");
    assert.equal(docs[1]?.docKey, "content/changelog-cli");
    assert.equal(docs[1]?.title, "CLI Tool");
  });

  void test("discoverCnChangelogDocs falls back to DEFAULT_CN_CHANGELOG_URL and handles bare ## line", async () => {
    assert.equal(
      DEFAULT_CN_CHANGELOG_URL,
      "https://changelog.qoder.cn/llms.txt",
    );

    const docsLlmsTxt = `
# Qoder CN Docs

## 产品公告
- [Fast 模式上线](/product-overview/fast-mode-announcement.md)
`;
    const changelogLlmsTxt = `
# Qoder CN 更新日志

- [Qoder CLI](/cli/changelog.md): CLI 更新日志
## 
- [Qoder Mobile](/mobile/changelog.md): 移动端更新日志
`;

    const requestedUrls: string[] = [];
    const fetchMock = async (url: string) => {
      requestedUrls.push(url);
      if (url === DEFAULT_CN_CHANGELOG_URL) {
        return changelogLlmsTxt;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const docs = await discoverCnChangelogDocs(
      docsLlmsTxt,
      DEFAULT_CN_DOCS_INDEX_URL,
      fetchMock,
    );

    assert.deepEqual(requestedUrls, [DEFAULT_CN_CHANGELOG_URL]);
    assert.equal(docs.length, 2);
    assert.equal(docs[0]?.docKey, "cli/changelog");
    assert.equal(
      docs[0]?.canonicalUrl,
      "https://changelog.qoder.cn/cli/changelog",
    );
    assert.equal(
      docs[0]?.fetchUrl,
      "https://changelog.qoder.cn/cli/changelog.md",
    );
    assert.equal(docs[1]?.docKey, "mobile/changelog");
    assert.equal(
      docs[1]?.canonicalUrl,
      "https://changelog.qoder.cn/mobile/changelog",
    );
    assert.equal(
      docs[1]?.fetchUrl,
      "https://changelog.qoder.cn/mobile/changelog.md",
    );
  });
});

void describe("Qoder CN Product Changelogs Action Flow", () => {
  void test("full CN product changelog lifecycle: navigation discovery exclusion, baseline, change detection, and collect", async () => {
    let cliContentVersion = 1;
    let cliServerError = false;
    const detailRequests: string[] = [];
    const submissions: SourceAdapterArchiveSubmission[] = [];
    const uploadedResources: ArchiveResourceMetadata[] = [];

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/llms.txt") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(`
# Qoder CN Docs

## 产品公告
- [Fast 模式上线](/product-overview/fast-mode-announcement.md)

## 更新日志
- [Qoder CN 更新日志](/product-overview/qoder-cn-update-log.md): 导航页
- [Qoder Quest](/product-overview/qoder-cn-quest.md): Quest 产品日志
        `);
        return;
      }

      // Navigation overview page containing cards
      if (path === "/product-overview/qoder-cn-update-log.md") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`
# Qoder CN 更新日志

以下为各产品最新更新日志入口：

<CardGroup>
  <Card title="Qoder 桌面端" href="/product-overview/qoder-update-log.md">
    Qoder 桌面端 IDE 更新日志
  </Card>
  <Card title="Qoder CLI" href="/product-overview/qoder-cn-cli.md">
    Qoder CLI 工具更新日志
  </Card>
</CardGroup>
        `);
        return;
      }

      // Actual IDE changelog with Update tag, Mintlify noise, and image
      if (path === "/product-overview/qoder-update-log.md") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`> ## Documentation Index
> Fetch the complete documentation index at: https://docs.qoder.cn/llms.txt
> Use this file to discover all available pages before exploring further.

# Qoder 桌面端更新日志

<style>
  .custom-style { color: red; }
</style>

<Update label="2026-11-03" description="Qoder 0.5.3">
  - 优化代码补全性能。
  - 修复多光标编辑偶发卡顿问题。
</Update>

<a id="ide-screenshot" style={{ display: "block" }} />

![Qoder IDE Screenshot](/media/ide.png)

<Update label="2026-10-20" description="Qoder 0.5.2">
  - 新增智能问答模式。
</Update>
        `);
        return;
      }

      // CLI changelog
      if (path === "/product-overview/qoder-cn-cli.md") {
        detailRequests.push(path);
        if (cliServerError) {
          response.writeHead(500);
          response.end("Internal Server Error");
          return;
        }

        let updatesMd = `
<Update label="2026-10-29" description="CLI 1.1.80">
  - 新增 qoder login 命令行工具支持。
</Update>
`;
        if (cliContentVersion >= 2) {
          updatesMd = `
<Update label="2026-11-05" description="CLI 1.1.82">
  - 增强网络重试策略。
</Update>

${updatesMd}
`;
        }

        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`
# Qoder CLI 更新日志

${updatesMd}
        `);
        return;
      }

      // Quest changelog
      if (path === "/product-overview/qoder-cn-quest.md") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`
# Qoder Quest 更新日志

<Update label="2026-10-15" description="0.1.0">
  - Qoder Quest 首个公开版本发布。
</Update>
        `);
        return;
      }

      // Media image
      if (path === "/media/ide.png") {
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
      rawConfig: Partial<QoderConfig>,
    ): SourceAdapterContext<QoderConfig> {
      const config = configSchema.parse(rawConfig);
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
        cnDocsIndexUrl: `${origin}/llms.txt`,
      });

      // 1. Check Action
      const checkResult = await sourceAdapter.actions.check.execute(context, {
        scopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(checkResult.availability, "available");
      assert.deepEqual(checkResult.scope, [CN_CHANGELOGS_SCOPE_ID]);
      assert.equal(checkResult.problems.length, 0);

      // 2. Initial Sync establishes baseline WITHOUT archiving (0 commits)
      detailRequests.length = 0;
      submissions.length = 0;

      const initialSync = await sourceAdapter.actions.sync.execute(context, {
        scopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.deepEqual(initialSync, {
        completedScopes: [CN_CHANGELOGS_SCOPE_ID],
        initializedScopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      // CRITICAL: 0 archive submissions on baseline!
      assert.equal(submissions.length, 0);

      // Verify persistent state baseline entries
      assert.ok(storedState !== undefined);
      const scopeState = storedState.scopes[CN_CHANGELOGS_SCOPE_ID];
      assert.ok(scopeState !== undefined);
      assert.ok(scopeState.ongoingDocuments !== undefined);
      // Actual product changelogs ARE tracked
      assert.ok(
        scopeState.ongoingDocuments["product-overview/qoder-update-log"]
          ?.contentHash !== undefined,
      );
      assert.ok(
        scopeState.ongoingDocuments["product-overview/qoder-cn-cli"]
          ?.contentHash !== undefined,
      );
      assert.ok(
        scopeState.ongoingDocuments["product-overview/qoder-cn-quest"]
          ?.contentHash !== undefined,
      );
      // CRITICAL: Navigation overview page is NOT tracked or archived as changelog
      assert.equal(
        scopeState.ongoingDocuments["product-overview/qoder-cn-update-log"],
        undefined,
      );

      // 3. Second Sync with no content changes makes 0 submissions
      detailRequests.length = 0;
      submissions.length = 0;

      const repeatSync = await sourceAdapter.actions.sync.execute(context, {
        scopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.deepEqual(repeatSync, {
        completedScopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(submissions.length, 0);

      // 4. Third Sync when CLI changelog has new <Update> added
      cliContentVersion = 2;
      detailRequests.length = 0;
      submissions.length = 0;

      const changedSync = await sourceAdapter.actions.sync.execute(context, {
        scopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.deepEqual(changedSync, {
        completedScopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      // Exactly 1 new revision submitted for the changed document!
      assert.equal(submissions.length, 1);

      const submission = submissions[0]!;
      const item = submission.items[0]!;

      // Identity verification: regional namespace and route key
      assert.deepEqual(item.sourceKey, {
        namespace: "qoder:cn:changelog",
        key: "product-overview/qoder-cn-cli",
      });
      assert.equal(item.sourceRef, `${origin}/product-overview/qoder-cn-cli`);
      // Date and version metadata verification
      assert.equal(item.sourceModifiedAt, undefined); // NEVER fabricate!
      assert.equal(item.metadata?.region, "cn");
      assert.equal(item.metadata?.language, "zh-CN");
      assert.equal(item.metadata?.category, "changelog");
      assert.equal(item.metadata?.latestUpdateDate, "2026-11-05");
      assert.equal(item.metadata?.datePrecision, "day");
      assert.equal(item.metadata?.latestVersion, "1.1.82");

      // Verify transformed body structure: Update block converted to Markdown heading
      const body = item.body as { markdown: string; text: string };
      assert.ok(typeof body.markdown === "string");
      assert.match(body.markdown, /## 2026-11-05 \(CLI 1.1\.82\)/u);
      assert.match(body.markdown, /增强网络重试策略/u);
      assert.doesNotMatch(body.markdown, /<Update/u);

      // 5. Fourth Sync: server error on product changelog fails sync without advancing state
      cliServerError = true;
      detailRequests.length = 0;
      submissions.length = 0;

      await assert.rejects(
        async () => {
          await sourceAdapter.actions.sync.execute(context, {
            scopes: [CN_CHANGELOGS_SCOPE_ID],
          });
        },
        (error: unknown) => {
          assert.ok(isSourceAdapterActionError(error));
          return true;
        },
      );
      assert.equal(submissions.length, 0);
      cliServerError = false;

      // 6. Collect Action on specific product changelog document
      detailRequests.length = 0;
      submissions.length = 0;
      uploadedResources.length = 0;

      const collectResult = await sourceAdapter.actions.collect.execute(
        context,
        {
          scopes: [CN_CHANGELOGS_SCOPE_ID],
          articleUrls: [`${origin}/product-overview/qoder-update-log.md`],
        },
      );
      assert.deepEqual(collectResult, {
        completedScopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(submissions.length, 1);

      const collectedItem = submissions[0]!.items[0]!;
      assert.deepEqual(collectedItem.sourceKey, {
        namespace: "qoder:cn:changelog",
        key: "product-overview/qoder-update-log",
      });
      assert.equal(collectedItem.metadata?.region, "cn");
      assert.equal(collectedItem.metadata?.language, "zh-CN");
      assert.equal(collectedItem.metadata?.category, "changelog");
      assert.equal(collectedItem.metadata?.latestUpdateDate, "2026-11-03");
      assert.equal(collectedItem.metadata?.latestVersion, "0.5.3");

      // Media upload and URL rewriting verification
      assert.equal(uploadedResources.length, 1);
      const ideBody = collectedItem.body as { markdown: string };
      assert.match(ideBody.markdown, /binny:\/\/resource\//u);
      // Noise elements stripped from body
      assert.doesNotMatch(ideBody.markdown, /Documentation Index/u);
      assert.doesNotMatch(ideBody.markdown, /<style>/u);
      assert.doesNotMatch(ideBody.markdown, /<a id=/u);

      // 7. Explicit Collect rejects navigation overview page
      await assert.rejects(
        async () => {
          await sourceAdapter.actions.collect.execute(context, {
            scopes: [CN_CHANGELOGS_SCOPE_ID],
            articleUrls: [`${origin}/product-overview/qoder-cn-update-log.md`],
          });
        },
        (error: unknown) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.match(
            error.failure.message,
            /navigation overview page.*cannot be archived/iu,
          );
          return true;
        },
      );
    } finally {
      server.close();
    }
  });

  void test("check, sync, and collect fall back to changelog.qoder.cn when docs.qoder.cn has no changelog section", async () => {
    let commitSeq = 0;
    const requestedUrls: string[] = [];
    const submissions: SourceAdapterArchiveSubmission[] = [];
    let storedState: IncrementalSyncState | undefined;

    const mockDocsLlms = `# Qoder CN 文档\n\n## 快速入门\n- [快速开始](/quickstart.md)`;
    const mockChangelogLlms = `# Qoder CN 更新日志\n\n- [Qoder CLI](/cli/changelog.md): CLI 更新日志\n## \n- [Qoder Mobile](/mobile/changelog.md): Mobile 更新日志`;
    const mockCliMd = `---
title: Qoder CLI
---
<Update label="2026-11-05" description="CLI 1.1.82">
CLI 更新说明
</Update>`;
    const mockMobileMd = `---
title: Qoder Mobile
---
<Update label="2026-11-04" description="Mobile 1.0.12">
Mobile 更新说明
</Update>`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, _init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requestedUrls.push(url);

      if (url === DEFAULT_CN_DOCS_INDEX_URL) {
        return new Response(mockDocsLlms, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url === DEFAULT_CN_CHANGELOG_URL) {
        return new Response(mockChangelogLlms, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url === "https://changelog.qoder.cn/cli/changelog.md") {
        return new Response(mockCliMd, {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
      if (url === "https://changelog.qoder.cn/mobile/changelog.md") {
        return new Response(mockMobileMd, {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    try {
      const runId = randomUUID();
      const context: SourceAdapterContext<QoderConfig> = {
        binId: "qoder-test-bin",
        identityId: "qoder-test-identity",
        runId,
        referenceTime: "2026-11-07T12:00:00.000Z",
        sourceAdapterVersion: sourceAdapter.version,
        config: configSchema.parse({}),
        signal: new AbortController().signal,
        persistentState: {
          async load() {
            return storedState as Record<string, unknown> | undefined;
          },
          async save(state) {
            storedState = state as IncrementalSyncState;
          },
        },
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
          async upload() {
            return {
              ok: true,
              resource: {
                resourceId: randomUUID(),
                sha256: "0".repeat(64),
                mediaType: "image/png",
                size: 10,
              },
            } as const;
          },
        },
      };

      // 1. Check Action falls back to changelog.qoder.cn and succeeds
      const checkResult = await sourceAdapter.actions.check.execute(context, {
        scopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(checkResult.availability, "available");
      assert.deepEqual(checkResult.scope, [CN_CHANGELOGS_SCOPE_ID]);
      assert.equal(checkResult.problems.length, 0);
      assert.ok(requestedUrls.includes(DEFAULT_CN_CHANGELOG_URL));

      // 2. Initial Sync establishes baseline for both changelogs discovered via fallback
      submissions.length = 0;
      const initialSync = await sourceAdapter.actions.sync.execute(context, {
        scopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.deepEqual(initialSync, {
        completedScopes: [CN_CHANGELOGS_SCOPE_ID],
        initializedScopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(submissions.length, 0);
      assert.ok(storedState !== undefined);
      const scopeState = storedState.scopes[CN_CHANGELOGS_SCOPE_ID];
      assert.ok(scopeState !== undefined);
      assert.ok(scopeState.ongoingDocuments !== undefined);
      assert.ok(scopeState.ongoingDocuments["cli/changelog"] !== undefined);
      assert.ok(scopeState.ongoingDocuments["mobile/changelog"] !== undefined);

      // 3. Collect Action without explicit URLs collects all items via fallback
      submissions.length = 0;
      const collectAll = await sourceAdapter.actions.collect.execute(context, {
        scopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.deepEqual(collectAll, {
        completedScopes: [CN_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(submissions.length, 2);
      assert.equal(submissions[0]!.items[0]!.sourceKey.key, "cli/changelog");
      assert.equal(
        submissions[0]!.items[0]!.sourceRef,
        "https://changelog.qoder.cn/cli/changelog",
      );
      assert.equal(submissions[1]!.items[0]!.sourceKey.key, "mobile/changelog");
      assert.equal(
        submissions[1]!.items[0]!.sourceRef,
        "https://changelog.qoder.cn/mobile/changelog",
      );

      // 4. Collect Action with explicit changelog.qoder.cn URL resolves against DEFAULT_CN_CHANGELOG_URL
      // and when scopes is omitted, cn-announcements-events filters out changelog.qoder.cn URLs
      submissions.length = 0;
      const explicitCollect = await sourceAdapter.actions.collect.execute(
        context,
        {
          articleUrls: ["https://changelog.qoder.cn/cli/changelog"],
        },
      );
      assert.ok(
        explicitCollect.completedScopes.includes(CN_CHANGELOGS_SCOPE_ID),
      );
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0]!.items[0]!.sourceKey.key, "cli/changelog");
      assert.equal(
        submissions[0]!.items[0]!.sourceRef,
        "https://changelog.qoder.cn/cli/changelog",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

void describe("Qoder International Product Changelogs Action Flow", () => {
  void test("full International product changelog lifecycle: baseline, change detection, and collect", async () => {
    let cliContentVersion = 1;
    const detailRequests: string[] = [];
    const submissions: SourceAdapterArchiveSubmission[] = [];
    const uploadedResources: ArchiveResourceMetadata[] = [];

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/llms.txt") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(`
# Qoder International Changelogs

## Changelogs
- [Qoder IDE](/content/changelog.md): Desktop IDE updates
- [Qoder CLI](/content/changelog-cli.md): Command line tool updates
        `);
        return;
      }

      if (path === "/content/changelog.md") {
        detailRequests.push(path);
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`
# Qoder IDE Changelog

<Update label="October 2026" description="v0.5.3">
  - Added fast generation mode.
  - Multi-tab completion improvements.
</Update>
        `);
        return;
      }

      if (path === "/content/changelog-cli.md") {
        detailRequests.push(path);
        let updatesMd = `
<Update label="2026-10-25" description="1.1.80">
  - Initial public CLI release.
</Update>
`;
        if (cliContentVersion >= 2) {
          updatesMd = `
<Update label="2026-11-02" description="1.1.82">
  - Fixed proxy authentication bug.
</Update>

${updatesMd}
`;
        }

        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
        });
        response.end(`
# Qoder CLI Changelog

${updatesMd}
        `);
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
      rawConfig: Partial<QoderConfig>,
    ): SourceAdapterContext<QoderConfig> {
      const config = configSchema.parse(rawConfig);
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
        intChangelogIndexUrl: `${origin}/llms.txt`,
      });

      // 1. Check Action
      const checkResult = await sourceAdapter.actions.check.execute(context, {
        scopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(checkResult.availability, "available");
      assert.deepEqual(checkResult.scope, [INTERNATIONAL_CHANGELOGS_SCOPE_ID]);
      assert.equal(checkResult.problems.length, 0);

      // 2. Initial Sync establishes baseline WITHOUT archiving (0 commits)
      detailRequests.length = 0;
      submissions.length = 0;

      const initialSync = await sourceAdapter.actions.sync.execute(context, {
        scopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      });
      assert.deepEqual(initialSync, {
        completedScopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
        initializedScopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(submissions.length, 0);

      // Verify ongoing documents hashes in state
      assert.ok(storedState !== undefined);
      const scopeState = storedState.scopes[INTERNATIONAL_CHANGELOGS_SCOPE_ID];
      assert.ok(scopeState !== undefined);
      assert.ok(scopeState.ongoingDocuments !== undefined);
      assert.ok(
        scopeState.ongoingDocuments["content/changelog"]?.contentHash !==
          undefined,
      );
      assert.ok(
        scopeState.ongoingDocuments["content/changelog-cli"]?.contentHash !==
          undefined,
      );

      // 3. Second Sync with unchanged content makes 0 submissions
      detailRequests.length = 0;
      submissions.length = 0;

      const repeatSync = await sourceAdapter.actions.sync.execute(context, {
        scopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      });
      assert.deepEqual(repeatSync, {
        completedScopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(submissions.length, 0);

      // 4. Third Sync when CLI changelog is updated
      cliContentVersion = 2;
      detailRequests.length = 0;
      submissions.length = 0;

      const changedSync = await sourceAdapter.actions.sync.execute(context, {
        scopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      });
      assert.deepEqual(changedSync, {
        completedScopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(submissions.length, 1);

      const submission = submissions[0]!;
      const item = submission.items[0]!;

      // Verify international changelog identity
      assert.deepEqual(item.sourceKey, {
        namespace: "qoder:international:changelog",
        key: "content/changelog-cli",
      });
      assert.equal(item.sourceRef, `${origin}/content/changelog-cli`);
      assert.equal(item.sourceModifiedAt, undefined);
      assert.equal(item.metadata?.region, "international");
      assert.equal(item.metadata?.language, "en");
      assert.equal(item.metadata?.category, "changelog");
      assert.equal(item.metadata?.latestUpdateDate, "2026-11-02");
      assert.equal(item.metadata?.datePrecision, "day");
      assert.equal(item.metadata?.latestVersion, "1.1.82");

      // 5. Collect Action on specific changelog document
      detailRequests.length = 0;
      submissions.length = 0;

      const collectResult = await sourceAdapter.actions.collect.execute(
        context,
        {
          scopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
          articleUrls: [`${origin}/content/changelog.md`],
        },
      );
      assert.deepEqual(collectResult, {
        completedScopes: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      });
      assert.equal(submissions.length, 1);

      const collectedItem = submissions[0]!.items[0]!;
      assert.deepEqual(collectedItem.sourceKey, {
        namespace: "qoder:international:changelog",
        key: "content/changelog",
      });
      assert.equal(collectedItem.metadata?.region, "international");
      assert.equal(collectedItem.metadata?.language, "en");
      assert.equal(collectedItem.metadata?.category, "changelog");
      assert.equal(collectedItem.metadata?.latestUpdateDate, "2026-10");
      assert.equal(collectedItem.metadata?.datePrecision, "month");
      assert.equal(collectedItem.metadata?.latestVersion, "0.5.3");
    } finally {
      server.close();
    }
  });
});
