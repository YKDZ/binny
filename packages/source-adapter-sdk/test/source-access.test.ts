import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSourceAccessCoordinator,
  createSourceAccessClient,
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
