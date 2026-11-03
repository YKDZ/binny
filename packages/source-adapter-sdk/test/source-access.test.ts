import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSourceAccessCoordinator,
  createSourceAccessClient,
  sourceAccessConfigSchema,
  type SourceAccessClock,
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
