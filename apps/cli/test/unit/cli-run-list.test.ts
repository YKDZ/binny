import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicApiProtocolVersion } from "@binny/contracts";

import { runCli } from "../../src/main.ts";

const requests: { readonly method: string; readonly url: URL }[] = [];
const runId = "d34687fc-8f3e-45bb-9fa2-1162eae5edc5";
const fetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  requests.push({ method: request.method, url });
  if (url.pathname === "/meta") {
    return Response.json({
      product: { name: "Binny", version: "1.2.3" },
      protocols: { httpApi: publicApiProtocolVersion },
      capabilities: [
        "archives.search",
        "archives.aggregate",
        "archive.query-contract",
      ],
      contracts: { archiveQuery: { version: 1, path: "/meta/query" } },
    });
  }
  if (url.pathname === "/bins/binny-one/runs") {
    return Response.json({
      runs: [
        {
          runId,
          action: "collect",
          status: "failed",
          createdAt: "2026-11-03T08:15:00.000Z",
        },
      ],
      nextCursor: "next-page-token",
    });
  }
  return new Response("Not found", { status: 404 });
};

void describe("run list 命令", () => {
  void it("按显式运行条件读取摘要和下一页游标", async () => {
    let output = "";
    const exitCode = await runCli({
      argv: [
        "node",
        "binny",
        "run",
        "list",
        "binny-one",
        "--action",
        "collect",
        "--status",
        "failed",
        "--created-from",
        "2026-11-01T00:00:00Z",
        "--created-before",
        "2026-11-04T00:00:00Z",
        "--limit",
        "10",
      ],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        output += chunk;
      },
    });

    assert.equal(exitCode, 0);
    const request = requests.find(
      ({ url }) => url.pathname === "/bins/binny-one/runs",
    );
    assert.ok(request !== undefined);
    assert.equal(request.method, "GET");
    assert.deepEqual(Object.fromEntries(request.url.searchParams), {
      action: "collect",
      status: "failed",
      createdFrom: "2026-11-01T00:00:00Z",
      createdBefore: "2026-11-04T00:00:00Z",
      limit: "10",
    });

    const wire = JSON.parse(output) as {
      readonly kind: string;
      readonly variant: string;
      readonly data: {
        readonly runs: readonly { readonly runId: string }[];
        readonly nextCursor?: string;
      };
    };
    assert.equal(wire.kind, "data");
    assert.equal(wire.variant, "listed");
    assert.equal(wire.data.runs[0]?.runId, runId);
    assert.equal(wire.data.nextCursor, "next-page-token");
  });
});
