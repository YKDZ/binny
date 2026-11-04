import { setTimeout as delay } from "node:timers/promises";

import {
  archivedMedia,
  archiveResourceManifest,
  sourceAdapterActionError,
  defineSourceAdapter,
  defineSourceAdapterAction,
  createSourceAccessBudget,
  SourceAccessBudgetExceededError,
  isSourceAdapterActionError,
  sourceAccessConfigSchema,
  type ArchiveResourceMetadata,
  type JsonObject,
  type SourceAccessBudgetClient,
  type SourceAccessKind,
  type SourceAccessRequest,
  type SourceAccessResponseObservation,
  type SourceAccessSnapshot,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { chromium, type APIRequestContext, type Page } from "patchright-core";
import { z } from "zod";

import { ChallengeRecovery } from "#/challenge-recovery";

const challengeRecoverySchema = z
  .object({
    rounds: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
  })
  .strict();
type ChallengeRecoverySummary = z.output<typeof challengeRecoverySchema>;

const topicIdSchema = z.number().int().safe().positive();
const targetIdSchema = z
  .string()
  .min(1, "目标标识不能为空。")
  .max(128, "目标标识不能超过 128 个字符。")
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u, "目标标识格式无效。");
const siteOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0 &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}, "站点地址必须是没有路径、查询或凭据的 HTTP(S) origin。");

const linuxDoSourceAccessSchema = sourceAccessConfigSchema.superRefine(
  (declaration, context) => {
    const group = declaration.groups.linuxdo;
    if (
      group === undefined ||
      !group.sources.includes("site") ||
      !group.sources.includes("media")
    ) {
      context.addIssue({
        code: "custom",
        path: ["groups"],
        message: "Linux.do 必须用 linuxdo 组共同准入站点和媒体来源。",
      });
    }
    if (Object.keys(declaration.groups).some((id) => id !== "linuxdo")) {
      context.addIssue({
        code: "custom",
        path: ["groups"],
        message: "Linux.do 的站点和媒体主动访问必须共享 linuxdo 来源组。",
      });
    }
  },
);

const sourceAdapterConfigSchema = z
  .object({
    origin: siteOriginSchema
      .describe(
        "Linux.do 站点的 HTTP(S) origin，只填协议、主机和可选端口，不含路径、查询、片段或登录凭据。",
      )
      .meta({ examples: ["https://linux.do"] }),
    sourceAccess: linuxDoSourceAccessSchema
      .default({
        groups: {
          linuxdo: {
            sources: ["site", "media"],
            minimumIntervalMs: 1_000,
            maxConcurrency: 1,
          },
        },
      })
      .describe(
        "Linux.do 的站点 JSON、显式导航、挑战恢复重读和媒体下载共用该访问策略；默认间隔与并发上限由默认配置确定，实际准入次数和等待时长以运行报告为准。",
      ),
  })
  .strict();
const categorySlugPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^/?#]+(?:\/[^/?#]+)*$/u);
const categorySlugSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^/?#]+$/u);
const categoryReferenceSchema = z
  .object({
    id: targetIdSchema,
    kind: z.literal("category"),
    categoryId: topicIdSchema.describe("Linux.do 板块数字 ID。"),
    categorySlugPath: categorySlugPathSchema.describe(
      "板块路径中的 slug，不含 /c/ 前缀；多级板块以斜杠分隔。",
    ),
  })
  .strict();
const configuredTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: targetIdSchema.describe("此目标在本配置中的唯一名称。"),
      kind: z.literal("latest").describe("按最新主题流发现主题。"),
    })
    .strict(),
  categoryReferenceSchema,
  z
    .object({
      id: targetIdSchema.describe("此目标在本配置中的唯一名称。"),
      kind: z.literal("topic").describe("直接引用一个主题。"),
      topicId: topicIdSchema.describe("Linux.do 主题数字 ID。"),
    })
    .strict(),
]);
const actionTargetsSchema = z
  .array(configuredTargetSchema)
  .max(100)
  .describe("显式指定的目标列表，最多 100 项；同一列表中的 id 必须唯一。")
  .meta({
    examples: [
      [{ id: "latest", kind: "latest" }],
      [
        {
          id: "support",
          kind: "category",
          categoryId: 4,
          categorySlugPath: "support",
        },
      ],
    ],
  })
  .superRefine((targets, context) => {
    const ids = new Set<string>();
    for (const [index, target] of targets.entries()) {
      if (ids.has(target.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "本次运行参数中的目标 id 不能重复。",
        });
      }
      ids.add(target.id);
    }
  });
const checkParamsSchema = z
  .object({
    topicId: topicIdSchema
      .optional()
      .describe("只检查此主题；与 targets 互斥。")
      .meta({ examples: [2401] }),
    targets: actionTargetsSchema.optional(),
  })
  .strict()
  .superRefine((params, context) => {
    if (params.topicId !== undefined && params.targets !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "topicId 与 targets 不能同时使用。",
      });
    }
  })
  .describe(
    "检查登录状态以及指定主题或目标的当前可见范围；topicId 与 targets 互斥。",
  )
  .meta({
    examples: [
      { topicId: 2401 },
      { targets: [{ id: "latest", kind: "latest" }] },
    ],
  });
const collectionDateSchema = z
  .string()
  .regex(/^(?:today|yesterday|\d{4}-\d{2}-\d{2})$/u)
  .refine(
    (value) =>
      value === "today" || value === "yesterday" || isValidCalendarDate(value),
    "日期必须是 today、yesterday 或有效的 YYYY-MM-DD。",
  )
  .describe(
    "按触发时固定的参考时间解释的逻辑日期；必须是 today、yesterday 或有效的 YYYY-MM-DD 日期。",
  )
  .meta({ examples: ["today", "2026-10-28"] });
const collectionTimeZoneSchema = z
  .string()
  .min(1, "必须提供 IANA 时区。")
  .refine(isValidTimeZone, "时区必须是有效的 IANA 时区名称。")
  .describe(
    "解释 date 的 IANA 时区；必须是有效名称，且与 postCreatedRange 互斥。",
  )
  .meta({ examples: ["UTC", "Asia/Tokyo"] });
const postCreatedRangeSchema = z
  .object({
    from: z.iso
      .datetime({ offset: true })
      .describe("帖子创建时间的包含起点，必须带明确时区偏移。"),
    to: z.iso
      .datetime({ offset: true })
      .describe(
        "帖子创建时间的不包含终点，必须带明确时区偏移，且不得晚于本次动作实际开始时刻。",
      ),
    maxPages: z
      .number()
      .int()
      .positive()
      .max(1_000)
      .safe()
      .default(20)
      .describe(
        "帖子流扫描页数上限，省略时使用公开 schema 中声明的默认值；未确认分页耗尽时结果保留为部分状态，不等于 HTTP 请求总量。",
      ),
  })
  .strict()
  .superRefine((range, context) => {
    if (Date.parse(range.from) >= Date.parse(range.to)) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "区间起点必须早于不包含的终点。",
      });
    }
  })
  .describe(
    "按帖子创建时间筛选的左闭右开区间；其 to 不得晚于本次动作实际开始时刻；与 date/timeZone 模式互斥。",
  )
  .meta({
    examples: [
      {
        from: "2026-10-28T02:00:00.000Z",
        to: "2026-10-28T04:00:00.000Z",
        maxPages: 20,
      },
    ],
  });
const collectParamsSchema = z
  .object({
    topicId: topicIdSchema
      .optional()
      .describe("只处理此主题；与 targets 互斥。")
      .meta({ examples: [2401] }),
    targets: actionTargetsSchema.optional(),
    date: collectionDateSchema
      .optional()
      .describe(
        "按 timeZone 解释的逻辑日期；必须为 today、yesterday 或有效 YYYY-MM-DD 日期，与 postCreatedRange 互斥。",
      ),
    timeZone: collectionTimeZoneSchema
      .optional()
      .describe(
        "解释 date 的有效 IANA 时区名称；date 与 timeZone 成对提供，且与 postCreatedRange 互斥。",
      ),
    postCreatedRange: postCreatedRangeSchema
      .optional()
      .meta(postCreatedRangeSchema.meta() ?? {}),
    maxTopics: z
      .number()
      .int()
      .positive()
      .safe()
      .optional()
      .describe("本轮主题处理数量上限；省略时不额外限制主题数。")
      .meta({ examples: [25] }),
  })
  .strict()
  .superRefine((params, context) => {
    if (params.topicId !== undefined && params.targets !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "topicId 与 targets 不能同时使用。",
      });
    } else if (params.topicId === undefined && params.targets?.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message:
          "目标列表不能为空；省略 targets 可采集当前账号的全部可见板块。",
      });
    }
    if (params.postCreatedRange !== undefined) {
      if (params.date !== undefined || params.timeZone !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["postCreatedRange"],
          message: "帖子创建时间区间不能与 date/timeZone 模式混用。",
        });
      }
    } else {
      if (params.date === undefined) {
        context.addIssue({
          code: "custom",
          path: ["date"],
          message: "必须提供 date/timeZone 或 postCreatedRange。",
        });
      }
      if (params.timeZone === undefined) {
        context.addIssue({
          code: "custom",
          path: ["timeZone"],
          message: "日期模式必须提供 IANA 时区。",
        });
      }
    }
  })
  .describe(
    "必须使用 date 与 timeZone，或 postCreatedRange 其中一种模式；date 与 timeZone 成对提供且日期、时区有效，帖子区间的 from 必须早于 to 且 to 不得晚于动作实际开始时刻。topicId 与 targets 互斥；targets 省略时使用当前可见板块，显式列表不可为空且 id 不可重复。",
  )
  .meta({
    examples: [
      { date: "today", timeZone: "Asia/Tokyo" },
      {
        postCreatedRange: {
          from: "2026-10-28T02:00:00.000Z",
          to: "2026-10-28T04:00:00.000Z",
        },
      },
    ],
  });
const syncTargetIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all-visible") }).strict(),
  z
    .object({ kind: z.literal("targets"), targets: actionTargetsSchema })
    .strict(),
]);
const syncParamsSchema = z
  .object({
    targets: actionTargetsSchema.optional(),
    maxPages: z
      .number()
      .int()
      .positive()
      .max(100)
      .safe()
      .default(20)
      .describe("每个已接续范围扫描帖子流的页数上限，默认 20 页。"),
    maxRequests: z
      .number()
      .int()
      .positive()
      .max(500)
      .safe()
      .default(200)
      .describe("本轮主动来源请求总数上限，含等待获准的请求。"),
    maxElapsedMs: z
      .number()
      .int()
      .positive()
      .max(900_000)
      .safe()
      .default(300_000)
      .describe("本轮动作执行总时长上限，默认 5 分钟，最高 15 分钟。"),
  })
  .strict()
  .superRefine((params, context) => {
    if (params.targets?.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "目标列表不能为空；省略 targets 可处理当前可见范围。",
      });
    }
  });
const syncScopeReferenceSchema = z
  .object({ kind: z.enum(["category", "topic"]), id: topicIdSchema })
  .strict();
const syncScopeIdentitySchema = z
  .object({
    binId: z.string().min(1),
    identityId: z.string().min(1),
    origin: siteOriginSchema,
    scope: syncScopeReferenceSchema,
  })
  .strict();
const syncProgressEntrySchema = syncScopeIdentitySchema
  .extend({
    position: z.iso
      .datetime()
      .describe("本轮已分配的接续位置；不代表此前内容完整覆盖。"),
    lastRunId: z.string().min(1).describe("最近一次分配该位置的运行 ID。"),
  })
  .strict();
const syncPersistentStateSchema = z
  .object({
    version: z.literal(1),
    scopes: z.array(syncProgressEntrySchema),
    lastIntent: z
      .object({
        runId: z.string().min(1),
        upperBound: z.iso.datetime(),
        target: syncTargetIntentSchema,
        phase: z
          .enum([
            "preparing",
            "discovering-targets",
            "processing",
            "completed",
            "partial",
            "failed",
            "cancelled",
            "budget-exhausted",
          ])
          .describe("崩溃前最后持久化的阶段；非终结阶段表示该运行事实未知。"),
      })
      .strict()
      .describe("最近一次已持久记录的运行意图。")
      .optional(),
  })
  .strict()
  .describe(
    "Linux.do 当前接续状态；每项由 bin、访问身份、规范站点 origin 和真实板块或主题定位。position 是接续位置，不代表资料完整性。",
  );
const syncUnavailableStateSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: z
      .literal("persistent_state_unavailable")
      .describe("运行器无法读取或保存接续状态，已停止相关 sync 来源访问。"),
  })
  .strict();
const syncPublicStateSchema = z
  .union([syncPersistentStateSchema, syncUnavailableStateSchema])
  .describe(
    "bin get 中的 Linux.do 接续状态；可用时包含范围进度和最近意图，持久状态故障时只公开稳定原因。首次运行前该字段缺失。",
  );
const listCategoriesParamsSchema = z.object({}).strict();
type CategoryReference = z.infer<typeof categoryReferenceSchema>;
type DiscoveredCategory = {
  id: number;
  name: string;
  parentId: number | null;
  collectTarget: CategoryReference;
  children: DiscoveredCategory[];
};
const discoveredCategorySchema: z.ZodType<DiscoveredCategory> = z.lazy(() =>
  z
    .object({
      id: topicIdSchema,
      name: z.string().min(1),
      parentId: topicIdSchema.nullable(),
      collectTarget: categoryReferenceSchema,
      children: z.array(discoveredCategorySchema),
    })
    .strict(),
);
const listCategoriesOutputSchema = z
  .object({
    categories: z.array(discoveredCategorySchema),
    challengeRecovery: challengeRecoverySchema,
  })
  .strict();
type DiscourseCategory = {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly parent_category_id?: number | null | undefined;
  readonly subcategory_list?: readonly DiscourseCategory[] | null | undefined;
};
const discourseCategorySchema: z.ZodType<DiscourseCategory> = z.lazy(() =>
  z
    .object({
      id: topicIdSchema,
      name: z.string().min(1),
      slug: categorySlugSchema,
      parent_category_id: z
        .number()
        .int()
        .safe()
        .nonnegative()
        .nullable()
        .optional(),
      subcategory_list: z.array(discourseCategorySchema).nullable().optional(),
    })
    .passthrough(),
);
const discourseCategoryListSchema = z
  .object({
    category_list: z
      .object({ categories: z.array(discourseCategorySchema) })
      .passthrough(),
  })
  .passthrough();
const discoveredTopicSchema = z
  .object({ id: topicIdSchema, created_at: z.string().optional() })
  .passthrough();
const topicListResponseSchema = z
  .object({
    topic_list: z
      .object({
        topics: z.array(discoveredTopicSchema),
        more_topics_url: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const discoursePostFeedSchema = z
  .object({ latest_posts: z.array(z.unknown()) })
  .passthrough();
const postIdSchema = z.number().int().safe().positive();
const discourseReplyPostNumberSchema = z
  .union([
    postIdSchema,
    z
      .string()
      .regex(/^[1-9]\d*$/u)
      .transform(Number)
      .pipe(postIdSchema),
  ])
  .nullable()
  .optional();

const discourseSessionSchema = z
  .object({
    current_user: z
      .object({ id: postIdSchema, username: z.string().min(1) })
      .passthrough(),
  })
  .passthrough();

const discoursePostSchema = z
  .object({
    id: postIdSchema,
    topic_id: topicIdSchema.optional(),
    post_number: postIdSchema,
    cooked: z.string().nullable().optional(),
    username: z.string().optional(),
    name: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    reply_to_post_number: discourseReplyPostNumberSchema,
    reply_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const discourseTopicTagSchema = z.union([
  z.string(),
  z
    .object({
      id: postIdSchema,
      name: z.string(),
      slug: z.string(),
    })
    .passthrough(),
]);

const discourseTopicSchema = z
  .object({
    id: topicIdSchema,
    title: z.string().optional(),
    slug: z.string().optional(),
    created_at: z.string().optional(),
    category_id: topicIdSchema.nullable().optional(),
    tags: z.array(discourseTopicTagSchema).optional(),
    post_stream: z
      .object({
        posts: z.array(discoursePostSchema),
        stream: z.array(postIdSchema).optional(),
        isMegaTopic: z.boolean().optional(),
        lastId: postIdSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

const topicPostsResponseSchema = z
  .object({
    post_stream: z.object({ posts: z.array(z.unknown()) }).passthrough(),
  })
  .passthrough();

type DiscoursePost = z.infer<typeof discoursePostSchema>;
type DiscourseTopic = z.infer<typeof discourseTopicSchema>;
type ConfiguredTarget = z.infer<typeof configuredTargetSchema>;
type SourceAdapterConfig = z.output<typeof sourceAdapterConfigSchema>;
type SourceAccessReport = z.output<typeof sourceAccessReportSchema>;
type CollectParams = z.output<typeof collectParamsSchema>;
type DateCollectionParams = CollectParams & {
  readonly date: string;
  readonly timeZone: string;
};
type PostRangeCollectionParams = CollectParams & {
  readonly postCreatedRange: z.output<typeof postCreatedRangeSchema>;
};
type CheckParams = z.output<typeof checkParamsSchema>;
type SyncParams = z.output<typeof syncParamsSchema>;
type SyncPersistentState = z.output<typeof syncPersistentStateSchema>;
type SyncTargetIntent = z.output<typeof syncTargetIntentSchema>;
type SyncScopeReference = SyncPersistentState["scopes"][number]["scope"];
type SyncScopeTarget = Exclude<ConfiguredTarget, { readonly kind: "latest" }>;
type SyncScopePlan = {
  readonly target: SyncScopeTarget;
  readonly identity: z.output<typeof syncScopeIdentitySchema>;
  readonly mode: "initialized" | "continued" | "truncated" | "no-forward-range";
  readonly position: string;
  readonly previousPosition?: string;
  readonly range?: { readonly from: string; readonly to: string };
  readonly skippedBefore?: string;
};
type DiscourseProblem = {
  readonly code: string;
  readonly message: string;
  readonly impact: string;
  readonly suggestion: string;
  readonly requiresHuman: boolean;
};
const checkOutputSchema = z
  .object({
    challengeRecovery: challengeRecoverySchema,
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string().min(1)),
    basis: z.string().min(1),
    problems: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          impact: z.string().min(1),
          path: z.array(z.union([z.string(), z.number()])).optional(),
          suggestion: z.string().min(1),
          requiresHuman: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
const sourceAccessReportSchema = z
  .object({
    admittedAttempts: z
      .number()
      .int()
      .nonnegative()
      .describe("通过共享准入且即将调用主动传输的操作次数；失败尝试也计入。"),
    waitedMs: z
      .number()
      .int()
      .nonnegative()
      .describe("本动作等待共享来源准入的累计毫秒数。"),
    bySource: z
      .object({
        site: z.number().int().nonnegative(),
        media: z.number().int().nonnegative(),
      })
      .strict()
      .describe("按适配器声明的站点或媒体来源类别统计的主动准入操作数。"),
    rateLimitResponses: z
      .array(
        z
          .object({
            source: z.enum(["site", "media"]),
            origin: siteOriginSchema,
            status: z.union([z.literal(429), z.literal(503)]),
            retryAfter: z.string().max(256).optional(),
            outcome: z.enum(["cooled", "missing", "invalid", "past"]),
            observedAt: z.iso.datetime(),
            cooldownUntil: z.iso.datetime().optional(),
          })
          .strict(),
      )
      .describe("主动传输收到的429/503及其冷却处理结果；不会自动重试。"),
    pageRequestEventsObserved: z
      .object({
        total: z.number().int().nonnegative(),
        get: z.number().int().nonnegative(),
        nonGet: z.number().int().nonnegative(),
        sameOriginGet: z.number().int().nonnegative(),
        otherOriginGet: z.number().int().nonnegative(),
        byResourceType: z
          .object({
            document: z.number().int().nonnegative(),
            fetch: z.number().int().nonnegative(),
            xhr: z.number().int().nonnegative(),
            other: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict()
      .describe(
        "浏览器 Page request 事件观测，含自动子请求；与主动准入操作分开记录，不能当作全部 HTTP 数量。",
      ),
  })
  .strict()
  .describe("解释本次主动访问和浏览器自动请求观测的统计。");
const checkReportSchema = z
  .object({
    phase: z.enum([
      "preparing",
      "checking",
      "completed",
      "failed",
      "cancelled",
    ]),
    intent: checkParamsSchema.describe("来源访问前记录的检查主题或目标。"),
    sourceAccess: sourceAccessReportSchema,
  })
  .strict();
const listCategoriesReportSchema = z
  .object({
    phase: z.enum([
      "preparing",
      "discovering",
      "completed",
      "failed",
      "cancelled",
    ]),
    intent: z
      .literal("list-categories")
      .describe("来源访问前记录的板块发现意图。"),
    sourceAccess: sourceAccessReportSchema,
  })
  .strict();
const collectionIncompleteScopeSchema = z
  .object({
    scope: z.string().min(1),
    reasonCode: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
const collectOutputSchema = z
  .object({
    challengeRecovery: challengeRecoverySchema,
    completedScopes: z.array(z.string()).readonly(),
    collectionCompleteness: z.enum(["complete", "partial"]),
    incompleteScopes: z.array(collectionIncompleteScopeSchema).readonly(),
  })
  .strict();
const collectReportSchema = z
  .object({
    phase: z
      .enum([
        "preparing",
        "checking-access",
        "discovering-targets",
        "collecting",
        "completed",
        "failed",
        "cancelled",
      ])
      .describe("当前运行阶段；中断时保留最后一个已持久化阶段。"),
    referenceTime: z.iso
      .datetime()
      .describe("此运行固定使用的时间依据，不随排队或后续运行变化。"),
    intent: z
      .object({
        date: collectionDateSchema
          .optional()
          .describe("按时区解释的逻辑采集日期；与帖子创建时间区间互斥。"),
        timeZone: collectionTimeZoneSchema
          .optional()
          .describe("解释逻辑日期的 IANA 时区；与帖子创建时间区间互斥。"),
        postCreatedRange: postCreatedRangeSchema
          .optional()
          .describe("按帖子创建时间筛选的左闭右开区间及有限页数上限。"),
        target: z
          .discriminatedUnion("kind", [
            z
              .object({ kind: z.literal("topic"), topicId: topicIdSchema })
              .strict(),
            z.object({ kind: z.literal("all-visible") }).strict(),
            z
              .object({
                kind: z.literal("targets"),
                targets: actionTargetsSchema,
              })
              .strict(),
          ])
          .describe("触发时请求的主题、可见范围或显式目标。"),
        maxTopics: z
          .number()
          .int()
          .positive()
          .safe()
          .optional()
          .describe("本轮请求的主题数量上限。"),
      })
      .strict()
      .superRefine((intent, context) => {
        if (intent.postCreatedRange !== undefined) {
          if (intent.date !== undefined || intent.timeZone !== undefined) {
            context.addIssue({
              code: "custom",
              path: ["postCreatedRange"],
              message: "帖子创建时间区间不能与日期模式混用。",
            });
          }
        } else if (intent.date === undefined || intent.timeZone === undefined) {
          context.addIssue({
            code: "custom",
            path: [intent.date === undefined ? "date" : "timeZone"],
            message: "运行意图必须声明完整的日期模式或帖子创建时间区间。",
          });
        }
      })
      .describe("来源访问前记录的运行意图。"),
    window: z
      .object({
        from: z.iso.datetime().describe("实际范围的包含起点。"),
        to: z.iso.datetime().describe("实际范围的不包含终点。"),
      })
      .strict()
      .optional()
      .describe("本轮筛选的左闭右开创建时间范围，可按主题日期或帖子日期解释。"),
    discovery: z
      .enum(["not-started", "in-progress", "complete", "partial", "failed"])
      .describe("目标或帖子流发现状态；页数受限或无推进时保留部分覆盖。"),
    sourceAccess: sourceAccessReportSchema,
    scopes: z
      .array(
        z
          .object({
            scope: z
              .string()
              .min(1)
              .describe("本次运行已确认的 Linux.do 目标标识。"),
            from: z.iso.datetime().describe("该范围的包含起点。"),
            to: z.iso.datetime().describe("该范围的不包含终点。"),
            status: z
              .enum([
                "unstarted",
                "in-progress",
                "completed",
                "incomplete",
                "unknown",
              ])
              .describe("该范围本轮的最后确认状态。"),
          })
          .strict(),
      )
      .describe("动态发现并分配的实际范围及其状态。")
      .readonly(),
  })
  .strict();
const syncRangeSchema = z
  .object({
    from: z.iso.datetime().describe("本轮接续范围的包含起点。"),
    to: z.iso.datetime().describe("本轮接续范围的不包含终点。"),
  })
  .strict();
const syncScopeReportSchema = z
  .object({
    scope: syncScopeReferenceSchema,
    mode: z.enum(["initialized", "continued", "truncated", "no-forward-range"]),
    position: z.iso.datetime().describe("已持久化的接续位置，不代表完整覆盖。"),
    range: syncRangeSchema.optional(),
    skippedBefore: z.iso
      .datetime()
      .describe("被一小时上限截去的旧范围起点；本轮从 range.from 接续。")
      .optional(),
    status: z.enum([
      "initializing",
      "initialized",
      "unstarted",
      "in-progress",
      "completed",
      "partial",
      "unknown",
      "no-forward-range",
    ]),
  })
  .strict();
const syncBudgetReportSchema = z
  .object({
    maxRequests: z.number().int().positive(),
    maxElapsedMs: z.number().int().positive(),
    elapsedMs: z.number().int().nonnegative(),
    remainingMs: z.number().int().nonnegative(),
    stopReason: z
      .enum(["request-limit", "elapsed-time-limit", "wait-exceeds-budget"])
      .optional(),
  })
  .strict();
const syncReportSchema = z
  .object({
    phase: z.enum([
      "preparing",
      "discovering-targets",
      "processing",
      "completed",
      "partial",
      "failed",
      "cancelled",
      "budget-exhausted",
    ]),
    upperBound: z.iso.datetime().describe("动作执行开始时冻结的本轮上界 U。"),
    intent: syncTargetIntentSchema.describe("来源访问前记录的逻辑目标意图。"),
    discovery: z.enum([
      "not-started",
      "in-progress",
      "complete",
      "partial",
      "failed",
    ]),
    challengeRecovery: challengeRecoverySchema,
    budget: syncBudgetReportSchema,
    sourceAccess: sourceAccessReportSchema,
    scopes: z.array(syncScopeReportSchema).readonly(),
    observedPosts: z.number().int().nonnegative(),
    topicsExamined: z.number().int().nonnegative(),
    incompleteScopes: z.array(collectionIncompleteScopeSchema).readonly(),
  })
  .strict()
  .describe("本轮新增内容发现、接续位置、来源访问预算和未确认范围事实。");
const syncOutputSchema = z
  .object({
    challengeRecovery: challengeRecoverySchema,
    outcome: z.enum(["initialized", "advanced", "no-forward-range", "partial"]),
    upperBound: z.iso.datetime(),
    scopes: z
      .array(
        z
          .object({
            scope: syncScopeReferenceSchema,
            position: z.iso.datetime(),
            status: z.enum([
              "initialized",
              "advanced",
              "partial",
              "unknown",
              "unstarted",
              "no-forward-range",
            ]),
            range: syncRangeSchema.optional(),
            skippedBefore: z.iso.datetime().optional(),
          })
          .strict(),
      )
      .readonly(),
    observedPosts: z.number().int().nonnegative(),
    topicsExamined: z.number().int().nonnegative(),
    incompleteScopes: z.array(collectionIncompleteScopeSchema).readonly(),
  })
  .strict();
type CollectionReport = z.output<typeof collectReportSchema>;
type CollectionReportUpdate = Omit<CollectionReport, "sourceAccess"> & {
  readonly sourceAccess?: CollectionReport["sourceAccess"];
};
type SyncReport = z.output<typeof syncReportSchema>;
type CollectionIncompleteScope = z.infer<
  typeof collectionIncompleteScopeSchema
>;
type JsonResponse =
  | { readonly kind: "json"; readonly status: number; readonly value: unknown }
  | {
      readonly kind: "nonJson";
      readonly status: number;
      readonly recoveryFailure?: string;
    }
  | {
      readonly kind: "invalidJson";
      readonly status: number;
      readonly recoveryFailure?: string;
    }
  | {
      readonly kind: "networkError";
      readonly status: 0;
      readonly message: string;
    };
type TopicAccess =
  | {
      readonly kind: "available";
      readonly siteOrigin: URL;
      readonly siteNamespace: string;
      readonly topic: DiscourseTopic;
      readonly scopeIncomplete: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly availability: "unavailable" | "unknown";
      readonly problem: DiscourseProblem;
    };
type SessionAccess =
  | { readonly kind: "available" }
  | {
      readonly kind: "unavailable";
      readonly availability: "unavailable" | "unknown";
      readonly problem: DiscourseProblem;
    };
type SharedBrowser = {
  readonly page: Page;
  readonly request: APIRequestContext;
};
type PageFetchResponse = {
  readonly recoveryFailure?: string;
  readonly mitigated: string;
  readonly status: number;
  readonly contentType: string;
  readonly retryAfter?: string;
  readonly body: string;
};
type TopicPostRead = {
  readonly posts: readonly DiscoursePost[];
  readonly missingPostIds: readonly number[];
  readonly scopeIncomplete: boolean;
  readonly challenge?: DiscourseProblem;
};
type MediaCandidate = {
  readonly index: number;
  readonly kind: "image" | "attachment";
  readonly url: string;
  readonly path: string;
};
type PreparedBody = {
  readonly html: string;
  readonly text: string;
  readonly media: readonly MediaCandidate[];
};
type MediaDownload =
  | { readonly ok: true; readonly resource: ArchiveResourceMetadata }
  | { readonly ok: false; readonly reason: string };

const checkBasis =
  "通过正式持久浏览器的共享身份读取 Discourse 当前会话和指定主题 JSON；检查不下载媒体、不写入归档。";
const postBatchSize = 100;
const pageRecovery = new WeakMap<Page, ChallengeRecovery>();
const pageSourceAccess = new WeakMap<Page, PageSourceAccess>();

type PageRequestEvents = {
  total: number;
  get: number;
  nonGet: number;
  sameOriginGet: number;
  otherOriginGet: number;
  byResourceType: {
    document: number;
    fetch: number;
    xhr: number;
    other: number;
  };
};

type PageSourceAccess = {
  readonly client: NonNullable<SourceAdapterContext["sourceAccess"]>;
  readonly signal: AbortSignal;
  readonly siteOrigin: string;
  readonly events: PageRequestEvents;
  readonly rateLimitResponses: SourceAccessReport["rateLimitResponses"];
  readonly publish: ((report: SourceAccessReport) => Promise<void>) | undefined;
};

function sourceBudgetRemainingMs(
  client: NonNullable<SourceAdapterContext["sourceAccess"]>,
): number | undefined {
  const budget = client as Partial<SourceAccessBudgetClient>;
  return typeof budget.remainingMs === "function"
    ? budget.remainingMs()
    : undefined;
}

function activeRequestTimeoutMs(
  client: NonNullable<SourceAdapterContext["sourceAccess"]>,
  signal: AbortSignal,
  maximumMs: number,
): number {
  signal.throwIfAborted();
  const remaining = sourceBudgetRemainingMs(client);
  if (remaining === undefined) return maximumMs;
  if (remaining <= 0) {
    signal.throwIfAborted();
    throw new DOMException("来源访问预算已耗尽。", "TimeoutError");
  }
  return Math.min(maximumMs, remaining);
}

function emptySourceAccessReport(): SourceAccessReport {
  return {
    admittedAttempts: 0,
    waitedMs: 0,
    bySource: { site: 0, media: 0 },
    rateLimitResponses: [],
    pageRequestEventsObserved: {
      total: 0,
      get: 0,
      nonGet: 0,
      sameOriginGet: 0,
      otherOriginGet: 0,
      byResourceType: { document: 0, fetch: 0, xhr: 0, other: 0 },
    },
  };
}

function sourceAccessReport(state: PageSourceAccess): SourceAccessReport {
  const active: SourceAccessSnapshot = state.client.snapshot();
  return {
    ...active,
    rateLimitResponses: [...state.rateLimitResponses],
    pageRequestEventsObserved: {
      ...state.events,
      byResourceType: { ...state.events.byResourceType },
    },
  };
}

async function sourceResponseDetails(
  value: unknown,
): Promise<
  { readonly status: 429 | 503; readonly retryAfter?: string } | undefined
> {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const rawStatus = record.status;
  let status: number | undefined;
  if (typeof rawStatus === "number") status = rawStatus;
  else if (typeof rawStatus === "function") {
    const resolved = (rawStatus as () => unknown).call(value);
    if (typeof resolved === "number") status = resolved;
  }
  if (status !== 429 && status !== 503) return undefined;

  if (typeof record.retryAfter === "string")
    return { status, retryAfter: record.retryAfter };
  if (typeof record.headerValue === "function") {
    const header = await (
      record.headerValue as (name: string) => Promise<unknown>
    ).call(value, "retry-after");
    return {
      status,
      ...(typeof header === "string" ? { retryAfter: header } : {}),
    };
  }
  if (typeof record.headers === "function") {
    const headers = await (record.headers as () => unknown).call(value);
    if (typeof headers === "object" && headers !== null) {
      const retryAfter = (headers as Record<string, unknown>)["retry-after"];
      return {
        status,
        ...(typeof retryAfter === "string" ? { retryAfter } : {}),
      };
    }
  }
  return { status };
}

async function reportPageSourceAccess(state: PageSourceAccess): Promise<void> {
  await state.publish?.(sourceAccessReport(state));
}

async function withSourceAdmission<T>(
  page: Page,
  source: SourceAccessKind,
  url: URL,
  operation: () => Promise<T>,
): Promise<T> {
  const state = pageSourceAccess.get(page);
  if (state === undefined) throw new Error("页面没有绑定来源准入状态。");
  await reportPageSourceAccess(state);
  let result: T;
  try {
    const request: SourceAccessRequest = {
      groupId: "linuxdo",
      source,
      origin: url.origin,
    };
    result = await state.client.withAdmission(request, async () => {
      state.signal.throwIfAborted();
      const response = await operation();
      const details = await sourceResponseDetails(response);
      if (details !== undefined) {
        const observation: SourceAccessResponseObservation =
          await state.client.observeResponse(request, details);
        state.rateLimitResponses.push({
          source,
          origin: url.origin,
          status: details.status,
          ...(details.retryAfter === undefined
            ? {}
            : { retryAfter: details.retryAfter }),
          outcome: observation.outcome,
          observedAt: new Date(observation.observedAtEpochMs).toISOString(),
          ...(observation.cooldownUntilEpochMs === undefined
            ? {}
            : {
                cooldownUntil: new Date(
                  observation.cooldownUntilEpochMs,
                ).toISOString(),
              }),
        });
      }
      return response;
    });
  } catch (error) {
    await reportPageSourceAccess(state).catch(() => undefined);
    throw error;
  }
  await reportPageSourceAccess(state);
  return result;
}

function siteFromConfig(config: SourceAdapterConfig): {
  readonly origin: URL;
  readonly namespace: string;
} {
  const url = new URL(config.origin);
  return {
    origin: new URL(url.origin),
    namespace: `linuxdo:${url.host}`,
  };
}

async function withSharedBrowser<T>(
  context: Pick<
    SourceAdapterContext<SourceAdapterConfig>,
    "browser" | "signal" | "config" | "sourceAccess"
  >,
  callback: (browser: SharedBrowser) => Promise<T>,
  publishSourceAccess?: (report: SourceAccessReport) => Promise<void>,
): Promise<
  T & {
    readonly challengeRecovery: ChallengeRecoverySummary;
    readonly sourceAccess: SourceAccessReport;
  }
> {
  const connection = context.browser;
  if (connection === undefined || connection.protocol !== "playwright") {
    throw new Error("Linux.do 采集需要正式浏览器运行器提供 Playwright 连接。");
  }
  if (connection.playwrightVersion !== "1.64.2") {
    throw new Error(
      "Linux.do 信源适配器与浏览器运行器的 Playwright 版本不一致。",
    );
  }
  if (context.sourceAccess === undefined)
    throw new Error("Linux.do 运行上下文缺少声明的来源访问准入能力。");
  const sourceAccess = context.sourceAccess;

  const connectedBrowser = await chromium.connect(connection.endpoint);
  try {
    const persistentContext = connectedBrowser.contexts()[0];
    if (persistentContext === undefined) {
      throw new Error("正式浏览器没有暴露持久 context。");
    }
    const page = await persistentContext.newPage();
    const accessState: PageSourceAccess = {
      client: context.sourceAccess,
      signal: context.signal,
      siteOrigin: new URL(context.config.origin).origin,
      events: {
        total: 0,
        get: 0,
        nonGet: 0,
        sameOriginGet: 0,
        otherOriginGet: 0,
        byResourceType: { document: 0, fetch: 0, xhr: 0, other: 0 },
      },
      rateLimitResponses: [],
      publish: publishSourceAccess,
    };
    pageSourceAccess.set(page, accessState);
    page.on("request", (request) => {
      accessState.events.total++;
      const method = request.method().toUpperCase();
      if (method !== "GET") {
        accessState.events.nonGet++;
        return;
      }
      accessState.events.get++;
      try {
        if (new URL(request.url()).origin === accessState.siteOrigin)
          accessState.events.sameOriginGet++;
        else accessState.events.otherOriginGet++;
      } catch {
        accessState.events.otherOriginGet++;
      }
      const resourceType = request.resourceType();
      if (
        resourceType === "document" ||
        resourceType === "fetch" ||
        resourceType === "xhr"
      )
        accessState.events.byResourceType[resourceType]++;
      else accessState.events.byResourceType.other++;
    });
    const recovery = new ChallengeRecovery(
      page,
      context.signal,
      (href, timeoutMs, source) =>
        withSourceAdmission(page, source, new URL(href), async () => {
          return await page.goto(href, {
            waitUntil: "domcontentloaded",
            timeout: activeRequestTimeoutMs(
              sourceAccess,
              context.signal,
              timeoutMs,
            ),
          });
        }),
      () => sourceBudgetRemainingMs(sourceAccess),
    );
    pageRecovery.set(page, recovery);
    const cancel = () => {
      void page.close({ runBeforeUnload: false }).catch(() => undefined);
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    let output: T;
    try {
      context.signal.throwIfAborted();
      output = await callback({
        page,
        request: persistentContext.request,
      });
    } finally {
      context.signal.removeEventListener("abort", cancel);
      pageRecovery.delete(page);
      await page.close({ runBeforeUnload: false });
      await reportPageSourceAccess(accessState).catch(() => undefined);
      pageSourceAccess.delete(page);
    }
    return {
      ...output,
      challengeRecovery: { ...recovery.summary },
      sourceAccess: sourceAccessReport(accessState),
    };
  } finally {
    await connectedBrowser.close();
  }
}

async function readJson(
  page: Page,
  url: URL,
  signal: AbortSignal,
  valid: (value: unknown) => boolean,
): Promise<JsonResponse> {
  signal.throwIfAborted();
  let response: PageFetchResponse;
  try {
    await ensurePageOrigin(page, url, signal);
    response = await fetchInPage(page, url, "application/json", "text", valid);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return {
      kind: "networkError",
      status: 0,
      message: error instanceof Error ? error.message : "请求没有完成。",
    };
  }

  const contentType = response.contentType;
  if (
    !/(?:^|\s|;)application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(
      contentType,
    )
  ) {
    return {
      kind: "nonJson",
      status: response.status,
      ...(response.recoveryFailure === undefined
        ? {}
        : { recoveryFailure: response.recoveryFailure }),
    };
  }
  try {
    return {
      kind: "json",
      status: response.status,
      value: JSON.parse(response.body) as unknown,
    };
  } catch {
    return {
      kind: "invalidJson",
      status: response.status,
      ...(response.recoveryFailure === undefined
        ? {}
        : { recoveryFailure: response.recoveryFailure }),
    };
  }
}

async function ensurePageOrigin(
  page: Page,
  url: URL,
  signal: AbortSignal,
  source: SourceAccessKind = "site",
): Promise<void> {
  let currentOrigin = "";
  try {
    currentOrigin = new URL(page.url()).origin;
  } catch {
    // about:blank 没有可用于同源请求的站点 origin。
  }
  if (currentOrigin === url.origin) return;
  signal.throwIfAborted();
  const home = new URL("/", url);
  await withSourceAdmission(page, source, home, async () => {
    const state = pageSourceAccess.get(page);
    if (state === undefined) throw new Error("页面没有绑定来源准入状态。");
    return await page.goto(home.href, {
      waitUntil: "domcontentloaded",
      timeout: activeRequestTimeoutMs(state.client, signal, 30_000),
    });
  });
  if (new URL(page.url()).origin !== url.origin) {
    throw new Error("站点首页跳转到了不同的 origin，无法安全复用浏览器会话。");
  }
}

async function fetchInPage(
  page: Page,
  url: URL,
  accept: string,
  body: "text" | "base64",
  validJson?: (value: unknown) => boolean,
  validMedia?: (response: PageFetchResponse) => boolean,
  source: SourceAccessKind = "site",
): Promise<PageFetchResponse> {
  const accessState = pageSourceAccess.get(page);
  if (accessState === undefined) throw new Error("页面没有绑定来源准入状态。");
  const initialDeadline =
    performance.now() +
    activeRequestTimeoutMs(accessState.client, accessState.signal, 30_000);
  let response: PageFetchResponse;
  while (true) {
    const remaining = () => {
      accessState.signal.throwIfAborted();
      const budgetRemaining = sourceBudgetRemainingMs(accessState.client);
      if (budgetRemaining !== undefined && budgetRemaining <= 0) {
        accessState.signal.throwIfAborted();
        return 0;
      }
      return Math.max(
        0,
        Math.ceil(
          Math.min(
            initialDeadline - performance.now(),
            budgetRemaining ?? Number.POSITIVE_INFINITY,
          ),
        ),
      );
    };
    if (remaining() <= 0) throw new Error("页面读取时间已耗尽。");
    try {
      response = await fetchInPageOnce(
        page,
        url,
        accept,
        body,
        remaining(),
        source,
      );
      break;
    } catch (error) {
      if (
        page.isClosed() ||
        !(error instanceof Error) ||
        !error.message.includes("Execution context was destroyed") ||
        remaining() <= 0
      )
        throw error;
      // DOM 就绪后仍可能继续导航；所有重读共用初次读取期限。
      await page.waitForLoadState("domcontentloaded", { timeout: remaining() });
      await delay(Math.max(0, Math.min(50, remaining())));
    }
  }
  if (response.mitigated !== "challenge") return response;
  const recovery = pageRecovery.get(page);
  if (recovery === undefined) return response;
  const restored = await recovery.recover(
    url,
    (timeoutMs) => fetchInPageOnce(page, url, accept, body, timeoutMs, source),
    (value) => {
      if (value.status < 200 || value.status >= 300) return false;
      if (value.mitigated === "challenge") return false;
      if (body === "base64") {
        return validMedia?.(value) ?? false;
      }
      if (value.status !== 200) return false;
      if (!/application\/(?:[a-z0-9.+-]*\+)?json/iu.test(value.contentType)) {
        return false;
      }
      try {
        return validJson?.(JSON.parse(value.body) as unknown) ?? false;
      } catch {
        return false;
      }
    },
    (value) => value.mitigated === "challenge",
    source,
  );
  const result = restored ?? response;
  return result.mitigated === "challenge" &&
    recovery.failureMessage !== undefined
    ? { ...result, recoveryFailure: recovery.failureMessage }
    : result;
}

/** 人工复核提示沿用既有语义；它不作为自动点击的挑战识别依据。 */
function requiresPageReview(response: JsonResponse): boolean {
  return (
    response.status === 200 ||
    response.status === 403 ||
    ("recoveryFailure" in response && response.recoveryFailure !== undefined)
  );
}

function responseProblemMessage(
  response: JsonResponse,
  message: string,
): string {
  return "recoveryFailure" in response && response.recoveryFailure !== undefined
    ? `${message}${response.recoveryFailure}`
    : message;
}

async function fetchInPageOnce(
  page: Page,
  url: URL,
  accept: string,
  body: "text" | "base64",
  timeoutMs = 30_000,
  source: SourceAccessKind = "site",
): Promise<PageFetchResponse> {
  return await withSourceAdmission(page, source, url, async () => {
    const accessState = pageSourceAccess.get(page);
    if (accessState === undefined)
      throw new Error("页面没有绑定来源准入状态。");
    const boundedTimeoutMs = activeRequestTimeoutMs(
      accessState.client,
      accessState.signal,
      timeoutMs,
    );
    return await page.evaluate(
      async ({ href, acceptHeader, bodyType, expiresAt }) => {
        const controller = new AbortController();
        const remaining =
          expiresAt - (performance.timeOrigin + performance.now());
        if (remaining <= 0)
          throw new DOMException("请求期限已到。", "TimeoutError");
        const timeout = window.setTimeout(() => controller.abort(), remaining);
        try {
          const response = await fetch(href, {
            cache: "no-store",
            credentials: "include",
            headers: { accept: acceptHeader },
            signal: controller.signal,
          });
          let responseBody: string;
          if (bodyType === "text") {
            responseBody = await response.text();
          } else {
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = "";
            const chunkSize = 0x8000;
            for (
              let offset = 0;
              offset < bytes.byteLength;
              offset += chunkSize
            ) {
              binary += String.fromCharCode(
                ...bytes.subarray(offset, offset + chunkSize),
              );
            }
            responseBody = btoa(binary);
          }
          const retryAfter = response.headers.get("retry-after");
          return {
            mitigated: response.headers.get("cf-mitigated") ?? "",
            status: response.status,
            contentType: response.headers.get("content-type") ?? "",
            ...(retryAfter === null ? {} : { retryAfter }),
            body: responseBody,
          };
        } finally {
          window.clearTimeout(timeout);
        }
      },
      {
        href: url.href,
        acceptHeader: accept,
        bodyType: body,
        // 请求期限与日期解释解耦，验收的日期偏移不能改变浏览器剩余预算。
        expiresAt:
          performance.timeOrigin + performance.now() + boundedTimeoutMs,
      },
    );
  });
}

function topicScope(topicId: number): string {
  return `topic:${String(topicId)}`;
}

function checkResult(
  scope: string,
  availability: "available" | "unavailable" | "unknown",
  problems: readonly DiscourseProblem[],
  basis = checkBasis,
) {
  return {
    availability,
    scope: [scope],
    basis,
    problems: [...problems],
  };
}

function accessProblem(
  topicId: number,
  availability: "unavailable" | "unknown",
  problem: DiscourseProblem,
): TopicAccess {
  return { kind: "unavailable", availability, problem };
}

function networkProblem(topicId: number, message: string): TopicAccess {
  return accessProblem(topicId, "unknown", {
    code: "linuxdo_source_unreachable",
    message: `无法读取 Linux.do 主题：${message}`,
    impact: "本次检查无法确认所选主题是否可用，未读取或归档主题内容。",
    suggestion: "检查站点地址、网络连接后重新运行 check。",
    requiresHuman: false,
  });
}

async function readTopicAccess(
  page: Page,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
  signal: AbortSignal,
): Promise<TopicAccess> {
  const session = await readSessionAccess(page, site, signal);
  if (session.kind === "unavailable") {
    return accessProblem(topicId, session.availability, session.problem);
  }
  return await readTopic(page, site, topicId, signal);
}

async function readSessionAccess(
  page: Page,
  site: ReturnType<typeof siteFromConfig>,
  signal: AbortSignal,
): Promise<SessionAccess> {
  const sessionUrl = new URL("/session/current.json", site.origin);
  const session = await readJson(
    page,
    sessionUrl,
    signal,
    (value) => discourseSessionSchema.safeParse(value).success,
  );
  if (session.kind === "networkError") {
    return {
      kind: "unavailable",
      availability: "unknown",
      problem: {
        code: "linuxdo_source_unreachable",
        message: `无法读取 Linux.do 当前会话：${session.message}`,
        impact: "本次检查无法确认所选目标是否可用，未读取或归档主题内容。",
        suggestion: "检查站点地址、网络连接后重新运行 check。",
        requiresHuman: false,
      },
    };
  }
  if (session.status === 404) {
    return {
      kind: "unavailable",
      availability: "unavailable",
      problem: {
        code: "login_required",
        message: "Linux.do 浏览器会话已经退出登录。",
        impact: "本次检查或采集不能读取所选目标。",
        suggestion:
          "使用 human open 在持久浏览器中登录后重新触发 check 或 collect。",
        requiresHuman: true,
      },
    };
  }
  if (session.kind !== "json") {
    const challenge = requiresPageReview(session);
    return {
      kind: "unavailable",
      availability: challenge ? "unknown" : "unavailable",
      problem: {
        code: challenge
          ? "discourse_challenge_response"
          : "linuxdo_session_unavailable",
        message: responseProblemMessage(
          session,
          "Linux.do 当前会话端点没有返回可识别的 JSON。",
        ),
        impact: "本次检查或采集没有确认登录状态。",
        suggestion:
          "使用 human open 检查登录状态或完成站点要求的人工挑战，再重新触发动作。",
        requiresHuman: challenge,
      },
    };
  }
  if (session.status !== 200) {
    return {
      kind: "unavailable",
      availability: "unknown",
      problem: {
        code: "linuxdo_session_check_failed",
        message: `Linux.do 当前会话端点返回 HTTP ${String(session.status)}。`,
        impact: "本次检查或采集没有确认登录状态。",
        suggestion: "检查站点响应后重新运行 check。",
        requiresHuman: false,
      },
    };
  }
  const currentUser = discourseSessionSchema.safeParse(session.value);
  if (!currentUser.success) {
    return {
      kind: "unavailable",
      availability: "unknown",
      problem: {
        code: "discourse_session_response_invalid",
        message: "Linux.do 当前会话端点返回了无法识别的用户资料。",
        impact: "本次检查或采集没有确认登录状态。",
        suggestion:
          "使用 human open 查看站点响应，并在登录状态有效后重新触发动作。",
        requiresHuman: true,
      },
    };
  }

  return { kind: "available" };
}

async function readTopic(
  page: Page,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
  signal: AbortSignal,
): Promise<TopicAccess> {
  const topicUrl = new URL(`/t/${String(topicId)}.json`, site.origin);
  const topicResponse = await readJson(page, topicUrl, signal, (value) => {
    const parsed = discourseTopicSchema.safeParse(value);
    return parsed.success && parsed.data.id === topicId;
  });
  if (topicResponse.kind === "networkError") {
    return networkProblem(topicId, topicResponse.message);
  }
  // JSON 403 表示主题权限；HTML 403 可能是站点挑战，须交给人工处理。
  if (
    topicResponse.status === 404 ||
    (topicResponse.status === 403 && topicResponse.kind === "json")
  ) {
    return accessProblem(topicId, "unavailable", {
      code: "discourse_topic_unavailable",
      message: `已登录账号不能读取主题 ${String(topicId)}。`,
      impact: "本次检查或采集没有读取该主题。",
      suggestion: "确认主题 ID 和账号对该主题的访问权限后重新触发动作。",
      requiresHuman: false,
    });
  }
  if (topicResponse.kind !== "json") {
    const challenge = requiresPageReview(topicResponse);
    return accessProblem(topicId, challenge ? "unknown" : "unavailable", {
      code: challenge
        ? "discourse_topic_challenge_response"
        : "discourse_topic_response_invalid",
      message: responseProblemMessage(
        topicResponse,
        "Linux.do 主题端点没有返回可识别的 JSON。",
      ),
      impact: "本次检查或采集没有确认主题范围。",
      suggestion:
        "使用 human open 查看站点状态，完成必要的人工挑战后重新触发动作。",
      requiresHuman: challenge,
    });
  }
  if (topicResponse.status !== 200) {
    return accessProblem(topicId, "unknown", {
      code: "discourse_topic_request_failed",
      message: `Linux.do 主题端点返回 HTTP ${String(topicResponse.status)}。`,
      impact: "本次检查或采集没有确认主题范围。",
      suggestion: "检查站点响应后重新运行 check。",
      requiresHuman: false,
    });
  }

  const checkedTopic = discourseTopicSchema.safeParse(topicResponse.value);
  if (!checkedTopic.success || checkedTopic.data.id !== topicId) {
    return accessProblem(topicId, "unknown", {
      code: "discourse_topic_response_invalid",
      message: "Linux.do 主题响应缺少有效主题身份或帖子流。",
      impact: "本次检查或采集没有确认主题范围。",
      suggestion: "检查主题响应后重新运行 check。",
      requiresHuman: false,
    });
  }

  return {
    kind: "available",
    siteOrigin: site.origin,
    siteNamespace: site.namespace,
    topic: checkedTopic.data,
    scopeIncomplete:
      checkedTopic.data.post_stream.stream === undefined ||
      checkedTopic.data.post_stream.isMegaTopic === true,
  };
}

function failureFromProblem(problem: DiscourseProblem) {
  return sourceAdapterActionError({
    code: problem.code,
    message: problem.message,
    impact: problem.impact,
    suggestion: problem.suggestion,
    requiresHuman: problem.requiresHuman,
  });
}

function failureFromAccess(
  access: Extract<TopicAccess, { kind: "unavailable" }>,
) {
  return failureFromProblem(access.problem);
}

function targetScope(target: ConfiguredTarget): string {
  return `target:${target.id}`;
}

function targetListUrl(
  site: ReturnType<typeof siteFromConfig>,
  target: Extract<ConfiguredTarget, { kind: "latest" | "category" }>,
  maxTopics: number | undefined,
  dateWindow?: CollectionDateWindow,
): URL {
  const pathname =
    target.kind === "latest"
      ? "/latest.json"
      : `/c/${target.categorySlugPath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}/${String(target.categoryId)}/l/latest.json`;
  const url = new URL(pathname, site.origin);
  url.searchParams.set("per_page", String(Math.min(maxTopics ?? 100, 100)));
  if (dateWindow !== undefined) {
    url.searchParams.set("order", "created");
    url.searchParams.set("ascending", "false");
  }
  return url;
}

function paginationUrl(
  value: string,
  currentUrl: URL,
  target: Extract<ConfiguredTarget, { kind: "latest" | "category" }>,
  requireCreatedOrder = false,
): URL {
  let nextUrl: URL;
  try {
    nextUrl = new URL(value, currentUrl);
  } catch {
    throw sourceAdapterActionError({
      code: "discourse_topic_list_pagination_invalid",
      message: "Linux.do 列表分页链接格式无效。",
      impact: "本次只处理了分页链接前的主题。",
      suggestion: "检查受控目标的 Discourse 列表响应后重新运行 collect。",
      requiresHuman: false,
    });
  }
  const targetPath =
    target.kind === "latest"
      ? "/latest.json"
      : `/c/${target.categorySlugPath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}/${String(target.categoryId)}/l/latest.json`;
  const extensionlessTargetPath = targetPath.replace(/\.json$/u, "");
  const latestCategoryPath =
    target.kind === "category" &&
    (nextUrl.pathname === "/latest.json" || nextUrl.pathname === "/latest") &&
    nextUrl.searchParams.get("category") === String(target.categoryId);
  const validPath =
    nextUrl.pathname === targetPath ||
    nextUrl.pathname === extensionlessTargetPath ||
    latestCategoryPath;
  const validCategoryFilter =
    nextUrl.searchParams.get("category") === null ||
    (target.kind === "category" &&
      nextUrl.searchParams.get("category") === String(target.categoryId));
  if (
    nextUrl.origin !== currentUrl.origin ||
    !validPath ||
    !validCategoryFilter ||
    nextUrl.username.length > 0 ||
    nextUrl.password.length > 0 ||
    nextUrl.hash.length > 0
  ) {
    throw sourceAdapterActionError({
      code: "discourse_topic_list_pagination_invalid",
      message: "Linux.do 列表分页链接超出了所选目标范围。",
      impact: "本次只处理了分页链接前的主题。",
      suggestion: "检查受控目标的 Discourse 列表响应后重新运行 collect。",
      requiresHuman: false,
    });
  }
  if (
    requireCreatedOrder &&
    ((nextUrl.searchParams.has("order") &&
      nextUrl.searchParams.get("order") !== "created") ||
      (nextUrl.searchParams.has("ascending") &&
        nextUrl.searchParams.get("ascending") !== "false"))
  ) {
    throw sourceAdapterActionError({
      code: "discourse_topic_list_pagination_invalid",
      message: "Linux.do 日期采集分页链接改变了创建时间降序排序。",
      impact: "本次无法依据该分页顺序确认日期范围已穷尽。",
      suggestion:
        "检查列表分页是否保持 order=created&ascending=false 后，以相同固定日期重新运行 collect。",
      requiresHuman: false,
    });
  }
  if (nextUrl.pathname === extensionlessTargetPath) {
    nextUrl.pathname = targetPath;
  } else if (latestCategoryPath && nextUrl.pathname === "/latest") {
    nextUrl.pathname = "/latest.json";
  }
  for (const key of ["per_page", "order", "ascending"]) {
    const valueFromCurrent = currentUrl.searchParams.get(key);
    if (valueFromCurrent !== null && !nextUrl.searchParams.has(key)) {
      nextUrl.searchParams.set(key, valueFromCurrent);
    }
  }
  return nextUrl;
}

async function readTopicListPage(
  page: Page,
  url: URL,
  signal: AbortSignal,
): Promise<z.output<typeof topicListResponseSchema>["topic_list"]> {
  const response = await readJson(
    page,
    url,
    signal,
    (value) => topicListResponseSchema.safeParse(value).success,
  );
  if (response.kind === "networkError") {
    throw sourceAdapterActionError({
      code: "linuxdo_source_unreachable",
      message: `无法读取 Linux.do 主题列表：${response.message}`,
      impact: "本次没有确认该目标的列表范围。",
      suggestion: "检查站点地址、网络连接后重新运行 check 或 collect。",
      requiresHuman: false,
    });
  }
  if (
    response.status === 404 ||
    (response.status === 403 && response.kind === "json")
  ) {
    throw sourceAdapterActionError({
      code: "discourse_target_unavailable",
      message: "已登录账号不能读取所选 Linux.do 列表目标。",
      impact: "本次没有处理该目标的主题。",
      suggestion: "确认分类路径、目标可见性与账号权限后重新运行。",
      requiresHuman: false,
    });
  }
  if (response.kind !== "json") {
    const challenge = requiresPageReview(response);
    throw sourceAdapterActionError({
      code: challenge
        ? "discourse_target_challenge_response"
        : "discourse_target_response_invalid",
      message: responseProblemMessage(
        response,
        "Linux.do 列表端点没有返回可识别的 JSON。",
      ),
      impact: "本次没有确认该目标的列表范围。",
      suggestion:
        "使用 human open 查看站点状态，完成必要的人工挑战后重新触发动作。",
      requiresHuman: challenge,
    });
  }
  if (response.status !== 200) {
    throw sourceAdapterActionError({
      code: "discourse_target_request_failed",
      message: `Linux.do 列表端点返回 HTTP ${String(response.status)}。`,
      impact: "本次没有确认该目标的列表范围。",
      suggestion: "检查站点响应后重新运行 check 或 collect。",
      requiresHuman: false,
    });
  }
  const parsed = topicListResponseSchema.safeParse(response.value);
  if (!parsed.success) {
    throw sourceAdapterActionError({
      code: "discourse_topic_list_response_invalid",
      message: "Linux.do 列表响应缺少有效主题集合或分页信息。",
      impact: "本次没有确认该目标的完整列表范围。",
      suggestion: "检查站点列表响应后重新运行 check 或 collect。",
      requiresHuman: false,
    });
  }
  return parsed.data.topic_list;
}

function targetCheckResult(
  scopes: readonly string[],
  availability: "available" | "unavailable" | "unknown",
  problems: readonly DiscourseProblem[],
) {
  return {
    availability,
    scope: [...scopes],
    basis:
      "通过正式持久浏览器的共享身份读取 Discourse 当前会话及所选目标的第一列表页或主题 JSON；检查不下载媒体、不写入归档。",
    problems: [...problems],
  };
}

function listCheckDiagnostic(
  error: unknown,
):
  | { availability: "unavailable" | "unknown"; problem: DiscourseProblem }
  | undefined {
  if (!isSourceAdapterActionError(error)) return undefined;
  const { failure } = error;
  // 只转换列表读取和分页校验识别的源站结果；其他执行故障仍按失败上抛。
  const availabilityBySourceCode: Readonly<
    Record<string, "unavailable" | "unknown">
  > = {
    linuxdo_source_unreachable: "unknown",
    discourse_target_unavailable: "unavailable",
    discourse_target_challenge_response: "unknown",
    discourse_target_response_invalid: "unavailable",
    discourse_target_request_failed: "unknown",
    discourse_topic_list_response_invalid: "unknown",
    discourse_topic_list_pagination_invalid: "unknown",
  };
  const availability = availabilityBySourceCode[failure.code];
  if (availability === undefined || failure.suggestion === undefined) {
    return undefined;
  }
  return {
    availability,
    problem: {
      code: failure.code,
      message: failure.message,
      impact: failure.impact,
      suggestion: failure.suggestion,
      requiresHuman: failure.requiresHuman,
    },
  };
}

async function checkTopic(
  context: SourceAdapterContext<SourceAdapterConfig, typeof checkReportSchema>,
  params: CheckParams,
) {
  const site = siteFromConfig(context.config);
  let report = checkReportSchema.parse({
    phase: "preparing",
    intent: params,
    sourceAccess: emptySourceAccessReport(),
  });
  const publishReport = async (next: z.input<typeof checkReportSchema>) => {
    report = checkReportSchema.parse(next);
    await context.report(report);
  };
  await context.report(report);
  try {
    await publishReport({ ...report, phase: "checking" });
    const onAccess = (sourceAccess: SourceAccessReport) =>
      publishReport({ ...report, sourceAccess });
    let browserOutput: Awaited<ReturnType<typeof checkOneTopic>>;
    if (params.topicId !== undefined) {
      browserOutput = await checkOneTopic(
        context,
        site,
        params.topicId,
        onAccess,
      );
    } else {
      const targets = params.targets ?? [];
      const scopes = targets.map(targetScope);
      browserOutput = await withSharedBrowser(
        context,
        async ({ page }) => {
          const session = await readSessionAccess(page, site, context.signal);
          if (session.kind === "unavailable") {
            return targetCheckResult(scopes, session.availability, [
              session.problem,
            ]);
          }
          const problems: DiscourseProblem[] = [];
          let availability: "available" | "unavailable" | "unknown" =
            "available";
          for (const target of targets) {
            if (target.kind === "topic") {
              const access = await readTopic(
                page,
                site,
                target.topicId,
                context.signal,
              );
              if (access.kind === "unavailable") {
                problems.push(access.problem);
                availability = access.availability;
                continue;
              }
              const posts = await readTopicPosts(
                page,
                access.siteOrigin,
                access.topic,
                context.signal,
              );
              if (posts.challenge !== undefined) {
                problems.push(posts.challenge);
                availability = "unknown";
                continue;
              }
              problems.push(...topicProblems(access, posts));
            } else {
              // 单条主题足以诊断目标可读性，也能检查 Discourse 的下一页链接。
              const listUrl = targetListUrl(site, target, 1, undefined);
              try {
                const response = await readTopicListPage(
                  page,
                  listUrl,
                  context.signal,
                );
                if (
                  response.more_topics_url !== null &&
                  response.more_topics_url !== undefined
                ) {
                  paginationUrl(response.more_topics_url, listUrl, target);
                }
              } catch (error) {
                const diagnostic = listCheckDiagnostic(error);
                if (diagnostic === undefined) throw error;
                problems.push(diagnostic.problem);
                availability = diagnostic.availability;
                continue;
              }
            }
          }
          return targetCheckResult(scopes, availability, problems);
        },
        onAccess,
      );
    }
    const { sourceAccess, ...output } = browserOutput;
    await publishReport({ ...report, phase: "completed", sourceAccess });
    return output;
  } catch (error) {
    await publishReport({
      ...report,
      phase: context.signal.aborted ? "cancelled" : "failed",
    }).catch(() => undefined);
    throw error;
  }
}

function categoryListFailure(
  code: string,
  message: string,
  requiresHuman = false,
) {
  return sourceAdapterActionError({
    code,
    message,
    impact: "本次没有确认当前账号可见的 Linux.do 板块，也没有提交归档。",
    suggestion: requiresHuman
      ? "使用 human open 检查登录状态或完成站点要求的人工挑战，再重新发现板块。"
      : "检查当前账号的站点响应与板块访问权限后，重新运行 list-categories。",
    requiresHuman,
  });
}

function buildDiscoveredCategories(
  sourceCategories: readonly DiscourseCategory[],
): DiscoveredCategory[] {
  const categoriesById = new Map<number, DiscourseCategory>();
  const parentIdById = new Map<number, number | null>();
  const addCategory = (
    category: DiscourseCategory,
    nestedParentId?: number,
  ): void => {
    const declaredParentId = category.parent_category_id;
    if (
      nestedParentId !== undefined &&
      declaredParentId !== undefined &&
      declaredParentId !== null &&
      declaredParentId !== 0 &&
      declaredParentId !== nestedParentId
    ) {
      throw categoryListFailure(
        "discourse_category_list_response_invalid",
        "Linux.do 板块响应中的嵌套层级与父板块 ID 不一致。",
      );
    }
    const parentId =
      nestedParentId ??
      (declaredParentId === 0 ? null : (declaredParentId ?? null));
    if (!categoriesById.has(category.id))
      categoriesById.set(category.id, category);
    const existingParentId = parentIdById.get(category.id);
    if (existingParentId === undefined || existingParentId === null) {
      parentIdById.set(category.id, parentId);
    } else if (parentId !== null && parentId !== existingParentId) {
      throw categoryListFailure(
        "discourse_category_list_response_invalid",
        "Linux.do 板块响应为同一板块声明了不同的父板块。",
      );
    }
    for (const child of category.subcategory_list ?? [])
      addCategory(child, category.id);
  };
  for (const category of sourceCategories) addCategory(category);

  const slugPathById = new Map<number, string>();
  const resolveSlugPath = (
    categoryId: number,
    visiting: ReadonlySet<number> = new Set(),
  ): string => {
    const cached = slugPathById.get(categoryId);
    if (cached !== undefined) return cached;
    if (visiting.has(categoryId)) {
      throw categoryListFailure(
        "discourse_category_list_response_invalid",
        "Linux.do 板块响应包含循环的父子关系。",
      );
    }
    const category = categoriesById.get(categoryId);
    if (category === undefined) {
      throw categoryListFailure(
        "discourse_category_list_response_invalid",
        "Linux.do 板块响应缺少用于生成采集引用的板块。",
      );
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(categoryId);
    const parentId = parentIdById.get(categoryId) ?? null;
    const parent =
      parentId === undefined || parentId === null || parentId === 0
        ? undefined
        : categoriesById.get(parentId);
    const path =
      parent === undefined
        ? category.slug
        : `${resolveSlugPath(parent.id, nextVisiting)}/${category.slug}`;
    slugPathById.set(categoryId, path);
    return path;
  };

  const nodesById = new Map<number, DiscoveredCategory>();
  for (const category of categoriesById.values()) {
    nodesById.set(category.id, {
      id: category.id,
      name: category.name,
      parentId: parentIdById.get(category.id) ?? null,
      collectTarget: {
        id: `category-${String(category.id)}`,
        kind: "category",
        categoryId: category.id,
        categorySlugPath: resolveSlugPath(category.id),
      },
      children: [],
    });
  }

  const roots: DiscoveredCategory[] = [];
  for (const category of categoriesById.values()) {
    const node = nodesById.get(category.id);
    if (node === undefined) continue;
    const parentId = node.parentId;
    const parent = parentId === null ? undefined : nodesById.get(parentId);
    if (parent === undefined || parent === node) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  return roots;
}

async function listCategories(
  context: SourceAdapterContext<
    SourceAdapterConfig,
    typeof listCategoriesReportSchema
  >,
) {
  const site = siteFromConfig(context.config);
  let report = listCategoriesReportSchema.parse({
    phase: "preparing",
    intent: "list-categories",
    sourceAccess: emptySourceAccessReport(),
  });
  const publishReport = async (
    next: z.input<typeof listCategoriesReportSchema>,
  ) => {
    report = listCategoriesReportSchema.parse(next);
    await context.report(report);
  };
  await context.report(report);
  try {
    await publishReport({ ...report, phase: "discovering" });
    const browserOutput = await withSharedBrowser(
      context,
      async ({ page }) => {
        const session = await readSessionAccess(page, site, context.signal);
        if (session.kind === "unavailable") {
          throw sourceAdapterActionError({
            code: session.problem.code,
            message: session.problem.message,
            impact:
              "本次没有确认当前登录账号可见的 Linux.do 板块，也没有提交归档。",
            suggestion: session.problem.requiresHuman
              ? "使用 human open 在持久浏览器中登录或完成人工挑战，再重新运行 list-categories。"
              : "检查站点地址与当前会话后，重新运行 list-categories。",
            requiresHuman: session.problem.requiresHuman,
          });
        }
        return {
          categories: await readVisibleCategories(page, site, context.signal),
        };
      },
      (sourceAccess) => publishReport({ ...report, sourceAccess }),
    );
    const { sourceAccess, ...output } = browserOutput;
    await publishReport({ ...report, phase: "completed", sourceAccess });
    return output;
  } catch (error) {
    await publishReport({
      ...report,
      phase: context.signal.aborted ? "cancelled" : "failed",
    }).catch(() => undefined);
    throw error;
  }
}

async function readVisibleCategories(
  page: Page,
  site: ReturnType<typeof siteFromConfig>,
  signal: AbortSignal,
): Promise<DiscoveredCategory[]> {
  const categoriesUrl = new URL("/categories.json", site.origin);
  categoriesUrl.searchParams.set("include_subcategories", "true");
  const response = await readJson(
    page,
    categoriesUrl,
    signal,
    (value) => discourseCategoryListSchema.safeParse(value).success,
  );
  if (response.kind === "networkError") {
    throw categoryListFailure(
      "linuxdo_source_unreachable",
      `无法读取 Linux.do 板块列表：${response.message}`,
    );
  }
  if (response.kind !== "json") {
    throw categoryListFailure(
      requiresPageReview(response)
        ? "discourse_category_list_challenge_response"
        : "discourse_category_list_response_invalid",
      responseProblemMessage(response, "Linux.do 板块列表没有返回有效 JSON。"),
      requiresPageReview(response),
    );
  }
  if (response.status === 403 || response.status === 404) {
    throw categoryListFailure(
      "discourse_category_list_unavailable",
      "当前登录账号不能读取 Linux.do 板块列表。",
    );
  }
  if (response.status !== 200) {
    throw categoryListFailure(
      "discourse_category_list_request_failed",
      `Linux.do 板块列表端点返回 HTTP ${String(response.status)}。`,
    );
  }

  const parsed = discourseCategoryListSchema.safeParse(response.value);
  if (!parsed.success) {
    throw categoryListFailure(
      "discourse_category_list_response_invalid",
      "Linux.do 板块列表缺少有效的标识、名称或 slug。",
    );
  }
  return buildDiscoveredCategories(parsed.data.category_list.categories);
}

function categorySubtree(root: DiscoveredCategory): CategoryReference[] {
  const targets = [root.collectTarget];
  for (const child of root.children) targets.push(...categorySubtree(child));
  return targets;
}

function findCategory(
  categories: readonly DiscoveredCategory[],
  categoryId: number,
): DiscoveredCategory | undefined {
  for (const category of categories) {
    if (category.id === categoryId) return category;
    const child = findCategory(category.children, categoryId);
    if (child !== undefined) return child;
  }
  return undefined;
}

function collectTargets(
  selectedTargets: readonly ConfiguredTarget[] | undefined,
  categories: readonly DiscoveredCategory[],
): ConfiguredTarget[] {
  const targets: ConfiguredTarget[] = [];
  if (selectedTargets === undefined) {
    for (const category of categories)
      targets.push(...categorySubtree(category));
  } else {
    for (const target of selectedTargets) {
      if (target.kind !== "category") {
        targets.push(target);
        continue;
      }
      const category = findCategory(categories, target.categoryId);
      if (
        category === undefined ||
        category.collectTarget.categorySlugPath !== target.categorySlugPath
      ) {
        throw sourceAdapterActionError({
          code: "discourse_category_target_unavailable",
          message: "所选 Linux.do 板块已不在当前账号可见范围内。",
          impact: `采集范围 ${targetScope(target)} 未开始，板块树已变化。`,
          suggestion:
            "重新运行 list-categories 获取当前可见板块引用，再创建新的 collect 运行。",
          requiresHuman: false,
        });
      }
      targets.push(...categorySubtree(category));
    }
  }
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key =
      target.kind === "category"
        ? `category:${String(target.categoryId)}`
        : target.kind === "topic"
          ? `topic:${String(target.topicId)}`
          : "latest";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function syncScopeTargets(
  selectedTargets: readonly ConfiguredTarget[] | undefined,
  categories: readonly DiscoveredCategory[],
): Exclude<ConfiguredTarget, { readonly kind: "latest" }>[] {
  const selected = collectTargets(selectedTargets, categories);
  const expanded = selected.flatMap((target) =>
    target.kind === "latest"
      ? categories.flatMap((category) => categorySubtree(category))
      : [target],
  );
  const byScope = new Map<
    string,
    Exclude<ConfiguredTarget, { readonly kind: "latest" }>
  >();
  for (const target of expanded) {
    const key =
      target.kind === "category"
        ? `category:${String(target.categoryId)}`
        : `topic:${String(target.topicId)}`;
    byScope.set(key, target);
  }
  return [...byScope.values()].toSorted((first, second) => {
    const kindOrder = first.kind.localeCompare(second.kind);
    if (kindOrder !== 0) return kindOrder;
    const firstId =
      first.kind === "category" ? first.categoryId : first.topicId;
    const secondId =
      second.kind === "category" ? second.categoryId : second.topicId;
    return firstId - secondId;
  });
}

function syncScopeReference(
  target: Exclude<ConfiguredTarget, { readonly kind: "latest" }>,
): SyncScopeReference {
  return target.kind === "category"
    ? { kind: "category", id: target.categoryId }
    : { kind: "topic", id: target.topicId };
}

function syncScopeIdentity(
  context: SourceAdapterContext,
  origin: URL,
  scope: SyncScopeReference,
) {
  return {
    binId: context.binId,
    identityId: context.identityId,
    origin: origin.origin,
    scope,
  };
}

function syncScopeKey(
  identity: z.output<typeof syncScopeIdentitySchema>,
): string {
  return JSON.stringify([
    identity.binId,
    identity.identityId,
    identity.origin,
    identity.scope.kind,
    identity.scope.id,
  ]);
}

function existingSyncProgress(
  state: SyncPersistentState,
  identity: z.output<typeof syncScopeIdentitySchema>,
) {
  const key = syncScopeKey(identity);
  return state.scopes.find((entry) => syncScopeKey(entry) === key);
}

function syncRange(
  position: string,
  upperBound: string,
): { readonly from: string; readonly to: string } | undefined {
  const previousPosition = Date.parse(position);
  const upperBoundMs = Date.parse(upperBound);
  if (upperBoundMs <= previousPosition) return undefined;
  return {
    from: new Date(
      Math.max(previousPosition, upperBoundMs - 60 * 60 * 1_000),
    ).toISOString(),
    to: upperBound,
  };
}

function syncScopePlans(
  context: SourceAdapterContext,
  origin: URL,
  targets: readonly SyncScopeTarget[],
  state: SyncPersistentState,
  upperBound: string,
): SyncScopePlan[] {
  const upperBoundMs = Date.parse(upperBound);
  return targets.map((target) => {
    const scope = syncScopeReference(target);
    const identity = syncScopeIdentity(context, origin, scope);
    const previous = existingSyncProgress(state, identity);
    if (previous === undefined) {
      return { target, identity, mode: "initialized", position: upperBound };
    }
    const previousPosition = Date.parse(previous.position);
    if (upperBoundMs <= previousPosition) {
      return {
        target,
        identity,
        mode: "no-forward-range",
        position: previous.position,
        previousPosition: previous.position,
      };
    }
    const cutoff = upperBoundMs - 60 * 60 * 1_000;
    const range = syncRange(previous.position, upperBound);
    if (range === undefined) {
      return {
        target,
        identity,
        mode: "no-forward-range",
        position: previous.position,
      };
    }
    return {
      target,
      identity,
      mode: previousPosition < cutoff ? "truncated" : "continued",
      position: upperBound,
      previousPosition: previous.position,
      range,
      ...(previousPosition < cutoff
        ? { skippedBefore: previous.position }
        : {}),
    };
  });
}

function assignSyncPosition(
  state: SyncPersistentState,
  plan: SyncScopePlan,
  runId: string,
): SyncPersistentState {
  const nextEntry = syncProgressEntrySchema.parse({
    ...plan.identity,
    position: plan.position,
    lastRunId: runId,
  });
  const key = syncScopeKey(plan.identity);
  const index = state.scopes.findIndex((entry) => syncScopeKey(entry) === key);
  const scopes = [...state.scopes];
  if (index < 0) scopes.push(nextEntry);
  else scopes[index] = nextEntry;
  return syncPersistentStateSchema.parse({ ...state, scopes });
}

function syncStateJson(state: SyncPersistentState): JsonObject {
  const checked = syncPersistentStateSchema.parse(state);
  return JSON.parse(JSON.stringify(checked)) as JsonObject;
}

async function loadSyncPersistentState(
  context: SourceAdapterContext,
): Promise<SyncPersistentState> {
  if (context.persistentState === undefined) {
    throw sourceAdapterActionError({
      code: "linuxdo_sync_state_unavailable",
      message: "当前运行器没有提供 Linux.do 持久接续状态。",
      impact: "本次同步没有访问来源，也没有改变接续位置。",
      suggestion: "检查运行器版本与信源适配器部署状态后重新触发。",
      requiresHuman: false,
    });
  }
  let saved: JsonObject | undefined;
  try {
    saved = await context.persistentState.load();
  } catch {
    throw sourceAdapterActionError({
      code: "linuxdo_sync_state_unavailable",
      message: "无法读取 Linux.do 持久接续状态。",
      impact: "本次同步没有访问来源，也没有重置或推进接续位置。",
      suggestion: "检查运行器状态存储后重新触发；不要手动清空接续状态。",
      requiresHuman: true,
    });
  }
  if (saved === undefined) return { version: 1, scopes: [] };
  const checked = syncPersistentStateSchema.safeParse(saved);
  if (!checked.success) {
    throw sourceAdapterActionError({
      code: "linuxdo_sync_state_invalid",
      message: "Linux.do 持久接续状态不符合当前适配器声明。",
      impact: "本次同步已停止，没有重置或推进任何范围。",
      suggestion: "检查运行器状态存储并恢复有效备份后重新触发。",
      requiresHuman: true,
    });
  }
  return checked.data;
}

async function saveSyncPersistentState(
  context: SourceAdapterContext,
  state: SyncPersistentState,
): Promise<void> {
  if (context.persistentState === undefined) {
    throw sourceAdapterActionError({
      code: "linuxdo_sync_state_unavailable",
      message: "当前运行器没有提供 Linux.do 持久接续状态。",
      impact: "本次同步已停止，不能保证接续位置已保存。",
      suggestion: "检查运行器版本与信源适配器部署状态后重新触发。",
      requiresHuman: false,
    });
  }
  try {
    await context.persistentState.save(syncStateJson(state));
  } catch {
    throw sourceAdapterActionError({
      code: "linuxdo_sync_state_unavailable",
      message: "无法持久保存 Linux.do 接续状态。",
      impact: "本轮已停止，未继续访问来源；运行报告保留最后成功持久化的范围。",
      suggestion: "检查运行器状态存储后重新触发；不要手动清空接续状态。",
      requiresHuman: true,
    });
  }
}

function syncBudgetReport(
  budget: SourceAccessBudgetClient,
): SyncReport["budget"] {
  const snapshot = budget.budgetSnapshot();
  return {
    maxRequests: snapshot.maxRequests,
    maxElapsedMs: snapshot.maxElapsedMs,
    elapsedMs: snapshot.elapsedMs,
    remainingMs: snapshot.remainingMs,
    ...(snapshot.stopReason === undefined
      ? {}
      : { stopReason: snapshot.stopReason }),
  };
}

function syncScopeName(scope: SyncScopeReference): string {
  return `${scope.kind}:${String(scope.id)}`;
}

function syncIntent(params: SyncParams): SyncTargetIntent {
  return params.targets === undefined
    ? { kind: "all-visible" }
    : { kind: "targets", targets: params.targets };
}

function syncStateWithIntent(
  state: SyncPersistentState,
  context: SourceAdapterContext,
  upperBound: string,
  intent: SyncTargetIntent,
  phase: NonNullable<SyncPersistentState["lastIntent"]>["phase"],
): SyncPersistentState {
  return syncPersistentStateSchema.parse({
    ...state,
    lastIntent: {
      runId: context.runId,
      upperBound,
      target: intent,
      phase,
    },
  });
}

function syncPlanReport(
  plan: SyncScopePlan,
  status: SyncReport["scopes"][number]["status"],
  assigned = false,
): SyncReport["scopes"][number] {
  return {
    scope: syncScopeReference(plan.target),
    mode: plan.mode,
    position: assigned
      ? plan.position
      : (plan.previousPosition ?? plan.position),
    ...(plan.range === undefined ? {} : { range: plan.range }),
    ...(plan.skippedBefore === undefined
      ? {}
      : { skippedBefore: plan.skippedBefore }),
    status,
  };
}

function syncOutputStatus(
  status: SyncReport["scopes"][number]["status"],
): z.output<typeof syncOutputSchema>["scopes"][number]["status"] {
  switch (status) {
    case "initializing":
    case "initialized":
      return "initialized";
    case "in-progress":
      return "unknown";
    case "completed":
      return "advanced";
    case "partial":
      return "partial";
    case "unknown":
      return "unknown";
    case "unstarted":
      return "unstarted";
    case "no-forward-range":
      return "no-forward-range";
  }
}

function emptyChallengeRecovery(): ChallengeRecoverySummary {
  return { rounds: 0, elapsedMs: 0, successes: 0 };
}

type PostRangeTargetSelection = {
  readonly allVisible: boolean;
  readonly topicIds: ReadonlySet<number>;
  readonly categoryIds: ReadonlySet<number>;
};

async function resolvePostRangeTargets(
  page: Page,
  site: ReturnType<typeof siteFromConfig>,
  params: CollectParams,
  signal: AbortSignal,
): Promise<PostRangeTargetSelection> {
  if (params.topicId !== undefined) {
    return {
      allVisible: false,
      topicIds: new Set([params.topicId]),
      categoryIds: new Set(),
    };
  }
  if (params.targets === undefined) {
    return {
      allVisible: true,
      topicIds: new Set(),
      categoryIds: new Set(),
    };
  }
  const categories = params.targets.some(({ kind }) => kind === "category")
    ? await readVisibleCategories(page, site, signal)
    : [];
  const targets = collectTargets(params.targets, categories);
  if (targets.some(({ kind }) => kind === "latest")) {
    return {
      allVisible: true,
      topicIds: new Set(),
      categoryIds: new Set(),
    };
  }
  return {
    allVisible: false,
    topicIds: new Set(
      targets.flatMap((target) =>
        target.kind === "topic" ? [target.topicId] : [],
      ),
    ),
    categoryIds: new Set(
      targets.flatMap((target) =>
        target.kind === "category" ? [target.categoryId] : [],
      ),
    ),
  };
}

async function checkOneTopic(
  context: SourceAdapterContext<SourceAdapterConfig, typeof checkReportSchema>,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
  publishSourceAccess: (report: SourceAccessReport) => Promise<void>,
) {
  return await withSharedBrowser(
    context,
    async ({ page }) => {
      const access = await readTopicAccess(page, site, topicId, context.signal);
      if (access.kind === "unavailable") {
        return checkResult(topicScope(topicId), access.availability, [
          access.problem,
        ]);
      }
      const posts = await readTopicPosts(
        page,
        access.siteOrigin,
        access.topic,
        context.signal,
      );
      if (posts.challenge !== undefined) {
        return checkResult(topicScope(topicId), "unknown", [posts.challenge]);
      }
      const problems = topicProblems(access, posts);
      return checkResult(topicScope(topicId), "available", problems);
    },
    publishSourceAccess,
  );
}

function topicProblems(
  access: Extract<TopicAccess, { kind: "available" }>,
  posts: TopicPostRead,
): DiscourseProblem[] {
  const problems: DiscourseProblem[] = [];
  if (
    access.scopeIncomplete ||
    posts.scopeIncomplete ||
    posts.missingPostIds.length > 0
  ) {
    problems.push({
      code: "discourse_topic_scope_partial",
      message: "主题可读，但本次没有取得主题声明的全部帖子正文。",
      impact: "采集可以保存已返回的帖子，未观察到的帖子和关系不会自动撤回。",
      suggestion: "检查帖子端点响应与账号权限后重新运行 check 或 collect。",
      requiresHuman: false,
    });
  }
  if (
    posts.posts.some(
      (post) =>
        typeof post.cooked !== "string" || post.cooked.trim().length === 0,
    )
  ) {
    problems.push({
      code: "discourse_post_body_missing",
      message: "至少一条帖子没有返回可归档的正文 HTML。",
      impact: "本次采集会为受影响帖子保留缺失说明。",
      suggestion: "检查站点返回与账号权限后重新运行 collect。",
      requiresHuman: false,
    });
  }
  return problems;
}

function sourceKey(namespace: string, postId: number) {
  return { namespace, key: `post:${String(postId)}` };
}

function sourcePostUrl(
  siteOrigin: URL,
  topic: DiscourseTopic,
  post: DiscoursePost,
): string {
  const path =
    topic.slug === undefined || topic.slug.length === 0
      ? `/t/${String(topic.id)}/${String(post.post_number)}`
      : `/t/${encodeURIComponent(topic.slug)}/${String(topic.id)}/${String(post.post_number)}`;
  return new URL(path, siteOrigin).href;
}

function postRelation(
  namespace: string,
  topicId: number,
  rootPostId: number,
  post: DiscoursePost,
) {
  return {
    relationId: `${namespace}:topic:${String(topicId)}:reply:${String(post.id)}`,
    value: {
      from: sourceKey(namespace, rootPostId),
      to: { sourceKey: sourceKey(namespace, post.id) },
      name: "topic_reply",
      properties: {
        topicId,
        postNumber: post.post_number,
        replyToPostNumber: post.reply_to_post_number ?? 1,
      },
      cascade: true,
    },
  };
}

async function readTopicPosts(
  page: Page,
  siteOrigin: URL,
  topic: DiscourseTopic,
  signal: AbortSignal,
): Promise<TopicPostRead> {
  const postsById = new Map<number, DiscoursePost>();
  for (const post of topic.post_stream.posts) {
    if (post.topic_id === undefined || post.topic_id === topic.id) {
      postsById.set(post.id, post);
    }
  }
  const streamIds = topic.post_stream.stream ?? [];
  const requestedPostIds = [...new Set([...streamIds, ...postsById.keys()])];
  const missingPostIds = new Set<number>();

  // topic.json 的 posts 只含首批正文；stream 才列出后续可见帖子 ID。
  for (
    let offset = 0;
    offset < requestedPostIds.length;
    offset += postBatchSize
  ) {
    const batch = requestedPostIds.slice(offset, offset + postBatchSize);
    const unresolved = batch.filter((postId) => !postsById.has(postId));
    if (unresolved.length === 0) continue;

    const postsUrl = new URL(`/t/${String(topic.id)}/posts.json`, siteOrigin);
    for (const postId of unresolved) {
      postsUrl.searchParams.append("post_ids[]", String(postId));
    }
    const response = await readJson(page, postsUrl, signal, (value) => {
      const parsed = topicPostsResponseSchema.safeParse(value);
      if (!parsed.success) return false;
      const ids = new Set<number>();
      for (const value of parsed.data.post_stream.posts) {
        const post = discoursePostSchema.safeParse(value);
        if (
          post.success &&
          (post.data.topic_id === undefined || post.data.topic_id === topic.id)
        )
          ids.add(post.data.id);
      }
      return unresolved.every((id) => ids.has(id));
    });
    if (response.kind !== "json" && requiresPageReview(response)) {
      return {
        posts: [...postsById.values()].toSorted(
          (first, second) => first.post_number - second.post_number,
        ),
        missingPostIds: [...unresolved].toSorted(
          (first, second) => first - second,
        ),
        scopeIncomplete:
          topic.post_stream.stream === undefined ||
          topic.post_stream.isMegaTopic === true,
        challenge: {
          code: "discourse_topic_posts_challenge_response",
          message: responseProblemMessage(
            response,
            "Linux.do 帖子补取端点没有返回可识别的 JSON。",
          ),
          impact: "本次检查或采集不能确认主题的完整回复范围。",
          suggestion:
            "使用 human open 查看站点状态，完成必要的人工挑战后重新触发动作。",
          requiresHuman: true,
        },
      };
    }
    if (response.kind !== "json" || response.status !== 200) {
      for (const postId of unresolved) missingPostIds.add(postId);
      continue;
    }
    const envelope = topicPostsResponseSchema.safeParse(response.value);
    if (!envelope.success) {
      for (const postId of unresolved) missingPostIds.add(postId);
      continue;
    }
    for (const value of envelope.data.post_stream.posts) {
      const post = discoursePostSchema.safeParse(value);
      if (
        !post.success ||
        !unresolved.includes(post.data.id) ||
        (post.data.topic_id !== undefined && post.data.topic_id !== topic.id)
      ) {
        continue;
      }
      postsById.set(post.data.id, post.data);
    }
    for (const postId of unresolved) {
      if (!postsById.has(postId)) missingPostIds.add(postId);
    }
  }

  return {
    posts: [...postsById.values()].toSorted(
      (first, second) => first.post_number - second.post_number,
    ),
    missingPostIds: [...missingPostIds].toSorted(
      (first, second) => first - second,
    ),
    scopeIncomplete:
      topic.post_stream.stream === undefined ||
      topic.post_stream.isMegaTopic === true,
  };
}

async function readSelectedTopicPosts(
  page: Page,
  siteOrigin: URL,
  topicId: number,
  requestedPostIds: readonly number[],
  signal: AbortSignal,
): Promise<{
  readonly posts: ReadonlyMap<number, DiscoursePost>;
  readonly missingPostIds: readonly number[];
}> {
  const postsById = new Map<number, DiscoursePost>();
  for (
    let offset = 0;
    offset < requestedPostIds.length;
    offset += postBatchSize
  ) {
    const batch = [
      ...new Set(requestedPostIds.slice(offset, offset + postBatchSize)),
    ];
    const postsUrl = new URL(`/t/${String(topicId)}/posts.json`, siteOrigin);
    for (const postId of batch) {
      postsUrl.searchParams.append("post_ids[]", String(postId));
    }
    const response = await readJson(page, postsUrl, signal, (value) => {
      const parsed = topicPostsResponseSchema.safeParse(value);
      if (!parsed.success) return false;
      const ids = new Set<number>();
      for (const value of parsed.data.post_stream.posts) {
        const post = discoursePostSchema.safeParse(value);
        if (
          post.success &&
          (post.data.topic_id === undefined || post.data.topic_id === topicId)
        ) {
          ids.add(post.data.id);
        }
      }
      return batch.every((id) => ids.has(id));
    });
    if (response.kind !== "json" || response.status !== 200) continue;
    const envelope = topicPostsResponseSchema.safeParse(response.value);
    if (!envelope.success) continue;
    for (const value of envelope.data.post_stream.posts) {
      const post = discoursePostSchema.safeParse(value);
      if (
        post.success &&
        batch.includes(post.data.id) &&
        (post.data.topic_id === undefined || post.data.topic_id === topicId)
      ) {
        postsById.set(post.data.id, post.data);
      }
    }
  }
  return {
    posts: postsById,
    missingPostIds: requestedPostIds.filter((id) => !postsById.has(id)),
  };
}

type PostRangeScanIssue = {
  readonly reasonCode: string;
  readonly message: string;
  readonly discovery: "partial" | "failed";
};

type PostRangeScan = {
  readonly posts: readonly DiscoursePost[];
  readonly pagesRead: number;
  readonly complete: boolean;
  readonly issue?: PostRangeScanIssue;
};
type PostRangeReadCache = {
  scan?: Promise<PostRangeScan>;
  readonly topics: Map<number, Promise<TopicAccess>>;
};

async function readPostFeedPage(
  page: Page,
  siteOrigin: URL,
  before: number | undefined,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "page"; readonly posts: readonly DiscoursePost[] }
  | { readonly kind: "error"; readonly issue: PostRangeScanIssue }
> {
  const feedUrl = new URL("/posts.json", siteOrigin);
  if (before !== undefined) feedUrl.searchParams.set("before", String(before));
  const response = await readJson(page, feedUrl, signal, (value) => {
    const feed = discoursePostFeedSchema.safeParse(value);
    return (
      feed.success &&
      feed.data.latest_posts.every(
        (post) => discoursePostSchema.safeParse(post).success,
      )
    );
  });
  if (response.kind === "networkError") {
    return {
      kind: "error",
      issue: {
        reasonCode: "post_range_source_unreachable",
        message: `读取 Linux.do 帖子流失败：${response.message}`,
        discovery: "failed",
      },
    };
  }
  if (response.kind !== "json") {
    const challenged = requiresPageReview(response);
    return {
      kind: "error",
      issue: {
        reasonCode: challenged
          ? "post_range_challenge_response"
          : "post_range_response_invalid",
        message: responseProblemMessage(
          response,
          "Linux.do 帖子流没有返回可识别的 JSON。",
        ),
        discovery: "failed",
      },
    };
  }
  if (response.status !== 200) {
    return {
      kind: "error",
      issue: {
        reasonCode: "post_range_source_request_failed",
        message: `Linux.do 帖子流返回 HTTP ${String(response.status)}。`,
        discovery: "failed",
      },
    };
  }
  const feed = discoursePostFeedSchema.safeParse(response.value);
  if (!feed.success) {
    return {
      kind: "error",
      issue: {
        reasonCode: "post_range_response_invalid",
        message: "Linux.do 帖子流缺少有效的 latest_posts 数组。",
        discovery: "failed",
      },
    };
  }
  const posts: DiscoursePost[] = [];
  for (const value of feed.data.latest_posts) {
    const post = discoursePostSchema.safeParse(value);
    if (!post.success) {
      return {
        kind: "error",
        issue: {
          reasonCode: "post_range_response_invalid",
          message: "Linux.do 帖子流包含无法识别的帖子字段。",
          discovery: "failed",
        },
      };
    }
    posts.push(post.data);
  }
  return { kind: "page", posts };
}

function isPostFeedProgress(
  posts: readonly DiscoursePost[],
  before: number | undefined,
): boolean {
  let previous = before ?? Number.POSITIVE_INFINITY;
  for (const post of posts) {
    if (post.id >= previous) return false;
    previous = post.id;
  }
  return true;
}

async function scanPostCreatedRange(
  page: Page,
  siteOrigin: URL,
  signal: AbortSignal,
  maxPages: number,
): Promise<PostRangeScan> {
  const postsById = new Map<number, DiscoursePost>();
  let pagesRead = 0;
  let validPageCount = 0;
  let issue: PostRangeScanIssue | undefined;
  let historyExhausted = false;
  let stopScanning = false;
  let cursor: number | undefined;
  let initialMaxId: number | undefined;

  const readPage = async (before: number | undefined) => {
    signal.throwIfAborted();
    pagesRead += 1;
    const result = await readPostFeedPage(page, siteOrigin, before, signal);
    if (result.kind === "error") {
      issue ??= {
        ...result.issue,
        discovery: validPageCount === 0 ? "failed" : "partial",
      };
      stopScanning = true;
      return undefined;
    }
    validPageCount += 1;
    return result.posts;
  };
  const keepPosts = (posts: readonly DiscoursePost[]) => {
    for (const post of posts) {
      if (post.topic_id === undefined) {
        issue ??= {
          reasonCode: "post_range_topic_id_missing",
          message: `帖子 ${String(post.id)} 缺少主题 ID，无法确认其归档上下文。`,
          discovery: "partial",
        };
      }
      const createdAt =
        post.created_at === undefined
          ? Number.NaN
          : Date.parse(post.created_at);
      if (!Number.isFinite(createdAt)) {
        issue ??= {
          reasonCode: "post_range_created_at_invalid",
          message: `帖子 ${String(post.id)} 缺少有效创建时间，无法确认其是否位于所选区间。`,
          discovery: "partial",
        };
      }
      postsById.set(post.id, post);
    }
  };

  const firstPage = await readPage(undefined);
  if (firstPage === undefined) {
    return {
      posts: [],
      pagesRead,
      complete: false,
      ...(issue === undefined ? {} : { issue }),
    };
  }
  if (firstPage.length === 0) {
    historyExhausted = true;
  } else {
    initialMaxId = firstPage[0]?.id;
    keepPosts(firstPage);
    if (!isPostFeedProgress(firstPage, undefined)) {
      issue ??= {
        reasonCode: "post_range_cursor_not_advancing",
        message: "Linux.do 帖子流首页的 ID 没有严格递减。",
        discovery: "partial",
      };
      stopScanning = true;
    } else {
      cursor = firstPage.at(-1)?.id;
    }
  }

  while (!historyExhausted && !stopScanning && pagesRead < maxPages - 1) {
    const nextPage = await readPage(cursor);
    if (nextPage === undefined) break;
    if (nextPage.length === 0) {
      historyExhausted = true;
      break;
    }
    keepPosts(nextPage);
    if (!isPostFeedProgress(nextPage, cursor)) {
      issue ??= {
        reasonCode: "post_range_cursor_not_advancing",
        message: `Linux.do 帖子流在 before=${String(cursor)} 后重复帖子或没有严格推进。`,
        discovery: "partial",
      };
      stopScanning = true;
      break;
    }
    cursor = nextPage.at(-1)?.id;
  }

  let headVerified = false;
  if (!stopScanning && pagesRead < maxPages) {
    const baseline = initialMaxId ?? 0;
    let headCursor: number | undefined;
    while (pagesRead < maxPages) {
      const headPage = await readPage(headCursor);
      if (headPage === undefined) break;
      if (headPage.length === 0) {
        headVerified = true;
        break;
      }
      keepPosts(headPage);
      if (!isPostFeedProgress(headPage, headCursor)) {
        issue ??= {
          reasonCode: "post_range_cursor_not_advancing",
          message: "Linux.do 帖子流复查首页时 ID 没有严格递减。",
          discovery: "partial",
        };
        stopScanning = true;
        break;
      }
      if (headPage.some(({ id }) => id <= baseline)) {
        headVerified = true;
        break;
      }
      headCursor = headPage.at(-1)?.id;
    }
  }

  if (issue === undefined && (!historyExhausted || !headVerified)) {
    issue = {
      reasonCode: "post_range_page_limit_reached",
      message: `帖子流最多扫描 ${String(maxPages)} 页，尚未同时确认历史分页耗尽和首页复查。`,
      discovery: "partial",
    };
  }
  return {
    posts: [...postsById.values()],
    pagesRead,
    complete: historyExhausted && headVerified && issue === undefined,
    ...(issue === undefined ? {} : { issue }),
  };
}

async function prepareCookedBody(
  page: Page,
  cooked: string,
): Promise<PreparedBody> {
  return await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    const media: MediaCandidate[] = [];
    const imageLightboxes = new Set<Element>();
    let imageNumber = 0;
    let attachmentNumber = 0;

    for (const image of document.body.querySelectorAll("img")) {
      const source = image.getAttribute("src");
      const isEmoji =
        image.classList.contains("emoji") ||
        (source !== null && /\/(?:emoji|_avatar)(?:\/|\.)/iu.test(source));
      if (isEmoji) {
        image.replaceWith(
          document.createTextNode(
            image.getAttribute("alt") || image.getAttribute("title") || "",
          ),
        );
        continue;
      }
      if (source === null || source.length === 0) continue;

      const lightbox = image.closest("a.lightbox[href]");
      const url = lightbox?.getAttribute("href") ?? source;
      const index = media.length;
      const path = `body.images[${String(imageNumber)}]`;
      imageNumber += 1;
      image.setAttribute("data-binny-media-index", String(index));
      if (lightbox !== null) {
        lightbox.setAttribute("data-binny-media-index", String(index));
        imageLightboxes.add(lightbox);
      }
      media.push({ index, kind: "image", url, path });
    }

    for (const attachment of document.body.querySelectorAll(
      "a.attachment[href], a[data-download-href]",
    )) {
      // Discourse 的 lightbox 下载别名指向图片变体，不是另一份附件。
      if (imageLightboxes.has(attachment)) continue;
      const url =
        attachment.getAttribute("data-download-href") ??
        attachment.getAttribute("href");
      if (url === null || url.length === 0) continue;
      const index = media.length;
      attachment.setAttribute("data-binny-media-index", String(index));
      media.push({
        index,
        kind: "attachment",
        url,
        path: `body.attachments[${String(attachmentNumber)}]`,
      });
      attachmentNumber += 1;
    }

    return {
      html: document.body.innerHTML,
      text: (document.body.textContent ?? "").replace(/\s+/gu, " ").trim(),
      media,
    };
  }, cooked);
}

async function rewriteCookedBody(
  page: Page,
  html: string,
  references: ReadonlyMap<number, string>,
): Promise<{ readonly html: string; readonly text: string }> {
  return await page.evaluate(
    ({ source, replacements }) => {
      const document = new DOMParser().parseFromString(source, "text/html");
      for (const element of document.body.querySelectorAll(
        "[data-binny-media-index]",
      )) {
        const key = Number(element.getAttribute("data-binny-media-index"));
        const reference = replacements.find(([index]) => index === key)?.[1];
        if (reference !== undefined) {
          if (element instanceof HTMLImageElement) {
            element.setAttribute("src", reference);
            // 移除源站自适应候选，避免浏览器绕过已归档的 src 再次取图。
            element.removeAttribute("srcset");
            element
              .closest("picture")
              ?.querySelectorAll("source[srcset]")
              .forEach((source) => source.removeAttribute("srcset"));
          } else if (element instanceof HTMLAnchorElement) {
            element.setAttribute("href", reference);
            if (element.hasAttribute("data-download-href")) {
              element.setAttribute("data-download-href", reference);
            }
          }
        }
        element.removeAttribute("data-binny-media-index");
      }
      return {
        html: document.body.innerHTML,
        text: (document.body.textContent ?? "").replace(/\s+/gu, " ").trim(),
      };
    },
    { source: html, replacements: [...references.entries()] },
  );
}

async function downloadMedia(
  page: Page,
  request: APIRequestContext,
  kind: MediaCandidate["kind"],
  url: string,
  siteOrigin: URL,
  context: SourceAdapterContext,
): Promise<MediaDownload> {
  let mediaUrl: URL;
  try {
    mediaUrl = new URL(url, siteOrigin);
  } catch {
    return { ok: false, reason: "媒体地址格式无效。" };
  }
  if (
    (mediaUrl.protocol !== "http:" && mediaUrl.protocol !== "https:") ||
    mediaUrl.username.length > 0 ||
    mediaUrl.password.length > 0
  ) {
    return { ok: false, reason: "媒体地址不是可读取的 HTTP(S) 资源。" };
  }

  context.signal.throwIfAborted();
  let status: number;
  let mediaType: string | undefined;
  let body: Uint8Array;
  try {
    if (mediaUrl.origin === siteOrigin.origin) {
      await ensurePageOrigin(page, mediaUrl, context.signal, "media");
      const response = await fetchInPage(
        page,
        mediaUrl,
        "*/*",
        "base64",
        undefined,
        (value) =>
          mediaProblem(
            kind,
            value.contentType,
            Buffer.from(value.body, "base64").byteLength,
          ) === undefined,
        "media",
      );
      status = response.status;
      if (response.recoveryFailure !== undefined) {
        return { ok: false, reason: response.recoveryFailure };
      }
      mediaType = response.contentType;
      body = Buffer.from(response.body, "base64");
    } else {
      const response = await withSourceAdmission(
        page,
        "media",
        mediaUrl,
        async () => {
          const accessState = pageSourceAccess.get(page);
          if (accessState === undefined)
            throw new Error("页面没有绑定来源准入状态。");
          return await request.get(mediaUrl.href, {
            timeout: activeRequestTimeoutMs(
              accessState.client,
              accessState.signal,
              30_000,
            ),
          });
        },
      );
      status = response.status();
      mediaType = response.headers()["content-type"];
      body = await response.body();
    }
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "媒体请求没有完成。",
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      reason: `媒体端点返回 HTTP ${String(status)}。`,
    };
  }

  mediaType =
    (mediaType ?? "application/octet-stream")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "application/octet-stream";
  const problem = mediaProblem(kind, mediaType, body.byteLength);
  if (problem !== undefined) return { ok: false, reason: problem };

  const upload = await context.resources.upload(
    new Blob([Uint8Array.from(body)], { type: mediaType }),
    mediaType,
  );
  return upload.ok
    ? { ok: true, resource: upload.resource }
    : { ok: false, reason: upload.error.message };
}

function mediaProblem(
  kind: MediaCandidate["kind"],
  contentType: string,
  byteLength: number,
): string | undefined {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    (kind === "image" &&
      (mediaType.startsWith("text/") ||
        mediaType === "application/json" ||
        mediaType.endsWith("+json")))
  )
    return "媒体端点返回了页面或结构化内容，未取得媒体字节。";
  if (byteLength === 0) return "媒体端点返回了空文件。";
  return undefined;
}

function modifiedAt(post: DiscoursePost): string | undefined {
  if (post.updated_at === undefined) return undefined;
  const timestamp = Date.parse(post.updated_at);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function postDiagnostics(
  topicId: number,
  missingPostIds: readonly number[],
  scopeIncomplete: boolean,
) {
  const diagnostics = [];
  if (missingPostIds.length > 0) {
    diagnostics.push({
      code: "discourse_posts_missing",
      message: `主题 ${String(topicId)} 的帖子流声明了 ${String(missingPostIds.length)} 个帖子，但本次没有返回其正文。`,
      details: { topicId, postIds: [...missingPostIds] },
      suggestion:
        "检查主题访问权限与帖子端点响应后重新运行 collect；本次未观察到的旧关系不会自动撤回。",
    });
  }
  if (scopeIncomplete) {
    diagnostics.push({
      code: "discourse_topic_scope_incomplete",
      message: `主题 ${String(topicId)} 没有返回可枚举的完整帖子 ID 列表。`,
      details: { topicId },
      suggestion: "本次只保存已返回的帖子，不会因有限观察撤回已有条目或关系。",
    });
  }
  return diagnostics;
}

async function archivePost(
  page: Page,
  request: APIRequestContext,
  context: SourceAdapterContext,
  siteOrigin: URL,
  siteNamespace: string,
  topic: DiscourseTopic,
  post: DiscoursePost,
  diagnostics: ReturnType<typeof postDiagnostics>,
  mediaCache: Map<string, Promise<MediaDownload>>,
) {
  const prepared = await prepareCookedBody(page, post.cooked ?? "");
  const references = new Map<number, string>();
  const resources: ArchiveResourceMetadata[] = [];
  const missing: { path: string; reason: string }[] = [];
  const itemDiagnostics: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly suggestion?: string;
  }[] = post.post_number === 1 ? [...diagnostics] : [];

  const downloads = await Promise.all(
    prepared.media.map(async (candidate) => {
      let mediaUrl = candidate.url;
      try {
        mediaUrl = new URL(candidate.url, siteOrigin).href;
      } catch {
        // downloadMedia 将无效地址转换为可见的部分采集结果。
      }
      let pending = mediaCache.get(mediaUrl);
      if (pending === undefined) {
        pending = downloadMedia(
          page,
          request,
          candidate.kind,
          mediaUrl,
          siteOrigin,
          context,
        );
        mediaCache.set(mediaUrl, pending);
      }
      return { candidate, downloaded: await pending };
    }),
  );
  for (const { candidate, downloaded } of downloads) {
    if (downloaded.ok) {
      const mediaPart = archivedMedia(downloaded.resource);
      references.set(candidate.index, mediaPart.reference);
      resources.push(downloaded.resource);
    } else {
      // 缺失原因属于版本状态；具体响应差异只记在本次观察诊断中。
      missing.push({
        path: candidate.path,
        reason: "媒体资源未能归档。",
      });
      itemDiagnostics.push({
        code: "linuxdo_media_unavailable",
        message: `帖子 ${String(post.id)} 的媒体未能归档：${downloaded.reason}`,
        details: {
          topicId: topic.id,
          postId: post.id,
          path: candidate.path,
          reason: downloaded.reason,
        },
        suggestion: "检查媒体端点响应后重新运行 collect。",
      });
    }
  }

  if ((post.cooked ?? "").trim().length === 0) {
    missing.push({
      path: "body.html",
      reason: "帖子没有返回可归档的 cooked 正文。",
    });
  }
  const body = await rewriteCookedBody(page, prepared.html, references);
  const searchText = [
    post.post_number === 1 ? topic.title?.trim() : undefined,
    body.text.trim(),
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n");
  const sourceModifiedAt = modifiedAt(post);
  const state = {
    sourceKey: sourceKey(siteNamespace, post.id),
    sourceRef: sourcePostUrl(siteOrigin, topic, post),
    ...(sourceModifiedAt === undefined ? {} : { sourceModifiedAt }),
    metadata: {
      topicId: topic.id,
      postId: post.id,
      postNumber: post.post_number,
      author: {
        username: post.username ?? null,
        name: post.name ?? null,
      },
      ...(post.created_at === undefined ? {} : { createdAt: post.created_at }),
      ...(post.post_number === 1
        ? {
            topic: {
              title: topic.title ?? null,
              slug: topic.slug ?? null,
              categoryId: topic.category_id ?? null,
              tags:
                topic.tags?.map((tag) =>
                  typeof tag === "string" ? tag : tag.name,
                ) ?? [],
              ...(topic.created_at === undefined
                ? {}
                : { createdAt: topic.created_at }),
            },
          }
        : {}),
    },
    body: { html: body.html, text: body.text, searchText },
    resources: [...archiveResourceManifest(resources)],
    capture: {
      scope: {
        origin: siteOrigin.origin,
        topicId: topic.id,
        postId: post.id,
        postNumber: post.post_number,
      },
      completeness:
        missing.length === 0 ? ("complete" as const) : ("partial" as const),
      missing,
    },
    ...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
  };
  return { state, complete: missing.length === 0 };
}

async function collectPostRangeTopic(
  context: SourceAdapterContext,
  page: Page,
  request: APIRequestContext,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
  inRangePosts: readonly DiscoursePost[],
  selection: PostRangeTargetSelection,
  maxTopics: number | undefined,
  collectedTopics: number,
  completedScopes: string[],
  incompleteScopes: CollectionIncompleteScope[],
  seenPostIds?: Set<number>,
  readCache?: PostRangeReadCache,
): Promise<"processed" | "skipped" | "limited"> {
  let accessPromise = readCache?.topics.get(topicId);
  if (accessPromise === undefined) {
    accessPromise = readTopic(page, site, topicId, context.signal);
    readCache?.topics.set(topicId, accessPromise);
  }
  const access = await accessPromise;
  if (access.kind === "unavailable") {
    incompleteScopes.push({
      scope: topicScope(topicId),
      reasonCode: access.problem.code,
      message: access.problem.message,
    });
    return "processed";
  }
  if (
    !selection.allVisible &&
    !selection.topicIds.has(topicId) &&
    !selection.categoryIds.has(access.topic.category_id ?? -1)
  ) {
    return "skipped";
  }
  if (maxTopics !== undefined && collectedTopics >= maxTopics) {
    incompleteScopes.push({
      scope: "post-created-range",
      reasonCode: "post_range_topic_limit_reached",
      message: `已达到显式 maxTopics=${String(maxTopics)}；当前符合目标的主题 ${String(topicId)} 未处理。`,
    });
    return "limited";
  }

  const topicRoot = access.topic.post_stream.posts.find(
    ({ post_number }) => post_number === 1,
  );
  const rootCandidateId = topicRoot?.id ?? access.topic.post_stream.stream?.[0];
  const requestedBodyIds = inRangePosts
    .filter((post) => post.cooked === undefined)
    .map(({ id }) => id);
  if (topicRoot?.cooked === undefined && rootCandidateId !== undefined) {
    requestedBodyIds.push(rootCandidateId);
  }
  const selectedRead = await readSelectedTopicPosts(
    page,
    access.siteOrigin,
    topicId,
    [...new Set(requestedBodyIds)],
    context.signal,
  );
  const selectedPosts = new Map<number, DiscoursePost>();
  for (const post of inRangePosts) selectedPosts.set(post.id, post);
  for (const [postId, post] of selectedRead.posts) {
    const current = selectedPosts.get(postId);
    selectedPosts.set(
      postId,
      current === undefined ? post : { ...current, ...post },
    );
  }

  const rootFromRange = [...selectedPosts.values()].find(
    ({ post_number }) => post_number === 1,
  );
  const fetchedRoot =
    rootCandidateId === undefined
      ? undefined
      : selectedRead.posts.get(rootCandidateId);
  const resolvedTopicRoot =
    topicRoot === undefined
      ? fetchedRoot
      : fetchedRoot === undefined
        ? topicRoot
        : { ...topicRoot, ...fetchedRoot };
  const root = rootFromRange ?? resolvedTopicRoot;
  if (root === undefined || root.post_number !== 1) {
    incompleteScopes.push({
      scope: topicScope(topicId),
      reasonCode: "post_range_topic_root_unavailable",
      message: `主题 ${String(topicId)} 的必要主帖上下文不可读；本次没有归档其区间回复。`,
    });
    return "processed";
  }

  const postsToArchive = [
    root,
    ...[...selectedPosts.values()].filter(({ id }) => id !== root.id),
  ]
    .filter(({ id }) => !seenPostIds?.has(id))
    .toSorted(
      (first, second) =>
        first.post_number - second.post_number || first.id - second.id,
    );
  const diagnostics = postDiagnostics(
    topicId,
    selectedRead.missingPostIds,
    false,
  );
  const mediaCache = new Map<string, Promise<MediaDownload>>();
  let complete = selectedRead.missingPostIds.length === 0;
  const incompleteMessages: string[] = [];
  if (selectedRead.missingPostIds.length > 0) {
    incompleteMessages.push(
      `帖子 ${selectedRead.missingPostIds.map(String).join("、")} 的正文没有补取成功。`,
    );
  }
  for (
    let offset = 0;
    offset < postsToArchive.length;
    offset += postBatchSize
  ) {
    context.signal.throwIfAborted();
    const batch = postsToArchive.slice(offset, offset + postBatchSize);
    const items: Awaited<ReturnType<typeof archivePost>>["state"][] = [];
    for (const post of batch) {
      const archived = await archivePost(
        page,
        request,
        context,
        access.siteOrigin,
        access.siteNamespace,
        access.topic,
        post,
        diagnostics,
        mediaCache,
      );
      items.push(archived.state);
      complete &&= archived.complete;
      if (!archived.complete) {
        incompleteMessages.push(
          ...archived.state.capture.missing.map(
            ({ path, reason }) => `${path}：${reason}`,
          ),
        );
      }
    }
    const relations = batch
      .filter(({ id }) => id !== root.id)
      .map((post) =>
        postRelation(access.siteNamespace, topicId, root.id, post),
      );
    await context.archive.submit({ items, relations });
    for (const post of batch) {
      seenPostIds?.add(post.id);
      completedScopes.push(
        selectedPosts.has(post.id)
          ? `post:${String(post.id)}`
          : `context:post:${String(post.id)}`,
      );
    }
  }
  if (!complete) {
    incompleteScopes.push({
      scope: topicScope(topicId),
      reasonCode: "post_range_archive_partial",
      message:
        incompleteMessages.length === 0
          ? `主题 ${String(topicId)} 的部分区间内容没有完整归档。`
          : incompleteMessages.join("；"),
    });
  }
  return "processed";
}

async function collectTopicContent(
  context: SourceAdapterContext,
  page: Page,
  request: APIRequestContext,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
  completedScopes: string[],
  knownAccess?: TopicAccess,
): Promise<CollectionIncompleteScope | undefined> {
  const access =
    knownAccess ?? (await readTopic(page, site, topicId, context.signal));
  if (access.kind === "unavailable") throw failureFromAccess(access);

  const read = await readTopicPosts(
    page,
    access.siteOrigin,
    access.topic,
    context.signal,
  );
  if (read.challenge !== undefined) {
    throw failureFromProblem(read.challenge);
  }
  const root = read.posts.find(({ post_number }) => post_number === 1);
  if (root === undefined) {
    throw sourceAdapterActionError({
      code: "discourse_topic_root_missing",
      message: `主题 ${String(topicId)} 的主帖没有出现在可读取帖子中。`,
      impact: "本次没有提交主题帖子或关系，已有归档保持不变。",
      suggestion: "检查当前账号对主帖的访问权限后重新运行 collect。",
      requiresHuman: false,
    });
  }

  const diagnostics = postDiagnostics(
    access.topic.id,
    read.missingPostIds,
    read.scopeIncomplete,
  );
  const mediaCache = new Map<string, Promise<MediaDownload>>();
  const incompleteMessages = diagnostics.map(({ message }) => message);
  let allPostsComplete = true;
  for (let offset = 0; offset < read.posts.length; offset += postBatchSize) {
    context.signal.throwIfAborted();
    const batch = read.posts.slice(offset, offset + postBatchSize);
    const items: Awaited<ReturnType<typeof archivePost>>["state"][] = [];
    for (const post of batch) {
      const archived = await archivePost(
        page,
        request,
        context,
        access.siteOrigin,
        access.siteNamespace,
        access.topic,
        post,
        diagnostics,
        mediaCache,
      );
      items.push(archived.state);
      allPostsComplete &&= archived.complete;
      if (!archived.complete) {
        incompleteMessages.push(
          ...archived.state.capture.missing.map(
            ({ path, reason }) => `${path}：${reason}`,
          ),
        );
      }
    }
    const relations = batch
      .filter(({ post_number }) => post_number !== 1)
      .map((post) =>
        postRelation(access.siteNamespace, access.topic.id, root.id, post),
      );
    await context.archive.submit({ items, relations });
    completedScopes.push(...batch.map(({ id }) => `post:${String(id)}`));
  }
  if (
    read.missingPostIds.length === 0 &&
    !read.scopeIncomplete &&
    allPostsComplete &&
    read.posts.every((post) => post.cooked !== undefined)
  ) {
    completedScopes.push(topicScope(access.topic.id));
    return undefined;
  }
  return {
    scope: topicScope(access.topic.id),
    reasonCode: diagnostics[0]?.code ?? "linuxdo_topic_archive_partial",
    message:
      incompleteMessages.length === 0
        ? "主题的可见帖子范围没有完整归档。"
        : incompleteMessages.join("；"),
  };
}

type CollectionDateWindow = {
  readonly startInclusive: number;
  readonly endExclusive: number;
};

function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function localDateKey(date: Date, formatter: Intl.DateTimeFormat): string {
  const parts = new Map(
    formatter
      .formatToParts(date)
      .map(({ type, value }) => [type, value] as const),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("无法读取 IANA 时区的本地日历日期。");
  }
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDateStart(
  value: string,
  formatter: Intl.DateTimeFormat,
): Date | undefined {
  const center = Date.parse(`${value}T12:00:00.000Z`);
  const spanMs = 36 * 60 * 60 * 1000;
  let lower = center - spanMs;
  let upper = center + spanMs;
  if (
    localDateKey(new Date(lower), formatter) >= value ||
    localDateKey(new Date(upper), formatter) < value
  ) {
    return undefined;
  }

  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (localDateKey(new Date(middle), formatter) >= value) upper = middle;
    else lower = middle;
  }
  if (localDateKey(new Date(upper), formatter) !== value) return undefined;
  return new Date(upper);
}

function collectionDateWindow(
  params: DateCollectionParams,
  referenceTime: string,
): CollectionDateWindow {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: params.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const referenceMilliseconds = Date.parse(referenceTime);
  if (!Number.isFinite(referenceMilliseconds)) {
    throw sourceAdapterActionError({
      code: "linuxdo_reference_time_invalid",
      message: "本次运行没有有效的固定 referenceTime。",
      impact: "无法确定 Linux.do 的日期范围，因此没有访问信源。",
      suggestion: "重新创建动作运行；如果问题持续，请检查运行快照。",
      requiresHuman: false,
    });
  }

  const referenceDate = new Date(referenceMilliseconds);
  const today = localDateKey(referenceDate, formatter);
  const selectedDate =
    params.date === "today"
      ? today
      : params.date === "yesterday"
        ? shiftCalendarDate(today, -1)
        : params.date;
  if (selectedDate > today) {
    throw sourceAdapterActionError({
      code: "linuxdo_collection_date_in_future",
      message: "未来日期不能作为完整自然日采集。",
      impact: "本次未访问 Linux.do，也没有归档资料。",
      suggestion: "选择当天、前一天或已经结束的指定日期。",
      requiresHuman: false,
    });
  }

  const start = localDateStart(selectedDate, formatter);
  const isCurrentDate = selectedDate === today;
  const end = isCurrentDate
    ? referenceDate
    : localDateStart(shiftCalendarDate(selectedDate, 1), formatter);
  if (start === undefined || end === undefined) {
    throw sourceAdapterActionError({
      code: "linuxdo_collection_date_unavailable",
      message: `日期 ${selectedDate} 在时区 ${params.timeZone} 中没有完整的自然日范围。`,
      impact: "本次未访问 Linux.do，也没有归档资料。",
      suggestion: "选择该时区存在的自然日，或使用其他 IANA 时区。",
      requiresHuman: false,
    });
  }
  return {
    startInclusive: start.getTime(),
    endExclusive: end.getTime(),
  };
}

function dateCollectionParams(params: CollectParams): DateCollectionParams {
  if (params.date === undefined || params.timeZone === undefined) {
    throw new Error("动作参数 schema 未能确认日期采集模式。");
  }
  return { ...params, date: params.date, timeZone: params.timeZone };
}

function postCreatedWindow(
  range: PostRangeCollectionParams["postCreatedRange"],
  actionStartedAt: number,
): CollectionDateWindow {
  const endExclusive = Date.parse(range.to);
  if (endExclusive > actionStartedAt) {
    throw sourceAdapterActionError({
      code: "linuxdo_post_created_range_in_future",
      message: "帖子创建时间区间的终点不能晚于本次动作实际开始时刻。",
      impact:
        "区间包含尚未发生的内容，无法完整取得；本次没有访问信源或归档资料。",
      suggestion:
        "等待区间终点到达后重新运行，或将 to 调整到本次动作开始时刻及之前。",
      requiresHuman: false,
    });
  }
  return {
    startInclusive: Date.parse(range.from),
    endExclusive,
  };
}

function topicMatchesDateWindow(
  topicId: number,
  createdAt: string | undefined,
  dateWindow: CollectionDateWindow,
): boolean {
  const created = topicCreatedAt(topicId, createdAt);
  return (
    created >= dateWindow.startInclusive && created < dateWindow.endExclusive
  );
}

function topicCreatedAt(
  topicId: number,
  createdAt: string | undefined,
): number {
  const created = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  if (!Number.isFinite(created)) {
    throw sourceAdapterActionError({
      code: "discourse_topic_created_at_invalid",
      message: `主题 ${String(topicId)} 没有有效的创建时间，无法应用日期范围。`,
      impact: "本次无法确认该主题是否位于所选时间范围。",
      suggestion: "检查 Discourse 列表中的 created_at 后重新运行。",
      requiresHuman: false,
    });
  }
  return created;
}

type DiscoveryProgress = {
  readonly seenTopicIds: Set<number>;
  collectedTopics: number;
};

async function collectListTarget(
  context: SourceAdapterContext,
  page: Page,
  request: APIRequestContext,
  site: ReturnType<typeof siteFromConfig>,
  target: Extract<ConfiguredTarget, { kind: "latest" | "category" }>,
  maxTopics: number | undefined,
  dateWindow: CollectionDateWindow,
  progress: DiscoveryProgress,
  completedScopes: string[],
  incompleteScopes: CollectionIncompleteScope[],
): Promise<"complete" | "limited"> {
  const initialUrl = targetListUrl(site, target, maxTopics, dateWindow);
  const visitedPages = new Set<string>();
  const seenOnTarget = new Set<number>();
  let pageUrl: URL | undefined = initialUrl;
  let previousCreatedAt: number | undefined;
  try {
    while (pageUrl !== undefined) {
      context.signal.throwIfAborted();
      if (visitedPages.has(pageUrl.href)) {
        throw sourceAdapterActionError({
          code: "discourse_topic_list_pagination_loop",
          message: "Linux.do 列表分页重复返回了已读取页面。",
          impact: "本次只处理了分页循环前的主题。",
          suggestion: "检查受控目标的 Discourse 分页响应后重新运行 collect。",
          requiresHuman: false,
        });
      }
      visitedPages.add(pageUrl.href);
      const topicList = await readTopicListPage(page, pageUrl, context.signal);
      if (
        topicList.topics.length === 0 &&
        topicList.more_topics_url !== null &&
        topicList.more_topics_url !== undefined
      ) {
        throw sourceAdapterActionError({
          code: "discourse_topic_list_ended_early",
          message: "Linux.do 列表在仍声明下一页时提前返回空主题页。",
          impact: `采集范围 ${targetScope(target)} 未穷尽，无法确认空页后的主题。`,
          suggestion:
            "检查分页响应和账号权限后，以相同固定日期重新运行 collect。",
          requiresHuman: false,
        });
      }
      const listedTopics = topicList.topics.map((topic) => ({
        topic,
        createdAt: topicCreatedAt(topic.id, topic.created_at),
      }));
      for (const { topic, createdAt } of listedTopics) {
        if (seenOnTarget.has(topic.id)) continue;
        if (previousCreatedAt !== undefined && createdAt > previousCreatedAt) {
          throw sourceAdapterActionError({
            code: "discourse_topic_list_order_invalid",
            message: "Linux.do 创建时间排序在分页中发生倒退。",
            impact: "本次不能依据日期边界确认剩余主题已穷尽。",
            suggestion:
              "检查列表是否支持 order=created 并保持分页顺序后，重新运行 collect。",
            requiresHuman: false,
          });
        }
        previousCreatedAt = createdAt;
        seenOnTarget.add(topic.id);
      }
      for (const { topic, createdAt } of listedTopics) {
        if (createdAt < dateWindow.startInclusive) {
          completedScopes.push(targetScope(target));
          return "complete";
        }
        if (progress.seenTopicIds.has(topic.id)) continue;
        progress.seenTopicIds.add(topic.id);
        if (createdAt >= dateWindow.endExclusive) continue;
        if (maxTopics !== undefined && progress.collectedTopics >= maxTopics) {
          incompleteScopes.push({
            scope: targetScope(target),
            reasonCode: "topic_limit_reached",
            message: `已达到显式 maxTopics=${String(maxTopics)}，所选主题范围仍有匹配主题。`,
          });
          return "limited";
        }
        const incomplete = await collectTopicContent(
          context,
          page,
          request,
          site,
          topic.id,
          completedScopes,
        );
        if (incomplete !== undefined) incompleteScopes.push(incomplete);
        progress.collectedTopics += 1;
      }
      if (
        topicList.more_topics_url === null ||
        topicList.more_topics_url === undefined
      ) {
        completedScopes.push(targetScope(target));
        return "complete";
      }
      pageUrl = paginationUrl(topicList.more_topics_url, pageUrl, target, true);
    }
    completedScopes.push(targetScope(target));
    return "complete";
  } catch (error) {
    const scope = targetScope(target);
    if (isSourceAdapterActionError(error)) {
      throw sourceAdapterActionError(
        {
          ...error.failure,
          impact: `采集范围 ${scope} 未穷尽：${error.failure.impact}`,
        },
        error.completedScopes,
      );
    }
    if (context.signal.aborted) {
      throw sourceAdapterActionError(
        {
          code: "source_adapter_action_cancelled",
          message: "Linux.do 采集已取消。",
          impact: `采集范围 ${scope} 未穷尽，已保存此前提交的资料。`,
          suggestion: "确认取消原因后，使用相同固定日期创建新的采集运行。",
          requiresHuman: false,
        },
        completedScopes,
      );
    }
    throw sourceAdapterActionError(
      {
        code: "linuxdo_collection_failed",
        message: "Linux.do 采集未能完成。",
        impact: `采集范围 ${scope} 未穷尽，已保存此前提交的资料。`,
        suggestion: "稍后重试；如持续失败，请检查站点状态后重新运行。",
        requiresHuman: false,
      },
      completedScopes,
    );
  }
}

function failureWithProgress(
  error: unknown,
  context: SourceAdapterContext,
  completedScopes: readonly string[],
) {
  if (isSourceAdapterActionError(error)) {
    const errorScopes = Array.isArray(error.completedScopes)
      ? error.completedScopes.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [];
    return sourceAdapterActionError(error.failure, [
      ...completedScopes,
      ...errorScopes,
    ]);
  }
  if (context.signal.aborted) {
    return sourceAdapterActionError(
      {
        code: "source_adapter_action_cancelled",
        message: "Linux.do 采集已取消。",
        impact: `本次已提交 ${String(completedScopes.length)} 个范围；其余选中主题未完成。`,
        suggestion: "确认取消原因后，可重新运行尚未完成的发现范围。",
        requiresHuman: false,
      },
      completedScopes,
    );
  }
  return sourceAdapterActionError(
    {
      code: "linuxdo_collection_failed",
      message: "Linux.do 采集未能完成。",
      impact: `本次已提交 ${String(completedScopes.length)} 个范围；其余选中主题未完成。`,
      suggestion: "稍后重试；如持续失败，请检查站点状态后重新运行。",
      requiresHuman: false,
    },
    completedScopes,
  );
}

async function collectPostCreatedRange(
  context: SourceAdapterContext<SourceAdapterConfig>,
  page: Page,
  request: APIRequestContext,
  site: ReturnType<typeof siteFromConfig>,
  params: PostRangeCollectionParams,
  dateWindow: CollectionDateWindow,
  completedScopes: string[],
  incompleteScopes: CollectionIncompleteScope[],
  publishReport: (report: CollectionReportUpdate) => Promise<void>,
  selectionOverride?: PostRangeTargetSelection,
  seenPostIds?: Set<number>,
  readCache?: PostRangeReadCache,
): Promise<
  Omit<z.output<typeof collectOutputSchema>, "challengeRecovery"> & {
    readonly observedPosts: number;
    readonly topicsExamined: number;
  }
> {
  const range = {
    from: new Date(dateWindow.startInclusive).toISOString(),
    to: new Date(dateWindow.endExclusive).toISOString(),
  };
  const rangeScope = "post-created-range";
  await publishReport({
    phase: "collecting",
    referenceTime: context.referenceTime,
    intent: {
      ...(params.date === undefined ? {} : { date: params.date }),
      ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),
      ...(params.postCreatedRange === undefined
        ? {}
        : { postCreatedRange: params.postCreatedRange }),
      target:
        params.topicId !== undefined
          ? { kind: "topic", topicId: params.topicId }
          : params.targets === undefined
            ? { kind: "all-visible" }
            : { kind: "targets", targets: params.targets },
      ...(params.maxTopics === undefined
        ? {}
        : { maxTopics: params.maxTopics }),
    },
    window: range,
    discovery: "in-progress",
    scopes: [{ scope: rangeScope, ...range, status: "in-progress" }],
  });
  const selection =
    selectionOverride ??
    (await resolvePostRangeTargets(page, site, params, context.signal));
  let scanPromise = readCache?.scan;
  if (scanPromise === undefined) {
    scanPromise = scanPostCreatedRange(
      page,
      site.origin,
      context.signal,
      params.postCreatedRange.maxPages,
    );
    if (readCache !== undefined) readCache.scan = scanPromise;
  }
  const scan = await scanPromise;
  if (scan.issue !== undefined) {
    incompleteScopes.push({
      scope: rangeScope,
      reasonCode: scan.issue.reasonCode,
      message: `${scan.issue.message} 已读取 ${String(scan.pagesRead)} 页；本轮覆盖保留为部分或未知。`,
    });
  }

  const postsByTopic = new Map<number, DiscoursePost[]>();
  for (const post of scan.posts) {
    if (
      post.topic_id === undefined ||
      seenPostIds?.has(post.id) === true ||
      (selection.topicIds.size > 0 && !selection.topicIds.has(post.topic_id))
    ) {
      continue;
    }
    const createdAt =
      post.created_at === undefined ? Number.NaN : Date.parse(post.created_at);
    if (
      !Number.isFinite(createdAt) ||
      createdAt < dateWindow.startInclusive ||
      createdAt >= dateWindow.endExclusive
    ) {
      continue;
    }
    const topicPosts = postsByTopic.get(post.topic_id) ?? [];
    topicPosts.push(post);
    postsByTopic.set(post.topic_id, topicPosts);
  }

  let collectedTopics = 0;
  let topicsExamined = 0;
  let observedPosts = 0;
  const topics = [...postsByTopic.entries()].toSorted(
    ([firstId], [secondId]) => firstId - secondId,
  );
  for (const [topicId, posts] of topics) {
    context.signal.throwIfAborted();
    if (
      !selection.allVisible &&
      selection.topicIds.size > 0 &&
      selection.categoryIds.size === 0 &&
      !selection.topicIds.has(topicId)
    ) {
      continue;
    }
    if (
      readCache !== undefined &&
      !selection.allVisible &&
      !selection.topicIds.has(topicId) &&
      selection.categoryIds.size > 0 &&
      posts.every((post) => {
        const categoryId = post.category_id;
        return (
          typeof categoryId === "number" &&
          Number.isSafeInteger(categoryId) &&
          categoryId > 0 &&
          !selection.categoryIds.has(categoryId)
        );
      })
    ) {
      continue;
    }
    const topicResult = await collectPostRangeTopic(
      context,
      page,
      request,
      site,
      topicId,
      posts,
      selection,
      params.maxTopics,
      collectedTopics,
      completedScopes,
      incompleteScopes,
      seenPostIds,
      readCache,
    );
    if (topicResult === "limited") break;
    if (topicResult === "processed") {
      observedPosts += posts.length;
      collectedTopics += 1;
      topicsExamined += 1;
    }
  }

  if (incompleteScopes.length === 0) completedScopes.push(rangeScope);
  const unknown = scan.issue?.discovery === "failed" && scan.posts.length === 0;
  const scopeStatus =
    incompleteScopes.length === 0
      ? ("completed" as const)
      : unknown
        ? ("unknown" as const)
        : ("incomplete" as const);
  await publishReport({
    phase: "completed",
    referenceTime: context.referenceTime,
    intent: {
      ...(params.date === undefined ? {} : { date: params.date }),
      ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),
      ...(params.postCreatedRange === undefined
        ? {}
        : { postCreatedRange: params.postCreatedRange }),
      target:
        params.topicId !== undefined
          ? { kind: "topic", topicId: params.topicId }
          : params.targets === undefined
            ? { kind: "all-visible" }
            : { kind: "targets", targets: params.targets },
      ...(params.maxTopics === undefined
        ? {}
        : { maxTopics: params.maxTopics }),
    },
    window: range,
    discovery: scan.issue === undefined ? "complete" : scan.issue.discovery,
    scopes: [{ scope: rangeScope, ...range, status: scopeStatus }],
  });
  return {
    completedScopes,
    collectionCompleteness:
      incompleteScopes.length === 0 ? "complete" : "partial",
    incompleteScopes,
    observedPosts,
    topicsExamined,
  };
}

async function collectTopic(
  context: SourceAdapterContext<
    SourceAdapterConfig,
    typeof collectReportSchema
  >,
  params: CollectParams,
): Promise<z.output<typeof collectOutputSchema>> {
  const actionStartedAt = Date.now();
  const site = siteFromConfig(context.config);
  const completedScopes: string[] = [];
  const incompleteScopes: CollectionIncompleteScope[] = [];
  let report: CollectionReport = collectReportSchema.parse({
    phase: "preparing",
    referenceTime: context.referenceTime,
    intent: {
      ...(params.date === undefined ? {} : { date: params.date }),
      ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),
      ...(params.postCreatedRange === undefined
        ? {}
        : { postCreatedRange: params.postCreatedRange }),
      target:
        params.topicId !== undefined
          ? { kind: "topic", topicId: params.topicId }
          : params.targets === undefined
            ? { kind: "all-visible" }
            : { kind: "targets", targets: params.targets },
      ...(params.maxTopics === undefined
        ? {}
        : { maxTopics: params.maxTopics }),
    },
    discovery: "not-started",
    sourceAccess: emptySourceAccessReport(),
    scopes: [],
  });
  const publishReport = async (next: CollectionReportUpdate) => {
    report = collectReportSchema.parse({
      ...next,
      sourceAccess: next.sourceAccess ?? report.sourceAccess,
    });
    await context.report(report);
  };
  const output = () => ({
    completedScopes,
    collectionCompleteness:
      incompleteScopes.length === 0
        ? ("complete" as const)
        : ("partial" as const),
    incompleteScopes,
  });
  const rangeParams: PostRangeCollectionParams | undefined =
    params.postCreatedRange === undefined
      ? undefined
      : { ...params, postCreatedRange: params.postCreatedRange };
  try {
    await context.report(report);
    const dateWindow =
      rangeParams === undefined
        ? collectionDateWindow(
            dateCollectionParams(params),
            context.referenceTime,
          )
        : postCreatedWindow(rangeParams.postCreatedRange, actionStartedAt);
    const range = {
      from: new Date(dateWindow.startInclusive).toISOString(),
      to: new Date(dateWindow.endExclusive).toISOString(),
    };
    await publishReport({
      ...report,
      phase: "checking-access",
      window: range,
    });
    const browserOutput = await withSharedBrowser(
      context,
      async ({ page, request }) => {
        const session = await readSessionAccess(page, site, context.signal);
        if (session.kind === "unavailable") {
          throw failureFromProblem(session.problem);
        }
        if (rangeParams !== undefined) {
          const rangeOutput = await collectPostCreatedRange(
            context,
            page,
            request,
            site,
            rangeParams,
            dateWindow,
            completedScopes,
            incompleteScopes,
            publishReport,
          );
          return {
            completedScopes: rangeOutput.completedScopes,
            collectionCompleteness: rangeOutput.collectionCompleteness,
            incompleteScopes: rangeOutput.incompleteScopes,
          };
        }
        if (params.topicId !== undefined) {
          await publishReport({
            ...report,
            phase: "collecting",
            discovery: "complete",
            scopes: [
              {
                scope: `topic:${String(params.topicId)}`,
                ...range,
                status: "in-progress",
              },
            ],
          });
          const access = await readTopic(
            page,
            site,
            params.topicId,
            context.signal,
          );
          if (access.kind === "unavailable") throw failureFromAccess(access);
          if (
            !topicMatchesDateWindow(
              params.topicId,
              access.topic.created_at,
              dateWindow,
            )
          ) {
            completedScopes.push(`${topicScope(params.topicId)}:filtered:date`);
            await publishReport({
              ...report,
              phase: "completed",
              scopes: report.scopes.map((scope) => ({
                ...scope,
                status: "completed",
              })),
            });
            return output();
          }
          const incomplete = await collectTopicContent(
            context,
            page,
            request,
            site,
            params.topicId,
            completedScopes,
            access,
          );
          if (incomplete !== undefined) incompleteScopes.push(incomplete);
          await publishReport({
            ...report,
            phase: "completed",
            scopes: report.scopes.map((scope) => ({
              ...scope,
              status: incomplete === undefined ? "completed" : "incomplete",
            })),
          });
          return output();
        }

        let categories: DiscoveredCategory[] = [];
        if (
          params.targets === undefined ||
          params.targets.some((target) => target.kind === "category")
        ) {
          await publishReport({
            ...report,
            phase: "discovering-targets",
            discovery: "in-progress",
          });
          categories = await readVisibleCategories(page, site, context.signal);
        }
        const targets = collectTargets(params.targets, categories);
        const scopes = targets.map((target) => ({
          scope: targetScope(target),
          ...range,
          status: "unstarted" as const,
        }));
        await publishReport({
          ...report,
          phase: "collecting",
          discovery: "complete",
          scopes,
        });
        const progress: DiscoveryProgress = {
          seenTopicIds: new Set(),
          collectedTopics: 0,
        };
        for (const [index, target] of targets.entries()) {
          context.signal.throwIfAborted();
          const scope = targetScope(target);
          await publishReport({
            ...report,
            scopes: report.scopes.map((current) =>
              current.scope === scope
                ? { ...current, status: "in-progress" }
                : current,
            ),
          });
          if (target.kind === "topic") {
            if (progress.seenTopicIds.has(target.topicId)) {
              completedScopes.push(targetScope(target));
              await publishReport({
                ...report,
                scopes: report.scopes.map((current) =>
                  current.scope === scope
                    ? { ...current, status: "completed" }
                    : current,
                ),
              });
              continue;
            }
            progress.seenTopicIds.add(target.topicId);
            const access = await readTopic(
              page,
              site,
              target.topicId,
              context.signal,
            );
            if (access.kind === "unavailable") throw failureFromAccess(access);
            if (
              !topicMatchesDateWindow(
                target.topicId,
                access.topic.created_at,
                dateWindow,
              )
            ) {
              completedScopes.push(`${targetScope(target)}:filtered:date`);
              await publishReport({
                ...report,
                scopes: report.scopes.map((current) =>
                  current.scope === scope
                    ? { ...current, status: "completed" }
                    : current,
                ),
              });
              continue;
            }
            if (
              params.maxTopics !== undefined &&
              progress.collectedTopics >= params.maxTopics
            ) {
              incompleteScopes.push({
                scope: targetScope(target),
                reasonCode: "topic_limit_reached",
                message: `已达到显式 maxTopics=${String(params.maxTopics)}，所选主题仍在日期范围内。`,
              });
              for (const remainingTarget of targets.slice(index + 1)) {
                incompleteScopes.push({
                  scope: targetScope(remainingTarget),
                  reasonCode: "not_scanned_due_to_topic_limit",
                  message: `前一范围达到显式 maxTopics=${String(params.maxTopics)} 后未扫描此范围。`,
                });
              }
              await publishReport({
                ...report,
                scopes: report.scopes.map((current) =>
                  current.scope === scope
                    ? { ...current, status: "incomplete" }
                    : current,
                ),
              });
              break;
            }
            const incomplete = await collectTopicContent(
              context,
              page,
              request,
              site,
              target.topicId,
              completedScopes,
              access,
            );
            if (incomplete !== undefined) incompleteScopes.push(incomplete);
            progress.collectedTopics += 1;
            completedScopes.push(targetScope(target));
            await publishReport({
              ...report,
              scopes: report.scopes.map((current) =>
                current.scope === scope
                  ? {
                      ...current,
                      status:
                        incomplete === undefined ? "completed" : "incomplete",
                    }
                  : current,
              ),
            });
            continue;
          }
          const result = await collectListTarget(
            context,
            page,
            request,
            site,
            target,
            params.maxTopics,
            dateWindow,
            progress,
            completedScopes,
            incompleteScopes,
          );
          if (result === "limited") {
            for (const remainingTarget of targets.slice(index + 1)) {
              incompleteScopes.push({
                scope: targetScope(remainingTarget),
                reasonCode: "not_scanned_due_to_topic_limit",
                message: `前一范围达到显式 maxTopics=${String(params.maxTopics)} 后未扫描此范围。`,
              });
            }
            await publishReport({
              ...report,
              scopes: report.scopes.map((current) =>
                current.scope === scope
                  ? { ...current, status: "incomplete" }
                  : current,
              ),
            });
            break;
          }
          await publishReport({
            ...report,
            scopes: report.scopes.map((current) =>
              current.scope === scope
                ? {
                    ...current,
                    status: incompleteScopes.some(
                      (incomplete) => incomplete.scope === scope,
                    )
                      ? "incomplete"
                      : "completed",
                  }
                : current,
            ),
          });
        }
        await publishReport({ ...report, phase: "completed" });
        return output();
      },
      (sourceAccess) => publishReport({ ...report, sourceAccess }),
    );
    const { sourceAccess, ...result } = browserOutput;
    await publishReport({ ...report, phase: "completed", sourceAccess });
    return result;
  } catch (error) {
    await publishReport({
      ...report,
      phase: context.signal.aborted ? "cancelled" : "failed",
      discovery:
        report.discovery === "in-progress" ? "failed" : report.discovery,
      scopes: report.scopes.map((scope) =>
        scope.status === "in-progress"
          ? { ...scope, status: "unknown" }
          : scope,
      ),
    }).catch(() => undefined);
    throw failureWithProgress(error, context, completedScopes);
  }
}

async function sync(
  context: SourceAdapterContext<SourceAdapterConfig, typeof syncReportSchema>,
  params: SyncParams,
): Promise<z.output<typeof syncOutputSchema>> {
  // 这是同步唯一的日历上界；来源访问耗时由独立的 monotonic budget 计算。
  const upperBound = new Date(Date.now()).toISOString();
  const intent = syncIntent(params);
  if (context.sourceAccess === undefined) {
    throw sourceAdapterActionError({
      code: "linuxdo_sync_source_access_unavailable",
      message: "当前运行器没有提供 Linux.do 来源访问预算。",
      impact: "本轮没有访问来源或推进接续位置。",
      suggestion: "检查运行器版本与信源适配器部署状态后重新触发。",
      requiresHuman: false,
    });
  }

  const budget = createSourceAccessBudget({
    client: context.sourceAccess,
    signal: context.signal,
    maxRequests: params.maxRequests,
    maxElapsedMs: params.maxElapsedMs,
  });
  const runContext = {
    ...context,
    signal: budget.signal,
    sourceAccess: budget,
  };
  const site = siteFromConfig(context.config);
  const plans: SyncScopePlan[] = [];
  const reportScopes = new Map<string, SyncReport["scopes"][number]>();
  const incompleteScopes: CollectionIncompleteScope[] = [];
  const completedScopes: string[] = [];
  const seenPostIds = new Set<number>();
  const postRangeReadCache: PostRangeReadCache = { topics: new Map() };
  let observedPosts = 0;
  let topicsExamined = 0;
  let state: SyncPersistentState | undefined;
  let activePlan: SyncScopePlan | undefined;
  let report = syncReportSchema.parse({
    phase: "preparing",
    upperBound,
    intent,
    discovery: "not-started",
    challengeRecovery: emptyChallengeRecovery(),
    budget: syncBudgetReport(budget),
    sourceAccess: emptySourceAccessReport(),
    scopes: [],
    observedPosts,
    topicsExamined,
    incompleteScopes,
  });

  const publishReport = async (next: SyncReport) => {
    report = syncReportSchema.parse({
      ...next,
      budget: syncBudgetReport(budget),
      scopes: [...reportScopes.values()],
      observedPosts,
      topicsExamined,
      incompleteScopes,
    });
    await context.report(report);
  };
  const persistIntent = async (
    phase: NonNullable<SyncPersistentState["lastIntent"]>["phase"],
  ) => {
    if (state === undefined) return;
    const next = syncStateWithIntent(state, context, upperBound, intent, phase);
    await saveSyncPersistentState(context, next);
    state = next;
  };
  const saveAssignedScopes = async (
    assignedPlans: readonly SyncScopePlan[],
    phase: NonNullable<SyncPersistentState["lastIntent"]>["phase"],
  ) => {
    if (state === undefined) throw new Error("同步状态尚未加载。");
    let next = state;
    for (const plan of assignedPlans)
      next = assignSyncPosition(next, plan, context.runId);
    next = syncStateWithIntent(next, context, upperBound, intent, phase);
    await saveSyncPersistentState(context, next);
    state = next;
  };
  const addIncomplete = (
    scope: string,
    reasonCode: string,
    message: string,
  ) => {
    if (
      incompleteScopes.some(
        (current) =>
          current.scope === scope &&
          current.reasonCode === reasonCode &&
          current.message === message,
      )
    )
      return;
    incompleteScopes.push({ scope, reasonCode, message });
  };
  const output = (
    challengeRecovery = emptyChallengeRecovery(),
  ): z.output<typeof syncOutputSchema> => {
    const scopeOutput = [...reportScopes.values()].map((scope) => ({
      scope: scope.scope,
      position: scope.position,
      status: syncOutputStatus(scope.status),
      ...(scope.range === undefined ? {} : { range: scope.range }),
      ...(scope.skippedBefore === undefined
        ? {}
        : { skippedBefore: scope.skippedBefore }),
    }));
    const incomplete =
      report.phase === "budget-exhausted" ||
      incompleteScopes.length > 0 ||
      scopeOutput.some(
        ({ status }) =>
          status === "partial" ||
          status === "unknown" ||
          status === "unstarted",
      );
    const processed = plans.some(
      (plan) => plan.mode === "continued" || plan.mode === "truncated",
    );
    const initialized = plans.some((plan) => plan.mode === "initialized");
    return {
      challengeRecovery,
      outcome: incomplete
        ? "partial"
        : processed
          ? "advanced"
          : initialized
            ? "initialized"
            : "no-forward-range",
      upperBound,
      scopes: scopeOutput,
      observedPosts,
      topicsExamined,
      incompleteScopes: [...incompleteScopes],
    };
  };

  try {
    state = await loadSyncPersistentState(context);
    state = syncStateWithIntent(
      state,
      context,
      upperBound,
      intent,
      "preparing",
    );
    await saveSyncPersistentState(context, state);
    await publishReport(report);

    await persistIntent("discovering-targets");
    await publishReport({ ...report, phase: "discovering-targets" });
    const browserOutput = await withSharedBrowser(
      runContext,
      async ({ page, request }) => {
        const session = await readSessionAccess(page, site, budget.signal);
        if (session.kind === "unavailable")
          throw failureFromProblem(session.problem);

        const needsCategories =
          params.targets === undefined ||
          params.targets.some(
            (target) => target.kind === "category" || target.kind === "latest",
          );
        const categories = needsCategories
          ? await readVisibleCategories(page, site, budget.signal)
          : [];
        const selectedTargets = syncScopeTargets(params.targets, categories);
        plans.push(
          ...syncScopePlans(
            context,
            site.origin,
            selectedTargets,
            state!,
            upperBound,
          ),
        );

        for (const plan of plans) {
          const status =
            plan.mode === "initialized"
              ? "initializing"
              : plan.mode === "no-forward-range"
                ? "no-forward-range"
                : "unstarted";
          reportScopes.set(
            syncScopeName(syncScopeReference(plan.target)),
            syncPlanReport(plan, status),
          );
        }
        const newScopes = plans.filter((plan) => plan.mode === "initialized");
        if (newScopes.length > 0) {
          await saveAssignedScopes(newScopes, "discovering-targets");
          for (const plan of newScopes)
            reportScopes.set(
              syncScopeName(syncScopeReference(plan.target)),
              syncPlanReport(plan, "initialized", true),
            );
        }
        await persistIntent("processing");
        await publishReport({
          ...report,
          phase: "processing",
          discovery: "complete",
        });

        const executionPlans = plans
          .filter(
            (plan) => plan.mode === "continued" || plan.mode === "truncated",
          )
          .toSorted(
            (first, second) =>
              Date.parse(first.previousPosition!) -
              Date.parse(second.previousPosition!),
          );
        for (const plan of executionPlans) {
          budget.signal.throwIfAborted();
          budget.remainingMs();
          budget.signal.throwIfAborted();
          await saveAssignedScopes([plan], "processing");
          activePlan = plan;
          const name = syncScopeName(syncScopeReference(plan.target));
          reportScopes.set(name, syncPlanReport(plan, "in-progress", true));
          await publishReport({ ...report, phase: "processing" });

          const beforeIncompleteCount = incompleteScopes.length;
          let scopeDiscovery: CollectionReport["discovery"] | undefined;
          const selected: PostRangeTargetSelection =
            plan.target.kind === "topic"
              ? {
                  allVisible: false,
                  topicIds: new Set([plan.target.topicId]),
                  categoryIds: new Set(),
                }
              : {
                  allVisible: false,
                  topicIds: new Set(),
                  categoryIds: new Set([plan.target.categoryId]),
                };
          const rangeParams: PostRangeCollectionParams = {
            targets: [plan.target],
            postCreatedRange: postCreatedRangeSchema.parse({
              ...plan.range,
              maxPages: params.maxPages,
            }),
            maxTopics: undefined,
          };
          const result = await collectPostCreatedRange(
            runContext,
            page,
            request,
            site,
            rangeParams,
            {
              startInclusive: Date.parse(plan.range!.from),
              endExclusive: Date.parse(plan.range!.to),
            },
            completedScopes,
            incompleteScopes,
            async (rangeReport) => {
              scopeDiscovery = rangeReport.discovery;
            },
            selected,
            seenPostIds,
            postRangeReadCache,
          );
          observedPosts += result.observedPosts;
          topicsExamined += result.topicsExamined;
          const addedIncomplete = incompleteScopes.splice(
            beforeIncompleteCount,
          );
          for (const incomplete of addedIncomplete) {
            addIncomplete(
              incomplete.scope === "post-created-range"
                ? name
                : incomplete.scope,
              incomplete.reasonCode,
              incomplete.message,
            );
          }
          const scopeIncomplete = addedIncomplete.length > 0;
          const scopeStatus = !scopeIncomplete
            ? "completed"
            : scopeDiscovery === "failed"
              ? "unknown"
              : "partial";
          reportScopes.set(name, syncPlanReport(plan, scopeStatus, true));
          activePlan = undefined;
          await publishReport({
            ...report,
            phase: scopeIncomplete ? "partial" : "processing",
            discovery: scopeIncomplete ? "partial" : "complete",
          });
        }

        return { challengeRecovery: { rounds: 0, elapsedMs: 0, successes: 0 } };
      },
      (sourceAccess) => publishReport({ ...report, sourceAccess }),
    );

    const challengeRecovery = browserOutput.challengeRecovery;
    const hasPartial = [...reportScopes.values()].some(
      ({ status }) =>
        status === "partial" || status === "unknown" || status === "unstarted",
    );
    const phase = hasPartial ? "partial" : "completed";
    await persistIntent(hasPartial ? "partial" : "completed");
    await publishReport({
      ...report,
      phase,
      discovery: hasPartial ? "partial" : "complete",
      challengeRecovery,
      sourceAccess: browserOutput.sourceAccess,
    });
    return output(challengeRecovery);
  } catch (error) {
    const budgetStop = error instanceof SourceAccessBudgetExceededError;
    const cancelled = context.signal.aborted;
    if (activePlan !== undefined) {
      const name = syncScopeName(syncScopeReference(activePlan.target));
      reportScopes.set(name, syncPlanReport(activePlan, "unknown", true));
      addIncomplete(
        name,
        budgetStop
          ? `budget_${error.reason.replaceAll("-", "_")}`
          : cancelled
            ? "sync_cancelled"
            : "sync_scope_unknown",
        budgetStop
          ? `本轮达到 ${error.reason} 上限；该已分配范围没有确认完成。`
          : cancelled
            ? "本轮在处理该范围时取消；接续位置已分配，覆盖结果未知。"
            : error instanceof Error
              ? `本轮在处理该范围时失败：${error.message}`
              : "本轮在处理该范围时失败，覆盖结果未知。",
      );
      activePlan = undefined;
    }
    if (budgetStop) {
      await persistIntent("budget-exhausted").catch(() => undefined);
      await publishReport({
        ...report,
        phase: "budget-exhausted",
        discovery: plans.length === 0 ? "failed" : "partial",
      }).catch(() => undefined);
      return output();
    }

    const failurePhase = cancelled ? "cancelled" : "failed";
    await persistIntent(failurePhase).catch(() => undefined);
    await publishReport({
      ...report,
      phase: failurePhase,
      discovery:
        report.discovery === "not-started" || report.discovery === "in-progress"
          ? "failed"
          : "partial",
    }).catch(() => undefined);
    throw failureWithProgress(error, context, completedScopes);
  } finally {
    budget.close();
  }
}

export const sourceAdapter = defineSourceAdapter({
  id: "binny.source-adapter-linuxdo",
  version: "1.0.0",
  description: "按长期主题目标发现并归档 Linux.do 帖子与媒体。",
  environment: {
    browser: { required: true, profileReuseAfterRestart: true },
  },
  configSchema: sourceAdapterConfigSchema,
  stateSchema: syncPersistentStateSchema,
  stateSnapshotSchema: syncPublicStateSchema,
  actions: {
    "list-categories": defineSourceAdapterAction(sourceAdapterConfigSchema, {
      description: "发现当前 Linux.do 登录账号可见的板块及其采集引用。",
      params: listCategoriesParamsSchema,
      output: listCategoriesOutputSchema,
      report: listCategoriesReportSchema,
      execute: listCategories,
    }),
    check: defineSourceAdapterAction(sourceAdapterConfigSchema, {
      description: "检查登录状态以及所选 Linux.do 目标的可见范围。",
      params: checkParamsSchema,
      output: checkOutputSchema,
      report: checkReportSchema,
      execute: checkTopic,
    }),
    collect: defineSourceAdapterAction(sourceAdapterConfigSchema, {
      description: "发现所选 Linux.do 目标的主题并归档帖子、回复和媒体。",
      params: collectParamsSchema,
      output: collectOutputSchema,
      report: collectReportSchema,
      execute: collectTopic,
    }),
    sync: defineSourceAdapterAction(sourceAdapterConfigSchema, {
      description:
        "在有限请求与耗时预算内按真实 Linux.do 范围接续归档新增帖子和回复；已有范围按接续位置从旧到新处理，同一位置沿用原范围顺序。",
      params: syncParamsSchema,
      output: syncOutputSchema,
      report: syncReportSchema,
      execute: sync,
    }),
  },
});
