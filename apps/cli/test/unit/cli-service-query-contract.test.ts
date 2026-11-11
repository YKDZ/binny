import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveQueryContractVersion,
  publicApiProtocolVersion,
} from "@binny/contracts";

import { runCli } from "../../src/main.ts";

type RemoteOperation = {
  readonly method: string;
  readonly path: string;
  readonly description: string;
  readonly requestSchema?: Readonly<Record<string, unknown>>;
  readonly responseSchema?: Readonly<Record<string, unknown>>;
};

type RemoteContract = {
  readonly version: number;
  readonly operations: Readonly<Record<string, RemoteOperation>>;
};

const remoteSearchRequestSchema = {
  type: "object",
  title: "remote-search-request",
  properties: {
    text: { $ref: "#/$defs/text" },
    limit: { type: "integer", maximum: 100 },
  },
  $defs: {
    text: {
      type: "object",
      properties: {
        groups: { type: "array", items: { type: "array" } },
      },
    },
  },
  required: ["text"],
} as const;
const remoteSearchResponseSchema = {
  type: "object",
  title: "remote-search-response",
  properties: { results: { type: "array" } },
} as const;
const remoteBatchReadRequestSchema = {
  type: "object",
  title: "remote-batch-read-request",
  properties: { references: { type: "array", maxItems: 50 } },
  required: ["references"],
} as const;
const remoteBatchReadResponseSchema = {
  type: "object",
  title: "remote-batch-read-response",
  properties: { results: { type: "array" } },
  required: ["results"],
} as const;

const remoteContract: RemoteContract = {
  version: 99,
  operations: {
    search: {
      method: "POST",
      path: "/archives/search",
      description: "Search rules supplied by the connected service.",
      requestSchema: remoteSearchRequestSchema,
      responseSchema: remoteSearchResponseSchema,
    },
    batchRead: {
      method: "POST",
      path: "/archives/batch-read",
      description: "Batch-read rules supplied by the connected service.",
      requestSchema: remoteBatchReadRequestSchema,
      responseSchema: remoteBatchReadResponseSchema,
    },
  },
};

type FakeServiceOptions = {
  readonly productVersion?: string;
  readonly contractVersion?: number;
  readonly metadataContractVersion?: number;
  readonly queryContract?: unknown;
  readonly queryStatus?: number;
  readonly metadataStatus?: number;
  readonly unreachable?: boolean;
  readonly omitCapability?: boolean;
  readonly contractPath?: string;
};

function fakeService(options: FakeServiceOptions = {}) {
  const requests: {
    readonly method: string;
    readonly path: string;
    readonly origin: string;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (options.unreachable === true) {
      throw new TypeError("fetch failed");
    }
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname,
      origin: url.origin,
    });
    if (url.pathname === "/meta") {
      if (options.metadataStatus !== undefined) {
        return new Response("unavailable", { status: options.metadataStatus });
      }
      const contractVersion =
        options.metadataContractVersion ??
        options.contractVersion ??
        remoteContract.version;
      return Response.json({
        product: {
          name: "Binny",
          version: options.productVersion ?? "1.2.3",
        },
        protocols: { httpApi: publicApiProtocolVersion },
        capabilities:
          options.omitCapability === true
            ? ["archives.search"]
            : ["archives.search", "archive.query-contract"],
        contracts: {
          archiveQuery: {
            version: contractVersion,
            path: options.contractPath ?? "/meta/query",
          },
        },
      });
    }
    if (url.pathname === "/meta/query") {
      if (options.queryStatus !== undefined) {
        return new Response("unavailable", { status: options.queryStatus });
      }
      return Response.json(
        "queryContract" in options
          ? options.queryContract
          : {
              ...remoteContract,
              version: options.contractVersion ?? remoteContract.version,
            },
      );
    }
    return new Response("Not found", { status: 404 });
  };
  return { fetch, requests };
}

async function run(
  argv: readonly string[],
  fetch: typeof globalThis.fetch,
  apiUrl: string | null = "http://service.test",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli({
    argv: ["node", "binny", ...argv],
    identity: { commandName: "binny", version: "9.8.7" },
    fetch,
    ...(apiUrl === null ? {} : { apiUrl }),
    write: async ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { exitCode, stdout, stderr };
}

type StructuredEnvelope = {
  readonly schemaVersion: string;
  readonly command: string;
  readonly outputMode: string;
  readonly kind: string;
  readonly variant: string;
  readonly data: {
    readonly service: { readonly name: string; readonly version: string };
    readonly queryContract: {
      readonly version: number;
      readonly path: string;
      readonly operations: Readonly<Record<string, RemoteOperation>>;
    };
  };
};

function failureData(stderr: string): {
  readonly code: string;
  readonly message: string;
} {
  const wire = JSON.parse(stderr) as {
    readonly kind: string;
    readonly variant: string;
    readonly data: { readonly code: string; readonly message: string };
  };
  assert.equal(wire.kind, "failure");
  assert.equal(wire.variant, "apiError");
  return wire.data;
}

void describe("service query contract discovery", () => {
  void it("reads the selected service's /meta/query without local fallback", async () => {
    const service = fakeService({ contractVersion: 99 });
    const result = await run(["service", "query-contract"], service.fetch);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      service.requests.map(({ method, path }) => [method, path]),
      [
        ["GET", "/meta"],
        ["GET", "/meta/query"],
      ],
    );
    const envelope = JSON.parse(result.stdout) as StructuredEnvelope;
    assert.equal(envelope.schemaVersion, "3");
    assert.equal(envelope.command, "serviceQueryContract");
    assert.equal(envelope.outputMode, "structured");
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "discovered");
    assert.deepEqual(envelope.data.service, {
      name: "Binny",
      version: "1.2.3",
    });
    assert.equal(envelope.data.queryContract.version, 99);
    assert.equal(envelope.data.queryContract.path, "/meta/query");
    assert.deepEqual(Object.keys(envelope.data.queryContract.operations), [
      "search",
      "batch-read",
    ]);
    assert.deepEqual(
      envelope.data.queryContract.operations.search,
      remoteContract.operations.search,
    );
    assert.deepEqual(
      envelope.data.queryContract.operations["batch-read"],
      remoteContract.operations.batchRead,
    );
  });

  void it("narrows discovery by operation and requested part", async () => {
    const searchRequest = fakeService();
    const selected = await run(
      [
        "service",
        "query-contract",
        "--operation",
        "search",
        "--part",
        "request",
      ],
      searchRequest.fetch,
    );

    assert.equal(selected.exitCode, 0, selected.stderr);
    const selectedEnvelope = JSON.parse(selected.stdout) as StructuredEnvelope;
    assert.deepEqual(
      Object.keys(selectedEnvelope.data.queryContract.operations),
      ["search"],
    );
    const search = selectedEnvelope.data.queryContract.operations.search;
    assert.deepEqual(search?.requestSchema, remoteSearchRequestSchema);
    assert.equal(Object.hasOwn(search ?? {}, "responseSchema"), false);
    assert.deepEqual(
      searchRequest.requests.map(({ path }) => path),
      ["/meta", "/meta/query"],
    );

    const batchResponse = fakeService();
    const response = await run(
      [
        "service",
        "query-contract",
        "--operation",
        "batch-read",
        "--part",
        "response",
      ],
      batchResponse.fetch,
    );
    assert.equal(response.exitCode, 0, response.stderr);
    const responseEnvelope = JSON.parse(response.stdout) as StructuredEnvelope;
    assert.deepEqual(
      Object.keys(responseEnvelope.data.queryContract.operations),
      ["batch-read"],
    );
    const batchRead =
      responseEnvelope.data.queryContract.operations["batch-read"];
    assert.deepEqual(batchRead?.responseSchema, remoteBatchReadResponseSchema);
    assert.equal(Object.hasOwn(batchRead ?? {}, "requestSchema"), false);
  });

  void it("fails when the service contract lacks the selected operation", async () => {
    const service = fakeService({
      contractVersion: archiveQueryContractVersion,
      queryContract: {
        version: archiveQueryContractVersion,
        operations: { search: remoteContract.operations.search },
      },
    });
    const result = await run(
      ["service", "query-contract", "--operation", "batch-read"],
      service.fetch,
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    const failure = failureData(result.stderr);
    assert.equal(failure.code, "service_capability_unavailable");
    assert.match(failure.message, /batch-read/u);
    assert.match(failure.message, /service/iu);
  });

  void it("fails when the service contract lacks the selected part", async () => {
    const service = fakeService({
      contractVersion: archiveQueryContractVersion,
      queryContract: {
        version: archiveQueryContractVersion,
        operations: {
          search: {
            method: "POST",
            path: "/archives/search",
            description: "Search rules without a response declaration.",
            requestSchema: remoteSearchRequestSchema,
          },
        },
      },
    });
    const result = await run(
      [
        "service",
        "query-contract",
        "--operation",
        "search",
        "--part",
        "response",
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    const failure = failureData(result.stderr);
    assert.equal(failure.code, "service_query_contract_unavailable");
    assert.match(failure.message, /search/u);
    assert.match(failure.message, /response/u);
  });

  void it("fails when the service metadata and contract versions disagree", async () => {
    const service = fakeService({
      metadataContractVersion: archiveQueryContractVersion,
      contractVersion: archiveQueryContractVersion + 1,
    });
    const result = await run(["service", "query-contract"], service.fetch);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    const failure = failureData(result.stderr);
    assert.equal(failure.code, "incompatible_archive_query_contract");
    assert.match(failure.message, /version/iu);
  });

  void it("fails when the service contract cannot be read or parsed", async () => {
    const unavailable = fakeService({ queryStatus: 503 });
    const readFailure = await run(
      ["service", "query-contract"],
      unavailable.fetch,
    );
    assert.equal(readFailure.exitCode, 1);
    assert.equal(readFailure.stdout, "");
    assert.equal(
      failureData(readFailure.stderr).code,
      "service_query_contract_unavailable",
    );

    const invalid = fakeService({
      queryContract: {
        version: archiveQueryContractVersion,
        operations: { search: "not a declaration" },
      },
    });
    const parseFailure = await run(
      ["service", "query-contract"],
      invalid.fetch,
    );
    assert.equal(parseFailure.exitCode, 1);
    assert.equal(parseFailure.stdout, "");
    assert.equal(
      failureData(parseFailure.stderr).code,
      "service_query_contract_unavailable",
    );
  });

  void it("fails clearly when the service is unreachable", async () => {
    const service = fakeService({ unreachable: true });
    const result = await run(["service", "query-contract"], service.fetch);

    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    const failure = failureData(result.stderr);
    assert.equal(failure.code, "service_metadata_unavailable");
    assert.match(failure.message, /service|连接|unreachable/iu);
  });

  void it("fails when the service does not advertise query contract discovery", async () => {
    const service = fakeService({ omitCapability: true });
    const result = await run(["service", "query-contract"], service.fetch);

    assert.equal(result.exitCode, 1);
    const failure = failureData(result.stderr);
    assert.equal(failure.code, "service_capability_unavailable");
    assert.match(failure.message, /archive\.query-contract/u);
  });

  void it("renders the full selected schemas as readable text", async () => {
    const service = fakeService({
      contractVersion: archiveQueryContractVersion,
    });
    const result = await run(
      [
        "service",
        "query-contract",
        "--operation",
        "search",
        "--part",
        "request",
        "--output",
        "text",
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Service: Binny 1\.2\.3/u);
    assert.match(result.stdout, /Query contract: v3 at \/meta\/query/u);
    assert.match(
      result.stdout,
      /Operation: search \(POST \/archives\/search\)/u,
    );
    assert.match(result.stdout, /Request schema:/u);
    assert.match(result.stdout, /remote-search-request/u);
    assert.match(result.stdout, /#\/\$defs\/text/u);
    assert.doesNotMatch(
      result.stdout,
      /responseSchema|remote-search-response/u,
    );
    assert.doesNotMatch(result.stdout, /"kind"\s*:/u);
  });

  void it("keeps native discovery and help offline for the new command", async () => {
    let requests = 0;
    const failOnRequest: typeof globalThis.fetch = async () => {
      requests += 1;
      throw new Error("Offline discovery must not request the service.");
    };

    const summary = await run(
      ["service", "query-contract", "--schema"],
      failOnRequest,
    );
    assert.equal(summary.exitCode, 0, summary.stderr);
    const document = JSON.parse(summary.stdout) as {
      readonly kind: string;
      readonly path: readonly string[];
      readonly outputs: {
        readonly default: string;
        readonly modes: Readonly<Record<string, unknown>>;
      };
      readonly next: readonly { readonly target: string }[];
      readonly examples?: readonly {
        readonly argv: readonly string[];
        readonly outputMode?: string;
      }[];
    };
    assert.equal(document.kind, "summary");
    assert.deepEqual(document.path, ["service", "query-contract"]);
    assert.equal(document.outputs.default, "structured");
    assert.deepEqual(Object.keys(document.outputs.modes), [
      "structured",
      "text",
    ]);
    assert.ok(
      document.next.some(({ target }) => target === "input") &&
        document.next.some(({ target }) => target === "success:structured"),
    );
    const exampleArgv = (document.examples ?? []).map(({ argv }) =>
      argv.join(" "),
    );
    assert.ok(
      exampleArgv.includes("service query-contract --operation=search"),
    );
    assert.ok(
      exampleArgv.includes(
        "service query-contract --operation=batch-read --part=request",
      ),
    );
    assert.ok(
      (document.examples ?? []).some(
        ({ argv, outputMode }) =>
          outputMode === "text" && argv.includes("--part=response"),
      ),
    );

    const help = await run(
      ["service", "query-contract", "--help"],
      failOnRequest,
    );
    assert.equal(help.exitCode, 0, help.stderr);
    assert.match(help.stdout, /\/meta\/query/u);
    assert.match(help.stdout, /--operation/u);
    assert.match(help.stdout, /--part/u);
    assert.match(help.stdout, /never falls back/u);
    assert.ok(
      help.stdout.includes("'service' 'query-contract' '--operation=search'"),
    );
    assert.ok(
      help.stdout.includes(
        "'service' 'query-contract' '--operation=batch-read' '--part=request'",
      ),
    );
    assert.equal(requests, 0);
  });

  void it("guides service info to the live query contract command", async () => {
    const service = fakeService();
    const result = await run(
      ["service", "info", "--output", "text"],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /service query-contract --operation search/u);
    assert.deepEqual(
      service.requests.map(({ path }) => path),
      ["/meta"],
    );
  });

  void it("applies the leaf --url selection to the new command", async () => {
    const service = fakeService();
    const result = await run(
      [
        "service",
        "query-contract",
        "--operation",
        "search",
        "--part",
        "request",
        "--url",
        "http://selected.test",
      ],
      service.fetch,
      "http://environment.test",
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      service.requests.map(({ origin }) => origin),
      ["http://selected.test", "http://selected.test"],
    );
  });
});
