import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyIsolatedApiConsumer } from "./binny-isolated-consumer.ts";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.yaml");
const projectName = "binny01-" + process.pid.toString(10);
const imageName = projectName + ":local";
const composeOverrideFile = path.join(
  tmpdir(),
  "binny01-compose-" + process.pid.toString(10) + ".yaml",
);
const composeSubnet = process.env.BINNY_E2E_SUBNET ?? "10.253.1.0/24";
let composePort = 0;

function composePrefix(): readonly string[] {
  return [
    "compose",
    "--project-name",
    projectName,
    "--file",
    composeFile,
    "--file",
    composeOverrideFile,
  ];
}

function composeEnvironment(): Readonly<Record<string, string>> {
  return {
    BINNY_PORT: String(composePort),
    BINNY_IMAGE: imageName,
  };
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function compose(
  args: readonly string[],
  port: number,
): Promise<ProcessResult> {
  const result = await run("docker", [...composePrefix(), ...args], {
    env: { ...composeEnvironment(), BINNY_PORT: String(port) },
  });
  if (result.code !== 0) {
    throw new Error(
      "Compose 命令失败：" +
        args.join(" ") +
        "\n" +
        result.stdout +
        result.stderr,
    );
  }
  return result;
}

async function reservePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const address = listener.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    listener.close((error) =>
      error === undefined ? resolveClose() : reject(error),
    );
  });
  return port;
}

async function cli(
  _baseUrl: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return await run(
    "docker",
    [
      ...composePrefix(),
      "exec",
      "--no-TTY",
      "server",
      "node",
      "packages/binny/dist/cli.js",
      ...args,
    ],
    { env: composeEnvironment() },
  );
}

function cliData<T>(result: ProcessResult, variant: string): T {
  assert.equal(result.code, 0, result.stderr);
  const wire = JSON.parse(result.stdout) as {
    readonly kind: string;
    readonly variant: string;
    readonly data: T;
  };
  assert.equal(wire.kind, "data");
  assert.equal(wire.variant, variant);
  return wire.data;
}

function cliFailure<T extends { readonly code: string }>(
  result: ProcessResult,
  code: string,
): T {
  assert.equal(result.code, 1, result.stdout);
  const wire = JSON.parse(result.stderr) as {
    readonly kind: string;
    readonly variant: string;
    readonly data: T;
  };
  assert.equal(wire.kind, "failure");
  assert.equal(wire.variant, "apiError");
  assert.equal(wire.data.code, code);
  return wire.data;
}

async function waitForApiAndDatabase(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastFailure = "服务尚未就绪。";
  while (Date.now() < deadline) {
    const result = await cli(baseUrl, ["bin", "list"]);
    if (result.code === 0) return;
    lastFailure = result.stderr;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("等待 HTTP API 和 PostgreSQL 就绪超时：\n" + lastFailure);
}

async function validateApiInput(): Promise<void> {
  const probe = [
    "(async () => {",
    'const bodies = [JSON.stringify({ id: 7 }), "{"];',
    'const responses = await Promise.all(bodies.map((body) => fetch("http://127.0.0.1:3000/bins", { method: "POST", headers: { "content-type": "application/json" }, body })));',
    "const results = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() })));",
    "process.stdout.write(JSON.stringify(results));",
    "})().catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("");
  const result = await run(
    "docker",
    [...composePrefix(), "exec", "--no-TTY", "server", "node", "-e", probe],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  const responses = JSON.parse(result.stdout) as readonly {
    readonly status: number;
    readonly body: {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly path?: readonly (string | number)[];
      };
    };
  }[];
  const invalidField = responses[0];
  const malformedJson = responses[1];
  assert.ok(invalidField !== undefined && malformedJson !== undefined);
  assert.equal(invalidField.status, 400);
  assert.equal(invalidField.body.error.code, "invalid_input");
  assert.deepEqual(invalidField.body.error.path, ["id"]);
  assert.match(invalidField.body.error.message, /字段|标识/u);
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.body.error.code, "invalid_input");
  assert.match(malformedJson.body.error.message, /JSON|格式/u);
}

async function createSdkManifest(): Promise<unknown> {
  const program = [
    'import { z } from "zod";',
    'import { collectorManifest, defineCollector } from "./dist/index.js";',
    "const collector = defineCollector({",
    '  id: "rss",',
    '  version: "1.0.0",',
    "  configSchema: z.object({",
    "    userAgent: z.string().min(1),",
    "    key: z.string().regex(/^a/).regex(/z$/),",
    "  }),",
    "  actions: {",
    '    collect: { description: "读取并归档订阅源。", params: z.object({ limit: z.number().int().min(1) }), execute: async () => undefined },',
    "  },",
    "  environment: { browser: { required: false, profileReuseAfterRestart: false } },",
    "});",
    "process.stdout.write(JSON.stringify(collectorManifest(collector)));",
  ].join("\n");
  const result = await run("pnpm", [
    "--filter",
    "@binny/collector-sdk",
    "exec",
    "node",
    "--input-type=module",
    "-e",
    program,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

async function verifyConfigurationJourney(baseUrl: string): Promise<void> {
  const manifest = await createSdkManifest();
  const manifestJson = JSON.stringify(manifest);
  const initialConfig = JSON.stringify({ userAgent: "Binny E2E", key: "az" });
  const initialTargets = JSON.stringify([
    { url: "https://example.test/one.xml" },
  ]);

  const emptyList = cliData<{ readonly bins: readonly unknown[] }>(
    await cli(baseUrl, ["bin", "list"]),
    "listed",
  );
  assert.deepEqual(emptyList.bins, []);

  const created = cliData<{
    readonly id: string;
    readonly identityId: string;
    readonly status: string;
    readonly execution: { readonly status: string };
  }>(
    await cli(baseUrl, [
      "bin",
      "create",
      "rss-main",
      "--collector",
      manifestJson,
      "--identity",
      "account-one",
      "--config",
      initialConfig,
      "--targets",
      initialTargets,
    ]),
    "created",
  );
  assert.equal(created.id, "rss-main");
  assert.equal(created.identityId, "account-one");
  assert.equal(created.status, "active");
  assert.equal(created.execution.status, "offline");

  const discovered = cliData<{
    readonly actions: Readonly<Record<string, unknown>>;
    readonly environment: { readonly browser: { readonly required: boolean } };
    readonly execution: { readonly status: string };
  }>(await cli(baseUrl, ["bin", "actions", "rss-main"]), "discovered");
  assert.deepEqual(Object.keys(discovered.actions), ["collect"]);
  assert.equal(discovered.environment.browser.required, false);
  assert.equal(discovered.execution.status, "offline");

  cliFailure(
    await cli(baseUrl, [
      "bin",
      "create",
      "rss-main",
      "--collector",
      manifestJson,
      "--identity",
      "duplicate-account",
      "--config",
      initialConfig,
      "--targets",
      initialTargets,
    ]),
    "bin_already_exists",
  );

  const invalidConfiguration = cliFailure<{
    readonly code: string;
    readonly message: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli(baseUrl, [
      "bin",
      "create",
      "rss-invalid-config",
      "--collector",
      manifestJson,
      "--identity",
      "account-invalid-config",
      "--config",
      "{}",
      "--targets",
      initialTargets,
    ]),
    "invalid_configuration",
  );
  assert.deepEqual(invalidConfiguration.path, ["config", "userAgent"]);
  assert.match(invalidConfiguration.message, /长期配置/u);

  const invalidRegexCreate = await fetch(baseUrl + "/bins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "rss-regex-invalid",
      collector: manifest,
      identityId: "account-regex-invalid",
      config: { userAgent: "Binny E2E", key: "ab" },
      targets: [],
    }),
  });
  assert.equal(invalidRegexCreate.status, 400);
  const invalidRegexCreateBody = (await invalidRegexCreate.json()) as {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly path?: readonly (string | number)[];
    };
  };
  assert.equal(invalidRegexCreateBody.error.code, "invalid_configuration");
  assert.deepEqual(invalidRegexCreateBody.error.path, ["config", "key"]);
  assert.match(invalidRegexCreateBody.error.message, /长期配置/u);

  const validRegexCreate = await fetch(baseUrl + "/bins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "rss-regex",
      collector: manifest,
      identityId: "account-regex",
      config: { userAgent: "Binny E2E", key: "az" },
      targets: [],
    }),
  });
  assert.equal(validRegexCreate.status, 201);
  const validRegexCreateBody = (await validRegexCreate.json()) as {
    readonly config: { readonly key: string };
  };
  assert.equal(validRegexCreateBody.config.key, "az");

  const invalidRegexUpdate = await fetch(baseUrl + "/bins/rss-regex", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: { userAgent: "Binny E2E", key: "bz" },
    }),
  });
  assert.equal(invalidRegexUpdate.status, 400);
  const invalidRegexUpdateBody = (await invalidRegexUpdate.json()) as {
    readonly error: {
      readonly code: string;
      readonly path?: readonly (string | number)[];
    };
  };
  assert.equal(invalidRegexUpdateBody.error.code, "invalid_configuration");
  assert.deepEqual(invalidRegexUpdateBody.error.path, ["config", "key"]);

  const afterInvalidRegexUpdate = await fetch(baseUrl + "/bins/rss-regex");
  assert.equal(afterInvalidRegexUpdate.status, 200);
  const afterInvalidRegexUpdateBody =
    (await afterInvalidRegexUpdate.json()) as {
      readonly config: { readonly key: string };
    };
  assert.equal(afterInvalidRegexUpdateBody.config.key, "az");

  const validRegexUpdate = await fetch(baseUrl + "/bins/rss-regex", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: { userAgent: "Binny E2E updated", key: "aaz" },
    }),
  });
  assert.equal(validRegexUpdate.status, 200);
  const validRegexUpdateBody = (await validRegexUpdate.json()) as {
    readonly config: { readonly key: string };
  };
  assert.equal(validRegexUpdateBody.config.key, "aaz");

  const secondary = cliData<{
    readonly id: string;
    readonly identityId: string;
  }>(
    await cli(baseUrl, [
      "bin",
      "create",
      "rss-secondary",
      "--collector",
      manifestJson,
      "--identity",
      "account-two",
      "--config",
      initialConfig,
      "--targets",
      JSON.stringify([{ url: "https://example.test/two.xml" }]),
    ]),
    "created",
  );
  assert.equal(secondary.id, "rss-secondary");
  assert.equal(secondary.identityId, "account-two");

  const listed = cliData<{
    readonly bins: readonly {
      readonly id: string;
      readonly identityId: string;
    }[];
  }>(await cli(baseUrl, ["bin", "list"]), "listed");
  assert.equal(listed.bins.length, 3);
  assert.deepEqual(listed.bins.map(({ identityId }) => identityId).toSorted(), [
    "account-one",
    "account-regex",
    "account-two",
  ]);

  const updatedConfig = JSON.stringify({
    userAgent: "Binny E2E updated",
    key: "aaz",
  });
  const updatedTargets = JSON.stringify([
    { url: "https://example.test/one.xml" },
    { url: "https://example.test/extra.xml" },
  ]);
  const updated = cliData<{
    readonly identityId: string;
    readonly config: { readonly userAgent: string };
    readonly targets: readonly unknown[];
  }>(
    await cli(baseUrl, [
      "bin",
      "update",
      "rss-main",
      "--identity",
      "account-primary",
      "--config",
      updatedConfig,
      "--targets",
      updatedTargets,
    ]),
    "updated",
  );
  assert.equal(updated.identityId, "account-primary");
  assert.equal(updated.config.userAgent, "Binny E2E updated");
  assert.equal(updated.targets.length, 2);

  cliFailure(
    await cli(baseUrl, ["bin", "update", "rss-main", "--config", "{}"]),
    "invalid_configuration",
  );
  const afterRejectedUpdate = cliData<{
    readonly identityId: string;
    readonly config: { readonly userAgent: string };
  }>(await cli(baseUrl, ["bin", "get", "rss-main"]), "found");
  assert.equal(afterRejectedUpdate.identityId, "account-primary");
  assert.equal(afterRejectedUpdate.config.userAgent, "Binny E2E updated");

  const disabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "disable", "rss-main"]),
    "disabled",
  );
  assert.equal(disabled.status, "disabled");

  return;
}

async function verifyRestartAndRemoval(
  baseUrl: string,
  port: number,
): Promise<void> {
  await compose(["restart", "postgres"], port);
  await waitForApiAndDatabase(baseUrl);
  await compose(["restart", "server"], port);
  await waitForApiAndDatabase(baseUrl);

  const persisted = cliData<{
    readonly status: string;
    readonly identityId: string;
    readonly config: { readonly userAgent: string };
    readonly targets: readonly unknown[];
  }>(await cli(baseUrl, ["bin", "get", "rss-main"]), "found");
  assert.equal(persisted.status, "disabled");
  assert.equal(persisted.identityId, "account-primary");
  assert.equal(persisted.config.userAgent, "Binny E2E updated");
  assert.equal(persisted.targets.length, 2);

  const persistedRegexConfiguration = cliData<{
    readonly config: { readonly userAgent: string; readonly key: string };
  }>(await cli(baseUrl, ["bin", "get", "rss-regex"]), "found");
  assert.equal(
    persistedRegexConfiguration.config.userAgent,
    "Binny E2E updated",
  );
  assert.equal(persistedRegexConfiguration.config.key, "aaz");

  const enabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "enable", "rss-main"]),
    "enabled",
  );
  assert.equal(enabled.status, "active");

  const removed = cliData<{ readonly removed: boolean; readonly id: string }>(
    await cli(baseUrl, ["bin", "remove", "rss-main"]),
    "removed",
  );
  assert.deepEqual(removed, { removed: true, id: "rss-main" });

  cliData(await cli(baseUrl, ["bin", "remove", "rss-regex"]), "removed");

  cliFailure(await cli(baseUrl, ["bin", "get", "rss-main"]), "bin_not_found");
  cliFailure(await cli(baseUrl, ["bin", "get", "rss-regex"]), "bin_not_found");
  cliData(await cli(baseUrl, ["bin", "remove", "rss-secondary"]), "removed");
  const empty = cliData<{ readonly bins: readonly unknown[] }>(
    await cli(baseUrl, ["bin", "list"]),
    "listed",
  );
  assert.deepEqual(empty.bins, []);
  await validateApiInput();
}

async function main(): Promise<void> {
  await writeFile(
    composeOverrideFile,
    [
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      "        - subnet: " + composeSubnet,
      "",
    ].join("\n"),
  );
  const port = await reservePort();
  composePort = port;
  const baseUrl =
    "http://" + (process.env.BINNY_E2E_HOST ?? "172.17.0.1") + ":" + port;
  let cleanupError: Error | undefined;
  try {
    await compose(
      [
        "up",
        "--detach",
        "--build",
        "--wait",
        "--wait-timeout",
        "360",
        "postgres",
        "server",
      ],
      port,
    );
    await waitForApiAndDatabase(baseUrl);
    const isolatedClient = await verifyIsolatedApiConsumer({
      repositoryRoot,
      projectName,
    });
    assert.deepEqual(isolatedClient, {
      health: "ok",
      binIds: [],
    });
    await verifyConfigurationJourney(baseUrl);
    await verifyRestartAndRemoval(baseUrl, port);
    process.stdout.write(
      "隔离客户端、Compose、PostgreSQL、HTTP API 与构建 CLI bin 配置旅程通过。\n",
    );
  } finally {
    const cleanup = await run(
      "docker",
      [
        "compose",
        "--project-name",
        projectName,
        "--file",
        composeFile,
        "--file",
        composeOverrideFile,
        "down",
        "--rmi",
        "all",
        "--volumes",
        "--remove-orphans",
      ],
      { env: composeEnvironment() },
    );
    if (cleanup.code !== 0) {
      cleanupError = new Error(
        "清理 Compose 资源失败：\n" + cleanup.stdout + cleanup.stderr,
      );
    }
    await rm(composeOverrideFile, { force: true });
  }
  if (cleanupError !== undefined) throw cleanupError;
}

await main();
