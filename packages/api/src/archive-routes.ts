import {
  archiveCommitSchema,
  archiveErrorSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveResourceMetadataSchema,
  archiveItemReadQuerySchema,
  archiveRevisionReadSchema,
  archiveTimelinePageSchema,
  archiveTimelineQuerySchema,
  archiveSubmissionInputSchema,
  toInputJsonSchema,
  type ArchiveOperations,
} from "@binny/contracts";
// 文本归档 HTTP 子路由；公开客户端类型直接由这些正式路由推导。
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import * as z from "zod";

export type { ArchiveOperations } from "@binny/contracts";

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

function makeArchiveRoutes(operations: ArchiveOperations) {
  return new Hono()
    .post("/resources", async (c) => {
      const contentType = c.req.header("content-type") ?? "";
      const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
      const checkedMediaType =
        archiveResourceMetadataSchema.shape.mediaType.safeParse(mediaType);
      if (!checkedMediaType.success) {
        return c.json(
          validationFailure(
            checkedMediaType.error.issues.map((issue) => ({
              ...issue,
              path: ["content-type", ...issue.path],
            })),
          ),
          400,
        );
      }
      const body = c.req.raw.body;
      if (body === null) {
        return c.json(
          {
            error: {
              code: "invalid_input" as const,
              message: "请求正文必须包含资源字节。",
              path: ["body"],
            },
          },
          400,
        );
      }

      const result = await operations.uploadArchiveResource(
        body,
        checkedMediaType.data,
      );
      if (!result.ok) {
        switch (result.status) {
          case 400:
            return c.json({ error: result.error }, 400);
          case 404:
            return c.json({ error: result.error }, 404);
          case 409:
            return c.json({ error: result.error }, 409);
          case 503:
            return c.json({ error: result.error }, 503);
        }
      }
      return c.json(result.value, 201);
    })
    .get(
      "/resources/:resourceId",
      zValidator(
        "param",
        z.object({ resourceId: archiveIdentifierSchema }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const result = await operations.getArchiveResource(
          c.req.valid("param").resourceId,
        );
        if (!result.ok) {
          switch (result.status) {
            case 400:
              return c.json({ error: result.error }, 400);
            case 404:
              return c.json({ error: result.error }, 404);
            case 409:
              return c.json({ error: result.error }, 409);
            case 503:
              return c.json({ error: result.error }, 503);
          }
        }
        return c.body(result.value.body, 200, {
          "content-type": result.value.metadata.mediaType,
          "content-length": String(result.value.metadata.size),
          etag: `"${result.value.metadata.sha256}"`,
          "x-binny-resource-id": result.value.metadata.resourceId,
        });
      },
    )
    .post(
      "/archives",
      zValidator("json", archiveSubmissionInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.submitArchive(c.req.valid("json"));
        if (!result.ok) {
          switch (result.status) {
            case 400:
              return c.json({ error: result.error }, 400);
            case 404:
              return c.json({ error: result.error }, 404);
            case 409:
              return c.json({ error: result.error }, 409);
            case 503:
              return c.json({ error: result.error }, 503);
          }
        }
        return c.json(result.value, 201);
      },
    )
    .get(
      "/archives/items/:itemId",
      zValidator(
        "param",
        z.object({ itemId: archiveIdentifierSchema }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      zValidator("query", archiveItemReadQuerySchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const query = c.req.valid("query");
        const result = await operations.getArchiveItem(
          c.req.valid("param").itemId,
          {
            ...(query.binId === undefined ? {} : { binId: query.binId }),
            ...(query.asOf === undefined ? {} : { asOf: query.asOf }),
          },
        );
        if (!result.ok) {
          switch (result.status) {
            case 400:
              return c.json({ error: result.error }, 400);
            case 404:
              return c.json({ error: result.error }, 404);
            case 409:
              return c.json({ error: result.error }, 409);
            case 503:
              return c.json({ error: result.error }, 503);
          }
        }
        return c.json(result.value, 200);
      },
    )
    .get(
      "/archives/items/:itemId/timeline",
      zValidator(
        "param",
        z.object({ itemId: archiveIdentifierSchema }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      zValidator("query", archiveTimelineQuerySchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const query = c.req.valid("query");
        const result = await operations.getArchiveTimeline(
          c.req.valid("param").itemId,
          {
            ...(query.binId === undefined ? {} : { binId: query.binId }),
            ...(query.asOf === undefined ? {} : { asOf: query.asOf }),
            ...(query.limit === undefined
              ? {}
              : { limit: Number(query.limit) }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
        );
        if (!result.ok) {
          switch (result.status) {
            case 400:
              return c.json({ error: result.error }, 400);
            case 404:
              return c.json({ error: result.error }, 404);
            case 409:
              return c.json({ error: result.error }, 409);
            case 503:
              return c.json({ error: result.error }, 503);
          }
        }
        return c.json(result.value, 200);
      },
    )
    .get(
      "/archives/revisions/:revisionId",
      zValidator(
        "param",
        z.object({ revisionId: archiveIdentifierSchema }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const result = await operations.getArchiveRevision(
          c.req.valid("param").revisionId,
        );
        if (!result.ok) {
          switch (result.status) {
            case 400:
              return c.json({ error: result.error }, 400);
            case 404:
              return c.json({ error: result.error }, 404);
            case 409:
              return c.json({ error: result.error }, 409);
            case 503:
              return c.json({ error: result.error }, 503);
          }
        }
        return c.json(result.value, 200);
      },
    )
    .get(
      "/archives/commits/:commitId",
      zValidator(
        "param",
        z.object({ commitId: archiveIdentifierSchema }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const result = await operations.getArchiveCommit(
          c.req.valid("param").commitId,
        );
        if (!result.ok) {
          switch (result.status) {
            case 400:
              return c.json({ error: result.error }, 400);
            case 404:
              return c.json({ error: result.error }, 404);
            case 409:
              return c.json({ error: result.error }, 409);
            case 503:
              return c.json({ error: result.error }, 503);
          }
        }
        return c.json(result.value, 200);
      },
    );
}

export type ArchiveRoutes = ReturnType<typeof makeArchiveRoutes>;

/** 公开归档输入输出的 JSON Schema 与正式运行时契约保持一致。 */
export const archiveApiSchemas: {
  readonly submitInput: Record<string, unknown>;
  readonly commit: Record<string, unknown>;
  readonly itemQuery: Record<string, unknown>;
  readonly item: Record<string, unknown>;
  readonly timelineQuery: Record<string, unknown>;
  readonly revision: Record<string, unknown>;
  readonly resource: Record<string, unknown>;
  readonly timeline: Record<string, unknown>;
  readonly error: Record<string, unknown>;
} = {
  submitInput: toInputJsonSchema(archiveSubmissionInputSchema),
  commit: z.toJSONSchema(archiveCommitSchema),
  itemQuery: toInputJsonSchema(archiveItemReadQuerySchema),
  item: z.toJSONSchema(archiveItemReadSchema),
  timelineQuery: toInputJsonSchema(archiveTimelineQuerySchema),
  revision: z.toJSONSchema(archiveRevisionReadSchema),
  resource: z.toJSONSchema(archiveResourceMetadataSchema),
  timeline: z.toJSONSchema(archiveTimelinePageSchema),
  error: z.toJSONSchema(archiveErrorSchema),
};

export function createArchiveRoutes(
  operations: ArchiveOperations,
): ArchiveRoutes {
  return makeArchiveRoutes(operations);
}
