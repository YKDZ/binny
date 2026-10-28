import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import * as z from "zod";

const feedEntryStateSchema = z
  .object({
    identity: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    pendingMedia: z.boolean(),
  })
  .strict();

const feedStateSchema = z
  .object({
    version: z.literal(1),
    feedUrl: z.url(),
    etag: z.string().optional(),
    lastModified: z.string().optional(),
    refreshStaticPages: z.boolean().default(false),
    entries: z.array(feedEntryStateSchema),
  })
  .strict();

export type FeedEntryState = z.infer<typeof feedEntryStateSchema>;
export type FeedState = z.infer<typeof feedStateSchema>;

export function createFeedState(feedUrl: string): FeedState {
  return {
    version: 1,
    feedUrl,
    refreshStaticPages: false,
    entries: [],
  };
}

export async function readFeedState(
  directory: string,
  feedId: string,
  feedUrl: string,
): Promise<FeedState> {
  const path = join(directory, `${feedId}.json`);
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return createFeedState(feedUrl);
    }
    throw new Error(`无法读取 RSS feed「${feedId}」的持久增量状态。`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(
      `RSS feed「${feedId}」的持久增量状态不是有效 JSON；保留原状态供诊断。`,
      { cause: error },
    );
  }
  const checked = feedStateSchema.safeParse(value);
  if (!checked.success) {
    throw new Error(
      `RSS feed「${feedId}」的持久增量状态格式无效；保留原状态供诊断。`,
    );
  }
  return checked.data;
}

export function upsertFeedEntry(
  state: FeedState,
  entry: FeedEntryState,
): FeedState {
  const entries = state.entries.filter(
    ({ identity }) => identity !== entry.identity,
  );
  entries.push(entry);
  return { ...state, entries };
}

export async function writeFeedState(
  directory: string,
  feedId: string,
  state: FeedState,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${feedId}.json`);
  const temporaryPath = join(directory, `.${feedId}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(JSON.stringify(state), "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(`无法保存 RSS feed「${feedId}」的持久增量状态。`, {
      cause: error,
    });
  }
}

export function hasPendingMedia(state: FeedState): boolean {
  return state.entries.some(({ pendingMedia }) => pendingMedia);
}
