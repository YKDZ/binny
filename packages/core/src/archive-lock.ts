import type postgres from "postgres";

import type { CoreDatabase } from "./database.ts";

type ClockRow = {
  readonly last_seq: string;
};

export type ArchiveTransaction = postgres.TransactionSql;

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
  const result = await database.begin(async (transaction) => {
    const clocks = await transaction<ClockRow[]>`
      SELECT last_seq::text AS last_seq
      FROM archive_write_clock
      WHERE clock_id = 1
      FOR UPDATE
    `;
    const clock = clocks[0];
    if (clock === undefined) {
      throw new Error("归档写入时钟尚未初始化。");
    }
    return {
      value: await operation(transaction, BigInt(clock.last_seq)),
    };
  });
  return result.value;
}

/** 仅在同一写事务中提交新的归档观察时推进全局序号。 */
export async function advanceArchiveSequence(
  transaction: ArchiveTransaction,
  currentSequence: bigint,
): Promise<string> {
  const nextSequence = (currentSequence + 1n).toString();
  const rows = await transaction<{ readonly last_seq: string }[]>`
    UPDATE archive_write_clock
    SET last_seq = ${nextSequence}::bigint
    WHERE clock_id = 1
    RETURNING last_seq::text AS last_seq
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("无法推进归档写入时钟。");
  }
  return row.last_seq;
}
