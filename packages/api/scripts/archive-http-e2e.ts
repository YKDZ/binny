import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApiClient } from "@binny/api/client";
import {
  archiveIdentifierSchema,
  archiveSnapshotSequenceSchema,
  archiveSubmissionInputSchema,
} from "@binny/contracts";
import * as z from "zod";

type ArchiveClient = ReturnType<typeof createApiClient>;
type ArchiveTimelineQuery = Parameters<
  ArchiveClient["archives"]["items"][":itemId"]["timeline"]["$get"]
>[0]["query"];
type ArchiveSubmission = Parameters<
  ArchiveClient["archives"]["$post"]
>[0]["json"];
type ArchiveJourney = {
  readonly itemId: string;
  readonly revisionId: string;
  readonly commitId: string;
  readonly historicalAsOf: string;
  readonly replayRequest: ArchiveSubmission;
  readonly replayCommitId: string;
  readonly expectedObservationCount: number;
  readonly resourceItemId: string;
  readonly resourceRevisionId: string;
  readonly resourceId: string;
  readonly repairedResourceId: string;
  readonly orphanResourceId: string;
  readonly resourceMarkerItemId: string;
};

type SdkResourceJourney = {
  readonly itemId: string;
  readonly revisionId: string;
  readonly resourceId: string;
};

const archiveJourneySchema = z.object({
  itemId: archiveIdentifierSchema,
  revisionId: archiveIdentifierSchema,
  commitId: archiveIdentifierSchema,
  historicalAsOf: archiveSnapshotSequenceSchema,
  replayRequest: archiveSubmissionInputSchema,
  replayCommitId: archiveIdentifierSchema,
  expectedObservationCount: z.number().int().nonnegative(),
  resourceItemId: archiveIdentifierSchema,
  resourceRevisionId: archiveIdentifierSchema,
  resourceId: archiveIdentifierSchema,
  repairedResourceId: archiveIdentifierSchema,
  orphanResourceId: archiveIdentifierSchema,
  resourceMarkerItemId: archiveIdentifierSchema,
});

const sdkResourceJourneySchema = z.object({
  itemId: archiveIdentifierSchema,
  revisionId: archiveIdentifierSchema,
  resourceId: archiveIdentifierSchema,
});

async function submitArchive(
  client: ArchiveClient,
  request: ArchiveSubmission,
) {
  const response = await client.archives.$post({ json: request });
  if (response.status !== 201) {
    throw new Error("归档提交失败：" + (await response.text()));
  }
  return await response.json();
}

async function readArchiveItem(client: ArchiveClient, itemId: string) {
  const response = await client.archives.items[":itemId"].$get({
    param: { itemId },
    query: {},
  });
  if (response.status !== 200) {
    throw new Error("读取归档条目失败：" + (await response.text()));
  }
  return await response.json();
}

async function verifyArchiveResourceHttp(client: ArchiveClient): Promise<{
  readonly resourceId: string;
  readonly repairedResourceId: string;
  readonly orphanResourceId: string;
  readonly resourceMarkerItemId: string;
  readonly itemId: string;
  readonly revisionId: string;
}> {
  const bytes = new TextEncoder().encode("binny media bytes v1");
  const upload = (value: BodyInit) =>
    client.resources.$post(
      { header: { "content-type": "image/png" } },
      { init: { body: value } },
    );
  const firstResponsePromise = upload(new Blob([bytes]));
  const duplicateResponsePromise = upload(new Blob([bytes]));
  const firstResponse = await firstResponsePromise;
  assert.equal(firstResponse.status, 201);
  if (firstResponse.status !== 201) {
    throw new Error("归档资源上传失败。");
  }
  const first = await firstResponse.json();

  const firstCommitPromise = submitArchive(client, {
    requestId: "e2e:archive:resource-history:first",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-history" },
        metadata: { title: "原始完整版本" },
        body: {
          markdown: `原文位置 binny://resource/${first.resourceId}；外链 https://example.test/image.png`,
        },
        resources: [{ resourceId: first.resourceId }],
        capture: {
          scope: { phase: "full" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const duplicateResponse = await duplicateResponsePromise;
  assert.equal(duplicateResponse.status, 201);
  if (duplicateResponse.status !== 201) {
    throw new Error("并发归档资源上传失败。");
  }
  const duplicate = await duplicateResponse.json();
  assert.equal(first.resourceId, duplicate.resourceId);
  assert.equal(first.mediaType, "image/png");
  assert.equal(first.size, 20);
  assert.equal(
    first.sha256,
    "07b91a192c733e472f4ccc16deb88af601cc2a3463486b672f6b5a11f821a7c4",
  );
  const firstCommit = await firstCommitPromise;
  const firstItem = firstCommit.items[0];
  assert.ok(firstItem);

  const read = await client.resources[":resourceId"].$get({
    param: { resourceId: first.resourceId },
  });
  assert.equal(read.status, 200);
  if (read.status !== 200) throw new Error("读取归档资源失败。");
  assert.equal(read.headers.get("content-type"), "image/png");
  assert.equal(Number(read.headers.get("content-length")), bytes.byteLength);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);

  const orphanBytes = new TextEncoder().encode("unreferenced media");
  const orphanResponse = await upload(new Blob([orphanBytes]));
  if (orphanResponse.status !== 201) {
    throw new Error("未引用资源上传失败：" + (await orphanResponse.text()));
  }
  const orphan = await orphanResponse.json();

  const resourceMarker = await submitArchive(client, {
    requestId: "e2e:archive:resource-text-marker-only",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-text-marker-only" },
        metadata: { note: `binny://resource/${orphan.resourceId}` },
        body: { text: `正文保留标记 binny://resource/${orphan.resourceId}` },
        capture: {
          scope: { phase: "text-marker-only" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const resourceMarkerItemId = resourceMarker.items[0]?.itemId;
  assert.ok(resourceMarkerItemId);
  const resourceMarkerRead = await readArchiveItem(
    client,
    resourceMarkerItemId,
  );
  assert.equal(
    resourceMarkerRead.views[0]?.state.body?.text,
    `正文保留标记 binny://resource/${orphan.resourceId}`,
  );
  assert.equal(resourceMarkerRead.views[0]?.state.resources, undefined);

  const invalidReference = await client.archives.$post({
    json: {
      requestId: "e2e:archive:invalid-resource-reference",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "invalid-resource-reference" },
          body: { text: "悬空资源引用" },
          resources: [{ resourceId: randomUUID() }],
          capture: {
            scope: { case: "invalid-resource-reference" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  if (invalidReference.status !== 400) {
    throw new Error(
      "未上传的资源引用应被拒绝：" + (await invalidReference.text()),
    );
  }
  const invalidReferenceError = await invalidReference.json();
  assert.equal(invalidReferenceError.error.code, "resource_not_found");
  assert.deepEqual(invalidReferenceError.error.path, [
    "items",
    0,
    "resources",
    0,
    "resourceId",
  ]);

  const attachmentOnly = await submitArchive(client, {
    requestId: "e2e:archive:resource-attachment-only",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-attachment-only" },
        resources: [{ resourceId: first.resourceId }],
        capture: {
          scope: { phase: "attachment-only" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const attachmentItemId = attachmentOnly.items[0]?.itemId;
  assert.ok(attachmentItemId);
  const attachmentRead = await readArchiveItem(client, attachmentItemId);
  assert.equal(attachmentRead.views[0]?.state.body, undefined);
  assert.deepEqual(attachmentRead.views[0]?.state.resources, [
    { resourceId: first.resourceId },
  ]);

  const partialCommit = await submitArchive(client, {
    requestId: "e2e:archive:resource-history:partial",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-history" },
        metadata: { title: "本次只取得部分资料" },
        body: { text: "本次取得的正文" },
        capture: {
          scope: { phase: "partial" },
          completeness: "partial",
          missing: [{ path: "resources.image", reason: "媒体下载失败" }],
        },
      },
    ],
  });
  const partialItem = partialCommit.items[0];
  assert.ok(partialItem);
  assert.notEqual(partialItem.revisionId, firstItem.revisionId);
  const partialRead = await readArchiveItem(client, firstItem.itemId);
  assert.equal(partialRead.views[0]?.revisionId, partialItem.revisionId);
  assert.equal(partialRead.views[0]?.state.body?.text, "本次取得的正文");
  assert.equal(
    partialRead.views[0]?.state.metadata?.title,
    "本次只取得部分资料",
  );
  assert.equal(partialRead.views[0]?.state.capture.completeness, "partial");
  assert.deepEqual(partialRead.views[0]?.state.capture.missing, [
    { path: "resources.image", reason: "媒体下载失败" },
  ]);
  assert.equal(partialRead.views[0]?.state.resources, undefined);

  const replacementBytes = new TextEncoder().encode("binny media bytes v2");
  const replacementResponse = await upload(new Blob([replacementBytes]));
  if (replacementResponse.status !== 201) {
    throw new Error("补齐资源上传失败：" + (await replacementResponse.text()));
  }
  const replacement = await replacementResponse.json();
  const repairedCommit = await submitArchive(client, {
    requestId: "e2e:archive:resource-history:repaired",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-history" },
        metadata: { title: "补齐后的资料" },
        body: { markdown: "补齐后的正文" },
        resources: [{ resourceId: replacement.resourceId }],
        capture: {
          scope: { phase: "repaired" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const repairedItem = repairedCommit.items[0];
  assert.ok(repairedItem);
  const repairedRead = await readArchiveItem(client, firstItem.itemId);
  assert.equal(repairedRead.views[0]?.revisionId, repairedItem.revisionId);
  assert.equal(repairedRead.views[0]?.state.body?.markdown, "补齐后的正文");
  assert.deepEqual(repairedRead.views[0]?.state.resources, [
    { resourceId: replacement.resourceId },
  ]);
  assert.equal(repairedRead.revisions.length, 3);

  const historicRead = await client.archives.revisions[":revisionId"].$get({
    param: { revisionId: firstItem.revisionId },
  });
  if (historicRead.status !== 200) {
    throw new Error("读取历史资源版本失败：" + (await historicRead.text()));
  }
  const historicRevision = await historicRead.json();
  assert.equal(historicRevision.state.metadata?.title, "原始完整版本");
  assert.deepEqual(historicRevision.state.resources, [
    { resourceId: first.resourceId },
  ]);
  assert.equal(
    historicRevision.state.body?.markdown,
    `原文位置 binny://resource/${first.resourceId}；外链 https://example.test/image.png`,
  );

  return {
    resourceId: first.resourceId,
    repairedResourceId: replacement.resourceId,
    orphanResourceId: orphan.resourceId,
    resourceMarkerItemId,
    itemId: firstItem.itemId,
    revisionId: firstItem.revisionId,
  };
}

async function readArchiveTimeline(
  client: ArchiveClient,
  itemId: string,
  query: ArchiveTimelineQuery,
) {
  const response = await client.archives.items[":itemId"].timeline.$get({
    param: { itemId },
    query,
  });
  if (response.status !== 200) {
    throw new Error("读取观察时间线失败：" + (await response.text()));
  }
  return await response.json();
}

async function readArchiveCommit(client: ArchiveClient, commitId: string) {
  const response = await client.archives.commits[":commitId"].$get({
    param: { commitId },
  });
  if (response.status !== 200) {
    throw new Error("读取归档提交失败：" + (await response.text()));
  }
  return await response.json();
}

async function verifyArchiveAtomicity(client: ArchiveClient): Promise<void> {
  const baseline = await submitArchive(client, {
    requestId: "e2e:archive:atomic-baseline",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "atomic-baseline" },
        body: { text: "原子拒绝后的对象" },
        capture: {
          scope: { case: "atomic" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });

  const missingBinResponse = await client.archives.$post({
    json: {
      requestId: "e2e:archive:missing-bin",
      binId: "rss-missing",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "missing-bin" },
          body: { text: "不存在的 bin" },
          capture: {
            scope: { case: "missing-bin" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  if (missingBinResponse.status !== 404) {
    throw new Error(
      "不存在的 bin 应被拒绝：" + (await missingBinResponse.text()),
    );
  }
  assert.equal((await missingBinResponse.json()).error.code, "bin_not_found");

  const emptyFailureResponse = await client.archives.$post({
    json: {
      requestId: "e2e:archive:empty-failure",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "empty-failure" },
          sourceRef: "https://example.test/unfetched",
          capture: {
            scope: { case: "failed-fetch" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  if (emptyFailureResponse.status !== 400) {
    throw new Error(
      "只提供外部出处不能形成空内容版本：" +
        (await emptyFailureResponse.text()),
    );
  }
  const emptyFailureError = await emptyFailureResponse.json();
  assert.equal(emptyFailureError.error.code, "invalid_input");
  assert.deepEqual(emptyFailureError.error.path, ["items", 0, "body"]);

  const unsafeNumberResponse = await client.archives.$post({
    json: {
      requestId: "e2e:archive:unsafe-json-number",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "unsafe-json-number" },
          properties: { count: Number.MAX_SAFE_INTEGER + 1 },
          capture: {
            scope: { case: "invalid-json" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  if (unsafeNumberResponse.status !== 400) {
    throw new Error(
      "不精确 JSON 整数应被拒绝：" + (await unsafeNumberResponse.text()),
    );
  }
  const unsafeNumberError = await unsafeNumberResponse.json();
  assert.equal(unsafeNumberError.error.code, "invalid_input");
  assert.deepEqual(unsafeNumberError.error.path, [
    "items",
    0,
    "properties",
    "count",
  ]);

  const validAtomicItem = {
    sourceKey: { namespace: "e2e", key: "atomic-retry" },
    body: { text: "原子拒绝后的对象" },
    capture: {
      scope: { case: "atomic" },
      completeness: "complete" as const,
      missing: [],
    },
  };
  const invalidBatch = {
    requestId: "e2e:archive:atomic-invalid",
    binId: "rss-main",
    items: [
      validAtomicItem,
      {
        sourceKey: { namespace: "e2e" },
        body: { text: "无稳定对象键" },
        capture: {
          scope: { case: "atomic" },
          completeness: "complete" as const,
          missing: [],
        },
      },
    ],
  };
  const invalidBatchResponse = await client.archives.$post({
    // @ts-expect-error 服务端必须拒绝包含一个非法条目的整批提交。
    json: invalidBatch,
  });
  if (invalidBatchResponse.status !== 400) {
    throw new Error(
      "非法批次应被整批拒绝：" + (await invalidBatchResponse.text()),
    );
  }
  const invalidBatchError = await invalidBatchResponse.json();
  assert.equal(invalidBatchError.error.code, "invalid_input");
  assert.deepEqual(invalidBatchError.error.path, [
    "items",
    1,
    "sourceKey",
    "key",
  ]);

  const acceptedAtomic = await submitArchive(client, {
    requestId: "e2e:archive:atomic-retry",
    binId: "rss-main",
    items: [validAtomicItem],
  });
  assert.equal(
    BigInt(acceptedAtomic.archiveSeq),
    BigInt(baseline.archiveSeq) + 1n,
  );
  const atomicItemId = acceptedAtomic.items[0]?.itemId;
  assert.ok(atomicItemId);
  const atomicRead = await readArchiveItem(client, atomicItemId);
  assert.equal(atomicRead.observations.length, 1);
  assert.equal(atomicRead.views[0]?.state.sourceModifiedAt, undefined);

  const partialCommit = await submitArchive(client, {
    requestId: "e2e:archive:partial-capture",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "partial-capture" },
        body: { text: "已取得的正文" },
        capture: {
          scope: { section: "main" },
          completeness: "partial",
          missing: [{ path: "body.html", reason: "源站未提供 HTML 表示" }],
        },
      },
    ],
  });
  const partialItemId = partialCommit.items[0]?.itemId;
  assert.ok(partialItemId);
  const partialRead = await readArchiveItem(client, partialItemId);
  assert.equal(partialRead.views[0]?.state.capture.completeness, "partial");
  assert.equal(
    partialRead.views[0]?.state.capture.missing[0]?.path,
    "body.html",
  );
}

async function verifyArchiveIdempotency(client: ArchiveClient): Promise<void> {
  const retryItem = {
    sourceKey: { namespace: "e2e", key: "idempotent-retry" },
    body: { text: "同一请求重放" },
    capture: {
      scope: { case: "idempotency" },
      completeness: "complete" as const,
      missing: [],
    },
    diagnostics: [{ code: "first_observation", message: "第一次取得" }],
  };
  const retryRequest = {
    requestId: "e2e:archive:idempotent-retry",
    binId: "rss-main",
    items: [retryItem],
  };
  const firstRetryCommit = await submitArchive(client, retryRequest);
  const replayedCommit = await submitArchive(client, retryRequest);
  assert.equal(replayedCommit.commitId, firstRetryCommit.commitId);
  assert.equal(replayedCommit.archiveSeq, firstRetryCommit.archiveSeq);

  const conflictingRetry = {
    ...retryRequest,
    items: [
      {
        ...retryItem,
        body: { text: "相同请求标识的不同负载" },
      },
    ],
  };
  const conflictResponse = await client.archives.$post({
    json: conflictingRetry,
  });
  if (conflictResponse.status !== 409) {
    throw new Error(
      "同请求标识的不同负载应冲突：" + (await conflictResponse.text()),
    );
  }
  assert.equal(
    (await conflictResponse.json()).error.code,
    "archive_request_conflict",
  );

  const freshSameContent = await submitArchive(client, {
    ...retryRequest,
    requestId: "e2e:archive:idempotent-fresh",
  });
  assert.notEqual(freshSameContent.commitId, firstRetryCommit.commitId);
  assert.equal(
    freshSameContent.items[0]?.revisionId,
    firstRetryCommit.items[0]?.revisionId,
  );
  const retryItemId = firstRetryCommit.items[0]?.itemId;
  assert.ok(retryItemId);
  const retryRead = await readArchiveItem(client, retryItemId);
  assert.equal(retryRead.observations.length, 2);
  assert.equal(retryRead.revisions.length, 1);
}

async function verifyArchiveABA(
  client: ArchiveClient,
): Promise<
  Pick<
    ArchiveJourney,
    | "itemId"
    | "revisionId"
    | "commitId"
    | "historicalAsOf"
    | "replayRequest"
    | "replayCommitId"
    | "expectedObservationCount"
  >
> {
  const abaA = {
    sourceKey: { namespace: "e2e", key: "aba-item" },
    sourceRef: "https://example.test/aba-item",
    sourceModifiedAt: "2026-10-28T12:00:00+08:00",
    metadata: { title: "状态 A", authors: ["writer"] },
    properties: { counts: { replies: 2, stars: 4 }, tags: ["a", "b"] },
    body: { markdown: "正文 A", searchText: "正文 A" },
    capture: {
      scope: { source: "e2e", topic: "42" },
      completeness: "complete" as const,
      missing: [],
    },
  };
  const abaFirstRequest = {
    requestId: "e2e:archive:aba:first",
    binId: "rss-main",
    runId: "run-a1",
    collectorVersion: "rss@1.0.0",
    observedAt: "2026-10-28T04:01:00.000Z",
    items: [
      {
        ...abaA,
        diagnostics: [{ code: "partial_probe", message: "可选区块缺失" }],
      },
    ],
  };
  const abaFirst = await submitArchive(client, abaFirstRequest);
  const abaSecond = await submitArchive(client, {
    requestId: "e2e:archive:aba:second",
    binId: "rss-main",
    runId: "run-a2",
    collectorVersion: "rss@1.1.0",
    observedAt: "2026-10-28T04:01:00.000Z",
    items: [
      {
        ...abaA,
        sourceModifiedAt: "2026-10-28T04:01:00.000Z",
        metadata: { title: "状态 B", authors: ["writer"] },
        properties: { counts: { replies: 3, stars: 5 }, tags: ["a", "b"] },
        body: { markdown: "正文 B", searchText: "正文 B" },
        diagnostics: [{ code: "body_changed", message: "正文发生变化" }],
      },
    ],
  });
  const abaThird = await submitArchive(client, {
    requestId: "e2e:archive:aba:third",
    binId: "rss-main",
    runId: "run-a3",
    collectorVersion: "rss@2.0.0",
    observedAt: "2026-10-28T04:03:00.000Z",
    items: [
      {
        ...abaA,
        sourceModifiedAt: "2026-10-28T04:00:00.000Z",
        metadata: { authors: ["writer"], title: "状态 A" },
        properties: { tags: ["a", "b"], counts: { stars: 4, replies: 2 } },
        capture: {
          scope: { topic: "42", source: "e2e" },
          completeness: "complete" as const,
          missing: [],
        },
        diagnostics: [{ code: "partial_probe", message: "诊断已变化" }],
      },
    ],
  });
  const abaFirstItem = abaFirst.items[0];
  const abaSecondItem = abaSecond.items[0];
  const abaThirdItem = abaThird.items[0];
  assert.ok(abaFirstItem);
  assert.ok(abaSecondItem);
  assert.ok(abaThirdItem);
  assert.equal(abaFirstItem.itemId, abaThirdItem.itemId);
  assert.equal(abaFirstItem.revisionId, abaThirdItem.revisionId);
  assert.notEqual(abaFirstItem.revisionId, abaSecondItem.revisionId);

  const abaRead = await readArchiveItem(client, abaThirdItem.itemId);
  assert.equal(abaRead.revisions.length, 2);
  assert.equal(abaRead.observations.length, 3);
  assert.deepEqual(abaRead.snapshot, {
    asOf: abaThird.archiveSeq,
    mode: "current",
  });
  assert.deepEqual(
    abaRead.observations.map(({ revisionId }) => revisionId),
    [
      abaFirstItem.revisionId,
      abaSecondItem.revisionId,
      abaThirdItem.revisionId,
    ],
  );
  assert.equal(abaRead.views[0]?.state.body?.markdown, "正文 A");
  assert.equal(abaRead.views[0]?.diagnostics?.[0]?.message, "诊断已变化");
  assert.equal(abaRead.views[0]?.observedAt, "2026-10-28T04:03:00.000Z");

  const historicalViewResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: abaThirdItem.itemId },
    query: { binId: "rss-main", asOf: abaSecond.archiveSeq },
  });
  if (historicalViewResponse.status !== 200) {
    throw new Error(
      "按归档截点读取历史视图失败：" + (await historicalViewResponse.text()),
    );
  }
  const historicalView = await historicalViewResponse.json();
  assert.deepEqual(historicalView.snapshot, {
    asOf: abaSecond.archiveSeq,
    mode: "asOf",
  });
  assert.equal(historicalView.views[0]?.state.body?.markdown, "正文 B");
  assert.equal(historicalView.revisions.length, 2);
  assert.equal(historicalView.observations.length, 2);
  assert.equal(
    historicalView.observations[0]?.sourceModifiedAt,
    "2026-10-28T04:00:00.000Z",
  );
  assert.equal(
    historicalView.observations[0]?.observedAt,
    "2026-10-28T04:01:00.000Z",
  );
  assert.ok(historicalView.observations[0]?.recordedAt);

  const historicalTimeline = await readArchiveTimeline(
    client,
    abaThirdItem.itemId,
    { binId: "rss-main", asOf: abaSecond.archiveSeq, limit: "10" },
  );
  assert.deepEqual(historicalTimeline.snapshot, {
    asOf: abaSecond.archiveSeq,
    mode: "asOf",
  });
  assert.deepEqual(
    historicalTimeline.observations.map(({ revisionId }) => revisionId),
    [abaFirstItem.revisionId, abaSecondItem.revisionId],
  );
  assert.equal(historicalTimeline.observations[0]?.commitId, abaFirst.commitId);
  assert.equal(historicalTimeline.observations[0]?.binId, "rss-main");
  assert.equal(historicalTimeline.observations[0]?.runId, "run-a1");
  assert.equal(
    historicalTimeline.observations[0]?.collectorVersion,
    "rss@1.0.0",
  );
  assert.equal(
    historicalTimeline.observations[0]?.sourceModifiedAt,
    "2026-10-28T04:00:00.000Z",
  );
  assert.equal(
    historicalTimeline.observations[0]?.observedAt,
    "2026-10-28T04:01:00.000Z",
  );
  assert.equal(
    historicalTimeline.observations[1]?.observedAt,
    "2026-10-28T04:01:00.000Z",
  );

  const firstTimelinePage = await readArchiveTimeline(
    client,
    abaThirdItem.itemId,
    { binId: "rss-main", limit: "1" },
  );
  assert.equal(firstTimelinePage.snapshot.mode, "current");
  assert.equal(firstTimelinePage.snapshot.asOf, abaThird.archiveSeq);
  assert.equal(
    firstTimelinePage.observations[0]?.revisionId,
    abaFirstItem.revisionId,
  );
  assert.ok(firstTimelinePage.nextCursor);

  const [lateCommit, secondTimelinePage] = await Promise.all([
    submitArchive(client, {
      requestId: "e2e:archive:aba:late-repeat",
      binId: "rss-main",
      collectorVersion: "rss@2.1.0",
      observedAt: "2026-10-28T03:59:00.000Z",
      items: [abaA],
    }),
    readArchiveTimeline(client, abaThirdItem.itemId, {
      cursor: firstTimelinePage.nextCursor,
      limit: "1",
    }),
  ]);
  assert.deepEqual(secondTimelinePage.snapshot, {
    asOf: abaThird.archiveSeq,
    mode: "asOf",
  });
  assert.equal(
    secondTimelinePage.observations[0]?.revisionId,
    abaSecondItem.revisionId,
  );
  assert.ok(secondTimelinePage.nextCursor);

  const thirdTimelinePage = await readArchiveTimeline(
    client,
    abaThirdItem.itemId,
    { cursor: secondTimelinePage.nextCursor, limit: "1" },
  );
  assert.deepEqual(thirdTimelinePage.snapshot, secondTimelinePage.snapshot);
  assert.equal(
    thirdTimelinePage.observations[0]?.revisionId,
    abaThirdItem.revisionId,
  );
  assert.equal(thirdTimelinePage.nextCursor, undefined);

  const currentTimeline = await readArchiveTimeline(
    client,
    abaThirdItem.itemId,
    { binId: "rss-main", limit: "10" },
  );
  assert.deepEqual(
    currentTimeline.observations.map(({ archiveSeq }) => archiveSeq),
    [
      abaFirst.archiveSeq,
      abaSecond.archiveSeq,
      abaThird.archiveSeq,
      lateCommit.archiveSeq,
    ],
  );
  assert.equal(
    currentTimeline.observations[3]?.sourceModifiedAt,
    "2026-10-28T04:00:00.000Z",
  );
  assert.equal(
    currentTimeline.observations[3]?.observedAt,
    "2026-10-28T03:59:00.000Z",
  );
  assert.equal(lateCommit.items[0]?.revisionId, abaFirstItem.revisionId);
  const firstCommitRead = await readArchiveCommit(client, abaFirst.commitId);
  assert.equal(firstCommitRead.runId, "run-a1");
  assert.equal(firstCommitRead.collectorVersion, "rss@1.0.0");
  assert.equal(firstCommitRead.items[0]?.itemId, abaFirstItem.itemId);
  assert.equal(
    historicalTimeline.observations[0]?.recordedAt,
    firstCommitRead.recordedAt,
  );
  const lateCommitRead = await readArchiveCommit(client, lateCommit.commitId);
  assert.deepEqual(lateCommitRead, lateCommit);
  assert.equal(lateCommitRead.runId, undefined);
  assert.equal(lateCommitRead.collectorVersion, "rss@2.1.0");

  const currentAfterLateArrival = await readArchiveItem(
    client,
    abaThirdItem.itemId,
  );
  assert.equal(
    currentAfterLateArrival.views[0]?.archiveSeq,
    lateCommit.archiveSeq,
  );
  assert.equal(
    currentAfterLateArrival.views[0]?.observedAt,
    "2026-10-28T03:59:00.000Z",
  );
  assert.equal(currentAfterLateArrival.revisions.length, 2);
  assert.equal(currentAfterLateArrival.observations.length, 4);

  const abaRevisionResponse = await client.archives.revisions[
    ":revisionId"
  ].$get({
    param: { revisionId: abaThirdItem.revisionId },
  });
  if (abaRevisionResponse.status !== 200) {
    throw new Error("读取 A 版本失败：" + (await abaRevisionResponse.text()));
  }
  const abaRevision = await abaRevisionResponse.json();
  assert.equal(abaRevision.state.sourceModifiedAt, "2026-10-28T04:00:00.000Z");
  assert.equal(abaRevision.state.metadata?.title, "状态 A");
  assert.equal(abaRevision.state.body?.markdown, "正文 A");

  return {
    itemId: abaThirdItem.itemId,
    revisionId: abaThirdItem.revisionId,
    commitId: lateCommit.commitId,
    historicalAsOf: abaSecond.archiveSeq,
    replayRequest: abaFirstRequest,
    replayCommitId: abaFirst.commitId,
    expectedObservationCount: currentAfterLateArrival.observations.length,
  };
}

async function verifyConcurrentArchiveIdentity(
  client: ArchiveClient,
): Promise<void> {
  const concurrentSourceKey = {
    namespace: "e2e",
    key: "concurrent-cross-bin",
  };
  const [mainCommit, secondaryCommit] = await Promise.all([
    submitArchive(client, {
      requestId: "e2e:archive:cross-bin:main",
      binId: "rss-main",
      items: [
        {
          sourceKey: concurrentSourceKey,
          metadata: { view: "main" },
          body: { text: "main view" },
          capture: {
            scope: { case: "cross-bin" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    }),
    submitArchive(client, {
      requestId: "e2e:archive:cross-bin:secondary",
      binId: "rss-secondary",
      items: [
        {
          sourceKey: concurrentSourceKey,
          metadata: { view: "secondary" },
          body: { text: "secondary view" },
          capture: {
            scope: { case: "cross-bin" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    }),
  ]);
  const mainConcurrentItem = mainCommit.items[0];
  const secondaryConcurrentItem = secondaryCommit.items[0];
  assert.ok(mainConcurrentItem);
  assert.ok(secondaryConcurrentItem);
  assert.equal(mainConcurrentItem.itemId, secondaryConcurrentItem.itemId);
  assert.notEqual(
    mainConcurrentItem.revisionId,
    secondaryConcurrentItem.revisionId,
  );
  const concurrentRead = await readArchiveItem(
    client,
    mainConcurrentItem.itemId,
  );
  assert.deepEqual(concurrentRead.views.map(({ binId }) => binId).toSorted(), [
    "rss-main",
    "rss-secondary",
  ]);
  assert.equal(concurrentRead.observations.length, 2);
  assert.equal(
    concurrentRead.views.find(({ binId }) => binId === "rss-main")?.state.body
      ?.text,
    "main view",
  );
  assert.equal(
    concurrentRead.views.find(({ binId }) => binId === "rss-secondary")?.state
      .body?.text,
    "secondary view",
  );
  assert.equal(concurrentRead.revisions.length, 2);

  const selectedMain = await client.archives.items[":itemId"].$get({
    param: { itemId: mainConcurrentItem.itemId },
    query: { binId: "rss-main", asOf: mainCommit.archiveSeq },
  });
  assert.equal(selectedMain.status, 200);
  const selectedMainRead = await selectedMain.json();
  assert.equal(selectedMainRead.views.length, 1);
  assert.equal(selectedMainRead.views[0]?.binId, "rss-main");
  assert.equal(selectedMainRead.views[0]?.state.body?.text, "main view");
  assert.equal(selectedMainRead.observations.length, 1);
  assert.equal(selectedMainRead.revisions.length, 1);
}

async function verifyArchiveReadErrors(
  client: ArchiveClient,
  itemId: string,
): Promise<void> {
  const current = await readArchiveItem(client, itemId);
  const futureCut = (BigInt(current.snapshot.asOf) + 1n).toString();
  const futureCutResponse = await client.archives.items[":itemId"].$get({
    param: { itemId },
    query: { asOf: futureCut },
  });
  assert.equal(futureCutResponse.status, 400);
  assert.equal((await futureCutResponse.json()).error.code, "invalid_input");

  const beforeFirstCutResponse = await client.archives.items[":itemId"].$get({
    param: { itemId },
    query: { asOf: "0" },
  });
  assert.equal(beforeFirstCutResponse.status, 404);
  assert.equal(
    (await beforeFirstCutResponse.json()).error.code,
    "item_not_found",
  );

  const invalidCutResponse = await client.archives.items[":itemId"].$get({
    param: { itemId },
    query: { asOf: "not-a-sequence" },
  });
  assert.equal(invalidCutResponse.status, 400);
  assert.equal((await invalidCutResponse.json()).error.code, "invalid_input");

  const invalidCursorResponse = await client.archives.items[
    ":itemId"
  ].timeline.$get({
    param: { itemId },
    query: { cursor: "not-a-cursor" },
  });
  assert.equal(invalidCursorResponse.status, 400);
  assert.equal(
    (await invalidCursorResponse.json()).error.code,
    "invalid_input",
  );

  const invalidItemIdResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: "not-a-uuid" },
    query: {},
  });
  if (invalidItemIdResponse.status !== 400) {
    throw new Error(
      "格式错误的 itemId 应返回400：" + (await invalidItemIdResponse.text()),
    );
  }
  assert.equal(
    (await invalidItemIdResponse.json()).error.code,
    "invalid_input",
  );

  const absentItemResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: "850e8400-e29b-41d4-a716-446655440000" },
    query: {},
  });
  if (absentItemResponse.status !== 404) {
    throw new Error(
      "不存在的 item 应返回404：" + (await absentItemResponse.text()),
    );
  }
  assert.equal((await absentItemResponse.json()).error.code, "item_not_found");

  const absentRevisionResponse = await client.archives.revisions[
    ":revisionId"
  ].$get({
    param: { revisionId: "950e8400-e29b-41d4-a716-446655440000" },
  });
  if (absentRevisionResponse.status !== 404) {
    throw new Error(
      "不存在的 revision 应返回404：" + (await absentRevisionResponse.text()),
    );
  }
  assert.equal(
    (await absentRevisionResponse.json()).error.code,
    "revision_not_found",
  );

  const absentCommitResponse = await client.archives.commits[":commitId"].$get({
    param: { commitId: "750e8400-e29b-41d4-a716-446655440000" },
  });
  assert.equal(absentCommitResponse.status, 404);
  assert.equal(
    (await absentCommitResponse.json()).error.code,
    "commit_not_found",
  );
}

async function verifyArchiveJourney(baseUrl: string): Promise<ArchiveJourney> {
  const client = createApiClient(baseUrl);
  await verifyArchiveAtomicity(client);
  const resources = await verifyArchiveResourceHttp(client);
  await verifyArchiveIdempotency(client);
  const aba = await verifyArchiveABA(client);
  await verifyConcurrentArchiveIdentity(client);
  await verifyArchiveReadErrors(client, aba.itemId);
  return {
    ...aba,
    resourceItemId: resources.itemId,
    resourceRevisionId: resources.revisionId,
    resourceId: resources.resourceId,
    repairedResourceId: resources.repairedResourceId,
    orphanResourceId: resources.orphanResourceId,
    resourceMarkerItemId: resources.resourceMarkerItemId,
  };
}

async function verifyArchivePersistence(
  baseUrl: string,
  archive: ArchiveJourney,
  sdkResource: SdkResourceJourney,
) {
  const client = createApiClient(baseUrl);
  const replay = await submitArchive(client, archive.replayRequest);
  assert.equal(replay.commitId, archive.replayCommitId);
  const persistedArchive = await readArchiveItem(client, archive.itemId);
  assert.equal(
    persistedArchive.observations.length,
    archive.expectedObservationCount,
  );
  assert.deepEqual(
    persistedArchive.views.map(({ binId }) => binId),
    ["rss-main"],
  );
  assert.equal(persistedArchive.views[0]?.state.body?.markdown, "正文 A");

  const revisionResponse = await client.archives.revisions[":revisionId"].$get({
    param: { revisionId: archive.revisionId },
  });
  if (revisionResponse.status !== 200) {
    throw new Error(
      "移除 bin 后读取历史版本失败：" + (await revisionResponse.text()),
    );
  }
  const persistedRevision = await revisionResponse.json();
  assert.equal(persistedRevision.state.body?.markdown, "正文 A");

  const resourceItem = await readArchiveItem(client, archive.resourceItemId);
  assert.equal(resourceItem.views[0]?.state.capture.completeness, "complete");
  assert.equal(resourceItem.views[0]?.state.body?.markdown, "补齐后的正文");
  assert.deepEqual(resourceItem.views[0]?.state.resources, [
    { resourceId: archive.repairedResourceId },
  ]);
  assert.equal(resourceItem.revisions.length, 3);
  const oldResourceRevision = await client.archives.revisions[
    ":revisionId"
  ].$get({ param: { revisionId: archive.resourceRevisionId } });
  if (oldResourceRevision.status !== 200) {
    throw new Error(
      "重启后读取历史媒体版本失败：" + (await oldResourceRevision.text()),
    );
  }
  const historicalResource = await oldResourceRevision.json();
  assert.equal(
    historicalResource.state.body?.markdown,
    `原文位置 binny://resource/${archive.resourceId}；外链 https://example.test/image.png`,
  );
  assert.deepEqual(historicalResource.state.resources, [
    { resourceId: archive.resourceId },
  ]);

  const resourceMarkerItem = await readArchiveItem(
    client,
    archive.resourceMarkerItemId,
  );
  assert.equal(
    resourceMarkerItem.views[0]?.state.body?.text,
    `正文保留标记 binny://resource/${archive.orphanResourceId}`,
  );
  assert.equal(
    resourceMarkerItem.views[0]?.state.metadata?.note,
    `binny://resource/${archive.orphanResourceId}`,
  );
  assert.equal(resourceMarkerItem.views[0]?.state.resources, undefined);

  for (const [resourceId, expected] of [
    [archive.resourceId, "binny media bytes v1"],
    [archive.repairedResourceId, "binny media bytes v2"],
  ] as const) {
    const response = await client.resources[":resourceId"].$get({
      param: { resourceId },
    });
    if (response.status !== 200) {
      throw new Error("重启后读取归档资源失败：" + (await response.text()));
    }
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      new TextEncoder().encode(expected),
    );
  }

  const orphanResponse = await client.resources[":resourceId"].$get({
    param: { resourceId: archive.orphanResourceId },
  });
  assert.equal(orphanResponse.status, 404);
  if (orphanResponse.status === 404) {
    assert.equal(
      (await orphanResponse.json()).error.code,
      "resource_not_found",
    );
  }

  const sdkItem = await readArchiveItem(client, sdkResource.itemId);
  assert.equal(sdkItem.views[0]?.revisionId, sdkResource.revisionId);
  assert.deepEqual(sdkItem.views[0]?.state.resources, [
    { resourceId: sdkResource.resourceId },
  ]);
  const sdkResourceResponse = await client.resources[":resourceId"].$get({
    param: { resourceId: sdkResource.resourceId },
  });
  if (sdkResourceResponse.status !== 200) {
    throw new Error(
      "SDK 媒体重启后不可读取：" + (await sdkResourceResponse.text()),
    );
  }
  const sdkBytes = new TextEncoder().encode("collector sdk image v1");
  assert.deepEqual(
    new Uint8Array(await sdkResourceResponse.arrayBuffer()),
    sdkBytes,
  );
  const sdkResourceMetadata = {
    resourceId: sdkResource.resourceId,
    mediaType: sdkResourceResponse.headers.get("content-type"),
    size: Number(sdkResourceResponse.headers.get("content-length")),
    sha256: sdkResourceResponse.headers.get("etag")?.replaceAll('"', ""),
  };

  const historicalResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: archive.itemId },
    query: { binId: "rss-main", asOf: archive.historicalAsOf },
  });
  if (historicalResponse.status !== 200) {
    throw new Error(
      "重启后按归档截点读取失败：" + (await historicalResponse.text()),
    );
  }
  const historicalItem = await historicalResponse.json();
  assert.equal(historicalItem.views[0]?.state.body?.markdown, "正文 B");

  const firstTimelinePage = await readArchiveTimeline(client, archive.itemId, {
    binId: "rss-main",
    limit: "1",
  });
  assert.ok(firstTimelinePage.nextCursor);
  const secondTimelinePage = await readArchiveTimeline(client, archive.itemId, {
    cursor: firstTimelinePage.nextCursor,
    limit: "1",
  });
  const commit = await readArchiveCommit(client, archive.commitId);
  return {
    item: persistedArchive,
    historicalItem,
    revision: persistedRevision,
    resourceItem,
    resourceMarkerItem,
    resourceRevision: historicalResource,
    sdkItem,
    sdkResourceMetadata,
    firstTimelinePage,
    secondTimelinePage,
    commit,
  };
}

async function main(): Promise<void> {
  const [stage, baseUrl] = process.argv.slice(2);
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("归档 HTTP 验收需要 base URL。");
  }
  if (stage === "submit") {
    const archive = await verifyArchiveJourney(baseUrl);
    process.stdout.write(JSON.stringify(archive));
    return;
  }
  if (stage === "after-restart") {
    const rawState = process.env.BINNY_E2E_ARCHIVE_STATE;
    if (rawState === undefined) {
      throw new Error("重启后归档验收缺少前置状态。");
    }
    const archive = archiveJourneySchema.parse(JSON.parse(rawState) as unknown);
    const rawSdkState = process.env.BINNY_E2E_SDK_RESOURCE_STATE;
    if (rawSdkState === undefined) {
      throw new Error("重启后归档验收缺少 SDK 资源前置状态。");
    }
    const sdkResource = sdkResourceJourneySchema.parse(
      JSON.parse(rawSdkState) as unknown,
    );
    const persisted = await verifyArchivePersistence(
      baseUrl,
      archive,
      sdkResource,
    );
    process.stdout.write(JSON.stringify(persisted));
    return;
  }
  throw new Error("未知归档 HTTP 验收阶段。");
}

await main();
