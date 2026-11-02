// 信源适配器声明、运行上下文和公共错误帮助。
import { randomUUID } from "node:crypto";

import { createApiClient } from "@binny/api/client";
import type { SourceAdapterManifest } from "@binny/contracts";
import {
  manualRunFailureSchema,
  type ArchiveCommit,
  type ArchiveError,
  type ArchiveResourceMetadata,
  type ArchiveResourceReference,
  type ArchiveSubmissionInput,
  type ManualRunFailure,
} from "@binny/contracts";
import { z } from "zod";

export type { SourceAdapterManifest, JsonSchema } from "@binny/contracts";
export type { ArchiveCommit, ArchiveResourceMetadata } from "@binny/contracts";

type SourceAdapterApiClient = ReturnType<typeof createApiClient>;

export type ArchiveResourceUpload =
  | { readonly ok: true; readonly resource: ArchiveResourceMetadata }
  | { readonly ok: false; readonly error: ArchiveError };

export type SourceAdapterArchiveSubmission = Omit<
  ArchiveSubmissionInput,
  "requestId" | "binId" | "runId" | "sourceAdapterVersion" | "relations"
> & {
  readonly requestId?: string;
  readonly relations?: ArchiveSubmissionInput["relations"];
};

/** 将真实媒体字节上传到核心，成功后返回可提交的归档资源元信息。 */
export async function uploadArchiveResource(
  client: SourceAdapterApiClient,
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

/** 浏览器执行器向信源适配器提供的本机 Playwright 连接描述。 */
export const sourceAdapterBrowserConnectionSchema = z
  .object({
    protocol: z.literal("playwright"),
    endpoint: z.url(),
    playwrightVersion: z.string().min(1),
  })
  .strict();

export type SourceAdapterBrowserConnection = z.infer<
  typeof sourceAdapterBrowserConnectionSchema
>;

export interface SourceAdapterContext<TConfig = unknown> {
  readonly binId: string;
  readonly identityId: string;
  readonly runId: string;
  readonly sourceAdapterVersion: string;
  readonly config: TConfig;
  readonly signal: AbortSignal;
  readonly browser?: SourceAdapterBrowserConnection;
  readonly archive: {
    submit(input: SourceAdapterArchiveSubmission): Promise<ArchiveCommit>;
  };
  readonly resources: {
    upload(body: BodyInit, mediaType: string): Promise<ArchiveResourceUpload>;
  };
}

export type SourceAdapterEnvironment = SourceAdapterManifest["environment"];

export interface SourceAdapterAction<
  TConfig extends z.ZodType = z.ZodType,
  TParams extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly description: string;
  readonly params: TParams;
  readonly output: TOutput;
  execute(
    context: SourceAdapterContext<z.output<TConfig>>,
    params: z.output<TParams>,
  ): Promise<z.input<TOutput>>;
}

/** 用同一份配置声明、参数 schema 与输出 schema 定义一个可执行动作。 */
export function defineSourceAdapterAction<
  TConfig extends z.ZodType,
  TParams extends z.ZodType,
  TOutput extends z.ZodType,
>(
  configSchema: TConfig,
  action: {
    readonly description: string;
    readonly params: TParams;
    readonly output: TOutput;
    execute(
      context: SourceAdapterContext<z.output<TConfig>>,
      params: z.output<TParams>,
    ): Promise<z.input<TOutput>>;
  },
): SourceAdapterAction<TConfig, TParams, TOutput> {
  void configSchema;
  return action;
}

type SourceAdapterActionShape = {
  readonly description: string;
  readonly params: z.ZodType;
  readonly output: z.ZodType;
  execute(context: never, params: never): Promise<unknown>;
};

const sourceAdapterActionErrorType = "binny.source-adapter-action-error";
export type SourceAdapterRunContext<TConfig = unknown> = Omit<
  SourceAdapterContext<TConfig>,
  | "archive"
  | "resources"
  | "binId"
  | "identityId"
  | "runId"
  | "sourceAdapterVersion"
> & {
  readonly binId: string;
  readonly identityId: string;
  readonly runId: string;
  readonly sourceAdapterVersion: string;
};

/** 提交失败或需要人工处理时保留稳定代码、影响范围和可执行建议。 */
export class SourceAdapterActionError extends Error {
  readonly type = sourceAdapterActionErrorType;
  readonly failure: ManualRunFailure;
  readonly completedScopes: readonly string[];

  constructor(
    failure: ManualRunFailure,
    completedScopes: readonly string[] = [],
  ) {
    super(failure.message);
    this.name = "SourceAdapterActionError";
    this.failure = failure;
    this.completedScopes = [...completedScopes];
  }
}

/** 识别独立部署依赖树抛出的同一 SDK 错误，并校验其公开失败契约。 */
export function isSourceAdapterActionError(
  error: unknown,
): error is SourceAdapterActionError {
  if (
    typeof error !== "object" ||
    error === null ||
    !("type" in error) ||
    error.type !== sourceAdapterActionErrorType ||
    !("failure" in error)
  ) {
    return false;
  }
  return manualRunFailureSchema.safeParse(error.failure).success;
}

export function sourceAdapterActionError(
  failure: ManualRunFailure,
  completedScopes: readonly string[] = [],
): SourceAdapterActionError {
  return new SourceAdapterActionError(failure, completedScopes);
}

/** 给动作提供固定 run/bin/version 的正式 API 归档提交能力。 */
export function createSourceAdapterContext<TConfig>(
  client: SourceAdapterApiClient,
  context: SourceAdapterRunContext<TConfig>,
): SourceAdapterContext<TConfig> {
  return {
    ...context,
    archive: {
      async submit(input) {
        const response = await client.archives.$post(
          {
            json: {
              ...input,
              relations: input.relations ?? [],
              requestId: input.requestId ?? randomUUID(),
              binId: context.binId,
              runId: context.runId,
              sourceAdapterVersion: context.sourceAdapterVersion,
            },
          },
          { init: { signal: context.signal } },
        );
        switch (response.status) {
          case 201:
            return await response.json();
          case 400:
          case 404:
          case 409:
          case 503: {
            const result = await response.json();
            throw new SourceAdapterActionError({
              code: result.error.code,
              message: result.error.message,
              impact: "本次资料提交未写入归档。",
              ...(result.error.path === undefined
                ? {}
                : { path: result.error.path }),
              ...(result.error.code === "invalid_input"
                ? { suggestion: "检查信源适配器整理后的资料内容。" }
                : {}),
              requiresHuman: false,
            });
          }
        }
        throw new Error("归档服务返回了未声明的提交状态。");
      },
    },
    resources: {
      upload(body, mediaType) {
        return uploadArchiveResource(client, body, mediaType);
      },
    },
  };
}

export interface SourceAdapterDefinition<
  TConfig extends z.ZodType = z.ZodType,
  TActions extends Readonly<Record<string, SourceAdapterActionShape>> & {
    readonly check: SourceAdapterActionShape;
    readonly collect: SourceAdapterActionShape;
  } = Readonly<Record<string, SourceAdapterAction>> & {
    readonly check: SourceAdapterAction;
    readonly collect: SourceAdapterAction;
  },
> {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly environment: SourceAdapterEnvironment;
  readonly configSchema: TConfig;
  readonly actions: TActions;
}

type TypedSourceAdapterActions<
  TConfig extends z.ZodType,
  TActions extends Readonly<Record<string, SourceAdapterActionSchema>> & {
    readonly check: SourceAdapterActionSchema;
    readonly collect: SourceAdapterActionSchema;
  },
> = {
  readonly [Name in keyof TActions]: SourceAdapterAction<
    TConfig,
    TActions[Name]["params"],
    TActions[Name]["output"]
  >;
};

type SourceAdapterActionSchema = {
  readonly description: string;
  readonly params: z.ZodType;
  readonly output: z.ZodType;
};

export function defineSourceAdapter<
  TConfig extends z.ZodType,
  TActions extends Readonly<Record<string, SourceAdapterActionSchema>> & {
    readonly check: SourceAdapterActionSchema;
    readonly collect: SourceAdapterActionSchema;
  },
>(definition: {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly environment: SourceAdapterEnvironment;
  readonly configSchema: TConfig;
  readonly actions: TActions & TypedSourceAdapterActions<TConfig, TActions>;
}): SourceAdapterDefinition<
  TConfig,
  TActions & TypedSourceAdapterActions<TConfig, TActions>
> {
  return definition;
}

export function sourceAdapterManifest(
  definition: SourceAdapterDefinition,
): SourceAdapterManifest {
  const manifestAction = (action: SourceAdapterActionShape) => ({
    description: action.description,
    params: z.toJSONSchema(action.params, { io: "input" }),
    output: z.toJSONSchema(action.output, { io: "output" }),
  });
  const actions = Object.fromEntries(
    Object.entries(definition.actions).map(([name, action]) => [
      name,
      manifestAction(action),
    ]),
  );
  const actionsWithRequiredActions = Object.assign(actions, {
    check: manifestAction(definition.actions.check),
    collect: manifestAction(definition.actions.collect),
  });

  return {
    id: definition.id,
    version: definition.version,
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
    environment: definition.environment,
    configSchema: z.toJSONSchema(definition.configSchema, { io: "input" }),
    actions: actionsWithRequiredActions,
  };
}
