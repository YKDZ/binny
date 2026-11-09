import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApiClient } from "@binny/api/client";
import {
  archiveCommitSchema,
  archiveErrorSchema,
  archiveItemDeletionResultSchema,
  archiveItemReadSchema,
  archiveResourceMetadataSchema,
  archiveSearchPageSchema,
  type ArchiveResourceMetadata,
  type ArchiveSearchRequest,
  type ArchiveSubmissionInput,
} from "@binny/contracts";

type ArchiveClient = ReturnType<typeof createApiClient>;
export type CapacityProfile = "smoke" | "full";
export type CapacityPhase = "all" | "seed" | "verify" | "delete";

type CapacityShape = {
  readonly itemCount: number;
  readonly cascadeCount: number;
  readonly mediaFileCount: number;
  readonly mediaBytesEach: number;
  readonly sharedBytes: number;
};

type CapacityResource = {
  readonly ordinal: number;
  readonly resourceId: string;
  readonly sha256: string;
  readonly size: number;
};

type CapacityManifest = {
  readonly version: 1;
  readonly profile: CapacityProfile;
  readonly itemCount: number;
  readonly cascadeCount: number;
  readonly mediaBytesEach: number;
  readonly sharedResourceId: string;
  readonly sharedSha256: string;
  readonly sharedBytes: number;
  readonly cascadeRootItemId: string;
  readonly historicalAsOf: string;
  readonly deletedSharedOwnerItemId: string;
  readonly survivingSharedOwnerItemId: string;
  readonly cascadeDeletionMilliseconds?: number;
  readonly resources: readonly CapacityResource[];
  readonly retainedOwnerItemIds: readonly string[];
};

type CapacityReport = {
  readonly profile: CapacityProfile;
  readonly phase: CapacityPhase;
  readonly seededItemCount: number;
  readonly retainedItemCount: number;
  readonly submittedRevisionCount: number;
  readonly retainedRevisionCount: number;
  readonly submittedObservationCount: number;
  readonly retainedObservationCount: number;
  readonly submittedRelationCount: number;
  readonly retainedRelationCount: number;
  readonly seededRelationDensity: number;
  readonly retainedRelationDensity: number;
  readonly cascadeDeletionMilliseconds?: number;
  readonly bodyCodePointLength: number;
  readonly largeMediaFileCount: number;
  readonly sharedResourceUploadAttempts: number;
  readonly uniqueReferencedResourceCount: number;
  readonly mediaBytesEach: number;
  readonly expectedReferencedUniqueMediaBytes: number;
  readonly measurements: readonly {
    readonly name: string;
    readonly elapsedMilliseconds: number;
    readonly status: number;
    readonly resultCount?: number;
    readonly errorCode?: string;
  }[];
  readonly deletedCascadeItems?: number;
  readonly deletedSharedOwnerItems?: number;
  readonly retainedMediaReferencesVerified: number;
};

const binId = "binny-runs-one";
const sourceNamespace = "capacity26";
const bodyCodePointLength = 512;
const sharedPayload = new TextEncoder().encode(
  "Binny capacity 26 shared archive resource. 中文媒体引用。🌿",
);
function shapeFor(profile: CapacityProfile): CapacityShape {
  return profile === "full"
    ? {
        itemCount: 100_000,
        cascadeCount: 10_000,
        mediaFileCount: 1_000,
        mediaBytesEach: 100_000_000,
        sharedBytes: sharedPayload.byteLength,
      }
    : {
        itemCount: 250,
        cascadeCount: 10,
        mediaFileCount: 4,
        mediaBytesEach: 1_048_576,
        sharedBytes: sharedPayload.byteLength,
      };
}

function sourceKeyFor(ordinal: number) {
  return {
    namespace: sourceNamespace,
    key: "item-" + String(ordinal).padStart(6, "0"),
  };
}

function bodyFor(ordinal: number, revision: number): string {
  const marker = ordinal % 10_000 === 0 ? "容量命中" : "容量样本";
  const prefix =
    marker + " " + sourceKeyFor(ordinal).key + " v" + String(revision) + " ";
  const padding = Array.from(
    "保存真实归档正文并按中文短串、范围条件和历史状态进行检索。🌿",
  );
  const codePoints = Array.from(prefix);
  while (codePoints.length < bodyCodePointLength) {
    codePoints.push(padding[codePoints.length % padding.length]!);
  }
  return codePoints.slice(0, bodyCodePointLength).join("");
}

function itemFor(
  ordinal: number,
  revision: number,
  resources?: readonly { readonly resourceId: string }[],
): ArchiveSubmissionInput["items"][number] {
  const body = bodyFor(ordinal, revision);
  return {
    sourceKey: sourceKeyFor(ordinal),
    title: "归档容量样本 " + String(ordinal),
    sourcePublishedAt: null,
    sourceModifiedAt: null,
    extensions: {
      capacityOrdinal: ordinal,
      group: ordinal % 100,
      score: (ordinal * 17) % 10_007,
      revision,
    },
    body: { text: body, searchText: body },
    capture: {
      scope: { benchmark: "archive-capacity", revision },
      completeness: "complete",
      missing: [],
    },
    ...(resources === undefined ? {} : { resources: [...resources] }),
  };
}

async function submitArchive(
  client: ArchiveClient,
  request: ArchiveSubmissionInput,
) {
  const response = await client.archives.$post({ json: request });
  if (response.status !== 201) {
    throw new Error("容量验收归档提交失败：" + (await response.text()));
  }
  return archiveCommitSchema.parse(await response.json());
}

async function ensureCapacityBin(
  client: ArchiveClient,
  phase: CapacityPhase,
): Promise<void> {
  const existing = await client.bins[":binId"].$get({ param: { binId } });
  if (existing.status === 200) return;
  throw new Error(`容量阶段 ${phase} 需要运行器自动登记 bin ${binId}。`);
}

function createMediaPayload(
  ordinal: number,
  size: number,
): {
  readonly body: ReadableStream<Uint8Array>;
  readonly sha256: () => string;
} {
  const key = createHash("sha256")
    .update("binny-v1-archive-capacity-media-" + String(ordinal))
    .digest();
  const cipher = createCipheriv("chacha20", key, Buffer.alloc(16));
  const digest = createHash("sha256");
  let generated = 0;
  let expectedSha256: string | undefined;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (generated === size) {
        controller.close();
        return;
      }
      const nextSize = Math.min(4 * 1024 * 1024, size - generated);
      const bytes = cipher.update(Buffer.alloc(nextSize));
      digest.update(bytes);
      generated += bytes.byteLength;
      controller.enqueue(bytes);
      if (generated === size) {
        const finalBytes = cipher.final();
        if (finalBytes.byteLength > 0) {
          digest.update(finalBytes);
          controller.enqueue(finalBytes);
        }
        expectedSha256 = digest.digest("hex");
      }
    },
  });
  return {
    body,
    sha256() {
      assert.equal(generated, size, "资源正文必须完整上传后才能核对摘要。");
      assert.ok(expectedSha256);
      return expectedSha256;
    },
  };
}

async function uploadMediaStream(
  client: ArchiveClient,
  ordinal: number,
  size: number,
): Promise<ArchiveResourceMetadata> {
  const payload = createMediaPayload(ordinal, size);
  const streamRequestInit = {
    body: payload.body,
    duplex: "half",
  } as RequestInit;
  const response = await client.resources.$post(
    { header: { "content-type": "application/octet-stream" } },
    { init: streamRequestInit },
  );
  if (response.status !== 201) {
    throw new Error("容量验收媒体上传失败：" + (await response.text()));
  }
  const metadata = archiveResourceMetadataSchema.parse(await response.json());
  assert.equal(metadata.size, size);
  assert.equal(metadata.sha256, payload.sha256());
  return metadata;
}

async function uploadSharedPayload(client: ArchiveClient) {
  const upload = async () =>
    await client.resources.$post(
      { header: { "content-type": "application/octet-stream" } },
      { init: { body: new Blob([sharedPayload]) } },
    );
  const firstResponse = await upload();
  assert.equal(firstResponse.status, 201, await firstResponse.clone().text());
  const first = archiveResourceMetadataSchema.parse(await firstResponse.json());
  const repeatedResponse = await upload();
  assert.equal(
    repeatedResponse.status,
    201,
    await repeatedResponse.clone().text(),
  );
  const repeated = archiveResourceMetadataSchema.parse(
    await repeatedResponse.json(),
  );
  assert.equal(repeated.resourceId, first.resourceId);
  assert.equal(repeated.sha256, first.sha256);
  assert.equal(first.size, sharedPayload.byteLength);
  return first;
}

async function seedCapacity(
  client: ArchiveClient,
  profile: CapacityProfile,
  shape: CapacityShape,
): Promise<{
  readonly manifest: CapacityManifest;
  readonly itemIds: ReadonlyMap<number, string>;
  readonly relationCount: number;
}> {
  assert.ok(
    shape.itemCount >= shape.cascadeCount + 10 + 2 * shape.mediaFileCount,
  );
  const mainItemCount = shape.itemCount - shape.cascadeCount;
  const itemIds = new Map<number, string>();
  let historicalAsOf = "";

  for (let offset = 0; offset < shape.itemCount; offset += 100) {
    const end = Math.min(shape.itemCount, offset + 100);
    const items = Array.from({ length: end - offset }, (_, index) =>
      itemFor(offset + index, 1),
    );
    const commit = await submitArchive(client, {
      requestId: "capacity26:" + profile + ":items:v1:" + String(offset),
      binId,
      observedAt: "2025-01-01T12:00:00Z",
      items,
      relations: [],
    });
    assert.equal(commit.items.length, items.length);
    for (let index = 0; index < commit.items.length; index += 1) {
      const item = commit.items[index];
      assert.ok(item);
      itemIds.set(offset + index, item.itemId);
    }
  }

  for (let offset = 0; offset < shape.itemCount; offset += 100) {
    const end = Math.min(shape.itemCount, offset + 100);
    const items = Array.from({ length: end - offset }, (_, index) =>
      itemFor(offset + index, 2),
    );
    const commit = await submitArchive(client, {
      requestId: "capacity26:" + profile + ":items:v2:" + String(offset),
      binId,
      observedAt: "2025-01-08T12:00:00Z",
      items,
      relations: [],
    });
    assert.equal(commit.items.length, items.length);
    historicalAsOf = commit.archiveSeq;
  }

  const shared = await uploadSharedPayload(client);
  const media: CapacityResource[] = [];
  const retainedOwnerItemIds: string[] = [];
  const mediaOwnerFirst = 10;
  const mediaOwnerSecond = mediaOwnerFirst + shape.mediaFileCount;
  for (let ordinal = 0; ordinal < shape.mediaFileCount; ordinal += 1) {
    const uploaded = await uploadMediaStream(
      client,
      ordinal,
      shape.mediaBytesEach,
    );
    media.push({
      ordinal,
      resourceId: uploaded.resourceId,
      sha256: uploaded.sha256,
      size: uploaded.size,
    });
    const resources = [
      { resourceId: uploaded.resourceId },
      ...(ordinal < 2 ? [{ resourceId: shared.resourceId }] : []),
    ];
    for (const ownerOrdinal of [
      mediaOwnerFirst + ordinal,
      mediaOwnerSecond + ordinal,
    ]) {
      const ownerId = itemIds.get(ownerOrdinal);
      assert.ok(ownerId);
      const commit = await submitArchive(client, {
        requestId:
          "capacity26:" +
          profile +
          ":media:" +
          String(ordinal) +
          ":owner:" +
          String(ownerOrdinal),
        binId,
        observedAt: "2025-01-15T12:00:00Z",
        items: [itemFor(ownerOrdinal, 3, resources)],
        relations: [],
      });
      assert.equal(commit.items[0]?.itemId, ownerId);
      if (ownerOrdinal >= mediaOwnerSecond) retainedOwnerItemIds.push(ownerId);
    }
  }

  const allRelations: ArchiveSubmissionInput["relations"] = [];
  let relationCount = 0;
  const submitRelationBatch = async (): Promise<void> => {
    if (allRelations.length === 0) return;
    const batch = allRelations.splice(0, 100);
    const startIndex = relationCount - batch.length;
    const commit = await submitArchive(client, {
      requestId: "capacity26:" + profile + ":relations:" + String(startIndex),
      binId,
      items: [],
      relations: batch,
    });
    assert.equal(commit.relations.length, batch.length);
  };
  const addRelation = (
    fromOrdinal: number,
    toOrdinal: number,
    name: string,
    cascade: boolean,
  ): void => {
    allRelations.push({
      relationId:
        "capacity26:" +
        name +
        ":" +
        String(fromOrdinal) +
        ":" +
        String(toOrdinal),
      value: {
        from: sourceKeyFor(fromOrdinal),
        to: { sourceKey: sourceKeyFor(toOrdinal) },
        name,
        properties: { from: fromOrdinal, to: toOrdinal },
        cascade,
      },
    });
    relationCount += 1;
  };
  for (let fromOrdinal = 0; fromOrdinal < mainItemCount; fromOrdinal += 1) {
    if (fromOrdinal + 1 < mainItemCount) {
      addRelation(fromOrdinal, fromOrdinal + 1, "capacity-next", false);
    }
    if (fromOrdinal + 2 < mainItemCount) {
      addRelation(fromOrdinal, fromOrdinal + 2, "capacity-next", false);
    }
    if (allRelations.length >= 100) await submitRelationBatch();
  }
  for (
    let fromOrdinal = mainItemCount;
    fromOrdinal + 1 < shape.itemCount;
    fromOrdinal += 1
  ) {
    addRelation(fromOrdinal, fromOrdinal + 1, "capacity-cascade", true);
    if (allRelations.length >= 100) await submitRelationBatch();
  }
  while (allRelations.length > 0) await submitRelationBatch();

  const cascadeRootItemId = itemIds.get(mainItemCount);
  assert.ok(cascadeRootItemId);
  const firstMediaOwnerId = itemIds.get(mediaOwnerFirst);
  assert.ok(firstMediaOwnerId);
  const survivingSharedOwnerItemId = itemIds.get(mediaOwnerFirst + 1);
  assert.ok(survivingSharedOwnerItemId);
  const manifest: CapacityManifest = {
    version: 1,
    profile,
    itemCount: shape.itemCount,
    cascadeCount: shape.cascadeCount,
    mediaBytesEach: shape.mediaBytesEach,
    sharedResourceId: shared.resourceId,
    sharedSha256: shared.sha256,
    sharedBytes: shared.size,
    cascadeRootItemId,
    historicalAsOf,
    deletedSharedOwnerItemId: firstMediaOwnerId,
    survivingSharedOwnerItemId,
    resources: media,
    retainedOwnerItemIds,
  };
  const result = { manifest, itemIds, relationCount };
  await writeFile(manifestPath(profile), JSON.stringify(manifest, null, 2));
  return result;
}

function manifestPath(profile: CapacityProfile): string {
  return path.join(tmpdir(), "binny-e2e-capacity-" + profile + ".json");
}

async function loadManifest(
  profile: CapacityProfile,
): Promise<CapacityManifest> {
  const parsed = JSON.parse(
    await readFile(manifestPath(profile), "utf8"),
  ) as CapacityManifest;
  assert.equal(parsed.version, 1);
  assert.equal(parsed.profile, profile);
  assert.equal(parsed.itemCount, shapeFor(profile).itemCount);
  assert.equal(parsed.resources.length, shapeFor(profile).mediaFileCount);
  return parsed;
}

type QueryMeasurement = CapacityReport["measurements"][number];

async function measureSearch(
  client: ArchiveClient,
  name: string,
  input: ArchiveSearchRequest,
): Promise<QueryMeasurement> {
  const startedAt = performance.now();
  const response = await client.archives.search.$post({ json: input });
  if (response.status === 422) {
    const error = archiveErrorSchema.parse(await response.json());
    return {
      name,
      elapsedMilliseconds: performance.now() - startedAt,
      status: response.status,
      errorCode: error.error.code,
    };
  }
  if (response.status !== 200) {
    throw new Error(name + " search failed: " + (await response.text()));
  }
  const page = archiveSearchPageSchema.parse(await response.json());
  return {
    name,
    elapsedMilliseconds: performance.now() - startedAt,
    status: response.status,
    resultCount: page.results.length,
  };
}

function assertSearchOutcome(
  measurement: QueryMeasurement,
  expectedResultCount: number,
): void {
  assert.equal(measurement.status, 200);
  assert.equal(measurement.resultCount, expectedResultCount);
}

function expectedChineseMatches(itemCount: number): number {
  let count = 0;
  for (let ordinal = 0; ordinal < itemCount; ordinal += 10_000) {
    count += 1;
  }
  return count;
}

async function runSearchMatrix(
  client: ArchiveClient,
  shape: CapacityShape,
): Promise<readonly QueryMeasurement[]> {
  const measurements: QueryMeasurement[] = [];
  const chinese = await measureSearch(client, "中文短串", {
    bins: [binId],
    text: { in: "body", groups: [["容量命中"]] },
    limit: 10,
  });
  assertSearchOutcome(chinese, expectedChineseMatches(shape.itemCount));
  measurements.push(chinese);

  const lastItem = await measureSearch(client, "末条目正文查询", {
    bins: [binId],
    text: { in: "body", groups: [[sourceKeyFor(shape.itemCount - 1).key]] },
    limit: 10,
  });
  assertSearchOutcome(lastItem, 1);
  measurements.push(lastItem);

  const enumeration = await measureSearch(client, "零条件枚举", {
    bins: [binId],
    limit: 10,
  });
  assertSearchOutcome(enumeration, 10);
  measurements.push(enumeration);
  return measurements;
}

async function verifyRetainedMediaReferences(
  client: ArchiveClient,
  manifest: CapacityManifest,
): Promise<number> {
  assert.equal(manifest.resources.length, manifest.retainedOwnerItemIds.length);
  const uniqueIds = new Set(
    manifest.resources.map(({ resourceId }) => resourceId),
  );
  const uniqueHashes = new Set(manifest.resources.map(({ sha256 }) => sha256));
  assert.equal(uniqueIds.size, manifest.resources.length);
  assert.equal(uniqueHashes.size, manifest.resources.length);
  assert.ok(
    manifest.resources.every(({ size }) => size === manifest.mediaBytesEach),
  );
  for (let offset = 0; offset < manifest.resources.length; offset += 16) {
    await Promise.all(
      manifest.resources
        .slice(offset, offset + 16)
        .map(async (resource, index) => {
          const itemId = manifest.retainedOwnerItemIds[offset + index];
          assert.ok(itemId);
          const response = await client.archives.items[":itemId"].$get({
            param: { itemId },
            query: { binId },
          });
          assert.equal(response.status, 200, "容量媒体拥有条目应仍可读取。");
          const item = archiveItemReadSchema.parse(await response.json());
          const view = item.views.find(
            (candidate) => candidate.binId === binId,
          );
          assert.ok(view);
          assert.ok(
            view.state.resources?.some(
              ({ resourceId }) => resourceId === resource.resourceId,
            ),
            "内容版本必须仍引用对应的唯一容量媒体。",
          );
        }),
    );
  }
  return manifest.resources.length;
}

async function verifyRetainedResource(
  client: ArchiveClient,
  resourceId: string,
  expectedSize: number,
): Promise<void> {
  const response = await client.resources[":resourceId"].$get({
    param: { resourceId },
  });
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get("content-length")), expectedSize);
  await response.body?.cancel();
}

async function verifyCascadeAndSharedResources(
  client: ArchiveClient,
  manifest: CapacityManifest,
  itemIds: ReadonlyMap<number, string> | undefined,
  shape: CapacityShape,
  deleteItems: boolean,
): Promise<{
  readonly deletedCascadeItems: number;
  readonly deletedSharedOwnerItems: number;
  readonly measurements: readonly QueryMeasurement[];
}> {
  if (!deleteItems) {
    return {
      deletedCascadeItems: 0,
      deletedSharedOwnerItems: 0,
      measurements: [],
    };
  }
  const mainItemCount = shape.itemCount - shape.cascadeCount;
  const cascadeRootId =
    itemIds?.get(mainItemCount) ?? manifest.cascadeRootItemId;
  const sharedOwnerId = itemIds?.get(10) ?? manifest.deletedSharedOwnerItemId;
  const deletionAlreadyCompleted =
    manifest.cascadeDeletionMilliseconds !== undefined;
  let cascadeMeasurement: QueryMeasurement;
  let deletedCascadeItems = 0;
  if (deletionAlreadyCompleted) {
    // manifest 仅在级联和共享媒体删除均验证成功后写入，可据此安全重验删除阶段。
    const cascadeRootRead = await client.archives.items[":itemId"].$get({
      param: { itemId: cascadeRootId },
      query: { binId },
    });
    assert.equal(cascadeRootRead.status, 404);
    deletedCascadeItems = shape.cascadeCount;
    cascadeMeasurement = {
      name: "级联删除 " + String(shape.cascadeCount) + " 个条目完成后复验",
      elapsedMilliseconds: manifest.cascadeDeletionMilliseconds,
      status: 200,
      resultCount: shape.cascadeCount,
    };
  } else {
    const cascadeStartedAt = performance.now();
    const cascadeResponse = await client.archives.items[":itemId"].$delete({
      param: { itemId: cascadeRootId },
    });
    assert.equal(
      cascadeResponse.status,
      200,
      await cascadeResponse.clone().text(),
    );
    const cascadeDeletion = archiveItemDeletionResultSchema.parse(
      await cascadeResponse.json(),
    );
    assert.equal(cascadeDeletion.deletedItemIds.length, shape.cascadeCount);
    deletedCascadeItems = cascadeDeletion.deletedItemIds.length;
    cascadeMeasurement = {
      name: "级联删除 " + String(shape.cascadeCount) + " 个条目",
      elapsedMilliseconds: performance.now() - cascadeStartedAt,
      status: cascadeResponse.status,
      resultCount: cascadeDeletion.deletedItemIds.length,
    };
  }
  const leafSearch = await measureSearch(client, "级联删除后查询", {
    bins: [binId],
    text: { in: "body", groups: [[sourceKeyFor(shape.itemCount - 1).key]] },
    limit: 10,
  });
  assert.equal(leafSearch.status, 200);
  assert.equal(leafSearch.resultCount, 0);
  let ownerMeasurement: QueryMeasurement | undefined;
  if (!deletionAlreadyCompleted) {
    const ownerStartedAt = performance.now();
    const ownerDeletion = await client.archives.items[":itemId"].$delete({
      param: { itemId: sharedOwnerId },
    });
    assert.equal(ownerDeletion.status, 200, await ownerDeletion.clone().text());
    const ownerDeletionResult = archiveItemDeletionResultSchema.parse(
      await ownerDeletion.json(),
    );
    assert.equal(ownerDeletionResult.deletedItemIds.length, 1);
    ownerMeasurement = {
      name: "删除共享媒体的一个拥有条目",
      elapsedMilliseconds: performance.now() - ownerStartedAt,
      status: ownerDeletion.status,
      resultCount: ownerDeletionResult.deletedItemIds.length,
    };
  }
  const deletedItemRead = await client.archives.items[":itemId"].$get({
    param: { itemId: sharedOwnerId },
    query: { binId },
  });
  assert.equal(deletedItemRead.status, 404);
  const survivingItemRead = await client.archives.items[":itemId"].$get({
    param: { itemId: manifest.survivingSharedOwnerItemId },
    query: { binId },
  });
  assert.equal(survivingItemRead.status, 200);
  const survivingItem = archiveItemReadSchema.parse(
    await survivingItemRead.json(),
  );
  const survivingView = survivingItem.views.find(
    (candidate) => candidate.binId === binId,
  );
  assert.ok(survivingView);
  assert.ok(
    survivingView.state.resources?.some(
      ({ resourceId }) => resourceId === manifest.sharedResourceId,
    ),
  );
  const firstLargeResource = manifest.resources[0];
  assert.ok(firstLargeResource);
  await verifyRetainedResource(
    client,
    firstLargeResource.resourceId,
    firstLargeResource.size,
  );
  await verifyRetainedResource(
    client,
    manifest.sharedResourceId,
    manifest.sharedBytes,
  );
  return {
    deletedCascadeItems,
    deletedSharedOwnerItems: 1,
    measurements: [
      ...(deletionAlreadyCompleted ? [] : [cascadeMeasurement]),
      leafSearch,
      ...(ownerMeasurement === undefined ? [] : [ownerMeasurement]),
    ],
  };
}

export async function runArchiveCapacityE2E(
  baseUrl: string,
  profile: CapacityProfile,
  phase: CapacityPhase,
): Promise<CapacityReport> {
  const shape = shapeFor(profile);
  const client = createApiClient(baseUrl);
  await ensureCapacityBin(client, phase);
  const measurements: QueryMeasurement[] = [];
  let manifest: CapacityManifest;
  let itemIds: ReadonlyMap<number, string> | undefined;
  let submittedRelationCount: number;
  let deletionResult: {
    readonly deletedCascadeItems: number;
    readonly deletedSharedOwnerItems: number;
    readonly measurements: readonly QueryMeasurement[];
  } = {
    deletedCascadeItems: 0,
    deletedSharedOwnerItems: 0,
    measurements: [],
  };

  if (phase === "verify" || phase === "delete") {
    manifest = await loadManifest(profile);
    submittedRelationCount = shape.itemCount * 2 - shape.cascadeCount - 4;
  } else {
    const seeded = await seedCapacity(client, profile, shape);
    manifest = seeded.manifest;
    itemIds = seeded.itemIds;
    submittedRelationCount = seeded.relationCount;
  }

  if (phase === "all" || phase === "verify") {
    measurements.push(...(await runSearchMatrix(client, shape)));
  }
  if (phase === "all" || phase === "delete") {
    deletionResult = await verifyCascadeAndSharedResources(
      client,
      manifest,
      itemIds,
      shape,
      true,
    );
    measurements.push(...deletionResult.measurements);
  }
  const cascadeDeletionMilliseconds = deletionResult.measurements.find(
    ({ name }) => name.startsWith("级联删除 "),
  )?.elapsedMilliseconds;
  if (cascadeDeletionMilliseconds !== undefined) {
    manifest = { ...manifest, cascadeDeletionMilliseconds };
    await writeFile(manifestPath(profile), JSON.stringify(manifest, null, 2));
  }
  const retainedMediaReferencesVerified = await verifyRetainedMediaReferences(
    client,
    manifest,
  );
  const largeResourceBytes = manifest.resources.reduce(
    (total, resource) => total + resource.size,
    0,
  );
  const deletedItemCount =
    deletionResult.deletedCascadeItems + deletionResult.deletedSharedOwnerItems;
  const retainedItemCount = shape.itemCount - deletedItemCount;
  const submittedRevisionCount = shape.itemCount * 2 + shape.mediaFileCount * 2;
  const retainedRevisionCount =
    submittedRevisionCount -
    deletionResult.deletedCascadeItems * 2 -
    deletionResult.deletedSharedOwnerItems * 3;
  const retainedRelationCount =
    submittedRelationCount -
    (deletionResult.deletedCascadeItems === 0 ? 0 : shape.cascadeCount - 1) -
    deletionResult.deletedSharedOwnerItems * 4;
  return {
    profile,
    phase,
    seededItemCount: shape.itemCount,
    retainedItemCount,
    submittedRevisionCount,
    retainedRevisionCount,
    submittedObservationCount: submittedRevisionCount,
    retainedObservationCount: retainedRevisionCount,
    submittedRelationCount,
    retainedRelationCount,
    seededRelationDensity: submittedRelationCount / shape.itemCount,
    retainedRelationDensity: retainedRelationCount / retainedItemCount,
    ...(manifest.cascadeDeletionMilliseconds === undefined
      ? {}
      : { cascadeDeletionMilliseconds: manifest.cascadeDeletionMilliseconds }),
    bodyCodePointLength,
    largeMediaFileCount: manifest.resources.length,
    sharedResourceUploadAttempts: 2,
    uniqueReferencedResourceCount: manifest.resources.length + 1,
    mediaBytesEach: shape.mediaBytesEach,
    expectedReferencedUniqueMediaBytes:
      largeResourceBytes + manifest.sharedBytes,
    measurements,
    ...(deletionResult.deletedCascadeItems === 0
      ? {}
      : { deletedCascadeItems: deletionResult.deletedCascadeItems }),
    ...(deletionResult.deletedSharedOwnerItems === 0
      ? {}
      : { deletedSharedOwnerItems: deletionResult.deletedSharedOwnerItems }),
    retainedMediaReferencesVerified,
  };
}
