import assert from "node:assert/strict";
import test from "node:test";

import { archiveJsonStringifyByteLength } from "./archive-json-size.ts";

const assertActive = () => undefined;
const values: readonly unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1e21,
  Number.MIN_VALUE,
  1.25,
  'quotes: " and slash: \\ and controls: \b\t\n\f\r\u001f',
  "中文与 emoji 🙂 plus a line separator \u2028",
  ["array", 1e-7, { enabled: true, values: [null, "nested"] }],
  {
    revisionId: "2c4d9976-10aa-4206-9bbf-8b7c8ed95769",
    state: {
      title: "Optional sourceRef is absent.",
      extensions: { source: "fixture", flags: [true, false] },
      body: { text: "Complete stored body." },
      capture: { completeness: "complete", missing: [], scope: {} },
    },
  },
];

void test("measures compact JSON bytes exactly at and above the limit", () => {
  for (const value of values) {
    const serialized = JSON.stringify(value);
    assert.notEqual(serialized, undefined);
    const expectedBytes = Buffer.byteLength(serialized, "utf8");
    assert.equal(
      archiveJsonStringifyByteLength(value, expectedBytes, assertActive),
      expectedBytes,
    );
    assert.equal(
      archiveJsonStringifyByteLength(value, expectedBytes - 1, assertActive),
      undefined,
    );
  }
});
