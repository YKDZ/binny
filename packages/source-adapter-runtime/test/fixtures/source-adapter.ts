import {
  defineSourceAdapter,
  defineSourceAdapterAction,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import { sampleActionDescription } from "./helper.ts";

const configSchema = z.object({ section: z.string() });
const extensionsSchema = z.object({}).strict();
const diagnosticOutputSchema = z.object({
  availability: z.enum(["available", "unavailable", "unknown"]),
  scope: z.array(z.string()),
  basis: z.string(),
  problems: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      impact: z.string(),
      suggestion: z.string(),
      requiresHuman: z.boolean(),
    }),
  ),
});

export default defineSourceAdapter({
  id: "binny-runtime.protocol-fixture",
  version: "1.0.0",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "说明轻量测试环境未配置真实信源。",
      params: z.object({}),
      output: diagnosticOutputSchema,
      async execute() {
        return {
          availability: "unknown" as const,
          scope: ["sample"],
          basis: "测试信源适配器没有配置可检查的外部信源。",
          problems: [
            {
              code: "sample_source_unconfigured",
              message: "测试信源适配器没有连接外部信源。",
              impact: "无法判断真实信源是否可用。",
              suggestion: "配置受控信源后重新触发 check。",
              requiresHuman: false,
            },
          ],
        };
      },
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "运行轻量测试采集动作。",
      params: z.object({}),
      output: z.object({ completedScopes: z.array(z.string()) }),
      async execute() {
        return { completedScopes: ["sample"] };
      },
    }),
    sample: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: sampleActionDescription,
      params: z.object({ limit: z.int().min(1) }),
      output: z.object({ sampled: z.boolean() }),
      async execute() {
        return { sampled: true };
      },
    }),
  },
});
