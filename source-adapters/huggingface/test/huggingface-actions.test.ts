import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceAdapter } from "../src/index.ts";

await test("huggingface adapter exports manifest id", () => {
  assert.equal(sourceAdapter.id, "huggingface");
});
