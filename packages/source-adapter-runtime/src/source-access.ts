import {
  createSourceAccessCoordinator,
  type SourceAccessCoordinator,
  type SourceAccessPersistentState,
} from "@binny/source-adapter-sdk";

export type PersistentSourceAccessOptions = {
  readonly apiUrl: string;
  readonly binId: string;
  readonly runtimeId: string;
  readonly ownerGeneration: string;
};

/** 运行器为 SDK 协调器提供核心数据库持久状态读写。 */
export async function openPersistentSourceAccessCoordinator(
  options: PersistentSourceAccessOptions,
): Promise<SourceAccessCoordinator> {
  const { apiUrl, binId, runtimeId, ownerGeneration } = options;
  return await createSourceAccessCoordinator({
    store: {
      async load(): Promise<unknown> {
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
          const err = new Error("runtime_owner_mismatch");
          (err as { code?: string }).code = "runtime_owner_mismatch";
          throw err;
        }
        if (!response.ok) {
          throw new Error(
            `无法从核心读取来源准入持久状态（HTTP ${response.status}）。`,
          );
        }
        const data = (await response.json()) as { sourceAccess?: unknown };
        return data.sourceAccess ?? undefined;
      },
      async save(state: SourceAccessPersistentState): Promise<void> {
        const putUrl = new URL(
          `/bins/${encodeURIComponent(binId)}/runtime/state`,
          apiUrl,
        );
        const payload: Record<string, unknown> = {
          runtimeId,
          ownerGeneration,
          sourceAccess: state,
        };
        const putResponse = await fetch(putUrl, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
        if (putResponse.status === 409) {
          const err = new Error("runtime_owner_mismatch");
          (err as { code?: string }).code = "runtime_owner_mismatch";
          throw err;
        }
        if (!putResponse.ok) {
          throw new Error(
            `无法向核心保存来源准入持久状态（HTTP ${putResponse.status}）。`,
          );
        }
      },
    },
  });
}
