import { randomUUID } from "node:crypto";

import * as z from "zod";

const sourceAccessGroupIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const sourceAccessGroupSchema = z
  .object({
    sources: z
      .array(z.enum(["site", "media"]))
      .min(1)
      .max(2)
      .describe("加入同一来源组节流的站点或媒体主动访问类别。"),
    minimumIntervalMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .describe("同组相邻主动请求准入的最小间隔，范围为 0 至 60000 毫秒。"),
    maxConcurrency: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe("同组同时持有的主动请求许可上限，范围为 1 至 8。"),
  })
  .strict()
  .describe(
    "同一來源组内主动访问共享最小间隔与并发上限。站点包含 JSON、显式导航和恢复重读；媒体包含站内及外部媒体下载。",
  );

export const sourceAccessConfigSchema = z
  .object({
    groups: z
      .record(sourceAccessGroupIdSchema, sourceAccessGroupSchema)
      .describe("以适配器稳定来源组标识为键的主动访问来源声明。"),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [groupId, group] of Object.entries(config.groups)) {
      if (new Set(group.sources).size !== group.sources.length) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupId, "sources"],
          message: "来源组内的来源类别不能重复。",
        });
      }
    }
  })
  .describe("信源适配器声明的共享来源访问准入组及有限调度策略。");

export const sourceAccessPersistentStateSchema = z
  .object({
    version: z.literal(1),
    lastAdmittedAt: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export type SourceAccessGroup = z.output<typeof sourceAccessGroupSchema>;
export type SourceAccessConfig = z.output<typeof sourceAccessConfigSchema>;
export type SourceAccessKind = SourceAccessGroup["sources"][number];
export type SourceAccessPersistentState = z.output<
  typeof sourceAccessPersistentStateSchema
>;

export type SourceAccessPersistentStore = {
  /** 不存在时返回 undefined；损坏状态由 SDK 拒绝载入。 */
  load(): Promise<unknown>;
  /** 仅在完成持久写入后返回，SDK 随后才发放许可。 */
  save(state: SourceAccessPersistentState): Promise<void>;
};

/** SDK 调度器所需的时钟接口；可注入完整可控时钟验证等待策略。 */
export type SourceAccessClock = {
  epochNow(): number;
  monotonicNow(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
};

export type SourceAccessAcquireInput = {
  readonly runId: string;
  readonly groupId: string;
  readonly source: SourceAccessKind;
  readonly origin: string;
  readonly minimumIntervalMs: number;
  readonly maxConcurrency: number;
  /** 后续冷却或重试策略可提供的最早准入时刻；与最小间隔一次取最大值。 */
  readonly notBeforeEpochMs?: number;
};

export type SourceAccessLease = {
  readonly leaseId: string;
  readonly waitedMs: number;
};

export type SourceAccessTransport = {
  acquire(
    input: SourceAccessAcquireInput,
    signal: AbortSignal,
  ): Promise<SourceAccessLease>;
  release(leaseId: string): Promise<void>;
};

export type SourceAccessRequest = {
  readonly groupId: string;
  readonly source: SourceAccessKind;
  readonly origin: string;
  /** 后续冷却或重试策略可提供的最早准入时刻；不触发第二层等待。 */
  readonly notBeforeEpochMs?: number;
};

export type SourceAccessSnapshot = {
  readonly admittedAttempts: number;
  readonly waitedMs: number;
  readonly bySource: Readonly<Record<SourceAccessKind, number>>;
};

export type SourceAccessCoordinator = {
  acquire(
    ownerId: string,
    request: SourceAccessAcquireInput,
    declarations: SourceAccessConfig,
    signal: AbortSignal,
  ): Promise<SourceAccessLease>;
  release(ownerId: string, leaseId: string): Promise<void>;
  closeOwner(ownerId: string): void;
};

type CoordinatorWaiter = {
  readonly ownerId: string;
  readonly request: SourceAccessAcquireInput;
  readonly group: SourceAccessGroup;
  readonly signal: AbortSignal;
  readonly queuedAt: number;
  readonly resolve: (lease: SourceAccessLease) => void;
  readonly reject: (error: unknown) => void;
  abort?: () => void;
};

type CoordinatorGroupState = {
  readonly queue: CoordinatorWaiter[];
  readonly leases: Set<string>;
  lastAdmittedAt: number;
  timer: unknown;
  pumping: boolean;
};

type CoordinatorLease = {
  readonly ownerId: string;
  readonly groupId: string;
};

const systemSourceAccessClock: SourceAccessClock = {
  epochNow: () => Math.floor(performance.timeOrigin + performance.now()),
  monotonicNow: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** 由 runtime 注入持久状态适配器；间隔、并发、取消和许可算法由 SDK 执行。 */
export async function createSourceAccessCoordinator(input: {
  readonly store: SourceAccessPersistentStore;
  readonly clock?: SourceAccessClock;
}): Promise<SourceAccessCoordinator> {
  const saved = await input.store.load();
  const parsed = { version: 1 as const, lastAdmittedAt: {} };
  if (saved !== undefined) {
    const checked = sourceAccessPersistentStateSchema.safeParse(saved);
    if (!checked.success)
      throw new Error("来源准入持久状态格式无效，拒绝载入。", {
        cause: checked.error,
      });
    return new SdkSourceAccessCoordinator(
      input.store,
      input.clock ?? systemSourceAccessClock,
      checked.data,
    );
  }
  return new SdkSourceAccessCoordinator(
    input.store,
    input.clock ?? systemSourceAccessClock,
    parsed,
  );
}

class SdkSourceAccessCoordinator implements SourceAccessCoordinator {
  private readonly lastAdmittedAt = new Map<string, number>();
  private readonly groups = new Map<string, CoordinatorGroupState>();
  private readonly leases = new Map<string, CoordinatorLease>();
  private persistTail: Promise<void> = Promise.resolve();
  private readonly store: SourceAccessPersistentStore;
  private readonly clock: SourceAccessClock;

  constructor(
    store: SourceAccessPersistentStore,
    clock: SourceAccessClock,
    saved: SourceAccessPersistentState,
  ) {
    this.store = store;
    this.clock = clock;
    for (const [groupId, timestamp] of Object.entries(saved.lastAdmittedAt))
      this.lastAdmittedAt.set(groupId, timestamp);
  }

  acquire(
    ownerId: string,
    request: SourceAccessAcquireInput,
    rawDeclarations: SourceAccessConfig,
    signal: AbortSignal,
  ): Promise<SourceAccessLease> {
    const declarations = sourceAccessConfigSchema.parse(rawDeclarations);
    const group = declarations.groups[request.groupId];
    if (
      group === undefined ||
      !group.sources.includes(request.source) ||
      group.minimumIntervalMs !== request.minimumIntervalMs ||
      group.maxConcurrency !== request.maxConcurrency ||
      !validSourceAccessOrigin(request.origin) ||
      (request.notBeforeEpochMs !== undefined &&
        (!Number.isSafeInteger(request.notBeforeEpochMs) ||
          request.notBeforeEpochMs < 0))
    )
      return Promise.reject(
        new Error("worker 请求与本次运行声明的来源准入策略不一致。"),
      );
    if (signal.aborted)
      return Promise.reject(
        signal.reason ?? new DOMException("已取消", "AbortError"),
      );

    const state = this.groupState(request.groupId);
    return new Promise((resolve, reject) => {
      const waiter: CoordinatorWaiter = {
        ownerId,
        request,
        group,
        signal,
        queuedAt: this.clock.monotonicNow(),
        resolve,
        reject,
      };
      waiter.abort = () => {
        const index = state.queue.indexOf(waiter);
        if (index !== -1) state.queue.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort!);
        reject(signal.reason ?? new DOMException("已取消", "AbortError"));
        this.schedulePump(request.groupId, state);
      };
      state.queue.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.schedulePump(request.groupId, state);
    });
  }

  async release(ownerId: string, leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (lease === undefined || lease.ownerId !== ownerId)
      throw new Error("worker 不能释放不属于自己的来源准入许可。");
    this.releaseLease(leaseId, lease);
  }

  closeOwner(ownerId: string): void {
    for (const [groupId, state] of this.groups) {
      for (let index = state.queue.length - 1; index >= 0; index--) {
        const waiter = state.queue[index]!;
        if (waiter.ownerId !== ownerId) continue;
        this.removeWaiter(state, waiter);
        waiter.reject(new DOMException("worker 已结束", "AbortError"));
      }
      for (const leaseId of state.leases) {
        const lease = this.leases.get(leaseId);
        if (lease?.ownerId === ownerId) this.releaseLease(leaseId, lease);
      }
      if (state.queue.length > 0) this.schedulePump(groupId, state);
    }
  }

  private groupState(groupId: string): CoordinatorGroupState {
    let state = this.groups.get(groupId);
    if (state === undefined) {
      state = {
        queue: [],
        leases: new Set(),
        lastAdmittedAt: this.lastAdmittedAt.get(groupId) ?? 0,
        timer: undefined,
        pumping: false,
      };
      this.groups.set(groupId, state);
    }
    return state;
  }

  private removeWaiter(
    state: CoordinatorGroupState,
    waiter: CoordinatorWaiter,
  ): void {
    const index = state.queue.indexOf(waiter);
    if (index !== -1) state.queue.splice(index, 1);
    if (waiter.abort !== undefined)
      waiter.signal.removeEventListener("abort", waiter.abort);
  }

  private schedulePump(groupId: string, state: CoordinatorGroupState): void {
    if (state.pumping) return;
    if (state.queue.length === 0) {
      if (state.timer !== undefined) this.clock.clearTimer(state.timer);
      state.timer = undefined;
      return;
    }
    if (state.timer !== undefined) this.clock.clearTimer(state.timer);
    const waiter = state.queue[0]!;
    if (state.leases.size >= waiter.group.maxConcurrency) return;
    const nextAt = Math.max(
      state.lastAdmittedAt + waiter.group.minimumIntervalMs,
      waiter.request.notBeforeEpochMs ?? 0,
    );
    const waitMs = Math.max(0, nextAt - this.clock.epochNow());
    if (waitMs > 0) {
      state.timer = this.clock.setTimer(() => {
        state.timer = undefined;
        this.schedulePump(groupId, state);
      }, waitMs);
      return;
    }
    state.pumping = true;
    void this.grantNext(groupId, state);
  }

  private async grantNext(
    groupId: string,
    state: CoordinatorGroupState,
  ): Promise<void> {
    try {
      const waiter = state.queue[0];
      if (waiter === undefined) return;
      if (waiter.signal.aborted) {
        this.removeWaiter(state, waiter);
        waiter.reject(
          waiter.signal.reason ?? new DOMException("已取消", "AbortError"),
        );
        return;
      }
      const timestamp = Math.floor(this.clock.epochNow());
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        this.removeWaiter(state, waiter);
        waiter.reject(new Error("来源准入时钟返回了无效的 epoch 时间。"));
        return;
      }
      try {
        await this.persistAdmission(groupId, state.lastAdmittedAt, timestamp);
      } catch (error) {
        this.removeWaiter(state, waiter);
        waiter.reject(error);
        return;
      }
      state.lastAdmittedAt = timestamp;
      if (waiter.signal.aborted) {
        this.removeWaiter(state, waiter);
        waiter.reject(
          waiter.signal.reason ?? new DOMException("已取消", "AbortError"),
        );
        return;
      }
      this.removeWaiter(state, waiter);
      const leaseId = randomUUID();
      state.leases.add(leaseId);
      this.leases.set(leaseId, { ownerId: waiter.ownerId, groupId });
      waiter.resolve({
        leaseId,
        waitedMs: Math.max(
          0,
          Math.ceil(this.clock.monotonicNow() - waiter.queuedAt),
        ),
      });
    } finally {
      state.pumping = false;
      this.schedulePump(groupId, state);
    }
  }

  private releaseLease(leaseId: string, lease: CoordinatorLease): void {
    const state = this.groups.get(lease.groupId);
    if (state === undefined) return;
    state.leases.delete(leaseId);
    this.leases.delete(leaseId);
    this.schedulePump(lease.groupId, state);
  }

  private async persistAdmission(
    groupId: string,
    previous: number,
    timestamp: number,
  ): Promise<void> {
    const prior = this.persistTail;
    let release!: () => void;
    this.persistTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    this.lastAdmittedAt.set(groupId, timestamp);
    try {
      await this.store.save({
        version: 1,
        lastAdmittedAt: Object.fromEntries(this.lastAdmittedAt),
      });
    } catch (error) {
      if (previous === 0) this.lastAdmittedAt.delete(groupId);
      else this.lastAdmittedAt.set(groupId, previous);
      throw error;
    } finally {
      release();
    }
  }
}

function validSourceAccessOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}

/** 从适配器原生配置读取可发现的来源准入声明；未声明时保持可选。 */
export function sourceAccessConfigFromAdapterConfig(
  config: unknown,
): SourceAccessConfig | undefined {
  if (
    typeof config !== "object" ||
    config === null ||
    !("sourceAccess" in config)
  )
    return undefined;
  const value = config.sourceAccess;
  return value === undefined
    ? undefined
    : sourceAccessConfigSchema.parse(value);
}

export type SourceAccessClient = {
  withAdmission<T>(
    request: SourceAccessRequest,
    operation: () => Promise<T>,
  ): Promise<T>;
  snapshot(): SourceAccessSnapshot;
};

/** 让适配器以来源组声明保护一次主动访问，并保留可解释的准入统计。 */
export function createSourceAccessClient(input: {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly declarations: SourceAccessConfig;
  readonly transport: SourceAccessTransport;
}): SourceAccessClient {
  const groups = input.declarations.groups;

  let admittedAttempts = 0;
  let waitedMs = 0;
  const bySource: Record<SourceAccessKind, number> = { site: 0, media: 0 };

  return {
    async withAdmission<T>(
      request: SourceAccessRequest,
      operation: () => Promise<T>,
    ): Promise<T> {
      const group = groups[request.groupId];
      if (group === undefined || !group.sources.includes(request.source))
        throw new Error("本次主动访问没有声明对应的来源准入组或来源类型。");
      if (
        request.notBeforeEpochMs !== undefined &&
        (!Number.isSafeInteger(request.notBeforeEpochMs) ||
          request.notBeforeEpochMs < 0)
      )
        throw new Error("来源准入最早时刻必须是非负安全整数毫秒时间戳。");
      let origin: string;
      try {
        const parsedOrigin = new URL(request.origin);
        if (
          (parsedOrigin.protocol !== "http:" &&
            parsedOrigin.protocol !== "https:") ||
          parsedOrigin.origin !== request.origin
        )
          throw new Error("invalid origin");
        origin = parsedOrigin.origin;
      } catch {
        throw new Error("来源准入必须使用不含路径的 HTTP(S) origin。");
      }

      const lease = await input.transport.acquire(
        {
          runId: input.runId,
          groupId: request.groupId,
          source: request.source,
          origin,
          minimumIntervalMs: group.minimumIntervalMs,
          maxConcurrency: group.maxConcurrency,
          ...(request.notBeforeEpochMs === undefined
            ? {}
            : { notBeforeEpochMs: request.notBeforeEpochMs }),
        },
        input.signal,
      );
      if (input.signal.aborted) {
        await input.transport.release(lease.leaseId).catch(() => undefined);
        throw input.signal.reason ?? new DOMException("已取消", "AbortError");
      }
      admittedAttempts++;
      waitedMs += lease.waitedMs;
      bySource[request.source]++;

      let result: T | undefined;
      let operationFailed = false;
      let operationFailure: unknown;
      try {
        result = await operation();
      } catch (error) {
        operationFailed = true;
        operationFailure = error;
      }

      let releaseFailed = false;
      let releaseFailure: unknown;
      try {
        await input.transport.release(lease.leaseId);
      } catch (error) {
        releaseFailed = true;
        releaseFailure = error;
      }
      if (operationFailed) throw operationFailure;
      if (releaseFailed) throw releaseFailure;
      return result as T;
    },
    snapshot() {
      return {
        admittedAttempts,
        waitedMs,
        bySource: { ...bySource },
      };
    },
  };
}
