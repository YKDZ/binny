import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isSourceAdapterActionError } from "@binny/source-adapter-sdk";
import type {
  ArchiveCommit,
  ArchiveResourceMetadata,
  SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import sourceAdapter from "../src/index.ts";

type RssConfig = z.output<typeof sourceAdapter.configSchema>;

void test("RSS/Atom 正文、静态补采和部分成果由正式动作提交", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "binny-rss-test-"));
  const previousStateDirectory =
    process.env.BINNY_SOURCE_ADAPTER_STATE_DIRECTORY;
  process.env.BINNY_SOURCE_ADAPTER_STATE_DIRECTORY = stateDirectory;

  let rssVersion = 1;
  const mediaRequests: string[] = [];
  const submissions: Parameters<
    SourceAdapterContext["archive"]["submit"]
  >[0][] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/rss") {
      const etag = `"rss-${rssVersion}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        etag,
      });
      response.end(
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>RSS 来源</title><link>${origin}/</link><item><guid>urn:binny:rss:item-1</guid><title>RSS 文章</title><link>${origin}/story/1</link><description>文章摘要</description><content:encoded><![CDATA[<p>RSS 全文版本 ${rssVersion}</p><img src="/media/photo.png" alt="文章图片" />]]></content:encoded><enclosure url="/media/audio.mp3" length="4" type="audio/mpeg" /><category>工程</category><author>作者甲</author></item></channel></rss>`,
      );
      return;
    }
    if (path === "/atom") {
      response.writeHead(200, {
        "content-type": "application/atom+xml; charset=utf-8",
        etag: '"atom-1"',
      });
      response.end(
        `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:binny:atom:feed</id><title>Atom 来源</title><updated>2026-10-28T00:00:00Z</updated><entry><id>tag:example.test,2026:atom-item-1</id><title>Atom 文章</title><link href="${origin}/story/atom-1" /><summary>Atom 摘要</summary><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Atom 完整正文</p><img src="/media/atom.png" alt="Atom 图片" /></div></content><author><name>作者乙</name></author><category term="资料" /></entry></feed>`,
      );
      return;
    }
    if (path === "/static-rss") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0"><channel><title>静态文章来源</title><item><guid>urn:binny:static:item-1</guid><title>静态文章</title><link>${origin}/pages/static.html</link><description>静态文章摘要</description></item></channel></rss>`,
      );
      return;
    }
    if (path === "/pages/static.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html><head><title>公开静态文章</title></head><body><main><article><h1>公开静态文章</h1><p>静态正文版本 1。这段内容来自订阅条目所指向的普通公开页面，服务器直接返回完整 HTML，无需登录、脚本执行或特殊交互。</p><p>文章正文保留有价值的段落和层级。归档应使用这段正文，而不是订阅源中的短摘要。</p><p>页面正文长度足以判断完整文章，侧栏登录框不应覆盖已经公开取得的内容。</p></article></main><aside><form><label>密码<input type="password"></label></form></aside></body></html>',
      );
      return;
    }
    if (path === "/login-rss") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0"><channel><title>登录页面来源</title><item><guid>urn:binny:login:item-1</guid><title>登录页面</title><link>${origin}/pages/login.html</link><description>登录页面摘要</description></item></channel></rss>`,
      );
      return;
    }
    if (path === "/pages/login.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html><body><main><h1>需要登录</h1><form><label>账号<input name="account"></label><label>密码<input type="password"></label><button>继续</button></form></main></body></html>',
      );
      return;
    }
    if (path.startsWith("/media/")) {
      mediaRequests.push(path);
      response.writeHead(200, {
        "content-type": path.endsWith(".mp3") ? "audio/mpeg" : "image/png",
      });
      response.end(Buffer.from([1, 2, 3, 4]));
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
  const resources: ArchiveResourceMetadata[] = [];
  let commitSequence = 0;
  const runId = randomUUID();
  const context: SourceAdapterContext<RssConfig> = {
    binId: "rss-test-bin",
    identityId: "rss-test-identity",
    runId,
    sourceAdapterVersion: sourceAdapter.version,
    config: {
      feeds: [
        { id: "rss-main", url: `${origin}/rss`, title: "RSS 来源" },
        { id: "atom-main", url: `${origin}/atom`, title: "Atom 来源" },
        { id: "static-main", url: `${origin}/static-rss` },
        { id: "login-main", url: `${origin}/login-rss` },
      ],
    },
    signal: new AbortController().signal,
    archive: {
      async submit(input) {
        submissions.push(input);
        commitSequence += 1;
        return {
          commitId: randomUUID(),
          archiveSeq: String(commitSequence),
          binId: "rss-test-bin",
          runId,
          sourceAdapterVersion: sourceAdapter.version,
          observedAt: "2026-10-28T00:00:00.000Z",
          recordedAt: "2026-10-28T00:00:00.000Z",
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
      async upload(body, mediaType) {
        const bytes = await new Response(body).arrayBuffer();
        const resource = {
          resourceId: randomUUID(),
          sha256: "0".repeat(64),
          mediaType,
          size: bytes.byteLength,
        } satisfies ArchiveResourceMetadata;
        resources.push(resource);
        return { ok: true, resource } as const;
      },
    },
  };

  try {
    const collect = sourceAdapter.actions.collect;
    assert.ok(collect !== undefined);
    const first = await collect.execute(context, {
      feedIds: ["rss-main", "atom-main"],
    });
    assert.deepEqual(first, {
      completedScopes: ["feed:rss-main", "feed:atom-main"],
    });
    assert.equal(submissions.length, 2);
    assert.deepEqual(mediaRequests.sort(), [
      "/media/atom.png",
      "/media/audio.mp3",
      "/media/photo.png",
    ]);

    const rssItem = submissions[0]?.items[0];
    assert.ok(rssItem);
    assert.deepEqual(rssItem.sourceKey, {
      namespace: "rss:rss-main",
      key: "id:urn:binny:rss:item-1",
    });
    assert.equal(rssItem.body?.html?.includes("RSS 全文版本 1"), true);
    assert.equal(rssItem.body?.html?.includes("文章摘要"), false);
    assert.equal(rssItem.capture.completeness, "complete");
    assert.equal(rssItem.body?.markdown?.includes("binny://resource/"), true);
    assert.equal(rssItem.resources?.length, 2);
    const rssMetadata = rssItem.metadata?.item;
    assert.ok(typeof rssMetadata === "object" && rssMetadata !== null);
    assert.equal("authors" in rssMetadata, true);
    assert.equal("categories" in rssMetadata, true);

    const atomItem = submissions[1]?.items[0];
    assert.ok(atomItem);
    assert.equal(atomItem.sourceKey.namespace, "rss:atom-main");
    assert.equal(
      atomItem.sourceKey.key,
      "id:tag:example.test,2026:atom-item-1",
    );
    assert.equal(atomItem.body?.html?.includes("Atom 完整正文"), true);
    assert.equal(atomItem.capture.completeness, "complete");

    rssVersion = 2;
    const second = await collect.execute(context, {
      feedIds: ["rss-main"],
    });
    assert.deepEqual(second, { completedScopes: ["feed:rss-main"] });
    assert.equal(submissions.length, 3);
    assert.deepEqual(submissions[2]?.items[0]?.sourceKey, rssItem.sourceKey);
    assert.equal(
      submissions[2]?.items[0]?.body?.html?.includes("RSS 全文版本 2"),
      true,
    );

    const staticResult = await collect.execute(context, {
      feedIds: ["static-main"],
    });
    assert.deepEqual(staticResult, {
      completedScopes: ["feed:static-main"],
    });
    const staticItem = submissions[3]?.items[0];
    assert.ok(staticItem);
    assert.equal(staticItem.capture.completeness, "complete");
    assert.match(staticItem.body?.html ?? "", /静态正文版本 1/u);

    let loginError: unknown;
    try {
      await collect.execute(context, { feedIds: ["login-main"] });
    } catch (error) {
      loginError = error;
    }
    assert.ok(isSourceAdapterActionError(loginError));
    assert.equal(loginError.failure.code, "rss_collection_incomplete");
    assert.match(loginError.failure.message, /需要登录/u);
    const loginItem = submissions[4]?.items[0];
    assert.ok(loginItem);
    assert.equal(loginItem.capture.completeness, "partial");
    assert.ok(
      loginItem.capture.missing.some(({ path }) => path === "body.fullText"),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    await rm(stateDirectory, { recursive: true, force: true });
    if (previousStateDirectory === undefined) {
      delete process.env.BINNY_SOURCE_ADAPTER_STATE_DIRECTORY;
    } else {
      process.env.BINNY_SOURCE_ADAPTER_STATE_DIRECTORY = previousStateDirectory;
    }
  }
});
