import { eq } from "drizzle-orm";

import type { CoreDatabase, CoreTransaction } from "./database.ts";
import { archiveWriteClock } from "./schema.ts";

export type ArchiveTransaction = CoreTransaction;

/**
 * 所有归档写入和资源生命周期操作使用同一短事务写门，
 * 避免并发提交、引用登记与资源清理采用不同锁序。
 */
export async function withArchiveWriteLock<T>(
  database: CoreDatabase,
  operation: (
    transaction: ArchiveTransaction,
    currentSequence: bigint,
  ) => Promise<T>,
): Promise<T> {
  const result = await database.transaction(async (transaction) => {
    const clocks = await transaction
      .select({ lastSequence: archiveWriteClock.lastSequence })
      .from(archiveWriteClock)
      .where(eq(archiveWriteClock.clockId, 1))
      .for("update");
    const clock = clocks[0];
    if (clock === undefined) {
      throw new Error("归档写入时钟尚未初始化。");
    }
    return {
      value: await operation(transaction, clock.lastSequence),
    };
  });
  return result.value;
}

/** 仅在同一写事务中提交新的归档观察时推进全局序号。 */
export async function advanceArchiveSequence(
  transaction: ArchiveTransaction,
  currentSequence: bigint,
): Promise<string> {
  const nextSequence = currentSequence + 1n;
  const rows = await transaction
    .update(archiveWriteClock)
    .set({ lastSequence: nextSequence })
    .where(eq(archiveWriteClock.clockId, 1))
    .returning({ lastSequence: archiveWriteClock.lastSequence });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("无法推进归档写入时钟。");
  }
  return row.lastSequence.toString();
}
