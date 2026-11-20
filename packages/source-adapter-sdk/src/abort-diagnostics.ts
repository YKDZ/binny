import type { ManualRunAbortCause } from "@binny/contracts";

import { isSourceAccessBudgetExceededError } from "./source-access-budget.ts";

const actionCancelledSymbol = Symbol.for("binny.sourceAdapter.actionCancelled");
const actionCancelledCode = "binny_run_cancelled";

/** Explicit cancellation reason attached by runtime worker when SIGTERM stops a run. */
export class ActionCancelledError extends Error {
  readonly [actionCancelledSymbol] = true;
  readonly code = actionCancelledCode;

  constructor(message = "Action cancelled by user.") {
    super(message);
    this.name = "AbortError";
  }
}

/** Creates an explicit user-cancellation reason for AbortController.abort(). */
export function createActionCancelledReason(
  message = "Action cancelled by user.",
): ActionCancelledError {
  return new ActionCancelledError(message);
}

/** Checks whether a value carries explicit user-cancellation evidence. */
export function isActionCancelledReason(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (actionCancelledSymbol in value ||
      ("code" in value && value.code === actionCancelledCode))
  );
}

/** Checks whether an error represents a timeout (DOMException TimeoutError or Playwright TimeoutError). */
export function isTimeoutLikeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "TimeoutError") return true;
  return false;
}

/** Checks whether an error represents an abort without assuming its cause. */
export function isAbortLikeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "AbortError") return true;
  if ("code" in error && error.code === "ERR_ABORTED") return true;
  if (error instanceof Error) {
    return /\bERR_ABORTED\b|signal is aborted|This operation was aborted/iu.test(
      error.message,
    );
  }
  return false;
}

function collectCauseChain(root: unknown): readonly unknown[] {
  const items: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = root;
  while (
    current !== undefined &&
    current !== null &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    items.push(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return items;
}

export type ClassifyAbortCauseInput = {
  readonly error?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutSignal?: AbortSignal | undefined;
  readonly requestTimedOut?: boolean | undefined;
  readonly userCancelled?: boolean | undefined;
  readonly budgetExceeded?: boolean | undefined;
};

/**
 * Classifies an abort/timeout/budget failure strictly from concrete runtime evidence.
 * Returns undefined for ordinary non-abort errors (e.g. connection refused or HTTP errors).
 */
export function classifyAbortCause(
  input: ClassifyAbortCauseInput,
): ManualRunAbortCause | undefined {
  const errorChain = collectCauseChain(input.error);
  const signalReasonChain =
    input.signal?.aborted === true
      ? collectCauseChain(input.signal.reason)
      : [];

  if (
    input.userCancelled === true ||
    signalReasonChain.some(isActionCancelledReason) ||
    errorChain.some(isActionCancelledReason)
  ) {
    return "user_cancelled";
  }

  if (
    input.budgetExceeded === true ||
    signalReasonChain.some(isSourceAccessBudgetExceededError) ||
    errorChain.some(isSourceAccessBudgetExceededError)
  ) {
    return "action_budget_exhausted";
  }

  if (
    input.requestTimedOut === true ||
    input.timeoutSignal?.aborted === true ||
    errorChain.some(isTimeoutLikeError)
  ) {
    return "source_request_timeout";
  }

  if (
    errorChain.some(isAbortLikeError) ||
    signalReasonChain.some(isAbortLikeError)
  ) {
    return "unknown";
  }

  return undefined;
}

export type FailureDiagnosticContext = {
  readonly stage?: string | undefined;
  readonly target?: string | undefined;
  readonly abortCause?: ManualRunAbortCause | undefined;
};

/** Error carrying structured failure stage, target, and abortCause for adapter/runtime reporting. */
export class SourceRequestError extends Error {
  readonly stage: string | undefined;
  readonly target: string | undefined;
  readonly abortCause: ManualRunAbortCause | undefined;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    context: FailureDiagnosticContext & {
      readonly statusCode?: number | undefined;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      context.cause === undefined ? undefined : { cause: context.cause },
    );
    this.name = "SourceRequestError";
    this.stage = context.stage;
    this.target = context.target;
    this.abortCause = context.abortCause;
    this.statusCode = context.statusCode;
  }
}

const validAbortCauses = new Set<ManualRunAbortCause>([
  "user_cancelled",
  "source_request_timeout",
  "action_budget_exhausted",
  "unknown",
]);

/** Extracts non-empty diagnostic fields (stage, target, abortCause) from an error or its cause chain. */
export function readFailureDiagnosticContext(
  error: unknown,
): FailureDiagnosticContext {
  let stage: string | undefined;
  let target: string | undefined;
  let abortCause: ManualRunAbortCause | undefined;

  for (const item of collectCauseChain(error)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (
      stage === undefined &&
      typeof record.stage === "string" &&
      record.stage.length > 0
    ) {
      stage = record.stage;
    }
    if (
      target === undefined &&
      typeof record.target === "string" &&
      record.target.length > 0
    ) {
      target = record.target;
    }
    if (
      abortCause === undefined &&
      typeof record.abortCause === "string" &&
      validAbortCauses.has(record.abortCause as ManualRunAbortCause)
    ) {
      abortCause = record.abortCause as ManualRunAbortCause;
    }
  }

  return {
    ...(stage === undefined ? {} : { stage }),
    ...(target === undefined ? {} : { target }),
    ...(abortCause === undefined ? {} : { abortCause }),
  };
}

export const defaultSourceRequestTimeoutMs = 20_000;

export type FetchSourceResponseOptions = {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly stage: string;
  readonly timeoutMs?: number | undefined;
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
};

export type FetchedSourceResponse = {
  readonly status: number;
  readonly ok: boolean;
  readonly url: string;
  readonly headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  cancelBody(): Promise<void>;
};

function throwClassifiedRequestError(
  error: unknown,
  options: {
    readonly url: string;
    readonly signal: AbortSignal;
    readonly timeoutSignal: AbortSignal;
    readonly stage: string;
    readonly timeoutMs: number;
    readonly phase: "request" | "body";
  },
): never {
  const abortCause = classifyAbortCause({
    error,
    signal: options.signal,
    timeoutSignal: options.timeoutSignal,
  });
  if (
    abortCause === "user_cancelled" ||
    abortCause === "action_budget_exhausted"
  ) {
    throw options.signal.reason ?? error;
  }
  const label = options.phase === "request" ? "Request" : "Response body";
  const message =
    abortCause === "source_request_timeout"
      ? `${label} timed out after ${String(options.timeoutMs)}ms for ${options.url}.`
      : abortCause === "unknown"
        ? `${label} aborted for an unknown reason for ${options.url}.`
        : `${label} failed for ${options.url}: ${error instanceof Error ? error.message : String(error)}`;
  throw new SourceRequestError(message, {
    stage: options.stage,
    target: options.url,
    ...(abortCause === undefined ? {} : { abortCause }),
    cause: error,
  });
}

/**
 * Performs an HTTP fetch bounded by a per-request timeout while preserving
 * user cancellation, action budget exhaustion, and timeout diagnostics.
 */
export async function fetchSourceResponse(
  options: FetchSourceResponseOptions,
): Promise<FetchedSourceResponse> {
  const timeoutMs = options.timeoutMs ?? defaultSourceRequestTimeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([options.signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(options.url, {
      method: options.method ?? "GET",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      signal: requestSignal,
    });
  } catch (error) {
    throwClassifiedRequestError(error, {
      url: options.url,
      signal: options.signal,
      timeoutSignal,
      stage: options.stage,
      timeoutMs,
      phase: "request",
    });
  }

  const readText = async (): Promise<string> => {
    try {
      return await response.text();
    } catch (error) {
      throwClassifiedRequestError(error, {
        url: options.url,
        signal: options.signal,
        timeoutSignal,
        stage: options.stage,
        timeoutMs,
        phase: "body",
      });
    }
  };

  return {
    status: response.status,
    ok: response.ok,
    url: response.url,
    headers: response.headers,
    text: readText,
    async json(): Promise<unknown> {
      const bodyText = await readText();
      return JSON.parse(bodyText) as unknown;
    },
    async cancelBody(): Promise<void> {
      await response.body?.cancel();
    },
  };
}
