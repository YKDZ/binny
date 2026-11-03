import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { jsonObjectSchema, type JsonObject } from "@binny/contracts";
import type { ZodType } from "zod";

/** 每个运行器 owner volume 上唯一的一份信源适配器状态。 */
export type PersistentSourceAdapterState = {
  snapshot(): JsonObject | undefined;
  replace(value: unknown): Promise<void>;
};

export class PersistentSourceAdapterStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistentSourceAdapterStateError";
  }
}

export async function openPersistentSourceAdapterState(
  statePath: string,
  stateSchema?: ZodType,
): Promise<PersistentSourceAdapterState> {
  let state: JsonObject | undefined;
  try {
    const encoded = await readFile(statePath, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded) as unknown;
    } catch (error) {
      throw new PersistentSourceAdapterStateError(
        "信源适配器持久状态不是有效 JSON。",
        { cause: error },
      );
    }
    state = parsePersistentState(decoded, stateSchema);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      if (error instanceof PersistentSourceAdapterStateError) throw error;
      throw new PersistentSourceAdapterStateError(
        "无法读取信源适配器持久状态。",
        { cause: error },
      );
    }
  }

  return {
    snapshot() {
      return state === undefined ? undefined : structuredClone(state);
    },
    async replace(value) {
      const checked = parsePersistentState(value, stateSchema);
      await writeStateAtomically(statePath, checked);
      state = checked;
    },
  };
}

function parsePersistentState(
  value: unknown,
  stateSchema: ZodType | undefined,
): JsonObject {
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

async function writeStateAtomically(
  statePath: string,
  state: JsonObject,
): Promise<void> {
  const directoryPath = dirname(statePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directoryPath,
    `.adapter-state-${process.pid}-${randomUUID()}.tmp`,
  );
  let file: FileHandle | undefined;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, statePath);
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (file !== undefined) await file.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new PersistentSourceAdapterStateError(
      "无法持久保存信源适配器状态。",
      { cause: error },
    );
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
