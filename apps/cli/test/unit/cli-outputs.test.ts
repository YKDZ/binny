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
    assert.match(text.stdout, /No archived items matched\./u);
    assert.doesNotMatch(text.stdout, /"kind"\s*:/u);
    assert.equal(requests, 2);
  });
});
