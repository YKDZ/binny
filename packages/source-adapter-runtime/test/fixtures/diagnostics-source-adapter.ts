import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  SourceAccessBudgetExceededError,
  SourceRequestError,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

const configSchema = z.object({}).strict();
const extensionsSchema = z.object({}).strict();
const collectParamsSchema = z
  .object({
    mode: z.enum([
      "wait-cancel",
      "budget-exceeded",
      "request-timeout",
      "unknown-abort",
    ]),
  })
  .strict();

const outputSchema = z.object({ ok: z.boolean() }).strict();

export default defineSourceAdapter({
  id: "test.worker-diagnostics",
  version: "1.0.0",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Check action",
      params: z.object({}).strict(),
      output: outputSchema,
      async execute() {
        return { ok: true };
      },
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Collect action exercising abort modes",
      params: collectParamsSchema,
      output: outputSchema,
      async execute(context, params) {
        if (params.mode === "wait-cancel") {
          await new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                reject(
                  new SourceRequestError("Request interrupted.", {
                    stage: "fetching-index",
                    target: "https://example.test/index.json",
                    cause: context.signal.reason,
                  }),
                );
              },
              { once: true },
            );
          });
        }
        if (params.mode === "budget-exceeded") {
          throw new SourceRequestError("Budget exhausted during feed scan.", {
            stage: "scanning-post-feed",
            target: "https://example.test/posts.json",
            cause: new SourceAccessBudgetExceededError("request-limit"),
          });
        }
        if (params.mode === "request-timeout") {
          throw new SourceRequestError("Request timed out after 50ms.", {
            stage: "fetching-index",
            target: "https://example.test/llms.txt",
            abortCause: "source_request_timeout",
            cause: new DOMException("The operation timed out.", "TimeoutError"),
          });
        }
        throw new SourceRequestError("Underlying connection aborted.", {
          stage: "reading-topic",
          target: "https://example.test/t/42.json",
          cause: new DOMException(
            "signal is aborted without reason",
            "AbortError",
          ),
        });
      },
    }),
  },
});
