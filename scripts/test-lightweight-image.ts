import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const workspaceRoot = process.cwd();
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const image = `binny-runtime/lightweight:${suffix}`;
const container = `binny-runtime-validation-${suffix}`;
const network = `binny-runtime-validation-${suffix}`;
const runtimePort = 8080;
const publishedHost = process.env.BINNY_RUNTIME_PUBLISHED_HOST ?? "172.17.0.1";

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
  await run("docker", ["network", "create", network]);
  await run("docker", [
    "build",
    "--file",
    "packages/source-adapter-runtime/Dockerfile.lightweight",
    "--build-arg",
    "BINNY_SOURCE_ADAPTER_PACKAGE=@binny/source-adapter-runtime",
    "--build-arg",
    "BINNY_SOURCE_ADAPTER_ENTRY=fixture-dist/config-validation-source-adapter.js",
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
    "--network",
    network,
    "--cpus",
    "0.5",
    "--memory",
    "256m",
    "--publish",
    "0.0.0.0::8080",
    "--env",
    "BINNY_BIN_ID=binny-runtime-fixture",
    "--env",
    "BINNY_API_URL=http://127.0.0.1:1",
    "--env",
    `BINNY_RUNTIME_PORT=${runtimePort}`,
    "--env",
    `BINNY_RUNTIME_CONTROL_URL=http://127.0.0.1:${runtimePort}`,
    image,
  ]);

  const publishedPort = await run("docker", [
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}',
    container,
  ]);
  const baseUrl = `http://${publishedHost}:${publishedPort.trim()}`;

  let manifest: unknown;
  try {
    manifest = await waitForManifest(baseUrl);
  } catch (error) {
    const logs = await run("docker", ["logs", container]).catch(() => "");
    throw new Error(`${String(error)}\n${logs}`);
  }
  assert.deepStrictEqual(manifest, {
    protocolVersion: 6,
    sourceAdapter: {
      id: "binny-runtime.configuration-validation-fixture",
      version: "1.0.0",
      environment: {
        browser: { required: false, profileReuseAfterRestart: false },
      },
      configSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        properties: { section: { type: "string", default: "sample" } },
        type: "object",
      },
      actions: {
        check: {
          description: "报告配置验证测试状态。",
          params: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: {},
            type: "object",
          },
          output: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: { available: { type: "boolean" } },
            required: ["available"],
            type: "object",
            additionalProperties: false,
          },
        },
        collect: {
          description: "报告配置验证测试范围。",
          params: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: {},
            type: "object",
          },
          output: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            properties: { section: { type: "string" } },
            required: ["section"],
            type: "object",
            additionalProperties: false,
          },
        },
      },
    },
  });

  const validConfiguration = await fetch(
    `${baseUrl}/internal/configuration/validate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceAdapterId: "binny-runtime.configuration-validation-fixture",
        sourceAdapterVersion: "1.0.0",
        config: {},
      }),
    },
  );
  assert.equal(
    validConfiguration.status,
    200,
    await validConfiguration.clone().text(),
  );
  assert.deepEqual(await validConfiguration.json(), { valid: true });

  const invalidRefine = await fetch(
    `${baseUrl}/internal/configuration/validate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceAdapterId: "binny-runtime.configuration-validation-fixture",
        sourceAdapterVersion: "1.0.0",
        config: { section: "forbidden" },
      }),
    },
  );
  assert.equal(invalidRefine.status, 422, await invalidRefine.clone().text());
  assert.deepEqual(await invalidRefine.json(), {
    valid: false,
    error: {
      code: "invalid_configuration",
      message: "该板块不可用。",
      path: ["section"],
    },
  });

  const wrongVersion = await fetch(
    `${baseUrl}/internal/configuration/validate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceAdapterId: "binny-runtime.configuration-validation-fixture",
        sourceAdapterVersion: "0.9.0",
        config: {},
      }),
    },
  );
  assert.equal(wrongVersion.status, 409);
  assert.deepEqual(await wrongVersion.json(), {
    valid: false,
    error: {
      code: "source_adapter_version_mismatch",
      message: "配置验证请求与当前运行器的信源适配器版本不一致。",
    },
  });
} finally {
  await run("docker", ["rm", "--force", container]).catch(() => undefined);
  await run("docker", ["network", "rm", network]).catch(() => undefined);
  await run("docker", ["image", "rm", "--force", image]).catch(() => undefined);
}
