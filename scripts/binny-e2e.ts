import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApiClient } from "@binny/api/client";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ArchiveClient = ReturnType<typeof createApiClient>;
type ArchiveSubmission = Parameters<
  ArchiveClient["archives"]["$post"]
>[0]["json"];
type ArchiveJourney = {
  readonly itemId: string;
  readonly revisionId: string;
  readonly replayRequest: ArchiveSubmission;
  readonly replayCommitId: string;
  readonly expectedObservationCount: number;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.yaml");
const projectName = "binny02-" + process.pid.toString(10);
const imageName = projectName + ":local";
let composeOverrideFile = "";
let composePort = 0;

function composePrefix(): readonly string[] {
  return [
    "compose",
    "--project-name",
    projectName,
    "--file",
    composeFile,
    "--file",
    composeOverrideFile,
  ];
}

function composeEnvironment(): Readonly<Record<string, string>> {
  return {
    BINNY_PORT: String(composePort),
    BINNY_IMAGE: imageName,
  };
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function compose(
  args: readonly string[],
  port: number,
): Promise<ProcessResult> {
  const result = await run("docker", [...composePrefix(), ...args], {
    env: { ...composeEnvironment(), BINNY_PORT: String(port) },
  });
  if (result.code !== 0) {
    throw new Error(
      "Compose 命令失败：" +
        args.join(" ") +
        "\n" +
        result.stdout +
        result.stderr,
    );
  }
  return result;
}

async function reservePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const address = listener.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    listener.close((error) =>
      error === undefined ? resolveClose() : reject(error),
    );
  });
  return port;
}

async function cli(
  _baseUrl: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return await run(
    "docker",
    [
      ...composePrefix(),
      "exec",
      "--no-TTY",
      "server",
      "node",
      "packages/binny/dist/cli.js",
      ...args,
    ],
    { env: composeEnvironment() },
  );
}

function cliData<T>(result: ProcessResult, variant: string): T {
  assert.equal(result.code, 0, result.stderr);
  const wire = JSON.parse(result.stdout) as {
    readonly kind: string;
    readonly variant: string;
    readonly data: T;
  };
  assert.equal(wire.kind, "data");
  assert.equal(wire.variant, variant);
  return wire.data;
}

function cliFailure<T extends { readonly code: string }>(
  result: ProcessResult,
  code: string,
): T {
  assert.equal(result.code, 1, result.stdout);
  const wire = JSON.parse(result.stderr) as {
    readonly kind: string;
    readonly variant: string;
    readonly data: T;
  };
  assert.equal(wire.kind, "failure");
  assert.equal(wire.variant, "apiError");
  assert.equal(wire.data.code, code);
  return wire.data;
}

async function submitArchive(
  client: ArchiveClient,
  request: ArchiveSubmission,
) {
  const response = await client.archives.$post({ json: request });
  if (response.status !== 201) {
    throw new Error("归档提交失败：" + (await response.text()));
  }
  return await response.json();
}

async function readArchiveItem(client: ArchiveClient, itemId: string) {
  const response = await client.archives.items[":itemId"].$get({
    param: { itemId },
  });
  if (response.status !== 200) {
    throw new Error("读取归档条目失败：" + (await response.text()));
  }
  return await response.json();
}

async function waitForApiAndDatabase(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastFailure = "服务尚未就绪。";
  while (Date.now() < deadline) {
    const result = await cli(baseUrl, ["bin", "list"]);
    if (result.code === 0) return;
    lastFailure = result.stderr;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("等待 HTTP API 和 PostgreSQL 就绪超时：\n" + lastFailure);
}

async function validateApiInput(_baseUrl: string): Promise<void> {
  const probe = [
    'fetch("http://127.0.0.1:3000/bins", {',
    'method: "POST",',
    'headers: { "content-type": "application/json" },',
    "body: JSON.stringify({ id: 7 }),",
    "}).then(async (response) => {",
    "process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));",
    "}).catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("");
  const result = await run(
    "docker",
    [...composePrefix(), "exec", "--no-TTY", "server", "node", "-e", probe],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout) as {
    readonly status: number;
    readonly body: {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly path: readonly (string | number)[];
      };
    };
  };
  assert.equal(response.status, 400);
  const body = response.body;
  assert.equal(body.error.code, "invalid_input");
  assert.deepEqual(body.error.path, ["id"]);
  assert.match(body.error.message, /字段|标识/u);
}

async function verifyConfigurationJourney(baseUrl: string): Promise<void> {
  const manifest = {
    id: "rss",
    version: "1.0.0",
    configSchema: {
      type: "object",
      properties: { userAgent: { type: "string", minLength: 1 } },
      required: ["userAgent"],
      additionalProperties: false,
    },
    actions: {
      collect: {
        description: "读取并归档订阅源。",
        params: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1 } },
          required: ["limit"],
          additionalProperties: false,
        },
      },
    },
    environment: {
      browser: { required: false, profileReuseAfterRestart: false },
    },
  };
  const manifestJson = JSON.stringify(manifest);
  const initialConfig = JSON.stringify({ userAgent: "Binny E2E" });
  const initialTargets = JSON.stringify([
    { url: "https://example.test/one.xml" },
  ]);

  const emptyList = cliData<{ readonly bins: readonly unknown[] }>(
    await cli(baseUrl, ["bin", "list"]),
    "listed",
  );
  assert.deepEqual(emptyList.bins, []);

  const created = cliData<{
    readonly id: string;
    readonly identityId: string;
    readonly status: string;
    readonly execution: { readonly status: string };
  }>(
    await cli(baseUrl, [
      "bin",
      "create",
      "rss-main",
      "--collector",
      manifestJson,
      "--identity",
      "account-one",
      "--config",
      initialConfig,
      "--targets",
      initialTargets,
    ]),
    "created",
  );
  assert.equal(created.id, "rss-main");
  assert.equal(created.identityId, "account-one");
  assert.equal(created.status, "active");
  assert.equal(created.execution.status, "offline");

  const discovered = cliData<{
    readonly actions: Readonly<Record<string, unknown>>;
    readonly environment: { readonly browser: { readonly required: boolean } };
    readonly execution: { readonly status: string };
  }>(await cli(baseUrl, ["bin", "actions", "rss-main"]), "discovered");
  assert.deepEqual(Object.keys(discovered.actions), ["collect"]);
  assert.equal(discovered.environment.browser.required, false);
  assert.equal(discovered.execution.status, "offline");

  cliFailure(
    await cli(baseUrl, [
      "bin",
      "create",
      "rss-main",
      "--collector",
      manifestJson,
      "--identity",
      "duplicate-account",
      "--config",
      initialConfig,
      "--targets",
      initialTargets,
    ]),
    "bin_already_exists",
  );

  const invalidConfiguration = cliFailure<{
    readonly code: string;
    readonly message: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli(baseUrl, [
      "bin",
      "create",
      "rss-invalid-config",
      "--collector",
      manifestJson,
      "--identity",
      "account-invalid-config",
      "--config",
      "{}",
      "--targets",
      initialTargets,
    ]),
    "invalid_configuration",
  );
  assert.deepEqual(invalidConfiguration.path, ["config", "userAgent"]);
  assert.match(invalidConfiguration.message, /长期配置/u);

  const secondary = cliData<{
    readonly id: string;
    readonly identityId: string;
  }>(
    await cli(baseUrl, [
      "bin",
      "create",
      "rss-secondary",
      "--collector",
      manifestJson,
      "--identity",
      "account-two",
      "--config",
      initialConfig,
      "--targets",
      JSON.stringify([{ url: "https://example.test/two.xml" }]),
    ]),
    "created",
  );
  assert.equal(secondary.id, "rss-secondary");
  assert.equal(secondary.identityId, "account-two");

  const listed = cliData<{
    readonly bins: readonly {
      readonly id: string;
      readonly identityId: string;
    }[];
  }>(await cli(baseUrl, ["bin", "list"]), "listed");
  assert.equal(listed.bins.length, 2);
  assert.deepEqual(listed.bins.map(({ identityId }) => identityId).toSorted(), [
    "account-one",
    "account-two",
  ]);

  const updatedConfig = JSON.stringify({ userAgent: "Binny E2E updated" });
  const updatedTargets = JSON.stringify([
    { url: "https://example.test/one.xml" },
    { url: "https://example.test/extra.xml" },
  ]);
  const updated = cliData<{
    readonly identityId: string;
    readonly config: { readonly userAgent: string };
    readonly targets: readonly unknown[];
  }>(
    await cli(baseUrl, [
      "bin",
      "update",
      "rss-main",
      "--identity",
      "account-primary",
      "--config",
      updatedConfig,
      "--targets",
      updatedTargets,
    ]),
    "updated",
  );
  assert.equal(updated.identityId, "account-primary");
  assert.equal(updated.config.userAgent, "Binny E2E updated");
  assert.equal(updated.targets.length, 2);

  cliFailure(
    await cli(baseUrl, ["bin", "update", "rss-main", "--config", "{}"]),
    "invalid_configuration",
  );
  const afterRejectedUpdate = cliData<{
    readonly identityId: string;
    readonly config: { readonly userAgent: string };
  }>(await cli(baseUrl, ["bin", "get", "rss-main"]), "found");
  assert.equal(afterRejectedUpdate.identityId, "account-primary");
  assert.equal(afterRejectedUpdate.config.userAgent, "Binny E2E updated");

  const disabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "disable", "rss-main"]),
    "disabled",
  );
  assert.equal(disabled.status, "disabled");

  return;
}

async function verifyArchiveAtomicity(client: ArchiveClient): Promise<void> {
  const baseline = await submitArchive(client, {
    requestId: "e2e:archive:atomic-baseline",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "atomic-baseline" },
        body: { text: "原子拒绝后的对象" },
        capture: {
          scope: { case: "atomic" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });

  const missingBinResponse = await client.archives.$post({
    json: {
      requestId: "e2e:archive:missing-bin",
      binId: "rss-missing",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "missing-bin" },
          body: { text: "不存在的 bin" },
          capture: {
            scope: { case: "missing-bin" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  if (missingBinResponse.status !== 404) {
    throw new Error(
      "不存在的 bin 应被拒绝：" + (await missingBinResponse.text()),
    );
  }
  assert.equal((await missingBinResponse.json()).error.code, "bin_not_found");

  const emptyFailureResponse = await client.archives.$post({
    json: {
      requestId: "e2e:archive:empty-failure",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "empty-failure" },
          sourceRef: "https://example.test/unfetched",
          capture: {
            scope: { case: "failed-fetch" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  if (emptyFailureResponse.status !== 400) {
    throw new Error(
      "只提供外部出处不能形成空内容版本：" +
        (await emptyFailureResponse.text()),
    );
  }
  const emptyFailureError = await emptyFailureResponse.json();
  assert.equal(emptyFailureError.error.code, "invalid_input");
  assert.deepEqual(emptyFailureError.error.path, ["items", 0, "body"]);

  const unsafeNumberResponse = await client.archives.$post({
    json: {
      requestId: "e2e:archive:unsafe-json-number",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "e2e", key: "unsafe-json-number" },
          properties: { count: Number.MAX_SAFE_INTEGER + 1 },
          capture: {
            scope: { case: "invalid-json" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });
  if (unsafeNumberResponse.status !== 400) {
    throw new Error(
      "不精确 JSON 整数应被拒绝：" + (await unsafeNumberResponse.text()),
    );
  }
  const unsafeNumberError = await unsafeNumberResponse.json();
  assert.equal(unsafeNumberError.error.code, "invalid_input");
  assert.deepEqual(unsafeNumberError.error.path, [
    "items",
    0,
    "properties",
    "count",
  ]);

  const validAtomicItem = {
    sourceKey: { namespace: "e2e", key: "atomic-retry" },
    body: { text: "原子拒绝后的对象" },
    capture: {
      scope: { case: "atomic" },
      completeness: "complete" as const,
      missing: [],
    },
  };
  const invalidBatch = {
    requestId: "e2e:archive:atomic-invalid",
    binId: "rss-main",
    items: [
      validAtomicItem,
      {
        sourceKey: { namespace: "e2e" },
        body: { text: "无稳定对象键" },
        capture: {
          scope: { case: "atomic" },
          completeness: "complete" as const,
          missing: [],
        },
      },
    ],
  };
  const invalidBatchResponse = await client.archives.$post({
    // @ts-expect-error 服务端必须拒绝包含一个非法条目的整批提交。
    json: invalidBatch,
  });
  if (invalidBatchResponse.status !== 400) {
    throw new Error(
      "非法批次应被整批拒绝：" + (await invalidBatchResponse.text()),
    );
  }
  const invalidBatchError = await invalidBatchResponse.json();
  assert.equal(invalidBatchError.error.code, "invalid_input");
  assert.deepEqual(invalidBatchError.error.path, [
    "items",
    1,
    "sourceKey",
    "key",
  ]);

  const acceptedAtomic = await submitArchive(client, {
    requestId: "e2e:archive:atomic-retry",
    binId: "rss-main",
    items: [validAtomicItem],
  });
  assert.equal(
    BigInt(acceptedAtomic.archiveSeq),
    BigInt(baseline.archiveSeq) + 1n,
  );
  const atomicItemId = acceptedAtomic.items[0]?.itemId;
  assert.ok(atomicItemId);
  const atomicRead = await readArchiveItem(client, atomicItemId);
  assert.equal(atomicRead.observations.length, 1);
  assert.equal(atomicRead.views[0]?.state.sourceModifiedAt, undefined);

  const partialCommit = await submitArchive(client, {
    requestId: "e2e:archive:partial-capture",
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: "partial-capture" },
        body: { text: "已取得的正文" },
        capture: {
          scope: { section: "main" },
          completeness: "partial",
          missing: [{ path: "body.html", reason: "源站未提供 HTML 表示" }],
        },
      },
    ],
  });
  const partialItemId = partialCommit.items[0]?.itemId;
  assert.ok(partialItemId);
  const partialRead = await readArchiveItem(client, partialItemId);
  assert.equal(partialRead.views[0]?.state.capture.completeness, "partial");
  assert.equal(
    partialRead.views[0]?.state.capture.missing[0]?.path,
    "body.html",
  );
}

async function verifyArchiveIdempotency(client: ArchiveClient): Promise<void> {
  const retryItem = {
    sourceKey: { namespace: "e2e", key: "idempotent-retry" },
    body: { text: "同一请求重放" },
    capture: {
      scope: { case: "idempotency" },
      completeness: "complete" as const,
      missing: [],
    },
    diagnostics: [{ code: "first_observation", message: "第一次取得" }],
  };
  const retryRequest = {
    requestId: "e2e:archive:idempotent-retry",
    binId: "rss-main",
    items: [retryItem],
  };
  const firstRetryCommit = await submitArchive(client, retryRequest);
  const replayedCommit = await submitArchive(client, retryRequest);
  assert.equal(replayedCommit.commitId, firstRetryCommit.commitId);
  assert.equal(replayedCommit.archiveSeq, firstRetryCommit.archiveSeq);

  const conflictingRetry = {
    ...retryRequest,
    items: [
      {
        ...retryItem,
        body: { text: "相同请求标识的不同负载" },
      },
    ],
  };
  const conflictResponse = await client.archives.$post({
    json: conflictingRetry,
  });
  if (conflictResponse.status !== 409) {
    throw new Error(
      "同请求标识的不同负载应冲突：" + (await conflictResponse.text()),
    );
  }
  assert.equal(
    (await conflictResponse.json()).error.code,
    "archive_request_conflict",
  );

  const freshSameContent = await submitArchive(client, {
    ...retryRequest,
    requestId: "e2e:archive:idempotent-fresh",
  });
  assert.notEqual(freshSameContent.commitId, firstRetryCommit.commitId);
  assert.equal(
    freshSameContent.items[0]?.revisionId,
    firstRetryCommit.items[0]?.revisionId,
  );
  const retryItemId = firstRetryCommit.items[0]?.itemId;
  assert.ok(retryItemId);
  const retryRead = await readArchiveItem(client, retryItemId);
  assert.equal(retryRead.observations.length, 2);
  assert.equal(retryRead.revisions.length, 1);
}

async function verifyArchiveABA(
  client: ArchiveClient,
): Promise<ArchiveJourney> {
  const abaA = {
    sourceKey: { namespace: "e2e", key: "aba-item" },
    sourceRef: "https://example.test/aba-item",
    sourceModifiedAt: "2026-10-28T12:00:00+08:00",
    metadata: { title: "状态 A", authors: ["writer"] },
    properties: { counts: { replies: 2, stars: 4 }, tags: ["a", "b"] },
    body: { markdown: "正文 A", searchText: "正文 A" },
    capture: {
      scope: { source: "e2e", topic: "42" },
      completeness: "complete" as const,
      missing: [],
    },
  };
  const abaFirstRequest = {
    requestId: "e2e:archive:aba:first",
    binId: "rss-main",
    runId: "run-a1",
    collectorVersion: "rss@1.0.0",
    observedAt: "2026-10-28T04:01:00.000Z",
    items: [
      {
        ...abaA,
        diagnostics: [{ code: "partial_probe", message: "可选区块缺失" }],
      },
    ],
  };
  const abaFirst = await submitArchive(client, abaFirstRequest);
  const abaSecond = await submitArchive(client, {
    requestId: "e2e:archive:aba:second",
    binId: "rss-main",
    runId: "run-a2",
    collectorVersion: "rss@1.1.0",
    observedAt: "2026-10-28T04:02:00.000Z",
    items: [
      {
        ...abaA,
        sourceModifiedAt: "2026-10-28T04:01:00.000Z",
        metadata: { title: "状态 B", authors: ["writer"] },
        properties: { counts: { replies: 3, stars: 5 }, tags: ["a", "b"] },
        body: { markdown: "正文 B", searchText: "正文 B" },
        diagnostics: [{ code: "body_changed", message: "正文发生变化" }],
      },
    ],
  });
  const abaThird = await submitArchive(client, {
    requestId: "e2e:archive:aba:third",
    binId: "rss-main",
    runId: "run-a3",
    collectorVersion: "rss@2.0.0",
    observedAt: "2026-10-28T04:03:00.000Z",
    items: [
      {
        ...abaA,
        sourceModifiedAt: "2026-10-28T04:00:00.000Z",
        metadata: { authors: ["writer"], title: "状态 A" },
        properties: { tags: ["a", "b"], counts: { stars: 4, replies: 2 } },
        capture: {
          scope: { topic: "42", source: "e2e" },
          completeness: "complete" as const,
          missing: [],
        },
        diagnostics: [{ code: "partial_probe", message: "诊断已变化" }],
      },
    ],
  });
  const abaFirstItem = abaFirst.items[0];
  const abaSecondItem = abaSecond.items[0];
  const abaThirdItem = abaThird.items[0];
  assert.ok(abaFirstItem);
  assert.ok(abaSecondItem);
  assert.ok(abaThirdItem);
  assert.equal(abaFirstItem.itemId, abaThirdItem.itemId);
  assert.equal(abaFirstItem.revisionId, abaThirdItem.revisionId);
  assert.notEqual(abaFirstItem.revisionId, abaSecondItem.revisionId);

  const abaRead = await readArchiveItem(client, abaThirdItem.itemId);
  assert.equal(abaRead.revisions.length, 2);
  assert.equal(abaRead.observations.length, 3);
  assert.deepEqual(
    abaRead.observations.map(({ revisionId }) => revisionId),
    [
      abaFirstItem.revisionId,
      abaSecondItem.revisionId,
      abaThirdItem.revisionId,
    ],
  );
  assert.equal(abaRead.views[0]?.state.body?.markdown, "正文 A");
  assert.equal(abaRead.views[0]?.diagnostics?.[0]?.message, "诊断已变化");
  assert.equal(abaRead.views[0]?.observedAt, "2026-10-28T04:03:00.000Z");

  const abaRevisionResponse = await client.archives.revisions[
    ":revisionId"
  ].$get({
    param: { revisionId: abaThirdItem.revisionId },
  });
  if (abaRevisionResponse.status !== 200) {
    throw new Error("读取 A 版本失败：" + (await abaRevisionResponse.text()));
  }
  const abaRevision = await abaRevisionResponse.json();
  assert.equal(abaRevision.state.sourceModifiedAt, "2026-10-28T04:00:00.000Z");
  assert.equal(abaRevision.state.metadata?.title, "状态 A");
  assert.equal(abaRevision.state.body?.markdown, "正文 A");

  return {
    itemId: abaThirdItem.itemId,
    revisionId: abaThirdItem.revisionId,
    replayRequest: abaFirstRequest,
    replayCommitId: abaFirst.commitId,
    expectedObservationCount: abaRead.observations.length,
  };
}

async function verifyConcurrentArchiveIdentity(
  client: ArchiveClient,
): Promise<void> {
  const concurrentSourceKey = {
    namespace: "e2e",
    key: "concurrent-cross-bin",
  };
  const [mainCommit, secondaryCommit] = await Promise.all([
    submitArchive(client, {
      requestId: "e2e:archive:cross-bin:main",
      binId: "rss-main",
      items: [
        {
          sourceKey: concurrentSourceKey,
          metadata: { view: "main" },
          body: { text: "main view" },
          capture: {
            scope: { case: "cross-bin" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    }),
    submitArchive(client, {
      requestId: "e2e:archive:cross-bin:secondary",
      binId: "rss-secondary",
      items: [
        {
          sourceKey: concurrentSourceKey,
          metadata: { view: "secondary" },
          body: { text: "secondary view" },
          capture: {
            scope: { case: "cross-bin" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    }),
  ]);
  const mainConcurrentItem = mainCommit.items[0];
  const secondaryConcurrentItem = secondaryCommit.items[0];
  assert.ok(mainConcurrentItem);
  assert.ok(secondaryConcurrentItem);
  assert.equal(mainConcurrentItem.itemId, secondaryConcurrentItem.itemId);
  assert.notEqual(
    mainConcurrentItem.revisionId,
    secondaryConcurrentItem.revisionId,
  );
  const concurrentRead = await readArchiveItem(
    client,
    mainConcurrentItem.itemId,
  );
  assert.deepEqual(concurrentRead.views.map(({ binId }) => binId).toSorted(), [
    "rss-main",
    "rss-secondary",
  ]);
  assert.equal(concurrentRead.observations.length, 2);
}

async function verifyArchiveReadErrors(client: ArchiveClient): Promise<void> {
  const invalidItemIdResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: "not-a-uuid" },
  });
  if (invalidItemIdResponse.status !== 400) {
    throw new Error(
      "格式错误的 itemId 应返回400：" + (await invalidItemIdResponse.text()),
    );
  }
  assert.equal(
    (await invalidItemIdResponse.json()).error.code,
    "invalid_input",
  );

  const absentItemResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: "850e8400-e29b-41d4-a716-446655440000" },
  });
  if (absentItemResponse.status !== 404) {
    throw new Error(
      "不存在的 item 应返回404：" + (await absentItemResponse.text()),
    );
  }
  assert.equal((await absentItemResponse.json()).error.code, "item_not_found");

  const absentRevisionResponse = await client.archives.revisions[
    ":revisionId"
  ].$get({
    param: { revisionId: "950e8400-e29b-41d4-a716-446655440000" },
  });
  if (absentRevisionResponse.status !== 404) {
    throw new Error(
      "不存在的 revision 应返回404：" + (await absentRevisionResponse.text()),
    );
  }
  assert.equal(
    (await absentRevisionResponse.json()).error.code,
    "revision_not_found",
  );
}

async function verifyArchiveJourney(baseUrl: string): Promise<ArchiveJourney> {
  const enabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "enable", "rss-main"]),
    "enabled",
  );
  assert.equal(enabled.status, "active");

  const client = createApiClient(baseUrl);
  await verifyArchiveAtomicity(client);
  await verifyArchiveIdempotency(client);
  const aba = await verifyArchiveABA(client);
  await verifyConcurrentArchiveIdentity(client);
  await verifyArchiveReadErrors(client);
  return aba;
}

async function verifyRestartAndRemoval(
  baseUrl: string,
  port: number,
  archive: ArchiveJourney,
): Promise<void> {
  const disabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "disable", "rss-main"]),
    "disabled",
  );
  assert.equal(disabled.status, "disabled");
  await compose(["restart", "postgres"], port);
  await waitForApiAndDatabase(baseUrl);
  await compose(["restart", "server"], port);
  await waitForApiAndDatabase(baseUrl);

  const persisted = cliData<{
    readonly status: string;
    readonly identityId: string;
    readonly config: { readonly userAgent: string };
    readonly targets: readonly unknown[];
  }>(await cli(baseUrl, ["bin", "get", "rss-main"]), "found");
  assert.equal(persisted.status, "disabled");
  assert.equal(persisted.identityId, "account-primary");
  assert.equal(persisted.config.userAgent, "Binny E2E updated");
  assert.equal(persisted.targets.length, 2);

  const enabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "enable", "rss-main"]),
    "enabled",
  );
  assert.equal(enabled.status, "active");

  const removed = cliData<{ readonly removed: boolean; readonly id: string }>(
    await cli(baseUrl, ["bin", "remove", "rss-main"]),
    "removed",
  );
  assert.deepEqual(removed, { removed: true, id: "rss-main" });

  cliFailure(await cli(baseUrl, ["bin", "get", "rss-main"]), "bin_not_found");
  cliData(await cli(baseUrl, ["bin", "remove", "rss-secondary"]), "removed");
  const empty = cliData<{ readonly bins: readonly unknown[] }>(
    await cli(baseUrl, ["bin", "list"]),
    "listed",
  );
  assert.deepEqual(empty.bins, []);

  const client = createApiClient(baseUrl);
  const replay = await submitArchive(client, archive.replayRequest);
  assert.equal(replay.commitId, archive.replayCommitId);
  const persistedArchive = await readArchiveItem(client, archive.itemId);
  assert.equal(
    persistedArchive.observations.length,
    archive.expectedObservationCount,
  );
  assert.deepEqual(
    persistedArchive.views.map(({ binId }) => binId),
    ["rss-main"],
  );
  assert.equal(persistedArchive.views[0]?.state.body?.markdown, "正文 A");

  const revisionResponse = await client.archives.revisions[":revisionId"].$get({
    param: { revisionId: archive.revisionId },
  });
  if (revisionResponse.status !== 200) {
    throw new Error(
      "移除 bin 后读取历史版本失败：" + (await revisionResponse.text()),
    );
  }
  const persistedRevision = await revisionResponse.json();
  assert.equal(persistedRevision.state.body?.markdown, "正文 A");

  const cliArchiveItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", archive.itemId]),
    "found",
  );
  assert.deepEqual(cliArchiveItem, persistedArchive);
  const cliArchiveRevision = cliData<unknown>(
    await cli(baseUrl, ["archive", "revision", archive.revisionId]),
    "found",
  );
  assert.deepEqual(cliArchiveRevision, persistedRevision);
  await validateApiInput(baseUrl);
}

async function main(): Promise<void> {
  const port = await reservePort();
  composePort = port;
  const e2eHost = process.env.BINNY_E2E_HOST ?? "127.0.0.1";
  const baseUrl = "http://" + e2eHost + ":" + port;
  const overrideDirectory = await mkdtemp(
    path.join(tmpdir(), "binny02-compose-"),
  );
  composeOverrideFile = path.join(overrideDirectory, "compose.yaml");
  await writeFile(
    composeOverrideFile,
    [
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      "        - subnet: 10.253.2.0/24",
      "",
    ].join("\n"),
  );
  let cleanupError: Error | undefined;
  try {
    await compose(
      [
        "up",
        "--detach",
        "--build",
        "--wait",
        "--wait-timeout",
        "360",
        "postgres",
        "server",
      ],
      port,
    );
    await waitForApiAndDatabase(baseUrl);
    await verifyConfigurationJourney(baseUrl);
    const archive = await verifyArchiveJourney(baseUrl);
    await verifyRestartAndRemoval(baseUrl, port, archive);
    process.stdout.write(
      "Compose、PostgreSQL、HTTP API、归档与构建 CLI 旅程通过。\n",
    );
  } finally {
    const cleanup = await run(
      "docker",
      [
        ...composePrefix(),
        "down",
        "--rmi",
        "all",
        "--volumes",
        "--remove-orphans",
      ],
      { env: composeEnvironment() },
    );
    if (cleanup.code !== 0) {
      cleanupError = new Error(
        "清理 Compose 资源失败：\n" + cleanup.stdout + cleanup.stderr,
      );
    }
    await rm(overrideDirectory, { recursive: true, force: true });
  }
  if (cleanupError !== undefined) throw cleanupError;
}

await main();
