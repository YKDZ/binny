// Comprehensive tests for Anthropic News, Research, and Engineering source adapter.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import type {
  ArchiveResourceMetadata,
  ArchiveSubmissionInput,
  IncrementalSyncState,
  SourceAdapterApiClient,
} from "@binny/source-adapter-sdk";
import {
  createSourceAdapterContext,
  isSourceAdapterActionError,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import { sourceAdapter } from "../src/index.ts";

void test("anthropic adapter exports valid manifest", () => {
  assert.equal(sourceAdapter.id, "anthropic");
  assert.equal(sourceAdapter.version, "0.1.0");
  assert.ok("check" in sourceAdapter.actions);
  assert.ok("collect" in sourceAdapter.actions);
  assert.ok("sync" in sourceAdapter.actions);

  // Verify config defaults work with empty object
  const parsedConfig = sourceAdapter.configSchema.parse({});
  assert.equal(parsedConfig.sections.length, 3);
  assert.deepEqual(
    parsedConfig.sections.map((s) => s.id),
    ["news", "research", "engineering"],
  );
});

type AnthropicConfig = z.output<typeof sourceAdapter.configSchema>;

void test("Anthropic actions: discovery, cross-section deduplication, layout extraction, and incremental sync", async () => {
  let storedPersistentState: IncrementalSyncState | undefined;
  const persistentState = {
    async load() {
      return storedPersistentState;
    },
    async save(state: unknown) {
      storedPersistentState = state as IncrementalSyncState;
    },
  };

  let newsVersion = 1;
  let engineeringFails = false;
  let detailFail404 = false;
  let detailFailEmpty = false;

  const detailRequests: string[] = [];
  const submissions: ArchiveSubmissionInput[] = [];
  const resources: ArchiveResourceMetadata[] = [];
  let commitSeq = 0;
  const runId = randomUUID();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Track detail page requests
    if (
      path.startsWith("/claude-") ||
      path.startsWith("/research/") ||
      (path.startsWith("/news/") && path !== "/news") ||
      path === "/broken-detail" ||
      path === "/empty-detail"
    ) {
      detailRequests.push(path);
    }

    if (path === "/news") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const newAnnouncementCard =
        newsVersion >= 2
          ? `<article class="tile"><a href="/news/new-frontier-announcement"><h3>New Frontier Announcement</h3></a><time datetime="2026-11-05">Nov 5, 2026</time><span class="category">Announcements</span></article>`
          : "";

      res.end(`<!doctype html>
<html>
<head><title>Anthropic News</title></head>
<body>
  <header><nav><a href="/pricing">Pricing</a><a href="/careers">Careers</a><a href="/login">Login</a></nav></header>
  <main>
    <div class="featured-grid">
      <article class="featured">
        <a href="/claude-opus-5-5" class="title-link"><h3>Introducing Claude Opus 5.5</h3></a>
        <p>Claude Opus 5.5 is our fastest, most capable model.</p>
        <time datetime="2026-09-22">Sep 22, 2026</time>
        <span class="eyebrow">Announcements</span>
      </article>
      <article class="tile">
        <a href="/news/public-benefit-fund" class="title-link"><h3>Investing in the Public Benefit</h3></a>
        <time datetime="2026-10-18">Oct 18, 2026</time>
        <span class="category">Company</span>
      </article>
      ${newAnnouncementCard}
    </div>
    <div class="utility-footer">
      <a href="mailto:press@anthropic.com">Press</a>
      <a href="/press-kit">Press Kit</a>
      <a href="/search?q=test">Search</a>
    </div>
  </main>
  <footer><p>© 2026 Anthropic PBC</p></footer>
</body>
</html>`);
      return;
    }

    if (path === "/research") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head><title>Anthropic Research</title></head>
<body>
  <main>
    <div class="articles-list">
      <div class="card expander">
        <a href="/research/cross-cutting-agent" class="title-link"><h3>Cross Cutting Agent Research</h3></a>
        <time datetime="2026-10-15">Oct 15, 2026</time>
        <span class="label">Research</span>
      </div>
      <div class="card expander">
        <a href="/research/provable-inference" class="title-link"><h3>Progress on Provable Inference</h3></a>
        <time datetime="2026-11-02">Nov 2, 2026</time>
        <span class="label">Research</span>
      </div>
    </div>
  </main>
</body>
</html>`);
      return;
    }

    if (path === "/engineering") {
      if (engineeringFails) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head><title>Anthropic Engineering</title></head>
<body>
  <main>
    <div class="articles-list">
      <!-- Shared article also linked from /research -->
      <div class="card expander">
        <a href="/research/cross-cutting-agent" class="title-link"><h3>Cross Cutting Agent Research</h3></a>
        <time datetime="2026-10-15">Oct 15, 2026</time>
        <span class="label">Engineering</span>
      </div>
      <div class="card expander">
        <a href="/research/redesigning-source-control" class="title-link"><h3>Redesigning Source Control at Anthropic</h3></a>
        <time datetime="2026-10-13">Oct 13, 2026</time>
        <span class="label">Engineering</span>
      </div>
    </div>
  </main>
</body>
</html>`);
      return;
    }

    if (path === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/claude-opus-5-5</loc>
    <lastmod>2026-10-25T14:30:00Z</lastmod>
  </url>
  <url>
    <loc>${origin}/research/cross-cutting-agent</loc>
    <lastmod>2026-10-16T12:00:00Z</lastmod>
  </url>
  <url>
    <loc>${origin}/news/new-frontier-announcement</loc>
    <lastmod>2026-11-05T15:00:00Z</lastmod>
  </url>
</urlset>`);
      return;
    }

    // Detail page 1: Model release page layout (/claude-opus-5-5)
    if (path === "/claude-opus-5-5") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head>
  <title>Introducing Claude Opus 5.5 \\ Anthropic</title>
  <meta property="og:title" content="Introducing Claude Opus 5.5" />
  <!-- Deliberately no article:published_time to test date precision preservation -->
</head>
<body>
  <main>
    <nav class="breadcrumb" role="navigation" aria-label="breadcrumb">
      <a href="/">Home</a> &gt; <span>Claude Opus 5.5</span>
    </nav>
    <nav class="side-toc"><ol><li><a href="#intro">Overview</a></li></ol></nav>

    <div class="release-hero">
      <h1>Claude Opus 5.5</h1>
      <time datetime="2026-09-22">September 22, 2026</time>
      <p>We are introducing Claude Opus 5.5, our premier model for complex agentic workflows and coding.</p>
    </div>

    <section class="performance">
      <h2>Performance and Benchmarks</h2>
      <p>Opus 5.5 achieves state of the art results across coding and reasoning benchmarks:</p>
      <table>
        <thead><tr><th>Benchmark</th><th>Score</th></tr></thead>
        <tbody>
          <tr><td>SWE-bench Verified</td><td>74.2%</td></tr>
          <tr><td>TAU-bench</td><td>81.4%</td></tr>
        </tbody>
      </table>
      <pre><code class="language-python">import anthropic
client = anthropic.Anthropic()
message = client.messages.create(model="claude-opus-5-5", max_tokens=1024)</code></pre>
    </section>

    <!-- Testimonial article cards that must be stripped -->
    <div class="testimonials">
      <article class="card _16pwma_card _1oJwFW_card">
        <div class="_16pwma_body">
          <span class="label">Quote</span>
          <blockquote class="quote"><p>Opus 5.5 solved our hardest multi-repo migration overnight.</p></blockquote>
          <cite>Alpha Customer</cite>
        </div>
      </article>
      <article class="testimonial-card">
        <blockquote><p>Unbelievable leap in agentic execution speed.</p></blockquote>
        <cite>Beta Partner</cite>
      </article>
    </div>

    <!-- Carousel and CTA banners that must be stripped -->
    <div class="customer-quote-carousel"><p>Quotes carousel content</p></div>
    <div class="cta-banner"><a href="/pricing">Get started with Claude Opus 5.5</a></div>
    <section class="recommendations"><h3>Keep reading</h3><a href="/claude-sonnet-5-5">Sonnet 5.5</a></section>
  </main>
</body>
</html>`);
      return;
    }

    // Detail page 2: Standard article layout (/research/cross-cutting-agent)
    if (path === "/research/cross-cutting-agent") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head>
  <title>Cross Cutting Agent Research \\ Anthropic</title>
  <meta property="og:title" content="Cross Cutting Agent Research" />
  <meta property="article:published_time" content="2026-10-15T00:00:00.000Z" />
  <meta property="article:modified_time" content="2026-10-16T10:00:00.000Z" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Cross Cutting Agent Research",
    "datePublished": "2026-10-15T00:00:00.000Z",
    "dateModified": "2026-10-16T10:00:00.000Z"
  }
  </script>
</head>
<body>
  <main>
    <article class="standard-article">
      <nav class="breadcrumb"><a href="/research">Research</a> &gt; <span>Agents</span></nav>
      <div class="social-share"><button>Share</button></div>
      <h1>Cross Cutting Agent Research</h1>
      <p>This research explores shared abstractions for long-running autonomous agents.</p>
      <img src="/media/architecture.png" alt="Architecture Diagram" />
      <div class="author-social"><a href="https://x.com/researcher">Twitter</a></div>
      <div class="related-content"><h3>Related content</h3><a href="/research/other">Other work</a></div>
    </article>
  </main>
</body>
</html>`);
      return;
    }

    if (path === "/media/architecture.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return;
    }

    // Standard articles for other items
    if (
      path === "/research/provable-inference" ||
      path === "/research/redesigning-source-control" ||
      path === "/news/public-benefit-fund" ||
      path === "/news/new-frontier-announcement"
    ) {
      const title = path.slice(path.lastIndexOf("/") + 1).replace(/-/gu, " ");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head>
  <title>${title} \\ Anthropic</title>
  <meta property="og:title" content="${title}" />
  <meta property="article:published_time" content="2026-10-20T00:00:00.000Z" />
</head>
<body>
  <main>
    <article>
      <h1>${title}</h1>
      <p>Substantial article content describing ${title} at length.</p>
    </article>
  </main>
</body>
</html>`);
      return;
    }

    if (path === "/broken-detail") {
      if (detailFail404) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not Found");
        return;
      }
      if (detailFailEmpty) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><body><main></main></body></html>");
        return;
      }
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Server Error");
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

  const mockApiClient = {
    archives: {
      $post: async ({ json }: { json: ArchiveSubmissionInput }) => {
        submissions.push(json);
        commitSeq += 1;
        return {
          status: 201 as const,
          json: async () => ({
            commitId: randomUUID(),
            archiveSeq: String(commitSeq),
            binId: "anthropic-test-bin",
            runId,
            sourceAdapterVersion: sourceAdapter.version,
            observedAt: "2026-10-28T00:00:00.000Z",
            recordedAt: "2026-10-28T00:00:00.000Z",
            items: json.items.map((item) => ({
              itemId: randomUUID(),
              revisionId: randomUUID(),
              sourceKey: item.sourceKey,
            })),
            relations: [],
          }),
        };
      },
    },
    resources: {
      $post: async () => {
        const id = randomUUID();
        const res: ArchiveResourceMetadata = {
          resourceId: id,
          size: 8,
          mediaType: "image/png",
          sha256: "0123456789abcdef",
        };
        resources.push(res);
        return {
          status: 201 as const,
          json: async () => res,
        };
      },
      resolve: {
        $post: async () => ({
          status: 200 as const,
          json: async () => ({ resources: [] }),
        }),
      },
    },
  } as unknown as SourceAdapterApiClient;

  const context = createSourceAdapterContext<AnthropicConfig>(mockApiClient, {
    binId: "anthropic-test-bin",
    identityId: "anthropic-test-identity",
    runId,
    referenceTime: "2026-10-28T00:00:00.000Z",
    sourceAdapterVersion: sourceAdapter.version,
    report: async () => {},
    config: {
      sections: [
        { id: "news", url: `${origin}/news` },
        { id: "research", url: `${origin}/research` },
        { id: "engineering", url: `${origin}/engineering` },
      ],
      sitemapUrl: `${origin}/sitemap.xml`,
    },
    signal: new AbortController().signal,
    persistentState,
  });

  const { check, sync, collect } = sourceAdapter.actions;

  try {
    // 1. Verify `check` action against healthy server
    const checkResult = await check.execute(context, {});
    assert.equal(checkResult.availability, "available");
    assert.deepEqual(checkResult.scope, [
      "section:news",
      "section:research",
      "section:engineering",
    ]);
    assert.equal(checkResult.problems.length, 0);

    // 2. Verify `check` action reporting unavailable when a section fails
    engineeringFails = true;
    const failingCheckResult = await check.execute(context, {
      sectionIds: ["engineering"],
    });
    assert.equal(failingCheckResult.availability, "unavailable");
    assert.ok(failingCheckResult.problems.length > 0);
    assert.ok(failingCheckResult.problems[0]?.message.includes("HTTP 500"));
    engineeringFails = false;

    // 3. Initial sync establishes baseline ONLY (0 detail fetches, 0 submissions)
    detailRequests.length = 0;
    const beforeInitSubmissions = submissions.length;

    const initSyncResult = await sync.execute(context, {});
    assert.deepEqual(initSyncResult.completedScopes, [
      "section:news",
      "section:research",
      "section:engineering",
    ]);
    assert.deepEqual(initSyncResult.initializedScopes, [
      "section:news",
      "section:research",
      "section:engineering",
    ]);

    // Zero detail page requests and zero archive submissions on initial sync
    assert.equal(detailRequests.length, 0);
    assert.equal(submissions.length, beforeInitSubmissions);

    // Verify baseline entries recorded in state
    assert.ok(storedPersistentState !== undefined);
    const newsScope = storedPersistentState.scopes["news"];
    const researchScope = storedPersistentState.scopes["research"];
    const engineeringScope = storedPersistentState.scopes["engineering"];

    assert.ok(newsScope !== undefined);
    assert.ok(researchScope !== undefined);
    assert.ok(engineeringScope !== undefined);

    assert.equal(
      newsScope.entries["/claude-opus-5-5"]?.archivedCompleteness,
      "baseline",
    );
    assert.equal(
      researchScope.entries["/research/cross-cutting-agent"]
        ?.archivedCompleteness,
      "baseline",
    );
    assert.equal(
      engineeringScope.entries["/research/cross-cutting-agent"]
        ?.archivedCompleteness,
      "baseline",
    );

    // 4. Subsequent sync with no changes skips detail fetching
    detailRequests.length = 0;
    const noChangeSyncResult = await sync.execute(context, {});
    assert.deepEqual(noChangeSyncResult.completedScopes, [
      "section:news",
      "section:research",
      "section:engineering",
    ]);
    assert.equal(detailRequests.length, 0);
    assert.equal(submissions.length, beforeInitSubmissions);

    // 5. Subsequent sync with new article in /news: fetches detail and archives only new article
    newsVersion = 2;
    detailRequests.length = 0;
    const newArticleSyncResult = await sync.execute(context, {
      sectionIds: ["news"],
    });
    assert.deepEqual(newArticleSyncResult.completedScopes, ["section:news"]);
    assert.deepEqual(detailRequests, ["/news/new-frontier-announcement"]);
    assert.equal(submissions.length, beforeInitSubmissions + 1);

    const latestSubmission = submissions.at(-1);
    assert.ok(latestSubmission !== undefined);
    const item = latestSubmission?.items[0];
    if (!item) throw new Error("Expected item");
    assert.equal(item.sourceKey.namespace, "anthropic:article");
    assert.equal(item.sourceKey.key, "/news/new-frontier-announcement");
    // Verify sitemapLastMod is recorded as modification signal, not as publishedAt
    assert.equal(item.metadata?.sitemapLastMod, "2026-11-05T15:00:00Z");
    assert.equal(item.metadata?.publishedAt, "2026-10-20T00:00:00.000Z");
    assert.equal(
      storedPersistentState.scopes["news"]?.entries[
        "/news/new-frontier-announcement"
      ]?.archivedCompleteness,
      "complete",
    );

    // 6. Explicit collect: backfills model release and shared research article
    // Tests cross-section deduplication and extraction rules
    detailRequests.length = 0;

    const collectResult = await collect.execute(context, {
      itemUrls: [
        `${origin}/claude-opus-5-5`,
        `${origin}/research/cross-cutting-agent`,
      ],
    });
    assert.deepEqual(collectResult.completedScopes, [
      "item:/claude-opus-5-5",
      "item:/research/cross-cutting-agent",
    ]);

    // Model release page verification
    const opusSubmission = submissions.find(
      (sub) => sub.items[0]?.sourceKey.key === "/claude-opus-5-5",
    );
    assert.ok(opusSubmission !== undefined);
    const opusItem = opusSubmission?.items[0];
    if (!opusItem) throw new Error("Expected opusItem");

    // Single sourceKey identity
    assert.equal(opusItem.sourceKey.namespace, "anthropic:article");
    assert.equal(opusItem.sourceKey.key, "/claude-opus-5-5");

    // Model release date precision preservation: day precision, no fabricated sourceModifiedAt
    assert.equal(opusItem.sourceModifiedAt, undefined);
    assert.equal(opusItem.metadata?.publishedDate, "2026-09-22");
    assert.equal(opusItem.metadata?.datePrecision, "day");

    // Content extraction: benchmark table and code block kept; testimonial cards stripped
    const opusMarkdown = opusItem.body?.markdown ?? "";
    assert.ok(opusMarkdown.includes("Claude Opus 5.5"));
    assert.ok(opusMarkdown.includes("SWE-bench Verified"));
    assert.ok(opusMarkdown.includes("TAU-bench"));
    assert.ok(opusMarkdown.includes("client.messages.create"));
    assert.ok(!opusMarkdown.includes("Alpha Customer"));
    assert.ok(!opusMarkdown.includes("Beta Partner"));
    assert.ok(!opusMarkdown.includes("multi-repo migration overnight"));
    assert.ok(!opusMarkdown.includes("Get started with Claude Opus 5.5"));

    // Standard article verification (/research/cross-cutting-agent)
    const agentSubmission = submissions.find(
      (sub) => sub.items[0]?.sourceKey.key === "/research/cross-cutting-agent",
    );
    assert.ok(agentSubmission !== undefined);
    const agentItem = agentSubmission?.items[0];
    if (!agentItem) throw new Error("Expected agentItem");

    // Timestamp precision on standard article
    assert.equal(agentItem.metadata?.publishedAt, "2026-10-15T00:00:00.000Z");
    assert.equal(agentItem.sourceModifiedAt, "2026-10-16T10:00:00.000Z");

    // Standard article content: breadcrumb, share buttons, author social stripped
    const agentMarkdown = agentItem.body?.markdown ?? "";
    assert.ok(agentMarkdown.includes("Cross Cutting Agent Research"));
    assert.ok(!agentMarkdown.includes("Share on X"));
    assert.ok(!agentMarkdown.includes("Researcher Twitter"));
    assert.ok(!agentMarkdown.includes("Related content"));

    // Media resource upload and reference
    assert.ok(
      agentItem.resources !== undefined && agentItem.resources.length > 0,
    );
    assert.ok(agentMarkdown.includes("binny://resource/"));

    // 7. Collect across sections with cross-section deduplication
    detailRequests.length = 0;
    const beforeMultiSectionSubmissions = submissions.length;
    const multiSectionCollectResult = await collect.execute(context, {
      sectionIds: ["research", "engineering"],
    });

    assert.ok(
      multiSectionCollectResult.completedScopes.includes("section:research"),
    );
    assert.ok(
      multiSectionCollectResult.completedScopes.includes("section:engineering"),
    );

    // Cross-section article /research/cross-cutting-agent must be fetched only ONCE in this run
    const sharedFetches = detailRequests.filter(
      (p) => p === "/research/cross-cutting-agent",
    );
    assert.equal(sharedFetches.length, 1);

    // Verified metadata merged sections array
    const sharedSubmission = submissions
      .slice(beforeMultiSectionSubmissions)
      .find(
        (sub) =>
          sub.items[0]?.sourceKey.key === "/research/cross-cutting-agent",
      );
    assert.ok(sharedSubmission !== undefined);
    const sharedItem = sharedSubmission?.items[0];
    if (!sharedItem) throw new Error("Expected sharedItem");
    const sharedSections = sharedItem.metadata?.sections as
      | string[]
      | undefined;
    assert.ok(Array.isArray(sharedSections));
    assert.deepEqual(sharedSections, ["engineering", "research"]);

    // 8. Detail fetch failure without summary fallback
    detailFail404 = true;
    const failingCollectUrl = `${origin}/broken-detail`;

    await assert.rejects(
      async () => {
        await collect.execute(context, {
          itemUrls: [failingCollectUrl],
        });
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "anthropic_collection_incomplete");
        return true;
      },
    );

    // Verify NO fallback summary item was submitted for broken-detail
    const brokenSubmission = submissions.find(
      (sub) => sub.items[0]?.sourceRef === failingCollectUrl,
    );
    assert.equal(brokenSubmission, undefined);

    // 9. Detail empty body failure without summary fallback
    detailFail404 = false;
    detailFailEmpty = true;

    await assert.rejects(
      async () => {
        await collect.execute(context, {
          itemUrls: [failingCollectUrl],
        });
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "anthropic_collection_incomplete");
        return true;
      },
    );

    const emptySubmission = submissions.find(
      (sub) => sub.items[0]?.sourceRef === failingCollectUrl,
    );
    assert.equal(emptySubmission, undefined);
  } finally {
    server.close();
  }
});
