import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { isSourceAdapterActionError } from "@binny/source-adapter-sdk";
import type {
  ArchiveCommit,
  ArchiveResourceMetadata,
  IncrementalSyncState,
  SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import sourceAdapter from "../src/index.ts";

type RssConfig = z.output<typeof sourceAdapter.configSchema>;

void test("RSS/Atom clean content, full-text selection, attachments, and incremental collection", async () => {
  let storedPersistentState: IncrementalSyncState | undefined;
  const persistentState = {
    async load() {
      return storedPersistentState;
    },
    async save(state: unknown) {
      storedPersistentState = state as IncrementalSyncState;
    },
  };

  let rssVersion = 1;
  let syncFeedVersion = 1;
  let syncMediaFeedVersion = 1;
  let failOnceAvailable = false;
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
    if (path === "/summary-full") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0"><channel><title>摘要全文来源</title><item><guid>urn:binny:summary:item-1</guid><title>摘要全文文章</title><link>${origin}/story/summary-1</link><description><![CDATA[<p>这是在 description 中的完整正文第一段。</p><p>第二段正文。</p>]]></description></item></channel></rss>`,
      );
      return;
    }
    if (path === "/summary-forced") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0"><channel><title>强制摘要来源</title><item><guid>urn:binny:forced:item-1</guid><title>强制摘要文章</title><link>${origin}/story/forced-1</link><description>配置强制摘要</description></item></channel></rss>`,
      );
      return;
    }
    if (path === "/genuine-attachments") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>附件来源</title><item><guid>urn:binny:attach:item-1</guid><title>带附件文章</title><link>${origin}/story/attach-1</link><content:encoded><![CDATA[<p>附带报告与数据</p><a download href="/files/report.html">HTML报告</a><a class="attachment" href="/files/data.json">数据</a>]]></content:encoded></item></channel></rss>`,
      );
      return;
    }
    if (path === "/error-media-feed") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>错误媒体来源</title><item><guid>urn:binny:err-media:item-1</guid><title>错误媒体文章</title><link>${origin}/story/err-1</link><content:encoded><![CDATA[<p>正文</p><img src="/media/error-image.png" alt="错误图片" />]]></content:encoded></item></channel></rss>`,
      );
      return;
    }
    if (path === "/short-summary-feed") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0"><channel><title>短摘要来源</title><item><guid>urn:binny:short:item-1</guid><title>短摘要文章</title><link>${origin}/story/short-1</link><description>只有摘要版本 1</description></item></channel></rss>`,
      );
      return;
    }
    if (path === "/empty-shell-feed") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>空壳正文来源</title><item><guid>urn:binny:empty:item-1</guid><title>空壳文章</title><link>${origin}/story/empty-1</link><content:encoded><![CDATA[<div><script>var x = 1;</script><style>.a{color:red}</style></div>]]></content:encoded></item></channel></rss>`,
      );
      return;
    }
    if (path === "/no-body-feed") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
      });
      response.end(
        `<rss version="2.0"><channel><title>缺失正文来源</title><item><guid>urn:binny:nobody:item-1</guid><title>无正文文章</title><link>${origin}/story/nobody-1</link></item></channel></rss>`,
      );
      return;
    }
    if (path === "/simon-atom") {
      response.writeHead(200, {
        "content-type": "application/atom+xml; charset=utf-8",
        etag: '"simon-1"',
      });
      response.end(
        `<feed xmlns="http://www.w3.org/2005/Atom"><id>tag:simonwillison.net,2026:atom-feed</id><title>Simon Willison’s Weblog</title><updated>2026-11-01T15:00:00Z</updated><entry><id>tag:simonwillison.net,2026:note-1</id><title>Short blogmark note</title><link href="${origin}/note/1" /><updated>2026-11-01T12:00:00Z</updated><summary type="html"><![CDATA[<p>Found this tool: <a href="https://example.com/tool">Tool</a> - quote: <blockquote>A small utility</blockquote> run with <code>pip install tool</code>.</p>]]></summary></entry><entry><id>tag:simonwillison.net,2026:article-1</id><title>LLM Guide</title><link href="${origin}/article/1" /><updated>2026-11-01T14:00:00Z</updated><summary type="html"><![CDATA[<p>First paragraph detailing language models and architectures.</p><p>Second paragraph on fine-tuning and inference optimizations.</p><pre><code>def generate():\n    return "done"</code></pre><blockquote><p>Quote from research paper.</p></blockquote><p>Reference link <a href="https://example.com/paper">Paper</a>.</p>]]></summary></entry></feed>`,
      );
      return;
    }
    if (path === "/sync-feed") {
      const etag = `"sync-${syncFeedVersion}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        etag,
      });
      const items: string[] = [
        `<item><guid>urn:binny:sync:item-1</guid><title>Sync 历史基线条目 1</title><link>${origin}/sync/1</link><content:encoded><![CDATA[<p>基线正文 1</p>]]></content:encoded></item>`,
      ];
      if (syncFeedVersion >= 3) {
        const item2Content =
          syncFeedVersion >= 4 ? "新增条目 2 更新版" : "新增条目 2 原版";
        items.push(
          `<item><guid>urn:binny:sync:item-2</guid><title>Sync 新增条目 2</title><link>${origin}/sync/2</link><content:encoded><![CDATA[<p>${item2Content}</p>]]></content:encoded></item>`,
        );
      }
      if (syncFeedVersion >= 5) {
        items.push(
          `<item><guid>urn:binny:sync:item-3</guid><title>Sync 无正文条目 3</title><link>${origin}/sync/3</link></item>`,
        );
      }
      response.end(
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Sync 测试来源</title><link>${origin}/</link>${items.join("")}</channel></rss>`,
      );
      return;
    }
    if (path === "/sync-media-fail-feed") {
      const etag = `"sync-media-${syncMediaFeedVersion}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        etag,
      });
      const items: string[] = [
        `<item><guid>urn:binny:sync-media:item-base</guid><title>媒体基线条目</title><link>${origin}/sync-media/base</link><content:encoded><![CDATA[<p>基线正文</p>]]></content:encoded></item>`,
      ];
      if (syncMediaFeedVersion >= 2) {
        items.push(
          `<item><guid>urn:binny:sync-media:item-photo</guid><title>含媒体条目</title><link>${origin}/sync-media/photo</link><content:encoded><![CDATA[<p>条目正文</p><img src="/media/fail-once.png" alt="待恢复图片" />]]></content:encoded></item>`,
        );
      }
      response.end(
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>媒体失败测试来源</title><link>${origin}/</link>${items.join("")}</channel></rss>`,
      );
      return;
    }
    if (path === "/sync-backfill-feed") {
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        etag: '"backfill-1"',
      });
      response.end(
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>补采测试来源</title><link>${origin}/</link><item><guid>urn:binny:backfill:item-1</guid><title>历史条目 1</title><link>${origin}/backfill/1</link><content:encoded><![CDATA[<p>历史正文 1</p>]]></content:encoded></item><item><guid>urn:binny:backfill:item-2</guid><title>历史条目 2</title><link>${origin}/backfill/2</link><content:encoded><![CDATA[<p>历史正文 2</p>]]></content:encoded></item></channel></rss>`,
      );
      return;
    }
    if (path === "/files/report.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><h1>审计报告</h1></body></html>",
      );
      return;
    }
    if (path === "/files/data.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", count: 42 }));
      return;
    }
    if (path === "/media/error-image.png") {
      mediaRequests.push(path);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body>500 Internal Error</body></html>",
      );
      return;
    }
    if (path === "/media/fail-once.png") {
      mediaRequests.push(path);
      if (!failOnceAvailable) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("Internal Server Error");
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([1, 2, 3, 4]));
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
    referenceTime: "2026-10-28T00:00:00.000Z",
    sourceAdapterVersion: sourceAdapter.version,
    config: {
      feeds: [
        { id: "rss-main", url: `${origin}/rss`, title: "RSS 来源" },
        { id: "atom-main", url: `${origin}/atom`, title: "Atom 来源" },
        { id: "summary-full", url: `${origin}/summary-full` },
        {
          id: "summary-forced",
          url: `${origin}/summary-forced`,
          bodyField: "summary",
        },
        { id: "genuine-attach", url: `${origin}/genuine-attachments` },
        { id: "error-media", url: `${origin}/error-media-feed` },
        { id: "short-summary", url: `${origin}/short-summary-feed` },
        { id: "empty-shell", url: `${origin}/empty-shell-feed` },
        { id: "no-body", url: `${origin}/no-body-feed` },
        {
          id: "content-missing",
          url: `${origin}/short-summary-feed`,
          bodyField: "content",
        },
        { id: "simon-atom", url: `${origin}/simon-atom` },
        { id: "sync-test", url: `${origin}/sync-feed` },
        { id: "sync-media", url: `${origin}/sync-media-fail-feed` },
        { id: "sync-backfill", url: `${origin}/sync-backfill-feed` },
      ],
    },
    signal: new AbortController().signal,
    persistentState,
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
        resources.push(resource);
        return { ok: true, resource } as const;
      },
    },
  };

  try {
    const collect = sourceAdapter.actions.collect;
    const check = sourceAdapter.actions.check;
    const sync = sourceAdapter.actions.sync;
    assert.ok(collect !== undefined);
    assert.ok(check !== undefined);
    assert.ok(sync !== undefined);

    // 1. Collect full text from content and summary
    const first = await collect.execute(context, {
      feedIds: ["rss-main", "atom-main", "summary-full", "summary-forced"],
    });
    assert.deepEqual(first, {
      completedScopes: [
        "feed:rss-main",
        "feed:atom-main",
        "feed:summary-full",
        "feed:summary-forced",
      ],
    });
    assert.equal(submissions.length, 4);

    const rssItem = submissions[0]?.items[0];
    assert.ok(rssItem);
    assert.deepEqual(rssItem.sourceKey, {
      namespace: "rss:rss-main",
      key: "id:urn:binny:rss:item-1",
    });
    assert.equal(rssItem.body?.html, undefined);
    assert.equal(rssItem.body?.markdown?.includes("RSS 全文版本 1"), true);
    assert.equal(rssItem.body?.markdown?.includes("binny://resource/"), true);
    assert.equal(rssItem.body?.text?.includes("RSS 全文版本 1"), true);
    assert.equal(rssItem.body?.searchText?.includes("RSS 全文版本 1"), true);
    assert.equal(rssItem.capture.completeness, "complete");
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
    assert.equal(atomItem.body?.html, undefined);
    assert.equal(atomItem.body?.markdown?.includes("Atom 完整正文"), true);
    assert.equal(atomItem.capture.completeness, "complete");

    const summaryFullItem = submissions[2]?.items[0];
    assert.ok(summaryFullItem);
    assert.equal(summaryFullItem.body?.html, undefined);
    assert.equal(
      summaryFullItem.body?.markdown?.includes(
        "这是在 description 中的完整正文第一段。",
      ),
      true,
    );
    assert.equal(summaryFullItem.capture.scope.bodySource, "summary");
    assert.equal(summaryFullItem.capture.completeness, "complete");

    const summaryForcedItem = submissions[3]?.items[0];
    assert.ok(summaryForcedItem);
    assert.equal(summaryForcedItem.body?.html, undefined);
    assert.equal(
      summaryForcedItem.body?.markdown?.includes("配置强制摘要"),
      true,
    );
    assert.equal(summaryForcedItem.capture.scope.bodySource, "summary");
    assert.equal(summaryForcedItem.capture.completeness, "complete");

    // Incremental update for rss-main
    rssVersion = 2;
    const second = await collect.execute(context, {
      feedIds: ["rss-main"],
    });
    assert.deepEqual(second, { completedScopes: ["feed:rss-main"] });
    assert.equal(submissions.length, 5);
    assert.deepEqual(submissions[4]?.items[0]?.sourceKey, rssItem.sourceKey);
    assert.equal(
      submissions[4]?.items[0]?.body?.markdown?.includes("RSS 全文版本 2"),
      true,
    );
    assert.equal(submissions[4]?.items[0]?.body?.html, undefined);

    // 2. Genuine .html and .json attachments archived
    const attachResult = await collect.execute(context, {
      feedIds: ["genuine-attach"],
    });
    assert.deepEqual(attachResult, {
      completedScopes: ["feed:genuine-attach"],
    });
    const attachItem = submissions[5]?.items[0];
    assert.ok(attachItem);
    assert.equal(attachItem.capture.completeness, "complete");
    assert.equal(attachItem.resources?.length, 2);
    assert.equal(
      attachItem.body?.markdown?.includes("binny://resource/"),
      true,
    );

    // 3. Rejected media: image URL returning text/html error page rejected, marking item partial and failing collect
    let errorMediaErr: unknown;
    try {
      await collect.execute(context, { feedIds: ["error-media"] });
    } catch (error) {
      errorMediaErr = error;
    }
    assert.ok(isSourceAdapterActionError(errorMediaErr));
    assert.equal(errorMediaErr.failure.code, "rss_collection_incomplete");
    const errorMediaItem = submissions[6]?.items[0];
    assert.ok(errorMediaItem);
    assert.equal(errorMediaItem.capture.completeness, "partial");
    assert.ok(
      errorMediaItem.capture.missing.some(({ path }) => path === "media.0"),
    );

    // 4. Short summary: check reports available, initial sync initializes baseline, collect archives complete item
    const shortSummaryCheck = await check.execute(context, {
      feedIds: ["short-summary"],
    });
    assert.equal(shortSummaryCheck.availability, "available");
    assert.equal(shortSummaryCheck.problems.length, 0);

    const shortSummarySync = await sync.execute(context, {
      feedIds: ["short-summary"],
    });
    assert.deepEqual(shortSummarySync, {
      completedScopes: ["feed:short-summary"],
      initializedScopes: ["feed:short-summary"],
    });

    const shortSummaryCollect = await collect.execute(context, {
      feedIds: ["short-summary"],
    });
    assert.deepEqual(shortSummaryCollect, {
      completedScopes: ["feed:short-summary"],
    });
    const shortSummaryItem = submissions[7]?.items[0];
    assert.ok(shortSummaryItem);
    assert.equal(shortSummaryItem.capture.completeness, "complete");
    assert.deepEqual(shortSummaryItem.capture.missing, []);
    assert.equal(shortSummaryItem.capture.scope.bodySource, "summary");
    assert.equal(shortSummaryItem.body?.text, "只有摘要版本 1");

    // 5. Empty shell HTML: check reports rss_entry_body_unavailable, initial sync fails, collect fails without archiving partial item
    const emptyShellCheck = await check.execute(context, {
      feedIds: ["empty-shell"],
    });
    assert.equal(emptyShellCheck.availability, "unavailable");
    assert.ok(
      emptyShellCheck.problems.some(
        (p) => p.code === "rss_entry_body_unavailable",
      ),
    );

    let emptyShellSyncErr: unknown;
    try {
      await sync.execute(context, { feedIds: ["empty-shell"] });
    } catch (error) {
      emptyShellSyncErr = error;
    }
    assert.ok(isSourceAdapterActionError(emptyShellSyncErr));
    assert.equal(emptyShellSyncErr.failure.code, "rss_collection_incomplete");

    const beforeEmptyShellSubmissions = submissions.length;
    let emptyShellCollectErr: unknown;
    try {
      await collect.execute(context, { feedIds: ["empty-shell"] });
    } catch (error) {
      emptyShellCollectErr = error;
    }
    assert.ok(isSourceAdapterActionError(emptyShellCollectErr));
    assert.equal(
      emptyShellCollectErr.failure.code,
      "rss_collection_incomplete",
    );
    assert.equal(
      submissions.length,
      beforeEmptyShellSubmissions,
      "Empty body entry is rejected and must not be archived as a partial item.",
    );

    // 6. Missing body & content-missing: check reports rss_entry_body_unavailable, initial sync fails, collect fails without archiving partial item
    const noBodyCheck = await check.execute(context, {
      feedIds: ["no-body", "content-missing"],
    });
    assert.equal(noBodyCheck.availability, "unavailable");
    assert.ok(
      noBodyCheck.problems.some((p) => p.code === "rss_entry_body_unavailable"),
    );

    let noBodySyncErr: unknown;
    try {
      await sync.execute(context, { feedIds: ["no-body"] });
    } catch (error) {
      noBodySyncErr = error;
    }
    assert.ok(isSourceAdapterActionError(noBodySyncErr));
    assert.equal(noBodySyncErr.failure.code, "rss_collection_incomplete");

    let contentMissingSyncErr: unknown;
    try {
      await sync.execute(context, { feedIds: ["content-missing"] });
    } catch (error) {
      contentMissingSyncErr = error;
    }
    assert.ok(isSourceAdapterActionError(contentMissingSyncErr));
    assert.equal(
      contentMissingSyncErr.failure.code,
      "rss_collection_incomplete",
    );

    const beforeNoBodySubmissions = submissions.length;
    let noBodyCollectErr: unknown;
    try {
      await collect.execute(context, { feedIds: ["no-body"] });
    } catch (error) {
      noBodyCollectErr = error;
    }
    assert.ok(isSourceAdapterActionError(noBodyCollectErr));
    assert.equal(noBodyCollectErr.failure.code, "rss_collection_incomplete");
    assert.equal(
      submissions.length,
      beforeNoBodySubmissions,
      "Missing body entry is rejected and must not be archived as a partial item.",
    );

    let contentMissingCollectErr: unknown;
    try {
      await collect.execute(context, { feedIds: ["content-missing"] });
    } catch (error) {
      contentMissingCollectErr = error;
    }
    assert.ok(isSourceAdapterActionError(contentMissingCollectErr));
    assert.equal(
      contentMissingCollectErr.failure.code,
      "rss_collection_incomplete",
    );
    assert.equal(
      submissions.length,
      beforeNoBodySubmissions,
      "Feed requiring content when content is absent is rejected and must not be archived.",
    );

    // 7. Simon Willison Atom feed: short blogmarks and long summary articles recognized as complete full text
    const simonCheck = await check.execute(context, {
      feedIds: ["simon-atom"],
    });
    assert.equal(simonCheck.availability, "available");
    assert.equal(simonCheck.problems.length, 0);

    const simonCollect = await collect.execute(context, {
      feedIds: ["simon-atom"],
    });
    assert.deepEqual(simonCollect, { completedScopes: ["feed:simon-atom"] });
    assert.equal(submissions.length, 10);

    const simonNote = submissions[8]?.items[0];
    assert.ok(simonNote);
    assert.equal(simonNote.sourceKey.namespace, "rss:simon-atom");
    assert.equal(
      simonNote.sourceKey.key,
      "id:tag:simonwillison.net,2026:note-1",
    );
    assert.equal(simonNote.capture.scope.bodySource, "summary");
    assert.equal(simonNote.capture.completeness, "complete");
    assert.equal(simonNote.body?.html, undefined);
    assert.ok(simonNote.body?.markdown?.includes("https://example.com/tool"));
    assert.ok(simonNote.body?.markdown?.includes("pip install tool"));

    const simonArticle = submissions[9]?.items[0];
    assert.ok(simonArticle);
    assert.equal(simonArticle.sourceKey.namespace, "rss:simon-atom");
    assert.equal(
      simonArticle.sourceKey.key,
      "id:tag:simonwillison.net,2026:article-1",
    );
    assert.equal(simonArticle.capture.scope.bodySource, "summary");
    assert.equal(simonArticle.capture.completeness, "complete");
    assert.ok(simonArticle.body?.markdown?.includes("First paragraph"));
    assert.ok(simonArticle.body?.markdown?.includes("def generate()"));
    assert.ok(
      simonArticle.body?.markdown?.includes("https://example.com/paper"),
    );

    // 8. Incremental Sync: baseline initialization establishes state without archiving historical items
    const beforeSyncSubmissions = submissions.length;
    const initialSyncResult = await sync.execute(context, {
      feedIds: ["sync-test"],
    });
    assert.deepEqual(initialSyncResult, {
      completedScopes: ["feed:sync-test"],
      initializedScopes: ["feed:sync-test"],
    });
    assert.equal(
      submissions.length,
      beforeSyncSubmissions,
      "First sync establishes baseline only; zero historical items submitted to archive.",
    );
    assert.ok(storedPersistentState !== undefined);
    assert.equal(
      storedPersistentState.scopes["sync-test"]?.entries[
        "id:urn:binny:sync:item-1"
      ]?.archivedCompleteness,
      "baseline",
    );

    // Repeat sync with 304 / no changes: skips entries without submissions
    const repeatSyncResult = await sync.execute(context, {
      feedIds: ["sync-test"],
    });
    assert.deepEqual(repeatSyncResult, {
      completedScopes: ["feed:sync-test"],
      initializedScopes: [],
    });
    assert.equal(submissions.length, beforeSyncSubmissions);

    // New item added in feed: sync archives only newly added entry
    syncFeedVersion = 3;
    const newEntrySyncResult = await sync.execute(context, {
      feedIds: ["sync-test"],
    });
    assert.deepEqual(newEntrySyncResult, {
      completedScopes: ["feed:sync-test"],
      initializedScopes: [],
    });
    assert.equal(submissions.length, beforeSyncSubmissions + 1);
    const newSyncItem = submissions[beforeSyncSubmissions]?.items[0];
    assert.equal(newSyncItem?.sourceKey.key, "id:urn:binny:sync:item-2");
    assert.equal(newSyncItem?.capture.completeness, "complete");

    // Modified item in feed: sync archives updated revision
    syncFeedVersion = 4;
    const modifiedSyncResult = await sync.execute(context, {
      feedIds: ["sync-test"],
    });
    assert.deepEqual(modifiedSyncResult, {
      completedScopes: ["feed:sync-test"],
      initializedScopes: [],
    });
    assert.equal(submissions.length, beforeSyncSubmissions + 2);
    const modifiedSyncItem = submissions[beforeSyncSubmissions + 1]?.items[0];
    assert.equal(modifiedSyncItem?.sourceKey.key, "id:urn:binny:sync:item-2");
    assert.ok(modifiedSyncItem?.body?.markdown?.includes("新增条目 2 更新版"));

    // Subsequent sync fails when feed contains entry missing body and does not archive partial item
    syncFeedVersion = 5;
    const beforeSubsequentSyncFailSubmissions = submissions.length;
    let subsequentSyncErr: unknown;
    try {
      await sync.execute(context, { feedIds: ["sync-test"] });
    } catch (error) {
      subsequentSyncErr = error;
    }
    assert.ok(isSourceAdapterActionError(subsequentSyncErr));
    assert.equal(subsequentSyncErr.failure.code, "rss_collection_incomplete");
    assert.equal(
      submissions.length,
      beforeSubsequentSyncFailSubmissions,
      "Subsequent sync on entry missing body fails without submitting partial item.",
    );

    // 9. Media failure during sync & explicit collect recovery
    const syncMediaInit = await sync.execute(context, {
      feedIds: ["sync-media"],
    });
    assert.deepEqual(syncMediaInit.completedScopes, ["feed:sync-media"]);
    assert.deepEqual(syncMediaInit.initializedScopes, ["feed:sync-media"]);

    // Add item with media that fails
    syncMediaFeedVersion = 2;
    failOnceAvailable = false;
    let syncMediaErr: unknown;
    try {
      await sync.execute(context, { feedIds: ["sync-media"] });
    } catch (error) {
      syncMediaErr = error;
    }
    assert.ok(isSourceAdapterActionError(syncMediaErr));
    assert.equal(syncMediaErr.failure.code, "rss_collection_incomplete");

    // Partial item was submitted to archive
    const partialItemSubmission = submissions.at(-1)?.items[0];
    assert.equal(
      partialItemSubmission?.sourceKey.key,
      "id:urn:binny:sync-media:item-photo",
    );
    assert.equal(partialItemSubmission?.capture.completeness, "partial");
    assert.ok(
      partialItemSubmission?.capture.missing.some(
        ({ path, reason }) =>
          path === "media.0" && reason.includes("本次未能取得或归档"),
      ),
    );

    // Fingerprint was recorded in persistent state with partial completeness
    assert.equal(
      storedPersistentState?.scopes["sync-media"]?.entries[
        "id:urn:binny:sync-media:item-photo"
      ]?.archivedCompleteness,
      "partial",
    );

    // Next sync with unchanged feed skips re-fetching failed media (no implicit pending-media retry)
    const subsequentSyncResult = await sync.execute(context, {
      feedIds: ["sync-media"],
    });
    assert.deepEqual(subsequentSyncResult.completedScopes, ["feed:sync-media"]);

    // Media now becomes available; explicit collect recovers it
    failOnceAvailable = true;
    const collectRecovery = await collect.execute(context, {
      feedIds: ["sync-media"],
    });
    assert.deepEqual(collectRecovery, {
      completedScopes: ["feed:sync-media"],
    });
    const recoveredItemSubmission = submissions.at(-1)?.items[0];
    assert.equal(
      recoveredItemSubmission?.sourceKey.key,
      "id:urn:binny:sync-media:item-photo",
    );
    assert.equal(recoveredItemSubmission?.capture.completeness, "complete");
    assert.equal(
      storedPersistentState?.scopes["sync-media"]?.entries[
        "id:urn:binny:sync-media:item-photo"
      ]?.archivedCompleteness,
      "complete",
    );

    // 10. Explicit collect on baseline-only feed backfills historical entries
    const beforeBackfillSubmissions = submissions.length;
    const baselineOnlySync = await sync.execute(context, {
      feedIds: ["sync-backfill"],
    });
    assert.deepEqual(baselineOnlySync, {
      completedScopes: ["feed:sync-backfill"],
      initializedScopes: ["feed:sync-backfill"],
    });
    assert.equal(submissions.length, beforeBackfillSubmissions);

    // Explicit collect backfills historical entries
    const backfillCollect = await collect.execute(context, {
      feedIds: ["sync-backfill"],
    });
    assert.deepEqual(backfillCollect, {
      completedScopes: ["feed:sync-backfill"],
    });
    assert.equal(
      submissions.length,
      beforeBackfillSubmissions + 2,
      "Explicit collect on baseline-only feed backfilled both historical entries.",
    );
    const backfilled1 = submissions[beforeBackfillSubmissions]?.items[0];
    const backfilled2 = submissions[beforeBackfillSubmissions + 1]?.items[0];
    assert.equal(backfilled1?.sourceKey.key, "id:urn:binny:backfill:item-1");
    assert.equal(backfilled2?.sourceKey.key, "id:urn:binny:backfill:item-2");

    // Second collect skips already-backfilled complete entries
    const secondBackfillCollect = await collect.execute(context, {
      feedIds: ["sync-backfill"],
    });
    assert.deepEqual(secondBackfillCollect, {
      completedScopes: ["feed:sync-backfill"],
    });
    assert.equal(
      submissions.length,
      beforeBackfillSubmissions + 2,
      "Second collect skipped unchanged complete items.",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }
});
