import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApiClient } from "@binny/api/client";
import {
  archiveBatchReadResponseSchema,
  archiveCommitSchema,
  archiveItemDeletionResultSchema,
  archiveItemReadSchema,
  archiveResourceMetadataSchema,
  archiveSearchPageSchema,
  type ArchiveBatchReadReference,
  type ArchiveSearchDistributionPage,
  type ArchiveSearchPage,
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
  readonly multiBinItemCount: number;
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
  readonly version: 2;
  readonly profile: CapacityProfile;
  readonly itemCount: number;
  readonly cascadeCount: number;
  readonly multiBinItemCount: number;
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
  readonly multiBinItemCount: number;
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
    readonly requestShape: string;
    readonly elapsedMilliseconds: number;
    readonly status: 200;
    readonly resultCount?: number;
    readonly pageCount?: number;
    readonly responseBytes?: number;
    readonly groupCount?: number;
    readonly snapshotAsOf?: string;
    readonly referenceCount?: number;
    readonly bodyCodePointLength?: number;
  }[];
  readonly deletedCascadeItems?: number;
  readonly deletedSharedOwnerItems?: number;
  readonly retainedMediaReferencesVerified: number;
};

const binId = "binny-runs-one";
const secondBinId = "binny-runs-two";
const sourceAdapterId = "binny-runs.manual-run-fixture";
const sourceBins = [binId, secondBinId] as const;
const sourceNamespace = "capacity26";
const capacityLabel = "capacity26";
const sectionGroupCount = 100;
const multiBinOrdinals = [0, 1, 2] as const;
const bodyCodePointLength = 512;
const sharedPayload = new TextEncoder().encode(
  "Binny capacity 26 shared archive resource. 中文媒体引用。🌿",
);
function shapeFor(profile: CapacityProfile): CapacityShape {
  return profile === "full"
    ? {
        itemCount: 100_000,
        cascadeCount: 10_000,
        multiBinItemCount: multiBinOrdinals.length,
        mediaFileCount: 1_000,
        mediaBytesEach: 100_000_000,
        sharedBytes: sharedPayload.byteLength,
      }
    : {
        itemCount: 250,
        cascadeCount: 10,
        multiBinItemCount: multiBinOrdinals.length,
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

function sourcePublishedAtFor(ordinal: number) {
  return {
    precision: "instant" as const,
    value: new Date(Date.UTC(2026, 0, 1) + ordinal * 60_000).toISOString(),
    timeZone: "UTC",
  };
}

function sourceModifiedAtFor(ordinal: number) {
  return {
    precision: "instant" as const,
    value: new Date(
      Date.UTC(2026, 0, 1) + ordinal * 60_000 + 60 * 60_000,
    ).toISOString(),
    timeZone: "UTC",
  };
}

function sectionFor(ordinal: number): string {
  return "capacity-" + String(ordinal % sectionGroupCount).padStart(2, "0");
}

function sectionItemCountFor(itemCount: number, sectionIndex: number): number {
  if (sectionIndex >= itemCount) return 0;
  return Math.floor((itemCount - 1 - sectionIndex) / sectionGroupCount) + 1;
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
    sourcePublishedAt: sourcePublishedAtFor(ordinal),
    sourceModifiedAt: sourceModifiedAtFor(ordinal),
    extensions: {
      category: ordinal % 2 === 0 ? "post" : "comment",
      section: sectionFor(ordinal),
      floor: ordinal,
      labels: [capacityLabel, ordinal % 2 === 0 ? "even" : "odd"],
      featured: ordinal % 10_000 === 0,
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
  targetBinId: string,
): Promise<void> {
  const existing = await client.bins[":binId"].$get({
    param: { binId: targetBinId },
  });
  if (existing.status === 200) return;
  throw new Error(`容量阶段 ${phase} 需要运行器自动登记 bin ${targetBinId}。`);
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
  const revisionIds = new Map<number, string>();
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
    for (let index = 0; index < commit.items.length; index += 1) {
      const item = commit.items[index];
      assert.ok(item);
      revisionIds.set(offset + index, item.revisionId);
    }
    historicalAsOf = commit.archiveSeq;
  }

  const multiBinItems = multiBinOrdinals.map((ordinal) => itemFor(ordinal, 2));
  const multiBinCommit = await submitArchive(client, {
    requestId: "capacity26:" + profile + ":multi-bin:v2",
    binId: secondBinId,
    observedAt: "2025-01-22T12:00:00Z",
    items: multiBinItems,
    relations: [],
  });
  assert.equal(multiBinCommit.items.length, multiBinItems.length);
  for (let index = 0; index < multiBinItems.length; index += 1) {
    const ordinal = multiBinOrdinals[index];
    const item = multiBinCommit.items[index];
    assert.ok(ordinal !== undefined && item !== undefined);
    assert.equal(item.itemId, itemIds.get(ordinal));
    assert.equal(item.revisionId, revisionIds.get(ordinal));
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
    version: 2,
    profile,
    itemCount: shape.itemCount,
    cascadeCount: shape.cascadeCount,
    multiBinItemCount: shape.multiBinItemCount,
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
  assert.equal(parsed.version, 2);
  assert.equal(parsed.profile, profile);
  assert.equal(parsed.itemCount, shapeFor(profile).itemCount);
  assert.equal(parsed.multiBinItemCount, shapeFor(profile).multiBinItemCount);
  assert.equal(parsed.resources.length, shapeFor(profile).mediaFileCount);
  return parsed;
}

type QueryMeasurement = CapacityReport["measurements"][number];

type SearchPageRead = {
  readonly page: ArchiveSearchPage;
  readonly responseBytes: number;
};

async function readSearchPage(
  client: ArchiveClient,
  input: ArchiveSearchRequest,
  name: string,
): Promise<SearchPageRead> {
  const response = await client.archives.search.$post({ json: input });
  const responseText = await response.text();
  if (response.status !== 200) {
    throw new Error(
      name +
        " search failed with " +
        String(response.status) +
        ": " +
        responseText,
    );
  }
  const page = archiveSearchPageSchema.parse(
    JSON.parse(responseText) as unknown,
  );
  return {
    page,
    responseBytes: Buffer.byteLength(responseText),
  };
}

async function measureSearch(
  client: ArchiveClient,
  name: string,
  requestShape: string,
  input: ArchiveSearchRequest,
): Promise<{
  readonly measurement: QueryMeasurement;
  readonly page: ArchiveSearchPage;
}> {
  const startedAt = performance.now();
  const read = await readSearchPage(client, input, name);
  return {
    page: read.page,
    measurement: {
      name,
      requestShape,
      elapsedMilliseconds: performance.now() - startedAt,
      status: 200,
      resultCount: read.page.results.length,
      pageCount: 1,
      responseBytes: read.responseBytes,
      snapshotAsOf: read.page.snapshot.asOf,
    },
  };
}

function assertCapacityResults(
  page: ArchiveSearchPage,
  expectedCount: number,
): void {
  assert.equal(page.candidatesIncluded, true);
  assert.equal(page.results.length, expectedCount);
}

function assertDescendingSourceTimes(
  results: ArchiveSearchPage["results"],
): void {
  for (let index = 1; index < results.length; index += 1) {
    const previous = results[index - 1]?.sourcePublishedAt?.value;
    const current = results[index]?.sourcePublishedAt?.value;
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(
      previous >= current,
      "Search results must be ordered newest first.",
    );
  }
}

async function runSearchMatrix(
  client: ArchiveClient,
  shape: CapacityShape,
): Promise<readonly QueryMeasurement[]> {
  const measurements: QueryMeasurement[] = [];
  const capacityExtensions: NonNullable<ArchiveSearchRequest["extensions"]> = {
    sourceAdapterId,
    filters: { labels: { op: "has", value: capacityLabel } },
  };
  const broadWindow = {
    field: "sourcePublishedAt",
    from: "2026-01-01",
    until: "2026-03-12",
    timeZone: "UTC",
  } as const;

  const candidatePagingStartedAt = performance.now();
  const candidateFirstRead = await readSearchPage(
    client,
    {
      bins: [binId],
      extensions: capacityExtensions,
      timeWindow: broadWindow,
      limit: 10,
    },
    "single-bin source-time search",
  );
  const candidateFirst = candidateFirstRead.page;
  assertCapacityResults(candidateFirst, 10);
  assert.equal(candidateFirst.hasMore, true);
  assert.ok(candidateFirst.nextCursor);
  assert.equal(
    candidateFirst.timeSummary?.certainItems,
    String(shape.itemCount),
  );
  assert.equal(candidateFirst.timeSummary?.undeterminedItems, "0");
  assertDescendingSourceTimes(candidateFirst.results);
  assert.ok(
    candidateFirst.results.every((result) => result.matches.length === 1),
  );

  const candidateNextRead = await readSearchPage(
    client,
    {
      bins: [binId],
      extensions: capacityExtensions,
      timeWindow: broadWindow,
      asOf: candidateFirst.snapshot.asOf,
      cursor: candidateFirst.nextCursor,
      limit: 25,
    },
    "single-bin source-time continuation",
  );
  const candidateNext = candidateNextRead.page;
  assertCapacityResults(candidateNext, 25);
  assert.equal(candidateNext.hasMore, true);
  assert.ok(candidateNext.nextCursor);
  assert.equal(candidateNext.snapshot.asOf, candidateFirst.snapshot.asOf);
  assert.deepEqual(candidateNext.timeSummary, candidateFirst.timeSummary);
  const firstPageIds = new Set(
    candidateFirst.results.map(({ itemId }) => itemId),
  );
  assert.ok(
    candidateNext.results.every(({ itemId }) => !firstPageIds.has(itemId)),
    "Candidate continuation must not repeat items from the prior page.",
  );
  assertDescendingSourceTimes(candidateNext.results);
  const lastFirstPageTime =
    candidateFirst.results.at(-1)?.sourcePublishedAt?.value;
  const firstContinuationTime =
    candidateNext.results[0]?.sourcePublishedAt?.value;
  assert.ok(
    lastFirstPageTime !== undefined && firstContinuationTime !== undefined,
  );
  assert.ok(lastFirstPageTime >= firstContinuationTime);
  measurements.push({
    name: "single-bin source-time paging",
    requestShape:
      "one bin, sourcePublishedAt 2026-01-01..2026-03-12 UTC, page sizes 10 then 25",
    elapsedMilliseconds: performance.now() - candidatePagingStartedAt,
    status: 200,
    resultCount: candidateFirst.results.length + candidateNext.results.length,
    pageCount: 2,
    responseBytes:
      candidateFirstRead.responseBytes + candidateNextRead.responseBytes,
    snapshotAsOf: candidateFirst.snapshot.asOf,
  });

  const multiSourceStartedAt = performance.now();
  const multiSourceRead = await readSearchPage(
    client,
    {
      bins: [...sourceBins],
      extensions: capacityExtensions,
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-01-01",
        until: "2026-01-02",
        timeZone: "UTC",
      },
      asOf: candidateFirst.snapshot.asOf,
      limit: 10,
    },
    "multi-bin source-time window",
  );
  const multiSource = multiSourceRead.page;
  assertCapacityResults(multiSource, 10);
  const expectedFirstUtcDayItems = Math.min(
    shape.itemCount,
    (Date.UTC(2026, 0, 2) - Date.UTC(2026, 0, 1)) / 60_000,
  );
  assert.equal(
    multiSource.timeSummary?.certainItems,
    String(expectedFirstUtcDayItems),
  );
  assert.equal(multiSource.timeSummary?.undeterminedItems, "0");
  assert.equal(multiSource.hasMore, true);
  assert.ok(multiSource.nextCursor);
  assert.equal(multiSource.snapshot.asOf, candidateFirst.snapshot.asOf);
  assertDescendingSourceTimes(multiSource.results);
  measurements.push({
    name: "multi-bin one-day source-time window",
    requestShape:
      "two same-adapter bins, sourcePublishedAt 2026-01-01 UTC, first 10 of " +
      String(expectedFirstUtcDayItems) +
      " items",
    elapsedMilliseconds: performance.now() - multiSourceStartedAt,
    status: 200,
    resultCount: multiSource.results.length,
    pageCount: 1,
    responseBytes: multiSourceRead.responseBytes,
    snapshotAsOf: multiSource.snapshot.asOf,
  });

  const extensionStartedAt = performance.now();
  const expectedSectionItemCount = sectionItemCountFor(shape.itemCount, 7);
  const extensionFilterRead = await readSearchPage(
    client,
    {
      bins: [...sourceBins],
      extensions: {
        sourceAdapterId,
        filters: {
          labels: { op: "has", value: capacityLabel },
          section: { op: "eq", value: sectionFor(7) },
        },
      },
      asOf: candidateFirst.snapshot.asOf,
      limit: 10,
      distribution: {
        by: "extension",
        sourceAdapterId,
        field: "section",
        limit: 10,
      },
    },
    "same-adapter extension filter",
  );
  const extensionPage = extensionFilterRead.page;
  assertCapacityResults(extensionPage, Math.min(expectedSectionItemCount, 10));
  assert.equal(extensionPage.hasMore, expectedSectionItemCount > 10);
  if (extensionPage.distribution?.by !== "extension") {
    throw new Error("Expected an extension-filter distribution page.");
  }
  assert.equal(
    extensionPage.distribution.totalItems,
    String(expectedSectionItemCount),
  );
  assert.deepEqual(extensionPage.distribution.groups, [
    {
      kind: "extension",
      value: sectionFor(7),
      itemCount: String(expectedSectionItemCount),
    },
  ]);
  assert.equal(extensionPage.distribution.hasMore, false);
  assert.equal(extensionPage.snapshot.asOf, candidateFirst.snapshot.asOf);
  measurements.push({
    name: "same-adapter section filter",
    requestShape:
      "two same-adapter bins, labels has capacity26 and section equals capacity-07",
    elapsedMilliseconds: performance.now() - extensionStartedAt,
    status: 200,
    resultCount: extensionPage.results.length,
    pageCount: 1,
    responseBytes: extensionFilterRead.responseBytes,
    snapshotAsOf: extensionPage.snapshot.asOf,
  });

  const keywordStartedAt = performance.now();
  const keywordRead = await readSearchPage(
    client,
    {
      bins: [binId],
      extensions: capacityExtensions,
      text: {
        in: "both",
        groups: [["归档容量样本"], ["保存真实归档正文"]],
      },
      timeWindow: broadWindow,
      asOf: candidateFirst.snapshot.asOf,
      limit: 10,
    },
    "title and body keyword groups",
  );
  const keywordPage = keywordRead.page;
  assertCapacityResults(keywordPage, 10);
  assert.equal(keywordPage.timeSummary?.certainItems, String(shape.itemCount));
  assert.equal(keywordPage.timeSummary?.undeterminedItems, "0");
  assert.equal(keywordPage.hasMore, true);
  assert.ok(
    keywordPage.results.every((result) =>
      result.title?.startsWith("归档容量样本 "),
    ),
  );
  measurements.push({
    name: "title and body keyword groups",
    requestShape:
      "one bin, literal title and body groups, first 10 of " +
      String(shape.itemCount) +
      " items",
    elapsedMilliseconds: performance.now() - keywordStartedAt,
    status: 200,
    resultCount: keywordPage.results.length,
    pageCount: 1,
    responseBytes: keywordRead.responseBytes,
    snapshotAsOf: keywordPage.snapshot.asOf,
  });

  const distributionStartedAt = performance.now();
  const distributionInput: ArchiveSearchRequest = {
    bins: [...sourceBins],
    extensions: capacityExtensions,
    asOf: candidateFirst.snapshot.asOf,
    includeCandidates: false,
    limit: 1,
    distribution: {
      by: "extension",
      sourceAdapterId,
      field: "section",
      limit: 37,
    },
  };
  type ExtensionGroup = Extract<
    Extract<
      ArchiveSearchDistributionPage,
      { readonly by: "extension" }
    >["groups"][number],
    { readonly kind: "extension" }
  >;
  const distributionReads: SearchPageRead[] = [];
  const distributionGroups: ExtensionGroup[] = [];
  let nextDistributionInput = distributionInput;
  let distributionLimit = 37;
  while (true) {
    const read = await readSearchPage(
      client,
      nextDistributionInput,
      "complete section distribution",
    );
    distributionReads.push(read);
    assert.equal(read.page.candidatesIncluded, false);
    assert.deepEqual(read.page.results, []);
    assert.equal(read.page.hasMore, false);
    assert.equal(read.page.nextCursor, undefined);
    assert.equal(read.page.snapshot.asOf, candidateFirst.snapshot.asOf);
    if (read.page.distribution?.by !== "extension") {
      throw new Error("Expected a complete extension distribution page.");
    }
    assert.equal(read.page.distribution.totalItems, String(shape.itemCount));
    for (const group of read.page.distribution.groups) {
      if (group.kind !== "extension") {
        throw new Error(
          "Capacity section distribution cannot contain missing values.",
        );
      }
      distributionGroups.push(group);
    }
    if (!read.page.distribution.hasMore) {
      assert.equal(read.page.distribution.nextCursor, undefined);
      break;
    }
    const cursor = read.page.distribution.nextCursor;
    assert.ok(cursor);
    distributionLimit = distributionLimit === 37 ? 31 : 37;
    nextDistributionInput = {
      ...distributionInput,
      distribution: {
        by: "extension",
        sourceAdapterId,
        field: "section",
        limit: distributionLimit,
        cursor,
      },
    };
  }
  assert.equal(distributionReads.length, 3);
  const expectedSectionGroupCount = Math.min(
    shape.itemCount,
    sectionGroupCount,
  );
  assert.equal(distributionGroups.length, expectedSectionGroupCount);
  assert.deepEqual(
    distributionGroups.map(({ value }) => value),
    Array.from({ length: expectedSectionGroupCount }, (_, index) =>
      sectionFor(index),
    ),
  );
  assert.ok(
    distributionGroups.every(
      (group, index) =>
        group.itemCount === String(sectionItemCountFor(shape.itemCount, index)),
    ),
  );
  assert.equal(
    distributionGroups.reduce(
      (total, group) => total + Number(group.itemCount),
      0,
    ),
    shape.itemCount,
  );
  measurements.push({
    name: "complete section distribution",
    requestShape:
      "two same-adapter bins, distribution-only section groups for every capacity item, page sizes 37 then 31 then remainder",
    elapsedMilliseconds: performance.now() - distributionStartedAt,
    status: 200,
    resultCount: 0,
    pageCount: distributionReads.length,
    responseBytes: distributionReads.reduce(
      (total, { responseBytes }) => total + responseBytes,
      0,
    ),
    groupCount: distributionGroups.length,
    snapshotAsOf: candidateFirst.snapshot.asOf,
  });

  const batchStartedAt = performance.now();
  const exactItemSearch = await readSearchPage(
    client,
    {
      bins: [...sourceBins],
      extensions: capacityExtensions,
      text: { in: "body", groups: [[sourceKeyFor(0).key]] },
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-01-01",
        until: "2026-01-02",
        timeZone: "UTC",
      },
      asOf: candidateFirst.snapshot.asOf,
      limit: 10,
    },
    "exact item references for batch read",
  );
  assert.equal(exactItemSearch.page.timeSummary?.certainItems, "1");
  assert.equal(exactItemSearch.page.timeSummary?.undeterminedItems, "0");
  assertCapacityResults(exactItemSearch.page, 1);
  assert.equal(exactItemSearch.page.hasMore, false);
  const exactCandidate = exactItemSearch.page.results[0];
  assert.ok(exactCandidate);
  assert.deepEqual(exactCandidate.sourceKey, sourceKeyFor(0));
  assert.deepEqual(
    exactCandidate.matches.map(({ binId: matchedBin }) => matchedBin).sort(),
    [...sourceBins].sort(),
  );
  const references: ArchiveBatchReadReference[] = exactCandidate.matches.map(
    ({ binId: matchedBin, revisionId, archiveSeq }) => ({
      itemId: exactCandidate.itemId,
      binId: matchedBin,
      revisionId,
      archiveSeq,
    }),
  );
  const batchResponse = await client.archives["batch-read"].$post({
    json: { references },
  });
  const batchResponseText = await batchResponse.text();
  if (batchResponse.status !== 200) {
    throw new Error(
      "Exact batch body read failed with " +
        String(batchResponse.status) +
        ": " +
        batchResponseText,
    );
  }
  const batchRead = archiveBatchReadResponseSchema.parse(
    JSON.parse(batchResponseText) as unknown,
  );
  assert.equal(batchRead.results.length, 2);
  const batchBodies = batchRead.results.map((result) => {
    if (result.status !== "readable") {
      throw new Error("Every capacity batch reference must be readable.");
    }
    const bodyText = result.revision.state.body?.text;
    assert.equal(bodyText, bodyFor(0, 2));
    return bodyText;
  });
  assert.equal(batchBodies.length, references.length);
  assert.equal(Array.from(batchBodies[0] ?? "").length, bodyCodePointLength);
  measurements.push({
    name: "exact-reference batch body read",
    requestShape:
      "one item, exact bin/revision/archiveSeq references from both bins, complete 512-code-point body",
    elapsedMilliseconds: performance.now() - batchStartedAt,
    status: 200,
    resultCount: batchRead.results.length,
    pageCount: 1,
    responseBytes:
      exactItemSearch.responseBytes + Buffer.byteLength(batchResponseText),
    snapshotAsOf: exactItemSearch.page.snapshot.asOf,
    referenceCount: references.length,
    bodyCodePointLength,
  });

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
      requestShape: "Verify that the persisted cascade root is absent",
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
      requestShape: "Delete the root of the configured cascade chain",
      elapsedMilliseconds: performance.now() - cascadeStartedAt,
      status: 200,
      resultCount: cascadeDeletion.deletedItemIds.length,
    };
  }
  const leafSearch = await measureSearch(
    client,
    "级联删除后查询",
    "one-bin body literal for a deleted leaf item",
    {
      bins: [binId],
      text: { in: "body", groups: [[sourceKeyFor(shape.itemCount - 1).key]] },
      limit: 10,
    },
  );
  assert.equal(leafSearch.page.results.length, 0);
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
      requestShape: "Delete one of two owners of the shared media resource",
      elapsedMilliseconds: performance.now() - ownerStartedAt,
      status: 200,
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
      leafSearch.measurement,
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
  await ensureCapacityBin(client, phase, binId);
  await ensureCapacityBin(client, phase, secondBinId);
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
  const submittedObservationCount =
    submittedRevisionCount + shape.multiBinItemCount;
  const retainedObservationCount =
    submittedObservationCount -
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
    multiBinItemCount: shape.multiBinItemCount,
    retainedItemCount,
    submittedRevisionCount,
    retainedRevisionCount,
    submittedObservationCount,
    retainedObservationCount,
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
