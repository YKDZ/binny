import { readFile } from "node:fs/promises";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
} from "@binny/source-adapter-sdk";
import { parseFeed } from "@rowanmanning/feed-parser";
import { z } from "zod";

const configSchema = z.object({ section: z.string() });
const extensionsSchema = z.object({}).strict();
const collectOutputSchema = z.object({
  feedTitle: z.string(),
  itemTitle: z.string(),
  bodyText: z.string(),
});

export default defineSourceAdapter({
  id: "binny-runtime.lightweight-resource-fixture",
  version: "1.0.0",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Report the packaged adapter resource and dependency status.",
      params: z.object({}),
      output: z.object({ ready: z.literal(true) }),
      async execute() {
        return { ready: true as const };
      },
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Parse the feed packaged with this adapter image and archive its entry.",
      params: z.object({}),
      output: collectOutputSchema,
      async execute(context) {
        const xml = await readFile(
          new URL("../resources/sample-feed.xml", import.meta.url),
          "utf8",
        );
        const feed = parseFeed(xml);
        const item = feed.items[0];
        if (item === undefined || item.title === null || feed.title === null) {
          throw new Error("The packaged feed resource has no titled entry.");
        }
        const bodyText = item.description ?? "";
        await context.archive.submit({
          requestId: "lightweight-resource-fixture:" + context.runId,
          items: [
            {
              sourceKey: {
                namespace: "binny-runtime.lightweight-resource-fixture",
                key: context.binId,
              },
              title: item.title,
              sourcePublishedAt: null,
              sourceModifiedAt: null,
              extensions: {},
              body: { text: bodyText },
              capture: {
                scope: {
                  feedTitle: feed.title,
                  section: context.config.section,
                },
                completeness: "complete",
                missing: [],
              },
            },
          ],
        });
        return { feedTitle: feed.title, itemTitle: item.title, bodyText };
      },
    }),
  },
});
