import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ArchiveCommit,
  ArchiveResourceMetadata,
  CollectorContext,
} from "@binny/collector-sdk";

import collector from "../src/index.ts";

void test("RSS 与 Atom 全文、结构和媒体由正式动作提交，编辑保留信源键", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "binny-rss-test-"));
  const previousStateDirectory = process.env.BINNY_COLLECTOR_STATE_DIRECTORY;
  process.env.BINNY_COLLECTOR_STATE_DIRECTORY = stateDirectory;

  let rssVersion = 1;
  const mediaRequests: string[] = [];
  const submissions: Parameters<CollectorContext["archive"]["submit"]>[0][] =
    [];
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
  const context: CollectorContext = {
    binId: "rss-test-bin",
    identityId: "rss-test-identity",
    runId,
    collectorVersion: collector.version,
    config: {
      feeds: [
        { id: "rss-main", url: `${origin}/rss`, title: "RSS 来源" },
        { id: "atom-main", url: `${origin}/atom`, title: "Atom 来源" },
      ],
    },
    targets: [],
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
          collectorVersion: collector.version,
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
    const collect = collector.actions.collect;
    assert.ok(collect !== undefined);
    const first = await collect.execute(context, {});
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
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    await rm(stateDirectory, { recursive: true, force: true });
    if (previousStateDirectory === undefined) {
      delete process.env.BINNY_COLLECTOR_STATE_DIRECTORY;
    } else {
      process.env.BINNY_COLLECTOR_STATE_DIRECTORY = previousStateDirectory;
    }
  }
});
