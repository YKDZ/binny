import * as z from "zod";

import { postgresTextSchema } from "./postgres-text.ts";

/** 公开 HTTP 路由兼容协议版本，与运行器控制协议分开递增。 */
export const publicApiProtocolVersion = 2;

/** 搜索与聚合输入、输出契约的版本。 */
export const archiveQueryContractVersion = 1;
export const archiveQueryContractPath = "/meta/query";

export const serviceCapabilities = {
  archiveSearch: "archives.search",
  archiveAggregation: "archives.aggregate",
  archiveQueryContract: "archive.query-contract",
} as const;

/** 独立 HTTP 消费者用于判断公开路由兼容性和发现查询契约。 */
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
