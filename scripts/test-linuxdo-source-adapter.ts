import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { type Browser, type Page } from "playwright-core";

import {
  closeLinuxdoHumanSession,
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
} from "./binny-e2e-linuxdo-journey.ts";

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

type FixtureState = {
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
  readonly dailyCollectionEnabled: boolean;
  readonly dailyTopicOverlapCount: number;
  readonly paginationOrderMutationEnabled: boolean;
  readonly invalidCreatedAtTopicIds: readonly number[];
  readonly topicVersion: number;
  readonly replyVersion: number;
  readonly addedReply: boolean;
  readonly discoveryAddedReply: boolean;
  readonly omittedPostIds: readonly number[];
  readonly unavailableTopicIds: readonly number[];
  readonly unavailableMedia: readonly string[];
  readonly unavailableMediaStatus: number;
  readonly topicCreatedAtOverrides?: Readonly<Record<number, string>>;
  readonly topicListDelayMs?: number;
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
    readonly requiresHuman: boolean;
    readonly suggestion?: string;
  }[];
};

function checkOutput(run: ManualRun): LinuxdoCheckOutput {
  assert.ok(run.result?.output !== undefined);
  return run.result.output as LinuxdoCheckOutput;
}

type ArchiveItemState = {
  readonly sourceKey: { readonly namespace: string; readonly key: string };
  readonly sourceRef?: string;
  readonly metadata?: Record<string, unknown>;
  readonly body?: {
    readonly html?: string;
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

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.acceptance.yaml");
const clockShimSource = path.join(
  repositoryRoot,
  "scripts/binny-e2e-test-clock.ts",
);
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const projectName = `binny-discovery-${suffix}`;
const serverImage = `${projectName}-server:local`;
const browserImage = `${projectName}-linuxdo:local`;
const publishedHost =
  process.env.BINNY_DISCOVERY_PUBLISHED_HOST ?? "172.17.0.1";
const password = `binny-discovery-${randomUUID().replaceAll("-", "")}`;
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
      "      - browser",
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
    readonly action: string;
    readonly path: string;
    readonly authenticated?: boolean;
    readonly topicIds?: readonly number[];
    readonly moreTopicsUrl?: string | null;
  }[];
}> {
  const response = await fetch(sourceUrl("/__control/state"), {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    readonly state: Record<string, unknown>;
    readonly events: readonly {
      readonly action: string;
      readonly path: string;
      readonly authenticated?: boolean;
      readonly topicIds?: readonly number[];
      readonly moreTopicsUrl?: string | null;
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

async function waitForRuntimeHealth(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "正式浏览器运行器尚未就绪。";
  while (Date.now() < deadline) {
    const result = await rawCompose([
      "exec",
      "--no-TTY",
      "runtime-linuxdo",
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

async function runtimeManifest(): Promise<Record<string, unknown>> {
  const result = await compose([
    "exec",
    "--no-TTY",
    "runtime-linuxdo",
    "node",
    "--input-type=module",
    "-e",
    'const response=await fetch("http://127.0.0.1:8080/manifest"); if(!response.ok)process.exit(1); console.log(JSON.stringify(await response.json()));',
  ]);
  const payload = JSON.parse(result.stdout) as {
    readonly sourceAdapter?: Record<string, unknown>;
  };
  assert.ok(payload.sourceAdapter !== undefined);
  return payload.sourceAdapter;
}

async function waitForBinRegistration(
  expectedManifest: Record<string, unknown>,
): Promise<void> {
  const deadline = Date.now() + 45_000;
  let latest = "运行器还没有完成自注册。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", "binny-discovery-topic"]);
    if (result.code === 0) {
      const bin = cliData<{
        readonly id: string;
        readonly sourceAdapter: Record<string, unknown>;
        readonly identityId: string;
        readonly config: Record<string, unknown>;
        readonly execution: {
          readonly status: string;
          readonly error?: { readonly code: string };
        };
      }>(result, "found");
      if (
        bin.sourceAdapter.id === expectedManifest.id &&
        bin.sourceAdapter.version === expectedManifest.version
      ) {
        assert.equal(bin.id, "binny-discovery-topic");
        assert.deepEqual(bin.sourceAdapter, expectedManifest);
        assert.equal(bin.identityId, bin.id);
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

async function waitForRuntime(): Promise<void> {
  const deadline = Date.now() + 45_000;
  let latest = "运行器还没有上线。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", "binny-discovery-topic"]);
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
    action === "collect"
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
  const actions = cliData<{
    readonly actions: Record<
      string,
      { readonly params?: unknown; readonly output?: unknown }
    >;
  }>(await cli(["bin", "actions", "binny-discovery-topic"]), "discovered");
  const declaration = actions.actions["list-categories"];
  assert.ok(declaration !== undefined, "动作发现应公开 list-categories。");
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
}

async function verifyCategoryDiscovery(): Promise<void> {
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

async function collectTopic(): Promise<ManualRun> {
  const run = await trigger("collect", { topicId: 2401 });
  assert.equal(run.status, "completed", JSON.stringify(run));
  return run;
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
  assert.equal(rootState.metadata?.postNumber, 1);
  const topicMetadata = rootState.metadata?.topic;
  assert.ok(topicMetadata !== null && typeof topicMetadata === "object");
  assert.deepEqual("tags" in topicMetadata ? topicMetadata.tags : undefined, [
    "受控",
    "归档",
  ]);
  assert.equal(
    rootState.metadata?.author && typeof rootState.metadata.author,
    "object",
  );
  assert.ok(rootState.body?.html?.includes("binny://resource/"));
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
    rootState.body?.html?.includes(
      `href="binny://resource/${pdfResource.resourceId}"`,
    ),
    rootState.body?.html,
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
    rootState.body?.html?.includes(
      `href="binny://resource/${jsonResource.resourceId}"`,
    ),
    rootState.body?.html,
  );
  const imageResourceIndex = resourceTypes.indexOf("image/png");
  assert.ok(imageResourceIndex >= 0);
  const imageResource = rootState.resources?.[imageResourceIndex];
  assert.ok(imageResource !== undefined);
  assert.ok(
    rootState.body?.html?.includes(
      `src="binny://resource/${imageResource.resourceId}"`,
    ),
    rootState.body?.html,
  );
  assert.ok(
    rootState.body?.html?.includes(
      `href="binny://resource/${imageResource.resourceId}"`,
    ),
    rootState.body?.html,
  );
  assert.ok(
    rootState.body?.html?.includes(
      `data-download-href="binny://resource/${imageResource.resourceId}"`,
    ),
    rootState.body?.html,
  );
  assert.ok(!rootState.body?.html?.includes("topic-photo-download-hash"));
  assert.ok(!rootState.body?.html?.includes("srcset="), rootState.body?.html);
  assert.ok(
    !rootState.body?.html?.includes("topic-photo-small.webp") &&
      !rootState.body?.html?.includes("topic-photo-large.webp"),
    rootState.body?.html,
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
  const duplicateTopicMetadata = binState(duplicateRoot).metadata?.topic;
  assert.ok(
    duplicateTopicMetadata !== null &&
      typeof duplicateTopicMetadata === "object",
  );
  assert.deepEqual(
    "tags" in duplicateTopicMetadata ? duplicateTopicMetadata.tags : undefined,
    ["受控", "归档"],
  );
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
  assert.equal(
    editedUnchangedReply.revisions.length,
    initialUnchangedRevisionCount,
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
    challengedRootState.body?.html?.includes(
      'src="/uploads/default/original/2X/topic-photo.png"',
    ),
    challengedRootState.body?.html,
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
  assert.ok(backfilledRootState.body?.html?.includes('src="binny://resource/'));
  assert.ok(
    !backfilledRootState.body?.html?.includes(
      'src="/uploads/default/original/2X/topic-photo.png"',
    ),
    backfilledRootState.body?.html,
  );
  assert.equal((await readOutgoingRelations(root.itemId)).length, 3);
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
    if (latest.status === "completed" || latest.status === "failed")
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

async function main(): Promise<void> {
  try {
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
    browser = await startOuterBrowser();

    const manifest = await runtimeManifest();
    await waitForBinRegistration(manifest);
    const configured = cliData<{ readonly id: string }>(
      await cli([
        "bin",
        "update",
        "binny-discovery-topic",
        "--identity",
        "binny-discovery-profile",
        "--config",
        JSON.stringify({ origin: "http://linuxdo-e2e-source:8081" }),
      ]),
      "updated",
    );
    assert.equal(configured.id, "binny-discovery-topic");
    await waitForRuntime();
    await verifyCategoryActionDiscovery();
    process.stdout.write("list-categories 的正式动作声明发现通过。\n");

    await verifyActionParameterValidation();
    process.stdout.write("本次动作参数校验定位错误且不改长期配置通过。\n");
    const journey = await verifyLoginRequired();
    process.stdout.write("登录状态检查与 noVNC 人工登录通过。\n");
    await assertSignedInCheckFailures();
    process.stdout.write("挑战页面与指定主题不可用分支通过。\n");
    await verifyTopicArchive(journey.firstCollection, journey.itemIds);
    process.stdout.write(
      "主题、回复、关系、媒体、重复、编辑、新回复与有限观察通过。\n",
    );
    await verifyDiscovery();
    process.stdout.write(
      "latest/category 分页、去重、时间范围、数量限制和部分失败范围通过。\n",
    );
    await verifyCategoryDiscovery();
    process.stdout.write(
      "板块动作发现、当前身份可见树、错误诊断和直接引用采集通过。\n",
    );
    await verifyDailyCollection();
    process.stdout.write(
      "全日跨板块分页、501 个唯一主题、日期边界、限额部分结果和失败保留通过。\n",
    );
    await verifyScheduledCollectionAcrossMidnight();
    await verifyLogout();
    process.stdout.write("退出登录后的全新检查和采集语义通过。\n");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${composeStarted ? await diagnostics() : ""}`,
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
        "linuxdo-runtime-owner",
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
}

await main();
