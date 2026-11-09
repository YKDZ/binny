import { setTimeout as delay } from "node:timers/promises";

import {
  sourceAdapterActionError,
  defineSourceAdapter,
  defineSourceAdapterAction,
  type SourceAdapterArchiveSubmission,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

const configurationSchema = z
  .object({
    section: z.string(),
    label: z
      .string()
      .default("runtime")
      .transform((value) => value + "!"),
  })
  .refine((configuration) => configuration.section !== "forbidden", {
    path: ["section"],
    message: "该板块不可用。",
  });
const extensionsSchema = z
  .object({
    section: z.string().optional(),
    adapterLabel: z.string().optional(),
    actionLabel: z.string().optional(),
    referenceTime: z.string().optional(),
    // Declared JSON slots let archive HTTP fixtures verify extension round trips.
    sourceDetails: z.json().optional(),
    attributes: z.json().optional(),
    media: z
      .array(z.strictObject({ url: z.url(), resourceId: z.uuid() }))
      .optional(),
  })
  .strict();
const sourceResultSchema = z.object({
  disposition: z.enum(["material", "manual", "empty", "partial", "slow"]),
  sourceKey: z.string(),
  title: z.string(),
  text: z.string(),
});
const diagnosticOutputSchema = z.object({
  availability: z.enum(["available", "unavailable", "unknown"]),
  scope: z.array(z.string()),
  basis: z.string(),
  problems: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      impact: z.string(),
      suggestion: z.string(),
      requiresHuman: z.boolean(),
    }),
  ),
});
const collectParamsSchema = z
  .object({
    sourceUrl: z.url(),
    gateKey: z.string().min(1),
    sourceKey: z.string().min(1),
    actionLabel: z
      .string()
      .default("collect")
      .transform((value) => value + "!"),
    invalidOutput: z.boolean().optional(),
    archiveModelVariant: z
      .enum(["baseline", "public-change", "extension-change"])
      .optional(),
    waitBeforeSourceMs: z.int().min(0).max(60_000).optional(),
    waitAfterCommitMs: z.int().min(0).max(60_000).optional(),
    validationDelayMs: z.int().min(0).max(10_000).optional(),
  })
  .refine(
    async ({ gateKey, validationDelayMs }) => {
      if (validationDelayMs !== undefined) await delay(validationDelayMs);
      return gateKey !== "native-refine-reject";
    },
    { path: ["gateKey"], message: "受控动作参数 refine 拒绝该标记。" },
  );

export default defineSourceAdapter({
  id: "binny-runs.manual-run-fixture",
  version: "1.0.0",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema: configurationSchema,
  extensionsSchema,
  actions: {
    check: defineSourceAdapterAction(configurationSchema, extensionsSchema, {
      description: "检查受控信源并返回当前可用性诊断。",
      params: z.object({
        sourceUrl: z.url(),
        gateKey: z.string().min(1),
        sourceKey: z.string().min(1),
        submitArchive: z.boolean().optional(),
      }),
      output: diagnosticOutputSchema,
      async execute(context, params) {
        void context.archive;
        const response = await fetch(
          new URL("/source/check", params.sourceUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              runId: context.runId,
              binId: context.binId,
              gateKey: params.gateKey,
              sourceKey: params.sourceKey,
            }),
            signal: context.signal,
          },
        );
        if (!response.ok) {
          throw sourceAdapterActionError({
            code: "source_check_failed",
            message: "信源没有完成可用性检查。",
            impact: "本次检查未得出诊断结果。",
            suggestion: "检查信源连接后重新触发 check。",
            requiresHuman: false,
          });
        }
        const diagnostic = diagnosticOutputSchema.parse(await response.json());
        if (params.submitArchive === true) {
          await context.archive.submit({
            requestId: "binny-runs:check:" + context.runId,
            items: [
              {
                sourceKey: {
                  namespace: "binny-runs.check-fixture",
                  key: params.sourceKey,
                },
                title: null,
                sourcePublishedAt: null,
                sourceModifiedAt: null,
                extensions: {},
                body: { text: "检查动作提交的归档" },
                capture: {
                  scope: { gateKey: params.gateKey },
                  completeness: "complete",
                  missing: [],
                },
              },
            ],
          });
        }
        return diagnostic;
      },
    }),
    collect: defineSourceAdapterAction(configurationSchema, extensionsSchema, {
      description: "从受控信源解析并提交资料。",
      params: collectParamsSchema,
      output: z.object({ completedScopes: z.array(z.string()) }),
      async execute(context, params) {
        if (params.waitBeforeSourceMs !== undefined)
          await delay(params.waitBeforeSourceMs);
        if (params.archiveModelVariant !== undefined) {
          const publicFactsChanged = params.archiveModelVariant !== "baseline";
          const extensionChange =
            params.archiveModelVariant === "extension-change";
          const submission = {
            requestId: "binny-runs:typed-archive-model:" + context.runId,
            items: [
              {
                sourceKey: {
                  namespace: "binny-runs.typed-archive-model",
                  key: "stable-item",
                },
                title: publicFactsChanged
                  ? "Typed archive public change"
                  : "Typed archive baseline",
                sourcePublishedAt: publicFactsChanged
                  ? { precision: "day", value: "2026-11-08" }
                  : { precision: "month", value: "2026-11" },
                sourceModifiedAt: publicFactsChanged
                  ? {
                      precision: "instant",
                      value: "2026-11-08T12:30:00+01:00",
                      timeZone: "Europe/Paris",
                    }
                  : {
                      precision: "instant",
                      value: "2026-11-08T12:00:00+02:00",
                      timeZone: "+02:00",
                    },
                extensions: {
                  section: extensionChange
                    ? "archive-model-extension-change"
                    : "archive-model",
                  adapterLabel: context.config.label,
                  actionLabel: params.actionLabel,
                },
                body: { text: "Typed archive stable body" },
                capture: {
                  scope: { fixture: "archive-model" },
                  completeness: "complete",
                  missing: [],
                },
              },
            ],
          } satisfies SourceAdapterArchiveSubmission<
            z.output<typeof extensionsSchema>
          >;
          await context.archive.submit(submission);
          return { completedScopes: ["archive/typed-version"] };
        }
        const response = await fetch(
          new URL("/source/collect", params.sourceUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              runId: context.runId,
              binId: context.binId,
              gateKey: params.gateKey,
              sourceKey: params.sourceKey,
            }),
            signal: context.signal,
          },
        );
        if (!response.ok) {
          throw sourceAdapterActionError({
            code: "source_unavailable",
            message: "信源暂时无法提供资料。",
            impact: "本次信源范围未能归档。",
            suggestion: "检查信源连接后重新触发。",
            requiresHuman: false,
          });
        }

        const source = sourceResultSchema.parse(await response.json());
        if (source.disposition === "manual") {
          throw sourceAdapterActionError({
            code: "source_requires_human",
            message: "信源要求人工处理后才能继续读取。",
            impact: "条目 " + source.sourceKey + " 未写入本次归档。",
            path: ["source", "title"],
            suggestion: "请在人工会话中完成信源验证后重新触发。",
            requiresHuman: true,
          });
        }
        if (source.disposition === "empty") {
          throw sourceAdapterActionError({
            code: "source_returned_no_material",
            message: "信源没有返回可归档资料。",
            impact: "条目 " + source.sourceKey + " 保留此前归档状态。",
            suggestion: "检查目标是否仍可访问后重新触发。",
            requiresHuman: false,
          });
        }

        const submission = {
          requestId: "binny-runs:manual-run:" + context.runId,
          items: [
            {
              sourceKey: {
                namespace: "binny-runs.controlled-source",
                key: source.sourceKey,
              },
              title: source.title,
              sourcePublishedAt: { precision: "month", value: "2026-11" },
              sourceModifiedAt: {
                precision: "instant",
                value: context.referenceTime,
                timeZone: "UTC",
              },
              extensions: {
                section: context.config.section,
                adapterLabel: context.config.label,
                actionLabel: params.actionLabel,
                referenceTime: context.referenceTime,
              },
              body: { text: source.text },
              capture: {
                scope: { gateKey: params.gateKey },
                completeness: "complete",
                missing: [],
              },
            },
          ],
        } satisfies SourceAdapterArchiveSubmission<
          z.output<typeof extensionsSchema>
        >;
        await context.archive.submit(submission);
        if (source.disposition === "slow") {
          const marker = await fetch(
            new URL("/control/mark", params.sourceUrl),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                runId: context.runId,
                gateKey: params.gateKey,
                marker: "committed",
              }),
            },
          );
          if (!marker.ok) throw new Error("受控信源没有记录提交标记。");
          await delay(params.waitAfterCommitMs ?? 10_000);
          const lateMarker = await fetch(
            new URL("/control/mark", params.sourceUrl),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                runId: context.runId,
                gateKey: params.gateKey,
                marker: "after-stop-delay",
              }),
            },
          );
          if (!lateMarker.ok) throw new Error("受控信源没有记录延迟标记。");
          await context.archive.submit({
            ...submission,
            requestId: submission.requestId + ":late",
          });
        }
        if (source.disposition === "partial") {
          // 同请求重放证明SDK复用02的幂等提交，再以失败结束本次run。
          await context.archive.submit(submission);
          throw sourceAdapterActionError({
            code: "source_requires_human",
            message: "后续信源范围要求人工处理后才能继续读取。",
            impact:
              "条目 " +
              source.sourceKey +
              " 已保存，后续范围没有写入本次归档。",
            path: ["source", "title"],
            suggestion: "完成信源验证后重新触发新的运行。",
            requiresHuman: true,
          });
        }
        const completedScopes = ["source/" + source.sourceKey];
        return params.invalidOutput === true
          ? { completedScopes: [123] as unknown as string[] }
          : { completedScopes };
      },
    }),
    discover: defineSourceAdapterAction(configurationSchema, extensionsSchema, {
      description: "返回本地受控适配器提供的普通发现结果。",
      params: z.object({
        prefix: z
          .string()
          .default("entry")
          .refine((value) => value.trim().length > 0)
          .transform((value) => value + "!"),
      }),
      output: z.object({ name: z.string() }),
      async execute(context, params) {
        return {
          name: `${params.prefix}:${context.config.label}:${context.config.section}`,
        };
      },
    }),
  },
});
