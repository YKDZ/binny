import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { createApiClient } from "@binny/api/client";
import {
  collectorManifestSchema,
  type ManualRun,
} from "@binny/contracts";

import {
  sourceControlStatusSchema,
  startControlledSource,
} from "./manual-runs-source.ts";

const baseUrl = process.env.BINNY_E2E_BASE_URL;
const e2eHost = process.env.BINNY_E2E_HOST ?? "172.17.0.1";
const manifestJson = process.env.BINNY15_COLLECTOR_MANIFEST;

if (baseUrl === undefined) throw new Error("缺少 BINNY_E2E_BASE_URL。");
if (manifestJson === undefined)
  throw new Error("缺少由 SDK 构造的 BINNY15_COLLECTOR_MANIFEST。");

const manifest = collectorManifestSchema.parse(JSON.parse(manifestJson) as unknown);
const client = createApiClient(baseUrl);

async function triggerRun(
  binId: string,
  sourceUrl: string,
  gateKey: string,
  sourceKey: string,
): Promise<ManualRun> {
  const response = await client.bins[":binId"].runs.$post({
    param: { binId },
    json: {
      action: "collect",
      params: { sourceUrl, gateKey, sourceKey },
    },
  });
  if (response.status === 202) return await response.json();
  const result = await response.json();
  assert.fail(
    `运行触发失败：${result.error.code} ${result.error.message}`,
  );
}

async function readRun(binId: string, runId: string): Promise<ManualRun> {
  const response = await client.bins[":binId"].runs[":runId"].$get({
    param: { binId, runId },
  });
  if (response.status === 200) return await response.json();
  const result = await response.json();
  assert.fail(`运行读取失败：${result.error.code} ${result.error.message}`);
}

async function sourceStatus(sourceUrl: string) {
  const response = await fetch(sourceUrl + "/control/arrivals");
  assert.equal(response.status, 200);
  return sourceControlStatusSchema.parse(await response.json());
}

async function releaseSource(
  sourceUrl: string,
  gateKey: string,
  disposition: "material" | "manual" | "empty" = "material",
): Promise<void> {
  const response = await fetch(sourceUrl + "/control/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gateKey, disposition }),
  });
  assert.equal(response.status, 200);
}

async function waitForArrival(sourceUrl: string, gateKey: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await sourceStatus(sourceUrl);
    if (status.arrivals.some((arrival) => arrival.gateKey === gateKey)) return;
    await delay(50);
  }
  assert.fail(`运行没有到达受控信源：${gateKey}`);
}

async function waitForRun(
  binId: string,
  runId: string,
  status: "completed" | "failed",
): Promise<ManualRun> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = await readRun(binId, runId);
    if (run.status === status) return run;
    await delay(50);
  }
  assert.fail(`运行没有进入 ${status} 状态：${runId}`);
}

async function verifyRunCommit(run: ManualRun): Promise<{
  readonly itemId: string;
  readonly commitId: string;
}> {
  assert.equal(run.status, "completed");
  assert.ok(run.result !== undefined);
  assert.equal(run.result.stopReason.code, "completed");
  assert.equal(run.result.commits.length, 1);
  const locator = run.result.commits[0];
  assert.ok(locator !== undefined);
  assert.equal(locator.items.length, 1);
  const item = locator.items[0];
  assert.ok(item !== undefined);

  const response = await client.archives.commits[":commitId"].$get({
    param: { commitId: locator.commitId },
  });
  assert.equal(response.status, 200);
  const commit = await response.json();
  assert.equal(commit.runId, run.runId);
  assert.equal(commit.binId, run.binId);
  assert.equal(commit.collectorVersion, manifest.version);
  return { itemId: item.itemId, commitId: locator.commitId };
}

async function verifyArchivedSection(
  itemId: string,
  expectedSection: string,
): Promise<void> {
  const response = await client.archives.items[":itemId"].$get({
    param: { itemId },
    query: {},
  });
  assert.equal(response.status, 200);
  const item = await response.json();
  assert.equal(item.views[0]?.state.metadata?.section, expectedSection);
}

async function verifyDynamicValidation(
  sourceUrl: string,
): Promise<void> {
  const invalidParams = await client.bins[":binId"].runs.$post({
    param: { binId: "binny15-one" },
    json: {
      action: "collect",
      params: { sourceUrl, gateKey: "15-invalid-params" },
    },
  });
  assert.equal(invalidParams.status, 400);
  if (invalidParams.status !== 400) return;
  const invalidParamsError = (await invalidParams.json()).error;
  assert.equal(invalidParamsError.code, "invalid_action_parameters");
  assert.deepEqual(invalidParamsError.path, ["params", "sourceKey"]);

  const unknownAction = await client.bins[":binId"].runs.$post({
    param: { binId: "binny15-one" },
    json: { action: "missing", params: {} },
  });
  assert.equal(unknownAction.status, 400);
  if (unknownAction.status !== 400) return;
  const unknownActionError = (await unknownAction.json()).error;
  assert.equal(unknownActionError.code, "action_not_found");
  assert.deepEqual(unknownActionError.path, ["action"]);

  const missingBin = await client.bins[":binId"].runs.$post({
    param: { binId: "binny15-missing" },
    json: { action: "collect", params: {} },
  });
  assert.equal(missingBin.status, 404);
  if (missingBin.status !== 404) return;
  assert.equal((await missingBin.json()).error.code, "bin_not_found");
}

async function verifySerialParallelAndSnapshot(
  sourceUrl: string,
): Promise<string> {
  const firstKey = "15-http-first";
  const secondKey = "15-http-queued";
  const parallelKey = "15-http-parallel";
  const first = await triggerRun(
    "binny15-one",
    sourceUrl,
    firstKey,
    "serial-first",
  );
  await waitForArrival(sourceUrl, firstKey);

  const second = await triggerRun(
    "binny15-one",
    sourceUrl,
    secondKey,
    "serial-queued",
  );
  const waitingSecond = await readRun("binny15-one", second.runId);
  assert.equal(waitingSecond.status, "queued");
  assert.equal(waitingSecond.queueReason, "earlier_run_active");

  const updatedBin = await client.bins[":binId"].$patch({
    param: { binId: "binny15-one" },
    json: { config: { section: "changed-while-queued" } },
  });
  assert.equal(updatedBin.status, 200);
  if (updatedBin.status === 200) {
    const configuration = await updatedBin.json();
    assert.equal(configuration.config.section, "changed-while-queued");
  }

  const parallel = await triggerRun(
    "binny15-two",
    sourceUrl,
    parallelKey,
    "parallel-other-bin",
  );
  await waitForArrival(sourceUrl, parallelKey);
  assert.equal(
    (await sourceStatus(sourceUrl)).arrivals.some(
      (arrival) => arrival.gateKey === secondKey,
    ),
    false,
  );

  await releaseSource(sourceUrl, firstKey);
  await releaseSource(sourceUrl, parallelKey);
  const [completedFirst, completedParallel] = await Promise.all([
    waitForRun("binny15-one", first.runId, "completed"),
    waitForRun("binny15-two", parallel.runId, "completed"),
  ]);
  const firstArchive = await verifyRunCommit(completedFirst);
  await verifyRunCommit(completedParallel);
  await verifyArchivedSection(firstArchive.itemId, "initial");

  await waitForArrival(sourceUrl, secondKey);
  await releaseSource(sourceUrl, secondKey);
  const completedSecond = await waitForRun(
    "binny15-one",
    second.runId,
    "completed",
  );
  const secondArchive = await verifyRunCommit(completedSecond);
  await verifyArchivedSection(secondArchive.itemId, "initial");
  return firstArchive.itemId;
}

async function verifyActionFailures(
  sourceUrl: string,
  existingItemId: string,
): Promise<void> {
  const manualKey = "15-http-manual";
  const manual = await triggerRun(
    "binny15-one",
    sourceUrl,
    manualKey,
    "manual-existing-item",
  );
  await waitForArrival(sourceUrl, manualKey);
  await releaseSource(sourceUrl, manualKey, "manual");
  const failedManual = await waitForRun(
    "binny15-one",
    manual.runId,
    "failed",
  );
  assert.equal(failedManual.result?.error?.code, "source_requires_human");
  assert.equal(failedManual.result?.error?.requiresHuman, true);
  assert.deepEqual(failedManual.result?.error?.path, ["source", "title"]);
  assert.ok(failedManual.result?.error?.impact.includes("manual-existing-item"));
  assert.ok(failedManual.result?.error?.suggestion);

  const before = await client.archives.items[":itemId"].$get({
    param: { itemId: existingItemId },
    query: {},
  });
  assert.equal(before.status, 200);
  if (before.status !== 200) return;
  const original = await before.json();

  const emptyKey = "15-http-empty";
  const empty = await triggerRun(
    "binny15-one",
    sourceUrl,
    emptyKey,
    "serial-first",
  );
  await waitForArrival(sourceUrl, emptyKey);
  await releaseSource(sourceUrl, emptyKey, "empty");
  const failedEmpty = await waitForRun("binny15-one", empty.runId, "failed");
  assert.equal(
    failedEmpty.result?.error?.code,
    "source_returned_no_material",
  );
  assert.equal(failedEmpty.result?.commits.length, 0);

  const after = await client.archives.items[":itemId"].$get({
    param: { itemId: existingItemId },
    query: {},
  });
  assert.equal(after.status, 200);
  if (after.status === 200) {
    const unchanged = await after.json();
    assert.equal(unchanged.views[0]?.state.body?.text, original.views[0]?.state.body?.text);
    assert.equal(unchanged.views[0]?.revisionId, original.views[0]?.revisionId);
  }
}

async function verifyDisabledQueueBoundary(sourceUrl: string): Promise<void> {
  const activeKey = "15-http-active-on-disable";
  const queuedKey = "15-http-queued-on-disable";
  const active = await triggerRun(
    "binny15-one",
    sourceUrl,
    activeKey,
    "active-on-disable",
  );
  await waitForArrival(sourceUrl, activeKey);
  const queued = await triggerRun(
    "binny15-one",
    sourceUrl,
    queuedKey,
    "queued-on-disable",
  );

  const disabled = await client.bins[":binId"].disable.$post({
    param: { binId: "binny15-one" },
  });
  assert.equal(disabled.status, 200);
  const disabledRun = await readRun("binny15-one", queued.runId);
  assert.equal(disabledRun.status, "failed");
  assert.equal(disabledRun.result?.error?.code, "bin_disabled");
  assert.equal(
    (await sourceStatus(sourceUrl)).arrivals.some(
      (arrival) => arrival.gateKey === queuedKey,
    ),
    false,
  );

  const blocked = await client.bins[":binId"].runs.$post({
    param: { binId: "binny15-one" },
    json: { action: "collect", params: {} },
  });
  assert.equal(blocked.status, 409);
  if (blocked.status === 409)
    assert.equal((await blocked.json()).error.code, "bin_disabled");

  await releaseSource(sourceUrl, activeKey);
  const completedActive = await waitForRun(
    "binny15-one",
    active.runId,
    "completed",
  );
  await verifyRunCommit(completedActive);
  const enabled = await client.bins[":binId"].enable.$post({
    param: { binId: "binny15-one" },
  });
  assert.equal(enabled.status, 200);
}

async function main(): Promise<void> {
  const source = await startControlledSource();
  const sourceUrl = "http://" + e2eHost + ":" + String(source.port);
  try {
    await verifyDynamicValidation(sourceUrl);
    const existingItemId = await verifySerialParallelAndSnapshot(sourceUrl);
    await verifyActionFailures(sourceUrl, existingItemId);
    await verifyDisabledQueueBoundary(sourceUrl);
    process.stdout.write(
      "手动运行 HTTP 领取、串行与并行、快照、归档提交和错误结果旅程通过。\n",
    );
  } finally {
    await source.close();
  }
}

await main();
