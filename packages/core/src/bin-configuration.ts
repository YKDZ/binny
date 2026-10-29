import {
  binConfigurationSchema,
  binConfigurationSettingsSchema,
  binCreateInputSchema,
  binUpdateInputSchema,
  collectorManifestStoredSchema,
  type BinConfiguration,
  type BinConfigurationOperations,
  type BinError,
  type BinOperation,
  type CollectorManifest,
  type JsonObject,
} from "@binny/contracts";
import {
  binConfigurations,
  databaseErrorCode,
  manualRuns,
  type Database,
} from "@binny/db";
import * as formats from "ajv-formats";
import {
  Ajv2020,
  type ErrorObject,
  type Schema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { and, eq, sql } from "drizzle-orm";

const binSelection = {
  id: binConfigurations.id,
  collector: binConfigurations.collector,
  identityId: binConfigurations.identityId,
  config: binConfigurations.config,
  targets: binConfigurations.targets,
  browserIdleTimeoutSeconds: binConfigurations.browserIdleTimeoutSeconds,
  status: binConfigurations.status,
  createdAt: binConfigurations.createdAt,
  updatedAt: binConfigurations.updatedAt,
};
const addFormats = formats.default.default;
const collectorValidatorCacheLimit = 32;

type CompiledCollectorValidators = {
  readonly configuration: ValidateFunction;
  readonly actions: Readonly<Record<string, ValidateFunction>>;
  // Ajv 持有 schema 对象强引用；淘汰条目时一并释放整个编译器。
  readonly compiler: Ajv2020;
};

const collectorValidatorCache = new Map<string, CompiledCollectorValidators>();

function dynamicSchemaPath(issue: ErrorObject): (string | number)[] {
  const path = issue.instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (
    issue.keyword === "required" &&
    "missingProperty" in issue.params &&
    typeof issue.params.missingProperty === "string"
  ) {
    path.push(issue.params.missingProperty);
  }
  if (
    issue.keyword === "additionalProperties" &&
    "additionalProperty" in issue.params &&
    typeof issue.params.additionalProperty === "string"
  ) {
    path.push(issue.params.additionalProperty);
  }
  return path;
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
  compiler: Ajv2020,
): {
  readonly validator: ValidateFunction | undefined;
  readonly error: BinError | undefined;
} {
  try {
    return {
      validator: compiler.compile(document as Schema),
      error: undefined,
    };
  } catch {
    return {
      validator: undefined,
      error: {
        code: "invalid_manifest",
        message: "采集器声明的 JSON Schema 无效或包含不支持的关键字。",
        path: [...path],
      },
    };
  }
}

function dynamicSchemaCacheKey(collector: CollectorManifest): string {
  const actions = Object.entries(collector.actions)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, action]) => [name, action.params]);
  return JSON.stringify({ config: collector.configSchema, actions });
}

function compileCollectorValidators(collector: CollectorManifest): {
  readonly validators: CompiledCollectorValidators | undefined;
  readonly error: BinError | undefined;
} {
  const cacheKey = dynamicSchemaCacheKey(collector);
  const cached = collectorValidatorCache.get(cacheKey);
  if (cached !== undefined) {
    collectorValidatorCache.delete(cacheKey);
    collectorValidatorCache.set(cacheKey, cached);
    return { validators: cached, error: undefined };
  }

  const compiler = new Ajv2020({ strictTypes: false });
  addFormats(compiler);
  const config = createDynamicSchema(
    collector.configSchema,
    ["collector", "configSchema"],
    compiler,
  );
  if (config.error !== undefined)
    return { validators: undefined, error: config.error };

  const actions: Record<string, ValidateFunction> = {};
  for (const [name, action] of Object.entries(collector.actions)) {
    const result = createDynamicSchema(
      action.params,
      ["collector", "actions", name, "params"],
      compiler,
    );
    if (result.error !== undefined)
      return { validators: undefined, error: result.error };
    actions[name] = result.validator!;
  }

  const validators = {
    configuration: config.validator!,
    actions,
    compiler,
  };
  collectorValidatorCache.set(cacheKey, validators);
  if (collectorValidatorCache.size > collectorValidatorCacheLimit) {
    const oldestKey = collectorValidatorCache.keys().next();
    if (!oldestKey.done) collectorValidatorCache.delete(oldestKey.value);
  }
  return { validators, error: undefined };
}

export function validateCollectorConfiguration(
  collector: CollectorManifest,
  config: JsonObject,
): BinError | undefined {
  const checked = collectorManifestStoredSchema.safeParse(collector);
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

  const built = compileCollectorValidators(collector);
  if (built.error !== undefined) return built.error;
  if (built.validators!.configuration(config)) return undefined;

  const issue = built.validators!.configuration.errors?.[0];
  return {
    code: "invalid_configuration",
    message: "长期配置不符合采集器声明。",
    ...(issue === undefined
      ? {}
      : { path: ["config", ...dynamicSchemaPath(issue)] }),
  };
}

function validateBrowserIdlePolicy(
  collector: CollectorManifest,
  browserIdleTimeoutSeconds: number | null,
): BinError | undefined {
  const browser = collector.environment.browser;
  if (
    browserIdleTimeoutSeconds === null ||
    !browser.required ||
    browser.profileReuseAfterRestart
  )
    return undefined;

  const reason = browser.profileReuseUnavailableReason;
  return {
    code: "invalid_configuration",
    message:
      reason === undefined
        ? "采集器不支持关闭浏览器后复用持久配置文件。"
        : `采集器不支持关闭浏览器后复用持久配置文件：${reason}`,
    path: ["browserIdleTimeoutSeconds"],
  };
}

export type CollectorActionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_manifest"
        | "action_not_found"
        | "invalid_action_parameters";
      readonly message: string;
      readonly path?: readonly (string | number)[];
    };

/** 在创建运行时按已登记清单校验动态动作及本次参数。 */
export function validateCollectorActionParameters(
  collector: CollectorManifest,
  actionName: string,
  params: JsonObject,
): CollectorActionValidation {
  const checked = collectorManifestStoredSchema.safeParse(collector);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return {
      ok: false,
      code: "invalid_manifest",
      message: issue?.message ?? "采集器声明格式无效。",
      ...(issue === undefined
        ? {}
        : { path: schemaIssuePath(["collector"], issue.path) }),
    };
  }

  if (!Object.hasOwn(checked.data.actions, actionName)) {
    return {
      ok: false,
      code: "action_not_found",
      message: "采集器没有声明这个动作。",
      path: ["action"],
    };
  }

  const built = compileCollectorValidators(checked.data);
  if (built.error !== undefined) {
    return {
      ok: false,
      code: "invalid_manifest",
      message: built.error.message,
      ...(built.error.path === undefined ? {} : { path: built.error.path }),
    };
  }

  const validator = built.validators!.actions[actionName];
  if (validator === undefined || validator(params)) return { ok: true };
  const issue = validator.errors?.[0];
  return {
    ok: false,
    code: "invalid_action_parameters",
    message: "本次动作参数不符合采集器声明。",
    ...(issue === undefined
      ? {}
      : { path: ["params", ...dynamicSchemaPath(issue)] }),
  };
}

async function selectBin(database: Database, id: string) {
  const [row] = await database
    .select(binSelection)
    .from(binConfigurations)
    .where(eq(binConfigurations.id, id));
  return row;
}

type BinRow = NonNullable<Awaited<ReturnType<typeof selectBin>>>;

function rowToConfiguration(row: BinRow): BinConfiguration {
  return binConfigurationSchema.parse({
    id: row.id,
    collector: row.collector,
    identityId: row.identityId,
    config: row.config,
    targets: row.targets,
    browserIdleTimeoutSeconds: row.browserIdleTimeoutSeconds,
    status: row.status,
    execution: {
      status: "offline",
      reason: "runtime_not_connected",
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function notFound<T>(_id: string): BinOperation<T> {
  return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
}

export function createBinConfigurationStore(
  database: Database,
): BinConfigurationOperations {
  return {
    async listBins() {
      const rows = await database
        .select(binSelection)
        .from(binConfigurations)
        .orderBy(binConfigurations.createdAt, binConfigurations.id);
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
      const invalid = validateCollectorConfiguration(
        checked.data.collector,
        checked.data.config,
      );
      if (invalid !== undefined)
        return { ok: false, status: 400, error: invalid };
      const browserIdleTimeoutSeconds =
        checked.data.browserIdleTimeoutSeconds === undefined
          ? 300
          : checked.data.browserIdleTimeoutSeconds;
      const invalidIdlePolicy = validateBrowserIdlePolicy(
        checked.data.collector,
        browserIdleTimeoutSeconds,
      );
      if (invalidIdlePolicy !== undefined)
        return { ok: false, status: 400, error: invalidIdlePolicy };

      try {
        const [row] = await database
          .insert(binConfigurations)
          .values({
            id: checked.data.id,
            collector: checked.data.collector,
            identityId: checked.data.identityId,
            config: checked.data.config,
            targets: checked.data.targets,
            browserIdleTimeoutSeconds,
            status: "active",
          })
          .returning(binSelection);
        if (row === undefined) throw new Error("bin 创建后没有返回记录。");
        return { ok: true, value: rowToConfiguration(row) };
      } catch (error) {
        if (databaseErrorCode(error) === "23505")
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

      return await database.transaction(async (transaction) => {
        const [previous] = await transaction
          .select(binSelection)
          .from(binConfigurations)
          .where(eq(binConfigurations.id, id))
          .for("update");
        if (previous === undefined) return notFound(id);

        const existing = binConfigurationSettingsSchema.parse({
          id: previous.id,
          collector: previous.collector,
          identityId: previous.identityId,
          config: previous.config,
          targets: previous.targets,
        });
        const collector = checked.data.collector ?? existing.collector;
        const config = checked.data.config ?? existing.config;
        const targets = checked.data.targets ?? existing.targets;
        const browserIdleTimeoutSeconds =
          checked.data.browserIdleTimeoutSeconds === undefined
            ? previous.browserIdleTimeoutSeconds
            : checked.data.browserIdleTimeoutSeconds;
        const invalid = validateCollectorConfiguration(collector, config);
        if (invalid !== undefined)
          return { ok: false as const, status: 400 as const, error: invalid };
        const invalidIdlePolicy = validateBrowserIdlePolicy(
          collector,
          browserIdleTimeoutSeconds,
        );
        if (invalidIdlePolicy !== undefined)
          return {
            ok: false as const,
            status: 400 as const,
            error: invalidIdlePolicy,
          };

        // Drizzle 没有用于 UPDATE 的事务时间 helper；保留原来的 PostgreSQL now() 语义。
        const [updated] = await transaction
          .update(binConfigurations)
          .set({
            collector,
            identityId: checked.data.identityId ?? existing.identityId,
            config,
            targets,
            browserIdleTimeoutSeconds,
            updatedAt: sql`now()`,
          })
          .where(eq(binConfigurations.id, id))
          .returning(binSelection);
        if (updated === undefined) throw new Error("bin 更新后没有返回记录。");
        return { ok: true as const, value: rowToConfiguration(updated) };
      });
    },

    async setBinStatus(id, status) {
      return await database.transaction(async (transaction) => {
        // 保留原来的 PostgreSQL now() 语义；Drizzle 只提供 INSERT 默认值 helper。
        const [bin] = await transaction
          .update(binConfigurations)
          .set({ status, updatedAt: sql`now()` })
          .where(eq(binConfigurations.id, id))
          .returning(binSelection);
        if (bin === undefined) return notFound(id);
        if (status === "disabled") {
          // 已在执行的运行继续使用快照；排队运行在停用时明确失败。
          await transaction
            .update(manualRuns)
            .set({
              status: "failed",
              failure: {
                code: "bin_disabled",
                message: "bin 已停用，排队中的运行没有执行。",
                impact: "排队中的运行已结束。",
                suggestion: "重新启用后可创建新的运行。",
                requiresHuman: false,
              },
              finishedAt: sql`clock_timestamp()`,
            })
            .where(
              and(eq(manualRuns.binId, id), eq(manualRuns.status, "queued")),
            );
        }
        return { ok: true, value: rowToConfiguration(bin) };
      });
    },

    async removeBin(id) {
      return await database.transaction(async (transaction) => {
        await transaction
          .update(manualRuns)
          .set({
            status: "failed",
            failure: {
              code: "bin_removed",
              message: "bin 配置已移除，排队中的运行没有执行。",
              impact: "排队中的运行已结束。",
              requiresHuman: false,
            },
            finishedAt: sql`clock_timestamp()`,
          })
          .where(
            and(eq(manualRuns.binId, id), eq(manualRuns.status, "queued")),
          );
        const [removed] = await transaction
          .delete(binConfigurations)
          .where(eq(binConfigurations.id, id))
          .returning({ id: binConfigurations.id });
        return removed === undefined
          ? notFound(id)
          : { ok: true as const, value: removed };
      });
    },
  };
}
