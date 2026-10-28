import assert from "node:assert/strict";

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
type ArchiveRelationQuery = Parameters<
  ArchiveClient["archives"]["items"][":itemId"]["relations"]["$get"]
>[0]["query"];
type ArchiveSubmission = Parameters<
  ArchiveClient["archives"]["$post"]
>[0]["json"];
type ArchiveJourney = {
  readonly itemId: string;
  readonly relationItemId: string;
  readonly revisionId: string;
  readonly commitId: string;
  readonly historicalAsOf: string;
  readonly relationAsOf: string;
  readonly replayRequest: ArchiveSubmission;
  readonly replayCommitId: string;
  readonly expectedObservationCount: number;
};

const archiveJourneySchema = z.object({
  itemId: archiveIdentifierSchema,
  relationItemId: archiveIdentifierSchema,
  revisionId: archiveIdentifierSchema,
  commitId: archiveIdentifierSchema,
  historicalAsOf: archiveSnapshotSequenceSchema,
  relationAsOf: archiveSnapshotSequenceSchema,
  replayRequest: archiveSubmissionInputSchema,
  replayCommitId: archiveIdentifierSchema,
  expectedObservationCount: z.number().int().nonnegative(),
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

async function readArchiveRelations(
  client: ArchiveClient,
  itemId: string,
  query: ArchiveRelationQuery,
) {
  const response = await client.archives.items[":itemId"].relations.$get({
    param: { itemId },
    query,
  });
  if (response.status !== 200) {
    throw new Error("读取对象关系失败：" + (await response.text()));
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

async function verifyArchiveRelations(
  client: ArchiveClient,
): Promise<{ readonly relationItemId: string; readonly relationAsOf: string }> {
  const from = { namespace: "e2e-relations", key: "same-batch-from" };
  const to = { namespace: "e2e-relations", key: "same-batch-to" };
  const foreignTarget = {
    namespace: "e2e-relations",
    key: "other-bin-target",
  };
  const foreignTargetCommit = await submitArchive(client, {
    requestId: "e2e:archive:relation:foreign-target",
    binId: "rss-secondary",
    items: [
      {
        sourceKey: foreignTarget,
        body: { text: "只在另一个 bin 取得的目标" },
        capture: {
          scope: { case: "relation" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const foreignTargetItem = foreignTargetCommit.items[0];
  assert.ok(foreignTargetItem);

  const firstState = {
    from,
    to: { sourceKey: to },
    name: "reply",
    properties: { position: 1 },
    cascade: true,
  };
  const secondState = {
    from,
    to: { sourceKey: to },
    name: "reply",
    properties: { position: 2 },
    cascade: false,
  };
  const firstCommit = await submitArchive(client, {
    requestId: "e2e:archive:relation:same-batch",
    binId: "rss-main",
    observedAt: "2026-10-28T04:20:00.000Z",
    items: [
      {
        sourceKey: from,
        body: { text: "关系来源资料" },
        capture: {
          scope: { case: "relation" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: to,
        body: { text: "同批关系目标" },
        capture: {
          scope: { case: "relation" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
    relations: [
      { relationId: "e2e:relation:01-forward", value: firstState },
      {
        relationId: "e2e:relation:02-external",
        value: {
          from,
          to: { sourceRef: "https://example.test/external-target" },
          name: "cites",
          properties: {
            label: "external",
            sourceRef: "https://example.test/external-target",
          },
          cascade: false,
        },
      },
      {
        relationId: "e2e:relation:03-unknown-target",
        value: {
          from,
          to: { sourceKey: foreignTarget },
          name: "mentions",
          properties: { label: "cross-bin" },
          cascade: false,
        },
      },
      {
        relationId: "e2e:relation:04-loop-reverse",
        value: {
          from: to,
          to: { sourceKey: from },
          name: "loop",
          properties: {},
          cascade: false,
        },
      },
    ],
  });
  const fromItem = firstCommit.items[0];
  const toItem = firstCommit.items[1];
  assert.ok(fromItem);
  assert.ok(toItem);
  assert.equal(firstCommit.relations.length, 4);
  assert.deepEqual(
    firstCommit.relations.map(({ ordinal }) => ordinal),
    [2, 3, 4, 5],
  );

  const firstOutgoingPage = await readArchiveRelations(
    client,
    fromItem.itemId,
    { direction: "outgoing", binId: "rss-main", limit: "2" },
  );
  assert.deepEqual(firstOutgoingPage.snapshot, {
    asOf: firstCommit.archiveSeq,
    mode: "current",
  });
  assert.deepEqual(
    firstOutgoingPage.relations.map(({ relationId }) => relationId),
    ["e2e:relation:01-forward", "e2e:relation:02-external"],
  );
  assert.ok(firstOutgoingPage.nextCursor);
  const firstForward = firstOutgoingPage.relations[0];
  assert.equal(firstForward?.status, "observed");
  if (firstForward?.status === "observed" && firstForward.to.kind === "item") {
    assert.equal(firstForward.to.itemId, toItem.itemId);
    assert.equal(firstForward.to.status, "observed");
  }
  const externalTarget = firstOutgoingPage.relations[1]?.to;
  assert.equal(externalTarget?.kind, "sourceRef");
  if (externalTarget?.kind === "sourceRef") {
    assert.equal(
      externalTarget.sourceRef,
      "https://example.test/external-target",
    );
  }
  const externalRelation = firstOutgoingPage.relations[1];
  assert.equal(externalRelation?.status, "observed");
  if (externalRelation?.status === "observed") {
    assert.equal(
      externalRelation.state.properties?.sourceRef,
      "https://example.test/external-target",
    );
  }

  const lateRelationCommit = await submitArchive(client, {
    requestId: "e2e:archive:relation:late-page-edge",
    binId: "rss-main",
    observedAt: "2026-10-28T03:59:00.000Z",
    items: [],
    relations: [
      {
        relationId: "e2e:relation:05-late",
        value: {
          from,
          to: { sourceKey: foreignTarget },
          name: "related",
          properties: { arrived: "after-first-page" },
          cascade: false,
        },
      },
    ],
  });
  const secondOutgoingPage = await readArchiveRelations(
    client,
    fromItem.itemId,
    {
      direction: "outgoing",
      binId: "rss-main",
      cursor: firstOutgoingPage.nextCursor,
      limit: "2",
    },
  );
  assert.deepEqual(secondOutgoingPage.snapshot, {
    asOf: firstCommit.archiveSeq,
    mode: "asOf",
  });
  assert.deepEqual(
    secondOutgoingPage.relations.map(({ relationId }) => relationId),
    ["e2e:relation:03-unknown-target"],
  );
  assert.equal(secondOutgoingPage.nextCursor, undefined);
  const unknownTarget = secondOutgoingPage.relations[0];
  assert.equal(unknownTarget?.status, "observed");
  if (
    unknownTarget?.status === "observed" &&
    unknownTarget.to.kind === "item"
  ) {
    assert.equal(unknownTarget.to.itemId, foreignTargetItem.itemId);
    assert.equal(unknownTarget.to.status, "unknown");
  }
  const currentOutgoingPage = await readArchiveRelations(
    client,
    fromItem.itemId,
    { direction: "outgoing", binId: "rss-main", limit: "10" },
  );
  assert.ok(
    currentOutgoingPage.relations.some(
      ({ relationId }) => relationId === "e2e:relation:05-late",
    ),
  );
  assert.equal(
    BigInt(lateRelationCommit.archiveSeq),
    BigInt(firstCommit.archiveSeq) + 1n,
  );
  assert.equal(lateRelationCommit.observedAt, "2026-10-28T03:59:00.000Z");
  const lateRelation = currentOutgoingPage.relations.find(
    ({ relationId }) => relationId === "e2e:relation:05-late",
  );
  assert.equal(lateRelation?.status, "observed");
  if (lateRelation?.status === "observed") {
    assert.equal(
      lateRelation.observation.archiveSeq,
      lateRelationCommit.archiveSeq,
    );
    assert.equal(
      lateRelation.observation.observedAt,
      lateRelationCommit.observedAt,
    );
    assert.equal(
      lateRelation.observation.recordedAt,
      lateRelationCommit.recordedAt,
    );
  }

  const incomingLoop = await readArchiveRelations(client, fromItem.itemId, {
    direction: "incoming",
    binId: "rss-main",
    asOf: firstCommit.archiveSeq,
    limit: "10",
  });
  assert.deepEqual(
    incomingLoop.relations.map(({ relationId }) => relationId),
    ["e2e:relation:04-loop-reverse"],
  );
  assert.equal(incomingLoop.relations[0]?.from.itemId, toItem.itemId);

  const relationOnlyCommit = await submitArchive(client, {
    requestId: "e2e:archive:relation:only-update",
    binId: "rss-main",
    observedAt: "2026-10-28T04:20:00.000Z",
    items: [],
    relations: [{ relationId: "e2e:relation:01-forward", value: secondState }],
  });
  assert.equal(relationOnlyCommit.items.length, 0);
  assert.equal(relationOnlyCommit.relations[0]?.status, "observed");
  assert.ok(relationOnlyCommit.relations[0]?.ordinal === 0);
  const afterRelationOnly = await readArchiveItem(client, fromItem.itemId);
  assert.equal(afterRelationOnly.views[0]?.revisionId, fromItem.revisionId);
  assert.equal(afterRelationOnly.revisions.length, 1);
  assert.equal(afterRelationOnly.observations.length, 1);

  const noRelationChangeCommit = await submitArchive(client, {
    requestId: "e2e:archive:relation:omission-does-not-withdraw",
    binId: "rss-main",
    items: [
      {
        sourceKey: from,
        body: { text: "关系来源资料" },
        capture: {
          scope: { case: "relation" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  assert.equal(noRelationChangeCommit.relations.length, 0);
  const relationAfterOmission = await readArchiveRelations(
    client,
    fromItem.itemId,
    { direction: "outgoing", binId: "rss-main", limit: "10" },
  );
  const stillActive = relationAfterOmission.relations.find(
    ({ relationId }) => relationId === "e2e:relation:01-forward",
  );
  assert.equal(stillActive?.status, "observed");
  if (stillActive?.status === "observed") {
    assert.equal(stillActive.state.properties?.position, 2);
    assert.equal(stillActive.state.cascade, false);
  }
  assert.equal(
    noRelationChangeCommit.items[0]?.revisionId,
    fromItem.revisionId,
  );

  const historicalRelations = await readArchiveRelations(
    client,
    fromItem.itemId,
    {
      direction: "outgoing",
      binId: "rss-main",
      asOf: firstCommit.archiveSeq,
      limit: "10",
    },
  );
  const historicalForward = historicalRelations.relations.find(
    ({ relationId }) => relationId === "e2e:relation:01-forward",
  );
  assert.equal(historicalForward?.status, "observed");
  if (historicalForward?.status === "observed") {
    assert.equal(historicalForward.state.properties?.position, 1);
    assert.equal(historicalForward.state.cascade, true);
  }

  const secondaryObservation = await submitArchive(client, {
    requestId: "e2e:archive:relation:secondary-observation",
    binId: "rss-secondary",
    items: [],
    relations: [{ relationId: "e2e:relation:01-forward", value: secondState }],
  });
  assert.equal(secondaryObservation.items.length, 0);
  const secondaryRelations = await readArchiveRelations(
    client,
    fromItem.itemId,
    { direction: "outgoing", binId: "rss-secondary", limit: "10" },
  );
  const secondaryForward = secondaryRelations.relations.find(
    ({ relationId }) => relationId === "e2e:relation:01-forward",
  );
  assert.equal(secondaryForward?.status, "observed");
  if (secondaryForward?.status === "observed") {
    assert.equal(secondaryForward.from.status, "unknown");
    assert.equal(secondaryForward.to.kind, "item");
    if (secondaryForward.to.kind === "item") {
      assert.equal(secondaryForward.to.status, "unknown");
    }
  }
  const unknownRelationInSecondary = secondaryRelations.relations.find(
    ({ relationId }) => relationId === "e2e:relation:03-unknown-target",
  );
  assert.equal(unknownRelationInSecondary?.status, "unknown");
  if (unknownRelationInSecondary?.status === "unknown") {
    assert.equal(unknownRelationInSecondary.to.kind, "item");
    if (unknownRelationInSecondary.to.kind === "item") {
      assert.equal(unknownRelationInSecondary.to.status, "observed");
    }
  }

  const [concurrentMain, concurrentSecondary] = await Promise.all([
    submitArchive(client, {
      requestId: "e2e:archive:relation:concurrent-main",
      binId: "rss-main",
      items: [],
      relations: [
        {
          relationId: "e2e:relation:06-concurrent",
          value: {
            from,
            to: { sourceKey: to },
            name: "concurrent",
            properties: { bin: "main" },
            cascade: false,
          },
        },
      ],
    }),
    submitArchive(client, {
      requestId: "e2e:archive:relation:concurrent-secondary",
      binId: "rss-secondary",
      items: [],
      relations: [
        {
          relationId: "e2e:relation:06-concurrent",
          value: {
            from,
            to: { sourceKey: to },
            name: "concurrent",
            properties: { bin: "secondary" },
            cascade: false,
          },
        },
      ],
    }),
  ]);
  assert.equal(concurrentMain.items.length, 0);
  assert.equal(concurrentSecondary.items.length, 0);
  const concurrentSequences = [
    BigInt(concurrentMain.archiveSeq),
    BigInt(concurrentSecondary.archiveSeq),
  ].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert.equal(concurrentSequences[1]! - concurrentSequences[0]!, 1n);
  const [mainRelationsAfterConcurrent, secondaryRelationsAfterConcurrent] =
    await Promise.all([
      readArchiveRelations(client, fromItem.itemId, {
        direction: "outgoing",
        binId: "rss-main",
        limit: "100",
      }),
      readArchiveRelations(client, fromItem.itemId, {
        direction: "outgoing",
        binId: "rss-secondary",
        limit: "100",
      }),
    ]);
  const mainConcurrentRelation = mainRelationsAfterConcurrent.relations.find(
    ({ relationId }) => relationId === "e2e:relation:06-concurrent",
  );
  const secondaryConcurrentRelation =
    secondaryRelationsAfterConcurrent.relations.find(
      ({ relationId }) => relationId === "e2e:relation:06-concurrent",
    );
  assert.equal(mainConcurrentRelation?.status, "observed");
  assert.equal(secondaryConcurrentRelation?.status, "observed");
  if (
    mainConcurrentRelation?.status === "observed" &&
    secondaryConcurrentRelation?.status === "observed"
  ) {
    assert.equal(mainConcurrentRelation.state.properties?.bin, "main");
    assert.equal(
      secondaryConcurrentRelation.state.properties?.bin,
      "secondary",
    );
  }

  const withdrawalCommit = await submitArchive(client, {
    requestId: "e2e:archive:relation:withdraw-main",
    binId: "rss-main",
    items: [],
    relations: [{ relationId: "e2e:relation:01-forward", value: null }],
  });
  assert.equal(withdrawalCommit.relations[0]?.status, "withdrawn");
  assert.equal(withdrawalCommit.items.length, 0);
  const afterWithdrawal = await readArchiveRelations(client, fromItem.itemId, {
    direction: "outgoing",
    binId: "rss-main",
    limit: "10",
  });
  assert.equal(
    afterWithdrawal.relations.find(
      ({ relationId }) => relationId === "e2e:relation:01-forward",
    )?.status,
    "withdrawn",
  );
  const afterOtherBinWithdrawal = await readArchiveRelations(
    client,
    fromItem.itemId,
    { direction: "outgoing", binId: "rss-secondary", limit: "10" },
  );
  assert.equal(
    afterOtherBinWithdrawal.relations.find(
      ({ relationId }) => relationId === "e2e:relation:01-forward",
    )?.status,
    "observed",
  );

  const changedEndpoint = await client.archives.$post({
    json: {
      requestId: "e2e:archive:relation:changed-endpoint",
      binId: "rss-main",
      items: [],
      relations: [
        {
          relationId: "e2e:relation:01-forward",
          value: {
            from,
            to: { sourceKey: foreignTarget },
            name: "reply",
            cascade: false,
          },
        },
      ],
    },
  });
  assert.equal(changedEndpoint.status, 409);
  if (changedEndpoint.status === 409) {
    assert.equal(
      (await changedEndpoint.json()).error.code,
      "relation_endpoint_conflict",
    );
  }

  const beforeInvalidBatch = await readArchiveItem(client, fromItem.itemId);
  const invalidRelationBatch = await client.archives.$post({
    json: {
      requestId: "e2e:archive:relation:atomic-invalid",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e-relations", key: "atomic-from" },
          body: { text: "拒绝整批时不能留下" },
          capture: {
            scope: { case: "relation-atomic" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
      relations: [
        {
          relationId: "e2e:relation:atomic-invalid",
          value: {
            from: { namespace: "e2e-relations", key: "atomic-from" },
            to: {
              sourceKey: {
                namespace: "e2e-relations",
                key: "not-archived",
              },
            },
            name: "invalid",
            cascade: false,
          },
        },
      ],
    },
  });
  assert.equal(invalidRelationBatch.status, 400);
  if (invalidRelationBatch.status === 400) {
    const error = await invalidRelationBatch.json();
    assert.equal(error.error.code, "invalid_input");
    assert.deepEqual(error.error.path, [
      "relations",
      0,
      "value",
      "to",
      "sourceKey",
    ]);
  }
  const validRetryAfterRejection = await submitArchive(client, {
    requestId: "e2e:archive:relation:atomic-invalid",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e-relations", key: "atomic-from" },
        body: { text: "拒绝整批时不能留下" },
        capture: {
          scope: { case: "relation-atomic" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  assert.equal(
    BigInt(validRetryAfterRejection.archiveSeq),
    BigInt(beforeInvalidBatch.snapshot.asOf) + 1n,
  );
  const rejectedRelationRead = await readArchiveRelations(
    client,
    validRetryAfterRejection.items[0]!.itemId,
    { direction: "outgoing", binId: "rss-main", limit: "10" },
  );
  assert.deepEqual(rejectedRelationRead.relations, []);

  const timeline = await readArchiveTimeline(client, fromItem.itemId, {
    binId: "rss-main",
    limit: "100",
  });
  const initialEvents = timeline.events.filter(
    (event) => event.archiveSeq === firstCommit.archiveSeq,
  );
  assert.deepEqual(
    initialEvents.map((event) => event.kind),
    ["item", "relation", "relation", "relation", "relation"],
  );
  assert.deepEqual(
    initialEvents.map((event) => event.ordinal),
    [0, 2, 3, 4, 5],
  );
  const forwardHistory = timeline.events.filter(
    (event) =>
      event.kind === "relation" &&
      event.relationId === "e2e:relation:01-forward",
  );
  assert.equal(forwardHistory[0]?.kind, "relation");
  assert.equal(forwardHistory[1]?.kind, "relation");
  if (
    forwardHistory[0]?.kind === "relation" &&
    forwardHistory[1]?.kind === "relation"
  ) {
    assert.equal(forwardHistory[0].observedAt, "2026-10-28T04:20:00.000Z");
    assert.equal(forwardHistory[1].observedAt, "2026-10-28T04:20:00.000Z");
    assert.ok(
      BigInt(forwardHistory[0].archiveSeq) <
        BigInt(forwardHistory[1].archiveSeq),
    );
    assert.equal(forwardHistory[1].archiveSeq, relationOnlyCommit.archiveSeq);
  }
  assert.deepEqual(
    timeline.events.map(
      ({ archiveSeq, ordinal }) => [archiveSeq, ordinal] as const,
    ),
    timeline.events
      .map(({ archiveSeq, ordinal }) => [archiveSeq, ordinal] as const)
      .toSorted((left, right) =>
        BigInt(left[0]!) === BigInt(right[0]!)
          ? left[1]! - right[1]!
          : BigInt(left[0]!) < BigInt(right[0]!)
            ? -1
            : 1,
      ),
  );
  const commitRead = await readArchiveCommit(
    client,
    relationOnlyCommit.commitId,
  );
  assert.equal(commitRead.items.length, 0);
  assert.equal(commitRead.relations[0]?.status, "observed");
  assert.equal(commitRead.relations[0]?.ordinal, 0);

  return {
    relationItemId: fromItem.itemId,
    relationAsOf: relationOnlyCommit.archiveSeq,
  };
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
  const replayedWithExplicitEmptyRelations = await submitArchive(client, {
    ...retryRequest,
    relations: [],
  });
  assert.equal(
    replayedWithExplicitEmptyRelations.commitId,
    firstRetryCommit.commitId,
  );

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
): Promise<Omit<ArchiveJourney, "relationItemId" | "relationAsOf">> {
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
    historicalTimeline.events
      .filter((event) => event.kind === "item")
      .map(({ revisionId }) => revisionId),
    [abaFirstItem.revisionId, abaSecondItem.revisionId],
  );
  const firstHistoricalItemEvent = historicalTimeline.events.find(
    (event) => event.kind === "item",
  );
  assert.ok(firstHistoricalItemEvent);
  if (firstHistoricalItemEvent?.kind === "item") {
    assert.equal(firstHistoricalItemEvent.commitId, abaFirst.commitId);
    assert.equal(firstHistoricalItemEvent.binId, "rss-main");
    assert.equal(firstHistoricalItemEvent.runId, "run-a1");
  }
  assert.equal(
    firstHistoricalItemEvent?.kind === "item"
      ? firstHistoricalItemEvent.collectorVersion
      : undefined,
    "rss@1.0.0",
  );
  assert.equal(
    firstHistoricalItemEvent?.kind === "item"
      ? firstHistoricalItemEvent.sourceModifiedAt
      : undefined,
    "2026-10-28T04:00:00.000Z",
  );
  assert.equal(
    firstHistoricalItemEvent?.kind === "item"
      ? firstHistoricalItemEvent.observedAt
      : undefined,
    "2026-10-28T04:01:00.000Z",
  );
  assert.equal(
    historicalTimeline.events.filter((event) => event.kind === "item")[1]
      ?.observedAt,
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
    firstTimelinePage.events[0]?.kind === "item"
      ? firstTimelinePage.events[0].revisionId
      : undefined,
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
    secondTimelinePage.events[0]?.kind === "item"
      ? secondTimelinePage.events[0].revisionId
      : undefined,
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
    thirdTimelinePage.events[0]?.kind === "item"
      ? thirdTimelinePage.events[0].revisionId
      : undefined,
    abaThirdItem.revisionId,
  );
  assert.equal(thirdTimelinePage.nextCursor, undefined);

  const currentTimeline = await readArchiveTimeline(
    client,
    abaThirdItem.itemId,
    { binId: "rss-main", limit: "10" },
  );
  assert.deepEqual(
    currentTimeline.events
      .filter((event) => event.kind === "item")
      .map(({ archiveSeq }) => archiveSeq),
    [
      abaFirst.archiveSeq,
      abaSecond.archiveSeq,
      abaThird.archiveSeq,
      lateCommit.archiveSeq,
    ],
  );
  assert.equal(
    currentTimeline.events.filter((event) => event.kind === "item")[3]
      ?.sourceModifiedAt,
    "2026-10-28T04:00:00.000Z",
  );
  assert.equal(
    currentTimeline.events.filter((event) => event.kind === "item")[3]
      ?.observedAt,
    "2026-10-28T03:59:00.000Z",
  );
  assert.equal(lateCommit.items[0]?.revisionId, abaFirstItem.revisionId);
  const firstCommitRead = await readArchiveCommit(client, abaFirst.commitId);
  assert.equal(firstCommitRead.runId, "run-a1");
  assert.equal(firstCommitRead.collectorVersion, "rss@1.0.0");
  assert.equal(firstCommitRead.items[0]?.itemId, abaFirstItem.itemId);
  assert.equal(
    firstHistoricalItemEvent?.kind === "item"
      ? firstHistoricalItemEvent.recordedAt
      : undefined,
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
  const relations = await verifyArchiveRelations(client);
  await verifyArchiveIdempotency(client);
  const aba = await verifyArchiveABA(client);
  await verifyConcurrentArchiveIdentity(client);
  await verifyArchiveReadErrors(client, aba.itemId);
  return { ...aba, ...relations };
}

async function verifyArchivePersistence(
  baseUrl: string,
  archive: ArchiveJourney,
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
  const relationPage = await readArchiveRelations(
    client,
    archive.relationItemId,
    {
      direction: "outgoing",
      binId: "rss-main",
      asOf: archive.relationAsOf,
      limit: "10",
    },
  );
  return {
    item: persistedArchive,
    historicalItem,
    revision: persistedRevision,
    firstTimelinePage,
    secondTimelinePage,
    commit,
    relationPage,
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
    const persisted = await verifyArchivePersistence(baseUrl, archive);
    process.stdout.write(JSON.stringify(persisted));
    return;
  }
  throw new Error("未知归档 HTTP 验收阶段。");
}

await main();
