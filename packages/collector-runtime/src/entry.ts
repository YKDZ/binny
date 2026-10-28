import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createApiClient } from "@binny/api/client";
import {
  collectorActionResultSchema,
  createCollectorContext,
  collectorManifest,
  isCollectorActionError,
  type CollectorDefinition,
} from "@binny/collector-sdk";
import {
  runtimeHeartbeatIntervalMs,
  runtimeProtocolVersion,
  type ManualRunCompletion,
  type ManualRunExecution,
  type RuntimeEnvironment,
} from "@binny/contracts";

import { createRuntimeServer } from "./runtime-server.ts";

const collectorPath = process.env.BINNY_COLLECTOR_ENTRY ?? "/app/dist/index.js";
const binId = process.env.BINNY_BIN_ID;
const apiUrl = process.env.BINNY_API_URL;
const runtimePort = Number(process.env.BINNY_RUNTIME_PORT ?? "8080");
const environmentKind = process.env.BINNY_RUNTIME_ENVIRONMENT ?? "lightweight";
const heartbeatInterval = Number(
  process.env.BINNY_RUNTIME_HEARTBEAT_INTERVAL_MS ??
    String(runtimeHeartbeatIntervalMs),
);

if (binId === undefined || binId.trim() === "") {
  throw new Error("缺少 BINNY_BIN_ID，运行器无法标识已配置 bin。");
}
const runtimeBinId = binId;

if (apiUrl === undefined) {
  throw new Error("缺少 BINNY_API_URL，运行器无法连接 Binny 核心。");
}

try {
  new URL(apiUrl);
} catch {
  throw new Error(`BINNY_API_URL 不是有效 URL：${apiUrl}`);
}

if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65_535) {
  throw new Error(`BINNY_RUNTIME_PORT 不是有效端口：${String(runtimePort)}`);
}

if (environmentKind !== "lightweight" && environmentKind !== "browser") {
  throw new Error(`未知运行环境：${environmentKind}`);
}

if (!Number.isInteger(heartbeatInterval) || heartbeatInterval < 250) {
  throw new Error("BINNY_RUNTIME_HEARTBEAT_INTERVAL_MS 必须大于等于 250。");
}

const importedCollector = (await import(pathToFileURL(collectorPath).href)) as {
  readonly default?: CollectorDefinition;
  readonly collector?: CollectorDefinition;
};
const collector = importedCollector.default ?? importedCollector.collector;

if (collector === undefined) {
  throw new Error(
    `采集器模块 ${collectorPath} 必须导出 default 或 collector。`,
  );
}

const activeCollector: CollectorDefinition = collector;
const manifest = collectorManifest(activeCollector);
const environment: RuntimeEnvironment = {
  kind: environmentKind,
  browser: {
    available: environmentKind === "browser",
    profileReuseAfterRestart:
      environmentKind === "browser" &&
      process.env.BINNY_BROWSER_PROFILE_REUSE === "true",
  },
};
const runtimeId = randomUUID();
const server = createRuntimeServer({ collector: activeCollector });
const client = createApiClient(apiUrl, {
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.timeout(3_000),
    }),
});
let heartbeatTimer: NodeJS.Timeout | undefined;
let heartbeatInFlight: Promise<void> | undefined;
let runInFlight: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
let lastStatus: string | undefined;

function logStatus(status: string, detail?: string): void {
  if (lastStatus === status) return;
  lastStatus = status;
  const suffix = detail === undefined ? "" : `：${detail}`;
  process.stdout.write(
    `运行器连接状态：bin=${binId} status=${status}${suffix}\n`,
  );
}

async function heartbeat(): Promise<void> {
  if (stopping !== undefined) return;
  try {
    const response = await client.bins[":binId"].runtime.heartbeat.$post({
      param: { binId: runtimeBinId },
      json: {
        protocolVersion: runtimeProtocolVersion,
        runtimeId,
        collector: manifest,
        environment,
      },
    });
    if (response.status === 200) {
      const execution = await response.json();
      logStatus(execution.status);
      if (execution.status === "online") void pollRun();
    } else {
      const result = await response.json();
      logStatus(result.error.code, result.error.message);
    }
  } catch (error) {
    logStatus(
      "disconnected",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (stopping === undefined) {
      heartbeatTimer = setTimeout(startHeartbeat, heartbeatInterval);
    }
  }
}

function failureFrom(error: unknown) {
  if (isCollectorActionError(error)) return error.failure;
  return {
    code: "collector_execution_failed",
    message: "采集器动作执行失败。",
    impact: "本次运行未能完成。",
    requiresHuman: false,
  } as const;
}

async function finishRun(
  run: ManualRunExecution,
  completion: ManualRunCompletion,
): Promise<void> {
  const response = await client.bins[":binId"].runtime.runs[
    ":runId"
  ].complete.$post({
    param: { binId: runtimeBinId, runId: run.runId },
    json: { runtimeId, completion },
  });
  switch (response.status) {
    case 200:
      return;
    case 400:
    case 404:
    case 409: {
      const result = await response.json();
      process.stderr.write(
        `运行结果未能写入：run=${run.runId} code=${result.error.code} message=${result.error.message}\n`,
      );
      return;
    }
  }
}

async function executeRun(run: ManualRunExecution): Promise<void> {
  let completion: ManualRunCompletion;
  const action = activeCollector.actions[run.action];
  if (
    run.collectorId !== manifest.id ||
    run.collectorVersion !== manifest.version ||
    action === undefined
  ) {
    completion = {
      status: "failed",
      completedScopes: [],
      error: {
        code: "collector_version_unavailable",
        message: "当前运行器没有本次运行要求的采集器版本或动作。",
        impact: "本次运行未执行。",
        suggestion: "部署对应采集器版本后重新触发。",
        requiresHuman: false,
      },
    };
  } else {
    const parsed = action.params.safeParse(run.params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      completion = {
        status: "failed",
        completedScopes: [],
        error: {
          code: "invalid_action_parameters",
          message: "本次动作参数不符合当前运行器声明。",
          impact: "本次运行未执行。",
          ...(issue === undefined
            ? {}
            : {
                path: issue.path.map((part) =>
                  typeof part === "symbol" ? String(part) : part,
                ),
              }),
          requiresHuman: false,
        },
      };
    } else {
      try {
        const result = await action.execute(
          createCollectorContext(client, {
            binId: run.binId,
            identityId: run.identityId,
            runId: run.runId,
            collectorVersion: run.collectorVersion,
            config: run.config,
            targets: run.targets,
            signal: new AbortController().signal,
          }),
          parsed.data,
        );
        const actionResult = collectorActionResultSchema.safeParse(result);
        completion = {
          status: "completed",
          completedScopes: actionResult.success
            ? actionResult.data.completedScopes
            : [],
        };
      } catch (error) {
        completion = {
          status: "failed",
          completedScopes: [],
          error: failureFrom(error),
        };
      }
    }
  }

  try {
    await finishRun(run, completion);
  } catch (error) {
    process.stderr.write(
      `运行结果暂时无法连接核心：run=${run.runId} ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function pollRun(): Promise<void> {
  if (runInFlight !== undefined || stopping !== undefined) return;
  try {
    const response = await client.bins[":binId"].runtime.runs.claim.$post({
      param: { binId: runtimeBinId },
      json: { runtimeId },
    });
    switch (response.status) {
      case 200: {
        const result = await response.json();
        if (result.run === null) return;
        const current = executeRun(result.run);
        runInFlight = current;
        void current.finally(() => {
          if (runInFlight === current) runInFlight = undefined;
        });
        return;
      }
      case 400:
      case 404:
      case 409: {
        const result = await response.json();
        process.stderr.write(
          `运行器领取失败：code=${result.error.code} message=${result.error.message}\n`,
        );
        return;
      }
    }
  } catch (error) {
    process.stderr.write(
      `运行器暂时无法领取任务：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function startHeartbeat(): void {
  const current = heartbeat();
  heartbeatInFlight = current;
  void current.finally(() => {
    if (heartbeatInFlight === current) heartbeatInFlight = undefined;
  });
}

async function disconnect(): Promise<void> {
  try {
    await client.bins[":binId"].runtime.disconnect.$post({
      param: { binId: runtimeBinId },
      json: { runtimeId },
    });
  } catch {
    // API 不可达时，核心会通过心跳过期将运行器置为离线。
  }
}

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function shutdown(): Promise<void> {
  if (stopping !== undefined) return stopping;
  stopping = (async () => {
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    if (heartbeatInFlight !== undefined) await heartbeatInFlight;
    await disconnect();
    await closeServer();
  })();
  return stopping;
}

server.listen(runtimePort, "0.0.0.0", () => {
  process.stdout.write(
    `运行器已启动：bin=${binId} collector=${collector.id} port=${runtimePort}\n`,
  );
  startHeartbeat();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 1;
      },
    );
  });
}
