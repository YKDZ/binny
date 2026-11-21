import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveQueryContractVersion,
  manualRunListSummarySchema,
  publicApiProtocolVersion,
} from "@binny/contracts";

import { runCli } from "../../src/main.ts";

const requests: { readonly method: string; readonly url: URL }[] = [];
const runId = "d34687fc-8f3e-45bb-9fa2-1162eae5edc5";
const failedRunId = "b8c471b1-7154-4c9a-9f57-67f516c4d10b";
const cancelledRunId = "a4f38290-9f4e-4b3e-8d12-2d1c94c8e201";
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
          triggerType: "manual",
          status: "failed",
          stopReasonCode: "source_requires_human",
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
  if (url.pathname === `/bins/binny-one/runs/${failedRunId}`) {
    return Response.json({
      runId: failedRunId,
      binId: "binny-one",
      action: "collect",
      sourceAdapterId: "example",
      sourceAdapterVersion: "1.2.3",
      status: "failed",
      trigger: { kind: "manual" },
      createdAt: "2026-11-03T08:15:00.000Z",
      referenceTime: "2026-11-03T08:15:00.000Z",
      startedAt: "2026-11-03T08:15:01.000Z",
      finishedAt: "2026-11-03T08:15:31.000Z",
      report: {
        phase: "failed",
        stage: "reading-topic",
        target: "https://example.test/t/2401.json",
      },
      result: {
        completedScopes: [],
        commits: [],
        stopReason: {
          code: "linuxdo_source_unreachable",
          message: "Source request timed out after 30000ms.",
        },
        error: {
          code: "linuxdo_source_unreachable",
          message: "Source request timed out after 30000ms.",
          impact: "Topic was not collected.",
          requiresHuman: false,
          stage: "reading-topic",
          target: "https://example.test/t/2401.json",
          abortCause: "source_request_timeout",
        },
      },
    });
  }
  if (url.pathname === `/bins/binny-one/runs/${cancelledRunId}`) {
    return Response.json({
      runId: cancelledRunId,
      binId: "binny-one",
      action: "sync",
      sourceAdapterId: "example",
      sourceAdapterVersion: "1.2.3",
      status: "cancelled",
      trigger: {
        kind: "schedule",
        scheduleId,
        scheduledFor: "2026-11-03T08:15:00.000Z",
      },
      createdAt: "2026-11-03T08:15:00.000Z",
      referenceTime: "2026-11-03T08:15:00.000Z",
      startedAt: "2026-11-03T08:15:01.000Z",
      finishedAt: "2026-11-03T08:15:05.000Z",
      cancellationRequestedAt: "2026-11-03T08:15:04.000Z",
      stopConfirmedAt: "2026-11-03T08:15:05.000Z",
      report: {
        phase: "cancelled",
        stage: "scanning-post-feed",
        target: "https://example.test/posts.json",
        abortCause: "user_cancelled",
      },
      result: {
        completedScopes: [],
        commits: [],
        stopReason: {
          code: "cancelled",
          message: "Run was cancelled.",
        },
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
          readonly triggerType: string;
          readonly stopReasonCode?: string;
        }[];
        readonly nextCursor?: string;
      };
    };
    assert.equal(wire.kind, "data");
    assert.equal(wire.variant, "listed");
    assert.equal(wire.data.runs[0]?.runId, runId);
    assert.equal(wire.data.runs[0]?.binId, "binny-one");
    assert.equal(wire.data.runs[0]?.triggerType, "manual");
    assert.equal(wire.data.runs[0]?.stopReasonCode, "source_requires_human");
    assert.equal(wire.data.nextCursor, "next-page-token");
  });

  void it("includes triggerType and stopReasonCode across bins without calling run get per row", async () => {
    const crossBinRequests: string[] = [];
    const mixedRuns = [
      {
        runId: "11111111-1111-4111-8111-111111111111",
        binId: "linuxdo",
        action: "check",
        triggerType: "manual",
        status: "completed",
        stopReasonCode: "completed",
        createdAt: "2026-11-04T09:00:00.000Z",
        startedAt: "2026-11-04T09:00:01.000Z",
        finishedAt: "2026-11-04T09:00:05.000Z",
      },
      {
        runId: "22222222-2222-4222-8222-222222222222",
        binId: "linuxdo",
        action: "sync",
        triggerType: "schedule",
        status: "failed",
        stopReasonCode: "linuxdo_source_unreachable",
        createdAt: "2026-11-04T08:00:00.000Z",
        startedAt: "2026-11-04T08:00:01.000Z",
        finishedAt: "2026-11-04T08:00:31.000Z",
      },
      {
        runId: "33333333-3333-4333-8333-333333333333",
        binId: "qoder",
        action: "sync",
        triggerType: "schedule",
        status: "cancelled",
        stopReasonCode: "cancelled",
        createdAt: "2026-11-04T07:00:00.000Z",
        startedAt: "2026-11-04T07:00:01.000Z",
        finishedAt: "2026-11-04T07:00:10.000Z",
      },
      {
        runId: "44444444-4444-4444-8444-444444444444",
        binId: "rss-main",
        action: "collect",
        triggerType: "manual",
        status: "cancelled",
        stopReasonCode: "cancelled_before_execution",
        createdAt: "2026-11-04T06:00:00.000Z",
        finishedAt: "2026-11-04T06:00:02.000Z",
      },
      {
        runId: "55555555-5555-4555-8555-555555555555",
        binId: "rss-main",
        action: "collect",
        triggerType: "manual",
        status: "executing",
        createdAt: "2026-11-04T05:00:00.000Z",
        startedAt: "2026-11-04T05:00:01.000Z",
      },
    ] as const;

    const mixedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      crossBinRequests.push(url.pathname);
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
        return Response.json({ runs: mixedRuns });
      }
      return new Response("Not found", { status: 404 });
    };

    let structuredOutput = "";
    const structuredExit = await runCli({
      argv: ["node", "binny", "run", "list"],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch: mixedFetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        structuredOutput += chunk;
      },
    });
    assert.equal(structuredExit, 0, structuredOutput);
    assert.deepEqual(crossBinRequests, ["/meta", "/runs"]);

    const wire = JSON.parse(structuredOutput) as {
      readonly data: {
        readonly runs: readonly {
          readonly runId: string;
          readonly binId: string;
          readonly action: string;
          readonly triggerType: string;
          readonly status: string;
          readonly stopReasonCode?: string;
        }[];
      };
    };
    assert.equal(wire.data.runs.length, 5);
    assert.deepEqual(
      wire.data.runs.map((entry) => ({
        binId: entry.binId,
        action: entry.action,
        triggerType: entry.triggerType,
        status: entry.status,
        stopReasonCode: entry.stopReasonCode,
      })),
      [
        {
          binId: "linuxdo",
          action: "check",
          triggerType: "manual",
          status: "completed",
          stopReasonCode: "completed",
        },
        {
          binId: "linuxdo",
          action: "sync",
          triggerType: "schedule",
          status: "failed",
          stopReasonCode: "linuxdo_source_unreachable",
        },
        {
          binId: "qoder",
          action: "sync",
          triggerType: "schedule",
          status: "cancelled",
          stopReasonCode: "cancelled",
        },
        {
          binId: "rss-main",
          action: "collect",
          triggerType: "manual",
          status: "cancelled",
          stopReasonCode: "cancelled_before_execution",
        },
        {
          binId: "rss-main",
          action: "collect",
          triggerType: "manual",
          status: "executing",
          stopReasonCode: undefined,
        },
      ],
    );

    let textOutput = "";
    const textExit = await runCli({
      argv: ["node", "binny", "run", "list", "--output", "text"],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch: mixedFetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        textOutput += chunk;
      },
    });
    assert.equal(textExit, 0, textOutput);
    assert.match(
      textOutput,
      /linuxdo\s+check\s+manual\s+completed\s+completed/u,
    );
    assert.match(
      textOutput,
      /linuxdo\s+sync\s+schedule\s+failed\s+linuxdo_source_unreachable/u,
    );
    assert.match(
      textOutput,
      /qoder\s+sync\s+schedule\s+cancelled\s+cancelled/u,
    );
    assert.match(
      textOutput,
      /rss-main\s+collect\s+manual\s+cancelled\s+cancelled_before_execution/u,
    );
    assert.match(textOutput, /rss-main\s+collect\s+manual\s+executing\s+-/u);

    assert.equal(
      manualRunListSummarySchema.safeParse({
        runId: "66666666-6666-4666-8666-666666666666",
        binId: "linuxdo",
        action: "sync",
        triggerType: "schedule",
        status: "failed",
        createdAt: "2026-11-04T08:00:00.000Z",
      }).success,
      false,
    );
    assert.equal(
      manualRunListSummarySchema.safeParse({
        runId: "77777777-7777-4777-8777-777777777777",
        binId: "linuxdo",
        action: "sync",
        triggerType: "manual",
        status: "queued",
        stopReasonCode: "completed",
        createdAt: "2026-11-04T08:00:00.000Z",
      }).success,
      false,
    );
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

  void it("renders failure stage, target, and abortCause in run get text and structured outputs", async () => {
    let textOutput = "";
    const textExitCode = await runCli({
      argv: [
        "node",
        "binny",
        "run",
        "get",
        "binny-one",
        failedRunId,
        "--output",
        "text",
      ],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        textOutput += chunk;
      },
    });

    assert.equal(textExitCode, 0, textOutput);
    assert.match(textOutput, /^Stage: reading-topic$/mu);
    assert.match(
      textOutput,
      /^Target: https:\/\/example\.test\/t\/2401\.json$/mu,
    );
    assert.match(textOutput, /^Abort cause: source_request_timeout$/mu);

    let structuredOutput = "";
    const structuredExitCode = await runCli({
      argv: ["node", "binny", "run", "get", "binny-one", failedRunId],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        structuredOutput += chunk;
      },
    });
    assert.equal(structuredExitCode, 0, structuredOutput);
    const wire = JSON.parse(structuredOutput) as {
      readonly data: {
        readonly result?: {
          readonly error?: {
            readonly stage?: string;
            readonly target?: string;
            readonly abortCause?: string;
          };
        };
      };
    };
    assert.equal(wire.data.result?.error?.stage, "reading-topic");
    assert.equal(
      wire.data.result?.error?.target,
      "https://example.test/t/2401.json",
    );
    assert.equal(wire.data.result?.error?.abortCause, "source_request_timeout");

    let cancelledText = "";
    const cancelledExitCode = await runCli({
      argv: [
        "node",
        "binny",
        "run",
        "get",
        "binny-one",
        cancelledRunId,
        "--output",
        "text",
      ],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        cancelledText += chunk;
      },
    });
    assert.equal(cancelledExitCode, 0, cancelledText);
    assert.match(cancelledText, /^Stage: scanning-post-feed$/mu);
    assert.match(
      cancelledText,
      /^Target: https:\/\/example\.test\/posts\.json$/mu,
    );
    assert.match(cancelledText, /^Abort cause: user_cancelled$/mu);
  });

  void it("renders queueReason and lastWakeError in run get, run list, and bin get outputs", async () => {
    const queuedRunId = "c5e41230-1111-4222-8333-444455556666";
    const wakeError = {
      code: "runtime_wake_start_failed",
      message: "Docker socket unavailable",
      at: "2026-11-20T10:00:05.000Z",
    };
    const wakeFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
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
              runId: queuedRunId,
              binId: "binny-sleep",
              action: "collect",
              triggerType: "schedule",
              status: "queued",
              queueReason: "runtime_sleeping",
              lastWakeError: wakeError,
              createdAt: "2026-11-20T10:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === `/bins/binny-sleep/runs/${queuedRunId}`) {
        return Response.json({
          runId: queuedRunId,
          binId: "binny-sleep",
          action: "collect",
          sourceAdapterId: "rss-atom",
          sourceAdapterVersion: "1.0.0",
          status: "queued",
          trigger: {
            kind: "schedule",
            scheduleId,
            scheduledFor: "2026-11-20T10:00:00.000Z",
          },
          queueReason: "runtime_sleeping",
          lastWakeError: wakeError,
          createdAt: "2026-11-20T10:00:00.000Z",
          referenceTime: "2026-11-20T10:00:00.000Z",
        });
      }
      if (url.pathname === "/bins/binny-sleep") {
        return Response.json({
          id: "binny-sleep",
          sourceAdapterId: "rss-atom",
          identityId: "binny-sleep",
          config: {},
          runtimeSleep: { idleTimeoutSeconds: 0 },
          status: "active",
          execution: {
            status: "sleeping",
            phase: "sleeping",
            lastWakeError: wakeError,
          },
          sourceStateSnapshot: { freshness: "unknown" },
          createdAt: "2026-11-20T09:00:00.000Z",
          updatedAt: "2026-11-20T10:00:05.000Z",
        });
      }
      return new Response("Not found", { status: 404 });
    };

    let runGetOutput = "";
    const runGetText = await runCli({
      argv: [
        "node",
        "binny",
        "run",
        "get",
        "binny-sleep",
        queuedRunId,
        "--output",
        "text",
      ],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch: wakeFetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        runGetOutput += chunk;
      },
    });
    assert.equal(runGetText, 0, runGetOutput);
    assert.match(runGetOutput, /^Queue reason: runtime_sleeping$/mu);
    assert.match(
      runGetOutput,
      /^Last wake error: runtime_wake_start_failed: Docker socket unavailable \(2026-11-20T10:00:05\.000Z\)$/mu,
    );

    let runListOutput = "";
    const runListText = await runCli({
      argv: ["node", "binny", "run", "list", "--output", "text"],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch: wakeFetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        runListOutput += chunk;
      },
    });
    assert.equal(runListText, 0, runListOutput);
    assert.match(runListOutput, /queueReason=runtime_sleeping/u);
    assert.match(
      runListOutput,
      /lastWakeError=runtime_wake_start_failed \(Docker socket unavailable\)/u,
    );

    let runListStructured = "";
    const runListJsonExit = await runCli({
      argv: ["node", "binny", "run", "list"],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch: wakeFetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        runListStructured += chunk;
      },
    });
    assert.equal(runListJsonExit, 0, runListStructured);
    const parsedList = JSON.parse(runListStructured) as {
      readonly data: {
        readonly runs: readonly {
          readonly queueReason?: string;
          readonly lastWakeError?: { readonly code: string };
        }[];
      };
    };
    assert.equal(parsedList.data.runs[0]?.queueReason, "runtime_sleeping");
    assert.equal(
      parsedList.data.runs[0]?.lastWakeError?.code,
      "runtime_wake_start_failed",
    );

    let binGetOutput = "";
    const binGetText = await runCli({
      argv: ["node", "binny", "bin", "get", "binny-sleep", "--output", "text"],
      identity: { commandName: "binny", version: "9.8.7" },
      fetch: wakeFetch,
      apiUrl: "http://service.test",
      write: async ({ chunk }) => {
        binGetOutput += chunk;
      },
    });
    assert.equal(binGetText, 0, binGetOutput);
    assert.match(
      binGetOutput,
      /^Last wake error: runtime_wake_start_failed: Docker socket unavailable/mu,
    );
  });
});
