import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { type Browser, type Page } from "patchright-core";

import {
  closeLinuxdoHumanSession,
  loginLinuxdoUser,
  linuxdoUserJourney,
  navigateThroughLinuxdoViewer,
  openLinuxdoHumanSession,
  openLinuxdoViewer,
  startLinuxdoViewerBrowser,
  triggerLinuxdoRun,
  type LinuxdoBrowserSession,
  type LinuxdoAction,
  type LinuxdoManualRun,
  type LinuxdoViewerBrowser,
} from "./acceptance-journey.ts";

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

type ManualRun = LinuxdoManualRun;

type DiscoveredCategoryResult = {
  readonly id: number;
  readonly name: string;
  readonly parentId: number | null;
  readonly collectTarget: {
    readonly id: string;
    readonly kind: "category";
    readonly categoryId: number;
    readonly categorySlugPath: string;
  };
  readonly children: readonly DiscoveredCategoryResult[];
};

type FixtureState = {
  readonly nativeChallenge: boolean;
  readonly nativeChallengeWait: boolean;
  readonly nativeChallengeNoReload: boolean;
  readonly nativeChallengePersistent: boolean;
  readonly nativeChallengeMedia: boolean;
  readonly nativeChallengePaths: readonly string[];
  readonly nativeChallengeNavigationDelayMs: number;
  readonly nativeChallengeStatus: number;
  readonly navigationRace: boolean;
  readonly challengePage: boolean;
  readonly challengeTopic: boolean;
  readonly challengePosts: boolean;
  readonly challengeMedia: boolean;
  readonly topicVisible: boolean;
  readonly legacyTags: boolean;
  readonly targetUnavailablePage: number | null;
  readonly targetChallengePage: number | null;
  readonly targetInvalidResponsePage: number | null;
  readonly targetPaginationLoopPage: number | null;
  readonly targetInvalidPaginationUrlPage: number | null;
  readonly targetEarlyEndPage: number | null;
  readonly categoriesUnavailable: boolean;
  readonly categoriesInvalidResponse: boolean;
  readonly nativeCategoryTree: boolean;
  readonly dailyCollectionEnabled: boolean;
  readonly dailyParentIncludesChild: boolean;
  readonly dailyTopicOverlapCount: number;
  readonly postRangeEnabled: boolean;
  readonly postRangeAddAfterFirstPage: boolean;
  readonly postRangeRepeatPage: boolean;
  readonly postRangeInvalidPage: number | null;
  readonly postRangeResponseStatus: number | null;
  readonly postRangeRetryAfter: string | null;
  readonly postRangePageSize: number;
  readonly postRangeTopicRootShape: "missing-cooked" | "stream-only" | null;
  readonly postCategoryCandidateScenario: boolean;
  readonly paginationOrderMutationEnabled: boolean;
  readonly invalidCreatedAtTopicIds: readonly number[];
  readonly topicVersion: number;
  readonly replyVersion: number;
  readonly addedReply: boolean;
  readonly discoveryAddedReply: boolean;
  readonly syncScenarioStage: number;
  readonly omittedPostIds: readonly number[];
  readonly unavailableTopicIds: readonly number[];
  readonly unavailableMedia: readonly string[];
  readonly unavailableMediaStatus: number;
  readonly topicCreatedAtOverrides?: Readonly<Record<number, string>>;
  readonly siteHomeDelayMs?: number;
  readonly topicListDelayMs?: number;
  readonly mediaResponseDelayMs?: number;
  readonly rateLimitPath: string | null;
  readonly rateLimitStatus: 429 | 503;
  readonly retryAfterHeader: string;
  readonly rateLimitRemaining: number;
  readonly postRangePause: {
    readonly page: number;
    readonly milliseconds: number;
  } | null;
  readonly topicResponsePause: {
    readonly topicId: number;
    readonly milliseconds: number;
  } | null;
};

const targetDefinitions = {
  latest: { id: "latest", kind: "latest" },
  category: {
    id: "category-42",
    kind: "category",
    categoryId: 42,
    categorySlugPath: "controlled",
  },
  pinned: { id: "pinned", kind: "topic", topicId: 2401 },
} as const;

function linuxdoTargets(...ids: (keyof typeof targetDefinitions)[]) {
  return ids.map((id) => targetDefinitions[id]);
}

type LinuxdoCheckOutput = {
  readonly availability: "available" | "unavailable" | "unknown";
  readonly scope: readonly string[];
  readonly problems: readonly {
    readonly code: string;
    readonly message?: string;
    readonly requiresHuman: boolean;
    readonly suggestion?: string;
  }[];
};

function checkOutput(run: ManualRun): LinuxdoCheckOutput {
  assert.ok(run.result?.output !== undefined);
  assert.deepEqual(
    (run.result.output as Record<string, unknown>).challengeRecovery,
    { rounds: 0, elapsedMs: 0, successes: 0 },
    "无可恢复挑战的检查应返回零值恢复摘要",
  );
  return run.result.output as LinuxdoCheckOutput;
}

type ArchiveItemState = {
  readonly sourceKey: { readonly namespace: string; readonly key: string };
  readonly title: string | null;
  readonly sourcePublishedAt: {
    readonly precision: "instant" | "day" | "month" | "year";
    readonly value: string;
    readonly timeZone?: string;
  } | null;
  readonly sourceModifiedAt: {
    readonly precision: "instant" | "day" | "month" | "year";
    readonly value: string;
    readonly timeZone?: string;
  } | null;
  readonly sourceRef?: string;
  readonly extensions: Record<string, unknown>;
  readonly body?: {
    readonly html?: string;
    readonly markdown?: string;
    readonly text?: string;
    readonly searchText?: string;
  };
  readonly resources?: readonly { readonly resourceId: string }[];
  readonly capture: {
    readonly scope: Record<string, unknown>;
    readonly completeness: "complete" | "partial";
    readonly missing: readonly {
      readonly path: string;
      readonly reason: string;
    }[];
  };
};

type ArchiveItem = {
  readonly itemId: string;
  readonly sourceKey: { readonly namespace: string; readonly key: string };
  readonly views: readonly {
    readonly binId: string;
    readonly state: ArchiveItemState;
    readonly diagnostics?: readonly {
      readonly code: string;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    }[];
  }[];
  readonly revisions: readonly { readonly revisionId: string }[];
  readonly observations: readonly unknown[];
};

type ArchiveRevision = {
  readonly revisionId: string;
  readonly state: ArchiveItemState;
};

type BrowserSession = LinuxdoBrowserSession;

const composeFile = "compose.acceptance.yaml";
const clockShimSource = "scripts/binny-e2e-test-clock.ts";
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const projectName = `binny-discovery-${suffix}`;
const serverImage = `${projectName}-server:local`;
const browserImage = `${projectName}-linuxdo:local`;
const internalStep = process.env.BINNY_E2E_INTERNAL_STEP;
const publishedHost =
  process.env.BINNY_DISCOVERY_PUBLISHED_HOST ?? "172.17.0.1";
const password = `binny-discovery-${randomUUID().replaceAll("-", "")}`;
const acceptanceFocus = process.env.BINNY_LINUXDO_ACCEPTANCE_FOCUS;
assert.ok(
  acceptanceFocus === undefined || acceptanceFocus === "source-state",
  "BINNY_LINUXDO_ACCEPTANCE_FOCUS 只能是 source-state。",
);
let overlayDirectory: string | undefined;
let overlayFile: string | undefined;
let browser: Browser | undefined;
let viewerBrowser: LinuxdoViewerBrowser | undefined;
let serverPort = 0;
let sourcePort = 0;
let composeStarted = false;

function environment(): Readonly<Record<string, string>> {
  return {
    BINNY_IMAGE: serverImage,
    BINNY_LINUXDO_BIN_ID: "binny-discovery-topic",
    BINNY_LINUXDO_IMAGE: browserImage,
    BINNY_POSTGRES_PASSWORD: password,
  };
}

function run(
  command: string,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "pnpm",
      ["--workspace-root", "exec", command, ...args],
      {
        env: { ...process.env, ...environment(), ...extraEnvironment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
    "binny-linuxdo",
    "--profile",
    "linuxdo-e2e",
    "--parallel",
    "1",
  ];
  return overlayFile === undefined
    ? prefix
    : [...prefix, "--file", overlayFile];
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

async function rawCompose(args: readonly string[]): Promise<ProcessResult> {
  return await run("docker", [...composePrefix(), ...args]);
}

async function cli(
  args: readonly string[],
  serverIndex = 1,
): Promise<ProcessResult> {
  return await run("docker", [
    ...composePrefix(),
    "exec",
    "--index",
    String(serverIndex),
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

async function createOverlay(): Promise<void> {
  overlayDirectory = await mkdtemp(
    path.join(tmpdir(), "binny-discovery-compose-"),
  );
  overlayFile = path.join(overlayDirectory, "compose.network.yaml");
  const subnets = {
    api: process.env.BINNY_DISCOVERY_API_SUBNET ?? "10.253.25.0/24",
    runtime: process.env.BINNY_DISCOVERY_RUNTIME_SUBNET ?? "10.253.187.0/24",
    connections:
      process.env.BINNY_DISCOVERY_CONNECTIONS_SUBNET ?? "10.253.188.0/24",
    browser: process.env.BINNY_DISCOVERY_BROWSER_SUBNET ?? "10.253.189.0/24",
  };
  await writeFile(
    overlayFile,
    [
      "services:",
      "  postgres:",
      "    networks: !override",
      "      - default",
      "  server:",
      "    environment:",
      "      NODE_OPTIONS: --import=/var/lib/binny/test-clock/clock.ts",
      "      BINNY_TEST_CLOCK_FILE: /var/lib/binny/test-clock/offset-ms",
      "    volumes:",
      "      - discovery-test-clock:/var/lib/binny/test-clock",
      "    ports: !override",
      '      - "3000"',
      "    networks: !override",
      "      - default",
      "      - runtime",
      "      - connections",
      "  runtime-linuxdo:",
      "    stop_grace_period: 30s",
      "    environment:",
      "      NODE_OPTIONS: --import=/var/lib/binny/test-clock/clock.ts",
      "      BINNY_TEST_CLOCK_FILE: /var/lib/binny/test-clock/offset-ms",
      "    volumes:",
      "      - discovery-test-clock:/var/lib/binny/test-clock",
      "    networks: !override",
      "      - runtime",
      "      - connections",
      "      - browser",
      "  runtime-linuxdo-two:",
      "    environment:",
      "      NODE_OPTIONS: --import=/var/lib/binny/test-clock/clock.ts",
      "      BINNY_TEST_CLOCK_FILE: /var/lib/binny/test-clock/offset-ms",
      "    volumes:",
      "      - discovery-test-clock:/var/lib/binny/test-clock",
      "    networks: !override",
      "      - runtime",
      "      - connections",
      "      - browser",
      "  linuxdo-e2e-source:",
      "    ports: !override",
      '      - "8081"',
      "    networks: !override",
      "      browser:",
      "        aliases:",
      "          - linuxdo-e2e-media",
      "          - linuxdo-e2e-other",
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      `        - subnet: ${subnets.api}`,
      "  runtime:",
      "    ipam:",
      "      config:",
      `        - subnet: ${subnets.runtime}`,
      "  connections:",
      "    ipam:",
      "      config:",
      `        - subnet: ${subnets.connections}`,
      "  browser:",
      "    ipam:",
      "      config:",
      `        - subnet: ${subnets.browser}`,
      "volumes:",
      "  discovery-test-clock: {}",
      "",
    ].join("\n"),
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
      Number.isSafeInteger(port) &&
      port > 0 &&
      port <= 65_535,
    `Compose 没有为 ${service}:${String(containerPort)} 返回有效宿主端口：${mapping}`,
  );
  return port;
}

function apiUrl(): string {
  return `http://${publishedHost}:${String(serverPort)}`;
}

function sourceUrl(pathname: string): string {
  return `http://${publishedHost}:${String(sourcePort)}${pathname}`;
}

async function sourceState(): Promise<{
  readonly state: Record<string, unknown>;
  readonly events: readonly {
    readonly at: number;
    readonly action: string;
    readonly path: string;
    readonly authenticated?: boolean;
    readonly topicIds?: readonly number[];
    readonly moreTopicsUrl?: string | null;
    readonly activeMediaRequests?: number;
  }[];
}> {
  const response = await fetch(sourceUrl("/__control/state"), {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    readonly state: Record<string, unknown>;
    readonly events: readonly {
      readonly at: number;
      readonly action: string;
      readonly path: string;
      readonly authenticated?: boolean;
      readonly topicIds?: readonly number[];
      readonly moreTopicsUrl?: string | null;
      readonly activeMediaRequests?: number;
    }[];
  };
}

async function updateFixtureState(
  update: Partial<FixtureState>,
): Promise<void> {
  const response = await fetch(sourceUrl("/__control/state"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200, await response.text());
}

async function clearSourceEvents(): Promise<void> {
  const response = await fetch(sourceUrl("/__control/clear-events"), {
    method: "POST",
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 204);
}

async function waitForApi(serverIndex = 1): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError = "正式服务尚未就绪。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "list"], serverIndex);
    if (result.code === 0) return;
    lastError = result.stderr;
    await delay(500);
  }
  throw new Error(`等待正式 API、PostgreSQL 和 CLI 超时：\n${lastError}`);
}

async function setTestClockOffset(offsetMilliseconds: number): Promise<void> {
  assert.ok(Number.isSafeInteger(offsetMilliseconds));
  await compose([
    "run",
    "--rm",
    "--no-deps",
    "--no-TTY",
    "--entrypoint",
    "node",
    "--env",
    `BINNY_TEST_CLOCK_OFFSET_MS=${String(offsetMilliseconds)}`,
    "server",
    "--input-type=module",
    "-e",
    'import { writeFileSync } from "node:fs"; writeFileSync(process.env.BINNY_TEST_CLOCK_FILE, process.env.BINNY_TEST_CLOCK_OFFSET_MS ?? "0");',
  ]);
}

async function provisionClockShim(): Promise<void> {
  await compose(["build", "server", "runtime-linuxdo"]);
  await compose(["create", "server"]);
  const containerId = (
    await compose(["ps", "--all", "--quiet", "server"])
  ).stdout.trim();
  assert.ok(containerId.length > 0, "Compose 没有创建时钟 volume 容器。");
  const copied = await run("docker", [
    "cp",
    clockShimSource,
    `${containerId}:/var/lib/binny/test-clock/clock.ts`,
  ]);
  assert.equal(
    copied.code,
    0,
    `复制受检时钟 shim 到测试 volume 失败：\n${copied.stderr}`,
  );
  await compose(["rm", "--force", "server"]);
}

async function setTestClockAt(isoDate: string): Promise<void> {
  const target = Date.parse(isoDate);
  assert.ok(Number.isFinite(target));
  await setTestClockOffset(target - Date.now());
}

async function readContainerTime(service: string): Promise<string> {
  const result = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "-e",
    "process.stdout.write(new Date().toISOString())",
  ]);
  return result.stdout.trim();
}

async function waitForRuntimeHealth(
  service = "runtime-linuxdo",
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "正式浏览器运行器尚未就绪。";
  while (Date.now() < deadline) {
    const result = await rawCompose([
      "exec",
      "--no-TTY",
      service,
      "node",
      "--input-type=module",
      "-e",
      'const response=await fetch("http://127.0.0.1:8080/health"); if (!response.ok) process.exit(1);',
    ]);
    if (result.code === 0) return;
    lastError = result.stderr + result.stdout;
    await delay(250);
  }
  throw new Error(`Linux.do 正式浏览器运行器没有就绪：\n${lastError}`);
}

type RuntimeManifest = {
  readonly protocolVersion: number;
  readonly sourceAdapter: Record<string, unknown>;
};

async function runtimeManifest(
  service = "runtime-linuxdo",
): Promise<RuntimeManifest> {
  await waitForRuntimeHealth(service);
  const result = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "--input-type=module",
    "-e",
    'const response=await fetch("http://127.0.0.1:8080/manifest"); if(!response.ok)process.exit(1); console.log(JSON.stringify(await response.json()));',
  ]);
  const payload = JSON.parse(result.stdout) as {
    readonly protocolVersion?: number;
    readonly sourceAdapter?: Record<string, unknown>;
  };
  assert.ok(Number.isSafeInteger(payload.protocolVersion));
  assert.ok(payload.sourceAdapter !== undefined);
  return {
    protocolVersion: payload.protocolVersion as number,
    sourceAdapter: payload.sourceAdapter,
  };
}

async function waitForBinRegistration(
  expectedManifest: Record<string, unknown>,
  binId = "binny-discovery-topic",
): Promise<void> {
  const expectedSourceAdapterId = expectedManifest.id;
  assert.equal(typeof expectedSourceAdapterId, "string");
  const deadline = Date.now() + 45_000;
  let latest = "运行器还没有完成自注册。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", binId]);
    if (result.code === 0) {
      const bin = cliData<{
        readonly id: string;
        readonly sourceAdapterId: string;
        readonly identityId: string;
        readonly config: Record<string, unknown>;
        readonly execution: {
          readonly status: string;
          readonly error?: { readonly code: string };
        };
      }>(result, "found");
      if (bin.sourceAdapterId === expectedSourceAdapterId) {
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
      latest = JSON.stringify(bin);
    } else {
      latest = result.stderr;
    }
    await delay(250);
  }
  throw new Error(`等待 Linux.do bin 自注册超时：${latest}`);
}

async function waitForRuntime(binId = "binny-discovery-topic"): Promise<void> {
  const deadline = Date.now() + 45_000;
  let latest = "运行器还没有上线。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", binId]);
    if (result.code === 0) {
      const bin = cliData<{
        readonly execution: { readonly status: string };
      }>(result, "found");
      if (bin.execution.status === "online") return;
      latest = JSON.stringify(bin.execution);
    } else {
      latest = result.stderr;
    }
    await delay(250);
  }
  throw new Error(`等待 Linux.do 运行器上线超时：${latest}`);
}

async function trigger(
  action: LinuxdoAction,
  params: Readonly<Record<string, unknown>>,
  timeoutMs?: number,
): Promise<ManualRun> {
  const actionParams =
    action === "collect" && !("postCreatedRange" in params)
      ? { date: "2026-10-28", timeZone: "UTC", ...params }
      : params;
  return await triggerLinuxdoRun(
    cli,
    "binny-discovery-topic",
    action,
    actionParams,
    timeoutMs,
  );
}

async function startOuterBrowser(): Promise<Browser> {
  viewerBrowser = await startLinuxdoViewerBrowser({
    projectName,
    image: browserImage,
    publishedHost,
    run,
  });
  return viewerBrowser.browser;
}

async function openViewer(session: BrowserSession): Promise<Page> {
  assert.ok(browser !== undefined);
  return await openLinuxdoViewer(browser, session, publishedHost, serverPort);
}

async function navigateThroughViewer(page: Page, url: string): Promise<void> {
  await navigateThroughLinuxdoViewer(page, url);
}

async function openHumanSession(): Promise<BrowserSession> {
  return await openLinuxdoHumanSession(cli, "binny-discovery-topic");
}

async function closeHumanSession(sessionId: string): Promise<void> {
  await closeLinuxdoHumanSession(cli, "binny-discovery-topic", sessionId);
}

async function searchArchiveItem(text: string): Promise<ArchiveItem> {
  const query = {
    scope: { kind: "current", binId: "binny-discovery-topic" },
    text: { kind: "literal", value: text },
    select: ["sourceKey", "sourceRef", "capture.completeness"],
    limit: 10,
  };
  const page = cliData<{
    readonly results: readonly { readonly itemId: string }[];
  }>(
    await cli(["archive", "search", "--query", JSON.stringify(query)]),
    "found",
  );
  assert.equal(page.results.length, 1, `应只命中一条正文「${text}」。`);
  const result = page.results[0];
  assert.ok(result !== undefined);
  return cliData<ArchiveItem>(
    await cli([
      "archive",
      "item",
      result.itemId,
      "--bin",
      "binny-discovery-topic",
    ]),
    "found",
  );
}

async function searchArchiveSourceKeys(text: string): Promise<string[]> {
  const query = {
    scope: { kind: "current", binId: "binny-discovery-topic" },
    text: { kind: "literal", value: text },
    select: ["sourceKey"],
    orderBy: [{ field: "sourceKey.key", direction: "asc" }],
    limit: 100,
  };
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = cliData<{
      readonly results: readonly {
        readonly sourceKey?: { readonly key: string };
      }[];
      readonly nextCursor?: string;
    }>(
      await cli([
        "archive",
        "search",
        "--query",
        JSON.stringify(cursor === undefined ? query : { ...query, cursor }),
      ]),
      "found",
    );
    keys.push(
      ...page.results.flatMap(({ sourceKey }) =>
        sourceKey === undefined ? [] : [sourceKey.key],
      ),
    );
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return keys;
}

async function readArchiveItem(itemId: string): Promise<ArchiveItem> {
  return cliData<ArchiveItem>(
    await cli(["archive", "item", itemId, "--bin", "binny-discovery-topic"]),
    "found",
  );
}

async function readArchiveRevision(
  revisionId: string,
): Promise<ArchiveRevision> {
  return cliData<ArchiveRevision>(
    await cli(["archive", "revision", revisionId]),
    "found",
  );
}

function binState(item: ArchiveItem): ArchiveItemState {
  const view = item.views.find(
    ({ binId }) => binId === "binny-discovery-topic",
  );
  assert.ok(view !== undefined, "归档条目缺少当前 bin 视图。");
  return view.state;
}

async function readOutgoingRelations(itemId: string): Promise<
  readonly {
    readonly status: string;
    readonly state?: {
      readonly name: string;
      readonly cascade: boolean;
      readonly to: { readonly sourceKey?: { readonly key: string } };
    };
  }[]
> {
  const page = cliData<{
    readonly relations: readonly {
      readonly status: string;
      readonly state?: {
        readonly name: string;
        readonly cascade: boolean;
        readonly to: { readonly sourceKey?: { readonly key: string } };
      };
    }[];
  }>(
    await cli([
      "archive",
      "relations",
      itemId,
      "--bin",
      "binny-discovery-topic",
      "--direction",
      "outgoing",
    ]),
    "found",
  );
  return page.relations;
}

async function assertStoredResource(resourceId: string): Promise<{
  readonly contentType: string;
  readonly bytes: Uint8Array;
}> {
  const response = await fetch(`${apiUrl()}/resources/${resourceId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  assert.ok(
    contentType === "image/png" ||
      contentType === "application/pdf" ||
      contentType === "application/json",
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 0);
  return { contentType, bytes };
}

async function waitForSourceEvent(
  action: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let latestCount = 0;
  while (Date.now() < deadline) {
    const current = await sourceState();
    latestCount = current.events.filter(
      (event) => event.action === action,
    ).length;
    if (latestCount >= count) return;
    await delay(50);
  }
  assert.fail(
    `受控信源没有记录 ${action}：期望 ${count} 次，实际 ${latestCount} 次。`,
  );
}

async function diagnostics(): Promise<string> {
  const [services, logs] = await Promise.all([
    rawCompose(["ps", "--all"]),
    rawCompose(["logs", "--tail", "120"]),
  ]);
  return `\nCompose 状态：\n${services.stdout}${services.stderr}\nCompose 日志：\n${(logs.stdout + logs.stderr).slice(-18_000)}`;
}

async function verifyLoginRequired(): Promise<
  Awaited<ReturnType<typeof linuxdoUserJourney>>
> {
  assert.ok(browser !== undefined);
  return await linuxdoUserJourney({
    binId: "binny-discovery-topic",
    topicId: 2401,
    cli,
    browser,
    publishedHost,
    serverPort,
    sourceOrigin: "http://linuxdo-e2e-source:8081",
    sourceControlUrl: sourceUrl("/__control/state"),
    username: "binny-discovery-user",
    password: "linuxdo-fixture",
  });
}

async function ensureAuthenticatedLinuxdoUser(): Promise<void> {
  const check = await trigger("check", { topicId: 2401 });
  assert.equal(check.status, "completed", JSON.stringify(check));
  if (checkOutput(check).availability === "unavailable") {
    assert.ok(browser !== undefined);
    await loginLinuxdoUser({
      binId: "binny-discovery-topic",
      cli,
      browser,
      publishedHost,
      serverPort,
      sourceOrigin: "http://linuxdo-e2e-source:8081",
      sourceControlUrl: sourceUrl("/__control/state"),
      username: "binny-discovery-user",
      password: "linuxdo-fixture",
    });
    const authenticatedCheck = await trigger("check", { topicId: 2401 });
    assert.equal(authenticatedCheck.status, "completed");
    assert.equal(
      checkOutput(authenticatedCheck).availability,
      "available",
      JSON.stringify(authenticatedCheck),
    );
  } else {
    assert.equal(checkOutput(check).availability, "available");
  }
}

async function verifyActionParameterValidation(): Promise<void> {
  for (const [params, path] of [
    [
      {
        targets: linuxdoTargets("latest"),
        date: "2026-02-30",
        timeZone: "UTC",
      },
      ["params", "date"],
    ],
    [
      {
        targets: linuxdoTargets("latest"),
        date: "today",
        timeZone: "Mars/Phobos",
      },
      ["params", "timeZone"],
    ],
    [
      { targets: linuxdoTargets("latest"), date: "today" },
      ["params", "timeZone"],
    ],
    [
      {
        targets: linuxdoTargets("latest"),
        postCreatedRange: {
          from: "2026-11-03T12:00:00.000Z",
          to: "2026-11-03T11:00:00.000Z",
        },
      },
      ["params", "postCreatedRange", "to"],
    ],
    [
      {
        targets: linuxdoTargets("latest"),
        postCreatedRange: {
          from: "2026-11-03T11:00:00",
          to: "2026-11-03T12:00:00.000Z",
        },
      },
      ["params", "postCreatedRange", "from"],
    ],
    [
      {
        targets: linuxdoTargets("latest"),
        postCreatedRange: {
          from: "2026-11-03T11:00:00.000Z",
          to: "2026-11-03T12:00:00.000Z",
          maxPages: 0,
        },
      },
      ["params", "postCreatedRange", "maxPages"],
    ],
    [
      {
        targets: linuxdoTargets("latest"),
        date: "today",
        timeZone: "UTC",
        postCreatedRange: {
          from: "2026-11-03T11:00:00.000Z",
          to: "2026-11-03T12:00:00.000Z",
        },
      },
      ["params", "postCreatedRange"],
    ],
    [{ targets: linuxdoTargets("latest") }, ["params", "date"]],
    [
      {
        targets: linuxdoTargets("latest"),
        date: "2026-10-28",
        timeZone: "UTC",
        maxTopics: 0,
      },
      ["params", "maxTopics"],
    ],
    [
      { targets: [1], date: "today", timeZone: "UTC" },
      ["params", "targets", 0],
    ],
  ] as const) {
    const response = await fetch(
      `${apiUrl()}/bins/binny-discovery-topic/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "collect", params }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(response.status, 400);
    const payload = (await response.json()) as {
      readonly error: {
        readonly code: string;
        readonly path?: readonly (string | number)[];
      };
    };
    assert.equal(payload.error.code, "invalid_action_parameters");
    assert.deepEqual(payload.error.path, path);
  }
}

async function verifyCategoryActionDiscovery(): Promise<void> {
  const before = await sourceState();
  const configuration = cliData<{
    readonly configSchema: {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
  }>(
    await cli(["bin", "config-schema", "binny-discovery-topic"]),
    "discovered",
  );
  const origin = configuration.configSchema.properties?.origin as
    | {
        readonly description?: string;
        readonly examples?: readonly unknown[];
      }
    | undefined;
  assert.match(origin?.description ?? "", /HTTP\(S\).*origin/u);
  assert.deepEqual(origin?.examples, ["https://linux.do"]);

  const actions = cliData<{
    readonly actions: Record<string, { readonly description: string }>;
  }>(await cli(["bin", "actions", "binny-discovery-topic"]), "discovered");
  assert.ok(actions.actions["list-categories"] !== undefined);
  assert.ok(actions.actions.collect !== undefined);
  assert.ok(actions.actions.sync !== undefined);
  const readAction = async (action: string) => {
    const discovery = cliData<{
      readonly actions: Record<
        string,
        {
          readonly description: string;
          readonly params?: unknown;
          readonly output?: unknown;
          readonly report?: unknown;
        }
      >;
    }>(
      await cli(["bin", "actions", "binny-discovery-topic", action]),
      "discovered",
    );
    const declaration = discovery.actions[action];
    assert.ok(declaration !== undefined);
    return declaration;
  };
  const declaration = await readAction("list-categories");
  assert.ok(declaration.params !== undefined);
  assert.ok(declaration.output !== undefined);
  const paramsSchema = declaration.params as {
    readonly type?: string;
    readonly required?: readonly string[];
  };
  assert.equal(paramsSchema.type, "object");
  assert.deepEqual(paramsSchema.required ?? [], []);
  const outputSchema = declaration.output as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.ok(outputSchema.properties?.categories !== undefined);

  const collect = await readAction("collect");
  assert.ok(collect?.params !== undefined);
  const collectParamsSchema = collect.params as {
    readonly description?: string;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.match(collectParamsSchema.description ?? "", /date 与 timeZone 成对/u);
  assert.match(
    collectParamsSchema.description ?? "",
    /topicId 与 targets 互斥/u,
  );
  assert.match(
    collectParamsSchema.description ?? "",
    /targets 省略时使用当前可见板块/u,
  );
  const postCreatedRange = collectParamsSchema.properties?.postCreatedRange as
    | {
        readonly description?: string;
        readonly examples?: readonly unknown[];
        readonly properties?: Readonly<Record<string, unknown>>;
        readonly required?: readonly string[];
      }
    | undefined;
  assert.ok(postCreatedRange !== undefined);
  assert.deepEqual(postCreatedRange.required, ["from", "to"]);
  assert.ok(postCreatedRange.properties?.from !== undefined);
  assert.ok(postCreatedRange.properties?.to !== undefined);
  assert.match(
    (
      postCreatedRange.properties?.to as
        | { readonly description?: string }
        | undefined
    )?.description ?? "",
    /不得晚于本次动作实际开始时刻/u,
  );
  assert.equal(
    (
      postCreatedRange.properties?.maxPages as
        | { readonly default?: unknown }
        | undefined
    )?.default,
    20,
  );
  assert.match(postCreatedRange.description ?? "", /date\/timeZone/u);
  assert.deepEqual(postCreatedRange.examples, [
    {
      from: "2026-10-28T02:00:00.000Z",
      to: "2026-10-28T04:00:00.000Z",
      maxPages: 20,
    },
  ]);
  const date = collectParamsSchema.properties?.date as
    | { readonly description?: string; readonly examples?: readonly unknown[] }
    | undefined;
  assert.match(date?.description ?? "", /today|YYYY-MM-DD/u);
  assert.deepEqual(date?.examples, ["today", "2026-10-28"]);
  const timeZone = collectParamsSchema.properties?.timeZone as
    | { readonly description?: string; readonly examples?: readonly unknown[] }
    | undefined;
  assert.match(timeZone?.description ?? "", /有效 IANA 时区名称/u);
  assert.deepEqual(timeZone?.examples, ["UTC", "Asia/Tokyo"]);

  const singleAction = cliData<{
    readonly actions: Record<string, { readonly report?: unknown }>;
    readonly environment?: unknown;
    readonly execution?: unknown;
  }>(
    await cli(["bin", "actions", "binny-discovery-topic", "collect"]),
    "discovered",
  );
  assert.deepEqual(Object.keys(singleAction.actions), ["collect"]);
  assert.ok(singleAction.actions.collect?.report !== undefined);
  assert.equal(Object.hasOwn(singleAction, "environment"), false);
  assert.equal(Object.hasOwn(singleAction, "execution"), false);
  assert.deepEqual((await sourceState()).events, before.events);

  assert.ok(collect.report !== undefined, "collect 应声明可发现的运行报告。");
  const reportSchema = collect.report as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.ok(reportSchema.properties?.phase !== undefined);
  assert.ok(reportSchema.properties?.intent !== undefined);
  assert.ok(
    typeof (reportSchema.properties.phase as { readonly description?: unknown })
      .description === "string",
  );
  for (const name of ["check", "list-categories"]) {
    const action = await readAction(name);
    const report = action.report as
      | { readonly properties?: Readonly<Record<string, unknown>> }
      | undefined;
    assert.ok(report?.properties?.sourceAccess !== undefined);
  }

  const sync = await readAction("sync");
  assert.ok(sync?.params !== undefined, "动作发现应公开 sync 参数。 ");
  assert.ok(sync.output !== undefined, "动作发现应公开 sync 结果。 ");
  assert.ok(sync.report !== undefined, "sync 应声明可发现的运行报告。 ");
  assert.match(sync.description ?? "", /已有范围按接续位置从旧到新处理/u);
  assert.match(sync.description ?? "", /同一位置沿用原范围顺序/u);
  const syncParams = sync.params as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  for (const name of ["maxPages", "maxRequests", "maxElapsedMs"])
    assert.ok(syncParams.properties?.[name] !== undefined);
  const syncReport = sync.report as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.ok(syncReport.properties?.upperBound !== undefined);
  assert.ok(syncReport.properties?.budget !== undefined);
  assert.ok(syncReport.properties?.scopes !== undefined);

  const manifest = await runtimeManifest();
  assert.ok(
    manifest.sourceAdapter.stateSchema !== undefined,
    "运行器清单应通过原生 schema 公开 Linux.do 接续状态。",
  );
  assert.ok(
    manifest.sourceAdapter.stateSnapshotSchema !== undefined,
    "运行器清单应通过原生 schema 公开接续状态的可用与故障形状。",
  );
}

type SourceAccessSummary = {
  readonly admittedAttempts: number;
  readonly waitedMs: number;
  readonly bySource: { readonly site: number; readonly media: number };
  readonly rateLimitResponses: readonly {
    readonly status: 429 | 503;
    readonly outcome: "cooled" | "missing" | "invalid" | "past";
    readonly observedAt: string;
    readonly cooldownUntil?: string;
  }[];
  readonly pageRequestEventsObserved: { readonly total: number };
};

function sourceAccessSummary(run: ManualRun): SourceAccessSummary {
  assert.ok(run.report !== undefined, `运行没有保存报告：${run.runId}`);
  const summary = run.report.sourceAccess as SourceAccessSummary | undefined;
  assert.ok(
    summary !== undefined,
    `报告没有来源访问统计：${JSON.stringify(run.report)}`,
  );
  return summary;
}

async function setSourceAccessPolicy(
  minimumIntervalMs: number,
  maxConcurrency: number,
): Promise<void> {
  const config = {
    origin: "http://linuxdo-e2e-source:8081",
    sourceAccess: {
      groups: {
        linuxdo: {
          sources: ["site", "media"],
          minimumIntervalMs,
          maxConcurrency,
        },
      },
    },
  };
  cliData(
    await cli([
      "bin",
      "update",
      "binny-discovery-topic",
      "--identity",
      "binny-discovery-profile",
      "--config",
      JSON.stringify(config),
    ]),
    "updated",
  );
  await waitForRuntime();
}

async function verifySharedSourceAccess(): Promise<void> {
  const minimumIntervalMs = 1_500;
  await setSourceAccessPolicy(minimumIntervalMs, 1);
  await clearSourceEvents();
  try {
    const check = await trigger("check", { topicId: 2401 });
    assert.equal(check.status, "completed", JSON.stringify(check));
    const checkAccess = sourceAccessSummary(check);
    assert.ok(checkAccess.admittedAttempts >= 3, JSON.stringify(checkAccess));
    assert.ok(
      checkAccess.waitedMs >= minimumIntervalMs,
      JSON.stringify(checkAccess),
    );
    assert.ok(checkAccess.bySource.site >= 3, JSON.stringify(checkAccess));

    const categories = await trigger("list-categories", {});
    assert.equal(categories.status, "completed", JSON.stringify(categories));
    const categoryAccess = sourceAccessSummary(categories);
    assert.ok(categoryAccess.waitedMs > 0, JSON.stringify(categoryAccess));
    assert.ok(
      categoryAccess.bySource.site >= 3,
      JSON.stringify(categoryAccess),
    );

    const intervalEvents = (await sourceState()).events;
    const intervalActiveEvents = intervalEvents.filter(({ action }) =>
      ["site-home", "session-current", "topic", "posts", "categories"].includes(
        action,
      ),
    );
    for (let index = 1; index < intervalActiveEvents.length; index++) {
      const previous = intervalActiveEvents[index - 1]!;
      const current = intervalActiveEvents[index]!;
      assert.ok(
        current.at - previous.at >= minimumIntervalMs - 100,
        `相邻来源请求间隔不足：${previous.action} ${previous.at} -> ${current.action} ${current.at}`,
      );
    }

    await setSourceAccessPolicy(0, 1);
    await updateFixtureState({ mediaResponseDelayMs: 250 });
    const collection = await trigger("collect", { topicId: 2401 });
    assert.equal(collection.status, "completed", JSON.stringify(collection));
    const collectionAccess = sourceAccessSummary(collection);
    assert.ok(
      collectionAccess.bySource.site >= 4,
      JSON.stringify(collectionAccess),
    );
    assert.ok(
      collectionAccess.bySource.media >= 1,
      JSON.stringify(collectionAccess),
    );
    assert.ok(
      collectionAccess.pageRequestEventsObserved.total > 0,
      JSON.stringify(collectionAccess),
    );

    const mediaEvents = (await sourceState()).events.filter(
      ({ action }) => action === "media",
    );
    assert.ok(mediaEvents.length >= 3, JSON.stringify(mediaEvents));
    assert.ok(
      mediaEvents.every(({ activeMediaRequests }) => activeMediaRequests === 1),
      `主动媒体并发超过配置上限：${JSON.stringify(mediaEvents)}`,
    );
  } finally {
    await updateFixtureState({ mediaResponseDelayMs: 0 });
    await setSourceAccessPolicy(0, 1);
  }
}

async function verifyNativeCategoryTree(): Promise<void> {
  await updateFixtureState({ nativeCategoryTree: true });
  try {
    await clearSourceEvents();
    const listed = await trigger("list-categories", {});
    assert.equal(listed.status, "completed", JSON.stringify(listed));
    const output = listed.result?.output as
      | { readonly categories?: readonly DiscoveredCategoryResult[] }
      | undefined;
    assert.ok(output !== undefined);
    assert.deepEqual(
      output.categories?.map(({ id, name, parentId }) => ({
        id,
        name,
        parentId,
      })),
      [
        { id: 42, name: "受控板块", parentId: null },
        { id: 44, name: "另一可见板块", parentId: null },
      ],
    );
    const parent = output.categories?.find(({ id }) => id === 42);
    assert.ok(parent !== undefined);
    assert.deepEqual(
      parent.children.map(({ id, name, parentId }) => ({
        id,
        name,
        parentId,
      })),
      [{ id: 43, name: "可见子板块", parentId: 42 }],
    );
    const child = parent.children[0];
    assert.ok(child !== undefined);
    assert.deepEqual(
      child.children.map(({ id, name, parentId, collectTarget }) => ({
        id,
        name,
        parentId,
        collectTarget,
      })),
      [
        {
          id: 48,
          name: "可见孙板块",
          parentId: 43,
          collectTarget: {
            id: "category-48",
            kind: "category",
            categoryId: 48,
            categorySlugPath: "controlled/child/grandchild",
          },
        },
      ],
    );
    assert.deepEqual(listed.result?.commits ?? [], []);
    assert.equal((await sourceState()).events.at(-1)?.action, "categories");

    const initialized = await trigger("sync", {
      targets: [child.children[0]!.collectTarget],
      maxPages: 20,
      maxRequests: 20,
      maxElapsedMs: 30_000,
    });
    assert.equal(initialized.status, "completed", JSON.stringify(initialized));
    assert.equal(syncOutput(initialized).outcome, "initialized");
    const report = syncReport(initialized);
    assert.equal(report.discovery, "complete");
    assert.deepEqual(
      report.scopes.map(({ scope, mode, status, position }) => ({
        scope,
        mode,
        status,
        position,
      })),
      [
        {
          scope: { kind: "category", id: 48 },
          mode: "initialized",
          status: "initialized",
          position: report.upperBound,
        },
      ],
    );
  } finally {
    await updateFixtureState({ nativeCategoryTree: false });
  }
}

async function verifyCategoryDiscovery(): Promise<void> {
  await verifyNativeCategoryTree();
  const unscopedCheck = await trigger("check", {});
  assert.equal(
    unscopedCheck.status,
    "completed",
    JSON.stringify(unscopedCheck),
  );
  assert.equal(checkOutput(unscopedCheck).availability, "available");
  assert.deepEqual(checkOutput(unscopedCheck).scope, []);

  const before = await sourceState();
  const listed = await trigger("list-categories", {});
  assert.equal(listed.status, "completed", JSON.stringify(listed));
  assert.deepEqual(listed.result?.commits ?? [], []);
  const output = listed.result?.output as
    | {
        readonly categories?: readonly {
          readonly id: number;
          readonly name: string;
          readonly parentId: number | null;
          readonly collectTarget: {
            readonly id: string;
            readonly kind: "category";
            readonly categoryId: number;
            readonly categorySlugPath: string;
          };
          readonly children: readonly {
            readonly id: number;
            readonly name: string;
            readonly parentId: number | null;
            readonly collectTarget: {
              readonly id: string;
              readonly kind: "category";
              readonly categoryId: number;
              readonly categorySlugPath: string;
            };
            readonly children: readonly unknown[];
          }[];
        }[];
      }
    | undefined;
  assert.ok(output !== undefined);
  assert.deepEqual(
    output.categories?.map(({ id, name, parentId }) => ({
      id,
      name,
      parentId,
    })),
    [
      { id: 42, name: "受控板块", parentId: null },
      { id: 44, name: "另一可见板块", parentId: null },
    ],
  );
  const parent = output.categories?.find(({ id }) => id === 42);
  assert.ok(parent !== undefined);
  assert.deepEqual(
    parent.children.map(({ id, name, parentId, collectTarget }) => ({
      id,
      name,
      parentId,
      collectTarget,
    })),
    [
      {
        id: 43,
        name: "可见子板块",
        parentId: 42,
        collectTarget: {
          id: "category-43",
          kind: "category",
          categoryId: 43,
          categorySlugPath: "controlled/child",
        },
      },
    ],
  );
  const after = await sourceState();
  const categoryEvent = after.events
    .slice(before.events.length)
    .find(({ action }) => action === "categories");
  assert.ok(categoryEvent !== undefined);
  assert.equal(categoryEvent.authenticated, true);
  assert.ok(categoryEvent.path.includes("include_subcategories=true"));
  assert.equal(
    after.events
      .slice(before.events.length)
      .some(({ action }) => ["topic-list", "topic", "posts"].includes(action)),
    false,
    "板块发现只枚举当前账号可见板块，不读取帖子或归档内容。",
  );

  await updateFixtureState({ categoriesUnavailable: true });
  const unavailable = await trigger("list-categories", {});
  assert.equal(unavailable.status, "failed", JSON.stringify(unavailable));
  assert.equal(
    unavailable.result?.error?.code,
    "discourse_category_list_request_failed",
  );

  const failedCollection = await trigger("collect", {
    targets: linuxdoTargets("category"),
    maxTopics: 1,
  });
  assert.equal(
    failedCollection.status,
    "failed",
    JSON.stringify(failedCollection),
  );
  assert.equal(
    failedCollection.result?.error?.code,
    "discourse_category_list_request_failed",
  );
  assert.equal(failedCollection.result?.output, undefined);
  assert.equal(failedCollection.report?.phase, "failed");
  assert.equal(failedCollection.report?.discovery, "failed");
  assert.equal(
    failedCollection.report?.referenceTime,
    failedCollection.referenceTime,
  );
  assert.deepEqual(failedCollection.report?.intent, {
    date: "2026-10-28",
    timeZone: "UTC",
    target: {
      kind: "targets",
      targets: linuxdoTargets("category"),
    },
    maxTopics: 1,
  });

  await updateFixtureState({
    categoriesUnavailable: false,
    categoriesInvalidResponse: true,
  });
  const invalid = await trigger("list-categories", {});
  assert.equal(invalid.status, "failed", JSON.stringify(invalid));
  assert.equal(
    invalid.result?.error?.code,
    "discourse_category_list_response_invalid",
  );
  await updateFixtureState({ categoriesInvalidResponse: false });

  const child = parent.children[0];
  assert.ok(child !== undefined);
  const beforeCollection = await sourceState();
  const collection = await trigger("collect", {
    targets: [child.collectTarget],
    maxTopics: 1,
  });
  assert.equal(collection.status, "completed", JSON.stringify(collection));
  assert.ok(
    collection.result?.output?.completedScopes?.includes("target:category-43"),
  );
  assert.equal(collection.report?.phase, "completed");
  assert.equal(collection.report?.discovery, "complete");
  assert.ok(
    Array.isArray(collection.report?.scopes) &&
      collection.report.scopes.some(
        (scope) =>
          typeof scope === "object" &&
          scope !== null &&
          "scope" in scope &&
          scope.scope === "target:category-43" &&
          "status" in scope &&
          scope.status === "completed",
      ),
    JSON.stringify(collection.report),
  );
  assert.ok(collection.result?.output !== undefined);
  const afterCollection = await sourceState();
  assert.ok(
    afterCollection.events
      .slice(beforeCollection.events.length)
      .some(
        ({ action, path, authenticated }) =>
          action === "topic-list" &&
          path.startsWith("/c/controlled/child/43/l/latest.json") &&
          authenticated === true,
      ),
  );
  const archived = await searchArchiveItem("发现主题 2499");
  assert.equal(archived.sourceKey.key, "post:249900");
  assert.equal(binState(archived).capture.scope.topicId, 2499);
}

async function verifyRunReportAfterWorkerInterruption(): Promise<void> {
  const before = await sourceState();
  const priorTopicLists = before.events.filter(
    ({ action }) => action === "topic-list",
  ).length;
  await updateFixtureState({ topicListDelayMs: 30_000 });
  try {
    const queued = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "collect",
        "--params",
        JSON.stringify({
          targets: linuxdoTargets("latest"),
          date: "2026-10-28",
          timeZone: "UTC",
          maxTopics: 1,
        }),
      ]),
      "triggered",
    );
    const collecting = await waitFor(
      async () =>
        cliData<ManualRun>(
          await cli(["run", "get", "binny-discovery-topic", queued.runId]),
          "found",
        ),
      ({ status, report }) =>
        status === "executing" &&
        report?.phase === "collecting" &&
        Array.isArray(report.scopes) &&
        report.scopes.some(
          (scope) =>
            typeof scope === "object" &&
            scope !== null &&
            "scope" in scope &&
            scope.scope === "target:latest" &&
            "status" in scope &&
            scope.status === "in-progress",
        ),
      "collect 运行的执行中报告",
    );
    assert.equal(collecting.report?.referenceTime, collecting.referenceTime);
    assert.ok(
      Array.isArray(collecting.report?.scopes) &&
        collecting.report.scopes.some(
          (scope) =>
            typeof scope === "object" &&
            scope !== null &&
            "scope" in scope &&
            scope.scope === "target:latest" &&
            "status" in scope &&
            scope.status === "in-progress",
        ),
      JSON.stringify(collecting.report),
    );
    await waitForSourceEvent("topic-list", priorTopicLists + 1);

    const bin = cliData<{
      readonly execution: { readonly runtimeId: string };
    }>(await cli(["bin", "get", "binny-discovery-topic"]), "found");
    const currentReport = JSON.stringify(collecting.report);
    const wrongRuntime = await fetch(
      `${apiUrl()}/bins/binny-discovery-topic/runtime/runs/${queued.runId}/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtimeId: "different-runtime",
          report: { phase: "tampered" },
        }),
      },
    );
    assert.equal(wrongRuntime.status, 409);
    assert.equal(
      (
        (await wrongRuntime.json()) as {
          readonly error: { readonly code: string };
        }
      ).error.code,
      "runtime_mismatch",
    );
    const afterWrongRuntime = cliData<ManualRun>(
      await cli(["run", "get", "binny-discovery-topic", queued.runId]),
      "found",
    );
    assert.equal(JSON.stringify(afterWrongRuntime.report), currentReport);

    const childProcesses = await compose([
      "exec",
      "--no-TTY",
      "runtime-linuxdo",
      "node",
      "--input-type=module",
      "-e",
      'import { readdirSync, readFileSync } from "node:fs"; for (const entry of readdirSync("/proc")) { if (!/^\\d+$/u.test(entry)) continue; try { const proc = "/proc/" + entry; const command = readFileSync(proc + "/cmdline").toString(); if ((command.includes("worker.js") || command.includes("worker.ts")) && Number(entry) !== process.pid) { process.stdout.write(entry); process.exit(0); } } catch {} } process.exit(1);',
    ]);
    const workerPid = Number(childProcesses.stdout.trim());
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1);
    await compose([
      "exec",
      "--no-TTY",
      "runtime-linuxdo",
      "node",
      "-e",
      `process.kill(${String(workerPid)}, "SIGKILL")`,
    ]);

    const interrupted = await waitForManualRun(queued.runId);
    assert.equal(interrupted.status, "failed", JSON.stringify(interrupted));
    assert.equal(
      interrupted.result?.error?.code,
      "source_adapter_process_interrupted",
    );
    assert.equal(interrupted.result?.output, undefined);
    assert.equal(JSON.stringify(interrupted.report), currentReport);

    const terminalUpdate = await fetch(
      `${apiUrl()}/bins/binny-discovery-topic/runtime/runs/${queued.runId}/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtimeId: bin.execution.runtimeId,
          report: { phase: "completed", tampered: true },
        }),
      },
    );
    assert.equal(terminalUpdate.status, 409);
    assert.equal(
      (
        (await terminalUpdate.json()) as {
          readonly error: { readonly code: string };
        }
      ).error.code,
      "run_not_executing",
    );
    const afterTerminalUpdate = cliData<ManualRun>(
      await cli(["run", "get", "binny-discovery-topic", queued.runId]),
      "found",
    );
    assert.equal(JSON.stringify(afterTerminalUpdate.report), currentReport);
  } finally {
    await updateFixtureState({ topicListDelayMs: 0 });
  }
}

type PublicSourceStateSnapshot = {
  readonly freshness: "unknown" | "current" | "stale";
  readonly updatedAt?: string;
  readonly sync?: unknown;
  readonly sourceAccess:
    | { readonly status: "unknown" }
    | {
        readonly status: "unavailable";
        readonly reason: "persistent_state_unavailable";
      }
    | {
        readonly status: "available";
        readonly groups: Readonly<
          Record<
            string,
            {
              readonly lastAdmittedAt?: string;
              readonly cooldownUntil?: string;
              readonly latestLimitStatus?: 429 | 503;
            }
          >
        >;
      };
};

type PublicBinRuntime = {
  readonly status: string;
  readonly sourceStateSnapshot: PublicSourceStateSnapshot;
};

async function readBinRuntime(binId: string): Promise<PublicBinRuntime> {
  const bin = cliData<{
    readonly execution: PublicBinRuntime;
  }>(await cli(["bin", "get", binId]), "found");
  return bin.execution;
}

async function verifySourceStateFreshness(
  manifest: RuntimeManifest,
): Promise<void> {
  await clearSourceEvents();
  const initialBin = cliData<{
    readonly execution: {
      readonly status: string;
      readonly runtimeId: string;
      readonly environment: Record<string, unknown>;
      readonly sourceStateSnapshot: PublicSourceStateSnapshot;
    };
  }>(await cli(["bin", "get", "binny-discovery-topic"]), "found");
  assert.equal(initialBin.execution.status, "online");
  assert.equal(initialBin.execution.sourceStateSnapshot.freshness, "current");
  assert.ok(initialBin.execution.sourceStateSnapshot.updatedAt !== undefined);
  const ownerGenerationResult = await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-U",
    "binny",
    "-d",
    "binny",
    "-t",
    "-A",
    "-c",
    "SELECT owner_generation FROM runtime_connections WHERE bin_id = 'binny-discovery-topic';",
  ]);
  const ownerGeneration = ownerGenerationResult.stdout.trim();
  assert.match(ownerGeneration, /^[1-9][0-9]*$/u);

  await compose(["stop", "runtime-linuxdo"]);
  const stoppedRuntime = await readBinRuntime("binny-discovery-topic");
  const originalUpdatedAt = stoppedRuntime.sourceStateSnapshot.updatedAt;
  assert.ok(originalUpdatedAt !== undefined);
  const sendHeartbeatWithoutSnapshot = async (): Promise<void> => {
    const response = await fetch(
      `${apiUrl()}/bins/binny-discovery-topic/runtime/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: manifest.protocolVersion,
          runtimeId: initialBin.execution.runtimeId,
          ownerGeneration,
          ownerLockAcquired: true,
          activeRunId: null,
          claimInFlight: false,
          runtimeControlUrl: "http://runtime-linuxdo:8080",
          sourceAdapter: manifest.sourceAdapter,
          environment: initialBin.execution.environment,
        }),
      },
    );
    assert.equal(response.status, 200, await response.text());
  };

  let latest = await readBinRuntime("binny-discovery-topic");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sendHeartbeatWithoutSnapshot();
    latest = await readBinRuntime("binny-discovery-topic");
    if (Date.now() - Date.parse(originalUpdatedAt) > 10_000) break;
    await delay(1_000);
  }
  assert.equal(latest.status, "online");
  assert.equal(latest.sourceStateSnapshot.freshness, "stale");
  assert.equal(latest.sourceStateSnapshot.updatedAt, originalUpdatedAt);
  assert.equal((await sourceState()).events.length, 0);

  await compose(["start", "runtime-linuxdo"]);
  await waitForRuntimeHealth();
  await waitForRuntime();
  const recovered = await readBinRuntime("binny-discovery-topic");
  assert.equal(recovered.status, "online");
  assert.equal(recovered.sourceStateSnapshot.freshness, "current");
  assert.ok(
    Date.parse(recovered.sourceStateSnapshot.updatedAt!) >=
      Date.parse(originalUpdatedAt),
  );
}

async function verifySourceCooldownAndSnapshots(): Promise<void> {
  await clearSourceEvents();
  const beforeRead = await sourceState();
  const current = await readBinRuntime("binny-discovery-topic");
  assert.equal(current.sourceStateSnapshot.freshness, "current");
  assert.equal(current.sourceStateSnapshot.sourceAccess.status, "available");
  const afterRead = await sourceState();
  assert.equal(afterRead.events.length, beforeRead.events.length);

  await compose(["stop", "runtime-linuxdo"]);
  await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-U",
    "binny",
    "-d",
    "binny",
    "-c",
    "UPDATE runtime_connections SET source_state_snapshot = NULL WHERE bin_id = 'binny-discovery-topic';",
  ]);
  const legacy = await waitFor(
    async () => await readBinRuntime("binny-discovery-topic"),
    (runtime) => runtime.status === "offline",
    "运行器停止后的未知快照离线收敛",
  );
  assert.equal(legacy.status, "offline");
  assert.equal(legacy.sourceStateSnapshot.freshness, "unknown");
  assert.deepEqual(legacy.sourceStateSnapshot.sourceAccess, {
    status: "unknown",
  });
  assert.equal((await sourceState()).events.length, afterRead.events.length);
  await compose(["start", "runtime-linuxdo"]);
  await waitForRuntimeHealth();
  await waitForRuntime();

  await setSourceAccessPolicy(0, 1);
  await updateFixtureState({
    rateLimitPath: "/session/current.json",
    rateLimitStatus: 429,
    retryAfterHeader: "30",
    rateLimitRemaining: 1,
  });
  await clearSourceEvents();
  const limited = await trigger("check", { topicId: 2401 });
  assert.equal(limited.status, "completed", JSON.stringify(limited));
  const limitedAccess = sourceAccessSummary(limited);
  assert.deepEqual(
    limitedAccess.rateLimitResponses.map(({ status, outcome }) => ({
      status,
      outcome,
    })),
    [{ status: 429, outcome: "cooled" }],
    JSON.stringify(limitedAccess),
  );
  const firstCooldown = limitedAccess.rateLimitResponses[0]?.cooldownUntil;
  assert.ok(firstCooldown !== undefined);
  assert.ok(
    Date.parse(firstCooldown) >
      Date.parse(limitedAccess.rateLimitResponses[0]!.observedAt),
  );

  const availableWithCooldown = await waitFor(
    async () => await readBinRuntime("binny-discovery-topic"),
    (runtime) => {
      const sourceAccess = runtime.sourceStateSnapshot.sourceAccess;
      if (sourceAccess.status !== "available") return false;
      const group = sourceAccess.groups.linuxdo;
      return (
        runtime.sourceStateSnapshot.freshness === "current" &&
        group?.latestLimitStatus === 429 &&
        group.cooldownUntil === firstCooldown
      );
    },
    "429 后的当前冷却快照",
  );
  assert.equal(
    availableWithCooldown.sourceStateSnapshot.sourceAccess.status,
    "available",
  );
  const eventsBeforeSnapshotRead = await sourceState();
  await readBinRuntime("binny-discovery-topic");
  assert.equal(
    (await sourceState()).events.length,
    eventsBeforeSnapshotRead.events.length,
  );

  await compose(["stop", "runtime-linuxdo"]);
  const offline = await waitFor(
    async () => await readBinRuntime("binny-discovery-topic"),
    (runtime) =>
      runtime.status === "offline" &&
      runtime.sourceStateSnapshot.freshness === "stale",
    "运行器停止后的离线快照收敛",
  );
  assert.equal(offline.status, "offline");
  assert.equal(offline.sourceStateSnapshot.freshness, "stale");
  const offlineAccess = offline.sourceStateSnapshot.sourceAccess;
  assert.equal(offlineAccess.status, "available");
  if (offlineAccess.status !== "available")
    assert.fail("离线快照没有保留来源状态。");
  assert.equal(offlineAccess.groups.linuxdo?.latestLimitStatus, 429);
  assert.equal(offlineAccess.groups.linuxdo?.cooldownUntil, firstCooldown);
  await compose(["start", "runtime-linuxdo"]);
  await waitForRuntimeHealth();
  await waitForRuntime();
  const restarted = await readBinRuntime("binny-discovery-topic");
  assert.equal(restarted.sourceStateSnapshot.freshness, "current");
  const restartedAccess = restarted.sourceStateSnapshot.sourceAccess;
  assert.equal(restartedAccess.status, "available");
  if (restartedAccess.status !== "available")
    assert.fail("重启后的运行器没有来源状态快照。");
  assert.equal(restartedAccess.groups.linuxdo?.latestLimitStatus, 429);
  assert.equal(restartedAccess.groups.linuxdo?.cooldownUntil, firstCooldown);

  await updateFixtureState({
    rateLimitPath: null,
    rateLimitRemaining: 0,
  });
  const eventsBeforeResume = await sourceState();
  const resumed = await trigger("check", { topicId: 2401 });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed));
  const resumedAccess = sourceAccessSummary(resumed);
  const resumedSourceEvents = (await sourceState()).events.slice(
    eventsBeforeResume.events.length,
  );
  const resumedSessionEvent = resumedSourceEvents.find(
    ({ action }) => action === "session-current",
  );
  assert.ok(resumedSessionEvent !== undefined);
  assert.ok(
    resumedSessionEvent.at >= Date.parse(firstCooldown),
    JSON.stringify({ firstCooldown, resumedSessionEvent, resumedAccess }),
  );
  assert.equal(
    resumedSourceEvents.filter(({ action }) => action === "session-current")
      .length,
    1,
  );

  await updateFixtureState({
    rateLimitPath: "/session/current.json",
    rateLimitStatus: 503,
    retryAfterHeader: new Date(
      Date.parse(await readContainerTime("runtime-linuxdo")) + 5_000,
    ).toUTCString(),
    rateLimitRemaining: 1,
  });
  const dateLimited = await trigger("check", { topicId: 2401 });
  assert.equal(dateLimited.status, "completed", JSON.stringify(dateLimited));
  assert.deepEqual(
    sourceAccessSummary(dateLimited).rateLimitResponses.map(
      ({ status, outcome }) => ({ status, outcome }),
    ),
    [{ status: 503, outcome: "cooled" }],
    JSON.stringify(sourceAccessSummary(dateLimited)),
  );
  const dateCooldownSnapshot = await waitFor(
    async () => await readBinRuntime("binny-discovery-topic"),
    (runtime) => {
      const access = runtime.sourceStateSnapshot.sourceAccess;
      return (
        runtime.sourceStateSnapshot.freshness === "current" &&
        access.status === "available" &&
        access.groups.linuxdo?.latestLimitStatus === 503
      );
    },
    "503 HTTP 日期冷却快照",
  );
  const dateCooldownUntil =
    dateCooldownSnapshot.sourceStateSnapshot.sourceAccess;
  assert.equal(dateCooldownUntil.status, "available");
  assert.ok(dateCooldownUntil.groups.linuxdo?.cooldownUntil !== undefined);
  const dateCooldownAt = dateCooldownUntil.groups.linuxdo.cooldownUntil;
  const eventsBeforeDateFollowUp = await sourceState();
  const dateLimitedFollowUp = await trigger("check", { topicId: 2401 });
  assert.equal(dateLimitedFollowUp.status, "completed");
  const dateFollowUpEvents = (await sourceState()).events.slice(
    eventsBeforeDateFollowUp.events.length,
  );
  const dateFollowUpSession = dateFollowUpEvents.find(
    ({ action }) => action === "session-current",
  );
  assert.ok(dateFollowUpSession !== undefined);
  assert.ok(
    dateFollowUpSession.at >= Date.parse(dateCooldownAt),
    JSON.stringify({ dateCooldownAt, dateFollowUpSession }),
  );
  assert.equal(
    sourceAccessSummary(dateLimitedFollowUp).rateLimitResponses.length,
    0,
  );
}

async function verifyCorruptSourceStateVisibility(): Promise<void> {
  await clearSourceEvents();
  await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-U",
    "binny",
    "-d",
    "binny",
    "-c",
    "UPDATE bin_configurations SET source_access_state = '\"corrupt\"'::jsonb WHERE id = 'binny-discovery-topic';",
  ]);
  await compose(["restart", "runtime-linuxdo"]);
  await waitForRuntimeHealth();
  await waitForRuntime();

  const bin = cliData<{
    readonly execution: PublicBinRuntime;
  }>(await cli(["bin", "get", "binny-discovery-topic"]), "found");
  assert.equal(bin.execution.sourceStateSnapshot.freshness, "current");
  assert.deepEqual(bin.execution.sourceStateSnapshot.sourceAccess, {
    status: "unavailable",
    reason: "persistent_state_unavailable",
  });
  assert.equal(JSON.stringify(bin).includes("source-access.json"), false);

  const unavailableCheck = await trigger("check", { topicId: 2401 });
  assert.equal(
    unavailableCheck.status,
    "completed",
    JSON.stringify(unavailableCheck),
  );
  assert.equal(checkOutput(unavailableCheck).availability, "unknown");
  assert.ok(
    checkOutput(unavailableCheck).problems.some(
      ({ code, message }) =>
        code === "linuxdo_source_unreachable" &&
        message?.includes("来源访问状态不可用，已停止本次主动访问。") === true,
    ),
  );
  assert.equal(sourceAccessSummary(unavailableCheck).admittedAttempts, 0);
  assert.ok(unavailableCheck.report !== undefined);

  const unavailableCategories = await trigger("list-categories", {});
  assert.equal(
    unavailableCategories.status,
    "failed",
    JSON.stringify(unavailableCategories),
  );
  assert.equal(
    unavailableCategories.result?.error?.code,
    "linuxdo_source_unreachable",
    JSON.stringify(unavailableCategories),
  );
  assert.ok(
    unavailableCategories.result?.error?.message?.includes(
      "来源访问状态不可用，已停止本次主动访问。",
    ),
  );
  assert.equal(sourceAccessSummary(unavailableCategories).admittedAttempts, 0);
  assert.ok(unavailableCategories.report !== undefined);
  assert.equal(
    JSON.stringify({ unavailableCheck, unavailableCategories }).includes(
      "source-access.json",
    ),
    false,
  );
  assert.equal((await sourceState()).events.length, 0);

  await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-U",
    "binny",
    "-d",
    "binny",
    "-c",
    "UPDATE bin_configurations SET source_access_state = NULL WHERE id = 'binny-discovery-topic';",
  ]);
  await compose(["restart", "runtime-linuxdo"]);
  await waitForRuntimeHealth();
  await waitForRuntime();
}

async function verifyScheduledCollectionAcrossMidnight(): Promise<void> {
  await updateFixtureState({
    topicVersion: 4,
    addedReply: true,
    discoveryAddedReply: true,
    topicListDelayMs: 0,
    topicCreatedAtOverrides: {
      2401: "2026-10-28T23:59:44.999Z",
      2402: "2026-10-29T00:00:00.000Z",
      2403: "2026-10-29T00:00:00.000Z",
      2404: "2026-10-29T00:00:00.000Z",
      2405: "2026-10-29T00:00:00.000Z",
      2406: "2026-10-29T00:00:00.000Z",
      2407: "2026-10-29T00:00:00.000Z",
      2408: "2026-10-29T00:00:00.000Z",
      2409: "2026-10-29T00:00:00.000Z",
      2410: "2026-10-29T00:00:00.000Z",
    },
  });

  await compose(["stop", "runtime-linuxdo", "server"]);
  await setTestClockAt("2026-10-28T23:59:00.000Z");
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
    "server",
    "runtime-linuxdo",
  ]);
  serverPort = await publishedPort("server", 3000);
  await waitForApi();
  await waitForRuntimeHealth();
  await waitForRuntime();
  const scheduleCreatedAt = await readContainerTime("server");
  assert.ok(
    Date.parse(scheduleCreatedAt) >= Date.parse("2026-10-28T23:59:00.000Z") &&
      Date.parse(scheduleCreatedAt) < Date.parse("2026-10-28T23:59:45.000Z"),
  );

  const schedule = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
  }>(
    await cli([
      "schedule",
      "create",
      "binny-discovery-topic",
      "--expression",
      "45 * * * * *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({
        targets: linuxdoTargets("latest"),
        date: "today",
        timeZone: "UTC",
        maxTopics: 10,
      }),
    ]),
    "created",
  );
  assert.equal(schedule.nextDueAt, "2026-10-28T23:59:45.000Z");

  const scheduleBlockerTime = await waitFor(
    async () => Date.parse(await readContainerTime("server")),
    (milliseconds) =>
      milliseconds >= Date.parse("2026-10-28T23:59:25.000Z") &&
      milliseconds < Date.parse("2026-10-28T23:59:45.000Z"),
    "等待计划到期前启动受控运行器占用",
  );
  assert.ok(Number.isFinite(scheduleBlockerTime));
  await updateFixtureState({ topicListDelayMs: 25_000 });
  const eventsBeforeScheduleBlocker = await sourceState();
  const scheduleBlocker = cliData<ManualRun>(
    await cli([
      "run",
      "trigger",
      "binny-discovery-topic",
      "collect",
      "--params",
      JSON.stringify({
        targets: linuxdoTargets("latest"),
        date: "2026-10-28",
        timeZone: "UTC",
        maxTopics: 10,
      }),
    ]),
    "triggered",
  );
  await waitForSourceEvent(
    "topic-list",
    eventsBeforeScheduleBlocker.events.filter(
      ({ action }) => action === "topic-list",
    ).length + 1,
  );
  const runningScheduleBlocker = await waitFor(
    async () =>
      cliData<ManualRun>(
        await cli([
          "run",
          "get",
          "binny-discovery-topic",
          scheduleBlocker.runId,
        ]),
        "found",
      ),
    ({ status }) => status === "executing",
    "确认受控运行器占用正在执行",
  );
  assert.equal(runningScheduleBlocker.status, "executing");

  const queuedDue = await waitFor(
    async () =>
      cliData<{
        readonly lastRunId?: string;
        readonly nextDueAt: string;
      }>(
        await cli([
          "schedule",
          "get",
          "binny-discovery-topic",
          schedule.scheduleId,
        ]),
        "found",
      ),
    ({ lastRunId }) => lastRunId !== undefined,
    "在运行器占用时排入午夜前的计划触发",
  );
  const queuedRunId = queuedDue.lastRunId;
  assert.ok(queuedRunId !== undefined);
  const queuedRun = cliData<ManualRun>(
    await cli(["run", "get", "binny-discovery-topic", queuedRunId]),
    "found",
  );
  assert.equal(queuedRun.status, "queued");
  assert.equal(queuedRun.trigger?.kind, "schedule");
  assert.equal(queuedRun.trigger?.scheduleId, schedule.scheduleId);
  assert.equal(queuedRun.trigger?.scheduledFor, "2026-10-28T23:59:45.000Z");
  assert.equal(queuedRun.referenceTime, "2026-10-28T23:59:45.000Z");
  const listedSchedules = cliData<{
    readonly schedules: readonly {
      readonly scheduleId: string;
      readonly lastRunId?: string;
    }[];
  }>(await cli(["schedule", "list", "binny-discovery-topic"]), "listed");
  assert.equal(
    listedSchedules.schedules.find(
      ({ scheduleId }) => scheduleId === schedule.scheduleId,
    )?.lastRunId,
    queuedRunId,
  );

  const changedSchedule = cliData<{
    readonly lastRunId?: string;
    readonly nextDueAt: string;
    readonly params: { readonly date: string };
  }>(
    await cli([
      "schedule",
      "update",
      "binny-discovery-topic",
      schedule.scheduleId,
      "--params",
      JSON.stringify({
        targets: linuxdoTargets("latest"),
        date: "2026-10-29",
        timeZone: "UTC",
        maxTopics: 10,
      }),
    ]),
    "updated",
  );
  assert.equal(changedSchedule.params.date, "2026-10-29");
  assert.equal(changedSchedule.lastRunId, queuedRunId);
  assert.equal(changedSchedule.nextDueAt, "2026-10-29T00:00:45.000Z");
  const queuedRunAfterPlanUpdate = cliData<ManualRun>(
    await cli(["run", "get", "binny-discovery-topic", queuedRunId]),
    "found",
  );
  assert.equal(queuedRunAfterPlanUpdate.status, "queued");
  assert.equal(queuedRunAfterPlanUpdate.referenceTime, queuedRun.referenceTime);
  assert.equal(
    queuedRunAfterPlanUpdate.trigger?.scheduleId,
    schedule.scheduleId,
  );
  assert.equal(
    queuedRunAfterPlanUpdate.trigger?.scheduledFor,
    "2026-10-28T23:59:45.000Z",
  );
  await compose(["stop", "runtime-linuxdo"]);
  const stoppedScheduleBlocker = await waitFor(
    async () =>
      cliData<ManualRun>(
        await cli([
          "run",
          "get",
          "binny-discovery-topic",
          scheduleBlocker.runId,
        ]),
        "found",
      ),
    ({ status }) =>
      status === "failed" || status === "cancelled" || status === "completed",
    "运行器停止后终结占用运行",
  );
  assert.notEqual(stoppedScheduleBlocker.status, "completed");
  await updateFixtureState({ topicListDelayMs: 0 });
  const queuedRunAfterRunnerStop = cliData<ManualRun>(
    await cli(["run", "get", "binny-discovery-topic", queuedRunId]),
    "found",
  );
  assert.equal(queuedRunAfterRunnerStop.status, "queued");
  assert.equal(queuedRunAfterRunnerStop.referenceTime, queuedRun.referenceTime);

  const coreStoppedAt = Date.now();
  await compose(["stop", "server"]);
  await setTestClockAt("2026-10-29T00:00:50.000Z");
  await compose(["up", "--detach", "--scale", "server=2", "server"]);
  serverPort = await publishedPort("server", 3000);
  await waitForApi();
  const coreOutageMilliseconds = Date.now() - coreStoppedAt;
  await waitForApi(2);
  const resumedSchedule = await waitFor(
    async () =>
      cliData<{
        readonly lastRunId?: string;
        readonly nextDueAt: string;
        readonly params: { readonly date: string };
      }>(
        await cli([
          "schedule",
          "get",
          "binny-discovery-topic",
          schedule.scheduleId,
        ]),
        "found",
      ),
    ({ nextDueAt }) => nextDueAt === "2026-10-29T00:01:45.000Z",
    "启动时跳过停机期间遗漏的下一次计划触发",
  );
  assert.equal(resumedSchedule.nextDueAt, "2026-10-29T00:01:45.000Z");
  if (
    resumedSchedule.lastRunId !== undefined &&
    resumedSchedule.lastRunId !== queuedRunId
  ) {
    const unexpectedRun = cliData<ManualRun>(
      await cli([
        "run",
        "get",
        "binny-discovery-topic",
        resumedSchedule.lastRunId,
      ]),
      "found",
    );
    assert.equal(
      unexpectedRun.trigger?.scheduledFor,
      "2026-10-29T00:00:45.000Z",
    );
  }
  assert.equal(resumedSchedule.lastRunId, queuedRunId);
  assert.equal(resumedSchedule.params.date, "2026-10-29");
  const resumedScheduleFromSecondCore = cliData<{
    readonly lastRunId?: string;
    readonly nextDueAt: string;
    readonly params: { readonly date: string };
  }>(
    await cli(
      ["schedule", "get", "binny-discovery-topic", schedule.scheduleId],
      2,
    ),
    "found",
  );
  assert.equal(resumedScheduleFromSecondCore.lastRunId, queuedRunId);
  assert.equal(
    resumedScheduleFromSecondCore.nextDueAt,
    "2026-10-29T00:01:45.000Z",
  );
  assert.equal(resumedScheduleFromSecondCore.params.date, "2026-10-29");
  const stillQueuedRun = cliData<ManualRun>(
    await cli(["run", "get", "binny-discovery-topic", queuedRunId], 2),
    "found",
  );
  assert.equal(stillQueuedRun.status, "queued");
  assert.equal(stillQueuedRun.referenceTime, "2026-10-28T23:59:45.000Z");
  assert.equal(
    stillQueuedRun.trigger?.scheduledFor,
    "2026-10-28T23:59:45.000Z",
  );

  await compose(["start", "runtime-linuxdo"]);
  await waitForRuntimeHealth();
  await waitForRuntime();
  const runtimeOnlineAt = await readContainerTime("runtime-linuxdo");
  assert.ok(
    Date.parse(runtimeOnlineAt) >= Date.parse("2026-10-29T00:00:50.000Z"),
  );

  const searchScheduledObservationRunIds = async (): Promise<string[]> => {
    const page = cliData<{
      readonly results: readonly {
        readonly matches: readonly { readonly runId?: string }[];
      }[];
    }>(
      await cli([
        "archive",
        "search",
        "--query",
        JSON.stringify({
          scope: { kind: "observations", binId: "binny-discovery-topic" },
          text: { kind: "literal", value: "主题正文版本 4" },
          select: ["runId"],
          limit: 10,
        }),
      ]),
      "found",
    );
    return [
      ...new Set(
        page.results.flatMap(({ matches }) =>
          matches.flatMap(({ runId }) => (runId === undefined ? [] : [runId])),
        ),
      ),
    ].sort();
  };

  const observedRunIds = await waitFor(
    searchScheduledObservationRunIds,
    (runIds) => runIds.length >= 1,
    "归档午夜前计划运行的主题正文",
  );
  const scheduledRunId = observedRunIds[0];
  assert.ok(scheduledRunId !== undefined);
  assert.equal(scheduledRunId, queuedRunId);
  const scheduledRun = await waitForManualRun(scheduledRunId);
  assert.equal(scheduledRun.status, "completed", JSON.stringify(scheduledRun));
  assert.equal(scheduledRun.trigger?.kind, "schedule");
  assert.equal(scheduledRun.trigger?.scheduleId, schedule.scheduleId);
  assert.equal(scheduledRun.trigger?.scheduledFor, "2026-10-28T23:59:45.000Z");
  assert.equal(scheduledRun.referenceTime, "2026-10-28T23:59:45.000Z");
  await delay(10_000);
  assert.deepEqual(
    await searchScheduledObservationRunIds(),
    [scheduledRunId],
    "停机期间 00:00:45 的触发不能在重启后补发第二个归档运行。",
  );
  assert.deepEqual(
    [...(scheduledRun.result?.output?.completedScopes ?? [])].sort(),
    [
      "target:latest",
      "topic:2401",
      "post:240001",
      "post:240002",
      "post:240003",
      "post:240004",
      "post:240005",
    ].sort(),
  );

  cliData(
    await cli([
      "schedule",
      "remove",
      "binny-discovery-topic",
      schedule.scheduleId,
    ]),
    "removed",
  );
  await compose(["stop", "runtime-linuxdo", "server"]);
  await setTestClockOffset(0);
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
    "--scale",
    "server=1",
    "server",
    "runtime-linuxdo",
  ]);
  serverPort = await publishedPort("server", 3000);
  await waitForApi();
  await waitForRuntimeHealth();
  await waitForRuntime();
  process.stdout.write(
    `跨午夜计划运行通过：runId=${scheduledRunId}, scheduleId=${schedule.scheduleId}, createdAt=${scheduleCreatedAt}, scheduledFor/referenceTime=2026-10-28T23:59:45.000Z, runtimeOnlineAt=${runtimeOnlineAt}, coreRecoveryMs=${coreOutageMilliseconds}, archivedScopes=[topic:2401]；恢复时跳过 2026-10-29T00:00:45.000Z。\n`,
  );
}

async function assertSignedInCheckFailures(): Promise<void> {
  const before = await sourceState();
  const topicRequests = before.events.filter(
    ({ action }) => action === "topic",
  ).length;

  await updateFixtureState({ challengePage: true });
  const challengeCheck = await trigger("check", { topicId: 2401 });
  assert.equal(challengeCheck.status, "completed");
  assert.equal(checkOutput(challengeCheck).availability, "unknown");
  assert.ok(
    checkOutput(challengeCheck).problems.some(
      ({ code, requiresHuman }) =>
        code === "discourse_challenge_response" && requiresHuman,
    ),
  );
  const challengeCollect = await trigger("collect", { topicId: 2401 });
  assert.equal(challengeCollect.status, "failed");
  assert.equal(challengeCollect.result?.error?.requiresHuman, true);

  await updateFixtureState({ challengePage: false, challengeTopic: true });
  const topicChallengeCheck = await trigger("check", { topicId: 2401 });
  assert.equal(topicChallengeCheck.status, "completed");
  assert.equal(checkOutput(topicChallengeCheck).availability, "unknown");
  assert.ok(
    checkOutput(topicChallengeCheck).problems.some(
      ({ code, requiresHuman }) =>
        code === "discourse_topic_challenge_response" && requiresHuman,
    ),
  );
  const topicChallengeCollect = await trigger("collect", { topicId: 2401 });
  assert.equal(topicChallengeCollect.status, "failed");
  assert.equal(topicChallengeCollect.result?.error?.requiresHuman, true);

  await updateFixtureState({ challengeTopic: false, challengePosts: true });
  const postsChallengeCheck = await trigger("check", { topicId: 2401 });
  assert.equal(postsChallengeCheck.status, "completed");
  assert.equal(checkOutput(postsChallengeCheck).availability, "unknown");
  assert.ok(
    checkOutput(postsChallengeCheck).problems.some(
      ({ code, requiresHuman }) =>
        code === "discourse_topic_posts_challenge_response" && requiresHuman,
    ),
  );
  const postsChallengeCollect = await trigger("collect", { topicId: 2401 });
  assert.equal(postsChallengeCollect.status, "failed");
  assert.equal(postsChallengeCollect.result?.error?.requiresHuman, true);

  await updateFixtureState({ challengePosts: false, topicVisible: false });
  const inaccessibleCheck = await trigger("check", { topicId: 2401 });
  assert.equal(inaccessibleCheck.status, "completed");
  assert.equal(checkOutput(inaccessibleCheck).availability, "unavailable");
  assert.ok(
    checkOutput(inaccessibleCheck).problems.some(
      ({ code }) => code === "discourse_topic_unavailable",
    ),
  );
  const inaccessibleCollect = await trigger("collect", { topicId: 2401 });
  assert.equal(inaccessibleCollect.status, "failed");
  assert.equal(
    inaccessibleCollect.result?.error?.code,
    "discourse_topic_unavailable",
  );
  await updateFixtureState({ topicVisible: true });

  const after = await sourceState();
  assert.ok(
    after.events.filter(({ action }) => action === "topic").length >
      topicRequests,
  );
}

async function verifyNavigationRace(): Promise<void> {
  const before = await sourceState();
  const reads = before.events.filter(
    ({ action }) => action === "session-current",
  ).length;
  await updateFixtureState({ navigationRace: true });
  try {
    const run = await trigger("check", { topicId: 2401 });
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.equal(
      checkOutput(run).availability,
      "available",
      JSON.stringify(run.result),
    );
    const after = await sourceState();
    assert.ok(after.events.some(({ action }) => action === "navigation-race"));
    assert.ok(
      after.events.filter(({ action }) => action === "session-current")
        .length >=
        reads + 2,
    );
  } finally {
    await updateFixtureState({ navigationRace: false });
  }
}

async function verifyNativeChallengeRecovery(): Promise<void> {
  await updateFixtureState({ nativeChallenge: true });
  const run = await trigger("check", { topicId: 2401 });
  assert.equal(run.status, "completed");
  const output = run.result?.output as Record<string, unknown>;
  const source = await sourceState();
  assert.equal(
    output.availability,
    "available",
    JSON.stringify({ run, events: source.events.slice(-12) }),
  );
  const summary = output.challengeRecovery as {
    rounds: number;
    elapsedMs: number;
    successes: number;
  };
  assert.equal(summary.rounds, 1);
  assert.equal(summary.successes, 1);
  assert.ok(summary.elapsedMs > 0 && summary.elapsedMs <= 30_000);
  assert.ok(source.events.some(({ action }) => action === "challenge-click"));

  const clicks = source.events.filter(
    ({ action }) => action === "challenge-click",
  ).length;
  await updateFixtureState({
    nativeChallenge: true,
    nativeChallengeWait: true,
  });
  const sessionReads = source.events.filter(
    ({ action }) => action === "session-current",
  ).length;
  const discovery = await trigger("list-categories", {});
  assert.equal(discovery.status, "completed", JSON.stringify(discovery));
  const discoveryOutput = discovery.result?.output as Record<string, unknown>;
  const waitSummary = discoveryOutput.challengeRecovery as typeof summary;
  assert.equal(waitSummary.rounds, 1);
  assert.equal(waitSummary.successes, 1);
  assert.ok(waitSummary.elapsedMs > 0 && waitSummary.elapsedMs <= 30_000);
  assert.ok(Array.isArray(discoveryOutput.categories));
  const afterWait = await sourceState();
  assert.equal(
    afterWait.events.filter(({ action }) => action === "challenge-click")
      .length,
    clicks,
  );
  assert.ok(afterWait.events.some(({ action }) => action === "challenge-wait"));
  assert.equal(
    afterWait.events.filter(({ action }) => action === "session-current")
      .length - sessionReads,
    4,
    "自动验证期间不应轮询原 JSON：只包含初次读取、验证导航、组件完成重载及恢复后重读",
  );
  await updateFixtureState({
    nativeChallenge: true,
    nativeChallengeWait: true,
    nativeChallengeNoReload: true,
  });
  try {
    const retainedDocument = await trigger("list-categories", {});
    assert.equal(
      retainedDocument.status,
      "completed",
      JSON.stringify(retainedDocument),
    );
    const retainedOutput = retainedDocument.result?.output as Record<
      string,
      unknown
    >;
    const retainedSummary = retainedOutput.challengeRecovery as typeof summary;
    assert.equal(retainedSummary.rounds, 1);
    assert.equal(
      retainedSummary.successes,
      1,
      "保留验证脚本的页面也必须通过原请求重读确认恢复",
    );
  } finally {
    await updateFixtureState({
      nativeChallenge: false,
      nativeChallengeWait: false,
      nativeChallengeNoReload: false,
    });
  }
}

async function collectTopic(): Promise<ManualRun> {
  const run = await trigger("collect", { topicId: 2401 });
  assert.equal(run.status, "completed", JSON.stringify(run));
  return run;
}

async function verifyPermissionAfterRecovery(): Promise<void> {
  await updateFixtureState({
    nativeChallengePaths: ["/t/2401.json"],
    topicVisible: false,
  });
  try {
    const run = await trigger("check", { topicId: 2401 });
    assert.equal(run.status, "completed", JSON.stringify(run));
    const output = run.result?.output as Record<string, unknown>;
    assert.equal(output.availability, "unavailable");
    const summary = output.challengeRecovery as {
      rounds: number;
      successes: number;
    };
    assert.equal(summary.rounds, 1);
    assert.equal(
      summary.successes,
      0,
      "解除挑战后仍无权限，不应计为原业务读取恢复成功",
    );
  } finally {
    await updateFixtureState({ nativeChallengePaths: [], topicVisible: true });
  }
}

async function verifyRunRecoveryBudget(): Promise<void> {
  await updateFixtureState({
    nativeChallengePaths: [
      "/session/current.json",
      "/t/2401.json",
      "/t/2401/posts.json",
      "/latest.json",
    ],
  });
  try {
    const run = await trigger("check", {
      targets: linuxdoTargets("pinned", "latest"),
    });
    assert.equal(run.status, "completed", JSON.stringify(run));
    const output = run.result?.output as Record<string, unknown>;
    assert.equal(output.availability, "unknown");
    const summary = output.challengeRecovery as {
      rounds: number;
      successes: number;
      elapsedMs: number;
    };
    assert.equal(summary.rounds, 3);
    assert.equal(summary.successes, 3);
    assert.ok(summary.elapsedMs > 0 && summary.elapsedMs <= 90_000);
    assert.match(JSON.stringify(output.problems), /恢复.*预算/u);
  } finally {
    await updateFixtureState({ nativeChallengePaths: [] });
  }
}

async function verifyChallengeCancellation(): Promise<void> {
  const before = await sourceState();
  const clicks = before.events.filter(
    ({ action }) => action === "challenge-click",
  ).length;
  await updateFixtureState({
    nativeChallenge: true,
    nativeChallengePersistent: true,
  });
  try {
    const queued = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "collect",
        "--params",
        JSON.stringify({
          topicId: 2401,
          date: "2026-10-28",
          timeZone: "UTC",
        }),
      ]),
      "triggered",
    );
    await waitForSourceEvent("challenge-click", clicks + 1);
    const started = Date.now();
    cliData<ManualRun>(
      await cli(["run", "cancel", "binny-discovery-topic", queued.runId]),
      "cancellation",
    );
    const stopped = await waitForManualRun(queued.runId);
    assert.equal(stopped.status, "cancelled", JSON.stringify(stopped));
    assert.equal(stopped.report?.phase, "cancelled", JSON.stringify(stopped));
    assert.equal(stopped.result?.output, undefined);
    assert.ok(
      Date.now() - started < 10_000,
      "取消应及时停止恢复，而非等待恢复预算耗尽",
    );
  } finally {
    await updateFixtureState({
      nativeChallenge: false,
      nativeChallengePersistent: false,
    });
  }
}

async function verifyPersistentChallengeBudget(): Promise<void> {
  const before = await sourceState();
  const previousClicks = before.events.filter(
    ({ action }) => action === "challenge-click",
  ).length;
  await updateFixtureState({
    nativeChallenge: true,
    nativeChallengePersistent: true,
    nativeChallengeStatus: 503,
  });
  try {
    const run = await trigger("check", { topicId: 2401 });
    assert.equal(run.status, "completed", JSON.stringify(run));
    const output = run.result?.output as Record<string, unknown>;
    assert.equal(output.availability, "unknown");
    const summary = output.challengeRecovery as {
      rounds: number;
      elapsedMs: number;
      successes: number;
    };
    assert.equal(summary.rounds, 1);
    assert.equal(summary.successes, 0);
    assert.match(
      JSON.stringify(output.problems),
      /恢复.*预算/u,
      "恢复耗尽后，诊断应说明自动恢复及预算原因",
    );
    assert.ok(
      summary.elapsedMs >= 29_000 && summary.elapsedMs < 31_500,
      JSON.stringify(summary),
    );
    const after = await sourceState();
    assert.equal(
      after.events.filter(({ action }) => action === "challenge-click").length -
        previousClicks,
      2,
    );
    const failed = await trigger("collect", { topicId: 2401 });
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    assert.equal(failed.result?.output, undefined);
    assert.equal(failed.result?.error?.requiresHuman, true);
    assert.match(failed.result?.error?.message ?? "", /恢复.*预算/u);
  } finally {
    await updateFixtureState({
      nativeChallenge: false,
      nativeChallengePersistent: false,
      nativeChallengeStatus: 403,
    });
  }
}

async function verifyTopicArchive(
  firstCollection: ManualRun,
  firstItemIds: readonly string[],
): Promise<void> {
  const root = await searchArchiveItem("主题正文版本 1");
  assert.ok(firstItemIds.includes(root.itemId));
  const titleOnlySearch = await searchArchiveItem("受控主题标题版本 1");
  assert.equal(titleOnlySearch.itemId, root.itemId);
  assert.equal(titleOnlySearch.sourceKey.key, "post:240001");
  const firstReply = await searchArchiveItem("回复正文版本 1");
  const unchangedReply = await searchArchiveItem("保持不变的另一条回复");
  const rootState = binState(root);
  assert.deepEqual(root.sourceKey, {
    namespace: "linuxdo:linuxdo-e2e-source:8081",
    key: "post:240001",
  });
  assert.equal(rootState.capture.completeness, "complete");
  assert.deepEqual(rootState.capture.missing, []);
  assert.equal(rootState.capture.scope.postNumber, 1);
  assert.equal(rootState.title, "受控主题标题版本 1");
  assert.deepEqual(rootState.sourcePublishedAt, {
    precision: "instant",
    value: "2026-10-28T01:00:00.000Z",
  });
  assert.deepEqual(rootState.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T00:00:01.000Z",
  });
  assert.equal(rootState.extensions.postNumber, 1);
  assert.equal(rootState.extensions.categoryId, 42);
  assert.deepEqual(rootState.extensions.tags, ["受控", "归档"]);
  const topicMetadata = rootState.extensions.topic;
  assert.ok(topicMetadata !== null && typeof topicMetadata === "object");
  assert.deepEqual(topicMetadata, {
    slug: "controlled-linuxdo-topic",
    createdAt: "2026-10-28T00:00:00.000Z",
  });
  assert.equal(rootState.extensions.authorUsername, "fixture-author");
  assert.equal(rootState.extensions.authorName, "Linux.do 示例作者");
  assert.equal(rootState.body?.html, undefined);
  assert.ok(rootState.body?.markdown?.includes("binny://resource/"));
  assert.equal(rootState.resources?.length, 3);
  const storedResources = await Promise.all(
    (rootState.resources ?? []).map(({ resourceId }) =>
      assertStoredResource(resourceId),
    ),
  );
  const resourceTypes = storedResources.map(({ contentType }) => contentType);
  assert.deepEqual(resourceTypes.toSorted(), [
    "application/json",
    "application/pdf",
    "image/png",
  ]);
  const pdfResourceIndex = resourceTypes.indexOf("application/pdf");
  assert.ok(pdfResourceIndex >= 0);
  const pdfResource = rootState.resources?.[pdfResourceIndex];
  assert.ok(pdfResource !== undefined);
  assert.ok(
    rootState.body?.markdown?.includes(
      `binny://resource/${pdfResource.resourceId}`,
    ),
    rootState.body?.markdown,
  );
  const jsonResourceIndex = resourceTypes.indexOf("application/json");
  assert.ok(jsonResourceIndex >= 0);
  const jsonResource = rootState.resources?.[jsonResourceIndex];
  assert.ok(jsonResource !== undefined);
  const storedJson = storedResources[jsonResourceIndex];
  assert.ok(storedJson !== undefined);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(storedJson.bytes)) as unknown,
    { topic: "linuxdo-fixture" },
  );
  assert.ok(
    rootState.body?.markdown?.includes(
      `binny://resource/${jsonResource.resourceId}`,
    ),
    rootState.body?.markdown,
  );
  const imageResourceIndex = resourceTypes.indexOf("image/png");
  assert.ok(imageResourceIndex >= 0);
  const imageResource = rootState.resources?.[imageResourceIndex];
  assert.ok(imageResource !== undefined);
  assert.ok(
    rootState.body?.markdown?.includes(
      `![主题封面](binny://resource/${imageResource.resourceId})`,
    ),
    rootState.body?.markdown,
  );
  assert.ok(!rootState.body?.markdown?.includes("topic-photo-download-hash"));
  assert.ok(
    !rootState.body?.markdown?.includes("srcset="),
    rootState.body?.markdown,
  );
  assert.ok(
    !rootState.body?.markdown?.includes("topic-photo-small.webp") &&
      !rootState.body?.markdown?.includes("topic-photo-large.webp"),
    rootState.body?.markdown,
  );
  assert.ok(
    firstCollection.result?.output?.completedScopes?.includes("topic:2401"),
  );
  assert.deepEqual(firstCollection.result?.output?.completedScopes, [
    "post:240001",
    "post:240002",
    "post:240003",
    "topic:2401",
  ]);

  const firstReplyState = binState(firstReply);
  assert.equal(firstReplyState.capture.scope.postNumber, 2);
  assert.equal(firstReplyState.title, null);
  assert.deepEqual(firstReplyState.sourcePublishedAt, {
    precision: "instant",
    value: "2026-10-28T02:00:00.000Z",
  });
  assert.deepEqual(firstReplyState.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T01:00:01.000Z",
  });
  assert.equal(firstReplyState.extensions.postNumber, 2);
  assert.equal(firstReplyState.extensions.topicId, 2401);
  const replyTopicContext = firstReplyState.extensions.topic;
  assert.ok(
    typeof replyTopicContext === "object" && replyTopicContext !== null,
  );
  assert.equal(
    (replyTopicContext as Record<string, unknown>).title,
    "受控主题标题版本 1",
  );
  assert.equal(firstReplyState.resources?.length, 1);
  assert.equal(binState(unchangedReply).capture.scope.postNumber, 3);

  const initialRootRevisionCount = root.revisions.length;
  const firstRootRevision = root.revisions[0];
  assert.ok(firstRootRevision !== undefined);
  const firstRootState = await readArchiveRevision(
    firstRootRevision.revisionId,
  );
  const initialUnchangedRevisionCount = unchangedReply.revisions.length;
  const relationsBeforeDuplicate = await readOutgoingRelations(root.itemId);
  assert.equal(relationsBeforeDuplicate.length, 2);
  assert.ok(
    relationsBeforeDuplicate.every(
      ({ status, state }) =>
        status === "observed" && state?.name === "topic_reply" && state.cascade,
    ),
  );
  assert.deepEqual(
    relationsBeforeDuplicate
      .map(({ state }) => state?.to.sourceKey?.key)
      .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["post:240002", "post:240003"],
  );

  await updateFixtureState({ legacyTags: true });
  await collectTopic();
  const duplicateRoot = await readArchiveItem(root.itemId);
  const duplicateExtensions = binState(duplicateRoot).extensions;
  const duplicateTopicMetadata = duplicateExtensions.topic;
  assert.ok(
    duplicateTopicMetadata !== null &&
      typeof duplicateTopicMetadata === "object",
  );
  assert.deepEqual(duplicateExtensions.tags, ["受控", "归档"]);
  assert.equal(
    duplicateRoot.revisions.length,
    initialRootRevisionCount,
    JSON.stringify({
      previous: firstRootState.state,
      current: await Promise.all(
        duplicateRoot.revisions.map(({ revisionId }) =>
          readArchiveRevision(revisionId),
        ),
      ),
    }),
  );
  assert.ok(duplicateRoot.observations.length > root.observations.length);
  const duplicateUnchanged = await readArchiveItem(unchangedReply.itemId);
  assert.equal(
    duplicateUnchanged.revisions.length,
    initialUnchangedRevisionCount,
  );

  await updateFixtureState({ topicVersion: 2, replyVersion: 2 });
  await collectTopic();
  const editedRoot = await readArchiveItem(root.itemId);
  const editedFirstReply = await readArchiveItem(firstReply.itemId);
  const editedUnchangedReply = await readArchiveItem(unchangedReply.itemId);
  assert.equal(editedRoot.revisions.length, initialRootRevisionCount + 1);
  assert.equal(
    editedFirstReply.revisions.length,
    firstReply.revisions.length + 1,
  );
  const editedRootState = binState(editedRoot);
  assert.equal(editedRootState.title, "受控主题标题版本 2");
  assert.deepEqual(
    editedRootState.sourcePublishedAt,
    rootState.sourcePublishedAt,
  );
  assert.deepEqual(editedRootState.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T00:00:02.000Z",
  });
  assert.equal(
    "title" in (editedRootState.extensions.topic as Record<string, unknown>),
    false,
  );
  const editedFirstReplyState = binState(editedFirstReply);
  assert.equal(editedFirstReplyState.title, null);
  assert.deepEqual(
    editedFirstReplyState.sourcePublishedAt,
    firstReplyState.sourcePublishedAt,
  );
  assert.deepEqual(editedFirstReplyState.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T01:00:02.000Z",
  });
  assert.equal(
    (editedFirstReplyState.extensions.topic as Record<string, unknown>).title,
    "受控主题标题版本 2",
  );
  assert.equal(
    editedUnchangedReply.revisions.length,
    initialUnchangedRevisionCount + 1,
  );
  const initialUnchangedState = binState(unchangedReply);
  const editedUnchangedState = binState(editedUnchangedReply);
  assert.equal(editedUnchangedState.title, null);
  assert.equal(
    editedUnchangedState.body?.text,
    initialUnchangedState.body?.text,
  );
  assert.deepEqual(
    editedUnchangedState.sourcePublishedAt,
    initialUnchangedState.sourcePublishedAt,
  );
  assert.deepEqual(
    editedUnchangedState.sourceModifiedAt,
    initialUnchangedState.sourceModifiedAt,
  );
  assert.equal(
    (editedUnchangedState.extensions.topic as Record<string, unknown>).title,
    "受控主题标题版本 2",
  );
  assert.equal(
    binState(editedRoot).body?.text?.includes("主题正文版本 2"),
    true,
  );
  assert.equal(
    binState(editedFirstReply).body?.text?.includes("回复正文版本 2"),
    true,
  );

  await updateFixtureState({ addedReply: true });
  const addedReplyRun = await collectTopic();
  assert.ok(
    addedReplyRun.result?.output?.completedScopes?.includes("post:240004"),
  );
  const addedReply = await searchArchiveItem("后来新增的回复");
  assert.equal(addedReply.sourceKey.key, "post:240004");
  assert.equal(
    (await readArchiveItem(root.itemId)).revisions.length,
    initialRootRevisionCount + 1,
  );
  assert.equal((await readOutgoingRelations(root.itemId)).length, 3);

  await updateFixtureState({ omittedPostIds: [240003] });
  const finiteReadRun = await collectTopic();
  assert.equal(
    finiteReadRun.result?.output?.completedScopes?.includes("topic:2401"),
    false,
  );
  assert.equal(
    finiteReadRun.result?.output?.completedScopes?.includes("post:240003"),
    false,
  );
  const finiteRoot = await readArchiveItem(root.itemId);
  const finiteView = finiteRoot.views.find(
    ({ binId }) => binId === "binny-discovery-topic",
  );
  assert.ok(
    finiteView?.diagnostics?.some(
      ({ code }) => code === "discourse_posts_missing",
    ),
  );
  assert.equal((await readOutgoingRelations(root.itemId)).length, 3);

  await updateFixtureState({
    omittedPostIds: [],
    unavailableMedia: ["/uploads/default/original/2X/topic-photo.png"],
    unavailableMediaStatus: 503,
  });
  const mediaPartialRun = await collectTopic();
  assert.equal(
    mediaPartialRun.result?.output?.completedScopes?.includes("topic:2401"),
    false,
  );
  const partialRoot = await readArchiveItem(root.itemId);
  const partialRootState = binState(partialRoot);
  assert.equal(partialRootState.capture.completeness, "partial");
  const missingPhoto = partialRootState.capture.missing.find(
    ({ path }) => path === "body.images[0]",
  );
  assert.ok(missingPhoto !== undefined);
  assert.equal(missingPhoto.reason, "媒体资源未能归档。");
  assert.equal(partialRootState.resources?.length, 2);
  const partialRootView = partialRoot.views.find(
    ({ binId }) => binId === "binny-discovery-topic",
  );
  assert.ok(
    partialRootView?.diagnostics?.some(
      ({ code, message }) =>
        code === "linuxdo_media_unavailable" && message.includes("HTTP 503"),
    ),
  );
  const missingState = partialRootState;
  const missingRevisionCount = partialRoot.revisions.length;
  const missingObservationCount = partialRoot.observations.length;

  await updateFixtureState({ unavailableMediaStatus: 502 });
  await collectTopic();
  const retriedMissingRoot = await readArchiveItem(root.itemId);
  assert.deepEqual(binState(retriedMissingRoot), missingState);
  assert.equal(retriedMissingRoot.revisions.length, missingRevisionCount);
  assert.equal(
    retriedMissingRoot.observations.length,
    missingObservationCount + 1,
  );
  const retriedMissingView = retriedMissingRoot.views.find(
    ({ binId }) => binId === "binny-discovery-topic",
  );
  assert.ok(
    retriedMissingView?.diagnostics?.some(
      ({ code, message }) =>
        code === "linuxdo_media_unavailable" && message.includes("HTTP 502"),
    ),
  );

  await updateFixtureState({ challengeMedia: true });
  const challengedMediaRun = await collectTopic();
  assert.equal(
    challengedMediaRun.result?.output?.completedScopes?.includes("topic:2401"),
    false,
  );
  const challengedRoot = await readArchiveItem(root.itemId);
  const challengedRootState = binState(challengedRoot);
  assert.ok(
    challengedRootState.capture.missing.some(
      ({ path }) => path === "body.attachments[2]",
    ),
  );
  assert.equal(challengedRootState.resources?.length, 2);
  const challengedRootView = challengedRoot.views.find(
    ({ binId }) => binId === "binny-discovery-topic",
  );
  assert.ok(
    challengedRootView?.diagnostics?.some(
      ({ code, message, details }) =>
        code === "linuxdo_media_unavailable" &&
        message.includes("页面") &&
        details?.path === "body.attachments[2]",
    ),
  );
  assert.ok(
    challengedRootState.body?.markdown?.includes(
      "/uploads/default/original/2X/topic-photo.png",
    ),
    challengedRootState.body?.markdown,
  );
  const challengedRevisionCount = challengedRoot.revisions.length;
  await updateFixtureState({ unavailableMedia: [] });
  await collectTopic();
  const backfilledRoot = await readArchiveItem(root.itemId);
  const backfilledRootState = binState(backfilledRoot);
  assert.equal(backfilledRoot.revisions.length, challengedRevisionCount + 1);
  assert.equal(backfilledRootState.capture.completeness, "partial");
  assert.ok(
    backfilledRootState.capture.missing.some(
      ({ path }) => path === "body.attachments[2]",
    ),
  );
  assert.ok(
    !backfilledRootState.capture.missing.some(
      ({ path }) => path === "body.images[0]",
    ),
  );
  assert.equal(backfilledRootState.resources?.length, 3);
  assert.ok(
    backfilledRootState.body?.markdown?.includes(
      "![主题封面](binny://resource/",
    ),
  );
  assert.ok(
    !backfilledRootState.body?.markdown?.includes(
      "/uploads/default/original/2X/topic-photo.png",
    ),
    backfilledRootState.body?.markdown,
  );
  assert.equal((await readOutgoingRelations(root.itemId)).length, 3);
  await updateFixtureState({
    nativeChallengeMedia: true,
    challengeMedia: false,
  });
  try {
    const recoveredMediaRun = await collectTopic();
    const mediaOutput = recoveredMediaRun.result?.output;
    assert.ok(mediaOutput !== undefined);
    const recovery = (mediaOutput as Record<string, unknown>)
      .challengeRecovery as {
      rounds: number;
      successes: number;
    };
    assert.equal(recovery.rounds, 1);
    assert.equal(recovery.successes, 1);
    const recovered = binState(await readArchiveItem(root.itemId));
    assert.equal(recovered.capture.completeness, "complete");
    assert.equal(recovered.resources?.length, 3);
    assert.ok(
      recovered.body?.markdown?.includes("![主题封面](binny://resource/"),
    );
    await updateFixtureState({
      nativeChallengeMedia: true,
      nativeChallengeNavigationDelayMs: 35_000,
    });
    const navigationTimeout = await collectTopic();
    const navigationEvents = await sourceState();
    assert.ok(
      navigationEvents.events.some(
        ({ action, path }) =>
          action === "challenge-navigation" && path.includes("topic-photo.png"),
      ),
    );
    const afterTimeout = binState(await readArchiveItem(root.itemId));
    assert.equal(afterTimeout.capture.completeness, "partial");
    assert.equal(
      afterTimeout.resources?.length,
      2,
      "导航超时后仍应能下载其余同源附件",
    );
    assert.ok(
      afterTimeout.capture.missing.some(
        ({ path }) => path === "body.images[0]",
      ),
    );
    assert.equal(
      navigationTimeout.result?.output?.collectionCompleteness,
      "partial",
    );
  } finally {
    await updateFixtureState({
      nativeChallengeMedia: false,
      nativeChallengeNavigationDelayMs: 0,
    });
  }
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function timeZoneWithRoomAroundNow(): string {
  const now = Date.now();
  for (const timeZone of ["UTC", "Etc/GMT+12"]) {
    const currentDay = localDateKey(new Date(now), timeZone);
    if (
      localDateKey(new Date(now - 60_000), timeZone) === currentDay &&
      localDateKey(new Date(now + 120_000), timeZone) === currentDay
    ) {
      return timeZone;
    }
  }
  assert.fail("无法为 referenceTime 边界选择有余量的固定时区。");
}

async function waitForManualRun(runId: string): Promise<ManualRun> {
  const deadline = Date.now() + 90_000;
  let latest: ManualRun | undefined;
  while (Date.now() < deadline) {
    latest = cliData<ManualRun>(
      await cli(["run", "get", "binny-discovery-topic", runId]),
      "found",
    );
    if (
      latest.status === "completed" ||
      latest.status === "failed" ||
      latest.status === "cancelled"
    )
      return latest;
    await delay(100);
  }
  assert.fail(`等待运行终结超时：${JSON.stringify(latest)}`);
}

async function waitFor<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 90_000;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (isReady(latest)) return latest;
    await delay(250);
  }
  assert.fail(`等待${description}超时：${JSON.stringify(latest)}`);
}

async function verifyCollectionDateWindows(): Promise<void> {
  await updateFixtureState({
    discoveryAddedReply: true,
    topicCreatedAtOverrides: {
      2401: "2026-10-26T00:00:00.000Z",
      2402: "2026-10-27T23:59:59.999Z",
      2403: "2026-10-28T00:00:00.000Z",
      2404: "2026-10-26T23:59:59.999Z",
      2410: "2026-10-27T00:00:00.000Z",
    },
  });
  const eventsBeforeFixedDate = (await sourceState()).events.length;
  const fixedDate = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    date: "2026-10-27",
    timeZone: "UTC",
    maxTopics: 10,
  });
  assert.equal(fixedDate.status, "completed", JSON.stringify(fixedDate));
  const fixedScopes = fixedDate.result?.output?.completedScopes ?? [];
  assert.ok(fixedScopes.includes("topic:2410"));
  assert.ok(fixedScopes.includes("post:241000"));
  assert.ok(fixedScopes.includes("topic:2402"));
  assert.ok(fixedScopes.includes("post:240200"));
  assert.ok(!fixedScopes.includes("topic:2401"));
  assert.ok(!fixedScopes.includes("post:240005"));
  assert.ok(!fixedScopes.includes("topic:2403"));
  assert.ok(!fixedScopes.includes("topic:2404"));
  const fixedDateEvents = (await sourceState()).events.slice(
    eventsBeforeFixedDate,
  );
  assert.ok(
    !fixedDateEvents.some(
      ({ action, path }) => action === "topic" && path === "/t/2401.json",
    ),
    "旧主题即使有新回复，也不应读取并进入固定日期运行。",
  );

  await updateFixtureState({
    topicCreatedAtOverrides: {
      2401: "2026-03-08T04:59:59.999Z",
      2402: "2026-03-08T05:00:00.000Z",
      2403: "2026-03-09T03:59:59.999Z",
      2404: "2026-03-09T04:00:00.000Z",
      2410: "2026-03-08T05:00:00.000Z",
    },
  });
  const dstDate = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    date: "2026-03-08",
    timeZone: "America/New_York",
    maxTopics: 10,
  });
  assert.equal(dstDate.status, "completed", JSON.stringify(dstDate));
  const dstScopes = dstDate.result?.output?.completedScopes ?? [];
  assert.ok(dstScopes.includes("topic:2402"));
  assert.ok(dstScopes.includes("topic:2403"));
  assert.ok(dstScopes.includes("topic:2410"));
  assert.ok(!dstScopes.includes("topic:2401"));
  assert.ok(!dstScopes.includes("topic:2404"));

  await updateFixtureState({
    topicCreatedAtOverrides: {
      2401: "2026-11-01T03:59:59.999Z",
      2402: "2026-11-01T04:00:00.000Z",
      2403: "2026-11-02T04:59:59.999Z",
      2404: "2026-11-02T05:00:00.000Z",
      2410: "2026-11-01T04:00:00.000Z",
    },
  });
  const dstFallDate = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    date: "2026-11-01",
    timeZone: "America/New_York",
    maxTopics: 10,
  });
  assert.equal(dstFallDate.status, "completed", JSON.stringify(dstFallDate));
  const dstFallScopes = dstFallDate.result?.output?.completedScopes ?? [];
  assert.ok(dstFallScopes.includes("topic:2402"));
  assert.ok(dstFallScopes.includes("topic:2403"));
  assert.ok(dstFallScopes.includes("topic:2410"));
  assert.ok(!dstFallScopes.includes("topic:2401"));
  assert.ok(!dstFallScopes.includes("topic:2404"));

  const eventsBeforeFutureDate = (await sourceState()).events.length;
  const futureDate = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    date: "2099-01-01",
    timeZone: "UTC",
  });
  assert.equal(futureDate.status, "failed", JSON.stringify(futureDate));
  assert.equal(
    futureDate.result?.error?.code,
    "linuxdo_collection_date_in_future",
  );
  assert.equal(
    (await sourceState()).events
      .slice(eventsBeforeFutureDate)
      .filter(({ action }) => action === "topic-list" || action === "topic")
      .length,
    0,
    "未来日期必须在访问 Linux.do 前失败。",
  );

  const timeZone = timeZoneWithRoomAroundNow();
  await updateFixtureState({
    topicListDelayMs: 5_000,
    topicCreatedAtOverrides: {},
  });
  const eventsBeforeBlocker = await sourceState();
  const blocker = cliData<ManualRun>(
    await cli([
      "run",
      "trigger",
      "binny-discovery-topic",
      "collect",
      "--params",
      JSON.stringify({
        targets: linuxdoTargets("latest"),
        date: "yesterday",
        timeZone,
        maxTopics: 1,
      }),
    ]),
    "triggered",
  );
  assert.equal(blocker.status, "queued");
  await waitForSourceEvent(
    "topic-list",
    eventsBeforeBlocker.events.filter(({ action }) => action === "topic-list")
      .length + 1,
  );

  const todayQueued = cliData<ManualRun>(
    await cli([
      "run",
      "trigger",
      "binny-discovery-topic",
      "collect",
      "--params",
      JSON.stringify({
        targets: linuxdoTargets("latest"),
        date: "today",
        timeZone,
        maxTopics: 10,
      }),
    ]),
    "triggered",
  );
  assert.equal(todayQueued.status, "queued");
  assert.ok(todayQueued.referenceTime !== undefined);
  const referenceMilliseconds = Date.parse(todayQueued.referenceTime);
  assert.ok(Number.isFinite(referenceMilliseconds));
  const referenceDay = localDateKey(new Date(referenceMilliseconds), timeZone);
  const beforeReferenceTime = new Date(
    referenceMilliseconds - 1_000,
  ).toISOString();
  const atReferenceTime = new Date(referenceMilliseconds).toISOString();
  assert.equal(
    localDateKey(new Date(beforeReferenceTime), timeZone),
    referenceDay,
  );
  assert.equal(localDateKey(new Date(atReferenceTime), timeZone), referenceDay);
  await updateFixtureState({
    topicListDelayMs: 0,
    topicCreatedAtOverrides: {
      2401: new Date(referenceMilliseconds - 2_000).toISOString(),
      2402: beforeReferenceTime,
      2403: atReferenceTime,
    },
  });

  const completedBlocker = await waitForManualRun(blocker.runId);
  assert.equal(
    completedBlocker.status,
    "completed",
    JSON.stringify(completedBlocker),
  );
  const todayRun = await waitForManualRun(todayQueued.runId);
  assert.equal(todayRun.status, "completed", JSON.stringify(todayRun));
  assert.equal(todayRun.referenceTime, todayQueued.referenceTime);
  const todayScopes = todayRun.result?.output?.completedScopes ?? [];
  assert.ok(todayScopes.includes("topic:2401"));
  assert.ok(todayScopes.includes("topic:2402"));
  assert.ok(!todayScopes.includes("topic:2403"));

  await updateFixtureState({
    topicListDelayMs: 0,
    topicCreatedAtOverrides: {},
  });
}

async function verifyDiscovery(): Promise<void> {
  await updateFixtureState({
    topicVersion: 3,
    replyVersion: 3,
    discoveryAddedReply: true,
    challengeMedia: false,
    unavailableMedia: [],
    unavailableTopicIds: [],
  });

  await updateFixtureState({ targetUnavailablePage: 0 });
  const unavailableListCheck = await trigger("check", {
    targets: linuxdoTargets("latest"),
  });
  assert.equal(
    unavailableListCheck.status,
    "completed",
    JSON.stringify(unavailableListCheck),
  );
  assert.equal(checkOutput(unavailableListCheck).availability, "unavailable");
  assert.deepEqual(checkOutput(unavailableListCheck).scope, ["target:latest"]);
  assert.ok(
    checkOutput(unavailableListCheck).problems.some(
      ({ code, requiresHuman }) =>
        code === "discourse_target_unavailable" && !requiresHuman,
    ),
  );
  assert.equal(unavailableListCheck.result?.commits?.length ?? 0, 0);

  await updateFixtureState({
    targetUnavailablePage: null,
    targetChallengePage: 0,
  });
  const challengedListCheck = await trigger("check", {
    targets: linuxdoTargets("latest"),
  });
  assert.equal(
    challengedListCheck.status,
    "completed",
    JSON.stringify(challengedListCheck),
  );
  assert.equal(checkOutput(challengedListCheck).availability, "unknown");
  assert.deepEqual(checkOutput(challengedListCheck).scope, ["target:latest"]);
  assert.ok(
    checkOutput(challengedListCheck).problems.some(
      ({ code, requiresHuman }) =>
        code === "discourse_target_challenge_response" && requiresHuman,
    ),
  );
  assert.equal(challengedListCheck.result?.commits?.length ?? 0, 0);
  await updateFixtureState({ targetChallengePage: null });

  await updateFixtureState({ targetInvalidResponsePage: 0 });
  const invalidListCheck = await trigger("check", {
    targets: linuxdoTargets("latest"),
  });
  assert.equal(
    invalidListCheck.status,
    "completed",
    JSON.stringify(invalidListCheck),
  );
  assert.equal(checkOutput(invalidListCheck).availability, "unknown");
  assert.deepEqual(checkOutput(invalidListCheck).scope, ["target:latest"]);
  assert.ok(
    checkOutput(invalidListCheck).problems.some(
      ({ code, requiresHuman, suggestion }) =>
        code === "discourse_topic_list_response_invalid" &&
        !requiresHuman &&
        suggestion !== undefined,
    ),
    JSON.stringify(invalidListCheck),
  );
  assert.equal(invalidListCheck.result?.commits?.length ?? 0, 0);
  await updateFixtureState({ targetInvalidResponsePage: null });

  const beforeCheck = await sourceState();
  const latestCheck = await trigger("check", {
    targets: linuxdoTargets("latest"),
  });
  assert.equal(latestCheck.status, "completed", JSON.stringify(latestCheck));
  assert.equal(checkOutput(latestCheck).availability, "available");
  assert.deepEqual(checkOutput(latestCheck).scope, ["target:latest"]);
  const afterCheck = await sourceState();
  const latestPage = afterCheck.events
    .filter(
      ({ action, path }) =>
        action === "topic-list" && path.startsWith("/latest.json"),
    )
    .at(-1);
  assert.ok(latestPage !== undefined);
  assert.equal(latestPage.authenticated, true);
  assert.ok(latestPage.path.includes("per_page=1"));
  assert.ok(afterCheck.events.length > beforeCheck.events.length);

  const categoryCheck = await trigger("check", {
    targets: linuxdoTargets("category"),
  });
  assert.equal(
    categoryCheck.status,
    "completed",
    JSON.stringify(categoryCheck),
  );
  assert.equal(checkOutput(categoryCheck).availability, "available");
  assert.deepEqual(checkOutput(categoryCheck).scope, ["target:category-42"]);
  const afterCategoryCheck = await sourceState();
  const categoryCheckPage = afterCategoryCheck.events
    .filter(
      ({ action, path }) =>
        action === "topic-list" &&
        path.startsWith("/c/controlled/42/l/latest.json"),
    )
    .at(-1);
  assert.ok(categoryCheckPage !== undefined);
  assert.ok(categoryCheckPage.path.includes("per_page=1"));

  const beforeCollection = await sourceState();
  const collection = await trigger("collect", {
    targets: linuxdoTargets("latest", "category"),
    maxTopics: 15,
  });
  assert.equal(collection.status, "completed", JSON.stringify(collection));
  assert.ok(
    collection.result?.output?.completedScopes?.includes("target:latest"),
  );
  assert.ok(
    collection.result?.output?.completedScopes?.includes("target:category-42"),
  );
  assert.ok(collection.result?.output?.completedScopes?.includes("topic:2401"));
  assert.ok(
    collection.result?.output?.completedScopes?.includes("post:240005"),
  );

  const afterCollection = await sourceState();
  const newTopicRequests = afterCollection.events
    .slice(beforeCollection.events.length)
    .filter(({ action }) => action === "topic")
    .map(({ path }) => path);
  assert.deepEqual(newTopicRequests.toSorted(), [
    "/t/2401.json",
    "/t/2402.json",
    "/t/2403.json",
    "/t/2404.json",
    "/t/2405.json",
    "/t/2406.json",
    "/t/2407.json",
    "/t/2408.json",
    "/t/2409.json",
    "/t/2410.json",
    "/t/2499.json",
  ]);
  assert.ok(
    afterCollection.events.some(
      ({ action, path, authenticated }) =>
        action === "topic-list" &&
        path.startsWith("/c/controlled/42/l/latest.json") &&
        authenticated === true,
    ),
  );

  const beforePaginatedCollection = await sourceState();
  const paginatedCollection = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    maxTopics: 10,
  });
  assert.equal(
    paginatedCollection.status,
    "completed",
    JSON.stringify(paginatedCollection),
  );
  assert.ok(
    paginatedCollection.result?.output?.completedScopes?.includes(
      "target:latest",
    ),
  );
  const afterPaginatedCollection = await sourceState();
  const paginatedEvents = afterPaginatedCollection.events.slice(
    beforePaginatedCollection.events.length,
  );
  assert.ok(
    paginatedEvents.some(
      ({ action, path, authenticated }) =>
        action === "topic-list" &&
        path.startsWith("/latest.json?page=1") &&
        authenticated === true,
    ),
  );
  assert.deepEqual(
    paginatedEvents
      .filter(({ action }) => action === "topic")
      .map(({ path }) => path)
      .toSorted(),
    [
      "/t/2401.json",
      "/t/2402.json",
      "/t/2403.json",
      "/t/2404.json",
      "/t/2405.json",
      "/t/2406.json",
      "/t/2407.json",
      "/t/2408.json",
      "/t/2409.json",
      "/t/2410.json",
    ],
  );

  const beforeCategoryPagination = await sourceState();
  const categoryPagination = await trigger("collect", {
    targets: linuxdoTargets("category"),
    maxTopics: 10,
  });
  assert.equal(
    categoryPagination.status,
    "completed",
    JSON.stringify(categoryPagination),
  );
  assert.ok(
    categoryPagination.result?.output?.completedScopes?.includes(
      "target:category-42",
    ),
  );
  assert.equal(
    categoryPagination.result?.output?.collectionCompleteness,
    "partial",
  );
  assert.deepEqual(
    categoryPagination.result?.output?.incompleteScopes?.map(
      ({ scope, reasonCode }) => ({ scope, reasonCode }),
    ),
    [{ scope: "target:category-43", reasonCode: "topic_limit_reached" }],
  );
  const afterCategoryPagination = await sourceState();
  const categoryPaginationEvents = afterCategoryPagination.events.slice(
    beforeCategoryPagination.events.length,
  );
  assert.ok(
    categoryPaginationEvents.some(
      ({ action, path, authenticated }) =>
        action === "topic-list" &&
        path.startsWith("/c/controlled/42/l/latest.json?page=1") &&
        authenticated === true,
    ),
  );
  assert.deepEqual(
    categoryPaginationEvents
      .filter(({ action }) => action === "topic")
      .map(({ path }) => path)
      .toSorted(),
    [
      "/t/2401.json",
      "/t/2402.json",
      "/t/2403.json",
      "/t/2404.json",
      "/t/2405.json",
      "/t/2406.json",
      "/t/2407.json",
      "/t/2408.json",
      "/t/2409.json",
      "/t/2410.json",
    ],
  );

  await updateFixtureState({ targetInvalidPaginationUrlPage: 0 });
  const invalidPagination = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    maxTopics: 10,
  });
  assert.equal(
    invalidPagination.status,
    "failed",
    JSON.stringify(invalidPagination),
  );
  assert.equal(
    invalidPagination.result?.error?.code,
    "discourse_topic_list_pagination_invalid",
  );
  assert.ok(
    invalidPagination.result?.error?.impact?.includes("target:latest"),
    JSON.stringify(invalidPagination),
  );
  assert.ok(
    invalidPagination.result?.completedScopes?.includes("post:240001"),
    JSON.stringify(invalidPagination),
  );

  await updateFixtureState({
    targetInvalidPaginationUrlPage: null,
    targetEarlyEndPage: 1,
  });
  const earlyEnd = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    maxTopics: 10,
  });
  assert.equal(earlyEnd.status, "failed", JSON.stringify(earlyEnd));
  assert.equal(
    earlyEnd.result?.error?.code,
    "discourse_topic_list_ended_early",
  );
  assert.ok(
    earlyEnd.result?.error?.impact?.includes("target:latest"),
    JSON.stringify(earlyEnd),
  );
  await updateFixtureState({ targetEarlyEndPage: null });

  await updateFixtureState({ targetPaginationLoopPage: 1 });
  const paginationLoop = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    maxTopics: 10,
  });
  assert.equal(paginationLoop.status, "failed", JSON.stringify(paginationLoop));
  assert.equal(
    paginationLoop.result?.error?.code,
    "discourse_topic_list_pagination_loop",
  );
  assert.ok(
    paginationLoop.result?.error?.impact?.includes("target:latest"),
    JSON.stringify(paginationLoop),
  );
  await updateFixtureState({ targetPaginationLoopPage: null });

  await updateFixtureState({ targetUnavailablePage: 1 });
  const unavailableTargetCollection = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    maxTopics: 1,
  });
  assert.equal(unavailableTargetCollection.status, "failed");
  assert.equal(
    unavailableTargetCollection.result?.error?.code,
    "discourse_target_unavailable",
  );
  assert.equal(unavailableTargetCollection.result?.error?.requiresHuman, false);
  assert.ok(
    unavailableTargetCollection.result?.error?.impact?.includes(
      "target:latest",
    ),
    JSON.stringify(unavailableTargetCollection),
  );
  assert.ok(
    unavailableTargetCollection.result?.completedScopes?.includes(
      "post:240001",
    ),
    JSON.stringify(unavailableTargetCollection),
  );
  assert.ok(
    unavailableTargetCollection.result?.completedScopes?.includes("topic:2401"),
  );

  await updateFixtureState({
    targetUnavailablePage: null,
    targetChallengePage: 1,
  });
  const challengedTargetCollection = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    maxTopics: 1,
  });
  assert.equal(challengedTargetCollection.status, "failed");
  assert.equal(
    challengedTargetCollection.result?.error?.code,
    "discourse_target_challenge_response",
  );
  assert.equal(challengedTargetCollection.result?.error?.requiresHuman, true);
  assert.ok(
    challengedTargetCollection.result?.error?.impact?.includes("target:latest"),
    JSON.stringify(challengedTargetCollection),
  );
  assert.ok(
    challengedTargetCollection.result?.completedScopes?.includes("post:240001"),
    JSON.stringify(challengedTargetCollection),
  );
  assert.ok(
    challengedTargetCollection.result?.completedScopes?.includes("topic:2401"),
  );
  await updateFixtureState({ targetChallengePage: null });

  await updateFixtureState({ targetInvalidResponsePage: 1 });
  const invalidTargetCollection = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    maxTopics: 1,
  });
  assert.equal(invalidTargetCollection.status, "failed");
  assert.equal(
    invalidTargetCollection.result?.error?.code,
    "discourse_topic_list_response_invalid",
  );
  assert.ok(
    invalidTargetCollection.result?.error?.impact?.includes("target:latest"),
    JSON.stringify(invalidTargetCollection),
  );
  assert.ok(
    invalidTargetCollection.result?.completedScopes?.includes("post:240001"),
    JSON.stringify(invalidTargetCollection),
  );
  assert.ok(
    invalidTargetCollection.result?.completedScopes?.includes("topic:2401"),
    JSON.stringify(invalidTargetCollection),
  );
  await updateFixtureState({ targetInvalidResponsePage: null });

  const editedRoot = await searchArchiveItem("主题正文版本 3");
  assert.ok(binState(editedRoot).body?.text?.includes("主题正文版本 3"));
  const addedReply = await searchArchiveItem("发现后新增的回复");
  assert.equal(addedReply.sourceKey.key, "post:240005");
  assert.ok(
    (await readOutgoingRelations(editedRoot.itemId)).some(
      ({ state }) => state?.to.sourceKey?.key === "post:240005",
    ),
  );

  await verifyCollectionDateWindows();

  const limited = await trigger("collect", {
    targets: linuxdoTargets("latest", "category"),
    maxTopics: 1,
  });
  assert.equal(limited.status, "completed", JSON.stringify(limited));
  assert.equal(limited.result?.output?.collectionCompleteness, "partial");
  assert.deepEqual(
    limited.result?.output?.incompleteScopes?.map(({ scope, reasonCode }) => ({
      scope,
      reasonCode,
    })),
    [
      { scope: "target:latest", reasonCode: "topic_limit_reached" },
      {
        scope: "target:category-42",
        reasonCode: "not_scanned_due_to_topic_limit",
      },
      {
        scope: "target:category-43",
        reasonCode: "not_scanned_due_to_topic_limit",
      },
    ],
  );

  await updateFixtureState({ unavailableTopicIds: [2402] });
  const failed = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    maxTopics: 3,
  });
  assert.equal(failed.status, "failed", JSON.stringify(failed));
  assert.equal(failed.result?.error?.code, "discourse_topic_unavailable");
  assert.equal(failed.result?.output, undefined);
  assert.equal(failed.report?.phase, "failed", JSON.stringify(failed));
  assert.equal(failed.report?.discovery, "complete", JSON.stringify(failed));
  assert.ok((failed.result?.commits?.length ?? 0) > 0, JSON.stringify(failed));
  assert.ok(
    failed.result?.completedScopes?.includes("topic:2401"),
    `失败运行应报告已提交的主题范围：${JSON.stringify(failed)}`,
  );
  assert.ok(
    failed.result?.completedScopes?.includes("post:240001"),
    `失败运行应报告已提交的帖子范围：${JSON.stringify(failed)}`,
  );
  await updateFixtureState({ unavailableTopicIds: [] });
}

async function verifyPostCreatedRangeCollection(): Promise<void> {
  await updateFixtureState({
    dailyCollectionEnabled: false,
    postRangeEnabled: true,
    postRangeAddAfterFirstPage: true,
    postRangeRepeatPage: false,
    postRangeInvalidPage: null,
    postRangePageSize: 2,
    topicVersion: 3,
    replyVersion: 3,
    topicCreatedAtOverrides: {
      2499: "2026-10-28T02:30:00.000Z",
    },
  });

  const mixedRange = {
    from: "2026-10-28T02:00:00.000Z",
    to: "2026-10-28T04:00:00.000Z",
  };
  const mixedTargetsCollected = await trigger("collect", {
    targets: linuxdoTargets("pinned", "category"),
    postCreatedRange: mixedRange,
  });
  assert.equal(
    mixedTargetsCollected.status,
    "completed",
    JSON.stringify(mixedTargetsCollected),
  );
  assert.equal(
    mixedTargetsCollected.result?.output?.collectionCompleteness,
    "complete",
    JSON.stringify(mixedTargetsCollected),
  );
  const mixedCategoryTopic = await searchArchiveItem("发现主题 2499");
  assert.equal(mixedCategoryTopic.sourceKey.key, "post:249900");
  const mixedCategoryReply = await searchArchiveItem("扫描期间插入的区间回复");
  assert.equal(mixedCategoryReply.sourceKey.key, "post:249901");
  assert.ok(
    mixedTargetsCollected.result?.output?.completedScopes?.includes(
      "post:249900",
    ),
  );
  assert.ok(
    mixedTargetsCollected.result?.output?.completedScopes?.includes(
      "post:249901",
    ),
  );

  await clearSourceEvents();
  const topicOnlyCollected = await trigger("collect", {
    targets: linuxdoTargets("pinned"),
    postCreatedRange: mixedRange,
  });
  assert.equal(
    topicOnlyCollected.status,
    "completed",
    JSON.stringify(topicOnlyCollected),
  );
  assert.equal(
    topicOnlyCollected.result?.output?.collectionCompleteness,
    "complete",
    JSON.stringify(topicOnlyCollected),
  );
  assert.ok(
    !topicOnlyCollected.result?.output?.completedScopes?.includes(
      "post:249900",
    ),
  );
  assert.ok(
    !(await sourceState()).events.some(
      ({ action, path }) => action === "topic" && path === "/t/2499.json",
    ),
    "仅选择主题2401时不得读取区间内未选中的主题2499。",
  );

  const before = await sourceState();
  const rangeParams = {
    targets: linuxdoTargets("latest"),
    postCreatedRange: {
      from: "2026-10-28T02:00:00.000Z",
      to: "2026-10-28T04:00:00.000Z",
    },
  };
  const collected = await trigger("collect", rangeParams);
  assert.equal(collected.status, "completed", JSON.stringify(collected));
  assert.equal(
    collected.result?.output?.collectionCompleteness,
    "complete",
    JSON.stringify(collected),
  );
  assert.deepEqual(collected.result?.output?.incompleteScopes, []);
  assert.equal(collected.report?.phase, "completed");
  assert.equal(collected.report?.discovery, "complete");
  assert.deepEqual(collected.report?.window, {
    from: "2026-10-28T02:00:00.000Z",
    to: "2026-10-28T04:00:00.000Z",
  });
  const reportIntent = collected.report?.intent as
    | { readonly postCreatedRange?: unknown }
    | undefined;
  assert.deepEqual(reportIntent?.postCreatedRange, {
    from: "2026-10-28T02:00:00.000Z",
    to: "2026-10-28T04:00:00.000Z",
    maxPages: 20,
  });

  const feedEvents = (await sourceState()).events
    .slice(before.events.length)
    .filter(({ action }) => action === "post-list");
  const beforeCursors = feedEvents.flatMap(({ path }) => {
    const value = /[?&]before=(\d+)/u.exec(path)?.[1];
    return value === undefined ? [] : [Number(value)];
  });
  assert.ok(feedEvents.length >= 7, JSON.stringify(feedEvents));
  assert.ok(beforeCursors.length >= 5, JSON.stringify(beforeCursors));
  assert.ok(
    beforeCursors.every(
      (cursor, index) => index === 0 || cursor < beforeCursors[index - 1]!,
    ),
    JSON.stringify(beforeCursors),
  );
  const sourceEvents = (await sourceState()).events.slice(before.events.length);
  assert.ok(
    sourceEvents.some(
      ({ action, path, authenticated }) =>
        action === "topic" && path === "/t/2401.json" && authenticated,
    ),
  );
  assert.ok(
    sourceEvents.some(
      ({ action, path, authenticated }) =>
        action === "topic" && path === "/t/2499.json" && authenticated,
    ),
  );
  assert.ok(
    !sourceEvents.some(
      ({ action, path }) =>
        action === "posts" && path.startsWith("/t/2401/posts.json"),
    ),
    "旧主题区间采集不得顺带读取整条主题帖子流。",
  );

  const oldTopicReply = await searchArchiveItem("区间新增回复内容");
  assert.equal(oldTopicReply.sourceKey.key, "post:240006");
  assert.equal(binState(oldTopicReply).capture.completeness, "complete");
  assert.ok(
    oldTopicReply.views[0]?.state.resources?.length,
    "区间回复的媒体应沿正式媒体归档路径保存。",
  );
  const newTopic = await searchArchiveItem("发现主题 2499");
  assert.equal(newTopic.sourceKey.key, "post:249900");
  const inserted = await searchArchiveItem("扫描期间插入的区间回复");
  assert.equal(inserted.sourceKey.key, "post:249901");
  assert.ok(collected.result?.output?.completedScopes?.includes("post:240002"));
  assert.ok(
    collected.result?.output?.completedScopes?.includes("context:post:240001"),
  );
  assert.ok(
    !collected.result?.output?.completedScopes?.includes("post:240001"),
    "区间外主帖仅作为上下文入档。",
  );
  const oldRoot = await searchArchiveItem("主题正文版本 3");
  assert.deepEqual(binState(oldRoot).sourcePublishedAt, {
    precision: "instant",
    value: "2026-10-28T01:00:00.000Z",
  });
  const rootRelations = await readOutgoingRelations(oldRoot.itemId);
  assert.ok(
    rootRelations.some(
      ({ state }) => state?.to.sourceKey?.key === "post:240002",
    ),
  );
  for (const rootShape of ["missing-cooked", "stream-only"] as const) {
    await updateFixtureState({
      postRangeAddAfterFirstPage: false,
      postRangeTopicRootShape: rootShape,
    });
    await clearSourceEvents();
    const rootSupplement = await trigger("collect", rangeParams);
    assert.equal(
      rootSupplement.status,
      "completed",
      JSON.stringify(rootSupplement),
    );
    assert.equal(
      rootSupplement.result?.output?.collectionCompleteness,
      "complete",
      JSON.stringify(rootSupplement),
    );
    assert.ok(
      rootSupplement.result?.output?.completedScopes?.includes(
        "context:post:240001",
      ),
      JSON.stringify(rootSupplement.result?.output?.completedScopes),
    );
    assert.ok(
      !rootSupplement.result?.output?.completedScopes?.includes("post:240001"),
      JSON.stringify(rootSupplement.result?.output?.completedScopes),
    );
    assert.ok(
      rootSupplement.result?.output?.completedScopes?.includes("post:240002"),
      JSON.stringify(rootSupplement.result?.output?.completedScopes),
    );
    const rootSupplementRequests = (await sourceState()).events.filter(
      ({ action, path }) =>
        action === "posts" && path.startsWith("/t/2401/posts.json"),
    );
    assert.ok(
      rootSupplementRequests.length > 0,
      JSON.stringify(rootSupplementRequests),
    );
    const requestedPostIds = rootSupplementRequests.flatMap(({ path }) =>
      new URL(path, "http://linuxdo-e2e-source").searchParams
        .getAll("post_ids[]")
        .map(Number),
    );
    assert.deepEqual(requestedPostIds, [240001]);
    const supplementedRoot = await searchArchiveItem("主题正文版本 3");
    assert.equal(supplementedRoot.sourceKey.key, "post:240001");
    assert.deepEqual(binState(supplementedRoot).sourcePublishedAt, {
      precision: "instant",
      value: "2026-10-28T01:00:00.000Z",
    });
  }
  await updateFixtureState({ postRangeTopicRootShape: null });
  assert.deepEqual(await searchArchiveSourceKeys("终点边界之外的帖子"), []);
  assert.deepEqual(
    await searchArchiveSourceKeys("早于起点的旧时间戳帖子甲"),
    [],
  );
  assert.deepEqual(
    await searchArchiveSourceKeys("早于起点的旧时间戳帖子乙"),
    [],
  );

  const stableReply = await searchArchiveItem("回复正文版本 3");
  assert.equal(stableReply.sourceKey.key, "post:240002");
  const firstVersions = stableReply.revisions.length;
  await updateFixtureState({
    postRangeAddAfterFirstPage: false,
    replyVersion: 4,
  });
  const repeated = await trigger("collect", rangeParams);
  assert.equal(repeated.status, "completed", JSON.stringify(repeated));
  assert.equal(
    repeated.result?.output?.collectionCompleteness,
    "complete",
    JSON.stringify(repeated),
  );
  const edited = await searchArchiveItem("回复正文版本 4");
  assert.equal(edited.itemId, stableReply.itemId);
  assert.equal(edited.sourceKey.key, stableReply.sourceKey.key);
  assert.equal(edited.revisions.length, firstVersions + 1);

  await updateFixtureState({
    replyVersion: 3,
    postRangeRepeatPage: true,
  });
  const repeatedPage = await trigger("collect", rangeParams);
  assert.equal(repeatedPage.status, "completed", JSON.stringify(repeatedPage));
  assert.equal(repeatedPage.result?.output?.collectionCompleteness, "partial");
  assert.equal(repeatedPage.report?.discovery, "partial");
  assert.ok(
    repeatedPage.result?.output?.incompleteScopes?.some(
      ({ reasonCode }) => reasonCode === "post_range_cursor_not_advancing",
    ),
    JSON.stringify(repeatedPage),
  );
  const repeatedPageScopes = repeatedPage.report?.scopes as
    | readonly { readonly status: string }[]
    | undefined;
  assert.ok(repeatedPageScopes?.some(({ status }) => status === "incomplete"));

  await updateFixtureState({
    postRangeRepeatPage: false,
    postRangeInvalidPage: 1,
  });
  const invalidPage = await trigger("collect", rangeParams);
  assert.equal(invalidPage.status, "completed", JSON.stringify(invalidPage));
  assert.equal(invalidPage.result?.output?.collectionCompleteness, "partial");
  assert.equal(invalidPage.report?.discovery, "failed");
  assert.ok(
    invalidPage.result?.output?.incompleteScopes?.some(
      ({ reasonCode }) => reasonCode === "post_range_response_invalid",
    ),
    JSON.stringify(invalidPage),
  );

  await updateFixtureState({
    postRangeInvalidPage: null,
    postRangeAddAfterFirstPage: false,
  });
  const pageLimit = await trigger("collect", {
    ...rangeParams,
    postCreatedRange: { ...rangeParams.postCreatedRange, maxPages: 2 },
  });
  assert.equal(pageLimit.status, "completed", JSON.stringify(pageLimit));
  assert.equal(pageLimit.result?.output?.collectionCompleteness, "partial");
  assert.ok(
    pageLimit.result?.output?.incompleteScopes?.some(
      ({ reasonCode }) => reasonCode === "post_range_page_limit_reached",
    ),
    JSON.stringify(pageLimit),
  );

  await setTestClockAt("2026-10-28T03:00:00.000Z");
  const archiveBeforeFutureRange = await searchArchiveItem("区间新增回复内容");
  for (const postCreatedRange of [
    {
      from: "2026-10-28T02:00:00.000Z",
      to: "2026-10-28T04:00:00.000Z",
    },
    {
      from: "2099-01-01T00:00:00.000Z",
      to: "2099-01-02T00:00:00.000Z",
    },
  ]) {
    await clearSourceEvents();
    const futureRange = await trigger("collect", {
      targets: linuxdoTargets("latest"),
      postCreatedRange,
    });
    const futureSourceEvents = (await sourceState()).events;
    const archiveAfterFutureRange = await searchArchiveItem("区间新增回复内容");
    assert.equal(
      futureRange.status,
      "failed",
      JSON.stringify({
        futureRange,
        sourceEvents: futureSourceEvents,
        archiveAfterFutureRange,
      }),
    );
    assert.equal(
      futureRange.result?.error?.code,
      "linuxdo_post_created_range_in_future",
      JSON.stringify(futureRange),
    );
    assert.equal(futureRange.report?.phase, "failed");
    assert.deepEqual(futureRange.result?.commits ?? [], []);
    assert.deepEqual(futureSourceEvents, []);
    assert.equal(
      archiveAfterFutureRange.itemId,
      archiveBeforeFutureRange.itemId,
    );
    assert.deepEqual(
      archiveAfterFutureRange.revisions.map(({ revisionId }) => revisionId),
      archiveBeforeFutureRange.revisions.map(({ revisionId }) => revisionId),
    );
    await setTestClockAt("2026-10-28T03:00:00.000Z");
  }
  await setTestClockOffset(0);

  await updateFixtureState({
    postRangeEnabled: false,
    postRangeAddAfterFirstPage: false,
    postRangeRepeatPage: false,
    postRangeInvalidPage: null,
    postRangeTopicRootShape: null,
    topicCreatedAtOverrides: {},
  });
}

type SyncRunOutput = {
  readonly outcome: "initialized" | "advanced" | "no-forward-range" | "partial";
  readonly upperBound: string;
  readonly scopes: readonly {
    readonly scope: {
      readonly kind: "category" | "topic";
      readonly id: number;
    };
    readonly position: string;
    readonly status:
      | "initialized"
      | "advanced"
      | "partial"
      | "unknown"
      | "unstarted"
      | "no-forward-range";
    readonly range?: { readonly from: string; readonly to: string };
    readonly skippedBefore?: string;
  }[];
  readonly observedPosts: number;
  readonly topicsExamined: number;
  readonly incompleteScopes: readonly {
    readonly scope: string;
    readonly reasonCode: string;
    readonly message: string;
  }[];
};

type SyncRunReport = {
  readonly phase: string;
  readonly upperBound: string;
  readonly intent:
    | { readonly kind: "all-visible" }
    | {
        readonly kind: "targets";
        readonly targets: readonly Record<string, unknown>[];
      };
  readonly discovery: string;
  readonly budget: {
    readonly maxRequests: number;
    readonly maxElapsedMs: number;
    readonly elapsedMs: number;
    readonly remainingMs: number;
    readonly stopReason?: string;
  };
  readonly sourceAccess: {
    readonly admittedAttempts: number;
    readonly waitedMs: number;
    readonly bySource: { readonly site: number; readonly media: number };
    readonly rateLimitResponses: readonly {
      readonly source: "site" | "media";
      readonly origin: string;
      readonly status: 429 | 503;
      readonly retryAfter?: string;
      readonly outcome: "cooled" | "missing" | "invalid" | "past";
      readonly observedAt: string;
      readonly cooldownUntil?: string;
    }[];
    readonly pageRequestEventsObserved: {
      readonly total: number;
      readonly get: number;
      readonly nonGet: number;
      readonly sameOriginGet: number;
      readonly otherOriginGet: number;
      readonly byResourceType: {
        readonly document: number;
        readonly fetch: number;
        readonly xhr: number;
        readonly other: number;
      };
    };
  };
  readonly scopes: readonly {
    readonly scope: {
      readonly kind: "category" | "topic";
      readonly id: number;
    };
    readonly mode: string;
    readonly position: string;
    readonly range?: { readonly from: string; readonly to: string };
    readonly skippedBefore?: string;
    readonly status: string;
  }[];
  readonly observedPosts: number;
  readonly topicsExamined: number;
  readonly incompleteScopes: readonly {
    readonly scope: string;
    readonly reasonCode: string;
    readonly message: string;
  }[];
};

function syncOutput(run: ManualRun): SyncRunOutput {
  assert.ok(run.result?.output !== undefined, JSON.stringify(run));
  return run.result.output as SyncRunOutput;
}

function syncReport(run: ManualRun): SyncRunReport {
  assert.ok(run.report !== undefined, `sync 运行没有报告：${run.runId}`);
  return run.report as SyncRunReport;
}

async function verifySyncWorkerInterruption(
  previousUpperBound: string,
): Promise<{ readonly upperBound: string; readonly runId: string }> {
  const params = {
    targets: linuxdoTargets("category"),
    maxPages: 20,
    maxRequests: 100,
    maxElapsedMs: 120_000,
  };
  const interruptedAt = new Date(
    Date.parse(previousUpperBound) + 31 * 60_000,
  ).toISOString();
  await setTestClockAt(interruptedAt);
  await updateFixtureState({
    postRangeEnabled: true,
    postRangeAddAfterFirstPage: false,
    postRangeRepeatPage: false,
    postRangeInvalidPage: null,
    postRangeResponseStatus: null,
    postRangeRetryAfter: null,
    postRangePageSize: 50,
    postRangePause: null,
    topicResponsePause: { topicId: 2499, milliseconds: 20_000 },
    syncScenarioStage: 3,
  });
  await clearSourceEvents();

  try {
    const interruptedRequest = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "sync",
        "--params",
        JSON.stringify(params),
      ]),
      "triggered",
    );
    await waitFor(
      async () => sourceState(),
      ({ events }) =>
        events.some(
          ({ action, path }) => action === "topic" && path === "/t/2499.json",
        ),
      "分类 43 的主题正文请求",
    );
    const processing = await waitFor(
      async () =>
        cliData<ManualRun>(
          await cli([
            "run",
            "get",
            "binny-discovery-topic",
            interruptedRequest.runId,
          ]),
          "found",
        ),
      ({ status, report }) =>
        status === "executing" && report?.phase === "processing",
      "同步第二个范围的执行中报告",
    );
    const reportBeforeInterruption = JSON.stringify(processing.report);
    const reportScopes = syncReport(processing).scopes;
    assert.equal(
      reportScopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 42,
      )?.status,
      "completed",
      JSON.stringify(reportScopes),
    );
    assert.equal(
      reportScopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 43,
      )?.status,
      "in-progress",
      JSON.stringify(reportScopes),
    );
    const archivedBeforeInterruption = await searchArchiveItem(
      "超过一小时范围的旧回复",
    );
    assert.equal(archivedBeforeInterruption.sourceKey.key, "post:240012");
    const postListCountBeforeInterruption = (await sourceState()).events.filter(
      ({ action }) => action === "post-list",
    ).length;

    const childProcesses = await compose([
      "exec",
      "--no-TTY",
      "runtime-linuxdo",
      "node",
      "--input-type=module",
      "-e",
      'import { readdirSync, readFileSync } from "node:fs"; for (const entry of readdirSync("/proc")) { if (!/^\\d+$/u.test(entry)) continue; try { const proc = "/proc/" + entry; const command = readFileSync(proc + "/cmdline").toString(); if ((command.includes("worker.js") || command.includes("worker.ts")) && Number(entry) !== process.pid) { process.stdout.write(entry); process.exit(0); } } catch {} } process.exit(1);',
    ]);
    const workerPid = Number(childProcesses.stdout.trim());
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1);
    await compose([
      "exec",
      "--no-TTY",
      "runtime-linuxdo",
      "node",
      "-e",
      `process.kill(${String(workerPid)}, "SIGKILL")`,
    ]);

    const interrupted = await waitForManualRun(interruptedRequest.runId);
    assert.equal(interrupted.status, "failed", JSON.stringify(interrupted));
    assert.equal(
      interrupted.result?.error?.code,
      "source_adapter_process_interrupted",
    );
    assert.equal(JSON.stringify(interrupted.report), reportBeforeInterruption);
    const archivedAfterInterruption = await searchArchiveItem(
      "超过一小时范围的旧回复",
    );
    assert.equal(
      archivedAfterInterruption.itemId,
      archivedBeforeInterruption.itemId,
    );
    assert.deepEqual(
      archivedAfterInterruption.revisions.map(({ revisionId }) => revisionId),
      archivedBeforeInterruption.revisions.map(({ revisionId }) => revisionId),
    );
    assert.equal(
      (await sourceState()).events.filter(
        ({ action }) => action === "post-list",
      ).length,
      postListCountBeforeInterruption,
      "worker 退出后不应自动恢复旧同步或继续扫描帖子流。",
    );

    await updateFixtureState({
      postRangePause: null,
      postRangePageSize: 2,
      topicResponsePause: null,
    });
    await setTestClockAt("2026-10-28T05:00:00.000Z");
    await clearSourceEvents();
    const resumed = await trigger("sync", params);
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    assert.equal(
      (resumed.result?.commits ?? []).some(({ items }) =>
        items.some(
          ({ itemId }) => itemId === archivedBeforeInterruption.itemId,
        ),
      ),
      false,
      "worker恢复后的sync不得再次提交窗口外的旧回复条目。",
    );
    const resumedReport = syncReport(resumed);
    assert.equal(
      resumedReport.scopes[0]?.range?.from,
      syncReport(processing).upperBound,
    );
    assert.ok(
      Date.parse(resumedReport.upperBound) >
        Date.parse(resumedReport.scopes[0].range.from),
    );
    const oldRunAfterResume = cliData<ManualRun>(
      await cli([
        "run",
        "get",
        "binny-discovery-topic",
        interruptedRequest.runId,
      ]),
      "found",
    );
    assert.equal(
      JSON.stringify(oldRunAfterResume.report),
      reportBeforeInterruption,
    );
    const archivedAfterResume = await searchArchiveItem(
      "超过一小时范围的旧回复",
    );
    assert.equal(archivedAfterResume.sourceKey.key, "post:240012");
    assert.deepEqual(
      archivedAfterResume.revisions.map(({ revisionId }) => revisionId),
      archivedBeforeInterruption.revisions.map(({ revisionId }) => revisionId),
    );
    return { upperBound: syncReport(resumed).upperBound, runId: resumed.runId };
  } finally {
    await updateFixtureState({
      postRangePause: null,
      postRangePageSize: 2,
      topicResponsePause: null,
      syncScenarioStage: 0,
    });
  }
}

async function verifySyncCancellationAndRuntimeExit(
  positionBeforeDiscovery: string,
): Promise<void> {
  const params = {
    targets: linuxdoTargets("category"),
    maxPages: 20,
    maxRequests: 100,
    maxElapsedMs: 120_000,
  };
  await ensureAuthenticatedLinuxdoUser();
  let blocker: ManualRun | undefined;
  await updateFixtureState({ topicListDelayMs: 30_000 });
  try {
    await clearSourceEvents();
    blocker = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "collect",
        "--params",
        JSON.stringify({
          targets: linuxdoTargets("latest"),
          date: "2026-10-28",
          timeZone: "UTC",
          maxTopics: 1,
        }),
      ]),
      "triggered",
    );
    const blockerStarted = await waitFor(
      async () =>
        cliData<ManualRun>(
          await cli(["run", "get", "binny-discovery-topic", blocker!.runId]),
          "found",
        ),
      ({ status }) =>
        status === "executing" ||
        status === "completed" ||
        status === "failed" ||
        status === "cancelled",
      "队列阻塞动作启动",
    );
    assert.equal(
      blockerStarted.status,
      "executing",
      `队列阻塞动作未保持执行中：${JSON.stringify(blockerStarted)}`,
    );
    await waitForSourceEvent("topic-list", 1);
    const sourceEventsBeforeSync = await sourceState();
    const queuedSync = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "sync",
        "--params",
        JSON.stringify(params),
      ]),
      "triggered",
    );
    assert.equal(queuedSync.status, "queued");
    cliData(
      await cli(["run", "cancel", "binny-discovery-topic", queuedSync.runId]),
      "cancellation",
    );
    const cancelledBeforeExecution = await waitForManualRun(queuedSync.runId);
    assert.equal(
      cancelledBeforeExecution.status,
      "cancelled",
      JSON.stringify(cancelledBeforeExecution),
    );
    assert.deepEqual(
      await sourceState(),
      sourceEventsBeforeSync,
      "排队中的 sync 取消不应触发额外来源访问。",
    );
  } finally {
    await updateFixtureState({ topicListDelayMs: 0 });
    if (blocker !== undefined) {
      const latestBlocker = cliData<ManualRun>(
        await cli(["run", "get", "binny-discovery-topic", blocker.runId]),
        "found",
      );
      if (
        latestBlocker.status === "queued" ||
        latestBlocker.status === "executing"
      ) {
        cliData(
          await cli(["run", "cancel", "binny-discovery-topic", blocker.runId]),
          "cancellation",
        );
      }
      const blockerResult = await waitForManualRun(blocker.runId);
      assert.ok(
        blockerResult.status === "completed" ||
          blockerResult.status === "cancelled",
        JSON.stringify(blockerResult),
      );
    }
  }

  await setTestClockAt(
    new Date(Date.parse(positionBeforeDiscovery) + 20 * 60_000).toISOString(),
  );
  await updateFixtureState({ siteHomeDelayMs: 20_000 });
  await clearSourceEvents();
  let interruptedDiscovery: ManualRun | undefined;
  let positionAfterDiscoveryCancellation: string | undefined;
  try {
    interruptedDiscovery = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "sync",
        "--params",
        JSON.stringify(params),
      ]),
      "triggered",
    );
    await waitForSourceEvent("site-home", 1);
    const discovering = await waitFor(
      async () =>
        cliData<ManualRun>(
          await cli([
            "run",
            "get",
            "binny-discovery-topic",
            interruptedDiscovery!.runId,
          ]),
          "found",
        ),
      ({ status, report }) =>
        status === "executing" && report?.phase === "discovering-targets",
      "首次来源响应前的 sync 意图报告",
    );
    assert.equal(syncReport(discovering).phase, "discovering-targets");

    cliData(
      await cli([
        "run",
        "cancel",
        "binny-discovery-topic",
        interruptedDiscovery.runId,
      ]),
      "cancellation",
    );
    const cancelledDiscovery = await waitForManualRun(
      interruptedDiscovery.runId,
    );
    assert.equal(cancelledDiscovery.status, "cancelled");
    assert.equal(syncReport(cancelledDiscovery).phase, "cancelled");
    const cancelledDiscoveryReport = JSON.stringify(cancelledDiscovery.report);
    const discoveryEvents = (await sourceState()).events;
    assert.equal(
      discoveryEvents.some(({ action }) =>
        [
          "categories",
          "topic-list",
          "topic",
          "post-list",
          "posts",
          "media",
        ].includes(action),
      ),
      false,
      "目标发现取消不得读取或归档任何逻辑范围。",
    );
    await updateFixtureState({ siteHomeDelayMs: 0 });
    await setTestClockAt(
      new Date(Date.parse(positionBeforeDiscovery) + 30 * 60_000).toISOString(),
    );
    await clearSourceEvents();
    const afterDiscoveryCancellation = await trigger("sync", params);
    assert.equal(
      afterDiscoveryCancellation.status,
      "completed",
      JSON.stringify(afterDiscoveryCancellation),
    );
    assert.equal(
      syncReport(afterDiscoveryCancellation).scopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 42,
      )?.range?.from,
      positionBeforeDiscovery,
    );
    positionAfterDiscoveryCancellation = syncReport(
      afterDiscoveryCancellation,
    ).scopes.find(({ scope }) => scope.kind === "category" && scope.id === 42)
      ?.range?.to;
    const oldDiscoveryRun = cliData<ManualRun>(
      await cli([
        "run",
        "get",
        "binny-discovery-topic",
        interruptedDiscovery.runId,
      ]),
      "found",
    );
    assert.equal(
      JSON.stringify(oldDiscoveryRun.report),
      cancelledDiscoveryReport,
    );
  } finally {
    await updateFixtureState({ siteHomeDelayMs: 0 });
  }

  const previousCategoryPosition = positionAfterDiscoveryCancellation;
  assert.ok(previousCategoryPosition !== undefined);
  await setTestClockAt(
    new Date(Date.parse(previousCategoryPosition) + 70 * 60_000).toISOString(),
  );
  await updateFixtureState({
    postRangeEnabled: true,
    postRangePageSize: 50,
    postRangePause: { page: 1, milliseconds: 20_000 },
    syncScenarioStage: 3,
  });
  await clearSourceEvents();

  try {
    const activeCancellation = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "sync",
        "--params",
        JSON.stringify(params),
      ]),
      "triggered",
    );
    const active = await waitFor(
      async () =>
        cliData<ManualRun>(
          await cli([
            "run",
            "get",
            "binny-discovery-topic",
            activeCancellation.runId,
          ]),
          "found",
        ),
      ({ status, report }) =>
        status === "executing" && report?.phase === "processing",
      "已分配范围的 sync 执行中报告",
    );
    await waitForSourceEvent("post-list", 1);
    const activeUpperBound = syncReport(active).upperBound;
    assert.equal(
      syncReport(active).scopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 42,
      )?.position,
      activeUpperBound,
    );

    cliData(
      await cli([
        "run",
        "cancel",
        "binny-discovery-topic",
        activeCancellation.runId,
      ]),
      "cancellation",
    );
    const cancelled = await waitForManualRun(activeCancellation.runId);
    assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
    assert.equal(syncReport(cancelled).phase, "cancelled");
    assert.equal(
      syncReport(cancelled).scopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 42,
      )?.status,
      "unknown",
      JSON.stringify(syncReport(cancelled)),
    );
    assert.ok(
      syncReport(cancelled).incompleteScopes.some(
        ({ scope, reasonCode }) =>
          scope === "category:42" && reasonCode === "sync_cancelled",
      ),
      JSON.stringify(syncReport(cancelled)),
    );
    const cancelledReport = JSON.stringify(cancelled.report);
    assert.equal(
      (await sourceState()).events.filter(
        ({ action }) => action === "post-list",
      ).length,
      1,
      "执行中取消后不应发出新的帖子流请求。",
    );

    await updateFixtureState({ postRangePause: null });
    await setTestClockAt(
      new Date(Date.parse(activeUpperBound) + 30 * 60_000).toISOString(),
    );
    await clearSourceEvents();
    const afterCancellation = await trigger("sync", params);
    assert.equal(
      afterCancellation.status,
      "completed",
      JSON.stringify(afterCancellation),
    );
    assert.equal(
      syncReport(afterCancellation).scopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 42,
      )?.range?.from,
      activeUpperBound,
    );
    const cancelledRunAfterResume = cliData<ManualRun>(
      await cli([
        "run",
        "get",
        "binny-discovery-topic",
        activeCancellation.runId,
      ]),
      "found",
    );
    assert.equal(
      JSON.stringify(cancelledRunAfterResume.report),
      cancelledReport,
    );

    const resumeUpperBound = syncReport(afterCancellation).upperBound;
    await setTestClockAt(
      new Date(Date.parse(resumeUpperBound) + 30 * 60_000).toISOString(),
    );
    await updateFixtureState({
      postRangePause: { page: 1, milliseconds: 20_000 },
    });
    await clearSourceEvents();
    const runtimeInterruption = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "sync",
        "--params",
        JSON.stringify(params),
      ]),
      "triggered",
    );
    await waitFor(
      async () =>
        cliData<ManualRun>(
          await cli([
            "run",
            "get",
            "binny-discovery-topic",
            runtimeInterruption.runId,
          ]),
          "found",
        ),
      ({ status, report }) =>
        status === "executing" && report?.phase === "processing",
      "运行器退出前已分配范围的报告",
    );
    await waitForSourceEvent("post-list", 1);
    const runtimeStateBeforeExit = cliData<ManualRun>(
      await cli([
        "run",
        "get",
        "binny-discovery-topic",
        runtimeInterruption.runId,
      ]),
      "found",
    );
    assert.equal(runtimeStateBeforeExit.status, "executing");
    assert.equal(syncReport(runtimeStateBeforeExit).phase, "processing");
    const runtimeUpperBound = syncReport(runtimeStateBeforeExit).upperBound;
    assert.equal(
      syncReport(runtimeStateBeforeExit).scopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 42,
      )?.position,
      runtimeUpperBound,
    );
    const reportBeforeRuntimeExit = JSON.stringify(
      runtimeStateBeforeExit.report,
    );
    const runtimeBefore = cliData<{
      readonly execution: { readonly runtimeId: string };
    }>(await cli(["bin", "get", "binny-discovery-topic"]), "found");

    await compose(["kill", "--signal", "SIGKILL", "runtime-linuxdo"]);
    await compose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "90",
      "--force-recreate",
      "runtime-linuxdo",
    ]);
    await waitForRuntimeHealth();
    await waitForRuntime();
    const runtimeAfter = await waitFor(
      async () =>
        cliData<{
          readonly execution: {
            readonly status: string;
            readonly runtimeId: string;
          };
        }>(await cli(["bin", "get", "binny-discovery-topic"]), "found"),
      ({ execution }) =>
        execution.status === "online" &&
        execution.runtimeId !== runtimeBefore.execution.runtimeId,
      "新的运行器 owner 注册",
    );
    assert.notEqual(
      runtimeAfter.execution.runtimeId,
      runtimeBefore.execution.runtimeId,
    );
    const stoppedRuntimeRun = await waitForManualRun(runtimeInterruption.runId);
    assert.ok(
      stoppedRuntimeRun.status === "failed" ||
        stoppedRuntimeRun.status === "cancelled",
      JSON.stringify(stoppedRuntimeRun),
    );
    assert.notEqual(stoppedRuntimeRun.status, "completed");
    assert.equal(
      JSON.stringify(stoppedRuntimeRun.report),
      reportBeforeRuntimeExit,
    );
    await delay(1_000);
    assert.equal(
      (await sourceState()).events.filter(
        ({ action }) => action === "post-list",
      ).length,
      1,
      "运行器重启不得自动恢复旧 sync 任务。",
    );

    await ensureAuthenticatedLinuxdoUser();

    await updateFixtureState({ postRangePause: null, postRangePageSize: 2 });
    await setTestClockAt(
      new Date(Date.parse(runtimeUpperBound) + 30 * 60_000).toISOString(),
    );
    await clearSourceEvents();
    const afterRuntimeRestart = await trigger("sync", params);
    assert.equal(
      afterRuntimeRestart.status,
      "completed",
      JSON.stringify(afterRuntimeRestart),
    );
    assert.equal(
      syncReport(afterRuntimeRestart).scopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 42,
      )?.range?.from,
      runtimeUpperBound,
    );
    const stoppedRunAfterResume = cliData<ManualRun>(
      await cli([
        "run",
        "get",
        "binny-discovery-topic",
        runtimeInterruption.runId,
      ]),
      "found",
    );
    assert.equal(
      JSON.stringify(stoppedRunAfterResume.report),
      reportBeforeRuntimeExit,
    );
  } finally {
    await updateFixtureState({
      postRangePause: null,
      postRangePageSize: 2,
      siteHomeDelayMs: 0,
      topicListDelayMs: 0,
      syncScenarioStage: 0,
    });
  }
}

async function verifyBoundedSync(): Promise<string> {
  const categoryTarget = linuxdoTargets("category");
  const params = {
    targets: categoryTarget,
    maxPages: 20,
    maxRequests: 100,
    maxElapsedMs: 120_000,
  };
  await setSourceAccessPolicy(0, 1);
  await updateFixtureState({
    postRangeEnabled: true,
    postRangeAddAfterFirstPage: false,
    postRangeRepeatPage: false,
    postRangeInvalidPage: null,
    postRangeResponseStatus: null,
    postRangeRetryAfter: null,
    postRangePageSize: 2,
    postRangePause: null,
    syncScenarioStage: 0,
    siteHomeDelayMs: 5_000,
  });
  await setTestClockAt("2026-10-28T02:00:00.000Z");
  let lastConfirmedPosition: string | undefined;

  try {
    await clearSourceEvents();
    const initializedRun = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "sync",
        "--params",
        JSON.stringify(params),
      ]),
      "triggered",
    );
    await waitForSourceEvent("site-home", 1);
    const reportBeforeSourceResponse = cliData<ManualRun>(
      await cli(["run", "get", "binny-discovery-topic", initializedRun.runId]),
      "found",
    );
    assert.equal(reportBeforeSourceResponse.status, "executing");
    assert.equal(
      syncReport(reportBeforeSourceResponse).phase,
      "discovering-targets",
    );
    const initialUpperBound = syncReport(reportBeforeSourceResponse).upperBound;
    assert.ok(
      Date.parse(initialUpperBound) >= Date.parse("2026-10-28T02:00:00.000Z") &&
        Date.parse(initialUpperBound) < Date.parse("2026-10-28T02:00:30.000Z"),
      initialUpperBound,
    );
    assert.deepEqual(syncReport(reportBeforeSourceResponse).intent, {
      kind: "targets",
      targets: categoryTarget,
    });
    const sourceEventsBeforeSnapshotRead = await sourceState();
    await readBinRuntime("binny-discovery-topic");
    const sourceEventsAfterSnapshotRead = await sourceState();
    assert.deepEqual(
      sourceEventsAfterSnapshotRead.events,
      sourceEventsBeforeSnapshotRead.events,
      "bin get 读取接续状态不应触发来源访问。",
    );
    const initialized = await waitForManualRun(initializedRun.runId);
    assert.equal(initialized.status, "completed", JSON.stringify(initialized));
    await updateFixtureState({ siteHomeDelayMs: 0 });
    assert.equal(syncReport(initialized).phase, "completed");
    assert.equal(syncReport(initialized).upperBound, initialUpperBound);
    assert.equal(syncReport(initialized).discovery, "complete");
    assert.equal(syncOutput(initialized).outcome, "initialized");
    assert.equal(syncOutput(initialized).observedPosts, 0);
    assert.deepEqual(
      syncOutput(initialized).scopes.map(({ scope, status, position }) => ({
        scope,
        status,
        position,
      })),
      [
        {
          scope: { kind: "category", id: 42 },
          status: "initialized",
          position: initialUpperBound,
        },
        {
          scope: { kind: "category", id: 43 },
          status: "initialized",
          position: initialUpperBound,
        },
      ],
    );
    assert.deepEqual(
      (await sourceState()).events.map(({ action }) => action),
      ["site-home", "session-current", "categories"],
      "首次 sync 只发现当前真实范围，不扫描帖子流或主题历史。",
    );
    assert.deepEqual(
      await searchArchiveSourceKeys("sync 第一轮发现的旧主题新回复"),
      [],
    );
    assert.deepEqual(await searchArchiveSourceKeys("发现主题 2500"), []);

    await updateFixtureState({ syncScenarioStage: 1 });
    await setTestClockAt("2026-10-28T03:00:00.000Z");
    await clearSourceEvents();
    const firstIncrement = await trigger("sync", params);
    assert.equal(
      firstIncrement.status,
      "completed",
      JSON.stringify(firstIncrement),
    );
    assert.equal(syncReport(firstIncrement).phase, "completed");
    const firstUpperBound = syncReport(firstIncrement).upperBound;
    assert.ok(
      Date.parse(firstUpperBound) >= Date.parse("2026-10-28T03:00:00.000Z") &&
        Date.parse(firstUpperBound) < Date.parse("2026-10-28T03:00:30.000Z"),
      firstUpperBound,
    );
    const expectedFirstRangeFrom = new Date(
      Math.max(
        Date.parse(initialUpperBound),
        Date.parse(firstUpperBound) - 60 * 60 * 1_000,
      ),
    ).toISOString();
    assert.deepEqual(syncReport(firstIncrement).scopes[0]?.range, {
      from: expectedFirstRangeFrom,
      to: firstUpperBound,
    });
    assert.ok(syncOutput(firstIncrement).observedPosts >= 2);
    assert.ok(syncOutput(firstIncrement).topicsExamined >= 2);
    assert.equal(
      (await searchArchiveItem("sync 第一轮发现的旧主题新回复")).sourceKey.key,
      "post:240010",
    );
    assert.equal(
      (await searchArchiveItem("发现主题 2500")).sourceKey.key,
      "post:250000",
    );

    await compose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "90",
      "--force-recreate",
      "runtime-linuxdo",
    ]);
    await Promise.all([waitForRuntimeHealth(), waitForRuntime()]);

    await readBinRuntime("binny-discovery-topic");
    await ensureAuthenticatedLinuxdoUser();

    await updateFixtureState({ syncScenarioStage: 2 });
    await setTestClockAt("2026-10-28T04:00:00.000Z");
    await clearSourceEvents();
    const resumed = await trigger("sync", params);
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    const resumedUpperBound = syncReport(resumed).upperBound;
    assert.ok(
      Date.parse(resumedUpperBound) >= Date.parse("2026-10-28T04:00:00.000Z") &&
        Date.parse(resumedUpperBound) < Date.parse("2026-10-28T04:00:30.000Z"),
      resumedUpperBound,
    );
    const expectedResumedRangeFrom = new Date(
      Math.max(
        Date.parse(firstUpperBound),
        Date.parse(resumedUpperBound) - 60 * 60 * 1_000,
      ),
    ).toISOString();
    assert.deepEqual(syncReport(resumed).scopes[0]?.range, {
      from: expectedResumedRangeFrom,
      to: resumedUpperBound,
    });
    assert.equal(
      (await searchArchiveItem("sync 第二轮发现的旧主题新回复")).sourceKey.key,
      "post:240011",
    );
    const resumedEvents = (await sourceState()).events;
    const resumedPostListEvents = resumedEvents.filter(
      ({ action }) => action === "post-list",
    );
    assert.ok(
      resumedPostListEvents.length < params.maxPages,
      `增量 sync 扫描到已确认下界即停止，实际请求了 ${String(resumedPostListEvents.length)} 页帖子流，少于 maxPages ${String(params.maxPages)}。`,
    );

    const workerRecovery =
      await verifySyncWorkerInterruption(resumedUpperBound);
    const interruptedArchive = await searchArchiveItem(
      "超过一小时范围的旧回复",
    );

    await clearSourceEvents();
    const sourceEventsBeforeRestartSnapshot = await sourceState();
    await readBinRuntime("binny-discovery-topic");
    const sourceEventsAfterRestartSnapshot = await sourceState();
    assert.deepEqual(
      sourceEventsAfterRestartSnapshot.events,
      sourceEventsBeforeRestartSnapshot.events,
      "runtime 重启后的 bin get 读取也不应访问来源。",
    );
    await setTestClockAt(
      new Date(Date.parse(resumedUpperBound) - 60_000).toISOString(),
    );
    await clearSourceEvents();
    const noForwardRange = await trigger("sync", params);
    assert.equal(
      noForwardRange.status,
      "completed",
      JSON.stringify(noForwardRange),
    );
    assert.equal(syncOutput(noForwardRange).outcome, "no-forward-range");
    assert.ok(
      syncOutput(noForwardRange).scopes.every(
        ({ status }) => status === "no-forward-range",
      ),
      JSON.stringify(noForwardRange),
    );
    assert.equal(
      (await sourceState()).events.some(({ action }) => action === "post-list"),
      false,
      "U 不晚于 P 时应报告无正向范围且不扫描帖子流。",
    );

    await updateFixtureState({ syncScenarioStage: 3 });
    await updateFixtureState({ topicListDelayMs: 1_500 });
    const priorTopicLists = (await sourceState()).events.filter(
      ({ action }) => action === "topic-list",
    ).length;
    const blocker = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "collect",
        "--params",
        JSON.stringify({
          targets: categoryTarget,
          date: "2026-10-28",
          timeZone: "UTC",
          maxTopics: 1,
        }),
      ]),
      "triggered",
    );
    await waitForSourceEvent("topic-list", priorTopicLists + 1);
    const queuedSync = cliData<ManualRun>(
      await cli([
        "run",
        "trigger",
        "binny-discovery-topic",
        "sync",
        "--params",
        JSON.stringify(params),
      ]),
      "triggered",
    );
    assert.equal(queuedSync.status, "queued");
    await setTestClockAt("2026-10-28T06:30:00.000Z");
    await updateFixtureState({ topicListDelayMs: 0 });
    const blockerResult = await waitForManualRun(blocker.runId);
    assert.equal(
      blockerResult.status,
      "completed",
      JSON.stringify(blockerResult),
    );
    const afterLongQueue = await waitForManualRun(queuedSync.runId);
    assert.equal(
      afterLongQueue.status,
      "completed",
      JSON.stringify(afterLongQueue),
    );
    const longUpperBound = syncReport(afterLongQueue).upperBound;
    assert.ok(
      Date.parse(longUpperBound) >= Date.parse("2026-10-28T06:30:00.000Z"),
      longUpperBound,
    );
    assert.equal(syncReport(afterLongQueue).scopes[0]?.mode, "truncated");
    const expectedLongRangeFrom = new Date(
      Math.max(
        Date.parse(resumedUpperBound),
        Date.parse(longUpperBound) - 60 * 60 * 1_000,
      ),
    ).toISOString();
    assert.deepEqual(syncReport(afterLongQueue).scopes[0]?.range, {
      from: expectedLongRangeFrom,
      to: longUpperBound,
    });
    assert.equal(
      syncReport(afterLongQueue).scopes[0]?.skippedBefore,
      workerRecovery.upperBound,
    );
    const archiveAfterLongQueue = await searchArchiveItem(
      "超过一小时范围的旧回复",
    );
    assert.equal(archiveAfterLongQueue.itemId, interruptedArchive.itemId);
    assert.equal(
      (afterLongQueue.result?.commits ?? []).some(({ items }) =>
        items.some(({ itemId }) => itemId === interruptedArchive.itemId),
      ),
      false,
      "长时间排队后的sync不得再次提交一小时窗口外的旧回复条目。",
    );
    assert.equal(
      archiveAfterLongQueue.revisions.length,
      interruptedArchive.revisions.length,
      "长时间排队时不应为一小时窗口之外的旧回复创建新归档版本。",
    );

    await setTestClockAt(
      new Date(Date.parse(longUpperBound) + 60_000).toISOString(),
    );
    await clearSourceEvents();
    const requestLimit = await trigger("sync", {
      ...params,
      maxRequests: 3,
    });
    assert.equal(
      requestLimit.status,
      "completed",
      JSON.stringify(requestLimit),
    );
    assert.equal(syncReport(requestLimit).phase, "budget-exhausted");
    assert.equal(syncReport(requestLimit).budget.stopReason, "request-limit");
    assert.equal(syncOutput(requestLimit).outcome, "partial");
    const requestLimitUpperBound = syncReport(requestLimit).upperBound;
    lastConfirmedPosition = syncOutput(requestLimit).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 42,
    )?.position;
    assert.equal(lastConfirmedPosition, requestLimitUpperBound);
    assert.ok(
      syncOutput(requestLimit).scopes.some(
        ({ scope, status }) =>
          scope.kind === "category" && scope.id === 42 && status === "unknown",
      ),
      JSON.stringify(requestLimit),
    );
    assert.equal(
      (await sourceState()).events.some(({ action }) => action === "post-list"),
      false,
      "请求额度耗尽后不得开始帖子流扫描。",
    );

    const topicParams = {
      ...params,
      targets: linuxdoTargets("pinned"),
    };
    await setTestClockAt(
      new Date(Date.parse(requestLimitUpperBound) + 60_000).toISOString(),
    );
    const topicInitialized = await trigger("sync", topicParams);
    assert.equal(
      topicInitialized.status,
      "completed",
      JSON.stringify(topicInitialized),
    );
    const topicInitializedUpperBound = syncReport(topicInitialized).upperBound;
    await setTestClockAt(
      new Date(Date.parse(topicInitializedUpperBound) + 60_000).toISOString(),
    );
    await updateFixtureState({
      postRangeResponseStatus: 429,
      postRangeRetryAfter: "60",
    });
    await clearSourceEvents();
    const cooled = await trigger("sync", {
      ...topicParams,
      maxElapsedMs: 1_000,
    });
    assert.equal(cooled.status, "completed", JSON.stringify(cooled));
    assert.equal(syncReport(cooled).phase, "partial");
    assert.equal(syncReport(cooled).scopes[0]?.status, "unknown");
    assert.equal(syncOutput(cooled).scopes[0]?.status, "unknown");
    assert.equal(
      syncReport(cooled).sourceAccess.rateLimitResponses[0]?.status,
      429,
    );
    assert.equal(
      syncReport(cooled).sourceAccess.rateLimitResponses[0]?.retryAfter,
      "60",
    );
    assert.equal(
      syncReport(cooled).sourceAccess.rateLimitResponses[0]?.outcome,
      "cooled",
    );

    const cooledUpperBound = syncReport(cooled).upperBound;
    await setTestClockAt(
      new Date(Date.parse(cooledUpperBound) + 60_000).toISOString(),
    );
    await clearSourceEvents();
    const waitLimit = await trigger("sync", {
      ...topicParams,
      maxElapsedMs: 5_000,
    });
    assert.equal(waitLimit.status, "completed", JSON.stringify(waitLimit));
    assert.equal(syncReport(waitLimit).phase, "budget-exhausted");
    assert.equal(
      syncReport(waitLimit).budget.stopReason,
      "wait-exceeds-budget",
    );
    assert.equal(syncOutput(waitLimit).outcome, "partial");
    assert.equal(syncOutput(waitLimit).scopes.length, 0);
    assert.deepEqual(
      (await sourceState()).events,
      [],
      "冷却所需等待超过本轮预算时不应向受控来源发出请求。",
    );
    await setTestClockAt(
      new Date(Date.parse(cooledUpperBound) + 5_000).toISOString(),
    );
    await updateFixtureState({
      postRangeResponseStatus: null,
      postRangeRetryAfter: null,
    });
    await setSourceAccessPolicy(0, 1);
  } finally {
    await updateFixtureState({
      postRangeEnabled: false,
      postRangeAddAfterFirstPage: false,
      postRangeRepeatPage: false,
      postRangeInvalidPage: null,
      postRangeResponseStatus: null,
      postRangeRetryAfter: null,
      syncScenarioStage: 0,
      siteHomeDelayMs: 0,
      postRangePause: null,
    });
    await setSourceAccessPolicy(0, 1);
    await setTestClockOffset(0);
  }
  assert.ok(lastConfirmedPosition !== undefined);
  return lastConfirmedPosition;
}

async function verifyCorruptSyncStateVisibility(): Promise<void> {
  // 1. Missing previously initialized scope / wiped persistent_state = NULL in PostgreSQL
  await clearSourceEvents();
  await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-U",
    "binny",
    "-d",
    "binny",
    "-c",
    "UPDATE bin_configurations SET persistent_state = NULL WHERE id = 'binny-discovery-topic';",
  ]);
  await compose(["restart", "runtime-linuxdo"]);
  await waitForRuntimeHealth();
  await waitForRuntime();

  const failedSyncMissing = await trigger("sync", {
    targets: linuxdoTargets("category"),
    maxPages: 20,
    maxRequests: 100,
    maxElapsedMs: 120_000,
  });
  assert.equal(
    failedSyncMissing.status,
    "failed",
    JSON.stringify(failedSyncMissing),
  );
  assert.equal(
    failedSyncMissing.result?.error?.code,
    "source_adapter_state_unavailable",
  );
  assert.equal(
    (await sourceState()).events.some(
      ({ action }) => action === "site-home" || action === "post-list",
    ),
    false,
    "已初始化范围持久状态丢失时不应访问 Linux.do 来源或静默重建基线。",
  );
  assert.equal(
    JSON.stringify(failedSyncMissing).includes("source-adapter-state"),
    false,
  );

  // 2. Corrupted persistent_state = '{"corrupt":true}'::jsonb in PostgreSQL
  await clearSourceEvents();
  await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-U",
    "binny",
    "-d",
    "binny",
    "-c",
    "UPDATE bin_configurations SET persistent_state = '{\"corrupt\":true}'::jsonb WHERE id = 'binny-discovery-topic';",
  ]);
  await compose(["restart", "runtime-linuxdo"]);
  await waitForRuntimeHealth();
  await waitForRuntime();

  const failedSyncCorrupt = await trigger("sync", {
    targets: linuxdoTargets("category"),
    maxPages: 20,
    maxRequests: 100,
    maxElapsedMs: 120_000,
  });
  assert.equal(
    failedSyncCorrupt.status,
    "failed",
    JSON.stringify(failedSyncCorrupt),
  );
  assert.equal(
    failedSyncCorrupt.result?.error?.code,
    "source_adapter_state_unavailable",
  );
  assert.equal(
    (await sourceState()).events.some(
      ({ action }) => action === "site-home" || action === "post-list",
    ),
    false,
    "持久接续状态损坏时不应访问 Linux.do 来源。",
  );
  assert.equal(
    JSON.stringify(failedSyncCorrupt).includes("source-adapter-state"),
    false,
  );
}

async function verifySyncPostCategoryCandidates(): Promise<void> {
  const categoryTarget = {
    id: "category-44",
    kind: "category",
    categoryId: 44,
    categorySlugPath: "other",
  } as const;
  const explicitTopicTarget = {
    id: "topic-2601",
    kind: "topic",
    topicId: 2601,
  } as const;
  const targets = [categoryTarget, explicitTopicTarget];
  await setSourceAccessPolicy(0, 1);
  await updateFixtureState({
    dailyCollectionEnabled: false,
    postRangeEnabled: true,
    postRangeAddAfterFirstPage: false,
    postRangeRepeatPage: false,
    postRangeInvalidPage: null,
    postRangeResponseStatus: null,
    postRangeRetryAfter: null,
    postRangePageSize: 5,
    postCategoryCandidateScenario: true,
    syncScenarioStage: 0,
  });
  try {
    await setTestClockAt("2026-10-28T02:00:00.000Z");
    const initialized = await trigger("sync", {
      targets,
      maxPages: 20,
      maxRequests: 20,
      maxElapsedMs: 120_000,
    });
    assert.equal(initialized.status, "completed", JSON.stringify(initialized));
    assert.equal(syncOutput(initialized).outcome, "initialized");
    const nextUpperBound = new Date(
      Date.parse(syncReport(initialized).upperBound) + 30 * 60_000,
    ).toISOString();
    await setTestClockAt(nextUpperBound);
    await clearSourceEvents();

    const increment = await trigger("sync", {
      targets,
      maxPages: 20,
      maxRequests: 20,
      maxElapsedMs: 120_000,
    });
    assert.equal(increment.status, "completed", JSON.stringify(increment));
    const report = syncReport(increment);
    assert.equal(report.phase, "completed", JSON.stringify(report));
    assert.equal(report.budget.maxRequests, 20);
    assert.equal(report.budget.stopReason, undefined, JSON.stringify(report));
    assert.deepEqual(
      report.scopes.map(({ scope, status }) => ({ scope, status })),
      [
        { scope: { kind: "category", id: 44 }, status: "completed" },
        { scope: { kind: "topic", id: 2601 }, status: "completed" },
      ],
      JSON.stringify(report.scopes),
    );
    assert.equal(syncOutput(increment).observedPosts, 5);

    const events = (await sourceState()).events;
    assert.equal(
      events.filter(({ action }) => action === "post-list").length,
      8,
      JSON.stringify(events.filter(({ action }) => action === "post-list")),
    );
    assert.deepEqual(
      events
        .filter(({ action }) => action === "topic")
        .map(({ path }) => path)
        .toSorted(),
      ["/t/2601.json", "/t/2700.json", "/t/2701.json", "/t/2702.json"],
    );
    for (const text of [
      "明确匹配分类的帖子",
      "同主题中分类不匹配的帖子",
      "同主题缺失分类字段的帖子仍应保留",
      "无效分类字段仍应回退主题读取",
      "应由帖子分类跳过的主题 2601",
    ]) {
      assert.ok(
        (await searchArchiveItem(text)).sourceKey.key.startsWith("post:"),
      );
    }
  } finally {
    await updateFixtureState({
      dailyCollectionEnabled: false,
      postRangeEnabled: false,
      postRangeAddAfterFirstPage: false,
      postRangeRepeatPage: false,
      postRangeInvalidPage: null,
      postRangeResponseStatus: null,
      postRangeRetryAfter: null,
      postRangePageSize: 2,
      postCategoryCandidateScenario: false,
      syncScenarioStage: 0,
    });
    await setTestClockAt(new Date().toISOString());
  }
}

async function verifySyncScopeTransitions(): Promise<void> {
  const categoryTarget = linuxdoTargets("category")[0];
  const topicTarget = linuxdoTargets("pinned")[0];
  assert.ok(categoryTarget?.kind === "category");
  assert.ok(topicTarget?.kind === "topic");
  const params = {
    targets: [categoryTarget, topicTarget],
    maxPages: 20,
    maxRequests: 100,
    maxElapsedMs: 120_000,
  };
  const adapterConfig = (origin: string) => ({
    origin,
    sourceAccess: {
      groups: {
        linuxdo: {
          sources: ["site", "media"],
          minimumIntervalMs: 0,
          maxConcurrency: 1,
        },
      },
    },
  });
  const originalIdentity = "binny-discovery-profile";
  const originalOrigin = "http://linuxdo-e2e-source:8081";
  let secondRuntimeStarted = false;

  await setSourceAccessPolicy(0, 1);
  await updateFixtureState({
    dailyCollectionEnabled: false,
    postRangeEnabled: true,
    postRangeAddAfterFirstPage: false,
    postRangeRepeatPage: false,
    postRangeInvalidPage: null,
    postRangeResponseStatus: null,
    postRangeRetryAfter: null,
    postRangePageSize: 2,
    syncScenarioStage: 0,
  });
  await setTestClockAt("2026-10-28T02:00:00.000Z");

  try {
    await clearSourceEvents();
    await readBinRuntime("binny-discovery-topic");
    assert.deepEqual((await sourceState()).events, []);

    const initialized = await trigger("sync", params);
    assert.equal(initialized.status, "completed", JSON.stringify(initialized));
    assert.equal(syncReport(initialized).phase, "completed");
    assert.equal(syncOutput(initialized).outcome, "initialized");
    const initialUpperBound = syncReport(initialized).upperBound;
    assert.deepEqual(
      syncOutput(initialized).scopes.map(({ scope, status, position }) => ({
        scope,
        status,
        position,
      })),
      [
        {
          scope: { kind: "category", id: 42 },
          status: "initialized",
          position: initialUpperBound,
        },
        {
          scope: { kind: "category", id: 43 },
          status: "initialized",
          position: initialUpperBound,
        },
        {
          scope: { kind: "topic", id: 2401 },
          status: "initialized",
          position: initialUpperBound,
        },
      ],
    );
    assert.equal(syncOutput(initialized).observedPosts, 0);
    assert.equal(
      (await sourceState()).events.some(({ action }) => action === "post-list"),
      false,
    );

    await setTestClockAt(
      new Date(Date.parse(initialUpperBound) + 30_000).toISOString(),
    );
    const reorderedTargets = [
      { ...topicTarget, id: "renamed-topic" },
      { ...categoryTarget, id: "renamed-category" },
    ];
    const reordered = await trigger("sync", {
      ...params,
      targets: reorderedTargets,
    });
    assert.equal(reordered.status, "completed", JSON.stringify(reordered));
    assert.ok(
      syncOutput(reordered).scopes.every(({ status }) => status === "advanced"),
      `改变目标别名和数组顺序不得重新初始化真实范围：${JSON.stringify(reordered)}`,
    );
    assert.deepEqual(
      syncReport(reordered).scopes.map(({ scope, position }) => ({
        scope,
        position,
      })),
      [
        {
          scope: { kind: "category", id: 42 },
          position: syncReport(reordered).upperBound,
        },
        {
          scope: { kind: "category", id: 43 },
          position: syncReport(reordered).upperBound,
        },
        {
          scope: { kind: "topic", id: 2401 },
          position: syncReport(reordered).upperBound,
        },
      ],
    );

    await updateFixtureState({ syncScenarioStage: 1 });
    await setTestClockAt("2026-10-28T03:00:00.000Z");
    await clearSourceEvents();
    const overlapped = await trigger("sync", {
      ...params,
      targets: reorderedTargets,
    });
    assert.equal(overlapped.status, "completed", JSON.stringify(overlapped));
    assert.equal(syncReport(overlapped).phase, "completed");
    const reply = await searchArchiveItem("sync 第一轮发现的旧主题新回复");
    assert.equal(reply.sourceKey.key, "post:240010");
    const replyReferences = (overlapped.result?.commits ?? [])
      .flatMap(({ items }) => items)
      .filter(({ itemId }) => itemId === reply.itemId);
    assert.equal(
      replyReferences.length,
      1,
      `同一帖子同时命中 category:42 和 topic:2401 时，同一运行只能提交一次；run=${JSON.stringify(overlapped)}`,
    );
    assert.deepEqual(
      syncOutput(overlapped).scopes.map(({ scope, status, position }) => ({
        scope,
        status,
        position,
      })),
      [
        {
          scope: { kind: "category", id: 42 },
          status: "advanced",
          position: syncReport(overlapped).upperBound,
        },
        {
          scope: { kind: "category", id: 43 },
          status: "advanced",
          position: syncReport(overlapped).upperBound,
        },
        {
          scope: { kind: "topic", id: 2401 },
          status: "advanced",
          position: syncReport(overlapped).upperBound,
        },
      ],
    );

    const scheduleParams = {
      targets: reorderedTargets,
      maxPages: 20,
      maxRequests: 100,
      maxElapsedMs: 120_000,
    };
    const firstSchedule = cliData<{
      readonly scheduleId: string;
      readonly enabled: boolean;
    }>(
      await cli([
        "schedule",
        "create",
        "binny-discovery-topic",
        "--expression",
        "0 0 0 1 1 *",
        "--time-zone",
        "UTC",
        "--action",
        "sync",
        "--params",
        JSON.stringify(scheduleParams),
        "--disabled",
      ]),
      "created",
    );
    assert.equal(firstSchedule.enabled, false);
    const updatedSchedule = cliData<{
      readonly scheduleId: string;
      readonly expression: string;
    }>(
      await cli([
        "schedule",
        "update",
        "binny-discovery-topic",
        firstSchedule.scheduleId,
        "--expression",
        "0 0 0 2 1 *",
        "--params",
        JSON.stringify({ ...scheduleParams, targets: params.targets }),
      ]),
      "updated",
    );
    assert.equal(updatedSchedule.scheduleId, firstSchedule.scheduleId);
    assert.equal(updatedSchedule.expression, "0 0 0 2 1 *");
    const removedSchedule = cliData<{ readonly removed: boolean }>(
      await cli([
        "schedule",
        "remove",
        "binny-discovery-topic",
        updatedSchedule.scheduleId,
      ]),
      "removed",
    );
    assert.equal(removedSchedule.removed, true);
    const replacementSchedule = cliData<{
      readonly scheduleId: string;
    }>(
      await cli([
        "schedule",
        "create",
        "binny-discovery-topic",
        "--expression",
        "0 0 0 3 1 *",
        "--time-zone",
        "UTC",
        "--action",
        "sync",
        "--params",
        JSON.stringify(scheduleParams),
        "--disabled",
      ]),
      "created",
    );
    assert.notEqual(replacementSchedule.scheduleId, firstSchedule.scheduleId);
    await setTestClockAt(
      new Date(
        Date.parse(syncReport(overlapped).upperBound) + 30_000,
      ).toISOString(),
    );
    const afterPlanChange = await trigger("sync", {
      ...params,
      targets: reorderedTargets,
    });
    assert.equal(afterPlanChange.status, "completed");
    assert.ok(
      syncReport(afterPlanChange).scopes.every(
        ({ mode }) => mode === "continued",
      ),
      `修改计划参数、cron 并替换计划 ID 不得重置实际范围：${JSON.stringify(afterPlanChange)}`,
    );

    const category44Target = {
      id: "other",
      kind: "category" as const,
      categoryId: 44,
      categorySlugPath: "other",
    };
    await updateFixtureState({
      dailyCollectionEnabled: false,
      syncScenarioStage: 0,
    });
    await setTestClockAt("2026-11-01T20:00:00.000Z");
    const addedScope = await trigger("sync", {
      ...params,
      targets: [category44Target],
    });
    assert.equal(addedScope.status, "completed", JSON.stringify(addedScope));
    assert.deepEqual(
      syncReport(addedScope).scopes.map(({ scope, mode }) => ({
        scope,
        mode,
      })),
      [{ scope: { kind: "category", id: 44 }, mode: "initialized" }],
    );
    assert.equal(
      syncReport(addedScope).scopes[0]?.position,
      syncReport(addedScope).upperBound,
    );
    const addedScopePosition = syncReport(addedScope).upperBound;

    await setTestClockAt(
      new Date(Date.parse(addedScopePosition) + 30_000).toISOString(),
    );
    const withoutAddedScope = await trigger("sync", {
      ...params,
      targets: [categoryTarget],
    });
    assert.equal(withoutAddedScope.status, "completed");
    assert.ok(
      syncReport(withoutAddedScope).scopes.every(
        ({ scope }) => scope.kind !== "category" || scope.id !== 44,
      ),
    );

    await setTestClockAt(
      new Date(
        Date.parse(addedScopePosition) + 2 * 60 * 60 * 1_000,
      ).toISOString(),
    );
    const readdedScope = await trigger("sync", {
      ...params,
      targets: [category44Target],
    });
    assert.equal(
      readdedScope.status,
      "completed",
      JSON.stringify(readdedScope),
    );
    const readdedCategory44 = syncReport(readdedScope).scopes[0];
    assert.ok(readdedCategory44);
    assert.equal(readdedCategory44.scope.id, 44);
    assert.equal(readdedCategory44.mode, "truncated");
    assert.equal(readdedCategory44.skippedBefore, addedScopePosition);
    assert.deepEqual(readdedCategory44.range, {
      from: new Date(
        Date.parse(syncReport(readdedScope).upperBound) - 60 * 60 * 1_000,
      ).toISOString(),
      to: syncReport(readdedScope).upperBound,
    });

    await updateFixtureState({
      dailyCollectionEnabled: true,
      dailyParentIncludesChild: true,
      postRangeEnabled: true,
      syncScenarioStage: 0,
    });
    await setTestClockAt("2026-11-01T23:00:00.000Z");
    const allVisible = await trigger("sync", {
      maxPages: 20,
      maxRequests: 100,
      maxElapsedMs: 120_000,
    });
    assert.equal(allVisible.status, "completed", JSON.stringify(allVisible));
    assert.deepEqual(syncReport(allVisible).intent, { kind: "all-visible" });
    assert.deepEqual(
      syncReport(allVisible).scopes.map(({ scope }) => scope),
      [42, 43, 44, 45, 46, 47].map((id) => ({ kind: "category", id })),
    );
    const initializedVisible = syncReport(allVisible).scopes.filter(
      ({ scope }) => scope.kind === "category" && scope.id >= 45,
    );
    assert.deepEqual(
      initializedVisible.map(({ scope, mode, position, status }) => ({
        scope,
        mode,
        position,
        status,
      })),
      [45, 46, 47].map((id) => ({
        scope: { kind: "category", id },
        mode: "initialized",
        position: syncReport(allVisible).upperBound,
        status: "initialized",
      })),
    );
    assert.deepEqual(
      await searchArchiveSourceKeys("全日受控主题 700200"),
      [],
      "全部可见范围新出现的板块只建立起点，不自动导入既有历史主题。",
    );

    const explicitHistoricalCollect = await trigger("collect", {
      topicId: 700200,
      date: "2026-11-01",
      timeZone: "UTC",
    });
    assert.equal(
      explicitHistoricalCollect.status,
      "completed",
      JSON.stringify(explicitHistoricalCollect),
    );
    assert.equal(
      (await searchArchiveItem("全日受控主题 700200 的正文")).sourceKey.key,
      "post:70020000",
      "迟到可见的历史主题仍可通过显式 collect 补采。",
    );

    await updateFixtureState({ syncScenarioStage: 1 });
    await setTestClockAt("2026-11-02T00:30:00.000Z");
    await clearSourceEvents();
    const parentChildOverlap = await trigger("sync", { maxRequests: 30 });
    assert.equal(
      parentChildOverlap.status,
      "completed",
      JSON.stringify(parentChildOverlap),
    );
    const costReport = syncReport(parentChildOverlap);
    const costEvents = (await sourceState()).events;
    assert.equal(costReport.phase, "completed", JSON.stringify(costReport));
    assert.equal(costReport.budget.maxRequests, 30);
    assert.equal(costReport.budget.stopReason, undefined);
    assert.equal(costReport.scopes.length, 6);
    assert.ok(
      costReport.scopes.every(({ status }) => status === "completed"),
      `30次主动请求额度内应完成全部6个独立范围：${JSON.stringify(costReport)}`,
    );
    assert.equal(
      costEvents.filter(({ action }) => action === "post-list").length,
      8,
      `同一run应只扫描一份8页帖子流：${JSON.stringify(costEvents)}`,
    );
    const costCounts = Object.fromEntries(
      [...new Set(costEvents.map(({ action }) => action))].map((action) => [
        action,
        costEvents.filter((event) => event.action === action).length,
      ]),
    );
    process.stdout.write(
      `sync multi-scope default-cost ${JSON.stringify({
        runId: parentChildOverlap.runId,
        scopes: costReport.scopes.map(({ scope, status }) => ({
          scope,
          status,
        })),
        budget: costReport.budget,
        sourceAccess: costReport.sourceAccess,
        sourceEventCounts: costCounts,
        postListPaths: costEvents
          .filter(({ action }) => action === "post-list")
          .map(({ path }) => path),
      })}\n`,
    );
    const childReply = await searchArchiveItem("全日子板块范围重叠回复");
    assert.equal(childReply.sourceKey.key, "post:70040001");
    assert.equal(
      (parentChildOverlap.result?.commits ?? [])
        .flatMap(({ items }) => items)
        .filter(({ itemId }) => itemId === childReply.itemId).length,
      1,
      "父板块与真实子板块范围重叠时，同一新回复只归档一次。",
    );
    const parentAndChildPositions = syncReport(parentChildOverlap)
      .scopes.filter(
        ({ scope }) =>
          scope.kind === "category" && (scope.id === 45 || scope.id === 46),
      )
      .map(({ scope, position, status }) => ({ scope, position, status }));
    assert.deepEqual(
      parentAndChildPositions,
      [45, 46].map((id) => ({
        scope: { kind: "category", id },
        position: syncReport(parentChildOverlap).upperBound,
        status: "completed",
      })),
    );

    const originalCategory42 = syncReport(parentChildOverlap).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 42,
    );
    assert.ok(originalCategory42);
    await cliData(
      await cli([
        "bin",
        "update",
        "binny-discovery-topic",
        "--identity",
        "binny-discovery-alt-profile",
      ]),
      "updated",
    );
    await setTestClockAt("2026-11-02T01:00:00.000Z");
    const changedIdentityRun = await trigger("sync", {
      ...params,
      targets: [categoryTarget],
    });
    assert.equal(changedIdentityRun.status, "completed");
    assert.ok(
      syncReport(changedIdentityRun).scopes.every(
        ({ mode }) => mode === "initialized",
      ),
      JSON.stringify(changedIdentityRun),
    );
    assert.equal(
      syncReport(changedIdentityRun).scopes[0]?.position,
      syncReport(changedIdentityRun).upperBound,
    );

    await cliData(
      await cli([
        "bin",
        "update",
        "binny-discovery-topic",
        "--identity",
        originalIdentity,
      ]),
      "updated",
    );
    await setTestClockAt("2026-11-02T01:05:00.000Z");
    const resumedOriginalIdentity = await trigger("sync", {
      ...params,
      targets: [categoryTarget],
    });
    assert.ok(
      syncReport(resumedOriginalIdentity).scopes.every(
        ({ mode }) => mode === "continued",
      ),
      `恢复原访问身份时应续用原范围位置：${JSON.stringify(resumedOriginalIdentity)}`,
    );
    assert.equal(
      syncReport(resumedOriginalIdentity).scopes[0]?.range?.from,
      originalCategory42.position,
    );

    await cliData(
      await cli([
        "bin",
        "update",
        "binny-discovery-topic",
        "--config",
        JSON.stringify(adapterConfig("http://linuxdo-e2e-other:8081")),
      ]),
      "updated",
    );
    await waitForRuntime();
    await loginLinuxdoUser({
      binId: "binny-discovery-topic",
      cli,
      browser: browser!,
      publishedHost,
      serverPort,
      sourceOrigin: "http://linuxdo-e2e-other:8081",
      sourceControlUrl: sourceUrl("/__control/state"),
      username: "binny-discovery-user",
      password: "linuxdo-fixture",
    });
    await setTestClockAt("2026-11-02T01:30:00.000Z");
    const changedOriginRun = await trigger("sync", {
      ...params,
      targets: [categoryTarget],
    });
    assert.ok(
      syncReport(changedOriginRun).scopes.every(
        ({ mode }) => mode === "initialized",
      ),
      `新站点 origin 应建立独立起点：${JSON.stringify(changedOriginRun)}`,
    );
    assert.equal(
      syncReport(changedOriginRun).scopes[0]?.position,
      syncReport(changedOriginRun).upperBound,
    );

    await cliData(
      await cli([
        "bin",
        "update",
        "binny-discovery-topic",
        "--config",
        JSON.stringify(adapterConfig(originalOrigin)),
      ]),
      "updated",
    );
    await waitForRuntime();
    await setTestClockAt("2026-11-02T01:35:00.000Z");
    const resumedOriginalOrigin = await trigger("sync", {
      ...params,
      targets: [categoryTarget],
    });
    assert.ok(
      syncReport(resumedOriginalOrigin).scopes.every(
        ({ mode }) => mode === "continued",
      ),
      `恢复原站点 origin 时应续用原范围位置：${JSON.stringify(resumedOriginalOrigin)}`,
    );
    assert.equal(
      syncReport(resumedOriginalOrigin).scopes[0]?.range?.from,
      syncReport(resumedOriginalIdentity).scopes[0]?.position,
    );

    const originalCategory43 = syncReport(resumedOriginalOrigin).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 43,
    );
    assert.ok(originalCategory43);
    await compose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "90",
      "runtime-linuxdo-two",
    ]);
    secondRuntimeStarted = true;
    const secondManifest = await runtimeManifest("runtime-linuxdo-two");
    await Promise.all([
      waitForRuntimeHealth("runtime-linuxdo-two"),
      waitForBinRegistration(secondManifest.sourceAdapter, "linuxdo-two"),
    ]);
    await cliData(
      await cli([
        "bin",
        "update",
        "linuxdo-two",
        "--identity",
        originalIdentity,
        "--config",
        JSON.stringify(adapterConfig(originalOrigin)),
      ]),
      "updated",
    );
    await waitForRuntime("linuxdo-two");
    await loginLinuxdoUser({
      binId: "linuxdo-two",
      cli,
      browser: browser!,
      publishedHost,
      serverPort,
      sourceOrigin: originalOrigin,
      sourceControlUrl: sourceUrl("/__control/state"),
      username: "binny-discovery-user",
      password: "linuxdo-fixture",
    });
    await setTestClockAt("2026-11-02T02:00:00.000Z");
    const secondBinSync = await triggerLinuxdoRun(cli, "linuxdo-two", "sync", {
      ...params,
      targets: [categoryTarget],
    });
    assert.equal(secondBinSync.status, "completed");
    assert.ok(
      syncReport(secondBinSync).scopes.every(
        ({ mode }) => mode === "initialized",
      ),
      `相同 identity、origin 和 scope 的另一个 bin 应独立初始化：${JSON.stringify(secondBinSync)}`,
    );
    assert.equal(
      syncReport(secondBinSync).scopes[0]?.position,
      syncReport(secondBinSync).upperBound,
    );

    const childCategoryTarget = {
      id: "category-43",
      kind: "category" as const,
      categoryId: 43,
      categorySlugPath: "controlled/child",
    };
    await setTestClockAt("2026-11-02T02:00:30.000Z");
    const mainAfterSecondBin = await trigger("sync", {
      ...params,
      targets: [categoryTarget, childCategoryTarget],
    });
    assert.equal(
      mainAfterSecondBin.status,
      "completed",
      JSON.stringify(mainAfterSecondBin),
    );
    const mainCategory42AfterSecondBin = syncReport(
      mainAfterSecondBin,
    ).scopes.find(({ scope }) => scope.kind === "category" && scope.id === 42);
    const mainCategory43AfterSecondBin = syncReport(
      mainAfterSecondBin,
    ).scopes.find(({ scope }) => scope.kind === "category" && scope.id === 43);
    assert.ok(mainCategory42AfterSecondBin);
    assert.ok(mainCategory43AfterSecondBin);
    assert.equal(
      mainCategory42AfterSecondBin.range?.from,
      syncReport(resumedOriginalOrigin).scopes[0]?.position,
    );
    assert.equal(mainCategory43AfterSecondBin.mode, "continued");
    assert.equal(
      mainCategory43AfterSecondBin.range?.from,
      originalCategory43.position,
      "另一个 bin 的初始化不得重置当前 bin 的既有类别接续位置。",
    );
    const priorityBaseUpperBound = syncReport(secondBinSync).upperBound;
    const minutesAfterPriorityBase = (minutes: number) =>
      new Date(
        Date.parse(priorityBaseUpperBound) + minutes * 60_000,
      ).toISOString();
    await setTestClockAt(minutesAfterPriorityBase(30));
    const newerScopeAdvanced = await triggerLinuxdoRun(
      cli,
      "linuxdo-two",
      "sync",
      {
        targets: [childCategoryTarget],
        maxPages: 20,
        maxRequests: 100,
        maxElapsedMs: 120_000,
      },
    );
    assert.equal(
      newerScopeAdvanced.status,
      "completed",
      JSON.stringify(newerScopeAdvanced),
    );
    assert.equal(syncReport(newerScopeAdvanced).phase, "completed");
    assert.equal(syncReport(newerScopeAdvanced).scopes[0]?.mode, "continued");
    assert.equal(syncReport(newerScopeAdvanced).scopes[0]?.status, "completed");
    const category42BeforeLimit = syncReport(secondBinSync).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 42,
    );
    const category43BeforeLimit = syncReport(newerScopeAdvanced).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 43,
    );
    assert.ok(category42BeforeLimit);
    assert.ok(category43BeforeLimit);
    assert.equal(category42BeforeLimit.position, priorityBaseUpperBound);
    assert.equal(
      category43BeforeLimit.position,
      syncReport(newerScopeAdvanced).upperBound,
    );

    await setTestClockAt(minutesAfterPriorityBase(60));
    await clearSourceEvents();
    const limitedRun = await triggerLinuxdoRun(cli, "linuxdo-two", "sync", {
      targets: [categoryTarget, childCategoryTarget],
      maxPages: 20,
      maxRequests: 3,
      maxElapsedMs: 120_000,
    });
    assert.equal(limitedRun.status, "completed", JSON.stringify(limitedRun));
    assert.equal(syncReport(limitedRun).phase, "budget-exhausted");
    assert.equal(syncReport(limitedRun).budget.stopReason, "request-limit");
    assert.deepEqual(
      syncReport(limitedRun).scopes.map(({ scope, status }) => ({
        scope,
        status,
      })),
      [
        { scope: { kind: "category", id: 42 }, status: "unknown" },
        { scope: { kind: "category", id: 43 }, status: "unstarted" },
      ],
      JSON.stringify(syncReport(limitedRun).scopes),
    );
    const category42AfterLimit = syncReport(limitedRun).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 42,
    );
    const category43BeforePriority = syncReport(limitedRun).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 43,
    );
    assert.ok(category42AfterLimit);
    assert.ok(category43BeforePriority);
    assert.equal(
      category42AfterLimit.position,
      syncReport(limitedRun).upperBound,
    );
    assert.equal(
      category43BeforePriority.position,
      syncReport(newerScopeAdvanced).upperBound,
    );

    await setTestClockAt(minutesAfterPriorityBase(90));
    await clearSourceEvents();
    const priorityRun = await triggerLinuxdoRun(cli, "linuxdo-two", "sync", {
      targets: [categoryTarget, childCategoryTarget],
      maxPages: 20,
      maxRequests: 3,
      maxElapsedMs: 120_000,
    });
    assert.equal(priorityRun.status, "completed", JSON.stringify(priorityRun));
    assert.equal(syncReport(priorityRun).phase, "budget-exhausted");
    assert.equal(syncReport(priorityRun).budget.stopReason, "request-limit");
    assert.deepEqual(
      syncReport(priorityRun).scopes.map(({ scope, status }) => ({
        scope,
        status,
      })),
      [
        { scope: { kind: "category", id: 42 }, status: "unstarted" },
        { scope: { kind: "category", id: 43 }, status: "unknown" },
      ],
      `预算优先处理已有位置较旧的 category:43，同时保留发现顺序与 category:42 的原位置：${JSON.stringify(syncReport(priorityRun).scopes)}`,
    );
    const category42AfterPriority = syncReport(priorityRun).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 42,
    );
    const category43AfterPriority = syncReport(priorityRun).scopes.find(
      ({ scope }) => scope.kind === "category" && scope.id === 43,
    );
    assert.equal(
      category42AfterPriority?.position,
      category42AfterLimit.position,
    );
    assert.equal(
      category43AfterPriority?.position,
      syncReport(priorityRun).upperBound,
    );
    assert.equal(
      (await sourceState()).events.some(({ action }) => action === "post-list"),
      false,
      "小请求额度应在首次帖子流读取前耗尽；范围仍通过公开运行报告体现排序。",
    );

    await updateFixtureState({ categoriesUnavailable: true });
    await setTestClockAt(minutesAfterPriorityBase(120));
    await clearSourceEvents();
    const discoveryFailure = await trigger("sync", {
      maxPages: 20,
      maxRequests: 100,
      maxElapsedMs: 120_000,
    });
    assert.equal(discoveryFailure.status, "failed");
    assert.equal(syncReport(discoveryFailure).phase, "failed");
    assert.equal(syncReport(discoveryFailure).discovery, "failed");
    assert.deepEqual(syncReport(discoveryFailure).intent, {
      kind: "all-visible",
    });
    assert.equal(syncReport(discoveryFailure).scopes.length, 0);
    assert.ok(
      Number.isFinite(Date.parse(syncReport(discoveryFailure).upperBound)),
    );
    assert.deepEqual(
      (await sourceState()).events.map(({ action }) => action),
      ["site-home", "session-current", "categories"],
    );
    assert.equal(
      (await sourceState()).events.some(({ action }) => action === "post-list"),
      false,
    );
    await clearSourceEvents();
    await readBinRuntime("binny-discovery-topic");
    assert.deepEqual(
      (await sourceState()).events,
      [],
      "发现失败后的 bin get 查询不得触发来源请求或初始化范围。",
    );
  } finally {
    await updateFixtureState({
      categoriesUnavailable: false,
      dailyCollectionEnabled: false,
      dailyParentIncludesChild: false,
      postRangeEnabled: false,
      postRangeAddAfterFirstPage: false,
      postRangeRepeatPage: false,
      postRangeInvalidPage: null,
      postRangeResponseStatus: null,
      postRangeRetryAfter: null,
      syncScenarioStage: 0,
    });
    if (secondRuntimeStarted) {
      await rawCompose(["stop", "runtime-linuxdo-two"]);
      const secondBin = await cli(["bin", "get", "linuxdo-two"]);
      if (secondBin.code === 0) await cli(["bin", "remove", "linuxdo-two"]);
    }
    await cliData(
      await cli([
        "bin",
        "update",
        "binny-discovery-topic",
        "--identity",
        originalIdentity,
        "--config",
        JSON.stringify(adapterConfig(originalOrigin)),
      ]),
      "updated",
    );
    await setSourceAccessPolicy(0, 1);
    await setTestClockOffset(0);
  }
}

async function verifyDailyCollection(): Promise<void> {
  await updateFixtureState({ dailyCollectionEnabled: true });

  const limited = await trigger("collect", {
    date: "2026-11-01",
    timeZone: "UTC",
    maxTopics: 1,
  });
  assert.equal(limited.status, "completed", JSON.stringify(limited));
  assert.equal(limited.result?.output?.collectionCompleteness, "partial");
  assert.deepEqual(
    limited.result?.output?.incompleteScopes?.map(({ scope, reasonCode }) => ({
      scope,
      reasonCode,
    })),
    [
      { scope: "target:category-45", reasonCode: "topic_limit_reached" },
      {
        scope: "target:category-46",
        reasonCode: "not_scanned_due_to_topic_limit",
      },
      {
        scope: "target:category-47",
        reasonCode: "not_scanned_due_to_topic_limit",
      },
    ],
  );
  const limitedTopic = await searchArchiveItem("全日受控主题 700200");
  assert.equal(limitedTopic.sourceKey.key, "post:70020000");

  await updateFixtureState({ invalidCreatedAtTopicIds: [700100] });
  const invalidDate = await trigger(
    "collect",
    {
      date: "2026-11-01",
      timeZone: "UTC",
    },
    180_000,
  );
  assert.equal(invalidDate.status, "failed", JSON.stringify(invalidDate));
  assert.equal(
    invalidDate.result?.error?.code,
    "discourse_topic_created_at_invalid",
  );
  assert.ok(
    invalidDate.result?.error?.impact?.includes("target:category-45"),
    JSON.stringify(invalidDate),
  );
  assert.ok(
    invalidDate.result?.completedScopes?.includes("post:70019900"),
    `日期失败前应报告已提交的主题资料：${JSON.stringify(invalidDate)}`,
  );
  assert.equal(
    (await searchArchiveItem("全日受控主题 700199")).sourceKey.key,
    "post:70019900",
    "失败运行已采集的资料仍应可通过公开归档查询读取。",
  );
  assert.equal(
    (await searchArchiveItem("全日受控主题 700200")).sourceKey.key,
    "post:70020000",
    "日期读取失败后，应保留此前已经提交的主题归档。",
  );
  await updateFixtureState({ invalidCreatedAtTopicIds: [] });

  const dailyParentTarget = {
    id: "category-45",
    kind: "category",
    categoryId: 45,
    categorySlugPath: "daily",
  } as const;
  await updateFixtureState({ dailyTopicOverlapCount: 2 });
  await clearSourceEvents();
  const beforeOverlappingPages = await sourceState();
  const overlappingPages = await trigger(
    "collect",
    {
      targets: [dailyParentTarget],
      date: "2026-11-01",
      timeZone: "UTC",
      maxTopics: 501,
    },
    300_000,
  );
  const afterOverlappingPages = await sourceState();
  const parentPageEvents = afterOverlappingPages.events
    .slice(beforeOverlappingPages.events.length)
    .filter(
      ({ action, path }) =>
        action === "topic-list-payload" &&
        path.startsWith("/c/daily/45/l/latest.json"),
    );
  const parentFirstPage = parentPageEvents.find(
    ({ path }) =>
      new URL(path, "http://linuxdo-fixture").searchParams.get("page") === null,
  );
  const parentSecondPage = parentPageEvents.find(
    ({ path }) =>
      new URL(path, "http://linuxdo-fixture").searchParams.get("page") === "1",
  );
  await updateFixtureState({
    dailyTopicOverlapCount: 1,
    paginationOrderMutationEnabled: true,
  });
  await clearSourceEvents();
  const beforeChangedOrder = await sourceState();
  const changedOrder = await trigger("collect", {
    targets: linuxdoTargets("latest"),
    date: "2026-11-01",
    timeZone: "UTC",
  });
  const afterChangedOrder = await sourceState();
  await updateFixtureState({ paginationOrderMutationEnabled: false });
  const changedOrderPage = afterChangedOrder.events
    .slice(beforeChangedOrder.events.length)
    .find(
      ({ action, path }) =>
        action === "topic-list-payload" && path.startsWith("/latest.json"),
    );
  assert.deepEqual(changedOrderPage?.topicIds, [800001]);
  assert.ok(changedOrderPage?.moreTopicsUrl?.includes("order=activity"));
  assert.deepEqual(
    parentFirstPage?.topicIds?.slice(-2),
    parentSecondPage?.topicIds?.slice(0, 2),
    `page1 明确重复上一页末尾的两个主题：${JSON.stringify(parentPageEvents)}`,
  );
  assert.ok(
    overlappingPages.status === "completed" && changedOrder.status === "failed",
    JSON.stringify({
      overlappingPages: {
        status: overlappingPages.status,
        errorCode: overlappingPages.result?.error?.code,
        message: overlappingPages.result?.error?.message,
        completeness: overlappingPages.result?.output?.collectionCompleteness,
      },
      changedOrder: {
        status: changedOrder.status,
        errorCode: changedOrder.result?.error?.code,
        completeness: changedOrder.result?.output?.collectionCompleteness,
        completedScopes: changedOrder.result?.completedScopes,
        fetchedLaterMatchingTopic: afterChangedOrder.events
          .slice(beforeChangedOrder.events.length)
          .some(
            ({ action, path }) =>
              action === "topic" && path === "/t/800003.json",
          ),
      },
    }),
  );

  assert.equal(
    overlappingPages.status,
    "completed",
    JSON.stringify(overlappingPages.result?.error),
  );
  assert.equal(
    overlappingPages.result?.output?.collectionCompleteness,
    "complete",
  );
  assert.ok(
    overlappingPages.result?.output?.completedScopes?.includes(
      "target:category-45",
    ),
  );
  assert.equal(changedOrder.status, "failed", JSON.stringify(changedOrder));
  assert.equal(
    changedOrder.result?.error?.code,
    "discourse_topic_list_pagination_invalid",
    JSON.stringify({ overlappingPages, changedOrder }),
  );
  assert.ok(
    changedOrder.result?.error?.impact?.includes("target:latest"),
    JSON.stringify(changedOrder),
  );
  assert.ok(
    changedOrder.result?.completedScopes?.includes("post:80000100"),
    JSON.stringify(changedOrder),
  );
  assert.equal(
    afterChangedOrder.events
      .slice(beforeChangedOrder.events.length)
      .some(
        ({ action, path }) => action === "topic" && path === "/t/800003.json",
      ),
    false,
    "排序改变后不得把日期边界用于跳过后续匹配主题。",
  );
  assert.equal(
    (await searchArchiveItem("排序变更前受控主题 800001")).sourceKey.key,
    "post:80000100",
  );

  const completeAtLimit = await trigger(
    "collect",
    {
      date: "2026-11-01",
      timeZone: "UTC",
      maxTopics: 501,
    },
    900_000,
  );
  assert.equal(
    completeAtLimit.status,
    "completed",
    JSON.stringify(completeAtLimit),
  );
  assert.equal(
    completeAtLimit.result?.output?.collectionCompleteness,
    "complete",
  );
  assert.deepEqual(completeAtLimit.result?.output?.incompleteScopes, []);

  const beforeFullCollection = await sourceState();
  const complete = await trigger(
    "collect",
    {
      date: "2026-11-01",
      timeZone: "UTC",
    },
    900_000,
  );
  assert.equal(complete.status, "completed", JSON.stringify(complete));
  assert.equal(complete.result?.output?.collectionCompleteness, "complete");
  assert.deepEqual(complete.result?.output?.incompleteScopes, []);
  for (const scope of [
    "target:category-42",
    "target:category-43",
    "target:category-44",
    "target:category-45",
    "target:category-46",
    "target:category-47",
  ]) {
    assert.ok(
      complete.result?.output?.completedScopes?.includes(scope),
      `默认全可见板块采集应穷尽 ${scope}：${JSON.stringify(complete)}`,
    );
  }

  const afterFullCollection = await sourceState();
  const runEvents = afterFullCollection.events.slice(
    beforeFullCollection.events.length,
  );
  const dailyListPaths = runEvents
    .filter(({ action }) => action === "topic-list")
    .map(({ path }) => path);
  for (const path of [
    "/c/daily/45/l/latest.json",
    "/c/daily/daily-child/46/l/latest.json",
    "/c/another/47/l/latest.json",
  ]) {
    assert.ok(
      dailyListPaths.some((requestPath) => requestPath.startsWith(path)),
      `应采集当前可见范围 ${path}：${dailyListPaths.join("\n")}`,
    );
  }
  assert.ok(
    dailyListPaths.some((path) => path.includes("page=1")) &&
      dailyListPaths.some((path) => path.includes("page=2")),
    `501 项受控数据应跨多个列表页：${dailyListPaths.join("\n")}`,
  );
  assert.ok(
    dailyListPaths.every(
      (path) =>
        path.includes("order=created") && path.includes("ascending=false"),
    ),
    "日期范围必须显式使用可验证的 created 降序列表。",
  );

  const topicRequests = runEvents
    .filter(
      ({ action, path }) =>
        action === "topic" && /\/t\/7\d+\.json$/u.test(path),
    )
    .map(({ path }) => Number(/\/t\/(\d+)\.json$/u.exec(path)?.[1]));
  const expectedTopicIds = Array.from(
    { length: 501 },
    (_, index) => 700001 + index,
  );
  assert.deepEqual(
    topicRequests.toSorted((first, second) => first - second),
    expectedTopicIds,
  );
  assert.equal(topicRequests.length, 501);
  assert.equal(
    new Set(topicRequests).size,
    501,
    "分页重叠不得重复读取主题内容。",
  );
  assert.ok(
    topicRequests.includes(700200),
    "固定日期重跑应重新发现先前已归档主题。",
  );
  assert.equal(
    topicRequests[0],
    700200,
    "固定日期新运行应从所选日范围开头重新发现，而非从旧游标续采。",
  );
  assert.ok(!topicRequests.includes(700502), "日期结束上界不包含未来主题。");
  assert.ok(!topicRequests.includes(699999), "日期开始下界不包含前一日主题。");

  const dailySourceKeys = await searchArchiveSourceKeys("全日受控主题");
  const expectedSourceKeys = Array.from(
    { length: 501 },
    (_, index) => `post:${String(700001 + index)}00`,
  );
  assert.deepEqual(dailySourceKeys, expectedSourceKeys);
  await updateFixtureState({ dailyCollectionEnabled: false });
}

async function verifyLogout(): Promise<void> {
  const current = await sourceState();
  const logoutCount = current.events.filter(
    ({ action }) => action === "logout",
  ).length;
  const session = await openHumanSession();
  const viewer = await openViewer(session);
  try {
    await navigateThroughViewer(
      viewer,
      "http://linuxdo-e2e-source:8081/logout",
    );
    await waitForSourceEvent("logout", logoutCount + 1);
  } finally {
    await closeHumanSession(session.sessionId);
    await viewer.close();
  }
  const loggedOut = await sourceState();
  assert.ok(
    loggedOut.events.some(
      ({ action, authenticated }) => action === "logout" && authenticated,
    ),
  );

  const check = await trigger("check", { topicId: 2401 });
  assert.equal(check.status, "completed");
  assert.equal(checkOutput(check).availability, "unavailable");
  assert.ok(
    checkOutput(check).problems.some(({ code }) => code === "login_required"),
  );
  const list = await trigger("list-categories", {});
  assert.equal(list.status, "failed");
  assert.equal(list.result?.error?.code, "login_required");
  assert.equal(list.result?.error?.requiresHuman, true);
  const collect = await trigger("collect", { topicId: 2401 });
  assert.equal(collect.status, "failed");
  assert.equal(collect.result?.error?.code, "login_required");
  assert.equal(collect.result?.error?.requiresHuman, true);
}

async function runScopeTransitionsAcceptance(): Promise<void> {
  process.stdout.write("运行范围变化专项正式验收。\n");
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=source", path.resolve("scripts/acceptance.ts")],
      {
        env: {
          ...process.env,
          BINNY_E2E_INTERNAL_STEP: "scope-transitions",
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  assert.equal(exitCode, 0, "默认正式验收中的范围变化专项失败。");
  process.stdout.write("范围变化专项正式验收通过。\n");
}

async function main(): Promise<void> {
  try {
    if (
      internalStep !== undefined &&
      internalStep !== "bounded-sync" &&
      internalStep !== "sync-interruption" &&
      internalStep !== "state-corruption" &&
      internalStep !== "post-range" &&
      internalStep !== "native-category-tree" &&
      internalStep !== "sync-category-candidates" &&
      internalStep !== "scope-transitions"
    )
      throw new Error(`未知 Linux.do 验收内部步骤：${internalStep}`);
    await createOverlay();
    const config = await compose(["config", "--quiet"]);
    assert.equal(config.code, 0);
    composeStarted = true;
    await provisionClockShim();

    await compose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "90",
      "postgres",
      "server",
      "runtime-linuxdo",
      "linuxdo-e2e-source",
    ]);
    serverPort = await publishedPort("server", 3000);
    sourcePort = await publishedPort("linuxdo-e2e-source", 8081);
    process.stdout.write(
      `Linux.do 验收隔离环境：project=${projectName}, serverImage=${serverImage}, browserImage=${browserImage}, server=${publishedHost}:${String(serverPort)}, source=${publishedHost}:${String(sourcePort)}。\n`,
    );
    await Promise.all([waitForApi(), waitForRuntimeHealth()]);
    if (acceptanceFocus === undefined) browser = await startOuterBrowser();

    const manifest = await runtimeManifest();
    await waitForBinRegistration(manifest.sourceAdapter);
    const configured = cliData<{ readonly id: string }>(
      await cli([
        "bin",
        "update",
        "binny-discovery-topic",
        "--identity",
        "binny-discovery-profile",
        "--config",
        JSON.stringify({
          origin: "http://linuxdo-e2e-source:8081",
          sourceAccess: {
            groups: {
              linuxdo: {
                sources: ["site", "media"],
                minimumIntervalMs: 0,
                maxConcurrency: 1,
              },
            },
          },
        }),
      ]),
      "updated",
    );
    assert.equal(configured.id, "binny-discovery-topic");
    await waitForRuntime();
    if (acceptanceFocus === "source-state") {
      await verifySourceStateFreshness(manifest);
      const sourceAccessProbe = await trigger("check", { topicId: 2401 });
      assert.equal(sourceAccessProbe.status, "completed");
      assert.ok(sourceAccessSummary(sourceAccessProbe).admittedAttempts > 0);
      await verifyCorruptSourceStateVisibility();
      process.stdout.write(
        "公开 heartbeat 省略状态时旧快照转为 stale、正式运行器重启后恢复 current；损坏冷却状态公开且拒绝来源访问。\n",
      );
      return;
    }
    await verifyCategoryActionDiscovery();
    process.stdout.write("list-categories 的正式动作声明发现通过。\n");

    await verifyActionParameterValidation();
    process.stdout.write("本次动作参数校验定位错误且不改长期配置通过。\n");
    const journey = await verifyLoginRequired();
    process.stdout.write("登录状态检查与 noVNC 人工登录通过。\n");
    if (internalStep === "sync-interruption") {
      await setSourceAccessPolicy(0, 1);
      await updateFixtureState({
        postRangeEnabled: true,
        postRangePause: null,
        syncScenarioStage: 0,
      });
      await setTestClockAt("2026-10-28T03:00:00.000Z");
      const seed = await trigger("sync", {
        targets: linuxdoTargets("category"),
        maxPages: 20,
        maxRequests: 100,
        maxElapsedMs: 120_000,
      });
      assert.equal(seed.status, "completed", JSON.stringify(seed));
      assert.equal(syncOutput(seed).outcome, "initialized");
      const seededPosition = syncOutput(seed).scopes.find(
        ({ scope }) => scope.kind === "category" && scope.id === 42,
      )?.position;
      assert.ok(seededPosition !== undefined);
      await verifySyncCancellationAndRuntimeExit(seededPosition);
      await verifyCorruptSyncStateVisibility();
      process.stdout.write(
        "sync队列/执行中取消、worker/runtime退出、U接续与状态损坏保护通过。\n",
      );
      return;
    }
    if (internalStep === "native-category-tree") {
      await verifyNativeCategoryTree();
      process.stdout.write(
        "原生嵌套子板块树、重复节点后代去重与新范围U初始化通过。\n",
      );
      return;
    }
    if (internalStep === "sync-category-candidates") {
      await verifySyncPostCategoryCandidates();
      process.stdout.write(
        "帖子流分类候选的安全跳过、混合字段回退与显式主题范围通过。\n",
      );
      return;
    }
    if (internalStep === "scope-transitions") {
      await verifySyncScopeTransitions();
      process.stdout.write("sync 范围身份、重叠、变化、隔离和未知状态通过。\n");
      return;
    }
    if (internalStep === "post-range") {
      await verifyPostCreatedRangeCollection();
      process.stdout.write("postCreatedRange 边界、归档与未来范围通过。\n");
      return;
    }
    if (internalStep === "bounded-sync") {
      const confirmedPosition = await verifyBoundedSync();
      await verifySyncCancellationAndRuntimeExit(confirmedPosition);
      await verifyCorruptSyncStateVisibility();
      process.stdout.write(
        "sync 初始化、增量接续、worker/runtime中断、取消、预算停止与状态损坏保护通过。\n",
      );
      return;
    }
    if (internalStep === "state-corruption") {
      await verifyCorruptSourceStateVisibility();
      await verifyCorruptSyncStateVisibility();
      process.stdout.write(
        "来源准入与同步状态损坏按公开快照拒绝来源访问和相关动作。\n",
      );
      return;
    }
    await verifySharedSourceAccess();
    process.stdout.write("Linux.do 跨动作／worker 来源准入及报告解释通过。\n");
    await assertSignedInCheckFailures();
    process.stdout.write("挑战页面与指定主题不可用分支通过。\n");
    await verifyNavigationRace();
    process.stdout.write("页面导航销毁执行上下文后的有界原请求重读通过。\n");
    await verifyNativeChallengeRecovery();
    process.stdout.write("原生挑战识别、点击与原请求恢复通过。\n");
    await verifyPermissionAfterRecovery();
    process.stdout.write("挑战解除后仍按原请求权限与业务校验判定通过。\n");
    await verifyPersistentChallengeBudget();
    process.stdout.write("持续挑战的一轮时间与两次点击上限通过。\n");
    await verifyChallengeCancellation();
    process.stdout.write("原生挑战恢复中的取消优先与停止确认通过。\n");
    await verifyRunRecoveryBudget();
    process.stdout.write("跨 JSON 读取共享三轮恢复预算通过。\n");
    await verifyTopicArchive(journey.firstCollection, journey.itemIds);
    process.stdout.write(
      "主题、回复、关系、媒体、重复、编辑、新回复与有限观察通过。\n",
    );
    await verifyPostCreatedRangeCollection();
    process.stdout.write(
      "帖子创建时间区间、before分页、扫描期间新增、上下文归档与未知覆盖报告通过。\n",
    );
    const confirmedSyncPosition = await verifyBoundedSync();
    process.stdout.write(
      "sync 首次初始化、连续新增、重启接续、一小时截断与预算停止通过。\n",
    );
    await verifySyncCancellationAndRuntimeExit(confirmedSyncPosition);
    process.stdout.write(
      "sync排队取消、范围内取消、worker/runtime退出与显式接续通过。\n",
    );
    await verifyDiscovery();
    process.stdout.write(
      "latest/category 分页、去重、时间范围、数量限制和部分失败范围通过。\n",
    );
    await verifyCategoryDiscovery();
    process.stdout.write(
      "板块动作发现、当前身份可见树、错误诊断和直接引用采集通过。\n",
    );
    await verifyRunReportAfterWorkerInterruption();
    process.stdout.write(
      "运行中报告、错误运行器拒绝、worker 异常退出保留和终结历史保护通过。\n",
    );
    await verifyDailyCollection();
    process.stdout.write(
      "全日跨板块分页、501 个唯一主题、日期边界、限额部分结果和失败保留通过。\n",
    );
    await verifyScheduledCollectionAcrossMidnight();
    await verifySourceCooldownAndSnapshots();
    process.stdout.write(
      "Retry-After 秒数与 HTTP 日期冷却跨运行器重启持续生效，bin get 快照只读且区分旧状态通过。\n",
    );
    await verifySourceStateFreshness(manifest);
    process.stdout.write(
      "公开 heartbeat 省略状态时旧快照转为 stale，正式运行器重启后恢复 current。\n",
    );
    await verifySyncPostCategoryCandidates();
    process.stdout.write(
      "帖子流分类候选的安全跳过、混合字段回退与显式主题范围通过。\n",
    );
    await verifyLogout();
    process.stdout.write("退出登录后的全新检查和采集语义通过。\n");
    await verifyCorruptSourceStateVisibility();
    process.stdout.write(
      "损坏的来源冷却状态公开为不可用并拒绝后续主动访问通过。\n",
    );
    await verifyCorruptSyncStateVisibility();
    process.stdout.write("接续状态损坏的公开诊断与来源访问阻止通过。\n");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${composeStarted ? await diagnostics() : ""}`,
      { cause: error },
    );
  } finally {
    await viewerBrowser?.close().catch(() => undefined);
    if (composeStarted) {
      await rawCompose(["down", "--volumes", "--remove-orphans"]);
      for (const service of [
        "postgres",
        "server",
        "runtime-linuxdo",
        "linuxdo-e2e-source",
      ]) {
        await run("docker", [
          "rm",
          "--force",
          `${projectName}-${service}-1`,
        ]).catch(() => undefined);
      }
      for (const network of ["default", "runtime", "connections", "browser"]) {
        await run("docker", [
          "network",
          "rm",
          `${projectName}_${network}`,
        ]).catch(() => undefined);
      }
      for (const volume of [
        "postgres-data",
        "bins",
        "resource-data",
        "discovery-test-clock",
      ]) {
        await run("docker", ["volume", "rm", `${projectName}_${volume}`]).catch(
          () => undefined,
        );
      }
    }
    await run("docker", [
      "image",
      "rm",
      "--force",
      serverImage,
      browserImage,
    ]).catch(() => undefined);
    if (overlayDirectory !== undefined)
      await rm(overlayDirectory, { recursive: true, force: true });
  }
  if (internalStep === undefined && acceptanceFocus === undefined) {
    await runScopeTransitionsAcceptance();
  }
}

await main();
