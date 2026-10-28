import assert from "node:assert/strict";
import { test } from "node:test";

import {
  archiveCommitSchema,
  archiveItemInputSchema,
  archiveItemReadSchema,
  archiveItemStateSchema,
  archiveSubmissionInputSchema,
} from "../src/archive.ts";

void test("条目必须声明稳定信源键并包含已取得资料", () => {
  const item = {
    sourceKey: { namespace: "forum.example", key: "topic/42" },
    sourceRef: "https://forum.example/t/42",
    body: { markdown: "正文", searchText: "正文" },
    capture: {
      scope: { kind: "topic", id: "42" },
      completeness: "complete",
      missing: [],
    },
  } as const;

  assert.deepEqual(archiveItemInputSchema.parse(item).sourceKey, {
    namespace: "forum.example",
    key: "topic/42",
  });
  assert.equal(
    archiveItemInputSchema.safeParse({
      ...item,
      sourceKey: { namespace: "forum.example" },
    }).success,
    false,
  );
  assert.equal(
    archiveItemInputSchema.safeParse({
      sourceKey: item.sourceKey,
      capture: item.capture,
    }).success,
    false,
  );
  assert.equal(
    archiveItemInputSchema.safeParse({
      sourceKey: item.sourceKey,
      sourceRef: item.sourceRef,
      capture: item.capture,
    }).success,
    false,
  );
  assert.equal(
    archiveItemInputSchema.safeParse({
      ...item,
      diagnostics: [
        {
          code: "optional_section_missing",
          message: "可选来源说明暂不可用。",
          suggestion: "稍后重新采集。",
        },
      ],
    }).success,
    true,
  );
});

void test("部分采集必须说明缺失字段且 JSON 整数保持精确", () => {
  const partial = {
    sourceKey: { namespace: "forum.example", key: "topic/43" },
    properties: { published: null },
    capture: {
      scope: { kind: "topic", id: "43" },
      completeness: "partial",
      missing: [{ path: "body.markdown", reason: "源站未提供正文" }],
    },
  } as const;

  assert.equal(archiveItemInputSchema.safeParse(partial).success, true);
  assert.equal(
    archiveItemInputSchema.safeParse({
      ...partial,
      capture: { ...partial.capture, missing: [] },
    }).success,
    false,
  );
  assert.equal(
    archiveItemInputSchema.safeParse({
      ...partial,
      properties: { count: Number.MAX_SAFE_INTEGER + 1 },
    }).success,
    false,
  );
  assert.equal(
    archiveItemInputSchema.parse(partial).properties?.published,
    null,
  );
});

void test("提交必须声明请求标识且同批信源键不能重复", () => {
  const item = {
    sourceKey: { namespace: "feed.example", key: "entry/7" },
    metadata: { title: "一条资料" },
    capture: { scope: { feed: "main" }, completeness: "complete", missing: [] },
  } as const;
  const submission = {
    requestId: "client-a:request-17",
    binId: "feeds-main",
    observedAt: "2026-10-28T12:30:00+08:00",
    items: [item],
  } as const;

  assert.equal(
    archiveSubmissionInputSchema.safeParse(submission).success,
    true,
  );
  assert.equal(
    archiveSubmissionInputSchema.safeParse({
      ...submission,
      items: [item, { ...item, metadata: { title: "另一个版本" } }],
    }).success,
    false,
  );
  assert.equal(
    archiveSubmissionInputSchema.safeParse({
      ...submission,
      binId: "not a valid bin",
    }).success,
    false,
  );
  assert.equal(
    archiveSubmissionInputSchema.safeParse({
      ...submission,
      requestId: "   ",
    }).success,
    false,
  );
});

void test("版本状态区分缺省来源时间与 JSON null", () => {
  const state = {
    sourceRef: "https://feed.example/items/7",
    metadata: { title: "一条资料", author: null },
    properties: { rank: 1.5 },
    body: { html: "<p>正文</p>", markdown: "正文", searchText: "正文" },
    capture: {
      scope: { feed: "main" },
      completeness: "complete",
      missing: [],
    },
  } as const;

  assert.equal(archiveItemStateSchema.parse(state).sourceModifiedAt, undefined);
  assert.equal(archiveItemStateSchema.parse(state).metadata?.author, null);
  assert.equal(
    archiveItemStateSchema.safeParse({ ...state, sourceModifiedAt: null })
      .success,
    false,
  );
  assert.equal(
    archiveItemInputSchema.parse({
      ...state,
      sourceKey: { namespace: "feed.example", key: "entry/7" },
      sourceModifiedAt: "2026-10-28T12:30:00+08:00",
    }).sourceModifiedAt,
    "2026-10-28T04:30:00.000Z",
  );
});

void test("归档提交和条目读取保留大序号、来源视图与观察记录", () => {
  const commit = archiveCommitSchema.parse({
    commitId: "550e8400-e29b-41d4-a716-446655440000",
    archiveSeq: "9007199254740993",
    binId: "rss-main",
    observedAt: "2026-10-28T04:30:00.000Z",
    recordedAt: "2026-10-28T04:30:01.000Z",
    items: [
      {
        itemId: "650e8400-e29b-41d4-a716-446655440000",
        revisionId: "750e8400-e29b-41d4-a716-446655440000",
        sourceKey: { namespace: "feed.example", key: "entry/7" },
      },
    ],
  });
  const item = archiveItemReadSchema.parse({
    itemId: "650e8400-e29b-41d4-a716-446655440000",
    sourceKey: { namespace: "feed.example", key: "entry/7" },
    views: [
      {
        binId: "rss-main",
        archiveSeq: commit.archiveSeq,
        revisionId: "750e8400-e29b-41d4-a716-446655440000",
        observedAt: commit.observedAt,
        recordedAt: commit.recordedAt,
        state: {
          body: { text: "正文" },
          capture: {
            scope: { feed: "main" },
            completeness: "complete",
            missing: [],
          },
        },
      },
    ],
    revisions: [
      {
        revisionId: "750e8400-e29b-41d4-a716-446655440000",
        stateHash: "a".repeat(64),
      },
    ],
    observations: [
      {
        commitId: commit.commitId,
        archiveSeq: commit.archiveSeq,
        binId: "rss-main",
        revisionId: "750e8400-e29b-41d4-a716-446655440000",
        observedAt: commit.observedAt,
        recordedAt: commit.recordedAt,
      },
    ],
  });

  assert.equal(commit.archiveSeq, "9007199254740993");
  assert.equal(item.views[0]?.state.body?.text, "正文");
  assert.equal(item.observations[0]?.commitId, commit.commitId);
});
