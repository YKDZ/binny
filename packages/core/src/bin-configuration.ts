import { isDeepStrictEqual } from "node:util";

import {
  binConfigurationSchema,
  binConfigurationSettingsSchema,
  binUpdateInputSchema,
  runtimeHeartbeatTimeoutMs,
  runtimeProtocolVersion,
  sourceAdapterManifestStoredSchema,
  type BinConfiguration,
  type BinConfigurationOperations,
  type BinError,
  type BinOperation,
  type SourceAdapterManifest,
  type JsonObject,
} from "@binny/contracts";
import {
  binConfigurations,
  manualRuns,
  runtimeConnections,
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

import type { BrowserCapacityCoordinator } from "./browser-capacity.ts";
import { validateConfigurationAtRuntime } from "./runtime-configuration-validation.ts";

const binSelection = {
  id: binConfigurations.id,
  sourceAdapter: binConfigurations.sourceAdapter,
  identityId: binConfigurations.identityId,
  config: binConfigurations.config,
  configNativeValid: binConfigurations.configNativeValid,
  browserIdleTimeoutSeconds: binConfigurations.browserIdleTimeoutSeconds,
  status: binConfigurations.status,
  createdAt: binConfigurations.createdAt,
  updatedAt: binConfigurations.updatedAt,
};
const configValidationSelection = {
  id: binConfigurations.id,
  sourceAdapter: binConfigurations.sourceAdapter,
  config: binConfigurations.config,
  configNativeValid: binConfigurations.configNativeValid,
  runtimeId: runtimeConnections.runtimeId,
  runtimeSourceAdapter: runtimeConnections.sourceAdapter,
  runtimeControlUrl: runtimeConnections.runtimeControlUrl,
  protocolVersion: runtimeConnections.protocolVersion,
  ownerGeneration: runtimeConnections.ownerGeneration,
  disconnected: runtimeConnections.disconnected,
  lastHeartbeatAt: runtimeConnections.lastHeartbeatAt,
};
const addFormats = formats.default.default;
const sourceAdapterValidatorCacheLimit = 32;

type CompiledSourceAdapterValidators = {
  readonly configuration: ValidateFunction;
  readonly extensions: ValidateFunction;
  readonly actions: Readonly<Record<string, ValidateFunction>>;
  // Ajv 持有 schema 对象强引用；淘汰条目时一并释放整个编译器。
  readonly compiler: Ajv2020;
};

const sourceAdapterValidatorCache = new Map<
  string,
  CompiledSourceAdapterValidators
>();

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
        message:
          "The source adapter JSON Schema is invalid or uses an unsupported keyword.",
        path: [...path],
      },
    };
  }
}

function dynamicSchemaCacheKey(sourceAdapter: SourceAdapterManifest): string {
  const actions = Object.entries(sourceAdapter.actions)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, action]) => [name, action.params, action.output]);
  return JSON.stringify({
    config: sourceAdapter.configSchema,
    extensions: sourceAdapter.extensionsSchema,
    actions,
  });
}

function compileSourceAdapterValidators(sourceAdapter: SourceAdapterManifest): {
  readonly validators: CompiledSourceAdapterValidators | undefined;
  readonly error: BinError | undefined;
} {
  const cacheKey = dynamicSchemaCacheKey(sourceAdapter);
  const cached = sourceAdapterValidatorCache.get(cacheKey);
  if (cached !== undefined) {
    sourceAdapterValidatorCache.delete(cacheKey);
    sourceAdapterValidatorCache.set(cacheKey, cached);
    return { validators: cached, error: undefined };
  }

  const compiler = new Ajv2020({ strictTypes: false });
  addFormats(compiler);
  const config = createDynamicSchema(
    sourceAdapter.configSchema,
    ["sourceAdapter", "configSchema"],
    compiler,
  );
  if (config.error !== undefined)
    return { validators: undefined, error: config.error };

  const extensions = createDynamicSchema(
    sourceAdapter.extensionsSchema,
    ["sourceAdapter", "extensionsSchema"],
    compiler,
  );
  if (extensions.error !== undefined)
    return { validators: undefined, error: extensions.error };

  const actions: Record<string, ValidateFunction> = {};
  for (const [name, action] of Object.entries(sourceAdapter.actions)) {
    const result = createDynamicSchema(
      action.params,
      ["sourceAdapter", "actions", name, "params"],
      compiler,
    );
    if (result.error !== undefined)
      return { validators: undefined, error: result.error };
    const output = createDynamicSchema(
      action.output,
      ["sourceAdapter", "actions", name, "output"],
      compiler,
    );
    if (output.error !== undefined)
      return { validators: undefined, error: output.error };
    actions[name] = result.validator!;
  }

  const validators = {
    configuration: config.validator!,
    extensions: extensions.validator!,
    actions,
    compiler,
  };
  sourceAdapterValidatorCache.set(cacheKey, validators);
  if (sourceAdapterValidatorCache.size > sourceAdapterValidatorCacheLimit) {
    const oldestKey = sourceAdapterValidatorCache.keys().next();
    if (!oldestKey.done) sourceAdapterValidatorCache.delete(oldestKey.value);
  }
  return { validators, error: undefined };
}

/** Validate an archive extension object against the schema registered by its source adapter. */
export function validateSourceAdapterExtensions(
  sourceAdapter: SourceAdapterManifest,
  extensions: JsonObject,
): BinError | undefined {
  const checked = sourceAdapterManifestStoredSchema.safeParse(sourceAdapter);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return {
      code: "invalid_manifest",
      message: issue?.message ?? "信源适配器声明格式无效。",
      ...(issue === undefined
        ? {}
        : { path: schemaIssuePath(["sourceAdapter"], issue.path) }),
    };
  }

  const built = compileSourceAdapterValidators(checked.data);
  if (built.error !== undefined) return built.error;
  if (built.validators!.extensions(extensions)) return undefined;

  const issue = built.validators!.extensions.errors?.[0];
  return {
    code: "invalid_input",
    message: "Archive extensions do not match the source adapter schema.",
    ...(issue === undefined
      ? {}
      : { path: ["extensions", ...dynamicSchemaPath(issue)] }),
  };
}

export function validateSourceAdapterConfiguration(
  sourceAdapter: SourceAdapterManifest,
  config: JsonObject,
): BinError | undefined {
  const checked = sourceAdapterManifestStoredSchema.safeParse(sourceAdapter);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return {
      code: "invalid_manifest",
      message: issue?.message ?? "信源适配器声明格式无效。",
      ...(issue === undefined
        ? {}
        : { path: schemaIssuePath(["sourceAdapter"], issue.path) }),
    };
  }

  const built = compileSourceAdapterValidators(sourceAdapter);
  if (built.error !== undefined) return built.error;
  if (built.validators!.configuration(config)) return undefined;

  const issue = built.validators!.configuration.errors?.[0];
  return {
    code: "invalid_configuration",
    message: "长期配置不符合信源适配器声明。",
    ...(issue === undefined
      ? {}
      : { path: ["config", ...dynamicSchemaPath(issue)] }),
  };
}

function validateBrowserIdlePolicy(
  sourceAdapter: SourceAdapterManifest,
  browserIdleTimeoutSeconds: number | null,
): BinError | undefined {
  const browser = sourceAdapter.environment.browser;
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
        ? "信源适配器不支持关闭浏览器后复用持久配置文件。"
        : `信源适配器不支持关闭浏览器后复用持久配置文件：${reason}`,
    path: ["browserIdleTimeoutSeconds"],
  };
}

export type SourceAdapterActionValidation =
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
export function validateSourceAdapterActionParameters(
  sourceAdapter: SourceAdapterManifest,
  actionName: string,
  params: JsonObject,
): SourceAdapterActionValidation {
  const checked = sourceAdapterManifestStoredSchema.safeParse(sourceAdapter);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return {
      ok: false,
      code: "invalid_manifest",
      message: issue?.message ?? "信源适配器声明格式无效。",
      ...(issue === undefined
        ? {}
        : { path: schemaIssuePath(["sourceAdapter"], issue.path) }),
    };
  }

  if (!Object.hasOwn(checked.data.actions, actionName)) {
    return {
      ok: false,
      code: "action_not_found",
      message: "信源适配器没有声明这个动作。",
      path: ["action"],
    };
  }

  const built = compileSourceAdapterValidators(checked.data);
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
    message: "本次动作参数不符合信源适配器声明。",
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

async function selectConfigurationValidationSnapshot(
  database: Database,
  id: string,
) {
  const [row] = await database
    .select(configValidationSelection)
    .from(binConfigurations)
    .leftJoin(
      runtimeConnections,
      eq(runtimeConnections.binId, binConfigurations.id),
    )
    .where(eq(binConfigurations.id, id));
  return row;
}

type BinRow = NonNullable<Awaited<ReturnType<typeof selectBin>>>;

function rowToConfiguration(row: BinRow): BinConfiguration {
  return binConfigurationSchema.parse({
    id: row.id,
    sourceAdapter: row.sourceAdapter,
    identityId: row.identityId,
    config: row.config,
    browserIdleTimeoutSeconds: row.browserIdleTimeoutSeconds,
    status: row.status,
    execution: {
      status: "offline",
      reason: "runtime_not_connected",
      sourceStateSnapshot: {
        freshness: "unknown",
        sourceAccess: { status: "unknown" },
      },
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
  browserCapacity: BrowserCapacityCoordinator,
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

      const validationSnapshot =
        checked.data.config === undefined
          ? undefined
          : await selectConfigurationValidationSnapshot(database, id);
      if (validationSnapshot === undefined && checked.data.config !== undefined)
        return notFound(id);

      if (validationSnapshot !== undefined) {
        const available =
          validationSnapshot.runtimeId !== null &&
          validationSnapshot.runtimeControlUrl !== null &&
          validationSnapshot.protocolVersion === runtimeProtocolVersion &&
          validationSnapshot.lastHeartbeatAt !== null &&
          !validationSnapshot.disconnected &&
          Date.now() - validationSnapshot.lastHeartbeatAt.getTime() <=
            runtimeHeartbeatTimeoutMs &&
          isDeepStrictEqual(
            validationSnapshot.sourceAdapter,
            validationSnapshot.runtimeSourceAdapter,
          );
        if (!available) {
          return failure(
            409,
            "runtime_configuration_validation_unavailable",
            "当前运行器离线、协议过期或源码声明未同步，不能验证长期配置。",
            ["config"],
          );
        }
        const sourceAdapter = sourceAdapterManifestStoredSchema.parse(
          validationSnapshot.sourceAdapter,
        );
        const validation = await validateConfigurationAtRuntime(
          validationSnapshot.runtimeControlUrl!,
          sourceAdapter,
          checked.data.config!,
        );
        if (!validation.ok) {
          return {
            ok: false,
            status: validation.kind === "invalid" ? 400 : 409,
            error: validation.error,
          } as const;
        }
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
          sourceAdapter: previous.sourceAdapter,
          identityId: previous.identityId,
          config: previous.config,
        });
        const sourceAdapter = existing.sourceAdapter;
        const config = checked.data.config ?? existing.config;
        const browserIdleTimeoutSeconds =
          checked.data.browserIdleTimeoutSeconds === undefined
            ? previous.browserIdleTimeoutSeconds
            : checked.data.browserIdleTimeoutSeconds;
        const invalid = validateSourceAdapterConfiguration(
          sourceAdapter,
          config,
        );
        if (invalid !== undefined && checked.data.config === undefined)
          return { ok: false as const, status: 400 as const, error: invalid };

        if (validationSnapshot !== undefined) {
          const [currentRuntime] = await transaction
            .select(configValidationSelection)
            .from(binConfigurations)
            .leftJoin(
              runtimeConnections,
              eq(runtimeConnections.binId, binConfigurations.id),
            )
            .where(eq(binConfigurations.id, id));
          if (
            currentRuntime === undefined ||
            !isDeepStrictEqual(
              currentRuntime.config,
              validationSnapshot.config,
            ) ||
            !isDeepStrictEqual(
              currentRuntime.sourceAdapter,
              validationSnapshot.sourceAdapter,
            ) ||
            currentRuntime.runtimeId !== validationSnapshot.runtimeId ||
            currentRuntime.ownerGeneration !==
              validationSnapshot.ownerGeneration ||
            currentRuntime.protocolVersion !==
              validationSnapshot.protocolVersion ||
            currentRuntime.runtimeControlUrl !==
              validationSnapshot.runtimeControlUrl ||
            !isDeepStrictEqual(
              currentRuntime.runtimeSourceAdapter,
              validationSnapshot.runtimeSourceAdapter,
            ) ||
            currentRuntime.disconnected ||
            currentRuntime.lastHeartbeatAt === null ||
            Date.now() - currentRuntime.lastHeartbeatAt.getTime() >
              runtimeHeartbeatTimeoutMs
          ) {
            return failure(
              409,
              "configuration_changed",
              "配置或运行器声明在原生校验期间发生变化，请重新提交并验证。",
              ["config"],
            );
          }
        }
        const invalidIdlePolicy = validateBrowserIdlePolicy(
          sourceAdapter,
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
            identityId: checked.data.identityId ?? existing.identityId,
            config,
            ...(checked.data.config === undefined
              ? {}
              : { configNativeValid: true }),
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
        const [bin] = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, id))
          .for("update");
        if (bin === undefined) return notFound(id);
        if (await browserCapacity.hasReservation(transaction, id))
          return failure(
            409,
            "browser_capacity_active",
            "浏览器尚未确认退出；等待运行器停止后再移除这个 bin。",
            ["binId"],
          );

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
