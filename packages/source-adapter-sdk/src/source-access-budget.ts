import { SourceAccessDeadlineExceededError } from "./source-access.ts";
import type {
  SourceAccessClient,
  SourceAccessClock,
  SourceAccessRequest,
  SourceAccessSnapshot,
} from "./source-access.ts";

const systemClock: SourceAccessClock = {
  epochNow: () => performance.timeOrigin + performance.now(),
  monotonicNow: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export type SourceAccessBudgetStopReason =
  | "request-limit"
  | "elapsed-time-limit"
  | "wait-exceeds-budget";

export class SourceAccessBudgetExceededError extends Error {
  readonly reason: SourceAccessBudgetStopReason;

  constructor(reason: SourceAccessBudgetStopReason, options?: ErrorOptions) {
    super(
      reason === "request-limit"
        ? "本轮主动请求预算已用尽。"
        : reason === "wait-exceeds-budget"
          ? "本轮剩余时间不足以等待来源准入。"
          : "本轮来源访问耗时预算已用尽。",
      options,
    );
    this.name = "SourceAccessBudgetExceededError";
    this.reason = reason;
  }
}

export type SourceAccessBudgetSnapshot = {
  readonly maxRequests: number;
  readonly maxElapsedMs: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly stopReason?: SourceAccessBudgetStopReason;
};

export type SourceAccessBudgetClient = SourceAccessClient & {
  readonly signal: AbortSignal;
  remainingMs(): number;
  budgetSnapshot(): SourceAccessBudgetSnapshot;
  close(): void;
};

/**
 * 为一次动作执行限制主动请求数量和总耗时，准入等待仍由原客户端负责。
 * 调用后立即开始耗时预算；每次准入先预留请求额度，再等待实际许可。
 */
export function createSourceAccessBudget(input: {
  readonly client: SourceAccessClient;
  readonly signal: AbortSignal;
  readonly clock?: SourceAccessClock;
  readonly maxRequests: number;
  readonly maxElapsedMs: number;
}): SourceAccessBudgetClient {
  if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests < 1)
    throw new RangeError("单轮主动请求上限必须是正安全整数。");
  if (!Number.isSafeInteger(input.maxElapsedMs) || input.maxElapsedMs < 1)
    throw new RangeError("单轮耗时上限必须是正安全整数毫秒。");

  const clock = input.clock ?? systemClock;
  const startedAt = clock.monotonicNow();
  if (!Number.isFinite(startedAt))
    throw new Error("单轮预算时钟没有返回有效的单调时间。");

  const budgetController = new AbortController();
  const signal = AbortSignal.any([input.signal, budgetController.signal]);
  let stopReason: SourceAccessBudgetStopReason | undefined;
  let reservedRequests = 0;
  let closed = false;
  let timer: unknown;

  const stop = (reason: SourceAccessBudgetStopReason) => {
    if (stopReason !== undefined || closed) return;
    stopReason = reason;
    budgetController.abort(new SourceAccessBudgetExceededError(stopReason));
  };

  const stopForElapsedTime = () => stop("elapsed-time-limit");

  const elapsedMs = () => Math.max(0, clock.monotonicNow() - startedAt);

  const remainingMs = () => {
    const remaining = Math.max(0, input.maxElapsedMs - elapsedMs());
    if (remaining <= 0) stopForElapsedTime();
    return Math.ceil(remaining);
  };

  const budgetSnapshot = (): SourceAccessBudgetSnapshot => {
    const remaining = remainingMs();
    return {
      maxRequests: input.maxRequests,
      maxElapsedMs: input.maxElapsedMs,
      elapsedMs: Math.ceil(elapsedMs()),
      remainingMs: remaining,
      ...(stopReason === undefined ? {} : { stopReason }),
    };
  };

  timer = clock.setTimer(stopForElapsedTime, input.maxElapsedMs);

  return {
    signal,
    remainingMs,
    budgetSnapshot,
    snapshot(): SourceAccessSnapshot {
      return input.client.snapshot();
    },
    async observeResponse(request, response) {
      return await input.client.observeResponse(request, response);
    },
    async withAdmission<T>(
      request: SourceAccessRequest,
      operation: () => Promise<T>,
    ): Promise<T> {
      const remaining = remainingMs();
      if (signal.aborted)
        throw signal.reason ?? new DOMException("已取消", "AbortError");

      const admittedAttempts = input.client.snapshot().admittedAttempts;
      if (admittedAttempts + reservedRequests >= input.maxRequests) {
        stop("request-limit");
        throw new SourceAccessBudgetExceededError("request-limit");
      }

      reservedRequests++;
      let operationStarted = false;
      const deadlineEpochMs = Math.floor(clock.epochNow() + remaining);
      if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs < 0) {
        reservedRequests--;
        throw new Error("来源访问预算时钟没有返回有效的 epoch 时间。");
      }

      try {
        return await input.client.withAdmission(
          request,
          async () => {
            reservedRequests--;
            operationStarted = true;
            if (signal.aborted)
              throw signal.reason ?? new DOMException("已取消", "AbortError");
            return await operation();
          },
          { signal, deadlineEpochMs },
        );
      } catch (error) {
        if (
          error instanceof SourceAccessDeadlineExceededError ||
          (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "source_access_deadline_exceeded")
        ) {
          stop("wait-exceeds-budget");
          throw new SourceAccessBudgetExceededError("wait-exceeds-budget", {
            cause: error,
          });
        }
        throw error;
      } finally {
        if (!operationStarted) reservedRequests--;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      clock.clearTimer(timer);
      if (!signal.aborted)
        budgetController.abort(
          new DOMException("单轮来源访问作用域已关闭。", "AbortError"),
        );
    },
  };
}
