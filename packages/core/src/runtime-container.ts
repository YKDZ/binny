import {
  type RuntimeEnvironment,
  type RuntimeExecution,
  type SourceAdapterManifest,
  sourceAdapterManifestStoredSchema,
} from "@binny/contracts";
import {
  binConfigurations,
  humanSessions,
  manualRuns,
  runtimeConnections,
  runtimeContainers,
  type Database,
  type Transaction,
} from "@binny/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

export type ManagedContainerStatus =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead";

export type ManagedContainerHealthStatus =
  | "none"
  | "starting"
  | "healthy"
  | "unhealthy";

export type ManagedContainerInspectResult = {
  readonly containerId: string;
  readonly composeProject: string;
  readonly composeService: string;
  readonly binId: string;
  readonly status: ManagedContainerStatus;
  readonly exitCode: number;
  readonly oomKilled: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly healthStatus: ManagedContainerHealthStatus;
};

/** Platform-agnostic container driver boundary implemented by Docker Engine in `@binny/server`. */
export interface RuntimeContainerDriver {
  discoverManagedContainers(): Promise<
    readonly ManagedContainerInspectResult[]
  >;
  inspectContainer(
    containerId: string,
  ): Promise<ManagedContainerInspectResult | null>;
  startContainer(
    containerId: string,
  ): Promise<"started" | "already_running" | "not_found">;
  stopContainer(
    containerId: string,
    graceSeconds?: number,
  ): Promise<"stopped" | "already_stopped" | "not_found">;
}

export type RuntimeWakeResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: "wake_failed" | "runtime_offline";
      readonly message: string;
    };

export type RuntimeContainerCoordinator = {
  reconcileOnStartup(): Promise<void>;
  onRuntimeHeartbeat(input: {
    readonly binId: string;
    readonly runtimeId: string;
    readonly ownerState: "confirmed" | "unconfirmed";
    readonly executionStatus: RuntimeExecution["status"];
    readonly environment: RuntimeEnvironment;
    readonly idleTimeoutSeconds: number | null;
  }): Promise<void>;
  onRuntimeDisconnected(binId: string, runtimeId: string): Promise<void>;
  ensureAwakeAndRun<T>(
    binId: string,
    work: () => Promise<T>,
  ): Promise<RuntimeWakeResult<T>>;
  requestWake(binId: string): void;
  onIdlePolicyUpdated(
    binId: string,
    idleTimeoutSeconds: number | null,
  ): Promise<void>;
  markWorkCompleted(binId: string): Promise<void>;
  onBinRemoved(binId: string): void;
  sweepIdleContainers(): Promise<void>;
  close(): Promise<void>;
};

export type RuntimeContainerCoordinatorOptions = {
  readonly database: Database;
  readonly driver?: RuntimeContainerDriver | undefined;
  readonly now?: (() => number) | undefined;
  readonly wakeTimeoutMs?: number | undefined;
  readonly stopGraceSeconds?: number | undefined;
  readonly wakeRetryBaseDelayMs?: number | undefined;
  readonly wakeRetryMaxDelayMs?: number | undefined;
};

const defaultWakeTimeoutMs = 30_000;
const defaultStopGraceSeconds = 30;
const defaultWakeRetryBaseDelayMs = 2_000;
const defaultWakeRetryMaxDelayMs = 60_000;
const healthStartingRetryDelayMs = 1_000;
const wakePollIntervalMs = 100;

type InternalWakeResult =
  | { readonly ok: true; readonly value: void }
  | {
      readonly ok: false;
      readonly code: "wake_failed" | "runtime_offline";
      readonly message: string;
      readonly retryable: boolean;
    };

type WakeErrorPayload = {
  readonly code: string;
  readonly message: string;
  readonly at: string;
};

function readEffectiveIdleTimeoutSeconds(bin: {
  readonly runtimeSleepIdleTimeoutSeconds?: number | null | undefined;
  readonly browserIdleTimeoutSeconds: number | null;
  readonly sourceAdapter?: unknown;
}): number | null {
  const configured =
    bin.runtimeSleepIdleTimeoutSeconds !== undefined
      ? bin.runtimeSleepIdleTimeoutSeconds
      : bin.browserIdleTimeoutSeconds;
  if (configured === null) return null;
  if (bin.sourceAdapter !== undefined) {
    const parsed = sourceAdapterManifestStoredSchema.safeParse(
      bin.sourceAdapter,
    );
    if (parsed.success && !canAdapterAutoSleep(parsed.data)) {
      return null;
    }
  }
  return configured;
}

function canAdapterAutoSleep(sourceAdapter: SourceAdapterManifest): boolean {
  return (
    !sourceAdapter.environment.browser.required ||
    sourceAdapter.environment.browser.profileReuseAfterRestart
  );
}

async function hasBlockingDatabaseWork(
  executor: Database | Transaction,
  binId: string,
): Promise<boolean> {
  const activeRuns = await executor
    .select({ runId: manualRuns.runId })
    .from(manualRuns)
    .where(
      and(
        eq(manualRuns.binId, binId),
        inArray(manualRuns.status, ["queued", "executing", "cancelling"]),
      ),
    )
    .limit(1);
  if (activeRuns.length > 0) return true;

  const unconfirmedInterrupted = await executor
    .select({ runId: manualRuns.runId })
    .from(manualRuns)
    .where(
      and(
        eq(manualRuns.binId, binId),
        eq(manualRuns.status, "failed"),
        isNull(manualRuns.stopConfirmedAt),
        sql`${manualRuns.failure}->>'code' = ${"runtime_interrupted"}`,
      ),
    )
    .limit(1);
  if (unconfirmedInterrupted.length > 0) return true;

  const activeSessions = await executor
    .select({ sessionId: humanSessions.sessionId })
    .from(humanSessions)
    .where(
      and(
        eq(humanSessions.binId, binId),
        inArray(humanSessions.status, [
          "pending",
          "opening",
          "ready",
          "closing",
        ]),
      ),
    )
    .limit(1);
  return activeSessions.length > 0;
}

async function hasWakeablePendingWork(
  executor: Database | Transaction,
  binId: string,
): Promise<boolean> {
  const queuedRuns = await executor
    .select({ runId: manualRuns.runId })
    .from(manualRuns)
    .where(and(eq(manualRuns.binId, binId), eq(manualRuns.status, "queued")))
    .limit(1);
  if (queuedRuns.length > 0) return true;

  const pendingSessions = await executor
    .select({ sessionId: humanSessions.sessionId })
    .from(humanSessions)
    .where(
      and(eq(humanSessions.binId, binId), eq(humanSessions.status, "pending")),
    )
    .limit(1);
  return pendingSessions.length > 0;
}

export function createRuntimeContainerCoordinator(
  options: RuntimeContainerCoordinatorOptions,
): RuntimeContainerCoordinator {
  const { database, driver } = options;
  const now = options.now ?? (() => Date.now());
  const wakeTimeoutMs = options.wakeTimeoutMs ?? defaultWakeTimeoutMs;
  const stopGraceSeconds = options.stopGraceSeconds ?? defaultStopGraceSeconds;
  const wakeRetryBaseDelayMs =
    options.wakeRetryBaseDelayMs ?? defaultWakeRetryBaseDelayMs;
  const wakeRetryMaxDelayMs = Math.max(
    wakeRetryBaseDelayMs,
    options.wakeRetryMaxDelayMs ?? defaultWakeRetryMaxDelayMs,
  );

  const activeLeases = new Map<string, number>();
  const idleTimers = new Map<string, NodeJS.Timeout>();
  const wakeRetryTimers = new Map<string, NodeJS.Timeout>();
  const wakeRetryAttempts = new Map<string, number>();
  const inFlightStops = new Map<string, Promise<void>>();
  const inFlightWakes = new Map<string, Promise<InternalWakeResult>>();
  const heartbeatWaiters = new Map<string, Set<() => void>>();
  const knownRuntimeIdByBin = new Map<string, string>();
  const trackedOperations = new Set<Promise<unknown>>();
  let closing = false;

  function track<T>(promise: Promise<T>): Promise<T> {
    trackedOperations.add(promise);
    void promise.finally(() => {
      trackedOperations.delete(promise);
    });
    return promise;
  }

  function clearIdleTimer(binId: string): void {
    const existing = idleTimers.get(binId);
    if (existing !== undefined) {
      clearTimeout(existing);
      idleTimers.delete(binId);
    }
  }

  function clearWakeRetryTimer(binId: string): void {
    const existing = wakeRetryTimers.get(binId);
    if (existing !== undefined) {
      clearTimeout(existing);
      wakeRetryTimers.delete(binId);
    }
  }

  function resetWakeRetryState(binId: string): void {
    clearWakeRetryTimer(binId);
    wakeRetryAttempts.delete(binId);
  }

  function wakeErrorPayload(code: string, message: string): WakeErrorPayload {
    return {
      code,
      message,
      at: new Date(now()).toISOString(),
    };
  }

  async function recordTransientWakeFailure(
    binId: string,
    lifecyclePhase: "sleeping" | "waking" | "running",
    errorPayload: WakeErrorPayload,
  ): Promise<void> {
    await database
      .update(runtimeContainers)
      .set({
        lifecyclePhase,
        idleSince: null,
        lastWakeError: errorPayload,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(runtimeContainers.binId, binId));
  }

  function scheduleWakeRetry(binId: string): void {
    if (closing || driver === undefined || wakeRetryTimers.has(binId)) return;
    const attempt = wakeRetryAttempts.get(binId) ?? 0;
    wakeRetryAttempts.set(binId, attempt + 1);
    const delayMs = Math.min(
      wakeRetryMaxDelayMs,
      Math.max(0, wakeRetryBaseDelayMs * 2 ** Math.min(attempt, 20)),
    );
    const timer = setTimeout(() => {
      if (wakeRetryTimers.get(binId) === timer) wakeRetryTimers.delete(binId);
      if (closing) return;
      void track(runBackgroundWakeAttempt(binId)).catch((error: unknown) => {
        process.stderr.write(
          `Background container wake retry failed for bin=${binId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }, delayMs);
    timer.unref();
    wakeRetryTimers.set(binId, timer);
  }

  async function runBackgroundWakeAttempt(binId: string): Promise<void> {
    if (closing || driver === undefined) return;
    if (!(await hasWakeablePendingWork(database, binId))) {
      resetWakeRetryState(binId);
      return;
    }
    const result = await ensureContainerReady(binId);
    if (result.ok) {
      resetWakeRetryState(binId);
      return;
    }
    if (closing || !result.retryable) {
      if (!result.retryable) resetWakeRetryState(binId);
      return;
    }
    if (await hasWakeablePendingWork(database, binId)) {
      scheduleWakeRetry(binId);
    } else {
      resetWakeRetryState(binId);
    }
  }

  function scheduleIdleStop(binId: string, delayMs: number): void {
    if (closing || driver === undefined) return;
    clearIdleTimer(binId);
    const timer = setTimeout(
      () => {
        if (idleTimers.get(binId) === timer) idleTimers.delete(binId);
        void track(stopIfIdle(binId)).catch((error: unknown) => {
          process.stderr.write(
            `Runtime container idle stop failed for bin=${binId}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      },
      Math.max(0, delayMs),
    );
    timer.unref();
    idleTimers.set(binId, timer);
  }

  function notifyHeartbeatWaiters(binId: string): void {
    const waiters = heartbeatWaiters.get(binId);
    if (waiters === undefined) return;
    for (const wake of waiters) wake();
  }

  function waitForHeartbeatSignal(
    binId: string,
    maxWaitMs: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      let waiters = heartbeatWaiters.get(binId);
      if (waiters === undefined) {
        waiters = new Set();
        heartbeatWaiters.set(binId, waiters);
      }
      const onDone = () => {
        clearTimeout(timer);
        waiters?.delete(onDone);
        if (waiters?.size === 0) heartbeatWaiters.delete(binId);
        resolve();
      };
      const timer = setTimeout(onDone, maxWaitMs);
      timer.unref();
      waiters.add(onDone);
    });
  }

  async function discoverManagedContainerForBin(
    binId: string,
  ): Promise<ManagedContainerInspectResult | undefined> {
    if (driver === undefined) return undefined;
    const discovered = await driver.discoverManagedContainers();
    const matches = discovered.filter((entry) => entry.binId === binId);
    if (matches.length !== 1) return undefined;
    return matches[0];
  }

  async function markContainerOffline(
    binId: string,
    lastWakeError: WakeErrorPayload | null = null,
  ): Promise<void> {
    clearIdleTimer(binId);
    resetWakeRetryState(binId);
    await database.transaction(async (transaction) => {
      await transaction
        .update(runtimeContainers)
        .set({
          lifecyclePhase: "offline",
          idleSince: null,
          ...(lastWakeError === null ? {} : { lastWakeError }),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(runtimeContainers.binId, binId));
      await transaction
        .update(runtimeConnections)
        .set({ disconnected: true })
        .where(eq(runtimeConnections.binId, binId));
    });
  }

  async function stopIfIdle(binId: string): Promise<void> {
    if (closing || driver === undefined) return;
    if (
      inFlightStops.has(binId) ||
      inFlightWakes.has(binId) ||
      (activeLeases.get(binId) ?? 0) > 0
    ) {
      return;
    }

    const [currentContainer] = await database
      .select()
      .from(runtimeContainers)
      .where(eq(runtimeContainers.binId, binId));
    if (
      currentContainer === undefined ||
      currentContainer.lifecyclePhase !== "running"
    ) {
      return;
    }

    const inspected = await driver.inspectContainer(
      currentContainer.containerId,
    );
    if (inspected === null || inspected.status !== "running") {
      await markContainerOffline(binId);
      return;
    }
    if (inspected.healthStatus === "starting") {
      scheduleIdleStop(binId, healthStartingRetryDelayMs);
      return;
    }

    const decision = await database.transaction<
      | { readonly action: "noop" }
      | { readonly action: "schedule"; readonly delayMs: number }
      | { readonly action: "stop"; readonly containerId: string }
    >(async (transaction) => {
      const [bin] = await transaction
        .select({
          id: binConfigurations.id,
          sourceAdapter: binConfigurations.sourceAdapter,
          browserIdleTimeoutSeconds:
            binConfigurations.browserIdleTimeoutSeconds,
          runtimeSleepIdleTimeoutSeconds:
            binConfigurations.runtimeSleepIdleTimeoutSeconds,
        })
        .from(binConfigurations)
        .where(eq(binConfigurations.id, binId))
        .for("update");
      if (bin === undefined) return { action: "noop" };

      const idleTimeoutSeconds = readEffectiveIdleTimeoutSeconds(bin);
      if (idleTimeoutSeconds === null) {
        await transaction
          .update(runtimeContainers)
          .set({ idleSince: null, updatedAt: sql`clock_timestamp()` })
          .where(eq(runtimeContainers.binId, binId));
        return { action: "noop" };
      }

      const [container] = await transaction
        .select()
        .from(runtimeContainers)
        .where(eq(runtimeContainers.binId, binId));
      if (
        container === undefined ||
        container.lifecyclePhase !== "running" ||
        container.containerId !== inspected.containerId
      ) {
        return { action: "noop" };
      }

      const [connection] = await transaction
        .select({
          disconnected: runtimeConnections.disconnected,
          ownerState: runtimeConnections.ownerState,
        })
        .from(runtimeConnections)
        .where(eq(runtimeConnections.binId, binId));
      if (
        connection === undefined ||
        connection.disconnected ||
        connection.ownerState !== "confirmed"
      ) {
        return { action: "noop" };
      }

      if (
        (activeLeases.get(binId) ?? 0) > 0 ||
        inFlightWakes.has(binId) ||
        (await hasBlockingDatabaseWork(transaction, binId))
      ) {
        await transaction
          .update(runtimeContainers)
          .set({ idleSince: null, updatedAt: sql`clock_timestamp()` })
          .where(eq(runtimeContainers.binId, binId));
        return { action: "noop" };
      }

      const currentMs = now();
      if (container.idleSince === null) {
        const nextIdleSince = new Date(currentMs);
        await transaction
          .update(runtimeContainers)
          .set({
            idleSince: nextIdleSince,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(runtimeContainers.binId, binId));
        if (idleTimeoutSeconds > 0) {
          return { action: "schedule", delayMs: idleTimeoutSeconds * 1_000 };
        }
      } else {
        const remainingMs =
          container.idleSince.getTime() +
          idleTimeoutSeconds * 1_000 -
          currentMs;
        if (remainingMs > 0) {
          return { action: "schedule", delayMs: remainingMs };
        }
      }

      await transaction
        .update(runtimeContainers)
        .set({
          lifecyclePhase: "stopping",
          containerStartedAt: inspected.startedAt,
          idleSince: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(runtimeContainers.binId, binId));
      return { action: "stop", containerId: container.containerId };
    });

    if (decision.action === "schedule") {
      scheduleIdleStop(binId, decision.delayMs);
      return;
    }
    if (decision.action === "noop") return;

    let stopTask!: Promise<void>;
    stopTask = (async () => {
      try {
        await driver.stopContainer(decision.containerId, stopGraceSeconds);
        const afterStop = await driver.inspectContainer(decision.containerId);
        const cleanSleep =
          afterStop !== null &&
          afterStop.status === "exited" &&
          afterStop.exitCode === 0 &&
          !afterStop.oomKilled;
        await database.transaction(async (transaction) => {
          const [latest] = await transaction
            .select({
              containerId: runtimeContainers.containerId,
              lifecyclePhase: runtimeContainers.lifecyclePhase,
            })
            .from(runtimeContainers)
            .where(eq(runtimeContainers.binId, binId))
            .for("update");
          if (
            latest === undefined ||
            latest.containerId !== decision.containerId ||
            latest.lifecyclePhase !== "stopping"
          ) {
            return;
          }
          await transaction
            .update(runtimeContainers)
            .set({
              lifecyclePhase: cleanSleep ? "sleeping" : "offline",
              stoppedContainerFinishedAt: cleanSleep
                ? afterStop.finishedAt
                : null,
              idleSince: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(runtimeContainers.binId, binId));
          await transaction
            .update(runtimeConnections)
            .set({ disconnected: true })
            .where(eq(runtimeConnections.binId, binId));
        });
      } finally {
        if (inFlightStops.get(binId) === stopTask) {
          inFlightStops.delete(binId);
        }
      }
    })();
    inFlightStops.set(binId, stopTask);
    await track(stopTask);
  }

  async function waitForContainerReady(
    binId: string,
    containerId: string,
    fallbackPhase: "waking" | "sleeping" | "running",
  ): Promise<InternalWakeResult> {
    if (driver === undefined) return { ok: true, value: undefined };
    const deadline = now() + wakeTimeoutMs;
    while (now() < deadline) {
      if (closing) {
        return {
          ok: false,
          code: "wake_failed",
          message:
            "Server is shutting down while waking the runtime container.",
          retryable: false,
        };
      }
      const [conn] = await database
        .select({
          disconnected: runtimeConnections.disconnected,
          ownerState: runtimeConnections.ownerState,
          runtimeControlUrl: runtimeConnections.runtimeControlUrl,
        })
        .from(runtimeConnections)
        .where(eq(runtimeConnections.binId, binId));
      const [container] = await database
        .select({
          lifecyclePhase: runtimeContainers.lifecyclePhase,
          containerId: runtimeContainers.containerId,
        })
        .from(runtimeContainers)
        .where(eq(runtimeContainers.binId, binId));
      if (
        conn !== undefined &&
        !conn.disconnected &&
        conn.ownerState === "confirmed" &&
        conn.runtimeControlUrl !== null &&
        container?.lifecyclePhase === "running"
      ) {
        return { ok: true, value: undefined };
      }

      let inspected: ManagedContainerInspectResult | null | undefined;
      try {
        inspected = await driver.inspectContainer(containerId);
      } catch {
        inspected = undefined;
      }
      if (
        inspected !== undefined &&
        (inspected === null ||
          inspected.status === "exited" ||
          inspected.status === "dead" ||
          inspected.status === "removing")
      ) {
        const reason =
          inspected === null
            ? "Runtime container was removed while waking."
            : `Runtime container exited prematurely while waking (exitCode=${inspected.exitCode}).`;
        await markContainerOffline(
          binId,
          wakeErrorPayload("runtime_wake_exited", reason),
        );
        return {
          ok: false,
          code: "wake_failed",
          message: reason,
          retryable: false,
        };
      }

      await waitForHeartbeatSignal(binId, wakePollIntervalMs);
    }

    const timeoutMessage =
      "Timed out waiting for the woken runtime container to reconnect and confirm ownership.";
    let finalInspect: ManagedContainerInspectResult | null | undefined;
    try {
      finalInspect = await driver.inspectContainer(containerId);
    } catch {
      finalInspect = undefined;
    }
    if (
      finalInspect !== undefined &&
      (finalInspect === null ||
        finalInspect.status === "exited" ||
        finalInspect.status === "dead" ||
        finalInspect.status === "removing")
    ) {
      const reason =
        finalInspect === null
          ? "Runtime container was removed while waking."
          : `Runtime container exited while waking (exitCode=${finalInspect.exitCode}).`;
      await markContainerOffline(
        binId,
        wakeErrorPayload("runtime_wake_exited", reason),
      );
      return {
        ok: false,
        code: "wake_failed",
        message: reason,
        retryable: false,
      };
    }

    await recordTransientWakeFailure(
      binId,
      finalInspect?.status === "running" ? "waking" : fallbackPhase,
      wakeErrorPayload("runtime_wake_timeout", timeoutMessage),
    );
    return {
      ok: false,
      code: "wake_failed",
      message: timeoutMessage,
      retryable: true,
    };
  }

  async function runEnsureReady(binId: string): Promise<InternalWakeResult> {
    if (driver === undefined) return { ok: true, value: undefined };

    const pendingStop = inFlightStops.get(binId);
    if (pendingStop !== undefined) {
      await pendingStop;
    }

    const [row] = await database
      .select()
      .from(runtimeContainers)
      .where(eq(runtimeContainers.binId, binId));

    if (row === undefined) {
      let discovered: ManagedContainerInspectResult | undefined;
      try {
        discovered = await discoverManagedContainerForBin(binId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Docker Engine failed while discovering runtime container.";
        return {
          ok: false,
          code: "wake_failed",
          message,
          retryable: true,
        };
      }
      if (discovered === undefined) {
        return { ok: true, value: undefined };
      }
      if (discovered.status !== "running") {
        return {
          ok: false,
          code: "runtime_offline",
          message:
            "Managed runtime container is stopped outside sleep policy and cannot auto-wake.",
          retryable: false,
        };
      }
      await database
        .insert(runtimeContainers)
        .values({
          binId,
          composeProject: discovered.composeProject,
          composeService: discovered.composeService,
          containerId: discovered.containerId,
          lifecyclePhase: "waking",
          containerStartedAt: discovered.startedAt,
          idleSince: null,
        })
        .onConflictDoUpdate({
          target: runtimeContainers.binId,
          set: {
            containerId: discovered.containerId,
            composeProject: discovered.composeProject,
            composeService: discovered.composeService,
            lifecyclePhase: "waking",
            containerStartedAt: discovered.startedAt,
            idleSince: null,
            updatedAt: sql`clock_timestamp()`,
          },
        });
      return await waitForContainerReady(
        binId,
        discovered.containerId,
        "waking",
      );
    }

    if (row.lifecyclePhase === "running") {
      const [conn] = await database
        .select({
          disconnected: runtimeConnections.disconnected,
          ownerState: runtimeConnections.ownerState,
          lastHeartbeatAt: runtimeConnections.lastHeartbeatAt,
        })
        .from(runtimeConnections)
        .where(eq(runtimeConnections.binId, binId));
      if (
        conn !== undefined &&
        !conn.disconnected &&
        conn.ownerState === "confirmed"
      ) {
        return { ok: true, value: undefined };
      }
      let inspected: ManagedContainerInspectResult | null;
      try {
        inspected = await driver.inspectContainer(row.containerId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Docker Engine failed to inspect runtime container.";
        await recordTransientWakeFailure(
          binId,
          "running",
          wakeErrorPayload("runtime_wake_driver_unavailable", message),
        );
        return {
          ok: false,
          code: "wake_failed",
          message,
          retryable: true,
        };
      }
      if (inspected?.status === "running") {
        await database
          .update(runtimeContainers)
          .set({
            lifecyclePhase: "waking",
            idleSince: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(runtimeContainers.binId, binId));
        return await waitForContainerReady(
          binId,
          inspected.containerId,
          "waking",
        );
      }
      let replacement: ManagedContainerInspectResult | undefined;
      try {
        replacement = await discoverManagedContainerForBin(binId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Docker Engine failed while discovering replacement container.";
        await recordTransientWakeFailure(
          binId,
          "running",
          wakeErrorPayload("runtime_wake_driver_unavailable", message),
        );
        return {
          ok: false,
          code: "wake_failed",
          message,
          retryable: true,
        };
      }
      if (replacement !== undefined && replacement.status === "running") {
        await database
          .update(runtimeContainers)
          .set({
            composeProject: replacement.composeProject,
            composeService: replacement.composeService,
            containerId: replacement.containerId,
            lifecyclePhase: "waking",
            containerStartedAt: replacement.startedAt,
            stoppedContainerFinishedAt: null,
            idleSince: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(runtimeContainers.binId, binId));
        return await waitForContainerReady(
          binId,
          replacement.containerId,
          "waking",
        );
      }
      await markContainerOffline(binId);
      return {
        ok: false,
        code: "runtime_offline",
        message: "Runtime container is offline and cannot auto-wake.",
        retryable: false,
      };
    }

    if (row.lifecyclePhase === "offline") {
      let inspected: ManagedContainerInspectResult | null = null;
      let replacement: ManagedContainerInspectResult | undefined;
      try {
        inspected = await driver.inspectContainer(row.containerId);
        if (inspected?.status !== "running") {
          replacement = await discoverManagedContainerForBin(binId);
        }
      } catch {
        return {
          ok: false,
          code: "runtime_offline",
          message:
            "Runtime container is offline (not policy-sleeping) and will not auto-start.",
          retryable: false,
        };
      }
      if (inspected?.status === "running") {
        return await waitForContainerReady(
          binId,
          inspected.containerId,
          "waking",
        );
      }
      if (replacement !== undefined && replacement.status === "running") {
        return await waitForContainerReady(
          binId,
          replacement.containerId,
          "waking",
        );
      }
      return {
        ok: false,
        code: "runtime_offline",
        message:
          "Runtime container is offline (not policy-sleeping) and will not auto-start.",
        retryable: false,
      };
    }

    if (row.lifecyclePhase === "waking") {
      let inspected: ManagedContainerInspectResult | null;
      try {
        inspected = await driver.inspectContainer(row.containerId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Docker Engine failed to inspect waking runtime container.";
        await recordTransientWakeFailure(
          binId,
          "waking",
          wakeErrorPayload("runtime_wake_driver_unavailable", message),
        );
        return {
          ok: false,
          code: "wake_failed",
          message,
          retryable: true,
        };
      }
      if (
        inspected !== null &&
        (inspected.status === "running" ||
          inspected.status === "created" ||
          inspected.status === "restarting")
      ) {
        return await waitForContainerReady(
          binId,
          inspected.containerId,
          "waking",
        );
      }
      const unstartedPolicySleep =
        inspected !== null &&
        inspected.status === "exited" &&
        inspected.exitCode === 0 &&
        !inspected.oomKilled &&
        row.containerStartedAt !== null &&
        inspected.startedAt === row.containerStartedAt &&
        (row.stoppedContainerFinishedAt === null ||
          inspected.finishedAt === row.stoppedContainerFinishedAt);
      if (!unstartedPolicySleep) {
        const reason = "Runtime container is no longer running while waking.";
        await markContainerOffline(
          binId,
          wakeErrorPayload("runtime_wake_exited", reason),
        );
        return {
          ok: false,
          code: "wake_failed",
          message: reason,
          retryable: false,
        };
      }
      // Fall through to sleeping wake if the container never started before interruption.
    }

    // lifecyclePhase === "sleeping" or leftover "stopping" (or pre-start "waking")
    let inspected: ManagedContainerInspectResult | null;
    try {
      inspected = await driver.inspectContainer(row.containerId);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Docker Engine failed to inspect sleeping runtime container.";
      await recordTransientWakeFailure(
        binId,
        "sleeping",
        wakeErrorPayload("runtime_wake_driver_unavailable", message),
      );
      return {
        ok: false,
        code: "wake_failed",
        message,
        retryable: true,
      };
    }
    if (inspected === null) {
      await markContainerOffline(
        binId,
        wakeErrorPayload(
          "runtime_container_missing",
          "Sleeping runtime container no longer exists.",
        ),
      );
      return {
        ok: false,
        code: "wake_failed",
        message: "Sleeping runtime container no longer exists.",
        retryable: false,
      };
    }

    if (inspected.status === "running") {
      await database
        .update(runtimeContainers)
        .set({
          lifecyclePhase: "waking",
          idleSince: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(runtimeContainers.binId, binId));
      return await waitForContainerReady(
        binId,
        inspected.containerId,
        "waking",
      );
    }

    if (
      inspected.status !== "exited" ||
      inspected.exitCode !== 0 ||
      inspected.oomKilled
    ) {
      await markContainerOffline(
        binId,
        wakeErrorPayload(
          "runtime_unexpected_exit",
          `Runtime container exited unexpectedly (status=${inspected.status}, exitCode=${inspected.exitCode}).`,
        ),
      );
      return {
        ok: false,
        code: "wake_failed",
        message: `Runtime container exited unexpectedly (exitCode=${inspected.exitCode}).`,
        retryable: false,
      };
    }

    await database.transaction(async (transaction) => {
      await transaction
        .update(runtimeContainers)
        .set({
          lifecyclePhase: "waking",
          idleSince: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(runtimeContainers.binId, binId));
      await transaction
        .update(runtimeConnections)
        .set({ disconnected: true })
        .where(eq(runtimeConnections.binId, binId));
    });

    try {
      const startResult = await driver.startContainer(row.containerId);
      if (startResult === "not_found") {
        await markContainerOffline(
          binId,
          wakeErrorPayload(
            "runtime_container_missing",
            "Sleeping runtime container was not found when starting.",
          ),
        );
        return {
          ok: false,
          code: "wake_failed",
          message: "Sleeping runtime container was not found when starting.",
          retryable: false,
        };
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Docker Engine failed to start sleeping runtime container.";
      // Revert to sleeping (not offline) so transient Docker Engine errors retry cleanly.
      await recordTransientWakeFailure(
        binId,
        "sleeping",
        wakeErrorPayload("runtime_wake_start_failed", message),
      );
      return { ok: false, code: "wake_failed", message, retryable: true };
    }

    return await waitForContainerReady(binId, row.containerId, "waking");
  }

  async function ensureContainerReady(
    binId: string,
  ): Promise<InternalWakeResult> {
    const existing = inFlightWakes.get(binId);
    if (existing !== undefined) return await existing;
    const task = runEnsureReady(binId).finally(() => {
      if (inFlightWakes.get(binId) === task) {
        inFlightWakes.delete(binId);
      }
    });
    inFlightWakes.set(binId, task);
    return await track(task);
  }

  async function refreshIdleScheduling(
    binId: string,
    idleTimeoutSeconds: number | null,
    resetIdleSince: boolean,
  ): Promise<void> {
    if (closing || driver === undefined) return;
    if ((activeLeases.get(binId) ?? 0) > 0) {
      clearIdleTimer(binId);
      return;
    }

    const outcome = await database.transaction<
      | { readonly action: "clear" }
      | { readonly action: "schedule"; readonly delayMs: number }
    >(async (transaction) => {
      const [container] = await transaction
        .select()
        .from(runtimeContainers)
        .where(eq(runtimeContainers.binId, binId))
        .for("update");
      if (container === undefined || container.lifecyclePhase !== "running") {
        return { action: "clear" };
      }

      if (idleTimeoutSeconds === null) {
        if (container.idleSince !== null) {
          await transaction
            .update(runtimeContainers)
            .set({ idleSince: null, updatedAt: sql`clock_timestamp()` })
            .where(eq(runtimeContainers.binId, binId));
        }
        return { action: "clear" };
      }

      if (await hasBlockingDatabaseWork(transaction, binId)) {
        if (container.idleSince !== null) {
          await transaction
            .update(runtimeContainers)
            .set({ idleSince: null, updatedAt: sql`clock_timestamp()` })
            .where(eq(runtimeContainers.binId, binId));
        }
        return { action: "clear" };
      }

      const currentMs = now();
      const idleSince =
        resetIdleSince || container.idleSince === null
          ? new Date(currentMs)
          : container.idleSince;
      if (resetIdleSince || container.idleSince === null) {
        await transaction
          .update(runtimeContainers)
          .set({ idleSince, updatedAt: sql`clock_timestamp()` })
          .where(eq(runtimeContainers.binId, binId));
      }
      const remainingMs =
        idleSince.getTime() + idleTimeoutSeconds * 1_000 - currentMs;
      return { action: "schedule", delayMs: Math.max(0, remainingMs) };
    });

    if (outcome.action === "clear") {
      clearIdleTimer(binId);
      return;
    }
    scheduleIdleStop(binId, outcome.delayMs);
  }

  return {
    async reconcileOnStartup() {
      if (driver === undefined || closing) return;
      const discovered = await driver.discoverManagedContainers();
      const discoveredByBin = new Map<string, ManagedContainerInspectResult>();
      const ambiguousBins = new Set<string>();
      for (const entry of discovered) {
        if (discoveredByBin.has(entry.binId)) {
          ambiguousBins.add(entry.binId);
        } else {
          discoveredByBin.set(entry.binId, entry);
        }
      }
      for (const ambiguous of ambiguousBins) {
        discoveredByBin.delete(ambiguous);
      }

      const persistedRows = await database.select().from(runtimeContainers);
      const persistedByBin = new Map(
        persistedRows.map((row) => [row.binId, row]),
      );

      for (const row of persistedRows) {
        const inspected = await driver.inspectContainer(row.containerId);
        if (inspected === null) {
          const replacement = discoveredByBin.get(row.binId);
          if (replacement !== undefined && replacement.status === "running") {
            await database
              .update(runtimeContainers)
              .set({
                composeProject: replacement.composeProject,
                composeService: replacement.composeService,
                containerId: replacement.containerId,
                lifecyclePhase: "waking",
                containerStartedAt: replacement.startedAt,
                stoppedContainerFinishedAt: null,
                idleSince: null,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(runtimeContainers.binId, row.binId));
          } else {
            await markContainerOffline(row.binId);
          }
          continue;
        }

        if (inspected.status === "running") {
          const [bin] = await database
            .select({
              sourceAdapter: binConfigurations.sourceAdapter,
              browserIdleTimeoutSeconds:
                binConfigurations.browserIdleTimeoutSeconds,
              runtimeSleepIdleTimeoutSeconds:
                binConfigurations.runtimeSleepIdleTimeoutSeconds,
            })
            .from(binConfigurations)
            .where(eq(binConfigurations.id, row.binId));
          const [conn] = await database
            .select({
              disconnected: runtimeConnections.disconnected,
              ownerState: runtimeConnections.ownerState,
            })
            .from(runtimeConnections)
            .where(eq(runtimeConnections.binId, row.binId));
          const connectionActive =
            conn !== undefined &&
            !conn.disconnected &&
            conn.ownerState === "confirmed";
          const idleTimeoutSeconds =
            bin === undefined ? null : readEffectiveIdleTimeoutSeconds(bin);
          await database
            .update(runtimeContainers)
            .set({
              lifecyclePhase: connectionActive ? "running" : "waking",
              containerStartedAt: inspected.startedAt,
              stoppedContainerFinishedAt: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(runtimeContainers.binId, row.binId));
          if (connectionActive && idleTimeoutSeconds !== null) {
            await refreshIdleScheduling(row.binId, idleTimeoutSeconds, false);
          }
          continue;
        }

        if (
          inspected.status === "paused" ||
          inspected.status === "restarting"
        ) {
          await database
            .update(runtimeContainers)
            .set({
              lifecyclePhase: "waking",
              containerStartedAt: inspected.startedAt,
              stoppedContainerFinishedAt: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(runtimeContainers.binId, row.binId));
          continue;
        }

        if (inspected.status === "exited") {
          const stoppedByPolicy =
            (row.lifecyclePhase === "sleeping" ||
              row.lifecyclePhase === "stopping" ||
              row.lifecyclePhase === "waking") &&
            inspected.exitCode === 0 &&
            !inspected.oomKilled &&
            (row.containerStartedAt === null ||
              inspected.startedAt === row.containerStartedAt) &&
            (row.lifecyclePhase === "stopping" ||
              row.stoppedContainerFinishedAt === null ||
              inspected.finishedAt === row.stoppedContainerFinishedAt);

          await database.transaction(async (transaction) => {
            await transaction
              .update(runtimeContainers)
              .set({
                lifecyclePhase: stoppedByPolicy ? "sleeping" : "offline",
                stoppedContainerFinishedAt: stoppedByPolicy
                  ? inspected.finishedAt
                  : null,
                idleSince: null,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(runtimeContainers.binId, row.binId));
            await transaction
              .update(runtimeConnections)
              .set({ disconnected: true })
              .where(eq(runtimeConnections.binId, row.binId));
          });
          continue;
        }

        await markContainerOffline(row.binId);
      }

      // Bind any pre-existing registered bins discovered on startup that don't yet have a runtime_containers row.
      for (const [binId, container] of discoveredByBin) {
        if (persistedByBin.has(binId)) continue;
        const [bin] = await database
          .select({
            id: binConfigurations.id,
            sourceAdapter: binConfigurations.sourceAdapter,
            browserIdleTimeoutSeconds:
              binConfigurations.browserIdleTimeoutSeconds,
            runtimeSleepIdleTimeoutSeconds:
              binConfigurations.runtimeSleepIdleTimeoutSeconds,
          })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId));
        if (bin === undefined) continue;

        const isRunning = container.status === "running";
        await database
          .insert(runtimeContainers)
          .values({
            binId,
            composeProject: container.composeProject,
            composeService: container.composeService,
            containerId: container.containerId,
            lifecyclePhase: isRunning ? "running" : "offline",
            containerStartedAt: container.startedAt,
            stoppedContainerFinishedAt: null,
            idleSince: null,
          })
          .onConflictDoNothing({ target: runtimeContainers.binId });

        if (isRunning) {
          const idleTimeoutSeconds = readEffectiveIdleTimeoutSeconds(bin);
          await refreshIdleScheduling(binId, idleTimeoutSeconds, false);
        }
      }

      // Resume wakeups for already-queued runs or pending human sessions on wakeable containers.
      const reconciledContainers = await database
        .select({
          binId: runtimeContainers.binId,
          lifecyclePhase: runtimeContainers.lifecyclePhase,
        })
        .from(runtimeContainers);
      for (const container of reconciledContainers) {
        if (
          container.lifecyclePhase === "sleeping" ||
          container.lifecyclePhase === "waking"
        ) {
          if (await hasWakeablePendingWork(database, container.binId)) {
            this.requestWake(container.binId);
          }
        }
      }
    },

    async onRuntimeHeartbeat(input) {
      if (closing || driver === undefined) return;
      resetWakeRetryState(input.binId);
      const [existing] = await database
        .select()
        .from(runtimeContainers)
        .where(eq(runtimeContainers.binId, input.binId));

      const sameActiveRuntime =
        existing !== undefined &&
        existing.lifecyclePhase === "running" &&
        knownRuntimeIdByBin.get(input.binId) === input.runtimeId;

      if (sameActiveRuntime) {
        notifyHeartbeatWaiters(input.binId);
        if (
          input.ownerState === "confirmed" &&
          existing.idleSince === null &&
          input.idleTimeoutSeconds !== null &&
          (activeLeases.get(input.binId) ?? 0) === 0
        ) {
          await refreshIdleScheduling(
            input.binId,
            input.idleTimeoutSeconds,
            false,
          );
        }
        return;
      }

      const discovered = await discoverManagedContainerForBin(input.binId);
      if (discovered === undefined || discovered.status !== "running") {
        notifyHeartbeatWaiters(input.binId);
        return;
      }

      if (
        existing !== undefined &&
        existing.lifecyclePhase === "stopping" &&
        existing.containerId === discovered.containerId
      ) {
        // Ignore late heartbeats from the container currently being stopped by policy.
        return;
      }

      const hasWork =
        (activeLeases.get(input.binId) ?? 0) > 0 ||
        (await hasBlockingDatabaseWork(database, input.binId));
      const keepExistingIdleSince =
        existing !== undefined &&
        existing.containerId === discovered.containerId &&
        existing.lifecyclePhase === "running"
          ? existing.idleSince
          : null;

      await database
        .insert(runtimeContainers)
        .values({
          binId: input.binId,
          composeProject: discovered.composeProject,
          composeService: discovered.composeService,
          containerId: discovered.containerId,
          lifecyclePhase: "running",
          containerStartedAt: discovered.startedAt,
          stoppedContainerFinishedAt: null,
          idleSince: hasWork
            ? null
            : (keepExistingIdleSince ?? new Date(now())),
          lastWakeError: null,
        })
        .onConflictDoUpdate({
          target: runtimeContainers.binId,
          set: {
            composeProject: discovered.composeProject,
            composeService: discovered.composeService,
            containerId: discovered.containerId,
            lifecyclePhase: "running",
            containerStartedAt: discovered.startedAt,
            stoppedContainerFinishedAt: null,
            lastWakeError: null,
            ...(hasWork
              ? { idleSince: null }
              : keepExistingIdleSince === null
                ? { idleSince: new Date(now()) }
                : {}),
            updatedAt: sql`clock_timestamp()`,
          },
        });

      knownRuntimeIdByBin.set(input.binId, input.runtimeId);
      notifyHeartbeatWaiters(input.binId);

      if (
        !hasWork &&
        input.ownerState === "confirmed" &&
        input.idleTimeoutSeconds !== null
      ) {
        await refreshIdleScheduling(
          input.binId,
          input.idleTimeoutSeconds,
          false,
        );
      }
    },

    async onRuntimeDisconnected(binId, _runtimeId) {
      if (driver === undefined) return;
      const [row] = await database
        .select({
          lifecyclePhase: runtimeContainers.lifecyclePhase,
        })
        .from(runtimeContainers)
        .where(eq(runtimeContainers.binId, binId));
      if (row === undefined) return;
      if (
        row.lifecyclePhase === "stopping" ||
        row.lifecyclePhase === "sleeping"
      ) {
        return;
      }
      clearIdleTimer(binId);
      await database
        .update(runtimeContainers)
        .set({
          lifecyclePhase: "offline",
          idleSince: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(runtimeContainers.binId, binId));
    },

    async ensureAwakeAndRun(binId, work) {
      activeLeases.set(binId, (activeLeases.get(binId) ?? 0) + 1);
      clearIdleTimer(binId);
      try {
        const ready = await ensureContainerReady(binId);
        if (!ready.ok) {
          if (
            ready.retryable &&
            (await hasWakeablePendingWork(database, binId))
          ) {
            scheduleWakeRetry(binId);
          }
          return { ok: false, code: ready.code, message: ready.message };
        }
        resetWakeRetryState(binId);
        return { ok: true, value: await work() };
      } finally {
        const remaining = (activeLeases.get(binId) ?? 1) - 1;
        if (remaining <= 0) {
          activeLeases.delete(binId);
          await this.markWorkCompleted(binId);
        } else {
          activeLeases.set(binId, remaining);
        }
      }
    },

    requestWake(binId) {
      if (closing || driver === undefined) return;
      if (wakeRetryTimers.has(binId) && !inFlightWakes.has(binId)) {
        // Respect active backoff timer instead of hammering Docker on repeated triggers.
        return;
      }
      void track(runBackgroundWakeAttempt(binId)).catch((error: unknown) => {
        process.stderr.write(
          `Background container wake failed for bin=${binId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    },

    async onIdlePolicyUpdated(binId, idleTimeoutSeconds) {
      if (closing || driver === undefined) return;
      await refreshIdleScheduling(binId, idleTimeoutSeconds, false);
    },

    async markWorkCompleted(binId) {
      if (closing || driver === undefined) return;
      if (!(await hasWakeablePendingWork(database, binId))) {
        resetWakeRetryState(binId);
      }
      const [bin] = await database
        .select({
          sourceAdapter: binConfigurations.sourceAdapter,
          browserIdleTimeoutSeconds:
            binConfigurations.browserIdleTimeoutSeconds,
          runtimeSleepIdleTimeoutSeconds:
            binConfigurations.runtimeSleepIdleTimeoutSeconds,
        })
        .from(binConfigurations)
        .where(eq(binConfigurations.id, binId));
      if (bin === undefined) return;
      const idleTimeoutSeconds = readEffectiveIdleTimeoutSeconds(bin);
      await refreshIdleScheduling(binId, idleTimeoutSeconds, true);
    },

    onBinRemoved(binId) {
      clearIdleTimer(binId);
      resetWakeRetryState(binId);
      knownRuntimeIdByBin.delete(binId);
    },

    async sweepIdleContainers() {
      if (closing || driver === undefined) return;
      const rows = await database.select().from(runtimeContainers);
      for (const row of rows) {
        if (row.lifecyclePhase !== "running") continue;
        if ((activeLeases.get(row.binId) ?? 0) > 0) continue;
        let inspected: ManagedContainerInspectResult | null;
        try {
          inspected = await driver.inspectContainer(row.containerId);
        } catch {
          continue;
        }
        if (inspected === null) {
          await markContainerOffline(row.binId);
          continue;
        }
        if (
          inspected.status === "paused" ||
          inspected.status === "restarting"
        ) {
          // A paused or restarting container is still alive; let heartbeat timeout govern liveness.
          continue;
        }
        if (inspected.status !== "running") {
          await markContainerOffline(row.binId);
          continue;
        }
        const [bin] = await database
          .select({
            sourceAdapter: binConfigurations.sourceAdapter,
            browserIdleTimeoutSeconds:
              binConfigurations.browserIdleTimeoutSeconds,
            runtimeSleepIdleTimeoutSeconds:
              binConfigurations.runtimeSleepIdleTimeoutSeconds,
          })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, row.binId));
        if (bin === undefined) continue;
        const idleTimeoutSeconds = readEffectiveIdleTimeoutSeconds(bin);
        if (idleTimeoutSeconds === null) continue;
        if (
          row.idleSince !== null &&
          now() - row.idleSince.getTime() >= idleTimeoutSeconds * 1_000
        ) {
          await stopIfIdle(row.binId);
        }
      }
    },

    async close() {
      closing = true;
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      for (const timer of wakeRetryTimers.values()) clearTimeout(timer);
      wakeRetryTimers.clear();
      wakeRetryAttempts.clear();
      for (const waiters of heartbeatWaiters.values()) {
        for (const wake of waiters) wake();
      }
      heartbeatWaiters.clear();
      await Promise.allSettled(trackedOperations);
    },
  };
}
