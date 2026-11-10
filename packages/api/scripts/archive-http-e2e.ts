import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { createApiClient } from "@binny/api/client";
import {
  archiveSearchPageSchema,
  archiveErrorSchema,
  archiveIdentifierSchema,
  archiveItemDeletionResultSchema,
  archiveSnapshotSequenceSchema,
  archiveQueryContractPath,
  archiveQueryContractVersion,
  publicApiProtocolVersion,
  serviceCapabilities,
  serviceMetadataSchema,
  archiveSubmissionInputSchema,
} from "@binny/contracts";
import type { ArchiveSearchRequest } from "@binny/contracts";
import type { AnySchema } from "ajv/dist/2020.js";
import * as z from "zod";

import { archiveApiSchemas } from "../src/routes.ts";
import { runArchiveCapacityE2E } from "./archive-capacity-e2e.ts";

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

async function submitExtensionSearchFixture(
  client: ArchiveClient,
  binId: string,
): Promise<void> {
  const queuedResponse = await client.bins[":binId"].runs.$post({
    param: { binId },
    json: {
      action: "collect",
      params: {
        sourceUrl: "https://example.test/feed",
        gateKey: "extension-search-" + binId,
        sourceKey: "extension-search-" + binId,
        extensionSearchFixture: true,
      },
    },
  });
  assert.equal(queuedResponse.status, 202);
  if (queuedResponse.status !== 202) return;
  const queued = await queuedResponse.json();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const runResponse = await client.bins[":binId"].runs[":runId"].$get({
      param: { binId, runId: queued.runId },
    });
    assert.equal(runResponse.status, 200);
    if (runResponse.status !== 200) return;
    const run = await runResponse.json();
    if (run.status === "completed") {
      assert.ok(run.result?.commits.some(({ items }) => items.length > 0));
      return;
    }
    assert.notEqual(run.status, "failed");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Extension search fixture run did not complete for ${binId}.`);
}

function compileJsonSchema(document: unknown) {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv.compile(document as AnySchema);
}

async function discoverArchiveQueryContract(baseUrl: string) {
  const client = createApiClient(baseUrl);
  const metadataResponse = await client.meta.$get();
  assert.equal(metadataResponse.status, 200);
  const metadata = serviceMetadataSchema.parse(await metadataResponse.json());
  assert.equal(metadata.protocols.httpApi, publicApiProtocolVersion);
  assert.equal(
    metadata.contracts.archiveQuery.version,
    archiveQueryContractVersion,
  );
  assert.equal(metadata.contracts.archiveQuery.path, archiveQueryContractPath);
  assert.ok(metadata.capabilities.includes(serviceCapabilities.archiveSearch));

  const contractResponse = await client.meta.query.$get();
  assert.equal(contractResponse.status, 200);
  const queryContract = await contractResponse.json();
  assert.equal(queryContract.version, metadata.contracts.archiveQuery.version);
  assert.equal(queryContract.operations.search.path, "/archives/search");
  return { metadata, queryContract };
}

async function postDiscoveredSearch(
  baseUrl: string,
  operation: {
    readonly method: "POST";
    readonly path: string;
    readonly requestSchema: unknown;
    readonly responseSchema: unknown;
  },
  request: unknown,
): Promise<unknown> {
  assert.equal(compileJsonSchema(operation.requestSchema)(request), true);
  const response = await fetch(new URL(operation.path, baseUrl), {
    method: operation.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status !== 200) {
    throw new Error(
      "Fixed archive search failed: " +
        response.status +
        " " +
        (await response.text()),
    );
  }
  const result = await response.json();
  assert.equal(compileJsonSchema(operation.responseSchema)(result), true);
  return result;
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
  expectedObservationCount: z.int().nonnegative(),
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
    throw new Error("Archive submission failed: " + (await response.text()));
  }
  return await response.json();
}

async function readArchiveItem(client: ArchiveClient, itemId: string) {
  const response = await client.archives.items[":itemId"].$get({
    param: { itemId },
    query: {},
  });
  if (response.status !== 200) {
    throw new Error("Archive item read failed: " + (await response.text()));
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
    throw new Error(
      "Archive revision comparison failed: " + (await response.text()),
    );
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
    title: "原始完整版本",
    sourcePublishedAt: null,
    sourceModifiedAt: null,
    extensions: {
      sourceDetails: { nested: { nullable: null, removed: "旧值" } },
      attributes: {
        nested: { nullable: null, removed: "旧值" },
        values: ["左", null, "右"],
      },
    },
    sourceRef: "https://example.test/resource-history",
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
    binId: "binny-runs-one",
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-text-marker-only" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {
          sourceDetails: { note: `binny://resource/${orphan.resourceId}` },
        },
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
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "invalid-resource-reference" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-attachment-only" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-history" },
        title: "本次只取得部分资料",
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {
          sourceDetails: { nested: { added: "新值" } },
          attributes: {
            nested: { nullable: null, added: "新值" },
            values: ["右", null, "左"],
          },
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
  assert.equal(partialRead.views[0]?.state.title, "本次只取得部分资料");
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
  assert.deepEqual(firstToPartialDiff.fields.extensions, {
    status: "changed",
    before: { present: true, value: originalState.extensions },
    after: {
      present: true,
      value: {
        sourceDetails: { nested: { added: "新值" } },
        attributes: {
          nested: { nullable: null, added: "新值" },
          values: ["右", null, "左"],
        },
      },
    },
  });
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "resource-history" },
        title: "补齐后的资料",
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: { attributes: { completion: { media: true } } },
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
  assert.equal(sameRevisionDiff.fields.extensions.status, "unchanged");
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
  assert.equal(historicRevision.state.title, "原始完整版本");
  assert.deepEqual(historicRevision.state.resources, [
    { resourceId: first.resourceId },
  ]);
  assert.equal(
    historicRevision.state.body?.markdown,
    `原文位置 binny://resource/${first.resourceId}；外链 https://example.test/image.png`,
  );

  const mediaTestUrl =
    "https://example.test/uploads/default/original/2X/0123456789abcdef0123456789abcdef01234567.png";
  await submitArchive(client, {
    requestId: "e2e:archive:immutable-media-resolve",
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "immutable-media-item" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {
          media: [{ url: mediaTestUrl, resourceId: first.resourceId }],
        },
        body: { text: "带不可变媒体引用的条目" },
        resources: [{ resourceId: first.resourceId }],
        capture: {
          scope: { case: "immutable-media" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });

  const resolveResponse = await client.resources.resolve.$post({
    json: {
      binId: "binny-runs-one",
      resourceIds: [first.resourceId, randomUUID()],
      sha256s: [
        first.sha256,
        "0000000000000000000000000000000000000000000000000000000000000000",
      ],
      sourceKeys: [
        { namespace: "e2e", key: "resource-history" },
        { namespace: "e2e", key: "resource-partial" },
        { namespace: "e2e", key: "non-existent" },
      ],
      immutableMediaUrls: [
        { namespace: "e2e", url: mediaTestUrl },
        { namespace: "e2e", url: "https://example.test/not-archived.png" },
      ],
    },
  });
  assert.equal(resolveResponse.status, 200);
  const resolveResult = await resolveResponse.json();
  assert.equal(resolveResult.resources.length, 1);
  assert.equal(resolveResult.resources[0]?.resourceId, first.resourceId);
  assert.equal(resolveResult.resources[0]?.sha256, first.sha256);
  assert.equal(resolveResult.items.length, 1);
  assert.equal(resolveResult.items[0]?.sourceKey.key, "resource-history");
  assert.equal(resolveResult.items[0]?.state.capture.completeness, "complete");
  assert.equal(
    resolveResult.items[0]?.resourceMetadata[0]?.resourceId,
    replacement.resourceId,
  );
  assert.equal(
    resolveResult.mediaByUrl[mediaTestUrl]?.resourceId,
    first.resourceId,
  );
  assert.equal(
    resolveResult.mediaByUrl["https://example.test/not-archived.png"],
    undefined,
  );

  const aliasResolveResponse = await client.archives.resources.resolve.$post({
    json: {
      resourceIds: [first.resourceId],
    },
  });
  assert.equal(aliasResolveResponse.status, 200);
  const aliasResult = await aliasResolveResponse.json();
  assert.equal(aliasResult.resources.length, 1);
  assert.equal(aliasResult.resources[0]?.resourceId, first.resourceId);

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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "atomic-baseline" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
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
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "empty-failure" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
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
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "unsafe-json-number" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {
            attributes: { count: Number.MAX_SAFE_INTEGER + 1 },
          },
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
    "extensions",
    "attributes",
    "count",
  ]);

  const validAtomicItem = {
    sourceKey: { namespace: "e2e", key: "atomic-retry" },
    title: null,
    sourcePublishedAt: null,
    sourceModifiedAt: null,
    extensions: {},
    body: { text: "原子拒绝后的对象" },
    capture: {
      scope: { case: "atomic" },
      completeness: "complete" as const,
      missing: [],
    },
  };
  const invalidBatch = {
    requestId: "e2e:archive:atomic-invalid",
    binId: "binny-runs-one",
    items: [
      validAtomicItem,
      {
        sourceKey: { namespace: "e2e" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    binId: "binny-runs-one",
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
  assert.equal(atomicRead.views[0]?.state.sourceModifiedAt, null);

  const partialCommit = await submitArchive(client, {
    requestId: "e2e:archive:partial-capture",
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "partial-capture" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    binId: "binny-runs-two",
    items: [
      {
        sourceKey: foreignTarget,
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    binId: "binny-runs-one",
    observedAt: "2026-10-28T04:20:00.000Z",
    items: [
      {
        sourceKey: from,
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
        body: { text: "关系来源资料" },
        capture: {
          scope: { case: "relation" },
          completeness: "complete",
          missing: [],
        },
      },
      {
        sourceKey: to,
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    { direction: "outgoing", binId: "binny-runs-one", limit: "2" },
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
    binId: "binny-runs-one",
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
      binId: "binny-runs-one",
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
    { direction: "outgoing", binId: "binny-runs-one", limit: "10" },
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
    binId: "binny-runs-one",
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
    binId: "binny-runs-one",
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: from,
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    { direction: "outgoing", binId: "binny-runs-one", limit: "10" },
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
      binId: "binny-runs-one",
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
    binId: "binny-runs-two",
    items: [],
    relations: [{ relationId: "e2e:relation:01-forward", value: secondState }],
  });
  assert.equal(secondaryObservation.items.length, 0);
  const secondaryRelations = await readArchiveRelations(
    client,
    fromItem.itemId,
    { direction: "outgoing", binId: "binny-runs-two", limit: "10" },
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
      binId: "binny-runs-one",
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
      binId: "binny-runs-two",
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
        binId: "binny-runs-one",
        limit: "100",
      }),
      readArchiveRelations(client, fromItem.itemId, {
        direction: "outgoing",
        binId: "binny-runs-two",
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
    binId: "binny-runs-one",
    items: [],
    relations: [{ relationId: "e2e:relation:01-forward", value: null }],
  });
  assert.equal(withdrawalCommit.relations[0]?.status, "withdrawn");
  assert.equal(withdrawalCommit.items.length, 0);
  const afterWithdrawal = await readArchiveRelations(client, fromItem.itemId, {
    direction: "outgoing",
    binId: "binny-runs-one",
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
    { direction: "outgoing", binId: "binny-runs-two", limit: "10" },
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
      binId: "binny-runs-one",
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
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e-relations", key: "atomic-from" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e-relations", key: "atomic-from" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    { direction: "outgoing", binId: "binny-runs-one", limit: "10" },
  );
  assert.deepEqual(rejectedRelationRead.relations, []);

  const timeline = await readArchiveTimeline(client, fromItem.itemId, {
    binId: "binny-runs-one",
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
        BigInt(left[0]) === BigInt(right[0])
          ? left[1] - right[1]
          : BigInt(left[0]) < BigInt(right[0])
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
    title: null,
    sourcePublishedAt: null,
    sourceModifiedAt: null,
    extensions: {},
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
    binId: "binny-runs-one",
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
    title: null,
    sourcePublishedAt: null,
    sourceModifiedAt: null,
    extensions: {
      sourceDetails: metadata,
      attributes: properties,
    },
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
    binId: "binny-runs-one",
    items: [state],
  };
  const first = await submitArchive(client, firstRequest);
  const itemId = first.items[0]?.itemId;
  const revisionId = first.items[0]?.revisionId;
  assert.ok(itemId);
  assert.ok(revisionId);

  const persisted = await readArchiveItem(client, itemId);
  assert.deepEqual(
    persisted.views[0]?.state.extensions.sourceDetails,
    metadata,
  );
  assert.deepEqual(persisted.views[0]?.state.extensions.attributes, properties);
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "prototype-json-conflict" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {
          attributes: Object.fromEntries([
            ["__proto__", { value: 1 }],
          ] as const),
        },
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
      items: [
        {
          ...firstConflictItem,
          extensions: { attributes: changedOwnKey },
        },
      ],
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
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "postgres-text-nul" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
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
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "postgres-text-key-nul" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: { attributes: { ["bad\u0000key"]: "value" } },
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
    ["items", 0, "extensions", "attributes", "bad\u0000key"],
    "键中含空字符的归档属性",
  );

  const validArchive = await submitArchive(client, {
    requestId: "e2e:archive:postgres-text-valid",
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "postgres-text-valid" },
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
      binId: "binny-runs-one",
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
      binId: "binny-runs-one",
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
  const sourceModifiedAtA = {
    precision: "instant" as const,
    value: "2026-10-28T12:00:00+08:00",
  };
  const abaA = {
    sourceKey: { namespace: "e2e", key: "aba-item" },
    title: "状态 A",
    sourcePublishedAt: null,
    extensions: {
      sourceDetails: { authors: ["writer"] },
      attributes: { counts: { replies: 2, stars: 4 }, tags: ["a", "b"] },
    },
    sourceRef: "https://example.test/aba-item",
    sourceModifiedAt: sourceModifiedAtA,
    body: { markdown: "正文 A🌿", searchText: "正文 A🌿" },
    capture: {
      scope: { source: "e2e", topic: "42" },
      completeness: "complete" as const,
      missing: [],
    },
  };
  const abaFirstRequest = {
    requestId: "e2e:archive:aba:first",
    binId: "binny-runs-one",
    runId: "run-a1",
    sourceAdapterVersion: "rss@1.0.0",
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
    binId: "binny-runs-one",
    runId: "run-a2",
    sourceAdapterVersion: "rss@1.1.0",
    observedAt: "2026-10-28T04:01:00.000Z",
    items: [
      {
        ...abaA,
        title: "状态 B",
        extensions: {
          sourceDetails: { authors: ["writer"] },
          attributes: {
            counts: { replies: 3, stars: 5 },
            tags: ["a", "b"],
          },
        },
        sourceModifiedAt: {
          precision: "instant" as const,
          value: "2026-10-28T04:01:00.000Z",
        },
        body: { markdown: "正文 B", searchText: "正文 B" },
        diagnostics: [{ code: "body_changed", message: "正文发生变化" }],
      },
    ],
  });
  const abaThird = await submitArchive(client, {
    requestId: "e2e:archive:aba:third",
    binId: "binny-runs-one",
    runId: "run-a3",
    sourceAdapterVersion: "rss@2.0.0",
    observedAt: "2026-10-28T04:03:00.000Z",
    items: [
      {
        ...abaA,
        title: "状态 A",
        extensions: {
          sourceDetails: { authors: ["writer"] },
          attributes: {
            tags: ["a", "b"],
            counts: { stars: 4, replies: 2 },
          },
        },
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
  assert.equal(firstToSecondDiff.fields.extensions.status, "changed");
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
    query: { binId: "binny-runs-one", asOf: abaSecond.archiveSeq },
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
  assert.deepEqual(
    historicalView.observations[0]?.sourceModifiedAt,
    sourceModifiedAtA,
  );
  assert.equal(
    historicalView.observations[0]?.observedAt,
    "2026-10-28T04:01:00.000Z",
  );
  assert.ok(historicalView.observations[0]?.recordedAt);

  const historicalTimeline = await readArchiveTimeline(
    client,
    abaThirdItem.itemId,
    { binId: "binny-runs-one", asOf: abaSecond.archiveSeq, limit: "10" },
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
    assert.equal(firstHistoricalItemEvent.binId, "binny-runs-one");
    assert.equal(firstHistoricalItemEvent.runId, "run-a1");
  }
  assert.equal(
    firstHistoricalItemEvent?.kind === "item"
      ? firstHistoricalItemEvent.sourceAdapterVersion
      : undefined,
    "rss@1.0.0",
  );
  assert.deepEqual(
    firstHistoricalItemEvent?.kind === "item"
      ? firstHistoricalItemEvent.sourceModifiedAt
      : undefined,
    sourceModifiedAtA,
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
    { binId: "binny-runs-one", limit: "1" },
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
      binId: "binny-runs-one",
      sourceAdapterVersion: "rss@2.1.0",
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
    { binId: "binny-runs-one", limit: "10" },
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
  assert.deepEqual(
    currentTimeline.events.filter((event) => event.kind === "item")[3]
      ?.sourceModifiedAt,
    sourceModifiedAtA,
  );
  assert.equal(
    currentTimeline.events.filter((event) => event.kind === "item")[3]
      ?.observedAt,
    "2026-10-28T03:59:00.000Z",
  );
  assert.equal(lateCommit.items[0]?.revisionId, abaFirstItem.revisionId);
  const firstCommitRead = await readArchiveCommit(client, abaFirst.commitId);
  assert.equal(firstCommitRead.runId, "run-a1");
  assert.equal(firstCommitRead.sourceAdapterVersion, "rss@1.0.0");
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
  assert.equal(lateCommitRead.sourceAdapterVersion, "rss@2.1.0");

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
  assert.deepEqual(abaRevision.state.sourceModifiedAt, sourceModifiedAtA);
  assert.equal(abaRevision.state.title, "状态 A");
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
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: concurrentSourceKey,
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: { sourceDetails: { view: "main" } },
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
      binId: "binny-runs-two",
      items: [
        {
          sourceKey: concurrentSourceKey,
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: { sourceDetails: { view: "secondary" } },
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
    "binny-runs-one",
    "binny-runs-two",
  ]);
  assert.equal(concurrentRead.observations.length, 2);
  assert.equal(
    concurrentRead.views.find(({ binId }) => binId === "binny-runs-one")?.state
      .body?.text,
    "main view",
  );
  assert.equal(
    concurrentRead.views.find(({ binId }) => binId === "binny-runs-two")?.state
      .body?.text,
    "secondary view",
  );
  assert.equal(concurrentRead.revisions.length, 2);

  const selectedMain = await client.archives.items[":itemId"].$get({
    param: { itemId: mainConcurrentItem.itemId },
    query: { binId: "binny-runs-one", asOf: mainCommit.archiveSeq },
  });
  assert.equal(selectedMain.status, 200);
  const selectedMainRead = await selectedMain.json();
  assert.equal(selectedMainRead.views.length, 1);
  assert.equal(selectedMainRead.views[0]?.binId, "binny-runs-one");
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

async function verifyFixedSearch(baseUrl: string): Promise<void> {
  const client = createApiClient(baseUrl);
  if (process.env.BINNY_E2E_ARCHIVE_EXTENSION_FIXTURES === "1") {
    await Promise.all(
      ["binny-runs-one", "binny-runs-two"].map((binId) =>
        submitExtensionSearchFixture(client, binId),
      ),
    );
    const schemaVariantResponse = await fetch(
      new URL("/bins/binny-runs-schema-two/extension-fields", baseUrl),
    );
    assert.equal(schemaVariantResponse.status, 200);
    if (schemaVariantResponse.status === 200) {
      const schemaVariant = (await schemaVariantResponse.json()) as {
        readonly sourceAdapterVersion: string;
        readonly fields: Readonly<
          Record<string, { readonly allowedValues?: readonly string[] }>
        >;
      };
      assert.equal(schemaVariant.sourceAdapterVersion, "2.0.0");
      assert.deepEqual(schemaVariant.fields.category?.allowedValues, [
        "comment",
      ]);
    }
  }
  const extensionFieldsResponse = await fetch(
    new URL("/bins/binny-runs-one/extension-fields", baseUrl),
  );
  assert.equal(extensionFieldsResponse.status, 200);
  if (extensionFieldsResponse.status === 200) {
    const extensionFields = (await extensionFieldsResponse.json()) as {
      readonly sourceAdapterId: string;
      readonly fields: Readonly<
        Record<
          string,
          {
            readonly type: string;
            readonly description?: string;
            readonly operations: readonly string[];
          }
        >
      >;
    };
    assert.equal(
      extensionFields.sourceAdapterId,
      "binny-runs.manual-run-fixture",
    );
    assert.deepEqual(extensionFields.fields.section, {
      type: "string",
      nullable: false,
      required: false,
      description: "The source section assigned to this archived item.",
      operations: ["eq", "in"],
    });
    assert.deepEqual(extensionFields.fields.category, {
      type: "string",
      nullable: false,
      required: false,
      description: "The category assigned to this archived item.",
      allowedValues: ["post", "comment"],
      operations: ["eq", "in"],
    });
    assert.deepEqual(extensionFields.fields.floor, {
      type: "integer",
      nullable: false,
      required: false,
      description: "The source floor number assigned to this archived item.",
      operations: ["eq", "in"],
    });
    assert.deepEqual(extensionFields.fields.labels, {
      type: "array",
      nullable: false,
      required: false,
      description: "Labels assigned to this archived item.",
      itemType: "string",
      operations: ["has", "hasAny"],
    });
    assert.deepEqual(extensionFields.fields.featured, {
      type: "boolean",
      nullable: false,
      required: false,
      description: "Whether the source marks this archived item as featured.",
      operations: ["eq", "in"],
    });
    assert.deepEqual(extensionFields.fields.nullableCategory, {
      type: "string",
      nullable: true,
      required: false,
      description: "The category assigned to this archived item.",
      operations: ["eq", "in"],
    });
    assert.deepEqual(extensionFields.fields.nullableLabels, {
      type: "array",
      nullable: true,
      required: false,
      description: "Labels assigned to this archived item.",
      itemType: "string",
      operations: ["has", "hasAny"],
    });
  }
  const discovery = await discoverArchiveQueryContract(baseUrl);
  const searchContract = discovery.queryContract.operations.search;
  const searchInput = compileJsonSchema(archiveApiSchemas.searchInput);
  const searchOutput = compileJsonSchema(archiveApiSchemas.searchPage);
  assert.equal(
    searchInput({
      extensions: {
        sourceAdapterId: "binny-runs.manual-run-fixture",
        filters: {
          section: { op: "eq", value: "archive-model-extension-change" },
        },
      },
    } as const),
    false,
  );

  const extensionScalarQuery = {
    bins: ["binny-runs-one"],
    extensions: {
      sourceAdapterId: "binny-runs.manual-run-fixture",
      filters: {
        section: { op: "eq", value: "archive-model-extension-change" },
      },
    },
    text: { groups: [["Typed archive stable body"]] },
    limit: 10,
  } as const;
  assert.equal(searchInput(extensionScalarQuery), true);
  const extensionScalarPage = archiveSearchPageSchema.parse(
    await postDiscoveredSearch(baseUrl, searchContract, extensionScalarQuery),
  );
  assert.equal(extensionScalarPage.results.length, 1);
  assert.equal(
    extensionScalarPage.results[0]?.title,
    "Typed archive public change",
  );
  assert.deepEqual(
    extensionScalarPage.results[0]?.matches.map(({ binId }) => binId),
    ["binny-runs-one"],
  );
  const unmatchedExtensionQuery = {
    ...extensionScalarQuery,
    extensions: {
      ...extensionScalarQuery.extensions,
      filters: {
        section: { op: "eq" as const, value: "not-the-declared-section" },
      },
    },
  };
  const unmatchedExtensionPage = archiveSearchPageSchema.parse(
    await postDiscoveredSearch(
      baseUrl,
      searchContract,
      unmatchedExtensionQuery,
    ),
  );
  assert.equal(unmatchedExtensionPage.results.length, 0);

  const implicitExtensionScope = await fetch(
    new URL("/archives/search", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensions: extensionScalarQuery.extensions }),
    },
  );
  assert.equal(implicitExtensionScope.status, 400);
  if (implicitExtensionScope.status === 400) {
    const error = (
      (await implicitExtensionScope.json()) as {
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly path: readonly (string | number)[];
        };
      }
    ).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["bins"]);
    assert.match(error.message, /explicit bin scope/u);
  }
  const invalidExtensionOperation = await fetch(
    new URL("/archives/search", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bins: ["binny-runs-one"],
        extensions: {
          sourceAdapterId: "binny-runs.manual-run-fixture",
          filters: {
            section: { op: "gt", value: "archive-model" },
          },
        },
      }),
    },
  );
  assert.equal(invalidExtensionOperation.status, 400);
  if (invalidExtensionOperation.status === 400) {
    const error = (
      (await invalidExtensionOperation.json()) as {
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly path: readonly (string | number)[];
        };
      }
    ).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["extensions", "filters", "section", "op"]);
    assert.match(error.message, /eq.*in.*has.*hasAny/u);
  }

  const invalidExtensionFilterShape = await fetch(
    new URL("/archives/search", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bins: ["binny-runs-one"],
        extensions: {
          sourceAdapterId: "binny-runs.manual-run-fixture",
          filters: [],
        },
      }),
    },
  );
  assert.equal(invalidExtensionFilterShape.status, 400);
  if (invalidExtensionFilterShape.status === 400) {
    const error = (
      (await invalidExtensionFilterShape.json()) as {
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly path: readonly (string | number)[];
        };
      }
    ).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["extensions", "filters"]);
    assert.match(error.message, /expected record/u);
  }

  const implicitExtensionDistributionScope = await fetch(
    new URL("/archives/search", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        includeCandidates: false,
        distribution: {
          by: "extension",
          sourceAdapterId: "binny-runs.manual-run-fixture",
          field: "category",
        },
      }),
    },
  );
  assert.equal(implicitExtensionDistributionScope.status, 400);
  if (implicitExtensionDistributionScope.status === 400) {
    const error = (
      (await implicitExtensionDistributionScope.json()) as {
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly path: readonly (string | number)[];
        };
      }
    ).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["bins"]);
    assert.match(error.message, /explicit bin scope/u);
  }

  const objectExtensionDistribution = await fetch(
    new URL("/archives/search", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bins: ["binny-runs-one"],
        includeCandidates: false,
        distribution: {
          by: "extension",
          sourceAdapterId: "binny-runs.manual-run-fixture",
          field: "sourceDetails",
        },
      }),
    },
  );
  assert.equal(objectExtensionDistribution.status, 400);
  if (objectExtensionDistribution.status === 400) {
    const error = (
      (await objectExtensionDistribution.json()) as {
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly path: readonly (string | number)[];
        };
      }
    ).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["distribution", "field"]);
    assert.match(error.message, /scalar or scalar list/u);
  }

  if (process.env.BINNY_E2E_ARCHIVE_EXTENSION_FIXTURES === "1") {
    const extensionSearch = async (query: Record<string, unknown>) =>
      archiveSearchPageSchema.parse(
        await postDiscoveredSearch(baseUrl, searchContract, query),
      );
    const multiBinScope = ["binny-runs-one", "binny-runs-two"];
    const scopedExtensionQuery = (filters: Record<string, unknown>) => ({
      bins: multiBinScope,
      extensions: {
        sourceAdapterId: "binny-runs.manual-run-fixture",
        filters,
      },
      limit: 20,
    });
    const postCategoryPage = await extensionSearch(
      scopedExtensionQuery({ category: { op: "eq", value: "post" } }),
    );
    assert.deepEqual(
      postCategoryPage.results.map(({ sourceKey }) => sourceKey),
      [
        {
          namespace: "binny-runs.extension-search-fixture",
          key: "multi-view-item",
        },
      ],
    );
    assert.deepEqual(
      postCategoryPage.results[0]?.matches.map(({ binId }) => binId),
      ["binny-runs-one"],
    );

    const floorInPage = await extensionSearch(
      scopedExtensionQuery({ floor: { op: "in", values: [7, 8] } }),
    );
    assert.deepEqual(
      floorInPage.results[0]?.matches.map(({ binId }) => binId),
      ["binny-runs-one", "binny-runs-two"],
    );
    const featuredPage = await extensionSearch(
      scopedExtensionQuery({ featured: { op: "eq", value: true } }),
    );
    assert.deepEqual(
      featuredPage.results[0]?.matches.map(({ binId }) => binId),
      ["binny-runs-one"],
    );
    const hasNewsPage = await extensionSearch(
      scopedExtensionQuery({ labels: { op: "has", value: "news" } }),
    );
    assert.deepEqual(
      hasNewsPage.results[0]?.matches.map(({ binId }) => binId),
      ["binny-runs-one"],
    );
    const hasAnyPage = await extensionSearch(
      scopedExtensionQuery({
        labels: { op: "hasAny", values: ["reply", "release"] },
      }),
    );
    assert.deepEqual(
      hasAnyPage.results[0]?.matches.map(({ binId }) => binId),
      ["binny-runs-one", "binny-runs-two"],
    );

    const labelDistribution = await extensionSearch({
      bins: multiBinScope,
      extensions: {
        sourceAdapterId: "binny-runs.manual-run-fixture",
        filters: {
          labels: { op: "hasAny", values: ["release", "reply"] },
        },
      },
      includeCandidates: false,
      distribution: {
        by: "extension",
        sourceAdapterId: "binny-runs.manual-run-fixture",
        field: "labels",
        limit: 1,
      },
    });
    assert.equal(labelDistribution.candidatesIncluded, false);
    assert.deepEqual(labelDistribution.results, []);
    assert.ok(labelDistribution.distribution);
    if (labelDistribution.distribution?.by !== "extension") {
      throw new Error("Expected an extension distribution page.");
    }
    assert.equal(labelDistribution.distribution.totalItems, "1");
    assert.deepEqual(labelDistribution.distribution.groups, [
      { kind: "extension", value: "news", itemCount: "1" },
    ]);
    assert.equal(labelDistribution.distribution.hasMore, true);
    assert.ok(labelDistribution.distribution.nextCursor);

    const labelDistributionNext = await extensionSearch({
      bins: multiBinScope,
      extensions: {
        sourceAdapterId: "binny-runs.manual-run-fixture",
        filters: {
          labels: { op: "hasAny", values: ["release", "reply"] },
        },
      },
      includeCandidates: false,
      limit: 1,
      distribution: {
        by: "extension",
        sourceAdapterId: "binny-runs.manual-run-fixture",
        field: "labels",
        limit: 5,
        cursor: labelDistribution.distribution.nextCursor,
      },
    });
    assert.ok(labelDistributionNext.distribution);
    if (labelDistributionNext.distribution?.by !== "extension") {
      throw new Error("Expected a continued extension distribution page.");
    }
    assert.equal(
      labelDistributionNext.distribution.totalItems,
      labelDistribution.distribution.totalItems,
    );
    assert.deepEqual(labelDistributionNext.distribution.groups, [
      { kind: "extension", value: "release", itemCount: "1" },
      { kind: "extension", value: "reply", itemCount: "1" },
    ]);
    assert.equal(labelDistributionNext.distribution.hasMore, false);
    assert.equal(labelDistributionNext.distribution.nextCursor, undefined);

    const categoryDistribution = await extensionSearch({
      bins: multiBinScope,
      text: { in: "title", groups: [["Extension"]] },
      includeCandidates: false,
      distribution: {
        by: "extension",
        sourceAdapterId: "binny-runs.manual-run-fixture",
        field: "category",
        limit: 10,
      },
    });
    assert.ok(categoryDistribution.distribution);
    if (categoryDistribution.distribution?.by !== "extension") {
      throw new Error("Expected a category distribution page.");
    }
    assert.equal(categoryDistribution.distribution.totalItems, "4");
    assert.deepEqual(categoryDistribution.distribution.groups, [
      { kind: "extension", value: "comment", itemCount: "1" },
      { kind: "extension", value: "post", itemCount: "1" },
      { kind: "missing", itemCount: "3" },
    ]);

    const allLabelValuesDistribution = await extensionSearch({
      bins: multiBinScope,
      text: { in: "title", groups: [["Extension"]] },
      includeCandidates: false,
      distribution: {
        by: "extension",
        sourceAdapterId: "binny-runs.manual-run-fixture",
        field: "labels",
        limit: 10,
      },
    });
    assert.ok(allLabelValuesDistribution.distribution);
    if (allLabelValuesDistribution.distribution?.by !== "extension") {
      throw new Error("Expected a label distribution page.");
    }
    assert.equal(allLabelValuesDistribution.distribution.totalItems, "4");
    assert.deepEqual(allLabelValuesDistribution.distribution.groups, [
      { kind: "extension", value: "news", itemCount: "1" },
      { kind: "extension", value: "release", itemCount: "1" },
      { kind: "extension", value: "reply", itemCount: "1" },
      { kind: "missing", itemCount: "3" },
    ]);

    const sameViewMiss = await extensionSearch({
      ...scopedExtensionQuery({ category: { op: "eq", value: "post" } }),
      text: { groups: [["release"]] },
    });
    assert.equal(sameViewMiss.results.length, 0);
    for (const query of [
      scopedExtensionQuery({ category: { op: "eq", value: "post" } }),
      scopedExtensionQuery({ labels: { op: "has", value: "news" } }),
      scopedExtensionQuery({ nullableCategory: { op: "eq", value: "post" } }),
      scopedExtensionQuery({ nullableLabels: { op: "has", value: "news" } }),
    ]) {
      const page = await extensionSearch(query);
      assert.equal(
        page.results.some(({ sourceKey }) =>
          ["missing-fields", "nullable-fields", "empty-list-fields"].includes(
            sourceKey.key,
          ),
        ),
        false,
      );
    }

    const invalidExtensionQueries = [
      {
        query: scopedExtensionQuery({ undeclared: { op: "eq", value: "x" } }),
        path: ["extensions", "filters", "undeclared"],
        message: /does not declare/u,
      },
      {
        query: scopedExtensionQuery({
          "sourceDetails.category": { op: "eq", value: "post" },
        }),
        path: ["extensions", "filters", "sourceDetails.category"],
        message: /top-level/u,
      },
      {
        query: scopedExtensionQuery({ floor: { op: "eq", value: "7" } }),
        path: ["extensions", "filters", "floor", "value"],
        message: /declared integer type/u,
      },
      {
        query: scopedExtensionQuery({
          category: { op: "has", value: "post" },
        }),
        path: ["extensions", "filters", "category", "op"],
        message: /allowed operations: eq, in/u,
      },
      {
        query: scopedExtensionQuery({
          category: { op: "in", values: ["post", "unknown"] },
        }),
        path: ["extensions", "filters", "category", "values", 1],
        message: /allowed values \["post","comment"\]/u,
      },
    ] as const;
    for (const { query, path, message } of invalidExtensionQueries) {
      const response = await client.archives.search.$post({
        json: query as never,
      });
      assert.equal(response.status, 400);
      if (response.status !== 400) continue;
      const error = (await response.json()).error;
      assert.equal(error.code, "invalid_input");
      assert.deepEqual(error.path, path);
      assert.match(error.message, message);
    }

    const mixedAdapterRange = await client.archives.search.$post({
      json: {
        bins: ["binny-runs-one", "binny-rss-one"],
        extensions: {
          sourceAdapterId: "binny-runs.manual-run-fixture",
          filters: { category: { op: "eq", value: "post" } },
        },
      } as never,
    });
    assert.equal(mixedAdapterRange.status, 400);
    if (mixedAdapterRange.status === 400) {
      const error = (await mixedAdapterRange.json()).error;
      assert.equal(error.code, "invalid_input");
      assert.deepEqual(error.path, ["bins"]);
      assert.match(error.message, /declared source adapter only/u);
    }

    const schemaMismatchRange = await client.archives.search.$post({
      json: {
        bins: ["binny-runs-one", "binny-runs-schema-two"],
        extensions: {
          sourceAdapterId: "binny-runs.manual-run-fixture",
          filters: { category: { op: "eq", value: "post" } },
        },
      } as never,
    });
    assert.equal(schemaMismatchRange.status, 400);
    if (schemaMismatchRange.status === 400) {
      const error = (await schemaMismatchRange.json()).error;
      assert.equal(error.code, "invalid_input");
      assert.deepEqual(error.path, [
        "extensions",
        "filters",
        "category",
        "value",
      ]);
      assert.match(error.message, /allowed values \["comment"\]/u);
    }
  }

  const runId = randomUUID();
  const prefix = "fixed-search:" + runId + ":";
  const makeItem = (key: string, title: string | null, text: string) => ({
    sourceKey: { namespace: "e2e", key: prefix + key },
    title,
    sourcePublishedAt: null,
    sourceModifiedAt: null,
    extensions: {},
    body: { text },
    capture: {
      scope: { case: "fixed-search" },
      completeness: "complete" as const,
      missing: [],
    },
  });

  const primary = await submitArchive(client, {
    requestId: "e2e:fixed-search:primary:" + runId,
    binId: "binny-runs-one",
    observedAt: "2026-11-09T14:00:00.000Z",
    items: [
      makeItem("shared", "Needle model", "A literal release is available."),
      makeItem("split", "CrossViewAlpha", "No second keyword here."),
      makeItem(
        "distribution-shared",
        "Distribution shared",
        "Distribution marker.",
      ),
      makeItem(
        "distribution-primary",
        "Distribution primary",
        "Distribution marker.",
      ),
      {
        ...makeItem("title-only", "TitleOnlyToken", "Unrelated body."),
        body: {
          text: "Unrelated body.",
          searchText: "TitleOnlyToken\nUnrelated body.",
        },
      },
      makeItem("body-only", "Unrelated title", "BodyOnlyToken is archived."),
      {
        ...makeItem("search-text-only", null, ""),
        body: { searchText: "SearchTextFallbackToken" },
      },
      {
        ...makeItem("search-text-with-text", null, "Unrelated body."),
        body: {
          text: "Unrelated body.",
          searchText: "SearchTextFallbackToken",
        },
      },
      {
        ...makeItem("split-representation", null, "alpha"),
        body: { text: "alpha", markdown: "beta" },
      },
    ],
  });
  const secondary = await submitArchive(client, {
    requestId: "e2e:fixed-search:secondary:" + runId,
    binId: "binny-runs-two",
    observedAt: "2026-11-09T15:00:00.000Z",
    items: [
      makeItem("shared", "needle model", "Another literal release."),
      makeItem("split", "Unrelated title", "CrossViewBeta only."),
      makeItem(
        "distribution-shared",
        "Distribution shared",
        "Distribution marker.",
      ),
    ],
  });
  const updated = await submitArchive(client, {
    requestId: "e2e:fixed-search:update:" + runId,
    binId: "binny-runs-one",
    observedAt: "2026-11-09T15:30:00.000Z",
    items: [
      makeItem(
        "shared",
        "Needle model updated",
        "The literal release was updated.",
      ),
    ],
  });
  const primaryShared = primary.items.find(
    ({ sourceKey }) => sourceKey.key === prefix + "shared",
  );
  const secondaryShared = secondary.items.find(
    ({ sourceKey }) => sourceKey.key === prefix + "shared",
  );
  const latestPrimaryShared = updated.items[0];
  const splitItem = primary.items.find(
    ({ sourceKey }) => sourceKey.key === prefix + "split",
  );
  const searchTextOnlyItem = primary.items.find(
    ({ sourceKey }) => sourceKey.key === prefix + "search-text-only",
  );
  assert.ok(
    primaryShared &&
      secondaryShared &&
      latestPrimaryShared &&
      splitItem &&
      searchTextOnlyItem,
  );
  assert.equal(primaryShared.itemId, secondaryShared.itemId);
  assert.equal(primaryShared.itemId, latestPrimaryShared.itemId);

  const query: ArchiveSearchRequest = {
    bins: ["binny-runs-one", "binny-runs-two"],
    text: {
      in: "both" as const,
      groups: [["not-present", "NEEDLE"], ["release"]],
    },
    limit: 10,
  };
  assert.equal(searchInput(query), true);
  const discoveredResult = await postDiscoveredSearch(
    baseUrl,
    searchContract,
    query,
  );
  assert.equal(searchOutput(discoveredResult), true);
  const page = archiveSearchPageSchema.parse(discoveredResult);
  assert.equal(page.results.length, 1);
  const shared = page.results[0];
  assert.ok(shared);
  assert.equal(shared.itemId, primaryShared.itemId);
  assert.equal(shared.title, "Needle model updated");
  assert.equal(shared.observedAt, "2026-11-09T15:30:00.000Z");
  assert.deepEqual(
    shared.matches.map(({ binId, revisionId }) => [binId, revisionId]),
    [
      ["binny-runs-one", latestPrimaryShared.revisionId],
      ["binny-runs-two", secondaryShared.revisionId],
    ],
  );

  const binDistributionQuery: ArchiveSearchRequest = {
    bins: ["binny-runs-one", "binny-runs-two"],
    text: { in: "title", groups: [["Distribution"]] },
    limit: 1,
    distribution: { by: "bin", limit: 1 },
  };
  const binDistributionResponse = await client.archives.search.$post({
    json: binDistributionQuery,
  });
  assert.equal(binDistributionResponse.status, 200);
  if (binDistributionResponse.status !== 200) {
    throw new Error("Bin distribution search failed.");
  }
  const binDistribution = await binDistributionResponse.json();
  assert.equal(binDistribution.candidatesIncluded, true);
  assert.deepEqual(
    binDistribution.results.map(({ title }) => title),
    ["Distribution shared"],
  );
  assert.equal(binDistribution.hasMore, true);
  assert.ok(binDistribution.nextCursor);
  assert.ok(binDistribution.distribution);
  if (binDistribution.distribution?.by !== "bin") {
    throw new Error("Expected a bin distribution page.");
  }
  assert.equal(binDistribution.distribution.totalItems, "2");
  assert.deepEqual(binDistribution.distribution.groups, [
    { kind: "bin", binId: "binny-runs-one", itemCount: "2" },
  ]);
  assert.equal(binDistribution.distribution.hasMore, true);
  assert.ok(binDistribution.distribution.nextCursor);

  const distributionOnlyResponse = await client.archives.search.$post({
    json: {
      bins: binDistributionQuery.bins,
      text: binDistributionQuery.text,
      includeCandidates: false,
      limit: 9,
      distribution: {
        by: "bin",
        limit: 5,
        cursor: binDistribution.distribution.nextCursor,
      },
    },
  });
  assert.equal(distributionOnlyResponse.status, 200);
  if (distributionOnlyResponse.status !== 200) {
    throw new Error("Distribution-only continuation failed.");
  }
  const distributionOnly = await distributionOnlyResponse.json();
  assert.equal(distributionOnly.snapshot.asOf, binDistribution.snapshot.asOf);
  assert.equal(distributionOnly.candidatesIncluded, false);
  assert.deepEqual(distributionOnly.results, []);
  assert.equal(distributionOnly.hasMore, false);
  assert.equal(distributionOnly.nextCursor, undefined);
  assert.ok(distributionOnly.distribution);
  if (distributionOnly.distribution?.by !== "bin") {
    throw new Error("Expected a bin distribution page.");
  }
  assert.equal(distributionOnly.distribution.totalItems, "2");
  assert.deepEqual(distributionOnly.distribution.groups, [
    { kind: "bin", binId: "binny-runs-two", itemCount: "1" },
  ]);
  assert.equal(distributionOnly.distribution.hasMore, false);
  assert.equal(distributionOnly.distribution.nextCursor, undefined);

  const candidateContinuationResponse = await client.archives.search.$post({
    json: {
      bins: binDistributionQuery.bins,
      text: binDistributionQuery.text,
      cursor: binDistribution.nextCursor,
      limit: 10,
      distribution: {
        by: "bin",
        limit: 5,
        cursor: binDistribution.distribution.nextCursor,
      },
    },
  });
  assert.equal(candidateContinuationResponse.status, 200);
  if (candidateContinuationResponse.status !== 200) {
    throw new Error("Candidate continuation after distribution failed.");
  }
  const candidateContinuation = await candidateContinuationResponse.json();
  assert.equal(
    candidateContinuation.snapshot.asOf,
    binDistribution.snapshot.asOf,
  );
  assert.deepEqual(
    candidateContinuation.results.map(({ title }) => title),
    ["Distribution primary"],
  );
  assert.equal(candidateContinuation.hasMore, false);
  assert.ok(candidateContinuation.distribution);
  if (candidateContinuation.distribution?.by !== "bin") {
    throw new Error("Expected a continued bin distribution page.");
  }
  assert.equal(candidateContinuation.distribution.totalItems, "2");
  assert.deepEqual(candidateContinuation.distribution.groups, [
    { kind: "bin", binId: "binny-runs-two", itemCount: "1" },
  ]);
  assert.equal(candidateContinuation.distribution.hasMore, false);

  const mismatchedDistributionCursor = await client.archives.search.$post({
    json: {
      bins: binDistributionQuery.bins,
      text: { in: "title", groups: [["different distribution"]] },
      includeCandidates: false,
      distribution: {
        by: "bin",
        cursor: binDistribution.distribution.nextCursor,
      },
    },
  });
  assert.equal(mismatchedDistributionCursor.status, 400);
  if (mismatchedDistributionCursor.status === 400) {
    assert.deepEqual((await mismatchedDistributionCursor.json()).error.path, [
      "distribution",
      "cursor",
    ]);
  }

  const zeroDistributionToken = "zero-distribution-" + randomUUID();
  const zeroMatchDistributionResponse = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "body", groups: [[zeroDistributionToken]] },
      includeCandidates: false,
      distribution: { by: "bin" },
    },
  });
  assert.equal(zeroMatchDistributionResponse.status, 200);
  if (zeroMatchDistributionResponse.status !== 200) {
    throw new Error("Zero-match distribution search failed.");
  }
  const zeroMatchDistribution = await zeroMatchDistributionResponse.json();
  assert.equal(zeroMatchDistribution.candidatesIncluded, false);
  assert.equal(zeroMatchDistribution.distribution?.totalItems, "0");
  assert.deepEqual(zeroMatchDistribution.distribution?.groups, []);
  assert.equal(zeroMatchDistribution.distribution?.hasMore, false);
  assert.equal(zeroMatchDistribution.distribution?.nextCursor, undefined);

  const noConditionDistributionResponse = await client.archives.search.$post({
    json: {
      includeCandidates: false,
      distribution: { by: "bin", limit: 100 },
    },
  });
  assert.equal(noConditionDistributionResponse.status, 200);
  if (noConditionDistributionResponse.status !== 200) {
    throw new Error("No-condition distribution search failed.");
  }
  const noConditionDistribution = await noConditionDistributionResponse.json();
  assert.ok(noConditionDistribution.distribution);
  if (noConditionDistribution.distribution?.by !== "bin") {
    throw new Error("Expected a bin distribution page.");
  }
  assert.ok(Number(noConditionDistribution.distribution.totalItems) > 0);
  assert.ok(
    noConditionDistribution.distribution.groups.some(
      ({ binId }) => binId === "binny-runs-one",
    ),
  );

  const crossView = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one", "binny-runs-two"],
      text: { in: "both", groups: [["CrossViewAlpha"], ["CrossViewBeta"]] },
    },
  });
  assert.equal(crossView.status, 200);
  if (crossView.status !== 200) throw new Error("Fixed search failed.");
  assert.equal(
    (await crossView.json()).results.some(
      ({ itemId }) => itemId === splitItem.itemId,
    ),
    false,
  );

  const titleOnly = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "title", groups: [["TitleOnlyToken"]] },
    },
  });
  assert.equal(titleOnly.status, 200);
  if (titleOnly.status !== 200) throw new Error("Title search failed.");
  assert.equal((await titleOnly.json()).results.length, 1);

  const bodyOnly = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "body", groups: [["BodyOnlyToken"]] },
    },
  });
  assert.equal(bodyOnly.status, 200);
  if (bodyOnly.status !== 200) throw new Error("Body search failed.");
  assert.equal((await bodyOnly.json()).results.length, 1);

  const titleExcludedFromBody = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "body", groups: [["TitleOnlyToken"]] },
    },
  });
  assert.equal(titleExcludedFromBody.status, 200);
  if (titleExcludedFromBody.status !== 200)
    throw new Error("Body search failed.");
  assert.equal((await titleExcludedFromBody.json()).results.length, 0);

  const searchTextFallback = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "body", groups: [["SearchTextFallbackToken"]] },
    },
  });
  assert.equal(searchTextFallback.status, 200);
  if (searchTextFallback.status !== 200)
    throw new Error("Body fallback search failed.");
  assert.deepEqual(
    (await searchTextFallback.json()).results.map(({ itemId }) => itemId),
    [searchTextOnlyItem.itemId],
  );

  const splitRepresentations = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "body", groups: [["alpha beta"]] },
    },
  });
  assert.equal(splitRepresentations.status, 200);
  if (splitRepresentations.status !== 200)
    throw new Error("Body search failed.");
  assert.equal((await splitRepresentations.json()).results.length, 0);

  const zeroCondition = await client.archives.search.$post({
    json: { bins: ["binny-runs-one"], limit: 1 },
  });
  assert.equal(zeroCondition.status, 200);
  if (zeroCondition.status !== 200) throw new Error("Enumeration failed.");
  assert.equal((await zeroCondition.json()).results.length, 1);

  const paginationToken = prefix + "pagination";
  const tiedAt = "2026-11-09T16:00:00.000Z";
  const newerPage = await submitArchive(client, {
    requestId: "e2e:fixed-search:pagination-new:" + runId,
    binId: "binny-runs-one",
    observedAt: tiedAt,
    items: [
      makeItem("page-a", "Page A", paginationToken),
      makeItem("page-b", "Page B", paginationToken),
    ],
  });
  const olderPage = await submitArchive(client, {
    requestId: "e2e:fixed-search:pagination-old:" + runId,
    binId: "binny-runs-one",
    observedAt: "2026-11-09T15:00:00.000Z",
    items: [makeItem("page-c", "Page C", paginationToken)],
  });
  const stableIds = [
    ...newerPage.items.map(({ itemId }) => itemId).toSorted(),
    ...olderPage.items.map(({ itemId }) => itemId).toSorted(),
  ];
  const paginationQuery = {
    bins: ["binny-runs-one"],
    text: { in: "body" as const, groups: [[paginationToken]] },
  };
  const firstResponse = await client.archives.search.$post({
    json: { ...paginationQuery, limit: 1 },
  });
  assert.equal(firstResponse.status, 200);
  if (firstResponse.status !== 200) throw new Error("First page failed.");
  const firstPage = await firstResponse.json();
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.hasMore, firstPage.nextCursor !== undefined);
  assert.deepEqual(
    firstPage.results.map(({ itemId }) => itemId),
    [stableIds[0]],
  );
  assert.ok(firstPage.nextCursor);

  await submitArchive(client, {
    requestId: "e2e:fixed-search:pagination-after-snapshot:" + runId,
    binId: "binny-runs-one",
    observedAt: "2026-11-10T16:00:00.000Z",
    items: [makeItem("page-late", "Later page", paginationToken)],
  });
  const secondResponse = await client.archives.search.$post({
    json: {
      ...paginationQuery,
      cursor: firstPage.nextCursor,
      limit: 2,
    },
  });
  assert.equal(secondResponse.status, 200);
  if (secondResponse.status !== 200) throw new Error("Next page failed.");
  const secondPage = await secondResponse.json();
  assert.equal(secondPage.snapshot.asOf, firstPage.snapshot.asOf);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.hasMore, secondPage.nextCursor !== undefined);
  assert.deepEqual(
    secondPage.results.map(({ itemId }) => itemId),
    stableIds.slice(1),
  );
  assert.equal(secondPage.nextCursor, undefined);

  const reusedSnapshot = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one", "binny-runs-two"],
      text: { groups: [["Needle"]] },
      asOf: firstPage.snapshot.asOf,
      limit: 10,
    },
  });
  assert.equal(reusedSnapshot.status, 200);
  if (reusedSnapshot.status !== 200)
    throw new Error("Reusing a snapshot failed.");
  assert.equal(
    (await reusedSnapshot.json()).snapshot.asOf,
    firstPage.snapshot.asOf,
  );

  const mismatchedCursor = await client.archives.search.$post({
    json: {
      ...paginationQuery,
      text: { in: "body", groups: [["different query"]] },
      cursor: firstPage.nextCursor,
      limit: 2,
    },
  });
  assert.equal(mismatchedCursor.status, 400);
  if (mismatchedCursor.status === 400) {
    assert.deepEqual((await mismatchedCursor.json()).error.path, ["cursor"]);
  }
  const malformedCursor = await client.archives.search.$post({
    json: { ...paginationQuery, cursor: "invalid", limit: 2 },
  });
  assert.equal(malformedCursor.status, 400);
}

async function verifyTimeWindowSearch(baseUrl: string): Promise<void> {
  const client = createApiClient(baseUrl);
  const runId = randomUUID();
  const token = "beijing-window-" + runId;
  const instant = (value: string) => ({
    precision: "instant" as const,
    value,
    timeZone: "Asia/Shanghai",
  });
  const fixtures = [
    {
      key: "before",
      sourcePublishedAt: instant("2026-11-07T23:59:59.999+08:00"),
      sourceModifiedAt: null,
    },
    {
      key: "from",
      sourcePublishedAt: instant("2026-11-08T00:00:00+08:00"),
      sourceModifiedAt: null,
    },
    {
      key: "middle",
      sourcePublishedAt: instant("2026-11-08T20:00:00+08:00"),
      sourceModifiedAt: null,
    },
    {
      key: "until",
      sourcePublishedAt: instant("2026-11-09T00:00:00+08:00"),
      sourceModifiedAt: null,
    },
    {
      key: "day-known",
      sourcePublishedAt: {
        precision: "day",
        value: "2026-11-08",
        timeZone: "Asia/Shanghai",
      },
      sourceModifiedAt: null,
    },
    {
      key: "day-utc",
      sourcePublishedAt: {
        precision: "day",
        value: "2026-11-08",
        timeZone: "UTC",
      },
      sourceModifiedAt: null,
    },
    {
      key: "day-without-zone",
      sourcePublishedAt: { precision: "day", value: "2026-11-08" },
      sourceModifiedAt: null,
    },
    {
      key: "old-day-without-zone",
      sourcePublishedAt: { precision: "day", value: "2020-01-01" },
      sourceModifiedAt: null,
    },
    {
      key: "month-overlap",
      sourcePublishedAt: {
        precision: "month",
        value: "2026-11",
        timeZone: "Asia/Shanghai",
      },
      sourceModifiedAt: null,
    },
    {
      key: "year-overlap",
      sourcePublishedAt: {
        precision: "year",
        value: "2026",
        timeZone: "Asia/Shanghai",
      },
      sourceModifiedAt: null,
    },
    {
      key: "modified-only",
      sourcePublishedAt: instant("2026-11-07T12:00:00+08:00"),
      sourceModifiedAt: instant("2026-11-08T12:00:00+08:00"),
    },
    {
      key: "modified-alias",
      sourcePublishedAt: instant("2026-11-07T12:00:00+08:00"),
      sourceModifiedAt: {
        precision: "day",
        value: "2026-07-01",
        timeZone: "CET",
      },
    },
    {
      key: "missing",
      sourcePublishedAt: null,
      sourceModifiedAt: null,
    },
    {
      key: "missing-two",
      sourcePublishedAt: null,
      sourceModifiedAt: null,
    },
    {
      key: "multi-view",
      sourcePublishedAt: instant("2026-11-08T10:00:00+08:00"),
      sourceModifiedAt: null,
    },
    {
      key: "summer-cet-day",
      sourcePublishedAt: {
        precision: "day",
        value: "2026-07-01",
        timeZone: "CET",
      },
      sourceModifiedAt: null,
    },
    {
      key: "dst-day",
      sourcePublishedAt: {
        precision: "day",
        value: "2026-03-29",
        timeZone: "Europe/Brussels",
      },
      sourceModifiedAt: null,
    },
    {
      key: "dst-inside",
      sourcePublishedAt: {
        precision: "instant",
        value: "2026-03-29T21:30:00+00:00",
      },
      sourceModifiedAt: null,
    },
    {
      key: "dst-outside",
      sourcePublishedAt: {
        precision: "instant",
        value: "2026-03-29T22:30:00+00:00",
      },
      sourceModifiedAt: null,
    },
  ] as const;
  const committed = await submitArchive(client, {
    requestId: "e2e:time-window:first:" + runId,
    binId: "binny-runs-one",
    items: fixtures.map(({ key, sourcePublishedAt, sourceModifiedAt }) => ({
      sourceKey: { namespace: "e2e", key: token + ":" + key },
      title: "Beijing window " + key,
      sourcePublishedAt,
      sourceModifiedAt,
      extensions: {},
      body: { text: token },
      capture: {
        scope: { case: "time-window" },
        completeness: "complete" as const,
        missing: [],
      },
    })),
  });
  const itemIds = new Map(
    committed.items.map(({ sourceKey, itemId }) => [sourceKey.key, itemId]),
  );
  const itemId = (key: string): string => {
    const found = itemIds.get(token + ":" + key);
    assert.ok(found);
    return found;
  };
  const multiViewItemId = itemId("multi-view");
  const secondaryView = await submitArchive(client, {
    requestId: "e2e:time-window:secondary:" + runId,
    binId: "binny-runs-two",
    items: [
      {
        sourceKey: { namespace: "e2e", key: token + ":multi-view" },
        title: "Beijing window multi-view without zone",
        sourcePublishedAt: { precision: "day", value: "2026-11-08" },
        sourceModifiedAt: null,
        extensions: {},
        body: { text: token },
        capture: {
          scope: { case: "time-window" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  assert.equal(secondaryView.items[0]?.itemId, multiViewItemId);

  const dateDistributionRequest: ArchiveSearchRequest = {
    bins: ["binny-runs-one", "binny-runs-two"],
    text: { in: "body", groups: [[token]] },
    includeCandidates: false,
    limit: 1,
    distribution: {
      by: "date",
      field: "sourcePublishedAt",
      period: "day",
      timeZone: "Asia/Shanghai",
      limit: 2,
    },
  };
  const dateDistributionResponse = await client.archives.search.$post({
    json: dateDistributionRequest,
  });
  assert.equal(dateDistributionResponse.status, 200);
  if (dateDistributionResponse.status !== 200) {
    throw new Error("Date distribution search failed.");
  }
  const dateDistribution = await dateDistributionResponse.json();
  assert.equal(dateDistribution.candidatesIncluded, false);
  assert.deepEqual(dateDistribution.results, []);
  assert.equal(dateDistribution.hasMore, false);
  assert.equal(dateDistribution.nextCursor, undefined);
  assert.ok(dateDistribution.distribution);
  if (dateDistribution.distribution?.by !== "date") {
    throw new Error("Expected a date distribution page.");
  }
  assert.equal(dateDistribution.distribution.totalItems, "19");
  assert.deepEqual(dateDistribution.distribution.groups, [
    { kind: "date", value: "2026-03-30", itemCount: "2" },
    { kind: "date", value: "2026-11-07", itemCount: "3" },
  ]);
  assert.equal(dateDistribution.distribution.hasMore, true);
  assert.ok(dateDistribution.distribution.nextCursor);

  const query: ArchiveSearchRequest = {
    bins: ["binny-runs-one", "binny-runs-two"],
    text: { in: "body", groups: [[token]] },
    limit: 2,
    timeWindow: {
      field: "sourcePublishedAt",
      from: "2026-11-08",
      until: "2026-11-09",
      timeZone: "Asia/Shanghai",
    },
  };
  const certainResponse = await client.archives.search.$post({ json: query });
  assert.equal(certainResponse.status, 200);
  if (certainResponse.status !== 200)
    throw new Error("Certain-time search failed.");
  const certain = await certainResponse.json();
  assert.ok(certain.timeSummary);
  assert.equal(certain.timeSummary.certainItems, "4");
  assert.equal(certain.timeSummary.undeterminedItems, "7");
  assert.deepEqual(
    certain.results.map(({ itemId }) => itemId),
    [itemId("middle"), multiViewItemId],
  );
  assert.equal(certain.results[0]?.timeStatus, "certain");
  assert.equal(certain.results[0]?.matches[0]?.timeMatch?.status, "certain");
  assert.deepEqual(
    certain.results[1]?.matches.map(({ binId }) => binId),
    ["binny-runs-one"],
  );
  assert.equal(certain.hasMore, true);
  assert.equal(certain.hasMore, certain.nextCursor !== undefined);
  assert.ok(certain.nextCursor);
  const snapshotAsOf = certain.snapshot.asOf;

  const afterSnapshot = await submitArchive(client, {
    requestId: "e2e:time-window:after-snapshot:" + runId,
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: { namespace: "e2e", key: token + ":later" },
        title: "Later Beijing window item",
        sourcePublishedAt: instant("2026-11-08T12:00:00+08:00"),
        sourceModifiedAt: null,
        extensions: {},
        body: { text: token },
        capture: {
          scope: { case: "time-window" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });

  const dateDistributionNextResponse = await client.archives.search.$post({
    json: {
      ...dateDistributionRequest,
      limit: 20,
      distribution: {
        by: "date",
        field: "sourcePublishedAt",
        period: "day",
        timeZone: "Asia/Shanghai",
        limit: 10,
        cursor: dateDistribution.distribution.nextCursor,
      },
    },
  });
  assert.equal(dateDistributionNextResponse.status, 200);
  if (dateDistributionNextResponse.status !== 200) {
    throw new Error("Date distribution continuation failed.");
  }
  const dateDistributionNext = await dateDistributionNextResponse.json();
  assert.equal(
    dateDistributionNext.snapshot.asOf,
    dateDistribution.snapshot.asOf,
  );
  assert.ok(dateDistributionNext.distribution);
  if (dateDistributionNext.distribution?.by !== "date") {
    throw new Error("Expected a continued date distribution page.");
  }
  assert.equal(dateDistributionNext.distribution.totalItems, "19");
  assert.deepEqual(dateDistributionNext.distribution.groups, [
    { kind: "date", value: "2026-11-08", itemCount: "4" },
    { kind: "date", value: "2026-11-09", itemCount: "1" },
    { kind: "undetermined", reason: "missingTime", itemCount: "2" },
    { kind: "undetermined", reason: "missingTimeZone", itemCount: "3" },
    {
      kind: "undetermined",
      reason: "precisionOverlapsBoundary",
      itemCount: "5",
    },
  ]);
  assert.equal(dateDistributionNext.distribution.hasMore, false);
  assert.equal(dateDistributionNext.distribution.nextCursor, undefined);

  const monthDistributionResponse = await client.archives.search.$post({
    json: {
      ...dateDistributionRequest,
      asOf: dateDistribution.snapshot.asOf,
      distribution: {
        by: "date",
        field: "sourcePublishedAt",
        period: "month",
        timeZone: "Asia/Shanghai",
        limit: 20,
      },
    },
  });
  assert.equal(monthDistributionResponse.status, 200);
  if (monthDistributionResponse.status !== 200) {
    throw new Error("Month distribution search failed.");
  }
  const monthDistribution = await monthDistributionResponse.json();
  assert.ok(monthDistribution.distribution);
  if (monthDistribution.distribution?.by !== "date") {
    throw new Error("Expected a month distribution page.");
  }
  assert.deepEqual(monthDistribution.distribution.groups, [
    { kind: "date", value: "2026-03", itemCount: "3" },
    { kind: "date", value: "2026-07", itemCount: "1" },
    { kind: "date", value: "2026-11", itemCount: "11" },
    { kind: "undetermined", reason: "missingTime", itemCount: "2" },
    { kind: "undetermined", reason: "missingTimeZone", itemCount: "1" },
    {
      kind: "undetermined",
      reason: "precisionOverlapsBoundary",
      itemCount: "1",
    },
  ]);

  const modifiedAliasDistributionResponse = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: {
        in: "title",
        groups: [["Beijing window modified-alias"]],
      },
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-07",
        until: "2026-11-08",
        timeZone: "Asia/Shanghai",
      },
      distribution: {
        by: "date",
        field: "sourceModifiedAt",
        period: "day",
        timeZone: "Europe/Brussels",
      },
    },
  });
  assert.equal(modifiedAliasDistributionResponse.status, 200);
  if (modifiedAliasDistributionResponse.status !== 200) {
    throw new Error("Modified-time date distribution search failed.");
  }
  const modifiedAliasDistribution =
    await modifiedAliasDistributionResponse.json();
  assert.ok(modifiedAliasDistribution.distribution);
  if (modifiedAliasDistribution.distribution?.by !== "date") {
    throw new Error("Expected a modified-time date distribution page.");
  }
  assert.deepEqual(modifiedAliasDistribution.distribution.groups, [
    { kind: "date", value: "2026-07-01", itemCount: "1" },
  ]);

  const certainNextPageResponse = await client.archives.search.$post({
    json: {
      ...query,
      cursor: certain.nextCursor,
      limit: 10,
    },
  });
  assert.equal(certainNextPageResponse.status, 200);
  if (certainNextPageResponse.status !== 200) {
    throw new Error("Certain-time cursor page failed.");
  }
  const certainNextPage = await certainNextPageResponse.json();
  assert.equal(certainNextPage.snapshot.asOf, snapshotAsOf);
  assert.deepEqual(certainNextPage.timeSummary, certain.timeSummary);
  assert.equal(certainNextPage.hasMore, false);
  assert.equal(
    certainNextPage.hasMore,
    certainNextPage.nextCursor !== undefined,
  );
  assert.equal(certainNextPage.nextCursor, undefined);
  const certainIds = [
    ...certain.results.map(({ itemId }) => itemId),
    ...certainNextPage.results.map(({ itemId }) => itemId),
  ];
  assert.deepEqual(
    certainIds.toSorted(),
    [
      itemId("from"),
      itemId("middle"),
      itemId("day-known"),
      multiViewItemId,
    ].toSorted(),
  );
  assert.equal(certainIds.includes(afterSnapshot.items[0]!.itemId), false);
  assert.equal(certainIds.includes(itemId("before")), false);
  assert.equal(certainIds.includes(itemId("until")), false);
  assert.equal(certainIds.includes(itemId("old-day-without-zone")), false);

  const modifiedTimeResponse = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "title", groups: [["Beijing window modified-only"]] },
      timeWindow: {
        field: "sourceModifiedAt",
        from: "2026-11-08",
        until: "2026-11-09",
        timeZone: "Asia/Shanghai",
      },
    },
  });
  assert.equal(modifiedTimeResponse.status, 200);
  if (modifiedTimeResponse.status !== 200) {
    throw new Error("Source-modified time search failed.");
  }
  const modifiedTimePage = await modifiedTimeResponse.json();
  assert.deepEqual(
    modifiedTimePage.results.map(({ itemId: resultId }) => resultId),
    [itemId("modified-only")],
  );

  const cetAliasResponse = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: {
        in: "title",
        groups: [["Beijing window summer-cet-day"]],
      },
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-07-01",
        until: "2026-07-02",
        timeZone: "Europe/Brussels",
      },
    },
  });
  assert.equal(cetAliasResponse.status, 200);
  if (cetAliasResponse.status !== 200) {
    throw new Error("Canonical source-zone alias search failed.");
  }
  const cetAliasPage = await cetAliasResponse.json();
  assert.deepEqual(
    cetAliasPage.results.map(({ itemId: resultId }) => resultId),
    [itemId("summer-cet-day")],
  );

  const daylightSavingResponse = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: {
        in: "title",
        groups: [["Beijing window dst-"]],
      },
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-03-29",
        until: "2026-03-30",
        timeZone: "Europe/Brussels",
      },
    },
  });
  assert.equal(daylightSavingResponse.status, 200);
  if (daylightSavingResponse.status !== 200) {
    throw new Error("Daylight-saving time-window search failed.");
  }
  const daylightSavingPage = await daylightSavingResponse.json();
  assert.deepEqual(daylightSavingPage.timeSummary, {
    certainItems: "2",
    undeterminedItems: "0",
  });
  assert.deepEqual(
    daylightSavingPage.results
      .map(({ itemId: resultId }) => resultId)
      .toSorted(),
    [itemId("dst-day"), itemId("dst-inside")].toSorted(),
  );

  const invalidTimeRange = await client.archives.search.$post({
    json: {
      ...query,
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-09",
        until: "2026-11-08",
        timeZone: "Asia/Shanghai",
      },
    },
  });
  assert.equal(invalidTimeRange.status, 400);
  if (invalidTimeRange.status === 400) {
    const error = (await invalidTimeRange.json()).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["timeWindow", "until"]);
  }
  const invalidLocalDate = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-02-30",
        until: "2026-03-01",
        timeZone: "UTC",
      },
    },
  });
  assert.equal(invalidLocalDate.status, 400);

  const undeterminedQuery: ArchiveSearchRequest = {
    bins: ["binny-runs-one", "binny-runs-two"],
    text: { in: "body", groups: [[token]] },
    asOf: snapshotAsOf,
    limit: 6,
    timeWindow: {
      field: "sourcePublishedAt",
      from: "2026-11-08",
      until: "2026-11-09",
      timeZone: "Asia/Shanghai",
      review: "undetermined",
    },
  };
  const undeterminedResponse = await client.archives.search.$post({
    json: undeterminedQuery,
  });
  assert.equal(undeterminedResponse.status, 200);
  if (undeterminedResponse.status !== 200) {
    throw new Error("Undetermined-time review failed.");
  }
  const undetermined = await undeterminedResponse.json();
  assert.equal(undetermined.snapshot.asOf, snapshotAsOf);
  assert.deepEqual(undetermined.timeSummary, {
    certainItems: "4",
    undeterminedItems: "7",
  });
  assert.equal(undetermined.results.length, 6);
  assert.equal(undetermined.hasMore, true);
  assert.equal(undetermined.hasMore, undetermined.nextCursor !== undefined);
  assert.ok(undetermined.nextCursor);
  assert.equal(
    undetermined.results.at(-1)?.sourcePublishedAt,
    null,
    "The first undetermined page ends inside the null-time sort group.",
  );
  const undeterminedNextResponse = await client.archives.search.$post({
    json: {
      ...undeterminedQuery,
      cursor: undetermined.nextCursor,
      limit: 2,
    },
  });
  assert.equal(undeterminedNextResponse.status, 200);
  if (undeterminedNextResponse.status !== 200) {
    throw new Error("Undetermined-time cursor page failed.");
  }
  const undeterminedNextPage = await undeterminedNextResponse.json();
  assert.equal(undeterminedNextPage.snapshot.asOf, snapshotAsOf);
  assert.deepEqual(undeterminedNextPage.timeSummary, undetermined.timeSummary);
  assert.equal(undeterminedNextPage.hasMore, false);
  assert.equal(
    undeterminedNextPage.hasMore,
    undeterminedNextPage.nextCursor !== undefined,
  );
  assert.equal(undeterminedNextPage.nextCursor, undefined);
  assert.equal(undeterminedNextPage.results.length, 1);
  assert.equal(undeterminedNextPage.results[0]?.sourcePublishedAt, null);
  const undeterminedResults = [
    ...undetermined.results,
    ...undeterminedNextPage.results,
  ];
  const undeterminedIds = undeterminedResults.map(({ itemId }) => itemId);
  assert.equal(new Set(undeterminedIds).size, undeterminedIds.length);
  assert.deepEqual(
    undeterminedIds.toSorted(),
    [
      itemId("day-without-zone"),
      itemId("day-utc"),
      itemId("month-overlap"),
      itemId("year-overlap"),
      itemId("missing"),
      itemId("missing-two"),
      multiViewItemId,
    ].toSorted(),
  );
  const unknownById = new Map(
    undeterminedResults.map((result) => [result.itemId, result]),
  );
  const timeReason = (resultId: string): string => {
    const timeMatch = unknownById.get(resultId)?.matches[0]?.timeMatch;
    assert.ok(timeMatch);
    assert.equal(timeMatch.status, "undetermined");
    if (timeMatch.status !== "undetermined") {
      throw new Error("Expected an undetermined time match.");
    }
    return timeMatch.reason;
  };
  assert.equal(timeReason(itemId("missing")), "missingTime");
  assert.equal(timeReason(itemId("missing-two")), "missingTime");
  assert.equal(timeReason(itemId("day-without-zone")), "missingTimeZone");
  assert.equal(
    timeReason(itemId("month-overlap")),
    "precisionOverlapsBoundary",
  );
  assert.equal(
    unknownById.get(multiViewItemId)?.matches[0]?.binId,
    "binny-runs-two",
  );

  const invalidTimeZone = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08",
        until: "2026-11-09",
        timeZone: "No/Such_Zone",
      },
    },
  });
  assert.equal(invalidTimeZone.status, 400);
  if (invalidTimeZone.status === 400) {
    const error = (await invalidTimeZone.json()).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["timeWindow", "timeZone"]);
  }
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
  const sharedBytes = new TextEncoder().encode(
    "binny-deletion shared delete media",
  );
  const exclusiveBytes = new TextEncoder().encode(
    "binny-deletion exclusive delete media",
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: targetKey,
        title: "应删除的正文状态",
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {
          sourceDetails: {
            note: "未登记标记 binny://resource/" + exclusiveResource.resourceId,
          },
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
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    binId: "binny-runs-two",
    items: [
      {
        sourceKey: targetKey,
        title: "第二个 bin 的内容状态",
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    "binny-runs-one",
    "binny-runs-two",
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
      binId: "binny-runs-one",
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
    binId: "binny-runs-one",
    items: [
      {
        sourceKey: targetKey,
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    binId: "binny-runs-two",
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
      binId: "binny-runs-one",
      limit: "10",
    },
  );
  const retainedDeletionGap = relationBeforeMainReobservation.relations.filter(
    ({ relationId }) => relationId === reusedRelationId,
  );
  assert.equal(retainedDeletionGap.length, 1);
  assert.equal(retainedDeletionGap[0]?.status, "deleted");
  assert.equal("from" in retainedDeletionGap[0], false);
  assert.equal("to" in retainedDeletionGap[0], false);

  const secondaryRelation = await readArchiveRelations(client, owner.itemId, {
    direction: "outgoing",
    binId: "binny-runs-two",
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
    binId: "binny-runs-one",
    asOf: firstCommit.archiveSeq,
    limit: "10",
  });
  const oldSnapshotGap = oldMainSnapshot.relations.find(
    ({ relationId }) => relationId === reusedRelationId,
  );
  assert.equal(oldSnapshotGap?.status, "deleted");

  const mainReobservation = await submitArchive(client, {
    requestId: "e2e:archive:hard-delete:main-reobservation:" + runId,
    binId: "binny-runs-one",
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
      binId: "binny-runs-one",
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
      binId: "binny-runs-one",
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
      binId: "binny-runs-one",
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
  const sharedBytes = new TextEncoder().encode(
    "binny-cascade shared cascade media",
  );
  const exclusiveBytes = new TextEncoder().encode(
    "binny-cascade exclusive cascade media",
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
    binId: "binny-runs-one",
    items: keys.map((sourceKey) => {
      const resources =
        sourceKey.key === rootKey.key || sourceKey.key === unrelatedKey.key
          ? [{ resourceId: sharedResource.resourceId }]
          : sourceKey.key === targetKey.key
            ? [{ resourceId: exclusiveResource.resourceId }]
            : [];
      return {
        sourceKey,
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
    binId: "binny-runs-two",
    items: [],
    relations: [{ relationId: relationIds.forward, value: forwardState(true) }],
  });
  await submitArchive(client, {
    requestId: "e2e:archive:cascade:main-update:" + runId,
    binId: "binny-runs-one",
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
    binId: "binny-runs-one",
    items: [],
    relations: [
      { relationId: relationIds.forward, value: null },
      { relationId: relationIds.withdrawn, value: null },
    ],
  });
  const mainCurrentRelations = await readArchiveRelations(client, rootItemId, {
    direction: "outgoing",
    binId: "binny-runs-one",
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
    { direction: "outgoing", binId: "binny-runs-two", limit: "10" },
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
      binId: "binny-runs-one",
      items: [rootKey, targetKey].map((sourceKey) => ({
        sourceKey,
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {},
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
            binId: "binny-runs-one",
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
            binId: "binny-runs-one",
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
    binId: "binny-runs-one",
    items: [cliCascadeRootKey, cliCascadeTargetKey].map((sourceKey) => ({
      sourceKey,
      title: null,
      sourcePublishedAt: null,
      sourceModifiedAt: null,
      extensions: {},
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
    ["binny-runs-one"],
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
  assert.deepEqual(
    resourceMarkerItem.views[0]?.state.extensions.sourceDetails,
    { note: `binny://resource/${archive.orphanResourceId}` },
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

  const orphanResolveResponse = await client.resources.resolve.$post({
    json: {
      binId: "binny-runs-one",
      resourceIds: [archive.orphanResourceId],
    },
  });
  assert.equal(orphanResolveResponse.status, 200);
  const orphanResolveResult = await orphanResolveResponse.json();
  assert.equal(orphanResolveResult.resources.length, 0);

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
  const sdkBytes = new TextEncoder().encode("sourceAdapter sdk image v1");
  assert.deepEqual(
    new Uint8Array(await sdkResourceResponse.arrayBuffer()),
    sdkBytes,
  );
  const sdkResourceDetails = {
    resourceId: sdkResource.resourceId,
    mediaType: sdkResourceResponse.headers.get("content-type"),
    size: Number(sdkResourceResponse.headers.get("content-length")),
    sha256: sdkResourceResponse.headers.get("etag")?.replaceAll('"', ""),
  };

  const historicalResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: archive.itemId },
    query: { binId: "binny-runs-one", asOf: archive.historicalAsOf },
  });
  if (historicalResponse.status !== 200) {
    throw new Error(
      "重启后按归档截点读取失败：" + (await historicalResponse.text()),
    );
  }
  const historicalItem = await historicalResponse.json();
  assert.equal(historicalItem.views[0]?.state.body?.markdown, "正文 B");

  const firstTimelinePage = await readArchiveTimeline(client, archive.itemId, {
    binId: "binny-runs-one",
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
      binId: "binny-runs-one",
      asOf: archive.relationAsOf,
      limit: "10",
    },
  );
  const relationTimelinePage = await readArchiveTimeline(
    client,
    archive.relationItemId,
    {
      binId: "binny-runs-one",
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
    sdkResourceDetails,
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
  if (stage === "fixed-search") {
    await verifyFixedSearch(baseUrl);
    await verifyTimeWindowSearch(baseUrl);
    process.stdout.write("固定归档搜索与分页验收通过。\n");
    return;
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
    const report = await runArchiveCapacityE2E(baseUrl, profile, phase);
    process.stdout.write(JSON.stringify(report));
    return;
  }
  throw new Error("未知归档 HTTP 验收阶段。");
}

await main();
