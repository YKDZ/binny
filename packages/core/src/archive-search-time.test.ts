import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveSearchInputDiagnostic,
  archiveSearchInputIssue,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
  toArchiveJsonSchema,
} from "@binny/contracts";

function parseIssue(input: unknown) {
  const checked = archiveSearchInputSchema.safeParse(input);
  assert.equal(checked.success, false, "Expected search input to fail.");
  const issue = archiveSearchInputIssue(input, checked.error.issues);
  const diagnostic = archiveSearchInputDiagnostic(input, issue);
  return {
    path: issue?.path,
    message: issue?.message,
    diagnostic,
  };
}

void describe("archive search precise offset time windows", () => {
  void it("accepts local calendar windows and explicit-offset instant windows", () => {
    const calendar = archiveSearchInputSchema.parse({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08",
        until: "2026-11-09",
        timeZone: "Asia/Shanghai",
      },
    });
    assert.deepEqual(calendar.timeWindow, {
      field: "sourcePublishedAt",
      from: "2026-11-08",
      until: "2026-11-09",
      timeZone: "Asia/Shanghai",
      review: "certain",
    });

    const offsetWindow = archiveSearchInputSchema.parse({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08T06:00:00+08:00",
        until: "2026-11-08T12:00:00+08:00",
      },
    });
    assert.deepEqual(offsetWindow.timeWindow, {
      field: "sourcePublishedAt",
      from: "2026-11-08T06:00:00+08:00",
      until: "2026-11-08T12:00:00+08:00",
      review: "certain",
    });

    const crossOffset = archiveSearchInputSchema.parse({
      timeWindow: {
        field: "observedAt",
        from: "2026-11-08T06:00:00+08:00",
        until: "2026-11-08T04:00:00Z",
        review: "undetermined",
      },
    });
    assert.equal(crossOffset.timeWindow?.review, "undetermined");

    const microsecondWindow = archiveSearchInputSchema.parse({
      timeWindow: {
        field: "sourceModifiedAt",
        from: "2026-11-08T06:00:00.000001+08:00",
        until: "2026-11-08T06:00:00.000002+08:00",
      },
    });
    assert.equal(
      microsecondWindow.timeWindow?.until,
      "2026-11-08T06:00:00.000002+08:00",
    );
  });

  void it("compares offset instants in UTC and aligns to PostgreSQL microsecond precision", () => {
    const equalInUtc = parseIssue({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08T06:00:00+08:00",
        until: "2026-11-07T22:00:00Z",
      },
    });
    assert.deepEqual(equalInUtc.path, ["timeWindow", "until"]);

    const earlierUntilInUtc = parseIssue({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08T06:00:00+08:00",
        until: "2026-11-07T21:59:59Z",
      },
    });
    assert.deepEqual(earlierUntilInUtc.path, ["timeWindow", "until"]);

    const collapsedSubMicrosecond = parseIssue({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08T06:00:00.0000001+08:00",
        until: "2026-11-08T06:00:00.0000004+08:00",
      },
    });
    assert.deepEqual(collapsedSubMicrosecond.path, ["timeWindow", "until"]);

    const roundedToNextSecond = parseIssue({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08T06:00:00.9999999+08:00",
        until: "2026-11-08T06:00:01+08:00",
      },
    });
    assert.deepEqual(roundedToNextSecond.path, ["timeWindow", "until"]);
  });

  void it("reports branch-accurate paths and allowedValues for invalid timeWindow inputs", () => {
    const missingOffset = parseIssue({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08T06:00:00",
        until: "2026-11-08T12:00:00+08:00",
      },
    });
    assert.deepEqual(missingOffset.path, ["timeWindow", "from"]);

    const extraTimeZone = parseIssue({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08T06:00:00+08:00",
        until: "2026-11-08T12:00:00+08:00",
        timeZone: "Asia/Shanghai",
      },
    });
    assert.deepEqual(extraTimeZone.path, ["timeWindow", "timeZone"]);

    const missingTimeZone = parseIssue({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08",
        until: "2026-11-09",
      },
    });
    assert.deepEqual(missingTimeZone.path, ["timeWindow", "timeZone"]);

    const invalidField = parseIssue({
      timeWindow: {
        field: "createdAt",
        from: "2026-11-08T06:00:00+08:00",
        until: "2026-11-08T12:00:00+08:00",
      },
    });
    assert.deepEqual(invalidField.path, ["timeWindow", "field"]);
    assert.deepEqual(invalidField.diagnostic, {
      allowedValues: ["sourcePublishedAt", "sourceModifiedAt", "observedAt"],
    });

    const invalidReview = parseIssue({
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08T06:00:00+08:00",
        until: "2026-11-08T12:00:00+08:00",
        review: "outside",
      },
    });
    assert.deepEqual(invalidReview.path, ["timeWindow", "review"]);
    assert.deepEqual(invalidReview.diagnostic, {
      allowedValues: ["certain", "undetermined"],
    });
  });

  void it("projects search input and output schemas with both timeWindow forms to JSON Schema", () => {
    const inputSchema = toArchiveJsonSchema(archiveSearchInputSchema, "input");
    const outputSchema = toArchiveJsonSchema(archiveSearchPageSchema, "output");
    assert.ok(JSON.stringify(inputSchema).includes("date-time"));
    assert.ok(JSON.stringify(outputSchema).includes("candidateOrder"));
  });
});
