import assert from "node:assert/strict";
import { test } from "node:test";

import { runJourneys } from "./run-journeys.ts";

void test("runs all source CLI journeys", { timeout: 180_000 }, async () => {
  const passed = await runJourneys({ mode: "source" });
  assert.notStrictEqual(passed.length, 0);
});
