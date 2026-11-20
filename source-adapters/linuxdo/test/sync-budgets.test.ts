import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createActionCancelledReason,
  createSourceAccessClient,
  createSourceAccessCoordinator,
  isSourceAdapterActionError,
  parseSourceAdapterInput,
  sourceAccessConfigSchema,
  sourceAdapterManifest,
  type JsonObject,
  type SourceAccessClock,
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
      // Wait for fixture HTTP listener startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fixture server at ${origin} did not start in time.`);
}

async function startLinuxdoFixtureProcess(): Promise<{
  readonly origin: string;
  readonly cookie: string;
  updateState(patch: Record<string, unknown>): Promise<void>;
  readEvents(): Promise<
    readonly { readonly action: string; readonly path: string }[]
  >;
  close(): Promise<void>;
}> {
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
      async updateState(patch) {
        const res = await fetch(`${origin}/__control/state`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        assert.equal(res.status, 200, await res.text());
      },
      async readEvents() {
        const res = await fetch(`${origin}/__control/state`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          readonly events: readonly {
            readonly action: string;
            readonly path: string;
          }[];
        };
        return body.events;
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
      const res = await realFetch(url, {
        headers: cookie && url.startsWith(origin) ? { cookie } : {},
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

function createMemorySyncHarness(options: {
  readonly origin: string;
  readonly minimumIntervalMs?: number;
  readonly clock?: SourceAccessClock;
}) {
  let persistentAdapterState: JsonObject | undefined;
  let persistentAccessState: SourceAccessPersistentState | undefined;
  const declarations = sourceAccessConfigSchema.parse({
    groups: {
      linuxdo: {
        sources: ["site", "media"],
        minimumIntervalMs: options.minimumIntervalMs ?? 0,
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
  const submittedItems: unknown[] = [];

  async function runSync(input: {
    readonly rawParams: Record<string, unknown>;
    readonly signal?: AbortSignal;
    readonly referenceTime?: string;
  }) {
    const coordinator = await createSourceAccessCoordinator({
      store,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const ownerId = `owner-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const signal = input.signal ?? new AbortController().signal;
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
    const parsed = await parseSourceAdapterInput(
      sourceAdapter.actions.sync.params,
      input.rawParams,
    );
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    const reports: Record<string, unknown>[] = [];
    const context = {
      binId: "bin-linuxdo-budget",
      identityId: "identity-fixture",
      runId,
      referenceTime: input.referenceTime ?? "2026-10-28T04:00:00.000Z",
      sourceAdapterVersion: sourceAdapter.version,
      config: {
        origin: options.origin,
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
        async submit(payload: { readonly items: readonly unknown[] }) {
          submittedItems.push(...payload.items);
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
    } as unknown as Parameters<typeof sourceAdapter.actions.sync.execute>[0];

    try {
      const output = await sourceAdapter.actions.sync.execute(
        context,
        parsed.data,
      );
      return { output, reports, latestReport: reports.at(-1) };
    } finally {
      await coordinator.closeOwner(ownerId).catch(() => undefined);
    }
  }

  return {
    runSync,
    getSubmittedItems: () => submittedItems,
    getAdapterState: () => persistentAdapterState,
    setAdapterState: (state: JsonObject) => {
      persistentAdapterState = state;
    },
  };
}

void describe("Linux.do sync explicit budgets and source-wait diagnostics", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  void it("publishes sync manifest without default budgets while preserving explicit input semantics", async () => {
    const manifest = sourceAdapterManifest(sourceAdapter);
    const syncAction = manifest.actions.sync;
    assert.ok(syncAction !== undefined);
    const paramsSchema = syncAction.params as {
      readonly required?: readonly string[];
      readonly properties?: Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >;
    };
    assert.equal(
      paramsSchema.required?.includes("maxRequests") ?? false,
      false,
    );
    assert.equal(
      paramsSchema.required?.includes("maxElapsedMs") ?? false,
      false,
    );
    assert.equal(paramsSchema.properties?.maxRequests?.default, undefined);
    assert.equal(paramsSchema.properties?.maxElapsedMs?.default, undefined);

    const omitted = await parseSourceAdapterInput(
      sourceAdapter.actions.sync.params,
      {},
    );
    assert.equal(omitted.success, true);
    if (omitted.success) {
      const data = omitted.data as {
        readonly maxPages: number;
        readonly maxRequests?: number;
        readonly maxElapsedMs?: number;
      };
      assert.equal(data.maxPages, 20);
      assert.equal(data.maxRequests, undefined);
      assert.equal(data.maxElapsedMs, undefined);
    }

    const explicitOldDefaults = await parseSourceAdapterInput(
      sourceAdapter.actions.sync.params,
      { maxRequests: 200, maxElapsedMs: 300_000 },
    );
    assert.equal(explicitOldDefaults.success, true);
    if (explicitOldDefaults.success) {
      const data = explicitOldDefaults.data as {
        readonly maxRequests?: number;
        readonly maxElapsedMs?: number;
      };
      assert.equal(data.maxRequests, 200);
      assert.equal(data.maxElapsedMs, 300_000);
    }
  });

  void it("completes sync exceeding old 200-request cap when budgets are omitted", async () => {
    // Serve 210 distinct topics so sync executes > 200 admitted requests without hitting a default limit.
    const topicCount = 210;
    const posts = Array.from({ length: topicCount }, (_, index) => {
      const topicId = 900_001 + index;
      return {
        id: 9_000_001 + (topicCount - 1 - index),
        topic_id: topicId,
        post_number: 1,
        created_at: "2026-10-28T03:30:00.000Z",
        updated_at: "2026-10-28T03:30:00.000Z",
        username: "author",
        cooked: `<p>Topic ${String(topicId)} body</p>`,
      };
    });
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
        if (before === null) {
          res.end(JSON.stringify({ latest_posts: posts.slice(0, 50) }));
          return;
        }
        const beforeNum = Number(before);
        const page = posts.filter((p) => p.id < beforeNum).slice(0, 50);
        res.end(JSON.stringify({ latest_posts: page }));
        return;
      }
      const topicMatch = /^\/t\/(\d+)\.json$/u.exec(url.pathname);
      if (topicMatch !== null) {
        const topicId = Number(topicMatch[1]);
        const post = posts.find((p) => p.topic_id === topicId);
        if (post === undefined) {
          res.statusCode = 404;
          res.end(JSON.stringify({ errors: ["not found"] }));
          return;
        }
        res.end(
          JSON.stringify({
            id: topicId,
            title: `Topic ${String(topicId)}`,
            slug: `topic-${String(topicId)}`,
            created_at: post.created_at,
            category_id: 42,
            post_stream: {
              posts: [post],
              stream: [post.id],
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

    const harness = createMemorySyncHarness({ origin });
    harness.setAdapterState({
      version: 1,
      scopes: [
        {
          binId: "bin-linuxdo-budget",
          identityId: "identity-fixture",
          origin,
          scope: { kind: "category", id: 42 },
          position: "2026-10-28T03:00:00.000Z",
          lastRunId: "prev-run",
        },
      ],
    });

    const realDateNow = Date.now;
    Date.now = () => Date.parse("2026-10-28T04:00:00.000Z");
    try {
      const { output, latestReport } = await harness.runSync({
        rawParams: {
          targets: [
            {
              id: "cat-42",
              kind: "category",
              categoryId: 42,
              categorySlugPath: "controlled",
            },
          ],
          maxPages: 20,
        },
      });
      const typedOutput = output as {
        readonly outcome: string;
        readonly observedPosts: number;
        readonly topicsExamined: number;
      };
      const typedReport = latestReport as {
        readonly phase: string;
        readonly abortCause?: string;
        readonly budget: {
          readonly maxRequests?: number;
          readonly maxElapsedMs?: number;
          readonly elapsedMs: number;
          readonly remainingMs?: number;
          readonly stopReason?: string;
        };
        readonly sourceAccess: { readonly admittedAttempts: number };
      };
      assert.equal(typedOutput.outcome, "advanced");
      assert.equal(typedOutput.topicsExamined, topicCount);
      assert.equal(typedOutput.observedPosts, topicCount);
      assert.equal(typedReport.phase, "completed");
      assert.equal(typedReport.abortCause, undefined);
      assert.equal(typedReport.budget.maxRequests, undefined);
      assert.equal(typedReport.budget.maxElapsedMs, undefined);
      assert.equal(typedReport.budget.remainingMs, undefined);
      assert.equal(typedReport.budget.stopReason, undefined);
      assert.ok(
        typedReport.sourceAccess.admittedAttempts > 200,
        `Expected > 200 admitted attempts, got ${String(typedReport.sourceAccess.admittedAttempts)}`,
      );

      // Verify explicit old defaults (200 / 300_000) still enforce those explicit bounds on the same source.
      harness.setAdapterState({
        version: 1,
        scopes: [
          {
            binId: "bin-linuxdo-budget",
            identityId: "identity-fixture",
            origin,
            scope: { kind: "category", id: 42 },
            position: "2026-10-28T03:00:00.000Z",
            lastRunId: "prev-run",
          },
        ],
      });
      const bounded = await harness.runSync({
        rawParams: {
          targets: [
            {
              id: "cat-42",
              kind: "category",
              categoryId: 42,
              categorySlugPath: "controlled",
            },
          ],
          maxPages: 20,
          maxRequests: 200,
          maxElapsedMs: 300_000,
        },
      });
      const boundedOutput = bounded.output as { readonly outcome: string };
      const boundedReport = bounded.latestReport as {
        readonly phase: string;
        readonly abortCause?: string;
        readonly budget: {
          readonly maxRequests?: number;
          readonly maxElapsedMs?: number;
          readonly stopReason?: string;
        };
      };
      assert.equal(boundedOutput.outcome, "partial");
      assert.equal(boundedReport.phase, "budget-exhausted");
      assert.equal(boundedReport.abortCause, "action_budget_exhausted");
      assert.equal(boundedReport.budget.maxRequests, 200);
      assert.equal(boundedReport.budget.maxElapsedMs, 300_000);
      assert.equal(boundedReport.budget.stopReason, "request-limit");
    } finally {
      Date.now = realDateNow;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  void it("enforces single explicit budget dimensions independently against controllable Discourse fixture", async () => {
    const fixture = await startLinuxdoFixtureProcess();
    try {
      await fixture.updateState({
        postRangeEnabled: true,
        postRangePageSize: 2,
      });
      createHttpBrowserMock(fixture.origin, fixture.cookie);
      const harness = createMemorySyncHarness({ origin: fixture.origin });
      const target = {
        id: "cat-42",
        kind: "category",
        categoryId: 42,
        categorySlugPath: "controlled",
      };

      const realDateNow = Date.now;
      let fakeNow = Date.parse("2026-10-28T03:00:00.000Z");
      Date.now = () => fakeNow;
      try {
        // Initialize scope position first
        const init = await harness.runSync({
          rawParams: { targets: [target] },
        });
        assert.equal(
          (init.output as { outcome: string }).outcome,
          "initialized",
        );

        // 1. Only maxRequests set (maxElapsedMs omitted)
        fakeNow = Date.parse("2026-10-28T03:30:00.000Z");
        const reqLimited = await harness.runSync({
          rawParams: { targets: [target], maxRequests: 3 },
        });
        const reqReport = reqLimited.latestReport as {
          readonly phase: string;
          readonly abortCause?: string;
          readonly budget: {
            readonly maxRequests?: number;
            readonly maxElapsedMs?: number;
            readonly remainingMs?: number;
            readonly stopReason?: string;
          };
          readonly incompleteScopes: readonly {
            readonly scope: string;
            readonly reasonCode: string;
          }[];
        };
        assert.equal(reqReport.phase, "budget-exhausted");
        assert.equal(reqReport.abortCause, "action_budget_exhausted");
        assert.equal(reqReport.budget.maxRequests, 3);
        assert.equal(reqReport.budget.maxElapsedMs, undefined);
        assert.equal(reqReport.budget.remainingMs, undefined);
        assert.equal(reqReport.budget.stopReason, "request-limit");
        assert.equal(
          reqReport.incompleteScopes.some(
            (s) => s.reasonCode === "budget_request_limit",
          ),
          true,
        );

        // 2. Only maxElapsedMs set (maxRequests omitted)
        await fixture.updateState({
          postRangePause: { page: 1, milliseconds: 200 },
        });
        fakeNow = Date.parse("2026-10-28T03:45:00.000Z");
        const timeLimited = await harness.runSync({
          rawParams: { targets: [target], maxElapsedMs: 60 },
        });
        const timeReport = timeLimited.latestReport as {
          readonly phase: string;
          readonly abortCause?: string;
          readonly budget: {
            readonly maxRequests?: number;
            readonly maxElapsedMs?: number;
            readonly remainingMs?: number;
            readonly stopReason?: string;
          };
          readonly incompleteScopes: readonly {
            readonly scope: string;
            readonly reasonCode: string;
          }[];
        };
        assert.equal(timeReport.phase, "budget-exhausted");
        assert.equal(timeReport.abortCause, "action_budget_exhausted");
        assert.equal(timeReport.budget.maxRequests, undefined);
        assert.equal(timeReport.budget.maxElapsedMs, 60);
        assert.equal(timeReport.budget.remainingMs, 0);
        assert.equal(timeReport.budget.stopReason, "elapsed-time-limit");
        assert.equal(
          timeReport.incompleteScopes.some(
            (s) => s.reasonCode === "budget_elapsed_time_limit",
          ),
          true,
        );
      } finally {
        Date.now = realDateNow;
      }
    } finally {
      await fixture.close();
    }
  });

  void it("distinguishes source-requested wait/cooldown, user cancellation, per-request timeout, and wait-exceeds-budget", async () => {
    const fixture = await startLinuxdoFixtureProcess();
    try {
      await fixture.updateState({
        postRangeEnabled: true,
        postRangePageSize: 50,
      });
      createHttpBrowserMock(fixture.origin, fixture.cookie);
      const harness = createMemorySyncHarness({ origin: fixture.origin });
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
        await harness.runSync({ rawParams: { targets: [target] } });

        // A. Source responds 429 with Retry-After: "2" -> rate-limited report & cross-run cooldown
        await fixture.updateState({
          postRangeResponseStatus: 429,
          postRangeRetryAfter: "2",
        });
        fakeNow = Date.parse("2026-10-28T02:20:00.000Z");
        const rateLimited = await harness.runSync({
          rawParams: { targets: [target] },
        });
        const rlReport = rateLimited.latestReport as {
          readonly phase: string;
          readonly abortCause?: string;
          readonly sourceAccess: {
            readonly rateLimitResponses: readonly {
              readonly status: number;
              readonly retryAfter?: string;
              readonly outcome: string;
              readonly cooldownUntil?: string;
            }[];
          };
          readonly incompleteScopes: readonly {
            readonly reasonCode: string;
            readonly message: string;
          }[];
        };
        assert.equal(rlReport.phase, "partial");
        assert.equal(rlReport.abortCause, undefined);
        assert.equal(rlReport.sourceAccess.rateLimitResponses[0]?.status, 429);
        assert.equal(
          rlReport.sourceAccess.rateLimitResponses[0]?.outcome,
          "cooled",
        );
        assert.equal(
          rlReport.incompleteScopes[0]?.reasonCode,
          "post_range_source_rate_limited",
        );
        assert.match(
          rlReport.incompleteScopes[0]?.message ?? "",
          /429|冷却|Retry-After/u,
        );

        // B. Explicit maxElapsedMs smaller than active Retry-After cooldown -> wait-exceeds-budget
        fakeNow = Date.parse("2026-10-28T02:25:00.000Z");
        const waitLimited = await harness.runSync({
          rawParams: { targets: [target], maxElapsedMs: 200 },
        });
        const waitReport = waitLimited.latestReport as {
          readonly phase: string;
          readonly abortCause?: string;
          readonly budget: { readonly stopReason?: string };
          readonly incompleteScopes: readonly {
            readonly reasonCode: string;
            readonly message: string;
          }[];
        };
        assert.equal(waitReport.phase, "budget-exhausted");
        assert.equal(waitReport.abortCause, "action_budget_exhausted");
        assert.equal(waitReport.budget.stopReason, "wait-exceeds-budget");
        assert.equal(
          waitReport.incompleteScopes.some(
            (s) =>
              s.reasonCode === "budget_wait_exceeds_budget" &&
              /冷却|Retry-After|maxElapsedMs/u.test(s.message),
          ),
          true,
          JSON.stringify(waitReport.incompleteScopes),
        );

        // C. Omitting maxElapsedMs waits through the remaining cooldown and completes!
        await fixture.updateState({
          postRangeResponseStatus: null,
          postRangeRetryAfter: null,
        });
        fakeNow = Date.parse("2026-10-28T02:30:00.000Z");
        const waitedAndCompleted = await harness.runSync({
          rawParams: { targets: [target] },
        });
        const waitedReport = waitedAndCompleted.latestReport as {
          readonly phase: string;
          readonly abortCause?: string;
          readonly sourceAccess: { readonly waitedMs: number };
        };
        assert.equal(waitedReport.phase, "completed");
        assert.equal(waitedReport.abortCause, undefined);
        assert.ok(
          waitedReport.sourceAccess.waitedMs > 0,
          `Expected waitedMs > 0, got ${String(waitedReport.sourceAccess.waitedMs)}`,
        );

        // D. User cancellation during sync -> user_cancelled (distinct from budget exhaustion & source wait)
        await fixture.updateState({
          postRangePause: { page: 1, milliseconds: 5_000 },
        });
        fakeNow = Date.parse("2026-10-28T02:45:00.000Z");
        const cancelController = new AbortController();
        setTimeout(
          () => cancelController.abort(createActionCancelledReason()),
          80,
        );
        await assert.rejects(
          harness.runSync({
            rawParams: { targets: [target] },
            signal: cancelController.signal,
          }),
          (error: unknown) =>
            isSourceAdapterActionError(error) &&
            error.failure.code === "source_adapter_action_cancelled" &&
            error.failure.abortCause === "user_cancelled",
        );

        // E. Per-request timeout still applies even when maxElapsedMs is omitted
        await fixture.updateState({
          postRangePause: { page: 1, milliseconds: 500 },
        });
        const previousEnvTimeout = process.env.BINNY_LINUXDO_REQUEST_TIMEOUT_MS;
        process.env.BINNY_LINUXDO_REQUEST_TIMEOUT_MS = "40";
        try {
          fakeNow = Date.parse("2026-10-28T03:00:00.000Z");
          const timedOut = await harness.runSync({
            rawParams: { targets: [target] },
          });
          const timeoutReport = timedOut.latestReport as {
            readonly phase: string;
            readonly abortCause?: string;
            readonly incompleteScopes: readonly {
              readonly reasonCode: string;
              readonly message: string;
            }[];
          };
          assert.equal(timeoutReport.phase, "partial");
          assert.equal(timeoutReport.abortCause, undefined);
          assert.equal(
            timeoutReport.incompleteScopes[0]?.reasonCode,
            "post_range_source_unreachable",
          );
          assert.match(
            timeoutReport.incompleteScopes[0]?.message ?? "",
            /timed out|40ms/u,
          );
        } finally {
          if (previousEnvTimeout === undefined) {
            delete process.env.BINNY_LINUXDO_REQUEST_TIMEOUT_MS;
          } else {
            process.env.BINNY_LINUXDO_REQUEST_TIMEOUT_MS = previousEnvTimeout;
          }
        }
      } finally {
        Date.now = realDateNow;
      }
    } finally {
      await fixture.close();
    }
  });
});
