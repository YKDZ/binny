import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceTimeSchema } from "@binny/contracts";

void test("source time keeps its declared precision and known time zone", () => {
  const values = [
    {
      precision: "instant",
      value: "2026-05-17T09:30:00+08:00",
      timeZone: "Asia/Shanghai",
    },
    {
      precision: "day",
      value: "2026-05-17",
      timeZone: "Asia/Shanghai",
    },
    { precision: "month", value: "2026-05" },
    { precision: "year", value: "2026" },
  ] as const;

  for (const value of values) {
    assert.deepEqual(sourceTimeSchema.parse(value), value);
  }
});

void test("source time rejects invalid dates and inconsistent zones", () => {
  const invalidValues = [
    { precision: "instant", value: "2026-02-30T09:30:00Z" },
    { precision: "day", value: "2026-02-30" },
    { precision: "month", value: "2026-13" },
    { precision: "year", value: "2026-05-17" },
    { precision: "instant", value: "2026-05-17T09:30:00" },
    {
      precision: "instant",
      value: "2026-05-17T09:30:00+08:00",
      timeZone: "America/Los_Angeles",
    },
    { precision: "instant", value: "2026-11-09T12:00:00Z", timeZone: "+08:00" },
    { precision: "day", value: "2026-05-17", timeZone: "Mars/Olympus" },
  ];

  for (const value of invalidValues) {
    assert.equal(sourceTimeSchema.safeParse(value).success, false);
  }
});
