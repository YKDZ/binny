import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  resolveBakeComposeContexts,
  type BakeComposeContexts,
} from "@binny/tooling-config/bake-compose-contexts";
import {
  startVncViewerFixture,
  type VncViewerFixture,
  type VncViewerHandle,
} from "@binny/tooling-config/vnc-viewer-fixture";

import { assertBinActionDeclarations } from "./binny-cli-adapter-discovery.ts";
import {
  copyImageBuildContext,
  setBuildContextSourceAdapterVersion,
} from "./binny-image-update-context.ts";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type BrowserService = "browser-one" | "browser-two";

type ContainerProcess = {
  readonly pid: string;
  readonly state: string;
  readonly command: string;
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
  readonly exitCode: number;
  readonly startedAt: string;
  readonly ownerVolume: string;
};

type CliWire<T> = {
  readonly kind: string;
  readonly variant: string;
  readonly data: T;
};

type HumanSessionStatus = {
  readonly sessionId: string;
  readonly binId?: string;
  readonly status: string;
  readonly queueReason?: string;
  readonly requestedAt?: string;
  readonly readyAt?: string;
  readonly closedAt?: string;
  readonly host?: unknown;
  readonly port?: unknown;
  readonly password?: unknown;
  readonly viewerPath?: unknown;
  readonly failure?: { readonly code: string; readonly message: string };
};

type HumanSessionCreated = HumanSessionStatus & {
  readonly password: string;
};

type HumanOpenWaitingRecord = {
  readonly sessionId: string;
  readonly binId: string;
  readonly status: string;
  readonly queueReason?: string;
};

type HumanOpenReadyRecord = {
  readonly sessionId: string;
  readonly binId: string;
  readonly status: "ready";
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly requestedAt: string;
  readonly readyAt: string;
};

type Run = {
  readonly runId: string;
  readonly action: string;
  readonly sourceAdapterVersion: string;
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
    readonly output?: {
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
  readonly id: string;
  readonly sourceAdapterId: string;
  readonly identityId: string;
  readonly config: Record<string, unknown>;
  readonly runtimeSleep: { readonly idleTimeoutSeconds: number | null };
  readonly execution: {
    readonly status: string;
    readonly phase?: string;
    readonly reason?: string;
    readonly error?: { readonly code: string };
    readonly environment?: {
      readonly kind?: string;
      readonly browser?: {
        readonly profileReuseAfterRestart?: boolean;
        readonly power?: BrowserPower;
      };
    };
  };
};

type BinConfigSchemaDiscovery = {
  readonly sourceAdapterId: string;
  readonly sourceAdapterVersion: string;
  readonly configSchema: Record<string, unknown>;
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
  readonly loginFormsReady: number;
  readonly authenticatedProtectedVisits: readonly number[];
  readonly gates: Readonly<Record<string, SourceGate>>;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.acceptance.yaml");
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const projectName = `binny-browser-${suffix}`;
const serverImage = `binny-browser-server-${suffix}:local`;
const browserImage = `binny-browser-browser-${suffix}:local`;
const browserBaselineImage = `binny-browser-browser-${suffix}-image-a:local`;
const browserNonReusableImage = `binny-browser-browser-${suffix}-non-reusable:local`;
const browserFixturePackage = "@binny/source-adapter-browser-session-fixture";
const vncViewerImage = `binny-browser-vnc-viewer-${suffix}:local`;
const processObserver = `${projectName}-process-observer`;
const password = `binny-browser${randomUUID().replaceAll("-", "")}`;
const publishedHost = process.env.BINNY_BROWSER_PUBLISHED_HOST ?? "172.17.0.1";
let serverPort: number | undefined;
let sitePort: number | undefined;
let heartbeatProxyControlPort: number | undefined;
let testDirectory: string | undefined;
let overlayFile: string | undefined;
let activeBrowserImage = browserImage;
let vncViewerFixture: VncViewerFixture | undefined;
let composeStarted = false;
const builtImages = new Set<string>();
let processObserverStarted = false;
let bakeComposeContexts: BakeComposeContexts | undefined;

function environment(): Readonly<Record<string, string>> {
  bakeComposeContexts ??= resolveBakeComposeContexts(repositoryRoot);
  return {
    ...bakeComposeContexts,
    BINNY_IMAGE: serverImage,
    BINNY_TEST_BROWSER_IMAGE: activeBrowserImage,
    BINNY_TEST_VNC_VIEWER_IMAGE: vncViewerImage,
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

function composePrefix(profile = "binny-browser"): readonly string[] {
  const prefix = [
    "compose",
    "--project-name",
    projectName,
    "--file",
    composeFile,
  ];
  for (const value of profile.split(",")) prefix.push("--profile", value);
  if (overlayFile !== undefined) prefix.push("--file", overlayFile);
  return prefix;
}

async function compose(
  args: readonly string[],
  profile = "binny-browser",
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
  profile = "binny-browser",
): Promise<ProcessResult> {
  return await run("docker", [...composePrefix(profile), ...args]);
}

async function cli(args: readonly string[]): Promise<ProcessResult> {
  return await rawCompose([
    "exec",
    "--no-TTY",
    "server",
    "node",
    "apps/cli/dist/cli.js",
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
  const requested = process.env.BINNY_CAPACITY_SUBNET ?? "10.253.21.0/24";
  assert.ok(
    existing.every((subnet) => !rangesOverlap(requested, subnet)),
    `BINNY_CAPACITY_SUBNET ${requested} 与现有 Docker 网络重叠。`,
  );
  return requested;
}

async function createComposeOverlay(): Promise<void> {
  testDirectory = await mkdtemp(path.join(tmpdir(), "binny-browser-browser-"));
  overlayFile = path.join(testDirectory, "compose.network.yaml");
  const subnet = await freeBrowserSubnet();
  await writeFile(
    overlayFile,
    [
      "services:",
      "  server:",
      "    environment:",
      '      BINNY_HUMAN_SESSION_VIEWER_WAIT_MS: "10000"',
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
      "    profiles: [binny-browser]",
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

async function armHumanOpenResponseGate(binId: string): Promise<void> {
  assert.ok(heartbeatProxyControlPort !== undefined);
  const response = await fetch(
    `http://${publishedHost}:${String(heartbeatProxyControlPort)}/control/arm`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ binId, humanOpenResponse: true }),
      signal: AbortSignal.timeout(3_000),
    },
  );
  assert.equal(response.status, 200, await response.text());
}

async function waitForHumanOpenResponseGate(): Promise<void> {
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
      readonly heldForHumanOpenResponse: boolean;
    };
    if (state.held && state.heldForHumanOpenResponse) return;
    await delay(100);
  }
  throw new Error("心跳代理没有拦住人工 open 响应。");
}

async function waitForHeldHeartbeatClientClosed(): Promise<void> {
  assert.ok(heartbeatProxyControlPort !== undefined);
  const controlUrl = `http://${publishedHost}:${String(heartbeatProxyControlPort)}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${controlUrl}/control/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const state = (await response.json()) as {
      readonly heldAt?: number;
      readonly clientClosedAt?: number;
    };
    if (
      typeof state.heldAt === "number" &&
      typeof state.clientClosedAt === "number" &&
      state.clientClosedAt >= state.heldAt
    )
      return;
    await delay(100);
  }
  throw new Error("运行器没有因超时放弃已拦截的人工 open 响应。");
}

async function releaseHeartbeatGate(): Promise<void> {
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
        readonly sourceAdapter?: Record<string, unknown>;
      };
      assert.ok(payload.sourceAdapter !== undefined);
      return payload.sourceAdapter;
    }
    lastError = result.stderr;
    await delay(250);
  }
  throw new Error(`正式浏览器运行器没有发布清单：${lastError}`);
}

function sourceAdapterVersion(manifest: Record<string, unknown>): string {
  const version = manifest.version;
  assert.ok(typeof version === "string" && version.length > 0);
  return version;
}

function sourceAdapterManifestWithVersion(
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
    readonly State?: {
      readonly Status?: string;
      readonly ExitCode?: number;
      readonly StartedAt?: string;
    };
    readonly Mounts?: readonly {
      readonly Type?: string;
      readonly Name?: string;
      readonly Destination?: string;
    }[];
  }[];
  assert.ok(container !== undefined, `${service} 容器没有检查结果。`);
  const ownerVolume = container?.Mounts?.find(
    ({ Destination, Type }) =>
      Destination === "/var/lib/binny/browser-profile" && Type === "volume",
  )?.Name;
  assert.ok(ownerVolume, `${service} 没有挂载持久运行目录。`);
  return {
    id: container.Id,
    imageId: container.Image,
    status: container.State?.Status ?? "unknown",
    exitCode: container.State?.ExitCode ?? 0,
    startedAt: container.State?.StartedAt ?? "",
    ownerVolume,
  };
}

async function replaceBrowserRuntimeImage(
  image: string,
  expectedImageId: string,
  afterOldImageStops?: () => Promise<void>,
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
  await afterOldImageStops?.();

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
  const candidateVersion = sourceAdapterVersion(candidateManifest);
  const baselineVersion = candidateVersion + "-image-a";
  const baselineManifest = sourceAdapterManifestWithVersion(
    candidateManifest,
    baselineVersion,
  );
  await copyImageBuildContext(repositoryRoot, buildContextDirectory);
  await setBuildContextSourceAdapterVersion(
    buildContextDirectory,
    "source-adapters/browser-session-fixture/src/index.ts",
    "binny-browser.browser-session-fixture",
    baselineVersion,
  );

  const candidateImageId = await imageId(browserImage);
  const previousBrowserImage = activeBrowserImage;
  let baselineImageId: string;
  try {
    activeBrowserImage = browserBaselineImage;
    const build = await run(
      "pnpm",
      [
        "--workspace-root",
        "exec",
        "turbo",
        "run",
        `${browserFixturePackage}#image:build`,
      ],
      { BINNY_IMAGE_BUILD_CONTEXT: buildContextDirectory },
    );
    assert.equal(
      build.code,
      0,
      `Browser baseline image build failed:\n${(build.stdout + build.stderr).slice(-12_000)}`,
    );
    builtImages.add(browserBaselineImage);
    baselineImageId = await imageId(browserBaselineImage);
  } finally {
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

async function buildNonReusableBrowserImage(
  buildContextDirectory: string,
): Promise<string> {
  await copyImageBuildContext(repositoryRoot, buildContextDirectory);
  const adapterPath = path.join(
    buildContextDirectory,
    "source-adapters/browser-session-fixture/src/index.ts",
  );
  const original = await readFile(adapterPath, "utf8");
  const updated = original.replace(
    "profileReuseAfterRestart: true",
    'profileReuseAfterRestart: false, profileReuseUnavailableReason: "Test fixture marks profile non-reusable across restarts."',
  );
  assert.notEqual(
    updated,
    original,
    "Failed to rewrite browser fixture adapter to profileReuseAfterRestart: false.",
  );
  await writeFile(adapterPath, updated, "utf8");

  const previousBrowserImage = activeBrowserImage;
  try {
    activeBrowserImage = browserNonReusableImage;
    const build = await run(
      "pnpm",
      [
        "--workspace-root",
        "exec",
        "turbo",
        "run",
        `${browserFixturePackage}#image:build`,
      ],
      { BINNY_IMAGE_BUILD_CONTEXT: buildContextDirectory },
    );
    assert.equal(
      build.code,
      0,
      `Non-reusable browser image build failed:\n${(build.stdout + build.stderr).slice(-12_000)}`,
    );
    builtImages.add(browserNonReusableImage);
    return await imageId(browserNonReusableImage);
  } finally {
    activeBrowserImage = previousBrowserImage;
  }
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

async function buildVncViewerImage(): Promise<void> {
  const viewerImageBuild = await run("pnpm", [
    "--workspace-root",
    "exec",
    "turbo",
    "run",
    "@binny/source-adapter-runtime#image:build:vnc-viewer-fixture",
  ]);
  assert.equal(
    viewerImageBuild.code,
    0,
    `VNC viewer fixture image build failed:\n${(viewerImageBuild.stdout + viewerImageBuild.stderr).slice(-12_000)}`,
  );
  builtImages.add(vncViewerImage);
}

async function startVncViewer(): Promise<VncViewerFixture> {
  return await startVncViewerFixture({
    containerName: `${projectName}-vnc-viewer`,
    image: vncViewerImage,
    run,
  });
}

async function publishedVncHostPort(service: BrowserService): Promise<number> {
  return await publishedPort(service, 5900);
}

function wrongVncPassword(password: string): string {
  const first = password[0] === "X" ? "Y" : "X";
  return `${first}${password.slice(1)}`;
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
  const runIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = cliData<{
      readonly results: readonly {
        readonly sourceKey: {
          readonly namespace: string;
          readonly key: string;
        };
      }[];
      readonly nextCursor?: string;
    }>(
      await cli([
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: [binId],
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ]),
      "found",
    );
    for (const { sourceKey } of page.results) {
      const prefix = `${binId}:`;
      if (
        sourceKey.namespace === "binny-browser.browser-session-fixture" &&
        sourceKey.key.startsWith(prefix)
      ) {
        runIds.add(sourceKey.key.slice(prefix.length));
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return runIds;
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

async function waitForBinRegistration(
  binId: string,
  expectedManifest: Record<string, unknown>,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastState = "尚未查询。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", binId]);
    if (result.code === 0) {
      const bin = cliData<Bin>(result, "found");
      if (
        bin.sourceAdapterId === expectedManifest.id &&
        bin.execution.status === "incompatible"
      ) {
        const schemaResult = await cli(["bin", "config-schema", binId]);
        if (schemaResult.code === 0) {
          const declaration = cliData<BinConfigSchemaDiscovery>(
            schemaResult,
            "discovered",
          );
          if (
            declaration.sourceAdapterId === expectedManifest.id &&
            declaration.sourceAdapterVersion === expectedManifest.version
          ) {
            assert.deepEqual(
              declaration.configSchema,
              expectedManifest.configSchema,
            );
            await assertBinActionDeclarations(cli, binId, expectedManifest);
            assert.equal(bin.id, binId);
            assert.equal(bin.identityId, binId);
            assert.deepEqual(bin.config, {});
            assert.equal(
              bin.execution.error?.code,
              "runtime_configuration_incompatible",
            );
            return;
          }
          lastState = JSON.stringify({ bin, declaration });
        } else {
          lastState = schemaResult.stderr;
        }
      } else {
        lastState = JSON.stringify(bin);
      }
    } else {
      lastState = result.stderr;
    }
    await delay(250);
  }
  throw new Error(`等待 bin ${binId} 自注册超时：${lastState}`);
}

async function waitForSourceAdapterVersion(
  binId: string,
  expectedManifest: Record<string, unknown>,
): Promise<{
  readonly bin: Bin;
  readonly declaration: BinConfigSchemaDiscovery;
}> {
  const version = sourceAdapterVersion(expectedManifest);
  const deadline = Date.now() + 60_000;
  let lastState = "尚未查询。";
  while (Date.now() < deadline) {
    const schemaResult = await cli(["bin", "config-schema", binId]);
    if (schemaResult.code === 0) {
      const declaration = cliData<BinConfigSchemaDiscovery>(
        schemaResult,
        "discovered",
      );
      if (
        declaration.sourceAdapterId === expectedManifest.id &&
        declaration.sourceAdapterVersion === version
      ) {
        assert.deepEqual(
          declaration.configSchema,
          expectedManifest.configSchema,
        );
        await assertBinActionDeclarations(cli, binId, expectedManifest);
        return { bin: await readBin(binId), declaration };
      }
      lastState = JSON.stringify(declaration);
    } else {
      lastState = schemaResult.stderr;
    }
    await delay(250);
  }
  throw new Error(`等待 bin ${binId} 源码版本 ${version} 超时：${lastState}`);
}

async function configureRegisteredBin(
  binId: string,
  idleTimeout: number | "disabled",
): Promise<Bin> {
  return cliData(
    await cli([
      "bin",
      "update",
      binId,
      "--identity",
      `identity-${binId}`,
      "--config",
      JSON.stringify({ baseUrl: "http://browser-session-source:8081/" }),
      "--idle-timeout-seconds",
      String(idleTimeout),
    ]),
    "updated",
  );
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
      "--idle-timeout-seconds",
      String(idleTimeout),
    ]),
    "updated",
  );
}

async function readBin(binId: string): Promise<Bin> {
  return cliData(await cli(["bin", "get", binId]), "found");
}

async function waitForRuntime(
  binId: string,
  expectedProfileReuse = true,
): Promise<Record<string, unknown>> {
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
          expectedProfileReuse,
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

async function waitForContainerSleeping(
  binId: string,
  service: BrowserService,
  timeoutMs = 60_000,
): Promise<{
  readonly bin: Bin;
  readonly container: BrowserRuntimeContainer;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "not queried yet.";
  while (Date.now() < deadline) {
    const [bin, container] = await Promise.all([
      readBin(binId),
      browserRuntimeContainerInfo(service),
    ]);
    lastState = JSON.stringify({ execution: bin.execution, container });
    if (
      bin.execution.status === "sleeping" &&
      bin.execution.phase === "sleeping" &&
      container.status === "exited" &&
      container.exitCode === 0
    ) {
      return { bin, container };
    }
    await delay(150);
  }
  throw new Error(
    `Timed out waiting for ${binId} container sleep: ${lastState}`,
  );
}

async function waitForContainerPhase(
  binId: string,
  expectedPhase: string,
  timeoutMs = 30_000,
): Promise<Bin> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "not queried yet.";
  while (Date.now() < deadline) {
    const bin = await readBin(binId);
    lastState = JSON.stringify(bin.execution);
    if (bin.execution.phase === expectedPhase) return bin;
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${binId} container phase ${expectedPhase}: ${lastState}`,
  );
}

async function waitForBrowserProcessesStopped(
  service: BrowserService = "browser-one",
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      (await activeBrowserMainProcessCount(service)) === 0 &&
      (await zombieBrowserProcesses(service)).length === 0
    ) {
      return;
    }
    await delay(150);
  }
  const zombies = await zombieBrowserProcesses(service);
  const activeCount = await activeBrowserMainProcessCount(service);
  throw new Error(
    `${service} 的浏览器与显示进程仍未退出：${JSON.stringify({
      activeCount,
      zombies,
    })}`,
  );
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

async function waitForLoginFormReady(
  index: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await sourceMetrics()).loginFormsReady > index) return;
    await delay(100);
  }
  throw new Error("The controlled login form did not receive keyboard focus.");
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

function parseHumanOpenStream(result: ProcessResult): {
  readonly waiting: readonly HumanOpenWaitingRecord[];
  readonly ready: HumanOpenReadyRecord;
} {
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly kind: string;
          readonly variant?: string;
          readonly data?: unknown;
        },
    );
  assert.ok(
    lines.length >= 3,
    `Expected NDJSON stream output:\n${result.stdout}`,
  );
  assert.equal(lines[0]?.kind, "stream");
  assert.equal(lines.at(-1)?.kind, "streamSuccess");
  const waiting = lines
    .filter((line) => line.kind === "record" && line.variant === "waiting")
    .map((line) => line.data as HumanOpenWaitingRecord);
  const readyRecords = lines.filter(
    (line) => line.kind === "record" && line.variant === "ready",
  );
  assert.equal(
    readyRecords.length,
    1,
    `Expected 1 ready record:\n${result.stdout}`,
  );
  const ready = readyRecords[0]?.data as HumanOpenReadyRecord;
  assert.equal(ready.status, "ready");
  assert.equal(ready.host, publishedHost);
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  assert.match(ready.password, /^[A-Za-z0-9]{8}$/u);
  return { waiting, ready };
}

async function openHumanSessionStream(binId: string): Promise<{
  readonly waiting: readonly HumanOpenWaitingRecord[];
  readonly ready: HumanOpenReadyRecord;
}> {
  assert.ok(serverPort !== undefined);
  const result = await cli([
    "human",
    "open",
    binId,
    "--url",
    `http://${publishedHost}:${String(serverPort)}`,
  ]);
  const parsed = parseHumanOpenStream(result);
  const inspectedCli = cliData<HumanSessionStatus>(
    await cli(["human", "get", binId, parsed.ready.sessionId]),
    "found",
  );
  assert.equal(inspectedCli.status, "ready");
  assert.equal(inspectedCli.host, undefined);
  assert.equal(inspectedCli.port, undefined);
  assert.equal(inspectedCli.password, undefined);
  return parsed;
}

async function getHumanSessionHttp(
  binId: string,
  sessionId: string,
): Promise<HumanSessionStatus> {
  assert.ok(serverPort !== undefined);
  const response = await fetch(
    `http://${publishedHost}:${String(serverPort)}/bins/${binId}/human-sessions/${sessionId}`,
    { signal: AbortSignal.timeout(5_000) },
  );
  const rawBody = await response.text();
  assert.equal(response.status, 200, rawBody);
  const body = JSON.parse(rawBody) as HumanSessionStatus;
  assert.equal(body.password, undefined);
  assert.equal(body.viewerPath, undefined);
  return body;
}

async function enterLoginThroughVnc(
  viewer: VncViewerHandle,
  maxAgeSeconds: number,
  expectedSubmissionIndex: number,
): Promise<void> {
  const initialMetrics = await sourceMetrics();
  const loginFormIndex = initialMetrics.loginFormsReady;
  const protectedVisitIndex =
    initialMetrics.authenticatedProtectedVisits.length;
  await viewer.navigateTo(
    `http://browser-session-source:8081/login?lifetime=${String(maxAgeSeconds)}`,
  );
  await waitForLoginFormReady(loginFormIndex);
  await viewer.typeText("binny-browser-user", 10);
  await viewer.pressKey("Tab");
  await viewer.typeText("browser-session", 10);
  await viewer.pressKey("Tab");
  await viewer.pressKey("Return");
  await waitForLoginSubmission(expectedSubmissionIndex);
  await waitForAuthenticatedVisit(protectedVisitIndex);
}

async function startHumanSession(binId: string): Promise<HumanSessionCreated> {
  assert.ok(serverPort !== undefined);
  const response = await fetch(
    `http://${publishedHost}:${String(serverPort)}/bins/${binId}/human-sessions`,
    { method: "POST", signal: AbortSignal.timeout(5_000) },
  );
  const rawBody = await response.text();
  assert.equal(response.status, 201, rawBody);
  const created = JSON.parse(rawBody) as HumanSessionCreated;
  assert.match(created.password, /^[A-Za-z0-9]{8}$/u);
  assert.equal(created.viewerPath, undefined);
  assert.equal(created.port, undefined);
  return created;
}

async function closeHumanSession(
  binId: string,
  sessionId: string,
): Promise<HumanSessionStatus> {
  const requested = await requestHumanSessionClose(binId, sessionId);
  assert.ok(requested.status === "closing" || requested.status === "closed");
  return await waitForHuman(binId, sessionId, "closed");
}

async function requestHumanSessionClose(
  binId: string,
  sessionId: string,
): Promise<HumanSessionStatus> {
  const result = await cli(["human", "close", binId, sessionId.toUpperCase()]);
  const closed = cliData<HumanSessionStatus>(result, "closed");
  assert.equal(closed.host, undefined);
  assert.equal(closed.port, undefined);
  assert.equal(closed.password, undefined);
  return closed;
}

async function verifyPatchrightDeploys(service: string): Promise<void> {
  const result = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "-e",
    'const fs = require("node:fs"); const path = require("node:path"); for (const root of ["/app/browser-session-fixture", "/app/binny-runtime"]) console.log(JSON.parse(fs.readFileSync(path.join(root, "node_modules/patchright-core/package.json"), "utf8")).version);',
  ]);
  assert.deepEqual(result.stdout.trim().split(/\s+/u), ["1.64.2", "1.64.2"]);
}

async function verifyBrowserRuntimePermissions(service: string): Promise<void> {
  const result = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "-e",
    'const fs = require("node:fs"); const path = require("node:path"); const uid = process.getuid?.(); const profile = process.env.BINNY_BROWSER_PROFILE_DIRECTORY; if (uid === undefined || uid === 0 || profile === undefined) process.exit(2); const probe = path.join(profile, `.binny-profile-write-${process.pid}`); try { fs.writeFileSync(probe, "ok"); } finally { fs.rmSync(probe, { force: true }); } console.log(JSON.stringify({ uid, profile, writable: true }));',
  ]);
  const permissions = JSON.parse(result.stdout.trim()) as {
    readonly uid: number;
    readonly profile: string;
    readonly writable: boolean;
  };
  assert.ok(permissions.uid > 0, `${service} must run as a non-root user.`);
  assert.equal(
    permissions.profile,
    "/var/lib/binny/browser-profile",
    `${service} must use the production browser profile path.`,
  );
  assert.equal(permissions.writable, true);
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

async function browserProcesses(
  service: BrowserService = "browser-one",
): Promise<readonly ContainerProcess[]> {
  const info = await browserRuntimeContainerInfo(service);
  if (info.status !== "running") return [];
  const result = await run("docker", [
    "top",
    info.id,
    "-eo",
    "pid,ppid,stat,comm,args",
  ]);
  if (result.code !== 0) {
    const refreshed = await browserRuntimeContainerInfo(service);
    if (refreshed.status !== "running") return [];
  }
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.split("\n").flatMap((line) => {
    const columns = /^(\s*\d+)\s+\d+\s+(\S+)\s+\S+(?:\s+(.*))?$/u.exec(line);
    if (columns === null) return [];
    const pid = columns[1]!.trim();
    const state = columns[2]!;
    const args = columns[3] ?? "";
    return [
      {
        pid,
        state,
        command: `${pid} ${args}`,
      },
    ];
  });
}

async function zombieBrowserProcesses(
  service: BrowserService = "browser-one",
): Promise<readonly ContainerProcess[]> {
  const processes = await browserProcesses(service);
  return processes.filter(({ state }) => /^[Zz]/u.test(state));
}

async function activeBrowserMainProcessCount(
  service?: BrowserService,
): Promise<number> {
  const targetServices: readonly BrowserService[] =
    service !== undefined ? [service] : ["browser-one", "browser-two"];
  const processes = await Promise.all(
    targetServices.map((entry) => browserProcesses(entry)),
  );
  return processes.reduce(
    (count, result) =>
      count +
      result.filter(
        ({ state, command }) =>
          !/^[ZXx]/u.test(state) &&
          /(?:chrom(?:e|ium))/iu.test(command) &&
          !command.includes("--type=") &&
          !command.includes("chrome_crashpad_handler"),
      ).length,
    0,
  );
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

async function browserMainProcess(
  service: BrowserService = "browser-one",
): Promise<HostProcess> {
  await ensureProcessObserver();
  const processes = await browserProcesses(service);
  const candidates = processes.filter(
    (candidate) =>
      /(?:chrom(?:e|ium))/iu.test(candidate.command) &&
      !candidate.command.includes("--type=") &&
      !candidate.command.includes("chrome_crashpad_handler"),
  );
  assert.equal(candidates.length, 1, `${service} 应恰有一个 Chromium 主进程。`);
  const candidate = candidates[0]!;
  const pid = Number(candidate.pid);
  assert.ok(
    Number.isInteger(pid) && pid > 0,
    `无效的 Chromium PID：${candidate.command}`,
  );
  const startTime = await daemonProcessIdentity(pid);
  assert.ok(
    startTime !== undefined,
    `无法在 Docker daemon 的 PID namespace 读取 Chromium 进程 ${String(pid)} 身份。`,
  );
  return { pid, startTime };
}

async function assertVncStopped(
  service: BrowserService = "browser-one",
): Promise<void> {
  const processes = await browserProcesses(service);
  assert.equal(
    processes.some((process) => /\bx11vnc\b/u.test(process.command)),
    false,
    `人工会话关闭后 ${service} 仍有 x11vnc 进程。`,
  );
  const listeners = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "-e",
    'const fs = require("node:fs"); const rows = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap(file => fs.readFileSync(file, "utf8").trim().split("\\n").slice(1)); const entries = rows.map(line => line.trim().split(/\\s+/u)).filter(fields => fields[3] === "0A" && fields[1]?.endsWith(":170C")); if (entries.length > 0) process.exit(2); const leftover = fs.readdirSync("/tmp").filter((name) => /^binny-vnc-.*\\.(?:passwd|sock)$/u.test(name)); if (leftover.length > 0) { console.error(leftover.join(",")); process.exit(3); }',
  ]);
  assert.equal(listeners.code, 0, listeners.stderr);
}

async function waitForVncStopped(
  service: BrowserService = "browser-one",
): Promise<void> {
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

async function browserHostProcesses(
  service: BrowserService = "browser-one",
): Promise<HostProcess[]> {
  await ensureProcessObserver();
  const processes = await browserProcesses(service);
  const hostProcesses: HostProcess[] = [];
  for (const process of processes) {
    if (!/(?:chrom(?:e|ium)|x11vnc|Xvfb)/iu.test(process.command)) continue;
    const pid = Number(process.pid);
    const startTime = await daemonProcessIdentity(pid);
    assert.ok(
      startTime !== undefined,
      `无法在 Docker daemon 的 PID namespace 读取进程 ${String(pid)} 身份。`,
    );
    hostProcesses.push({ pid, startTime });
  }
  assert.ok(
    hostProcesses.some(({ pid }) => pid > 0),
    `没有枚举到 ${service} 的浏览器进程。`,
  );
  assert.ok(
    processes.some((process) => process.command.includes("x11vnc")) &&
      processes.some((process) => process.command.includes("Xvfb")) &&
      processes.some((process) => /chrom(?:e|ium)/iu.test(process.command)),
    `容器进程列表没有同时包含 Chromium、Xvfb 和 x11vnc：\n${JSON.stringify(processes)}`,
  );
  return hostProcesses;
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

  const [imageBuild] = await Promise.all([
    run("pnpm", [
      "--workspace-root",
      "exec",
      "turbo",
      "run",
      `${browserFixturePackage}#image:build`,
    ]),
    buildVncViewerImage(),
  ]);
  assert.equal(
    imageBuild.code,
    0,
    `Browser fixture image build failed:\n${(imageBuild.stdout + imageBuild.stderr).slice(-12_000)}`,
  );
  builtImages.add(browserImage);
  const browserBuildContextDirectory = path.join(
    testDirectory,
    "browser-image-a",
  );

  const config = await compose(["config", "--quiet"]);
  assert.equal(config.code, 0);
  composeStarted = true;
  builtImages.add(serverImage);
  await compose(["up", "--detach", "--no-deps", "--no-build", "browser-two"]);
  const candidateManifestFromImage = await runtimeManifest("browser-two");
  const browserImageUpdate = await buildBrowserImageUpdate(
    candidateManifestFromImage,
    browserBuildContextDirectory,
  );
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
  vncViewerFixture = await startVncViewer();
  serverPort = await publishedPort("server", 3000);
  sitePort = await publishedPort("browser-session-source", 8081);
  heartbeatProxyControlPort = await publishedPort(
    "browser-idle-heartbeat-proxy",
    8083,
  );
  await waitForApi();
  await waitForSource();
  await verifyBrowserRuntimePermissions("browser-one");

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
  await Promise.all([
    waitForBinRegistration("binny-browser-one", manifest),
    waitForBinRegistration("binny-browser-two", candidateManifest),
  ]);
  assert.equal(
    (await readBin("binny-browser-one")).runtimeSleep.idleTimeoutSeconds,
    300,
  );
  assert.equal(
    (await readBin("binny-browser-two")).runtimeSleep.idleTimeoutSeconds,
    300,
  );
  await Promise.all([
    configureRegisteredBin("binny-browser-one", 30),
    configureRegisteredBin("binny-browser-two", "disabled"),
  ]);
  await Promise.all([
    waitForBrowserPower("binny-browser-one", "ready"),
    waitForBrowserPower("binny-browser-two", "ready"),
  ]);
  assert.equal(await activeBrowserMainProcessCount(), 2);
  await Promise.all([
    verifyPatchrightDeploys("browser-one"),
    verifyPatchrightDeploys("browser-two"),
  ]);

  const originalConfig = (await readBin("binny-browser-one")).config;
  const invalidConfig = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli([
      "bin",
      "update",
      "binny-browser-one",
      "--config",
      JSON.stringify({ baseUrl: "not a URL" }),
    ]),
    "invalid_configuration",
  );
  assert.deepEqual(invalidConfig.path, ["config", "baseUrl"]);
  assert.deepEqual((await readBin("binny-browser-one")).config, originalConfig);

  assert.equal(
    (await updateBin("binny-browser-one", "disabled")).runtimeSleep
      .idleTimeoutSeconds,
    null,
  );
  assert.equal(
    (await updateBin("binny-browser-one", 0)).runtimeSleep.idleTimeoutSeconds,
    0,
  );
  assert.equal(
    (await updateBin("binny-browser-two", 0)).runtimeSleep.idleTimeoutSeconds,
    0,
  );
  await Promise.all([
    waitForContainerSleeping("binny-browser-one", "browser-one"),
    waitForContainerSleeping("binny-browser-two", "browser-two"),
  ]);
  assert.equal(
    (await updateBin("binny-browser-one", 30)).runtimeSleep.idleTimeoutSeconds,
    30,
  );
  assert.equal(
    (await updateBin("binny-browser-two", "disabled")).runtimeSleep
      .idleTimeoutSeconds,
    null,
  );
  assert.equal(
    (await readBin("binny-browser-one")).runtimeSleep.idleTimeoutSeconds,
    30,
  );
  assert.equal(
    (await readBin("binny-browser-two")).runtimeSleep.idleTimeoutSeconds,
    null,
  );

  const oneBindings = await browserPortBindings("browser-one");
  assert.notEqual(oneBindings["5900/tcp"], undefined);
  assert.equal(oneBindings["6000/tcp"], undefined);
  assert.equal(oneBindings["9222/tcp"], undefined);

  const concurrentFirstLaunches = await Promise.all([
    triggerRun("binny-browser-one", "check"),
    triggerRun("binny-browser-two", "check"),
  ]);
  const [firstConcurrentRun, secondConcurrentRun] = await Promise.all([
    waitForRun(
      "binny-browser-one",
      concurrentFirstLaunches[0].runId,
      (run) => run.status === "completed" || run.status === "failed",
    ),
    waitForRun(
      "binny-browser-two",
      concurrentFirstLaunches[1].runId,
      (run) => run.status === "completed" || run.status === "failed",
    ),
  ]);
  assert.equal(firstConcurrentRun.status, "completed");
  assert.equal(secondConcurrentRun.status, "completed");
  await Promise.all([
    waitForBrowserPower("binny-browser-one", "ready"),
    waitForBrowserPower("binny-browser-two", "ready"),
  ]);
  const concurrentBrowserSamples = [await activeBrowserMainProcessCount()];
  assert.equal(
    concurrentBrowserSamples.at(-1),
    2,
    "Two independent browser bins must be able to start and stay ready concurrently.",
  );

  await compose(["restart", "server"]);
  await waitForApi();
  serverPort = await publishedPort("server", 3000);
  await Promise.all([
    waitForRuntime("binny-browser-one"),
    waitForRuntime("binny-browser-two"),
  ]);
  await Promise.all([
    waitForBrowserPower("binny-browser-one", "ready"),
    waitForBrowserPower("binny-browser-two", "ready"),
  ]);
  concurrentBrowserSamples.push(await activeBrowserMainProcessCount());
  assert.equal(concurrentBrowserSamples.at(-1), 2);

  await Promise.all([
    updateBin("binny-browser-one", 0),
    updateBin("binny-browser-two", 0),
  ]);
  await Promise.all([
    waitForContainerSleeping("binny-browser-one", "browser-one"),
    waitForContainerSleeping("binny-browser-two", "browser-two"),
  ]);
  await Promise.all([
    waitForBrowserProcessesStopped("browser-one"),
    waitForBrowserProcessesStopped("browser-two"),
  ]);
  concurrentBrowserSamples.push(await activeBrowserMainProcessCount());
  assert.equal(concurrentBrowserSamples.at(-1), 0);
  await updateBin("binny-browser-one", 30);
  await updateBin("binny-browser-two", "disabled");
  process.stdout.write(
    `Cross-bin independent browser concurrency and server restart: ${JSON.stringify(
      {
        observedBrowserProcessCounts: concurrentBrowserSamples,
        bothBinsReadyAcrossServerRestart: true,
        releasedAfterRealExit: true,
      },
    )}\n`,
  );

  await armHumanOpenResponseGate("binny-browser-one");
  const lostOpenSession = await startHumanSession("binny-browser-one");
  await waitForHumanOpenResponseGate();
  assert.equal(
    (
      await waitForHuman(
        "binny-browser-one",
        lostOpenSession.sessionId,
        "opening",
      )
    ).status,
    "opening",
  );
  const runDuringLostOpen = await triggerRun("binny-browser-two", "check");
  const concurrentDuringLostOpen = await waitForRun(
    "binny-browser-two",
    runDuringLostOpen.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(concurrentDuringLostOpen.status, "completed");
  await waitForBrowserPower("binny-browser-two", "ready");
  const lostOpenBrowserSamples = [await activeBrowserMainProcessCount()];
  assert.equal(lostOpenBrowserSamples.at(-1), 2);

  const lostOpenCloseRequest = await requestHumanSessionClose(
    "binny-browser-one",
    lostOpenSession.sessionId,
  );
  assert.equal(lostOpenCloseRequest.status, "closing");
  await waitForHeldHeartbeatClientClosed();
  await releaseHeartbeatGate();
  assert.equal(
    (
      await waitForHuman(
        "binny-browser-one",
        lostOpenSession.sessionId,
        "closed",
      )
    ).status,
    "closed",
  );
  await updateBin("binny-browser-two", 0);
  await waitForContainerSleeping("binny-browser-two", "browser-two");
  await waitForBrowserProcessesStopped("browser-two");
  lostOpenBrowserSamples.push(await activeBrowserMainProcessCount());
  assert.equal(lostOpenBrowserSamples.at(-1), 1);
  await updateBin("binny-browser-two", "disabled");
  process.stdout.write(
    `人工 open 回包丢失实测：${JSON.stringify({
      closedSession: lostOpenSession.sessionId,
      browserProcessCounts: lostOpenBrowserSamples,
      independentBinCompletedDuringHeldOpen:
        concurrentDuringLostOpen.status === "completed",
    })}\n`,
  );

  const initialCheck = await triggerRun("binny-browser-one", "check");
  const initialResult = await waitForRun(
    "binny-browser-one",
    initialCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(initialResult.status, "completed");
  assert.equal(initialResult.result?.output?.availability, "unavailable");
  assert.equal(initialResult.result?.output?.problems[0]?.requiresHuman, true);

  await waitForBrowserPower("binny-browser-one", "ready");
  const readyBinText = await cli([
    "bin",
    "get",
    "binny-browser-one",
    "--output",
    "text",
  ]);
  assert.equal(readyBinText.code, 0, readyBinText.stderr);
  assert.match(readyBinText.stdout, /^Runtime connection: online$/mu);
  assert.match(readyBinText.stdout, /^Browser: ready$/mu);
  const initialBrowserProcess = await browserMainProcess("browser-one");
  await updateBin("binny-browser-one", "disabled");
  await updateBin("binny-browser-one", 12);
  await delay(1_500);
  await updateBin("binny-browser-one", "disabled");
  await delay(12_000);
  assert.equal(
    (await readBin("binny-browser-one")).execution.status,
    "online",
    "Disabling idle sleep before stopping started still triggered container sleep.",
  );
  assert.equal(
    (await browserRuntimeContainerInfo("browser-one")).status,
    "running",
  );
  await updateBin("binny-browser-one", 4);
  const { bin: sleepingBin, container: sleepingContainer } =
    await waitForContainerSleeping("binny-browser-one", "browser-one");
  assert.equal(sleepingBin.execution.status, "sleeping");
  assert.equal(sleepingContainer.status, "exited");
  const sleepingBinText = await cli([
    "bin",
    "get",
    "binny-browser-one",
    "--output",
    "text",
  ]);
  assert.equal(sleepingBinText.code, 0, sleepingBinText.stderr);
  assert.match(
    sleepingBinText.stdout,
    /^Runtime connection: sleeping \(idle_policy\)$/mu,
  );
  await waitForBrowserProcessesStopped("browser-one");
  assert.equal(await activeBrowserMainProcessCount("browser-one"), 0);
  process.stdout.write(
    `Container sleep measurement: ${JSON.stringify({
      browserHostPid: initialBrowserProcess.pid,
      browserStartTime: initialBrowserProcess.startTime,
      sleepingContainerStatus: sleepingContainer.status,
      sleepingExitCode: sleepingContainer.exitCode,
    })}\n`,
  );

  assert.ok(vncViewerFixture !== undefined);
  const vncViewer = vncViewerFixture;
  const loginOpen = await openHumanSessionStream("binny-browser-one");
  assert.ok(
    loginOpen.waiting.some(
      ({ queueReason }) =>
        queueReason === "runtime_sleeping" || queueReason === "runtime_waking",
    ),
    `Expected sleep-wake waiting reason, got: ${JSON.stringify(loginOpen.waiting)}`,
  );
  const readyLogin = loginOpen.ready;
  const publishedPortOne = await publishedVncHostPort("browser-one");
  assert.equal(readyLogin.port, publishedPortOne);
  const httpReadyLogin = await getHumanSessionHttp(
    "binny-browser-one",
    readyLogin.sessionId,
  );
  assert.equal(httpReadyLogin.status, "ready");
  assert.equal(httpReadyLogin.port, publishedPortOne);
  assert.ok(serverPort !== undefined);
  for (const legacyPath of [
    `/human-sessions/${readyLogin.sessionId}`,
    "/human-viewer.js",
  ]) {
    const legacyResponse: Response = await fetch(
      `http://${publishedHost}:${String(serverPort)}${legacyPath}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(
      legacyResponse.status,
      404,
      `Legacy noVNC endpoint ${legacyPath} should return 404.`,
    );
  }
  const humanWakeProcess = await browserMainProcess("browser-one");
  assert.notEqual(
    humanWakeProcess.startTime,
    initialBrowserProcess.startTime,
    "Human session did not wake container and start a new browser process.",
  );
  const loginViewer = await vncViewer.connect({
    host: readyLogin.host,
    port: readyLogin.port,
    password: readyLogin.password,
  });
  const loginConnectedAt = Date.now();
  await vncViewer.expectRejectedConnection({
    host: readyLogin.host,
    port: readyLogin.port,
    password: wrongVncPassword(readyLogin.password),
  });
  await vncViewer.expectRejectedConnection({
    host: readyLogin.host,
    port: readyLogin.port,
    password: readyLogin.password,
    shared: false,
  });
  await vncViewer.expectRejectedConnection({
    host: readyLogin.host,
    port: readyLogin.port,
    password: readyLogin.password,
    shared: true,
  });
  assert.equal(
    await loginViewer.isAlive(),
    true,
    "Primary TigerVNC viewer disconnected after rejected clients.",
  );
  await enterLoginThroughVnc(loginViewer, 3_600, 0);

  // Stay connected past 2 * BINNY_HUMAN_SESSION_VIEWER_WAIT_MS (20s) to prove
  // connected sessions are not subject to the first-connect expiry timer.
  const remainingExtendedMs = 21_000 - (Date.now() - loginConnectedAt);
  if (remainingExtendedMs > 0) await delay(remainingExtendedMs);
  assert.equal(
    cliData<HumanSessionStatus>(
      await cli(["human", "get", "binny-browser-one", readyLogin.sessionId]),
      "found",
    ).status,
    "ready",
    "Connected TigerVNC session expired after exceeding 2 * viewerWaitMs.",
  );
  assert.equal(
    (await readBin("binny-browser-one")).execution.status,
    "online",
    "Container sleep stopped browser during an active human session.",
  );
  assert.equal(
    (await readBin("binny-browser-one")).execution.environment?.browser?.power
      ?.status,
    "ready",
  );

  // Interact on the desktop after exceeding 2 * viewerWaitMs and open a gated
  // page so we can verify SIGKILL tears down x11vnc and unloads human tabs.
  const sigkillPageGateId = randomUUID();
  const sigkillPageGate = await createGate(sigkillPageGateId);
  await loginViewer.navigateTo(
    `http://browser-session-source:8081/protected?gate=${sigkillPageGateId}`,
  );
  await waitForGateStarted(sigkillPageGateId, sigkillPageGate);
  const sigkillQueuedRun = await triggerRun("binny-browser-one", "collect");
  assert.equal(sigkillQueuedRun.status, "queued");
  assert.equal(sigkillQueuedRun.queueReason, "human_session_active");

  await loginViewer.killForce();
  const sigkillClosed = await waitForHuman(
    "binny-browser-one",
    readyLogin.sessionId,
    "closed",
  );
  assert.equal(sigkillClosed.status, "closed");
  await assertVncStopped("browser-one");
  await waitForGateUnload(sigkillPageGateId, sigkillPageGate);
  await vncViewer.expectRejectedConnection({
    host: readyLogin.host,
    port: readyLogin.port,
    password: readyLogin.password,
  });
  const sigkillRunDone = await waitForRun(
    "binny-browser-one",
    sigkillQueuedRun.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(sigkillRunDone.status, "completed");
  assert.ok((sigkillRunDone.result?.commits.length ?? 0) > 0);
  assert.ok(readyLogin.readyAt !== undefined);
  await waitForContainerSleeping("binny-browser-one", "browser-one");
  await waitForBrowserProcessesStopped("browser-one");
  assert.deepEqual(await zombieBrowserProcesses("browser-one"), []);

  const persistedCheck = await triggerRun("binny-browser-one", "check");
  const persistedCheckResult = await waitForRun(
    "binny-browser-one",
    persistedCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(persistedCheckResult.status, "completed");
  assert.equal(persistedCheckResult.result?.output?.availability, "available");
  assert.equal(persistedCheckResult.result?.commits.length, 0);
  const checkWakeProcess = await browserMainProcess("browser-one");
  assert.notEqual(
    checkWakeProcess.startTime,
    humanWakeProcess.startTime,
    "check did not wake container and restart browser.",
  );

  // Verify explicit human close disconnects an online viewer, unloads human
  // pages, and invalidates the previous password even when reusing the same host port.
  await updateBin("binny-browser-one", 30);
  const reuseContainerBefore = await browserRuntimeContainerInfo("browser-one");
  const reuseSessionA = (await openHumanSessionStream("binny-browser-one"))
    .ready;
  const viewerA = await vncViewer.connect({
    host: reuseSessionA.host,
    port: reuseSessionA.port,
    password: reuseSessionA.password,
  });
  const closePageGateId = randomUUID();
  const closePageGate = await createGate(closePageGateId);
  await viewerA.navigateTo(
    `http://browser-session-source:8081/protected?gate=${closePageGateId}`,
  );
  await waitForGateStarted(closePageGateId, closePageGate);
  const closeQueuedRun = await triggerRun("binny-browser-one", "collect");
  assert.equal(closeQueuedRun.status, "queued");
  assert.equal(closeQueuedRun.queueReason, "human_session_active");

  await closeHumanSession("binny-browser-one", reuseSessionA.sessionId);
  const viewerAExited = await viewerA.waitForExit();
  assert.equal(
    viewerAExited.exited,
    true,
    `TigerVNC viewer stayed running after explicit human close:\n${viewerAExited.log}`,
  );
  await viewerA.closeGracefully();
  await waitForGateUnload(closePageGateId, closePageGate);
  await assertVncStopped("browser-one");
  const closeRunDone = await waitForRun(
    "binny-browser-one",
    closeQueuedRun.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(closeRunDone.status, "completed");
  assert.ok((closeRunDone.result?.commits.length ?? 0) > 0);

  const reuseContainerAfterA = await browserRuntimeContainerInfo("browser-one");
  assert.equal(reuseContainerAfterA.id, reuseContainerBefore.id);
  assert.equal(reuseContainerAfterA.startedAt, reuseContainerBefore.startedAt);

  const reuseSessionB = (await openHumanSessionStream("binny-browser-one"))
    .ready;
  assert.equal(
    reuseSessionB.port,
    reuseSessionA.port,
    "Expected same running container to reuse identical host-mapped VNC port.",
  );
  assert.notEqual(reuseSessionB.password, reuseSessionA.password);
  await vncViewer.expectRejectedConnection({
    host: reuseSessionB.host,
    port: reuseSessionB.port,
    password: reuseSessionA.password,
  });
  const viewerB = await vncViewer.connect({
    host: reuseSessionB.host,
    port: reuseSessionB.port,
    password: reuseSessionB.password,
  });
  assert.equal(await viewerB.isAlive(), true);
  await closeHumanSession("binny-browser-one", reuseSessionB.sessionId);
  const viewerBExited = await viewerB.waitForExit();
  assert.equal(viewerBExited.exited, true);
  await viewerB.closeGracefully();
  await assertVncStopped("browser-one");
  await updateBin("binny-browser-one", 4);

  const adjacentCollect = await triggerRun("binny-browser-one", "collect");
  const adjacentCollectResult = await waitForRun(
    "binny-browser-one",
    adjacentCollect.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(adjacentCollectResult.status, "completed");
  assert.ok((adjacentCollectResult.result?.commits.length ?? 0) > 0);
  assert.deepEqual(await browserMainProcess("browser-one"), checkWakeProcess);
  await waitForContainerSleeping("binny-browser-one", "browser-one");
  await waitForBrowserProcessesStopped("browser-one");
  assert.deepEqual(await zombieBrowserProcesses("browser-one"), []);

  const archivedBeforeImageUpdate =
    await browserFixtureRunIds("binny-browser-one");
  assert.ok(archivedBeforeImageUpdate.size > 0);

  const versionProofSession = await startHumanSession("binny-browser-one");
  assert.equal(versionProofSession.status, "pending");
  await waitForHuman(
    "binny-browser-one",
    versionProofSession.sessionId,
    "ready",
  );
  const oldVersionRunGateId = randomUUID();
  const oldVersionRunGate = await createGate(oldVersionRunGateId);
  const queuedOldVersionRun = await triggerRun("binny-browser-one", "collect", {
    gateId: oldVersionRunGateId,
  });
  assert.equal(queuedOldVersionRun.status, "queued");
  assert.equal(queuedOldVersionRun.queueReason, "human_session_active");
  assert.equal(
    queuedOldVersionRun.sourceAdapterVersion,
    sourceAdapterVersion(browserImageUpdate.baselineManifest),
  );
  const queuedOldVersionRunBeforeUpdate = await readRun(
    "binny-browser-one",
    queuedOldVersionRun.runId,
  );
  assert.equal(queuedOldVersionRunBeforeUpdate.status, "queued");
  await refreshGate(oldVersionRunGateId, oldVersionRunGate);
  assert.equal(oldVersionRunGate.started, false);
  assert.equal(oldVersionRunGate.touches, 0);

  const browserImageB = await replaceBrowserRuntimeImage(
    browserImage,
    browserImageUpdate.candidateImageId,
    async () => {
      await requestHumanSessionClose(
        "binny-browser-one",
        versionProofSession.sessionId,
      ).catch(() => undefined);
    },
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
  const updatedBrowserBin = await waitForSourceAdapterVersion(
    "binny-browser-one",
    browserImageUpdate.candidateManifest,
  );
  assert.equal(updatedBrowserBin.bin.id, "binny-browser-one");
  await waitForRuntime("binny-browser-one");
  await waitForHuman(
    "binny-browser-one",
    versionProofSession.sessionId,
    "closed",
  );
  const failedOldVersionRun = await waitForRun(
    "binny-browser-one",
    queuedOldVersionRun.runId,
    (run) => run.status === "failed",
  );
  assert.equal(
    failedOldVersionRun.result?.error?.code,
    "source_adapter_changed_before_execution",
  );
  await refreshGate(oldVersionRunGateId, oldVersionRunGate);
  assert.equal(oldVersionRunGate.started, false);
  assert.equal(oldVersionRunGate.touches, 0);
  assert.ok(
    !(await browserFixtureRunIds("binny-browser-one")).has(
      queuedOldVersionRun.runId,
    ),
    "版本变更拒绝的旧运行不能提交归档。",
  );

  const imageUpdateCheck = await triggerRun("binny-browser-one", "check");
  const imageUpdateCheckResult = await waitForRun(
    "binny-browser-one",
    imageUpdateCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(imageUpdateCheckResult.status, "completed");
  assert.equal(
    imageUpdateCheckResult.sourceAdapterVersion,
    sourceAdapterVersion(browserImageUpdate.candidateManifest),
  );
  assert.equal(
    imageUpdateCheckResult.result?.output?.availability,
    "available",
    "浏览器镜像替换后，持久 profile 应继续保持登录状态。",
  );
  assert.equal(imageUpdateCheckResult.result?.commits.length, 0);
  assert.deepEqual(
    await browserFixtureRunIds("binny-browser-one"),
    archivedBeforeImageUpdate,
    "浏览器镜像替换不能丢失已归档资料。",
  );
  await waitForContainerSleeping("binny-browser-one", "browser-one");
  await waitForBrowserProcessesStopped("browser-one");
  assert.deepEqual(await zombieBrowserProcesses("browser-one"), []);
  process.stdout.write(
    `浏览器镜像更新实测：${JSON.stringify({
      binId: updatedBrowserBin.bin.id,
      baselineVersion: sourceAdapterVersion(
        browserImageUpdate.baselineManifest,
      ),
      candidateVersion: updatedBrowserBin.declaration.sourceAdapterVersion,
      queuedOldVersionRun: {
        runId: failedOldVersionRun.runId,
        sourceAdapterVersion: failedOldVersionRun.sourceAdapterVersion,
        status: failedOldVersionRun.status,
        errorCode: failedOldVersionRun.result?.error?.code,
        queueReason: queuedOldVersionRun.queueReason,
        sourceGateStarted: oldVersionRunGate.started,
        sourceGateTouches: oldVersionRunGate.touches,
      },
      baselineImageId: browserImageUpdate.baselineImageId,
      candidateImageId: browserImageUpdate.candidateImageId,
      oldContainerId: browserImageB.previous.id,
      oldContainerStatusAfterStop: browserImageB.stopped.status,
      newContainerId: browserImageB.current.id,
      profileVolume: browserImageB.current.ownerVolume,
      archivedFixtureIds: [...archivedBeforeImageUpdate].toSorted(),
      postUpdateCheck: imageUpdateCheckResult.result?.output?.availability,
    })}\n`,
  );

  await updateBin("binny-browser-one", 30);
  const collectWake = await triggerRun("binny-browser-one", "collect");
  const collectWakeResult = await waitForRun(
    "binny-browser-one",
    collectWake.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(collectWakeResult.status, "completed");
  assert.ok((collectWakeResult.result?.commits.length ?? 0) > 0);
  const collectWakeProcess = await browserMainProcess("browser-one");
  assert.notEqual(
    collectWakeProcess.startTime,
    checkWakeProcess.startTime,
    "collect did not wake container and restart browser.",
  );

  await updateBin("binny-browser-one", "disabled");
  await updateBin("binny-browser-one", 12);
  await delay(1_500);
  await updateBin("binny-browser-one", 60);
  await delay(12_000);
  assert.equal(
    (await readBin("binny-browser-one")).execution.status,
    "online",
    "Extending idle timeout before stopping started still slept browser on old deadline.",
  );
  await updateBin("binny-browser-one", 4);
  await waitForContainerSleeping("binny-browser-one", "browser-one");
  await waitForBrowserProcessesStopped("browser-one");
  assert.deepEqual(await zombieBrowserProcesses("browser-one"), []);
  const browserFixtureRunsBeforeSchedule =
    await browserFixtureRunIds("binny-browser-one");
  const scheduleGateId = randomUUID();
  const scheduleGate = await createGate(scheduleGateId);
  const scheduledWake = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
  }>(
    await cli([
      "schedule",
      "create",
      "binny-browser-one",
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
  await waitForBrowserPower("binny-browser-one", "ready");
  const scheduleWakeProcess = await browserMainProcess("browser-one");
  assert.notEqual(
    scheduleWakeProcess.startTime,
    collectWakeProcess.startTime,
    "已停止的浏览器没有被真实采集计划唤醒。",
  );
  const scheduleAfterDue = cliData<{ readonly nextDueAt: string }>(
    await cli([
      "schedule",
      "get",
      "binny-browser-one",
      scheduledWake.scheduleId,
    ]),
    "found",
  );
  assert.ok(Date.parse(scheduleAfterDue.nextDueAt) > Date.parse(scheduledFor));
  assert.equal(
    cliData<{ readonly enabled: boolean }>(
      await cli([
        "schedule",
        "disable",
        "binny-browser-one",
        scheduledWake.scheduleId,
      ]),
      "disabled",
    ).enabled,
    false,
  );
  await updateBin("binny-browser-one", 30);
  await delay(2_500);
  await releaseGate(scheduleGateId, scheduleGate);
  const scheduledRunDeadline = Date.now() + 120_000;
  let scheduledSourceRunId: string | undefined;
  while (Date.now() < scheduledRunDeadline) {
    const current = await browserFixtureRunIds("binny-browser-one");
    scheduledSourceRunId = [...current].find(
      (runId) => !browserFixtureRunsBeforeSchedule.has(runId),
    );
    if (scheduledSourceRunId !== undefined) break;
    await delay(250);
  }
  assert.ok(scheduledSourceRunId !== undefined, "计划采集没有提交受控资料。");
  const scheduledRun = await waitForRun(
    "binny-browser-one",
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

  // Keep browser-two warm before freezing browser-one so cross-bin verification
  // finishes well inside browser-one's 30s Docker stop grace period.
  const warmTwo = await triggerRun("binny-browser-two", "check");
  assert.equal(
    (
      await waitForRun(
        "binny-browser-two",
        warmTwo.runId,
        (run) => run.status === "completed" || run.status === "failed",
      )
    ).status,
    "completed",
  );
  const stoppingContainerBefore =
    await browserRuntimeContainerInfo("browser-one");
  const stoppingProcess = await browserMainProcess("browser-one");
  const stoppingContainerPid = await browserContainerProcessId(stoppingProcess);
  const signalBrowser = async (signal: "SIGSTOP" | "SIGCONT") => {
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
  let pendingWakePromise: Promise<Run> | undefined;
  let pendingHumanDuringStop: HumanSessionCreated | undefined;
  try {
    await updateBin("binny-browser-one", 0);
    await waitForContainerPhase("binny-browser-one", "stopping");
    pendingHumanDuringStop = await startHumanSession("binny-browser-one");
    assert.equal(pendingHumanDuringStop.status, "pending");
    assert.equal(pendingHumanDuringStop.queueReason, "runtime_sleeping");
    // Parameter validation in triggerRun awaits ensureAwakeAndRun, which waits
    // for the in-flight stop; start it concurrently while SIGSTOP holds the stop.
    pendingWakePromise = triggerRun("binny-browser-one", "collect");
    await delay(300);
    const crossBinWake = await triggerRun("binny-browser-two", "check");
    const completedCrossBinWake = await waitForRun(
      "binny-browser-two",
      crossBinWake.runId,
      (run) => run.status === "completed" || run.status === "failed",
    );
    assert.equal(completedCrossBinWake.status, "completed");
    assert.equal(
      (await readBin("binny-browser-one")).execution.phase,
      "stopping",
    );
    assert.deepEqual(
      await browserMainProcess("browser-one"),
      stoppingProcess,
      "Runtime started a second profile consumer before old container exited.",
    );
    await updateBin("binny-browser-one", 30);
  } finally {
    await signalBrowser("SIGCONT").catch(() => undefined);
  }
  await updateBin("binny-browser-two", 0);
  await waitForContainerSleeping("binny-browser-two", "browser-two");
  await waitForBrowserProcessesStopped("browser-two");
  await updateBin("binny-browser-two", "disabled");
  assert.ok(pendingWakePromise !== undefined);
  const pendingWake = await pendingWakePromise;
  assert.ok(pendingHumanDuringStop !== undefined);
  await waitForHuman(
    "binny-browser-one",
    pendingHumanDuringStop.sessionId,
    "ready",
  );
  await closeHumanSession(
    "binny-browser-one",
    pendingHumanDuringStop.sessionId,
  );
  const wakeAfterStop = await waitForRun(
    "binny-browser-one",
    pendingWake.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(wakeAfterStop.status, "completed");
  await waitForBrowserPower("binny-browser-one", "ready");
  assert.notEqual(
    (await browserRuntimeContainerInfo("browser-one")).startedAt,
    stoppingContainerBefore.startedAt,
    "Work arriving while stopping did not wait for old container exit before restarting.",
  );
  assert.notDeepEqual(
    await browserMainProcess("browser-one"),
    stoppingProcess,
    "关闭中的需求没有等旧 profile 退出后重新启动浏览器。",
  );
  await updateBin("binny-browser-one", 30);

  await updateBin("binny-browser-one", 5);
  const restartSurvived = (await openHumanSessionStream("binny-browser-one"))
    .ready;
  const restartViewer = await vncViewer.connect({
    host: restartSurvived.host,
    port: restartSurvived.port,
    password: restartSurvived.password,
  });
  const restartInitialMetrics = await sourceMetrics();
  const restartFormIndex = restartInitialMetrics.loginFormsReady;
  const restartSubmissionIndex = restartInitialMetrics.loginSubmissions.length;
  const restartProtectedIndex =
    restartInitialMetrics.authenticatedProtectedVisits.length;
  await restartViewer.navigateTo(
    "http://browser-session-source:8081/login?lifetime=3600",
  );
  await waitForLoginFormReady(restartFormIndex);
  await restartViewer.typeText("binny-browser-user", 10);
  await restartViewer.pressKey("Tab");

  const restartQueuedRun = await triggerRun("binny-browser-one", "collect");
  assert.equal(restartQueuedRun.status, "queued");
  assert.equal(restartQueuedRun.queueReason, "human_session_active");

  const restartWindowStart = Date.now();
  await compose(["restart", "server"]);
  await waitForApi();
  serverPort = await publishedPort("server", 3000);
  await waitForRuntime("binny-browser-one");
  if (Date.now() - restartWindowStart < 6_000) {
    await delay(6_000 - (Date.now() - restartWindowStart));
  }
  assert.equal(
    await restartViewer.isAlive(),
    true,
    "Active TigerVNC session disconnected during server restart.",
  );
  assert.equal(
    (await readBin("binny-browser-one")).execution.status,
    "online",
    "Browser container slept during active human session and server restart.",
  );
  assert.equal(
    (
      await waitForHuman(
        "binny-browser-one",
        restartSurvived.sessionId,
        "ready",
      )
    ).status,
    "ready",
  );
  const queuedAcrossRestart = await readRun(
    "binny-browser-one",
    restartQueuedRun.runId,
  );
  assert.equal(queuedAcrossRestart.status, "queued");
  assert.equal(queuedAcrossRestart.queueReason, "human_session_active");

  await restartViewer.typeText("browser-session", 10);
  await restartViewer.pressKey("Tab");
  await restartViewer.pressKey("Return");
  await waitForLoginSubmission(restartSubmissionIndex);
  await waitForAuthenticatedVisit(restartProtectedIndex);
  assert.equal(
    (await readRun("binny-browser-one", restartQueuedRun.runId)).status,
    "queued",
  );

  await closeHumanSession("binny-browser-one", restartSurvived.sessionId);
  const restartViewerExited = await restartViewer.waitForExit();
  assert.equal(restartViewerExited.exited, true);
  await restartViewer.closeGracefully();
  await assertVncStopped("browser-one");

  const restartUnblockedRun = await waitForRun(
    "binny-browser-one",
    restartQueuedRun.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(restartUnblockedRun.status, "completed");
  assert.ok((restartUnblockedRun.result?.commits.length ?? 0) > 0);
  await waitForContainerSleeping("binny-browser-one", "browser-one");
  await waitForBrowserProcessesStopped("browser-one");

  // Also verify idle sleep countdown with no queued run starts strictly after
  // close confirmation (even across a server restart while connected).
  await updateBin("binny-browser-one", 5);
  const restartSleepSession = (
    await openHumanSessionStream("binny-browser-one")
  ).ready;
  const restartSleepViewer = await vncViewer.connect({
    host: restartSleepSession.host,
    port: restartSleepSession.port,
    password: restartSleepSession.password,
  });
  const sleepRestartAt = Date.now();
  await compose(["restart", "server"]);
  await waitForApi();
  serverPort = await publishedPort("server", 3000);
  await waitForRuntime("binny-browser-one");
  if (Date.now() - sleepRestartAt < 6_000) {
    await delay(6_000 - (Date.now() - sleepRestartAt));
  }
  assert.equal(await restartSleepViewer.isAlive(), true);
  assert.equal((await readBin("binny-browser-one")).execution.status, "online");
  await closeHumanSession("binny-browser-one", restartSleepSession.sessionId);
  const closeConfirmedAt = Date.now();
  await restartSleepViewer.waitForExit();
  await restartSleepViewer.closeGracefully();
  await assertVncStopped("browser-one");
  await delay(2_500);
  assert.equal(
    (await readBin("binny-browser-one")).execution.status,
    "online",
    "Idle countdown started before human session close confirmation.",
  );
  await waitForContainerSleeping("binny-browser-one", "browser-one");
  assert.ok(
    Date.now() - closeConfirmedAt >= 4_500,
    "Container slept earlier than idleTimeoutSeconds after close confirmation.",
  );
  await updateBin("binny-browser-one", 30);

  const profileTwoCheck = await triggerRun("binny-browser-two", "check");
  const profileTwoCheckResult = await waitForRun(
    "binny-browser-two",
    profileTwoCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(profileTwoCheckResult.status, "completed");
  assert.equal(
    profileTwoCheckResult.result?.output?.availability,
    "unavailable",
  );
  await updateBin("binny-browser-two", 0);
  await waitForContainerSleeping("binny-browser-two", "browser-two");
  await waitForBrowserProcessesStopped("browser-two");

  await updateBin("binny-browser-one", "disabled");
  await updateBin("binny-browser-one", 10);
  const gateId = randomUUID();
  const gate = await createGate(gateId);
  const gatedRun = await triggerRun("binny-browser-one", "collect", { gateId });
  await waitForGateStarted(gateId, gate);
  await delay(300);
  await refreshGate(gateId, gate);
  await delay(11_000);
  await refreshGate(gateId, gate);
  assert.ok(gate.touches > 0, "受控页面没有保持自动阶段活动状态。");
  assert.equal(
    (await readBin("binny-browser-one")).execution.environment?.browser?.power
      ?.status,
    "ready",
    "自动运行期间空闲计时关闭了浏览器。",
  );

  const pendingSession = await startHumanSession("binny-browser-one");
  assert.equal(pendingSession.status, "pending");
  const queuedRun = await triggerRun("binny-browser-one", "check");
  const queuedRunCurrent = await readRun("binny-browser-one", queuedRun.runId);
  assert.equal(queuedRunCurrent.status, "queued");
  assert.equal(queuedRunCurrent.queueReason, "human_session_active");
  const cancelledQueued = cliData<Run>(
    await cli(["run", "cancel", "binny-browser-one", queuedRun.runId]),
    "cancellation",
  );
  assert.equal(cancelledQueued.status, "cancelled");

  await releaseGate(gateId, gate);
  const gatedResult = await waitForGateQuiet(
    gateId,
    gate,
    waitForRun(
      "binny-browser-one",
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
    "binny-browser-one",
    pendingSession.sessionId,
    "ready",
  );
  assert.ok(
    pendingReady.readyAt !== undefined &&
      new Date(pendingReady.readyAt).getTime() >=
        new Date(gatedResult.stopConfirmedAt).getTime(),
    "人工会话在原运行停止确认前进入 ready。",
  );
  await closeHumanSession("binny-browser-one", pendingSession.sessionId);
  await assertVncStopped("browser-one");
  await updateBin("binny-browser-one", 30);

  const beforeRestart = (await openHumanSessionStream("binny-browser-one"))
    .ready;
  const oldViewer = await vncViewer.connect({
    host: beforeRestart.host,
    port: beforeRestart.port,
    password: beforeRestart.password,
  });
  const originalProcesses = await browserHostProcesses("browser-one");
  const killed = await run("docker", [
    "kill",
    "--signal",
    "KILL",
    `${projectName}-browser-one-1`,
  ]);
  assert.equal(killed.code, 0, killed.stderr);
  const killedExit = await oldViewer.waitForExit();
  assert.equal(killedExit.exited, true);
  await waitForHostProcessesGone(originalProcesses);
  await oldViewer.closeGracefully();

  await compose(["rm", "--force", "--stop", "browser-one"]);
  await compose(["up", "--detach", "--no-deps", "browser-one"]);
  await waitForRuntime("binny-browser-one");
  const killedSession = await waitForHuman(
    "binny-browser-one",
    beforeRestart.sessionId,
    "failed",
  );
  assert.equal(killedSession.failure?.code, "runtime_disconnected");

  await vncViewer.expectRejectedConnection({
    host: beforeRestart.host,
    port: beforeRestart.port,
    password: beforeRestart.password,
  });

  const recreatedPort = await publishedVncHostPort("browser-one");
  assert.notEqual(recreatedPort, beforeRestart.port);
  const recreatedSession = (await openHumanSessionStream("binny-browser-one"))
    .ready;
  assert.equal(recreatedSession.port, recreatedPort);
  const recreatedViewer = await vncViewer.connect({
    host: recreatedSession.host,
    port: recreatedSession.port,
    password: recreatedSession.password,
  });
  await closeHumanSession("binny-browser-one", recreatedSession.sessionId);
  await recreatedViewer.waitForExit();
  await recreatedViewer.closeGracefully();

  const afterRestartCollect = await triggerRun("binny-browser-one", "collect");
  const afterRestartResult = await waitForRun(
    "binny-browser-one",
    afterRestartCollect.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(afterRestartResult.status, "completed");
  assert.ok((afterRestartResult.result?.commits.length ?? 0) > 0);
  await updateBin("binny-browser-two", "disabled");

  const contender = await compose(
    ["up", "--detach", "--no-deps", "browser-one-contender"],
    "binny-browser,binny-browser-lock",
  );
  assert.equal(contender.code, 0);
  const contenderName = `${projectName}-browser-one-contender-1`;
  const contenderDeadline = Date.now() + 15_000;
  let contenderState = "running";
  while (
    Date.now() < contenderDeadline &&
    contenderState.startsWith("running")
  ) {
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

  const shortSession = (await openHumanSessionStream("binny-browser-two"))
    .ready;
  const shortViewer = await vncViewer.connect({
    host: shortSession.host,
    port: shortSession.port,
    password: shortSession.password,
  });
  const shortCookie = (await sourceMetrics()).loginSubmissions.length;
  await enterLoginThroughVnc(shortViewer, 10, shortCookie);
  assert.equal((await sourceMetrics()).loginSubmissions.at(-1)?.maxAge, 10);
  await closeHumanSession("binny-browser-two", shortSession.sessionId);
  await shortViewer.waitForExit();
  await shortViewer.closeGracefully();
  await delay(11_000);
  const disabledIdleBin = await readBin("binny-browser-two");
  assert.equal(disabledIdleBin.runtimeSleep.idleTimeoutSeconds, null);
  assert.equal(disabledIdleBin.execution.status, "online");
  assert.equal(
    disabledIdleBin.execution.environment?.browser?.power?.status,
    "ready",
    "Browser was still stopped automatically after disabling idle sleep.",
  );

  const expiredCheck = await triggerRun("binny-browser-two", "check");
  const expiredCheckResult = await waitForRun(
    "binny-browser-two",
    expiredCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(expiredCheckResult.status, "completed");
  assert.equal(expiredCheckResult.result?.output?.availability, "unavailable");
  assert.equal(
    expiredCheckResult.result?.output?.problems[0]?.requiresHuman,
    true,
  );

  const expiredCollect = await triggerRun("binny-browser-two", "collect");
  const expiredCollectResult = await waitForRun(
    "binny-browser-two",
    expiredCollect.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(expiredCollectResult.status, "failed");
  assert.equal(expiredCollectResult.result?.error?.code, "login_required");
  assert.equal(expiredCollectResult.result?.error?.requiresHuman, true);

  await updateBin("binny-browser-one", 0);
  await waitForContainerSleeping("binny-browser-one", "browser-one");
  await waitForBrowserProcessesStopped("browser-one");
  assert.deepEqual(await zombieBrowserProcesses("browser-one"), []);
  await updateBin("binny-browser-one", 30);
  await waitForBrowserPower("binny-browser-two", "ready");
  const browserConcurrencySamples: number[] = [
    await activeBrowserMainProcessCount(),
  ];
  assert.equal(browserConcurrencySamples.at(-1), 1);

  const [activeHumanOne, activeHumanTwo] = await Promise.all([
    openHumanSessionStream("binny-browser-one"),
    openHumanSessionStream("binny-browser-two"),
  ]);
  const [viewerOne, viewerTwo] = await Promise.all([
    vncViewer.connect({
      host: activeHumanOne.ready.host,
      port: activeHumanOne.ready.port,
      password: activeHumanOne.ready.password,
    }),
    vncViewer.connect({
      host: activeHumanTwo.ready.host,
      port: activeHumanTwo.ready.port,
      password: activeHumanTwo.ready.password,
    }),
  ]);
  assert.equal(await viewerOne.isAlive(), true);
  assert.equal(await viewerTwo.isAlive(), true);
  await closeHumanSession("binny-browser-two", activeHumanTwo.ready.sessionId);
  await viewerTwo.waitForExit();
  await viewerTwo.closeGracefully();
  assert.equal(
    await viewerOne.isAlive(),
    true,
    "Closing second bin's VNC viewer disrupted first bin's VNC viewer.",
  );
  await waitForBrowserPower("binny-browser-one", "ready");
  await waitForBrowserPower("binny-browser-two", "ready");
  browserConcurrencySamples.push(await activeBrowserMainProcessCount());
  assert.equal(
    browserConcurrencySamples.at(-1),
    2,
    "Two independent browser bins must remain ready concurrently.",
  );

  // Same-bin run must still wait behind active human session on binny-browser-one,
  // while binny-browser-two executes concurrently without blocking.
  const waitingCollect = await triggerRun("binny-browser-one", "collect");
  assert.equal(waitingCollect.status, "queued");
  assert.equal(waitingCollect.queueReason, "human_session_active");
  const concurrentCheckTwo = await triggerRun("binny-browser-two", "check");
  const concurrentCheckTwoResult = await waitForRun(
    "binny-browser-two",
    concurrentCheckTwo.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(concurrentCheckTwoResult.status, "completed");
  assert.equal(
    (await readRun("binny-browser-one", waitingCollect.runId)).queueReason,
    "human_session_active",
  );

  await closeHumanSession("binny-browser-one", activeHumanOne.ready.sessionId);
  await viewerOne.waitForExit();
  await viewerOne.closeGracefully();
  const unblockedCollectResult = await waitForRun(
    "binny-browser-one",
    waitingCollect.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(unblockedCollectResult.status, "completed");
  assert.ok((unblockedCollectResult.result?.commits.length ?? 0) > 0);
  browserConcurrencySamples.push(await activeBrowserMainProcessCount());
  assert.equal(browserConcurrencySamples.at(-1), 2);

  // Verify independent queue & first-connect timers plus pending revocation.
  await updateBin("binny-browser-one", "disabled");
  const cancelPendingGateId = randomUUID();
  const cancelPendingGate = await createGate(cancelPendingGateId);
  const cancelPendingRun = await triggerRun("binny-browser-one", "collect", {
    gateId: cancelPendingGateId,
  });
  await waitForGateStarted(cancelPendingGateId, cancelPendingGate);
  const revokedPending = await startHumanSession("binny-browser-one");
  assert.equal(revokedPending.status, "pending");
  assert.equal(revokedPending.queueReason, "bin_busy");
  const revokedResult = await requestHumanSessionClose(
    "binny-browser-one",
    revokedPending.sessionId,
  );
  assert.equal(revokedResult.status, "closed");
  await releaseGate(cancelPendingGateId, cancelPendingGate);
  const cancelPendingRunDone = await waitForRun(
    "binny-browser-one",
    cancelPendingRun.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(cancelPendingRunDone.status, "completed");

  const queueTimeoutGateId = randomUUID();
  const queueTimeoutGate = await createGate(queueTimeoutGateId);
  const queueTimeoutRun = await triggerRun("binny-browser-one", "collect", {
    gateId: queueTimeoutGateId,
  });
  await waitForGateStarted(queueTimeoutGateId, queueTimeoutGate);
  const timedOutOpenPromise = cli([
    "human",
    "open",
    "binny-browser-one",
    "--url",
    `http://${publishedHost}:${String(serverPort)}`,
  ]);
  const timedOutOpenResult = await timedOutOpenPromise;
  assert.equal(
    timedOutOpenResult.code,
    1,
    `Expected queue timeout failure, got:\n${timedOutOpenResult.stdout}`,
  );
  assert.match(timedOutOpenResult.stderr, /human_session_closed/u);
  await refreshGate(queueTimeoutGateId, queueTimeoutGate);
  assert.equal(queueTimeoutGate.released, false);
  await releaseGate(queueTimeoutGateId, queueTimeoutGate);
  const queueTimeoutRunDone = await waitForRun(
    "binny-browser-one",
    queueTimeoutRun.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(queueTimeoutRunDone.status, "completed");

  const independentTimerGateId = randomUUID();
  const independentTimerGate = await createGate(independentTimerGateId);
  const independentTimerRun = await triggerRun("binny-browser-one", "collect", {
    gateId: independentTimerGateId,
  });
  await waitForGateStarted(independentTimerGateId, independentTimerGate);
  const delayedOpenPromise = cli([
    "human",
    "open",
    "binny-browser-one",
    "--url",
    `http://${publishedHost}:${String(serverPort)}`,
  ]);
  await delay(5_000);
  await releaseGate(independentTimerGateId, independentTimerGate);
  const independentOpen = parseHumanOpenStream(await delayedOpenPromise);
  assert.ok(
    independentOpen.waiting.some(
      ({ queueReason }) => queueReason === "bin_busy",
    ),
  );
  const independentRunDone = await waitForRun(
    "binny-browser-one",
    independentTimerRun.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(independentRunDone.status, "completed");
  // Wait 6s after ready (>11s since requestedAt, yet <10s since x11vnc ready).
  await delay(6_000);
  const stillReady = cliData<HumanSessionStatus>(
    await cli([
      "human",
      "get",
      "binny-browser-one",
      independentOpen.ready.sessionId,
    ]),
    "found",
  );
  assert.equal(
    stillReady.status,
    "ready",
    "First-connect timer did not start independently after queue wait.",
  );
  const idleExpired = await waitForHuman(
    "binny-browser-one",
    independentOpen.ready.sessionId,
    "closed",
    30_000,
  );
  assert.equal(idleExpired.status, "closed");
  await waitForVncStopped("browser-one");
  await vncViewer.expectRejectedConnection({
    host: independentOpen.ready.host,
    port: independentOpen.ready.port,
    password: independentOpen.ready.password,
  });
  const postExpireCheck = await triggerRun("binny-browser-one", "check");
  const postExpireCheckDone = await waitForRun(
    "binny-browser-one",
    postExpireCheck.runId,
    (run) => run.status === "completed" || run.status === "failed",
  );
  assert.equal(postExpireCheckDone.status, "completed");
  await updateBin("binny-browser-one", 30);

  await Promise.all([
    updateBin("binny-browser-one", 0),
    updateBin("binny-browser-two", 0),
  ]);
  await Promise.all([
    waitForContainerSleeping("binny-browser-one", "browser-one"),
    waitForContainerSleeping("binny-browser-two", "browser-two"),
  ]);
  await Promise.all([
    waitForBrowserProcessesStopped("browser-one"),
    waitForBrowserProcessesStopped("browser-two"),
  ]);
  assert.deepEqual(await zombieBrowserProcesses("browser-one"), []);
  assert.deepEqual(await zombieBrowserProcesses("browser-two"), []);
  browserConcurrencySamples.push(await activeBrowserMainProcessCount());
  assert.equal(browserConcurrencySamples.at(-1), 0);
  process.stdout.write(
    `Dual-bin independent browsers: ${JSON.stringify({
      observedBrowserProcessCounts: browserConcurrencySamples,
      sameBinRunQueueReason: waitingCollect.queueReason,
      concurrentCheckTwoStatus: concurrentCheckTwoResult.status,
      stoppedRemovalAccepted: true,
    })}\n`,
  );

  cliData<{ readonly removed: true; readonly id: string }>(
    await cli(["bin", "remove", "binny-browser-two"]),
    "removed",
  );

  const nonReusableContextDirectory = path.join(
    testDirectory,
    "browser-image-non-reusable",
  );
  const nonReusableImageId = await buildNonReusableBrowserImage(
    nonReusableContextDirectory,
  );
  await compose(["stop", "browser-two"]);
  activeBrowserImage = browserNonReusableImage;
  try {
    await compose([
      "up",
      "--detach",
      "--no-deps",
      "--force-recreate",
      "--no-build",
      "browser-two",
    ]);
    const nonReusableContainer =
      await browserRuntimeContainerInfo("browser-two");
    assert.equal(nonReusableContainer.imageId, nonReusableImageId);
    const nonReusableManifest = await runtimeManifest("browser-two");
    await waitForBinRegistration("binny-browser-two", nonReusableManifest);
    const nonReusableDefaultBin = await readBin("binny-browser-two");
    assert.equal(nonReusableDefaultBin.runtimeSleep.idleTimeoutSeconds, null);

    const configuredResidentBin = cliData<Bin>(
      await cli([
        "bin",
        "update",
        "binny-browser-two",
        "--config",
        JSON.stringify({ baseUrl: "http://browser-session-source:8081/" }),
      ]),
      "updated",
    );
    assert.equal(configuredResidentBin.runtimeSleep.idleTimeoutSeconds, null);
    await waitForRuntime("binny-browser-two");

    const rejectedCliUpdate = cliFailure<{
      readonly code: string;
      readonly message: string;
      readonly path?: readonly (string | number)[];
    }>(
      await cli([
        "bin",
        "update",
        "binny-browser-two",
        "--idle-timeout-seconds",
        "60",
      ]),
      "invalid_configuration",
    );
    assert.deepEqual(rejectedCliUpdate.path, [
      "runtimeSleep",
      "idleTimeoutSeconds",
    ]);
    assert.match(
      rejectedCliUpdate.message,
      /Test fixture marks profile non-reusable across restarts\./u,
    );

    assert.ok(serverPort !== undefined);
    const rejectedHttpUpdate = await fetch(
      `http://${publishedHost}:${String(serverPort)}/bins/binny-browser-two`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtimeSleep: { idleTimeoutSeconds: 0 },
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(rejectedHttpUpdate.status, 400);
    const rejectedHttpBody = (await rejectedHttpUpdate.json()) as {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly path?: readonly (string | number)[];
      };
    };
    assert.equal(rejectedHttpBody.error.code, "invalid_configuration");
    assert.deepEqual(rejectedHttpBody.error.path, [
      "runtimeSleep",
      "idleTimeoutSeconds",
    ]);
    assert.match(
      rejectedHttpBody.error.message,
      /Test fixture marks profile non-reusable across restarts\./u,
    );

    assert.equal(
      (await readBin("binny-browser-two")).runtimeSleep.idleTimeoutSeconds,
      null,
    );
    assert.equal(
      (await browserRuntimeContainerInfo("browser-two")).status,
      "running",
    );
    cliData<{ readonly removed: true; readonly id: string }>(
      await cli(["bin", "remove", "binny-browser-two"]),
      "removed",
    );
  } finally {
    activeBrowserImage = browserImage;
  }
}

try {
  try {
    await main();
    process.stdout.write("浏览器生命周期正式 Compose 验收通过。\n");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${composeStarted ? await diagnostics() : ""}`,
      { cause: error },
    );
  }
} finally {
  if (vncViewerFixture !== undefined)
    await vncViewerFixture.close().catch(() => undefined);
  if (processObserverStarted)
    await run("docker", ["rm", "--force", processObserver]).catch(
      () => undefined,
    );
  if (composeStarted)
    await rawCompose(
      ["down", "--volumes", "--remove-orphans"],
      "binny-browser,binny-browser-lock",
    ).catch(() => undefined);
  if (builtImages.size > 0)
    await run("docker", ["image", "rm", "--force", ...builtImages]).catch(
      () => undefined,
    );
  if (testDirectory !== undefined)
    await rm(testDirectory, { recursive: true, force: true });
}
