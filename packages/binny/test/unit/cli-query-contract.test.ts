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
      return Response.json({
        actions:
          actionName === null
            ? { collect: action, discover: action }
            : { [actionName]: action },
      });
    }
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
  void it("CLI 信息命令读取公开服务元信息和查询契约", async () => {
    const service = fakeService({});
    const result = await run(["service", "info"], service.fetch);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      service.requests.map(({ method, path }) => [method, path]),
      [
        ["GET", "/meta"],
        ["GET", "/meta/query"],
      ],
    );
    assert.match(result.output, /archive\.query-contract/u);
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

  void it("按 bin actions 可选动作读取声明且不会触发动作运行", async () => {
    const service = fakeService({});
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
        ["GET", "/bins/rss-main/actions", "?action=collect"],
        ["GET", "/meta", ""],
        ["GET", "/bins/rss-main/actions", "?action=missing"],
      ],
    );
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
