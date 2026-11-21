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
  isReady?: () => { readonly ready: boolean; readonly reason?: string },
): Promise<void> {
  const server = createRuntimeServer({
    sourceAdapter: sourceAdapter(includeConstructor),
    ...(isReady === undefined ? {} : { isReady }),
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

  void it("returns 503 for /health and native validation endpoints until browser readiness completes", async () => {
    let ready = false;
    await withRuntimeServer(
      false,
      async (baseUrl) => {
        const healthNotReady = await fetch(new URL("/health", baseUrl));
        assert.equal(healthNotReady.status, 503);

        const configNotReady = await fetch(
          new URL("/internal/configuration/validate", baseUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sourceAdapterId: "test.runtime-action-lookup",
              sourceAdapterVersion: "1.0.0",
              config: {},
            }),
          },
        );
        assert.equal(configNotReady.status, 503);

        const actionNotReady = await validateAction(baseUrl, "check");
        assert.equal(actionNotReady.status, 503);

        ready = true;
        const healthReady = await fetch(new URL("/health", baseUrl));
        assert.equal(healthReady.status, 200);
        assert.deepEqual(await healthReady.json(), { process: "ready" });

        const actionReady = await validateAction(baseUrl, "check");
        assert.equal(actionReady.status, 200);
      },
      () =>
        ready ? { ready: true } : { ready: false, reason: "browser_starting" },
    );
  });
});
