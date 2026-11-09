import {
  defineSourceAdapter,
  defineSourceAdapterAction,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

const configurationSchema = z
  .object({
    section: z.string(),
    label: z
      .string()
      .default("runtime")
      .transform((value) => value + "!"),
  })
  .strict();
const extensionsSchema = z
  .object({
    category: z
      .enum(["comment"])
      .describe("The category assigned to this archived item.")
      .optional(),
  })
  .strict();
const paramsSchema = z.object({});
const outputSchema = z.object({ accepted: z.literal(true) });

function declareAction(description: string) {
  return defineSourceAdapterAction(configurationSchema, extensionsSchema, {
    description,
    params: paramsSchema,
    output: outputSchema,
    async execute() {
      return { accepted: true as const };
    },
  });
}

export default defineSourceAdapter({
  id: "binny-runs.manual-run-fixture",
  version: "2.0.0",
  description: "A second saved schema for extension range validation.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema: configurationSchema,
  extensionsSchema,
  actions: {
    check: declareAction("Check the schema fixture adapter."),
    collect: declareAction("Collect from the schema fixture adapter."),
    discover: declareAction("Discover the schema fixture adapter."),
  },
});
