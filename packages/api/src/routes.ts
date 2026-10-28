import {
  binConfigurationSchema,
  binCreateInputSchema,
  binErrorSchema,
  binIdSchema,
  binUpdateInputSchema,
  toInputJsonSchema,
  type ArchiveOperations,
  type BinConfigurationOperations,
} from "@binny/contracts";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import * as z from "zod";

// 正式 HTTP 路由入口；业务操作由 server 注入，客户端类型由此推导。
import { archiveApiSchemas, createArchiveRoutes } from "./archive-routes.ts";
export type {
  ArchiveOperations,
  BinConfigurationOperations,
} from "@binny/contracts";

export type ApiOperations = {
  readonly bins: BinConfigurationOperations;
  readonly archives: ArchiveOperations;
};

function validationFailure(issues: readonly z.core.$ZodIssue[]) {
  const firstIssue = issues[0];
  const path = firstIssue?.path.map((part) =>
    typeof part === "symbol" ? String(part) : part,
  );
  const message =
    firstIssue?.message.includes("。") === true
      ? firstIssue.message
      : firstIssue?.code === "unrecognized_keys"
        ? "请求包含未支持的字段。"
        : firstIssue?.code === "invalid_type"
          ? "必填字段缺失或字段类型无效。"
          : "字段值不符合要求。";
  return {
    error: {
      code: "invalid_input" as const,
      message,
      ...(path === undefined || path.length === 0 ? {} : { path }),
    },
  };
}

function makeApp(operations: ApiOperations) {
  return new Hono()
    .get("/health", (c) => c.json({ status: "ok" as const }, 200))
    .get("/bins", async (c) => {
      return c.json({ bins: await operations.bins.listBins() }, 200);
    })
    .post(
      "/bins",
      zValidator("json", binCreateInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.bins.createBin(c.req.valid("json"));
        if (!result.ok) {
          switch (result.status) {
            case 400:
              return c.json({ error: result.error }, 400);
            case 404:
              return c.json({ error: result.error }, 404);
            case 409:
              return c.json({ error: result.error }, 409);
          }
        }
        return c.json(result.value, 201);
      },
    )
    .get(
      "/bins/:binId",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.bins.getBin(c.req.valid("param").binId);
        if (!result.ok) return c.json({ error: result.error }, 404);
        return c.json(result.value, 200);
      },
    )
    .get(
      "/bins/:binId/actions",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.bins.getBin(c.req.valid("param").binId);
        if (!result.ok) return c.json({ error: result.error }, 404);
        return c.json(
          {
            actions: result.value.collector.actions,
            environment: result.value.collector.environment,
            execution: result.value.execution,
          },
          200,
        );
      },
    )
    .patch(
      "/bins/:binId",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("json", binUpdateInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const { binId } = c.req.valid("param");
        const result = await operations.bins.updateBin(
          binId,
          c.req.valid("json"),
        );
        if (!result.ok) {
          switch (result.status) {
            case 400:
              return c.json({ error: result.error }, 400);
            case 404:
              return c.json({ error: result.error }, 404);
            case 409:
              return c.json({ error: result.error }, 409);
          }
        }
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/disable",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.bins.setBinStatus(
          c.req.valid("param").binId,
          "disabled",
        );
        if (!result.ok) return c.json({ error: result.error }, 404);
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/enable",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.bins.setBinStatus(
          c.req.valid("param").binId,
          "active",
        );
        if (!result.ok) return c.json({ error: result.error }, 404);
        return c.json(result.value, 200);
      },
    )
    .delete(
      "/bins/:binId",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.bins.removeBin(
          c.req.valid("param").binId,
        );
        if (!result.ok) return c.json({ error: result.error }, 404);
        return c.json({ removed: true as const, ...result.value }, 200);
      },
    )
    .route("/", createArchiveRoutes(operations.archives));
}

export type ApiRoutes = ReturnType<typeof makeApp>;

/** 对外暴露 Zod 4 契约的 JSON Schema 投影，避免维护平行的手写描述。 */
export const binApiSchemas = {
  create: toInputJsonSchema(binCreateInputSchema),
  update: toInputJsonSchema(binUpdateInputSchema),
  output: z.toJSONSchema(binConfigurationSchema),
  error: z.toJSONSchema(binErrorSchema),
};

export { archiveApiSchemas };

export function createApiRoutes(operations: ApiOperations): ApiRoutes {
  return makeApp(operations);
}
