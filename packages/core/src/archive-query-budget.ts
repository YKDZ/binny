import { performance } from "node:perf_hooks";

import type { CancellableQueryExecutor } from "@binny/db";
import type { SQL } from "drizzle-orm";

export class ArchiveQueryBudgetExceeded extends Error {}

export class ArchiveRequestCancelled extends Error {}

export function createArchiveQueryDeadline(budgetMs: number): number {
  return performance.now() + budgetMs;
}

export function assertArchiveQueryActive(
  deadline: number,
  signal?: AbortSignal,
): number {
  if (signal?.aborted) throw new ArchiveRequestCancelled();
  return remainingArchiveQueryBudgetMs(deadline);
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
  signal?: AbortSignal,
): Promise<readonly Row[]> {
  const remaining = assertArchiveQueryActive(deadline, signal);
  const pending = executeQuery<Row>(query);
  let timeout: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const cancelled = new Promise<{ readonly kind: "cancelled" }>((resolve) => {
    if (signal === undefined) return;
    abortHandler = () => resolve({ kind: "cancelled" });
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  });
  let outcome:
    | { readonly kind: "rows"; readonly rows: readonly Row[] }
    | { readonly kind: "error"; readonly error: unknown }
    | { readonly kind: "timeout" }
    | { readonly kind: "cancelled" };
  try {
    outcome = await Promise.race([
      pending.rows.then(
        (rows) => ({ kind: "rows" as const, rows }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), remaining);
      }),
      cancelled,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
  if (outcome.kind === "timeout") {
    pending.cancel();
    throw new ArchiveQueryBudgetExceeded();
  }
  if (outcome.kind === "cancelled") {
    pending.cancel();
    throw new ArchiveRequestCancelled();
  }
  if (outcome.kind === "error") throw outcome.error;
  assertArchiveQueryActive(deadline, signal);
  return outcome.rows as readonly Row[];
}
