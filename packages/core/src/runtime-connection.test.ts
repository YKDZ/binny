import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  binConfigurations,
  manualRuns,
  runtimeConnections,
  type Database,
} from "@binny/db";

import type { BrowserCapacityCoordinator } from "./browser-capacity.ts";
import { createRuntimeConnectionStore } from "./runtime-connection.ts";

type MockBin = {
  id: string;
  sourceAdapter: unknown;
  config: unknown;
  status: "active" | "disabled";
  persistentState: unknown;
  sourceAccessState: unknown;
  lastIssuedOwnerGeneration: string;
};

type MockConnection = {
  binId: string;
  runtimeId: string;
  ownerGeneration: bigint;
  runtimeControlUrl: string;
  disconnected: boolean;
  lastHeartbeatAt: Date;
  sourceStateSnapshot?: unknown;
};

function createMockDatabase(options: {
  initialBin?: MockBin | undefined;
  initialConnection?: MockConnection | undefined;
}) {
  let bin = options.initialBin ? { ...options.initialBin } : undefined;
  let connection = options.initialConnection
    ? { ...options.initialConnection }
    : undefined;

  function executeQuery(table: unknown) {
    if (table === binConfigurations) {
      return bin ? [{ ...bin }] : [];
    }
    if (table === runtimeConnections) {
      return connection ? [{ ...connection }] : [];
    }
    if (table === manualRuns) {
      return [];
    }
    return [];
  }

  function createSelectBuilder(table: unknown) {
    function createResultPromise() {
      const promise = Promise.resolve(executeQuery(table));
      return Object.assign(promise, {
        for(_mode: string) {
          return Promise.resolve(executeQuery(table));
        },
      });
    }

    return {
      where(_clause: unknown) {
        return createResultPromise();
      },
      for(_mode: string) {
        return Promise.resolve(executeQuery(table));
      },
    };
  }

  function createUpdateBuilder(table: unknown) {
    return {
      set(values: Record<string, unknown>) {
        return {
          where(_clause: unknown) {
            if (table === binConfigurations && bin !== undefined) {
              if ("persistentState" in values) {
                bin.persistentState = values.persistentState;
              }
              if ("sourceAccessState" in values) {
                bin.sourceAccessState = values.sourceAccessState;
              }
              if ("lastIssuedOwnerGeneration" in values) {
                bin.lastIssuedOwnerGeneration = String(
                  values.lastIssuedOwnerGeneration,
                );
              }
            }
            if (table === runtimeConnections && connection !== undefined) {
              if ("sourceStateSnapshot" in values) {
                connection.sourceStateSnapshot = values.sourceStateSnapshot;
              }
            }
            return Promise.resolve();
          },
        };
      },
    };
  }

  const transaction = {
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          return createSelectBuilder(table);
        },
      };
    },
    update(table: unknown) {
      return createUpdateBuilder(table);
    },
  };

  const database = {
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          return createSelectBuilder(table);
        },
      };
    },
    update(table: unknown) {
      return createUpdateBuilder(table);
    },
    async transaction<T>(
      callback: (tx: typeof transaction) => Promise<T>,
    ): Promise<T> {
      return await callback(transaction);
    },
  };

  return {
    database: database as unknown as Database,
    getBin: () => bin,
    getConnection: () => connection,
    setConnection: (conn?: MockConnection) => {
      connection = conn;
    },
  };
}

const mockBrowserCapacity = {} as unknown as BrowserCapacityCoordinator;

const mockSourceAdapter = {
  id: "test.adapter",
  version: "1.0.0",
  configSchema: { type: "object" },
  extensionsSchema: { type: "object", additionalProperties: false },
  actions: {
    check: {
      description: "check",
      params: { type: "object" },
      output: { type: "object" },
    },
    collect: {
      description: "collect",
      params: { type: "object" },
      output: { type: "object" },
    },
  },
  environment: {
    browser: {
      required: false,
      profileReuseAfterRestart: false,
    },
  },
};

void describe("runtime connection state endpoints", () => {
  void it("accepts newly claimed ownerGeneration before first heartbeat and rejects stale generations", async () => {
    const mock = createMockDatabase({
      initialBin: {
        id: "bin-1",
        sourceAdapter: mockSourceAdapter,
        config: {},
        status: "active",
        persistentState: { syncCursor: "cursor-initial" },
        sourceAccessState: { lease: "active", budgetRemaining: 100 },
        lastIssuedOwnerGeneration: "0",
      },
      initialConnection: undefined,
    });

    const store = createRuntimeConnectionStore(
      mock.database,
      mockBrowserCapacity,
    );

    // 1. Claim ownership initially without any prior connection.
    const claimResult = await store.claimOwnership("bin-1", {
      runtimeId: "runtime-1",
      runtimeControlUrl: "http://127.0.0.1:8080",
      sourceAdapter: mockSourceAdapter,
    });
    assert.equal(claimResult.ok, true);
    if (!claimResult.ok) return;
    assert.equal(claimResult.value.ownerGeneration, "1");

    // Before heartbeat, runtimeConnections row is still absent.
    assert.equal(mock.getConnection(), undefined);

    // 2. getState immediately after claimOwnership succeeds with newly claimed generation.
    const getStateResult = await store.getState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "1",
    });
    assert.equal(getStateResult.ok, true);
    if (!getStateResult.ok) return;
    assert.deepEqual(getStateResult.value.persistentState, {
      syncCursor: "cursor-initial",
    });
    assert.deepEqual(getStateResult.value.sourceAccess, {
      lease: "active",
      budgetRemaining: 100,
    });

    // 3. putState immediately after claimOwnership succeeds with newly claimed generation.
    const putStateResult = await store.putState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "1",
      persistentState: { syncCursor: "cursor-updated" },
      sourceAccess: { lease: "active", budgetRemaining: 80 },
    });
    assert.equal(putStateResult.ok, true);

    // Verify getState sees the newly updated state.
    const getUpdatedResult = await store.getState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "1",
    });
    assert.equal(getUpdatedResult.ok, true);
    if (!getUpdatedResult.ok) return;
    assert.deepEqual(getUpdatedResult.value.persistentState, {
      syncCursor: "cursor-updated",
    });

    // 4. Stale generation ("0") is rejected by both getState and putState.
    const staleGetResult = await store.getState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "0",
    });
    assert.equal(staleGetResult.ok, false);
    if (!staleGetResult.ok) {
      assert.equal(staleGetResult.status, 409);
      assert.equal(staleGetResult.error.code, "runtime_owner_mismatch");
    }

    const stalePutResult = await store.putState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "0",
      persistentState: { syncCursor: "stale-overwrite" },
    });
    assert.equal(stalePutResult.ok, false);
    if (!stalePutResult.ok) {
      assert.equal(stalePutResult.status, 409);
      assert.equal(stalePutResult.error.code, "runtime_owner_mismatch");
    }

    // 5. Unclaimed non-matching generation ("99") is rejected.
    const nonMatchingGetResult = await store.getState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "99",
    });
    assert.equal(nonMatchingGetResult.ok, false);
    if (!nonMatchingGetResult.ok) {
      assert.equal(nonMatchingGetResult.status, 409);
      assert.equal(nonMatchingGetResult.error.code, "runtime_owner_mismatch");
    }

    const nonMatchingPutResult = await store.putState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "99",
      persistentState: { syncCursor: "unclaimed-overwrite" },
    });
    assert.equal(nonMatchingPutResult.ok, false);
    if (!nonMatchingPutResult.ok) {
      assert.equal(nonMatchingPutResult.status, 409);
      assert.equal(nonMatchingPutResult.error.code, "runtime_owner_mismatch");
    }
  });

  void it("accepts newly claimed ownerGeneration when replacing a disconnected previous owner before heartbeat", async () => {
    const mock = createMockDatabase({
      initialBin: {
        id: "bin-1",
        sourceAdapter: mockSourceAdapter,
        config: {},
        status: "active",
        persistentState: { syncCursor: "cursor-1" },
        sourceAccessState: { lease: "active" },
        lastIssuedOwnerGeneration: "1",
      },
      initialConnection: {
        binId: "bin-1",
        runtimeId: "runtime-1",
        ownerGeneration: 1n,
        runtimeControlUrl: "http://127.0.0.1:8080",
        disconnected: true,
        lastHeartbeatAt: new Date(0),
      },
    });

    const store = createRuntimeConnectionStore(
      mock.database,
      mockBrowserCapacity,
    );

    // New runtime claims ownership over the disconnected old runtime.
    const claimResult = await store.claimOwnership("bin-1", {
      runtimeId: "runtime-2",
      runtimeControlUrl: "http://127.0.0.1:8081",
      sourceAdapter: mockSourceAdapter,
    });
    assert.equal(claimResult.ok, true);
    if (!claimResult.ok) return;
    assert.equal(claimResult.value.ownerGeneration, "2");

    // Before heartbeat, runtime-2 can read and write state with generation 2.
    const getResult = await store.getState("bin-1", {
      runtimeId: "runtime-2",
      ownerGeneration: "2",
    });
    assert.equal(getResult.ok, true);

    const putResult = await store.putState("bin-1", {
      runtimeId: "runtime-2",
      ownerGeneration: "2",
      persistentState: { syncCursor: "cursor-2" },
    });
    assert.equal(putResult.ok, true);

    // Old runtime with generation 1 is rejected with runtime_owner_mismatch.
    const oldGetResult = await store.getState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "1",
    });
    assert.equal(oldGetResult.ok, false);
    if (!oldGetResult.ok) {
      assert.equal(oldGetResult.status, 409);
      assert.equal(oldGetResult.error.code, "runtime_owner_mismatch");
    }

    const oldPutResult = await store.putState("bin-1", {
      runtimeId: "runtime-1",
      ownerGeneration: "1",
      persistentState: { syncCursor: "old-cursor" },
    });
    assert.equal(oldPutResult.ok, false);
    if (!oldPutResult.ok) {
      assert.equal(oldPutResult.status, 409);
      assert.equal(oldPutResult.error.code, "runtime_owner_mismatch");
    }
  });
});
