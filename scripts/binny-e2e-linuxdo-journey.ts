import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

export type LinuxdoCliResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type LinuxdoCli = (args: readonly string[]) => Promise<LinuxdoCliResult>;

export type LinuxdoCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<LinuxdoCliResult>;

export type LinuxdoManualRun = {
  readonly runId: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly result?: {
    readonly output?: {
      readonly completedScopes?: readonly string[];
      readonly availability?: "available" | "unavailable" | "unknown";
      readonly scope?: readonly string[];
      readonly problems?: readonly {
        readonly code: string;
        readonly requiresHuman: boolean;
        readonly suggestion?: string;
      }[];
    };
    readonly error?: {
      readonly code: string;
      readonly requiresHuman: boolean;
      readonly path?: readonly (string | number)[];
    };
    readonly completedScopes?: readonly string[];
    readonly commits?: readonly {
      readonly commitId: string;
      readonly items: readonly { readonly itemId: string }[];
    }[];
  };
};

export type LinuxdoAction = "check" | "collect" | "list-categories";

type LinuxdoCheckOutput = {
  readonly availability: "available" | "unavailable" | "unknown";
  readonly scope: readonly string[];
  readonly problems: readonly {
    readonly code: string;
    readonly requiresHuman: boolean;
    readonly suggestion?: string;
  }[];
};

function checkOutput(run: LinuxdoManualRun): LinuxdoCheckOutput {
  assert.ok(run.result?.output !== undefined);
  return run.result.output as LinuxdoCheckOutput;
}

export type LinuxdoBrowserSession = {
  readonly sessionId: string;
  readonly viewerUrl: string;
  readonly status?: string;
};

type SourceEvent = {
  readonly action: string;
  readonly path: string;
  readonly authenticated?: boolean;
};

type SourceState = {
  readonly state: Record<string, unknown>;
  readonly events: readonly SourceEvent[];
};

export type LinuxdoViewerBrowser = {
  readonly browser: Browser;
  readonly close: () => Promise<void>;
};

export type LinuxdoUserJourney = {
  readonly unavailableCheck: LinuxdoManualRun;
  readonly loginRequiredCollection: LinuxdoManualRun;
  readonly authenticatedCheck: LinuxdoManualRun;
  readonly firstCollection: LinuxdoManualRun;
  readonly itemIds: readonly string[];
};

function cliData<T>(result: LinuxdoCliResult, variant: string): T {
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

export async function startLinuxdoViewerBrowser(input: {
  readonly projectName: string;
  readonly image: string;
  readonly publishedHost: string;
  readonly run: LinuxdoCommandRunner;
}): Promise<LinuxdoViewerBrowser> {
  const containerName = `${input.projectName}-outer-browser`;
  const wsPath = `/binny-linuxdo-${randomUUID()}`;
  const launch = await input.run("docker", [
    "run",
    "--detach",
    "--name",
    containerName,
    "--network",
    "bridge",
    "--publish",
    `${input.publishedHost}::9224`,
    "--workdir",
    "/app/binny-runtime",
    "--entrypoint",
    "node",
    input.image,
    "--input-type=module",
    "--eval",
    `import { chromium } from "playwright-core"; await chromium.launchServer({ host: "0.0.0.0", port: 9224, wsPath: ${JSON.stringify(wsPath)}, headless: true, channel: "chromium" }); process.stdout.write("BINNY_LINUXDO_OUTER_BROWSER_READY\\n"); setInterval(() => {}, 2147483647);`,
  ]);
  assert.equal(launch.code, 0, `外层浏览器启动失败：\n${launch.stderr}`);

  let browser: Browser;
  try {
    const deadline = Date.now() + 30_000;
    let logs = "";
    while (Date.now() < deadline) {
      const result = await input.run("docker", ["logs", containerName]);
      logs = result.stdout + result.stderr;
      if (logs.includes("BINNY_LINUXDO_OUTER_BROWSER_READY")) break;
      await delay(100);
    }
    assert.ok(logs.includes("BINNY_LINUXDO_OUTER_BROWSER_READY"), logs);
    const mapping = (
      await input.run("docker", ["port", containerName, "9224/tcp"])
    ).stdout.trim();
    const portText = /:(\d+)$/u.exec(mapping)?.[1];
    assert.ok(portText !== undefined, `没有外层浏览器端口：${mapping}`);
    const endpoint = new URL(`ws://127.0.0.1:9224${wsPath}`);
    endpoint.hostname = input.publishedHost;
    endpoint.port = portText;
    browser = await chromium.connect(endpoint.href);
  } catch (error) {
    await input.run("docker", ["rm", "--force", containerName]);
    throw error;
  }

  return {
    browser,
    async close() {
      await browser.close().catch(() => undefined);
      const result = await input.run("docker", [
        "rm",
        "--force",
        containerName,
      ]);
      if (result.code !== 0 && !result.stderr.includes("No such container")) {
        throw new Error(
          `清理外层浏览器失败：\n${result.stdout}${result.stderr}`,
        );
      }
    },
  };
}

export async function triggerLinuxdoRun(
  cli: LinuxdoCli,
  binId: string,
  action: LinuxdoAction,
  params: Readonly<Record<string, unknown>>,
): Promise<LinuxdoManualRun> {
  const queued = cliData<LinuxdoManualRun>(
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
  assert.equal(queued.status, "queued");
  const deadline = Date.now() + 90_000;
  let latest = queued;
  while (Date.now() < deadline) {
    latest = cliData<LinuxdoManualRun>(
      await cli(["run", "get", binId, queued.runId]),
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

export async function openLinuxdoHumanSession(
  cli: LinuxdoCli,
  binId: string,
): Promise<LinuxdoBrowserSession> {
  const opened = cliData<LinuxdoBrowserSession>(
    await cli(["human", "open", binId]),
    "opened",
  );
  const deadline = Date.now() + 90_000;
  let latest = opened.status ?? "pending";
  while (Date.now() < deadline) {
    const current = cliData<LinuxdoBrowserSession>(
      await cli(["human", "get", binId, opened.sessionId]),
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

export async function closeLinuxdoHumanSession(
  cli: LinuxdoCli,
  binId: string,
  sessionId: string,
): Promise<void> {
  cliData(await cli(["human", "close", binId, sessionId]), "closed");
}

async function readSourceState(controlUrl: string): Promise<SourceState> {
  const response = await fetch(controlUrl, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as SourceState;
}

async function waitForSourceEvent(
  controlUrl: string,
  action: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let latestCount = 0;
  while (Date.now() < deadline) {
    const current = await readSourceState(controlUrl);
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

export async function openLinuxdoViewer(
  browser: Browser,
  session: LinuxdoBrowserSession,
  publishedHost: string,
  serverPort: number,
): Promise<Page> {
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

export async function navigateThroughLinuxdoViewer(
  page: Page,
  url: string,
): Promise<void> {
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

export async function linuxdoUserJourney(input: {
  readonly binId: string;
  readonly topicId: number;
  readonly cli: LinuxdoCli;
  readonly browser: Browser;
  readonly publishedHost: string;
  readonly serverPort: number;
  readonly sourceOrigin: string;
  readonly sourceControlUrl: string;
  readonly username: string;
  readonly password: string;
}): Promise<LinuxdoUserJourney> {
  const { binId, topicId, cli, browser, publishedHost, serverPort } = input;
  const topicScope = `topic:${String(topicId)}`;
  const unavailableCheck = await triggerLinuxdoRun(cli, binId, "check", {
    topicId,
  });
  assert.equal(unavailableCheck.status, "completed");
  assert.equal(
    checkOutput(unavailableCheck).availability,
    "unavailable",
    JSON.stringify({
      output: unavailableCheck.result?.output,
      sourceEvents: (await readSourceState(input.sourceControlUrl)).events,
    }),
  );
  assert.deepEqual(checkOutput(unavailableCheck).scope, [topicScope]);
  assert.ok(
    checkOutput(unavailableCheck).problems.some(
      ({ code, requiresHuman }) => code === "login_required" && requiresHuman,
    ),
  );

  const loginRequiredCollection = await triggerLinuxdoRun(
    cli,
    binId,
    "collect",
    { topicId },
  );
  assert.equal(loginRequiredCollection.status, "failed");
  assert.equal(loginRequiredCollection.result?.error?.code, "login_required");
  assert.equal(loginRequiredCollection.result?.error?.requiresHuman, true);
  const beforeLogin = await readSourceState(input.sourceControlUrl);
  assert.equal(
    beforeLogin.events.some(({ action }) => action === "topic"),
    false,
  );

  const eventCounts = {
    loginPage: beforeLogin.events.filter(
      ({ action }) => action === "login-page",
    ).length,
    loginComplete: beforeLogin.events.filter(
      ({ action }) => action === "login-complete",
    ).length,
    sessionRead: beforeLogin.events.filter(
      ({ action }) => action === "session-current",
    ).length,
  };
  const session = await openLinuxdoHumanSession(cli, binId);

  const viewer = await openLinuxdoViewer(
    browser,
    session,
    publishedHost,
    serverPort,
  );
  try {
    await navigateThroughLinuxdoViewer(viewer, `${input.sourceOrigin}/login`);
    await waitForSourceEvent(
      input.sourceControlUrl,
      "login-page",
      eventCounts.loginPage + 1,
    );
    await viewer.keyboard.press("Tab");
    await viewer.keyboard.type(input.username, { delay: 5 });
    await viewer.keyboard.press("Tab");
    await viewer.keyboard.type(input.password, { delay: 5 });
    await viewer.keyboard.press("Tab");
    await viewer.keyboard.press("Enter");
    await waitForSourceEvent(
      input.sourceControlUrl,
      "login-complete",
      eventCounts.loginComplete + 1,
    );
    await navigateThroughLinuxdoViewer(
      viewer,
      `${input.sourceOrigin}/session/current.json`,
    );
    await waitForSourceEvent(
      input.sourceControlUrl,
      "session-current",
      eventCounts.sessionRead + 1,
    );
    const browserSessionRead = (
      await readSourceState(input.sourceControlUrl)
    ).events
      .filter(({ action }) => action === "session-current")
      .at(-1);
    assert.equal(
      browserSessionRead?.authenticated,
      true,
      "noVNC 浏览器没有在登录响应后保留受控站点会话。",
    );
  } finally {
    await closeLinuxdoHumanSession(cli, binId, session.sessionId);
    const oldViewerUrl = viewer.url();
    await viewer.waitForFunction(
      () =>
        document.querySelector("#status")?.textContent ===
        "连接已结束，请回到终端查看会话状态。",
      undefined,
      { timeout: 15_000 },
    );
    assert.equal(await viewer.locator("#screen canvas").count(), 0);
    const rejectedViewer = await browser.newPage();
    try {
      await rejectedViewer.goto(oldViewerUrl);
      await rejectedViewer.waitForFunction(
        () =>
          document.querySelector("#status")?.textContent ===
          "连接已结束，请回到终端查看会话状态。",
        undefined,
        { timeout: 15_000 },
      );
      assert.equal(await rejectedViewer.locator("#screen canvas").count(), 0);
    } finally {
      await rejectedViewer.close();
      await viewer.close();
    }
  }

  const authenticatedCheck = await triggerLinuxdoRun(cli, binId, "check", {
    topicId,
  });
  assert.equal(authenticatedCheck.status, "completed");
  assert.equal(
    checkOutput(authenticatedCheck).availability,
    "available",
    JSON.stringify({
      output: authenticatedCheck.result?.output,
      recentSourceEvents: (
        await readSourceState(input.sourceControlUrl)
      ).events.slice(-12),
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
        scope: { kind: "current", binId },
        text: { kind: "literal", value: "主题正文版本 1" },
        select: ["sourceKey"],
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.equal(beforeCollection.results.length, 0);

  const firstCollection = await triggerLinuxdoRun(cli, binId, "collect", {
    topicId,
  });
  assert.equal(
    firstCollection.status,
    "completed",
    JSON.stringify(firstCollection),
  );
  const itemIds = [
    ...new Set(
      (firstCollection.result?.commits ?? []).flatMap(({ items }) =>
        items.map(({ itemId }) => itemId),
      ),
    ),
  ];
  assert.ok(itemIds.length > 0, "Linux.do 正式采集没有返回归档条目 ID。");
  return {
    unavailableCheck,
    loginRequiredCollection,
    authenticatedCheck,
    firstCollection,
    itemIds,
  };
}
