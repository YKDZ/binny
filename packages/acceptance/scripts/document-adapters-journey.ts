import assert from "node:assert/strict";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type Cli = (args: readonly string[]) => Promise<ProcessResult>;
type Compose = (args: readonly string[]) => Promise<ProcessResult>;
type DocumentSourceControl = {
  readonly baseUrl: string;
  readonly requests: () => Promise<readonly { readonly path: string }[]>;
  readonly setDocumentVersion: (version: 1 | 2) => Promise<void>;
};

type DocumentAdapterId = "deepseek" | "qwen" | "kimi" | "minimax";

type DocumentAdapterDefinition = {
  readonly adapterId: DocumentAdapterId;
  readonly binId: string;
  readonly identityId: string;
  readonly runtimeService: string;
  readonly sourceAdapterId: string;
  readonly config: (origin: string) => unknown;
  readonly params: Readonly<Record<string, unknown>>;
};

type RegisteredBin = {
  readonly id: string;
  readonly sourceAdapterId: string;
  readonly sourceAdapterVersion: string;
};

type ArchiveSourceKey = { readonly namespace: string; readonly key: string };
type ArchiveState = {
  readonly title: string | null;
  readonly sourcePublishedAt: unknown;
  readonly sourceModifiedAt: unknown;
  readonly extensions: Record<string, unknown>;
  readonly body?: { readonly markdown?: string; readonly text?: string };
};
type ArchiveItemRead = {
  readonly itemId: string;
  readonly sourceKey: ArchiveSourceKey;
  readonly views: readonly {
    readonly binId: string;
    readonly revisionId: string;
    readonly state: ArchiveState;
  }[];
  readonly revisions: readonly { readonly revisionId: string }[];
};
type ArchiveRevisionRead = {
  readonly revisionId: string;
  readonly itemId: string;
  readonly state: ArchiveState;
};
type DocumentRun = {
  readonly runId: string;
  readonly status: string;
  readonly result?: {
    readonly commits?: readonly {
      readonly items: readonly {
        readonly itemId: string;
        readonly revisionId: string;
      }[];
    }[];
    readonly error?: { readonly code?: string; readonly message?: string };
  };
};
type ExpectedState = {
  readonly namespace: string;
  readonly key: string;
  readonly title: (version: 1 | 2) => string;
  readonly titleChanges: boolean;
  readonly publishedAt: (version: 1 | 2) => unknown;
  readonly modifiedAt: (version: 1 | 2) => unknown;
  readonly bodyMarker: string;
  readonly verifyExtensions: (
    extensions: Record<string, unknown>,
    version: 1 | 2,
  ) => void;
};
type RuntimeManifest = {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly extensionsSchema?: {
    readonly additionalProperties?: unknown;
    readonly properties?: Record<string, { readonly description?: unknown }>;
  };
};

const publicFactKeys = new Set([
  "title",
  "sourcePublishedAt",
  "sourceModifiedAt",
]);

const adapters: readonly DocumentAdapterDefinition[] = [
  {
    adapterId: "deepseek",
    binId: "binny-document-deepseek",
    identityId: "binny-document-deepseek-identity",
    runtimeService: "runtime-document-deepseek",
    sourceAdapterId: "deepseek",
    config: (origin) => ({
      sources: [
        {
          id: "e2e-en",
          language: "en",
          updatesUrl: origin + "/deepseek/updates.md",
          title: "DeepSeek Updates",
        },
      ],
    }),
    params: { sourceIds: ["e2e-en"] },
  },
  {
    adapterId: "qwen",
    binId: "binny-document-qwen",
    identityId: "binny-document-qwen-identity",
    runtimeService: "runtime-document-qwen",
    sourceAdapterId: "qwen",
    config: (origin) => ({
      languages: ["en-US"],
      endpointUrl: origin + "/qwen/api/v2/article/retrieval",
      articleType: "qwen_ai",
      siteBaseUrl: origin + "/qwen",
    }),
    params: { languages: ["en-US"] },
  },
  {
    adapterId: "kimi",
    binId: "binny-document-kimi",
    identityId: "binny-document-kimi-identity",
    runtimeService: "runtime-document-kimi",
    sourceAdapterId: "kimi",
    config: (origin) => ({
      sources: [
        {
          id: "e2e-changelog",
          kind: "changelog",
          region: "international",
          language: "en",
          url: origin + "/kimi/changelog.md",
          title: "Kimi Platform Changelog",
        },
        {
          id: "e2e-research",
          kind: "research",
          region: "international",
          language: "en",
          url: origin + "/kimi/blog",
          title: "Kimi Research Blog",
        },
      ],
    }),
    params: { sourceIds: ["e2e-changelog", "e2e-research"] },
  },
  {
    adapterId: "minimax",
    binId: "binny-document-minimax",
    identityId: "binny-document-minimax-identity",
    runtimeService: "runtime-document-minimax",
    sourceAdapterId: "minimax",
    config: (origin) => ({
      sources: [
        {
          id: "e2e-international",
          region: "international",
          language: "en",
          modelsReleaseUrl: origin + "/minimax/models.md",
          allowedArticleHosts: ["rss-e2e-source"],
        },
      ],
    }),
    params: { sourceIds: ["e2e-international"] },
  },
];

function expectedStates(
  adapterId: DocumentAdapterId,
): readonly ExpectedState[] {
  switch (adapterId) {
    case "deepseek":
      return [
        {
          namespace: "deepseek:e2e-en",
          key: "changelog:updates",
          title: () => "DeepSeek Updates",
          titleChanges: false,
          publishedAt: () => null,
          modifiedAt: () => null,
          bodyMarker: "Cumulative updates document",
          verifyExtensions(extensions, version) {
            assert.equal(extensions.region, "unpartitioned");
            assert.equal(extensions.language, "en");
            assert.equal(extensions.kind, "changelog");
            assert.equal(
              extensions.latestUpdateDate,
              version === 1 ? "2026-11-08" : "2026-11-09",
            );
            assert.equal(extensions.latestUpdateDatePrecision, "day");
          },
        },
        {
          namespace: "deepseek:e2e-en",
          key: "news:news261108",
          title: (version) => "DeepSeek Research Update " + String(version),
          titleChanges: true,
          publishedAt: (version) => ({
            precision: "instant",
            value:
              version === 1
                ? "2026-11-08T12:30:00+08:00"
                : "2026-11-08T13:30:00+08:00",
          }),
          modifiedAt: () => null,
          bodyMarker: "DeepSeek article body",
          verifyExtensions(extensions) {
            assert.equal(extensions.region, "unpartitioned");
            assert.equal(extensions.language, "en");
            assert.equal(extensions.kind, "news");
          },
        },
      ];
    case "qwen":
      return [
        {
          namespace: "qwen:en-US",
          key: "research-note",
          title: (version) => "Qwen Research Note " + String(version),
          titleChanges: true,
          publishedAt: () => ({
            precision: "instant",
            value: "2026-11-08T12:30:00+08:00",
          }),
          modifiedAt: () => null,
          bodyMarker: "Qwen article body",
          verifyExtensions(extensions) {
            assert.equal(extensions.language, "en-US");
            assert.equal(extensions.region, "global");
            assert.equal(
              extensions.canonicalUrl,
              "http://rss-e2e-source:8081/qwen/research-note",
            );
            assert.equal(extensions.qwenArticleId, "qwen-research-note-1");
            assert.equal(extensions.author, "Qwen Research");
            assert.deepEqual(extensions.tags, ["research", "models"]);
          },
        },
      ];
    case "kimi":
      return [
        {
          namespace: "kimi:international",
          key: "changelog:e2e-changelog",
          title: () => "Kimi Platform Changelog",
          titleChanges: false,
          publishedAt: () => null,
          modifiedAt: () => null,
          bodyMarker: "Cumulative changelog body",
          verifyExtensions(extensions, version) {
            assert.equal(extensions.kind, "changelog");
            assert.equal(extensions.region, "international");
            assert.equal(extensions.language, "en");
            assert.equal(
              extensions.latestChangelogDate,
              version === 1 ? "2026-11-08" : "2026-11-09",
            );
            assert.equal(extensions.latestChangelogDatePrecision, "day");
            assert.deepEqual(extensions.observedChangelogDates, [
              version === 1 ? "2026-11-08" : "2026-11-09",
            ]);
          },
        },
        {
          namespace: "kimi:international:en",
          key: "research:research-update",
          title: (version) => "Kimi Research " + String(version),
          titleChanges: true,
          publishedAt: () => ({
            precision: "instant",
            value: "2026-11-08T12:30:00+08:00",
          }),
          modifiedAt: (version) => ({
            precision: "instant",
            value:
              version === 1
                ? "2026-11-08T09:15:00-04:00"
                : "2026-11-09T09:15:00-04:00",
          }),
          bodyMarker: "Kimi research article body",
          verifyExtensions(extensions) {
            assert.equal(extensions.kind, "research");
            assert.equal(extensions.region, "international");
            assert.equal(extensions.language, "en");
            assert.equal(extensions.slug, "research-update");
            assert.equal(
              extensions.canonicalUrl,
              "http://rss-e2e-source:8081/kimi/blog/research-update",
            );
          },
        },
      ];
    case "minimax":
      return [
        {
          namespace: "minimax:international",
          key: "release-notes:models",
          title: () => "MiniMax Model Release Notes",
          titleChanges: false,
          publishedAt: () => null,
          modifiedAt: () => null,
          bodyMarker: "Models release document",
          verifyExtensions(extensions, version) {
            assert.equal(extensions.kind, "release-notes");
            assert.equal(extensions.region, "international");
            assert.equal(extensions.language, "en");
            assert.equal(
              extensions.latestReleaseEntryDate,
              version === 1 ? "2026-11-08" : "2026-11-09",
            );
            assert.equal(extensions.latestReleaseEntryDatePrecision, "day");
            assert.deepEqual(extensions.observedReleaseEntryDates, [
              version === 1 ? "2026-11-08" : "2026-11-09",
            ]);
          },
        },
        {
          namespace: "minimax:international",
          key: "article:minimax/news/minimax-m4",
          title: (version) => "MiniMax Model Update " + String(version),
          titleChanges: true,
          publishedAt: () => ({
            precision: "instant",
            value: "2026-11-07T12:30:00+08:00",
          }),
          modifiedAt: (version) => ({
            precision: "instant",
            value:
              version === 1
                ? "2026-11-08T09:15:00-04:00"
                : "2026-11-09T09:15:00-04:00",
          }),
          bodyMarker: "MiniMax article body",
          verifyExtensions(extensions, version) {
            assert.equal(extensions.kind, "article");
            assert.equal(extensions.region, "international");
            assert.equal(extensions.language, "en");
            assert.equal(
              extensions.modelsReleaseDate,
              version === 1 ? "2026-11-08" : "2026-11-09",
            );
            assert.equal(extensions.modelsReleaseDatePrecision, "day");
            assert.equal(extensions.articleContentDate, "2026-12-01");
            assert.equal(extensions.articleContentDatePrecision, "day");
          },
        },
      ];
  }
  assert.fail("Unsupported document adapter: " + String(adapterId) + ".");
}

function data<T>(result: ProcessResult, variant: string): T {
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const wire = JSON.parse(result.stdout) as {
    readonly kind: string;
    readonly variant: string;
    readonly data: T;
  };
  assert.equal(wire.kind, "data");
  assert.equal(wire.variant, variant);
  return wire.data;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function runtimeManifest(
  compose: Compose,
  service: string,
): Promise<RuntimeManifest> {
  const result = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "--input-type=module",
    "-e",
    'const response=await fetch("http://127.0.0.1:8080/manifest"); if(!response.ok)process.exit(1); const payload=await response.json(); if(!payload.sourceAdapter)process.exit(1); console.log(JSON.stringify(payload.sourceAdapter));',
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as RuntimeManifest;
}

function committedItems(run: DocumentRun): readonly {
  readonly itemId: string;
  readonly revisionId: string;
}[] {
  return run.result?.commits?.flatMap(({ items }) => items) ?? [];
}

async function runAction(
  binId: string,
  action: "collect" | "sync",
  params: Readonly<Record<string, unknown>>,
  cli: Cli,
): Promise<DocumentRun> {
  const triggered = data<{ readonly runId: string; readonly status: string }>(
    await cli([
      "run",
      "trigger",
      binId,
      action,
      "--params",
      JSON.stringify(params),
    ]),
    "triggered",
  );
  assert.equal(triggered.status, "queued");
  const deadline = Date.now() + 60_000;
  let latest: DocumentRun | undefined;
  while (Date.now() < deadline) {
    latest = data<DocumentRun>(
      await cli(["run", "get", binId, triggered.runId]),
      "found",
    );
    if (latest.status === "completed" || latest.status === "failed") break;
    await wait(100);
  }
  assert.ok(latest, "Timed out waiting for " + action + " on " + binId + ".");
  assert.equal(
    latest.status,
    "completed",
    action +
      " failed for " +
      binId +
      ": " +
      JSON.stringify(latest.result?.error),
  );
  return latest;
}

async function committedItem(
  run: DocumentRun,
  expected: ExpectedState,
  cli: Cli,
): Promise<{ readonly itemId: string; readonly revisionId: string }> {
  for (const candidate of committedItems(run)) {
    const item = await readItem(candidate.itemId, cli);
    if (
      item.sourceKey.namespace === expected.namespace &&
      item.sourceKey.key === expected.key
    ) {
      return candidate;
    }
  }
  assert.fail(
    "Run " +
      run.runId +
      " did not commit " +
      expected.namespace +
      "/" +
      expected.key +
      ".",
  );
}

async function readItem(itemId: string, cli: Cli): Promise<ArchiveItemRead> {
  return data<ArchiveItemRead>(await cli(["archive", "item", itemId]), "found");
}

async function readRevision(
  revisionId: string,
  cli: Cli,
): Promise<ArchiveRevisionRead> {
  return data<ArchiveRevisionRead>(
    await cli(["archive", "revision", revisionId]),
    "found",
  );
}

function assertState(
  state: ArchiveState,
  expected: ExpectedState,
  version: 1 | 2,
): void {
  assert.equal(state.title, expected.title(version));
  assert.deepEqual(state.sourcePublishedAt, expected.publishedAt(version));
  assert.deepEqual(state.sourceModifiedAt, expected.modifiedAt(version));
  for (const publicFact of publicFactKeys) {
    assert.equal(Object.hasOwn(state.extensions, publicFact), false);
  }
  expected.verifyExtensions(state.extensions, version);
  assert.match(
    state.body?.markdown ?? state.body?.text ?? "",
    new RegExp(expected.bodyMarker, "u"),
  );
  assert.match(
    state.body?.markdown ?? state.body?.text ?? "",
    new RegExp("version " + String(version), "u"),
  );
}

function assertManifest(
  adapter: DocumentAdapterDefinition,
  manifest: RuntimeManifest,
): void {
  assert.equal(manifest.id, adapter.adapterId);
  assert.ok(
    typeof manifest.version === "string" && manifest.version.length > 0,
  );
  const schema = manifest.extensionsSchema;
  assert.ok(schema);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties);
  for (const [key, field] of Object.entries(schema.properties)) {
    assert.equal(publicFactKeys.has(key), false);
    assert.ok(
      typeof field.description === "string" && field.description.length > 0,
      adapter.adapterId + " extension " + key + " needs a runtime description.",
    );
  }
}

/** Runs the formal CLI/runtime/archive journey for document-source adapters. */
export async function runDocumentAdaptersJourney(options: {
  readonly baseUrl: string;
  readonly source: DocumentSourceControl;
  readonly cli: Cli;
  readonly compose: Compose;
  readonly fetchRegisteredBin: (
    baseUrl: string,
    binId: string,
  ) => Promise<RegisteredBin>;
  readonly waitForRuntime: (baseUrl: string, binId: string) => Promise<void>;
  readonly waitForRuntimeHealth: (service: string) => Promise<void>;
}): Promise<void> {
  for (const adapter of adapters) {
    await options.waitForRuntimeHealth(adapter.runtimeService);
    const registered = await options.fetchRegisteredBin(
      options.baseUrl,
      adapter.binId,
    );
    const manifest = await runtimeManifest(
      options.compose,
      adapter.runtimeService,
    );
    assertManifest(adapter, manifest);
    assert.equal(registered.id, adapter.binId);
    assert.equal(registered.sourceAdapterId, adapter.sourceAdapterId);
    assert.equal(registered.sourceAdapterVersion, manifest.version);

    const configured = data<{ readonly id: string }>(
      await options.cli([
        "bin",
        "update",
        adapter.binId,
        "--identity",
        adapter.identityId,
        "--config",
        JSON.stringify(adapter.config(options.source.baseUrl)),
      ]),
      "updated",
    );
    assert.equal(configured.id, adapter.binId);
    await options.waitForRuntime(options.baseUrl, adapter.binId);
  }

  for (const adapter of adapters) {
    const expected = expectedStates(adapter.adapterId);
    await options.source.setDocumentVersion(1);

    const baseline = await runAction(
      adapter.binId,
      "sync",
      adapter.params,
      options.cli,
    );
    assert.equal(committedItems(baseline).length, 0);

    const initial = await runAction(
      adapter.binId,
      "collect",
      adapter.params,
      options.cli,
    );
    assert.equal(committedItems(initial).length, expected.length);
    const itemIds = new Map<string, string>();
    const firstRevisionIds = new Map<string, string>();
    for (const source of expected) {
      const committed = await committedItem(initial, source, options.cli);
      const compoundKey = source.namespace + "\n" + source.key;
      itemIds.set(compoundKey, committed.itemId);
      firstRevisionIds.set(compoundKey, committed.revisionId);
      const item = await readItem(committed.itemId, options.cli);
      assert.equal(item.sourceKey.namespace, source.namespace);
      assert.equal(item.sourceKey.key, source.key);
      const view = item.views.find(
        (candidate) => candidate.binId === adapter.binId,
      );
      assert.ok(view);
      assertState(view.state, source, 1);
    }

    const unchanged = await runAction(
      adapter.binId,
      "sync",
      adapter.params,
      options.cli,
    );
    assert.equal(committedItems(unchanged).length, 0);

    await options.source.setDocumentVersion(2);
    const updated = await runAction(
      adapter.binId,
      "sync",
      adapter.params,
      options.cli,
    );
    assert.equal(committedItems(updated).length, expected.length);
    const updatedRevisionIds = new Map<string, string>();
    for (const source of expected) {
      const compoundKey = source.namespace + "\n" + source.key;
      const committed = await committedItem(updated, source, options.cli);
      assert.equal(committed.itemId, itemIds.get(compoundKey));
      assert.notEqual(committed.revisionId, firstRevisionIds.get(compoundKey));
      updatedRevisionIds.set(compoundKey, committed.revisionId);
      const item = await readItem(committed.itemId, options.cli);
      const view = item.views.find(
        (candidate) => candidate.binId === adapter.binId,
      );
      assert.ok(view);
      assert.equal(view.revisionId, committed.revisionId);
      assertState(view.state, source, 2);
      assert.ok(
        item.revisions.some(
          ({ revisionId }) => revisionId === firstRevisionIds.get(compoundKey),
        ),
      );
      assert.ok(
        item.revisions.some(
          ({ revisionId }) => revisionId === committed.revisionId,
        ),
      );
    }

    const repeatedSync = await runAction(
      adapter.binId,
      "sync",
      adapter.params,
      options.cli,
    );
    assert.equal(committedItems(repeatedSync).length, 0);
    const repeatedCollect = await runAction(
      adapter.binId,
      "collect",
      adapter.params,
      options.cli,
    );
    assert.equal(committedItems(repeatedCollect).length, expected.length);

    for (const source of expected) {
      const compoundKey = source.namespace + "\n" + source.key;
      const itemId = itemIds.get(compoundKey);
      const firstRevisionId = firstRevisionIds.get(compoundKey);
      const updatedRevisionId = updatedRevisionIds.get(compoundKey);
      assert.ok(itemId);
      assert.ok(firstRevisionId);
      assert.ok(updatedRevisionId);
      const reused = await committedItem(repeatedCollect, source, options.cli);
      assert.equal(reused.itemId, itemId);
      assert.equal(reused.revisionId, updatedRevisionId);

      const item = await readItem(itemId, options.cli);
      const view = item.views.find(
        (candidate) => candidate.binId === adapter.binId,
      );
      assert.ok(view);
      assert.equal(view.revisionId, updatedRevisionId);
      assertState(view.state, source, 2);

      const firstRevision = await readRevision(firstRevisionId, options.cli);
      const updatedRevision = await readRevision(
        updatedRevisionId,
        options.cli,
      );
      assert.equal(firstRevision.itemId, itemId);
      assert.equal(updatedRevision.itemId, itemId);
      assertState(firstRevision.state, source, 1);
      assertState(updatedRevision.state, source, 2);

      const diff = data<{
        readonly itemId: string;
        readonly firstRevisionId: string;
        readonly secondRevisionId: string;
        readonly hasChanges: boolean;
        readonly fields: {
          readonly title: { readonly status: string };
          readonly body: { readonly status: string };
        };
      }>(
        await options.cli([
          "archive",
          "diff",
          firstRevisionId,
          updatedRevisionId,
        ]),
        "found",
      );
      assert.equal(diff.itemId, itemId);
      assert.equal(diff.firstRevisionId, firstRevisionId);
      assert.equal(diff.secondRevisionId, updatedRevisionId);
      assert.equal(diff.hasChanges, true);
      assert.equal(diff.fields.body.status, "changed");
      assert.equal(
        diff.fields.title.status,
        source.titleChanges ? "changed" : "unchanged",
      );

      const timeline = data<{
        readonly events: readonly { readonly runId?: string }[];
      }>(
        await options.cli([
          "archive",
          "timeline",
          itemId,
          "--bin",
          adapter.binId,
          "--limit",
          "100",
        ]),
        "found",
      );
      assert.ok(timeline.events.some(({ runId }) => runId === initial.runId));
      assert.ok(timeline.events.some(({ runId }) => runId === updated.runId));
    }
  }

  const requestPaths = new Set(
    (await options.source.requests()).map(({ path }) => path),
  );
  for (const path of [
    "/deepseek/updates.md",
    "/deepseek/news/news261108.md",
    "/qwen/api/v2/article/retrieval",
    "/kimi/changelog.md",
    "/kimi/blog",
    "/kimi/blog/research-update",
    "/minimax/models.md",
    "/minimax/news/minimax-m4",
  ]) {
    assert.ok(requestPaths.has(path), "Fixture did not serve " + path + ".");
  }
}
