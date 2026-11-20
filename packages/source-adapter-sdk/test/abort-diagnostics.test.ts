import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import {
  cleanContent,
  classifyAbortCause,
  createActionCancelledReason,
  fetchSourceResponse,
  fetchValidatedMedia,
  isActionCancelledReason,
  isSourceAccessBudgetExceededError,
  MediaFetchError,
  readFailureDiagnosticContext,
  SourceAccessBudgetExceededError,
  SourceRequestError,
  uploadCleanedMedia,
} from "../src/index.ts";

void describe("abort diagnostics and evidence-based classification", () => {
  void it("distinguishes user_cancelled, action_budget_exhausted, source_request_timeout, and unknown strictly from evidence", () => {
    const cancelReason = createActionCancelledReason();
    assert.equal(isActionCancelledReason(cancelReason), true);
    assert.equal(
      isActionCancelledReason(new DOMException("aborted", "AbortError")),
      false,
    );

    const cancelledController = new AbortController();
    cancelledController.abort(cancelReason);
    assert.equal(
      classifyAbortCause({
        error: new DOMException("The operation was aborted", "AbortError"),
        signal: cancelledController.signal,
        timeoutSignal: AbortSignal.abort(
          new DOMException("timed out", "TimeoutError"),
        ),
      }),
      "user_cancelled",
    );

    const budgetError = new SourceAccessBudgetExceededError(
      "elapsed-time-limit",
    );
    assert.equal(isSourceAccessBudgetExceededError(budgetError), true);
    assert.equal(
      isSourceAccessBudgetExceededError({
        name: "SourceAccessBudgetExceededError",
        reason: "request-limit",
      }),
      true,
    );
    const budgetController = new AbortController();
    budgetController.abort(budgetError);
    assert.equal(
      classifyAbortCause({
        error: new DOMException("aborted", "AbortError"),
        signal: budgetController.signal,
      }),
      "action_budget_exhausted",
    );

    const timeoutController = new AbortController();
    timeoutController.abort(new DOMException("timed out", "TimeoutError"));
    assert.equal(
      classifyAbortCause({
        error: new DOMException("timed out", "TimeoutError"),
        signal: new AbortController().signal,
        timeoutSignal: timeoutController.signal,
      }),
      "source_request_timeout",
    );

    assert.equal(
      classifyAbortCause({
        error: new DOMException(
          "signal is aborted without reason",
          "AbortError",
        ),
        signal: new AbortController().signal,
      }),
      "unknown",
    );

    assert.equal(
      classifyAbortCause({
        error: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
        signal: new AbortController().signal,
      }),
      undefined,
    );
  });

  void it("classifies media timeout, unreasoned AbortError, and user cancellation in article-archive helpers", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/slow.png") {
        // Leave open until client aborts.
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from("png"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const slowUrl = `http://127.0.0.1:${String(address.port)}/slow.png`;

    try {
      await assert.rejects(
        () =>
          fetchValidatedMedia(
            { kind: "inline-image", url: slowUrl },
            new AbortController().signal,
            { timeoutMs: 30 },
          ),
        (error: unknown) => {
          assert.ok(error instanceof MediaFetchError);
          assert.equal(error.abortCause, "source_request_timeout");
          assert.equal(error.target, slowUrl);
          return true;
        },
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new DOMException(
          "signal is aborted without reason",
          "AbortError",
        );
      };
      try {
        await assert.rejects(
          () =>
            fetchValidatedMedia(
              { kind: "inline-image", url: slowUrl },
              new AbortController().signal,
            ),
          (error: unknown) => {
            assert.ok(error instanceof MediaFetchError);
            assert.equal(error.abortCause, "unknown");
            assert.equal(error.target, slowUrl);
            return true;
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }

      const cancelController = new AbortController();
      const cleaned = cleanContent(`<p><img src="${slowUrl}" alt="slow"></p>`, {
        format: "html",
        baseUrl: `http://127.0.0.1:${String(address.port)}/`,
      });
      setTimeout(
        () => cancelController.abort(createActionCancelledReason()),
        20,
      );
      await assert.rejects(
        () =>
          uploadCleanedMedia(
            {
              signal: cancelController.signal,
              resources: {
                upload: async () => {
                  throw new Error("should not upload");
                },
                resolve: async () => ({
                  resources: [],
                  items: [],
                  mediaByUrl: {},
                }),
              },
            },
            cleaned,
            { timeoutMs: 5_000 },
          ),
        (error: unknown) => isActionCancelledReason(error),
      );
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  void it("classifies timeout, unknown abort, and user cancellation in fetchSourceResponse", async () => {
    const server = createServer((_req, _res) => {
      // Leave open to trigger timeout / cancellation.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const slowUrl = `http://127.0.0.1:${String(address.port)}/slow`;

    try {
      await assert.rejects(
        () =>
          fetchSourceResponse({
            url: slowUrl,
            signal: new AbortController().signal,
            stage: "fetching-feed",
            timeoutMs: 30,
          }),
        (error: unknown) => {
          assert.ok(error instanceof SourceRequestError);
          const diag = readFailureDiagnosticContext(error);
          assert.equal(diag.stage, "fetching-feed");
          assert.equal(diag.target, slowUrl);
          assert.equal(diag.abortCause, "source_request_timeout");
          return true;
        },
      );

      const controller = new AbortController();
      setTimeout(() => controller.abort(createActionCancelledReason()), 20);
      await assert.rejects(
        () =>
          fetchSourceResponse({
            url: slowUrl,
            signal: controller.signal,
            stage: "fetching-feed",
            timeoutMs: 5_000,
          }),
        (error: unknown) => isActionCancelledReason(error),
      );
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
});
