import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { BrowserLifecycle } from "../src/browser-lifecycle.ts";

void describe("browser profile owner lock", () => {
  void it("acquires exclusive .binny-runtime-owner.lock, blocks contenders, and releases on close", async () => {
    const profileDirectory = await mkdtemp(
      path.join(tmpdir(), "binny-browser-lock-"),
    );
    const first = new BrowserLifecycle({
      apiUrl: "http://127.0.0.1:3000",
      binId: "bin-one",
      runtimeId: "rt-1",
      ownerGeneration: "1",
      profileDirectory,
      onPowerChange: () => undefined,
    });
    const contender = new BrowserLifecycle({
      apiUrl: "http://127.0.0.1:3000",
      binId: "bin-one",
      runtimeId: "rt-2",
      ownerGeneration: "2",
      profileDirectory,
      onPowerChange: () => undefined,
    });

    try {
      await first.acquireOwnerLock();

      await assert.rejects(() => contender.acquireOwnerLock(), {
        code: "browser_owner_lock_conflict",
      });

      await first.close();
      await contender.acquireOwnerLock();
    } finally {
      await contender.close().catch(() => undefined);
      await first.close().catch(() => undefined);
      await rm(profileDirectory, { recursive: true, force: true });
    }
  });
});
