import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

import { createApiClient } from "@binny/api/client";
import {
  jsonObjectSchema,
  manualRunCompletionSchema,
  runtimeHeartbeatIntervalMs,
  runtimeEnvironmentKindSchema,
  runtimeControlUrlSchema,
  runtimeProtocolVersion,
  type ManualRunCompletion,
  type ManualRunExecution,
  type ManualRun,
  type BrowserPower,
  type RuntimeHumanSessionControl,
  type RuntimeHumanSessionEvent,
  type RuntimeSourceStateSnapshot,
  type RuntimeEnvironment,
} from "@binny/contracts";
import {
  parseSourceAdapterInput,
  sourceAccessConfigFromAdapterConfig,
  sourceAdapterManifest,
  type SourceAdapterBrowserConnection,
  type SourceAdapterDefinition,
  type SourceAccessAcquireInput,
  type SourceAccessCoordinator,
  type SourceAccessConfig,
  type SourceAccessResponse,
} from "@binny/source-adapter-sdk";

import {
  BrowserLifecycle,
  type BrowserPowerChangeResult,
  type BrowserPowerEvent,
} from "./browser-lifecycle.ts";
import { createRuntimeServer } from "./runtime-server.ts";
import { openPersistentSourceAccessCoordinator } from "./source-access.ts";
import {
  openPersistentSourceAdapterState,
  type PersistentSourceAdapterState,
} from "./sync-state.ts";

const sourceAdapterPath =
  process.env.BINNY_SOURCE_ADAPTER_ENTRY ?? "/app/dist/index.js";
const binId = process.env.BINNY_BIN_ID;
const apiUrl = process.env.BINNY_API_URL;
const runtimeControlUrl = runtimeControlUrlSchema.parse(
  process.env.BINNY_RUNTIME_CONTROL_URL,
);
const runtimePort = Number(process.env.BINNY_RUNTIME_PORT ?? "8080");
const environmentKind = runtimeEnvironmentKindSchema.parse(
  process.env.BINNY_RUNTIME_ENVIRONMENT ?? "lightweight",
);
const heartbeatInterval = Number(
  process.env.BINNY_RUNTIME_HEARTBEAT_INTERVAL_MS ??
    String(runtimeHeartbeatIntervalMs),
);
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
const runtimeApiUrl = apiUrl;

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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isSourceAccessUnavailableError(error: unknown): boolean {
  return (
    hasErrorCode(error, "source_access_state_unavailable") ||
    hasErrorCode(error, "source_access_persistent_store_failed")
  );
}

let sourceAccessCoordinator: SourceAccessCoordinator | undefined;
let sourceAccessUnavailable = false;
let persistentSourceAdapterState: PersistentSourceAdapterState | undefined;
let persistentSourceAdapterStateUnavailable = false;
let ownerGeneration: string | undefined = undefined;

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

async function claimOwnership(): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${runtimeApiUrl}/bins/${encodeURIComponent(runtimeBinId)}/runtime/ownership`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtimeId,
          runtimeControlUrl,
          sourceAdapter: manifest,
        }),
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (response.status === 409) {
      const data = await response.json().catch(() => ({}));
      process.stderr.write(`所有权冲突，退出：${JSON.stringify(data)}\n`);
      process.exit(1);
    }
    if (!response.ok) {
      process.stderr.write(
        `申领所有权失败（HTTP ${response.status}），稍后重试\n`,
      );
      return undefined;
    }
    const data = (await response.json()) as { ownerGeneration: string };
    return data.ownerGeneration;
  } catch (error) {
    process.stderr.write(
      `申领所有权网络错误，稍后重试：${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

async function ensureStateCoordinators(generation: string): Promise<void> {
  if (sourceAccessCoordinator === undefined && !sourceAccessUnavailable) {
    try {
      sourceAccessCoordinator = await openPersistentSourceAccessCoordinator({
        apiUrl: runtimeApiUrl,
        binId: runtimeBinId,
        runtimeId,
        ownerGeneration: generation,
      });
    } catch (error) {
      sourceAccessUnavailable = true;
      process.stderr.write(
        `来源准入持久状态不可用，相关来源访问已停止：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (
    persistentSourceAdapterState === undefined &&
    !persistentSourceAdapterStateUnavailable
  ) {
    try {
      persistentSourceAdapterState = await openPersistentSourceAdapterState(
        {
          apiUrl: runtimeApiUrl,
          binId: runtimeBinId,
          runtimeId,
          ownerGeneration: generation,
        },
        activeSourceAdapter.stateSchema,
      );
    } catch (error) {
      persistentSourceAdapterStateUnavailable = true;
      process.stderr.write(
        `信源适配器持久状态不可用，相关同步已停止：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

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
        ownerGeneration: () => ownerGeneration ?? "0",
        profileDirectory:
          process.env.BINNY_BROWSER_PROFILE_DIRECTORY ??
          "/var/lib/binny/browser-profile",
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
  if (ownerGeneration === undefined) return "unavailable";
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
        runtimeControlUrl,
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
  readonly ownerId: string;
  readonly accessRequests: Map<string, AbortController>;
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

function sourceAccessInput(
  value: unknown,
  run: ManualRunExecution,
): SourceAccessAcquireInput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const request = value as Record<string, unknown>;
  if (
    request.runId !== run.runId ||
    typeof request.groupId !== "string" ||
    (request.source !== "site" && request.source !== "media") ||
    typeof request.origin !== "string" ||
    typeof request.minimumIntervalMs !== "number" ||
    typeof request.maxConcurrency !== "number" ||
    !Number.isSafeInteger(request.minimumIntervalMs) ||
    !Number.isSafeInteger(request.maxConcurrency) ||
    (request.notBeforeEpochMs !== undefined &&
      (typeof request.notBeforeEpochMs !== "number" ||
        !Number.isSafeInteger(request.notBeforeEpochMs) ||
        request.notBeforeEpochMs < 0)) ||
    (request.deadlineEpochMs !== undefined &&
      (typeof request.deadlineEpochMs !== "number" ||
        !Number.isSafeInteger(request.deadlineEpochMs) ||
        request.deadlineEpochMs < 0))
  )
    return undefined;
  return {
    runId: request.runId,
    groupId: request.groupId,
    source: request.source,
    origin: request.origin,
    minimumIntervalMs: request.minimumIntervalMs,
    maxConcurrency: request.maxConcurrency,
    ...(request.notBeforeEpochMs === undefined
      ? {}
      : { notBeforeEpochMs: request.notBeforeEpochMs }),
    ...(request.deadlineEpochMs === undefined
      ? {}
      : { deadlineEpochMs: request.deadlineEpochMs }),
  };
}

function sourceAccessResponseInput(
  value: unknown,
): SourceAccessResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const response = value as Record<string, unknown>;
  if (
    typeof response.status !== "number" ||
    !Number.isSafeInteger(response.status) ||
    (response.retryAfter !== undefined &&
      typeof response.retryAfter !== "string")
  )
    return undefined;
  return {
    status: response.status,
    ...(typeof response.retryAfter === "string"
      ? { retryAfter: response.retryAfter }
      : {}),
  };
}

function runtimeSourceStateSnapshot(): RuntimeSourceStateSnapshot {
  const updatedAt = new Date().toISOString();
  let sync = persistentSourceAdapterStateUnavailable
    ? unavailableSourceAdapterStateSnapshot()
    : persistentSourceAdapterState?.snapshot();
  if (sync !== undefined && !persistentSourceAdapterStateUnavailable) {
    const checked = activeSourceAdapter.stateSnapshotSchema?.safeParse(sync);
    if (checked !== undefined && !checked.success) {
      persistentSourceAdapterStateUnavailable = true;
      process.stderr.write(
        "信源适配器状态快照不符合原生 schema，相关同步已停止。\n",
      );
      sync = unavailableSourceAdapterStateSnapshot();
    } else if (checked?.success) {
      const json = jsonObjectSchema.safeParse(checked.data);
      if (json.success) {
        sync = json.data;
      } else {
        persistentSourceAdapterStateUnavailable = true;
        process.stderr.write(
          "信源适配器状态快照不是 JSON 对象，相关同步已停止。\n",
        );
        sync = unavailableSourceAdapterStateSnapshot();
      }
    }
  }
  const access = sourceAccessCoordinator?.snapshot();
  if (
    sourceAccessUnavailable ||
    access === undefined ||
    access.status === "unavailable"
  ) {
    return {
      updatedAt,
      sourceAccess: {
        status: "unavailable",
        reason: "persistent_state_unavailable",
      },
      ...(sync === undefined ? {} : { sync }),
    };
  }
  const groupIds = [
    ...new Set([
      ...Object.keys(access.lastAdmittedAt),
      ...Object.keys(access.cooldownByGroup),
    ]),
  ];
  return {
    updatedAt,
    sourceAccess: {
      status: "available",
      groups: Object.fromEntries(
        groupIds.map((groupId) => {
          const cooldown = access.cooldownByGroup[groupId];
          const lastAdmittedAt = access.lastAdmittedAt[groupId];
          return [
            groupId,
            {
              ...(lastAdmittedAt === undefined
                ? {}
                : { lastAdmittedAt: new Date(lastAdmittedAt).toISOString() }),
              ...(cooldown === undefined
                ? {}
                : {
                    cooldownUntil: new Date(
                      cooldown.notBeforeEpochMs,
                    ).toISOString(),
                    latestLimitStatus: cooldown.status,
                  }),
            },
          ];
        }),
      ),
    },
    ...(sync === undefined ? {} : { sync }),
  };
}

function unavailableSourceAdapterStateSnapshot() {
  return {
    status: "unavailable" as const,
    reason: "persistent_state_unavailable" as const,
  };
}

function startActionWorker(
  run: ManualRunExecution,
  declarations: SourceAccessConfig | undefined,
): ActionWorker {
  const child = spawn(process.execPath, [workerEntry], {
    detached: true,
    env: {
      ...process.env,
      BINNY_RUNTIME_ID: runtimeId,
      ...(ownerGeneration === undefined
        ? {}
        : { BINNY_RUNTIME_OWNER_GENERATION: ownerGeneration }),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("无法启动隔离的信源适配器执行进程。");
  const ownerId = randomUUID();
  const accessRequests = new Map<string, AbortController>();
  let worker!: ActionWorker;

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
    if (
      message.type === "adapter-state-load" ||
      message.type === "adapter-state-save"
    ) {
      const record = message as Record<string, unknown>;
      if (typeof record.requestId !== "string") return;
      if (record.runId !== run.runId) {
        void sendWorkerMessage(worker, {
          type: "adapter-state-rejected",
          requestId: record.requestId,
          message: "信源适配器持久状态请求不属于当前运行。",
        });
        return;
      }
      if (
        persistentSourceAdapterStateUnavailable ||
        persistentSourceAdapterState === undefined
      ) {
        void sendWorkerMessage(worker, {
          type: "adapter-state-rejected",
          requestId: record.requestId,
          code: "source_adapter_state_unavailable",
          message: "信源适配器持久状态不可用，相关同步已停止。",
        });
        return;
      }
      if (message.type === "adapter-state-load") {
        void persistentSourceAdapterState
          .load()
          .then(async (state) => {
            await sendWorkerMessage(worker, {
              type: "adapter-state-loaded",
              requestId: record.requestId,
              ...(state === undefined ? {} : { state }),
            });
          })
          .catch(async (error: unknown) => {
            persistentSourceAdapterStateUnavailable = true;
            await sendHeartbeatNow(false, false);
            const isOwnerMismatch =
              hasErrorCode(error, "runtime_owner_mismatch") ||
              (error instanceof Error &&
                error.message === "runtime_owner_mismatch");
            await sendWorkerMessage(worker, {
              type: "adapter-state-rejected",
              requestId: record.requestId,
              code: isOwnerMismatch
                ? "runtime_owner_mismatch"
                : "source_adapter_state_unavailable",
              message:
                error instanceof Error
                  ? error.message
                  : "信源适配器持久状态不可用，相关同步已停止。",
            }).catch((sendError: unknown) => {
              process.stderr.write(
                `无法拒绝信源适配器状态请求：${sendError instanceof Error ? sendError.message : String(sendError)}\n`,
              );
            });
          });
        return;
      }
      if (!Object.hasOwn(record, "state")) {
        void sendWorkerMessage(worker, {
          type: "adapter-state-rejected",
          requestId: record.requestId,
          message: "信源适配器持久状态写入内容缺失。",
        });
        return;
      }
      void persistentSourceAdapterState
        .replace(record.state)
        .then(async () => {
          await sendHeartbeatNow(false, false);
          await sendWorkerMessage(worker, {
            type: "adapter-state-saved",
            requestId: record.requestId,
          });
        })
        .catch(async (error: unknown) => {
          persistentSourceAdapterStateUnavailable = true;
          await sendHeartbeatNow(false, false);
          const isOwnerMismatch =
            hasErrorCode(error, "runtime_owner_mismatch") ||
            (error instanceof Error &&
              error.message === "runtime_owner_mismatch");
          await sendWorkerMessage(worker, {
            type: "adapter-state-rejected",
            requestId: record.requestId,
            code: isOwnerMismatch
              ? "runtime_owner_mismatch"
              : "source_adapter_state_unavailable",
            message:
              error instanceof Error
                ? error.message
                : "信源适配器持久状态无法保存。",
          }).catch(() => undefined);
        });
      return;
    }
    if (message.type === "source-access-acquire") {
      const record = message as Record<string, unknown>;
      const coordinator = sourceAccessCoordinator;
      if (
        declarations === undefined ||
        persistentSourceAdapterStateUnavailable ||
        sourceAccessUnavailable ||
        coordinator === undefined ||
        typeof record.requestId !== "string" ||
        accessRequests.has(record.requestId)
      ) {
        void sendWorkerMessage(worker, {
          type: "source-access-rejected",
          requestId: record.requestId,
          ...(persistentSourceAdapterStateUnavailable ||
          sourceAccessUnavailable ||
          coordinator === undefined
            ? { code: "source_access_state_unavailable" }
            : {}),
          message: persistentSourceAdapterStateUnavailable
            ? "信源适配器持久状态不可用，相关来源访问已停止。"
            : sourceAccessUnavailable || coordinator === undefined
              ? "来源访问状态不可用，相关来源访问已停止。"
              : "本次运行没有可用的来源准入声明。",
        });
        return;
      }
      const request = sourceAccessInput(record.input, run);
      if (request === undefined) {
        void sendWorkerMessage(worker, {
          type: "source-access-rejected",
          requestId: record.requestId,
          message: "来源准入请求格式无效。",
        });
        return;
      }
      const pending = new AbortController();
      accessRequests.set(record.requestId, pending);
      void coordinator
        .acquire(ownerId, request, declarations, pending.signal)
        .then(async (lease) => {
          if (
            pending.signal.aborted ||
            accessRequests.get(record.requestId as string) !== pending
          ) {
            await coordinator.release(ownerId, lease.leaseId);
            return;
          }
          accessRequests.delete(record.requestId as string);
          try {
            await sendWorkerMessage(worker, {
              type: "source-access-granted",
              requestId: record.requestId,
              ...lease,
            });
          } catch (error) {
            await coordinator.release(ownerId, lease.leaseId);
            throw error;
          }
        })
        .catch(async (error: unknown) => {
          if (isSourceAccessUnavailableError(error)) {
            sourceAccessUnavailable = true;
            await sendHeartbeatNow(false, false).catch(() => undefined);
          }
          accessRequests.delete(record.requestId as string);
          if (!worker.child.connected) return;
          const errorCode =
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined;
          await sendWorkerMessage(worker, {
            type: "source-access-rejected",
            requestId: record.requestId,
            ...(isSourceAccessUnavailableError(error)
              ? { code: "source_access_state_unavailable" }
              : errorCode === "source_access_deadline_exceeded"
                ? { code: "source_access_deadline_exceeded" }
                : errorCode === "runtime_owner_mismatch"
                  ? { code: "runtime_owner_mismatch" }
                  : {}),
            message:
              error instanceof Error ? error.message : "来源准入请求失败。",
          }).catch(() => undefined);
        });
      return;
    }
    if (message.type === "source-access-response") {
      const record = message as Record<string, unknown>;
      if (
        declarations === undefined ||
        sourceAccessUnavailable ||
        sourceAccessCoordinator === undefined ||
        typeof record.requestId !== "string"
      ) {
        void sendWorkerMessage(worker, {
          type: "source-access-rejected",
          requestId: record.requestId,
          code: "source_access_state_unavailable",
          message: "来源访问状态不可用，冷却依据未能保存。",
        });
        return;
      }
      const request = sourceAccessInput(record.input, run);
      const response = sourceAccessResponseInput(record.response);
      if (request === undefined || response === undefined) {
        void sendWorkerMessage(worker, {
          type: "source-access-rejected",
          requestId: record.requestId,
          message: "来源响应冷却依据格式无效。",
        });
        return;
      }
      void sourceAccessCoordinator
        .observeResponse(ownerId, request, declarations, response)
        .then(async (observation) => {
          await sendHeartbeatNow(false, false).catch(() => undefined);
          return sendWorkerMessage(worker, {
            type: "source-access-response-recorded",
            requestId: record.requestId,
            observation,
          });
        })
        .catch((error: unknown) => {
          if (isSourceAccessUnavailableError(error)) {
            sourceAccessUnavailable = true;
            void sendHeartbeatNow(false, false).catch(() => undefined);
          }
          return sendWorkerMessage(worker, {
            type: "source-access-rejected",
            requestId: record.requestId,
            ...(isSourceAccessUnavailableError(error)
              ? { code: "source_access_state_unavailable" }
              : {}),
            message:
              error instanceof Error
                ? error.message
                : "来源冷却状态无法持久保存。",
          }).catch(() => undefined);
        });
      return;
    }
    if (message.type === "source-access-cancel") {
      const record = message as Record<string, unknown>;
      if (typeof record.requestId !== "string") return;
      const pending = accessRequests.get(record.requestId);
      if (pending !== undefined) {
        accessRequests.delete(record.requestId);
        pending.abort();
      }
      return;
    }
    if (message.type === "source-access-release") {
      const record = message as Record<string, unknown>;
      if (
        typeof record.requestId !== "string" ||
        typeof record.leaseId !== "string"
      )
        return;
      if (sourceAccessCoordinator === undefined) {
        void sendWorkerMessage(worker, {
          type: "source-access-rejected",
          requestId: record.requestId,
          message: "来源访问状态不可用，许可无法释放。",
        });
        return;
      }
      void sourceAccessCoordinator
        .release(ownerId, record.leaseId)
        .then(() =>
          sendWorkerMessage(worker, {
            type: "source-access-released",
            requestId: record.requestId,
          }),
        )
        .catch((error: unknown) =>
          (async () => {
            if (isSourceAccessUnavailableError(error)) {
              sourceAccessUnavailable = true;
              await sendHeartbeatNow(false, false).catch(() => undefined);
            }
            await sendWorkerMessage(worker, {
              type: "source-access-rejected",
              requestId: record.requestId,
              ...(isSourceAccessUnavailableError(error)
                ? { code: "source_access_state_unavailable" }
                : {}),
              message:
                error instanceof Error ? error.message : "许可释放失败。",
            }).catch(() => undefined);
          })(),
        );
      return;
    }
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
  worker = { child, pid, ownerId, accessRequests, ready, outcome, closed };
  return worker;
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

  if (
    activeSourceAdapter.stateSchema !== undefined &&
    persistentSourceAdapterStateUnavailable
  ) {
    await confirmNotStarted();
    await finishRun(run, {
      status: "failed",
      completedScopes: [],
      error: {
        code: "source_adapter_state_unavailable",
        message: "信源适配器持久状态不可用，相关动作没有启动。",
        impact: "本次运行没有发起来源请求；运行器没有重置或推进接续位置。",
        suggestion: "检查信源适配器状态并恢复有效备份后重新触发。",
        requiresHuman: true,
      },
    });
    await acknowledgeStoppedRun(run.runId);
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
    if (worker !== undefined) {
      for (const pending of worker.accessRequests.values()) pending.abort();
      worker.accessRequests.clear();
      try {
        await sourceAccessCoordinator?.closeOwner(worker.ownerId);
      } catch (error) {
        if (isSourceAccessUnavailableError(error)) {
          sourceAccessUnavailable = true;
          await sendHeartbeatNow(false, false).catch(() => undefined);
        }
        process.stderr.write(
          `关闭来源访问 owner 时持久确认失败：${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
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
    const configured = await parseSourceAdapterInput(
      activeSourceAdapter.configSchema,
      run.config,
    );
    const accessDeclarations = configured.success
      ? sourceAccessConfigFromAdapterConfig(configured.data)
      : undefined;
    worker = startActionWorker(run, accessDeclarations);
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
      runtimeId,
      ownerGeneration: ownerGeneration!,
      run: {
        runId: run.runId,
        binId: run.binId,
        identityId: run.identityId,
        sourceAdapterId: run.sourceAdapterId,
        sourceAdapterVersion: run.sourceAdapterVersion,
        action: run.action,
        params: run.params,
        config: run.config,
        referenceTime: run.referenceTime,
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
  if (ownerGeneration === undefined) {
    const generation = await claimOwnership();
    if (generation === undefined) {
      if (stopping === undefined) {
        heartbeatTimer = setTimeout(() => {
          heartbeatTimer = undefined;
          startHeartbeat();
        }, heartbeatInterval);
      }
      return;
    }
    ownerGeneration = generation;
  }
  await ensureStateCoordinators(ownerGeneration);

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
        runtimeControlUrl,
        ...(stoppedRunId === undefined ? {} : { stoppedRunId }),
        ...(humanSessionEvent === undefined ? {} : { humanSessionEvent }),
        sourceAdapter: manifest,
        sourceStateSnapshot: runtimeSourceStateSnapshot(),
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
