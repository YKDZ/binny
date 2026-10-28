import * as z from "zod";

/** PostgreSQL UTF-8 文本接受良构 Unicode，但不能保存 U+0000。 */
export const postgresTextMessage =
  "文本不能包含空字符或未配对的 Unicode 代理项。";

// Unicode 模式把合法代理对视为单个码点，供原生 JSON Schema 投影复用。
const postgresTextPattern = new RegExp(
  "^[^" + "\\u0000" + "\\uD800-\\uDFFF" + "]*$",
  "u",
);

export const postgresTextSchema = z
  .string()
  .regex(postgresTextPattern, postgresTextMessage);

const jsonSchemaProjections = new WeakMap<object, z.ZodType>();

/**
 * 给自定义运行时校验绑定同源的 Zod JSON Schema 投影。
 * 注册 base 与 refine 后的 schema，因为 Zod 会为后者保留 parent 节点。
 */
export function registerPostgresJsonSchemaProjection(
  base: z.ZodType,
  checked: z.ZodType,
  projection: z.ZodType,
): void {
  jsonSchemaProjections.set(base, projection);
  jsonSchemaProjections.set(checked, projection);
}

const postgresJsonSchemaUnrepresentable: z.core.UnrepresentableHandler = ({
  zodSchema,
}) => {
  const projection = jsonSchemaProjections.get(zodSchema);
  return projection === undefined ? "throw" : z.toJSONSchema(projection);
};

/** 给含已注册 custom JSON 节点的根契约绑定 Zod 原生 Standard Schema 投影。 */
export function withPostgresJsonSchemaProjection<T extends z.ZodType>(
  schema: T,
): T {
  const standard = schema["~standard"];
  schema["~standard"] = {
    ...standard,
    jsonSchema: {
      input: (options) =>
        standard.jsonSchema.input({
          ...options,
          libraryOptions: {
            ...options.libraryOptions,
            unrepresentable: postgresJsonSchemaUnrepresentable,
          },
        }),
      output: (options) =>
        standard.jsonSchema.output({
          ...options,
          libraryOptions: {
            ...options.libraryOptions,
            unrepresentable: postgresJsonSchemaUnrepresentable,
          },
        }),
    },
  };
  return schema;
}

/** 使用 Zod 原生规则投影契约，并处理已注册的 custom JSON 节点。 */
export function toPostgresJsonSchema(
  schema: z.ZodType,
  io: "input" | "output" = "input",
): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io,
    unrepresentable: postgresJsonSchemaUnrepresentable,
  });
}

export function addPostgresTextIssue(
  value: string,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (!postgresTextPattern.test(value)) {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: postgresTextMessage,
    });
  }
}

/** 递归检查准备写入 JSONB 的键和值，保留 JSON 数据本身不做归一化。 */
export function validatePostgresJsonText(
  value: unknown,
  context: z.RefinementCtx,
  path: readonly (string | number)[] = [],
  ancestors: WeakSet<object> = new WeakSet<object>(),
): void {
  if (typeof value === "string") {
    addPostgresTextIssue(value, context, path);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (ancestors.has(value)) return;

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validatePostgresJsonText(
        value[index],
        context,
        [...path, index],
        ancestors,
      );
    }
  } else {
    for (const [key, nestedValue] of Object.entries(value)) {
      addPostgresTextIssue(key, context, [...path, key]);
      validatePostgresJsonText(nestedValue, context, [...path, key], ancestors);
    }
  }
  ancestors.delete(value);
}
