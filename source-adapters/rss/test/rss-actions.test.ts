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

void test("RSS/Atom clean content, full-text selection, attachments, and incremental collection", async () => {
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
      // Inline image returns text/html error page with HTTP 200 (e.g. anti-bot/login)
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body>500 Internal Error</body></html>",
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
    const check = sourceAdapter.actions.check;
    assert.ok(collect !== undefined);
    assert.ok(check !== undefined);

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

    // 4. Short summary only: check reports rss_feed_summary_only, collect fails and marks partial
    const shortSummaryCheck = await check.execute(context, {
      feedIds: ["short-summary"],
    });
    assert.equal(shortSummaryCheck.availability, "unavailable");
    assert.ok(
      shortSummaryCheck.problems.some(
        (p) => p.code === "rss_feed_summary_only",
      ),
    );

    let shortSummaryErr: unknown;
    try {
      await collect.execute(context, { feedIds: ["short-summary"] });
    } catch (error) {
      shortSummaryErr = error;
    }
    assert.ok(isSourceAdapterActionError(shortSummaryErr));
    assert.equal(shortSummaryErr.failure.code, "rss_collection_incomplete");
    const shortSummaryItem = submissions[7]?.items[0];
    assert.ok(shortSummaryItem);
    assert.equal(shortSummaryItem.capture.completeness, "partial");
    assert.ok(
      shortSummaryItem.capture.missing.some(
        ({ path }) => path === "body.fullText",
      ),
    );

    // 5. Empty shell HTML: check reports rss_entry_body_unavailable, collect fails and marks partial
    const emptyShellCheck = await check.execute(context, {
      feedIds: ["empty-shell"],
    });
    assert.equal(emptyShellCheck.availability, "unavailable");
    assert.ok(
      emptyShellCheck.problems.some(
        (p) => p.code === "rss_entry_body_unavailable",
      ),
    );

    let emptyShellErr: unknown;
    try {
      await collect.execute(context, { feedIds: ["empty-shell"] });
    } catch (error) {
      emptyShellErr = error;
    }
    assert.ok(isSourceAdapterActionError(emptyShellErr));
    assert.equal(emptyShellErr.failure.code, "rss_collection_incomplete");
    const emptyShellItem = submissions[8]?.items[0];
    assert.ok(emptyShellItem);
    assert.equal(emptyShellItem.capture.completeness, "partial");
    assert.ok(
      emptyShellItem.capture.missing.some(
        ({ path }) => path === "body.fullText",
      ),
    );

    // 6. Missing body: check reports rss_entry_body_unavailable, collect fails and marks partial
    const noBodyCheck = await check.execute(context, {
      feedIds: ["no-body"],
    });
    assert.equal(noBodyCheck.availability, "unavailable");
    assert.ok(
      noBodyCheck.problems.some((p) => p.code === "rss_entry_body_unavailable"),
    );

    let noBodyErr: unknown;
    try {
      await collect.execute(context, { feedIds: ["no-body"] });
    } catch (error) {
      noBodyErr = error;
    }
    assert.ok(isSourceAdapterActionError(noBodyErr));
    assert.equal(noBodyErr.failure.code, "rss_collection_incomplete");
    const noBodyItem = submissions[9]?.items[0];
    assert.ok(noBodyItem);
    assert.equal(noBodyItem.capture.completeness, "partial");
    assert.ok(
      noBodyItem.capture.missing.some(({ path }) => path === "body.fullText"),
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
