import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import {
  archiveIdentifierSchema,
  archiveResourceMediaTypeSchema,
  archiveResourceMetadataSchema,
  type ArchiveOperation,
  type ArchiveResourceMetadata,
} from "@binny/contracts";
import {
  archiveResources,
  archiveRevisionResources,
  type CancellableQueryExecutor,
  type Database,
} from "@binny/db";
import { and, asc, eq, inArray, lte, notExists, sql } from "drizzle-orm";

import { withArchiveWriteLock } from "./archive-lock.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import {
  assertArchiveQueryActive,
  executeArchiveQueryWithinDeadline,
} from "./archive-query-budget.ts";

type ResourceRow = typeof archiveResources.$inferSelect;
type ResourceAvailabilityRow = Pick<
  ResourceRow,
  "resourceId" | "sha256" | "mediaType" | "byteSize" | "storageKey"
>;
type ResourceAvailabilityQueryRow = {
  readonly resourceId: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteSize: string;
  readonly storageKey: string;
};

type StorageOptions = {
  readonly directory: string;
  readonly unreferencedAgeMs: number;
  readonly cleanupIntervalMs: number;
};

export type ArchiveResourceStorage = {
  readonly upload: (
    body: ReadableStream<Uint8Array>,
    mediaType: string,
  ) => Promise<ArchiveOperation<ArchiveResourceMetadata>>;
  readonly get: (resourceId: string) => Promise<
    ArchiveOperation<{
      readonly metadata: ArchiveResourceMetadata;
      readonly body: ReadableStream<Uint8Array>;
    }>
  >;
  readonly isAvailable: (
    transaction: ArchiveTransaction,
    resourceId: string,
  ) => Promise<boolean>;
  readonly inspectAvailability: (
    resourceIds: readonly string[],
    executeQuery: CancellableQueryExecutor,
    deadline: number,
    signal?: AbortSignal,
  ) => Promise<ReadonlyMap<string, boolean>>;
  readonly collectUnreferencedResources: (
    resourceIds: readonly string[],
  ) => Promise<void>;
  readonly initialize: () => Promise<void>;
  readonly close: () => Promise<void>;
};

const uploadFilePrefix = ".upload-";
const resourceFilePattern = /^[0-9a-f-]{36}\.bin$/u;
const copyChunkSize = 64 * 1024;
// Drizzle 的 inArray 将每个 ID 展开为参数；分批避开 PostgreSQL 单条语句参数上限。
const inArrayChunkSize = 5_000;

function failure<T>(
  status: 400 | 404 | 409 | 503,
  code: "invalid_input" | "resource_not_found" | "resource_storage_unavailable",
  message: string,
  path?: readonly (string | number)[],
): ArchiveOperation<T> {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      ...(path === undefined ? {} : { path: [...path] }),
    },
  };
}

function storageFailure<T>(): ArchiveOperation<T> {
  return failure(
    503,
    "resource_storage_unavailable",
    "归档资源存储暂时不可用。",
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function resourcePath(directory: string, storageKey: string): string {
  return resolve(directory, storageKey + ".bin");
}

function metadataFromRow(
  row: ResourceAvailabilityRow,
): ArchiveResourceMetadata | undefined {
  const size = Number(row.byteSize);
  if (!Number.isSafeInteger(size) || size < 0) return undefined;
  const parsed = archiveResourceMetadataSchema.safeParse({
    resourceId: row.resourceId,
    sha256: row.sha256,
    mediaType: row.mediaType,
    size,
  });
  return parsed.success ? parsed.data : undefined;
}

async function resourceFileIsAvailable(
  directory: string,
  row: ResourceAvailabilityRow,
): Promise<boolean> {
  const metadata = metadataFromRow(row);
  if (metadata === undefined) return false;
  try {
    return (
      (await stat(resourcePath(directory, row.storageKey))).size ===
      metadata.size
    );
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publish(
  temporaryPath: string,
  directory: string,
  storageKey: string,
): Promise<void> {
  await rename(temporaryPath, resourcePath(directory, storageKey));
  await syncDirectory(directory);
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (result.bytesRead === 0) throw new Error("资源文件意外结束。");
    offset += result.bytesRead;
  }
}

async function filesEqual(
  leftPath: string,
  rightPath: string,
  size: number,
): Promise<boolean> {
  let left: FileHandle | undefined;
  let right: FileHandle | undefined;
  try {
    left = await open(leftPath, "r");
    right = await open(rightPath, "r");
    if ((await left.stat()).size !== size || (await right.stat()).size !== size)
      return false;
    for (let position = 0; position < size; position += copyChunkSize) {
      const length = Math.min(copyChunkSize, size - position);
      const leftBuffer = Buffer.allocUnsafe(length);
      const rightBuffer = Buffer.allocUnsafe(length);
      await Promise.all([
        readExactly(left, leftBuffer, length, position),
        readExactly(right, rightBuffer, length, position),
      ]);
      if (!leftBuffer.equals(rightBuffer)) return false;
    }
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  } finally {
    await Promise.all([left?.close(), right?.close()]);
  }
}

async function stageUpload(
  directory: string,
  body: ReadableStream<Uint8Array>,
): Promise<{
  readonly temporaryPath: string;
  readonly sha256: string;
  readonly size: number;
}> {
  const temporaryName = uploadFilePrefix + randomUUID() + ".tmp";
  const temporaryPath = resolve(directory, temporaryName);
  const handle = await open(temporaryPath, "wx", 0o600);
  const reader = body.getReader();
  const digest = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const bytes = Buffer.from(
        result.value.buffer,
        result.value.byteOffset,
        result.value.byteLength,
      );
      digest.update(bytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          size + offset,
        );
        if (written.bytesWritten === 0) {
          throw new Error("无法写入归档资源暂存文件。");
        }
        offset += written.bytesWritten;
      }
      size += bytes.byteLength;
      if (!Number.isSafeInteger(size)) {
        throw new Error("资源字节数超出支持范围。");
      }
    }
    await handle.sync();
    return {
      temporaryPath,
      sha256: digest.digest("hex"),
      size,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
    await handle.close();
  }
}

async function writeStreamToFile(
  directory: string,
  body: ReadableStream<Uint8Array>,
): Promise<{
  readonly temporaryPath: string;
  readonly sha256: string;
  readonly size: number;
}> {
  await mkdir(directory, { recursive: true });
  return await stageUpload(directory, body);
}

export function createArchiveResourceStorage(
  database: Database,
  options: StorageOptions,
): ArchiveResourceStorage {
  const directory = resolve(options.directory);
  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupInFlight: Promise<void> | undefined;

  async function collectUnreferencedResources(
    resourceIds: readonly string[],
  ): Promise<void> {
    const uniqueResourceIds = [
      ...new Set(resourceIds.map((resourceId) => resourceId.toLowerCase())),
    ];
    if (uniqueResourceIds.length === 0) return;

    const deleting = await withArchiveWriteLock(
      database,
      async (transaction) => {
        const rows: ResourceRow[] = [];
        for (
          let offset = 0;
          offset < uniqueResourceIds.length;
          offset += inArrayChunkSize
        ) {
          const resourceIdBatch = uniqueResourceIds.slice(
            offset,
            offset + inArrayChunkSize,
          );
          rows.push(
            ...(await transaction
              .select()
              .from(archiveResources)
              .where(
                and(
                  inArray(archiveResources.resourceId, resourceIdBatch),
                  eq(archiveResources.status, "deleting"),
                  notExists(
                    transaction
                      .select({
                        resourceId: archiveRevisionResources.resourceId,
                      })
                      .from(archiveRevisionResources)
                      .where(
                        eq(
                          archiveRevisionResources.resourceId,
                          archiveResources.resourceId,
                        ),
                      ),
                  ),
                ),
              )),
          );
        }
        return rows;
      },
    );

    let directoryChanged = false;
    for (const row of deleting) {
      await rm(resourcePath(directory, row.storageKey), { force: true });
      directoryChanged = true;
    }
    if (directoryChanged) await syncDirectory(directory);

    await database.transaction(async (transaction) => {
      for (const row of deleting) {
        await transaction.delete(archiveResources).where(
          and(
            eq(archiveResources.resourceId, row.resourceId),
            eq(archiveResources.status, "deleting"),
            notExists(
              transaction
                .select({
                  resourceId: archiveRevisionResources.resourceId,
                })
                .from(archiveRevisionResources)
                .where(
                  eq(
                    archiveRevisionResources.resourceId,
                    archiveResources.resourceId,
                  ),
                ),
            ),
          ),
        );
      }
    });
  }

  async function collectUnreferenced(): Promise<void> {
    const resourceIds = await withArchiveWriteLock(
      database,
      async (transaction) => {
        // 保留 PostgreSQL 墙钟时间与 interval 运算，避免应用主机时钟偏差。
        await transaction
          .update(archiveResources)
          .set({ status: "deleting" })
          .where(
            and(
              eq(archiveResources.status, "ready"),
              lte(
                archiveResources.uploadedAt,
                sql`clock_timestamp() - (${options.unreferencedAgeMs}::double precision * interval '1 millisecond')`,
              ),
              notExists(
                transaction
                  .select({
                    resourceId: archiveRevisionResources.resourceId,
                  })
                  .from(archiveRevisionResources)
                  .where(
                    eq(
                      archiveRevisionResources.resourceId,
                      archiveResources.resourceId,
                    ),
                  ),
              ),
            ),
          );
        const rows = await transaction
          .select({ resourceId: archiveResources.resourceId })
          .from(archiveResources)
          .where(
            and(
              eq(archiveResources.status, "deleting"),
              notExists(
                transaction
                  .select({
                    resourceId: archiveRevisionResources.resourceId,
                  })
                  .from(archiveRevisionResources)
                  .where(
                    eq(
                      archiveRevisionResources.resourceId,
                      archiveResources.resourceId,
                    ),
                  ),
              ),
            ),
          );
        return rows.map(({ resourceId }) => resourceId);
      },
    );
    await collectUnreferencedResources(resourceIds);

    await withArchiveWriteLock(database, async (transaction) => {
      let directoryChanged = false;
      const registered = await transaction
        .select({ storageKey: archiveResources.storageKey })
        .from(archiveResources);
      const registeredKeys = new Set(
        registered.map(({ storageKey }) => storageKey + ".bin"),
      );
      const files = await readdir(directory, { withFileTypes: true });
      for (const file of files) {
        if (
          file.isFile() &&
          resourceFilePattern.test(file.name) &&
          !registeredKeys.has(file.name)
        ) {
          await rm(resolve(directory, file.name), { force: true });
          directoryChanged = true;
        }
      }
      if (directoryChanged) await syncDirectory(directory);
    });
  }

  async function cleanupStagedUploads(): Promise<void> {
    await mkdir(directory, { recursive: true });
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && file.name.startsWith(uploadFilePrefix)) {
        await rm(resolve(directory, file.name), { force: true });
      }
    }
  }

  async function upload(
    body: ReadableStream<Uint8Array>,
    mediaType: string,
  ): Promise<ArchiveOperation<ArchiveResourceMetadata>> {
    const checkedMediaType =
      archiveResourceMediaTypeSchema.safeParse(mediaType);
    if (!checkedMediaType.success) {
      return failure(400, "invalid_input", "媒体类型格式无效。", [
        "content-type",
      ]);
    }

    let staged: Awaited<ReturnType<typeof writeStreamToFile>> | undefined;
    try {
      const stagedUpload = await writeStreamToFile(directory, body);
      staged = stagedUpload;
      return await withArchiveWriteLock(database, async (transaction) => {
        const matching = await transaction
          .select()
          .from(archiveResources)
          .where(
            and(
              eq(archiveResources.sha256, stagedUpload.sha256),
              eq(archiveResources.byteSize, BigInt(stagedUpload.size)),
              eq(archiveResources.status, "ready"),
            ),
          )
          .orderBy(asc(archiveResources.resourceId));
        let missingFile: ResourceRow | undefined;
        for (const row of matching) {
          const path = resourcePath(directory, row.storageKey);
          try {
            const file = await stat(path);
            if (file.size === stagedUpload.size) {
              if (
                await filesEqual(
                  stagedUpload.temporaryPath,
                  path,
                  stagedUpload.size,
                )
              ) {
                const metadata = metadataFromRow(row);
                if (metadata === undefined) {
                  throw new Error("归档资源元信息无效。");
                }
                return {
                  ok: true,
                  value: metadata,
                };
              }
            }
          } catch (error) {
            if (!isMissingFile(error)) throw error;
            missingFile ??= row;
          }
        }

        if (missingFile !== undefined) {
          await publish(
            stagedUpload.temporaryPath,
            directory,
            missingFile.storageKey,
          );
          const metadata = metadataFromRow(missingFile);
          if (metadata === undefined) throw new Error("归档资源元信息无效。");
          return {
            ok: true,
            value: metadata,
          };
        }

        const resourceId = randomUUID();
        const storageKey = randomUUID();
        await publish(stagedUpload.temporaryPath, directory, storageKey);
        const rows = await transaction
          .insert(archiveResources)
          .values({
            resourceId,
            sha256: stagedUpload.sha256,
            mediaType: checkedMediaType.data,
            byteSize: BigInt(stagedUpload.size),
            storageKey,
            status: "ready",
          })
          .returning();
        const row = rows[0];
        if (row === undefined) throw new Error("无法登记归档资源。");
        const metadata = metadataFromRow(row);
        if (metadata === undefined) throw new Error("归档资源元信息无效。");
        return { ok: true, value: metadata };
      });
    } catch {
      return storageFailure();
    } finally {
      if (staged !== undefined) {
        await rm(staged.temporaryPath, { force: true }).catch(() => undefined);
      }
    }
  }

  async function get(resourceId: string): Promise<
    ArchiveOperation<{
      readonly metadata: ArchiveResourceMetadata;
      readonly body: ReadableStream<Uint8Array>;
    }>
  > {
    const checkedId = archiveIdentifierSchema.safeParse(resourceId);
    if (!checkedId.success) {
      return failure(400, "invalid_input", "资源标识格式无效。", [
        "resourceId",
      ]);
    }
    let openedFile: FileHandle | undefined;
    try {
      const result: ArchiveOperation<{
        readonly metadata: ArchiveResourceMetadata;
      }> = await database.transaction(async (transaction) => {
        const rows = await transaction
          .select()
          .from(archiveResources)
          .where(eq(archiveResources.resourceId, checkedId.data))
          .for("share");
        const row = rows[0];
        if (row === undefined || row.status !== "ready") {
          return failure(404, "resource_not_found", "没有找到这个归档资源。", [
            "resourceId",
          ]);
        }
        const metadata = metadataFromRow(row);
        if (metadata === undefined) return storageFailure();
        try {
          openedFile = await open(resourcePath(directory, row.storageKey), "r");
          const fileInfo = await openedFile.stat();
          if (fileInfo.size !== metadata.size) {
            await openedFile.close();
            openedFile = undefined;
            return storageFailure();
          }
        } catch (error) {
          if (openedFile !== undefined) await openedFile.close();
          openedFile = undefined;
          if (isMissingFile(error)) return storageFailure();
          throw error;
        }
        return { ok: true as const, value: { metadata } };
      });
      if (!result.ok) return result;
      const handle = openedFile;
      if (handle === undefined) return storageFailure();
      openedFile = undefined;
      return {
        ok: true,
        value: {
          metadata: result.value.metadata,
          body: Readable.toWeb(
            handle.createReadStream({ autoClose: true }),
          ) as ReadableStream<Uint8Array>,
        },
      };
    } catch {
      if (openedFile !== undefined)
        await openedFile.close().catch(() => undefined);
      return storageFailure();
    }
  }

  async function isAvailable(
    transaction: ArchiveTransaction,
    resourceId: string,
  ): Promise<boolean> {
    const rows = await transaction
      .select()
      .from(archiveResources)
      .where(
        and(
          eq(archiveResources.resourceId, resourceId),
          eq(archiveResources.status, "ready"),
        ),
      );
    const row = rows[0];
    return row !== undefined && (await resourceFileIsAvailable(directory, row));
  }

  async function inspectAvailability(
    resourceIds: readonly string[],
    executeQuery: CancellableQueryExecutor,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, boolean>> {
    // PostgreSQL returns UUID text in lowercase even when the immutable state preserves source casing.
    const uniqueResourceIds = [
      ...new Set(resourceIds.map((resourceId) => resourceId.toLowerCase())),
    ];
    if (uniqueResourceIds.length === 0) return new Map();

    assertArchiveQueryActive(deadline, signal);
    const requestJson = JSON.stringify(uniqueResourceIds);
    const rows = await executeArchiveQueryWithinDeadline(
      executeQuery,
      sql<ResourceAvailabilityQueryRow[]>`
        SELECT
          resource.resource_id::text AS "resourceId",
          resource.sha256 AS "sha256",
          resource.media_type AS "mediaType",
          resource.byte_size::text AS "byteSize",
          resource.storage_key::text AS "storageKey"
        FROM jsonb_array_elements_text(${requestJson}::text::jsonb) AS requested(resource_id)
        INNER JOIN archive_resource AS resource
          ON resource.resource_id = requested.resource_id::uuid
         AND resource.status = 'ready'
      `,
      deadline,
      signal,
    );
    const rowsById = new Map<string, ResourceAvailabilityRow>();
    for (const row of rows) {
      rowsById.set(row.resourceId, {
        resourceId: row.resourceId,
        sha256: row.sha256,
        mediaType: row.mediaType,
        byteSize: BigInt(row.byteSize),
        storageKey: row.storageKey,
      });
    }

    const availability = new Map<string, boolean>();
    for (const resourceId of uniqueResourceIds) {
      assertArchiveQueryActive(deadline, signal);
      const row = rowsById.get(resourceId);
      availability.set(
        resourceId,
        row === undefined
          ? false
          : await resourceFileIsAvailable(directory, row),
      );
      assertArchiveQueryActive(deadline, signal);
    }
    return availability;
  }

  async function initialize(): Promise<void> {
    await mkdir(directory, { recursive: true });
    await cleanupStagedUploads();
    await collectUnreferenced();
    cleanupTimer = setInterval(() => {
      if (cleanupInFlight !== undefined) return;
      cleanupInFlight = collectUnreferenced()
        .catch((error: unknown) => {
          console.error("归档资源清理失败：", error);
        })
        .finally(() => {
          cleanupInFlight = undefined;
        });
    }, options.cleanupIntervalMs);
    cleanupTimer.unref();
  }

  async function close(): Promise<void> {
    if (cleanupTimer !== undefined) clearInterval(cleanupTimer);
    cleanupTimer = undefined;
    await cleanupInFlight;
  }

  return {
    upload,
    get,
    isAvailable,
    inspectAvailability,
    collectUnreferencedResources,
    initialize,
    close,
  };
}
