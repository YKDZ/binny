import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApiClient } from "@binny/api/client";
import { archiveBatchReadResponseSchema } from "@binny/contracts";

async function verifyArchiveBatchRead(baseUrl: string): Promise<void> {
  const client = createApiClient(baseUrl);
  const runId = randomUUID();
  const token = "batch-read-" + runId;
  const bodyText = "Exact selected content " + token;
  const submitted = await client.archives.$post({
    json: {
      requestId: "e2e:archive-batch-read:" + runId,
      binId: "binny-runs-one",
      items: [
        {
          sourceKey: { namespace: "e2e", key: token },
          title: "Exact batch read fixture",
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
          body: { text: bodyText },
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

  const reference = {
    itemId: candidate.itemId,
    binId: match.binId,
    revisionId: match.revisionId,
    archiveSeq: match.archiveSeq,
  };
  const response = await client.archives["batch-read"].$post({
    json: { references: [reference] },
  });
  assert.equal(response.status, 200);
  if (response.status !== 200) {
    throw new Error("Batch archive read failed.");
  }
  const result = archiveBatchReadResponseSchema.parse(await response.json())
    .results[0];
  assert.ok(result !== undefined);
  assert.equal(result.status, "readable");
  if (result.status !== "readable") return;
  assert.deepEqual(result.reference, reference);
  assert.equal(result.revision.revisionId, match.revisionId);
  assert.equal(result.revision.state.body?.text, bodyText);
}

const [baseUrl] = process.argv.slice(2);
if (baseUrl === undefined || baseUrl.length === 0) {
  throw new Error("Archive batch-read verification requires a base URL.");
}
await verifyArchiveBatchRead(baseUrl);
process.stdout.write(
  "Exact archive batch-read reference verification passed.\n",
);
