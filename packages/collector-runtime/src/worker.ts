import { pathToFileURL } from "node:url";

import { createApiClient } from "@binny/api/client";
import {
  collectorActionResultSchema,
  createCollectorContext,
  collectorManifest,
  isCollectorActionError,
  type CollectorDefinition,
} from "@binny/collector-sdk";
import {
  manualRunExecutionSchema,
  type ManualRunCompletion,
  type ManualRunExecution,
} from "@binny/contracts";

const collectorPath = process.env.BINNY_COLLECTOR_ENTRY ?? "/app/dist/index.js";
const apiUrl = process.env.BINNY_API_URL;
if (apiUrl === undefined)
  throw new Error("缺少 BINNY_API_URL，执行进程无法连接核心。");

const importedCollector = (await import(pathToFileURL(collectorPath).href)) as {
  readonly default?: CollectorDefinition;
  readonly collector?: CollectorDefinition;
};
const loadedCollector =
  importedCollector.default ?? importedCollector.collector;
if (loadedCollector === undefined)
  throw new Error(
    `采集器模块 ${collectorPath} 必须导出 default 或 collector。`,
  );
const activeCollector: CollectorDefinition = loadedCollector;

const client = createApiClient(apiUrl, {
  fetch: (input, init) => {
    const timeout = AbortSignal.timeout(3_000);
    const signal =
      init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
    return fetch(input, { ...init, signal });
  },
});
let cancelled = false;
let actionAbort: AbortController | undefined;

process.once("SIGTERM", () => {
  cancelled = true;
  actionAbort?.abort();
});

function failureFrom(error: unknown) {
  if (isCollectorActionError(error)) return error.failure;
  return {
    code: "collector_execution_failed",
    message: "采集器动作执行失败。",
    impact: "本次运行未能完成。",
    requiresHuman: false,
  } as const;
}

async function executeRun(
  run: ManualRunExecution,
): Promise<ManualRunCompletion> {
  const manifest = collectorManifest(activeCollector);
  const action = activeCollector.actions[run.action];
  if (
    run.collectorId !== manifest.id ||
    run.collectorVersion !== manifest.version ||
    action === undefined
  ) {
    return {
      status: "failed",
      completedScopes: [],
      error: {
        code: "collector_version_unavailable",
        message: "当前运行器没有本次运行要求的采集器版本或动作。",
        impact: "本次运行未执行。",
        suggestion: "部署对应采集器版本后重新触发。",
        requiresHuman: false,
      },
    };
  }

  const parsed = action.params.safeParse(run.params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: "failed",
      completedScopes: [],
      error: {
        code: "invalid_action_parameters",
        message: "本次动作参数不符合当前运行器声明。",
        impact: "本次运行未执行。",
        ...(issue === undefined
          ? {}
          : {
              path: issue.path.map((part) =>
                typeof part === "symbol" ? String(part) : part,
              ),
            }),
        requiresHuman: false,
      },
    };
  }

  actionAbort = new AbortController();
  if (cancelled) actionAbort.abort();
  try {
    const result = await action.execute(
      createCollectorContext(client, {
        binId: run.binId,
        identityId: run.identityId,
        runId: run.runId,
        collectorVersion: run.collectorVersion,
        config: run.config,
        targets: run.targets,
        signal: actionAbort.signal,
      }),
      parsed.data,
    );
    const checked = collectorActionResultSchema.safeParse(result);
    return {
      status: "completed",
      completedScopes: checked.success ? checked.data.completedScopes : [],
    };
  } catch (error) {
    return {
      status: "failed",
      completedScopes: [],
      error: failureFrom(error),
    };
  }
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("执行进程没有与 controller 建立 IPC 通道。"));
      return;
    }
    process.send(JSON.stringify(message), (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
}

process.once("message", (value: unknown) => {
  void (async () => {
    let decoded: unknown = value;
    if (typeof value === "string") {
      try {
        decoded = JSON.parse(value) as unknown;
      } catch {
        decoded = undefined;
      }
    }
    const message =
      typeof decoded === "object" && decoded !== null
        ? (decoded as { readonly type?: unknown; readonly run?: unknown })
        : undefined;
    const checked = manualRunExecutionSchema.safeParse(message?.run);
    if (message?.type !== "execute" || !checked.success) {
      await send({
        type: "completion",
        completion: {
          status: "failed",
          completedScopes: [],
          error: {
            code: "invalid_worker_input",
            message: "controller 发送的运行数据无效。",
            impact: "本次运行未执行。",
            requiresHuman: false,
          },
        },
      });
    } else {
      const completion = await executeRun(checked.data);
      await send({ type: "completion", completion });
    }
    process.disconnect?.();
  })().catch((error: unknown) => {
    process.stderr.write(
      `执行进程无法回传结果：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    process.disconnect?.();
  });
});

await send({ type: "ready", manifest: collectorManifest(activeCollector) });
