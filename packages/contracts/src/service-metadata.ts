import * as z from "zod";

import { postgresTextSchema } from "./postgres-text.ts";

/**
 * Public HTTP route compatibility version, independent of the runtime protocol.
 * Version 12 adds adapter-declared `searchRelations`, on-demand `related` search
 * requests, and deduplicated `relatedRevisions` to archive query and discovery.
 * Version 13 replaces the noVNC web viewer and WebSocket reverse tunnel with
 * direct native VNC access (one-time password on create, host port when ready).
 * Version 14 removes `suggestion` from public manual-run/archive diagnostics,
 * adds structured `sessionState` and `humanSession` facts on runs, and exposes
 * structured batch-read limit/reference diagnostics.
 */
export const publicApiProtocolVersion = 14;

/** Archive search and batch-read contract version. */
export const archiveQueryContractVersion = 7;
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
