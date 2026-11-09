import { z } from "zod";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  submitCleanedArticle,
  type ArchiveSearchRequestFor,
  type SourceAdapterContext,
} from "../src/index.ts";

const basicConfigSchema = z.object({ feedUrl: z.url() });
const basicExtensionsSchema = z
  .object({
    category: z.enum(["question", "reply"]),
    floor: z.number().int(),
    source: z.object({ forum: z.string() }).strict(),
  })
  .strict();
const sourceAdapter = defineSourceAdapter({
  id: "example.rss",
  version: "1.0.0",
  configSchema: basicConfigSchema,
  extensionsSchema: basicExtensionsSchema,
  environment: {
    browser: {
      required: false,
      profileReuseAfterRestart: false,
    },
  },
  actions: {
    check: defineSourceAdapterAction(basicConfigSchema, basicExtensionsSchema, {
      description: "检查 RSS 信源是否可用。",
      params: z.object({}),
      output: z.object({ available: z.boolean() }),
      async execute() {
        return { available: true };
      },
    }),
    collect: defineSourceAdapterAction(
      basicConfigSchema,
      basicExtensionsSchema,
      {
        description: "采集选定的信源条目。",
        params: z.object({ scope: z.enum(["all", "recent"]) }),
        output: z.object({ completedScopes: z.array(z.string()) }),
        async execute(_context, params) {
          const scope: "all" | "recent" = params.scope;
          return { completedScopes: [scope] };
        },
      },
    ),
    discover: defineSourceAdapterAction(
      basicConfigSchema,
      basicExtensionsSchema,
      {
        description: "发现可用的信源。",
        params: z.object({}),
        output: z.object({ feeds: z.array(z.string()) }),
        async execute() {
          return { feeds: ["main"] };
        },
      },
    ),
  },
});

void sourceAdapter;

const basicAction = defineSourceAdapterAction(
  basicConfigSchema,
  basicExtensionsSchema,
  {
    description: "Return an empty check result.",
    params: z.object({}),
    output: z.object({ accepted: z.boolean() }),
    async execute() {
      return { accepted: true };
    },
  },
);

// @ts-expect-error Every adapter must declare the schema that owns its extensions.
defineSourceAdapter({
  id: "example.missing-extensions-schema",
  version: "1.0.0",
  configSchema: basicConfigSchema,
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  actions: { check: basicAction, collect: basicAction },
});

const incompatibleExtensionsSchema = z.object({ legacy: z.string() }).strict();
const incompatibleAction = defineSourceAdapterAction(
  basicConfigSchema,
  incompatibleExtensionsSchema,
  {
    description: "Return an incompatible check result.",
    params: z.object({}),
    output: z.object({ accepted: z.boolean() }),
    async execute() {
      return { accepted: true };
    },
  },
);

defineSourceAdapter({
  id: "example.mismatched-extensions-schema",
  version: "1.0.0",
  configSchema: basicConfigSchema,
  extensionsSchema: basicExtensionsSchema,
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  // @ts-expect-error Actions and adapter declaration must use one extension schema.
  actions: { check: incompatibleAction, collect: basicAction },
});

const transformedConfigSchema = z.object({
  enabled: z.boolean().default(true),
  offset: z.string().transform(Number),
});
const transformedParamsSchema = z.object({
  limit: z.string().transform(Number),
});
const typedExtensionsSchema = z
  .object({
    category: z.enum(["post", "comment"]),
    floor: z.number().int(),
    labels: z.array(z.enum(["release", "news"])).optional(),
    nullableCategory: z.string().nullable().optional(),
    nullableLabels: z.array(z.number().int().nullable()).nullable().optional(),
  })
  .strict();
const typedExtensionSearch: ArchiveSearchRequestFor<
  z.output<typeof typedExtensionsSchema>,
  "example.typed-actions"
> = {
  bins: ["example-bin"],
  extensions: {
    sourceAdapterId: "example.typed-actions",
    filters: {
      category: { op: "eq", value: "post" },
      floor: { op: "in", values: [2, 3] },
      labels: { op: "hasAny", values: ["news", "release"] },
      nullableCategory: { op: "eq", value: "comment" },
      nullableLabels: { op: "has", value: 2 },
    },
  },
};
void typedExtensionSearch;
const typedNullableArrayHasAny: ArchiveSearchRequestFor<
  z.output<typeof typedExtensionsSchema>,
  "example.typed-actions"
> = {
  bins: ["example-bin"],
  extensions: {
    sourceAdapterId: "example.typed-actions",
    filters: { nullableLabels: { op: "hasAny", values: [2, 3] } },
  },
};
void typedNullableArrayHasAny;
const badNullableArrayQueryNull: ArchiveSearchRequestFor<
  z.output<typeof typedExtensionsSchema>,
  "example.typed-actions"
> = {
  bins: ["example-bin"],
  extensions: {
    sourceAdapterId: "example.typed-actions",
    filters: {
      nullableLabels: {
        op: "has",
        // @ts-expect-error Query values cannot be null even when array items allow null.
        value: null,
      },
    },
  },
};
void badNullableArrayQueryNull;
// @ts-expect-error Adapter-scoped extension searches must select explicit bins.
const badExtensionSearchWithoutBins: ArchiveSearchRequestFor<
  z.output<typeof typedExtensionsSchema>,
  "example.typed-actions"
> = {
  extensions: {
    sourceAdapterId: "example.typed-actions",
    filters: { category: { op: "eq", value: "post" } },
  },
};
const badExtensionSearchField: ArchiveSearchRequestFor<
  z.output<typeof typedExtensionsSchema>,
  "example.typed-actions"
> = {
  bins: ["example-bin"],
  extensions: {
    sourceAdapterId: "example.typed-actions",
    filters: {
      // @ts-expect-error Search keys must be declared by the extension schema.
      unknown: { op: "eq", value: "post" },
    },
  },
};
const badExtensionSearchType: ArchiveSearchRequestFor<
  z.output<typeof typedExtensionsSchema>,
  "example.typed-actions"
> = {
  bins: ["example-bin"],
  extensions: {
    sourceAdapterId: "example.typed-actions",
    filters: {
      // @ts-expect-error Scalar values must match the declared field type.
      floor: { op: "eq", value: "2" },
    },
  },
};
const badExtensionSearchOperation: ArchiveSearchRequestFor<
  z.output<typeof typedExtensionsSchema>,
  "example.typed-actions"
> = {
  bins: ["example-bin"],
  extensions: {
    sourceAdapterId: "example.typed-actions",
    filters: {
      // @ts-expect-error Scalar fields support eq/in, not list operations.
      category: { op: "has", value: "post" },
    },
  },
};
const badExtensionSearchAdapter: ArchiveSearchRequestFor<
  z.output<typeof typedExtensionsSchema>,
  "example.typed-actions"
> = {
  bins: ["example-bin"],
  extensions: {
    // @ts-expect-error The adapter scope is preserved as a literal type.
    sourceAdapterId: "example.other-adapter",
    filters: { category: { op: "eq", value: "post" } },
  },
};
void badExtensionSearchField;
void badExtensionSearchType;
void badExtensionSearchOperation;
void badExtensionSearchAdapter;
void badExtensionSearchWithoutBins;
type IsString<T> = [T] extends [string] ? true : false;
type Expect<T extends true> = T;
type TypedReferenceTimeIsString = Expect<
  IsString<
    SourceAdapterContext<
      z.output<typeof transformedConfigSchema>
    >["referenceTime"]
  >
>;
const referenceTimeTypeAssertion: TypedReferenceTimeIsString = true;
void referenceTimeTypeAssertion;

const typedActionAdapter = defineSourceAdapter({
  id: "example.typed-actions",
  version: "1.0.0",
  configSchema: transformedConfigSchema,
  extensionsSchema: typedExtensionsSchema,
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  actions: {
    check: defineSourceAdapterAction(
      transformedConfigSchema,
      typedExtensionsSchema,
      {
        description: "返回配置摘要。",
        params: transformedParamsSchema,
        output: z.object({ enabled: z.boolean(), total: z.number() }),
        async execute(context, params) {
          // @ts-expect-error 未声明报告的动作不能发布虚假报告。
          void context.report;
          const enabled: boolean = context.config.enabled;
          const offset: number = context.config.offset;
          const limit: number = params.limit;

          void context.archive.submit({
            items: [
              {
                sourceKey: { namespace: "example", key: "typed" },
                title: null,
                sourcePublishedAt: null,
                sourceModifiedAt: null,
                extensions: { category: "post", floor: 2 },
                body: { text: "typed archive item" },
                capture: {
                  scope: {},
                  completeness: "complete",
                  missing: [],
                },
              },
            ],
          });
          void context.archive.submit({
            items: [
              // @ts-expect-error Public archive attributes remain required.
              {
                sourceKey: { namespace: "example", key: "missing-public" },
                extensions: { category: "post", floor: 2 },
                body: { text: "missing public attributes" },
                capture: {
                  scope: {},
                  completeness: "complete",
                  missing: [],
                },
              },
            ],
          });
          void context.archive.submit({
            items: [
              {
                sourceKey: { namespace: "example", key: "wrong-extension" },
                title: null,
                sourcePublishedAt: null,
                sourceModifiedAt: null,
                // @ts-expect-error Extension values use the declared property types.
                extensions: { category: "post", floor: "2" },
                body: { text: "wrong extension" },
                capture: {
                  scope: {},
                  completeness: "complete",
                  missing: [],
                },
              },
            ],
          });
          void context.archive.submit({
            items: [
              {
                sourceKey: { namespace: "example", key: "unknown-extension" },
                title: null,
                sourcePublishedAt: null,
                sourceModifiedAt: null,
                extensions: {
                  category: "post",
                  floor: 2,
                  // @ts-expect-error Undeclared extension keys are rejected at the SDK seam.
                  extra: true,
                },
                body: { text: "unknown extension" },
                capture: {
                  scope: {},
                  completeness: "complete",
                  missing: [],
                },
              },
            ],
          });
          const assertHelperInput = async () => {
            await submitCleanedArticle(context, {
              sourceKey: { namespace: "example", key: "helper" },
              title: null,
              sourcePublishedAt: null,
              sourceModifiedAt: null,
              extensions: { category: "comment", floor: 3 },
              cleanResult: undefined as never,
              captureScope: {},
            });
            await submitCleanedArticle(context, {
              sourceKey: { namespace: "example", key: "helper-wrong" },
              title: null,
              sourcePublishedAt: null,
              sourceModifiedAt: null,
              // @ts-expect-error The helper keeps the adapter's extension type.
              extensions: { category: "comment", floor: "3" },
              cleanResult: undefined as never,
              captureScope: {},
            });
          };
          void assertHelperInput;
          return { enabled, total: offset + limit };
        },
      },
    ),
    collect: defineSourceAdapterAction(
      transformedConfigSchema,
      typedExtensionsSchema,
      {
        description: "返回采集结果。",
        params: z.object({}),
        output: z.object({ accepted: z.boolean() }),
        async execute(_context, _params) {
          return { accepted: true };
        },
      },
    ),
    discover: defineSourceAdapterAction(
      transformedConfigSchema,
      typedExtensionsSchema,
      {
        description: "返回发现结果。",
        params: z.object({}),
        output: z.object({ feeds: z.array(z.string()) }),
        // @ts-expect-error 输出声明要求订阅源标识为字符串。
        async execute() {
          return { feeds: [1] };
        },
      },
    ),
  },
});

void typedActionAdapter;

defineSourceAdapter({
  id: "example.missing-check",
  version: "1.0.0",
  configSchema: z.object({}),
  extensionsSchema: z.object({}).strict(),
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  actions: {
    // @ts-expect-error The adapter declaration must include check.
    collect: defineSourceAdapterAction(z.object({}), z.object({}).strict(), {
      description: "采集条目。",
      params: z.object({}),
      output: z.object({ completedScopes: z.array(z.string()) }),
      async execute() {
        return { completedScopes: [] };
      },
    }),
  },
});

defineSourceAdapter({
  id: "example.missing-collect",
  version: "1.0.0",
  configSchema: z.object({}),
  extensionsSchema: z.object({}).strict(),
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  actions: {
    // @ts-expect-error The adapter declaration must include collect.
    check: defineSourceAdapterAction(z.object({}), z.object({}).strict(), {
      description: "检查信源端点。",
      params: z.object({}),
      output: z.object({ available: z.boolean() }),
      async execute() {
        return { available: true };
      },
    }),
  },
});
