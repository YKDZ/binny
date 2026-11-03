import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createApiRoutes,
  type HumanSessionOperations,
  type RuntimeConnectionOperations,
} from "@binny/api/routes";
import {
  createArchiveStore,
  createBinConfigurationStore,
  createBrowserCapacityCoordinator,
  createHumanSessionStore,
  createManualRunListStore,
  createManualRunStore,
  createRuntimeConnectionStore,
  createScheduleStore,
  startScheduleDispatcher,
} from "@binny/core";
import { connectDatabase, migrateDatabase } from "@binny/db";
// 核心与 HTTP 的组装、配置及服务启动。
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";

import { HumanSessionGateway } from "./human-session-gateway.ts";
import { humanSessionViewerPage } from "./human-session-viewer.ts";

const require = createRequire(import.meta.url);
const serverPackageVersion = (
  require("../package.json") as { readonly version?: string }
).version;

export type ServerRuntime = {
  readonly app: ReturnType<typeof createApiRoutes>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly attachUpgradeHandler: (server: ServerType) => () => void;
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

function environmentPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} 必须是正整数。`);
  }
  return parsed;
}

export async function createServerRuntime(options: {
  readonly databaseUrl: string;
}): Promise<ServerRuntime> {
  const connection = connectDatabase(options.databaseUrl);
  const { database } = connection;
  const browserCapacity = createBrowserCapacityCoordinator(
    environmentPositiveInteger("BINNY_BROWSER_CAPACITY_LIMIT", 2),
  );
  const archives = createArchiveStore(database, {
    resourceDirectory:
      process.env.BINNY_RESOURCE_DIRECTORY ?? "/var/lib/binny/resources",
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
  const runtime = createRuntimeConnectionStore(database, browserCapacity);
  const runs = createManualRunStore(database, browserCapacity);
  const runListings = createManualRunListStore(database);
  const schedules = createScheduleStore(database);
  const humanSessions = createHumanSessionStore(database, browserCapacity);
  const viewerWaitMs = environmentMilliseconds(
    "BINNY_HUMAN_SESSION_VIEWER_WAIT_MS",
    60_000,
    1_000,
  );
  const gateway = new HumanSessionGateway({
    sessions: humanSessions,
    viewerWaitMs,
    onUnexpectedClose: async (binId, sessionId) => {
      const result = await humanSessions.closeHumanSession(binId, sessionId);
      if (!result.ok && result.error.code !== "human_session_not_found")
        throw new Error(result.error.message);
    },
  });
  let pendingTimeout: NodeJS.Timeout | undefined;
  let scheduleDispatcher:
    | Awaited<ReturnType<typeof startScheduleDispatcher>>
    | undefined;
  try {
    await migrateDatabase(database);
    await browserCapacity.initialize(database);
    await archives.initializeResourceStorage();
    await humanSessions.reconcileHumanSessionsAfterGatewayRestart();
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
  } catch (error) {
    try {
      if (scheduleDispatcher !== undefined) await scheduleDispatcher.close();
    } finally {
      try {
        await archives.close();
      } finally {
        await connection.close();
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
  const humanOperations: HumanSessionOperations = {
    requestHumanSession: (binId) => humanSessions.requestHumanSession(binId),
    getHumanSession: (binId, sessionId) =>
      humanSessions.getHumanSession(binId, sessionId),
    closeHumanSession: async (binId, sessionId) => {
      const result = await humanSessions.closeHumanSession(binId, sessionId);
      if (!result.ok) return result;
      try {
        await gateway.closeSession(sessionId);
        const updated = await humanSessions.getHumanSession(binId, sessionId);
        return updated.ok ? updated : result;
      } catch (error) {
        process.stderr.write(
          `浏览器会话通道回收仍在进行：session=${sessionId} ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return result;
      }
    },
  };
  const runtimeOperations: RuntimeConnectionOperations = {
    getExecution: (binId) => runtime.getExecution(binId),
    disconnect: (binId, input) => runtime.disconnect(binId, input),
    heartbeat: async (binId, input) => {
      const result = await runtime.heartbeat(binId, input);
      if (result.ok && result.value.humanSession?.action === "close") {
        try {
          await gateway.closeSession(result.value.humanSession.sessionId);
        } catch (error) {
          process.stderr.write(
            `浏览器会话通道仍未确认关闭：session=${result.value.humanSession.sessionId} ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      return result;
    },
  };
  const app = createApiRoutes(
    {
      bins: createBinConfigurationStore(database, browserCapacity),
      runtime: runtimeOperations,
      runs,
      runListings,
      schedules,
      archives,
      humanSessions: humanOperations,
    },
    {
      productVersion:
        process.env.BINNY_PRODUCT_VERSION ??
        serverPackageVersion ??
        "unpublished",
    },
  );
  const viewerBundlePath = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../dist/human-viewer.js"
        : "./human-viewer.js",
      import.meta.url,
    ),
  );
  return {
    app,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        /^\/human-sessions\/[0-9a-f-]+$/iu.test(url.pathname)
      ) {
        return new Response(humanSessionViewerPage(), {
          headers: {
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
            "content-type": "text/html; charset=utf-8",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/human-viewer.js") {
        return new Response(await readFile(viewerBundlePath), {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/javascript; charset=utf-8",
            "referrer-policy": "no-referrer",
          },
        });
      }
      return await app.fetch(request);
    },
    attachUpgradeHandler: (server) =>
      gateway.attach(server as import("node:http").Server),
    close: async () => {
      scheduleClosing = true;
      if (schedulePoll !== undefined) clearInterval(schedulePoll);
      schedulePoll = undefined;
      await scheduleWork;
      try {
        await scheduleDispatcher?.close();
      } finally {
        if (pendingTimeout !== undefined) clearInterval(pendingTimeout);
        await humanSessions.beginHumanGatewayShutdown();
        try {
          await gateway.close();
        } finally {
          try {
            await archives.close();
          } finally {
            await connection.close();
          }
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
  const server = serve({
    fetch: runtime.fetch,
    hostname: "0.0.0.0",
    port: options.port,
  });
  const detachUpgradeHandler = runtime.attachUpgradeHandler(server);
  return {
    server,
    close: async () => {
      const serverClosed = new Promise<void>((resolveClose, reject) => {
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        );
      });
      try {
        await runtime.close();
      } finally {
        detachUpgradeHandler();
        await serverClosed;
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
