import { fileURLToPath } from "node:url";

import { DrizzleQueryError } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { archiveWriteClock } from "./schema.ts";

export type CoreDatabase = PostgresJsDatabase;
export type CoreTransaction = Parameters<
  Parameters<CoreDatabase["transaction"]>[0]
>[0];

export type CoreDatabaseConnection = {
  readonly database: CoreDatabase;
  readonly close: () => Promise<void>;
};

export function connectCoreDatabase(
  connectionString: string,
): CoreDatabaseConnection {
  const client = postgres(connectionString, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 20,
  });

  return {
    database: drizzle({ client }),
    close: () => client.end(),
  };
}

export function databaseErrorCode(error: unknown): string | undefined {
  if (error instanceof DrizzleQueryError) {
    return databaseErrorCode(error.cause);
  }
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export async function migrateCoreDatabase(
  database: CoreDatabase,
): Promise<void> {
  const migrationsFolder = fileURLToPath(
    new URL("../migrations/", import.meta.url),
  );
  await migrate(database, { migrationsFolder });

  await database
    .insert(archiveWriteClock)
    .values({ clockId: 1, lastSequence: 0n })
    .onConflictDoNothing({ target: archiveWriteClock.clockId });
}
