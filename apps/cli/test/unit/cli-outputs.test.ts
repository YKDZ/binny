import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  archiveQueryContractVersion,
  publicApiProtocolVersion,
} from "@binny/contracts";

import { runCli } from "../../src/main.ts";

const metadata = {
  product: { name: "Binny", version: "1.2.3" },
  protocols: { httpApi: publicApiProtocolVersion },
  capabilities: ["archives.search", "archive.query-contract"],
  contracts: {
    archiveQuery: {
      version: archiveQueryContractVersion,
      path: "/meta/query",
    },
  },
};

async function run(
  argv: readonly string[],
  fetch: typeof globalThis.fetch,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli({
    argv: ["node", "binny", ...argv],
    identity: { commandName: "binny", version: "9.8.7" },
    fetch,
    apiUrl: "http://service.test",
    write: async ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { exitCode, stdout, stderr };
}

void describe("native CLI output modes", () => {
  void it("defaults to the structured envelope and selects text explicitly", async () => {
    let requests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests += 1;
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/meta") return Response.json(metadata);
      if (url.pathname === "/bins") return Response.json({ bins: [] });
      return new Response("Not found", { status: 404 });
    };

    const structured = await run(["bin", "list"], fetch);
    assert.equal(structured.exitCode, 0, structured.stderr);
    assert.equal(requests, 2);
    const envelope = JSON.parse(structured.stdout) as {
      readonly schemaVersion: string;
      readonly command: string;
      readonly outputMode: string;
      readonly kind: string;
      readonly variant: string;
      readonly data: { readonly bins: readonly unknown[] };
    };
    assert.equal(envelope.schemaVersion, "3");
    assert.equal(envelope.command, "binList");
    assert.equal(envelope.outputMode, "structured");
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "listed");
    assert.deepEqual(envelope.data.bins, []);

    requests = 0;
    const text = await run(["bin", "list", "--output", "text"], fetch);
    assert.equal(text.exitCode, 0, text.stderr);
    assert.equal(requests, 2);
    assert.equal(text.stdout, "No bins configured.\n");
    assert.equal(text.stderr, "");
  });

  void it("accepts --output only after the selected leaf command", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error(
        "Misplaced output selectors must not request the service.",
      );
    };
    const misplaced = await run(["--output", "text", "bin", "list"], fetch);

    assert.equal(misplaced.exitCode, 2);
    const failure = JSON.parse(misplaced.stderr) as {
      readonly kind: string;
      readonly issues: readonly { readonly code: string }[];
    };
    assert.equal(failure.kind, "usageFailure");
    assert.ok(failure.issues.some(({ code }) => code === "unknownOption"));
  });

  void it("reports an invalid output mode without a business envelope", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("Invalid output modes must not request the service.");
    };
    const result = await run(["bin", "list", "--output", "bogus"], fetch);

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    const failure = JSON.parse(result.stderr) as {
      readonly schemaVersion: string;
      readonly command: string;
      readonly kind: string;
      readonly issues: readonly { readonly code: string }[];
      readonly outputMode?: string;
      readonly variant?: string;
    };
    assert.equal(failure.schemaVersion, "3");
    assert.equal(failure.command, "binList");
    assert.equal(failure.kind, "usageFailure");
    assert.equal(failure.outputMode, undefined);
    assert.equal(failure.variant, undefined);
    assert.ok(failure.issues.some(({ code }) => code === "invalidOutputMode"));
  });

  void it("saves resource bytes through --save-to while --output selects presentation", async () => {
    const resourceId = "550e8400-e29b-41d4-a716-446655440000";
    const bytes = Buffer.from("resource bytes");
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/meta") return Response.json(metadata);
      if (url.pathname === `/resources/${resourceId}`) {
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.length),
            etag: `"${"a".repeat(64)}"`,
            "x-binny-resource-id": resourceId,
          },
        });
      }
      return new Response("Not found", { status: 404 });
    };
    const directory = await mkdtemp(path.join(tmpdir(), "binny-output-"));
    try {
      const textPath = path.join(directory, "resource.bin");
      const text = await run(
        [
          "archive",
          "resource",
          resourceId,
          "--save-to",
          textPath,
          "--output",
          "text",
        ],
        fetch,
      );
      assert.equal(text.exitCode, 0, text.stderr);
      assert.match(text.stdout, /已保存归档资源至/u);
      assert.equal(text.stderr, "");
      assert.deepEqual(await readFile(textPath), bytes);

      const structuredPath = path.join(directory, "structured.bin");
      const structured = await run(
        ["archive", "resource", resourceId, "--save-to", structuredPath],
        fetch,
      );
      assert.equal(structured.exitCode, 0, structured.stderr);
      const envelope = JSON.parse(structured.stdout) as {
        readonly outputMode: string;
        readonly kind: string;
        readonly variant: string;
        readonly data: {
          readonly resourceId: string;
          readonly savedTo: string;
        };
      };
      assert.equal(envelope.outputMode, "structured");
      assert.equal(envelope.kind, "data");
      assert.equal(envelope.variant, "downloaded");
      assert.equal(envelope.data.resourceId, resourceId);
      assert.equal(envelope.data.savedTo, structuredPath);
      assert.deepEqual(await readFile(structuredPath), bytes);
      assert.deepEqual(requests, [
        "/meta",
        `/resources/${resourceId}`,
        "/meta",
        `/resources/${resourceId}`,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

void describe("native command examples", () => {
  void it("executes argv discovered from the installed contract", async () => {
    const offline = await run(["archive", "search", "--schema"], async () => {
      throw new Error("Schema discovery must not request the service.");
    });
    assert.equal(offline.exitCode, 0, offline.stderr);
    const summary = JSON.parse(offline.stdout) as {
      readonly examples: readonly {
        readonly argv: readonly string[];
        readonly shell: string;
        readonly outputMode?: string;
      }[];
    };
    const structuredExample = summary.examples.find(
      ({ shell, outputMode }) =>
        outputMode === undefined &&
        shell.includes("--query=") &&
        !shell.includes('"distribution"') &&
        !shell.includes("timeWindow"),
    );
    assert.ok(structuredExample, "search should publish a minimal example");
    const textExample = summary.examples.find(
      ({ outputMode }) => outputMode === "text",
    );
    assert.ok(textExample, "search should publish an explicit text example");

    let requests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests += 1;
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/meta") return Response.json(metadata);
      if (url.pathname === "/archives/search")
        return Response.json({
          snapshot: { asOf: "0", mode: "current" },
          candidatesIncluded: true,
          results: [],
          hasMore: false,
        });
      return new Response("Not found", { status: 404 });
    };

    const structured = await run(structuredExample.argv, fetch);
    assert.equal(structured.exitCode, 0, structured.stderr);
    const envelope = JSON.parse(structured.stdout) as {
      readonly outputMode: string;
      readonly kind: string;
      readonly variant: string;
    };
    assert.equal(envelope.outputMode, "structured");
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "found");

    requests = 0;
    const text = await run(textExample.argv, fetch);
    assert.equal(text.exitCode, 0, text.stderr);
    assert.match(text.stdout, /Snapshot: 0/u);
    assert.match(text.stdout, /Candidate order: observedAt desc/u);
    assert.match(text.stdout, /No archived items matched\./u);
    assert.doesNotMatch(text.stdout, /"kind"\s*:/u);
    assert.equal(requests, 2);

    const distributionFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/meta") return Response.json(metadata);
      if (url.pathname === "/archives/search")
        return Response.json({
          snapshot: { asOf: "5", mode: "current" },
          candidatesIncluded: false,
          results: [],
          hasMore: false,
          distribution: {
            by: "bin",
            order: "count",
            totalItems: "10",
            groups: [
              { kind: "bin", binId: "b-top", itemCount: "10" },
              { kind: "bin", binId: "b-low", itemCount: "2" },
            ],
            hasMore: false,
          },
        });
      return new Response("Not found", { status: 404 });
    };
    const distributionText = await run(
      [
        "archive",
        "search",
        "--query",
        '{"includeCandidates":false,"distribution":{"by":"bin","order":"count","limit":10}}',
        "--output",
        "text",
      ],
      distributionFetch,
    );
    assert.equal(distributionText.exitCode, 0, distributionText.stderr);
    assert.match(
      distributionText.stdout,
      /Distribution order: numeric itemCount desc \(group key asc\)/u,
    );
    assert.match(distributionText.stdout, /- Bin b-top: 10 items/u);
  });
});

void describe("native VNC human session commands", () => {
  void it("streams waiting reasons then emits host, port, and password on ready, extracting host from --url", async () => {
    const sessionId = "650e8400-e29b-41d4-a716-446655440000";
    const requestedAt = "2026-11-21T10:00:00.000Z";
    const updatedAt = "2026-11-21T10:00:02.000Z";
    const readyAt = "2026-11-21T10:00:02.000Z";
    let pollStep = 0;

    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.host, "192.168.2.23:8787");
      if (url.pathname === "/meta") return Response.json(metadata);
      if (
        request.method === "POST" &&
        url.pathname === "/bins/linuxdo/human-sessions"
      ) {
        pollStep = 0;
        return Response.json(
          {
            sessionId,
            binId: "linuxdo",
            status: "pending",
            queueReason: "runtime_sleeping",
            requestedAt,
            updatedAt: requestedAt,
            password: "Ab12Cd34",
          },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === `/bins/linuxdo/human-sessions/${sessionId}`
      ) {
        pollStep += 1;
        if (pollStep === 1) {
          return Response.json({
            sessionId,
            binId: "linuxdo",
            status: "pending",
            queueReason: "runtime_waking",
            requestedAt,
            updatedAt: "2026-11-21T10:00:01.000Z",
          });
        }
        return Response.json({
          sessionId,
          binId: "linuxdo",
          status: "ready",
          port: 49_520,
          requestedAt,
          updatedAt,
          readyAt,
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const structured = await run(
      ["human", "open", "linuxdo", "--url", "http://192.168.2.23:8787"],
      fetch,
    );
    assert.equal(structured.exitCode, 0, structured.stderr);
    const lines = structured.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines[0]?.kind, "stream");
    assert.equal(lines[1]?.kind, "record");
    assert.equal(lines[1]?.variant, "waiting");
    assert.deepEqual(lines[1]?.data, {
      sessionId,
      binId: "linuxdo",
      status: "pending",
      queueReason: "runtime_sleeping",
    });
    assert.equal(lines[2]?.kind, "record");
    assert.equal(lines[2]?.variant, "waiting");
    assert.deepEqual(lines[2]?.data, {
      sessionId,
      binId: "linuxdo",
      status: "pending",
      queueReason: "runtime_waking",
    });
    assert.equal(lines[3]?.kind, "record");
    assert.equal(lines[3]?.variant, "ready");
    assert.deepEqual(lines[3]?.data, {
      sessionId,
      binId: "linuxdo",
      status: "ready",
      host: "192.168.2.23",
      port: 49_520,
      password: "Ab12Cd34",
      requestedAt,
      updatedAt,
      readyAt,
    });
    assert.equal(lines[4]?.kind, "streamSuccess");

    const textResult = await run(
      [
        "human",
        "open",
        "linuxdo",
        "--url",
        "http://192.168.2.23:8787",
        "--output",
        "text",
      ],
      fetch,
    );
    assert.equal(textResult.exitCode, 0, textResult.stderr);
    assert.match(
      textResult.stdout,
      /Human session waiting: status=pending, reason=runtime_sleeping/u,
    );
    assert.match(
      textResult.stdout,
      /Human session waiting: status=pending, reason=runtime_waking/u,
    );
    assert.match(textResult.stdout, /^Host: 192\.168\.2\.23$/mu);
    assert.match(textResult.stdout, /^Port: 49520$/mu);
    assert.match(textResult.stdout, /^Password: Ab12Cd34$/mu);
    assert.doesNotMatch(textResult.stdout, /vncviewer|ssh|http/iu);
  });

  void it("fails human open when a queued session closes before becoming ready", async () => {
    const sessionId = "650e8400-e29b-41d4-a716-446655440001";
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/meta") return Response.json(metadata);
      if (
        request.method === "POST" &&
        url.pathname === "/bins/linuxdo/human-sessions"
      ) {
        return Response.json(
          {
            sessionId,
            binId: "linuxdo",
            status: "pending",
            queueReason: "bin_busy",
            requestedAt: "2026-11-21T10:00:00.000Z",
            updatedAt: "2026-11-21T10:00:00.000Z",
            password: "Xy90Zw12",
          },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === `/bins/linuxdo/human-sessions/${sessionId}`
      ) {
        return Response.json({
          sessionId,
          binId: "linuxdo",
          status: "closed",
          requestedAt: "2026-11-21T10:00:00.000Z",
          updatedAt: "2026-11-21T10:01:00.000Z",
          closedAt: "2026-11-21T10:01:00.000Z",
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const result = await run(["human", "open", "linuxdo"], fetch);
    assert.equal(result.exitCode, 1);
    const failure = JSON.parse(result.stderr) as {
      readonly kind: string;
      readonly variant: string;
      readonly data: { readonly code: string };
    };
    assert.equal(failure.kind, "failure");
    assert.equal(failure.variant, "apiError");
    assert.equal(failure.data.code, "human_session_closed");
  });

  void it("projects pure session state in human get and human close without port, host, or password", async () => {
    const sessionId = "650e8400-e29b-41d4-a716-446655440002";
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/meta") return Response.json(metadata);
      if (
        request.method === "GET" &&
        url.pathname === `/bins/linuxdo/human-sessions/${sessionId}`
      ) {
        return Response.json({
          sessionId,
          binId: "linuxdo",
          status: "ready",
          port: 49_521,
          requestedAt: "2026-11-21T10:00:00.000Z",
          updatedAt: "2026-11-21T10:00:02.000Z",
          readyAt: "2026-11-21T10:00:02.000Z",
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === `/bins/linuxdo/human-sessions/${sessionId}/close`
      ) {
        return Response.json({
          sessionId,
          binId: "linuxdo",
          status: "closing",
          requestedAt: "2026-11-21T10:00:00.000Z",
          updatedAt: "2026-11-21T10:00:05.000Z",
          readyAt: "2026-11-21T10:00:02.000Z",
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const got = await run(["human", "get", "linuxdo", sessionId], fetch);
    assert.equal(got.exitCode, 0, got.stderr);
    const gotEnvelope = JSON.parse(got.stdout) as {
      readonly data: Record<string, unknown>;
    };
    assert.equal(gotEnvelope.data.status, "ready");
    assert.equal("port" in gotEnvelope.data, false);
    assert.equal("host" in gotEnvelope.data, false);
    assert.equal("password" in gotEnvelope.data, false);

    const closed = await run(["human", "close", "linuxdo", sessionId], fetch);
    assert.equal(closed.exitCode, 0, closed.stderr);
    const closedEnvelope = JSON.parse(closed.stdout) as {
      readonly data: Record<string, unknown>;
    };
    assert.equal(closedEnvelope.data.status, "closing");
    assert.equal("port" in closedEnvelope.data, false);
    assert.equal("password" in closedEnvelope.data, false);

    const schemaResult = await run(["human", "open", "--schema"], fetch);
    assert.equal(schemaResult.exitCode, 0, schemaResult.stderr);
    const summary = JSON.parse(schemaResult.stdout) as {
      readonly outputs: {
        readonly modes: {
          readonly structured: { readonly delivery: string };
          readonly text: { readonly delivery: string };
        };
      };
    };
    assert.equal(summary.outputs.modes.structured.delivery, "stream");
    assert.equal(summary.outputs.modes.text.delivery, "stream");
  });
});
