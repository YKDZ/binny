// 信源适配器声明、运行上下文和公共错误帮助。
import { randomUUID } from "node:crypto";

import { createApiClient } from "@binny/api/client";
import type { JsonObject, SourceAdapterManifest } from "@binny/contracts";
import {
  manualRunFailureSchema,
  type ArchiveCommit,
  type ArchiveError,
  type ArchiveResourceMetadata,
  type ArchiveResourceReference,
  type ArchiveResourceResolveRequest,
  type ArchiveResourceResolveResult,
  type ArchiveSubmissionInput,
  type ManualRunFailure,
} from "@binny/contracts";
import { z } from "zod";

import type { SourceAccessClient } from "./source-access.ts";

export {
  cleanContent,
  isAcceptableMediaResponse,
  validateMediaResponse,
} from "./content-cleaner.ts";
export type {
  CleanContentMediaCandidate,
  CleanContentMediaKind,
  CleanContentOptions,
  CleanContentResult,
  ContentInputFormat,
} from "./content-cleaner.ts";

export {
  fetchValidatedMedia,
  MediaFetchError,
  submitCleanedArticle,
  uploadCleanedMedia,
} from "./article-archive.ts";
export type {
  MediaFetchOptions,
  SubmitCleanedArticleInput,
  SubmitCleanedArticleResult,
  UploadedCleanMediaResult,
} from "./article-archive.ts";

export {
  computeOngoingDocumentHash,
  createEmptyIncrementalSyncState,
  getIncrementalScopeOngoingDocument,
  hasIncrementalEntryChanged,
  hasOngoingDocumentChanged,
  incrementalEntryRecordSchema,
  incrementalOngoingDocumentRecordSchema,
  incrementalScopeStateSchema,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  pruneInactiveOngoingDocuments,
  saveIncrementalSyncState,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeEntry,
  upsertIncrementalScopeOngoingDocument,
} from "./incremental-sync.ts";
export type {
  IncrementalEntryRecord,
  IncrementalOngoingDocumentRecord,
  IncrementalScopeState,
  IncrementalSyncState,
} from "./incremental-sync.ts";

export {
  createSourceAccessBudget,
  SourceAccessBudgetExceededError,
} from "./source-access-budget.ts";
export type {
  SourceAccessBudgetClient,
  SourceAccessBudgetSnapshot,
  SourceAccessBudgetStopReason,
} from "./source-access-budget.ts";
export {
  createSourceAccessCoordinator,
  createSourceAccessClient,
  sourceAccessConfigFromAdapterConfig,
  sourceAccessConfigSchema,
  sourceAccessGroupSchema,
  sourceAccessPersistentStateSchema,
} from "./source-access.ts";
export type {
  SourceAccessAcquireInput,
  SourceAccessAdmissionOptions,
  SourceAccessClient,
  SourceAccessClock,
  SourceAccessCoordinator,
  SourceAccessCoordinatorSnapshot,
  SourceAccessConfig,
  SourceAccessCooldown,
  SourceAccessGroup,
  SourceAccessKind,
  SourceAccessLease,
  SourceAccessPersistentState,
  SourceAccessPersistentStore,
  SourceAccessRequest,
  SourceAccessResponse,
  SourceAccessResponseObservation,
  SourceAccessSnapshot,
  SourceAccessTransport,
} from "./source-access.ts";
export {
  SourceAccessDeadlineExceededError,
  SourceAccessPersistentStoreError,
  SourceAccessStateUnavailableError,
} from "./source-access.ts";

export type {
  JsonObject,
  ManualRunFailure,
  SourceAdapterManifest,
  JsonSchema,
} from "@binny/contracts";
export type {
  ArchiveCommit,
  ArchiveItemSubmissionInput,
  ArchiveResourceMetadata,
  ArchiveResourceResolveInput,
  ArchiveResourceResolveItem,
  ArchiveResourceResolveRequest,
  ArchiveResourceResolveResult,
  ArchiveSearchRequestFor,
  ArchiveSubmissionInput,
} from "@binny/contracts";

export type SourceAdapterApiClient = ReturnType<typeof createApiClient>;

export type ArchiveResourceUpload =
  | { readonly ok: true; readonly resource: ArchiveResourceMetadata }
  | { readonly ok: false; readonly error: ArchiveError };

export type SourceAdapterPersistentStateStore = {
  load(): Promise<JsonObject | undefined>;
  save(state: JsonObject): Promise<void>;
};

/**
 * A formal archive request authored with the extension type owned by the
 * adapter's `extensionsSchema`. The Core validates the same JSON Schema before
 * writing; successful retries reuse their original archive revision.
 */
export type SourceAdapterArchiveSubmission<TExtensions extends object> = Omit<
  ArchiveSubmissionInput<TExtensions>,
  "requestId" | "binId" | "runId" | "sourceAdapterVersion" | "relations"
> & {
  readonly requestId?: string;
  readonly relations?: ArchiveSubmissionInput<TExtensions>["relations"];
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

/** 向核心校验并解析已归档的资源元信息、未变化条目状态及不可变媒体。 */
export async function resolveArchiveResources(
  client: SourceAdapterApiClient,
  input: ArchiveResourceResolveRequest,
): Promise<ArchiveResourceResolveResult> {
  const response = await client.resources.resolve.$post({
    json: input,
  });
  if (response.status === 200) {
    return await response.json();
  }
  const result = await response.json();
  throw new SourceAdapterActionError({
    code: result.error.code,
    message: result.error.message,
    impact: "本次归档资源校验未完成。",
    ...(result.error.path === undefined ? {} : { path: result.error.path }),
    requiresHuman: false,
  });
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

type SourceAdapterContextBase<TConfig, TExtensions extends object> = {
  readonly binId: string;
  readonly identityId: string;
  readonly runId: string;
  readonly referenceTime: string;
  readonly sourceAdapterVersion: string;
  readonly config: TConfig;
  readonly signal: AbortSignal;
  readonly browser?: SourceAdapterBrowserConnection;
  readonly sourceAccess?: SourceAccessClient;
  readonly persistentState?: SourceAdapterPersistentStateStore;
  readonly archive: {
    /**
     * Submit public source facts and adapter-declared extensions through the
     * Core archive API. Invalid values reject with `SourceAdapterActionError`
     * and do not create a successful commit.
     */
    submit(
      input: SourceAdapterArchiveSubmission<TExtensions>,
    ): Promise<ArchiveCommit>;
  };
  readonly resources: {
    upload(body: BodyInit, mediaType: string): Promise<ArchiveResourceUpload>;
    resolve(
      input: ArchiveResourceResolveRequest,
    ): Promise<ArchiveResourceResolveResult>;
  };
};

export type SourceAdapterContext<
  TConfig = unknown,
  TReport extends z.ZodType = never,
  TExtensions extends object = {},
> = SourceAdapterContextBase<TConfig, TExtensions> &
  ([TReport] extends [never]
    ? object
    : { readonly report: (report: z.input<TReport>) => Promise<void> });

/** 按 SDK 原生 schema 异步解析原始配置或动作参数，保留 defaults/refinements/transforms。 */
export async function parseSourceAdapterInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
) {
  return await schema.safeParseAsync(input);
}

export type SourceAdapterEnvironment = SourceAdapterManifest["environment"];

export type SourceAdapterAction<
  TConfig extends z.ZodType = z.ZodType,
  TParams extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
  TReport extends z.ZodType = never,
  TExtensions extends object = {},
> = {
  readonly description: string;
  readonly params: TParams;
  readonly output: TOutput;
  readonly execute: (
    context: SourceAdapterContext<z.output<TConfig>, TReport, TExtensions>,
    params: z.output<TParams>,
  ) => Promise<z.input<TOutput>>;
  readonly [sourceAdapterExtensionsType]: TExtensions;
} & ([TReport] extends [never] ? object : { readonly report: TReport });

declare const sourceAdapterExtensionsType: unique symbol;

/** Use the adapter-owned extension schema to type archive submissions in an action. */
export function defineSourceAdapterAction<
  TConfig extends z.ZodType,
  TExtensionsSchema extends z.ZodObject,
  TParams extends z.ZodType,
  TOutput extends z.ZodType,
>(
  configSchema: TConfig,
  extensionsSchema: TExtensionsSchema,
  action: {
    readonly description: string;
    readonly params: TParams;
    readonly output: TOutput;
    readonly execute: (
      context: SourceAdapterContext<
        z.output<TConfig>,
        never,
        z.output<TExtensionsSchema>
      >,
      params: z.output<TParams>,
    ) => Promise<z.input<TOutput>>;
  },
): SourceAdapterAction<
  TConfig,
  TParams,
  TOutput,
  never,
  z.output<TExtensionsSchema>
>;
export function defineSourceAdapterAction<
  TConfig extends z.ZodType,
  TExtensionsSchema extends z.ZodObject,
  TParams extends z.ZodType,
  TOutput extends z.ZodType,
  TReport extends z.ZodType,
>(
  configSchema: TConfig,
  extensionsSchema: TExtensionsSchema,
  action: {
    readonly description: string;
    readonly params: TParams;
    readonly output: TOutput;
    readonly report: TReport;
    readonly execute: (
      context: SourceAdapterContext<
        z.output<TConfig>,
        TReport,
        z.output<TExtensionsSchema>
      >,
      params: z.output<TParams>,
    ) => Promise<z.input<TOutput>>;
  },
): SourceAdapterAction<
  TConfig,
  TParams,
  TOutput,
  TReport,
  z.output<TExtensionsSchema>
>;
export function defineSourceAdapterAction(
  configSchema: z.ZodType,
  extensionsSchema: z.ZodObject,
  action: SourceAdapterActionRuntimeShape,
): SourceAdapterActionRuntimeShape {
  void configSchema;
  void extensionsSchema;
  return action;
}

type SourceAdapterActionRuntimeShape = {
  readonly description: string;
  readonly params: z.ZodType;
  readonly output: z.ZodType;
  readonly report?: z.ZodType;
  execute(context: SourceAdapterContext, params: unknown): Promise<unknown>;
};

const sourceAdapterActionErrorType = "binny.source-adapter-action-error";
export type SourceAdapterRunContext<
  TConfig = unknown,
  TReport extends z.ZodType = z.ZodType,
> = Omit<
  SourceAdapterContextBase<TConfig, {}>,
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
} & ([TReport] extends [never]
    ? object
    : { readonly report: (report: z.input<TReport>) => Promise<void> });

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

/** Provides actions with formal API archive submission capabilities bound to run/bin/version. */
export function createSourceAdapterContext<
  TConfig,
  TExtensionsSchema extends z.ZodObject,
  TReport extends z.ZodType = z.ZodType,
>(
  client: SourceAdapterApiClient,
  context: SourceAdapterRunContext<TConfig, TReport>,
  extensionsSchema: TExtensionsSchema,
): SourceAdapterContext<TConfig, TReport, z.output<TExtensionsSchema>> {
  // The schema is passed at runtime so the context's submit type has one
  // explicit owner. Core performs value validation from its manifest schema.
  void extensionsSchema;
  const { browser, ...runContext } = context;
  return {
    ...runContext,
    ...(browser === undefined ? {} : { browser }),
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
            } as ArchiveSubmissionInput,
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
      resolve(input) {
        return resolveArchiveResources(client, {
          binId: input.binId ?? context.binId,
          ...input,
        });
      },
    },
  } as SourceAdapterContext<TConfig, TReport, z.output<TExtensionsSchema>>;
}

export interface SourceAdapterDefinition<
  TConfig extends z.ZodType = z.ZodType,
  TExtensionsSchema extends z.ZodObject = z.ZodObject,
  TActions extends Readonly<
    Record<string, SourceAdapterActionShape<z.output<TExtensionsSchema>>>
  > & {
    readonly check: SourceAdapterActionShape<z.output<TExtensionsSchema>>;
    readonly collect: SourceAdapterActionShape<z.output<TExtensionsSchema>>;
  } = Readonly<
    Record<string, SourceAdapterActionShape<z.output<TExtensionsSchema>>>
  > & {
    readonly check: SourceAdapterActionShape<z.output<TExtensionsSchema>>;
    readonly collect: SourceAdapterActionShape<z.output<TExtensionsSchema>>;
  },
> {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly environment: SourceAdapterEnvironment;
  readonly configSchema: TConfig;
  /** Owns extension values accepted by every action's archive context. */
  readonly extensionsSchema: TExtensionsSchema;
  readonly stateSchema?: z.ZodType;
  readonly stateSnapshotSchema?: z.ZodType;
  readonly actions: TActions;
}

type TypedSourceAdapterActions<
  TConfig extends z.ZodType,
  TExtensionsSchema extends z.ZodObject,
  TActions extends Readonly<
    Record<string, SourceAdapterActionShape<z.output<TExtensionsSchema>>>
  > & {
    readonly check: SourceAdapterActionShape<z.output<TExtensionsSchema>>;
    readonly collect: SourceAdapterActionShape<z.output<TExtensionsSchema>>;
  },
> = {
  readonly [Name in keyof TActions]: SourceAdapterAction<
    TConfig,
    TActions[Name]["params"],
    TActions[Name]["output"],
    TActions[Name] extends { readonly report: infer TReport extends z.ZodType }
      ? TReport
      : never,
    z.output<TExtensionsSchema>
  >;
};

type SourceAdapterActionSchema<TExtensions extends object> = {
  readonly description: string;
  readonly params: z.ZodType;
  readonly output: z.ZodType;
  readonly report?: z.ZodType;
  readonly [sourceAdapterExtensionsType]: TExtensions;
};

type SourceAdapterActionShape<TExtensions extends object> =
  SourceAdapterActionSchema<TExtensions> & SourceAdapterActionRuntimeShape;

export function defineSourceAdapter<
  TConfig extends z.ZodType,
  TExtensionsSchema extends z.ZodObject,
  TActions extends Readonly<
    Record<string, SourceAdapterActionShape<z.output<TExtensionsSchema>>>
  > & {
    readonly check: SourceAdapterActionShape<z.output<TExtensionsSchema>>;
    readonly collect: SourceAdapterActionShape<z.output<TExtensionsSchema>>;
  },
>(definition: {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly environment: SourceAdapterEnvironment;
  readonly configSchema: TConfig;
  /** This strict object schema owns the values accepted under `extensions`. */
  readonly extensionsSchema: TExtensionsSchema;
  readonly stateSchema?: z.ZodType;
  readonly stateSnapshotSchema?: z.ZodType;
  readonly actions: TActions &
    TypedSourceAdapterActions<TConfig, TExtensionsSchema, TActions>;
}): SourceAdapterDefinition<
  TConfig,
  TExtensionsSchema,
  TActions & TypedSourceAdapterActions<TConfig, TExtensionsSchema, TActions>
> {
  return definition;
}

export function sourceAdapterManifest(
  definition: SourceAdapterDefinition,
): SourceAdapterManifest {
  const manifestAction = (action: SourceAdapterActionRuntimeShape) => ({
    description: action.description,
    params: z.toJSONSchema(action.params, { io: "input" }),
    output: z.toJSONSchema(action.output, { io: "output" }),
    ...(action.report === undefined
      ? {}
      : { report: z.toJSONSchema(action.report, { io: "output" }) }),
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
    extensionsSchema: z.toJSONSchema(definition.extensionsSchema.strict(), {
      io: "input",
    }),
    ...(definition.stateSchema === undefined
      ? {}
      : {
          stateSchema: z.toJSONSchema(definition.stateSchema, { io: "output" }),
        }),
    ...(definition.stateSnapshotSchema === undefined
      ? {}
      : {
          stateSnapshotSchema: z.toJSONSchema(definition.stateSnapshotSchema, {
            io: "output",
          }),
        }),
    actions: actionsWithRequiredActions,
  };
}
