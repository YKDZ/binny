import {
  binConfigurationSchema,
  binConfigSchemaDiscoverySchema,
  binDetailsSchema,
  binErrorSchema,
  binIdSchema,
  binListSchema,
  binUpdateInputSchema,
  type HumanSessionOperations,
  manualRunClaimInputSchema,
  manualRunCompleteInputSchema,
  manualRunReportInputSchema,
  manualRunApiSchemas as contractManualRunApiSchemas,
  scheduleApiSchemas as contractScheduleApiSchemas,
  scheduleCreateInputSchema,
  scheduleListQuerySchema,
  scheduleUpdateInputSchema,
  manualRunListQuerySchema,
  archiveQueryContractPath,
  archiveQueryContractVersion,
  publicApiProtocolVersion,
  serviceCapabilities,
  serviceMetadataSchema,
  manualRunTriggerInputSchema,
  runtimeDisconnectInputSchema,
  runtimeHeartbeatInputSchema,
  runtimeOwnershipClaimInputSchema,
  runtimeStateQuerySchema,
  runtimeStateUpdateInputSchema,
  type ArchiveOperations,
  type BinConfiguration,
  type BinConfigurationOperations,
  sourceAdapterActionDiscoverySchema,
  sourceAdapterActionListSchema,
  sourceAdapterActionNameSchema,
  type ManualRunOperations,
  type ManualRunListOperations,
  type RuntimeConnectionOperations,
  type ScheduleOperations,
  type ScheduleListOperations,
  toInputJsonSchema,
  toPostgresJsonSchema,
} from "@binny/contracts";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod";

// 正式 HTTP 路由入口；业务操作由 server 注入，客户端类型由此推导。
import {
  archiveApiSchemas,
  archiveQueryContract,
  createArchiveRoutes,
} from "./archive-routes.ts";
import { validationFailure } from "./validation.ts";
export type {
  ArchiveOperations,
  BinConfigurationOperations,
  HumanSessionOperations,
  ManualRunOperations,
  ManualRunListOperations,
  RuntimeConnectionOperations,
  ScheduleOperations,
  ScheduleListOperations,
} from "@binny/contracts";

export type ApiOperations = {
  readonly bins: BinConfigurationOperations;
  readonly runtime: RuntimeConnectionOperations;
  readonly runs: ManualRunOperations;
  readonly runListings: ManualRunListOperations;
  readonly schedules: ScheduleOperations;
  readonly scheduleListings: ScheduleListOperations;
  readonly archives: ArchiveOperations;
  readonly humanSessions: HumanSessionOperations;
};

function makeApp(operations: ApiOperations, productVersion: string) {
  const serviceMetadata = serviceMetadataSchema.parse({
    product: { name: "Binny", version: productVersion },
    protocols: { httpApi: publicApiProtocolVersion },
    capabilities: Object.values(serviceCapabilities),
    contracts: {
      archiveQuery: {
        version: archiveQueryContractVersion,
        path: archiveQueryContractPath,
      },
    },
  });

  async function withExecution(configuration: BinConfiguration) {
    const result = await operations.runtime.getExecution(configuration.id);
    if (!result.ok)
      throw new Error("已读取的 bin 无法读取运行状态：" + result.error.message);
    return { ...configuration, execution: result.value };
  }

  function summarizeBin(configuration: BinConfiguration) {
    return binDetailsSchema.parse({
      id: configuration.id,
      sourceAdapterId: configuration.sourceAdapter.id,
      identityId: configuration.identityId,
      config: configuration.config,
      browserIdleTimeoutSeconds: configuration.browserIdleTimeoutSeconds,
      status: configuration.status,
      execution:
        configuration.execution.status === "offline"
          ? {
              status: configuration.execution.status,
              reason: configuration.execution.reason,
              ...(configuration.execution.runtimeId === undefined
                ? {}
                : { runtimeId: configuration.execution.runtimeId }),
              ...(configuration.execution.lastHeartbeatAt === undefined
                ? {}
                : {
                    lastHeartbeatAt: configuration.execution.lastHeartbeatAt,
                  }),
            }
          : configuration.execution.status === "incompatible"
            ? {
                status: configuration.execution.status,
                runtimeId: configuration.execution.runtimeId,
                lastHeartbeatAt: configuration.execution.lastHeartbeatAt,
                error: { code: configuration.execution.error.code },
              }
            : {
                status: configuration.execution.status,
                runtimeId: configuration.execution.runtimeId,
                lastHeartbeatAt: configuration.execution.lastHeartbeatAt,
                environment: configuration.execution.environment,
              },
      sourceStateSnapshot:
        configuration.execution.sourceStateSnapshot.freshness === "unknown"
          ? { freshness: "unknown" }
          : {
              freshness: configuration.execution.sourceStateSnapshot.freshness,
              updatedAt: configuration.execution.sourceStateSnapshot.updatedAt,
            },
      createdAt: configuration.createdAt,
      updatedAt: configuration.updatedAt,
    });
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
    .get("/meta", (c) => c.json(serviceMetadata, 200))
    .get("/meta/query", (c) => c.json(archiveQueryContract, 200))
    .get("/bins", async (c) => {
      const bins = await operations.bins.listBins();
      const listed = await Promise.all(
        bins.map(async (bin) => {
          const configuration = await withExecution(bin);
          return {
            id: configuration.id,
            sourceAdapterId: configuration.sourceAdapter.id,
            status: configuration.status,
            execution: { status: configuration.execution.status },
          };
        }),
      );
      return c.json(binListSchema.parse({ bins: listed }), 200);
    })
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
        return c.json(summarizeBin(await withExecution(result.value)), 200);
      },
    )
    .get(
      "/bins/:binId/config-schema",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.bins.getBin(c.req.valid("param").binId);
        if (!result.ok) return c.json({ error: result.error }, 404);
        return c.json(
          binConfigSchemaDiscoverySchema.parse({
            sourceAdapterId: result.value.sourceAdapter.id,
            sourceAdapterVersion: result.value.sourceAdapter.version,
            configSchema: result.value.sourceAdapter.configSchema,
          }),
          200,
        );
      },
    )
    .get(
      "/bins/:binId/actions",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator(
        "query",
        z.object({ action: sourceAdapterActionNameSchema.optional() }).strict(),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const result = await operations.bins.getBin(c.req.valid("param").binId);
        if (!result.ok) return c.json({ error: result.error }, 404);
        const { action } = c.req.valid("query");
        const actions = result.value.sourceAdapter.actions;
        if (action === undefined) {
          return c.json(
            sourceAdapterActionListSchema.parse({
              actions: Object.fromEntries(
                Object.entries(actions).map(([name, declaration]) => [
                  name,
                  { description: declaration.description },
                ]),
              ),
            }),
            200,
          );
        }
        const declaration = actions[action];
        if (declaration === undefined) {
          return c.json(
            {
              error: {
                code: "action_not_found" as const,
                message: "信源适配器没有声明这个动作。",
                path: ["action" as const],
              },
            },
            404,
          );
        }
        return c.json(
          sourceAdapterActionDiscoverySchema.parse({
            actions: { [action]: declaration },
          }),
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
      "/runs",
      zValidator("query", manualRunListQuerySchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.runListings.listRuns(
          c.req.valid("query"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
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
      "/schedules",
      zValidator("query", scheduleListQuerySchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.scheduleListings.listScheduleSummaries(
          c.req.valid("query"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
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
    .post(
      "/bins/:binId/runtime/runs/:runId/report",
      zValidator(
        "param",
        z.object({ binId: binIdSchema, runId: z.string().uuid() }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      zValidator("json", manualRunReportInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const { binId, runId } = c.req.valid("param");
        const result = await operations.runs.reportRun(
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
        return c.json(summarizeBin(await withExecution(result.value)), 200);
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
        return c.json(summarizeBin(await withExecution(result.value)), 200);
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
        return c.json(summarizeBin(await withExecution(result.value)), 200);
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
        if (!result.ok) return c.json({ error: result.error }, result.status);
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
    .post(
      "/bins/:binId/runtime/ownership",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("json", runtimeOwnershipClaimInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.runtime.claimOwnership(
          c.req.valid("param").binId,
          c.req.valid("json"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .get(
      "/bins/:binId/runtime/state",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("query", runtimeStateQuerySchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.runtime.getState(
          c.req.valid("param").binId,
          c.req.valid("query"),
        );
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.value, 200);
      },
    )
    .put(
      "/bins/:binId/runtime/state",
      zValidator("param", z.object({ binId: binIdSchema }), (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      zValidator("json", runtimeStateUpdateInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.runtime.putState(
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
  update: toInputJsonSchema(binUpdateInputSchema),
  runtimeHeartbeat: toInputJsonSchema(runtimeHeartbeatInputSchema),
  runtimeDisconnect: toInputJsonSchema(runtimeDisconnectInputSchema),
  runtimeOwnership: toInputJsonSchema(runtimeOwnershipClaimInputSchema),
  runtimeStateUpdate: toInputJsonSchema(runtimeStateUpdateInputSchema),
  output: toPostgresJsonSchema(binConfigurationSchema, "output"),
  error: toPostgresJsonSchema(binErrorSchema, "output"),
};

export const manualRunApiSchemas = contractManualRunApiSchemas;

export const scheduleApiSchemas = contractScheduleApiSchemas;

export { archiveApiSchemas };

export function createApiRoutes(
  operations: ApiOperations,
  options: { readonly productVersion?: string } = {},
): ApiRoutes {
  return makeApp(operations, options.productVersion ?? "unpublished");
}
