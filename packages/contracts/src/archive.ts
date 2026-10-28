import * as z from "zod";

import type { ArchiveHistoryOperations } from "./archive-history.ts";
import type { ArchiveRelationsOperations } from "./archive-relations.ts";
import { binIdSchema } from "./bin-configuration.ts";
import {
  addPostgresTextIssue,
  postgresTextSchema,
  registerPostgresJsonSchemaProjection,
  toPostgresJsonSchema,
  withPostgresJsonSchemaProjection,
} from "./postgres-text.ts";

const nonEmptyText = postgresTextSchema
  .min(1, "字段不能为空。")
  .max(4096, "字段不能超过 4096 个字符。")
  .refine((value) => value.trim().length > 0, "字段不能为空。");

const sourceKeySchema = z
  .object({
    namespace: nonEmptyText.max(256, "信源命名空间不能超过 256 个字符。"),
    key: nonEmptyText.max(1024, "信源对象键不能超过 1024 个字符。"),
  })
  .strict();

// JSON 整数必须能由 JavaScript Number 精确表示，避免读写时静默改值。
const jsonNumberSchema = z
  .number()
  .finite()
  .refine(
    (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
    "JSON 整数必须处于 JavaScript 安全整数范围内。",
  );

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type ArchiveJsonValue =
  | null
  | boolean
  | number
  | string
  | ArchiveJsonValue[]
  | { [key: string]: ArchiveJsonValue };

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): value is ArchiveJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return true;
  }
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return true;

  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (index in value && !isJsonValue(value[index], ancestors)) {
        valid = false;
        break;
      }
    }
  } else if (isPlainJsonObject(value)) {
    for (const nestedValue of Object.values(value)) {
      if (!isJsonValue(nestedValue, ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

function validateJsonValue(
  value: unknown,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  ancestors: WeakSet<object>,
): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    addPostgresTextIssue(value, context, path);
    return;
  }
  if (typeof value === "number") {
    const checked = jsonNumberSchema.safeParse(value);
    if (!checked.success) {
      context.addIssue({
        code: "custom",
        path: [...path],
        message: checked.error.issues[0]?.message ?? "JSON 数字无效。",
      });
    }
    return;
  }
  if (typeof value !== "object") {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: "字段值必须是 JSON 数据。",
    });
    return;
  }
  if (ancestors.has(value)) {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: "JSON 数据不能包含循环引用。",
    });
    return;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        context.addIssue({
          code: "custom",
          path: [...path, index],
          message: "JSON 数组不能包含空位。",
        });
      } else {
        validateJsonValue(value[index], context, [...path, index], ancestors);
      }
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      context.addIssue({
        code: "custom",
        path: [...path],
        message: "字段值必须是 JSON 对象。",
      });
    } else {
      for (const [key, nestedValue] of Object.entries(value)) {
        addPostgresTextIssue(key, context, [...path, key]);
        validateJsonValue(nestedValue, context, [...path, key], ancestors);
      }
    }
  }
  ancestors.delete(value);
}

const jsonObjectBaseSchema = z.custom<Record<string, unknown>>(
  isPlainJsonObject,
  { message: "字段必须是 JSON 对象。" },
);
const archiveJsonValueBaseSchema = z.custom<unknown>(isJsonValue, {
  message: "字段值必须是 JSON 数据。",
});
const archiveJsonValueSchema = archiveJsonValueBaseSchema.superRefine(
  (value, context) => {
    if (!isJsonValue(value)) {
      context.addIssue({
        code: "custom",
        message: "字段值必须是 JSON 数据。",
      });
      return;
    }
    validateJsonValue(value, context, [], new WeakSet<object>());
  },
);
registerPostgresJsonSchemaProjection(
  archiveJsonValueBaseSchema,
  archiveJsonValueSchema,
  z.unknown(),
);
const jsonObjectSchema = jsonObjectBaseSchema.superRefine((object, context) => {
  const ancestors = new WeakSet<object>([object]);
  for (const [key, value] of Object.entries(object)) {
    addPostgresTextIssue(key, context, [key]);
    validateJsonValue(value, context, [key], ancestors);
  }
});

const jsonObjectProjectionSchema = z.record(postgresTextSchema, z.unknown());
registerPostgresJsonSchemaProjection(
  jsonObjectBaseSchema,
  jsonObjectSchema,
  jsonObjectProjectionSchema,
);

/** 为含归档 JSON custom 节点的根 schema 绑定 Zod 原生 JSON Schema 投影。 */
export function withArchiveJsonSchemaProjection<T extends z.ZodType>(
  schema: T,
): T {
  return withPostgresJsonSchemaProjection(schema);
}

/** 使用 Zod 原生规则输出归档 JSON 的输入或输出 Schema。 */
export function toArchiveJsonSchema(
  schema: z.ZodType,
  io: "input" | "output",
): Record<string, unknown> {
  return toPostgresJsonSchema(schema, io);
}

const archiveRelationTargetInputSchema = z.union([
  z.object({ sourceKey: sourceKeySchema }).strict(),
  z
    .object({
      sourceRef: nonEmptyText.max(4096, "外部来源引用不能超过 4096 个字符。"),
    })
    .strict(),
]);

/** 关系端点引用已归档对象，或显式标记为尚未归档的外部来源。 */
export const archiveRelationStateSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      from: sourceKeySchema,
      to: archiveRelationTargetInputSchema,
      name: nonEmptyText.max(256, "关系名称不能超过 256 个字符。"),
      properties: jsonObjectSchema.optional(),
      // true 表示删除 from 时沿 from -> to 级联；名称本身没有删除语义。
      cascade: z.boolean(),
    })
    .strict()
    .superRefine((relation, context) => {
      if ("sourceRef" in relation.to && relation.cascade) {
        context.addIssue({
          code: "custom",
          path: ["cascade"],
          message: "外部来源引用不能声明内部对象级联。",
        });
      }
    }),
);

export type ArchiveRelationState = z.infer<typeof archiveRelationStateSchema>;

const archiveRelationInputSchema = z
  .object({
    relationId: nonEmptyText.max(256, "关系标识不能超过 256 个字符。"),
    value: archiveRelationStateSchema.nullable(),
  })
  .strict();

const archiveBodySchema = z
  .object({
    html: postgresTextSchema.optional(),
    markdown: postgresTextSchema.optional(),
    text: postgresTextSchema.optional(),
    searchText: postgresTextSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "正文至少需要提供一种表示。",
  });

const archiveMissingSchema = z
  .object({
    path: nonEmptyText.max(1024, "缺失字段路径不能超过 1024 个字符。"),
    reason: nonEmptyText,
  })
  .strict();

const archiveCaptureSchema = z
  .object({
    scope: jsonObjectSchema,
    completeness: z.enum(["complete", "partial"]),
    missing: z.array(archiveMissingSchema),
  })
  .strict()
  .superRefine((capture, context) => {
    if (capture.completeness === "partial" && capture.missing.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["missing"],
        message: "部分资料必须说明缺失内容。",
      });
    }
    if (capture.completeness === "complete" && capture.missing.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["missing"],
        message: "完整资料不能声明缺失内容。",
      });
    }
  });

const archiveDiagnosticSchema = z
  .object({
    code: nonEmptyText.max(128, "诊断代码不能超过 128 个字符。"),
    message: nonEmptyText,
    details: jsonObjectSchema.optional(),
    suggestion: nonEmptyText.optional(),
  })
  .strict();

// 将显式来源时刻规范为 UTC；字段缺省时不代造来源时间。
const timestampSchema = z.iso
  .datetime({ offset: true })
  .overwrite((value) => new Date(value).toISOString());

export const archiveResourceReferenceSchema = z
  .object({ resourceId: z.string().uuid() })
  .strict();
export type ArchiveResourceReference = z.infer<
  typeof archiveResourceReferenceSchema
>;

const archiveItemFieldsSchema = z
  .object({
    sourceRef: nonEmptyText.optional(),
    sourceModifiedAt: timestampSchema.optional(),
    metadata: jsonObjectSchema.optional(),
    properties: jsonObjectSchema.optional(),
    body: archiveBodySchema.optional(),
    resources: z
      .array(archiveResourceReferenceSchema)
      .optional()
      .superRefine((resources, context) => {
        const resourceIds = new Set<string>();
        for (const [index, resource] of (resources ?? []).entries()) {
          if (resourceIds.has(resource.resourceId)) {
            context.addIssue({
              code: "custom",
              path: [index, "resourceId"],
              message: "同一内容版本不能重复登记相同资源。",
            });
          }
          resourceIds.add(resource.resourceId);
        }
      }),
    capture: archiveCaptureSchema,
  })
  .strict();

function hasReceivedMaterial(item: {
  readonly metadata?: Record<string, unknown> | undefined;
  readonly properties?: Record<string, unknown> | undefined;
  readonly body?: object | undefined;
  readonly resources?: readonly unknown[] | undefined;
}): boolean {
  const hasMetadata =
    item.metadata !== undefined && Object.keys(item.metadata).length > 0;
  const hasProperties =
    item.properties !== undefined && Object.keys(item.properties).length > 0;
  // sourceRef 只定位出处，不能让未取得资料的失败形成空版本。
  return (
    hasMetadata ||
    hasProperties ||
    item.body !== undefined ||
    (item.resources?.length ?? 0) > 0
  );
}

/** 保存已整理的资料状态；采集上下文和诊断不会因此生成新版本。 */
export const archiveItemStateSchema = withArchiveJsonSchemaProjection(
  archiveItemFieldsSchema.refine(hasReceivedMaterial, {
    path: ["body"],
    message: "没有取得资料时不能创建空内容版本。",
  }),
);

/** 单对象提交必须携带稳定信源键，不能从正文推测身份。 */
export const archiveItemInputSchema = withArchiveJsonSchemaProjection(
  archiveItemFieldsSchema
    .extend({
      sourceKey: sourceKeySchema,
      diagnostics: z.array(archiveDiagnosticSchema).optional(),
    })
    .strict()
    .refine(hasReceivedMaterial, {
      path: ["body"],
      message: "没有取得资料时不能创建空内容版本。",
    }),
);

export type ArchiveItemState = z.infer<typeof archiveItemStateSchema>;
export type ArchiveItemInput = z.infer<typeof archiveItemInputSchema>;

/** 提交标识全局唯一；相同标识不得用于不同业务负载。 */
export const archiveSubmissionInputSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      requestId: nonEmptyText.max(256, "请求标识不能超过 256 个字符。"),
      binId: binIdSchema,
      runId: nonEmptyText.max(128, "run 标识不能超过 128 个字符。").optional(),
      collectorVersion: nonEmptyText
        .max(256, "采集器版本不能超过 256 个字符。")
        .optional(),
      observedAt: timestampSchema.optional(),
      items: z.array(archiveItemInputSchema).max(100),
      relations: z.array(archiveRelationInputSchema).max(100).default([]),
    })
    .strict()
    .superRefine((submission, context) => {
      if (submission.items.length === 0 && submission.relations.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["items"],
          message: "归档提交至少需要包含一个条目或关系观察。",
        });
      }
      const sourceKeys = new Set<string>();
      for (const [index, item] of submission.items.entries()) {
        const identity = JSON.stringify([
          item.sourceKey.namespace,
          item.sourceKey.key,
        ]);
        if (sourceKeys.has(identity)) {
          context.addIssue({
            code: "custom",
            path: ["items", index, "sourceKey"],
            message: "同一批资料不能重复提交相同信源键。",
          });
        }
        sourceKeys.add(identity);
      }
      const relationIds = new Set<string>();
      for (const [index, relation] of submission.relations.entries()) {
        if (relationIds.has(relation.relationId)) {
          context.addIssue({
            code: "custom",
            path: ["relations", index, "relationId"],
            message: "同一批资料不能重复声明相同关系标识。",
          });
        }
        relationIds.add(relation.relationId);
      }
    }),
);

export type ArchiveSubmissionInput = z.infer<
  typeof archiveSubmissionInputSchema
>;

export const archiveIdentifierSchema = z.string().uuid();
const archiveIdSchema = archiveIdentifierSchema;
const archiveSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const archiveResourceMediaTypeSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u,
    "媒体类型格式无效。",
  );

export const archiveResourceMetadataSchema = z
  .object({
    resourceId: archiveIdSchema,
    sha256: archiveSha256Schema,
    mediaType: archiveResourceMediaTypeSchema,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ArchiveResourceMetadata = z.infer<
  typeof archiveResourceMetadataSchema
>;

// PostgreSQL BIGINT 序号以十进制文本传输，避免超出安全整数范围时舍入。
export const archiveSequenceSchema = z.string().regex(/^[1-9][0-9]*$/u);
export const archiveSnapshotSequenceSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/u);
/** 读取在此已提交序号内所知的 current 视图或历史视图。 */
export const archiveSnapshotSchema = z
  .object({
    asOf: archiveSnapshotSequenceSchema,
    mode: z.enum(["current", "asOf"]),
  })
  .strict();
const archiveStateHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const archiveCommitItemSchema = z
  .object({
    itemId: archiveIdSchema,
    revisionId: archiveIdSchema,
    sourceKey: sourceKeySchema,
  })
  .strict();

const archiveCommitRelationFields = {
  relationId: nonEmptyText.max(256),
  ordinal: z.number().int().nonnegative(),
};

const archiveCommitRelationSchema = z.union([
  z
    .object({
      ...archiveCommitRelationFields,
      status: z.literal("observed"),
      revisionId: archiveIdSchema,
      state: archiveRelationStateSchema,
    })
    .strict(),
  z
    .object({
      ...archiveCommitRelationFields,
      status: z.literal("withdrawn"),
    })
    .strict(),
]);

const archiveCommitItemGapSchema = z
  .object({
    itemId: archiveIdSchema,
    ordinal: z.number().int().nonnegative(),
    sourceKey: sourceKeySchema,
  })
  .strict();

const archiveCommitRelationGapSchema = z
  .object({
    relationId: nonEmptyText.max(256),
    ordinal: z.number().int().nonnegative(),
  })
  .strict();

const archiveCommitGapsSchema = z
  .object({
    items: z.array(archiveCommitItemGapSchema),
    relations: z.array(archiveCommitRelationGapSchema),
  })
  .strict();

export const archiveObservationSchema = z
  .object({
    commitId: archiveIdSchema,
    archiveSeq: archiveSequenceSchema,
    ordinal: z.number().int().nonnegative(),
    binId: binIdSchema,
    runId: nonEmptyText.max(128).optional(),
    collectorVersion: nonEmptyText.max(256).optional(),
    revisionId: archiveIdSchema,
    sourceModifiedAt: timestampSchema.optional(),
    observedAt: timestampSchema,
    recordedAt: timestampSchema,
    diagnostics: z.array(archiveDiagnosticSchema).optional(),
  })
  .strict();

const archiveViewSchema = z
  .object({
    binId: binIdSchema,
    archiveSeq: archiveSequenceSchema,
    revisionId: archiveIdSchema,
    observedAt: timestampSchema,
    recordedAt: timestampSchema,
    runId: nonEmptyText.max(128).optional(),
    collectorVersion: nonEmptyText.max(256).optional(),
    state: archiveItemStateSchema,
    diagnostics: z.array(archiveDiagnosticSchema).optional(),
  })
  .strict();

const archiveRevisionSummarySchema = z
  .object({
    revisionId: archiveIdSchema,
    stateHash: archiveStateHashSchema,
  })
  .strict();

/** 成功提交的动态表示；重复请求仍由当前归档数据生成响应。 */
export const archiveCommitSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      commitId: archiveIdSchema,
      archiveSeq: archiveSequenceSchema,
      binId: binIdSchema,
      runId: nonEmptyText.max(128).optional(),
      collectorVersion: nonEmptyText.max(256).optional(),
      observedAt: timestampSchema,
      recordedAt: timestampSchema,
      items: z.array(archiveCommitItemSchema),
      relations: z.array(archiveCommitRelationSchema),
      gaps: archiveCommitGapsSchema.optional(),
    })
    .strict(),
);

export const archiveItemDeletionResultSchema = z
  .object({
    itemId: archiveIdSchema,
    /** 包含输入条目的完整删除集合，按条目 ID 排序。 */
    deletedItemIds: z.array(archiveIdSchema).min(1),
    deletionSeq: archiveSnapshotSequenceSchema,
    deleted: z.literal(true),
  })
  .strict();

/** 条目读取固定归档截点，并返回该点各 bin 的 current、版本与观察。 */
export const archiveItemReadSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      itemId: archiveIdSchema,
      sourceKey: sourceKeySchema,
      snapshot: archiveSnapshotSchema,
      views: z.array(archiveViewSchema),
      revisions: z.array(archiveRevisionSummarySchema),
      observations: z.array(archiveObservationSchema),
    })
    .strict(),
);

export const archiveRevisionReadSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      revisionId: archiveIdSchema,
      itemId: archiveIdSchema,
      sourceKey: sourceKeySchema,
      stateHash: archiveStateHashSchema,
      state: archiveItemStateSchema,
    })
    .strict(),
);

export const archiveErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "invalid_input",
          "bin_not_found",
          "check_run_archive_forbidden",
          "archive_request_conflict",
          "item_not_found",
          "item_deleted",
          "revision_not_found",
          "resource_not_found",
          "resource_storage_unavailable",
          "commit_not_found",
          "query_budget_exceeded",
          "relation_not_found",
          "relation_endpoint_conflict",
        ]),
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .strict(),
  })
  .strict();

export type ArchiveCommit = z.infer<typeof archiveCommitSchema>;
export type ArchiveCommitRelation = z.infer<typeof archiveCommitRelationSchema>;
export type ArchiveItemDeletionResult = z.infer<
  typeof archiveItemDeletionResultSchema
>;
export type ArchiveItemRead = z.infer<typeof archiveItemReadSchema>;
export type ArchiveRevisionRead = z.infer<typeof archiveRevisionReadSchema>;
export type ArchiveError = z.infer<typeof archiveErrorSchema>["error"];

export const archiveSearchFieldSchema = z.enum([
  "sourceKey.namespace",
  "sourceKey.key",
  "sourceRef",
  "sourceModifiedAt",
  "capture.completeness",
  "body.searchText",
  "binId",
  "runId",
  "collectorVersion",
  "observedAt",
  "recordedAt",
]);
export type ArchiveSearchField = z.infer<typeof archiveSearchFieldSchema>;

/** 正文条件只匹配采集器提供的 searchText；正则使用 PostgreSQL ARE。 */
export const archiveSearchTextSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("literal"),
      value: postgresTextSchema
        .min(1)
        .max(1024, "字面检索词不能超过 1024 个字符。")
        .describe("在 searchText 中按大小写敏感的字面子串匹配。"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("regex"),
      pattern: postgresTextSchema
        .min(1)
        .max(512, "正则表达式不能超过 512 个字符。")
        .describe("PostgreSQL ARE 正则表达式；原样执行，默认区分大小写。"),
    })
    .strict(),
]);
export type ArchiveSearchText = z.infer<typeof archiveSearchTextSchema>;

const archiveSearchJsonFieldSchema = z.enum(["metadata", "properties"]);
const archiveSearchJsonPathSchema = z
  .array(
    z.union([postgresTextSchema, z.number().int().min(0).max(2_147_483_647)]),
  )
  .max(16)
  .describe(
    "JSON 路径使用对象键字符串或数组下标数字；空路径表示整个自定义字段。",
  );
const archiveSearchJsonValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "null",
  "array",
  "object",
]);
const archiveSearchJsonOperatorSchema = z.enum([
  "exists",
  "eq",
  "ne",
  "in",
  "notIn",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
]);

type ArchiveSearchJsonValueType = z.infer<
  typeof archiveSearchJsonValueTypeSchema
>;
type ArchiveSearchJsonPathSegment = z.infer<
  typeof archiveSearchJsonPathSchema
>[number];
export type ArchiveSearchJsonProjection = {
  readonly type: "json";
  readonly field: z.infer<typeof archiveSearchJsonFieldSchema>;
  readonly path: ArchiveSearchJsonPathSegment[];
};

export type ArchiveSearchJsonFilter = {
  readonly type: "json";
  readonly field: z.infer<typeof archiveSearchJsonFieldSchema>;
  readonly path: ArchiveSearchJsonPathSegment[];
  readonly operator: z.infer<typeof archiveSearchJsonOperatorSchema>;
  readonly valueType?: ArchiveSearchJsonValueType | undefined;
  readonly value?: unknown;
  readonly values?: unknown[] | undefined;
  readonly lower?: unknown;
  readonly upper?: unknown;
};

function matchesArchiveJsonType(
  value: unknown,
  valueType: ArchiveSearchJsonValueType,
): boolean {
  switch (valueType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
  }
}

const archiveSearchJsonFilterSchema = z
  .object({
    type: z.literal("json"),
    field: archiveSearchJsonFieldSchema,
    path: archiveSearchJsonPathSchema,
    operator: archiveSearchJsonOperatorSchema,
    valueType: archiveSearchJsonValueTypeSchema.optional(),
    value: archiveJsonValueSchema.optional(),
    values: z.array(archiveJsonValueSchema).min(1).max(100).optional(),
    lower: archiveJsonValueSchema.optional(),
    upper: archiveJsonValueSchema.optional(),
  })
  .strict()
  .superRefine((filter, context) => {
    const hasValue = filter.value !== undefined;
    const hasValues = filter.values !== undefined;
    const hasBounds = filter.lower !== undefined || filter.upper !== undefined;
    if (filter.operator === "exists") {
      if (
        typeof filter.value !== "boolean" ||
        filter.valueType !== undefined ||
        hasValues ||
        hasBounds
      ) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "JSON 路径 exists 条件必须用布尔值说明路径是否存在。",
        });
      }
      return;
    }

    if (filter.valueType === undefined) {
      context.addIssue({
        code: "custom",
        path: ["valueType"],
        message: "JSON 路径比较必须声明预期 JSON 类型。",
      });
      return;
    }
    const valueType = filter.valueType;
    const requireTypedValue = (
      value: unknown,
      path: (string | number)[],
    ): void => {
      if (value !== undefined && !matchesArchiveJsonType(value, valueType)) {
        context.addIssue({
          code: "custom",
          path,
          message: "JSON 路径比较值与声明类型不一致。",
        });
      }
    };
    const operator = filter.operator;
    if (operator === "in" || operator === "notIn") {
      if (!hasValues || hasValue || hasBounds) {
        context.addIssue({
          code: "custom",
          path: ["values"],
          message: "JSON 路径集合条件必须提供 values 列表。",
        });
      } else {
        for (const [index, value] of (filter.values ?? []).entries()) {
          requireTypedValue(value, ["values", index]);
        }
      }
      return;
    }

    if (operator === "between") {
      if (
        !hasBounds ||
        filter.lower === undefined ||
        filter.upper === undefined ||
        hasValue ||
        hasValues
      ) {
        context.addIssue({
          code: "custom",
          path: ["lower"],
          message: "JSON 路径范围条件必须同时提供 lower 和 upper。",
        });
      } else {
        if (valueType !== "number" && valueType !== "string") {
          context.addIssue({
            code: "custom",
            path: ["valueType"],
            message: "JSON 路径范围只支持 string 和 number 类型。",
          });
        }
        requireTypedValue(filter.lower, ["lower"]);
        requireTypedValue(filter.upper, ["upper"]);
        if (
          valueType === "number" &&
          typeof filter.lower === "number" &&
          typeof filter.upper === "number" &&
          filter.lower > filter.upper
        ) {
          context.addIssue({
            code: "custom",
            path: ["upper"],
            message: "JSON 数值范围上界不能早于下界。",
          });
        }
      }
      return;
    }

    if (!hasValue || hasValues || hasBounds) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "JSON 路径比较条件必须提供单个 value。",
      });
      return;
    }
    requireTypedValue(filter.value, ["value"]);
    if (
      (operator === "gt" ||
        operator === "gte" ||
        operator === "lt" ||
        operator === "lte") &&
      valueType !== "number" &&
      valueType !== "string"
    ) {
      context.addIssue({
        code: "custom",
        path: ["valueType"],
        message: "JSON 路径范围只支持 string 和 number 类型。",
      });
    }
  });

export type ArchiveSearchFieldFilter = {
  readonly type: "field";
  readonly field: ArchiveSearchField;
  readonly operator:
    | "exists"
    | "eq"
    | "ne"
    | "in"
    | "notIn"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "between";
  readonly value?: string | boolean | undefined;
  readonly values?: string[] | undefined;
  readonly lower?: string | undefined;
  readonly upper?: string | undefined;
};

type ArchiveSearchScalarFilter =
  | { readonly type: "text"; readonly text: ArchiveSearchText }
  | ArchiveSearchJsonFilter
  | ArchiveSearchFieldFilter;

export type ArchiveSearchTargetFilter =
  | { readonly type: "and"; readonly conditions: ArchiveSearchTargetFilter[] }
  | { readonly type: "or"; readonly conditions: ArchiveSearchTargetFilter[] }
  | { readonly type: "not"; readonly condition: ArchiveSearchTargetFilter }
  | ArchiveSearchScalarFilter;

export type ArchiveSearchRelationCount = {
  /** 统计不同目标条目或源引用；多个关系指向同一目标只计一次。 */
  readonly operator: "eq" | "gt" | "gte" | "lt" | "lte";
  readonly value: number;
};

export type ArchiveSearchRelationFilter = {
  readonly type: "relation";
  readonly direction: "outgoing" | "incoming" | "either";
  readonly name?: string | undefined;
  readonly properties?: ArchiveSearchJsonFilter | undefined;
  readonly target?: ArchiveSearchTargetFilter | undefined;
  readonly operator: "exists" | "notExists" | "count";
  readonly count?: ArchiveSearchRelationCount | undefined;
};

export type ArchiveSearchFilter =
  | { readonly type: "and"; readonly conditions: ArchiveSearchFilter[] }
  | { readonly type: "or"; readonly conditions: ArchiveSearchFilter[] }
  | { readonly type: "not"; readonly condition: ArchiveSearchFilter }
  | ArchiveSearchScalarFilter
  | ArchiveSearchRelationFilter;

export const archiveSearchOrderFieldSchema = z.enum([
  "itemId",
  "sourceKey.namespace",
  "sourceKey.key",
  "sourceRef",
  "sourceModifiedAt",
  "capture.completeness",
  "binId",
  "revisionId",
  "archiveSeq",
  "runId",
  "collectorVersion",
  "observedAt",
  "recordedAt",
  "metadata",
  "properties",
]);

const archiveSearchOrderBySchema = z
  .array(
    z
      .object({
        field: archiveSearchOrderFieldSchema,
        path: archiveSearchJsonPathSchema.optional(),
        valueType: z.enum(["string", "number", "boolean"]).optional(),
        direction: z.enum(["asc", "desc"]).default("asc"),
      })
      .strict()
      .superRefine((item, context) => {
        const customJsonField =
          item.field === "metadata" || item.field === "properties";
        if (
          customJsonField &&
          (item.path === undefined || item.valueType === undefined)
        ) {
          context.addIssue({
            code: "custom",
            path: [item.path === undefined ? "path" : "valueType"],
            message:
              "JSON 路径排序必须声明路径和预期 string、number 或 boolean 类型。",
          });
        } else if (
          !customJsonField &&
          (item.path !== undefined || item.valueType !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            path: ["path"],
            message: "内置字段排序不能声明 JSON 路径或 JSON 类型。",
          });
        }
      }),
  )
  .min(1)
  .max(5)
  .default([{ field: "itemId", direction: "asc" }])
  .superRefine((orderBy, context) => {
    const fields = new Set<string>();
    for (const [index, item] of orderBy.entries()) {
      const field =
        item.path === undefined
          ? item.field
          : item.field + ":" + JSON.stringify(item.path);
      if (fields.has(field)) {
        context.addIssue({
          code: "custom",
          path: [index, item.path === undefined ? "field" : "path"],
          message: "排序字段不能重复。",
        });
      }
      fields.add(field);
    }
  });

const archiveSearchProjectionSchema = z
  .array(
    z.union([
      z.enum([
        "sourceKey",
        "sourceRef",
        "sourceModifiedAt",
        "capture.completeness",
        "runId",
        "collectorVersion",
        "observedAt",
        "recordedAt",
        "hit.context",
      ]),
      z
        .object({
          type: z.literal("json"),
          field: archiveSearchJsonFieldSchema,
          path: archiveSearchJsonPathSchema,
        })
        .strict(),
    ]),
  )
  .max(25)
  .default([
    "sourceKey",
    "sourceRef",
    "sourceModifiedAt",
    "capture.completeness",
    "runId",
    "collectorVersion",
    "observedAt",
    "recordedAt",
    "hit.context",
  ])
  .superRefine((fields, context) => {
    const selectors = new Set<string>();
    for (const [index, item] of fields.entries()) {
      const selector =
        typeof item === "string"
          ? item
          : "json:" + item.field + ":" + JSON.stringify(item.path);
      if (selectors.has(selector)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "投影字段不能重复。",
        });
      }
      selectors.add(selector);
    }
  });

const archiveSearchFieldFilterSchema = z
  .object({
    type: z.literal("field"),
    field: archiveSearchFieldSchema,
    operator: z.enum([
      "exists",
      "eq",
      "ne",
      "in",
      "notIn",
      "gt",
      "gte",
      "lt",
      "lte",
      "between",
    ]),
    value: z.union([postgresTextSchema, z.boolean()]).optional(),
    values: z.array(postgresTextSchema).min(1).max(100).optional(),
    lower: postgresTextSchema.optional(),
    upper: postgresTextSchema.optional(),
  })
  .strict()
  .superRefine((filter, context) => {
    const hasValues = filter.value !== undefined;
    const hasList = filter.values !== undefined;
    const hasBounds = filter.lower !== undefined || filter.upper !== undefined;
    if (filter.operator === "exists") {
      if (typeof filter.value !== "boolean" || hasList || hasBounds) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "exists 条件必须用布尔值说明字段是否存在。",
        });
      }
      return;
    }
    if (filter.operator === "in" || filter.operator === "notIn") {
      if (!hasList || hasValues || hasBounds) {
        context.addIssue({
          code: "custom",
          path: ["values"],
          message: "集合条件必须提供 values 列表。",
        });
      }
    } else if (filter.operator === "between") {
      if (
        filter.lower === undefined ||
        filter.upper === undefined ||
        hasValues ||
        hasList
      ) {
        context.addIssue({
          code: "custom",
          path: ["lower"],
          message: "范围条件必须同时提供 lower 和 upper。",
        });
      }
    } else if (typeof filter.value !== "string" || hasList || hasBounds) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "比较条件必须提供字符串 value。",
      });
    }

    if (
      filter.field === "capture.completeness" &&
      (filter.value !== undefined || filter.values !== undefined || hasBounds)
    ) {
      const values = [
        ...(typeof filter.value === "string" ? [filter.value] : []),
        ...(filter.values ?? []),
        ...(filter.lower === undefined ? [] : [filter.lower]),
        ...(filter.upper === undefined ? [] : [filter.upper]),
      ];
      if (values.some((value) => value !== "complete" && value !== "partial")) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "完整性只能是 complete 或 partial。",
        });
      }
    }

    if (
      filter.field === "sourceModifiedAt" ||
      filter.field === "observedAt" ||
      filter.field === "recordedAt"
    ) {
      const dateValues = [
        ...(typeof filter.value === "string" ? [filter.value] : []),
        ...(filter.values ?? []),
        ...(filter.lower === undefined ? [] : [filter.lower]),
        ...(filter.upper === undefined ? [] : [filter.upper]),
      ];
      for (const value of dateValues) {
        if (!timestampSchema.safeParse(value).success) {
          context.addIssue({
            code: "custom",
            path: ["value"],
            message: "时间条件必须是带时区的 ISO 日期时间。",
          });
          break;
        }
      }
      if (
        filter.operator === "between" &&
        filter.lower !== undefined &&
        filter.upper !== undefined &&
        Date.parse(filter.lower) > Date.parse(filter.upper)
      ) {
        context.addIssue({
          code: "custom",
          path: ["upper"],
          message: "范围上界不能早于下界。",
        });
      }
    }
  });

const archiveSearchScalarFilterSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: archiveSearchTextSchema,
    })
    .strict(),
  archiveSearchFieldFilterSchema,
  archiveSearchJsonFilterSchema,
]);

const archiveSearchTargetFilterNodeSchema: z.ZodType<ArchiveSearchTargetFilter> =
  z.lazy(() =>
    z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("and"),
          conditions: z
            .array(archiveSearchTargetFilterNodeSchema)
            .min(1)
            .max(16),
        })
        .strict(),
      z
        .object({
          type: z.literal("or"),
          conditions: z
            .array(archiveSearchTargetFilterNodeSchema)
            .min(1)
            .max(16),
        })
        .strict(),
      z
        .object({
          type: z.literal("not"),
          condition: archiveSearchTargetFilterNodeSchema,
        })
        .strict(),
      archiveSearchScalarFilterSchema,
    ]),
  );

const archiveSearchRelationCountSchema = z
  .object({
    operator: z.enum(["eq", "gt", "gte", "lt", "lte"]),
    value: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .describe("按不同目标条目或源引用计数；多条关系指向同一目标只计一次。");

const archiveSearchRelationPropertiesFilterSchema =
  archiveSearchJsonFilterSchema.superRefine((filter, context) => {
    if (filter.field !== "properties") {
      context.addIssue({
        code: "custom",
        path: ["field"],
        message: "关系属性条件的 field 必须是 properties。",
      });
    }
  });

const archiveSearchRelationFilterSchema = z
  .object({
    type: z.literal("relation"),
    direction: z.enum(["outgoing", "incoming", "either"]),
    name: postgresTextSchema.min(1).max(256).optional(),
    properties: archiveSearchRelationPropertiesFilterSchema.optional(),
    target: archiveSearchTargetFilterNodeSchema.optional(),
    operator: z.enum(["exists", "notExists", "count"]),
    count: archiveSearchRelationCountSchema.optional(),
  })
  .strict()
  .superRefine((filter, context) => {
    if (filter.operator === "count" && filter.count === undefined) {
      context.addIssue({
        code: "custom",
        path: ["count"],
        message: "关系数量条件必须声明比较符和值。",
      });
    } else if (filter.operator !== "count" && filter.count !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["count"],
        message: "只有 count 条件可以声明数量比较。",
      });
    }
  });

const archiveSearchExpansionInputSchema = z
  .array(
    z
      .object({
        key: nonEmptyText.max(128),
        direction: z.enum(["outgoing", "incoming", "either"]),
        name: postgresTextSchema.min(1).max(256).optional(),
        properties: archiveSearchRelationPropertiesFilterSchema.optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe(
            "每个根条目来源视图返回的关系明细上限；hasMore 提示仍有未返回项。",
          ),
      })
      .strict(),
  )
  .max(8)
  .describe("独立选择至多 8 种关系展开；hasMore 没有对应的展开续页游标。")
  .superRefine((expansions, context) => {
    const keys = new Set<string>();
    for (const [index, expansion] of expansions.entries()) {
      if (keys.has(expansion.key)) {
        context.addIssue({
          code: "custom",
          path: [index, "key"],
          message: "关系展开 key 不能重复。",
        });
      }
      keys.add(expansion.key);
    }
  });

const archiveSearchFilterNodeSchema: z.ZodType<ArchiveSearchFilter> = z.lazy(
  () =>
    z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("and"),
          conditions: z.array(archiveSearchFilterNodeSchema).min(1).max(16),
        })
        .strict(),
      z
        .object({
          type: z.literal("or"),
          conditions: z.array(archiveSearchFilterNodeSchema).min(1).max(16),
        })
        .strict(),
      z
        .object({
          type: z.literal("not"),
          condition: archiveSearchFilterNodeSchema,
        })
        .strict(),
      archiveSearchScalarFilterSchema,
      archiveSearchRelationFilterSchema,
    ]),
);

/** 字段逻辑对当前所选视图求值；缺失值不匹配比较，not 对 false 求补。 */
export const archiveSearchFilterSchema = withArchiveJsonSchemaProjection(
  archiveSearchFilterNodeSchema.superRefine((filter, context) => {
    let nodeCount = 0;
    const visitTarget = (
      node: ArchiveSearchTargetFilter,
      depth: number,
    ): void => {
      nodeCount += 1;
      if (depth > 8 || nodeCount > 64) return;
      if (node.type === "and" || node.type === "or") {
        for (const condition of node.conditions)
          visitTarget(condition, depth + 1);
      } else if (node.type === "not") {
        visitTarget(node.condition, depth + 1);
      }
    };
    const visit = (node: ArchiveSearchFilter, depth: number): void => {
      nodeCount += 1;
      if (depth > 8 || nodeCount > 64) return;
      if (node.type === "and" || node.type === "or") {
        for (const condition of node.conditions) visit(condition, depth + 1);
      } else if (node.type === "not") {
        visit(node.condition, depth + 1);
      } else if (node.type === "relation" && node.target !== undefined) {
        visitTarget(node.target, depth + 1);
      }
    };
    visit(filter, 1);
    if (nodeCount > 64) {
      context.addIssue({
        code: "custom",
        message: "查询条件不能超过 64 个节点。",
      });
    } else if (nodeCount > 0 && filterDepth(filter) > 8) {
      context.addIssue({
        code: "custom",
        message: "查询条件嵌套深度不能超过 8 层。",
      });
    }
  }),
);

function filterDepth(filter: ArchiveSearchFilter): number {
  if (filter.type === "and" || filter.type === "or") {
    return 1 + Math.max(...filter.conditions.map(filterDepth));
  }
  if (filter.type === "not") return 1 + filterDepth(filter.condition);
  if (filter.type === "relation" && filter.target !== undefined) {
    return 1 + targetFilterDepth(filter.target);
  }
  return 1;
}

function targetFilterDepth(filter: ArchiveSearchTargetFilter): number {
  if (filter.type === "and" || filter.type === "or") {
    return 1 + Math.max(...filter.conditions.map(targetFilterDepth));
  }
  return filter.type === "not" ? 1 + targetFilterDepth(filter.condition) : 1;
}

/**
 * 字段和文本谓词在同一来源视图与截点求值。当前/asOf 每个 bin 取最新观察；
 * revisions 每 bin 每版本取最新观察，observations 按每次观察匹配。未指定 bin 时，
 * current/asOf 结果以 item 为根，历史结果按所选单位分组。多视图排序值来自命中结果
 * 中 binId 按 C 排序最小的一项；null 置末尾，同值按结果标识升序。
 * 顶层 text 与 where 中的 text 节点使用相同的逻辑树，顶层 text 等价于 AND 条件。
 * expand 最多声明 8 个选择器，为每个返回 match/bin 独立读取关系：默认每个选择器最多 20 条，最大 100 条，
 * 按 relationId 的 C 顺序排列；hasMore 表示还有未返回明细，本契约没有展开续页游标。
 * 展开上限只约束返回明细，不限制根匹配、exists/count 等过滤使用的完整集合。观察到的
 * 关系可带同 bin/K 下未知目标端点；撤回和硬删除缺口分别返回状态与删除提交依据，
 * 不借用其他 bin 补资料。游标固定首屏 snapshot 并绑定查询；budgetMs 限制每条
 * PostgreSQL 搜索语句，超时返回 422 且不返回部分结果。无 text 与 where 的空查询无效。
 */
export const archiveSearchInputSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      scope: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("current"),
            binId: binIdSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("asOf"),
            binId: binIdSchema.optional(),
            asOf: archiveSnapshotSequenceSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("revisions"),
            binId: binIdSchema.optional(),
            asOf: archiveSnapshotSequenceSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("observations"),
            binId: binIdSchema.optional(),
            asOf: archiveSnapshotSequenceSchema.optional(),
          })
          .strict(),
      ]),
      text: archiveSearchTextSchema.optional(),
      where: archiveSearchFilterSchema.optional(),
      expand: archiveSearchExpansionInputSchema
        .optional()
        .describe("按每个命中来源视图独立返回有界关系明细；不改变根筛选结果。"),
      select: archiveSearchProjectionSchema,
      orderBy: archiveSearchOrderBySchema,
      limit: z.number().int().min(1).max(100).default(50),
      cursor: postgresTextSchema.min(1).max(4096).optional(),
      budgetMs: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .default(1_000)
        .describe("每条 PostgreSQL 搜索与展开语句的超时预算（毫秒）。"),
    })
    .strict()
    .superRefine((input, context) => {
      if (input.text === undefined && input.where === undefined) {
        context.addIssue({
          code: "custom",
          path: ["where"],
          message: "搜索请求至少需要正文条件或字段条件。",
        });
      }
    }),
);

const archiveSearchHitSchema = z
  .object({
    field: z.literal("body.searchText"),
    representation: z.literal("searchText"),
    position: z
      .object({
        encoding: z.literal("unicode-code-point"),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict(),
    context: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: postgresTextSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const archiveSearchJsonProjectionResultSchema = z.discriminatedUnion(
  "exists",
  [
    z
      .object({
        field: archiveSearchJsonFieldSchema,
        path: archiveSearchJsonPathSchema,
        exists: z.literal(true),
        value: archiveJsonValueSchema,
      })
      .strict(),
    z
      .object({
        field: archiveSearchJsonFieldSchema,
        path: archiveSearchJsonPathSchema,
        exists: z.literal(false),
      })
      .strict(),
  ],
);
export type ArchiveSearchJsonProjectionResult = z.infer<
  typeof archiveSearchJsonProjectionResultSchema
>;

const archiveSearchExpandedItemEndpointSchema = z
  .object({
    kind: z.literal("item"),
    itemId: archiveIdentifierSchema,
    sourceKey: sourceKeySchema,
    status: z.enum(["observed", "unknown"]),
    revisionId: archiveIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((endpoint, context) => {
    if (endpoint.status === "observed" && endpoint.revisionId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["revisionId"],
        message: "已观察对象必须关联内容版本。",
      });
    }
    if (endpoint.status === "unknown" && endpoint.revisionId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["revisionId"],
        message: "未知对象视图不能关联内容版本。",
      });
    }
  });

const archiveSearchExpandedEndpointSchema = z.discriminatedUnion("kind", [
  archiveSearchExpandedItemEndpointSchema,
  z
    .object({
      kind: z.literal("sourceRef"),
      sourceRef: nonEmptyText.max(4096),
    })
    .strict(),
]);

const archiveSearchExpansionObservationSchema = z
  .object({
    commitId: archiveIdentifierSchema,
    archiveSeq: archiveSequenceSchema,
    ordinal: z.number().int().nonnegative(),
    observedAt: timestampSchema,
    recordedAt: timestampSchema,
    runId: nonEmptyText.max(128).optional(),
    collectorVersion: nonEmptyText.max(256).optional(),
  })
  .strict();

const archiveSearchExpansionRelationSchema = withArchiveJsonSchemaProjection(
  z.union([
    z
      .object({
        relationId: nonEmptyText.max(256),
        direction: z.enum(["outgoing", "incoming"]),
        status: z.literal("observed"),
        from: archiveSearchExpandedItemEndpointSchema,
        to: archiveSearchExpandedEndpointSchema,
        revisionId: archiveIdentifierSchema,
        state: archiveRelationStateSchema,
        observation: archiveSearchExpansionObservationSchema,
      })
      .strict(),
    z
      .object({
        relationId: nonEmptyText.max(256),
        direction: z.enum(["outgoing", "incoming"]),
        status: z.literal("withdrawn"),
        from: archiveSearchExpandedItemEndpointSchema,
        to: archiveSearchExpandedEndpointSchema,
        observation: archiveSearchExpansionObservationSchema,
      })
      .strict(),
    z
      .object({
        relationId: nonEmptyText.max(256),
        direction: z.enum(["outgoing", "incoming"]),
        status: z.literal("deleted"),
        observation: archiveSearchExpansionObservationSchema,
      })
      .strict(),
  ]),
);

const archiveSearchExpansionResultSchema = z
  .object({
    key: nonEmptyText.max(128),
    direction: z.enum(["outgoing", "incoming", "either"]),
    name: postgresTextSchema.min(1).max(256).optional(),
    relations: z.array(archiveSearchExpansionRelationSchema),
    hasMore: z
      .boolean()
      .describe("当前限额之外仍有关系明细；本查询契约不提供展开续页游标。"),
  })
  .strict();

const archiveSearchMatchSchema = z
  .object({
    binId: binIdSchema,
    revisionId: archiveIdentifierSchema,
    archiveSeq: archiveSequenceSchema,
    sourceRef: postgresTextSchema.optional(),
    sourceModifiedAt: timestampSchema.optional(),
    completeness: z.enum(["complete", "partial"]).optional(),
    observedAt: timestampSchema.optional(),
    recordedAt: timestampSchema.optional(),
    runId: nonEmptyText.max(128).optional(),
    collectorVersion: nonEmptyText.max(256).optional(),
    hit: archiveSearchHitSchema.optional(),
    json: z.array(archiveSearchJsonProjectionResultSchema).optional(),
    expansions: z.array(archiveSearchExpansionResultSchema).optional(),
  })
  .strict();

const archiveSearchResultSchema = z
  .object({
    resultId: nonEmptyText.max(128),
    itemId: archiveIdentifierSchema,
    sourceKey: sourceKeySchema.optional(),
    revisionId: archiveIdentifierSchema.optional(),
    commitId: archiveIdentifierSchema.optional(),
    ordinal: z.number().int().nonnegative().optional(),
    matches: z.array(archiveSearchMatchSchema).min(1),
  })
  .strict();

/**
 * item resultId 等于 itemId；revision 为 itemId:revisionId；observation 为 commitId:ordinal。
 * 每个 matches 项对应真实 bin 视图。只有该视图满足正向正文条件时才返回 hit；位置为
 * searchText 中零起始、左闭右开的 Unicode 码点偏移。投影启用 hit.context 时，上下文
 * 起止同样使用码点偏移，命中左右各最多 80 码点。
 */
export const archiveSearchPageSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      unit: z.enum(["item", "revision", "observation"]),
      snapshot: archiveSnapshotSchema,
      results: z.array(archiveSearchResultSchema),
      nextCursor: z.string().min(1).max(4096).optional(),
    })
    .strict(),
);

export type ArchiveSearchInput = z.infer<typeof archiveSearchInputSchema>;
export type ArchiveSearchRequest = z.input<typeof archiveSearchInputSchema>;
export type ArchiveSearchPage = z.infer<typeof archiveSearchPageSchema>;
export type ArchiveSearchOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 422;
      readonly error: ArchiveError;
    };

export type ArchiveReadOptions = {
  readonly binId?: z.infer<typeof binIdSchema>;
  readonly asOf?: z.infer<typeof archiveSnapshotSequenceSchema>;
};
export type ArchiveOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 409 | 503;
      readonly error: ArchiveError;
    };
export type ArchiveOperations = {
  submitArchive(
    input: ArchiveSubmissionInput,
  ): Promise<ArchiveOperation<ArchiveCommit>>;
  /** 删除输入条目及沿各 bin 当前未撤回级联声明并集可达的对象；结果按 ID 排序并包含输入条目。 */
  deleteArchiveItem(
    itemId: string,
  ): Promise<ArchiveOperation<ArchiveItemDeletionResult>>;
  uploadArchiveResource(
    body: ReadableStream<Uint8Array>,
    mediaType: string,
  ): Promise<ArchiveOperation<ArchiveResourceMetadata>>;
  getArchiveResource(resourceId: string): Promise<
    ArchiveOperation<{
      readonly metadata: ArchiveResourceMetadata;
      readonly body: ReadableStream<Uint8Array>;
    }>
  >;
  getArchiveItem(
    itemId: string,
    options?: ArchiveReadOptions,
  ): Promise<ArchiveOperation<ArchiveItemRead>>;
  getArchiveRevision(
    revisionId: string,
  ): Promise<ArchiveOperation<ArchiveRevisionRead>>;
  searchArchive(
    input: ArchiveSearchRequest,
  ): Promise<ArchiveSearchOperation<ArchiveSearchPage>>;
} & ArchiveHistoryOperations &
  ArchiveRelationsOperations;
