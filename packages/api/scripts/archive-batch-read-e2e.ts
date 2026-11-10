import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApiClient } from "@binny/api/client";
import {
  archiveBatchReadMaxResponseBytes,
  archiveBatchReadMaxReferences,
  archiveBatchReadResponseSchema,
  type ArchiveBatchReadReference,
} from "@binny/contracts";

async function readBatch(
  client: ReturnType<typeof createApiClient>,
  references: readonly ArchiveBatchReadReference[],
) {
  const response = await client.archives["batch-read"].$post({
    json: { references: [...references] },
  });
  const responseStatus: number = response.status;
  const responseBody = await response.text();
  if (responseStatus !== 200) {
    throw new Error(
      `Batch archive read failed with ${String(responseStatus)}: ${responseBody}`,
    );
  }
  return archiveBatchReadResponseSchema.parse(
    JSON.parse(responseBody) as unknown,
  );
}

async function verifyArchiveBatchRead(baseUrl: string): Promise<{
  readonly reference: ArchiveBatchReadReference;
  readonly oversizedReference: ArchiveBatchReadReference;
  readonly bodyLength: number;
  readonly bodySuffix: string;
  readonly resourceId: string;
}> {
  const client = createApiClient(baseUrl);
  const runId = randomUUID();
  const token = "batch-read-" + runId;
  const bodyPrefix = "Exact selected content " + token + "\n";
  const bodySuffix = "Batch read full body suffix " + token;
  const bodyText = bodyPrefix + "x".repeat(1024 * 1024) + "\n" + bodySuffix;
  const sourceKey = { namespace: "e2e", key: token };
  const resourceUpload = await fetch(baseUrl + "/resources", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new TextEncoder().encode("Batch read media resource " + token),
  });
  assert.equal(resourceUpload.status, 201);
  if (resourceUpload.status !== 201) {
    throw new Error("Batch-read media upload failed.");
  }
  const uploadedResource = (await resourceUpload.json()) as {
    readonly resourceId: string;
  };
  const uppercaseResourceId = uploadedResource.resourceId.toUpperCase();
  assert.notEqual(uppercaseResourceId, uploadedResource.resourceId);
  const submitted = await client.archives.$post({
    json: {
      requestId: "e2e:archive-batch-read:" + runId,
      binId: "binny-runs-one",
      items: [
        {
          sourceKey,
          title: "Exact batch read fixture",
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
          body: { text: bodyText },
          resources: [{ resourceId: uppercaseResourceId }],
          capture: {
            scope: { case: "archive-batch-read" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  assert.equal(submitted.status, 201);

  const searched = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "body", groups: [[token]] },
      limit: 10,
    },
  });
  assert.equal(searched.status, 200);
  if (searched.status !== 200) throw new Error("Archive search failed.");
  const candidate = (await searched.json()).results.find(
    ({ sourceKey }) => sourceKey.key === token,
  );
  assert.ok(candidate !== undefined);
  const match = candidate.matches.find(
    ({ binId }) => binId === "binny-runs-one",
  );
  assert.ok(match !== undefined);

  const firstBinReference: ArchiveBatchReadReference = {
    itemId: candidate.itemId,
    binId: match.binId,
    revisionId: match.revisionId,
    archiveSeq: match.archiveSeq,
  };
  const updatedBodyText = "Selected content changed after search " + token;
  const updated = await client.archives.$post({
    json: {
      requestId: "e2e:archive-batch-read:update:" + runId,
      binId: "binny-runs-one",
      items: [
        {
          sourceKey,
          title: "Updated batch read fixture",
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
          body: { text: updatedBodyText },
          capture: {
            scope: { case: "archive-batch-read-update" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  assert.equal(updated.status, 201);
  if (updated.status !== 201) throw new Error("Archive update failed.");
  const updatedCommit = await updated.json();
  assert.notEqual(
    updatedCommit.items[0]?.revisionId,
    firstBinReference.revisionId,
  );

  const secondBinBodyText = "Different bin content " + token;
  const secondBinSubmission = await client.archives.$post({
    json: {
      requestId: "e2e:archive-batch-read:second-bin:" + runId,
      binId: "binny-runs-two",
      items: [
        {
          sourceKey,
          title: "Second bin batch read fixture",
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
          body: { text: secondBinBodyText },
          capture: {
            scope: { case: "archive-batch-read-second-bin" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  assert.equal(secondBinSubmission.status, 201);
  if (secondBinSubmission.status !== 201) {
    throw new Error("Second-bin archive submission failed.");
  }
  const secondBinCommit = await secondBinSubmission.json();
  const secondBinItem = secondBinCommit.items[0];
  assert.ok(secondBinItem !== undefined);
  assert.equal(secondBinItem.itemId, firstBinReference.itemId);
  assert.notEqual(secondBinItem.revisionId, firstBinReference.revisionId);
  const secondBinReference: ArchiveBatchReadReference = {
    itemId: secondBinItem.itemId,
    binId: "binny-runs-two",
    revisionId: secondBinItem.revisionId,
    archiveSeq: secondBinCommit.archiveSeq,
  };

  const deletedToken = token + ":deleted";
  const deletedSubmission = await client.archives.$post({
    json: {
      requestId: "e2e:archive-batch-read:deleted:" + runId,
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e", key: deletedToken },
          title: "Deleted batch read fixture",
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
          body: { text: "This selected item will be deleted." },
          capture: {
            scope: { case: "archive-batch-read-deleted" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  assert.equal(deletedSubmission.status, 201);
  if (deletedSubmission.status !== 201) {
    throw new Error("Deleted-reference fixture submission failed.");
  }
  const deletedCommit = await deletedSubmission.json();
  const deletedItem = deletedCommit.items[0];
  assert.ok(deletedItem !== undefined);
  const deletedReference: ArchiveBatchReadReference = {
    itemId: deletedItem.itemId,
    binId: "binny-runs-one",
    revisionId: deletedItem.revisionId,
    archiveSeq: deletedCommit.archiveSeq,
  };
  const deletion = await client.archives.items[":itemId"].$delete({
    param: { itemId: deletedItem.itemId },
  });
  assert.equal(deletion.status, 200);

  const nonexistentReference: ArchiveBatchReadReference = {
    ...firstBinReference,
    itemId: randomUUID(),
    revisionId: randomUUID(),
  };
  const mismatchedReference: ArchiveBatchReadReference = {
    ...secondBinReference,
    binId: "binny-runs-one",
  };
  const references = [
    firstBinReference,
    secondBinReference,
    firstBinReference,
    nonexistentReference,
    mismatchedReference,
    deletedReference,
  ];
  const batch = await readBatch(client, references);
  assert.deepEqual(
    batch.results.map(({ index }) => index),
    references.map((_, index) => index),
  );
  assert.deepEqual(
    batch.results.map(({ reference }) => reference),
    references,
  );

  const firstResult = batch.results[0];
  assert.ok(firstResult?.status === "readable");
  assert.equal(firstResult.revision.revisionId, match.revisionId);
  assert.equal(firstResult.revision.state.body?.text, bodyText);
  assert.deepEqual(firstResult.resources, [
    { resourceId: uppercaseResourceId, status: "available" },
  ]);
  const secondResult = batch.results[1];
  assert.ok(secondResult?.status === "readable");
  assert.equal(secondResult.revision.revisionId, secondBinReference.revisionId);
  assert.equal(secondResult.revision.state.body?.text, secondBinBodyText);
  const duplicateResult = batch.results[2];
  assert.ok(duplicateResult?.status === "readable");
  assert.equal(duplicateResult.revision.state.body?.text, bodyText);
  assert.deepEqual(batch.results[3], {
    index: 3,
    reference: nonexistentReference,
    status: "unreadable",
    reason: "not_found",
  });
  assert.deepEqual(batch.results[4], {
    index: 4,
    reference: mismatchedReference,
    status: "unreadable",
    reason: "reference_mismatch",
  });
  assert.deepEqual(batch.results[5], {
    index: 5,
    reference: deletedReference,
    status: "unreadable",
    reason: "deleted",
  });

  const missingSequence = await client.archives["batch-read"].$post({
    json: {
      references: [
        {
          itemId: firstBinReference.itemId,
          binId: firstBinReference.binId,
          revisionId: firstBinReference.revisionId,
        },
      ],
    } as never,
  });
  assert.equal(missingSequence.status, 400);
  if (missingSequence.status === 400) {
    const error = (await missingSequence.json()).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["references", 0, "archiveSeq"]);
  }

  const outOfRangeSequence = await client.archives["batch-read"].$post({
    json: {
      references: [
        {
          ...firstBinReference,
          archiveSeq: "9223372036854775808",
        },
      ],
    },
  });
  assert.equal(
    outOfRangeSequence.status,
    400,
    await outOfRangeSequence.clone().text(),
  );
  if (outOfRangeSequence.status === 400) {
    const error = (await outOfRangeSequence.json()).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["references", 0, "archiveSeq"]);
    assert.match(
      error.message,
      /Archive sequence must be between 1 and 9223372036854775807.*archiveSeq from the selected search match/u,
    );
  }

  const tooManyReferences = await client.archives["batch-read"].$post({
    json: {
      references: Array.from(
        { length: archiveBatchReadMaxReferences + 1 },
        () => firstBinReference,
      ),
    },
  });
  assert.equal(tooManyReferences.status, 400);
  if (tooManyReferences.status === 400) {
    const error = (await tooManyReferences.json()).error;
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.path, ["references"]);
    assert.match(error.message, /Read at most 50 references.*another request/u);
  }

  const oversizedToken = token + ":oversized";
  const oversizedSubmission = await client.archives.$post({
    json: {
      requestId: "e2e:archive-batch-read:oversized:" + runId,
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e", key: oversizedToken },
          title: "Oversized batch response " + oversizedToken,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
          body: {
            text:
              "Oversized response body " +
              oversizedToken +
              "\n" +
              "x".repeat(archiveBatchReadMaxResponseBytes + 1_024),
          },
          capture: {
            scope: { case: "archive-batch-read-oversized" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  assert.equal(oversizedSubmission.status, 201);

  const oversizedSearch = await client.archives.search.$post({
    json: {
      bins: ["binny-runs-one"],
      text: { in: "title", groups: [[oversizedToken]] },
      limit: 10,
    },
  });
  assert.equal(oversizedSearch.status, 200);
  if (oversizedSearch.status !== 200) {
    throw new Error("Search for oversized archive fixture failed.");
  }
  const oversizedCandidate = (await oversizedSearch.json()).results.find(
    ({ sourceKey }) => sourceKey.key === oversizedToken,
  );
  assert.ok(oversizedCandidate !== undefined);
  const oversizedMatch = oversizedCandidate.matches.find(
    ({ binId }) => binId === "binny-runs-one",
  );
  assert.ok(oversizedMatch !== undefined);
  const oversizedReference: ArchiveBatchReadReference = {
    itemId: oversizedCandidate.itemId,
    binId: oversizedMatch.binId,
    revisionId: oversizedMatch.revisionId,
    archiveSeq: oversizedMatch.archiveSeq,
  };
  const oversizedRead = await client.archives["batch-read"].$post({
    json: { references: [oversizedReference] },
  });
  assert.equal(oversizedRead.status, 413, await oversizedRead.clone().text());
  if (oversizedRead.status === 413) {
    const error = (await oversizedRead.json()).error;
    assert.equal(error.code, "payload_too_large");
    assert.match(
      error.message,
      new RegExp(
        `complete batch response exceeds ${String(archiveBatchReadMaxResponseBytes)} bytes`,
        "u",
      ),
    );
    assert.match(error.message, /Split the references into smaller requests/u);
    assert.match(error.message, /archive revision <revision-id>/u);
  }

  const cumulativeReferences: ArchiveBatchReadReference[] = [];
  const cumulativeBodies = [
    "Cumulative response one " +
      token +
      "\n" +
      "a".repeat(archiveBatchReadMaxResponseBytes / 2 + 1_024),
    "Cumulative response two " +
      token +
      "\n" +
      "b".repeat(archiveBatchReadMaxResponseBytes / 2 + 1_024),
  ];
  for (const [index, cumulativeBody] of cumulativeBodies.entries()) {
    const cumulativeToken = token + ":cumulative:" + String(index);
    const cumulativeSubmission = await client.archives.$post({
      json: {
        requestId:
          "e2e:archive-batch-read:cumulative:" + runId + ":" + String(index),
        binId: "binny-runs-one",
        items: [
          {
            sourceKey: { namespace: "e2e", key: cumulativeToken },
            title: "Cumulative batch response " + cumulativeToken,
            sourcePublishedAt: null,
            sourceModifiedAt: null,
            extensions: {},
            body: { text: cumulativeBody },
            capture: {
              scope: { case: "archive-batch-read-cumulative" },
              completeness: "complete",
              missing: [],
            },
          },
        ],
      },
    });
    assert.equal(cumulativeSubmission.status, 201);

    const cumulativeSearch = await client.archives.search.$post({
      json: {
        bins: ["binny-runs-one"],
        text: { in: "title", groups: [[cumulativeToken]] },
        limit: 10,
      },
    });
    assert.equal(cumulativeSearch.status, 200);
    if (cumulativeSearch.status !== 200) {
      throw new Error("Search for cumulative batch fixture failed.");
    }
    const cumulativeCandidate = (await cumulativeSearch.json()).results.find(
      ({ sourceKey }) => sourceKey.key === cumulativeToken,
    );
    assert.ok(cumulativeCandidate !== undefined);
    const cumulativeMatch = cumulativeCandidate.matches.find(
      ({ binId }) => binId === "binny-runs-one",
    );
    assert.ok(cumulativeMatch !== undefined);
    const cumulativeReference: ArchiveBatchReadReference = {
      itemId: cumulativeCandidate.itemId,
      binId: cumulativeMatch.binId,
      revisionId: cumulativeMatch.revisionId,
      archiveSeq: cumulativeMatch.archiveSeq,
    };
    const singleCumulativeRead = await readBatch(client, [cumulativeReference]);
    const singleCumulativeResult = singleCumulativeRead.results[0];
    assert.ok(singleCumulativeResult?.status === "readable");
    assert.equal(
      singleCumulativeResult.revision.state.body?.text,
      cumulativeBody,
    );
    cumulativeReferences.push(cumulativeReference);
  }

  const cumulativeRead = await client.archives["batch-read"].$post({
    json: { references: cumulativeReferences },
  });
  assert.equal(cumulativeRead.status, 413, await cumulativeRead.clone().text());
  if (cumulativeRead.status === 413) {
    const error = (await cumulativeRead.json()).error;
    assert.equal(error.code, "payload_too_large");
  }

  const repeatedOversizedRead = await client.archives["batch-read"].$post({
    json: {
      references: Array.from(
        { length: archiveBatchReadMaxReferences },
        () => oversizedReference,
      ),
    },
  });
  assert.equal(
    repeatedOversizedRead.status,
    413,
    await repeatedOversizedRead.clone().text(),
  );
  if (repeatedOversizedRead.status === 413) {
    const error = (await repeatedOversizedRead.json()).error;
    assert.equal(error.code, "payload_too_large");
  }

  const recoveredRead = await readBatch(client, [firstBinReference]);
  const recoveredResult = recoveredRead.results[0];
  assert.ok(recoveredResult?.status === "readable");
  assert.equal(recoveredResult.revision.state.body?.text, bodyText);

  return {
    reference: firstBinReference,
    oversizedReference,
    bodyLength: bodyText.length,
    bodySuffix,
    resourceId: uppercaseResourceId,
  };
}

const [baseUrl] = process.argv.slice(2);
if (baseUrl === undefined || baseUrl.length === 0) {
  throw new Error("Archive batch-read verification requires a base URL.");
}
process.stdout.write(
  JSON.stringify(await verifyArchiveBatchRead(baseUrl)) + "\n",
);
