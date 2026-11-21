import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveSearchInputDiagnostic,
  archiveSearchInputIssue,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
  discoverSourceAdapterExtensionFields,
  sourceAdapterManifestSchema,
  sourceAdapterManifestStoredSchema,
  toArchiveJsonSchema,
} from "@binny/contracts";
import { connectDatabase, type CancellableQueryExecutor } from "@binny/db";
import { PgDialect } from "drizzle-orm/pg-core";

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

const baseManifest = {
  id: "test.related-adapter",
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
    },
    required: ["postNumber"],
    additionalProperties: false,
  },
  searchRelations: {
    topicRoot: {
      relationName: "topic_reply",
      direction: "incoming",
      description: "Opening post of the topic linked to a reply.",
    },
    childReply: {
      relationName: "topic_reply",
      direction: "outgoing",
    },
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

const pgDialect = new PgDialect();

function querySqlText(query: unknown): string {
  if (typeof query === "object" && query !== null && "queryChunks" in query) {
    return pgDialect.sqlToQuery(query as never).sql;
  }
  return "";
}

void describe("archive search related item contract and core resolution", () => {
  void it("validates searchRelations on manifests, discovery, and search input contracts", () => {
    const manifest = sourceAdapterManifestSchema.parse(baseManifest);
    assert.deepEqual(manifest.searchRelations, baseManifest.searchRelations);

    const legacyStored = sourceAdapterManifestStoredSchema.parse({
      ...baseManifest,
      searchRelations: undefined,
    });
    assert.equal(legacyStored.searchRelations, undefined);

    const discovery = discoverSourceAdapterExtensionFields({
      sourceAdapterId: manifest.id,
      sourceAdapterVersion: manifest.version,
      extensionsSchema: manifest.extensionsSchema,
      searchRelations: manifest.searchRelations,
    });
    assert.deepEqual(discovery.searchRelations, baseManifest.searchRelations);

    const emptyDiscovery = discoverSourceAdapterExtensionFields({
      sourceAdapterId: manifest.id,
      sourceAdapterVersion: manifest.version,
      extensionsSchema: manifest.extensionsSchema,
    });
    assert.deepEqual(emptyDiscovery.searchRelations, {});

    const omittedCandidates = parseIssue({
      bins: ["bin-a"],
      includeCandidates: false,
      distribution: { by: "bin" },
      related: {
        sourceAdapterId: "test.related-adapter",
        include: ["topicRoot"],
      },
    });
    assert.deepEqual(omittedCandidates.path, ["related"]);
    assert.deepEqual(omittedCandidates.diagnostic, {
      discovery: { sourceAdapterId: "test.related-adapter", binId: "bin-a" },
    });

    const missingBins = parseIssue({
      related: {
        sourceAdapterId: "test.related-adapter",
        include: ["topicRoot"],
      },
    });
    assert.deepEqual(missingBins.path, ["bins"]);

    const mismatchedExtensions = parseIssue({
      bins: ["bin-a"],
      extensions: {
        sourceAdapterId: "adapter-a",
        filters: { postNumber: { op: "eq", value: 2 } },
      },
      related: { sourceAdapterId: "adapter-b", include: ["topicRoot"] },
    });
    assert.deepEqual(mismatchedExtensions.path, ["related", "sourceAdapterId"]);

    const mismatchedDistribution = parseIssue({
      bins: ["bin-a"],
      distribution: {
        by: "extension",
        sourceAdapterId: "adapter-a",
        field: "postNumber",
      },
      related: { sourceAdapterId: "adapter-b", include: ["topicRoot"] },
    });
    assert.deepEqual(mismatchedDistribution.path, [
      "related",
      "sourceAdapterId",
    ]);

    const duplicateRole = parseIssue({
      bins: ["bin-a"],
      related: {
        sourceAdapterId: "test.related-adapter",
        include: ["topicRoot", "topicRoot"],
      },
    });
    assert.deepEqual(duplicateRole.path, ["related", "include", 1]);

    const requestSchema = toArchiveJsonSchema(
      archiveSearchInputSchema,
      "input",
    );
    const responseSchema = toArchiveJsonSchema(
      archiveSearchPageSchema,
      "output",
    );
    assert.match(JSON.stringify(requestSchema), /"related"/u);
    assert.match(JSON.stringify(responseSchema), /"relatedRevisions"/u);
  });

  void it("validates declared search relation roles and incompatible bin scopes", async () => {
    const connection = connectDatabase(
      "postgres://binny:binny@127.0.0.1:1/binny",
    );
    try {
      const manifestWithRelations =
        sourceAdapterManifestSchema.parse(baseManifest);
      const manifestWithoutRelations = sourceAdapterManifestSchema.parse({
        ...baseManifest,
        id: "test.plain-adapter",
        searchRelations: undefined,
      });
      const manifestIncompatible = sourceAdapterManifestSchema.parse({
        ...baseManifest,
        searchRelations: {
          topicRoot: {
            relationName: "different_relation",
            direction: "outgoing",
          },
        },
      });

      let scopeBins: readonly {
        readonly binId: string;
        readonly sourceAdapter: unknown;
      }[] = [{ binId: "bin-a", sourceAdapter: manifestWithRelations }];
      const executeQuery: CancellableQueryExecutor = () => ({
        rows: Promise.resolve([
          {
            snapshotAsOf: "20",
            snapshotMode: "current",
            invalidSnapshot: false,
            results: [],
            matchedBinAdapters: {},
            extensionBins: scopeBins,
            distributionTotalItems: null,
            distributionGroups: [],
          },
        ] as never),
        cancel: () => undefined,
      });

      const { searchArchive } = createArchiveSearchOperation(
        connection.database,
        executeQuery,
        { inspectAvailability: async () => new Map() },
      );

      const unknownRole = await searchArchive({
        bins: ["bin-a"],
        related: {
          sourceAdapterId: "test.related-adapter",
          include: ["unknownRole"],
        },
      });
      assert.equal(unknownRole.ok, false);
      if (unknownRole.ok) throw new Error("Expected invalid_input failure.");
      assert.equal(unknownRole.status, 400);
      assert.deepEqual(unknownRole.error.path, ["related", "include", 0]);
      assert.deepEqual(unknownRole.error.diagnostic, {
        allowedItemValues: ["childReply", "topicRoot"],
        discovery: {
          sourceAdapterId: "test.related-adapter",
          sourceAdapterVersion: "1.0.0",
          binId: "bin-a",
        },
      });

      scopeBins = [
        { binId: "bin-plain", sourceAdapter: manifestWithoutRelations },
      ];
      const emptyRoles = await searchArchive({
        bins: ["bin-plain"],
        related: {
          sourceAdapterId: "test.plain-adapter",
          include: ["topicRoot"],
        },
      });
      assert.equal(emptyRoles.ok, false);
      if (emptyRoles.ok) throw new Error("Expected invalid_input failure.");
      assert.equal(emptyRoles.status, 400);
      assert.deepEqual(emptyRoles.error.path, ["related", "include", 0]);
      assert.deepEqual(emptyRoles.error.diagnostic, {
        discovery: {
          sourceAdapterId: "test.plain-adapter",
          sourceAdapterVersion: "1.0.0",
          binId: "bin-plain",
        },
      });

      scopeBins = [
        { binId: "bin-a", sourceAdapter: manifestWithRelations },
        { binId: "bin-b", sourceAdapter: manifestIncompatible },
      ];
      const incompatibleBins = await searchArchive({
        bins: ["bin-a", "bin-b"],
        related: {
          sourceAdapterId: "test.related-adapter",
          include: ["topicRoot"],
        },
      });
      assert.equal(incompatibleBins.ok, false);
      if (incompatibleBins.ok)
        throw new Error("Expected invalid_input failure.");
      assert.equal(incompatibleBins.status, 400);
      assert.deepEqual(incompatibleBins.error.path, ["bins"]);
    } finally {
      await connection.close();
    }
  });

  void it("resolves readable, deduplicated, none, and unreadable related items without altering cursors", async () => {
    const connection = connectDatabase(
      "postgres://binny:binny@127.0.0.1:1/binny",
    );
    try {
      const manifest = sourceAdapterManifestSchema.parse(baseManifest);
      const reply1ItemId = "11111111-1111-4111-8111-111111111111";
      const reply2ItemId = "22222222-2222-4222-8222-222222222222";
      const rootItemId = "33333333-3333-4333-8333-333333333333";
      const unobservedRootId = "44444444-4444-4444-8444-444444444444";
      const deletedRootId = "55555555-5555-4555-8555-555555555555";
      const replyUnobservedItemId = "66666666-6666-4666-8666-666666666666";
      const replyDeletedItemId = "77777777-7777-4777-8777-777777777777";
      const replyWithdrawnItemId = "88888888-8888-4888-8888-888888888888";
      const replyAmbiguousItemId = "99999999-9999-4999-8999-999999999999";

      const reply1RevId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
      const reply2RevId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
      const rootRevId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
      const rootItem2RevId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
      const replyUnobservedRevId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
      const replyDeletedRevId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
      const replyWithdrawnRevId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
      const replyAmbiguousRevId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
      const resAvailableId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
      const resMissingId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";

      const makeMatch = (
        binId: string,
        revisionId: string,
        archiveSeq: string,
      ) => ({
        binId,
        revisionId,
        archiveSeq,
        observedAt: "2026-11-10T02:00:00.000Z",
        recordedAt: "2026-11-10T02:00:01.000Z",
        title: null,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
      });

      const pageResults = [
        {
          itemId: reply1ItemId,
          sourceKey: { namespace: "linuxdo", key: "post:102" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          observedAt: "2026-11-10T02:00:00.000Z",
          matches: [makeMatch("bin-a", reply1RevId, "12")],
        },
        {
          itemId: reply2ItemId,
          sourceKey: { namespace: "linuxdo", key: "post:103" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          observedAt: "2026-11-10T01:59:00.000Z",
          matches: [makeMatch("bin-a", reply2RevId, "13")],
        },
        {
          itemId: rootItemId,
          sourceKey: { namespace: "linuxdo", key: "post:101" },
          title: "Root title",
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          observedAt: "2026-11-10T01:58:00.000Z",
          matches: [makeMatch("bin-a", rootItem2RevId, "11")],
        },
        {
          itemId: replyUnobservedItemId,
          sourceKey: { namespace: "linuxdo", key: "post:202" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          observedAt: "2026-11-10T01:57:00.000Z",
          matches: [makeMatch("bin-a", replyUnobservedRevId, "14")],
        },
        {
          itemId: replyDeletedItemId,
          sourceKey: { namespace: "linuxdo", key: "post:302" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          observedAt: "2026-11-10T01:56:00.000Z",
          matches: [makeMatch("bin-a", replyDeletedRevId, "15")],
        },
        {
          itemId: replyWithdrawnItemId,
          sourceKey: { namespace: "linuxdo", key: "post:402" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          observedAt: "2026-11-10T01:55:00.000Z",
          matches: [makeMatch("bin-a", replyWithdrawnRevId, "16")],
        },
        {
          itemId: replyAmbiguousItemId,
          sourceKey: { namespace: "linuxdo", key: "post:502" },
          title: null,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          observedAt: "2026-11-10T01:54:00.000Z",
          matches: [makeMatch("bin-a", replyAmbiguousRevId, "17")],
        },
      ];

      const executeQuery: CancellableQueryExecutor = (query) => {
        const sqlText = querySqlText(query);
        if (sqlText.includes("fixed_snapshot")) {
          return {
            rows: Promise.resolve([
              {
                snapshotAsOf: "20",
                snapshotMode: "current",
                invalidSnapshot: false,
                results: pageResults,
                matchedBinAdapters: { "bin-a": manifest },
                extensionBins: [{ binId: "bin-a", sourceAdapter: manifest }],
                distributionTotalItems: null,
                distributionGroups: [],
              },
            ] as never),
            cancel: () => undefined,
          };
        }
        if (
          sqlText.includes("archive_relation_observation_gap") &&
          !sqlText.includes("archive_relation_revision")
        ) {
          // Step B: gap query
          return {
            rows: Promise.resolve([
              {
                relationId: "rel-deleted",
                binId: "bin-a",
                archiveSequence: 8n,
                ordinal: 0,
                commitId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
                fromItemId: deletedRootId,
                targetItemId: replyDeletedItemId,
                deletedNamespace: "linuxdo",
                deletedSourceKey: "post:301",
                itemNamespace: null,
                itemSourceKey: null,
              },
            ] as never),
            cancel: () => undefined,
          };
        }
        if (sqlText.includes("archive_relation_revision")) {
          // Step A: active & withdrawn relation observations
          return {
            rows: Promise.resolve([
              {
                relationId: "rel-1",
                binId: "bin-a",
                archiveSequence: 12n,
                ordinal: 0,
                commitId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
                fromItemId: rootItemId,
                targetItemId: reply1ItemId,
                targetSourceRef: null,
                relationRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
                relationName: "topic_reply",
              },
              {
                relationId: "rel-2",
                binId: "bin-a",
                archiveSequence: 13n,
                ordinal: 0,
                commitId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
                fromItemId: rootItemId,
                targetItemId: reply2ItemId,
                targetSourceRef: null,
                relationRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
                relationName: "topic_reply",
              },
              {
                relationId: "rel-unobserved",
                binId: "bin-a",
                archiveSequence: 14n,
                ordinal: 0,
                commitId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
                fromItemId: unobservedRootId,
                targetItemId: replyUnobservedItemId,
                targetSourceRef: null,
                relationRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3",
                relationName: "topic_reply",
              },
              {
                relationId: "rel-withdrawn",
                binId: "bin-a",
                archiveSequence: 16n,
                ordinal: 0,
                commitId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd5",
                fromItemId: rootItemId,
                targetItemId: replyWithdrawnItemId,
                targetSourceRef: null,
                relationRevisionId: null,
                relationName: null,
              },
              {
                relationId: "rel-amb-1",
                binId: "bin-a",
                archiveSequence: 17n,
                ordinal: 0,
                commitId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd6",
                fromItemId: rootItemId,
                targetItemId: replyAmbiguousItemId,
                targetSourceRef: null,
                relationRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4",
                relationName: "topic_reply",
              },
              {
                relationId: "rel-amb-2",
                binId: "bin-a",
                archiveSequence: 17n,
                ordinal: 1,
                commitId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd6",
                fromItemId: unobservedRootId,
                targetItemId: replyAmbiguousItemId,
                targetSourceRef: null,
                relationRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5",
                relationName: "topic_reply",
              },
            ] as never),
            cancel: () => undefined,
          };
        }
        if (sqlText.includes("archive_observation")) {
          // Step C: latest item observation for related items in bin-a <= 20
          return {
            rows: Promise.resolve([
              {
                itemId: rootItemId,
                binId: "bin-a",
                revisionId: rootRevId,
                archiveSequence: 11n,
              },
            ] as never),
            cancel: () => undefined,
          };
        }
        if (sqlText.includes("archive_revision")) {
          // Step E: batch load deduplicated revisions
          return {
            rows: Promise.resolve([
              {
                revisionId: rootRevId,
                itemId: rootItemId,
                namespace: "linuxdo",
                sourceKey: "post:101",
                stateHash: "a".repeat(64),
                stateData: {
                  title: "Topic One Opening Post",
                  sourcePublishedAt: null,
                  sourceModifiedAt: null,
                  extensions: { postNumber: 1 },
                  body: { text: "Full opening post body" },
                  resources: [
                    { resourceId: resAvailableId },
                    { resourceId: resMissingId },
                  ],
                  capture: {
                    scope: { topicId: 101 },
                    completeness: "complete",
                    missing: [],
                  },
                },
              },
            ] as never),
            cancel: () => undefined,
          };
        }
        if (sqlText.includes("archive_item_deletion")) {
          return {
            rows: Promise.resolve([] as never),
            cancel: () => undefined,
          };
        }
        if (sqlText.includes("archive_item")) {
          // Step C fallback: metadata for unobserved item
          return {
            rows: Promise.resolve([
              {
                itemId: unobservedRootId,
                namespace: "linuxdo",
                sourceKey: "post:201",
              },
            ] as never),
            cancel: () => undefined,
          };
        }
        return { rows: Promise.resolve([] as never), cancel: () => undefined };
      };

      const { searchArchive } = createArchiveSearchOperation(
        connection.database,
        executeQuery,
        {
          inspectAvailability: async () =>
            new Map([
              [resAvailableId.toLowerCase(), true],
              [resMissingId.toLowerCase(), false],
            ]),
        },
      );

      const baselinePaged = await searchArchive({ bins: ["bin-a"], limit: 5 });
      assert.equal(baselinePaged.ok, true);
      if (!baselinePaged.ok)
        throw new Error("Expected baseline paged success.");
      assert.equal(baselinePaged.value.hasMore, true);

      const withRelatedPaged = await searchArchive({
        bins: ["bin-a"],
        limit: 5,
        related: {
          sourceAdapterId: "test.related-adapter",
          include: ["topicRoot"],
        },
      });
      assert.equal(withRelatedPaged.ok, true);
      if (!withRelatedPaged.ok)
        throw new Error("Expected related paged success.");
      assert.equal(
        withRelatedPaged.value.nextCursor,
        baselinePaged.value.nextCursor,
      );

      const baseline = await searchArchive({ bins: ["bin-a"], limit: 10 });
      assert.equal(baseline.ok, true);
      if (!baseline.ok) throw new Error("Expected baseline search success.");
      assert.equal(baseline.value.relatedRevisions, undefined);
      assert.equal(baseline.value.results[0]?.matches[0]?.related, undefined);

      const withRelated = await searchArchive({
        bins: ["bin-a"],
        limit: 10,
        related: {
          sourceAdapterId: "test.related-adapter",
          include: ["topicRoot"],
        },
      });
      assert.equal(withRelated.ok, true);
      if (!withRelated.ok) throw new Error("Expected related search success.");

      assert.equal(withRelated.value.nextCursor, baseline.value.nextCursor);
      assert.deepEqual(
        withRelated.value.results.map(({ itemId }) => itemId),
        baseline.value.results.map(({ itemId }) => itemId),
      );

      assert.deepEqual(Object.keys(withRelated.value.relatedRevisions ?? {}), [
        rootRevId,
      ]);
      const sharedRevision = withRelated.value.relatedRevisions?.[rootRevId];
      assert.equal(
        sharedRevision?.revision.state.body?.text,
        "Full opening post body",
      );
      assert.deepEqual(sharedRevision?.resources, [
        { resourceId: resAvailableId, status: "available" },
        { resourceId: resMissingId, status: "missing" },
      ]);

      const byItemId = new Map(
        withRelated.value.results.map((r) => [r.itemId, r.matches[0]?.related]),
      );
      assert.deepEqual(byItemId.get(reply1ItemId)?.topicRoot, {
        status: "readable",
        reference: {
          itemId: rootItemId,
          binId: "bin-a",
          revisionId: rootRevId,
          archiveSeq: "11",
        },
      });
      assert.deepEqual(byItemId.get(reply2ItemId)?.topicRoot, {
        status: "readable",
        reference: {
          itemId: rootItemId,
          binId: "bin-a",
          revisionId: rootRevId,
          archiveSeq: "11",
        },
      });
      assert.deepEqual(byItemId.get(rootItemId)?.topicRoot, { status: "none" });
      assert.deepEqual(byItemId.get(replyWithdrawnItemId)?.topicRoot, {
        status: "none",
      });
      assert.deepEqual(byItemId.get(replyUnobservedItemId)?.topicRoot, {
        status: "unreadable",
        reason: "not_observed",
        itemId: unobservedRootId,
        sourceKey: { namespace: "linuxdo", key: "post:201" },
      });
      assert.deepEqual(byItemId.get(replyDeletedItemId)?.topicRoot, {
        status: "unreadable",
        reason: "deleted",
        itemId: deletedRootId,
        sourceKey: { namespace: "linuxdo", key: "post:301" },
      });
      assert.deepEqual(byItemId.get(replyAmbiguousItemId)?.topicRoot, {
        status: "unreadable",
        reason: "ambiguous_target",
      });
    } finally {
      await connection.close();
    }
  });
});
