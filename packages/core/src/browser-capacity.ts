import { randomUUID } from "node:crypto";

import { runtimeEnvironmentStoredSchema } from "@binny/contracts";
import {
  browserCapacityCoordinator,
  browserCapacityReservations,
  humanSessions,
  manualRuns,
  runtimeConnections,
  type Database,
  type Transaction,
} from "@binny/db";
import { and, count, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

export type BrowserCapacityState =
  | "reserved"
  | "starting"
  | "ready"
  | "stopping"
  | "unknown";

export type BrowserCapacityPowerStatus =
  | Exclude<BrowserCapacityState, "reserved">
  | "stopped";

export type BrowserCapacityOwner = {
  readonly binId: string;
  readonly runtimeId: string;
  readonly ownerGeneration: string | bigint;
};

export type BrowserCapacityAdmission =
  | { readonly kind: "reserved"; readonly reservationId: string }
  | { readonly kind: "browser_capacity_exhausted" }
  | { readonly kind: "bin_busy" }
  | { readonly kind: "runtime_protocol_outdated" };

export type BrowserCapacityReservation = {
  readonly reservationId: string;
  readonly status: BrowserCapacityState;
  readonly requiresReservationId: boolean;
};

export type BrowserCapacityQueueReason =
  | "browser_capacity_exhausted"
  | "bin_busy"
  | "runtime_protocol_outdated";

export type BrowserCapacityCoordinator = {
  /** 迁移后按旧 runtime 的真实 power 快照接续仍占用中的浏览器。 */
  initialize(database: Database): Promise<void>;
  /** 同一事务中串行检查部署总数并预约；仅同一 owner 的启动中或就绪浏览器可复用。 */
  reserve(
    transaction: Transaction,
    owner: BrowserCapacityOwner,
    supportsReservationId: boolean,
  ): Promise<BrowserCapacityAdmission>;
  /** 查询精确 owner 仍持有的预约，用于对丢失的 open 控制回包安全重试。 */
  reservation(
    transaction: Database | Transaction,
    owner: BrowserCapacityOwner,
  ): Promise<BrowserCapacityReservation | undefined>;
  /** 旧尝试的迟到状态不能改写新预约；只有 stopped 释放名额。 */
  reportPower(
    transaction: Transaction,
    owner: BrowserCapacityOwner,
    reservationId: string,
    status: BrowserCapacityPowerStatus,
  ): Promise<boolean>;
  /** 仅兼容迁移前仍在运行且不认识 reservationId 的正式 controller。 */
  reportLegacyPower(
    transaction: Transaction,
    owner: BrowserCapacityOwner,
    status: BrowserCapacityPowerStatus,
    previousStatus: BrowserCapacityPowerStatus | "unavailable" | undefined,
  ): Promise<boolean | undefined>;
  /** 仅明确未发出启动动作时释放尚未离开 reserved 的预约。 */
  confirmNotStarted(
    transaction: Transaction,
    owner: BrowserCapacityOwner,
    reservationId: string,
  ): Promise<boolean>;
  /** 更高代际合法接管 owner lock 后，回收已退出旧容器的浏览器占位。 */
  releaseReplacedOwner(
    transaction: Transaction,
    previousOwner: BrowserCapacityOwner,
  ): Promise<void>;
  /** 仅用于展示等待原因，不作为准入判断；实际准入仍需 reserve 的锁。 */
  queueReason(
    transaction: Database | Transaction,
    owner: BrowserCapacityOwner,
    supportsReservationId: boolean,
  ): Promise<BrowserCapacityQueueReason | undefined>;
  /** 在 bin 行锁后检查并协调配置删除，避免移除活动预约的归属配置。 */
  hasReservation(transaction: Transaction, binId: string): Promise<boolean>;
};

function sameOwner(
  row: {
    readonly runtimeId: string;
    readonly ownerGeneration: bigint;
  },
  owner: BrowserCapacityOwner,
): boolean {
  return (
    row.runtimeId === owner.runtimeId &&
    row.ownerGeneration === BigInt(owner.ownerGeneration)
  );
}

function legacyReservationStatus(
  environment: unknown,
): Exclude<BrowserCapacityState, "reserved"> | undefined {
  const snapshot = runtimeEnvironmentStoredSchema.safeParse(environment);
  if (!snapshot.success || !snapshot.data.browser.available) return undefined;
  const status = snapshot.data.browser.power?.status;
  if (status === "stopped") return undefined;
  if (
    status === "starting" ||
    status === "ready" ||
    status === "stopping" ||
    status === "unknown"
  )
    return status;
  // 旧持久快照未记录 power 时不能假定进程已退出。
  return "unknown";
}

function canAdvance(
  current: BrowserCapacityState,
  next: BrowserCapacityState,
): boolean {
  if (current === next) return true;
  // 启停结果不明时只允许确认就绪或进入关闭，不能再发起同一 attempt 的新启动。
  if (current === "unknown") return next === "ready" || next === "stopping";
  if (current === "reserved") return next === "starting";
  if (current === "starting")
    return next === "ready" || next === "stopping" || next === "unknown";
  if (current === "ready")
    return next === "starting" || next === "stopping" || next === "unknown";
  return next === "unknown";
}

async function hasActiveBrowserUse(
  transaction: Transaction,
  binId: string,
): Promise<boolean> {
  const [run] = await transaction
    .select({ runId: manualRuns.runId })
    .from(manualRuns)
    .where(
      and(
        eq(manualRuns.binId, binId),
        or(
          inArray(manualRuns.status, ["executing", "cancelling"]),
          and(
            isNotNull(manualRuns.startedAt),
            isNull(manualRuns.stopConfirmedAt),
          ),
        ),
      ),
    )
    .limit(1);
  if (run !== undefined) return true;
  const [session] = await transaction
    .select({ sessionId: humanSessions.sessionId })
    .from(humanSessions)
    .where(
      and(
        eq(humanSessions.binId, binId),
        inArray(humanSessions.status, ["opening", "ready", "closing"]),
      ),
    )
    .limit(1);
  return session !== undefined;
}

export function createBrowserCapacityCoordinator(
  maxActiveBrowsers: number,
): BrowserCapacityCoordinator {
  if (!Number.isSafeInteger(maxActiveBrowsers) || maxActiveBrowsers < 1)
    throw new Error("同时活跃的浏览器数量上限必须是正整数。");

  async function lockCapacity(transaction: Transaction): Promise<void> {
    // 调用者先锁当前 bin；该单例行串行所有跨 bin 的占用集合变更。
    const [coordinator] = await transaction
      .select({ coordinatorId: browserCapacityCoordinator.coordinatorId })
      .from(browserCapacityCoordinator)
      .where(eq(browserCapacityCoordinator.coordinatorId, 1))
      .for("update");
    if (coordinator === undefined)
      throw new Error("浏览器容量协调记录缺失；拒绝无锁预约。");
  }

  async function readReservation(
    transaction: Database | Transaction,
    owner: BrowserCapacityOwner,
  ) {
    const [reservation] = await transaction
      .select()
      .from(browserCapacityReservations)
      .where(eq(browserCapacityReservations.binId, owner.binId))
      .limit(1);
    return reservation;
  }

  async function activeCount(
    transaction: Database | Transaction,
  ): Promise<number> {
    const [row] = await transaction
      .select({ value: count() })
      .from(browserCapacityReservations);
    return row?.value ?? 0;
  }

  const coordinator: BrowserCapacityCoordinator = {
    async initialize(database) {
      await database.transaction(async (transaction) => {
        await transaction
          .insert(browserCapacityCoordinator)
          .values({ coordinatorId: 1 })
          .onConflictDoNothing({
            target: browserCapacityCoordinator.coordinatorId,
          });
        await lockCapacity(transaction);

        const runtimes = await transaction
          .select({
            binId: runtimeConnections.binId,
            runtimeId: runtimeConnections.runtimeId,
            ownerGeneration: runtimeConnections.ownerGeneration,
            environment: runtimeConnections.environment,
          })
          .from(runtimeConnections);
        for (const runtime of runtimes) {
          if (runtime.ownerGeneration < 1n) continue;
          const status = legacyReservationStatus(runtime.environment);
          if (status === undefined) continue;
          await transaction
            .insert(browserCapacityReservations)
            .values({
              reservationId: randomUUID(),
              binId: runtime.binId,
              runtimeId: runtime.runtimeId,
              ownerGeneration: runtime.ownerGeneration,
              requiresReservationId: false,
              status,
            })
            .onConflictDoNothing({
              target: browserCapacityReservations.binId,
            });
        }
      });
    },

    async reservation(transaction, owner) {
      const current = await readReservation(transaction, owner);
      return current === undefined || !sameOwner(current, owner)
        ? undefined
        : {
            reservationId: current.reservationId,
            status: current.status,
            requiresReservationId: current.requiresReservationId,
          };
    },

    async reserve(transaction, owner, supportsReservationId) {
      await lockCapacity(transaction);
      const current = await readReservation(transaction, owner);
      if (current !== undefined) {
        if (
          sameOwner(current, owner) &&
          (current.status === "starting" || current.status === "ready")
        ) {
          if (current.requiresReservationId && !supportsReservationId)
            return { kind: "runtime_protocol_outdated" };
          return {
            kind: "reserved",
            reservationId: current.reservationId,
          };
        }
        // reserved 仍绑定前一 attempt；不能让后续请求复用 ID 后被迟到的 not_started 释放。
        return { kind: "bin_busy" };
      }

      if (!supportsReservationId) return { kind: "runtime_protocol_outdated" };

      if ((await activeCount(transaction)) >= maxActiveBrowsers)
        return { kind: "browser_capacity_exhausted" };

      const reservationId = randomUUID();
      await transaction.insert(browserCapacityReservations).values({
        reservationId,
        binId: owner.binId,
        runtimeId: owner.runtimeId,
        ownerGeneration: BigInt(owner.ownerGeneration),
        status: "reserved",
      });
      return { kind: "reserved", reservationId };
    },

    async reportPower(transaction, owner, reservationId, status) {
      const previous = await transaction
        .select()
        .from(browserCapacityReservations)
        .where(
          and(
            eq(browserCapacityReservations.reservationId, reservationId),
            eq(browserCapacityReservations.binId, owner.binId),
          ),
        )
        .limit(1);
      const row = previous[0];
      if (row === undefined)
        // stopped 迟到重试是幂等的；精确 ID 已不占用容量，不会触及新预约。
        return status === "stopped";
      if (!sameOwner(row, owner)) return false;
      if (status === "stopped" && row.status !== "stopping") {
        // 只有已确认进入关闭阶段的同一 attempt 才能报告退出完成。
        return false;
      }
      if (status !== "stopped" && row.status === status) return true;
      if (status !== "stopped" && !canAdvance(row.status, status)) return false;

      await lockCapacity(transaction);
      const current = await transaction
        .select()
        .from(browserCapacityReservations)
        .where(
          and(
            eq(browserCapacityReservations.reservationId, reservationId),
            eq(browserCapacityReservations.binId, owner.binId),
          ),
        )
        .limit(1);
      const currentRow = current[0];
      if (currentRow === undefined) return status === "stopped";
      if (!sameOwner(currentRow, owner)) return false;

      if (status === "stopped") {
        if (currentRow.status !== "stopping") return false;
        if (await hasActiveBrowserUse(transaction, owner.binId)) return false;
        await transaction
          .delete(browserCapacityReservations)
          .where(
            and(
              eq(browserCapacityReservations.reservationId, reservationId),
              eq(browserCapacityReservations.binId, owner.binId),
              eq(browserCapacityReservations.runtimeId, owner.runtimeId),
              eq(
                browserCapacityReservations.ownerGeneration,
                BigInt(owner.ownerGeneration),
              ),
            ),
          );
        return true;
      }

      if (
        !canAdvance(currentRow.status, status) ||
        currentRow.status === status
      )
        return currentRow.status === status;
      if (
        status === "stopping" &&
        (await hasActiveBrowserUse(transaction, owner.binId))
      )
        return false;
      await transaction
        .update(browserCapacityReservations)
        .set({ status })
        .where(
          and(
            eq(browserCapacityReservations.reservationId, reservationId),
            eq(browserCapacityReservations.binId, owner.binId),
            eq(browserCapacityReservations.runtimeId, owner.runtimeId),
            eq(
              browserCapacityReservations.ownerGeneration,
              BigInt(owner.ownerGeneration),
            ),
          ),
        );
      return true;
    },

    async reportLegacyPower(transaction, owner, status, previousStatus) {
      const [reservation] = await transaction
        .select({
          reservationId: browserCapacityReservations.reservationId,
          status: browserCapacityReservations.status,
        })
        .from(browserCapacityReservations)
        .where(
          and(
            eq(browserCapacityReservations.binId, owner.binId),
            eq(browserCapacityReservations.runtimeId, owner.runtimeId),
            eq(
              browserCapacityReservations.ownerGeneration,
              BigInt(owner.ownerGeneration),
            ),
            eq(browserCapacityReservations.requiresReservationId, false),
          ),
        )
        .limit(1);
      if (reservation === undefined) return undefined;
      if (
        status === "stopped" &&
        (previousStatus !== "stopping" || reservation.status !== "stopping")
      )
        return false;
      return await coordinator.reportPower(
        transaction,
        owner,
        reservation.reservationId,
        status,
      );
    },

    async confirmNotStarted(transaction, owner, reservationId) {
      const previous = await transaction
        .select()
        .from(browserCapacityReservations)
        .where(
          and(
            eq(browserCapacityReservations.reservationId, reservationId),
            eq(browserCapacityReservations.binId, owner.binId),
          ),
        )
        .limit(1);
      const row = previous[0];
      if (row === undefined) return true;
      if (!sameOwner(row, owner)) return false;
      if (row.status !== "reserved") return false;

      await lockCapacity(transaction);
      const current = await transaction
        .select()
        .from(browserCapacityReservations)
        .where(
          and(
            eq(browserCapacityReservations.reservationId, reservationId),
            eq(browserCapacityReservations.binId, owner.binId),
          ),
        )
        .limit(1);
      const currentRow = current[0];
      if (currentRow === undefined || !sameOwner(currentRow, owner))
        return currentRow === undefined;
      if (currentRow.status !== "reserved") return false;
      await transaction
        .delete(browserCapacityReservations)
        .where(
          and(
            eq(browserCapacityReservations.reservationId, reservationId),
            eq(browserCapacityReservations.binId, owner.binId),
            eq(browserCapacityReservations.runtimeId, owner.runtimeId),
            eq(
              browserCapacityReservations.ownerGeneration,
              BigInt(owner.ownerGeneration),
            ),
          ),
        );
      return true;
    },

    async releaseReplacedOwner(transaction, previousOwner) {
      await lockCapacity(transaction);
      await transaction
        .delete(browserCapacityReservations)
        .where(
          and(
            eq(browserCapacityReservations.binId, previousOwner.binId),
            eq(browserCapacityReservations.runtimeId, previousOwner.runtimeId),
            eq(
              browserCapacityReservations.ownerGeneration,
              BigInt(previousOwner.ownerGeneration),
            ),
          ),
        );
    },

    async queueReason(transaction, owner, supportsReservationId) {
      const current = await readReservation(transaction, owner);
      if (current !== undefined) {
        if (
          !sameOwner(current, owner) ||
          (current.status !== "starting" && current.status !== "ready")
        )
          return "bin_busy";
        return current.requiresReservationId && !supportsReservationId
          ? "runtime_protocol_outdated"
          : undefined;
      }
      if (!supportsReservationId) return "runtime_protocol_outdated";
      return (await activeCount(transaction)) >= maxActiveBrowsers
        ? "browser_capacity_exhausted"
        : undefined;
    },

    async hasReservation(transaction, binId) {
      await lockCapacity(transaction);
      const [row] = await transaction
        .select({ reservationId: browserCapacityReservations.reservationId })
        .from(browserCapacityReservations)
        .where(eq(browserCapacityReservations.binId, binId))
        .limit(1);
      return row !== undefined;
    },
  };
  return coordinator;
}
