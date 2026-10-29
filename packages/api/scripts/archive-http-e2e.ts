import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { createApiClient } from "@binny/api/client";
import {
  archiveAggregationInputSchema,
  archiveAggregationResultSchema,
  archiveSearchFilterSchema,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
  archiveErrorSchema,
  archiveIdentifierSchema,
  archiveItemDeletionResultSchema,
  archiveSnapshotSequenceSchema,
  archiveSubmissionInputSchema,
} from "@binny/contracts";
import type {
  ArchiveSearchFilter,
  ArchiveSearchInput,
  ArchiveSearchPathStep,
  ArchiveSearchRequest,
} from "@binny/contracts";
import type { AnySchema } from "ajv/dist/2020.js";
import * as z from "zod";

import {
  archiveApiSchemas,
  binApiSchemas,
  manualRunApiSchemas,
} from "../src/routes.ts";
import {
  runArchiveCapacityE2E,
  type CapacityPhase,
  type CapacityProfile,
} from "./archive-capacity-e2e.ts";

const require = createRequire(import.meta.url);
const Ajv2020 =
  require("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js").default;
const addFormats =
  require("ajv-formats") as typeof import("ajv-formats").default;

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
type BinCreateRequest = Parameters<ArchiveClient["bins"]["$post"]>[0]["json"];
type ArchiveJourney = {
  readonly itemId: string;
  readonly relationItemId: string;
  readonly relationCommitId: string;
  readonly revisionId: string;
  readonly comparedRevisionId: string;
  readonly commitId: string;
  readonly historicalAsOf: string;
  readonly relationAsOf: string;
  readonly replayRequest: ArchiveSubmission;
  readonly replayCommitId: string;
  readonly expectedObservationCount: number;
  readonly resourceItemId: string;
  readonly resourceRevisionId: string;
  readonly resourcePartialRevisionId: string;
  readonly resourceRepairedRevisionId: string;
  readonly resourceId: string;
  readonly repairedResourceId: string;
  readonly orphanResourceId: string;
  readonly resourceMarkerItemId: string;
  readonly cliCascadeRootItemId: string;
  readonly cliCascadeTargetItemId: string;
};

type SdkResourceJourney = {
  readonly itemId: string;
  readonly revisionId: string;
  readonly resourceId: string;
};

function compileJsonSchema(document: unknown) {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv.compile(document as AnySchema);
}

function compilePublishedSchemas() {
  for (const document of [
    ...Object.values(binApiSchemas),
    ...Object.values(archiveApiSchemas),
    ...Object.values(manualRunApiSchemas),
  ]) {
    compileJsonSchema(document);
  }

  const standardRoots = [
    archiveSearchInputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    }),
    archiveSearchInputSchema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    }),
    archiveSearchFilterSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    }),
    archiveSearchFilterSchema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    }),
    archiveSearchPageSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    }),
    archiveSearchPageSchema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    }),
  ];
  for (const document of standardRoots) compileJsonSchema(document);

  return {
    apiInput: compileJsonSchema(archiveApiSchemas.searchInput),
    apiOutput: compileJsonSchema(archiveApiSchemas.searchPage),
    standardInput: compileJsonSchema(standardRoots[0]),
    standardFilter: compileJsonSchema(standardRoots[2]),
    standardOutput: compileJsonSchema(standardRoots[5]),
  };
}

const archiveJourneySchema = z.object({
  itemId: archiveIdentifierSchema,
  relationItemId: archiveIdentifierSchema,
  relationCommitId: archiveIdentifierSchema,
  revisionId: archiveIdentifierSchema,
  comparedRevisionId: archiveIdentifierSchema,
  commitId: archiveIdentifierSchema,
  historicalAsOf: archiveSnapshotSequenceSchema,
  relationAsOf: archiveSnapshotSequenceSchema,
  replayRequest: archiveSubmissionInputSchema,
  replayCommitId: archiveIdentifierSchema,
  expectedObservationCount: z.number().int().nonnegative(),
  resourceItemId: archiveIdentifierSchema,
  resourceRevisionId: archiveIdentifierSchema,
  resourcePartialRevisionId: archiveIdentifierSchema,
  resourceRepairedRevisionId: archiveIdentifierSchema,
  resourceId: archiveIdentifierSchema,
  repairedResourceId: archiveIdentifierSchema,
  orphanResourceId: archiveIdentifierSchema,
  resourceMarkerItemId: archiveIdentifierSchema,
  cliCascadeRootItemId: archiveIdentifierSchema,
  cliCascadeTargetItemId: archiveIdentifierSchema,
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

async function readArchiveRevisionDiff(
  client: ArchiveClient,
  firstRevisionId: string,
  secondRevisionId: string,
) {
  const response = await client.archives.revisions[":firstRevisionId"].diff[
    ":secondRevisionId"
  ].$get({ param: { firstRevisionId, secondRevisionId } });
  if (response.status !== 200) {
    throw new Error("比较归档版本失败：" + (await response.text()));
  }
  return await response.json();
}

async function verifyArchiveResourceHttp(client: ArchiveClient): Promise<{
  readonly resourceId: string;
  readonly repairedResourceId: string;
  readonly partialRevisionId: string;
  readonly repairedRevisionId: string;
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

  const originalState = {
    sourceKey: { namespace: "e2e", key: "resource-history" },
    sourceRef: "https://example.test/resource-history",
    metadata: {
      title: "原始完整版本",
      nested: { nullable: null, removed: "旧值" },
    },
    properties: {
      nested: { nullable: null, removed: "旧值" },
      values: ["左", null, "右"],
    },
    body: {
      html: `<p>原文媒体：binny://resource/${first.resourceId}</p>`,
      markdown: `原文位置 binny://resource/${first.resourceId}；外链 https://example.test/image.png`,
      text: "原始纯文本正文",
      searchText: "原始可检索文本",
    },
    resources: [{ resourceId: first.resourceId }],
    capture: {
      scope: { phase: "full" },
      completeness: "complete" as const,
      missing: [],
    },
  } satisfies ArchiveSubmission["items"][number];
  const firstCommitPromise = submitArchive(client, {
    requestId: "e2e:archive:resource-history:first",
    binId: "rss-main",
    items: [originalState],
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
        metadata: {
          title: "本次只取得部分资料",
          nested: { added: "新值" },
        },
        properties: {
          nested: { nullable: null, added: "新值" },
          values: ["右", null, "左"],
        },
        body: {
          html: "<p>本次部分正文</p>",
          text: "本次取得的正文",
          searchText: "本次可检索正文",
        },
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

  const firstToPartialDiff = await readArchiveRevisionDiff(
    client,
    firstItem.revisionId,
    partialItem.revisionId,
  );
  assert.equal(firstToPartialDiff.hasChanges, true);
  assert.deepEqual(firstToPartialDiff.fields.sourceRef, {
    status: "changed",
    before: { present: true, value: originalState.sourceRef },
    after: { present: false },
  });
  assert.deepEqual(firstToPartialDiff.fields.body, {
    status: "changed",
    before: { present: true, value: originalState.body },
    after: {
      present: true,
      value: {
        html: "<p>本次部分正文</p>",
        text: "本次取得的正文",
        searchText: "本次可检索正文",
      },
    },
  });
  assert.deepEqual(firstToPartialDiff.fields.metadata, {
    status: "changed",
    before: { present: true, value: originalState.metadata },
    after: {
      present: true,
      value: {
        title: "本次只取得部分资料",
        nested: { added: "新值" },
      },
    },
  });
  assert.equal(firstToPartialDiff.fields.properties.status, "changed");
  if (firstToPartialDiff.fields.properties.status === "changed") {
    assert.deepEqual(firstToPartialDiff.fields.properties.before, {
      present: true,
      value: originalState.properties,
    });
    assert.deepEqual(firstToPartialDiff.fields.properties.after, {
      present: true,
      value: {
        nested: { nullable: null, added: "新值" },
        values: ["右", null, "左"],
      },
    });
  }
  assert.equal(firstToPartialDiff.fields.capture.status, "changed");
  assert.deepEqual(firstToPartialDiff.resources, {
    added: [],
    removed: [first.resourceId],
  });

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
        properties: { completion: { media: true } },
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

  const firstToRepairedDiff = await readArchiveRevisionDiff(
    client,
    firstItem.revisionId,
    repairedItem.revisionId,
  );
  assert.equal(firstToRepairedDiff.hasChanges, true);
  assert.deepEqual(firstToRepairedDiff.resources, {
    added: [replacement.resourceId],
    removed: [first.resourceId],
  });
  assert.deepEqual(firstToRepairedDiff.fields.body, {
    status: "changed",
    before: { present: true, value: originalState.body },
    after: { present: true, value: { markdown: "补齐后的正文" } },
  });
  const repairedState = repairedRead.views[0]?.state;
  assert.ok(repairedState);
  assert.deepEqual(firstToRepairedDiff.fields.capture, {
    status: "changed",
    before: { present: true, value: originalState.capture },
    after: { present: true, value: repairedState.capture },
  });
  const partialToRepairedDiff = await readArchiveRevisionDiff(
    client,
    partialItem.revisionId,
    repairedItem.revisionId,
  );
  assert.equal(partialToRepairedDiff.fields.capture.status, "changed");
  assert.deepEqual(partialToRepairedDiff.fields.capture, {
    status: "changed",
    before: { present: true, value: partialRead.views[0]?.state.capture },
    after: { present: true, value: repairedRead.views[0]?.state.capture },
  });
  const sameRevisionDiff = await readArchiveRevisionDiff(
    client,
    firstItem.revisionId,
    firstItem.revisionId,
  );
  assert.equal(sameRevisionDiff.hasChanges, false);
  assert.deepEqual(sameRevisionDiff.resources, { added: [], removed: [] });
  assert.equal(sameRevisionDiff.fields.metadata.status, "unchanged");
  assert.equal(sameRevisionDiff.fields.properties.status, "unchanged");
  const mixedCaseSameRevisionDiff = await readArchiveRevisionDiff(
    client,
    firstItem.revisionId.toUpperCase(),
    firstItem.revisionId,
  );
  assert.equal(mixedCaseSameRevisionDiff.hasChanges, false);
  assert.equal(mixedCaseSameRevisionDiff.firstRevisionId, firstItem.revisionId);
  assert.equal(
    mixedCaseSameRevisionDiff.secondRevisionId,
    firstItem.revisionId,
  );
  const uppercaseRevisionDiff = await readArchiveRevisionDiff(
    client,
    firstItem.revisionId.toUpperCase(),
    partialItem.revisionId.toUpperCase(),
  );
  assert.equal(uppercaseRevisionDiff.hasChanges, true);
  assert.equal(uppercaseRevisionDiff.fields.body.status, "changed");

  const invalidRevisionDiff = await client.archives.revisions[
    ":firstRevisionId"
  ].diff[":secondRevisionId"].$get({
    param: {
      firstRevisionId: "not-a-revision-id",
      secondRevisionId: firstItem.revisionId,
    },
  });
  assert.equal(invalidRevisionDiff.status, 400);
  if (invalidRevisionDiff.status === 400) {
    assert.equal(
      (await invalidRevisionDiff.json()).error.code,
      "invalid_input",
    );
  }
  const missingRevisionDiff = await client.archives.revisions[
    ":firstRevisionId"
  ].diff[":secondRevisionId"].$get({
    param: {
      firstRevisionId: randomUUID(),
      secondRevisionId: firstItem.revisionId,
    },
  });
  assert.equal(missingRevisionDiff.status, 404);
  if (missingRevisionDiff.status === 404) {
    const error = await missingRevisionDiff.json();
    assert.equal(error.error.code, "revision_not_found");
    assert.deepEqual(error.error.path, ["firstRevisionId"]);
  }
  const attachmentRevision = attachmentOnly.items[0];
  assert.ok(attachmentRevision);
  const crossItemRevisionDiff = await client.archives.revisions[
    ":firstRevisionId"
  ].diff[":secondRevisionId"].$get({
    param: {
      firstRevisionId: firstItem.revisionId,
      secondRevisionId: attachmentRevision.revisionId,
    },
  });
  assert.equal(crossItemRevisionDiff.status, 409);
  if (crossItemRevisionDiff.status === 409) {
    assert.equal(
      (await crossItemRevisionDiff.json()).error.code,
      "revision_item_mismatch",
    );
  }

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
    partialRevisionId: partialItem.revisionId,
    repairedRevisionId: repairedItem.revisionId,
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

async function verifyArchiveRelations(client: ArchiveClient): Promise<{
  readonly relationItemId: string;
  readonly relationCommitId: string;
  readonly relationAsOf: string;
}> {
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
    properties: Object.fromEntries([
      ["__proto__", { label: "关系中文 emoji 🧭" }],
      ["position", 1],
    ] as const),
    cascade: true,
  };
  const secondState = {
    from,
    to: { sourceKey: to },
    name: "reply",
    properties: Object.fromEntries([
      ["__proto__", { label: "更新关系中文 emoji 🌿" }],
      ["position", 2],
    ] as const),
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
  const firstCommittedRelation = firstCommit.relations[0];
  assert.equal(firstCommittedRelation?.status, "observed");
  if (firstCommittedRelation?.status === "observed") {
    assert.deepEqual(
      firstCommittedRelation.state.properties,
      firstState.properties,
    );
  }

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
    assert.deepEqual(firstForward.state.properties, firstState.properties);
  }
  const externalRelation = firstOutgoingPage.relations[1];
  assert.equal(externalRelation?.status, "observed");
  const externalTarget =
    externalRelation?.status === "observed" ? externalRelation.to : undefined;
  assert.equal(externalTarget?.kind, "sourceRef");
  if (externalTarget?.kind === "sourceRef") {
    assert.equal(
      externalTarget.sourceRef,
      "https://example.test/external-target",
    );
  }
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
  const incomingLoopRelation = incomingLoop.relations[0];
  assert.equal(incomingLoopRelation?.status, "observed");
  if (incomingLoopRelation?.status === "observed") {
    assert.equal(incomingLoopRelation.from.itemId, toItem.itemId);
  }

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
    assert.deepEqual(stillActive.state.properties, secondState.properties);
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
    assert.deepEqual(historicalForward.state.properties, firstState.properties);
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
  const committedRelationRead = commitRead.relations[0];
  assert.equal(committedRelationRead?.status, "observed");
  if (committedRelationRead?.status === "observed") {
    assert.deepEqual(
      committedRelationRead.state.properties,
      secondState.properties,
    );
  }

  return {
    relationItemId: fromItem.itemId,
    relationCommitId: relationOnlyCommit.commitId,
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
      check: {
        description: "检查输入是否处于可用状态",
        params: { type: "object" },
      },
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

  const validRelationSource = {
    namespace: "e2e",
    key: "postgres-text-valid",
  };
  const relationValue = {
    from: validRelationSource,
    to: { sourceKey: validRelationSource },
    name: "related",
    cascade: false,
  };
  const invalidRelationId = await client.archives.$post({
    json: {
      requestId: "e2e:archive:relation-postgres-text-nul-id",
      binId: "rss-main",
      items: [],
      relations: [{ relationId: "relation\u0000id", value: relationValue }],
    },
  });
  await expectUnsupportedPostgresText(
    invalidRelationId,
    ["relations", 0, "relationId"],
    "关系标识中的空字符",
  );

  const invalidRelationProperties = await client.archives.$post({
    json: {
      requestId: "e2e:archive:relation-postgres-text-surrogate-key",
      binId: "rss-main",
      items: [],
      relations: [
        {
          relationId: "e2e:relation:postgres-text-surrogate-key",
          value: {
            ...relationValue,
            properties: { ["bad\ud800key"]: "value" },
          },
        },
      ],
    },
  });
  await expectUnsupportedPostgresText(
    invalidRelationProperties,
    ["relations", 0, "value", "properties", "bad\ud800key"],
    "关系属性键中的未配对代理项",
  );
}

async function verifyArchiveABA(
  client: ArchiveClient,
): Promise<
  Pick<
    ArchiveJourney,
    | "itemId"
    | "revisionId"
    | "comparedRevisionId"
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

  const firstToSecondDiff = await readArchiveRevisionDiff(
    client,
    abaFirstItem.revisionId,
    abaSecondItem.revisionId,
  );
  assert.equal(firstToSecondDiff.hasChanges, true);
  assert.equal(firstToSecondDiff.fields.body.status, "changed");
  assert.equal(firstToSecondDiff.fields.metadata.status, "changed");
  assert.equal(firstToSecondDiff.fields.properties.status, "changed");
  assert.deepEqual(firstToSecondDiff.resources, { added: [], removed: [] });
  const firstToReusedDiff = await readArchiveRevisionDiff(
    client,
    abaFirstItem.revisionId,
    abaThirdItem.revisionId,
  );
  assert.equal(firstToReusedDiff.hasChanges, false);
  assert.deepEqual(firstToReusedDiff.resources, { added: [], removed: [] });
  for (const field of Object.values(firstToReusedDiff.fields)) {
    assert.equal(field.status, "unchanged");
  }

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
  assert.equal(abaRead.views[0]?.state.body?.markdown, "正文 A🌿");
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
  assert.equal(abaRevision.state.body?.markdown, "正文 A🌿");

  return {
    itemId: abaThirdItem.itemId,
    revisionId: abaThirdItem.revisionId,
    comparedRevisionId: abaSecondItem.revisionId,
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

async function verifySearchRoute(
  baseUrl: string,
  itemId: string,
  revisionId: string,
  historicalAsOf: string,
): Promise<void> {
  const client = createApiClient(baseUrl);
  const searchSchemas = compilePublishedSchemas();
  const unicodeCommit = await submitArchive(client, {
    requestId: "e2e:archive:search-unicode",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "search-unicode" },
        sourceRef: "https://example.test/search-unicode",
        sourceModifiedAt: "2026-10-28T04:04:00.000Z",
        body: {
          html: "<p>HTML-only phrase is not search text</p>",
          searchText: "前🙂中文短串后",
        },
        capture: {
          scope: { case: "search" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const unicodeItem = unicodeCommit.items[0];
  assert.ok(unicodeItem);
  const query = {
    scope: { kind: "current" as const, binId: "rss-main" },
    text: { kind: "literal" as const, value: "正文 A" },
    limit: 10,
  };
  assert.equal(searchSchemas.apiInput(query), true);
  assert.equal(searchSchemas.standardInput(query), true);
  const response = await client.archives.search.$post({ json: query });
  if (response.status !== 200) {
    throw new Error("公开正文搜索失败：" + (await response.text()));
  }
  const page = await response.json();
  assert.equal(searchSchemas.apiOutput(page), true);
  assert.equal(searchSchemas.standardOutput(page), true);
  assert.equal(page.unit, "item");
  assert.equal(page.snapshot.mode, "current");
  assert.equal(page.results.length, 1);
  const result = page.results[0];
  assert.ok(result);
  assert.equal(result.itemId, itemId);
  assert.equal(result.matches[0]?.revisionId, revisionId);
  assert.equal(result.matches[0]?.binId, "rss-main");
  assert.equal(result.matches[0]?.sourceRef, "https://example.test/aba-item");
  assert.equal(result.matches[0]?.completeness, "complete");
  assert.deepEqual(result.matches[0]?.hit?.position, {
    encoding: "unicode-code-point",
    start: 0,
    end: 4,
  });
  assert.deepEqual(result.matches[0]?.hit?.context, {
    start: 0,
    end: 5,
    text: "正文 A🌿",
  });

  const regexResponse = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "regex", pattern: "\\mA\\M" },
      limit: 10,
    },
  });
  if (regexResponse.status !== 200) {
    throw new Error("PostgreSQL ARE 搜索失败：" + (await regexResponse.text()));
  }
  const regexPage = await regexResponse.json();
  assert.equal(regexPage.results.length, 1);
  assert.equal(regexPage.results[0]?.itemId, itemId);
  assert.deepEqual(regexPage.results[0]?.matches[0]?.hit?.position, {
    encoding: "unicode-code-point",
    start: 3,
    end: 4,
  });

  const unicodeSearch = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "literal", value: "短串" },
      limit: 10,
    },
  });
  if (unicodeSearch.status !== 200) {
    throw new Error("短中文字面搜索失败：" + (await unicodeSearch.text()));
  }
  const unicodePage = await unicodeSearch.json();
  assert.equal(unicodePage.results.length, 1);
  assert.equal(unicodePage.results[0]?.itemId, unicodeItem.itemId);
  assert.deepEqual(unicodePage.results[0]?.matches[0]?.hit?.position, {
    encoding: "unicode-code-point",
    start: 4,
    end: 6,
  });
  assert.deepEqual(unicodePage.results[0]?.matches[0]?.hit?.context, {
    start: 0,
    end: 7,
    text: "前🙂中文短串后",
  });

  const composedFilter = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "literal", value: "短串" },
      where: {
        type: "and",
        conditions: [
          {
            type: "field",
            field: "sourceKey.key",
            operator: "in",
            values: ["search-unicode", "other"],
          },
          {
            type: "or",
            conditions: [
              {
                type: "field",
                field: "sourceModifiedAt",
                operator: "between",
                lower: "2026-10-28T04:00:00.000Z",
                upper: "2026-10-28T04:05:00.000Z",
              },
              {
                type: "field",
                field: "sourceRef",
                operator: "eq",
                value: "https://example.test/other",
              },
            ],
          },
          {
            type: "not",
            condition: {
              type: "field",
              field: "sourceRef",
              operator: "eq",
              value: "https://example.test/other",
            },
          },
          {
            type: "field",
            field: "runId",
            operator: "exists",
            value: false,
          },
        ],
      },
      limit: 10,
    },
  });
  if (composedFilter.status !== 200) {
    throw new Error("组合字段过滤失败：" + (await composedFilter.text()));
  }
  assert.equal(
    searchSchemas.standardFilter({
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: "search-unicode",
    }),
    true,
  );
  const composedPage = (await composedFilter.json()) as typeof unicodePage;
  assert.equal(composedPage.results.length, 1);
  assert.equal(composedPage.results[0]?.itemId, unicodeItem.itemId);

  const htmlOnlySearch = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "literal", value: "HTML-only phrase" },
      limit: 10,
    },
  });
  assert.equal(htmlOnlySearch.status, 200);
  if (htmlOnlySearch.status !== 200) return;
  assert.deepEqual((await htmlOnlySearch.json()).results, []);

  const currentOldText = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "literal", value: "正文 B" },
      limit: 10,
    },
  });
  assert.equal(currentOldText.status, 200);
  if (currentOldText.status !== 200) return;
  assert.equal((await currentOldText.json()).results.length, 0);

  const historicalText = await client.archives.search.$post({
    json: {
      scope: { kind: "asOf", binId: "rss-main", asOf: historicalAsOf },
      text: { kind: "literal", value: "正文 B" },
      limit: 10,
    },
  });
  if (historicalText.status !== 200) {
    throw new Error("指定截点搜索失败：" + (await historicalText.text()));
  }
  const historicalPage = await historicalText.json();
  assert.equal(historicalPage.snapshot.mode, "asOf");
  assert.equal(historicalPage.snapshot.asOf, historicalAsOf);
  assert.equal(historicalPage.results[0]?.itemId, itemId);
  assert.notEqual(
    historicalPage.results[0]?.matches[0]?.revisionId,
    revisionId,
  );

  const revisionHistory = await client.archives.search.$post({
    json: {
      scope: {
        kind: "revisions",
        binId: "rss-main",
        asOf: historicalAsOf,
      },
      text: { kind: "literal", value: "正文 B" },
      limit: 10,
    },
  });
  if (revisionHistory.status !== 200) {
    throw new Error("历史版本正文搜索失败：" + (await revisionHistory.text()));
  }
  const revisionHistoryPage = await revisionHistory.json();
  assert.equal(revisionHistoryPage.unit, "revision");
  assert.equal(
    revisionHistoryPage.results.find(
      ({ itemId: matchedId }) => matchedId === itemId,
    )?.revisionId,
    historicalPage.results[0]?.matches[0]?.revisionId,
  );

  const observationHistory = await client.archives.search.$post({
    json: {
      scope: {
        kind: "observations",
        binId: "rss-main",
        asOf: historicalAsOf,
      },
      text: { kind: "literal", value: "正文 B" },
      limit: 10,
    },
  });
  if (observationHistory.status !== 200) {
    throw new Error(
      "观察历史正文搜索失败：" + (await observationHistory.text()),
    );
  }
  const observationHistoryPage = await observationHistory.json();
  assert.equal(observationHistoryPage.unit, "observation");
  const historicalObservation = observationHistoryPage.results.find(
    ({ itemId: matchedId }) => matchedId === itemId,
  );
  assert.ok(historicalObservation?.commitId);
  assert.equal(historicalObservation?.ordinal, 0);
  assert.equal(
    historicalObservation?.matches[0]?.revisionId,
    historicalPage.results[0]?.matches[0]?.revisionId,
  );

  const invalidRegex = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "regex", pattern: "(" },
      limit: 10,
    },
  });
  assert.equal(invalidRegex.status, 400);
  if (invalidRegex.status !== 400) return;
  const invalidRegexError = await invalidRegex.json();
  assert.equal(invalidRegexError.error.code, "invalid_input");
  assert.deepEqual(invalidRegexError.error.path, ["text", "pattern"]);

  const invalidRegexInCondition = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "or",
        conditions: [
          {
            type: "text",
            text: { kind: "regex", pattern: "valid" },
          },
          { type: "text", text: { kind: "regex", pattern: "(" } },
        ],
      },
      limit: 10,
    },
  });
  assert.equal(invalidRegexInCondition.status, 400);
  if (invalidRegexInCondition.status !== 400) return;
  const invalidRegexInConditionError = await invalidRegexInCondition.json();
  assert.equal(invalidRegexInConditionError.error.code, "invalid_input");
  assert.deepEqual(invalidRegexInConditionError.error.path, [
    "where",
    "conditions",
    1,
    "text",
    "pattern",
  ]);

  const invalidRegexAfterTopLevel = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "regex", pattern: "(?i)^正文 a" },
      where: {
        type: "and",
        conditions: [
          {
            type: "not",
            condition: {
              type: "text",
              text: { kind: "regex", pattern: "(" },
            },
          },
        ],
      },
      limit: 10,
    },
  });
  assert.equal(invalidRegexAfterTopLevel.status, 400);
  if (invalidRegexAfterTopLevel.status !== 400) return;
  const invalidRegexAfterTopLevelError = await invalidRegexAfterTopLevel.json();
  assert.equal(invalidRegexAfterTopLevelError.error.code, "invalid_input");
  assert.deepEqual(invalidRegexAfterTopLevelError.error.path, [
    "where",
    "conditions",
    0,
    "condition",
    "text",
    "pattern",
  ]);

  const validRegexCombination = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "regex", pattern: "(?i)^正文 a" },
      where: {
        type: "or",
        conditions: [
          {
            type: "text",
            text: { kind: "regex", pattern: "\\mA\\M" },
          },
          { type: "text", text: { kind: "regex", pattern: "never" } },
        ],
      },
      limit: 10,
    },
  });
  if (validRegexCombination.status !== 200) {
    throw new Error(
      "PostgreSQL ARE 多正则组合搜索失败：" +
        (await validRegexCombination.text()),
    );
  }
  const validRegexCombinationPage = await validRegexCombination.json();
  const validRegexCombinationResult = validRegexCombinationPage.results.find(
    ({ itemId: matchedItemId }) => matchedItemId === itemId,
  );
  assert.ok(validRegexCombinationResult);
  assert.deepEqual(validRegexCombinationResult.matches[0]?.hit?.position, {
    encoding: "unicode-code-point",
    start: 0,
    end: 4,
  });
}

async function verifySearchSourceViews(baseUrl: string): Promise<void> {
  const client = createApiClient(baseUrl);
  const sourceKey = { namespace: "e2e", key: "search-cross-view" };
  const primary = await submitArchive(client, {
    requestId: "e2e:archive:search-cross-view:main",
    binId: "rss-main",
    runId: "search-view-left",
    items: [
      {
        sourceKey,
        body: { searchText: "分视图文字" },
        capture: {
          scope: { case: "search-view" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const secondary = await submitArchive(client, {
    requestId: "e2e:archive:search-cross-view:secondary",
    binId: "rss-secondary",
    runId: "search-view-right",
    items: [
      {
        sourceKey,
        body: { searchText: "另一份内容" },
        capture: {
          scope: { case: "search-view" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  assert.equal(primary.items[0]?.itemId, secondary.items[0]?.itemId);

  const spliced = await client.archives.search.$post({
    json: {
      scope: { kind: "current" },
      text: { kind: "literal", value: "分视图文字" },
      where: {
        type: "field",
        field: "runId",
        operator: "eq",
        value: "search-view-right",
      },
      limit: 10,
    },
  });
  if (spliced.status !== 200) {
    throw new Error("跨来源同视图条件查询失败：" + (await spliced.text()));
  }
  assert.deepEqual((await spliced.json()).results, []);

  const matchedSource = await client.archives.search.$post({
    json: {
      scope: { kind: "current" },
      text: { kind: "literal", value: "分视图文字" },
      where: {
        type: "field",
        field: "runId",
        operator: "eq",
        value: "search-view-left",
      },
      limit: 10,
    },
  });
  if (matchedSource.status !== 200) {
    throw new Error("多来源结果查询失败：" + (await matchedSource.text()));
  }
  const matchedSourcePage = await matchedSource.json();
  assert.equal(matchedSourcePage.results.length, 1);
  assert.equal(matchedSourcePage.results[0]?.itemId, primary.items[0]?.itemId);
  assert.deepEqual(
    matchedSourcePage.results[0]?.matches.map(({ binId }) => binId),
    ["rss-main"],
  );

  const asOfAcrossBins = await client.archives.search.$post({
    json: {
      scope: { kind: "asOf", asOf: secondary.archiveSeq },
      text: { kind: "literal", value: "分视图文字" },
      limit: 10,
    },
  });
  if (asOfAcrossBins.status !== 200) {
    throw new Error("未选来源的历史搜索失败：" + (await asOfAcrossBins.text()));
  }
  const asOfAcrossBinsPage = await asOfAcrossBins.json();
  assert.equal(asOfAcrossBinsPage.unit, "item");
  assert.equal(asOfAcrossBinsPage.snapshot.asOf, secondary.archiveSeq);
  assert.equal(asOfAcrossBinsPage.results.length, 1);
  assert.equal(asOfAcrossBinsPage.results[0]?.itemId, primary.items[0]?.itemId);
  assert.deepEqual(
    asOfAcrossBinsPage.results[0]?.matches.map(({ binId }) => binId),
    ["rss-main"],
  );

  const fieldOnlySearch = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: "search-cross-view",
      },
      limit: 10,
    },
  });
  if (fieldOnlySearch.status !== 200) {
    throw new Error("纯字段搜索失败：" + (await fieldOnlySearch.text()));
  }
  const fieldOnlyPage = await fieldOnlySearch.json();
  assert.equal(fieldOnlyPage.results.length, 1);
  assert.equal(fieldOnlyPage.results[0]?.itemId, primary.items[0]?.itemId);
  assert.equal(fieldOnlyPage.results[0]?.matches[0]?.hit, undefined);

  const nestedOrSearch = await client.archives.search.$post({
    json: {
      scope: { kind: "current" },
      where: {
        type: "or",
        conditions: [
          {
            type: "field",
            field: "runId",
            operator: "eq",
            value: "search-view-right",
          },
          {
            type: "text",
            text: { kind: "literal", value: "分视图文字" },
          },
        ],
      },
      limit: 10,
    },
  });
  if (nestedOrSearch.status !== 200) {
    throw new Error("嵌套 OR 正文搜索失败：" + (await nestedOrSearch.text()));
  }
  const nestedOrPage = await nestedOrSearch.json();
  const nestedOrResult = nestedOrPage.results.find(
    ({ itemId }) => itemId === primary.items[0]?.itemId,
  );
  assert.ok(nestedOrResult);
  assert.deepEqual(
    nestedOrResult.matches.map(({ binId }) => binId),
    ["rss-main", "rss-secondary"],
  );
  assert.ok(nestedOrResult.matches[0]?.hit);
  assert.equal(nestedOrResult.matches[1]?.hit, undefined);

  const nestedNotSearch = await client.archives.search.$post({
    json: {
      scope: { kind: "current" },
      where: {
        type: "and",
        conditions: [
          {
            type: "field",
            field: "sourceKey.key",
            operator: "eq",
            value: "search-cross-view",
          },
          {
            type: "not",
            condition: {
              type: "text",
              text: { kind: "literal", value: "分视图文字" },
            },
          },
        ],
      },
      limit: 10,
    },
  });
  if (nestedNotSearch.status !== 200) {
    throw new Error("嵌套 NOT 正文搜索失败：" + (await nestedNotSearch.text()));
  }
  const nestedNotPage = await nestedNotSearch.json();
  assert.equal(nestedNotPage.results.length, 1);
  assert.equal(nestedNotPage.results[0]?.itemId, primary.items[0]?.itemId);
  assert.deepEqual(
    nestedNotPage.results[0]?.matches.map(({ binId }) => binId),
    ["rss-secondary"],
  );
  assert.equal(nestedNotPage.results[0]?.matches[0]?.hit, undefined);

  const sharedKey = { namespace: "e2e", key: "search-shared-revision" };
  const sharedState = {
    sourceKey: sharedKey,
    body: { searchText: "相同正文跨两个来源" },
    capture: {
      scope: { case: "shared-search" },
      completeness: "complete" as const,
      missing: [],
    },
  };
  const [sharedMain, sharedSecondary] = await Promise.all([
    submitArchive(client, {
      requestId: "e2e:archive:search-shared:main",
      binId: "rss-main",
      items: [sharedState],
    }),
    submitArchive(client, {
      requestId: "e2e:archive:search-shared:secondary",
      binId: "rss-secondary",
      items: [sharedState],
    }),
  ]);
  assert.equal(
    sharedMain.items[0]?.revisionId,
    sharedSecondary.items[0]?.revisionId,
  );
  const sharedSearch = await client.archives.search.$post({
    json: {
      scope: { kind: "current" },
      text: { kind: "literal", value: "相同正文跨两个来源" },
      limit: 10,
    },
  });
  if (sharedSearch.status !== 200) {
    throw new Error("共享版本多来源查询失败：" + (await sharedSearch.text()));
  }
  const sharedPage = await sharedSearch.json();
  assert.equal(sharedPage.results.length, 1);
  assert.equal(sharedPage.results[0]?.itemId, sharedMain.items[0]?.itemId);
  assert.deepEqual(
    sharedPage.results[0]?.matches.map(({ binId }) => binId),
    ["rss-main", "rss-secondary"],
  );

  const sharedRevisionHistory = await client.archives.search.$post({
    json: {
      scope: { kind: "revisions" },
      text: { kind: "literal", value: "相同正文跨两个来源" },
      limit: 10,
    },
  });
  if (sharedRevisionHistory.status !== 200) {
    throw new Error(
      "共享版本历史搜索失败：" + (await sharedRevisionHistory.text()),
    );
  }
  const sharedRevisionPage = await sharedRevisionHistory.json();
  assert.equal(sharedRevisionPage.unit, "revision");
  assert.equal(sharedRevisionPage.results.length, 1);
  assert.equal(
    sharedRevisionPage.results[0]?.revisionId,
    sharedMain.items[0]?.revisionId,
  );
  assert.deepEqual(
    sharedRevisionPage.results[0]?.matches.map(({ binId }) => binId),
    ["rss-main", "rss-secondary"],
  );

  const sharedObservationHistory = await client.archives.search.$post({
    json: {
      scope: { kind: "observations" },
      text: { kind: "literal", value: "相同正文跨两个来源" },
      limit: 1,
    },
  });
  if (sharedObservationHistory.status !== 200) {
    throw new Error(
      "共享来源观察搜索失败：" + (await sharedObservationHistory.text()),
    );
  }
  const sharedObservationPage = await sharedObservationHistory.json();
  assert.equal(sharedObservationPage.unit, "observation");
  assert.equal(sharedObservationPage.results.length, 1);
  assert.ok(sharedObservationPage.nextCursor);
  const sharedObservationSecondPageResponse =
    await client.archives.search.$post({
      json: {
        scope: { kind: "observations" },
        text: { kind: "literal", value: "相同正文跨两个来源" },
        limit: 1,
        cursor: sharedObservationPage.nextCursor,
      },
    });
  if (sharedObservationSecondPageResponse.status !== 200) {
    throw new Error(
      "观察搜索游标续页失败：" +
        (await sharedObservationSecondPageResponse.text()),
    );
  }
  const sharedObservationSecondPage =
    await sharedObservationSecondPageResponse.json();
  assert.equal(sharedObservationSecondPage.results.length, 1);
  assert.equal(sharedObservationSecondPage.nextCursor, undefined);
  assert.equal(
    sharedObservationSecondPage.snapshot.asOf,
    sharedObservationPage.snapshot.asOf,
  );
  assert.deepEqual(
    [...sharedObservationPage.results, ...sharedObservationSecondPage.results]
      .map(({ matches }) => matches[0]?.binId)
      .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["rss-main", "rss-secondary"],
  );

  const complete = await submitArchive(client, {
    requestId: "e2e:archive:search-latest-partial:complete",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "search-latest-partial" },
        body: { searchText: "旧完整版本onlyneedle" },
        capture: {
          scope: { case: "search-partial" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const partial = await submitArchive(client, {
    requestId: "e2e:archive:search-latest-partial:partial",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "search-latest-partial" },
        body: { searchText: "最新部分版本onlyneedle" },
        capture: {
          scope: { case: "search-partial" },
          completeness: "partial",
          missing: [{ path: "attachments", reason: "本次未能下载附件。" }],
        },
      },
    ],
  });
  const stalePartialSearch = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "literal", value: "旧完整版本onlyneedle" },
      limit: 10,
    },
  });
  assert.equal(stalePartialSearch.status, 200);
  if (stalePartialSearch.status !== 200) return;
  assert.deepEqual((await stalePartialSearch.json()).results, []);
  const currentPartialSearch = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      text: { kind: "literal", value: "最新部分版本onlyneedle" },
      limit: 10,
    },
  });
  if (currentPartialSearch.status !== 200) {
    throw new Error(
      "最新部分版本搜索失败：" + (await currentPartialSearch.text()),
    );
  }
  const currentPartialPage = await currentPartialSearch.json();
  assert.equal(currentPartialPage.results.length, 1);
  assert.equal(
    currentPartialPage.results[0]?.itemId,
    complete.items[0]?.itemId,
  );
  assert.equal(
    currentPartialPage.results[0]?.matches[0]?.revisionId,
    partial.items[0]?.revisionId,
  );
  const oldPartialSnapshotSearch = await client.archives.search.$post({
    json: {
      scope: {
        kind: "asOf",
        binId: "rss-main",
        asOf: complete.archiveSeq,
      },
      text: { kind: "literal", value: "旧完整版本onlyneedle" },
      limit: 10,
    },
  });
  if (oldPartialSnapshotSearch.status !== 200) {
    throw new Error(
      "部分版本前的显式截点搜索失败：" +
        (await oldPartialSnapshotSearch.text()),
    );
  }
  const oldPartialSnapshotPage = await oldPartialSnapshotSearch.json();
  assert.equal(oldPartialSnapshotPage.results.length, 1);
  assert.equal(
    oldPartialSnapshotPage.results[0]?.matches[0]?.revisionId,
    complete.items[0]?.revisionId,
  );
}

async function verifyAggregationFirstSlice(baseUrl: string): Promise<void> {
  const client = createApiClient(baseUrl);
  const runId = randomUUID();
  const aggregate = async (request: unknown) => {
    const response = await client.archives.aggregate.$post({
      json: archiveAggregationInputSchema.parse(request),
    });
    if (response.status !== 200) {
      throw new Error("归档聚合失败：" + (await response.text()));
    }
    return archiveAggregationResultSchema.parse(await response.json());
  };
  const sharedState = {
    sourceKey: { namespace: "e2e", key: "aggregation-shared-p" },
    body: { searchText: "聚合完整候选集合" },
    properties: { price: 10, category: "x" },
    capture: {
      scope: { case: "aggregation" },
      completeness: "complete" as const,
      missing: [],
    },
  };
  const [primary, secondary] = await Promise.all([
    submitArchive(client, {
      requestId: "e2e:archive:aggregation-shared-p:main",
      binId: "rss-main",
      runId: "aggregation-primary",
      items: [sharedState],
    }),
    submitArchive(client, {
      requestId: "e2e:archive:aggregation-shared-p:secondary",
      binId: "rss-secondary",
      runId: "aggregation-secondary",
      items: [sharedState],
    }),
  ]);
  assert.equal(primary.items[0]?.itemId, secondary.items[0]?.itemId);
  await submitArchive(client, {
    requestId: "e2e:archive:aggregation-distinct-q",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "aggregation-distinct-q" },
        body: { searchText: "聚合完整候选集合" },
        properties: { price: 10, category: "x" },
        capture: {
          scope: { case: "aggregation" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });

  const thirdKey = "aggregation-third-" + runId;
  await submitArchive(client, {
    requestId: "e2e:archive:aggregation-third:" + runId,
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: thirdKey },
        body: { searchText: "聚合完整候选集合" },
        properties: { price: 2, category: "y" },
        capture: {
          scope: { case: "aggregation" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });

  const where = {
    type: "and" as const,
    conditions: [
      {
        type: "field" as const,
        field: "sourceKey.namespace" as const,
        operator: "eq" as const,
        value: "e2e",
      },
      {
        type: "field" as const,
        field: "sourceKey.key" as const,
        operator: "in" as const,
        values: [
          "aggregation-shared-p",
          "aggregation-distinct-q",
          thirdKey,
          "aggregation-late-" + runId,
        ],
      },
      {
        type: "json" as const,
        field: "properties" as const,
        path: ["category"],
        operator: "in" as const,
        valueType: "string" as const,
        values: ["x", "y", "z"],
      },
    ],
  };
  const groupedInput = {
    scope: { kind: "current" },
    unit: "item",
    text: { kind: "regex", pattern: "^聚合完整候选集合$" },
    where,
    groupBy: [
      {
        key: "category",
        type: "json",
        field: "properties",
        path: ["category"],
      },
      {
        key: "namespace",
        type: "field",
        field: "sourceKey.namespace",
      },
    ],
    metrics: [
      { key: "items", op: "count" },
      {
        key: "priceSum",
        op: "sum",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
      {
        key: "priceAverage",
        op: "avg",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
      {
        key: "priceMinimum",
        op: "min",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
      {
        key: "priceMaximum",
        op: "max",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
      {
        key: "distinctPrices",
        op: "distinct",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
    ],
    orderBy: [{ key: "priceSum", direction: "desc" }],
    limit: 1,
  };
  const firstPage = await aggregate(groupedInput);
  const result = firstPage;
  assert.equal(result.unit, "item");
  assert.equal(result.scope.kind, "current");
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]?.keys, [
    { key: "category", result: { status: "value", value: "x" } },
    { key: "namespace", result: { status: "value", value: "e2e" } },
  ]);
  assert.deepEqual(result.groups[0]?.metrics, [
    { key: "items", op: "count", value: "2" },
    { key: "priceSum", op: "sum", value: "20" },
    { key: "priceAverage", op: "avg", value: "10" },
    { key: "priceMinimum", op: "min", value: "10" },
    { key: "priceMaximum", op: "max", value: "10" },
    { key: "distinctPrices", op: "distinct", value: "1" },
  ]);
  assert.ok(firstPage.nextCursor);
  await submitArchive(client, {
    requestId: "e2e:archive:aggregation-late:" + runId,
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "aggregation-late-" + runId },
        body: { searchText: "聚合完整候选集合" },
        properties: { price: 100, category: "z" },
        capture: {
          scope: { case: "aggregation" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const secondPage = await aggregate({
    ...groupedInput,
    cursor: firstPage.nextCursor,
  });
  assert.deepEqual(secondPage.groups[0]?.keys, [
    { key: "category", result: { status: "value", value: "y" } },
    { key: "namespace", result: { status: "value", value: "e2e" } },
  ]);
  assert.deepEqual(secondPage.groups[0]?.metrics, [
    { key: "items", op: "count", value: "1" },
    { key: "priceSum", op: "sum", value: "2" },
    { key: "priceAverage", op: "avg", value: "2" },
    { key: "priceMinimum", op: "min", value: "2" },
    { key: "priceMaximum", op: "max", value: "2" },
    { key: "distinctPrices", op: "distinct", value: "1" },
  ]);
  assert.equal(secondPage.nextCursor, undefined);

  const havingPage = await aggregate({
    ...groupedInput,
    having: { type: "metric", metric: "priceSum", operator: "gt", value: "10" },
    limit: 10,
  });
  assert.deepEqual(
    havingPage.groups.map(({ keys }) => keys[0]?.result),
    [
      { status: "value", value: "z" },
      { status: "value", value: "x" },
    ],
  );
  const mismatchedCursor = await client.archives.aggregate.$post({
    json: archiveAggregationInputSchema.parse({
      ...groupedInput,
      having: {
        type: "metric",
        metric: "priceSum",
        operator: "gt",
        value: "10",
      },
      cursor: firstPage.nextCursor,
    }),
  });
  assert.equal(mismatchedCursor.status, 400);
  const invalidRegex = await client.archives.aggregate.$post({
    json: archiveAggregationInputSchema.parse({
      ...groupedInput,
      text: { kind: "regex", pattern: "(" },
    }),
  });
  assert.equal(invalidRegex.status, 400);
  if (invalidRegex.status === 400) {
    const invalidRegexError = archiveErrorSchema.parse(
      await invalidRegex.json(),
    );
    assert.deepEqual(invalidRegexError.error.path, ["text", "pattern"]);
  }

  const decimalKeys = [
    "aggregation-decimal-a-" + runId,
    "aggregation-decimal-b-" + runId,
  ];
  await submitArchive(client, {
    requestId: "e2e:archive:aggregation-decimals:" + runId,
    binId: "rss-main",
    items: decimalKeys.map((key, index) => ({
      sourceKey: { namespace: "e2e", key },
      properties: { price: index === 0 ? 0.1 : 0.2 },
      capture: {
        scope: { case: "aggregation-decimal" },
        completeness: "complete" as const,
        missing: [],
      },
    })),
  });
  const exactDecimal = await aggregate({
    scope: { kind: "current", binId: "rss-main" },
    unit: "item",
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "in",
      values: decimalKeys,
    },
    groupBy: [],
    metrics: [
      { key: "items", op: "count" },
      {
        key: "priceDistinct",
        op: "distinct",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
      ...(["sum", "avg", "min", "max"] as const).map((op) => ({
        key: "price" + op,
        op,
        value: {
          type: "json" as const,
          field: "properties" as const,
          path: ["price"],
          valueType: "number" as const,
        },
      })),
    ],
  });
  assert.deepEqual(exactDecimal.groups[0]?.metrics, [
    { key: "items", op: "count", value: "2" },
    { key: "priceDistinct", op: "distinct", value: "2" },
    { key: "pricesum", op: "sum", value: "0.3" },
    { key: "priceavg", op: "avg", value: "0.15" },
    { key: "pricemin", op: "min", value: "0.1" },
    { key: "pricemax", op: "max", value: "0.2" },
  ]);

  const emptyWhere = {
    type: "field" as const,
    field: "sourceKey.key" as const,
    operator: "eq" as const,
    value: "aggregation-empty-" + runId,
  };
  const emptyGlobal = await aggregate({
    scope: { kind: "current" },
    unit: "item",
    where: emptyWhere,
    groupBy: [],
    metrics: [
      { key: "items", op: "count" },
      {
        key: "distinctPrices",
        op: "distinct",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
      {
        key: "priceSum",
        op: "sum",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
    ],
  });
  assert.deepEqual(emptyGlobal.groups[0]?.metrics, [
    { key: "items", op: "count", value: "0" },
    { key: "distinctPrices", op: "distinct", value: "0" },
    { key: "priceSum", op: "sum", value: null },
  ]);
  const emptyGrouped = await aggregate({
    scope: { kind: "current" },
    unit: "item",
    where: emptyWhere,
    groupBy: [
      {
        key: "category",
        type: "json",
        field: "properties",
        path: ["category"],
      },
    ],
    metrics: [{ key: "items", op: "count" }],
  });
  assert.deepEqual(emptyGrouped.groups, []);

  const nullKey = "aggregation-null-" + runId;
  const missingKey = "aggregation-missing-" + runId;
  const valueKey = "aggregation-value-" + runId;
  await submitArchive(client, {
    requestId: "e2e:archive:aggregation-null-missing:" + runId,
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: nullKey },
        properties: { marker: null, price: 9 },
      },
      {
        sourceKey: { namespace: "e2e", key: missingKey },
        properties: { price: 4 },
      },
      {
        sourceKey: { namespace: "e2e", key: valueKey },
        properties: { marker: "blue", price: 2 },
      },
    ].map((item) => ({
      ...item,
      capture: {
        scope: { case: "aggregation-null-missing" },
        completeness: "complete" as const,
        missing: [],
      },
    })),
  });
  const nullMissing = await aggregate({
    scope: { kind: "current", binId: "rss-main" },
    unit: "item",
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "in",
      values: [nullKey, missingKey, valueKey],
    },
    groupBy: [
      {
        key: "marker",
        type: "json",
        field: "properties",
        path: ["marker"],
      },
    ],
    metrics: [
      { key: "items", op: "count" },
      {
        key: "distinctMarkers",
        op: "distinct",
        value: { type: "json", field: "properties", path: ["marker"] },
      },
      {
        key: "priceSum",
        op: "sum",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
    ],
  });
  const nullMissingRows = nullMissing.groups.map((group) => ({
    key: group.keys[0]?.result,
    metrics: group.metrics,
  }));
  assert.deepEqual(nullMissingRows, [
    {
      key: { status: "missing" },
      metrics: [
        { key: "items", op: "count", value: "1" },
        { key: "distinctMarkers", op: "distinct", value: "0" },
        { key: "priceSum", op: "sum", value: "4" },
      ],
    },
    {
      key: { status: "value", value: null },
      metrics: [
        { key: "items", op: "count", value: "1" },
        { key: "distinctMarkers", op: "distinct", value: "0" },
        { key: "priceSum", op: "sum", value: "9" },
      ],
    },
    {
      key: { status: "value", value: "blue" },
      metrics: [
        { key: "items", op: "count", value: "1" },
        { key: "distinctMarkers", op: "distinct", value: "1" },
        { key: "priceSum", op: "sum", value: "2" },
      ],
    },
  ]);

  const relationRoot = {
    namespace: "e2e",
    key: "aggregation-relation-root-" + runId,
  };
  const relationTarget = {
    namespace: "e2e",
    key: "aggregation-relation-target-" + runId,
  };
  for (const [binId, weight] of [
    ["rss-main", 10],
    ["rss-secondary", 20],
  ] as const) {
    await submitArchive(client, {
      requestId: "e2e:archive:aggregation-relation:" + runId + ":" + binId,
      binId,
      items: [relationRoot, relationTarget].map((sourceKey) => ({
        sourceKey,
        body: { searchText: "聚合关系视图" },
        capture: {
          scope: { case: "aggregation-relation" },
          completeness: "complete" as const,
          missing: [],
        },
      })),
      relations: [
        {
          relationId: "e2e:aggregation-relation:" + runId,
          value: {
            from: relationRoot,
            to: { sourceKey: relationTarget },
            name: "aggregation-link",
            properties: { bucket: "keep", weight },
            cascade: false,
          },
        },
      ],
    });
  }
  const relationGroups = await aggregate({
    scope: { kind: "current" },
    unit: "relation",
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: relationRoot.key,
    },
    relations: { direction: "outgoing", name: "aggregation-link" },
    groupBy: [
      {
        key: "bucket",
        type: "json",
        field: "properties",
        path: ["bucket"],
      },
    ],
    metrics: [
      { key: "relations", op: "count" },
      {
        key: "weightSum",
        op: "sum",
        value: {
          type: "json",
          field: "properties",
          path: ["weight"],
          valueType: "number",
        },
      },
    ],
  });
  assert.deepEqual(relationGroups.groups[0]?.keys, [
    { key: "bucket", result: { status: "value", value: "keep" } },
  ]);
  assert.deepEqual(relationGroups.groups[0]?.metrics, [
    { key: "relations", op: "count", value: "1" },
    { key: "weightSum", op: "sum", value: "10" },
  ]);

  const relationTargetTextFilter = await aggregate({
    scope: { kind: "current" },
    unit: "relation",
    relations: {
      direction: "outgoing",
      target: {
        type: "text",
        text: { kind: "regex", pattern: "聚合关系视图" },
      },
    },
    groupBy: [],
    metrics: [{ key: "edges", op: "count" }],
  });
  assert.equal(relationTargetTextFilter.groups[0]?.metrics[0]?.value, "1");

  const invalidRelationTargetRegex = await client.archives.aggregate.$post({
    json: archiveAggregationInputSchema.parse({
      scope: { kind: "current" },
      unit: "relation",
      relations: {
        direction: "outgoing",
        target: { type: "text", text: { kind: "regex", pattern: "[" } },
      },
      groupBy: [],
      metrics: [{ key: "edges", op: "count" }],
    }),
  });
  const invalidRelationTargetRegexText =
    await invalidRelationTargetRegex.text();
  const combinedInvalidRelationTargetRegex =
    await client.archives.aggregate.$post({
      json: archiveAggregationInputSchema.parse({
        scope: { kind: "current" },
        unit: "relation",
        text: { kind: "regex", pattern: ".*" },
        relations: {
          direction: "outgoing",
          target: { type: "text", text: { kind: "regex", pattern: "[" } },
        },
        groupBy: [],
        metrics: [{ key: "edges", op: "count" }],
      }),
    });
  const combinedInvalidRelationTargetRegexText =
    await combinedInvalidRelationTargetRegex.text();
  assert.equal(invalidRelationTargetRegex.status, 400);
  const invalidRelationTargetRegexError = archiveErrorSchema.parse(
    JSON.parse(invalidRelationTargetRegexText),
  );
  assert.equal(invalidRelationTargetRegexError.error.code, "invalid_input");
  assert.deepEqual(invalidRelationTargetRegexError.error.path, [
    "relations",
    "target",
    "text",
    "pattern",
  ]);
  assert.equal(combinedInvalidRelationTargetRegex.status, 400);
  const combinedInvalidRelationTargetRegexError = archiveErrorSchema.parse(
    JSON.parse(combinedInvalidRelationTargetRegexText),
  );
  assert.equal(
    combinedInvalidRelationTargetRegexError.error.code,
    "invalid_input",
  );
  assert.deepEqual(combinedInvalidRelationTargetRegexError.error.path, [
    "relations",
    "target",
    "text",
    "pattern",
  ]);

  const cycleKey = "aggregation-aba-" + runId;
  const cycleRevisions: string[] = [];
  for (const [index, cycle] of ["A", "B", "A"].entries()) {
    const commit = await submitArchive(client, {
      requestId: "e2e:archive:aggregation-aba:" + runId + ":" + index,
      binId: "rss-main",
      runId: "aggregation-aba-" + runId + "-" + index,
      items: [
        {
          sourceKey: { namespace: "e2e", key: cycleKey },
          body: { searchText: "聚合历史状态 " + cycle },
          properties: { cycle },
          capture: {
            scope: { case: "aggregation-aba" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    });
    const revisionId = commit.items[0]?.revisionId;
    assert.ok(revisionId);
    cycleRevisions.push(revisionId);
  }
  assert.equal(cycleRevisions[0], cycleRevisions[2]);
  assert.notEqual(cycleRevisions[0], cycleRevisions[1]);

  const abaWhere = {
    type: "field" as const,
    field: "sourceKey.key" as const,
    operator: "eq" as const,
    value: cycleKey,
  };
  const revisionHistory = await aggregate({
    scope: { kind: "revisions", binId: "rss-main" },
    unit: "revision",
    where: abaWhere,
    groupBy: [],
    metrics: [{ key: "units", op: "count" }],
  });
  assert.equal(revisionHistory.groups[0]?.metrics[0]?.value, "2");
  const observationHistory = await aggregate({
    scope: { kind: "observations", binId: "rss-main" },
    unit: "observation",
    where: abaWhere,
    groupBy: [],
    metrics: [{ key: "units", op: "count" }],
  });
  assert.equal(observationHistory.groups[0]?.metrics[0]?.value, "3");

  const timeKey = "aggregation-time-" + runId;
  const submitAt = async (suffix: string, observedAt: string) =>
    submitArchive(client, {
      requestId: "e2e:archive:aggregation-time:" + runId + ":" + suffix,
      binId: "rss-main",
      runId: "aggregation-time-" + runId + "-" + suffix,
      observedAt,
      items: [
        {
          sourceKey: { namespace: "e2e", key: timeKey },
          properties: { observation: suffix },
          capture: {
            scope: { case: "aggregation-time" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    });
  const tokyoFirstObservation = await submitAt(
    "tokyo-before",
    "2026-01-01T15:59:59.000Z",
  );
  await submitAt("tokyo-after", "2026-01-01T16:00:00.000Z");
  const tokyoBuckets = await aggregate({
    scope: { kind: "observations", binId: "rss-main" },
    unit: "observation",
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: timeKey,
    },
    groupBy: [
      {
        key: "day",
        type: "timeBucket",
        field: "observedAt",
        grain: "day",
        timeZone: "Asia/Shanghai",
      },
    ],
    metrics: [{ key: "observations", op: "count" }],
  });
  assert.deepEqual(
    tokyoBuckets.groups.map(({ keys }) => keys[0]?.result),
    [
      {
        status: "bucket",
        start: "2025-12-31T16:00:00.000Z",
        end: "2026-01-01T16:00:00.000Z",
      },
      {
        status: "bucket",
        start: "2026-01-01T16:00:00.000Z",
        end: "2026-01-02T16:00:00.000Z",
      },
    ],
  );
  const historicalBucket = await aggregate({
    scope: {
      kind: "asOf",
      binId: "rss-main",
      asOf: tokyoFirstObservation.archiveSeq,
    },
    unit: "item",
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: timeKey,
    },
    groupBy: [
      {
        key: "day",
        type: "timeBucket",
        field: "observedAt",
        grain: "day",
        timeZone: "Asia/Shanghai",
      },
    ],
    metrics: [{ key: "items", op: "count" }],
  });
  assert.deepEqual(historicalBucket.groups[0]?.keys[0]?.result, {
    status: "bucket",
    start: "2025-12-31T16:00:00.000Z",
    end: "2026-01-01T16:00:00.000Z",
  });
  assert.deepEqual(historicalBucket.groups[0]?.metrics, [
    { key: "items", op: "count", value: "1" },
  ]);

  const dstKey = "aggregation-dst-" + runId;
  await submitArchive(client, {
    requestId: "e2e:archive:aggregation-dst:" + runId,
    binId: "rss-main",
    runId: "aggregation-dst-" + runId,
    observedAt: "2026-03-08T12:00:00.000Z",
    items: [
      {
        sourceKey: { namespace: "e2e", key: dstKey },
        body: { searchText: "聚合时区边界" },
        capture: {
          scope: { case: "aggregation-dst" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const dstBucket = async (grain: "day" | "week" | "month") =>
    aggregate({
      scope: { kind: "observations", binId: "rss-main" },
      unit: "observation",
      where: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: dstKey,
      },
      groupBy: [
        {
          key: grain,
          type: "timeBucket",
          field: "observedAt",
          grain,
          timeZone: "America/New_York",
        },
      ],
      metrics: [{ key: "observations", op: "count" }],
    });
  const [dstDay, dstWeek, dstMonth] = await Promise.all([
    dstBucket("day"),
    dstBucket("week"),
    dstBucket("month"),
  ]);
  assert.deepEqual(dstDay.groups[0]?.keys[0]?.result, {
    status: "bucket",
    start: "2026-03-08T05:00:00.000Z",
    end: "2026-03-09T04:00:00.000Z",
  });
  assert.deepEqual(dstWeek.groups[0]?.keys[0]?.result, {
    status: "bucket",
    start: "2026-03-02T05:00:00.000Z",
    end: "2026-03-09T04:00:00.000Z",
  });
  assert.deepEqual(dstMonth.groups[0]?.keys[0]?.result, {
    status: "bucket",
    start: "2026-03-01T05:00:00.000Z",
    end: "2026-04-01T04:00:00.000Z",
  });
  const invalidTimeZone = await client.archives.aggregate.$post({
    json: archiveAggregationInputSchema.parse({
      scope: { kind: "observations", binId: "rss-main" },
      unit: "observation",
      where: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: dstKey,
      },
      groupBy: [
        {
          key: "day",
          type: "timeBucket",
          field: "observedAt",
          grain: "day",
          timeZone: "Mars/Olympus",
        },
      ],
      metrics: [{ key: "observations", op: "count" }],
    }),
  });
  assert.equal(invalidTimeZone.status, 400);
  if (invalidTimeZone.status === 400) {
    assert.deepEqual(
      archiveErrorSchema.parse(await invalidTimeZone.json()).error.path,
      ["groupBy", 0, "timeZone"],
    );
  }

  const relationCountFilter = await aggregate({
    scope: { kind: "current", binId: "rss-main" },
    unit: "item",
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "eq",
          value: relationRoot.key,
        },
        {
          type: "relation",
          direction: "outgoing",
          name: "aggregation-link",
          operator: "count",
          count: { operator: "eq", value: 1 },
        },
      ],
    },
    groupBy: [],
    metrics: [{ key: "items", op: "count" }],
  });
  assert.equal(relationCountFilter.groups[0]?.metrics[0]?.value, "1");

  const pathRoot = { namespace: "e2e", key: "aggregation-path-root-" + runId };
  const pathMiddle = {
    namespace: "e2e",
    key: "aggregation-path-middle-" + runId,
  };
  const pathEnd = { namespace: "e2e", key: "aggregation-path-end-" + runId };
  await submitArchive(client, {
    requestId: "e2e:archive:aggregation-path:" + runId,
    binId: "rss-main",
    items: (
      [
        [pathRoot, "有限路径根"],
        [pathMiddle, "有限路径中间对象"],
        [pathEnd, "有限路径终点"],
      ] as const
    ).map(([sourceKey, searchText]) => ({
      sourceKey,
      body: { searchText },
      capture: {
        scope: { case: "aggregation-path" },
        completeness: "complete" as const,
        missing: [],
      },
    })),
    relations: [
      {
        relationId: "e2e:aggregation-path-first:" + runId,
        value: {
          from: pathRoot,
          to: { sourceKey: pathMiddle },
          name: "aggregation-path-first",
          cascade: false,
        },
      },
      {
        relationId: "e2e:aggregation-path-second:" + runId,
        value: {
          from: pathMiddle,
          to: { sourceKey: pathEnd },
          name: "aggregation-path-second",
          cascade: false,
        },
      },
    ],
  });
  const finitePathFilter = await aggregate({
    scope: { kind: "current", binId: "rss-main" },
    unit: "item",
    text: { kind: "literal", value: "有限路径根" },
    where: {
      type: "path",
      steps: [
        { direction: "outgoing", name: "aggregation-path-first" },
        { direction: "outgoing", name: "aggregation-path-second" },
      ],
      operator: "exists",
    },
    groupBy: [],
    metrics: [{ key: "items", op: "count" }],
  });
  assert.equal(finitePathFilter.groups[0]?.metrics[0]?.value, "1");

  await submitArchive(client, {
    requestId: "e2e:archive:aggregation-budget:" + runId,
    binId: "rss-main",
    items: [
      {
        sourceKey: {
          namespace: "e2e",
          key: "aggregation-budget-" + runId,
        },
        body: { searchText: "a".repeat(250_000) },
        capture: {
          scope: { case: "aggregation-budget" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const overBudget = await client.archives.aggregate.$post({
    json: archiveAggregationInputSchema.parse({
      scope: { kind: "current" },
      unit: "item",
      text: { kind: "regex", pattern: ".*" },
      groupBy: [],
      metrics: [{ key: "items", op: "count" }],
      budgetMs: 1,
    }),
  });
  assert.equal(overBudget.status, 422);
  if (overBudget.status === 422) {
    assert.equal((await overBudget.json()).error.code, "query_budget_exceeded");
  }

  const invalid = await fetch(new URL("/archives/aggregate", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...groupedInput, unit: "unknown" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    archiveErrorSchema.parse(await invalid.json()).error.code,
    "invalid_input",
  );
}

async function verifySearchPagination(baseUrl: string): Promise<void> {
  const client = createApiClient(baseUrl);
  const resultIdOrderNeedle = "隐式resultId分页顺序needle";
  const firstOrderKey = "search-result-id-order-first";
  const secondOrderKey = "search-result-id-order-second";
  const firstOrderItem = await submitArchive(client, {
    requestId: "e2e:archive:search-result-id-order-first",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: firstOrderKey },
        body: { searchText: resultIdOrderNeedle + " initial" },
        capture: {
          scope: { case: "search-result-id-order" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const secondOrderItem = await submitArchive(client, {
    requestId: "e2e:archive:search-result-id-order-second",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: secondOrderKey },
        body: { searchText: resultIdOrderNeedle + " initial" },
        capture: {
          scope: { case: "search-result-id-order" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const firstOrderItemId = firstOrderItem.items[0]?.itemId;
  const secondOrderItemId = secondOrderItem.items[0]?.itemId;
  assert.ok(firstOrderItemId);
  assert.ok(secondOrderItemId);
  // UUID 只含 ASCII 字符，默认字符串序与 SQL C 序一致。
  const resultIdOrder = [firstOrderItemId, secondOrderItemId].toSorted();
  const smallerResultId = resultIdOrder[0]!;
  const smallerResultKey =
    firstOrderItemId === smallerResultId ? firstOrderKey : secondOrderKey;
  // 正文变化但保留命中词，确保小 ID 项的最新观察序号更大。
  await submitArchive(client, {
    requestId: "e2e:archive:search-result-id-order-later-observation",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: smallerResultKey },
        body: { searchText: resultIdOrderNeedle + " later" },
        capture: {
          scope: { case: "search-result-id-order" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const resultIdOrderQuery = {
    scope: { kind: "current" as const, binId: "rss-main" },
    text: { kind: "literal" as const, value: resultIdOrderNeedle },
    orderBy: [
      { field: "sourceKey.namespace" as const, direction: "asc" as const },
    ],
  };
  const completeOrderResponse = await client.archives.search.$post({
    json: { ...resultIdOrderQuery, limit: 10 },
  });
  if (completeOrderResponse.status !== 200) {
    throw new Error(
      "隐式 resultId 顺序完整搜索失败：" + (await completeOrderResponse.text()),
    );
  }
  const completeOrderPage = await completeOrderResponse.json();
  assert.deepEqual(
    completeOrderPage.results.map(({ itemId }) => itemId),
    resultIdOrder,
  );

  const pagedResultIds: string[] = [];
  let resultIdCursor: string | undefined;
  for (let pageIndex = 0; pageIndex < resultIdOrder.length; pageIndex += 1) {
    const pageResponse = await client.archives.search.$post({
      json:
        resultIdCursor === undefined
          ? { ...resultIdOrderQuery, limit: 1 }
          : { ...resultIdOrderQuery, limit: 1, cursor: resultIdCursor },
    });
    if (pageResponse.status !== 200) {
      throw new Error(
        "隐式 resultId 顺序分页失败：" + (await pageResponse.text()),
      );
    }
    const page = await pageResponse.json();
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0]?.itemId, resultIdOrder[pageIndex]);
    pagedResultIds.push(page.results[0]!.itemId);
    resultIdCursor = page.nextCursor;
    if (pageIndex + 1 < resultIdOrder.length) {
      assert.ok(resultIdCursor);
    } else {
      assert.equal(resultIdCursor, undefined);
    }
  }
  assert.equal(new Set(pagedResultIds).size, resultIdOrder.length);
  assert.deepEqual(
    pagedResultIds,
    completeOrderPage.results.map(({ itemId }) => itemId),
  );

  const pageA = await submitArchive(client, {
    requestId: "e2e:archive:search-page-a",
    binId: "rss-main",
    runId: "search-page-run",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "search-page-a" },
        sourceModifiedAt: "2026-10-28T04:00:00.000Z",
        properties: { rank: 1 },
        body: { searchText: "稳定分页唯一needle" },
        capture: {
          scope: { case: "search-page" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const pageB = await submitArchive(client, {
    requestId: "e2e:archive:search-page-b",
    binId: "rss-main",
    runId: "search-page-run",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "search-page-b" },
        sourceModifiedAt: "2026-10-28T04:00:00.000Z",
        properties: { rank: 1 },
        body: { searchText: "稳定分页唯一needle" },
        capture: {
          scope: { case: "search-page" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const pageNullTime = await submitArchive(client, {
    requestId: "e2e:archive:search-page-null-time",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "search-page-null-time" },
        properties: { rank: "0" },
        body: { searchText: "稳定分页唯一needle" },
        capture: {
          scope: { case: "search-page" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const baseQuery = {
    scope: { kind: "current" as const, binId: "rss-main" },
    text: { kind: "literal" as const, value: "稳定分页唯一needle" },
    select: [
      "runId" as const,
      {
        type: "json" as const,
        field: "properties" as const,
        path: ["rank"],
      },
    ],
    orderBy: [
      {
        field: "properties" as const,
        path: ["rank"],
        valueType: "number" as const,
        direction: "asc" as const,
      },
      { field: "sourceModifiedAt" as const, direction: "asc" as const },
      { field: "sourceKey.key" as const, direction: "asc" as const },
    ],
    limit: 1,
  };
  const firstResponse = await client.archives.search.$post({
    json: baseQuery,
  });
  if (firstResponse.status !== 200) {
    throw new Error("搜索首页面失败：" + (await firstResponse.text()));
  }
  const firstPage = await firstResponse.json();
  assert.equal(firstPage.results.length, 1);
  assert.equal(firstPage.results[0]?.itemId, pageA.items[0]?.itemId);
  assert.equal(firstPage.results[0]?.sourceKey, undefined);
  assert.equal(firstPage.results[0]?.matches[0]?.runId, "search-page-run");
  assert.equal(firstPage.results[0]?.matches[0]?.sourceRef, undefined);
  assert.equal(firstPage.results[0]?.matches[0]?.completeness, undefined);
  assert.equal(firstPage.results[0]?.matches[0]?.hit?.context, undefined);
  assert.deepEqual(firstPage.results[0]?.matches[0]?.json, [
    {
      field: "properties",
      path: ["rank"],
      exists: true,
      value: 1,
    },
  ]);
  assert.ok(firstPage.nextCursor);

  const [pageC, secondResponse, concurrentSecondResponse] = await Promise.all([
    submitArchive(client, {
      requestId: "e2e:archive:search-page-c",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "search-page-c" },
          sourceModifiedAt: "2026-10-28T04:00:00.000Z",
          properties: { rank: 0 },
          body: { searchText: "稳定分页唯一needle" },
          capture: {
            scope: { case: "search-page" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    }),
    client.archives.search.$post({
      json: { ...baseQuery, cursor: firstPage.nextCursor },
    }),
    client.archives.search.$post({
      json: { ...baseQuery, cursor: firstPage.nextCursor },
    }),
  ]);
  assert.ok(pageC.items[0]);
  if (secondResponse.status !== 200) {
    throw new Error("搜索后续页面失败：" + (await secondResponse.text()));
  }
  const secondPage = await secondResponse.json();
  assert.equal(secondPage.results.length, 1);
  assert.equal(secondPage.results[0]?.itemId, pageB.items[0]?.itemId);
  assert.ok(secondPage.nextCursor);
  assert.equal(secondPage.snapshot.asOf, firstPage.snapshot.asOf);
  if (concurrentSecondResponse.status !== 200) {
    throw new Error(
      "并发搜索后续页面失败：" + (await concurrentSecondResponse.text()),
    );
  }
  const concurrentSecondPage = await concurrentSecondResponse.json();
  assert.deepEqual(concurrentSecondPage.results, secondPage.results);
  assert.equal(concurrentSecondPage.snapshot.asOf, firstPage.snapshot.asOf);

  const thirdResponse = await client.archives.search.$post({
    json: { ...baseQuery, cursor: secondPage.nextCursor },
  });
  if (thirdResponse.status !== 200) {
    throw new Error("搜索 null 排序页失败：" + (await thirdResponse.text()));
  }
  const thirdPage = await thirdResponse.json();
  assert.equal(thirdPage.results.length, 1);
  assert.equal(thirdPage.results[0]?.itemId, pageNullTime.items[0]?.itemId);
  assert.equal(thirdPage.nextCursor, undefined);
  assert.equal(thirdPage.snapshot.asOf, firstPage.snapshot.asOf);
  assert.deepEqual(thirdPage.results[0]?.matches[0]?.json, [
    {
      field: "properties",
      path: ["rank"],
      exists: true,
      value: "0",
    },
  ]);

  const mismatchedCursor = await client.archives.search.$post({
    json: {
      ...baseQuery,
      text: { kind: "literal", value: "另一条查询" },
      cursor: firstPage.nextCursor,
    },
  });
  assert.equal(mismatchedCursor.status, 400);

  await submitArchive(client, {
    requestId: "e2e:archive:search-wide-regex-budget",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "search-wide-regex-budget" },
        body: { searchText: "a".repeat(250_000) },
        capture: {
          scope: { case: "search-budget" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const overBudget = await client.archives.search.$post({
    json: {
      scope: { kind: "current" },
      text: { kind: "regex", pattern: ".*" },
      budgetMs: 1,
      limit: 10,
    },
  });
  assert.equal(overBudget.status, 422);
  if (overBudget.status !== 422) return;
  assert.equal((await overBudget.json()).error.code, "query_budget_exceeded");
}

async function verifySearchJsonPathFilter(baseUrl: string): Promise<void> {
  const client = createApiClient(baseUrl);
  const searchJsonPage = async (
    json: Parameters<ArchiveClient["archives"]["search"]["$post"]>[0]["json"],
  ) => {
    const response = await client.archives.search.$post({ json });
    if (response.status !== 200) {
      throw new Error("JSON 路径查询失败：" + (await response.text()));
    }
    return response.json();
  };
  const numberLow = "json-number-low";
  const numberHigh = "json-number-high";
  const stringValue = "json-string";
  const missingValue = "json-missing";
  const prototypeValue = "json-prototype";
  const keys = [numberLow, numberHigh, stringValue, missingValue];
  const searchFixturePage = (
    condition: ArchiveSearchFilter,
    select: ArchiveSearchInput["select"] = ["sourceKey"],
  ) =>
    searchJsonPage({
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "and",
        conditions: [
          {
            type: "field",
            field: "sourceKey.key",
            operator: "in",
            values: keys,
          },
          condition,
        ],
      },
      select,
      orderBy: [{ field: "sourceKey.key" }],
      limit: 10,
    });
  const nestedPrototypeValue: unknown = JSON.parse(
    '{"__proto__":{"marker":1,"nested":{"__proto__":"preserve"}}}',
  );
  assert.ok(
    typeof nestedPrototypeValue === "object" && nestedPrototypeValue !== null,
  );
  const prototypePropertiesSource: unknown = JSON.parse(
    '{"__proto__":{"score":12}}',
  );
  assert.ok(
    typeof prototypePropertiesSource === "object" &&
      prototypePropertiesSource !== null,
  );
  const prototypeProperties: Record<string, unknown> = {
    ...prototypePropertiesSource,
    custom: nestedPrototypeValue,
  };
  assert.equal(Object.hasOwn(prototypeProperties, "__proto__"), true);
  await submitArchive(client, {
    requestId: "e2e:archive:search-json-path-filter",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: numberLow },
        properties: {
          profile: {
            score: 2,
            nullable: null,
            active: true,
            details: { name: "低", flags: ["a", 3] },
          },
          events: [{ score: 4 }, { score: 9 }],
        },
        metadata: { stats: { views: 7 } },
        capture: {
          scope: { case: "json-path" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: { namespace: "e2e", key: numberHigh },
        properties: { profile: { score: 10, nullable: null, active: false } },
        capture: {
          scope: { case: "json-path" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: { namespace: "e2e", key: stringValue },
        properties: {
          profile: { score: "10", nullable: "not null", active: true },
        },
        capture: {
          scope: { case: "json-path" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: { namespace: "e2e", key: missingValue },
        properties: { profile: { active: true } },
        capture: {
          scope: { case: "json-path" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: { namespace: "e2e", key: prototypeValue },
        properties: prototypeProperties,
        capture: {
          scope: { case: "json-path" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });

  const schemas = compilePublishedSchemas();
  const query = {
    scope: { kind: "current" as const, binId: "rss-main" },
    where: {
      type: "and" as const,
      conditions: [
        {
          type: "field" as const,
          field: "sourceKey.key" as const,
          operator: "in" as const,
          values: keys,
        },
        {
          type: "json" as const,
          field: "properties" as const,
          path: ["profile", "score"],
          valueType: "number" as const,
          operator: "gte" as const,
          value: 2,
        },
      ],
    },
    select: [
      "sourceKey" as const,
      {
        type: "json" as const,
        field: "properties" as const,
        path: ["profile", "score"],
      },
      {
        type: "json" as const,
        field: "properties" as const,
        path: ["profile", "nullable"],
      },
      {
        type: "json" as const,
        field: "properties" as const,
        path: ["profile", "details"],
      },
      {
        type: "json" as const,
        field: "properties" as const,
        path: ["events", 1, "score"],
      },
    ],
    orderBy: [
      {
        field: "properties" as const,
        path: ["profile", "score"],
        valueType: "number" as const,
        direction: "asc" as const,
      },
      { field: "sourceKey.key" as const, direction: "asc" as const },
    ],
    limit: 10,
  };
  assert.equal(schemas.apiInput(query), true);
  assert.equal(schemas.standardInput(query), true);
  const response = await client.archives.search.$post({ json: query });
  if (response.status !== 200) {
    throw new Error("JSON 路径数值过滤失败：" + (await response.text()));
  }
  const page = await response.json();
  assert.equal(
    schemas.apiOutput(page),
    true,
    JSON.stringify(schemas.apiOutput.errors),
  );
  assert.equal(
    schemas.standardOutput(page),
    true,
    JSON.stringify(schemas.standardOutput.errors),
  );
  assert.deepEqual(
    page.results.map(({ sourceKey }) => sourceKey?.key),
    [numberLow, numberHigh],
  );
  assert.deepEqual(page.results[0]?.matches[0]?.json, [
    {
      field: "properties",
      path: ["profile", "score"],
      exists: true,
      value: 2,
    },
    {
      field: "properties",
      path: ["profile", "nullable"],
      exists: true,
      value: null,
    },
    {
      field: "properties",
      path: ["profile", "details"],
      exists: true,
      value: { name: "低", flags: ["a", 3] },
    },
    {
      field: "properties",
      path: ["events", 1, "score"],
      exists: true,
      value: 9,
    },
  ]);

  const nullPage = await searchFixturePage(
    {
      type: "json",
      field: "properties",
      path: ["profile", "nullable"],
      valueType: "null",
      operator: "eq",
      value: null,
    },
    [
      "sourceKey",
      { type: "json", field: "properties", path: ["profile", "nullable"] },
    ],
  );
  assert.deepEqual(
    nullPage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberHigh, numberLow],
  );
  assert.deepEqual(nullPage.results[0]?.matches[0]?.json, [
    {
      field: "properties",
      path: ["profile", "nullable"],
      exists: true,
      value: null,
    },
  ]);

  const existsPage = await searchFixturePage({
    type: "json",
    field: "properties",
    path: ["profile", "nullable"],
    operator: "exists",
    value: true,
  });
  assert.deepEqual(
    existsPage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberHigh, numberLow, stringValue],
  );

  const missingPage = await searchFixturePage(
    {
      type: "json",
      field: "properties",
      path: ["profile", "score"],
      operator: "exists",
      value: false,
    },
    [
      "sourceKey",
      { type: "json", field: "properties", path: ["profile", "score"] },
    ],
  );
  assert.deepEqual(
    missingPage.results.map(({ sourceKey }) => sourceKey?.key),
    [missingValue],
  );
  assert.deepEqual(missingPage.results[0]?.matches[0]?.json, [
    {
      field: "properties",
      path: ["profile", "score"],
      exists: false,
    },
  ]);

  const notPage = await searchFixturePage({
    type: "not",
    condition: {
      type: "json",
      field: "properties",
      path: ["profile", "score"],
      valueType: "number",
      operator: "eq",
      value: 2,
    },
  });
  assert.deepEqual(
    notPage.results.map(({ sourceKey }) => sourceKey?.key),
    [missingValue, numberHigh, stringValue],
  );

  const rangePage = await searchFixturePage({
    type: "json",
    field: "properties",
    path: ["profile", "score"],
    valueType: "number",
    operator: "between",
    lower: 2,
    upper: 10,
  });
  assert.deepEqual(
    rangePage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberHigh, numberLow],
  );

  const collectionPage = await searchFixturePage({
    type: "json",
    field: "properties",
    path: ["profile", "score"],
    valueType: "number",
    operator: "in",
    values: [2, 10],
  });
  assert.deepEqual(
    collectionPage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberHigh, numberLow],
  );

  const stringComparePage = await searchFixturePage({
    type: "json",
    field: "properties",
    path: ["profile", "nullable"],
    valueType: "string",
    operator: "eq",
    value: "not null",
  });
  assert.deepEqual(
    stringComparePage.results.map(({ sourceKey }) => sourceKey?.key),
    [stringValue],
  );

  const notInPage = await searchFixturePage({
    type: "json",
    field: "properties",
    path: ["profile", "score"],
    valueType: "number",
    operator: "notIn",
    values: [2],
  });
  assert.deepEqual(
    notInPage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberHigh],
  );

  const composedPage = await searchFixturePage({
    type: "or",
    conditions: [
      {
        type: "json",
        field: "properties",
        path: ["profile", "score"],
        valueType: "number",
        operator: "eq",
        value: 2,
      },
      {
        type: "json",
        field: "properties",
        path: ["profile", "active"],
        valueType: "boolean",
        operator: "eq",
        value: false,
      },
    ],
  });
  assert.deepEqual(
    composedPage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberHigh, numberLow],
  );

  const nestedPathPage = await searchJsonPage({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "json",
          field: "metadata",
          path: ["stats", "views"],
          valueType: "number",
          operator: "eq",
          value: 7,
        },
        {
          type: "json",
          field: "properties",
          path: ["events", 1, "score"],
          valueType: "number",
          operator: "eq",
          value: 9,
        },
        {
          type: "json",
          field: "properties",
          path: ["profile", "details", "flags"],
          valueType: "array",
          operator: "eq",
          value: ["a", 3],
        },
        {
          type: "json",
          field: "properties",
          path: ["profile", "details"],
          valueType: "object",
          operator: "eq",
          value: { name: "低", flags: ["a", 3] },
        },
      ],
    },
    select: ["sourceKey"],
    limit: 10,
  });
  assert.deepEqual(
    nestedPathPage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberLow],
  );

  const prototypePage = await searchJsonPage({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "eq",
          value: prototypeValue,
        },
        {
          type: "json",
          field: "properties",
          path: ["__proto__", "score"],
          valueType: "number",
          operator: "eq",
          value: 12,
        },
        {
          type: "json",
          field: "properties",
          path: ["custom"],
          valueType: "object",
          operator: "eq",
          value: nestedPrototypeValue,
        },
      ],
    },
    select: [
      "sourceKey",
      { type: "json", field: "properties", path: ["__proto__"] },
      { type: "json", field: "properties", path: ["custom"] },
    ],
    limit: 10,
  });
  assert.deepEqual(
    prototypePage.results.map(({ sourceKey }) => sourceKey?.key),
    [prototypeValue],
  );
  const prototypeJson = prototypePage.results[0]?.matches[0]?.json;
  assert.deepEqual(prototypeJson, [
    {
      field: "properties",
      path: ["__proto__"],
      exists: true,
      value: { score: 12 },
    },
    {
      field: "properties",
      path: ["custom"],
      exists: true,
      value: nestedPrototypeValue,
    },
  ]);
  const projectedPrototypeValue = prototypeJson?.[1]?.value;
  assert.ok(
    typeof projectedPrototypeValue === "object" &&
      projectedPrototypeValue !== null &&
      !Array.isArray(projectedPrototypeValue),
  );
  assert.equal(Object.hasOwn(projectedPrototypeValue, "__proto__"), true);
  const projectedOwnPrototype = Object.getOwnPropertyDescriptor(
    projectedPrototypeValue,
    "__proto__",
  )?.value;
  assert.ok(
    typeof projectedOwnPrototype === "object" &&
      projectedOwnPrototype !== null &&
      !Array.isArray(projectedOwnPrototype),
  );
  const projectedNestedValue =
    "nested" in projectedOwnPrototype
      ? projectedOwnPrototype.nested
      : undefined;
  assert.ok(
    typeof projectedNestedValue === "object" &&
      projectedNestedValue !== null &&
      !Array.isArray(projectedNestedValue),
  );
  assert.equal(Object.hasOwn(projectedNestedValue, "__proto__"), true);

  const numericSortPage = await searchJsonPage({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "in",
      values: keys,
    },
    select: ["sourceKey"],
    orderBy: [
      {
        field: "properties",
        path: ["profile", "score"],
        valueType: "number",
      },
      { field: "sourceKey.key" },
    ],
    limit: 10,
  });
  assert.deepEqual(
    numericSortPage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberLow, numberHigh, missingValue, stringValue],
  );

  const stringSortPage = await searchJsonPage({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "in",
      values: keys,
    },
    select: ["sourceKey"],
    orderBy: [
      {
        field: "properties",
        path: ["profile", "nullable"],
        valueType: "string",
      },
      { field: "sourceKey.key" },
    ],
    limit: 10,
  });
  assert.deepEqual(
    stringSortPage.results.map(({ sourceKey }) => sourceKey?.key),
    [stringValue, missingValue, numberHigh, numberLow],
  );

  const booleanSortPage = await searchJsonPage({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "in",
      values: keys,
    },
    select: ["sourceKey"],
    orderBy: [
      {
        field: "properties",
        path: ["profile", "active"],
        valueType: "boolean",
      },
      { field: "sourceKey.key" },
    ],
    limit: 10,
  });
  assert.deepEqual(
    booleanSortPage.results.map(({ sourceKey }) => sourceKey?.key),
    [numberHigh, missingValue, numberLow, stringValue],
  );

  const cursorRunId = randomUUID();
  const cursorKeys = [
    "json-cursor-a:" + cursorRunId,
    "json-cursor-b:" + cursorRunId,
    "json-cursor-c:" + cursorRunId,
    "json-cursor-d:" + cursorRunId,
  ];
  const cursorCommit = await submitArchive(client, {
    requestId: "e2e:archive:search-json-cursor-delete:" + cursorRunId,
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: cursorKeys[0]! },
        properties: { rank: 2 },
        capture: {
          scope: { case: "json-cursor-delete" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: { namespace: "e2e", key: cursorKeys[1]! },
        properties: { rank: 10 },
        capture: {
          scope: { case: "json-cursor-delete" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: { namespace: "e2e", key: cursorKeys[2]! },
        properties: { rank: 9 },
        capture: {
          scope: { case: "json-cursor-delete" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: { namespace: "e2e", key: cursorKeys[3]! },
        properties: { rank: "not a number" },
        capture: {
          scope: { case: "json-cursor-delete" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const cursorAnchor = cursorCommit.items.find(
    ({ sourceKey }) => sourceKey.key === cursorKeys[1],
  );
  assert.ok(cursorAnchor);
  const cursorQuery = {
    scope: { kind: "current" as const, binId: "rss-main" },
    where: {
      type: "field" as const,
      field: "sourceKey.key" as const,
      operator: "in" as const,
      values: cursorKeys,
    },
    select: ["sourceKey" as const],
    orderBy: [
      {
        field: "properties" as const,
        path: ["rank"],
        valueType: "number" as const,
        direction: "desc" as const,
      },
      { field: "sourceKey.key" as const, direction: "asc" as const },
    ],
    limit: 1,
  };
  const cursorFirstPage = await searchJsonPage(cursorQuery);
  assert.deepEqual(
    cursorFirstPage.results.map(({ sourceKey }) => sourceKey?.key),
    [cursorKeys[1]],
  );
  assert.ok(cursorFirstPage.nextCursor);

  const cursorAnchorDeletion = await fetch(
    baseUrl + "/archives/items/" + cursorAnchor.itemId,
    { method: "DELETE" },
  );
  assert.equal(cursorAnchorDeletion.status, 200);
  if (cursorAnchorDeletion.status !== 200) {
    throw new Error("JSON 排序游标锚点硬删除失败。");
  }

  const retainedAtCursorSnapshot = await searchJsonPage({
    ...cursorQuery,
    scope: {
      kind: "asOf",
      binId: "rss-main",
      asOf: cursorFirstPage.snapshot.asOf,
    },
    limit: 10,
  });
  assert.deepEqual(
    retainedAtCursorSnapshot.results.map(({ sourceKey }) => sourceKey?.key),
    [cursorKeys[2], cursorKeys[0], cursorKeys[3]],
  );
  assert.equal(retainedAtCursorSnapshot.nextCursor, undefined);

  const deletedCursorResponse = await client.archives.search.$post({
    json: { ...cursorQuery, cursor: cursorFirstPage.nextCursor },
  });
  assert.equal(deletedCursorResponse.status, 400);
  if (deletedCursorResponse.status === 400) {
    const deletedCursorError = await deletedCursorResponse.json();
    assert.equal(deletedCursorError.error.code, "invalid_input");
    assert.deepEqual(deletedCursorError.error.path, ["cursor"]);
    assert.equal(
      deletedCursorError.error.message,
      "搜索游标已失效，请重新查询。",
    );
  }

  const retainedAnchorQuery = {
    ...cursorQuery,
    where: {
      type: "field" as const,
      field: "sourceKey.key" as const,
      operator: "in" as const,
      values: [cursorKeys[2]!, cursorKeys[3]!],
    },
  };
  const retainedAnchorPage = await searchJsonPage(retainedAnchorQuery);
  assert.deepEqual(
    retainedAnchorPage.results.map(({ sourceKey }) => sourceKey?.key),
    [cursorKeys[2]],
  );
  assert.ok(retainedAnchorPage.nextCursor);
  const tailAnchor = cursorCommit.items.find(
    ({ sourceKey }) => sourceKey.key === cursorKeys[3],
  );
  assert.ok(tailAnchor);
  const tailAnchorDeletion = await fetch(
    baseUrl + "/archives/items/" + tailAnchor.itemId,
    { method: "DELETE" },
  );
  assert.equal(tailAnchorDeletion.status, 200);
  if (tailAnchorDeletion.status !== 200) {
    throw new Error("JSON 排序游标尾项硬删除失败。");
  }
  const exhaustedCursorResponse = await client.archives.search.$post({
    json: { ...retainedAnchorQuery, cursor: retainedAnchorPage.nextCursor },
  });
  assert.equal(exhaustedCursorResponse.status, 200);
  if (exhaustedCursorResponse.status === 200) {
    const exhaustedCursorPage = await exhaustedCursorResponse.json();
    assert.deepEqual(exhaustedCursorPage.results, []);
    assert.equal(exhaustedCursorPage.nextCursor, undefined);
  }

  const budgetPage = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "json",
        field: "properties",
        path: ["profile", "score"],
        valueType: "number",
        operator: "gte",
        value: 0,
      },
      budgetMs: 1,
      limit: 10,
    },
  });
  assert.equal(budgetPage.status, 422);
  if (budgetPage.status === 422) {
    assert.equal((await budgetPage.json()).error.code, "query_budget_exceeded");
  }

  const unsafeNumberPage = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "json",
        field: "properties",
        path: ["profile", "score"],
        valueType: "number",
        operator: "eq",
        value: Number.MAX_SAFE_INTEGER + 1,
      },
      limit: 10,
    },
  });
  assert.equal(unsafeNumberPage.status, 400);

  const reversedRangePage = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "json",
        field: "properties",
        path: ["profile", "score"],
        valueType: "number",
        operator: "between",
        lower: 10,
        upper: 2,
      },
      limit: 10,
    },
  });
  assert.equal(reversedRangePage.status, 400);

  const invalidTextKey: unknown = JSON.parse('{"\\u0000":"bad"}');
  const invalidTextKeyPage = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "json",
        field: "properties",
        path: ["custom"],
        valueType: "object",
        operator: "eq",
        value: invalidTextKey,
      },
      limit: 10,
    },
  });
  assert.equal(invalidTextKeyPage.status, 400);
  if (invalidTextKeyPage.status === 400) {
    const invalidTextKeyError = await invalidTextKeyPage.json();
    assert.equal(invalidTextKeyError.error.code, "invalid_input");
    assert.ok(invalidTextKeyError.error.path?.includes("\u0000"));
  }
}

async function verifyRelationSearch(baseUrl: string): Promise<void> {
  const client = createApiClient(baseUrl);
  const rootSplit = { namespace: "e2e-relation-query", key: "split-root" };
  const rootEmpty = { namespace: "e2e-relation-query", key: "empty-root" };
  const targetAuthor = {
    namespace: "e2e-relation-query",
    key: "split-author-target",
  };
  const targetText = {
    namespace: "e2e-relation-query",
    key: "split-text-target",
  };
  const rootMatch = { namespace: "e2e-relation-query", key: "match-root" };
  const targetMatch = {
    namespace: "e2e-relation-query",
    key: "match-target",
  };
  const directionRoot = {
    namespace: "e2e-relation-query",
    key: "direction-root",
  };
  const directionSourceA = {
    namespace: "e2e-relation-query",
    key: "direction-source-a",
  };
  const directionSourceB = {
    namespace: "e2e-relation-query",
    key: "direction-source-b",
  };
  const directionSourceC = {
    namespace: "e2e-relation-query",
    key: "direction-source-c",
  };
  const directionTargetD = {
    namespace: "e2e-relation-query",
    key: "direction-target-d",
  };
  const fixtureCommit = await submitArchive(client, {
    requestId: "e2e:archive:relation-query:same-target",
    binId: "rss-main",
    items: [
      {
        sourceKey: rootSplit,
        body: { searchText: "关联筛选根对象" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: rootEmpty,
        body: { searchText: "没有关联的根对象" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: targetAuthor,
        properties: { author: "甲" },
        body: { searchText: "没有这个词" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: targetText,
        properties: { author: "乙" },
        body: { searchText: "目标词在另一个目标" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: rootMatch,
        body: { searchText: "另一个关联筛选根对象" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: targetMatch,
        properties: { author: "甲" },
        body: { searchText: "目标词和作者同在此目标" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: directionRoot,
        properties: { rank: 0 },
        body: { searchText: "root text" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: directionSourceA,
        properties: { rank: 2 },
        body: { searchText: "source a" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: directionSourceB,
        properties: { rank: "2" },
        body: { searchText: "source b" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: directionSourceC,
        properties: { rank: 3 },
        body: { searchText: "source c" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: directionTargetD,
        properties: { rank: 4 },
        body: { searchText: "target d" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
    relations: [
      {
        relationId: "e2e:relation-query:split-author",
        value: {
          from: rootSplit,
          to: { sourceKey: targetAuthor },
          name: "mentions",
          properties: { kind: "profile" },
          cascade: false,
        },
      },
      {
        relationId: "e2e:relation-query:split-text",
        value: {
          from: rootSplit,
          to: { sourceKey: targetText },
          name: "mentions",
          properties: { kind: "profile" },
          cascade: false,
        },
      },
      {
        relationId: "e2e:relation-query:zz-duplicate-target-edge",
        value: {
          from: rootSplit,
          to: { sourceKey: targetText },
          name: "mentions",
          properties: { kind: "profile" },
          cascade: false,
        },
      },
      {
        relationId: "e2e:relation-query:matching-target",
        value: {
          from: rootMatch,
          to: { sourceKey: targetMatch },
          name: "mentions",
          properties: { kind: "profile" },
          cascade: false,
        },
      },
      {
        relationId: "e2e:relation-query:incoming-authorship",
        value: {
          from: targetAuthor,
          to: { sourceKey: rootSplit },
          name: "authored-by",
          properties: { role: "author" },
          cascade: false,
        },
      },
      {
        relationId: "e2e:relation-query:withdrawn-edge",
        value: {
          from: rootEmpty,
          to: { sourceRef: "https://example.test/withdrawn" },
          name: "retired",
          properties: { reason: "no-longer-current" },
          cascade: false,
        },
      },
      ...[
        {
          from: directionSourceA,
          to: { sourceKey: directionRoot },
        },
        {
          from: directionSourceA,
          to: { sourceKey: directionRoot },
        },
        {
          from: directionSourceB,
          to: { sourceKey: directionRoot },
        },
        {
          from: directionSourceC,
          to: { sourceKey: directionRoot },
        },
        {
          from: directionRoot,
          to: { sourceKey: directionTargetD },
        },
      ].map(({ from, to }, index) => ({
        relationId: `e2e:relation-query:direction-${index}`,
        value: {
          from,
          to,
          name: "links",
          properties: { kind: "direction" },
          cascade: false,
        },
      })),
    ],
  });

  const pathRoot = { namespace: "e2e-relation-query", key: "path-root" };
  const pathEmpty = { namespace: "e2e-relation-query", key: "path-empty" };
  const pathB = { namespace: "e2e-relation-query", key: "path-b" };
  const pathC = { namespace: "e2e-relation-query", key: "path-c" };
  const pathD = { namespace: "e2e-relation-query", key: "path-d" };
  const pathUnknown = {
    namespace: "e2e-relation-query",
    key: "path-unknown-hop",
  };
  const pathForeign = {
    namespace: "e2e-relation-query",
    key: "path-foreign-hop",
  };
  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:path-endpoints",
    binId: "rss-secondary",
    items: [pathUnknown, pathForeign].map((sourceKey) => ({
      sourceKey,
      body: { searchText: "只在次要来源观察的路径端点" },
      capture: {
        scope: { case: "bounded-path" },
        completeness: "complete" as const,
        missing: [],
      },
    })),
  });
  const pathRelation = (
    relationId: string,
    from: { readonly namespace: string; readonly key: string },
    to:
      | {
          readonly sourceKey: {
            readonly namespace: string;
            readonly key: string;
          };
        }
      | { readonly sourceRef: string },
    name: string,
  ) => ({
    relationId,
    value: {
      from,
      to,
      name,
      properties: { case: "bounded-path" },
      cascade: false,
    },
  });
  const pathCommit = await submitArchive(client, {
    requestId: "e2e:archive:relation-query:bounded-paths",
    binId: "rss-main",
    items: [
      { sourceKey: pathRoot, searchText: "有限路径根" },
      { sourceKey: pathEmpty, searchText: "无路径根" },
      { sourceKey: pathB, searchText: "路径中间对象 B" },
      { sourceKey: pathC, searchText: "路径中间对象 C" },
      { sourceKey: pathD, searchText: "有限路径终点资料" },
    ].map(({ sourceKey, searchText }) => ({
      sourceKey,
      body: { searchText },
      properties: { pathRole: sourceKey.key },
      capture: {
        scope: { case: "bounded-path" },
        completeness: "complete" as const,
        missing: [],
      },
    })),
    relations: [
      pathRelation(
        "e2e:relation-query:path-first-a",
        pathRoot,
        { sourceKey: pathB },
        "path-first",
      ),
      pathRelation(
        "e2e:relation-query:path-first-b",
        pathRoot,
        { sourceKey: pathB },
        "path-first",
      ),
      pathRelation(
        "e2e:relation-query:path-first-c",
        pathRoot,
        { sourceKey: pathC },
        "path-first",
      ),
      pathRelation(
        "e2e:relation-query:path-first-unknown",
        pathRoot,
        { sourceKey: pathUnknown },
        "path-first",
      ),
      pathRelation(
        "e2e:relation-query:path-second-b",
        pathB,
        { sourceKey: pathD },
        "path-second",
      ),
      pathRelation(
        "e2e:relation-query:path-second-c",
        pathC,
        { sourceKey: pathD },
        "path-second",
      ),
      pathRelation(
        "e2e:relation-query:path-second-unknown",
        pathUnknown,
        { sourceKey: pathD },
        "path-second",
      ),
      pathRelation(
        "e2e:relation-query:path-cross-incoming",
        pathC,
        { sourceKey: pathB },
        "path-cross",
      ),
      pathRelation(
        "e2e:relation-query:path-self-loop",
        pathRoot,
        { sourceKey: pathRoot },
        "path-self",
      ),
      pathRelation(
        "e2e:relation-query:path-cycle",
        pathRoot,
        { sourceKey: pathB },
        "path-cycle",
      ),
      pathRelation(
        "e2e:relation-query:path-cycle-back",
        pathB,
        { sourceKey: pathRoot },
        "path-cycle",
      ),
      pathRelation(
        "e2e:relation-query:path-external",
        pathRoot,
        { sourceRef: "https://example.test/bounded-path-endpoint" },
        "path-external",
      ),
      pathRelation(
        'e2e:relation-query:prefix:"edge',
        pathRoot,
        { sourceKey: pathB },
        "path-sort",
      ),
      pathRelation(
        "e2e:relation-query:prefix:Aedge",
        pathRoot,
        { sourceKey: pathB },
        "path-sort",
      ),
      pathRelation(
        "e2e:relation-query:path-cross-bin-first",
        pathRoot,
        { sourceKey: pathForeign },
        "path-cross-bin-first",
      ),
    ],
  });
  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:path-cross-bin-second",
    binId: "rss-secondary",
    items: [],
    relations: [
      pathRelation(
        "e2e:relation-query:path-cross-bin-second",
        pathForeign,
        { sourceKey: pathD },
        "path-cross-bin-second",
      ),
    ],
  });

  const query: ArchiveSearchRequest = {
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "relation",
      direction: "outgoing",
      name: "mentions",
      properties: {
        type: "json",
        field: "properties",
        path: ["kind"],
        operator: "eq",
        valueType: "string",
        value: "profile",
      },
      target: {
        type: "and",
        conditions: [
          { type: "text", text: { kind: "literal", value: "目标词" } },
          {
            type: "json",
            field: "properties",
            path: ["author"],
            valueType: "string",
            operator: "eq",
            value: "甲",
          },
        ],
      },
      operator: "exists",
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  };
  const search = async (input: ArchiveSearchRequest) => {
    const response = await client.archives.search.$post({ json: input });
    if (response.status !== 200) {
      throw new Error("关系条件搜索失败：" + (await response.text()));
    }
    return response.json();
  };
  const searchDirectionRoot = (filter: ArchiveSearchFilter) =>
    search({
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "and",
        conditions: [
          {
            type: "field",
            field: "sourceKey.key",
            operator: "eq",
            value: "direction-root",
          },
          filter,
        ],
      },
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
      limit: 10,
    });
  const page = await search(query);
  assert.deepEqual(
    page.results.map(({ sourceKey }) => sourceKey?.key),
    ["match-root"],
  );

  const incomingRelation = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "eq",
          value: "split-root",
        },
        {
          type: "relation",
          direction: "incoming",
          name: "authored-by",
          operator: "exists",
        },
      ],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    incomingRelation.results.map(({ sourceKey }) => sourceKey?.key),
    ["split-root"],
  );
  const eitherRelation = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "eq",
          value: "split-root",
        },
        {
          type: "relation",
          direction: "either",
          name: "authored-by",
          operator: "exists",
        },
      ],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    eitherRelation.results.map(({ sourceKey }) => sourceKey?.key),
    ["split-root"],
  );

  const independentExists = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "in",
          values: ["split-root", "match-root", "empty-root"],
        },
        {
          type: "relation",
          direction: "outgoing",
          name: "mentions",
          target: {
            type: "json",
            field: "properties",
            path: ["author"],
            valueType: "string",
            operator: "eq",
            value: "甲",
          },
          operator: "exists",
        },
        {
          type: "relation",
          direction: "outgoing",
          name: "mentions",
          target: {
            type: "text",
            text: { kind: "literal", value: "目标词" },
          },
          operator: "exists",
        },
      ],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    independentExists.results.map(({ sourceKey }) => sourceKey?.key),
    ["match-root", "split-root"],
  );

  const countMatches = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "in",
          values: ["split-root", "match-root", "empty-root"],
        },
        {
          type: "relation",
          direction: "outgoing",
          name: "mentions",
          properties: {
            type: "json",
            field: "properties",
            path: ["kind"],
            valueType: "string",
            operator: "eq",
            value: "profile",
          },
          operator: "count",
          count: { operator: "eq", value: 2 },
        },
      ],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    countMatches.results.map(({ sourceKey }) => sourceKey?.key),
    ["split-root"],
  );

  const incomingCount = await searchDirectionRoot({
    type: "relation",
    direction: "incoming",
    name: "links",
    operator: "count",
    count: { operator: "gte", value: 3 },
  });
  assert.deepEqual(
    incomingCount.results.map(({ sourceKey }) => sourceKey?.key),
    ["direction-root"],
  );
  const incomingSingleCount = await searchDirectionRoot({
    type: "relation",
    direction: "incoming",
    name: "links",
    operator: "count",
    count: { operator: "eq", value: 1 },
  });
  assert.deepEqual(incomingSingleCount.results, []);
  const eitherCount = await searchDirectionRoot({
    type: "relation",
    direction: "either",
    name: "links",
    operator: "count",
    count: { operator: "eq", value: 4 },
  });
  assert.deepEqual(
    eitherCount.results.map(({ sourceKey }) => sourceKey?.key),
    ["direction-root"],
  );
  const eitherIncomingTarget = await searchDirectionRoot({
    type: "relation",
    direction: "either",
    name: "links",
    target: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "eq",
          value: "direction-source-a",
        },
        {
          type: "text",
          text: { kind: "literal", value: "source a" },
        },
        {
          type: "json",
          field: "properties",
          path: ["rank"],
          valueType: "number",
          operator: "eq",
          value: 2,
        },
      ],
    },
    operator: "exists",
  });
  assert.deepEqual(
    eitherIncomingTarget.results.map(({ sourceKey }) => sourceKey?.key),
    ["direction-root"],
  );
  const incomingTargetKey = await searchDirectionRoot({
    type: "relation",
    direction: "incoming",
    name: "links",
    target: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: "direction-source-a",
    },
    operator: "exists",
  });
  assert.deepEqual(
    incomingTargetKey.results.map(({ sourceKey }) => sourceKey?.key),
    ["direction-root"],
  );
  const incomingTextTarget = await searchDirectionRoot({
    type: "relation",
    direction: "incoming",
    name: "links",
    target: {
      type: "text",
      text: { kind: "literal", value: "source a" },
    },
    operator: "exists",
  });
  assert.deepEqual(
    incomingTextTarget.results.map(({ sourceKey }) => sourceKey?.key),
    ["direction-root"],
  );
  const incomingRootAsTarget = await searchDirectionRoot({
    type: "relation",
    direction: "incoming",
    name: "links",
    target: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: "direction-root",
    },
    operator: "exists",
  });
  assert.deepEqual(incomingRootAsTarget.results, []);
  const incomingNumericTarget = await searchDirectionRoot({
    type: "relation",
    direction: "incoming",
    name: "links",
    target: {
      type: "json",
      field: "properties",
      path: ["rank"],
      valueType: "number",
      operator: "eq",
      value: 2,
    },
    operator: "exists",
  });
  assert.deepEqual(
    incomingNumericTarget.results.map(({ sourceKey }) => sourceKey?.key),
    ["direction-root"],
  );
  const incomingTextNotExists = await searchDirectionRoot({
    type: "relation",
    direction: "incoming",
    name: "links",
    target: {
      type: "text",
      text: { kind: "literal", value: "source a" },
    },
    operator: "notExists",
  });
  assert.deepEqual(incomingTextNotExists.results, []);

  const notExists = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "in",
          values: ["split-root", "match-root", "empty-root"],
        },
        {
          type: "relation",
          direction: "outgoing",
          name: "mentions",
          operator: "notExists",
        },
      ],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    notExists.results.map(({ sourceKey }) => sourceKey?.key),
    ["empty-root"],
  );

  const historicalPredicate: ArchiveSearchFilter = {
    type: "relation",
    direction: "outgoing",
    name: "mentions",
    target: {
      type: "json",
      field: "properties",
      path: ["author"],
      valueType: "string",
      operator: "eq",
      value: "甲",
    },
    operator: "exists",
  };
  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:rename-edge",
    binId: "rss-main",
    items: [],
    relations: [
      {
        relationId: "e2e:relation-query:split-author",
        value: {
          from: rootSplit,
          to: { sourceKey: targetAuthor },
          name: "cites",
          properties: { kind: "profile" },
          cascade: false,
        },
      },
    ],
  });
  const currentRenamedRelation = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "eq",
          value: "split-root",
        },
        historicalPredicate,
      ],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(currentRenamedRelation.results, []);

  const historicalRelation = await search({
    scope: { kind: "asOf", binId: "rss-main", asOf: fixtureCommit.archiveSeq },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "eq",
          value: "split-root",
        },
        historicalPredicate,
      ],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    historicalRelation.results.map(({ sourceKey }) => sourceKey?.key),
    ["split-root"],
  );
  const historicalExpansion = await search({
    scope: { kind: "asOf", binId: "rss-main", asOf: fixtureCommit.archiveSeq },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: "split-root",
    },
    expand: [
      { key: "mentions", direction: "outgoing", name: "mentions", limit: 10 },
    ],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    historicalExpansion.results[0]?.matches[0]?.expansions?.[0]?.relations.map(
      ({ relationId }) => relationId,
    ),
    [
      "e2e:relation-query:split-author",
      "e2e:relation-query:split-text",
      "e2e:relation-query:zz-duplicate-target-edge",
    ],
  );

  const foreignTarget = {
    namespace: "e2e-relation-query",
    key: "foreign-target",
  };
  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:foreign-target",
    binId: "rss-secondary",
    items: [
      {
        sourceKey: foreignTarget,
        body: { searchText: "只在另一来源中的目标词" },
        properties: { author: "甲" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const foreignRoot = {
    namespace: "e2e-relation-query",
    key: "foreign-root",
  };
  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:foreign-edge",
    binId: "rss-main",
    items: [
      {
        sourceKey: foreignRoot,
        body: { searchText: "外来源目标测试根" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
    relations: [
      {
        relationId: "e2e:relation-query:foreign-edge",
        value: {
          from: foreignRoot,
          to: { sourceKey: foreignTarget },
          name: "mentions",
          properties: { kind: "profile" },
          cascade: false,
        },
      },
    ],
  });
  const noCrossBinTarget = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.key",
          operator: "eq",
          value: "foreign-root",
        },
        {
          type: "relation",
          direction: "outgoing",
          name: "mentions",
          target: {
            type: "text",
            text: { kind: "literal", value: "另一来源" },
          },
          operator: "exists",
        },
      ],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(noCrossBinTarget.results, []);

  const unknownTargetExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: "foreign-root",
    },
    expand: [{ key: "all", direction: "outgoing" }],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.equal(unknownTargetExpansion.results.length, 1);
  assert.equal(
    unknownTargetExpansion.results[0]?.matches[0]?.expansions?.[0]?.relations[0]
      ?.status,
    "observed",
  );
  const unknownTargetRelation =
    unknownTargetExpansion.results[0]?.matches[0]?.expansions?.[0]
      ?.relations[0];
  assert.ok(
    unknownTargetRelation !== undefined && "to" in unknownTargetRelation,
  );
  assert.equal(unknownTargetRelation.to.kind, "item");
  if (unknownTargetRelation.to.kind === "item") {
    assert.equal(unknownTargetRelation.to.status, "unknown");
  }

  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:second-bin-root-view",
    binId: "rss-secondary",
    items: [
      {
        sourceKey: rootSplit,
        body: { searchText: "第二来源中的相同根条目" },
        capture: {
          scope: { case: "relation-query" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:second-bin-cites-edge",
    binId: "rss-secondary",
    items: [],
    relations: [
      {
        relationId: "e2e:relation-query:secondary-cites",
        value: {
          from: rootSplit,
          to: { sourceRef: "https://example.test/secondary-citation" },
          name: "cites",
          properties: { kind: "external" },
          cascade: false,
        },
      },
    ],
  });
  const expandResponse = await fetch(baseUrl + "/archives/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: { kind: "current" },
      where: {
        type: "and",
        conditions: [
          {
            type: "field",
            field: "sourceKey.key",
            operator: "eq",
            value: "split-root",
          },
          {
            type: "relation",
            direction: "outgoing",
            name: "cites",
            operator: "exists",
          },
        ],
      },
      expand: [
        { key: "all", direction: "outgoing", limit: 1 },
        {
          key: "mentions",
          direction: "outgoing",
          name: "mentions",
          properties: {
            type: "json",
            field: "properties",
            path: ["kind"],
            valueType: "string",
            operator: "eq",
            value: "profile",
          },
          limit: 1,
        },
        {
          key: "authorship",
          direction: "incoming",
          name: "authored-by",
        },
      ],
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
      limit: 10,
    }),
  });
  if (expandResponse.status !== 200) {
    throw new Error("独立关系展开失败：" + (await expandResponse.text()));
  }
  const expandedPage = (await expandResponse.json()) as {
    readonly results: readonly {
      readonly sourceKey?: { readonly key: string };
      readonly matches: readonly {
        readonly binId: string;
        readonly expansions: readonly {
          readonly key: string;
          readonly hasMore: boolean;
          readonly relations: readonly {
            readonly relationId: string;
            readonly direction: string;
            readonly status: string;
          }[];
        }[];
      }[];
    }[];
  };
  assert.equal(expandedPage.results.length, 1);
  assert.equal(expandedPage.results[0]?.sourceKey?.key, "split-root");
  assert.deepEqual(
    expandedPage.results[0]?.matches.map(({ binId }) => binId),
    ["rss-main", "rss-secondary"],
  );
  const mainMatch = expandedPage.results[0]?.matches.find(
    ({ binId }) => binId === "rss-main",
  );
  const secondaryMatch = expandedPage.results[0]?.matches.find(
    ({ binId }) => binId === "rss-secondary",
  );
  const mainAllExpansion = mainMatch?.expansions.find(
    ({ key }) => key === "all",
  );
  assert.deepEqual(
    mainAllExpansion?.relations.map(({ relationId }) => relationId),
    ["e2e:relation-query:split-author"],
  );
  assert.equal(mainAllExpansion?.hasMore, true);
  const mainMentionsExpansion = mainMatch?.expansions.find(
    ({ key }) => key === "mentions",
  );
  assert.deepEqual(
    mainMentionsExpansion?.relations.map(({ relationId }) => relationId),
    ["e2e:relation-query:split-text"],
  );
  assert.equal(mainMentionsExpansion?.hasMore, true);
  const authorshipExpansion = mainMatch?.expansions.find(
    ({ key }) => key === "authorship",
  );
  assert.deepEqual(
    authorshipExpansion?.relations.map(({ relationId, direction }) => ({
      relationId,
      direction,
    })),
    [
      {
        relationId: "e2e:relation-query:incoming-authorship",
        direction: "incoming",
      },
    ],
  );
  assert.deepEqual(
    secondaryMatch?.expansions.map(({ key, relations, hasMore }) => ({
      key,
      relations: relations.map(({ relationId, status }) => ({
        relationId,
        status,
      })),
      hasMore,
    })),
    [
      {
        key: "all",
        relations: [
          {
            relationId: "e2e:relation-query:secondary-cites",
            status: "observed",
          },
        ],
        hasMore: false,
      },
      { key: "mentions", relations: [], hasMore: false },
      { key: "authorship", relations: [], hasMore: false },
    ],
  );

  const pagedExpansionQuery: ArchiveSearchRequest = {
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "in",
      values: ["match-root", "split-root"],
    },
    expand: [{ key: "all", direction: "outgoing", limit: 1 }],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 1,
  };
  const firstRootPage = await search(pagedExpansionQuery);
  assert.deepEqual(
    firstRootPage.results.map(({ sourceKey }) => sourceKey?.key),
    ["match-root"],
  );
  assert.ok(firstRootPage.nextCursor !== undefined);
  assert.deepEqual(
    firstRootPage.results[0]?.matches[0]?.expansions?.[0]?.relations.map(
      ({ relationId }) => relationId,
    ),
    ["e2e:relation-query:matching-target"],
  );
  const secondRootPage = await search({
    ...pagedExpansionQuery,
    cursor: firstRootPage.nextCursor,
  });
  assert.deepEqual(
    secondRootPage.results.map(({ sourceKey }) => sourceKey?.key),
    ["split-root"],
  );
  assert.equal(
    secondRootPage.results[0]?.matches[0]?.expansions?.[0]?.hasMore,
    true,
  );

  const emptyExpandResponse = await fetch(baseUrl + "/archives/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: "empty-root",
      },
      expand: [{ key: "mentions", direction: "outgoing", name: "mentions" }],
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
      limit: 10,
    }),
  });
  if (emptyExpandResponse.status !== 200) {
    throw new Error("空关系展开失败：" + (await emptyExpandResponse.text()));
  }
  const emptyExpandedPage = (await emptyExpandResponse.json()) as {
    readonly results: readonly {
      readonly sourceKey?: { readonly key: string };
      readonly matches: readonly {
        readonly expansions: readonly {
          readonly key: string;
          readonly hasMore: boolean;
          readonly relations: readonly unknown[];
        }[];
      }[];
    }[];
  };
  assert.equal(emptyExpandedPage.results.length, 1);
  assert.equal(emptyExpandedPage.results[0]?.sourceKey?.key, "empty-root");
  assert.deepEqual(emptyExpandedPage.results[0]?.matches[0]?.expansions, [
    {
      key: "mentions",
      direction: "outgoing",
      name: "mentions",
      relations: [],
      hasMore: false,
    },
  ]);

  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:withdraw-edge",
    binId: "rss-main",
    items: [],
    relations: [
      { relationId: "e2e:relation-query:withdrawn-edge", value: null },
    ],
  });
  const withdrawnExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: "empty-root",
    },
    expand: [{ key: "all", direction: "outgoing" }],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    withdrawnExpansion.results[0]?.matches[0]?.expansions?.[0]?.relations.map(
      ({ relationId, status }) => ({ relationId, status }),
    ),
    [{ relationId: "e2e:relation-query:withdrawn-edge", status: "withdrawn" }],
  );

  const targetMatchId = fixtureCommit.items.find(
    ({ sourceKey }) => sourceKey.key === "match-target",
  )?.itemId;
  assert.ok(targetMatchId !== undefined);
  const hardDeleteResponse = await fetch(
    baseUrl + "/archives/items/" + targetMatchId,
    { method: "DELETE" },
  );
  assert.equal(hardDeleteResponse.status, 200);
  const deletedGapExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: "match-root",
    },
    expand: [{ key: "all", direction: "outgoing" }],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    deletedGapExpansion.results[0]?.matches[0]?.expansions?.[0]?.relations.map(
      ({ relationId, status }) => ({ relationId, status }),
    ),
    [{ relationId: "e2e:relation-query:matching-target", status: "deleted" }],
  );

  const pathRootFilter: ArchiveSearchFilter = {
    type: "field",
    field: "sourceKey.key",
    operator: "eq",
    value: pathRoot.key,
  };
  const searchPathRoot = (
    filter: ArchiveSearchFilter,
    scope: ArchiveSearchRequest["scope"] = {
      kind: "current",
      binId: "rss-main",
    },
  ) =>
    search({
      scope,
      where: { type: "and", conditions: [pathRootFilter, filter] },
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
      limit: 10,
    });
  const twoHopPath: ArchiveSearchFilter = {
    type: "path",
    steps: [
      { direction: "outgoing", name: "path-first" },
      {
        direction: "outgoing",
        name: "path-second",
        target: {
          type: "text",
          text: { kind: "literal", value: "有限路径终点资料" },
        },
      },
    ],
    operator: "count",
    count: { operator: "eq", value: 1 },
  };
  const twoHopPage = await searchPathRoot(twoHopPath);
  assert.equal(twoHopPage.unit, "item");
  assert.deepEqual(
    twoHopPage.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const twoHopExists = await searchPathRoot({
    type: "path",
    steps: twoHopPath.steps,
    operator: "exists",
  });
  assert.deepEqual(
    twoHopExists.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const zeroPathCount = await searchPathRoot({
    type: "path",
    steps: [
      { direction: "outgoing", name: "path-first" },
      { direction: "outgoing", name: "no-such-path-step" },
    ],
    operator: "count",
    count: { operator: "eq", value: 0 },
  });
  assert.deepEqual(
    zeroPathCount.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const absentPath = await searchPathRoot({
    type: "path",
    steps: [{ direction: "outgoing", name: "no-such-path-step" }],
    operator: "notExists",
  });
  assert.deepEqual(
    absentPath.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );

  const twoHopExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: pathRootFilter,
    expandPaths: [
      {
        key: "two-hop",
        steps: [
          { direction: "outgoing", name: "path-first" },
          { direction: "outgoing", name: "path-second" },
        ],
        limit: 2,
      },
    ],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    twoHopExpansion.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const expandedPaths =
    twoHopExpansion.results[0]?.matches[0]?.pathExpansions?.[0];
  assert.ok(expandedPaths !== undefined);
  assert.equal(expandedPaths.paths.length, 2);
  assert.equal(expandedPaths.hasMore, true);
  assert.deepEqual(
    expandedPaths.paths.map((path) =>
      path.steps.map(({ relationId }) => relationId),
    ),
    [
      ["e2e:relation-query:path-first-a", "e2e:relation-query:path-second-b"],
      ["e2e:relation-query:path-first-b", "e2e:relation-query:path-second-b"],
    ],
  );
  assert.equal(expandedPaths.paths[0]?.steps[0]?.state.name, "path-first");
  assert.match(
    expandedPaths.paths[0]?.steps[0]?.observation.archiveSeq ?? "",
    /^\d+$/u,
  );
  const directPathResponse = await fetch(baseUrl + "/archives/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: { kind: "current", binId: "rss-main" },
      where: pathRootFilter,
      expandPaths: [
        {
          key: "direct-two-hop",
          steps: [
            { direction: "outgoing", name: "path-first" },
            { direction: "outgoing", name: "path-second" },
          ],
          limit: 1,
        },
      ],
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
      limit: 10,
    }),
  });
  assert.equal(directPathResponse.status, 200);
  const directPathPage = archiveSearchPageSchema.parse(
    await directPathResponse.json(),
  );
  assert.deepEqual(
    directPathPage.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  assert.equal(
    directPathPage.results[0]?.matches[0]?.pathExpansions?.[0]?.paths.length,
    1,
  );

  const pathSortIds = [
    'e2e:relation-query:prefix:"edge',
    "e2e:relation-query:prefix:Aedge",
  ];
  const completeSortExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: pathRootFilter,
    expandPaths: [
      {
        key: "c-sorted",
        steps: [{ direction: "outgoing", name: "path-sort" }],
        limit: 10,
      },
    ],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  const completeSortedPaths =
    completeSortExpansion.results[0]?.matches[0]?.pathExpansions?.[0];
  assert.ok(completeSortedPaths !== undefined);
  assert.deepEqual(
    completeSortedPaths.paths.map(({ steps }) => steps[0]?.relationId),
    pathSortIds,
  );
  assert.equal(completeSortedPaths.hasMore, false);

  const limitedSortExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: pathRootFilter,
    expandPaths: [
      {
        key: "c-sorted-limit-one",
        steps: [{ direction: "outgoing", name: "path-sort" }],
        limit: 1,
      },
    ],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  const limitedSortedPaths =
    limitedSortExpansion.results[0]?.matches[0]?.pathExpansions?.[0];
  assert.ok(limitedSortedPaths !== undefined);
  assert.deepEqual(
    limitedSortedPaths.paths.map(({ steps }) => steps[0]?.relationId),
    [pathSortIds[0]],
  );
  assert.equal(limitedSortedPaths.hasMore, true);

  const unknownPath = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: pathRootFilter,
    expandPaths: [
      {
        key: "unknown-hop",
        steps: [
          { direction: "outgoing", name: "path-first" },
          { direction: "outgoing", name: "path-second" },
        ],
        limit: 10,
      },
    ],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  const unknownOnlyPath =
    unknownPath.results[0]?.matches[0]?.pathExpansions?.[0]?.paths.find(
      ({ steps }) =>
        steps[0]?.relationId === "e2e:relation-query:path-first-unknown",
    );
  assert.equal(unknownOnlyPath?.steps[0]?.to.kind, "item");
  if (unknownOnlyPath?.steps[0]?.to.kind === "item") {
    assert.equal(unknownOnlyPath.steps[0].to.status, "unknown");
  }
  assert.equal(unknownOnlyPath?.steps[1]?.from.status, "unknown");

  const unknownTargetNot = await searchPathRoot({
    type: "path",
    steps: [
      {
        direction: "outgoing",
        name: "path-first",
        target: {
          type: "not",
          condition: {
            type: "field",
            field: "sourceKey.key",
            operator: "eq",
            value: "not-present",
          },
        },
      },
    ],
    operator: "count",
    count: { operator: "eq", value: 2 },
  });
  assert.deepEqual(
    unknownTargetNot.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );

  const incomingEitherSteps = [
    {
      direction: "outgoing",
      name: "path-first",
      target: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: pathB.key,
      },
    },
    {
      direction: "incoming",
      name: "path-cross",
      target: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: pathC.key,
      },
    },
    {
      direction: "either",
      name: "path-second",
      target: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: pathD.key,
      },
    },
  ] satisfies ArchiveSearchPathStep[];
  const incomingEither = await searchPathRoot({
    type: "path",
    steps: incomingEitherSteps,
    operator: "exists",
  });
  assert.deepEqual(
    incomingEither.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const mixedExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: pathRootFilter,
    expandPaths: [{ key: "mixed", steps: incomingEitherSteps, limit: 10 }],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    mixedExpansion.results[0]?.matches[0]?.pathExpansions?.[0]?.paths.map(
      ({ steps }) => steps.map(({ direction }) => direction),
    ),
    [
      ["outgoing", "incoming", "outgoing"],
      ["outgoing", "incoming", "outgoing"],
    ],
  );

  const repeatedCycleSteps = [
    {
      direction: "outgoing",
      name: "path-cycle",
      target: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: pathB.key,
      },
    },
    {
      direction: "incoming",
      name: "path-first",
      target: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: pathRoot.key,
      },
    },
    {
      direction: "outgoing",
      name: "path-cycle",
      target: {
        type: "field",
        field: "sourceKey.key",
        operator: "eq",
        value: pathB.key,
      },
    },
  ] satisfies ArchiveSearchPathStep[];
  const repeatedCycle = await searchPathRoot({
    type: "path",
    steps: repeatedCycleSteps,
    operator: "count",
    count: { operator: "eq", value: 1 },
  });
  assert.deepEqual(
    repeatedCycle.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const repeatedCycleExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: pathRootFilter,
    expandPaths: [{ key: "cycle", steps: repeatedCycleSteps, limit: 10 }],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.ok(
    repeatedCycleExpansion.results[0]?.matches[0]?.pathExpansions?.[0]?.paths.some(
      ({ steps }) =>
        steps.map(({ relationId }) => relationId).join("|") ===
        [
          "e2e:relation-query:path-cycle",
          "e2e:relation-query:path-first-a",
          "e2e:relation-query:path-cycle",
        ].join("|"),
    ),
  );

  const selfLoopSteps = [
    { direction: "either", name: "path-self" },
  ] satisfies ArchiveSearchPathStep[];
  const selfLoop = await searchPathRoot({
    type: "path",
    steps: selfLoopSteps,
    operator: "count",
    count: { operator: "eq", value: 1 },
  });
  assert.deepEqual(
    selfLoop.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const selfLoopExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: pathRootFilter,
    expandPaths: [{ key: "self", steps: selfLoopSteps, limit: 10 }],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    selfLoopExpansion.results[0]?.matches[0]?.pathExpansions?.[0]?.paths.map(
      ({ steps }) =>
        steps.map(({ direction, relationId }) => ({
          direction,
          relationId,
        })),
    ),
    [
      [
        {
          direction: "outgoing",
          relationId: "e2e:relation-query:path-self-loop",
        },
      ],
    ],
  );

  const externalPath = await searchPathRoot({
    type: "path",
    steps: [{ direction: "outgoing", name: "path-external" }],
    operator: "count",
    count: { operator: "eq", value: 1 },
  });
  assert.deepEqual(
    externalPath.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const externalExpansion = await search({
    scope: { kind: "current", binId: "rss-main" },
    where: pathRootFilter,
    expandPaths: [
      {
        key: "external",
        steps: [{ direction: "outgoing", name: "path-external" }],
      },
    ],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  const externalEndpoint =
    externalExpansion.results[0]?.matches[0]?.pathExpansions?.[0]?.paths[0]
      ?.steps[0]?.to;
  assert.deepEqual(externalEndpoint, {
    kind: "sourceRef",
    sourceRef: "https://example.test/bounded-path-endpoint",
  });
  const sourceRefCannotContinue = await searchPathRoot({
    type: "path",
    steps: [
      { direction: "outgoing", name: "path-external" },
      { direction: "either", name: "path-second" },
    ],
    operator: "count",
    count: { operator: "eq", value: 0 },
  });
  assert.deepEqual(
    sourceRefCannotContinue.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );

  const noCrossBinStitch = await searchPathRoot({
    type: "path",
    steps: [
      { direction: "outgoing", name: "path-cross-bin-first" },
      { direction: "outgoing", name: "path-cross-bin-second" },
    ],
    operator: "count",
    count: { operator: "eq", value: 0 },
  });
  assert.deepEqual(
    noCrossBinStitch.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );

  const invalidPathThroughClient = await client.archives.search.$post({
    json: {
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "path",
        steps: [],
        operator: "exists",
      },
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    },
  });
  assert.equal(invalidPathThroughClient.status, 400);
  if (invalidPathThroughClient.status === 400) {
    assert.equal(
      (await invalidPathThroughClient.json()).error.code,
      "invalid_input",
    );
  }

  const wrongPathDirection = await fetch(baseUrl + "/archives/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "path",
        steps: [{ direction: "outgoing" }, { direction: "sideways" }],
        operator: "exists",
      },
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    }),
  });
  assert.equal(wrongPathDirection.status, 400);
  const wrongPathDirectionBody = archiveErrorSchema.parse(
    await wrongPathDirection.json(),
  );
  assert.equal(wrongPathDirectionBody.error.code, "invalid_input");
  assert.deepEqual(wrongPathDirectionBody.error.path, [
    "where",
    "steps",
    1,
    "direction",
  ]);

  const invalidPathRegex = await fetch(baseUrl + "/archives/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: { kind: "current", binId: "rss-main" },
      where: {
        type: "path",
        steps: [
          {
            direction: "outgoing",
            target: {
              type: "text",
              text: { kind: "regex", pattern: "(" },
            },
          },
        ],
        operator: "exists",
      },
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    }),
  });
  assert.equal(invalidPathRegex.status, 400);
  const invalidPathRegexBody = archiveErrorSchema.parse(
    await invalidPathRegex.json(),
  );
  assert.equal(invalidPathRegexBody.error.code, "invalid_input");
  assert.deepEqual(invalidPathRegexBody.error.path, [
    "where",
    "steps",
    0,
    "target",
    "text",
    "pattern",
  ]);
  const invalidExpansionRegex = await fetch(baseUrl + "/archives/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: { kind: "current", binId: "rss-main" },
      where: pathRootFilter,
      expandPaths: [
        {
          key: "invalid-regex",
          steps: [
            {
              direction: "outgoing",
              target: {
                type: "text",
                text: { kind: "regex", pattern: "(" },
              },
            },
          ],
        },
      ],
      select: ["sourceKey"],
      orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    }),
  });
  assert.equal(invalidExpansionRegex.status, 400);
  const invalidExpansionRegexBody = archiveErrorSchema.parse(
    await invalidExpansionRegex.json(),
  );
  assert.equal(invalidExpansionRegexBody.error.code, "invalid_input");
  assert.deepEqual(invalidExpansionRegexBody.error.path, [
    "expandPaths",
    0,
    "steps",
    0,
    "target",
    "text",
    "pattern",
  ]);

  const historicalPathScope = {
    kind: "asOf",
    binId: "rss-main",
    asOf: pathCommit.archiveSeq,
  } as const;
  const historicalPath = await searchPathRoot(twoHopPath, historicalPathScope);
  assert.deepEqual(
    historicalPath.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const historicalRevisionPath = await searchPathRoot(twoHopPath, {
    kind: "revisions",
    binId: "rss-main",
    asOf: pathCommit.archiveSeq,
  });
  assert.equal(historicalRevisionPath.unit, "revision");
  assert.deepEqual(
    historicalRevisionPath.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  const historicalPathExpansion = await search({
    scope: historicalPathScope,
    where: pathRootFilter,
    expandPaths: [
      {
        key: "two-hop-history",
        steps: [
          { direction: "outgoing", name: "path-first" },
          { direction: "outgoing", name: "path-second" },
        ],
        limit: 10,
      },
    ],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.equal(
    historicalPathExpansion.results[0]?.matches[0]?.pathExpansions?.[0]?.paths
      .length,
    4,
  );
  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:path-current-change",
    binId: "rss-main",
    items: [
      {
        sourceKey: pathD,
        body: { searchText: "更新后的路径终点资料" },
        capture: {
          scope: { case: "bounded-path" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
    relations: [
      pathRelation(
        "e2e:relation-query:path-second-b",
        pathB,
        { sourceKey: pathD },
        "renamed-path-second",
      ),
    ],
  });
  const currentHistoricalPredicate = await searchPathRoot(twoHopPath);
  assert.deepEqual(currentHistoricalPredicate.results, []);
  const retainedHistoricalPath = await searchPathRoot(
    twoHopPath,
    historicalPathScope,
  );
  assert.deepEqual(
    retainedHistoricalPath.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );

  const independentExpansion = await search({
    scope: historicalPathScope,
    where: { type: "and", conditions: [pathRootFilter, twoHopPath] },
    expandPaths: [{ key: "self-only", steps: selfLoopSteps, limit: 1 }],
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(
    independentExpansion.results[0]?.matches[0]?.pathExpansions?.[0]?.paths.map(
      ({ steps }) => steps.map(({ relationId }) => relationId),
    ),
    [["e2e:relation-query:path-self-loop"]],
  );

  const rootPageQuery: ArchiveSearchRequest = {
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "in",
      values: [pathEmpty.key, pathRoot.key],
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 1,
  };
  const rootPage = await search(rootPageQuery);
  const pathExpandedRootPage = await search({
    ...rootPageQuery,
    expandPaths: [
      {
        key: "one-step",
        steps: [{ direction: "outgoing", name: "path-first" }],
      },
    ],
  });
  assert.deepEqual(
    pathExpandedRootPage.results.map(({ sourceKey }) => sourceKey?.key),
    rootPage.results.map(({ sourceKey }) => sourceKey?.key),
  );
  assert.deepEqual(
    pathExpandedRootPage.results[0]?.matches[0]?.pathExpansions?.[0]?.paths,
    [],
  );
  assert.ok(pathExpandedRootPage.nextCursor !== undefined);
  const secondPathPage = await search({
    ...rootPageQuery,
    cursor: pathExpandedRootPage.nextCursor,
    expandPaths: [
      {
        key: "one-step",
        steps: [{ direction: "outgoing", name: "path-first" }],
      },
    ],
  });
  assert.deepEqual(
    secondPathPage.results.map(({ sourceKey }) => sourceKey?.key),
    [pathRoot.key],
  );
  assert.ok(
    (secondPathPage.results[0]?.matches[0]?.pathExpansions?.[0]?.paths.length ??
      0) > 0,
  );

  const fanoutKeys = Array.from({ length: 10 }, (_, index) => ({
    namespace: "e2e-relation-query",
    key: `path-budget-${index}`,
  }));
  await submitArchive(client, {
    requestId: "e2e:archive:relation-query:path-budget-fanout",
    binId: "rss-main",
    items: fanoutKeys.map((sourceKey) => ({
      sourceKey,
      body: { searchText: "有限路径预算扇出图" },
      capture: {
        scope: { case: "bounded-path-budget" },
        completeness: "complete" as const,
        missing: [],
      },
    })),
    relations: fanoutKeys.flatMap((from, fromIndex) =>
      fanoutKeys.map((to, toIndex) =>
        pathRelation(
          `e2e:relation-query:path-budget:${fromIndex}:${toIndex}`,
          from,
          { sourceKey: to },
          "path-budget",
        ),
      ),
    ),
  });
  const fanoutRootQuery: ArchiveSearchRequest = {
    scope: { kind: "current", binId: "rss-main" },
    where: {
      type: "field",
      field: "sourceKey.key",
      operator: "eq",
      value: fanoutKeys[0]!.key,
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 1,
    budgetMs: 250,
  };
  const fanoutSteps = Array.from({ length: 8 }, () => ({
    direction: "outgoing" as const,
    name: "path-budget",
  }));
  const fanoutRootPage = await client.archives.search.$post({
    json: fanoutRootQuery,
  });
  assert.equal(fanoutRootPage.status, 200);
  if (fanoutRootPage.status === 200) {
    const expandedFanout = await client.archives.search.$post({
      json: {
        ...fanoutRootQuery,
        expandPaths: [{ key: "fanout", steps: fanoutSteps, limit: 1 }],
      },
    });
    assert.equal(expandedFanout.status, 422);
    if (expandedFanout.status === 422) {
      assert.equal(
        (await expandedFanout.json()).error.code,
        "query_budget_exceeded",
      );
    }
  }
  const directFanout = await fetch(baseUrl + "/archives/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...fanoutRootQuery,
      expandPaths: [{ key: "fanout", steps: fanoutSteps, limit: 1 }],
    }),
  });
  assert.equal(directFanout.status, 422);
  const directFanoutError = archiveErrorSchema.parse(await directFanout.json());
  assert.equal(directFanoutError.error.code, "query_budget_exceeded");
}
async function verifyHardDeleteEntryPoint(
  client: ArchiveClient,
  baseUrl: string,
): Promise<void> {
  const runId = randomUUID();
  const targetKey = { namespace: "e2e", key: "hard-delete-target:" + runId };
  const ownerKey = { namespace: "e2e", key: "hard-delete-owner:" + runId };
  const unrelatedKey = {
    namespace: "e2e",
    key: "hard-delete-unrelated:" + runId,
  };
  const sharedBytes = new TextEncoder().encode("binny06 shared delete media");
  const exclusiveBytes = new TextEncoder().encode(
    "binny06 exclusive delete media",
  );
  const upload = async (bytes: Uint8Array) => {
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await client.resources.$post(
      { header: { "content-type": "image/png" } },
      { init: { body: new Blob([body]) } },
    );
    assert.equal(response.status, 201);
    if (response.status !== 201) {
      throw new Error("硬删除资源上传失败。");
    }
    return await response.json();
  };
  const sharedResource = await upload(sharedBytes);
  const exclusiveResource = await upload(exclusiveBytes);
  const relationIds = [
    "e2e:hard-delete:" + runId + ":target-owner",
    "e2e:hard-delete:" + runId + ":owner-target",
    "e2e:hard-delete:" + runId + ":target-unrelated",
  ];
  const firstRequest: ArchiveSubmission = {
    requestId: "e2e:archive:hard-delete:first:" + runId,
    binId: "rss-main",
    items: [
      {
        sourceKey: targetKey,
        metadata: { title: "应删除的正文状态" },
        body: { text: "hard delete target first revision secret" },
        resources: [
          { resourceId: sharedResource.resourceId },
          { resourceId: exclusiveResource.resourceId },
        ],
        diagnostics: [
          { code: "e2e-hard-delete", message: "应清除的专属观察诊断" },
        ],
        capture: {
          scope: { case: "hard-delete-first" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: ownerKey,
        metadata: {
          note: "未登记标记 binny://resource/" + exclusiveResource.resourceId,
        },
        body: {
          text: "未登记标记 binny://resource/" + exclusiveResource.resourceId,
        },
        resources: [{ resourceId: sharedResource.resourceId }],
        capture: {
          scope: { case: "hard-delete-owner" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: unrelatedKey,
        body: { text: "普通关系不扩大删除集合" },
        capture: {
          scope: { case: "hard-delete-unrelated" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
    relations: [
      {
        relationId: relationIds[0]!,
        value: {
          from: targetKey,
          to: { sourceKey: ownerKey },
          name: "ordinary-target-owner",
          cascade: false,
        },
      },
      {
        relationId: relationIds[1]!,
        value: {
          from: ownerKey,
          to: { sourceKey: targetKey },
          name: "ordinary-owner-target",
          cascade: false,
        },
      },
      {
        relationId: relationIds[2]!,
        value: {
          from: targetKey,
          to: { sourceKey: unrelatedKey },
          name: "ordinary-target-unrelated",
          cascade: false,
        },
      },
    ],
  };
  const firstCommit = await submitArchive(client, firstRequest);
  const target = firstCommit.items.find(
    ({ sourceKey }) => sourceKey.key === targetKey.key,
  );
  const owner = firstCommit.items.find(
    ({ sourceKey }) => sourceKey.key === ownerKey.key,
  );
  const unrelated = firstCommit.items.find(
    ({ sourceKey }) => sourceKey.key === unrelatedKey.key,
  );
  assert.ok(target && owner && unrelated);

  const secondCommit = await submitArchive(client, {
    requestId: "e2e:archive:hard-delete:secondary:" + runId,
    binId: "rss-secondary",
    items: [
      {
        sourceKey: targetKey,
        metadata: { title: "第二个 bin 的内容状态" },
        body: { text: "hard delete target second revision secret" },
        resources: [
          { resourceId: sharedResource.resourceId },
          { resourceId: exclusiveResource.resourceId },
        ],
        capture: {
          scope: { case: "hard-delete-secondary" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const secondTarget = secondCommit.items[0];
  assert.ok(secondTarget);
  assert.equal(secondTarget.itemId, target.itemId);
  assert.notEqual(secondTarget.revisionId, target.revisionId);

  const beforeDeleteResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: target.itemId },
    query: {},
  });
  assert.equal(beforeDeleteResponse.status, 200);
  if (beforeDeleteResponse.status !== 200) {
    throw new Error("删除前读取跨 bin 视图失败。");
  }
  const beforeDelete = await beforeDeleteResponse.json();
  assert.deepEqual(beforeDelete.views.map(({ binId }) => binId).toSorted(), [
    "rss-main",
    "rss-secondary",
  ]);
  assert.equal(beforeDelete.revisions.length, 2);

  const response = await fetch(baseUrl + "/archives/items/" + target.itemId, {
    method: "DELETE",
  });
  if (response.status !== 200) {
    throw new Error("HTTP 硬删除失败：" + (await response.text()));
  }
  const deletion = archiveItemDeletionResultSchema.parse(await response.json());
  assert.equal(deletion.itemId, target.itemId);
  assert.deepEqual(deletion.deletedItemIds, [target.itemId]);
  assert.equal(deletion.deleted, true);
  assert.ok(BigInt(deletion.deletionSeq) > BigInt(secondCommit.archiveSeq));

  for (const query of [{}, { asOf: firstCommit.archiveSeq }] as const) {
    const deletedRead = await client.archives.items[":itemId"].$get({
      param: { itemId: target.itemId },
      query,
    });
    assert.equal(deletedRead.status, 404);
    if (deletedRead.status === 404) {
      assert.equal((await deletedRead.json()).error.code, "item_deleted");
    }
  }
  for (const revisionId of [target.revisionId, secondTarget.revisionId]) {
    const deletedRevision = await client.archives.revisions[":revisionId"].$get(
      { param: { revisionId } },
    );
    assert.equal(deletedRevision.status, 404);
    if (deletedRevision.status === 404) {
      assert.equal(
        (await deletedRevision.json()).error.code,
        "revision_not_found",
      );
    }
  }

  const mixedCommit = await readArchiveCommit(client, firstCommit.commitId);
  assert.deepEqual(
    mixedCommit.items.map(({ itemId }) => itemId).toSorted(),
    [owner.itemId, unrelated.itemId].toSorted(),
  );
  assert.deepEqual(
    mixedCommit.gaps?.items.map(({ itemId }) => itemId),
    [target.itemId],
  );
  assert.deepEqual(
    mixedCommit.gaps?.relations.map(({ relationId }) => relationId).toSorted(),
    relationIds.toSorted(),
  );
  assert.doesNotMatch(
    JSON.stringify(mixedCommit),
    /hard delete target|应删除的正文状态|应清除的专属观察诊断/u,
  );
  const secondaryCommit = await readArchiveCommit(
    client,
    secondCommit.commitId,
  );
  assert.deepEqual(
    secondaryCommit.gaps?.items.map(({ itemId }) => itemId),
    [target.itemId],
  );

  const targetTimeline = await readArchiveTimeline(client, target.itemId, {
    asOf: firstCommit.archiveSeq,
    limit: "100",
  });
  assert.ok(
    targetTimeline.events.some(
      (event) => event.kind === "gap" && event.subject.kind === "item",
    ),
  );
  assert.ok(
    targetTimeline.events.some(
      (event) =>
        event.kind === "gap" &&
        event.subject.kind === "relation" &&
        event.subject.relationId === relationIds[0],
    ),
  );
  assert.equal(
    targetTimeline.events.some((event) => event.kind === "item"),
    false,
  );
  const ownerTimeline = await readArchiveTimeline(client, owner.itemId, {
    asOf: firstCommit.archiveSeq,
    limit: "100",
  });
  assert.ok(
    ownerTimeline.events.some(
      (event) =>
        event.kind === "gap" &&
        event.subject.kind === "relation" &&
        event.subject.relationId === relationIds[1],
    ),
  );

  for (const [direction, expectedRelationId] of [
    ["outgoing", relationIds[1]],
    ["incoming", relationIds[0]],
  ] as const) {
    const page = await readArchiveRelations(client, owner.itemId, {
      binId: "rss-main",
      direction,
      asOf: firstCommit.archiveSeq,
      limit: "100",
    });
    const deletedRelation = page.relations.find(
      ({ relationId }) => relationId === expectedRelationId,
    );
    assert.equal(deletedRelation?.status, "deleted");
  }
  const unrelatedRead = await client.archives.items[":itemId"].$get({
    param: { itemId: unrelated.itemId },
    query: {},
  });
  assert.equal(unrelatedRead.status, 200);

  const replayedRequest = await submitArchive(client, firstRequest);
  assert.equal(replayedRequest.commitId, firstCommit.commitId);
  assert.equal(
    replayedRequest.items.some(({ itemId }) => itemId === target.itemId),
    false,
  );
  assert.deepEqual(
    replayedRequest.gaps?.items.map(({ itemId }) => itemId),
    [target.itemId],
  );
  const afterReplay = await client.archives.items[":itemId"].$get({
    param: { itemId: target.itemId },
    query: {},
  });
  assert.equal(afterReplay.status, 404);
  if (afterReplay.status === 404) {
    assert.equal((await afterReplay.json()).error.code, "item_deleted");
  }

  const ownerRead = await client.archives.items[":itemId"].$get({
    param: { itemId: owner.itemId },
    query: {},
  });
  assert.equal(ownerRead.status, 200);
  if (ownerRead.status !== 200) {
    throw new Error("删除后共享资源持有条目不可读。");
  }
  const retainedOwner = await ownerRead.json();
  assert.ok(
    retainedOwner.views[0]?.state.body?.text?.includes(
      exclusiveResource.resourceId,
    ),
  );
  const sharedRead = await client.resources[":resourceId"].$get({
    param: { resourceId: sharedResource.resourceId },
  });
  assert.equal(sharedRead.status, 200);
  if (sharedRead.status === 200) {
    assert.deepEqual(
      new Uint8Array(await sharedRead.arrayBuffer()),
      sharedBytes,
    );
  }
  const exclusiveRead = await client.resources[":resourceId"].$get({
    param: { resourceId: exclusiveResource.resourceId },
  });
  assert.equal(exclusiveRead.status, 404);
  if (exclusiveRead.status === 404) {
    assert.equal((await exclusiveRead.json()).error.code, "resource_not_found");
  }

  const freshCommit = await submitArchive(client, {
    requestId: "e2e:archive:hard-delete:fresh:" + runId,
    binId: "rss-main",
    items: [
      {
        sourceKey: targetKey,
        body: { text: "真实新采集允许重新归档" },
        capture: {
          scope: { case: "hard-delete-fresh-capture" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const freshItem = freshCommit.items[0];
  assert.ok(freshItem);
  assert.notEqual(freshItem.itemId, target.itemId);
  const freshRead = await client.archives.items[":itemId"].$get({
    param: { itemId: freshItem.itemId },
    query: {},
  });
  assert.equal(freshRead.status, 200);

  const reusedRelationId = relationIds[1]!;
  const secondaryRelationCommit = await submitArchive(client, {
    requestId: "e2e:archive:hard-delete:secondary-relation:" + runId,
    binId: "rss-secondary",
    items: [],
    relations: [
      {
        relationId: reusedRelationId,
        value: {
          from: ownerKey,
          to: { sourceKey: targetKey },
          name: "ordinary-owner-target",
          cascade: false,
        },
      },
    ],
  });
  const relationBeforeMainReobservation = await readArchiveRelations(
    client,
    owner.itemId,
    {
      direction: "outgoing",
      binId: "rss-main",
      limit: "10",
    },
  );
  const retainedDeletionGap = relationBeforeMainReobservation.relations.filter(
    ({ relationId }) => relationId === reusedRelationId,
  );
  assert.equal(retainedDeletionGap.length, 1);
  assert.equal(retainedDeletionGap[0]?.status, "deleted");
  assert.equal("from" in retainedDeletionGap[0]!, false);
  assert.equal("to" in retainedDeletionGap[0]!, false);

  const secondaryRelation = await readArchiveRelations(client, owner.itemId, {
    direction: "outgoing",
    binId: "rss-secondary",
    limit: "10",
  });
  const secondaryObservedRelation = secondaryRelation.relations.find(
    ({ relationId }) => relationId === reusedRelationId,
  );
  assert.equal(secondaryObservedRelation?.status, "observed");
  if (secondaryObservedRelation?.status === "observed") {
    assert.equal(
      secondaryObservedRelation.observation.commitId,
      secondaryRelationCommit.commitId,
    );
    assert.equal(secondaryObservedRelation.to.kind, "item");
    if (secondaryObservedRelation.to.kind === "item") {
      assert.equal(secondaryObservedRelation.to.itemId, freshItem.itemId);
    }
  }

  const oldMainSnapshot = await readArchiveRelations(client, owner.itemId, {
    direction: "outgoing",
    binId: "rss-main",
    asOf: firstCommit.archiveSeq,
    limit: "10",
  });
  const oldSnapshotGap = oldMainSnapshot.relations.find(
    ({ relationId }) => relationId === reusedRelationId,
  );
  assert.equal(oldSnapshotGap?.status, "deleted");

  const mainReobservation = await submitArchive(client, {
    requestId: "e2e:archive:hard-delete:main-reobservation:" + runId,
    binId: "rss-main",
    items: [],
    relations: [
      {
        relationId: reusedRelationId,
        value: {
          from: ownerKey,
          to: { sourceKey: targetKey },
          name: "ordinary-owner-target",
          cascade: false,
        },
      },
      {
        relationId: "e2e:hard-delete:" + runId + ":a-before",
        value: {
          from: ownerKey,
          to: { sourceRef: "https://example.test/a-before" },
          name: "page-boundary",
          cascade: false,
        },
      },
      {
        relationId: "e2e:hard-delete:" + runId + ":z-after",
        value: {
          from: ownerKey,
          to: { sourceRef: "https://example.test/z-after" },
          name: "page-boundary",
          cascade: false,
        },
      },
    ],
  });
  assert.equal(mainReobservation.relations.length, 3);
  const currentMainRelationIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await readArchiveRelations(client, owner.itemId, {
      direction: "outgoing",
      binId: "rss-main",
      ...(cursor === undefined ? {} : { cursor }),
      limit: "1",
    });
    currentMainRelationIds.push(
      ...page.relations.map(({ relationId }) => relationId),
    );
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert.deepEqual(currentMainRelationIds, [
    "e2e:hard-delete:" + runId + ":a-before",
    reusedRelationId,
    "e2e:hard-delete:" + runId + ":z-after",
  ]);
  assert.equal(
    new Set(currentMainRelationIds).size,
    currentMainRelationIds.length,
  );
  const restoredMainRelation = (
    await readArchiveRelations(client, owner.itemId, {
      direction: "outgoing",
      binId: "rss-main",
      limit: "10",
    })
  ).relations.find(({ relationId }) => relationId === reusedRelationId);
  assert.equal(restoredMainRelation?.status, "observed");
  if (restoredMainRelation?.status === "observed") {
    assert.equal(
      restoredMainRelation.observation.commitId,
      mainReobservation.commitId,
    );
    assert.equal(restoredMainRelation.to.kind, "item");
    if (restoredMainRelation.to.kind === "item") {
      assert.equal(restoredMainRelation.to.itemId, freshItem.itemId);
      assert.equal(restoredMainRelation.to.status, "observed");
    }
  }
  const gapAfterMainReobservation = await readArchiveRelations(
    client,
    owner.itemId,
    {
      direction: "outgoing",
      binId: "rss-main",
      asOf: firstCommit.archiveSeq,
      limit: "10",
    },
  );
  assert.equal(
    gapAfterMainReobservation.relations.find(
      ({ relationId }) => relationId === reusedRelationId,
    )?.status,
    "deleted",
  );
}

async function verifyDeclaredCascadeDeleteEntryPoint(
  client: ArchiveClient,
): Promise<void> {
  const runId = randomUUID();
  const rootKey = { namespace: "e2e", key: "cascade-root:" + runId };
  const targetKey = { namespace: "e2e", key: "cascade-target:" + runId };
  const cycleKey = { namespace: "e2e", key: "cascade-cycle:" + runId };
  const sharedKey = { namespace: "e2e", key: "cascade-shared:" + runId };
  const incomingKey = { namespace: "e2e", key: "cascade-incoming:" + runId };
  const ordinaryKey = { namespace: "e2e", key: "cascade-ordinary:" + runId };
  const changedKey = { namespace: "e2e", key: "cascade-changed:" + runId };
  const withdrawnKey = { namespace: "e2e", key: "cascade-withdrawn:" + runId };
  const unrelatedKey = { namespace: "e2e", key: "cascade-unrelated:" + runId };
  const sharedBytes = new TextEncoder().encode("binny07 shared cascade media");
  const exclusiveBytes = new TextEncoder().encode(
    "binny07 exclusive cascade media",
  );
  const upload = async (bytes: Uint8Array) => {
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await client.resources.$post(
      { header: { "content-type": "image/png" } },
      { init: { body: new Blob([body]) } },
    );
    assert.equal(response.status, 201);
    if (response.status !== 201) {
      throw new Error("级联删除资源上传失败。");
    }
    return await response.json();
  };
  const sharedResource = await upload(sharedBytes);
  const exclusiveResource = await upload(exclusiveBytes);
  const relationIds = {
    forward: "e2e:cascade:" + runId + ":forward",
    toCycle: "e2e:cascade:" + runId + ":to-cycle",
    cycleBack: "e2e:cascade:" + runId + ":cycle-back",
    sharedFromTarget: "e2e:cascade:" + runId + ":shared-from-target",
    sharedFromCycle: "e2e:cascade:" + runId + ":shared-from-cycle",
    incoming: "e2e:cascade:" + runId + ":incoming",
    ordinary: "e2e:cascade:" + runId + ":ordinary",
    changed: "e2e:cascade:" + runId + ":changed",
    withdrawn: "e2e:cascade:" + runId + ":withdrawn",
  };
  const keys = [
    rootKey,
    targetKey,
    cycleKey,
    sharedKey,
    incomingKey,
    ordinaryKey,
    changedKey,
    withdrawnKey,
    unrelatedKey,
  ];
  const commit = await submitArchive(client, {
    requestId: "e2e:archive:cascade:" + runId,
    binId: "rss-main",
    items: keys.map((sourceKey) => {
      const resources =
        sourceKey.key === rootKey.key || sourceKey.key === unrelatedKey.key
          ? [{ resourceId: sharedResource.resourceId }]
          : sourceKey.key === targetKey.key
            ? [{ resourceId: exclusiveResource.resourceId }]
            : [];
      return {
        sourceKey,
        body: { text: sourceKey.key },
        resources,
        capture: {
          scope: { case: "declared-cascade" },
          completeness: "complete" as const,
          missing: [],
        },
      };
    }),
    relations: [
      {
        relationId: relationIds.forward,
        value: {
          from: rootKey,
          to: { sourceKey: targetKey },
          name: "declared-child",
          cascade: true,
        },
      },
      {
        relationId: relationIds.toCycle,
        value: {
          from: targetKey,
          to: { sourceKey: cycleKey },
          name: "declared-child",
          cascade: true,
        },
      },
      {
        relationId: relationIds.cycleBack,
        value: {
          from: cycleKey,
          to: { sourceKey: rootKey },
          name: "declared-cycle",
          cascade: true,
        },
      },
      {
        relationId: relationIds.sharedFromTarget,
        value: {
          from: targetKey,
          to: { sourceKey: sharedKey },
          name: "declared-child",
          cascade: true,
        },
      },
      {
        relationId: relationIds.sharedFromCycle,
        value: {
          from: cycleKey,
          to: { sourceKey: sharedKey },
          name: "declared-child",
          cascade: true,
        },
      },
      {
        relationId: relationIds.incoming,
        value: {
          from: incomingKey,
          to: { sourceKey: rootKey },
          name: "declared-parent",
          cascade: true,
        },
      },
      {
        relationId: relationIds.ordinary,
        value: {
          from: rootKey,
          to: { sourceKey: ordinaryKey },
          name: "ordinary-link",
          cascade: false,
        },
      },
      {
        relationId: relationIds.changed,
        value: {
          from: rootKey,
          to: { sourceKey: changedKey },
          name: "changed-declaration",
          cascade: true,
        },
      },
      {
        relationId: relationIds.withdrawn,
        value: {
          from: rootKey,
          to: { sourceKey: withdrawnKey },
          name: "withdrawn-declaration",
          cascade: true,
        },
      },
    ],
  });
  const itemsByKey = new Map(
    commit.items.map(({ sourceKey, itemId }) => [sourceKey.key, itemId]),
  );
  const rootItemId = itemsByKey.get(rootKey.key);
  const targetItemId = itemsByKey.get(targetKey.key);
  const cycleItemId = itemsByKey.get(cycleKey.key);
  const sharedItemId = itemsByKey.get(sharedKey.key);
  const incomingItemId = itemsByKey.get(incomingKey.key);
  const ordinaryItemId = itemsByKey.get(ordinaryKey.key);
  const changedItemId = itemsByKey.get(changedKey.key);
  const withdrawnItemId = itemsByKey.get(withdrawnKey.key);
  const unrelatedItemId = itemsByKey.get(unrelatedKey.key);
  assert.ok(rootItemId);
  assert.ok(targetItemId);
  assert.ok(cycleItemId);
  assert.ok(sharedItemId);
  assert.ok(incomingItemId);
  assert.ok(ordinaryItemId);
  assert.ok(changedItemId);
  assert.ok(withdrawnItemId);
  assert.ok(unrelatedItemId);

  const forwardState = (cascade: boolean) => ({
    from: rootKey,
    to: { sourceKey: targetKey },
    name: "declared-child",
    cascade,
  });
  await submitArchive(client, {
    requestId: "e2e:archive:cascade:secondary:" + runId,
    binId: "rss-secondary",
    items: [],
    relations: [{ relationId: relationIds.forward, value: forwardState(true) }],
  });
  await submitArchive(client, {
    requestId: "e2e:archive:cascade:main-update:" + runId,
    binId: "rss-main",
    items: [],
    relations: [
      { relationId: relationIds.forward, value: forwardState(false) },
      {
        relationId: relationIds.changed,
        value: {
          from: rootKey,
          to: { sourceKey: changedKey },
          name: "changed-declaration",
          cascade: false,
        },
      },
    ],
  });
  await submitArchive(client, {
    requestId: "e2e:archive:cascade:main-withdrawal:" + runId,
    binId: "rss-main",
    items: [],
    relations: [
      { relationId: relationIds.forward, value: null },
      { relationId: relationIds.withdrawn, value: null },
    ],
  });
  const mainCurrentRelations = await readArchiveRelations(client, rootItemId, {
    direction: "outgoing",
    binId: "rss-main",
    limit: "100",
  });
  assert.equal(
    mainCurrentRelations.relations.find(
      ({ relationId }) => relationId === relationIds.forward,
    )?.status,
    "withdrawn",
  );
  const changedDeclaration = mainCurrentRelations.relations.find(
    ({ relationId }) => relationId === relationIds.changed,
  );
  assert.equal(changedDeclaration?.status, "observed");
  if (changedDeclaration?.status === "observed") {
    assert.equal(changedDeclaration.state.cascade, false);
  }
  assert.equal(
    mainCurrentRelations.relations.find(
      ({ relationId }) => relationId === relationIds.withdrawn,
    )?.status,
    "withdrawn",
  );
  const secondaryCurrentRelations = await readArchiveRelations(
    client,
    rootItemId,
    { direction: "outgoing", binId: "rss-secondary", limit: "10" },
  );
  const oldBinDeclaration = secondaryCurrentRelations.relations.find(
    ({ relationId }) => relationId === relationIds.forward,
  );
  assert.equal(oldBinDeclaration?.status, "observed");
  if (oldBinDeclaration?.status === "observed") {
    assert.equal(oldBinDeclaration.state.cascade, true);
  }

  const deletion = await client.archives.items[":itemId"].$delete({
    param: { itemId: rootItemId },
  });
  assert.equal(deletion.status, 200);
  if (deletion.status !== 200) {
    throw new Error("声明级联删除请求失败。");
  }
  const deletionResult = await deletion.json();
  assert.equal(deletionResult.itemId, rootItemId);
  const deletedItemIds = [rootItemId, targetItemId, cycleItemId, sharedItemId];
  assert.deepEqual(
    deletionResult.deletedItemIds.toSorted(),
    deletedItemIds.toSorted(),
  );
  assert.equal(
    new Set(deletionResult.deletedItemIds).size,
    deletionResult.deletedItemIds.length,
  );

  for (const itemId of deletedItemIds) {
    const response = await client.archives.items[":itemId"].$get({
      param: { itemId },
      query: {},
    });
    assert.equal(response.status, 404);
    if (response.status === 404) {
      assert.equal((await response.json()).error.code, "item_deleted");
    }
  }
  for (const itemId of [
    incomingItemId,
    ordinaryItemId,
    changedItemId,
    withdrawnItemId,
    unrelatedItemId,
  ]) {
    const response = await client.archives.items[":itemId"].$get({
      param: { itemId },
      query: {},
    });
    assert.equal(response.status, 200);
    if (response.status === 200 && itemId === unrelatedItemId) {
      const retainedOwner = await response.json();
      assert.deepEqual(retainedOwner.views[0]?.state.resources, [
        { resourceId: sharedResource.resourceId },
      ]);
    }
  }

  const sharedResourceRead = await client.resources[":resourceId"].$get({
    param: { resourceId: sharedResource.resourceId },
  });
  assert.equal(sharedResourceRead.status, 200);
  if (sharedResourceRead.status === 200) {
    assert.deepEqual(
      new Uint8Array(await sharedResourceRead.arrayBuffer()),
      sharedBytes,
    );
  }
  const exclusiveResourceRead = await client.resources[":resourceId"].$get({
    param: { resourceId: exclusiveResource.resourceId },
  });
  assert.equal(exclusiveResourceRead.status, 404);
  if (exclusiveResourceRead.status === 404) {
    assert.equal(
      (await exclusiveResourceRead.json()).error.code,
      "resource_not_found",
    );
  }

  const deletedCommit = await readArchiveCommit(client, commit.commitId);
  assert.deepEqual(
    deletedCommit.gaps?.items.map(({ itemId }) => itemId).toSorted(),
    deletedItemIds.toSorted(),
  );
  assert.deepEqual(
    deletedCommit.gaps?.relations
      .map(({ relationId }) => relationId)
      .toSorted(),
    Object.values(relationIds).toSorted(),
  );
  const historicalTimeline = await readArchiveTimeline(client, targetItemId, {
    asOf: commit.archiveSeq,
    limit: "100",
  });
  assert.ok(
    historicalTimeline.events.some(
      (event) =>
        event.kind === "gap" &&
        event.subject.kind === "item" &&
        event.subject.itemId === targetItemId,
    ),
  );
}

async function verifyConcurrentCascadeWrites(
  client: ArchiveClient,
): Promise<void> {
  for (const mutation of ["submission", "withdrawal"] as const) {
    const runId = randomUUID();
    const rootKey = { namespace: "e2e", key: "cascade-race-root:" + runId };
    const targetKey = {
      namespace: "e2e",
      key: "cascade-race-target:" + runId,
    };
    const relationId = "e2e:cascade-race:" + runId + ":original";
    const firstCommit = await submitArchive(client, {
      requestId: "e2e:archive:cascade-race:first:" + runId,
      binId: "rss-main",
      items: [rootKey, targetKey].map((sourceKey) => ({
        sourceKey,
        body: { text: sourceKey.key },
        capture: {
          scope: { case: "declared-cascade-race" },
          completeness: "complete" as const,
          missing: [],
        },
      })),
      relations: [
        {
          relationId,
          value: {
            from: rootKey,
            to: { sourceKey: targetKey },
            name: "declared-child",
            cascade: mutation === "withdrawal",
          },
        },
      ],
    });
    const rootItem = firstCommit.items.find(
      ({ sourceKey }) => sourceKey.key === rootKey.key,
    );
    const targetItem = firstCommit.items.find(
      ({ sourceKey }) => sourceKey.key === targetKey.key,
    );
    assert.ok(rootItem);
    assert.ok(targetItem);

    const mutationSubmission: ArchiveSubmission =
      mutation === "submission"
        ? {
            requestId: "e2e:archive:cascade-race:new-edge:" + runId,
            binId: "rss-main",
            items: [],
            relations: [
              {
                relationId: "e2e:cascade-race:" + runId + ":new",
                value: {
                  from: rootKey,
                  to: { sourceKey: targetKey },
                  name: "concurrent-child",
                  cascade: true,
                },
              },
            ],
          }
        : {
            requestId: "e2e:archive:cascade-race:withdraw:" + runId,
            binId: "rss-main",
            items: [],
            relations: [{ relationId, value: null }],
          };
    const [deletionResponse, mutationResponse] = await Promise.all([
      client.archives.items[":itemId"].$delete({
        param: { itemId: rootItem.itemId },
      }),
      client.archives.$post({ json: mutationSubmission }),
    ]);
    assert.equal(deletionResponse.status, 200);
    if (deletionResponse.status !== 200) {
      throw new Error("并发级联删除失败。");
    }
    const deletionResult = await deletionResponse.json();
    const targetWasDeleted = deletionResult.deletedItemIds.includes(
      targetItem.itemId,
    );

    if (mutation === "submission") {
      if (mutationResponse.status === 201) {
        assert.equal(targetWasDeleted, true);
      } else if (mutationResponse.status === 400) {
        assert.equal(
          (await mutationResponse.json()).error.code,
          "invalid_input",
        );
        assert.equal(targetWasDeleted, false);
      } else {
        assert.fail("并发关系提交返回了未预期的状态。");
      }
    } else if (mutationResponse.status === 201) {
      assert.equal(
        (await mutationResponse.json()).relations[0]?.status,
        "withdrawn",
      );
      assert.equal(targetWasDeleted, false);
    } else if (mutationResponse.status === 404) {
      assert.equal(
        (await mutationResponse.json()).error.code,
        "relation_not_found",
      );
      assert.equal(targetWasDeleted, true);
    } else {
      assert.fail("并发关系撤回返回了未预期的状态。");
    }

    const targetRead = await client.archives.items[":itemId"].$get({
      param: { itemId: targetItem.itemId },
      query: {},
    });
    assert.equal(targetRead.status, targetWasDeleted ? 404 : 200);
    if (targetRead.status === 404) {
      assert.equal((await targetRead.json()).error.code, "item_deleted");
    }
  }
}

async function verifyArchiveJourney(baseUrl: string): Promise<ArchiveJourney> {
  const client = createApiClient(baseUrl);
  await verifyArchiveAtomicity(client);
  const relations = await verifyArchiveRelations(client);
  const resources = await verifyArchiveResourceHttp(client);
  await verifyArchiveIdempotency(client);
  await verifyArchivePrototypeKeys(client);
  await verifyPersistableTextBoundary(client);
  const aba = await verifyArchiveABA(client);
  await verifySearchRoute(
    baseUrl,
    aba.itemId,
    aba.revisionId,
    aba.historicalAsOf,
  );
  await verifySearchJsonPathFilter(baseUrl);
  await verifyRelationSearch(baseUrl);
  await verifySearchSourceViews(baseUrl);
  await verifyAggregationFirstSlice(baseUrl);
  await verifySearchPagination(baseUrl);
  await verifyConcurrentArchiveIdentity(client);
  await verifyArchiveReadErrors(client, aba.itemId);
  await verifyHardDeleteEntryPoint(client, baseUrl);
  await verifyDeclaredCascadeDeleteEntryPoint(client);
  await verifyConcurrentCascadeWrites(client);
  const cliCascadeRunId = randomUUID();
  const cliCascadeRootKey = {
    namespace: "e2e",
    key: "cli-cascade-root:" + cliCascadeRunId,
  };
  const cliCascadeTargetKey = {
    namespace: "e2e",
    key: "cli-cascade-target:" + cliCascadeRunId,
  };
  const cliCascadeCommit = await submitArchive(client, {
    requestId: "e2e:archive:cli-cascade:" + cliCascadeRunId,
    binId: "rss-main",
    items: [cliCascadeRootKey, cliCascadeTargetKey].map((sourceKey) => ({
      sourceKey,
      body: { text: sourceKey.key },
      capture: {
        scope: { case: "declared-cascade-cli" },
        completeness: "complete" as const,
        missing: [],
      },
    })),
    relations: [
      {
        relationId: "e2e:cli-cascade:" + cliCascadeRunId,
        value: {
          from: cliCascadeRootKey,
          to: { sourceKey: cliCascadeTargetKey },
          name: "declared-child",
          cascade: true,
        },
      },
    ],
  });
  const cliCascadeRoot = cliCascadeCommit.items.find(
    ({ sourceKey }) => sourceKey.key === cliCascadeRootKey.key,
  );
  const cliCascadeTarget = cliCascadeCommit.items.find(
    ({ sourceKey }) => sourceKey.key === cliCascadeTargetKey.key,
  );
  assert.ok(cliCascadeRoot);
  assert.ok(cliCascadeTarget);
  return {
    ...aba,
    ...relations,
    resourceItemId: resources.itemId,
    resourceRevisionId: resources.revisionId,
    resourcePartialRevisionId: resources.partialRevisionId,
    resourceRepairedRevisionId: resources.repairedRevisionId,
    resourceId: resources.resourceId,
    repairedResourceId: resources.repairedResourceId,
    orphanResourceId: resources.orphanResourceId,
    resourceMarkerItemId: resources.resourceMarkerItemId,
    cliCascadeRootItemId: cliCascadeRoot.itemId,
    cliCascadeTargetItemId: cliCascadeTarget.itemId,
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

  const resourceDiffSnapshot = await readArchiveItem(
    client,
    archive.resourceItemId,
  );
  const revisionDiff = await readArchiveRevisionDiff(
    client,
    archive.revisionId,
    archive.comparedRevisionId,
  );
  assert.equal(revisionDiff.hasChanges, true);
  const resourcePartialDiff = await readArchiveRevisionDiff(
    client,
    archive.resourceRevisionId,
    archive.resourcePartialRevisionId,
  );
  const resourceDiff = await readArchiveRevisionDiff(
    client,
    archive.resourceRevisionId,
    archive.resourceRepairedRevisionId,
  );
  assert.deepEqual(resourceDiff.resources, {
    added: [archive.repairedResourceId],
    removed: [archive.resourceId],
  });
  assert.deepEqual(
    await readArchiveItem(client, archive.resourceItemId),
    resourceDiffSnapshot,
  );

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
  const relationCommit = await readArchiveCommit(
    client,
    archive.relationCommitId,
  );
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
  const relationTimelinePage = await readArchiveTimeline(
    client,
    archive.relationItemId,
    {
      binId: "rss-main",
      asOf: archive.relationAsOf,
      limit: "100",
    },
  );
  const restoredRelation = relationPage.relations.find(
    ({ relationId }) => relationId === "e2e:relation:01-forward",
  );
  assert.equal(restoredRelation?.status, "observed");
  if (restoredRelation?.status === "observed") {
    assert.deepEqual(
      restoredRelation.state.properties,
      Object.fromEntries([
        ["__proto__", { label: "更新关系中文 emoji 🌿" }],
        ["position", 2],
      ] as const),
    );
  }
  const restoredRelationEvent = relationTimelinePage.events
    .filter(
      (event) =>
        event.kind === "relation" &&
        event.relationId === "e2e:relation:01-forward",
    )
    .at(-1);
  assert.equal(restoredRelationEvent?.kind, "relation");
  if (restoredRelationEvent?.kind === "relation") {
    assert.equal(restoredRelationEvent.status, "observed");
    if (restoredRelationEvent.status === "observed") {
      assert.deepEqual(
        restoredRelationEvent.state.properties,
        Object.fromEntries([
          ["__proto__", { label: "更新关系中文 emoji 🌿" }],
          ["position", 2],
        ] as const),
      );
    }
  }
  return {
    item: persistedArchive,
    historicalItem,
    revision: persistedRevision,
    revisionDiff,
    resourcePartialDiff,
    resourceDiff,
    resourceItem,
    resourceMarkerItem,
    resourceRevision: historicalResource,
    sdkItem,
    sdkResourceMetadata,
    firstTimelinePage,
    secondTimelinePage,
    commit,
    relationCommit,
    relationPage,
    relationTimelinePage,
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
  if (stage === "capacity") {
    const profile = process.env.BINNY_E2E_CAPACITY_PROFILE;
    const phase = process.env.BINNY_E2E_CAPACITY_PHASE;
    if (profile !== "full" && profile !== "smoke") {
      throw new Error("容量验收需要 smoke 或 full 配置。");
    }
    if (
      phase !== "all" &&
      phase !== "seed" &&
      phase !== "verify" &&
      phase !== "delete"
    ) {
      throw new Error("容量验收阶段必须为 all、seed、verify 或 delete。");
    }
    const report = await runArchiveCapacityE2E(
      baseUrl,
      profile as CapacityProfile,
      phase as CapacityPhase,
    );
    process.stdout.write(JSON.stringify(report));
    return;
  }
  throw new Error("未知归档 HTTP 验收阶段。");
}

await main();
