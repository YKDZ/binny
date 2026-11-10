import {
  archiveCommitSchema,
  archiveErrorSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveItemDeletionResultSchema,
  archiveBatchReadInputSchema,
  archiveBatchReadResponseSchema,
  archiveResourceMetadataSchema,
  archiveResourceResolveInputSchema,
  archiveResourceResolveResultSchema,
  archiveItemReadQuerySchema,
  archiveRelationPageSchema,
  archiveRelationReadQuerySchema,
  archiveRevisionDiffSchema,
  archiveRevisionReadSchema,
  archiveSearchInputSchema,
  archiveSearchInputIssue,
  archiveSearchPageSchema,
  archiveQueryContractVersion,
  archiveTimelinePageSchema,
  archiveTimelineQuerySchema,
  archiveSubmissionInputSchema,
  toArchiveJsonSchema,
  type ArchiveOperations,
} from "@binny/contracts";
// 文本归档 HTTP 子路由；公开客户端类型直接由这些正式路由推导。
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import * as z from "zod";

import { validationFailure } from "./validation.ts";

export type { ArchiveOperations } from "@binny/contracts";

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
    .post(
      "/resources/resolve",
      zValidator("json", archiveResourceResolveInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.resolveArchiveResources(
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
            case 503:
              return c.json({ error: result.error }, 503);
          }
        }
        return c.json(result.value, 200);
      },
    )
    .post(
      "/archives/resources/resolve",
      zValidator("json", archiveResourceResolveInputSchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const result = await operations.resolveArchiveResources(
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
            case 503:
              return c.json({ error: result.error }, 503);
          }
        }
        return c.json(result.value, 200);
      },
    )
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
    .post(
      "/archives/search",
      zValidator("json", archiveSearchInputSchema, async (result, c) => {
        if (!result.success) {
          const input = await c.req.json().catch(() => undefined);
          const issue = archiveSearchInputIssue(input, result.error.issues);
          return c.json(
            validationFailure(
              issue === undefined ? result.error.issues : [issue],
              { preserveOriginalMessage: true },
            ),
            400,
          );
        }
        return undefined;
      }),
      async (c) => {
        const signal = c.req.raw.signal;
        try {
          const result = await operations.searchArchive(c.req.valid("json"), {
            signal,
          });
          if (!result.ok) {
            switch (result.status) {
              case 400:
                return c.json({ error: result.error }, 400);
              case 422:
                return c.json({ error: result.error }, 422);
            }
          }
          return c.json(result.value, 200);
        } catch (error) {
          if (signal.aborted) return c.body(null, 204);
          throw error;
        }
      },
    )
    .post(
      "/archives/batch-read",
      zValidator("json", archiveBatchReadInputSchema, (result, c) => {
        if (!result.success)
          return c.json(
            validationFailure(result.error.issues, {
              preserveOriginalMessage: true,
            }),
            400,
          );
        return undefined;
      }),
      async (c) => {
        const signal = c.req.raw.signal;
        try {
          const result = await operations.readArchiveBatch(
            c.req.valid("json"),
            { signal },
          );
          if (!result.ok) {
            switch (result.status) {
              case 400:
                return c.json({ error: result.error }, 400);
              case 413:
                return c.json({ error: result.error }, 413);
              case 422:
                return c.json({ error: result.error }, 422);
              case 503:
                return c.json({ error: result.error }, 503);
            }
          }
          return c.json(result.value, 200);
        } catch (error) {
          if (signal.aborted) return c.body(null, 204);
          throw error;
        }
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
    .delete(
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
      async (c) => {
        const result = await operations.deleteArchiveItem(
          c.req.valid("param").itemId,
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
      "/archives/items/:itemId/relations",
      zValidator(
        "param",
        z.object({ itemId: archiveIdentifierSchema }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      zValidator("query", archiveRelationReadQuerySchema, (result, c) => {
        if (!result.success)
          return c.json(validationFailure(result.error.issues), 400);
        return undefined;
      }),
      async (c) => {
        const query = c.req.valid("query");
        const result = await operations.getArchiveRelations(
          c.req.valid("param").itemId,
          {
            binId: query.binId,
            direction: query.direction,
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
      "/archives/revisions/:firstRevisionId/diff/:secondRevisionId",
      zValidator(
        "param",
        z.object({
          firstRevisionId: archiveIdentifierSchema,
          secondRevisionId: archiveIdentifierSchema,
        }),
        (result, c) => {
          if (!result.success)
            return c.json(validationFailure(result.error.issues), 400);
          return undefined;
        },
      ),
      async (c) => {
        const { firstRevisionId, secondRevisionId } = c.req.valid("param");
        const result = await operations.compareArchiveRevisions(
          firstRevisionId,
          secondRevisionId,
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
  readonly searchInput: Record<string, unknown>;
  readonly searchPage: Record<string, unknown>;
  readonly batchReadInput: Record<string, unknown>;
  readonly batchReadResponse: Record<string, unknown>;
  readonly commit: Record<string, unknown>;
  readonly itemQuery: Record<string, unknown>;
  readonly item: Record<string, unknown>;
  readonly timelineQuery: Record<string, unknown>;
  readonly relationQuery: Record<string, unknown>;
  readonly revision: Record<string, unknown>;
  readonly revisionDiff: Record<string, unknown>;
  readonly resource: Record<string, unknown>;
  readonly resourceResolveInput: Record<string, unknown>;
  readonly resourceResolveResult: Record<string, unknown>;
  readonly deletionResult: Record<string, unknown>;
  readonly timeline: Record<string, unknown>;
  readonly relationPage: Record<string, unknown>;
  readonly error: Record<string, unknown>;
} = {
  submitInput: toArchiveJsonSchema(archiveSubmissionInputSchema, "input"),
  searchInput: toArchiveJsonSchema(archiveSearchInputSchema, "input"),
  searchPage: toArchiveJsonSchema(archiveSearchPageSchema, "output"),
  batchReadInput: toArchiveJsonSchema(archiveBatchReadInputSchema, "input"),
  batchReadResponse: toArchiveJsonSchema(
    archiveBatchReadResponseSchema,
    "output",
  ),
  commit: toArchiveJsonSchema(archiveCommitSchema, "output"),
  itemQuery: toArchiveJsonSchema(archiveItemReadQuerySchema, "input"),
  item: toArchiveJsonSchema(archiveItemReadSchema, "output"),
  timelineQuery: toArchiveJsonSchema(archiveTimelineQuerySchema, "input"),
  relationQuery: toArchiveJsonSchema(archiveRelationReadQuerySchema, "input"),
  revision: toArchiveJsonSchema(archiveRevisionReadSchema, "output"),
  revisionDiff: toArchiveJsonSchema(archiveRevisionDiffSchema, "output"),
  resource: toArchiveJsonSchema(archiveResourceMetadataSchema, "output"),
  resourceResolveInput: toArchiveJsonSchema(
    archiveResourceResolveInputSchema,
    "input",
  ),
  resourceResolveResult: toArchiveJsonSchema(
    archiveResourceResolveResultSchema,
    "output",
  ),
  deletionResult: toArchiveJsonSchema(
    archiveItemDeletionResultSchema,
    "output",
  ),
  timeline: toArchiveJsonSchema(archiveTimelinePageSchema, "output"),
  relationPage: toArchiveJsonSchema(archiveRelationPageSchema, "output"),
  error: toArchiveJsonSchema(archiveErrorSchema, "output"),
};

/** Search discovery references schemas generated from the public request and response contracts. */
export const archiveQueryContract = {
  version: archiveQueryContractVersion,
  operations: {
    search: {
      method: "POST",
      path: "/archives/search",
      description:
        "在固定归档截点下按来源和不区分大小写的字面关键词组搜索资料，并稳定分页返回命中来源视图。",
      requestSchema: archiveApiSchemas.searchInput,
      responseSchema: archiveApiSchemas.searchPage,
    },
    batchRead: {
      method: "POST",
      path: "/archives/batch-read",
      description:
        "Read the exact item, bin, revision, and observation references selected from archive search. Each input reference has one result; complete responses are limited to 16 MiB.",
      requestSchema: archiveApiSchemas.batchReadInput,
      responseSchema: archiveApiSchemas.batchReadResponse,
    },
  },
} as const;

export function createArchiveRoutes(
  operations: ArchiveOperations,
): ArchiveRoutes {
  return makeArchiveRoutes(operations);
}
