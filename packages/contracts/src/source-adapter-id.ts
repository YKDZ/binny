import { postgresTextSchema } from "./postgres-text.ts";

/** Stable identifier schema shared by bin configuration and extension contracts. */
export const sourceAdapterIdSchema = postgresTextSchema
  .min(1, "信源适配器标识不能为空。")
  .max(128, "信源适配器标识不能超过 128 个字符。");
