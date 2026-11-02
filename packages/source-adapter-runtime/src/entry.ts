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
  manualRunCompletionSchema,
  runtimeHeartbeatIntervalMs,
  runtimeEnvironmentKindSchema,
  runtimeProtocolVersion,
  type ManualRunCompletion,
  type ManualRunExecution,
  type ManualRun,
  type BrowserPower,
  type RuntimeHumanSessionControl,
  type RuntimeHumanSessionEvent,
  type RuntimeEnvironment,
} from "@binny/contracts";
import {
  sourceAdapterManifest,
  type SourceAdapterBrowserConnection,
  type SourceAdapterDefinition,
} from "@binny/source-adapter-sdk";

import {
  BrowserLifecycle,
  type BrowserPowerChangeResult,
  type BrowserPowerEvent,
} from "./browser-lifecycle.ts";
import { createRuntimeServer } from "./runtime-server.ts";

const sourceAdapterPath =
  process.env.BINNY_SOURCE_ADAPTER_ENTRY ?? "/app/dist/index.js";
const binId = process.env.BINNY_BIN_ID;
const apiUrl = process.env.BINNY_API_URL;
const runtimePort = Number(process.env.BINNY_RUNTIME_PORT ?? "8080");
const environmentKind = runtimeEnvironmentKindSchema.parse(
  process.env.BINNY_RUNTIME_ENVIRONMENT ?? "lightweight",
);
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
const importedSourceAdapter = (await import(
  pathToFileURL(sourceAdapterPath).href
)) as {
  readonly default?: SourceAdapterDefinition;
  readonly sourceAdapter?: SourceAdapterDefinition;
};
const sourceAdapter =
  importedSourceAdapter.default ?? importedSourceAdapter.sourceAdapter;
if (sourceAdapter === undefined)
  throw new Error(
    `信源适配器模块 ${sourceAdapterPath} 必须导出 default 或 sourceAdapter。`,
  );

const activeSourceAdapter: SourceAdapterDefinition = sourceAdapter;
const manifest = sourceAdapterManifest(activeSourceAdapter);
let browserPower: BrowserPower = {
  status: environmentKind === "browser" ? "stopped" : "unavailable",
};
let browserIdleTimeoutSeconds: number | null | undefined;
let browserIdleSince: number | undefined;
let browserIdleTimer: NodeJS.Timeout | undefined;
let browserIdleProbeInFlight = false;
let browserIdleCloseInFlight: Promise<void> | undefined;
const pendingBrowserPowerEvents: {
  readonly reservationId: string;
  readonly event: BrowserPowerEvent;
  readonly power: BrowserPower;
}[] = [];
let browserPowerEventsInFlight: Promise<BrowserPowerChangeResult> | undefined;
const runtimeId = randomUUID();
const browserLifecycle =
  environmentKind === "browser"
    ? new BrowserLifecycle({
        apiUrl,
        binId: runtimeBinId,
        runtimeId,
        ownerGeneration,
        profileDirectory:
          process.env.BINNY_BROWSER_PROFILE_DIRECTORY ??
          "/var/lib/binny/runtime/browser-profile",
        async onPowerChange(power, reservationId, event) {
          browserPower = power;
          refreshBrowserIdle();
          if (event !== undefined && reservationId !== undefined)
            return await reportBrowserPowerEvent(reservationId, event, power);
          startHeartbeat();
          return "accepted";
        },
      })
    : undefined;
function runtimeEnvironment(): RuntimeEnvironment {
  return {
    kind: environmentKind,
    browser: {
      available: environmentKind === "browser",
      profileReuseAfterRestart:
        environmentKind === "browser" &&
        process.env.BINNY_BROWSER_PROFILE_REUSE === "true",
      power: browserLifecycle?.currentPower ?? browserPower,
    },
  };
}

const server = createRuntimeServer({ sourceAdapter: activeSourceAdapter });
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
let activeHumanSessionId: string | undefined;
let openingHumanSessionId: string | undefined;
let pendingHumanSessionEvent: RuntimeHumanSessionEvent | undefined;
let claimInFlight = false;
let stopping: Promise<void> | undefined;
let lastStatus: string | undefined;

async function sendBrowserPowerEventNow(
  event: (typeof pendingBrowserPowerEvents)[number],
): Promise<BrowserPowerChangeResult> {
  try {
    const environment = runtimeEnvironment();
    const response = await client.bins[":binId"].runtime.heartbeat.$post({
      param: { binId: runtimeBinId },
      json: {
        protocolVersion: runtimeProtocolVersion,
        runtimeId,
        ownerGeneration,
        ownerLockAcquired: true,
        activeRunId,
        claimInFlight,
        sourceAdapter: manifest,
        environment:
          event.event === "not_started"
            ? {
                ...environment,
                browser: {
                  ...environment.browser,
                  power: event.power,
                },
              }
            : environment,
        browserPowerEvent: {
          reservationId: event.reservationId,
          event: event.event,
        },
      },
    });
    if (response.status === 200) {
      const result = await response.json();
      acceptBrowserIdleTimeout(result.browserIdleTimeoutSeconds);
      logStatus(result.status);
      return "accepted";
    }
    if (response.status >= 500) return "unavailable";
    await response.json();
    return "rejected";
  } catch {
    return "unavailable";
  }
}

function removeBrowserPowerEvents(
  reservationId: string,
  events: readonly BrowserPowerEvent[],
): void {
  for (let index = pendingBrowserPowerEvents.length - 1; index >= 0; index--) {
    const pending = pendingBrowserPowerEvents[index]!;
    if (
      pending.reservationId === reservationId &&
      events.includes(pending.event)
    )
      pendingBrowserPowerEvents.splice(index, 1);
  }
}

async function flushBrowserPowerEvents(): Promise<BrowserPowerChangeResult> {
  if (browserPowerEventsInFlight !== undefined)
    return await browserPowerEventsInFlight;
  const work = (async () => {
    while (pendingBrowserPowerEvents.length > 0) {
      const event = pendingBrowserPowerEvents[0]!;
      const result = await sendBrowserPowerEventNow(event);
      if (result === "accepted") {
        if (pendingBrowserPowerEvents[0] === event)
          pendingBrowserPowerEvents.shift();
        if (
          event.event === "stopping" &&
          browserPower.status === "stopped" &&
          !pendingBrowserPowerEvents.some(
            (pending) =>
              pending.reservationId === event.reservationId &&
              pending.event === "stopped",
          )
        )
          pendingBrowserPowerEvents.push({
            reservationId: event.reservationId,
            event: "stopped",
            power: { status: "stopped" },
          });
        continue;
      }
      if (result === "unavailable") return result;

      const hasRestart = pendingBrowserPowerEvents.some(
        (pending) =>
          pending.reservationId === event.reservationId &&
          (pending.event === "starting" || pending.event === "ready"),
      );
      if (
        hasRestart &&
        (event.event === "stopping" || event.event === "stopped")
      ) {
        removeBrowserPowerEvents(event.reservationId, ["stopping", "stopped"]);
        continue;
      }
      if (
        event.event === "starting" ||
        event.event === "ready" ||
        event.event === "unknown" ||
        event.event === "not_started"
      )
        removeBrowserPowerEvents(event.reservationId, [event.event]);
      return result;
    }
    return "accepted";
  })();
  browserPowerEventsInFlight = work;
  try {
    return await work;
  } finally {
    if (browserPowerEventsInFlight === work)
      browserPowerEventsInFlight = undefined;
  }
}

async function reportBrowserPowerEvent(
  reservationId: string,
  event: BrowserPowerEvent,
  power: BrowserPower,
): Promise<BrowserPowerChangeResult> {
  if (event === "not_started")
    removeBrowserPowerEvents(reservationId, [
      "starting",
      "ready",
      "stopping",
      "stopped",
      "unknown",
    ]);
  if (
    event === "stopped" &&
    !pendingBrowserPowerEvents.some(
      (pending) =>
        pending.reservationId === reservationId && pending.event === "stopping",
    )
  )
    pendingBrowserPowerEvents.push({
      reservationId,
      event: "stopping",
      power,
    });
  if (
    !pendingBrowserPowerEvents.some(
      (pending) =>
        pending.reservationId === reservationId && pending.event === event,
    )
  )
    pendingBrowserPowerEvents.push({ reservationId, event, power });

  const result = await flushBrowserPowerEvents();
  if (event === "starting" && result !== "accepted")
    removeBrowserPowerEvents(reservationId, ["starting"]);
  if (pendingBrowserPowerEvents.length > 0) startHeartbeat();
  return result;
}

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
  if (pid === undefined) throw new Error("无法启动隔离的信源适配器执行进程。");

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
      rejectReady(new Error("信源适配器执行进程在启动完成前退出。"));
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
      reject(new Error("信源适配器执行进程 IPC 通道已经关闭。"));
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
      `无法向信源适配器进程组发送 ${signal}：${String(error)}；继续保留 bin 占用。\n`,
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
          `信源适配器进程组仍未确认退出：pid=${worker.pid} bin=${binId}；运行继续占用 bin。\n`,
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
  const browserReservationId = run.browserReservationId;
  async function confirmNotStarted(): Promise<void> {
    if (browserReservationId !== undefined)
      await browserLifecycle?.confirmNotStarted(browserReservationId);
  }
  if (permission === "terminal") {
    await confirmNotStarted();
    return;
  }
  if (permission === "cancel") {
    await confirmNotStarted();
    await acknowledgeStoppedRun(run.runId);
    return;
  }
  if (permission === "shutdown") {
    const current = await readRun(run);
    if (current?.status === "cancelling") {
      await confirmNotStarted();
      await acknowledgeStoppedRun(run.runId);
    } else if (current?.status === "executing") {
      await finishRun(run, interruptFailure());
      await confirmNotStarted();
    }
    return;
  }

  let worker: ActionWorker | undefined;
  let workerStopped = false;
  let browserBound = false;
  let browserConnection: SourceAdapterBrowserConnection | undefined;
  async function stopWorker(): Promise<void> {
    if (browserBound) await browserLifecycle?.unbindWorkerEndpoint();
    if (worker !== undefined && !workerStopped) {
      await stopActionWorker(worker);
      workerStopped = true;
      if (activeWorker === worker) activeWorker = undefined;
    }
    if (browserBound) {
      if (browserLifecycle === undefined)
        throw new Error("浏览器运行环境没有可用的生命周期控制器。");
      await browserLifecycle.cleanAutomaticPages();
      browserBound = false;
    }
  }
  try {
    if (activeSourceAdapter.environment.browser.required) {
      if (browserLifecycle === undefined)
        throw new Error(
          "本次信源适配器需要浏览器，但运行镜像没有浏览器控制器。",
        );
      if (browserReservationId === undefined)
        throw new Error("运行器没有收到浏览器容量预约，拒绝启动浏览器。");
      await browserLifecycle.ensureReady(browserReservationId);
      browserConnection = await browserLifecycle.bindWorkerEndpoint(
        run.runId,
        browserReservationId,
      );
      browserBound = true;
    }
    worker = startActionWorker();
    activeWorker = worker;
    const readyDeadline = Date.now() + 10_000;
    await Promise.race([
      worker.ready,
      (async () => {
        while (Date.now() < readyDeadline) await delay(25);
        throw new Error("信源适配器执行进程启动超时。");
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

    await sendWorkerMessage(worker, {
      type: "execute",
      run: {
        runId: run.runId,
        binId: run.binId,
        identityId: run.identityId,
        sourceAdapterId: run.sourceAdapterId,
        sourceAdapterVersion: run.sourceAdapterVersion,
        action: run.action,
        params: run.params,
        config: run.config,
        targets: run.targets,
      },
      ...(browserConnection === undefined
        ? {}
        : { browser: browserConnection }),
    });
    while (true) {
      const outcome = await Promise.race([
        worker.outcome,
        delay(250).then(() => undefined),
      ]);
      // 容器停机时 worker 可能先回传动作错误；该结果不能覆盖运行器中断语义。
      if (outcome?.type === "completion") {
        await stopWorker();
        const current = await readRun(run);
        if (current?.status === "executing")
          await finishRun(
            run,
            stopping === undefined ? outcome.completion : interruptFailure(),
          );
        await acknowledgeStoppedRun(run.runId);
        return;
      }
      if (outcome?.type === "exit") {
        await stopWorker();
        const current = await readRun(run);
        if (current?.status === "executing") {
          await finishRun(
            run,
            stopping === undefined
              ? {
                  status: "failed",
                  completedScopes: [],
                  error: {
                    code: "source_adapter_process_interrupted",
                    message: "信源适配器执行进程意外退出。",
                    impact: "本次运行未恢复执行；之前提交的资料仍然保留。",
                    suggestion: "检查信源适配器后重新触发新的运行。",
                    requiresHuman: false,
                  },
                }
              : interruptFailure(),
          );
        }
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
            code: "source_adapter_process_start_failed",
            message: "无法启动隔离的信源适配器执行进程。",
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
        `运行器无法启动信源适配器执行进程：run=${run.runId} ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (worker === undefined) await confirmNotStarted();
    if (worker === undefined || workerStopped)
      await acknowledgeStoppedRun(run.runId);
  } finally {
    if (workerStopped && activeWorker === worker) activeWorker = undefined;
  }
}

async function closeHumanSessionAfterHeartbeatFailure(): Promise<void> {
  const sessionId = activeHumanSessionId;
  if (sessionId === undefined || browserLifecycle === undefined) return;
  try {
    // 核心不可达时先停掉本地画面与通道，状态事件留待下一次正常心跳回报。
    await browserLifecycle.closeHumanSession(sessionId);
    if (activeHumanSessionId === sessionId) activeHumanSessionId = undefined;
    if (pendingHumanSessionEvent?.sessionId !== sessionId)
      pendingHumanSessionEvent = { sessionId, event: "closed" };
  } catch (error) {
    process.stderr.write(
      `核心心跳失败后浏览器通道仍未确认关闭：session=${sessionId} ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function clearBrowserIdleTimer(): void {
  if (browserIdleTimer !== undefined) clearTimeout(browserIdleTimer);
  browserIdleTimer = undefined;
}

function browserHasActiveUse(): boolean {
  return (
    runInFlight !== undefined ||
    activeRunId !== null ||
    pendingStoppedRunId !== undefined ||
    activeHumanSessionId !== undefined ||
    openingHumanSessionId !== undefined ||
    pendingHumanSessionEvent !== undefined ||
    stopping !== undefined
  );
}

function browserIdleCloseIsDue(): boolean {
  if (
    browserIdleSince === undefined ||
    browserIdleTimeoutSeconds === undefined ||
    browserIdleTimeoutSeconds === null
  )
    return false;
  return Date.now() >= browserIdleSince + browserIdleTimeoutSeconds * 1_000;
}

function scheduleBrowserIdleClose(waitMs: number): void {
  clearBrowserIdleTimer();
  const timer = setTimeout(
    () => {
      if (browserIdleTimer === timer) browserIdleTimer = undefined;
      void closeBrowserWhenIdle();
    },
    Math.max(0, waitMs),
  );
  browserIdleTimer = timer;
}

function refreshBrowserIdle(): void {
  if (browserLifecycle === undefined) return;
  if (browserHasActiveUse()) {
    clearBrowserIdleTimer();
    browserIdleSince = undefined;
    return;
  }
  if (browserPower.status === "stopped") {
    clearBrowserIdleTimer();
    browserIdleSince = undefined;
    return;
  }
  if (browserPower.status !== "ready") {
    clearBrowserIdleTimer();
    return;
  }
  if (browserIdleProbeInFlight) return;
  if (browserIdleSince === undefined) browserIdleSince = Date.now();
  if (browserIdleTimeoutSeconds === undefined) return;
  if (browserIdleTimeoutSeconds === null) {
    clearBrowserIdleTimer();
    return;
  }
  if (browserIdleTimer !== undefined) return;
  scheduleBrowserIdleClose(
    browserIdleSince + browserIdleTimeoutSeconds * 1_000 - Date.now(),
  );
}

function acceptBrowserIdleTimeout(value: number | null): void {
  if (browserIdleTimeoutSeconds !== value) {
    browserIdleTimeoutSeconds = value;
    if (browserIdleSince !== undefined) browserIdleSince = Date.now();
    clearBrowserIdleTimer();
  }
  refreshBrowserIdle();
}

function closeBrowserWhenIdle(): Promise<void> {
  if (browserIdleCloseInFlight !== undefined) return browserIdleCloseInFlight;
  const closing = runBrowserIdleClose();
  browserIdleCloseInFlight = closing;
  void closing.finally(() => {
    if (browserIdleCloseInFlight === closing)
      browserIdleCloseInFlight = undefined;
  });
  return closing;
}

async function runBrowserIdleClose(): Promise<void> {
  if (
    browserLifecycle === undefined ||
    browserHasActiveUse() ||
    browserPower.status !== "ready" ||
    !browserIdleCloseIsDue()
  ) {
    refreshBrowserIdle();
    return;
  }
  if (claimInFlight) {
    scheduleBrowserIdleClose(50);
    return;
  }

  browserIdleProbeInFlight = true;
  try {
    await sendHeartbeatNow(false, false);
    if (!browserHasActiveUse() && browserPower.status === "ready")
      await pollRun();
  } finally {
    browserIdleProbeInFlight = false;
  }
  if (
    browserHasActiveUse() ||
    browserPower.status !== "ready" ||
    claimInFlight
  ) {
    if (!browserHasActiveUse() && claimInFlight) scheduleBrowserIdleClose(50);
    else refreshBrowserIdle();
    return;
  }

  // heartbeat 与领取探测会让出事件循环，期间策略及空闲起点都可能改变。
  if (!browserIdleCloseIsDue()) {
    refreshBrowserIdle();
    return;
  }

  // 关闭开始后新 run／人工请求沿同一生命周期等待真实退出再唤醒。
  browserIdleSince = undefined;
  try {
    await browserLifecycle.closeWhenIdle();
  } catch (error) {
    process.stderr.write(
      `浏览器空闲关闭未确认：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function heartbeat(
  allowStopping = false,
  pollRuns = true,
): Promise<void> {
  if (stopping !== undefined && !allowStopping) return;
  const stoppedRunId = pendingStoppedRunId;
  const humanSessionEvent = pendingHumanSessionEvent;
  let heartbeatAccepted = false;
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
        ...(humanSessionEvent === undefined ? {} : { humanSessionEvent }),
        sourceAdapter: manifest,
        environment: runtimeEnvironment(),
      },
    });
    if (response.status === 200) {
      const execution = await response.json();
      heartbeatAccepted = true;
      acceptBrowserIdleTimeout(execution.browserIdleTimeoutSeconds);
      if (stoppedRunId !== undefined && pendingStoppedRunId === stoppedRunId)
        pendingStoppedRunId = undefined;
      if (
        humanSessionEvent !== undefined &&
        pendingHumanSessionEvent === humanSessionEvent
      )
        pendingHumanSessionEvent = undefined;
      if (execution.humanSession !== undefined)
        await applyHumanSessionControl(execution.humanSession);
      logStatus(execution.status);
      refreshBrowserIdle();
      if (
        execution.status === "online" &&
        stopping === undefined &&
        pendingStoppedRunId === undefined &&
        pollRuns
      )
        void pollRun();
    } else {
      const result = await response.json();
      logStatus(result.error.code, result.error.message);
      await closeHumanSessionAfterHeartbeatFailure();
    }
  } catch (error) {
    logStatus(
      "disconnected",
      error instanceof Error ? error.message : String(error),
    );
    await closeHumanSessionAfterHeartbeatFailure();
  } finally {
    if (
      pendingBrowserPowerEvents.length > 0 &&
      browserPowerEventsInFlight === undefined
    )
      void flushBrowserPowerEvents();
    if (stopping === undefined) {
      heartbeatTimer = setTimeout(
        () => {
          heartbeatTimer = undefined;
          startHeartbeat();
        },
        heartbeatAccepted && pendingHumanSessionEvent !== undefined
          ? 0
          : heartbeatInterval,
      );
    }
  }
}

async function sendHeartbeatNow(
  allowStopping = false,
  pollRuns = true,
): Promise<void> {
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
  const current = heartbeat(allowStopping, pollRuns);
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

async function applyHumanSessionControl(
  control: RuntimeHumanSessionControl,
): Promise<void> {
  if (control.action === "open") {
    if (activeHumanSessionId === control.sessionId) return;
    if (control.browserReservationId === undefined) {
      pendingHumanSessionEvent = {
        sessionId: control.sessionId,
        event: "failed",
        failure: {
          code: "browser_reservation_missing",
          message: "核心没有提供浏览器容量预约。",
        },
      };
      return;
    }
    if (browserLifecycle === undefined) {
      pendingHumanSessionEvent = {
        sessionId: control.sessionId,
        event: "failed",
        failure: {
          code: "browser_unavailable",
          message: "运行器镜像没有浏览器环境。",
        },
      };
      return;
    }
    clearBrowserIdleTimer();
    browserIdleSince = undefined;
    openingHumanSessionId = control.sessionId;
    try {
      const { ended } = await browserLifecycle.openHumanSession(
        control.sessionId,
        control.tunnelToken,
        control.browserReservationId,
      );
      activeHumanSessionId = control.sessionId;
      openingHumanSessionId = undefined;
      pendingHumanSessionEvent = {
        sessionId: control.sessionId,
        event: "ready",
      };
      void ended.then((result) => {
        if (activeHumanSessionId !== control.sessionId) return;
        activeHumanSessionId = undefined;
        pendingHumanSessionEvent =
          result.failure === undefined
            ? { sessionId: control.sessionId, event: "closed" }
            : {
                sessionId: control.sessionId,
                event: "failed",
                failure: result.failure,
              };
        startHeartbeat();
      });
    } catch (error) {
      if (openingHumanSessionId === control.sessionId)
        openingHumanSessionId = undefined;
      pendingHumanSessionEvent = {
        sessionId: control.sessionId,
        event: "failed",
        failure: {
          code: "browser_human_session_open_failed",
          message: "浏览器维护入口没有正常启动。",
        },
      };
      process.stderr.write(
        `浏览器人工会话没有就绪：session=${control.sessionId} ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return;
  }

  if (browserLifecycle === undefined) return;
  try {
    if (control.browserReservationId !== undefined)
      await browserLifecycle.confirmNotStarted(control.browserReservationId);
    await browserLifecycle.closeHumanSession(control.sessionId);
    if (activeHumanSessionId === control.sessionId)
      activeHumanSessionId = undefined;
    pendingHumanSessionEvent = {
      sessionId: control.sessionId,
      event: "closed",
    };
  } catch (error) {
    process.stderr.write(
      `浏览器人工会话仍未确认关闭：session=${control.sessionId} ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function closeBrowserRuntime(): Promise<void> {
  if (browserLifecycle === undefined) return;
  try {
    await browserLifecycle.close();
  } catch (error) {
    process.stderr.write(
      `浏览器运行环境仍有资源未确认退出：${error instanceof Error ? error.message : String(error)}\n`,
    );
    throw error;
  }
  if (pendingHumanSessionEvent !== undefined) await sendHeartbeatNow(true);
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
        clearBrowserIdleTimer();
        browserIdleSince = undefined;
        activeRunId = result.run.runId;
        const current = executeRun(result.run);
        runInFlight = current;
        void current.then(
          () => {
            if (runInFlight === current) runInFlight = undefined;
            if (activeRunId === result.run?.runId) activeRunId = null;
            if (stopping === undefined) {
              startHeartbeat();
              refreshBrowserIdle();
            }
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
    if (!browserIdleProbeInFlight) refreshBrowserIdle();
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
    clearBrowserIdleTimer();
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    if (heartbeatInFlight !== undefined) await heartbeatInFlight;
    while (claimInFlight) await delay(25);
    if (activeWorker !== undefined) await stopActionWorker(activeWorker);
    if (runInFlight !== undefined) await runInFlight;
    if (browserIdleCloseInFlight !== undefined) await browserIdleCloseInFlight;
    await closeBrowserRuntime();
    await disconnect();
    await closeServer();
  })();
  return stopping;
}

server.listen(runtimePort, "0.0.0.0", () => {
  process.stdout.write(
    `运行器已启动：bin=${binId} sourceAdapter=${sourceAdapter.id} port=${runtimePort}\n`,
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
