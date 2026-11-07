import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceAdapter } from "../src/index.ts";

await test("mistral adapter exports manifest id", () => {
  assert.equal(sourceAdapter.id, "mistral");
});
