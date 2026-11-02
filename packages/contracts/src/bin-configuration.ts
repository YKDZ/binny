// 共享资料、查询、运行与信源适配器契约，不依赖 HTTP 或业务实现。
import * as z from "zod";

import {
  postgresTextSchema,
  registerPostgresJsonSchemaProjection,
  toPostgresJsonSchema,
  validatePostgresJsonText,
  withPostgresJsonSchemaProjection,
} from "./postgres-text.ts";
import {
  runtimeHumanSessionControlSchema,
  runtimeHumanSessionEventSchema,
} from "./runtime-human-session.ts";

export const binIdSchema = postgresTextSchema
  .min(1, "bin 标识不能为空。")
  .max(128, "bin 标识不能超过 128 个字符。")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u,
    "bin 标识只能包含字母、数字、点、下划线和连字符。",
  );

export const sourceAdapterIdSchema = postgresTextSchema
  .min(1, "信源适配器标识不能为空。")
  .max(128, "信源适配器标识不能超过 128 个字符。");

export const identityIdSchema = postgresTextSchema
  .min(1, "访问身份标识不能为空。")
  .max(256, "访问身份标识不能超过 256 个字符。");

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const jsonObjectBaseSchema = z.custom<Record<string, unknown>>(
  isPlainJsonObject,
  { message: "字段必须是 JSON 对象。" },
);

/** 线上 JSON 对象；配置本身由对应信源适配器声明的动态 JSON Schema 校验。 */
export const jsonObjectSchema = withPostgresJsonSchemaProjection(
  jsonObjectBaseSchema.superRefine((object, context) => {
    validatePostgresJsonText(object, context);
  }),
);

registerPostgresJsonSchemaProjection(
  jsonObjectBaseSchema,
  jsonObjectSchema,
  z.record(postgresTextSchema, z.unknown()),
);

/** 信源适配器以 JSON Schema 声明运行时才知道的配置、目标和动作参数。 */
export const jsonSchemaDocumentSchema = jsonObjectSchema;

const targetsBaseSchema = z.custom<unknown[]>(Array.isArray, {
  message: "目标必须是 JSON 数组。",
});
const targetsSchema = targetsBaseSchema.superRefine((targets, context) => {
  validatePostgresJsonText(targets, context);
});
registerPostgresJsonSchemaProjection(
  targetsBaseSchema,
  targetsSchema,
  z.array(z.unknown()),
);

export const sourceAdapterActionNameSchema = postgresTextSchema.regex(
  /^[a-z][a-z0-9-]*$/u,
  "动作名称必须使用小写字母、数字和连字符。",
);

export const sourceAdapterActionSchema = withPostgresJsonSchemaProjection(
  z.object({
    description: postgresTextSchema.min(1, "动作说明不能为空。"),
    params: jsonSchemaDocumentSchema,
  }),
);

const sourceAdapterActionsSchema = z
  .record(sourceAdapterActionNameSchema, sourceAdapterActionSchema)
  .and(
    z.object({
      check: sourceAdapterActionSchema,
      collect: sourceAdapterActionSchema,
    }),
  );

const sourceAdapterManifestStoredFieldsSchema = z.object({
  id: sourceAdapterIdSchema,
  version: postgresTextSchema.min(1, "信源适配器版本不能为空。"),
  description: postgresTextSchema.optional(),
  configSchema: jsonSchemaDocumentSchema,
  actions: sourceAdapterActionsSchema,
  environment: z.object({
    browser: z.object({
      required: z.boolean(),
      profileReuseAfterRestart: z.boolean(),
      profileReuseUnavailableReason: postgresTextSchema.optional(),
    }),
  }),
});

const sourceAdapterManifestInputFieldsSchema = z.object({
  id: sourceAdapterIdSchema,
  version: postgresTextSchema.min(1, "信源适配器版本不能为空。"),
  description: postgresTextSchema.optional(),
  configSchema: jsonSchemaDocumentSchema,
  actions: sourceAdapterActionsSchema,
  environment: z.object({
    browser: z.object({
      required: z.boolean(),
      profileReuseAfterRestart: z.boolean(),
      profileReuseUnavailableReason: postgresTextSchema
        .min(1, "不支持原因不能为空。")
        .optional(),
    }),
  }),
});

const sourceAdapterManifestCheckedSchema =
  sourceAdapterManifestInputFieldsSchema.superRefine(
    (sourceAdapter, context) => {
      if (
        sourceAdapter.environment.browser.required &&
        !sourceAdapter.environment.browser.profileReuseAfterRestart &&
        sourceAdapter.environment.browser.profileReuseUnavailableReason ===
          undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["environment", "browser", "profileReuseUnavailableReason"],
          message: "不支持关闭后复用浏览器配置文件时必须说明原因。",
        });
      }
    },
  );

registerPostgresJsonSchemaProjection(
  sourceAdapterManifestInputFieldsSchema,
  sourceAdapterManifestCheckedSchema,
  sourceAdapterManifestInputFieldsSchema,
);

/** 持久化清单解析器保留旧版允许为空或缺失的复用原因。 */
export const sourceAdapterManifestStoredSchema =
  withPostgresJsonSchemaProjection(sourceAdapterManifestStoredFieldsSchema);

/** 新建或更新清单时使用；必需浏览器不支持复用 profile 时必须给出原因。 */
export const sourceAdapterManifestSchema = withPostgresJsonSchemaProjection(
  sourceAdapterManifestCheckedSchema,
);

export const browserIdleTimeoutSecondsSchema = z
  .number()
  .int("浏览器空闲关闭时长必须是整数秒。")
  .min(0, "浏览器空闲关闭时长不能为负数。")
  .max(2_147_483, "浏览器空闲关闭时长不能超过 2147483 秒。");

export const browserPowerStatusSchema = z.enum([
  "unavailable",
  "stopped",
  "starting",
  "ready",
  "stopping",
  "unknown",
]);

const browserPowerFieldsSchema = z
  .object({
    status: browserPowerStatusSchema,
    error: z
      .object({
        code: z.enum([
          "browser_start_failed",
          "browser_stop_failed",
          "browser_interrupted",
        ]),
        message: postgresTextSchema.min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const browserPowerCheckedSchema = browserPowerFieldsSchema.superRefine(
  (power, context) => {
    if (power.status === "unknown" && power.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "浏览器状态未知时必须说明原因。",
      });
    } else if (power.status !== "unknown" && power.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "只有浏览器状态未知时才能附带生命周期错误。",
      });
    }
  },
);

registerPostgresJsonSchemaProjection(
  browserPowerFieldsSchema,
  browserPowerCheckedSchema,
  browserPowerFieldsSchema,
);

export const browserPowerSchema = withPostgresJsonSchemaProjection(
  browserPowerCheckedSchema,
);

export type BrowserPower = z.infer<typeof browserPowerSchema>;

export const binCreateInputSchema = withPostgresJsonSchemaProjection(
  z.object({
    id: binIdSchema,
    sourceAdapter: sourceAdapterManifestSchema,
    identityId: identityIdSchema,
    config: jsonObjectSchema,
    targets: targetsSchema,
    browserIdleTimeoutSeconds: browserIdleTimeoutSecondsSchema
      .nullable()
      .optional(),
  }),
);

/** 持久化 bin 的运行配置切片，不将旧清单误当作新建输入重新校验。 */
export const binConfigurationSettingsSchema = withPostgresJsonSchemaProjection(
  z.object({
    id: binIdSchema,
    sourceAdapter: sourceAdapterManifestStoredSchema,
    identityId: identityIdSchema,
    config: jsonObjectSchema,
    targets: targetsSchema,
  }),
);

export const binUpdateInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      sourceAdapter: sourceAdapterManifestSchema.optional(),
      identityId: identityIdSchema.optional(),
      config: jsonObjectSchema.optional(),
      targets: targetsSchema.optional(),
      browserIdleTimeoutSeconds: browserIdleTimeoutSecondsSchema
        .nullable()
        .optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: "至少提供一个需要修改的字段。",
    }),
);

export const binStatusSchema = z.enum(["active", "disabled"]);

export const runtimeHeartbeatIntervalMs = 2_000;
export const runtimeHeartbeatTimeoutMs = 8_000;
export const legacyRuntimeProtocolVersion = 4;
export const runtimeProtocolVersion = 5;
export const runtimeEnvironmentKindSchema = z.enum(["lightweight", "browser"]);
export type RuntimeEnvironmentKind = z.infer<
  typeof runtimeEnvironmentKindSchema
>;

const runtimeEnvironmentBrowserFieldsSchema = z.object({
  available: z.boolean(),
  profileReuseAfterRestart: z.boolean(),
});

/** 旧协议持久快照可以没有 power；该缺省不能用于校验新心跳。 */
export const runtimeEnvironmentStoredSchema = z.object({
  kind: runtimeEnvironmentKindSchema,
  browser: runtimeEnvironmentBrowserFieldsSchema.extend({
    power: browserPowerSchema.optional(),
  }),
});

export const runtimeEnvironmentSchema = z.object({
  kind: runtimeEnvironmentKindSchema,
  browser: runtimeEnvironmentBrowserFieldsSchema.extend({
    power: browserPowerSchema,
  }),
});

export const runtimeBrowserPowerEventSchema = z
  .object({
    reservationId: z.string().uuid(),
    event: z.enum([
      "starting",
      "ready",
      "stopping",
      "stopped",
      "unknown",
      "not_started",
    ]),
  })
  .strict();

const runtimeOwnerGenerationSchema = postgresTextSchema
  .regex(/^[1-9][0-9]*$/u, "运行器所有权代际必须是正十进制整数。")
  .refine(
    (value) =>
      value.length < 19 ||
      (value.length === 19 && value <= "9223372036854775807"),
    "运行器所有权代际超出 PostgreSQL bigint 范围。",
  );

const runtimeHeartbeatFieldsSchema = z.object({
  runtimeId: postgresTextSchema.min(1),
  ownerGeneration: runtimeOwnerGenerationSchema,
  ownerLockAcquired: z.literal(true),
  activeRunId: z.string().uuid().nullable(),
  claimInFlight: z.boolean(),
  stoppedRunId: z.string().uuid().optional(),
  humanSessionEvent: runtimeHumanSessionEventSchema.optional(),
  sourceAdapter: sourceAdapterManifestStoredSchema,
  environment: runtimeEnvironmentSchema,
});

const legacyRuntimeHeartbeatSchema = runtimeHeartbeatFieldsSchema.extend({
  protocolVersion: z.literal(legacyRuntimeProtocolVersion),
});

const runtimeHeartbeatV5Schema = runtimeHeartbeatFieldsSchema
  .extend({
    protocolVersion: z.literal(runtimeProtocolVersion),
    browserPowerEvent: runtimeBrowserPowerEventSchema.optional(),
  })
  .superRefine((input, context) => {
    const event = input.browserPowerEvent;
    if (
      event?.event === "not_started" &&
      input.environment.browser.power.status !== "stopped"
    ) {
      context.addIssue({
        code: "custom",
        path: ["environment", "browser", "power", "status"],
        message: "未启动确认只能伴随已停止的真实电源状态。",
      });
    }
  });

export const runtimeHeartbeatInputSchema = withPostgresJsonSchemaProjection(
  z.discriminatedUnion("protocolVersion", [
    legacyRuntimeHeartbeatSchema,
    runtimeHeartbeatV5Schema,
  ]),
);

export const runtimeDisconnectInputSchema = z.object({
  runtimeId: postgresTextSchema.min(1),
  ownerLockAcquired: z.literal(true),
  activeRunId: z.null(),
  claimInFlight: z.literal(false),
});

export const runtimeExecutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("online"),
    runtimeId: postgresTextSchema,
    environment: runtimeEnvironmentSchema,
    lastHeartbeatAt: z.iso.datetime(),
  }),
  z.object({
    status: z.literal("offline"),
    reason: z.enum([
      "runtime_not_connected",
      "heartbeat_expired",
      "runtime_protocol_outdated",
    ]),
    runtimeId: postgresTextSchema.optional(),
    lastHeartbeatAt: z.iso.datetime().optional(),
  }),
  z.object({
    status: z.literal("incompatible"),
    runtimeId: postgresTextSchema,
    lastHeartbeatAt: z.iso.datetime(),
    error: z.object({
      code: z.enum([
        "runtime_manifest_mismatch",
        "runtime_configuration_incompatible",
        "runtime_environment_incompatible",
        "runtime_owner_mismatch",
      ]),
      message: postgresTextSchema,
      path: z.array(z.union([z.string(), z.number()])),
    }),
  }),
]);

export const binConfigurationSchema = withPostgresJsonSchemaProjection(
  z.object({
    id: binIdSchema,
    sourceAdapter: sourceAdapterManifestStoredSchema,
    identityId: identityIdSchema,
    config: jsonObjectSchema,
    targets: targetsSchema,
    browserIdleTimeoutSeconds: browserIdleTimeoutSecondsSchema.nullable(),
    status: binStatusSchema,
    execution: runtimeExecutionSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
);

export const binErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "invalid_input",
      "invalid_manifest",
      "invalid_configuration",
      "bin_already_exists",
      "bin_not_found",
      "runtime_manifest_mismatch",
      "runtime_configuration_incompatible",
      "runtime_environment_incompatible",
      "runtime_owner_mismatch",
      "browser_capacity_active",
      "browser_reservation_mismatch",
    ]),
    message: postgresTextSchema,
    path: z.array(z.union([z.string(), z.number()])).optional(),
  }),
});

export type JsonObject = z.infer<typeof jsonObjectSchema>;
export type JsonSchema = z.infer<typeof jsonSchemaDocumentSchema>;
export type SourceAdapterManifest = z.infer<typeof sourceAdapterManifestSchema>;
export type BinCreateInput = z.infer<typeof binCreateInputSchema>;
export type BinUpdateInput = z.infer<typeof binUpdateInputSchema>;
export type BinConfiguration = z.infer<typeof binConfigurationSchema>;
export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;
export type RuntimeEnvironmentStored = z.infer<
  typeof runtimeEnvironmentStoredSchema
>;
export type RuntimeHeartbeatInput = z.infer<typeof runtimeHeartbeatInputSchema>;
export type RuntimeDisconnectInput = z.infer<
  typeof runtimeDisconnectInputSchema
>;
export type RuntimeExecution = z.infer<typeof runtimeExecutionSchema>;
export type BinError = z.infer<typeof binErrorSchema>["error"];
export type BinOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 409;
      readonly error: BinError;
    };
export type BinConfigurationOperations = {
  listBins(): Promise<readonly BinConfiguration[]>;
  getBin(id: string): Promise<BinOperation<BinConfiguration>>;
  createBin(input: BinCreateInput): Promise<BinOperation<BinConfiguration>>;
  updateBin(
    id: string,
    input: BinUpdateInput,
  ): Promise<BinOperation<BinConfiguration>>;
  setBinStatus(
    id: string,
    status: "active" | "disabled",
  ): Promise<BinOperation<BinConfiguration>>;
  removeBin(id: string): Promise<BinOperation<{ readonly id: string }>>;
};

export type RuntimeConnectionOperations = {
  getExecution(id: string): Promise<BinOperation<RuntimeExecution>>;
  heartbeat(
    binId: string,
    input: RuntimeHeartbeatInput,
  ): Promise<BinOperation<RuntimeHeartbeatResult>>;
  disconnect(
    binId: string,
    input: RuntimeDisconnectInput,
  ): Promise<BinOperation<RuntimeExecution>>;
};

export const runtimeHeartbeatResultSchema = runtimeExecutionSchema.and(
  z.object({
    browserIdleTimeoutSeconds: browserIdleTimeoutSecondsSchema.nullable(),
    humanSession: runtimeHumanSessionControlSchema.optional(),
  }),
);

export type RuntimeHeartbeatResult = z.infer<
  typeof runtimeHeartbeatResultSchema
>;

/** 使用与运行时校验相同的 Zod 4 原生接口生成输入 JSON Schema。 */
export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return toPostgresJsonSchema(schema, "input");
}
