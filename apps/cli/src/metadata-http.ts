import * as z from "zod";

export const DEFAULT_METADATA_MAX_RETRIES = 2;
export const DEFAULT_METADATA_BASE_DELAY_MS = 100;
export const DEFAULT_METADATA_ATTEMPT_TIMEOUT_MS = 5_000;

export const RETRYABLE_METADATA_HTTP_STATUSES = new Set<number>([
  408, 429, 500, 502, 503, 504,
]);

export const metadataFailureReasonSchema = z.enum([
  "connection_error",
  "timeout",
  "http_status",
  "invalid_json",
  "invalid_contract",
]);

export type MetadataFailureReason = z.infer<typeof metadataFailureReasonSchema>;

/** Internal retry/timeout overrides used by `CliRuntime` (not exposed as CLI flags). */
export type MetadataRetryOptions = {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type ServiceCompatibilityFailureCode =
  | "service_metadata_unavailable"
  | "service_query_contract_unavailable"
  | "incompatible_http_api_protocol"
  | "incompatible_archive_query_contract"
  | "service_capability_unavailable";

export type ServiceCompatibilityFailure = {
  readonly code: ServiceCompatibilityFailureCode;
  readonly message: string;
  readonly reason?: MetadataFailureReason;
  readonly httpStatus?: number;
  readonly attempts?: number;
};

export type MetadataFetchSpec<Document> = {
  readonly failureCode:
    | "service_metadata_unavailable"
    | "service_query_contract_unavailable";
  readonly targetLabel: string;
  readonly endpointPath: string;
  readonly schema: z.ZodType<Document>;
  readonly trailingHint?: string;
};

export type MetadataFetchResult<Document> =
  | { readonly ok: true; readonly document: Document }
  | { readonly ok: false; readonly error: ServiceCompatibilityFailure };

type AttemptOutcome =
  | { readonly kind: "text"; readonly bodyText: string }
  | { readonly kind: "http_status"; readonly status: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "connection_error" };

type RetryableFailureState =
  | { readonly reason: "connection_error" }
  | { readonly reason: "timeout"; readonly timeoutMs: number }
  | { readonly reason: "http_status"; readonly httpStatus: number };

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function formatSchemaIssueSummary(issues: readonly z.core.$ZodIssue[]): string {
  const first = issues[0];
  if (first === undefined) return "schema validation failed";
  const path =
    first.path.length > 0
      ? first.path
          .map((part) => (typeof part === "symbol" ? String(part) : part))
          .join(".")
      : "<root>";
  return `${path}: ${first.message}`;
}

function formatMetadataFailureMessage(
  spec: MetadataFetchSpec<unknown>,
  detail:
    | { readonly reason: "connection_error"; readonly attempts: number }
    | {
        readonly reason: "timeout";
        readonly timeoutMs: number;
        readonly attempts: number;
      }
    | {
        readonly reason: "http_status";
        readonly httpStatus: number;
        readonly attempts: number;
      }
    | { readonly reason: "invalid_json"; readonly attempts: number }
    | {
        readonly reason: "invalid_contract";
        readonly issueSummary: string;
        readonly attempts: number;
      },
): string {
  const attemptNote =
    detail.attempts > 1 ? ` after ${String(detail.attempts)} attempts` : "";
  const suffix =
    spec.trailingHint === undefined ? "." : `; ${spec.trailingHint}.`;
  switch (detail.reason) {
    case "connection_error":
      return `Cannot read ${spec.targetLabel} from ${spec.endpointPath}: connection failed${attemptNote}${suffix}`;
    case "timeout":
      return `Cannot read ${spec.targetLabel} from ${spec.endpointPath}: request timed out after ${String(detail.timeoutMs)}ms${attemptNote}${suffix}`;
    case "http_status":
      return `Cannot read ${spec.targetLabel} from ${spec.endpointPath}: service returned HTTP ${String(detail.httpStatus)}${attemptNote}${suffix}`;
    case "invalid_json":
      return `The service returned invalid JSON for ${spec.targetLabel} from ${spec.endpointPath}${suffix}`;
    case "invalid_contract":
      return `The service returned an invalid ${spec.targetLabel} contract from ${spec.endpointPath} (${detail.issueSummary})${suffix}`;
  }
}

async function executeMetadataAttempt(
  baseFetch: typeof globalThis.fetch,
  requestWithFetch: (
    attemptFetch: typeof globalThis.fetch,
  ) => Promise<Response>,
  attemptTimeoutMs: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  let cleanupTimer: (() => void) | undefined;

  const attemptFetch: typeof globalThis.fetch = (input, init) => {
    const signal =
      init?.signal === undefined || init.signal === null
        ? controller.signal
        : AbortSignal.any([init.signal, controller.signal]);
    return baseFetch(input, { ...init, signal });
  };

  // Race against a timer in addition to aborting the signal so even custom test
  // fetch stubs that ignore `init.signal` cannot hang indefinitely.
  const timeoutGate = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      const timeoutError = new DOMException(
        `Request timed out after ${String(attemptTimeoutMs)}ms`,
        "TimeoutError",
      );
      controller.abort(timeoutError);
      reject(timeoutError);
    }, attemptTimeoutMs);
    cleanupTimer = () => clearTimeout(timer);
  });

  const networkPromise = (async (): Promise<AttemptOutcome> => {
    const response = await requestWithFetch(attemptFetch);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { kind: "http_status", status: response.status };
    }
    // Read the body as text inside the network/timeout guard so JSON syntax
    // errors can be classified separately once body transfer succeeds.
    const bodyText = await response.text();
    return { kind: "text", bodyText };
  })();

  // Prevent an unhandled rejection if the underlying fetch settles after timeoutGate wins.
  networkPromise.catch(() => {});

  try {
    return await Promise.race([networkPromise, timeoutGate]);
  } catch (error) {
    if (timedOut || isTimeoutError(error)) {
      return { kind: "timeout" };
    }
    return { kind: "connection_error" };
  } finally {
    cleanupTimer?.();
  }
}

/**
 * Fetches and validates a metadata or discovery GET endpoint with finite
 * exponential backoff for transient transport/server failures, returning
 * deterministic HTTP, JSON, and schema errors immediately without retrying.
 */
export async function fetchMetadataDocument<Document>(input: {
  readonly fetchImplementation?: typeof globalThis.fetch;
  readonly requestWithFetch: (
    attemptFetch: typeof globalThis.fetch,
  ) => Promise<Response>;
  readonly spec: MetadataFetchSpec<Document>;
  readonly retry?: MetadataRetryOptions;
}): Promise<MetadataFetchResult<Document>> {
  const baseFetch = input.fetchImplementation ?? globalThis.fetch;
  const maxRetries = Math.max(
    0,
    input.retry?.maxRetries ?? DEFAULT_METADATA_MAX_RETRIES,
  );
  const baseDelayMs = Math.max(
    0,
    input.retry?.baseDelayMs ?? DEFAULT_METADATA_BASE_DELAY_MS,
  );
  const attemptTimeoutMs = Math.max(
    1,
    input.retry?.attemptTimeoutMs ?? DEFAULT_METADATA_ATTEMPT_TIMEOUT_MS,
  );
  const sleep =
    input.retry?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const totalAttempts = 1 + maxRetries;
  let lastFailure: RetryableFailureState = { reason: "connection_error" };

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const outcome = await executeMetadataAttempt(
      baseFetch,
      input.requestWithFetch,
      attemptTimeoutMs,
    );

    if (outcome.kind === "text") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(outcome.bodyText) as unknown;
      } catch {
        return {
          ok: false,
          error: {
            code: input.spec.failureCode,
            reason: "invalid_json",
            attempts: attempt,
            message: formatMetadataFailureMessage(input.spec, {
              reason: "invalid_json",
              attempts: attempt,
            }),
          },
        };
      }
      const checked = input.spec.schema.safeParse(parsed);
      if (!checked.success) {
        return {
          ok: false,
          error: {
            code: input.spec.failureCode,
            reason: "invalid_contract",
            attempts: attempt,
            message: formatMetadataFailureMessage(input.spec, {
              reason: "invalid_contract",
              issueSummary: formatSchemaIssueSummary(checked.error.issues),
              attempts: attempt,
            }),
          },
        };
      }
      return { ok: true, document: checked.data };
    }

    if (outcome.kind === "http_status") {
      if (!RETRYABLE_METADATA_HTTP_STATUSES.has(outcome.status)) {
        return {
          ok: false,
          error: {
            code: input.spec.failureCode,
            reason: "http_status",
            httpStatus: outcome.status,
            attempts: attempt,
            message: formatMetadataFailureMessage(input.spec, {
              reason: "http_status",
              httpStatus: outcome.status,
              attempts: attempt,
            }),
          },
        };
      }
      lastFailure = { reason: "http_status", httpStatus: outcome.status };
    } else if (outcome.kind === "timeout") {
      lastFailure = { reason: "timeout", timeoutMs: attemptTimeoutMs };
    } else {
      lastFailure = { reason: "connection_error" };
    }

    if (attempt < totalAttempts) {
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delayMs);
    }
  }

  return {
    ok: false,
    error: {
      code: input.spec.failureCode,
      reason: lastFailure.reason,
      ...(lastFailure.reason === "http_status"
        ? { httpStatus: lastFailure.httpStatus }
        : {}),
      attempts: totalAttempts,
      message: formatMetadataFailureMessage(input.spec, {
        ...lastFailure,
        attempts: totalAttempts,
      }),
    },
  };
}
