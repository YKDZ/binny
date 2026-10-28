import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeFile = path.join(repositoryRoot, "compose.yaml");
const projectName = "binny06-" + process.pid.toString(10);
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
    BINNY_RESOURCE_UNREFERENCED_AGE_MS: String(15 * 1000),
    BINNY_RESOURCE_CLEANUP_INTERVAL_MS: String(60 * 60 * 1000),
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
    `BEGIN;\nLOCK TABLE ${table} IN SHARE MODE;\nSELECT 'BINNY06_LOCK_HELD';\n`,
  );
  await lock.waitForMarker("BINNY06_LOCK_HELD");
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

async function holdArchiveWriteClockLock(): Promise<HeldTableLock> {
  const lock = startManagedProcess("docker", postgresExecArgs([]));
  lock.write(
    "BEGIN;\nSELECT last_seq FROM archive_write_clock WHERE clock_id = 1 FOR UPDATE;\nSELECT 'BINNY06_CLOCK_HELD';\n",
  );
  await lock.waitForMarker("BINNY06_CLOCK_HELD");
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

async function holdResourceKeyShareLock(
  resourceId: string,
): Promise<HeldTableLock> {
  assert.match(resourceId, /^[0-9a-f-]{36}$/u);
  const lock = startManagedProcess("docker", postgresExecArgs([]));
  lock.write(
    `BEGIN;\nSELECT resource_id FROM archive_resource WHERE resource_id = '${resourceId}' FOR KEY SHARE;\nSELECT 'BINNY06_RESOURCE_LOCK_HELD';\n`,
  );
  await lock.waitForMarker("BINNY06_RESOURCE_LOCK_HELD");
  assert.ok(lock.stdout().includes(resourceId));
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

async function resourceFiles(port: number): Promise<readonly string[]> {
  const result = await compose(
    [
      "exec",
      "--no-TTY",
      "server",
      "node",
      "--input-type=module",
      "-e",
      'import { readdir } from "node:fs/promises"; process.stdout.write(JSON.stringify(await readdir("/var/lib/binny/resources")));',
    ],
    port,
  );
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

async function waitForBlockedQuery(
  port: number,
  queryFragment: string,
  minimumCount = 1,
): Promise<void> {
  await waitFor(
    async () => {
      const result = await compose(
        postgresExecArgs([
          "-c",
          `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%${queryFragment}%';`,
        ]).slice(composePrefix().length),
        port,
      );
      return Number(result.stdout.trim());
    },
    (count) => count >= minimumCount,
    `PostgreSQL 等待 ${queryFragment} 锁`,
  );
}

async function restartServer(port: number): Promise<void> {
  await compose(
    ["up", "--detach", "--wait", "--wait-timeout", "90", "server"],
    port,
  );
}

function resourceUploadProcess(
  content = "binny06 interrupted resource publish",
): ManagedProcess {
  const program = [
    `const body = Buffer.from(${JSON.stringify(content)});`,
    'process.stdout.write("BINNY06_UPLOAD_STARTED\\n");',
    'const response = await fetch("http://127.0.0.1:3000/resources", { method: "POST", headers: { "content-type": "application/octet-stream" }, body });',
    'process.stdout.write("BINNY06_UPLOAD_RESPONSE " + response.status + " " + await response.text() + "\\n");',
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

function archiveDeleteProcess(itemId: string): ManagedProcess {
  assert.match(itemId, /^[0-9a-f-]{36}$/u);
  return startManagedProcess("docker", [
    ...composePrefix(),
    "exec",
    "--no-TTY",
    "server",
    "node",
    "packages/binny/dist/cli.js",
    "archive",
    "delete",
    itemId,
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
    'process.stdout.write("BINNY06_REFERENCE_STARTED\\n");',
    `const response = await fetch("http://127.0.0.1:3000/archives", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(request)} });`,
    'process.stdout.write("BINNY06_REFERENCE_RESPONSE " + response.status + " " + await response.text() + "\\n");',
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
  port: number,
  archive: string,
): Promise<void> {
  const filesBeforePublish = await resourceFiles(port);
  let publishLock: HeldTableLock | undefined;
  let publishRequest: ManagedProcess | undefined;
  let publishServerNeedsRestart = false;
  try {
    publishLock = await holdTableShareLock("archive_resource");
    publishRequest = resourceUploadProcess();
    await publishRequest.waitForMarker("BINNY06_UPLOAD_STARTED");
    const publishedFiles = await waitFor(
      () => resourceFiles(port),
      (files) => files.some((file) => !filesBeforePublish.includes(file)),
      "资源文件在登记前发布到持久目录",
    );
    const newPublishedFiles = publishedFiles.filter(
      (file) => !filesBeforePublish.includes(file),
    );
    assert.equal(newPublishedFiles.length, 1);
    const publishedFile = newPublishedFiles[0];
    assert.ok(publishedFile);
    await waitForBlockedQuery(port, "INSERT INTO archive_resource");
    assert.doesNotMatch(publishRequest.stdout(), /BINNY06_UPLOAD_RESPONSE/u);

    await compose(["kill", "-s", "SIGKILL", "server"], port);
    publishServerNeedsRestart = true;
    await publishLock.release();
    publishLock = undefined;
    const interruptedUpload = await publishRequest.waitForClose();
    assert.notEqual(interruptedUpload.code, 0);
    await restartServer(port);
    publishServerNeedsRestart = false;
    await waitForApiAndDatabase(baseUrl);
    const filesAfterPublishRecovery = await resourceFiles(port);
    assert.ok(!filesAfterPublishRecovery.includes(publishedFile));
  } finally {
    if (
      publishRequest !== undefined &&
      publishRequest.child.exitCode === null
    ) {
      if (!publishServerNeedsRestart) {
        await compose(["kill", "-s", "SIGKILL", "server"], port);
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
    if (publishServerNeedsRestart) await restartServer(port);
  }

  const referenceBytes = new TextEncoder().encode(
    "binny06 committed upload survives interrupted reference registration",
  );
  const uploadResponse = await fetch(baseUrl + "/resources", {
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
    await referenceRequest.waitForMarker("BINNY06_REFERENCE_STARTED");
    await waitForBlockedQuery(port, "INSERT INTO archive_revision_resource");
    assert.doesNotMatch(
      referenceRequest.stdout(),
      /BINNY06_REFERENCE_RESPONSE/u,
    );

    await compose(["kill", "-s", "SIGKILL", "server"], port);
    referenceServerNeedsRestart = true;
    await referenceLock.release();
    referenceLock = undefined;
    const interruptedReference = await referenceRequest.waitForClose();
    assert.notEqual(interruptedReference.code, 0);
    await restartServer(port);
    referenceServerNeedsRestart = false;
    await waitForApiAndDatabase(baseUrl);
    const resourceRead = await fetch(
      baseUrl + "/resources/" + uploaded.resourceId,
    );
    assert.equal(resourceRead.status, 200);
    assert.deepEqual(
      new Uint8Array(await resourceRead.arrayBuffer()),
      referenceBytes,
    );

    const archiveIdsValue = archiveIds(archive);
    const historicalResource = await fetch(
      baseUrl + "/resources/" + archiveIdsValue.resourceId,
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
        await compose(["kill", "-s", "SIGKILL", "server"], port);
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
    if (referenceServerNeedsRestart) await restartServer(port);
  }

  const gracePeriodMs = Number(
    composeEnvironment().BINNY_RESOURCE_UNREFERENCED_AGE_MS,
  );
  await new Promise((resolveGrace) => setTimeout(resolveGrace, gracePeriodMs));
  await verifyArchiveDeleteRollbackAfterCrash(baseUrl, port, archive);
}

async function verifyArchiveDeleteRollbackAfterCrash(
  baseUrl: string,
  port: number,
  archive: string,
): Promise<void> {
  const { resourceItemId, resourceId, repairedResourceId } =
    archiveIds(archive);
  let resourceLock: HeldTableLock | undefined;
  let deleteRequest: ManagedProcess | undefined;
  let serverNeedsRestart = false;
  try {
    resourceLock = await holdTableShareLock("archive_resource");
    deleteRequest = archiveDeleteProcess(resourceItemId);
    await waitForBlockedQuery(port, "UPDATE archive_resource");
    assert.equal(deleteRequest.child.exitCode, null);

    await compose(["kill", "-s", "SIGKILL", "server"], port);
    serverNeedsRestart = true;
    await resourceLock.release();
    resourceLock = undefined;
    const interruptedDelete = await deleteRequest.waitForClose();
    assert.notEqual(interruptedDelete.code, 0);
    await restartServer(port);
    serverNeedsRestart = false;
    await waitForApiAndDatabase(baseUrl);

    const itemRead = await fetch(baseUrl + "/archives/items/" + resourceItemId);
    assert.equal(itemRead.status, 200, await itemRead.text());
    for (const [resourceIdToCheck, content] of [
      [resourceId, "binny media bytes v1"],
      [repairedResourceId, "binny media bytes v2"],
    ] as const) {
      const resourceRead = await fetch(
        baseUrl + "/resources/" + resourceIdToCheck,
      );
      assert.equal(resourceRead.status, 200);
      assert.deepEqual(
        new Uint8Array(await resourceRead.arrayBuffer()),
        new TextEncoder().encode(content),
      );
    }
  } finally {
    if (
      deleteRequest !== undefined &&
      deleteRequest.child.exitCode === null &&
      !serverNeedsRestart
    ) {
      await compose(["kill", "-s", "SIGKILL", "server"], port);
      serverNeedsRestart = true;
    }
    if (resourceLock !== undefined) await resourceLock.release();
    if (deleteRequest !== undefined && deleteRequest.child.exitCode === null) {
      await deleteRequest.waitForClose();
    }
    if (serverNeedsRestart) await restartServer(port);
  }
}

function processResponse<T>(
  result: ProcessResult,
  marker: string,
): { readonly status: number; readonly body: T } {
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(marker + " "));
  assert.ok(line, result.stdout + result.stderr);
  const separator = line.indexOf(" ", marker.length + 1);
  assert.notEqual(separator, -1, line);
  return {
    status: Number(line.slice(marker.length + 1, separator)),
    body: JSON.parse(line.slice(separator + 1)) as T,
  };
}

async function verifyDeleteUploadAndFileCleanupRace(
  baseUrl: string,
  port: number,
  archive: string,
): Promise<void> {
  const { resourceItemId, repairedResourceId } = archiveIds(archive);
  const filesBeforeDelete = await resourceFiles(port);
  let resourceLock: HeldTableLock | undefined;
  let clockLock: HeldTableLock | undefined;
  let deleteRequest: ManagedProcess | undefined;
  let uploadRequest: ManagedProcess | undefined;
  let referenceRequest: ManagedProcess | undefined;
  let serverNeedsRestart = false;
  try {
    resourceLock = await holdResourceKeyShareLock(repairedResourceId);
    clockLock = await holdArchiveWriteClockLock();
    deleteRequest = archiveDeleteProcess(resourceItemId);
    await waitForBlockedQuery(port, "archive_write_clock");

    uploadRequest = resourceUploadProcess("binny media bytes v2");
    await uploadRequest.waitForMarker("BINNY06_UPLOAD_STARTED");
    await waitFor(
      () => resourceFiles(port),
      (files) => files.some((file) => file.startsWith(".upload-")),
      "并发上传完成暂存并等待归档写门",
    );
    await waitForBlockedQuery(port, "archive_write_clock", 2);
    await clockLock.release();
    clockLock = undefined;

    await uploadRequest.waitForMarker("BINNY06_UPLOAD_RESPONSE");
    const uploadResult = await uploadRequest.waitForClose();
    assert.equal(uploadResult.code, 0, uploadResult.stderr);
    const uploaded = processResponse<{ readonly resourceId: string }>(
      uploadResult,
      "BINNY06_UPLOAD_RESPONSE",
    );
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.notEqual(uploaded.body.resourceId, repairedResourceId);

    referenceRequest = archiveReferenceProcess(uploaded.body.resourceId);
    await referenceRequest.waitForMarker("BINNY06_REFERENCE_STARTED");
    await referenceRequest.waitForMarker("BINNY06_REFERENCE_RESPONSE");
    const referenceResult = await referenceRequest.waitForClose();
    assert.equal(referenceResult.code, 0, referenceResult.stderr);
    const referenced = processResponse<{ readonly items: readonly unknown[] }>(
      referenceResult,
      "BINNY06_REFERENCE_RESPONSE",
    );
    assert.equal(referenced.status, 201, JSON.stringify(referenced.body));

    await waitForBlockedQuery(port, "DELETE FROM archive_resource");
    assert.equal(deleteRequest.child.exitCode, null);
    const filesAfterUnlink = await resourceFiles(port);
    const removedFiles = filesBeforeDelete.filter(
      (file) => !filesAfterUnlink.includes(file),
    );
    const addedFiles = filesAfterUnlink.filter(
      (file) => !filesBeforeDelete.includes(file),
    );
    assert.equal(removedFiles.length, 1, JSON.stringify(removedFiles));
    assert.match(removedFiles[0] ?? "", /^[0-9a-f-]{36}\.bin$/u);
    assert.equal(addedFiles.length, 1, JSON.stringify(addedFiles));
    assert.match(addedFiles[0] ?? "", /^[0-9a-f-]{36}\.bin$/u);

    const oldResource = await fetch(
      baseUrl + "/resources/" + repairedResourceId,
    );
    assert.equal(oldResource.status, 404, await oldResource.text());
    const newResource = await fetch(
      baseUrl + "/resources/" + uploaded.body.resourceId,
    );
    assert.equal(newResource.status, 200);
    assert.deepEqual(
      new Uint8Array(await newResource.arrayBuffer()),
      new TextEncoder().encode("binny media bytes v2"),
    );

    await compose(["kill", "-s", "SIGKILL", "server"], port);
    serverNeedsRestart = true;
    await resourceLock.release();
    resourceLock = undefined;
    const interruptedDelete = await deleteRequest.waitForClose();
    assert.notEqual(interruptedDelete.code, 0);
    await restartServer(port);
    serverNeedsRestart = false;
    await waitForApiAndDatabase(baseUrl);

    cliFailure(
      await cli(baseUrl, ["archive", "item", resourceItemId]),
      "item_deleted",
    );
    const oldResourceAfterRestart = await fetch(
      baseUrl + "/resources/" + repairedResourceId,
    );
    assert.equal(oldResourceAfterRestart.status, 404);
    const newResourceAfterRestart = await fetch(
      baseUrl + "/resources/" + uploaded.body.resourceId,
    );
    assert.equal(newResourceAfterRestart.status, 200);
    assert.deepEqual(
      new Uint8Array(await newResourceAfterRestart.arrayBuffer()),
      new TextEncoder().encode("binny media bytes v2"),
    );
  } finally {
    const activeProcess = [deleteRequest, uploadRequest, referenceRequest].some(
      (process) => process !== undefined && process.child.exitCode === null,
    );
    if (activeProcess && !serverNeedsRestart) {
      await compose(["kill", "-s", "SIGKILL", "server"], port);
      serverNeedsRestart = true;
    }
    if (clockLock !== undefined) await clockLock.release();
    if (resourceLock !== undefined) await resourceLock.release();
    for (const child of [deleteRequest, uploadRequest, referenceRequest]) {
      if (child !== undefined && child.child.exitCode === null) {
        await child.waitForClose();
      }
    }
    if (serverNeedsRestart) await restartServer(port);
  }
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
    'import { collectorManifest, defineCollector } from "./dist/index.js";',
    "const collector = defineCollector({",
    '  id: "rss",',
    '  version: "1.0.0",',
    "  configSchema: z.object({",
    "    userAgent: z.string().min(1),",
    "    key: z.string().regex(/^a/).regex(/z$/),",
    "  }),",
    "  actions: {",
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
  port: number,
  archive: string,
  sdkResource: string,
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

  const downloadDirectory = await mkdtemp(
    path.join(tmpdir(), "binny06-resource-cli-"),
  );
  const localResourcePath = path.join(downloadDirectory, "resource.bin");
  const containerResourcePath = `/tmp/binny06-resource-${process.pid}.bin`;
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
    await compose(
      ["cp", `server:${containerResourcePath}`, localResourcePath],
      port,
    );
    assert.deepEqual(
      await readFile(localResourcePath),
      Buffer.from("collector sdk image v1"),
    );
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }
  await compose(
    ["exec", "--no-TTY", "server", "rm", "-f", containerResourcePath],
    port,
  );

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

  const cliDeletion = cliData<{
    readonly itemId: string;
    readonly deletionSeq: string;
    readonly deleted: true;
  }>(
    await cli(baseUrl, ["archive", "delete", resourceMarkerItemId]),
    "deleted",
  );
  assert.equal(cliDeletion.itemId, resourceMarkerItemId);
  assert.equal(cliDeletion.deleted, true);
  cliFailure(
    await cli(baseUrl, ["archive", "item", resourceMarkerItemId]),
    "item_deleted",
  );
  await verifyDeleteUploadAndFileCleanupRace(baseUrl, port, archive);

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
}

async function main(): Promise<void> {
  const port = await reservePort();
  composePort = port;
  const e2eHost = process.env.BINNY_E2E_HOST ?? "172.17.0.1";
  const baseUrl = "http://" + e2eHost + ":" + port;
  const overrideDirectory = await mkdtemp(
    path.join(tmpdir(), "binny06-compose-"),
  );
  composeOverrideFile = path.join(overrideDirectory, "compose.yaml");
  const e2eSubnet = process.env.BINNY_E2E_SUBNET ?? "10.253.6.0/24";
  await writeFile(
    composeOverrideFile,
    [
      "networks:",
      "  default:",
      "    ipam:",
      "      config:",
      `        - subnet: ${e2eSubnet}`,
      "",
    ].join("\n"),
  );
  let cleanupError: Error | undefined;
  let acceptanceFailed = false;
  let acceptanceError: unknown;
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
    const isolatedClient = await verifyIsolatedApiConsumer({
      repositoryRoot,
      projectName,
    });
    assert.deepEqual(isolatedClient, {
      health: "ok",
      binIds: [],
    });
    await verifyConfigurationJourney(baseUrl);
    const enabled = cliData<{ readonly status: string }>(
      await cli(baseUrl, ["bin", "enable", "rss-main"]),
      "enabled",
    );
    assert.equal(enabled.status, "active");
    const resourceFilesBeforeArchive = await resourceFiles(port);
    const archive = await archiveHttpStep("submit", baseUrl);
    const resourceFilesAfterArchive = await resourceFiles(port);
    assert.equal(
      resourceFilesAfterArchive.length - resourceFilesBeforeArchive.length,
      4,
      "五份新资源中只有仍被引用的四份应保留文件字节。",
    );
    const sdkResource = await sdkResourceStep(baseUrl);
    await verifyResourceStorageInterruptions(baseUrl, port, archive);
    await verifyRestartAndRemoval(baseUrl, port, archive, sdkResource);
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
  if (acceptanceFailed) throw acceptanceError;
  if (cleanupError !== undefined) throw cleanupError;
}

await main();
