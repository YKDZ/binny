import assert from "node:assert/strict";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type Cli = (args: readonly string[]) => Promise<ProcessResult>;
type Compose = (args: readonly string[]) => Promise<ProcessResult>;
type ArticleSourceControl = {
  readonly baseUrl: string;
  readonly requests: () => Promise<readonly { readonly path: string }[]>;
  readonly setArticleVersion: (version: 1 | 2) => Promise<void>;
};

type ArticleAdapterId =
  | "openai"
  | "anthropic"
  | "google"
  | "huggingface"
  | "mistral";

type ArticleAdapterDefinition = {
  readonly adapterId: ArticleAdapterId;
  readonly binId: string;
  readonly identityId: string;
  readonly runtimeService: string;
  readonly sourceAdapterId: string;
  readonly config: (runtimeOrigin: string) => unknown;
  readonly params: Readonly<Record<string, unknown>>;
};

type RegisteredBin = {
  readonly id: string;
  readonly sourceAdapterId: string;
  readonly sourceAdapterVersion: string;
};

type ArchiveSourceKey = {
  readonly namespace: string;
  readonly key: string;
};

type RunCommit = {
  readonly items: readonly {
    readonly itemId: string;
    readonly revisionId: string;
  }[];
};

type ArticleRun = {
  readonly runId: string;
  readonly binId: string;
  readonly action: string;
  readonly status: string;
  readonly result?: {
    readonly commits?: readonly RunCommit[];
    readonly error?: { readonly code?: string; readonly message?: string };
  };
};

type ArchiveItemRead = {
  readonly itemId: string;
  readonly sourceKey: ArchiveSourceKey;
  readonly views: readonly {
    readonly binId: string;
    readonly revisionId: string;
    readonly state: {
      readonly title: string | null;
      readonly sourcePublishedAt: unknown;
      readonly sourceModifiedAt: unknown;
      readonly extensions: Record<string, unknown>;
      readonly body?: { readonly markdown?: string; readonly text?: string };
    };
  }[];
  readonly revisions: readonly { readonly revisionId: string }[];
};

type ArchiveRevisionRead = {
  readonly revisionId: string;
  readonly itemId: string;
  readonly state: {
    readonly title: string | null;
    readonly sourcePublishedAt: unknown;
    readonly sourceModifiedAt: unknown;
    readonly extensions: Record<string, unknown>;
    readonly body?: { readonly markdown?: string; readonly text?: string };
  };
};

type ArticleExpectedState = {
  readonly namespace: string;
  readonly title: (version: 1 | 2) => string;
  readonly sourcePublishedAt: (version: 1 | 2) => unknown;
  readonly sourceModifiedAt: (version: 1 | 2) => unknown;
  readonly verifyExtensions: (
    extensions: Record<string, unknown>,
    version: 1 | 2,
  ) => void;
};

type ArticleRuntimeManifest = {
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

const adapters: readonly ArticleAdapterDefinition[] = [
  {
    adapterId: "openai",
    binId: "binny-article-openai",
    identityId: "binny-article-openai-identity",
    runtimeService: "runtime-article-openai",
    sourceAdapterId: "openai",
    config: (runtimeOrigin) => ({
      news: { enabled: true, rssUrl: `${runtimeOrigin}/openai/news/rss.xml` },
      developersBlog: {
        enabled: true,
        listUrl: `${runtimeOrigin}/openai/blog`,
        preferMarkdown: true,
      },
    }),
    params: { scopes: ["news", "developers-blog"] },
  },
  {
    adapterId: "anthropic",
    binId: "binny-article-anthropic",
    identityId: "binny-article-anthropic-identity",
    runtimeService: "runtime-article-anthropic",
    sourceAdapterId: "anthropic",
    config: (runtimeOrigin) => ({
      sections: [{ id: "news", url: `${runtimeOrigin}/anthropic/news` }],
    }),
    params: { sectionIds: ["news"] },
  },
  {
    adapterId: "google",
    binId: "binny-article-google",
    identityId: "binny-article-google-identity",
    runtimeService: "runtime-article-google",
    sourceAdapterId: "google",
    config: (runtimeOrigin) => ({
      sources: [
        {
          id: "google-ai",
          url: `${runtimeOrigin}/google/ai/feed.xml`,
          title: "Google AI Blog",
        },
      ],
    }),
    params: { sourceIds: ["google-ai"] },
  },
  {
    adapterId: "huggingface",
    binId: "binny-article-huggingface",
    identityId: "binny-article-huggingface-identity",
    runtimeService: "runtime-article-huggingface",
    sourceAdapterId: "huggingface",
    config: (runtimeOrigin) => ({
      feedUrl: `${runtimeOrigin}/huggingface/blog/feed.xml`,
      defaultCollectMaxItems: 5,
    }),
    params: { maxItems: 5 },
  },
  {
    adapterId: "mistral",
    binId: "binny-article-mistral",
    identityId: "binny-article-mistral-identity",
    runtimeService: "runtime-article-mistral",
    sourceAdapterId: "mistral",
    config: (runtimeOrigin) => ({
      rssUrl: `${runtimeOrigin}/mistral/news/rss`,
    }),
    params: { maxItems: 5 },
  },
];

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
): Promise<ArticleRuntimeManifest> {
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
  return JSON.parse(result.stdout) as ArticleRuntimeManifest;
}

async function waitForRegistration(
  baseUrl: string,
  binId: string,
  fetchRegisteredBin: (
    baseUrl: string,
    binId: string,
  ) => Promise<RegisteredBin>,
): Promise<RegisteredBin> {
  return fetchRegisteredBin(baseUrl, binId);
}

async function runAction(
  binId: string,
  action: "collect" | "sync",
  params: Readonly<Record<string, unknown>>,
  cli: Cli,
): Promise<ArticleRun> {
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
  let latest: ArticleRun | undefined;
  while (Date.now() < deadline) {
    latest = data<ArticleRun>(
      await cli(["run", "get", binId, triggered.runId]),
      "found",
    );
    if (latest.status === "completed" || latest.status === "failed") break;
    await wait(100);
  }
  assert.ok(latest, `Timed out waiting for ${action} on ${binId}.`);
  assert.equal(
    latest.status,
    "completed",
    `${action} failed for ${binId}: ${JSON.stringify(latest.result?.error)}`,
  );
  return latest;
}

function committedItems(run: ArticleRun): readonly {
  readonly itemId: string;
  readonly revisionId: string;
}[] {
  return run.result?.commits?.flatMap(({ items }) => items) ?? [];
}

async function committedItem(
  run: ArticleRun,
  namespace: string,
  cli: Cli,
): Promise<{ readonly itemId: string; readonly revisionId: string }> {
  for (const candidate of committedItems(run)) {
    const item = await readItem(candidate.itemId, cli);
    if (item.sourceKey.namespace === namespace) return candidate;
  }
  assert.fail(`Run ${run.runId} did not commit ${namespace}.`);
}

async function readItem(itemId: string, cli: Cli): Promise<ArchiveItemRead> {
  return data<ArchiveItemRead>(await cli(["archive", "item", itemId]), "found");
}

function currentView(
  item: ArchiveItemRead,
  binId: string,
): ArchiveItemRead["views"][number] {
  const view = item.views.find((candidate) => candidate.binId === binId);
  assert.ok(view, `Archive item ${item.itemId} has no view for ${binId}.`);
  return view;
}

function expectedStates(
  adapterId: ArticleAdapterId,
): readonly ArticleExpectedState[] {
  switch (adapterId) {
    case "openai":
      return [
        {
          namespace: "openai:news",
          title: (version) => `OpenAI Research Update ${version}`,
          sourcePublishedAt: () => ({
            precision: "instant",
            value: "2026-11-03T20:15:00-04:00",
          }),
          sourceModifiedAt: (version) => ({
            precision: "instant",
            value: `2026-11-0${version === 1 ? "4" : "5"}T09:30:00-04:00`,
          }),
          verifyExtensions(extensions) {
            assert.equal(extensions.section, "news");
            assert.deepEqual(extensions.categories, ["Research"]);
            assert.deepEqual(extensions.authors, ["OpenAI Research Team"]);
          },
        },
        {
          namespace: "openai:developers-blog",
          title: (version) => `OpenAI Runtime Guide ${version}`,
          sourcePublishedAt: () => ({
            precision: "instant",
            value: "2026-11-04T08:00:00+08:00",
          }),
          sourceModifiedAt: () => null,
          verifyExtensions(extensions) {
            assert.equal(extensions.section, "developers-blog");
            assert.deepEqual(extensions.categories, ["Tooling"]);
            assert.deepEqual(extensions.authors, [
              "OpenAI Developer Relations",
            ]);
          },
        },
      ];
    case "anthropic":
      return [
        {
          namespace: "anthropic:article",
          title: (version) => `Anthropic Safety Release ${version}`,
          sourcePublishedAt: () => ({
            precision: "instant",
            value: "2026-10-10T09:15:00-04:00",
          }),
          sourceModifiedAt: (version) => ({
            precision: "instant",
            value: `2026-10-${version === 1 ? "12" : "13"}T10:45:00-04:00`,
          }),
          verifyExtensions(extensions) {
            assert.equal(
              extensions.canonicalPath,
              "/anthropic/news/safety-release",
            );
            assert.deepEqual(extensions.sections, ["news"]);
          },
        },
      ];
    case "google":
      return [
        {
          namespace: "google:google-ai",
          title: (version) => `Google AI Research ${version}`,
          sourcePublishedAt: () => ({
            precision: "instant",
            value: "2026-11-03T12:00:00+05:30",
          }),
          sourceModifiedAt: (version) => ({
            precision: "instant",
            value: `2026-11-0${version === 1 ? "4" : "5"}T10:30:00-04:00`,
          }),
          verifyExtensions(extensions) {
            assert.equal(extensions.sourceId, "google-ai");
            assert.deepEqual(extensions.authors, ["Google AI Team"]);
            assert.deepEqual(extensions.categories, ["Research"]);
          },
        },
      ];
    case "huggingface":
      return [
        {
          namespace: "huggingface:blog",
          title: (version) => `Hugging Face Engineering Note ${version}`,
          sourcePublishedAt: (version) => ({
            precision: "instant",
            value: `2024-05-${version === 1 ? "10" : "11"}T16:00:00+02:00`,
          }),
          sourceModifiedAt: () => null,
          verifyExtensions(extensions) {
            assert.ok(Array.isArray(extensions.authors));
            assert.deepEqual(extensions.categories, ["engineering"]);
          },
        },
      ];
    case "mistral":
      return [
        {
          namespace: "mistral:news",
          title: (version) => `Mistral AI Update ${version}`,
          sourcePublishedAt: () => ({
            precision: "instant",
            value: "2026-11-02T10:00:00+02:30",
          }),
          sourceModifiedAt: (version) => ({
            precision: "instant",
            value: `2026-11-0${version === 1 ? "3" : "4"}T08:30:00+02:00`,
          }),
          verifyExtensions(extensions, version) {
            assert.equal(
              extensions.rssDescription,
              `Mistral RSS summary version ${version}.`,
            );
            assert.ok(Array.isArray(extensions.authors));
            assert.ok(
              (extensions.categories as string[]).includes("Engineering"),
            );
          },
        },
      ];
  }
  assert.fail(`Unsupported article adapter: ${String(adapterId)}.`);
}

function assertManifest(
  adapter: ArticleAdapterDefinition,
  manifest: ArticleRuntimeManifest,
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
      `${adapter.adapterId} extension ${key} needs a runtime description.`,
    );
  }
}

function assertState(
  state: ArchiveItemRead["views"][number]["state"],
  expected: ArticleExpectedState,
  version: 1 | 2,
): void {
  assert.equal(state.title, expected.title(version));
  assert.deepEqual(
    state.sourcePublishedAt,
    expected.sourcePublishedAt(version),
  );
  assert.deepEqual(state.sourceModifiedAt, expected.sourceModifiedAt(version));
  assert.equal(Object.hasOwn(state.extensions, "title"), false);
  assert.equal(Object.hasOwn(state.extensions, "sourcePublishedAt"), false);
  assert.equal(Object.hasOwn(state.extensions, "sourceModifiedAt"), false);
  expected.verifyExtensions(state.extensions, version);
  assert.match(
    state.body?.markdown ?? state.body?.text ?? "",
    new RegExp(`version ${version}`, "u"),
  );
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

/** Runs the formal CLI/runtime/archive journey for all article-source adapters. */
export async function runArticleAdaptersJourney(options: {
  readonly baseUrl: string;
  readonly articleSource: ArticleSourceControl;
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
    const registered = await waitForRegistration(
      options.baseUrl,
      adapter.binId,
      options.fetchRegisteredBin,
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
        JSON.stringify(adapter.config(options.articleSource.baseUrl)),
      ]),
      "updated",
    );
    assert.equal(configured.id, adapter.binId);
    await options.waitForRuntime(options.baseUrl, adapter.binId);
  }

  for (const adapter of adapters) {
    const expected = expectedStates(adapter.adapterId);
    await options.articleSource.setArticleVersion(1);
    const initial = await runAction(
      adapter.binId,
      "collect",
      adapter.params,
      options.cli,
    );
    const initialItems = committedItems(initial);
    assert.equal(initialItems.length, expected.length);
    const itemIds = new Map<string, string>();
    const initialRevisionIds = new Map<string, string>();
    for (const source of expected) {
      const committed = await committedItem(
        initial,
        source.namespace,
        options.cli,
      );
      itemIds.set(source.namespace, committed.itemId);
      initialRevisionIds.set(source.namespace, committed.revisionId);
      const item = await readItem(committed.itemId, options.cli);
      assert.equal(item.sourceKey.namespace, source.namespace);
      assertState(currentView(item, adapter.binId).state, source, 1);
    }

    const unchangedSync = await runAction(
      adapter.binId,
      "sync",
      adapter.params,
      options.cli,
    );
    assert.equal(committedItems(unchangedSync).length, 0);

    await options.articleSource.setArticleVersion(2);
    const updated = await runAction(
      adapter.binId,
      "sync",
      adapter.params,
      options.cli,
    );
    const updatedItems = committedItems(updated);
    assert.equal(updatedItems.length, expected.length);
    const updatedRevisionIds = new Map<string, string>();
    for (const source of expected) {
      const committed = await committedItem(
        updated,
        source.namespace,
        options.cli,
      );
      assert.equal(committed.itemId, itemIds.get(source.namespace));
      assert.notEqual(
        committed.revisionId,
        initialRevisionIds.get(source.namespace),
      );
      updatedRevisionIds.set(source.namespace, committed.revisionId);
      const item = await readItem(committed.itemId, options.cli);
      const view = currentView(item, adapter.binId);
      assert.equal(view.revisionId, committed.revisionId);
      assertState(view.state, source, 2);
      assert.ok(
        item.revisions.some(
          ({ revisionId }) =>
            revisionId === initialRevisionIds.get(source.namespace),
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
      const itemId = itemIds.get(source.namespace);
      const initialRevisionId = initialRevisionIds.get(source.namespace);
      const updatedRevisionId = updatedRevisionIds.get(source.namespace);
      assert.ok(itemId);
      assert.ok(initialRevisionId);
      assert.ok(updatedRevisionId);
      const repeated = await committedItem(
        repeatedCollect,
        source.namespace,
        options.cli,
      );
      assert.equal(repeated.itemId, itemId);
      assert.equal(repeated.revisionId, updatedRevisionId);

      const item = await readItem(itemId, options.cli);
      const current = currentView(item, adapter.binId);
      assert.equal(current.revisionId, updatedRevisionId);
      assertState(current.state, source, 2);

      const initialRevision = await readRevision(
        initialRevisionId,
        options.cli,
      );
      const updatedRevision = await readRevision(
        updatedRevisionId,
        options.cli,
      );
      assert.equal(initialRevision.itemId, itemId);
      assert.equal(updatedRevision.itemId, itemId);
      assertState(
        initialRevision.state as ArchiveItemRead["views"][number]["state"],
        source,
        1,
      );
      assertState(
        updatedRevision.state as ArchiveItemRead["views"][number]["state"],
        source,
        2,
      );

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
          initialRevisionId,
          updatedRevisionId,
        ]),
        "found",
      );
      assert.equal(diff.itemId, itemId);
      assert.equal(diff.firstRevisionId, initialRevisionId);
      assert.equal(diff.secondRevisionId, updatedRevisionId);
      assert.equal(diff.hasChanges, true);
      assert.equal(diff.fields.title.status, "changed");
      assert.equal(diff.fields.body.status, "changed");

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

  const requests = (await options.articleSource.requests()).map(
    ({ path }) => path,
  );
  for (const requiredPath of [
    "/openai/news/rss.xml",
    "/openai/news/article",
    "/openai/blog",
    "/blog/runtime-guide.md",
    "/anthropic/news",
    "/anthropic/news/safety-release",
    "/google/ai/feed.xml",
    "/google/ai/article",
    "/huggingface/blog/feed.xml",
    "/huggingface/blog/engineering-note",
    "/mistral/news/rss",
    "/mistral/news/ai-update",
  ]) {
    assert.ok(
      requests.includes(requiredPath),
      `No runtime request reached ${requiredPath}.`,
    );
  }
  process.stdout.write(
    "Five article-source adapters passed real lightweight runtime, CLI collect/sync, public current/history/diff reads, and duplicate revision reuse.\n",
  );
}
