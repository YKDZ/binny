import { fileURLToPath } from "node:url";

import type { SQL } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

export type CancellableDatabaseQuery<Row> = {
  readonly rows: Promise<readonly Row[]>;
  readonly cancel: () => void;
};

export type CancellableQueryExecutor = <Row extends Record<string, unknown>>(
  query: SQL<Row[]>,
) => CancellableDatabaseQuery<Row>;

export type DatabaseConnection = {
  readonly database: Database;
  readonly reserveSession: () => Promise<ReservedDatabaseConnection>;
  readonly executeCancellableQuery: CancellableQueryExecutor;
  readonly close: () => Promise<void>;
};

/** 创建单一数据库连接池；服务关闭时调用返回的 close。 */
export function connectDatabase(connectionString: string): DatabaseConnection {
  const client = postgres(connectionString, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 20,
  });
  const dialect = new PgDialect();

  return {
    database: drizzle({ client }),
    reserveSession: async () => {
      const reservedClient = await client.reserve();
      // postgres.js 3.4.9 的 ReservedSql 运行时对象不包含 Sql.options，Drizzle 的 postgres-js 驱动会读取该公开属性。
      reservedClient.options = client.options;
      return {
        database: drizzle({ client: reservedClient }),
        release: () => reservedClient.release(),
      };
    },
    executeCancellableQuery<Row extends Record<string, unknown>>(
      query: SQL<Row[]>,
    ) {
      const compiled = dialect.sqlToQuery(query);
      // PgDialect has prepared these values; postgres.js types an unconfigured parameter list as never[].
      const pending = client.unsafe<Row[]>(
        compiled.sql,
        compiled.params as never[],
      );
      return {
        rows: pending,
        cancel: () => pending.cancel(),
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
