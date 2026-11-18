import type { CancellableQueryExecutor } from "@binny/db";
import type { SQL, SQLWrapper } from "drizzle-orm";

export class ArchiveRequestCancelled extends Error {}

export function assertArchiveQueryActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArchiveRequestCancelled();
}

/**
 * Execute a cancellable Drizzle query and abort pending PostgreSQL work if the
 * caller's `AbortSignal` fires. The driver returns raw rows, so callers keep
 * SQL aliases explicit and validate the public response before returning.
 */
export async function executeCancellableArchiveQuery<
  Row extends Record<string, unknown>,
>(
  executeQuery: CancellableQueryExecutor,
  query: SQL<Row[]> | SQLWrapper,
  signal?: AbortSignal,
): Promise<readonly Row[]> {
  assertArchiveQueryActive(signal);
  const rawQuery = query.getSQL() as SQL<Row[]>;
  const pending = executeQuery<Row>(rawQuery);
  let abortHandler: (() => void) | undefined;
  const cancelled = new Promise<{ readonly kind: "cancelled" }>((resolve) => {
    if (signal === undefined) return;
    abortHandler = () => {
      void Promise.resolve(pending.cancel()).catch(() => undefined);
      resolve({ kind: "cancelled" });
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  });
  let outcome:
    | { readonly kind: "rows"; readonly rows: readonly Row[] }
    | { readonly kind: "error"; readonly error: unknown }
    | { readonly kind: "cancelled" };
  try {
    outcome = await Promise.race([
      pending.rows.then(
        (rows) => ({ kind: "rows" as const, rows }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      cancelled,
    ]);
  } finally {
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
  if (outcome.kind === "cancelled") {
    throw new ArchiveRequestCancelled();
  }
  if (outcome.kind === "error") {
    if (signal?.aborted) throw new ArchiveRequestCancelled();
    throw outcome.error;
  }
  assertArchiveQueryActive(signal);
  return outcome.rows;
}
