import {
  classifyAbortCause,
  SourceRequestError,
} from "@binny/source-adapter-sdk";

const defaultQoderFetchTimeoutMs = 20_000;

/** Checks whether a response text is an HTML SPA shell or error page instead of markdown. */
export function isHtmlSpaOrError(text: string): boolean {
  if (/<(!doctype\s+html|html|head)[\s>]/iu.test(text)) {
    if (/<div\s+id=["'](root|app|__next)["']\s*>\s*<\/div>/iu.test(text)) {
      return true;
    }
    if (
      /<title[^>]*>.*?(404|not\s+found|error|forbidden|页面不存在|错误).*?<\/title>/iu.test(
        text,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Fetches a Qoder text or HTML document with an explicit per-request timeout,
 * attaching stage, target, and evidence-based abortCause on failure.
 */
export async function fetchQoderDocument(options: {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly stage: string;
  readonly timeoutMs?: number;
  readonly accept?: string;
  readonly userAgent?: string;
  readonly rejectHtmlSpaOrError?: boolean;
}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? defaultQoderFetchTimeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([options.signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(options.url, {
      method: "GET",
      headers: {
        accept: options.accept ?? "text/markdown, text/plain, */*",
        "user-agent": options.userAgent ?? "Binny SourceAdapter/1.0",
      },
      signal: requestSignal,
    });
  } catch (error) {
    const abortCause = classifyAbortCause({
      error,
      signal: options.signal,
      timeoutSignal,
    });
    if (
      abortCause === "user_cancelled" ||
      abortCause === "action_budget_exhausted"
    ) {
      throw options.signal.reason ?? error;
    }
    const message =
      abortCause === "source_request_timeout"
        ? `Fetch timed out after ${String(timeoutMs)}ms for ${options.url}.`
        : abortCause === "unknown"
          ? `Fetch aborted for an unknown reason for ${options.url}.`
          : `Failed to fetch ${options.url}: ${error instanceof Error ? error.message : String(error)}`;
    throw new SourceRequestError(message, {
      stage: options.stage,
      target: options.url,
      ...(abortCause === undefined ? {} : { abortCause }),
      cause: error,
    });
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceRequestError(
      `Fetch failed: ${options.url} returned HTTP ${String(response.status)}`,
      {
        stage: options.stage,
        target: options.url,
        statusCode: response.status,
      },
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const abortCause = classifyAbortCause({
      error,
      signal: options.signal,
      timeoutSignal,
    });
    if (
      abortCause === "user_cancelled" ||
      abortCause === "action_budget_exhausted"
    ) {
      throw options.signal.reason ?? error;
    }
    const message =
      abortCause === "source_request_timeout"
        ? `Response body timed out after ${String(timeoutMs)}ms for ${options.url}.`
        : abortCause === "unknown"
          ? `Response body aborted for an unknown reason for ${options.url}.`
          : `Failed to read response from ${options.url}: ${error instanceof Error ? error.message : String(error)}`;
    throw new SourceRequestError(message, {
      stage: options.stage,
      target: options.url,
      ...(abortCause === undefined ? {} : { abortCause }),
      cause: error,
    });
  }

  if (options.rejectHtmlSpaOrError === true && isHtmlSpaOrError(text)) {
    throw new SourceRequestError(
      `Fetch failed: ${options.url} returned an HTML SPA shell or error page instead of markdown`,
      {
        stage: options.stage,
        target: options.url,
      },
    );
  }

  return text;
}
