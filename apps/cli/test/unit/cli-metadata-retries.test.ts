import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import {
  archiveQueryContractVersion,
  publicApiProtocolVersion,
} from "@binny/contracts";

import { runCli, type CliRuntime } from "../../src/main.ts";

const validMetadata = {
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

const validQueryContract = {
  version: archiveQueryContractVersion,
  operations: {
    search: {
      method: "POST",
      path: "/archives/search",
      description: "Search archived items.",
      requestSchema: { type: "object" },
      responseSchema: { type: "object" },
    },
  },
};

type CliFailurePayload = {
  readonly kind: string;
  readonly variant: string;
  readonly data: {
    readonly code: string;
    readonly message: string;
    readonly reason?: string;
    readonly httpStatus?: number;
    readonly attempts?: number;
  };
};

async function invokeCli(
  argv: readonly string[],
  options: {
    readonly apiUrl?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly metadataRetry?: CliRuntime["metadataRetry"];
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli({
    argv: ["node", "binny", ...argv],
    identity: { commandName: "binny", version: "1.0.0" },
    apiUrl: options.apiUrl ?? "http://service.test",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.metadataRetry === undefined
      ? {}
      : { metadataRetry: options.metadataRetry }),
    write: async ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { exitCode, stdout, stderr };
}

function parseFailure(stderr: string): CliFailurePayload["data"] {
  const wire = JSON.parse(stderr) as CliFailurePayload;
  assert.equal(wire.kind, "failure");
  assert.equal(wire.variant, "apiError");
  return wire.data;
}

void describe("metadata GET retries and failure classification", () => {
  void it("recovers from transient connection errors, timeouts, and retryable HTTP statuses on /meta with exponential backoff", async () => {
    const sleepDelays: number[] = [];
    let metaAttempts = 0;

    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/meta") {
        metaAttempts += 1;
        if (metaAttempts === 1) {
          throw new TypeError("fetch failed");
        }
        if (metaAttempts === 2) {
          return new Response("service unavailable", { status: 503 });
        }
        return Response.json(validMetadata);
      }
      if (url.pathname === "/bins") {
        return Response.json({ bins: [] });
      }
      return new Response("Not found", { status: 404 });
    };

    const result = await invokeCli(["bin", "list"], {
      fetch,
      metadataRetry: {
        maxRetries: 2,
        baseDelayMs: 50,
        attemptTimeoutMs: 100,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(metaAttempts, 3);
    assert.deepEqual(sleepDelays, [50, 100]);
    const envelope = JSON.parse(result.stdout) as {
      readonly kind: string;
      readonly data: { readonly bins: readonly unknown[] };
    };
    assert.equal(envelope.kind, "data");
    assert.deepEqual(envelope.data.bins, []);
  });

  void it("recovers after a per-attempt timeout aborted through the request signal", async () => {
    const sleepDelays: number[] = [];
    let metaAttempts = 0;
    let sawAbortedSignal = false;

    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/meta") {
        metaAttempts += 1;
        if (metaAttempts === 1) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                sawAbortedSignal = true;
                reject(init.signal?.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          });
        }
        return Response.json(validMetadata);
      }
      return new Response("Not found", { status: 404 });
    };

    const result = await invokeCli(["service", "info"], {
      fetch,
      metadataRetry: {
        maxRetries: 1,
        baseDelayMs: 25,
        attemptTimeoutMs: 30,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(sawAbortedSignal, true);
    assert.equal(metaAttempts, 2);
    assert.deepEqual(sleepDelays, [25]);
  });

  void it("retries all transient HTTP statuses (408, 429, 500, 502, 503, 504) and reports the last cause on exhaustion", async () => {
    for (const status of [408, 429, 500, 502, 503, 504] as const) {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const fetch: typeof globalThis.fetch = async () => {
        attempts += 1;
        return new Response("temporary failure", { status });
      };

      const structured = await invokeCli(["service", "info"], {
        fetch,
        metadataRetry: {
          maxRetries: 2,
          baseDelayMs: 10,
          attemptTimeoutMs: 50,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
        },
      });
      assert.equal(structured.exitCode, 1);
      assert.equal(attempts, 3);
      assert.deepEqual(sleepDelays, [10, 20]);
      const failure = parseFailure(structured.stderr);
      assert.equal(failure.code, "service_metadata_unavailable");
      assert.equal(failure.reason, "http_status");
      assert.equal(failure.httpStatus, status);
      assert.equal(failure.attempts, 3);
      assert.match(failure.message, new RegExp(`HTTP ${String(status)}`, "u"));
      assert.match(failure.message, /3 attempts/u);
    }

    let mixedAttempts = 0;
    const mixedFetch: typeof globalThis.fetch = async () => {
      mixedAttempts += 1;
      if (mixedAttempts === 1) {
        return new Response("bad gateway", { status: 502 });
      }
      if (mixedAttempts === 2) {
        throw new TypeError("fetch failed");
      }
      return await new Promise<Response>(() => {});
    };

    const exhaustedText = await invokeCli(
      ["service", "info", "--output", "text"],
      {
        fetch: mixedFetch,
        metadataRetry: {
          maxRetries: 2,
          baseDelayMs: 0,
          attemptTimeoutMs: 25,
          sleep: async () => {},
        },
      },
    );
    assert.equal(exhaustedText.exitCode, 1);
    assert.equal(exhaustedText.stdout, "");
    assert.equal(mixedAttempts, 3);
    assert.match(exhaustedText.stderr, /Request failed:.*timed out/u);
    assert.match(exhaustedText.stderr, /Reason: timeout/u);
    assert.match(exhaustedText.stderr, /Attempts: 3/u);
  });

  void it("reports connection errors distinctly when retries are exhausted", async () => {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    };

    const result = await invokeCli(["bin", "list"], {
      fetch,
      metadataRetry: {
        maxRetries: 2,
        baseDelayMs: 0,
        attemptTimeoutMs: 50,
        sleep: async () => {},
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(attempts, 3);
    const failure = parseFailure(result.stderr);
    assert.equal(failure.code, "service_metadata_unavailable");
    assert.equal(failure.reason, "connection_error");
    assert.equal(failure.httpStatus, undefined);
    assert.equal(failure.attempts, 3);
    assert.match(failure.message, /connection failed/u);
  });

  void it("does not retry deterministic HTTP status, invalid JSON, invalid contract, or version mismatches on /meta", async () => {
    for (const status of [400, 401, 403, 404] as const) {
      let attempts = 0;
      const result = await invokeCli(["bin", "list"], {
        fetch: async () => {
          attempts += 1;
          return new Response("nope", { status });
        },
        metadataRetry: {
          maxRetries: 2,
          baseDelayMs: 10,
          attemptTimeoutMs: 50,
          sleep: async () => {
            throw new Error("Deterministic errors must not sleep or retry.");
          },
        },
      });
      assert.equal(result.exitCode, 1);
      assert.equal(attempts, 1);
      const failure = parseFailure(result.stderr);
      assert.equal(failure.code, "service_metadata_unavailable");
      assert.equal(failure.reason, "http_status");
      assert.equal(failure.httpStatus, status);
      assert.equal(failure.attempts, 1);
      assert.match(failure.message, new RegExp(`HTTP ${String(status)}`, "u"));
    }

    let invalidJsonAttempts = 0;
    const invalidJson = await invokeCli(["service", "info"], {
      fetch: async () => {
        invalidJsonAttempts += 1;
        return new Response("<html>proxy error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
      metadataRetry: {
        maxRetries: 2,
        baseDelayMs: 10,
        attemptTimeoutMs: 50,
        sleep: async () => {
          throw new Error("Invalid JSON must not retry.");
        },
      },
    });
    assert.equal(invalidJson.exitCode, 1);
    assert.equal(invalidJsonAttempts, 1);
    const jsonFailure = parseFailure(invalidJson.stderr);
    assert.equal(jsonFailure.code, "service_metadata_unavailable");
    assert.equal(jsonFailure.reason, "invalid_json");
    assert.equal(jsonFailure.attempts, 1);
    assert.match(jsonFailure.message, /invalid JSON/iu);
    assert.doesNotMatch(jsonFailure.message, /connection failed/iu);

    let invalidContractAttempts = 0;
    const invalidContract = await invokeCli(["service", "info"], {
      fetch: async () => {
        invalidContractAttempts += 1;
        return Response.json({
          product: { name: "Binny", version: "1.2.3" },
          protocols: { httpApi: "not-an-integer" },
        });
      },
      metadataRetry: {
        maxRetries: 2,
        baseDelayMs: 10,
        attemptTimeoutMs: 50,
        sleep: async () => {
          throw new Error("Invalid metadata contract must not retry.");
        },
      },
    });
    assert.equal(invalidContract.exitCode, 1);
    assert.equal(invalidContractAttempts, 1);
    const contractFailure = parseFailure(invalidContract.stderr);
    assert.equal(contractFailure.code, "service_metadata_unavailable");
    assert.equal(contractFailure.reason, "invalid_contract");
    assert.equal(contractFailure.attempts, 1);
    assert.match(
      contractFailure.message,
      /invalid service metadata contract/iu,
    );

    let mismatchAttempts = 0;
    const mismatchFetch: typeof globalThis.fetch = async () => {
      mismatchAttempts += 1;
      return Response.json({
        ...validMetadata,
        protocols: { httpApi: publicApiProtocolVersion + 10 },
      });
    };
    const mismatch = await invokeCli(["bin", "list"], {
      fetch: mismatchFetch,
      metadataRetry: {
        maxRetries: 2,
        baseDelayMs: 10,
        attemptTimeoutMs: 50,
        sleep: async () => {
          throw new Error("Protocol mismatch must not retry.");
        },
      },
    });
    assert.equal(mismatch.exitCode, 1);
    assert.equal(mismatchAttempts, 1);
    const mismatchFailure = parseFailure(mismatch.stderr);
    assert.equal(mismatchFailure.code, "incompatible_http_api_protocol");
    assert.match(
      mismatchFailure.message,
      new RegExp(String(publicApiProtocolVersion + 10), "u"),
    );
    assert.match(
      mismatchFailure.message,
      new RegExp(String(publicApiProtocolVersion), "u"),
    );

    const inspected = await invokeCli(["service", "info"], {
      fetch: mismatchFetch,
    });
    assert.equal(inspected.exitCode, 0, inspected.stderr);
  });

  void it("applies finite retries and distinct failure classification to /meta/query", async () => {
    let queryAttempts = 0;
    const recovered = await invokeCli(["service", "query-contract"], {
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/meta") return Response.json(validMetadata);
        if (url.pathname === "/meta/query") {
          queryAttempts += 1;
          if (queryAttempts === 1) {
            return new Response("unavailable", { status: 503 });
          }
          return Response.json(validQueryContract);
        }
        return new Response("Not found", { status: 404 });
      },
      metadataRetry: {
        maxRetries: 2,
        baseDelayMs: 0,
        attemptTimeoutMs: 50,
        sleep: async () => {},
      },
    });
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert.equal(queryAttempts, 2);

    let deterministicQueryAttempts = 0;
    const notFound = await invokeCli(["service", "query-contract"], {
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/meta") return Response.json(validMetadata);
        if (url.pathname === "/meta/query") {
          deterministicQueryAttempts += 1;
          return new Response("missing", { status: 404 });
        }
        return new Response("Not found", { status: 404 });
      },
      metadataRetry: {
        maxRetries: 2,
        baseDelayMs: 0,
        attemptTimeoutMs: 50,
        sleep: async () => {},
      },
    });
    assert.equal(notFound.exitCode, 1);
    assert.equal(deterministicQueryAttempts, 1);
    const notFoundFailure = parseFailure(notFound.stderr);
    assert.equal(notFoundFailure.code, "service_query_contract_unavailable");
    assert.equal(notFoundFailure.reason, "http_status");
    assert.equal(notFoundFailure.httpStatus, 404);
    assert.equal(notFoundFailure.attempts, 1);

    let jsonAttempts = 0;
    const invalidQueryJson = await invokeCli(["service", "query-contract"], {
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/meta") return Response.json(validMetadata);
        if (url.pathname === "/meta/query") {
          jsonAttempts += 1;
          return new Response("{not-json", { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    assert.equal(invalidQueryJson.exitCode, 1);
    assert.equal(jsonAttempts, 1);
    const jsonQueryFailure = parseFailure(invalidQueryJson.stderr);
    assert.equal(jsonQueryFailure.code, "service_query_contract_unavailable");
    assert.equal(jsonQueryFailure.reason, "invalid_json");
    assert.match(jsonQueryFailure.message, /invalid JSON/iu);

    let schemaAttempts = 0;
    const invalidQuerySchema = await invokeCli(["service", "query-contract"], {
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/meta") return Response.json(validMetadata);
        if (url.pathname === "/meta/query") {
          schemaAttempts += 1;
          return Response.json({
            version: archiveQueryContractVersion,
            operations: { search: "invalid" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    assert.equal(invalidQuerySchema.exitCode, 1);
    assert.equal(schemaAttempts, 1);
    const schemaQueryFailure = parseFailure(invalidQuerySchema.stderr);
    assert.equal(schemaQueryFailure.code, "service_query_contract_unavailable");
    assert.equal(schemaQueryFailure.reason, "invalid_contract");
    assert.match(
      schemaQueryFailure.message,
      /invalid service archive query contract/iu,
    );
  });

  void it("reuses the metadata result within one CLI invocation and re-fetches on the next invocation", async () => {
    let metaCalls = 0;
    let serviceVersion = "1.0.0";
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/meta") {
        metaCalls += 1;
        return Response.json({
          ...validMetadata,
          product: { name: "Binny", version: serviceVersion },
        });
      }
      if (url.pathname === "/archives/search") {
        return Response.json({
          snapshot: { asOf: "0", mode: "current" },
          candidatesIncluded: true,
          results: [],
          hasMore: false,
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const firstSearch = await invokeCli(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({ text: { groups: [["alpha"]] } }),
      ],
      { fetch },
    );
    assert.equal(firstSearch.exitCode, 0, firstSearch.stderr);
    assert.equal(metaCalls, 1);

    serviceVersion = "2.0.0";
    const secondInfo = await invokeCli(["service", "info"], { fetch });
    assert.equal(secondInfo.exitCode, 0, secondInfo.stderr);
    assert.equal(metaCalls, 2);
    const envelope = JSON.parse(secondInfo.stdout) as {
      readonly data: { readonly product: { readonly version: string } };
    };
    assert.equal(envelope.data.product.version, "2.0.0");

    // Exhaustion within a single invocation must also run only one retry cycle.
    let exhaustedMetaCalls = 0;
    const failingSearch = await invokeCli(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({ text: { groups: [["alpha"]] } }),
      ],
      {
        fetch: async () => {
          exhaustedMetaCalls += 1;
          return new Response("unavailable", { status: 503 });
        },
        metadataRetry: {
          maxRetries: 2,
          baseDelayMs: 0,
          attemptTimeoutMs: 50,
          sleep: async () => {},
        },
      },
    );
    assert.equal(failingSearch.exitCode, 1);
    assert.equal(exhaustedMetaCalls, 3);
  });

  void it("verifies transient recovery, timeout abort, invalid JSON, and cross-command re-confirmation over real local HTTP", async () => {
    let mode: "recover_503" | "recover_timeout" | "invalid_json" | "healthy" =
      "recover_503";
    let metaCount = 0;
    let currentVersion = "1.0.0";
    const openResponses: http.ServerResponse[] = [];

    const server = http.createServer((request, response) => {
      if (request.url === "/meta") {
        metaCount += 1;
        if (mode === "recover_503" && metaCount === 1) {
          response.writeHead(503, { "content-type": "text/plain" });
          response.end("try again");
          return;
        }
        if (mode === "recover_timeout" && metaCount === 1) {
          openResponses.push(response);
          response.writeHead(200, { "content-type": "application/json" });
          return;
        }
        if (mode === "invalid_json") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<html>not json</html>");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...validMetadata,
            product: { name: "Binny", version: currentVersion },
          }),
        );
        return;
      }
      if (request.url === "/bins") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ bins: [] }));
        return;
      }
      response.writeHead(404);
      response.end("not found");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const apiUrl = `http://127.0.0.1:${String(address.port)}`;

    try {
      const retryConfig: CliRuntime["metadataRetry"] = {
        maxRetries: 2,
        baseDelayMs: 10,
        attemptTimeoutMs: 60,
      };

      // 1. Transient 503 recovers over real HTTP.
      const recovered503 = await invokeCli(["bin", "list"], {
        apiUrl,
        metadataRetry: retryConfig,
      });
      assert.equal(recovered503.exitCode, 0, recovered503.stderr);
      assert.equal(metaCount, 2);

      // 2. Hanging attempt times out and recovers on retry over real HTTP.
      mode = "recover_timeout";
      metaCount = 0;
      const recoveredTimeout = await invokeCli(["service", "info"], {
        apiUrl,
        metadataRetry: retryConfig,
      });
      assert.equal(recoveredTimeout.exitCode, 0, recoveredTimeout.stderr);
      assert.equal(metaCount, 2);

      // 3. Invalid JSON on HTTP 200 fails immediately without retrying.
      mode = "invalid_json";
      metaCount = 0;
      const badJson = await invokeCli(["service", "info"], {
        apiUrl,
        metadataRetry: retryConfig,
      });
      assert.equal(badJson.exitCode, 1);
      assert.equal(metaCount, 1);
      assert.equal(parseFailure(badJson.stderr).reason, "invalid_json");

      // 4. Subsequent command re-queries metadata and sees updated service state.
      mode = "healthy";
      currentVersion = "2.1.0";
      metaCount = 0;
      const nextCommand = await invokeCli(["service", "info"], {
        apiUrl,
        metadataRetry: retryConfig,
      });
      assert.equal(nextCommand.exitCode, 0, nextCommand.stderr);
      assert.equal(metaCount, 1);
      const parsed = JSON.parse(nextCommand.stdout) as {
        readonly data: { readonly product: { readonly version: string } };
      };
      assert.equal(parsed.data.product.version, "2.1.0");
    } finally {
      for (const response of openResponses) {
        response.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
