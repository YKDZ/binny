// Source adapter definition for qwen.
import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  incrementalSyncStateSchema,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

const configSchema = z.object({}).strict();
const paramsSchema = z.object({}).strict();
const checkOutputSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string()),
    basis: z.string(),
    problems: z.array(z.unknown()),
  })
  .strict();
const collectOutputSchema = z
  .object({ completedScopes: z.array(z.string()).readonly() })
  .strict();

export const sourceAdapter = defineSourceAdapter({
  id: "qwen",
  version: "0.1.0",
  description: "Qwen bilingual research articles source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, {
      description: "Check source availability.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: () =>
        Promise.resolve({
          availability: "available" as const,
          scope: [],
          basis: "init",
          problems: [],
        }),
    }),
    collect: defineSourceAdapterAction(configSchema, {
      description: "Collect source items.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: () => Promise.resolve({ completedScopes: [] }),
    }),
  },
});
