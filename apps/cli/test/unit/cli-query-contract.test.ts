import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  archiveQueryContractVersion,
  publicApiProtocolVersion,
} from "@binny/contracts";

import { runCli } from "../../src/main.ts";

const matchingMetadata = {
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

function fakeService(options: {
  readonly httpApiVersion?: number;
  readonly archiveQueryVersion?: number;
  readonly productVersion?: string;
  readonly searchResponse?: unknown;
  readonly searchFailure?: {
    readonly status: number;
    readonly body: unknown;
  };
}) {
  const requests: {
    readonly method: string;
    readonly path: string;
    readonly search: string;
    readonly origin: string;
    readonly body?: unknown;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "POST" ? await request.clone().json() : undefined;
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      origin: url.origin,
      ...(body === undefined ? {} : { body }),
    });
    if (url.pathname === "/meta") {
      return Response.json({
        ...matchingMetadata,
        product: {
          ...matchingMetadata.product,
          version: options.productVersion ?? matchingMetadata.product.version,
        },
        protocols: {
          httpApi: options.httpApiVersion ?? matchingMetadata.protocols.httpApi,
        },
        contracts: {
          archiveQuery: {
            version: options.archiveQueryVersion ?? archiveQueryContractVersion,
            path: "/meta/query",
          },
        },
      });
    }
    if (url.pathname === "/meta/query") {
      return Response.json({
        version: options.archiveQueryVersion ?? archiveQueryContractVersion,
        operations: {},
      });
    }
    if (url.pathname === "/archives/search") {
      if (options.searchFailure !== undefined) {
        return Response.json(options.searchFailure.body, {
          status: options.searchFailure.status,
        });
      }
      return Response.json(
        options.searchResponse ?? {
          snapshot: { asOf: "0", mode: "current" },
          candidatesIncluded: true,
          results: [],
          hasMore: false,
        },
      );
    }
    if (url.pathname === "/bins/rss-main/actions") {
      const actionName = url.searchParams.get("action");
      if (actionName === "missing") {
        return Response.json(
          {
            error: {
              code: "action_not_found",
              message: "信源适配器没有声明这个动作。",
              path: ["action"],
            },
          },
          { status: 404 },
        );
      }
      const action = {
        description: "读取 feed 中的新内容。",
        params: { type: "object", properties: {} },
        output: { type: "object", properties: {} },
        report: { type: "object", properties: {} },
      };
      if (actionName === null)
        return Response.json({
          actions: {
            check: { description: "Check whether a feed is available." },
            collect: { description: action.description },
          },
        });
      return Response.json({
        actions: { [actionName]: action },
      });
    }
    if (url.pathname === "/bins/rss-main/config-schema")
      return Response.json({
        sourceAdapterId: "rss",
        sourceAdapterVersion: "1.0.0",
        configSchema: { type: "object", properties: {} },
      });
    if (url.pathname === "/bins/rss-main/extension-fields")
      return Response.json({
        sourceAdapterId: "rss",
        sourceAdapterVersion: "1.0.0",
        fields: {
          category: {
            type: "string",
            nullable: false,
            required: false,
            description: "The item's category.",
            allowedValues: ["post", "reply"],
            operations: ["eq", "in"],
          },
          labels: {
            type: "array",
            nullable: true,
            required: false,
            description: "Labels on the item.",
            itemType: "string",
            allowedItemValues: ["news", "release"],
            operations: ["has", "hasAny"],
          },
        },
      });
    if (url.pathname === "/bins") return Response.json({ bins: [] });
    return new Response("Not found", { status: 404 });
  };
  return { fetch, requests };
}

async function run(
  argv: readonly string[],
  fetch: typeof globalThis.fetch,
  version = "9.8.7",
  apiUrl: string | null = "http://service.test",
  readStdin?: () => Promise<string>,
) {
  let output = "";
  const exitCode = await runCli({
    argv: ["node", "binny", ...argv],
    identity: { commandName: "binny", version },
    fetch,
    ...(apiUrl === null ? {} : { apiUrl }),
    ...(readStdin === undefined ? {} : { readStdin }),
    write: async ({ chunk }) => {
      output += chunk;
    },
  });
  return { exitCode, output };
}

function failureData(output: string): Record<string, unknown> {
  const wire = JSON.parse(output) as {
    readonly kind: string;
    readonly variant: string;
    readonly data: Record<string, unknown>;
  };
  assert.equal(wire.kind, "failure");
  assert.equal(wire.variant, "apiError");
  return wire.data;
}

void describe("查询服务发现", () => {
  void it("service info reads metadata without fetching the full query contract", async () => {
    const service = fakeService({});
    const result = await run(["service", "info"], service.fetch);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      service.requests.map(({ method, path }) => [method, path]),
      [["GET", "/meta"]],
    );
    assert.match(result.output, /archive\.query-contract/u);
    const wire = JSON.parse(result.output) as {
      readonly data: {
        readonly contracts: {
          readonly archiveQuery: { readonly path: string };
        };
        readonly queryContract?: unknown;
      };
    };
    assert.equal(wire.data.contracts.archiveQuery.path, "/meta/query");
    assert.equal(Object.hasOwn(wire.data, "queryContract"), false);
  });

  void it("service info text lists capabilities and contract links", async () => {
    const service = fakeService({});
    const result = await run(
      ["service", "info", "--output", "text"],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /Product: Binny 1\.2\.3/u);
    assert.match(result.output, /archive\.query-contract/u);
    assert.match(result.output, /Archive query v3: \/meta\/query/u);
    assert.doesNotMatch(result.output, /"kind"\s*:/u);
  });

  void it("reads one adapter's declared extension fields as structured data", async () => {
    const service = fakeService({});
    const result = await run(
      ["bin", "extension-fields", "rss-main"],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.output);
    const wire = JSON.parse(result.output) as {
      readonly data: {
        readonly sourceAdapterId: string;
        readonly fields: Readonly<
          Record<
            string,
            {
              readonly operations: readonly string[];
              readonly allowedItemValues?: readonly string[];
            }
          >
        >;
      };
    };
    assert.equal(wire.data.sourceAdapterId, "rss");
    assert.deepEqual(wire.data.fields.labels?.operations, ["has", "hasAny"]);
    assert.deepEqual(wire.data.fields.labels?.allowedItemValues, [
      "news",
      "release",
    ]);
    assert.deepEqual(
      service.requests.map(({ method, path }) => [method, path]),
      [
        ["GET", "/meta"],
        ["GET", "/bins/rss-main/extension-fields"],
      ],
    );
  });

  void it("renders extension-field discovery as concise readable text", async () => {
    const service = fakeService({});
    const result = await run(
      ["bin", "extension-fields", "rss-main", "--output", "text"],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /Source adapter: rss@1\.0\.0/u);
    assert.match(result.output, /- category: string/u);
    assert.match(result.output, /Allowed values: \["post","reply"\]/u);
    assert.match(result.output, /- labels: array \(nullable\)/u);
    assert.match(result.output, /Allowed item values: \["news","release"\]/u);
    assert.match(result.output, /Operations: has, hasAny/u);
    assert.match(
      result.output,
      /Missing and null extension values do not match filters\./u,
    );
    assert.doesNotMatch(result.output, /"kind"\s*:/u);
  });

  void it("returns structured allowed values for a local fixed-search enum failure", async () => {
    const service = fakeService({});
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          text: { in: "headline", groups: [["model"]] },
        }),
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 1);
    assert.deepEqual(failureData(result.output), {
      code: "invalid_input",
      message: 'Invalid option: expected one of "title"|"body"|"both"',
      path: ["text", "in"],
      diagnostic: { allowedValues: ["title", "body", "both"] },
    });
    assert.deepEqual(service.requests, []);
  });

  void it("keeps local fixed-search diagnostics identical across input sources", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "binny-search-diagnostic-"),
    );
    try {
      const query = JSON.stringify({
        text: { in: "headline", groups: [["model"]] },
      });
      const queryFile = path.join(directory, "query.json");
      await writeFile(queryFile, query, "utf8");
      const service = fakeService({});
      const inline = await run(
        ["archive", "search", "--query", query],
        service.fetch,
      );
      const fromFile = await run(
        ["archive", "search", "--query-file", queryFile],
        service.fetch,
      );
      const fromStdin = await run(
        ["archive", "search", "--query-stdin"],
        service.fetch,
        "9.8.7",
        "http://service.test",
        async () => query,
      );

      assert.deepEqual(
        failureData(fromFile.output),
        failureData(inline.output),
      );
      assert.deepEqual(
        failureData(fromStdin.output),
        failureData(inline.output),
      );
      assert.deepEqual(service.requests, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("renders local fixed-search candidates and paths as readable text", async () => {
    const service = fakeService({});
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          text: { in: "headline", groups: [["model"]] },
        }),
        "--output",
        "text",
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 1, result.output);
    assert.match(
      result.output,
      /Request failed: Invalid option: expected one of "title"\|"body"\|"both"/u,
    );
    assert.match(result.output, /Path: text\.in/u);
    assert.match(result.output, /Allowed values: "title", "body", "both"/u);
    assert.deepEqual(service.requests, []);
  });

  void it("labels unresolved extension operations as protocol operations", async () => {
    const service = fakeService({});
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: ["kimi"],
          extensions: {
            sourceAdapterId: "kimi",
            filters: { kind: { op: "contains", value: "changelog" } },
          },
        }),
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 1);
    assert.deepEqual(failureData(result.output), {
      code: "invalid_input",
      message:
        "Invalid discriminator value. Expected 'eq' | 'in' | 'has' | 'hasAny'",
      path: ["extensions", "filters", "kind", "op"],
      diagnostic: {
        protocolOperations: ["eq", "in", "has", "hasAny"],
        discovery: { sourceAdapterId: "kimi", binId: "kimi" },
      },
    });
    assert.deepEqual(service.requests, []);

    const text = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: ["kimi"],
          extensions: {
            sourceAdapterId: "kimi",
            filters: { kind: { op: "contains", value: "changelog" } },
          },
        }),
        "--output",
        "text",
      ],
      service.fetch,
    );
    assert.equal(text.exitCode, 1, text.output);
    assert.match(text.output, /Path: extensions\.filters\.kind\.op/u);
    assert.match(
      text.output,
      /Protocol operations: "eq", "in", "has", "hasAny"/u,
    );
    assert.match(
      text.output,
      /Discover extension fields: binny bin extension-fields kimi/u,
    );
    assert.doesNotMatch(text.output, /Allowed operations:/u);
  });

  void it("passes server extension diagnostics through structured and text output", async () => {
    const diagnostic = {
      allowedItemValues: ["basic", "pro"],
      allowedOperations: ["has", "hasAny"],
      discovery: {
        sourceAdapterId: "kimi",
        sourceAdapterVersion: "0.1.0",
        binId: "kimi-main",
      },
    };
    const service = fakeService({
      searchFailure: {
        status: 400,
        body: {
          error: {
            code: "invalid_input",
            message:
              'The value for extension field "tiers" must match its declared string type and allowed values ["basic","pro"].',
            path: ["extensions", "filters", "tiers", "values", 0],
            diagnostic,
          },
        },
      },
    });
    const query = JSON.stringify({
      bins: ["kimi-main"],
      extensions: {
        sourceAdapterId: "kimi",
        filters: { tiers: { op: "hasAny", values: ["enterprise"] } },
      },
    });
    const structured = await run(
      ["archive", "search", "--query", query],
      service.fetch,
    );

    assert.equal(structured.exitCode, 1);
    assert.deepEqual(failureData(structured.output), {
      code: "invalid_input",
      message:
        'The value for extension field "tiers" must match its declared string type and allowed values ["basic","pro"].',
      path: ["extensions", "filters", "tiers", "values", 0],
      diagnostic,
    });

    const text = await run(
      ["archive", "search", "--query", query, "--output", "text"],
      service.fetch,
    );
    assert.equal(text.exitCode, 1, text.output);
    assert.match(text.output, /Path: extensions\.filters\.tiers\.values\[0\]/u);
    assert.match(text.output, /Allowed item values: "basic", "pro"/u);
    assert.match(text.output, /Allowed operations: "has", "hasAny"/u);
    assert.match(
      text.output,
      /Discover extension fields: binny bin extension-fields kimi-main/u,
    );
    assert.doesNotMatch(text.output, /Allowed values:/u);
  });

  void it("keeps open extension value failures free of invented candidates", async () => {
    const service = fakeService({
      searchFailure: {
        status: 400,
        body: {
          error: {
            code: "invalid_input",
            message:
              'The value for extension field "section" must match its declared string type.',
            path: ["extensions", "filters", "section", "value"],
            diagnostic: {
              allowedOperations: ["eq", "in"],
              discovery: {
                sourceAdapterId: "kimi",
                sourceAdapterVersion: "0.1.0",
                binId: "kimi-main",
              },
            },
          },
        },
      },
    });
    const text = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: ["kimi-main"],
          extensions: {
            sourceAdapterId: "kimi",
            filters: { section: { op: "eq", value: 7 } },
          },
        }),
        "--output",
        "text",
      ],
      service.fetch,
    );

    assert.equal(text.exitCode, 1, text.output);
    assert.match(text.output, /Path: extensions\.filters\.section\.value/u);
    assert.match(text.output, /Allowed operations: "eq", "in"/u);
    assert.match(
      text.output,
      /Discover extension fields: binny bin extension-fields kimi-main/u,
    );
    assert.doesNotMatch(text.output, /Allowed values:|Allowed item values:/u);
  });

  void it("keeps invalid discovery identities inside the input error envelope", async () => {
    const service = fakeService({});
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: ["rss-main"],
          extensions: {
            sourceAdapterId: "",
            filters: { category: { op: "eq", value: "news" } },
          },
        }),
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 1, result.output);
    assert.deepEqual(failureData(result.output), {
      code: "invalid_input",
      message: "信源适配器标识不能为空。",
      path: ["extensions", "sourceAdapterId"],
    });
    assert.deepEqual(service.requests, []);

    const text = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: ["rss-main"],
          extensions: {
            sourceAdapterId: "",
            filters: { category: { op: "eq", value: "news" } },
          },
        }),
        "--output",
        "text",
      ],
      service.fetch,
    );
    assert.equal(text.exitCode, 1, text.output);
    assert.match(text.output, /Request failed: 信源适配器标识不能为空。/u);
    assert.match(text.output, /Path: extensions\.sourceAdapterId/u);
    assert.doesNotMatch(
      text.output,
      /Allowed values:|Allowed item values:|Protocol operations:|Discover extension fields:/u,
    );
  });

  void it("omits invalid identities from extension discovery hints", async () => {
    const service = fakeService({});
    const emptyAdapter = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: ["rss-main"],
          extensions: {
            sourceAdapterId: "",
            filters: { kind: { op: "contains", value: "changelog" } },
          },
        }),
      ],
      service.fetch,
    );
    assert.equal(emptyAdapter.exitCode, 1, emptyAdapter.output);
    assert.deepEqual(failureData(emptyAdapter.output), {
      code: "invalid_input",
      message:
        "Invalid discriminator value. Expected 'eq' | 'in' | 'has' | 'hasAny'",
      path: ["extensions", "filters", "kind", "op"],
      diagnostic: {
        protocolOperations: ["eq", "in", "has", "hasAny"],
      },
    });

    const invalidBin = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: [""],
          extensions: {
            sourceAdapterId: "kimi",
            filters: { kind: { op: "contains", value: "changelog" } },
          },
        }),
      ],
      service.fetch,
    );
    assert.equal(invalidBin.exitCode, 1, invalidBin.output);
    assert.deepEqual(failureData(invalidBin.output), {
      code: "invalid_input",
      message:
        "Invalid discriminator value. Expected 'eq' | 'in' | 'has' | 'hasAny'",
      path: ["extensions", "filters", "kind", "op"],
      diagnostic: {
        protocolOperations: ["eq", "in", "has", "hasAny"],
        discovery: { sourceAdapterId: "kimi" },
      },
    });
    assert.deepEqual(service.requests, []);
  });

  void it("产品版本不同但公开协议兼容时仍执行查询", async () => {
    const service = fakeService({ productVersion: "2.4.0" });
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          text: { groups: [["needle"]] },
        }),
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      service.requests.map(({ method, path }) => [method, path]),
      [
        ["GET", "/meta"],
        ["POST", "/archives/search"],
      ],
    );
  });

  void it("显式 --url 覆盖服务地址环境变量", async () => {
    const service = fakeService({});
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          text: { groups: [["needle"]] },
        }),
        "--url",
        "http://selected.test",
      ],
      service.fetch,
      "9.8.7",
      "http://from-environment.test",
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      service.requests.map(({ origin }) => origin),
      ["http://selected.test", "http://selected.test"],
    );
  });

  void it("未提供显式地址时使用环境地址", async () => {
    const service = fakeService({});
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          text: { groups: [["needle"]] },
        }),
      ],
      service.fetch,
      "9.8.7",
      "http://from-environment.test",
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      service.requests.map(({ origin }) => origin),
      ["http://from-environment.test", "http://from-environment.test"],
    );
  });

  void it("未提供显式地址或环境地址时使用默认服务地址", async () => {
    const service = fakeService({});
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          text: { groups: [["needle"]] },
        }),
      ],
      service.fetch,
      "9.8.7",
      null,
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      service.requests.map(({ origin }) => origin),
      ["http://localhost:3000", "http://localhost:3000"],
    );
  });

  void it("forwards term groups in fixed search and returns concise candidates", async () => {
    const query = {
      bins: ["rss-main"],
      text: {
        in: "both",
        groups: [["GPT", "Claude"], ["released"]],
      },
      includeCandidates: true,
      limit: 1,
    };
    const searchResponse = {
      snapshot: { asOf: "12", mode: "current" },
      candidatesIncluded: true,
      hasMore: false,
      results: [
        {
          itemId: "750e8400-e29b-41d4-a716-446655440000",
          sourceKey: { namespace: "rss", key: "entry/12" },
          title: "Released model",
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          observedAt: "2026-11-09T12:00:00.000Z",
          matches: [
            {
              binId: "rss-main",
              revisionId: "850e8400-e29b-41d4-a716-446655440000",
              archiveSeq: "12",
              observedAt: "2026-11-09T12:00:00.000Z",
              recordedAt: "2026-11-09T12:00:00.000Z",
              title: "Released model",
              sourcePublishedAt: null,
              sourceModifiedAt: null,
            },
          ],
        },
      ],
      nextCursor: undefined,
    };
    const service = fakeService({ searchResponse });
    const result = await run(
      ["archive", "search", "--query", JSON.stringify(query)],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.output);
    const wire = JSON.parse(result.output) as {
      readonly data: {
        readonly results: readonly { readonly title: string | null }[];
      };
    };
    assert.equal(wire.data.results[0]?.title, "Released model");
    assert.deepEqual(
      service.requests.find(({ path }) => path === "/archives/search")?.body,
      query,
    );
  });

  void it("不兼容的公开 HTTP 协议会在查询前给出可读错误", async () => {
    const service = fakeService({ httpApiVersion: 99 });
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          text: { groups: [["needle"]] },
        }),
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /HTTP API 协议/u);
    assert.equal(
      service.requests.some(({ path }) => path === "/archives/search"),
      false,
    );
  });

  void it("旧版公开 HTTP 协议会在动作声明读取前被拒绝", async () => {
    const service = fakeService({ httpApiVersion: 1 });
    const result = await run(["bin", "actions", "rss-main"], service.fetch);

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /HTTP API 协议/u);
    assert.deepEqual(
      service.requests.map(({ method, path }) => [method, path]),
      [["GET", "/meta"]],
    );
  });

  void it("不兼容的公开 HTTP 协议会阻止普通读取", async () => {
    const listService = fakeService({ httpApiVersion: 99 });
    const listed = await run(["bin", "list"], listService.fetch);

    assert.equal(listed.exitCode, 1);
    assert.match(listed.output, /HTTP API 协议/u);
    assert.deepEqual(
      listService.requests.map(({ method, path }) => [method, path]),
      [["GET", "/meta"]],
    );
  });

  void it("不兼容的公开 HTTP 协议会阻止普通写入", async () => {
    const updateService = fakeService({ httpApiVersion: 99 });
    const updated = await run(
      ["bin", "update", "rss-main", "--identity", "account-primary"],
      updateService.fetch,
    );

    assert.equal(updated.exitCode, 1);
    assert.match(updated.output, /HTTP API 协议/u);
    assert.deepEqual(
      updateService.requests.map(({ method, path }) => [method, path]),
      [["GET", "/meta"]],
    );
  });

  void it("兼容协议的普通命令按选定服务地址读取", async () => {
    const service = fakeService({});
    const result = await run(
      ["bin", "list", "--url", "http://selected.test"],
      service.fetch,
      "9.8.7",
      "http://from-environment.test",
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      service.requests.map(({ method, path, origin }) => [
        method,
        path,
        origin,
      ]),
      [
        ["GET", "/meta", "http://selected.test"],
        ["GET", "/bins", "http://selected.test"],
      ],
    );
  });

  void it("lists compact action names before reading one declaration", async () => {
    const service = fakeService({});
    const listed = await run(["bin", "actions", "rss-main"], service.fetch);

    assert.equal(listed.exitCode, 0, listed.output);
    const listedWire = JSON.parse(listed.output) as {
      readonly data: {
        readonly actions: Readonly<
          Record<string, { readonly description: string }>
        >;
      };
    };
    assert.deepEqual(Object.keys(listedWire.data.actions), [
      "check",
      "collect",
    ]);
    assert.equal(
      listedWire.data.actions.collect?.description,
      "读取 feed 中的新内容。",
    );
    assert.equal("params" in listedWire.data.actions.collect!, false);

    const listedText = await run(
      ["bin", "actions", "rss-main", "--output", "text"],
      service.fetch,
    );
    assert.equal(listedText.exitCode, 0, listedText.output);
    assert.match(listedText.output, /- collect: 读取 feed 中的新内容。/u);
    assert.doesNotMatch(listedText.output, /"kind"\s*:/u);

    const selected = await run(
      ["bin", "actions", "rss-main", "collect"],
      service.fetch,
    );

    assert.equal(selected.exitCode, 0, selected.output);
    const selectedWire = JSON.parse(selected.output) as {
      readonly data: {
        readonly actions: Readonly<
          Record<
            string,
            {
              readonly description: string;
              readonly report?: { readonly type?: string };
            }
          >
        >;
        readonly execution?: unknown;
        readonly environment?: unknown;
      };
    };
    assert.deepEqual(Object.keys(selectedWire.data.actions), ["collect"]);
    assert.equal(
      selectedWire.data.actions.collect?.description,
      "读取 feed 中的新内容。",
    );
    assert.equal(selectedWire.data.actions.collect?.report?.type, "object");
    assert.equal(Object.hasOwn(selectedWire.data, "execution"), false);
    assert.equal(Object.hasOwn(selectedWire.data, "environment"), false);

    const selectedText = await run(
      ["bin", "actions", "rss-main", "collect", "--output", "text"],
      service.fetch,
    );
    assert.equal(selectedText.exitCode, 0, selectedText.output);
    assert.match(selectedText.output, /Parameters:/u);
    assert.match(selectedText.output, /Output:/u);
    assert.match(selectedText.output, /Report:/u);
    assert.doesNotMatch(selectedText.output, /"kind"\s*:/u);

    const missing = await run(
      ["bin", "actions", "rss-main", "missing"],
      service.fetch,
    );
    assert.equal(missing.exitCode, 1);
    assert.match(missing.output, /动作/);
    assert.deepEqual(
      service.requests.map(({ method, path, search }) => [
        method,
        path,
        search,
      ]),
      [
        ["GET", "/meta", ""],
        ["GET", "/bins/rss-main/actions", ""],
        ["GET", "/meta", ""],
        ["GET", "/bins/rss-main/actions", ""],
        ["GET", "/meta", ""],
        ["GET", "/bins/rss-main/actions", "?action=collect"],
        ["GET", "/meta", ""],
        ["GET", "/bins/rss-main/actions", "?action=collect"],
        ["GET", "/meta", ""],
        ["GET", "/bins/rss-main/actions", "?action=missing"],
      ],
    );
  });

  void it("reads the full configuration schema through its explicit command", async () => {
    const service = fakeService({});
    const result = await run(
      ["bin", "config-schema", "rss-main"],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.output);
    const wire = JSON.parse(result.output) as {
      readonly data: {
        readonly sourceAdapterId: string;
        readonly sourceAdapterVersion: string;
        readonly configSchema: { readonly type?: string };
      };
    };
    assert.equal(wire.data.sourceAdapterId, "rss");
    assert.equal(wire.data.sourceAdapterVersion, "1.0.0");
    assert.equal(wire.data.configSchema.type, "object");
    assert.deepEqual(
      service.requests.map(({ method, path }) => [method, path]),
      [
        ["GET", "/meta"],
        ["GET", "/bins/rss-main/config-schema"],
      ],
    );

    const textResult = await run(
      ["bin", "config-schema", "rss-main", "--output", "text"],
      service.fetch,
    );
    assert.equal(textResult.exitCode, 0, textResult.output);
    assert.match(textResult.output, /Source adapter: rss@1\.0\.0/u);
    assert.match(textResult.output, /Configuration schema:/u);
    assert.doesNotMatch(textResult.output, /"kind"\s*:/u);
  });

  void it("reports an incompatible archive query contract with a readable error before fixed search", async () => {
    const service = fakeService({ archiveQueryVersion: 99 });
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          text: { groups: [["model"]] },
        }),
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /归档查询契约版本/u);
    assert.equal(
      service.requests.some(({ path }) => path === "/archives/search"),
      false,
    );
  });
});
