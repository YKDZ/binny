import assert from "node:assert/strict";

import { createApiClient } from "@binny/api/client";
import {
  archiveErrorSchema,
  archiveIdentifierSchema,
  archiveSubmissionInputSchema,
} from "@binny/contracts";
import * as z from "zod";

type ArchiveClient = ReturnType<typeof createApiClient>;
type ArchiveSubmission = Parameters<
  ArchiveClient["archives"]["$post"]
>[0]["json"];
type BinCreateRequest = Parameters<ArchiveClient["bins"]["$post"]>[0]["json"];
type ArchiveJourney = {
  readonly itemId: string;
  readonly revisionId: string;
  readonly replayRequest: ArchiveSubmission;
  readonly replayCommitId: string;
  readonly expectedObservationCount: number;
};

const archiveJourneySchema = z.object({
  itemId: archiveIdentifierSchema,
  revisionId: archiveIdentifierSchema,
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
  });
  if (response.status !== 200) {
    throw new Error("读取归档条目失败：" + (await response.text()));
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

async function verifyArchivePrototypeKeys(
  client: ArchiveClient,
): Promise<void> {
  const metadata = Object.fromEntries([
    ["__proto__", { title: "自有元信息键" }],
  ] as const);
  const properties = Object.fromEntries([
    ["__proto__", { title: "自有属性键" }],
    [
      "nested",
      Object.fromEntries([["__proto__", { title: "嵌套自有键" }]] as const),
    ],
  ] as const);
  const scope = Object.fromEntries([
    ["__proto__", { title: "自有范围键" }],
  ] as const);
  const details = Object.fromEntries([
    ["__proto__", { title: "自有诊断键" }],
  ] as const);
  const state = {
    sourceKey: { namespace: "e2e", key: "prototype-json" },
    metadata,
    properties,
    body: { text: "保留自有 JSON 键" },
    capture: {
      scope,
      completeness: "complete" as const,
      missing: [],
    },
    diagnostics: [
      { code: "prototype_json", message: "保留诊断 JSON 键", details },
    ],
  };
  const firstRequest = {
    requestId: "e2e:archive:prototype-json:first",
    binId: "rss-main",
    items: [state],
  };
  const first = await submitArchive(client, firstRequest);
  const itemId = first.items[0]?.itemId;
  const revisionId = first.items[0]?.revisionId;
  assert.ok(itemId);
  assert.ok(revisionId);

  const persisted = await readArchiveItem(client, itemId);
  assert.deepEqual(persisted.views[0]?.state.metadata, metadata);
  assert.deepEqual(persisted.views[0]?.state.properties, properties);
  assert.deepEqual(persisted.views[0]?.state.capture.scope, scope);
  assert.deepEqual(persisted.views[0]?.diagnostics?.[0]?.details, details);

  const freshSameState = await submitArchive(client, {
    ...firstRequest,
    requestId: "e2e:archive:prototype-json:same-state",
  });
  assert.equal(freshSameState.items[0]?.revisionId, revisionId);
  const observedAgain = await readArchiveItem(client, itemId);
  assert.equal(observedAgain.observations.length, 2);
  assert.equal(observedAgain.revisions.length, 1);

  const firstConflictRequest = {
    requestId: "e2e:archive:prototype-json:conflict",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "prototype-json-conflict" },
        properties: Object.fromEntries([["__proto__", { value: 1 }]] as const),
        body: { text: "幂等键冲突负例" },
        capture: {
          scope: { case: "prototype-conflict" },
          completeness: "complete" as const,
          missing: [],
        },
      },
    ],
  };
  await submitArchive(client, firstConflictRequest);
  const firstConflictItem = firstConflictRequest.items[0];
  assert.ok(firstConflictItem);
  const changedOwnKey = Object.fromEntries([
    ["__proto__", { value: 2 }],
  ] as const);
  const conflictingResponse = await client.archives.$post({
    json: {
      ...firstConflictRequest,
      items: [{ ...firstConflictItem, properties: changedOwnKey }],
    },
  });
  if (conflictingResponse.status !== 409) {
    throw new Error(
      "自有 __proto__ 属性变化必须触发幂等冲突：" +
        (await conflictingResponse.text()),
    );
  }
  assert.equal(
    (await conflictingResponse.json()).error.code,
    "archive_request_conflict",
  );
}

async function expectUnsupportedPostgresText(
  response: Response,
  path: readonly (string | number)[],
  label: string,
): Promise<void> {
  if (response.status !== 400) {
    throw new Error(label + " 应返回结构化 400：" + (await response.text()));
  }
  const body = archiveErrorSchema.parse(await response.json());
  assert.equal(body.error.code, "invalid_input");
  assert.equal(
    body.error.message,
    "文本不能包含空字符或未配对的 Unicode 代理项。",
  );
  assert.deepEqual(body.error.path, path);
}

async function verifyPersistableTextBoundary(
  client: ArchiveClient,
): Promise<void> {
  const invalidArchiveBody = await client.archives.$post({
    json: {
      requestId: "e2e:archive:postgres-text-nul",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "postgres-text-nul" },
          body: { text: "a\u0000b" },
          capture: {
            scope: {},
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  await expectUnsupportedPostgresText(
    invalidArchiveBody,
    ["items", 0, "body", "text"],
    "含空字符的归档正文",
  );

  const invalidArchiveKey = await client.archives.$post({
    json: {
      requestId: "e2e:archive:postgres-text-key-nul",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "postgres-text-key-nul" },
          properties: { ["bad\u0000key"]: "value" },
          body: { text: "正常中文正文🌿" },
          capture: {
            scope: {},
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  await expectUnsupportedPostgresText(
    invalidArchiveKey,
    ["items", 0, "properties", "bad\u0000key"],
    "键中含空字符的归档属性",
  );

  const collector = {
    id: "text-boundary",
    version: "1.0.0",
    configSchema: { type: "object" },
    actions: {
      collect: {
        description: "采集验证资料",
        params: { type: "object" },
      },
    },
    environment: {
      browser: { required: false, profileReuseAfterRestart: false },
    },
  };
  const binInput = {
    id: "e2e-text-boundary-invalid",
    collector,
    identityId: "text-boundary",
    config: { value: "正常中文🌿" },
    targets: [{ value: "正常中文🌿" }],
  };
  const invalidBins: {
    readonly label: string;
    readonly input: BinCreateRequest;
    readonly path: readonly (string | number)[];
  }[] = [
    {
      label: "身份标识中的空字符",
      input: { ...binInput, identityId: "a\u0000b" },
      path: ["identityId"],
    },
    {
      label: "身份标识中的未配对代理项",
      input: { ...binInput, identityId: "a\ud800b" },
      path: ["identityId"],
    },
    {
      label: "配置字符串中的空字符",
      input: { ...binInput, config: { value: "a\u0000b" } },
      path: ["config", "value"],
    },
    {
      label: "配置字符串中的未配对代理项",
      input: { ...binInput, config: { value: "a\ud800b" } },
      path: ["config", "value"],
    },
    {
      label: "配置键中的空字符",
      input: {
        ...binInput,
        config: { ["bad\u0000key"]: "value" },
      },
      path: ["config", "bad\u0000key"],
    },
    {
      label: "目标中的空字符",
      input: { ...binInput, targets: [{ value: "a\u0000b" }] },
      path: ["targets", 0, "value"],
    },
    {
      label: "采集器版本中的空字符",
      input: {
        ...binInput,
        collector: { ...collector, version: "a\u0000b" },
      },
      path: ["collector", "version"],
    },
    {
      label: "采集器 JSON Schema 中的空字符",
      input: {
        ...binInput,
        collector: {
          ...collector,
          configSchema: { type: "object", description: "a\u0000b" },
        },
      },
      path: ["collector", "configSchema", "description"],
    },
  ];

  for (const testCase of invalidBins) {
    const response = await client.bins.$post({ json: testCase.input });
    await expectUnsupportedPostgresText(
      response,
      testCase.path,
      testCase.label,
    );
  }

  const validBinInput = {
    ...binInput,
    id: "e2e-text-boundary-" + process.pid.toString(10),
    collector: { ...collector, version: "版本 1.0 🌿" },
    identityId: "身份🌿",
    config: { value: "配置🌿" },
    targets: [{ value: "目标🌿" }],
  };
  const validBinResponse = await client.bins.$post({ json: validBinInput });
  if (validBinResponse.status !== 201) {
    throw new Error(
      "合法中文和 emoji 应能持久化：" + (await validBinResponse.text()),
    );
  }
  const validBin = await validBinResponse.json();
  assert.equal(validBin.identityId, validBinInput.identityId);
  assert.equal(validBin.collector.version, validBinInput.collector.version);
  assert.deepEqual(validBin.config, validBinInput.config);
  assert.deepEqual(validBin.targets, validBinInput.targets);
  const removed = await client.bins[":binId"].$delete({
    param: { binId: validBinInput.id },
  });
  assert.equal(removed.status, 200);

  const validArchive = await submitArchive(client, {
    requestId: "e2e:archive:postgres-text-valid",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "postgres-text-valid" },
        body: { text: "合法中文和 emoji 🌿" },
        capture: {
          scope: { language: "中文🌿" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const validArchiveItemId = validArchive.items[0]?.itemId;
  assert.ok(validArchiveItemId);
  const validArchiveItem = await readArchiveItem(client, validArchiveItemId);
  assert.equal(
    validArchiveItem.views[0]?.state.body?.text,
    "合法中文和 emoji 🌿",
  );
  assert.deepEqual(validArchiveItem.views[0]?.state.capture.scope, {
    language: "中文🌿",
  });
}

async function verifyArchiveABA(
  client: ArchiveClient,
): Promise<ArchiveJourney> {
  const abaA = {
    sourceKey: { namespace: "e2e", key: "aba-item" },
    sourceRef: "https://example.test/aba-item",
    sourceModifiedAt: "2026-10-28T12:00:00+08:00",
    metadata: { title: "状态 A", authors: ["writer"] },
    properties: { counts: { replies: 2, stars: 4 }, tags: ["a", "b"] },
    body: { markdown: "正文 A🌿", searchText: "正文 A🌿" },
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
    observedAt: "2026-10-28T04:02:00.000Z",
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
  assert.deepEqual(
    abaRead.observations.map(({ revisionId }) => revisionId),
    [
      abaFirstItem.revisionId,
      abaSecondItem.revisionId,
      abaThirdItem.revisionId,
    ],
  );
  assert.equal(abaRead.views[0]?.state.body?.markdown, "正文 A🌿");
  assert.equal(abaRead.views[0]?.diagnostics?.[0]?.message, "诊断已变化");
  assert.equal(abaRead.views[0]?.observedAt, "2026-10-28T04:03:00.000Z");

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
  assert.equal(abaRevision.state.body?.markdown, "正文 A🌿");

  return {
    itemId: abaThirdItem.itemId,
    revisionId: abaThirdItem.revisionId,
    replayRequest: abaFirstRequest,
    replayCommitId: abaFirst.commitId,
    expectedObservationCount: abaRead.observations.length,
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
}

async function verifyArchiveReadErrors(client: ArchiveClient): Promise<void> {
  const invalidItemIdResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: "not-a-uuid" },
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
}

async function verifyArchiveJourney(baseUrl: string): Promise<ArchiveJourney> {
  const client = createApiClient(baseUrl);
  await verifyArchiveAtomicity(client);
  await verifyArchiveIdempotency(client);
  await verifyArchivePrototypeKeys(client);
  await verifyPersistableTextBoundary(client);
  const aba = await verifyArchiveABA(client);
  await verifyConcurrentArchiveIdentity(client);
  await verifyArchiveReadErrors(client);
  return aba;
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
  assert.equal(persistedArchive.views[0]?.state.body?.markdown, "正文 A🌿");

  const revisionResponse = await client.archives.revisions[":revisionId"].$get({
    param: { revisionId: archive.revisionId },
  });
  if (revisionResponse.status !== 200) {
    throw new Error(
      "移除 bin 后读取历史版本失败：" + (await revisionResponse.text()),
    );
  }
  const persistedRevision = await revisionResponse.json();
  assert.equal(persistedRevision.state.body?.markdown, "正文 A🌿");
  return { item: persistedArchive, revision: persistedRevision };
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
