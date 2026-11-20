import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runtimeProtocolVersion } from "@binny/contracts";
import {
  binConfigurations,
  humanSessions,
  manualRuns,
  runtimeConnections,
  runtimeContainers,
  schedules,
  type Database,
} from "@binny/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  createRuntimeContainerCoordinator,
  type ManagedContainerInspectResult,
  type RuntimeContainerDriver,
} from "./runtime-container.ts";

const lightweightAdapter = {
  id: "rss-atom",
  version: "1.0.0",
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  extensionsSchema: { type: "object", additionalProperties: false },
  actions: {
    check: {
      description: "check",
      params: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object" },
    },
    collect: {
      description: "collect",
      params: { type: "object", properties: {}, additionalProperties: false },
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

type BinRow = {
  id: string;
  sourceAdapter: unknown;
  identityId: string;
  config: Record<string, unknown>;
  configNativeValid: boolean;
  browserIdleTimeoutSeconds: number | null;
  runtimeSleepIdleTimeoutSeconds: number | null;
  status: "active" | "disabled";
  persistentState: unknown;
  sourceAccessState: unknown;
  lastIssuedOwnerGeneration: string;
  createdAt: Date;
  updatedAt: Date;
};

type ConnectionRow = {
  binId: string;
  runtimeId: string;
  sourceAdapter: unknown;
  environment: unknown;
  sourceStateSnapshot: unknown;
  lastHeartbeatAt: Date;
  disconnected: boolean;
  protocolVersion: number;
  runtimeControlUrl: string | null;
  ownerState: "confirmed" | "unconfirmed";
  ownerGeneration: bigint;
};

type ContainerRow = {
  binId: string;
  composeProject: string;
  composeService: string;
  containerId: string;
  lifecyclePhase: "running" | "waking" | "stopping" | "sleeping" | "offline";
  containerStartedAt: string | null;
  stoppedContainerFinishedAt: string | null;
  idleSince: Date | null;
  lastWakeError: unknown;
  updatedAt: Date;
};

type RunRow = {
  runId: string;
  binId: string;
  status:
    | "queued"
    | "executing"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
  stopConfirmedAt: Date | null;
  failure: unknown;
};

type HumanSessionRow = {
  sessionId: string;
  binId: string;
  status: "pending" | "opening" | "ready" | "closing" | "closed" | "failed";
};

const dialect = new PgDialect();

function compileWhere(clause: unknown): {
  readonly sql: string;
  readonly params: readonly unknown[];
} {
  if (clause === undefined) return { sql: "", params: [] };
  return dialect.sqlToQuery(clause as SQL);
}

function createFakeDriver(initial: readonly ManagedContainerInspectResult[]) {
  const containers = new Map(
    initial.map((entry) => [entry.containerId, { ...entry }]),
  );
  const startCalls: string[] = [];
  const stopCalls: string[] = [];
  let onStop:
    | ((container: ManagedContainerInspectResult) => Promise<void> | void)
    | undefined;
  let onStart:
    | ((container: ManagedContainerInspectResult) => Promise<void> | void)
    | undefined;

  const driver: RuntimeContainerDriver = {
    async discoverManagedContainers() {
      return [...containers.values()].map((entry) => ({ ...entry }));
    },
    async inspectContainer(containerId) {
      const entry = containers.get(containerId);
      return entry === undefined ? null : { ...entry };
    },
    async startContainer(containerId) {
      startCalls.push(containerId);
      const entry = containers.get(containerId);
      if (entry === undefined) return "not_found";
      if (entry.status === "running") return "already_running";
      const updated: ManagedContainerInspectResult = {
        ...entry,
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      containers.set(containerId, updated);
      await onStart?.(updated);
      return "started";
    },
    async stopContainer(containerId) {
      stopCalls.push(containerId);
      const entry = containers.get(containerId);
      if (entry === undefined) return "not_found";
      if (entry.status === "exited") return "already_stopped";
      await onStop?.(entry);
      const latest = containers.get(containerId);
      if (latest === undefined) return "not_found";
      if (latest.status === "exited") return "stopped";
      containers.set(containerId, {
        ...latest,
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        finishedAt: new Date().toISOString(),
      });
      return "stopped";
    },
  };

  return {
    driver,
    containers,
    startCalls,
    stopCalls,
    setOnStop(
      handler:
        | ((container: ManagedContainerInspectResult) => Promise<void> | void)
        | undefined,
    ) {
      onStop = handler;
    },
    setOnStart(
      handler:
        | ((container: ManagedContainerInspectResult) => Promise<void> | void)
        | undefined,
    ) {
      onStart = handler;
    },
  };
}

function createFakeDatabase(initial: {
  bins?: BinRow[];
  connections?: ConnectionRow[];
  containers?: ContainerRow[];
  runs?: RunRow[];
  humanSessions?: HumanSessionRow[];
}) {
  const bins = new Map((initial.bins ?? []).map((b) => [b.id, { ...b }]));
  const connections = new Map(
    (initial.connections ?? []).map((c) => [c.binId, { ...c }]),
  );
  const containers = new Map(
    (initial.containers ?? []).map((c) => [c.binId, { ...c }]),
  );
  const runs = new Map((initial.runs ?? []).map((r) => [r.runId, { ...r }]));
  const sessions = new Map(
    (initial.humanSessions ?? []).map((s) => [s.sessionId, { ...s }]),
  );
  const scheduleRows = new Map<string, Record<string, unknown>>();

  function findBinId(params: readonly unknown[]): string | undefined {
    for (const param of params) {
      if (typeof param === "string" && bins.has(param)) return param;
    }
    return undefined;
  }

  function executeSelect(table: unknown, clause: unknown): unknown[] {
    const compiled = compileWhere(clause);
    if (table === binConfigurations) {
      const binId = findBinId(compiled.params);
      if (binId !== undefined) {
        const bin = bins.get(binId);
        return bin === undefined ? [] : [{ ...bin }];
      }
      return [...bins.values()].map((b) => ({ ...b }));
    }
    if (table === runtimeConnections) {
      const binId = findBinId(compiled.params);
      if (binId !== undefined) {
        const conn = connections.get(binId);
        return conn === undefined ? [] : [{ ...conn }];
      }
      return [...connections.values()].map((c) => ({ ...c }));
    }
    if (table === runtimeContainers) {
      const binId = findBinId(compiled.params);
      if (binId !== undefined) {
        const row = containers.get(binId);
        return row === undefined ? [] : [{ ...row }];
      }
      return [...containers.values()].map((c) => ({ ...c }));
    }
    if (table === manualRuns) {
      const binId = findBinId(compiled.params);
      let rows = [...runs.values()];
      if (binId !== undefined) rows = rows.filter((r) => r.binId === binId);
      if (
        compiled.sql.includes("status") &&
        compiled.params.includes("queued")
      ) {
        rows = rows.filter((r) =>
          ["queued", "executing", "cancelling"].includes(r.status),
        );
      } else if (
        compiled.sql.includes("stop_confirmed_at") &&
        compiled.sql.includes("is null")
      ) {
        rows = rows.filter(
          (r) =>
            r.status === "failed" &&
            r.stopConfirmedAt === null &&
            typeof r.failure === "object" &&
            r.failure !== null &&
            (r.failure as { code?: string }).code === "runtime_interrupted",
        );
      }
      return rows.map((r) => ({ ...r }));
    }
    if (table === humanSessions) {
      const binId = findBinId(compiled.params);
      let rows = [...sessions.values()];
      if (binId !== undefined) rows = rows.filter((s) => s.binId === binId);
      rows = rows.filter((s) =>
        ["pending", "opening", "ready", "closing"].includes(s.status),
      );
      return rows.map((s) => ({ ...s }));
    }
    if (table === schedules) {
      return [...scheduleRows.values()];
    }
    return [];
  }

  function createSelectBuilder(table: unknown) {
    let whereClause: unknown;
    const builder = Object.assign(
      Promise.resolve().then(() => executeSelect(table, whereClause)),
      {
        leftJoin(_other: unknown, _on: unknown) {
          return builder;
        },
        where(clause: unknown) {
          whereClause = clause;
          return builder;
        },
        orderBy(..._cols: unknown[]) {
          return builder;
        },
        limit(_count: number) {
          return builder;
        },
        for(_mode: string) {
          return Promise.resolve().then(() =>
            executeSelect(table, whereClause),
          );
        },
      },
    );
    return builder;
  }

  function resolveValue(value: unknown): unknown {
    if (typeof value === "object" && value !== null && "queryChunks" in value) {
      return new Date();
    }
    return value;
  }

  function createInsertBuilder(table: unknown) {
    return {
      values(values: Record<string, unknown>) {
        const applyInsert = (
          conflictMode: "error" | "update" | "nothing",
          setValues?: Record<string, unknown>,
        ) => {
          if (table === runtimeContainers) {
            const binId = String(values.binId);
            const existing = containers.get(binId);
            if (
              existing !== undefined &&
              conflictMode === "update" &&
              setValues
            ) {
              const next = { ...existing };
              for (const [k, v] of Object.entries(setValues)) {
                (next as Record<string, unknown>)[k] = resolveValue(v);
              }
              containers.set(binId, next);
              return [next];
            }
            const created: ContainerRow = {
              binId,
              composeProject: String(values.composeProject),
              composeService: String(values.composeService),
              containerId: String(values.containerId),
              lifecyclePhase:
                values.lifecyclePhase as ContainerRow["lifecyclePhase"],
              containerStartedAt:
                (values.containerStartedAt as string | null) ?? null,
              stoppedContainerFinishedAt:
                (values.stoppedContainerFinishedAt as string | null) ?? null,
              idleSince:
                (resolveValue(values.idleSince) as Date | null) ?? null,
              lastWakeError: values.lastWakeError ?? null,
              updatedAt: new Date(),
            };
            containers.set(binId, created);
            return [created];
          }
          return [];
        };

        const result = Object.assign(
          Promise.resolve().then(() => applyInsert("error")),
          {
            onConflictDoUpdate(opts: { set: Record<string, unknown> }) {
              const rows = applyInsert("update", opts.set);
              return Object.assign(Promise.resolve(rows), {
                returning() {
                  return Promise.resolve(rows);
                },
              });
            },
            onConflictDoNothing() {
              const rows = applyInsert("nothing");
              return Object.assign(Promise.resolve(rows), {
                returning() {
                  return Promise.resolve(rows);
                },
              });
            },
            returning() {
              return Promise.resolve(applyInsert("error"));
            },
          },
        );
        return result;
      },
    };
  }

  function createUpdateBuilder(table: unknown) {
    return {
      set(values: Record<string, unknown>) {
        return {
          where(clause: unknown) {
            const compiled = compileWhere(clause);
            const binId = findBinId(compiled.params);
            const applyUpdate = () => {
              if (table === runtimeContainers && binId !== undefined) {
                const row = containers.get(binId);
                if (row !== undefined) {
                  for (const [k, v] of Object.entries(values)) {
                    (row as Record<string, unknown>)[k] = resolveValue(v);
                  }
                  return [{ ...row }];
                }
              }
              if (table === runtimeConnections && binId !== undefined) {
                const row = connections.get(binId);
                if (row !== undefined) {
                  for (const [k, v] of Object.entries(values)) {
                    (row as Record<string, unknown>)[k] = resolveValue(v);
                  }
                  return [{ ...row }];
                }
              }
              if (table === binConfigurations && binId !== undefined) {
                const row = bins.get(binId);
                if (row !== undefined) {
                  for (const [k, v] of Object.entries(values)) {
                    (row as Record<string, unknown>)[k] = resolveValue(v);
                  }
                  return [{ ...row }];
                }
              }
              return [];
            };
            return Object.assign(Promise.resolve().then(applyUpdate), {
              returning() {
                return Promise.resolve().then(applyUpdate);
              },
            });
          },
        };
      },
    };
  }

  const executor: {
    select: (_fields?: unknown) => {
      from: (table: unknown) => ReturnType<typeof createSelectBuilder>;
    };
    insert: (table: unknown) => ReturnType<typeof createInsertBuilder>;
    update: (table: unknown) => ReturnType<typeof createUpdateBuilder>;
    transaction: <T>(cb: (tx: typeof executor) => Promise<T>) => Promise<T>;
  } = {
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          return createSelectBuilder(table);
        },
      };
    },
    insert(table: unknown) {
      return createInsertBuilder(table);
    },
    update(table: unknown) {
      return createUpdateBuilder(table);
    },
    async transaction<T>(cb: (tx: typeof executor) => Promise<T>): Promise<T> {
      return await cb(executor);
    },
  };

  return {
    database: executor as unknown as Database,
    bins,
    connections,
    containers,
    runs,
    sessions,
  };
}

function makeLightweightBin(
  binId: string,
  idleTimeoutSeconds: number | null = 300,
): BinRow {
  const now = new Date();
  return {
    id: binId,
    sourceAdapter: lightweightAdapter,
    identityId: binId,
    config: {},
    configNativeValid: true,
    browserIdleTimeoutSeconds: idleTimeoutSeconds,
    runtimeSleepIdleTimeoutSeconds: idleTimeoutSeconds,
    status: "active",
    persistentState: null,
    sourceAccessState: null,
    lastIssuedOwnerGeneration: "1",
    createdAt: now,
    updatedAt: now,
  };
}

function makeOnlineConnection(
  binId: string,
  runtimeId = "rt-1",
): ConnectionRow {
  return {
    binId,
    runtimeId,
    sourceAdapter: lightweightAdapter,
    environment: {
      kind: "lightweight",
      browser: {
        available: false,
        profileReuseAfterRestart: false,
        power: { status: "unavailable" },
      },
    },
    sourceStateSnapshot: null,
    lastHeartbeatAt: new Date(),
    disconnected: false,
    protocolVersion: runtimeProtocolVersion,
    runtimeControlUrl: `http://${binId}:8080`,
    ownerState: "confirmed",
    ownerGeneration: 1n,
  };
}

void describe("runtime container coordinator", () => {
  void it("sleeps an idle lightweight container when timeout is 0 without resetting idle time on heartbeats", async () => {
    let fakeNow = 1_000_000;
    const db = createFakeDatabase({
      bins: [makeLightweightBin("binny-rss-one", 0)],
      connections: [makeOnlineConnection("binny-rss-one")],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-rss-1",
        composeProject: "binny",
        composeService: "runtime-rss",
        binId: "binny-rss-one",
        status: "running",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: null,
        healthStatus: "none",
      },
    ]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      now: () => fakeNow,
    });

    try {
      await coordinator.onRuntimeHeartbeat({
        binId: "binny-rss-one",
        runtimeId: "rt-1",
        ownerState: "confirmed",
        executionStatus: "online",
        environment: {
          kind: "lightweight",
          browser: {
            available: false,
            profileReuseAfterRestart: false,
            power: { status: "unavailable" },
          },
        },
        idleTimeoutSeconds: 0,
      });

      // Wait briefly for the 0s idle stop to complete.
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(fakeDriver.stopCalls, ["cid-rss-1"]);
      assert.equal(fakeDriver.containers.get("cid-rss-1")?.status, "exited");
      assert.equal(
        db.containers.get("binny-rss-one")?.lifecyclePhase,
        "sleeping",
      );
      assert.equal(db.connections.get("binny-rss-one")?.disconnected, true);
    } finally {
      await coordinator.close();
    }
  });

  void it("does not reset idleSince on subsequent heartbeats and stops only after configured idle timeout", async () => {
    let fakeNow = 1_000_000;
    const db = createFakeDatabase({
      bins: [makeLightweightBin("binny-rss-one", 5)],
      connections: [makeOnlineConnection("binny-rss-one")],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-rss-1",
        composeProject: "binny",
        composeService: "runtime-rss",
        binId: "binny-rss-one",
        status: "running",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: null,
        healthStatus: "none",
      },
    ]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      now: () => fakeNow,
    });

    try {
      const env = {
        kind: "lightweight" as const,
        browser: {
          available: false,
          profileReuseAfterRestart: false,
          power: { status: "unavailable" as const },
        },
      };
      await coordinator.onRuntimeHeartbeat({
        binId: "binny-rss-one",
        runtimeId: "rt-1",
        ownerState: "confirmed",
        executionStatus: "online",
        environment: env,
        idleTimeoutSeconds: 5,
      });
      assert.equal(
        db.containers.get("binny-rss-one")?.idleSince?.getTime(),
        1_000_000,
      );

      // Heartbeat 3s later must NOT extend idleSince.
      fakeNow = 1_003_000;
      await coordinator.onRuntimeHeartbeat({
        binId: "binny-rss-one",
        runtimeId: "rt-1",
        ownerState: "confirmed",
        executionStatus: "online",
        environment: env,
        idleTimeoutSeconds: 5,
      });
      assert.equal(
        db.containers.get("binny-rss-one")?.idleSince?.getTime(),
        1_000_000,
      );
      await coordinator.sweepIdleContainers();
      assert.deepEqual(fakeDriver.stopCalls, []);

      // At t + 5s, sweep stops the container.
      fakeNow = 1_005_000;
      await coordinator.sweepIdleContainers();
      assert.deepEqual(fakeDriver.stopCalls, ["cid-rss-1"]);
      assert.equal(
        db.containers.get("binny-rss-one")?.lifecyclePhase,
        "sleeping",
      );
    } finally {
      await coordinator.close();
    }
  });

  void it("coalesces concurrent wake requests and hands off a request arriving while stopping", async () => {
    let fakeNow = 1_000_000;
    const db = createFakeDatabase({
      bins: [makeLightweightBin("binny-rss-one", 0)],
      connections: [makeOnlineConnection("binny-rss-one", "rt-1")],
      containers: [
        {
          binId: "binny-rss-one",
          composeProject: "binny",
          composeService: "runtime-rss",
          containerId: "cid-rss-1",
          lifecyclePhase: "running",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: new Date(1_000_000),
          lastWakeError: null,
          updatedAt: new Date(1_000_000),
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-rss-1",
        composeProject: "binny",
        composeService: "runtime-rss",
        binId: "binny-rss-one",
        status: "running",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: null,
        healthStatus: "none",
      },
    ]);

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopEnteredResolve!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      stopEnteredResolve = resolve;
    });

    fakeDriver.setOnStop(async () => {
      stopEnteredResolve();
      await stopGate;
    });

    let bootCount = 1;
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      now: () => fakeNow,
      wakeTimeoutMs: 5_000,
    });

    fakeDriver.setOnStart(async () => {
      bootCount += 1;
      const nextRuntimeId = `rt-${bootCount}`;
      const conn = db.connections.get("binny-rss-one")!;
      conn.runtimeId = nextRuntimeId;
      conn.disconnected = false;
      conn.ownerState = "confirmed";
      conn.ownerGeneration = BigInt(bootCount);
      await coordinator.onRuntimeHeartbeat({
        binId: "binny-rss-one",
        runtimeId: nextRuntimeId,
        ownerState: "confirmed",
        executionStatus: "online",
        environment: {
          kind: "lightweight",
          browser: {
            available: false,
            profileReuseAfterRestart: false,
            power: { status: "unavailable" },
          },
        },
        idleTimeoutSeconds: 0,
      });
    });

    try {
      // Trigger stop (will pause inside stopContainer at stopGate).
      const sweepPromise = coordinator.sweepIdleContainers();
      await stopEntered;
      assert.equal(
        db.containers.get("binny-rss-one")?.lifecyclePhase,
        "stopping",
      );

      // While stopping, 3 concurrent requests arrive: must wait for stop, then coalesce into 1 start!
      const workCalls: number[] = [];
      const r1 = coordinator.ensureAwakeAndRun("binny-rss-one", async () => {
        workCalls.push(1);
        return "one";
      });
      const r2 = coordinator.ensureAwakeAndRun("binny-rss-one", async () => {
        workCalls.push(2);
        return "two";
      });
      const r3 = coordinator.ensureAwakeAndRun("binny-rss-one", async () => {
        workCalls.push(3);
        return "three";
      });

      // Before stop completes, startContainer must not have been called yet.
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(fakeDriver.startCalls, []);

      // Release stop gate -> container stops cleanly -> coalesced wake starts it once -> all 3 succeed!
      fakeDriver.setOnStop(undefined);
      releaseStop();
      await sweepPromise;

      const results = await Promise.all([r1, r2, r3]);
      assert.deepEqual(
        results.map((r) => (r.ok ? r.value : r.code)),
        ["one", "two", "three"],
      );
      assert.equal(fakeDriver.startCalls.length, 1);
      assert.deepEqual(
        workCalls.toSorted((a, b) => a - b),
        [1, 2, 3],
      );
    } finally {
      await coordinator.close();
    }
  });

  void it("blocks idle stop while runs or human sessions are active and starts idle clock only after completion", async () => {
    const fakeNow = 2_000_000;
    const db = createFakeDatabase({
      bins: [makeLightweightBin("binny-rss-one", 0)],
      connections: [makeOnlineConnection("binny-rss-one", "rt-1")],
      runs: [
        {
          runId: "run-1",
          binId: "binny-rss-one",
          status: "executing",
          stopConfirmedAt: null,
          failure: null,
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-rss-1",
        composeProject: "binny",
        composeService: "runtime-rss",
        binId: "binny-rss-one",
        status: "running",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: null,
        healthStatus: "none",
      },
    ]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      now: () => fakeNow,
    });

    try {
      await coordinator.onRuntimeHeartbeat({
        binId: "binny-rss-one",
        runtimeId: "rt-1",
        ownerState: "confirmed",
        executionStatus: "online",
        environment: {
          kind: "lightweight",
          browser: {
            available: false,
            profileReuseAfterRestart: false,
            power: { status: "unavailable" },
          },
        },
        idleTimeoutSeconds: 0,
      });
      await coordinator.sweepIdleContainers();
      assert.deepEqual(fakeDriver.stopCalls, []);

      // Even after run completes, if an interrupted run lacks stopConfirmedAt, do not stop.
      const run = db.runs.get("run-1")!;
      run.status = "failed";
      run.failure = { code: "runtime_interrupted" };
      run.stopConfirmedAt = null;
      await coordinator.markWorkCompleted("binny-rss-one");
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(fakeDriver.stopCalls, []);

      // Once stopConfirmedAt is set, idle clock starts and stops the 0s container.
      run.status = "completed";
      run.stopConfirmedAt = new Date(fakeNow);
      await coordinator.markWorkCompleted("binny-rss-one");
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(fakeDriver.stopCalls, ["cid-rss-1"]);
    } finally {
      await coordinator.close();
    }
  });

  void it("reconciles server restarts: keeps policy-sleeping containers wakeable and marks manual/unexpected stops offline", async () => {
    const db = createFakeDatabase({
      bins: [
        makeLightweightBin("bin-sleep", 300),
        makeLightweightBin("bin-manual-stop", 300),
        makeLightweightBin("bin-crashed", 300),
        makeLightweightBin("bin-deleted", 300),
        makeLightweightBin("bin-replaced", 300),
      ],
      connections: [
        makeOnlineConnection("bin-sleep"),
        makeOnlineConnection("bin-manual-stop"),
        makeOnlineConnection("bin-crashed"),
        makeOnlineConnection("bin-deleted"),
        makeOnlineConnection("bin-replaced"),
      ],
      containers: [
        {
          binId: "bin-sleep",
          composeProject: "binny",
          composeService: "s-sleep",
          containerId: "cid-sleep",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-manual-stop",
          composeProject: "binny",
          composeService: "s-manual",
          containerId: "cid-manual",
          lifecyclePhase: "running",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: new Date(),
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-crashed",
          composeProject: "binny",
          composeService: "s-crashed",
          containerId: "cid-crashed",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-deleted",
          composeProject: "binny",
          composeService: "s-deleted",
          containerId: "cid-deleted",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-replaced",
          composeProject: "binny",
          composeService: "s-replaced",
          containerId: "cid-old",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-sleep",
        composeProject: "binny",
        composeService: "s-sleep",
        binId: "bin-sleep",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        healthStatus: "none",
      },
      {
        containerId: "cid-manual",
        composeProject: "binny",
        composeService: "s-manual",
        binId: "bin-manual-stop",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:06:00.000Z",
        healthStatus: "none",
      },
      {
        containerId: "cid-crashed",
        composeProject: "binny",
        composeService: "s-crashed",
        binId: "bin-crashed",
        status: "exited",
        exitCode: 137,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        healthStatus: "none",
      },
      {
        containerId: "cid-new",
        composeProject: "binny",
        composeService: "s-replaced",
        binId: "bin-replaced",
        status: "running",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:07:00.000Z",
        finishedAt: null,
        healthStatus: "none",
      },
    ]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
    });

    try {
      await coordinator.reconcileOnStartup();

      assert.equal(db.containers.get("bin-sleep")?.lifecyclePhase, "sleeping");
      assert.equal(
        db.containers.get("bin-manual-stop")?.lifecyclePhase,
        "offline",
      );
      assert.equal(db.containers.get("bin-crashed")?.lifecyclePhase, "offline");
      assert.equal(db.containers.get("bin-deleted")?.lifecyclePhase, "offline");
      assert.equal(db.containers.get("bin-replaced")?.containerId, "cid-new");
      assert.equal(db.containers.get("bin-replaced")?.lifecyclePhase, "waking");

      // Offline bins refuse auto-wake.
      const manualWake = await coordinator.ensureAwakeAndRun(
        "bin-manual-stop",
        async () => "should-not-run",
      );
      assert.equal(manualWake.ok, false);
      if (!manualWake.ok) assert.equal(manualWake.code, "runtime_offline");
      assert.deepEqual(fakeDriver.startCalls, []);
    } finally {
      await coordinator.close();
    }
  });

  void it("marks a running container offline on unexpected disconnect and surfaces wake failures cleanly", async () => {
    const db = createFakeDatabase({
      bins: [
        makeLightweightBin("bin-running", 300),
        makeLightweightBin("bin-missing-wake", 300),
      ],
      connections: [
        makeOnlineConnection("bin-running"),
        { ...makeOnlineConnection("bin-missing-wake"), disconnected: true },
      ],
      containers: [
        {
          binId: "bin-running",
          composeProject: "binny",
          composeService: "s-running",
          containerId: "cid-running",
          lifecyclePhase: "running",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: new Date(),
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-missing-wake",
          composeProject: "binny",
          composeService: "s-missing",
          containerId: "cid-missing",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
    });
    const fakeDriver = createFakeDriver([]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
    });

    try {
      await coordinator.onRuntimeDisconnected("bin-running", "rt-1");
      assert.equal(db.containers.get("bin-running")?.lifecyclePhase, "offline");

      const wakeResult = await coordinator.ensureAwakeAndRun(
        "bin-missing-wake",
        async () => "never",
      );
      assert.equal(wakeResult.ok, false);
      if (!wakeResult.ok) assert.equal(wakeResult.code, "wake_failed");
      assert.equal(
        db.containers.get("bin-missing-wake")?.lifecyclePhase,
        "offline",
      );
    } finally {
      await coordinator.close();
    }
  });
});
