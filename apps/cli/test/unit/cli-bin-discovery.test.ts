import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicApiProtocolVersion } from "@binny/contracts";

import { runCli } from "../../src/main.ts";

const metadata = {
  product: { name: "Binny", version: "1.2.3" },
  protocols: { httpApi: publicApiProtocolVersion },
  capabilities: ["archive.query-contract"],
  contracts: { archiveQuery: { version: 1, path: "/meta/query" } },
};

type RouteResult = {
  readonly path: string;
  readonly search: string;
  readonly method: string;
};

function createService(
  bins: readonly unknown[] = [
    {
      id: "rss-main",
      sourceAdapterId: "rss",
      status: "active",
      execution: { status: "online" },
    },
    {
      id: "forum-backup",
      sourceAdapterId: "forum",
      status: "disabled",
      execution: { status: "offline" },
    },
  ],
) {
  const requests: RouteResult[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      path: url.pathname,
      search: url.search,
      method: request.method,
    });
    if (url.pathname === "/meta") return Response.json(metadata);
    if (url.pathname === "/bins") return Response.json({ bins });
    if (url.pathname === "/bins/rss-main")
      return Response.json({
        id: "rss-main",
        sourceAdapterId: "rss",
        identityId: "account-main",
        config: { feedUrl: "https://example.test/feed.xml" },
        runtimeSleep: { idleTimeoutSeconds: null },
        status: "active",
        execution: { status: "offline", reason: "runtime_not_connected" },
        sourceStateSnapshot: { freshness: "unknown" },
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
      });
    return new Response("Not found", { status: 404 });
  };

  return { fetch, requests };
}

async function run(argv: readonly string[], fetch: typeof globalThis.fetch) {
  let output = "";
  const exitCode = await runCli({
    argv: ["node", "binny", ...argv],
    identity: { commandName: "binny", version: "9.8.7" },
    fetch,
    apiUrl: "http://service.test",
    write: async ({ chunk }) => {
      output += chunk;
    },
  });
  return { exitCode, output };
}

void describe("bin discovery", () => {
  void it("lists concise bin identities and runtime status in structured output", async () => {
    const service = createService();
    const result = await run(["bin", "list"], service.fetch);

    assert.equal(result.exitCode, 0, result.output);
    const wire = JSON.parse(result.output) as {
      readonly data: {
        readonly bins: readonly {
          readonly id: string;
          readonly sourceAdapterId: string;
          readonly status: string;
          readonly execution: { readonly status: string };
        }[];
      };
    };
    assert.deepEqual(wire.data.bins, [
      {
        id: "rss-main",
        sourceAdapterId: "rss",
        status: "active",
        execution: { status: "online" },
      },
      {
        id: "forum-backup",
        sourceAdapterId: "forum",
        status: "disabled",
        execution: { status: "offline" },
      },
    ]);
    assert.deepEqual(
      service.requests.map(({ method, path }) => [method, path]),
      [
        ["GET", "/meta"],
        ["GET", "/bins"],
      ],
    );
  });

  void it("keeps an empty bin list as an explicit structured collection", async () => {
    const service = createService([]);
    const result = await run(["bin", "list"], service.fetch);

    assert.equal(result.exitCode, 0, result.output);
    const wire = JSON.parse(result.output) as {
      readonly data: { readonly bins: readonly unknown[] };
    };
    assert.deepEqual(wire.data.bins, []);
  });

  void it("returns bin configuration with status and snapshot freshness only", async () => {
    const service = createService();
    const result = await run(["bin", "get", "rss-main"], service.fetch);

    assert.equal(result.exitCode, 0, result.output);
    const wire = JSON.parse(result.output) as {
      readonly data: Record<string, unknown> & {
        readonly sourceAdapterId: string;
        readonly config: Record<string, unknown>;
        readonly execution: { readonly status: string };
        readonly sourceStateSnapshot: { readonly freshness: string };
      };
    };
    assert.equal(wire.data.sourceAdapterId, "rss");
    assert.deepEqual(wire.data.config, {
      feedUrl: "https://example.test/feed.xml",
    });
    assert.equal(wire.data.execution.status, "offline");
    assert.equal(wire.data.sourceStateSnapshot.freshness, "unknown");
    assert.equal(Object.hasOwn(wire.data, "sourceAdapter"), false);
    assert.equal(Object.hasOwn(wire.data, "persistentState"), false);

    const textResult = await run(
      ["bin", "get", "rss-main", "--output", "text"],
      service.fetch,
    );
    assert.equal(textResult.exitCode, 0, textResult.output);
    assert.match(textResult.output, /Bin: rss-main/u);
    assert.match(
      textResult.output,
      /Runtime connection: offline \(runtime_not_connected\)/u,
    );
    assert.match(textResult.output, /Browser: unknown \(runtime offline\)/u);
    assert.match(textResult.output, /Source state: unknown/u);
    assert.doesNotMatch(textResult.output, /"kind"\s*:/u);
  });

  void it("renders separate runtime connection and browser work states for online browser, lightweight, and incompatible bins", async () => {
    const binsById: Record<string, unknown> = {
      linuxdo: {
        id: "linuxdo",
        sourceAdapterId: "linuxdo",
        identityId: "account-linuxdo",
        config: { baseUrl: "https://linux.do" },
        runtimeSleep: { idleTimeoutSeconds: 0 },
        status: "active",
        execution: {
          status: "online",
          runtimeId: "runtime-linuxdo-1",
          lastHeartbeatAt: "2026-11-02T00:00:00.000Z",
          environment: {
            kind: "browser",
            browser: {
              available: true,
              profileReuseAfterRestart: true,
              power: { status: "stopped" },
            },
          },
        },
        sourceStateSnapshot: {
          freshness: "current",
          updatedAt: "2026-11-02T00:00:00.000Z",
        },
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
      },
      "rss-lightweight": {
        id: "rss-lightweight",
        sourceAdapterId: "rss",
        identityId: "account-rss",
        config: { feedUrl: "https://example.test/feed.xml" },
        runtimeSleep: { idleTimeoutSeconds: null },
        status: "active",
        execution: {
          status: "online",
          runtimeId: "runtime-rss-1",
          lastHeartbeatAt: "2026-11-02T00:00:00.000Z",
          environment: {
            kind: "lightweight",
            browser: {
              available: false,
              profileReuseAfterRestart: false,
              power: { status: "unavailable" },
            },
          },
        },
        sourceStateSnapshot: { freshness: "unknown" },
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
      },
      "rss-sleeping": {
        id: "rss-sleeping",
        sourceAdapterId: "rss",
        identityId: "account-rss-sleep",
        config: { feedUrl: "https://example.test/sleep.xml" },
        runtimeSleep: { idleTimeoutSeconds: 300 },
        status: "active",
        execution: {
          status: "sleeping",
          phase: "sleeping",
          runtimeId: "runtime-rss-sleep-1",
          lastHeartbeatAt: "2026-11-02T00:00:00.000Z",
        },
        sourceStateSnapshot: {
          freshness: "stale",
          updatedAt: "2026-11-02T00:00:00.000Z",
        },
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
      },
      "broken-browser": {
        id: "broken-browser",
        sourceAdapterId: "linuxdo",
        identityId: "account-broken",
        config: {},
        runtimeSleep: { idleTimeoutSeconds: 60 },
        status: "active",
        execution: {
          status: "incompatible",
          runtimeId: "runtime-broken-1",
          lastHeartbeatAt: "2026-11-02T00:00:00.000Z",
          error: { code: "runtime_configuration_incompatible" },
        },
        sourceStateSnapshot: { freshness: "unknown" },
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
      },
    };

    const customFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/meta") return Response.json(metadata);
      const match = /^\/bins\/([^/]+)$/u.exec(url.pathname);
      const bin = match?.[1] === undefined ? undefined : binsById[match[1]];
      return bin === undefined
        ? new Response("Not found", { status: 404 })
        : Response.json(bin);
    };

    const browserStructured = await run(["bin", "get", "linuxdo"], customFetch);
    assert.equal(browserStructured.exitCode, 0, browserStructured.output);
    const wire = JSON.parse(browserStructured.output) as {
      readonly data: {
        readonly execution: {
          readonly status: string;
          readonly environment?: {
            readonly kind: string;
            readonly browser: { readonly power: { readonly status: string } };
          };
        };
      };
    };
    assert.equal(wire.data.execution.status, "online");
    assert.equal(
      wire.data.execution.environment?.browser.power.status,
      "stopped",
    );

    const browserText = await run(
      ["bin", "get", "linuxdo", "--output", "text"],
      customFetch,
    );
    assert.equal(browserText.exitCode, 0, browserText.output);
    assert.match(browserText.output, /^Runtime connection: online$/mu);
    assert.match(browserText.output, /^Browser: stopped$/mu);

    const lightweightText = await run(
      ["bin", "get", "rss-lightweight", "--output", "text"],
      customFetch,
    );
    assert.equal(lightweightText.exitCode, 0, lightweightText.output);
    assert.match(lightweightText.output, /^Runtime connection: online$/mu);
    assert.match(
      lightweightText.output,
      /^Browser: unavailable \(lightweight runtime\)$/mu,
    );

    const incompatibleText = await run(
      ["bin", "get", "broken-browser", "--output", "text"],
      customFetch,
    );
    assert.equal(incompatibleText.exitCode, 0, incompatibleText.output);
    assert.match(
      incompatibleText.output,
      /^Runtime connection: incompatible \(runtime_configuration_incompatible\)$/mu,
    );
    assert.match(
      incompatibleText.output,
      /^Browser: unknown \(runtime incompatible\)$/mu,
    );

    const sleepingText = await run(
      ["bin", "get", "rss-sleeping", "--output", "text"],
      customFetch,
    );
    assert.equal(sleepingText.exitCode, 0, sleepingText.output);
    assert.match(sleepingText.output, /^Status: active$/mu);
    assert.match(
      sleepingText.output,
      /^Runtime connection: sleeping \(idle_policy\)$/mu,
    );
    assert.match(sleepingText.output, /^Runtime sleep: 300s idle$/mu);
  });

  void it("renders list output as readable text without changing structured shape", async () => {
    const service = createService();
    const result = await run(
      ["bin", "list", "--output", "text"],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /ID\s+ADAPTER\s+STATUS\s+RUNTIME/u);
    assert.match(result.output, /rss-main\s+rss\s+active\s+online/u);
    assert.doesNotMatch(result.output, /"kind"\s*:/u);
    assert.doesNotMatch(result.output, /"data"\s*:/u);
  });

  void it("renders an empty list with a readable text message", async () => {
    const service = createService([]);
    const result = await run(
      ["bin", "list", "--output", "text"],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /No bins configured\./u);
  });
});
