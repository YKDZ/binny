import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  binErrorSchema,
  humanSessionQueueReasonSchema,
  manualRunExecutionSchema,
  manualRunQueueReasonSchema,
  publicApiProtocolVersion,
  runtimeHeartbeatInputSchema,
  runtimeHumanSessionControlSchema,
  runtimeProtocolVersion,
} from "@binny/contracts";
import {
  archiveCommits,
  binConfigurations,
  humanSessions,
  manualRuns,
  runtimeConnections,
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
  browserIdleTimeoutSeconds: number | null;
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
  accessTokenHash: string;
  status: "pending" | "opening" | "ready" | "closing" | "closed" | "failed";
  runtimeId: string | null;
  ownerGeneration: bigint | null;
  runtimeTokenHash: string | null;
  gatewayClosed: boolean;
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
  runs: RunRow[];
  humanSessions: HumanSessionRow[];
}) {
  const bins = new Map(initial.bins.map((b) => [b.id, { ...b }]));
  const connections = new Map(
    initial.connections.map((c) => [c.binId, { ...c }]),
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
      const binId = findBinId(compiled.params);
      const bin = binId === undefined ? undefined : bins.get(binId);
      if (bin === undefined) return [];
      const conn = connections.get(bin.id);
      if (keys.includes("configuredSourceAdapter")) {
        return [
          {
            binId: bin.id,
            configuredSourceAdapter: bin.sourceAdapter,
            config: bin.config,
            configNativeValid: bin.configNativeValid,
            browserIdleTimeoutSeconds: bin.browserIdleTimeoutSeconds,
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
          },
        ];
      }
      return [{ ...bin }];
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
      const updated: HumanSessionRow[] = [];
      for (const row of sessions.values()) {
        if (sessionId !== undefined && row.sessionId !== sessionId) continue;
        if ("status" in values)
          row.status = values.status as HumanSessionRow["status"];
        if ("runtimeId" in values)
          row.runtimeId = values.runtimeId as string | null;
        if ("ownerGeneration" in values)
          row.ownerGeneration = values.ownerGeneration as bigint | null;
        if ("runtimeTokenHash" in values)
          row.runtimeTokenHash = values.runtimeTokenHash as string | null;
        if ("gatewayClosed" in values)
          row.gatewayClosed = Boolean(values.gatewayClosed);
        if ("runtimeClosed" in values)
          row.runtimeClosed = Boolean(values.runtimeClosed);
        if ("failure" in values) row.failure = values.failure;
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
    browserIdleTimeoutSeconds: 300,
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
    accessTokenHash: `hash-${sessionId}`,
    status,
    runtimeId: null,
    ownerGeneration: null,
    runtimeTokenHash: null,
    gatewayClosed: false,
    runtimeClosed: false,
    failure: null,
    requestedAt: now,
    updatedAt: now,
    readyAt: null,
    closedAt: null,
  };
}

void describe("independent browser bins without cross-bin capacity", () => {
  void it("removes cross-bin browser capacity protocol fields and bumps protocol versions", () => {
    assert.equal(runtimeProtocolVersion, 8);
    assert.ok(publicApiProtocolVersion >= 7);

    assert.equal(
      manualRunQueueReasonSchema.safeParse("browser_capacity_exhausted")
        .success,
      false,
    );
    assert.equal(
      humanSessionQueueReasonSchema.safeParse("browser_capacity_exhausted")
        .success,
      false,
    );
    assert.equal(
      binErrorSchema.safeParse({
        error: { code: "browser_capacity_active", message: "active" },
      }).success,
      false,
    );
    assert.equal(
      binErrorSchema.safeParse({
        error: { code: "browser_reservation_mismatch", message: "mismatch" },
      }).success,
      false,
    );

    const parsedExecution = manualRunExecutionSchema.safeParse({
      runId: "11111111-1111-4111-8111-111111111111",
      binId: "bin-a",
      identityId: "bin-a",
      sourceAdapterId: browserAdapter.id,
      sourceAdapterVersion: browserAdapter.version,
      action: "check",
      params: {},
      config: {},
      referenceTime: new Date().toISOString(),
      browserReservationId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(parsedExecution.success, false);

    const parsedControl = runtimeHumanSessionControlSchema.safeParse({
      sessionId: "33333333-3333-4333-8333-333333333333",
      action: "open",
      tunnelToken: "tok",
      browserReservationId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(parsedControl.success, false);

    const oldProtocolHeartbeat = runtimeHeartbeatInputSchema.safeParse({
      protocolVersion: 7,
      runtimeId: "rt-1",
      ownerGeneration: "1",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      runtimeControlUrl: "http://rt-1:8080",
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
    assert.equal(oldProtocolHeartbeat.success, false);

    const parsedHeartbeat = runtimeHeartbeatInputSchema.parse({
      protocolVersion: runtimeProtocolVersion,
      runtimeId: "rt-1",
      ownerGeneration: "1",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      runtimeControlUrl: "http://rt-1:8080",
      sourceAdapter: browserAdapter,
      environment: {
        kind: "browser",
        browser: {
          available: true,
          profileReuseAfterRestart: true,
          power: { status: "ready" },
        },
      },
      browserPowerEvent: {
        reservationId: "22222222-2222-4222-8222-222222222222",
        event: "ready",
      },
    });
    assert.equal("browserPowerEvent" in parsedHeartbeat, false);
  });

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
    assert.equal("browserReservationId" in claimA.value, false);
    assert.equal("browserReservationId" in claimB.value, false);

    // Independent human sessions on two idle browser bins can open simultaneously.
    const sessionA = "33333333-3333-4333-8333-333333333333";
    const sessionB = "44444444-4444-4444-8444-444444444444";
    mock.runs.clear();
    mock.sessions.set(sessionA, makeHumanSession(sessionA, "bin-a", "pending"));
    mock.sessions.set(sessionB, makeHumanSession(sessionB, "bin-b", "pending"));

    const runtimeStore = createRuntimeConnectionStore(mock.database);
    const heartbeatPayload = (runtimeId: string, binId: string) => ({
      protocolVersion: runtimeProtocolVersion as 8,
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

    // 5. removeBin succeeds without browser_capacity_active.
    const removed = await binStore.removeBin("bin-a");
    assert.deepEqual(removed, { ok: true, value: { id: "bin-a" } });
  });
});
