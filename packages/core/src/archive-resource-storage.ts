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

import { withArchiveWriteLock } from "./archive-lock.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import type { CoreDatabase } from "./database.ts";

type ResourceRow = {
  readonly resource_id: string;
  readonly sha256: string;
  readonly media_type: string;
  readonly byte_size: string;
  readonly storage_key: string;
  readonly status: "ready" | "deleting";
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
  readonly collectUnreferencedResources: (
    resourceIds: readonly string[],
  ) => Promise<void>;
  readonly initialize: () => Promise<void>;
  readonly close: () => Promise<void>;
};

const uploadFilePrefix = ".upload-";
const resourceFilePattern = /^[0-9a-f-]{36}\.bin$/u;
const copyChunkSize = 64 * 1024;

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
  row: ResourceRow,
): ArchiveResourceMetadata | undefined {
  const size = Number(row.byte_size);
  if (!Number.isSafeInteger(size) || size < 0) return undefined;
  const parsed = archiveResourceMetadataSchema.safeParse({
    resourceId: row.resource_id,
    sha256: row.sha256,
    mediaType: row.media_type,
    size,
  });
  return parsed.success ? parsed.data : undefined;
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
  database: CoreDatabase,
  options: StorageOptions,
): ArchiveResourceStorage {
  const directory = resolve(options.directory);
  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupInFlight: Promise<void> | undefined;

  async function collectUnreferencedResources(
    resourceIds: readonly string[],
  ): Promise<void> {
    const uniqueResourceIds = [...new Set(resourceIds)];
    if (uniqueResourceIds.length === 0) return;

    const deleting = await withArchiveWriteLock(
      database,
      async (transaction) => {
        return await transaction<ResourceRow[]>`
        SELECT
          resource_id,
          sha256,
          media_type,
          byte_size::text AS byte_size,
          storage_key,
          status
        FROM archive_resource
        WHERE resource_id = ANY(${transaction.array(uniqueResourceIds, 2950)})
          AND status = 'deleting'
          AND NOT EXISTS (
            SELECT 1
            FROM archive_revision_resource AS reference
            WHERE reference.resource_id = archive_resource.resource_id
          )
      `;
      },
    );

    let directoryChanged = false;
    for (const row of deleting) {
      await rm(resourcePath(directory, row.storage_key), { force: true });
      directoryChanged = true;
    }
    if (directoryChanged) await syncDirectory(directory);

    await database.begin(async (transaction) => {
      for (const row of deleting) {
        await transaction`
          DELETE FROM archive_resource
          WHERE resource_id = ${row.resource_id}
            AND status = 'deleting'
            AND NOT EXISTS (
              SELECT 1
              FROM archive_revision_resource AS reference
              WHERE reference.resource_id = archive_resource.resource_id
            )
        `;
      }
    });
  }

  async function collectUnreferenced(): Promise<void> {
    const resourceIds = await withArchiveWriteLock(
      database,
      async (transaction) => {
        await transaction`
        UPDATE archive_resource
        SET status = 'deleting'
        WHERE status = 'ready'
          AND uploaded_at <= clock_timestamp() - (
            ${options.unreferencedAgeMs}::double precision * INTERVAL '1 millisecond'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM archive_revision_resource AS reference
            WHERE reference.resource_id = archive_resource.resource_id
          )
      `;
        const rows = await transaction<{ readonly resource_id: string }[]>`
        SELECT resource_id
        FROM archive_resource
        WHERE status = 'deleting'
          AND NOT EXISTS (
            SELECT 1
            FROM archive_revision_resource AS reference
            WHERE reference.resource_id = archive_resource.resource_id
          )
      `;
        return rows.map(({ resource_id }) => resource_id);
      },
    );
    await collectUnreferencedResources(resourceIds);

    await withArchiveWriteLock(database, async (transaction) => {
      let directoryChanged = false;
      const registered = await transaction<{ readonly storage_key: string }[]>`
        SELECT storage_key
        FROM archive_resource
      `;
      const registeredKeys = new Set(
        registered.map(({ storage_key }) => storage_key + ".bin"),
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
        const matching = await transaction<ResourceRow[]>`
            SELECT
              resource_id,
              sha256,
              media_type,
              byte_size::text AS byte_size,
              storage_key,
              status
            FROM archive_resource
            WHERE sha256 = ${stagedUpload.sha256}
              AND byte_size = ${stagedUpload.size}::bigint
              AND status = 'ready'
            ORDER BY resource_id
          `;
        let missingFile: ResourceRow | undefined;
        for (const row of matching) {
          const path = resourcePath(directory, row.storage_key);
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
            missingFile.storage_key,
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
        const rows = await transaction<ResourceRow[]>`
            INSERT INTO archive_resource (
              resource_id,
              sha256,
              media_type,
              byte_size,
              storage_key,
              status
            ) VALUES (
              ${resourceId},
              ${stagedUpload.sha256},
              ${checkedMediaType.data},
              ${stagedUpload.size}::bigint,
              ${storageKey},
              'ready'
            )
            RETURNING
              resource_id,
              sha256,
              media_type,
              byte_size::text AS byte_size,
              storage_key,
              status
          `;
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
      }> = await database.begin(async (transaction) => {
        const rows = await transaction<ResourceRow[]>`
          SELECT
            resource_id,
            sha256,
            media_type,
            byte_size::text AS byte_size,
            storage_key,
            status
          FROM archive_resource
          WHERE resource_id = ${checkedId.data}
          FOR SHARE
        `;
        const row = rows[0];
        if (row === undefined || row.status !== "ready") {
          return failure(404, "resource_not_found", "没有找到这个归档资源。", [
            "resourceId",
          ]);
        }
        const metadata = metadataFromRow(row);
        if (metadata === undefined) return storageFailure();
        try {
          openedFile = await open(
            resourcePath(directory, row.storage_key),
            "r",
          );
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
    const rows = await transaction<ResourceRow[]>`
      SELECT
        resource_id,
        sha256,
        media_type,
        byte_size::text AS byte_size,
        storage_key,
        status
      FROM archive_resource
      WHERE resource_id = ${resourceId}
        AND status = 'ready'
    `;
    const row = rows[0];
    if (row === undefined) return false;
    const metadata = metadataFromRow(row);
    if (metadata === undefined) return false;
    try {
      return (
        (await stat(resourcePath(directory, row.storage_key))).size ===
        metadata.size
      );
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
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
    collectUnreferencedResources,
    initialize,
    close,
  };
}
