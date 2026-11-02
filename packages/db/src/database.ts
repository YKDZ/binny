import { fileURLToPath } from "node:url";

import { DrizzleQueryError } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { archiveWriteClock } from "./schema.ts";

export type Database = PostgresJsDatabase;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ReservedDatabaseConnection = {
  readonly database: Database;
  readonly release: () => void;
};

export type DatabaseConnection = {
  readonly database: Database;
  readonly reserveSession: () => Promise<ReservedDatabaseConnection>;
  readonly close: () => Promise<void>;
};

/** 创建单一数据库连接池；服务关闭时调用返回的 close。 */
export function connectDatabase(connectionString: string): DatabaseConnection {
  const client = postgres(connectionString, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 20,
  });

  return {
    database: drizzle({ client }),
    reserveSession: async () => {
      const reservedClient = await client.reserve();
      // postgres.js 3.4.9 omits Sql.options on its ReservedSql runtime value,
      // while Drizzle's postgres-js driver reads the public options property.
      reservedClient.options = client.options;
      return {
        database: drizzle({ client: reservedClient }),
        release: () => reservedClient.release(),
      };
    },
    close: () => client.end(),
  };
}

/** 提取 Drizzle 包装链最内层驱动错误的 SQLSTATE。 */
export function databaseErrorCode(error: unknown): string | undefined {
  if (error instanceof DrizzleQueryError) {
    return databaseErrorCode(error.cause);
  }
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/** 应用随包发布的迁移，并在迁移后安全种入归档写入时钟。 */
export async function migrateDatabase(database: Database): Promise<void> {
  const migrationsFolder = fileURLToPath(
    new URL("../migrations/", import.meta.url),
  );
  await migrate(database, { migrationsFolder });

  await database
    .insert(archiveWriteClock)
    .values({ clockId: 1, lastSequence: 0n })
    .onConflictDoNothing({ target: archiveWriteClock.clockId });
}
