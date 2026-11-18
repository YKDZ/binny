import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { ManualRunCompletion } from "@binny/contracts";
import { isActionCancelledReason } from "@binny/source-adapter-sdk";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workerEntry = path.join(packageRoot, "src/worker.ts");
const fixtureAdapter = path.join(
  packageRoot,
  "test/fixtures/diagnostics-source-adapter.ts",
);

async function runWorkerScenario(
  mode: "wait-cancel" | "budget-exceeded" | "request-timeout" | "unknown-abort",
): Promise<ManualRunCompletion> {
  return await new Promise((resolve, reject) => {
    const child = fork(workerEntry, [], {
      cwd: packageRoot,
      execArgv: ["--conditions=source"],
      env: {
        ...process.env,
        BINNY_API_URL: "http://127.0.0.1:1",
        BINNY_RUNTIME_ID: "test-runtime",
        BINNY_SOURCE_ADAPTER_ENTRY: fixtureAdapter,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let completion: ManualRunCompletion | undefined;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("message", (raw: unknown) => {
      const message =
        typeof raw === "string"
          ? (JSON.parse(raw) as {
              type?: string;
              completion?: ManualRunCompletion;
            })
          : (raw as { type?: string; completion?: ManualRunCompletion });
      if (message.type === "ready") {
        child.send(
          JSON.stringify({
            type: "execute",
            runtimeId: "test-runtime",
            ownerGeneration: "1",
            run: {
              runId: randomUUID(),
              binId: "test-bin",
              identityId: "test-identity",
              sourceAdapterId: "test.worker-diagnostics",
              sourceAdapterVersion: "1.0.0",
              action: "collect",
              params: { mode },
              config: {},
              referenceTime: "2026-11-18T00:00:00.000Z",
            },
          }),
        );
        if (mode === "wait-cancel") {
          setTimeout(() => {
            child.kill("SIGTERM");
          }, 50);
        }
        return;
      }
      if (message.type === "completion") {
        completion = message.completion;
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (completion !== undefined) {
        resolve(completion);
      } else {
        reject(
          new Error(
            `Worker exited (${String(code)}) without completion: ${stderr}`,
          ),
        );
      }
    });
  });
}

void describe("worker abort diagnostics and SIGTERM cancellation evidence", () => {
  void it("attaches explicit cancellation reason on SIGTERM and preserves stage and target", async () => {
    assert.equal(isActionCancelledReason(undefined), false);
    const completion = await runWorkerScenario("wait-cancel");
    assert.equal(completion.status, "failed");
    assert.equal(completion.error.stage, "fetching-index");
    assert.equal(completion.error.target, "https://example.test/index.json");
    assert.equal(completion.error.abortCause, "user_cancelled");
  });

  void it("preserves action_budget_exhausted, source_request_timeout, and unknown abort causes", async () => {
    const budget = await runWorkerScenario("budget-exceeded");
    assert.equal(budget.status, "failed");
    assert.equal(budget.error.stage, "scanning-post-feed");
    assert.equal(budget.error.target, "https://example.test/posts.json");
    assert.equal(budget.error.abortCause, "action_budget_exhausted");

    const timeout = await runWorkerScenario("request-timeout");
    assert.equal(timeout.status, "failed");
    assert.equal(timeout.error.stage, "fetching-index");
    assert.equal(timeout.error.target, "https://example.test/llms.txt");
    assert.equal(timeout.error.abortCause, "source_request_timeout");

    const unknown = await runWorkerScenario("unknown-abort");
    assert.equal(unknown.status, "failed");
    assert.equal(unknown.error.stage, "reading-topic");
    assert.equal(unknown.error.target, "https://example.test/t/42.json");
    assert.equal(unknown.error.abortCause, "unknown");
  });
});
