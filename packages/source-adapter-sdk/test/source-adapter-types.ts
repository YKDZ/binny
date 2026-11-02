import { z } from "zod";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  type SourceAdapterContext,
} from "../src/index.ts";

const basicConfigSchema = z.object({ feedUrl: z.url() });
const sourceAdapter = defineSourceAdapter({
  id: "example.rss",
  version: "1.0.0",
  configSchema: basicConfigSchema,
  environment: {
    browser: {
      required: false,
      profileReuseAfterRestart: false,
    },
  },
  actions: {
    check: defineSourceAdapterAction(basicConfigSchema, {
      description: "检查 RSS 信源是否可用。",
      params: z.object({}),
      output: z.object({ available: z.boolean() }),
      async execute() {
        return { available: true };
      },
    }),
    collect: defineSourceAdapterAction(basicConfigSchema, {
      description: "采集选定的信源条目。",
      params: z.object({ scope: z.enum(["all", "recent"]) }),
      output: z.object({ completedScopes: z.array(z.string()) }),
      async execute(_context, params) {
        const scope: "all" | "recent" = params.scope;
        return { completedScopes: [scope] };
      },
    }),
    discover: defineSourceAdapterAction(basicConfigSchema, {
      description: "发现可用的信源。",
      params: z.object({}),
      output: z.object({ feeds: z.array(z.string()) }),
      async execute() {
        return { feeds: ["main"] };
      },
    }),
  },
});

void sourceAdapter;

const transformedConfigSchema = z.object({
  enabled: z.boolean().default(true),
  offset: z.string().transform(Number),
});
const transformedParamsSchema = z.object({
  limit: z.string().transform(Number),
});
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
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  actions: {
    check: defineSourceAdapterAction(transformedConfigSchema, {
      description: "返回配置摘要。",
      params: transformedParamsSchema,
      output: z.object({ enabled: z.boolean(), total: z.number() }),
      async execute(context, params) {
        const enabled: boolean = context.config.enabled;
        const offset: number = context.config.offset;
        const limit: number = params.limit;
        return { enabled, total: offset + limit };
      },
    }),
    collect: defineSourceAdapterAction(transformedConfigSchema, {
      description: "返回采集结果。",
      params: z.object({}),
      output: z.object({ accepted: z.boolean() }),
      async execute(_context, _params) {
        return { accepted: true };
      },
    }),
    discover: defineSourceAdapterAction(transformedConfigSchema, {
      description: "返回发现结果。",
      params: z.object({}),
      output: z.object({ feeds: z.array(z.string()) }),
      // @ts-expect-error 输出声明要求订阅源标识为字符串。
      async execute() {
        return { feeds: [1] };
      },
    }),
  },
});

void typedActionAdapter;

defineSourceAdapter({
  id: "example.missing-check",
  version: "1.0.0",
  configSchema: z.object({}),
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  // @ts-expect-error 声明的动作中必须包含 check。
  actions: {
    collect: defineSourceAdapterAction(z.object({}), {
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
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  // @ts-expect-error 声明的动作中必须包含 collect。
  actions: {
    check: defineSourceAdapterAction(z.object({}), {
      description: "检查信源端点。",
      params: z.object({}),
      output: z.object({ available: z.boolean() }),
      async execute() {
        return { available: true };
      },
    }),
  },
});
