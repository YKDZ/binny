import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CliWire<T> = {
  readonly kind: string;
  readonly variant: string;
  readonly data: T;
};

type RuntimeStatus = {
  readonly status: "online" | "offline" | "incompatible";
  readonly reason?: string;
  readonly runtimeId?: string;
  readonly environment?: { readonly kind: string };
  readonly error?: {
    readonly code: string;
    readonly path: readonly (string | number)[];
  };
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.acceptance.yaml");
const projectName = "binny-runtime-" + process.pid.toString(10);
const runtimeImage = projectName + ":lightweight";
const imageName = projectName + ":server";
const jsonHeaders = { "content-type": "application/json" };
const publishedHost = process.env.BINNY_RUNTIME_PUBLISHED_HOST ?? "172.17.0.1";
let serverPort = 0;
let runtimeOnePort = 0;
let runtimeTwoPort = 0;
let composeOverlayDirectory: string | undefined;
let composeOverlayFile: string | undefined;

function environment(): Readonly<Record<string, string>> {
  return {
    BINNY_IMAGE: imageName,
    BINNY_TEST_LIGHTWEIGHT_IMAGE: runtimeImage,
  };
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>> } = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment(), ...options.env },
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

function composePrefix(): readonly string[] {
  const prefix = [
    "compose",
    "--project-name",
    projectName,
    "--file",
    composeFile,
    "--profile",
    "binny-runtime",
    "--parallel",
    "1",
  ];
  return composeOverlayFile === undefined
    ? prefix
    : [...prefix, "--file", composeOverlayFile];
}

async function createNetworkOverlay(): Promise<void> {
  composeOverlayDirectory = await mkdtemp(
    path.join(tmpdir(), "binny-runtime-compose-"),
  );
  composeOverlayFile = path.join(
    composeOverlayDirectory,
    "compose.network.yaml",
  );
  const subnet = process.env.BINNY_RUNTIME_SUBNET ?? "10.253.151.0/24";
  const subnetMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/24$/u.exec(
    subnet,
  );
  assert.ok(subnetMatch !== null);
  assert.ok(subnetMatch.slice(1).every((octet) => Number(octet) <= 255));
  await writeFile(
    composeOverlayFile,
    [
      "services:",
      "  server:",
      "    ports: !override",
      '      - "3000"',
      "  runtime-one:",
      "    ports: !override",
      '      - "8080"',
      "  runtime-two:",
      "    ports: !override",
      '      - "8080"',
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      `        - subnet: ${subnet}`,
      "",
    ].join("\n"),
  );
}

async function compose(args: readonly string[]): Promise<ProcessResult> {
  const result = await run("docker", [...composePrefix(), ...args]);
  assert.equal(
    result.code,
    0,
    `Compose ${args.join(" ")} 失败：\n${(result.stdout + result.stderr).slice(-12_000)}`,
  );
  return result;
}

async function cli(args: readonly string[]): Promise<ProcessResult> {
  return await run("docker", [
    ...composePrefix(),
    "exec",
    "--no-TTY",
    "server",
    "node",
    "packages/binny/dist/cli.js",
    ...args,
  ]);
}

async function publishedPort(
  service: string,
  containerPort: number,
): Promise<number> {
  const mapping = (
    await compose(["port", service, String(containerPort)])
  ).stdout.trim();
  const portText = /:(\d+)$/u.exec(mapping)?.[1];
  const port = Number(portText);
  assert.ok(
    portText !== undefined &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535,
    `Compose 没有为 ${service}:${String(containerPort)} 返回有效宿主端口：${mapping}`,
  );
  return port;
}

function cliData<T>(result: ProcessResult, variant: string): T {
  assert.equal(result.code, 0, result.stderr);
  const wire = JSON.parse(result.stdout) as CliWire<T>;
  assert.equal(wire.kind, "data");
  assert.equal(wire.variant, variant);
  return wire.data;
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "服务尚未就绪。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "list"]);
    if (result.code === 0) return;
    lastError = result.stderr;
    await delay(500);
  }
  throw new Error("等待正式 API、PostgreSQL 和 CLI 就绪超时：\n" + lastError);
}

async function waitForManifest(port: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${publishedHost}:${port}/manifest`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok)
        return (await response.json()) as Record<string, unknown>;
      lastError = new Error(`运行器返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const [logs, services] = await Promise.all([
    run("docker", [...composePrefix(), "logs", "runtime-one", "runtime-two"]),
    run("docker", [...composePrefix(), "ps", "--all"]),
  ]);
  throw new Error(
    "正式轻量镜像未发布清单：" +
      String(lastError) +
      "\n服务状态：\n" +
      services.stdout +
      services.stderr +
      "\n运行器日志：\n" +
      logs.stdout +
      logs.stderr,
  );
}

async function waitForCliStatus(
  binId: string,
  expected: RuntimeStatus["status"],
  reason?: string,
): Promise<Record<string, unknown> & { readonly execution: RuntimeStatus }> {
  const deadline = Date.now() + 25_000;
  let lastResult = "尚未查询。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", binId]);
    if (result.code === 0) {
      const bin = cliData<
        Record<string, unknown> & { readonly execution: RuntimeStatus }
      >(result, "found");
      if (
        bin.execution.status === expected &&
        (reason === undefined || bin.execution.reason === reason)
      ) {
        return bin;
      }
      lastResult = JSON.stringify(bin.execution);
    } else {
      lastResult = result.stderr;
    }
    await delay(250);
  }
  throw new Error(
    `等待 bin ${binId} 状态 ${expected}${reason === undefined ? "" : `/${reason}`} 超时：${lastResult}`,
  );
}

async function createBin(
  id: string,
  sourceAdapter: unknown,
  section: string,
  browserIdleTimeout: number | "disabled" = 300,
): Promise<Record<string, unknown> & { readonly execution: RuntimeStatus }> {
  return cliData(
    await cli([
      "bin",
      "create",
      id,
      "--source-adapter",
      JSON.stringify(sourceAdapter),
      "--identity",
      `identity-${id}`,
      "--config",
      JSON.stringify({ section }),
      "--targets",
      "[]",
      "--browser-idle-timeout-seconds",
      String(browserIdleTimeout),
    ]),
    "created",
  );
}

async function postHeartbeat(
  binId: string,
  input: Record<string, unknown>,
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const response = await fetch(
    `http://${publishedHost}:${serverPort}/bins/${binId}/runtime/heartbeat`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        protocolVersion: 4,
        ownerLockAcquired: true,
        ownerGeneration: "1",
        activeRunId: null,
        claimInFlight: false,
        ...input,
      }),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function postDisconnect(
  binId: string,
  runtimeId: string,
): Promise<{ readonly status: number; readonly body: RuntimeStatus }> {
  const response = await fetch(
    `http://${publishedHost}:${serverPort}/bins/${binId}/runtime/disconnect`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        runtimeId,
        ownerLockAcquired: true,
        activeRunId: null,
        claimInFlight: false,
      }),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as RuntimeStatus,
  };
}

async function containerImage(service: string): Promise<string> {
  const container = (await compose(["ps", "--quiet", service])).stdout.trim();
  assert.notEqual(container, "");
  return (
    await run("docker", ["inspect", "--format", "{{.Image}}", container])
  ).stdout.trim();
}

try {
  await createNetworkOverlay();

  await compose(["build", "server", "runtime-one"]);
  await compose(["up", "--detach", "--no-build"]);
  [serverPort, runtimeOnePort, runtimeTwoPort] = await Promise.all([
    publishedPort("server", 3000),
    publishedPort("runtime-one", 8080),
    publishedPort("runtime-two", 8080),
  ]);
  await waitForApi();

  const [runtimeOneManifest, runtimeTwoManifest] = await Promise.all([
    waitForManifest(runtimeOnePort),
    waitForManifest(runtimeTwoPort),
  ]);
  assert.deepEqual(runtimeOneManifest, runtimeTwoManifest);
  assert.equal(runtimeOneManifest.protocolVersion, 5);
  const sourceAdapter = runtimeOneManifest.sourceAdapter;
  assert.ok(typeof sourceAdapter === "object" && sourceAdapter !== null);

  const createdOne = await createBin("binny-runtime-one", sourceAdapter, "one");
  const createdTwo = await createBin("binny-runtime-two", sourceAdapter, "two");
  assert.equal(createdOne.execution.status, "offline");
  assert.equal(createdTwo.execution.status, "offline");
  const initialOffline = await createBin(
    "binny-runtime-offline",
    sourceAdapter,
    "not-running",
  );
  assert.equal(initialOffline.execution.status, "offline");

  const onlineOne = await waitForCliStatus("binny-runtime-one", "online");
  const onlineTwo = await waitForCliStatus("binny-runtime-two", "online");
  assert.notEqual(onlineOne.execution.runtimeId, onlineTwo.execution.runtimeId);
  assert.equal(onlineOne.execution.environment?.kind, "lightweight");
  assert.equal(onlineTwo.execution.environment?.kind, "lightweight");
  const discovered = cliData<{
    readonly execution: RuntimeStatus;
  }>(await cli(["bin", "actions", "binny-runtime-one"]), "discovered");
  assert.equal(discovered.execution.status, "online");
  assert.equal(
    await containerImage("runtime-one"),
    await containerImage("runtime-two"),
  );

  const browserSourceAdapter = {
    ...sourceAdapter,
    environment: {
      browser: {
        required: true,
        profileReuseAfterRestart: false,
        profileReuseUnavailableReason: "该运行环境不保留跨重启浏览器会话。",
      },
    },
  };
  await createBin(
    "binny-runtime-browser",
    browserSourceAdapter,
    "browser",
    "disabled",
  );
  const incompatibleEnvironment = await postHeartbeat("binny-runtime-browser", {
    runtimeId: "binny-runtime-browser-probe",
    sourceAdapter: browserSourceAdapter,
    environment: {
      kind: "lightweight",
      browser: {
        available: false,
        profileReuseAfterRestart: false,
        power: { status: "unavailable" },
      },
    },
  });
  assert.equal(incompatibleEnvironment.status, 409);
  assert.deepEqual(
    (incompatibleEnvironment.body.error as { readonly code: string }).code,
    "runtime_environment_incompatible",
  );
  assert.deepEqual(
    (incompatibleEnvironment.body.error as { readonly path: unknown }).path,
    ["sourceAdapter", "environment", "browser", "required"],
  );
  const browserState = cliData<{ readonly execution: RuntimeStatus }>(
    await cli(["bin", "get", "binny-runtime-browser"]),
    "found",
  );
  assert.equal(browserState.execution.status, "incompatible");
  assert.equal(
    browserState.execution.error?.code,
    "runtime_environment_incompatible",
  );

  const allOfSourceAdapter = {
    ...sourceAdapter,
    configSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        section: {
          type: "string",
          allOf: [{ pattern: "^a" }, { pattern: "z$" }],
        },
      },
      required: ["section"],
      additionalProperties: false,
    },
  };
  await createBin("binny-runtime-config-allof-valid", allOfSourceAdapter, "az");
  const compatibleConfig = await postHeartbeat(
    "binny-runtime-config-allof-valid",
    {
      runtimeId: "binny-runtime-config-allof-valid-probe",
      sourceAdapter: allOfSourceAdapter,
      environment: {
        kind: "lightweight",
        browser: {
          available: false,
          profileReuseAfterRestart: false,
          power: { status: "unavailable" },
        },
      },
    },
  );
  assert.equal(compatibleConfig.status, 200);
  assert.equal((compatibleConfig.body as RuntimeStatus).status, "online");

  const configMismatchSourceAdapter = {
    ...sourceAdapter,
    configSchema: {
      type: "object",
      properties: { section: { type: "string" } },
      required: ["section"],
      additionalProperties: false,
    },
  };
  const incompatibleConfigCreated = cliData<{
    readonly id: string;
  }>(
    await cli([
      "bin",
      "create",
      "binny-runtime-config-mismatch",
      "--source-adapter",
      JSON.stringify(configMismatchSourceAdapter),
      "--identity",
      "identity-binny-runtime-config-mismatch",
      "--config",
      JSON.stringify({ section: "ab" }),
      "--targets",
      "[]",
    ]),
    "created",
  );
  assert.equal(incompatibleConfigCreated.id, "binny-runtime-config-mismatch");
  const incompatibleConfig = await postHeartbeat(
    "binny-runtime-config-mismatch",
    {
      runtimeId: "binny-runtime-config-probe",
      sourceAdapter: allOfSourceAdapter,
      environment: {
        kind: "lightweight",
        browser: {
          available: false,
          profileReuseAfterRestart: false,
          power: { status: "unavailable" },
        },
      },
    },
  );
  assert.equal(incompatibleConfig.status, 409);
  assert.equal(
    (incompatibleConfig.body.error as { readonly code: string }).code,
    "runtime_configuration_incompatible",
  );
  assert.deepEqual(
    (incompatibleConfig.body.error as { readonly path: unknown }).path,
    ["config", "section"],
  );

  const driftedManifest = {
    ...sourceAdapter,
    version: "2.0.0",
  };
  const manifestMismatch = await postHeartbeat("binny-runtime-offline", {
    runtimeId: "binny-runtime-manifest-probe",
    sourceAdapter: driftedManifest,
    environment: {
      kind: "lightweight",
      browser: {
        available: false,
        profileReuseAfterRestart: false,
        power: { status: "unavailable" },
      },
    },
  });
  assert.equal(manifestMismatch.status, 409);
  assert.equal(
    (manifestMismatch.body.error as { readonly code: string }).code,
    "runtime_manifest_mismatch",
  );
  assert.deepEqual(
    (manifestMismatch.body.error as { readonly path: unknown }).path,
    ["sourceAdapter", "version"],
  );

  await compose(["stop", "runtime-one"]);
  const stoppedOne = await waitForCliStatus(
    "binny-runtime-one",
    "offline",
    "runtime_not_connected",
  );
  const disconnectedId = stoppedOne.execution.runtimeId;
  await compose(["start", "runtime-one"]);
  const reconnectedOne = await waitForCliStatus("binny-runtime-one", "online");
  assert.notEqual(reconnectedOne.execution.runtimeId, disconnectedId);
  assert.ok(disconnectedId !== undefined);
  const staleDisconnect = await postDisconnect(
    "binny-runtime-one",
    disconnectedId,
  );
  assert.equal(staleDisconnect.status, 200);
  assert.equal(staleDisconnect.body.status, "online");
  assert.equal(
    staleDisconnect.body.runtimeId,
    reconnectedOne.execution.runtimeId,
  );

  await compose(["kill", "--signal", "SIGKILL", "runtime-one"]);
  await waitForCliStatus("binny-runtime-one", "offline", "heartbeat_expired");
  await compose(["start", "runtime-one"]);
  await waitForCliStatus("binny-runtime-one", "online");
  await compose(["stop", "runtime-one", "runtime-two"]);

  await compose(["up", "--detach", "--force-recreate", "server"]);
  await waitForApi();
  const persistedOne = cliData<{
    readonly id: string;
    readonly identityId: string;
    readonly config: { readonly section: string };
  }>(await cli(["bin", "get", "binny-runtime-one"]), "found");
  const persistedTwo = cliData<{
    readonly id: string;
    readonly identityId: string;
    readonly config: { readonly section: string };
  }>(await cli(["bin", "get", "binny-runtime-two"]), "found");
  assert.equal(persistedOne.id, "binny-runtime-one");
  assert.equal(persistedTwo.id, "binny-runtime-two");
  assert.equal(persistedOne.identityId, "identity-binny-runtime-one");
  assert.equal(persistedTwo.identityId, "identity-binny-runtime-two");
  assert.deepEqual(persistedOne.config, { section: "one" });
  assert.deepEqual(persistedTwo.config, { section: "two" });

  process.stdout.write(
    "正式轻量镜像、真实 PostgreSQL、双 bin、能力错误、心跳断开与重连、CLI 状态和核心重建持久性均通过。\n",
  );
} finally {
  await run("docker", [
    ...composePrefix(),
    "down",
    "--volumes",
    "--remove-orphans",
  ]).catch(() => undefined);
  await run("docker", ["image", "rm", "--force", runtimeImage]).catch(
    () => undefined,
  );
  await run("docker", ["image", "rm", "--force", imageName]).catch(
    () => undefined,
  );
  if (composeOverlayDirectory !== undefined)
    await rm(composeOverlayDirectory, { recursive: true, force: true });
}
