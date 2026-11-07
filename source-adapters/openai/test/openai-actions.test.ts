import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  isSourceAdapterActionError,
  type ArchiveCommit,
  type ArchiveResourceMetadata,
  type ArchiveResourceUpload,
  type IncrementalSyncState,
  type SourceAdapterArchiveSubmission,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";

import { sourceAdapter, type OpenAIConfig } from "../src/source-adapter.ts";

export function createSourceAdapterContext(
  config: OpenAIConfig,
  options: {
    persistentState?: {
      load(): Promise<Record<string, unknown> | undefined>;
      save(state: unknown): Promise<void>;
    };
    archiveSubmit?: (
      input: SourceAdapterArchiveSubmission,
    ) => Promise<ArchiveCommit>;
    resourceUpload?: (
      body: BodyInit,
      mediaType: string,
    ) => Promise<ArchiveResourceUpload>;
    signal?: AbortSignal;
    referenceTime?: string;
  } = {},
): SourceAdapterContext<OpenAIConfig> {
  const runId = randomUUID();
  let commitSeq = 0;
  return {
    binId: "openai-test-bin",
    identityId: "openai-test-identity",
    runId,
    referenceTime: options.referenceTime ?? "2026-11-04T00:00:00.000Z",
    sourceAdapterVersion: sourceAdapter.version,
    config,
    signal: options.signal ?? new AbortController().signal,
    persistentState: options.persistentState ?? {
      async load() {
        return undefined;
      },
      async save() {},
    },
    archive: {
      submit:
        options.archiveSubmit ??
        (async (input) => {
          commitSeq += 1;
          return {
            commitId: randomUUID(),
            archiveSeq: String(commitSeq),
            binId: "openai-test-bin",
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
          };
        }),
    },
    resources: {
      async resolve() {
        return { resources: [], items: [], mediaByUrl: {} };
      },
      upload:
        options.resourceUpload ??
        (async (body, mediaType) => {
          const bytes = await new Response(body).arrayBuffer();
          return {
            ok: true,
            resource: {
              resourceId: randomUUID(),
              sha256: "a".repeat(64),
              mediaType,
              size: bytes.byteLength,
            },
          };
        }),
    },
  };
}

await test("OpenAI adapter exports manifest id and configuration defaults", () => {
  assert.equal(sourceAdapter.id, "openai");
  assert.equal(sourceAdapter.environment.browser.required, false);

  const parsed = sourceAdapter.configSchema.parse({});
  assert.equal(parsed.news.enabled, true);
  assert.equal(parsed.news.rssUrl, "https://openai.com/news/rss.xml");
  assert.ok(parsed.news.userAgent.includes("Chrome/156"));
  assert.equal(parsed.developersBlog.enabled, true);
  assert.equal(
    parsed.developersBlog.listUrl,
    "https://developers.openai.com/blog",
  );
  assert.equal(parsed.developersBlog.preferMarkdown, true);
});

await test("OpenAI News RSS discovery, Node fetch with Chrome UA, body extraction, and stripping noise", async () => {
  const recordedHeaders: Record<string, string | string[] | undefined>[] = [];
  const submissions: SourceAdapterArchiveSubmission[] = [];
  const uploadedResources: ArchiveResourceMetadata[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    recordedHeaders.push({ ...req.headers });

    if (url.pathname === "/news/rss.xml") {
      res.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>OpenAI News</title>
    <link>${origin}/news</link>
    <description>Latest news from OpenAI</description>
    <item>
      <guid isPermaLink="false">urn:openai:scaling-git</guid>
      <title>Scaling Git at OpenAI</title>
      <link>${origin}/index/scaling-git-at-openai/</link>
      <description>RSS description summary that MUST NOT be used as article body.</description>
      <pubDate>Wed, 21 Oct 2026 17:00:00 GMT</pubDate>
      <category>Engineering</category>
    </item>
  </channel>
</rss>`);
      return;
    }

    if (url.pathname === "/index/scaling-git-at-openai/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head>
  <title>Scaling Git at OpenAI | OpenAI</title>
  <link rel="canonical" href="${origin}/index/scaling-git-at-openai/" />
  <meta property="og:title" content="Scaling Git at OpenAI" />
  <meta property="article:published_time" content="2026-10-21T17:00:00.000Z" />
  <meta property="article:modified_time" content="2026-10-22T08:30:00.000Z" />
  <meta name="author" content="OpenAI Infra Team" />
</head>
<body>
  <main>
    <article>
      <nav aria-label="Table of contents" data-show-toc="true">
        <ul><li><a href="#intro">Introduction</a></li><li><a href="#arch">Architecture</a></li></ul>
      </nav>
      <div data-toc-content>
        <h1 id="intro">Scaling Git at OpenAI</h1>
        <p>Over the past year, the size and demands on our monorepo have increased at a staggering pace.</p>
        <pre><code class="language-python">def scale_pando():
    repo = "monorepo"
    return repo.scale()
</code></pre>
        <p>Comparison of approaches below:</p>
        <table>
          <thead><tr><th>Approach</th><th>Write Latency</th></tr></thead>
          <tbody><tr><td>Pando</td><td>10ms</td></tr></tbody>
        </table>
        <p><img src="/media/diagram.png" alt="Architecture Diagram" /></p>
      </div>
      <div class="audio-player"><button>Listen to article</button></div>
      <div class="author-bio-card">
        <h3>Author</h3>
        <p>Infra team bio details that should be stripped.</p>
      </div>
      <section class="keep-reading">
        <h2>Keep reading</h2>
        <a href="/index/other-post/">Other post link</a>
      </section>
    </article>
  </main>
</body>
</html>`);
      return;
    }

    if (url.pathname === "/media/diagram.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const config: OpenAIConfig = {
      news: {
        enabled: true,
        rssUrl: `${origin}/news/rss.xml`,
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
      },
      developersBlog: {
        enabled: false,
        listUrl: `${origin}/blog`,
        preferMarkdown: true,
      },
    };

    let storedState: IncrementalSyncState | undefined;
    const context = createSourceAdapterContext(config, {
      persistentState: {
        async load() {
          return storedState;
        },
        async save(state) {
          storedState = state as IncrementalSyncState;
        },
      },
      archiveSubmit: async (input) => {
        submissions.push(input);
        return {
          commitId: randomUUID(),
          archiveSeq: "1",
          binId: "openai-test-bin",
          runId: randomUUID(),
          sourceAdapterVersion: sourceAdapter.version,
          observedAt: "2026-11-04T00:00:00.000Z",
          recordedAt: "2026-11-04T00:00:00.000Z",
          items: input.items.map((item) => ({
            itemId: randomUUID(),
            revisionId: randomUUID(),
            sourceKey: item.sourceKey,
          })),
          relations: [],
        };
      },
      resourceUpload: async (body, mediaType) => {
        const bytes = await new Response(body).arrayBuffer();
        const meta = {
          resourceId: randomUUID(),
          sha256: "b".repeat(64),
          mediaType,
          size: bytes.byteLength,
        };
        uploadedResources.push(meta);
        return { ok: true, resource: meta };
      },
    });

    const collectAction = sourceAdapter.actions.collect;
    assert.ok(collectAction);

    const result = await collectAction.execute(context, { scopes: ["news"] });
    assert.deepEqual(result.completedScopes, ["news"]);

    // 1. Verify headers sent
    const articleReqHeaders = recordedHeaders.find(
      (h) =>
        h["accept"]?.includes("text/html") &&
        h["user-agent"]?.includes("Chrome/156"),
    );
    assert.ok(
      articleReqHeaders,
      "Chrome UA and Accept: text/html headers must be sent",
    );
    assert.ok(String(articleReqHeaders?.["accept-language"]).includes("en-US"));

    // 2. Verify submission
    assert.equal(submissions.length, 1);
    const item = submissions[0]!.items[0]!;

    assert.deepEqual(item.sourceKey, {
      namespace: "openai:news",
      key: "/index/scaling-git-at-openai/",
    });
    assert.equal(item.sourceRef, `${origin}/index/scaling-git-at-openai/`);
    assert.equal(item.sourceModifiedAt, "2026-10-22T08:30:00.000Z");

    const metadata = item.metadata as Record<string, unknown>;
    assert.equal(metadata.region, "international");
    assert.equal(metadata.language, "en");
    assert.equal(metadata.section, "news");
    assert.deepEqual(metadata.categories, ["Engineering"]);
    assert.equal(metadata.feedPublishedAt, "2026-10-21T17:00:00.000Z");
    assert.equal(metadata.publishedAt, "2026-10-21T17:00:00.000Z");
    assert.equal(metadata.updatedAt, "2026-10-22T08:30:00.000Z");
    assert.deepEqual(metadata.authors, ["OpenAI Infra Team"]);

    // 3. Verify body content, indentation, table, media, and absence of body.html
    const markdown = item.body?.markdown ?? "";
    assert.ok(
      markdown.includes(
        "Over the past year, the size and demands on our monorepo",
      ),
    );
    // Code block indentation preserved
    assert.ok(
      markdown.includes(
        'def scale_pando():\n    repo = "monorepo"\n    return repo.scale()',
      ),
    );
    // Table preserved
    assert.ok(markdown.includes("| Approach | Write Latency |"));
    assert.ok(markdown.includes("| Pando | 10ms |"));
    // Media reference rendered
    assert.ok(markdown.includes("binny://resource/"));
    assert.equal(uploadedResources.length, 1);
    assert.equal(item.resources?.length, 1);

    // Verify stripped noise elements
    assert.ok(!markdown.includes("Table of contents"));
    assert.ok(!markdown.includes("Architecture</a>"));
    assert.ok(!markdown.includes("Listen to article"));
    assert.ok(!markdown.includes("Infra team bio details"));
    assert.ok(!markdown.includes("Keep reading"));
    assert.ok(!markdown.includes("Other post link"));
    assert.ok(
      !markdown.includes("RSS description summary that MUST NOT be used"),
    );

    // Verify NO body.html
    assert.equal((item.body as Record<string, unknown>)["html"], undefined);
  } finally {
    server.close();
  }
});

await test("OpenAI News rejects 403, Cloudflare challenge, redirect to index, and missing body without RSS fallback", async () => {
  const submissions: SourceAdapterArchiveSubmission[] = [];
  let scenario:
    | "403"
    | "cf-challenge"
    | "challenge-title"
    | "challenge-script"
    | "redirect-index"
    | "missing-body" = "403";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/news/rss.xml") {
      res.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OpenAI News</title>
    <link>${origin}/news</link>
    <item>
      <guid>urn:openai:sample</guid>
      <title>Sample Article</title>
      <link>${origin}/index/sample-article/</link>
      <description>Fallback summary that MUST NEVER be archived</description>
    </item>
  </channel>
</rss>`);
      return;
    }

    if (url.pathname === "/index/sample-article/") {
      if (scenario === "403") {
        res.writeHead(403, {
          "content-type": "text/html; charset=utf-8",
          server: "cloudflare",
          "cf-mitigated": "challenge",
        });
        res.end("<html><body>Cloudflare 403 Forbidden</body></html>");
        return;
      }
      if (scenario === "cf-challenge") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cf-mitigated": "challenge",
        });
        res.end("<html><body>Challenge required</body></html>");
        return;
      }
      if (scenario === "challenge-title") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<html><head><title>Just a moment...</title></head><body>Verifying browser</body></html>",
        );
        return;
      }
      if (scenario === "challenge-script") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          '<html><head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body>Challenge script</body></html>',
        );
        return;
      }
      if (scenario === "redirect-index") {
        res.writeHead(302, { location: `${origin}/news` });
        res.end();
        return;
      }
      if (scenario === "missing-body") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<html><body><div>Layout without main or article container</div></body></html>",
        );
        return;
      }
    }

    if (url.pathname === "/news") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>News index listing</body></html>");
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const config: OpenAIConfig = {
      news: {
        enabled: true,
        rssUrl: `${origin}/news/rss.xml`,
        userAgent: "Mozilla/5.0 Chrome/156.0.0.0",
      },
      developersBlog: {
        enabled: false,
        listUrl: `${origin}/blog`,
        preferMarkdown: true,
      },
    };

    const context = createSourceAdapterContext(config, {
      archiveSubmit: async (input) => {
        submissions.push(input);
        return {
          commitId: randomUUID(),
          archiveSeq: "1",
          binId: "openai-test-bin",
          runId: randomUUID(),
          sourceAdapterVersion: sourceAdapter.version,
          observedAt: "2026-11-04T00:00:00.000Z",
          recordedAt: "2026-11-04T00:00:00.000Z",
          items: [],
          relations: [],
        };
      },
    });

    const checkAction = sourceAdapter.actions.check;
    const collectAction = sourceAdapter.actions.collect;

    // 1. Scenario: HTTP 403
    scenario = "403";
    const check403 = await checkAction.execute(context, { scopes: ["news"] });
    assert.equal(check403.availability, "unavailable");
    assert.ok(
      check403.problems.some(
        (p) => p.code === "openai_news_challenge_or_forbidden",
      ),
    );

    await assert.rejects(
      async () => {
        await collectAction.execute(context, { scopes: ["news"] });
      },
      (error: unknown) => {
        assert.ok(isSourceAdapterActionError(error));
        assert.equal(error.failure.code, "openai_collection_incomplete");
        return true;
      },
    );
    assert.equal(
      submissions.length,
      0,
      "No summary fallback should be submitted on 403",
    );

    // 2. Scenario: cf-mitigated: challenge header
    scenario = "cf-challenge";
    const checkCf = await checkAction.execute(context, { scopes: ["news"] });
    assert.equal(checkCf.availability, "unavailable");
    assert.ok(
      checkCf.problems.some(
        (p) => p.code === "openai_news_challenge_or_forbidden",
      ),
    );

    // 3. Scenario: Just a moment... title
    scenario = "challenge-title";
    const checkTitle = await checkAction.execute(context, { scopes: ["news"] });
    assert.equal(checkTitle.availability, "unavailable");
    assert.ok(
      checkTitle.problems.some(
        (p) => p.code === "openai_news_challenge_or_forbidden",
      ),
    );

    // 4. Scenario: Cloudflare challenge script
    scenario = "challenge-script";
    const checkScript = await checkAction.execute(context, {
      scopes: ["news"],
    });
    assert.equal(checkScript.availability, "unavailable");
    assert.ok(
      checkScript.problems.some(
        (p) => p.code === "openai_news_challenge_or_forbidden",
      ),
    );

    // 5. Scenario: Redirect to /news index
    scenario = "redirect-index";
    const checkRedirect = await checkAction.execute(context, {
      scopes: ["news"],
    });
    assert.equal(checkRedirect.availability, "unavailable");
    assert.ok(
      checkRedirect.problems.some(
        (p) =>
          p.code === "openai_news_body_unavailable" ||
          p.code === "openai_news_challenge_or_forbidden",
      ),
    );

    // 6. Scenario: Missing body
    scenario = "missing-body";
    const checkMissing = await checkAction.execute(context, {
      scopes: ["news"],
    });
    assert.equal(checkMissing.availability, "unavailable");
    assert.ok(
      checkMissing.problems.some(
        (p) => p.code === "openai_news_body_unavailable",
      ),
    );

    // Ensure across all failure scenarios, not a single fallback was archived
    assert.equal(submissions.length, 0);
  } finally {
    server.close();
  }
});

await test("OpenAI Developers Blog list discovery, .md and HTML extraction, day-precision date preservation", async () => {
  const submissions: SourceAdapterArchiveSubmission[] = [];
  const uploadedResources: ArchiveResourceMetadata[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/blog") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<body>
  <main>
    <h1>Developers Blog</h1>
    <div class="posts-list">
      <article class="post-card">
        <h2><a href="/blog/designing-failover">Designing Failover Across OpenAI Model Providers</a></h2>
        <time datetime="2026-10-14">Oct 14, 2026</time>
        <span class="category">Reliability</span>
        <span class="author">Alex Dev</span>
      </article>
      <article class="post-card">
        <h2><a href="/blog/maintaining-software">Maintaining Software With The GPT-6 Family</a></h2>
        <time>2026-10-14</time>
        <span class="category">Tooling</span>
        <span class="author">Taylor Eng</span>
      </article>
    </div>
  </main>
</body>
</html>`);
      return;
    }

    // Markdown companion for designing-failover
    if (url.pathname === "/blog/designing-failover.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(`# Designing Failover Across OpenAI Model Providers

Failover patterns are essential when operating mission-critical AI workloads.

\`\`\`python
def execute_with_failover(prompt):
    models = ["gpt-6.1", "gpt-6"]
    for model in models:
        try:
            return call_model(model, prompt)
        except Exception:
            continue
\`\`\`

![Failover Architecture](/media/failover.png)
`);
      return;
    }

    // maintaining-software.md returns 404 to exercise HTML fallback
    if (url.pathname === "/blog/maintaining-software.md") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // HTML fallback for maintaining-software
    if (url.pathname === "/blog/maintaining-software") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head>
  <title>Maintaining Software With The GPT-6 Family</title>
  <meta property="og:title" content="Maintaining Software With The GPT-6 Family" />
</head>
<body>
  <header role="banner">Site Header Nav</header>
  <aside role="complementary" class="sidebar">Sidebar contents</aside>
  <main>
    <article>
      <h1>Maintaining Software With The GPT-6 Family</h1>
      <p>Continuous software maintenance requires intelligent code comprehension.</p>
      <pre><code>pnpm run test --watch</code></pre>
      <div class="related-posts">Related posts block to strip</div>
    </article>
  </main>
  <footer role="contentinfo">Footer copyright</footer>
</body>
</html>`);
      return;
    }

    if (url.pathname === "/media/failover.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const config: OpenAIConfig = {
      news: {
        enabled: false,
        rssUrl: `${origin}/news/rss.xml`,
        userAgent: "Mozilla/5.0 Chrome/156.0.0.0",
      },
      developersBlog: {
        enabled: true,
        listUrl: `${origin}/blog`,
        preferMarkdown: true,
      },
    };

    let storedState: IncrementalSyncState | undefined;
    const context = createSourceAdapterContext(config, {
      persistentState: {
        async load() {
          return storedState;
        },
        async save(state) {
          storedState = state as IncrementalSyncState;
        },
      },
      archiveSubmit: async (input) => {
        submissions.push(input);
        return {
          commitId: randomUUID(),
          archiveSeq: String(submissions.length),
          binId: "openai-test-bin",
          runId: randomUUID(),
          sourceAdapterVersion: sourceAdapter.version,
          observedAt: "2026-11-04T00:00:00.000Z",
          recordedAt: "2026-11-04T00:00:00.000Z",
          items: input.items.map((item) => ({
            itemId: randomUUID(),
            revisionId: randomUUID(),
            sourceKey: item.sourceKey,
          })),
          relations: [],
        };
      },
      resourceUpload: async (body, mediaType) => {
        const bytes = await new Response(body).arrayBuffer();
        const meta = {
          resourceId: randomUUID(),
          sha256: "c".repeat(64),
          mediaType,
          size: bytes.byteLength,
        };
        uploadedResources.push(meta);
        return { ok: true, resource: meta };
      },
    });

    const collectAction = sourceAdapter.actions.collect;
    const result = await collectAction.execute(context, {
      scopes: ["developers-blog"],
    });
    assert.deepEqual(result.completedScopes, ["developers-blog"]);

    assert.equal(submissions.length, 2);

    // 1. Post 1 (fetched via .md)
    const post1 = submissions[0]!.items[0]!;
    assert.deepEqual(post1.sourceKey, {
      namespace: "openai:developers-blog",
      key: "designing-failover",
    });
    assert.equal(post1.sourceRef, `${origin}/blog/designing-failover`);
    // Crucial: sourceModifiedAt must NOT be fabricated when day-precision date is present
    assert.equal(
      post1.sourceModifiedAt,
      undefined,
      "sourceModifiedAt must not be fabricated for day-precision dates",
    );
    const post1Meta = post1.metadata as Record<string, unknown>;
    assert.equal(post1Meta.publishedDate, "2026-10-14");
    assert.equal(post1Meta.datePrecision, "day");
    assert.equal(post1Meta.section, "developers-blog");
    assert.deepEqual(post1Meta.categories, ["Reliability"]);
    assert.deepEqual(post1Meta.authors, ["Alex Dev"]);

    const post1Markdown = post1.body?.markdown ?? "";
    assert.ok(post1Markdown.includes("Failover patterns are essential"));
    assert.ok(post1Markdown.includes("def execute_with_failover(prompt):"));
    assert.ok(post1Markdown.includes("binny://resource/"));
    assert.equal((post1.body as Record<string, unknown>)["html"], undefined);

    // 2. Post 2 (fetched via HTML fallback)
    const post2 = submissions[1]!.items[0]!;
    assert.deepEqual(post2.sourceKey, {
      namespace: "openai:developers-blog",
      key: "maintaining-software",
    });
    assert.equal(post2.sourceRef, `${origin}/blog/maintaining-software`);
    assert.equal(
      post2.sourceModifiedAt,
      undefined,
      "sourceModifiedAt must not be fabricated for day-precision dates",
    );
    const post2Meta = post2.metadata as Record<string, unknown>;
    assert.equal(post2Meta.publishedDate, "2026-10-14");
    assert.equal(post2Meta.datePrecision, "day");
    assert.deepEqual(post2Meta.categories, ["Tooling"]);
    assert.deepEqual(post2Meta.authors, ["Taylor Eng"]);

    const post2Markdown = post2.body?.markdown ?? "";
    assert.ok(
      post2Markdown.includes(
        "Continuous software maintenance requires intelligent",
      ),
    );
    assert.ok(post2Markdown.includes("pnpm run test --watch"));
    // Verify stripped noise elements
    assert.ok(!post2Markdown.includes("Site Header Nav"));
    assert.ok(!post2Markdown.includes("Sidebar contents"));
    assert.ok(!post2Markdown.includes("Related posts block to strip"));
    assert.ok(!post2Markdown.includes("Footer copyright"));
    assert.equal((post2.body as Record<string, unknown>)["html"], undefined);
  } finally {
    server.close();
  }
});

await test("OpenAI sync establishes initial baseline with zero detail requests, skips unchanged, and archives new", async () => {
  const requestedUrls: string[] = [];
  const submissions: SourceAdapterArchiveSubmission[] = [];

  let newsItemsXml = `<item>
    <guid>urn:openai:item-base</guid>
    <title>Baseline News Article</title>
    <link>TARGET_ORIGIN/index/baseline-news/</link>
    <pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate>
  </item>`;

  let blogPostsHtml = `<article class="card">
    <h2><a href="/blog/baseline-post">Baseline Dev Post</a></h2>
    <time>2026-10-12</time>
  </article>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requestedUrls.push(url.pathname);

    if (url.pathname === "/news/rss.xml") {
      res.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>News</title>${newsItemsXml.replaceAll("TARGET_ORIGIN", origin)}</channel></rss>`);
      return;
    }

    if (url.pathname === "/blog") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>${blogPostsHtml}</body></html>`);
      return;
    }

    if (url.pathname === "/index/baseline-news/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body><main><article><div data-toc-content><h1>Baseline News</h1><p>Body 1</p></div></article></main></body></html>`,
      );
      return;
    }

    if (url.pathname === "/index/new-news/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body><main><article><div data-toc-content><h1>Newly Added News</h1><p>Newly added news body</p></div></article></main></body></html>`,
      );
      return;
    }

    if (url.pathname === "/blog/baseline-post.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# Baseline Post\n\nContent");
      return;
    }

    if (url.pathname === "/blog/new-post.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# Newly Added Post\n\nNewly added post content");
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const config: OpenAIConfig = {
      news: {
        enabled: true,
        rssUrl: `${origin}/news/rss.xml`,
        userAgent: "Mozilla/5.0 Chrome/156.0.0.0",
      },
      developersBlog: {
        enabled: true,
        listUrl: `${origin}/blog`,
        preferMarkdown: true,
      },
    };

    let storedState: IncrementalSyncState | undefined;
    const context = createSourceAdapterContext(config, {
      persistentState: {
        async load() {
          return storedState;
        },
        async save(state) {
          storedState = state as IncrementalSyncState;
        },
      },
      archiveSubmit: async (input) => {
        submissions.push(input);
        return {
          commitId: randomUUID(),
          archiveSeq: String(submissions.length),
          binId: "openai-test-bin",
          runId: randomUUID(),
          sourceAdapterVersion: sourceAdapter.version,
          observedAt: "2026-11-04T00:00:00.000Z",
          recordedAt: "2026-11-04T00:00:00.000Z",
          items: input.items.map((item) => ({
            itemId: randomUUID(),
            revisionId: randomUUID(),
            sourceKey: item.sourceKey,
          })),
          relations: [],
        };
      },
    });

    const syncAction = sourceAdapter.actions.sync;
    assert.ok(syncAction);

    // 1. Initial sync on uninitialized state
    requestedUrls.length = 0;
    submissions.length = 0;

    const initialResult = await syncAction.execute(context, {});
    assert.deepEqual(initialResult.completedScopes, [
      "news",
      "developers-blog",
    ]);
    assert.deepEqual(initialResult.initializedScopes, [
      "news",
      "developers-blog",
    ]);

    // NO articles should be archived on baseline sync
    assert.equal(submissions.length, 0);

    // NO detail requests should have been made on baseline sync!
    assert.ok(
      !requestedUrls.includes("/index/baseline-news/"),
      "Baseline sync must not fetch historical news article pages",
    );
    assert.ok(
      !requestedUrls.includes("/blog/baseline-post.md") &&
        !requestedUrls.includes("/blog/baseline-post"),
      "Baseline sync must not fetch historical developers blog post pages",
    );

    // Verify baseline state entries recorded
    assert.ok(storedState);
    assert.equal(
      storedState.scopes["news"]?.entries["/index/baseline-news/"]
        ?.archivedCompleteness,
      "baseline",
    );
    assert.equal(
      storedState.scopes["developers-blog"]?.entries["baseline-post"]
        ?.archivedCompleteness,
      "baseline",
    );

    // 2. Subsequent sync with no changes
    requestedUrls.length = 0;
    submissions.length = 0;

    const unchangedResult = await syncAction.execute(context, {});
    assert.deepEqual(unchangedResult.completedScopes, [
      "news",
      "developers-blog",
    ]);
    assert.equal(unchangedResult.initializedScopes, undefined);

    // Zero detail requests and zero submissions when unchanged
    assert.equal(submissions.length, 0);
    assert.ok(!requestedUrls.includes("/index/baseline-news/"));
    assert.ok(!requestedUrls.includes("/blog/baseline-post.md"));

    // 3. Subsequent sync with newly added articles
    requestedUrls.length = 0;
    submissions.length = 0;

    newsItemsXml += `
  <item>
    <guid>urn:openai:item-new</guid>
    <title>Newly Added News Article</title>
    <link>TARGET_ORIGIN/index/new-news/</link>
    <pubDate>Thu, 15 Oct 2026 14:00:00 GMT</pubDate>
  </item>`;

    blogPostsHtml += `
  <article class="card">
    <h2><a href="/blog/new-post">Newly Added Dev Post</a></h2>
    <time>2026-10-15</time>
  </article>`;

    const updateResult = await syncAction.execute(context, {});
    assert.deepEqual(updateResult.completedScopes, ["news", "developers-blog"]);

    // Only the two newly added items should be archived
    assert.equal(submissions.length, 2);

    const archivedKeys = submissions.map((s) => s.items[0]?.sourceKey.key);
    assert.ok(archivedKeys.includes("/index/new-news/"));
    assert.ok(archivedKeys.includes("new-post"));

    // Verify that baseline items were NOT fetched during this sync
    assert.ok(!requestedUrls.includes("/index/baseline-news/"));
    assert.ok(!requestedUrls.includes("/blog/baseline-post.md"));

    // Verify state updated for newly added items
    assert.equal(
      storedState.scopes["news"]?.entries["/index/new-news/"]
        ?.archivedCompleteness,
      "complete",
    );
    assert.equal(
      storedState.scopes["developers-blog"]?.entries["new-post"]
        ?.archivedCompleteness,
      "complete",
    );
  } finally {
    server.close();
  }
});
