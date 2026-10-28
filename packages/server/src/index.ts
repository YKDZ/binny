import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createApiRoutes } from "@binny/api/routes";
import {
  createArchiveStore,
  connectCoreDatabase,
  createBinConfigurationStore,
  createManualRunStore,
  createRuntimeConnectionStore,
  initializeArchiveSchema,
  initializeBinConfigurationSchema,
  initializeManualRunSchema,
  initializeRuntimeConnectionSchema,
} from "@binny/core";
// 核心与 HTTP 的组装、配置及服务启动。
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";

export type ServerRuntime = {
  readonly app: ReturnType<typeof createApiRoutes>;
  readonly close: () => Promise<void>;
};

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
  const database = connectCoreDatabase(options.databaseUrl);
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
  const runtime = createRuntimeConnectionStore(database);
  const runs = createManualRunStore(database);
  try {
    await initializeBinConfigurationSchema(database);
    await initializeArchiveSchema(database);
    await archives.initializeResourceStorage();
    await initializeRuntimeConnectionSchema(database);
    await initializeManualRunSchema(database);
  } catch (error) {
    await archives.close();
    await database.end();
    throw error;
  }
  return {
    app: createApiRoutes({
      bins: createBinConfigurationStore(database),
      runtime,
      runs,
      archives,
    }),
    close: async () => {
      await archives.close();
      await database.end();
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
    fetch: runtime.app.fetch,
    hostname: "0.0.0.0",
    port: options.port,
  });
  return {
    server,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        );
      });
      await runtime.close();
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
