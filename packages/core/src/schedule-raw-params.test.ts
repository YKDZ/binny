import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { runtimeProtocolVersion } from "@binny/contracts";
import {
  archiveCommits,
  binConfigurations,
  manualRuns,
  schedules,
  type Database,
} from "@binny/db";

import { createScheduleStore } from "./schedule.ts";

function buildManifest(options: { readonly withBudgetDefaults: boolean }) {
  return {
    id: "binny.source-adapter-linuxdo",
    version: options.withBudgetDefaults ? "1.0.0" : "1.0.1",
    environment: {
      browser: { required: true, profileReuseAfterRestart: true },
    },
    configSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        origin: { type: "string", format: "uri" },
      },
      required: ["origin"],
      additionalProperties: false,
    },
    extensionsSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    actions: {
      check: {
        description: "check",
        params: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        output: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      collect: {
        description: "collect",
        params: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        output: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      sync: {
        description: "sync",
        params: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            maxPages: {
              type: "integer",
              exclusiveMinimum: 0,
              maximum: 100,
              default: 20,
            },
            maxRequests: {
              type: "integer",
              exclusiveMinimum: 0,
              ...(options.withBudgetDefaults
                ? { default: 200, maximum: 500 }
                : {}),
            },
            maxElapsedMs: {
              type: "integer",
              exclusiveMinimum: 0,
              ...(options.withBudgetDefaults
                ? { default: 300_000, maximum: 900_000 }
                : {}),
            },
          },
          additionalProperties: false,
        },
        output: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
  };
}

type StoredScheduleRow = {
  scheduleId: string;
  binId: string;
  expression: string;
  timeZone: string;
  action: string;
  params: unknown;
  overlapPolicy: "skip" | "queue";
  enabled: boolean;
  nextDueAt: Date;
  lastSkip: unknown;
  lastError: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type StoredRunRow = {
  runId: string;
  binId: string;
  identityId: string;
  sourceAdapterSnapshot: unknown;
  sourceAdapterId: string;
  sourceAdapterVersion: string;
  action: string;
  params: unknown;
  configSnapshot: unknown;
  triggerType: "manual" | "schedule";
  scheduleId: string | null;
  scheduledFor: Date | null;
  cancelRequestedAt: Date | null;
  stopConfirmedAt: Date | null;
  createdAt: Date;
  referenceTime: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  completedScopes: string[];
  failure: unknown;
  output: unknown;
  report: unknown;
  status:
    | "queued"
    | "executing"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
};

function createScheduleMockDatabase(options: {
  readonly binId: string;
  readonly runtimeControlUrl: string;
  initialManifest: Record<string, unknown>;
}) {
  const bin = {
    id: options.binId,
    sourceAdapter: options.initialManifest,
    identityId: "identity-1",
    config: { origin: "https://linux.do" },
    configNativeValid: true,
    runtimeSleepIdleTimeoutSeconds: 300,
    status: "active" as const,
  };
  const connection = {
    binId: options.binId,
    runtimeId: "runtime-linuxdo",
    sourceAdapter: options.initialManifest,
    environment: {
      kind: "browser" as const,
      browser: {
        available: true,
        profileReuseAfterRestart: true,
        power: { status: "ready" as const },
      },
    },
    lastHeartbeatAt: new Date(),
    disconnected: false,
    ownerState: "confirmed" as const,
    ownerGeneration: 1n,
    protocolVersion: runtimeProtocolVersion,
    runtimeControlUrl: options.runtimeControlUrl,
    sourceStateSnapshot: {
      freshness: "current" as const,
      observedAt: new Date().toISOString(),
      sourceAccess: {
        status: "available" as const,
        lastAdmittedAt: {},
        cooldownByGroup: {},
      },
    },
  };
  const scheduleRows = new Map<string, StoredScheduleRow>();
  const runRows: StoredRunRow[] = [];

  function queryResult(table: unknown) {
    if (table === binConfigurations) {
      return [
        {
          ...bin,
          binId: bin.id,
          configuredSourceAdapter: bin.sourceAdapter,
          runtimeId: connection.runtimeId,
          runtimeSourceAdapter: connection.sourceAdapter,
          environment: connection.environment,
          lastHeartbeatAt: connection.lastHeartbeatAt,
          disconnected: connection.disconnected,
          ownerState: connection.ownerState,
          ownerGeneration: connection.ownerGeneration,
          protocolVersion: connection.protocolVersion,
          runtimeControlUrl: connection.runtimeControlUrl,
          sourceStateSnapshot: connection.sourceStateSnapshot,
        },
      ];
    }
    if (table === schedules) {
      return [...scheduleRows.values()].map((row) => ({ ...row }));
    }
    if (table === manualRuns) {
      return [];
    }
    if (table === archiveCommits) {
      return [];
    }
    return [];
  }

  function findMatchingScheduleId(clause: unknown): string | undefined {
    const seen = new WeakSet<object>();
    const stack: unknown[] = [clause];
    while (stack.length > 0) {
      const current = stack.pop();
      if (typeof current === "string") {
        if (scheduleRows.has(current)) return current;
        continue;
      }
      if (typeof current !== "object" || current === null) continue;
      if (seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        for (const item of current) stack.push(item);
      } else {
        for (const [key, value] of Object.entries(
          current as Record<string, unknown>,
        )) {
          if (key === "table" || key === "encoder") continue;
          stack.push(value);
        }
      }
    }
    return undefined;
  }

  function createSelectChain(table: unknown) {
    let targetScheduleId: string | undefined;
    const resolveRows = () => {
      const rows = queryResult(table);
      if (table === schedules && targetScheduleId !== undefined) {
        const single = scheduleRows.get(targetScheduleId);
        return single === undefined ? [] : [{ ...single }];
      }
      return rows;
    };
    const makeResult = () =>
      Object.assign(Promise.resolve(resolveRows()), {
        from(nextTable: unknown) {
          return createSelectChain(nextTable);
        },
        leftJoin() {
          return makeResult();
        },
        where(clause: unknown) {
          if (table === schedules && scheduleRows.size > 0) {
            targetScheduleId = findMatchingScheduleId(clause);
          }
          return makeResult();
        },
        orderBy() {
          return makeResult();
        },
        for() {
          return makeResult();
        },
        limit() {
          return makeResult();
        },
      });
    return makeResult();
  }

  function createInsertBuilder(table: unknown) {
    return {
      values(values: Record<string, unknown>) {
        return {
          returning() {
            const now = new Date();
            if (table === schedules) {
              const row: StoredScheduleRow = {
                scheduleId: String(values.scheduleId),
                binId: String(values.binId),
                expression: String(values.expression),
                timeZone: String(values.timeZone),
                action: String(values.action),
                params: structuredClone(values.params),
                overlapPolicy: values.overlapPolicy as "skip" | "queue",
                enabled: Boolean(values.enabled),
                nextDueAt: values.nextDueAt as Date,
                lastSkip: null,
                lastError: null,
                createdAt: now,
                updatedAt: now,
              };
              scheduleRows.set(row.scheduleId, row);
              return Promise.resolve([{ ...row }]);
            }
            if (table === manualRuns) {
              const row: StoredRunRow = {
                runId: values.runId as string,
                binId: values.binId as string,
                identityId: values.identityId as string,
                sourceAdapterSnapshot: structuredClone(
                  values.sourceAdapterSnapshot,
                ),
                sourceAdapterId: values.sourceAdapterId as string,
                sourceAdapterVersion: values.sourceAdapterVersion as string,
                action: values.action as string,
                params: structuredClone(values.params),
                configSnapshot: structuredClone(values.configSnapshot),
                triggerType: values.triggerType as "manual" | "schedule",
                scheduleId:
                  values.scheduleId === null
                    ? null
                    : (values.scheduleId as string),
                scheduledFor:
                  values.scheduledFor instanceof Date
                    ? values.scheduledFor
                    : null,
                cancelRequestedAt: null,
                stopConfirmedAt: null,
                createdAt: now,
                referenceTime:
                  values.referenceTime instanceof Date
                    ? values.referenceTime
                    : now,
                startedAt: null,
                finishedAt: null,
                completedScopes: [],
                failure: null,
                output: null,
                report: null,
                status: "queued",
              };
              runRows.push(row);
              return Promise.resolve([{ ...row }]);
            }
            return Promise.resolve([]);
          },
        };
      },
    };
  }

  function createUpdateBuilder(table: unknown) {
    return {
      set(values: Record<string, unknown>) {
        return {
          where(clause: unknown) {
            let updated: StoredScheduleRow | undefined;
            if (table === schedules) {
              const id = findMatchingScheduleId(clause);
              const row = id === undefined ? undefined : scheduleRows.get(id);
              if (id !== undefined && row !== undefined) {
                const next: StoredScheduleRow = {
                  ...row,
                  ...(typeof values.expression === "string"
                    ? { expression: values.expression }
                    : {}),
                  ...(typeof values.timeZone === "string"
                    ? { timeZone: values.timeZone }
                    : {}),
                  ...(typeof values.action === "string"
                    ? { action: values.action }
                    : {}),
                  ...(values.params !== undefined
                    ? { params: structuredClone(values.params) }
                    : {}),
                  ...(values.overlapPolicy !== undefined
                    ? {
                        overlapPolicy: values.overlapPolicy as "skip" | "queue",
                      }
                    : {}),
                  ...(values.nextDueAt instanceof Date
                    ? { nextDueAt: values.nextDueAt }
                    : {}),
                  ...(values.lastError !== undefined
                    ? { lastError: values.lastError }
                    : {}),
                  updatedAt: new Date(),
                };
                scheduleRows.set(id, next);
                updated = next;
              }
            }
            return Object.assign(Promise.resolve(), {
              returning() {
                return Promise.resolve(
                  updated === undefined ? [] : [{ ...updated }],
                );
              },
            });
          },
        };
      },
    };
  }

  const transaction = {
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          return createSelectChain(table);
        },
      };
    },
    insert(table: unknown) {
      return createInsertBuilder(table);
    },
    update(table: unknown) {
      return createUpdateBuilder(table);
    },
  };

  const database = {
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          return createSelectChain(table);
        },
      };
    },
    insert(table: unknown) {
      return createInsertBuilder(table);
    },
    update(table: unknown) {
      return createUpdateBuilder(table);
    },
    async transaction<T>(fn: (tx: typeof transaction) => Promise<T>) {
      return await fn(transaction);
    },
  } as unknown as Database;

  return {
    database,
    getScheduleRow: (id: string) => scheduleRows.get(id),
    markAllDue: () => {
      const past = new Date(Date.now() - 60_000);
      for (const [id, row] of scheduleRows.entries()) {
        scheduleRows.set(id, { ...row, nextDueAt: past });
      }
    },
    upgradeManifest: (nextManifest: Record<string, unknown>) => {
      bin.sourceAdapter = nextManifest;
      connection.sourceAdapter = nextManifest;
    },
    getRunRows: () => runRows,
  };
}

void describe("schedule raw parameter preservation across budget default removal", () => {
  void it("preserves omitted vs explicit old default budget params from creation through manifest upgrade and due execution", async () => {
    const validatedInputs: unknown[] = [];
    const runtimeServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly params?: unknown;
        };
        validatedInputs.push(body.params);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ valid: true }));
      });
    });
    await new Promise<void>((resolve) =>
      runtimeServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = runtimeServer.address();
    assert.ok(addr !== null && typeof addr !== "string");
    const controlUrl = `http://127.0.0.1:${String(addr.port)}`;

    try {
      const legacyManifest = buildManifest({ withBudgetDefaults: true });
      const upgradedManifest = buildManifest({ withBudgetDefaults: false });
      const mockDb = createScheduleMockDatabase({
        binId: "bin-linuxdo-schedules",
        runtimeControlUrl: controlUrl,
        initialManifest: legacyManifest,
      });
      const store = createScheduleStore(mockDb.database);

      // 1. Created under legacy manifest with omitted budgets -> must store `{}` verbatim (never inject 200 / 300_000)
      const omitted = await store.createSchedule("bin-linuxdo-schedules", {
        expression: "0 */30 * * * *",
        timeZone: "UTC",
        action: "sync",
        params: {},
        overlapPolicy: "skip",
      });
      assert.equal(omitted.ok, true, JSON.stringify(omitted));
      if (!omitted.ok) return;
      assert.deepEqual(omitted.value.params, {});
      assert.deepEqual(
        mockDb.getScheduleRow(omitted.value.scheduleId)?.params,
        {},
      );

      // 2. Created under legacy manifest with explicit old defaults (`200` / `300_000`) -> must retain user choices
      const explicitOldDefaults = await store.createSchedule(
        "bin-linuxdo-schedules",
        {
          expression: "0 */30 * * * *",
          timeZone: "UTC",
          action: "sync",
          params: { maxRequests: 200, maxElapsedMs: 300_000 },
          overlapPolicy: "skip",
        },
      );
      assert.equal(
        explicitOldDefaults.ok,
        true,
        JSON.stringify(explicitOldDefaults),
      );
      if (!explicitOldDefaults.ok) return;
      assert.deepEqual(explicitOldDefaults.value.params, {
        maxRequests: 200,
        maxElapsedMs: 300_000,
      });
      assert.deepEqual(
        mockDb.getScheduleRow(explicitOldDefaults.value.scheduleId)?.params,
        { maxRequests: 200, maxElapsedMs: 300_000 },
      );

      // 3. Created with only one explicit dimension -> preserves only that dimension
      const singleDimension = await store.createSchedule(
        "bin-linuxdo-schedules",
        {
          expression: "0 */30 * * * *",
          timeZone: "UTC",
          action: "sync",
          params: { maxRequests: 200 },
          overlapPolicy: "skip",
        },
      );
      assert.equal(singleDimension.ok, true, JSON.stringify(singleDimension));
      if (!singleDimension.ok) return;
      assert.deepEqual(singleDimension.value.params, { maxRequests: 200 });

      // 4. Updating expression without touching params preserves raw omitted vs explicit values
      const updatedOmitted = await store.updateSchedule(
        "bin-linuxdo-schedules",
        omitted.value.scheduleId,
        { expression: "0 0 * * * *" },
      );
      assert.equal(updatedOmitted.ok, true);
      if (!updatedOmitted.ok) return;
      assert.deepEqual(updatedOmitted.value.params, {});

      // 5. Upgrade manifest to optional budgets (no defaults) and dispatch due runs
      mockDb.upgradeManifest(upgradedManifest);
      mockDb.markAllDue();
      await store.processDueSchedules();

      const runs = mockDb.getRunRows();
      assert.equal(runs.length, 3);
      const runBySchedule = new Map(runs.map((r) => [r.scheduleId, r]));
      assert.deepEqual(runBySchedule.get(omitted.value.scheduleId)?.params, {});
      assert.deepEqual(
        runBySchedule.get(explicitOldDefaults.value.scheduleId)?.params,
        { maxRequests: 200, maxElapsedMs: 300_000 },
      );
      assert.deepEqual(
        runBySchedule.get(singleDimension.value.scheduleId)?.params,
        { maxRequests: 200 },
      );
      assert.deepEqual(validatedInputs, [
        {},
        { maxRequests: 200, maxElapsedMs: 300_000 },
        { maxRequests: 200 },
      ]);
    } finally {
      await new Promise<void>((resolve) =>
        runtimeServer.close(() => resolve()),
      );
    }
  });
});
