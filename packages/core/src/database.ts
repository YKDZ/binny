// core 所有持久化模块共享同一个 postgres.js 连接池。
import postgres from "postgres";

export type CoreDatabase = ReturnType<typeof postgres>;
export type CoreTransaction = postgres.TransactionSql;

export function connectCoreDatabase(connectionString: string): CoreDatabase {
  return postgres(connectionString, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 20,
  });
}
