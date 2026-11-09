import * as z from "zod";

import { postgresTextSchema } from "./postgres-text.ts";

/** Public HTTP route compatibility version, independent of the runtime protocol. */
export const publicApiProtocolVersion = 3;

/** 搜索与聚合输入、输出契约的版本。 */
export const archiveQueryContractVersion = 1;
export const archiveQueryContractPath = "/meta/query";

export const serviceCapabilities = {
  archiveSearch: "archives.search",
  archiveAggregation: "archives.aggregate",
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
