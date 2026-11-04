import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSourceAccessBudget,
  createSourceAccessCoordinator,
  createSourceAccessClient,
  SourceAccessBudgetExceededError,
  sourceAccessConfigSchema,
  type SourceAccessClock,
  type SourceAccessLease,
  type SourceAccessPersistentState,
  type SourceAccessTransport,
} from "../src/index.ts";

const declarations = sourceAccessConfigSchema.parse({
  groups: {
    linuxdo: {
      sources: ["site", "media"],
      minimumIntervalMs: 250,
      maxConcurrency: 1,
    },
  },
});

function createControlledClock(startEpochMs = 1_000_000): {
  readonly clock: SourceAccessClock;
  advanceBy(deltaMs: number): Promise<void>;
} {
  let monotonicMs = 0;
  let epochMs = startEpochMs;
  let nextTimerId = 0;
  const timers = new Map<
    number,
    { readonly dueAt: number; readonly callback: () => void }
  >();
  const clock: SourceAccessClock = {
    epochNow: () => epochMs,
    monotonicNow: () => monotonicMs,
    setTimer(callback, delayMs) {
      const id = ++nextTimerId;
      timers.set(id, { dueAt: monotonicMs + delayMs, callback });
      return id;
    },
    clearTimer(timer) {
      timers.delete(timer as number);
    },
  };
  return {
    clock,
    async advanceBy(deltaMs) {
      const target = monotonicMs + deltaMs;
      while (true) {
        let next:
          | [number, { readonly dueAt: number; readonly callback: () => void }]
          | undefined;
        for (const entry of timers) {
          if (
            entry[1].dueAt <= target &&
            (next === undefined || entry[1].dueAt < next[1].dueAt)
          )
            next = entry;
        }
        if (next === undefined) break;
        timers.delete(next[0]);
        const step = next[1].dueAt - monotonicMs;
        monotonicMs += step;
        epochMs += step;
        next[1].callback();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const step = target - monotonicMs;
      monotonicMs = target;
      epochMs += step;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function createDelayedStore(
  controlled: ReturnType<typeof createControlledClock>,
  saveDelaysMs: readonly number[],
) {
  let saved: unknown;
  let saves = 0;
  return {
    store: {
      async load() {
        return saved;
      },
      async save(state: SourceAccessPersistentState) {
        const delayMs = saveDelaysMs[saves] ?? 0;
        saves++;
        if (delayMs > 0) await controlled.advanceBy(delayMs);
        saved = state;
      },
    },
    saves: () => saves,
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pacingRequest = {
  runId: "run-pacing",
  groupId: "linuxdo",
  source: "site" as const,
  origin: "https://linux.do",
  minimumIntervalMs: 1_500,
  maxConcurrency: 1,
};

const pacingDeclarations = sourceAccessConfigSchema.parse({
  groups: {
    linuxdo: {
      sources: ["site"],
      minimumIntervalMs: 1_500,
      maxConcurrency: 1,
    },
  },
});

void test("来源准入间隔从实际许可时刻计算，而非持久写入开始时刻", async () => {
  const controlled = createControlledClock();
  const persistence = createDelayedStore(controlled, [250, 0, 0, 0]);
  const coordinator = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: persistence.store,
  });
  const first = await coordinator.acquire(
    "owner-pacing",
    pacingRequest,
    pacingDeclarations,
    new AbortController().signal,
  );
  const firstGrantedAt = controlled.clock.monotonicNow();
  await coordinator.release("owner-pacing", first.leaseId);

  let secondGrantedAt: number | undefined;
  const secondPending = coordinator
    .acquire(
      "owner-pacing",
      { ...pacingRequest, runId: "run-pacing-next" },
      pacingDeclarations,
      new AbortController().signal,
    )
    .then((lease) => {
      secondGrantedAt = controlled.clock.monotonicNow();
      return lease;
    });

  await controlled.advanceBy(1_499);
  assert.equal(secondGrantedAt, undefined);
  await controlled.advanceBy(1);
  const second = await secondPending;
  assert.ok(secondGrantedAt !== undefined);
  assert.ok(
    secondGrantedAt - firstGrantedAt >= 1_500,
    `许可间隔过短：${secondGrantedAt - firstGrantedAt} 毫秒`,
  );
  await coordinator.release("owner-pacing", second.leaseId);
});

void test("立即重建协调器仍按实际许可时刻保留来源准入间隔", async () => {
  const controlled = createControlledClock();
  const persistence = createDelayedStore(controlled, [250, 0, 0, 0]);
  const firstCoordinator = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: persistence.store,
  });
  const first = await firstCoordinator.acquire(
    "owner-pacing-restart",
    pacingRequest,
    pacingDeclarations,
    new AbortController().signal,
  );
  const firstGrantedAt = controlled.clock.monotonicNow();
  await firstCoordinator.release("owner-pacing-restart", first.leaseId);

  const restarted = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: persistence.store,
  });
  let secondGrantedAt: number | undefined;
  const secondPending = restarted
    .acquire(
      "next-owner-pacing",
      { ...pacingRequest, runId: "run-pacing-after-restart" },
      pacingDeclarations,
      new AbortController().signal,
    )
    .then((lease) => {
      secondGrantedAt = controlled.clock.monotonicNow();
      return lease;
    });

  await controlled.advanceBy(1_499);
  assert.equal(secondGrantedAt, undefined);
  await controlled.advanceBy(1);
  const second = await secondPending;
  assert.ok(secondGrantedAt !== undefined);
  assert.ok(secondGrantedAt - firstGrantedAt >= 1_500);
  await restarted.release("next-owner-pacing", second.leaseId);
});

void test("持久准入写入跨过期限时不得发放许可", async () => {
  const controlled = createControlledClock();
  const persistence = createDelayedStore(controlled, [250, 0]);
  const coordinator = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: persistence.store,
  });
  const deadlineEpochMs = controlled.clock.epochNow() + 100;

  await assert.rejects(
    coordinator.acquire(
      "owner-pacing-deadline",
      { ...pacingRequest, deadlineEpochMs },
      pacingDeclarations,
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "source_access_deadline_exceeded",
  );
  assert.equal(persistence.saves(), 2);

  const restarted = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: persistence.store,
  });
  const next = await restarted.acquire(
    "next-owner-pacing-deadline",
    { ...pacingRequest, runId: "run-after-crossed-deadline" },
    pacingDeclarations,
    new AbortController().signal,
  );
  assert.equal(next.waitedMs, 0);
  await restarted.release("next-owner-pacing-deadline", next.leaseId);
});

void test("许可 ACK 的延迟不重置重建后的剩余间隔", async () => {
  const controlled = createControlledClock();
  const persistence = createDelayedStore(controlled, [250, 250, 0, 0]);
  const coordinator = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: persistence.store,
  });
  const first = await coordinator.acquire(
    "owner-pacing-ack-delay",
    pacingRequest,
    pacingDeclarations,
    new AbortController().signal,
  );
  const firstGrantedAt = first.waitedMs;
  await coordinator.release("owner-pacing-ack-delay", first.leaseId);
  const restarted = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: persistence.store,
  });

  let secondGrantedAt: number | undefined;
  const secondPending = restarted
    .acquire(
      "next-owner-pacing-ack-delay",
      { ...pacingRequest, runId: "run-after-delayed-ack" },
      pacingDeclarations,
      new AbortController().signal,
    )
    .then((lease) => {
      secondGrantedAt = controlled.clock.monotonicNow();
      return lease;
    });
  await controlled.advanceBy(1_249);
  assert.equal(secondGrantedAt, undefined);
  await controlled.advanceBy(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const grantedAfterRemainingInterval = secondGrantedAt !== undefined;
  if (!grantedAfterRemainingInterval) await controlled.advanceBy(250);
  const second = await secondPending;
  assert.equal(grantedAfterRemainingInterval, true);
  assert.equal(secondGrantedAt, firstGrantedAt + 1_500);
  await restarted.release("next-owner-pacing-ack-delay", second.leaseId);
});

void test("pending 准入只在首次重建时采恢复上界", async () => {
  const controlled = createControlledClock();
  let persisted: unknown = {
    version: 1,
    lastAdmittedAt: {},
    admissionRecoveryByGroup: { linuxdo: { phase: "pending" } },
  };
  const store = {
    async load() {
      return persisted;
    },
    async save(state: SourceAccessPersistentState) {
      persisted = state;
    },
  };
  await createSourceAccessCoordinator({ clock: controlled.clock, store });
  assert.deepEqual(persisted, {
    version: 1,
    lastAdmittedAt: {},
    admissionRecoveryByGroup: {
      linuxdo: { phase: "recovered", upperBoundEpochMs: 1_000_000 },
    },
  });

  await controlled.advanceBy(500);
  const restarted = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store,
  });
  let settled = false;
  const pending = restarted
    .acquire(
      "owner-recovered-pending",
      pacingRequest,
      pacingDeclarations,
      new AbortController().signal,
    )
    .then((lease) => {
      settled = true;
      return lease;
    });
  await controlled.advanceBy(999);
  assert.equal(settled, false);
  await controlled.advanceBy(1);
  const lease = await pending;
  assert.equal(settled, true);
  await restarted.release("owner-recovered-pending", lease.leaseId);
});

void test("准入许可先开放操作，release 与 closeOwner 等待持久 ACK", async () => {
  const ackStarted = createDeferred();
  const finishAck = createDeferred();
  let persisted: unknown;
  let saves = 0;
  const coordinator = await createSourceAccessCoordinator({
    store: {
      async load() {
        return persisted;
      },
      async save(state) {
        saves++;
        if (saves === 2) {
          ackStarted.resolve();
          await finishAck.promise;
        }
        persisted = state;
      },
    },
  });
  const config = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 2,
      },
    },
  });
  const ownerId = "owner-ack-pending";
  const transport: SourceAccessTransport = {
    async acquire(request, signal) {
      return await coordinator.acquire(ownerId, request, config, signal);
    },
    async release(leaseId) {
      await coordinator.release(ownerId, leaseId);
    },
    async observeResponse(request, response) {
      return await coordinator.observeResponse(
        ownerId,
        request,
        config,
        response,
      );
    },
  };
  const access = createSourceAccessClient({
    runId: "run-ack-pending",
    signal: new AbortController().signal,
    declarations: config,
    transport,
  });
  let operationStarted = false;
  let completed = false;
  const operation = access
    .withAdmission(
      { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
      async () => {
        operationStarted = true;
        return "done";
      },
    )
    .then((value) => {
      completed = true;
      return value;
    });

  await ackStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(operationStarted, true);
  assert.equal(completed, false);
  const closing = coordinator.closeOwner(ownerId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  finishAck.resolve();
  assert.equal(await operation, "done");
  await closing;
  assert.equal(completed, true);
});

void test("持久 ACK 失败锁存 unavailable 并拒绝后续来源访问", async () => {
  let saves = 0;
  const coordinator = await createSourceAccessCoordinator({
    store: {
      async load() {
        return undefined;
      },
      async save() {
        saves++;
        if (saves === 2) throw new Error("ack disk write failed");
      },
    },
  });
  const config = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  const ownerId = "owner-ack-failed";
  const transport: SourceAccessTransport = {
    async acquire(request, signal) {
      return await coordinator.acquire(ownerId, request, config, signal);
    },
    async release(leaseId) {
      await coordinator.release(ownerId, leaseId);
    },
    async observeResponse(request, response) {
      return await coordinator.observeResponse(
        ownerId,
        request,
        config,
        response,
      );
    },
  };
  const access = createSourceAccessClient({
    runId: "run-ack-failed",
    signal: new AbortController().signal,
    declarations: config,
    transport,
  });
  let operations = 0;

  await assert.rejects(
    access.withAdmission(
      { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
      async () => {
        operations++;
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "source_access_persistent_store_failed",
  );
  assert.equal(operations, 1);
  assert.equal(coordinator.snapshot().status, "unavailable");

  await assert.rejects(
    access.withAdmission(
      { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
      async () => {
        operations++;
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "source_access_state_unavailable",
  );
  assert.equal(operations, 1);
  assert.equal(coordinator.snapshot().status, "unavailable");
  await coordinator.closeOwner(ownerId).catch(() => undefined);
});

void test("其他来源组持久写失败后不得放行已完成准备写的准入", async () => {
  const config = sourceAccessConfigSchema.parse({
    groups: {
      first: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
      second: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  let saves = 0;
  const coordinator = await createSourceAccessCoordinator({
    store: {
      async load() {
        return undefined;
      },
      save() {
        saves++;
        if (saves === 2) throw new Error("disk write failed");
        return Promise.resolve();
      },
    },
  });
  const attempt = async (groupId: "first" | "second") => {
    try {
      const lease = await coordinator.acquire(
        groupId,
        {
          runId: `run-${groupId}`,
          groupId,
          source: "site",
          origin: "https://linux.do",
          minimumIntervalMs: 0,
          maxConcurrency: 1,
        },
        config,
        new AbortController().signal,
      );
      await coordinator.release(groupId, lease.leaseId).catch(() => undefined);
      return { groupId, kind: "granted" as const };
    } catch (error) {
      return {
        groupId,
        kind: "rejected" as const,
        code:
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined,
      };
    }
  };

  const outcomes = await Promise.all([attempt("first"), attempt("second")]);
  assert.deepEqual(
    outcomes.map(({ groupId, kind }) => ({ groupId, kind })),
    [
      { groupId: "first", kind: "rejected" },
      { groupId: "second", kind: "rejected" },
    ],
  );
  const firstOutcome = outcomes[0]!;
  assert.equal(firstOutcome.kind, "rejected");
  if (firstOutcome.kind === "rejected")
    assert.equal(firstOutcome.code, "source_access_state_unavailable");
  assert.equal(coordinator.snapshot().status, "unavailable");
});

void test("取消准备或关闭 owner 会恢复旧准入状态且不留下许可", async () => {
  for (const endMode of ["cancel", "close"] as const) {
    const controlled = createControlledClock();
    const saveStarted = createDeferred();
    const finishSave = createDeferred();
    let persisted: unknown;
    let saves = 0;
    const store = {
      async load() {
        return persisted;
      },
      async save(state: SourceAccessPersistentState) {
        saves++;
        if (saves === 1) {
          saveStarted.resolve();
          await finishSave.promise;
        }
        persisted = state;
      },
    };
    const coordinator = await createSourceAccessCoordinator({
      clock: controlled.clock,
      store,
    });
    const ownerId = `owner-prepare-${endMode}`;
    const abort = new AbortController();
    const pending = coordinator.acquire(
      ownerId,
      pacingRequest,
      pacingDeclarations,
      abort.signal,
    );
    await saveStarted.promise;
    const closing =
      endMode === "close" ? coordinator.closeOwner(ownerId) : undefined;
    if (endMode === "cancel") abort.abort();
    finishSave.resolve();
    await assert.rejects(pending, { name: "AbortError" });
    if (closing !== undefined) await closing;
    else await coordinator.closeOwner(ownerId);

    const restarted = await createSourceAccessCoordinator({
      clock: controlled.clock,
      store,
    });
    const next = await restarted.acquire(
      `next-${ownerId}`,
      { ...pacingRequest, runId: `run-next-${endMode}` },
      pacingDeclarations,
      new AbortController().signal,
    );
    assert.equal(next.waitedMs, 0);
    await restarted.release(`next-${ownerId}`, next.leaseId);
  }
});

void test("SDK 调度器按注入时钟等待并从持久状态合并最早准入时刻", async () => {
  const controlledClock = createControlledClock();
  const clock = controlledClock.clock;
  const intervalDeclarations = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site", "media"],
        minimumIntervalMs: 1_000,
        maxConcurrency: 1,
      },
    },
  });
  let persisted: SourceAccessPersistentState = {
    version: 1,
    lastAdmittedAt: {},
  };
  const store = {
    async load() {
      return persisted;
    },
    async save(state: SourceAccessPersistentState) {
      persisted = state;
    },
  };
  const coordinator = await createSourceAccessCoordinator({ clock, store });
  const request = {
    runId: "run-interval",
    groupId: "linuxdo",
    source: "site" as const,
    origin: "https://linux.do",
    minimumIntervalMs: 1_000,
    maxConcurrency: 1,
  };
  const first = await coordinator.acquire(
    "owner",
    request,
    intervalDeclarations,
    new AbortController().signal,
  );
  await coordinator.release("owner", first.leaseId);

  let secondSettled = false;
  const secondPromise = coordinator
    .acquire(
      "owner",
      { ...request, runId: "run-next" },
      intervalDeclarations,
      new AbortController().signal,
    )
    .then((lease) => {
      secondSettled = true;
      return lease;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  await controlledClock.advanceBy(999);
  assert.equal(secondSettled, false);
  await controlledClock.advanceBy(1);

  const second = await secondPromise;
  assert.equal(second.waitedMs, 1_000);
  assert.deepEqual(persisted, {
    version: 1,
    lastAdmittedAt: { linuxdo: 1_001_000 },
    cooldownByGroup: {},
  });
  await coordinator.release("owner", second.leaseId);

  const restarted = await createSourceAccessCoordinator({ clock, store });
  let thirdSettled = false;
  const thirdPromise = restarted
    .acquire(
      "owner",
      {
        ...request,
        runId: "run-with-deadline",
        notBeforeEpochMs: 1_005_000,
      },
      intervalDeclarations,
      new AbortController().signal,
    )
    .then((lease) => {
      thirdSettled = true;
      return lease;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(thirdSettled, false);
  await controlledClock.advanceBy(3_999);
  assert.equal(thirdSettled, false);
  await controlledClock.advanceBy(1);
  const third = await thirdPromise;
  assert.equal(third.waitedMs, 4_000);
  await restarted.release("owner", third.leaseId);
});

void test("SDK 对有效秒数和 HTTP 日期冷却持久化，重启后与重试时刻一次取最大值", async () => {
  const startEpochMs = Date.parse("Tue, 03 Nov 2026 12:00:00 GMT");
  const controlledClock = createControlledClock(startEpochMs);
  const { clock } = controlledClock;
  const intervalDeclarations = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site", "media"],
        minimumIntervalMs: 1_000,
        maxConcurrency: 1,
      },
    },
  });
  const state: SourceAccessPersistentState = {
    version: 1,
    lastAdmittedAt: {},
  };
  let persisted = state;
  const store = {
    async load() {
      return persisted;
    },
    async save(next: SourceAccessPersistentState) {
      persisted = next;
    },
  };
  const coordinator = await createSourceAccessCoordinator({ clock, store });
  const request = {
    runId: "run-rate-limited",
    groupId: "linuxdo",
    source: "site" as const,
    origin: "https://linux.do",
    minimumIntervalMs: 1_000,
    maxConcurrency: 1,
  };

  const seconds = await coordinator.observeResponse(
    "owner",
    request,
    intervalDeclarations,
    { status: 429, retryAfter: "2" },
  );
  assert.equal(seconds.outcome, "cooled");
  assert.equal(seconds.cooldownUntilEpochMs, startEpochMs + 2_000);

  const retryDate = new Date(startEpochMs + 3_000).toUTCString();
  const date = await coordinator.observeResponse(
    "owner",
    request,
    intervalDeclarations,
    { status: 503, retryAfter: retryDate },
  );
  assert.equal(date.outcome, "cooled");
  assert.equal(date.cooldownUntilEpochMs, startEpochMs + 3_000);
  assert.equal(
    coordinator.snapshot().cooldownByGroup.linuxdo?.notBeforeEpochMs,
    startEpochMs + 3_000,
  );

  const restarted = await createSourceAccessCoordinator({ clock, store });
  let settled = false;
  const pending = restarted
    .acquire(
      "next-owner",
      {
        ...request,
        runId: "run-after-restart",
        notBeforeEpochMs: startEpochMs + 4_000,
      },
      intervalDeclarations,
      new AbortController().signal,
    )
    .then((lease) => {
      settled = true;
      return lease;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await controlledClock.advanceBy(3_999);
  assert.equal(settled, false);
  await controlledClock.advanceBy(1);
  const lease = await pending;
  assert.equal(lease.waitedMs, 4_000);
  await restarted.release("next-owner", lease.leaseId);
});

void test("无效、缺失和过去的 Retry-After 不写入跨运行冷却", async () => {
  const { clock } = createControlledClock();
  let persisted: SourceAccessPersistentState = {
    version: 1,
    lastAdmittedAt: {},
  };
  const coordinator = await createSourceAccessCoordinator({
    clock,
    store: {
      async load() {
        return persisted;
      },
      async save(state: SourceAccessPersistentState) {
        persisted = state;
      },
    },
  });
  const request = {
    runId: "run-limited",
    groupId: "linuxdo",
    source: "site" as const,
    origin: "https://linux.do",
    minimumIntervalMs: 250,
    maxConcurrency: 1,
  };

  assert.equal(
    (
      await coordinator.observeResponse("owner", request, declarations, {
        status: 429,
      })
    ).outcome,
    "missing",
  );
  assert.equal(
    (
      await coordinator.observeResponse("owner", request, declarations, {
        status: 503,
        retryAfter: "tomorrow",
      })
    ).outcome,
    "invalid",
  );
  assert.equal(
    (
      await coordinator.observeResponse("owner", request, declarations, {
        status: 429,
        retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT",
      })
    ).outcome,
    "past",
  );
  assert.deepEqual(coordinator.snapshot().cooldownByGroup, {});
  assert.equal(persisted.cooldownByGroup, undefined);

  const lease = await coordinator.acquire(
    "next-owner",
    { ...request, runId: "run-finite-next" },
    declarations,
    new AbortController().signal,
  );
  assert.equal(lease.waitedMs, 0);
  await coordinator.release("next-owner", lease.leaseId);
});

void test("超过本轮准入期限的持久冷却立即拒绝，不排长时间等待", async () => {
  const { clock } = createControlledClock();
  const coordinator = await createSourceAccessCoordinator({
    clock,
    store: {
      async load() {
        return {
          version: 1,
          lastAdmittedAt: {},
          cooldownByGroup: {
            linuxdo: {
              notBeforeEpochMs: 1_001_000,
              status: 429,
              observedAtEpochMs: 1_000_000,
              retryAfter: "1",
            },
          },
        };
      },
      async save() {},
    },
  });

  await assert.rejects(
    coordinator.acquire(
      "owner",
      {
        runId: "run-budget-expired",
        groupId: "linuxdo",
        source: "site",
        origin: "https://linux.do",
        minimumIntervalMs: 250,
        maxConcurrency: 1,
        deadlineEpochMs: 1_000_100,
      },
      declarations,
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "source_access_deadline_exceeded",
  );
});

void test("SDK 调度器遵守并发上限并移除已取消的排队请求", async () => {
  const { clock } = createControlledClock();
  const config = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site", "media"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  const coordinator = await createSourceAccessCoordinator({
    clock,
    store: {
      async load() {
        return undefined;
      },
      async save() {},
    },
  });
  const request = {
    runId: "run-concurrency",
    groupId: "linuxdo",
    source: "site" as const,
    origin: "https://linux.do",
    minimumIntervalMs: 0,
    maxConcurrency: 1,
  };
  const first = await coordinator.acquire(
    "owner",
    request,
    config,
    new AbortController().signal,
  );
  const abort = new AbortController();
  let secondSettled = false;
  const secondPromise = coordinator
    .acquire(
      "owner",
      { ...request, runId: "run-cancelled" },
      config,
      abort.signal,
    )
    .then((lease) => {
      secondSettled = true;
      return lease;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  abort.abort();
  await assert.rejects(secondPromise, { name: "AbortError" });
  await coordinator.release("owner", first.leaseId);

  const next = await coordinator.acquire(
    "owner",
    { ...request, runId: "run-after-cancel" },
    config,
    new AbortController().signal,
  );
  assert.equal(next.waitedMs, 0);
  await coordinator.release("owner", next.leaseId);
});

void test("来源准入在操作前取得共享许可，并在完成后释放", async () => {
  const events: string[] = [];
  const clock = { now: () => 1_000 };
  const transport: SourceAccessTransport = {
    async acquire(input) {
      assert.equal(input.notBeforeEpochMs, clock.now() + 125);
      events.push(`acquire:${input.groupId}:${input.source}:${input.origin}`);
      return { leaseId: "permit-1", waitedMs: 125 };
    },
    async release(leaseId) {
      events.push(`release:${leaseId}`);
    },
    async observeResponse() {
      return {
        status: 429,
        observedAtEpochMs: 1_000,
        outcome: "missing" as const,
      };
    },
  };
  const access = createSourceAccessClient({
    runId: "run-1",
    signal: new AbortController().signal,
    declarations,
    transport,
  });

  const result = await access.withAdmission(
    {
      groupId: "linuxdo",
      source: "site",
      origin: "https://linux.do",
      notBeforeEpochMs: clock.now() + 125,
    },
    async () => {
      events.push("operation");
      return "response";
    },
  );

  assert.equal(result, "response");
  assert.deepEqual(events, [
    "acquire:linuxdo:site:https://linux.do",
    "operation",
    "release:permit-1",
  ]);
  assert.deepEqual(access.snapshot(), {
    admittedAttempts: 1,
    waitedMs: 125,
    bySource: { site: 1, media: 0 },
  });
});

void test("准入后的失败访问仍计入主动尝试并释放许可", async () => {
  let released = false;
  const access = createSourceAccessClient({
    runId: "run-2",
    signal: new AbortController().signal,
    declarations,
    transport: {
      async acquire() {
        return { leaseId: "permit-failed", waitedMs: 30 };
      },
      async release() {
        released = true;
      },
      async observeResponse() {
        return { status: 429, observedAtEpochMs: 1_000, outcome: "missing" };
      },
    },
  });
  const failure = new Error("连接被重置");

  await assert.rejects(
    access.withAdmission(
      {
        groupId: "linuxdo",
        source: "media",
        origin: "https://cdn.example",
      },
      async () => {
        throw failure;
      },
    ),
    failure,
  );

  assert.equal(released, true);
  assert.deepEqual(access.snapshot(), {
    admittedAttempts: 1,
    waitedMs: 30,
    bySource: { site: 0, media: 1 },
  });
});

void test("未声明的来源组或来源类型不能取得访问许可", async () => {
  let acquired = false;
  const access = createSourceAccessClient({
    runId: "run-3",
    signal: new AbortController().signal,
    declarations,
    transport: {
      async acquire() {
        acquired = true;
        return { leaseId: "unused", waitedMs: 0 };
      },
      async release() {},
      async observeResponse() {
        return { status: 429, observedAtEpochMs: 1_000, outcome: "missing" };
      },
    },
  });

  await assert.rejects(
    access.withAdmission(
      { groupId: "unlisted", source: "site", origin: "https://linux.do" },
      async () => undefined,
    ),
    /没有声明/u,
  );
  await assert.rejects(
    access.withAdmission(
      {
        groupId: "linuxdo",
        source: "navigation" as "site",
        origin: "https://linux.do",
      },
      async () => undefined,
    ),
    /没有声明/u,
  );

  assert.equal(acquired, false);
  assert.equal(access.snapshot().admittedAttempts, 0);
});

void test("取消的等待不会记成已经准入的请求", async () => {
  const abort = new AbortController();
  let released = false;
  const access = createSourceAccessClient({
    runId: "run-4",
    signal: abort.signal,
    declarations,
    transport: {
      async acquire(_input, signal) {
        assert.equal(signal, abort.signal);
        abort.abort();
        throw new DOMException("已取消", "AbortError");
      },
      async release() {
        released = true;
      },
      async observeResponse() {
        return { status: 429, observedAtEpochMs: 1_000, outcome: "missing" };
      },
    },
  });

  await assert.rejects(
    access.withAdmission(
      {
        groupId: "linuxdo",
        source: "site",
        origin: "https://linux.do",
      },
      async () => undefined,
    ),
    { name: "AbortError" },
  );

  assert.equal(released, false);
  assert.deepEqual(access.snapshot(), {
    admittedAttempts: 0,
    waitedMs: 0,
    bySource: { site: 0, media: 0 },
  });
});

void test("许可返回前取消时不调用传输操作，并释放已发出的许可", async () => {
  const abort = new AbortController();
  let finishAcquire!: (lease: { leaseId: string; waitedMs: number }) => void;
  let signalAcquireStarted!: () => void;
  let released = false;
  let operationCalled = false;
  const acquireStarted = new Promise<void>((resolve) => {
    signalAcquireStarted = resolve;
  });
  const access = createSourceAccessClient({
    runId: "run-5",
    signal: abort.signal,
    declarations,
    transport: {
      async acquire(_input, signal) {
        assert.equal(signal, abort.signal);
        signalAcquireStarted();
        return await new Promise((resolve) => {
          finishAcquire = resolve;
        });
      },
      async release() {
        released = true;
      },
      async observeResponse() {
        return { status: 429, observedAtEpochMs: 1_000, outcome: "missing" };
      },
    },
  });

  const pending = access.withAdmission(
    { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
    async () => {
      operationCalled = true;
    },
  );
  await acquireStarted;
  abort.abort();
  finishAcquire({ leaseId: "permit-cancelled", waitedMs: 10 });

  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(operationCalled, false);
  assert.equal(released, true);
  assert.deepEqual(access.snapshot(), {
    admittedAttempts: 0,
    waitedMs: 0,
    bySource: { site: 0, media: 0 },
  });
});

void test("单次准入期限与可选取消信号会沿SDK公开client进入同一协调请求", async () => {
  const actionSignal = new AbortController();
  const budgetSignal = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  let receivedDeadline: number | undefined;
  const access = createSourceAccessClient({
    runId: "run-budgeted",
    signal: actionSignal.signal,
    declarations,
    transport: {
      async acquire(input, signal) {
        receivedSignal = signal;
        receivedDeadline = input.deadlineEpochMs;
        return await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      async release() {},
      async observeResponse() {
        return { status: 429, observedAtEpochMs: 1_000, outcome: "missing" };
      },
    },
  });
  const pending = access.withAdmission(
    { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
    async () => assert.fail("取消后不能调用实际操作"),
    { signal: budgetSignal.signal, deadlineEpochMs: 9_876 },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(receivedDeadline, 9_876);
  assert.equal(receivedSignal?.aborted, false);
  budgetSignal.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(actionSignal.signal.aborted, false);
});

void test("单次预算在许可发出后、实际操作前取消时释放许可且不计主动尝试", async () => {
  const budgetSignal = new AbortController();
  let finishAcquire!: (lease: SourceAccessLease) => void;
  let signalAcquireStarted!: () => void;
  let released = false;
  let operationCalled = false;
  const acquireStarted = new Promise<void>((resolve) => {
    signalAcquireStarted = resolve;
  });
  const access = createSourceAccessClient({
    runId: "run-budget-grant-race",
    signal: new AbortController().signal,
    declarations,
    transport: {
      async acquire() {
        signalAcquireStarted();
        return await new Promise<SourceAccessLease>((resolve) => {
          finishAcquire = resolve;
        });
      },
      async release() {
        released = true;
      },
      async observeResponse() {
        return { status: 429, observedAtEpochMs: 1_000, outcome: "missing" };
      },
    },
  });

  const pending = access.withAdmission(
    { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
    async () => {
      operationCalled = true;
    },
    { signal: budgetSignal.signal },
  );
  await acquireStarted;
  finishAcquire({ leaseId: "permit-budget-race", waitedMs: 0 });
  budgetSignal.abort();

  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(operationCalled, false);
  assert.equal(released, true);
  assert.deepEqual(access.snapshot(), {
    admittedAttempts: 0,
    waitedMs: 0,
    bySource: { site: 0, media: 0 },
  });
});

void test("原生来源声明用稳定组键并限制间隔和并发范围", () => {
  assert.equal(
    sourceAccessConfigSchema.safeParse({
      groups: {
        "bad group id": {
          sources: ["site"],
          minimumIntervalMs: 10,
          maxConcurrency: 1,
        },
      },
    }).success,
    false,
  );
  assert.equal(
    sourceAccessConfigSchema.safeParse({
      groups: {
        linuxdo: {
          sources: ["site"],
          minimumIntervalMs: 60_001,
          maxConcurrency: 1,
        },
      },
    }).success,
    false,
  );
});

void test("单轮预算在同一来源准入前预留并限制主动请求数", async () => {
  const { clock } = createControlledClock();
  const config = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  const coordinator = await createSourceAccessCoordinator({
    clock,
    store: {
      async load() {
        return undefined;
      },
      async save() {},
    },
  });
  const ownerId = "owner-budget";
  const request = {
    runId: "run-request-budget",
    groupId: "linuxdo",
    source: "site" as const,
    origin: "https://linux.do",
    minimumIntervalMs: 0,
    maxConcurrency: 1,
  };
  const ownerSignal = new AbortController().signal;
  const held = await coordinator.acquire(
    ownerId,
    { ...request, runId: "run-holding-budget-permit" },
    config,
    ownerSignal,
  );
  const signal = new AbortController().signal;
  const transport: SourceAccessTransport = {
    async acquire(request, acquireSignal) {
      return await coordinator.acquire(ownerId, request, config, acquireSignal);
    },
    async release(leaseId) {
      await coordinator.release(ownerId, leaseId);
    },
    async observeResponse(request, response) {
      return await coordinator.observeResponse(
        ownerId,
        request,
        config,
        response,
      );
    },
  };
  const access = createSourceAccessClient({
    runId: "run-request-budget",
    signal,
    declarations: config,
    transport,
  });
  const budget = createSourceAccessBudget({
    client: access,
    signal,
    maxRequests: 1,
    maxElapsedMs: 5_000,
  });
  const clientRequest = {
    groupId: "linuxdo",
    source: "site" as const,
    origin: "https://linux.do",
  };
  let operations = 0;
  let pendingSettled = false;
  const pending = budget
    .withAdmission(clientRequest, async () => {
      operations++;
    })
    .then(
      () => {
        pendingSettled = true;
        return { kind: "completed" as const };
      },
      (error: unknown) => {
        pendingSettled = true;
        return { kind: "failed" as const, error };
      },
    );
  let heldReleased = false;

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pendingSettled, false);
    assert.equal(access.snapshot().admittedAttempts, 0);
    await assert.rejects(
      budget.withAdmission(clientRequest, async () => {
        operations++;
      }),
      (error: unknown) =>
        error instanceof SourceAccessBudgetExceededError &&
        error.reason === "request-limit",
    );
    assert.equal(pendingSettled, false);
    assert.equal(operations, 0);
    assert.equal(budget.signal.aborted, true);

    await coordinator.release(ownerId, held.leaseId);
    heldReleased = true;
    const settled = await pending;
    assert.equal(settled.kind, "failed");
    if (settled.kind === "failed") {
      assert.ok(settled.error instanceof SourceAccessBudgetExceededError);
      assert.equal(
        (settled.error as SourceAccessBudgetExceededError).reason,
        "request-limit",
      );
    }
    assert.equal(operations, 0);
    assert.equal(access.snapshot().admittedAttempts, 0);
    assert.equal(budget.budgetSnapshot().stopReason, "request-limit");
  } finally {
    if (!heldReleased)
      await coordinator.release(ownerId, held.leaseId).catch(() => undefined);
    budget.close();
    await coordinator.closeOwner(ownerId);
  }
});

void test("关闭单轮预算时撤销排队请求但不伪造预算耗尽", async () => {
  const config = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  const coordinator = await createSourceAccessCoordinator({
    store: {
      async load() {
        return undefined;
      },
      async save() {},
    },
  });
  const ownerId = "owner-budget-close";
  const request = {
    runId: "run-budget-close",
    groupId: "linuxdo",
    source: "site" as const,
    origin: "https://linux.do",
    minimumIntervalMs: 0,
    maxConcurrency: 1,
  };
  const held = await coordinator.acquire(
    ownerId,
    { ...request, runId: "run-holding-close-permit" },
    config,
    new AbortController().signal,
  );
  const actionAbort = new AbortController();
  const transport: SourceAccessTransport = {
    async acquire(input, signal) {
      return await coordinator.acquire(ownerId, input, config, signal);
    },
    async release(leaseId) {
      await coordinator.release(ownerId, leaseId);
    },
    async observeResponse(input, response) {
      return await coordinator.observeResponse(
        ownerId,
        input,
        config,
        response,
      );
    },
  };
  const access = createSourceAccessClient({
    runId: request.runId,
    signal: actionAbort.signal,
    declarations: config,
    transport,
  });
  const budget = createSourceAccessBudget({
    client: access,
    signal: actionAbort.signal,
    maxRequests: 1,
    maxElapsedMs: 30_000,
  });
  let operationStarted = false;
  const pending = budget
    .withAdmission(
      { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
      async () => {
        operationStarted = true;
      },
    )
    .then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(operationStarted, false);
    assert.equal(access.snapshot().admittedAttempts, 0);
    budget.close();
    assert.equal(budget.signal.aborted, true);
    const settled = await pending;
    assert.equal(settled.kind, "failed");
    if (settled.kind === "failed") {
      assert.ok(settled.error instanceof DOMException);
      assert.equal((settled.error as DOMException).name, "AbortError");
    }

    await coordinator.release(ownerId, held.leaseId);
    assert.equal(operationStarted, false);
    assert.equal(access.snapshot().admittedAttempts, 0);
    assert.equal(budget.budgetSnapshot().stopReason, undefined);
  } finally {
    actionAbort.abort(new DOMException("test cleanup", "AbortError"));
    budget.close();
    await coordinator.release(ownerId, held.leaseId).catch(() => undefined);
    await coordinator.closeOwner(ownerId);
  }
});

void test("单轮预算耗尽时取消在途操作并记录精确单调耗时", async () => {
  const controlled = createControlledClock();
  const config = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  const coordinator = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: {
      async load() {
        return undefined;
      },
      async save() {},
    },
  });
  const actionAbort = new AbortController();
  const transport: SourceAccessTransport = {
    async acquire(request, signal) {
      return await coordinator.acquire(
        "owner-time-budget",
        request,
        config,
        signal,
      );
    },
    async release(leaseId) {
      await coordinator.release("owner-time-budget", leaseId);
    },
    async observeResponse(request, response) {
      return await coordinator.observeResponse(
        "owner-time-budget",
        request,
        config,
        response,
      );
    },
  };
  const access = createSourceAccessClient({
    runId: "run-time-budget",
    signal: actionAbort.signal,
    declarations: config,
    transport,
  });
  const budget = createSourceAccessBudget({
    client: access,
    signal: actionAbort.signal,
    clock: controlled.clock,
    maxRequests: 4,
    maxElapsedMs: 250,
  });
  let operationStarted = false;
  const result = budget
    .withAdmission(
      { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
      async () => {
        operationStarted = true;
        await new Promise<void>((_resolve, reject) => {
          if (budget.signal.aborted) {
            reject(budget.signal.reason);
            return;
          }
          budget.signal.addEventListener(
            "abort",
            () => reject(budget.signal.reason),
            { once: true },
          );
        });
      },
    )
    .then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(operationStarted, true);
    await controlled.advanceBy(249);
    assert.equal(budget.budgetSnapshot().elapsedMs, 249);
    assert.equal(budget.signal.aborted, false);
    await controlled.advanceBy(1);
    assert.equal(budget.signal.aborted, true);
    const settled = await result;
    assert.equal(settled.kind, "failed");
    if (settled.kind === "failed") {
      assert.ok(settled.error instanceof SourceAccessBudgetExceededError);
      assert.equal(
        (settled.error as SourceAccessBudgetExceededError).reason,
        "elapsed-time-limit",
      );
    }
    assert.equal(budget.budgetSnapshot().elapsedMs, 250);
    assert.equal(budget.budgetSnapshot().stopReason, "elapsed-time-limit");
  } finally {
    actionAbort.abort(new DOMException("test cleanup", "AbortError"));
    await result;
    budget.close();
    await coordinator.closeOwner("owner-time-budget");
  }
});

void test("单轮耗时预算到期会撤销同一协调器中排队的准入", async () => {
  const controlled = createControlledClock();
  const config = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  const coordinator = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: {
      async load() {
        return undefined;
      },
      async save() {},
    },
  });
  const ownerId = "owner-budget-wait";
  const request = {
    runId: "run-budget-wait",
    groupId: "linuxdo",
    source: "site" as const,
    origin: "https://linux.do",
    minimumIntervalMs: 0,
    maxConcurrency: 1,
  };
  const held = await coordinator.acquire(
    ownerId,
    { ...request, runId: "run-holding-permit" },
    config,
    new AbortController().signal,
  );
  const actionAbort = new AbortController();
  const transport: SourceAccessTransport = {
    async acquire(input, signal) {
      return await coordinator.acquire(ownerId, input, config, signal);
    },
    async release(leaseId) {
      await coordinator.release(ownerId, leaseId);
    },
    async observeResponse(input, response) {
      return await coordinator.observeResponse(
        ownerId,
        input,
        config,
        response,
      );
    },
  };
  const access = createSourceAccessClient({
    runId: request.runId,
    signal: actionAbort.signal,
    declarations: config,
    transport,
  });
  const budget = createSourceAccessBudget({
    client: access,
    signal: actionAbort.signal,
    clock: controlled.clock,
    maxRequests: 2,
    maxElapsedMs: 250,
  });
  let operationStarted = false;
  let pendingSettled = false;
  const pending = budget
    .withAdmission(
      { groupId: "linuxdo", source: "site", origin: "https://linux.do" },
      async () => {
        operationStarted = true;
      },
    )
    .then(
      () => {
        pendingSettled = true;
        return { kind: "completed" as const };
      },
      (error: unknown) => {
        pendingSettled = true;
        return { kind: "failed" as const, error };
      },
    );

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pendingSettled, false);
    await controlled.advanceBy(250);
    assert.equal(budget.signal.aborted, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pendingSettled, true);
    assert.equal(operationStarted, false);
    assert.equal(access.snapshot().admittedAttempts, 0);
    const settled = await pending;
    assert.equal(settled.kind, "failed");
    if (settled.kind === "failed") {
      assert.ok(settled.error instanceof SourceAccessBudgetExceededError);
      assert.equal(
        (settled.error as SourceAccessBudgetExceededError).reason,
        "elapsed-time-limit",
      );
    }
    assert.equal(budget.budgetSnapshot().elapsedMs, 250);
  } finally {
    actionAbort.abort(new DOMException("test cleanup", "AbortError"));
    await pending;
    budget.close();
    await coordinator.release(ownerId, held.leaseId);
    await coordinator.closeOwner(ownerId);
  }
});

void test("最早来源准入时刻晚于预算期限时立即停止本轮等待", async () => {
  const controlled = createControlledClock();
  const config = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  const ownerId = "owner-budget-deadline";
  const coordinator = await createSourceAccessCoordinator({
    clock: controlled.clock,
    store: {
      async load() {
        return undefined;
      },
      async save() {},
    },
  });
  const signal = new AbortController().signal;
  const transport: SourceAccessTransport = {
    async acquire(request, acquireSignal) {
      return await coordinator.acquire(ownerId, request, config, acquireSignal);
    },
    async release(leaseId) {
      await coordinator.release(ownerId, leaseId);
    },
    async observeResponse(request, response) {
      return await coordinator.observeResponse(
        ownerId,
        request,
        config,
        response,
      );
    },
  };
  const access = createSourceAccessClient({
    runId: "run-budget-deadline",
    signal,
    declarations: config,
    transport,
  });
  const budget = createSourceAccessBudget({
    client: access,
    signal,
    clock: controlled.clock,
    maxRequests: 2,
    maxElapsedMs: 250,
  });
  let operationStarted = false;

  try {
    await assert.rejects(
      budget.withAdmission(
        {
          groupId: "linuxdo",
          source: "site",
          origin: "https://linux.do",
          notBeforeEpochMs: 1_001_000,
        },
        async () => {
          operationStarted = true;
        },
      ),
      (error: unknown) =>
        error instanceof SourceAccessBudgetExceededError &&
        (error.reason as string) === "wait-exceeds-budget",
    );
    assert.equal(operationStarted, false);
    assert.equal(access.snapshot().admittedAttempts, 0);
    assert.equal(
      budget.budgetSnapshot().stopReason as string,
      "wait-exceeds-budget",
    );
    assert.equal(budget.budgetSnapshot().elapsedMs, 0);
  } finally {
    budget.close();
    await coordinator.closeOwner(ownerId);
  }
});
