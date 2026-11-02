import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCli } from "../../src/main.ts";

void describe("CLI 服务地址", () => {
  void it("bin update 的公开请求正文不包含服务地址", async () => {
    let request: Request | undefined;
    let requestBody: unknown;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      requestBody = await request.json();
      return Response.json(
        {
          error: {
            code: "invalid_input",
            message: "请求包含未支持的字段。",
          },
        },
        { status: 400 },
      );
    };
    let output = "";
    const exitCode = await runCli({
      argv: [
        "node",
        "binny",
        "bin",
        "update",
        "rss-main",
        "--identity",
        "account-primary",
        "--config",
        JSON.stringify({ userAgent: "Binny E2E updated", key: "aaz" }),
        "--url",
        "http://selected.test",
      ],
      identity: { commandName: "binny", version: "1.2.3" },
      apiUrl: "http://from-environment.test",
      fetch,
      write: async ({ chunk }) => {
        output += chunk;
      },
    });

    assert.equal(exitCode, 1);
    assert.match(output, /请求包含未支持的字段/u);
    assert.ok(request !== undefined);
    assert.equal(request.method, "PATCH");
    assert.equal(new URL(request.url).origin, "http://selected.test");
    assert.deepEqual(requestBody, {
      identityId: "account-primary",
      config: { userAgent: "Binny E2E updated", key: "aaz" },
    });
  });
});
