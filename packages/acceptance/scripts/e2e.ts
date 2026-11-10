import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  archiveBatchReadResponseSchema,
  archiveBatchReadReferenceSchema,
  type ArchiveBatchReadReference,
  type ArchiveSubmissionInput,
} from "@binny/contracts";
import {
  closeLinuxdoHumanSession,
  linuxdoUserJourney,
  openLinuxdoHumanSession,
  startLinuxdoViewerBrowser,
  triggerLinuxdoRun,
  type LinuxdoViewerBrowser,
  type LinuxdoUserJourney,
} from "@binny/source-adapter-linuxdo/acceptance";

import { runArticleAdaptersJourney } from "./article-adapters-journey.ts";
import {
  copyImageBuildContext,
  setBuildContextSourceAdapterVersion,
} from "./build-context.ts";
import { runDocumentAdaptersJourney } from "./document-adapters-journey.ts";
import {
  createIsolatedCliConsumer,
  type IsolatedCliConsumer,
} from "./isolated-consumer.ts";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ArchiveSourceTimeRead = {
  readonly precision: "instant" | "day" | "month" | "year";
  readonly value: string;
  readonly timeZone?: string;
};

type ManagedProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly write: (input: string) => void;
  readonly waitForMarker: (marker: string) => Promise<void>;
  readonly waitForClose: () => Promise<ProcessResult>;
};

type HeartbeatDelayProxy = {
  readonly arm: (stoppedRunId: string) => Promise<void>;
  readonly armRequestBody: () => Promise<void>;
  readonly waitUntilRequestBodyHeld: () => Promise<{
    readonly heldAt: number;
    readonly runtimeId: string;
  }>;
  readonly forwardUnrelatedRequest: () => Promise<number>;
  readonly waitUntilRequestBodyResponse: () => Promise<{
    readonly statusCode: number;
    readonly latestForwardedStatusCode?: number;
    readonly error?: string;
  }>;
  readonly waitUntilHeld: () => Promise<{
    readonly heldAt: number;
    readonly runtimeId: string;
    readonly ownerGeneration?: string;
    readonly stoppedRunId?: string;
  }>;
  readonly waitUntilTimedOut: () => Promise<number>;
  readonly waitUntilForwarded: (
    runtimeId: string,
  ) => Promise<string | undefined>;
  readonly release: () => Promise<void>;
};

type HeartbeatDelayProxyStatus = {
  readonly held: boolean;
  readonly heldForRequestBody?: boolean;
  readonly heldRequestBodyStatusCode?: number;
  readonly heldRequestBodyError?: string;
  readonly heldAt?: number;
  readonly clientClosedAt?: number;
  readonly heldRuntimeId?: string;
  readonly heldOwnerGeneration?: string;
  readonly heldStoppedRunId?: string;
  readonly forwardedRuntimeId?: string;
  readonly forwardedOwnerGeneration?: string;
  readonly forwardedStatusCode?: number;
};

type RssImageUpdate = {
  readonly baselineManifest: unknown;
  readonly candidateManifest: unknown;
  readonly baselineImageId: string;
  readonly candidateImageId: string;
  readonly buildContextDirectory: string;
};

type RssAcceptanceResult = {
  readonly binIds: readonly ["binny-rss-one", "binny-rss-two"];
  readonly itemId: string;
  readonly initialRevisionId: string;
  readonly initialRunId: string;
  readonly commitId: string;
  readonly resourceIds: readonly string[];
  readonly latestPartialRevisionId: string;
  readonly latestPartialResourceIds: readonly string[];
};

const artifactRoot = (() => {
  const value = process.env.BINNY_ACCEPTANCE_BUILD_CONTEXT;
  assert.ok(value !== undefined, "集成验收需要准备好的临时构建制品。");
  return value;
})();
const composeFile = path.join(artifactRoot, "compose.acceptance.yaml");
const capacityProfile = process.env.BINNY_E2E_CAPACITY_PROFILE ?? "smoke";
assert.ok(
  capacityProfile === "full" || capacityProfile === "smoke",
  "BINNY_E2E_CAPACITY_PROFILE 必须为 smoke 或 full。",
);
const capacityPhase =
  process.env.BINNY_E2E_CAPACITY_PHASE ??
  (capacityProfile === "full" ? "seed" : "all");
assert.ok(
  capacityPhase === "all" ||
    capacityPhase === "seed" ||
    capacityPhase === "verify" ||
    capacityPhase === "delete",
  "BINNY_E2E_CAPACITY_PHASE 必须为 all、seed、verify 或 delete。",
);
const isFullCapacityRun = capacityProfile === "full";
const internalStep = process.env.BINNY_E2E_INTERNAL_STEP;
const scheduleOnly =
  internalStep === "scheduled-runs" || internalStep === "schedule-overlap";
const scheduledRunsOnly = internalStep === "scheduled-runs";
const scheduleOverlapOnly = internalStep === "schedule-overlap";
const archiveModelOnly = internalStep === "archive-model";
const archiveSearchOnly = internalStep === "archive-search";
const rssLinuxdoOnly = internalStep === "rss-linuxdo";
const archiveModelJourney = archiveModelOnly || archiveSearchOnly;
const articleAdaptersOnly = internalStep === "article-adapters";
const documentAdaptersOnly = internalStep === "document-adapters";
const qoderAdapterOnly = internalStep === "qoder-adapter";
const archiveSearchBudgetMs = archiveModelJourney ? 1_500 : 10_000;
const manualRunsOnly =
  scheduleOnly ||
  archiveModelJourney ||
  articleAdaptersOnly ||
  documentAdaptersOnly ||
  qoderAdapterOnly;
const useHeartbeatProxy =
  (!manualRunsOnly || scheduledRunsOnly) && !rssLinuxdoOnly;
const preserveCapacityProject =
  isFullCapacityRun && (capacityPhase === "seed" || capacityPhase === "verify");
const projectName = isFullCapacityRun
  ? "binny-load-capacity"
  : "binny-archive-revision-diff-" + process.pid.toString(10);
const imageName = projectName + ":local";
const runtimeImageName = projectName + "-lightweight:local";
const schemaVariantRuntimeImageName =
  projectName + "-schema-two-lightweight:local";
const rssRuntimeImageName = projectName + "-rss:local";
const linuxdoRuntimeImageName = projectName + "-linuxdo:local";
const rssBaselineRuntimeImageName = projectName + "-rss-baseline:local";
const articleAdapterRuntimeImageNames = {
  openai: projectName + "-article-openai:local",
  anthropic: projectName + "-article-anthropic:local",
  google: projectName + "-article-google:local",
  huggingface: projectName + "-article-huggingface:local",
  mistral: projectName + "-article-mistral:local",
} as const;
const articleAdapterRuntimeServices = [
  "runtime-article-openai",
  "runtime-article-anthropic",
  "runtime-article-google",
  "runtime-article-huggingface",
  "runtime-article-mistral",
] as const;
const documentAdapterRuntimeImageNames = {
  deepseek: projectName + "-document-deepseek:local",
  qwen: projectName + "-document-qwen:local",
  kimi: projectName + "-document-kimi:local",
  minimax: projectName + "-document-minimax:local",
  qoder: projectName + "-document-qoder:local",
} as const;
const qoderAdapterRuntimeService = "runtime-document-qoder";
const documentAdapterRuntimeServices = [
  "runtime-document-deepseek",
  "runtime-document-qwen",
  "runtime-document-kimi",
  "runtime-document-minimax",
  qoderAdapterRuntimeService,
] as const;
let activeServerImage = imageName;
let activeRssRuntimeImage = rssRuntimeImageName;
let composeOverrideFile = "";
let composeProjectDirectory = "";
let composePort = 0;
let manualRunSourcePort = 0;
let linuxdoSourcePort = 0;
let linuxdoViewerBrowser: LinuxdoViewerBrowser | undefined;
let installedCliConsumer: IsolatedCliConsumer | undefined;

function createHeartbeatDelayProxy(
  controlPort: number,
  runtimePort: number,
): HeartbeatDelayProxy {
  const host = process.env.BINNY_E2E_HOST ?? "172.17.0.1";
  const controlUrl = `http://${host}:${String(controlPort)}`;

  async function readStatus(): Promise<HeartbeatDelayProxyStatus> {
    const response = await fetch(controlUrl + "/control/status", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as HeartbeatDelayProxyStatus;
  }

  return {
    async arm(stoppedRunId) {
      const response = await fetch(controlUrl + "/control/arm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stoppedRunId }),
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(response.status, 200);
    },
    async armRequestBody() {
      const response = await fetch(controlUrl + "/control/arm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ binId: "binny-runs-one", requestBody: true }),
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(response.status, 200);
    },
    async waitUntilRequestBodyHeld() {
      const status = await waitFor(
        readStatus,
        (current) =>
          current.held &&
          current.heldForRequestBody === true &&
          typeof current.heldAt === "number" &&
          typeof current.heldRuntimeId === "string",
        "server accepted an incomplete real heartbeat request body",
      );
      assert.ok(status.heldAt !== undefined);
      assert.ok(status.heldRuntimeId !== undefined);
      return { heldAt: status.heldAt, runtimeId: status.heldRuntimeId };
    },
    async forwardUnrelatedRequest() {
      const response = await fetch(
        `http://${host}:${String(runtimePort)}/health`,
        { signal: AbortSignal.timeout(3_000) },
      );
      await response.arrayBuffer();
      return response.status;
    },
    async waitUntilRequestBodyResponse() {
      const status = await waitFor(
        readStatus,
        (current) => typeof current.heldRequestBodyStatusCode === "number",
        "server completed the held heartbeat request",
      );
      assert.ok(status.heldRequestBodyStatusCode !== undefined);
      return {
        statusCode: status.heldRequestBodyStatusCode,
        ...(status.forwardedStatusCode === undefined
          ? {}
          : { latestForwardedStatusCode: status.forwardedStatusCode }),
        ...(status.heldRequestBodyError === undefined
          ? {}
          : { error: status.heldRequestBodyError }),
      };
    },
    async waitUntilHeld() {
      const status = await waitFor(
        readStatus,
        (current) =>
          current.held &&
          typeof current.heldAt === "number" &&
          typeof current.heldRuntimeId === "string",
        "代理暂存的原生 idle heartbeat",
      );
      assert.ok(status.heldAt !== undefined);
      assert.ok(status.heldRuntimeId !== undefined);
      return {
        heldAt: status.heldAt,
        runtimeId: status.heldRuntimeId,
        ...(status.heldOwnerGeneration === undefined
          ? {}
          : { ownerGeneration: status.heldOwnerGeneration }),
        ...(status.heldStoppedRunId === undefined
          ? {}
          : { stoppedRunId: status.heldStoppedRunId }),
      };
    },
    async waitUntilTimedOut() {
      const status = await waitFor(
        readStatus,
        (current) => typeof current.clientClosedAt === "number",
        "运行器 heartbeat 客户端超时",
      );
      assert.ok(status.clientClosedAt !== undefined);
      return status.clientClosedAt;
    },
    async waitUntilForwarded(runtimeId) {
      const status = await waitFor(
        readStatus,
        (current) => current.forwardedRuntimeId === runtimeId,
        `新运行器 ${runtimeId} 的真实心跳`,
      );
      return status.forwardedOwnerGeneration;
    },
    async release() {
      if (!(await readStatus()).held) return;
      const response = await fetch(controlUrl + "/control/release", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(response.status, 200);
    },
  };
}

function composePrefix(): readonly string[] {
  const projectDirectory =
    composeProjectDirectory.length === 0
      ? []
      : ["--project-directory", composeProjectDirectory];
  return [
    "compose",
    "--project-name",
    projectName,
    ...projectDirectory,
    "--file",
    composeFile,
    "--file",
    composeOverrideFile,
  ];
}

function composeEnvironment(): Readonly<Record<string, string>> {
  return {
    BINNY_IMAGE: activeServerImage,
    BINNY_BROWSER_CAPACITY_LIMIT: "1",
    BINNY_TEST_RUNNER_IMAGE: runtimeImageName,
    BINNY_TEST_RUNNER_SCHEMA_IMAGE: schemaVariantRuntimeImageName,
    BINNY_LIFECYCLE_STOP_GRACE_MS: "1500",
    BINNY_RSS_IMAGE: activeRssRuntimeImage,
    BINNY_ARTICLE_OPENAI_IMAGE: articleAdapterRuntimeImageNames.openai,
    BINNY_ARTICLE_ANTHROPIC_IMAGE: articleAdapterRuntimeImageNames.anthropic,
    BINNY_ARTICLE_GOOGLE_IMAGE: articleAdapterRuntimeImageNames.google,
    BINNY_ARTICLE_HUGGINGFACE_IMAGE:
      articleAdapterRuntimeImageNames.huggingface,
    BINNY_ARTICLE_MISTRAL_IMAGE: articleAdapterRuntimeImageNames.mistral,
    BINNY_DOCUMENT_DEEPSEEK_IMAGE: documentAdapterRuntimeImageNames.deepseek,
    BINNY_DOCUMENT_QWEN_IMAGE: documentAdapterRuntimeImageNames.qwen,
    BINNY_DOCUMENT_KIMI_IMAGE: documentAdapterRuntimeImageNames.kimi,
    BINNY_DOCUMENT_MINIMAX_IMAGE: documentAdapterRuntimeImageNames.minimax,
    BINNY_DOCUMENT_QODER_IMAGE: documentAdapterRuntimeImageNames.qoder,
    BINNY_LINUXDO_BIN_ID: "binny-integration-linuxdo",
    BINNY_LINUXDO_BIN_ID_TWO: "binny-integration-linuxdo-two",
    BINNY_LINUXDO_IMAGE: linuxdoRuntimeImageName,
    BINNY_ARCHIVE_SEARCH_BUDGET_MS: String(archiveSearchBudgetMs),
    BINNY_RESOURCE_UNREFERENCED_AGE_MS: String(15 * 1000),
    BINNY_RESOURCE_CLEANUP_INTERVAL_MS: String(60 * 60 * 1000),
  };
}

function apiBaseUrl(): string {
  return (
    "http://" +
    (process.env.BINNY_E2E_HOST ?? "172.17.0.1") +
    ":" +
    String(composePort)
  );
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
      cwd: options.cwd ?? artifactRoot,
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

async function compose(args: readonly string[]): Promise<ProcessResult> {
  const result = await run("docker", [...composePrefix(), ...args], {
    env: composeEnvironment(),
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

function startManagedProcess(
  command: string,
  args: readonly string[],
): ManagedProcess {
  const child = spawn(command, [...args], {
    cwd: artifactRoot,
    env: { ...process.env, ...composeEnvironment() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closeResult: ProcessResult | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<ProcessResult>((resolve) => {
    child.once("error", (error) => {
      stderr += String(error);
      closeResult = { code: 1, stdout, stderr };
      resolve(closeResult);
    });
    child.once("close", (code) => {
      closeResult = { code: code ?? 1, stdout, stderr };
      resolve(closeResult);
    });
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    write(input) {
      if (closeResult !== undefined) {
        throw new Error("受控子进程已经退出。");
      }
      child.stdin.write(input);
    },
    async waitForMarker(marker) {
      if (stdout.includes(marker)) return;
      await new Promise<void>((resolveMarker, rejectMarker) => {
        const deadline = setTimeout(() => {
          cleanup();
          rejectMarker(
            new Error(`等待子进程输出 ${marker} 超时：\n${stdout}\n${stderr}`),
          );
        }, 30_000);
        const onData = (): void => {
          if (!stdout.includes(marker)) return;
          cleanup();
          resolveMarker();
        };
        const onClose = (): void => {
          cleanup();
          rejectMarker(
            new Error(`子进程在输出 ${marker} 前退出：\n${stdout}\n${stderr}`),
          );
        };
        const cleanup = (): void => {
          clearTimeout(deadline);
          child.stdout.off("data", onData);
          child.off("close", onClose);
        };
        child.stdout.on("data", onData);
        child.once("close", onClose);
      });
    },
    waitForClose: () => closed,
  };
}

async function cli(
  baseUrl: string,
  args: readonly string[],
): Promise<ProcessResult> {
  assert.ok(installedCliConsumer !== undefined, "未安装独立 CLI 消费者。");
  return await installedCliConsumer.run(args, {
    apiUrl: baseUrl,
    environmentApiUrl: "http://127.0.0.1:1",
  });
}

async function publishedPort(
  service: string,
  containerPort: number,
  replicaIndex?: number,
): Promise<number> {
  const mapping = (
    await compose([
      "port",
      ...(replicaIndex === undefined ? [] : ["--index", String(replicaIndex)]),
      service,
      String(containerPort),
    ])
  ).stdout.trim();
  const portText = /:(\d+)$/u.exec(mapping)?.[1];
  const port = Number(portText);
  assert.ok(
    portText !== undefined &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535,
    `Compose 没有为 ${service}:${String(containerPort)} 返回有效宿主端口：${mapping}`,
  );
  return port;
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

async function archiveHttpStep(
  stage: "fixed-search" | "submit" | "after-restart",
  baseUrl: string,
  state?: string,
  sdkResourceState?: string,
): Promise<string> {
  const result = await run(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@binny/api",
      "exec",
      "node",
      "--conditions=source",
      "scripts/archive-http-e2e.ts",
      stage,
      baseUrl,
    ],
    {
      env: {
        ...(state === undefined ? {} : { BINNY_E2E_ARCHIVE_STATE: state }),
        ...(stage === "fixed-search" && archiveModelJourney
          ? { BINNY_E2E_ARCHIVE_EXTENSION_FIXTURES: "1" }
          : {}),
        ...(sdkResourceState === undefined
          ? {}
          : { BINNY_E2E_SDK_RESOURCE_STATE: sdkResourceState }),
      },
    },
  );
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

type ArchiveBatchReadAcceptanceFixture = {
  readonly reference: ArchiveBatchReadReference;
  readonly oversizedReference: ArchiveBatchReadReference;
  readonly bodyLength: number;
  readonly bodySuffix: string;
  readonly resourceId: string;
};

async function archiveBatchReadHttpStep(
  baseUrl: string,
): Promise<ArchiveBatchReadAcceptanceFixture> {
  const result = await run("pnpm", [
    "--silent",
    "--filter",
    "@binny/api",
    "exec",
    "node",
    "--conditions=source",
    "scripts/archive-batch-read-e2e.ts",
    baseUrl,
  ]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const fixture: unknown = JSON.parse(result.stdout);
  assert.ok(typeof fixture === "object" && fixture !== null);
  assert.ok("reference" in fixture);
  assert.ok("oversizedReference" in fixture);
  assert.ok("bodyLength" in fixture && typeof fixture.bodyLength === "number");
  assert.ok("bodySuffix" in fixture && typeof fixture.bodySuffix === "string");
  assert.ok("resourceId" in fixture && typeof fixture.resourceId === "string");
  assert.ok(Number.isSafeInteger(fixture.bodyLength) && fixture.bodyLength > 0);
  return {
    reference: archiveBatchReadReferenceSchema.parse(fixture.reference),
    oversizedReference: archiveBatchReadReferenceSchema.parse(
      fixture.oversizedReference,
    ),
    bodyLength: fixture.bodyLength,
    bodySuffix: fixture.bodySuffix,
    resourceId: fixture.resourceId,
  };
}

async function archiveBatchReadMissingMediaHttpStep(
  baseUrl: string,
  fixture: ArchiveBatchReadAcceptanceFixture,
): Promise<void> {
  const response = await fetch(baseUrl + "/archives/batch-read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ references: [fixture.reference] }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = archiveBatchReadResponseSchema.parse(
    (await response.json()) as unknown,
  ).results[0];
  assert.ok(result?.status === "readable");
  assert.equal(result.revision.state.body?.text?.length, fixture.bodyLength);
  assert.ok(result.revision.state.body?.text?.endsWith(fixture.bodySuffix));
  assert.deepEqual(result.resources, [
    { resourceId: fixture.resourceId, status: "missing" },
  ]);
}

async function archiveBatchReadCliStep(
  baseUrl: string,
  fixture: ArchiveBatchReadAcceptanceFixture,
): Promise<void> {
  const args = [
    "archive",
    "batch-read",
    "--references",
    JSON.stringify([fixture.reference]),
  ];
  const structured = cliData<{
    readonly results: readonly {
      readonly index: number;
      readonly status: string;
      readonly resources: readonly {
        readonly resourceId: string;
        readonly status: string;
      }[];
      readonly revision?: {
        readonly state: { readonly body?: { readonly text?: string } };
      };
    }[];
  }>(await cli(baseUrl, args), "read");
  assert.equal(structured.results.length, 1);
  const result = structured.results[0];
  assert.ok(result?.status === "readable");
  assert.equal(result.index, 0);
  const bodyText = result.revision?.state.body?.text;
  assert.equal(bodyText?.length, fixture.bodyLength);
  assert.ok(bodyText?.endsWith(fixture.bodySuffix));
  assert.deepEqual(result.resources, [
    { resourceId: fixture.resourceId, status: "missing" },
  ]);

  const readableText = await cli(baseUrl, [...args, "--output-format", "text"]);
  assert.equal(readableText.code, 0, readableText.stderr);
  assert.ok(readableText.stdout.includes(fixture.bodySuffix));
  assert.ok(readableText.stdout.includes(fixture.resourceId + ": missing"));

  const invalidJson = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
    readonly message: string;
  }>(
    await cli(baseUrl, ["archive", "batch-read", "--references", "not-json"]),
    "invalid_input",
  );
  assert.deepEqual(invalidJson.path, ["references"]);
  assert.match(invalidJson.message, /valid JSON/u);

  const tooMany = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
    readonly message: string;
  }>(
    await cli(baseUrl, [
      "archive",
      "batch-read",
      "--references",
      JSON.stringify(Array.from({ length: 51 }, () => fixture.reference)),
    ]),
    "invalid_input",
  );
  assert.deepEqual(tooMany.path, ["references"]);
  assert.match(tooMany.message, /Read at most 50 references.*another request/u);

  const payloadFailure = cliFailure<{
    readonly code: string;
    readonly message: string;
  }>(
    await cli(baseUrl, [
      "archive",
      "batch-read",
      "--references",
      JSON.stringify([fixture.oversizedReference]),
    ]),
    "payload_too_large",
  );
  assert.match(
    payloadFailure.message,
    /Split the references into smaller requests/u,
  );
  assert.match(payloadFailure.message, /archive revision <revision-id>/u);
}

async function archiveSearchCliStep(baseUrl: string): Promise<void> {
  const binId = "binny-runs-one";
  if (archiveModelJourney) {
    const discovered = cliData<{
      readonly sourceAdapterId: string;
      readonly fields: Readonly<
        Record<string, { readonly operations: readonly string[] }>
      >;
    }>(await cli(baseUrl, ["bin", "extension-fields", binId]), "discovered");
    assert.equal(discovered.sourceAdapterId, "binny-runs.manual-run-fixture");
    assert.deepEqual(discovered.fields.labels?.operations, ["has", "hasAny"]);
    const discoveryText = await cli(baseUrl, [
      "bin",
      "extension-fields",
      binId,
      "--output-format",
      "text",
    ]);
    assert.equal(discoveryText.code, 0, discoveryText.stderr);
    assert.match(discoveryText.stdout, /- category: string/u);
    assert.match(discoveryText.stdout, /Operations: has, hasAny/u);

    const extensionQuery = {
      bins: ["binny-runs-one", "binny-runs-two"],
      extensions: {
        sourceAdapterId: "binny-runs.manual-run-fixture",
        filters: { category: { op: "eq", value: "post" } },
      },
      limit: 20,
    };
    const extensionResults = cliData<{
      readonly results: readonly {
        readonly title: string | null;
        readonly matches: readonly { readonly binId: string }[];
      }[];
    }>(
      await cli(baseUrl, [
        "archive",
        "search",
        "--query",
        JSON.stringify(extensionQuery),
      ]),
      "found",
    );
    assert.equal(extensionResults.results.length, 1);
    assert.equal(extensionResults.results[0]?.title, "Extension post view");
    assert.deepEqual(
      extensionResults.results[0]?.matches.map(
        ({ binId: matchedBinId }) => matchedBinId,
      ),
      ["binny-runs-one"],
    );

    const listQuery = {
      ...extensionQuery,
      extensions: {
        ...extensionQuery.extensions,
        filters: { labels: { op: "hasAny", values: ["reply", "release"] } },
      },
    };
    const extensionText = await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify(listQuery),
      "--output-format",
      "text",
    ]);
    assert.equal(extensionText.code, 0, extensionText.stderr);
    assert.match(extensionText.stdout, /- Extension post view/u);
    assert.match(
      extensionText.stdout,
      /Views: binny-runs-one, binny-runs-two/u,
    );
    assert.doesNotMatch(extensionText.stdout, /"kind"\s*:/u);

    const extensionDistributionQuery = {
      bins: ["binny-runs-one", "binny-runs-two"],
      extensions: {
        sourceAdapterId: "binny-runs.manual-run-fixture",
        filters: {
          labels: { op: "hasAny", values: ["release", "reply"] },
        },
      },
      includeCandidates: false,
      limit: 5,
      distribution: {
        by: "extension",
        sourceAdapterId: "binny-runs.manual-run-fixture",
        field: "labels",
        limit: 1,
      },
    };
    const extensionDistribution = cliData<{
      readonly candidatesIncluded: boolean;
      readonly results: readonly unknown[];
      readonly distribution?: {
        readonly by: string;
        readonly totalItems: string;
        readonly groups: readonly {
          readonly kind: string;
          readonly value?: string;
          readonly itemCount: string;
        }[];
        readonly hasMore: boolean;
        readonly nextCursor?: string;
      };
    }>(
      await cli(baseUrl, [
        "archive",
        "search",
        "--query",
        JSON.stringify(extensionDistributionQuery),
      ]),
      "found",
    );
    assert.equal(extensionDistribution.candidatesIncluded, false);
    assert.deepEqual(extensionDistribution.results, []);
    assert.equal(extensionDistribution.distribution?.by, "extension");
    assert.equal(extensionDistribution.distribution?.totalItems, "1");
    assert.deepEqual(extensionDistribution.distribution?.groups, [
      { kind: "extension", value: "news", itemCount: "1" },
    ]);
    assert.equal(extensionDistribution.distribution?.hasMore, true);
    assert.ok(extensionDistribution.distribution?.nextCursor);

    const categoryDistributionText = await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        bins: ["binny-runs-one", "binny-runs-two"],
        text: { in: "title", groups: [["Extension"]] },
        includeCandidates: false,
        distribution: {
          by: "extension",
          sourceAdapterId: "binny-runs.manual-run-fixture",
          field: "category",
        },
      }),
      "--output-format",
      "text",
    ]);
    assert.equal(
      categoryDistributionText.code,
      0,
      categoryDistributionText.stderr,
    );
    assert.match(
      categoryDistributionText.stdout,
      /Distribution by extension: 4 distinct matching items\./u,
    );
    assert.match(
      categoryDistributionText.stdout,
      /- Extension "comment": 1 item/u,
    );
    assert.match(
      categoryDistributionText.stdout,
      /- Missing extension value: 3 items/u,
    );
    assert.match(
      categoryDistributionText.stdout,
      /Each group counts distinct items; one item can appear in multiple groups\./u,
    );
    assert.match(
      categoryDistributionText.stdout,
      /Candidate results were not requested\./u,
    );
    assert.doesNotMatch(
      categoryDistributionText.stdout,
      /No archived items matched\.|End of results\./u,
    );
    assert.match(categoryDistributionText.stdout, /End of distribution\./u);
    assert.doesNotMatch(categoryDistributionText.stdout, /"kind"\s*:/u);

    const searchHelp = await cli(baseUrl, ["archive", "search", "--help"]);
    assert.equal(searchHelp.code, 0, searchHelp.stderr);
    assert.match(searchHelp.stdout, /distribute.*by bin, local date period/u);
    assert.match(searchHelp.stdout, /distribution\.cursor/u);
    assert.match(
      searchHelp.stdout,
      /group counts may exceed the distinct total/u,
    );

    const mixedAdapterFailure = cliFailure<{
      readonly code: string;
      readonly path?: readonly (string | number)[];
      readonly message: string;
    }>(
      await cli(baseUrl, [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: ["binny-runs-one", "binny-rss-one"],
          extensions: {
            sourceAdapterId: "binny-runs.manual-run-fixture",
            filters: { category: { op: "eq", value: "post" } },
          },
        }),
      ]),
      "invalid_input",
    );
    assert.deepEqual(mixedAdapterFailure.path, ["bins"]);
    assert.match(mixedAdapterFailure.message, /declared source adapter only/u);

    const invalidOperationFailure = cliFailure<{
      readonly code: string;
      readonly path?: readonly (string | number)[];
      readonly message: string;
    }>(
      await cli(baseUrl, [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: ["binny-runs-one"],
          extensions: {
            sourceAdapterId: "binny-runs.manual-run-fixture",
            filters: {
              section: { op: "gt", value: "archive-model" },
            },
          },
        }),
      ]),
      "invalid_input",
    );
    assert.deepEqual(invalidOperationFailure.path, [
      "extensions",
      "filters",
      "section",
      "op",
    ]);
    assert.match(invalidOperationFailure.message, /eq.*in.*has.*hasAny/u);
  }
  const query = {
    bins: [binId],
    text: { groups: [["Needle"], ["release"]] },
    limit: 10,
  };
  const search = cliData<{
    readonly snapshot: { readonly asOf: string };
    readonly results: readonly {
      readonly itemId: string;
      readonly title: string | null;
      readonly sourceKey: { readonly namespace: string; readonly key: string };
      readonly matches: readonly {
        readonly binId: string;
        readonly revisionId: string;
        readonly archiveSeq: string;
      }[];
    }[];
  }>(
    await cli(baseUrl, ["archive", "search", "--query", JSON.stringify(query)]),
    "found",
  );
  const matchedItem = search.results.find(
    ({ title }) => title === "Needle model updated",
  );
  assert.ok(matchedItem !== undefined);
  assert.equal(matchedItem.sourceKey.namespace, "e2e");
  assert.ok(
    matchedItem.matches.some(
      ({ binId: matchedBinId, revisionId }) =>
        matchedBinId === binId && revisionId.length > 0,
    ),
  );

  const timeWindowQuery = {
    bins: [binId],
    timeWindow: {
      field: "observedAt",
      from: "2000-01-01",
      until: "2100-01-01",
      timeZone: "UTC",
    },
    limit: 5,
  };
  const timeWindowPage = cliData<{
    readonly timeSummary: {
      readonly certainItems: string;
      readonly undeterminedItems: string;
    };
    readonly results: readonly {
      readonly timeStatus?: string;
      readonly matches: readonly {
        readonly timeMatch?: { readonly status: string };
      }[];
    }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify(timeWindowQuery),
    ]),
    "found",
  );
  assert.ok(Number(timeWindowPage.timeSummary.certainItems) > 0);
  assert.equal(timeWindowPage.timeSummary.undeterminedItems, "0");
  assert.ok(
    timeWindowPage.results.every(
      ({ timeStatus, matches }) =>
        timeStatus === "certain" &&
        matches.every(({ timeMatch }) => timeMatch?.status === "certain"),
    ),
  );

  const firstPage = cliData<{
    readonly snapshot: { readonly asOf: string };
    readonly results: readonly { readonly itemId: string }[];
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({ bins: [binId], limit: 1 }),
    ]),
    "found",
  );
  assert.equal(firstPage.results.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  assert.equal(firstPage.hasMore, firstPage.nextCursor !== undefined);
  const secondPage = cliData<{
    readonly snapshot: { readonly asOf: string };
    readonly results: readonly { readonly itemId: string }[];
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        bins: [binId],
        limit: 2,
        cursor: firstPage.nextCursor,
      }),
    ]),
    "found",
  );
  assert.deepEqual(secondPage.snapshot, firstPage.snapshot);
  assert.ok(secondPage.results.length > 0);
  assert.equal(secondPage.hasMore, secondPage.nextCursor !== undefined);
  assert.ok(
    secondPage.results.every(
      ({ itemId }) => itemId !== firstPage.results[0]?.itemId,
    ),
  );

  const reusedSnapshot = cliData<{
    readonly snapshot: { readonly asOf: string; readonly mode: string };
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        bins: [binId],
        text: { in: "title", groups: [["Needle"]] },
        asOf: firstPage.snapshot.asOf,
      }),
    ]),
    "found",
  );
  assert.equal(reusedSnapshot.snapshot.asOf, firstPage.snapshot.asOf);
  assert.equal(reusedSnapshot.snapshot.mode, "asOf");

  const readable = await cli(baseUrl, [
    "archive",
    "search",
    "--query",
    JSON.stringify({ bins: [binId], limit: 1 }),
    "--output-format",
    "text",
  ]);
  assert.equal(readable.code, 0, readable.stderr);
  assert.match(readable.stdout, /Snapshot:/u);
  assert.match(readable.stdout, /Matches on this page: 1/u);
  assert.match(
    readable.stdout,
    /More results are available\. Repeat with query\.cursor set to [A-Za-z0-9_-]+\./u,
  );
  assert.doesNotMatch(readable.stdout, /"results"\s*:/u);

  const timeWindowReadable = await cli(baseUrl, [
    "archive",
    "search",
    "--query",
    JSON.stringify(timeWindowQuery),
    "--output-format",
    "text",
  ]);
  assert.equal(timeWindowReadable.code, 0, timeWindowReadable.stderr);
  assert.match(timeWindowReadable.stdout, /Certain items: [1-9]\d*/u);
  assert.match(timeWindowReadable.stdout, /Undetermined items: 0/u);
  assert.match(timeWindowReadable.stdout, /Time review: certain/u);

  const sourceTimeQuery = {
    bins: [binId],
    text: { in: "title", groups: [["Beijing window"]] },
    timeWindow: {
      field: "sourcePublishedAt",
      from: "2026-11-08",
      until: "2026-11-09",
      timeZone: "Asia/Shanghai",
    },
    limit: 20,
  };
  const certainSourceTimeReadable = await cli(baseUrl, [
    "archive",
    "search",
    "--query",
    JSON.stringify(sourceTimeQuery),
    "--output-format",
    "text",
  ]);
  assert.equal(
    certainSourceTimeReadable.code,
    0,
    certainSourceTimeReadable.stderr,
  );
  assert.match(
    certainSourceTimeReadable.stdout,
    /Source published: 2026-11-08T20:00:00\+08:00 \(precision=instant; timeZone=Asia\/Shanghai\)/u,
  );
  assert.match(
    certainSourceTimeReadable.stdout,
    /Source published: 2026-11-08 \(precision=day; timeZone=Asia\/Shanghai\)/u,
  );
  assert.match(
    certainSourceTimeReadable.stdout,
    /Time match binny-runs-one: certain/u,
  );

  const undeterminedSourceTimeReadable = await cli(baseUrl, [
    "archive",
    "search",
    "--query",
    JSON.stringify({
      ...sourceTimeQuery,
      timeWindow: { ...sourceTimeQuery.timeWindow, review: "undetermined" },
    }),
    "--output-format",
    "text",
  ]);
  assert.equal(
    undeterminedSourceTimeReadable.code,
    0,
    undeterminedSourceTimeReadable.stderr,
  );
  assert.match(
    undeterminedSourceTimeReadable.stdout,
    /Source published: null/u,
  );
  assert.match(
    undeterminedSourceTimeReadable.stdout,
    /Source published: 2026-11-08 \(precision=day\)/u,
  );
  assert.match(
    undeterminedSourceTimeReadable.stdout,
    /Source published: 2026-11 \(precision=month; timeZone=Asia\/Shanghai\)/u,
  );
  for (const reason of [
    "missingTime",
    "missingTimeZone",
    "precisionOverlapsBoundary",
  ]) {
    assert.match(
      undeterminedSourceTimeReadable.stdout,
      new RegExp(
        `Time match binny-runs-one: undetermined \\(${reason}\\)`,
        "u",
      ),
    );
  }

  const dateDistributionReadable = await cli(baseUrl, [
    "archive",
    "search",
    "--query",
    JSON.stringify({
      bins: [binId],
      text: { in: "title", groups: [["Beijing window day-utc"]] },
      includeCandidates: false,
      distribution: {
        by: "date",
        field: "sourcePublishedAt",
        period: "day",
        timeZone: "Asia/Shanghai",
      },
    }),
    "--output-format",
    "text",
  ]);
  assert.equal(
    dateDistributionReadable.code,
    0,
    dateDistributionReadable.stderr,
  );
  assert.match(
    dateDistributionReadable.stdout,
    /Distribution by date: 1 distinct matching item\./u,
  );
  assert.match(
    dateDistributionReadable.stdout,
    /- Undetermined \(precisionOverlapsBoundary\): 1 item/u,
  );
  assert.match(dateDistributionReadable.stdout, /End of distribution\./u);

  for (const invalidQuery of [
    { unsupportedFilter: true },
    { budgetMs: 1 },
    { bins: [binId], limit: 0 },
  ]) {
    const failure = cliFailure<{ readonly code: string }>(
      await cli(baseUrl, [
        "archive",
        "search",
        "--query",
        JSON.stringify(invalidQuery),
      ]),
      "invalid_input",
    );
    assert.equal(failure.code, "invalid_input");
  }

  const mismatchedCursor = cliFailure<{ readonly code: string }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        bins: [binId],
        text: { groups: [["different filter"]] },
        cursor: firstPage.nextCursor,
      }),
    ]),
    "invalid_input",
  );
  assert.equal(mismatchedCursor.code, "invalid_input");
}

async function verifyArchiveSearchPoolWaitBudget(
  baseUrl: string,
  itemId: string,
): Promise<void> {
  const databasePoolSize = 10;
  // The server reserves one of its pool sessions for the schedule dispatcher.
  const reservedScheduleSessionCount = 1;
  const blockedReadConnectionCount =
    databasePoolSize - reservedScheduleSessionCount;
  const lock = await holdArchiveItemReadLock();
  const itemReads = Array.from({ length: blockedReadConnectionCount }, () =>
    fetch(`${baseUrl}/archives/items/${itemId}`, {
      signal: AbortSignal.timeout(30_000),
    }),
  );

  try {
    const blockedReads = await waitFor(
      async () =>
        (await readManualRunLockWaiters()).filter(({ blockers }) =>
          blockers.includes(lock.backendPid),
        ),
      (waiters) => waiters.length === blockedReadConnectionCount,
      "archive item reads to occupy every non-reserved PostgreSQL pool connection",
    );
    assert.equal(blockedReads.length, blockedReadConnectionCount);

    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/archives/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bins: ["binny-runs-one"], limit: 1 }),
      signal: AbortSignal.timeout(6_000),
    });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(response.status, 422);
    const failure = (await response.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    assert.equal(failure.error.code, "query_budget_exceeded");
    assert.match(
      failure.error.message,
      new RegExp(`request budget of ${String(archiveSearchBudgetMs)} ms`, "u"),
    );
    assert.ok(
      elapsedMs < archiveSearchBudgetMs * 2,
      `Search waited ${String(elapsedMs)} ms for the occupied database pool.`,
    );
  } finally {
    await lock.release();
    const responses = await Promise.all(itemReads);
    assert.ok(responses.every(({ status }) => status === 200));
  }

  const recoveredSearch = await fetch(`${baseUrl}/archives/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bins: ["binny-runs-one"], limit: 1 }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(recoveredSearch.status, 200);
}

async function verifyArchiveBatchReadBudget(
  baseUrl: string,
  reference: ArchiveBatchReadReference,
): Promise<void> {
  const lock = startManagedProcess("docker", postgresExecArgs([]));
  lock.write(
    "BEGIN;\nSELECT pg_backend_pid();\nLOCK TABLE archive_resource IN ACCESS EXCLUSIVE MODE;\nSELECT 'BINNY_ARCHIVE_RESOURCE_READ_LOCK_HELD';\n",
  );
  await lock.waitForMarker("BINNY_ARCHIVE_RESOURCE_READ_LOCK_HELD");
  const backendPid = Number(lock.stdout().trim().split("\n")[0]);
  assert.ok(Number.isInteger(backendPid) && backendPid > 0);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    lock.write("COMMIT;\n\\q\n");
    const result = await lock.waitForClose();
    assert.equal(result.code, 0, result.stderr);
  };

  try {
    const startedAt = performance.now();
    const responsePromise = fetch(baseUrl + "/archives/batch-read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ references: [reference] }),
      signal: AbortSignal.timeout(archiveSearchBudgetMs * 3),
    });
    await waitForManualRunLockWaiterBlockedBy(backendPid);
    const response = await responsePromise;
    const elapsedMs = performance.now() - startedAt;
    assert.equal(response.status, 422);
    const failure = (await response.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    assert.equal(failure.error.code, "query_budget_exceeded");
    assert.match(
      failure.error.message,
      new RegExp(`request budget of ${String(archiveSearchBudgetMs)} ms`, "u"),
    );
    assert.match(failure.error.message, /no partial results were returned/u);
    assert.ok(
      elapsedMs < archiveSearchBudgetMs * 2,
      `Batch read waited ${String(elapsedMs)} ms for resource storage metadata.`,
    );
  } finally {
    await release();
  }

  const recovered = await fetch(baseUrl + "/archives/batch-read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ references: [reference] }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(recovered.status, 200, await recovered.clone().text());
}

async function capacityHttpStep(baseUrl: string): Promise<string> {
  const result = await run(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@binny/api",
      "exec",
      "node",
      "--conditions=source",
      "scripts/archive-http-e2e.ts",
      "capacity",
      baseUrl,
    ],
    {
      env: {
        BINNY_E2E_CAPACITY_PROFILE: capacityProfile,
        BINNY_E2E_CAPACITY_PHASE: capacityPhase,
      },
    },
  );
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

async function sdkResourceStep(baseUrl: string): Promise<string> {
  const result = await run("pnpm", [
    "--silent",
    "--filter",
    "@binny/source-adapter-sdk",
    "exec",
    "node",
    "--conditions=source",
    "scripts/archive-resource-e2e.ts",
    baseUrl,
  ]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

async function imageId(image: string): Promise<string> {
  const result = await run(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function containerImageId(service: string): Promise<string> {
  const containerId = await runningContainerId(service);
  const result = await run(
    "docker",
    ["inspect", "--format", "{{.Image}}", containerId],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function runningContainerId(service: string): Promise<string> {
  const containers = await compose(["ps", "-q", service]);
  const containerId = containers.stdout.trim().split("\n")[0];
  assert.ok(containerId, `没有找到 Compose 服务 ${service} 的容器。`);
  return containerId;
}

async function containerStatus(containerId: string): Promise<string> {
  const result = await run(
    "docker",
    ["inspect", "--format", "{{.State.Status}}", containerId],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function networkSubnet(network: string): Promise<string> {
  const result = await run("docker", [
    "network",
    "inspect",
    "--format",
    "{{(index .IPAM.Config 0).Subnet}}",
    network,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function archiveIds(state: string): {
  readonly itemId: string;
  readonly relationItemId: string;
  readonly relationCommitId: string;
  readonly revisionId: string;
  readonly comparedRevisionId: string;
  readonly commitId: string;
  readonly historicalAsOf: string;
  readonly relationAsOf: string;
  readonly resourceItemId: string;
  readonly resourceRevisionId: string;
  readonly resourcePartialRevisionId: string;
  readonly resourceRepairedRevisionId: string;
  readonly resourceId: string;
  readonly repairedResourceId: string;
  readonly orphanResourceId: string;
  readonly resourceMarkerItemId: string;
  readonly cliCascadeRootItemId: string;
  readonly cliCascadeTargetItemId: string;
} {
  const parsed: unknown = JSON.parse(state);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("归档验收状态格式无效。");
  }
  const fields = parsed as Record<string, unknown>;
  const readText = (name: string): string => {
    const value = fields[name];
    if (typeof value !== "string") {
      throw new Error(`归档验收状态缺少 ${name}。`);
    }
    return value;
  };
  return {
    itemId: readText("itemId"),
    relationItemId: readText("relationItemId"),
    relationCommitId: readText("relationCommitId"),
    revisionId: readText("revisionId"),
    comparedRevisionId: readText("comparedRevisionId"),
    commitId: readText("commitId"),
    historicalAsOf: readText("historicalAsOf"),
    relationAsOf: readText("relationAsOf"),
    resourceItemId: readText("resourceItemId"),
    resourceRevisionId: readText("resourceRevisionId"),
    resourcePartialRevisionId: readText("resourcePartialRevisionId"),
    resourceRepairedRevisionId: readText("resourceRepairedRevisionId"),
    resourceId: readText("resourceId"),
    repairedResourceId: readText("repairedResourceId"),
    orphanResourceId: readText("orphanResourceId"),
    resourceMarkerItemId: readText("resourceMarkerItemId"),
    cliCascadeRootItemId: readText("cliCascadeRootItemId"),
    cliCascadeTargetItemId: readText("cliCascadeTargetItemId"),
  };
}

function archiveResponses(response: string): {
  readonly item: unknown;
  readonly historicalItem: unknown;
  readonly revision: unknown;
  readonly revisionDiff: unknown;
  readonly resourcePartialDiff: unknown;
  readonly resourceDiff: unknown;
  readonly resourceItem: unknown;
  readonly resourceMarkerItem: unknown;
  readonly sdkItem: unknown;
  readonly sdkResourceMetadata: {
    readonly resourceId: string;
    readonly mediaType: string;
    readonly size: number;
    readonly sha256: string;
  };
  readonly firstTimelinePage: unknown;
  readonly secondTimelinePage: unknown;
  readonly commit: unknown;
  readonly relationCommit: unknown;
  readonly relationPage: unknown;
  readonly relationTimelinePage: unknown;
} {
  const parsed: unknown = JSON.parse(response);
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.ok(
    "item" in parsed &&
      "revision" in parsed &&
      "revisionDiff" in parsed &&
      "resourcePartialDiff" in parsed &&
      "resourceDiff" in parsed &&
      "resourceItem" in parsed &&
      "resourceMarkerItem" in parsed &&
      "sdkItem" in parsed &&
      "sdkResourceMetadata" in parsed &&
      "historicalItem" in parsed &&
      "firstTimelinePage" in parsed &&
      "secondTimelinePage" in parsed &&
      "commit" in parsed &&
      "relationCommit" in parsed &&
      "relationPage" in parsed &&
      "relationTimelinePage" in parsed,
  );
  assert.ok(typeof parsed.sdkResourceMetadata === "object");
  assert.ok(parsed.sdkResourceMetadata !== null);
  assert.ok("resourceId" in parsed.sdkResourceMetadata);
  assert.ok("mediaType" in parsed.sdkResourceMetadata);
  assert.ok("size" in parsed.sdkResourceMetadata);
  assert.ok("sha256" in parsed.sdkResourceMetadata);
  return {
    item: parsed.item,
    historicalItem: parsed.historicalItem,
    revision: parsed.revision,
    revisionDiff: parsed.revisionDiff,
    resourcePartialDiff: parsed.resourcePartialDiff,
    resourceDiff: parsed.resourceDiff,
    resourceItem: parsed.resourceItem,
    resourceMarkerItem: parsed.resourceMarkerItem,
    sdkItem: parsed.sdkItem,
    sdkResourceMetadata: parsed.sdkResourceMetadata as {
      readonly resourceId: string;
      readonly mediaType: string;
      readonly size: number;
      readonly sha256: string;
    },
    firstTimelinePage: parsed.firstTimelinePage,
    secondTimelinePage: parsed.secondTimelinePage,
    commit: parsed.commit,
    relationCommit: parsed.relationCommit,
    relationPage: parsed.relationPage,
    relationTimelinePage: parsed.relationTimelinePage,
  };
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

async function verifyEmptyBinList(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/bins`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    readonly bins: readonly unknown[];
  };
  assert.deepEqual(payload.bins, []);

  const listed = cliData<{ readonly bins: readonly unknown[] }>(
    await cli(baseUrl, ["bin", "list"]),
    "listed",
  );
  assert.deepEqual(listed.bins, []);

  const text = await cli(baseUrl, ["bin", "list", "--output-format", "text"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /No bins configured\./u);
}

type HeldTableLock = {
  readonly release: () => Promise<void>;
};

type HeldArchiveItemLock = {
  readonly backendPid: number;
  readonly release: () => Promise<void>;
};

type ManualRunLockWaiter = {
  readonly pid: number;
  readonly blockers: readonly number[];
};

function postgresExecArgs(args: readonly string[]): readonly string[] {
  return [
    ...composePrefix(),
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-X",
    "-qAt",
    "-U",
    "binny",
    "-d",
    "binny",
    ...args,
  ];
}

async function holdTableShareLock(table: string): Promise<HeldTableLock> {
  assert.ok(
    table === "archive_resource" || table === "archive_revision_resource",
  );
  const lock = startManagedProcess("docker", postgresExecArgs([]));
  lock.write(
    `BEGIN;\nLOCK TABLE ${table} IN SHARE MODE;\nSELECT 'BINNY_RESOURCES_LOCK_HELD';\n`,
  );
  await lock.waitForMarker("BINNY_RESOURCES_LOCK_HELD");
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      lock.write("COMMIT;\n\\q\n");
      const result = await lock.waitForClose();
      assert.equal(result.code, 0, result.stderr);
    },
  };
}

async function holdArchiveItemReadLock(): Promise<HeldArchiveItemLock> {
  const lock = startManagedProcess("docker", postgresExecArgs([]));
  lock.write(
    "BEGIN;\nSELECT pg_backend_pid();\nLOCK TABLE archive_item IN ACCESS EXCLUSIVE MODE;\nSELECT 'BINNY_ARCHIVE_ITEM_READ_LOCK_HELD';\n",
  );
  await lock.waitForMarker("BINNY_ARCHIVE_ITEM_READ_LOCK_HELD");
  const backendPid = Number(lock.stdout().trim().split("\n")[0]);
  assert.ok(Number.isInteger(backendPid) && backendPid > 0);
  let released = false;
  return {
    backendPid,
    async release() {
      if (released) return;
      released = true;
      lock.write("COMMIT;\n\\q\n");
      const result = await lock.waitForClose();
      assert.equal(result.code, 0, result.stderr);
    },
  };
}

async function holdManualRunRowLock(runId: string): Promise<{
  readonly backendPid: number;
  readonly release: () => Promise<void>;
}> {
  assert.match(runId, /^[0-9a-f-]{36}$/u);
  const lock = startManagedProcess("docker", postgresExecArgs([]));
  lock.write(
    `BEGIN;\nSELECT pg_backend_pid();\nSELECT run_id FROM manual_runs WHERE run_id = '${runId}'::uuid FOR UPDATE;\nSELECT 'BINNY_LIFECYCLE_MANUAL_RUN_ROW_LOCK_HELD';\n`,
  );
  await lock.waitForMarker("BINNY_LIFECYCLE_MANUAL_RUN_ROW_LOCK_HELD");
  const backendPid = Number(lock.stdout().trim().split("\n")[0]);
  assert.ok(Number.isInteger(backendPid) && backendPid > 0);
  let released = false;
  return {
    backendPid,
    async release() {
      if (released) return;
      released = true;
      lock.write("COMMIT;\n\\q\n");
      const result = await lock.waitForClose();
      assert.equal(result.code, 0, result.stderr);
    },
  };
}

async function readManualRunLockWaiters(): Promise<
  readonly ManualRunLockWaiter[]
> {
  const result = await compose(
    postgresExecArgs([
      "-c",
      "SELECT json_build_object('pid', activity.pid, 'blockers', pg_blocking_pids(activity.pid)) FROM pg_stat_activity AS activity WHERE activity.datname = current_database() AND activity.wait_event_type = 'Lock';",
    ]).slice(composePrefix().length),
  );
  const output = result.stdout.trim();
  if (output.length === 0) return [];
  return output.split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    assert.ok(typeof value === "object" && value !== null);
    assert.ok("pid" in value && typeof value.pid === "number");
    assert.ok("blockers" in value && Array.isArray(value.blockers));
    assert.ok(value.blockers.every((pid: unknown) => typeof pid === "number"));
    return {
      pid: value.pid,
      blockers: value.blockers,
    };
  });
}

async function waitForManualRunLockWaiterBlockedBy(
  blockerPid: number,
  excludingPids: readonly number[] = [],
): Promise<number> {
  const waiter = await waitFor(
    async () =>
      (await readManualRunLockWaiters()).find(
        (candidate) =>
          !excludingPids.includes(candidate.pid) &&
          candidate.blockers.includes(blockerPid),
      ),
    (candidate) => candidate !== undefined,
    `PostgreSQL 行锁等待方被进程 ${String(blockerPid)} 阻塞`,
  );
  assert.ok(waiter !== undefined);
  return waiter.pid;
}

async function resourceFiles(): Promise<readonly string[]> {
  const result = await compose([
    "exec",
    "--no-TTY",
    "server",
    "node",
    "--input-type=module",
    "-e",
    'import { readdir } from "node:fs/promises"; process.stdout.write(JSON.stringify(await readdir("/var/lib/binny/resources")));',
  ]);
  const files: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(files));
  assert.ok(files.every((file) => typeof file === "string"));
  return files;
}

async function removeResourceStorageFile(resourceId: string): Promise<void> {
  assert.match(resourceId, /^[0-9a-f-]{36}$/iu);
  const keyResult = await compose(
    postgresExecArgs([
      "-c",
      `SELECT storage_key FROM archive_resource WHERE resource_id = '${resourceId.toLowerCase()}'::uuid;`,
    ]).slice(composePrefix().length),
  );
  const storageKey = keyResult.stdout.trim();
  assert.match(storageKey, /^[0-9a-f-]{36}$/u);
  const fileName = storageKey + ".bin";
  const beforeFiles = await resourceFiles();
  assert.ok(beforeFiles.includes(fileName));
  const filePath = "/var/lib/binny/resources/" + fileName;
  const script = [
    'import { stat, unlink } from "node:fs/promises";',
    `const file = ${JSON.stringify(filePath)};`,
    "const before = await stat(file);",
    "await unlink(file);",
    "process.stdout.write(String(before.size));",
  ].join("\n");
  const removal = await compose([
    "exec",
    "--no-TTY",
    "server",
    "node",
    "--input-type=module",
    "-e",
    script,
  ]);
  assert.ok(Number(removal.stdout) > 0);
  const afterFiles = await resourceFiles();
  assert.ok(!afterFiles.includes(fileName));
}

async function waitFor<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (isReady(latest)) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `等待 ${description} 超时，最近状态：${JSON.stringify(latest)}`,
  );
}

async function waitForBlockedTableWrite(
  table: "archive_resource" | "archive_revision_resource",
): Promise<void> {
  // 按关系 OID 观察未授予写锁，避免依赖 Drizzle 生成的标识符文本。
  const relationByTable = {
    archive_resource: "public.archive_resource",
    archive_revision_resource: "public.archive_revision_resource",
  } as const;
  await waitFor(
    async () => {
      const result = await compose(
        postgresExecArgs([
          "-c",
          `SELECT count(*) FROM pg_locks AS blocked INNER JOIN pg_stat_activity AS activity ON activity.pid = blocked.pid WHERE activity.datname = current_database() AND activity.wait_event_type = 'Lock' AND blocked.locktype = 'relation' AND blocked.relation = '${relationByTable[table]}'::regclass AND blocked.mode = 'RowExclusiveLock' AND NOT blocked.granted;`,
        ]).slice(composePrefix().length),
      );
      return Number(result.stdout.trim());
    },
    (count) => count > 0,
    `PostgreSQL 等待 ${table} 写锁`,
  );
}

async function restartServer(): Promise<string> {
  await compose(["up", "--detach", "--wait", "--wait-timeout", "90", "server"]);
  composePort = await publishedPort("server", 3000);
  return apiBaseUrl();
}

function resourceUploadProcess(): ManagedProcess {
  const program = [
    'const body = Buffer.from("binny-runs interrupted resource publish");',
    'process.stdout.write("BINNY_RESOURCES_UPLOAD_STARTED\\n");',
    'const response = await fetch("http://127.0.0.1:3000/resources", { method: "POST", headers: { "content-type": "application/octet-stream" }, body });',
    'process.stdout.write("BINNY_RESOURCES_UPLOAD_RESPONSE " + response.status + " " + await response.text() + "\\n");',
  ].join("\n");
  return startManagedProcess("docker", [
    ...composePrefix(),
    "exec",
    "--no-TTY",
    "server",
    "node",
    "--input-type=module",
    "-e",
    program,
  ]);
}

function archiveReferenceProcess(resourceId: string): ManagedProcess {
  assert.match(resourceId, /^[0-9a-f-]{36}$/u);
  const requestId = "e2e:resource-interrupted-reference:" + randomUUID();
  const sourceKey = "resource-interrupted-reference:" + randomUUID();
  const submission: ArchiveSubmissionInput = {
    requestId,
    binId: "binny-runs-one",
    relations: [],
    items: [
      {
        sourceKey: { namespace: "e2e", key: sourceKey },
        title: "Interrupted resource reference",
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        body: { text: "引用登记被进程中断" },
        extensions: {},
        resources: [{ resourceId }],
        capture: {
          scope: { case: "interrupted-resource-reference" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  };
  const request = JSON.stringify(submission);
  const program = [
    'process.stdout.write("BINNY_RESOURCES_REFERENCE_STARTED\\n");',
    `const response = await fetch("http://127.0.0.1:3000/archives", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(request)} });`,
    'process.stdout.write("BINNY_RESOURCES_REFERENCE_RESPONSE " + response.status + " " + await response.text() + "\\n");',
  ].join("\n");
  return startManagedProcess("docker", [
    ...composePrefix(),
    "exec",
    "--no-TTY",
    "server",
    "node",
    "--input-type=module",
    "-e",
    program,
  ]);
}

async function waitForUnreferencedResourceAge(): Promise<void> {
  const gracePeriodMs = Number(
    composeEnvironment().BINNY_RESOURCE_UNREFERENCED_AGE_MS,
  );
  await new Promise((resolveGrace) => setTimeout(resolveGrace, gracePeriodMs));
}

async function verifyResourceStorageInterruptions(
  baseUrl: string,
  archive: string,
): Promise<string> {
  let currentBaseUrl = baseUrl;
  const filesBeforePublish = await resourceFiles();
  let publishLock: HeldTableLock | undefined;
  let publishRequest: ManagedProcess | undefined;
  let publishServerNeedsRestart = false;
  try {
    publishLock = await holdTableShareLock("archive_resource");
    publishRequest = resourceUploadProcess();
    await publishRequest.waitForMarker("BINNY_RESOURCES_UPLOAD_STARTED");
    const publishedFiles = await waitFor(
      () => resourceFiles(),
      (files) => files.some((file) => !filesBeforePublish.includes(file)),
      "资源文件在登记前发布到持久目录",
    );
    const newPublishedFiles = publishedFiles.filter(
      (file) => !filesBeforePublish.includes(file),
    );
    assert.equal(newPublishedFiles.length, 1);
    const publishedFile = newPublishedFiles[0];
    assert.ok(publishedFile);
    await waitForBlockedTableWrite("archive_resource");
    assert.doesNotMatch(
      publishRequest.stdout(),
      /BINNY_RESOURCES_UPLOAD_RESPONSE/u,
    );

    await compose(["kill", "-s", "SIGKILL", "server"]);
    publishServerNeedsRestart = true;
    await publishLock.release();
    publishLock = undefined;
    const interruptedUpload = await publishRequest.waitForClose();
    assert.notEqual(interruptedUpload.code, 0);
    currentBaseUrl = await restartServer();
    publishServerNeedsRestart = false;
    await waitForApiAndDatabase(currentBaseUrl);
    const filesAfterPublishRecovery = await resourceFiles();
    assert.ok(!filesAfterPublishRecovery.includes(publishedFile));
  } finally {
    if (
      publishRequest !== undefined &&
      publishRequest.child.exitCode === null
    ) {
      if (!publishServerNeedsRestart) {
        await compose(["kill", "-s", "SIGKILL", "server"]);
        publishServerNeedsRestart = true;
      }
    }
    if (publishLock !== undefined) await publishLock.release();
    if (
      publishRequest !== undefined &&
      publishRequest.child.exitCode === null
    ) {
      await publishRequest.waitForClose();
    }
    if (publishServerNeedsRestart) currentBaseUrl = await restartServer();
  }

  const referenceBytes = new TextEncoder().encode(
    "binny-runs committed upload survives interrupted reference registration",
  );
  const uploadResponse = await fetch(currentBaseUrl + "/resources", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: referenceBytes,
  });
  assert.equal(uploadResponse.status, 201, await uploadResponse.clone().text());
  if (uploadResponse.status !== 201) {
    throw new Error("引用登记中断场景的资源上传没有提交成功。");
  }
  const uploaded = (await uploadResponse.json()) as {
    readonly resourceId: string;
  };
  let referenceLock: HeldTableLock | undefined;
  let referenceRequest: ManagedProcess | undefined;
  let referenceServerNeedsRestart = false;
  try {
    referenceLock = await holdTableShareLock("archive_revision_resource");
    referenceRequest = archiveReferenceProcess(uploaded.resourceId);
    await referenceRequest.waitForMarker("BINNY_RESOURCES_REFERENCE_STARTED");
    await waitForBlockedTableWrite("archive_revision_resource");
    assert.doesNotMatch(
      referenceRequest.stdout(),
      /BINNY_RESOURCES_REFERENCE_RESPONSE/u,
    );

    await compose(["kill", "-s", "SIGKILL", "server"]);
    referenceServerNeedsRestart = true;
    await referenceLock.release();
    referenceLock = undefined;
    const interruptedReference = await referenceRequest.waitForClose();
    assert.notEqual(interruptedReference.code, 0);
    currentBaseUrl = await restartServer();
    referenceServerNeedsRestart = false;
    await waitForApiAndDatabase(currentBaseUrl);
    const resourceRead = await fetch(
      currentBaseUrl + "/resources/" + uploaded.resourceId,
    );
    assert.equal(resourceRead.status, 200);
    assert.deepEqual(
      new Uint8Array(await resourceRead.arrayBuffer()),
      referenceBytes,
    );

    const archiveIdsValue = archiveIds(archive);
    const historicalResource = await fetch(
      currentBaseUrl + "/resources/" + archiveIdsValue.resourceId,
    );
    assert.equal(historicalResource.status, 200);
    assert.deepEqual(
      new Uint8Array(await historicalResource.arrayBuffer()),
      new TextEncoder().encode("binny media bytes v1"),
      "引用登记失败后的清理不能影响仍被历史版本引用的媒体。",
    );
  } finally {
    if (
      referenceRequest !== undefined &&
      referenceRequest.child.exitCode === null
    ) {
      if (!referenceServerNeedsRestart) {
        await compose(["kill", "-s", "SIGKILL", "server"]);
        referenceServerNeedsRestart = true;
      }
    }
    if (referenceLock !== undefined) await referenceLock.release();
    if (
      referenceRequest !== undefined &&
      referenceRequest.child.exitCode === null
    ) {
      await referenceRequest.waitForClose();
    }
    if (referenceServerNeedsRestart) currentBaseUrl = await restartServer();
  }

  await waitForUnreferencedResourceAge();
  return currentBaseUrl;
}

async function validateApiInput(): Promise<void> {
  const probe = [
    "(async () => {",
    'const bodies = [JSON.stringify({ identityId: 7 }), "{"];',
    'const responses = await Promise.all(bodies.map((body) => fetch("http://127.0.0.1:3000/bins/binny-runs-one", { method: "PATCH", headers: { "content-type": "application/json" }, body })));',
    "const results = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() })));",
    "process.stdout.write(JSON.stringify(results));",
    "})().catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("");
  const result = await run(
    "docker",
    [...composePrefix(), "exec", "--no-TTY", "server", "node", "-e", probe],
    { env: composeEnvironment() },
  );
  assert.equal(result.code, 0, result.stderr);
  const responses = JSON.parse(result.stdout) as readonly {
    readonly status: number;
    readonly body: {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly path?: readonly (string | number)[];
      };
    };
  }[];
  const invalidField = responses[0];
  const malformedJson = responses[1];
  assert.ok(invalidField !== undefined && malformedJson !== undefined);
  assert.equal(invalidField.status, 400);
  assert.equal(invalidField.body.error.code, "invalid_input");
  assert.deepEqual(invalidField.body.error.path, ["identityId"]);
  assert.match(invalidField.body.error.message, /字段|标识/u);
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.body.error.code, "invalid_input");
  assert.match(malformedJson.body.error.message, /JSON|格式/u);
}

async function createRuntimeFixtureManifest(): Promise<unknown> {
  const program = [
    'import { sourceAdapterManifest } from "@binny/source-adapter-sdk";',
    'import sourceAdapter from "./test/fixtures/manual-runs-source-adapter.ts";',
    "process.stdout.write(JSON.stringify(sourceAdapterManifest(sourceAdapter)));",
  ].join("\n");
  const result = await run("pnpm", [
    "--silent",
    "--filter",
    "@binny/source-adapter-runtime",
    "exec",
    "node",
    "--conditions=source",
    "--input-type=module",
    "-e",
    program,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRuntime(baseUrl: string, binId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = cliData<{
      readonly execution: { readonly status: string };
    }>(await cli(baseUrl, ["bin", "get", binId]), "found");
    if (result.execution.status === "online") return;
    await wait(100);
  }
  assert.fail(`bin ${binId} 的运行器没有上线。`);
}

async function waitForBinRegistration(
  baseUrl: string,
  binId: string,
): Promise<{
  readonly id: string;
  readonly sourceAdapterId: string;
  readonly sourceAdapterVersion: string;
  readonly identityId: string;
  readonly config: Record<string, unknown>;
  readonly execution: { readonly status: string };
  readonly sourceStateSnapshot: { readonly freshness: string };
}> {
  const deadline = Date.now() + 30_000;
  let lastResponse = "尚未查询。";
  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl}/bins/${encodeURIComponent(binId)}`,
    );
    if (response.status === 200) {
      const bin = (await response.json()) as {
        readonly id: string;
        readonly sourceAdapterId: string;
        readonly identityId: string;
        readonly config: Record<string, unknown>;
        readonly execution: { readonly status: string };
        readonly sourceStateSnapshot: { readonly freshness: string };
      };
      const schemaResponse = await fetch(
        `${baseUrl}/bins/${encodeURIComponent(binId)}/config-schema`,
      );
      if (schemaResponse.status !== 200) {
        lastResponse = `${schemaResponse.status} ${await schemaResponse.text()}`;
        await wait(100);
        continue;
      }
      const declaration = (await schemaResponse.json()) as {
        readonly sourceAdapterId: string;
        readonly sourceAdapterVersion: string;
      };
      assert.equal(declaration.sourceAdapterId, bin.sourceAdapterId);
      return {
        ...bin,
        sourceAdapterVersion: declaration.sourceAdapterVersion,
      };
    }
    lastResponse = `${response.status} ${await response.text()}`;
    if (response.status !== 404) throw new Error(lastResponse);
    await wait(100);
  }
  throw new Error(`运行器没有自动登记 bin ${binId}：${lastResponse}`);
}

type RssRequestRecord = {
  readonly path: string;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
};

type RssControlState = {
  readonly requests: readonly RssRequestRecord[];
  readonly photoBytes: string;
  readonly audioBytes: string;
  readonly articleVersion: number;
  readonly documentVersion: number;
  readonly heldFeedPath?: string;
};

type RssControlSource = {
  readonly baseUrl: string;
  readonly requests: () => Promise<readonly RssRequestRecord[]>;
  readonly mediaBytes: () => Promise<{
    readonly photoBytes: Buffer;
    readonly audioBytes: Buffer;
  }>;
  readonly setRssVersion: (version: number) => Promise<void>;
  readonly setAtomVersion: (version: number) => Promise<void>;
  readonly setArticleVersion: (version: 1 | 2) => Promise<void>;
  readonly setDocumentVersion: (version: 1 | 2) => Promise<void>;
  readonly setAtomTextMode: (mode: "text" | "html") => Promise<void>;
  readonly setTemporaryAvailable: (available: boolean) => Promise<void>;
  readonly setPhotoAvailable: (available: boolean) => Promise<void>;
  readonly holdFeed: (pathname: string) => Promise<void>;
  readonly waitUntilFeedHeld: (pathname: string) => Promise<void>;
  readonly releaseFeed: () => Promise<void>;
};

async function createRssControlSource(port: number): Promise<RssControlSource> {
  const host = process.env.BINNY_E2E_HOST ?? "172.17.0.1";
  const controlUrl = `http://${host}:${String(port)}`;
  const baseUrl = "http://rss-e2e-source:8081";

  async function readState(): Promise<RssControlState> {
    const response = await fetch(controlUrl + "/control/state", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as RssControlState;
  }

  async function updateState(
    value: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const response = await fetch(controlUrl + "/control/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
  }

  const deadline = Date.now() + 30_000;
  let ready = false;
  let lastFailure = "受控信源 Compose 服务尚未启动。";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(controlUrl + "/health", {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        ready = true;
        break;
      }
      lastFailure = `受控信源返回 HTTP ${String(response.status)}。`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await wait(100);
  }
  assert.ok(ready, `受控信源没有在 Compose 随机宿主端口就绪：${lastFailure}`);
  await readState();

  return {
    baseUrl,
    async requests() {
      return (await readState()).requests;
    },
    async mediaBytes() {
      const current = await readState();
      return {
        photoBytes: Buffer.from(current.photoBytes, "base64"),
        audioBytes: Buffer.from(current.audioBytes, "base64"),
      };
    },
    async setRssVersion(version) {
      await updateState({ rssVersion: version });
    },
    async setAtomVersion(version) {
      await updateState({ atomVersion: version });
    },
    async setArticleVersion(version) {
      await updateState({ articleVersion: version });
    },
    async setDocumentVersion(version) {
      await updateState({ documentVersion: version });
    },
    async setAtomTextMode(mode) {
      await updateState({ atomTextMode: mode });
    },
    async setTemporaryAvailable(available) {
      await updateState({ temporaryAvailable: available });
    },
    async setPhotoAvailable(available) {
      await updateState({ photoAvailable: available });
    },
    async holdFeed(pathname) {
      await updateState({ holdFeedPath: pathname });
    },
    async waitUntilFeedHeld(pathname) {
      await waitFor(
        readState,
        (state) => state.heldFeedPath === pathname,
        `受控 RSS 信源暂存 ${pathname} 响应`,
      );
    },
    async releaseFeed() {
      const response = await fetch(controlUrl + "/control/release-feed", {
        method: "POST",
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(response.status, 200);
    },
  };
}

type ManualActionOutput = {
  readonly availability?: "available" | "unavailable" | "unknown";
  readonly scope?: readonly string[];
  readonly basis?: string;
  readonly completedScopes?: readonly string[];
  readonly collectionCompleteness?: "complete" | "partial";
  readonly incompleteScopes?: readonly {
    readonly scope: string;
    readonly reasonCode: string;
    readonly message: string;
  }[];
  readonly problems?: readonly {
    readonly code: string;
    readonly message?: string;
    readonly suggestion?: string;
    readonly requiresHuman?: boolean;
  }[];
};

function runOutput(run: { readonly result?: { readonly output?: unknown } }) {
  return run.result?.output as ManualActionOutput | undefined;
}

type RssManualRun = {
  readonly status: string;
  readonly runId: string;
  readonly binId: string;
  readonly stopConfirmedAt?: string;
  readonly finishedAt?: string;
  readonly result?: {
    readonly completedScopes: readonly string[];
    readonly output?: ManualActionOutput;
    readonly commits: readonly {
      readonly commitId: string;
      readonly items: readonly { readonly itemId: string }[];
    }[];
    readonly stopReason: { readonly code: string };
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly suggestion?: string;
    };
  };
};

async function createRssManifest(): Promise<unknown> {
  const program = [
    'import { sourceAdapterManifest } from "@binny/source-adapter-sdk";',
    'import sourceAdapter from "@binny/source-adapter-rss";',
    "process.stdout.write(JSON.stringify(sourceAdapterManifest(sourceAdapter)));",
  ].join("\n");
  const result = await run("pnpm", [
    "--silent",
    "--filter",
    "@binny/source-adapter-rss",
    "exec",
    "node",
    "--conditions=source",
    "--input-type=module",
    "-e",
    program,
  ]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout) as unknown;
}

async function linuxdoRuntimeManifest(
  service = "runtime-linuxdo",
): Promise<unknown> {
  await waitForLinuxdoRuntimeHealth(service);
  const result = await compose([
    "exec",
    "--no-TTY",
    service,
    "node",
    "--input-type=module",
    "-e",
    'const response=await fetch("http://127.0.0.1:8080/manifest"); if(!response.ok)process.exit(1); const payload=await response.json(); if(!payload.sourceAdapter)process.exit(1); console.log(JSON.stringify(payload.sourceAdapter));',
  ]);
  return JSON.parse(result.stdout) as unknown;
}

async function waitForLinuxdoRuntimeHealth(
  service = "runtime-linuxdo",
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let latest = "Linux.do 浏览器运行器尚未就绪。";
  while (Date.now() < deadline) {
    const result = await run(
      "docker",
      [
        ...composePrefix(),
        "exec",
        "--no-TTY",
        service,
        "node",
        "--input-type=module",
        "-e",
        'const response=await fetch("http://127.0.0.1:8080/health"); if(!response.ok)process.exit(1);',
      ],
      { env: composeEnvironment() },
    );
    if (result.code === 0) return;
    latest = result.stderr + result.stdout;
    await wait(250);
  }
  throw new Error(`Linux.do 正式浏览器运行器没有就绪：\n${latest}`);
}

async function createLinuxdoBin(
  baseUrl: string,
  binId = "binny-integration-linuxdo",
  service = "runtime-linuxdo",
  identityId = "binny-integration-profile",
): Promise<void> {
  const registered = await waitForBinRegistration(baseUrl, binId);
  const runtimeManifest = await linuxdoRuntimeManifest(service);
  assert.equal(
    registered.sourceAdapterVersion,
    rssManifestVersion(runtimeManifest),
  );
  const configured = cliData<{ readonly id: string }>(
    await cli(baseUrl, [
      "bin",
      "update",
      binId,
      "--identity",
      identityId,
      "--config",
      JSON.stringify({ origin: "http://linuxdo-e2e-source:8081" }),
    ]),
    "updated",
  );
  assert.equal(configured.id, binId);
  await waitForRuntime(baseUrl, binId);

  const summaries = await fetch(`${baseUrl}/bins`);
  assert.equal(summaries.status, 200);
  const list = (await summaries.json()) as {
    readonly bins: readonly {
      readonly id: string;
      readonly sourceAdapterId: string;
      readonly [key: string]: unknown;
    }[];
  };
  const listed = list.bins.find((entry) => entry.id === binId);
  assert.ok(listed !== undefined);
  assert.equal(listed.sourceAdapterId, "binny.source-adapter-linuxdo");
  assert.equal(Object.hasOwn(listed, "sourceAdapter"), false);
  assert.equal(Object.hasOwn(listed, "configSchema"), false);
  assert.equal(Object.hasOwn(listed, "actions"), false);

  const details = cliData<{
    readonly sourceAdapterId: string;
    readonly execution: { readonly status: string };
    readonly sourceStateSnapshot: { readonly freshness: string };
    readonly [key: string]: unknown;
  }>(await cli(baseUrl, ["bin", "get", binId]), "found");
  assert.equal(details.sourceAdapterId, "binny.source-adapter-linuxdo");
  assert.equal(Object.hasOwn(details, "sourceAdapter"), false);
  assert.equal(Object.hasOwn(details, "persistentState"), false);
  assert.equal(Object.hasOwn(details, "sync"), false);

  const configuration = cliData<{
    readonly sourceAdapterId: string;
    readonly sourceAdapterVersion: string;
    readonly configSchema: unknown;
  }>(await cli(baseUrl, ["bin", "config-schema", binId]), "discovered");
  assert.equal(configuration.sourceAdapterId, "binny.source-adapter-linuxdo");
  assert.equal(
    configuration.sourceAdapterVersion,
    registered.sourceAdapterVersion,
  );
  assert.ok(JSON.stringify(configuration.configSchema).length > 500);

  const actions = cliData<{
    readonly actions: Readonly<
      Record<string, { readonly description: string }>
    >;
  }>(await cli(baseUrl, ["bin", "actions", binId]), "discovered");
  assert.ok("collect" in actions.actions);
  assert.equal("params" in actions.actions.collect!, false);
  const collect = cliData<{
    readonly actions: Readonly<
      Record<
        string,
        {
          readonly description: string;
          readonly params: unknown;
          readonly output: unknown;
          readonly report?: unknown;
        }
      >
    >;
  }>(await cli(baseUrl, ["bin", "actions", binId, "collect"]), "discovered");
  assert.ok(collect.actions.collect?.params !== undefined);
  assert.ok(collect.actions.collect?.output !== undefined);
  assert.ok(collect.actions.collect?.report !== undefined);
  const collectText = await cli(baseUrl, [
    "bin",
    "actions",
    binId,
    "collect",
    "--output-format",
    "text",
  ]);
  assert.equal(collectText.code, 0, collectText.stderr);
  assert.match(collectText.stdout, /Parameters:/u);
  assert.match(collectText.stdout, /Output:/u);
  assert.match(collectText.stdout, /Report:/u);
}

const linuxdoTargetDefinitions = {
  latest: { id: "latest", kind: "latest" },
  category: {
    id: "category",
    kind: "category",
    categoryId: 42,
    categorySlugPath: "controlled",
  },
  pinned: { id: "pinned", kind: "topic", topicId: 2401 },
} as const;

function linuxdoTargets(...ids: (keyof typeof linuxdoTargetDefinitions)[]) {
  return ids.map((id) => linuxdoTargetDefinitions[id]);
}

async function collectLinuxdoOnSchedule(
  baseUrl: string,
  sourceControlUrl: string,
  binId: string,
  rootItemId: string,
  previousRunId: string,
): Promise<ManualRunCliState> {
  const sourceTopicReadCount = async (): Promise<number> => {
    const response = await fetch(sourceControlUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    const value = (await response.json()) as {
      readonly events: readonly {
        readonly action: string;
        readonly path: string;
        readonly authenticated?: boolean;
      }[];
    };
    return value.events.filter(
      (event) =>
        event.action === "topic" &&
        event.path === "/t/2401.json" &&
        event.authenticated === true,
    ).length;
  };
  const readsBefore = await sourceTopicReadCount();
  const created = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      binId,
      "--expression",
      "*/10 * * * * *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({
        topicId: 2401,
        date: "2026-10-28",
        timeZone: "UTC",
      }),
    ]),
    "created",
  );
  assert.equal(created.enabled, true);
  const scheduledFor = created.nextDueAt;
  const dueTimestamp = Date.parse(scheduledFor);
  assert.ok(dueTimestamp > Date.now());

  const advanced = await waitFor(
    async () =>
      cliData<{ readonly nextDueAt: string }>(
        await cli(baseUrl, ["schedule", "get", binId, created.scheduleId]),
        "found",
      ),
    (schedule) => Date.parse(schedule.nextDueAt) > dueTimestamp,
    "Linux.do 主题采集计划到期并推进",
  );
  assert.ok(Date.parse(advanced.nextDueAt) > dueTimestamp);
  cliData(
    await cli(baseUrl, ["schedule", "disable", binId, created.scheduleId]),
    "disabled",
  );

  const currentRoot = await waitFor(
    async () => {
      const item = cliData<{
        readonly views: readonly {
          readonly binId: string;
          readonly revisionId: string;
          readonly runId?: string;
          readonly state: {
            readonly body?: {
              readonly html?: string;
              readonly markdown?: string;
            };
          };
        }[];
      }>(
        await cli(baseUrl, ["archive", "item", rootItemId, "--bin", binId]),
        "found",
      );
      return item.views.find((view) => view.binId === binId);
    },
    (view) =>
      view?.runId !== undefined &&
      view.runId !== previousRunId &&
      (view.state.body?.markdown ?? "").includes("主题正文版本 2"),
    "计划采集提交 Linux.do 主题更新",
  );
  assert.ok(currentRoot !== undefined);
  const scheduledRunId = currentRoot.runId;
  assert.ok(scheduledRunId !== undefined);
  const scheduledRun = await waitFor(
    async () =>
      cliData<ManualRunCliState>(
        await cli(baseUrl, ["run", "get", binId, scheduledRunId]),
        "found",
      ),
    (runState) =>
      runState.status === "completed" || runState.status === "failed",
    "计划 Linux.do 运行终结",
  );
  assert.equal(scheduledRun.status, "completed");
  assert.equal(scheduledRun.action, "collect");
  assert.equal(scheduledRun.trigger.kind, "schedule");
  if (scheduledRun.trigger.kind === "schedule") {
    assert.equal(scheduledRun.trigger.scheduleId, created.scheduleId);
    assert.equal(scheduledRun.trigger.scheduledFor, scheduledFor);
  }
  assert.ok(
    scheduledRun.result?.commits.some(({ items }) =>
      items.some(({ itemId }) => itemId === rootItemId),
    ),
  );
  assert.ok((await sourceTopicReadCount()) > readsBefore);
  cliData(
    await cli(baseUrl, ["schedule", "remove", binId, created.scheduleId]),
    "removed",
  );
  return scheduledRun;
}

async function verifyLinuxdoArchiveJourney(
  baseUrl: string,
  sourceControlUrl: string,
  journey: LinuxdoUserJourney,
  rss: RssAcceptanceResult,
): Promise<void> {
  const binId = "binny-integration-linuxdo";
  const namespace = "linuxdo:linuxdo-e2e-source:8081";
  const cliForLinuxdo = (args: readonly string[]) => cli(baseUrl, args);
  assert.equal(journey.firstCollection.status, "completed");
  assert.ok(
    runOutput(journey.firstCollection)?.completedScopes?.includes("topic:2401"),
  );

  const readCollectedItem = async (sourceKey: string) => {
    for (const itemId of journey.itemIds) {
      const item = cliData<{
        readonly itemId: string;
        readonly sourceKey: {
          readonly namespace: string;
          readonly key: string;
        };
      }>(
        await cliForLinuxdo(["archive", "item", itemId, "--bin", binId]),
        "found",
      );
      if (
        item.sourceKey.namespace === namespace &&
        item.sourceKey.key === sourceKey
      ) {
        return item;
      }
    }
    assert.fail("Initial Linux.do run did not return " + sourceKey + ".");
  };

  const rssItem = cliData<{
    readonly itemId: string;
    readonly views: readonly {
      readonly binId: string;
      readonly revisionId: string;
      readonly state: {
        readonly capture: { readonly completeness: string };
      };
    }[];
  }>(await cli(baseUrl, ["archive", "item", rss.itemId]), "found");
  assert.equal(rssItem.itemId, rss.itemId);
  const rssBinIds = new Set<string>(rss.binIds);
  assert.deepEqual(
    rssItem.views
      .filter(({ binId: viewBinId }) => rssBinIds.has(viewBinId))
      .map(({ binId: viewBinId }) => viewBinId)
      .toSorted(),
    [...rss.binIds].toSorted(),
  );
  assert.equal(
    rssItem.views.find(({ binId: viewBinId }) => viewBinId === "binny-rss-one")
      ?.state.capture.completeness,
    "partial",
  );
  assert.equal(
    rssItem.views.find(({ binId: viewBinId }) => viewBinId === "binny-rss-two")
      ?.state.capture.completeness,
    "complete",
  );
  const initialRssRevision = cliData<{
    readonly revisionId: string;
    readonly itemId: string;
  }>(
    await cli(baseUrl, ["archive", "revision", rss.initialRevisionId]),
    "found",
  );
  assert.equal(initialRssRevision.itemId, rss.itemId);
  const latestRssPartial = cliData<{
    readonly revisionId: string;
    readonly itemId: string;
    readonly state: {
      readonly capture: { readonly completeness: string };
    };
  }>(
    await cli(baseUrl, ["archive", "revision", rss.latestPartialRevisionId]),
    "found",
  );
  assert.equal(latestRssPartial.itemId, rss.itemId);
  assert.equal(latestRssPartial.state.capture.completeness, "partial");
  const rssCommit = cliData<{
    readonly commitId: string;
    readonly binId: string;
    readonly runId: string;
    readonly items: readonly { readonly itemId: string }[];
  }>(await cli(baseUrl, ["archive", "commit", rss.commitId]), "found");
  assert.equal(rssCommit.binId, "binny-rss-one");
  assert.equal(rssCommit.runId, rss.initialRunId);
  assert.ok(rssCommit.items.some(({ itemId }) => itemId === rss.itemId));
  const rssDiff = cliData<{
    readonly hasChanges: boolean;
    readonly firstRevisionId: string;
    readonly secondRevisionId: string;
  }>(
    await cli(baseUrl, [
      "archive",
      "diff",
      rss.initialRevisionId,
      rss.latestPartialRevisionId,
    ]),
    "found",
  );
  assert.equal(rssDiff.hasChanges, true);
  assert.equal(rssDiff.firstRevisionId, rss.initialRevisionId);
  assert.equal(rssDiff.secondRevisionId, rss.latestPartialRevisionId);
  for (const resourceId of rss.resourceIds) {
    const response = await fetch(`${baseUrl}/resources/${resourceId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  for (const resourceId of rss.latestPartialResourceIds) {
    const response = await fetch(`${baseUrl}/resources/${resourceId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }

  const rootLocator = await readCollectedItem("post:240001");
  const rootItemId = rootLocator.itemId;
  assert.ok(journey.itemIds.includes(rootItemId));
  const rootItem = cliData<{
    readonly itemId: string;
    readonly sourceKey: { readonly namespace: string; readonly key: string };
    readonly views: readonly {
      readonly binId: string;
      readonly revisionId: string;
      readonly state: {
        readonly title: string | null;
        readonly sourcePublishedAt: ArchiveSourceTimeRead | null;
        readonly sourceModifiedAt: ArchiveSourceTimeRead | null;
        readonly extensions: {
          readonly topicId: number;
          readonly postNumber: number;
          readonly categoryId: number | null;
          readonly tags: readonly string[];
          readonly authorUsername: string | null;
          readonly authorName: string | null;
          readonly topic: {
            readonly slug: string | null;
            readonly createdAt: string | null;
            readonly title?: string;
          };
        };
        readonly body?: {
          readonly html?: string;
          readonly markdown?: string;
        };
        readonly resources?: readonly { readonly resourceId: string }[];
        readonly capture: {
          readonly completeness: "complete" | "partial";
          readonly missing: readonly { readonly path: string }[];
        };
      };
    }[];
    readonly revisions: readonly { readonly revisionId: string }[];
  }>(
    await cliForLinuxdo(["archive", "item", rootItemId, "--bin", binId]),
    "found",
  );
  assert.equal(rootItem.sourceKey.namespace, namespace);
  assert.equal(rootItem.sourceKey.key, "post:240001");
  const originalRootView = rootItem.views.find(
    ({ binId: viewBinId }) => viewBinId === binId,
  );
  assert.ok(originalRootView !== undefined);
  assert.equal(originalRootView.state.capture.completeness, "complete");
  const originalRootState = originalRootView.state;
  assert.equal(originalRootState.title, "受控主题标题版本 1");
  assert.deepEqual(originalRootState.sourcePublishedAt, {
    precision: "instant",
    value: "2026-10-28T01:00:00.000Z",
  });
  assert.deepEqual(originalRootState.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T00:00:01.000Z",
  });
  assert.equal(originalRootState.extensions.topicId, 2401);
  assert.equal(originalRootState.extensions.postNumber, 1);
  assert.equal(originalRootState.extensions.categoryId, 42);
  assert.deepEqual(originalRootState.extensions.tags, ["受控", "归档"]);
  assert.equal(originalRootState.extensions.authorUsername, "fixture-author");
  assert.equal(originalRootState.extensions.authorName, "Linux.do 示例作者");
  assert.deepEqual(originalRootState.extensions.topic, {
    slug: "controlled-linuxdo-topic",
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  const firstReplyLocator = await readCollectedItem("post:240002");
  const firstReplyItemId = firstReplyLocator.itemId;
  assert.ok(journey.itemIds.includes(firstReplyItemId));
  const firstReplyItem = cliData<typeof rootItem>(
    await cliForLinuxdo(["archive", "item", firstReplyItemId, "--bin", binId]),
    "found",
  );
  const firstReplyView = firstReplyItem.views.find(
    ({ binId: viewBinId }) => viewBinId === binId,
  );
  assert.ok(firstReplyView !== undefined);
  assert.equal(firstReplyItem.sourceKey.key, "post:240002");
  assert.equal(firstReplyView.state.title, null);
  assert.deepEqual(firstReplyView.state.sourcePublishedAt, {
    precision: "instant",
    value: "2026-10-28T02:00:00.000Z",
  });
  assert.deepEqual(firstReplyView.state.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T01:00:01.000Z",
  });
  assert.equal(firstReplyView.state.extensions.topicId, 2401);
  assert.equal(firstReplyView.state.extensions.postNumber, 2);
  assert.equal(
    firstReplyView.state.extensions.topic.title,
    "受控主题标题版本 1",
  );
  const firstRunCommitLocator = journey.firstCollection.result?.commits?.find(
    ({ items }) => items.some(({ itemId }) => itemId === rootItemId),
  );
  assert.ok(firstRunCommitLocator !== undefined);
  const firstCommit = cliData<{
    readonly commitId: string;
    readonly archiveSeq: string;
    readonly binId: string;
    readonly runId: string;
    readonly sourceAdapterVersion: string;
    readonly items: readonly {
      readonly itemId: string;
      readonly revisionId: string;
      readonly sourceKey: { readonly key: string };
    }[];
  }>(
    await cliForLinuxdo(["archive", "commit", firstRunCommitLocator.commitId]),
    "found",
  );
  assert.equal(firstCommit.binId, binId);
  assert.equal(firstCommit.runId, journey.firstCollection.runId);
  assert.ok(firstCommit.sourceAdapterVersion.length > 0);
  assert.ok(firstCommit.items.some(({ itemId }) => itemId === rootItemId));
  const firstCommitItem = firstCommit.items.find(
    ({ itemId }) => itemId === rootItemId,
  );
  assert.ok(firstCommitItem !== undefined);
  assert.equal(firstCommitItem.revisionId, originalRootView.revisionId);
  const firstRevisionId = firstCommitItem.revisionId;
  const firstRevision = cliData<{
    readonly revisionId: string;
    readonly itemId: string;
    readonly state: {
      readonly body?: {
        readonly html?: string;
        readonly markdown?: string;
      };
      readonly resources?: readonly { readonly resourceId: string }[];
      readonly capture: { readonly completeness: string };
    };
  }>(await cliForLinuxdo(["archive", "revision", firstRevisionId]), "found");
  assert.equal(firstRevision.itemId, rootItemId);
  assert.equal(firstRevision.state.capture.completeness, "complete");
  assert.equal(firstRevision.state.body?.html, undefined);
  assert.match(firstRevision.state.body?.markdown ?? "", /主题正文版本 1/u);
  const firstResourceIds =
    firstRevision.state.resources?.map(({ resourceId }) => resourceId) ?? [];
  assert.ok(firstResourceIds.length === 3);
  let photoResourceId: string | undefined;
  for (const resourceId of firstResourceIds) {
    const response = await fetch(`${baseUrl}/resources/${resourceId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.byteLength > 0);
    if (response.headers.get("content-type")?.startsWith("image/png"))
      photoResourceId = resourceId;
  }
  assert.ok(photoResourceId !== undefined);

  const discoveryCheck = await triggerLinuxdoRun(
    cliForLinuxdo,
    binId,
    "check",
    { targets: linuxdoTargets("latest") },
  );
  assert.equal(discoveryCheck.status, "completed");
  assert.equal(runOutput(discoveryCheck)?.availability, "available");
  assert.deepEqual(runOutput(discoveryCheck)?.scope, ["target:latest"]);
  assert.equal(discoveryCheck.result?.commits?.length ?? 0, 0);
  const discoveryCollection = await triggerLinuxdoRun(
    cliForLinuxdo,
    binId,
    "collect",
    {
      targets: linuxdoTargets("latest"),
      maxTopics: 1,
      date: "2026-10-28",
      timeZone: "UTC",
    },
  );
  assert.equal(discoveryCollection.status, "completed");
  const discoveryOutput = runOutput(discoveryCollection);
  assert.equal(discoveryOutput?.collectionCompleteness, "partial");
  assert.ok(
    discoveryOutput?.incompleteScopes?.some(
      ({ scope, reasonCode }) =>
        scope === "target:latest" && reasonCode === "topic_limit_reached",
    ),
  );
  assert.ok(discoveryOutput?.completedScopes?.includes("topic:2401"));
  assert.ok(discoveryOutput?.completedScopes?.includes("post:240001"));
  const discoveryCommitLocator = discoveryCollection.result?.commits?.find(
    ({ items }) => items.some(({ itemId }) => itemId === rootItemId),
  );
  assert.ok(discoveryCommitLocator !== undefined);
  const discoveryCommit = cliData<{
    readonly binId: string;
    readonly runId: string;
    readonly items: readonly { readonly itemId: string }[];
  }>(
    await cliForLinuxdo(["archive", "commit", discoveryCommitLocator.commitId]),
    "found",
  );
  assert.equal(discoveryCommit.binId, binId);
  assert.equal(discoveryCommit.runId, discoveryCollection.runId);
  assert.ok(discoveryCommit.items.some(({ itemId }) => itemId === rootItemId));

  const fixtureUpdate = await fetch(sourceControlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topicVersion: 2,
      replyVersion: 2,
      addedReply: true,
    }),
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(fixtureUpdate.status, 200, await fixtureUpdate.text());
  const secondCollection = await collectLinuxdoOnSchedule(
    baseUrl,
    sourceControlUrl,
    binId,
    rootItemId,
    discoveryCollection.runId,
  );
  assert.equal(secondCollection.status, "completed");
  assert.ok(
    runOutput(secondCollection)?.completedScopes?.includes("topic:2401"),
  );
  const updatedItem = cliData<typeof rootItem>(
    await cliForLinuxdo(["archive", "item", rootItemId, "--bin", binId]),
    "found",
  );
  const updatedRootView = updatedItem.views.find(
    ({ binId: viewBinId }) => viewBinId === binId,
  );
  assert.ok(updatedRootView !== undefined);
  assert.equal(updatedRootView.state.capture.completeness, "complete");
  assert.equal(updatedRootView.state.title, "受控主题标题版本 2");
  assert.deepEqual(updatedRootView.state.sourcePublishedAt, {
    precision: "instant",
    value: "2026-10-28T01:00:00.000Z",
  });
  assert.deepEqual(updatedRootView.state.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T00:00:02.000Z",
  });
  assert.match(updatedRootView.state.body?.markdown ?? "", /主题正文版本 2/u);
  assert.equal("title" in updatedRootView.state.extensions.topic, false);
  assert.ok(updatedItem.revisions.length >= 2);
  assert.notEqual(updatedRootView.revisionId, firstRevisionId);
  const updatedReplyItem = cliData<typeof rootItem>(
    await cliForLinuxdo(["archive", "item", firstReplyItemId, "--bin", binId]),
    "found",
  );
  const updatedReplyView = updatedReplyItem.views.find(
    ({ binId: viewBinId }) => viewBinId === binId,
  );
  assert.ok(updatedReplyView !== undefined);
  assert.equal(updatedReplyView.state.title, null);
  assert.deepEqual(updatedReplyView.state.sourcePublishedAt, {
    precision: "instant",
    value: "2026-10-28T02:00:00.000Z",
  });
  assert.deepEqual(updatedReplyView.state.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T01:00:02.000Z",
  });
  assert.equal(
    updatedReplyView.state.extensions.topic.title,
    "受控主题标题版本 2",
  );
  assert.match(updatedReplyView.state.body?.markdown ?? "", /回复正文版本 2/u);
  const secondRunCommitLocator = secondCollection.result?.commits?.find(
    ({ items }) => items.some(({ itemId }) => itemId === rootItemId),
  );
  assert.ok(secondRunCommitLocator !== undefined);
  const secondCommit = cliData<typeof firstCommit>(
    await cliForLinuxdo(["archive", "commit", secondRunCommitLocator.commitId]),
    "found",
  );
  assert.equal(secondCommit.binId, binId);
  assert.equal(secondCommit.runId, secondCollection.runId);
  const secondCommitItem = secondCommit.items.find(
    ({ itemId }) => itemId === rootItemId,
  );
  assert.ok(secondCommitItem !== undefined);
  const secondRevisionId = secondCommitItem.revisionId;

  const partialUpdate = await fetch(sourceControlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topicVersion: 3,
      unavailableMedia: ["/uploads/default/original/2X/topic-photo.png"],
      unavailableMediaStatus: 503,
    }),
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(partialUpdate.status, 200, await partialUpdate.text());
  const partialCollection = await triggerLinuxdoRun(
    cliForLinuxdo,
    binId,
    "collect",
    { topicId: 2401, date: "2026-10-28", timeZone: "UTC" },
  );
  assert.equal(partialCollection.status, "completed");
  assert.equal(
    runOutput(partialCollection)?.completedScopes?.includes("topic:2401"),
    false,
  );
  const partialItem = cliData<typeof rootItem>(
    await cliForLinuxdo(["archive", "item", rootItemId, "--bin", binId]),
    "found",
  );
  const partialRootView = partialItem.views.find(
    ({ binId: viewBinId }) => viewBinId === binId,
  );
  assert.ok(partialRootView !== undefined);
  assert.equal(partialRootView.state.capture.completeness, "partial");
  assert.equal(partialRootView.state.title, "受控主题标题版本 3");
  assert.deepEqual(partialRootView.state.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T00:00:03.000Z",
  });
  assert.match(partialRootView.state.body?.markdown ?? "", /主题正文版本 3/u);
  assert.ok(
    partialRootView.state.capture.missing.some(
      ({ path }) => path === "body.images[0]",
    ),
  );
  assert.equal(partialRootView.state.resources?.length, 2);
  const partialRunCommitLocator = partialCollection.result?.commits?.find(
    ({ items }) => items.some(({ itemId }) => itemId === rootItemId),
  );
  assert.ok(partialRunCommitLocator !== undefined);
  const partialCommit = cliData<typeof firstCommit>(
    await cliForLinuxdo([
      "archive",
      "commit",
      partialRunCommitLocator.commitId,
    ]),
    "found",
  );
  assert.equal(partialCommit.runId, partialCollection.runId);
  const partialCommitItem = partialCommit.items.find(
    ({ itemId }) => itemId === rootItemId,
  );
  assert.ok(partialCommitItem !== undefined);
  const partialRevisionId = partialCommitItem.revisionId;
  const previousPhoto = await fetch(`${baseUrl}/resources/${photoResourceId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(previousPhoto.status, 200);
  assert.ok((await previousPhoto.arrayBuffer()).byteLength > 0);
  const linuxdoDiff = cliData<{
    readonly itemId: string;
    readonly hasChanges: boolean;
    readonly fields: { readonly body: { readonly status: string } };
    readonly resources: {
      readonly added: readonly string[];
      readonly removed: readonly string[];
    };
  }>(
    await cliForLinuxdo([
      "archive",
      "diff",
      firstRevisionId,
      partialRevisionId,
    ]),
    "found",
  );
  assert.equal(linuxdoDiff.itemId, rootItemId);
  assert.equal(linuxdoDiff.hasChanges, true);
  assert.equal(linuxdoDiff.fields.body.status, "changed");
  assert.ok(linuxdoDiff.resources.removed.includes(photoResourceId));

  const relationPage = cliData<{
    readonly relations: readonly {
      readonly status: string;
      readonly state?: {
        readonly name: string;
        readonly cascade: boolean;
        readonly to: { readonly sourceKey?: { readonly key: string } };
      };
    }[];
  }>(
    await cliForLinuxdo([
      "archive",
      "relations",
      rootItemId,
      "--bin",
      binId,
      "--direction",
      "outgoing",
      "--limit",
      "100",
    ]),
    "found",
  );
  assert.equal(relationPage.relations.length, 3);
  assert.deepEqual(
    relationPage.relations
      .map(({ state }) => state?.to.sourceKey?.key)
      .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["post:240002", "post:240003", "post:240004"],
  );
  assert.ok(
    relationPage.relations.every(
      ({ status, state }) =>
        status === "observed" && state?.name === "topic_reply" && state.cascade,
    ),
  );
  const timeline = cliData<{
    readonly events: readonly {
      readonly kind: string;
      readonly commitId: string;
      readonly runId?: string;
      readonly itemId?: string;
    }[];
  }>(
    await cliForLinuxdo([
      "archive",
      "timeline",
      rootItemId,
      "--bin",
      binId,
      "--limit",
      "100",
    ]),
    "found",
  );
  for (const runId of [
    journey.firstCollection.runId,
    discoveryCollection.runId,
    secondCollection.runId,
    partialCollection.runId,
  ]) {
    assert.ok(timeline.events.some((event) => event.runId === runId));
  }

  const deletion = cliData<{
    readonly itemId: string;
    readonly deletedItemIds: readonly string[];
    readonly deletionSeq: string;
    readonly deleted: true;
  }>(await cliForLinuxdo(["archive", "delete", rootItemId]), "deleted");
  assert.equal(deletion.itemId, rootItemId);
  const deletedItemIds = [
    ...new Set([
      rootItemId,
      ...journey.itemIds,
      ...secondCommit.items.map(({ itemId }) => itemId),
    ]),
  ];
  assert.deepEqual(
    deletion.deletedItemIds.toSorted(),
    deletedItemIds.toSorted(),
  );
  assert.equal(deletion.deleted, true);
  cliFailure(
    await cliForLinuxdo(["archive", "item", rootItemId, "--bin", binId]),
    "item_deleted",
  );
  for (const revisionId of [
    firstRevisionId,
    secondRevisionId,
    partialRevisionId,
  ]) {
    cliFailure(
      await cliForLinuxdo(["archive", "revision", revisionId]),
      "revision_not_found",
    );
  }
  cliFailure(
    await cliForLinuxdo([
      "archive",
      "diff",
      firstRevisionId,
      partialRevisionId,
    ]),
    "revision_not_found",
  );
  const deletedCommit = cliData<{
    readonly gaps?: {
      readonly items: readonly { readonly itemId: string }[];
      readonly relations: readonly { readonly relationId: string }[];
    };
  }>(
    await cliForLinuxdo(["archive", "commit", partialCommit.commitId]),
    "found",
  );
  assert.deepEqual(
    deletedCommit.gaps?.items.map(({ itemId }) => itemId).toSorted(),
    deletedItemIds.toSorted(),
  );
  assert.equal(deletedCommit.gaps?.relations.length, 3);
  const historicalTimeline = cliData<{
    readonly events: readonly {
      readonly kind: string;
      readonly subject?: {
        readonly kind: string;
        readonly itemId?: string;
        readonly relationId?: string;
      };
    }[];
  }>(
    await cliForLinuxdo([
      "archive",
      "timeline",
      rootItemId,
      "--bin",
      binId,
      "--as-of",
      partialCommit.archiveSeq,
      "--limit",
      "100",
    ]),
    "found",
  );
  assert.ok(
    historicalTimeline.events.some(
      (event) =>
        event.kind === "gap" &&
        event.subject?.kind === "item" &&
        event.subject.itemId === rootItemId,
    ),
  );
  assert.ok(
    historicalTimeline.events.some(
      (event) => event.kind === "gap" && event.subject?.kind === "relation",
    ),
  );
  const rssStillPresent = cliData<{ readonly itemId: string }>(
    await cli(baseUrl, [
      "archive",
      "item",
      rss.itemId,
      "--bin",
      "binny-rss-one",
    ]),
    "found",
  );
  assert.equal(rssStillPresent.itemId, rss.itemId);
  process.stdout.write(
    "整合查询、更新历史、最新 partial、媒体保留与声明级联删除通过：" +
      JSON.stringify({
        binId,
        linuxdoRunIds: [
          journey.firstCollection.runId,
          discoveryCollection.runId,
          secondCollection.runId,
          partialCollection.runId,
        ],
        deletedItemIds: deletion.deletedItemIds,
        rssItemId: rss.itemId,
        rssBinIds: rss.binIds,
      }) +
      "\n",
  );
}

async function verifyLinuxdoCapacityJourney(baseUrl: string): Promise<void> {
  const firstBinId = "binny-integration-linuxdo";
  const secondBinId = "binny-integration-linuxdo-two";
  const browserServices = ["runtime-linuxdo", "runtime-linuxdo-two"] as const;
  type BrowserBin = {
    readonly browserIdleTimeoutSeconds: number | null;
    readonly execution: {
      readonly status: string;
      readonly environment?: {
        readonly browser?: { readonly power?: { readonly status: string } };
      };
    };
  };
  const cliForLinuxdo = (args: readonly string[]) => cli(baseUrl, args);
  const readBin = async (binId: string): Promise<BrowserBin> =>
    cliData<BrowserBin>(await cli(baseUrl, ["bin", "get", binId]), "found");
  const updateIdleTimeout = async (
    binId: string,
    timeout: number | "disabled",
  ): Promise<void> => {
    cliData(
      await cli(baseUrl, [
        "bin",
        "update",
        binId,
        "--browser-idle-timeout-seconds",
        String(timeout),
      ]),
      "updated",
    );
  };
  const waitForPower = async (
    binId: string,
    status: string,
  ): Promise<BrowserBin> =>
    await waitFor(
      () => readBin(binId),
      (bin) =>
        bin.execution.status === "online" &&
        bin.execution.environment?.browser?.power?.status === status,
      `${binId} 浏览器进入 ${status}`,
    );
  const browserProcesses = async (service?: string) => {
    const snapshots = await Promise.all(
      (service === undefined ? browserServices : [service]).map((serviceName) =>
        runtimeProcessSnapshot(serviceName),
      ),
    );
    return snapshots
      .flat()
      .filter(
        ({ command }) =>
          /(?:chrom(?:e|ium))/iu.test(command) &&
          !command.includes("--type=") &&
          !command.includes("chrome_crashpad_handler") &&
          !command.includes("<defunct>"),
      );
  };
  const closeHuman = async (
    binId: string,
    sessionId: string,
  ): Promise<void> => {
    await closeLinuxdoHumanSession(cliForLinuxdo, binId, sessionId);
    await waitFor(
      async () =>
        cliData<{ readonly status: string }>(
          await cli(baseUrl, ["human", "get", binId, sessionId]),
          "found",
        ),
      (session) => session.status === "closed",
      `${binId} 人工会话关闭`,
    );
  };
  const triggerCheck = async (binId: string): Promise<ManualRunCliState> =>
    cliData<ManualRunCliState>(
      await cli(baseUrl, [
        "run",
        "trigger",
        binId,
        "check",
        "--params",
        JSON.stringify({ topicId: 2401 }),
      ]),
      "triggered",
    );
  const waitForRunEnd = async (
    binId: string,
    runId: string,
  ): Promise<ManualRunCliState> =>
    await waitFor(
      async () =>
        cliData<ManualRunCliState>(
          await cli(baseUrl, ["run", "get", binId, runId]),
          "found",
        ),
      (current) =>
        current.status === "completed" || current.status === "failed",
      `${binId} 检查运行结束`,
    );

  await updateIdleTimeout(firstBinId, 0);
  await updateIdleTimeout(secondBinId, "disabled");
  const firstHuman = await openLinuxdoHumanSession(cliForLinuxdo, firstBinId);
  await waitForPower(firstBinId, "ready");
  const firstProcess = await browserProcesses("runtime-linuxdo");
  assert.equal(firstProcess.length, 1);
  const queuedOnCapacity = await triggerCheck(secondBinId);
  assert.equal(queuedOnCapacity.status, "queued");
  assert.equal(queuedOnCapacity.queueReason, "browser_capacity_exhausted");
  assert.equal((await browserProcesses()).length, 1);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  assert.equal(
    (await waitForPower(firstBinId, "ready")).browserIdleTimeoutSeconds,
    0,
  );
  assert.deepEqual(
    (await browserProcesses()).map(({ pid, command }) => ({ pid, command })),
    firstProcess.map(({ pid, command }) => ({ pid, command })),
    "人工会话 ready 时空闲策略不应关闭浏览器。",
  );

  await closeHuman(firstBinId, firstHuman.sessionId);
  const firstStopped = await waitForPower(firstBinId, "stopped");
  assert.equal(firstStopped.browserIdleTimeoutSeconds, 0);
  assert.equal((await browserProcesses("runtime-linuxdo")).length, 0);
  assert.ok((await browserProcesses()).length <= 1);
  const secondRun = await waitForRunEnd(secondBinId, queuedOnCapacity.runId);
  assert.equal(secondRun.status, "completed");
  assert.equal(secondRun.result?.output?.availability, "unavailable");
  await waitForPower(secondBinId, "ready");
  const disabledOwnerProcess = await waitFor(
    () => browserProcesses(),
    (processes) => processes.length === 1,
    `${secondBinId} 唯一主浏览器进程收敛`,
  );
  assert.equal(disabledOwnerProcess.length, 1);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  assert.equal(
    (await waitForPower(secondBinId, "ready")).browserIdleTimeoutSeconds,
    null,
  );
  assert.deepEqual(
    (await browserProcesses()).map(({ pid, command }) => ({ pid, command })),
    disabledOwnerProcess.map(({ pid, command }) => ({ pid, command })),
    "禁用空闲关闭的容量持有者应保留原浏览器进程。",
  );

  const waitingFirstRun = await triggerCheck(firstBinId);
  assert.equal(waitingFirstRun.status, "queued");
  assert.equal(waitingFirstRun.queueReason, "browser_capacity_exhausted");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  assert.equal(
    (await readBin(secondBinId)).execution.environment?.browser?.power?.status,
    "ready",
  );
  assert.equal((await browserProcesses()).length, 1);
  await updateIdleTimeout(secondBinId, 0);
  await waitForPower(secondBinId, "stopped");
  assert.equal((await browserProcesses("runtime-linuxdo-two")).length, 0);
  assert.ok((await browserProcesses()).length <= 1);
  const firstRun = await waitForRunEnd(firstBinId, waitingFirstRun.runId);
  assert.equal(firstRun.status, "completed");
  assert.equal(firstRun.result?.output?.availability, "available");
  await waitForPower(firstBinId, "stopped");
  assert.equal((await browserProcesses()).length, 0);

  const secondHuman = await openLinuxdoHumanSession(cliForLinuxdo, firstBinId);
  await waitForPower(firstBinId, "ready");
  const blockedRun = await triggerCheck(firstBinId);
  assert.equal(blockedRun.status, "queued");
  assert.equal(blockedRun.queueReason, "human_session_active");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  assert.equal(
    (await readBin(firstBinId)).execution.environment?.browser?.power?.status,
    "ready",
  );
  assert.equal((await browserProcesses()).length, 1);
  await closeHuman(firstBinId, secondHuman.sessionId);
  const unblockedRun = await waitForRunEnd(firstBinId, blockedRun.runId);
  assert.equal(unblockedRun.status, "completed");
  await waitForPower(firstBinId, "stopped");
  assert.equal((await browserProcesses()).length, 0);

  process.stdout.write(
    "同项目 Linux.do 容量交接实测：" +
      JSON.stringify({
        capacityLimit: 1,
        queuedBin: secondBinId,
        queueReason: queuedOnCapacity.queueReason,
        stoppedBeforeWake:
          firstStopped.execution.environment?.browser?.power?.status,
        disabledOwnerStayedReady: true,
        manualRunQueueReason: blockedRun.queueReason,
        finalBrowserMainProcessCount: 0,
      }) +
      "\n",
  );
}

function rssManifestVersion(manifest: unknown): string {
  assert.ok(typeof manifest === "object" && manifest !== null);
  const version = (manifest as { readonly version?: unknown }).version;
  assert.ok(typeof version === "string" && version.length > 0);
  return version;
}

function rssManifestWithVersion(manifest: unknown, version: string): unknown {
  assert.ok(typeof manifest === "object" && manifest !== null);
  return { ...manifest, version };
}

async function buildRssImageUpdate(
  buildContextDirectory: string,
): Promise<RssImageUpdate> {
  const candidateManifest = await createRssManifest();
  const candidateVersion = rssManifestVersion(candidateManifest);
  const baselineVersion = candidateVersion + "-image-a";
  const baselineManifest = rssManifestWithVersion(
    candidateManifest,
    baselineVersion,
  );
  await copyImageBuildContext(artifactRoot, buildContextDirectory);
  await setBuildContextSourceAdapterVersion(
    buildContextDirectory,
    "source-adapters/rss/src/source-adapter.ts",
    "rss-atom",
    baselineVersion,
  );

  const previousProjectDirectory = composeProjectDirectory;
  const previousRuntimeImage = activeRssRuntimeImage;
  let baselineImageId: string;
  try {
    composeProjectDirectory = buildContextDirectory;
    activeRssRuntimeImage = rssBaselineRuntimeImageName;
    await compose(["build", "runtime-rss"]);
    baselineImageId = await imageId(rssBaselineRuntimeImageName);
  } finally {
    composeProjectDirectory = previousProjectDirectory;
    activeRssRuntimeImage = previousRuntimeImage;
  }

  const candidateImageId = await imageId(rssRuntimeImageName);
  assert.notEqual(
    candidateImageId,
    baselineImageId,
    "RSS A/B 应由不同源码构建出不同镜像制品。",
  );
  await setBuildContextSourceAdapterVersion(
    buildContextDirectory,
    "source-adapters/rss/src/source-adapter.ts",
    "rss-atom",
    candidateVersion,
  );
  return {
    baselineManifest,
    candidateManifest,
    baselineImageId,
    candidateImageId,
    buildContextDirectory,
  };
}

async function createRssBin(
  baseUrl: string,
  binId: string,
  manifest: unknown,
  config: unknown,
): Promise<void> {
  const registered = await waitForBinRegistration(baseUrl, binId);
  assert.equal(registered.sourceAdapterVersion, rssManifestVersion(manifest));
  const configJson = JSON.stringify(config);
  assert.ok(configJson !== undefined);
  const updated = cliData<{ readonly id: string }>(
    await cli(baseUrl, [
      "bin",
      "update",
      binId,
      "--identity",
      binId + "-identity",
      "--config",
      configJson,
    ]),
    "updated",
  );
  assert.equal(updated.id, binId);
}

async function updateRssBinSourceAdapter(
  baseUrl: string,
  binId: string,
  manifest: unknown,
): Promise<void> {
  const registered = await waitForBinRegistration(baseUrl, binId);
  assert.equal(registered.sourceAdapterVersion, rssManifestVersion(manifest));
}

async function rebuildRssRuntimeWithComposeWatch(
  baseUrl: string,
  imageUpdate: RssImageUpdate,
  version: string,
): Promise<{
  readonly imageId: string;
  readonly previousImageId: string;
  readonly previousContainerId: string;
  readonly updatedContainerId: string;
}> {
  const previousProjectDirectory = composeProjectDirectory;
  const previousImageId = await containerImageId("runtime-rss");
  const previousContainerId = await runningContainerId("runtime-rss");
  let watcher: ManagedProcess | undefined;
  try {
    composeProjectDirectory = imageUpdate.buildContextDirectory;
    watcher = startManagedProcess("docker", [
      ...composePrefix(),
      "watch",
      "--no-up",
      "--prune=false",
      "runtime-rss",
    ]);
    await watcher.waitForMarker("Watch enabled");
    await setBuildContextSourceAdapterVersion(
      imageUpdate.buildContextDirectory,
      "source-adapters/rss/src/source-adapter.ts",
      "rss-atom",
      version,
    );
    const imageIdAfterRebuild = await waitFor(
      async () => {
        const result = await run(
          "docker",
          ["image", "inspect", "--format", "{{.Id}}", rssRuntimeImageName],
          { env: composeEnvironment() },
        );
        return result.code === 0 ? result.stdout.trim() : "";
      },
      (imageId) => imageId.length > 0 && imageId !== previousImageId,
      "Compose Watch 编译新的 RSS 镜像",
    );
    await waitFor(
      async () => {
        try {
          return await containerImageId("runtime-rss");
        } catch {
          return "";
        }
      },
      (imageId) => imageId === imageIdAfterRebuild,
      "Compose Watch 替换 RSS 运行器",
    );
    await waitForRuntimeHealth("runtime-rss");
    await waitForRuntime(baseUrl, "binny-rss-one");
    const updatedContainerId = await runningContainerId("runtime-rss");
    assert.notEqual(updatedContainerId, previousContainerId);
    return {
      imageId: imageIdAfterRebuild,
      previousImageId,
      previousContainerId,
      updatedContainerId,
    };
  } finally {
    if (watcher !== undefined) {
      if (watcher.child.exitCode === null) watcher.child.kill("SIGINT");
      await watcher.waitForClose();
    }
    composeProjectDirectory = previousProjectDirectory;
  }
}

async function waitForRuntimeHealth(service: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const probe = [
    "const response = await fetch('http://127.0.0.1:8080/health');",
    'const body = await response.json(); if (!response.ok || body.process !== "ready") process.exit(1);',
  ].join("\n");
  let lastFailure = "运行器尚未启动。";
  while (Date.now() < deadline) {
    const result = await run(
      "docker",
      [
        ...composePrefix(),
        "exec",
        "--no-TTY",
        service,
        "node",
        "--input-type=module",
        "-e",
        probe,
      ],
      { env: composeEnvironment() },
    );
    if (result.code === 0) return;
    lastFailure = result.stderr + result.stdout;
    await wait(100);
  }
  assert.fail(`Compose 运行器 ${service} 没有就绪：${lastFailure}`);
}

async function triggerRssAction(
  baseUrl: string,
  binId: string,
  action: "check" | "collect",
  params: Readonly<Record<string, unknown>>,
): Promise<RssManualRun> {
  const triggered = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli(baseUrl, [
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
  let latest: RssManualRun | undefined;
  while (Date.now() < deadline) {
    latest = cliData<RssManualRun>(
      await cli(baseUrl, ["run", "get", binId, triggered.runId]),
      "found",
    );
    if (latest.status === "completed" || latest.status === "failed")
      return latest;
    await wait(100);
  }
  assert.fail(`等待 RSS ${action} 运行终结超时：${JSON.stringify(latest)}`);
}

type RssArchiveRead = {
  readonly itemId: string;
  readonly sourceKey: { readonly namespace: string; readonly key: string };
  readonly snapshot: unknown;
  readonly views: readonly {
    readonly binId: string;
    readonly archiveSeq: string;
    readonly revisionId: string;
    readonly state: {
      readonly title: string | null;
      readonly sourcePublishedAt: ArchiveSourceTimeRead | null;
      readonly sourceModifiedAt: ArchiveSourceTimeRead | null;
      readonly extensions: Record<string, unknown> & {
        readonly authors?: readonly string[];
        readonly categories?: readonly string[];
        readonly item?: {
          readonly bodyType?: string;
          readonly bodySource?: string;
          readonly authors?: readonly unknown[];
          readonly categories?: readonly unknown[];
        } | null;
      };
      readonly body?: {
        readonly html?: string;
        readonly markdown?: string;
        readonly text?: string;
        readonly searchText?: string;
      };
      readonly resources?: readonly { readonly resourceId: string }[];
      readonly capture: {
        readonly completeness: "complete" | "partial";
        readonly scope: {
          readonly bodySource?: string;
          readonly bodyUrl?: string;
          readonly bodyFinalUrl?: string;
        };
        readonly missing: readonly {
          readonly path: string;
          readonly reason: string;
        }[];
      };
    };
  }[];
  readonly revisions: readonly {
    readonly revisionId: string;
    readonly stateHash: string;
  }[];
  readonly observations: readonly unknown[];
};

async function searchRssArchive(
  baseUrl: string,
  binId: string,
  text: string,
): Promise<
  readonly {
    readonly itemId: string;
    readonly sourceKey: { readonly namespace: string; readonly key: string };
  }[]
> {
  const results: {
    readonly itemId: string;
    readonly sourceKey: { readonly namespace: string; readonly key: string };
  }[] = [];
  let cursor: string | undefined;
  do {
    const page = cliData<{
      readonly results: readonly {
        readonly itemId: string;
        readonly sourceKey: {
          readonly namespace: string;
          readonly key: string;
        };
      }[];
      readonly nextCursor?: string;
    }>(
      await cli(baseUrl, [
        "archive",
        "search",
        "--query",
        JSON.stringify({
          bins: [binId],
          text: { groups: [[text]] },
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ]),
      "found",
    );
    results.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return results;
}

async function readRssArchive(
  baseUrl: string,
  binId: string,
  text: string,
): Promise<RssArchiveRead> {
  const results = await searchRssArchive(baseUrl, binId, text);
  assert.equal(results.length, 1, `归档正文检索「${text}」应命中一项。`);
  const result = results[0];
  assert.ok(result !== undefined);
  const item = cliData<RssArchiveRead>(
    await cli(baseUrl, ["archive", "item", result.itemId, "--bin", binId]),
    "found",
  );
  assert.deepEqual(item.sourceKey, result.sourceKey);
  return item;
}

function rssArchiveView(
  item: RssArchiveRead,
  binId: string,
): RssArchiveRead["views"][number]["state"] {
  const view = item.views.find((entry) => entry.binId === binId);
  assert.ok(view !== undefined, `归档条目没有 ${binId} 的视图。`);
  return view.state;
}

async function readRssResource(
  baseUrl: string,
  resourceId: string,
): Promise<Buffer> {
  const response = await fetch(`${baseUrl}/resources/${resourceId}`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0);
  return bytes;
}

function sourceArrived(
  response: unknown,
  gateKey: string,
  runId?: string,
  binId?: string,
): boolean {
  if (
    typeof response !== "object" ||
    response === null ||
    !("arrivals" in response) ||
    !Array.isArray(response.arrivals)
  ) {
    return false;
  }
  return response.arrivals.some((arrival: unknown) => {
    if (typeof arrival !== "object" || arrival === null) return false;
    return (
      "gateKey" in arrival &&
      arrival.gateKey === gateKey &&
      (runId === undefined ||
        ("runId" in arrival && arrival.runId === runId)) &&
      (binId === undefined || ("binId" in arrival && arrival.binId === binId))
    );
  });
}

async function waitForSourceArrival(
  sourceUrl: string,
  gateKey: string,
  runId?: string,
  binId?: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(sourceUrl + "/control/arrivals", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const status: unknown = await response.json();
    if (sourceArrived(status, gateKey, runId, binId)) return;
    await wait(50);
  }
  assert.fail(`运行没有到达受控信源：${gateKey}`);
}

async function waitForScheduledArrival(
  sourceUrl: string,
  gateKeys: readonly string[],
  binId: string,
): Promise<{ readonly gateKey: string; readonly runId: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(sourceUrl + "/control/arrivals", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const status: unknown = await response.json();
    if (
      typeof status === "object" &&
      status !== null &&
      "arrivals" in status &&
      Array.isArray(status.arrivals)
    ) {
      for (const gateKey of gateKeys) {
        const arrival = status.arrivals.find(
          (value: unknown) =>
            typeof value === "object" &&
            value !== null &&
            "gateKey" in value &&
            value.gateKey === gateKey &&
            "binId" in value &&
            value.binId === binId &&
            "runId" in value &&
            typeof value.runId === "string",
        );
        if (
          typeof arrival === "object" &&
          arrival !== null &&
          "runId" in arrival &&
          typeof arrival.runId === "string"
        ) {
          return { gateKey, runId: arrival.runId };
        }
      }
    }
    await wait(50);
  }
  assert.fail("重启后没有受控信源到达计划运行。");
}

async function countSourceArrivals(
  sourceUrl: string,
  gateKey: string,
  binId: string,
): Promise<number> {
  const response = await fetch(sourceUrl + "/control/arrivals", {
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  const status: unknown = await response.json();
  if (
    typeof status !== "object" ||
    status === null ||
    !("arrivals" in status) ||
    !Array.isArray(status.arrivals)
  ) {
    return 0;
  }
  return status.arrivals.filter(
    (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      "gateKey" in value &&
      value.gateKey === gateKey &&
      "binId" in value &&
      value.binId === binId,
  ).length;
}

async function countAllSourceArrivals(sourceUrl: string): Promise<number> {
  const response = await fetch(sourceUrl + "/control/arrivals", {
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  const status: unknown = await response.json();
  return typeof status === "object" &&
    status !== null &&
    "arrivals" in status &&
    Array.isArray(status.arrivals)
    ? status.arrivals.length
    : 0;
}

async function releaseSource(
  sourceUrl: string,
  gateKey: string,
  disposition:
    | "material"
    | "slow"
    | "available"
    | "unavailable"
    | "unknown" = "material",
): Promise<void> {
  const response = await fetch(sourceUrl + "/control/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gateKey, disposition }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
}

function manualRunSourceRuntimeUrl(): string {
  return "http://manual-runs-source:8081";
}

function manualRunSourceControlUrl(): string {
  const host = process.env.BINNY_E2E_HOST ?? "172.17.0.1";
  return "http://" + host + ":" + String(manualRunSourcePort);
}

async function waitForManualRunSource(): Promise<void> {
  const sourceUrl = manualRunSourceControlUrl();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(sourceUrl + "/control/arrivals", {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status === 200) return;
    } catch {
      // Compose 服务可能比 `up --wait` 晚几毫秒开始监听。
    }
    await wait(50);
  }
  assert.fail("受控信源没有在 Compose 网络入口启动。");
}

async function waitForSourceMarker(
  sourceUrl: string,
  runId: string,
  gateKey: string,
  marker: string,
): Promise<void> {
  await waitFor(
    async () => {
      const response = await fetch(sourceUrl + "/control/arrivals", {
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as unknown;
    },
    (status) =>
      typeof status === "object" &&
      status !== null &&
      "markers" in status &&
      Array.isArray(status.markers) &&
      status.markers.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "runId" in entry &&
          entry.runId === runId &&
          "gateKey" in entry &&
          entry.gateKey === gateKey &&
          "marker" in entry &&
          entry.marker === marker,
      ),
    `运行 ${runId} 写出信源标记 ${marker}`,
  );
}

async function runtimeProcessSnapshot(service: string): Promise<
  readonly {
    readonly pid: number;
    readonly pgid: number;
    readonly command: string;
  }[]
> {
  const containers = await compose(["ps", "-q", service]);
  const containerId = containers.stdout.trim().split("\n")[0];
  assert.ok(containerId, `没有找到 Compose 服务 ${service} 的容器。`);
  const processes = await run(
    "docker",
    ["top", containerId, "-eo", "pid,pgid,args"],
    { env: composeEnvironment() },
  );
  assert.equal(processes.code, 0, processes.stderr);
  return processes.stdout
    .trim()
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/u.exec(line.trim());
      return match === null
        ? []
        : [
            {
              pid: Number(match[1]),
              pgid: Number(match[2]),
              command: match[3]!,
            },
          ];
    });
}

type ManualRunCliState = {
  readonly runId: string;
  readonly binId: string;
  readonly createdAt: string;
  readonly referenceTime: string;
  readonly action: string;
  readonly trigger:
    | { readonly kind: "manual" }
    | {
        readonly kind: "schedule";
        readonly scheduleId: string;
        readonly scheduledFor: string;
      };
  readonly status: string;
  readonly queueReason?:
    | "runtime_offline"
    | "earlier_run_active"
    | "earlier_run_queued"
    | "previous_execution_unconfirmed";
  readonly cancellationRequestedAt?: string;
  readonly stopConfirmedAt?: string;
  readonly result?: {
    readonly completedScopes: readonly string[];
    readonly commits: readonly {
      readonly commitId: string;
      readonly items: readonly { readonly itemId: string }[];
    }[];
    readonly output?: ManualActionOutput;
    readonly stopReason: { readonly code: string };
    readonly error?: { readonly code: string };
  };
};

async function waitForCliManualRunState(
  baseUrl: string,
  binId: string,
  runId: string,
  statuses: readonly string[],
): Promise<ManualRunCliState> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, runId]),
      "found",
    );
    if (statuses.includes(current.status)) return current;
    await wait(50);
  }
  assert.fail(`运行没有进入预期状态：${statuses.join("/")}`);
}

type RuntimeExecutionState = {
  readonly status: string;
  readonly runtimeId?: string;
  readonly reason?: string;
};

async function readRuntimeExecutionState(
  baseUrl: string,
  binId: string,
): Promise<RuntimeExecutionState> {
  const bin = cliData<{ readonly execution: RuntimeExecutionState }>(
    await cli(baseUrl, ["bin", "get", binId]),
    "found",
  );
  return bin.execution;
}

async function waitForReplacementRuntime(
  baseUrl: string,
  binId: string,
  previousRuntimeId: string,
): Promise<string> {
  const replacement = await waitFor(
    () => readRuntimeExecutionState(baseUrl, binId),
    (current) =>
      current.status === "online" &&
      current.runtimeId !== undefined &&
      current.runtimeId !== previousRuntimeId,
    `bin ${binId} 的替换运行器上线`,
  );
  assert.ok(replacement.runtimeId !== undefined);
  return replacement.runtimeId;
}

async function verifyDelayedOldOwnerCannotDisturbRun(
  baseUrl: string,
  heartbeatProxy: HeartbeatDelayProxy,
  label: string,
  currentRuntimeId: string,
): Promise<void> {
  const binId = "binny-runs-one";
  const service = "runtime-fifteen-one";
  const sourceControlUrl = manualRunSourceControlUrl();
  const gateKey = `18-${label}-late-owner-${randomUUID()}`;
  const run = cliData<{ readonly runId: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey,
        sourceKey: gateKey,
        waitAfterCommitMs: 60_000,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(sourceControlUrl, gateKey, run.runId, binId);
  await releaseSource(sourceControlUrl, gateKey, "slow");
  await waitForSourceMarker(sourceControlUrl, run.runId, gateKey, "committed");
  const worker = (await runtimeProcessSnapshot(service)).find((process) =>
    process.command.includes("worker.js"),
  );
  assert.ok(worker, `${label} 应有真实的新 owner worker 正在运行。`);

  await heartbeatProxy.release();
  await wait(150);
  const afterLateHeartbeat = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", binId, run.runId]),
    "found",
  );
  assert.equal(
    afterLateHeartbeat.status,
    "executing",
    `${label} 的迟到旧 idle 不能终结新 owner 的运行。`,
  );
  assert.equal(afterLateHeartbeat.stopConfirmedAt, undefined);
  const ownerAfterLateHeartbeat = await readRuntimeExecutionState(
    baseUrl,
    binId,
  );
  assert.equal(ownerAfterLateHeartbeat.status, "online");
  assert.equal(ownerAfterLateHeartbeat.runtimeId, currentRuntimeId);
  assert.ok(
    (await runtimeProcessSnapshot(service)).some(
      (process) => process.pgid === worker.pgid,
    ),
    `${label} 的迟到旧 idle 不能确认仍在运行的 worker 已停止。`,
  );

  const cancellation = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "cancel", binId, run.runId]),
    "cancellation",
  );
  assert.equal(cancellation.status, "cancelling");
  const cancelled = await waitForCliManualRunState(baseUrl, binId, run.runId, [
    "cancelled",
  ]);
  assert.ok(cancelled.stopConfirmedAt);
  await waitFor(
    () => runtimeProcessSnapshot(service),
    (processes) => !processes.some((process) => process.pgid === worker.pgid),
    `${label} 的取消确认等待真实 worker 退出`,
  );

  const completedGate = `18-${label}-replacement-run-${randomUUID()}`;
  const completedRun = cliData<{ readonly runId: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey: completedGate,
        sourceKey: completedGate,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(
    sourceControlUrl,
    completedGate,
    completedRun.runId,
    binId,
  );
  await releaseSource(sourceControlUrl, completedGate);
  const completed = await waitForCliManualRunState(
    baseUrl,
    binId,
    completedRun.runId,
    ["completed"],
  );
  assert.equal(completed.result?.stopReason.code, "completed");
}

async function ownerGenerationOverlapStep(
  baseUrl: string,
  heartbeatProxy: HeartbeatDelayProxy,
  previousStoppedRunId: string,
): Promise<void> {
  const binId = "binny-runs-one";
  const service = "runtime-fifteen-one";
  const initialOwner = await readRuntimeExecutionState(baseUrl, binId);
  assert.equal(initialOwner.status, "online");
  assert.ok(initialOwner.runtimeId !== undefined);

  await heartbeatProxy.arm(previousStoppedRunId);
  const registeredOldHeartbeat = await heartbeatProxy.waitUntilHeld();
  assert.equal(registeredOldHeartbeat.runtimeId, initialOwner.runtimeId);
  assert.ok(registeredOldHeartbeat.ownerGeneration !== undefined);
  assert.equal(registeredOldHeartbeat.stoppedRunId, undefined);
  const heldAt = registeredOldHeartbeat.heldAt;
  const clientClosedAt = await heartbeatProxy.waitUntilTimedOut();
  assert.ok(clientClosedAt - heldAt >= 2_500);
  await compose(["kill", "--signal", "SIGKILL", service]);
  await compose(["up", "--detach", "--no-build", "--force-recreate", service]);
  const registeredReplacementId = await waitForReplacementRuntime(
    baseUrl,
    binId,
    initialOwner.runtimeId,
  );
  const registeredReplacementGeneration =
    await heartbeatProxy.waitUntilForwarded(registeredReplacementId);
  assert.ok(registeredReplacementGeneration !== undefined);
  assert.ok(
    BigInt(registeredReplacementGeneration) >
      BigInt(registeredOldHeartbeat.ownerGeneration),
    "通过同卷 owner lock 的合法替换必须持久推进所有权代际。",
  );
  await verifyDelayedOldOwnerCannotDisturbRun(
    baseUrl,
    heartbeatProxy,
    "registered-owner",
    registeredReplacementId,
  );

  await compose(["stop", service]);
  const stoppedOwner = await waitFor(
    () => readRuntimeExecutionState(baseUrl, binId),
    (current) =>
      current.status === "offline" &&
      current.runtimeId === registeredReplacementId,
    "当前运行器正常断开",
  );
  assert.equal(stoppedOwner.reason, "runtime_not_connected");

  await heartbeatProxy.arm(previousStoppedRunId);
  await compose(["up", "--detach", "--no-build", "--force-recreate", service]);
  const unseenOldHeartbeat = await heartbeatProxy.waitUntilHeld();
  assert.notEqual(unseenOldHeartbeat.runtimeId, registeredReplacementId);
  assert.ok(unseenOldHeartbeat.ownerGeneration !== undefined);
  assert.equal(unseenOldHeartbeat.stoppedRunId, undefined);
  assert.ok(
    BigInt(unseenOldHeartbeat.ownerGeneration) >
      BigInt(registeredReplacementGeneration),
  );
  const stillStopped = await readRuntimeExecutionState(baseUrl, binId);
  assert.equal(stillStopped.status, "offline");
  assert.equal(
    stillStopped.runtimeId,
    registeredReplacementId,
    "core 尚未见到新 controller 的首个 idle 心跳。",
  );
  const unseenClientClosedAt = await heartbeatProxy.waitUntilTimedOut();
  assert.ok(unseenClientClosedAt - unseenOldHeartbeat.heldAt >= 2_500);
  await compose(["kill", "--signal", "SIGKILL", service]);
  await compose(["up", "--detach", "--no-build", "--force-recreate", service]);
  const unseenReplacementId = await waitForReplacementRuntime(
    baseUrl,
    binId,
    registeredReplacementId,
  );
  assert.notEqual(unseenReplacementId, unseenOldHeartbeat.runtimeId);
  const unseenReplacementGeneration =
    await heartbeatProxy.waitUntilForwarded(unseenReplacementId);
  assert.ok(unseenReplacementGeneration !== undefined);
  assert.ok(
    BigInt(unseenReplacementGeneration) >
      BigInt(unseenOldHeartbeat.ownerGeneration),
    "核心未见旧首包时，新 controller 仍须携带更高的持久代际。",
  );
  await verifyDelayedOldOwnerCannotDisturbRun(
    baseUrl,
    heartbeatProxy,
    "unseen-first-heartbeat",
    unseenReplacementId,
  );
}

async function replacementPreservesAcceptedCancellationStep(
  baseUrl: string,
): Promise<void> {
  const binId = "binny-runs-one";
  const service = "runtime-fifteen-one";
  const sourceControlUrl = manualRunSourceControlUrl();
  const initialOwner = await readRuntimeExecutionState(baseUrl, binId);
  assert.equal(initialOwner.status, "online");
  assert.ok(initialOwner.runtimeId !== undefined);

  const gateKey = `18-replacement-cancel-race-${randomUUID()}`;
  const run = cliData<{ readonly runId: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey,
        sourceKey: gateKey,
        waitAfterCommitMs: 60_000,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(sourceControlUrl, gateKey, run.runId, binId);
  await releaseSource(sourceControlUrl, gateKey, "slow");
  await waitForSourceMarker(sourceControlUrl, run.runId, gateKey, "committed");

  const rowLock = await holdManualRunRowLock(run.runId);
  let cancellationRequest:
    | Promise<
        | { readonly status: number; readonly body: unknown }
        | { readonly error: unknown }
      >
    | undefined;
  try {
    cancellationRequest = fetch(
      `${baseUrl}/bins/${encodeURIComponent(binId)}/runs/${encodeURIComponent(run.runId)}/cancel`,
      {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      },
    )
      .then(async (response) => ({
        status: response.status,
        body: (await response.json()) as unknown,
      }))
      .catch((error: unknown) => ({ error }));
    const cancellationWaiterPid = await waitForManualRunLockWaiterBlockedBy(
      rowLock.backendPid,
      [rowLock.backendPid],
    );

    await compose(["kill", "--signal", "SIGKILL", service]);
    await compose([
      "up",
      "--detach",
      "--no-build",
      "--force-recreate",
      service,
    ]);
    await waitForManualRunLockWaiterBlockedBy(cancellationWaiterPid, [
      rowLock.backendPid,
      cancellationWaiterPid,
    ]);
  } finally {
    await rowLock.release();
  }

  assert.ok(cancellationRequest !== undefined);
  const acceptedResponse = await cancellationRequest;
  if ("error" in acceptedResponse)
    assert.fail(`取消请求失败：${String(acceptedResponse.error)}`);
  assert.equal(acceptedResponse.status, 200);
  const acceptedCancellation = acceptedResponse.body as ManualRunCliState;
  assert.equal(acceptedCancellation.status, "cancelling");
  assert.ok(acceptedCancellation.cancellationRequestedAt);

  const replacementRuntimeId = await waitForReplacementRuntime(
    baseUrl,
    binId,
    initialOwner.runtimeId,
  );
  const cancelled = await waitForCliManualRunState(baseUrl, binId, run.runId, [
    "cancelled",
  ]);
  assert.ok(cancelled.stopConfirmedAt);
  assert.equal(cancelled.result?.stopReason.code, "cancelled");
  assert.equal(
    (await readRuntimeExecutionState(baseUrl, binId)).runtimeId,
    replacementRuntimeId,
  );
}

async function configureManualRunBins(
  baseUrl: string,
  manifest: unknown,
): Promise<void> {
  for (const binId of ["binny-runs-one", "binny-runs-two"]) {
    const registered = await waitForBinRegistration(baseUrl, binId);
    assert.equal(registered.sourceAdapterVersion, rssManifestVersion(manifest));
    const configured = cliData<{
      readonly id: string;
      readonly config: { readonly section: string };
    }>(
      await cli(baseUrl, [
        "bin",
        "update",
        binId,
        "--identity",
        binId + "-identity",
        "--config",
        JSON.stringify({ section: "initial" }),
      ]),
      "updated",
    );
    assert.equal(configured.id, binId);
    assert.deepEqual(configured.config, { section: "initial" });
  }
  await Promise.all([
    waitForRuntime(baseUrl, "binny-runs-one"),
    waitForRuntime(baseUrl, "binny-runs-two"),
  ]);
}

async function configureExtensionScopeBins(baseUrl: string): Promise<void> {
  const schemaVariant = await waitForBinRegistration(
    baseUrl,
    "binny-runs-schema-two",
  );
  assert.equal(schemaVariant.sourceAdapterId, "binny-runs.manual-run-fixture");
  assert.equal(schemaVariant.sourceAdapterVersion, "2.0.0");
  const configuredSchemaVariant = cliData<{ readonly id: string }>(
    await cli(baseUrl, [
      "bin",
      "update",
      "binny-runs-schema-two",
      "--identity",
      "binny-runs-schema-two-identity",
      "--config",
      JSON.stringify({ section: "initial" }),
    ]),
    "updated",
  );
  assert.equal(configuredSchemaVariant.id, "binny-runs-schema-two");
  await waitForRuntime(baseUrl, "binny-runs-schema-two");

  const rssManifest = await createRssManifest();
  await createRssBin(baseUrl, "binny-rss-one", rssManifest, {
    feeds: [{ id: "extension-scope", url: "https://example.test/rss" }],
  });
  await waitForRuntime(baseUrl, "binny-rss-one");
}

async function manualRunsCliStep(
  baseUrl: string,
  manifest: unknown,
  heartbeatProxy: HeartbeatDelayProxy,
): Promise<void> {
  await configureManualRunBins(baseUrl, manifest);

  await waitForManualRunSource();
  const sourceRuntimeUrl = manualRunSourceRuntimeUrl();
  const sourceControlUrl = manualRunSourceControlUrl();
  const gateKey = "runs-cli-manual-run";
  const parameters = {
    sourceUrl: sourceRuntimeUrl,
    gateKey,
    sourceKey: "cli-created-item",
  };
  const invalidNativeParams = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-runs-one",
      "collect",
      "--params",
      JSON.stringify({
        ...parameters,
        gateKey: "native-refine-reject",
      }),
    ]),
    "invalid_action_parameters",
  );
  assert.deepEqual(invalidNativeParams.path, ["params", "gateKey"]);
  const triggered = cliData<{
    readonly runId: string;
    readonly status: string;
    readonly binId: string;
    readonly createdAt: string;
    readonly referenceTime: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-runs-one",
      "collect",
      "--params",
      JSON.stringify(parameters),
    ]),
    "triggered",
  );
  assert.equal(triggered.status, "queued");
  assert.equal(triggered.binId, "binny-runs-one");
  assert.equal(triggered.referenceTime, triggered.createdAt);
  await waitForSourceArrival(
    sourceControlUrl,
    gateKey,
    triggered.runId,
    "binny-runs-one",
  );
  const sourceArrivalsBeforeRunList =
    await countAllSourceArrivals(sourceControlUrl);
  const executingRuns = cliData<{
    readonly runs: readonly {
      readonly runId: string;
      readonly status: string;
    }[];
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--action",
      "collect",
      "--status",
      "executing",
    ]),
    "listed",
  );
  assert.ok(
    executingRuns.runs.some(
      ({ runId, status }) =>
        runId === triggered.runId && status === "executing",
    ),
  );
  assert.equal(
    await countAllSourceArrivals(sourceControlUrl),
    sourceArrivalsBeforeRunList,
    "只读运行列表不能增加来源请求。",
  );
  await releaseSource(sourceControlUrl, gateKey);

  const deadline = Date.now() + 30_000;
  let completed: ManualRunCliState | undefined;
  while (Date.now() < deadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", "binny-runs-one", triggered.runId]),
      "found",
    );
    if (current.status === "completed" || current.status === "failed") {
      completed = current;
      break;
    }
    await wait(100);
  }
  assert.ok(completed !== undefined, "CLI 没有读取到终结运行结果。");
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.stopReason.code, "completed");
  assert.deepEqual(completed.result?.output?.completedScopes, [
    "source/cli-created-item",
  ]);
  const savedCommit = completed.result?.commits[0];
  assert.ok(savedCommit !== undefined);
  const savedItem = savedCommit.items[0];
  assert.ok(savedItem !== undefined);

  const commit = cliData<{
    readonly binId: string;
    readonly runId?: string;
    readonly sourceAdapterVersion?: string;
  }>(await cli(baseUrl, ["archive", "commit", savedCommit.commitId]), "found");
  assert.equal(commit.binId, "binny-runs-one");
  assert.equal(commit.runId, triggered.runId);
  assert.equal(commit.sourceAdapterVersion, "1.0.0");

  const item = cliData<{
    readonly views: readonly {
      readonly state: {
        readonly title: string | null;
        readonly sourcePublishedAt: {
          readonly precision: string;
          readonly value: string;
        } | null;
        readonly sourceModifiedAt: {
          readonly precision: string;
          readonly value: string;
          readonly timeZone?: string;
        } | null;
        readonly extensions: {
          readonly section?: unknown;
          readonly adapterLabel?: unknown;
          readonly actionLabel?: unknown;
          readonly referenceTime?: unknown;
        };
        readonly body?: { readonly text?: string };
      };
    }[];
  }>(await cli(baseUrl, ["archive", "item", savedItem.itemId]), "found");
  assert.equal(item.views[0]?.state.title, "受控资料 " + gateKey);
  assert.deepEqual(item.views[0]?.state.sourcePublishedAt, {
    precision: "month",
    value: "2026-11",
  });
  assert.deepEqual(item.views[0]?.state.sourceModifiedAt, {
    precision: "instant",
    value: triggered.referenceTime,
    timeZone: "UTC",
  });
  assert.equal(item.views[0]?.state.extensions.section, "initial");
  assert.equal(item.views[0]?.state.extensions.adapterLabel, "runtime!");
  assert.equal(item.views[0]?.state.extensions.actionLabel, "collect!");
  assert.equal(
    item.views[0]?.state.extensions.referenceTime,
    triggered.referenceTime,
  );
  assert.equal(item.views[0]?.state.body?.text, "受控正文 " + gateKey);

  const checkGateKey = "check-cli-check-unknown";
  const checkTriggered = cliData<{
    readonly runId: string;
    readonly status: string;
    readonly binId: string;
    readonly createdAt: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-runs-one",
      "check",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: checkGateKey,
        sourceKey: "cli-check-scope",
      }),
    ]),
    "triggered",
  );
  assert.equal(checkTriggered.status, "queued");
  await waitForSourceArrival(
    sourceControlUrl,
    checkGateKey,
    checkTriggered.runId,
    "binny-runs-one",
  );
  await releaseSource(sourceControlUrl, checkGateKey, "unknown");

  const checkDeadline = Date.now() + 30_000;
  let checkedRun: ManualRunCliState | undefined;
  while (Date.now() < checkDeadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, [
        "run",
        "get",
        "binny-runs-one",
        checkTriggered.runId,
      ]),
      "found",
    );
    if (current.status === "completed" || current.status === "failed") {
      checkedRun = current;
      break;
    }
    await wait(100);
  }
  assert.ok(checkedRun !== undefined, "CLI 没有读取到 check 终结结果。");
  assert.equal(checkedRun.status, "completed");
  assert.equal(checkedRun.result?.output?.availability, "unknown");
  assert.deepEqual(checkedRun.result?.commits, []);
  assert.ok(
    (checkedRun.result?.output?.problems?.[0]?.suggestion?.length ?? 0) > 0,
  );
  assert.equal(checkedRun.result?.stopReason.code, "completed");

  const followUpGateKey = "check-cli-collect-after-check";
  const followUp = cliData<{
    readonly runId: string;
    readonly status: string;
    readonly createdAt: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-runs-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: followUpGateKey,
        sourceKey: "cli-after-check",
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(
    sourceControlUrl,
    followUpGateKey,
    followUp.runId,
    "binny-runs-one",
  );
  await releaseSource(sourceControlUrl, followUpGateKey);
  const followUpDeadline = Date.now() + 30_000;
  let collectedAfterCheck: ManualRunCliState | undefined;
  while (Date.now() < followUpDeadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", "binny-runs-one", followUp.runId]),
      "found",
    );
    if (current.status === "completed" || current.status === "failed") {
      collectedAfterCheck = current;
      break;
    }
    await wait(100);
  }
  assert.ok(
    collectedAfterCheck !== undefined,
    "最近 check 结果之后没有产生新的 collect 运行结果。",
  );
  assert.equal(collectedAfterCheck.status, "completed");
  assert.deepEqual(collectedAfterCheck.result?.output?.completedScopes, [
    "source/cli-after-check",
  ]);

  const filteredHistory = cliData<{
    readonly runs: readonly { readonly runId: string }[];
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--action",
      "check",
      "--status",
      "completed",
      "--created-from",
      checkTriggered.createdAt,
      "--created-before",
      "2099-01-01T00:00:00Z",
    ]),
    "listed",
  );
  assert.deepEqual(
    filteredHistory.runs.map(({ runId }) => runId),
    [checkTriggered.runId],
  );
  const emptyHistory = cliData<{
    readonly runs: readonly unknown[];
    readonly nextCursor?: string;
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--action",
      "check",
      "--status",
      "failed",
    ]),
    "listed",
  );
  assert.deepEqual(emptyHistory, { runs: [] });

  const firstHistoryPage = cliData<{
    readonly runs: readonly {
      readonly runId: string;
      readonly action: string;
      readonly status: string;
      readonly createdAt: string;
    }[];
    readonly nextCursor?: string;
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--limit",
      "2",
    ]),
    "listed",
  );
  assert.equal(firstHistoryPage.runs.length, 2);
  assert.ok(firstHistoryPage.nextCursor);
  const readableRunHistory = await cli(baseUrl, [
    "run",
    "list",
    "--bin-id",
    "binny-runs-one",
    "--limit",
    "10",
    "--output-format",
    "text",
  ]);
  assert.equal(readableRunHistory.code, 0, readableRunHistory.stderr);
  assert.match(readableRunHistory.stdout, /Runs/u);
  assert.match(readableRunHistory.stdout, /binny run get binny-runs-one /u);
  assert.doesNotMatch(readableRunHistory.stdout, /"runs"/u);
  const firstHistoryRun = firstHistoryPage.runs[0];
  assert.ok(firstHistoryRun);
  const detailFromHistory = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", "binny-runs-one", firstHistoryRun.runId]),
    "found",
  );
  assert.equal(detailFromHistory.runId, firstHistoryRun.runId);

  const malformedCursor = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--cursor",
      "invalid-cursor",
    ]),
    "invalid_input",
  );
  assert.deepEqual(malformedCursor.path, ["cursor"]);
  const mismatchedCursor = cliFailure<{
    readonly code: string;
    readonly path?: readonly (string | number)[];
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--action",
      "check",
      "--limit",
      "2",
      "--cursor",
      firstHistoryPage.nextCursor,
    ]),
    "invalid_input",
  );
  assert.deepEqual(mismatchedCursor.path, ["cursor"]);

  const pageInsertGateKey = "runs-cli-page-insert";
  const pageInsertRun = cliData<{ readonly runId: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-runs-one",
      "check",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: pageInsertGateKey,
        sourceKey: "cli-page-insert",
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(
    sourceControlUrl,
    pageInsertGateKey,
    pageInsertRun.runId,
    "binny-runs-one",
  );
  await releaseSource(sourceControlUrl, pageInsertGateKey, "unknown");
  await waitForCliManualRunState(
    baseUrl,
    "binny-runs-one",
    pageInsertRun.runId,
    ["completed"],
  );

  const secondHistoryPage = cliData<{
    readonly runs: readonly { readonly runId: string }[];
    readonly nextCursor?: string;
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--limit",
      "2",
      "--cursor",
      firstHistoryPage.nextCursor,
    ]),
    "listed",
  );
  assert.ok(
    secondHistoryPage.runs.every(
      ({ runId }) =>
        !firstHistoryPage.runs.some((first) => first.runId === runId),
    ),
  );
  assert.ok(
    secondHistoryPage.runs.some(({ runId }) => runId === triggered.runId),
  );
  assert.equal(
    secondHistoryPage.runs.some(({ runId }) => runId === pageInsertRun.runId),
    false,
    "翻页期间新增的较新运行不能滑入旧游标之后。",
  );
  assert.equal(secondHistoryPage.nextCursor, undefined);

  const invalidDateRange = await fetch(
    baseUrl +
      "/runs?binId=binny-runs-one&createdFrom=2026-11-04T00%3A00%3A00Z&createdBefore=2026-11-03T00%3A00%3A00Z",
  );
  assert.equal(invalidDateRange.status, 400);
  const invalidDateRangeBody = (await invalidDateRange.json()) as {
    readonly error: {
      readonly code: string;
      readonly path?: readonly string[];
    };
  };
  assert.equal(invalidDateRangeBody.error.code, "invalid_input");
  assert.deepEqual(invalidDateRangeBody.error.path, ["createdBefore"]);

  await ownerGenerationOverlapStep(baseUrl, heartbeatProxy, followUp.runId);
  await replacementPreservesAcceptedCancellationStep(baseUrl);

  const slowGateKey = "lifecycle-cli-slow-stop";
  const slowRun = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-runs-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: slowGateKey,
        sourceKey: "partial-before-cancel",
        waitAfterCommitMs: 10_000,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(
    sourceControlUrl,
    slowGateKey,
    slowRun.runId,
    "binny-runs-one",
  );
  const slowExecutingHistory = cliData<{
    readonly runs: readonly { readonly runId: string }[];
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--status",
      "executing",
    ]),
    "listed",
  );
  assert.ok(
    slowExecutingHistory.runs.some(({ runId }) => runId === slowRun.runId),
  );
  await releaseSource(sourceControlUrl, slowGateKey, "slow");
  await waitForSourceMarker(
    sourceControlUrl,
    slowRun.runId,
    slowGateKey,
    "committed",
  );
  const originalWorker = (
    await runtimeProcessSnapshot("runtime-fifteen-one")
  ).find((process) => process.command.includes("worker.js"));
  assert.ok(originalWorker, "慢动作应由独立执行进程运行。");

  const nextGateKey = "lifecycle-cli-next-after-stop";
  const nextRun = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-runs-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: nextGateKey,
        sourceKey: "after-cancel",
      }),
    ]),
    "triggered",
  );
  const queuedBehindSlowRun = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", "binny-runs-one", nextRun.runId]),
    "found",
  );
  assert.equal(queuedBehindSlowRun.status, "queued");
  assert.equal(queuedBehindSlowRun.queueReason, "earlier_run_active");
  const queuedHistory = cliData<{
    readonly runs: readonly {
      readonly runId: string;
      readonly status: string;
    }[];
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--status",
      "queued",
    ]),
    "listed",
  );
  assert.ok(
    queuedHistory.runs.some(
      ({ runId, status }) => runId === nextRun.runId && status === "queued",
    ),
  );

  const acceptedCancel = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "cancel", "binny-runs-one", slowRun.runId]),
    "cancellation",
  );
  assert.equal(acceptedCancel.status, "cancelling");
  assert.ok(acceptedCancel.cancellationRequestedAt);
  assert.equal(acceptedCancel.stopConfirmedAt, undefined);
  const stillQueued = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", "binny-runs-one", nextRun.runId]),
    "found",
  );
  assert.equal(stillQueued.status, "queued");
  assert.equal(stillQueued.queueReason, "earlier_run_active");
  const arrivalsDuringStop = await fetch(
    sourceControlUrl + "/control/arrivals",
  );
  assert.equal(arrivalsDuringStop.status, 200);
  assert.equal(
    sourceArrived(await arrivalsDuringStop.json(), nextGateKey),
    false,
  );

  const cancelled = await waitForCliManualRunState(
    baseUrl,
    "binny-runs-one",
    slowRun.runId,
    ["cancelled"],
  );
  assert.ok(cancelled.stopConfirmedAt);
  assert.equal(cancelled.result?.stopReason.code, "cancelled");
  const cancelledHistory = cliData<{
    readonly runs: readonly {
      readonly runId: string;
      readonly status: string;
    }[];
  }>(
    await cli(baseUrl, [
      "run",
      "list",
      "--bin-id",
      "binny-runs-one",
      "--status",
      "cancelled",
    ]),
    "listed",
  );
  assert.ok(
    cancelledHistory.runs.some(
      ({ runId, status }) => runId === slowRun.runId && status === "cancelled",
    ),
  );
  assert.equal(cancelled.result?.commits.length, 1);
  const savedPartial = cancelled.result?.commits[0];
  assert.ok(savedPartial);
  const retainedCommit = cliData<{ readonly runId?: string }>(
    await cli(baseUrl, ["archive", "commit", savedPartial.commitId]),
    "found",
  );
  assert.equal(retainedCommit.runId, slowRun.runId);
  const stoppedProcesses = await runtimeProcessSnapshot("runtime-fifteen-one");
  assert.equal(
    stoppedProcesses.some((process) => process.pgid === originalWorker.pgid),
    false,
    "取消完成后旧 worker 进程组必须已经退出。",
  );
  const sourceAfterStopResponse = await fetch(
    sourceControlUrl + "/control/arrivals",
  );
  assert.equal(sourceAfterStopResponse.status, 200);
  const sourceAfterStop: unknown = await sourceAfterStopResponse.json();
  if (
    typeof sourceAfterStop === "object" &&
    sourceAfterStop !== null &&
    "markers" in sourceAfterStop &&
    Array.isArray(sourceAfterStop.markers)
  ) {
    assert.equal(
      sourceAfterStop.markers.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "runId" in entry &&
          entry.runId === slowRun.runId &&
          "marker" in entry &&
          entry.marker === "after-stop-delay",
      ),
      false,
    );
  }

  await waitForSourceArrival(
    sourceControlUrl,
    nextGateKey,
    nextRun.runId,
    "binny-runs-one",
  );
  await releaseSource(sourceControlUrl, nextGateKey);
  const nextCompleted = await waitForCliManualRunState(
    baseUrl,
    "binny-runs-one",
    nextRun.runId,
    ["completed"],
  );
  assert.equal(nextCompleted.result?.stopReason.code, "completed");

  const ownerBeforeRecreation = await readRuntimeExecutionState(
    baseUrl,
    "binny-runs-one",
  );
  assert.equal(ownerBeforeRecreation.status, "online");
  assert.ok(ownerBeforeRecreation.runtimeId !== undefined);

  const generationBefore = (
    await run(
      "docker",
      postgresExecArgs([
        "-c",
        "SELECT owner_generation FROM runtime_connections WHERE bin_id = 'binny-runs-one';",
      ]),
    )
  ).stdout.trim();
  assert.ok(generationBefore.length > 0);

  const putInitialStateResponse = await fetch(
    `${baseUrl}/bins/binny-runs-one/runtime/state`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeId: ownerBeforeRecreation.runtimeId,
        ownerGeneration: generationBefore,
        persistentState: { testSyncCursor: "item-12345" },
        sourceAccess: { lease: "active", budgetRemaining: 99 },
      }),
    },
  );
  assert.equal(putInitialStateResponse.status, 200);

  await compose(["stop", "runtime-fifteen-one"]);
  await waitFor(
    () => readRuntimeExecutionState(baseUrl, "binny-runs-one"),
    (current) =>
      current.status === "offline" &&
      current.runtimeId === ownerBeforeRecreation.runtimeId,
    "重建前的运行器断开",
  );

  cliFailure<{ readonly code: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-runs-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey: "cli-offline-action-input",
        sourceKey: "cli-offline-action-input",
      }),
    ]),
    "runtime_action_validation_unavailable",
  );
  const offlineScheduleInput = cliFailure<{ readonly code: string }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      "binny-runs-one",
      "--expression",
      "0 0 0 1 1 *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey: "cli-offline-schedule-input",
        sourceKey: "cli-offline-schedule-input",
      }),
    ]),
    "runtime_action_validation_unavailable",
  );
  assert.equal(
    offlineScheduleInput.code,
    "runtime_action_validation_unavailable",
  );

  await compose([
    "up",
    "--detach",
    "--no-build",
    "--force-recreate",
    "runtime-fifteen-one",
  ]);
  await waitForRuntimeHealth("runtime-fifteen-one");
  await waitForRuntime(baseUrl, "binny-runs-one");

  const ownerAfterRecreation = await waitFor(
    () => readRuntimeExecutionState(baseUrl, "binny-runs-one"),
    (current) =>
      current.status === "online" &&
      current.runtimeId !== undefined &&
      current.runtimeId !== ownerBeforeRecreation.runtimeId,
    "无本地持久卷的轻量运行器重建后成功重新上线并申领新所有权",
  );

  const generationAfter = (
    await run(
      "docker",
      postgresExecArgs([
        "-c",
        "SELECT owner_generation FROM runtime_connections WHERE bin_id = 'binny-runs-one';",
      ]),
    )
  ).stdout.trim();
  assert.ok(BigInt(generationAfter) > BigInt(generationBefore));

  const stalePutResponse = await fetch(
    `${baseUrl}/bins/binny-runs-one/runtime/state`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeId: ownerBeforeRecreation.runtimeId,
        ownerGeneration: generationBefore,
        persistentState: { testSyncCursor: "stale-overwrite" },
      }),
    },
  );
  assert.equal(stalePutResponse.status, 409);
  const stalePutBody = (await stalePutResponse.json()) as {
    error: { code: string };
  };
  assert.equal(stalePutBody.error.code, "runtime_owner_mismatch");

  const getStateResponse = await fetch(
    `${baseUrl}/bins/binny-runs-one/runtime/state?runtimeId=${encodeURIComponent(
      ownerAfterRecreation.runtimeId!,
    )}&ownerGeneration=${encodeURIComponent(generationAfter)}`,
  );
  assert.equal(getStateResponse.status, 200);
  const getStateBody = (await getStateResponse.json()) as {
    persistentState?: { testSyncCursor?: string };
    sourceAccess?: { lease?: string; budgetRemaining?: number };
  };
  assert.deepEqual(getStateBody.persistentState, {
    testSyncCursor: "item-12345",
  });
  assert.deepEqual(getStateBody.sourceAccess, {
    lease: "active",
    budgetRemaining: 99,
  });

  const scheduleParameters = {
    sourceUrl: manualRunSourceRuntimeUrl(),
    gateKey: "schedule-cli-schedule",
    sourceKey: "schedule-cli-schedule-item",
  };
  const schedulesBeforeNativeRejection = cliData<{
    readonly schedules: readonly { readonly scheduleId: string }[];
  }>(
    await cli(baseUrl, ["schedule", "list", "--bin-id", "binny-runs-one"]),
    "listed",
  );
  cliFailure<{ readonly code: string }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      "binny-runs-one",
      "--expression",
      "0 0 0 1 1 *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({
        ...scheduleParameters,
        gateKey: "native-refine-reject",
      }),
    ]),
    "invalid_action_parameters",
  );
  const schedulesAfterNativeRejection = cliData<{
    readonly schedules: readonly { readonly scheduleId: string }[];
  }>(
    await cli(baseUrl, ["schedule", "list", "--bin-id", "binny-runs-one"]),
    "listed",
  );
  assert.deepEqual(
    schedulesAfterNativeRejection.schedules.map(({ scheduleId }) => scheduleId),
    schedulesBeforeNativeRejection.schedules.map(
      ({ scheduleId }) => scheduleId,
    ),
  );
  const createdSchedule = cliData<{
    readonly scheduleId: string;
    readonly expression: string;
    readonly action: string;
    readonly params: { readonly gateKey: string };
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      "binny-runs-one",
      "--expression",
      "0 0 0 1 1 *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify(scheduleParameters),
    ]),
    "created",
  );
  assert.equal(createdSchedule.expression, "0 0 0 1 1 *");
  assert.equal(createdSchedule.action, "collect");
  assert.equal(createdSchedule.params.gateKey, "schedule-cli-schedule");
  assert.equal(createdSchedule.enabled, true);
  const scheduleList = cliData<{
    readonly schedules: readonly { readonly scheduleId: string }[];
  }>(
    await cli(baseUrl, ["schedule", "list", "--bin-id", "binny-runs-one"]),
    "listed",
  );
  assert.ok(
    scheduleList.schedules.some(
      ({ scheduleId }) => scheduleId === createdSchedule.scheduleId,
    ),
  );
  const readableScheduleList = await cli(baseUrl, [
    "schedule",
    "list",
    "--bin-id",
    "binny-runs-one",
    "--output-format",
    "text",
  ]);
  assert.equal(readableScheduleList.code, 0, readableScheduleList.stderr);
  assert.match(readableScheduleList.stdout, /Schedules/u);
  assert.match(
    readableScheduleList.stdout,
    /binny schedule get binny-runs-one /u,
  );
  assert.doesNotMatch(readableScheduleList.stdout, /"schedules"/u);
  cliFailure<{ readonly code: string }>(
    await cli(baseUrl, [
      "schedule",
      "update",
      "binny-runs-one",
      createdSchedule.scheduleId,
      "--params",
      JSON.stringify({
        ...scheduleParameters,
        gateKey: "native-refine-reject",
      }),
    ]),
    "invalid_action_parameters",
  );
  const preservedSchedule = cliData<{
    readonly action: string;
    readonly params: { readonly gateKey: string };
  }>(
    await cli(baseUrl, [
      "schedule",
      "get",
      "binny-runs-one",
      createdSchedule.scheduleId,
    ]),
    "found",
  );
  assert.equal(preservedSchedule.action, "collect");
  assert.equal(preservedSchedule.params.gateKey, "schedule-cli-schedule");
  const updatedSchedule = cliData<{
    readonly expression: string;
    readonly timeZone: string;
    readonly action: string;
    readonly params: { readonly gateKey: string };
  }>(
    await cli(baseUrl, [
      "schedule",
      "update",
      "binny-runs-one",
      createdSchedule.scheduleId,
      "--expression",
      "0 0 0 1 2 *",
      "--time-zone",
      "Europe/London",
      "--action",
      "check",
      "--params",
      JSON.stringify({
        ...scheduleParameters,
        gateKey: "schedule-cli-schedule-updated",
      }),
    ]),
    "updated",
  );
  assert.equal(updatedSchedule.expression, "0 0 0 1 2 *");
  assert.equal(updatedSchedule.timeZone, "Europe/London");
  assert.equal(updatedSchedule.action, "check");
  assert.equal(updatedSchedule.params.gateKey, "schedule-cli-schedule-updated");
  const disabledSchedule = cliData<{ readonly enabled: boolean }>(
    await cli(baseUrl, [
      "schedule",
      "disable",
      "binny-runs-one",
      createdSchedule.scheduleId,
    ]),
    "disabled",
  );
  assert.equal(disabledSchedule.enabled, false);
  const enabledSchedule = cliData<{ readonly enabled: boolean }>(
    await cli(baseUrl, [
      "schedule",
      "enable",
      "binny-runs-one",
      createdSchedule.scheduleId,
    ]),
    "enabled",
  );
  assert.equal(enabledSchedule.enabled, true);
  const removedSchedule = cliData<{ readonly scheduleId: string }>(
    await cli(baseUrl, [
      "schedule",
      "remove",
      "binny-runs-one",
      createdSchedule.scheduleId,
    ]),
    "removed",
  );
  assert.equal(removedSchedule.scheduleId, createdSchedule.scheduleId);
  cliFailure<{ readonly code: string }>(
    await cli(baseUrl, [
      "schedule",
      "get",
      "binny-runs-one",
      createdSchedule.scheduleId,
    ]),
    "schedule_not_found",
  );
}

async function manualRunsHttpStep(
  baseUrl: string,
  manifest: unknown,
  options: {
    readonly stage?: "exercise" | "verify-after-restart";
    readonly itemId?: string;
  } = {},
): Promise<string | undefined> {
  const stage = options.stage ?? "exercise";
  const scriptArguments = [
    "scripts/manual-runs-http-e2e.ts",
    ...(stage === "exercise" ? [] : [stage]),
  ];
  const result = await run(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@binny/api",
      "exec",
      "node",
      "--conditions=source",
      ...scriptArguments,
    ],
    {
      env: {
        BINNY_E2E_BASE_URL: baseUrl,
        BINNY_RUNS_SOURCE_CONTROL_URL: manualRunSourceControlUrl(),
        BINNY_RUNS_RUNTIME_CONTROL_URL: "http://runtime-fifteen-one:8080",
        BINNY_RUNS_SOURCE_ADAPTER_MANIFEST: JSON.stringify(manifest),
        ...(options.itemId === undefined
          ? {}
          : { BINNY_E2E_TYPED_ARCHIVE_ITEM_ID: options.itemId }),
      },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  process.stdout.write(result.stdout);
  if (stage === "verify-after-restart") return undefined;
  const itemId = /^BINNY_TYPED_ARCHIVE_ITEM_ID=([0-9a-f-]+)$/mu.exec(
    result.stdout,
  )?.[1];
  assert.ok(itemId, "手工运行归档旅程应返回公开条目 ID。");
  return itemId;
}

async function verifyGlobalOperationsCli(baseUrl: string): Promise<void> {
  const runFilter = [
    "--action",
    "collect",
    "--status",
    "completed",
    "--created-from",
    "2020-01-01T00:00:00Z",
    "--created-before",
    "2099-01-01T00:00:00Z",
    "--limit",
    "1",
  ];
  const runs = new Map<
    string,
    { readonly runId: string; readonly binId: string }
  >();
  let cursor: string | undefined;
  do {
    const page = cliData<{
      readonly runs: readonly {
        readonly runId: string;
        readonly binId: string;
      }[];
      readonly nextCursor?: string;
    }>(
      await cli(baseUrl, [
        "run",
        "list",
        ...runFilter,
        ...(cursor === undefined ? [] : ["--cursor", cursor]),
      ]),
      "listed",
    );
    for (const run of page.runs) {
      assert.equal(Object.hasOwn(run, "params"), false);
      assert.equal(Object.hasOwn(run, "report"), false);
      assert.equal(Object.hasOwn(run, "result"), false);
      assert.equal(runs.has(run.runId), false);
      runs.set(run.runId, run);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  const runBinIds = new Set([...runs.values()].map(({ binId }) => binId));
  assert.ok(runBinIds.has("binny-runs-one"));
  assert.ok(runBinIds.has("binny-runs-two"));
  const selectedRun = runs.values().next().value;
  assert.ok(selectedRun);
  const runDetail = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", selectedRun.binId, selectedRun.runId]),
    "found",
  );
  assert.equal(runDetail.runId, selectedRun.runId);
  const readableRunDetail = await cli(baseUrl, [
    "run",
    "get",
    selectedRun.binId,
    selectedRun.runId,
    "--output-format",
    "text",
  ]);
  assert.equal(readableRunDetail.code, 0, readableRunDetail.stderr);
  assert.match(readableRunDetail.stdout, /^Run\n/u);
  assert.match(
    readableRunDetail.stdout,
    new RegExp(`Bin: ${selectedRun.binId}`, "u"),
  );
  assert.match(readableRunDetail.stdout, /Result:\n/u);
  assert.doesNotMatch(readableRunDetail.stdout, /"runId":/u);

  const readableRunList = await cli(baseUrl, [
    "run",
    "list",
    "--output-format",
    "text",
  ]);
  assert.equal(readableRunList.code, 0, readableRunList.stderr);
  assert.match(readableRunList.stdout, /Runs/u);
  assert.match(readableRunList.stdout, /binny run get /u);
  assert.doesNotMatch(readableRunList.stdout, /"runs"/u);

  const schedules: { readonly binId: string; readonly scheduleId: string }[] =
    [];
  try {
    for (const input of [
      { binId: "binny-runs-one", enabled: true, suffix: "one" },
      { binId: "binny-runs-two", enabled: false, suffix: "two" },
    ]) {
      const params = {
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey: "global-cli-schedule-" + input.suffix,
        sourceKey: "global-cli-schedule-" + input.suffix,
      };
      const result = cliData<{ readonly scheduleId: string }>(
        await cli(baseUrl, [
          "schedule",
          "create",
          input.binId,
          "--expression",
          "0 0 0 1 1 *",
          "--time-zone",
          "UTC",
          "--action",
          "collect",
          "--params",
          JSON.stringify(params),
          ...(input.enabled ? [] : ["--disabled"]),
        ]),
        "created",
      );
      schedules.push({ binId: input.binId, scheduleId: result.scheduleId });
    }

    const scheduleIds = new Set<string>();
    const scheduleBinIds = new Set<string>();
    cursor = undefined;
    do {
      const page: {
        readonly schedules: readonly {
          readonly scheduleId: string;
          readonly binId: string;
        }[];
        readonly nextCursor?: string;
      } = cliData<{
        readonly schedules: readonly {
          readonly scheduleId: string;
          readonly binId: string;
        }[];
        readonly nextCursor?: string;
      }>(
        await cli(baseUrl, [
          "schedule",
          "list",
          "--action",
          "collect",
          "--limit",
          "1",
          ...(cursor === undefined ? [] : ["--cursor", cursor]),
        ]),
        "listed",
      );
      for (const schedule of page.schedules) {
        assert.equal(Object.hasOwn(schedule, "params"), false);
        assert.equal(scheduleIds.has(schedule.scheduleId), false);
        scheduleIds.add(schedule.scheduleId);
        scheduleBinIds.add(schedule.binId);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    assert.deepEqual(
      scheduleIds,
      new Set(schedules.map(({ scheduleId }) => scheduleId)),
    );
    assert.deepEqual(
      scheduleBinIds,
      new Set(["binny-runs-one", "binny-runs-two"]),
    );

    const disabledPlans = cliData<{
      readonly schedules: readonly {
        readonly scheduleId: string;
        readonly binId: string;
        readonly enabled: boolean;
      }[];
    }>(
      await cli(baseUrl, [
        "schedule",
        "list",
        "--action",
        "collect",
        "--enabled",
        "false",
      ]),
      "listed",
    );
    assert.deepEqual(
      disabledPlans.schedules.map(({ binId, enabled }) => ({ binId, enabled })),
      [{ binId: "binny-runs-two", enabled: false }],
    );
    const scheduleDetail = cliData<{
      readonly params: { readonly gateKey: string };
    }>(
      await cli(baseUrl, [
        "schedule",
        "get",
        disabledPlans.schedules[0]!.binId,
        disabledPlans.schedules[0]!.scheduleId,
      ]),
      "found",
    );
    assert.equal(scheduleDetail.params.gateKey, "global-cli-schedule-two");
    const readableScheduleDetail = await cli(baseUrl, [
      "schedule",
      "get",
      disabledPlans.schedules[0]!.binId,
      disabledPlans.schedules[0]!.scheduleId,
      "--output-format",
      "text",
    ]);
    assert.equal(readableScheduleDetail.code, 0, readableScheduleDetail.stderr);
    assert.match(readableScheduleDetail.stdout, /^Schedule\n/u);
    assert.match(
      readableScheduleDetail.stdout,
      new RegExp(`Bin: ${disabledPlans.schedules[0]!.binId}`, "u"),
    );
    assert.match(readableScheduleDetail.stdout, /Parameters:\n/u);
    assert.match(
      readableScheduleDetail.stdout,
      /"gateKey": "global-cli-schedule-two"/u,
    );
    assert.doesNotMatch(readableScheduleDetail.stdout, /"scheduleId":/u);

    const readableScheduleList = await cli(baseUrl, [
      "schedule",
      "list",
      "--output-format",
      "text",
    ]);
    assert.equal(readableScheduleList.code, 0, readableScheduleList.stderr);
    assert.match(readableScheduleList.stdout, /Schedules/u);
    assert.match(readableScheduleList.stdout, /binny schedule get /u);
    assert.doesNotMatch(readableScheduleList.stdout, /"schedules"/u);
  } finally {
    for (const schedule of schedules) {
      cliData<{ readonly scheduleId: string }>(
        await cli(baseUrl, [
          "schedule",
          "remove",
          schedule.binId,
          schedule.scheduleId,
        ]),
        "removed",
      );
    }
  }
}

async function scheduledRunsStep(
  baseUrl: string,
  heartbeatProxy: HeartbeatDelayProxy,
): Promise<string> {
  const binId = "binny-runs-one";
  const sourceControlUrl = manualRunSourceControlUrl();
  const sourceUrl = manualRunSourceRuntimeUrl();
  const collectGateKey = "schedule-scheduled-collect-" + randomUUID();
  const checkGateKey = "schedule-scheduled-check-" + randomUUID();

  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  await waitForApiAndDatabase(baseUrl);
  await waitForRuntime(baseUrl, binId);
  await waitForManualRunSource();

  const shortOutageGateKey = "schedule-short-outage-" + randomUUID();
  const shortOutageSchedule = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      binId,
      "--expression",
      "*/20 * * * * *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl,
        gateKey: shortOutageGateKey,
        sourceKey: shortOutageGateKey,
      }),
      "--disabled",
    ]),
    "created",
  );
  assert.equal(shortOutageSchedule.enabled, false);
  const disabledFirstDueAt = Date.parse(shortOutageSchedule.nextDueAt);
  await wait(disabledFirstDueAt - Date.now() + 100);
  const enabledShortOutageSchedule = cliData<{
    readonly nextDueAt: string;
  }>(
    await cli(baseUrl, [
      "schedule",
      "enable",
      binId,
      shortOutageSchedule.scheduleId,
    ]),
    "enabled",
  );
  const shortOutageScheduledAt = Date.parse(
    enabledShortOutageSchedule.nextDueAt,
  );
  assert.ok(shortOutageScheduledAt - Date.now() > 15_000);

  await wait(Math.max(0, shortOutageScheduledAt - Date.now() - 8_500));
  await heartbeatProxy.armRequestBody();
  const heldHeartbeat = await heartbeatProxy.waitUntilRequestBodyHeld();
  assert.ok(heldHeartbeat.heldAt < shortOutageScheduledAt - 4_500);
  const serverContainerId = (await compose(["ps", "-q", "server"])).stdout
    .trim()
    .split("\n")[0];
  assert.ok(serverContainerId !== undefined && serverContainerId.length > 0);
  const signalEvents = startManagedProcess("docker", [
    "events",
    "--filter",
    `container=${serverContainerId}`,
    "--filter",
    "event=kill",
    "--format",
    "{{.Actor.Attributes.signal}}",
  ]);
  await wait(Math.max(0, shortOutageScheduledAt - Date.now() - 4_500));
  const shortOutageStartedAt = Date.now();
  let stopCompletedAt: number | undefined;
  const stopPromise = compose(["stop", "server"]).then((result) => {
    stopCompletedAt = Date.now();
    return result;
  });
  let signalObservedAt: number | undefined;
  let requestBodyReleasedAt: number | undefined;
  let signalError: unknown;
  try {
    await signalEvents.waitForMarker("15");
    signalObservedAt = Date.now();
    await wait(2_000);
  } catch (error) {
    signalError = error;
  } finally {
    signalEvents.child.kill("SIGTERM");
    await signalEvents.waitForClose();
    requestBodyReleasedAt = Date.now();
    await heartbeatProxy.release();
  }
  await stopPromise;
  const shortOutageStoppedAt = stopCompletedAt ?? Date.now();
  if (signalError !== undefined) throw signalError;
  const unrelatedRequestStatus = await heartbeatProxy.forwardUnrelatedRequest();
  const heartbeatResponse = await heartbeatProxy.waitUntilRequestBodyResponse();
  process.stdout.write(
    `Scheduled-run shutdown: heartbeat held ${String(shortOutageScheduledAt - heldHeartbeat.heldAt)}ms before due; SIGTERM observed ${String((signalObservedAt ?? shortOutageStartedAt) - shortOutageStartedAt)}ms after stop start; body released ${String((requestBodyReleasedAt ?? shortOutageStartedAt) - (signalObservedAt ?? shortOutageStartedAt))}ms after SIGTERM; held heartbeat HTTP ${String(heartbeatResponse.statusCode)}; unrelated proxy request HTTP ${String(unrelatedRequestStatus)}; latest forwarded HTTP ${String(heartbeatResponse.latestForwardedStatusCode)}; held error ${heartbeatResponse.error ?? "none"}; server stop ${String(shortOutageStoppedAt - shortOutageStartedAt)}ms; due margin ${String(shortOutageScheduledAt - shortOutageStoppedAt)}ms.\n`,
  );
  assert.equal(unrelatedRequestStatus, 502);
  assert.equal(heartbeatResponse.latestForwardedStatusCode, 502);
  assert.equal(
    heartbeatResponse.statusCode,
    200,
    `Held heartbeat failed: ${heartbeatResponse.error ?? "no upstream error"}`,
  );
  assert.ok(
    shortOutageScheduledAt - shortOutageStoppedAt > 500,
    `所有 server 停止时应距离触发仍超过0.5秒，实际 ${String(shortOutageScheduledAt - shortOutageStoppedAt)}ms。`,
  );
  await wait(shortOutageScheduledAt - shortOutageStoppedAt + 250);
  await compose(["start", "server"]);
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  await waitForApiAndDatabase(baseUrl);
  const shortOutageResumedAt = Date.now();
  assert.ok(
    shortOutageResumedAt - shortOutageStartedAt < 10_000,
    `全部 core 停机和恢复耗时应少于10秒，实际 ${String(shortOutageResumedAt - shortOutageStartedAt)}ms。`,
  );
  await waitForRuntime(baseUrl, binId);
  await wait(1_500);

  const shortOutageAfterRestart = cliData<{
    readonly nextDueAt: string;
    readonly lastRunId?: string;
  }>(
    await cli(baseUrl, [
      "schedule",
      "get",
      binId,
      shortOutageSchedule.scheduleId,
    ]),
    "found",
  );
  assert.equal(shortOutageAfterRestart.lastRunId, undefined);
  assert.ok(Date.parse(shortOutageAfterRestart.nextDueAt) > Date.now());
  assert.equal(
    await countSourceArrivals(sourceControlUrl, shortOutageGateKey, binId),
    0,
  );
  cliData(
    await cli(baseUrl, [
      "schedule",
      "remove",
      binId,
      shortOutageSchedule.scheduleId,
    ]),
    "removed",
  );

  // 两个正式 server 实例共享 PostgreSQL，验证竞争扫描只会排入一次到期运行。
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "120",
    "--scale",
    "server=2",
    "server",
  ]);
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  await waitForApiAndDatabase(baseUrl);
  await waitForRuntime(baseUrl, binId);

  const serverInstances = (await compose(["ps", "-q", "server"])).stdout
    .trim()
    .split("\n")
    .filter((containerId) => containerId.length > 0);
  assert.equal(serverInstances.length, 2);
  const singleServerRestart = await run(
    "docker",
    ["restart", serverInstances[0]!],
    { env: composeEnvironment() },
  );
  assert.equal(singleServerRestart.code, 0, singleServerRestart.stderr);
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  await waitForApiAndDatabase(baseUrl);
  await waitForRuntime(baseUrl, binId);

  const collectSchedule = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      binId,
      "--expression",
      "*/30 * * * * *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl,
        gateKey: collectGateKey,
        sourceKey: collectGateKey,
      }),
      "--disabled",
    ]),
    "created",
  );
  assert.equal(collectSchedule.enabled, false);
  const firstDueAt = Date.parse(collectSchedule.nextDueAt);
  assert.ok(firstDueAt > Date.now());
  if (firstDueAt - Date.now() < 20_000)
    await wait(firstDueAt - Date.now() + 100);

  const enabledCollectSchedule = cliData<{
    readonly nextDueAt: string;
  }>(
    await cli(baseUrl, [
      "schedule",
      "enable",
      binId,
      collectSchedule.scheduleId,
    ]),
    "enabled",
  );
  const scheduledFor = enabledCollectSchedule.nextDueAt;
  const scheduledTimestamp = Date.parse(scheduledFor);
  assert.ok(scheduledTimestamp - Date.now() > 15_000);

  const dueDate = new Date(scheduledTimestamp);
  const checkExpression = [
    dueDate.getUTCSeconds(),
    dueDate.getUTCMinutes(),
    dueDate.getUTCHours(),
    dueDate.getUTCDate(),
    dueDate.getUTCMonth() + 1,
    "*",
  ].join(" ");
  const checkSchedule = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      binId,
      "--expression",
      checkExpression,
      "--time-zone",
      "UTC",
      "--action",
      "check",
      "--params",
      JSON.stringify({
        sourceUrl,
        gateKey: checkGateKey,
        sourceKey: checkGateKey,
      }),
    ]),
    "created",
  );
  assert.equal(checkSchedule.enabled, true);
  assert.equal(checkSchedule.nextDueAt, scheduledFor);
  const schedules = cliData<{
    readonly schedules: readonly { readonly scheduleId: string }[];
  }>(await cli(baseUrl, ["schedule", "list", "--bin-id", binId]), "listed");
  assert.ok(
    schedules.schedules.some(
      ({ scheduleId }) => scheduleId === collectSchedule.scheduleId,
    ),
  );
  assert.ok(
    schedules.schedules.some(
      ({ scheduleId }) => scheduleId === checkSchedule.scheduleId,
    ),
  );

  await wait(Math.max(0, scheduledTimestamp - Date.now() - 5_000));
  assert.ok(scheduledTimestamp - Date.now() >= 4_000);
  await compose(["stop", "runtime-fifteen-one"]);
  const collectAfterFirstTrigger = await waitFor(
    async () =>
      cliData<{
        readonly nextDueAt: string;
        readonly lastRunId?: string;
      }>(
        await cli(baseUrl, [
          "schedule",
          "get",
          binId,
          collectSchedule.scheduleId,
        ]),
        "found",
      ),
    (schedule) => schedule.lastRunId !== undefined,
    "活 core 应为短轮询延迟到期计划创建运行",
  );
  const checkAfterFirstTrigger = await waitFor(
    async () =>
      cliData<{
        readonly nextDueAt: string;
        readonly lastRunId?: string;
      }>(
        await cli(baseUrl, [
          "schedule",
          "get",
          binId,
          checkSchedule.scheduleId,
        ]),
        "found",
      ),
    (schedule) => schedule.lastRunId !== undefined,
    "第二个活 core 并发扫描也应创建对应计划运行",
  );
  assert.ok(collectAfterFirstTrigger.lastRunId !== undefined);
  assert.ok(checkAfterFirstTrigger.lastRunId !== undefined);
  const collectQueuedRun = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "get",
      binId,
      collectAfterFirstTrigger.lastRunId,
    ]),
    "found",
  );
  const checkQueuedRun = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", binId, checkAfterFirstTrigger.lastRunId]),
    "found",
  );
  for (const [runState, scheduleId, action] of [
    [collectQueuedRun, collectSchedule.scheduleId, "collect"],
    [checkQueuedRun, checkSchedule.scheduleId, "check"],
  ] as const) {
    assert.equal(runState.status, "queued");
    assert.equal(runState.queueReason, "runtime_offline");
    assert.equal(runState.action, action);
    assert.equal(runState.trigger.kind, "schedule");
    if (runState.trigger.kind === "schedule") {
      assert.equal(runState.trigger.scheduleId, scheduleId);
      assert.equal(runState.trigger.scheduledFor, scheduledFor);
    }
    assert.ok(Date.parse(runState.createdAt) >= scheduledTimestamp);
    assert.ok(Date.parse(runState.createdAt) - scheduledTimestamp < 5_000);
  }
  assert.equal(
    await countSourceArrivals(sourceControlUrl, collectGateKey, binId),
    0,
  );
  assert.equal(
    await countSourceArrivals(sourceControlUrl, checkGateKey, binId),
    0,
  );

  const nextCollectDueAt = Date.parse(collectAfterFirstTrigger.nextDueAt);
  assert.ok(nextCollectDueAt > Date.now());
  await wait(Math.max(0, nextCollectDueAt - Date.now() - 15_000));
  assert.ok(nextCollectDueAt - Date.now() > 10_000);
  await compose(["stop", "server"]);
  await wait(65_000);
  await compose(["start", "server"]);
  const apiUrlBeforeRestart = baseUrl;
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  process.stdout.write(
    `计划服务端点重启后刷新：${apiUrlBeforeRestart} -> ${baseUrl}\n`,
  );
  await waitForApiAndDatabase(baseUrl);

  const resumedCollectSchedule = cliData<{
    readonly nextDueAt: string;
    readonly lastRunId?: string;
  }>(
    await cli(baseUrl, ["schedule", "get", binId, collectSchedule.scheduleId]),
    "found",
  );
  const resumedCheckSchedule = cliData<{
    readonly nextDueAt: string;
    readonly lastRunId?: string;
  }>(
    await cli(baseUrl, ["schedule", "get", binId, checkSchedule.scheduleId]),
    "found",
  );
  assert.ok(Date.parse(resumedCollectSchedule.nextDueAt) > Date.now());
  assert.ok(Date.parse(resumedCheckSchedule.nextDueAt) > Date.now());
  assert.equal(resumedCollectSchedule.lastRunId, collectQueuedRun.runId);
  assert.equal(resumedCheckSchedule.lastRunId, checkQueuedRun.runId);
  assert.equal(
    cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, collectQueuedRun.runId]),
      "found",
    ).status,
    "queued",
  );
  assert.equal(
    cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, checkQueuedRun.runId]),
      "found",
    ).status,
    "queued",
  );
  assert.equal(
    await countSourceArrivals(sourceControlUrl, collectGateKey, binId),
    0,
  );
  assert.equal(
    await countSourceArrivals(sourceControlUrl, checkGateKey, binId),
    0,
  );

  await compose(["start", "runtime-fifteen-one"]);
  await waitForRuntime(baseUrl, binId);

  const controlArrivals = [collectGateKey, checkGateKey] as const;
  const firstArrival = await waitForScheduledArrival(
    sourceControlUrl,
    controlArrivals,
    binId,
  );
  const firstScheduleId =
    firstArrival.gateKey === collectGateKey
      ? collectSchedule.scheduleId
      : checkSchedule.scheduleId;
  const secondGateKey =
    firstArrival.gateKey === collectGateKey ? checkGateKey : collectGateKey;
  const secondScheduleId =
    firstArrival.gateKey === collectGateKey
      ? checkSchedule.scheduleId
      : collectSchedule.scheduleId;
  await waitForSourceArrival(
    sourceControlUrl,
    firstArrival.gateKey,
    firstArrival.runId,
    binId,
  );
  const firstRun = await waitForCliManualRunState(
    baseUrl,
    binId,
    firstArrival.runId,
    ["executing"],
  );
  assert.equal(firstRun.trigger.kind, "schedule");
  assert.equal(
    firstRun.action,
    firstArrival.gateKey === collectGateKey ? "collect" : "check",
  );
  if (firstRun.trigger.kind === "schedule") {
    assert.equal(firstRun.trigger.scheduleId, firstScheduleId);
    assert.equal(firstRun.trigger.scheduledFor, scheduledFor);
    assert.equal(firstRun.referenceTime, firstRun.trigger.scheduledFor);
  }

  assert.ok(Date.parse(resumedCollectSchedule.nextDueAt) > Date.now());
  assert.ok(Date.parse(resumedCheckSchedule.nextDueAt) > Date.now());

  assert.equal(
    await countSourceArrivals(sourceControlUrl, secondGateKey, binId),
    0,
  );
  await wait(300);
  assert.equal(
    await countSourceArrivals(sourceControlUrl, secondGateKey, binId),
    0,
  );

  for (const scheduleId of [
    collectSchedule.scheduleId,
    checkSchedule.scheduleId,
  ]) {
    cliData(
      await cli(baseUrl, ["schedule", "disable", binId, scheduleId]),
      "disabled",
    );
  }

  const firstDisposition =
    firstArrival.gateKey === collectGateKey ? "material" : "available";
  await releaseSource(sourceControlUrl, firstArrival.gateKey, firstDisposition);
  const completedFirst = await waitForCliManualRunState(
    baseUrl,
    binId,
    firstRun.runId,
    ["completed", "failed"],
  );
  assert.equal(completedFirst.status, "completed");
  if (completedFirst.action === "collect")
    assert.equal(completedFirst.result?.commits.length, 1);
  else assert.ok(completedFirst.result?.output !== undefined);

  const secondArrival = await waitForScheduledArrival(
    sourceControlUrl,
    [secondGateKey],
    binId,
  );
  assert.equal(secondArrival.gateKey, secondGateKey);
  assert.notEqual(secondArrival.runId, firstArrival.runId);
  const secondRun = await waitForCliManualRunState(
    baseUrl,
    binId,
    secondArrival.runId,
    ["executing"],
  );
  assert.equal(secondRun.trigger.kind, "schedule");
  assert.equal(
    secondRun.action,
    secondGateKey === collectGateKey ? "collect" : "check",
  );
  if (secondRun.trigger.kind === "schedule") {
    assert.equal(secondRun.trigger.scheduleId, secondScheduleId);
    assert.equal(secondRun.trigger.scheduledFor, scheduledFor);
    assert.equal(secondRun.referenceTime, secondRun.trigger.scheduledFor);
  }
  const secondDisposition =
    secondGateKey === collectGateKey ? "material" : "available";
  await releaseSource(sourceControlUrl, secondGateKey, secondDisposition);
  const completedSecond = await waitForCliManualRunState(
    baseUrl,
    binId,
    secondRun.runId,
    ["completed", "failed"],
  );
  assert.equal(completedSecond.status, "completed");
  if (completedSecond.action === "collect")
    assert.equal(completedSecond.result?.commits.length, 1);
  else assert.ok(completedSecond.result?.output !== undefined);

  const manualGateKey = "schedule-scheduled-queue-marker-" + randomUUID();
  const manualRun = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl,
        gateKey: manualGateKey,
        sourceKey: manualGateKey,
      }),
    ]),
    "triggered",
  );
  assert.equal(manualRun.status, "queued");
  await waitForSourceArrival(
    sourceControlUrl,
    manualGateKey,
    manualRun.runId,
    binId,
  );
  const completedManualRun = await waitForCliManualRunState(
    baseUrl,
    binId,
    manualRun.runId,
    ["executing"],
  );
  assert.equal(completedManualRun.trigger.kind, "manual");
  await releaseSource(sourceControlUrl, manualGateKey, "material");
  const finishedManualRun = await waitForCliManualRunState(
    baseUrl,
    binId,
    manualRun.runId,
    ["completed", "failed"],
  );
  assert.equal(finishedManualRun.status, "completed");

  // 队尾人工运行到达前，所有并发扫描已排入的计划运行都应已先行执行。
  assert.equal(
    await countSourceArrivals(sourceControlUrl, collectGateKey, binId),
    1,
  );
  assert.equal(
    await countSourceArrivals(sourceControlUrl, checkGateKey, binId),
    1,
  );
  assert.equal(completedFirst.result?.stopReason.code, "completed");
  assert.equal(completedSecond.result?.stopReason.code, "completed");

  for (const [scheduleId, runId] of [
    [
      collectSchedule.scheduleId,
      firstArrival.gateKey === collectGateKey
        ? firstRun.runId
        : secondRun.runId,
    ],
    [
      checkSchedule.scheduleId,
      firstArrival.gateKey === checkGateKey ? firstRun.runId : secondRun.runId,
    ],
  ] as const) {
    cliData(
      await cli(baseUrl, ["schedule", "remove", binId, scheduleId]),
      "removed",
    );
    const retained = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, runId]),
      "found",
    );
    assert.equal(retained.trigger.kind, "schedule");
    if (retained.trigger.kind === "schedule")
      assert.equal(retained.trigger.scheduleId, scheduleId);
    const historyAfterPlanRemoval = cliData<{
      readonly runs: readonly { readonly runId: string }[];
    }>(
      await cli(baseUrl, [
        "run",
        "list",
        "--bin-id",
        binId,
        "--action",
        retained.action,
        "--status",
        "completed",
        "--created-from",
        retained.createdAt,
        "--created-before",
        "2099-01-01T00:00:00Z",
        "--limit",
        "100",
      ]),
      "listed",
    );
    assert.ok(
      historyAfterPlanRemoval.runs.some(
        ({ runId: listedRunId }) => listedRunId === runId,
      ),
      "删除运行计划后，已完成运行仍可通过运行列表发现。",
    );
  }

  const inspectServer = async (containerId: string) => {
    const result = await run(
      "docker",
      [
        "inspect",
        "--format",
        "{{.Name}}|{{.Id}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.State.Status}}",
        containerId,
      ],
      { env: composeEnvironment() },
    );
    assert.equal(result.code, 0, result.stderr);
    const [name, id, pidText, startedAt, status] = result.stdout
      .trim()
      .split("|");
    assert.ok(name !== undefined && id !== undefined);
    assert.ok(pidText !== undefined && startedAt !== undefined);
    const replicaNumber = /-server-(\d+)$/u.exec(name)?.[1];
    assert.ok(replicaNumber !== undefined);
    return {
      containerId,
      id,
      name,
      pid: Number(pidText),
      replicaNumber: Number(replicaNumber),
      startedAt,
      status,
    };
  };
  const serverReplicas = await Promise.all(
    serverInstances.map((containerId) => inspectServer(containerId)),
  );
  const serverA = serverReplicas.find(
    ({ replicaNumber }) => replicaNumber === 1,
  );
  const serverB = serverReplicas.find(
    ({ replicaNumber }) => replicaNumber === 2,
  );
  assert.ok(serverA !== undefined && serverB !== undefined);
  const serverABeforePostgresRestart = await inspectServer(serverA.containerId);
  const serverBBeforePostgresRestart = await inspectServer(serverB.containerId);
  assert.equal(serverABeforePostgresRestart.status, "running");
  assert.equal(serverBBeforePostgresRestart.status, "running");

  composePort = await publishedPort("server", 3000, 1);
  baseUrl = apiBaseUrl();
  await compose(["restart", "postgres"]);
  await waitForApiAndDatabase(baseUrl);
  await wait(1_500);
  const serverAAfterPostgresRestart = await inspectServer(serverA.containerId);
  const serverBAfterPostgresRestart = await inspectServer(serverB.containerId);
  assert.deepEqual(
    {
      id: serverAAfterPostgresRestart.id,
      pid: serverAAfterPostgresRestart.pid,
      startedAt: serverAAfterPostgresRestart.startedAt,
      status: serverAAfterPostgresRestart.status,
    },
    {
      id: serverABeforePostgresRestart.id,
      pid: serverABeforePostgresRestart.pid,
      startedAt: serverABeforePostgresRestart.startedAt,
      status: "running",
    },
  );
  assert.deepEqual(
    {
      id: serverBAfterPostgresRestart.id,
      pid: serverBAfterPostgresRestart.pid,
      startedAt: serverBAfterPostgresRestart.startedAt,
      status: serverBAfterPostgresRestart.status,
    },
    {
      id: serverBBeforePostgresRestart.id,
      pid: serverBBeforePostgresRestart.pid,
      startedAt: serverBBeforePostgresRestart.startedAt,
      status: "running",
    },
  );

  const stoppedRecoveryServer = await run(
    "docker",
    ["stop", serverB.containerId],
    { env: composeEnvironment() },
  );
  assert.equal(stoppedRecoveryServer.code, 0, stoppedRecoveryServer.stderr);
  await compose(["create", "--no-recreate", "--scale", "server=2", "server"]);
  const serverAAfterReplicaPrepare = await inspectServer(serverA.containerId);
  assert.equal(serverAAfterReplicaPrepare.status, "running");
  assert.equal(serverAAfterReplicaPrepare.id, serverABeforePostgresRestart.id);
  assert.equal(
    serverAAfterReplicaPrepare.pid,
    serverABeforePostgresRestart.pid,
  );
  assert.equal(
    serverAAfterReplicaPrepare.startedAt,
    serverABeforePostgresRestart.startedAt,
  );
  const preparedServerB = await inspectServer(serverB.containerId);
  if (preparedServerB.status === "running") {
    const stoppedPreparedServerB = await run(
      "docker",
      ["stop", serverB.containerId],
      { env: composeEnvironment() },
    );
    assert.equal(stoppedPreparedServerB.code, 0, stoppedPreparedServerB.stderr);
  }
  composePort = await publishedPort("server", 3000, 1);
  baseUrl = apiBaseUrl();
  const postgresRecoveryGateKey = "schedule-postgres-recovery-" + randomUUID();
  const recoverySchedule = cliData<{
    readonly scheduleId: string;
    readonly nextDueAt: string;
    readonly enabled: boolean;
  }>(
    await cli(baseUrl, [
      "schedule",
      "create",
      binId,
      "--expression",
      "*/30 * * * * *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl,
        gateKey: postgresRecoveryGateKey,
        sourceKey: postgresRecoveryGateKey,
      }),
      "--disabled",
    ]),
    "created",
  );
  let recoveryScheduleId: string | undefined = recoverySchedule.scheduleId;
  let recoveryScheduleRemoved = false;
  let serverAPaused = false;
  let recoveryRunnerStopped = false;
  try {
    assert.equal(recoverySchedule.enabled, false);
    const recoveryFirstDueAt = Date.parse(recoverySchedule.nextDueAt);
    if (recoveryFirstDueAt - Date.now() < 20_000)
      await wait(recoveryFirstDueAt - Date.now() + 100);
    const enabledRecoverySchedule = cliData<{
      readonly nextDueAt: string;
    }>(
      await cli(baseUrl, [
        "schedule",
        "enable",
        binId,
        recoverySchedule.scheduleId,
      ]),
      "enabled",
    );
    const recoveryScheduledFor = enabledRecoverySchedule.nextDueAt;
    const recoveryScheduledAt = Date.parse(recoveryScheduledFor);
    assert.ok(recoveryScheduledAt - Date.now() > 15_000);
    const recoveryScheduleBeforePause = cliData<{
      readonly nextDueAt: string;
      readonly lastRunId?: string;
    }>(
      await cli(baseUrl, [
        "schedule",
        "get",
        binId,
        recoverySchedule.scheduleId,
      ]),
      "found",
    );
    assert.equal(recoveryScheduleBeforePause.lastRunId, undefined);
    assert.ok(Date.parse(recoveryScheduleBeforePause.nextDueAt) > Date.now());

    await compose(["stop", "runtime-fifteen-one"]);
    recoveryRunnerStopped = true;
    await waitFor(
      async () =>
        cliData<{ readonly execution: { readonly status: string } }>(
          await cli(baseUrl, ["bin", "get", binId]),
          "found",
        ),
      (bin) => bin.execution.status !== "online",
      "PostgreSQL 恢复验收在计划到期前停止运行器",
    );
    await wait(Math.max(0, recoveryScheduledAt - Date.now() - 4_000));
    assert.ok(recoveryScheduledAt > Date.now());

    const pausedServer = await run("docker", ["pause", serverA.containerId], {
      env: composeEnvironment(),
    });
    assert.equal(pausedServer.code, 0, pausedServer.stderr);
    serverAPaused = true;
    const serverABeforeReplicaStart = await inspectServer(serverA.containerId);
    assert.equal(serverABeforeReplicaStart.status, "paused");
    assert.equal(serverABeforeReplicaStart.id, serverABeforePostgresRestart.id);
    assert.equal(
      serverABeforeReplicaStart.pid,
      serverABeforePostgresRestart.pid,
    );
    assert.equal(
      serverABeforeReplicaStart.startedAt,
      serverABeforePostgresRestart.startedAt,
    );
    await wait(recoveryScheduledAt - Date.now() + 250);

    const startedRecoveryServer = await run(
      "docker",
      ["start", serverB.containerId],
      { env: composeEnvironment() },
    );
    assert.equal(startedRecoveryServer.code, 0, startedRecoveryServer.stderr);
    composePort = await publishedPort("server", 3000, 2);
    baseUrl = apiBaseUrl();
    await waitForApiAndDatabase(baseUrl);
    const serverAAfterReplicaStart = await inspectServer(serverA.containerId);
    assert.equal(serverAAfterReplicaStart.status, "paused");
    assert.equal(serverAAfterReplicaStart.id, serverABeforePostgresRestart.id);
    assert.equal(
      serverAAfterReplicaStart.pid,
      serverABeforePostgresRestart.pid,
    );
    assert.equal(
      serverAAfterReplicaStart.startedAt,
      serverABeforePostgresRestart.startedAt,
    );

    const recoveryScheduleAfterStart = await waitFor(
      async () =>
        cliData<{
          readonly nextDueAt: string;
          readonly lastRunId?: string;
        }>(
          await cli(baseUrl, [
            "schedule",
            "get",
            binId,
            recoverySchedule.scheduleId,
          ]),
          "found",
        ),
      (schedule) => schedule.lastRunId !== undefined,
      "PostgreSQL reserved session 恢复后 B 应触发计划 D",
    );
    assert.ok(recoveryScheduleAfterStart.lastRunId !== undefined);
    const recoveryRun = cliData<ManualRunCliState>(
      await cli(baseUrl, [
        "run",
        "get",
        binId,
        recoveryScheduleAfterStart.lastRunId,
      ]),
      "found",
    );
    assert.equal(recoveryRun.status, "queued");
    assert.equal(recoveryRun.queueReason, "runtime_offline");
    assert.equal(recoveryRun.action, "collect");
    assert.equal(recoveryRun.trigger.kind, "schedule");
    if (recoveryRun.trigger.kind === "schedule") {
      assert.equal(recoveryRun.trigger.scheduleId, recoverySchedule.scheduleId);
      assert.equal(recoveryRun.trigger.scheduledFor, recoveryScheduledFor);
      assert.equal(recoveryRun.referenceTime, recoveryRun.trigger.scheduledFor);
    }

    cliData(
      await cli(baseUrl, [
        "schedule",
        "remove",
        binId,
        recoverySchedule.scheduleId,
      ]),
      "removed",
    );
    recoveryScheduleRemoved = true;
    const cancelledRecoveryRun = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "cancel", binId, recoveryRun.runId]),
      "cancellation",
    );
    assert.equal(cancelledRecoveryRun.runId, recoveryRun.runId);
    assert.equal(cancelledRecoveryRun.status, "cancelled");
    assert.ok(cancelledRecoveryRun.stopConfirmedAt);
  } finally {
    if (serverAPaused) {
      const unpausedServer = await run(
        "docker",
        ["unpause", serverA.containerId],
        { env: composeEnvironment() },
      );
      if (unpausedServer.code !== 0)
        process.stderr.write(unpausedServer.stderr);
      else serverAPaused = false;
    }
    composePort = await publishedPort("server", 3000, 1);
    baseUrl = apiBaseUrl();
    if (!recoveryScheduleRemoved && recoveryScheduleId !== undefined) {
      const removed = await cli(baseUrl, [
        "schedule",
        "remove",
        binId,
        recoveryScheduleId,
      ]);
      if (removed.code === 0) recoveryScheduleRemoved = true;
      else process.stderr.write(removed.stderr);
    }
    if (recoveryRunnerStopped) await compose(["start", "runtime-fifteen-one"]);
  }

  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "120",
    "--scale",
    "server=1",
    "server",
  ]);
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  await verifyScheduleOverlapPolicy(baseUrl);
  process.stdout.write(
    "计划的跨重启合并触发、并发扫描去重、同 bin 串行、来源保留与正式 runner 结果通过。\n",
  );
  return baseUrl;
}

async function verifyScheduleOverlapPolicy(baseUrl: string): Promise<void> {
  const binId = "binny-runs-one";
  const sourceUrl = manualRunSourceRuntimeUrl();
  const sourceControlUrl = manualRunSourceControlUrl();
  const defaultGateKey = "schedule-overlap-api-default-" + randomUUID();
  const scheduleGateKey = "schedule-overlap-skip-" + randomUUID();
  const otherScheduleGateKey = "schedule-overlap-other-plan-" + randomUUID();
  const manualGateKey = "schedule-overlap-manual-" + randomUUID();
  let apiDefaultScheduleId: string | undefined;
  let skipScheduleId: string | undefined;
  let otherScheduleId: string | undefined;
  let unconfirmedScheduleId: string | undefined;
  let runtimeStopped = false;
  let runtimePaused = false;

  const readSchedule = async (scheduleId: string) =>
    cliData<{
      readonly scheduleId: string;
      readonly overlapPolicy: "queue" | "skip";
      readonly nextDueAt: string;
      readonly lastRunId?: string;
      readonly lastSkip?: {
        readonly reason: "overlap";
        readonly scheduledFor: string;
        readonly skippedAt: string;
      };
    }>(await cli(baseUrl, ["schedule", "get", binId, scheduleId]), "found");

  try {
    await waitForApiAndDatabase(baseUrl);
    await waitForRuntime(baseUrl, binId);
    await waitForManualRunSource();

    const defaultPayload = {
      expression: "0 0 0 1 1 *",
      timeZone: "UTC",
      action: "collect",
      params: {
        sourceUrl,
        gateKey: defaultGateKey,
        sourceKey: defaultGateKey,
      },
      enabled: false,
    };
    const invalidCreate = await fetch(
      baseUrl + "/bins/" + encodeURIComponent(binId) + "/schedules",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...defaultPayload, overlapPolicy: "parallel" }),
      },
    );
    assert.equal(invalidCreate.status, 400);
    const defaultCreate = await fetch(
      baseUrl + "/bins/" + encodeURIComponent(binId) + "/schedules",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultPayload),
      },
    );
    assert.equal(defaultCreate.status, 201);
    if (defaultCreate.status !== 201) return;
    const defaultSchedule = (await defaultCreate.json()) as {
      readonly scheduleId: string;
      readonly overlapPolicy: string;
    };
    apiDefaultScheduleId = defaultSchedule.scheduleId;
    assert.equal(defaultSchedule.overlapPolicy, "queue");

    const created = cliData<{
      readonly scheduleId: string;
      readonly nextDueAt: string;
      readonly overlapPolicy: "queue" | "skip";
    }>(
      await cli(baseUrl, [
        "schedule",
        "create",
        binId,
        "--expression",
        "*/20 * * * * *",
        "--time-zone",
        "UTC",
        "--action",
        "collect",
        "--params",
        JSON.stringify({
          sourceUrl,
          gateKey: scheduleGateKey,
          sourceKey: scheduleGateKey,
          waitAfterCommitMs: 60_000,
        }),
        "--disabled",
      ]),
      "created",
    );
    skipScheduleId = created.scheduleId;
    assert.equal(created.overlapPolicy, "queue");
    const firstDisabledDueAt = Date.parse(created.nextDueAt);
    if (firstDisabledDueAt > Date.now())
      await wait(firstDisabledDueAt - Date.now() + 100);

    await compose(["stop", "runtime-fifteen-one"]);
    runtimeStopped = true;

    const enabled = cliData<{ readonly nextDueAt: string }>(
      await cli(baseUrl, ["schedule", "enable", binId, created.scheduleId]),
      "enabled",
    );
    const firstDue = enabled.nextDueAt;
    const firstRunSchedule = await waitFor(
      () => readSchedule(created.scheduleId),
      ({ lastRunId }) => lastRunId !== undefined,
      "skip 策略的首个到期点创建一个正式计划运行",
    );
    const firstRunId = firstRunSchedule.lastRunId;
    assert.ok(firstRunId !== undefined);
    const firstRun = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, firstRunId]),
      "found",
    );
    assert.equal(firstRun.status, "queued");
    assert.equal(firstRun.trigger.kind, "schedule");
    if (firstRun.trigger.kind === "schedule") {
      assert.equal(firstRun.trigger.scheduleId, created.scheduleId);
      assert.equal(firstRun.trigger.scheduledFor, firstDue);
    }

    const changedPolicy = cliData<{
      readonly overlapPolicy: string;
      readonly nextDueAt: string;
    }>(
      await cli(baseUrl, [
        "schedule",
        "update",
        binId,
        created.scheduleId,
        "--overlap-policy",
        "skip",
      ]),
      "updated",
    );
    assert.equal(changedPolicy.overlapPolicy, "skip");
    const firstRunAfterPolicyUpdate = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, firstRunId]),
      "found",
    );
    assert.equal(firstRunAfterPolicyUpdate.status, "queued");
    assert.equal(firstRunAfterPolicyUpdate.trigger.kind, "schedule");
    if (firstRunAfterPolicyUpdate.trigger.kind === "schedule") {
      assert.equal(
        firstRunAfterPolicyUpdate.trigger.scheduleId,
        created.scheduleId,
      );
      assert.equal(firstRunAfterPolicyUpdate.trigger.scheduledFor, firstDue);
      assert.equal(
        firstRunAfterPolicyUpdate.referenceTime,
        firstRunAfterPolicyUpdate.trigger.scheduledFor,
      );
    }

    const queuedSkip = await waitFor(
      () => readSchedule(created.scheduleId),
      ({ lastRunId, lastSkip }) =>
        lastRunId !== firstRunId ||
        lastSkip?.scheduledFor === changedPolicy.nextDueAt,
      "同计划有排队运行时跳过下一次到期触发",
    );
    assert.equal(queuedSkip.lastRunId, firstRunId);
    assert.equal(queuedSkip.lastSkip?.reason, "overlap");
    assert.equal(queuedSkip.lastSkip?.scheduledFor, changedPolicy.nextDueAt);
    assert.ok(Date.parse(queuedSkip.lastSkip?.skippedAt ?? "") > 0);
    assert.ok(
      Date.parse(queuedSkip.nextDueAt) > Date.parse(changedPolicy.nextDueAt),
    );
    const listedSkip = cliData<{
      readonly scheduleId: string;
      readonly lastSkip?: { readonly reason: string };
    }>(
      await cli(baseUrl, ["schedule", "get", binId, created.scheduleId]),
      "found",
    );
    assert.equal(listedSkip.lastSkip?.reason, "overlap");

    const nextOverlapAt = new Date(Date.parse(queuedSkip.nextDueAt));
    assert.ok(Date.parse(queuedSkip.nextDueAt) - Date.now() > 10_000);
    await compose(["start", "runtime-fifteen-one"]);
    runtimeStopped = false;
    await waitForRuntime(baseUrl, binId);
    const otherExpression = [
      nextOverlapAt.getUTCSeconds(),
      nextOverlapAt.getUTCMinutes(),
      nextOverlapAt.getUTCHours(),
      nextOverlapAt.getUTCDate(),
      nextOverlapAt.getUTCMonth() + 1,
      "*",
    ].join(" ");
    const otherSchedule = cliData<{
      readonly scheduleId: string;
      readonly nextDueAt: string;
    }>(
      await cli(baseUrl, [
        "schedule",
        "create",
        binId,
        "--expression",
        otherExpression,
        "--time-zone",
        "UTC",
        "--action",
        "check",
        "--params",
        JSON.stringify({
          sourceUrl,
          gateKey: otherScheduleGateKey,
          sourceKey: otherScheduleGateKey,
        }),
        "--overlap-policy",
        "skip",
      ]),
      "created",
    );
    otherScheduleId = otherSchedule.scheduleId;
    assert.equal(otherSchedule.nextDueAt, queuedSkip.nextDueAt);
    await releaseSource(sourceControlUrl, otherScheduleGateKey, "available");
    await waitForSourceArrival(
      sourceControlUrl,
      scheduleGateKey,
      firstRunId,
      binId,
    );
    const executingRun = await waitForCliManualRunState(
      baseUrl,
      binId,
      firstRunId,
      ["executing"],
    );
    await releaseSource(sourceControlUrl, scheduleGateKey, "slow");
    await waitForSourceMarker(
      sourceControlUrl,
      firstRunId,
      scheduleGateKey,
      "committed",
    );
    assert.equal(executingRun.status, "executing");

    const executingSkip = await waitFor(
      () => readSchedule(created.scheduleId),
      ({ lastRunId, lastSkip }) =>
        lastRunId !== firstRunId ||
        lastSkip?.scheduledFor === queuedSkip.nextDueAt,
      "同计划运行执行中跳过下一次到期触发",
    );
    assert.equal(executingSkip.lastRunId, firstRunId);
    assert.equal(executingSkip.lastSkip?.scheduledFor, queuedSkip.nextDueAt);
    assert.equal(
      (await readSchedule(otherSchedule.scheduleId)).lastRunId !== undefined,
      true,
      "另一计划首次到期时仍应创建运行。",
    );
    const otherRunId = (await readSchedule(otherSchedule.scheduleId)).lastRunId;
    assert.ok(otherRunId !== undefined);
    const otherRun = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, otherRunId]),
      "found",
    );
    assert.equal(otherRun.status, "queued");
    assert.equal(otherRun.trigger.kind, "schedule");
    if (otherRun.trigger.kind === "schedule")
      assert.equal(otherRun.trigger.scheduleId, otherSchedule.scheduleId);

    while (Date.now() % 5_000 > 500) await wait(50);
    const cancellationSchedule = cliData<{
      readonly nextDueAt: string;
    }>(
      await cli(baseUrl, [
        "schedule",
        "update",
        binId,
        created.scheduleId,
        "--expression",
        "*/5 * * * * *",
      ]),
      "updated",
    );
    const cancellationDueAt = cancellationSchedule.nextDueAt;
    assert.ok(Date.parse(cancellationDueAt) - Date.now() > 3_000);

    await releaseSource(sourceControlUrl, manualGateKey, "material");
    const manualRun = cliData<ManualRunCliState>(
      await cli(baseUrl, [
        "run",
        "trigger",
        binId,
        "collect",
        "--params",
        JSON.stringify({
          sourceUrl,
          gateKey: manualGateKey,
          sourceKey: manualGateKey,
        }),
      ]),
      "triggered",
    );
    assert.equal(manualRun.status, "queued");
    assert.equal(manualRun.trigger.kind, "manual");

    await compose(["pause", "runtime-fifteen-one"]);
    runtimePaused = true;
    const cancellingRun = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "cancel", binId, firstRunId]),
      "cancellation",
    );
    assert.equal(cancellingRun.status, "cancelling");
    const cancellingSkip = await waitFor(
      () => readSchedule(created.scheduleId),
      ({ lastRunId, lastSkip }) =>
        lastRunId !== firstRunId ||
        (lastSkip !== undefined &&
          Date.parse(lastSkip.scheduledFor) >
            Date.parse(executingSkip.lastSkip?.scheduledFor ?? "")),
      "取消尚未确认时跳过同计划到期触发",
    );
    assert.equal(cancellingSkip.lastRunId, firstRunId);
    assert.equal(cancellingSkip.lastSkip?.reason, "overlap");
    assert.equal(cancellingSkip.lastSkip?.scheduledFor, cancellationDueAt);
    const stillCancellingRun = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, firstRunId]),
      "found",
    );
    assert.equal(stillCancellingRun.status, "cancelling");
    assert.equal(stillCancellingRun.stopConfirmedAt, undefined);
    assert.ok(stillCancellingRun.cancellationRequestedAt);
    assert.ok(
      Date.parse(cancellingSkip.lastSkip?.skippedAt ?? "") >=
        Date.parse(stillCancellingRun.cancellationRequestedAt),
    );
    await compose(["unpause", "runtime-fifteen-one"]);
    runtimePaused = false;
    const cancelledRun = await waitForCliManualRunState(
      baseUrl,
      binId,
      firstRunId,
      ["cancelled"],
    );
    assert.ok(cancelledRun.stopConfirmedAt);
    await releaseSource(sourceControlUrl, scheduleGateKey, "material");

    const recoveredSchedule = await waitFor(
      () => readSchedule(created.scheduleId),
      ({ lastRunId }) => lastRunId !== undefined && lastRunId !== firstRunId,
      "同计划运行终结后，后续到期点恢复创建运行",
    );
    const recoveredRunId = recoveredSchedule.lastRunId;
    assert.ok(recoveredRunId !== undefined);
    assert.ok(recoveredSchedule.lastSkip !== undefined);
    assert.ok(Date.parse(recoveredSchedule.lastSkip.skippedAt) > 0);
    assert.equal(recoveredSchedule.overlapPolicy, "skip");

    cliData(
      await cli(baseUrl, ["schedule", "disable", binId, created.scheduleId]),
      "disabled",
    );
    cliData(
      await cli(baseUrl, [
        "schedule",
        "disable",
        binId,
        otherSchedule.scheduleId,
      ]),
      "disabled",
    );

    const [finishedOther, finishedManual, finishedRecovered] =
      await Promise.all([
        waitForCliManualRunState(baseUrl, binId, otherRunId, ["completed"]),
        waitForCliManualRunState(baseUrl, binId, manualRun.runId, [
          "completed",
        ]),
        waitForCliManualRunState(baseUrl, binId, recoveredRunId, ["completed"]),
      ]);
    assert.equal(finishedOther.status, "completed");
    assert.equal(finishedManual.trigger.kind, "manual");
    assert.equal(finishedRecovered.trigger.kind, "schedule");
    const retainedSkip = await readSchedule(created.scheduleId);
    assert.equal(retainedSkip.lastRunId, recoveredRunId);
    assert.equal(retainedSkip.lastSkip?.reason, "overlap");

    const invalidUpdate = await fetch(
      baseUrl +
        "/bins/" +
        encodeURIComponent(binId) +
        "/schedules/" +
        encodeURIComponent(created.scheduleId),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overlapPolicy: "parallel" }),
      },
    );
    assert.equal(invalidUpdate.status, 400);
    const preserved = await readSchedule(created.scheduleId);
    assert.equal(preserved.overlapPolicy, "skip");

    const unconfirmedExpression = "*/20 * * * * *";
    const unconfirmedGateKey = "schedule-overlap-unconfirmed-" + randomUUID();
    const unconfirmedSchedule = cliData<{
      readonly scheduleId: string;
      readonly nextDueAt: string;
      readonly overlapPolicy: "queue" | "skip";
    }>(
      await cli(baseUrl, [
        "schedule",
        "create",
        binId,
        "--expression",
        unconfirmedExpression,
        "--time-zone",
        "UTC",
        "--action",
        "collect",
        "--params",
        JSON.stringify({
          sourceUrl,
          gateKey: unconfirmedGateKey,
          sourceKey: unconfirmedGateKey,
          waitBeforeSourceMs: 60_000,
        }),
        "--overlap-policy",
        "skip",
      ]),
      "created",
    );
    unconfirmedScheduleId = unconfirmedSchedule.scheduleId;
    assert.equal(unconfirmedSchedule.overlapPolicy, "skip");
    const expiredRunSchedule = await waitFor(
      () => readSchedule(unconfirmedSchedule.scheduleId),
      ({ lastRunId }) => lastRunId !== undefined,
      "等待受控长动作的首次计划触发",
    );
    const expiredRunId = expiredRunSchedule.lastRunId;
    assert.ok(expiredRunId !== undefined);
    const expiredRun = await waitForCliManualRunState(
      baseUrl,
      binId,
      expiredRunId,
      ["executing"],
    );
    assert.equal(expiredRun.trigger.kind, "schedule");
    if (expiredRun.trigger.kind === "schedule")
      assert.equal(
        expiredRun.trigger.scheduleId,
        unconfirmedSchedule.scheduleId,
      );

    await compose(["pause", "runtime-fifteen-one"]);
    runtimePaused = true;
    const timedOutRun = await waitForCliManualRunState(
      baseUrl,
      binId,
      expiredRunId,
      ["failed"],
    );
    assert.equal(timedOutRun.stopConfirmedAt, undefined);
    assert.equal(timedOutRun.result?.error?.code, "runtime_interrupted");
    const dueWhileUnconfirmed = (
      await readSchedule(unconfirmedSchedule.scheduleId)
    ).nextDueAt;
    const skippedUnconfirmed = await waitFor(
      () => readSchedule(unconfirmedSchedule.scheduleId),
      ({ lastRunId, lastSkip }) =>
        lastRunId !== expiredRunId ||
        lastSkip?.scheduledFor === dueWhileUnconfirmed,
      "失败但未确认停止的同计划运行仍应阻止重叠触发",
    );
    assert.equal(skippedUnconfirmed.lastRunId, expiredRunId);
    assert.equal(skippedUnconfirmed.lastSkip?.reason, "overlap");
    assert.equal(
      skippedUnconfirmed.lastSkip?.scheduledFor,
      dueWhileUnconfirmed,
    );
    const failedStillUnconfirmed = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, expiredRunId]),
      "found",
    );
    assert.equal(failedStillUnconfirmed.status, "failed");
    assert.equal(failedStillUnconfirmed.stopConfirmedAt, undefined);

    cliData(
      await cli(baseUrl, [
        "schedule",
        "disable",
        binId,
        unconfirmedSchedule.scheduleId,
      ]),
      "disabled",
    );
    await compose(["unpause", "runtime-fifteen-one"]);
    runtimePaused = false;
    await compose(["kill", "--signal", "SIGKILL", "runtime-fifteen-one"]);
    runtimeStopped = true;
    await compose([
      "up",
      "--detach",
      "--no-build",
      "--force-recreate",
      "runtime-fifteen-one",
    ]);
    runtimeStopped = false;
    await waitForRuntime(baseUrl, binId);
  } finally {
    if (runtimePaused) {
      try {
        await compose(["unpause", "runtime-fifteen-one"]);
      } catch (error) {
        process.stderr.write(String(error) + "\n");
      }
    }
    if (apiDefaultScheduleId !== undefined) {
      try {
        await fetch(
          baseUrl +
            "/bins/" +
            encodeURIComponent(binId) +
            "/schedules/" +
            encodeURIComponent(apiDefaultScheduleId),
          { method: "DELETE" },
        );
      } catch (error) {
        process.stderr.write(String(error) + "\n");
      }
    }
    for (const scheduleId of [
      skipScheduleId,
      otherScheduleId,
      unconfirmedScheduleId,
    ]) {
      if (scheduleId === undefined) continue;
      const removed = await cli(baseUrl, [
        "schedule",
        "remove",
        binId,
        scheduleId,
      ]);
      if (removed.code !== 0) process.stderr.write(removed.stderr);
    }
    if (runtimeStopped) await compose(["start", "runtime-fifteen-one"]);
  }
}

async function manualRunControllerPartitionStep(): Promise<void> {
  const baseUrl = apiBaseUrl();
  const sourceControlUrl = manualRunSourceControlUrl();
  const binId = "binny-runs-two";
  const interruptedGateKey = "lifecycle-controller-link-loss";
  const interrupted = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey: interruptedGateKey,
        sourceKey: "interrupted-before-source",
        waitBeforeSourceMs: 30_000,
      }),
    ]),
    "triggered",
  );
  const active = await waitForCliManualRunState(
    baseUrl,
    binId,
    interrupted.runId,
    ["executing"],
  );
  assert.equal(active.status, "executing");
  const oldWorker = (await runtimeProcessSnapshot("runtime-fifteen-two")).find(
    (process) => process.command.includes("worker.js"),
  );
  assert.ok(oldWorker, "失联验收应观察到真实执行子进程。");
  const bin = cliData<{
    readonly execution: { readonly runtimeId?: string };
  }>(await cli(baseUrl, ["bin", "get", binId]), "found");
  assert.ok(bin.execution.runtimeId);

  const nextGateKey = "lifecycle-after-controller-link-loss";
  const next = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      binId,
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: manualRunSourceRuntimeUrl(),
        gateKey: nextGateKey,
        sourceKey: "after-interruption",
      }),
    ]),
    "triggered",
  );
  const queuedBeforeDisconnect = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", binId, next.runId]),
    "found",
  );
  assert.equal(queuedBeforeDisconnect.status, "queued");
  assert.equal(queuedBeforeDisconnect.queueReason, "earlier_run_active");

  const containers = await compose(["ps", "-q", "runtime-fifteen-two"]);
  const containerId = containers.stdout.trim().split("\n")[0];
  assert.ok(containerId);
  const networkName = projectName + "_runtime";
  const detached = await run(
    "docker",
    ["network", "disconnect", networkName, containerId],
    { env: composeEnvironment() },
  );
  assert.equal(detached.code, 0, detached.stderr);
  let reconnected = false;
  try {
    cliFailure<{ readonly code: string }>(
      await cli(baseUrl, [
        "run",
        "trigger",
        binId,
        "collect",
        "--params",
        JSON.stringify({
          sourceUrl: manualRunSourceRuntimeUrl(),
          gateKey: "lifecycle-action-while-controller-offline",
          sourceKey: "offline-input",
        }),
      ]),
      "runtime_action_validation_unavailable",
    );
    const stale = await waitForCliManualRunState(
      baseUrl,
      binId,
      interrupted.runId,
      ["failed"],
    );
    assert.equal(stale.result?.error?.code, "runtime_interrupted");
    assert.equal(stale.stopConfirmedAt, undefined);
    const offlineFailedHistory = cliData<{
      readonly runs: readonly {
        readonly runId: string;
        readonly status: string;
      }[];
    }>(
      await cli(baseUrl, [
        "run",
        "list",
        "--bin-id",
        binId,
        "--status",
        "failed",
      ]),
      "listed",
    );
    assert.ok(
      offlineFailedHistory.runs.some(
        ({ runId, status }) =>
          runId === interrupted.runId && status === "failed",
      ),
      "运行器无法连接时仍可查询已保存的失败历史。",
    );
    const stillQueued = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", binId, next.runId]),
      "found",
    );
    assert.equal(stillQueued.status, "queued");
    assert.equal(stillQueued.queueReason, "previous_execution_unconfirmed");

    const claim = await fetch(
      baseUrl + "/bins/" + binId + "/runtime/runs/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtimeId: bin.execution.runtimeId }),
      },
    );
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { run: null });
    const liveProcesses = await runtimeProcessSnapshot("runtime-fifteen-two");
    assert.ok(
      liveProcesses.some((process) => process.pgid === oldWorker.pgid),
      "失联超时不能伪称旧执行进程已经退出。",
    );

    const attached = await run(
      "docker",
      [
        "network",
        "connect",
        "--alias",
        "runtime-fifteen-two",
        networkName,
        containerId,
      ],
      { env: composeEnvironment() },
    );
    assert.equal(attached.code, 0, attached.stderr);
    reconnected = true;

    await waitForSourceArrival(
      sourceControlUrl,
      nextGateKey,
      next.runId,
      binId,
    );
    const stopped = await waitForCliManualRunState(
      baseUrl,
      binId,
      interrupted.runId,
      ["failed"],
    );
    assert.ok(stopped.stopConfirmedAt);
    const processesAfterAck = await runtimeProcessSnapshot(
      "runtime-fifteen-two",
    );
    assert.equal(
      processesAfterAck.some((process) => process.pgid === oldWorker.pgid),
      false,
      "恢复控制连接并收到停止确认后旧 worker 进程组应消失。",
    );
    await releaseSource(sourceControlUrl, nextGateKey);
    const completedNext = await waitForCliManualRunState(
      baseUrl,
      binId,
      next.runId,
      ["completed"],
    );
    assert.equal(completedNext.result?.stopReason.code, "completed");
  } finally {
    if (!reconnected) {
      const attached = await run(
        "docker",
        [
          "network",
          "connect",
          "--alias",
          "runtime-fifteen-two",
          networkName,
          containerId,
        ],
        { env: composeEnvironment() },
      );
      if (attached.code !== 0 && !attached.stderr.includes("already exists"))
        process.stderr.write(attached.stderr);
    }
  }
}

async function verifyConfigurationJourney(
  baseUrl: string,
  sourceControlUrl: string,
): Promise<void> {
  const binId = "binny-runs-one";
  const registered = await waitForBinRegistration(baseUrl, binId);
  assert.equal(registered.id, binId);
  assert.ok(registered.sourceAdapterId.length > 0);
  assert.equal(registered.identityId, binId);
  assert.deepEqual(registered.config, {});
  assert.equal(registered.execution.status, "incompatible");

  const binListResponse = await fetch(`${baseUrl}/bins`);
  assert.equal(binListResponse.status, 200);
  const binList = (await binListResponse.json()) as {
    readonly bins: readonly {
      readonly id: string;
      readonly sourceAdapterId: string;
      readonly status: string;
      readonly execution: { readonly status: string };
      readonly [key: string]: unknown;
    }[];
  };
  assert.ok(binList.bins.length > 1);
  const listedBin = binList.bins.find(({ id }) => id === binId);
  assert.ok(listedBin !== undefined);
  assert.equal(listedBin.sourceAdapterId, registered.sourceAdapterId);
  assert.equal(listedBin.status, "active");
  assert.equal(listedBin.execution.status, "incompatible");
  assert.equal(Object.hasOwn(listedBin, "sourceAdapter"), false);
  assert.equal(Object.hasOwn(listedBin, "config"), false);

  const cliBinList = cliData<{
    readonly bins: readonly {
      readonly id: string;
      readonly sourceAdapterId: string;
    }[];
  }>(await cli(baseUrl, ["bin", "list"]), "listed");
  assert.ok(cliBinList.bins.length > 1);
  assert.ok(cliBinList.bins.some(({ id }) => id === binId));
  const cliBinListText = await cli(baseUrl, [
    "bin",
    "list",
    "--output-format",
    "text",
  ]);
  assert.equal(cliBinListText.code, 0, cliBinListText.stderr);
  assert.ok(cliBinListText.stdout.includes(registered.sourceAdapterId));
  assert.doesNotMatch(cliBinListText.stdout, /"kind"\s*:/u);

  const binResponse = await fetch(
    `${baseUrl}/bins/${encodeURIComponent(binId)}`,
  );
  assert.equal(binResponse.status, 200);
  const binDetails = (await binResponse.json()) as {
    readonly sourceAdapterId: string;
    readonly config: Record<string, unknown>;
    readonly execution: { readonly status: string };
    readonly sourceStateSnapshot: { readonly freshness: string };
    readonly [key: string]: unknown;
  };
  assert.equal(binDetails.sourceAdapterId, registered.sourceAdapterId);
  assert.equal(binDetails.execution.status, "incompatible");
  assert.equal(Object.hasOwn(binDetails, "sourceAdapter"), false);
  assert.equal(Object.hasOwn(binDetails, "persistentState"), false);

  const configurationDeclaration = cliData<{
    readonly sourceAdapterId: string;
    readonly sourceAdapterVersion: string;
    readonly configSchema: unknown;
  }>(await cli(baseUrl, ["bin", "config-schema", binId]), "discovered");
  assert.equal(
    configurationDeclaration.sourceAdapterId,
    registered.sourceAdapterId,
  );
  assert.equal(
    configurationDeclaration.sourceAdapterVersion,
    registered.sourceAdapterVersion,
  );
  assert.notEqual(configurationDeclaration.configSchema, undefined);

  const listRunIds = async (): Promise<readonly string[]> => {
    const page = cliData<{
      readonly runs: readonly { readonly runId: string }[];
    }>(await cli(baseUrl, ["run", "list", "--bin-id", binId]), "listed");
    return page.runs.map(({ runId }) => runId);
  };
  const runsBefore = await listRunIds();
  const sourceArrivalsBefore = await countAllSourceArrivals(sourceControlUrl);
  const discovered = cliData<{
    readonly actions: Readonly<
      Record<string, { readonly description: string }>
    >;
    readonly environment?: unknown;
    readonly execution?: unknown;
  }>(await cli(baseUrl, ["bin", "actions", binId]), "discovered");
  assert.ok("check" in discovered.actions);
  assert.ok("collect" in discovered.actions);
  assert.ok("discover" in discovered.actions);
  assert.equal("params" in discovered.actions.collect!, false);
  assert.ok(discovered.actions.collect?.description.length);
  assert.equal(Object.hasOwn(discovered, "environment"), false);
  assert.equal(Object.hasOwn(discovered, "execution"), false);

  const selected = cliData<{
    readonly actions: Readonly<
      Record<
        string,
        {
          readonly description: string;
          readonly params: unknown;
          readonly output: unknown;
          readonly report?: unknown;
        }
      >
    >;
    readonly execution?: unknown;
  }>(await cli(baseUrl, ["bin", "actions", binId, "collect"]), "discovered");
  assert.deepEqual(Object.keys(selected.actions), ["collect"]);
  assert.equal(typeof selected.actions.collect?.description, "string");
  assert.ok(selected.actions.collect?.params !== undefined);
  assert.ok(selected.actions.collect?.output !== undefined);
  assert.equal(Object.hasOwn(selected, "execution"), false);

  cliFailure<{ readonly code: string }>(
    await cli(baseUrl, ["bin", "actions", binId, "missing"]),
    "action_not_found",
  );

  const bin = cliData<{
    readonly execution: { readonly status: string };
  }>(await cli(baseUrl, ["bin", "get", binId]), "found");
  assert.equal(bin.execution.status, "incompatible");
  assert.deepEqual(await listRunIds(), runsBefore);
  assert.equal(
    await countAllSourceArrivals(sourceControlUrl),
    sourceArrivalsBefore,
    "动作声明读取不应启动运行或访问来源。",
  );

  const blockedRun = await fetch(`${baseUrl}/bins/${binId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "collect", params: {} }),
  });
  assert.equal(blockedRun.status, 400);
  const blockedBody = (await blockedRun.json()) as {
    readonly error: { readonly code: string };
  };
  assert.equal(blockedBody.error.code, "invalid_configuration");

  const rejectedNativeConfig = await fetch(`${baseUrl}/bins/${binId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { section: "forbidden" } }),
  });
  assert.equal(rejectedNativeConfig.status, 400);
  const rejectedBody = (await rejectedNativeConfig.json()) as {
    readonly error: {
      readonly code: string;
      readonly path?: readonly (string | number)[];
    };
  };
  assert.equal(rejectedBody.error.code, "invalid_configuration");
  assert.deepEqual(rejectedBody.error.path, ["config", "section"]);
  const unchanged = await waitForBinRegistration(baseUrl, binId);
  assert.deepEqual(unchanged.config, {});

  const acceptedNativeConfig = await fetch(`${baseUrl}/bins/${binId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identityId: "account-one",
      config: { section: "initial" },
    }),
  });
  assert.equal(acceptedNativeConfig.status, 200);
  const acceptedBody = (await acceptedNativeConfig.json()) as {
    readonly id: string;
    readonly identityId: string;
    readonly config: Record<string, unknown>;
    readonly execution: { readonly status: string };
  };
  assert.equal(acceptedBody.id, binId);
  assert.equal(acceptedBody.identityId, "account-one");
  assert.deepEqual(acceptedBody.config, { section: "initial" });
  assert.equal(acceptedBody.execution.status, "online");

  cliFailure(
    await cli(baseUrl, [
      "bin",
      "update",
      binId,
      "--config",
      JSON.stringify({ section: "forbidden" }),
    ]),
    "invalid_configuration",
  );
  const unchangedAfterCliFailure = cliData<{
    readonly config: Record<string, unknown>;
  }>(await cli(baseUrl, ["bin", "get", binId]), "found");
  assert.deepEqual(unchangedAfterCliFailure.config, { section: "initial" });

  const updated = cliData<{
    readonly identityId: string;
    readonly config: Record<string, unknown>;
  }>(
    await cli(baseUrl, [
      "bin",
      "update",
      binId,
      "--identity",
      "account-primary",
      "--config",
      JSON.stringify({ section: "initial" }),
    ]),
    "updated",
  );
  assert.equal(updated.identityId, "account-primary");
  assert.deepEqual(updated.config, { section: "initial" });
}

async function verifyRestartAndRemoval(
  baseUrl: string,
  archive: string,
  sdkResource: string,
): Promise<string> {
  const beforeRestart = cliData<{
    readonly status: string;
    readonly identityId: string;
    readonly config: Record<string, unknown>;
  }>(await cli(baseUrl, ["bin", "get", "binny-runs-one"]), "found");
  assert.equal(beforeRestart.status, "active");
  const disabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "disable", "binny-runs-one"]),
    "disabled",
  );
  assert.equal(disabled.status, "disabled");
  await compose(["restart", "postgres"]);
  await waitForApiAndDatabase(baseUrl);
  await compose(["restart", "server"]);
  composePort = await publishedPort("server", 3000);
  baseUrl = apiBaseUrl();
  await waitForApiAndDatabase(baseUrl);

  const persisted = cliData<{
    readonly status: string;
    readonly identityId: string;
    readonly config: Record<string, unknown>;
  }>(await cli(baseUrl, ["bin", "get", "binny-runs-one"]), "found");
  assert.equal(persisted.status, "disabled");
  assert.equal(persisted.identityId, beforeRestart.identityId);
  assert.deepEqual(persisted.config, beforeRestart.config);

  const enabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "enable", "binny-runs-one"]),
    "enabled",
  );
  assert.equal(enabled.status, "active");
  const archiveState = await archiveHttpStep(
    "after-restart",
    baseUrl,
    archive,
    sdkResource,
  );
  const {
    itemId,
    relationItemId,
    relationCommitId,
    revisionId,
    comparedRevisionId,
    commitId,
    historicalAsOf,
    relationAsOf,
    resourceItemId,
    resourceRevisionId,
    resourcePartialRevisionId,
    resourceRepairedRevisionId,
    resourceMarkerItemId,
    cliCascadeRootItemId,
    cliCascadeTargetItemId,
  } = archiveIds(archive);
  const expectedArchive = archiveResponses(archiveState);
  const cliArchiveItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", itemId]),
    "found",
  );
  assert.deepEqual(cliArchiveItem, expectedArchive.item);
  const cliHistoricalItem = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "item",
      itemId,
      "--bin",
      "binny-runs-one",
      "--as-of",
      historicalAsOf,
    ]),
    "found",
  );
  assert.deepEqual(cliHistoricalItem, expectedArchive.historicalItem);
  const cliArchiveRevision = cliData<unknown>(
    await cli(baseUrl, ["archive", "revision", revisionId]),
    "found",
  );
  assert.deepEqual(cliArchiveRevision, expectedArchive.revision);
  const cliRevisionDiff = cliData<unknown>(
    await cli(baseUrl, ["archive", "diff", revisionId, comparedRevisionId]),
    "found",
  );
  assert.deepEqual(cliRevisionDiff, expectedArchive.revisionDiff);
  const cliResourceDiff = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "diff",
      resourceRevisionId,
      resourceRepairedRevisionId,
    ]),
    "found",
  );
  assert.deepEqual(cliResourceDiff, expectedArchive.resourceDiff);
  const cliResourcePartialDiff = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "diff",
      resourceRevisionId,
      resourcePartialRevisionId,
    ]),
    "found",
  );
  assert.deepEqual(cliResourcePartialDiff, expectedArchive.resourcePartialDiff);

  const cliResourceItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", resourceItemId]),
    "found",
  );
  assert.deepEqual(cliResourceItem, expectedArchive.resourceItem);
  const cliResourceMarkerItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", resourceMarkerItemId]),
    "found",
  );
  assert.deepEqual(cliResourceMarkerItem, expectedArchive.resourceMarkerItem);
  const cliResourceRevision = cliData<unknown>(
    await cli(baseUrl, ["archive", "revision", resourceRevisionId]),
    "found",
  );
  const persistedState: unknown = JSON.parse(archiveState);
  assert.ok(typeof persistedState === "object" && persistedState !== null);
  assert.ok("resourceRevision" in persistedState);
  assert.deepEqual(cliResourceRevision, persistedState.resourceRevision);
  const sdkJourney: unknown = JSON.parse(sdkResource);
  assert.ok(typeof sdkJourney === "object" && sdkJourney !== null);
  assert.ok("itemId" in sdkJourney && typeof sdkJourney.itemId === "string");
  const cliSdkItem = cliData<unknown>(
    await cli(baseUrl, ["archive", "item", sdkJourney.itemId]),
    "found",
  );
  assert.deepEqual(cliSdkItem, expectedArchive.sdkItem);

  const cliSearch = cliData<{
    readonly results: readonly {
      readonly itemId: string;
      readonly matches: readonly {
        readonly binId: string;
        readonly revisionId: string;
      }[];
    }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        bins: ["binny-runs-one"],
        text: { groups: [["正文 A"]] },
        limit: 10,
      }),
    ]),
    "found",
  );
  const cliSearchResult = cliSearch.results.find(
    (result) => result.itemId === itemId,
  );
  assert.ok(cliSearchResult);
  assert.ok(
    cliSearchResult.matches.some(
      (match) =>
        match.binId === "binny-runs-one" && match.revisionId === revisionId,
    ),
  );

  const downloadDirectory = await mkdtemp(
    path.join(tmpdir(), "binny-relations-resource-cli-"),
  );
  const localResourcePath = path.join(downloadDirectory, "resource.bin");
  try {
    const downloaded = cliData<{
      readonly resourceId: string;
      readonly mediaType: string;
      readonly size: number;
      readonly sha256: string;
      readonly savedTo: string;
    }>(
      await cli(baseUrl, [
        "archive",
        "resource",
        expectedArchive.sdkResourceMetadata.resourceId,
        "--output",
        localResourcePath,
      ]),
      "downloaded",
    );
    assert.equal(
      downloaded.resourceId,
      expectedArchive.sdkResourceMetadata.resourceId,
    );
    assert.equal(downloaded.mediaType, "image/svg+xml");
    assert.equal(downloaded.sha256, expectedArchive.sdkResourceMetadata.sha256);
    assert.equal(downloaded.savedTo, localResourcePath);
    assert.deepEqual(
      await readFile(localResourcePath),
      Buffer.from("sourceAdapter sdk image v1"),
    );
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }

  const cliFirstTimelinePage = cliData<{ readonly nextCursor?: string }>(
    await cli(baseUrl, [
      "archive",
      "timeline",
      itemId,
      "--bin",
      "binny-runs-one",
      "--limit",
      "1",
    ]),
    "found",
  );
  assert.deepEqual(cliFirstTimelinePage, expectedArchive.firstTimelinePage);
  assert.ok(cliFirstTimelinePage.nextCursor);
  const cliSecondTimelinePage = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "timeline",
      itemId,
      "--limit",
      "1",
      "--cursor",
      cliFirstTimelinePage.nextCursor,
    ]),
    "found",
  );
  assert.deepEqual(cliSecondTimelinePage, expectedArchive.secondTimelinePage);
  const cliRelationPage = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "relations",
      relationItemId,
      "--bin",
      "binny-runs-one",
      "--direction",
      "outgoing",
      "--as-of",
      relationAsOf,
      "--limit",
      "10",
    ]),
    "found",
  );
  assert.deepEqual(cliRelationPage, expectedArchive.relationPage);
  const cliRelationTimelinePage = cliData<unknown>(
    await cli(baseUrl, [
      "archive",
      "timeline",
      relationItemId,
      "--bin",
      "binny-runs-one",
      "--as-of",
      relationAsOf,
      "--limit",
      "100",
    ]),
    "found",
  );
  assert.deepEqual(
    cliRelationTimelinePage,
    expectedArchive.relationTimelinePage,
  );
  const cliRelationCommit = cliData<unknown>(
    await cli(baseUrl, ["archive", "commit", relationCommitId]),
    "found",
  );
  assert.deepEqual(cliRelationCommit, expectedArchive.relationCommit);
  const cliArchiveCommit = cliData<unknown>(
    await cli(baseUrl, ["archive", "commit", commitId]),
    "found",
  );
  assert.deepEqual(cliArchiveCommit, expectedArchive.commit);
  await validateApiInput();

  const cliCascadeDeletion = cliData<{
    readonly itemId: string;
    readonly deletedItemIds: readonly string[];
    readonly deletionSeq: string;
    readonly deleted: true;
  }>(
    await cli(baseUrl, ["archive", "delete", cliCascadeRootItemId]),
    "deleted",
  );
  assert.equal(cliCascadeDeletion.itemId, cliCascadeRootItemId);
  assert.deepEqual(
    cliCascadeDeletion.deletedItemIds.toSorted(),
    [cliCascadeRootItemId, cliCascadeTargetItemId].toSorted(),
  );
  assert.equal(cliCascadeDeletion.deleted, true);
  cliFailure(
    await cli(baseUrl, ["archive", "item", cliCascadeTargetItemId]),
    "item_deleted",
  );
  return baseUrl;
}

async function runRssAcceptance(
  baseUrl: string,
  source: RssControlSource,
  imageUpdate: RssImageUpdate,
): Promise<RssAcceptanceResult> {
  const sourceMediaBytes = await source.mediaBytes();
  const baselineManifest = imageUpdate.baselineManifest;
  let activeManifest = imageUpdate.candidateManifest;
  const config = {
    feeds: [
      { id: "rss-main", url: source.baseUrl + "/rss" },
      { id: "atom-main", url: source.baseUrl + "/atom" },
      { id: "temporary", url: source.baseUrl + "/temporary" },
      { id: "bad-identity", url: source.baseUrl + "/bad-identity" },
      {
        id: "real-feed-parser",
        url: "https://github.com/rowanmanning/feed-parser/releases.atom",
      },
      { id: "summary-main", url: source.baseUrl + "/summary-full" },
      { id: "missing-body", url: source.baseUrl + "/missing-body" },
    ],
  };
  await Promise.all([
    createRssBin(baseUrl, "binny-rss-one", baselineManifest, config),
    createRssBin(baseUrl, "binny-rss-two", baselineManifest, config),
  ]);
  assert.equal(
    await containerImageId("runtime-rss"),
    imageUpdate.baselineImageId,
  );
  assert.equal(
    await containerImageId("runtime-rss-two"),
    imageUpdate.baselineImageId,
  );
  await Promise.all([
    waitForRuntimeHealth("runtime-rss"),
    waitForRuntimeHealth("runtime-rss-two"),
    waitForRuntime(baseUrl, "binny-rss-one"),
    waitForRuntime(baseUrl, "binny-rss-two"),
  ]);
  const latestRequest = async (
    pathname: string,
  ): Promise<RssRequestRecord | undefined> =>
    [...(await source.requests())]
      .reverse()
      .find((entry) => entry.path === pathname);

  const initialRun = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    {
      feedIds: ["rss-main", "atom-main", "temporary", "summary-main"],
    },
  );
  const initialRequests = await source.requests();
  const initialAtomRequest = initialRequests.find(
    ({ path }) => path === "/atom",
  );
  assert.ok(initialAtomRequest !== undefined);
  assert.equal(initialAtomRequest.ifModifiedSince, undefined);
  process.stdout.write(
    "受控信源首批运行结果：" +
      JSON.stringify({ run: initialRun, requests: initialRequests }) +
      "\n",
  );
  assert.equal(initialRun.status, "failed");
  assert.equal(initialRun.result?.error?.code, "rss_collection_incomplete");

  const rssItemV1 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 1",
  );
  assert.equal(rssItemV1.sourceKey.namespace, "rss:rss-main");
  assert.equal(rssItemV1.sourceKey.key, "id:urn:binny:rss:rss-item");
  const initialRssView = rssItemV1.views.find(
    ({ binId }) => binId === "binny-rss-one",
  );
  assert.ok(initialRssView !== undefined);
  const rssV1 = rssArchiveView(rssItemV1, "binny-rss-one");
  assert.equal(rssV1.capture.completeness, "complete");
  assert.equal(rssV1.title, "RSS 全文测试文章");
  assert.deepEqual(rssV1.sourcePublishedAt, {
    precision: "instant",
    value: "2026-10-28T01:23:45+02:00",
  });
  assert.deepEqual(rssV1.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-30T12:34:56-03:00",
  });
  assert.deepEqual(rssV1.extensions.authors, ["作者"]);
  assert.deepEqual(rssV1.extensions.categories, ["工程"]);
  assert.equal("title" in rssV1.extensions, false);
  assert.equal("published" in rssV1.extensions, false);
  assert.equal("updated" in rssV1.extensions, false);
  assert.equal(rssV1.body?.html, undefined);
  assert.match(rssV1.body?.markdown ?? "", /RSS 正文版本 1/u);
  assert.doesNotMatch(rssV1.body?.markdown ?? "", /RSS 摘要版本 1/u);
  assert.match(rssV1.body?.markdown ?? "", /binny:\/\/resource\//u);
  assert.match(rssV1.body?.text ?? "", /RSS 正文版本 1/u);
  assert.equal(rssV1.resources?.length, 2);
  const rssTitleSearch = await searchRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 全文测试文章",
  );
  assert.equal(rssTitleSearch.length, 1);
  assert.equal(rssTitleSearch[0]?.itemId, rssItemV1.itemId);
  assert.deepEqual(
    await searchRssArchive(baseUrl, "binny-rss-one", "没有对应资料的词"),
    [],
  );
  const caseInsensitiveTitleResults = await searchRssArchive(
    baseUrl,
    "binny-rss-one",
    "rss 全文测试文章",
  );
  assert.deepEqual(
    caseInsensitiveTitleResults.map(({ itemId, sourceKey }) => ({
      itemId,
      sourceKey,
    })),
    [{ itemId: rssItemV1.itemId, sourceKey: rssItemV1.sourceKey }],
    "literal search matches title text without case sensitivity.",
  );

  const titleOnlyItem = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 仅标题資料🌿",
  );
  const titleOnlyState = rssArchiveView(titleOnlyItem, "binny-rss-one");
  assert.deepEqual(titleOnlyItem.sourceKey, {
    namespace: "rss:rss-main",
    key: "id:urn:binny:rss:rss-title-only",
  });
  assert.equal(titleOnlyState.body?.text, "原生短文正文🌿");
  assert.equal(
    titleOnlyState.body?.searchText,
    "RSS 仅标题資料🌿\n原生短文正文🌿",
  );
  assert.equal(titleOnlyState.capture.completeness, "complete");
  assert.deepEqual(titleOnlyState.capture.missing, []);
  assert.equal(titleOnlyState.title, "RSS 仅标题資料🌿");
  assert.equal(titleOnlyState.sourcePublishedAt, null);
  assert.equal(titleOnlyState.sourceModifiedAt, null);
  assert.equal("title" in titleOnlyState.extensions, false);

  const titleOnlySearch = cliData<{
    readonly results: readonly {
      readonly itemId: string;
      readonly matches: readonly { readonly binId: string }[];
    }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        bins: ["binny-rss-one"],
        text: { in: "title", groups: [["标题資料🌿"]] },
        limit: 10,
      }),
    ]),
    "found",
  );
  const titleOnlyResult = titleOnlySearch.results.find(
    ({ itemId }) => itemId === titleOnlyItem.itemId,
  );
  assert.ok(titleOnlyResult !== undefined);
  assert.ok(
    titleOnlyResult.matches.some(({ binId }) => binId === "binny-rss-one"),
  );

  const titleOnlyBodySearch = cliData<{
    readonly results: readonly { readonly itemId: string }[];
  }>(
    await cli(baseUrl, [
      "archive",
      "search",
      "--query",
      JSON.stringify({
        bins: ["binny-rss-one"],
        text: { in: "body", groups: [["标题資料🌿"]] },
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.deepEqual(titleOnlyBodySearch.results, []);
  const rssResources = rssV1.resources ?? [];
  const rssResourceBytes = await Promise.all(
    rssResources.map(({ resourceId }) => readRssResource(baseUrl, resourceId)),
  );
  assert.ok(
    rssResourceBytes.some((bytes) => bytes.equals(sourceMediaBytes.photoBytes)),
    "RSS 图片资源应能通过公开 HTTP 归档端点读取为信源原始字节。",
  );
  assert.ok(
    rssResourceBytes.some((bytes) => bytes.equals(sourceMediaBytes.audioBytes)),
    "RSS enclosure 应能通过公开 HTTP 归档端点读取为信源原始字节。",
  );

  const rssSummary = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "只有摘要版本 1",
  );
  const summaryState = rssArchiveView(rssSummary, "binny-rss-one");
  assert.equal(summaryState.capture.completeness, "complete");
  assert.equal(summaryState.capture.scope.bodySource, "summary");
  assert.equal(summaryState.body?.text, "只有摘要版本 1");

  const summaryItem = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "摘要正文版本 1",
  );
  assert.equal(summaryItem.sourceKey.namespace, "rss:summary-main");
  assert.equal(
    summaryItem.sourceKey.key,
    "id:urn:binny:summary:summary-article",
  );
  const summaryFullState = rssArchiveView(summaryItem, "binny-rss-one");
  assert.equal(summaryFullState.capture.completeness, "complete");
  assert.equal(summaryFullState.capture.scope.bodySource, "summary");
  assert.equal(summaryFullState.body?.html, undefined);
  assert.match(summaryFullState.body?.markdown ?? "", /摘要正文版本 1/u);
  assert.match(summaryFullState.body?.text ?? "", /摘要正文版本 1/u);
  assert.match(summaryFullState.body?.markdown ?? "", /binny:\/\/resource\//u);
  assert.equal(summaryFullState.resources?.length, 1);
  assert.deepEqual(
    await readRssResource(
      baseUrl,
      summaryFullState.resources?.[0]?.resourceId ?? "",
    ),
    sourceMediaBytes.photoBytes,
  );

  const summarySecondBinRun = await triggerRssAction(
    baseUrl,
    "binny-rss-two",
    "collect",
    { feedIds: ["summary-main"] },
  );
  assert.equal(summarySecondBinRun.status, "completed");
  const summaryArticleSecondBin = await readRssArchive(
    baseUrl,
    "binny-rss-two",
    "摘要正文版本 1",
  );
  assert.equal(summaryArticleSecondBin.itemId, summaryItem.itemId);
  assert.deepEqual(summaryArticleSecondBin.sourceKey, summaryItem.sourceKey);

  const summaryCheck = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "check",
    {
      feedIds: ["summary-main"],
    },
  );
  assert.equal(summaryCheck.status, "completed");
  assert.equal(summaryCheck.result?.output?.availability, "available");
  assert.deepEqual(summaryCheck.result?.output?.scope, ["summary-main"]);

  const atomItemV1 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "Atom 全文版本 1",
  );
  assert.equal(atomItemV1.sourceKey.namespace, "rss:atom-main");
  assert.equal(
    atomItemV1.sourceKey.key,
    "id:tag:example.test,2026:binny-rss-atom",
  );
  const atomV1 = rssArchiveView(atomItemV1, "binny-rss-one");
  assert.equal(atomV1.capture.completeness, "complete");
  assert.equal(atomV1.title, "Atom 全文测试文章");
  assert.deepEqual(atomV1.sourcePublishedAt, {
    precision: "day",
    value: "2026-10-27",
  });
  assert.deepEqual(atomV1.sourceModifiedAt, {
    precision: "instant",
    value: "2026-10-28T12:34:56-05:00",
  });
  assert.deepEqual(atomV1.extensions.authors, ["作者乙"]);
  assert.deepEqual(atomV1.extensions.categories, ["测试"]);
  assert.equal("title" in atomV1.extensions, false);
  assert.equal("published" in atomV1.extensions, false);
  assert.equal("updated" in atomV1.extensions, false);
  assert.equal(atomV1.body?.html, undefined);
  assert.match(atomV1.body?.markdown ?? "", /Atom 全文版本 1/u);
  assert.match(atomV1.body?.text ?? "", /Atom 全文版本 1/u);
  assert.equal(atomV1.resources?.length, 1);
  assert.deepEqual(
    await readRssResource(baseUrl, atomV1.resources?.[0]?.resourceId ?? ""),
    sourceMediaBytes.photoBytes,
  );

  const literalWidgetMatches = await searchRssArchive(
    baseUrl,
    "binny-rss-one",
    "<widget>",
  );
  assert.equal(
    literalWidgetMatches.length,
    6,
    "RSS HTML 与 Atom text、HTML、XHTML 正文中的代码文字应能按字面标签搜索。",
  );
  const literalWidgetItems = await Promise.all(
    literalWidgetMatches.map(async ({ itemId }) =>
      cliData<RssArchiveRead>(
        await cli(baseUrl, [
          "archive",
          "item",
          itemId,
          "--bin",
          "binny-rss-one",
        ]),
        "found",
      ),
    ),
  );
  assert.deepEqual(
    new Set(literalWidgetItems.map(({ sourceKey }) => sourceKey.key)),
    new Set([
      "id:urn:binny:rss:rss-item",
      "id:urn:binny:rss:rss-item-escaped",
      "id:tag:example.test,2026:binny-rss-atom",
      "id:tag:example.test,2026:atom-text-explicit",
      "id:tag:example.test,2026:atom-text-default",
      "id:tag:example.test,2026:atom-html-literal",
    ]),
  );
  const literalWidgetItemsByKey = new Map(
    literalWidgetItems.map((item) => [item.sourceKey.key, item]),
  );
  for (const [key, title] of [
    ["id:tag:example.test,2026:atom-text-explicit", "Atom 显式纯文本"],
    ["id:tag:example.test,2026:atom-text-default", "Atom 默认纯文本"],
  ] as const) {
    const atomTextItem = literalWidgetItemsByKey.get(key);
    assert.ok(atomTextItem !== undefined);
    const state = rssArchiveView(atomTextItem, "binny-rss-one");
    assert.equal(state.capture.completeness, "complete");
    assert.equal(state.body?.text, "代码 <widget> 与 A & B");
    assert.equal(state.body?.searchText, `${title}\n代码 <widget> 与 A & B`);
    assert.equal(state.body?.html, undefined);
    assert.equal(state.body?.markdown, "代码 &lt;widget&gt; 与 A &amp; B");
    assert.ok(
      typeof state.extensions?.item === "object" &&
        state.extensions.item !== null,
    );
    assert.equal(state.extensions?.item?.bodyType, "text");
  }
  const rssLiteralItem = literalWidgetItemsByKey.get(
    "id:urn:binny:rss:rss-item",
  );
  assert.ok(rssLiteralItem !== undefined);
  const rssLiteralState = rssArchiveView(rssLiteralItem, "binny-rss-one");
  assert.equal(rssLiteralState.capture.completeness, "complete");
  assert.match(rssLiteralState.body?.text ?? "", /代码 <widget> 与 A & B/u);
  assert.match(
    rssLiteralState.body?.searchText ?? "",
    /代码 <widget> 与 A & B/u,
  );
  assert.equal(rssLiteralState.body?.html, undefined);
  assert.match(rssLiteralState.body?.markdown ?? "", /&lt;widget&gt;/u);
  assert.equal(rssLiteralState.extensions?.item?.bodyType, "html");
  const rssEscapedLiteralItem = literalWidgetItemsByKey.get(
    "id:urn:binny:rss:rss-item-escaped",
  );
  assert.ok(rssEscapedLiteralItem !== undefined);
  const rssEscapedLiteralState = rssArchiveView(
    rssEscapedLiteralItem,
    "binny-rss-one",
  );
  assert.equal(rssEscapedLiteralState.capture.completeness, "complete");
  assert.equal(rssEscapedLiteralState.body?.text, "代码 <widget> 与 A & B");
  assert.equal(
    rssEscapedLiteralState.body?.searchText,
    "RSS XML 转义 HTML 测试文章\n代码 <widget> 与 A & B",
  );
  assert.equal(rssEscapedLiteralState.body?.html, undefined);
  assert.match(rssEscapedLiteralState.body?.markdown ?? "", /&lt;widget&gt;/u);
  assert.equal(rssEscapedLiteralState.extensions?.item?.bodyType, "html");
  for (const [key, bodyType] of [
    ["id:tag:example.test,2026:binny-rss-atom", "xhtml"],
    ["id:tag:example.test,2026:atom-html-literal", "html"],
  ] as const) {
    const atomMarkupItem = literalWidgetItemsByKey.get(key);
    assert.ok(atomMarkupItem !== undefined);
    const state = rssArchiveView(atomMarkupItem, "binny-rss-one");
    assert.equal(state.capture.completeness, "complete");
    assert.match(state.body?.text ?? "", /代码 <widget> 与 A & B/u);
    assert.match(state.body?.searchText ?? "", /代码 <widget> 与 A & B/u);
    assert.equal(state.body?.html, undefined);
    assert.match(state.body?.markdown ?? "", /&lt;widget&gt;/u);
    assert.equal(state.extensions?.item?.bodyType, bodyType);
  }
  const atomEntityTextMatches = await searchRssArchive(
    baseUrl,
    "binny-rss-one",
    "&lt;widget&gt;",
  );
  const atomEntityTextItem = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "Atom 纯文本中的实体字面值",
  );
  assert.ok(
    atomEntityTextMatches.some(
      ({ itemId }) => itemId === atomEntityTextItem.itemId,
    ),
    "escaped entity text search should include the Atom entity-text item.",
  );
  const atomEntityTextState = rssArchiveView(
    atomEntityTextItem,
    "binny-rss-one",
  );
  assert.equal(
    atomEntityTextItem.sourceKey.key,
    "id:tag:example.test,2026:atom-text-entities",
  );
  assert.equal(atomEntityTextState.body?.text, "A &lt;widget&gt; &amp; B");
  assert.equal(
    atomEntityTextState.body?.searchText,
    "Atom 纯文本中的实体字面值\nA &lt;widget&gt; &amp; B",
  );
  assert.equal(atomEntityTextState.body?.html, undefined);
  assert.equal(
    atomEntityTextState.body?.markdown,
    "A &amp;lt;widget&amp;gt; &amp;amp; B",
  );
  const atomModeTextV1 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "语义固定内容",
  );
  assert.equal(atomModeTextV1.revisions.length, 1);
  assert.equal(
    rssArchiveView(atomModeTextV1, "binny-rss-one").extensions?.item?.bodyType,
    "text",
  );

  await source.setRssVersion(2);
  await source.setAtomVersion(2);
  await source.setAtomTextMode("html");
  await source.setTemporaryAvailable(true);
  await source.holdFeed("/atom");
  const oldRuntimeContainerId = await runningContainerId("runtime-rss");
  const interruptedRun = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny-rss-one",
      "collect",
      "--params",
      JSON.stringify({ feedIds: ["rss-main", "atom-main"] }),
    ]),
    "triggered",
  );
  assert.equal(interruptedRun.status, "queued");
  await source.waitUntilFeedHeld("/atom");
  const activeInterruptedRun = cliData<RssManualRun>(
    await cli(baseUrl, ["run", "get", "binny-rss-one", interruptedRun.runId]),
    "found",
  );
  assert.equal(activeInterruptedRun.status, "executing");
  const rssCommittedBeforeStop = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 2",
  );
  assert.equal(rssCommittedBeforeStop.itemId, rssItemV1.itemId);
  assert.equal(rssCommittedBeforeStop.revisions.length, 2);
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-1"');

  await compose(["stop", "--timeout", "30", "runtime-rss"]);
  assert.equal(await containerStatus(oldRuntimeContainerId), "exited");
  const interruptedResult = await waitFor(
    async () =>
      cliData<RssManualRun>(
        await cli(baseUrl, [
          "run",
          "get",
          "binny-rss-one",
          interruptedRun.runId,
        ]),
        "found",
      ),
    (run) => run.status === "failed",
    "被镜像更新中断的 RSS 运行",
  );
  assert.equal(interruptedResult.result?.error?.code, "runtime_interrupted");
  assert.ok(interruptedResult.stopConfirmedAt);
  await source.releaseFeed();

  activeRssRuntimeImage = rssRuntimeImageName;
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
    "--no-deps",
    "--no-build",
    "--force-recreate",
    "runtime-rss",
  ]);
  const updatedRuntimeContainerId = await runningContainerId("runtime-rss");
  assert.notEqual(updatedRuntimeContainerId, oldRuntimeContainerId);
  assert.equal(
    await containerImageId("runtime-rss"),
    imageUpdate.candidateImageId,
  );
  await waitForRuntimeHealth("runtime-rss");
  await waitForRuntime(baseUrl, "binny-rss-one");
  await updateRssBinSourceAdapter(baseUrl, "binny-rss-one", activeManifest);
  const persistedInterruptedRun = cliData<RssManualRun>(
    await cli(baseUrl, ["run", "get", "binny-rss-one", interruptedRun.runId]),
    "found",
  );
  assert.equal(persistedInterruptedRun.status, "failed");
  assert.equal(
    persistedInterruptedRun.result?.error?.code,
    "runtime_interrupted",
  );
  assert.ok(persistedInterruptedRun.stopConfirmedAt);
  const configuredUpdatedBin = cliData<{
    readonly sourceAdapterVersion: string;
  }>(
    await cli(baseUrl, ["bin", "config-schema", "binny-rss-one"]),
    "discovered",
  );
  assert.equal(
    configuredUpdatedBin.sourceAdapterVersion,
    rssManifestVersion(activeManifest),
  );
  process.stdout.write(
    "RSS 正式镜像 A→B 更新与活动运行中断：" +
      JSON.stringify({
        baselineImage: rssBaselineRuntimeImageName,
        baselineImageId: imageUpdate.baselineImageId,
        candidateImage: rssRuntimeImageName,
        candidateImageId: imageUpdate.candidateImageId,
        binId: "binny-rss-one",
        interruptedRunId: interruptedRun.runId,
        runStatus: persistedInterruptedRun.status,
        stopConfirmed: true,
        rssItemId: rssCommittedBeforeStop.itemId,
        rssRevisionsBeforeStop: rssCommittedBeforeStop.revisions.length,
        oldRuntimeContainerId,
        updatedRuntimeContainerId,
      }) +
      "\n",
  );
  const afterRestart = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    {
      feedIds: ["rss-main", "atom-main", "temporary"],
    },
  );
  assert.equal(afterRestart.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-2"');
  const atomRequestAfterRestart = await latestRequest("/atom");
  assert.equal(atomRequestAfterRestart?.ifNoneMatch, undefined);
  assert.match(atomRequestAfterRestart?.ifModifiedSince ?? "", /GMT$/u);
  assert.equal((await latestRequest("/temporary"))?.ifNoneMatch, undefined);

  const rssItemV2 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 2",
  );
  assert.equal(rssItemV2.itemId, rssItemV1.itemId);
  assert.deepEqual(rssItemV2.sourceKey, rssItemV1.sourceKey);
  assert.equal(rssItemV2.revisions.length, 2);
  const atomModeHtmlV2 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "语义固定内容",
  );
  assert.equal(atomModeHtmlV2.itemId, atomModeTextV1.itemId);
  assert.equal(
    atomModeHtmlV2.revisions.length,
    2,
    "Atom 正文同值从 text 切换到 html 时应形成新的归档状态。",
  );
  assert.equal(
    rssArchiveView(atomModeHtmlV2, "binny-rss-one").extensions?.item?.bodyType,
    "html",
  );
  const stableItem = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 2",
  );
  const repeatedRun = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    {
      feedIds: ["rss-main"],
    },
  );
  assert.equal(repeatedRun.status, "completed");
  assert.deepEqual(repeatedRun.result?.commits, []);
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-2"');
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny-rss-one", "RSS 正文版本 2"),
    stableItem,
  );
  const stableAtomItem = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "Atom 全文版本 2",
  );
  const repeatedAtomRun = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    { feedIds: ["atom-main"] },
  );
  assert.equal(repeatedAtomRun.status, "completed");
  assert.deepEqual(repeatedAtomRun.result?.commits, []);
  assert.match((await latestRequest("/atom"))?.ifModifiedSince ?? "", /GMT$/u);
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny-rss-one", "Atom 全文版本 2"),
    stableAtomItem,
  );

  await source.setRssVersion(3);
  const archiveBeforeCheck = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 2",
  );
  const mediaRequestCount = (await source.requests()).filter(({ path }) =>
    path.startsWith("/media/"),
  ).length;
  const checkRun = await triggerRssAction(baseUrl, "binny-rss-one", "check", {
    feedIds: ["rss-main", "missing-body"],
  });
  assert.equal(checkRun.status, "completed");
  assert.equal(checkRun.result?.output?.availability, "unavailable");
  assert.deepEqual(checkRun.result?.output?.scope, [
    "rss-main",
    "missing-body",
  ]);
  assert.ok(
    checkRun.result?.output?.problems?.some(
      ({ code }) => code === "rss_entry_body_unavailable",
    ),
  );
  assert.deepEqual(checkRun.result?.commits, []);
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, undefined);
  assert.equal(
    (await source.requests()).filter(({ path }) => path.startsWith("/media/"))
      .length,
    mediaRequestCount,
  );
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny-rss-one", "RSS 正文版本 2"),
    archiveBeforeCheck,
  );

  const collectMissingBody = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    {
      feedIds: ["missing-body"],
    },
  );
  assert.equal(collectMissingBody.status, "failed");
  assert.equal(
    collectMissingBody.result?.error?.code,
    "rss_collection_incomplete",
  );
  assert.deepEqual(
    await searchRssArchive(baseUrl, "binny-rss-one", "RSS 缺失正文条目"),
    [],
  );

  const startHeldCheck = async (): Promise<string> => {
    await source.holdFeed("/rss");
    const triggered = cliData<{
      readonly runId: string;
      readonly status: string;
    }>(
      await cli(baseUrl, [
        "run",
        "trigger",
        "binny-rss-one",
        "check",
        "--params",
        JSON.stringify({ feedIds: ["rss-main"] }),
      ]),
      "triggered",
    );
    assert.equal(triggered.status, "queued");
    await source.waitUntilFeedHeld("/rss");
    const activeCheck = cliData<RssManualRun & { readonly action: string }>(
      await cli(baseUrl, ["run", "get", "binny-rss-one", triggered.runId]),
      "found",
    );
    assert.equal(activeCheck.status, "executing");
    assert.equal(activeCheck.action, "check");
    return triggered.runId;
  };

  const cancelledCheckRunId = await startHeldCheck();
  const cancelledCheckWorker = (
    await runtimeProcessSnapshot("runtime-rss")
  ).find((process) => process.command.includes("worker.js"));
  assert.ok(cancelledCheckWorker, "执行中的 RSS check 应有真实 worker 进程。");
  const cancellationRequest = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["run", "cancel", "binny-rss-one", cancelledCheckRunId]),
    "cancellation",
  );
  assert.equal(cancellationRequest.status, "cancelling");
  const cancelledCheckResult = await waitFor(
    async () =>
      cliData<RssManualRun>(
        await cli(baseUrl, [
          "run",
          "get",
          "binny-rss-one",
          cancelledCheckRunId,
        ]),
        "found",
      ),
    (run) => run.status === "cancelled",
    "执行中的 RSS check 收到取消并终结",
  );
  assert.ok(cancelledCheckResult.stopConfirmedAt);
  assert.equal(cancelledCheckResult.result?.stopReason.code, "cancelled");
  assert.equal(cancelledCheckResult.result?.commits.length, 0);
  await waitFor(
    () => runtimeProcessSnapshot("runtime-rss"),
    (processes) =>
      !processes.some(({ pgid }) => pgid === cancelledCheckWorker.pgid),
    "取消确认后的 RSS check worker 退出",
  );
  await source.releaseFeed();
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny-rss-one", "RSS 正文版本 2"),
    archiveBeforeCheck,
  );

  const oldCheckRuntimeContainerId = await runningContainerId("runtime-rss");
  const interruptedCheckRunId = await startHeldCheck();
  assert.ok(
    (await runtimeProcessSnapshot("runtime-rss")).some((process) =>
      process.command.includes("worker.js"),
    ),
    "被中断的 RSS check 应有真实 worker 进程。",
  );
  await compose(["stop", "--timeout", "30", "runtime-rss"]);
  assert.equal(await containerStatus(oldCheckRuntimeContainerId), "exited");
  const stoppedRuntimePid = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Pid}}",
    oldCheckRuntimeContainerId,
  ]);
  assert.equal(stoppedRuntimePid.code, 0, stoppedRuntimePid.stderr);
  assert.equal(stoppedRuntimePid.stdout.trim(), "0");
  const interruptedCheckResult = await waitFor(
    async () =>
      cliData<RssManualRun>(
        await cli(baseUrl, [
          "run",
          "get",
          "binny-rss-one",
          interruptedCheckRunId,
        ]),
        "found",
      ),
    (run) => run.status === "failed",
    "RSS check 运行器停止后报中断并确认退出",
  );
  assert.equal(
    interruptedCheckResult.result?.error?.code,
    "runtime_interrupted",
  );
  assert.ok(interruptedCheckResult.stopConfirmedAt);
  assert.equal(interruptedCheckResult.result?.commits.length, 0);
  await source.releaseFeed();
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
    "--no-deps",
    "--no-build",
    "--force-recreate",
    "runtime-rss",
  ]);
  const resumedCheckRuntimeContainerId =
    await runningContainerId("runtime-rss");
  assert.notEqual(resumedCheckRuntimeContainerId, oldCheckRuntimeContainerId);
  assert.equal(
    await containerImageId("runtime-rss"),
    imageUpdate.candidateImageId,
  );
  await waitForRuntimeHealth("runtime-rss");
  await waitForRuntime(baseUrl, "binny-rss-one");
  const persistedInterruptedCheck = cliData<RssManualRun>(
    await cli(baseUrl, ["run", "get", "binny-rss-one", interruptedCheckRunId]),
    "found",
  );
  assert.equal(persistedInterruptedCheck.status, "failed");
  assert.equal(
    persistedInterruptedCheck.result?.error?.code,
    "runtime_interrupted",
  );
  assert.ok(persistedInterruptedCheck.stopConfirmedAt);
  assert.deepEqual(
    await readRssArchive(baseUrl, "binny-rss-one", "RSS 正文版本 2"),
    archiveBeforeCheck,
  );
  assert.equal(
    (await source.requests()).filter(({ path }) => path.startsWith("/media/"))
      .length,
    mediaRequestCount,
  );
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, undefined);

  const afterCheck = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    {
      feedIds: ["rss-main"],
    },
  );
  assert.equal(afterCheck.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-2"');
  process.stdout.write(
    "RSS 独立 check 执行中取消与运行器中断：" +
      JSON.stringify({
        cancelledCheckRunId,
        cancelledStatus: cancelledCheckResult.status,
        cancelStopConfirmed: true,
        cancelWorkerExited: true,
        interruptedCheckRunId,
        interruptedStatus: persistedInterruptedCheck.status,
        interruptStopConfirmed: true,
        oldRuntimeContainerExited: true,
        newRuntimeContainerId: resumedCheckRuntimeContainerId,
        nextCollectIfNoneMatch: (await latestRequest("/rss"))?.ifNoneMatch,
      }) +
      "\n",
  );
  const rssItemV3 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 3",
  );
  assert.equal(rssItemV3.itemId, rssItemV1.itemId);

  await source.setRssVersion(4);
  await source.setPhotoAvailable(false);
  const partialMediaRun = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(partialMediaRun.status, "failed");
  assert.equal(
    partialMediaRun.result?.error?.code,
    "rss_collection_incomplete",
  );
  const rssItemPartial = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 4",
  );
  assert.equal(rssItemPartial.itemId, rssItemV1.itemId);
  const partialState = rssArchiveView(rssItemPartial, "binny-rss-one");
  assert.equal(partialState.capture.completeness, "partial");
  assert.ok(
    partialState.capture.missing.some(
      ({ path, reason }) =>
        path.startsWith("media.") && reason.includes("本次未能取得或归档"),
    ),
  );
  assert.equal(partialState.resources?.length, 1);
  assert.equal(partialState.body?.html, undefined);
  assert.doesNotMatch(
    partialState.body?.markdown ?? "",
    /!\[RSS 封面\]\(binny:\/\/resource\//u,
  );
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-3"');

  await source.setPhotoAvailable(true);
  const mediaRecovery = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(mediaRecovery.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, undefined);
  const rssItemV4 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 4",
  );
  assert.equal(rssItemV4.itemId, rssItemV1.itemId);
  const rssV4 = rssArchiveView(rssItemV4, "binny-rss-one");
  assert.equal(rssV4.capture.completeness, "complete");
  assert.equal(rssV4.resources?.length, 2);
  assert.equal(rssV4.body?.html, undefined);
  assert.match(
    rssV4.body?.markdown ?? "",
    /!\[RSS 封面\]\(binny:\/\/resource\//u,
  );
  const recoveredResourceBytes = await Promise.all(
    (rssV4.resources ?? []).map(({ resourceId }) =>
      readRssResource(baseUrl, resourceId),
    ),
  );
  assert.ok(
    recoveredResourceBytes.some((bytes) =>
      bytes.equals(sourceMediaBytes.photoBytes),
    ),
  );
  assert.ok(
    recoveredResourceBytes.some((bytes) =>
      bytes.equals(sourceMediaBytes.audioBytes),
    ),
  );

  await source.setRssVersion(5);
  let watchUpdateEvidence:
    | {
        readonly version: string;
        readonly imageId: string;
        readonly previousImageId: string;
        readonly previousContainerId: string;
        readonly updatedContainerId: string;
      }
    | undefined;
  if (!preserveCapacityProject) {
    const watchVersion = rssManifestVersion(activeManifest) + "-watch";
    const watchManifest = rssManifestWithVersion(activeManifest, watchVersion);
    activeManifest = watchManifest;
    const watchedUpdate = await rebuildRssRuntimeWithComposeWatch(
      baseUrl,
      imageUpdate,
      watchVersion,
    );
    await updateRssBinSourceAdapter(baseUrl, "binny-rss-one", activeManifest);
    assert.notEqual(watchedUpdate.imageId, imageUpdate.candidateImageId);
    assert.equal(await imageId(rssRuntimeImageName), watchedUpdate.imageId);
    watchUpdateEvidence = { version: watchVersion, ...watchedUpdate };
  }
  const postMediaRestart = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(postMediaRestart.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-4"');
  const rssItemV5 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 5",
  );
  assert.equal(rssItemV5.itemId, rssItemV1.itemId);
  assert.deepEqual(
    await Promise.all(
      rssResources.map(({ resourceId }) =>
        readRssResource(baseUrl, resourceId),
      ),
    ),
    rssResourceBytes,
    "Watch 更新后既有 RSS 媒体仍应可从归档读取。",
  );
  if (watchUpdateEvidence !== undefined) {
    process.stdout.write(
      "Compose Watch RSS rebuild 更新证据：" +
        JSON.stringify({
          candidateImageId: imageUpdate.candidateImageId,
          ...watchUpdateEvidence,
          requestIfNoneMatch: (await latestRequest("/rss"))?.ifNoneMatch,
          itemId: rssItemV5.itemId,
          resourceCount: rssResources.length,
        }) +
        "\n",
    );
  }

  const separateBinRun = await triggerRssAction(
    baseUrl,
    "binny-rss-two",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(separateBinRun.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, undefined);
  const secondBinItemV5 = await readRssArchive(
    baseUrl,
    "binny-rss-two",
    "RSS 正文版本 5",
  );
  assert.equal(secondBinItemV5.itemId, rssItemV1.itemId);
  assert.deepEqual(secondBinItemV5.sourceKey, rssItemV1.sourceKey);

  await source.setRssVersion(6);
  const secondOldImageId = await containerImageId("runtime-rss-two");
  await compose([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
    "--no-deps",
    "--no-build",
    "--force-recreate",
    "runtime-rss-two",
  ]);
  assert.notEqual(
    await containerImageId("runtime-rss-two"),
    secondOldImageId,
    "第二个 bin 的 RSS 运行器应切换到更新后的镜像。",
  );
  await waitForRuntimeHealth("runtime-rss-two");
  await waitForRuntime(baseUrl, "binny-rss-two");
  await updateRssBinSourceAdapter(baseUrl, "binny-rss-two", activeManifest);
  const separateBinRestart = await triggerRssAction(
    baseUrl,
    "binny-rss-two",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(separateBinRestart.status, "completed");
  assert.equal((await latestRequest("/rss"))?.ifNoneMatch, '"rss-5"');
  const secondBinItemV6 = await readRssArchive(
    baseUrl,
    "binny-rss-two",
    "RSS 正文版本 6",
  );
  assert.equal(secondBinItemV6.itemId, rssItemV1.itemId);

  await source.setRssVersion(7);
  const editedConfig = {
    feeds: config.feeds.map((feed) =>
      feed.id === "rss-main"
        ? { ...feed, url: source.baseUrl + "/rss-edited" }
        : feed,
    ),
  };
  const updatedBin = cliData<{ readonly id: string }>(
    await cli(baseUrl, [
      "bin",
      "update",
      "binny-rss-one",
      "--config",
      JSON.stringify(editedConfig),
    ]),
    "updated",
  );
  assert.equal(updatedBin.id, "binny-rss-one");
  const afterUrlEdit = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(afterUrlEdit.status, "completed");
  assert.equal((await latestRequest("/rss-edited"))?.ifNoneMatch, undefined);
  const rssItemV7 = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 7",
  );
  assert.equal(rssItemV7.itemId, rssItemV1.itemId);
  assert.deepEqual(rssItemV7.sourceKey, rssItemV1.sourceKey);

  await source.setRssVersion(8);
  await source.setPhotoAvailable(false);
  const latestPartialRun = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    { feedIds: ["rss-main"] },
  );
  assert.equal(latestPartialRun.status, "failed");
  assert.equal(
    latestPartialRun.result?.error?.code,
    "rss_collection_incomplete",
  );
  const rssLatestPartial = await readRssArchive(
    baseUrl,
    "binny-rss-one",
    "RSS 正文版本 8",
  );
  assert.equal(rssLatestPartial.itemId, rssItemV1.itemId);
  const latestPartialState = rssArchiveView(rssLatestPartial, "binny-rss-one");
  assert.equal(latestPartialState.capture.completeness, "partial");
  assert.ok(latestPartialState.capture.missing.length > 0);
  assert.ok((latestPartialState.resources?.length ?? 0) > 0);
  assert.deepEqual(
    await Promise.all(
      rssResources.map(({ resourceId }) =>
        readRssResource(baseUrl, resourceId),
      ),
    ),
    rssResourceBytes,
    "最新部分版本不得使先前版本的媒体字节失效。",
  );
  const crossBinItem = cliData<RssArchiveRead>(
    await cli(baseUrl, ["archive", "item", rssItemV1.itemId]),
    "found",
  );
  assert.deepEqual(
    crossBinItem.views
      .map(({ binId }) => binId)
      .filter((binId) => ["binny-rss-one", "binny-rss-two"].includes(binId))
      .toSorted(),
    ["binny-rss-one", "binny-rss-two"],
  );
  assert.equal(
    rssArchiveView(crossBinItem, "binny-rss-one").capture.completeness,
    "partial",
  );
  assert.equal(
    rssArchiveView(crossBinItem, "binny-rss-two").capture.completeness,
    "complete",
  );
  const latestPartialView = rssLatestPartial.views.find(
    ({ binId }) => binId === "binny-rss-one",
  );
  assert.ok(latestPartialView !== undefined);

  const badIdentityCheck = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "check",
    { feedIds: ["bad-identity"] },
  );
  assert.equal(badIdentityCheck.status, "completed");
  assert.equal(badIdentityCheck.result?.output?.availability, "unavailable");
  assert.deepEqual(badIdentityCheck.result?.output?.scope, ["bad-identity"]);
  assert.ok(
    badIdentityCheck.result?.output?.problems?.some(
      ({ code, suggestion }) =>
        code === "rss_entry_identity_unavailable" &&
        (suggestion?.length ?? 0) > 0,
    ),
  );
  const badIdentityRun = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "collect",
    { feedIds: ["bad-identity"] },
  );
  assert.equal(badIdentityRun.status, "failed");
  assert.equal(badIdentityRun.result?.error?.code, "rss_collection_incomplete");
  assert.equal(
    (await searchRssArchive(baseUrl, "binny-rss-one", "坏身份正文不得进入归档"))
      .length,
    0,
  );

  const realFeedUrl =
    "https://github.com/rowanmanning/feed-parser/releases.atom";
  const realFeedCheck = await triggerRssAction(
    baseUrl,
    "binny-rss-one",
    "check",
    { feedIds: ["real-feed-parser"] },
  );
  assert.equal(realFeedCheck.status, "completed");
  assert.deepEqual(realFeedCheck.result?.output?.scope, ["real-feed-parser"]);
  process.stdout.write(
    "真实 feed 兼容性结果：" +
      JSON.stringify({
        url: realFeedUrl,
        environment: "Compose runtime-rss 正式轻量镜像",
        action: "check",
        scope: realFeedCheck.result?.output?.scope,
        availability: realFeedCheck.result?.output?.availability,
        problems: realFeedCheck.result?.output?.problems,
      }) +
      "\n",
  );

  const initialCommit = initialRun.result?.commits.find(({ items }) =>
    items.some(({ itemId }) => itemId === rssItemV1.itemId),
  );
  assert.ok(initialCommit !== undefined);
  assert.equal(initialCommit.commitId.length > 0, true);
  return {
    binIds: ["binny-rss-one", "binny-rss-two"],
    itemId: rssItemV1.itemId,
    initialRevisionId: initialRssView.revisionId,
    initialRunId: initialRun.runId,
    commitId: initialCommit.commitId,
    resourceIds: rssV1.resources?.map(({ resourceId }) => resourceId) ?? [],
    latestPartialRevisionId: latestPartialView.revisionId,
    latestPartialResourceIds:
      latestPartialState.resources?.map(({ resourceId }) => resourceId) ?? [],
  };
}

type PostgresPerformanceStats = {
  readonly sequentialScans: number;
  readonly sequentialTuplesRead: number;
  readonly indexScans: number;
  readonly indexTuplesFetched: number;
  readonly temporaryFiles: number;
  readonly temporaryBytes: number;
  readonly databaseBytes: number;
};

type ContainerLimit = {
  readonly service: string;
  readonly nanoCpus: number;
  readonly cpuQuota: number;
  readonly cpuPeriod: number;
  readonly cpuCores: number;
  readonly memoryBytes: number;
};

type ContainerUsage = {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly blockIo: string;
  readonly processes: number;
};

type CapacitySampler = {
  samples: number;
  peakCombinedCpuPercent: number;
  peakCombinedMemoryBytes: number;
  readonly server: {
    peakCpuPercent: number;
    peakMemoryBytes: number;
    blockIo: string;
    processes: number;
  };
  readonly postgres: {
    peakCpuPercent: number;
    peakMemoryBytes: number;
    blockIo: string;
    processes: number;
  };
};

function parseDockerBytes(value: string): number {
  const matched = /^([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB|TB|TiB)$/u.exec(
    value.trim(),
  );
  assert.ok(matched, "无法解析 Docker 内存字节值：" + value);
  const scale: Readonly<Record<string, number>> = {
    B: 1,
    kB: 1_000,
    KiB: 1_024,
    MB: 1_000_000,
    MiB: 1_048_576,
    GB: 1_000_000_000,
    GiB: 1_073_741_824,
    TB: 1_000_000_000_000,
    TiB: 1_099_511_627_776,
  };
  return Number(matched[1]) * scale[matched[2]!]!;
}

async function readPostgresPerformanceStats(): Promise<PostgresPerformanceStats> {
  const query = [
    "WITH table_stats AS (",
    "      SELECT",
    "        COALESCE(sum(seq_scan), 0) AS sequential_scans,",
    "        COALESCE(sum(seq_tup_read), 0) AS sequential_tuples_read,",
    "        COALESCE(sum(idx_scan), 0) AS index_scans,",
    "        COALESCE(sum(idx_tup_fetch), 0) AS index_tuples_fetched",
    "      FROM pg_stat_user_tables",
    "    ), database_stats AS (",
    "      SELECT temp_files AS temporary_files, temp_bytes AS temporary_bytes",
    "      FROM pg_stat_database WHERE datname = current_database()",
    "    )",
    "    SELECT json_build_object(",
    "      'sequentialScans', table_stats.sequential_scans,",
    "      'sequentialTuplesRead', table_stats.sequential_tuples_read,",
    "      'indexScans', table_stats.index_scans,",
    "      'indexTuplesFetched', table_stats.index_tuples_fetched,",
    "      'temporaryFiles', database_stats.temporary_files,",
    "      'temporaryBytes', database_stats.temporary_bytes,",
    "      'databaseBytes', pg_database_size(current_database())",
    "    )::text",
    "    FROM table_stats CROSS JOIN database_stats;",
  ].join("\n");
  const result = await compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-A",
    "-t",
    "-q",
    "-U",
    "binny",
    "-d",
    "binny",
    "-c",
    query,
  ]);
  return JSON.parse(result.stdout.trim()) as PostgresPerformanceStats;
}

async function inspectContainerLimit(service: string): Promise<ContainerLimit> {
  const id = (await compose(["ps", "-q", service])).stdout.trim();
  assert.ok(id, "没有找到容量验收服务容器：" + service);
  const result = await run("docker", [
    "inspect",
    "--format",
    "{{.HostConfig.NanoCpus}}|{{.HostConfig.CpuQuota}}|{{.HostConfig.CpuPeriod}}|{{.HostConfig.Memory}}",
    id,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const [nanoText, quotaText, periodText, memoryText] = result.stdout
    .trim()
    .split("|");
  const nanoCpus = Number(nanoText);
  const cpuQuota = Number(quotaText);
  const cpuPeriod = Number(periodText);
  const memoryBytes = Number(memoryText);
  const cpuCores =
    nanoCpus > 0 ? nanoCpus / 1_000_000_000 : cpuQuota / cpuPeriod;
  return { service, nanoCpus, cpuQuota, cpuPeriod, cpuCores, memoryBytes };
}

async function readContainerUsage(
  serverId: string,
  postgresId: string,
): Promise<{
  readonly server: ContainerUsage;
  readonly postgres: ContainerUsage;
}> {
  const result = await run("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.BlockIO}}|{{.PIDs}}",
    serverId,
    postgresId,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const byId = new Map<string, ContainerUsage>();
  for (const line of result.stdout.trim().split("\n")) {
    const [id, cpuText, memoryText, blockIo, processText] = line.split("|");
    assert.ok(id && cpuText && memoryText && blockIo && processText);
    const usedMemory = memoryText.split("/")[0];
    assert.ok(usedMemory);
    byId.set(id, {
      cpuPercent: Number(cpuText.replace("%", "")),
      memoryBytes: parseDockerBytes(usedMemory),
      blockIo,
      processes: Number(processText),
    });
  }
  const findUsage = (containerId: string): ContainerUsage | undefined =>
    [...byId].find(([id]) => containerId.startsWith(id))?.[1];
  const server = findUsage(serverId);
  const postgres = findUsage(postgresId);
  assert.ok(server, "Docker stats 没有返回 core 容器采样。");
  assert.ok(postgres, "Docker stats 没有返回 PostgreSQL 容器采样。");
  return { server, postgres };
}

function updateCapacitySampler(
  sampler: CapacitySampler,
  usage: { readonly server: ContainerUsage; readonly postgres: ContainerUsage },
): void {
  sampler.samples += 1;
  sampler.server.peakCpuPercent = Math.max(
    sampler.server.peakCpuPercent,
    usage.server.cpuPercent,
  );
  sampler.server.peakMemoryBytes = Math.max(
    sampler.server.peakMemoryBytes,
    usage.server.memoryBytes,
  );
  sampler.server.blockIo = usage.server.blockIo;
  sampler.server.processes = usage.server.processes;
  sampler.postgres.peakCpuPercent = Math.max(
    sampler.postgres.peakCpuPercent,
    usage.postgres.cpuPercent,
  );
  sampler.postgres.peakMemoryBytes = Math.max(
    sampler.postgres.peakMemoryBytes,
    usage.postgres.memoryBytes,
  );
  sampler.postgres.blockIo = usage.postgres.blockIo;
  sampler.postgres.processes = usage.postgres.processes;
  sampler.peakCombinedCpuPercent = Math.max(
    sampler.peakCombinedCpuPercent,
    usage.server.cpuPercent + usage.postgres.cpuPercent,
  );
  sampler.peakCombinedMemoryBytes = Math.max(
    sampler.peakCombinedMemoryBytes,
    usage.server.memoryBytes + usage.postgres.memoryBytes,
  );
}

async function readVolumeUsage(
  service: "server" | "postgres",
  directory: string,
): Promise<{
  readonly allocatedBytes: number;
  readonly apparentBytes?: number;
  readonly fileCount?: number;
  readonly availableBytes: number;
}> {
  const allocationArguments =
    service === "server" ? ["-sB1", directory] : ["-sk", directory];
  const allocationScale = service === "server" ? 1 : 1_024;
  const allocated = await compose([
    "exec",
    "--no-TTY",
    service,
    "du",
    ...allocationArguments,
  ]);
  const df = await compose([
    "exec",
    "--no-TTY",
    service,
    "df",
    "-B1",
    "-P",
    directory,
  ]);
  const allocation =
    Number(allocated.stdout.trim().split(/\s+/u)[0]) * allocationScale;
  const dfColumns = df.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/u);
  assert.ok(Number.isSafeInteger(allocation) && allocation >= 0);
  assert.ok(
    dfColumns !== undefined && Number.isSafeInteger(Number(dfColumns[3])),
  );

  let apparentBytes: number | undefined;
  let fileCount: number | undefined;
  if (service === "server") {
    const fileSizes = await compose([
      "exec",
      "--no-TTY",
      "server",
      "find",
      directory,
      "-type",
      "f",
      "-printf",
      "%s\n",
    ]);
    const sizes = fileSizes.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(Number);
    apparentBytes = sizes.reduce((total, size) => total + size, 0);
    fileCount = sizes.length;
  }
  return {
    allocatedBytes: allocation,
    ...(apparentBytes === undefined ? {} : { apparentBytes }),
    ...(fileCount === undefined ? {} : { fileCount }),
    availableBytes: Number(dfColumns[3]),
  };
}

async function runCapacityAcceptance(baseUrl: string): Promise<void> {
  const dockerInfo = await run("docker", [
    "info",
    "--format",
    "{{.NCPU}}|{{.MemTotal}}|{{.DockerRootDir}}",
  ]);
  assert.equal(dockerInfo.code, 0, dockerInfo.stderr);
  const [hostCpuText, hostMemoryText, dockerRoot] = dockerInfo.stdout
    .trim()
    .split("|");
  const host = {
    cpuCount: Number(hostCpuText),
    memoryBytes: Number(hostMemoryText),
    dockerRoot,
  };
  const networkSubnets = {
    api: await networkSubnet(projectName + "_default"),
    runtime: await networkSubnet(projectName + "_runtime"),
    connections: await networkSubnet(projectName + "_connections"),
    ...(isFullCapacityRun &&
    (capacityPhase === "verify" || capacityPhase === "delete")
      ? {}
      : {
          browser: await networkSubnet(projectName + "_browser"),
          linuxdo: await networkSubnet(projectName + "_linuxdo"),
        }),
  };
  assert.equal(
    networkSubnets.api,
    process.env.BINNY_E2E_SUBNET ?? "10.253.23.0/24",
  );
  assert.equal(
    networkSubnets.runtime,
    process.env.BINNY_E2E_RUNTIME_SUBNET ?? "10.253.150.0/24",
  );
  assert.equal(
    networkSubnets.connections,
    process.env.BINNY_E2E_CONNECTIONS_SUBNET ?? "10.253.151.0/24",
  );
  if ("browser" in networkSubnets && "linuxdo" in networkSubnets) {
    assert.equal(
      networkSubnets.browser,
      process.env.BINNY_E2E_BROWSER_SUBNET ?? "10.253.152.0/24",
    );
    assert.equal(
      networkSubnets.linuxdo,
      process.env.BINNY_E2E_LINUXDO_SUBNET ?? "10.253.153.0/24",
    );
  }
  const serverId = (await compose(["ps", "-q", "server"])).stdout.trim();
  const postgresId = (await compose(["ps", "-q", "postgres"])).stdout.trim();
  assert.ok(serverId && postgresId);
  const limits = await Promise.all([
    inspectContainerLimit("server"),
    inspectContainerLimit("postgres"),
  ]);
  for (const limit of limits) {
    assert.ok(
      Math.abs(limit.cpuCores - 1) < 0.001,
      limit.service + " 应限制为 1 vCPU。",
    );
    assert.equal(limit.memoryBytes, 2 * 1024 * 1024 * 1024);
  }

  const resourceVolumeBefore = await readVolumeUsage(
    "server",
    "/var/lib/binny/resources",
  );
  const postgresVolumeBefore = await readVolumeUsage(
    "postgres",
    "/var/lib/postgresql/data",
  );
  if (preserveCapacityProject && capacityPhase === "seed") {
    assert.ok(
      resourceVolumeBefore.availableBytes >= 102_000_000_000,
      "百 GB 媒体负载前可用卷空间不足；没有开始上传。",
    );
  }
  const before = await readPostgresPerformanceStats();
  const sampler: CapacitySampler = {
    samples: 0,
    peakCombinedCpuPercent: 0,
    peakCombinedMemoryBytes: 0,
    server: {
      peakCpuPercent: 0,
      peakMemoryBytes: 0,
      blockIo: "",
      processes: 0,
    },
    postgres: {
      peakCpuPercent: 0,
      peakMemoryBytes: 0,
      blockIo: "",
      processes: 0,
    },
  };
  const stageStartedAt = Date.now();
  let sampling = true;
  let samplingError: unknown;
  const sample = async (): Promise<void> => {
    updateCapacitySampler(
      sampler,
      await readContainerUsage(serverId, postgresId),
    );
    if (sampler.samples % 12 === 0) {
      process.stdout.write(
        "容量负载采样：已运行 " +
          String(Math.floor((Date.now() - stageStartedAt) / 1000)) +
          " 秒，core+PostgreSQL 峰值内存 " +
          String(sampler.peakCombinedMemoryBytes) +
          " B。\n",
      );
    }
  };
  const samplerTask = (async (): Promise<void> => {
    while (sampling) {
      await sample();
      if (sampling) await wait(5_000);
    }
  })().catch((error: unknown) => {
    samplingError = error;
  });

  let apiReport = "";
  try {
    apiReport = await capacityHttpStep(baseUrl);
  } finally {
    sampling = false;
    await samplerTask;
  }
  if (samplingError !== undefined) throw samplingError;

  const after = await readPostgresPerformanceStats();
  const resourceVolume = await readVolumeUsage(
    "server",
    "/var/lib/binny/resources",
  );
  const postgresVolume = await readVolumeUsage(
    "postgres",
    "/var/lib/postgresql/data",
  );
  const resourceVolumeDelta = {
    allocatedBytes:
      resourceVolume.allocatedBytes - resourceVolumeBefore.allocatedBytes,
    apparentBytes:
      resourceVolume.apparentBytes! - resourceVolumeBefore.apparentBytes!,
    fileCount: resourceVolume.fileCount! - resourceVolumeBefore.fileCount!,
    availableBytes:
      resourceVolume.availableBytes - resourceVolumeBefore.availableBytes,
  };
  const postgresVolumeDelta = {
    allocatedBytes:
      postgresVolume.allocatedBytes - postgresVolumeBefore.allocatedBytes,
    availableBytes:
      postgresVolume.availableBytes - postgresVolumeBefore.availableBytes,
  };
  const capacityReport = JSON.parse(apiReport) as {
    readonly uniqueReferencedResourceCount: number;
    readonly expectedReferencedUniqueMediaBytes: number;
  };
  if (capacityPhase === "seed" || capacityPhase === "all") {
    assert.equal(
      resourceVolumeDelta.fileCount,
      capacityReport.uniqueReferencedResourceCount,
      "磁盘新增资源文件数应与正式上传的唯一资源数相符。",
    );
    assert.equal(
      resourceVolumeDelta.apparentBytes,
      capacityReport.expectedReferencedUniqueMediaBytes,
      "磁盘新增资源正文总字节数应与 HTTP 上传的唯一媒体字节相符。",
    );
  } else if (capacityPhase === "delete") {
    assert.equal(resourceVolumeDelta.fileCount, 0);
    assert.equal(resourceVolumeDelta.apparentBytes, 0);
  }
  const commit = process.env.BINNY_ACCEPTANCE_COMMIT;
  assert.ok(
    commit !== undefined && /^[0-9a-f]{40}$/u.test(commit),
    "根准备入口应提供提交标识。",
  );
  const serverImageId = await containerImageId("server");
  const serverBuildImageId = await imageId(activeServerImage);
  const postgresImageId = await containerImageId("postgres");
  const tree = process.env.BINNY_ACCEPTANCE_TREE;
  assert.ok(
    tree !== undefined && /^[0-9a-f]{40}$/u.test(tree),
    "根准备入口应提供源码树标识。",
  );
  const delta = {
    sequentialScans: after.sequentialScans - before.sequentialScans,
    sequentialTuplesRead:
      after.sequentialTuplesRead - before.sequentialTuplesRead,
    indexScans: after.indexScans - before.indexScans,
    indexTuplesFetched: after.indexTuplesFetched - before.indexTuplesFetched,
    temporaryFiles: after.temporaryFiles - before.temporaryFiles,
    temporaryBytes: after.temporaryBytes - before.temporaryBytes,
  };
  process.stdout.write(
    "归档容量验收实测：" +
      JSON.stringify(
        {
          project: projectName,
          phase: capacityPhase,
          commit,
          tree,
          serverImageId,
          serverBuildImageId,
          postgresImageId,
          node: process.version,
          host,
          networkSubnets,
          coreAndPostgresLimits: limits,
          resourcesVolumeBefore: resourceVolumeBefore,
          resourcesVolumeDelta: resourceVolumeDelta,
          sampleCount: sampler.samples,
          elapsedMilliseconds: Date.now() - stageStartedAt,
          peakCombinedCpuPercent: sampler.peakCombinedCpuPercent,
          peakCombinedMemoryBytes: sampler.peakCombinedMemoryBytes,
          containerPeaks: {
            server: sampler.server,
            postgres: sampler.postgres,
          },
          resourcesVolume: resourceVolume,
          postgresVolumeBefore,
          postgresVolume,
          postgresVolumeDelta,
          postgresPerformance: { before, after, delta },
          capacity: capacityReport,
          preservedForNextPhase: preserveCapacityProject,
        },
        null,
        2,
      ) +
      "\n",
  );
}

async function main(): Promise<void> {
  const overrideDirectory = await mkdtemp(
    path.join(tmpdir(), "binny-archive-revision-diff-compose-"),
  );
  composeOverrideFile = path.join(overrideDirectory, "compose.yaml");
  const e2eSubnet = process.env.BINNY_E2E_SUBNET ?? "10.253.23.0/24";
  const runtimeSubnet =
    process.env.BINNY_E2E_RUNTIME_SUBNET ?? "10.253.150.0/24";
  const connectionsSubnet =
    process.env.BINNY_E2E_CONNECTIONS_SUBNET ?? "10.253.151.0/24";
  const browserSubnet =
    process.env.BINNY_E2E_BROWSER_SUBNET ?? "10.253.152.0/24";
  const linuxdoSubnet =
    process.env.BINNY_E2E_LINUXDO_SUBNET ?? "10.253.153.0/24";
  await writeFile(
    composeOverrideFile,
    [
      "services:",
      "  postgres:",
      '    cpus: "1.0"',
      '    mem_limit: "2g"',
      "  server:",
      '    cpus: "1.0"',
      '    mem_limit: "2g"',
      "    ports: !override",
      '      - "3000"',
      "    networks: !override",
      "      - default",
      "      - runtime",
      "      - connections",
      "  manual-runs-source:",
      "    ports: !override",
      '      - "8081"',
      "    networks:",
      "      - default",
      "      - runtime",
      "  rss-e2e-source:",
      "    ports: !override",
      '      - "8081"',
      "    networks:",
      "      - default",
      "      - runtime",
      "  runtime-fifteen-one:",
      "    environment:",
      useHeartbeatProxy
        ? "      BINNY_API_URL: http://heartbeat-proxy:8082"
        : "      BINNY_API_URL: http://server:3000",
      "    networks: !override",
      "      - runtime",
      "  runtime-fifteen-two:",
      "    environment:",
      useHeartbeatProxy
        ? "      BINNY_API_URL: http://heartbeat-proxy:8082"
        : "      BINNY_API_URL: http://server:3000",
      "    networks: !override",
      "      - runtime",
      "  runtime-linuxdo:",
      "    networks: !override",
      "      - runtime",
      "      - connections",
      "      - browser",
      "      - linuxdo",
      "  runtime-linuxdo-two:",
      "    networks: !override",
      "      - runtime",
      "      - connections",
      "      - browser",
      "      - linuxdo",
      "  linuxdo-e2e-source:",
      "    ports: !override",
      '      - "8081"',
      "    networks: !override",
      "      linuxdo:",
      "        aliases:",
      "          - linuxdo-e2e-media",
      "  heartbeat-proxy:",
      `    image: ${imageName}`,
      "    command:",
      "      - node",
      "      - scripts/binny-e2e-heartbeat-proxy.ts",
      "    ports: !override",
      '      - "8082"',
      '      - "8083"',
      "    depends_on:",
      "      server:",
      "        condition: service_started",
      "    networks:",
      "      - default",
      "      - runtime",
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      `        - subnet: ${e2eSubnet}`,
      "  runtime:",
      "    ipam:",
      "      config:",
      `        - subnet: ${runtimeSubnet}`,
      "  connections:",
      "    ipam:",
      "      config:",
      `        - subnet: ${connectionsSubnet}`,
      "  browser:",
      "    ipam:",
      "      config:",
      `        - subnet: ${browserSubnet}`,
      "  linuxdo:",
      "    ipam:",
      "      config:",
      `        - subnet: ${linuxdoSubnet}`,
      "",
    ].join("\n"),
  );
  let cleanupError: Error | undefined;
  let acceptanceFailed = false;
  let acceptanceError: unknown;
  const builtImages = new Set<string>();
  let heartbeatProxy: HeartbeatDelayProxy | undefined;
  let rssControlSource: RssControlSource | undefined;
  const runFunctionalJourney =
    !manualRunsOnly &&
    !(
      isFullCapacityRun &&
      (capacityPhase === "verify" || capacityPhase === "delete")
    );
  let rssImageUpdate: RssImageUpdate | undefined;
  try {
    installedCliConsumer = await createIsolatedCliConsumer({
      artifactRoot,
    });
    await installedCliConsumer.verifyOfflineSchema();
    await compose(["build", "server"]);
    builtImages.add(imageName);
    if (
      !articleAdaptersOnly &&
      !documentAdaptersOnly &&
      !qoderAdapterOnly &&
      !rssLinuxdoOnly
    ) {
      await compose(["build", "runtime-fifteen-one"]);
      builtImages.add(runtimeImageName);
    }
    if (!manualRunsOnly || archiveModelJourney) {
      await compose(["build", "runtime-rss"]);
      builtImages.add(rssRuntimeImageName);
    }
    if (archiveModelJourney) {
      await compose(["build", "runtime-fifteen-schema-two"]);
      builtImages.add(schemaVariantRuntimeImageName);
    }
    if (runFunctionalJourney) {
      await compose(["build", "runtime-linuxdo"]);
      builtImages.add(linuxdoRuntimeImageName);
    }
    if (articleAdaptersOnly || (runFunctionalJourney && !rssLinuxdoOnly)) {
      await compose(["build", ...articleAdapterRuntimeServices]);
      for (const imageName of Object.values(articleAdapterRuntimeImageNames)) {
        builtImages.add(imageName);
      }
    }
    if (qoderAdapterOnly) {
      await compose(["build", qoderAdapterRuntimeService]);
      builtImages.add(documentAdapterRuntimeImageNames.qoder);
    }
    if (documentAdaptersOnly || (runFunctionalJourney && !rssLinuxdoOnly)) {
      await compose(["build", ...documentAdapterRuntimeServices]);
      for (const imageName of Object.values(documentAdapterRuntimeImageNames)) {
        builtImages.add(imageName);
      }
    }
    if (runFunctionalJourney) {
      rssImageUpdate = await buildRssImageUpdate(
        path.join(overrideDirectory, "rss-build-context"),
      );
      builtImages.add(rssBaselineRuntimeImageName);
      activeRssRuntimeImage = rssBaselineRuntimeImageName;
    }
    await compose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "360",
      "--no-build",
      "postgres",
      "server",
    ]);
    composePort = await publishedPort("server", 3000);
    let baseUrl = apiBaseUrl();
    await waitForApiAndDatabase(baseUrl);
    await verifyEmptyBinList(baseUrl);

    const e2eServices = articleAdaptersOnly
      ? [
          "postgres",
          "server",
          "rss-e2e-source",
          ...articleAdapterRuntimeServices,
        ]
      : qoderAdapterOnly
        ? ["postgres", "server", "rss-e2e-source", qoderAdapterRuntimeService]
        : documentAdaptersOnly
          ? [
              "postgres",
              "server",
              "rss-e2e-source",
              ...documentAdapterRuntimeServices,
            ]
          : manualRunsOnly
            ? [
                "postgres",
                "server",
                "manual-runs-source",
                "runtime-fifteen-one",
                ...(scheduledRunsOnly ? ["heartbeat-proxy"] : []),
                ...(archiveModelJourney
                  ? [
                      "runtime-fifteen-two",
                      "runtime-fifteen-schema-two",
                      "runtime-rss",
                    ]
                  : []),
              ]
            : rssLinuxdoOnly
              ? [
                  "postgres",
                  "server",
                  "rss-e2e-source",
                  "runtime-rss",
                  "runtime-rss-two",
                ]
              : [
                  "postgres",
                  "server",
                  "manual-runs-source",
                  "rss-e2e-source",
                  "runtime-fifteen-one",
                  "runtime-fifteen-two",
                  "runtime-rss",
                  "runtime-rss-two",
                  "heartbeat-proxy",
                ];
    if (runFunctionalJourney && !rssLinuxdoOnly) {
      e2eServices.push(
        "runtime-linuxdo",
        "runtime-linuxdo-two",
        "linuxdo-e2e-source",
        ...articleAdapterRuntimeServices,
        ...documentAdapterRuntimeServices,
      );
    }
    if (runFunctionalJourney && rssLinuxdoOnly) {
      e2eServices.push(
        "runtime-linuxdo",
        "runtime-linuxdo-two",
        "linuxdo-e2e-source",
      );
    }
    await compose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "360",
      "--no-build",
      ...e2eServices,
    ]);
    composePort = await publishedPort("server", 3000);
    if (
      !articleAdaptersOnly &&
      !documentAdaptersOnly &&
      !qoderAdapterOnly &&
      !rssLinuxdoOnly
    ) {
      manualRunSourcePort = await publishedPort("manual-runs-source", 8081);
    }
    if (runFunctionalJourney) {
      linuxdoSourcePort = await publishedPort("linuxdo-e2e-source", 8081);
    }
    let activeHeartbeatProxy: HeartbeatDelayProxy | undefined;
    if (useHeartbeatProxy) {
      activeHeartbeatProxy = createHeartbeatDelayProxy(
        await publishedPort("heartbeat-proxy", 8083),
        await publishedPort("heartbeat-proxy", 8082),
      );
      heartbeatProxy = activeHeartbeatProxy;
    }
    if (
      articleAdaptersOnly ||
      documentAdaptersOnly ||
      qoderAdapterOnly ||
      runFunctionalJourney
    ) {
      rssControlSource = await createRssControlSource(
        await publishedPort("rss-e2e-source", 8081),
      );
    }
    baseUrl = apiBaseUrl();
    await waitForApiAndDatabase(baseUrl);
    if (scheduleOnly) {
      const registered = await waitForBinRegistration(
        baseUrl,
        "binny-runs-one",
      );
      assert.equal(
        registered.sourceAdapterVersion,
        rssManifestVersion(await createRuntimeFixtureManifest()),
      );
      cliData(
        await cli(baseUrl, [
          "bin",
          "update",
          "binny-runs-one",
          "--identity",
          "binny-runs-one-identity",
          "--config",
          JSON.stringify({ section: "initial" }),
        ]),
        "updated",
      );
      await waitForRuntime(baseUrl, "binny-runs-one");
      if (scheduleOverlapOnly) {
        await verifyScheduleOverlapPolicy(baseUrl);
      } else {
        assert.ok(activeHeartbeatProxy !== undefined);
        baseUrl = await scheduledRunsStep(baseUrl, activeHeartbeatProxy);
      }
    } else if (archiveModelJourney) {
      const manifest = await createRuntimeFixtureManifest();
      await configureManualRunBins(baseUrl, manifest);
      await configureExtensionScopeBins(baseUrl);
      await waitForManualRunSource();
      const itemId = await manualRunsHttpStep(baseUrl, manifest);
      assert.ok(itemId);
      await archiveHttpStep("fixed-search", baseUrl);
      const batchReadFixture = await archiveBatchReadHttpStep(baseUrl);
      await verifyArchiveBatchReadBudget(baseUrl, batchReadFixture.reference);
      await removeResourceStorageFile(batchReadFixture.resourceId);
      await archiveBatchReadMissingMediaHttpStep(baseUrl, batchReadFixture);
      await archiveBatchReadCliStep(baseUrl, batchReadFixture);
      await archiveSearchCliStep(baseUrl);
      if (archiveSearchOnly) {
        process.stdout.write("固定搜索 HTTP/CLI 验收通过。\n");
      } else {
        const archiveState = await archiveHttpStep("submit", baseUrl);
        const archiveStateReference = JSON.parse(archiveState) as {
          readonly itemId: string;
        };
        await verifyArchiveSearchPoolWaitBudget(
          baseUrl,
          archiveStateReference.itemId,
        );
        baseUrl = await verifyResourceStorageInterruptions(
          baseUrl,
          archiveState,
        );
        const sdkResourceState = await sdkResourceStep(baseUrl);
        await waitForUnreferencedResourceAge();
        await compose(["kill", "-s", "SIGKILL", "server"]);
        baseUrl = await restartServer();
        await waitForApiAndDatabase(baseUrl);
        await archiveHttpStep(
          "after-restart",
          baseUrl,
          archiveState,
          sdkResourceState,
        );
        await manualRunsHttpStep(baseUrl, manifest, {
          stage: "verify-after-restart",
          itemId,
        });
        process.stdout.write(
          "SDK/运行器/HTTP/数据库归档模型及重启后公开读回通过。\n",
        );
      }
    } else if (articleAdaptersOnly) {
      assert.ok(rssControlSource !== undefined);
      await runArticleAdaptersJourney({
        baseUrl,
        articleSource: rssControlSource,
        cli: (args) => cli(baseUrl, args),
        compose,
        fetchRegisteredBin: waitForBinRegistration,
        waitForRuntime,
        waitForRuntimeHealth,
      });
    } else if (qoderAdapterOnly) {
      assert.ok(rssControlSource !== undefined);
      await runDocumentAdaptersJourney({
        baseUrl,
        source: rssControlSource,
        cli: (args) => cli(baseUrl, args),
        compose,
        fetchRegisteredBin: waitForBinRegistration,
        waitForRuntime,
        waitForRuntimeHealth,
        adapterIds: ["qoder"],
      });
    } else if (documentAdaptersOnly) {
      assert.ok(rssControlSource !== undefined);
      await runDocumentAdaptersJourney({
        baseUrl,
        source: rssControlSource,
        cli: (args) => cli(baseUrl, args),
        compose,
        fetchRegisteredBin: waitForBinRegistration,
        waitForRuntime,
        waitForRuntimeHealth,
      });
    } else if (runFunctionalJourney) {
      assert.ok(rssImageUpdate !== undefined);
      assert.ok(rssControlSource !== undefined);
      if (!rssLinuxdoOnly) {
        assert.ok(installedCliConsumer !== undefined);
        assert.ok(activeHeartbeatProxy !== undefined);
        await installedCliConsumer.verifyRemoteUrlSelection(baseUrl);
        await verifyConfigurationJourney(baseUrl, manualRunSourceControlUrl());
        const manualRunManifest = await createRuntimeFixtureManifest();
        await manualRunsCliStep(
          baseUrl,
          manualRunManifest,
          activeHeartbeatProxy,
        );
        await manualRunControllerPartitionStep();
        await manualRunsHttpStep(baseUrl, manualRunManifest);
        await verifyGlobalOperationsCli(baseUrl);
        baseUrl = await scheduledRunsStep(baseUrl, activeHeartbeatProxy);
      }
      const rssAcceptance = await runRssAcceptance(
        baseUrl,
        rssControlSource,
        rssImageUpdate,
      );
      if (!rssLinuxdoOnly) {
        await runArticleAdaptersJourney({
          baseUrl,
          articleSource: rssControlSource,
          cli: (args) => cli(baseUrl, args),
          compose,
          fetchRegisteredBin: waitForBinRegistration,
          waitForRuntime,
          waitForRuntimeHealth,
        });
        await runDocumentAdaptersJourney({
          baseUrl,
          source: rssControlSource,
          cli: (args) => cli(baseUrl, args),
          compose,
          fetchRegisteredBin: waitForBinRegistration,
          waitForRuntime,
          waitForRuntimeHealth,
        });
        await archiveHttpStep("fixed-search", baseUrl);
        const batchReadFixture = await archiveBatchReadHttpStep(baseUrl);
        await removeResourceStorageFile(batchReadFixture.resourceId);
        await archiveBatchReadMissingMediaHttpStep(baseUrl, batchReadFixture);
        await archiveBatchReadCliStep(baseUrl, batchReadFixture);
        const archive = await archiveHttpStep("submit", baseUrl);
        await archiveSearchCliStep(baseUrl);
        const sdkResource = await sdkResourceStep(baseUrl);
        baseUrl = await verifyResourceStorageInterruptions(baseUrl, archive);
        baseUrl = await verifyRestartAndRemoval(baseUrl, archive, sdkResource);
        process.stdout.write(
          "隔离客户端、RSS/Atom 全文、媒体状态、Compose、PostgreSQL、HTTP API、归档与构建 CLI 旅程通过。\n",
        );
      }
      await createLinuxdoBin(baseUrl);
      await createLinuxdoBin(
        baseUrl,
        "binny-integration-linuxdo-two",
        "runtime-linuxdo-two",
        "binny-integration-profile-two",
      );
      linuxdoViewerBrowser = await startLinuxdoViewerBrowser({
        projectName,
        image: linuxdoRuntimeImageName,
        publishedHost: process.env.BINNY_E2E_HOST ?? "172.17.0.1",
        run,
      });
      const outerBrowser = linuxdoViewerBrowser.browser;
      const linuxdoSourceControlUrl =
        "http://" +
        (process.env.BINNY_E2E_HOST ?? "172.17.0.1") +
        ":" +
        String(linuxdoSourcePort) +
        "/__control/state";
      const linuxdoJourney = await linuxdoUserJourney({
        binId: "binny-integration-linuxdo",
        topicId: 2401,
        cli: (args) => cli(baseUrl, args),
        browser: outerBrowser,
        publishedHost: process.env.BINNY_E2E_HOST ?? "172.17.0.1",
        serverPort: composePort,
        sourceOrigin: "http://linuxdo-e2e-source:8081",
        sourceControlUrl: linuxdoSourceControlUrl,
        username: "binny-discovery-user",
        password: "linuxdo-fixture",
      });
      process.stdout.write(
        "Linux.do 同项目正式镜像旅程：" +
          JSON.stringify({
            binId: "binny-integration-linuxdo",
            checkRunId: linuxdoJourney.authenticatedCheck.runId,
            collectRunId: linuxdoJourney.firstCollection.runId,
            itemIds: linuxdoJourney.itemIds,
          }) +
          "\n",
      );
      await verifyLinuxdoArchiveJourney(
        baseUrl,
        linuxdoSourceControlUrl,
        linuxdoJourney,
        rssAcceptance,
      );
      if (rssLinuxdoOnly) {
        process.stdout.write(
          "RSS/Atom、Linux.do 来源映射、媒体复用与公开历史读回通过。\n",
        );
      } else {
        await verifyLinuxdoCapacityJourney(baseUrl);
      }
    }
    if (!manualRunsOnly && !rssLinuxdoOnly) {
      await runCapacityAcceptance(baseUrl);
    }
  } catch (error) {
    acceptanceFailed = true;
    acceptanceError = error;
    const logs = await run(
      "docker",
      [...composePrefix(), "logs", "--no-color"],
      { env: composeEnvironment() },
    );
    process.stderr.write(
      "Compose 验收失败日志：\n" + logs.stdout + logs.stderr,
    );
  } finally {
    if (installedCliConsumer !== undefined) {
      try {
        await installedCliConsumer.close();
        installedCliConsumer = undefined;
      } catch (error) {
        cleanupError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    if (linuxdoViewerBrowser !== undefined) {
      try {
        await linuxdoViewerBrowser.close();
      } catch (error) {
        cleanupError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    if (heartbeatProxy !== undefined) {
      try {
        await heartbeatProxy.release();
      } catch (error) {
        cleanupError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    if (preserveCapacityProject || acceptanceFailed) {
      process.stdout.write(
        "保留当前验收 Compose 项目与持久卷供最终聚合验收：" +
          projectName +
          "。\n",
      );
    } else {
      const cleanup = await run(
        "docker",
        [
          ...composePrefix(),
          "--profile",
          "*",
          "down",
          "--volumes",
          "--remove-orphans",
        ],
        { env: composeEnvironment() },
      );
      if (cleanup.code !== 0) {
        cleanupError = new Error(
          "清理 Compose 资源失败：\n" + cleanup.stdout + cleanup.stderr,
        );
      } else if (builtImages.size > 0) {
        const imageCleanup = await run(
          "docker",
          [
            "image",
            "rm",
            ...builtImages,
            ...(rssImageUpdate === undefined
              ? []
              : [rssImageUpdate.candidateImageId]),
          ],
          { env: composeEnvironment() },
        );
        if (imageCleanup.code !== 0) {
          cleanupError = new Error(
            "清理本次 Compose 构建镜像失败：\n" +
              imageCleanup.stdout +
              imageCleanup.stderr,
          );
        }
      }
    }
    await rm(overrideDirectory, { recursive: true, force: true });
  }
  if (acceptanceFailed) throw acceptanceError;
  if (cleanupError !== undefined) throw cleanupError;
}

await main();
