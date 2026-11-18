import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveSearchInputDiagnostic,
  archiveSearchInputIssue,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
  toArchiveJsonSchema,
} from "@binny/contracts";
import { connectDatabase, type CancellableQueryExecutor } from "@binny/db";

import { createArchiveSearchOperation } from "./archive-search.ts";

function parseIssue(input: unknown) {
  const checked = archiveSearchInputSchema.safeParse(input);
  assert.equal(checked.success, false, "Expected search input to fail.");
  const issue = archiveSearchInputIssue(input, checked.error.issues);
  const diagnostic = archiveSearchInputDiagnostic(input, issue);
  return {
    path: issue?.path,
    message: issue?.message,
    diagnostic,
  };
}

void describe("archive search distribution order contract", () => {
  void it("defaults distribution.order to key and accepts count across all dimensions", () => {
    const binDefault = archiveSearchInputSchema.parse({
      distribution: { by: "bin" },
    });
    assert.equal(binDefault.distribution?.order, "key");

    const dateCount = archiveSearchInputSchema.parse({
      distribution: {
        by: "date",
        field: "sourcePublishedAt",
        timeZone: "Asia/Shanghai",
        order: "count",
      },
    });
    assert.equal(dateCount.distribution?.order, "count");

    const extensionCount = archiveSearchInputSchema.parse({
      bins: ["linuxdo-main"],
      distribution: {
        by: "extension",
        sourceAdapterId: "linuxdo",
        field: "topicId",
        order: "count",
      },
    });
    assert.equal(extensionCount.distribution?.order, "count");
  });

  void it("reports distribution.order path and allowedValues for invalid order across dimensions", () => {
    const invalidBin = parseIssue({
      distribution: { by: "bin", order: "popular" },
    });
    assert.deepEqual(invalidBin.path, ["distribution", "order"]);
    assert.deepEqual(invalidBin.diagnostic, {
      allowedValues: ["key", "count"],
    });

    const invalidDate = parseIssue({
      distribution: {
        by: "date",
        field: "observedAt",
        timeZone: "UTC",
        order: "desc",
      },
    });
    assert.deepEqual(invalidDate.path, ["distribution", "order"]);
    assert.deepEqual(invalidDate.diagnostic, {
      allowedValues: ["key", "count"],
    });

    const invalidExtension = parseIssue({
      bins: ["linuxdo-main"],
      distribution: {
        by: "extension",
        sourceAdapterId: "linuxdo",
        field: "topicId",
        order: "numeric",
      },
    });
    assert.deepEqual(invalidExtension.path, ["distribution", "order"]);
    assert.deepEqual(invalidExtension.diagnostic, {
      allowedValues: ["key", "count"],
      discovery: { sourceAdapterId: "linuxdo", binId: "linuxdo-main" },
    });

    const invalidWithExtensionsFilter = parseIssue({
      bins: ["linuxdo-main"],
      extensions: {
        sourceAdapterId: "linuxdo",
        filters: { topicId: { op: "eq", value: 1 } },
      },
      distribution: { by: "bin", order: "votes" },
    });
    assert.deepEqual(invalidWithExtensionsFilter.path, [
      "distribution",
      "order",
    ]);
    assert.deepEqual(invalidWithExtensionsFilter.diagnostic, {
      allowedValues: ["key", "count"],
      discovery: { sourceAdapterId: "linuxdo", binId: "linuxdo-main" },
    });
  });

  void it("echoes effective distribution.order in search page and projects JSON schemas", () => {
    const page = archiveSearchPageSchema.parse({
      snapshot: { asOf: "12", mode: "current" },
      candidatesIncluded: false,
      results: [],
      hasMore: false,
      distribution: {
        by: "bin",
        order: "count",
        totalItems: "10",
        groups: [{ kind: "bin", binId: "b1", itemCount: "10" }],
        hasMore: false,
      },
    });
    assert.equal(page.distribution?.order, "count");

    const inputSchema = toArchiveJsonSchema(archiveSearchInputSchema, "input");
    const outputSchema = toArchiveJsonSchema(archiveSearchPageSchema, "output");
    assert.ok(JSON.stringify(inputSchema).includes('"order"'));
    assert.ok(JSON.stringify(outputSchema).includes('"order"'));
  });
});

void describe("archive search distribution cursor binding", () => {
  void it("binds distribution cursors to order and rejects cross-order or malformed itemCount cursors", async () => {
    const connection = connectDatabase(
      "postgres://binny:binny@127.0.0.1:1/binny",
    );
    try {
      let queryCalls = 0;
      const executeQuery: CancellableQueryExecutor = () => {
        queryCalls += 1;
        return {
          rows: Promise.resolve([
            {
              snapshotAsOf: "10",
              snapshotMode: "current",
              invalidSnapshot: false,
              results: [],
              extensionBins: [],
              distributionTotalItems: "12",
              distributionGroups: [
                {
                  kind: "bin",
                  binId: "bin-top",
                  itemCount: "10",
                  __distributionKey: "bin-top",
                },
                {
                  kind: "bin",
                  binId: "bin-second",
                  itemCount: "2",
                  __distributionKey: "bin-second",
                },
              ],
            },
          ] as never),
          cancel: () => undefined,
        };
      };

      const { searchArchive } = createArchiveSearchOperation(
        connection.database,
        executeQuery,
      );

      const countPage = await searchArchive({
        includeCandidates: false,
        distribution: { by: "bin", order: "count", limit: 1 },
      });
      assert.equal(countPage.ok, true);
      if (!countPage.ok || countPage.value.distribution?.by !== "bin") {
        throw new Error("Expected bin count distribution page.");
      }
      assert.equal(countPage.value.distribution.order, "count");
      assert.equal(countPage.value.distribution.hasMore, true);
      const countCursor = countPage.value.distribution.nextCursor;
      assert.ok(countCursor);

      const decodedCountCursor = JSON.parse(
        Buffer.from(countCursor, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      assert.equal(decodedCountCursor.itemCount, "10");

      const callsBeforeRejections = queryCalls;

      const crossToKey = await searchArchive({
        includeCandidates: false,
        distribution: {
          by: "bin",
          order: "key",
          limit: 1,
          cursor: countCursor,
        },
      });
      assert.equal(crossToKey.ok, false);
      if (!crossToKey.ok) {
        assert.equal(crossToKey.status, 400);
        assert.equal(crossToKey.error.code, "invalid_input");
        assert.deepEqual(crossToKey.error.path, ["distribution", "cursor"]);
      }

      const keyPage = await searchArchive({
        includeCandidates: false,
        distribution: { by: "bin", limit: 1 },
      });
      assert.equal(keyPage.ok, true);
      if (!keyPage.ok || keyPage.value.distribution?.by !== "bin") {
        throw new Error("Expected bin key distribution page.");
      }
      assert.equal(keyPage.value.distribution.order, "key");
      const keyCursor = keyPage.value.distribution.nextCursor;
      assert.ok(keyCursor);

      const decodedKeyCursor = JSON.parse(
        Buffer.from(keyCursor, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      assert.equal("itemCount" in decodedKeyCursor, false);

      const callsAfterKeyPage = queryCalls;

      const crossToCount = await searchArchive({
        includeCandidates: false,
        distribution: {
          by: "bin",
          order: "count",
          limit: 1,
          cursor: keyCursor,
        },
      });
      assert.equal(crossToCount.ok, false);
      if (!crossToCount.ok) {
        assert.equal(crossToCount.status, 400);
        assert.equal(crossToCount.error.code, "invalid_input");
        assert.deepEqual(crossToCount.error.path, ["distribution", "cursor"]);
      }

      const overflowItemCountCursor = Buffer.from(
        JSON.stringify({
          ...decodedCountCursor,
          itemCount: "9223372036854775808",
        }),
      ).toString("base64url");
      const overflowRejected = await searchArchive({
        includeCandidates: false,
        distribution: {
          by: "bin",
          order: "count",
          limit: 1,
          cursor: overflowItemCountCursor,
        },
      });
      assert.equal(overflowRejected.ok, false);
      if (!overflowRejected.ok) {
        assert.equal(overflowRejected.status, 400);
        assert.equal(overflowRejected.error.code, "invalid_input");
        assert.deepEqual(overflowRejected.error.path, [
          "distribution",
          "cursor",
        ]);
      }

      const missingItemCountForCountCursor = Buffer.from(
        JSON.stringify({
          version: decodedCountCursor.version,
          queryHash: decodedCountCursor.queryHash,
          snapshot: decodedCountCursor.snapshot,
          groupKey: decodedCountCursor.groupKey,
        }),
      ).toString("base64url");
      const missingItemCountRejected = await searchArchive({
        includeCandidates: false,
        distribution: {
          by: "bin",
          order: "count",
          limit: 1,
          cursor: missingItemCountForCountCursor,
        },
      });
      assert.equal(missingItemCountRejected.ok, false);
      if (!missingItemCountRejected.ok) {
        assert.equal(missingItemCountRejected.status, 400);
        assert.equal(missingItemCountRejected.error.code, "invalid_input");
        assert.deepEqual(missingItemCountRejected.error.path, [
          "distribution",
          "cursor",
        ]);
      }

      assert.equal(callsBeforeRejections, 1);
      assert.equal(queryCalls, callsAfterKeyPage);
    } finally {
      await connection.close();
    }
  });
});
