import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { archiveErrorSchema } from "@binny/contracts";
import type { CancellableQueryExecutor } from "@binny/db";
import { sql } from "drizzle-orm";

import {
  ArchiveRequestCancelled,
  executeCancellableArchiveQuery,
} from "./archive-query-cancellation.ts";

void describe("cancellable archive query execution", () => {
  void it("rejects query_budget_exceeded in the public archive error schema", () => {
    const parsed = archiveErrorSchema.safeParse({
      error: {
        code: "query_budget_exceeded",
        message: "Timed out",
      },
    });
    assert.equal(parsed.success, false);
  });

  void it("waits past the former 10-second window without timing out when not aborted", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let cancelCalls = 0;
    const executeQuery: CancellableQueryExecutor = () => ({
      rows: new Promise((resolve) => {
        setTimeout(() => {
          resolve([{ ok: true }] as never);
        }, 15_000);
      }),
      cancel: () => {
        cancelCalls += 1;
      },
    });

    const controller = new AbortController();
    const pending = executeCancellableArchiveQuery<{ readonly ok: boolean }>(
      executeQuery,
      sql`SELECT true AS ok`,
      controller.signal,
    );
    t.mock.timers.tick(15_000);
    const rows = await pending;
    assert.deepEqual(rows, [{ ok: true }]);
    assert.equal(cancelCalls, 0);
  });

  void it("rejects immediately without starting work when already aborted", async () => {
    let executed = false;
    const executeQuery: CancellableQueryExecutor = () => {
      executed = true;
      return {
        rows: Promise.resolve([]),
        cancel: () => undefined,
      };
    };

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        executeCancellableArchiveQuery(
          executeQuery,
          sql`SELECT 1`,
          controller.signal,
        ),
      ArchiveRequestCancelled,
    );
    assert.equal(executed, false);
  });

  void it("cancels the pending database query and rejects on abort", async () => {
    let cancelCalls = 0;
    let rejectRows!: (error: unknown) => void;
    const executeQuery: CancellableQueryExecutor = () => ({
      rows: new Promise((_, reject) => {
        rejectRows = reject;
      }),
      cancel: () => {
        cancelCalls += 1;
        rejectRows(
          Object.assign(new Error("canceling statement"), { code: "57014" }),
        );
      },
    });

    const controller = new AbortController();
    const pending = executeCancellableArchiveQuery(
      executeQuery,
      sql`SELECT 1`,
      controller.signal,
    );
    controller.abort();
    await assert.rejects(() => pending, ArchiveRequestCancelled);
    assert.equal(cancelCalls, 1);
  });

  void it("propagates database errors when the request was not aborted", async () => {
    const dbError = Object.assign(new Error("statement canceled externally"), {
      code: "57014",
    });
    const executeQuery: CancellableQueryExecutor = () => ({
      rows: Promise.reject(dbError),
      cancel: () => undefined,
    });

    const controller = new AbortController();
    await assert.rejects(
      () =>
        executeCancellableArchiveQuery(
          executeQuery,
          sql`SELECT 1`,
          controller.signal,
        ),
      (error: unknown) => error === dbError,
    );
  });
});
