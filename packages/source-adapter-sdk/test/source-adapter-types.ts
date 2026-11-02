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
      description: "Check the feed.",
      params: z.object({}),
      output: z.object({ available: z.boolean() }),
      async execute() {
        return { available: true };
      },
    }),
    collect: defineSourceAdapterAction(basicConfigSchema, {
      description: "Collect selected feed entries.",
      params: z.object({ scope: z.enum(["all", "recent"]) }),
      output: z.object({ completedScopes: z.array(z.string()) }),
      async execute(_context, params) {
        const scope: "all" | "recent" = params.scope;
        return { completedScopes: [scope] };
      },
    }),
    discover: defineSourceAdapterAction(basicConfigSchema, {
      description: "Discover available feeds.",
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

const typedActionAdapter = defineSourceAdapter({
  id: "example.typed-actions",
  version: "1.0.0",
  configSchema: transformedConfigSchema,
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  actions: {
    check: defineSourceAdapterAction(transformedConfigSchema, {
      description: "Return the typed configuration summary.",
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
      description: "Return a typed collection result.",
      params: z.object({}),
      output: z.object({ accepted: z.boolean() }),
      async execute(_context, _params) {
        return { accepted: true };
      },
    }),
    discover: defineSourceAdapterAction(transformedConfigSchema, {
      description: "Return a typed discovery result.",
      params: z.object({}),
      output: z.object({ feeds: z.array(z.string()) }),
      // @ts-expect-error The declared output requires string feed IDs.
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
      description: "Collect entries.",
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
      description: "Check the endpoint.",
      params: z.object({}),
      output: z.object({ available: z.boolean() }),
      async execute() {
        return { available: true };
      },
    }),
  },
});
