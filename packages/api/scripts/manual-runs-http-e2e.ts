import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { createApiClient } from "@binny/api/client";
import {
  sourceAdapterManifestSchema,
  type ArchiveSubmissionInput,
  type ManualRun,
} from "@binny/contracts";

import {
  sourceControlStatusSchema,
  type SourceDisposition,
} from "./manual-runs-source.ts";

const baseUrl = process.env.BINNY_E2E_BASE_URL;
const sourceRuntimeUrl = "http://manual-runs-source:8081";
const runtimeControlUrl = process.env.BINNY_RUNS_RUNTIME_CONTROL_URL;
const sourceControlUrl = (() => {
  const url = process.env.BINNY_RUNS_SOURCE_CONTROL_URL;
  if (url === undefined)
    throw new Error("缺少 BINNY_RUNS_SOURCE_CONTROL_URL。");
  return url;
})();
const manifestJson = process.env.BINNY_RUNS_SOURCE_ADAPTER_MANIFEST;

if (baseUrl === undefined) throw new Error("缺少 BINNY_E2E_BASE_URL。");
if (manifestJson === undefined)
  throw new Error("缺少由 SDK 构造的 BINNY_RUNS_SOURCE_ADAPTER_MANIFEST。");
if (runtimeControlUrl === undefined)
  throw new Error("缺少 BINNY_RUNS_RUNTIME_CONTROL_URL。");

const manifest = sourceAdapterManifestSchema.parse(
  JSON.parse(manifestJson) as unknown,
);
const requestTimeoutMs = 10_000;
const client = createApiClient(baseUrl, {
  fetch: (input, init) => {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal =
      init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
    return fetch(input, { ...init, signal });
  },
});

async function triggerRun(
  binId: string,
  sourceUrl: string,
  gateKey: string,
  sourceKey: string,
  invalidOutput = false,
  validationDelayMs?: number,
): Promise<ManualRun> {
  const response = await client.bins[":binId"].runs.$post({
    param: { binId },
    json: {
      action: "collect",
      params: {
        sourceUrl,
        gateKey,
        sourceKey,
        ...(invalidOutput ? { invalidOutput: true } : {}),
        ...(validationDelayMs === undefined ? {} : { validationDelayMs }),
      },
    },
  });
  if (response.status === 202) return await response.json();
  const result = await response.json();
  assert.fail(`运行触发失败：${result.error.code} ${result.error.message}`);
}

async function triggerCheckRun(
  binId: string,
  sourceUrl: string,
  gateKey: string,
  sourceKey: string,
  submitArchive = false,
): Promise<ManualRun> {
  const response = await client.bins[":binId"].runs.$post({
    param: { binId },
    json: {
      action: "check",
      params: {
        sourceUrl,
        gateKey,
        sourceKey,
        ...(submitArchive ? { submitArchive: true } : {}),
      },
    },
  });
  if (response.status === 202) return await response.json();
  const result = await response.json();
  assert.fail(`check 触发失败：${result.error.code} ${result.error.message}`);
}

async function readRun(binId: string, runId: string): Promise<ManualRun> {
  const response = await client.bins[":binId"].runs[":runId"].$get({
    param: { binId, runId },
  });
  if (response.status === 200) return await response.json();
  const result = await response.json();
  assert.fail(`运行读取失败：${result.error.code} ${result.error.message}`);
}

async function heartbeat(
  binId: string,
  runtimeId: string,
  stoppedRunId?: string,
  allowInvalidDefault = false,
): Promise<void> {
  const response = await client.bins[":binId"].runtime.heartbeat.$post({
    param: { binId },
    json: {
      protocolVersion: 6,
      runtimeId,
      ownerGeneration: "1",
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
      runtimeControlUrl: runtimeControlUrl!,
      ...(stoppedRunId === undefined ? {} : { stoppedRunId }),
      sourceAdapter: manifest,
      environment: {
        kind: "lightweight",
        browser: {
          available: false,
          profileReuseAfterRestart: false,
          power: { status: "unavailable" },
        },
      },
    },
  });
  if (response.status === 200) return;
  const result = await response.json();
  if (
    allowInvalidDefault &&
    response.status === 409 &&
    result.error.code === "runtime_configuration_incompatible"
  )
    return;
  assert.fail(`并发验收 runtime 注册失败：${result.error.code}`);
}

async function disconnectRuntime(
  binId: string,
  runtimeId: string,
): Promise<void> {
  const response = await client.bins[":binId"].runtime.disconnect.$post({
    param: { binId },
    json: {
      runtimeId,
      ownerLockAcquired: true,
      activeRunId: null,
      claimInFlight: false,
    },
  });
  if (response.status === 200) return;
  const result = await response.json();
  assert.fail(`并发验收 runtime 断开失败：${result.error.code}`);
}

async function createConcurrencyBin(
  binId: string,
  runtimeId: string,
): Promise<void> {
  await heartbeat(binId, runtimeId, undefined, true);
  const configured = await client.bins[":binId"].$patch({
    param: { binId },
    json: { config: { section: "concurrency" } },
  });
  if (configured.status !== 200) {
    const result = await configured.json();
    assert.fail(`并发验收配置失败：${result.error.code}`);
  }
  await disconnectRuntime(binId, runtimeId);
  const offlineRun = await client.bins[":binId"].runs.$post({
    param: { binId },
    json: {
      action: "collect",
      params: {
        sourceUrl: sourceRuntimeUrl,
        gateKey: "offline-action-input",
        sourceKey: "offline-action-input",
      },
    },
  });
  assert.equal(offlineRun.status, 409);
  if (offlineRun.status === 409)
    assert.equal(
      (await offlineRun.json()).error.code,
      "runtime_action_validation_unavailable",
    );
  const offlineSchedule = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: {
      expression: "0 0 0 1 1 *",
      timeZone: "UTC",
      action: "collect",
      params: {
        sourceUrl: sourceRuntimeUrl,
        gateKey: "offline-schedule-input",
        sourceKey: "offline-schedule-input",
      },
    },
  });
  assert.equal(offlineSchedule.status, 409);
  if (offlineSchedule.status === 409)
    assert.equal(
      (await offlineSchedule.json()).error.code,
      "runtime_action_validation_unavailable",
    );
  const schedules = await client.bins[":binId"].schedules.$get({
    param: { binId },
  });
  assert.equal(schedules.status, 200);
  if (schedules.status === 200)
    assert.equal((await schedules.json()).schedules.length, 0);
  const rejectedOfflineConfig = await client.bins[":binId"].$patch({
    param: { binId },
    json: { config: { section: "offline-update" } },
  });
  assert.equal(rejectedOfflineConfig.status, 409);
  if (rejectedOfflineConfig.status === 409)
    assert.equal(
      (await rejectedOfflineConfig.json()).error.code,
      "runtime_configuration_validation_unavailable",
    );
  const preserved = await client.bins[":binId"].$get({ param: { binId } });
  assert.equal(preserved.status, 200);
  if (preserved.status === 200)
    assert.deepEqual((await preserved.json()).config, {
      section: "concurrency",
    });
}

async function claimRun(binId: string, runtimeId: string) {
  const response = await client.bins[":binId"].runtime.runs.claim.$post({
    param: { binId },
    json: { runtimeId },
  });
  if (response.status === 200) return (await response.json()).run;
  const result = await response.json();
  assert.fail(`运行领取失败：${result.error.code} ${result.error.message}`);
}

async function completeRun(
  binId: string,
  runId: string,
  runtimeId: string,
): Promise<void> {
  const response = await client.bins[":binId"].runtime.runs[
    ":runId"
  ].complete.$post({
    param: { binId, runId },
    json: {
      runtimeId,
      completion: { status: "completed", output: null },
    },
  });
  if (response.status === 200) return;
  const result = await response.json();
  assert.fail(`运行终结失败：${result.error.code} ${result.error.message}`);
}

async function removeConcurrencyBin(binId: string): Promise<void> {
  const response = await client.bins[":binId"].$delete({ param: { binId } });
  if (response.status === 200) return;
  const result = await response.json();
  assert.fail(`并发验收 bin 清理失败：${result.error.code}`);
}

async function cancelRun(binId: string, runId: string) {
  return await client.bins[":binId"].runs[":runId"].cancel.$post({
    param: { binId, runId },
  });
}

async function verifyQueuedCancellation(): Promise<void> {
  const binId = "binny-lifecycle-queued-cancel";
  const runtimeId = "binny-lifecycle-queued-cancel-runtime";
  await createConcurrencyBin(binId, runtimeId);
  try {
    await heartbeat(binId, runtimeId);
    const queued = await triggerRun(
      binId,
      sourceRuntimeUrl,
      "lifecycle-queued-cancel",
      "queued-cancel",
    );
    assert.equal(queued.status, "queued");
    const accepted = await cancelRun(binId, queued.runId);
    assert.equal(accepted.status, 200);
    if (accepted.status !== 200) return;
    const cancelled = await accepted.json();
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.finishedAt);
    assert.equal(
      cancelled.result?.stopReason.code,
      "cancelled_before_execution",
    );

    await heartbeat(binId, runtimeId);
    assert.equal(await claimRun(binId, runtimeId), null);
    assert.equal((await readRun(binId, queued.runId)).status, "cancelled");
  } finally {
    await removeConcurrencyBin(binId);
  }
}

async function verifyCancellationFencesLateWrites(): Promise<void> {
  const binId = "binny-lifecycle-fenced-cancel";
  const runtimeId = "binny-lifecycle-fenced-cancel-runtime";
  await createConcurrencyBin(binId, runtimeId);
  try {
    await heartbeat(binId, runtimeId);
    const queued = await triggerRun(
      binId,
      sourceRuntimeUrl,
      "lifecycle-fenced-cancel",
      "fenced-cancel",
    );
    const claimed = await claimRun(binId, runtimeId);
    assert.equal(claimed?.runId, queued.runId);

    const submission = {
      requestId: "binny-lifecycle-replay:" + queued.runId,
      binId,
      runId: queued.runId,
      sourceAdapterVersion: manifest.version,
      items: [
        {
          sourceKey: {
            namespace: "binny-lifecycle.cancellation",
            key: queued.runId,
          },
          body: { text: "取消前已提交的资料。" },
          capture: {
            scope: { runId: queued.runId },
            completeness: "complete",
            missing: [],
          },
        },
      ],
      relations: [],
    } satisfies ArchiveSubmissionInput;
    const initialCommit = await client.archives.$post({ json: submission });
    assert.equal(initialCommit.status, 201);
    if (initialCommit.status !== 201) return;
    const original = await initialCommit.json();

    const accepted = await cancelRun(binId, queued.runId);
    assert.equal(accepted.status, 200);
    if (accepted.status !== 200) return;
    assert.equal((await accepted.json()).status, "cancelling");

    const replay = await client.archives.$post({ json: submission });
    assert.equal(replay.status, 201);
    if (replay.status === 201)
      assert.equal((await replay.json()).commitId, original.commitId);

    const lateWrite = await client.archives.$post({
      json: { ...submission, requestId: submission.requestId + ":late" },
    });
    assert.equal(lateWrite.status, 409);
    if (lateWrite.status === 409)
      assert.equal((await lateWrite.json()).error.code, "run_not_writable");

    const staleCompletion = await client.bins[":binId"].runtime.runs[
      ":runId"
    ].complete.$post({
      param: { binId, runId: queued.runId },
      json: {
        runtimeId,
        completion: { status: "completed", output: null },
      },
    });
    assert.equal(staleCompletion.status, 409);
    if (staleCompletion.status === 409)
      assert.equal(
        (await staleCompletion.json()).error.code,
        "run_cancellation_pending",
      );

    const pendingStop = await readRun(binId, queued.runId);
    assert.equal(pendingStop.status, "cancelling");
    assert.equal(pendingStop.stopConfirmedAt, undefined);

    await heartbeat(binId, runtimeId, queued.runId);
    const stopped = await readRun(binId, queued.runId);
    assert.equal(stopped.status, "cancelled");
    assert.ok(stopped.stopConfirmedAt);

    const lateCompletion = await client.bins[":binId"].runtime.runs[
      ":runId"
    ].complete.$post({
      param: { binId, runId: queued.runId },
      json: {
        runtimeId,
        completion: { status: "completed", output: null },
      },
    });
    assert.equal(lateCompletion.status, 409);
    if (lateCompletion.status === 409)
      assert.equal(
        (await lateCompletion.json()).error.code,
        "run_not_executing",
      );
  } finally {
    await removeConcurrencyBin(binId);
  }
}

async function verifyConcurrentRuns(): Promise<void> {
  const firstBin = "binny-runs-pool-one";
  const secondBin = "binny-runs-pool-two";
  const firstRuntime = "binny-runs-pool-runtime-one";
  const secondRuntime = "binny-runs-pool-runtime-two";
  const firstKeys = Array.from(
    { length: 16 },
    (_, index) => "runs-pool-one-" + String(index),
  );
  const secondKey = "runs-pool-two";

  await Promise.all([
    createConcurrencyBin(firstBin, firstRuntime),
    createConcurrencyBin(secondBin, secondRuntime),
  ]);
  await Promise.all([
    heartbeat(firstBin, firstRuntime),
    heartbeat(secondBin, secondRuntime),
  ]);
  const firstRuns = await Promise.all(
    firstKeys.map((key) => triggerRun(firstBin, sourceRuntimeUrl, key, key)),
  );
  const secondRun = await triggerRun(
    secondBin,
    sourceRuntimeUrl,
    secondKey,
    secondKey,
  );
  await Promise.all([
    disconnectRuntime(firstBin, firstRuntime),
    disconnectRuntime(secondBin, secondRuntime),
  ]);
  const firstRunIds = firstRuns.map((run) => run.runId);
  assert.equal(new Set(firstRunIds).size, 16);
  assert.equal(new Set([...firstRunIds, secondRun.runId]).size, 17);

  for (const runId of firstRunIds) {
    const run = await readRun(firstBin, runId);
    assert.equal(run.status, "queued");
    assert.equal(run.queueReason, "runtime_offline");
  }

  await Promise.all([
    heartbeat(firstBin, firstRuntime),
    heartbeat(secondBin, secondRuntime),
  ]);
  const [firstClaims, secondClaim] = await Promise.all([
    Promise.all(
      Array.from({ length: 16 }, () => claimRun(firstBin, firstRuntime)),
    ),
    claimRun(secondBin, secondRuntime),
  ]);
  const firstClaimedRuns = firstClaims.filter((run) => run !== null);
  assert.equal(firstClaimedRuns.length, 1);
  const firstClaimed = firstClaimedRuns[0];
  assert.ok(firstClaimed !== undefined);
  assert.ok(firstRunIds.includes(firstClaimed.runId));
  assert.equal(secondClaim?.binId, secondBin);

  const firstStatuses = await Promise.all(
    firstRunIds.map((runId) => readRun(firstBin, runId)),
  );
  assert.equal(
    firstStatuses.filter((run) => run.status === "executing").length,
    1,
  );
  assert.equal(
    firstStatuses.filter((run) => run.status === "queued").length,
    15,
  );
  await completeRun(firstBin, firstClaimed.runId, firstRuntime);
  assert.ok(secondClaim !== null);
  await completeRun(secondBin, secondClaim.runId, secondRuntime);

  const completedRunIds = new Set([firstClaimed.runId]);
  while (completedRunIds.size < firstRunIds.length) {
    const next = await claimRun(firstBin, firstRuntime);
    assert.ok(next !== null);
    assert.ok(firstRunIds.includes(next.runId));
    assert.equal(completedRunIds.has(next.runId), false);
    assert.equal((await readRun(firstBin, next.runId)).status, "executing");
    await completeRun(firstBin, next.runId, firstRuntime);
    completedRunIds.add(next.runId);
  }

  for (const runId of firstRunIds) {
    assert.equal((await readRun(firstBin, runId)).status, "completed");
  }
  assert.equal((await readRun(secondBin, secondRun.runId)).status, "completed");
  assert.equal(await claimRun(firstBin, firstRuntime), null);
  assert.equal(await claimRun(secondBin, secondRuntime), null);
  await Promise.all([
    removeConcurrencyBin(firstBin),
    removeConcurrencyBin(secondBin),
  ]);
}

async function sourceStatus(sourceUrl: string) {
  const response = await fetch(sourceUrl + "/control/arrivals", {
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  return sourceControlStatusSchema.parse(await response.json());
}

async function releaseSource(
  sourceUrl: string,
  gateKey: string,
  disposition: SourceDisposition = "material",
): Promise<void> {
  const response = await fetch(sourceUrl + "/control/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gateKey, disposition }),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
}

async function waitForArrival(
  sourceUrl: string,
  gateKey: string,
): Promise<void> {
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

async function verifyAvailabilityChecks(): Promise<void> {
  const cases = [
    { disposition: "available", availability: "available" },
    { disposition: "unavailable", availability: "unavailable" },
    { disposition: "unknown", availability: "unknown" },
  ] as const;
  for (const [index, current] of cases.entries()) {
    const gateKey = `16-check-${current.disposition}`;
    const sourceKey = `16-check-scope-${String(index)}`;
    const queued = await triggerCheckRun(
      "binny-runs-one",
      sourceRuntimeUrl,
      gateKey,
      sourceKey,
    );
    assert.equal(queued.action, "check");
    assert.equal(queued.status, "queued");
    await waitForArrival(sourceControlUrl, gateKey);
    await releaseSource(sourceControlUrl, gateKey, current.disposition);

    const finished = await waitForRun(
      "binny-runs-one",
      queued.runId,
      "completed",
    );
    assert.equal(finished.status, "completed");
    assert.equal(finished.result?.error, undefined);
    assert.deepEqual(finished.result?.commits, []);
    assert.equal(finished.result?.stopReason.code, "completed");
    const diagnostic = finished.result?.output as
      | {
          readonly availability: string;
          readonly scope: readonly string[];
          readonly basis: string;
          readonly problems: readonly {
            readonly suggestion: string;
            readonly requiresHuman: boolean;
          }[];
        }
      | undefined;
    assert.ok(diagnostic !== undefined);
    assert.equal(diagnostic.availability, current.availability);
    assert.deepEqual(diagnostic.scope, ["source/" + sourceKey]);
    assert.ok(diagnostic.basis.length > 0);
    if (current.availability === "available") {
      assert.deepEqual(diagnostic.problems, []);
    } else {
      assert.ok(diagnostic.problems.length > 0);
      const problem = diagnostic.problems[0];
      assert.ok(problem !== undefined);
      assert.ok(problem.suggestion.length > 0);
      assert.equal(problem.requiresHuman, true);
    }
  }

  const failedKey = "check-check-execution-error";
  const failedSourceKey = "check-check-execution-error-scope";
  const queuedFailure = await triggerCheckRun(
    "binny-runs-one",
    sourceRuntimeUrl,
    failedKey,
    failedSourceKey,
  );
  await waitForArrival(sourceControlUrl, failedKey);
  await releaseSource(sourceControlUrl, failedKey, "execution-error");
  const executionFailure = await waitForRun(
    "binny-runs-one",
    queuedFailure.runId,
    "failed",
  );
  assert.equal(executionFailure.result?.output, undefined);
  assert.equal(executionFailure.result?.error?.code, "source_check_failed");
  assert.equal(executionFailure.result?.stopReason.code, "source_check_failed");

  const archiveGate = "16-check-archive";
  const archiveCheck = await triggerCheckRun(
    "binny-runs-one",
    sourceRuntimeUrl,
    archiveGate,
    "check-archive-result",
    true,
  );
  await waitForArrival(sourceControlUrl, archiveGate);
  await releaseSource(sourceControlUrl, archiveGate, "available");
  const archivedCheck = await waitForRun(
    "binny-runs-one",
    archiveCheck.runId,
    "completed",
  );
  const checkArchive = await verifyRunCommit(archivedCheck);
  const archivedCheckItem = await client.archives.items[":itemId"].$get({
    param: { itemId: checkArchive.itemId },
    query: {},
  });
  assert.equal(archivedCheckItem.status, 200);
}

async function verifyOrdinaryAction(): Promise<void> {
  const binId = "binny-runs-one";
  const invalid = await client.bins[":binId"].runs.$post({
    param: { binId },
    json: { action: "discover", params: { prefix: "" } },
  });
  if (invalid.status === 202) {
    const queued = await invalid.json();
    const failed = await waitForRun(binId, queued.runId, "failed");
    assert.equal(failed.result?.error?.code, "invalid_action_parameters");
    assert.equal(failed.result?.output, undefined);
  } else {
    assert.equal(invalid.status, 400);
    if (invalid.status === 400)
      assert.equal(
        (await invalid.json()).error.code,
        "invalid_action_parameters",
      );
  }

  const response = await client.bins[":binId"].runs.$post({
    param: { binId },
    json: { action: "discover", params: {} },
  });
  assert.equal(response.status, 202);
  if (response.status !== 202) return;
  const queued = await response.json();
  const completed = await waitForRun(binId, queued.runId, "completed");
  assert.equal(completed.action, "discover");
  assert.deepEqual(completed.result?.output, {
    name: "entry!:runtime!:changed-while-queued",
  });
  assert.deepEqual(completed.result?.commits, []);
}

function nextLastSundayAtUtc(month: number, hour: number, minute = 0): Date {
  const now = Date.now();
  for (let year = new Date(now).getUTCFullYear(); ; year += 1) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    const date = lastDay.getUTCDate() - lastDay.getUTCDay();
    const dueAt = new Date(Date.UTC(year, month, date, hour, minute));
    if (dueAt.getTime() > now) return dueAt;
  }
}

async function verifySchedulesCrud(runtimeSourceUrl: string): Promise<void> {
  const binId = "binny-runs-one";
  const expression = "0 0 0 1 1 *";
  const params = {
    sourceUrl: runtimeSourceUrl,
    gateKey: "schedule-schedule-crud",
    sourceKey: "schedule-schedule-crud",
  };

  const invalidExpression = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: {
      expression: "every minute",
      timeZone: "UTC",
      action: "collect",
      params,
    },
  });
  assert.equal(invalidExpression.status, 400);
  if (invalidExpression.status === 400)
    assert.equal(
      (await invalidExpression.json()).error.code,
      "invalid_schedule_expression",
    );

  const invalidTimeZone = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: {
      expression,
      timeZone: "Mars/Olympus_Mons",
      action: "collect",
      params,
    },
  });
  assert.equal(invalidTimeZone.status, 400);
  if (invalidTimeZone.status === 400)
    assert.equal(
      (await invalidTimeZone.json()).error.code,
      "invalid_time_zone",
    );

  const invalidActionParameters = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: { expression, timeZone: "UTC", action: "collect", params: {} },
  });
  assert.equal(invalidActionParameters.status, 400);
  if (invalidActionParameters.status === 400)
    assert.equal(
      (await invalidActionParameters.json()).error.code,
      "invalid_action_parameters",
    );

  const refinedActionParameters = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: {
      expression,
      timeZone: "UTC",
      action: "collect",
      params: {
        ...params,
        gateKey: "native-refine-reject",
      },
    },
  });
  assert.equal(refinedActionParameters.status, 400);
  if (refinedActionParameters.status === 400) {
    const error = (await refinedActionParameters.json()).error;
    assert.equal(error.code, "invalid_action_parameters");
    assert.deepEqual(error.path, ["params", "gateKey"]);
  }

  const created = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: { expression, timeZone: "UTC", action: "collect", params },
  });
  assert.equal(created.status, 201);
  if (created.status !== 201) return;
  const schedule = await created.json();
  assert.equal(schedule.binId, binId);
  assert.equal(schedule.expression, expression);
  assert.equal(schedule.timeZone, "UTC");
  assert.equal(schedule.action, "collect");
  assert.deepEqual(schedule.params, params);
  assert.ok(Date.parse(schedule.nextDueAt) > Date.now());

  const listed = await client.bins[":binId"].schedules.$get({
    param: { binId },
  });
  assert.equal(listed.status, 200);
  if (listed.status === 200)
    assert.ok(
      (await listed.json()).schedules.some(
        ({ scheduleId }) => scheduleId === schedule.scheduleId,
      ),
    );

  const read = await client.bins[":binId"].schedules[":scheduleId"].$get({
    param: { binId, scheduleId: schedule.scheduleId },
  });
  assert.equal(read.status, 200);
  if (read.status === 200)
    assert.equal((await read.json()).scheduleId, schedule.scheduleId);

  const invalidUpdate = await client.bins[":binId"].schedules[
    ":scheduleId"
  ].$patch({
    param: { binId, scheduleId: schedule.scheduleId },
    json: { params: {} },
  });
  assert.equal(invalidUpdate.status, 400);
  if (invalidUpdate.status === 400)
    assert.equal(
      (await invalidUpdate.json()).error.code,
      "invalid_action_parameters",
    );

  const refinedUpdate = await client.bins[":binId"].schedules[
    ":scheduleId"
  ].$patch({
    param: { binId, scheduleId: schedule.scheduleId },
    json: {
      params: { ...params, gateKey: "native-refine-reject" },
    },
  });
  assert.equal(refinedUpdate.status, 400);
  if (refinedUpdate.status === 400) {
    const error = (await refinedUpdate.json()).error;
    assert.equal(error.code, "invalid_action_parameters");
    assert.deepEqual(error.path, ["params", "gateKey"]);
  }

  const updated = await client.bins[":binId"].schedules[":scheduleId"].$patch({
    param: { binId, scheduleId: schedule.scheduleId },
    json: {
      expression: "0 30 2 * * *",
      timeZone: "Europe/London",
      action: "check",
      params: { ...params, gateKey: "schedule-schedule-updated" },
    },
  });
  assert.equal(updated.status, 200);
  if (updated.status === 200) {
    const value = await updated.json();
    assert.equal(value.expression, "0 30 2 * * *");
    assert.equal(value.timeZone, "Europe/London");
    assert.equal(value.action, "check");
    assert.equal(value.params.gateKey, "schedule-schedule-updated");
  }

  const disabled = await client.bins[":binId"].schedules[
    ":scheduleId"
  ].disable.$post({
    param: { binId, scheduleId: schedule.scheduleId },
  });
  assert.equal(disabled.status, 200);
  if (disabled.status === 200)
    assert.equal((await disabled.json()).enabled, false);

  const enabled = await client.bins[":binId"].schedules[
    ":scheduleId"
  ].enable.$post({
    param: { binId, scheduleId: schedule.scheduleId },
  });
  assert.equal(enabled.status, 200);
  if (enabled.status === 200)
    assert.equal((await enabled.json()).enabled, true);

  const removed = await client.bins[":binId"].schedules[":scheduleId"].$delete({
    param: { binId, scheduleId: schedule.scheduleId },
  });
  assert.equal(removed.status, 200);
  if (removed.status === 200)
    assert.deepEqual(await removed.json(), {
      removed: true,
      scheduleId: schedule.scheduleId,
    });
  const afterRemoval = await client.bins[":binId"].schedules[
    ":scheduleId"
  ].$get({ param: { binId, scheduleId: schedule.scheduleId } });
  assert.equal(afterRemoval.status, 404);

  // cron-parser 会跳过春季缺失的本地 01:30；先按转换点选年，再检查其后的到期点。
  const springTransition = nextLastSundayAtUtc(2, 1);
  const springDueAt = new Date(springTransition.getTime() + 30 * 60 * 1000);
  const springExpression = "0 30 1 * 3 SUNL";
  const springSchedule = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: {
      expression: springExpression,
      timeZone: "Europe/London",
      action: "check",
      params,
    },
  });
  assert.equal(springSchedule.status, 201);
  if (springSchedule.status === 201) {
    const value = await springSchedule.json();
    assert.equal(value.nextDueAt, springDueAt.toISOString());
    const removedSpring = await client.bins[":binId"].schedules[
      ":scheduleId"
    ].$delete({ param: { binId, scheduleId: value.scheduleId } });
    assert.equal(removedSpring.status, 200);
  }

  const autumnDueAt = nextLastSundayAtUtc(9, 0, 30);
  const autumnExpression = "0 30 1 * 10 SUNL";
  const autumnSchedule = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: {
      expression: autumnExpression,
      timeZone: "Europe/London",
      action: "check",
      params,
    },
  });
  assert.equal(autumnSchedule.status, 201);
  if (autumnSchedule.status === 201) {
    const value = await autumnSchedule.json();
    assert.equal(value.nextDueAt, autumnDueAt.toISOString());
    const removedAutumn = await client.bins[":binId"].schedules[
      ":scheduleId"
    ].$delete({ param: { binId, scheduleId: value.scheduleId } });
    assert.equal(removedAutumn.status, 200);
  }
}

async function verifyScheduledReferenceTime(
  runtimeSourceUrl: string,
  controlSourceUrl: string,
): Promise<void> {
  const binId = "binny-runs-one";
  const gateKey = "schedule-reference-time";
  const created = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: {
      expression: "*/1 * * * * *",
      timeZone: "UTC",
      action: "collect",
      params: {
        sourceUrl: runtimeSourceUrl,
        gateKey,
        sourceKey: gateKey,
      },
    },
  });
  assert.equal(created.status, 201);
  if (created.status !== 201) return;
  const schedule = await created.json();
  let removed = false;
  try {
    await waitForArrival(controlSourceUrl, gateKey);
    const arrival = (await sourceStatus(controlSourceUrl)).arrivals.find(
      (candidate) => candidate.gateKey === gateKey,
    );
    assert.ok(arrival !== undefined);
    if (arrival === undefined) return;
    const queued = await readRun(binId, arrival.runId);
    assert.deepEqual(queued.trigger, {
      kind: "schedule",
      scheduleId: schedule.scheduleId,
      scheduledFor: schedule.nextDueAt,
    });
    assert.equal(queued.referenceTime, schedule.nextDueAt);

    const deleted = await client.bins[":binId"].schedules[
      ":scheduleId"
    ].$delete({
      param: { binId, scheduleId: schedule.scheduleId },
    });
    assert.equal(deleted.status, 200);
    removed = deleted.status === 200;
    await releaseSource(controlSourceUrl, gateKey);
    const completed = await waitForRun(binId, arrival.runId, "completed");
    const committed = await verifyRunCommit(completed);
    await verifyArchivedSection(
      committed.itemId,
      "changed-while-queued",
      schedule.nextDueAt,
    );
  } finally {
    if (!removed) {
      await client.bins[":binId"].schedules[":scheduleId"].$delete({
        param: { binId, scheduleId: schedule.scheduleId },
      });
    }
    await releaseSource(controlSourceUrl, gateKey);
  }
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
  assert.equal(commit.sourceAdapterVersion, manifest.version);
  return { itemId: item.itemId, commitId: locator.commitId };
}

async function verifyArchivedSection(
  itemId: string,
  expectedSection: string,
  expectedReferenceTime: string,
): Promise<void> {
  const response = await client.archives.items[":itemId"].$get({
    param: { itemId },
    query: {},
  });
  assert.equal(response.status, 200);
  const item = await response.json();
  const metadata = item.views[0]?.state.metadata;
  assert.equal(metadata?.section, expectedSection);
  assert.equal(metadata?.adapterLabel, "runtime!");
  assert.equal(metadata?.actionLabel, "collect!");
  assert.equal(metadata?.referenceTime, expectedReferenceTime);
}

async function verifyDynamicValidation(sourceUrl: string): Promise<void> {
  const incompleteCheck = await client.bins[":binId"].runs.$post({
    param: { binId: "binny-runs-one" },
    json: {
      action: "check",
      params: { sourceUrl, gateKey: "check-check-invalid-params" },
    },
  });
  assert.equal(incompleteCheck.status, 400);
  if (incompleteCheck.status === 400) {
    const error = (await incompleteCheck.json()).error;
    assert.equal(error.code, "invalid_action_parameters");
    assert.deepEqual(error.path, ["params", "sourceKey"]);
  }

  const invalidParams = await client.bins[":binId"].runs.$post({
    param: { binId: "binny-runs-one" },
    json: {
      action: "collect",
      params: { sourceUrl, gateKey: "runs-invalid-params" },
    },
  });
  assert.equal(invalidParams.status, 400);
  if (invalidParams.status !== 400) return;
  const invalidParamsError = (await invalidParams.json()).error;
  assert.equal(invalidParamsError.code, "invalid_action_parameters");
  assert.deepEqual(invalidParamsError.path, ["params", "sourceKey"]);

  const rejectedByNativeRefine = await client.bins[":binId"].runs.$post({
    param: { binId: "binny-runs-one" },
    json: {
      action: "collect",
      params: {
        sourceUrl,
        gateKey: "native-refine-reject",
        sourceKey: "native-refine-reject",
      },
    },
  });
  assert.equal(rejectedByNativeRefine.status, 400);
  if (rejectedByNativeRefine.status === 400) {
    const error = (await rejectedByNativeRefine.json()).error;
    assert.equal(error.code, "invalid_action_parameters");
    assert.deepEqual(error.path, ["params", "gateKey"]);
  }

  const inheritedAction = await client.bins[":binId"].runs.$post({
    param: { binId: "binny-runs-one" },
    json: { action: "constructor", params: {} },
  });
  assert.equal(inheritedAction.status, 400);
  if (inheritedAction.status === 400) {
    const error = (await inheritedAction.json()).error;
    assert.equal(error.code, "action_not_found");
    assert.deepEqual(error.path, ["action"]);
  }

  const unknownAction = await client.bins[":binId"].runs.$post({
    param: { binId: "binny-runs-one" },
    json: { action: "missing", params: {} },
  });
  assert.equal(unknownAction.status, 400);
  if (unknownAction.status !== 400) return;
  const unknownActionError = (await unknownAction.json()).error;
  assert.equal(unknownActionError.code, "action_not_found");
  assert.deepEqual(unknownActionError.path, ["action"]);

  const missingBin = await client.bins[":binId"].runs.$post({
    param: { binId: "binny-runs-missing" },
    json: { action: "collect", params: {} },
  });
  assert.equal(missingBin.status, 404);
  if (missingBin.status !== 404) return;
  assert.equal((await missingBin.json()).error.code, "bin_not_found");
}

async function verifyActionValidationSnapshotRace(
  sourceUrl: string,
): Promise<void> {
  const binId = "binny-runs-two";
  const pending = client.bins[":binId"].runs.$post({
    param: { binId },
    json: {
      action: "collect",
      params: {
        sourceUrl,
        gateKey: "action-validation-race",
        sourceKey: "action-validation-race",
        validationDelayMs: 1_000,
      },
    },
  });
  await delay(150);
  const changed = await client.bins[":binId"].$patch({
    param: { binId },
    json: { config: { section: "changed-during-action-validation" } },
  });
  assert.equal(changed.status, 200);
  const result = await pending;
  assert.equal(result.status, 409);
  if (result.status === 409)
    assert.equal((await result.json()).error.code, "action_input_changed");

  const restored = await client.bins[":binId"].$patch({
    param: { binId },
    json: { config: { section: "initial" } },
  });
  assert.equal(restored.status, 200);
}

async function verifySerialParallelAndSnapshot(
  runtimeSourceUrl: string,
  controlSourceUrl: string,
): Promise<string> {
  const firstKey = "runs-http-first";
  const secondKey = "runs-http-queued";
  const parallelKey = "runs-http-parallel";
  const first = await triggerRun(
    "binny-runs-one",
    runtimeSourceUrl,
    firstKey,
    "serial-first",
  );
  assert.equal(first.referenceTime, first.createdAt);
  await waitForArrival(controlSourceUrl, firstKey);

  const second = await triggerRun(
    "binny-runs-one",
    runtimeSourceUrl,
    secondKey,
    "serial-queued",
  );
  assert.equal(second.referenceTime, second.createdAt);
  const waitingSecond = await readRun("binny-runs-one", second.runId);
  assert.equal(waitingSecond.status, "queued");
  assert.equal(waitingSecond.queueReason, "earlier_run_active");

  const updatedBin = await client.bins[":binId"].$patch({
    param: { binId: "binny-runs-one" },
    json: { config: { section: "changed-while-queued" } },
  });
  assert.equal(updatedBin.status, 200);
  if (updatedBin.status === 200) {
    const configuration = await updatedBin.json();
    assert.equal(configuration.config.section, "changed-while-queued");
  }

  const parallel = await triggerRun(
    "binny-runs-two",
    runtimeSourceUrl,
    parallelKey,
    "parallel-other-bin",
  );
  await waitForArrival(controlSourceUrl, parallelKey);
  assert.equal(
    (await sourceStatus(controlSourceUrl)).arrivals.some(
      (arrival) => arrival.gateKey === secondKey,
    ),
    false,
  );

  await releaseSource(controlSourceUrl, firstKey);
  await releaseSource(controlSourceUrl, parallelKey);
  const [completedFirst, completedParallel] = await Promise.all([
    waitForRun("binny-runs-one", first.runId, "completed"),
    waitForRun("binny-runs-two", parallel.runId, "completed"),
  ]);
  assert.deepEqual(completedFirst.result?.output, {
    completedScopes: ["source/serial-first"],
  });
  const firstArchive = await verifyRunCommit(completedFirst);
  await verifyRunCommit(completedParallel);
  await verifyArchivedSection(
    firstArchive.itemId,
    "initial",
    completedFirst.referenceTime,
  );

  await waitForArrival(controlSourceUrl, secondKey);
  await releaseSource(controlSourceUrl, secondKey);
  const completedSecond = await waitForRun(
    "binny-runs-one",
    second.runId,
    "completed",
  );
  const secondArchive = await verifyRunCommit(completedSecond);
  await verifyArchivedSection(
    secondArchive.itemId,
    "initial",
    completedSecond.referenceTime,
  );
  return firstArchive.itemId;
}

async function verifyActionFailures(
  runtimeSourceUrl: string,
  controlSourceUrl: string,
  existingItemId: string,
): Promise<void> {
  const manualKey = "runs-http-manual";
  const manual = await triggerRun(
    "binny-runs-one",
    runtimeSourceUrl,
    manualKey,
    "manual-existing-item",
  );
  await waitForArrival(controlSourceUrl, manualKey);
  await releaseSource(controlSourceUrl, manualKey, "manual");
  const failedManual = await waitForRun(
    "binny-runs-one",
    manual.runId,
    "failed",
  );
  assert.equal(failedManual.result?.error?.code, "source_requires_human");
  assert.equal(failedManual.result?.error?.requiresHuman, true);
  assert.deepEqual(failedManual.result?.error?.path, ["source", "title"]);
  assert.ok(
    failedManual.result?.error?.impact.includes("manual-existing-item"),
  );
  assert.ok(failedManual.result?.error?.suggestion);

  const before = await client.archives.items[":itemId"].$get({
    param: { itemId: existingItemId },
    query: {},
  });
  assert.equal(before.status, 200);
  if (before.status !== 200) return;
  const original = await before.json();

  const emptyKey = "runs-http-empty";
  const empty = await triggerRun(
    "binny-runs-one",
    runtimeSourceUrl,
    emptyKey,
    "serial-first",
  );
  await waitForArrival(controlSourceUrl, emptyKey);
  await releaseSource(controlSourceUrl, emptyKey, "empty");
  const failedEmpty = await waitForRun("binny-runs-one", empty.runId, "failed");
  assert.equal(failedEmpty.result?.error?.code, "source_returned_no_material");
  assert.equal(failedEmpty.result?.commits.length, 0);

  const after = await client.archives.items[":itemId"].$get({
    param: { itemId: existingItemId },
    query: {},
  });
  assert.equal(after.status, 200);
  if (after.status === 200) {
    const unchanged = await after.json();
    assert.equal(
      unchanged.views[0]?.state.body?.text,
      original.views[0]?.state.body?.text,
    );
    assert.equal(unchanged.views[0]?.revisionId, original.views[0]?.revisionId);
  }

  const partialKey = "runs-http-partial";
  const partial = await triggerRun(
    "binny-runs-one",
    runtimeSourceUrl,
    partialKey,
    "partial-before-manual",
  );
  await waitForArrival(controlSourceUrl, partialKey);
  await releaseSource(controlSourceUrl, partialKey, "partial");
  const failedPartial = await waitForRun(
    "binny-runs-one",
    partial.runId,
    "failed",
  );
  assert.equal(failedPartial.result?.error?.code, "source_requires_human");
  assert.equal(failedPartial.result?.commits.length, 1);
  const savedCommit = failedPartial.result?.commits[0];
  assert.ok(savedCommit !== undefined);
  assert.equal(savedCommit.items.length, 1);
  const savedItem = savedCommit.items[0];
  assert.ok(savedItem !== undefined);

  const savedCommitResponse = await client.archives.commits[":commitId"].$get({
    param: { commitId: savedCommit.commitId },
  });
  assert.equal(savedCommitResponse.status, 200);
  if (savedCommitResponse.status === 200) {
    const archivedCommit = await savedCommitResponse.json();
    assert.equal(archivedCommit.runId, partial.runId);
    assert.equal(archivedCommit.binId, "binny-runs-one");
    assert.equal(archivedCommit.sourceAdapterVersion, manifest.version);
  }
  const savedItemResponse = await client.archives.items[":itemId"].$get({
    param: { itemId: savedItem.itemId },
    query: {},
  });
  assert.equal(savedItemResponse.status, 200);
  if (savedItemResponse.status === 200) {
    const archivedItem = await savedItemResponse.json();
    assert.equal(
      archivedItem.views[0]?.state.body?.text,
      "受控正文 " + partialKey,
    );
  }

  const invalidOutputKey = "runs-http-invalid-output";
  const invalidOutput = await triggerRun(
    "binny-runs-one",
    runtimeSourceUrl,
    invalidOutputKey,
    invalidOutputKey,
    true,
  );
  await waitForArrival(controlSourceUrl, invalidOutputKey);
  await releaseSource(controlSourceUrl, invalidOutputKey, "material");
  const failedOutput = await waitForRun(
    "binny-runs-one",
    invalidOutput.runId,
    "failed",
  );
  assert.equal(failedOutput.result?.error?.code, "invalid_action_output");
  assert.equal(failedOutput.result?.commits.length, 1);
  const retainedOutputCommit = failedOutput.result?.commits[0];
  assert.ok(retainedOutputCommit !== undefined);
  const retainedOutputCommitResponse = await client.archives.commits[
    ":commitId"
  ].$get({ param: { commitId: retainedOutputCommit.commitId } });
  assert.equal(retainedOutputCommitResponse.status, 200);
  if (retainedOutputCommitResponse.status === 200)
    assert.equal(
      (await retainedOutputCommitResponse.json()).runId,
      invalidOutput.runId,
    );
  const retainedOutputItem = retainedOutputCommit.items[0];
  assert.ok(retainedOutputItem !== undefined);
  const retainedOutputItemResponse = await client.archives.items[
    ":itemId"
  ].$get({ param: { itemId: retainedOutputItem.itemId }, query: {} });
  assert.equal(retainedOutputItemResponse.status, 200);
}

async function verifyDisabledQueueBoundary(
  runtimeSourceUrl: string,
  controlSourceUrl: string,
): Promise<void> {
  const activeKey = "runs-http-active-on-disable";
  const queuedKey = "runs-http-queued-on-disable";
  const active = await triggerRun(
    "binny-runs-one",
    runtimeSourceUrl,
    activeKey,
    "active-on-disable",
  );
  await waitForArrival(controlSourceUrl, activeKey);
  const queued = await triggerRun(
    "binny-runs-one",
    runtimeSourceUrl,
    queuedKey,
    "queued-on-disable",
  );

  const disabled = await client.bins[":binId"].disable.$post({
    param: { binId: "binny-runs-one" },
  });
  assert.equal(disabled.status, 200);
  const disabledRun = await readRun("binny-runs-one", queued.runId);
  assert.equal(disabledRun.status, "failed");
  assert.equal(disabledRun.result?.error?.code, "bin_disabled");
  assert.equal(
    (await sourceStatus(controlSourceUrl)).arrivals.some(
      (arrival) => arrival.gateKey === queuedKey,
    ),
    false,
  );

  const blocked = await client.bins[":binId"].runs.$post({
    param: { binId: "binny-runs-one" },
    json: { action: "collect", params: {} },
  });
  assert.equal(blocked.status, 409);
  if (blocked.status === 409)
    assert.equal((await blocked.json()).error.code, "bin_disabled");

  await releaseSource(controlSourceUrl, activeKey);
  const completedActive = await waitForRun(
    "binny-runs-one",
    active.runId,
    "completed",
  );
  await verifyRunCommit(completedActive);
  const enabled = await client.bins[":binId"].enable.$post({
    param: { binId: "binny-runs-one" },
  });
  assert.equal(enabled.status, 200);
}

async function configureRegisteredBin(binId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await client.bins[":binId"].$get({ param: { binId } });
    if (response.status === 200) {
      const current = await response.json();
      if (Object.keys(current.config).length === 0) {
        assert.equal(current.execution.status, "incompatible");
        const configured = await client.bins[":binId"].$patch({
          param: { binId },
          json: { config: { section: "initial" } },
        });
        assert.equal(configured.status, 200);
        if (configured.status === 200) {
          const bin = await configured.json();
          assert.deepEqual(bin.config, { section: "initial" });
          assert.equal(bin.execution.status, "online");
        }
      } else {
        assert.deepEqual(current.config, { section: "initial" });
        assert.equal(current.execution.status, "online");
      }
      return;
    }
    assert.equal(response.status, 404);
    await delay(100);
  }
  assert.fail(`运行器没有自动登记 bin ${binId}。`);
}

async function main(): Promise<void> {
  await configureRegisteredBin("binny-runs-one");
  await configureRegisteredBin("binny-runs-two");
  await verifyQueuedCancellation();
  await verifyCancellationFencesLateWrites();
  await verifyConcurrentRuns();
  await verifyDynamicValidation(sourceRuntimeUrl);
  await verifyActionValidationSnapshotRace(sourceRuntimeUrl);
  const existingItemId = await verifySerialParallelAndSnapshot(
    sourceRuntimeUrl,
    sourceControlUrl,
  );
  await verifyActionFailures(
    sourceRuntimeUrl,
    sourceControlUrl,
    existingItemId,
  );
  await verifyDisabledQueueBoundary(sourceRuntimeUrl, sourceControlUrl);
  await verifyAvailabilityChecks();
  await verifyOrdinaryAction();
  await verifySchedulesCrud(sourceRuntimeUrl);
  await verifyScheduledReferenceTime(sourceRuntimeUrl, sourceControlUrl);
  process.stdout.write(
    "运行 HTTP 队列、check 诊断、普通动作输出、串行并行、归档约束和错误结果旅程通过。\n",
  );
}

await main();
