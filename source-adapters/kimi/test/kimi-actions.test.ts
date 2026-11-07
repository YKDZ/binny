import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  createSourceAdapterContext,
  isSourceAdapterActionError,
  type ArchiveResourceMetadata,
  type ArchiveSubmissionInput,
  type IncrementalSyncState,
  type SourceAdapterApiClient,
  type SourceAdapterContext,
  type SourceAdapterRunContext,
} from "@binny/source-adapter-sdk";

import type { KimiConfig } from "../src/changelog.ts";
import sourceAdapter from "../src/index.ts";

function createTestContext(
  config: KimiConfig,
  options?: {
    persistentState?: {
      load(): Promise<unknown>;
      save(state: unknown): Promise<void>;
    };
    signal?: AbortSignal;
  },
) {
  let commitSequence = 0;
  let resourceSequence = 0;
  const submissions: ArchiveSubmissionInput[] = [];
  const uploadedResources: ArchiveResourceMetadata[] = [];

  const mockClient = {
    archives: {
      async $post({ json }: { json: ArchiveSubmissionInput }) {
        submissions.push(json);
        return {
          status: 201 as const,
          json: async () => ({
            commitId: `commit-${++commitSequence}`,
            committedAt: "2026-11-07T00:00:00.000Z",
            itemCount: json.items.length,
            revisionCount: json.items.length,
          }),
        };
      },
    },
    resources: {
      async $post(
        { header }: { header: { "content-type": string } },
        init: { init: RequestInit },
      ) {
        const body = init.init.body as Blob;
        const resource: ArchiveResourceMetadata = {
          resourceId: `res-${++resourceSequence}`,
          mediaType: header["content-type"],
          size: body?.size ?? 128,
          sha256: `sha-${resourceSequence}`,
        };
        uploadedResources.push(resource);
        return {
          status: 201 as const,
          json: async () => resource,
        };
      },
      resolve: {
        async $post() {
          return {
            status: 200 as const,
            json: async () => ({
              resolved: [],
              missing: [],
            }),
          };
        },
      },
    },
  } as unknown as SourceAdapterApiClient;

  const runContext: SourceAdapterRunContext<KimiConfig> = {
    binId: "kimi-test-bin",
    identityId: "kimi-test-identity",
    runId: randomUUID(),
    referenceTime: "2026-11-07T12:00:00.000Z",
    sourceAdapterVersion: sourceAdapter.version,
    config,
    signal: options?.signal ?? new AbortController().signal,
    report: async () => {},
    ...(options?.persistentState !== undefined
      ? {
          persistentState: options.persistentState as unknown as NonNullable<
            SourceAdapterContext["persistentState"]
          >,
        }
      : {}),
  };

  const context = createSourceAdapterContext(mockClient, runContext);

  return { context, submissions, uploadedResources };
}

void test("Kimi platform changelogs source adapter actions and ongoing documents", async (t) => {
  let cnPlatformChangelogVersion = 1;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/docs/changelog/index.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      const v2Content =
        cnPlatformChangelogVersion >= 2
          ? "## 2026年11月\n\n- Kimi K2.5 模型深度推理发布。\n\n"
          : "";
      response.end(
        `---\ntitle: Kimi 开放平台更新日志\n---\n\n${v2Content}# 2026年10月\n\n- 支持 Kimi K2 模型流式输出与深度推理。\n- 开放 Function Calling 结构化输出能力。\n\n## 2026年9月\n\n- 开放平台基础能力正式上线。\n`,
      );
      return;
    }

    if (path === "/docs/platform-changelog.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      response.end(
        `# October 2026\n\n- Moonshot AI platform introduces global API endpoints.\n- Latency optimizations for context caching.\n\n# September 2026\n\n- Initial international developer platform release.\n`,
      );
      return;
    }

    if (path === "/docs/hosted-agents/changelog.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      response.end(
        `# Kimi Hosted Agents 更新日志\n\n## 2026-10-14\n\n- 支持长任务托管 Agent 自动恢复机制。\n- 优化了 Agent 会话保持与工具调用超时重试。\n\n## 2026-09-25\n\n- Hosted Agents Beta 内部测试版上线。\n`,
      );
      return;
    }

    if (path === "/docs/media-changelog.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      response.end(
        `# Kimi 带媒体更新日志\n\n## 2026-10-20\n\n架构图展示：\n\n![架构示意图](/media/arch.png)\n\n失效图片：\n\n![不存在图片](/media/missing.png)\n\n错误页伪装：\n\n![错误页图片](/media/error-page.png)\n`,
      );
      return;
    }

    if (path === "/media/arch.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      return;
    }

    if (path === "/media/error-page.png") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body>500 Internal Error</body></html>",
      );
      return;
    }

    if (path === "/docs/spa-shell.md") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!DOCTYPE html><html><head><title>SPA</title></head><body><div id="root"></div></body></html>',
      );
      return;
    }

    if (path === "/docs/empty.md") {
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
      });
      response.end("");
      return;
    }

    if (path === "/docs/500.md") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("Internal Server Error");
      return;
    }

    if (path === "/docs/403.md") {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Forbidden");
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const validConfig: KimiConfig = {
    sources: [
      {
        id: "cn-platform-changelog",
        kind: "changelog",
        region: "cn",
        language: "zh-CN",
        url: `${origin}/docs/changelog/index.md`,
        title: "Kimi 开放平台更新日志",
      },
      {
        id: "int-platform-changelog",
        kind: "changelog",
        region: "international",
        language: "en",
        url: `${origin}/docs/platform-changelog.md`,
        title: "Moonshot AI Platform Changelog",
      },
      {
        id: "cn-hosted-agents-changelog",
        kind: "changelog",
        region: "cn",
        language: "zh-CN",
        url: `${origin}/docs/hosted-agents/changelog.md`,
        title: "Kimi Hosted Agents 更新日志",
      },
    ],
  };

  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  await t.test(
    "check action reports availability and catches invalid sources",
    async () => {
      const { context } = createTestContext(validConfig);
      const result = await sourceAdapter.actions.check.execute(context, {});

      assert.equal(result.availability, "available");
      assert.deepEqual(result.scope, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      assert.equal(result.problems.length, 0);

      // Test with invalid sources (SPA shell, 500 error, 404)
      const invalidConfig: KimiConfig = {
        sources: [
          {
            id: "spa-source",
            kind: "changelog",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/docs/spa-shell.md`,
          },
          {
            id: "error-source",
            kind: "changelog",
            region: "international",
            language: "en",
            url: `${origin}/docs/500.md`,
          },
        ],
      };

      const { context: invalidCtx } = createTestContext(invalidConfig);
      const invalidResult = await sourceAdapter.actions.check.execute(
        invalidCtx,
        {},
      );
      assert.equal(invalidResult.availability, "unavailable");
      assert.equal(invalidResult.problems.length, 2);
      assert.equal(
        invalidResult.problems[0]?.code,
        "kimi_changelog_unavailable",
      );
      assert.equal(
        invalidResult.problems[1]?.code,
        "kimi_changelog_unavailable",
      );
    },
  );

  await t.test(
    "distinct sourceKeys, exact date precision, and clean Markdown without body.html",
    async () => {
      let storedState: IncrementalSyncState | undefined;
      const persistentState = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = state as IncrementalSyncState;
        },
      };

      const { context, submissions } = createTestContext(validConfig, {
        persistentState,
      });

      const collectResult = await sourceAdapter.actions.collect.execute(
        context,
        {},
      );
      assert.deepEqual(collectResult.completedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);

      assert.equal(submissions.length, 3);

      // Verify CN Platform Changelog
      const cnPlatformSub = submissions[0];
      assert.ok(cnPlatformSub !== undefined);
      assert.equal(cnPlatformSub.items.length, 1);
      const cnItem = cnPlatformSub.items[0];
      assert.ok(cnItem !== undefined);
      assert.deepEqual(cnItem.sourceKey, {
        namespace: "kimi:cn",
        key: "changelog:cn-platform-changelog",
      });
      assert.equal(cnItem.sourceRef, `${origin}/docs/changelog/index.md`);
      assert.equal(cnItem.properties?.["title"], "Kimi 开放平台更新日志");
      assert.equal(
        cnItem.sourceModifiedAt,
        undefined,
        "month precision date must not fabricate timestamp",
      );
      assert.equal(cnItem.metadata?.["documentKind"], "changelog");
      assert.equal(cnItem.metadata?.["region"], "cn");
      assert.equal(cnItem.metadata?.["language"], "zh-CN");
      assert.equal(cnItem.metadata?.["datePrecision"], "month");
      assert.equal(cnItem.metadata?.["latestDate"], "2026-10");
      assert.deepEqual(cnItem.metadata?.["observedDates"], [
        "2026-10",
        "2026-09",
      ]);
      assert.ok(cnItem.body?.markdown?.includes("Kimi K2"));
      assert.ok(cnItem.body?.text?.includes("Kimi K2"));
      assert.equal(
        (cnItem.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
        "must not produce body.html",
      );

      // Verify International Platform Changelog
      const intPlatformSub = submissions[1];
      assert.ok(intPlatformSub !== undefined);
      const intItem = intPlatformSub.items[0];
      assert.ok(intItem !== undefined);
      assert.deepEqual(intItem.sourceKey, {
        namespace: "kimi:international",
        key: "changelog:int-platform-changelog",
      });
      assert.equal(intItem.sourceRef, `${origin}/docs/platform-changelog.md`);
      assert.equal(
        intItem.sourceModifiedAt,
        undefined,
        "month precision date must not fabricate timestamp",
      );
      assert.equal(intItem.metadata?.["documentKind"], "changelog");
      assert.equal(intItem.metadata?.["region"], "international");
      assert.equal(intItem.metadata?.["language"], "en");
      assert.equal(intItem.metadata?.["datePrecision"], "month");
      assert.equal(intItem.metadata?.["latestDate"], "2026-10");
      assert.deepEqual(intItem.metadata?.["observedDates"], [
        "2026-10",
        "2026-09",
      ]);
      assert.equal(
        (intItem.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
      );

      // Verify CN Hosted Agents Changelog
      const hostedSub = submissions[2];
      assert.ok(hostedSub !== undefined);
      const hostedItem = hostedSub.items[0];
      assert.ok(hostedItem !== undefined);
      assert.deepEqual(hostedItem.sourceKey, {
        namespace: "kimi:cn",
        key: "changelog:cn-hosted-agents-changelog",
      });
      assert.equal(
        hostedItem.sourceRef,
        `${origin}/docs/hosted-agents/changelog.md`,
      );
      assert.equal(
        hostedItem.sourceModifiedAt,
        undefined,
        "day precision date must not fabricate timestamp",
      );
      assert.equal(hostedItem.metadata?.["documentKind"], "changelog");
      assert.equal(hostedItem.metadata?.["region"], "cn");
      assert.equal(hostedItem.metadata?.["language"], "zh-CN");
      assert.equal(hostedItem.metadata?.["datePrecision"], "day");
      assert.equal(hostedItem.metadata?.["latestDate"], "2026-10-14");
      assert.deepEqual(hostedItem.metadata?.["observedDates"], [
        "2026-10-14",
        "2026-09-25",
      ]);
      assert.equal(
        (hostedItem.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
      );

      // Source keys between CN and International must be strictly distinct
      assert.notEqual(cnItem.sourceKey.namespace, intItem.sourceKey.namespace);
      assert.notEqual(cnItem.sourceKey.key, intItem.sourceKey.key);
      assert.notEqual(hostedItem.sourceKey.key, cnItem.sourceKey.key);
    },
  );

  await t.test(
    "sync baseline, unchanged skip, and revision detection lifecycle",
    async () => {
      let storedState: IncrementalSyncState | undefined;
      const persistentState = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = state as IncrementalSyncState;
        },
      };

      // 1. First sync run on uninitialized state establishes baseline with 0 archive submissions
      const { context: ctx1, submissions: sub1 } = createTestContext(
        validConfig,
        {
          persistentState,
        },
      );
      const syncResult1 = await sourceAdapter.actions.sync.execute(ctx1, {});

      assert.equal(
        sub1.length,
        0,
        "first sync establishing baseline must make 0 archive submissions",
      );
      assert.deepEqual(syncResult1.completedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      assert.deepEqual(syncResult1.initializedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      assert.ok(storedState !== undefined);
      assert.ok(
        storedState.scopes["cn-platform-changelog"]?.ongoingDocuments?.[
          "cn-platform-changelog"
        ]?.contentHash,
      );

      // 2. Second sync run with unchanged content makes 0 archive submissions
      const { context: ctx2, submissions: sub2 } = createTestContext(
        validConfig,
        {
          persistentState,
        },
      );
      const syncResult2 = await sourceAdapter.actions.sync.execute(ctx2, {});

      assert.equal(
        sub2.length,
        0,
        "subsequent sync with unchanged content must make 0 archive submissions",
      );
      assert.deepEqual(syncResult2.completedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      assert.equal(syncResult2.initializedScopes, undefined);

      // 3. Edit changelog content on server and run third sync
      cnPlatformChangelogVersion = 2; // Server now serves 2026年11月 entry

      const { context: ctx3, submissions: sub3 } = createTestContext(
        validConfig,
        {
          persistentState,
        },
      );
      const syncResult3 = await sourceAdapter.actions.sync.execute(ctx3, {});

      assert.equal(
        sub3.length,
        1,
        "sync after content change must submit whole-page revision",
      );
      assert.deepEqual(syncResult3.completedScopes, [
        "cn-platform-changelog",
        "int-platform-changelog",
        "cn-hosted-agents-changelog",
      ]);
      const revisionItem = sub3[0]?.items[0];
      assert.ok(revisionItem !== undefined);
      assert.deepEqual(revisionItem.sourceKey, {
        namespace: "kimi:cn",
        key: "changelog:cn-platform-changelog",
      });
      assert.ok(revisionItem.body?.markdown?.includes("2026年11月"));
      assert.equal(revisionItem.metadata?.["latestDate"], "2026-11");
    },
  );

  await t.test(
    "collect archives referenced media and records partial media failures",
    async () => {
      const mediaConfig: KimiConfig = {
        sources: [
          {
            id: "media-changelog",
            kind: "changelog",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/docs/media-changelog.md`,
            title: "带媒体更新日志",
          },
        ],
      };

      const { context, submissions, uploadedResources } =
        createTestContext(mediaConfig);
      const result = await sourceAdapter.actions.collect.execute(context, {});

      assert.deepEqual(result.completedScopes, ["media-changelog"]);
      assert.equal(submissions.length, 1);
      assert.equal(
        uploadedResources.length,
        1,
        "successful image should be uploaded",
      );

      const item = submissions[0]?.items[0];
      assert.ok(item !== undefined);
      assert.ok(item.body?.markdown?.includes("binny://resource/res-1"));
      assert.equal(
        (item.body as Record<string, unknown> | undefined)?.["html"],
        undefined,
      );

      // Missing array should record partial failures (404 missing.png, error-page.png)
      assert.ok(item.capture.missing.length >= 2);
      const missingUrls = item.capture.missing.map(
        (m: { readonly reason: string }) => m.reason,
      );
      assert.ok(
        missingUrls.some((r: string) => r.includes("/media/missing.png")),
      );
      assert.ok(
        missingUrls.some((r: string) => r.includes("/media/error-page.png")),
      );
    },
  );

  await t.test(
    "error handling does not advance state or create fallback summaries",
    async () => {
      let storedState: IncrementalSyncState | undefined;
      const persistentState = {
        async load() {
          return storedState;
        },
        async save(state: unknown) {
          storedState = state as IncrementalSyncState;
        },
      };

      const failConfig: KimiConfig = {
        sources: [
          {
            id: "fail-403",
            kind: "changelog",
            region: "cn",
            language: "zh-CN",
            url: `${origin}/docs/403.md`,
          },
        ],
      };

      const { context, submissions } = createTestContext(failConfig, {
        persistentState,
      });

      await assert.rejects(
        async () => sourceAdapter.actions.sync.execute(context, {}),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "kimi_sync_incomplete");
          return true;
        },
      );

      assert.equal(
        submissions.length,
        0,
        "failure must not create archive submissions",
      );
      assert.equal(
        storedState?.scopes["fail-403"],
        undefined,
        "failed scope must not establish or advance state",
      );

      await assert.rejects(
        async () => sourceAdapter.actions.collect.execute(context, {}),
        (error) => {
          assert.ok(isSourceAdapterActionError(error));
          assert.equal(error.failure.code, "kimi_collection_incomplete");
          return true;
        },
      );
      assert.equal(submissions.length, 0);
    },
  );
});
