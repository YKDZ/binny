import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createApiClient } from "@binny/api/client";
import {
  archiveJsonValueSchema,
  jsonObjectSchema,
  manualRunExecutionSchema,
  type JsonObject,
  type ManualRunCompletion,
  type ManualRunExecution,
} from "@binny/contracts";
import {
  createSourceAdapterContext,
  parseSourceAdapterInput,
  sourceAdapterManifest,
  isSourceAdapterActionError,
  createSourceAccessClient,
  sourceAccessConfigFromAdapterConfig,
  sourceAdapterActionError,
  SourceAccessDeadlineExceededError,
  SourceAccessStateUnavailableError,
  type SourceAccessAcquireInput,
  type SourceAccessLease,
  type SourceAccessResponse,
  type SourceAccessResponseObservation,
  type SourceAccessTransport,
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
type PendingSourceAccess = {
  readonly resolve: (value?: unknown) => void;
  readonly reject: (error: unknown) => void;
};
type PendingAdapterState = {
  readonly resolve: (value?: JsonObject) => void;
  readonly reject: (error: unknown) => void;
};
const pendingSourceAccess = new Map<string, PendingSourceAccess>();
const pendingAdapterState = new Map<string, PendingAdapterState>();

function decodeMessage(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

const sourceAccessTransport: SourceAccessTransport = {
  acquire(input: SourceAccessAcquireInput, signal: AbortSignal) {
    const requestId = randomUUID();
    return new Promise<SourceAccessLease>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException("已取消", "AbortError"));
        return;
      }
      const abort = () => {
        pendingSourceAccess.delete(requestId);
        void send({ type: "source-access-cancel", requestId });
        reject(signal.reason ?? new DOMException("已取消", "AbortError"));
      };
      pendingSourceAccess.set(requestId, {
        resolve: (lease) => {
          signal.removeEventListener("abort", abort);
          if (
            typeof lease !== "object" ||
            lease === null ||
            !("leaseId" in lease) ||
            typeof lease.leaseId !== "string" ||
            !("waitedMs" in lease) ||
            typeof lease.waitedMs !== "number" ||
            !Number.isSafeInteger(lease.waitedMs) ||
            lease.waitedMs < 0
          ) {
            reject(new Error("运行器没有返回来源准入许可。"));
          } else {
            resolve({ leaseId: lease.leaseId, waitedMs: lease.waitedMs });
          }
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      void send({ type: "source-access-acquire", requestId, input }).catch(
        (error: unknown) => {
          pendingSourceAccess.delete(requestId);
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  },
  release(leaseId) {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      pendingSourceAccess.set(requestId, {
        resolve: () => resolve(),
        reject,
      });
      void send({ type: "source-access-release", requestId, leaseId }).catch(
        (error: unknown) => {
          pendingSourceAccess.delete(requestId);
          reject(error);
        },
      );
    });
  },
  observeResponse(
    input: SourceAccessAcquireInput,
    response: SourceAccessResponse,
  ): Promise<SourceAccessResponseObservation> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      pendingSourceAccess.set(requestId, {
        resolve(value) {
          if (
            typeof value !== "object" ||
            value === null ||
            !("status" in value) ||
            (value.status !== 429 && value.status !== 503) ||
            !("observedAtEpochMs" in value) ||
            typeof value.observedAtEpochMs !== "number" ||
            !Number.isSafeInteger(value.observedAtEpochMs) ||
            !("outcome" in value) ||
            (value.outcome !== "cooled" &&
              value.outcome !== "missing" &&
              value.outcome !== "invalid" &&
              value.outcome !== "past") ||
            ("cooldownUntilEpochMs" in value &&
              (typeof value.cooldownUntilEpochMs !== "number" ||
                !Number.isSafeInteger(value.cooldownUntilEpochMs)))
          ) {
            reject(new Error("运行器返回了无效的来源冷却观察。"));
            return;
          }
          resolve(value as SourceAccessResponseObservation);
        },
        reject,
      });
      void send({
        type: "source-access-response",
        requestId,
        input,
        response,
      }).catch((error: unknown) => {
        pendingSourceAccess.delete(requestId);
        reject(error);
      });
    });
  },
};

function requestAdapterState(
  runId: string,
  type: "adapter-state-load" | "adapter-state-save",
  state?: JsonObject,
): Promise<JsonObject | undefined> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    pendingAdapterState.set(requestId, { resolve, reject });
    void send({
      type,
      requestId,
      runId,
      ...(state === undefined ? {} : { state }),
    }).catch((error: unknown) => {
      pendingAdapterState.delete(requestId);
      reject(error);
    });
  });
}

process.on("message", (value: unknown) => {
  const message = decodeMessage(value);
  if (typeof message !== "object" || message === null || !("type" in message))
    return;
  const record = message as Record<string, unknown>;
  if (typeof record.requestId !== "string") return;
  if (record.type === "source-access-granted") {
    const pending = pendingSourceAccess.get(record.requestId);
    if (pending === undefined) {
      if (typeof record.leaseId === "string")
        void send({
          type: "source-access-release",
          requestId: randomUUID(),
          leaseId: record.leaseId,
        });
      return;
    }
    pendingSourceAccess.delete(record.requestId);
    if (
      typeof record.leaseId !== "string" ||
      typeof record.waitedMs !== "number" ||
      !Number.isSafeInteger(record.waitedMs) ||
      record.waitedMs < 0
    ) {
      pending.reject(new Error("运行器返回了无效的来源准入许可。"));
      return;
    }
    pending.resolve({ leaseId: record.leaseId, waitedMs: record.waitedMs });
    return;
  }
  if (record.type === "source-access-released") {
    const pending = pendingSourceAccess.get(record.requestId);
    if (pending === undefined) return;
    pendingSourceAccess.delete(record.requestId);
    pending.resolve();
    return;
  }
  if (record.type === "source-access-response-recorded") {
    const pending = pendingSourceAccess.get(record.requestId);
    if (pending === undefined) return;
    pendingSourceAccess.delete(record.requestId);
    pending.resolve(record.observation);
    return;
  }
  if (record.type === "source-access-rejected") {
    const pending = pendingSourceAccess.get(record.requestId);
    if (pending === undefined) return;
    pendingSourceAccess.delete(record.requestId);
    pending.reject(
      record.code === "source_access_state_unavailable"
        ? new SourceAccessStateUnavailableError()
        : record.code === "source_access_deadline_exceeded"
          ? new SourceAccessDeadlineExceededError()
          : new Error(
              typeof record.message === "string"
                ? record.message
                : "来源准入请求失败。",
            ),
    );
    return;
  }
  if (record.type === "adapter-state-loaded") {
    const pending = pendingAdapterState.get(record.requestId);
    if (pending === undefined) return;
    pendingAdapterState.delete(record.requestId);
    if (record.state === undefined) {
      pending.resolve(undefined);
      return;
    }
    const state = jsonObjectSchema.safeParse(record.state);
    if (!state.success) {
      pending.reject(new Error("运行器返回了无效的信源适配器状态。"));
      return;
    }
    pending.resolve(state.data);
    return;
  }
  if (record.type === "adapter-state-saved") {
    const pending = pendingAdapterState.get(record.requestId);
    if (pending === undefined) return;
    pendingAdapterState.delete(record.requestId);
    pending.resolve();
    return;
  }
  if (record.type === "adapter-state-rejected") {
    const pending = pendingAdapterState.get(record.requestId);
    if (pending === undefined) return;
    pendingAdapterState.delete(record.requestId);
    pending.reject(
      new Error(
        typeof record.message === "string"
          ? record.message
          : "信源适配器状态不可用。",
      ),
    );
  }
});

process.once("SIGTERM", () => {
  cancelled = true;
  actionAbort?.abort();
});

function failureFrom(error: unknown) {
  if (isSourceAdapterActionError(error)) return error.failure;
  if (error instanceof SourceAccessStateUnavailableError) {
    return {
      code: error.code,
      message: error.message,
      impact: "本次运行没有发出来源请求。",
      requiresHuman: false,
    } as const;
  }
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
  runtimeId: string,
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

  const configured = await parseSourceAdapterInput(
    activeSourceAdapter.configSchema,
    run.config,
  );
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

  const parsed = await parseSourceAdapterInput(action.params, run.params);
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
    const accessDeclarations = sourceAccessConfigFromAdapterConfig(
      configured.data,
    );
    const sourceAccess =
      accessDeclarations === undefined
        ? undefined
        : createSourceAccessClient({
            runId: run.runId,
            signal: actionAbort.signal,
            declarations: accessDeclarations,
            transport: sourceAccessTransport,
          });
    const context = {
      binId: run.binId,
      identityId: run.identityId,
      runId: run.runId,
      referenceTime: run.referenceTime,
      sourceAdapterVersion: run.sourceAdapterVersion,
      config: configured.data,
      signal: actionAbort.signal,
      ...(browser === undefined ? {} : { browser }),
      ...(sourceAccess === undefined ? {} : { sourceAccess }),
      persistentState: {
        async load() {
          return await requestAdapterState(run.runId, "adapter-state-load");
        },
        async save(state: JsonObject) {
          await requestAdapterState(run.runId, "adapter-state-save", state);
        },
      },
      report: async (value: unknown) => {
        if (action.report === undefined) {
          throw sourceAdapterActionError({
            code: "action_report_not_declared",
            message: "信源适配器尝试更新未声明的运行报告。",
            impact: "本次运行报告没有更新。",
            requiresHuman: false,
          });
        }

        const parsedReport = await parseSourceAdapterInput(
          action.report,
          value,
        );
        if (!parsedReport.success) {
          const issue = parsedReport.error.issues[0];
          throw sourceAdapterActionError({
            code: "invalid_action_report",
            message: "信源适配器运行报告不符合动作声明。",
            impact: "本次运行报告没有更新。",
            ...(issue === undefined
              ? {}
              : {
                  path: issue.path.map((part) =>
                    typeof part === "symbol" ? String(part) : part,
                  ),
                }),
            requiresHuman: false,
          });
        }

        const jsonReport = jsonObjectSchema.safeParse(parsedReport.data);
        if (!jsonReport.success) {
          throw sourceAdapterActionError({
            code: "invalid_action_report",
            message: "信源适配器运行报告不能通过 JSON 对象接口传递。",
            impact: "本次运行报告没有更新。",
            requiresHuman: false,
          });
        }

        const response = await client.bins[":binId"].runtime.runs[
          ":runId"
        ].report.$post({
          param: { binId: run.binId, runId: run.runId },
          json: { runtimeId, report: jsonReport.data },
        });
        if (response.status === 200) return;
        if (
          response.status === 400 ||
          response.status === 404 ||
          response.status === 409
        ) {
          const result = await response.json();
          throw sourceAdapterActionError({
            code: result.error.code,
            message: result.error.message,
            impact: "本次运行报告没有更新。",
            requiresHuman: false,
          });
        }
        throw new Error("运行报告服务返回了未声明的状态。");
      },
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
            readonly runtimeId?: unknown;
            readonly run?: unknown;
            readonly browser?: unknown;
          })
        : undefined;
    const checked = manualRunExecutionSchema.safeParse(message?.run);
    const runtimeId =
      typeof message?.runtimeId === "string" && message.runtimeId.length > 0
        ? message.runtimeId
        : undefined;
    const checkedBrowser =
      message?.browser === undefined
        ? undefined
        : sourceAdapterBrowserConnectionSchema.safeParse(message.browser);
    if (
      message?.type !== "execute" ||
      !checked.success ||
      runtimeId === undefined ||
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
        runtimeId,
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
