import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyIsolatedApiConsumer } from "./binny-isolated-consumer.ts";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ManagedProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly write: (input: string) => void;
  readonly waitForMarker: (marker: string) => Promise<void>;
  readonly waitForClose: () => Promise<ProcessResult>;
};

type HeartbeatDelayProxy = {
  readonly arm: (stoppedRunId: string) => Promise<void>;
  readonly waitUntilHeld: () => Promise<{
    readonly heldAt: number;
    readonly runtimeId: string;
    readonly ownerGeneration?: string;
    readonly stoppedRunId?: string;
  }>;
  readonly waitUntilTimedOut: () => Promise<number>;
  readonly waitUntilForwarded: (
    runtimeId: string,
  ) => Promise<string | undefined>;
  readonly release: () => Promise<void>;
};

type HeartbeatDelayProxyStatus = {
  readonly held: boolean;
  readonly heldAt?: number;
  readonly clientClosedAt?: number;
  readonly heldRuntimeId?: string;
  readonly heldOwnerGeneration?: string;
  readonly heldStoppedRunId?: string;
  readonly forwardedRuntimeId?: string;
  readonly forwardedOwnerGeneration?: string;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.yaml");
const capacityProfile = process.env.BINNY_E2E_CAPACITY_PROFILE ?? "smoke";
assert.ok(
  capacityProfile === "full" || capacityProfile === "smoke",
  "BINNY_E2E_CAPACITY_PROFILE 必须为 smoke 或 full。",
);
const capacityPhase =
  process.env.BINNY_E2E_CAPACITY_PHASE ??
  (capacityProfile === "full" ? "seed" : "all");
assert.ok(
  capacityPhase === "all" ||
    capacityPhase === "seed" ||
    capacityPhase === "verify",
  "BINNY_E2E_CAPACITY_PHASE 必须为 all、seed 或 verify。",
);
const isFullCapacityRun = capacityProfile === "full";
const preserveCapacityProject = isFullCapacityRun && capacityPhase === "seed";
const projectName = isFullCapacityRun
  ? "binny26-capacity"
  : "binny12-revision-diff-" + process.pid.toString(10);
const imageName = projectName + ":local";
const runtimeImageName = projectName + "-lightweight:local";
const rssRuntimeImageName = projectName + "-rss:local";
let activeServerImage = imageName;
let composeOverrideFile = "";
let composePort = 0;
let manualRunSourcePort = 0;

function createHeartbeatDelayProxy(controlPort: number): HeartbeatDelayProxy {
  const host = process.env.BINNY_E2E_HOST ?? "172.17.0.1";
  const controlUrl = `http://${host}:${String(controlPort)}`;

  async function readStatus(): Promise<HeartbeatDelayProxyStatus> {
    const response = await fetch(controlUrl + "/control/status", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as HeartbeatDelayProxyStatus;
  }

  return {
    async arm(stoppedRunId) {
      const response = await fetch(controlUrl + "/control/arm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stoppedRunId }),
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(response.status, 200);
    },
    async waitUntilHeld() {
      const status = await waitFor(
        readStatus,
        (current) =>
          current.held &&
          typeof current.heldAt === "number" &&
          typeof current.heldRuntimeId === "string",
        "代理暂存的原生 idle heartbeat",
      );
      assert.ok(status.heldAt !== undefined);
      assert.ok(status.heldRuntimeId !== undefined);
      return {
        heldAt: status.heldAt,
        runtimeId: status.heldRuntimeId,
        ...(status.heldOwnerGeneration === undefined
          ? {}
          : { ownerGeneration: status.heldOwnerGeneration }),
        ...(status.heldStoppedRunId === undefined
          ? {}
          : { stoppedRunId: status.heldStoppedRunId }),
      };
    },
    async waitUntilTimedOut() {
      const status = await waitFor(
        readStatus,
        (current) => typeof current.clientClosedAt === "number",
        "运行器 heartbeat 客户端超时",
      );
      assert.ok(status.clientClosedAt !== undefined);
      return status.clientClosedAt;
    },
    async waitUntilForwarded(runtimeId) {
      const status = await waitFor(
        readStatus,
        (current) => current.forwardedRuntimeId === runtimeId,
        `新运行器 ${runtimeId} 的真实心跳`,
      );
      return status.forwardedOwnerGeneration;
    },
    async release() {
      if (!(await readStatus()).held) return;
      const response = await fetch(controlUrl + "/control/release", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(response.status, 200);
    },
  };
}

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
    BINNY_IMAGE: activeServerImage,
    BINNY15_RUNTIME_IMAGE: runtimeImageName,
    BINNY18_STOP_GRACE_MS: "1500",
    BINNY22_RUNTIME_IMAGE: rssRuntimeImageName,
    BINNY_RESOURCE_UNREFERENCED_AGE_MS: String(15 * 1000),
    BINNY_RESOURCE_CLEANUP_INTERVAL_MS: String(60 * 60 * 1000),
  };
}

function apiBaseUrl(): string {
  return (
    "http://" +
    (process.env.BINNY_E2E_HOST ?? "172.17.0.1") +
    ":" +
    String(composePort)
  );
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

async function compose(args: readonly string[]): Promise<ProcessResult> {
  const result = await run("docker", [...composePrefix(), ...args], {
    env: composeEnvironment(),
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

function startManagedProcess(
  command: string,
  args: readonly string[],
): ManagedProcess {
  const child = spawn(command, [...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...composeEnvironment() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closeResult: ProcessResult | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<ProcessResult>((resolve) => {
    child.once("error", (error) => {
      stderr += String(error);
      closeResult = { code: 1, stdout, stderr };
      resolve(closeResult);
    });
    child.once("close", (code) => {
      closeResult = { code: code ?? 1, stdout, stderr };
      resolve(closeResult);
    });
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    write(input) {
      if (closeResult !== undefined) {
        throw new Error("受控子进程已经退出。");
      }
      child.stdin.write(input);
    },
    async waitForMarker(marker) {
      if (stdout.includes(marker)) return;
      await new Promise<void>((resolveMarker, rejectMarker) => {
        const deadline = setTimeout(() => {
          cleanup();
          rejectMarker(
            new Error(`等待子进程输出 ${marker} 超时：\n${stdout}\n${stderr}`),
          );
        }, 30_000);
        const onData = (): void => {
          if (!stdout.includes(marker)) return;
          cleanup();
          resolveMarker();
        };
        const onClose = (): void => {
          cleanup();
          rejectMarker(
            new Error(`子进程在输出 ${marker} 前退出：\n${stdout}\n${stderr}`),
          );
        };
        const cleanup = (): void => {
          clearTimeout(deadline);
          child.stdout.off("data", onData);
          child.off("close", onClose);
        };
        child.stdout.on("data", onData);
        child.once("close", onClose);
      });
    },
    waitForClose: () => closed,
  };
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
  sdkResourceState?: string,
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
      env: {
        ...(state === undefined ? {} : { BINNY_E2E_ARCHIVE_STATE: state }),
        ...(sdkResourceState === undefined
          ? {}
          : { BINNY_E2E_SDK_RESOURCE_STATE: sdkResourceState }),
      },
    },
  );
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

async function archiveAggregationCliStep(baseUrl: string): Promise<void> {
  const request = {
    scope: { kind: "current" },
    unit: "item",
    where: {
      type: "and",
      conditions: [
        {
          type: "field",
          field: "sourceKey.namespace",
          operator: "eq",
          value: "e2e",
        },
        {
          type: "field",
          field: "sourceKey.key",
          operator: "in",
          values: ["aggregation-shared-p", "aggregation-distinct-q"],
        },
      ],
    },
    groupBy: [],
    metrics: [
      { key: "items", op: "count" },
      {
        key: "priceSum",
        op: "sum",
        value: {
          type: "json",
          field: "properties",
          path: ["price"],
          valueType: "number",
        },
      },
    ],
  };
  const result = cliData<{
    readonly unit: string;
    readonly groups: readonly {
      readonly metrics: readonly {
        readonly key: string;
        readonly value: string | null;
      }[];
    }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "aggregate",
      "--query",
      JSON.stringify(request),
    ]),
    "aggregated",
  );
  assert.equal(result.unit, "item");
  assert.deepEqual(result.groups[0]?.metrics, [
    { key: "items", op: "count", value: "2" },
    { key: "priceSum", op: "sum", value: "20" },
  ]);

  const invalidRequest = { ...request, unit: "unknown" };
  const failure = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli(baseUrl, [
      "archive",
      "aggregate",
      "--query",
      JSON.stringify(invalidRequest),
    ]),
    "invalid_input",
  );
  assert.deepEqual(failure.path, ["unit"]);
}

async function capacityHttpStep(baseUrl: string): Promise<string> {
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
      "capacity",
      baseUrl,
    ],
    {
      env: {
        BINNY_E2E_CAPACITY_PROFILE: capacityProfile,
        BINNY_E2E_CAPACITY_PHASE: capacityPhase,
      },
    },
  );
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

async function sdkResourceStep(baseUrl: string): Promise<string> {
  const result = await run("pnpm", [
    "--silent",
    "--filter",
    "@binny/collector-sdk",
    "exec",
    "node",
    "--conditions=source",
    "scripts/archive-resource-e2e.ts",
    baseUrl,
  ]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

async function imageId(image: string): Promise<string> {
  const result = await run(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function containerImageId(service: string): Promise<string> {
  const containers = await compose(["ps", "-q", service]);
  const containerId = containers.stdout.trim().split("\n")[0];
  assert.ok(containerId, `没有找到 Compose 服务 ${service} 的容器。`);
  const result = await run(
    "docker",
    ["inspect", "--format", "{{.Image}}", containerId],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function networkSubnet(network: string): Promise<string> {
  const result = await run("docker", [
    "network",
    "inspect",
    "--format",
    "{{(index .IPAM.Config 0).Subnet}}",
    network,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function migrationHistory(): Promise<string> {
  const result = await compose(
    postgresExecArgs([
      "-c",
      "SELECT COALESCE(json_agg(json_build_object('id', id, 'hash', hash, 'created_at', created_at, 'name', name, 'applied_at', applied_at) ORDER BY id), '[]'::json)::text FROM drizzle.__drizzle_migrations;",
    ]).slice(composePrefix().length),
  );
  const history = result.stdout.trim();
  const records: unknown = JSON.parse(history);
  assert.ok(Array.isArray(records));
  assert.equal(records.length, 2, "基线库应保留两条既有迁移记录。");
  return history;
}

async function seedUpgradeRun(
  baseUrl: string,
  manifest: unknown,
): Promise<string> {
  const binId = "rss-main";
  const runtimeId = "binny36-upgrade-baseline-runtime";
  const heartbeat = await fetch(`${baseUrl}/bins/${binId}/runtime/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: 3,
      runtimeId,
      ownerGeneration: "1",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      collector: manifest,
      environment: {
        kind: "lightweight",
        browser: { available: false, profileReuseAfterRestart: false },
      },
    }),
  });
  assert.equal(heartbeat.status, 200, await heartbeat.clone().text());

  const triggered = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({ limit: 1 }),
    ]),
    "triggered",
  );
  assert.equal(triggered.status, "queued");

  const claimResponse = await fetch(
    `${baseUrl}/bins/${binId}/runtime/runs/claim`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeId }),
    },
  );
  assert.equal(claimResponse.status, 200, await claimResponse.clone().text());
  const claim: unknown = await claimResponse.json();
  assert.ok(typeof claim === "object" && claim !== null && "run" in claim);
  assert.ok(
    typeof claim.run === "object" && claim.run !== null && "runId" in claim.run,
  );
  assert.equal(claim.run.runId, triggered.runId);

  const completeResponse = await fetch(
    `${baseUrl}/bins/${binId}/runtime/runs/${triggered.runId}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeId,
        completion: {
          status: "completed",
          completedScopes: ["baseline-upgrade"],
        },
      }),
    },
  );
  assert.equal(
    completeResponse.status,
    200,
    await completeResponse.clone().text(),
  );
  const completed = cliData<{
    readonly status: string;
    readonly result?: { readonly stopReason?: { readonly code?: string } };
  }>(await cli(baseUrl, ["run", "get", binId, triggered.runId]), "found");
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.stopReason?.code, "completed");
  return triggered.runId;
}

type UpgradeArchiveObservation = {
  readonly archiveSeq: string;
  readonly itemId: string;
  readonly revisionId: string;
};

async function submitUpgradeArchiveObservation(
  baseUrl: string,
  requestId: string,
  title: string,
  markdown: string,
  phase: string,
  resourceId?: string,
): Promise<UpgradeArchiveObservation> {
  const response = await fetch(baseUrl + "/archives", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "database-package-upgrade" },
          metadata: { title },
          body: { markdown },
          ...(resourceId === undefined ? {} : { resources: [{ resourceId }] }),
          capture: {
            scope: { phase },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const commit = (await response.json()) as {
    readonly archiveSeq: string;
    readonly items: readonly {
      readonly itemId: string;
      readonly revisionId: string;
    }[];
  };
  const item = commit.items[0];
  assert.ok(item);
  return {
    archiveSeq: commit.archiveSeq,
    itemId: item.itemId,
    revisionId: item.revisionId,
  };
}

async function readUpgradeArchive(
  baseUrl: string,
  itemId: string,
  asOf?: string,
): Promise<{
  readonly views: readonly {
    readonly state: { readonly body?: { readonly markdown?: string } };
  }[];
  readonly revisions: readonly unknown[];
  readonly observations: readonly unknown[];
}> {
  const query = new URLSearchParams({ binId: "rss-main" });
  if (asOf !== undefined) query.set("asOf", asOf);
  const response = await fetch(
    `${baseUrl}/archives/items/${itemId}?${query.toString()}`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as {
    readonly views: readonly {
      readonly state: { readonly body?: { readonly markdown?: string } };
    }[];
    readonly revisions: readonly unknown[];
    readonly observations: readonly unknown[];
  };
}

async function readUpgradeResource(
  baseUrl: string,
  resourceId: string,
): Promise<Uint8Array> {
  const response = await fetch(`${baseUrl}/resources/${resourceId}`);
  assert.equal(response.status, 200);
  return new Uint8Array(await response.arrayBuffer());
}

async function verifyDatabasePackageUpgrade(): Promise<void> {
  const baselineImage = process.env.BINNY_E2E_BASELINE_IMAGE;
  if (baselineImage === undefined || baselineImage.length === 0) return;
  const expectedBaselineId = process.env.BINNY_E2E_BASELINE_IMAGE_ID;
  assert.ok(
    expectedBaselineId !== undefined && expectedBaselineId.length > 0,
    "指定旧正式镜像时必须同时提供冻结的 BINNY_E2E_BASELINE_IMAGE_ID。",
  );

  const taggedBaselineId = await imageId(baselineImage);
  assert.equal(taggedBaselineId, expectedBaselineId);
  const candidateImageId = await imageId(imageName);
  assert.notEqual(candidateImageId, taggedBaselineId);

  activeServerImage = baselineImage;
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "360",
    "--no-build",
    "postgres",
    "server",
  ]);
  const runningBaselineId = await containerImageId("server");
  assert.equal(runningBaselineId, expectedBaselineId);
  composePort = await publishedPort("server", 3000);
  let baseUrl = apiBaseUrl();
  await waitForApiAndDatabase(baseUrl);

  const manifest = await createSdkManifest();
  await createRssBin(baseUrl, "rss-main", manifest, {
    userAgent: "Binny E2E",
    key: "az",
  });
  const resourceBytes = new TextEncoder().encode("binny media bytes v1");
  const resourceResponse = await fetch(baseUrl + "/resources", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Blob([resourceBytes]),
  });
  assert.equal(
    resourceResponse.status,
    201,
    await resourceResponse.clone().text(),
  );
  const resourceMetadata = (await resourceResponse.json()) as {
    readonly resourceId: string;
  };
  const resourceId = resourceMetadata.resourceId;
  const aMarkdown = `正文 A，媒体 binny://resource/${resourceId}`;
  const baselineStates = [
    { title: "版本 A", markdown: aMarkdown, phase: "A", resourceId },
    { title: "版本 B", markdown: "正文 B", phase: "B", resourceId: undefined },
    { title: "版本 A", markdown: aMarkdown, phase: "A", resourceId },
  ] as const;
  const baselineObservations: UpgradeArchiveObservation[] = [];
  for (const [index, state] of baselineStates.entries()) {
    baselineObservations.push(
      await submitUpgradeArchiveObservation(
        baseUrl,
        `binny36:database-package-upgrade:observation-${String(index + 1)}`,
        state.title,
        state.markdown,
        state.phase,
        state.resourceId,
      ),
    );
  }
  const firstObservation = baselineObservations[0];
  const middleObservation = baselineObservations[1];
  const lastObservation = baselineObservations[2];
  assert.ok(firstObservation);
  assert.ok(middleObservation);
  assert.ok(lastObservation);
  assert.equal(firstObservation.itemId, middleObservation.itemId);
  assert.equal(firstObservation.itemId, lastObservation.itemId);
  assert.notEqual(firstObservation.revisionId, middleObservation.revisionId);
  assert.equal(firstObservation.revisionId, lastObservation.revisionId);
  const archiveItemId = firstObservation.itemId;
  const middleArchiveSeq = middleObservation.archiveSeq;
  const oldArchive = await readUpgradeArchive(baseUrl, archiveItemId);
  assert.equal(oldArchive.revisions.length, 2);
  assert.equal(oldArchive.observations.length, 3);
  assert.equal(oldArchive.views[0]?.state.body?.markdown, aMarkdown);
  const oldHistoricalArchive = await readUpgradeArchive(
    baseUrl,
    archiveItemId,
    middleArchiveSeq,
  );
  assert.equal(oldHistoricalArchive.views[0]?.state.body?.markdown, "正文 B");
  assert.deepEqual(
    await readUpgradeResource(baseUrl, resourceId),
    resourceBytes,
  );

  const runId = await seedUpgradeRun(baseUrl, manifest);
  const oldRun = cliData<{
    readonly status: string;
    readonly result?: { readonly stopReason?: { readonly code?: string } };
  }>(await cli(baseUrl, ["run", "get", "rss-main", runId]), "found");
  assert.equal(oldRun.status, "completed");
  assert.equal(await containerImageId("server"), expectedBaselineId);
  const baselineHistory = await migrationHistory();

  await compose(["stop", "server"]);
  activeServerImage = imageName;
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "360",
    "--no-build",
    "--force-recreate",
    "server",
  ]);
  const runningCandidateId = await containerImageId("server");
  assert.equal(runningCandidateId, candidateImageId);
  assert.notEqual(runningCandidateId, runningBaselineId);
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  await waitForApiAndDatabase(baseUrl);
  assert.equal(await migrationHistory(), baselineHistory);

  const candidateArchive = await readUpgradeArchive(baseUrl, archiveItemId);
  assert.equal(candidateArchive.revisions.length, 2);
  assert.equal(candidateArchive.observations.length, 3);
  assert.equal(candidateArchive.views[0]?.state.body?.markdown, aMarkdown);
  const candidateHistoricalArchive = await readUpgradeArchive(
    baseUrl,
    archiveItemId,
    middleArchiveSeq,
  );
  assert.equal(
    candidateHistoricalArchive.views[0]?.state.body?.markdown,
    "正文 B",
  );
  assert.deepEqual(
    await readUpgradeResource(baseUrl, resourceId),
    resourceBytes,
  );

  const continuedItem = await submitUpgradeArchiveObservation(
    baseUrl,
    "binny36:database-package-upgrade:candidate",
    "候选数据库包追加版本",
    "候选数据库包写入的新正文",
    "candidate",
  );
  assert.equal(continuedItem.itemId, archiveItemId);
  assert.notEqual(continuedItem.revisionId, lastObservation.revisionId);
  const continuedArchive = await readUpgradeArchive(baseUrl, archiveItemId);
  assert.equal(
    continuedArchive.views[0]?.state.body?.markdown,
    "候选数据库包写入的新正文",
  );
  assert.equal(continuedArchive.revisions.length, 3);
  assert.equal(continuedArchive.observations.length, 4);
  const continuedHistoricalArchive = await readUpgradeArchive(
    baseUrl,
    archiveItemId,
    middleArchiveSeq,
  );
  assert.equal(
    continuedHistoricalArchive.views[0]?.state.body?.markdown,
    "正文 B",
  );

  const candidateRun = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["run", "get", "rss-main", runId]),
    "found",
  );
  assert.equal(candidateRun.status, "completed");

  await compose(["restart", "server"]);
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  await waitForApiAndDatabase(baseUrl);
  assert.equal(await containerImageId("server"), candidateImageId);
  assert.equal(await migrationHistory(), baselineHistory);
  const restartedRun = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["run", "get", "rss-main", runId]),
    "found",
  );
  assert.equal(restartedRun.status, "completed");

  const persistedArchive = await readUpgradeArchive(baseUrl, archiveItemId);
  assert.equal(
    persistedArchive.views[0]?.state.body?.markdown,
    "候选数据库包写入的新正文",
  );
  assert.equal(persistedArchive.revisions.length, 3);
  assert.equal(persistedArchive.observations.length, 4);
  const restartedHistoricalArchive = await readUpgradeArchive(
    baseUrl,
    archiveItemId,
    middleArchiveSeq,
  );
  assert.equal(
    restartedHistoricalArchive.views[0]?.state.body?.markdown,
    "正文 B",
  );
  assert.deepEqual(
    await readUpgradeResource(baseUrl, resourceId),
    resourceBytes,
  );

  process.stdout.write(
    "票 36 旧正式镜像升级证据：" +
      JSON.stringify({
        baselineImage,
        baselineImageId: runningBaselineId,
        candidateImage: imageName,
        candidateImageId: runningCandidateId,
        runId,
        archiveItemId,
        candidateRevisionId: continuedItem.revisionId,
        previousRevisionId: lastObservation.revisionId,
        resourceId,
        migrationHistory: JSON.parse(baselineHistory) as unknown,
        candidateRestarted: true,
      }) +
      "\n",
  );
}

function archiveIds(state: string): {
  readonly itemId: string;
  readonly relationItemId: string;
  readonly relationCommitId: string;
  readonly revisionId: string;
  readonly comparedRevisionId: string;
  readonly commitId: string;
  readonly historicalAsOf: string;
  readonly relationAsOf: string;
  readonly resourceItemId: string;
  readonly resourceRevisionId: string;
  readonly resourcePartialRevisionId: string;
  readonly resourceRepairedRevisionId: string;
  readonly resourceId: string;
  readonly repairedResourceId: string;
  readonly orphanResourceId: string;
  readonly resourceMarkerItemId: string;
  readonly cliCascadeRootItemId: string;
  readonly cliCascadeTargetItemId: string;
} {
  const parsed: unknown = JSON.parse(state);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("归档验收状态格式无效。");
  }
  const fields = parsed as Record<string, unknown>;
  const readText = (name: string): string => {
    const value = fields[name];
    if (typeof value !== "string") {
      throw new Error(`归档验收状态缺少 ${name}。`);
    }
    return value;
  };
  return {
    itemId: readText("itemId"),
    relationItemId: readText("relationItemId"),
    relationCommitId: readText("relationCommitId"),
    revisionId: readText("revisionId"),
    comparedRevisionId: readText("comparedRevisionId"),
    commitId: readText("commitId"),
    historicalAsOf: readText("historicalAsOf"),
    relationAsOf: readText("relationAsOf"),
    resourceItemId: readText("resourceItemId"),
    resourceRevisionId: readText("resourceRevisionId"),
    resourcePartialRevisionId: readText("resourcePartialRevisionId"),
    resourceRepairedRevisionId: readText("resourceRepairedRevisionId"),
    resourceId: readText("resourceId"),
    repairedResourceId: readText("repairedResourceId"),
    orphanResourceId: readText("orphanResourceId"),
    resourceMarkerItemId: readText("resourceMarkerItemId"),
    cliCascadeRootItemId: readText("cliCascadeRootItemId"),
    cliCascadeTargetItemId: readText("cliCascadeTargetItemId"),
  };
}

function archiveResponses(response: string): {
  readonly item: unknown;
  readonly historicalItem: unknown;
  readonly revision: unknown;
  readonly revisionDiff: unknown;
  readonly resourcePartialDiff: unknown;
  readonly resourceDiff: unknown;
  readonly resourceItem: unknown;
  readonly resourceMarkerItem: unknown;
  readonly sdkItem: unknown;
  readonly sdkResourceMetadata: {
    readonly resourceId: string;
    readonly mediaType: string;
    readonly size: number;
    readonly sha256: string;
  };
  readonly firstTimelinePage: unknown;
  readonly secondTimelinePage: unknown;
  readonly commit: unknown;
  readonly relationCommit: unknown;
  readonly relationPage: unknown;
  readonly relationTimelinePage: unknown;
} {
  const parsed: unknown = JSON.parse(response);
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.ok(
    "item" in parsed &&
      "revision" in parsed &&
      "revisionDiff" in parsed &&
      "resourcePartialDiff" in parsed &&
      "resourceDiff" in parsed &&
      "resourceItem" in parsed &&
      "resourceMarkerItem" in parsed &&
      "sdkItem" in parsed &&
      "sdkResourceMetadata" in parsed &&
      "historicalItem" in parsed &&
      "firstTimelinePage" in parsed &&
      "secondTimelinePage" in parsed &&
      "commit" in parsed &&
      "relationCommit" in parsed &&
      "relationPage" in parsed &&
      "relationTimelinePage" in parsed,
  );
  assert.ok(typeof parsed.sdkResourceMetadata === "object");
  assert.ok(parsed.sdkResourceMetadata !== null);
  assert.ok("resourceId" in parsed.sdkResourceMetadata);
  assert.ok("mediaType" in parsed.sdkResourceMetadata);
  assert.ok("size" in parsed.sdkResourceMetadata);
  assert.ok("sha256" in parsed.sdkResourceMetadata);
  return {
    item: parsed.item,
    historicalItem: parsed.historicalItem,
    revision: parsed.revision,
    revisionDiff: parsed.revisionDiff,
    resourcePartialDiff: parsed.resourcePartialDiff,
    resourceDiff: parsed.resourceDiff,
    resourceItem: parsed.resourceItem,
    resourceMarkerItem: parsed.resourceMarkerItem,
    sdkItem: parsed.sdkItem,
    sdkResourceMetadata: parsed.sdkResourceMetadata as {
      readonly resourceId: string;
      readonly mediaType: string;
      readonly size: number;
      readonly sha256: string;
    },
    firstTimelinePage: parsed.firstTimelinePage,
    secondTimelinePage: parsed.secondTimelinePage,
    commit: parsed.commit,
    relationCommit: parsed.relationCommit,
    relationPage: parsed.relationPage,
    relationTimelinePage: parsed.relationTimelinePage,
  };
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

type HeldTableLock = {
  readonly release: () => Promise<void>;
};

type ManualRunLockWaiter = {
  readonly pid: number;
  readonly blockers: readonly number[];
};

function postgresExecArgs(args: readonly string[]): readonly string[] {
  return [
    ...composePrefix(),
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
    ...args,
  ];
}

async function holdTableShareLock(table: string): Promise<HeldTableLock> {
  assert.ok(
    table === "archive_resource" || table === "archive_revision_resource",
  );
  const lock = startManagedProcess("docker", postgresExecArgs([]));
  lock.write(
    `BEGIN;\nLOCK TABLE ${table} IN SHARE MODE;\nSELECT 'BINNY04_LOCK_HELD';\n`,
  );
  await lock.waitForMarker("BINNY04_LOCK_HELD");
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      lock.write("COMMIT;\n\\q\n");
      const result = await lock.waitForClose();
      assert.equal(result.code, 0, result.stderr);
    },
  };
}

async function holdManualRunRowLock(runId: string): Promise<{
  readonly backendPid: number;
  readonly release: () => Promise<void>;
}> {
  assert.match(runId, /^[0-9a-f-]{36}$/u);
  const lock = startManagedProcess("docker", postgresExecArgs([]));
  lock.write(
    `BEGIN;\nSELECT pg_backend_pid();\nSELECT run_id FROM manual_runs WHERE run_id = '${runId}'::uuid FOR UPDATE;\nSELECT 'BINNY18_MANUAL_RUN_ROW_LOCK_HELD';\n`,
  );
  await lock.waitForMarker("BINNY18_MANUAL_RUN_ROW_LOCK_HELD");
  const backendPid = Number(lock.stdout().trim().split("\n")[0]);
  assert.ok(Number.isInteger(backendPid) && backendPid > 0);
  let released = false;
  return {
    backendPid,
    async release() {
      if (released) return;
      released = true;
      lock.write("COMMIT;\n\\q\n");
      const result = await lock.waitForClose();
      assert.equal(result.code, 0, result.stderr);
    },
  };
}

async function readManualRunLockWaiters(): Promise<
  readonly ManualRunLockWaiter[]
> {
  const result = await compose(
    postgresExecArgs([
      "-c",
      "SELECT json_build_object('pid', activity.pid, 'blockers', pg_blocking_pids(activity.pid)) FROM pg_stat_activity AS activity WHERE activity.datname = current_database() AND activity.wait_event_type = 'Lock';",
    ]).slice(composePrefix().length),
  );
  const output = result.stdout.trim();
  if (output.length === 0) return [];
  return output.split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    assert.ok(typeof value === "object" && value !== null);
    assert.ok("pid" in value && typeof value.pid === "number");
    assert.ok("blockers" in value && Array.isArray(value.blockers));
    assert.ok(value.blockers.every((pid: unknown) => typeof pid === "number"));
    return {
      pid: value.pid,
      blockers: value.blockers,
    };
  });
}

async function waitForManualRunLockWaiterBlockedBy(
  blockerPid: number,
  excludingPids: readonly number[] = [],
): Promise<number> {
  const waiter = await waitFor(
    async () =>
      (await readManualRunLockWaiters()).find(
        (candidate) =>
          !excludingPids.includes(candidate.pid) &&
          candidate.blockers.includes(blockerPid),
      ),
    (candidate) => candidate !== undefined,
    `PostgreSQL 行锁等待方被进程 ${String(blockerPid)} 阻塞`,
  );
  assert.ok(waiter !== undefined);
  return waiter.pid;
}

async function resourceFiles(): Promise<readonly string[]> {
  const result = await compose([
    "exec",
    "--no-TTY",
    "server",
    "node",
    "--input-type=module",
    "-e",
    'import { readdir } from "node:fs/promises"; process.stdout.write(JSON.stringify(await readdir("/var/lib/binny/resources")));',
  ]);
  const files: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(files));
  assert.ok(files.every((file) => typeof file === "string"));
  return files as string[];
}

async function waitFor<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (isReady(latest)) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `等待 ${description} 超时，最近状态：${JSON.stringify(latest)}`,
  );
}

async function waitForBlockedTableWrite(
  table: "archive_resource" | "archive_revision_resource",
): Promise<void> {
  // 按关系 OID 观察未授予写锁，避免依赖 Drizzle 生成的标识符文本。
  const relationByTable = {
    archive_resource: "public.archive_resource",
    archive_revision_resource: "public.archive_revision_resource",
  } as const;
  await waitFor(
    async () => {
      const result = await compose(
        postgresExecArgs([
          "-c",
          `SELECT count(*) FROM pg_locks AS blocked INNER JOIN pg_stat_activity AS activity ON activity.pid = blocked.pid WHERE activity.datname = current_database() AND activity.wait_event_type = 'Lock' AND blocked.locktype = 'relation' AND blocked.relation = '${relationByTable[table]}'::regclass AND blocked.mode = 'RowExclusiveLock' AND NOT blocked.granted;`,
        ]).slice(composePrefix().length),
      );
      return Number(result.stdout.trim());
    },
    (count) => count > 0,
    `PostgreSQL 等待 ${table} 写锁`,
  );
}

async function restartServer(): Promise<string> {
  await compose(["up", "--detach", "--wait", "--wait-timeout", "90", "server"]);
  composePort = await publishedPort("server", 3000);
  return apiBaseUrl();
}

function resourceUploadProcess(): ManagedProcess {
  const program = [
    'const body = Buffer.from("binny15 interrupted resource publish");',
    'process.stdout.write("BINNY04_UPLOAD_STARTED\\n");',
    'const response = await fetch("http://127.0.0.1:3000/resources", { method: "POST", headers: { "content-type": "application/octet-stream" }, body });',
    'process.stdout.write("BINNY04_UPLOAD_RESPONSE " + response.status + " " + await response.text() + "\\n");',
  ].join("\n");
  return startManagedProcess("docker", [
    ...composePrefix(),
    "exec",
    "--no-TTY",
    "server",
    "node",
    "--input-type=module",
    "-e",
    program,
  ]);
}

function archiveReferenceProcess(resourceId: string): ManagedProcess {
  assert.match(resourceId, /^[0-9a-f-]{36}$/u);
  const requestId = "e2e:resource-interrupted-reference:" + randomUUID();
  const sourceKey = "resource-interrupted-reference:" + randomUUID();
  const request = JSON.stringify({
    requestId,
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: sourceKey },
        body: { text: "引用登记被进程中断" },
        resources: [{ resourceId }],
        capture: {
          scope: { case: "interrupted-resource-reference" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const program = [
    'process.stdout.write("BINNY04_REFERENCE_STARTED\\n");',
    `const response = await fetch("http://127.0.0.1:3000/archives", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(request)} });`,
    'process.stdout.write("BINNY04_REFERENCE_RESPONSE " + response.status + " " + await response.text() + "\\n");',
  ].join("\n");
  return startManagedProcess("docker", [
    ...composePrefix(),
    "exec",
    "--no-TTY",
    "server",
    "node",
    "--input-type=module",
    "-e",
    program,
  ]);
}

async function verifyResourceStorageInterruptions(
  baseUrl: string,
  archive: string,
): Promise<string> {
  let currentBaseUrl = baseUrl;
  const filesBeforePublish = await resourceFiles();
  let publishLock: HeldTableLock | undefined;
  let publishRequest: ManagedProcess | undefined;
  let publishServerNeedsRestart = false;
  try {
    publishLock = await holdTableShareLock("archive_resource");
    publishRequest = resourceUploadProcess();
    await publishRequest.waitForMarker("BINNY04_UPLOAD_STARTED");
    const publishedFiles = await waitFor(
      () => resourceFiles(),
      (files) => files.some((file) => !filesBeforePublish.includes(file)),
      "资源文件在登记前发布到持久目录",
    );
    const newPublishedFiles = publishedFiles.filter(
      (file) => !filesBeforePublish.includes(file),
    );
    assert.equal(newPublishedFiles.length, 1);
    const publishedFile = newPublishedFiles[0];
    assert.ok(publishedFile);
    await waitForBlockedTableWrite("archive_resource");
    assert.doesNotMatch(publishRequest.stdout(), /BINNY04_UPLOAD_RESPONSE/u);

    await compose(["kill", "-s", "SIGKILL", "server"]);
    publishServerNeedsRestart = true;
    await publishLock.release();
    publishLock = undefined;
    const interruptedUpload = await publishRequest.waitForClose();
    assert.notEqual(interruptedUpload.code, 0);
    currentBaseUrl = await restartServer();
    publishServerNeedsRestart = false;
    await waitForApiAndDatabase(currentBaseUrl);
    const filesAfterPublishRecovery = await resourceFiles();
    assert.ok(!filesAfterPublishRecovery.includes(publishedFile));
  } finally {
    if (
      publishRequest !== undefined &&
      publishRequest.child.exitCode === null
    ) {
      if (!publishServerNeedsRestart) {
        await compose(["kill", "-s", "SIGKILL", "server"]);
        publishServerNeedsRestart = true;
      }
    }
    if (publishLock !== undefined) await publishLock.release();
    if (
      publishRequest !== undefined &&
      publishRequest.child.exitCode === null
    ) {
      await publishRequest.waitForClose();
    }
    if (publishServerNeedsRestart) currentBaseUrl = await restartServer();
  }

  const referenceBytes = new TextEncoder().encode(
    "binny15 committed upload survives interrupted reference registration",
  );
  const uploadResponse = await fetch(currentBaseUrl + "/resources", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: referenceBytes,
  });
  assert.equal(uploadResponse.status, 201, await uploadResponse.clone().text());
  if (uploadResponse.status !== 201) {
    throw new Error("引用登记中断场景的资源上传没有提交成功。");
  }
  const uploaded = (await uploadResponse.json()) as {
    readonly resourceId: string;
  };
  let referenceLock: HeldTableLock | undefined;
  let referenceRequest: ManagedProcess | undefined;
  let referenceServerNeedsRestart = false;
  try {
    referenceLock = await holdTableShareLock("archive_revision_resource");
    referenceRequest = archiveReferenceProcess(uploaded.resourceId);
    await referenceRequest.waitForMarker("BINNY04_REFERENCE_STARTED");
    await waitForBlockedTableWrite("archive_revision_resource");
    assert.doesNotMatch(
      referenceRequest.stdout(),
      /BINNY04_REFERENCE_RESPONSE/u,
    );

    await compose(["kill", "-s", "SIGKILL", "server"]);
    referenceServerNeedsRestart = true;
    await referenceLock.release();
    referenceLock = undefined;
    const interruptedReference = await referenceRequest.waitForClose();
    assert.notEqual(interruptedReference.code, 0);
    currentBaseUrl = await restartServer();
    referenceServerNeedsRestart = false;
    await waitForApiAndDatabase(currentBaseUrl);
    const resourceRead = await fetch(
      currentBaseUrl + "/resources/" + uploaded.resourceId,
    );
    assert.equal(resourceRead.status, 200);
    assert.deepEqual(
      new Uint8Array(await resourceRead.arrayBuffer()),
      referenceBytes,
    );

    const archiveIdsValue = archiveIds(archive);
    const historicalResource = await fetch(
      currentBaseUrl + "/resources/" + archiveIdsValue.resourceId,
    );
    assert.equal(historicalResource.status, 200);
    assert.deepEqual(
      new Uint8Array(await historicalResource.arrayBuffer()),
      new TextEncoder().encode("binny media bytes v1"),
      "引用登记失败后的清理不能影响仍被历史版本引用的媒体。",
    );
  } finally {
    if (
      referenceRequest !== undefined &&
      referenceRequest.child.exitCode === null
    ) {
      if (!referenceServerNeedsRestart) {
        await compose(["kill", "-s", "SIGKILL", "server"]);
        referenceServerNeedsRestart = true;
      }
    }
    if (referenceLock !== undefined) await referenceLock.release();
    if (
      referenceRequest !== undefined &&
      referenceRequest.child.exitCode === null
    ) {
      await referenceRequest.waitForClose();
    }
    if (referenceServerNeedsRestart) currentBaseUrl = await restartServer();
  }

  const gracePeriodMs = Number(
    composeEnvironment().BINNY_RESOURCE_UNREFERENCED_AGE_MS,
  );
  await new Promise((resolveGrace) => setTimeout(resolveGrace, gracePeriodMs));
  return currentBaseUrl;
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
    'import { collectorManifest, defineCollector, defineCollectorCheckAction } from "./dist/index.js";',
    "const collector = defineCollector({",
    '  id: "rss",',
    '  version: "1.0.0",',
    "  configSchema: z.object({",
    "    userAgent: z.string().min(1),",
    "    key: z.string().regex(/^a/).regex(/z$/),",
    "  }),",
    "  actions: {",
    '    check: defineCollectorCheckAction({ description: "检查测试信源配置。", params: z.object({}), execute: async () => ({ availability: "unknown", scope: ["test-source"], basis: "验收用 RSS 清单没有连接真实信源。", problems: [{ code: "test_source_unconfigured", message: "验收用 RSS 清单没有连接真实信源。", impact: "无法判断真实订阅源是否可用。", suggestion: "配置真实订阅源后重新触发 check。", requiresHuman: false }] }) }),',
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

async function createRuntimeFixtureManifest(): Promise<unknown> {
  const program = [
    'import { collectorManifest } from "@binny/collector-sdk";',
    'import collector from "./test/fixtures/manual-runs-collector.ts";',
    "process.stdout.write(JSON.stringify(collectorManifest(collector)));",
  ].join("\n");
  const result = await run("pnpm", [
    "--silent",
    "--filter",
    "@binny/collector-runtime",
    "exec",
    "node",
    "--conditions=source",
    "--input-type=module",
    "-e",
    program,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRuntime(baseUrl: string, binId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = cliData<{
      readonly execution: { readonly status: string };
    }>(await cli(baseUrl, ["bin", "get", binId]), "found");
    if (result.execution.status === "online") return;
    await wait(100);
  }
  assert.fail(`bin ${binId} 的运行器没有上线。`);
}

type RssRequestRecord = {
  readonly path: string;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
};

type RssControlState = {
  readonly requests: readonly RssRequestRecord[];
  readonly photoBytes: string;
  readonly audioBytes: string;
};

type RssControlSource = {
  readonly baseUrl: string;
  readonly requests: () => Promise<readonly RssRequestRecord[]>;
  readonly mediaBytes: () => Promise<{
    readonly photoBytes: Buffer;
    readonly audioBytes: Buffer;
  }>;
  readonly setRssVersion: (version: number) => Promise<void>;
  readonly setAtomVersion: (version: number) => Promise<void>;
  readonly setAtomTextMode: (mode: "text" | "html") => Promise<void>;
  readonly setTemporaryAvailable: (available: boolean) => Promise<void>;
  readonly setPhotoAvailable: (available: boolean) => Promise<void>;
  readonly setStaticArticleVersion: (version: number) => Promise<void>;
  readonly setStaticPhotoAvailable: (available: boolean) => Promise<void>;
  readonly setRecoveryPageAvailable: (available: boolean) => Promise<void>;
};

async function createRssControlSource(port: number): Promise<RssControlSource> {
  const host = process.env.BINNY_E2E_HOST ?? "172.17.0.1";
  const controlUrl = `http://${host}:${String(port)}`;
  const baseUrl = "http://rss-e2e-source:8081";

  async function readState(): Promise<RssControlState> {
    const response = await fetch(controlUrl + "/control/state", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as RssControlState;
  }

  async function updateState(
    value: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const response = await fetch(controlUrl + "/control/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
  }

  const deadline = Date.now() + 30_000;
  let ready = false;
  let lastFailure = "受控信源 Compose 服务尚未启动。";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(controlUrl + "/health", {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        ready = true;
        break;
      }
      lastFailure = `受控信源返回 HTTP ${String(response.status)}。`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await wait(100);
  }
  assert.ok(ready, `受控信源没有在 Compose 随机宿主端口就绪：${lastFailure}`);
  await readState();

  return {
    baseUrl,
    async requests() {
      return (await readState()).requests;
    },
    async mediaBytes() {
      const current = await readState();
      return {
        photoBytes: Buffer.from(current.photoBytes, "base64"),
        audioBytes: Buffer.from(current.audioBytes, "base64"),
      };
    },
    async setRssVersion(version) {
      await updateState({ rssVersion: version });
    },
    async setAtomVersion(version) {
      await updateState({ atomVersion: version });
    },
    async setAtomTextMode(mode) {
      await updateState({ atomTextMode: mode });
    },
    async setTemporaryAvailable(available) {
      await updateState({ temporaryAvailable: available });
    },
    async setPhotoAvailable(available) {
      await updateState({ photoAvailable: available });
    },
    async setStaticArticleVersion(version) {
      await updateState({ staticArticleVersion: version });
    },
    async setStaticPhotoAvailable(available) {
      await updateState({ staticPhotoAvailable: available });
    },
    async setRecoveryPageAvailable(available) {
      await updateState({ recoveryPageAvailable: available });
    },
  };
}

type RssManualRun = {
  readonly status: string;
  readonly runId: string;
  readonly binId: string;
  readonly finishedAt?: string;
  readonly result?: {
    readonly completedScopes: readonly string[];
    readonly commits: readonly {
      readonly items: readonly { readonly itemId: string }[];
    }[];
    readonly stopReason: { readonly code: string };
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly suggestion?: string;
    };
    readonly check?: {
      readonly availability: "available" | "unavailable" | "unknown";
      readonly checkedAt: string;
      readonly scope: readonly string[];
      readonly basis: string;
      readonly problems: readonly {
        readonly code: string;
        readonly message: string;
        readonly suggestion: string;
      }[];
    };
  };
};

async function createRssManifest(): Promise<unknown> {
  const program = [
    'import { collectorManifest } from "@binny/collector-sdk";',
    'import collector from "@binny/collector-rss";',
    "process.stdout.write(JSON.stringify(collectorManifest(collector)));",
  ].join("\n");
  const result = await run("pnpm", [
    "--silent",
    "--filter",
    "@binny/collector-rss",
    "exec",
    "node",
    "--conditions=source",
    "--input-type=module",
    "-e",
    program,
  ]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout) as unknown;
}

async function createRssBin(
  baseUrl: string,
  binId: string,
  manifest: unknown,
  config: unknown,
): Promise<void> {
  const manifestJson = JSON.stringify(manifest);
  const configJson = JSON.stringify(config);
  assert.ok(manifestJson !== undefined && configJson !== undefined);
  const created = cliData<{ readonly id: string }>(
    await cli(baseUrl, [
      "bin",
      "create",
      binId,
      "--collector",
      manifestJson,
      "--identity",
      binId + "-identity",
      "--config",
      configJson,
      "--targets",
      "[]",
    ]),
    "created",
  );
  assert.equal(created.id, binId);
}

async function waitForRuntimeHealth(service: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const probe = [
    "const response = await fetch('http://127.0.0.1:8080/health');",
    'const body = await response.json(); if (!response.ok || body.process !== "ready") process.exit(1);',
  ].join("\n");
  let lastFailure = "运行器尚未启动。";
  while (Date.now() < deadline) {
    const result = await run(
      "docker",
      [
        ...composePrefix(),
        "exec",
        "--no-TTY",
        service,
        "node",
        "--input-type=module",
        "-e",
        probe,
      ],
      { env: composeEnvironment() },
    );
    if (result.code === 0) return;
    lastFailure = result.stderr + result.stdout;
    await wait(100);
  }
  assert.fail(`Compose 运行器 ${service} 没有就绪：${lastFailure}`);
}

async function triggerRssAction(
  baseUrl: string,
  binId: string,
  action: "check" | "collect",
  params: Readonly<Record<string, unknown>>,
): Promise<RssManualRun> {
  const triggered = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      action,
      "--params",
      JSON.stringify(params),
    ]),
    "triggered",
  );
  assert.equal(triggered.status, "queued");
  const deadline = Date.now() + 60_000;
  let latest: RssManualRun | undefined;
  while (Date.now() < deadline) {
    latest = cliData<RssManualRun>(
      await cli(baseUrl, ["run", "get", binId, triggered.runId]),
      "found",
    );
    if (latest.status === "completed" || latest.status === "failed")
      return latest;
    await wait(100);
  }
  assert.fail(`等待 RSS ${action} 运行终结超时：${JSON.stringify(latest)}`);
}

type RssArchiveRead = {
  readonly itemId: string;
  readonly sourceKey: { readonly namespace: string; readonly key: string };
  readonly snapshot: unknown;
  readonly views: readonly {
    readonly binId: string;
    readonly state: {
      readonly body?: {
        readonly html?: string;
        readonly markdown?: string;
        readonly text?: string;
        readonly searchText?: string;
      };
      readonly metadata?: Record<string, unknown> & {
        readonly item?: {
          readonly bodyType?: string;
          readonly bodySource?: string;
          readonly bodyUrl?: string;
          readonly bodyFinalUrl?: string;
          readonly bodyTitle?: string | null;
        } | null;
      };
      readonly resources?: readonly { readonly resourceId: string }[];
      readonly capture: {
        readonly completeness: "complete" | "partial";
        readonly scope: {
          readonly bodySource?: string;
          readonly bodyUrl?: string;
          readonly bodyFinalUrl?: string;
        };
        readonly missing: readonly {
          readonly path: string;
          readonly reason: string;
        }[];
      };
    };
  }[];
  readonly revisions: readonly {
    readonly revisionId: string;
    readonly stateHash: string;
  }[];
  readonly observations: readonly unknown[];
};

async function searchRssArchive(
  baseUrl: string,
  binId: string,
  text: string,
): Promise<
  readonly {
    readonly itemId: string;
    readonly sourceKey?: { readonly namespace: string; readonly key: string };
  }[]
> {
  const query = {
    scope: { kind: "current", binId },
    text: { kind: "literal", value: text },
    select: ["sourceKey", "sourceRef", "capture.completeness"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 100,
  };
  const page = cliData<{
    readonly results: readonly {
      readonly itemId: string;
      readonly sourceKey?: { readonly namespace: string; readonly key: string };
    }[];
  }>(
    await cli(baseUrl, ["archive", "search", "--query", JSON.stringify(query)]),
    "found",
  );
  return page.results;
}

async function readRssArchive(
  baseUrl: string,
  binId: string,
  text: string,
): Promise<RssArchiveRead> {
  const results = await searchRssArchive(baseUrl, binId, text);
  assert.equal(results.length, 1, `归档正文检索「${text}」应命中一项。`);
  const result = results[0];
  assert.ok(result?.sourceKey !== undefined);
  const item = cliData<RssArchiveRead>(
    await cli(baseUrl, ["archive", "item", result.itemId, "--bin", binId]),
    "found",
  );
  assert.deepEqual(item.sourceKey, result.sourceKey);
  return item;
}

function rssArchiveView(
  item: RssArchiveRead,
  binId: string,
): RssArchiveRead["views"][number]["state"] {
  const view = item.views.find((entry) => entry.binId === binId);
  assert.ok(view !== undefined, `归档条目没有 ${binId} 的视图。`);
  return view.state;
}

async function readRssResource(
  baseUrl: string,
  resourceId: string,
): Promise<Buffer> {
  const response = await fetch(`${baseUrl}/resources/${resourceId}`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0);
  return bytes;
}

function sourceArrived(
  response: unknown,
  gateKey: string,
  runId?: string,
  binId?: string,
): boolean {
  if (
    typeof response !== "object" ||
    response === null ||
    !("arrivals" in response) ||
    !Array.isArray(response.arrivals)
  ) {
    return false;
  }
  return response.arrivals.some((arrival: unknown) => {
    if (typeof arrival !== "object" || arrival === null) return false;
    return (
      "gateKey" in arrival &&
      arrival.gateKey === gateKey &&
      (runId === undefined ||
        ("runId" in arrival && arrival.runId === runId)) &&
      (binId === undefined || ("binId" in arrival && arrival.binId === binId))
    );
  });
}

async function waitForSourceArrival(
  sourceUrl: string,
  gateKey: string,
  runId?: string,
  binId?: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(sourceUrl + "/control/arrivals", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const status: unknown = await response.json();
    if (sourceArrived(status, gateKey, runId, binId)) return;
    await wait(50);
  }
  assert.fail(`运行没有到达受控信源：${gateKey}`);
}

async function waitForScheduledArrival(
  sourceUrl: string,
  gateKeys: readonly string[],
  binId: string,
): Promise<{ readonly gateKey: string; readonly runId: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(sourceUrl + "/control/arrivals", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const status: unknown = await response.json();
    if (
      typeof status === "object" &&
      status !== null &&
      "arrivals" in status &&
      Array.isArray(status.arrivals)
    ) {
      for (const gateKey of gateKeys) {
        const arrival = status.arrivals.find(
          (value: unknown) =>
            typeof value === "object" &&
            value !== null &&
            "gateKey" in value &&
            value.gateKey === gateKey &&
            "binId" in value &&
            value.binId === binId &&
            "runId" in value &&
            typeof value.runId === "string",
        );
        if (
          typeof arrival === "object" &&
          arrival !== null &&
          "runId" in arrival &&
          typeof arrival.runId === "string"
        ) {
          return { gateKey, runId: arrival.runId };
        }
      }
    }
    await wait(50);
  }
  assert.fail("重启后没有受控信源到达计划运行。");
}

async function countSourceArrivals(
  sourceUrl: string,
  gateKey: string,
  binId: string,
): Promise<number> {
  const response = await fetch(sourceUrl + "/control/arrivals", {
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  const status: unknown = await response.json();
  if (
    typeof status !== "object" ||
    status === null ||
    !("arrivals" in status) ||
    !Array.isArray(status.arrivals)
  ) {
    return 0;
  }
  return status.arrivals.filter(
    (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      "gateKey" in value &&
      value.gateKey === gateKey &&
      "binId" in value &&
      value.binId === binId,
  ).length;
}

async function releaseSource(
  sourceUrl: string,
  gateKey: string,
  disposition:
    | "material"
    | "slow"
    | "available"
    | "unavailable"
    | "unknown" = "material",
): Promise<void> {
  const response = await fetch(sourceUrl + "/control/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gateKey, disposition }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
}

function manualRunSourceRuntimeUrl(): string {
  return "http://manual-runs-source:8081";
}

function manualRunSourceControlUrl(): string {
  const host = process.env.BINNY_E2E_HOST ?? "172.17.0.1";
  return "http://" + host + ":" + String(manualRunSourcePort);
}

async function waitForManualRunSource(): Promise<void> {
  const sourceUrl = manualRunSourceControlUrl();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(sourceUrl + "/control/arrivals", {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status === 200) return;
    } catch {
      // Compose 服务可能比 `up --wait` 晚几毫秒开始监听。
    }
    await wait(50);
  }
  assert.fail("受控信源没有在 Compose 网络入口启动。");
}

async function waitForSourceMarker(
  sourceUrl: string,
  runId: string,
  gateKey: string,
  marker: string,
): Promise<void> {
  await waitFor(
    async () => {
      const response = await fetch(sourceUrl + "/control/arrivals", {
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as unknown;
    },
    (status) =>
      typeof status === "object" &&
      status !== null &&
      "markers" in status &&
      Array.isArray(status.markers) &&
      status.markers.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "runId" in entry &&
          entry.runId === runId &&
          "gateKey" in entry &&
          entry.gateKey === gateKey &&
          "marker" in entry &&
          entry.marker === marker,
      ),
    `运行 ${runId} 写出信源标记 ${marker}`,
  );
}

async function runtimeProcessSnapshot(service: string): Promise<
  readonly {
    readonly pid: number;
    readonly pgid: number;
    readonly command: string;
  }[]
> {
  const containers = await compose(["ps", "-q", service]);
  const containerId = containers.stdout.trim().split("\n")[0];
  assert.ok(containerId, `没有找到 Compose 服务 ${service} 的容器。`);
  const processes = await run(
    "docker",
    ["top", containerId, "-eo", "pid,pgid,args"],
    { env: composeEnvironment() },
  );
  assert.equal(processes.code, 0, processes.stderr);
  return processes.stdout
    .trim()
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/u.exec(line.trim());
      return match === null
        ? []
        : [
            {
              pid: Number(match[1]),
              pgid: Number(match[2]),
              command: match[3]!,
            },
          ];
    });
}

type ManualRunCliState = {
  readonly runId: string;
  readonly binId: string;
  readonly action: string;
  readonly trigger:
    | { readonly kind: "manual" }
    | {
        readonly kind: "schedule";
        readonly scheduleId: string;
        readonly scheduledFor: string;
      };
  readonly status: string;
  readonly queueReason?:
    | "runtime_offline"
    | "earlier_run_active"
    | "earlier_run_queued"
    | "previous_execution_unconfirmed";
  readonly cancellationRequestedAt?: string;
  readonly stopConfirmedAt?: string;
  readonly result?: {
    readonly completedScopes: readonly string[];
    readonly commits: readonly {
      readonly commitId: string;
      readonly items: readonly { readonly itemId: string }[];
    }[];
    readonly stopReason: { readonly code: string };
    readonly error?: { readonly code: string };
    readonly check?: {
      readonly availability: "available" | "unavailable" | "unknown";
      readonly checkedAt: string;
      readonly scope: readonly string[];
      readonly basis: string;
      readonly problems: readonly {
        readonly suggestion: string;
        readonly requiresHuman: boolean;
      }[];
    };
  };
};

async function waitForCliManualRunState(
  baseUrl: string,
  binId: string,
  runId: string,
  statuses: readonly string[],
): Promise<ManualRunCliState> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, runId]),
      "found",
    );
    if (statuses.includes(current.status)) return current;
    await wait(50);
  }
  assert.fail(`运行没有进入预期状态：${statuses.join("/")}`);
}

type RuntimeExecutionState = {
  readonly status: string;
  readonly runtimeId?: string;
  readonly reason?: string;
};

async function readRuntimeExecutionState(
  baseUrl: string,
  binId: string,
): Promise<RuntimeExecutionState> {
  const bin = cliData<{ readonly execution: RuntimeExecutionState }>(
    await cli(baseUrl, ["bin", "get", binId]),
    "found",
  );
  return bin.execution;
}

async function waitForReplacementRuntime(
  baseUrl: string,
  binId: string,
  previousRuntimeId: string,
): Promise<string> {
  const replacement = await waitFor(
    () => readRuntimeExecutionState(baseUrl, binId),
    (current) =>
      current.status === "online" &&
      current.runtimeId !== undefined &&
      current.runtimeId !== previousRuntimeId,
    `bin ${binId} 的替换运行器上线`,
  );
  assert.ok(replacement.runtimeId !== undefined);
  return replacement.runtimeId;
}

async function verifyDelayedOldOwnerCannotDisturbRun(
  baseUrl: string,
  heartbeatProxy: HeartbeatDelayProxy,
  label: string,
  currentRuntimeId: string,
): Promise<void> {
  const binId = "binny15-one";
  const service = "runtime-fifteen-one";
  const sourceControlUrl = manualRunSourceControlUrl();
  const gateKey = `18-${label}-late-owner-${randomUUID()}`;
  const run = cliData<{ readonly runId: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey,
        sourceKey: gateKey,
        waitAfterCommitMs: 60_000,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(sourceControlUrl, gateKey, run.runId, binId);
  await releaseSource(sourceControlUrl, gateKey, "slow");
  await waitForSourceMarker(sourceControlUrl, run.runId, gateKey, "committed");
  const worker = (await runtimeProcessSnapshot(service)).find((process) =>
    process.command.includes("worker.js"),
  );
  assert.ok(worker, `${label} 应有真实的新 owner worker 正在运行。`);

  await heartbeatProxy.release();
  await wait(150);
  const afterLateHeartbeat = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", binId, run.runId]),
    "found",
  );
  assert.equal(
    afterLateHeartbeat.status,
    "executing",
    `${label} 的迟到旧 idle 不能终结新 owner 的运行。`,
  );
  assert.equal(afterLateHeartbeat.stopConfirmedAt, undefined);
  const ownerAfterLateHeartbeat = await readRuntimeExecutionState(
    baseUrl,
    binId,
  );
  assert.equal(ownerAfterLateHeartbeat.status, "online");
  assert.equal(ownerAfterLateHeartbeat.runtimeId, currentRuntimeId);
  assert.ok(
    (await runtimeProcessSnapshot(service)).some(
      (process) => process.pgid === worker.pgid,
    ),
    `${label} 的迟到旧 idle 不能确认仍在运行的 worker 已停止。`,
  );

  const cancellation = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "cancel", binId, run.runId]),
    "cancellation",
  );
  assert.equal(cancellation.status, "cancelling");
  const cancelled = await waitForCliManualRunState(baseUrl, binId, run.runId, [
    "cancelled",
  ]);
  assert.ok(cancelled.stopConfirmedAt);
  await waitFor(
    () => runtimeProcessSnapshot(service),
    (processes) => !processes.some((process) => process.pgid === worker.pgid),
    `${label} 的取消确认等待真实 worker 退出`,
  );

  const completedGate = `18-${label}-replacement-run-${randomUUID()}`;
  const completedRun = cliData<{ readonly runId: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey: completedGate,
        sourceKey: completedGate,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(
    sourceControlUrl,
    completedGate,
    completedRun.runId,
    binId,
  );
  await releaseSource(sourceControlUrl, completedGate);
  const completed = await waitForCliManualRunState(
    baseUrl,
    binId,
    completedRun.runId,
    ["completed"],
  );
  assert.equal(completed.result?.stopReason.code, "completed");
}

async function ownerGenerationOverlapStep(
  baseUrl: string,
  heartbeatProxy: HeartbeatDelayProxy,
  previousStoppedRunId: string,
): Promise<void> {
  const binId = "binny15-one";
  const service = "runtime-fifteen-one";
  const initialOwner = await readRuntimeExecutionState(baseUrl, binId);
  assert.equal(initialOwner.status, "online");
  assert.ok(initialOwner.runtimeId !== undefined);

  await heartbeatProxy.arm(previousStoppedRunId);
  const registeredOldHeartbeat = await heartbeatProxy.waitUntilHeld();
  assert.equal(registeredOldHeartbeat.runtimeId, initialOwner.runtimeId);
  assert.ok(registeredOldHeartbeat.ownerGeneration !== undefined);
  assert.equal(registeredOldHeartbeat.stoppedRunId, undefined);
  const heldAt = registeredOldHeartbeat.heldAt;
  const clientClosedAt = await heartbeatProxy.waitUntilTimedOut();
  assert.ok(clientClosedAt - heldAt >= 2_500);
  await compose(["kill", "--signal", "SIGKILL", service]);
  await compose(["up", "--detach", "--no-build", "--force-recreate", service]);
  const registeredReplacementId = await waitForReplacementRuntime(
    baseUrl,
    binId,
    initialOwner.runtimeId,
  );
  const registeredReplacementGeneration =
    await heartbeatProxy.waitUntilForwarded(registeredReplacementId);
  assert.ok(registeredReplacementGeneration !== undefined);
  assert.ok(
    BigInt(registeredReplacementGeneration) >
      BigInt(registeredOldHeartbeat.ownerGeneration),
    "通过同卷 owner lock 的合法替换必须持久推进所有权代际。",
  );
  await verifyDelayedOldOwnerCannotDisturbRun(
    baseUrl,
    heartbeatProxy,
    "registered-owner",
    registeredReplacementId,
  );

  await compose(["stop", service]);
  const stoppedOwner = await waitFor(
    () => readRuntimeExecutionState(baseUrl, binId),
    (current) =>
      current.status === "offline" &&
      current.runtimeId === registeredReplacementId,
    "当前运行器正常断开",
  );
  assert.equal(stoppedOwner.reason, "runtime_not_connected");

  await heartbeatProxy.arm(previousStoppedRunId);
  await compose(["up", "--detach", "--no-build", "--force-recreate", service]);
  const unseenOldHeartbeat = await heartbeatProxy.waitUntilHeld();
  assert.notEqual(unseenOldHeartbeat.runtimeId, registeredReplacementId);
  assert.ok(unseenOldHeartbeat.ownerGeneration !== undefined);
  assert.equal(unseenOldHeartbeat.stoppedRunId, undefined);
  assert.ok(
    BigInt(unseenOldHeartbeat.ownerGeneration) >
      BigInt(registeredReplacementGeneration),
  );
  const stillStopped = await readRuntimeExecutionState(baseUrl, binId);
  assert.equal(stillStopped.status, "offline");
  assert.equal(
    stillStopped.runtimeId,
    registeredReplacementId,
    "core 尚未见到新 controller 的首个 idle 心跳。",
  );
  const unseenClientClosedAt = await heartbeatProxy.waitUntilTimedOut();
  assert.ok(unseenClientClosedAt - unseenOldHeartbeat.heldAt >= 2_500);
  await compose(["kill", "--signal", "SIGKILL", service]);
  await compose(["up", "--detach", "--no-build", "--force-recreate", service]);
  const unseenReplacementId = await waitForReplacementRuntime(
    baseUrl,
    binId,
    registeredReplacementId,
  );
  assert.notEqual(unseenReplacementId, unseenOldHeartbeat.runtimeId);
  const unseenReplacementGeneration =
    await heartbeatProxy.waitUntilForwarded(unseenReplacementId);
  assert.ok(unseenReplacementGeneration !== undefined);
  assert.ok(
    BigInt(unseenReplacementGeneration) >
      BigInt(unseenOldHeartbeat.ownerGeneration),
    "核心未见旧首包时，新 controller 仍须携带更高的持久代际。",
  );
  await verifyDelayedOldOwnerCannotDisturbRun(
    baseUrl,
    heartbeatProxy,
    "unseen-first-heartbeat",
    unseenReplacementId,
  );
}

async function replacementPreservesAcceptedCancellationStep(
  baseUrl: string,
): Promise<void> {
  const binId = "binny15-one";
  const service = "runtime-fifteen-one";
  const sourceControlUrl = manualRunSourceControlUrl();
  const initialOwner = await readRuntimeExecutionState(baseUrl, binId);
  assert.equal(initialOwner.status, "online");
  assert.ok(initialOwner.runtimeId !== undefined);

  const gateKey = `18-replacement-cancel-race-${randomUUID()}`;
  const run = cliData<{ readonly runId: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey,
        sourceKey: gateKey,
        waitAfterCommitMs: 60_000,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(sourceControlUrl, gateKey, run.runId, binId);
  await releaseSource(sourceControlUrl, gateKey, "slow");
  await waitForSourceMarker(sourceControlUrl, run.runId, gateKey, "committed");

  const rowLock = await holdManualRunRowLock(run.runId);
  let cancellationRequest:
    | Promise<
        | { readonly status: number; readonly body: unknown }
        | { readonly error: unknown }
      >
    | undefined;
  try {
    cancellationRequest = fetch(
      `${baseUrl}/bins/${encodeURIComponent(binId)}/runs/${encodeURIComponent(run.runId)}/cancel`,
      {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      },
    )
      .then(async (response) => ({
        status: response.status,
        body: (await response.json()) as unknown,
      }))
      .catch((error: unknown) => ({ error }));
    const cancellationWaiterPid = await waitForManualRunLockWaiterBlockedBy(
      rowLock.backendPid,
      [rowLock.backendPid],
    );

    await compose(["kill", "--signal", "SIGKILL", service]);
    await compose([
      "up",
      "--detach",
      "--no-build",
      "--force-recreate",
      service,
    ]);
    await waitForManualRunLockWaiterBlockedBy(cancellationWaiterPid, [
      rowLock.backendPid,
      cancellationWaiterPid,
    ]);
  } finally {
    await rowLock.release();
  }

  assert.ok(cancellationRequest !== undefined);
  const acceptedResponse = await cancellationRequest;
  if ("error" in acceptedResponse)
    assert.fail(`取消请求失败：${String(acceptedResponse.error)}`);
  assert.equal(acceptedResponse.status, 200);
  const acceptedCancellation = acceptedResponse.body as ManualRunCliState;
  assert.equal(acceptedCancellation.status, "cancelling");
  assert.ok(acceptedCancellation.cancellationRequestedAt);

  const replacementRuntimeId = await waitForReplacementRuntime(
    baseUrl,
    binId,
    initialOwner.runtimeId,
  );
  const cancelled = await waitForCliManualRunState(baseUrl, binId, run.runId, [
    "cancelled",
  ]);
  assert.ok(cancelled.stopConfirmedAt);
  assert.equal(cancelled.result?.stopReason.code, "cancelled");
  assert.equal(
    (await readRuntimeExecutionState(baseUrl, binId)).runtimeId,
    replacementRuntimeId,
  );
}

async function manualRunsCliStep(
  baseUrl: string,
  manifest: unknown,
  heartbeatProxy: HeartbeatDelayProxy,
): Promise<void> {
  const manifestJson = JSON.stringify(manifest);
  assert.ok(manifestJson !== undefined);
  for (const binId of ["binny15-one", "binny15-two"]) {
    const created = cliData<{
      readonly id: string;
      readonly execution: unknown;
    }>(
      await cli(baseUrl, [
        "bin",
        "create",
        binId,
        "--collector",
        manifestJson,
        "--identity",
        binId + "-identity",
        "--config",
        JSON.stringify({ section: "initial" }),
        "--targets",
        "[]",
      ]),
      "created",
    );
    assert.equal(created.id, binId);
  }

  await Promise.all([
    waitForRuntime(baseUrl, "binny15-one"),
    waitForRuntime(baseUrl, "binny15-two"),
  ]);

  await waitForManualRunSource();
  const sourceRuntimeUrl = manualRunSourceRuntimeUrl();
  const sourceControlUrl = manualRunSourceControlUrl();
  const gateKey = "15-cli-manual-run";
  const parameters = {
    sourceUrl: sourceRuntimeUrl,
    gateKey,
    sourceKey: "cli-created-item",
  };
  const triggered = cliData<{
    readonly runId: string;
    readonly status: string;
    readonly binId: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
      "collect",
      "--params",
      JSON.stringify(parameters),
    ]),
    "triggered",
  );
  assert.equal(triggered.status, "queued");
  assert.equal(triggered.binId, "binny15-one");
  await waitForSourceArrival(
    sourceControlUrl,
    gateKey,
    triggered.runId,
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, gateKey);

  const deadline = Date.now() + 30_000;
  let completed: ManualRunCliState | undefined;
  while (Date.now() < deadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", "binny15-one", triggered.runId]),
      "found",
    );
    if (current.status === "completed" || current.status === "failed") {
      completed = current;
      break;
    }
    await wait(100);
  }
  assert.ok(completed !== undefined, "CLI 没有读取到终结运行结果。");
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.stopReason.code, "completed");
  assert.deepEqual(completed.result?.completedScopes, [
    "source/cli-created-item",
  ]);
  const savedCommit = completed.result?.commits[0];
  assert.ok(savedCommit !== undefined);
  const savedItem = savedCommit.items[0];
  assert.ok(savedItem !== undefined);

  const commit = cliData<{
    readonly binId: string;
    readonly runId?: string;
    readonly collectorVersion?: string;
  }>(await cli(baseUrl, ["archive", "commit", savedCommit.commitId]), "found");
  assert.equal(commit.binId, "binny15-one");
  assert.equal(commit.runId, triggered.runId);
  assert.equal(commit.collectorVersion, "1.0.0");

  const item = cliData<{
    readonly views: readonly {
      readonly state: {
        readonly metadata?: { readonly section?: unknown };
        readonly body?: { readonly text?: string };
      };
    }[];
  }>(await cli(baseUrl, ["archive", "item", savedItem.itemId]), "found");
  assert.equal(item.views[0]?.state.metadata?.section, "initial");
  assert.equal(item.views[0]?.state.body?.text, "受控正文 " + gateKey);

  const checkGateKey = "16-cli-check-unknown";
  const checkTriggered = cliData<{
    readonly runId: string;
    readonly status: string;
    readonly binId: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
      "check",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: checkGateKey,
        sourceKey: "cli-check-scope",
      }),
    ]),
    "triggered",
  );
  assert.equal(checkTriggered.status, "queued");
  await waitForSourceArrival(
    sourceControlUrl,
    checkGateKey,
    checkTriggered.runId,
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, checkGateKey, "unknown");

  const checkDeadline = Date.now() + 30_000;
  let checkedRun: ManualRunCliState | undefined;
  while (Date.now() < checkDeadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", "binny15-one", checkTriggered.runId]),
      "found",
    );
    if (current.status === "completed" || current.status === "failed") {
      checkedRun = current;
      break;
    }
    await wait(100);
  }
  assert.ok(checkedRun !== undefined, "CLI 没有读取到 check 终结结果。");
  assert.equal(checkedRun.status, "completed");
  assert.equal(checkedRun.result?.check?.availability, "unknown");
  assert.deepEqual(checkedRun.result?.commits, []);
  assert.ok(
    (checkedRun.result?.check?.problems[0]?.suggestion.length ?? 0) > 0,
  );
  assert.equal(checkedRun.result?.stopReason.code, "completed");

  const followUpGateKey = "16-cli-collect-after-check";
  const followUp = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: followUpGateKey,
        sourceKey: "cli-after-check",
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(
    sourceControlUrl,
    followUpGateKey,
    followUp.runId,
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, followUpGateKey);
  const followUpDeadline = Date.now() + 30_000;
  let collectedAfterCheck: ManualRunCliState | undefined;
  while (Date.now() < followUpDeadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", "binny15-one", followUp.runId]),
      "found",
    );
    if (current.status === "completed" || current.status === "failed") {
      collectedAfterCheck = current;
      break;
    }
    await wait(100);
  }
  assert.ok(
    collectedAfterCheck !== undefined,
    "最近 check 结果之后没有产生新的 collect 运行结果。",
  );
  assert.equal(collectedAfterCheck.status, "completed");
  assert.deepEqual(collectedAfterCheck.result?.completedScopes, [
    "source/cli-after-check",
  ]);

  await ownerGenerationOverlapStep(baseUrl, heartbeatProxy, followUp.runId);
  await replacementPreservesAcceptedCancellationStep(baseUrl);

  const slowGateKey = "18-cli-slow-stop";
  const slowRun = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: slowGateKey,
        sourceKey: "partial-before-cancel",
        waitAfterCommitMs: 10_000,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(
    sourceControlUrl,
    slowGateKey,
    slowRun.runId,
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, slowGateKey, "slow");
  await waitForSourceMarker(
    sourceControlUrl,
    slowRun.runId,
    slowGateKey,
    "committed",
  );
  const originalWorker = (
    await runtimeProcessSnapshot("runtime-fifteen-one")
  ).find((process) => process.command.includes("worker.js"));
  assert.ok(originalWorker, "慢动作应由独立执行进程运行。");

  const nextGateKey = "18-cli-next-after-stop";
  const nextRun = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: nextGateKey,
        sourceKey: "after-cancel",
      }),
    ]),
    "triggered",
  );
  const queuedBehindSlowRun = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", "binny15-one", nextRun.runId]),
    "found",
  );
  assert.equal(queuedBehindSlowRun.status, "queued");
  assert.equal(queuedBehindSlowRun.queueReason, "earlier_run_active");

  const acceptedCancel = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "cancel", "binny15-one", slowRun.runId]),
    "cancellation",
  );
  assert.equal(acceptedCancel.status, "cancelling");
  assert.ok(acceptedCancel.cancellationRequestedAt);
  assert.equal(acceptedCancel.stopConfirmedAt, undefined);
  const stillQueued = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", "binny15-one", nextRun.runId]),
    "found",
  );
  assert.equal(stillQueued.status, "queued");
  assert.equal(stillQueued.queueReason, "earlier_run_active");
  const arrivalsDuringStop = await fetch(
    sourceControlUrl + "/control/arrivals",
  );
  assert.equal(arrivalsDuringStop.status, 200);
  assert.equal(
    sourceArrived(await arrivalsDuringStop.json(), nextGateKey),
    false,
  );

  const cancelled = await waitForCliManualRunState(
    baseUrl,
    "binny15-one",
    slowRun.runId,
    ["cancelled"],
  );
  assert.ok(cancelled.stopConfirmedAt);
  assert.equal(cancelled.result?.stopReason.code, "cancelled");
  assert.equal(cancelled.result?.commits.length, 1);
  const savedPartial = cancelled.result?.commits[0];
  assert.ok(savedPartial);
  const retainedCommit = cliData<{ readonly runId?: string }>(
    await cli(baseUrl, ["archive", "commit", savedPartial.commitId]),
    "found",
  );
  assert.equal(retainedCommit.runId, slowRun.runId);
  const stoppedProcesses = await runtimeProcessSnapshot("runtime-fifteen-one");
  assert.equal(
    stoppedProcesses.some((process) => process.pgid === originalWorker.pgid),
    false,
    "取消完成后旧 worker 进程组必须已经退出。",
  );
  const sourceAfterStopResponse = await fetch(
    sourceControlUrl + "/control/arrivals",
  );
  assert.equal(sourceAfterStopResponse.status, 200);
  const sourceAfterStop: unknown = await sourceAfterStopResponse.json();
  if (
    typeof sourceAfterStop === "object" &&
    sourceAfterStop !== null &&
    "markers" in sourceAfterStop &&
    Array.isArray(sourceAfterStop.markers)
  ) {
    assert.equal(
      sourceAfterStop.markers.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "runId" in entry &&
          entry.runId === slowRun.runId &&
          "marker" in entry &&
          entry.marker === "after-stop-delay",
      ),
      false,
    );
  }

  await waitForSourceArrival(
    sourceControlUrl,
    nextGateKey,
    nextRun.runId,
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, nextGateKey);
  const nextCompleted = await waitForCliManualRunState(
    baseUrl,
    "binny15-one",
    nextRun.runId,
    ["completed"],
  );
  assert.equal(nextCompleted.result?.stopReason.code, "completed");

  const ownerBeforeStorageFailure = await readRuntimeExecutionState(
    baseUrl,
    "binny15-one",
  );
  assert.equal(ownerBeforeStorageFailure.status, "online");
  assert.ok(ownerBeforeStorageFailure.runtimeId !== undefined);
  const runningContainer = await compose(["ps", "-q", "runtime-fifteen-one"]);
  const runningContainerId = runningContainer.stdout.trim().split("\n")[0];
  assert.ok(runningContainerId);
  const makeOwnerVolumeReadOnly = await run("docker", [
    "exec",
    "--user",
    "0",
    runningContainerId,
    "chmod",
    "0555",
    "/var/lib/binny/runtime",
  ]);
  assert.equal(makeOwnerVolumeReadOnly.code, 0, makeOwnerVolumeReadOnly.stderr);
  await compose(["stop", "runtime-fifteen-one"]);
  await waitFor(
    () => readRuntimeExecutionState(baseUrl, "binny15-one"),
    (current) =>
      current.status === "offline" &&
      current.runtimeId === ownerBeforeStorageFailure.runtimeId,
    "存储故障前的运行器断开",
  );
  await compose([
    "up",
    "--detach",
    "--no-build",
    "--force-recreate",
    "runtime-fifteen-one",
  ]);
  const failedContainer = await compose([
    "ps",
    "--all",
    "-q",
    "runtime-fifteen-one",
  ]);
  const failedContainerId = failedContainer.stdout.trim().split("\n")[0];
  assert.ok(failedContainerId);
  await waitFor(
    async () =>
      await run("docker", [
        "inspect",
        "--format",
        "{{.State.Status}} {{.RestartCount}}",
        failedContainerId,
      ]),
    (state) =>
      state.code === 0 &&
      /^(?:exited|restarting) [1-9][0-9]*$/u.test(state.stdout.trim()),
    "代际不能持久发布时 controller 启动失败",
  );
  const failedContainerLogs = await run("docker", ["logs", failedContainerId]);
  assert.match(
    failedContainerLogs.stdout + failedContainerLogs.stderr,
    /无法持久发布运行器所有权代际/u,
  );
  const ownerAfterStorageFailure = await readRuntimeExecutionState(
    baseUrl,
    "binny15-one",
  );
  assert.equal(ownerAfterStorageFailure.status, "offline");
  assert.equal(
    ownerAfterStorageFailure.runtimeId,
    ownerBeforeStorageFailure.runtimeId,
    "代际持久发布失败后，controller 不能向 core 自报为新 owner。",
  );
  await compose([
    "run",
    "--rm",
    "--no-deps",
    "--user",
    "0",
    "--entrypoint",
    "chmod",
    "runtime-fifteen-one",
    "0755",
    "/var/lib/binny/runtime",
  ]);
  await compose(["restart", "runtime-fifteen-one"]);
  await waitForRuntimeHealth("runtime-fifteen-one");
  await waitForRuntime(baseUrl, "binny15-one");

  const scheduleParameters = {
    sourceUrl: manualRunSourceRuntimeUrl(),
    gateKey: "17-cli-schedule",
    sourceKey: "17-cli-schedule-item",
  };
  const createdSchedule = cliData<{
    readonly scheduleId: string;
    readonly expression: string;
    readonly action: string;
    readonly params: { readonly gateKey: string };
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      "binny15-one",
      "--expression",
      "0 0 0 1 1 *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify(scheduleParameters),
    ]),
    "created",
  );
  assert.equal(createdSchedule.expression, "0 0 0 1 1 *");
  assert.equal(createdSchedule.action, "collect");
  assert.equal(createdSchedule.params.gateKey, "17-cli-schedule");
  assert.equal(createdSchedule.enabled, true);
  const scheduleList = cliData<{
    readonly schedules: readonly { readonly scheduleId: string }[];
  }>(await cli(baseUrl, ["schedule", "list", "binny15-one"]), "listed");
  assert.ok(
    scheduleList.schedules.some(
      ({ scheduleId }) => scheduleId === createdSchedule.scheduleId,
    ),
  );
  const updatedSchedule = cliData<{
    readonly expression: string;
    readonly timeZone: string;
    readonly action: string;
    readonly params: { readonly gateKey: string };
  }>(
    await cli(baseUrl, [
      "schedule",
      "update",
      "binny15-one",
      createdSchedule.scheduleId,
      "--expression",
      "0 0 0 1 2 *",
      "--time-zone",
      "Europe/London",
      "--action",
      "check",
      "--params",
      JSON.stringify({
        ...scheduleParameters,
        gateKey: "17-cli-schedule-updated",
      }),
    ]),
    "updated",
  );
  assert.equal(updatedSchedule.expression, "0 0 0 1 2 *");
  assert.equal(updatedSchedule.timeZone, "Europe/London");
  assert.equal(updatedSchedule.action, "check");
  assert.equal(updatedSchedule.params.gateKey, "17-cli-schedule-updated");
  const disabledSchedule = cliData<{ readonly enabled: boolean }>(
    await cli(baseUrl, [
      "schedule",
      "disable",
      "binny15-one",
      createdSchedule.scheduleId,
    ]),
    "disabled",
  );
  assert.equal(disabledSchedule.enabled, false);
  const enabledSchedule = cliData<{ readonly enabled: boolean }>(
    await cli(baseUrl, [
      "schedule",
      "enable",
      "binny15-one",
      createdSchedule.scheduleId,
    ]),
    "enabled",
  );
  assert.equal(enabledSchedule.enabled, true);
  const removedSchedule = cliData<{ readonly scheduleId: string }>(
    await cli(baseUrl, [
      "schedule",
      "remove",
      "binny15-one",
      createdSchedule.scheduleId,
    ]),
    "removed",
  );
  assert.equal(removedSchedule.scheduleId, createdSchedule.scheduleId);
  cliFailure<{ readonly code: string }>(
    await cli(baseUrl, [
      "schedule",
      "get",
      "binny15-one",
      createdSchedule.scheduleId,
    ]),
    "schedule_not_found",
  );
}

async function manualRunsHttpStep(
  baseUrl: string,
  manifest: unknown,
): Promise<void> {
  const result = await run(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@binny/api",
      "exec",
      "node",
      "--conditions=source",
      "scripts/manual-runs-http-e2e.ts",
    ],
    {
      env: {
        BINNY_E2E_BASE_URL: baseUrl,
        BINNY15_SOURCE_CONTROL_URL: manualRunSourceControlUrl(),
        BINNY15_COLLECTOR_MANIFEST: JSON.stringify(manifest),
      },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  process.stdout.write(result.stdout);
}

async function scheduledRunsStep(baseUrl: string): Promise<string> {
  const binId = "binny15-one";
  const sourceControlUrl = manualRunSourceControlUrl();
  const sourceUrl = manualRunSourceRuntimeUrl();
  const collectGateKey = "17-scheduled-collect-" + randomUUID();
  const checkGateKey = "17-scheduled-check-" + randomUUID();

  // 两个正式 server 实例共享 PostgreSQL，验证竞争扫描只会排入一次到期运行。
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "120",
    "--scale",
    "server=2",
    "server",
  ]);
  await waitForApiAndDatabase(baseUrl);

  const collectSchedule = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      binId,
      "--expression",
      "*/30 * * * * *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl,
        gateKey: collectGateKey,
        sourceKey: collectGateKey,
      }),
      "--disabled",
    ]),
    "created",
  );
  assert.equal(collectSchedule.enabled, false);
  const firstDueAt = Date.parse(collectSchedule.nextDueAt);
  assert.ok(firstDueAt > Date.now());
  if (firstDueAt - Date.now() < 20_000)
    await wait(firstDueAt - Date.now() + 100);

  const enabledCollectSchedule = cliData<{
    readonly nextDueAt: string;
  }>(
    await cli(baseUrl, [
      "schedule",
      "enable",
      binId,
      collectSchedule.scheduleId,
    ]),
    "enabled",
  );
  const scheduledFor = enabledCollectSchedule.nextDueAt;
  const scheduledTimestamp = Date.parse(scheduledFor);
  assert.ok(scheduledTimestamp - Date.now() > 15_000);

  const dueDate = new Date(scheduledTimestamp);
  const checkExpression = [
    dueDate.getUTCSeconds(),
    dueDate.getUTCMinutes(),
    dueDate.getUTCHours(),
    dueDate.getUTCDate(),
    dueDate.getUTCMonth() + 1,
    "*",
  ].join(" ");
  const checkSchedule = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      binId,
      "--expression",
      checkExpression,
      "--time-zone",
      "UTC",
      "--action",
      "check",
      "--params",
      JSON.stringify({
        sourceUrl,
        gateKey: checkGateKey,
        sourceKey: checkGateKey,
      }),
    ]),
    "created",
  );
  assert.equal(checkSchedule.enabled, true);
  assert.equal(checkSchedule.nextDueAt, scheduledFor);
  const schedules = cliData<{
    readonly schedules: readonly { readonly scheduleId: string }[];
  }>(await cli(baseUrl, ["schedule", "list", binId]), "listed");
  assert.ok(
    schedules.schedules.some(
      ({ scheduleId }) => scheduleId === collectSchedule.scheduleId,
    ),
  );
  assert.ok(
    schedules.schedules.some(
      ({ scheduleId }) => scheduleId === checkSchedule.scheduleId,
    ),
  );

  await wait(Math.max(0, scheduledTimestamp - Date.now() - 5_000));
  assert.ok(scheduledTimestamp - Date.now() >= 4_000);
  await compose(["stop", "server"]);
  await wait(65_000);
  await compose(["start", "server"]);
  await waitForApiAndDatabase(baseUrl);
  await waitForRuntime(baseUrl, binId);

  const controlArrivals = [collectGateKey, checkGateKey] as const;
  const firstArrival = await waitForScheduledArrival(
    sourceControlUrl,
    controlArrivals,
    binId,
  );
  const firstScheduleId =
    firstArrival.gateKey === collectGateKey
      ? collectSchedule.scheduleId
      : checkSchedule.scheduleId;
  const secondGateKey =
    firstArrival.gateKey === collectGateKey ? checkGateKey : collectGateKey;
  const secondScheduleId =
    firstArrival.gateKey === collectGateKey
      ? checkSchedule.scheduleId
      : collectSchedule.scheduleId;
  await waitForSourceArrival(
    sourceControlUrl,
    firstArrival.gateKey,
    firstArrival.runId,
    binId,
  );
  const firstRun = await waitForCliManualRunState(
    baseUrl,
    binId,
    firstArrival.runId,
    ["executing"],
  );
  assert.equal(firstRun.trigger.kind, "schedule");
  assert.equal(
    firstRun.action,
    firstArrival.gateKey === collectGateKey ? "collect" : "check",
  );
  if (firstRun.trigger.kind === "schedule") {
    assert.equal(firstRun.trigger.scheduleId, firstScheduleId);
    assert.equal(firstRun.trigger.scheduledFor, scheduledFor);
  }

  const resumedCollectSchedule = await waitFor(
    async () =>
      cliData<{ readonly nextDueAt: string }>(
        await cli(baseUrl, [
          "schedule",
          "get",
          binId,
          collectSchedule.scheduleId,
        ]),
        "found",
      ),
    (schedule) => Date.parse(schedule.nextDueAt) > Date.now(),
    "重启后推进采集计划的到期时间",
  );
  const resumedCheckSchedule = await waitFor(
    async () =>
      cliData<{ readonly nextDueAt: string }>(
        await cli(baseUrl, [
          "schedule",
          "get",
          binId,
          checkSchedule.scheduleId,
        ]),
        "found",
      ),
    (schedule) => Date.parse(schedule.nextDueAt) > Date.now(),
    "重启后推进检查计划的到期时间",
  );
  assert.ok(Date.parse(resumedCollectSchedule.nextDueAt) > Date.now());
  assert.ok(Date.parse(resumedCheckSchedule.nextDueAt) > Date.now());

  assert.equal(
    await countSourceArrivals(sourceControlUrl, secondGateKey, binId),
    0,
  );
  await wait(300);
  assert.equal(
    await countSourceArrivals(sourceControlUrl, secondGateKey, binId),
    0,
  );

  for (const scheduleId of [
    collectSchedule.scheduleId,
    checkSchedule.scheduleId,
  ]) {
    cliData(
      await cli(baseUrl, ["schedule", "disable", binId, scheduleId]),
      "disabled",
    );
  }

  const firstDisposition =
    firstArrival.gateKey === collectGateKey ? "material" : "available";
  await releaseSource(sourceControlUrl, firstArrival.gateKey, firstDisposition);
  const completedFirst = await waitForCliManualRunState(
    baseUrl,
    binId,
    firstRun.runId,
    ["completed", "failed"],
  );
  assert.equal(completedFirst.status, "completed");
  if (completedFirst.action === "collect")
    assert.equal(completedFirst.result?.commits.length, 1);
  else assert.ok(completedFirst.result?.check !== undefined);

  const secondArrival = await waitForScheduledArrival(
    sourceControlUrl,
    [secondGateKey],
    binId,
  );
  assert.equal(secondArrival.gateKey, secondGateKey);
  assert.notEqual(secondArrival.runId, firstArrival.runId);
  const secondRun = await waitForCliManualRunState(
    baseUrl,
    binId,
    secondArrival.runId,
    ["executing"],
  );
  assert.equal(secondRun.trigger.kind, "schedule");
  assert.equal(
    secondRun.action,
    secondGateKey === collectGateKey ? "collect" : "check",
  );
  if (secondRun.trigger.kind === "schedule") {
    assert.equal(secondRun.trigger.scheduleId, secondScheduleId);
    assert.equal(secondRun.trigger.scheduledFor, scheduledFor);
  }
  const secondDisposition =
    secondGateKey === collectGateKey ? "material" : "available";
  await releaseSource(sourceControlUrl, secondGateKey, secondDisposition);
  const completedSecond = await waitForCliManualRunState(
    baseUrl,
    binId,
    secondRun.runId,
    ["completed", "failed"],
  );
  assert.equal(completedSecond.status, "completed");
  if (completedSecond.action === "collect")
    assert.equal(completedSecond.result?.commits.length, 1);
  else assert.ok(completedSecond.result?.check !== undefined);

  const manualGateKey = "17-scheduled-queue-marker-" + randomUUID();
  const manualRun = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl,
        gateKey: manualGateKey,
        sourceKey: manualGateKey,
      }),
    ]),
    "triggered",
  );
  assert.equal(manualRun.status, "queued");
  await waitForSourceArrival(
    sourceControlUrl,
    manualGateKey,
    manualRun.runId,
    binId,
  );
  const completedManualRun = await waitForCliManualRunState(
    baseUrl,
    binId,
    manualRun.runId,
    ["executing"],
  );
  assert.equal(completedManualRun.trigger.kind, "manual");
  await releaseSource(sourceControlUrl, manualGateKey, "material");
  const finishedManualRun = await waitForCliManualRunState(
    baseUrl,
    binId,
    manualRun.runId,
    ["completed", "failed"],
  );
  assert.equal(finishedManualRun.status, "completed");

  // 队尾人工运行到达前，所有并发扫描已排入的计划运行都应已先行执行。
  assert.equal(
    await countSourceArrivals(sourceControlUrl, collectGateKey, binId),
    1,
  );
  assert.equal(
    await countSourceArrivals(sourceControlUrl, checkGateKey, binId),
    1,
  );
  assert.equal(completedFirst.result?.stopReason.code, "completed");
  assert.equal(completedSecond.result?.stopReason.code, "completed");

  for (const [scheduleId, runId] of [
    [
      collectSchedule.scheduleId,
      firstArrival.gateKey === collectGateKey
        ? firstRun.runId
        : secondRun.runId,
    ],
    [
      checkSchedule.scheduleId,
      firstArrival.gateKey === checkGateKey ? firstRun.runId : secondRun.runId,
    ],
  ] as const) {
    cliData(
      await cli(baseUrl, ["schedule", "remove", binId, scheduleId]),
      "removed",
    );
    const retained = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, runId]),
      "found",
    );
    assert.equal(retained.trigger.kind, "schedule");
    if (retained.trigger.kind === "schedule")
      assert.equal(retained.trigger.scheduleId, scheduleId);
  }
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "120",
    "--scale",
    "server=1",
    "server",
  ]);
  composePort = await publishedPort("server", 3000);
  process.stdout.write(
    "票 17 计划的跨重启合并触发、并发扫描去重、同 bin 串行、来源保留与正式 runner 结果通过。\n",
  );
  return apiBaseUrl();
}

async function manualRunControllerPartitionStep(): Promise<void> {
  const baseUrl = apiBaseUrl();
  const sourceControlUrl = manualRunSourceControlUrl();
  const binId = "binny15-two";
  const interruptedGateKey = "18-controller-link-loss";
  const interrupted = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey: interruptedGateKey,
        sourceKey: "interrupted-before-source",
        waitBeforeSourceMs: 30_000,
      }),
    ]),
    "triggered",
  );
  const active = await waitForCliManualRunState(
    baseUrl,
    binId,
    interrupted.runId,
    ["executing"],
  );
  assert.equal(active.status, "executing");
  const oldWorker = (await runtimeProcessSnapshot("runtime-fifteen-two")).find(
    (process) => process.command.includes("worker.js"),
  );
  assert.ok(oldWorker, "失联验收应观察到真实执行子进程。");
  const bin = cliData<{
    readonly execution: { readonly runtimeId?: string };
  }>(await cli(baseUrl, ["bin", "get", binId]), "found");
  assert.ok(bin.execution.runtimeId);

  const containers = await compose(["ps", "-q", "runtime-fifteen-two"]);
  const containerId = containers.stdout.trim().split("\n")[0];
  assert.ok(containerId);
  const networkName = projectName + "_runtime";
  const detached = await run(
    "docker",
    ["network", "disconnect", networkName, containerId],
    { env: composeEnvironment() },
  );
  assert.equal(detached.code, 0, detached.stderr);
  let reconnected = false;
  try {
    const nextGateKey = "18-after-controller-link-loss";
    const next = cliData<ManualRunCliState>(
      await cli(baseUrl, [
        "run",
        "trigger",
        binId,
        "collect",
        "--params",
        JSON.stringify({
          sourceUrl: manualRunSourceRuntimeUrl(),
          gateKey: nextGateKey,
          sourceKey: "after-interruption",
        }),
      ]),
      "triggered",
    );
    const stale = await waitForCliManualRunState(
      baseUrl,
      binId,
      interrupted.runId,
      ["failed"],
    );
    assert.equal(stale.result?.error?.code, "runtime_interrupted");
    assert.equal(stale.stopConfirmedAt, undefined);
    const stillQueued = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, next.runId]),
      "found",
    );
    assert.equal(stillQueued.status, "queued");
    assert.equal(stillQueued.queueReason, "previous_execution_unconfirmed");

    const claim = await fetch(
      baseUrl + "/bins/" + binId + "/runtime/runs/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtimeId: bin.execution.runtimeId }),
      },
    );
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { run: null });
    const liveProcesses = await runtimeProcessSnapshot("runtime-fifteen-two");
    assert.ok(
      liveProcesses.some((process) => process.pgid === oldWorker.pgid),
      "失联超时不能伪称旧执行进程已经退出。",
    );

    const attached = await run(
      "docker",
      ["network", "connect", networkName, containerId],
      { env: composeEnvironment() },
    );
    assert.equal(attached.code, 0, attached.stderr);
    reconnected = true;

    await waitForSourceArrival(
      sourceControlUrl,
      nextGateKey,
      next.runId,
      binId,
    );
    const stopped = await waitForCliManualRunState(
      baseUrl,
      binId,
      interrupted.runId,
      ["failed"],
    );
    assert.ok(stopped.stopConfirmedAt);
    const processesAfterAck = await runtimeProcessSnapshot(
      "runtime-fifteen-two",
    );
    assert.equal(
      processesAfterAck.some((process) => process.pgid === oldWorker.pgid),
      false,
      "恢复控制连接并收到停止确认后旧 worker 进程组应消失。",
    );
    await releaseSource(sourceControlUrl, nextGateKey);
    const completedNext = await waitForCliManualRunState(
      baseUrl,
      binId,
      next.runId,
      ["completed"],
    );
    assert.equal(completedNext.result?.stopReason.code, "completed");
  } finally {
    if (!reconnected) {
      const attached = await run(
        "docker",
        ["network", "connect", networkName, containerId],
        { env: composeEnvironment() },
      );
      if (attached.code !== 0 && !attached.stderr.includes("already exists"))
        process.stderr.write(attached.stderr);
    }
  }
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
  assert.deepEqual(Object.keys(discovered.actions), ["check", "collect"]);
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
  archive: string,
  sdkResource: string,
): Promise<string> {
  const disabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "disable", "rss-main"]),
    "disabled",
  );
  assert.equal(disabled.status, "disabled");
  await compose(["restart", "postgres"]);
  await waitForApiAndDatabase(baseUrl);
  await compose(["restart", "server"]);
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
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
  const archiveState = await archiveHttpStep(
    "after-restart",
    baseUrl,
    archive,
    sdkResource,
  );
  const {
    itemId,
    relationItemId,
    relationCommitId,
    revisionId,
    comparedRevisionId,
    commitId,
    historicalAsOf,
    relationAsOf,
    resourceItemId,
    resourceRevisionId,
    resourcePartialRevisionId,
    resourceRepairedRevisionId,
    resourceMarkerItemId,
    cliCascadeRootItemId,
    cliCascadeTargetItemId,
  } = archiveIds(archive);
  const expectedArchive = archiveResponses(archiveState);
  const cliArchiveItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", itemId]),
    "found",
  );
  assert.deepEqual(cliArchiveItem, expectedArchive.item);
  const cliHistoricalItem = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "item",
      itemId,
      "--bin",
      "rss-main",
      "--as-of",
      historicalAsOf,
    ]),
    "found",
  );
  assert.deepEqual(cliHistoricalItem, expectedArchive.historicalItem);
  const cliArchiveRevision = cliData<unknown>(
    await cli(baseUrl, ["archive", "revision", revisionId]),
    "found",
  );
  assert.deepEqual(cliArchiveRevision, expectedArchive.revision);
  const cliRevisionDiff = cliData<unknown>(
    await cli(baseUrl, ["archive", "diff", revisionId, comparedRevisionId]),
    "found",
  );
  assert.deepEqual(cliRevisionDiff, expectedArchive.revisionDiff);
  const cliResourceDiff = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "diff",
      resourceRevisionId,
      resourceRepairedRevisionId,
    ]),
    "found",
  );
  assert.deepEqual(cliResourceDiff, expectedArchive.resourceDiff);
  const cliResourcePartialDiff = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "diff",
      resourceRevisionId,
      resourcePartialRevisionId,
    ]),
    "found",
  );
  assert.deepEqual(cliResourcePartialDiff, expectedArchive.resourcePartialDiff);

  const cliResourceItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", resourceItemId]),
    "found",
  );
  assert.deepEqual(cliResourceItem, expectedArchive.resourceItem);
  const cliResourceMarkerItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", resourceMarkerItemId]),
    "found",
  );
  assert.deepEqual(cliResourceMarkerItem, expectedArchive.resourceMarkerItem);
  const cliResourceRevision = cliData<unknown>(
    await cli(baseUrl, ["archive", "revision", resourceRevisionId]),
    "found",
  );
  const persistedState: unknown = JSON.parse(archiveState);
  assert.ok(typeof persistedState === "object" && persistedState !== null);
  assert.ok("resourceRevision" in persistedState);
  assert.deepEqual(cliResourceRevision, persistedState.resourceRevision);
  const sdkJourney: unknown = JSON.parse(sdkResource);
  assert.ok(typeof sdkJourney === "object" && sdkJourney !== null);
  assert.ok("itemId" in sdkJourney && typeof sdkJourney.itemId === "string");
  const cliSdkItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", sdkJourney.itemId]),
    "found",
  );
  assert.deepEqual(cliSdkItem, expectedArchive.sdkItem);

  const cliSearch = cliData<{
    readonly unit: string;
    readonly results: readonly {
      readonly itemId: string;
      readonly matches: readonly {
        readonly binId: string;
        readonly revisionId: string;
      }[];
    }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        scope: { kind: "current", binId: "rss-main" },
        text: { kind: "literal", value: "正文 A" },
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.equal(cliSearch.unit, "item");
  const cliSearchResult = cliSearch.results.find(
    (result) => result.itemId === itemId,
  );
  assert.ok(cliSearchResult);
  assert.ok(
    cliSearchResult.matches.some(
      (match) => match.binId === "rss-main" && match.revisionId === revisionId,
    ),
  );

  const cliJsonSearch = cliData<{
    readonly unit: string;
    readonly results: readonly {
      readonly sourceKey?: { readonly key: string };
      readonly matches: readonly {
        readonly json?: readonly {
          readonly field: string;
          readonly path: readonly (string | number)[];
          readonly exists: boolean;
          readonly value?: unknown;
        }[];
      }[];
    }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        scope: { kind: "current", binId: "rss-main" },
        where: {
          type: "and",
          conditions: [
            {
              type: "field",
              field: "sourceKey.key",
              operator: "eq",
              value: "json-number-high",
            },
            {
              type: "json",
              field: "properties",
              path: ["profile", "score"],
              valueType: "number",
              operator: "eq",
              value: 10,
            },
          ],
        },
        select: [
          "sourceKey",
          {
            type: "json",
            field: "properties",
            path: ["profile", "score"],
          },
        ],
        orderBy: [
          {
            field: "properties",
            path: ["profile", "score"],
            valueType: "number",
            direction: "desc",
          },
          { field: "sourceKey.key", direction: "asc" },
        ],
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.equal(cliJsonSearch.unit, "item");
  assert.deepEqual(
    cliJsonSearch.results.map((result) => result.sourceKey?.key),
    ["json-number-high"],
  );
  assert.deepEqual(cliJsonSearch.results[0]?.matches[0]?.json, [
    {
      field: "properties",
      path: ["profile", "score"],
      exists: true,
      value: 10,
    },
  ]);

  const cliRelationSearch = cliData<{
    readonly results: readonly {
      readonly sourceKey?: { readonly key: string };
      readonly matches: readonly {
        readonly binId: string;
        readonly expansions?: readonly {
          readonly key: string;
          readonly hasMore: boolean;
          readonly relations: readonly {
            readonly relationId: string;
            readonly status: string;
          }[];
        }[];
      }[];
    }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        scope: { kind: "current", binId: "rss-main" },
        where: {
          type: "and",
          conditions: [
            {
              type: "field",
              field: "sourceKey.key",
              operator: "eq",
              value: "split-root",
            },
            {
              type: "relation",
              direction: "outgoing",
              name: "cites",
              operator: "exists",
            },
          ],
        },
        expand: [
          {
            key: "mentions",
            direction: "outgoing",
            name: "mentions",
            limit: 1,
          },
        ],
        select: ["sourceKey"],
        orderBy: [{ field: "sourceKey.key", direction: "asc" }],
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.deepEqual(
    cliRelationSearch.results.map((result) => result.sourceKey?.key),
    ["split-root"],
  );
  assert.deepEqual(
    cliRelationSearch.results[0]?.matches[0]?.expansions?.[0]?.relations.map(
      ({ relationId }) => relationId,
    ),
    ["e2e:relation-query:split-text"],
  );

  const cliPathSearch = cliData<{
    readonly results: readonly {
      readonly sourceKey?: { readonly key: string };
      readonly matches: readonly {
        readonly pathExpansions?: readonly {
          readonly key: string;
          readonly hasMore: boolean;
          readonly paths: readonly {
            readonly steps: readonly {
              readonly relationId: string;
              readonly direction: string;
              readonly status: string;
              readonly observation: { readonly archiveSeq: string };
            }[];
          }[];
        }[];
      }[];
    }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        scope: { kind: "current", binId: "rss-main" },
        where: {
          type: "and",
          conditions: [
            {
              type: "field",
              field: "sourceKey.key",
              operator: "eq",
              value: "path-root",
            },
            {
              type: "path",
              steps: [
                { direction: "outgoing", name: "path-first" },
                { direction: "outgoing", name: "path-second" },
              ],
              operator: "count",
              count: { operator: "eq", value: 1 },
            },
          ],
        },
        expandPaths: [
          {
            key: "two-hop",
            steps: [
              { direction: "outgoing", name: "path-first" },
              { direction: "outgoing", name: "path-second" },
            ],
            limit: 10,
          },
        ],
        select: ["sourceKey"],
        orderBy: [{ field: "sourceKey.key", direction: "asc" }],
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.deepEqual(
    cliPathSearch.results.map(({ sourceKey }) => sourceKey?.key),
    ["path-root"],
  );
  const cliPaths = cliPathSearch.results[0]?.matches[0]?.pathExpansions?.[0];
  assert.ok(cliPaths !== undefined);
  assert.equal(cliPaths.paths.length, 2);
  assert.equal(cliPaths.hasMore, false);
  assert.deepEqual(
    cliPaths.paths.map(({ steps }) =>
      steps.map(({ relationId }) => relationId),
    ),
    [
      ["e2e:relation-query:path-first-c", "e2e:relation-query:path-second-c"],
      [
        "e2e:relation-query:path-first-unknown",
        "e2e:relation-query:path-second-unknown",
      ],
    ],
  );
  assert.match(
    cliPaths.paths[0]?.steps[0]?.observation.archiveSeq ?? "",
    /^\d+$/u,
  );

  const cliInvalidPath = cliFailure<{ readonly code: string }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        scope: { kind: "current", binId: "rss-main" },
        where: {
          type: "path",
          steps: [],
          operator: "exists",
        },
        select: ["sourceKey"],
        orderBy: [{ field: "sourceKey.key", direction: "asc" }],
        limit: 10,
      }),
    ]),
    "invalid_input",
  );
  assert.equal(cliInvalidPath.code, "invalid_input");

  const downloadDirectory = await mkdtemp(
    path.join(tmpdir(), "binny10-resource-cli-"),
  );
  const localResourcePath = path.join(downloadDirectory, "resource.bin");
  const containerResourcePath = `/tmp/binny10-resource-${process.pid}.bin`;
  try {
    const downloaded = cliData<{
      readonly resourceId: string;
      readonly mediaType: string;
      readonly size: number;
      readonly sha256: string;
      readonly savedTo: string;
    }>(
      await cli(baseUrl, [
        "archive",
        "resource",
        expectedArchive.sdkResourceMetadata.resourceId,
        "--output",
        containerResourcePath,
      ]),
      "downloaded",
    );
    assert.equal(
      downloaded.resourceId,
      expectedArchive.sdkResourceMetadata.resourceId,
    );
    assert.equal(downloaded.mediaType, "image/svg+xml");
    assert.equal(downloaded.sha256, expectedArchive.sdkResourceMetadata.sha256);
    await compose(["cp", `server:${containerResourcePath}`, localResourcePath]);
    assert.deepEqual(
      await readFile(localResourcePath),
      Buffer.from("collector sdk image v1"),
    );
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }
  await compose([
    "exec",
    "--no-TTY",
    "server",
    "rm",
    "-f",
    containerResourcePath,
  ]);

  const cliFirstTimelinePage = cliData<{ readonly nextCursor?: string }>(
    await cli(baseUrl, [
      "archive",
      "timeline",
      itemId,
      "--bin",
      "rss-main",
      "--limit",
      "1",
    ]),
    "found",
  );
  assert.deepEqual(cliFirstTimelinePage, expectedArchive.firstTimelinePage);
  assert.ok(cliFirstTimelinePage.nextCursor);
  const cliSecondTimelinePage = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "timeline",
      itemId,
      "--limit",
      "1",
      "--cursor",
      cliFirstTimelinePage.nextCursor,
    ]),
    "found",
  );
  assert.deepEqual(cliSecondTimelinePage, expectedArchive.secondTimelinePage);
  const cliRelationPage = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "relations",
      relationItemId,
      "--bin",
      "rss-main",
      "--direction",
      "outgoing",
      "--as-of",
      relationAsOf,
      "--limit",
      "10",
    ]),
    "found",
  );
  assert.deepEqual(cliRelationPage, expectedArchive.relationPage);
  const cliRelationTimelinePage = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "timeline",
      relationItemId,
      "--bin",
      "rss-main",
      "--as-of",
      relationAsOf,
      "--limit",
      "100",
    ]),
    "found",
  );
  assert.deepEqual(
    cliRelationTimelinePage,
    expectedArchive.relationTimelinePage,
  );
  const cliRelationCommit = cliData<unknown>(
    await cli(baseUrl, ["archive", "commit", relationCommitId]),
    "found",
  );
  assert.deepEqual(cliRelationCommit, expectedArchive.relationCommit);
  const cliArchiveCommit = cliData<unknown>(
    await cli(baseUrl, ["archive", "commit", commitId]),
    "found",
  );
  assert.deepEqual(cliArchiveCommit, expectedArchive.commit);
  await validateApiInput();

  const cliCascadeDeletion = cliData<{
    readonly itemId: string;
    readonly deletedItemIds: readonly string[];
    readonly deletionSeq: string;
    readonly deleted: true;
  }>(
    await cli(baseUrl, ["archive", "delete", cliCascadeRootItemId]),
    "deleted",
  );
  assert.equal(cliCascadeDeletion.itemId, cliCascadeRootItemId);
  assert.deepEqual(
    cliCascadeDeletion.deletedItemIds.toSorted(),
    [cliCascadeRootItemId, cliCascadeTargetItemId].toSorted(),
  );
  assert.equal(cliCascadeDeletion.deleted, true);
  cliFailure(
    await cli(baseUrl, ["archive", "item", cliCascadeTargetItemId]),
    "item_deleted",
  );
  return baseUrl;
}

async function runRssAcceptance(
  baseUrl: string,
  source: RssControlSource,
): Promise<void> {
  const sourceMediaBytes = await source.mediaBytes();
  const manifest = await createRssManifest();
  const config = {
    feeds: [
      { id: "rss-main", url: source.baseUrl + "/rss" },
      { id: "atom-main", url: source.baseUrl + "/atom" },
      { id: "temporary", url: source.baseUrl + "/temporary" },
      { id: "bad-identity", url: source.baseUrl + "/bad-identity" },
      {
        id: "real-feed-parser",
        url: "https://github.com/rowanmanning/feed-parser/releases.atom",
      },
      { id: "static-main", url: source.baseUrl + "/static-rss" },
      { id: "real-bbc", url: source.baseUrl + "/real-static-rss" },
    ],
  };
  await Promise.all([
    createRssBin(baseUrl, "binny22-one", manifest, config),
    createRssBin(baseUrl, "binny22-two", manifest, config),
  ]);
  await Promise.all([
    waitForRuntimeHealth("runtime-rss"),
    waitForRuntimeHealth("runtime-rss-two"),
    waitForRuntime(baseUrl, "binny22-one"),
    waitForRuntime(baseUrl, "binny22-two"),
  ]);

  const initialRun = await triggerRssAction(baseUrl, "binny22-one", "collect", {
    feedIds: ["rss-main", "atom-main", "temporary", "static-main"],
  });
  const initialRequests = await source.requests();
  const initialAtomRequest = initialRequests.find(
    ({ path }) => path === "/atom",
  );
  assert.ok(initialAtomRequest !== undefined);
  assert.equal(initialAtomRequest.ifModifiedSince, undefined);
  process.stdout.write(
    "票 22 受控信源首批运行结果：" +
      JSON.stringify({ run: initialRun, requests: initialRequests }) +
      "\n",
  );
  assert.equal(initialRun.status, "failed");
  assert.equal(initialRun.result?.error?.code, "rss_collection_incomplete");

  const rssItemV1 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 1",
  );
  assert.equal(rssItemV1.sourceKey.namespace, "rss:rss-main");
  assert.equal(rssItemV1.sourceKey.key, "id:urn:binny:22:rss-item");
  const rssV1 = rssArchiveView(rssItemV1, "binny22-one");
  assert.equal(rssV1.capture.completeness, "complete");
  assert.match(rssV1.body?.html ?? "", /RSS 正文版本 1/u);
  assert.doesNotMatch(rssV1.body?.html ?? "", /RSS 摘要版本 1/u);
  assert.match(rssV1.body?.html ?? "", /binny:\/\/resource\//u);
  assert.equal(rssV1.resources?.length, 2);
  const rssResources = rssV1.resources ?? [];
  const rssResourceBytes = await Promise.all(
    rssResources.map(({ resourceId }) => readRssResource(baseUrl, resourceId)),
  );
  assert.ok(
    rssResourceBytes.some((bytes) => bytes.equals(sourceMediaBytes.photoBytes)),
    "RSS 图片资源应能通过公开 HTTP 归档端点读取为信源原始字节。",
  );
  assert.ok(
    rssResourceBytes.some((bytes) => bytes.equals(sourceMediaBytes.audioBytes)),
    "RSS enclosure 应能通过公开 HTTP 归档端点读取为信源原始字节。",
  );

  const rssSummary = await readRssArchive(
    baseUrl,
    "binny22-one",
    "只有摘要版本 1",
  );
  const summaryState = rssArchiveView(rssSummary, "binny22-one");
  assert.equal(summaryState.capture.completeness, "partial");
  assert.ok(
    summaryState.capture.missing.some(({ reason }) =>
      reason.includes("不能声称已取得全文"),
    ),
  );

  const staticArticleV1 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "公开静态正文版本 1",
  );
  assert.equal(staticArticleV1.sourceKey.namespace, "rss:static-main");
  assert.equal(staticArticleV1.sourceKey.key, "id:urn:binny:23:static-article");
  const staticArticleStateV1 = rssArchiveView(staticArticleV1, "binny22-one");
  assert.equal(staticArticleStateV1.capture.completeness, "complete");
  assert.equal(staticArticleStateV1.capture.scope.bodySource, "static-html");
  assert.equal(
    staticArticleStateV1.capture.scope.bodyUrl,
    source.baseUrl + "/story/static",
  );
  assert.equal(
    staticArticleStateV1.capture.scope.bodyFinalUrl,
    source.baseUrl + "/pages/2026/article.html",
  );
  assert.equal(staticArticleStateV1.metadata?.item?.bodySource, "static-html");
  assert.equal(
    staticArticleStateV1.metadata?.item?.bodyFinalUrl,
    source.baseUrl + "/pages/2026/article.html",
  );
  assert.match(staticArticleStateV1.body?.html ?? "", /公开静态正文版本 1/u);
  assert.doesNotMatch(staticArticleStateV1.body?.html ?? "", /导航文字/u);
  assert.doesNotMatch(staticArticleStateV1.body?.html ?? "", /侧栏广告/u);
  assert.match(staticArticleStateV1.body?.html ?? "", /binny:\/\/resource\//u);
  assert.match(
    staticArticleStateV1.body?.markdown ?? "",
    /binny:\/\/resource\//u,
  );
  assert.equal(staticArticleStateV1.resources?.length, 1);
  assert.deepEqual(
    await readRssResource(
      baseUrl,
      staticArticleStateV1.resources?.[0]?.resourceId ?? "",
    ),
    sourceMediaBytes.photoBytes,
  );

  const realBbcUrl =
    "https://www.bbc.co.uk/news/articles/cwj342k62exyo?at_medium=RSS&at_campaign=rss";
  const realBbcRun = await triggerRssAction(baseUrl, "binny22-one", "collect", {
    feedIds: ["real-bbc"],
  });
  assert.equal(realBbcRun.status, "completed", JSON.stringify(realBbcRun));
  const realBbcArticle = await readRssArchive(
    baseUrl,
    "binny22-one",
    "650 passengers",
  );
  assert.equal(realBbcArticle.sourceKey.namespace, "rss:real-bbc");
  assert.equal(realBbcArticle.sourceKey.key, "id:urn:binny:23:real-static-bbc");
  const realBbcState = rssArchiveView(realBbcArticle, "binny22-one");
  assert.equal(realBbcState.capture.completeness, "complete");
  assert.equal(realBbcState.capture.scope.bodySource, "static-html");
  assert.equal(realBbcState.capture.scope.bodyUrl, realBbcUrl);
  assert.match(realBbcState.body?.text ?? "", /650 passengers/u);
  process.stdout.write(
    "票 23 真实静态站点兼容性结果：" +
      JSON.stringify({
        url: realBbcUrl,
        environment:
          "Compose runtime-rss 正式轻量镜像、真实 PostgreSQL 与资源目录、正式 CLI",
        action: "collect",
        scope: ["real-bbc"],
        runStatus: realBbcRun.status,
        completeness: realBbcState.capture.completeness,
        bodySource: realBbcState.capture.scope.bodySource,
        finalUrl: realBbcState.capture.scope.bodyFinalUrl,
        checkedAt: realBbcRun.finishedAt ?? new Date().toISOString(),
      }) +
      "\n",
  );

  const staticSecondBinRun = await triggerRssAction(
    baseUrl,
    "binny22-two",
    "collect",
    { feedIds: ["static-main"] },
  );
  assert.equal(staticSecondBinRun.status, "failed");
  const staticArticleSecondBin = await readRssArchive(
    baseUrl,
    "binny22-two",
    "公开静态正文版本 1",
  );
  assert.equal(staticArticleSecondBin.itemId, staticArticleV1.itemId);
  assert.deepEqual(staticArticleSecondBin.sourceKey, staticArticleV1.sourceKey);

  const staticArchiveBeforeCheck = await readRssArchive(
    baseUrl,
    "binny22-one",
    "公开静态正文版本 1",
  );
  const staticPageRequestsBeforeCheck = (await source.requests()).filter(
    ({ path }) => path.startsWith("/story/") || path.startsWith("/pages/"),
  ).length;
  const staticMediaRequestsBeforeCheck = (await source.requests()).filter(
    ({ path }) => path.startsWith("/media/"),
  ).length;
  const staticCheck = await triggerRssAction(baseUrl, "binny22-one", "check", {
    feedIds: ["static-main"],
  });
  assert.equal(staticCheck.status, "completed");
  assert.equal(staticCheck.result?.check?.availability, "unavailable");
  assert.deepEqual(staticCheck.result?.check?.scope, ["static-main"]);
  assert.ok(
    staticCheck.result?.check?.problems.some(
      ({ code, suggestion }) =>
        code === "rss_static_article_unavailable" &&
        suggestion.includes("可公开访问的静态正文来源"),
    ),
  );
  const staticPageRequestsAfterCheck = (await source.requests()).filter(
    ({ path }) => path.startsWith("/story/") || path.startsWith("/pages/"),
  ).length;
  const staticMediaRequestsAfterCheck = (await source.requests()).filter(
    ({ path }) => path.startsWith("/media/"),
  ).length;
  assert.equal(staticPageRequestsAfterCheck, staticPageRequestsBeforeCheck + 5);
  assert.equal(staticMediaRequestsAfterCheck, staticMediaRequestsBeforeCheck);
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny22-one", "公开静态正文版本 1"),
    staticArchiveBeforeCheck,
  );

  const staticRequests = await source.requests();
  const staticArticleRequest = [...staticRequests]
    .reverse()
    .find(({ path }) => path === "/pages/2026/article.html");
  assert.ok(staticArticleRequest !== undefined);
  assert.equal(staticArticleRequest.ifNoneMatch, undefined);
  assert.equal(staticArticleRequest.ifModifiedSince, undefined);

  const javascriptSummary = await readRssArchive(
    baseUrl,
    "binny22-one",
    "JavaScript 页面摘要",
  );
  const javascriptState = rssArchiveView(javascriptSummary, "binny22-one");
  assert.equal(javascriptState.capture.completeness, "partial");
  assert.ok(
    javascriptState.capture.missing.some(
      ({ path, reason }) =>
        path === "body.fullText" && reason.includes("脚本渲染"),
    ),
  );

  const loginSummary = await readRssArchive(
    baseUrl,
    "binny22-one",
    "登录页面摘要",
  );
  const loginState = rssArchiveView(loginSummary, "binny22-one");
  assert.equal(loginState.capture.completeness, "partial");
  assert.ok(
    loginState.capture.missing.some(({ path }) => path === "body.fullText"),
  );
  assert.ok(
    loginState.capture.missing.some(({ reason }) =>
      reason.includes("需要登录"),
    ),
  );

  const recoverySummary = await readRssArchive(
    baseUrl,
    "binny22-one",
    "恢复页面摘要",
  );
  const recoveryState = rssArchiveView(recoverySummary, "binny22-one");
  assert.equal(recoveryState.capture.completeness, "partial");
  assert.ok(
    recoveryState.capture.missing.some(({ path }) => path === "body.fullText"),
  );
  const recoveryPartialRevision = recoverySummary.revisions[0];
  assert.ok(recoveryPartialRevision !== undefined);
  const archivedRecoveryPartialRevision = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "revision",
      recoveryPartialRevision.revisionId,
    ]),
    "found",
  );

  const recoveryRequestsBeforeRetry = (await source.requests()).filter(
    ({ path }) => path === "/story/recovery",
  ).length;
  await source.setRecoveryPageAvailable(true);
  const recoveredPageRun = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["static-main"] },
  );
  assert.equal(recoveredPageRun.status, "failed");
  assert.ok(
    recoveredPageRun.result?.error?.suggestion?.includes(
      "可公开访问的静态正文来源",
    ),
  );
  assert.equal(
    (await source.requests()).filter(({ path }) => path === "/story/recovery")
      .length,
    recoveryRequestsBeforeRetry + 1,
  );
  const recoveredArticle = await readRssArchive(
    baseUrl,
    "binny22-one",
    "恢复后静态正文",
  );
  assert.equal(recoveredArticle.itemId, recoverySummary.itemId);
  assert.equal(recoveredArticle.revisions.length, 2);
  assert.equal(
    rssArchiveView(recoveredArticle, "binny22-one").capture.completeness,
    "complete",
  );
  assert.equal(
    rssArchiveView(recoveredArticle, "binny22-one").metadata?.item?.bodySource,
    "static-html",
  );
  assert.match(
    rssArchiveView(recoveredArticle, "binny22-one").body?.text ?? "",
    /恢复后静态正文/u,
  );
  assert.doesNotMatch(
    rssArchiveView(recoveredArticle, "binny22-one").body?.text ?? "",
    /恢复页面摘要/u,
  );
  assert.deepEqual(
    cliData<unknown>(
      await cli(baseUrl, [
        "archive",
        "revision",
        recoveryPartialRevision.revisionId,
      ]),
      "found",
    ),
    archivedRecoveryPartialRevision,
  );

  const staticArticleV2ExpectedRequests = (await source.requests()).filter(
    ({ path }) => path === "/pages/2026/article.html",
  ).length;
  await source.setStaticArticleVersion(2);
  const staticArticleV2Run = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["static-main"] },
  );
  assert.equal(staticArticleV2Run.status, "failed");
  const staticArticleV2Requests = (await source.requests()).filter(
    ({ path }) => path === "/pages/2026/article.html",
  );
  assert.equal(
    staticArticleV2Requests.length,
    staticArticleV2ExpectedRequests + 1,
  );
  assert.equal(staticArticleV2Requests.at(-1)?.ifNoneMatch, undefined);
  const staticArticleV2 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "公开静态正文版本 2",
  );
  assert.equal(staticArticleV2.itemId, staticArticleV1.itemId);
  assert.equal(staticArticleV2.revisions.length, 2);
  const stableStaticArticleV2 = staticArticleV2;
  const repeatedStaticRun = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["static-main"] },
  );
  assert.equal(repeatedStaticRun.status, "failed");
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny22-one", "公开静态正文版本 2"),
    stableStaticArticleV2,
  );

  await source.setStaticPhotoAvailable(false);
  await source.setStaticArticleVersion(3);
  const partialStaticMediaRun = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["static-main"] },
  );
  assert.equal(partialStaticMediaRun.status, "failed");
  const staticArticleV3Partial = await readRssArchive(
    baseUrl,
    "binny22-one",
    "公开静态正文版本 3",
  );
  assert.equal(staticArticleV3Partial.itemId, staticArticleV1.itemId);
  const staticArticleV3PartialState = rssArchiveView(
    staticArticleV3Partial,
    "binny22-one",
  );
  assert.equal(staticArticleV3PartialState.capture.completeness, "partial");
  assert.equal(staticArticleV3PartialState.resources?.length ?? 0, 0);
  assert.doesNotMatch(
    staticArticleV3PartialState.body?.html ?? "",
    /binny:\/\/resource\//u,
  );
  assert.ok(
    staticArticleV3PartialState.capture.missing.some(({ path }) =>
      path.startsWith("media."),
    ),
  );
  const staticArticleV3PartialRevision =
    staticArticleV3Partial.revisions.at(-1);
  assert.ok(staticArticleV3PartialRevision !== undefined);
  const archivedStaticArticleV3PartialRevision = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "revision",
      staticArticleV3PartialRevision.revisionId,
    ]),
    "found",
  );

  await source.setStaticPhotoAvailable(true);
  const recoveredStaticMediaRun = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["static-main"] },
  );
  assert.equal(recoveredStaticMediaRun.status, "failed");
  const staticArticleV3 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "公开静态正文版本 3",
  );
  assert.equal(staticArticleV3.itemId, staticArticleV1.itemId);
  assert.equal(staticArticleV3.revisions.length, 4);
  assert.deepEqual(
    cliData<unknown>(
      await cli(baseUrl, [
        "archive",
        "revision",
        staticArticleV3PartialRevision.revisionId,
      ]),
      "found",
    ),
    archivedStaticArticleV3PartialRevision,
  );
  assert.equal(
    rssArchiveView(staticArticleV3, "binny22-one").capture.completeness,
    "complete",
  );
  assert.equal(
    rssArchiveView(staticArticleV3, "binny22-one").resources?.length,
    1,
  );

  const atomItemV1 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "Atom 全文版本 1",
  );
  assert.equal(atomItemV1.sourceKey.namespace, "rss:atom-main");
  assert.equal(
    atomItemV1.sourceKey.key,
    "id:tag:example.test,2026:binny-22-atom",
  );
  const atomV1 = rssArchiveView(atomItemV1, "binny22-one");
  assert.equal(atomV1.capture.completeness, "complete");
  assert.match(atomV1.body?.html ?? "", /Atom 全文版本 1/u);
  assert.equal(atomV1.resources?.length, 1);
  assert.deepEqual(
    await readRssResource(baseUrl, atomV1.resources?.[0]?.resourceId ?? ""),
    sourceMediaBytes.photoBytes,
  );

  const literalWidgetMatches = await searchRssArchive(
    baseUrl,
    "binny22-one",
    "<widget>",
  );
  assert.equal(
    literalWidgetMatches.length,
    6,
    "RSS HTML 与 Atom text、HTML、XHTML 正文中的代码文字应能按字面标签搜索。",
  );
  const literalWidgetItems = await Promise.all(
    literalWidgetMatches.map(async ({ itemId }) =>
      cliData<RssArchiveRead>(
        await cli(baseUrl, ["archive", "item", itemId, "--bin", "binny22-one"]),
        "found",
      ),
    ),
  );
  assert.deepEqual(
    new Set(literalWidgetItems.map(({ sourceKey }) => sourceKey.key)),
    new Set([
      "id:urn:binny:22:rss-item",
      "id:urn:binny:22:rss-item-escaped",
      "id:tag:example.test,2026:binny-22-atom",
      "id:tag:example.test,2026:atom-text-explicit",
      "id:tag:example.test,2026:atom-text-default",
      "id:tag:example.test,2026:atom-html-literal",
    ]),
  );
  const literalWidgetItemsByKey = new Map(
    literalWidgetItems.map((item) => [item.sourceKey.key, item]),
  );
  for (const key of [
    "id:tag:example.test,2026:atom-text-explicit",
    "id:tag:example.test,2026:atom-text-default",
  ]) {
    const atomTextItem = literalWidgetItemsByKey.get(key);
    assert.ok(atomTextItem !== undefined);
    const state = rssArchiveView(atomTextItem, "binny22-one");
    assert.equal(state.capture.completeness, "complete");
    assert.equal(state.body?.text, "代码 <widget> 与 A & B");
    assert.equal(state.body?.searchText, "代码 <widget> 与 A & B");
    assert.equal(state.body?.html, "代码 &lt;widget&gt; 与 A &amp; B");
    assert.equal(state.body?.markdown, "代码 &lt;widget&gt; 与 A &amp; B");
    assert.ok(
      typeof state.metadata?.item === "object" && state.metadata.item !== null,
    );
    assert.equal(state.metadata?.item?.bodyType, "text");
  }
  const rssLiteralItem = literalWidgetItemsByKey.get(
    "id:urn:binny:22:rss-item",
  );
  assert.ok(rssLiteralItem !== undefined);
  const rssLiteralState = rssArchiveView(rssLiteralItem, "binny22-one");
  assert.equal(rssLiteralState.capture.completeness, "complete");
  assert.match(rssLiteralState.body?.text ?? "", /代码 <widget> 与 A & B/u);
  assert.match(
    rssLiteralState.body?.searchText ?? "",
    /代码 <widget> 与 A & B/u,
  );
  assert.match(rssLiteralState.body?.html ?? "", /&lt;widget&gt;/u);
  assert.match(rssLiteralState.body?.markdown ?? "", /&lt;widget&gt;/u);
  assert.equal(rssLiteralState.metadata?.item?.bodyType, "html");
  const rssEscapedLiteralItem = literalWidgetItemsByKey.get(
    "id:urn:binny:22:rss-item-escaped",
  );
  assert.ok(rssEscapedLiteralItem !== undefined);
  const rssEscapedLiteralState = rssArchiveView(
    rssEscapedLiteralItem,
    "binny22-one",
  );
  assert.equal(rssEscapedLiteralState.capture.completeness, "complete");
  assert.equal(rssEscapedLiteralState.body?.text, "代码 <widget> 与 A & B");
  assert.equal(
    rssEscapedLiteralState.body?.searchText,
    "代码 <widget> 与 A & B",
  );
  assert.match(rssEscapedLiteralState.body?.html ?? "", /&lt;widget&gt;/u);
  assert.match(rssEscapedLiteralState.body?.markdown ?? "", /&lt;widget&gt;/u);
  assert.equal(rssEscapedLiteralState.metadata?.item?.bodyType, "html");
  for (const [key, bodyType] of [
    ["id:tag:example.test,2026:binny-22-atom", "xhtml"],
    ["id:tag:example.test,2026:atom-html-literal", "html"],
  ] as const) {
    const atomMarkupItem = literalWidgetItemsByKey.get(key);
    assert.ok(atomMarkupItem !== undefined);
    const state = rssArchiveView(atomMarkupItem, "binny22-one");
    assert.equal(state.capture.completeness, "complete");
    assert.match(state.body?.text ?? "", /代码 <widget> 与 A & B/u);
    assert.match(state.body?.searchText ?? "", /代码 <widget> 与 A & B/u);
    assert.match(state.body?.html ?? "", /&lt;widget&gt;/u);
    assert.match(state.body?.markdown ?? "", /&lt;widget&gt;/u);
    assert.equal(state.metadata?.item?.bodyType, bodyType);
  }
  const atomEntityTextMatches = await searchRssArchive(
    baseUrl,
    "binny22-one",
    "&lt;widget&gt;",
  );
  assert.equal(atomEntityTextMatches.length, 1);
  const atomEntityTextMatch = atomEntityTextMatches[0];
  assert.ok(atomEntityTextMatch !== undefined);
  const atomEntityTextItem = cliData<RssArchiveRead>(
    await cli(baseUrl, [
      "archive",
      "item",
      atomEntityTextMatch.itemId,
      "--bin",
      "binny22-one",
    ]),
    "found",
  );
  const atomEntityTextState = rssArchiveView(atomEntityTextItem, "binny22-one");
  assert.equal(
    atomEntityTextItem.sourceKey.key,
    "id:tag:example.test,2026:atom-text-entities",
  );
  assert.equal(atomEntityTextState.body?.text, "A &lt;widget&gt; &amp; B");
  assert.equal(
    atomEntityTextState.body?.searchText,
    "A &lt;widget&gt; &amp; B",
  );
  assert.equal(
    atomEntityTextState.body?.html,
    "A &amp;lt;widget&amp;gt; &amp;amp; B",
  );
  assert.equal(
    atomEntityTextState.body?.markdown,
    "A &amp;lt;widget&amp;gt; &amp;amp; B",
  );
  const atomModeTextV1 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "语义固定内容",
  );
  assert.equal(atomModeTextV1.revisions.length, 1);
  assert.equal(
    rssArchiveView(atomModeTextV1, "binny22-one").metadata?.item?.bodyType,
    "text",
  );

  await source.setRssVersion(2);
  await source.setAtomVersion(2);
  await source.setAtomTextMode("html");
  await source.setTemporaryAvailable(true);
  await compose([
    "up",
    "--detach",
    "--no-deps",
    "--force-recreate",
    "runtime-rss",
  ]);
  await waitForRuntimeHealth("runtime-rss");
  await waitForRuntime(baseUrl, "binny22-one");
  const afterRestart = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    {
      feedIds: ["rss-main", "atom-main", "temporary"],
    },
  );
  assert.equal(afterRestart.status, "completed");
  const latestRequest = async (
    pathname: string,
  ): Promise<RssRequestRecord | undefined> =>
    [...(await source.requests())]
      .reverse()
      .find((entry) => entry.path === pathname);
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-1"');
  const atomRequestAfterRestart = await latestRequest("/atom");
  assert.equal(atomRequestAfterRestart?.ifNoneMatch, undefined);
  assert.match(atomRequestAfterRestart?.ifModifiedSince ?? "", /GMT$/u);
  assert.equal((await latestRequest("/temporary"))?.ifNoneMatch, undefined);

  const rssItemV2 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 2",
  );
  assert.equal(rssItemV2.itemId, rssItemV1.itemId);
  assert.deepEqual(rssItemV2.sourceKey, rssItemV1.sourceKey);
  assert.equal(rssItemV2.revisions.length, 2);
  const atomModeHtmlV2 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "语义固定内容",
  );
  assert.equal(atomModeHtmlV2.itemId, atomModeTextV1.itemId);
  assert.equal(
    atomModeHtmlV2.revisions.length,
    2,
    "Atom 正文同值从 text 切换到 html 时应形成新的归档状态。",
  );
  assert.equal(
    rssArchiveView(atomModeHtmlV2, "binny22-one").metadata?.item?.bodyType,
    "html",
  );
  const stableItem = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 2",
  );
  const repeatedRun = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    {
      feedIds: ["rss-main"],
    },
  );
  assert.equal(repeatedRun.status, "completed");
  assert.deepEqual(repeatedRun.result?.commits, []);
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-2"');
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny22-one", "RSS 正文版本 2"),
    stableItem,
  );
  const stableAtomItem = await readRssArchive(
    baseUrl,
    "binny22-one",
    "Atom 全文版本 2",
  );
  const repeatedAtomRun = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["atom-main"] },
  );
  assert.equal(repeatedAtomRun.status, "completed");
  assert.deepEqual(repeatedAtomRun.result?.commits, []);
  assert.match((await latestRequest("/atom"))?.ifModifiedSince ?? "", /GMT$/u);
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny22-one", "Atom 全文版本 2"),
    stableAtomItem,
  );

  await source.setRssVersion(3);
  const archiveBeforeCheck = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 2",
  );
  const mediaRequestCount = (await source.requests()).filter(({ path }) =>
    path.startsWith("/media/"),
  ).length;
  const checkRun = await triggerRssAction(baseUrl, "binny22-one", "check", {
    feedIds: ["rss-main"],
  });
  assert.equal(checkRun.status, "completed");
  assert.equal(checkRun.result?.check?.availability, "available");
  assert.deepEqual(checkRun.result?.check?.scope, ["rss-main"]);
  assert.ok((checkRun.result?.check?.checkedAt.length ?? 0) > 0);
  assert.ok(
    checkRun.result?.check?.problems.some(
      ({ code }) => code === "rss_feed_summary_only",
    ),
  );
  assert.deepEqual(checkRun.result?.commits, []);
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, undefined);
  assert.equal(
    (await source.requests()).filter(({ path }) => path.startsWith("/media/"))
      .length,
    mediaRequestCount,
  );
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny22-one", "RSS 正文版本 2"),
    archiveBeforeCheck,
  );

  const afterCheck = await triggerRssAction(baseUrl, "binny22-one", "collect", {
    feedIds: ["rss-main"],
  });
  assert.equal(afterCheck.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-2"');
  const rssItemV3 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 3",
  );
  assert.equal(rssItemV3.itemId, rssItemV1.itemId);

  await source.setRssVersion(4);
  await source.setPhotoAvailable(false);
  const partialMediaRun = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(partialMediaRun.status, "failed");
  assert.equal(
    partialMediaRun.result?.error?.code,
    "rss_collection_incomplete",
  );
  const rssItemPartial = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 4",
  );
  assert.equal(rssItemPartial.itemId, rssItemV1.itemId);
  const partialState = rssArchiveView(rssItemPartial, "binny22-one");
  assert.equal(partialState.capture.completeness, "partial");
  assert.ok(
    partialState.capture.missing.some(
      ({ path, reason }) =>
        path.startsWith("media.") && reason.includes("本次未能取得或归档"),
    ),
  );
  assert.equal(partialState.resources?.length, 1);
  assert.doesNotMatch(partialState.body?.html ?? "", /binny:\/\/resource\//u);
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-3"');

  await source.setPhotoAvailable(true);
  const mediaRecovery = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(mediaRecovery.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, undefined);
  const rssItemV4 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 4",
  );
  assert.equal(rssItemV4.itemId, rssItemV1.itemId);
  const rssV4 = rssArchiveView(rssItemV4, "binny22-one");
  assert.equal(rssV4.capture.completeness, "complete");
  assert.equal(rssV4.resources?.length, 2);
  assert.match(rssV4.body?.html ?? "", /binny:\/\/resource\//u);
  const recoveredResourceBytes = await Promise.all(
    (rssV4.resources ?? []).map(({ resourceId }) =>
      readRssResource(baseUrl, resourceId),
    ),
  );
  assert.ok(
    recoveredResourceBytes.some((bytes) =>
      bytes.equals(sourceMediaBytes.photoBytes),
    ),
  );
  assert.ok(
    recoveredResourceBytes.some((bytes) =>
      bytes.equals(sourceMediaBytes.audioBytes),
    ),
  );

  await source.setRssVersion(5);
  await compose([
    "up",
    "--detach",
    "--no-deps",
    "--force-recreate",
    "runtime-rss",
  ]);
  await waitForRuntimeHealth("runtime-rss");
  await waitForRuntime(baseUrl, "binny22-one");
  const postMediaRestart = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(postMediaRestart.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-4"');
  const rssItemV5 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 5",
  );
  assert.equal(rssItemV5.itemId, rssItemV1.itemId);

  const separateBinRun = await triggerRssAction(
    baseUrl,
    "binny22-two",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(separateBinRun.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, undefined);
  const secondBinItemV5 = await readRssArchive(
    baseUrl,
    "binny22-two",
    "RSS 正文版本 5",
  );
  assert.equal(secondBinItemV5.itemId, rssItemV1.itemId);
  assert.deepEqual(secondBinItemV5.sourceKey, rssItemV1.sourceKey);

  await source.setRssVersion(6);
  await compose([
    "up",
    "--detach",
    "--no-deps",
    "--force-recreate",
    "runtime-rss-two",
  ]);
  await waitForRuntimeHealth("runtime-rss-two");
  await waitForRuntime(baseUrl, "binny22-two");
  const separateBinRestart = await triggerRssAction(
    baseUrl,
    "binny22-two",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(separateBinRestart.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-5"');
  const secondBinItemV6 = await readRssArchive(
    baseUrl,
    "binny22-two",
    "RSS 正文版本 6",
  );
  assert.equal(secondBinItemV6.itemId, rssItemV1.itemId);

  await source.setRssVersion(7);
  const editedConfig = {
    feeds: config.feeds.map((feed) =>
      feed.id === "rss-main"
        ? { ...feed, url: source.baseUrl + "/rss-edited" }
        : feed,
    ),
  };
  const updatedBin = cliData<{ readonly id: string }>(
    await cli(baseUrl, [
      "bin",
      "update",
      "binny22-one",
      "--config",
      JSON.stringify(editedConfig),
    ]),
    "updated",
  );
  assert.equal(updatedBin.id, "binny22-one");
  const afterUrlEdit = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(afterUrlEdit.status, "completed");
  assert.equal((await latestRequest("/rss-edited"))?.ifNoneMatch, undefined);
  const rssItemV7 = await readRssArchive(
    baseUrl,
    "binny22-one",
    "RSS 正文版本 7",
  );
  assert.equal(rssItemV7.itemId, rssItemV1.itemId);
  assert.deepEqual(rssItemV7.sourceKey, rssItemV1.sourceKey);

  const badIdentityCheck = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "check",
    { feedIds: ["bad-identity"] },
  );
  assert.equal(badIdentityCheck.status, "completed");
  assert.equal(badIdentityCheck.result?.check?.availability, "unavailable");
  assert.deepEqual(badIdentityCheck.result?.check?.scope, ["bad-identity"]);
  assert.ok(
    badIdentityCheck.result?.check?.problems.some(
      ({ code, suggestion }) =>
        code === "rss_entry_identity_unavailable" && suggestion.length > 0,
    ),
  );
  const badIdentityRun = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "collect",
    { feedIds: ["bad-identity"] },
  );
  assert.equal(badIdentityRun.status, "failed");
  assert.equal(badIdentityRun.result?.error?.code, "rss_collection_incomplete");
  assert.equal(
    (await searchRssArchive(baseUrl, "binny22-one", "坏身份正文不得进入归档"))
      .length,
    0,
  );

  const realFeedUrl =
    "https://github.com/rowanmanning/feed-parser/releases.atom";
  const realFeedCheck = await triggerRssAction(
    baseUrl,
    "binny22-one",
    "check",
    { feedIds: ["real-feed-parser"] },
  );
  assert.equal(realFeedCheck.status, "completed");
  assert.deepEqual(realFeedCheck.result?.check?.scope, ["real-feed-parser"]);
  process.stdout.write(
    "票 22 真实 feed 兼容性结果：" +
      JSON.stringify({
        url: realFeedUrl,
        environment: "Compose runtime-rss 正式轻量镜像",
        action: "check",
        scope: realFeedCheck.result?.check?.scope,
        availability: realFeedCheck.result?.check?.availability,
        checkedAt: realFeedCheck.result?.check?.checkedAt,
        problems: realFeedCheck.result?.check?.problems,
      }) +
      "\n",
  );

  for (const binId of ["binny22-one", "binny22-two"]) {
    const removed = cliData<{
      readonly removed: boolean;
      readonly id: string;
    }>(await cli(baseUrl, ["bin", "remove", binId]), "removed");
    assert.deepEqual(removed, { removed: true, id: binId });
  }
}

type PostgresPerformanceStats = {
  readonly sequentialScans: number;
  readonly sequentialTuplesRead: number;
  readonly indexScans: number;
  readonly indexTuplesFetched: number;
  readonly temporaryFiles: number;
  readonly temporaryBytes: number;
  readonly databaseBytes: number;
};

type ContainerLimit = {
  readonly service: string;
  readonly nanoCpus: number;
  readonly cpuQuota: number;
  readonly cpuPeriod: number;
  readonly cpuCores: number;
  readonly memoryBytes: number;
};

type ContainerUsage = {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly blockIo: string;
  readonly processes: number;
};

type CapacitySampler = {
  samples: number;
  peakCombinedCpuPercent: number;
  peakCombinedMemoryBytes: number;
  readonly server: {
    peakCpuPercent: number;
    peakMemoryBytes: number;
    blockIo: string;
    processes: number;
  };
  readonly postgres: {
    peakCpuPercent: number;
    peakMemoryBytes: number;
    blockIo: string;
    processes: number;
  };
};

function parseDockerBytes(value: string): number {
  const matched = /^([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB|TB|TiB)$/u.exec(
    value.trim(),
  );
  assert.ok(matched, "无法解析 Docker 内存字节值：" + value);
  const scale: Readonly<Record<string, number>> = {
    B: 1,
    kB: 1_000,
    KiB: 1_024,
    MB: 1_000_000,
    MiB: 1_048_576,
    GB: 1_000_000_000,
    GiB: 1_073_741_824,
    TB: 1_000_000_000_000,
    TiB: 1_099_511_627_776,
  };
  return Number(matched[1]) * scale[matched[2]!]!;
}

async function readPostgresPerformanceStats(): Promise<PostgresPerformanceStats> {
  const query = [
    "WITH table_stats AS (",
    "      SELECT",
    "        COALESCE(sum(seq_scan), 0) AS sequential_scans,",
    "        COALESCE(sum(seq_tup_read), 0) AS sequential_tuples_read,",
    "        COALESCE(sum(idx_scan), 0) AS index_scans,",
    "        COALESCE(sum(idx_tup_fetch), 0) AS index_tuples_fetched",
    "      FROM pg_stat_user_tables",
    "    ), database_stats AS (",
    "      SELECT temp_files AS temporary_files, temp_bytes AS temporary_bytes",
    "      FROM pg_stat_database WHERE datname = current_database()",
    "    )",
    "    SELECT json_build_object(",
    "      'sequentialScans', table_stats.sequential_scans,",
    "      'sequentialTuplesRead', table_stats.sequential_tuples_read,",
    "      'indexScans', table_stats.index_scans,",
    "      'indexTuplesFetched', table_stats.index_tuples_fetched,",
    "      'temporaryFiles', database_stats.temporary_files,",
    "      'temporaryBytes', database_stats.temporary_bytes,",
    "      'databaseBytes', pg_database_size(current_database())",
    "    )::text",
    "    FROM table_stats CROSS JOIN database_stats;",
  ].join("\n");
  const result = await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-A",
    "-t",
    "-q",
    "-U",
    "binny",
    "-d",
    "binny",
    "-c",
    query,
  ]);
  return JSON.parse(result.stdout.trim()) as PostgresPerformanceStats;
}

async function inspectContainerLimit(service: string): Promise<ContainerLimit> {
  const id = (await compose(["ps", "-q", service])).stdout.trim();
  assert.ok(id, "没有找到容量验收服务容器：" + service);
  const result = await run("docker", [
    "inspect",
    "--format",
    "{{.HostConfig.NanoCpus}}|{{.HostConfig.CpuQuota}}|{{.HostConfig.CpuPeriod}}|{{.HostConfig.Memory}}",
    id,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const [nanoText, quotaText, periodText, memoryText] = result.stdout
    .trim()
    .split("|");
  const nanoCpus = Number(nanoText);
  const cpuQuota = Number(quotaText);
  const cpuPeriod = Number(periodText);
  const memoryBytes = Number(memoryText);
  const cpuCores =
    nanoCpus > 0 ? nanoCpus / 1_000_000_000 : cpuQuota / cpuPeriod;
  return { service, nanoCpus, cpuQuota, cpuPeriod, cpuCores, memoryBytes };
}

async function readContainerUsage(
  serverId: string,
  postgresId: string,
): Promise<{
  readonly server: ContainerUsage;
  readonly postgres: ContainerUsage;
}> {
  const result = await run("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.BlockIO}}|{{.PIDs}}",
    serverId,
    postgresId,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const byId = new Map<string, ContainerUsage>();
  for (const line of result.stdout.trim().split("\n")) {
    const [id, cpuText, memoryText, blockIo, processText] = line.split("|");
    assert.ok(id && cpuText && memoryText && blockIo && processText);
    const usedMemory = memoryText.split("/")[0];
    assert.ok(usedMemory);
    byId.set(id, {
      cpuPercent: Number(cpuText.replace("%", "")),
      memoryBytes: parseDockerBytes(usedMemory),
      blockIo,
      processes: Number(processText),
    });
  }
  const findUsage = (containerId: string): ContainerUsage | undefined =>
    [...byId].find(([id]) => containerId.startsWith(id))?.[1];
  const server = findUsage(serverId);
  const postgres = findUsage(postgresId);
  assert.ok(server, "Docker stats 没有返回 core 容器采样。");
  assert.ok(postgres, "Docker stats 没有返回 PostgreSQL 容器采样。");
  return { server, postgres };
}

function updateCapacitySampler(
  sampler: CapacitySampler,
  usage: { readonly server: ContainerUsage; readonly postgres: ContainerUsage },
): void {
  sampler.samples += 1;
  sampler.server.peakCpuPercent = Math.max(
    sampler.server.peakCpuPercent,
    usage.server.cpuPercent,
  );
  sampler.server.peakMemoryBytes = Math.max(
    sampler.server.peakMemoryBytes,
    usage.server.memoryBytes,
  );
  sampler.server.blockIo = usage.server.blockIo;
  sampler.server.processes = usage.server.processes;
  sampler.postgres.peakCpuPercent = Math.max(
    sampler.postgres.peakCpuPercent,
    usage.postgres.cpuPercent,
  );
  sampler.postgres.peakMemoryBytes = Math.max(
    sampler.postgres.peakMemoryBytes,
    usage.postgres.memoryBytes,
  );
  sampler.postgres.blockIo = usage.postgres.blockIo;
  sampler.postgres.processes = usage.postgres.processes;
  sampler.peakCombinedCpuPercent = Math.max(
    sampler.peakCombinedCpuPercent,
    usage.server.cpuPercent + usage.postgres.cpuPercent,
  );
  sampler.peakCombinedMemoryBytes = Math.max(
    sampler.peakCombinedMemoryBytes,
    usage.server.memoryBytes + usage.postgres.memoryBytes,
  );
}

async function readVolumeUsage(
  service: "server" | "postgres",
  directory: string,
): Promise<{
  readonly allocatedBytes: number;
  readonly apparentBytes?: number;
  readonly fileCount?: number;
  readonly availableBytes: number;
}> {
  const allocationArguments =
    service === "server" ? ["-sB1", directory] : ["-sk", directory];
  const allocationScale = service === "server" ? 1 : 1_024;
  const allocated = await compose([
    "exec",
    "--no-TTY",
    service,
    "du",
    ...allocationArguments,
  ]);
  const df = await compose([
    "exec",
    "--no-TTY",
    service,
    "df",
    "-B1",
    "-P",
    directory,
  ]);
  const allocation =
    Number(allocated.stdout.trim().split(/\s+/u)[0]) * allocationScale;
  const dfColumns = df.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/u);
  assert.ok(Number.isSafeInteger(allocation) && allocation >= 0);
  assert.ok(
    dfColumns !== undefined && Number.isSafeInteger(Number(dfColumns[3])),
  );

  let apparentBytes: number | undefined;
  let fileCount: number | undefined;
  if (service === "server") {
    const fileSizes = await compose([
      "exec",
      "--no-TTY",
      "server",
      "find",
      directory,
      "-type",
      "f",
      "-printf",
      "%s\n",
    ]);
    const sizes = fileSizes.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(Number);
    apparentBytes = sizes.reduce((total, size) => total + size, 0);
    fileCount = sizes.length;
  }
  return {
    allocatedBytes: allocation,
    ...(apparentBytes === undefined ? {} : { apparentBytes }),
    ...(fileCount === undefined ? {} : { fileCount }),
    availableBytes: Number(dfColumns[3]),
  };
}

async function runCapacityAcceptance(baseUrl: string): Promise<void> {
  const dockerInfo = await run("docker", [
    "info",
    "--format",
    "{{.NCPU}}|{{.MemTotal}}|{{.DockerRootDir}}",
  ]);
  assert.equal(dockerInfo.code, 0, dockerInfo.stderr);
  const [hostCpuText, hostMemoryText, dockerRoot] = dockerInfo.stdout
    .trim()
    .split("|");
  const host = {
    cpuCount: Number(hostCpuText),
    memoryBytes: Number(hostMemoryText),
    dockerRoot,
  };
  const networkSubnets = {
    api: await networkSubnet(projectName + "_default"),
    runtime: await networkSubnet(projectName + "_runtime"),
  };
  assert.equal(
    networkSubnets.api,
    process.env.BINNY_E2E_SUBNET ?? "10.253.23.0/24",
  );
  assert.equal(
    networkSubnets.runtime,
    process.env.BINNY_E2E_RUNTIME_SUBNET ?? "10.253.150.0/24",
  );
  const serverId = (await compose(["ps", "-q", "server"])).stdout.trim();
  const postgresId = (await compose(["ps", "-q", "postgres"])).stdout.trim();
  assert.ok(serverId && postgresId);
  const limits = await Promise.all([
    inspectContainerLimit("server"),
    inspectContainerLimit("postgres"),
  ]);
  for (const limit of limits) {
    assert.ok(
      Math.abs(limit.cpuCores - 1) < 0.001,
      limit.service + " 应限制为 1 vCPU。",
    );
    assert.equal(limit.memoryBytes, 2 * 1024 * 1024 * 1024);
  }

  const resourceVolumeBefore = await readVolumeUsage(
    "server",
    "/var/lib/binny/resources",
  );
  const postgresVolumeBefore = await readVolumeUsage(
    "postgres",
    "/var/lib/postgresql/data",
  );
  if (preserveCapacityProject) {
    assert.ok(
      resourceVolumeBefore.availableBytes >= 102_000_000_000,
      "百 GB 媒体负载前可用卷空间不足；没有开始上传。",
    );
  }
  const before = await readPostgresPerformanceStats();
  const sampler: CapacitySampler = {
    samples: 0,
    peakCombinedCpuPercent: 0,
    peakCombinedMemoryBytes: 0,
    server: {
      peakCpuPercent: 0,
      peakMemoryBytes: 0,
      blockIo: "",
      processes: 0,
    },
    postgres: {
      peakCpuPercent: 0,
      peakMemoryBytes: 0,
      blockIo: "",
      processes: 0,
    },
  };
  const stageStartedAt = Date.now();
  let sampling = true;
  let samplingError: unknown;
  const sample = async (): Promise<void> => {
    updateCapacitySampler(
      sampler,
      await readContainerUsage(serverId, postgresId),
    );
    if (sampler.samples % 12 === 0) {
      process.stdout.write(
        "容量负载采样：已运行 " +
          String(Math.floor((Date.now() - stageStartedAt) / 1000)) +
          " 秒，core+PostgreSQL 峰值内存 " +
          String(sampler.peakCombinedMemoryBytes) +
          " B。\n",
      );
    }
  };
  const samplerTask = (async (): Promise<void> => {
    while (sampling) {
      await sample();
      if (sampling) await wait(5_000);
    }
  })().catch((error: unknown) => {
    samplingError = error;
  });

  let apiReport = "";
  try {
    apiReport = await capacityHttpStep(baseUrl);
  } finally {
    sampling = false;
    await samplerTask;
  }
  if (samplingError !== undefined) throw samplingError;

  const after = await readPostgresPerformanceStats();
  const resourceVolume = await readVolumeUsage(
    "server",
    "/var/lib/binny/resources",
  );
  const postgresVolume = await readVolumeUsage(
    "postgres",
    "/var/lib/postgresql/data",
  );
  const resourceVolumeDelta = {
    allocatedBytes:
      resourceVolume.allocatedBytes - resourceVolumeBefore.allocatedBytes,
    apparentBytes:
      resourceVolume.apparentBytes! - resourceVolumeBefore.apparentBytes!,
    fileCount: resourceVolume.fileCount! - resourceVolumeBefore.fileCount!,
    availableBytes:
      resourceVolume.availableBytes - resourceVolumeBefore.availableBytes,
  };
  const postgresVolumeDelta = {
    allocatedBytes:
      postgresVolume.allocatedBytes - postgresVolumeBefore.allocatedBytes,
    availableBytes:
      postgresVolume.availableBytes - postgresVolumeBefore.availableBytes,
  };
  const capacityReport = JSON.parse(apiReport) as {
    readonly uniqueReferencedResourceCount: number;
    readonly expectedReferencedUniqueMediaBytes: number;
  };
  if (capacityPhase !== "verify") {
    assert.equal(
      resourceVolumeDelta.fileCount,
      capacityReport.uniqueReferencedResourceCount,
      "磁盘新增资源文件数应与正式上传的唯一资源数相符。",
    );
    assert.equal(
      resourceVolumeDelta.apparentBytes,
      capacityReport.expectedReferencedUniqueMediaBytes,
      "磁盘新增资源正文总字节数应与 HTTP 上传的唯一媒体字节相符。",
    );
  }
  const commit = await run("git", ["rev-parse", "HEAD"]);
  assert.equal(commit.code, 0, commit.stderr);
  const serverImageId = await containerImageId("server");
  const serverBuildImageId = await imageId(activeServerImage);
  const postgresImageId = await containerImageId("postgres");
  const tree = await run("git", ["rev-parse", "HEAD^{tree}"]);
  assert.equal(tree.code, 0, tree.stderr);
  const delta = {
    sequentialScans: after.sequentialScans - before.sequentialScans,
    sequentialTuplesRead:
      after.sequentialTuplesRead - before.sequentialTuplesRead,
    indexScans: after.indexScans - before.indexScans,
    indexTuplesFetched: after.indexTuplesFetched - before.indexTuplesFetched,
    temporaryFiles: after.temporaryFiles - before.temporaryFiles,
    temporaryBytes: after.temporaryBytes - before.temporaryBytes,
  };
  process.stdout.write(
    "归档容量验收实测：" +
      JSON.stringify(
        {
          project: projectName,
          phase: capacityPhase,
          commit: commit.stdout.trim(),
          tree: tree.stdout.trim(),
          serverImageId,
          serverBuildImageId,
          postgresImageId,
          node: process.version,
          host,
          networkSubnets,
          coreAndPostgresLimits: limits,
          resourcesVolumeBefore: resourceVolumeBefore,
          resourcesVolumeDelta: resourceVolumeDelta,
          sampleCount: sampler.samples,
          elapsedMilliseconds: Date.now() - stageStartedAt,
          peakCombinedCpuPercent: sampler.peakCombinedCpuPercent,
          peakCombinedMemoryBytes: sampler.peakCombinedMemoryBytes,
          containerPeaks: {
            server: sampler.server,
            postgres: sampler.postgres,
          },
          resourcesVolume: resourceVolume,
          postgresVolumeBefore,
          postgresVolume,
          postgresVolumeDelta,
          postgresPerformance: { before, after, delta },
          capacity: capacityReport,
          keptForFinalAggregation:
            isFullCapacityRun && capacityPhase === "seed",
        },
        null,
        2,
      ) +
      "\n",
  );
}

async function main(): Promise<void> {
  const overrideDirectory = await mkdtemp(
    path.join(tmpdir(), "binny12-revision-diff-compose-"),
  );
  composeOverrideFile = path.join(overrideDirectory, "compose.yaml");
  const e2eSubnet = process.env.BINNY_E2E_SUBNET ?? "10.253.23.0/24";
  const runtimeSubnet =
    process.env.BINNY_E2E_RUNTIME_SUBNET ?? "10.253.150.0/24";
  await writeFile(
    composeOverrideFile,
    [
      "services:",
      "  postgres:",
      '    cpus: "1.0"',
      '    mem_limit: "2g"',
      "  server:",
      '    cpus: "1.0"',
      '    mem_limit: "2g"',
      "    ports: !override",
      '      - "3000"',
      "  manual-runs-source:",
      "    ports: !override",
      '      - "8081"',
      "    networks:",
      "      - default",
      "      - runtime",
      "  rss-e2e-source:",
      "    ports: !override",
      '      - "8081"',
      "    networks:",
      "      - default",
      "      - runtime",
      "  runtime-fifteen-one:",
      "    environment:",
      "      BINNY_API_URL: http://heartbeat-proxy:8082",
      "    networks: !override",
      "      - runtime",
      "  runtime-fifteen-two:",
      "    environment:",
      "      BINNY_API_URL: http://heartbeat-proxy:8082",
      "    networks: !override",
      "      - runtime",
      "  heartbeat-proxy:",
      `    image: ${imageName}`,
      "    command:",
      "      - node",
      "      - scripts/binny-e2e-heartbeat-proxy.ts",
      "    ports: !override",
      '      - "8082"',
      '      - "8083"',
      "    depends_on:",
      "      server:",
      "        condition: service_started",
      "    networks:",
      "      - default",
      "      - runtime",
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      `        - subnet: ${e2eSubnet}`,
      "  runtime:",
      "    ipam:",
      "      config:",
      `        - subnet: ${runtimeSubnet}`,
      "",
    ].join("\n"),
  );
  let cleanupError: Error | undefined;
  let acceptanceFailed = false;
  let acceptanceError: unknown;
  let heartbeatProxy: HeartbeatDelayProxy | undefined;
  let rssControlSource: RssControlSource | undefined;
  try {
    assert.ok(
      !isFullCapacityRun ||
        process.env.BINNY_E2E_BASELINE_IMAGE === undefined ||
        process.env.BINNY_E2E_BASELINE_IMAGE.length === 0,
      "容量项目不能与会清空其数据库和资源卷的拆包升级路径并行运行。",
    );
    await compose(["build", "server"]);
    await compose(["build", "runtime-fifteen-one"]);
    await compose(["build", "runtime-rss"]);
    if (
      process.env.BINNY_E2E_BASELINE_IMAGE !== undefined &&
      process.env.BINNY_E2E_BASELINE_IMAGE.length > 0
    ) {
      await verifyDatabasePackageUpgrade();
      await compose(["down", "--volumes", "--remove-orphans"]);
      process.stdout.write("票 36 升级专用数据库与资源卷已清理。\n");
    } else {
      process.stdout.write(
        "票 36 本次未执行旧→新升级证明；本次验收不提供跨版本兼容结论。\n",
      );
    }
    await compose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "360",
      "postgres",
      "server",
      "manual-runs-source",
      "rss-e2e-source",
      "runtime-fifteen-one",
      "runtime-fifteen-two",
      "runtime-rss",
      "runtime-rss-two",
      "heartbeat-proxy",
    ]);
    composePort = await publishedPort("server", 3000);
    manualRunSourcePort = await publishedPort("manual-runs-source", 8081);
    const activeHeartbeatProxy = createHeartbeatDelayProxy(
      await publishedPort("heartbeat-proxy", 8083),
    );
    heartbeatProxy = activeHeartbeatProxy;
    rssControlSource = await createRssControlSource(
      await publishedPort("rss-e2e-source", 8081),
    );
    let baseUrl = apiBaseUrl();
    await waitForApiAndDatabase(baseUrl);
    if (!(isFullCapacityRun && capacityPhase === "verify")) {
      const isolatedClient = await verifyIsolatedApiConsumer({
        repositoryRoot,
        projectName,
      });
      assert.deepEqual(isolatedClient, {
        health: "ok",
        binIds: [],
      });
      await verifyConfigurationJourney(baseUrl);
      const manualRunManifest = await createRuntimeFixtureManifest();
      await manualRunsCliStep(baseUrl, manualRunManifest, activeHeartbeatProxy);
      await manualRunControllerPartitionStep();
      await manualRunsHttpStep(baseUrl, manualRunManifest);
      baseUrl = await scheduledRunsStep(baseUrl);
      await runRssAcceptance(baseUrl, rssControlSource);
      for (const binId of ["binny15-one", "binny15-two"]) {
        const removed = cliData<{
          readonly removed: boolean;
          readonly id: string;
        }>(await cli(baseUrl, ["bin", "remove", binId]), "removed");
        assert.deepEqual(removed, { removed: true, id: binId });
      }
      const enabled = cliData<{ readonly status: string }>(
        await cli(baseUrl, ["bin", "enable", "rss-main"]),
        "enabled",
      );
      assert.equal(enabled.status, "active");
      const archive = await archiveHttpStep("submit", baseUrl);
      await archiveAggregationCliStep(baseUrl);
      const sdkResource = await sdkResourceStep(baseUrl);
      baseUrl = await verifyResourceStorageInterruptions(baseUrl, archive);
      baseUrl = await verifyRestartAndRemoval(baseUrl, archive, sdkResource);
      process.stdout.write(
        "隔离客户端、RSS/Atom 全文、媒体状态、Compose、PostgreSQL、HTTP API、归档与构建 CLI 旅程通过。\n",
      );
    }
    await runCapacityAcceptance(baseUrl);
  } catch (error) {
    acceptanceFailed = true;
    acceptanceError = error;
    const logs = await run(
      "docker",
      [...composePrefix(), "logs", "--no-color"],
      { env: composeEnvironment() },
    );
    process.stderr.write(
      "Compose 验收失败日志：\n" + logs.stdout + logs.stderr,
    );
  } finally {
    if (heartbeatProxy !== undefined) {
      try {
        await heartbeatProxy.release();
      } catch (error) {
        cleanupError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    if (isFullCapacityRun && (capacityPhase === "seed" || acceptanceFailed)) {
      process.stdout.write(
        "保留本票 Compose 项目与持久卷供最终聚合验收：" + projectName + "。\n",
      );
    } else {
      const cleanup = await run(
        "docker",
        [
          ...composePrefix(),
          "--profile",
          "binny15",
          "--profile",
          "binny22",
          "down",
          "--volumes",
          "--remove-orphans",
        ],
        { env: composeEnvironment() },
      );
      if (cleanup.code !== 0) {
        cleanupError = new Error(
          "清理 Compose 资源失败：\n" + cleanup.stdout + cleanup.stderr,
        );
      } else {
        const imageCleanup = await run(
          "docker",
          ["image", "rm", imageName, runtimeImageName, rssRuntimeImageName],
          { env: composeEnvironment() },
        );
        if (imageCleanup.code !== 0) {
          cleanupError = new Error(
            "清理本次 Compose 构建镜像失败：\n" +
              imageCleanup.stdout +
              imageCleanup.stderr,
          );
        }
      }
    }
    await rm(overrideDirectory, { recursive: true, force: true });
  }
  if (acceptanceFailed) throw acceptanceError;
  if (cleanupError !== undefined) throw cleanupError;
}

await main();
