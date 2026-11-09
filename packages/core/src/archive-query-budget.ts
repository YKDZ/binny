import { performance } from "node:perf_hooks";

import type { CancellableQueryExecutor } from "@binny/db";
import type { SQL } from "drizzle-orm";

export class ArchiveQueryBudgetExceeded extends Error {}

export function createArchiveQueryDeadline(budgetMs: number): number {
  return performance.now() + budgetMs;
}

export function remainingArchiveQueryBudgetMs(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new ArchiveQueryBudgetExceeded();
  return remaining;
}

/** Execute one cancellable SQL statement under the request's shared deadline. */
export async function executeArchiveQueryWithinDeadline<
  Row extends Record<string, unknown>,
>(
  executeQuery: CancellableQueryExecutor,
  query: SQL<Row[]>,
  deadline: number,
): Promise<readonly Row[]> {
  const remaining = remainingArchiveQueryBudgetMs(deadline);
  const pending = executeQuery<Row>(query);
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    pending.rows.then(
      (rows) => ({ kind: "rows" as const, rows }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), remaining);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome.kind === "timeout") {
    pending.cancel();
    throw new ArchiveQueryBudgetExceeded();
  }
  if (outcome.kind === "error") throw outcome.error;
  remainingArchiveQueryBudgetMs(deadline);
  return outcome.rows as readonly Row[];
}
