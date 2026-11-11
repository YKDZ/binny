import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveQueryContractVersion,
  publicApiProtocolVersion,
} from "@binny/contracts";

import { runCli } from "../../src/main.ts";

const requests: { readonly method: string; readonly url: URL }[] = [];
const runId = "d34687fc-8f3e-45bb-9fa2-1162eae5edc5";
const scheduleId = "a0a9c854-5f23-427b-9e62-1994db53e395";
const fetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  requests.push({ method: request.method, url });
  if (url.pathname === "/meta") {
    return Response.json({
      product: { name: "Binny", version: "1.2.3" },
      protocols: { httpApi: publicApiProtocolVersion },
      capabilities: ["archives.search", "archive.query-contract"],
      contracts: {
        archiveQuery: {
          version: archiveQueryContractVersion,
          path: "/meta/query",
        },
      },
    });
  }
  if (url.pathname === "/runs") {
    return Response.json({
      runs: [
        {
          runId,
          binId: "binny-one",
          action: "collect",
          status: "failed",
          createdAt: "2026-11-03T08:15:00.000Z",
        },
      ],
      nextCursor: "next-page-token",
    });
  }
  if (url.pathname === "/schedules") {
    return Response.json({
      schedules: [
        {
          scheduleId,
          binId: "binny-two",
          action: "collect",
          enabled: false,
          nextDueAt: "2026-11-10T08:00:00.000Z",
          createdAt: "2026-11-03T08:15:00.000Z",
        },
      ],
    });
  }
  if (url.pathname === `/bins/binny-one/runs/${runId}`) {
    return Response.json({
      runId,
      binId: "binny-one",
      action: "collect",
      sourceAdapterId: "example",
      sourceAdapterVersion: "1.2.3",
      status: "completed",
      trigger: { kind: "manual" },
      createdAt: "2026-11-03T08:15:00.000Z",
      referenceTime: "2026-11-03T08:15:00.000Z",
      startedAt: "2026-11-03T08:15:01.000Z",
      finishedAt: "2026-11-03T08:15:02.000Z",
      report: { progress: "finished" },
      result: {
        completedScopes: ["default"],
        commits: [],
        output: { itemCount: 1 },
        stopReason: { code: "completed", message: "Action completed." },
      },
    });
  }
  if (url.pathname === `/bins/binny-two/schedules/${scheduleId}`) {
    return Response.json({
      scheduleId,
      binId: "binny-two",
      expression: "0 0 0 1 1 *",
      timeZone: "UTC",
      action: "collect",
      params: { sourceUrl: "https://example.test/feed" },
      overlapPolicy: "queue",
      enabled: false,
      nextDueAt: "2026-11-10T08:00:00.000Z",
      createdAt: "2026-11-03T08:15:00.000Z",
      updatedAt: "2026-11-03T08:15:00.000Z",
    });
  }
  return new Response("Not found", { status: 404 });
};

void describe("run and schedule list commands", () => {
  void it("lists runs across bins through the global endpoint and keeps its cursor", async () => {
    let output = "";
    const exitCode = await runCli({
      argv: [
        "node",
        "binny",
        "run",
        "list",
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

    assert.equal(exitCode, 0, output);
    const request = requests.find(({ url }) => url.pathname === "/runs");
    assert.ok(request !== undefined);
    assert.equal(request.method, "GET");
    assert.deepEqual(Object.fromEntries(request.url.searchParams), {
      action: "collect",
      status: "failed",
      createdFrom: "2026-11-01T00:00:00Z",
      createdBefore: "2026-11-04T00:00:00Z",
      limit: "10",
    });
    assert.equal(
      requests.some(({ url }) => /^\/bins\/[^/]+\/runs$/u.test(url.pathname)),
      false,
    );

    const wire = JSON.parse(output) as {
      readonly kind: string;
      readonly variant: string;
      readonly data: {
        readonly runs: readonly {
          readonly runId: string;
          readonly binId: string;
        }[];
        readonly nextCursor?: string;
      };
    };
    assert.equal(wire.kind, "data");
    assert.equal(wire.variant, "listed");
    assert.equal(wire.data.runs[0]?.runId, runId);
    assert.equal(wire.data.runs[0]?.binId, "binny-one");
    assert.equal(wire.data.nextCursor, "next-page-token");
  });

  void it("lists schedules across bins with state filters through the global endpoint", async () => {
    let output = "";
    const exitCode = await runCli({
      argv: [
        "node",
        "binny",
        "schedule",
        "list",
        "--bin-id",
        "binny-two",
        "--action",
        "collect",
        "--enabled",
        "false",
      ],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        output += chunk;
      },
    });

    assert.equal(exitCode, 0, output);
    const request = requests.find(({ url }) => url.pathname === "/schedules");
    assert.ok(request !== undefined);
    assert.equal(request.method, "GET");
    assert.deepEqual(Object.fromEntries(request.url.searchParams), {
      binId: "binny-two",
      action: "collect",
      enabled: "false",
    });

    const wire = JSON.parse(output) as {
      readonly data: {
        readonly schedules: readonly {
          readonly scheduleId: string;
          readonly binId: string;
          readonly enabled: boolean;
        }[];
      };
    };
    assert.equal(wire.data.schedules[0]?.scheduleId, scheduleId);
    assert.equal(wire.data.schedules[0]?.binId, "binny-two");
    assert.equal(wire.data.schedules[0]?.enabled, false);
  });

  void it("renders run details as readable fields and separate JSON sections", async () => {
    let output = "";
    const exitCode = await runCli({
      argv: [
        "node",
        "binny",
        "run",
        "get",
        "binny-one",
        runId,
        "--output",
        "text",
      ],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        output += chunk;
      },
    });

    assert.equal(exitCode, 0, output);
    assert.match(output, /^Run\n/u);
    assert.match(output, /Bin: binny-one/u);
    assert.match(output, /Action: collect/u);
    assert.match(output, /Status: completed/u);
    assert.match(output, /Report:\n  \{/u);
    assert.match(output, /Result:\n  \{/u);
    assert.doesNotMatch(output, /"runId":/u);
  });

  void it("renders schedule details with parameters in a separate JSON section", async () => {
    let output = "";
    const exitCode = await runCli({
      argv: [
        "node",
        "binny",
        "schedule",
        "get",
        "binny-two",
        scheduleId,
        "--output",
        "text",
      ],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        output += chunk;
      },
    });

    assert.equal(exitCode, 0, output);
    assert.match(output, /^Schedule\n/u);
    assert.match(output, /Bin: binny-two/u);
    assert.match(output, /Action: collect/u);
    assert.match(output, /Expression: 0 0 0 1 1 \*/u);
    assert.match(output, /Enabled: false/u);
    assert.match(output, /Parameters:\n  \{/u);
    assert.match(output, /"sourceUrl": "https:\/\/example\.test\/feed"/u);
    assert.doesNotMatch(output, /"scheduleId":/u);
  });
});
