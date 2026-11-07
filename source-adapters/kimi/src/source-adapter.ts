// Source adapter definition for kimi.
import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  incrementalSyncStateSchema,
} from "@binny/source-adapter-sdk";

import {
  actionParamsSchema,
  checkOutputSchema,
  collectOutputSchema,
  configSchema,
  executeKimiCheck,
  executeKimiCollect,
  executeKimiSync,
  syncOutputSchema,
} from "./changelog.ts";

export const sourceAdapter = defineSourceAdapter({
  id: "kimi",
  version: "0.1.0",
  description: "Kimi regional research and platform changelogs source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, {
      description: "检查 Kimi 信源可用性与正文格式。",
      params: actionParamsSchema,
      output: checkOutputSchema,
      execute: executeKimiCheck,
    }),
    collect: defineSourceAdapterAction(configSchema, {
      description: "即时采集并归档整页 Kimi 更新日志与关联媒体。",
      params: actionParamsSchema,
      output: collectOutputSchema,
      execute: executeKimiCollect,
    }),
    sync: defineSourceAdapterAction(configSchema, {
      description:
        "增量同步 Kimi 更新日志；首次建立观察基线，后续正文变化保存整页版本。",
      params: actionParamsSchema,
      output: syncOutputSchema,
      execute: executeKimiSync,
    }),
  },
});
