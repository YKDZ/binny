import { defineCollector } from "@binny/collector-sdk";
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
    sample: {
      description: sampleActionDescription,
      params: z.object({ limit: z.number().int().min(1) }),
      async execute() {
        return { sampled: true };
      },
    },
  },
});
