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

import { createBinConfigurationStore } from "./bin-configuration.ts";
import { createRuntimeConnectionStore } from "./runtime-connection.ts";
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
  let onBeforeStart:
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
      await onBeforeStart?.(entry);
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
    setBeforeStart(
      handler:
        | ((container: ManagedContainerInspectResult) => Promise<void> | void)
        | undefined,
    ) {
      onBeforeStart = handler;
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

  function executeSelect(
    fields: Record<string, unknown> | undefined,
    table: unknown,
    clause: unknown,
  ): unknown[] {
    const compiled = compileWhere(clause);
    const keys = fields === undefined ? [] : Object.keys(fields);
    if (table === binConfigurations) {
      const binId = findBinId(compiled.params);
      const selectedBins =
        binId !== undefined
          ? bins.has(binId)
            ? [bins.get(binId)!]
            : []
          : [...bins.values()];
      if (keys.includes("configuredSourceAdapter")) {
        return selectedBins.map((bin) => {
          const conn = connections.get(bin.id);
          const container = containers.get(bin.id);
          return {
            binId: bin.id,
            configuredSourceAdapter: bin.sourceAdapter,
            config: bin.config,
            configNativeValid: bin.configNativeValid,
            runtimeSleepIdleTimeoutSeconds: bin.runtimeSleepIdleTimeoutSeconds,
            runtimeId: conn?.runtimeId ?? null,
            runtimeSourceAdapter: conn?.sourceAdapter ?? null,
            environment: conn?.environment ?? null,
            lastHeartbeatAt: conn?.lastHeartbeatAt ?? null,
            disconnected: conn?.disconnected ?? null,
            ownerState: conn?.ownerState ?? null,
            ownerGeneration: conn?.ownerGeneration ?? null,
            protocolVersion: conn?.protocolVersion ?? null,
            runtimeControlUrl: conn?.runtimeControlUrl ?? null,
            sourceStateSnapshot: conn?.sourceStateSnapshot ?? null,
            containerLifecyclePhase: container?.lifecyclePhase ?? null,
            containerLastWakeError: container?.lastWakeError ?? null,
          };
        });
      }
      return selectedBins.map((b) => ({ ...b }));
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
        const statuses = compiled.params.filter(
          (p): p is string =>
            typeof p === "string" &&
            ["queued", "executing", "cancelling"].includes(p),
        );
        rows = rows.filter((r) => statuses.includes(r.status));
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

  function createSelectBuilder(
    fields: Record<string, unknown> | undefined,
    table: unknown,
  ) {
    let whereClause: unknown;
    const builder = Object.assign(
      Promise.resolve().then(() => executeSelect(fields, table, whereClause)),
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
            executeSelect(fields, table, whereClause),
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
              if (table === humanSessions) {
                const sessionId = compiled.params.find(
                  (param): param is string =>
                    typeof param === "string" && sessions.has(param),
                );
                const updated: HumanSessionRow[] = [];
                for (const row of sessions.values()) {
                  if (sessionId !== undefined && row.sessionId !== sessionId)
                    continue;
                  if (binId !== undefined && row.binId !== binId) continue;
                  for (const [k, v] of Object.entries(values)) {
                    (row as Record<string, unknown>)[k] = resolveValue(v);
                  }
                  updated.push({ ...row });
                }
                return updated;
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
    select: (fields?: Record<string, unknown>) => {
      from: (table: unknown) => ReturnType<typeof createSelectBuilder>;
    };
    insert: (table: unknown) => ReturnType<typeof createInsertBuilder>;
    update: (table: unknown) => ReturnType<typeof createUpdateBuilder>;
    transaction: <T>(cb: (tx: typeof executor) => Promise<T>) => Promise<T>;
  } = {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          return createSelectBuilder(fields, table);
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
      wakeTimeoutMs: 100,
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
      wakeTimeoutMs: 100,
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

  void it("recovers queued runs for policy-sleeping containers on startup without waking idle sleeping or offline containers", async () => {
    const db = createFakeDatabase({
      bins: [
        makeLightweightBin("bin-sleep-queued", 300),
        makeLightweightBin("bin-sleep-idle", 300),
        makeLightweightBin("bin-offline-queued", 300),
      ],
      connections: [
        { ...makeOnlineConnection("bin-sleep-queued"), disconnected: true },
        { ...makeOnlineConnection("bin-sleep-idle"), disconnected: true },
        { ...makeOnlineConnection("bin-offline-queued"), disconnected: true },
      ],
      containers: [
        {
          binId: "bin-sleep-queued",
          composeProject: "binny",
          composeService: "s-sleep-queued",
          containerId: "cid-sleep-queued",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-sleep-idle",
          composeProject: "binny",
          composeService: "s-sleep-idle",
          containerId: "cid-sleep-idle",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-offline-queued",
          composeProject: "binny",
          composeService: "s-offline-queued",
          containerId: "cid-offline-queued",
          lifecyclePhase: "offline",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
      runs: [
        {
          runId: "run-sleep-queued",
          binId: "bin-sleep-queued",
          status: "queued",
          stopConfirmedAt: null,
          failure: null,
        },
        {
          runId: "run-offline-queued",
          binId: "bin-offline-queued",
          status: "queued",
          stopConfirmedAt: null,
          failure: null,
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-sleep-queued",
        composeProject: "binny",
        composeService: "s-sleep-queued",
        binId: "bin-sleep-queued",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        healthStatus: "none",
      },
      {
        containerId: "cid-sleep-idle",
        composeProject: "binny",
        composeService: "s-sleep-idle",
        binId: "bin-sleep-idle",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        healthStatus: "none",
      },
      {
        containerId: "cid-offline-queued",
        composeProject: "binny",
        composeService: "s-offline-queued",
        binId: "bin-offline-queued",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:06:00.000Z",
        healthStatus: "none",
      },
    ]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      wakeTimeoutMs: 2_000,
    });
    fakeDriver.setOnStart(async (container) => {
      if (container.binId !== "bin-sleep-queued") return;
      const conn = db.connections.get("bin-sleep-queued")!;
      conn.disconnected = false;
      conn.ownerState = "confirmed";
      await coordinator.onRuntimeHeartbeat({
        binId: "bin-sleep-queued",
        runtimeId: conn.runtimeId,
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
        idleTimeoutSeconds: 300,
      });
    });

    try {
      await coordinator.reconcileOnStartup();
      await new Promise((r) => setTimeout(r, 50));

      assert.deepEqual(fakeDriver.startCalls, ["cid-sleep-queued"]);
      assert.equal(
        db.containers.get("bin-sleep-queued")?.lifecyclePhase,
        "running",
      );
      assert.equal(
        db.containers.get("bin-sleep-idle")?.lifecyclePhase,
        "sleeping",
      );
      assert.equal(
        db.containers.get("bin-offline-queued")?.lifecyclePhase,
        "offline",
      );
    } finally {
      await coordinator.close();
    }
  });

  void it("retries transient start failures with backoff while keeping sleeping state and lastWakeError until recovery", async () => {
    const db = createFakeDatabase({
      bins: [makeLightweightBin("bin-retry", 300)],
      connections: [
        { ...makeOnlineConnection("bin-retry"), disconnected: true },
      ],
      containers: [
        {
          binId: "bin-retry",
          composeProject: "binny",
          composeService: "s-retry",
          containerId: "cid-retry",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
      runs: [
        {
          runId: "run-retry",
          binId: "bin-retry",
          status: "queued",
          stopConfirmedAt: null,
          failure: null,
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-retry",
        composeProject: "binny",
        composeService: "s-retry",
        binId: "bin-retry",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        healthStatus: "none",
      },
    ]);

    let startAttempts = 0;
    fakeDriver.setBeforeStart(() => {
      startAttempts += 1;
      if (startAttempts <= 2) {
        throw new Error("Docker socket ECONNREFUSED");
      }
    });

    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      wakeTimeoutMs: 2_000,
      wakeRetryBaseDelayMs: 30,
      wakeRetryMaxDelayMs: 60,
    });
    fakeDriver.setOnStart(async () => {
      const conn = db.connections.get("bin-retry")!;
      conn.disconnected = false;
      conn.ownerState = "confirmed";
      await coordinator.onRuntimeHeartbeat({
        binId: "bin-retry",
        runtimeId: conn.runtimeId,
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
        idleTimeoutSeconds: 300,
      });
    });

    try {
      coordinator.requestWake("bin-retry");
      // Wait for first failed attempt while backoff is active.
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(db.containers.get("bin-retry")?.lifecyclePhase, "sleeping");
      const retryError = db.containers.get("bin-retry")?.lastWakeError as
        | { code: string; message: string }
        | undefined;
      assert.equal(retryError?.code, "runtime_wake_start_failed");
      assert.match(retryError?.message ?? "", /ECONNREFUSED/u);

      // Wait for retries to succeed on attempt 3.
      const deadline = Date.now() + 2_000;
      while (
        db.containers.get("bin-retry")?.lifecyclePhase !== "running" &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(db.containers.get("bin-retry")?.lifecyclePhase, "running");
      assert.equal(db.containers.get("bin-retry")?.lastWakeError, null);
      assert.equal(startAttempts, 3);
    } finally {
      await coordinator.close();
    }
  });

  void it("stops wake backoff retries immediately when queued work is cancelled", async () => {
    const db = createFakeDatabase({
      bins: [makeLightweightBin("bin-cancel", 300)],
      connections: [
        { ...makeOnlineConnection("bin-cancel"), disconnected: true },
      ],
      containers: [
        {
          binId: "bin-cancel",
          composeProject: "binny",
          composeService: "s-cancel",
          containerId: "cid-cancel",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
      runs: [
        {
          runId: "run-cancel",
          binId: "bin-cancel",
          status: "queued",
          stopConfirmedAt: null,
          failure: null,
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-cancel",
        composeProject: "binny",
        composeService: "s-cancel",
        binId: "bin-cancel",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        healthStatus: "none",
      },
    ]);
    fakeDriver.setBeforeStart(() => {
      throw new Error("transient docker outage");
    });

    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      wakeTimeoutMs: 2_000,
      wakeRetryBaseDelayMs: 60,
      wakeRetryMaxDelayMs: 60,
    });

    try {
      coordinator.requestWake("bin-cancel");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(fakeDriver.startCalls.length, 1);

      // Simulate run cancel marking the queued run cancelled and notifying coordinator.
      db.runs.get("run-cancel")!.status = "cancelled";
      await coordinator.markWorkCompleted("bin-cancel");

      // Wait longer than retry delay and verify no second start attempt occurs.
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(fakeDriver.startCalls.length, 1);
      assert.equal(db.containers.get("bin-cancel")?.lifecyclePhase, "sleeping");
    } finally {
      await coordinator.close();
    }
  });

  void it("preserves waking state on reconnect timeout and completes wake once heartbeats arrive", async () => {
    const db = createFakeDatabase({
      bins: [makeLightweightBin("bin-timeout", 300)],
      connections: [
        { ...makeOnlineConnection("bin-timeout"), disconnected: true },
      ],
      containers: [
        {
          binId: "bin-timeout",
          composeProject: "binny",
          composeService: "s-timeout",
          containerId: "cid-timeout",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
      runs: [
        {
          runId: "run-timeout",
          binId: "bin-timeout",
          status: "queued",
          stopConfirmedAt: null,
          failure: null,
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-timeout",
        composeProject: "binny",
        composeService: "s-timeout",
        binId: "bin-timeout",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        healthStatus: "none",
      },
    ]);

    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      wakeTimeoutMs: 60,
      wakeRetryBaseDelayMs: 40,
      wakeRetryMaxDelayMs: 80,
    });

    try {
      coordinator.requestWake("bin-timeout");
      // Wait for initial wake timeout without heartbeat.
      const waitDeadline = Date.now() + 1_500;
      while (
        db.containers.get("bin-timeout")?.lastWakeError === null &&
        Date.now() < waitDeadline
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(db.containers.get("bin-timeout")?.lifecyclePhase, "waking");
      const timeoutError = db.containers.get("bin-timeout")?.lastWakeError as
        | { code: string }
        | undefined;
      assert.equal(timeoutError?.code, "runtime_wake_timeout");

      // Deliver heartbeat now; retry or heartbeat handler completes wake and clears lastWakeError.
      const conn = db.connections.get("bin-timeout")!;
      conn.disconnected = false;
      conn.ownerState = "confirmed";
      await coordinator.onRuntimeHeartbeat({
        binId: "bin-timeout",
        runtimeId: conn.runtimeId,
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
        idleTimeoutSeconds: 300,
      });

      assert.equal(db.containers.get("bin-timeout")?.lifecyclePhase, "running");
      assert.equal(db.containers.get("bin-timeout")?.lastWakeError, null);
      assert.equal(fakeDriver.startCalls.length, 1);
    } finally {
      await coordinator.close();
    }
  });

  void it("sweepIdleContainers does not mark paused containers offline", async () => {
    const db = createFakeDatabase({
      bins: [makeLightweightBin("bin-paused", 0)],
      connections: [makeOnlineConnection("bin-paused")],
      containers: [
        {
          binId: "bin-paused",
          composeProject: "binny",
          composeService: "s-paused",
          containerId: "cid-paused",
          lifecyclePhase: "running",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: new Date(Date.now() - 10_000),
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-paused",
        composeProject: "binny",
        composeService: "s-paused",
        binId: "bin-paused",
        status: "paused",
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
      wakeTimeoutMs: 100,
    });

    try {
      await coordinator.sweepIdleContainers();
      assert.equal(db.containers.get("bin-paused")?.lifecyclePhase, "running");
      assert.equal(db.connections.get("bin-paused")?.disconnected, false);
      assert.deepEqual(fakeDriver.stopCalls, []);
    } finally {
      await coordinator.close();
    }
  });

  void it("refuses auto-wake and marks container offline when sleeping container was manually started and stopped", async () => {
    const db = createFakeDatabase({
      bins: [makeLightweightBin("bin-manual-cycle", 300)],
      connections: [
        { ...makeOnlineConnection("bin-manual-cycle"), disconnected: true },
      ],
      containers: [
        {
          binId: "bin-manual-cycle",
          composeProject: "binny",
          composeService: "s-manual-cycle",
          containerId: "cid-manual-cycle",
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
        containerId: "cid-manual-cycle",
        composeProject: "binny",
        composeService: "s-manual-cycle",
        binId: "bin-manual-cycle",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        // External docker start + docker stop before first heartbeat changed both timestamps.
        startedAt: "2026-11-20T00:06:00.000Z",
        finishedAt: "2026-11-20T00:06:10.000Z",
        healthStatus: "none",
      },
    ]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      wakeTimeoutMs: 100,
    });

    try {
      const wakeResult = await coordinator.ensureAwakeAndRun(
        "bin-manual-cycle",
        async () => "should-not-run",
      );
      assert.equal(wakeResult.ok, false);
      if (!wakeResult.ok) assert.equal(wakeResult.code, "runtime_offline");
      assert.deepEqual(fakeDriver.startCalls, []);
      assert.equal(
        db.containers.get("bin-manual-cycle")?.lifecyclePhase,
        "offline",
      );
    } finally {
      await coordinator.close();
    }
  });

  void it("marks sleeping container offline on unexpected disconnect while ignoring disconnect during policy stop", async () => {
    const db = createFakeDatabase({
      bins: [
        makeLightweightBin("bin-sleep-disconnect", 300),
        makeLightweightBin("bin-stopping-disconnect", 300),
      ],
      connections: [
        {
          ...makeOnlineConnection("bin-sleep-disconnect"),
          disconnected: true,
        },
        makeOnlineConnection("bin-stopping-disconnect"),
      ],
      containers: [
        {
          binId: "bin-sleep-disconnect",
          composeProject: "binny",
          composeService: "s-sleep-disconnect",
          containerId: "cid-sleep-disconnect",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-stopping-disconnect",
          composeProject: "binny",
          composeService: "s-stopping-disconnect",
          containerId: "cid-stopping-disconnect",
          lifecyclePhase: "stopping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
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
      wakeTimeoutMs: 100,
    });

    try {
      await coordinator.onRuntimeDisconnected("bin-sleep-disconnect", "rt-1");
      assert.equal(
        db.containers.get("bin-sleep-disconnect")?.lifecyclePhase,
        "offline",
      );

      await coordinator.onRuntimeDisconnected(
        "bin-stopping-disconnect",
        "rt-1",
      );
      assert.equal(
        db.containers.get("bin-stopping-disconnect")?.lifecyclePhase,
        "stopping",
      );
    } finally {
      await coordinator.close();
    }
  });

  void it("reconciles exited waking container without stoppedContainerFinishedAt as offline on startup", async () => {
    const db = createFakeDatabase({
      bins: [
        makeLightweightBin("bin-waking-started", 300),
        makeLightweightBin("bin-waking-unstarted", 300),
        makeLightweightBin("bin-stopping-clean", 300),
      ],
      connections: [
        { ...makeOnlineConnection("bin-waking-started"), disconnected: true },
        { ...makeOnlineConnection("bin-waking-unstarted"), disconnected: true },
        { ...makeOnlineConnection("bin-stopping-clean"), disconnected: true },
      ],
      containers: [
        {
          binId: "bin-waking-started",
          composeProject: "binny",
          composeService: "s-waking-started",
          containerId: "cid-waking-started",
          lifecyclePhase: "waking",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-waking-unstarted",
          composeProject: "binny",
          composeService: "s-waking-unstarted",
          containerId: "cid-waking-unstarted",
          lifecyclePhase: "waking",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
        {
          binId: "bin-stopping-clean",
          composeProject: "binny",
          composeService: "s-stopping-clean",
          containerId: "cid-stopping-clean",
          lifecyclePhase: "stopping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-waking-started",
        composeProject: "binny",
        composeService: "s-waking-started",
        binId: "bin-waking-started",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:07:00.000Z",
        healthStatus: "none",
      },
      {
        containerId: "cid-waking-unstarted",
        composeProject: "binny",
        composeService: "s-waking-unstarted",
        binId: "bin-waking-unstarted",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        healthStatus: "none",
      },
      {
        containerId: "cid-stopping-clean",
        composeProject: "binny",
        composeService: "s-stopping-clean",
        binId: "bin-stopping-clean",
        status: "exited",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:06:00.000Z",
        healthStatus: "none",
      },
    ]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      wakeTimeoutMs: 100,
    });

    try {
      await coordinator.reconcileOnStartup();
      assert.equal(
        db.containers.get("bin-waking-started")?.lifecyclePhase,
        "offline",
      );
      assert.equal(
        db.containers.get("bin-waking-unstarted")?.lifecyclePhase,
        "sleeping",
      );
      assert.equal(
        db.containers.get("bin-stopping-clean")?.lifecyclePhase,
        "sleeping",
      );
    } finally {
      await coordinator.close();
    }
  });

  void it("preserves incompatible public execution status when an incompatible bin container is sleeping", async () => {
    const db = createFakeDatabase({
      bins: [
        {
          ...makeLightweightBin("bin-incompat-sleep", 300),
          configNativeValid: false,
        },
      ],
      connections: [
        { ...makeOnlineConnection("bin-incompat-sleep"), disconnected: true },
      ],
      containers: [
        {
          binId: "bin-incompat-sleep",
          composeProject: "binny",
          composeService: "s-incompat-sleep",
          containerId: "cid-incompat-sleep",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
    });

    const connectionStore = createRuntimeConnectionStore(db.database);
    const execution = await connectionStore.getExecution("bin-incompat-sleep");
    assert.equal(execution.ok, true);
    if (execution.ok) {
      assert.equal(execution.value.status, "incompatible");
      assert.equal(
        execution.value.error.code,
        "runtime_configuration_incompatible",
      );
    }
  });

  void it("reads migrated runtimeSleep policies consistently for lightweight, custom/resident reusable browser, and non-reusable browser bins", async () => {
    const reusableBrowserAdapter = {
      ...lightweightAdapter,
      id: "browser.reusable",
      environment: {
        browser: { required: true, profileReuseAfterRestart: true },
      },
    };
    const nonReusableBrowserAdapter = {
      ...lightweightAdapter,
      id: "browser.ephemeral",
      environment: {
        browser: {
          required: true,
          profileReuseAfterRestart: false,
          profileReuseUnavailableReason: "In-memory session only.",
        },
      },
    };

    const db = createFakeDatabase({
      bins: [
        makeLightweightBin("bin-mig-lightweight", 300),
        {
          ...makeLightweightBin("bin-mig-browser-custom", 45),
          sourceAdapter: reusableBrowserAdapter,
        },
        {
          ...makeLightweightBin("bin-mig-browser-resident", null),
          sourceAdapter: reusableBrowserAdapter,
        },
        {
          ...makeLightweightBin("bin-mig-browser-nonreusable", 300),
          sourceAdapter: nonReusableBrowserAdapter,
        },
      ],
    });

    const binStore = createBinConfigurationStore(db.database);
    const listed = await binStore.listBins();
    const byId = new Map(listed.map((b) => [b.id, b.runtimeSleep]));
    assert.deepEqual(byId.get("bin-mig-lightweight"), {
      idleTimeoutSeconds: 300,
    });
    assert.deepEqual(byId.get("bin-mig-browser-custom"), {
      idleTimeoutSeconds: 45,
    });
    assert.deepEqual(byId.get("bin-mig-browser-resident"), {
      idleTimeoutSeconds: null,
    });
    assert.deepEqual(byId.get("bin-mig-browser-nonreusable"), {
      idleTimeoutSeconds: null,
    });

    const single = await binStore.getBin("bin-mig-browser-nonreusable");
    assert.equal(single.ok, true);
    if (single.ok) {
      assert.deepEqual(single.value.runtimeSleep, { idleTimeoutSeconds: null });
    }
  });

  void it("resolves live container VNC host ports across container recreation and settles disconnected human sessions on startup", async () => {
    const db = createFakeDatabase({
      bins: [makeLightweightBin("bin-vnc-live", 300)],
      connections: [makeOnlineConnection("bin-vnc-live")],
      containers: [
        {
          binId: "bin-vnc-live",
          composeProject: "binny",
          composeService: "browser-one",
          containerId: "cid-old",
          lifecyclePhase: "running",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
      humanSessions: [
        {
          sessionId: "99999999-9999-4999-8999-999999999999",
          binId: "bin-vnc-live",
          status: "ready",
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      {
        containerId: "cid-new",
        composeProject: "binny",
        composeService: "browser-one",
        binId: "bin-vnc-live",
        status: "running",
        exitCode: 0,
        oomKilled: false,
        startedAt: "2026-11-20T01:00:00.000Z",
        finishedAt: null,
        healthStatus: "none",
        vncHostPort: 45_123,
      },
    ]);
    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
    });

    try {
      // Resolves live port from replacement container even before reconcile updates containerId.
      assert.equal(
        await coordinator.resolveVncHostPort("bin-vnc-live"),
        45_123,
      );

      // Simulate crashed container during server downtime.
      fakeDriver.containers.delete("cid-new");
      await coordinator.reconcileOnStartup();
      assert.equal(
        db.sessions.get("99999999-9999-4999-8999-999999999999")?.status,
        "failed",
      );
      assert.equal(await coordinator.resolveVncHostPort("bin-vnc-live"), null);
    } finally {
      await coordinator.close();
    }
  });
});
