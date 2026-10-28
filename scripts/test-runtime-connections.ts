import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
const composeFile = path.join(repositoryRoot, "compose.yaml");
const projectName = "binny14-" + process.pid.toString(10);
const runtimeImage = projectName + ":lightweight";
const imageName = projectName + ":server";
const jsonHeaders = { "content-type": "application/json" };
const publishedHost = process.env.BINNY14_PUBLISHED_HOST ?? "172.17.0.1";
let serverPort = 0;
let runtimeOnePort = 0;
let runtimeTwoPort = 0;
let composeOverlayDirectory: string | undefined;
let composeOverlayFile: string | undefined;

function environment(): Readonly<Record<string, string>> {
  return {
    BINNY_PORT: String(serverPort),
    BINNY_IMAGE: imageName,
    BINNY14_RUNTIME_IMAGE: runtimeImage,
    BINNY14_RUNTIME_ONE_PORT: String(runtimeOnePort),
    BINNY14_RUNTIME_TWO_PORT: String(runtimeTwoPort),
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
    "binny14",
    "--parallel",
    "1",
  ];
  return composeOverlayFile === undefined
    ? prefix
    : [...prefix, "--file", composeOverlayFile];
}

async function createNetworkOverlay(): Promise<void> {
  composeOverlayDirectory = await mkdtemp(
    path.join(tmpdir(), "binny14-compose-"),
  );
  composeOverlayFile = path.join(
    composeOverlayDirectory,
    "compose.network.yaml",
  );
  const subnet = process.env.BINNY14_SUBNET ?? "10.253.14.0/24";
  const subnetMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/24$/u.exec(
    subnet,
  );
  assert.ok(subnetMatch !== null);
  assert.ok(subnetMatch.slice(1).every((octet) => Number(octet) <= 255));
  await writeFile(
    composeOverlayFile,
    [
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
  collector: unknown,
  section: string,
): Promise<Record<string, unknown> & { readonly execution: RuntimeStatus }> {
  return cliData(
    await cli([
      "bin",
      "create",
      id,
      "--collector",
      JSON.stringify(collector),
      "--identity",
      `identity-${id}`,
      "--config",
      JSON.stringify({ section }),
      "--targets",
      "[]",
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
      body: JSON.stringify({ protocolVersion: 1, ...input }),
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
      body: JSON.stringify({ runtimeId }),
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
  [serverPort, runtimeOnePort, runtimeTwoPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  assert.equal(new Set([serverPort, runtimeOnePort, runtimeTwoPort]).size, 3);
  await createNetworkOverlay();

  await compose(["build", "server", "runtime-one"]);
  await compose(["up", "--detach", "--no-build"]);
  await waitForApi();

  const [runtimeOneManifest, runtimeTwoManifest] = await Promise.all([
    waitForManifest(runtimeOnePort),
    waitForManifest(runtimeTwoPort),
  ]);
  assert.deepEqual(runtimeOneManifest, runtimeTwoManifest);
  assert.equal(runtimeOneManifest.protocolVersion, 1);
  const collector = runtimeOneManifest.collector;
  assert.ok(typeof collector === "object" && collector !== null);

  const createdOne = await createBin("binny14-one", collector, "one");
  const createdTwo = await createBin("binny14-two", collector, "two");
  assert.equal(createdOne.execution.status, "offline");
  assert.equal(createdTwo.execution.status, "offline");
  const initialOffline = await createBin(
    "binny14-offline",
    collector,
    "not-running",
  );
  assert.equal(initialOffline.execution.status, "offline");

  const onlineOne = await waitForCliStatus("binny14-one", "online");
  const onlineTwo = await waitForCliStatus("binny14-two", "online");
  assert.notEqual(onlineOne.execution.runtimeId, onlineTwo.execution.runtimeId);
  assert.equal(onlineOne.execution.environment?.kind, "lightweight");
  assert.equal(onlineTwo.execution.environment?.kind, "lightweight");
  const discovered = cliData<{
    readonly execution: RuntimeStatus;
  }>(await cli(["bin", "actions", "binny14-one"]), "discovered");
  assert.equal(discovered.execution.status, "online");
  assert.equal(
    await containerImage("runtime-one"),
    await containerImage("runtime-two"),
  );

  const browserCollector = {
    ...collector,
    environment: {
      browser: { required: true, profileReuseAfterRestart: false },
    },
  };
  await createBin("binny14-browser", browserCollector, "browser");
  const incompatibleEnvironment = await postHeartbeat("binny14-browser", {
    runtimeId: "binny14-browser-probe",
    collector: browserCollector,
    environment: {
      kind: "lightweight",
      browser: { available: false, profileReuseAfterRestart: false },
    },
  });
  assert.equal(incompatibleEnvironment.status, 409);
  assert.deepEqual(
    (incompatibleEnvironment.body.error as { readonly code: string }).code,
    "runtime_environment_incompatible",
  );
  assert.deepEqual(
    (incompatibleEnvironment.body.error as { readonly path: unknown }).path,
    ["collector", "environment", "browser", "required"],
  );
  const browserState = cliData<{ readonly execution: RuntimeStatus }>(
    await cli(["bin", "get", "binny14-browser"]),
    "found",
  );
  assert.equal(browserState.execution.status, "incompatible");
  assert.equal(
    browserState.execution.error?.code,
    "runtime_environment_incompatible",
  );

  const configMismatchCollector = {
    ...collector,
    configSchema: {
      type: "object",
      properties: { other: { type: "string" } },
      required: ["other"],
      additionalProperties: false,
    },
  };
  const incompatibleConfigCreated = cliData<{
    readonly id: string;
  }>(
    await cli([
      "bin",
      "create",
      "binny14-config-mismatch",
      "--collector",
      JSON.stringify(configMismatchCollector),
      "--identity",
      "identity-binny14-config-mismatch",
      "--config",
      JSON.stringify({ other: "kept" }),
      "--targets",
      "[]",
    ]),
    "created",
  );
  assert.equal(incompatibleConfigCreated.id, "binny14-config-mismatch");
  const incompatibleConfig = await postHeartbeat("binny14-config-mismatch", {
    runtimeId: "binny14-config-probe",
    collector,
    environment: {
      kind: "lightweight",
      browser: { available: false, profileReuseAfterRestart: false },
    },
  });
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
    ...collector,
    version: "2.0.0",
  };
  const manifestMismatch = await postHeartbeat("binny14-offline", {
    runtimeId: "binny14-manifest-probe",
    collector: driftedManifest,
    environment: {
      kind: "lightweight",
      browser: { available: false, profileReuseAfterRestart: false },
    },
  });
  assert.equal(manifestMismatch.status, 409);
  assert.equal(
    (manifestMismatch.body.error as { readonly code: string }).code,
    "runtime_manifest_mismatch",
  );
  assert.deepEqual(
    (manifestMismatch.body.error as { readonly path: unknown }).path,
    ["collector", "version"],
  );

  await compose(["stop", "runtime-one"]);
  const stoppedOne = await waitForCliStatus(
    "binny14-one",
    "offline",
    "runtime_not_connected",
  );
  const disconnectedId = stoppedOne.execution.runtimeId;
  await compose(["start", "runtime-one"]);
  const reconnectedOne = await waitForCliStatus("binny14-one", "online");
  assert.notEqual(reconnectedOne.execution.runtimeId, disconnectedId);
  assert.ok(disconnectedId !== undefined);
  const staleDisconnect = await postDisconnect("binny14-one", disconnectedId);
  assert.equal(staleDisconnect.status, 200);
  assert.equal(staleDisconnect.body.status, "online");
  assert.equal(
    staleDisconnect.body.runtimeId,
    reconnectedOne.execution.runtimeId,
  );

  await compose(["kill", "--signal", "SIGKILL", "runtime-one"]);
  await waitForCliStatus("binny14-one", "offline", "heartbeat_expired");
  await compose(["start", "runtime-one"]);
  await waitForCliStatus("binny14-one", "online");
  await compose(["stop", "runtime-one", "runtime-two"]);

  await compose(["up", "--detach", "--force-recreate", "server"]);
  const persistedOne = cliData<{
    readonly id: string;
    readonly identityId: string;
    readonly config: { readonly section: string };
  }>(await cli(["bin", "get", "binny14-one"]), "found");
  const persistedTwo = cliData<{
    readonly id: string;
    readonly identityId: string;
    readonly config: { readonly section: string };
  }>(await cli(["bin", "get", "binny14-two"]), "found");
  assert.equal(persistedOne.id, "binny14-one");
  assert.equal(persistedTwo.id, "binny14-two");
  assert.equal(persistedOne.identityId, "identity-binny14-one");
  assert.equal(persistedTwo.identityId, "identity-binny14-two");
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
