import * as z from "zod";

const sourceAccessGroupIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const sourceAccessGroupSchema = z
  .object({
    sources: z
      .array(z.enum(["site", "media"]))
      .min(1)
      .max(2)
      .describe("加入同一来源组节流的站点或媒体主动访问类别。"),
    minimumIntervalMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .describe("同组相邻主动请求准入的最小间隔，范围为 0 至 60000 毫秒。"),
    maxConcurrency: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe("同组同时持有的主动请求许可上限，范围为 1 至 8。"),
  })
  .strict()
  .describe(
    "同一來源组内主动访问共享最小间隔与并发上限。站点包含 JSON、显式导航和恢复重读；媒体包含站内及外部媒体下载。",
  );

export const sourceAccessConfigSchema = z
  .object({
    groups: z
      .record(sourceAccessGroupIdSchema, sourceAccessGroupSchema)
      .describe("以适配器稳定来源组标识为键的主动访问来源声明。"),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [groupId, group] of Object.entries(config.groups)) {
      if (new Set(group.sources).size !== group.sources.length) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupId, "sources"],
          message: "来源组内的来源类别不能重复。",
        });
      }
    }
  })
  .describe("信源适配器声明的共享来源访问准入组及有限调度策略。");

export type SourceAccessGroup = z.output<typeof sourceAccessGroupSchema>;
export type SourceAccessConfig = z.output<typeof sourceAccessConfigSchema>;
export type SourceAccessKind = SourceAccessGroup["sources"][number];

export type SourceAccessAcquireInput = {
  readonly runId: string;
  readonly groupId: string;
  readonly source: SourceAccessKind;
  readonly origin: string;
  readonly minimumIntervalMs: number;
  readonly maxConcurrency: number;
  /** 后续冷却或重试策略可提供的最早准入时刻；与最小间隔一次取最大值。 */
  readonly notBeforeEpochMs?: number;
};

export type SourceAccessLease = {
  readonly leaseId: string;
  readonly waitedMs: number;
};

export type SourceAccessTransport = {
  acquire(
    input: SourceAccessAcquireInput,
    signal: AbortSignal,
  ): Promise<SourceAccessLease>;
  release(leaseId: string): Promise<void>;
};

export type SourceAccessRequest = {
  readonly groupId: string;
  readonly source: SourceAccessKind;
  readonly origin: string;
  /** 后续冷却或重试策略可提供的最早准入时刻；不触发第二层等待。 */
  readonly notBeforeEpochMs?: number;
};

export type SourceAccessSnapshot = {
  readonly admittedAttempts: number;
  readonly waitedMs: number;
  readonly bySource: Readonly<Record<SourceAccessKind, number>>;
};

/** 从适配器原生配置读取可发现的来源准入声明；未声明时保持可选。 */
export function sourceAccessConfigFromAdapterConfig(
  config: unknown,
): SourceAccessConfig | undefined {
  if (
    typeof config !== "object" ||
    config === null ||
    !("sourceAccess" in config)
  )
    return undefined;
  const value = config.sourceAccess;
  return value === undefined
    ? undefined
    : sourceAccessConfigSchema.parse(value);
}

export type SourceAccessClient = {
  withAdmission<T>(
    request: SourceAccessRequest,
    operation: () => Promise<T>,
  ): Promise<T>;
  snapshot(): SourceAccessSnapshot;
};

/** 让适配器以来源组声明保护一次主动访问，并保留可解释的准入统计。 */
export function createSourceAccessClient(input: {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly declarations: SourceAccessConfig;
  readonly transport: SourceAccessTransport;
}): SourceAccessClient {
  const groups = input.declarations.groups;

  let admittedAttempts = 0;
  let waitedMs = 0;
  const bySource: Record<SourceAccessKind, number> = { site: 0, media: 0 };

  return {
    async withAdmission<T>(
      request: SourceAccessRequest,
      operation: () => Promise<T>,
    ): Promise<T> {
      const group = groups[request.groupId];
      if (group === undefined || !group.sources.includes(request.source))
        throw new Error("本次主动访问没有声明对应的来源准入组或来源类型。");
      if (
        request.notBeforeEpochMs !== undefined &&
        (!Number.isSafeInteger(request.notBeforeEpochMs) ||
          request.notBeforeEpochMs < 0)
      )
        throw new Error("来源准入最早时刻必须是非负安全整数毫秒时间戳。");
      let origin: string;
      try {
        const parsedOrigin = new URL(request.origin);
        if (
          (parsedOrigin.protocol !== "http:" &&
            parsedOrigin.protocol !== "https:") ||
          parsedOrigin.origin !== request.origin
        )
          throw new Error("invalid origin");
        origin = parsedOrigin.origin;
      } catch {
        throw new Error("来源准入必须使用不含路径的 HTTP(S) origin。");
      }

      const lease = await input.transport.acquire(
        {
          runId: input.runId,
          groupId: request.groupId,
          source: request.source,
          origin,
          minimumIntervalMs: group.minimumIntervalMs,
          maxConcurrency: group.maxConcurrency,
          ...(request.notBeforeEpochMs === undefined
            ? {}
            : { notBeforeEpochMs: request.notBeforeEpochMs }),
        },
        input.signal,
      );
      if (input.signal.aborted) {
        await input.transport.release(lease.leaseId).catch(() => undefined);
        throw input.signal.reason ?? new DOMException("已取消", "AbortError");
      }
      admittedAttempts++;
      waitedMs += lease.waitedMs;
      bySource[request.source]++;

      let result: T | undefined;
      let operationFailed = false;
      let operationFailure: unknown;
      try {
        result = await operation();
      } catch (error) {
        operationFailed = true;
        operationFailure = error;
      }

      let releaseFailed = false;
      let releaseFailure: unknown;
      try {
        await input.transport.release(lease.leaseId);
      } catch (error) {
        releaseFailed = true;
        releaseFailure = error;
      }
      if (operationFailed) throw operationFailure;
      if (releaseFailed) throw releaseFailure;
      return result as T;
    },
    snapshot() {
      return {
        admittedAttempts,
        waitedMs,
        bySource: { ...bySource },
      };
    },
  };
}
