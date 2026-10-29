import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";

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

type ManualRun = {
  readonly runId: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly result?: {
    readonly check?: {
      readonly availability: "available" | "unavailable" | "unknown";
      readonly scope: readonly string[];
      readonly problems: readonly {
        readonly code: string;
        readonly requiresHuman: boolean;
      }[];
    };
    readonly error?: {
      readonly code: string;
      readonly requiresHuman: boolean;
      readonly path?: readonly (string | number)[];
    };
    readonly completedScopes?: readonly string[];
    readonly commits?: readonly {
      readonly items: readonly { readonly itemId: string }[];
    }[];
  };
};

type FixtureState = {
  readonly challengePage: boolean;
  readonly challengeTopic: boolean;
  readonly challengePosts: boolean;
  readonly challengeMedia: boolean;
  readonly topicVisible: boolean;
  readonly legacyTags: boolean;
  readonly topicVersion: number;
  readonly replyVersion: number;
  readonly addedReply: boolean;
  readonly discoveryAddedReply: boolean;
  readonly omittedPostIds: readonly number[];
  readonly unavailableTopicIds: readonly number[];
  readonly unavailableMedia: readonly string[];
  readonly unavailableMediaStatus: number;
};

type ArchiveItemState = {
  readonly sourceKey: { readonly namespace: string; readonly key: string };
  readonly sourceRef?: string;
  readonly metadata?: Record<string, unknown>;
  readonly body?: { readonly html?: string; readonly text?: string };
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

type BrowserSession = {
  readonly sessionId: string;
  readonly viewerUrl: string;
  readonly status?: string;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.yaml");
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const projectName = `binny25-${suffix}`;
const serverImage = `${projectName}-server:local`;
const browserImage = `${projectName}-linuxdo:local`;
const outerBrowserContainer = `${projectName}-outer-browser`;
const outerBrowserWsPath = `/binny25-${randomUUID()}`;
const publishedHost = process.env.BINNY25_PUBLISHED_HOST ?? "172.17.0.1";
const password = `binny25-${randomUUID().replaceAll("-", "")}`;
let overlayDirectory: string | undefined;
let overlayFile: string | undefined;
let browser: Browser | undefined;
let serverPort = 0;
let sourcePort = 0;
let composeStarted = false;
let outerBrowserStarted = false;

function environment(): Readonly<Record<string, string>> {
  return {
    BINNY_IMAGE: serverImage,
    BINNY25_BIN_ID: "binny25-topic",
    BINNY25_RUNTIME_IMAGE: browserImage,
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
    "binny24",
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

async function createOverlay(): Promise<void> {
  overlayDirectory = await mkdtemp(path.join(tmpdir(), "binny25-compose-"));
  overlayFile = path.join(overlayDirectory, "compose.network.yaml");
  const subnets = {
    api: process.env.BINNY25_API_SUBNET ?? "10.253.25.0/24",
    runtime: process.env.BINNY25_RUNTIME_SUBNET ?? "10.253.187.0/24",
    connections: process.env.BINNY25_CONNECTIONS_SUBNET ?? "10.253.188.0/24",
    browser: process.env.BINNY25_BROWSER_SUBNET ?? "10.253.189.0/24",
  };
  await writeFile(
    overlayFile,
    [
      "services:",
      "  postgres:",
      "    networks: !override",
      "      - default",
      "  server:",
      "    ports: !override",
      '      - "3000"',
      "    networks: !override",
      "      - default",
      "      - runtime",
      "      - connections",
      "  runtime-linuxdo:",
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

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError = "正式服务尚未就绪。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "list"]);
    if (result.code === 0) return;
    lastError = result.stderr;
    await delay(500);
  }
  throw new Error(`等待正式 API、PostgreSQL 和 CLI 超时：\n${lastError}`);
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
    readonly collector?: Record<string, unknown>;
  };
  assert.ok(payload.collector !== undefined);
  return payload.collector;
}

async function waitForRuntime(): Promise<void> {
  const deadline = Date.now() + 45_000;
  let latest = "运行器还没有上线。";
  while (Date.now() < deadline) {
    const result = await cli(["bin", "get", "binny25-topic"]);
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
  action: "check" | "collect",
  params: Readonly<Record<string, unknown>>,
): Promise<ManualRun> {
  const queued = cliData<ManualRun>(
    await cli([
      "run",
      "trigger",
      "binny25-topic",
      action,
      "--params",
      JSON.stringify(params),
    ]),
    "triggered",
  );
  assert.equal(queued.status, "queued");
  const deadline = Date.now() + 90_000;
  let latest = queued;
  while (Date.now() < deadline) {
    latest = cliData<ManualRun>(
      await cli(["run", "get", "binny25-topic", queued.runId]),
      "found",
    );
    if (latest.status === "completed" || latest.status === "failed")
      return latest;
    await delay(100);
  }
  assert.fail(
    `等待 Linux.do ${action} 运行终结超时：${JSON.stringify(latest)}`,
  );
}

async function startOuterBrowser(): Promise<Browser> {
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
    `import { chromium } from "playwright-core"; await chromium.launchServer({ host: "0.0.0.0", port: 9224, wsPath: ${JSON.stringify(outerBrowserWsPath)}, headless: true, channel: "chromium" }); process.stdout.write("BINNY25_OUTER_BROWSER_READY\\n"); setInterval(() => {}, 2147483647);`,
  ]);
  assert.equal(launch.code, 0, `外层浏览器启动失败：\n${launch.stderr}`);
  outerBrowserStarted = true;

  const deadline = Date.now() + 30_000;
  let logs = "";
  while (Date.now() < deadline) {
    const result = await run("docker", ["logs", outerBrowserContainer]);
    logs = result.stdout + result.stderr;
    if (logs.includes("BINNY25_OUTER_BROWSER_READY")) break;
    await delay(100);
  }
  assert.ok(logs.includes("BINNY25_OUTER_BROWSER_READY"), logs);
  const mapping = (
    await run("docker", ["port", outerBrowserContainer, "9224/tcp"])
  ).stdout.trim();
  const portText = /:(\d+)$/u.exec(mapping)?.[1];
  assert.ok(portText !== undefined, `没有外层浏览器端口：${mapping}`);
  const endpoint = new URL(`ws://127.0.0.1:9224${outerBrowserWsPath}`);
  endpoint.hostname = publishedHost;
  endpoint.port = portText;
  return await chromium.connect(endpoint.href);
}

async function openViewer(session: BrowserSession): Promise<Page> {
  assert.ok(browser !== undefined);
  const viewer = new URL(session.viewerUrl);
  viewer.hostname = publishedHost;
  viewer.port = String(serverPort);
  const page = await browser.newPage();
  await page.goto(viewer.href);
  try {
    await page
      .locator("#screen canvas")
      .waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `noVNC 画面没有加载：url=${page.url()} title=${await page.title()} body=${(
        await page
          .locator("body")
          .innerText()
          .catch(() => "<无法读取>")
      ).slice(
        0,
        2_000,
      )} 原因=${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "已连接，可以操作浏览器。",
    undefined,
    { timeout: 30_000 },
  );
  return page;
}

async function navigateThroughViewer(page: Page, url: string): Promise<void> {
  const canvas = page.locator("#screen canvas");
  const bounds = await canvas.boundingBox();
  assert.ok(bounds !== null);
  await canvas.click({
    position: { x: bounds.width / 2, y: bounds.height * 0.09 },
  });
  await page.keyboard.press("Control+a");
  await page.keyboard.type(url, { delay: 5 });
  await page.keyboard.press("Enter");
}

async function openHumanSession(): Promise<BrowserSession> {
  const opened = cliData<BrowserSession>(
    await cli(["human", "open", "binny25-topic"]),
    "opened",
  );
  const deadline = Date.now() + 90_000;
  let latest = opened.status ?? "pending";
  while (Date.now() < deadline) {
    const current = cliData<BrowserSession>(
      await cli(["human", "get", "binny25-topic", opened.sessionId]),
      "found",
    );
    latest = current.status ?? "unknown";
    if (latest === "ready") return opened;
    if (latest === "failed" || latest === "closed") {
      throw new Error(`浏览器人工会话未就绪：${JSON.stringify(current)}`);
    }
    await delay(250);
  }
  throw new Error(`等待浏览器人工会话就绪超时：${latest}`);
}

async function closeHumanSession(sessionId: string): Promise<void> {
  cliData(await cli(["human", "close", "binny25-topic", sessionId]), "closed");
}

async function searchArchiveItem(text: string): Promise<ArchiveItem> {
  const query = {
    scope: { kind: "current", binId: "binny25-topic" },
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
    await cli(["archive", "item", result.itemId, "--bin", "binny25-topic"]),
    "found",
  );
}

async function readArchiveItem(itemId: string): Promise<ArchiveItem> {
  return cliData<ArchiveItem>(
    await cli(["archive", "item", itemId, "--bin", "binny25-topic"]),
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
  const view = item.views.find(({ binId }) => binId === "binny25-topic");
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
      "binny25-topic",
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

async function verifyLoginRequired(): Promise<void> {
  const check = await trigger("check", { topicId: 2401 });
  assert.equal(check.status, "completed");
  assert.equal(
    check.result?.check?.availability,
    "unavailable",
    JSON.stringify({
      check: check.result?.check,
      sourceEvents: (await sourceState()).events,
    }),
  );
  assert.deepEqual(check.result?.check?.scope, ["topic:2401"]);
  assert.ok(
    check.result?.check?.problems.some(
      ({ code, requiresHuman }) => code === "login_required" && requiresHuman,
    ),
  );

  const collect = await trigger("collect", { topicId: 2401 });
  assert.equal(collect.status, "failed");
  assert.equal(collect.result?.error?.code, "login_required");
  assert.equal(collect.result?.error?.requiresHuman, true);
  const current = await sourceState();
  assert.equal(
    current.events.some(({ action }) => action === "topic"),
    false,
  );

  const loginPageCount = current.events.filter(
    ({ action }) => action === "login-page",
  ).length;
  const loginCompleteCount = current.events.filter(
    ({ action }) => action === "login-complete",
  ).length;
  const sessionReadCount = current.events.filter(
    ({ action }) => action === "session-current",
  ).length;
  const session = await openHumanSession();
  const viewer = await openViewer(session);
  try {
    await navigateThroughViewer(viewer, "http://linuxdo-e2e-source:8081/login");
    await waitForSourceEvent("login-page", loginPageCount + 1);
    await viewer.keyboard.press("Tab");
    await viewer.keyboard.type("binny25-user", { delay: 5 });
    await viewer.keyboard.press("Tab");
    await viewer.keyboard.type("linuxdo-fixture", { delay: 5 });
    await viewer.keyboard.press("Tab");
    await viewer.keyboard.press("Enter");
    await waitForSourceEvent("login-complete", loginCompleteCount + 1);
    await navigateThroughViewer(
      viewer,
      "http://linuxdo-e2e-source:8081/session/current.json",
    );
    await waitForSourceEvent("session-current", sessionReadCount + 1);
    const browserSessionRead = (await sourceState()).events
      .filter(({ action }) => action === "session-current")
      .at(-1);
    assert.equal(
      browserSessionRead?.authenticated,
      true,
      "noVNC 浏览器没有在登录响应后保留受控站点会话。",
    );
  } finally {
    await closeHumanSession(session.sessionId);
    await viewer.close();
  }

  const authenticatedCheck = await trigger("check", { topicId: 2401 });
  assert.equal(authenticatedCheck.status, "completed");
  assert.equal(
    authenticatedCheck.result?.check?.availability,
    "available",
    JSON.stringify({
      check: authenticatedCheck.result?.check,
      recentSourceEvents: (await sourceState()).events.slice(-12),
    }),
  );
  const beforeCollection = cliData<{
    readonly results: readonly unknown[];
  }>(
    await cli([
      "archive",
      "search",
      "--query",
      JSON.stringify({
        scope: { kind: "current", binId: "binny25-topic" },
        text: { kind: "literal", value: "主题正文版本 1" },
        select: ["sourceKey"],
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.equal(beforeCollection.results.length, 0);
}

async function verifyActionParameterValidation(): Promise<void> {
  const before = cliData<{
    readonly config: unknown;
    readonly targets: readonly unknown[];
  }>(await cli(["bin", "get", "binny25-topic"]), "found");
  for (const [params, path] of [
    [{ createdAfter: "yesterday" }, ["params", "createdAfter"]],
    [{ maxTopics: 501 }, ["params", "maxTopics"]],
    [{ targetIds: [1] }, ["params", "targetIds", "0"]],
  ] as const) {
    const response = await fetch(`${apiUrl()}/bins/binny25-topic/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "collect", params }),
      signal: AbortSignal.timeout(5_000),
    });
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

  const missingTarget = await trigger("collect", {
    targetIds: ["not-configured"],
  });
  assert.equal(missingTarget.status, "failed");
  assert.equal(missingTarget.result?.error?.code, "linuxdo_target_not_found");
  assert.deepEqual(missingTarget.result?.error?.path, ["targetIds", 0]);
  const after = cliData<{
    readonly config: unknown;
    readonly targets: readonly unknown[];
  }>(await cli(["bin", "get", "binny25-topic"]), "found");
  assert.deepEqual(after.config, before.config);
  assert.deepEqual(after.targets, before.targets);
}

async function assertSignedInCheckFailures(): Promise<void> {
  const before = await sourceState();
  const topicRequests = before.events.filter(
    ({ action }) => action === "topic",
  ).length;

  await updateFixtureState({ challengePage: true });
  const challengeCheck = await trigger("check", { topicId: 2401 });
  assert.equal(challengeCheck.status, "completed");
  assert.equal(challengeCheck.result?.check?.availability, "unknown");
  assert.ok(
    challengeCheck.result?.check?.problems.some(
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
  assert.equal(topicChallengeCheck.result?.check?.availability, "unknown");
  assert.ok(
    topicChallengeCheck.result?.check?.problems.some(
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
  assert.equal(postsChallengeCheck.result?.check?.availability, "unknown");
  assert.ok(
    postsChallengeCheck.result?.check?.problems.some(
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
  assert.equal(inaccessibleCheck.result?.check?.availability, "unavailable");
  assert.ok(
    inaccessibleCheck.result?.check?.problems.some(
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

async function verifyTopicArchive(): Promise<void> {
  const firstCollection = await collectTopic();
  const root = await searchArchiveItem("主题正文版本 1");
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
  assert.ok(firstCollection.result?.completedScopes?.includes("topic:2401"));
  assert.deepEqual(firstCollection.result?.completedScopes, [
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
  assert.ok(addedReplyRun.result?.completedScopes?.includes("post:240004"));
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
    finiteReadRun.result?.completedScopes?.includes("topic:2401"),
    false,
  );
  assert.equal(
    finiteReadRun.result?.completedScopes?.includes("post:240003"),
    false,
  );
  const finiteRoot = await readArchiveItem(root.itemId);
  const finiteView = finiteRoot.views.find(
    ({ binId }) => binId === "binny25-topic",
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
    mediaPartialRun.result?.completedScopes?.includes("topic:2401"),
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
    ({ binId }) => binId === "binny25-topic",
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
    ({ binId }) => binId === "binny25-topic",
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
    challengedMediaRun.result?.completedScopes?.includes("topic:2401"),
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
    ({ binId }) => binId === "binny25-topic",
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

async function verifyDiscovery(): Promise<void> {
  await updateFixtureState({
    topicVersion: 3,
    replyVersion: 3,
    discoveryAddedReply: true,
    challengeMedia: false,
    unavailableMedia: [],
    unavailableTopicIds: [],
  });

  const beforeCheck = await sourceState();
  const latestCheck = await trigger("check", { targetIds: ["latest"] });
  assert.equal(latestCheck.status, "completed", JSON.stringify(latestCheck));
  assert.equal(latestCheck.result?.check?.availability, "available");
  assert.deepEqual(latestCheck.result?.check?.scope, ["target:latest"]);
  const afterCheck = await sourceState();
  const latestPage = afterCheck.events
    .filter(
      ({ action, path }) =>
        action === "topic-list" && path.startsWith("/latest.json"),
    )
    .at(-1);
  assert.ok(latestPage !== undefined);
  assert.equal(latestPage.authenticated, true);
  assert.ok(afterCheck.events.length > beforeCheck.events.length);

  const beforeCollection = await sourceState();
  const collection = await trigger("collect", {
    targetIds: ["latest", "category"],
    maxTopics: 15,
  });
  assert.equal(collection.status, "completed", JSON.stringify(collection));
  assert.ok(collection.result?.completedScopes?.includes("target:latest"));
  assert.ok(collection.result?.completedScopes?.includes("target:category"));
  assert.ok(collection.result?.completedScopes?.includes("topic:2401"));
  assert.ok(collection.result?.completedScopes?.includes("post:240005"));

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
    targetIds: ["latest"],
    maxTopics: 10,
  });
  assert.equal(
    paginatedCollection.status,
    "completed",
    JSON.stringify(paginatedCollection),
  );
  assert.ok(
    paginatedCollection.result?.completedScopes?.includes("target:latest"),
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

  const editedRoot = await searchArchiveItem("主题正文版本 3");
  assert.ok(binState(editedRoot).body?.text?.includes("主题正文版本 3"));
  const addedReply = await searchArchiveItem("发现后新增的回复");
  assert.equal(addedReply.sourceKey.key, "post:240005");
  assert.ok(
    (await readOutgoingRelations(editedRoot.itemId)).some(
      ({ state }) => state?.to.sourceKey?.key === "post:240005",
    ),
  );

  const cutoff = await trigger("collect", {
    targetIds: ["latest"],
    createdAfter: "2026-10-27T00:00:00.000Z",
    maxTopics: 10,
  });
  assert.equal(cutoff.status, "completed", JSON.stringify(cutoff));
  assert.ok(cutoff.result?.completedScopes?.includes("target:latest"));
  assert.ok(cutoff.result?.completedScopes?.includes("topic:2402"));
  assert.ok(cutoff.result?.completedScopes?.includes("post:240200"));
  assert.ok(!cutoff.result?.completedScopes?.includes("topic:2403"));
  assert.ok(!cutoff.result?.completedScopes?.includes("post:240300"));

  const limited = await trigger("collect", {
    targetIds: ["latest", "category"],
    maxTopics: 1,
  });
  assert.equal(limited.status, "completed", JSON.stringify(limited));
  assert.ok(
    limited.result?.completedScopes?.includes(
      "target:latest:limited:maxTopics=1",
    ),
  );
  assert.ok(
    limited.result?.completedScopes?.includes(
      "target:category:not-visited:maxTopics=1",
    ),
  );

  await updateFixtureState({ unavailableTopicIds: [2402] });
  const failed = await trigger("collect", {
    targetIds: ["latest"],
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
  assert.equal(check.result?.check?.availability, "unavailable");
  assert.ok(
    check.result?.check?.problems.some(({ code }) => code === "login_required"),
  );
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

    await compose([
      "up",
      "--detach",
      "--build",
      "postgres",
      "server",
      "runtime-linuxdo",
      "linuxdo-e2e-source",
    ]);
    serverPort = await publishedPort("server", 3000);
    sourcePort = await publishedPort("linuxdo-e2e-source", 8081);
    await Promise.all([waitForApi(), waitForRuntimeHealth()]);
    browser = await startOuterBrowser();

    const manifest = await runtimeManifest();
    const created = cliData<{ readonly id: string }>(
      await cli([
        "bin",
        "create",
        "binny25-topic",
        "--collector",
        JSON.stringify(manifest),
        "--identity",
        "binny25-profile",
        "--config",
        JSON.stringify({ origin: "http://linuxdo-e2e-source:8081" }),
        "--targets",
        JSON.stringify([
          { id: "latest", kind: "latest" },
          {
            id: "category",
            kind: "category",
            categoryId: 42,
            categorySlugPath: "controlled",
          },
          { id: "pinned", kind: "topic", topicId: 2401 },
        ]),
      ]),
      "created",
    );
    assert.equal(created.id, "binny25-topic");
    await waitForRuntime();

    await verifyActionParameterValidation();
    process.stdout.write("本次动作参数校验定位错误且不改长期配置通过。\n");
    await verifyLoginRequired();
    process.stdout.write("登录状态检查与 noVNC 人工登录通过。\n");
    await assertSignedInCheckFailures();
    process.stdout.write("挑战页面与指定主题不可用分支通过。\n");
    await verifyTopicArchive();
    process.stdout.write(
      "主题、回复、关系、媒体、重复、编辑、新回复与有限观察通过。\n",
    );
    await verifyDiscovery();
    process.stdout.write(
      "latest/category 分页、去重、时间范围、数量限制和部分失败范围通过。\n",
    );
    await verifyLogout();
    process.stdout.write("退出登录后的全新检查和采集语义通过。\n");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${composeStarted ? await diagnostics() : ""}`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    if (outerBrowserStarted)
      await run("docker", ["rm", "--force", outerBrowserContainer]).catch(
        () => undefined,
      );
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
