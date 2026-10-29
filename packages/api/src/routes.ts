import {
  binConfigurationSchema,
  binCreateInputSchema,
  binErrorSchema,
  binIdSchema,
  binUpdateInputSchema,
  type HumanSessionOperations,
  manualRunClaimInputSchema,
  manualRunCompleteInputSchema,
  manualRunApiSchemas as contractManualRunApiSchemas,
  scheduleApiSchemas as contractScheduleApiSchemas,
  scheduleCreateInputSchema,
  scheduleUpdateInputSchema,
  manualRunTriggerInputSchema,
  runtimeDisconnectInputSchema,
  runtimeHeartbeatInputSchema,
  type ArchiveOperations,
  type BinConfiguration,
  type BinConfigurationOperations,
  type ManualRunOperations,
  type RuntimeConnectionOperations,
  type ScheduleOperations,
  toInputJsonSchema,
  toPostgresJsonSchema,
} from "@binny/contracts";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod";

// 正式 HTTP 路由入口；业务操作由 server 注入，客户端类型由此推导。
import { archiveApiSchemas, createArchiveRoutes } from "./archive-routes.ts";
export type {
  ArchiveOperations,
  BinConfigurationOperations,
  HumanSessionOperations,
  ManualRunOperations,
  RuntimeConnectionOperations,
  ScheduleOperations,
} from "@binny/contracts";

export type ApiOperations = {
  readonly bins: BinConfigurationOperations;
  readonly runtime: RuntimeConnectionOperations;
  readonly runs: ManualRunOperations;
  readonly schedules: ScheduleOperations;
  readonly archives: ArchiveOperations;
  readonly humanSessions: HumanSessionOperations;
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
  async function withExecution(configuration: BinConfiguration) {
    const result = await operations.runtime.getExecution(configuration.id);
    if (!result.ok)
      throw new Error("已读取的 bin 无法读取运行状态：" + result.error.message);
    return { ...configuration, execution: result.value };
  }

  return new Hono()
    .onError((error, c) => {
      if (
        error instanceof HTTPException &&
        error.status === 400 &&
        error.message === "Malformed JSON in request body"
      ) {
        return c.json(
          {
            error: {
              code: "invalid_input" as const,
              message: "请求正文必须是有效 JSON。",
            },
          },
          400,
        );
      }
      if (error instanceof HTTPException) return error.getResponse();
      console.error(error);
      return c.text("Internal Server Error", 500);
    })
    .get("/health", (c) => c.json({ status: "ok" as const }, 200))
    .get("/bins", async (c) => {
      const bins = await operations.bins.listBins();
      return c.json({ bins: await Promise.all(bins.map(withExecution)) }, 200);
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
        return c.json(await withExecution(result.value), 201);
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
        return c.json(await withExecution(result.value), 200);
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
        const configuration = await withExecution(result.value);
        return c.json(
          {
            actions: configuration.collector.actions,
            environment: configuration.collector.environment,
            execution: configuration.execution,
          },
          200,
        );
      },
    )
    .post(
      "/bins/:binId/human-sessions",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.humanSessions.requestHumanSession(
          c.req.valid("param").binId,
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 201);
      },
    )
    .get(
      "/bins/:binId/human-sessions/:sessionId",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, sessionId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const { binId, sessionId } = c.req.valid("param");
        const result = await operations.humanSessions.getHumanSession(
          binId,
          sessionId,
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/human-sessions/:sessionId/close",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, sessionId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const { binId, sessionId } = c.req.valid("param");
        const result = await operations.humanSessions.closeHumanSession(
          binId,
          sessionId,
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/runs",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("json", manualRunTriggerInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.runs.triggerRun(
          c.req.valid("param").binId,
          c.req.valid("json"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 202);
      },
    )
    .get(
      "/bins/:binId/runs/:runId",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, runId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const { binId, runId } = c.req.valid("param");
        const result = await operations.runs.getRun(binId, runId);
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/runs/:runId/cancel",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, runId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const { binId, runId } = c.req.valid("param");
        const result = await operations.runs.cancelRun(binId, runId);
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .get(
      "/bins/:binId/schedules",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.schedules.listSchedules(
          c.req.valid("param").binId,
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json({ schedules: result.value }, 200);
      },
    )
    .post(
      "/bins/:binId/schedules",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("json", scheduleCreateInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.schedules.createSchedule(
          c.req.valid("param").binId,
          c.req.valid("json"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 201);
      },
    )
    .get(
      "/bins/:binId/schedules/:scheduleId",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const result = await operations.schedules.getSchedule(
          c.req.valid("param").binId,
          c.req.valid("param").scheduleId,
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .patch(
      "/bins/:binId/schedules/:scheduleId",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      zValidator("json", scheduleUpdateInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const { binId, scheduleId } = c.req.valid("param");
        const result = await operations.schedules.updateSchedule(
          binId,
          scheduleId,
          c.req.valid("json"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/schedules/:scheduleId/disable",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const { binId, scheduleId } = c.req.valid("param");
        const result = await operations.schedules.setScheduleEnabled(
          binId,
          scheduleId,
          false,
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/schedules/:scheduleId/enable",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const { binId, scheduleId } = c.req.valid("param");
        const result = await operations.schedules.setScheduleEnabled(
          binId,
          scheduleId,
          true,
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .delete(
      "/bins/:binId/schedules/:scheduleId",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const result = await operations.schedules.deleteSchedule(
          c.req.valid("param").binId,
          c.req.valid("param").scheduleId,
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/runtime/runs/claim",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("json", manualRunClaimInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.runs.claimRun(
          c.req.valid("param").binId,
          c.req.valid("json"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json({ run: result.value }, 200);
      },
    )
    .post(
      "/bins/:binId/runtime/runs/:runId/complete",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, runId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      zValidator("json", manualRunCompleteInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const { binId, runId } = c.req.valid("param");
        const result = await operations.runs.completeRun(
          binId,
          runId,
          c.req.valid("json"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
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
        return c.json(await withExecution(result.value), 200);
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
        return c.json(await withExecution(result.value), 200);
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
        return c.json(await withExecution(result.value), 200);
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
    .post(
      "/bins/:binId/runtime/heartbeat",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("json", runtimeHeartbeatInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.runtime.heartbeat(
          c.req.valid("param").binId,
          c.req.valid("json"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .post(
      "/bins/:binId/runtime/disconnect",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("json", runtimeDisconnectInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.runtime.disconnect(
          c.req.valid("param").binId,
          c.req.valid("json"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .route("/", createArchiveRoutes(operations.archives));
}

export type ApiRoutes = ReturnType<typeof makeApp>;

/** 对外暴露 Zod 4 契约的 JSON Schema 投影，避免维护平行的手写描述。 */
export const binApiSchemas = {
  create: toInputJsonSchema(binCreateInputSchema),
  update: toInputJsonSchema(binUpdateInputSchema),
  runtimeHeartbeat: toInputJsonSchema(runtimeHeartbeatInputSchema),
  runtimeDisconnect: toInputJsonSchema(runtimeDisconnectInputSchema),
  output: toPostgresJsonSchema(binConfigurationSchema, "output"),
  error: toPostgresJsonSchema(binErrorSchema, "output"),
};

export const manualRunApiSchemas = contractManualRunApiSchemas;

export const scheduleApiSchemas = contractScheduleApiSchemas;

export { archiveApiSchemas };

export function createApiRoutes(operations: ApiOperations): ApiRoutes {
  return makeApp(operations);
}
