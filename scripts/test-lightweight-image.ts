import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const workspaceRoot = process.cwd();
const image = `binny-runtime/lightweight:${process.pid}`;
const container = `binny-runtime-runtime-${process.pid}`;
const runtimePort = 14140 + (process.pid % 1000);

async function run(command: string, args: readonly string[]): Promise<string> {
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  const output = Buffer.concat(stdout).toString("utf8");
  const error = Buffer.concat(stderr).toString("utf8");
  assert.equal(
    code,
    0,
    `${command} ${args.join(" ")} 执行失败${signal === null ? "" : `（信号 ${signal}）`}：${error}`,
  );
  return `${output}${error}`;
}

async function waitForManifest(baseUrl: string): Promise<unknown> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/manifest`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`运行器返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`轻量运行器未发布清单：${String(lastError)}`);
}

try {
  await run("docker", [
    "build",
    "--file",
    "packages/source-adapter-runtime/Dockerfile.lightweight",
    "--build-arg",
    "BINNY_SOURCE_ADAPTER_PACKAGE=@binny/source-adapter-runtime",
    "--build-arg",
    "BINNY_SOURCE_ADAPTER_ENTRY=fixture-dist/source-adapter.js",
    "--build-arg",
    "BINNY_BUILD_FIXTURE=1",
    "--tag",
    image,
    ".",
  ]);
  await run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--env",
    "BINNY_BIN_ID=binny-runtime-fixture",
    "--env",
    "BINNY_API_URL=http://127.0.0.1:1",
    "--env",
    `BINNY_RUNTIME_PORT=${runtimePort}`,
    image,
  ]);

  const address = await run("docker", [
    "inspect",
    "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    container,
  ]);
  const baseUrl = `http://${address.trim()}:${runtimePort}`;

  let manifest: unknown;
  try {
    manifest = await waitForManifest(baseUrl);
  } catch (error) {
    const logs = await run("docker", ["logs", container]).catch(() => "");
    throw new Error(`${String(error)}\n${logs}`);
  }
  assert.deepStrictEqual(manifest, {
    protocolVersion: 5,
    sourceAdapter: {
      id: "binny-runtime.protocol-fixture",
      version: "1.0.0",
      environment: {
        browser: { required: false, profileReuseAfterRestart: false },
      },
      configSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        properties: { section: { type: "string" } },
        required: ["section"],
        type: "object",
      },
      actions: {
        check: {
          description: "说明轻量测试环境未配置真实信源。",
          params: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: {},
            type: "object",
          },
          output: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: {
              availability: {
                enum: ["available", "unavailable", "unknown"],
                type: "string",
              },
              scope: { items: { type: "string" }, type: "array" },
              basis: { type: "string" },
              problems: {
                items: {
                  properties: {
                    code: { type: "string" },
                    message: { type: "string" },
                    impact: { type: "string" },
                    suggestion: { type: "string" },
                    requiresHuman: { type: "boolean" },
                  },
                  required: [
                    "code",
                    "message",
                    "impact",
                    "suggestion",
                    "requiresHuman",
                  ],
                  type: "object",
                  additionalProperties: false,
                },
                type: "array",
              },
            },
            required: ["availability", "scope", "basis", "problems"],
            type: "object",
            additionalProperties: false,
          },
        },
        collect: {
          description: "运行轻量测试采集动作。",
          params: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: {},
            type: "object",
          },
          output: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: {
              completedScopes: {
                items: { type: "string" },
                type: "array",
              },
            },
            required: ["completedScopes"],
            type: "object",
            additionalProperties: false,
          },
        },
        sample: {
          description: "验证轻量执行链路。",
          params: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: {
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 9007199254740991,
              },
            },
            required: ["limit"],
            type: "object",
          },
          output: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: { sampled: { type: "boolean" } },
            required: ["sampled"],
            type: "object",
            additionalProperties: false,
          },
        },
      },
    },
  });
} finally {
  await run("docker", ["rm", "--force", container]).catch(() => undefined);
  await run("docker", ["image", "rm", "--force", image]).catch(() => undefined);
}
