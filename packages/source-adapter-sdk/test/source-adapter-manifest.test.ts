import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import {
  defineSourceAdapter,
  defineSourceAdapterAction,
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
});
