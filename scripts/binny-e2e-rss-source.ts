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
let atomTextMode: "text" | "html" = "text";
let temporaryAvailable = false;
let photoAvailable = true;
let staticArticleVersion = 1;
let staticPhotoAvailable = true;
let recoveryPageAvailable = false;
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
  if (
    "staticArticleVersion" in updates &&
    (!Number.isSafeInteger(updates.staticArticleVersion) ||
      Number(updates.staticArticleVersion) < 1)
  ) {
    return false;
  }
  if (
    "staticPhotoAvailable" in updates &&
    typeof updates.staticPhotoAvailable !== "boolean"
  ) {
    return false;
  }
  if (
    "recoveryPageAvailable" in updates &&
    typeof updates.recoveryPageAvailable !== "boolean"
  ) {
    return false;
  }
  if (updates.rssVersion !== undefined) rssVersion = Number(updates.rssVersion);
  if (updates.atomVersion !== undefined)
    atomVersion = Number(updates.atomVersion);
  if (updates.atomTextMode === "text" || updates.atomTextMode === "html") {
    atomTextMode = updates.atomTextMode;
  }
  if (typeof updates.temporaryAvailable === "boolean") {
    temporaryAvailable = updates.temporaryAvailable;
  }
  if (typeof updates.photoAvailable === "boolean") {
    photoAvailable = updates.photoAvailable;
  }
  if (updates.staticArticleVersion !== undefined) {
    staticArticleVersion = Number(updates.staticArticleVersion);
  }
  if (typeof updates.staticPhotoAvailable === "boolean") {
    staticPhotoAvailable = updates.staticPhotoAvailable;
  }
  if (typeof updates.recoveryPageAvailable === "boolean") {
    recoveryPageAvailable = updates.recoveryPageAvailable;
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
        "/static-rss",
        "/real-static-rss",
        "/summary-full",
      ].includes(pathname) ||
      pathname.startsWith("/story/") ||
      pathname.startsWith("/pages/")
    ) {
      const ifNoneMatch = request.headers["if-none-match"];
      const ifModifiedSince = request.headers["if-modified-since"];
      requests.push({
        path: pathname,
        ...(typeof ifNoneMatch === "string" ? { ifNoneMatch } : {}),
        ...(typeof ifModifiedSince === "string" ? { ifModifiedSince } : {}),
      });
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
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Binny RSS 受控信源</title><link>http://rss-e2e-source:8081/rss</link><description>RSS 全文受控信源</description><item><guid isPermaLink="false">urn:binny:rss:rss-item</guid><title>RSS 全文测试文章</title><link>http://rss-e2e-source:8081/story/rss</link><description>RSS 摘要版本 ${String(rssVersion)}</description><content:encoded><![CDATA[<article><h1>RSS 全文</h1><p>RSS 正文版本 ${String(rssVersion)}</p><p>代码 &lt;widget&gt; 与 A &amp; B</p><img src="/media/photo.png" alt="RSS 封面" /></article>]]></content:encoded><enclosure url="/media/audio.mp3" length="22" type="audio/mpeg" /><author>作者</author><category>工程</category></item><item><guid isPermaLink="false">urn:binny:rss:rss-item-escaped</guid><title>RSS XML 转义 HTML 测试文章</title><content:encoded>&lt;p&gt;代码 &amp;lt;widget&amp;gt; 与 A &amp;amp; B&lt;/p&gt;</content:encoded></item><item><guid isPermaLink="false">urn:binny:rss:rss-summary</guid><title>RSS 仅摘要条目</title><description>只有摘要版本 ${String(rssVersion)}</description></item><item><guid isPermaLink="false">urn:binny:rss:rss-title-only</guid><title>RSS 仅标题資料🌿</title></item></channel></rss>`,
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

    if (request.method === "GET" && pathname === "/static-rss") {
      sendFeed(
        request,
        response,
        { etag: '"static-rss-1"' },
        "application/rss+xml; charset=utf-8",
        '<rss version="2.0"><channel><title>受控静态正文信源</title><item><guid isPermaLink="false">urn:binny:static:static-article</guid><title>RSS 静态补采文章</title><link>http://rss-e2e-source:8081/story/static</link><description>静态页面摘要</description></item><item><guid isPermaLink="false">urn:binny:static:javascript-shell</guid><title>JavaScript 页面文章</title><link>http://rss-e2e-source:8081/story/javascript</link><description>JavaScript 页面摘要</description></item><item><guid isPermaLink="false">urn:binny:static:login-page</guid><title>需要登录的文章</title><link>http://rss-e2e-source:8081/story/login</link><description>登录页面摘要</description></item><item><guid isPermaLink="false">urn:binny:static:recovery-page</guid><title>暂时无法访问的文章</title><link>http://rss-e2e-source:8081/story/recovery</link><description>恢复页面摘要</description></item></channel></rss>',
      );
      return;
    }

    if (request.method === "GET" && pathname === "/real-static-rss") {
      sendFeed(
        request,
        response,
        { etag: '"real-static-rss-1"' },
        "application/rss+xml; charset=utf-8",
        '<rss version="2.0"><channel><title>真实静态站点兼容信源</title><item><guid isPermaLink="false">urn:binny:static:real-static-bbc</guid><title>BBC 真实静态正文兼容验证</title><link>https://www.bbc.co.uk/news/articles/cwj342k62exyo?at_medium=RSS&amp;at_campaign=rss</link><description>由受控 RSS 摘要指向真实 BBC 公开文章页面。</description></item></channel></rss>',
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
        `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:binny:rss:atom-feed</id><title>Binny Atom 受控信源</title><updated>2026-10-28T00:00:00Z</updated><entry><id>tag:example.test,2026:binny-rss-atom</id><title>Atom 全文测试文章</title><link href="http://rss-e2e-source:8081/story/atom" /><summary>Atom 摘要版本 ${String(atomVersion)}</summary><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Atom 全文版本 ${String(atomVersion)}；代码 &lt;widget&gt; 与 A &amp; B</p><img src="/media/atom.png" alt="Atom 插图" /></div></content><author><name>作者乙</name></author><category term="测试" /></entry><entry><id>tag:example.test,2026:atom-text-explicit</id><title>Atom 显式纯文本</title><content type="text">代码 &lt;widget&gt; 与 A &amp; B</content></entry><entry><id>tag:example.test,2026:atom-text-default</id><title>Atom 默认纯文本</title><content>代码 &lt;widget&gt; 与 A &amp; B</content></entry><entry><id>tag:example.test,2026:atom-html-literal</id><title>Atom HTML 中的代码文字</title><content type="html">&lt;p&gt;代码 &amp;lt;widget&amp;gt; 与 A &amp;amp; B&lt;/p&gt;</content></entry><entry><id>tag:example.test,2026:atom-text-entities</id><title>Atom 纯文本中的实体字面值</title><content type="text">A &amp;lt;widget&amp;gt; &amp;amp; B</content></entry><entry><id>tag:example.test,2026:atom-text-kind-switch</id><title>Atom 正文类型切换</title><content type="${atomTextMode}">语义固定内容</content></entry></feed>`,
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

    if (request.method === "GET" && pathname === "/story/static") {
      response.writeHead(302, { location: "/pages/2026/article.html" });
      response.end();
      return;
    }

    if (request.method === "GET" && pathname === "/pages/2026/article.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>受控公开文章</title></head><body><header><nav>导航文字不得归档</nav></header><main><article><h1>受控公开文章</h1><p>公开静态正文版本 ${String(staticArticleVersion)}。这段内容来自 RSS 条目链接所指向的普通公开文章页面，服务端直接返回完整 HTML，无需登录、脚本执行或特殊交互。</p><p>文章正文保留其有价值的段落、层级和图片。归档应使用这段静态页面正文，而不是订阅源中的短摘要。</p><p>页面更新独立于 feed 摘要版本；重新采集时应该再次取得页面，并只在正文或资料确实变化时生成新的归档版本。</p><img src="../../media/static-photo.png" alt="静态文章插图" /></article></main><aside>侧栏广告不得归档<form><label>侧栏账号<input name="side-account" /></label><label>侧栏密码<input type="password" /></label></form></aside></body></html>`,
      );
      return;
    }

    if (request.method === "GET" && pathname === "/story/javascript") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html><head><title>JavaScript 页面</title></head><body><main id="app"><p>正在加载文章，请启用 JavaScript。</p></main><script>document.querySelector("#app").innerHTML="<article><p>需要执行脚本才能取得的正文内容</p></article>";</script></body></html>',
      );
      return;
    }

    if (request.method === "GET" && pathname === "/story/login") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html><head><title>登录</title></head><body><main><h1>需要登录</h1><form><label>账号<input name="account" /></label><label>密码<input type="password" /></label><button>继续</button></form></main></body></html>',
      );
      return;
    }

    if (request.method === "GET" && pathname === "/story/recovery") {
      if (!recoveryPageAvailable) {
        response.writeHead(503, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("受控文章页面暂时不可用");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>恢复后的公开文章</title></head><body><main><article><h1>恢复后的公开文章</h1><p>恢复后静态正文。页面在首次采集时不可访问，后续可由公开 HTTP 页面取得。</p><p>这个文章正文足够长，可以验证正式正文提取只使用公开静态 HTML，而不沿用 feed 摘要或旧版本字段。</p><p>实际采集在页面恢复后应创建新版本，并保留 feed 条目相同的稳定身份。</p></article></main></body></html>",
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
      if (pathname === "/media/static-photo.png") {
        if (!staticPhotoAvailable) {
          response.writeHead(503, {
            "content-type": "text/plain; charset=utf-8",
          });
          response.end("受控静态文章图片暂时不可用");
          return;
        }
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
