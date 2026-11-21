import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  searchSummaryField,
  sourceAdapterManifest,
} from "../src/index.ts";

const configSchema = z.object({});
const extensionsSchema = z
  .object({ category: z.enum(["question", "reply"]) })
  .strict();
const action = defineSourceAdapterAction(configSchema, extensionsSchema, {
  description: "执行测试动作。",
  params: z.object({}),
  output: z.object({ accepted: z.boolean() }),
  async execute() {
    return { accepted: true };
  },
});

void test("adapter manifest publishes extension and state JSON Schemas", () => {
  const sourceAdapter = defineSourceAdapter({
    id: "test.sync-state-contract",
    version: "1.0.0",
    configSchema,
    extensionsSchema,
    environment: {
      browser: { required: false, profileReuseAfterRestart: false },
    },
    stateSchema: z
      .object({ cursor: z.iso.datetime().describe("实际接续位置。") })
      .strict(),
    stateSnapshotSchema: z
      .union([
        z.object({ cursor: z.iso.datetime() }).strict(),
        z.object({ status: z.literal("unavailable") }).strict(),
      ])
      .describe("当前接续状态或不可用原因。"),
    actions: { check: action, collect: action },
  });

  const manifest = sourceAdapterManifest(sourceAdapter);

  assert.deepEqual(manifest.extensionsSchema.required, ["category"]);
  assert.equal(manifest.extensionsSchema.additionalProperties, false);
  const extensionProperties = manifest.extensionsSchema.properties;
  assert.ok(
    typeof extensionProperties === "object" && extensionProperties !== null,
  );
  assert.deepEqual(
    (extensionProperties as Record<string, { readonly enum?: unknown[] }>)
      .category?.enum,
    ["question", "reply"],
  );
  assert.deepEqual(manifest.stateSchema?.required, ["cursor"]);
  const properties = manifest.stateSchema?.properties;
  assert.ok(typeof properties === "object" && properties !== null);
  const cursor = (properties as Record<string, unknown>).cursor;
  assert.ok(typeof cursor === "object" && cursor !== null);
  const cursorSchema = cursor as Record<string, unknown>;
  assert.equal(cursorSchema.type, "string");
  assert.equal(cursorSchema.format, "date-time");
  assert.equal(cursorSchema.description, "实际接续位置。");
  assert.equal(
    manifest.stateSnapshotSchema?.description,
    "当前接续状态或不可用原因。",
  );
  const snapshotVariants = manifest.stateSnapshotSchema?.anyOf;
  assert.ok(Array.isArray(snapshotVariants));
  assert.equal(snapshotVariants.length, 2);
  const unavailable = snapshotVariants[1] as {
    readonly properties?: Readonly<
      Record<string, { readonly const?: unknown }>
    >;
  };
  assert.equal(unavailable.properties?.status?.const, "unavailable");
  assert.equal("searchSummaryFields" in manifest, false);
  assert.equal("searchRelations" in manifest, false);
});

void test("adapter manifest preserves declared searchRelations and rejects invalid declarations", () => {
  const withRelations = defineSourceAdapter({
    id: "test.search-relations",
    version: "1.0.0",
    configSchema,
    extensionsSchema,
    searchRelations: {
      topicRoot: {
        relationName: "topic_reply",
        direction: "incoming",
        description: "Opening post of the topic linked to a reply.",
      },
    },
    environment: {
      browser: { required: false, profileReuseAfterRestart: false },
    },
    actions: { check: action, collect: action },
  });

  const manifest = sourceAdapterManifest(withRelations);
  assert.deepEqual(manifest.searchRelations, {
    topicRoot: {
      relationName: "topic_reply",
      direction: "incoming",
      description: "Opening post of the topic linked to a reply.",
    },
  });

  const withEmptyRelations = defineSourceAdapter({
    id: "test.empty-search-relations",
    version: "1.0.0",
    configSchema,
    extensionsSchema,
    searchRelations: {},
    environment: {
      browser: { required: false, profileReuseAfterRestart: false },
    },
    actions: { check: action, collect: action },
  });
  assert.equal(
    "searchRelations" in sourceAdapterManifest(withEmptyRelations),
    false,
  );

  assert.throws(() =>
    sourceAdapterManifest(
      defineSourceAdapter({
        id: "test.invalid-search-relations",
        version: "1.0.0",
        configSchema,
        extensionsSchema,
        searchRelations: {
          "bad role": {
            relationName: "topic_reply",
            direction: "incoming",
          },
        },
        environment: {
          browser: { required: false, profileReuseAfterRestart: false },
        },
        actions: { check: action, collect: action },
      }),
    ),
  );
  assert.throws(() =>
    sourceAdapterManifest(
      defineSourceAdapter({
        id: "test.invalid-relation-name",
        version: "1.0.0",
        configSchema,
        extensionsSchema,
        searchRelations: {
          topicRoot: {
            relationName: "",
            direction: "incoming",
          },
        },
        environment: {
          browser: { required: false, profileReuseAfterRestart: false },
        },
        actions: { check: action, collect: action },
      }),
    ),
  );
});

function hasKeywordAnywhere(node: unknown, keyword: string): boolean {
  if (typeof node !== "object" || node === null) return false;
  if (Array.isArray(node)) {
    return node.some((item) => hasKeywordAnywhere(item, keyword));
  }
  if (Object.hasOwn(node, keyword)) return true;
  return Object.values(node).some((value) =>
    hasKeywordAnywhere(value, keyword),
  );
}

void test("adapter manifest extracts searchSummaryFields and strips internal markers from extensionsSchema", () => {
  const summaryExtensionsSchema = z
    .object({
      postNumber: searchSummaryField(z.int().positive().describe("Floor")),
      tags: searchSummaryField(z.array(z.string()).nullable().optional()),
      topic: z.strictObject({
        slug: z.string(),
        title: searchSummaryField(z.string().min(1)).optional(),
      }),
      nullableTopic: z
        .strictObject({
          label: searchSummaryField(z.string()).nullable(),
        })
        .optional(),
    })
    .strict();

  const summaryAction = defineSourceAdapterAction(
    configSchema,
    summaryExtensionsSchema,
    {
      description: "Execute summary test action.",
      params: z.object({}),
      output: z.object({ accepted: z.boolean() }),
      async execute() {
        return { accepted: true };
      },
    },
  );

  const sourceAdapter = defineSourceAdapter({
    id: "test.search-summary-manifest",
    version: "1.0.0",
    configSchema,
    extensionsSchema: summaryExtensionsSchema,
    environment: {
      browser: { required: false, profileReuseAfterRestart: false },
    },
    actions: { check: summaryAction, collect: summaryAction },
  });

  const manifest = sourceAdapterManifest(sourceAdapter);

  assert.deepEqual(manifest.searchSummaryFields, [
    "postNumber",
    "tags",
    "topic.title",
    "nullableTopic.label",
  ]);
  assert.equal(
    hasKeywordAnywhere(manifest.extensionsSchema, "x-binny-search-summary"),
    false,
  );
});

void test("adapter manifest rejects invalid searchSummaryField placements", () => {
  const buildManifest = (badExtensionsSchema: z.ZodObject) => {
    const badAction = defineSourceAdapterAction(
      configSchema,
      badExtensionsSchema,
      {
        description: "Invalid summary test action.",
        params: z.object({}),
        output: z.object({ accepted: z.boolean() }),
        async execute() {
          return { accepted: true };
        },
      },
    );
    return sourceAdapterManifest(
      defineSourceAdapter({
        id: "test.invalid-summary",
        version: "1.0.0",
        configSchema,
        extensionsSchema: badExtensionsSchema,
        environment: {
          browser: { required: false, profileReuseAfterRestart: false },
        },
        actions: { check: badAction, collect: badAction },
      }),
    );
  };

  assert.throws(() =>
    buildManifest(
      z.strictObject({
        topic: searchSummaryField(z.strictObject({ title: z.string() })),
      }),
    ),
  );
  assert.throws(() =>
    buildManifest(
      z.strictObject({
        media: searchSummaryField(z.array(z.strictObject({ url: z.string() }))),
      }),
    ),
  );
  assert.throws(() =>
    buildManifest(
      z.strictObject({
        tags: z.array(searchSummaryField(z.string())),
      }),
    ),
  );
  assert.throws(() =>
    buildManifest(
      z.strictObject({
        "topic.title": searchSummaryField(z.string()),
      }),
    ),
  );
  assert.throws(() =>
    buildManifest(
      z.strictObject({
        a: z.strictObject({
          b: z.strictObject({
            c: z.strictObject({
              d: z.strictObject({
                e: z.strictObject({
                  f: z.strictObject({
                    g: z.strictObject({
                      h: z.strictObject({
                        i: searchSummaryField(z.string()),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    ),
  );
});
