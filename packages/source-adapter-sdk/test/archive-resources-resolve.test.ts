import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveArchiveResources,
  SourceAdapterActionError,
  type SourceAdapterApiClient,
} from "../src/index.ts";

void test("resolveArchiveResources returns result on successful 200 response", async () => {
  const mockResult = {
    resources: [
      {
        resourceId: "11111111-1111-1111-1111-111111111111",
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        mediaType: "image/png",
        size: 1024,
      },
    ],
    items: [],
    mediaByUrl: {},
  };

  const client = {
    resources: {
      resolve: {
        async $post(args: { json: unknown }) {
          assert.deepEqual(args.json, {
            resourceIds: ["11111111-1111-1111-1111-111111111111"],
          });
          return {
            status: 200,
            async json() {
              return mockResult;
            },
          };
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  const result = await resolveArchiveResources(client, {
    resourceIds: ["11111111-1111-1111-1111-111111111111"],
  });

  assert.deepEqual(result, mockResult);
});

void test("resolveArchiveResources throws SourceAdapterActionError on failure", async () => {
  const client = {
    resources: {
      resolve: {
        async $post() {
          return {
            status: 400,
            async json() {
              return {
                error: {
                  code: "invalid_input",
                  message: "请求输入无效。",
                  path: ["resourceIds", 0],
                },
              };
            },
          };
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  await assert.rejects(
    async () => {
      await resolveArchiveResources(client, {
        resourceIds: ["invalid-id"],
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof SourceAdapterActionError);
      assert.equal(err.failure.code, "invalid_input");
      assert.equal(err.failure.message, "请求输入无效。");
      assert.deepEqual(err.failure.path, ["resourceIds", 0]);
      return true;
    },
  );
});
