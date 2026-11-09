import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";

import { runtimeActionParametersValidationPath } from "@binny/contracts";
import {
  defineSourceAdapter,
  defineSourceAdapterAction,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import { createRuntimeServer } from "../src/runtime-server.ts";

const configSchema = z.object({});
const extensionsSchema = z.object({}).strict();
const environment = {
  browser: { required: false, profileReuseAfterRestart: false },
} as const;

function action() {
  return defineSourceAdapterAction(configSchema, extensionsSchema, {
    description: "执行测试动作。",
    params: z.object({}),
    output: z.object({ accepted: z.boolean() }),
    async execute() {
      return { accepted: true };
    },
  });
}

function sourceAdapter(includeConstructor: boolean) {
  const actions = {
    check: action(),
    collect: action(),
  };
  const definition = {
    id: "test.runtime-action-lookup",
    version: "1.0.0",
    configSchema,
    extensionsSchema,
    environment,
  };
  return includeConstructor
    ? defineSourceAdapter({
        ...definition,
        actions: { ...actions, constructor: action() },
      })
    : defineSourceAdapter({ ...definition, actions });
}

async function withRuntimeServer(
  includeConstructor: boolean,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createRuntimeServer({
    sourceAdapter: sourceAdapter(includeConstructor),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function validateAction(
  baseUrl: string,
  actionName: string,
): Promise<Response> {
  return await fetch(new URL(runtimeActionParametersValidationPath, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(500),
    body: JSON.stringify({
      sourceAdapterId: "test.runtime-action-lookup",
      sourceAdapterVersion: "1.0.0",
      action: actionName,
      params: {},
    }),
  });
}

void describe("运行器动作参数校验 HTTP", () => {
  void it("拒绝未声明的 constructor 后仍能服务其他动作", async () => {
    await withRuntimeServer(false, async (baseUrl) => {
      const missing = await validateAction(baseUrl, "constructor");
      assert.equal(missing.status, 422);
      assert.deepEqual(await missing.json(), {
        valid: false,
        error: {
          code: "action_not_found",
          message: "当前运行器没有请求的动作。",
          path: ["action"],
        },
      });

      const health = await fetch(new URL("/health", baseUrl));
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { process: "ready" });

      const declared = await validateAction(baseUrl, "check");
      assert.equal(declared.status, 200);
      assert.deepEqual(await declared.json(), { valid: true });
    });
  });

  void it("接受适配器自身声明的 constructor 动作", async () => {
    await withRuntimeServer(true, async (baseUrl) => {
      const response = await validateAction(baseUrl, "constructor");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { valid: true });
    });
  });
});
