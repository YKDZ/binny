import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createActionCancelledReason,
  createSourceAccessBudget,
  createSourceAccessClient,
  isActionCancelledReason,
  isSourceAccessBudgetExceededError,
  isSourceAdapterActionError,
  type SourceAccessClient,
} from "@binny/source-adapter-sdk";
import type { Page } from "patchright-core";

import {
  bindPageSourceAccessForTest,
  failureFromAccess,
  failureWithProgress,
  fetchInPageOnce,
  readSessionAccess,
  readTopic,
  readTopicListPage,
  readVisibleCategories,
} from "../src/source-adapter.ts";

function createTestAccessClient(signal: AbortSignal): SourceAccessClient {
  return createSourceAccessClient({
    runId: "diag-test-run",
    signal,
    declarations: {
      groups: {
        linuxdo: {
          sources: ["site", "media"],
          minimumIntervalMs: 0,
          maxConcurrency: 1,
        },
      },
    },
    transport: {
      async acquire() {
        return { leaseId: "lease-1", waitedMs: 0 };
      },
      async release() {},
      async observeResponse(_input, response) {
        return {
          status: response.status === 503 ? (503 as const) : (429 as const),
          observedAtEpochMs: Date.now(),
          outcome: "past" as const,
        };
      },
    },
  });
}

void describe("Linux.do source adapter failure diagnostics", () => {
  void it("splits per-request timeout from action budget remaining time and classifies budget exhaustion accurately", async () => {
    const parentController = new AbortController();
    const baseClient = createTestAccessClient(parentController.signal);
    const budget = createSourceAccessBudget({
      client: baseClient,
      signal: parentController.signal,
      maxRequests: 10,
      maxElapsedMs: 60,
    });

    let observedBudgetWindowMs = 0;
    const page = {
      url: () => "https://linux.do/",
      isClosed: () => false,
      close: async () => undefined,
      evaluate: async (_fn: unknown, arg: { readonly expiresAt: number }) => {
        observedBudgetWindowMs =
          arg.expiresAt - (performance.timeOrigin + performance.now());
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          mitigated: "",
          status: 200,
          contentType: "application/json",
          body: "{}",
        };
      },
    } as unknown as Page;

    bindPageSourceAccessForTest(page, "https://linux.do", {
      client: budget,
      signal: budget.signal,
    });

    try {
      await assert.rejects(
        () =>
          fetchInPageOnce(
            page,
            new URL("https://linux.do/latest.json"),
            "application/json",
            "text",
            30_000,
          ),
        (error: unknown) => isSourceAccessBudgetExceededError(error),
      );
      assert.ok(
        observedBudgetWindowMs > 10_000,
        `expected per-request timeout (~30000ms) not capped to 60ms budget, got ${String(observedBudgetWindowMs)}`,
      );
    } finally {
      budget.close();
    }
  });

  void it("returns structured timeout from browser fetchInPageOnce and populates stage, target, and abortCause", async () => {
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = globalThis;
    globalThis.fetch = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(
              new DOMException(
                "signal is aborted without reason",
                "AbortError",
              ),
            );
          },
          { once: true },
        );
      });

    const page = {
      url: () => "https://linux.do/",
      isClosed: () => false,
      evaluate: async (fn: (arg: unknown) => Promise<unknown>, arg: unknown) =>
        await fn(arg),
    } as unknown as Page;
    bindPageSourceAccessForTest(page, "https://linux.do", {
      signal: controller.signal,
    });

    const previousEnvTimeout = process.env.BINNY_LINUXDO_REQUEST_TIMEOUT_MS;
    process.env.BINNY_LINUXDO_REQUEST_TIMEOUT_MS = "25";
    try {
      const access = await readTopic(
        page,
        { origin: new URL("https://linux.do"), namespace: "linuxdo:linux.do" },
        2401,
        controller.signal,
      );
      assert.equal(access.kind, "unavailable");
      const actionError = failureFromAccess(access);
      assert.equal(actionError.failure.code, "linuxdo_source_unreachable");
      assert.equal(actionError.failure.stage, "reading-topic");
      assert.equal(actionError.failure.target, "https://linux.do/t/2401.json");
      assert.equal(actionError.failure.abortCause, "source_request_timeout");
    } finally {
      if (previousEnvTimeout === undefined) {
        delete process.env.BINNY_LINUXDO_REQUEST_TIMEOUT_MS;
      } else {
        process.env.BINNY_LINUXDO_REQUEST_TIMEOUT_MS = previousEnvTimeout;
      }
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  void it("preserves abortCause unknown when an underlying AbortError has no cancellation, timeout, or budget evidence", async () => {
    const controller = new AbortController();
    const page = {
      url: () => "https://linux.do/",
      isClosed: () => false,
      evaluate: async () => {
        throw new DOMException(
          "signal is aborted without reason",
          "AbortError",
        );
      },
    } as unknown as Page;
    bindPageSourceAccessForTest(page, "https://linux.do", {
      signal: controller.signal,
    });

    await assert.rejects(
      () =>
        readTopicListPage(
          page,
          new URL("https://linux.do/latest.json"),
          controller.signal,
        ),
      (error: unknown) => {
        assert.equal(isSourceAdapterActionError(error), true);
        if (!isSourceAdapterActionError(error)) return false;
        assert.equal(error.failure.code, "linuxdo_source_unreachable");
        assert.equal(error.failure.stage, "reading-topic-list");
        assert.equal(error.failure.target, "https://linux.do/latest.json");
        assert.equal(error.failure.abortCause, "unknown");
        return true;
      },
    );

    await assert.rejects(
      () =>
        readVisibleCategories(
          page,
          {
            origin: new URL("https://linux.do"),
            namespace: "linuxdo:linux.do",
          },
          controller.signal,
        ),
      (error: unknown) => {
        assert.equal(isSourceAdapterActionError(error), true);
        if (!isSourceAdapterActionError(error)) return false;
        assert.equal(error.failure.code, "linuxdo_source_unreachable");
        assert.equal(error.failure.stage, "discovering-categories");
        assert.equal(
          error.failure.target,
          "https://linux.do/categories.json?include_subcategories=true",
        );
        assert.equal(error.failure.abortCause, "unknown");
        return true;
      },
    );
  });

  void it("tracks initializing-page-origin stage and target on page.goto TimeoutError and propagates user_cancelled on abort", async () => {
    const timeoutController = new AbortController();
    const gotoTimeoutPage = {
      url: () => "about:blank",
      isClosed: () => false,
      goto: async () => {
        const error = new Error("page.goto: Timeout 30000ms exceeded.");
        error.name = "TimeoutError";
        throw error;
      },
    } as unknown as Page;
    bindPageSourceAccessForTest(gotoTimeoutPage, "https://linux.do", {
      signal: timeoutController.signal,
    });

    const session = await readSessionAccess(
      gotoTimeoutPage,
      { origin: new URL("https://linux.do"), namespace: "linuxdo:linux.do" },
      timeoutController.signal,
    );
    assert.equal(session.kind, "unavailable");
    assert.equal(session.diagnostic?.stage, "initializing-page-origin");
    assert.equal(session.diagnostic?.target, "https://linux.do/");
    assert.equal(session.diagnostic?.abortCause, "source_request_timeout");

    const cancelController = new AbortController();
    const cancelPage = {
      url: () => "https://linux.do/",
      isClosed: () => false,
      evaluate: async () => {
        cancelController.abort(createActionCancelledReason());
        throw new DOMException("Target closed", "AbortError");
      },
    } as unknown as Page;
    bindPageSourceAccessForTest(cancelPage, "https://linux.do", {
      signal: cancelController.signal,
    });

    let caught: unknown;
    try {
      await readTopicListPage(
        cancelPage,
        new URL("https://linux.do/c/develop/4/l/latest.json"),
        cancelController.signal,
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(isActionCancelledReason(caught), true);
    const wrapped = failureWithProgress(
      caught,
      { signal: cancelController.signal },
      [],
      cancelPage,
    );
    assert.equal(wrapped.failure.code, "source_adapter_action_cancelled");
    assert.equal(wrapped.failure.stage, "reading-topic-list");
    assert.equal(
      wrapped.failure.target,
      "https://linux.do/c/develop/4/l/latest.json",
    );
    assert.equal(wrapped.failure.abortCause, "user_cancelled");
  });
});
