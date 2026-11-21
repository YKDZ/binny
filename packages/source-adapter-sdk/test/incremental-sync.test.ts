import assert from "node:assert/strict";
import test from "node:test";

import {
  computeOngoingDocumentHash,
  createEmptyIncrementalSyncState,
  feedSyncOutputSchema,
  getIncrementalScopeOngoingDocument,
  hasIncrementalEntryChanged,
  hasOngoingDocumentChanged,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  isSourceAdapterActionError,
  loadIncrementalSyncState,
  pruneInactiveOngoingDocuments,
  recordIncrementalArchivedEntry,
  recordIncrementalBaselineEntry,
  recordIncrementalBodyGapEntry,
  saveIncrementalSyncState,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  upsertIncrementalScopeOngoingDocument,
  type IncrementalSyncState,
  type SourceAdapterContext,
} from "../src/index.ts";

function createMockContext(persistentState?: {
  load(): Promise<unknown>;
  save(state: unknown): Promise<void>;
}): SourceAdapterContext {
  const base = {
    binId: "test-bin",
    identityId: "test-id",
    runId: "test-run",
    referenceTime: "2026-11-07T00:00:00Z",
    sourceAdapterVersion: "1.0.0",
    config: {},
    signal: new AbortController().signal,
    archive: {
      async submit() {
        throw new Error("not implemented");
      },
    },
    resources: {
      async upload() {
        throw new Error("not implemented");
      },
      async resolve() {
        throw new Error("not implemented");
      },
    },
  };
  return (
    persistentState === undefined
      ? base
      : {
          ...base,
          persistentState:
            persistentState as unknown as SourceAdapterContext["persistentState"],
        }
  ) as SourceAdapterContext;
}

void test("incremental sync state schema and helpers", async (t) => {
  await t.test(
    "loadIncrementalSyncState returns empty state when store returns undefined",
    async () => {
      const context = createMockContext({
        async load() {
          return undefined;
        },
        async save() {},
      });
      const state = await loadIncrementalSyncState(context);
      assert.deepEqual(state, { version: 1, scopes: {} });
    },
  );

  await t.test(
    "loadIncrementalSyncState throws when persistentState is undefined",
    async () => {
      const context = createMockContext(undefined);
      await assert.rejects(
        async () => loadIncrementalSyncState(context),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "source_adapter_state_unavailable");
          return true;
        },
      );
    },
  );

  await t.test(
    "loadIncrementalSyncState throws when load() throws",
    async () => {
      const context = createMockContext({
        async load() {
          throw new Error("network disk error");
        },
        async save() {},
      });
      await assert.rejects(
        async () => loadIncrementalSyncState(context),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "source_adapter_state_unavailable");
          return true;
        },
      );
    },
  );

  await t.test(
    "loadIncrementalSyncState throws when stored JSON fails schema validation",
    async () => {
      const context = createMockContext({
        async load() {
          return { version: 999, invalidField: true };
        },
        async save() {},
      });
      await assert.rejects(
        async () => loadIncrementalSyncState(context),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "source_adapter_state_unavailable");
          return true;
        },
      );
    },
  );

  await t.test(
    "loadIncrementalSyncState and saveIncrementalSyncState round-trip valid state",
    async () => {
      let savedData: unknown;
      const context = createMockContext({
        async load() {
          return savedData;
        },
        async save(state) {
          savedData = state;
        },
      });

      const state = createEmptyIncrementalSyncState();
      initializeIncrementalScope(state, "feed-1", {
        scopeUrl: "https://example.com/feed.xml",
        initializedAt: "2026-11-07T00:00:00Z",
        etag: '"v1"',
        entries: {
          "item-1": {
            fingerprint: "hash123",
            updatedAt: "2026-11-07T00:00:00Z",
            archivedCompleteness: "baseline",
          },
        },
      });

      await saveIncrementalSyncState(context, state);
      const loaded = await loadIncrementalSyncState(context);
      assert.deepEqual(loaded, state);
    },
  );

  await t.test(
    "saveIncrementalSyncState throws when save() throws",
    async () => {
      const context = createMockContext({
        async load() {
          return undefined;
        },
        async save() {
          throw new Error("write failure");
        },
      });
      const state = createEmptyIncrementalSyncState();
      await assert.rejects(
        async () => saveIncrementalSyncState(context, state),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "source_adapter_state_unavailable");
          return true;
        },
      );
    },
  );

  await t.test(
    "isIncrementalScopeInitialized validates scope existence and url match",
    () => {
      const state: IncrementalSyncState = {
        version: 1,
        scopes: {
          "feed-1": {
            scopeUrl: "https://example.com/feed.xml",
            initializedAt: "2026-11-07T00:00:00Z",
            entries: {},
          },
        },
      };
      assert.equal(isIncrementalScopeInitialized(state, "feed-1"), true);
      assert.equal(
        isIncrementalScopeInitialized(
          state,
          "feed-1",
          "https://example.com/feed.xml",
        ),
        true,
      );
      assert.equal(
        isIncrementalScopeInitialized(
          state,
          "feed-1",
          "https://example.com/different.xml",
        ),
        false,
      );
      assert.equal(
        isIncrementalScopeInitialized(state, "feed-nonexistent"),
        false,
      );
    },
  );

  await t.test(
    "hasIncrementalEntryChanged checks fingerprint and updatedAt changes",
    () => {
      assert.equal(
        hasIncrementalEntryChanged(undefined, "fp-1"),
        true,
        "undefined previous entry is changed/new",
      );
      assert.equal(
        hasIncrementalEntryChanged(
          { fingerprint: "fp-1", updatedAt: "2026-11-07T00:00:00Z" },
          "fp-1",
          "2026-11-07T00:00:00Z",
        ),
        false,
        "same fingerprint and same updatedAt is unchanged",
      );
      assert.equal(
        hasIncrementalEntryChanged(
          { fingerprint: "fp-1", updatedAt: "2026-11-07T00:00:00Z" },
          "fp-2",
          "2026-11-07T00:00:00Z",
        ),
        true,
        "different fingerprint is changed",
      );
      assert.equal(
        hasIncrementalEntryChanged(
          { fingerprint: "fp-1", updatedAt: "2026-11-07T00:00:00Z" },
          "fp-1",
          "2026-11-07T01:00:00Z",
        ),
        true,
        "different updatedAt is changed",
      );
    },
  );

  await t.test(
    "upsertIncrementalScopeEntry and updateIncrementalScopeValidators update scope",
    () => {
      const state = createEmptyIncrementalSyncState();
      upsertIncrementalScopeEntry(state, "feed-1", "entry-1", {
        fingerprint: "hash1",
        archivedCompleteness: "complete",
      });
      assert.equal(
        state.scopes["feed-1"]?.entries["entry-1"]?.fingerprint,
        "hash1",
      );

      updateIncrementalScopeValidators(state, "feed-1", {
        etag: '"etag-1"',
        lastModified: "Wed, 07 Nov 2026 00:00:00 GMT",
        scopeUrl: "https://example.com/rss",
      });
      assert.equal(state.scopes["feed-1"]?.etag, '"etag-1"');
      assert.equal(
        state.scopes["feed-1"]?.lastModified,
        "Wed, 07 Nov 2026 00:00:00 GMT",
      );
      assert.equal(state.scopes["feed-1"]?.scopeUrl, "https://example.com/rss");

      updateIncrementalScopeValidators(state, "feed-1", {
        etag: undefined,
      });
      assert.equal(state.scopes["feed-1"]?.etag, undefined);

      upsertIncrementalScopeOngoingDocument(state, "feed-1", "doc-1", {
        contentHash: "doc-hash-1",
        updatedAt: "2026-11-07T00:00:00Z",
      });
      assert.equal(
        state.scopes["feed-1"]?.ongoingDocuments?.["doc-1"]?.contentHash,
        "doc-hash-1",
      );
    },
  );

  await t.test(
    "ongoing-document baseline initialization, change detection, and pruning",
    () => {
      const hash1 = computeOngoingDocumentHash(
        "# Heading\n\nContent",
        "Content",
      );
      const hash1Copy = computeOngoingDocumentHash(
        "# Heading\n\nContent",
        "Content",
      );
      const hash2 = computeOngoingDocumentHash(
        "# Heading\n\nModified",
        "Modified",
      );

      assert.equal(hash1, hash1Copy, "hash calculation must be deterministic");
      assert.notEqual(
        hash1,
        hash2,
        "different content produces different hash",
      );

      const state = createEmptyIncrementalSyncState();
      initializeIncrementalScope(state, "scope-changelog", {
        scopeUrl: "https://example.com/changelog.md",
        initializedAt: "2026-11-07T00:00:00Z",
        ongoingDocuments: {
          "doc-main": {
            contentHash: hash1,
            updatedAt: "2026-11-07T00:00:00Z",
          },
        },
      });

      const retrieved = getIncrementalScopeOngoingDocument(
        state,
        "scope-changelog",
        "doc-main",
      );
      assert.ok(retrieved !== undefined);
      assert.equal(retrieved.contentHash, hash1);

      assert.equal(
        getIncrementalScopeOngoingDocument(state, "scope-changelog", "unknown"),
        undefined,
      );
      assert.equal(
        getIncrementalScopeOngoingDocument(state, "unknown-scope", "doc-main"),
        undefined,
      );

      assert.equal(
        hasOngoingDocumentChanged(undefined, hash1),
        true,
        "undefined previous record indicates change",
      );
      assert.equal(
        hasOngoingDocumentChanged(retrieved, hash1),
        false,
        "matching content hash indicates no change",
      );
      assert.equal(
        hasOngoingDocumentChanged(retrieved, hash2),
        true,
        "different content hash indicates change",
      );

      upsertIncrementalScopeOngoingDocument(
        state,
        "scope-changelog",
        "doc-event",
        {
          contentHash: "event-hash",
        },
      );
      upsertIncrementalScopeOngoingDocument(
        state,
        "scope-changelog",
        "doc-old",
        {
          contentHash: "old-hash",
        },
      );

      const removed = pruneInactiveOngoingDocuments(state, "scope-changelog", [
        "doc-main",
        "doc-event",
      ]);
      assert.deepEqual(
        removed,
        ["doc-old"],
        "inactive document key must be pruned and returned",
      );
      assert.equal(
        getIncrementalScopeOngoingDocument(state, "scope-changelog", "doc-old"),
        undefined,
      );
      assert.ok(
        getIncrementalScopeOngoingDocument(
          state,
          "scope-changelog",
          "doc-main",
        ) !== undefined,
      );

      const emptyPrune = pruneInactiveOngoingDocuments(
        state,
        "non-existent-scope",
        ["doc-main"],
      );
      assert.deepEqual(
        emptyPrune,
        [],
        "pruning non-existent scope returns empty list",
      );
    },
  );

  await t.test(
    "legacy version 1 state without articleUrl, archivedFingerprint, or bodyGap loads cleanly",
    async () => {
      const legacyState = {
        version: 1,
        scopes: {
          "google-ai": {
            scopeUrl: "https://example.com/feed.xml",
            initializedAt: "2026-11-01T00:00:00Z",
            etag: '"legacy-v1"',
            entries: {
              "urn:legacy:baseline": {
                fingerprint: "fp-base",
                publishedAt: "Mon, 01 Nov 2026 00:00:00 GMT",
                archivedCompleteness: "baseline",
              },
              "urn:legacy:archived": {
                fingerprint: "fp-arch",
                updatedAt: "2026-11-02T00:00:00Z",
                archivedCompleteness: "complete",
              },
            },
          },
        },
      };

      const context = createMockContext({
        async load() {
          return legacyState;
        },
        async save() {},
      });

      const loaded = await loadIncrementalSyncState(context);
      assert.deepEqual(loaded, legacyState);
      assert.equal(incrementalSyncStateSchema.safeParse(loaded).success, true);
    },
  );

  await t.test(
    "recordIncrementalBodyGapEntry separates observed index from archive status and recordIncrementalArchivedEntry clears bodyGap",
    () => {
      const baseline = recordIncrementalBaselineEntry({
        fingerprint: "fp-b-v1",
        publishedAt: "Mon, 02 Nov 2026 08:00:00 GMT",
        articleUrl: "https://example.com/b",
      });
      assert.equal(baseline.archivedCompleteness, "baseline");
      assert.equal(baseline.articleUrl, "https://example.com/b");
      assert.equal(baseline.bodyGap, undefined);

      // First-time discovery failure: never archived
      const firstGap = recordIncrementalBodyGapEntry(undefined, {
        fingerprint: "fp-b-v2",
        publishedAt: "Tue, 03 Nov 2026 09:00:00 GMT",
        articleUrl: "https://example.com/b",
        gap: {
          url: "https://example.com/b",
          stage: "fetching-article",
          code: "article_http_error",
          reason: "Article HTTP request returned status 503.",
          httpStatus: 503,
        },
      });
      assert.equal(firstGap.fingerprint, "fp-b-v2");
      assert.equal(firstGap.archivedCompleteness, undefined);
      assert.equal(firstGap.archivedFingerprint, undefined);
      assert.equal(firstGap.bodyGap?.httpStatus, 503);
      assert.equal(
        hasIncrementalEntryChanged(firstGap, "fp-b-v2"),
        false,
        "unchanged index fingerprint skips re-fetch despite bodyGap",
      );
      assert.equal(
        hasIncrementalEntryChanged(firstGap, "fp-b-v3"),
        true,
        "updated index fingerprint triggers retry",
      );

      // Baseline entry failing on subsequent feed change must not pretend to be archived
      const baselineGap = recordIncrementalBodyGapEntry(baseline, {
        fingerprint: "fp-b-v2",
        articleUrl: "https://example.com/b",
        gap: {
          url: "https://example.com/b",
          stage: "extracting-article",
          code: "article_content_empty",
          reason: "Article page yielded no extractable article body.",
        },
      });
      assert.equal(baselineGap.archivedCompleteness, undefined);
      assert.equal(baselineGap.archivedFingerprint, undefined);
      assert.equal(baselineGap.bodyGap?.code, "article_content_empty");

      // Explicit backfill using existing entry fingerprint clears bodyGap
      const backfilled = recordIncrementalArchivedEntry(firstGap, {
        completeness: "complete",
      });
      assert.equal(backfilled.fingerprint, "fp-b-v2");
      assert.equal(backfilled.archivedFingerprint, "fp-b-v2");
      assert.equal(backfilled.archivedCompleteness, "complete");
      assert.equal(backfilled.articleUrl, "https://example.com/b");
      assert.equal(backfilled.bodyGap, undefined);

      // Previously archived legacy entry (without archivedFingerprint) failing on a new feed version preserves prior archived state
      const legacyArchived = {
        fingerprint: "fp-c-v1",
        publishedAt: "Mon, 02 Nov 2026 08:00:00 GMT",
        archivedCompleteness: "complete" as const,
      };
      const updatedVersionGap = recordIncrementalBodyGapEntry(legacyArchived, {
        fingerprint: "fp-c-v2",
        articleUrl: "https://example.com/c",
        gap: {
          url: "https://example.com/c",
          stage: "fetching-article",
          code: "article_fetch_failed",
          reason: "Request timed out after 20000ms.",
          abortCause: "source_request_timeout",
        },
      });
      assert.equal(updatedVersionGap.fingerprint, "fp-c-v2");
      assert.equal(updatedVersionGap.archivedCompleteness, "complete");
      assert.equal(updatedVersionGap.archivedFingerprint, "fp-c-v1");
      assert.equal(
        updatedVersionGap.bodyGap?.abortCause,
        "source_request_timeout",
      );

      // Subsequent successful archive updates archivedFingerprint and clears bodyGap
      const recovered = recordIncrementalArchivedEntry(updatedVersionGap, {
        fingerprint: "fp-c-v2",
        articleUrl: "https://example.com/c",
        completeness: "partial",
      });
      assert.equal(recovered.fingerprint, "fp-c-v2");
      assert.equal(recovered.archivedFingerprint, "fp-c-v2");
      assert.equal(recovered.archivedCompleteness, "partial");
      assert.equal(recovered.bodyGap, undefined);
    },
  );

  await t.test(
    "feedSyncOutputSchema validates complete and partial sync outputs",
    () => {
      const partial = feedSyncOutputSchema.parse({
        collectionCompleteness: "partial",
        completedScopes: [],
        incompleteScopes: [
          {
            scope: "google-ai",
            reasonCode: "article_body_unavailable",
            message:
              "1 of 3 changed feed items had unavailable article body; 2 items were archived.",
          },
        ],
        bodyGaps: [
          {
            scope: "google-ai",
            itemKey: "urn:google:b",
            url: "https://example.com/b",
            stage: "fetching-article",
            code: "article_http_error",
            reason: "Article HTTP request returned status 503.",
            httpStatus: 503,
          },
        ],
      });
      assert.equal(partial.collectionCompleteness, "partial");
      assert.equal(partial.bodyGaps?.length, 1);

      const complete = feedSyncOutputSchema.parse({
        collectionCompleteness: "complete",
        completedScopes: ["blog"],
        initializedScopes: ["blog"],
      });
      assert.equal(complete.collectionCompleteness, "complete");
    },
  );
});
