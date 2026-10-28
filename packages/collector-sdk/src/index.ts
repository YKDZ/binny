// 采集器声明、运行上下文和公共错误帮助。
import { randomUUID } from "node:crypto";

import { createApiClient } from "@binny/api/client";
import type { CollectorManifest } from "@binny/contracts";
import {
  manualRunFailureSchema,
  type ArchiveCommit,
  type ArchiveError,
  type ArchiveResourceMetadata,
  type ArchiveResourceReference,
  type ArchiveSubmissionInput,
  type ManualRunFailure,
  postgresTextSchema,
} from "@binny/contracts";
import { z } from "zod";

export type { CollectorManifest, JsonSchema } from "@binny/contracts";

type CollectorApiClient = ReturnType<typeof createApiClient>;

export type ArchiveResourceUpload =
  | { readonly ok: true; readonly resource: ArchiveResourceMetadata }
  | { readonly ok: false; readonly error: ArchiveError };

export type CollectorArchiveSubmission = Omit<
  ArchiveSubmissionInput,
  "requestId" | "binId" | "runId" | "collectorVersion" | "relations"
> & {
  readonly requestId?: string;
  readonly relations?: ArchiveSubmissionInput["relations"];
};

/** 将真实媒体字节上传到核心，成功后返回可提交的归档资源元信息。 */
export async function uploadArchiveResource(
  client: CollectorApiClient,
  body: BodyInit,
  mediaType: string,
): Promise<ArchiveResourceUpload> {
  const requestInit: RequestInit & { duplex?: "half" } = { body };
  if (body instanceof ReadableStream) requestInit.duplex = "half";
  const response = await client.resources.$post(
    { header: { "content-type": mediaType } },
    { init: requestInit },
  );
  if (response.status === 201) {
    return { ok: true, resource: await response.json() };
  }
  const result = await response.json();
  return { ok: false, error: result.error };
}

export type ArchiveMediaPart = {
  readonly kind: "archive-media";
  readonly resourceId: string;
  readonly reference: string;
};

/** 为正文中的媒体位置生成与部署地址无关的内部引用。 */
export function archivedMedia(
  resource: ArchiveResourceMetadata,
): ArchiveMediaPart {
  return {
    kind: "archive-media",
    resourceId: resource.resourceId,
    reference: `binny://resource/${resource.resourceId}`,
  };
}

/** 从实际写入正文的媒体片段同时构造不重复的显式资源清单。 */
export function archiveBodyWithResources(
  parts: readonly (string | ArchiveMediaPart)[],
): {
  readonly content: string;
  readonly resources: readonly ArchiveResourceReference[];
} {
  const resourceIds = new Set<string>();
  let content = "";
  for (const part of parts) {
    if (typeof part === "string") {
      content += part;
    } else {
      content += part.reference;
      resourceIds.add(part.resourceId);
    }
  }
  return {
    content,
    resources: [...resourceIds].map((resourceId) => ({ resourceId })),
  };
}

/** 为只需列出附件的版本生成显式资源清单。 */
export function archiveResourceManifest(
  resources: readonly ArchiveResourceMetadata[],
): readonly ArchiveResourceReference[] {
  return [...new Set(resources.map(({ resourceId }) => resourceId))].map(
    (resourceId) => ({ resourceId }),
  );
}

export interface CollectorContext {
  readonly binId: string;
  readonly identityId: string;
  readonly runId: string;
  readonly collectorVersion: string;
  readonly config: unknown;
  readonly targets: readonly unknown[];
  readonly signal: AbortSignal;
  readonly archive: {
    submit(input: CollectorArchiveSubmission): Promise<ArchiveCommit>;
  };
}

export type CollectorEnvironment = CollectorManifest["environment"];

export interface CollectorAction<TParams extends z.ZodType = z.ZodType> {
  readonly description: string;
  readonly params: TParams;
  execute(
    context: CollectorContext,
    params: z.output<TParams>,
  ): Promise<unknown>;
}

export type CollectorActionResult = {
  readonly completedScopes: readonly string[];
};

const collectorActionErrorType = "binny.collector-action-error";

export const collectorActionResultSchema = z
  .object({ completedScopes: z.array(postgresTextSchema) })
  .strict();

/** 将单个动作与其 Zod 参数输出类型关联，供清单声明保持编译期类型。 */
export function defineCollectorAction<TParams extends z.ZodType>(
  action: CollectorAction<TParams>,
): CollectorAction<TParams> {
  return action;
}

export type CollectorRunContext = Omit<
  CollectorContext,
  "archive" | "binId" | "identityId" | "runId" | "collectorVersion"
> & {
  readonly binId: string;
  readonly identityId: string;
  readonly runId: string;
  readonly collectorVersion: string;
};

/** 提交失败或需要人工处理时保留稳定代码、影响范围和可执行建议。 */
export class CollectorActionError extends Error {
  readonly type = collectorActionErrorType;
  readonly failure: ManualRunFailure;

  constructor(failure: ManualRunFailure) {
    super(failure.message);
    this.name = "CollectorActionError";
    this.failure = failure;
  }
}

/** 识别独立部署依赖树抛出的同一 SDK 错误，并校验其公开失败契约。 */
export function isCollectorActionError(
  error: unknown,
): error is CollectorActionError {
  if (
    typeof error !== "object" ||
    error === null ||
    !("type" in error) ||
    error.type !== collectorActionErrorType ||
    !("failure" in error)
  ) {
    return false;
  }
  return manualRunFailureSchema.safeParse(error.failure).success;
}

export function collectorActionError(
  failure: ManualRunFailure,
): CollectorActionError {
  return new CollectorActionError(failure);
}

/** 给动作提供固定 run/bin/version 的正式 API 归档提交能力。 */
export function createCollectorContext(
  client: CollectorApiClient,
  context: CollectorRunContext,
): CollectorContext {
  return {
    ...context,
    archive: {
      async submit(input) {
        const response = await client.archives.$post({
          json: {
            ...input,
            relations: input.relations ?? [],
            requestId: input.requestId ?? randomUUID(),
            binId: context.binId,
            runId: context.runId,
            collectorVersion: context.collectorVersion,
          },
        });
        switch (response.status) {
          case 201:
            return await response.json();
          case 400:
          case 404:
          case 409:
          case 503: {
            const result = await response.json();
            throw new CollectorActionError({
              code: result.error.code,
              message: result.error.message,
              impact: "本次资料提交未写入归档。",
              ...(result.error.path === undefined
                ? {}
                : { path: result.error.path }),
              ...(result.error.code === "invalid_input"
                ? { suggestion: "检查采集器整理后的资料内容。" }
                : {}),
              requiresHuman: false,
            });
          }
        }
        throw new Error("归档服务返回了未声明的提交状态。");
      },
    },
  };
}

export interface CollectorDefinition<
  TConfig extends z.ZodType = z.ZodType,
  TActions extends Readonly<Record<string, CollectorAction>> = Readonly<
    Record<string, CollectorAction>
  >,
> {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly environment: CollectorEnvironment;
  readonly configSchema: TConfig;
  readonly actions: TActions;
}

type CollectorActionShape = {
  readonly description: string;
  readonly params: z.ZodType;
};

type TypedCollectorActions<
  TActions extends Readonly<Record<string, CollectorActionShape>>,
> = {
  readonly [Name in keyof TActions]: CollectorAction<TActions[Name]["params"]>;
};

export function defineCollector<
  TConfig extends z.ZodType,
  TActions extends Readonly<Record<string, CollectorActionShape>>,
>(
  definition: Omit<
    CollectorDefinition<TConfig, TypedCollectorActions<TActions>>,
    "actions"
  > & {
    readonly actions: TypedCollectorActions<TActions>;
  },
): CollectorDefinition<TConfig, TypedCollectorActions<TActions>> {
  return definition;
}

export function collectorManifest(
  definition: CollectorDefinition,
): CollectorManifest {
  const actions = Object.fromEntries(
    Object.entries(definition.actions).map(([name, action]) => [
      name,
      {
        description: action.description,
        params: z.toJSONSchema(action.params, { io: "input" }),
      },
    ]),
  );

  return {
    id: definition.id,
    version: definition.version,
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
    environment: definition.environment,
    configSchema: z.toJSONSchema(definition.configSchema, { io: "input" }),
    actions,
  };
}
