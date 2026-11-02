import { z } from "zod";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  defineSourceAdapterCheckAction,
} from "../src/index.ts";

const sourceAdapter = defineSourceAdapter({
  id: "example.rss",
  version: "1.0.0",
  configSchema: z.object({ feedUrl: z.url() }),
  environment: {
    browser: {
      required: false,
      profileReuseAfterRestart: false,
    },
  },
  actions: {
    check: defineSourceAdapterCheckAction({
      description: "Check the feed.",
      params: z.object({}),
      async execute() {
        return {
          availability: "available",
          scope: ["feed"],
          basis: "The feed endpoint is reachable.",
          problems: [],
        };
      },
    }),
    collect: defineSourceAdapterAction({
      description: "Collect selected feed entries.",
      params: z.object({ scope: z.enum(["all", "recent"]) }),
      async execute(_context, params) {
        const scope: "all" | "recent" = params.scope;
        return { completedScopes: [scope] };
      },
    }),
    discover: defineSourceAdapterAction({
      description: "Discover available feeds.",
      params: z.object({}),
      async execute() {
        return { feeds: ["main"] };
      },
    }),
  },
});

void sourceAdapter;

defineSourceAdapter({
  id: "example.missing-check",
  version: "1.0.0",
  configSchema: z.object({}),
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  // @ts-expect-error 声明的动作中必须包含 check。
  actions: {
    collect: defineSourceAdapterAction({
      description: "Collect entries.",
      params: z.object({}),
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
    check: defineSourceAdapterCheckAction({
      description: "Check the endpoint.",
      params: z.object({}),
      async execute() {
        return {
          availability: "available",
          scope: ["feed"],
          basis: "The feed endpoint is reachable.",
          problems: [],
        };
      },
    }),
  },
});
