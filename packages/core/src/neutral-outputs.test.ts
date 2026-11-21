import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveBatchReadInputDiagnostic,
  archiveBatchReadInputSchema,
  archiveBatchReadMaxReferences,
} from "@binny/contracts";
import type { CancellableQueryExecutor, Database } from "@binny/db";

import { createArchiveBatchReadOperation } from "./archive-batch-read.ts";
import type { ArchiveResourceStorage } from "./archive-resource-storage.ts";
import {
  parseStoredManualRunFailure,
  safeParseStoredManualRunFailure,
} from "./manual-run-fencing.ts";

void describe("neutral output contracts and legacy persistence", () => {
  void it("strips legacy suggestion keys when parsing stored manual run failures", () => {
    const legacyFailure = {
      code: "discourse_login_required",
      message: "Persistent browser profile is not authenticated.",
      impact: "Protected categories were not read.",
      suggestion: "使用 human open 登录后重试。",
      requiresHuman: true,
      sessionState: "unauthenticated",
      stage: "checking-session",
      target: "https://linux.do/session/current.json",
    };

    const parsed = parseStoredManualRunFailure(legacyFailure);
    assert.equal("suggestion" in parsed, false);
    assert.equal(parsed.code, "discourse_login_required");
    assert.equal(parsed.requiresHuman, true);
    assert.equal(parsed.sessionState, "unauthenticated");

    const safe = safeParseStoredManualRunFailure(legacyFailure);
    assert.equal(safe.success, true);
    if (safe.success) {
      assert.equal("suggestion" in safe.data, false);
    }
  });

  void it("returns bounded maxReferences diagnostic facts when batch-read exceeds 50 references", async () => {
    const ref = {
      itemId: "650e8400-e29b-41d4-a716-446655440000",
      binId: "rss-main",
      revisionId: "750e8400-e29b-41d4-a716-446655440000",
      archiveSeq: "12",
    };
    const overLimitRequest = {
      references: Array.from(
        { length: archiveBatchReadMaxReferences + 1 },
        () => ref,
      ),
    };
    const checked = archiveBatchReadInputSchema.safeParse(overLimitRequest);
    assert.equal(checked.success, false);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      assert.equal(
        issue?.message,
        `Batch read accepts at most ${String(archiveBatchReadMaxReferences)} references per request.`,
      );
      assert.deepEqual(
        archiveBatchReadInputDiagnostic(overLimitRequest, issue),
        {
          maxReferences: archiveBatchReadMaxReferences,
          requestedReferences: archiveBatchReadMaxReferences + 1,
        },
      );
    }

    const op = createArchiveBatchReadOperation(
      {} as Database,
      {} as ArchiveResourceStorage,
      (async () => []) as unknown as CancellableQueryExecutor,
    );
    const result = await op.readArchiveBatch(overLimitRequest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.error.code, "invalid_input");
      assert.deepEqual(result.error.path, ["references"]);
      assert.equal(
        result.error.message,
        `Batch read accepts at most ${String(archiveBatchReadMaxReferences)} references per request.`,
      );
      assert.deepEqual(result.error.diagnostic, {
        maxReferences: archiveBatchReadMaxReferences,
        requestedReferences: archiveBatchReadMaxReferences + 1,
      });
    }
  });
});
