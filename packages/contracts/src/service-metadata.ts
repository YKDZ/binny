import * as z from "zod";

import { postgresTextSchema } from "./postgres-text.ts";

/**
 * Public HTTP route compatibility version, independent of the runtime protocol.
 * Version 9 adds `"runtime_sleeping"` / `"runtime_waking"` run queue reasons
 * and optional `lastWakeError` details on queued runs, run summaries, and bin
 * execution summaries.
 */
export const publicApiProtocolVersion = 9;

/** Archive search and batch-read contract version. */
export const archiveQueryContractVersion = 4;
export const archiveQueryContractPath = "/meta/query";

export const serviceCapabilities = {
  archiveSearch: "archives.search",
  archiveBatchRead: "archives.batch-read",
  archiveQueryContract: "archive.query-contract",
} as const;

/**
 * Compact service discovery metadata. Contract paths point to endpoints that
 * can be fetched separately when their complete declarations are needed.
 */
export const serviceMetadataSchema = z
  .object({
    product: z
      .object({
        name: z.literal("Binny"),
        version: postgresTextSchema.min(1).max(128),
      })
      .strict(),
    protocols: z
      .object({
        httpApi: z.int().positive(),
      })
      .strict(),
    capabilities: z.array(postgresTextSchema.min(1)).min(1),
    contracts: z
      .object({
        archiveQuery: z
          .object({
            version: z.int().positive(),
            path: postgresTextSchema.min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type ServiceMetadata = z.infer<typeof serviceMetadataSchema>;
