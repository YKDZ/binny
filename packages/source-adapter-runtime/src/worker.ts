import { pathToFileURL } from "node:url";

import { createApiClient } from "@binny/api/client";
import {
  archiveJsonValueSchema,
  manualRunExecutionSchema,
  type ManualRunCompletion,
  type ManualRunExecution,
} from "@binny/contracts";
import {
  createSourceAdapterContext,
  sourceAdapterManifest,
  isSourceAdapterActionError,
  type SourceAdapterDefinition,
} from "@binny/source-adapter-sdk";
import {
  sourceAdapterBrowserConnectionSchema,
  type SourceAdapterBrowserConnection,
} from "@binny/source-adapter-sdk";

const sourceAdapterPath =
  process.env.BINNY_SOURCE_ADAPTER_ENTRY ?? "/app/dist/index.js";
const apiUrl = process.env.BINNY_API_URL;
if (apiUrl === undefined)
  throw new Error("缺少 BINNY_API_URL，执行进程无法连接核心。");

const importedSourceAdapter = (await import(
  pathToFileURL(sourceAdapterPath).href
)) as {
  readonly default?: SourceAdapterDefinition;
  readonly sourceAdapter?: SourceAdapterDefinition;
};
const loadedSourceAdapter =
  importedSourceAdapter.default ?? importedSourceAdapter.sourceAdapter;
if (loadedSourceAdapter === undefined)
  throw new Error(
    `信源适配器模块 ${sourceAdapterPath} 必须导出 default 或 sourceAdapter。`,
  );
const activeSourceAdapter: SourceAdapterDefinition = loadedSourceAdapter;

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
  if (isSourceAdapterActionError(error)) return error.failure;
  return {
    code: "source_adapter_execution_failed",
    message: "信源适配器动作执行失败。",
    impact: "本次运行未能完成。",
    requiresHuman: false,
  } as const;
}

async function executeRun(
  run: ManualRunExecution,
  browser: SourceAdapterBrowserConnection | undefined,
): Promise<ManualRunCompletion> {
  const manifest = sourceAdapterManifest(activeSourceAdapter);
  const action = activeSourceAdapter.actions[run.action];
  if (
    run.sourceAdapterId !== manifest.id ||
    run.sourceAdapterVersion !== manifest.version ||
    action === undefined
  ) {
    return {
      status: "failed",
      completedScopes: [],
      error: {
        code: "source_adapter_version_unavailable",
        message: "当前运行器没有本次运行要求的信源适配器版本或动作。",
        impact: "本次运行未执行。",
        suggestion: "部署对应信源适配器版本后重新触发。",
        requiresHuman: false,
      },
    };
  }

  const configured = activeSourceAdapter.configSchema.safeParse(run.config);
  if (!configured.success) {
    const issue = configured.error.issues[0];
    return {
      status: "failed",
      completedScopes: [],
      error: {
        code: "invalid_configuration",
        message: "本次运行配置不符合当前信源适配器声明。",
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
    const context = {
      binId: run.binId,
      identityId: run.identityId,
      runId: run.runId,
      sourceAdapterVersion: run.sourceAdapterVersion,
      config: configured.data,
      signal: actionAbort.signal,
      ...(browser === undefined ? {} : { browser }),
    };
    const result = await action.execute(
      createSourceAdapterContext(client, context),
      parsed.data,
    );
    const checked = action.output.safeParse(result);
    if (!checked.success) {
      return {
        status: "failed",
        completedScopes: [],
        error: {
          code: "invalid_action_output",
          message: "信源适配器动作输出不符合声明。",
          impact: "本次运行失败；已提交的归档资料仍然保留。",
          requiresHuman: false,
        },
      };
    }
    const jsonOutput = archiveJsonValueSchema.safeParse(checked.data);
    if (!jsonOutput.success) {
      return {
        status: "failed",
        completedScopes: [],
        error: {
          code: "invalid_action_output",
          message: "信源适配器动作输出不能通过 JSON 接口传递。",
          impact: "本次运行失败；已提交的归档资料仍然保留。",
          requiresHuman: false,
        },
      };
    }
    return { status: "completed", output: jsonOutput.data };
  } catch (error) {
    const completedScopes =
      isSourceAdapterActionError(error) && Array.isArray(error.completedScopes)
        ? error.completedScopes.filter(
            (scope): scope is string => typeof scope === "string",
          )
        : [];
    return {
      status: "failed",
      completedScopes,
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
        ? (decoded as {
            readonly type?: unknown;
            readonly run?: unknown;
            readonly browser?: unknown;
          })
        : undefined;
    const checked = manualRunExecutionSchema.safeParse(message?.run);
    const checkedBrowser =
      message?.browser === undefined
        ? undefined
        : sourceAdapterBrowserConnectionSchema.safeParse(message.browser);
    if (
      message?.type !== "execute" ||
      !checked.success ||
      (message.browser !== undefined && !checkedBrowser?.success) ||
      (activeSourceAdapter.environment.browser.required &&
        !checkedBrowser?.success)
    ) {
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
      const completion = await executeRun(
        checked.data,
        checkedBrowser?.success === true ? checkedBrowser.data : undefined,
      );
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

await send({
  type: "ready",
  manifest: sourceAdapterManifest(activeSourceAdapter),
});
