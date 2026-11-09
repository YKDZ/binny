import {
  defineSourceAdapter,
  defineSourceAdapterAction,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

const configSchema = z
  .object({
    section: z
      .string()
      .default("sample")
      .transform((value) => value + "!"),
  })
  .refine(({ section }) => section !== "forbidden!", {
    path: ["section"],
    message: "该板块不可用。",
  });
const extensionsSchema = z.object({}).strict();

export default defineSourceAdapter({
  id: "binny-runtime.configuration-validation-fixture",
  version: "1.0.0",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "报告配置验证测试状态。",
      params: z.object({}),
      output: z.object({ available: z.boolean() }),
      async execute() {
        return { available: true };
      },
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "报告配置验证测试范围。",
      params: z.object({}),
      output: z.object({ section: z.string() }),
      async execute(context) {
        return { section: context.config.section };
      },
    }),
  },
});
