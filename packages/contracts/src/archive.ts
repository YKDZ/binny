import * as z from "zod";

import type {
  ArchiveBatchReadOperation,
  ArchiveBatchReadRequest,
  ArchiveBatchReadResponse,
} from "./archive-batch-read.ts";
import {
  archiveExtensionOperationSchema,
  archiveExtensionScalarSchema,
  archiveSearchExtensionsSchema,
  type ArchiveExtensionOperation,
  type ArchiveExtensionScalar,
} from "./archive-extensions.ts";
import type { ArchiveHistoryOperations } from "./archive-history.ts";
import type { ArchiveRelationsOperations } from "./archive-relations.ts";
import { binIdSchema, sourceAdapterIdSchema } from "./bin-configuration.ts";
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

export type ArchiveJsonValue =
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
export const archiveJsonValueSchema = archiveJsonValueBaseSchema.superRefine(
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
    searchText: postgresTextSchema
      .optional()
      .describe(
        "Body-only fallback searched when html, markdown, and text are absent; ignored beside those representations because some producers include the title.",
      ),
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

function isValidSourceTimeZone(value: string): boolean {
  if (value === "UTC") return true;
  const offset = /^([+-])([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (offset !== null) {
    const hours = Number(offset[2]);
    const minutes = Number(offset[3]);
    return hours < 14 || (hours === 14 && minutes === 0);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A caller supplied IANA zone name or explicit UTC offset. */
export const archiveTimeZoneSchema = z
  .string()
  .min(1, "Source time zone cannot be empty.")
  .refine(
    isValidSourceTimeZone,
    "Time zone must be a valid IANA zone or UTC offset.",
  );

const sourceTimeFields = {
  timeZone: archiveTimeZoneSchema.optional(),
};

const sourceTimeValueSchemas = [
  z
    .object({
      precision: z.literal("instant"),
      value: z.iso.datetime({ offset: true }),
      ...sourceTimeFields,
    })
    .strict(),
  z
    .object({
      precision: z.literal("day"),
      value: z.iso.date(),
      ...sourceTimeFields,
    })
    .strict(),
  z
    .object({
      precision: z.literal("month"),
      value: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
      ...sourceTimeFields,
    })
    .strict(),
  z
    .object({
      precision: z.literal("year"),
      value: z.string().regex(/^\d{4}$/u),
      ...sourceTimeFields,
    })
    .strict(),
] as const;

function sourceTimeZoneOffsetAt(
  epochMs: number,
  timeZone: string,
): number | undefined {
  const fixedOffset = /^([+-])(\d{2}):(\d{2})$/u.exec(timeZone);
  if (fixedOffset !== null) {
    const direction = fixedOffset[1] === "+" ? 1 : -1;
    return direction * (Number(fixedOffset[2]) * 60 + Number(fixedOffset[3]));
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(epochMs);
    const values = Object.fromEntries(
      parts
        .filter(({ type }) => type !== "literal")
        .map(({ type, value }) => [type, Number(value)]),
    );
    const localTime = new Date(0);
    localTime.setUTCFullYear(values.year!, values.month! - 1, values.day!);
    localTime.setUTCHours(values.hour!, values.minute!, values.second!, 0);
    return Math.round((localTime.getTime() - epochMs) / 60_000);
  } catch {
    return undefined;
  }
}

function sourceTimeValueOffset(value: string): number {
  const offset = /([+-])(\d{2}):(\d{2})$/u.exec(value);
  if (offset === null) return 0;
  const direction = offset[1] === "+" ? 1 : -1;
  return direction * (Number(offset[2]) * 60 + Number(offset[3]));
}

/**
 * A source-supplied time that retains its original precision and known time zone.
 * `instant` values require an ISO 8601 offset; day, month, and year values stay
 * at their stated precision. A supplied zone must agree with an instant's
 * numeric offset, and a missing zone is never inferred.
 */
export const sourceTimeSchema = z
  .discriminatedUnion("precision", sourceTimeValueSchemas)
  .superRefine((sourceTime, context) => {
    if (
      sourceTime.precision !== "instant" ||
      sourceTime.timeZone === undefined
    ) {
      return;
    }
    const epochMs = new Date(sourceTime.value).getTime();
    const zoneOffset = sourceTimeZoneOffsetAt(epochMs, sourceTime.timeZone);
    if (
      zoneOffset !== undefined &&
      zoneOffset !== sourceTimeValueOffset(sourceTime.value)
    ) {
      context.addIssue({
        code: "custom",
        path: ["timeZone"],
        message:
          "Source time zone does not match the offset in the instant value.",
      });
    }
  });

/** A source timestamp can be exact or retain day, month, or year precision. */
export type SourceTime = z.infer<typeof sourceTimeSchema>;

export const archiveResourceReferenceSchema = z
  .object({ resourceId: z.string().uuid() })
  .strict();
export type ArchiveResourceReference = z.infer<
  typeof archiveResourceReferenceSchema
>;

const archiveItemExtensionsSchema = jsonObjectSchema.describe(
  "Structured source facts validated by the registered adapter extension schema.",
);
// `describe()` clones this custom node, so its JSON Schema projection must be registered too.
registerPostgresJsonSchemaProjection(
  archiveItemExtensionsSchema,
  archiveItemExtensionsSchema,
  jsonObjectProjectionSchema.describe(
    "Structured source facts validated by the registered adapter extension schema.",
  ),
);

const archiveItemFieldsSchema = z
  .object({
    title: nonEmptyText
      .nullable()
      .describe(
        "Source-supplied title, or null when the source provided none.",
      ),
    sourcePublishedAt: sourceTimeSchema
      .nullable()
      .describe(
        "Source publication time at its known precision, or null if absent.",
      ),
    sourceModifiedAt: sourceTimeSchema
      .nullable()
      .describe(
        "Source modification time at its known precision, or null if absent.",
      ),
    sourceRef: nonEmptyText.optional(),
    extensions: archiveItemExtensionsSchema,
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
  readonly title: string | null;
  readonly sourcePublishedAt: SourceTime | null;
  readonly sourceModifiedAt: SourceTime | null;
  readonly extensions: Record<string, unknown>;
  readonly body?: object | undefined;
  readonly resources?: readonly unknown[] | undefined;
}): boolean {
  const hasExtensions = Object.keys(item.extensions).length > 0;
  // A source reference only identifies the origin; it cannot make a failed capture a content revision.
  return (
    item.title !== null ||
    item.sourcePublishedAt !== null ||
    item.sourceModifiedAt !== null ||
    hasExtensions ||
    item.body !== undefined ||
    (item.resources?.length ?? 0) > 0
  );
}

/** An immutable source state; capture context contributes to revision identity, while diagnostics do not. */
export const archiveItemStateSchema = withArchiveJsonSchemaProjection(
  archiveItemFieldsSchema.refine(hasReceivedMaterial, {
    path: ["body"],
    message: "没有取得资料时不能创建空内容版本。",
  }),
);

/** Submit one source item under its stable source key; identity is never inferred from its body. */
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

type ArchiveItemStateFromSchema = z.infer<typeof archiveItemStateSchema>;
type ArchiveItemInputFromSchema = z.infer<typeof archiveItemInputSchema>;

/** Public facts supplied by the source for each captured item. */
export type ArchiveItemPublicFacts = {
  /** The source's title, or `null` when it did not provide one. */
  readonly title: string | null;
  /** The source's publication time at its known precision, or `null` if absent. */
  readonly sourcePublishedAt: SourceTime | null;
  /** The source's modification time at its known precision, or `null` if absent. */
  readonly sourceModifiedAt: SourceTime | null;
};

/** A complete, immutable item revision with adapter-owned extension data. */
export type ArchiveItemState<
  TExtensions extends object = ArchiveItemStateFromSchema["extensions"],
> = Omit<
  ArchiveItemStateFromSchema,
  "title" | "sourcePublishedAt" | "sourceModifiedAt" | "extensions"
> & {
  readonly title: ArchiveItemPublicFacts["title"];
  readonly sourcePublishedAt: ArchiveItemPublicFacts["sourcePublishedAt"];
  readonly sourceModifiedAt: ArchiveItemPublicFacts["sourceModifiedAt"];
  readonly extensions: TExtensions;
};

/** An item submitted under its stable source key. */
export type ArchiveItemInput<
  TExtensions extends object = ArchiveItemInputFromSchema["extensions"],
> = Omit<
  ArchiveItemInputFromSchema,
  "title" | "sourcePublishedAt" | "sourceModifiedAt" | "extensions"
> & {
  readonly title: ArchiveItemPublicFacts["title"];
  readonly sourcePublishedAt: ArchiveItemPublicFacts["sourcePublishedAt"];
  readonly sourceModifiedAt: ArchiveItemPublicFacts["sourceModifiedAt"];
  readonly extensions: TExtensions;
};

/** A batch submission uses one globally unique request ID; a retry reuses its original commit. */
export const archiveSubmissionInputSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      requestId: nonEmptyText.max(256, "请求标识不能超过 256 个字符。"),
      binId: binIdSchema,
      runId: nonEmptyText.max(128, "run 标识不能超过 128 个字符。").optional(),
      sourceAdapterVersion: nonEmptyText
        .max(256, "信源适配器版本不能超过 256 个字符。")
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

type ArchiveSubmissionInputFromSchema = z.infer<
  typeof archiveSubmissionInputSchema
>;

/** A batch of content and relation observations accepted by the archive API. */
export type ArchiveSubmissionInput<
  TExtensions extends object = ArchiveItemInputFromSchema["extensions"],
> = Omit<ArchiveSubmissionInputFromSchema, "items"> & {
  readonly items: ArchiveItemInput<TExtensions>[];
};

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
    size: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ArchiveResourceMetadata = z.infer<
  typeof archiveResourceMetadataSchema
>;

export const archiveResourceResolveInputSchema = z
  .object({
    binId: binIdSchema.optional(),
    resourceIds: z.array(archiveIdentifierSchema).optional(),
    sha256s: z.array(archiveSha256Schema).optional(),
    sourceKeys: z.array(sourceKeySchema).optional(),
    immutableMediaUrls: z
      .array(
        z
          .object({
            namespace: nonEmptyText.max(
              256,
              "信源命名空间不能超过 256 个字符。",
            ),
            url: postgresTextSchema
              .min(1, "媒体地址不能为空。")
              .max(4096, "媒体地址不能超过 4096 个字符。"),
          })
          .strict(),
      )
      .optional()
      .describe(
        "Resolve media URLs from declared extensions.media entries containing url and resourceId.",
      ),
  })
  .strict();

export const archiveResourceResolveItemSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      sourceKey: sourceKeySchema,
      state: archiveItemStateSchema,
      resourceMetadata: z.array(archiveResourceMetadataSchema),
    })
    .strict(),
);

export const archiveResourceResolveResultSchema =
  withArchiveJsonSchemaProjection(
    z
      .object({
        resources: z.array(archiveResourceMetadataSchema),
        items: z.array(archiveResourceResolveItemSchema),
        mediaByUrl: z.record(postgresTextSchema, archiveResourceMetadataSchema),
      })
      .strict(),
  );

export type ArchiveItemSubmissionInput<
  TExtensions extends object = ArchiveItemStateFromSchema["extensions"],
> = ArchiveItemState<TExtensions>;
export type ArchiveResourceResolveInput = z.infer<
  typeof archiveResourceResolveInputSchema
>;
export type ArchiveResourceResolveRequest = z.input<
  typeof archiveResourceResolveInputSchema
>;
export type ArchiveResourceResolveItem = z.infer<
  typeof archiveResourceResolveItemSchema
>;
export type ArchiveResourceResolveResult = z.infer<
  typeof archiveResourceResolveResultSchema
>;

// PostgreSQL BIGINT 序号以十进制文本传输，避免超出安全整数范围时舍入。
export const archiveSequenceSchema = z.string().regex(/^[1-9][0-9]*$/u);
// Keep the signed BIGINT boundary in the regex so it survives JSON Schema projection.
const archiveSnapshotSequencePattern = new RegExp(
  [
    "^(?:",
    "0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|",
    "9[01][0-9]{17}|92[01][0-9]{16}|922[0-2][0-9]{15}|",
    "9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|",
    "92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|",
    "9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|",
    "922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|",
    "92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|",
    "9223372036854775[0-7][0-9]{2}|922337203685477580[0-7]",
    ")$",
  ].join(""),
  "u",
);
export const archiveSnapshotSequenceSchema = z
  .string()
  .regex(
    archiveSnapshotSequencePattern,
    "Archive snapshot sequence must be between 0 and 9223372036854775807.",
  )
  .describe(
    "A decimal archive sequence between 0 and 9223372036854775807, inclusive.",
  );
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
  ordinal: z.int().nonnegative(),
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
    ordinal: z.int().nonnegative(),
    sourceKey: sourceKeySchema,
  })
  .strict();

const archiveCommitRelationGapSchema = z
  .object({
    relationId: nonEmptyText.max(256),
    ordinal: z.int().nonnegative(),
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
    ordinal: z.int().nonnegative(),
    binId: binIdSchema,
    runId: nonEmptyText.max(128).optional(),
    sourceAdapterVersion: nonEmptyText.max(256).optional(),
    revisionId: archiveIdSchema,
    sourceModifiedAt: sourceTimeSchema.nullable(),
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
    sourceAdapterVersion: nonEmptyText.max(256).optional(),
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
      sourceAdapterVersion: nonEmptyText.max(256).optional(),
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

const archiveRevisionDiffValueSnapshotSchema = z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }).strict(),
  z
    .object({ present: z.literal(true), value: archiveJsonValueSchema })
    .strict(),
]);

const archiveRevisionDiffFieldSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unchanged") }).strict(),
  z
    .object({
      status: z.literal("changed"),
      before: archiveRevisionDiffValueSnapshotSchema,
      after: archiveRevisionDiffValueSnapshotSchema,
    })
    .strict(),
]);

/**
 * Compare two complete item revisions. Public facts and declared extensions are
 * reported as fields; JSON object key order is ignored and arrays compare by
 * position. Missing values use `present: false`, while JSON null stays present.
 * Resource IDs compare as an unordered set and added or removed IDs are sorted.
 */
export const archiveRevisionDiffSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      itemId: archiveIdSchema,
      firstRevisionId: archiveIdSchema,
      secondRevisionId: archiveIdSchema,
      fields: z
        .object({
          title: archiveRevisionDiffFieldSchema,
          sourcePublishedAt: archiveRevisionDiffFieldSchema,
          sourceRef: archiveRevisionDiffFieldSchema,
          sourceModifiedAt: archiveRevisionDiffFieldSchema,
          extensions: archiveRevisionDiffFieldSchema,
          body: archiveRevisionDiffFieldSchema,
          capture: archiveRevisionDiffFieldSchema,
        })
        .strict(),
      resources: z
        .object({
          added: z.array(archiveIdentifierSchema),
          removed: z.array(archiveIdentifierSchema),
        })
        .strict(),
      hasChanges: z.boolean(),
    })
    .strict(),
);

/**
 * Machine-readable correction evidence for a search input failure.
 *
 * Candidate values are closed sets taken from the active request contract or
 * the selected adapter's declared extension fields. They are never derived
 * from archived data, and a missing field means no finite candidate set is
 * known. `allowedOperations` describes one declared field; `protocolOperations`
 * only lists operations the request protocol accepts when no field declaration
 * is available.
 */
export const archiveSearchDiagnosticSchema = z
  .object({
    allowedValues: z.array(archiveExtensionScalarSchema).min(1).optional(),
    allowedItemValues: z.array(archiveExtensionScalarSchema).min(1).optional(),
    allowedOperations: z.array(archiveExtensionOperationSchema).optional(),
    protocolOperations: z
      .array(archiveExtensionOperationSchema)
      .min(1)
      .optional(),
    discovery: z
      .object({
        sourceAdapterId: sourceAdapterIdSchema,
        sourceAdapterVersion: postgresTextSchema.min(1).optional(),
        binId: binIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Public archive failure envelope. `diagnostic` appears only when the failing
 * input has a closed correction set or a discoverable extension declaration;
 * consumers must not infer candidates from archived data.
 */
export const archiveErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "invalid_input",
          "bin_not_found",
          "archive_request_conflict",
          "run_not_writable",
          "item_not_found",
          "item_deleted",
          "revision_not_found",
          "revision_item_mismatch",
          "resource_not_found",
          "resource_storage_unavailable",
          "commit_not_found",
          "query_budget_exceeded",
          "request_cancelled",
          "payload_too_large",
          "relation_not_found",
          "relation_endpoint_conflict",
        ]),
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
        diagnostic: archiveSearchDiagnosticSchema.optional(),
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
export type ArchiveRevisionDiff = z.infer<typeof archiveRevisionDiffSchema>;
export type ArchiveError = z.infer<typeof archiveErrorSchema>["error"];

/** Literal text groups use OR within a group and AND across groups. */
export const archiveSearchTextSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      in: z.enum(["title", "body", "both"]).default("both"),
      groups: z
        .array(
          z
            .array(
              postgresTextSchema
                .min(1, "Search terms cannot be empty.")
                .max(1024, "Search terms cannot exceed 1024 characters."),
            )
            .min(1)
            .max(16),
        )
        .min(1)
        .max(16),
    })
    .strict(),
);
export type ArchiveSearchText = z.infer<typeof archiveSearchTextSchema>;

/**
 * Filter by a local calendar window. `from` is inclusive and `until` is
 * exclusive; both boundaries are local midnights in `timeZone`, so calendar
 * days retain their actual length across daylight-saving changes. Review
 * selects confirmed matches or views whose precision/time-zone evidence is
 * insufficient to decide membership.
 */
export const archiveSearchTimeWindowSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      field: z
        .enum(["sourcePublishedAt", "sourceModifiedAt", "observedAt"])
        .describe("The source or archive time fact used for this window."),
      from: z.iso
        .date()
        .describe(
          "Inclusive local calendar date, interpreted at local midnight.",
        ),
      until: z.iso
        .date()
        .describe(
          "Exclusive local calendar date, interpreted at local midnight.",
        ),
      timeZone: archiveTimeZoneSchema.describe(
        "Required caller time zone used to interpret both local date bounds.",
      ),
      review: z
        .enum(["certain", "undetermined"])
        .default("certain")
        .describe(
          "Enumerate confirmed matching views or views whose time evidence is insufficient.",
        ),
    })
    .strict()
    .superRefine((window, context) => {
      if (window.from >= window.until) {
        context.addIssue({
          code: "custom",
          path: ["until"],
          message: "The exclusive until date must be later than from.",
        });
      }
    }),
);
export type ArchiveSearchTimeWindow = z.infer<
  typeof archiveSearchTimeWindowSchema
>;

/** Classification of one returned bin view against the requested time window. */
const archiveSearchTimeMatchSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("certain") }).strict(),
  z
    .object({
      status: z.literal("undetermined"),
      reason: z.enum([
        "missingTime",
        "missingTimeZone",
        "precisionOverlapsBoundary",
      ]),
    })
    .strict(),
]);

const archiveSearchCountSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);

const archiveSearchDistributionPageInputFields = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: postgresTextSchema.min(1).max(4096).optional(),
};

const archiveSearchBinDistributionRequestSchema = z
  .object({
    by: z.literal("bin"),
    ...archiveSearchDistributionPageInputFields,
  })
  .strict();
const archiveSearchDateDistributionRequestSchema = z
  .object({
    by: z.literal("date"),
    field: z
      .enum(["sourcePublishedAt", "sourceModifiedAt", "observedAt"])
      .describe("The source or archive time fact used for the date groups."),
    period: z
      .enum(["day", "month", "year"])
      .default("day")
      .describe("The local calendar period represented by each date group."),
    timeZone: archiveTimeZoneSchema.describe(
      "Required time zone used to form local calendar groups.",
    ),
    ...archiveSearchDistributionPageInputFields,
  })
  .strict();
const archiveSearchExtensionDistributionRequestSchema = z
  .object({
    by: z.literal("extension"),
    sourceAdapterId: sourceAdapterIdSchema,
    field: postgresTextSchema.min(1).max(128),
    ...archiveSearchDistributionPageInputFields,
  })
  .strict();

/**
 * One independently paginated distribution over the complete match set.
 * Date periods use local calendar boundaries in the required time zone; a day
 * follows the calendar and may not be exactly 24 elapsed hours across DST.
 */
export const archiveSearchDistributionRequestSchema =
  withArchiveJsonSchemaProjection(
    z.discriminatedUnion("by", [
      archiveSearchBinDistributionRequestSchema,
      archiveSearchDateDistributionRequestSchema,
      archiveSearchExtensionDistributionRequestSchema,
    ]),
  );
const archiveSearchNonExtensionDistributionRequestSchema =
  withArchiveJsonSchemaProjection(
    z.discriminatedUnion("by", [
      archiveSearchBinDistributionRequestSchema,
      archiveSearchDateDistributionRequestSchema,
    ]),
  );
export type ArchiveSearchDistributionRequest = z.input<
  typeof archiveSearchDistributionRequestSchema
>;

const archiveSearchDistributionItemCountSchema = archiveSearchCountSchema;
const archiveSearchDistributionUndeterminedReasonSchema = z.enum([
  "missingTime",
  "missingTimeZone",
  "precisionOverlapsBoundary",
]);
const archiveSearchDistributionBinGroupSchema = z
  .object({
    kind: z.literal("bin"),
    binId: binIdSchema,
    itemCount: archiveSearchDistributionItemCountSchema,
  })
  .strict();
const archiveSearchDistributionDateGroupSchema = z
  .object({
    kind: z.literal("date"),
    value: postgresTextSchema,
    itemCount: archiveSearchDistributionItemCountSchema,
  })
  .strict();
const archiveSearchDistributionUndeterminedGroupSchema = z
  .object({
    kind: z.literal("undetermined"),
    reason: archiveSearchDistributionUndeterminedReasonSchema,
    itemCount: archiveSearchDistributionItemCountSchema,
  })
  .strict();
const archiveSearchDistributionExtensionGroupSchema = z
  .object({
    kind: z.literal("extension"),
    value: archiveExtensionScalarSchema,
    itemCount: archiveSearchDistributionItemCountSchema,
  })
  .strict();
const archiveSearchDistributionMissingGroupSchema = z
  .object({
    kind: z.literal("missing"),
    itemCount: archiveSearchDistributionItemCountSchema,
  })
  .strict();
const archiveSearchDistributionPageFields = {
  totalItems: archiveSearchDistributionItemCountSchema,
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(4096).optional(),
};

/**
 * One stable, independently paginated view of the full matching set.
 * `totalItems` is distinct by item. A multi-valued extension item can appear
 * once in each value group; a bin distribution counts it once per matching
 * bin, so group totals can exceed `totalItems`.
 */
export const archiveSearchDistributionPageSchema =
  withArchiveJsonSchemaProjection(
    z.discriminatedUnion("by", [
      z
        .object({
          by: z.literal("bin"),
          ...archiveSearchDistributionPageFields,
          groups: z.array(archiveSearchDistributionBinGroupSchema),
        })
        .strict(),
      z
        .object({
          by: z.literal("date"),
          field: z.enum([
            "sourcePublishedAt",
            "sourceModifiedAt",
            "observedAt",
          ]),
          period: z.enum(["day", "month", "year"]),
          timeZone: archiveTimeZoneSchema,
          ...archiveSearchDistributionPageFields,
          groups: z.array(
            z.union([
              archiveSearchDistributionDateGroupSchema,
              archiveSearchDistributionUndeterminedGroupSchema,
            ]),
          ),
        })
        .strict(),
      z
        .object({
          by: z.literal("extension"),
          sourceAdapterId: sourceAdapterIdSchema,
          field: postgresTextSchema.min(1).max(128),
          ...archiveSearchDistributionPageFields,
          groups: z.array(
            z.union([
              archiveSearchDistributionExtensionGroupSchema,
              archiveSearchDistributionMissingGroupSchema,
            ]),
          ),
        })
        .strict(),
    ]),
  );
export type ArchiveSearchDistributionPage = z.infer<
  typeof archiveSearchDistributionPageSchema
>;

function archiveSearchBinsSchema(requiredExtensionScope = false) {
  return z
    .array(binIdSchema, {
      error: (issue) =>
        requiredExtensionScope && issue.input === undefined
          ? "Extension filters require an explicit bin scope."
          : undefined,
    })
    .min(1)
    .max(100)
    .superRefine((bins, context) => {
      const seen = new Set<string>();
      for (const [index, binId] of bins.entries()) {
        if (seen.has(binId)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "A bin can appear only once.",
          });
        }
        seen.add(binId);
      }
    });
}

const archiveSearchInputSharedFields = {
  text: archiveSearchTextSchema.optional(),
  timeWindow: archiveSearchTimeWindowSchema.optional(),
  includeCandidates: z
    .boolean()
    .default(true)
    .describe(
      "Return candidate item results alongside an optional distribution.",
    ),
  asOf: archiveSnapshotSequenceSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: postgresTextSchema.min(1).max(4096).optional(),
};
const archiveSearchInputCommonFields = {
  ...archiveSearchInputSharedFields,
  distribution: archiveSearchDistributionRequestSchema
    .optional()
    .describe(
      "An independent complete-match distribution by bin, local date period, or declared extension field.",
    ),
};
const archiveSearchWithoutExtensionsSchema = z.union([
  z
    .object({
      bins: archiveSearchBinsSchema().optional(),
      ...archiveSearchInputSharedFields,
      distribution:
        archiveSearchNonExtensionDistributionRequestSchema.optional(),
      extensions: z.never().optional(),
    })
    .strict(),
  z
    .object({
      bins: archiveSearchBinsSchema(true),
      ...archiveSearchInputSharedFields,
      distribution: archiveSearchExtensionDistributionRequestSchema,
      extensions: z.never().optional(),
    })
    .strict(),
]);
const archiveSearchWithExtensionsSchema = z
  .object({
    bins: archiveSearchBinsSchema(true),
    ...archiveSearchInputCommonFields,
    extensions: archiveSearchExtensionsSchema,
  })
  .strict();

/**
 * Search the latest matching view in each selected bin at one archive
 * snapshot. Extension filters require an explicit `bins` list. Every selected
 * bin must use the declared adapter and schema; all filters are evaluated on
 * the same latest bin view. Missing or null extension values do not match.
 * A request may include one complete-match distribution by bin, date period,
 * or declared top-level extension field. Candidate and distribution cursors
 * and page sizes advance independently; set `includeCandidates` to false for
 * distribution-only pages.
 */
export const archiveSearchInputSchema = withArchiveJsonSchemaProjection(
  z
    .union([
      archiveSearchWithExtensionsSchema,
      archiveSearchWithoutExtensionsSchema,
    ])
    .superRefine((input, context) => {
      if (!input.includeCandidates && input.distribution === undefined) {
        context.addIssue({
          code: "custom",
          path: ["distribution"],
          message: "A distribution is required when candidates are omitted.",
        });
      }
      if (!input.includeCandidates && input.cursor !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["cursor"],
          message:
            "A candidate cursor cannot be used when candidates are omitted.",
        });
      }
      if (input.distribution?.by === "extension" && input.bins === undefined) {
        context.addIssue({
          code: "custom",
          path: ["bins"],
          message: "Extension distributions require an explicit bin scope.",
        });
      }
      if (
        input.distribution?.by === "extension" &&
        input.extensions !== undefined &&
        input.distribution.sourceAdapterId !== input.extensions.sourceAdapterId
      ) {
        context.addIssue({
          code: "custom",
          path: ["distribution", "sourceAdapterId"],
          message:
            "Extension filters and distributions must use the same source adapter.",
        });
      }
    }),
);

function nestedArchiveSearchIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): readonly z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      return nestedArchiveSearchIssues(issue.errors.flat(), path);
    }
    return [{ ...issue, path } as z.core.$ZodIssue];
  });
}

/** Select the most specific issue from the search input union branch that applies. */
export function archiveSearchInputIssue(
  input: unknown,
  issues: readonly z.core.$ZodIssue[],
): z.core.$ZodIssue | undefined {
  const unionIssue = issues.find(
    (issue) => issue.code === "invalid_union" && issue.errors.length === 2,
  );
  if (unionIssue?.code !== "invalid_union") return issues[0];

  const hasExtensionScope =
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "extensions");
  const branchIndex = hasExtensionScope ? 0 : 1;
  let branchIssues = unionIssue.errors[branchIndex];
  if (branchIssues === undefined) return issues[0];

  const distribution =
    typeof input === "object" &&
    input !== null &&
    "distribution" in input &&
    typeof input.distribution === "object" &&
    input.distribution !== null
      ? input.distribution
      : undefined;
  if (
    !hasExtensionScope &&
    distribution !== undefined &&
    "by" in distribution &&
    distribution.by === "extension"
  ) {
    const distributionUnion = branchIssues.find(
      (issue) => issue.code === "invalid_union" && issue.errors.length === 2,
    );
    if (distributionUnion?.code === "invalid_union") {
      branchIssues = distributionUnion.errors[1];
    }
  }
  if (branchIssues === undefined) return issues[0];

  const candidates = nestedArchiveSearchIssues(branchIssues.flat());
  return candidates.reduce<z.core.$ZodIssue | undefined>(
    (selected, candidate) =>
      selected === undefined || candidate.path.length > selected.path.length
        ? candidate
        : selected,
    undefined,
  );
}

/** Optional correction evidence attached to an archive search failure. */
export type ArchiveSearchDiagnostic = z.infer<
  typeof archiveSearchDiagnosticSchema
>;

function archiveExtensionScalarCandidates(
  values: readonly unknown[],
): ArchiveExtensionScalar[] | undefined {
  const scalars = values.filter(
    (value): value is ArchiveExtensionScalar =>
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean",
  );
  return scalars.length === 0 ? undefined : scalars;
}

function archiveSearchInputExtensionDiscovery(
  input: unknown,
): ArchiveSearchDiagnostic["discovery"] {
  if (!isPlainJsonObject(input)) return undefined;
  const extensions = isPlainJsonObject(input.extensions)
    ? input.extensions
    : undefined;
  const distribution = isPlainJsonObject(input.distribution)
    ? input.distribution
    : undefined;
  // Discovery navigation is optional evidence; never let an invalid identity
  // turn an otherwise normal input failure into a diagnostic construction error.
  const checkedSourceAdapterId = sourceAdapterIdSchema.safeParse(
    extensions?.sourceAdapterId ?? distribution?.sourceAdapterId,
  );
  if (!checkedSourceAdapterId.success) return undefined;
  const bins = Array.isArray(input.bins) ? input.bins : undefined;
  const checkedBinId =
    bins?.length === 1 ? binIdSchema.safeParse(bins[0]) : undefined;
  return {
    sourceAdapterId: checkedSourceAdapterId.data,
    ...(checkedBinId?.success === true ? { binId: checkedBinId.data } : {}),
  };
}

/**
 * Extract public correction evidence from the selected fixed-search issue.
 * The selected Zod issue already preserves the applicable union branch and
 * list position. A discriminated union exposes its closed candidate set as
 * `options`; an `op` discriminator instead describes protocol operations
 * rather than a field's values. No message parsing or duplicated enum table
 * is involved.
 */
export function archiveSearchInputDiagnostic(
  input: unknown,
  issue: z.core.$ZodIssue | undefined,
): ArchiveSearchDiagnostic | undefined {
  if (issue === undefined) return undefined;
  const values =
    issue.code === "invalid_value"
      ? archiveExtensionScalarCandidates(issue.values)
      : issue.code === "invalid_union" &&
          "options" in issue &&
          issue.discriminator !== "op"
        ? archiveExtensionScalarCandidates(issue.options)
        : undefined;
  const protocolOperations =
    issue.code === "invalid_union" &&
    "options" in issue &&
    issue.discriminator === "op"
      ? issue.options.filter(
          (option): option is ArchiveExtensionOperation =>
            archiveExtensionOperationSchema.safeParse(option).success,
        )
      : undefined;
  const extensionIssue =
    issue.path[0] === "extensions" || issue.path[0] === "distribution";
  const discovery = extensionIssue
    ? archiveSearchInputExtensionDiscovery(input)
    : undefined;
  const diagnostic = {
    ...(values === undefined
      ? {}
      : typeof issue.path.at(-1) === "number"
        ? { allowedItemValues: values }
        : { allowedValues: values }),
    ...(protocolOperations === undefined || protocolOperations.length === 0
      ? {}
      : { protocolOperations }),
    ...(discovery === undefined ? {} : { discovery }),
  };
  if (Object.keys(diagnostic).length === 0) return undefined;
  return archiveSearchDiagnosticSchema.parse(diagnostic);
}

const archiveSearchMatchSchema = z
  .object({
    binId: binIdSchema,
    revisionId: archiveIdentifierSchema,
    archiveSeq: archiveSequenceSchema,
    observedAt: timestampSchema,
    recordedAt: timestampSchema,
    title: nonEmptyText.nullable(),
    sourceRef: nonEmptyText.optional(),
    sourcePublishedAt: sourceTimeSchema.nullable(),
    sourceModifiedAt: sourceTimeSchema.nullable(),
    timeMatch: archiveSearchTimeMatchSchema.optional(),
  })
  .strict();

const archiveSearchResultSchema = z
  .object({
    itemId: archiveIdentifierSchema,
    sourceKey: sourceKeySchema,
    title: nonEmptyText.nullable(),
    sourcePublishedAt: sourceTimeSchema.nullable(),
    sourceModifiedAt: sourceTimeSchema.nullable(),
    observedAt: timestampSchema,
    timeStatus: z.enum(["certain", "undetermined"]).optional(),
    matches: z.array(archiveSearchMatchSchema).min(1),
  })
  .strict();

/**
 * Results are deduplicated by item while retaining every selected bin view and
 * its immutable revision reference. Without a time window, ordering uses the
 * newest matching observation descending; with a time window, it uses the
 * newest selected time fact descending. Exact values and known-zone coarse
 * values use the represented instant or interval start; an undetermined
 * zone-free coarse value uses its written local period start as an ordering
 * key. A null time sorts last, and these keys never replace the stored public
 * SourceTime fact. Item ID breaks ties. Counts are distinct
 * per review set, so one item with certain and undetermined views may count in
 * both. `hasMore` and `nextCursor` describe the candidate page. If candidates
 * are omitted, `results` is empty and `hasMore` is false. A requested
 * distribution covers the complete matching set and has its own continuation
 * cursor and page size. Date groups include a source-time fact only when its
 * complete represented interval fits one local calendar period; other facts
 * are grouped by their undetermined reason. Matching views can place one item
 * in different date or reason groups, but it counts once within each group.
 * Extension list values and matching views are also deduplicated within each
 * group, and absent/null/empty values share one missing group. Neither page
 * size nor cursor changes the other page.
 */
export const archiveSearchPageSchema = withArchiveJsonSchemaProjection(
  z
    .object({
      snapshot: archiveSnapshotSchema,
      candidatesIncluded: z.boolean(),
      results: z.array(archiveSearchResultSchema),
      timeSummary: z
        .object({
          certainItems: archiveSearchCountSchema,
          undeterminedItems: archiveSearchCountSchema,
        })
        .strict()
        .optional(),
      hasMore: z.boolean(),
      nextCursor: z.string().min(1).max(4096).optional(),
      distribution: archiveSearchDistributionPageSchema.optional(),
    })
    .strict(),
);

export type ArchiveSearchInput = z.infer<typeof archiveSearchInputSchema>;
export type ArchiveSearchRequest = z.input<typeof archiveSearchInputSchema>;
export type ArchiveSearchPage = z.infer<typeof archiveSearchPageSchema>;
type ExtensionFilterFor<Value> =
  NonNullable<Value> extends readonly (infer Item)[]
    ? [NonNullable<Item>] extends [never]
      ? never
      : [NonNullable<Item>] extends [ArchiveExtensionScalar]
        ?
            | {
                readonly op: "has";
                readonly value: NonNullable<Item>;
              }
            | {
                readonly op: "hasAny";
                readonly values: readonly NonNullable<Item>[];
              }
        : never
    : NonNullable<Value> extends ArchiveExtensionScalar
      ?
          | { readonly op: "eq"; readonly value: NonNullable<Value> }
          | {
              readonly op: "in";
              readonly values: readonly NonNullable<Value>[];
            }
      : never;
type ExtensionFiltersFor<TExtensions extends object> = {
  readonly [Field in keyof TExtensions]?: ExtensionFilterFor<
    TExtensions[Field]
  >;
};
type AtLeastOne<T, Keys extends keyof T = keyof T> = Keys extends keyof T
  ? Pick<T, Keys> & Partial<Omit<T, Keys>>
  : never;

/**
 * A type-only search request for an adapter's declared extension properties.
 * Callers must supply at least one bin; runtime validation confirms that every
 * selected bin still uses the adapter and schema described by the request.
 * Scalar fields use `eq` or `in`; scalar arrays use `has` or `hasAny`. Missing
 * and null values do not match.
 */
export type ArchiveSearchRequestFor<
  TExtensions extends object,
  TSourceAdapterId extends string = string,
> = Omit<ArchiveSearchRequest, "bins" | "extensions"> & {
  readonly bins: NonNullable<ArchiveSearchRequest["bins"]>;
  readonly extensions: {
    readonly sourceAdapterId: TSourceAdapterId;
    readonly filters: AtLeastOne<ExtensionFiltersFor<TExtensions>>;
  };
};
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

/**
 * Server-only execution metadata passed between the HTTP adapter and archive
 * store. One monotonic deadline covers processing and preparing the complete
 * response after the request has been parsed; it does not bound client network
 * transfer time.
 */
export type ArchiveOperationContext = {
  /** Monotonic deadline set once by the server; never accepted in a serialized request. */
  readonly deadline?: number;
  /** Aborted when the HTTP client disconnects before the response is complete. */
  readonly signal?: AbortSignal;
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
  /**
   * Verify and resolve resources, unchanged item states, and immutable media URLs mapped by declared `extensions.media` arrays.
   * Only returns resources that are ready in the database and physically available on storage disk.
   */
  resolveArchiveResources(
    input: ArchiveResourceResolveRequest,
  ): Promise<ArchiveOperation<ArchiveResourceResolveResult>>;
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
  compareArchiveRevisions(
    firstRevisionId: string,
    secondRevisionId: string,
  ): Promise<ArchiveOperation<ArchiveRevisionDiff>>;
  /**
   * Search an immutable snapshot. Candidates and any requested distribution
   * share the request deadline through complete HTTP response preparation;
   * the server does not guarantee client network transfer time.
   */
  searchArchive(
    input: ArchiveSearchRequest,
    context?: ArchiveOperationContext,
  ): Promise<ArchiveSearchOperation<ArchiveSearchPage>>;
  /**
   * Read exact item, bin, revision, and observation references selected from
   * search. Repeated inputs retain separate result indices, while deleted,
   * absent, and mismatched references return per-item unreadable results.
   * Readable revisions include the complete stored body and report resource
   * availability independently. A request accepts at most 50 references and
   * rejects as a whole if its complete response exceeds 16 MiB or its shared
   * server request budget expires. The deadline includes HTTP response
   * preparation but does not bound client network transfer time.
   */
  readArchiveBatch(
    input: ArchiveBatchReadRequest,
    context?: ArchiveOperationContext,
  ): Promise<ArchiveBatchReadOperation<ArchiveBatchReadResponse>>;
} & ArchiveHistoryOperations &
  ArchiveRelationsOperations;
