import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  startVncViewerFixture,
  type VncViewerFixture,
  type VncViewerHandle,
} from "@binny/tooling-config/vnc-viewer-fixture";

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
  readonly status:
    | "queued"
    | "executing"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
  readonly referenceTime?: string;
  readonly startedAt?: string;
  readonly report?: Record<string, unknown>;
  readonly trigger?: {
    readonly kind: string;
    readonly scheduleId?: string;
    readonly scheduledFor?: string;
  };
  readonly result?: {
    readonly output?: {
      readonly completedScopes?: readonly string[];
      readonly collectionCompleteness?: "complete" | "partial";
      readonly incompleteScopes?: readonly {
        readonly scope: string;
        readonly reasonCode: string;
        readonly message: string;
      }[];
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
      readonly impact?: string;
      readonly message?: string;
      readonly stage?: string;
      readonly target?: string;
      readonly abortCause?: string;
    };
    readonly completedScopes?: readonly string[];
    readonly commits?: readonly {
      readonly commitId: string;
      readonly items: readonly { readonly itemId: string }[];
    }[];
  };
};

export type LinuxdoAction = "check" | "collect" | "list-categories" | "sync";

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
  readonly binId: string;
  readonly status: string;
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly requestedAt?: string;
  readonly readyAt?: string;
};

type LinuxdoHumanSessionState = {
  readonly sessionId: string;
  readonly binId: string;
  readonly status: string;
  readonly queueReason?: string;
  readonly host?: unknown;
  readonly port?: unknown;
  readonly password?: unknown;
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

export type LinuxdoViewerBrowser = VncViewerFixture;

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
  readonly run: LinuxdoCommandRunner;
}): Promise<LinuxdoViewerBrowser> {
  return await startVncViewerFixture({
    containerName: `${input.projectName}-vnc-viewer`,
    image: input.image,
    run: input.run,
  });
}

export async function triggerLinuxdoRun(
  cli: LinuxdoCli,
  binId: string,
  action: LinuxdoAction,
  params: Readonly<Record<string, unknown>>,
  timeoutMs = 180_000,
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
  const deadline = Date.now() + timeoutMs;
  let latest = queued;
  while (Date.now() < deadline) {
    latest = cliData<LinuxdoManualRun>(
      await cli(["run", "get", binId, queued.runId]),
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
  assert.fail(
    `等待 Linux.do ${action} 运行终结超时：${JSON.stringify(latest)}`,
  );
}

function parseLinuxdoHumanOpenStream(result: LinuxdoCliResult): {
  readonly waiting: readonly {
    readonly sessionId: string;
    readonly status: string;
    readonly queueReason?: string;
  }[];
  readonly ready: LinuxdoBrowserSession;
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
    .map(
      (line) =>
        line.data as {
          readonly sessionId: string;
          readonly status: string;
          readonly queueReason?: string;
        },
    );
  const readyRecords = lines.filter(
    (line) => line.kind === "record" && line.variant === "ready",
  );
  assert.equal(
    readyRecords.length,
    1,
    `Expected 1 ready record:\n${result.stdout}`,
  );
  const ready = readyRecords[0]?.data as LinuxdoBrowserSession;
  assert.equal(ready.status, "ready");
  assert.ok(typeof ready.host === "string" && ready.host.length > 0);
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  assert.match(ready.password, /^[A-Za-z0-9]{8}$/u);
  return { waiting, ready };
}

export async function openLinuxdoHumanSession(
  cli: LinuxdoCli,
  binId: string,
  apiUrl?: string,
): Promise<LinuxdoBrowserSession> {
  const args =
    apiUrl === undefined
      ? ["human", "open", binId]
      : ["human", "open", binId, "--url", apiUrl];
  const { ready } = parseLinuxdoHumanOpenStream(await cli(args));
  const current = cliData<LinuxdoHumanSessionState>(
    await cli(["human", "get", binId, ready.sessionId]),
    "found",
  );
  assert.equal(current.status, "ready");
  assert.equal(current.host, undefined);
  assert.equal(current.port, undefined);
  assert.equal(current.password, undefined);
  return ready;
}

export async function closeLinuxdoHumanSession(
  cli: LinuxdoCli,
  binId: string,
  sessionId: string,
): Promise<void> {
  const closed = cliData<LinuxdoHumanSessionState>(
    await cli(["human", "close", binId, sessionId]),
    "closed",
  );
  assert.equal(closed.host, undefined);
  assert.equal(closed.port, undefined);
  assert.equal(closed.password, undefined);
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
  vncViewer: VncViewerFixture,
  session: LinuxdoBrowserSession,
): Promise<VncViewerHandle> {
  return await vncViewer.connect({
    host: session.host,
    port: session.port,
    password: session.password,
  });
}

export async function navigateThroughLinuxdoViewer(
  viewer: VncViewerHandle,
  url: string,
): Promise<void> {
  await viewer.navigateTo(url);
}

type LinuxdoLoginInput = {
  readonly binId: string;
  readonly cli: LinuxdoCli;
  readonly vncViewer: VncViewerFixture;
  readonly apiUrl?: string;
  readonly sourceOrigin: string;
  readonly sourceControlUrl: string;
  readonly username: string;
  readonly password: string;
};

export async function loginLinuxdoUser(
  input: LinuxdoLoginInput,
): Promise<void> {
  const beforeLogin = await readSourceState(input.sourceControlUrl);
  const eventCounts = {
    loginPage: beforeLogin.events.filter(
      ({ action }) => action === "login-page",
    ).length,
    loginComplete: beforeLogin.events.filter(
      ({ action }) => action === "login-complete",
    ).length,
  };
  const session = await openLinuxdoHumanSession(
    input.cli,
    input.binId,
    input.apiUrl,
  );
  const viewer = await openLinuxdoViewer(input.vncViewer, session);
  try {
    let loggedIn = false;
    let priorLoginPage = eventCounts.loginPage;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        priorLoginPage = (
          await readSourceState(input.sourceControlUrl)
        ).events.filter(({ action }) => action === "login-page").length;
      }
      await navigateThroughLinuxdoViewer(viewer, `${input.sourceOrigin}/login`);
      await waitForSourceEvent(
        input.sourceControlUrl,
        "login-page",
        priorLoginPage + 1,
      );
      await delay(300);
      await viewer.pressKey("Tab");
      await viewer.typeText(input.username, 5);
      await viewer.pressKey("Tab");
      await viewer.typeText(input.password, 5);
      await viewer.pressKey("Tab");
      await viewer.pressKey("Return");
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const state = await readSourceState(input.sourceControlUrl);
        const loginCompleteCount = state.events.filter(
          ({ action }) => action === "login-complete",
        ).length;
        if (loginCompleteCount >= eventCounts.loginComplete + 1) {
          loggedIn = true;
          break;
        }
        await delay(50);
      }
      if (loggedIn) break;
    }
    if (!loggedIn) {
      await waitForSourceEvent(
        input.sourceControlUrl,
        "login-complete",
        eventCounts.loginComplete + 1,
      );
    }
  } finally {
    await closeLinuxdoHumanSession(input.cli, input.binId, session.sessionId);
    const exited = await viewer.waitForExit(15_000);
    assert.equal(
      exited.exited,
      true,
      `TigerVNC viewer stayed running after human session close:\n${exited.log}`,
    );
    await input.vncViewer.expectRejectedConnection({
      host: session.host,
      port: session.port,
      password: session.password,
    });
    await viewer.closeGracefully();
  }
}

export async function linuxdoUserJourney(input: {
  readonly binId: string;
  readonly topicId: number;
  readonly cli: LinuxdoCli;
  readonly vncViewer: VncViewerFixture;
  readonly apiUrl?: string;
  readonly sourceOrigin: string;
  readonly sourceControlUrl: string;
  readonly username: string;
  readonly password: string;
}): Promise<LinuxdoUserJourney> {
  const { binId, topicId, cli } = input;
  const topicScope = `topic:${String(topicId)}`;
  const collectParams = {
    topicId,
    date: "2026-10-28",
    timeZone: "UTC",
  };
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
    collectParams,
  );
  assert.equal(loginRequiredCollection.status, "failed");
  assert.equal(loginRequiredCollection.result?.error?.code, "login_required");
  assert.equal(loginRequiredCollection.result?.error?.requiresHuman, true);
  const beforeLogin = await readSourceState(input.sourceControlUrl);
  assert.equal(
    beforeLogin.events.some(({ action }) => action === "topic"),
    false,
  );
  await loginLinuxdoUser(input);

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
        bins: [binId],
        text: { groups: [["主题正文版本 1"]] },
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.equal(beforeCollection.results.length, 0);

  const firstCollection = await triggerLinuxdoRun(
    cli,
    binId,
    "collect",
    collectParams,
  );
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
