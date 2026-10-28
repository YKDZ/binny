import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const projectName = "binny02-" + process.pid.toString(10);
const imageName = projectName + ":local";
let composeOverrideFile = "";
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

async function archiveHttpStep(
  stage: "submit" | "after-restart",
  baseUrl: string,
  state?: string,
): Promise<string> {
  const result = await run(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@binny/api",
      "exec",
      "node",
      "--conditions=source",
      "scripts/archive-http-e2e.ts",
      stage,
      baseUrl,
    ],
    {
      env: state === undefined ? {} : { BINNY_E2E_ARCHIVE_STATE: state },
    },
  );
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

function archiveIds(state: string): {
  readonly itemId: string;
  readonly revisionId: string;
} {
  const parsed: unknown = JSON.parse(state);
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.ok("itemId" in parsed && typeof parsed.itemId === "string");
  assert.ok("revisionId" in parsed && typeof parsed.revisionId === "string");
  return { itemId: parsed.itemId, revisionId: parsed.revisionId };
}

function archiveResponses(response: string): {
  readonly item: unknown;
  readonly revision: unknown;
} {
  const parsed: unknown = JSON.parse(response);
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.ok("item" in parsed && "revision" in parsed);
  return { item: parsed.item, revision: parsed.revision };
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

async function validateApiInput(_baseUrl: string): Promise<void> {
  const probe = [
    'fetch("http://127.0.0.1:3000/bins", {',
    'method: "POST",',
    'headers: { "content-type": "application/json" },',
    "body: JSON.stringify({ id: 7 }),",
    "}).then(async (response) => {",
    "process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));",
    "}).catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("");
  const result = await run(
    "docker",
    [...composePrefix(), "exec", "--no-TTY", "server", "node", "-e", probe],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout) as {
    readonly status: number;
    readonly body: {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly path: readonly (string | number)[];
      };
    };
  };
  assert.equal(response.status, 400);
  const body = response.body;
  assert.equal(body.error.code, "invalid_input");
  assert.deepEqual(body.error.path, ["id"]);
  assert.match(body.error.message, /字段|标识/u);
}

async function verifyConfigurationJourney(baseUrl: string): Promise<void> {
  const manifest = {
    id: "rss",
    version: "1.0.0",
    configSchema: {
      type: "object",
      properties: { userAgent: { type: "string", minLength: 1 } },
      required: ["userAgent"],
      additionalProperties: false,
    },
    actions: {
      collect: {
        description: "读取并归档订阅源。",
        params: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1 } },
          required: ["limit"],
          additionalProperties: false,
        },
      },
    },
    environment: {
      browser: { required: false, profileReuseAfterRestart: false },
    },
  };
  const manifestJson = JSON.stringify(manifest);
  const initialConfig = JSON.stringify({ userAgent: "Binny E2E" });
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
  assert.equal(listed.bins.length, 2);
  assert.deepEqual(listed.bins.map(({ identityId }) => identityId).toSorted(), [
    "account-one",
    "account-two",
  ]);

  const updatedConfig = JSON.stringify({ userAgent: "Binny E2E updated" });
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
  archive: string,
): Promise<void> {
  const disabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "disable", "rss-main"]),
    "disabled",
  );
  assert.equal(disabled.status, "disabled");
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

  cliFailure(await cli(baseUrl, ["bin", "get", "rss-main"]), "bin_not_found");
  cliData(await cli(baseUrl, ["bin", "remove", "rss-secondary"]), "removed");
  const empty = cliData<{ readonly bins: readonly unknown[] }>(
    await cli(baseUrl, ["bin", "list"]),
    "listed",
  );
  assert.deepEqual(empty.bins, []);

  const archiveState = await archiveHttpStep("after-restart", baseUrl, archive);
  const { itemId, revisionId } = archiveIds(archive);
  const expectedArchive = archiveResponses(archiveState);
  const cliArchiveItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", itemId]),
    "found",
  );
  assert.deepEqual(cliArchiveItem, expectedArchive.item);
  const cliArchiveRevision = cliData<unknown>(
    await cli(baseUrl, ["archive", "revision", revisionId]),
    "found",
  );
  assert.deepEqual(cliArchiveRevision, expectedArchive.revision);
  await validateApiInput(baseUrl);
}

async function main(): Promise<void> {
  const port = await reservePort();
  composePort = port;
  const e2eHost = process.env.BINNY_E2E_HOST ?? "127.0.0.1";
  const baseUrl = "http://" + e2eHost + ":" + port;
  const overrideDirectory = await mkdtemp(
    path.join(tmpdir(), "binny02-compose-"),
  );
  composeOverrideFile = path.join(overrideDirectory, "compose.yaml");
  const e2eSubnet = process.env.BINNY_E2E_SUBNET ?? "10.253.2.0/24";
  await writeFile(
    composeOverrideFile,
    [
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      `        - subnet: ${e2eSubnet}`,
      "",
    ].join("\n"),
  );
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
    await verifyConfigurationJourney(baseUrl);
    const enabled = cliData<{ readonly status: string }>(
      await cli(baseUrl, ["bin", "enable", "rss-main"]),
      "enabled",
    );
    assert.equal(enabled.status, "active");
    const archive = await archiveHttpStep("submit", baseUrl);
    await verifyRestartAndRemoval(baseUrl, port, archive);
    process.stdout.write(
      "Compose、PostgreSQL、HTTP API、归档与构建 CLI 旅程通过。\n",
    );
  } finally {
    const cleanup = await run(
      "docker",
      [
        ...composePrefix(),
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
    await rm(overrideDirectory, { recursive: true, force: true });
  }
  if (cleanupError !== undefined) throw cleanupError;
}

await main();
