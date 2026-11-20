import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createSourceAccessClient,
  createSourceAccessCoordinator,
  parseSourceAdapterInput,
  sourceAccessConfigSchema,
  type JsonObject,
  type SourceAccessPersistentState,
  type SourceAccessTransport,
} from "@binny/source-adapter-sdk";
import { chromium } from "patchright-core";

import { sourceAdapter } from "../src/source-adapter.ts";

const fixtureScriptPath = fileURLToPath(
  new URL("../scripts/fixtures/source.ts", import.meta.url),
);

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate port.")));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForHttpReady(origin: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/__control/state`);
      if (response.ok) return;
    } catch {
      // Wait for fixture server startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fixture server at ${origin} did not start in time.`);
}

async function startLinuxdoFixtureProcess() {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--conditions=source", fixtureScriptPath],
    {
      env: { ...process.env, BINNY_DISCOVERY_SOURCE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHttpReady(origin);
    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=binny-discovery-user&password=linuxdo-fixture",
      redirect: "manual",
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    assert.ok(cookie.length > 0, `Expected login cookie, got: ${stderr}`);

    return {
      origin,
      cookie,
      async updateState(patch: Record<string, unknown>) {
        const res = await fetch(`${origin}/__control/state`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        assert.equal(res.status, 200, await res.text());
      },
      async close() {
        if (!child.killed) {
          child.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 2_000);
          });
        }
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

function createHttpBrowserMock(origin: string, cookie: string) {
  const realFetch = globalThis.fetch;
  const cdpSession = {
    send: async () => ({}),
    detach: async () => undefined,
  };
  const createPage = () => {
    let currentUrl = "about:blank";
    let closed = false;
    const closeController = new AbortController();
    return {
      url: () => currentUrl,
      isClosed: () => closed,
      on: () => undefined,
      close: async () => {
        closed = true;
        closeController.abort(new DOMException("Target closed", "AbortError"));
      },
      waitForLoadState: async () => undefined,
      context: () => ({
        newCDPSession: async () => cdpSession,
      }),
      goto: async (href: string) => {
        const response = await realFetch(href, {
          headers: cookie ? { cookie } : {},
          signal: closeController.signal,
        });
        currentUrl = response.url || href;
        return response;
      },
      evaluate: async (
        fn: (arg: unknown) => Promise<unknown>,
        arg: unknown,
      ) => {
        const previousWindow = (globalThis as { window?: unknown }).window;
        const previousFetch = globalThis.fetch;
        (globalThis as { window?: unknown }).window = globalThis;
        globalThis.fetch = async (input: unknown, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          if (cookie && String(input).startsWith(origin)) {
            headers.set("cookie", cookie);
          }
          const signal =
            init?.signal == null
              ? closeController.signal
              : AbortSignal.any([init.signal, closeController.signal]);
          return await realFetch(input as string | URL | Request, {
            ...init,
            headers,
            signal,
          });
        };
        try {
          return await fn(arg);
        } finally {
          globalThis.fetch = previousFetch;
          if (previousWindow === undefined) {
            delete (globalThis as { window?: unknown }).window;
          } else {
            (globalThis as { window?: unknown }).window = previousWindow;
          }
        }
      },
    };
  };
  const requestContext = {
    get: async (url: string) => {
      const resolvedUrl = url.replace("http://linuxdo-e2e-media:8081", origin);
      const res = await realFetch(resolvedUrl, {
        headers: cookie && resolvedUrl.startsWith(origin) ? { cookie } : {},
      });
      const body = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") ?? "";
      return {
        status: () => res.status,
        headers: () => ({ "content-type": contentType }),
        body: async () => body,
      };
    },
  };
  const persistentContext = {
    newPage: async () => createPage(),
    request: requestContext,
  };
  const browser = {
    contexts: () => [persistentContext],
    close: async () => undefined,
  };
  return mock.method(chromium, "connect", async () => browser as never);
}

type SubmittedItem = {
  readonly sourceKey: { readonly namespace: string; readonly key: string };
  readonly content: { readonly text: string };
};

function createActionHarness(origin: string) {
  let persistentAdapterState: JsonObject | undefined;
  let persistentAccessState: SourceAccessPersistentState | undefined;
  const declarations = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site", "media"],
        minimumIntervalMs: 0,
        maxConcurrency: 1,
      },
    },
  });
  const store = {
    async load() {
      return persistentAccessState;
    },
    async save(state: SourceAccessPersistentState) {
      persistentAccessState = state;
    },
  };
  const submittedItems: SubmittedItem[] = [];

  async function runAction(
    actionName: "sync" | "collect",
    rawParams: Record<string, unknown>,
    referenceTime = "2026-10-28T04:00:00.000Z",
  ) {
    const coordinator = await createSourceAccessCoordinator({ store });
    const ownerId = `owner-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const signal = new AbortController().signal;
    const transport: SourceAccessTransport = {
      async acquire(request, acquireSignal) {
        return await coordinator.acquire(
          ownerId,
          request,
          declarations,
          acquireSignal,
        );
      },
      async release(leaseId) {
        await coordinator.release(ownerId, leaseId);
      },
      async observeResponse(request, response) {
        return await coordinator.observeResponse(
          ownerId,
          request,
          declarations,
          response,
        );
      },
    };
    const sourceAccess = createSourceAccessClient({
      runId,
      signal,
      declarations,
      transport,
    });
    const action = sourceAdapter.actions[actionName];
    const parsed = await parseSourceAdapterInput(action.params, rawParams);
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    const reports: Record<string, unknown>[] = [];
    const runItems: SubmittedItem[] = [];
    const contextBase = {
      binId: "bin-linuxdo-coverage",
      identityId: "identity-fixture",
      runId,
      referenceTime,
      sourceAdapterVersion: sourceAdapter.version,
      config: {
        origin,
        sourceAccess: declarations,
      },
      signal,
      browser: {
        protocol: "playwright" as const,
        endpoint: "ws://mock-browser",
        playwrightVersion: "1.64.2",
      },
      sourceAccess,
      persistentState: {
        async load() {
          return persistentAdapterState;
        },
        async save(state: JsonObject) {
          persistentAdapterState = state;
        },
      },
      report: async (value: Record<string, unknown>) => {
        reports.push(structuredClone(value));
      },
      archive: {
        async submit(payload: { readonly items: readonly SubmittedItem[] }) {
          submittedItems.push(...payload.items);
          runItems.push(...payload.items);
          return {
            commitId: randomUUID(),
            archiveSequence: String(submittedItems.length),
          };
        },
      },
      resources: {
        async upload(_body: Uint8Array, mediaType: string) {
          return {
            ok: true as const,
            resource: {
              resourceId: randomUUID(),
              sha256: "0".repeat(64),
              mediaType,
              size: 16,
            },
          };
        },
        async resolve() {
          return { mediaByUrl: {} };
        },
      },
    };

    try {
      const output =
        actionName === "sync"
          ? await sourceAdapter.actions.sync.execute(
              contextBase as unknown as Parameters<
                typeof sourceAdapter.actions.sync.execute
              >[0],
              parsed.data as Parameters<
                typeof sourceAdapter.actions.sync.execute
              >[1],
            )
          : await sourceAdapter.actions.collect.execute(
              contextBase as unknown as Parameters<
                typeof sourceAdapter.actions.collect.execute
              >[0],
              parsed.data as Parameters<
                typeof sourceAdapter.actions.collect.execute
              >[1],
            );
      return {
        output: output as Record<string, unknown>,
        reports,
        latestReport: reports.at(-1),
        runItems,
      };
    } finally {
      await coordinator.closeOwner(ownerId).catch(() => undefined);
    }
  }

  return {
    runSync: (rawParams: Record<string, unknown>, referenceTime?: string) =>
      runAction("sync", rawParams, referenceTime),
    runCollect: (rawParams: Record<string, unknown>, referenceTime?: string) =>
      runAction("collect", rawParams, referenceTime),
    getSubmittedItems: () => submittedItems,
    getAdapterState: () => persistentAdapterState,
    setAdapterState: (state: JsonObject) => {
      persistentAdapterState = state;
    },
  };
}

void describe("Linux.do range coverage, head verification, and explicit backfill", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  void it("reports complete coverage on exhausted history with head insertion catch-up and archives inserted posts", async () => {
    const fixture = await startLinuxdoFixtureProcess();
    try {
      await fixture.updateState({
        postRangeEnabled: true,
        postRangePageSize: 2,
        postRangeAddAfterFirstPage: true,
      });
      createHttpBrowserMock(fixture.origin, fixture.cookie);
      const harness = createActionHarness(fixture.origin);

      const realDateNow = Date.now;
      Date.now = () => Date.parse("2026-10-28T04:00:00.000Z");
      try {
        const result = await harness.runCollect({
          targets: [{ id: "latest", kind: "latest" }],
          postCreatedRange: {
            from: "2026-10-28T02:00:00.000Z",
            to: "2026-10-28T04:00:00.000Z",
            maxPages: 20,
          },
        });

        assert.equal(
          result.output.collectionCompleteness,
          "complete",
          JSON.stringify(result.output),
        );
        assert.deepEqual(result.output.incompleteScopes, []);
        assert.equal(result.latestReport?.phase, "completed");
        assert.deepEqual(result.output.rangeCoverage, {
          pagesRead: (result.output.rangeCoverage as { pagesRead: number })
            .pagesRead,
          maxPages: 20,
          lowerBoundConfirmed: true,
          headVerified: true,
        });
        const keys = new Set(result.runItems.map((item) => item.sourceKey.key));
        assert.ok(keys.has("post:249901"), "Inserted in-range reply archived");
        assert.ok(
          keys.has("post:240006"),
          "Non-monotonic in-range reply archived",
        );
      } finally {
        Date.now = realDateNow;
      }
    } finally {
      await fixture.close();
    }
  });

  void it("reports partial with lowerBoundConfirmed=true, headVerified=false when head insertions exceed maxPages, and withholds lower bound update", async () => {
    // Controllable Discourse server: history ends on page 2, then 3 new posts inserted at head (pageSize=2 -> needs 2 head pages)
    let feedPhase = 0;
    const basePosts = [
      {
        id: 200,
        topic_id: 10,
        post_number: 1,
        created_at: "2026-10-28T02:10:00.000Z",
        updated_at: "2026-10-28T02:10:00.000Z",
        username: "u",
        cooked: "<p>Base post 200</p>",
      },
    ];
    const headInsertedPosts = [
      {
        id: 204,
        topic_id: 10,
        post_number: 5,
        created_at: "2026-10-28T02:20:00.000Z",
        updated_at: "2026-10-28T02:20:00.000Z",
        username: "u",
        cooked: "<p>Head insert 204</p>",
      },
      {
        id: 203,
        topic_id: 10,
        post_number: 4,
        created_at: "2026-10-28T02:18:00.000Z",
        updated_at: "2026-10-28T02:18:00.000Z",
        username: "u",
        cooked: "<p>Head insert 203</p>",
      },
      {
        id: 202,
        topic_id: 10,
        post_number: 3,
        created_at: "2026-10-28T02:16:00.000Z",
        updated_at: "2026-10-28T02:16:00.000Z",
        username: "u",
        cooked: "<p>Head insert 202</p>",
      },
    ];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json; charset=utf-8");
      if (url.pathname === "/" || url.pathname === "/login") {
        res.end("<html></html>");
        return;
      }
      if (url.pathname === "/session/current.json") {
        res.end(JSON.stringify({ current_user: { id: 1, username: "u" } }));
        return;
      }
      if (url.pathname === "/categories.json") {
        res.end(
          JSON.stringify({
            category_list: {
              categories: [{ id: 42, name: "Controlled", slug: "controlled" }],
            },
          }),
        );
        return;
      }
      if (url.pathname === "/posts.json") {
        const before = url.searchParams.get("before");
        const allPosts =
          feedPhase === 0 ? basePosts : [...headInsertedPosts, ...basePosts];
        if (before === null) {
          feedPhase += 1;
          res.end(JSON.stringify({ latest_posts: allPosts.slice(0, 2) }));
          return;
        }
        const beforeNum = Number(before);
        res.end(
          JSON.stringify({
            latest_posts: allPosts.filter((p) => p.id < beforeNum).slice(0, 2),
          }),
        );
        return;
      }
      if (url.pathname === "/t/10.json") {
        res.end(
          JSON.stringify({
            id: 10,
            title: "Topic 10",
            slug: "topic-10",
            created_at: "2026-10-28T02:10:00.000Z",
            category_id: 42,
            post_stream: {
              posts: basePosts,
              stream: [200, 202, 203, 204],
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ errors: ["not found"] }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = server.address();
    assert.ok(addr !== null && typeof addr !== "string");
    const origin = `http://127.0.0.1:${String(addr.port)}`;
    createHttpBrowserMock(origin, "");

    const harness = createActionHarness(origin);
    const target = {
      id: "cat-42",
      kind: "category",
      categoryId: 42,
      categorySlugPath: "controlled",
    };
    const realDateNow = Date.now;
    let fakeNow = Date.parse("2026-10-28T02:00:00.000Z");
    Date.now = () => fakeNow;
    try {
      await harness.runSync({ targets: [target] });

      // maxPages = 3: 1 initial (200) + 1 downward (before=200 -> [], lowerBoundConfirmed=true) + 1 head (204,203 -> doesn't reach 200 -> headVerified=false)
      fakeNow = Date.parse("2026-10-28T02:30:00.000Z");
      const partialSync = await harness.runSync({
        targets: [target],
        maxPages: 3,
      });

      assert.equal(partialSync.output.outcome, "partial");
      assert.equal(partialSync.latestReport?.phase, "partial");
      const incomplete = (
        partialSync.output.incompleteScopes as readonly Record<
          string,
          unknown
        >[]
      )[0];
      assert.ok(incomplete !== undefined);
      assert.equal(incomplete.reasonCode, "post_range_page_limit_reached");
      assert.equal(incomplete.pagesRead, 3);
      assert.equal(incomplete.maxPages, 3);
      assert.equal(incomplete.lowerBoundConfirmed, true);
      assert.equal(incomplete.headVerified, false);
      assert.deepEqual(incomplete.range, {
        from: "2026-10-28T02:00:00.000Z",
        to: "2026-10-28T02:30:00.000Z",
      });
      assert.ok(incomplete.backfillCollectParams !== undefined);

      // Must NOT forge/update confirmedPostIdLowerBound when headVerified is false!
      const state = harness.getAdapterState() as {
        readonly scopes: readonly {
          readonly position: string;
          readonly confirmedPostIdLowerBound?: number;
        }[];
      };
      assert.equal(state.scopes[0]?.position, "2026-10-28T02:30:00.000Z");
      assert.equal(state.scopes[0]?.confirmedPostIdLowerBound, undefined);

      // Explicit backfill using backfillCollectParams from output completes and archives missing post 202
      const backfill = await harness.runCollect(
        incomplete.backfillCollectParams as Record<string, unknown>,
      );
      assert.equal(backfill.output.collectionCompleteness, "complete");
      assert.equal(backfill.latestReport?.phase, "completed");
      const backfilledKeys = new Set(
        backfill.runItems.map((item) => item.sourceKey.key),
      );
      assert.ok(backfilledKeys.has("post:202"));
    } finally {
      Date.now = realDateNow;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  void it("preserves partial archive on lower-bound page limit, guides explicit collect backfill, handles truncated skippedBefore gap, and advances next sync without fake lowerBound", async () => {
    const fixture = await startLinuxdoFixtureProcess();
    try {
      await fixture.updateState({
        postRangeEnabled: true,
        postRangePageSize: 2,
        postRangeAddAfterFirstPage: false,
        syncScenarioStage: 1,
      });
      createHttpBrowserMock(fixture.origin, fixture.cookie);
      const harness = createActionHarness(fixture.origin);
      const target = {
        id: "cat-42",
        kind: "category",
        categoryId: 42,
        categorySlugPath: "controlled",
      };

      const realDateNow = Date.now;
      let fakeNow = Date.parse("2026-10-28T02:00:00.000Z");
      Date.now = () => fakeNow;
      try {
        // Step 1: Initialize sync at 02:00
        const init = await harness.runSync({ targets: [target] });
        assert.equal(init.output.outcome, "initialized");

        // Step 2: Sync at 03:00 with maxPages = 2 -> truncated before confirming lower bound
        // Older in-range posts in [02:00, 03:00) (e.g. post:240002 at 02:00, post:250000 at 02:30) lie beyond page 1.
        fakeNow = Date.parse("2026-10-28T03:00:00.000Z");
        const partialSync = await harness.runSync({
          targets: [target],
          maxPages: 2,
        });
        assert.equal(partialSync.output.outcome, "partial");
        assert.equal(partialSync.latestReport?.phase, "partial");
        const partialIncomplete = (
          partialSync.output.incompleteScopes as readonly Record<
            string,
            unknown
          >[]
        ).find((s) => s.reasonCode === "post_range_page_limit_reached");
        assert.ok(partialIncomplete !== undefined);
        assert.equal(partialIncomplete.pagesRead, 2);
        assert.equal(partialIncomplete.maxPages, 2);
        assert.equal(partialIncomplete.lowerBoundConfirmed, false);
        assert.equal(partialIncomplete.headVerified, true);
        assert.deepEqual(partialIncomplete.range, {
          from: "2026-10-28T02:00:00.000Z",
          to: "2026-10-28T03:00:00.000Z",
        });
        assert.deepEqual(partialIncomplete.target, {
          kind: "targets",
          targets: [{ ...target, id: "category-42" }],
        });

        // Position moved to 03:00, confirmedPostIdLowerBound must remain undefined!
        const stateAfterPartial = harness.getAdapterState() as {
          readonly scopes: readonly {
            readonly position: string;
            readonly confirmedPostIdLowerBound?: number;
          }[];
        };
        assert.equal(
          stateAfterPartial.scopes[0]?.position,
          "2026-10-28T03:00:00.000Z",
        );
        assert.equal(
          stateAfterPartial.scopes[0]?.confirmedPostIdLowerBound,
          undefined,
        );

        // Step 3: Explicit collect using backfillCollectParams recovers missing posts in [02:00, 03:00)
        const backfillParams = partialIncomplete.backfillCollectParams as {
          readonly targets?: unknown;
          readonly postCreatedRange: {
            readonly from: string;
            readonly to: string;
            readonly maxPages: number;
          };
        };
        assert.ok(backfillParams.postCreatedRange.maxPages > 2);
        const backfill = await harness.runCollect(backfillParams);
        assert.equal(backfill.output.collectionCompleteness, "complete");
        assert.equal(backfill.latestReport?.phase, "completed");
        const backfilledKeys = new Set(
          backfill.runItems.map((item) => item.sourceKey.key),
        );
        assert.ok(backfilledKeys.has("post:250000"));
        assert.ok(backfilledKeys.has("post:240002"));

        // Step 4: Next sync at 03:30 continues from 03:00 (not 02:00) and succeeds when given sufficient maxPages
        await fixture.updateState({ syncScenarioStage: 2 });
        fakeNow = Date.parse("2026-10-28T03:30:00.000Z");
        const nextSync = await harness.runSync({
          targets: [target],
          maxPages: 20,
        });
        assert.equal(nextSync.output.outcome, "advanced");
        assert.equal(nextSync.latestReport?.phase, "completed");
        const nextScope = (
          nextSync.output.scopes as readonly {
            readonly range?: { readonly from: string; readonly to: string };
          }[]
        )[0];
        assert.deepEqual(nextScope?.range, {
          from: "2026-10-28T03:00:00.000Z",
          to: "2026-10-28T03:30:00.000Z",
        });

        // Step 5: Sync > 1 hour later (at 05:00) produces skippedBefore + sync_skipped_before_window gap with backfillCollectParams
        fakeNow = Date.parse("2026-10-28T05:00:00.000Z");
        const truncatedSync = await harness.runSync({
          targets: [target],
          maxPages: 20,
        });
        assert.equal(truncatedSync.output.outcome, "partial");
        const skippedGapEntry = (
          truncatedSync.output.incompleteScopes as readonly Record<
            string,
            unknown
          >[]
        ).find((s) => s.reasonCode === "sync_skipped_before_window");
        assert.ok(skippedGapEntry !== undefined);
        assert.deepEqual(skippedGapEntry.range, {
          from: "2026-10-28T03:30:00.000Z",
          to: "2026-10-28T04:00:00.000Z",
        });
        assert.ok(skippedGapEntry.backfillCollectParams !== undefined);

        // Passing skippedGapEntry.backfillCollectParams directly into collect works and recovers post:240011 (created at 03:45)
        const skippedBackfill = await harness.runCollect(
          skippedGapEntry.backfillCollectParams as Record<string, unknown>,
          "2026-10-28T05:00:00.000Z",
        );
        assert.equal(skippedBackfill.output.collectionCompleteness, "complete");
        const skippedKeys = new Set(
          skippedBackfill.runItems.map((item) => item.sourceKey.key),
        );
        assert.ok(skippedKeys.has("post:240011"));
      } finally {
        Date.now = realDateNow;
      }
    } finally {
      await fixture.close();
    }
  });
});
