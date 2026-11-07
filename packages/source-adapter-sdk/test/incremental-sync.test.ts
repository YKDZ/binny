import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyIncrementalSyncState,
  hasIncrementalEntryChanged,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  isSourceAdapterActionError,
  loadIncrementalSyncState,
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
});
