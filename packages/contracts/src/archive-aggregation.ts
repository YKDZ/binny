import * as z from "zod";

import {
  archiveJsonValueSchema,
  archiveSearchFilterSchema,
  archiveSearchJsonPathSchema,
  archiveSearchPathStepSchema,
  archiveSearchScopeSchema,
  archiveSearchTextSchema,
  archiveSnapshotSchema,
  archiveSearchFieldSchema,
  withArchiveJsonSchemaProjection,
  type ArchiveError,
  type ArchiveSearchFilter,
  type ArchiveSearchPathStep,
  type ArchiveSearchScope,
  type ArchiveSearchText,
} from "./archive.ts";
import { postgresTextSchema } from "./postgres-text.ts";

const aggregationKeySchema = postgresTextSchema
  .min(1)
  .max(128)
  .refine((key) => key.trim().length > 0, "key 不能为空。");

const archiveAggregationUnitSchema = z.enum([
  "item",
  "revision",
  "observation",
  "relation",
]);

const archiveAggregationContentFieldSchema = z.union([
  archiveSearchFieldSchema,
  z.enum(["itemId", "revisionId", "commitId", "archiveSeq", "ordinal"]),
]);

const archiveAggregationRelationFieldSchema = z.enum([
  "relationId",
  "name",
  "cascade",
  "from.itemId",
  "to.itemId",
  "to.sourceRef",
  "binId",
  "runId",
  "sourceAdapterVersion",
  "observedAt",
  "recordedAt",
]);

const archiveAggregationFieldSchema = z.union([
  archiveAggregationContentFieldSchema,
  archiveAggregationRelationFieldSchema,
]);

const archiveAggregationTimeFieldSchema = z.enum([
  "sourceModifiedAt",
  "observedAt",
  "recordedAt",
]);

const archiveAggregationFieldSelectorSchema = z
  .object({
    type: z.literal("field"),
    field: archiveAggregationFieldSchema,
  })
  .strict();

const archiveAggregationJsonSelectorSchema = z
  .object({
    type: z.literal("json"),
    field: z.enum(["metadata", "properties"]),
    path: archiveSearchJsonPathSchema,
  })
  .strict();

const archiveAggregationTimeBucketSelectorSchema = z
  .object({
    type: z.literal("timeBucket"),
    field: archiveAggregationTimeFieldSchema,
    grain: z.enum(["day", "week", "month"]),
    timeZone: postgresTextSchema.min(1).max(256),
  })
  .strict()
  .describe("按声明时区的日历边界分桶，周从 ISO 周一开始。");

const archiveAggregationGroupSelectorSchema = z.discriminatedUnion("type", [
  archiveAggregationFieldSelectorSchema,
  archiveAggregationJsonSelectorSchema,
  archiveAggregationTimeBucketSelectorSchema,
]);

const archiveAggregationGroupingSchema = z.intersection(
  z.object({ key: aggregationKeySchema }).strict(),
  archiveAggregationGroupSelectorSchema,
);

const archiveAggregationDistinctSelectorSchema = z.discriminatedUnion("type", [
  archiveAggregationFieldSelectorSchema,
  z
    .object({
      type: z.literal("json"),
      field: z.enum(["metadata", "properties"]),
      path: archiveSearchJsonPathSchema,
      valueType: z
        .enum(["boolean", "number", "string", "array", "object"])
        .optional(),
    })
    .strict(),
]);

const archiveAggregationNumericSelectorSchema = z
  .object({
    type: z.literal("json"),
    field: z.enum(["metadata", "properties"]),
    path: archiveSearchJsonPathSchema,
    valueType: z.literal("number"),
  })
  .strict();

const archiveAggregationCountMetricSchema = z
  .object({
    key: aggregationKeySchema,
    op: z.literal("count"),
  })
  .strict();

const archiveAggregationDistinctMetricSchema = z
  .object({
    key: aggregationKeySchema,
    op: z.literal("distinct"),
    value: archiveAggregationDistinctSelectorSchema,
  })
  .strict();

const archiveAggregationNumericMetricSchema = z
  .object({
    key: aggregationKeySchema,
    op: z.enum(["sum", "avg", "min", "max"]),
    value: archiveAggregationNumericSelectorSchema,
  })
  .strict();

const archiveAggregationMetricSchema = z
  .discriminatedUnion("op", [
    archiveAggregationCountMetricSchema,
    archiveAggregationDistinctMetricSchema,
    archiveAggregationNumericMetricSchema,
  ])
  .describe(
    "count 统计组内去重单位；distinct 不计 JSON null 和缺失；数值指标只对 JSON number 使用 PostgreSQL numeric，不经 JavaScript Number。",
  );

const archiveAggregationDecimalSchema = postgresTextSchema
  .min(1)
  .max(500)
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u, "必须是有限十进制数。");

export type ArchiveAggregationHaving =
  | {
      readonly type: "and";
      readonly conditions: ArchiveAggregationHaving[];
    }
  | {
      readonly type: "or";
      readonly conditions: ArchiveAggregationHaving[];
    }
  | {
      readonly type: "not";
      readonly condition: ArchiveAggregationHaving;
    }
  | {
      readonly type: "metric";
      readonly metric: string;
      readonly operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      readonly value: string;
    }
  | {
      readonly type: "metric";
      readonly metric: string;
      readonly operator: "isNull" | "isNotNull";
    };

const archiveAggregationHavingNodeSchema: z.ZodType<
  ArchiveAggregationHaving,
  ArchiveAggregationHaving
> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal("and"),
        conditions: z.array(archiveAggregationHavingNodeSchema).min(1).max(16),
      })
      .strict(),
    z
      .object({
        type: z.literal("or"),
        conditions: z.array(archiveAggregationHavingNodeSchema).min(1).max(16),
      })
      .strict(),
    z
      .object({
        type: z.literal("not"),
        condition: archiveAggregationHavingNodeSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("metric"),
        metric: aggregationKeySchema,
        operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
        value: archiveAggregationDecimalSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("metric"),
        metric: aggregationKeySchema,
        operator: z.enum(["isNull", "isNotNull"]),
      })
      .strict(),
  ]),
);

const archiveAggregationHavingSchema = archiveAggregationHavingNodeSchema
  .optional()
  .describe("聚合完成后筛选完整分组；数值比较使用 PostgreSQL numeric。");

const archiveAggregationOrderBySchema = z
  .array(
    z
      .object({
        key: aggregationKeySchema,
        direction: z.enum(["asc", "desc"]),
      })
      .strict(),
  )
  .max(5)
  .default([]);

/**
 * 统计单位先由 scope 形成完整候选集合，再在每个分组内按单位身份去重。
 * 同一单位同组含多份来源视图时，取 binId 的 C 序最小视图；该视图所有指标共用。
 */
export const archiveAggregationInputSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      scope: archiveSearchScopeSchema,
      text: archiveSearchTextSchema.optional(),
      where: archiveSearchFilterSchema.optional(),
      unit: archiveAggregationUnitSchema,
      relations: archiveSearchPathStepSchema.optional(),
      groupBy: z.array(archiveAggregationGroupingSchema).max(5),
      metrics: z.array(archiveAggregationMetricSchema).min(1).max(10),
      having: archiveAggregationHavingSchema,
      orderBy: archiveAggregationOrderBySchema,
      limit: z.number().int().min(1).max(100).default(50),
      cursor: postgresTextSchema.min(1).max(4096).optional(),
      budgetMs: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .default(1_000)
        .describe("每条 PostgreSQL 查询语句的超时预算（毫秒）。"),
    })
    .strict()
    .superRefine((input, context) => {
      const groupKeys = new Set<string>();
      for (const [index, grouping] of input.groupBy.entries()) {
        if (groupKeys.has(grouping.key)) {
          context.addIssue({
            code: "custom",
            path: ["groupBy", index, "key"],
            message: "分组 key 不能重复。",
          });
        }
        groupKeys.add(grouping.key);
      }

      const metricKeys = new Set<string>();
      for (const [index, metric] of input.metrics.entries()) {
        if (metricKeys.has(metric.key)) {
          context.addIssue({
            code: "custom",
            path: ["metrics", index, "key"],
            message: "指标 key 不能重复。",
          });
        }
        metricKeys.add(metric.key);
      }
      for (const key of groupKeys) {
        if (metricKeys.has(key)) {
          context.addIssue({
            code: "custom",
            path: ["metrics"],
            message: "分组和指标 key 不能重名。",
          });
        }
      }

      const declaredKeys = new Set([...groupKeys, ...metricKeys]);
      const orderKeys = new Set<string>();
      for (const [index, order] of input.orderBy.entries()) {
        if (!declaredKeys.has(order.key)) {
          context.addIssue({
            code: "custom",
            path: ["orderBy", index, "key"],
            message: "排序 key 必须引用已声明的分组或指标。",
          });
        }
        if (orderKeys.has(order.key)) {
          context.addIssue({
            code: "custom",
            path: ["orderBy", index, "key"],
            message: "排序 key 不能重复。",
          });
        }
        orderKeys.add(order.key);
      }

      let havingNodes = 0;
      let depthReported = false;
      let nodeLimitReported = false;
      const visitHaving = (
        node: ArchiveAggregationHaving,
        path: (string | number)[],
        depth: number,
      ) => {
        if (depth > 8) {
          if (!depthReported) {
            depthReported = true;
            context.addIssue({
              code: "custom",
              path,
              message: "having 最多支持 8 层嵌套。",
            });
          }
          return;
        }
        havingNodes += 1;
        if (havingNodes > 64) {
          if (!nodeLimitReported) {
            nodeLimitReported = true;
            context.addIssue({
              code: "custom",
              path,
              message: "having 最多支持 64 个条件节点。",
            });
          }
          return;
        }
        if (node.type === "and" || node.type === "or") {
          for (const [index, condition] of node.conditions.entries()) {
            visitHaving(condition, [...path, "conditions", index], depth + 1);
          }
        } else if (node.type === "not") {
          visitHaving(node.condition, [...path, "condition"], depth + 1);
        } else if (!metricKeys.has(node.metric)) {
          context.addIssue({
            code: "custom",
            path: [...path, "metric"],
            message: "having 只能引用已声明的指标。",
          });
        }
      };
      if (input.having !== undefined) visitHaving(input.having, ["having"], 1);

      if (input.unit === "relation" && input.relations === undefined) {
        context.addIssue({
          code: "custom",
          path: ["relations"],
          message: "关系单位必须声明关系选择条件。",
        });
      } else if (input.unit !== "relation" && input.relations !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["relations"],
          message: "只有关系单位可以声明关系选择条件。",
        });
      }

      const relationOnlyFields = new Set([
        "relationId",
        "name",
        "cascade",
        "from.itemId",
        "to.itemId",
        "to.sourceRef",
      ]);
      const inspectSelector = (
        selector:
          | { readonly type: "field"; readonly field: string }
          | { readonly type: "json"; readonly field: "metadata" | "properties" }
          | {
              readonly type: "timeBucket";
              readonly field: "sourceModifiedAt" | "observedAt" | "recordedAt";
            },
        path: (string | number)[],
      ) => {
        if (input.unit === "relation") {
          if (
            selector.type === "field" &&
            !archiveAggregationRelationFieldSchema.safeParse(selector.field)
              .success
          ) {
            context.addIssue({
              code: "custom",
              path: [...path, "field"],
              message: "关系单位只能选择关系字段。",
            });
          }
          if (selector.type === "json" && selector.field !== "properties") {
            context.addIssue({
              code: "custom",
              path: [...path, "field"],
              message: "关系单位只能选择 properties JSON。",
            });
          }
          if (
            selector.type === "timeBucket" &&
            selector.field === "sourceModifiedAt"
          ) {
            context.addIssue({
              code: "custom",
              path: [...path, "field"],
              message: "关系单位不能按 sourceModifiedAt 分桶。",
            });
          }
        } else {
          if (
            selector.type === "field" &&
            relationOnlyFields.has(selector.field)
          ) {
            context.addIssue({
              code: "custom",
              path: [...path, "field"],
              message: "内容单位不能选择关系字段。",
            });
          }
          if (
            selector.type === "json" &&
            selector.field !== "metadata" &&
            selector.field !== "properties"
          ) {
            context.addIssue({
              code: "custom",
              path: [...path, "field"],
              message: "内容单位只能选择 metadata 或 properties JSON。",
            });
          }
        }
      };

      input.groupBy.forEach((grouping, index) => {
        inspectSelector(grouping, ["groupBy", index]);
      });
      input.metrics.forEach((metric, index) => {
        if (metric.op === "distinct") {
          inspectSelector(metric.value, ["metrics", index, "value"]);
        } else if (metric.op !== "count") {
          inspectSelector(metric.value, ["metrics", index, "value"]);
        }
      });
    }),
);

const archiveAggregationGroupKeyResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing") }).strict(),
  z
    .object({
      status: z.literal("value"),
      value: archiveJsonValueSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("bucket"),
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);

const archiveAggregationTimeBucketSchema = z
  .object({
    key: aggregationKeySchema,
    field: archiveAggregationTimeFieldSchema,
    grain: z.enum(["day", "week", "month"]),
    timeZone: postgresTextSchema.min(1).max(256),
    boundary: z.literal("[start,end)"),
  })
  .strict();

const archiveAggregationGroupSchema = z
  .object({
    keys: z.array(
      z
        .object({
          key: aggregationKeySchema,
          result: archiveAggregationGroupKeyResultSchema,
        })
        .strict(),
    ),
    metrics: z.array(
      z
        .object({
          key: aggregationKeySchema,
          op: z.enum(["count", "distinct", "sum", "avg", "min", "max"]),
          value: postgresTextSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/** 聚合结果只包含完整集合计算出的分组；游标固定首屏归档截点。 */
export const archiveAggregationResultSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      unit: archiveAggregationUnitSchema,
      scope: archiveSearchScopeSchema,
      snapshot: archiveSnapshotSchema,
      timeBuckets: z.array(archiveAggregationTimeBucketSchema),
      groups: z.array(archiveAggregationGroupSchema),
      nextCursor: postgresTextSchema.min(1).max(4096).optional(),
    })
    .strict(),
);

export type ArchiveAggregationInput = z.infer<
  typeof archiveAggregationInputSchema
>;
export type ArchiveAggregationRequest = z.input<
  typeof archiveAggregationInputSchema
>;
export type ArchiveAggregationResult = z.infer<
  typeof archiveAggregationResultSchema
>;
export type ArchiveAggregationMetric = z.infer<
  typeof archiveAggregationMetricSchema
>;
export type ArchiveAggregationGrouping = z.infer<
  typeof archiveAggregationGroupingSchema
>;
export type ArchiveAggregationSelector = z.infer<
  typeof archiveAggregationGroupSelectorSchema
>;
export type ArchiveAggregationUnit = z.infer<
  typeof archiveAggregationUnitSchema
>;
export type ArchiveAggregationOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 422;
      readonly error: ArchiveError;
    };

export type ArchiveAggregationScope = ArchiveSearchScope;
export type ArchiveAggregationFilter = ArchiveSearchFilter;
export type ArchiveAggregationStep = ArchiveSearchPathStep;
export type ArchiveAggregationText = ArchiveSearchText;
