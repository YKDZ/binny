import { createServer } from "node:http";

const photoBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/gQAAAABJRU5ErkJggg==",
  "base64",
);
const audioBytes = Buffer.from(
  "ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000Binny22Audio",
);
const requests: {
  readonly path: string;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
}[] = [];
let rssVersion = 1;
let atomVersion = 1;
let articleVersion = 1;
let documentVersion = 1;
let atomTextMode: "text" | "html" = "text";
let temporaryAvailable = false;
let photoAvailable = true;
let holdFeedPath: string | undefined;
let heldFeedPath: string | undefined;
let releaseFeedResponse: (() => void) | undefined;

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function readJson(
  request: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function state(): unknown {
  return {
    requests,
    articleVersion,
    documentVersion,
    photoBytes: photoBytes.toString("base64"),
    audioBytes: audioBytes.toString("base64"),
    ...(heldFeedPath === undefined ? {} : { heldFeedPath }),
  };
}

function updateState(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const updates = value as Record<string, unknown>;
  if (
    "holdFeedPath" in updates &&
    updates.holdFeedPath !== null &&
    updates.holdFeedPath !== "/rss" &&
    updates.holdFeedPath !== "/atom"
  ) {
    return false;
  }
  if (
    "rssVersion" in updates &&
    (!Number.isSafeInteger(updates.rssVersion) ||
      Number(updates.rssVersion) < 1)
  ) {
    return false;
  }
  if (
    "atomVersion" in updates &&
    (!Number.isSafeInteger(updates.atomVersion) ||
      Number(updates.atomVersion) < 1)
  ) {
    return false;
  }
  if (
    "articleVersion" in updates &&
    (!Number.isSafeInteger(updates.articleVersion) ||
      Number(updates.articleVersion) < 1)
  ) {
    return false;
  }
  if (
    "documentVersion" in updates &&
    (!Number.isSafeInteger(updates.documentVersion) ||
      Number(updates.documentVersion) < 1)
  ) {
    return false;
  }
  if (
    "atomTextMode" in updates &&
    updates.atomTextMode !== "text" &&
    updates.atomTextMode !== "html"
  ) {
    return false;
  }
  if (
    "temporaryAvailable" in updates &&
    typeof updates.temporaryAvailable !== "boolean"
  ) {
    return false;
  }
  if (
    "photoAvailable" in updates &&
    typeof updates.photoAvailable !== "boolean"
  ) {
    return false;
  }
  if (updates.rssVersion !== undefined) rssVersion = Number(updates.rssVersion);
  if (updates.atomVersion !== undefined)
    atomVersion = Number(updates.atomVersion);
  if (updates.articleVersion !== undefined)
    articleVersion = Number(updates.articleVersion);
  if (updates.documentVersion !== undefined)
    documentVersion = Number(updates.documentVersion);
  if (updates.atomTextMode === "text" || updates.atomTextMode === "html") {
    atomTextMode = updates.atomTextMode;
  }
  if (typeof updates.temporaryAvailable === "boolean") {
    temporaryAvailable = updates.temporaryAvailable;
  }
  if (typeof updates.photoAvailable === "boolean") {
    photoAvailable = updates.photoAvailable;
  }
  if ("holdFeedPath" in updates) {
    holdFeedPath =
      typeof updates.holdFeedPath === "string"
        ? updates.holdFeedPath
        : undefined;
  }
  return true;
}

async function waitForFeedRelease(
  pathname: string,
  response: import("node:http").ServerResponse,
): Promise<void> {
  if (holdFeedPath !== pathname) return;
  holdFeedPath = undefined;
  heldFeedPath = pathname;
  await new Promise<void>((resolve) => {
    const closed = (): void => {
      releaseFeedResponse = undefined;
      heldFeedPath = undefined;
      resolve();
    };
    const release = (): void => {
      response.off("close", closed);
      releaseFeedResponse = undefined;
      heldFeedPath = undefined;
      resolve();
    };
    releaseFeedResponse = release;
    response.once("close", closed);
  });
}

function sendFeed(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  validators: { readonly etag?: string; readonly lastModified?: string },
  mediaType: string,
  body: string,
): void {
  const notModified =
    validators.etag !== undefined
      ? request.headers["if-none-match"] === validators.etag
      : validators.lastModified !== undefined &&
        request.headers["if-modified-since"] === validators.lastModified;
  const responseValidators = {
    ...(validators.etag === undefined ? {} : { etag: validators.etag }),
    ...(validators.lastModified === undefined
      ? {}
      : { "last-modified": validators.lastModified }),
  };
  if (notModified) {
    response.writeHead(304, responseValidators);
    response.end();
    return;
  }
  response.writeHead(200, {
    "content-type": mediaType,
    ...responseValidators,
  });
  response.end(body);
}

const articleSourceOrigin = "http://rss-e2e-source:8081";

function articleSourceResponse(
  pathname: string,
): { readonly mediaType: string; readonly body: string } | undefined {
  const version = articleVersion;
  const articleBody = (title: string): string =>
    `<h1>${title}</h1>
      <p>Substantive ${title} article body, version ${String(version)}, from the controlled source.</p>
      <section><h2>Implementation</h2><p>The source response provides a distinct article version.</p></section>`;
  const html = (body: string) => ({
    mediaType: "text/html; charset=utf-8",
    body,
  });
  const rssItem = (options: {
    readonly id: string;
    readonly title: string;
    readonly path: string;
    readonly published: string;
    readonly description?: string;
    readonly category?: string;
  }): string => `<item>
    <guid isPermaLink="false">${options.id}</guid>
    <title>${options.title}</title>
    <link>${articleSourceOrigin}${options.path}</link>
    ${options.description === undefined ? "" : `<description>${options.description}</description>`}
    <pubDate>${options.published}</pubDate>
    ${options.category === undefined ? "" : `<category>${options.category}</category>`}
  </item>`;

  if (pathname === "/openai/news/rss.xml") {
    return {
      mediaType: "application/rss+xml; charset=utf-8",
      body: `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>OpenAI News</title>
          ${rssItem({
            id: "urn:binny:openai:article",
            title: `OpenAI Research Update ${String(version)}`,
            path: "/openai/news/article",
            published: "Wed, 04 Nov 2026 08:00:00 +0800",
            description:
              "A source summary that must not replace article content.",
            category: "Research",
          })}
        </channel></rss>`,
    };
  }
  if (pathname === "/openai/news/article") {
    const title = `OpenAI Research Update ${String(version)}`;
    return html(`<!doctype html><html><head>
      <title>${title} | OpenAI</title>
      <link rel="canonical" href="${articleSourceOrigin}/openai/news/article" />
      <meta property="og:title" content="${title}" />
      <meta property="article:published_time" content="2026-11-03T20:15:00-04:00" />
      <meta property="article:modified_time" content="2026-11-0${version === 1 ? "4" : "5"}T09:30:00-04:00" />
      <meta name="author" content="OpenAI Research Team" />
    </head><body><main><article>${articleBody(title)}</article></main></body></html>`);
  }
  if (pathname === "/openai/blog") {
    const title = `OpenAI Runtime Guide ${String(version)}`;
    return html(`<!doctype html><html><body><main><div class="posts-list">
      <article class="post-card">
        <h2><a href="/blog/runtime-guide">${title}</a></h2>
        <time datetime="2026-11-04T08:00:00+08:00">Nov 4, 2026</time>
        <span class="category">Tooling</span>
        <span class="author">OpenAI Developer Relations</span>
      </article>
    </div></main></body></html>`);
  }
  if (pathname === "/blog/runtime-guide.md") {
    return {
      mediaType: "text/markdown; charset=utf-8",
      body: [
        `# OpenAI Runtime Guide ${String(version)}`,
        "",
        `This Developers Blog article describes runtime integration, version ${String(version)}.`,
        "",
        "```ts",
        "const result = await collectSource();",
        "```",
        "",
      ].join("\n"),
    };
  }
  if (pathname === "/anthropic/news") {
    const title = `Anthropic Safety Release ${String(version)}`;
    return html(`<!doctype html><html><head><title>Anthropic News</title></head><body>
      <main><div class="featured-grid"><article class="tile">
        <a href="/anthropic/news/safety-release" class="title-link"><h3>${title}</h3></a>
        <time datetime="2026-10-10">Oct 10, 2026</time>
        <span class="category">Announcements</span>
      </article></div></main></body></html>`);
  }
  if (pathname === "/anthropic/news/safety-release") {
    const title = `Anthropic Safety Release ${String(version)}`;
    return html(`<!doctype html><html><head>
      <title>${title} \\ Anthropic</title>
      <meta property="og:title" content="${title}" />
      <meta property="article:published_time" content="2026-10-10T09:15:00-04:00" />
      <meta property="article:modified_time" content="2026-10-${version === 1 ? "12" : "13"}T10:45:00-04:00" />
    </head><body><main><article>${articleBody(title)}</article></main></body></html>`);
  }
  if (pathname === "/google/ai/feed.xml") {
    return {
      mediaType: "application/rss+xml; charset=utf-8",
      body: `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Google AI</title>
          ${rssItem({
            id: "urn:binny:google:ai-article",
            title: `Google AI Research ${String(version)}`,
            path: "/google/ai/article",
            published: "Tue, 03 Nov 2026 12:00:00 +0530",
            category: "Research",
          })}
        </channel></rss>`,
    };
  }
  if (pathname === "/google/ai/article") {
    const title = `Google AI Research ${String(version)}`;
    return html(`<!doctype html><html lang="en"><head><title>${title}</title>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: title,
        datePublished: "2026-11-03T12:00:00+05:30",
        dateModified: `2026-11-0${version === 1 ? "4" : "5"}T10:30:00-04:00`,
        author: { "@type": "Person", name: "Google AI Team" },
        articleSection: "Research",
        inLanguage: "en",
      })}</script>
    </head><body><article class="uni-blog-article">${articleBody(title)}</article></body></html>`);
  }
  if (pathname === "/huggingface/blog/feed.xml") {
    return {
      mediaType: "application/rss+xml; charset=utf-8",
      body: `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Hugging Face Blog</title>
          ${rssItem({
            id: "urn:binny:huggingface:article",
            title: `Hugging Face Engineering Note ${String(version)}`,
            path: "/huggingface/blog/engineering-note",
            published: "Mon, 06 May 2024 09:30:00 +0530",
            category: "engineering",
          })}
        </channel></rss>`,
    };
  }
  if (pathname === "/huggingface/blog/engineering-note") {
    const title = `Hugging Face Engineering Note ${String(version)}`;
    return html(`<!doctype html><html><head><title>${title} - Hugging Face</title>
      <meta name="author" content="Research Team" />
      <meta property="article:author" content="https://huggingface.co/research-team" />
      <meta property="article:tag" content="engineering" />
    </head><body><nav><a href="/blog">Blog</a></nav><article>
      <header><h1>${title}</h1>
        <div class="authors"><a href="/authors/research-team">Research Team</a></div>
        <time datetime="2024-05-${version === 1 ? "10" : "11"}T16:00:00+02:00">May ${version === 1 ? "10" : "11"}, 2024</time>
      </header><div class="blog-content">${articleBody(title)}
        <span class="tag">systems</span>
      </div></article></body></html>`);
  }
  if (pathname === "/mistral/news/rss") {
    return {
      mediaType: "text/plain; charset=utf-8",
      body: `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Mistral News</title>
          ${rssItem({
            id: `${articleSourceOrigin}/mistral/news/ai-update`,
            title: `Mistral AI Update ${String(version)}`,
            path: "/mistral/news/ai-update",
            published: "Mon, 02 Nov 2026 10:00:00 +0230",
            description: `Mistral RSS summary version ${String(version)}.`,
            category: "Engineering",
          })}
        </channel></rss>`,
    };
  }
  if (pathname === "/mistral/news/ai-update") {
    const title = `Mistral AI Update ${String(version)}`;
    return html(`<!doctype html><html lang="en"><head><title>${title}</title>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: title,
        dateModified: `2026-11-0${version === 1 ? "3" : "4"}T08:30:00+02:00`,
        author: { "@type": "Person", name: "Mistral Engineering" },
        articleSection: "Engineering",
      })}</script>
    </head><body><main><article>${articleBody(title)}</article></main></body></html>`);
  }
  return undefined;
}

function documentSourceResponse(
  pathname: string,
): { readonly mediaType: string; readonly body: string } | undefined {
  const version = documentVersion;
  const html = (body: string) => ({
    mediaType: "text/html; charset=utf-8",
    body,
  });
  if (pathname === "/deepseek/updates.md") {
    const updateDate = version === 1 ? "2026-11-08" : "2026-11-09";
    return {
      mediaType: "text/markdown; charset=utf-8",
      body: `# DeepSeek API Updates

## ${updateDate}

Cumulative updates document version ${String(version)}.

- See [Research Update](/deepseek/news/news261108).
`,
    };
  }
  if (pathname === "/deepseek/news/news261108.md") {
    const published =
      version === 1 ? "2026-11-08T12:30:00+08:00" : "2026-11-08T13:30:00+08:00";
    return {
      mediaType: "text/markdown; charset=utf-8",
      body: `---
title: DeepSeek Research Update ${String(version)}
date: "${published}"
---

# DeepSeek Research Update ${String(version)}

DeepSeek article body version ${String(version)}.
`,
    };
  }
  if (pathname === "/qwen/api/v2/article/retrieval") {
    const title = `Qwen Research Note ${String(version)}`;
    return {
      mediaType: "application/json; charset=utf-8",
      body: JSON.stringify({
        articles: [
          {
            id: "qwen-research-note-1",
            path: "research-note",
            title,
            language: "en-US",
            content: `<article><link rel="canonical" href="http://rss-e2e-source:8081/qwen/research-note" /><h2>Research note</h2><p>Qwen article body version ${String(version)}.</p></article>`,
            extra: {
              date: "2026-11-08T12:30:00+08:00",
              author: "Qwen Research",
              tags: ["research", "models"],
            },
          },
        ],
      }),
    };
  }
  if (pathname === "/kimi/changelog.md") {
    const updateDate = version === 1 ? "2026-11-08" : "2026-11-09";
    return {
      mediaType: "text/markdown; charset=utf-8",
      body: `# Kimi Platform Changelog

## ${updateDate}

Cumulative changelog body version ${String(version)}.
`,
    };
  }
  if (pathname === "/kimi/blog") {
    const title = `Kimi Research ${String(version)}`;
    return html(`<!doctype html><html><body><main>
      <article class="card"><a href="/kimi/blog/research-update">
        <span class="card-title">${title}</span><span class="card-date">2026-11-08</span>
      </a></article>
    </main></body></html>`);
  }
  if (pathname === "/kimi/blog/research-update") {
    const title = `Kimi Research ${String(version)}`;
    return html(`<!doctype html><html><head>
      <link rel="canonical" href="${articleSourceOrigin}/kimi/blog/research-update" />
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: title,
        datePublished: "2026-11-08T12:30:00+08:00",
        dateModified: `2026-11-0${version === 1 ? "8" : "9"}T09:15:00-04:00`,
      })}</script>
    </head><body><main><article><h1>${title}</h1>
      <p>Kimi research article body version ${String(version)}.</p>
    </article></main></body></html>`);
  }
  if (pathname === "/minimax/models.md") {
    const updateDate = version === 1 ? "2026-11-08" : "2026-11-09";
    const title = `MiniMax Model Update ${String(version)}`;
    return {
      mediaType: "text/markdown; charset=utf-8",
      body: `# MiniMax Model Release Notes

## ${updateDate}

Models release document version ${String(version)}.

- [${title}](/minimax/news/minimax-m4)
`,
    };
  }
  if (pathname === "/minimax/news/minimax-m4") {
    const title = `MiniMax Model Update ${String(version)}`;
    return html(`<!doctype html><html><head>
      <title>${title} | MiniMax</title>
      <meta property="article:published_time" content="2026-11-07T12:30:00+08:00" />
      <meta property="article:modified_time" content="2026-11-0${version === 1 ? "8" : "9"}T09:15:00-04:00" />
    </head><body><article><h1>${title}</h1>
      <time datetime="2026-12-01">Launch event</time>
      <p>MiniMax article body version ${String(version)}.</p>
    </article></body></html>`);
  }
  return undefined;
}

function qoderSourceResponse(
  pathname: string,
): { readonly mediaType: string; readonly body: string } | undefined {
  const version = documentVersion;
  const text = (body: string) => ({
    mediaType: "text/markdown; charset=utf-8",
    body,
  });
  const html = (body: string) => ({
    mediaType: "text/html; charset=utf-8",
    body,
  });

  if (pathname === "/qoder/cn/llms.txt") {
    return text(`# Qoder CN Sources

## 活动
- [Qoder Model Launch 活动](/qoder/cn/events/model-launch.md): 受控活动资料

## 公告
- [Qoder Feature Announcement](/qoder/cn/announcements/feature-rollout.md): 受控公告资料

## 更新日志
- [Qoder CN CLI 更新日志](/qoder/cn/changelogs/cli.md): CN CLI release history
`);
  }
  if (pathname === "/qoder/cn/events/model-launch.md") {
    const effectiveDate =
      version === 1
        ? "2026年11月8日至2026年11月9日"
        : "2026年11月9日至2026年11月10日";
    return text(`# Qoder Model Launch 活动

活动时间：${effectiveDate}

Qoder CN event body version ${String(version)}.
`);
  }
  if (pathname === "/qoder/cn/announcements/feature-rollout.md") {
    return text(`# Qoder Feature Announcement

Qoder CN announcement body version ${String(version)}.
`);
  }
  if (pathname === "/qoder/cn/changelogs/cli.md") {
    const updateDate = version === 1 ? "2026-11-08" : "2026-11-09";
    const updateVersion = version === 1 ? "1.4.0" : "1.4.1";
    return text(`# Qoder CN CLI Changelog

<Update label="${updateDate}" description="${updateVersion}">
  - Qoder CN changelog body version ${String(version)}.
</Update>
`);
  }
  if (pathname === "/qoder/international/llms.txt") {
    return text(`# Qoder International Changelog

## Changelogs
- [Qoder International Release Notes](/qoder/international/changelogs/product.md): International product history
`);
  }
  if (pathname === "/qoder/international/changelogs/product.md") {
    const updateDate = version === 1 ? "2026-11-08" : "2026-11-09";
    const updateVersion = version === 1 ? "2.8.0" : "2.8.1";
    return text(`# Qoder International Release Notes

<Update label="${updateDate}" description="${updateVersion}">
  - Qoder international changelog body version ${String(version)}.
</Update>
`);
  }
  if (pathname === "/blog") {
    const title = `Qoder Blog Release ${String(version)}`;
    return html(`<!doctype html><html><body><main>
      <article class="blog-card">
        <h2><a href="/blog/qoder-source-adapter-e2e">${title}</a></h2>
        <time datetime="2026-11-08T12:30:00+08:00">Nov 8, 2026</time>
        <span class="category">Engineering</span>
        <p class="summary">Qoder blog summary version ${String(version)}.</p>
      </article>
    </main></body></html>`);
  }
  if (pathname === "/blog/qoder-source-adapter-e2e") {
    const title = `Qoder Blog Release ${String(version)}`;
    const modifiedDate = version === 1 ? "2026-11-09" : "2026-11-10";
    return html(`<!doctype html><html><head>
      <link rel="canonical" href="${articleSourceOrigin}/blog/qoder-source-adapter-e2e" />
      <meta property="article:published_time" content="2026-11-08T12:30:00+08:00" />
      <meta property="article:modified_time" content="${modifiedDate}T09:15:00-04:00" />
      <meta name="author" content="Qoder Engineering" />
      <meta property="article:tag" content="Engineering, Release" />
    </head><body><main><article><h1>${title}</h1>
      <p>Qoder international blog article body version ${String(version)}.</p>
    </article></main></body></html>`);
  }
  return undefined;
}

const server = createServer((request, response) => {
  void (async () => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (
      [
        "/rss",
        "/rss-edited",
        "/atom",
        "/temporary",
        "/bad-identity",
        "/missing-body",
        "/summary-full",
      ].includes(pathname)
    ) {
      const ifNoneMatch = request.headers["if-none-match"];
      const ifModifiedSince = request.headers["if-modified-since"];
      requests.push({
        path: pathname,
        ...(typeof ifNoneMatch === "string" ? { ifNoneMatch } : {}),
        ...(typeof ifModifiedSince === "string" ? { ifModifiedSince } : {}),
      });
    }
    if (
      pathname.startsWith("/openai/") ||
      pathname.startsWith("/anthropic/") ||
      pathname.startsWith("/google/") ||
      pathname.startsWith("/huggingface/") ||
      pathname.startsWith("/mistral/") ||
      pathname.startsWith("/deepseek/") ||
      pathname.startsWith("/qwen/") ||
      pathname.startsWith("/kimi/") ||
      pathname.startsWith("/minimax/") ||
      pathname.startsWith("/qoder/") ||
      pathname === "/blog" ||
      pathname === "/blog/qoder-source-adapter-e2e" ||
      pathname === "/blog/runtime-guide.md"
    ) {
      requests.push({ path: pathname });
    }
    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { process: "ready" });
      return;
    }
    if (request.method === "GET" && pathname === "/control/state") {
      sendJson(response, 200, state());
      return;
    }
    if (request.method === "POST" && pathname === "/control/state") {
      let value: unknown;
      try {
        value = await readJson(request);
      } catch {
        sendJson(response, 400, { error: "受控信源状态请求不是有效 JSON。" });
        return;
      }
      if (!updateState(value)) {
        sendJson(response, 400, { error: "受控信源状态请求格式无效。" });
        return;
      }
      sendJson(response, 200, state());
      return;
    }
    if (request.method === "POST" && pathname === "/control/release-feed") {
      releaseFeedResponse?.();
      sendJson(response, 200, state());
      return;
    }

    if (request.method === "GET") {
      const sourceResponse =
        qoderSourceResponse(pathname) ??
        documentSourceResponse(pathname) ??
        articleSourceResponse(pathname);
      if (sourceResponse !== undefined) {
        response.writeHead(200, {
          "content-type": sourceResponse.mediaType,
        });
        response.end(sourceResponse.body);
        return;
      }
    }

    if (
      request.method === "GET" &&
      ["/rss", "/rss-edited"].includes(pathname)
    ) {
      await waitForFeedRelease(pathname, response);
      if (response.destroyed) return;
      const etag = `"rss-${String(rssVersion)}"`;
      sendFeed(
        request,
        response,
        { etag },
        "application/rss+xml; charset=utf-8",
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Binny RSS 受控信源</title><link>http://rss-e2e-source:8081/rss</link><description>RSS 全文受控信源</description><item><guid isPermaLink="false">urn:binny:rss:rss-item</guid><title>RSS 全文测试文章</title><pubDate>Wed, 28 Oct 2026 01:23:45 +0200</pubDate><dc:date>2026-10-29</dc:date><updated>2026-10-30T12:34:56-03:00</updated><link>http://rss-e2e-source:8081/story/rss</link><description>RSS 摘要版本 ${String(rssVersion)}</description><content:encoded><![CDATA[<article><h1>RSS 全文</h1><p>RSS 正文版本 ${String(rssVersion)}</p><p>代码 &lt;widget&gt; 与 A &amp; B</p><img src="/media/photo.png" alt="RSS 封面" /></article>]]></content:encoded><enclosure url="/media/audio.mp3" length="22" type="audio/mpeg" /><author>作者</author><category>工程</category></item><item><guid isPermaLink="false">urn:binny:rss:rss-item-escaped</guid><title>RSS XML 转义 HTML 测试文章</title><content:encoded>&lt;p&gt;代码 &amp;lt;widget&amp;gt; 与 A &amp;amp; B&lt;/p&gt;</content:encoded></item><item><guid isPermaLink="false">urn:binny:rss:rss-summary</guid><title>RSS 仅摘要条目</title><description>只有摘要版本 ${String(rssVersion)}</description></item><item><guid isPermaLink="false">urn:binny:rss:rss-title-only</guid><title>RSS 仅标题資料🌿</title><description>原生短文正文🌿</description></item></channel></rss>`,
      );
      return;
    }

    if (request.method === "GET" && pathname === "/missing-body") {
      sendFeed(
        request,
        response,
        { etag: '"missing-body-1"' },
        "application/rss+xml; charset=utf-8",
        '<rss version="2.0"><channel><title>缺失正文受控信源</title><link>http://rss-e2e-source:8081/missing-body</link><item><guid isPermaLink="false">urn:binny:rss:missing-body</guid><title>RSS 缺失正文条目</title></item></channel></rss>',
      );
      return;
    }

    if (request.method === "GET" && pathname === "/summary-full") {
      sendFeed(
        request,
        response,
        { etag: '"summary-1"' },
        "application/rss+xml; charset=utf-8",
        '<rss version="2.0"><channel><title>受控摘要信源</title><item><guid isPermaLink="false">urn:binny:summary:summary-article</guid><title>RSS 摘要全文文章</title><link>http://rss-e2e-source:8081/story/summary</link><description><![CDATA[<article><h1>摘要全文</h1><p>摘要正文版本 1。这段内容直接位于 description 字段中的 HTML 块级结构中。</p><p>信源适配器将具有 HTML 块级结构的多段摘要视为完整正文归档。</p><img src="/media/photo.png" alt="摘要文章插图" /></article>]]></description></item></channel></rss>',
      );
      return;
    }

    if (request.method === "GET" && pathname === "/atom") {
      await waitForFeedRelease(pathname, response);
      if (response.destroyed) return;
      const lastModified = new Date(
        Date.UTC(2026, 9, 27 + atomVersion),
      ).toUTCString();
      sendFeed(
        request,
        response,
        { lastModified },
        "application/atom+xml; charset=utf-8",
        `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:binny:rss:atom-feed</id><title>Binny Atom 受控信源</title><updated>2026-10-28T00:00:00Z</updated><entry><id>tag:example.test,2026:binny-rss-atom</id><title>Atom 全文测试文章</title><published>2026-10-27</published><updated>2026-10-28T12:34:56-05:00</updated><link href="http://rss-e2e-source:8081/story/atom" /><summary>Atom 摘要版本 ${String(atomVersion)}</summary><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Atom 全文版本 ${String(atomVersion)}；代码 &lt;widget&gt; 与 A &amp; B</p><img src="/media/atom.png" alt="Atom 插图" /></div></content><author><name>作者乙</name></author><category term="测试" /></entry><entry><id>tag:example.test,2026:atom-text-explicit</id><title>Atom 显式纯文本</title><content type="text">代码 &lt;widget&gt; 与 A &amp; B</content></entry><entry><id>tag:example.test,2026:atom-text-default</id><title>Atom 默认纯文本</title><content>代码 &lt;widget&gt; 与 A &amp; B</content></entry><entry><id>tag:example.test,2026:atom-html-literal</id><title>Atom HTML 中的代码文字</title><content type="html">&lt;p&gt;代码 &amp;lt;widget&amp;gt; 与 A &amp;amp; B&lt;/p&gt;</content></entry><entry><id>tag:example.test,2026:atom-text-entities</id><title>Atom 纯文本中的实体字面值</title><content type="text">A &amp;lt;widget&amp;gt; &amp;amp; B</content></entry><entry><id>tag:example.test,2026:atom-text-kind-switch</id><title>Atom 正文类型切换</title><content type="${atomTextMode}">语义固定内容</content></entry></feed>`,
      );
      return;
    }

    if (request.method === "GET" && pathname === "/temporary") {
      if (!temporaryAvailable) {
        response.writeHead(503, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("受控 feed 暂时不可用");
        return;
      }
      sendFeed(
        request,
        response,
        { etag: '"temporary-1"' },
        "application/rss+xml; charset=utf-8",
        `<rss version="2.0"><channel><title>恢复的受控 feed</title><link>http://rss-e2e-source:8081/temporary</link><item><guid isPermaLink="false">urn:binny:rss:temporary-item</guid><title>恢复后正文</title><description>临时失败后取得的正文</description><content:encoded><![CDATA[<p>temporary feed 恢复后正文</p>]]></content:encoded></item></channel></rss>`,
      );
      return;
    }

    if (request.method === "GET" && pathname === "/bad-identity") {
      sendFeed(
        request,
        response,
        { etag: '"bad-identity-1"' },
        "application/rss+xml; charset=utf-8",
        '<rss version="2.0"><channel><title>缺少条目标识</title><link>http://rss-e2e-source:8081/bad-identity</link><item><title>无稳定身份条目</title><description>坏身份正文不得进入归档</description><content:encoded><![CDATA[<p>坏身份正文不得进入归档</p>]]></content:encoded></item></channel></rss>',
      );
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/media/")) {
      const ifNoneMatch = request.headers["if-none-match"];
      const ifModifiedSince = request.headers["if-modified-since"];
      requests.push({
        path: pathname,
        ...(typeof ifNoneMatch === "string" ? { ifNoneMatch } : {}),
        ...(typeof ifModifiedSince === "string" ? { ifModifiedSince } : {}),
      });
      if (pathname === "/media/photo.png" && !photoAvailable) {
        response.writeHead(503, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("受控图片暂时不可用");
        return;
      }
      if (pathname === "/media/photo.png" || pathname === "/media/atom.png") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(photoBytes);
        return;
      }
      if (pathname === "/media/audio.mp3") {
        response.writeHead(200, { "content-type": "audio/mpeg" });
        response.end(audioBytes);
        return;
      }
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("未找到受控信源资源");
  })().catch((error: unknown) => {
    if (!response.headersSent) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "受控信源内部错误。",
      });
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
});

const port = Number(process.env.BINNY_RSS_SOURCE_PORT ?? "8081");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("受控 RSS 信源端口配置无效。");
}
server.listen(port, "0.0.0.0");
