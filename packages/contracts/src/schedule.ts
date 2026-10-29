import * as z from "zod";

import {
  binIdSchema,
  collectorActionNameSchema,
  jsonObjectSchema,
} from "./bin-configuration.ts";
import {
  postgresTextSchema,
  toPostgresJsonSchema,
  withPostgresJsonSchemaProjection,
} from "./postgres-text.ts";

const scheduleIdSchema = z.string().uuid();

/** 按 cron-parser 的 strict 规则解析（包括原生宏），并要求调用方声明 IANA 时区。 */
export const scheduleCreateInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      expression: postgresTextSchema.min(1).max(256),
      timeZone: postgresTextSchema.min(1).max(128),
      action: collectorActionNameSchema,
      params: jsonObjectSchema,
      enabled: z.boolean().optional(),
    })
    .strict(),
);

export const scheduleUpdateInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      expression: postgresTextSchema.min(1).max(256).optional(),
      timeZone: postgresTextSchema.min(1).max(128).optional(),
      action: collectorActionNameSchema.optional(),
      params: jsonObjectSchema.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: "至少提供一个需要修改的字段。",
    }),
);

export const scheduleLastErrorSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      code: postgresTextSchema.min(1).max(128),
      message: postgresTextSchema.min(1),
      path: z.array(z.union([postgresTextSchema, z.number()])).optional(),
    })
    .strict(),
);

export const scheduleSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      scheduleId: scheduleIdSchema,
      binId: binIdSchema,
      expression: postgresTextSchema.min(1).max(256),
      timeZone: postgresTextSchema.min(1).max(128),
      action: collectorActionNameSchema,
      params: jsonObjectSchema,
      enabled: z.boolean(),
      nextDueAt: z.iso.datetime(),
      lastError: scheduleLastErrorSchema.optional(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .strict(),
);

export const scheduleDeleteResultSchema = z
  .object({ removed: z.literal(true), scheduleId: scheduleIdSchema })
  .strict();

export const scheduleErrorSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      error: z
        .object({
          code: z.enum([
            "invalid_input",
            "bin_not_found",
            "schedule_not_found",
            "invalid_schedule_expression",
            "invalid_time_zone",
            "action_not_found",
            "invalid_action_parameters",
          ]),
          message: postgresTextSchema,
          path: z.array(z.union([z.string(), z.number()])).optional(),
        })
        .strict(),
    })
    .strict(),
);

/**
 * nextDueAt 是绝对时刻，表达式按所声明的 IANA 时区解释。bin 停用时不创建
 * 计划运行；到期点仍推进并在 lastError 中记录原因。
 */
export type Schedule = z.infer<typeof scheduleSchema>;
export type ScheduleCreateInput = z.infer<typeof scheduleCreateInputSchema>;
export type ScheduleUpdateInput = z.infer<typeof scheduleUpdateInputSchema>;
export type ScheduleLastError = z.infer<typeof scheduleLastErrorSchema>;
export type ScheduleApiError = z.infer<typeof scheduleErrorSchema>["error"];
export type ScheduleOperation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 404 | 409;
      readonly error: ScheduleApiError;
    };

export type ScheduleOperations = {
  listSchedules(binId: string): Promise<ScheduleOperation<readonly Schedule[]>>;
  getSchedule(
    binId: string,
    scheduleId: string,
  ): Promise<ScheduleOperation<Schedule>>;
  /** 使用 cron-parser 的 strict 解析规则（包括原生宏）；首次到期点从创建时刻之后计算。 */
  createSchedule(
    binId: string,
    input: ScheduleCreateInput,
  ): Promise<ScheduleOperation<Schedule>>;
  /** 修改会从当前时刻重算 nextDueAt，不补发编辑期间错过的点。 */
  updateSchedule(
    binId: string,
    scheduleId: string,
    input: ScheduleUpdateInput,
  ): Promise<ScheduleOperation<Schedule>>;
  /**
   * 延迟扫描或重启后，只为最早尚未处理的到期点创建一次运行，
   * 其余错过点合并；nextDueAt 前进到扫描时刻之后的第一个匹配点。
   * 计划停用期间不创建运行；停用和重新启用都会从当前时刻重算 nextDueAt，
   * 不补发停用期间的到期点。
   */
  setScheduleEnabled(
    binId: string,
    scheduleId: string,
    enabled: boolean,
  ): Promise<ScheduleOperation<Schedule>>;
  deleteSchedule(
    binId: string,
    scheduleId: string,
  ): Promise<ScheduleOperation<z.infer<typeof scheduleDeleteResultSchema>>>;
};

export const scheduleApiSchemas = {
  create: toPostgresJsonSchema(scheduleCreateInputSchema, "input"),
  update: toPostgresJsonSchema(scheduleUpdateInputSchema, "input"),
  schedule: toPostgresJsonSchema(scheduleSchema, "output"),
  error: toPostgresJsonSchema(scheduleErrorSchema, "output"),
};
