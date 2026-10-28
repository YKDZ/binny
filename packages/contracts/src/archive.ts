import * as z from "zod";

import type { ArchiveHistoryOperations } from "./archive-history.ts";
import { binIdSchema } from "./bin-configuration.ts";

const nonEmptyText = z
  .string()
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

function validateJsonValue(
  value: unknown,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  ancestors: WeakSet<object>,
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
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
        validateJsonValue(nestedValue, context, [...path, key], ancestors);
      }
    }
  }
  ancestors.delete(value);
}

const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .superRefine((object, context) => {
    const ancestors = new WeakSet<object>([object]);
    for (const [key, value] of Object.entries(object)) {
      validateJsonValue(value, context, [key], ancestors);
    }
  });

const archiveBodySchema = z
  .object({
    html: z.string().optional(),
    markdown: z.string().optional(),
    text: z.string().optional(),
    searchText: z.string().optional(),
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
export const archiveItemStateSchema = archiveItemFieldsSchema.refine(
  hasReceivedMaterial,
  {
    path: ["body"],
    message: "没有取得资料时不能创建空内容版本。",
  },
);

/** 单对象提交必须携带稳定信源键，不能从正文推测身份。 */
export const archiveItemInputSchema = archiveItemFieldsSchema
  .extend({
    sourceKey: sourceKeySchema,
    diagnostics: z.array(archiveDiagnosticSchema).optional(),
  })
  .strict()
  .refine(hasReceivedMaterial, {
    path: ["body"],
    message: "没有取得资料时不能创建空内容版本。",
  });

export type ArchiveItemState = z.infer<typeof archiveItemStateSchema>;
export type ArchiveItemInput = z.infer<typeof archiveItemInputSchema>;

/** 提交标识全局唯一；相同标识不得用于不同业务负载。 */
export const archiveSubmissionInputSchema = z
  .object({
    requestId: nonEmptyText.max(256, "请求标识不能超过 256 个字符。"),
    binId: binIdSchema,
    runId: nonEmptyText.max(128, "run 标识不能超过 128 个字符。").optional(),
    collectorVersion: nonEmptyText
      .max(256, "采集器版本不能超过 256 个字符。")
      .optional(),
    observedAt: timestampSchema.optional(),
    items: z.array(archiveItemInputSchema).min(1).max(100),
  })
  .strict()
  .superRefine((submission, context) => {
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
  });

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
export const archiveCommitSchema = z
  .object({
    commitId: archiveIdSchema,
    archiveSeq: archiveSequenceSchema,
    binId: binIdSchema,
    runId: nonEmptyText.max(128).optional(),
    collectorVersion: nonEmptyText.max(256).optional(),
    observedAt: timestampSchema,
    recordedAt: timestampSchema,
    items: z.array(archiveCommitItemSchema),
  })
  .strict();

/** 条目读取固定归档截点，并返回该点各 bin 的 current、版本与观察。 */
export const archiveItemReadSchema = z
  .object({
    itemId: archiveIdSchema,
    sourceKey: sourceKeySchema,
    snapshot: archiveSnapshotSchema,
    views: z.array(archiveViewSchema),
    revisions: z.array(archiveRevisionSummarySchema),
    observations: z.array(archiveObservationSchema),
  })
  .strict();

export const archiveRevisionReadSchema = z
  .object({
    revisionId: archiveIdSchema,
    itemId: archiveIdSchema,
    sourceKey: sourceKeySchema,
    stateHash: archiveStateHashSchema,
    state: archiveItemStateSchema,
  })
  .strict();

export const archiveErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "invalid_input",
          "bin_not_found",
          "archive_request_conflict",
          "item_not_found",
          "revision_not_found",
          "resource_not_found",
          "resource_storage_unavailable",
          "commit_not_found",
          "query_budget_exceeded",
        ]),
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .strict(),
  })
  .strict();

export type ArchiveCommit = z.infer<typeof archiveCommitSchema>;
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

export type ArchiveSearchFilter =
  | { readonly type: "and"; readonly conditions: ArchiveSearchFilter[] }
  | { readonly type: "or"; readonly conditions: ArchiveSearchFilter[] }
  | { readonly type: "not"; readonly condition: ArchiveSearchFilter }
  | {
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

export const archiveSearchOrderFieldSchema = z.enum([
  "itemId",
  "sourceKey.namespace",
  "sourceKey.key",
  "sourceModifiedAt",
  "binId",
  "revisionId",
  "archiveSeq",
  "runId",
  "collectorVersion",
  "observedAt",
  "recordedAt",
]);

const archiveSearchOrderBySchema = z
  .array(
    z
      .object({
        field: archiveSearchOrderFieldSchema,
        direction: z.enum(["asc", "desc"]).default("asc"),
      })
      .strict(),
  )
  .min(1)
  .max(5)
  .default([{ field: "itemId", direction: "asc" }])
  .superRefine((orderBy, context) => {
    const fields = new Set<string>();
    for (const [index, item] of orderBy.entries()) {
      if (fields.has(item.field)) {
        context.addIssue({
          code: "custom",
          path: [index, "field"],
          message: "排序字段不能重复。",
        });
      }
      fields.add(item.field);
    }
  });

const archiveSearchProjectionSchema = z
  .array(
    z.enum([
      "sourceKey",
      "sourceModifiedAt",
      "runId",
      "collectorVersion",
      "observedAt",
      "recordedAt",
      "hit.context",
    ]),
  )
  .max(7)
  .default([
    "sourceKey",
    "sourceModifiedAt",
    "runId",
    "collectorVersion",
    "observedAt",
    "recordedAt",
    "hit.context",
  ])
  .superRefine((fields, context) => {
    if (new Set(fields).size !== fields.length) {
      context.addIssue({
        code: "custom",
        message: "投影字段不能重复。",
      });
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
    value: z.union([z.string(), z.boolean()]).optional(),
    values: z.array(z.string()).min(1).max(100).optional(),
    lower: z.string().optional(),
    upper: z.string().optional(),
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
      archiveSearchFieldFilterSchema,
    ]),
);

/** 字段逻辑对当前所选视图求值；缺失值不匹配比较，not 对 false 求补。 */
export const archiveSearchFilterSchema =
  archiveSearchFilterNodeSchema.superRefine((filter, context) => {
    let nodeCount = 0;
    const visit = (node: ArchiveSearchFilter, depth: number): void => {
      nodeCount += 1;
      if (depth > 8 || nodeCount > 64) return;
      if (node.type === "and" || node.type === "or") {
        for (const condition of node.conditions) visit(condition, depth + 1);
      } else if (node.type === "not") {
        visit(node.condition, depth + 1);
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
  });

function filterDepth(filter: ArchiveSearchFilter): number {
  if (filter.type === "and" || filter.type === "or") {
    return 1 + Math.max(...filter.conditions.map(filterDepth));
  }
  return filter.type === "not" ? 1 + filterDepth(filter.condition) : 1;
}

/** 搜索正文仅使用采集器提交的 searchText，不把其他表示或 HTML 字节当作匹配位置。 */
export const archiveSearchInputSchema = z
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
    text: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("literal"),
          value: z
            .string()
            .min(1)
            .max(1024, "字面检索词不能超过 1024 个字符。"),
        })
        .strict(),
      z
        .object({
          kind: z.literal("regex"),
          pattern: z
            .string()
            .min(1)
            .max(512, "正则表达式不能超过 512 个字符。")
            .describe("PostgreSQL ARE 正则表达式；原样执行，默认区分大小写。"),
        })
        .strict(),
    ]),
    where: archiveSearchFilterSchema.optional(),
    select: archiveSearchProjectionSchema,
    orderBy: archiveSearchOrderBySchema,
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(4096).optional(),
    budgetMs: z.number().int().min(1).max(10_000).default(1_000),
  })
  .strict();

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
        text: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

const archiveSearchMatchSchema = z
  .object({
    binId: binIdSchema,
    revisionId: archiveIdentifierSchema,
    archiveSeq: archiveSequenceSchema,
    sourceModifiedAt: timestampSchema.optional(),
    observedAt: timestampSchema.optional(),
    recordedAt: timestampSchema.optional(),
    runId: nonEmptyText.max(128).optional(),
    collectorVersion: nonEmptyText.max(256).optional(),
    hit: archiveSearchHitSchema,
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

/** `select` 只裁剪可选字段；排序视图值取结果内 binId 的 C 排序首项，null 恒置末尾，同值按 resultId 升序。 */
export const archiveSearchPageSchema = z
  .object({
    unit: z.enum(["item", "revision", "observation"]),
    snapshot: archiveSnapshotSchema,
    results: z.array(archiveSearchResultSchema),
    nextCursor: z.string().min(1).max(4096).optional(),
  })
  .strict();

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
} & ArchiveHistoryOperations;
