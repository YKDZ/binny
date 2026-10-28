// 共享资料、查询、运行与采集器契约，不依赖 HTTP 或业务实现。
import * as z from "zod";

import {
  postgresTextSchema,
  registerPostgresJsonSchemaProjection,
  toPostgresJsonSchema,
  validatePostgresJsonText,
  withPostgresJsonSchemaProjection,
} from "./postgres-text.ts";

export const binIdSchema = postgresTextSchema
  .min(1, "bin 标识不能为空。")
  .max(128, "bin 标识不能超过 128 个字符。")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u,
    "bin 标识只能包含字母、数字、点、下划线和连字符。",
  );

export const collectorIdSchema = postgresTextSchema
  .min(1, "采集器标识不能为空。")
  .max(128, "采集器标识不能超过 128 个字符。");

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

/** 线上 JSON 对象；配置本身由对应采集器声明的动态 JSON Schema 校验。 */
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

/** 采集器以 JSON Schema 声明运行时才知道的配置、目标和动作参数。 */
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

export const collectorActionNameSchema = postgresTextSchema.regex(
  /^[a-z][a-z0-9-]*$/u,
  "动作名称必须使用小写字母、数字和连字符。",
);

export const collectorActionSchema = withPostgresJsonSchemaProjection(
  z.object({
    description: postgresTextSchema.min(1, "动作说明不能为空。"),
    params: jsonSchemaDocumentSchema,
  }),
);

const collectorActionsSchema = z
  .record(collectorActionNameSchema, collectorActionSchema)
  .and(z.object({ check: collectorActionSchema }));

export const collectorManifestSchema = withPostgresJsonSchemaProjection(
  z.object({
    id: collectorIdSchema,
    version: postgresTextSchema.min(1, "采集器版本不能为空。"),
    description: postgresTextSchema.optional(),
    configSchema: jsonSchemaDocumentSchema,
    actions: collectorActionsSchema,
    environment: z.object({
      browser: z.object({
        required: z.boolean(),
        profileReuseAfterRestart: z.boolean(),
        profileReuseUnavailableReason: postgresTextSchema.optional(),
      }),
    }),
  }),
);

export const binCreateInputSchema = withPostgresJsonSchemaProjection(
  z.object({
    id: binIdSchema,
    collector: collectorManifestSchema,
    identityId: identityIdSchema,
    config: jsonObjectSchema,
    targets: targetsSchema,
  }),
);

export const binUpdateInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      collector: collectorManifestSchema.optional(),
      identityId: identityIdSchema.optional(),
      config: jsonObjectSchema.optional(),
      targets: targetsSchema.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: "至少提供一个需要修改的字段。",
    }),
);

export const binStatusSchema = z.enum(["active", "disabled"]);

export const runtimeHeartbeatIntervalMs = 2_000;
export const runtimeHeartbeatTimeoutMs = 8_000;
export const runtimeProtocolVersion = 2;
export const runtimeEnvironmentKindSchema = z.enum(["lightweight", "browser"]);
export type RuntimeEnvironmentKind = z.infer<
  typeof runtimeEnvironmentKindSchema
>;

export const runtimeEnvironmentSchema = z.object({
  kind: runtimeEnvironmentKindSchema,
  browser: z.object({
    available: z.boolean(),
    profileReuseAfterRestart: z.boolean(),
  }),
});

export const runtimeHeartbeatInputSchema = withPostgresJsonSchemaProjection(
  z.object({
    protocolVersion: z.literal(runtimeProtocolVersion),
    runtimeId: postgresTextSchema.min(1),
    ownerLockAcquired: z.literal(true),
    activeRunId: z.string().uuid().nullable(),
    claimInFlight: z.boolean(),
    collector: collectorManifestSchema,
    environment: runtimeEnvironmentSchema,
  }),
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
    reason: z.enum(["runtime_not_connected", "heartbeat_expired"]),
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
    collector: collectorManifestSchema,
    identityId: identityIdSchema,
    config: jsonObjectSchema,
    targets: targetsSchema,
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
    ]),
    message: postgresTextSchema,
    path: z.array(z.union([z.string(), z.number()])).optional(),
  }),
});

export type JsonObject = z.infer<typeof jsonObjectSchema>;
export type JsonSchema = z.infer<typeof jsonSchemaDocumentSchema>;
export type CollectorManifest = z.infer<typeof collectorManifestSchema>;
export type BinCreateInput = z.infer<typeof binCreateInputSchema>;
export type BinUpdateInput = z.infer<typeof binUpdateInputSchema>;
export type BinConfiguration = z.infer<typeof binConfigurationSchema>;
export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;
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
  ): Promise<BinOperation<RuntimeExecution>>;
  disconnect(
    binId: string,
    input: RuntimeDisconnectInput,
  ): Promise<BinOperation<RuntimeExecution>>;
};

/** 使用与运行时校验相同的 Zod 4 原生接口生成输入 JSON Schema。 */
export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return toPostgresJsonSchema(schema, "input");
}
