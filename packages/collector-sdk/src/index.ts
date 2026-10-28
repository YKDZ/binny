// 采集器声明、运行上下文和公共错误帮助。
import { createApiClient } from "@binny/api/client";
import type { CollectorManifest } from "@binny/contracts";
import {
  type ArchiveError,
  type ArchiveResourceMetadata,
  type ArchiveResourceReference,
} from "@binny/contracts";
import { z } from "zod";

export type { CollectorManifest, JsonSchema } from "@binny/contracts";

type CollectorApiClient = ReturnType<typeof createApiClient>;

export type ArchiveResourceUpload =
  | { readonly ok: true; readonly resource: ArchiveResourceMetadata }
  | { readonly ok: false; readonly error: ArchiveError };

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
  readonly config: unknown;
  readonly signal: AbortSignal;
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

export function defineCollector<
  TConfig extends z.ZodType,
  TActions extends Readonly<Record<string, CollectorAction>>,
>(
  definition: CollectorDefinition<TConfig, TActions>,
): CollectorDefinition<TConfig, TActions> {
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
