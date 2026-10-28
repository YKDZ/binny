import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyIsolatedApiConsumer } from "./binny-isolated-consumer.ts";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
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
  readonly waitUntilHeld: () => Promise<number>;
  readonly waitUntilTimedOut: () => Promise<number>;
  readonly release: () => Promise<void>;
};

type HeartbeatDelayProxyStatus = {
  readonly held: boolean;
  readonly heldAt?: number;
  readonly clientClosedAt?: number;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.yaml");
const projectName = "binny18-e2e-" + process.pid.toString(10);
const imageName = projectName + ":local";
const runtimeImageName = projectName + "-lightweight:local";
let composeOverrideFile = "";
let composePort = 0;
let manualRunSourcePort = 0;

function createHeartbeatDelayProxy(controlPort: number): HeartbeatDelayProxy {
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
    async waitUntilHeld() {
      const status = await waitFor(
        readStatus,
        (current) => current.held && typeof current.heldAt === "number",
        "代理暂存的原生 idle heartbeat",
      );
      assert.ok(status.heldAt !== undefined);
      return status.heldAt;
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
    BINNY_IMAGE: imageName,
    BINNY15_RUNTIME_IMAGE: runtimeImageName,
    BINNY18_STOP_GRACE_MS: "1500",
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
    cwd: repositoryRoot,
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

async function publishedPort(
  service: string,
  containerPort: number,
): Promise<number> {
  const mapping = (
    await compose(["port", service, String(containerPort)])
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
  stage: "submit" | "after-restart",
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
        ...(sdkResourceState === undefined
          ? {}
          : { BINNY_E2E_SDK_RESOURCE_STATE: sdkResourceState }),
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
    "@binny/collector-sdk",
    "exec",
    "node",
    "--conditions=source",
    "scripts/archive-resource-e2e.ts",
    baseUrl,
  ]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

function archiveIds(state: string): {
  readonly itemId: string;
  readonly relationItemId: string;
  readonly relationCommitId: string;
  readonly revisionId: string;
  readonly commitId: string;
  readonly historicalAsOf: string;
  readonly relationAsOf: string;
  readonly resourceItemId: string;
  readonly resourceRevisionId: string;
  readonly resourceId: string;
  readonly repairedResourceId: string;
  readonly orphanResourceId: string;
  readonly resourceMarkerItemId: string;
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
    commitId: readText("commitId"),
    historicalAsOf: readText("historicalAsOf"),
    relationAsOf: readText("relationAsOf"),
    resourceItemId: readText("resourceItemId"),
    resourceRevisionId: readText("resourceRevisionId"),
    resourceId: readText("resourceId"),
    repairedResourceId: readText("repairedResourceId"),
    orphanResourceId: readText("orphanResourceId"),
    resourceMarkerItemId: readText("resourceMarkerItemId"),
  };
}

function archiveResponses(response: string): {
  readonly item: unknown;
  readonly historicalItem: unknown;
  readonly revision: unknown;
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

type HeldTableLock = {
  readonly release: () => Promise<void>;
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
    `BEGIN;\nLOCK TABLE ${table} IN SHARE MODE;\nSELECT 'BINNY04_LOCK_HELD';\n`,
  );
  await lock.waitForMarker("BINNY04_LOCK_HELD");
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
  return files as string[];
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

async function waitForBlockedQuery(queryFragment: string): Promise<void> {
  await waitFor(
    async () => {
      const result = await compose(
        postgresExecArgs([
          "-c",
          `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%${queryFragment}%';`,
        ]).slice(composePrefix().length),
      );
      return Number(result.stdout.trim());
    },
    (count) => count > 0,
    `PostgreSQL 等待 ${queryFragment} 锁`,
  );
}

async function restartServer(): Promise<string> {
  await compose(["up", "--detach", "--wait", "--wait-timeout", "90", "server"]);
  composePort = await publishedPort("server", 3000);
  return apiBaseUrl();
}

function resourceUploadProcess(): ManagedProcess {
  const program = [
    'const body = Buffer.from("binny15 interrupted resource publish");',
    'process.stdout.write("BINNY04_UPLOAD_STARTED\\n");',
    'const response = await fetch("http://127.0.0.1:3000/resources", { method: "POST", headers: { "content-type": "application/octet-stream" }, body });',
    'process.stdout.write("BINNY04_UPLOAD_RESPONSE " + response.status + " " + await response.text() + "\\n");',
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
  const request = JSON.stringify({
    requestId,
    binId: "rss-main",
    items: [
      {
        sourceKey: { namespace: "e2e", key: sourceKey },
        body: { text: "引用登记被进程中断" },
        resources: [{ resourceId }],
        capture: {
          scope: { case: "interrupted-resource-reference" },
          completeness: "complete",
          missing: [],
        },
      },
    ],
  });
  const program = [
    'process.stdout.write("BINNY04_REFERENCE_STARTED\\n");',
    `const response = await fetch("http://127.0.0.1:3000/archives", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(request)} });`,
    'process.stdout.write("BINNY04_REFERENCE_RESPONSE " + response.status + " " + await response.text() + "\\n");',
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
    await publishRequest.waitForMarker("BINNY04_UPLOAD_STARTED");
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
    await waitForBlockedQuery("INSERT INTO archive_resource");
    assert.doesNotMatch(publishRequest.stdout(), /BINNY04_UPLOAD_RESPONSE/u);

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
    "binny15 committed upload survives interrupted reference registration",
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
    await referenceRequest.waitForMarker("BINNY04_REFERENCE_STARTED");
    await waitForBlockedQuery("INSERT INTO archive_revision_resource");
    assert.doesNotMatch(
      referenceRequest.stdout(),
      /BINNY04_REFERENCE_RESPONSE/u,
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

  const gracePeriodMs = Number(
    composeEnvironment().BINNY_RESOURCE_UNREFERENCED_AGE_MS,
  );
  await new Promise((resolveGrace) => setTimeout(resolveGrace, gracePeriodMs));
  return currentBaseUrl;
}

async function validateApiInput(): Promise<void> {
  const probe = [
    "(async () => {",
    'const bodies = [JSON.stringify({ id: 7 }), "{"];',
    'const responses = await Promise.all(bodies.map((body) => fetch("http://127.0.0.1:3000/bins", { method: "POST", headers: { "content-type": "application/json" }, body })));',
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
  assert.deepEqual(invalidField.body.error.path, ["id"]);
  assert.match(invalidField.body.error.message, /字段|标识/u);
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.body.error.code, "invalid_input");
  assert.match(malformedJson.body.error.message, /JSON|格式/u);
}

async function createSdkManifest(): Promise<unknown> {
  const program = [
    'import { z } from "zod";',
    'import { collectorManifest, defineCollector, defineCollectorCheckAction } from "./dist/index.js";',
    "const collector = defineCollector({",
    '  id: "rss",',
    '  version: "1.0.0",',
    "  configSchema: z.object({",
    "    userAgent: z.string().min(1),",
    "    key: z.string().regex(/^a/).regex(/z$/),",
    "  }),",
    "  actions: {",
    '    check: defineCollectorCheckAction({ description: "检查测试信源配置。", params: z.object({}), execute: async () => ({ availability: "unknown", scope: ["test-source"], basis: "验收用 RSS 清单没有连接真实信源。", problems: [{ code: "test_source_unconfigured", message: "验收用 RSS 清单没有连接真实信源。", impact: "无法判断真实订阅源是否可用。", suggestion: "配置真实订阅源后重新触发 check。", requiresHuman: false }] }) }),',
    '    collect: { description: "读取并归档订阅源。", params: z.object({ limit: z.number().int().min(1) }), execute: async () => undefined },',
    "  },",
    "  environment: { browser: { required: false, profileReuseAfterRestart: false } },",
    "});",
    "process.stdout.write(JSON.stringify(collectorManifest(collector)));",
  ].join("\n");
  const result = await run("pnpm", [
    "--filter",
    "@binny/collector-sdk",
    "exec",
    "node",
    "--input-type=module",
    "-e",
    program,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

async function createRuntimeFixtureManifest(): Promise<unknown> {
  const program = [
    'import { collectorManifest } from "@binny/collector-sdk";',
    'import collector from "./test/fixtures/manual-runs-collector.ts";',
    "process.stdout.write(JSON.stringify(collectorManifest(collector)));",
  ].join("\n");
  const result = await run("pnpm", [
    "--silent",
    "--filter",
    "@binny/collector-runtime",
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

async function releaseSource(
  sourceUrl: string,
  gateKey: string,
  disposition:
    | "material"
    | "manual"
    | "empty"
    | "partial"
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(sourceUrl + "/control/arrivals", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const status: unknown = await response.json();
    if (
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
      )
    )
      return;
    await wait(50);
  }
  assert.fail(`运行没有写出信源标记：${marker}`);
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
    readonly stopReason: { readonly code: string };
    readonly error?: { readonly code: string };
    readonly check?: {
      readonly availability: "available" | "unavailable" | "unknown";
      readonly checkedAt: string;
      readonly scope: readonly string[];
      readonly basis: string;
      readonly problems: readonly {
        readonly suggestion: string;
        readonly requiresHuman: boolean;
      }[];
    };
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

async function manualRunsCliStep(
  baseUrl: string,
  manifest: unknown,
  heartbeatProxy: HeartbeatDelayProxy,
): Promise<void> {
  const manifestJson = JSON.stringify(manifest);
  assert.ok(manifestJson !== undefined);
  for (const binId of ["binny15-one", "binny15-two"]) {
    const created = cliData<{
      readonly id: string;
      readonly execution: unknown;
    }>(
      await cli(baseUrl, [
        "bin",
        "create",
        binId,
        "--collector",
        manifestJson,
        "--identity",
        binId + "-identity",
        "--config",
        JSON.stringify({ section: "initial" }),
        "--targets",
        "[]",
      ]),
      "created",
    );
    assert.equal(created.id, binId);
  }

  await Promise.all([
    waitForRuntime(baseUrl, "binny15-one"),
    waitForRuntime(baseUrl, "binny15-two"),
  ]);

  await waitForManualRunSource();
  const sourceRuntimeUrl = manualRunSourceRuntimeUrl();
  const sourceControlUrl = manualRunSourceControlUrl();
  const gateKey = "15-cli-manual-run";
  const parameters = {
    sourceUrl: sourceRuntimeUrl,
    gateKey,
    sourceKey: "cli-created-item",
  };
  const triggered = cliData<{
    readonly runId: string;
    readonly status: string;
    readonly binId: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
      "collect",
      "--params",
      JSON.stringify(parameters),
    ]),
    "triggered",
  );
  assert.equal(triggered.status, "queued");
  assert.equal(triggered.binId, "binny15-one");
  await waitForSourceArrival(
    sourceControlUrl,
    gateKey,
    triggered.runId,
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, gateKey);

  const deadline = Date.now() + 30_000;
  let completed: ManualRunCliState | undefined;
  while (Date.now() < deadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", "binny15-one", triggered.runId]),
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
  assert.deepEqual(completed.result?.completedScopes, [
    "source/cli-created-item",
  ]);
  const savedCommit = completed.result?.commits[0];
  assert.ok(savedCommit !== undefined);
  const savedItem = savedCommit.items[0];
  assert.ok(savedItem !== undefined);

  const commit = cliData<{
    readonly binId: string;
    readonly runId?: string;
    readonly collectorVersion?: string;
  }>(await cli(baseUrl, ["archive", "commit", savedCommit.commitId]), "found");
  assert.equal(commit.binId, "binny15-one");
  assert.equal(commit.runId, triggered.runId);
  assert.equal(commit.collectorVersion, "1.0.0");

  const item = cliData<{
    readonly views: readonly {
      readonly state: {
        readonly metadata?: { readonly section?: unknown };
        readonly body?: { readonly text?: string };
      };
    }[];
  }>(await cli(baseUrl, ["archive", "item", savedItem.itemId]), "found");
  assert.equal(item.views[0]?.state.metadata?.section, "initial");
  assert.equal(item.views[0]?.state.body?.text, "受控正文 " + gateKey);

  const checkGateKey = "16-cli-check-unknown";
  const checkTriggered = cliData<{
    readonly runId: string;
    readonly status: string;
    readonly binId: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
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
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, checkGateKey, "unknown");

  const checkDeadline = Date.now() + 30_000;
  let checkedRun: ManualRunCliState | undefined;
  while (Date.now() < checkDeadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", "binny15-one", checkTriggered.runId]),
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
  assert.equal(checkedRun.result?.check?.availability, "unknown");
  assert.deepEqual(checkedRun.result?.commits, []);
  assert.ok(
    (checkedRun.result?.check?.problems[0]?.suggestion.length ?? 0) > 0,
  );
  assert.equal(checkedRun.result?.stopReason.code, "completed");

  const followUpGateKey = "16-cli-collect-after-check";
  const followUp = cliData<{
    readonly runId: string;
    readonly status: string;
  }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
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
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, followUpGateKey);
  const followUpDeadline = Date.now() + 30_000;
  let collectedAfterCheck: ManualRunCliState | undefined;
  while (Date.now() < followUpDeadline) {
    const current = cliData<ManualRunCliState>(
      await cli(baseUrl, ["run", "get", "binny15-one", followUp.runId]),
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
  assert.deepEqual(collectedAfterCheck.result?.completedScopes, [
    "source/cli-after-check",
  ]);

  const heartbeatWarmGate = "18-heartbeat-warm-" + randomUUID();
  const heartbeatWarmRun = cliData<{ readonly runId: string }>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: heartbeatWarmGate,
        sourceKey: heartbeatWarmGate,
      }),
    ]),
    "triggered",
  );
  await waitForSourceArrival(
    sourceControlUrl,
    heartbeatWarmGate,
    heartbeatWarmRun.runId,
    "binny15-one",
  );
  const heartbeatNextGate = "18-heartbeat-next-" + randomUUID();
  const heartbeatNextRun = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
      "collect",
      "--params",
      JSON.stringify({
        sourceUrl: sourceRuntimeUrl,
        gateKey: heartbeatNextGate,
        sourceKey: heartbeatNextGate,
        waitAfterCommitMs: 60_000,
      }),
    ]),
    "triggered",
  );
  assert.equal(heartbeatNextRun.status, "queued");
  await heartbeatProxy.arm(heartbeatWarmRun.runId);
  await releaseSource(sourceControlUrl, heartbeatWarmGate);
  await waitForCliManualRunState(
    baseUrl,
    "binny15-one",
    heartbeatWarmRun.runId,
    ["completed"],
  );
  const delayedHeartbeatAt = await heartbeatProxy.waitUntilHeld();
  const heartbeatClientClosedAt = await heartbeatProxy.waitUntilTimedOut();
  assert.ok(
    heartbeatClientClosedAt - delayedHeartbeatAt >= 2_500,
    "运行器的原生心跳应在客户端超时后仍留在代理中。",
  );
  const heartbeatNextExecuting = await waitForCliManualRunState(
    baseUrl,
    "binny15-one",
    heartbeatNextRun.runId,
    ["executing"],
  );
  assert.equal(heartbeatNextExecuting.status, "executing");
  await waitForSourceArrival(
    sourceControlUrl,
    heartbeatNextGate,
    heartbeatNextRun.runId,
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, heartbeatNextGate, "slow");
  await waitForSourceMarker(
    sourceControlUrl,
    heartbeatNextRun.runId,
    heartbeatNextGate,
    "committed",
  );
  const heartbeatWorker = (
    await runtimeProcessSnapshot("runtime-fifteen-one")
  ).find((process) => process.command.includes("worker.js"));
  assert.ok(heartbeatWorker, "延迟心跳时应有新的真实 worker 正在运行。");
  const heartbeatCancel = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "cancel",
      "binny15-one",
      heartbeatNextRun.runId,
    ]),
    "cancellation",
  );
  assert.equal(heartbeatCancel.status, "cancelling");
  assert.equal(heartbeatCancel.stopConfirmedAt, undefined);
  await heartbeatProxy.release();
  const heartbeatCancelled = await waitForCliManualRunState(
    baseUrl,
    "binny15-one",
    heartbeatNextRun.runId,
    ["cancelled"],
  );
  assert.ok(heartbeatCancelled.stopConfirmedAt);
  assert.equal(heartbeatCancelled.result?.commits.length, 1);
  const heartbeatStoppedProcesses = await runtimeProcessSnapshot(
    "runtime-fifteen-one",
  );
  assert.equal(
    heartbeatStoppedProcesses.some(
      (process) => process.pgid === heartbeatWorker.pgid,
    ),
    false,
    "迟到的旧 idle heartbeat 不能确认新 run，停止确认必须晚于 worker 退出。",
  );

  const slowGateKey = "18-cli-slow-stop";
  const slowRun = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
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
    "binny15-one",
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

  const nextGateKey = "18-cli-next-after-stop";
  const nextRun = cliData<ManualRunCliState>(
    await cli(baseUrl, [
      "run",
      "trigger",
      "binny15-one",
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
    await cli(baseUrl, ["run", "get", "binny15-one", nextRun.runId]),
    "found",
  );
  assert.equal(queuedBehindSlowRun.status, "queued");
  assert.equal(queuedBehindSlowRun.queueReason, "earlier_run_active");

  const acceptedCancel = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "cancel", "binny15-one", slowRun.runId]),
    "cancellation",
  );
  assert.equal(acceptedCancel.status, "cancelling");
  assert.ok(acceptedCancel.cancellationRequestedAt);
  assert.equal(acceptedCancel.stopConfirmedAt, undefined);
  const stillQueued = cliData<ManualRunCliState>(
    await cli(baseUrl, ["run", "get", "binny15-one", nextRun.runId]),
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
    "binny15-one",
    slowRun.runId,
    ["cancelled"],
  );
  assert.ok(cancelled.stopConfirmedAt);
  assert.equal(cancelled.result?.stopReason.code, "cancelled");
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
    "binny15-one",
  );
  await releaseSource(sourceControlUrl, nextGateKey);
  const nextCompleted = await waitForCliManualRunState(
    baseUrl,
    "binny15-one",
    nextRun.runId,
    ["completed"],
  );
  assert.equal(nextCompleted.result?.stopReason.code, "completed");
}

async function manualRunControllerPartitionStep(): Promise<void> {
  const baseUrl = apiBaseUrl();
  const sourceControlUrl = manualRunSourceControlUrl();
  const binId = "binny15-two";
  const interruptedGateKey = "18-controller-link-loss";
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
    const nextGateKey = "18-after-controller-link-loss";
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
    const stale = await waitForCliManualRunState(
      baseUrl,
      binId,
      interrupted.runId,
      ["failed"],
    );
    assert.equal(stale.result?.error?.code, "runtime_interrupted");
    assert.equal(stale.stopConfirmedAt, undefined);
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
      ["network", "connect", networkName, containerId],
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
        ["network", "connect", networkName, containerId],
        { env: composeEnvironment() },
      );
      if (attached.code !== 0 && !attached.stderr.includes("already exists"))
        process.stderr.write(attached.stderr);
    }
  }
}

async function manualRunsHttpStep(
  baseUrl: string,
  manifest: unknown,
): Promise<void> {
  const result = await run(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@binny/api",
      "exec",
      "node",
      "--conditions=source",
      "scripts/manual-runs-http-e2e.ts",
    ],
    {
      env: {
        BINNY_E2E_BASE_URL: baseUrl,
        BINNY15_SOURCE_CONTROL_URL: manualRunSourceControlUrl(),
        BINNY15_COLLECTOR_MANIFEST: JSON.stringify(manifest),
      },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  process.stdout.write(result.stdout);
}

async function verifyConfigurationJourney(baseUrl: string): Promise<void> {
  const manifest = await createSdkManifest();
  const manifestJson = JSON.stringify(manifest);
  const initialConfig = JSON.stringify({ userAgent: "Binny E2E", key: "az" });
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
  assert.deepEqual(Object.keys(discovered.actions), ["check", "collect"]);
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

  const invalidRegexCreate = await fetch(baseUrl + "/bins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "rss-regex-invalid",
      collector: manifest,
      identityId: "account-regex-invalid",
      config: { userAgent: "Binny E2E", key: "ab" },
      targets: [],
    }),
  });
  assert.equal(invalidRegexCreate.status, 400);
  const invalidRegexCreateBody = (await invalidRegexCreate.json()) as {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly path?: readonly (string | number)[];
    };
  };
  assert.equal(invalidRegexCreateBody.error.code, "invalid_configuration");
  assert.deepEqual(invalidRegexCreateBody.error.path, ["config", "key"]);
  assert.match(invalidRegexCreateBody.error.message, /长期配置/u);

  const validRegexCreate = await fetch(baseUrl + "/bins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "rss-regex",
      collector: manifest,
      identityId: "account-regex",
      config: { userAgent: "Binny E2E", key: "az" },
      targets: [],
    }),
  });
  assert.equal(validRegexCreate.status, 201);
  const validRegexCreateBody = (await validRegexCreate.json()) as {
    readonly config: { readonly key: string };
  };
  assert.equal(validRegexCreateBody.config.key, "az");

  const invalidRegexUpdate = await fetch(baseUrl + "/bins/rss-regex", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: { userAgent: "Binny E2E", key: "bz" },
    }),
  });
  assert.equal(invalidRegexUpdate.status, 400);
  const invalidRegexUpdateBody = (await invalidRegexUpdate.json()) as {
    readonly error: {
      readonly code: string;
      readonly path?: readonly (string | number)[];
    };
  };
  assert.equal(invalidRegexUpdateBody.error.code, "invalid_configuration");
  assert.deepEqual(invalidRegexUpdateBody.error.path, ["config", "key"]);

  const afterInvalidRegexUpdate = await fetch(baseUrl + "/bins/rss-regex");
  assert.equal(afterInvalidRegexUpdate.status, 200);
  const afterInvalidRegexUpdateBody =
    (await afterInvalidRegexUpdate.json()) as {
      readonly config: { readonly key: string };
    };
  assert.equal(afterInvalidRegexUpdateBody.config.key, "az");

  const validRegexUpdate = await fetch(baseUrl + "/bins/rss-regex", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: { userAgent: "Binny E2E updated", key: "aaz" },
    }),
  });
  assert.equal(validRegexUpdate.status, 200);
  const validRegexUpdateBody = (await validRegexUpdate.json()) as {
    readonly config: { readonly key: string };
  };
  assert.equal(validRegexUpdateBody.config.key, "aaz");

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
  assert.equal(listed.bins.length, 3);
  assert.deepEqual(listed.bins.map(({ identityId }) => identityId).toSorted(), [
    "account-one",
    "account-regex",
    "account-two",
  ]);

  const updatedConfig = JSON.stringify({
    userAgent: "Binny E2E updated",
    key: "aaz",
  });
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

async function verifyRestartAndRemoval(
  baseUrl: string,
  archive: string,
  sdkResource: string,
): Promise<string> {
  const disabled = cliData<{ readonly status: string }>(
    await cli(baseUrl, ["bin", "disable", "rss-main"]),
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
    readonly config: { readonly userAgent: string };
    readonly targets: readonly unknown[];
  }>(await cli(baseUrl, ["bin", "get", "rss-main"]), "found");
  assert.equal(persisted.status, "disabled");
  assert.equal(persisted.identityId, "account-primary");
  assert.equal(persisted.config.userAgent, "Binny E2E updated");
  assert.equal(persisted.targets.length, 2);

  const persistedRegexConfiguration = cliData<{
    readonly config: { readonly userAgent: string; readonly key: string };
  }>(await cli(baseUrl, ["bin", "get", "rss-regex"]), "found");
  assert.equal(
    persistedRegexConfiguration.config.userAgent,
    "Binny E2E updated",
  );
  assert.equal(persistedRegexConfiguration.config.key, "aaz");

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

  cliData(await cli(baseUrl, ["bin", "remove", "rss-regex"]), "removed");

  cliFailure(await cli(baseUrl, ["bin", "get", "rss-main"]), "bin_not_found");
  cliFailure(await cli(baseUrl, ["bin", "get", "rss-regex"]), "bin_not_found");
  cliData(await cli(baseUrl, ["bin", "remove", "rss-secondary"]), "removed");
  const empty = cliData<{ readonly bins: readonly unknown[] }>(
    await cli(baseUrl, ["bin", "list"]),
    "listed",
  );
  assert.deepEqual(empty.bins, []);
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
    commitId,
    historicalAsOf,
    relationAsOf,
    resourceItemId,
    resourceRevisionId,
    resourceMarkerItemId,
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
      "rss-main",
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
    readonly unit: string;
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
        scope: { kind: "current", binId: "rss-main" },
        text: { kind: "literal", value: "正文 A" },
        limit: 10,
      }),
    ]),
    "found",
  );
  assert.equal(cliSearch.unit, "item");
  const cliSearchResult = cliSearch.results.find(
    (result) => result.itemId === itemId,
  );
  assert.ok(cliSearchResult);
  assert.ok(
    cliSearchResult.matches.some(
      (match) => match.binId === "rss-main" && match.revisionId === revisionId,
    ),
  );

  const downloadDirectory = await mkdtemp(
    path.join(tmpdir(), "binny15fix-resource-cli-"),
  );
  const localResourcePath = path.join(downloadDirectory, "resource.bin");
  const containerResourcePath = `/tmp/binny15fix-resource-${process.pid}.bin`;
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
        containerResourcePath,
      ]),
      "downloaded",
    );
    assert.equal(
      downloaded.resourceId,
      expectedArchive.sdkResourceMetadata.resourceId,
    );
    assert.equal(downloaded.mediaType, "image/svg+xml");
    assert.equal(downloaded.sha256, expectedArchive.sdkResourceMetadata.sha256);
    await compose(["cp", `server:${containerResourcePath}`, localResourcePath]);
    assert.deepEqual(
      await readFile(localResourcePath),
      Buffer.from("collector sdk image v1"),
    );
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }
  await compose([
    "exec",
    "--no-TTY",
    "server",
    "rm",
    "-f",
    containerResourcePath,
  ]);

  const cliFirstTimelinePage = cliData<{ readonly nextCursor?: string }>(
    await cli(baseUrl, [
      "archive",
      "timeline",
      itemId,
      "--bin",
      "rss-main",
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
      "rss-main",
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
      "rss-main",
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
  return baseUrl;
}

async function main(): Promise<void> {
  const overrideDirectory = await mkdtemp(
    path.join(tmpdir(), "binny18-e2e-compose-"),
  );
  composeOverrideFile = path.join(overrideDirectory, "compose.yaml");
  const e2eSubnet = process.env.BINNY_E2E_SUBNET ?? "10.253.18.0/24";
  const runtimeSubnet =
    process.env.BINNY_E2E_RUNTIME_SUBNET ?? "10.253.134.0/24";
  let cleanupError: Error | undefined;
  let acceptanceFailed = false;
  let acceptanceError: unknown;
  let heartbeatProxy: HeartbeatDelayProxy | undefined;
  try {
    await writeFile(
      composeOverrideFile,
      [
        "services:",
        "  server:",
        "    ports: !override",
        '      - "3000"',
        "  manual-runs-source:",
        "    ports: !override",
        '      - "8081"',
        "    networks:",
        "      - default",
        "      - runtime",
        "  runtime-fifteen-one:",
        "    environment:",
        "      BINNY_API_URL: http://heartbeat-proxy:8082",
        "    networks:",
        "      - runtime",
        "  runtime-fifteen-two:",
        "    environment:",
        "      BINNY_API_URL: http://heartbeat-proxy:8082",
        "    networks:",
        "      - runtime",
        "  heartbeat-proxy:",
        `    image: ${imageName}`,
        "    command:",
        "      - node",
        "      - scripts/binny-e2e-heartbeat-proxy.ts",
        "    ports:",
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
        "",
      ].join("\n"),
    );
    await compose([
      "up",
      "--detach",
      "--build",
      "--wait",
      "--wait-timeout",
      "360",
      "postgres",
      "server",
      "manual-runs-source",
      "runtime-fifteen-one",
      "runtime-fifteen-two",
      "heartbeat-proxy",
    ]);
    composePort = await publishedPort("server", 3000);
    manualRunSourcePort = await publishedPort("manual-runs-source", 8081);
    const activeHeartbeatProxy = createHeartbeatDelayProxy(
      await publishedPort("heartbeat-proxy", 8083),
    );
    heartbeatProxy = activeHeartbeatProxy;
    let baseUrl = apiBaseUrl();
    await waitForApiAndDatabase(baseUrl);
    const isolatedClient = await verifyIsolatedApiConsumer({
      repositoryRoot,
      projectName,
    });
    assert.deepEqual(isolatedClient, {
      health: "ok",
      binIds: [],
    });
    await verifyConfigurationJourney(baseUrl);
    const manualRunManifest = await createRuntimeFixtureManifest();
    await manualRunsCliStep(baseUrl, manualRunManifest, activeHeartbeatProxy);
    await manualRunControllerPartitionStep();
    await manualRunsHttpStep(baseUrl, manualRunManifest);
    for (const binId of ["binny15-one", "binny15-two"]) {
      const removed = cliData<{
        readonly removed: boolean;
        readonly id: string;
      }>(await cli(baseUrl, ["bin", "remove", binId]), "removed");
      assert.deepEqual(removed, { removed: true, id: binId });
    }
    const enabled = cliData<{ readonly status: string }>(
      await cli(baseUrl, ["bin", "enable", "rss-main"]),
      "enabled",
    );
    assert.equal(enabled.status, "active");
    const archive = await archiveHttpStep("submit", baseUrl);
    const sdkResource = await sdkResourceStep(baseUrl);
    baseUrl = await verifyResourceStorageInterruptions(baseUrl, archive);
    baseUrl = await verifyRestartAndRemoval(baseUrl, archive, sdkResource);
    process.stdout.write(
      "隔离客户端、Compose、PostgreSQL、HTTP API、归档与构建 CLI 旅程通过。\n",
    );
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
    if (heartbeatProxy !== undefined) {
      try {
        await heartbeatProxy.release();
      } catch (error) {
        cleanupError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    const cleanup = await run(
      "docker",
      [
        ...composePrefix(),
        "--profile",
        "binny15",
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
    } else {
      const imageCleanup = await run(
        "docker",
        ["image", "rm", imageName, runtimeImageName],
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
    await rm(overrideDirectory, { recursive: true, force: true });
  }
  if (acceptanceFailed) throw acceptanceError;
  if (cleanupError !== undefined) throw cleanupError;
}

await main();
