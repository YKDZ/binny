import {
  defineCollector,
  defineCollectorCheckAction,
} from "@binny/collector-sdk";
import { z } from "zod";

import { sampleActionDescription } from "./helper.ts";

export default defineCollector({
  id: "binny14.protocol-fixture",
  version: "1.0.0",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema: z.object({ section: z.string() }),
  actions: {
    check: defineCollectorCheckAction({
      description: "说明轻量测试环境未配置真实信源。",
      params: z.object({}),
      async execute() {
        return {
          availability: "unknown",
          scope: ["sample"],
          basis: "测试采集器没有配置可检查的外部信源。",
          problems: [
            {
              code: "sample_source_unconfigured",
              message: "测试采集器没有连接外部信源。",
              impact: "无法判断真实信源是否可用。",
              suggestion: "配置受控信源后重新触发 check。",
              requiresHuman: false,
            },
          ],
        };
      },
    }),
    sample: {
      description: sampleActionDescription,
      params: z.object({ limit: z.number().int().min(1) }),
      async execute() {
        return { sampled: true };
      },
    },
  },
});
