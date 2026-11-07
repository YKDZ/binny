// Unit tests for Qoder MDX/Markdown preprocessor and cleaner.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { cleanQoderMdx, transformQoderMdx } from "../src/mdx-cleaner.ts";

void describe("Qoder MDX Cleaner", () => {
  void test("extracts <Update> label and description, creates section headings, and populates updates metadata", () => {
    const raw = `
<Update label="2026-10-28" description="v0.2.9">
  - Added new feature A.
  - Fixed issue B.
</Update>

<Update label="2026-10-15">
  - Maintenance update.
</Update>
`;
    const { transformedMarkdown, updates } = transformQoderMdx(raw);

    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0], {
      label: "2026-10-28",
      description: "v0.2.9",
    });
    assert.deepEqual(updates[1], {
      label: "2026-10-15",
    });

    assert.ok(transformedMarkdown.includes("## 2026-10-28 (v0.2.9)"));
    assert.ok(transformedMarkdown.includes("- Added new feature A."));
    assert.ok(transformedMarkdown.includes("## 2026-10-15"));
    assert.ok(transformedMarkdown.includes("- Maintenance update."));
  });

  void test("converts <Card> and <CardGroup> into Markdown list items with title and href", () => {
    const raw = `
<CardGroup cols={2}>
  <Card title="Qoder CN 更新日志" icon="Airplay" href="/product-overview/qoder-update-log">
    查看全新 Qoder CN 的版本更新。
  </Card>
  <Card title="Qoder CLI" href="https://qoder.com/cli">
    Command line tool for developers.
  </Card>
</CardGroup>
`;
    const { transformedMarkdown } = transformQoderMdx(raw);

    assert.ok(
      !transformedMarkdown.includes("<CardGroup") &&
        !transformedMarkdown.includes("</CardGroup>"),
    );
    assert.ok(
      !transformedMarkdown.includes("<Card") &&
        !transformedMarkdown.includes("</Card>"),
    );
    assert.ok(
      transformedMarkdown.includes(
        "- [Qoder CN 更新日志](/product-overview/qoder-update-log): 查看全新 Qoder CN 的版本更新。",
      ),
    );
    assert.ok(
      transformedMarkdown.includes(
        "- [Qoder CLI](https://qoder.com/cli): Command line tool for developers.",
      ),
    );
  });

  void test("converts <Note>, <Warning>, <Info>, <Tip> into Markdown blockquotes", () => {
    const raw = `
<Note>
  This is a critical note for CN users.
</Note>

<Warning>
  Do not use deprecated endpoints.
</Warning>
`;
    const { transformedMarkdown } = transformQoderMdx(raw);

    assert.ok(!transformedMarkdown.includes("<Note>"));
    assert.ok(!transformedMarkdown.includes("<Warning>"));
    assert.ok(
      transformedMarkdown.includes("> This is a critical note for CN users."),
    );
    assert.ok(
      transformedMarkdown.includes("> Do not use deprecated endpoints."),
    );
  });

  void test("converts <Accordion> and <Step> with title into subheadings while preserving FAQ and table content", () => {
    const raw = `
<AccordionGroup>
  <Accordion title="How do I participate?">
    Follow the steps on the pricing page.
    | Plan | Credits |
    | --- | --- |
    | Pro | 2,000 |
  </Accordion>
</AccordionGroup>
`;
    const { transformedMarkdown } = transformQoderMdx(raw);

    assert.ok(
      !transformedMarkdown.includes("<AccordionGroup") &&
        !transformedMarkdown.includes("</AccordionGroup>"),
    );
    assert.ok(
      !transformedMarkdown.includes("<Accordion") &&
        !transformedMarkdown.includes("</Accordion>"),
    );
    assert.ok(transformedMarkdown.includes("### How do I participate?"));
    assert.ok(
      transformedMarkdown.includes("Follow the steps on the pricing page."),
    );
    assert.ok(transformedMarkdown.includes("| Plan | Credits |"));
    assert.ok(transformedMarkdown.includes("| Pro | 2,000 |"));
  });

  void test("strips YAML frontmatter, documentation index prompts, style blocks, and anchor spans", () => {
    const raw = `---
title: "Purchase Offer"
description: "Limited time offer"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.qoder.cn/llms.txt
> Use this file to discover all available pages before exploring further.

# 限时特价活动

<style>
  .banner { color: red; }
</style>

<a id="schedule" style={{ display: "block", scrollMarginTop: "8rem" }} />
{/* #custom-anchor */}

正文规则说明。
`;
    const { transformedMarkdown } = transformQoderMdx(raw);

    assert.ok(!transformedMarkdown.includes("---"));
    assert.ok(!transformedMarkdown.includes("Documentation Index"));
    assert.ok(!transformedMarkdown.includes("Fetch the complete"));
    assert.ok(!transformedMarkdown.includes("<style>"));
    assert.ok(!transformedMarkdown.includes("<a id="));
    assert.ok(!transformedMarkdown.includes("{/*"));
    assert.ok(transformedMarkdown.includes("# 限时特价活动"));
    assert.ok(transformedMarkdown.includes("正文规则说明。"));
  });

  void test("cleanQoderMdx runs cleanContent and extracts media candidates while preserving tables", () => {
    const raw = `
# Event Details

![Event Banner](/images/banner.png)

| Column A | Column B |
| --- | --- |
| Value 1 | Value 2 |
`;
    const { cleanResult, transformedMarkdown } = cleanQoderMdx(raw, {
      baseUrl: "https://docs.qoder.cn/events/offer",
    });

    assert.ok(cleanResult.hasSubstantialContent);
    assert.equal(cleanResult.media.length, 1);
    assert.equal(
      cleanResult.media[0]?.url,
      "https://docs.qoder.cn/images/banner.png",
    );
    assert.ok(cleanResult.markdown.includes("| Column A | Column B |"));
    assert.ok(cleanResult.markdown.includes("| Value 1 | Value 2 |"));
    assert.ok(transformedMarkdown.includes("# Event Details"));
  });
});
