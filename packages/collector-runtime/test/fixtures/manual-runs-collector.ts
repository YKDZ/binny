import {
  collectorActionError,
  defineCollector,
  defineCollectorAction,
  type CollectorArchiveSubmission,
} from "@binny/collector-sdk";
import { z } from "zod";

const configurationSchema = z.object({ section: z.string() });
const sourceResultSchema = z.object({
  disposition: z.enum(["material", "manual", "empty", "partial"]),
  sourceKey: z.string(),
  title: z.string(),
  text: z.string(),
});

export default defineCollector({
  id: "binny15.manual-run-fixture",
  version: "1.0.0",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema: configurationSchema,
  actions: {
    collect: defineCollectorAction({
      description: "从受控信源解析并提交资料。",
      params: z.object({
        sourceUrl: z.url(),
        gateKey: z.string().min(1),
        sourceKey: z.string().min(1),
      }),
      async execute(context, params) {
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
          throw collectorActionError({
            code: "source_unavailable",
            message: "信源暂时无法提供资料。",
            impact: "本次信源范围未能归档。",
            suggestion: "检查信源连接后重新触发。",
            requiresHuman: false,
          });
        }

        const source = sourceResultSchema.parse(await response.json());
        if (source.disposition === "manual") {
          throw collectorActionError({
            code: "source_requires_human",
            message: "信源要求人工处理后才能继续读取。",
            impact: "条目 " + source.sourceKey + " 未写入本次归档。",
            path: ["source", "title"],
            suggestion: "请在人工会话中完成信源验证后重新触发。",
            requiresHuman: true,
          });
        }
        if (source.disposition === "empty") {
          throw collectorActionError({
            code: "source_returned_no_material",
            message: "信源没有返回可归档资料。",
            impact: "条目 " + source.sourceKey + " 保留此前归档状态。",
            suggestion: "检查目标是否仍可访问后重新触发。",
            requiresHuman: false,
          });
        }

        const config = configurationSchema.parse(context.config);
        const submission = {
          requestId: "binny15:manual-run:" + context.runId,
          items: [
            {
              sourceKey: {
                namespace: "binny15.controlled-source",
                key: source.sourceKey,
              },
              metadata: { title: source.title, section: config.section },
              body: { text: source.text },
              capture: {
                scope: { gateKey: params.gateKey },
                completeness: "complete",
                missing: [],
              },
            },
          ],
        } satisfies CollectorArchiveSubmission;
        await context.archive.submit(submission);
        if (source.disposition === "partial") {
          // 同请求重放证明SDK复用02的幂等提交，再以失败结束本次run。
          await context.archive.submit(submission);
          throw collectorActionError({
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
        return { completedScopes: ["source/" + source.sourceKey] };
      },
    }),
  },
});
