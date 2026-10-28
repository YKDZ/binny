import {
  binConfigurationSchema,
  binCreateInputSchema,
  binUpdateInputSchema,
  collectorManifestSchema,
  type BinConfiguration,
  type BinConfigurationOperations,
  type BinError,
  type BinOperation,
  type CollectorManifest,
  type JsonObject,
} from "@binny/contracts";
import * as z from "zod";

import type { CoreDatabase } from "./database.ts";

type BinStatus = "active" | "disabled";

type BinRow = {
  readonly id: string;
  readonly collector: CollectorManifest;
  readonly identity_id: string;
  readonly config: JsonObject;
  readonly targets: readonly unknown[];
  readonly status: BinStatus;
  readonly created_at: Date;
  readonly updated_at: Date;
};

const tableName = "bin_configurations";
// postgres.js 的 JSONB OID；传对象让驱动序列化一次，避免把 JSON 存成字符串。
const jsonbType = 3802;
const selectColumns =
  "id, collector, identity_id, config, targets, status, created_at, updated_at";

function jsonbParameter(database: CoreDatabase, value: unknown) {
  return database.typed(value, jsonbType);
}

export async function initializeBinConfigurationSchema(
  database: CoreDatabase,
): Promise<void> {
  await database.unsafe(
    "CREATE TABLE IF NOT EXISTS bin_configurations (" +
      "id text PRIMARY KEY, " +
      "collector jsonb NOT NULL, " +
      "identity_id text NOT NULL, " +
      "config jsonb NOT NULL, " +
      "targets jsonb NOT NULL, " +
      "status text NOT NULL CHECK (status IN ('active', 'disabled')), " +
      "created_at timestamptz NOT NULL DEFAULT now(), " +
      "updated_at timestamptz NOT NULL DEFAULT now()" +
      ")",
  );
}

function failure<T>(
  status: 400 | 404 | 409,
  code: BinError["code"],
  message: string,
  path?: (string | number)[],
): BinOperation<T> {
  return {
    ok: false,
    status,
    error: { code, message, ...(path === undefined ? {} : { path }) },
  };
}

function rowToConfiguration(row: BinRow): BinConfiguration {
  return binConfigurationSchema.parse({
    id: row.id,
    collector: row.collector,
    identityId: row.identity_id,
    config: row.config,
    targets: row.targets,
    status: row.status,
    execution: {
      status: "unavailable",
      reason: "runtime_not_connected",
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function schemaIssuePath(
  prefix: readonly (string | number)[],
  issuePath: readonly PropertyKey[],
): (string | number)[] {
  return [
    ...prefix,
    ...issuePath.map((part) =>
      typeof part === "symbol" ? String(part) : part,
    ),
  ];
}

function createDynamicSchema(
  document: Record<string, unknown>,
  path: readonly (string | number)[],
): {
  readonly schema: z.ZodType | undefined;
  readonly error: BinError | undefined;
} {
  try {
    return {
      schema: z.fromJSONSchema(document),
      error: undefined,
    };
  } catch {
    return {
      schema: undefined,
      error: {
        code: "invalid_manifest",
        message: "采集器声明的 JSON Schema 无效或包含不支持的关键字。",
        path: [...path],
      },
    };
  }
}

function validateManifest(collector: CollectorManifest): BinError | undefined {
  const checked = collectorManifestSchema.safeParse(collector);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return {
      code: "invalid_manifest",
      message: issue?.message ?? "采集器声明格式无效。",
      ...(issue === undefined
        ? {}
        : { path: schemaIssuePath(["collector"], issue.path) }),
    };
  }

  const definitions = [
    {
      document: collector.configSchema,
      path: ["collector", "configSchema"],
    },
    ...Object.entries(collector.actions).map(([name, action]) => ({
      document: action.params,
      path: ["collector", "actions", name, "params"],
    })),
  ];
  for (const definition of definitions) {
    const result = createDynamicSchema(definition.document, definition.path);
    if (result.error !== undefined) return result.error;
  }
  return undefined;
}

function validateDynamicValue(
  value: unknown,
  document: Record<string, unknown>,
  prefix: readonly (string | number)[],
  errorCode: "invalid_configuration",
  message: string,
): BinError | undefined {
  const built = createDynamicSchema(document, prefix);
  if (built.error !== undefined) return built.error;
  const parsed = built.schema!.safeParse(value);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  return {
    code: errorCode,
    message,
    ...(issue === undefined
      ? {}
      : { path: [...schemaIssuePath(prefix, issue.path)] }),
  };
}

function validateConfiguration(
  collector: CollectorManifest,
  config: JsonObject,
): BinError | undefined {
  const manifestError = validateManifest(collector);
  if (manifestError !== undefined) return manifestError;

  const configError = validateDynamicValue(
    config,
    collector.configSchema,
    ["config"],
    "invalid_configuration",
    "长期配置不符合采集器声明。",
  );
  if (configError !== undefined) return configError;
  return undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function selectBin(
  database: CoreDatabase,
  id: string,
): Promise<BinRow | undefined> {
  const rows = await database.unsafe<BinRow[]>(
    "SELECT " + selectColumns + " FROM " + tableName + " WHERE id = $1",
    [id],
  );
  return rows[0];
}

function notFound<T>(_id: string): BinOperation<T> {
  return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
}

export function createBinConfigurationStore(
  database: CoreDatabase,
): BinConfigurationOperations {
  return {
    async listBins() {
      const rows = await database.unsafe<BinRow[]>(
        "SELECT " +
          selectColumns +
          " FROM " +
          tableName +
          " ORDER BY created_at, id",
      );
      return rows.map(rowToConfiguration);
    },

    async getBin(id) {
      const row = await selectBin(database, id);
      return row === undefined
        ? notFound(id)
        : { ok: true, value: rowToConfiguration(row) };
    },

    async createBin(input) {
      const checked = binCreateInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return failure(
          400,
          "invalid_input",
          "bin 配置格式无效。",
          issue === undefined ? undefined : issue.path.map(String),
        );
      }
      const invalid = validateConfiguration(
        checked.data.collector,
        checked.data.config,
      );
      if (invalid !== undefined)
        return { ok: false, status: 400, error: invalid };

      try {
        const rows = await database.unsafe<BinRow[]>(
          "INSERT INTO " +
            tableName +
            " (id, collector, identity_id, config, targets, status) " +
            "VALUES ($1, $2, $3, $4, $5, 'active') " +
            "RETURNING " +
            selectColumns,
          [
            checked.data.id,
            jsonbParameter(database, checked.data.collector),
            checked.data.identityId,
            jsonbParameter(database, checked.data.config),
            jsonbParameter(database, checked.data.targets),
          ],
        );
        return { ok: true, value: rowToConfiguration(rows[0]!) };
      } catch (error) {
        if (isUniqueViolation(error))
          return failure(409, "bin_already_exists", "这个 bin 标识已被使用。", [
            "id",
          ]);
        throw error;
      }
    },

    async updateBin(id, input) {
      const checked = binUpdateInputSchema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return failure(
          400,
          "invalid_input",
          "bin 修改内容无效。",
          issue === undefined ? undefined : issue.path.map(String),
        );
      }

      return await database.begin(async (transaction) => {
        const rows = await transaction.unsafe<BinRow[]>(
          "SELECT " +
            selectColumns +
            " FROM " +
            tableName +
            " WHERE id = $1 FOR UPDATE",
          [id],
        );
        const previous = rows[0];
        if (previous === undefined) return notFound(id);

        const collector = checked.data.collector ?? previous.collector;
        const config = checked.data.config ?? previous.config;
        const targets = checked.data.targets ?? previous.targets;
        const invalid = validateConfiguration(collector, config);
        if (invalid !== undefined)
          return { ok: false as const, status: 400 as const, error: invalid };

        const updated = await transaction.unsafe<BinRow[]>(
          "UPDATE " +
            tableName +
            " SET collector = $1, identity_id = $2, config = $3, " +
            "targets = $4, updated_at = now() WHERE id = $5 RETURNING " +
            selectColumns,
          [
            jsonbParameter(database, collector),
            checked.data.identityId ?? previous.identity_id,
            jsonbParameter(database, config),
            jsonbParameter(database, targets),
            id,
          ],
        );
        return { ok: true as const, value: rowToConfiguration(updated[0]!) };
      });
    },

    async setBinStatus(id, status) {
      const rows = await database.unsafe<BinRow[]>(
        "UPDATE " +
          tableName +
          " SET status = $1, updated_at = now() WHERE id = $2 RETURNING " +
          selectColumns,
        [status, id],
      );
      return rows[0] === undefined
        ? notFound(id)
        : { ok: true, value: rowToConfiguration(rows[0]) };
    },

    async removeBin(id) {
      const rows = await database.unsafe<{ readonly id: string }[]>(
        "DELETE FROM " + tableName + " WHERE id = $1 RETURNING id",
        [id],
      );
      return rows[0] === undefined
        ? notFound(id)
        : { ok: true, value: { id: rows[0].id } };
    },
  };
}
