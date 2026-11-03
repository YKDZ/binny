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

import {
  createSourceAccessCoordinator,
  type SourceAccessCoordinator,
  type SourceAccessPersistentState,
} from "@binny/source-adapter-sdk";

/** 运行器为 SDK 协调器提供 owner volume 持久状态读写。 */
export async function openPersistentSourceAccessCoordinator(
  statePath: string,
): Promise<SourceAccessCoordinator> {
  return await createSourceAccessCoordinator({
    store: {
      async load(): Promise<unknown> {
        let saved: string;
        try {
          saved = await readFile(statePath, "utf8");
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) return undefined;
          throw new Error("无法读取来源准入持久状态，运行器不能启动。", {
            cause: error,
          });
        }
        try {
          return JSON.parse(saved) as unknown;
        } catch (error) {
          throw new Error("来源准入持久状态不是有效 JSON，运行器不能启动。", {
            cause: error,
          });
        }
      },
      async save(state: SourceAccessPersistentState): Promise<void> {
        await writeStateAtomically(statePath, state);
      },
    },
  });
}

async function writeStateAtomically(
  statePath: string,
  state: SourceAccessPersistentState,
): Promise<void> {
  const directoryPath = dirname(statePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directoryPath,
    `.source-access-${process.pid}-${randomUUID()}.tmp`,
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
    throw new Error("无法持久写入来源准入时间，拒绝发放访问许可。", {
      cause: error,
    });
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
