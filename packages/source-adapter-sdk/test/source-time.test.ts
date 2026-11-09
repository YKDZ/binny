import assert from "node:assert/strict";
import test from "node:test";

import { sourceTimeFrom } from "../src/source-time.ts";

void test("source time parsing keeps precision and the source offset", () => {
  assert.deepEqual(sourceTimeFrom("2026-11-08T12:00:00+08:00"), {
    precision: "instant",
    value: "2026-11-08T12:00:00+08:00",
  });
  assert.deepEqual(sourceTimeFrom("2026-11-08"), {
    precision: "day",
    value: "2026-11-08",
  });
  assert.deepEqual(sourceTimeFrom("2026-11"), {
    precision: "month",
    value: "2026-11",
  });
  assert.deepEqual(sourceTimeFrom("2026"), {
    precision: "year",
    value: "2026",
  });
});

void test("source time parsing converts zoned feed dates without inventing a zone", () => {
  assert.deepEqual(sourceTimeFrom("Thu, 29 Oct 2026 12:00:07 GMT"), {
    precision: "instant",
    value: "2026-10-29T12:00:07Z",
    timeZone: "UTC",
  });
  assert.deepEqual(sourceTimeFrom("Thu, 29 Oct 2026 12:00:07 +0200"), {
    precision: "instant",
    value: "2026-10-29T12:00:07+02:00",
  });
  assert.deepEqual(sourceTimeFrom("Oct 29, 2026"), {
    precision: "day",
    value: "2026-10-29",
  });
  assert.deepEqual(sourceTimeFrom("October 2026"), {
    precision: "month",
    value: "2026-10",
  });
  assert.equal(sourceTimeFrom("Thu, 29 Oct 2026 12:00:07"), null);
});

void test("source time parsing rejects invalid source values", () => {
  assert.equal(sourceTimeFrom("2026-13-01"), null);
  assert.equal(sourceTimeFrom("2026-02-30"), null);
  assert.equal(sourceTimeFrom("2026-11-08T12:00:00"), null);
  assert.equal(sourceTimeFrom(undefined), null);
});
