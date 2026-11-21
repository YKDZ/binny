import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  resolveBakeComposeContexts,
  type BakeComposeContexts,
} from "@binny/tooling-config/bake-compose-contexts";

import { assertBinActionDeclarations } from "./binny-cli-adapter-discovery.ts";
import { copyImageBuildContext } from "./binny-image-update-context.ts";

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

type BinConfigSchemaDiscovery = {
  readonly sourceAdapterId: string;
  readonly sourceAdapterVersion: string;
  readonly configSchema: Record<string, unknown>;
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
const resourceImage = projectName + ":resource-fixture";
const imageName = projectName + ":server";
const jsonHeaders = { "content-type": "application/json" };
const publishedHost = process.env.BINNY_RUNTIME_PUBLISHED_HOST ?? "172.17.0.1";
let serverPort = 0;
let runtimeOnePort = 0;
let runtimeTwoPort = 0;
let runtimeResourcePort = 0;
let composeOverlayDirectory: string | undefined;
let composeOverlayFile: string | undefined;
let imageBuildContextDirectory: string | undefined;
let bakeComposeContexts: BakeComposeContexts | undefined;

function environment(): Readonly<Record<string, string>> {
  bakeComposeContexts ??= resolveBakeComposeContexts(repositoryRoot);
  return {
    ...bakeComposeContexts,
    BINNY_IMAGE: imageName,
    BINNY_TEST_LIGHTWEIGHT_IMAGE: runtimeImage,
    BINNY_TEST_LIGHTWEIGHT_RESOURCE_IMAGE: resourceImage,
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
  // The aggregate E2E gate can run alongside this leaf gate.
  const subnet = process.env.BINNY_RUNTIME_SUBNET ?? "10.253.154.0/24";
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
      "  runtime-resource-fixture:",
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
    "apps/cli/dist/cli.js",
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

async function waitForBinRegistration(
  binId: string,
  expectedSourceAdapter: Record<string, unknown>,
): Promise<void> {
  const deadline = Date.now() + 25_000;
  let lastResult = "尚未查询。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", binId]);
    if (result.code === 0) {
      const bin = cliData<{
        readonly id: string;
        readonly sourceAdapterId: string;
        readonly identityId: string;
        readonly config: Record<string, unknown>;
        readonly execution: RuntimeStatus;
      }>(result, "found");
      if (bin.sourceAdapterId === expectedSourceAdapter.id) {
        const schemaResult = await cli(["bin", "config-schema", binId]);
        if (schemaResult.code === 0) {
          const declaration = cliData<BinConfigSchemaDiscovery>(
            schemaResult,
            "discovered",
          );
          if (
            declaration.sourceAdapterId === expectedSourceAdapter.id &&
            declaration.sourceAdapterVersion === expectedSourceAdapter.version
          ) {
            assert.deepEqual(
              declaration.configSchema,
              expectedSourceAdapter.configSchema,
            );
            await assertBinActionDeclarations(
              cli,
              binId,
              expectedSourceAdapter,
            );
            assert.equal(bin.id, binId);
            assert.equal(bin.identityId, binId);
            assert.deepEqual(bin.config, {});
            assert.equal(bin.execution.status, "incompatible");
            assert.equal(
              bin.execution.error?.code,
              "runtime_configuration_incompatible",
            );
            return;
          }
          lastResult = JSON.stringify({ bin, declaration });
        } else {
          lastResult = schemaResult.stderr;
        }
      } else {
        lastResult = JSON.stringify(bin);
      }
    } else {
      lastResult = result.stderr;
    }
    await delay(250);
  }
  throw new Error(`等待 bin ${binId} 自注册超时：${lastResult}`);
}

async function configureBin(binId: string, section: string): Promise<void> {
  const configured = cliData<{ readonly id: string }>(
    await cli([
      "bin",
      "update",
      binId,
      "--identity",
      `identity-${binId}`,
      "--config",
      JSON.stringify({ section }),
    ]),
    "updated",
  );
  assert.equal(configured.id, binId);
}

async function queryDb(sql: string): Promise<string> {
  const result = await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-X",
    "-qAt",
    "-U",
    "binny",
    "-d",
    "binny",
    "-c",
    sql,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function getRuntimeState(
  binId: string,
  runtimeId: string,
  ownerGeneration: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(
    `http://${publishedHost}:${serverPort}/bins/${encodeURIComponent(
      binId,
    )}/runtime/state?runtimeId=${encodeURIComponent(
      runtimeId,
    )}&ownerGeneration=${encodeURIComponent(ownerGeneration)}`,
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function putRuntimeState(
  binId: string,
  payload: {
    readonly runtimeId: string;
    readonly ownerGeneration: string;
    readonly persistentState?: Record<string, unknown>;
    readonly sourceAccess?: unknown;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(
    `http://${publishedHost}:${serverPort}/bins/${encodeURIComponent(
      binId,
    )}/runtime/state`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    },
  );
  return {
    status: response.status,
    body: await response.json(),
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

async function dockerImageId(image: string): Promise<string> {
  const result = await run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function buildRuntimeImages(): Promise<string> {
  imageBuildContextDirectory = await mkdtemp(
    path.join(tmpdir(), `${projectName}-build-context-`),
  );
  await copyImageBuildContext(repositoryRoot, imageBuildContextDirectory);
  // Build both adapters in one Turbo graph so their shared base is built once.
  const build = await run(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "@binny/source-adapter-runtime#image:build:protocol-fixture",
      "@binny/source-adapter-lightweight-resource-fixture#image:build",
    ],
    { env: { BINNY_IMAGE_BUILD_CONTEXT: imageBuildContextDirectory } },
  );
  assert.equal(build.code, 0, build.stdout + build.stderr);

  const baseImage = "binny/source-adapter-runtime:lightweight-v1";
  const layers = await run("docker", [
    "image",
    "inspect",
    "--format",
    "{{json .RootFS.Layers}}",
    baseImage,
    runtimeImage,
    resourceImage,
  ]);
  assert.equal(layers.code, 0, layers.stderr);
  const [baseLayers, ...adapterLayers] = layers.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.ok(baseLayers !== undefined && baseLayers.length > 0);
  assert.equal(adapterLayers.length, 2);
  for (const imageLayers of adapterLayers) {
    assert.ok(imageLayers.length > baseLayers.length);
    assert.deepEqual(
      imageLayers.slice(0, baseLayers.length),
      baseLayers,
      "Both adapter images must extend the same lightweight runtime base.",
    );
  }
  return await dockerImageId(baseImage);
}

try {
  await createNetworkOverlay();

  const lightweightBaseImageId = await buildRuntimeImages();
  await compose(["build", "server"]);
  await compose(["up", "--detach", "--no-build"]);
  [serverPort, runtimeOnePort, runtimeTwoPort, runtimeResourcePort] =
    await Promise.all([
      publishedPort("server", 3000),
      publishedPort("runtime-one", 8080),
      publishedPort("runtime-two", 8080),
      publishedPort("runtime-resource-fixture", 8080),
    ]);
  await waitForApi();

  const [runtimeOneManifest, runtimeTwoManifest, resourceManifest] =
    await Promise.all([
      waitForManifest(runtimeOnePort),
      waitForManifest(runtimeTwoPort),
      waitForManifest(runtimeResourcePort),
    ]);
  assert.deepEqual(runtimeOneManifest, runtimeTwoManifest);
  assert.equal(resourceManifest.protocolVersion, 9);
  assert.equal(runtimeOneManifest.protocolVersion, 9);
  const sourceAdapter = runtimeOneManifest.sourceAdapter;
  assert.ok(typeof sourceAdapter === "object" && sourceAdapter !== null);
  const sourceAdapterRecord = sourceAdapter as Record<string, unknown>;
  const resourceSourceAdapter = resourceManifest.sourceAdapter;
  assert.ok(
    typeof resourceSourceAdapter === "object" && resourceSourceAdapter !== null,
  );
  const resourceSourceAdapterRecord = resourceSourceAdapter as Record<
    string,
    unknown
  >;

  await Promise.all([
    waitForBinRegistration("binny-runtime-one", sourceAdapterRecord),
    waitForBinRegistration("binny-runtime-two", sourceAdapterRecord),
    waitForBinRegistration(
      "binny-runtime-resource",
      resourceSourceAdapterRecord,
    ),
  ]);
  await Promise.all([
    configureBin("binny-runtime-one", "one"),
    configureBin("binny-runtime-two", "two"),
    configureBin("binny-runtime-resource", "resource-test"),
  ]);

  const onlineOne = await waitForCliStatus("binny-runtime-one", "online");
  const onlineTwo = await waitForCliStatus("binny-runtime-two", "online");
  assert.notEqual(onlineOne.execution.runtimeId, onlineTwo.execution.runtimeId);
  assert.equal(onlineOne.execution.environment?.kind, "lightweight");
  assert.equal(onlineTwo.execution.environment?.kind, "lightweight");
  const onlineResource = await waitForCliStatus(
    "binny-runtime-resource",
    "online",
  );
  assert.equal(onlineResource.execution.environment?.kind, "lightweight");
  assert.equal(
    await containerImage("runtime-resource-fixture"),
    await dockerImageId(resourceImage),
  );
  assert.equal(
    await containerImage("runtime-one"),
    await containerImage("runtime-two"),
  );

  const resourceTrigger = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli([
      "run",
      "trigger",
      "binny-runtime-resource",
      "collect",
      "--params",
      "{}",
    ]),
    "triggered",
  );
  assert.equal(resourceTrigger.status, "queued");
  const resourceRunDeadline = Date.now() + 30_000;
  type ResourceRun = {
    readonly status: string;
    readonly result?: {
      readonly output?: unknown;
      readonly commits: readonly {
        readonly commitId: string;
        readonly items: readonly { readonly itemId: string }[];
      }[];
    };
  };
  let resourceRun: ResourceRun | undefined;
  while (Date.now() < resourceRunDeadline) {
    resourceRun = cliData<ResourceRun>(
      await cli([
        "run",
        "get",
        "binny-runtime-resource",
        resourceTrigger.runId,
      ]),
      "found",
    );
    if (resourceRun.status === "completed" || resourceRun.status === "failed")
      break;
    await delay(100);
  }
  assert.ok(resourceRun !== undefined);
  assert.equal(resourceRun.status, "completed");
  assert.deepEqual(resourceRun.result?.output, {
    feedTitle: "Packaged Test Feed",
    itemTitle: "Adapter-Owned Resource",
    bodyText: "Parsed from the adapter-owned resource file.",
  });
  const resourceCommit = resourceRun.result?.commits[0];
  assert.ok(resourceCommit !== undefined);
  const resourceItemId = resourceCommit.items[0]?.itemId;
  assert.ok(resourceItemId !== undefined);
  const archivedResource = cliData<{
    readonly views: readonly {
      readonly binId: string;
      readonly state: {
        readonly title: string | null;
        readonly body?: { readonly text?: string };
      };
    }[];
  }>(
    await cli([
      "archive",
      "item",
      resourceItemId,
      "--bin",
      "binny-runtime-resource",
    ]),
    "found",
  );
  const resourceView = archivedResource.views.find(
    ({ binId }) => binId === "binny-runtime-resource",
  );
  assert.ok(resourceView !== undefined);
  assert.equal(resourceView.state.title, "Adapter-Owned Resource");
  assert.equal(
    resourceView.state.body?.text,
    "Parsed from the adapter-owned resource file.",
  );
  const currentBin = cliData<{
    readonly execution: RuntimeStatus;
  }>(await cli(["bin", "get", "binny-runtime-one"]), "found");
  assert.equal(currentBin.execution.status, "online");
  assert.equal(
    await containerImage("runtime-one"),
    await containerImage("runtime-two"),
  );

  const initialRuntimeId = onlineOne.execution.runtimeId!;
  assert.ok(initialRuntimeId !== undefined);
  const initialGeneration = await queryDb(
    "SELECT owner_generation FROM runtime_connections WHERE bin_id = 'binny-runtime-one';",
  );
  assert.ok(initialGeneration.length > 0);

  const initialPut = await putRuntimeState("binny-runtime-one", {
    runtimeId: initialRuntimeId,
    ownerGeneration: initialGeneration,
    persistentState: { syncCursor: "initial-cursor-10" },
    sourceAccess: { lease: "active", budgetRemaining: 50 },
  });
  assert.equal(initialPut.status, 200);

  const initialGet = await getRuntimeState(
    "binny-runtime-one",
    initialRuntimeId,
    initialGeneration,
  );
  assert.equal(initialGet.status, 200);
  assert.deepEqual(
    (initialGet.body as Record<string, unknown>).persistentState,
    { syncCursor: "initial-cursor-10" },
  );
  assert.deepEqual((initialGet.body as Record<string, unknown>).sourceAccess, {
    lease: "active",
    budgetRemaining: 50,
  });

  await compose(["stop", "runtime-one"]);
  const stoppedOne = await waitForCliStatus(
    "binny-runtime-one",
    "offline",
    "runtime_not_connected",
  );
  const disconnectedId = stoppedOne.execution.runtimeId;
  assert.equal(disconnectedId, initialRuntimeId);

  await compose(["up", "--detach", "--force-recreate", "runtime-one"]);
  const reconnectedOne = await waitForCliStatus("binny-runtime-one", "online");
  assert.notEqual(reconnectedOne.execution.runtimeId, disconnectedId);
  assert.ok(disconnectedId !== undefined);

  const newGeneration = await queryDb(
    "SELECT owner_generation FROM runtime_connections WHERE bin_id = 'binny-runtime-one';",
  );
  assert.ok(BigInt(newGeneration) > BigInt(initialGeneration));

  const staleStatePut = await putRuntimeState("binny-runtime-one", {
    runtimeId: initialRuntimeId,
    ownerGeneration: initialGeneration,
    persistentState: { syncCursor: "stale-overwrite" },
  });
  assert.equal(staleStatePut.status, 409);
  assert.equal(
    (staleStatePut.body as { error: { code: string } }).error.code,
    "runtime_owner_mismatch",
  );

  const persistedStateGet = await getRuntimeState(
    "binny-runtime-one",
    reconnectedOne.execution.runtimeId!,
    newGeneration,
  );
  assert.equal(persistedStateGet.status, 200);
  assert.deepEqual(
    (persistedStateGet.body as Record<string, unknown>).persistentState,
    { syncCursor: "initial-cursor-10" },
  );
  assert.deepEqual(
    (persistedStateGet.body as Record<string, unknown>).sourceAccess,
    { lease: "active", budgetRemaining: 50 },
  );
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
  await compose([
    "stop",
    "runtime-one",
    "runtime-two",
    "runtime-resource-fixture",
  ]);

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
  assert.equal(
    await dockerImageId("binny/source-adapter-runtime:lightweight-v1"),
    lightweightBaseImageId,
    "The adapter action must leave the runtime base image unchanged.",
  );

  process.stdout.write(
    "Official lightweight images, adapter-owned dependency and resource action, PostgreSQL, dual bins, capability errors, heartbeat reconnection, CLI state, and server restart persistence passed.\n",
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
  await run("docker", ["image", "rm", "--force", resourceImage]).catch(
    () => undefined,
  );
  await run("docker", ["image", "rm", "--force", imageName]).catch(
    () => undefined,
  );
  if (composeOverlayDirectory !== undefined)
    await rm(composeOverlayDirectory, { recursive: true, force: true });
  if (imageBuildContextDirectory !== undefined)
    await rm(imageBuildContextDirectory, { recursive: true, force: true });
}
