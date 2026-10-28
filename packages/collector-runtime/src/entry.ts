import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

import { createApiClient } from "@binny/api/client";
import {
  collectorManifest,
  type CollectorDefinition,
} from "@binny/collector-sdk";
import {
  manualRunCompletionSchema,
  runtimeHeartbeatIntervalMs,
  runtimeProtocolVersion,
  type ManualRunCompletion,
  type ManualRunExecution,
  type ManualRun,
  type RuntimeEnvironment,
} from "@binny/contracts";

import { createRuntimeServer } from "./runtime-server.ts";

const collectorPath = process.env.BINNY_COLLECTOR_ENTRY ?? "/app/dist/index.js";
const binId = process.env.BINNY_BIN_ID;
const apiUrl = process.env.BINNY_API_URL;
const runtimePort = Number(process.env.BINNY_RUNTIME_PORT ?? "8080");
const environmentKind = process.env.BINNY_RUNTIME_ENVIRONMENT ?? "lightweight";
const heartbeatInterval = Number(
  process.env.BINNY_RUNTIME_HEARTBEAT_INTERVAL_MS ??
    String(runtimeHeartbeatIntervalMs),
);
const ownerLockPath =
  process.env.BINNY_RUNTIME_OWNER_LOCK_PATH ??
  "/var/lib/binny/runtime/owner.lock";
const workerEntry =
  process.env.BINNY_RUNTIME_WORKER_ENTRY ??
  fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
      import.meta.url,
    ),
  );

function positiveInteger(name: string, fallback: number, minimum = 0): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`${name} 必须是大于等于 ${minimum} 的整数。`);
  return parsed;
}

const stopGraceMs = positiveInteger("BINNY_RUNTIME_RUN_STOP_GRACE_MS", 2_000);
const stopConfirmationLogMs = positiveInteger(
  "BINNY_RUNTIME_STOP_CONFIRMATION_LOG_MS",
  10_000,
  1,
);

if (binId === undefined || binId.trim() === "") {
  throw new Error("缺少 BINNY_BIN_ID，运行器无法标识已配置 bin。");
}
const runtimeBinId = binId;

if (apiUrl === undefined) {
  throw new Error("缺少 BINNY_API_URL，运行器无法连接 Binny 核心。");
}

try {
  new URL(apiUrl);
} catch {
  throw new Error(`BINNY_API_URL 不是有效 URL：${apiUrl}`);
}

if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65_535) {
  throw new Error(`BINNY_RUNTIME_PORT 不是有效端口：${String(runtimePort)}`);
}

if (environmentKind !== "lightweight" && environmentKind !== "browser") {
  throw new Error(`未知运行环境：${environmentKind}`);
}

if (!Number.isInteger(heartbeatInterval) || heartbeatInterval < 250) {
  throw new Error("BINNY_RUNTIME_HEARTBEAT_INTERVAL_MS 必须大于等于 250。");
}

async function findOwnerLockDescriptor(): Promise<{
  readonly descriptor: number;
  readonly path: string;
}> {
  let expectedPath: string;
  try {
    expectedPath = await realpath(ownerLockPath);
  } catch {
    throw new Error(
      `运行器没有持有 owner lock：请用 flock 锁定 ${ownerLockPath} 后启动。`,
    );
  }
  for (const entry of await readdir("/proc/self/fd")) {
    const descriptor = Number(entry);
    if (!Number.isInteger(descriptor)) continue;
    try {
      if ((await realpath(`/proc/self/fd/${entry}`)) === expectedPath)
        return { descriptor, path: expectedPath };
    } catch {
      // fd 列表可能在遍历时关闭临时描述符。
    }
  }
  throw new Error(
    `运行器没有持有 owner lock：请用 flock 锁定 ${ownerLockPath} 后启动。`,
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function advanceOwnerGeneration(
  ownerLockRealPath: string,
): Promise<string> {
  const directoryPath = dirname(ownerLockRealPath);
  const generationPath = join(directoryPath, "owner.generation");
  let current = 0n;
  try {
    const saved = await readFile(generationPath, "utf8");
    const match = /^(0|[1-9][0-9]*)\n$/u.exec(saved);
    if (match === null)
      throw new Error("运行器所有权代际文件格式无效，拒绝重新编号。");
    current = BigInt(match[1]!);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT"))
      throw new Error("无法读取运行器所有权代际，不能启动控制器。", {
        cause: error,
      });
  }

  const next = current + 1n;
  if (next > 9_223_372_036_854_775_807n)
    throw new Error("运行器所有权代际已用尽，不能启动控制器。");

  const temporaryPath = join(
    directoryPath,
    `.owner-generation-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryFile: FileHandle | undefined;
  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(`${next.toString()}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, generationPath);
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return next.toString();
  } catch (error) {
    if (temporaryFile !== undefined)
      await temporaryFile.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw new Error("无法持久发布运行器所有权代际，不能发送首个心跳。", {
      cause: error,
    });
  }
}

const ownerLock = await findOwnerLockDescriptor();
const ownerLockDescriptor = ownerLock.descriptor;
const ownerGeneration = await advanceOwnerGeneration(ownerLock.path);
const importedCollector = (await import(pathToFileURL(collectorPath).href)) as {
  readonly default?: CollectorDefinition;
  readonly collector?: CollectorDefinition;
};
const collector = importedCollector.default ?? importedCollector.collector;
if (collector === undefined)
  throw new Error(
    `采集器模块 ${collectorPath} 必须导出 default 或 collector。`,
  );

const activeCollector: CollectorDefinition = collector;
const manifest = collectorManifest(activeCollector);
const environment: RuntimeEnvironment = {
  kind: environmentKind,
  browser: {
    available: environmentKind === "browser",
    profileReuseAfterRestart:
      environmentKind === "browser" &&
      process.env.BINNY_BROWSER_PROFILE_REUSE === "true",
  },
};
const runtimeId = randomUUID();
const server = createRuntimeServer({ collector: activeCollector });
const client = createApiClient(apiUrl, {
  fetch: (input, init) => {
    const timeout = AbortSignal.timeout(3_000);
    const signal =
      init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
    return fetch(input, { ...init, signal });
  },
});
let heartbeatTimer: NodeJS.Timeout | undefined;
let heartbeatInFlight: Promise<void> | undefined;
let runInFlight: Promise<void> | undefined;
let activeWorker: ActionWorker | undefined;
let activeRunId: string | null = null;
let pendingStoppedRunId: string | undefined;
let claimInFlight = false;
let stopping: Promise<void> | undefined;
let lastStatus: string | undefined;

type WorkerOutcome =
  | { readonly type: "completion"; readonly completion: ManualRunCompletion }
  | {
      readonly type: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

type ActionWorker = {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly ready: Promise<void>;
  readonly outcome: Promise<WorkerOutcome>;
  readonly closed: Promise<void>;
  stopPromise?: Promise<void>;
};

function logStatus(status: string, detail?: string): void {
  if (lastStatus === status) return;
  lastStatus = status;
  const suffix = detail === undefined ? "" : `：${detail}`;
  process.stdout.write(
    `运行器连接状态：bin=${binId} status=${status}${suffix}\n`,
  );
}

function parseWorkerMessage(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function startActionWorker(): ActionWorker {
  const child = spawn(process.execPath, [workerEntry], {
    detached: true,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit", "ipc", ownerLockDescriptor],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("无法启动隔离的采集器执行进程。");

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readyResolved = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveOutcome!: (outcome: WorkerOutcome) => void;
  let outcomeResolved = false;
  const outcome = new Promise<WorkerOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  child.on("message", (value: unknown) => {
    const message = parseWorkerMessage(value);
    if (typeof message !== "object" || message === null || !("type" in message))
      return;
    if (message.type === "ready") {
      readyResolved = true;
      resolveReady();
      return;
    }
    if (message.type !== "completion" || outcomeResolved) return;
    const completion =
      typeof message === "object" && "completion" in message
        ? manualRunCompletionSchema.safeParse(message.completion)
        : undefined;
    if (completion === undefined || !completion.success) return;
    outcomeResolved = true;
    resolveOutcome({ type: "completion", completion: completion.data });
  });
  child.once("error", (error) => {
    if (!readyResolved) rejectReady(error);
    if (!outcomeResolved) {
      outcomeResolved = true;
      resolveOutcome({ type: "exit", code: 1, signal: null });
    }
  });
  child.once("close", (code, signal) => {
    if (!readyResolved)
      rejectReady(new Error("采集器执行进程在启动完成前退出。"));
    if (!outcomeResolved) {
      outcomeResolved = true;
      resolveOutcome({ type: "exit", code, signal });
    }
  });
  return { child, pid, ready, outcome, closed };
}

function sendWorkerMessage(
  worker: ActionWorker,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!worker.child.connected) {
      reject(new Error("采集器执行进程 IPC 通道已经关闭。"));
      return;
    }
    worker.child.send(JSON.stringify(value), (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
}

function groupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return false;
    return true;
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return;
    process.stderr.write(
      `无法向采集器进程组发送 ${signal}：${String(error)}；继续保留 bin 占用。\n`,
    );
  }
}

function stopActionWorker(worker: ActionWorker): Promise<void> {
  if (worker.stopPromise !== undefined) return worker.stopPromise;
  worker.stopPromise = (async () => {
    const startedAt = Date.now();
    const terminateAt = startedAt + stopGraceMs;
    let killed = false;
    let failureReported = false;
    signalProcessGroup(worker.pid, "SIGTERM");
    while (groupExists(worker.pid)) {
      if (!killed && Date.now() >= terminateAt) {
        killed = true;
        signalProcessGroup(worker.pid, "SIGKILL");
      }
      if (!failureReported && Date.now() - startedAt >= stopConfirmationLogMs) {
        failureReported = true;
        process.stderr.write(
          `采集器进程组仍未确认退出：pid=${worker.pid} bin=${binId}；运行继续占用 bin。\n`,
        );
      }
      await delay(25);
    }
    await worker.closed;
  })();
  return worker.stopPromise;
}

async function readRun(
  run: ManualRunExecution,
): Promise<ManualRun | undefined> {
  try {
    const response = await client.bins[":binId"].runs[":runId"].$get({
      param: { binId: runtimeBinId, runId: run.runId },
    });
    return response.status === 200 ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

function interruptFailure(): ManualRunCompletion {
  return {
    status: "failed",
    completedScopes: [],
    error: {
      code: "runtime_interrupted",
      message: "运行器正在停止，本次动作没有恢复执行。",
      impact: "本次运行已终结；之前提交的资料仍然保留。",
      suggestion: "检查运行器后重新触发新的运行。",
      requiresHuman: false,
    },
  };
}

async function finishRun(
  run: ManualRunExecution,
  completion: ManualRunCompletion,
): Promise<void> {
  const result = await client.bins[":binId"].runtime.runs[
    ":runId"
  ].complete.$post({
    param: { binId: runtimeBinId, runId: run.runId },
    json: { runtimeId, completion },
  });
  switch (result.status) {
    case 200:
      return;
    case 400:
    case 404:
    case 409: {
      const failure = await result.json();
      process.stderr.write(
        `运行结果未能写入：run=${run.runId} code=${failure.error.code} message=${failure.error.message}\n`,
      );
      return;
    }
  }
}

async function awaitExecutionPermission(
  run: ManualRunExecution,
): Promise<"execute" | "cancel" | "terminal" | "shutdown"> {
  while (true) {
    if (stopping !== undefined) return "shutdown";
    const current = await readRun(run);
    if (current === undefined) {
      await delay(250);
      continue;
    }
    if (current.status === "executing") return "execute";
    if (current.status === "cancelling") return "cancel";
    return "terminal";
  }
}

async function executeRun(run: ManualRunExecution): Promise<void> {
  const permission = await awaitExecutionPermission(run);
  if (permission === "terminal") return;
  if (permission === "cancel") {
    await acknowledgeStoppedRun(run.runId);
    return;
  }
  if (permission === "shutdown") {
    const current = await readRun(run);
    if (current?.status === "cancelling") {
      await acknowledgeStoppedRun(run.runId);
    } else if (current?.status === "executing") {
      await finishRun(run, interruptFailure());
    }
    return;
  }

  let worker: ActionWorker | undefined;
  let workerStopped = false;
  async function stopWorker(): Promise<void> {
    if (worker === undefined || workerStopped) return;
    await stopActionWorker(worker);
    workerStopped = true;
    if (activeWorker === worker) activeWorker = undefined;
  }
  try {
    worker = startActionWorker();
    activeWorker = worker;
    const readyDeadline = Date.now() + 10_000;
    await Promise.race([
      worker.ready,
      (async () => {
        while (Date.now() < readyDeadline) await delay(25);
        throw new Error("采集器执行进程启动超时。");
      })(),
    ]);
    const afterStart = await awaitExecutionPermission(run);
    if (afterStart === "terminal") {
      await stopWorker();
      await acknowledgeStoppedRun(run.runId);
      return;
    }
    if (afterStart === "cancel") {
      await stopWorker();
      await acknowledgeStoppedRun(run.runId);
      return;
    }
    if (afterStart === "shutdown") {
      await stopWorker();
      const current = await readRun(run);
      if (current?.status !== "cancelling")
        await finishRun(run, interruptFailure());
      await acknowledgeStoppedRun(run.runId);
      return;
    }

    await sendWorkerMessage(worker, { type: "execute", run });
    while (true) {
      const outcome = await Promise.race([
        worker.outcome,
        delay(250).then(() => undefined),
      ]);
      if (outcome?.type === "completion") {
        await stopWorker();
        const current = await readRun(run);
        if (current?.status === "executing")
          await finishRun(run, outcome.completion);
        await acknowledgeStoppedRun(run.runId);
        return;
      }
      if (outcome?.type === "exit") {
        await stopWorker();
        const current = await readRun(run);
        if (current?.status === "executing")
          await finishRun(run, {
            status: "failed",
            completedScopes: [],
            error: {
              code: "collector_process_interrupted",
              message: "采集器执行进程意外退出。",
              impact: "本次运行未恢复执行；之前提交的资料仍然保留。",
              suggestion: "检查采集器后重新触发新的运行。",
              requiresHuman: false,
            },
          });
        await acknowledgeStoppedRun(run.runId);
        return;
      }

      const current = await readRun(run);
      if (current?.status === "cancelling") {
        await stopWorker();
        await acknowledgeStoppedRun(run.runId);
        return;
      }
      if (current !== undefined && current.status !== "executing") {
        await stopWorker();
        await acknowledgeStoppedRun(run.runId);
        return;
      }
      if (stopping !== undefined) {
        await stopWorker();
        const afterStop = await readRun(run);
        if (afterStop?.status !== "cancelling")
          await finishRun(run, interruptFailure());
        await acknowledgeStoppedRun(run.runId);
        return;
      }
    }
  } catch (error) {
    await stopWorker();
    const current = await readRun(run);
    if (current?.status === "executing") {
      try {
        await finishRun(run, {
          status: "failed",
          completedScopes: [],
          error: {
            code: "collector_process_start_failed",
            message: "无法启动隔离的采集器执行进程。",
            impact: "本次运行未执行。",
            suggestion: "检查运行器镜像后重新触发。",
            requiresHuman: false,
          },
        });
      } catch (completionError) {
        process.stderr.write(
          `运行结果提交失败：run=${run.runId} ${completionError instanceof Error ? completionError.message : String(completionError)}\n`,
        );
      }
      process.stderr.write(
        `运行器无法启动采集器执行进程：run=${run.runId} ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (worker === undefined || workerStopped)
      await acknowledgeStoppedRun(run.runId);
  } finally {
    if (workerStopped && activeWorker === worker) activeWorker = undefined;
  }
}

async function heartbeat(allowStopping = false): Promise<void> {
  if (stopping !== undefined && !allowStopping) return;
  const stoppedRunId = pendingStoppedRunId;
  try {
    const response = await client.bins[":binId"].runtime.heartbeat.$post({
      param: { binId: runtimeBinId },
      json: {
        protocolVersion: runtimeProtocolVersion,
        runtimeId,
        ownerGeneration,
        ownerLockAcquired: true,
        activeRunId,
        claimInFlight,
        ...(stoppedRunId === undefined ? {} : { stoppedRunId }),
        collector: manifest,
        environment,
      },
    });
    if (response.status === 200) {
      const execution = await response.json();
      if (stoppedRunId !== undefined && pendingStoppedRunId === stoppedRunId)
        pendingStoppedRunId = undefined;
      logStatus(execution.status);
      if (
        execution.status === "online" &&
        stopping === undefined &&
        pendingStoppedRunId === undefined
      )
        void pollRun();
    } else {
      const result = await response.json();
      logStatus(result.error.code, result.error.message);
    }
  } catch (error) {
    logStatus(
      "disconnected",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (stopping === undefined) {
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        startHeartbeat();
      }, heartbeatInterval);
    }
  }
}

async function sendHeartbeatNow(allowStopping = false): Promise<void> {
  if (heartbeatTimer !== undefined) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  while (heartbeatInFlight !== undefined) await heartbeatInFlight;
  if (heartbeatTimer !== undefined) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (stopping !== undefined && !allowStopping) return;
  const current = heartbeat(allowStopping);
  heartbeatInFlight = current;
  try {
    await current;
  } finally {
    if (heartbeatInFlight === current) heartbeatInFlight = undefined;
  }
}

async function acknowledgeStoppedRun(runId: string): Promise<void> {
  pendingStoppedRunId = runId;
  if (activeRunId === runId) activeRunId = null;
  await sendHeartbeatNow(stopping !== undefined);
}

async function pollRun(): Promise<void> {
  if (runInFlight !== undefined || claimInFlight || stopping !== undefined)
    return;
  claimInFlight = true;
  try {
    const response = await client.bins[":binId"].runtime.runs.claim.$post({
      param: { binId: runtimeBinId },
      json: { runtimeId },
    });
    switch (response.status) {
      case 200: {
        const result = await response.json();
        if (result.run === null) return;
        activeRunId = result.run.runId;
        const current = executeRun(result.run);
        runInFlight = current;
        void current.then(
          () => {
            if (runInFlight === current) runInFlight = undefined;
            if (activeRunId === result.run?.runId) activeRunId = null;
            if (stopping === undefined) startHeartbeat();
          },
          (error: unknown) => {
            process.stderr.write(
              `运行器尚未确认 worker 已停止：run=${result.run?.runId ?? "unknown"} ${error instanceof Error ? error.message : String(error)}；保留执行引用与 bin 占用。\n`,
            );
          },
        );
        return;
      }
      case 400:
      case 404:
      case 409: {
        const result = await response.json();
        process.stderr.write(
          `运行器领取失败：code=${result.error.code} message=${result.error.message}\n`,
        );
        return;
      }
    }
  } catch (error) {
    process.stderr.write(
      `运行器暂时无法领取任务：${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    claimInFlight = false;
  }
}

function startHeartbeat(): void {
  if (stopping !== undefined || heartbeatInFlight !== undefined) return;
  if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
  heartbeatTimer = undefined;
  const current = heartbeat();
  heartbeatInFlight = current;
  void current.then(
    () => {
      if (heartbeatInFlight === current) heartbeatInFlight = undefined;
    },
    () => {
      if (heartbeatInFlight === current) heartbeatInFlight = undefined;
    },
  );
}

async function disconnect(): Promise<void> {
  try {
    await client.bins[":binId"].runtime.disconnect.$post({
      param: { binId: runtimeBinId },
      json: {
        runtimeId,
        ownerLockAcquired: true,
        activeRunId: null,
        claimInFlight: false,
      },
    });
  } catch {
    // API 不可达时保留核心中最后一次执行者与 run 的对应关系。
  }
}

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function shutdown(): Promise<void> {
  if (stopping !== undefined) return stopping;
  stopping = (async () => {
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    if (heartbeatInFlight !== undefined) await heartbeatInFlight;
    while (claimInFlight) await delay(25);
    if (activeWorker !== undefined) await stopActionWorker(activeWorker);
    if (runInFlight !== undefined) await runInFlight;
    await disconnect();
    await closeServer();
  })();
  return stopping;
}

server.listen(runtimePort, "0.0.0.0", () => {
  process.stdout.write(
    `运行器已启动：bin=${binId} collector=${collector.id} port=${runtimePort}\n`,
  );
  startHeartbeat();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 1;
      },
    );
  });
}
