import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  discoverSourceAdapterExtensionFields,
  extractArchiveSummaryExtensions,
  resolveSourceAdapterSummaryFields,
  sourceAdapterManifestSchema,
  sourceAdapterManifestStoredSchema,
} from "@binny/contracts";
import { connectDatabase, type CancellableQueryExecutor } from "@binny/db";

import { createArchiveSearchOperation } from "./archive-search.ts";
import { validateSourceAdapterExtensions } from "./bin-configuration.ts";

const baseManifest = {
  id: "test.summary-adapter",
  version: "1.0.0",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema: { type: "object", properties: {} },
  extensionsSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      postNumber: { type: "integer", exclusiveMinimum: 0 },
      tags: { type: "array", items: { type: "string" } },
      topic: {
        type: "object",
        properties: {
          slug: { type: "string" },
          title: { type: "string", minLength: 1 },
        },
        required: ["slug"],
        additionalProperties: false,
      },
      media: {
        type: "array",
        items: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
    },
    required: ["postNumber", "tags", "topic"],
    additionalProperties: false,
  },
  actions: {
    check: {
      description: "Check source",
      params: { type: "object", properties: {} },
      output: { type: "object", properties: { ok: { type: "boolean" } } },
    },
    collect: {
      description: "Collect source",
      params: { type: "object", properties: {} },
      output: { type: "object", properties: { ok: { type: "boolean" } } },
    },
  },
} as const;

void describe("archive search summary fields contract and core projection", () => {
  void it("validates searchSummaryFields on manifests and projects summaryFields in discovery", () => {
    const valid = sourceAdapterManifestSchema.parse({
      ...baseManifest,
      searchSummaryFields: ["postNumber", "topic.title", "tags"],
    });
    assert.deepEqual(valid.searchSummaryFields, [
      "postNumber",
      "topic.title",
      "tags",
    ]);

    const ajvError = validateSourceAdapterExtensions(valid, {
      postNumber: 2,
      tags: ["help"],
      topic: { slug: "test-topic", title: "Topic Title" },
    });
    assert.equal(ajvError, undefined);

    const discovery = discoverSourceAdapterExtensionFields({
      sourceAdapterId: valid.id,
      sourceAdapterVersion: valid.version,
      extensionsSchema: valid.extensionsSchema,
      searchSummaryFields: valid.searchSummaryFields,
    });
    assert.deepEqual(
      discovery.summaryFields.map(({ path, type, required, itemType }) => ({
        path,
        type,
        required,
        itemType,
      })),
      [
        {
          path: "postNumber",
          type: "integer",
          required: true,
          itemType: undefined,
        },
        {
          path: "topic.title",
          type: "string",
          required: false,
          itemType: undefined,
        },
        { path: "tags", type: "array", required: true, itemType: "string" },
      ],
    );

    const legacyDiscovery = discoverSourceAdapterExtensionFields({
      sourceAdapterId: valid.id,
      sourceAdapterVersion: valid.version,
      extensionsSchema: valid.extensionsSchema,
    });
    assert.deepEqual(legacyDiscovery.summaryFields, []);

    for (const invalidSummaryFields of [
      ["postNumber", "postNumber"],
      ["missingField"],
      ["topic"],
      ["media"],
      ["topic.missing"],
    ]) {
      const checked = sourceAdapterManifestSchema.safeParse({
        ...baseManifest,
        searchSummaryFields: invalidSummaryFields,
      });
      assert.equal(
        checked.success,
        false,
        `Expected ${JSON.stringify(invalidSummaryFields)} to be rejected.`,
      );
    }

    const legacyStored = sourceAdapterManifestStoredSchema.parse(baseManifest);
    assert.equal(legacyStored.searchSummaryFields, undefined);
  });

  void it("extracts summary values along dotted paths and skips absent or null values", () => {
    const summaryFields = resolveSourceAdapterSummaryFields({
      extensionsSchema: baseManifest.extensionsSchema,
      searchSummaryFields: ["postNumber", "topic.title", "tags"],
    });

    assert.deepEqual(
      extractArchiveSummaryExtensions(
        {
          postNumber: 4,
          tags: ["v1", "summary"],
          topic: { slug: "s", title: "Controlled Topic" },
        },
        summaryFields,
      ),
      {
        postNumber: 4,
        "topic.title": "Controlled Topic",
        tags: ["v1", "summary"],
      },
    );

    assert.deepEqual(
      extractArchiveSummaryExtensions(
        {
          postNumber: 2,
          tags: [],
          topic: { slug: "legacy-reply" },
        },
        summaryFields,
      ),
      {
        postNumber: 2,
        tags: [],
      },
    );

    assert.equal(
      extractArchiveSummaryExtensions(
        {
          postNumber: null,
          topic: { slug: "s", title: null },
        },
        summaryFields,
      ),
      undefined,
    );
  });

  void it("attaches per-view summaryExtensions without leaking raw extensions or altering cursors", async () => {
    const connection = connectDatabase(
      "postgres://binny:binny@127.0.0.1:1/binny",
    );
    try {
      const manifestWithSummary = sourceAdapterManifestSchema.parse({
        ...baseManifest,
        searchSummaryFields: ["postNumber", "topic.title"],
      });
      const manifestWithoutSummary = sourceAdapterManifestSchema.parse({
        ...baseManifest,
        id: "test.plain-adapter",
      });
      const itemId = "11111111-1111-4111-8111-111111111111";
      const secondItemId = "22222222-2222-4222-8222-222222222222";
      const revOne = "33333333-3333-4333-8333-333333333333";
      const revTwo = "44444444-4444-4444-8444-444444444444";
      const revLegacy = "55555555-5555-4555-8555-555555555555";

      let includeSummaryInAdapters = true;
      const executeQuery: CancellableQueryExecutor = () => ({
        rows: Promise.resolve([
          {
            snapshotAsOf: "20",
            snapshotMode: "current",
            invalidSnapshot: false,
            results: [
              {
                itemId,
                sourceKey: { namespace: "linuxdo", key: "post:102" },
                title: "Reply own title",
                sourcePublishedAt: null,
                sourceModifiedAt: null,
                observedAt: "2026-11-10T02:00:00.000Z",
                matches: [
                  {
                    binId: "bin-a",
                    revisionId: revOne,
                    archiveSeq: "12",
                    observedAt: "2026-11-10T02:00:00.000Z",
                    recordedAt: "2026-11-10T02:00:01.000Z",
                    title: "Reply own title",
                    sourcePublishedAt: null,
                    sourceModifiedAt: null,
                    __extensions: {
                      postNumber: 2,
                      topic: { slug: "topic-a", title: "Topic Title View A" },
                    },
                  },
                  {
                    binId: "bin-b",
                    revisionId: revTwo,
                    archiveSeq: "10",
                    observedAt: "2026-11-10T01:00:00.000Z",
                    recordedAt: "2026-11-10T01:00:01.000Z",
                    title: null,
                    sourcePublishedAt: null,
                    sourceModifiedAt: null,
                    __extensions: {
                      postNumber: 2,
                      topic: { slug: "topic-b" },
                    },
                  },
                ],
              },
              {
                itemId: secondItemId,
                sourceKey: { namespace: "linuxdo", key: "post:103" },
                title: null,
                sourcePublishedAt: null,
                sourceModifiedAt: null,
                observedAt: "2026-11-10T00:30:00.000Z",
                matches: [
                  {
                    binId: "deleted-bin",
                    revisionId: revLegacy,
                    archiveSeq: "5",
                    observedAt: "2026-11-10T00:30:00.000Z",
                    recordedAt: "2026-11-10T00:30:01.000Z",
                    title: null,
                    sourcePublishedAt: null,
                    sourceModifiedAt: null,
                    __extensions: {
                      postNumber: 3,
                      topic: { slug: "deleted", title: "Should Not Appear" },
                    },
                  },
                ],
              },
            ],
            matchedBinAdapters: includeSummaryInAdapters
              ? {
                  "bin-a": manifestWithSummary,
                  "bin-b": manifestWithSummary,
                }
              : {
                  "bin-a": manifestWithoutSummary,
                  "bin-b": manifestWithoutSummary,
                },
            extensionBins: [],
            distributionTotalItems: null,
            distributionGroups: [],
          },
        ] as never),
        cancel: () => undefined,
      });

      const { searchArchive } = createArchiveSearchOperation(
        connection.database,
        executeQuery,
      );

      const withSummary = await searchArchive({ limit: 1 });
      assert.equal(withSummary.ok, true);
      if (!withSummary.ok) throw new Error("Expected search success.");
      assert.equal(withSummary.value.hasMore, true);
      assert.equal(withSummary.value.results.length, 1);
      const firstResult = withSummary.value.results[0]!;
      assert.equal(firstResult.title, "Reply own title");
      assert.deepEqual(firstResult.matches[0]?.summaryExtensions, {
        postNumber: 2,
        "topic.title": "Topic Title View A",
      });
      assert.deepEqual(firstResult.matches[1]?.summaryExtensions, {
        postNumber: 2,
      });
      assert.equal("__extensions" in (firstResult.matches[0] ?? {}), false);

      includeSummaryInAdapters = false;
      const withoutSummary = await searchArchive({ limit: 1 });
      assert.equal(withoutSummary.ok, true);
      if (!withoutSummary.ok) throw new Error("Expected search success.");
      assert.equal(
        withoutSummary.value.results[0]?.matches[0]?.summaryExtensions,
        undefined,
      );
      assert.equal(
        withoutSummary.value.nextCursor,
        withSummary.value.nextCursor,
      );
    } finally {
      await connection.close();
    }
  });
});
