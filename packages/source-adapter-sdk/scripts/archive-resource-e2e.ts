import assert from "node:assert/strict";

import { createApiClient } from "@binny/api/client";

import {
  archiveBodyWithResources,
  archiveResourceManifest,
  archivedMedia,
  uploadArchiveResource,
} from "../src/index.ts";

const baseUrl = process.argv[2];
if (baseUrl === undefined || baseUrl.length === 0) {
  throw new Error("SDK 资源验收需要核心 API 地址。");
}

const client = createApiClient(baseUrl);
const bytes = new TextEncoder().encode("sourceAdapter sdk image v1");
const mediaBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(bytes);
    controller.close();
  },
});
const uploaded = await uploadArchiveResource(
  client,
  mediaBody,
  "image/svg+xml",
);
if (!uploaded.ok) throw new Error(uploaded.error.message);

const media = archivedMedia(uploaded.resource);
const body = archiveBodyWithResources([
  '<figure><img src="',
  media,
  '"></figure> https://example.test/external-image',
]);
assert.equal(
  body.content,
  `<figure><img src="binny://resource/${uploaded.resource.resourceId}"></figure> https://example.test/external-image`,
);
assert.deepEqual(body.resources, [
  { resourceId: uploaded.resource.resourceId },
]);
assert.deepEqual(
  archiveResourceManifest([uploaded.resource, uploaded.resource]),
  [{ resourceId: uploaded.resource.resourceId }],
);

const submission = await client.archives.$post({
  json: {
    requestId: "e2e:archive:sdk-resource",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "sdk-resource" },
        body: { html: body.content, searchText: "SDK 媒体" },
        resources: [...body.resources],
        capture: {
          scope: { case: "sdk-resource" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  },
});
if (submission.status !== 201) {
  throw new Error("SDK 媒体资料提交失败：" + (await submission.text()));
}
const submitted = await submission.json();
const item = submitted.items[0];
assert.ok(item);
const read = await client.archives.items[":itemId"].$get({
  param: { itemId: item.itemId },
  query: {},
});
if (read.status !== 200) {
  throw new Error("SDK 媒体条目读取失败：" + (await read.text()));
}
const archived = await read.json();
assert.equal(archived.views[0]?.state.body?.html, body.content);
assert.deepEqual(archived.views[0]?.state.resources, body.resources);

const resourceRead = await client.resources[":resourceId"].$get({
  param: { resourceId: uploaded.resource.resourceId },
});
if (resourceRead.status !== 200) {
  throw new Error("SDK 上传媒体读取失败：" + (await resourceRead.text()));
}
assert.deepEqual(new Uint8Array(await resourceRead.arrayBuffer()), bytes);
process.stdout.write(
  JSON.stringify({
    itemId: item.itemId,
    revisionId: item.revisionId,
    resourceId: uploaded.resource.resourceId,
  }),
);
