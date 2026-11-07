import { jsonObjectSchema, type JsonObject } from "@binny/contracts";
import type { ZodType } from "zod";

/** 每个运行器 owner 上唯一的一份信源适配器状态。 */
export type PersistentSourceAdapterState = {
  snapshot(): JsonObject | undefined;
  load(): Promise<JsonObject | undefined>;
  replace(value: unknown): Promise<void>;
};

export class PersistentSourceAdapterStateError extends Error {
  readonly code?: string | undefined;
  constructor(
    message: string,
    options?: ErrorOptions & { readonly code?: string | undefined },
  ) {
    super(message, options);
    this.name = "PersistentSourceAdapterStateError";
    this.code =
      options?.code ??
      (message === "runtime_owner_mismatch"
        ? "runtime_owner_mismatch"
        : undefined);
  }
}

export type PersistentSourceAdapterStateOptions = {
  readonly apiUrl: string;
  readonly binId: string;
  readonly runtimeId: string;
  readonly ownerGeneration: string;
};

export async function openPersistentSourceAdapterState(
  options: PersistentSourceAdapterStateOptions,
  stateSchema?: ZodType,
): Promise<PersistentSourceAdapterState> {
  const { apiUrl, binId, runtimeId, ownerGeneration } = options;
  let state: JsonObject | undefined;

  async function fetchState(): Promise<JsonObject | undefined> {
    const url = new URL(
      `/bins/${encodeURIComponent(binId)}/runtime/state`,
      apiUrl,
    );
    url.searchParams.set("runtimeId", runtimeId);
    url.searchParams.set("ownerGeneration", ownerGeneration);

    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });

    if (response.status === 409) {
      throw new PersistentSourceAdapterStateError("runtime_owner_mismatch", {
        code: "runtime_owner_mismatch",
      });
    }
    if (!response.ok) {
      throw new PersistentSourceAdapterStateError(
        `无法从核心读取信源适配器持久状态（HTTP ${response.status}）。`,
      );
    }

    const data = (await response.json()) as {
      persistentState?: unknown;
    };
    if (data.persistentState !== undefined && data.persistentState !== null) {
      state = parsePersistentState(data.persistentState, stateSchema);
    } else {
      state = undefined;
    }
    return state === undefined ? undefined : structuredClone(state);
  }

  await fetchState();

  return {
    snapshot() {
      return state === undefined ? undefined : structuredClone(state);
    },
    async load() {
      return await fetchState();
    },
    async replace(value) {
      const checked = parsePersistentState(value, stateSchema);
      const putUrl = new URL(
        `/bins/${encodeURIComponent(binId)}/runtime/state`,
        apiUrl,
      );
      const putResponse = await fetch(putUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtimeId,
          ownerGeneration,
          persistentState: checked,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (putResponse.status === 409) {
        throw new PersistentSourceAdapterStateError("runtime_owner_mismatch", {
          code: "runtime_owner_mismatch",
        });
      }
      if (!putResponse.ok) {
        throw new PersistentSourceAdapterStateError(
          `无法向核心保存信源适配器持久状态（HTTP ${putResponse.status}）。`,
        );
      }
      state = checked;
    },
  };
}

function parsePersistentState(
  value: unknown,
  stateSchema: ZodType | undefined,
): JsonObject {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).status === "unavailable"
  ) {
    const reason = (value as Record<string, unknown>).reason;
    throw new PersistentSourceAdapterStateError(
      `信源适配器持久状态不可用：${typeof reason === "string" ? reason : "unavailable"}`,
    );
  }
  const declared = stateSchema?.safeParse(value);
  if (declared !== undefined && !declared.success)
    throw new PersistentSourceAdapterStateError(
      "信源适配器持久状态不符合其原生 schema。",
      { cause: declared.error },
    );
  const checked = jsonObjectSchema.safeParse(
    declared === undefined ? value : declared.data,
  );
  if (!checked.success)
    throw new PersistentSourceAdapterStateError(
      "信源适配器持久状态必须是 JSON 对象。",
      { cause: checked.error },
    );
  return checked.data;
}
