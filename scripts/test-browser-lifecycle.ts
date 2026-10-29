import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { Browser as PlaywrightBrowser, Page } from "playwright-core";

import {
  copyImageBuildContext,
  setBuildContextCollectorVersion,
} from "./binny-image-update-context.ts";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type BrowserImageUpdate = {
  readonly baselineManifest: Record<string, unknown>;
  readonly candidateManifest: Record<string, unknown>;
  readonly baselineImageId: string;
  readonly candidateImageId: string;
};

type BrowserRuntimeContainer = {
  readonly id: string;
  readonly imageId: string;
  readonly status: string;
  readonly ownerVolume: string;
};

type CliWire<T> = {
  readonly kind: string;
  readonly variant: string;
  readonly data: T;
};

type HumanSessionStatus = {
  readonly sessionId: string;
  readonly status: string;
  readonly readyAt?: string;
  readonly closedAt?: string;
  readonly failure?: { readonly code: string; readonly message: string };
};

type HumanSessionCreated = HumanSessionStatus & {
  readonly viewerUrl: string;
};

type Run = {
  readonly runId: string;
  readonly action: string;
  readonly status: string;
  readonly trigger:
    | { readonly kind: "manual" }
    | {
        readonly kind: "schedule";
        readonly scheduleId: string;
        readonly scheduledFor: string;
      };
  readonly queueReason?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly stopConfirmedAt?: string;
  readonly result?: {
    readonly commits: readonly unknown[];
    readonly check?: {
      readonly availability: string;
      readonly problems: readonly { readonly requiresHuman: boolean }[];
    };
    readonly error?: {
      readonly code: string;
      readonly requiresHuman: boolean;
    };
  };
};

type BrowserPower = {
  readonly status: string;
  readonly error?: { readonly code: string; readonly message: string };
};

type Bin = {
  readonly browserIdleTimeoutSeconds: number | null;
  readonly execution: {
    readonly status: string;
    readonly environment?: {
      readonly kind?: string;
      readonly browser?: {
        readonly profileReuseAfterRestart?: boolean;
        readonly power?: BrowserPower;
      };
    };
  };
};

type Gate = {
  started: boolean;
  released: boolean;
  touches: number;
  lastTouchAt?: number;
  unloadedAt?: number;
};

type HostProcess = { readonly pid: number; readonly startTime: string };
type SourceGate = Gate;

type SourceMetrics = {
  readonly loginSubmissions: readonly {
    readonly maxAge: number;
    readonly at: number;
  }[];
  readonly loginPageViews: readonly number[];
  readonly authenticatedProtectedVisits: readonly number[];
  readonly gates: Readonly<Record<string, SourceGate>>;
};

type ViewerFrameStats = {
  receivedFrames: number;
  receivedBytes: number;
  receivedSamples: string[];
  sentFrames: number;
  sentBytes: number;
  sentSamples: string[];
  sentKeyEvents: string[];
  errors: string[];
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.yaml");
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const projectName = `binny19-${suffix}`;
const serverImage = `binny19-server-${suffix}:local`;
const browserImage = `binny19-browser-${suffix}:local`;
const browserBaselineImage = `binny19-browser-${suffix}-image-a:local`;
const outerBrowserContainer = `${projectName}-outer-browser`;
const outerBrowserWsPath = `/binny19-${randomUUID()}`;
const processObserver = `${projectName}-process-observer`;
const password = `binny19${randomUUID().replaceAll("-", "")}`;
const publishedHost = process.env.BINNY19_PUBLISHED_HOST ?? "172.17.0.1";
let serverPort: number | undefined;
let sitePort: number | undefined;
let heartbeatProxyControlPort: number | undefined;
let testDirectory: string | undefined;
let overlayFile: string | undefined;
let composeProjectDirectory = "";
let activeBrowserImage = browserImage;
let playwrightBrowser: PlaywrightBrowser | undefined;
let composeStarted = false;
const builtImages = new Set<string>();
let processObserverStarted = false;

function environment(): Readonly<Record<string, string>> {
  return {
    BINNY_IMAGE: serverImage,
    BINNY19_RUNTIME_IMAGE: activeBrowserImage,
    BINNY_POSTGRES_PASSWORD: password,
  };
}

function run(
  command: string,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment(), ...extraEnvironment },
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

function composePrefix(profile = "binny19"): readonly string[] {
  const projectDirectory =
    composeProjectDirectory.length === 0
      ? []
      : ["--project-directory", composeProjectDirectory];
  const prefix = [
    "compose",
    "--project-name",
    projectName,
    ...projectDirectory,
    "--file",
    composeFile,
  ];
  for (const value of profile.split(",")) prefix.push("--profile", value);
  if (overlayFile !== undefined) prefix.push("--file", overlayFile);
  return prefix;
}

async function compose(
  args: readonly string[],
  profile = "binny19",
): Promise<ProcessResult> {
  const result = await run("docker", [...composePrefix(profile), ...args]);
  assert.equal(
    result.code,
    0,
    `Compose ${args.join(" ")} 失败：\n${(result.stdout + result.stderr).slice(-12_000)}`,
  );
  return result;
}

async function rawCompose(
  args: readonly string[],
  profile = "binny19",
): Promise<ProcessResult> {
  return await run("docker", [...composePrefix(profile), ...args]);
}

async function cli(args: readonly string[]): Promise<ProcessResult> {
  return await rawCompose([
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

function cliInputFailure(
  result: ProcessResult,
  path: readonly (string | number)[],
): void {
  assert.equal(result.code, 2, result.stdout);
  const wire = JSON.parse(result.stderr) as {
    readonly kind: string;
    readonly issues: readonly {
      readonly evidence: readonly {
        readonly path: readonly (string | number)[];
      }[];
    }[];
  };
  assert.equal(wire.kind, "usageFailure");
  assert.ok(
    wire.issues.some((issue) =>
      issue.evidence.some(
        (evidence) =>
          evidence.path.length === path.length &&
          evidence.path.every((part, index) => part === path[index]),
      ),
    ),
  );
}

function ipv4Number(value: string): number {
  const octets = value.split(".").map(Number);
  assert.equal(octets.length, 4);
  assert.ok(
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    ),
  );
  return (
    ((octets[0]! << 24) |
      (octets[1]! << 16) |
      (octets[2]! << 8) |
      octets[3]!) >>>
    0
  );
}

function cidrRange(value: string): {
  readonly first: number;
  readonly last: number;
} {
  const [address, prefixText] = value.split("/");
  const prefix = Number(prefixText);
  assert.ok(
    address !== undefined &&
      Number.isInteger(prefix) &&
      prefix >= 0 &&
      prefix <= 32,
  );
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  const first = (ipv4Number(address) & mask) >>> 0;
  return { first, last: (first | (~mask >>> 0)) >>> 0 };
}

function rangesOverlap(left: string, right: string): boolean {
  const a = cidrRange(left);
  const b = cidrRange(right);
  return a.first <= b.last && b.first <= a.last;
}

async function dockerNetworkSubnets(): Promise<string[]> {
  const listed = await run("docker", [
    "network",
    "ls",
    "--quiet",
    "--no-trunc",
  ]);
  assert.equal(listed.code, 0, listed.stderr);
  const ids = listed.stdout.split(/\s+/u).filter(Boolean);
  const inspected = await Promise.all(
    ids.map(async (id) => {
      const result = await run("docker", ["network", "inspect", id]);
      assert.equal(result.code, 0, result.stderr);
      const [network] = JSON.parse(result.stdout) as {
        readonly IPAM?: {
          readonly Config?: readonly { readonly Subnet?: string }[];
        };
      }[];
      return (network?.IPAM?.Config ?? [])
        .map((entry) => entry.Subnet)
        .filter(
          (subnet): subnet is string =>
            subnet !== undefined &&
            /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/u.test(subnet),
        );
    }),
  );
  return inspected.flat();
}

async function freeBrowserSubnet(): Promise<string> {
  const existing = await dockerNetworkSubnets();
  const requested = process.env.BINNY19_SUBNET;
  if (requested !== undefined) {
    assert.ok(
      existing.every((subnet) => !rangesOverlap(requested, subnet)),
      `BINNY19_SUBNET ${requested} 与现有 Docker 网络重叠。`,
    );
    return requested;
  }
  for (let octet = 168; octet < 184; octet += 1) {
    const candidate = `10.253.${String(octet)}.0/24`;
    if (existing.every((subnet) => !rangesOverlap(candidate, subnet)))
      return candidate;
  }
  throw new Error(
    "10.253.168.0/24 到 10.253.183.0/24 均与现有 Docker 网络冲突。",
  );
}

async function createComposeOverlay(): Promise<void> {
  testDirectory = await mkdtemp(path.join(tmpdir(), "binny19-browser-"));
  overlayFile = path.join(testDirectory, "compose.network.yaml");
  const subnet = await freeBrowserSubnet();
  await writeFile(
    overlayFile,
    [
      "services:",
      "  server:",
      "    ports: !override",
      '      - "3000"',
      "  browser-session-source:",
      "    ports: !override",
      '      - "8081"',
      "  browser-one:",
      "    environment:",
      "      BINNY_API_URL: http://browser-idle-heartbeat-proxy:8082",
      "    depends_on:",
      "      browser-idle-heartbeat-proxy:",
      "        condition: service_started",
      "  browser-idle-heartbeat-proxy:",
      `    image: ${serverImage}`,
      "    profiles: [binny19]",
      "    command:",
      "      - node",
      "      - scripts/binny-e2e-heartbeat-proxy.ts",
      "    ports:",
      '      - "8083"',
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      `        - subnet: ${subnet}`,
      "",
    ].join("\n"),
  );
}

async function armIdleHeartbeatGate(binId: string): Promise<void> {
  assert.ok(heartbeatProxyControlPort !== undefined);
  const response = await fetch(
    `http://${publishedHost}:${String(heartbeatProxyControlPort)}/control/arm`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ binId, idleHeartbeat: true }),
      signal: AbortSignal.timeout(3_000),
    },
  );
  assert.equal(response.status, 200, await response.text());
}

async function waitForHeartbeatForwardedAfter(
  after: number,
  browserIdleTimeoutSeconds: number,
): Promise<number> {
  assert.ok(heartbeatProxyControlPort !== undefined);
  const controlUrl = `http://${publishedHost}:${String(heartbeatProxyControlPort)}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${controlUrl}/control/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const state = (await response.json()) as {
      readonly forwardedAt?: number;
      readonly forwardedRuntimeId?: string;
      readonly forwardedBrowserIdleTimeoutSeconds?: number | null;
    };
    if (
      typeof state.forwardedAt === "number" &&
      state.forwardedAt > after &&
      state.forwardedRuntimeId !== undefined &&
      state.forwardedBrowserIdleTimeoutSeconds === browserIdleTimeoutSeconds
    )
      return state.forwardedAt;
    await delay(50);
  }
  throw new Error("更新空闲策略后没有观察到运行器完成的真实心跳。");
}

async function waitForIdleHeartbeatGate(binId: string): Promise<void> {
  assert.ok(heartbeatProxyControlPort !== undefined);
  const controlUrl = `http://${publishedHost}:${String(heartbeatProxyControlPort)}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${controlUrl}/control/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const state = (await response.json()) as {
      readonly held: boolean;
      readonly armedForBinId?: string;
      readonly heldAt?: number;
    };
    if (state.held && typeof state.heldAt === "number") return;
    assert.equal(
      state.armedForBinId,
      binId,
      "代理没有等待指定 bin 的空闲心跳。",
    );
    await delay(100);
  }
  throw new Error(`运行器没有发出 ${binId} 的空闲探测心跳。`);
}

async function holdIdleProbeAtDeadline(
  binId: string,
  timeoutSeconds: number,
): Promise<void> {
  const updateStartedAt = Date.now();
  await updateBin(binId, timeoutSeconds);
  const acceptedAt = await waitForHeartbeatForwardedAfter(
    updateStartedAt,
    timeoutSeconds,
  );
  const remainingMs = timeoutSeconds * 1_000 - (Date.now() - acceptedAt) - 750;
  if (remainingMs > 0) await delay(remainingMs);
  await armIdleHeartbeatGate(binId);
  await waitForIdleHeartbeatGate(binId);
}

async function releaseIdleHeartbeatGate(): Promise<void> {
  assert.ok(heartbeatProxyControlPort !== undefined);
  const response = await fetch(
    `http://${publishedHost}:${String(heartbeatProxyControlPort)}/control/release`,
    { method: "POST", signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(response.status, 200, await response.text());
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError = "服务尚未就绪。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "list"]);
    if (result.code === 0) return;
    lastError = result.stderr;
    await delay(500);
  }
  throw new Error(`等待正式 API、PostgreSQL 和 CLI 就绪超时：\n${lastError}`);
}

async function runtimeManifest(
  service: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  let lastError = "运行器还没有发布清单。";
  while (Date.now() < deadline) {
    const result = await rawCompose([
      "exec",
      "--no-TTY",
      service,
      "node",
      "--input-type=module",
      "-e",
      'const response = await fetch("http://127.0.0.1:8080/manifest"); if (!response.ok) process.exit(2); console.log(JSON.stringify(await response.json()));',
    ]);
    if (result.code === 0) {
      const payload = JSON.parse(result.stdout) as {
        readonly collector?: Record<string, unknown>;
      };
      assert.ok(payload.collector !== undefined);
      return payload.collector;
    }
    lastError = result.stderr;
    await delay(250);
  }
  throw new Error(`正式浏览器运行器没有发布清单：${lastError}`);
}

function collectorVersion(manifest: Record<string, unknown>): string {
  const version = manifest.version;
  assert.ok(typeof version === "string" && version.length > 0);
  return version;
}

function collectorManifestWithVersion(
  manifest: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  return { ...manifest, version };
}

async function imageId(image: string): Promise<string> {
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

async function browserRuntimeContainerInfo(
  service: string,
): Promise<BrowserRuntimeContainer> {
  const containers = await compose(["ps", "--all", "--quiet", service]);
  const id = containers.stdout.trim();
  assert.ok(id.length > 0, `没有找到 ${service} 容器。`);
  const result = await run("docker", ["inspect", id]);
  assert.equal(result.code, 0, result.stderr);
  const [container] = JSON.parse(result.stdout) as {
    readonly Id: string;
    readonly Image: string;
    readonly State?: { readonly Status?: string };
    readonly Mounts?: readonly {
      readonly Type?: string;
      readonly Name?: string;
      readonly Destination?: string;
    }[];
  }[];
  assert.ok(container !== undefined, `${service} 容器没有检查结果。`);
  const ownerVolume = container?.Mounts?.find(
    ({ Destination, Type }) =>
      Destination === "/var/lib/binny/runtime" && Type === "volume",
  )?.Name;
  assert.ok(ownerVolume, `${service} 没有挂载持久运行目录。`);
  return {
    id: container.Id,
    imageId: container.Image,
    status: container.State?.Status ?? "unknown",
    ownerVolume,
  };
}

async function replaceBrowserRuntimeImage(
  image: string,
  expectedImageId: string,
): Promise<{
  readonly previous: BrowserRuntimeContainer;
  readonly stopped: BrowserRuntimeContainer;
  readonly current: BrowserRuntimeContainer;
}> {
  const previous = await browserRuntimeContainerInfo("browser-one");
  assert.equal(previous.status, "running");
  await compose(["stop", "browser-one"]);
  const stopped = await browserRuntimeContainerInfo("browser-one");
  assert.equal(stopped.id, previous.id);
  assert.equal(stopped.status, "exited", "旧浏览器运行器必须先退出。");

  activeBrowserImage = image;
  await compose([
    "up",
    "--detach",
    "--no-deps",
    "--force-recreate",
    "--no-build",
    "browser-one",
  ]);
  const current = await browserRuntimeContainerInfo("browser-one");
  assert.notEqual(current.id, previous.id);
  assert.equal(current.status, "running");
  assert.equal(current.imageId, expectedImageId);
  assert.equal(current.ownerVolume, previous.ownerVolume);
  return { previous, stopped, current };
}

async function buildBrowserImageUpdate(
  candidateManifest: Record<string, unknown>,
  buildContextDirectory: string,
): Promise<BrowserImageUpdate> {
  const candidateVersion = collectorVersion(candidateManifest);
  const baselineVersion = candidateVersion + "-image-a";
  const baselineManifest = collectorManifestWithVersion(
    candidateManifest,
    baselineVersion,
  );
  await copyImageBuildContext(repositoryRoot, buildContextDirectory);
  await setBuildContextCollectorVersion(
    buildContextDirectory,
    "packages/collector-runtime/test/fixtures/browser-session-collector.ts",
    "binny19.browser-session-fixture",
    baselineVersion,
  );

  const candidateImageId = await imageId(browserImage);
  const previousProjectDirectory = composeProjectDirectory;
  const previousBrowserImage = activeBrowserImage;
  let baselineImageId: string;
  try {
    composeProjectDirectory = buildContextDirectory;
    activeBrowserImage = browserBaselineImage;
    await compose(["build", "browser-one"]);
    builtImages.add(browserBaselineImage);
    baselineImageId = await imageId(browserBaselineImage);
  } finally {
    composeProjectDirectory = previousProjectDirectory;
    activeBrowserImage = previousBrowserImage;
  }
  assert.notEqual(
    baselineImageId,
    candidateImageId,
    "浏览器 A/B 应由不同源码构建出不同镜像制品。",
  );
  return {
    baselineManifest,
    candidateManifest,
    baselineImageId,
    candidateImageId,
  };
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

async function startOuterBrowser(): Promise<PlaywrightBrowser> {
  const launch = await run("docker", [
    "run",
    "--detach",
    "--name",
    outerBrowserContainer,
    "--network",
    "bridge",
    "--publish",
    `${publishedHost}::9224`,
    "--workdir",
    "/app/binny-runtime",
    "--entrypoint",
    "node",
    browserImage,
    "--input-type=module",
    "--eval",
    `import { chromium } from "playwright-core"; await chromium.launchServer({ host: "0.0.0.0", port: 9224, wsPath: ${JSON.stringify(outerBrowserWsPath)}, headless: true, channel: "chromium" }); process.stdout.write("BINNY19_OUTER_BROWSER_READY\\n"); setInterval(() => {}, 2147483647);`,
  ]);
  assert.equal(
    launch.code,
    0,
    `启动外层正式镜像浏览器失败：\n${launch.stderr}`,
  );

  const deadline = Date.now() + 30_000;
  let logs = "";
  while (Date.now() < deadline) {
    const result = await run("docker", ["logs", outerBrowserContainer]);
    logs = result.stdout + result.stderr;
    if (logs.includes("BINNY19_OUTER_BROWSER_READY")) break;
    const inspected = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}",
      outerBrowserContainer,
    ]);
    if (inspected.code === 0 && inspected.stdout.trim() !== "running")
      throw new Error(`外层正式镜像浏览器未能启动：\n${logs.slice(-8_000)}`);
    await delay(100);
  }
  assert.ok(
    logs.includes("BINNY19_OUTER_BROWSER_READY"),
    `等待外层正式镜像浏览器超时：\n${logs.slice(-8_000)}`,
  );

  const mapping = (
    await run("docker", ["port", outerBrowserContainer, "9224/tcp"])
  ).stdout.trim();
  const portText = /:(\d+)$/u.exec(mapping)?.[1];
  const port = Number(portText);
  assert.ok(
    portText !== undefined &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535,
    `外层浏览器没有返回有效宿主端口：${mapping}`,
  );

  const endpoint = new URL(`ws://localhost:9224${outerBrowserWsPath}`);
  endpoint.hostname = publishedHost;
  endpoint.port = String(port);
  const { chromium } = await import("playwright-core");
  return await chromium.connect(endpoint.href);
}

function sourceUrl(pathname: string): string {
  assert.ok(sitePort !== undefined, "受控信源端口尚未发布。");
  return `http://${publishedHost}:${String(sitePort)}${pathname}`;
}

async function sourceMetrics(): Promise<SourceMetrics> {
  const response = await fetch(sourceUrl("/__control/metrics"), {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200, "受控信源没有返回运行指标。");
  return (await response.json()) as SourceMetrics;
}

async function browserFixtureRunIds(
  binId: string,
): Promise<ReadonlySet<string>> {
  const query = {
    scope: { kind: "current", binId },
    where: {
      type: "field",
      field: "sourceKey.namespace",
      operator: "eq",
      value: "binny19.browser-session-fixture",
    },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 100,
  };
  const page = cliData<{
    readonly results: readonly {
      readonly sourceKey?: { readonly namespace: string; readonly key: string };
    }[];
  }>(
    await cli(["archive", "search", "--query", JSON.stringify(query)]),
    "found",
  );
  return new Set(
    page.results.flatMap(({ sourceKey }) => {
      const prefix = `${binId}:`;
      return sourceKey?.namespace === "binny19.browser-session-fixture" &&
        sourceKey.key.startsWith(prefix)
        ? [sourceKey.key.slice(prefix.length)]
        : [];
    }),
  );
}

async function sourceControl(pathname: string): Promise<void> {
  const response = await fetch(sourceUrl(pathname), {
    method: "POST",
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 204, `受控信源控制请求失败：${pathname}`);
}

async function waitForSource(): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sourceMetrics();
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`Compose 受控信源宿主入口不可达：${String(lastError)}`);
}

async function createBin(
  binId: string,
  manifest: Record<string, unknown>,
  idleTimeout: number | "disabled" = 300,
): Promise<void> {
  const config = { baseUrl: "http://browser-session-source:8081/" };
  const args = [
    "bin",
    "create",
    binId,
    "--collector",
    JSON.stringify(manifest),
    "--identity",
    `identity-${binId}`,
    "--config",
    JSON.stringify(config),
    "--targets",
    "[]",
    "--browser-idle-timeout-seconds",
    String(idleTimeout),
  ];
  cliData(await cli(args), "created");
}

async function updateBin(
  binId: string,
  idleTimeout: number | "disabled",
): Promise<Bin> {
  return cliData(
    await cli([
      "bin",
      "update",
      binId,
      "--browser-idle-timeout-seconds",
      String(idleTimeout),
    ]),
    "updated",
  );
}

async function updateCollectorManifest(
  binId: string,
  manifest: Record<string, unknown>,
): Promise<{ readonly id: string; readonly version: string }> {
  const updated = cliData<{
    readonly id: string;
    readonly collector: { readonly version: string };
  }>(
    await cli([
      "bin",
      "update",
      binId,
      "--collector",
      JSON.stringify(manifest),
    ]),
    "updated",
  );
  return { id: updated.id, version: updated.collector.version };
}

async function readBin(binId: string): Promise<Bin> {
  return cliData(await cli(["bin", "get", binId]), "found");
}

async function waitForRuntime(binId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;
  let lastState = "尚未查询。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", binId]);
    if (result.code === 0) {
      const bin = cliData<
        Record<string, unknown> & {
          execution: {
            status: string;
            environment?: {
              kind?: string;
              browser?: {
                profileReuseAfterRestart?: boolean;
                power?: BrowserPower;
              };
            };
          };
        }
      >(result, "found");
      if (bin.execution.status === "online") {
        assert.equal(bin.execution.environment?.kind, "browser");
        assert.equal(
          bin.execution.environment?.browser?.profileReuseAfterRestart,
          true,
        );
        return bin;
      }
      lastState = JSON.stringify(bin.execution);
    } else {
      lastState = result.stderr;
    }
    await delay(250);
  }
  throw new Error(`等待 ${binId} 浏览器运行器在线超时：${lastState}`);
}

async function waitForBrowserPower(
  binId: string,
  expected: string,
  timeoutMs = 30_000,
): Promise<Bin> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "尚未查询。";
  while (Date.now() < deadline) {
    const bin = await readBin(binId);
    lastState = JSON.stringify(bin.execution);
    if (
      bin.execution.status === "online" &&
      bin.execution.environment?.browser?.power?.status === expected
    )
      return bin;
    await delay(150);
  }
  throw new Error(`等待 ${binId} 浏览器状态 ${expected} 超时：${lastState}`);
}

function dockerMemoryBytes(value: string): number {
  const match = /^\s*([\d.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*\//u.exec(
    value,
  );
  assert.ok(match !== null, `Docker 没有返回可识别的内存用量：${value}`);
  const scale = match[2]!.startsWith("Ki")
    ? 1024
    : match[2]!.startsWith("Mi")
      ? 1024 ** 2
      : match[2]!.startsWith("Gi")
        ? 1024 ** 3
        : match[2]!.startsWith("Ti")
          ? 1024 ** 4
          : match[2] === "B"
            ? 1
            : 1000 ** (["kB", "MB", "GB", "TB"].indexOf(match[2]!) + 1);
  return Number(match[1]) * scale;
}

async function browserContainerMemoryBytes(service: string): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await compose([
      "stats",
      "--no-stream",
      "--format",
      "{{.MemUsage}}",
      service,
    ]);
    samples.push(dockerMemoryBytes(result.stdout.trim()));
    if (index < 2) await delay(250);
  }
  return samples.toSorted((left, right) => left - right)[1]!;
}

async function waitForBrowserProcessesStopped(service: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastProcesses = "";
  while (Date.now() < deadline) {
    const result = await browserProcesses(service);
    lastProcesses = result.stdout;
    if (
      !result.stdout
        .split("\n")
        .some((line) => /(?:chrom(?:e|ium)|x11vnc|Xvfb)/iu.test(line))
    )
      return;
    await delay(150);
  }
  throw new Error(`${service} 的浏览器与显示进程仍未退出：\n${lastProcesses}`);
}

async function triggerRun(
  binId: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<Run> {
  return cliData(
    await cli([
      "run",
      "trigger",
      binId,
      action,
      "--params",
      JSON.stringify(params),
    ]),
    "triggered",
  );
}

async function readRun(binId: string, runId: string): Promise<Run> {
  return cliData(await cli(["run", "get", binId, runId]), "found");
}

async function waitForRun(
  binId: string,
  runId: string,
  predicate: (run: Run) => boolean,
  timeoutMs = 120_000,
): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  let last: Run | undefined;
  while (Date.now() < deadline) {
    last = await readRun(binId, runId);
    if (predicate(last)) return last;
    await delay(250);
  }
  throw new Error(`运行 ${runId} 等待超时：${JSON.stringify(last)}`);
}

async function waitForHuman(
  binId: string,
  sessionId: string,
  expected: string,
  timeoutMs = 90_000,
): Promise<HumanSessionStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: HumanSessionStatus | undefined;
  while (Date.now() < deadline) {
    const result = await cli(["human", "get", binId, sessionId]);
    if (result.code === 0) {
      last = cliData<HumanSessionStatus>(result, "found");
      if (last.status === expected) return last;
      if (last.status === "failed")
        throw new Error(`浏览器人工会话失败：${JSON.stringify(last)}`);
    }
    await delay(250);
  }
  throw new Error(
    `会话 ${sessionId} 等待 ${expected} 超时：${JSON.stringify(last)}`,
  );
}

async function waitForHumanTerminal(
  binId: string,
  sessionId: string,
  timeoutMs = 90_000,
): Promise<HumanSessionStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: HumanSessionStatus | undefined;
  while (Date.now() < deadline) {
    const result = await cli(["human", "get", binId, sessionId]);
    if (result.code === 0) {
      last = cliData<HumanSessionStatus>(result, "found");
      if (last.status === "closed" || last.status === "failed") return last;
    }
    await delay(250);
  }
  throw new Error(
    `会话 ${sessionId} 没有在服务恢复后终结：${JSON.stringify(last)}`,
  );
}

async function createGate(gateId: string): Promise<Gate> {
  const gate: Gate = {
    started: false,
    released: false,
    touches: 0,
  };
  await sourceControl(`/__control/gates/${gateId}`);
  return gate;
}

async function refreshGate(gateId: string, gate: Gate): Promise<void> {
  const state = (await sourceMetrics()).gates[gateId];
  assert.ok(state !== undefined, `受控信源没有登记运行 ${gateId}。`);
  gate.started = state.started;
  gate.released = state.released;
  gate.touches = state.touches;
  if (state.lastTouchAt === undefined) delete gate.lastTouchAt;
  else gate.lastTouchAt = state.lastTouchAt;
  if (state.unloadedAt === undefined) delete gate.unloadedAt;
  else gate.unloadedAt = state.unloadedAt;
}

async function waitForGateStarted(gateId: string, gate: Gate): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await refreshGate(gateId, gate);
    if (gate.started) return;
    await delay(100);
  }
  throw new Error(`运行 ${gateId} 没有访问受控保护页面。`);
}

async function releaseGate(gateId: string, gate: Gate): Promise<void> {
  await sourceControl(`/__control/gates/${gateId}/release`);
  await refreshGate(gateId, gate);
}

async function waitForLoginSubmission(
  index: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await sourceMetrics()).loginSubmissions.length > index) return;
    await delay(100);
  }
  throw new Error("外层浏览器通过 noVNC 输入后，受控站点没有收到登录表单。");
}

async function waitForLoginPage(
  index: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await sourceMetrics()).loginPageViews.length > index) return;
    await delay(100);
  }
  throw new Error("外层浏览器输入的地址没有打开受控登录页。");
}

async function waitForAuthenticatedVisit(
  index: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await sourceMetrics()).authenticatedProtectedVisits.length > index)
      return;
    await delay(100);
  }
  throw new Error("受控浏览器提交登录表单后没有读取受保护页面。");
}

async function openViewer(
  browser: PlaywrightBrowser,
  viewerUrl: string,
): Promise<{
  readonly page: Page;
  readonly closed: Promise<void>;
  readonly frames: ViewerFrameStats;
}> {
  const page = await browser.newPage();
  const frames: ViewerFrameStats = {
    receivedFrames: 0,
    receivedBytes: 0,
    receivedSamples: [],
    sentFrames: 0,
    sentBytes: 0,
    sentSamples: [],
    sentKeyEvents: [],
    errors: [],
  };
  page.on("pageerror", (error) => {
    if (frames.errors.length < 10)
      frames.errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && frames.errors.length < 10)
      frames.errors.push(`console: ${message.text()}`);
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.endsWith("/ws")) {
      socket.on("close", resolveClosed);
      socket.on("framereceived", ({ payload }) => {
        const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        frames.receivedFrames += 1;
        frames.receivedBytes += bytes.length;
        if (frames.receivedSamples.length < 20)
          frames.receivedSamples.push(bytes.subarray(0, 24).toString("hex"));
      });
      socket.on("framesent", ({ payload }) => {
        const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        frames.sentFrames += 1;
        frames.sentBytes += bytes.length;
        frames.sentSamples.push(bytes.subarray(0, 24).toString("hex"));
        if (frames.sentSamples.length > 32) frames.sentSamples.shift();
        if (bytes[0] === 4 && bytes.length === 8) {
          frames.sentKeyEvents.push(
            `${bytes[1] === 1 ? "down" : "up"}:${bytes.readUInt32BE(4).toString(16)}`,
          );
          if (frames.sentKeyEvents.length > 64) frames.sentKeyEvents.shift();
        }
      });
    }
  });
  await page.goto(viewerUrl);
  await page
    .locator("#screen canvas")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "已连接，可以操作浏览器。",
    undefined,
    { timeout: 30_000 },
  );
  return { page, closed, frames };
}

async function enterLoginThroughCanvas(
  page: Page,
  maxAgeSeconds: number,
  expectedSubmissionIndex: number,
  frames: ViewerFrameStats,
): Promise<void> {
  const initialMetrics = await sourceMetrics();
  const loginPageIndex = initialMetrics.loginPageViews.length;
  const protectedVisitIndex =
    initialMetrics.authenticatedProtectedVisits.length;
  const canvas = page.locator("#screen canvas");
  const readViewerState = async () => ({
    title: await page.title(),
    status: await page.locator("#status").textContent(),
    canvas: await canvas.evaluate((element) => {
      const canvasElement = element as HTMLCanvasElement;
      const context = canvasElement.getContext("2d");
      const bounds = canvasElement.getBoundingClientRect();
      return {
        width: canvasElement.width,
        height: canvasElement.height,
        clientWidth: canvasElement.clientWidth,
        clientHeight: canvasElement.clientHeight,
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        activeElement: document.activeElement?.tagName,
        pixelSamples:
          context === null
            ? []
            : [
                [20, 20],
                [640, 400],
                [640, 790],
                [1270, 790],
              ].map(([x, y]) =>
                Array.from(context.getImageData(x!, y!, 1, 1).data),
              ),
      };
    }),
    frames: {
      receivedFrames: frames.receivedFrames,
      receivedBytes: frames.receivedBytes,
      receivedSamples: [...frames.receivedSamples],
      sentFrames: frames.sentFrames,
      sentBytes: frames.sentBytes,
      sentSamples: [...frames.sentSamples],
      sentKeyEvents: [...frames.sentKeyEvents],
      errors: [...frames.errors],
    },
  });
  let beforeInputState = await readViewerState();
  const frameDeadline = Date.now() + 15_000;
  while (
    beforeInputState.canvas.pixelSamples.every((pixel) => pixel[3] === 0) &&
    Date.now() < frameDeadline
  ) {
    await delay(50);
    beforeInputState = await readViewerState();
  }
  const beforeInputScreenshot = await page.screenshot();
  if (beforeInputState.canvas.pixelSamples.every((pixel) => pixel[3] === 0)) {
    const screenshotPath = path.join(
      tmpdir(),
      `binny19-viewer-${suffix}-no-frame.png`,
    );
    await writeFile(screenshotPath, beforeInputScreenshot);
    throw new Error(
      `noVNC WebSocket 已连接，但 15 秒内没有绘制 RFB 帧：${JSON.stringify(beforeInputState)}；画面截图：${screenshotPath}`,
    );
  }
  const canvasBounds = await canvas.boundingBox();
  assert.ok(canvasBounds !== null);
  // 人工维护实际点击浏览器地址栏，再键入站点地址。
  await canvas.click({
    position: { x: canvasBounds.width / 2, y: canvasBounds.height * 0.09 },
  });
  await page.keyboard.press("Control+a");
  await page.keyboard.type(
    `http://browser-session-source:8081/login?lifetime=${String(maxAgeSeconds)}`,
    { delay: 10 },
  );
  await page.keyboard.press("Enter");
  try {
    await waitForLoginPage(loginPageIndex);
  } catch (error) {
    const afterInputState = await readViewerState();
    const beforeScreenshotPath = path.join(
      tmpdir(),
      `binny19-viewer-${suffix}-before.png`,
    );
    const afterScreenshotPath = path.join(
      tmpdir(),
      `binny19-viewer-${suffix}-after.png`,
    );
    await writeFile(beforeScreenshotPath, beforeInputScreenshot);
    await page.screenshot({ path: afterScreenshotPath });
    throw new Error(
      `外层浏览器输入后没有打开受控登录页：${JSON.stringify({ beforeInputState, afterInputState, loginPageViews: (await sourceMetrics()).loginPageViews.length })}；输入前画面：${beforeScreenshotPath}；输入后画面：${afterScreenshotPath}；${String(error)}`,
    );
  }
  await page.keyboard.type("binny19-user", { delay: 10 });
  await page.keyboard.press("Tab");
  await page.keyboard.type("browser-session", { delay: 10 });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await waitForLoginSubmission(expectedSubmissionIndex);
  await waitForAuthenticatedVisit(protectedVisitIndex);
}

async function startHumanSession(binId: string): Promise<HumanSessionCreated> {
  return cliData(await cli(["human", "open", binId]), "opened");
}

async function closeHumanSession(
  binId: string,
  sessionId: string,
): Promise<HumanSessionStatus> {
  const result = await cli(["human", "close", binId, sessionId.toUpperCase()]);
  cliData<HumanSessionStatus>(result, "closed");
  return await waitForHuman(binId, sessionId, "closed");
}

async function verifyPlaywrightDeploys(service: string): Promise<void> {
  const result = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "-e",
    'const fs = require("node:fs"); const path = require("node:path"); for (const root of ["/app", "/app/binny-runtime"]) console.log(JSON.parse(fs.readFileSync(path.join(root, "node_modules/playwright-core/package.json"), "utf8")).version);',
  ]);
  assert.deepEqual(result.stdout.trim().split(/\s+/u), ["1.64.1", "1.64.1"]);
}

async function browserPortBindings(
  service: string,
): Promise<Record<string, unknown>> {
  const inspected = await compose(["ps", "--all", "--quiet", service]);
  const containerId = inspected.stdout.trim();
  assert.ok(containerId.length > 0, `没有找到 ${service} 容器。`);
  const result = await run("docker", ["inspect", containerId]);
  assert.equal(result.code, 0, result.stderr);
  const [container] = JSON.parse(result.stdout) as {
    readonly HostConfig?: {
      readonly PortBindings?: Record<string, unknown> | null;
    };
  }[];
  return container?.HostConfig?.PortBindings ?? {};
}

async function browserProcesses(service: string): Promise<ProcessResult> {
  const containers = await compose(["ps", "--all", "--quiet", service]);
  const containerId = containers.stdout.trim();
  assert.ok(containerId.length > 0, `没有找到 ${service} 容器。`);
  const result = await run("docker", ["top", containerId, "-eo", "pid,args"]);
  assert.equal(result.code, 0, result.stderr);
  return result;
}

async function ensureProcessObserver(): Promise<void> {
  if (processObserverStarted) return;
  const observer = await run("docker", [
    "run",
    "--detach",
    "--name",
    processObserver,
    "--network",
    "none",
    "--pid=host",
    "--user",
    "0:0",
    "--read-only",
    "--mount",
    "type=bind,source=/proc,target=/host/proc,readonly",
    "--entrypoint",
    "node",
    browserImage,
    "-e",
    "setInterval(() => {}, 2147483647)",
  ]);
  assert.equal(observer.code, 0, observer.stderr);
  processObserverStarted = true;
}

async function browserMainProcess(service: string): Promise<HostProcess> {
  await ensureProcessObserver();
  const result = await browserProcesses(service);
  const lines = result.stdout
    .split("\n")
    .filter(
      (candidate) =>
        /(?:chrom(?:e|ium))/iu.test(candidate) &&
        !candidate.includes("--type=") &&
        !candidate.includes("chrome_crashpad_handler"),
    );
  assert.equal(lines.length, 1, `${service} 应恰有一个 Chromium 主进程。`);
  const line = lines[0]!;
  const pid = Number(/^\s*(\d+)\s/u.exec(line)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, `无效的 Chromium PID：${line}`);
  const startTime = await daemonProcessIdentity(pid);
  assert.ok(
    startTime !== undefined,
    `无法在 Docker daemon 的 PID namespace 读取 Chromium 进程 ${String(pid)} 身份。`,
  );
  return { pid, startTime };
}

async function assertVncLoopbackOnly(): Promise<void> {
  const processes = await browserProcesses("browser-one");
  const vncCommand = processes.stdout
    .split("\n")
    .find((line) => /\bx11vnc\b/u.test(line));
  assert.ok(vncCommand !== undefined && vncCommand.includes("-localhost"));

  const listeners = await compose([
    "exec",
    "--no-TTY",
    "browser-one",
    "node",
    "-e",
    'const fs = require("node:fs"); const rows = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap(file => fs.readFileSync(file, "utf8").trim().split("\\n").slice(1)); const entries = rows.map(line => line.trim().split(/\\s+/u)).filter(fields => fields[3] === "0A" && fields[1]?.endsWith(":170C")).map(fields => fields[1].split(":")[0]); console.log(JSON.stringify(entries)); if (entries.length === 0 || entries.some(address => address !== "0100007F" && address !== "00000000000000000000000001000000")) process.exit(2);',
  ]);
  const addresses = JSON.parse(listeners.stdout.trim()) as readonly string[];
  assert.ok(addresses.length > 0);

  const outsideContainer = await compose([
    "exec",
    "--no-TTY",
    "browser-two",
    "node",
    "-e",
    'const socket = require("node:net").connect({ host: "browser-one", port: 5900 }); const timeout = setTimeout(() => process.exit(2), 3000); socket.once("connect", () => { clearTimeout(timeout); process.exit(1); }); socket.once("error", error => { clearTimeout(timeout); process.exit(error.code === "ECONNREFUSED" ? 0 : 3); });',
  ]);
  assert.equal(outsideContainer.code, 0, outsideContainer.stderr);
}

async function assertVncStopped(service: string): Promise<void> {
  const processes = await browserProcesses(service);
  assert.equal(
    processes.stdout.split("\n").some((line) => /\bx11vnc\b/u.test(line)),
    false,
    `人工会话关闭后 ${service} 仍有 x11vnc 进程。`,
  );
  const listeners = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "-e",
    'const fs = require("node:fs"); const rows = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap(file => fs.readFileSync(file, "utf8").trim().split("\\n").slice(1)); const entries = rows.map(line => line.trim().split(/\\s+/u)).filter(fields => fields[3] === "0A" && fields[1]?.endsWith(":170C")); if (entries.length > 0) process.exit(2);',
  ]);
  assert.equal(listeners.code, 0, listeners.stderr);
}

async function waitForVncStopped(service: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertVncStopped(service);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(
    `${service} 的 VNC 进程未随核心心跳失联退出：${String(lastError)}`,
  );
}

async function browserHostProcesses(service: string): Promise<HostProcess[]> {
  await ensureProcessObserver();
  const result = await browserProcesses(service);
  const processes: HostProcess[] = [];
  for (const line of result.stdout.split("\n").slice(1)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match === null || !/(?:chrom(?:e|ium)|x11vnc|Xvfb)/iu.test(match[2]!))
      continue;
    const pid = Number(match[1]);
    const startTime = await daemonProcessIdentity(pid);
    assert.ok(
      startTime !== undefined,
      `无法在 Docker daemon 的 PID namespace 读取进程 ${String(pid)} 身份。`,
    );
    processes.push({ pid, startTime });
  }
  assert.ok(
    processes.some(({ pid }) => pid > 0),
    `没有枚举到 ${service} 的浏览器进程。`,
  );
  assert.ok(
    result.stdout.includes("x11vnc") &&
      result.stdout.includes("Xvfb") &&
      /chrom(?:e|ium)/iu.test(result.stdout),
    `容器进程列表没有同时包含 Chromium、Xvfb 和 x11vnc：\n${result.stdout}`,
  );
  return processes;
}

async function daemonProcessIdentity(pid: number): Promise<string | undefined> {
  const result = await run("docker", [
    "exec",
    processObserver,
    "node",
    "-e",
    'const fs = require("node:fs"); try { const stat = fs.readFileSync(`/host/proc/${process.argv[1]}/stat`, "utf8"); const close = stat.lastIndexOf(")"); console.log(stat.slice(close + 2).trim().split(/\\s+/u)[19]); } catch (error) { if (error.code !== "ENOENT") { console.error(error); process.exitCode = 2; } }',
    String(pid),
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim() || undefined;
}

async function browserContainerProcessId(
  process: HostProcess,
): Promise<number> {
  await ensureProcessObserver();
  const result = await run("docker", [
    "exec",
    processObserver,
    "node",
    "-e",
    'const fs = require("node:fs"); const status = fs.readFileSync(`/host/proc/${process.argv[1]}/status`, "utf8"); const line = /^NSpid:\\s+(.+)$/mu.exec(status)?.[1]; if (line === undefined) process.exitCode = 1; else console.log(line.trim().split(/\\s+/u).at(-1));',
    String(process.pid),
  ]);
  assert.equal(result.code, 0, result.stderr);
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "无法映射浏览器容器进程 PID。");
  return pid;
}

async function waitForHostProcessesGone(
  processes: readonly HostProcess[],
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const stillAlive = await Promise.all(
      processes.map(
        async ({ pid, startTime }) =>
          (await daemonProcessIdentity(pid)) === startTime,
      ),
    );
    if (stillAlive.every((alive) => !alive)) return;
    await delay(100);
  }
  throw new Error(
    "PID1 被强制终止后，仍发现原 Chromium、Xvfb 或 x11vnc 进程。",
  );
}

async function waitForViewerClosed(
  promise: Promise<void>,
  timeoutMs = 15_000,
): Promise<void> {
  await Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error("浏览器运行器退出后，旧 noVNC WebSocket 没有结束。");
    }),
  ]);
}

async function waitForGateUnload(gateId: string, gate: Gate): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await refreshGate(gateId, gate);
    if (gate.unloadedAt !== undefined) return;
    await delay(50);
  }
  throw new Error("控制器关闭遗留页面后，受控站点没有收到页面卸载确认。");
}

async function waitForGateQuiet(
  gateId: string,
  gate: Gate,
  run: Promise<Run>,
): Promise<Run> {
  let previous = gate.touches;
  let stableSince = Date.now();
  let finalRun: Run | undefined;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await refreshGate(gateId, gate);
    const current = await run;
    if (current.status === "completed" || current.status === "failed")
      finalRun = current;
    if (gate.touches !== previous) {
      previous = gate.touches;
      stableSince = Date.now();
    }
    if (finalRun !== undefined && Date.now() - stableSince >= 500)
      return finalRun;
    await delay(100);
  }
  throw new Error(
    `运行期间遗留浏览器页面没有停止：${JSON.stringify({ run: finalRun, touches: gate.touches })}`,
  );
}

async function diagnostics(): Promise<string> {
  const [services, logs, browserProcesses] = await Promise.all([
    rawCompose(["ps", "--all"]).catch((error: unknown) => ({
      stdout: "",
      stderr: String(error),
    })),
    rawCompose(["logs", "--tail", "160"]).catch((error: unknown) => ({
      stdout: "",
      stderr: String(error),
    })),
    rawCompose([
      "exec",
      "--no-TTY",
      "browser-one",
      "node",
      "--input-type=module",
      "--eval",
      'import fs from "node:fs"; const chrome = []; let chromeRenderers = 0; let xvfb; let vnc; for (const pid of fs.readdirSync("/proc")) { if (!/^\\d+$/u.test(pid) || pid === String(process.pid)) continue; try { const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\\0", " ").trim(); const display = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\\0").find((entry) => entry.startsWith("DISPLAY=")); if (cmdline.includes("Xvfb ")) xvfb = { pid, display, cmdline }; else if (cmdline.includes("x11vnc")) vnc = { pid, display, cmdline }; else if (/(?:chrom(?:e|ium))/iu.test(cmdline) && !cmdline.includes("chrome_crashpad_handler")) { if (cmdline.includes("--type=renderer")) chromeRenderers += 1; else if (!cmdline.includes("--type=")) chrome.push({ pid, display, headless: /--headless(?:=| )/u.test(cmdline), profile: /--user-data-dir=([^ ]+)/u.exec(cmdline)?.[1], blankPage: cmdline.endsWith("about:blank") }); } } catch {} } console.log(JSON.stringify({ display: process.env.DISPLAY, displaySocket: fs.existsSync("/tmp/.X11-unix/X99"), xvfb, vnc, chrome, chromeRenderers }));',
    ]).catch((error: unknown) => ({ stdout: "", stderr: String(error) })),
  ]);
  return `\nCompose 状态：\n${services.stdout}${services.stderr}\n浏览器显示进程：\n${browserProcesses.stdout}${browserProcesses.stderr}\nCompose 日志：\n${(logs.stdout + logs.stderr).slice(-24_000)}`;
}

async function main(): Promise<void> {
  await createComposeOverlay();
  assert.ok(testDirectory !== undefined);
  const browserBuildContextDirectory = path.join(
    testDirectory,
    "browser-image-a",
  );

  const config = await compose(["config", "--quiet"]);
  assert.equal(config.code, 0);
  composeStarted = true;
  builtImages.add(serverImage);
  builtImages.add(browserImage);
  await compose([
    "up",
    "--detach",
    "--build",
    "server",
    "browser-session-source",
    "browser-idle-heartbeat-proxy",
    "browser-one",
    "browser-two",
  ]);
  playwrightBrowser = await startOuterBrowser();
  serverPort = await publishedPort("server", 3000);
  sitePort = await publishedPort("browser-session-source", 8081);
  heartbeatProxyControlPort = await publishedPort(
    "browser-idle-heartbeat-proxy",
    8083,
  );
  await waitForApi();
  await waitForSource();

  const browserImageUpdate = await buildBrowserImageUpdate(
    await runtimeManifest("browser-two"),
    browserBuildContextDirectory,
  );
  const initialBrowserContainer =
    await browserRuntimeContainerInfo("browser-one");
  assert.equal(
    initialBrowserContainer.imageId,
    browserImageUpdate.candidateImageId,
  );
  const browserImageA = await replaceBrowserRuntimeImage(
    browserBaselineImage,
    browserImageUpdate.baselineImageId,
  );
  const manifest = await runtimeManifest("browser-one");
  assert.deepEqual(manifest, browserImageUpdate.baselineManifest);
  const candidateManifest = await runtimeManifest("browser-two");
  assert.deepEqual(candidateManifest, browserImageUpdate.candidateManifest);
  await createBin("binny19-one", manifest, 4);
  await createBin("binny19-two", candidateManifest, "disabled");

  const unsupported = structuredClone(manifest);
  const unsupportedEnvironment = unsupported.environment as {
    browser: Record<string, unknown>;
  };
  unsupportedEnvironment.browser = {
    ...unsupportedEnvironment.browser,
    profileReuseAfterRestart: false,
    profileReuseUnavailableReason: "此采集器依赖无法跨重启保存的会话状态。",
  };
  const createWithoutReason = structuredClone(unsupported);
  delete (
    createWithoutReason.environment as {
      browser: Record<string, unknown>;
    }
  ).browser.profileReuseUnavailableReason;
  cliInputFailure(
    await cli([
      "bin",
      "create",
      "binny20-no-reason",
      "--collector",
      JSON.stringify(createWithoutReason),
      "--identity",
      "identity-binny20-no-reason",
      "--config",
      JSON.stringify({ baseUrl: "http://browser-session-source:8081/" }),
      "--targets",
      "[]",
    ]),
    ["collector", "environment", "browser", "profileReuseUnavailableReason"],
  );
  const incompatiblePolicy = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli([
      "bin",
      "create",
      "binny20-incompatible",
      "--collector",
      JSON.stringify(unsupported),
      "--identity",
      "identity-binny20-incompatible",
      "--config",
      JSON.stringify({ baseUrl: "http://browser-session-source:8081/" }),
      "--targets",
      "[]",
      "--browser-idle-timeout-seconds",
      "4",
    ]),
    "invalid_configuration",
  );
  assert.deepEqual(incompatiblePolicy.path, ["browserIdleTimeoutSeconds"]);

  assert.equal(
    (await updateBin("binny19-one", "disabled")).browserIdleTimeoutSeconds,
    null,
  );
  assert.equal(
    (await updateBin("binny19-one", 0)).browserIdleTimeoutSeconds,
    0,
  );
  assert.equal(
    (await updateBin("binny19-one", 4)).browserIdleTimeoutSeconds,
    4,
  );
  assert.equal(
    (await updateBin("binny19-two", 0)).browserIdleTimeoutSeconds,
    0,
  );
  assert.equal(
    (await updateBin("binny19-two", "disabled")).browserIdleTimeoutSeconds,
    null,
  );
  const incompatibleUpdate = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli([
      "bin",
      "update",
      "binny19-one",
      "--collector",
      JSON.stringify(unsupported),
    ]),
    "invalid_configuration",
  );
  assert.deepEqual(incompatibleUpdate.path, ["browserIdleTimeoutSeconds"]);

  await Promise.all([
    waitForRuntime("binny19-one"),
    waitForRuntime("binny19-two"),
  ]);
  assert.equal((await readBin("binny19-one")).browserIdleTimeoutSeconds, 4);
  assert.equal((await readBin("binny19-two")).browserIdleTimeoutSeconds, null);
  await updateBin("binny19-one", 30);
  await delay(2_500);
  assert.equal(
    (await waitForBrowserPower("binny19-one", "stopped")).execution.status,
    "online",
  );
  await Promise.all([
    verifyPlaywrightDeploys("browser-one"),
    verifyPlaywrightDeploys("browser-two"),
  ]);

  const oneBindings = await browserPortBindings("browser-one");
  assert.equal(oneBindings["5900/tcp"], undefined);
  assert.equal(oneBindings["6000/tcp"], undefined);
  assert.equal(oneBindings["9222/tcp"], undefined);

  const initialCheck = await triggerRun("binny19-one", "check");
  const initialResult = await waitForRun(
    "binny19-one",
    initialCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(initialResult.status, "completed");
  assert.equal(initialResult.result?.check?.availability, "unavailable");
  assert.equal(initialResult.result?.check?.problems[0]?.requiresHuman, true);

  await waitForBrowserPower("binny19-one", "ready");
  const awakeMemory = await browserContainerMemoryBytes("browser-one");
  const initialBrowserProcess = await browserMainProcess("browser-one");
  await holdIdleProbeAtDeadline("binny19-one", 4);
  await updateBin("binny19-one", "disabled");
  await releaseIdleHeartbeatGate();
  await delay(4_500);
  assert.equal(
    (await readBin("binny19-one")).execution.environment?.browser?.power
      ?.status,
    "ready",
    "关闭尚未开始时禁用空闲关闭，探测完成后仍关闭了浏览器。",
  );
  await updateBin("binny19-one", 4);
  const stoppedBin = await waitForBrowserPower("binny19-one", "stopped");
  assert.equal(stoppedBin.execution.status, "online");
  await waitForBrowserProcessesStopped("browser-one");
  const stoppedMemory = await browserContainerMemoryBytes("browser-one");
  assert.ok(
    stoppedMemory < awakeMemory,
    `浏览器真实退出后容器内存没有下降：ready=${String(awakeMemory)} stopped=${String(stoppedMemory)}`,
  );
  process.stdout.write(
    `票20空闲资源实测：${JSON.stringify({
      browserHostPid: initialBrowserProcess.pid,
      browserStartTime: initialBrowserProcess.startTime,
      readyMemoryBytes: awakeMemory,
      stoppedMemoryBytes: stoppedMemory,
    })}\n`,
  );

  assert.ok(playwrightBrowser !== undefined);
  const outerBrowser = playwrightBrowser;
  const loginSession = await startHumanSession("binny19-one");
  assert.equal(loginSession.status, "pending");
  const readyLogin = await waitForHuman(
    "binny19-one",
    loginSession.sessionId,
    "ready",
  );
  const humanWakeProcess = await browserMainProcess("browser-one");
  assert.notEqual(
    humanWakeProcess.startTime,
    initialBrowserProcess.startTime,
    "人工访问没有从已停止状态启动新的浏览器进程。",
  );
  const loginViewerUrl = new URL(loginSession.viewerUrl);
  loginViewerUrl.hostname = publishedHost;
  loginViewerUrl.port = String(serverPort);
  const loginViewer = await openViewer(outerBrowser, loginViewerUrl.href);
  await enterLoginThroughCanvas(loginViewer.page, 3_600, 0, loginViewer.frames);
  await delay(4_500);
  assert.equal(
    (await readBin("binny19-one")).execution.environment?.browser?.power
      ?.status,
    "ready",
    "人工操作期间空闲计时关闭了浏览器。",
  );
  await closeHumanSession("binny19-one", loginSession.sessionId);
  await waitForViewerClosed(loginViewer.closed);
  const loginViewerAfterClose = loginViewer.page.locator("#status");
  assert.equal(
    await loginViewerAfterClose.textContent(),
    "连接已结束，请回到终端查看会话状态。",
  );
  await assertVncStopped("browser-one");
  await loginViewer.page.close();
  assert.ok(readyLogin.readyAt !== undefined);
  await waitForBrowserPower("binny19-one", "stopped");
  await waitForBrowserProcessesStopped("browser-one");

  const persistedCheck = await triggerRun("binny19-one", "check");
  const persistedCheckResult = await waitForRun(
    "binny19-one",
    persistedCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(persistedCheckResult.status, "completed");
  assert.equal(persistedCheckResult.result?.check?.availability, "available");
  assert.equal(persistedCheckResult.result?.commits.length, 0);
  const checkWakeProcess = await browserMainProcess("browser-one");
  assert.notEqual(
    checkWakeProcess.startTime,
    humanWakeProcess.startTime,
    "check 没有从已停止状态重新启动浏览器。",
  );

  const adjacentCollect = await triggerRun("binny19-one", "collect");
  const adjacentCollectResult = await waitForRun(
    "binny19-one",
    adjacentCollect.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(adjacentCollectResult.status, "completed");
  assert.ok((adjacentCollectResult.result?.commits.length ?? 0) > 0);
  assert.deepEqual(await browserMainProcess("browser-one"), checkWakeProcess);
  await waitForBrowserPower("binny19-one", "stopped");
  await waitForBrowserProcessesStopped("browser-one");

  const archivedBeforeImageUpdate = await browserFixtureRunIds("binny19-one");
  assert.ok(archivedBeforeImageUpdate.size > 0);
  const updatedBrowserBin = await updateCollectorManifest(
    "binny19-one",
    browserImageUpdate.candidateManifest,
  );
  assert.equal(updatedBrowserBin.id, "binny19-one");
  assert.equal(
    updatedBrowserBin.version,
    collectorVersion(browserImageUpdate.candidateManifest),
  );
  const browserImageB = await replaceBrowserRuntimeImage(
    browserImage,
    browserImageUpdate.candidateImageId,
  );
  assert.equal(
    browserImageB.previous.imageId,
    browserImageUpdate.baselineImageId,
  );
  assert.equal(browserImageB.stopped.status, "exited");
  assert.equal(
    browserImageB.current.ownerVolume,
    browserImageA.current.ownerVolume,
  );
  assert.deepEqual(
    await runtimeManifest("browser-one"),
    browserImageUpdate.candidateManifest,
  );
  await waitForRuntime("binny19-one");
  const imageUpdateCheck = await triggerRun("binny19-one", "check");
  const imageUpdateCheckResult = await waitForRun(
    "binny19-one",
    imageUpdateCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(imageUpdateCheckResult.status, "completed");
  assert.equal(
    imageUpdateCheckResult.result?.check?.availability,
    "available",
    "浏览器镜像替换后，持久 profile 应继续保持登录状态。",
  );
  assert.equal(imageUpdateCheckResult.result?.commits.length, 0);
  assert.deepEqual(
    await browserFixtureRunIds("binny19-one"),
    archivedBeforeImageUpdate,
    "浏览器镜像替换不能丢失已归档资料。",
  );
  await waitForBrowserPower("binny19-one", "stopped");
  await waitForBrowserProcessesStopped("browser-one");
  process.stdout.write(
    `票27浏览器镜像更新实测：${JSON.stringify({
      binId: updatedBrowserBin.id,
      baselineVersion: collectorVersion(browserImageUpdate.baselineManifest),
      candidateVersion: updatedBrowserBin.version,
      baselineImageId: browserImageUpdate.baselineImageId,
      candidateImageId: browserImageUpdate.candidateImageId,
      oldContainerId: browserImageB.previous.id,
      oldContainerStatusAfterStop: browserImageB.stopped.status,
      newContainerId: browserImageB.current.id,
      profileVolume: browserImageB.current.ownerVolume,
      archivedFixtureIds: [...archivedBeforeImageUpdate].toSorted(),
      postUpdateCheck: imageUpdateCheckResult.result?.check?.availability,
    })}\n`,
  );

  await updateBin("binny19-one", 30);
  await delay(2_500);
  const collectWake = await triggerRun("binny19-one", "collect");
  const collectWakeResult = await waitForRun(
    "binny19-one",
    collectWake.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(collectWakeResult.status, "completed");
  assert.ok((collectWakeResult.result?.commits.length ?? 0) > 0);
  const collectWakeProcess = await browserMainProcess("browser-one");
  assert.notEqual(
    collectWakeProcess.startTime,
    checkWakeProcess.startTime,
    "collect 没有从已停止状态重新启动浏览器。",
  );

  await holdIdleProbeAtDeadline("binny19-one", 4);
  await updateBin("binny19-one", 30);
  await releaseIdleHeartbeatGate();
  await delay(5_000);
  assert.equal(
    (await readBin("binny19-one")).execution.environment?.browser?.power
      ?.status,
    "ready",
    "关闭尚未开始时延长空闲时限，旧截止时间仍关闭了浏览器。",
  );
  await updateBin("binny19-one", 4);
  await waitForBrowserPower("binny19-one", "stopped");
  await waitForBrowserProcessesStopped("browser-one");
  const browserFixtureRunsBeforeSchedule =
    await browserFixtureRunIds("binny19-one");
  const scheduleGateId = randomUUID();
  const scheduleGate = await createGate(scheduleGateId);
  const scheduledWake = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
  }>(
    await cli([
      "schedule",
      "create",
      "binny19-one",
      "--expression",
      "*/10 * * * * *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({ gateId: scheduleGateId }),
    ]),
    "created",
  );
  const scheduledFor = scheduledWake.nextDueAt;
  assert.ok(Date.parse(scheduledFor) > Date.now() - 2_000);
  assert.ok(Date.parse(scheduledFor) - Date.now() <= 10_000);
  await waitForGateStarted(scheduleGateId, scheduleGate);
  await waitForBrowserPower("binny19-one", "ready");
  const scheduleWakeProcess = await browserMainProcess("browser-one");
  assert.notEqual(
    scheduleWakeProcess.startTime,
    collectWakeProcess.startTime,
    "已停止的浏览器没有被真实采集计划唤醒。",
  );
  const scheduleAfterDue = cliData<{ readonly nextDueAt: string }>(
    await cli(["schedule", "get", "binny19-one", scheduledWake.scheduleId]),
    "found",
  );
  assert.ok(Date.parse(scheduleAfterDue.nextDueAt) > Date.parse(scheduledFor));
  assert.equal(
    cliData<{ readonly enabled: boolean }>(
      await cli([
        "schedule",
        "disable",
        "binny19-one",
        scheduledWake.scheduleId,
      ]),
      "disabled",
    ).enabled,
    false,
  );
  await updateBin("binny19-one", 30);
  await delay(2_500);
  await releaseGate(scheduleGateId, scheduleGate);
  const scheduledRunDeadline = Date.now() + 120_000;
  let scheduledSourceRunId: string | undefined;
  while (Date.now() < scheduledRunDeadline) {
    const current = await browserFixtureRunIds("binny19-one");
    scheduledSourceRunId = [...current].find(
      (runId) => !browserFixtureRunsBeforeSchedule.has(runId),
    );
    if (scheduledSourceRunId !== undefined) break;
    await delay(250);
  }
  assert.ok(scheduledSourceRunId !== undefined, "计划采集没有提交受控资料。");
  const scheduledRun = await waitForRun(
    "binny19-one",
    scheduledSourceRunId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(scheduledRun.status, "completed");
  assert.equal(scheduledRun.action, "collect");
  assert.equal(scheduledRun.trigger.kind, "schedule");
  if (scheduledRun.trigger.kind === "schedule") {
    assert.equal(scheduledRun.trigger.scheduleId, scheduledWake.scheduleId);
    assert.equal(scheduledRun.trigger.scheduledFor, scheduledFor);
  }
  assert.ok((scheduledRun.result?.commits.length ?? 0) > 0);
  await waitForGateUnload(scheduleGateId, scheduleGate);

  const stoppingProcess = await browserMainProcess("browser-one");
  const stoppingContainerPid = await browserContainerProcessId(stoppingProcess);
  const signalBrowser = async (signal: "SIGSTOP" | "SIGCONT") => {
    assert.deepEqual(await browserMainProcess("browser-one"), stoppingProcess);
    await compose([
      "exec",
      "--no-TTY",
      "browser-one",
      "node",
      "-e",
      `process.kill(${String(stoppingContainerPid)}, ${JSON.stringify(signal)});`,
    ]);
  };
  await signalBrowser("SIGSTOP");
  let pendingWake: Run | undefined;
  try {
    await updateBin("binny19-one", 0);
    await waitForBrowserPower("binny19-one", "stopping");
    pendingWake = await triggerRun("binny19-one", "collect");
    const waitingWake = await waitForRun(
      "binny19-one",
      pendingWake.runId,
      (run) => run.status === "executing" || run.status === "failed",
    );
    assert.equal(waitingWake.status, "executing");
    assert.equal(
      (await readBin("binny19-one")).execution.environment?.browser?.power
        ?.status,
      "stopping",
    );
    assert.deepEqual(
      await browserMainProcess("browser-one"),
      stoppingProcess,
      "旧浏览器退出前运行器启动了第二个 profile 使用者。",
    );
    await updateBin("binny19-one", 30);
    await delay(2_500);
  } finally {
    await signalBrowser("SIGCONT");
  }
  assert.ok(pendingWake !== undefined);
  const wakeAfterStop = await waitForRun(
    "binny19-one",
    pendingWake.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(wakeAfterStop.status, "completed");
  await waitForBrowserPower("binny19-one", "ready");
  assert.notDeepEqual(
    await browserMainProcess("browser-one"),
    stoppingProcess,
    "关闭中的需求没有等旧 profile 退出后重新启动浏览器。",
  );
  await updateBin("binny19-one", 4);

  const disconnectedSession = await startHumanSession("binny19-one");
  await waitForHuman("binny19-one", disconnectedSession.sessionId, "ready");
  const disconnectedViewerUrl = new URL(disconnectedSession.viewerUrl);
  disconnectedViewerUrl.hostname = publishedHost;
  disconnectedViewerUrl.port = String(serverPort);
  const disconnectedViewer = await openViewer(
    outerBrowser,
    disconnectedViewerUrl.href,
  );
  await compose(["stop", "postgres"]);
  await waitForViewerClosed(disconnectedViewer.closed, 30_000);
  await waitForVncStopped("browser-one");
  await disconnectedViewer.page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent?.includes("连接已结束") ===
      true,
    undefined,
    { timeout: 5_000 },
  );
  assert.equal(
    await disconnectedViewer.page.locator("#status").textContent(),
    "连接已结束，请回到终端查看会话状态。",
  );
  await assertVncStopped("browser-one");
  await compose(["start", "postgres"]);
  await waitForApi();
  const recoveredSession = await waitForHumanTerminal(
    "binny19-one",
    disconnectedSession.sessionId,
  );
  assert.equal(recoveredSession.status, "closed");
  await disconnectedViewer.page.close();
  await waitForRuntime("binny19-one");

  const profileTwoCheck = await triggerRun("binny19-two", "check");
  const profileTwoCheckResult = await waitForRun(
    "binny19-two",
    profileTwoCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(profileTwoCheckResult.status, "completed");
  assert.equal(
    profileTwoCheckResult.result?.check?.availability,
    "unavailable",
  );

  const gateId = randomUUID();
  const gate = await createGate(gateId);
  const gatedRun = await triggerRun("binny19-one", "collect", { gateId });
  await waitForGateStarted(gateId, gate);
  await delay(300);
  await refreshGate(gateId, gate);
  await delay(4_500);
  await refreshGate(gateId, gate);
  assert.ok(gate.touches > 0, "受控页面没有保持自动阶段活动状态。");
  assert.equal(
    (await readBin("binny19-one")).execution.environment?.browser?.power
      ?.status,
    "ready",
    "自动运行期间空闲计时关闭了浏览器。",
  );

  const pendingSession = await startHumanSession("binny19-one");
  assert.equal(pendingSession.status, "pending");
  const queuedRun = await triggerRun("binny19-one", "check");
  const queuedRunCurrent = await readRun("binny19-one", queuedRun.runId);
  assert.equal(queuedRunCurrent.status, "queued");
  assert.equal(queuedRunCurrent.queueReason, "human_session_active");
  const cancelledQueued = cliData<Run>(
    await cli(["run", "cancel", "binny19-one", queuedRun.runId]),
    "cancellation",
  );
  assert.equal(cancelledQueued.status, "cancelled");

  await releaseGate(gateId, gate);
  const gatedResult = await waitForGateQuiet(
    gateId,
    gate,
    waitForRun(
      "binny19-one",
      gatedRun.runId,
      (run) => run.status === "completed" || run.status === "failed",
    ),
  );
  assert.equal(gatedResult.status, "completed");
  await waitForGateUnload(gateId, gate);
  assert.ok((gatedResult.result?.commits.length ?? 0) > 0);
  assert.ok(gatedResult.stopConfirmedAt !== undefined);
  assert.ok(
    gate.unloadedAt !== undefined,
    "controller 没有关闭自动阶段遗留页面。",
  );
  assert.ok(
    gate.unloadedAt <= new Date(gatedResult.finishedAt ?? "").getTime() + 1_000,
    "运行结果写入前没有确认自动阶段页面退出。",
  );

  const pendingReady = await waitForHuman(
    "binny19-one",
    pendingSession.sessionId,
    "ready",
  );
  assert.ok(
    pendingReady.readyAt !== undefined &&
      new Date(pendingReady.readyAt).getTime() >=
        new Date(gatedResult.stopConfirmedAt).getTime(),
    "人工会话在原运行停止确认前进入 ready。",
  );
  await closeHumanSession("binny19-one", pendingSession.sessionId);
  await assertVncStopped("browser-one");

  const beforeRestartSession = await startHumanSession("binny19-one");
  const readyBeforeRestart = await waitForHuman(
    "binny19-one",
    beforeRestartSession.sessionId,
    "ready",
  );
  assert.equal(readyBeforeRestart.status, "ready");
  const oldViewerUrl = new URL(beforeRestartSession.viewerUrl);
  oldViewerUrl.hostname = publishedHost;
  oldViewerUrl.port = String(serverPort);
  const oldViewer = await openViewer(outerBrowser, oldViewerUrl.href);
  await assertVncLoopbackOnly();
  const originalProcesses = await browserHostProcesses("browser-one");
  const killed = await run("docker", [
    "kill",
    "--signal",
    "KILL",
    `${projectName}-browser-one-1`,
  ]);
  assert.equal(killed.code, 0, killed.stderr);
  await waitForViewerClosed(oldViewer.closed);
  await waitForHostProcessesGone(originalProcesses);
  await oldViewer.page.close();

  await compose(["rm", "--force", "--stop", "browser-one"]);
  await compose(["up", "--detach", "--no-deps", "browser-one"]);
  await waitForRuntime("binny19-one");
  await waitForHuman("binny19-one", beforeRestartSession.sessionId, "closed");

  const rejectedOldViewer = await outerBrowser.newPage();
  await rejectedOldViewer.goto(oldViewerUrl.href);
  await rejectedOldViewer.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "连接已结束，请回到终端查看会话状态。",
    undefined,
    { timeout: 15_000 },
  );
  assert.equal(await rejectedOldViewer.locator("#screen canvas").count(), 0);
  await rejectedOldViewer.close();

  const afterRestartCollect = await triggerRun("binny19-one", "collect");
  const afterRestartResult = await waitForRun(
    "binny19-one",
    afterRestartCollect.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(afterRestartResult.status, "completed");
  assert.ok((afterRestartResult.result?.commits.length ?? 0) > 0);

  const contender = await compose(
    ["up", "--detach", "--no-deps", "browser-one-contender"],
    "binny19,binny19-lock",
  );
  assert.equal(contender.code, 0);
  const contenderName = `${projectName}-browser-one-contender-1`;
  const contenderDeadline = Date.now() + 15_000;
  let contenderState = "running";
  while (Date.now() < contenderDeadline && contenderState === "running") {
    const inspected = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.ExitCode}}",
      contenderName,
    ]);
    assert.equal(inspected.code, 0, inspected.stderr);
    contenderState = inspected.stdout.trim();
    if (contenderState.startsWith("running ")) await delay(100);
  }
  assert.ok(
    contenderState.startsWith("exited "),
    `同卷第二实例没有退出：${contenderState}`,
  );
  assert.ok(
    contenderState.endsWith(" 1"),
    `同卷第二实例退出码异常：${contenderState}`,
  );

  const shortSession = await startHumanSession("binny19-two");
  await waitForHuman("binny19-two", shortSession.sessionId, "ready");
  const shortViewerUrl = new URL(shortSession.viewerUrl);
  shortViewerUrl.hostname = publishedHost;
  shortViewerUrl.port = String(serverPort);
  const shortViewer = await openViewer(outerBrowser, shortViewerUrl.href);
  const shortCookie = (await sourceMetrics()).loginSubmissions.length;
  await enterLoginThroughCanvas(
    shortViewer.page,
    10,
    shortCookie,
    shortViewer.frames,
  );
  assert.equal((await sourceMetrics()).loginSubmissions.at(-1)?.maxAge, 10);
  await closeHumanSession("binny19-two", shortSession.sessionId);
  await waitForViewerClosed(shortViewer.closed);
  await shortViewer.page.close();
  await delay(11_000);
  const disabledIdleBin = await readBin("binny19-two");
  assert.equal(disabledIdleBin.browserIdleTimeoutSeconds, null);
  assert.equal(disabledIdleBin.execution.status, "online");
  assert.equal(
    disabledIdleBin.execution.environment?.browser?.power?.status,
    "ready",
    "禁用空闲关闭后浏览器仍被自动停掉。",
  );

  const expiredCheck = await triggerRun("binny19-two", "check");
  const expiredCheckResult = await waitForRun(
    "binny19-two",
    expiredCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(expiredCheckResult.status, "completed");
  assert.equal(expiredCheckResult.result?.check?.availability, "unavailable");
  assert.equal(
    expiredCheckResult.result?.check?.problems[0]?.requiresHuman,
    true,
  );

  const expiredCollect = await triggerRun("binny19-two", "collect");
  const expiredCollectResult = await waitForRun(
    "binny19-two",
    expiredCollect.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(expiredCollectResult.status, "failed");
  assert.equal(expiredCollectResult.result?.error?.code, "login_required");
  assert.equal(expiredCollectResult.result?.error?.requiresHuman, true);
}

try {
  try {
    await main();
    process.stdout.write("票19与票20浏览器生命周期正式 Compose 验收通过。\n");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${composeStarted ? await diagnostics() : ""}`,
    );
  }
} finally {
  if (playwrightBrowser !== undefined)
    await playwrightBrowser.close().catch(() => undefined);
  await run("docker", ["rm", "--force", outerBrowserContainer]).catch(
    () => undefined,
  );
  if (processObserverStarted)
    await run("docker", ["rm", "--force", processObserver]).catch(
      () => undefined,
    );
  if (composeStarted)
    await rawCompose(
      ["down", "--volumes", "--remove-orphans"],
      "binny19,binny19-lock",
    ).catch(() => undefined);
  if (builtImages.size > 0)
    await run("docker", ["image", "rm", "--force", ...builtImages]).catch(
      () => undefined,
    );
  if (testDirectory !== undefined)
    await rm(testDirectory, { recursive: true, force: true });
}
