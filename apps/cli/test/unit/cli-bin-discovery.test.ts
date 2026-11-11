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
        browserIdleTimeoutSeconds: null,
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
    assert.match(textResult.output, /Runtime: offline/u);
    assert.match(textResult.output, /Source state: unknown/u);
    assert.doesNotMatch(textResult.output, /"kind"\s*:/u);
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
