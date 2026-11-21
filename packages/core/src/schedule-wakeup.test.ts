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
  schedules,
  type Database,
} from "@binny/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createManualRunListStore } from "./manual-run-list.ts";
import { createManualRunStore } from "./manual-run.ts";
import {
  createRuntimeContainerCoordinator,
  type ManagedContainerInspectResult,
  type RuntimeContainerDriver,
} from "./runtime-container.ts";
import { createScheduleStore } from "./schedule.ts";

const adapterManifest = {
  id: "rss-atom",
  version: "1.0.0",
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  extensionsSchema: { type: "object", additionalProperties: false },
  actions: {
    check: {
      description: "check",
      params: {
        type: "object",
        properties: { feed: { type: "string" } },
        additionalProperties: false,
      },
      output: { type: "object" },
    },
    collect: {
      description: "collect",
      params: {
        type: "object",
        properties: { feed: { type: "string" }, date: { type: "string" } },
        additionalProperties: false,
      },
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

type ScheduleRow = {
  scheduleId: string;
  binId: string;
  expression: string;
  timeZone: string;
  action: string;
  params: unknown;
  overlapPolicy: "queue" | "skip";
  enabled: boolean;
  nextDueAt: Date;
  lastSkip: unknown;
  lastError: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type RunRow = {
  runId: string;
  binId: string;
  identityId: string;
  sourceAdapterSnapshot: unknown;
  sourceAdapterId: string;
  sourceAdapterVersion: string;
  action: string;
  params: unknown;
  configSnapshot: unknown;
  referenceTime: Date;
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
  startedAt: Date | null;
  finishedAt: Date | null;
};

const dialect = new PgDialect();

function compileWhere(clause: unknown): {
  readonly sql: string;
  readonly params: readonly unknown[];
} {
  if (clause === undefined) return { sql: "", params: [] };
  return dialect.sqlToQuery(clause as SQL);
}

function toIsoMicros(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/\.(\d{3})Z$/u, ".$1000Z");
}

function createSliceFakeDatabase(initial: {
  bins?: BinRow[];
  connections?: ConnectionRow[];
  containers?: ContainerRow[];
  schedules?: ScheduleRow[];
  runs?: RunRow[];
}) {
  const bins = new Map((initial.bins ?? []).map((b) => [b.id, { ...b }]));
  const connections = new Map(
    (initial.connections ?? []).map((c) => [c.binId, { ...c }]),
  );
  const containers = new Map(
    (initial.containers ?? []).map((c) => [c.binId, { ...c }]),
  );
  const scheduleRows = new Map(
    (initial.schedules ?? []).map((s) => [s.scheduleId, { ...s }]),
  );
  const runs = new Map((initial.runs ?? []).map((r) => [r.runId, { ...r }]));

  function findBinId(params: readonly unknown[]): string | undefined {
    for (const p of params) {
      if (typeof p === "string" && bins.has(p)) return p;
    }
    return undefined;
  }

  function findRunId(params: readonly unknown[]): string | undefined {
    for (const p of params) {
      if (typeof p === "string" && runs.has(p)) return p;
    }
    return undefined;
  }

  function findScheduleId(params: readonly unknown[]): string | undefined {
    for (const p of params) {
      if (typeof p === "string" && scheduleRows.has(p)) return p;
    }
    return undefined;
  }

  function isConnOnline(conn: ConnectionRow | undefined): boolean {
    if (conn === undefined || conn.disconnected) return false;
    return Date.now() - conn.lastHeartbeatAt.getTime() <= 8_000;
  }

  function resolveValue(value: unknown, fallback = new Date()): unknown {
    if (typeof value === "object" && value !== null && "queryChunks" in value) {
      return fallback;
    }
    return value;
  }

  function executeSelect(
    fields: Record<string, unknown> | undefined,
    table: unknown,
    clause: unknown,
  ): unknown[] {
    const compiled = compileWhere(clause);
    const keys = fields === undefined ? [] : Object.keys(fields);

    if (table === archiveCommits) return [];
    if (table === humanSessions) return [];

    if (table === binConfigurations) {
      const binId = findBinId(compiled.params);
      const list = binId
        ? [bins.get(binId)].filter((x): x is BinRow => x !== undefined)
        : [...bins.values()];
      return list.map((b) => {
        const conn = connections.get(b.id);
        const container = containers.get(b.id);
        if (keys.includes("configuredSourceAdapter")) {
          return {
            binId: b.id,
            configuredSourceAdapter: b.sourceAdapter,
            config: b.config,
            configNativeValid: b.configNativeValid,
            runtimeSleepIdleTimeoutSeconds: b.runtimeSleepIdleTimeoutSeconds,
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
        }
        return { ...b };
      });
    }

    if (table === runtimeConnections) {
      const binId = findBinId(compiled.params);
      const list = binId
        ? [connections.get(binId)].filter(
            (x): x is ConnectionRow => x !== undefined,
          )
        : [...connections.values()];
      return list.map((c) => ({
        ...c,
        heartbeatFresh: isConnOnline(c),
        ...(keys.includes("matches") ? { matches: true } : {}),
      }));
    }

    if (table === runtimeContainers) {
      const binId = findBinId(compiled.params);
      if (binId !== undefined) {
        const c = containers.get(binId);
        return c === undefined ? [] : [{ ...c }];
      }
      return [...containers.values()].map((c) => ({ ...c }));
    }

    if (table === schedules) {
      const scheduleId = findScheduleId(compiled.params);
      let rows =
        scheduleId !== undefined
          ? [scheduleRows.get(scheduleId)].filter(
              (s): s is ScheduleRow => s !== undefined,
            )
          : [...scheduleRows.values()];
      if (compiled.sql.includes('"enabled" =')) {
        rows = rows.filter((s) => s.enabled);
      }
      if (compiled.sql.includes('"next_due_at" <=')) {
        const cutoffParam = compiled.params.find(
          (p) =>
            p instanceof Date ||
            (typeof p === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(p)),
        );
        const cutoffMs =
          cutoffParam instanceof Date
            ? cutoffParam.getTime()
            : typeof cutoffParam === "string"
              ? Date.parse(cutoffParam)
              : Number.NaN;
        if (Number.isFinite(cutoffMs)) {
          rows = rows.filter((s) => s.nextDueAt.getTime() <= cutoffMs);
        }
      }
      return rows.map((s) => ({ ...s }));
    }

    if (table === manualRuns) {
      const binId = findBinId(compiled.params);
      const runId = findRunId(compiled.params);
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
          return {
            ...run,
            runtimeOnline: isConnOnline(conn),
            earlierRunActive: binRuns.some(
              (other) =>
                other.status === "executing" || other.status === "cancelling",
            ),
            previousExecutionUnconfirmed: conn?.ownerState === "unconfirmed",
            humanSessionActive: false,
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

      if (keys.includes("createdAtIso")) {
        rows = rows.filter((r) =>
          ["queued", "executing", "cancelling"].includes(r.status),
        );
        return rows.map((r) => ({
          runId: r.runId,
          binId: r.binId,
          status: r.status,
          createdAtIso: toIsoMicros(r.createdAt),
        }));
      }

      if (
        keys.includes("triggerType") &&
        keys.includes("sourceAdapterSnapshot") &&
        !keys.includes("params")
      ) {
        return rows
          .toSorted(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.binId.localeCompare(a.binId) ||
              b.runId.localeCompare(a.runId),
          )
          .map((r) => ({
            runId: r.runId,
            binId: r.binId,
            action: r.action,
            triggerType: r.triggerType,
            status: r.status,
            sourceAdapterSnapshot: r.sourceAdapterSnapshot,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            failure: r.failure,
            createdAt: toIsoMicros(r.createdAt),
          }));
      }

      if (compiled.sql.includes("status")) {
        const statuses = compiled.params.filter(
          (p): p is string =>
            typeof p === "string" &&
            [
              "queued",
              "executing",
              "cancelling",
              "completed",
              "failed",
              "cancelled",
            ].includes(p),
        );
        if (statuses.length > 0) {
          rows = rows.filter((r) => statuses.includes(r.status));
        }
      }

      if (keys.includes("params")) {
        rows = rows
          .filter((r) => r.status === "queued")
          .toSorted(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.runId.localeCompare(b.runId),
          );
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
    const builder = Object.assign(
      Promise.resolve().then(() => executeSelect(fields, table, whereClause)),
      {
        leftJoin() {
          return builder;
        },
        where(clause: unknown) {
          whereClause = clause;
          return builder;
        },
        orderBy() {
          return builder;
        },
        limit() {
          return builder;
        },
        for() {
          return builder;
        },
      },
    );
    return builder;
  }

  function createInsertBuilder(table: unknown) {
    return {
      values(values: Record<string, unknown>) {
        const applyInsert = (
          conflictMode: "error" | "update" | "nothing",
          setValues?: Record<string, unknown>,
        ) => {
          if (table === manualRuns) {
            const now = new Date();
            const row: RunRow = {
              runId: String(values.runId),
              binId: String(values.binId),
              identityId: String(values.identityId),
              sourceAdapterSnapshot: structuredClone(
                values.sourceAdapterSnapshot,
              ),
              sourceAdapterId: String(values.sourceAdapterId),
              sourceAdapterVersion: String(values.sourceAdapterVersion),
              action: String(values.action),
              params: structuredClone(values.params),
              configSnapshot: structuredClone(values.configSnapshot),
              referenceTime:
                values.referenceTime instanceof Date
                  ? values.referenceTime
                  : now,
              triggerType: values.triggerType as "manual" | "schedule",
              scheduleId: (values.scheduleId as string | null) ?? null,
              scheduledFor: (values.scheduledFor as Date | null) ?? null,
              status: values.status as RunRow["status"],
              runtimeId: null,
              completedScopes: [],
              failure: null,
              output: null,
              report: null,
              cancelRequestedAt: null,
              stopConfirmedAt: null,
              createdAt: now,
              startedAt: null,
              finishedAt: null,
            };
            runs.set(row.runId, row);
            return [{ ...row }];
          }
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
              return [{ ...next }];
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
            return [{ ...created }];
          }
          return [];
        };

        return Object.assign(
          Promise.resolve().then(() => applyInsert("error")),
          {
            onConflictDoUpdate(opts: { set: Record<string, unknown> }) {
              const rows = applyInsert("update", opts.set);
              return Object.assign(Promise.resolve(rows), {
                returning: () => Promise.resolve(rows),
              });
            },
            onConflictDoNothing() {
              const rows = applyInsert("nothing");
              return Object.assign(Promise.resolve(rows), {
                returning: () => Promise.resolve(rows),
              });
            },
            returning: () => Promise.resolve(applyInsert("error")),
          },
        );
      },
    };
  }

  function createUpdateBuilder(table: unknown) {
    return {
      set(values: Record<string, unknown>) {
        return {
          where(clause: unknown) {
            const compiled = compileWhere(clause);
            const applyUpdate = () => {
              if (table === runtimeContainers) {
                const binId = findBinId(compiled.params);
                if (binId === undefined) return [];
                const row = containers.get(binId);
                if (row === undefined) return [];
                for (const [k, v] of Object.entries(values)) {
                  (row as Record<string, unknown>)[k] = resolveValue(v);
                }
                return [{ ...row }];
              }
              if (table === runtimeConnections) {
                const binId = findBinId(compiled.params);
                if (binId === undefined) return [];
                const row = connections.get(binId);
                if (row === undefined) return [];
                for (const [k, v] of Object.entries(values)) {
                  (row as Record<string, unknown>)[k] = resolveValue(v);
                }
                return [{ ...row }];
              }
              if (table === schedules) {
                const scheduleId = findScheduleId(compiled.params);
                if (scheduleId === undefined) return [];
                const row = scheduleRows.get(scheduleId);
                if (row === undefined) return [];
                for (const [k, v] of Object.entries(values)) {
                  (row as Record<string, unknown>)[k] = resolveValue(v);
                }
                return [{ ...row }];
              }
              if (table === manualRuns) {
                const runId = findRunId(compiled.params);
                if (runId === undefined) return [];
                const row = runs.get(runId);
                if (row === undefined) return [];
                if (
                  compiled.sql.includes('"status" =') &&
                  compiled.params.includes("queued") &&
                  row.status !== "queued"
                ) {
                  return [];
                }
                for (const [k, v] of Object.entries(values)) {
                  (row as Record<string, unknown>)[k] = resolveValue(v);
                }
                return [{ ...row }];
              }
              return [];
            };
            let applied: unknown[] | undefined;
            const runUpdateOnce = () => {
              if (applied === undefined) applied = applyUpdate();
              return applied;
            };
            return Object.assign(Promise.resolve().then(runUpdateOnce), {
              returning: () => Promise.resolve().then(runUpdateOnce),
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
    schedules: scheduleRows,
    runs,
  };
}

function createFakeDriver(initial: readonly ManagedContainerInspectResult[]) {
  const containers = new Map(
    initial.map((entry) => [entry.containerId, { ...entry }]),
  );
  const startCalls: string[] = [];
  let beforeStart:
    | ((entry: ManagedContainerInspectResult) => Promise<void> | void)
    | undefined;
  let onStart:
    | ((entry: ManagedContainerInspectResult) => Promise<void> | void)
    | undefined;

  const driver: RuntimeContainerDriver = {
    async discoverManagedContainers() {
      return [...containers.values()].map((c) => ({ ...c }));
    },
    async inspectContainer(containerId) {
      const entry = containers.get(containerId);
      return entry === undefined ? null : { ...entry };
    },
    async startContainer(containerId) {
      startCalls.push(containerId);
      const entry = containers.get(containerId);
      if (entry === undefined) return "not_found";
      await beforeStart?.(entry);
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
      const entry = containers.get(containerId);
      if (entry === undefined) return "not_found";
      containers.set(containerId, {
        ...entry,
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
    setBeforeStart(
      handler:
        | ((entry: ManagedContainerInspectResult) => Promise<void> | void)
        | undefined,
    ) {
      beforeStart = handler;
    },
    setOnStart(
      handler:
        | ((entry: ManagedContainerInspectResult) => Promise<void> | void)
        | undefined,
    ) {
      onStart = handler;
    },
  };
}

function makeBin(binId: string, overrides: Partial<BinRow> = {}): BinRow {
  const now = new Date();
  return {
    id: binId,
    sourceAdapter: adapterManifest,
    identityId: binId,
    config: {},
    configNativeValid: true,
    runtimeSleepIdleTimeoutSeconds: 0,
    status: "active",
    persistentState: null,
    sourceAccessState: null,
    lastIssuedOwnerGeneration: "1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSleepingContainer(
  binId: string,
  containerId = `cid-${binId}`,
): ContainerRow {
  return {
    binId,
    composeProject: "binny",
    composeService: `svc-${binId}`,
    containerId,
    lifecyclePhase: "sleeping",
    containerStartedAt: "2026-11-20T00:00:00.000Z",
    stoppedContainerFinishedAt: "2026-11-20T00:05:00.000Z",
    idleSince: null,
    lastWakeError: null,
    updatedAt: new Date(),
  };
}

function makeSleepingInspect(
  binId: string,
  containerId = `cid-${binId}`,
): ManagedContainerInspectResult {
  return {
    containerId,
    composeProject: "binny",
    composeService: `svc-${binId}`,
    binId,
    status: "exited",
    exitCode: 0,
    oomKilled: false,
    startedAt: "2026-11-20T00:00:00.000Z",
    finishedAt: "2026-11-20T00:05:00.000Z",
    healthStatus: "none",
  };
}

void describe("scheduled wakeup vertical slice", () => {
  void it("wakes sleeping container only for enqueued scheduled runs and never wakes on overlap skip, disabled bin, invalid config, or overdue skip", async () => {
    const pastDue = new Date("2026-11-20T10:00:00.000Z");
    const db = createSliceFakeDatabase({
      bins: [
        makeBin("bin-active"),
        makeBin("bin-disabled", { status: "disabled" }),
        makeBin("bin-invalid", { configNativeValid: false }),
        makeBin("bin-overdue"),
      ],
      connections: [
        {
          binId: "bin-active",
          runtimeId: "rt-active",
          sourceAdapter: adapterManifest,
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
          disconnected: true,
          protocolVersion: runtimeProtocolVersion,
          runtimeControlUrl: "http://bin-active:8080",
          ownerState: "confirmed",
          ownerGeneration: 1n,
        },
      ],
      containers: [
        makeSleepingContainer("bin-active"),
        makeSleepingContainer("bin-disabled"),
        makeSleepingContainer("bin-invalid"),
        makeSleepingContainer("bin-overdue"),
      ],
      schedules: [
        {
          scheduleId: "11111111-1111-4111-8111-111111111111",
          binId: "bin-active",
          expression: "0 * * * * *",
          timeZone: "UTC",
          action: "collect",
          params: { feed: "main", date: "today" },
          overlapPolicy: "skip",
          enabled: true,
          nextDueAt: pastDue,
          lastSkip: null,
          lastError: null,
          createdAt: new Date("2026-11-20T09:00:00.000Z"),
          updatedAt: new Date("2026-11-20T09:00:00.000Z"),
        },
        {
          scheduleId: "22222222-2222-4222-8222-222222222222",
          binId: "bin-disabled",
          expression: "0 * * * * *",
          timeZone: "UTC",
          action: "collect",
          params: { feed: "main" },
          overlapPolicy: "queue",
          enabled: true,
          nextDueAt: pastDue,
          lastSkip: null,
          lastError: null,
          createdAt: new Date("2026-11-20T09:00:00.000Z"),
          updatedAt: new Date("2026-11-20T09:00:00.000Z"),
        },
        {
          scheduleId: "33333333-3333-4333-8333-333333333333",
          binId: "bin-invalid",
          expression: "0 * * * * *",
          timeZone: "UTC",
          action: "collect",
          params: { feed: "main" },
          overlapPolicy: "queue",
          enabled: true,
          nextDueAt: pastDue,
          lastSkip: null,
          lastError: null,
          createdAt: new Date("2026-11-20T09:00:00.000Z"),
          updatedAt: new Date("2026-11-20T09:00:00.000Z"),
        },
        {
          scheduleId: "44444444-4444-4444-8444-444444444444",
          binId: "bin-overdue",
          expression: "0 * * * * *",
          timeZone: "UTC",
          action: "collect",
          params: { feed: "main" },
          overlapPolicy: "queue",
          enabled: true,
          nextDueAt: pastDue,
          lastSkip: null,
          lastError: null,
          createdAt: new Date("2026-11-20T09:00:00.000Z"),
          updatedAt: new Date("2026-11-20T09:00:00.000Z"),
        },
      ],
    });
    const fakeDriver = createFakeDriver([
      makeSleepingInspect("bin-active"),
      makeSleepingInspect("bin-disabled"),
      makeSleepingInspect("bin-invalid"),
      makeSleepingInspect("bin-overdue"),
    ]);

    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      wakeTimeoutMs: 1_000,
      wakeRetryBaseDelayMs: 30,
      wakeRetryMaxDelayMs: 60,
    });
    const scheduleStore = createScheduleStore(db.database, {
      containerCoordinator: coordinator,
    });
    const runStore = createManualRunStore(db.database, {
      containerCoordinator: coordinator,
    });

    // Hold active wake on bin-active temporarily via a failure on attempt 1 so we can observe overlap skip without extra start.
    let failFirstWake = true;
    fakeDriver.setBeforeStart((entry) => {
      if (entry.binId === "bin-active" && failFirstWake) {
        failFirstWake = false;
        throw new Error("temporary socket outage");
      }
    });
    fakeDriver.setOnStart(async (entry) => {
      if (entry.binId !== "bin-active") return;
      const conn = db.connections.get("bin-active")!;
      conn.disconnected = false;
      conn.lastHeartbeatAt = new Date();
      conn.ownerState = "confirmed";
      await coordinator.onRuntimeHeartbeat({
        binId: "bin-active",
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
        idleTimeoutSeconds: 0,
      });
    });

    try {
      // First skip overdue schedule for bin-overdue only (remove temporarily or run skipOverdueSchedules on bin-overdue)
      const overdueSchedule = db.schedules.get(
        "44444444-4444-4444-8444-444444444444",
      )!;
      // Temporarily disable other 3, run skipOverdueSchedules, verify bin-overdue didn't wake.
      for (const id of [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ]) {
        db.schedules.get(id)!.enabled = false;
      }
      await scheduleStore.skipOverdueSchedules();
      assert.deepEqual(fakeDriver.startCalls, []);
      assert.ok(overdueSchedule.nextDueAt.getTime() > Date.now());
      assert.equal(db.runs.size, 0);

      for (const id of [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ]) {
        db.schedules.get(id)!.enabled = true;
      }

      // Trigger due schedules: bin-active creates 1 queued run, bin-disabled/invalid fail without waking.
      await scheduleStore.processDueSchedules();
      await new Promise((r) => setTimeout(r, 15));

      assert.equal(db.runs.size, 1);
      const [createdRun] = [...db.runs.values()];
      assert.ok(createdRun !== undefined);
      assert.equal(createdRun.binId, "bin-active");
      assert.equal(
        createdRun.referenceTime.toISOString(),
        pastDue.toISOString(),
      );

      // While bin-active run is still queued & backing off, simulate second due trigger with overlapPolicy: "skip".
      const activeSchedule = db.schedules.get(
        "11111111-1111-4111-8111-111111111111",
      )!;
      const secondDue = new Date("2026-11-20T10:01:00.000Z");
      activeSchedule.nextDueAt = secondDue;
      await scheduleStore.processDueSchedules();
      assert.equal(db.runs.size, 1);
      assert.equal(
        (activeSchedule.lastSkip as { reason: string }).reason,
        "overlap",
      );

      // Wait for backoff retry to wake bin-active and verify ONLY the original run claims.
      const deadline = Date.now() + 1_500;
      while (
        db.containers.get("bin-active")?.lifecyclePhase !== "running" &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(db.containers.get("bin-active")?.lifecyclePhase, "running");
      assert.ok(
        fakeDriver.startCalls.every((cid) => cid === "cid-bin-active"),
        "only bin-active should ever have startContainer called",
      );

      const claimed = await runStore.claimRun("bin-active", {
        runtimeId: "rt-active",
      });
      assert.equal(claimed.ok, true);
      if (claimed.ok) {
        assert.equal(claimed.value?.runId, createdRun.runId);
        assert.deepEqual(claimed.value?.params, {
          feed: "main",
          date: "today",
        });
        assert.equal(claimed.value?.referenceTime, pastDue.toISOString());
      }
    } finally {
      await coordinator.close();
    }
  });

  void it("surfaces queueReason and lastWakeError in getRun and listRuns during transient wake failure, preserves original run on recovery, and cancels cleanly", async () => {
    const dueTime = new Date("2026-11-20T11:00:00.000Z");
    const db = createSliceFakeDatabase({
      bins: [makeBin("bin-one")],
      connections: [
        {
          binId: "bin-one",
          runtimeId: "rt-one",
          sourceAdapter: adapterManifest,
          environment: {
            kind: "lightweight",
            browser: {
              available: false,
              profileReuseAfterRestart: false,
              power: { status: "unavailable" },
            },
          },
          sourceStateSnapshot: null,
          lastHeartbeatAt: new Date(Date.now() - 60_000),
          disconnected: true,
          protocolVersion: runtimeProtocolVersion,
          runtimeControlUrl: "http://bin-one:8080",
          ownerState: "confirmed",
          ownerGeneration: 1n,
        },
      ],
      containers: [makeSleepingContainer("bin-one")],
      schedules: [
        {
          scheduleId: "55555555-5555-4555-8555-555555555555",
          binId: "bin-one",
          expression: "0 * * * * *",
          timeZone: "UTC",
          action: "collect",
          params: { feed: "rss", date: "yesterday" },
          overlapPolicy: "queue",
          enabled: true,
          nextDueAt: dueTime,
          lastSkip: null,
          lastError: null,
          createdAt: new Date("2026-11-20T10:00:00.000Z"),
          updatedAt: new Date("2026-11-20T10:00:00.000Z"),
        },
      ],
    });
    const fakeDriver = createFakeDriver([makeSleepingInspect("bin-one")]);
    fakeDriver.setBeforeStart(() => {
      throw new Error("Docker Engine temporarily unreachable");
    });

    const coordinator = createRuntimeContainerCoordinator({
      database: db.database,
      driver: fakeDriver.driver,
      wakeTimeoutMs: 1_000,
      wakeRetryBaseDelayMs: 100,
      wakeRetryMaxDelayMs: 200,
    });
    const scheduleStore = createScheduleStore(db.database, {
      containerCoordinator: coordinator,
    });
    const runStore = createManualRunStore(db.database, {
      containerCoordinator: coordinator,
    });
    const runListStore = createManualRunListStore(db.database);

    try {
      await scheduleStore.processDueSchedules();
      await new Promise((r) => setTimeout(r, 25));

      const [queuedRow] = [...db.runs.values()];
      assert.ok(queuedRow !== undefined);

      const getResult = await runStore.getRun("bin-one", queuedRow.runId);
      assert.equal(getResult.ok, true);
      if (getResult.ok) {
        assert.equal(getResult.value.status, "queued");
        assert.equal(getResult.value.queueReason, "runtime_sleeping");
        assert.equal(
          getResult.value.lastWakeError?.code,
          "runtime_wake_start_failed",
        );
        assert.match(
          getResult.value.lastWakeError?.message ?? "",
          /temporarily unreachable/u,
        );
        assert.equal(getResult.value.referenceTime, dueTime.toISOString());
      }

      const listResult = await runListStore.listRuns({ binId: "bin-one" });
      assert.equal(listResult.ok, true);
      if (listResult.ok) {
        assert.equal(listResult.value.runs.length, 1);
        assert.equal(listResult.value.runs[0]?.runId, queuedRow.runId);
        assert.equal(listResult.value.runs[0]?.queueReason, "runtime_sleeping");
        assert.equal(
          listResult.value.runs[0]?.lastWakeError?.code,
          "runtime_wake_start_failed",
        );
      }

      // Cancel while waiting for retry.
      const startsBeforeCancel = fakeDriver.startCalls.length;
      const cancelled = await runStore.cancelRun("bin-one", queuedRow.runId);
      assert.equal(cancelled.ok, true);
      if (cancelled.ok) {
        assert.equal(cancelled.value.status, "cancelled");
        assert.equal(cancelled.value.queueReason, undefined);
        assert.equal(cancelled.value.lastWakeError, undefined);
        assert.equal(
          cancelled.value.result?.stopReason.code,
          "cancelled_before_execution",
        );
      }

      const listAfterCancel = await runListStore.listRuns({ binId: "bin-one" });
      assert.equal(listAfterCancel.ok, true);
      if (listAfterCancel.ok) {
        assert.equal(listAfterCancel.value.runs[0]?.status, "cancelled");
        assert.equal(listAfterCancel.value.runs[0]?.queueReason, undefined);
        assert.equal(listAfterCancel.value.runs[0]?.lastWakeError, undefined);
      }

      await new Promise((r) => setTimeout(r, 150));
      assert.equal(fakeDriver.startCalls.length, startsBeforeCancel);
    } finally {
      await coordinator.close();
    }
  });
});
