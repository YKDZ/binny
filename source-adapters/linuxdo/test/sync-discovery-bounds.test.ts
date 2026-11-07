import assert from "node:assert/strict";
import test from "node:test";

import type { SourceAdapterContext } from "@binny/source-adapter-sdk";
import type { Page } from "patchright-core";

import {
  assignSyncPosition,
  bindPageSourceAccessForTest,
  computeSyncScopeCandidateLowerBound,
  scanPostCreatedRange,
  syncScopePlans,
  type DiscoursePost,
  type PostRangeReadCache,
  type SyncPersistentState,
} from "../src/source-adapter.ts";

const siteOrigin = new URL("https://linux.do");

function createMockPage(
  feedPages: Map<string, DiscoursePost[]>,
  onRequest?: (url: string) => void,
): Page {
  const page = {
    url() {
      return "https://linux.do";
    },
    isClosed() {
      return false;
    },
    async evaluate(_fn: unknown, arg: unknown) {
      if (arg && typeof arg === "object" && "href" in arg) {
        const fetchArg = arg as { href: string; bodyType: "text" | "base64" };
        const url = new URL(fetchArg.href);
        onRequest?.(url.href);
        const before = url.searchParams.get("before");
        const key = before ?? "initial";
        const posts = feedPages.get(key) ?? [];
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ latest_posts: posts }),
          bodyType: fetchArg.bodyType,
        };
      }
      return {};
    },
  } as unknown as Page;
  bindPageSourceAccessForTest(page, "https://linux.do");
  return page;
}

void test("1. sync initializes position without lower bound, establishes bound on full scan, and next run converges in 1 downward page + 1 head page", async () => {
  const mockContext = {
    binId: "bin-1",
    identityId: "identity-1",
    runId: "run-1",
  } as unknown as SourceAdapterContext;

  const target = {
    id: "category-42",
    kind: "category" as const,
    categoryId: 42,
    categorySlugPath: "test",
  };

  // Step 1: Initial sync (mode: "initialized")
  let state: SyncPersistentState = {
    version: 1 as const,
    scopes: [],
  };
  const u1 = "2026-10-28T02:00:00.000Z";
  const initialPlans = syncScopePlans(
    mockContext,
    siteOrigin,
    [target],
    state,
    u1,
  );
  assert.equal(initialPlans.length, 1);
  const initialPlan = initialPlans[0]!;
  assert.equal(initialPlan.mode, "initialized");
  assert.equal(initialPlan.confirmedPostIdLowerBound, undefined);
  assert.equal(initialPlan.previousConfirmedPostIdLowerBound, undefined);

  state = assignSyncPosition(state, initialPlan, "run-1");
  assert.equal(state.scopes.length, 1);
  assert.equal(state.scopes[0]?.confirmedPostIdLowerBound, undefined);

  // Step 2: Second sync (scans to end of history and establishes confirmedPostIdLowerBound)
  const u2 = "2026-10-28T03:00:00.000Z";
  const secondPlans = syncScopePlans(
    mockContext,
    siteOrigin,
    [target],
    state,
    u2,
  );
  assert.equal(secondPlans.length, 1);
  const secondPlan = secondPlans[0]!;
  assert.equal(secondPlan.mode, "continued");
  assert.equal(secondPlan.previousConfirmedPostIdLowerBound, undefined);

  const feedRound2 = new Map<string, DiscoursePost[]>([
    [
      "initial",
      [
        {
          id: 250,
          topic_id: 10,
          post_number: 1,
          created_at: "2026-10-28T02:30:00.000Z",
        },
        {
          id: 200,
          topic_id: 10,
          post_number: 2,
          created_at: "2026-10-28T02:15:00.000Z",
        },
      ],
    ],
    [
      "200",
      [
        {
          id: 150,
          topic_id: 10,
          post_number: 3,
          created_at: "2026-10-28T01:45:00.000Z",
        },
      ],
    ],
    ["150", []],
  ]);

  const requestsRound2: string[] = [];
  const pageRound2 = createMockPage(feedRound2, (url) =>
    requestsRound2.push(url),
  );
  const readCacheRound2: PostRangeReadCache = {
    downwardPages: new Map(),
    topics: new Map(),
  };

  const scanRound2 = await scanPostCreatedRange(
    pageRound2,
    siteOrigin,
    new AbortController().signal,
    20,
    readCacheRound2,
    secondPlan.previousConfirmedPostIdLowerBound,
  );

  assert.equal(scanRound2.complete, true);
  // Round 2 requests: initial page, before=200, before=150 (empty), head page
  assert.equal(requestsRound2.length, 4);

  const candidateBoundRound2 = computeSyncScopeCandidateLowerBound(
    scanRound2.posts,
    Date.parse(secondPlan.range!.to),
  );
  assert.equal(candidateBoundRound2, 250);

  // Update state with advanced position and established confirmedPostIdLowerBound: 250
  state = assignSyncPosition(
    state,
    { ...secondPlan, confirmedPostIdLowerBound: candidateBoundRound2 },
    "run-2",
  );
  assert.equal(state.scopes[0]?.confirmedPostIdLowerBound, 250);
  assert.equal(state.scopes[0]?.position, u2);

  // Step 3: Third sync (incremental with confirmedPostIdLowerBound = 250)
  const u3 = "2026-10-28T04:00:00.000Z";
  const thirdPlans = syncScopePlans(
    mockContext,
    siteOrigin,
    [target],
    state,
    u3,
  );
  assert.equal(thirdPlans.length, 1);
  const thirdPlan = thirdPlans[0]!;
  assert.equal(thirdPlan.mode, "continued");
  assert.equal(thirdPlan.previousConfirmedPostIdLowerBound, 250);

  // New posts in source:
  // initial page contains post 350 (new) and post 250 (already <= confirmedPostIdLowerBound)
  const feedRound3 = new Map<string, DiscoursePost[]>([
    [
      "initial",
      [
        {
          id: 350,
          topic_id: 10,
          post_number: 4,
          created_at: "2026-10-28T03:30:00.000Z",
        },
        {
          id: 250,
          topic_id: 10,
          post_number: 1,
          created_at: "2026-10-28T02:30:00.000Z",
        },
      ],
    ],
    [
      "250",
      [
        {
          id: 200,
          topic_id: 10,
          post_number: 2,
          created_at: "2026-10-28T02:15:00.000Z",
        },
      ],
    ],
  ]);

  const requestsRound3: string[] = [];
  const pageRound3 = createMockPage(feedRound3, (url) =>
    requestsRound3.push(url),
  );
  const readCacheRound3: PostRangeReadCache = {
    downwardPages: new Map(),
    topics: new Map(),
  };

  const scanRound3 = await scanPostCreatedRange(
    pageRound3,
    siteOrigin,
    new AbortController().signal,
    20,
    readCacheRound3,
    thirdPlan.previousConfirmedPostIdLowerBound,
  );

  assert.equal(scanRound3.complete, true);
  // Downward pagination stopped immediately at post 250 on first page, then head page verified!
  // Exactly 2 requests: 1 downward page + 1 head page!
  assert.equal(requestsRound3.length, 2);
  assert.equal(
    requestsRound3.filter((url) => !url.includes("before=")).length,
    2,
    "Exactly 1 initial page and 1 head page requested without deeper before= pagination",
  );

  const candidateBoundRound3 = computeSyncScopeCandidateLowerBound(
    scanRound3.posts,
    Date.parse(thirdPlan.range!.to),
  );
  assert.equal(candidateBoundRound3, 350);
});

void test("2. confirmedPostIdLowerBound never crosses a post with created_at >= U (deferred to next window)", () => {
  const u = "2026-10-28T03:00:00.000Z";
  const endExclusiveMs = Date.parse(u);

  // Scenario A: Post 500 created at 03:05 (>= U, deferred), Post 505 created at 02:50 (< U, higher ID than 500)
  const postsWithAnomaly: DiscoursePost[] = [
    {
      id: 505,
      topic_id: 10,
      post_number: 3,
      created_at: "2026-10-28T02:50:00.000Z",
    },
    {
      id: 500,
      topic_id: 10,
      post_number: 2,
      created_at: "2026-10-28T03:05:00.000Z", // >= U
    },
    {
      id: 490,
      topic_id: 10,
      post_number: 1,
      created_at: "2026-10-28T02:40:00.000Z",
    },
  ];

  const boundA = computeSyncScopeCandidateLowerBound(
    postsWithAnomaly,
    endExclusiveMs,
  );
  // Bound must be 490, strictly less than minDeferredPostId (500)!
  // Post 505 is excluded because setting bound to 505 would bypass post 500 on next sync.
  assert.equal(boundA, 490);
  assert.ok(boundA < 500);

  // Scenario B: Post with invalid created_at is also treated as deferred
  const postsWithInvalidDate: DiscoursePost[] = [
    {
      id: 480,
      topic_id: 10,
      post_number: 2,
      created_at: "not-a-valid-date",
    },
    {
      id: 450,
      topic_id: 10,
      post_number: 1,
      created_at: "2026-10-28T02:30:00.000Z",
    },
  ];

  const boundB = computeSyncScopeCandidateLowerBound(
    postsWithInvalidDate,
    endExclusiveMs,
  );
  assert.equal(boundB, 450);
  assert.ok(boundB < 480);
});

void test("3. Independent bounds across multiple scopes and interrupted/unstarted scope preserves its own bound", () => {
  const mockContext = {
    binId: "bin-1",
    identityId: "identity-1",
    runId: "run-2",
  } as unknown as SourceAdapterContext;

  const categoryTarget = {
    id: "category-42",
    kind: "category" as const,
    categoryId: 42,
    categorySlugPath: "test-cat",
  };

  const topicTarget = {
    id: "topic-100",
    kind: "topic" as const,
    topicId: 100,
  };

  let state: SyncPersistentState = {
    version: 1 as const,
    scopes: [
      {
        binId: "bin-1",
        identityId: "identity-1",
        origin: "https://linux.do",
        scope: { kind: "category" as const, id: 42 },
        position: "2026-10-28T02:00:00.000Z",
        confirmedPostIdLowerBound: 200,
        lastRunId: "run-1",
      },
      {
        binId: "bin-1",
        identityId: "identity-1",
        origin: "https://linux.do",
        scope: { kind: "topic" as const, id: 100 },
        position: "2026-10-28T02:00:00.000Z",
        confirmedPostIdLowerBound: 150,
        lastRunId: "run-1",
      },
    ],
  };

  const u = "2026-10-28T03:00:00.000Z";
  const plans = syncScopePlans(
    mockContext,
    siteOrigin,
    [categoryTarget, topicTarget],
    state,
    u,
  );

  const planCategory = plans.find((p) => p.target.kind === "category")!;
  const planTopic = plans.find((p) => p.target.kind === "topic")!;

  assert.equal(planCategory.previousConfirmedPostIdLowerBound, 200);
  assert.equal(planTopic.previousConfirmedPostIdLowerBound, 150);

  // Scope 1 (category) completes and advances its bound to 300
  const advancedCategoryPlan = {
    ...planCategory,
    confirmedPostIdLowerBound: 300,
  };
  state = assignSyncPosition(state, advancedCategoryPlan, "run-2");

  // Scope 2 (topic) is interrupted before scanning completes:
  // assignSyncPosition preserves planTopic.previousConfirmedPostIdLowerBound
  state = assignSyncPosition(state, planTopic, "run-2");

  const finalCategoryScope = state.scopes.find(
    (s) => s.scope.kind === "category" && s.scope.id === 42,
  );
  const finalTopicScope = state.scopes.find(
    (s) => s.scope.kind === "topic" && s.scope.id === 100,
  );

  assert.equal(finalCategoryScope?.confirmedPostIdLowerBound, 300);
  assert.equal(
    finalTopicScope?.confirmedPostIdLowerBound,
    150,
    "Interrupted scope preserved its previous bound without being overwritten by other scopes",
  );
});

void test("4. Ordinary collect without confirmedPostIdLowerBound retains conservative completeness check", async () => {
  const feedPages = new Map<string, DiscoursePost[]>([
    [
      "initial",
      [
        {
          id: 50,
          topic_id: 1,
          post_number: 1,
          created_at: "2026-10-28T02:00:00.000Z",
        },
      ],
    ],
    // Only 1 page available, maxPages = 2. Deeper page is not reached because maxPages limit hits before empty page.
  ]);

  const page = createMockPage(feedPages);

  // When maxPages is reached before seeing an empty page (nextPage.length === 0),
  // scan without confirmedPostIdLowerBound must report incomplete.
  const scanPartial = await scanPostCreatedRange(
    page,
    siteOrigin,
    new AbortController().signal,
    2, // maxPages = 2 (first page read, downward loop stops at maxPages - 1 = 1)
    undefined,
    undefined, // No confirmedPostIdLowerBound
  );

  assert.equal(scanPartial.complete, false);
  assert.equal(scanPartial.issue?.reasonCode, "post_range_page_limit_reached");

  // When pagination fully exhausts history (empty page seen), it completes.
  const feedExhausted = new Map<string, DiscoursePost[]>([
    [
      "initial",
      [
        {
          id: 50,
          topic_id: 1,
          post_number: 1,
          created_at: "2026-10-28T02:00:00.000Z",
        },
      ],
    ],
    ["50", []], // History exhausted
  ]);
  const pageExhausted = createMockPage(feedExhausted);
  const scanComplete = await scanPostCreatedRange(
    pageExhausted,
    siteOrigin,
    new AbortController().signal,
    5,
    undefined,
    undefined,
  );

  assert.equal(scanComplete.complete, true);
  assert.equal(scanComplete.issue, undefined);
});
