import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSourceAccessClient,
  sourceAccessConfigSchema,
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
