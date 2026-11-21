import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runtimeProtocolVersion } from "@binny/contracts";
import {
  archiveCommits,
  binConfigurations,
  humanSessions,
  manualRuns,
  runtimeConnections,
  runtimeContainers,
  type Database,
} from "@binny/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createBinConfigurationStore } from "./bin-configuration.ts";
import { createHumanSessionStore } from "./human-session.ts";
import { createManualRunStore } from "./manual-run.ts";
import { createRuntimeConnectionStore } from "./runtime-connection.ts";

const browserAdapter = {
  id: "test.browser",
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
      required: true,
      profileReuseAfterRestart: true,
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

type ConnectionRow = {
  binId: string;
  runtimeId: string;
  sourceAdapter: unknown;
  environment: unknown;
  sourceStateSnapshot: unknown;
  lastHeartbeatAt: Date;
  disconnected: boolean;
  protocolVersion: number;
  runtimeControlUrl: string;
  ownerState: "confirmed" | "unconfirmed";
  ownerGeneration: bigint;
};

type RunRow = {
  runId: string;
  binId: string;
  identityId: string;
  sourceAdapterSnapshot: unknown;
  sourceAdapterId: string;
  sourceAdapterVersion: string;
  action: string;
  params: Record<string, unknown>;
  configSnapshot: Record<string, unknown>;
  triggerType: "manual" | "schedule";
  scheduleId: string | null;
  scheduledFor: Date | null;
  status:
    | "queued"
    | "executing"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
  runtimeId: string | null;
  completedScopes: string[];
  failure: unknown;
  output: unknown;
  report: unknown;
  cancelRequestedAt: Date | null;
  stopConfirmedAt: Date | null;
  createdAt: Date;
  referenceTime: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

type HumanSessionRow = {
  sessionId: string;
  binId: string;
  status: "pending" | "opening" | "ready" | "closing" | "closed" | "failed";
  runtimeId: string | null;
  ownerGeneration: bigint | null;
  vncPasswordPending: string | null;
  runtimeClosed: boolean;
  failure: unknown;
  requestedAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  closedAt: Date | null;
};

const dialect = new PgDialect();

function compileWhere(clause: unknown): {
  readonly sql: string;
  readonly params: readonly unknown[];
} {
  if (clause === undefined) return { sql: "", params: [] };
  return dialect.sqlToQuery(clause as SQL);
}

function createInMemoryDatabase(initial: {
  bins: BinRow[];
  connections: ConnectionRow[];
  containers?: ContainerRow[];
  runs: RunRow[];
  humanSessions: HumanSessionRow[];
}) {
  const bins = new Map(initial.bins.map((b) => [b.id, { ...b }]));
  const connections = new Map(
    initial.connections.map((c) => [c.binId, { ...c }]),
  );
  const containers = new Map(
    (initial.containers ?? []).map((c) => [c.binId, { ...c }]),
  );
  const runs = new Map(initial.runs.map((r) => [r.runId, { ...r }]));
  const sessions = new Map(
    initial.humanSessions.map((s) => [s.sessionId, { ...s }]),
  );

  function findBinId(params: readonly unknown[]): string | undefined {
    for (const param of params) {
      if (typeof param === "string" && bins.has(param)) return param;
    }
    return undefined;
  }

  function isConnectionOnline(connection: ConnectionRow | undefined): boolean {
    if (connection === undefined || connection.disconnected) return false;
    return Date.now() - connection.lastHeartbeatAt.getTime() <= 8_000;
  }

  function executeSelect(
    fields: Record<string, unknown> | undefined,
    table: unknown,
    clause: unknown,
  ): unknown[] {
    const compiled = compileWhere(clause);
    const keys = fields === undefined ? [] : Object.keys(fields);

    if (table === archiveCommits) return [];

    if (table === binConfigurations) {
      if (compiled.sql.includes("in (")) {
        return compiled.params
          .filter(
            (param): param is string =>
              typeof param === "string" && bins.has(param),
          )
          .map((id) => ({ ...bins.get(id)! }));
      }
      const binId = findBinId(compiled.params);
      const bin = binId === undefined ? undefined : bins.get(binId);
      if (bin === undefined) return [];
      const conn = connections.get(bin.id);
      if (keys.includes("configuredSourceAdapter")) {
        const container = containers.get(bin.id);
        return [
          {
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
          },
        ];
      }
      return [{ ...bin }];
    }

    if (table === runtimeContainers) {
      const binId = findBinId(compiled.params);
      const container = binId === undefined ? undefined : containers.get(binId);
      return container === undefined ? [] : [{ ...container }];
    }

    if (table === runtimeConnections) {
      const binId = findBinId(compiled.params);
      const conn = binId === undefined ? undefined : connections.get(binId);
      if (conn === undefined) return [];
      if (keys.includes("online")) {
        return [
          {
            ...conn,
            online: isConnectionOnline(conn) && conn.ownerState === "confirmed",
          },
        ];
      }
      if (keys.includes("matches")) {
        return [{ ...conn, matches: true }];
      }
      return [{ ...conn }];
    }

    if (table === humanSessions) {
      const binId = findBinId(compiled.params);
      const sessionId = compiled.params.find(
        (param): param is string =>
          typeof param === "string" && sessions.has(param),
      );
      let rows = [...sessions.values()];
      if (binId !== undefined) rows = rows.filter((r) => r.binId === binId);
      if (sessionId !== undefined)
        rows = rows.filter((r) => r.sessionId === sessionId);
      if (compiled.sql.includes("in (")) {
        rows = rows.filter((r) =>
          ["pending", "opening", "ready", "closing"].includes(r.status),
        );
      }
      return rows.map((r) => ({ ...r }));
    }

    if (table === manualRuns) {
      const binId = findBinId(compiled.params);
      const runId = compiled.params.find(
        (param): param is string =>
          typeof param === "string" && runs.has(param),
      );
      if (keys.length === 1 && keys[0] === "matches") {
        return [{ matches: true }];
      }
      let rows = [...runs.values()];
      if (binId !== undefined) rows = rows.filter((r) => r.binId === binId);
      if (runId !== undefined) rows = rows.filter((r) => r.runId === runId);

      if (keys.includes("earlierRunActive")) {
        return rows.map((run) => {
          const conn = connections.get(run.binId);
          const binRuns = [...runs.values()].filter(
            (other) => other.binId === run.binId,
          );
          const binSessions = [...sessions.values()].filter(
            (s) => s.binId === run.binId,
          );
          return {
            ...run,
            runtimeOnline: isConnectionOnline(conn),
            earlierRunActive: binRuns.some(
              (other) =>
                other.status === "executing" || other.status === "cancelling",
            ),
            previousExecutionUnconfirmed: conn?.ownerState === "unconfirmed",
            humanSessionActive: binSessions.some((s) =>
              ["pending", "opening", "ready", "closing"].includes(s.status),
            ),
            earlierRunQueued: binRuns.some(
              (other) =>
                other.status === "queued" &&
                (other.createdAt.getTime() < run.createdAt.getTime() ||
                  (other.createdAt.getTime() === run.createdAt.getTime() &&
                    other.runId < run.runId)),
            ),
          };
        });
      }

      if (keys.length === 1 && keys[0] === "runId") {
        if (compiled.sql.includes('"stop_confirmed_at" is null')) {
          rows = rows.filter(
            (r) =>
              r.status === "executing" ||
              r.status === "cancelling" ||
              (r.startedAt !== null && r.stopConfirmedAt === null),
          );
        } else {
          rows = rows.filter(
            (r) => r.status === "executing" || r.status === "cancelling",
          );
        }
        return rows.map((r) => ({ runId: r.runId }));
      }

      if (keys.includes("params")) {
        rows = rows
          .filter((r) => r.status === "queued")
          .toSorted(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.runId.localeCompare(b.runId),
          );
        return rows.map((r) => ({ ...r }));
      }

      if (compiled.sql.includes("not (exists")) {
        return [];
      }

      return rows.map((r) => ({ ...r }));
    }

    return [];
  }

  function createSelectBuilder(
    fields: Record<string, unknown> | undefined,
    table: unknown,
  ) {
    let whereClause: unknown;
    let maxRows: number | undefined;
    const resolveRows = () => {
      const result = executeSelect(fields, table, whereClause);
      return maxRows === undefined ? result : result.slice(0, maxRows);
    };
    const builder = Object.assign(
      Promise.resolve().then(() => resolveRows()),
      {
        leftJoin(_other: unknown, _on: unknown) {
          return builder;
        },
        where(clause: unknown) {
          whereClause = clause;
          return builder;
        },
        orderBy(..._columns: unknown[]) {
          return builder;
        },
        limit(count: number) {
          maxRows = count;
          return builder;
        },
        for(_mode: string, _options?: unknown) {
          return builder;
        },
      },
    );
    return builder;
  }

  function applyUpdate(
    table: unknown,
    values: Record<string, unknown>,
    clause: unknown,
  ): unknown[] {
    const compiled = compileWhere(clause);
    if (table === manualRuns) {
      if (compiled.sql.includes("not (exists")) return [];
      const runId = compiled.params.find(
        (param): param is string =>
          typeof param === "string" && runs.has(param),
      );
      const binId = findBinId(compiled.params);
      const updated: RunRow[] = [];
      for (const row of runs.values()) {
        if (runId !== undefined && row.runId !== runId) continue;
        if (binId !== undefined && row.binId !== binId) continue;
        if (
          compiled.sql.includes('"status" = $') &&
          compiled.params.includes("queued")
        ) {
          if (row.status !== "queued") continue;
        }
        if ("status" in values) row.status = values.status as RunRow["status"];
        if ("runtimeId" in values)
          row.runtimeId = values.runtimeId as string | null;
        if ("startedAt" in values) row.startedAt = new Date();
        updated.push({ ...row });
      }
      return updated;
    }
    if (table === humanSessions) {
      const sessionId = compiled.params.find(
        (param): param is string =>
          typeof param === "string" && sessions.has(param),
      );
      const binId = findBinId(compiled.params);
      const updated: HumanSessionRow[] = [];
      for (const row of sessions.values()) {
        if (sessionId !== undefined && row.sessionId !== sessionId) continue;
        if (binId !== undefined && row.binId !== binId) continue;
        if (
          compiled.sql.includes('"status" = $') &&
          compiled.params.includes("pending") &&
          row.status !== "pending"
        ) {
          continue;
        }
        if (
          compiled.sql.includes('"status" = $') &&
          compiled.params.includes("opening") &&
          row.status !== "opening"
        ) {
          continue;
        }
        if ("status" in values)
          row.status = values.status as HumanSessionRow["status"];
        if ("runtimeId" in values)
          row.runtimeId = values.runtimeId as string | null;
        if ("ownerGeneration" in values)
          row.ownerGeneration = values.ownerGeneration as bigint | null;
        if ("vncPasswordPending" in values)
          row.vncPasswordPending = values.vncPasswordPending as string | null;
        if ("runtimeClosed" in values)
          row.runtimeClosed = Boolean(values.runtimeClosed);
        if ("failure" in values) row.failure = values.failure;
        if ("readyAt" in values) row.readyAt = new Date();
        if ("closedAt" in values) row.closedAt = new Date();
        row.updatedAt = new Date();
        updated.push({ ...row });
      }
      return updated;
    }
    if (table === binConfigurations) {
      const binId = findBinId(compiled.params);
      if (binId === undefined) return [];
      const bin = bins.get(binId);
      if (bin === undefined) return [];
      if ("lastIssuedOwnerGeneration" in values) {
        bin.lastIssuedOwnerGeneration = String(
          values.lastIssuedOwnerGeneration,
        );
      }
      if ("runtimeSleepIdleTimeoutSeconds" in values) {
        bin.runtimeSleepIdleTimeoutSeconds =
          (values.runtimeSleepIdleTimeoutSeconds as number | null) ?? null;
      }
      return [{ ...bin }];
    }
    if (table === runtimeConnections) {
      const binId = findBinId(compiled.params);
      if (binId === undefined) return [];
      const conn = connections.get(binId);
      if (conn === undefined) return [];
      if ("disconnected" in values)
        conn.disconnected = Boolean(values.disconnected);
      if ("ownerState" in values)
        conn.ownerState = values.ownerState as ConnectionRow["ownerState"];
      return [{ ...conn }];
    }
    return [];
  }

  function applyInsert(table: unknown, values: Record<string, unknown>) {
    if (table === humanSessions) {
      const now = new Date();
      const created: HumanSessionRow = {
        sessionId: values.sessionId as string,
        binId: values.binId as string,
        status: (values.status as HumanSessionRow["status"]) ?? "pending",
        runtimeId: null,
        ownerGeneration: null,
        vncPasswordPending:
          (values.vncPasswordPending as string | null | undefined) ?? null,
        runtimeClosed: false,
        failure: null,
        requestedAt: now,
        updatedAt: now,
        readyAt: null,
        closedAt: null,
      };
      sessions.set(created.sessionId, created);
      return [{ ...created }];
    }
    if (table === runtimeConnections) {
      const binId = values.binId as string;
      const existing = connections.get(binId);
      const next: ConnectionRow = {
        binId,
        runtimeId: values.runtimeId as string,
        sourceAdapter: values.sourceAdapter,
        environment: values.environment,
        sourceStateSnapshot: values.sourceStateSnapshot ?? null,
        lastHeartbeatAt: new Date(),
        disconnected: Boolean(values.disconnected ?? false),
        protocolVersion: Number(values.protocolVersion),
        runtimeControlUrl: values.runtimeControlUrl as string,
        ownerState:
          (values.ownerState as ConnectionRow["ownerState"]) ?? "confirmed",
        ownerGeneration: values.ownerGeneration as bigint,
      };
      connections.set(binId, existing ? { ...existing, ...next } : next);
    }
    return [];
  }

  function applyDelete(table: unknown, clause: unknown): unknown[] {
    const compiled = compileWhere(clause);
    if (table === binConfigurations) {
      const binId = findBinId(compiled.params);
      if (binId === undefined) return [];
      const existing = bins.get(binId);
      if (existing === undefined) return [];
      bins.delete(binId);
      connections.delete(binId);
      return [{ id: existing.id }];
    }
    return [];
  }

  const queryExecutor = {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          return createSelectBuilder(fields, table);
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(clause: unknown) {
              const rows = applyUpdate(table, values, clause);
              return Object.assign(Promise.resolve(rows), {
                returning(_fields?: unknown) {
                  return Promise.resolve(rows);
                },
              });
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          const runInsert = () => applyInsert(table, values);
          return {
            returning() {
              return Promise.resolve(runInsert() ?? []);
            },
            onConflictDoUpdate(_opts: unknown) {
              runInsert();
              return Promise.resolve();
            },
            onConflictDoNothing(_opts: unknown) {
              return {
                returning() {
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(clause: unknown) {
          return {
            returning(_fields?: unknown) {
              return Promise.resolve(applyDelete(table, clause));
            },
          };
        },
      };
    },
  };

  const executor = {
    ...queryExecutor,
    async transaction<T>(
      callback: (tx: typeof queryExecutor) => Promise<T>,
    ): Promise<T> {
      return await callback(queryExecutor);
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

function makeBin(id: string): BinRow {
  const now = new Date();
  return {
    id,
    sourceAdapter: browserAdapter,
    identityId: id,
    config: {},
    configNativeValid: true,
    runtimeSleepIdleTimeoutSeconds: 300,
    status: "active",
    persistentState: null,
    sourceAccessState: null,
    lastIssuedOwnerGeneration: "1",
    createdAt: now,
    updatedAt: now,
  };
}

function makeConnection(
  binId: string,
  runtimeId: string,
  powerStatus:
    | "stopped"
    | "starting"
    | "ready"
    | "stopping"
    | "unknown" = "stopped",
  ownerState: "confirmed" | "unconfirmed" = "confirmed",
): ConnectionRow {
  return {
    binId,
    runtimeId,
    sourceAdapter: browserAdapter,
    environment: {
      kind: "browser",
      browser: {
        available: true,
        profileReuseAfterRestart: true,
        power:
          powerStatus === "unknown"
            ? {
                status: "unknown",
                error: { code: "browser_stop_failed", message: "unknown" },
              }
            : { status: powerStatus },
      },
    },
    sourceStateSnapshot: null,
    lastHeartbeatAt: new Date(),
    disconnected: false,
    protocolVersion: runtimeProtocolVersion,
    runtimeControlUrl: `http://${binId}:8080`,
    ownerState,
    ownerGeneration: 1n,
  };
}

function makeQueuedRun(
  runId: string,
  binId: string,
  createdAt = new Date(),
): RunRow {
  return {
    runId,
    binId,
    identityId: binId,
    sourceAdapterSnapshot: browserAdapter,
    sourceAdapterId: browserAdapter.id,
    sourceAdapterVersion: browserAdapter.version,
    action: "check",
    params: {},
    configSnapshot: {},
    triggerType: "manual",
    scheduleId: null,
    scheduledFor: null,
    status: "queued",
    runtimeId: null,
    completedScopes: [],
    failure: null,
    output: null,
    report: null,
    cancelRequestedAt: null,
    stopConfirmedAt: null,
    createdAt,
    referenceTime: createdAt,
    startedAt: null,
    finishedAt: null,
  };
}

function makeHumanSession(
  sessionId: string,
  binId: string,
  status: HumanSessionRow["status"] = "pending",
): HumanSessionRow {
  const now = new Date();
  return {
    sessionId,
    binId,
    status,
    runtimeId: null,
    ownerGeneration: null,
    vncPasswordPending: null,
    runtimeClosed: false,
    failure: null,
    requestedAt: now,
    updatedAt: now,
    readyAt: null,
    closedAt: null,
  };
}

void describe("independent browser bins without cross-bin capacity", () => {
  void it("admits runs and human sessions for two independent browser bins concurrently", async () => {
    const runA = "11111111-1111-4111-8111-111111111111";
    const runB = "22222222-2222-4222-8222-222222222222";
    const mock = createInMemoryDatabase({
      bins: [makeBin("bin-a"), makeBin("bin-b")],
      connections: [
        makeConnection("bin-a", "rt-a", "ready"),
        makeConnection("bin-b", "rt-b", "stopped"),
      ],
      runs: [makeQueuedRun(runA, "bin-a"), makeQueuedRun(runB, "bin-b")],
      humanSessions: [],
    });

    const runsStore = createManualRunStore(mock.database);
    const [claimA, claimB] = await Promise.all([
      runsStore.claimRun("bin-a", { runtimeId: "rt-a" }),
      runsStore.claimRun("bin-b", { runtimeId: "rt-b" }),
    ]);

    assert.equal(claimA.ok, true);
    assert.equal(claimB.ok, true);
    if (!claimA.ok || !claimB.ok) return;
    assert.equal(claimA.value?.runId, runA);
    assert.equal(claimB.value?.runId, runB);

    // Independent human sessions on two idle browser bins can open simultaneously.
    const sessionA = "33333333-3333-4333-8333-333333333333";
    const sessionB = "44444444-4444-4444-8444-444444444444";
    mock.runs.clear();
    mock.sessions.set(sessionA, makeHumanSession(sessionA, "bin-a", "pending"));
    mock.sessions.set(sessionB, makeHumanSession(sessionB, "bin-b", "pending"));

    const runtimeStore = createRuntimeConnectionStore(mock.database);
    const heartbeatPayload = (runtimeId: string, binId: string) => ({
      protocolVersion: runtimeProtocolVersion as typeof runtimeProtocolVersion,
      runtimeId,
      ownerGeneration: "1",
      ownerLockAcquired: true as const,
      activeRunId: null,
      claimInFlight: false,
      runtimeControlUrl: `http://${binId}:8080`,
      sourceAdapter: browserAdapter,
      environment: {
        kind: "browser" as const,
        browser: {
          available: true,
          profileReuseAfterRestart: true,
          power: { status: "ready" as const },
        },
      },
    });
    const [hbA, hbB] = await Promise.all([
      runtimeStore.heartbeat("bin-a", heartbeatPayload("rt-a", "bin-a")),
      runtimeStore.heartbeat("bin-b", heartbeatPayload("rt-b", "bin-b")),
    ]);
    assert.equal(hbA.ok, true);
    assert.equal(hbB.ok, true);
    if (!hbA.ok || !hbB.ok) return;
    assert.equal(hbA.value.humanSession?.action, "open");
    assert.equal(hbA.value.humanSession?.sessionId, sessionA);
    assert.equal(hbB.value.humanSession?.action, "open");
    assert.equal(hbB.value.humanSession?.sessionId, sessionB);
  });

  void it("preserves same-bin serialization, human-vs-run exclusion, stopping wait, and unconfirmed owner fencing", async () => {
    const activeRunId = "11111111-1111-4111-8111-111111111111";
    const queuedRunId = "22222222-2222-4222-8222-222222222222";
    const sessionId = "33333333-3333-4333-8333-333333333333";

    const mock = createInMemoryDatabase({
      bins: [makeBin("bin-a")],
      connections: [makeConnection("bin-a", "rt-a", "ready")],
      runs: [
        {
          ...makeQueuedRun(activeRunId, "bin-a", new Date(1000)),
          status: "executing",
          runtimeId: "rt-a",
          startedAt: new Date(1000),
        },
        makeQueuedRun(queuedRunId, "bin-a", new Date(2000)),
      ],
      humanSessions: [],
    });

    const runsStore = createManualRunStore(mock.database);
    const humanStore = createHumanSessionStore(mock.database);
    const binStore = createBinConfigurationStore(mock.database);

    // 1. Active run blocks queued run and pending human session on same bin.
    const queuedDuringRun = await runsStore.getRun("bin-a", queuedRunId);
    assert.equal(queuedDuringRun.ok, true);
    if (queuedDuringRun.ok) {
      assert.equal(queuedDuringRun.value.queueReason, "earlier_run_active");
    }
    const blockedClaimDuringRun = await runsStore.claimRun("bin-a", {
      runtimeId: "rt-a",
    });
    assert.deepEqual(blockedClaimDuringRun, { ok: true, value: null });

    mock.sessions.set(
      sessionId,
      makeHumanSession(sessionId, "bin-a", "pending"),
    );
    const humanDuringRun = await humanStore.getHumanSession("bin-a", sessionId);
    assert.equal(humanDuringRun.ok, true);
    if (humanDuringRun.ok) {
      assert.equal(humanDuringRun.value.queueReason, "bin_busy");
    }

    // 2. Active human session blocks queued run even when no run is executing.
    mock.runs.delete(activeRunId);
    mock.sessions.get(sessionId)!.status = "ready";
    const queuedDuringHuman = await runsStore.getRun("bin-a", queuedRunId);
    assert.equal(queuedDuringHuman.ok, true);
    if (queuedDuringHuman.ok) {
      assert.equal(queuedDuringHuman.value.queueReason, "human_session_active");
    }
    const blockedClaimDuringHuman = await runsStore.claimRun("bin-a", {
      runtimeId: "rt-a",
    });
    assert.deepEqual(blockedClaimDuringHuman, { ok: true, value: null });

    // 3. Stopping browser blocks claim and pending human session with bin_busy.
    mock.sessions.get(sessionId)!.status = "pending";
    mock.connections.set("bin-a", makeConnection("bin-a", "rt-a", "stopping"));
    const runtimeStore = createRuntimeConnectionStore(mock.database);
    const hbStopping = await runtimeStore.heartbeat("bin-a", {
      protocolVersion: runtimeProtocolVersion,
      runtimeId: "rt-a",
      ownerGeneration: "1",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      runtimeControlUrl: "http://bin-a:8080",
      sourceAdapter: browserAdapter,
      environment: {
        kind: "browser",
        browser: {
          available: true,
          profileReuseAfterRestart: true,
          power: { status: "stopping" },
        },
      },
    });
    assert.equal(hbStopping.ok, true);
    if (hbStopping.ok) {
      assert.equal(hbStopping.value.humanSession, undefined);
    }
    const blockedHumanDuringStopping = await humanStore.getHumanSession(
      "bin-a",
      sessionId,
    );
    assert.equal(blockedHumanDuringStopping.ok, true);
    if (blockedHumanDuringStopping.ok) {
      assert.equal(blockedHumanDuringStopping.value.queueReason, "bin_busy");
    }
    mock.sessions.delete(sessionId);
    const queuedDuringStopping = await runsStore.getRun("bin-a", queuedRunId);
    assert.equal(queuedDuringStopping.ok, true);
    if (queuedDuringStopping.ok) {
      assert.equal(queuedDuringStopping.value.queueReason, "bin_busy");
    }
    const blockedClaimDuringStopping = await runsStore.claimRun("bin-a", {
      runtimeId: "rt-a",
    });
    assert.deepEqual(blockedClaimDuringStopping, { ok: true, value: null });

    // 4. Unconfirmed previous owner blocks queued run with previous_execution_unconfirmed.
    mock.connections.set(
      "bin-a",
      makeConnection("bin-a", "rt-a", "stopped", "unconfirmed"),
    );
    const queuedUnconfirmed = await runsStore.getRun("bin-a", queuedRunId);
    assert.equal(queuedUnconfirmed.ok, true);
    if (queuedUnconfirmed.ok) {
      assert.equal(
        queuedUnconfirmed.value.queueReason,
        "previous_execution_unconfirmed",
      );
    }
    const blockedUnconfirmedClaim = await runsStore.claimRun("bin-a", {
      runtimeId: "rt-a",
    });
    assert.deepEqual(blockedUnconfirmedClaim, { ok: true, value: null });

    // 5. removeBin succeeds cleanly.
    const removed = await binStore.removeBin("bin-a");
    assert.deepEqual(removed, { ok: true, value: { id: "bin-a" } });
  });

  void it("enforces resident policy for non-reusable browser profiles and rejects enabling sleep", async () => {
    const nonReusableAdapter = {
      ...browserAdapter,
      id: "test.browser-ephemeral",
      environment: {
        browser: {
          required: true,
          profileReuseAfterRestart: false,
          profileReuseUnavailableReason:
            "Session tokens are stored in volatile memory.",
        },
      },
    };
    const mock = createInMemoryDatabase({
      bins: [
        {
          ...makeBin("bin-ephemeral"),
          sourceAdapter: nonReusableAdapter,
          runtimeSleepIdleTimeoutSeconds: null,
        },
        {
          ...makeBin("bin-upgraded"),
          sourceAdapter: nonReusableAdapter,
          runtimeSleepIdleTimeoutSeconds: 300,
        },
      ],
      connections: [],
      runs: [],
      humanSessions: [],
    });

    const binStore = createBinConfigurationStore(mock.database);
    const ephemeral = await binStore.getBin("bin-ephemeral");
    assert.equal(ephemeral.ok, true);
    if (ephemeral.ok) {
      assert.equal(ephemeral.value.runtimeSleep.idleTimeoutSeconds, null);
    }

    const upgraded = await binStore.getBin("bin-upgraded");
    assert.equal(upgraded.ok, true);
    if (upgraded.ok) {
      assert.equal(upgraded.value.runtimeSleep.idleTimeoutSeconds, null);
    }

    const rejected = await binStore.updateBin("bin-ephemeral", {
      runtimeSleep: { idleTimeoutSeconds: 60 },
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.status, 400);
      assert.equal(rejected.error.code, "invalid_configuration");
      assert.deepEqual(rejected.error.path, [
        "runtimeSleep",
        "idleTimeoutSeconds",
      ]);
      assert.match(
        rejected.error.message,
        /Session tokens are stored in volatile memory\./u,
      );
    }

    const residentAccepted = await binStore.updateBin("bin-ephemeral", {
      runtimeSleep: { idleTimeoutSeconds: null },
    });
    assert.equal(residentAccepted.ok, true);
  });

  void it("wakes sleeping containers on human open, injects host port on ready, and marks work completed after runtime close confirmation", async () => {
    const mock = createInMemoryDatabase({
      bins: [makeBin("bin-human")],
      connections: [
        {
          ...makeConnection("bin-human", "rt-old", "ready"),
          disconnected: true,
        },
      ],
      containers: [
        {
          binId: "bin-human",
          composeProject: "binny",
          composeService: "browser-one",
          containerId: "cid-human",
          lifecyclePhase: "sleeping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
      runs: [],
      humanSessions: [],
    });

    const wakeCalls: string[] = [];
    const workCompletedCalls: string[] = [];
    let liveHostPort: number | null = 32_768;
    const coordinatorStub = {
      requestWake(binId: string) {
        wakeCalls.push(binId);
      },
      async onRuntimeHeartbeat() {},
      async markWorkCompleted(binId: string) {
        workCompletedCalls.push(binId);
      },
      async resolveVncHostPort() {
        return liveHostPort;
      },
    };

    const humanStore = createHumanSessionStore(mock.database, {
      containerCoordinator: coordinatorStub as unknown as Parameters<
        typeof createHumanSessionStore
      >[1] extends infer O
        ? O extends { readonly containerCoordinator?: infer C }
          ? C
          : never
        : never,
    });
    const runtimeStore = createRuntimeConnectionStore(mock.database, {
      containerCoordinator: coordinatorStub as unknown as Parameters<
        typeof createRuntimeConnectionStore
      >[1] extends infer O
        ? O extends { readonly containerCoordinator?: infer C }
          ? C
          : never
        : never,
    });

    const opened = await humanStore.requestHumanSession("bin-human");
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.value.status, "pending");
    assert.equal(opened.value.queueReason, "runtime_sleeping");
    assert.equal("port" in opened.value, false);
    assert.match(opened.value.password, /^[A-Za-z0-9]{8}$/u);
    assert.deepEqual(wakeCalls, ["bin-human"]);

    mock.containers.get("bin-human")!.lifecyclePhase = "waking";
    const whileWaking = await humanStore.getHumanSession(
      "bin-human",
      opened.value.sessionId,
    );
    assert.equal(whileWaking.ok, true);
    if (whileWaking.ok) {
      assert.equal(whileWaking.value.status, "pending");
      assert.equal(whileWaking.value.queueReason, "runtime_waking");
      assert.equal(whileWaking.value.port, undefined);
    }

    // Woken runtime reconnects with a new runtimeId + generation and promotes pending -> opening.
    mock.containers.get("bin-human")!.lifecyclePhase = "running";
    const hbOpen = await runtimeStore.heartbeat("bin-human", {
      protocolVersion: runtimeProtocolVersion,
      runtimeId: "rt-new",
      ownerGeneration: "2",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      activeHumanSession: null,
      runtimeControlUrl: "http://bin-human:8080",
      sourceAdapter: browserAdapter,
      environment: {
        kind: "browser",
        browser: {
          available: true,
          profileReuseAfterRestart: true,
          power: { status: "ready" },
        },
      },
    });
    assert.equal(hbOpen.ok, true);
    if (!hbOpen.ok) return;
    assert.deepEqual(hbOpen.value.humanSession, {
      sessionId: opened.value.sessionId,
      action: "open",
      password: opened.value.password,
      connectTimeoutMs: 60_000,
    });

    // If the heartbeat response is lost, a retry heartbeat re-delivers the exact same password.
    const hbOpenRetry = await runtimeStore.heartbeat("bin-human", {
      protocolVersion: runtimeProtocolVersion,
      runtimeId: "rt-new",
      ownerGeneration: "2",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      activeHumanSession: null,
      runtimeControlUrl: "http://bin-human:8080",
      sourceAdapter: browserAdapter,
      environment: {
        kind: "browser",
        browser: {
          available: true,
          profileReuseAfterRestart: true,
          power: { status: "ready" },
        },
      },
    });
    assert.equal(hbOpenRetry.ok, true);
    if (!hbOpenRetry.ok) return;
    assert.deepEqual(hbOpenRetry.value.humanSession, {
      sessionId: opened.value.sessionId,
      action: "open",
      password: opened.value.password,
      connectTimeoutMs: 60_000,
    });

    // Runtime reports ready.
    const hbReady = await runtimeStore.heartbeat("bin-human", {
      protocolVersion: runtimeProtocolVersion,
      runtimeId: "rt-new",
      ownerGeneration: "2",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      activeHumanSession: {
        sessionId: opened.value.sessionId,
        phase: "ready",
        clientConnected: false,
      },
      humanSessionEvent: {
        sessionId: opened.value.sessionId,
        event: "ready",
      },
      runtimeControlUrl: "http://bin-human:8080",
      sourceAdapter: browserAdapter,
      environment: {
        kind: "browser",
        browser: {
          available: true,
          profileReuseAfterRestart: true,
          power: { status: "ready" },
        },
      },
    });
    assert.equal(hbReady.ok, true);
    assert.deepEqual(workCompletedCalls, []);

    const readyLookup = await humanStore.getHumanSession(
      "bin-human",
      opened.value.sessionId,
    );
    assert.equal(readyLookup.ok, true);
    if (readyLookup.ok) {
      assert.equal(readyLookup.value.status, "ready");
      assert.equal(readyLookup.value.port, 32_768);
      assert.equal("password" in readyLookup.value, false);
    }

    // Updated host port after container recreation is reflected dynamically.
    liveHostPort = 41_234;
    const refreshedLookup = await humanStore.getHumanSession(
      "bin-human",
      opened.value.sessionId,
    );
    assert.equal(refreshedLookup.ok, true);
    if (refreshedLookup.ok) {
      assert.equal(refreshedLookup.value.port, 41_234);
    }

    // Close requested: remains closing until runtime confirms VNC teardown.
    const closing = await humanStore.closeHumanSession(
      "bin-human",
      opened.value.sessionId,
    );
    assert.equal(closing.ok, true);
    if (closing.ok) {
      assert.equal(closing.value.status, "closing");
      assert.equal(closing.value.port, undefined);
    }
    assert.deepEqual(workCompletedCalls, []);

    // Runtime confirms closed -> marks work completed once.
    const hbClosed = await runtimeStore.heartbeat("bin-human", {
      protocolVersion: runtimeProtocolVersion,
      runtimeId: "rt-new",
      ownerGeneration: "2",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      activeHumanSession: null,
      humanSessionEvent: {
        sessionId: opened.value.sessionId,
        event: "closed",
      },
      runtimeControlUrl: "http://bin-human:8080",
      sourceAdapter: browserAdapter,
      environment: {
        kind: "browser",
        browser: {
          available: true,
          profileReuseAfterRestart: true,
          power: { status: "ready" },
        },
      },
    });
    assert.equal(hbClosed.ok, true);
    assert.deepEqual(workCompletedCalls, ["bin-human"]);
  });

  void it("reconciles active and terminated ready/opening/closing human sessions across server restart and unblocks queued runs", async () => {
    const queuedRunId = "55555555-5555-4555-8555-555555555550";
    const readySessionId = "55555555-5555-4555-8555-555555555555";
    const openingSessionId = "55555555-5555-4555-8555-555555555556";
    const closingSessionId = "55555555-5555-4555-8555-555555555557";
    const mock = createInMemoryDatabase({
      bins: [makeBin("bin-reconcile")],
      connections: [makeConnection("bin-reconcile", "rt-1", "ready")],
      runs: [makeQueuedRun(queuedRunId, "bin-reconcile")],
      humanSessions: [
        {
          ...makeHumanSession(readySessionId, "bin-reconcile", "ready"),
          runtimeId: "rt-1",
          ownerGeneration: 1n,
          readyAt: new Date(1000),
        },
      ],
    });
    const workCompletedCalls: string[] = [];
    const coordinatorStub = {
      requestWake() {},
      async onRuntimeHeartbeat() {},
      async markWorkCompleted(binId: string) {
        workCompletedCalls.push(binId);
      },
      async resolveVncHostPort() {
        return 39_001;
      },
    };
    const runtimeStore = createRuntimeConnectionStore(mock.database, {
      containerCoordinator: coordinatorStub as unknown as Parameters<
        typeof createRuntimeConnectionStore
      >[1] extends infer O
        ? O extends { readonly containerCoordinator?: infer C }
          ? C
          : never
        : never,
    });
    const humanStore = createHumanSessionStore(mock.database, {
      containerCoordinator: coordinatorStub as unknown as Parameters<
        typeof createHumanSessionStore
      >[1] extends infer O
        ? O extends { readonly containerCoordinator?: infer C }
          ? C
          : never
        : never,
    });
    const runsStore = createManualRunStore(mock.database);
    const heartbeatBase = {
      protocolVersion: runtimeProtocolVersion as typeof runtimeProtocolVersion,
      runtimeId: "rt-1",
      ownerGeneration: "1",
      ownerLockAcquired: true as const,
      activeRunId: null,
      claimInFlight: false,
      runtimeControlUrl: "http://bin-reconcile:8080",
      sourceAdapter: browserAdapter,
      environment: {
        kind: "browser" as const,
        browser: {
          available: true,
          profileReuseAfterRestart: true,
          power: { status: "ready" as const },
        },
      },
    };

    // 1. Ready session still held by runtime across server restart keeps queued run blocked.
    const hbStillActive = await runtimeStore.heartbeat("bin-reconcile", {
      ...heartbeatBase,
      activeHumanSession: {
        sessionId: readySessionId,
        phase: "ready",
        clientConnected: true,
      },
    });
    assert.equal(hbStillActive.ok, true);
    if (hbStillActive.ok) {
      assert.equal(hbStillActive.value.humanSession, undefined);
    }
    assert.deepEqual(workCompletedCalls, []);
    assert.deepEqual(
      await runsStore.claimRun("bin-reconcile", { runtimeId: "rt-1" }),
      { ok: true, value: null },
    );

    // 2. Ready session whose client disconnected during server downtime settles to closed and unblocks run scheduling.
    const hbReadyGone = await runtimeStore.heartbeat("bin-reconcile", {
      ...heartbeatBase,
      activeHumanSession: null,
    });
    assert.equal(hbReadyGone.ok, true);
    assert.deepEqual(workCompletedCalls, ["bin-reconcile"]);

    const finalReadyState = await humanStore.getHumanSession(
      "bin-reconcile",
      readySessionId,
    );
    assert.equal(finalReadyState.ok, true);
    if (finalReadyState.ok) {
      assert.equal(finalReadyState.value.status, "closed");
      assert.equal(finalReadyState.value.port, undefined);
    }
    const claimedAfterReadyGone = await runsStore.claimRun("bin-reconcile", {
      runtimeId: "rt-1",
    });
    assert.equal(claimedAfterReadyGone.ok, true);
    if (claimedAfterReadyGone.ok) {
      assert.equal(claimedAfterReadyGone.value?.runId, queuedRunId);
    }

    // 3. Opening session: advances to ready if runtime reports ready, or settles to closed if client already disconnected.
    mock.runs.set(queuedRunId, makeQueuedRun(queuedRunId, "bin-reconcile"));
    mock.sessions.set(openingSessionId, {
      ...makeHumanSession(openingSessionId, "bin-reconcile", "opening"),
      runtimeId: "rt-1",
      ownerGeneration: 1n,
      vncPasswordPending: "Ab12Cd34",
    });
    const hbOpeningReady = await runtimeStore.heartbeat("bin-reconcile", {
      ...heartbeatBase,
      activeHumanSession: {
        sessionId: openingSessionId,
        phase: "ready",
        clientConnected: true,
      },
    });
    assert.equal(hbOpeningReady.ok, true);
    assert.equal(mock.sessions.get(openingSessionId)?.status, "ready");
    assert.equal(mock.sessions.get(openingSessionId)?.vncPasswordPending, null);
    assert.deepEqual(workCompletedCalls, ["bin-reconcile"]);

    mock.sessions.set(openingSessionId, {
      ...makeHumanSession(openingSessionId, "bin-reconcile", "opening"),
      runtimeId: "rt-1",
      ownerGeneration: 1n,
      vncPasswordPending: "Ab12Cd34",
    });
    const hbOpeningGone = await runtimeStore.heartbeat("bin-reconcile", {
      ...heartbeatBase,
      activeHumanSession: null,
      humanSessionEvent: {
        sessionId: openingSessionId,
        event: "closed",
      },
    });
    assert.equal(hbOpeningGone.ok, true);
    assert.deepEqual(workCompletedCalls, ["bin-reconcile", "bin-reconcile"]);
    assert.equal(mock.sessions.get(openingSessionId)?.status, "closed");
    assert.equal(mock.sessions.get(openingSessionId)?.vncPasswordPending, null);
    const claimedAfterOpeningGone = await runsStore.claimRun("bin-reconcile", {
      runtimeId: "rt-1",
    });
    assert.equal(claimedAfterOpeningGone.ok, true);
    if (claimedAfterOpeningGone.ok) {
      assert.equal(claimedAfterOpeningGone.value?.runId, queuedRunId);
    }

    // 4. Closing session: re-emits close if still active on runtime, or settles to closed when activeHumanSession is null.
    mock.runs.set(queuedRunId, makeQueuedRun(queuedRunId, "bin-reconcile"));
    mock.sessions.set(closingSessionId, {
      ...makeHumanSession(closingSessionId, "bin-reconcile", "closing"),
      runtimeId: "rt-1",
      ownerGeneration: 1n,
    });
    const hbClosingStillActive = await runtimeStore.heartbeat("bin-reconcile", {
      ...heartbeatBase,
      activeHumanSession: {
        sessionId: closingSessionId,
        phase: "ready",
        clientConnected: true,
      },
    });
    assert.equal(hbClosingStillActive.ok, true);
    if (hbClosingStillActive.ok) {
      assert.deepEqual(hbClosingStillActive.value.humanSession, {
        sessionId: closingSessionId,
        action: "close",
      });
    }
    assert.deepEqual(workCompletedCalls, ["bin-reconcile", "bin-reconcile"]);
    assert.deepEqual(
      await runsStore.claimRun("bin-reconcile", { runtimeId: "rt-1" }),
      { ok: true, value: null },
    );

    const hbClosingGone = await runtimeStore.heartbeat("bin-reconcile", {
      ...heartbeatBase,
      activeHumanSession: null,
    });
    assert.equal(hbClosingGone.ok, true);
    assert.deepEqual(workCompletedCalls, [
      "bin-reconcile",
      "bin-reconcile",
      "bin-reconcile",
    ]);
    assert.equal(mock.sessions.get(closingSessionId)?.status, "closed");
    const claimedAfterClosingGone = await runsStore.claimRun("bin-reconcile", {
      runtimeId: "rt-1",
    });
    assert.equal(claimedAfterClosingGone.ok, true);
    if (claimedAfterClosingGone.ok) {
      assert.equal(claimedAfterClosingGone.value?.runId, queuedRunId);
    }
  });

  void it("expires queued pending and unready opening sessions without disturbing in-flight runs", async () => {
    const activeRunId = "66666666-6666-4666-8666-666666666666";
    const pendingSessionId = "77777777-7777-4777-8777-777777777777";
    const openingSessionId = "88888888-8888-4888-8888-888888888888";
    const mock = createInMemoryDatabase({
      bins: [makeBin("bin-expire-a"), makeBin("bin-expire-b")],
      connections: [
        makeConnection("bin-expire-a", "rt-a", "ready"),
        makeConnection("bin-expire-b", "rt-b", "ready"),
      ],
      runs: [
        {
          ...makeQueuedRun(activeRunId, "bin-expire-a", new Date(1000)),
          status: "executing",
          runtimeId: "rt-a",
          startedAt: new Date(1000),
        },
      ],
      humanSessions: [
        makeHumanSession(pendingSessionId, "bin-expire-a", "pending"),
        {
          ...makeHumanSession(openingSessionId, "bin-expire-b", "opening"),
          runtimeId: "rt-b",
          ownerGeneration: 1n,
          vncPasswordPending: "Ab12Cd34",
        },
      ],
    });
    const workCompletedCalls: string[] = [];
    const coordinatorStub = {
      requestWake() {},
      async onRuntimeHeartbeat() {},
      async markWorkCompleted(binId: string) {
        workCompletedCalls.push(binId);
      },
      async resolveVncHostPort() {
        return null;
      },
    };
    const humanStore = createHumanSessionStore(mock.database, {
      containerCoordinator: coordinatorStub as unknown as Parameters<
        typeof createHumanSessionStore
      >[1] extends infer O
        ? O extends { readonly containerCoordinator?: infer C }
          ? C
          : never
        : never,
    });

    const expiredCount = await humanStore.expirePendingHumanSessions(60_000);
    assert.equal(expiredCount, 2);
    assert.equal(mock.sessions.get(pendingSessionId)?.status, "closed");
    assert.equal(mock.sessions.get(openingSessionId)?.status, "closing");
    assert.equal(mock.sessions.get(openingSessionId)?.vncPasswordPending, null);
    assert.equal(mock.runs.get(activeRunId)?.status, "executing");
    assert.deepEqual(workCompletedCalls, ["bin-expire-a"]);
  });

  void it("reports runtime_sleeping when human open arrives while container is stopping before disconnect", async () => {
    const mock = createInMemoryDatabase({
      bins: [makeBin("bin-stopping")],
      connections: [makeConnection("bin-stopping", "rt-1", "stopping")],
      containers: [
        {
          binId: "bin-stopping",
          composeProject: "binny",
          composeService: "browser-one",
          containerId: "cid-stopping",
          lifecyclePhase: "stopping",
          containerStartedAt: "2026-11-20T00:00:00.000Z",
          stoppedContainerFinishedAt: null,
          idleSince: null,
          lastWakeError: null,
          updatedAt: new Date(),
        },
      ],
      runs: [],
      humanSessions: [],
    });

    const wakeCalls: string[] = [];
    const humanStore = createHumanSessionStore(mock.database, {
      containerCoordinator: {
        requestWake(binId: string) {
          wakeCalls.push(binId);
        },
      } as unknown as Parameters<
        typeof createHumanSessionStore
      >[1] extends infer O
        ? O extends { readonly containerCoordinator?: infer C }
          ? C
          : never
        : never,
    });

    const opened = await humanStore.requestHumanSession("bin-stopping");
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.value.status, "pending");
    assert.equal(opened.value.queueReason, "runtime_sleeping");
    assert.deepEqual(wakeCalls, ["bin-stopping"]);
  });
});
