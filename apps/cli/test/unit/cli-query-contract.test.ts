import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicApiProtocolVersion } from "@binny/contracts";

import { runCli } from "../../src/main.ts";

const matchingMetadata = {
  product: { name: "Binny", version: "1.2.3" },
  protocols: { httpApi: publicApiProtocolVersion },
  capabilities: [
    "archives.search",
    "archives.aggregate",
    "archive.query-contract",
  ],
  contracts: { archiveQuery: { version: 1, path: "/meta/query" } },
};

function fakeService(options: {
  readonly httpApiVersion?: number;
  readonly archiveQueryVersion?: number;
  readonly productVersion?: string;
}) {
  const requests: {
    readonly method: string;
    readonly path: string;
    readonly search: string;
    readonly origin: string;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      origin: url.origin,
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
            version: options.archiveQueryVersion ?? 1,
            path: "/meta/query",
          },
        },
      });
    }
    if (url.pathname === "/meta/query") {
      return Response.json({
        version: options.archiveQueryVersion ?? 1,
        operations: {},
      });
    }
    if (url.pathname === "/archives/search") {
      return Response.json({
        unit: "item",
        snapshot: { asOf: "0", mode: "current" },
        results: [],
      });
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
            check: { description: "检查 feed 是否可用。" },
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
) {
  let output = "";
  const exitCode = await runCli({
    argv: ["node", "binny", ...argv],
    identity: { commandName: "binny", version },
    fetch,
    ...(apiUrl === null ? {} : { apiUrl }),
    write: async ({ chunk }) => {
      output += chunk;
    },
  });
  return { exitCode, output };
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
      ["service", "info", "--output-format", "text"],
      service.fetch,
    );

    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /Product: Binny 1\.2\.3/u);
    assert.match(result.output, /archive\.query-contract/u);
    assert.match(result.output, /Archive query v1: \/meta\/query/u);
    assert.doesNotMatch(result.output, /"kind"\s*:/u);
  });

  void it("产品版本不同但公开协议兼容时仍执行查询", async () => {
    const service = fakeService({ productVersion: "2.4.0" });
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          scope: { kind: "current" },
          text: { kind: "literal", value: "needle" },
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
          scope: { kind: "current" },
          text: { kind: "literal", value: "needle" },
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
          scope: { kind: "current" },
          text: { kind: "literal", value: "needle" },
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
          scope: { kind: "current" },
          text: { kind: "literal", value: "needle" },
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

  void it("不兼容的公开 HTTP 协议会在查询前给出可读错误", async () => {
    const service = fakeService({ httpApiVersion: 99 });
    const result = await run(
      [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          scope: { kind: "current" },
          text: { kind: "literal", value: "needle" },
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
      ["bin", "actions", "rss-main", "--output-format", "text"],
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
      ["bin", "actions", "rss-main", "collect", "--output-format", "text"],
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
      ["bin", "config-schema", "rss-main", "--output-format", "text"],
      service.fetch,
    );
    assert.equal(textResult.exitCode, 0, textResult.output);
    assert.match(textResult.output, /Source adapter: rss@1\.0\.0/u);
    assert.match(textResult.output, /Configuration schema:/u);
    assert.doesNotMatch(textResult.output, /"kind"\s*:/u);
  });

  void it("不兼容的归档查询契约会在查询前给出可读错误", async () => {
    const service = fakeService({ archiveQueryVersion: 99 });
    const result = await run(
      [
        "archive",
        "aggregate",
        "--query",
        JSON.stringify({
          scope: { kind: "current" },
          unit: "item",
          groupBy: [],
          metrics: [{ key: "items", op: "count" }],
        }),
      ],
      service.fetch,
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /归档查询契约版本/u);
    assert.equal(
      service.requests.some(({ path }) => path === "/archives/aggregate"),
      false,
    );
  });
});
