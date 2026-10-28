// 共享资料、查询、运行与采集器契约，不依赖 HTTP 或业务实现。
import * as z from "zod";

export const binIdSchema = z
  .string()
  .min(1, "bin 标识不能为空。")
  .max(128, "bin 标识不能超过 128 个字符。")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u,
    "bin 标识只能包含字母、数字、点、下划线和连字符。",
  );

export const collectorIdSchema = z
  .string()
  .min(1, "采集器标识不能为空。")
  .max(128, "采集器标识不能超过 128 个字符。");

export const identityIdSchema = z
  .string()
  .min(1, "访问身份标识不能为空。")
  .max(256, "访问身份标识不能超过 256 个字符。");

/** 线上 JSON 对象；配置本身由对应采集器声明的动态 JSON Schema 校验。 */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

/** 采集器以 JSON Schema 声明运行时才知道的配置、目标和动作参数。 */
export const jsonSchemaDocumentSchema = z.record(z.string(), z.unknown());

export const collectorActionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/u, "动作名称必须使用小写字母、数字和连字符。");

export const collectorActionSchema = z.object({
  description: z.string().min(1, "动作说明不能为空。"),
  params: jsonSchemaDocumentSchema,
});

export const collectorManifestSchema = z.object({
  id: collectorIdSchema,
  version: z.string().min(1, "采集器版本不能为空。"),
  description: z.string().optional(),
  configSchema: jsonSchemaDocumentSchema,
  actions: z.record(collectorActionNameSchema, collectorActionSchema),
  environment: z.object({
    browser: z.object({
      required: z.boolean(),
      profileReuseAfterRestart: z.boolean(),
      profileReuseUnavailableReason: z.string().optional(),
    }),
  }),
});

export const binCreateInputSchema = z.object({
  id: binIdSchema,
  collector: collectorManifestSchema,
  identityId: identityIdSchema,
  config: jsonObjectSchema,
  targets: z.array(z.unknown()),
});

export const binUpdateInputSchema = z
  .object({
    collector: collectorManifestSchema.optional(),
    identityId: identityIdSchema.optional(),
    config: jsonObjectSchema.optional(),
    targets: z.array(z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少提供一个需要修改的字段。",
  });

export const binStatusSchema = z.enum(["active", "disabled"]);

export const binConfigurationSchema = z.object({
  id: binIdSchema,
  collector: collectorManifestSchema,
  identityId: identityIdSchema,
  config: jsonObjectSchema,
  targets: z.array(z.unknown()),
  status: binStatusSchema,
  execution: z.object({
    status: z.literal("unavailable"),
    reason: z.literal("runtime_not_connected"),
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const binErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "invalid_input",
      "invalid_manifest",
      "invalid_configuration",
      "bin_already_exists",
      "bin_not_found",
    ]),
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
  }),
});

export type JsonObject = z.infer<typeof jsonObjectSchema>;
export type JsonSchema = z.infer<typeof jsonSchemaDocumentSchema>;
export type CollectorManifest = z.infer<typeof collectorManifestSchema>;
export type BinCreateInput = z.infer<typeof binCreateInputSchema>;
export type BinUpdateInput = z.infer<typeof binUpdateInputSchema>;
export type BinConfiguration = z.infer<typeof binConfigurationSchema>;
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

/** 使用与运行时校验相同的 Zod 4 原生接口生成输入 JSON Schema。 */
export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" });
}
