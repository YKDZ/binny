import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createApiRoutes } from "@binny/api/routes";
import {
  createArchiveStore,
  createBinConfigurationStore,
  createHumanSessionStore,
  createManualRunListStore,
  createManualRunStore,
  createScheduleListStore,
  createRuntimeConnectionStore,
  createRuntimeContainerCoordinator,
  createScheduleStore,
  startScheduleDispatcher,
} from "@binny/core";
import { connectDatabase, migrateDatabase } from "@binny/db";
// 核心与 HTTP 的组装、配置及服务启动。
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";

import { createDockerEngineContainerDriver } from "./docker-engine.ts";

const require = createRequire(import.meta.url);
const serverPackageVersion = (
  require("../package.json") as { readonly version?: string }
).version;

export type ServerRuntime = {
  readonly app: ReturnType<typeof createApiRoutes>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly stopBackgroundWork: () => Promise<void>;
  readonly close: () => Promise<void>;
};

const schedulePollIntervalMs = 1_000;

function environmentMilliseconds(
  name: string,
  fallback: number,
  minimum: number,
): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} 必须是大于等于 ${minimum} 的整数。`);
  }
  return parsed;
}

export async function createServerRuntime(options: {
  readonly databaseUrl: string;
}): Promise<ServerRuntime> {
  const connection = connectDatabase(options.databaseUrl);
  const { database } = connection;
  const archives = createArchiveStore(database, {
    resourceDirectory:
      process.env.BINNY_RESOURCE_DIRECTORY ?? "/var/lib/binny/resources",
    executeCancellableSearchQuery: connection.executeCancellableQuery,
    unreferencedResourceAgeMs: environmentMilliseconds(
      "BINNY_RESOURCE_UNREFERENCED_AGE_MS",
      24 * 60 * 60 * 1000,
      0,
    ),
    resourceCleanupIntervalMs: environmentMilliseconds(
      "BINNY_RESOURCE_CLEANUP_INTERVAL_MS",
      60 * 60 * 1000,
      100,
    ),
  });
  const dockerDriver = await createDockerEngineContainerDriver();
  const containerCoordinator = createRuntimeContainerCoordinator({
    database,
    driver: dockerDriver,
    wakeTimeoutMs: environmentMilliseconds(
      "BINNY_RUNTIME_WAKE_TIMEOUT_MS",
      30_000,
      1_000,
    ),
    wakeRetryBaseDelayMs: environmentMilliseconds(
      "BINNY_RUNTIME_WAKE_RETRY_BASE_DELAY_MS",
      2_000,
      50,
    ),
    wakeRetryMaxDelayMs: environmentMilliseconds(
      "BINNY_RUNTIME_WAKE_RETRY_MAX_DELAY_MS",
      60_000,
      50,
    ),
  });
  const viewerWaitMs = environmentMilliseconds(
    "BINNY_HUMAN_SESSION_VIEWER_WAIT_MS",
    60_000,
    1_000,
  );
  const runtime = createRuntimeConnectionStore(database, {
    containerCoordinator,
    humanSessionConnectTimeoutMs: viewerWaitMs,
  });
  const runs = createManualRunStore(database, { containerCoordinator });
  const runListings = createManualRunListStore(database);
  const schedules = createScheduleStore(database, { containerCoordinator });
  const scheduleListings = createScheduleListStore(database);
  const humanSessions = createHumanSessionStore(database, {
    containerCoordinator,
    resolveRuntimeVncHostPort: (binId) =>
      containerCoordinator.resolveVncHostPort(binId),
  });
  let pendingTimeout: NodeJS.Timeout | undefined;
  let containerSweepTimer: NodeJS.Timeout | undefined;
  let containerSweepWork: Promise<void> | undefined;
  let scheduleDispatcher:
    | Awaited<ReturnType<typeof startScheduleDispatcher>>
    | undefined;
  try {
    await migrateDatabase(database);
    await archives.initializeResourceStorage();
    await containerCoordinator.reconcileOnStartup();
    scheduleDispatcher = await startScheduleDispatcher(
      schedules,
      database,
      connection.reserveSession,
    );
    pendingTimeout = setInterval(
      () => {
        void humanSessions
          .expirePendingHumanSessions(viewerWaitMs)
          .catch((error: unknown) => {
            process.stderr.write(
              `浏览器会话等待清理失败：${error instanceof Error ? error.message : String(error)}\n`,
            );
          });
      },
      Math.min(viewerWaitMs, 5_000),
    );
    pendingTimeout.unref();
    if (dockerDriver !== undefined) {
      containerSweepTimer = setInterval(() => {
        if (containerSweepWork !== undefined) return;
        containerSweepWork = containerCoordinator
          .sweepIdleContainers()
          .catch((error: unknown) => {
            process.stderr.write(
              `Runtime container sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          })
          .finally(() => {
            containerSweepWork = undefined;
          });
      }, schedulePollIntervalMs);
      containerSweepTimer.unref();
    }
  } catch (error) {
    try {
      await containerCoordinator.close();
    } finally {
      try {
        if (scheduleDispatcher !== undefined) await scheduleDispatcher.close();
      } finally {
        try {
          await archives.close();
        } finally {
          await connection.close();
        }
      }
    }
    throw error;
  }
  let schedulePoll: ReturnType<typeof setInterval> | undefined;
  let scheduleWork: Promise<void> | undefined;
  let scheduleClosing = false;
  const activeScheduleDispatcher = scheduleDispatcher;
  if (activeScheduleDispatcher === undefined)
    throw new Error("采集计划 dispatcher 尚未启动。");
  const pollSchedules = (): void => {
    if (scheduleClosing || scheduleWork !== undefined) return;
    scheduleWork = activeScheduleDispatcher
      .ensureActiveSession()
      .then(() => schedules.processDueSchedules())
      .catch((error: unknown) => {
        console.error("采集计划处理失败：", error);
      })
      .finally(() => {
        scheduleWork = undefined;
      });
  };
  schedulePoll = setInterval(pollSchedules, schedulePollIntervalMs);
  schedulePoll.unref();
  pollSchedules();
  const app = createApiRoutes(
    {
      bins: createBinConfigurationStore(database, { containerCoordinator }),
      runtime,
      runs,
      runListings,
      schedules,
      scheduleListings,
      archives,
      humanSessions,
    },
    {
      productVersion:
        process.env.BINNY_PRODUCT_VERSION ??
        serverPackageVersion ??
        "unpublished",
    },
  );
  let backgroundWorkStop: Promise<void> | undefined;
  const stopBackgroundWork = (): Promise<void> => {
    if (backgroundWorkStop !== undefined) return backgroundWorkStop;
    scheduleClosing = true;
    if (schedulePoll !== undefined) clearInterval(schedulePoll);
    schedulePoll = undefined;
    if (pendingTimeout !== undefined) clearInterval(pendingTimeout);
    pendingTimeout = undefined;
    if (containerSweepTimer !== undefined) clearInterval(containerSweepTimer);
    containerSweepTimer = undefined;
    backgroundWorkStop = (async () => {
      await scheduleWork;
      await containerSweepWork;
      try {
        await containerCoordinator.close();
      } finally {
        await activeScheduleDispatcher.close();
      }
    })();
    return backgroundWorkStop;
  };
  return {
    app,
    fetch: async (request: Request) => await app.fetch(request),
    stopBackgroundWork,
    close: async () => {
      try {
        await stopBackgroundWork();
      } finally {
        try {
          await archives.close();
        } finally {
          await connection.close();
        }
      }
    },
  };
}

export async function startServer(options: {
  readonly databaseUrl: string;
  readonly port: number;
}): Promise<{
  readonly server: ServerType;
  readonly close: () => Promise<void>;
}> {
  const runtime = await createServerRuntime(options);
  let shuttingDown = false;
  const server = serve({
    // Requests on existing keep-alive sockets can arrive after the listener closes.
    fetch: (request) =>
      shuttingDown
        ? Promise.resolve(
            new Response(null, {
              status: 503,
              headers: { connection: "close" },
            }),
          )
        : runtime.fetch(request),
    hostname: "0.0.0.0",
    port: options.port,
  });
  const activeHttpResponses = new Set<ServerResponse>();
  server.on("request", (_request, response) => {
    activeHttpResponses.add(response);
    if (shuttingDown) {
      response.shouldKeepAlive = false;
      if (!response.headersSent) response.setHeader("connection", "close");
    }
    response.once("finish", () => activeHttpResponses.delete(response));
    response.once("close", () => activeHttpResponses.delete(response));
  });
  return {
    server,
    close: async () => {
      shuttingDown = true;
      for (const response of activeHttpResponses) {
        response.shouldKeepAlive = false;
        if (!response.headersSent) response.setHeader("connection", "close");
      }
      const serverClosed = new Promise<void>((resolveClose, reject) => {
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        );
      });
      try {
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      } finally {
        try {
          // Stop background work before draining requests and keep dependencies open through the drain.
          await runtime.stopBackgroundWork();
        } finally {
          try {
            await serverClosed;
          } finally {
            await runtime.close();
          }
        }
      }
    },
  };
}

function directInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (directInvocation()) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL 未配置。");
  }
  const parsedPort = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error("PORT 必须是 1 到 65535 之间的整数。");
  }
  const runtime = await startServer({ databaseUrl, port: parsedPort });
  const shutdown = (): void => {
    void runtime.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
