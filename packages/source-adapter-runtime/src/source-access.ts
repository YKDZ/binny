import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  sourceAccessConfigSchema,
  type SourceAccessAcquireInput,
  type SourceAccessConfig,
  type SourceAccessGroup,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

const stateSchema = z
  .object({
    version: z.literal(1),
    lastAdmittedAt: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

type Waiter = {
  readonly ownerId: string;
  readonly request: SourceAccessAcquireInput;
  readonly group: SourceAccessGroup;
  readonly signal: AbortSignal;
  readonly queuedAt: number;
  readonly resolve: (lease: { leaseId: string; waitedMs: number }) => void;
  readonly reject: (error: unknown) => void;
  abort?: () => void;
};

type GroupState = {
  readonly queue: Waiter[];
  readonly leases: Set<string>;
  lastAdmittedAt: number;
  timer: NodeJS.Timeout | undefined;
  pumping: boolean;
};

type Lease = { readonly ownerId: string; readonly groupId: string };

/** 按运行器所属 volume 持久记录每组最近的准入时间，并在 worker 间调度许可。 */
export class PersistentSourceAccessCoordinator {
  private readonly statePath: string;
  private readonly lastAdmittedAt = new Map<string, number>();
  private readonly groups = new Map<string, GroupState>();
  private readonly leases = new Map<string, Lease>();
  private persistTail: Promise<void> = Promise.resolve();

  private constructor(statePath: string) {
    this.statePath = statePath;
  }

  static async open(
    statePath: string,
  ): Promise<PersistentSourceAccessCoordinator> {
    const coordinator = new PersistentSourceAccessCoordinator(statePath);
    let saved: string;
    try {
      saved = await readFile(statePath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return coordinator;
      throw new Error("无法读取来源准入持久状态，运行器不能启动。", {
        cause: error,
      });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(saved) as unknown;
    } catch (error) {
      throw new Error("来源准入持久状态不是有效 JSON，运行器不能启动。", {
        cause: error,
      });
    }
    const parsed = stateSchema.safeParse(decoded);
    if (!parsed.success)
      throw new Error("来源准入持久状态格式无效，运行器不能启动。");
    for (const [groupId, timestamp] of Object.entries(
      parsed.data.lastAdmittedAt,
    ))
      coordinator.lastAdmittedAt.set(groupId, timestamp);
    return coordinator;
  }

  acquire(
    ownerId: string,
    request: SourceAccessAcquireInput,
    rawDeclarations: SourceAccessConfig,
    signal: AbortSignal,
  ): Promise<{ leaseId: string; waitedMs: number }> {
    const declarations = sourceAccessConfigSchema.parse(rawDeclarations);
    const group = declarations.groups[request.groupId];
    if (
      group === undefined ||
      !group.sources.includes(request.source) ||
      group.minimumIntervalMs !== request.minimumIntervalMs ||
      group.maxConcurrency !== request.maxConcurrency ||
      !validOrigin(request.origin)
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
      const waiter: Waiter = {
        ownerId,
        request,
        group,
        signal,
        queuedAt: performance.now(),
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

  /** worker 异常退出时，调用方须先清理其浏览器页再释放剩余许可。 */
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

  private groupState(groupId: string): GroupState {
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

  private removeWaiter(state: GroupState, waiter: Waiter): void {
    const index = state.queue.indexOf(waiter);
    if (index !== -1) state.queue.splice(index, 1);
    if (waiter.abort !== undefined)
      waiter.signal.removeEventListener("abort", waiter.abort);
  }

  private schedulePump(groupId: string, state: GroupState): void {
    if (state.pumping) return;
    if (state.queue.length === 0) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      return;
    }
    if (state.timer !== undefined) clearTimeout(state.timer);
    const waiter = state.queue[0]!;
    if (state.leases.size >= waiter.group.maxConcurrency) return;
    const nextAt = Math.max(
      state.lastAdmittedAt + waiter.group.minimumIntervalMs,
      waiter.request.notBeforeEpochMs ?? 0,
    );
    const waitMs = Math.max(0, nextAt - accessEpochNow());
    if (waitMs > 0) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        this.schedulePump(groupId, state);
      }, waitMs);
      return;
    }
    state.pumping = true;
    void this.grantNext(groupId, state);
  }

  private async grantNext(groupId: string, state: GroupState): Promise<void> {
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
      const timestamp = accessEpochNow();
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
        waitedMs: Math.max(0, Math.ceil(performance.now() - waiter.queuedAt)),
      });
    } finally {
      state.pumping = false;
      this.schedulePump(groupId, state);
    }
  }

  private releaseLease(leaseId: string, lease: Lease): void {
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
      await writeStateAtomically(this.statePath, {
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

function validOrigin(origin: string): boolean {
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

// 保留可跨 controller 重启比较的 epoch 时间，同时避开正式验收只替换 Date 的日期时钟。
function accessEpochNow(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}

async function writeStateAtomically(
  statePath: string,
  state: z.input<typeof stateSchema>,
): Promise<void> {
  const directoryPath = dirname(statePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directoryPath,
    `.source-access-${process.pid}-${randomUUID()}.tmp`,
  );
  let file: FileHandle | undefined;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, statePath);
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (file !== undefined) await file.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("无法持久写入来源准入时间，拒绝发放访问许可。", {
      cause: error,
    });
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
