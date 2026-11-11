import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { createApiClient } from "@binny/api/client";
import { validationFailure } from "@binny/api/validation";
import {
  archiveBatchReadInputSchema,
  archiveBatchReadResponseSchema,
  archiveCommitSchema,
  archiveErrorSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveItemDeletionResultSchema,
  archiveRelationPageSchema,
  archiveResourceMetadataSchema,
  archiveRevisionDiffSchema,
  archiveRevisionReadSchema,
  archiveSearchInputIssue,
  archiveSearchInputDiagnostic,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
  archiveSnapshotSequenceSchema,
  archiveQueryContractPath,
  archiveQueryContractVersion,
  publicApiProtocolVersion,
  serviceCapabilities,
  serviceMetadataSchema,
  archiveTimelinePageSchema,
  binConfigSchemaDiscoverySchema,
  sourceAdapterExtensionFieldsDiscoverySchema,
  binDetailsSchema,
  binListSchema,
  sourceAdapterActionDiscoverySchema,
  sourceAdapterActionListSchema,
  binErrorSchema,
  binIdSchema,
  browserIdleTimeoutSecondsSchema,
  sourceAdapterActionNameSchema,
  identityIdSchema,
  humanSessionCreatedSchema,
  humanSessionErrorSchema,
  humanSessionSchema,
  jsonObjectSchema,
  manualRunErrorSchema,
  manualRunListPageSchema,
  manualRunListQuerySchema,
  manualRunSchema,
  type ManualRun,
  type SourceTime,
  postgresTextSchema,
  scheduleCreateInputSchema,
  scheduleDeleteResultSchema,
  scheduleErrorSchema,
  scheduleListPageSchema,
  scheduleListQuerySchema,
  scheduleOverlapPolicySchema,
  scheduleSchema,
  type Schedule,
  scheduleUpdateInputSchema,
  withPostgresJsonSchemaProjection,
} from "@binny/contracts";
import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  parseCliInvocation,
  schemaCapability,
  text,
  versionCapability,
  type AtomicTextPresenter,
  type DataFactUnion,
  type DataOutcome,
  type FailureFactUnion,
  type FailureOutcome,
  type OutputModeDefinition,
  type OutputModesDefinition,
  type WriteCliOutput,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import * as z from "zod";

import type { CliCommandIdentity } from "./cli-command-identity.ts";

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly write: WriteCliOutput;
  readonly identity: CliCommandIdentity;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly readStdin?: () => Promise<string>;
};

type CliDependencies = {
  readonly createClient: () => ReturnType<typeof createApiClient>;
  readonly apiUrl: string;
  readonly getServiceMetadata: () => Promise<ServiceMetadataDocument>;
  readonly readStdin?: () => Promise<string>;
};

type ServiceMetadataDocument =
  | {
      readonly ok: true;
      readonly metadata: z.infer<typeof serviceMetadataSchema>;
    }
  | { readonly ok: false; readonly error: ServiceCompatibilityFailure };

async function saveResourceBody(
  response: Response,
  outputPath: string,
): Promise<void> {
  const body = response.body;
  if (body === null) throw new Error("资源响应不包含字节正文。");
  const resolvedPath = path.resolve(outputPath);
  const temporaryPath = path.join(
    path.dirname(resolvedPath),
    `.${path.basename(resolvedPath)}.binny-${randomUUID()}.tmp`,
  );
  try {
    await pipeline(
      body,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    await rename(temporaryPath, resolvedPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

const jsonTextSchema = z.string().transform((source, context) => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    context.addIssue({
      code: "custom",
      message: "请提供有效的 JSON 内容。",
    });
    return z.NEVER;
  }
});

const jsonObjectTextSchema = withPostgresJsonSchemaProjection(
  jsonTextSchema.pipe(jsonObjectSchema),
);
const cliArchiveSearchInputSchema = z
  .object({
    query: postgresTextSchema.optional(),
    queryFile: z.string().min(1).optional(),
    queryStdin: z.boolean().optional(),
  })
  .strict();
const browserIdleTimeoutOptionSchema = z.string();

function parseBrowserIdleTimeoutOption(
  value: string,
):
  | { readonly value: number | null }
  | { readonly error: z.infer<typeof errorOutputSchema> } {
  if (value === "disabled") return { value: null };
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    return {
      error: {
        code: "invalid_input",
        message:
          "浏览器空闲关闭时长必须是 0 到 2147483 之间的整数秒，或 disabled。",
        path: ["browserIdleTimeoutSeconds"],
      },
    };
  }
  const parsed = browserIdleTimeoutSecondsSchema.safeParse(Number(value));
  return parsed.success
    ? { value: parsed.data }
    : {
        error: {
          code: "invalid_input",
          message:
            parsed.error.issues[0]?.message ?? "浏览器空闲关闭时长无效。",
          path: ["browserIdleTimeoutSeconds"],
        },
      };
}
const apiUrlOptionField = {
  kind: "valueOption",
  longOption: "--url",
  description:
    "目标服务 HTTP URL；优先于 BINNY_API_URL，默认地址为 http://localhost:3000",
} as const;

type ApiUrlOptionField = typeof apiUrlOptionField;
type ApiUrlInputField = z.ZodOptional<z.ZodString>;
type ExtendedCommandInput<Input> =
  Input extends z.ZodObject<infer Shape, infer Config>
    ? z.ZodObject<Shape & { apiUrl: ApiUrlInputField }, Config>
    : Input;
type CommandWithApiUrl<Definition> = Definition extends {
  readonly kind: "command";
  readonly fields?: infer Fields;
  readonly input: infer Input;
}
  ? Omit<Definition, "fields" | "input"> & {
      readonly fields: (Fields extends object ? Fields : {}) & {
        readonly apiUrl: ApiUrlOptionField;
      };
      readonly input: ExtendedCommandInput<Input>;
    }
  : Definition;

type CommandWithApiUrlByName<Name, Definition> = Name extends "cliContract"
  ? Definition
  : CommandWithApiUrl<Definition>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedApiUrl(invocation: unknown): string | undefined {
  if (
    !isRecord(invocation) ||
    invocation.kind !== "parsed" ||
    !isRecord(invocation.input) ||
    typeof invocation.input.apiUrl !== "string"
  ) {
    return undefined;
  }
  return invocation.input.apiUrl;
}

type CliHandlerContext = {
  readonly input: Record<string, unknown>;
  readonly dependencies: CliDependencies;
  readonly outcome: {
    readonly failure: {
      readonly apiError: (failure: ServiceCompatibilityFailure) => unknown;
    };
  };
};

function stripApiUrlFromHandlerInput(
  handler: unknown,
  checkHttpApiCompatibility: boolean,
): unknown {
  if (typeof handler !== "function") return handler;
  return async (context: unknown) => {
    if (!isRecord(context) || !isRecord(context.input)) {
      throw new Error("CLI handler input 必须是对象。");
    }
    const { apiUrl: _apiUrl, ...input } = context.input;
    const handlerContext = context as unknown as CliHandlerContext;
    if (checkHttpApiCompatibility) {
      const compatibilityFailure = await httpApiCompatibilityFailure(
        handlerContext.dependencies,
      );
      if (compatibilityFailure !== undefined) {
        return handlerContext.outcome.failure.apiError(compatibilityFailure);
      }
    }
    return await Reflect.apply(handler, undefined, [
      { ...handlerContext, input },
    ]);
  };
}

// Output modes capture the input schema at construction; command definitions must reuse it.
const outputInputs = new WeakMap<object, z.ZodType>();

// Query commands run their own compatibility checks; service info must inspect incompatible services.
const commandsWithoutAutomaticProtocolCheck = new Set([
  "serviceInfo",
  "serviceQueryContract",
  "archiveSearch",
  "archiveBatchRead",
]);

function addApiUrlOption<Commands extends Record<string, unknown>>(
  commands: Commands,
): {
  [Command in keyof Commands]: CommandWithApiUrlByName<
    Command,
    Commands[Command]
  >;
} {
  const offlineCommands = new Set(["cliContract"]);
  const extendedCommands = Object.fromEntries(
    Object.entries(commands).map(([name, definition]) => {
      if (!isRecord(definition) || definition.kind !== "command") {
        return [name, definition];
      }
      if (offlineCommands.has(name)) return [name, definition];
      if (!(definition.input instanceof z.ZodObject)) {
        throw new Error(`CLI 命令 ${name} 的输入必须是对象 schema。`);
      }
      const input = outputInputs.get(definition.outputs as object);
      if (input === undefined) {
        throw new Error(
          `CLI command ${name} must build output modes from its input schema.`,
        );
      }
      return [
        name,
        {
          ...definition,
          fields: {
            ...(isRecord(definition.fields) ? definition.fields : {}),
            apiUrl: apiUrlOptionField,
          },
          // Output modes were assembled with the extended input; reuse the same schema object here.
          input,
        },
      ];
    }),
  );
  // 每条命令的解析字段与输入 schema 同步扩展，避免另写 argv 解析器。
  return extendedCommands as {
    [Command in keyof Commands]: CommandWithApiUrlByName<
      Command,
      Commands[Command]
    >;
  };
}

const cliBinDetailsSchema = withPostgresJsonSchemaProjection(binDetailsSchema);
const cliBinListSchema = withPostgresJsonSchemaProjection(binListSchema);
const cliBinConfigSchemaDiscoverySchema = withPostgresJsonSchemaProjection(
  binConfigSchemaDiscoverySchema,
);

const cliBinActionDiscoverySchema = withPostgresJsonSchemaProjection(
  z.union([sourceAdapterActionListSchema, sourceAdapterActionDiscoverySchema]),
);
type CliActionSummary = z.infer<
  typeof sourceAdapterActionListSchema
>["actions"][string];
type CliActionDeclaration = z.infer<
  typeof sourceAdapterActionDiscoverySchema
>["actions"][string];

function isCliActionDeclaration(
  action: CliActionSummary | CliActionDeclaration,
): action is CliActionDeclaration {
  return "params" in action;
}
const cliScheduleCreateInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      binId: binIdSchema,
      expression: postgresTextSchema.min(1).max(256),
      timeZone: postgresTextSchema.min(1).max(128),
      action: sourceAdapterActionNameSchema,
      params: jsonObjectTextSchema.optional(),
      overlapPolicy: scheduleOverlapPolicySchema.default("queue"),
      disabled: z.boolean().optional(),
    })
    .strict(),
);
const cliScheduleUpdateInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      binId: binIdSchema,
      scheduleId: z.string().uuid(),
      expression: postgresTextSchema.min(1).max(256).optional(),
      timeZone: postgresTextSchema.min(1).max(128).optional(),
      action: sourceAdapterActionNameSchema.optional(),
      params: jsonObjectTextSchema.optional(),
      overlapPolicy: scheduleOverlapPolicySchema.optional(),
    })
    .strict()
    .refine(
      ({ expression, timeZone, action, params, overlapPolicy }) =>
        expression !== undefined ||
        timeZone !== undefined ||
        action !== undefined ||
        params !== undefined ||
        overlapPolicy !== undefined,
      { message: "至少提供一个需要修改的字段。" },
    ),
);
const errorOutputSchema = z.union([
  // Keep the strict archive error first: earlier non-strict variants would
  // strip optional diagnostic evidence while accepting the same fields.
  archiveErrorSchema.shape.error,
  binErrorSchema.shape.error,
  manualRunErrorSchema.shape.error,
  humanSessionErrorSchema.shape.error,
  scheduleErrorSchema.shape.error,
  z
    .object({
      code: z.enum([
        "service_metadata_unavailable",
        "service_query_contract_unavailable",
        "incompatible_http_api_protocol",
        "incompatible_archive_query_contract",
        "service_capability_unavailable",
      ]),
      message: z.string(),
    })
    .strict(),
]);
type CliApiError = z.infer<typeof errorOutputSchema>;

type ServiceCompatibilityFailure = {
  readonly code:
    | "service_metadata_unavailable"
    | "service_query_contract_unavailable"
    | "incompatible_http_api_protocol"
    | "incompatible_archive_query_contract"
    | "service_capability_unavailable";
  readonly message: string;
};

function httpApiProtocolFailure(
  httpApiVersion: number,
): ServiceCompatibilityFailure | undefined {
  if (httpApiVersion === publicApiProtocolVersion) return undefined;
  return {
    code: "incompatible_http_api_protocol",
    message:
      "服务使用 HTTP API 协议 " +
      String(httpApiVersion) +
      "；当前 CLI 支持协议 " +
      String(publicApiProtocolVersion) +
      "。",
  };
}

async function httpApiCompatibilityFailure(
  dependencies: CliDependencies,
): Promise<ServiceCompatibilityFailure | undefined> {
  const result = await dependencies.getServiceMetadata();
  if (!result.ok) return result.error;
  return httpApiProtocolFailure(result.metadata.protocols.httpApi);
}

async function queryCompatibilityFailure(
  dependencies: CliDependencies,
  capability: string,
): Promise<ServiceCompatibilityFailure | undefined> {
  const protocolFailure = await httpApiCompatibilityFailure(dependencies);
  if (protocolFailure !== undefined) return protocolFailure;

  const result = await dependencies.getServiceMetadata();
  if (!result.ok) {
    return result.error;
  }

  if (
    result.metadata.contracts.archiveQuery.version !==
      archiveQueryContractVersion ||
    result.metadata.contracts.archiveQuery.path !== archiveQueryContractPath
  ) {
    return {
      code: "incompatible_archive_query_contract",
      message:
        "服务的归档查询契约版本或入口与当前 CLI 不兼容。服务版本为 " +
        String(result.metadata.contracts.archiveQuery.version) +
        "，当前 CLI 支持版本 " +
        String(archiveQueryContractVersion) +
        "。",
    };
  }
  if (!result.metadata.capabilities.includes(capability)) {
    return {
      code: "service_capability_unavailable",
      message: "服务未公开当前查询所需的能力：" + capability + "。",
    };
  }
  return undefined;
}

const serviceQueryOperationNames = ["search", "batch-read"] as const;
const serviceQueryPartNames = ["request", "response"] as const;
type ServiceQueryOperationName = (typeof serviceQueryOperationNames)[number];
type ServiceQueryPartName = (typeof serviceQueryPartNames)[number];

// The service contract uses camelCase operation keys; CLI selectors are kebab-case.
const serviceQueryOperationSourceKeys = {
  search: "search",
  "batch-read": "batchRead",
} as const satisfies Record<ServiceQueryOperationName, string>;

const serviceQueryJsonSchema = z.record(z.string(), z.unknown());
// Only the discovery envelope is validated; each query schema stays owned by the service.
const serviceQueryContractOperationSchema = z.looseObject({
  method: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
  requestSchema: serviceQueryJsonSchema.optional(),
  responseSchema: serviceQueryJsonSchema.optional(),
});
const serviceQueryContractDocumentSchema = z.looseObject({
  version: z.int().positive(),
  operations: z.record(z.string(), serviceQueryContractOperationSchema),
});
type ServiceQueryContractDocument = z.infer<
  typeof serviceQueryContractDocumentSchema
>;

const serviceQueryContractInputSchema = z.object({
  operation: z.enum(serviceQueryOperationNames).optional(),
  part: z.enum(serviceQueryPartNames).optional(),
});

/**
 * CLI response shape. Schema values are copied from the service unchanged so
 * their internal references remain resolvable; unselected operations and parts
 * are omitted rather than truncated.
 */
const serviceQueryOperationOutputSchema = z
  .object({
    method: z.string(),
    path: z.string(),
    description: z.string().optional(),
    requestSchema: serviceQueryJsonSchema.optional(),
    responseSchema: serviceQueryJsonSchema.optional(),
  })
  .strict();
type ServiceQueryOperationOutput = z.infer<
  typeof serviceQueryOperationOutputSchema
>;
const serviceQueryContractOutputSchema = z
  .object({
    service: z
      .object({
        name: z.string(),
        version: z.string(),
      })
      .strict(),
    queryContract: z
      .object({
        version: z.int().positive(),
        path: z.string(),
        operations: z.record(z.string(), serviceQueryOperationOutputSchema),
      })
      .strict(),
  })
  .strict();
type ServiceQueryContractOutput = z.infer<
  typeof serviceQueryContractOutputSchema
>;

type ServiceQueryContractReadResult =
  | {
      readonly ok: true;
      readonly metadata: z.infer<typeof serviceMetadataSchema>;
      readonly document: ServiceQueryContractDocument;
    }
  | { readonly ok: false; readonly error: ServiceCompatibilityFailure };

/**
 * Reads the connected service's current query declarations. The CLI's local
 * archive query version is deliberately not used as a fallback: a differing
 * service version is still discoverable, but service metadata and the
 * `/meta/query` document must agree with each other.
 */
async function readServiceQueryContract(
  dependencies: CliDependencies,
): Promise<ServiceQueryContractReadResult> {
  const metadataResult = await dependencies.getServiceMetadata();
  if (!metadataResult.ok) return { ok: false, error: metadataResult.error };
  const metadata = metadataResult.metadata;

  const protocolFailure = httpApiProtocolFailure(metadata.protocols.httpApi);
  if (protocolFailure !== undefined)
    return { ok: false, error: protocolFailure };

  if (metadata.contracts.archiveQuery.path !== archiveQueryContractPath) {
    return {
      ok: false,
      error: {
        code: "incompatible_archive_query_contract",
        message:
          "The service advertises archive query contract path " +
          metadata.contracts.archiveQuery.path +
          "; this CLI reads " +
          archiveQueryContractPath +
          ".",
      },
    };
  }
  if (
    !metadata.capabilities.includes(serviceCapabilities.archiveQueryContract)
  ) {
    return {
      ok: false,
      error: {
        code: "service_capability_unavailable",
        message:
          "The service does not advertise the archive query contract capability: " +
          serviceCapabilities.archiveQueryContract +
          ".",
      },
    };
  }

  let response: Response;
  try {
    response = await dependencies.createClient().meta.query.$get();
  } catch {
    return {
      ok: false,
      error: {
        code: "service_query_contract_unavailable",
        message:
          "Cannot read the service archive query contract from " +
          archiveQueryContractPath +
          "; no local declarations were used.",
      },
    };
  }
  if (response.status !== 200) {
    return {
      ok: false,
      error: {
        code: "service_query_contract_unavailable",
        message:
          "The service did not return its archive query contract from " +
          archiveQueryContractPath +
          " (HTTP " +
          String(response.status) +
          "); no local declarations were used.",
      },
    };
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return {
      ok: false,
      error: {
        code: "service_query_contract_unavailable",
        message:
          "The service returned an invalid archive query contract; no local declarations were used.",
      },
    };
  }
  const checked = serviceQueryContractDocumentSchema.safeParse(value);
  if (!checked.success) {
    return {
      ok: false,
      error: {
        code: "service_query_contract_unavailable",
        message:
          "The service returned an invalid archive query contract; no local declarations were used.",
      },
    };
  }
  if (checked.data.version !== metadata.contracts.archiveQuery.version) {
    return {
      ok: false,
      error: {
        code: "incompatible_archive_query_contract",
        message:
          "The service archive query contract reports version " +
          String(checked.data.version) +
          " but service metadata advertises version " +
          String(metadata.contracts.archiveQuery.version) +
          ".",
      },
    };
  }
  return { ok: true, metadata, document: checked.data };
}

function selectedServiceQueryOperations(
  document: ServiceQueryContractDocument,
  operation: ServiceQueryOperationName | undefined,
): readonly ServiceQueryOperationName[] {
  if (operation !== undefined) return [operation];
  return serviceQueryOperationNames.filter(
    (name) =>
      document.operations[serviceQueryOperationSourceKeys[name]] !== undefined,
  );
}

function selectedServiceQueryOperation(
  read: Extract<ServiceQueryContractReadResult, { readonly ok: true }>,
  name: ServiceQueryOperationName,
  part: ServiceQueryPartName | undefined,
): ServiceQueryOperationOutput | ServiceCompatibilityFailure {
  const source =
    read.document.operations[serviceQueryOperationSourceKeys[name]];
  if (source === undefined) {
    return {
      code: "service_capability_unavailable",
      message:
        "The service archive query contract does not declare the " +
        name +
        " operation.",
    };
  }
  const operation: {
    method: string;
    path: string;
    description?: string;
    requestSchema?: Readonly<Record<string, unknown>>;
    responseSchema?: Readonly<Record<string, unknown>>;
  } = {
    method: source.method,
    path: source.path,
    ...(source.description === undefined
      ? {}
      : { description: source.description }),
  };
  if (part === undefined || part === "request") {
    if (source.requestSchema === undefined) {
      return {
        code: "service_query_contract_unavailable",
        message:
          "The service archive query contract does not declare a request schema for the " +
          name +
          " operation.",
      };
    }
    operation.requestSchema = source.requestSchema;
  }
  if (part === undefined || part === "response") {
    if (source.responseSchema === undefined) {
      return {
        code: "service_query_contract_unavailable",
        message:
          "The service archive query contract does not declare a response schema for the " +
          name +
          " operation.",
      };
    }
    operation.responseSchema = source.responseSchema;
  }
  return serviceQueryOperationOutputSchema.parse(operation);
}

function serviceQueryContractData(
  read: Extract<ServiceQueryContractReadResult, { readonly ok: true }>,
  operation: ServiceQueryOperationName | undefined,
  part: ServiceQueryPartName | undefined,
): ServiceQueryContractOutput | ServiceCompatibilityFailure {
  const operations: Record<string, ServiceQueryOperationOutput> = {};
  for (const name of selectedServiceQueryOperations(read.document, operation)) {
    const selected = selectedServiceQueryOperation(read, name, part);
    if ("code" in selected) return selected;
    operations[name] = selected;
  }
  if (Object.keys(operations).length === 0) {
    return {
      code: "service_capability_unavailable",
      message:
        "The service archive query contract declares none of the supported operations: " +
        serviceQueryOperationNames.join(", ") +
        ".",
    };
  }
  return {
    service: {
      name: read.metadata.product.name,
      version: read.metadata.product.version,
    },
    queryContract: {
      version: read.document.version,
      path: read.metadata.contracts.archiveQuery.path,
      operations,
    },
  };
}

function createCliContract(identity: CliCommandIdentity) {
  const define = defineCli<CliDependencies>();
  const command = (id: string) => define.command(id);
  const outputText = (heading: string, payload: unknown) =>
    text.lines([heading, ...JSON.stringify(payload, null, 2).split("\n")]);
  const sourceTimeText = (sourceTime: SourceTime | null) =>
    sourceTime === null
      ? "null"
      : `${sourceTime.value} (precision=${sourceTime.precision}${
          sourceTime.timeZone === undefined
            ? ""
            : `; timeZone=${sourceTime.timeZone}`
        })`;
  const distributionItemCountText = (count: string) =>
    `${count} ${count === "1" ? "item" : "items"}`;
  const archiveSearchPageText = (
    page: z.infer<typeof archiveSearchPageSchema>,
  ) =>
    text.lines([
      `Snapshot: ${page.snapshot.asOf}`,
      ...(page.candidatesIncluded
        ? [
            `Matches on this page: ${page.results.length}`,
            ...(page.results.length === 0
              ? ["No archived items matched."]
              : page.results.flatMap((result) => [
                  `- ${result.title ?? result.sourceKey.key}`,
                  `  Source: ${result.sourceKey.namespace}:${result.sourceKey.key}`,
                  `  Observed: ${result.observedAt}`,
                  `  Source published: ${sourceTimeText(result.sourcePublishedAt)}`,
                  `  Source modified: ${sourceTimeText(result.sourceModifiedAt)}`,
                  ...(result.timeStatus === undefined
                    ? []
                    : [`  Time review: ${result.timeStatus}`]),
                  `  Views: ${result.matches.map(({ binId }) => binId).join(", ")}`,
                  ...result.matches.flatMap(({ binId, timeMatch }) =>
                    timeMatch === undefined
                      ? []
                      : [
                          `  Time match ${binId}: ${timeMatch.status}${
                            timeMatch.status === "undetermined"
                              ? ` (${timeMatch.reason})`
                              : ""
                          }`,
                        ],
                  ),
                ])),
          ]
        : ["Candidate results were not requested."]),
      ...(page.timeSummary === undefined
        ? []
        : [
            `Certain items: ${page.timeSummary.certainItems}`,
            `Undetermined items: ${page.timeSummary.undeterminedItems}`,
          ]),
      ...(page.candidatesIncluded
        ? page.hasMore
          ? [
              `More results are available. Repeat with query.cursor set to ${page.nextCursor}.`,
            ]
          : ["End of results."]
        : []),
      ...(page.distribution === undefined
        ? []
        : [
            `Distribution by ${page.distribution.by}: ${page.distribution.totalItems} distinct matching ${page.distribution.totalItems === "1" ? "item" : "items"}.`,
            "Each group counts distinct items; one item can appear in multiple groups.",
            ...page.distribution.groups.map((group) => {
              if (group.kind === "bin") {
                return `- Bin ${group.binId}: ${distributionItemCountText(group.itemCount)}`;
              }
              if (group.kind === "date") {
                return `- Date ${group.value}: ${distributionItemCountText(group.itemCount)}`;
              }
              if (group.kind === "undetermined") {
                return `- Undetermined (${group.reason}): ${distributionItemCountText(group.itemCount)}`;
              }
              if (group.kind === "extension") {
                return `- Extension ${JSON.stringify(group.value)}: ${distributionItemCountText(group.itemCount)}`;
              }
              return `- Missing extension value: ${distributionItemCountText(group.itemCount)}`;
            }),
            ...(page.distribution.hasMore
              ? [
                  `More distribution groups are available. Repeat with query.distribution.cursor set to ${page.distribution.nextCursor}.`,
                ]
              : ["End of distribution."]),
          ]),
    ]);
  const archiveBatchReadText = (
    response: z.infer<typeof archiveBatchReadResponseSchema>,
  ) =>
    text.lines([
      `Selected references: ${String(response.results.length)}`,
      ...response.results.flatMap((result) => {
        if (result.status === "unreadable") {
          return [
            `Reference ${String(result.index)}: unreadable (${result.reason})`,
            `  Item: ${result.reference.itemId}`,
            `  Bin: ${result.reference.binId}`,
            `  Revision: ${result.reference.revisionId}`,
            `  Archive sequence: ${result.reference.archiveSeq}`,
          ];
        }

        const { reference, revision, resources } = result;
        const body = revision.state.body;
        return [
          `Reference ${String(result.index)}: readable`,
          `  Item: ${revision.itemId}`,
          `  Bin: ${reference.binId}`,
          `  Revision: ${revision.revisionId}`,
          `  Archive sequence: ${reference.archiveSeq}`,
          `  Source: ${revision.sourceKey.namespace}:${revision.sourceKey.key}`,
          `  Title: ${revision.state.title ?? "(none)"}`,
          `  Published: ${JSON.stringify(revision.state.sourcePublishedAt)}`,
          `  Modified: ${JSON.stringify(revision.state.sourceModifiedAt)}`,
          ...(revision.state.sourceRef === undefined
            ? []
            : [`  Source reference: ${revision.state.sourceRef}`]),
          ...(body === undefined
            ? ["  Body: no body representation was stored."]
            : Object.entries(body).flatMap(([format, content]) => [
                `  Body ${format}:`,
                ...String(content)
                  .split("\n")
                  .map((line) => `    ${line}`),
              ])),
          `  Capture: ${revision.state.capture.completeness}`,
          ...revision.state.capture.missing.map(
            ({ path, reason }) => `  Missing ${path}: ${reason}`,
          ),
          "  Resources:",
          ...(resources.length === 0
            ? ["    (none)"]
            : resources.map(
                ({ resourceId, status }) => `    ${resourceId}: ${status}`,
              )),
          "  Extensions:",
          ...JSON.stringify(revision.state.extensions, null, 2)
            .split("\n")
            .map((line) => `    ${line}`),
        ];
      }),
    ]);
  const jsonSection = (heading: string, payload: unknown) => [
    `${heading}:`,
    ...JSON.stringify(payload, null, 2)
      .split("\n")
      .map((line) => `  ${line}`),
  ];
  const runDetailText = (run: ManualRun) =>
    text.lines([
      "Run",
      `ID: ${run.runId}`,
      `Bin: ${run.binId}`,
      `Action: ${run.action}`,
      `Status: ${run.status}`,
      `Source adapter: ${run.sourceAdapterId}@${run.sourceAdapterVersion}`,
      `Trigger: ${run.trigger.kind}`,
      ...(run.trigger.kind === "schedule"
        ? [
            `Schedule: ${run.trigger.scheduleId}`,
            `Scheduled for: ${run.trigger.scheduledFor}`,
          ]
        : []),
      ...(run.queueReason === undefined
        ? []
        : [`Queue reason: ${run.queueReason}`]),
      `Created at: ${run.createdAt}`,
      `Reference time: ${run.referenceTime}`,
      ...(run.startedAt === undefined ? [] : [`Started at: ${run.startedAt}`]),
      ...(run.finishedAt === undefined
        ? []
        : [`Finished at: ${run.finishedAt}`]),
      ...(run.cancellationRequestedAt === undefined
        ? []
        : [`Cancellation requested at: ${run.cancellationRequestedAt}`]),
      ...(run.stopConfirmedAt === undefined
        ? []
        : [`Stop confirmed at: ${run.stopConfirmedAt}`]),
      ...(run.report === undefined ? [] : jsonSection("Report", run.report)),
      ...(run.result === undefined ? [] : jsonSection("Result", run.result)),
    ]);
  const scheduleDetailText = (schedule: Schedule) =>
    text.lines([
      "Schedule",
      `ID: ${schedule.scheduleId}`,
      `Bin: ${schedule.binId}`,
      `Action: ${schedule.action}`,
      `Expression: ${schedule.expression}`,
      `Time zone: ${schedule.timeZone}`,
      `Overlap policy: ${schedule.overlapPolicy}`,
      `Enabled: ${schedule.enabled}`,
      `Next due at: ${schedule.nextDueAt}`,
      ...(schedule.lastRunId === undefined
        ? []
        : [`Last run: ${schedule.lastRunId}`]),
      ...(schedule.lastSkip === undefined
        ? []
        : jsonSection("Last skip", schedule.lastSkip)),
      ...(schedule.lastError === undefined
        ? []
        : jsonSection("Last error", schedule.lastError)),
      `Created at: ${schedule.createdAt}`,
      `Updated at: ${schedule.updatedAt}`,
      ...jsonSection("Parameters", schedule.params),
    ]);
  const serviceMetadataText = (
    metadata: z.infer<typeof serviceMetadataSchema>,
  ) =>
    text.lines([
      `Product: ${metadata.product.name} ${metadata.product.version}`,
      `HTTP API protocol: ${metadata.protocols.httpApi}`,
      `Capabilities: ${metadata.capabilities.join(", ")}`,
      "Contracts:",
      `  Archive query v${metadata.contracts.archiveQuery.version}: ${metadata.contracts.archiveQuery.path}`,
      `Read the current service query rules: ${identity.commandName} service query-contract --operation search`,
    ]);
  const serviceQueryContractText = (discovery: ServiceQueryContractOutput) => {
    const lines: [string, ...string[]] = [
      `Service: ${discovery.service.name} ${discovery.service.version}`,
      `Query contract: v${String(discovery.queryContract.version)} at ${discovery.queryContract.path}`,
    ];
    for (const [name, operation] of Object.entries(
      discovery.queryContract.operations,
    )) {
      lines.push(
        "",
        `Operation: ${name} (${operation.method} ${operation.path})`,
        ...(operation.description === undefined
          ? []
          : [`Description: ${operation.description}`]),
        ...(operation.requestSchema === undefined
          ? []
          : jsonSection("Request schema", operation.requestSchema)),
        ...(operation.responseSchema === undefined
          ? []
          : jsonSection("Response schema", operation.responseSchema)),
      );
    }
    return text.lines(lines);
  };
  const binListText = ({ bins }: z.infer<typeof cliBinListSchema>) =>
    bins.length === 0
      ? text.line("No bins configured.")
      : text.lines([
          "ID\tADAPTER\tSTATUS\tRUNTIME",
          ...bins.map(
            ({ id, sourceAdapterId, status, execution }) =>
              `${id}\t${sourceAdapterId}\t${status}\t${execution.status}`,
          ),
        ]);
  const binDetailsText = (bin: z.infer<typeof cliBinDetailsSchema>) =>
    text.lines([
      `Bin: ${bin.id}`,
      `Source adapter: ${bin.sourceAdapterId}`,
      `Status: ${bin.status}`,
      `Runtime: ${bin.execution.status}`,
      `Source state: ${bin.sourceStateSnapshot.freshness}${
        "updatedAt" in bin.sourceStateSnapshot
          ? ` (updated ${bin.sourceStateSnapshot.updatedAt})`
          : ""
      }`,
      `Identity: ${bin.identityId}`,
      "Configuration:",
      ...JSON.stringify(bin.config, null, 2).split("\n"),
    ]);
  const actionDiscoveryText = (
    discovery: z.infer<typeof cliBinActionDiscoverySchema>,
  ) => {
    const entries = Object.entries(discovery.actions);
    if (entries.length === 0) return text.line("No actions declared.");
    const lines = entries.flatMap(([name, declaration]) => {
      if (!isCliActionDeclaration(declaration))
        return [`- ${name}: ${declaration.description}`];
      return [
        `Action: ${name}`,
        `Description: ${declaration.description}`,
        "Parameters:",
        ...JSON.stringify(declaration.params, null, 2).split("\n"),
        "Output:",
        ...JSON.stringify(declaration.output, null, 2).split("\n"),
        ...(declaration.report === undefined
          ? []
          : [
              "Report:",
              ...JSON.stringify(declaration.report, null, 2).split("\n"),
            ]),
      ];
    });
    return text.lines([lines[0]!, ...lines.slice(1)]);
  };
  const extensionFieldsText = (
    discovery: z.infer<typeof sourceAdapterExtensionFieldsDiscoverySchema>,
  ) => {
    const fields = Object.entries(discovery.fields);
    return text.lines([
      `Source adapter: ${discovery.sourceAdapterId}@${discovery.sourceAdapterVersion}`,
      ...(fields.length === 0
        ? ["No extension fields declared."]
        : [
            "Extension fields:",
            ...fields.flatMap(([name, field]) => [
              `- ${name}: ${field.type}${field.nullable ? " (nullable)" : ""}${field.required ? " (required)" : ""}`,
              ...(field.description === undefined
                ? []
                : [`  Meaning: ${field.description}`]),
              `  Operations: ${field.operations.join(", ") || "none"}`,
              ...(field.itemType === undefined
                ? []
                : [`  Item type: ${field.itemType}`]),
              ...(field.allowedValues === undefined
                ? []
                : [`  Allowed values: ${JSON.stringify(field.allowedValues)}`]),
              ...(field.allowedItemValues === undefined
                ? []
                : [
                    `  Allowed item values: ${JSON.stringify(field.allowedItemValues)}`,
                  ]),
            ]),
          ]),
      "Missing and null extension values do not match filters.",
    ]);
  };

  type Variants = Readonly<
    Record<
      string,
      Readonly<{
        description: string;
        schema: z.ZodType;
        exitCode: number;
      }>
    >
  >;
  type TextPresenters<Definitions extends Variants> = {
    readonly [Variant in keyof Definitions]: Definitions[Variant] extends {
      readonly schema: infer Schema extends z.ZodType;
    }
      ? AtomicTextPresenter<z.output<Schema>>
      : never;
  };
  type Handler<
    Command extends string,
    InputSchema extends z.ZodType,
    Success extends Variants,
    Failures extends Variants,
  > = (
    context: Readonly<{
      input: z.output<InputSchema>;
      dependencies: CliDependencies;
      outcome: DataOutcome<Command, Success> &
        FailureOutcome<Command, Failures>;
    }>,
  ) => Promise<
    DataFactUnion<Command, Success> | FailureFactUnion<Command, Failures>
  >;

  /**
   * Defines the two public modes of a business command from one handler and one
   * success/failure shape. The structured mode keeps only wire schemas; the text
   * mode adds presenters. Each invocation still executes exactly one handler.
   */
  function businessOutputs<
    const Command extends string,
    const InputSchema extends z.ZodType,
    const Success extends Variants,
    const Failures extends Variants,
  >(
    commandId: Command,
    input: InputSchema,
    definition: Readonly<{
      structuredDescription: string;
      textDescription: string;
      success: Success;
      failures: Failures;
      textSuccess: TextPresenters<Success>;
      textFailures: TextPresenters<Failures>;
      handler: Handler<Command, InputSchema, Success, Failures>;
    }>,
  ): OutputModesDefinition<Command, InputSchema> {
    const handler = stripApiUrlFromHandlerInput(
      definition.handler,
      !commandsWithoutAutomaticProtocolCheck.has(commandId),
    );
    const textSuccess = Object.fromEntries(
      Object.entries(definition.success).map(([variant, declaration]) => [
        variant,
        {
          ...declaration,
          text: definition.textSuccess[variant as keyof Success],
        },
      ]),
    );
    const textFailures = Object.fromEntries(
      Object.entries(definition.failures).map(([variant, declaration]) => [
        variant,
        {
          ...declaration,
          text: definition.textFailures[variant as keyof Failures],
        },
      ]),
    );
    // The library's per-command generics cannot infer this shared handler shape;
    // defineCli still validates the compiled contract at construction time.
    const build = (mode: {
      readonly atomic: (definition: unknown) => OutputModeDefinition;
    }) => ({
      default: "structured",
      modes: {
        structured: mode.atomic({
          description: definition.structuredDescription,
          format: "structured",
          success: { kind: "data", variants: definition.success },
          failures: definition.failures,
          handler,
        }),
        text: mode.atomic({
          description: definition.textDescription,
          format: "text",
          success: { kind: "data", variants: textSuccess },
          failures: textFailures,
          handler,
        }),
      },
    });
    const extendedInput = withPostgresJsonSchemaProjection(
      (input as unknown as z.ZodObject).safeExtend({
        apiUrl: z.string().url().optional(),
      }),
    ) as unknown as InputSchema;
    const outputs = define.outputModes(
      commandId,
      extendedInput,
      build as never,
    ) as OutputModesDefinition<Command, InputSchema>;
    outputInputs.set(outputs, extendedInput);
    return outputs;
  }

  const errorPathText = (parts: readonly (string | number)[]) =>
    parts.reduce<string>(
      (result, part) =>
        typeof part === "number"
          ? `${result}[${part}]`
          : result.length === 0
            ? part
            : `${result}.${part}`,
      "",
    );
  const candidateValuesText = (values: readonly unknown[]) =>
    values.map((value) => JSON.stringify(value)).join(", ");
  const extensionDiscoveryText = (
    discovery: NonNullable<
      NonNullable<
        z.infer<typeof archiveErrorSchema>["error"]["diagnostic"]
      >["discovery"]
    >,
  ) => [
    discovery.binId === undefined
      ? `Discover extension fields declared by source adapter ${discovery.sourceAdapterId}${discovery.sourceAdapterVersion === undefined ? "" : "@" + discovery.sourceAdapterVersion} with the current service.`
      : `Discover extension fields: ${identity.commandName} bin extension-fields ${discovery.binId}`,
  ];
  const apiErrorText = (error: CliApiError) => {
    const diagnostic = "diagnostic" in error ? error.diagnostic : undefined;
    return text.lines([
      "Request failed: " + error.message,
      ...("path" in error && error.path !== undefined
        ? [`Path: ${errorPathText(error.path)}`]
        : []),
      ...(diagnostic?.allowedValues === undefined
        ? []
        : [`Allowed values: ${candidateValuesText(diagnostic.allowedValues)}`]),
      ...(diagnostic?.allowedItemValues === undefined
        ? []
        : [
            `Allowed item values: ${candidateValuesText(diagnostic.allowedItemValues)}`,
          ]),
      ...(diagnostic?.allowedOperations === undefined
        ? []
        : [
            `Allowed operations: ${
              diagnostic.allowedOperations.length === 0
                ? "none"
                : candidateValuesText(diagnostic.allowedOperations)
            }`,
          ]),
      ...(diagnostic?.protocolOperations === undefined
        ? []
        : [
            `Protocol operations: ${candidateValuesText(diagnostic.protocolOperations)}`,
          ]),
      ...(diagnostic?.discovery === undefined
        ? []
        : extensionDiscoveryText(diagnostic.discovery)),
    ]);
  };
  const failureSchemas = {
    apiError: {
      description: "请求未能完成",
      exitCode: 1,
      schema: errorOutputSchema,
    },
  } as const;
  const failureText = {
    apiError: apiErrorText,
  } as const;

  const emptyInputSchema = z.object({});
  const archiveSearchCliInputSchema = cliArchiveSearchInputSchema;
  const archiveBatchReadCliInputSchema = z.object({
    references: postgresTextSchema.min(1),
  });
  const binIdInputSchema = z.object({ id: binIdSchema });
  const binActionsInputSchema = z.object({
    id: binIdSchema,
    action: sourceAdapterActionNameSchema.optional(),
  });
  const binUpdateInputSchema = withPostgresJsonSchemaProjection(
    z.object({
      id: binIdSchema,
      identityId: identityIdSchema.optional(),
      config: jsonObjectTextSchema.optional(),
      browserIdleTimeoutSeconds: browserIdleTimeoutOptionSchema.optional(),
    }),
  );
  const runTriggerInputSchema = withPostgresJsonSchemaProjection(
    z.object({
      binId: binIdSchema,
      action: sourceAdapterActionNameSchema,
      params: jsonObjectTextSchema.optional(),
    }),
  );
  const runGetInputSchema = z.object({
    binId: binIdSchema,
    runId: z.string().uuid(),
  });
  const humanSessionInputSchema = z.object({
    binId: binIdSchema,
    sessionId: z.string().uuid(),
  });
  const scheduleIdInputSchema = z.object({
    binId: binIdSchema,
    scheduleId: z.string().uuid(),
  });
  const archiveItemInputSchema = z.object({
    itemId: archiveIdentifierSchema,
    binId: binIdSchema.optional(),
    asOf: archiveSnapshotSequenceSchema.optional(),
  });
  const archiveDeleteInputSchema = z.object({
    itemId: archiveIdentifierSchema,
  });
  const archiveTimelineInputSchema = z.object({
    itemId: archiveIdentifierSchema,
    binId: binIdSchema.optional(),
    asOf: archiveSnapshotSequenceSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
      .optional(),
    cursor: z.string().min(1).max(4096).optional(),
  });
  const archiveRelationsInputSchema = z.object({
    itemId: archiveIdentifierSchema,
    binId: binIdSchema,
    direction: z.enum(["outgoing", "incoming"]),
    asOf: archiveSnapshotSequenceSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
      .optional(),
    cursor: z.string().min(1).max(4096).optional(),
  });
  const archiveRevisionInputSchema = z.object({
    revisionId: archiveIdentifierSchema,
  });
  const archiveRevisionDiffInputSchema = z.object({
    firstRevisionId: archiveIdentifierSchema,
    secondRevisionId: archiveIdentifierSchema,
  });
  const archiveCommitInputSchema = z.object({
    commitId: archiveIdentifierSchema,
  });
  const archiveResourceInputSchema = z.object({
    resourceId: archiveIdentifierSchema,
    saveTo: z.string().min(1),
  });

  const serviceInfoSuccess = {
    discovered: {
      description: "Service metadata and contract links",
      exitCode: 0,
      schema: serviceMetadataSchema,
    },
  } as const;
  const serviceInfoHandler: Handler<
    "serviceInfo",
    typeof emptyInputSchema,
    typeof serviceInfoSuccess,
    typeof failureSchemas
  > = async ({ dependencies, outcome }) => {
    const metadata = await dependencies.getServiceMetadata();
    if (!metadata.ok) return outcome.failure.apiError(metadata.error);
    return outcome.data.discovered(metadata.metadata);
  };
  const serviceInfoOutputs = businessOutputs("serviceInfo", emptyInputSchema, {
    structuredDescription: "Machine-readable service metadata",
    textDescription: "Readable service metadata",
    success: serviceInfoSuccess,
    failures: failureSchemas,
    textSuccess: { discovered: serviceMetadataText },
    textFailures: failureText,
    handler: serviceInfoHandler,
  });

  const serviceQueryContractSuccess = {
    discovered: {
      description: "Selected archive query contract declared by the service",
      exitCode: 0,
      schema: serviceQueryContractOutputSchema,
    },
  } as const;
  const serviceQueryContractHandler: Handler<
    "serviceQueryContract",
    typeof serviceQueryContractInputSchema,
    typeof serviceQueryContractSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const read = await readServiceQueryContract(dependencies);
    if (!read.ok) return outcome.failure.apiError(read.error);
    const data = serviceQueryContractData(read, input.operation, input.part);
    if ("code" in data) return outcome.failure.apiError(data);
    return outcome.data.discovered(data);
  };
  const serviceQueryContractOutputs = businessOutputs(
    "serviceQueryContract",
    serviceQueryContractInputSchema,
    {
      structuredDescription: "Machine-readable selected service query contract",
      textDescription: "Readable selected service query contract",
      success: serviceQueryContractSuccess,
      failures: failureSchemas,
      textSuccess: { discovered: serviceQueryContractText },
      textFailures: failureText,
      handler: serviceQueryContractHandler,
    },
  );

  const archiveSearchSuccess = {
    found: {
      description: "归档搜索结果页",
      exitCode: 0,
      schema: archiveSearchPageSchema,
    },
  } as const;
  const archiveSearchHandler: Handler<
    "archiveSearch",
    typeof archiveSearchCliInputSchema,
    typeof archiveSearchSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    let source: string;
    if (input.query !== undefined) {
      source = input.query;
    } else if (input.queryFile !== undefined) {
      try {
        source = await readFile(input.queryFile, "utf8");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return outcome.failure.apiError({
          code: "invalid_input",
          message: `Cannot read search request file: ${detail}`,
          path: ["queryFile"],
        });
      }
    } else if (input.queryStdin === true) {
      try {
        if (dependencies.readStdin === undefined)
          throw new Error("Standard input is not available.");
        source = await dependencies.readStdin();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return outcome.failure.apiError({
          code: "invalid_input",
          message: `Cannot read search request from standard input: ${detail}`,
          path: ["queryStdin"],
        });
      }
    } else {
      throw new Error("The archive search source constraint was bypassed.");
    }

    let request: unknown;
    try {
      request = JSON.parse(source) as unknown;
    } catch {
      const error = {
        code: "invalid_input" as const,
        message: "Search request must be valid JSON.",
        path: ["query"],
      };
      return outcome.failure.apiError(error);
    }
    const checked = archiveSearchInputSchema.safeParse(request);
    if (!checked.success) {
      const issue = archiveSearchInputIssue(request, checked.error.issues);
      const failure = validationFailure(
        issue === undefined ? checked.error.issues : [issue],
        { preserveOriginalMessage: true },
      );
      const diagnostic = archiveSearchInputDiagnostic(request, issue);
      return outcome.failure.apiError({
        ...failure.error,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      });
    }
    const compatibilityFailure = await queryCompatibilityFailure(
      dependencies,
      serviceCapabilities.archiveSearch,
    );
    if (compatibilityFailure !== undefined) {
      return outcome.failure.apiError(compatibilityFailure);
    }
    const response = await dependencies
      .createClient()
      .archives.search.$post({ json: checked.data });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (response.status === 400 || response.status === 422)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的归档搜索状态。");
  };
  const archiveSearchOutputs = businessOutputs(
    "archiveSearch",
    archiveSearchCliInputSchema,
    {
      structuredDescription: "Machine-readable archive search page",
      textDescription: "Readable archive search page",
      success: archiveSearchSuccess,
      failures: failureSchemas,
      textSuccess: { found: archiveSearchPageText },
      textFailures: failureText,
      handler: archiveSearchHandler,
    },
  );

  const archiveBatchReadSuccess = {
    read: {
      description: "One exact read result for every supplied reference",
      exitCode: 0,
      schema: archiveBatchReadResponseSchema,
    },
  } as const;
  const archiveBatchReadHandler: Handler<
    "archiveBatchRead",
    typeof archiveBatchReadCliInputSchema,
    typeof archiveBatchReadSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    let request: unknown;
    try {
      request = {
        references: JSON.parse(input.references) as unknown,
      };
    } catch {
      return outcome.failure.apiError({
        code: "invalid_input",
        message: "Batch read references must be valid JSON.",
        path: ["references"],
      });
    }
    const checked = archiveBatchReadInputSchema.safeParse(request);
    if (!checked.success) {
      return outcome.failure.apiError(
        validationFailure(checked.error.issues, {
          preserveOriginalMessage: true,
        }).error,
      );
    }
    const compatibilityFailure = await queryCompatibilityFailure(
      dependencies,
      serviceCapabilities.archiveBatchRead,
    );
    if (compatibilityFailure !== undefined) {
      return outcome.failure.apiError(compatibilityFailure);
    }
    const response = await dependencies
      .createClient()
      .archives["batch-read"].$post({ json: checked.data });
    if (response.status === 200)
      return outcome.data.read(await response.json());
    if (
      response.status === 400 ||
      response.status === 413 ||
      response.status === 422 ||
      response.status === 503
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("The service returned an undeclared batch-read status.");
  };
  const archiveBatchReadOutputs = businessOutputs(
    "archiveBatchRead",
    archiveBatchReadCliInputSchema,
    {
      structuredDescription: "Machine-readable exact revision read",
      textDescription: "Readable exact revision read",
      success: archiveBatchReadSuccess,
      failures: failureSchemas,
      textSuccess: { read: archiveBatchReadText },
      textFailures: failureText,
      handler: archiveBatchReadHandler,
    },
  );

  const binListSuccess = {
    listed: {
      description: "bin 列表",
      exitCode: 0,
      schema: cliBinListSchema,
    },
  } as const;
  const binListHandler: Handler<
    "binList",
    typeof emptyInputSchema,
    typeof binListSuccess,
    typeof failureSchemas
  > = async ({ dependencies, outcome }) => {
    const response = await dependencies.createClient().bins.$get();
    const result = await response.json();
    return outcome.data.listed({ bins: [...result.bins] });
  };
  const binListOutputs = businessOutputs("binList", emptyInputSchema, {
    structuredDescription: "Machine-readable bin list",
    textDescription: "Readable bin list",
    success: binListSuccess,
    failures: failureSchemas,
    textSuccess: { listed: binListText },
    textFailures: failureText,
    handler: binListHandler,
  });

  const binGetSuccess = {
    found: {
      description: "Bin configuration and status",
      exitCode: 0,
      schema: cliBinDetailsSchema,
    },
  } as const;
  const binGetHandler: Handler<
    "binGet",
    typeof binIdInputSchema,
    typeof binGetSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].$get({ param: { binId: input.id } });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的读取状态。");
  };
  const binGetOutputs = businessOutputs("binGet", binIdInputSchema, {
    structuredDescription: "Machine-readable bin configuration and status",
    textDescription: "Readable bin configuration and status",
    success: binGetSuccess,
    failures: failureSchemas,
    textSuccess: { found: binDetailsText },
    textFailures: failureText,
    handler: binGetHandler,
  });

  const binActionsSuccess = {
    discovered: {
      description: "Action names or one selected action declaration",
      exitCode: 0,
      schema: cliBinActionDiscoverySchema,
    },
  } as const;
  const binActionsHandler: Handler<
    "binActions",
    typeof binActionsInputSchema,
    typeof binActionsSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].actions.$get({
        param: { binId: input.id },
        query: input.action === undefined ? {} : { action: input.action },
      });
    if (response.status === 200)
      return outcome.data.discovered(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的动作查询状态。");
  };
  const binActionsOutputs = businessOutputs(
    "binActions",
    binActionsInputSchema,
    {
      structuredDescription: "Machine-readable action descriptions",
      textDescription: "Readable action descriptions",
      success: binActionsSuccess,
      failures: failureSchemas,
      textSuccess: { discovered: actionDiscoveryText },
      textFailures: failureText,
      handler: binActionsHandler,
    },
  );

  const binExtensionFieldsSuccess = {
    discovered: {
      description: "Declared extension fields and supported operations",
      exitCode: 0,
      schema: sourceAdapterExtensionFieldsDiscoverySchema,
    },
  } as const;
  const binExtensionFieldsHandler: Handler<
    "binExtensionFields",
    typeof binIdInputSchema,
    typeof binExtensionFieldsSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"]["extension-fields"].$get({
        param: { binId: input.id },
      });
    if (response.status === 200)
      return outcome.data.discovered(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error(
      "The service returned an undeclared extension-field status.",
    );
  };
  const binExtensionFieldsOutputs = businessOutputs(
    "binExtensionFields",
    binIdInputSchema,
    {
      structuredDescription: "Machine-readable extension-field declaration",
      textDescription: "Readable extension-field declaration",
      success: binExtensionFieldsSuccess,
      failures: failureSchemas,
      textSuccess: { discovered: extensionFieldsText },
      textFailures: failureText,
      handler: binExtensionFieldsHandler,
    },
  );

  const binConfigSchemaSuccess = {
    discovered: {
      description: "Configuration schema declaration",
      exitCode: 0,
      schema: cliBinConfigSchemaDiscoverySchema,
    },
  } as const;
  const binConfigSchemaText = (
    declaration: z.infer<typeof cliBinConfigSchemaDiscoverySchema>,
  ) =>
    text.lines([
      `Source adapter: ${declaration.sourceAdapterId}@${declaration.sourceAdapterVersion}`,
      "Configuration schema:",
      ...JSON.stringify(declaration.configSchema, null, 2).split("\n"),
    ]);
  const binConfigSchemaHandler: Handler<
    "binConfigSchema",
    typeof binIdInputSchema,
    typeof binConfigSchemaSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"]["config-schema"].$get({
        param: { binId: input.id },
      });
    if (response.status === 200)
      return outcome.data.discovered(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("The service returned an undeclared schema status.");
  };
  const binConfigSchemaOutputs = businessOutputs(
    "binConfigSchema",
    binIdInputSchema,
    {
      structuredDescription: "Machine-readable configuration schema",
      textDescription: "Readable configuration schema",
      success: binConfigSchemaSuccess,
      failures: failureSchemas,
      textSuccess: { discovered: binConfigSchemaText },
      textFailures: failureText,
      handler: binConfigSchemaHandler,
    },
  );

  const binUpdateSuccess = {
    updated: {
      description: "Updated bin configuration and status",
      exitCode: 0,
      schema: cliBinDetailsSchema,
    },
  } as const;
  const binUpdateHandler: Handler<
    "binUpdate",
    typeof binUpdateInputSchema,
    typeof binUpdateSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const { id, browserIdleTimeoutSeconds, ...fields } = input;
    const idleTimeout =
      browserIdleTimeoutSeconds === undefined
        ? undefined
        : parseBrowserIdleTimeoutOption(browserIdleTimeoutSeconds);
    if (idleTimeout !== undefined && "error" in idleTimeout)
      return outcome.failure.apiError(idleTimeout.error);
    const patch =
      idleTimeout === undefined
        ? fields
        : {
            ...fields,
            browserIdleTimeoutSeconds: idleTimeout.value,
          };
    const response = await dependencies.createClient().bins[":binId"].$patch({
      param: { binId: id },
      json: patch,
    });
    if (response.status === 200)
      return outcome.data.updated(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的修改状态。");
  };
  const binUpdateOutputs = businessOutputs("binUpdate", binUpdateInputSchema, {
    structuredDescription: "Machine-readable updated bin configuration",
    textDescription: "Readable updated bin configuration",
    success: binUpdateSuccess,
    failures: failureSchemas,
    textSuccess: { updated: binDetailsText },
    textFailures: failureText,
    handler: binUpdateHandler,
  });

  const binDisableSuccess = {
    disabled: {
      description: "Disabled bin configuration and status",
      exitCode: 0,
      schema: cliBinDetailsSchema,
    },
  } as const;
  const binDisableHandler: Handler<
    "binDisable",
    typeof binIdInputSchema,
    typeof binDisableSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].disable.$post({ param: { binId: input.id } });
    if (response.status === 200)
      return outcome.data.disabled(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的停用状态。");
  };
  const binDisableOutputs = businessOutputs("binDisable", binIdInputSchema, {
    structuredDescription: "Machine-readable disabled bin configuration",
    textDescription: "Readable disabled bin configuration",
    success: binDisableSuccess,
    failures: failureSchemas,
    textSuccess: { disabled: binDetailsText },
    textFailures: failureText,
    handler: binDisableHandler,
  });

  const binEnableSuccess = {
    enabled: {
      description: "Enabled bin configuration and status",
      exitCode: 0,
      schema: cliBinDetailsSchema,
    },
  } as const;
  const binEnableHandler: Handler<
    "binEnable",
    typeof binIdInputSchema,
    typeof binEnableSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].enable.$post({ param: { binId: input.id } });
    if (response.status === 200)
      return outcome.data.enabled(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的启用状态。");
  };
  const binEnableOutputs = businessOutputs("binEnable", binIdInputSchema, {
    structuredDescription: "Machine-readable enabled bin configuration",
    textDescription: "Readable enabled bin configuration",
    success: binEnableSuccess,
    failures: failureSchemas,
    textSuccess: { enabled: binDetailsText },
    textFailures: failureText,
    handler: binEnableHandler,
  });

  const binRemoveSuccess = {
    removed: {
      description: "已移除的 bin 配置",
      exitCode: 0,
      schema: z.object({ removed: z.literal(true), id: binIdSchema }),
    },
  } as const;
  const binRemoveHandler: Handler<
    "binRemove",
    typeof binIdInputSchema,
    typeof binRemoveSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].$delete({ param: { binId: input.id } });
    if (response.status === 200)
      return outcome.data.removed(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的移除状态。");
  };
  const binRemoveOutputs = businessOutputs("binRemove", binIdInputSchema, {
    structuredDescription: "Machine-readable removed bin configuration",
    textDescription: "Readable removed bin configuration",
    success: binRemoveSuccess,
    failures: failureSchemas,
    textSuccess: {
      removed: ({ id }) => text.line("已移除 bin 配置：" + id),
    },
    textFailures: failureText,
    handler: binRemoveHandler,
  });

  const runTriggerSuccess = {
    triggered: {
      description: "已排队的运行",
      exitCode: 0,
      schema: manualRunSchema,
    },
  } as const;
  const runTriggerHandler: Handler<
    "runTrigger",
    typeof runTriggerInputSchema,
    typeof runTriggerSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].runs.$post({
        param: { binId: input.binId },
        json: { action: input.action, params: input.params ?? {} },
      });
    if (response.status === 202)
      return outcome.data.triggered(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的运行触发状态。");
  };
  const runTriggerOutputs = businessOutputs(
    "runTrigger",
    runTriggerInputSchema,
    {
      structuredDescription: "Machine-readable queued run",
      textDescription: "Readable queued run",
      success: runTriggerSuccess,
      failures: failureSchemas,
      textSuccess: { triggered: (run) => outputText("已触发运行", run) },
      textFailures: failureText,
      handler: runTriggerHandler,
    },
  );

  const runListSuccess = {
    listed: {
      description: "Run summaries and next-page cursor",
      exitCode: 0,
      schema: manualRunListPageSchema,
    },
  } as const;
  const runListText = (page: z.infer<typeof manualRunListPageSchema>) =>
    text.lines([
      "Runs",
      ...page.runs.map(
        (run) =>
          `${run.createdAt}  ${run.binId}  ${run.action}  ${run.status}  ${run.runId}  ${identity.commandName} run get ${run.binId} ${run.runId}`,
      ),
      ...(page.nextCursor === undefined
        ? []
        : [
            `Next page: repeat the same filters and page size, then append --cursor ${page.nextCursor}`,
          ]),
    ]);
  const runListHandler: Handler<
    "runList",
    typeof manualRunListQuerySchema,
    typeof runListSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .runs.$get({ query: input });
    if (response.status === 200)
      return outcome.data.listed(await response.json());
    if (response.status === 400)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("Service returned an undeclared run-list status.");
  };
  const runListOutputs = businessOutputs("runList", manualRunListQuerySchema, {
    structuredDescription: "Machine-readable run list",
    textDescription: "Readable run list",
    success: runListSuccess,
    failures: failureSchemas,
    textSuccess: { listed: runListText },
    textFailures: failureText,
    handler: runListHandler,
  });

  const runGetSuccess = {
    found: {
      description: "Run status and result",
      exitCode: 0,
      schema: manualRunSchema,
    },
  } as const;
  const runGetHandler: Handler<
    "runGet",
    typeof runGetInputSchema,
    typeof runGetSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].runs[":runId"].$get({
        param: { binId: input.binId, runId: input.runId },
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("Service returned an undeclared run-detail status.");
  };
  const runGetOutputs = businessOutputs("runGet", runGetInputSchema, {
    structuredDescription: "Machine-readable run details",
    textDescription: "Readable run details",
    success: runGetSuccess,
    failures: failureSchemas,
    textSuccess: { found: runDetailText },
    textFailures: failureText,
    handler: runGetHandler,
  });

  const runCancelSuccess = {
    cancellation: {
      description: "取消请求及停止状态",
      exitCode: 0,
      schema: manualRunSchema,
    },
  } as const;
  const runCancelHandler: Handler<
    "runCancel",
    typeof runGetInputSchema,
    typeof runCancelSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].runs[":runId"].cancel.$post({
        param: { binId: input.binId, runId: input.runId },
      });
    if (response.status === 200)
      return outcome.data.cancellation(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的运行取消状态。");
  };
  const runCancelOutputs = businessOutputs("runCancel", runGetInputSchema, {
    structuredDescription: "Machine-readable run cancellation status",
    textDescription: "Readable run cancellation status",
    success: runCancelSuccess,
    failures: failureSchemas,
    textSuccess: {
      cancellation: (run) => outputText("运行取消状态", run),
    },
    textFailures: failureText,
    handler: runCancelHandler,
  });

  const humanOpenInputSchema = z.object({ binId: binIdSchema });
  const humanOpenSuccess = {
    opened: {
      description: "人工会话状态和临时入口",
      exitCode: 0,
      schema: humanSessionCreatedSchema.extend({
        viewerUrl: z.url(),
      }),
    },
  } as const;
  const humanOpenHandler: Handler<
    "humanOpen",
    typeof humanOpenInputSchema,
    typeof humanOpenSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"]["human-sessions"].$post({
        param: { binId: input.binId },
      });
    if (response.status === 201) {
      const session = await response.json();
      return outcome.data.opened({
        ...session,
        viewerUrl: new URL(session.viewerPath, dependencies.apiUrl).href,
      });
    }
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的浏览器会话状态。");
  };
  const humanOpenOutputs = businessOutputs("humanOpen", humanOpenInputSchema, {
    structuredDescription: "Machine-readable browser session",
    textDescription: "Readable browser session",
    success: humanOpenSuccess,
    failures: failureSchemas,
    textSuccess: { opened: (session) => outputText("浏览器维护入口", session) },
    textFailures: failureText,
    handler: humanOpenHandler,
  });

  const humanGetSuccess = {
    found: {
      description: "人工会话状态",
      exitCode: 0,
      schema: humanSessionSchema,
    },
  } as const;
  const humanGetHandler: Handler<
    "humanGet",
    typeof humanSessionInputSchema,
    typeof humanGetSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"]["human-sessions"][":sessionId"].$get({
        param: { binId: input.binId, sessionId: input.sessionId },
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的浏览器会话读取状态。");
  };
  const humanGetOutputs = businessOutputs("humanGet", humanSessionInputSchema, {
    structuredDescription: "Machine-readable browser session state",
    textDescription: "Readable browser session state",
    success: humanGetSuccess,
    failures: failureSchemas,
    textSuccess: { found: (session) => outputText("浏览器会话状态", session) },
    textFailures: failureText,
    handler: humanGetHandler,
  });

  const humanCloseSuccess = {
    closed: {
      description: "人工会话关闭状态",
      exitCode: 0,
      schema: humanSessionSchema,
    },
  } as const;
  const humanCloseHandler: Handler<
    "humanClose",
    typeof humanSessionInputSchema,
    typeof humanCloseSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"]["human-sessions"][":sessionId"].close.$post({
        param: { binId: input.binId, sessionId: input.sessionId },
      });
    if (response.status === 200)
      return outcome.data.closed(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的浏览器会话关闭状态。");
  };
  const humanCloseOutputs = businessOutputs(
    "humanClose",
    humanSessionInputSchema,
    {
      structuredDescription: "Machine-readable browser session closure",
      textDescription: "Readable browser session closure",
      success: humanCloseSuccess,
      failures: failureSchemas,
      textSuccess: {
        closed: (session) => outputText("浏览器会话关闭状态", session),
      },
      textFailures: failureText,
      handler: humanCloseHandler,
    },
  );

  const scheduleCreateSuccess = {
    created: {
      description: "已声明的运行计划",
      exitCode: 0,
      schema: scheduleSchema,
    },
  } as const;
  const scheduleCreateHandler: Handler<
    "scheduleCreate",
    typeof cliScheduleCreateInputSchema,
    typeof scheduleCreateSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const json = scheduleCreateInputSchema.parse({
      expression: input.expression,
      timeZone: input.timeZone,
      action: input.action,
      params: input.params ?? {},
      overlapPolicy: input.overlapPolicy,
      enabled: !(input.disabled ?? false),
    });
    const response = await dependencies
      .createClient()
      .bins[":binId"].schedules.$post({
        param: { binId: input.binId },
        json,
      });
    if (response.status === 201)
      return outcome.data.created(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的运行计划创建状态。");
  };
  const scheduleCreateOutputs = businessOutputs(
    "scheduleCreate",
    cliScheduleCreateInputSchema,
    {
      structuredDescription: "Machine-readable schedule details",
      textDescription: "Readable schedule details",
      success: scheduleCreateSuccess,
      failures: failureSchemas,
      textSuccess: {
        created: (schedule) => outputText("已创建运行计划", schedule),
      },
      textFailures: failureText,
      handler: scheduleCreateHandler,
    },
  );

  const scheduleListSuccess = {
    listed: {
      description: "Schedule summaries and next-page cursor",
      exitCode: 0,
      schema: scheduleListPageSchema,
    },
  } as const;
  const scheduleListText = (page: z.infer<typeof scheduleListPageSchema>) =>
    text.lines([
      "Schedules",
      ...page.schedules.map(
        (schedule) =>
          `${schedule.enabled ? "enabled" : "disabled"}  ${schedule.binId}  ${schedule.action}  ${schedule.nextDueAt}  ${schedule.scheduleId}  ${identity.commandName} schedule get ${schedule.binId} ${schedule.scheduleId}`,
      ),
      ...(page.nextCursor === undefined
        ? []
        : [
            `Next page: repeat the same filters and page size, then append --cursor ${page.nextCursor}`,
          ]),
    ]);
  const scheduleListHandler: Handler<
    "scheduleList",
    typeof scheduleListQuerySchema,
    typeof scheduleListSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .schedules.$get({ query: input });
    if (response.status === 200)
      return outcome.data.listed(await response.json());
    if (response.status === 400)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("Service returned an undeclared schedule-list status.");
  };
  const scheduleListOutputs = businessOutputs(
    "scheduleList",
    scheduleListQuerySchema,
    {
      structuredDescription: "Machine-readable schedule list",
      textDescription: "Readable schedule list",
      success: scheduleListSuccess,
      failures: failureSchemas,
      textSuccess: { listed: scheduleListText },
      textFailures: failureText,
      handler: scheduleListHandler,
    },
  );

  const scheduleGetSuccess = {
    found: {
      description: "Schedule details and action parameters",
      exitCode: 0,
      schema: scheduleSchema,
    },
  } as const;
  const scheduleGetHandler: Handler<
    "scheduleGet",
    typeof scheduleIdInputSchema,
    typeof scheduleGetSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].schedules[":scheduleId"].$get({
        param: input,
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("Service returned an undeclared schedule-detail status.");
  };
  const scheduleGetOutputs = businessOutputs(
    "scheduleGet",
    scheduleIdInputSchema,
    {
      structuredDescription: "Machine-readable schedule details",
      textDescription: "Readable schedule details",
      success: scheduleGetSuccess,
      failures: failureSchemas,
      textSuccess: { found: scheduleDetailText },
      textFailures: failureText,
      handler: scheduleGetHandler,
    },
  );

  const scheduleUpdateSuccess = {
    updated: {
      description: "已修改的运行计划",
      exitCode: 0,
      schema: scheduleSchema,
    },
  } as const;
  const scheduleUpdateHandler: Handler<
    "scheduleUpdate",
    typeof cliScheduleUpdateInputSchema,
    typeof scheduleUpdateSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const { binId, scheduleId, ...patch } = input;
    const json = scheduleUpdateInputSchema.parse(patch);
    const response = await dependencies
      .createClient()
      .bins[":binId"].schedules[":scheduleId"].$patch({
        param: { binId, scheduleId },
        json,
      });
    if (response.status === 200)
      return outcome.data.updated(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的运行计划修改状态。");
  };
  const scheduleUpdateOutputs = businessOutputs(
    "scheduleUpdate",
    cliScheduleUpdateInputSchema,
    {
      structuredDescription: "Machine-readable updated schedule",
      textDescription: "Readable updated schedule",
      success: scheduleUpdateSuccess,
      failures: failureSchemas,
      textSuccess: {
        updated: (schedule) => outputText("已修改运行计划", schedule),
      },
      textFailures: failureText,
      handler: scheduleUpdateHandler,
    },
  );

  const scheduleDisableSuccess = {
    disabled: {
      description: "已停用的运行计划",
      exitCode: 0,
      schema: scheduleSchema,
    },
  } as const;
  const scheduleDisableHandler: Handler<
    "scheduleDisable",
    typeof scheduleIdInputSchema,
    typeof scheduleDisableSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].schedules[":scheduleId"].disable.$post({
        param: input,
      });
    if (response.status === 200)
      return outcome.data.disabled(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的运行计划停用状态。");
  };
  const scheduleDisableOutputs = businessOutputs(
    "scheduleDisable",
    scheduleIdInputSchema,
    {
      structuredDescription: "Machine-readable disabled schedule",
      textDescription: "Readable disabled schedule",
      success: scheduleDisableSuccess,
      failures: failureSchemas,
      textSuccess: {
        disabled: (schedule) => outputText("已停用运行计划", schedule),
      },
      textFailures: failureText,
      handler: scheduleDisableHandler,
    },
  );

  const scheduleEnableSuccess = {
    enabled: {
      description: "已启用的运行计划",
      exitCode: 0,
      schema: scheduleSchema,
    },
  } as const;
  const scheduleEnableHandler: Handler<
    "scheduleEnable",
    typeof scheduleIdInputSchema,
    typeof scheduleEnableSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].schedules[":scheduleId"].enable.$post({
        param: input,
      });
    if (response.status === 200)
      return outcome.data.enabled(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的运行计划启用状态。");
  };
  const scheduleEnableOutputs = businessOutputs(
    "scheduleEnable",
    scheduleIdInputSchema,
    {
      structuredDescription: "Machine-readable enabled schedule",
      textDescription: "Readable enabled schedule",
      success: scheduleEnableSuccess,
      failures: failureSchemas,
      textSuccess: {
        enabled: (schedule) => outputText("已启用运行计划", schedule),
      },
      textFailures: failureText,
      handler: scheduleEnableHandler,
    },
  );

  const scheduleRemoveSuccess = {
    removed: {
      description: "已移除的运行计划",
      exitCode: 0,
      schema: scheduleDeleteResultSchema,
    },
  } as const;
  const scheduleRemoveHandler: Handler<
    "scheduleRemove",
    typeof scheduleIdInputSchema,
    typeof scheduleRemoveSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .bins[":binId"].schedules[":scheduleId"].$delete({
        param: input,
      });
    if (response.status === 200)
      return outcome.data.removed(await response.json());
    if (response.status === 400 || response.status === 404)
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的运行计划移除状态。");
  };
  const scheduleRemoveOutputs = businessOutputs(
    "scheduleRemove",
    scheduleIdInputSchema,
    {
      structuredDescription: "Machine-readable removed schedule",
      textDescription: "Readable removed schedule",
      success: scheduleRemoveSuccess,
      failures: failureSchemas,
      textSuccess: {
        removed: ({ scheduleId }) => text.line("已移除运行计划：" + scheduleId),
      },
      textFailures: failureText,
      handler: scheduleRemoveHandler,
    },
  );

  const archiveItemSuccess = {
    found: {
      description: "归档条目及观察历史",
      exitCode: 0,
      schema: archiveItemReadSchema,
    },
  } as const;
  const archiveItemHandler: Handler<
    "archiveItem",
    typeof archiveItemInputSchema,
    typeof archiveItemSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .archives.items[":itemId"].$get({
        param: { itemId: input.itemId },
        query: {
          ...(input.binId === undefined ? {} : { binId: input.binId }),
          ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
        },
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409 ||
      response.status === 503
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的归档条目读取状态。");
  };
  const archiveItemOutputs = businessOutputs(
    "archiveItem",
    archiveItemInputSchema,
    {
      structuredDescription: "Machine-readable archive item",
      textDescription: "Readable archive item",
      success: archiveItemSuccess,
      failures: failureSchemas,
      textSuccess: { found: (item) => outputText("归档条目", item) },
      textFailures: failureText,
      handler: archiveItemHandler,
    },
  );

  const archiveDeleteSuccess = {
    deleted: {
      description: "已删除的归档条目",
      exitCode: 0,
      schema: archiveItemDeletionResultSchema,
    },
  } as const;
  const archiveDeleteHandler: Handler<
    "archiveDelete",
    typeof archiveDeleteInputSchema,
    typeof archiveDeleteSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .archives.items[":itemId"].$delete({
        param: { itemId: input.itemId },
      });
    if (response.status === 200)
      return outcome.data.deleted(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409 ||
      response.status === 503
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的归档条目删除状态。");
  };
  const archiveDeleteOutputs = businessOutputs(
    "archiveDelete",
    archiveDeleteInputSchema,
    {
      structuredDescription: "Machine-readable archive deletion result",
      textDescription: "Readable archive deletion result",
      success: archiveDeleteSuccess,
      failures: failureSchemas,
      textSuccess: {
        deleted: ({ itemId, deletedItemIds }) =>
          text.line(
            "已删除归档条目：" +
              itemId +
              "；本次共删除 " +
              String(deletedItemIds.length) +
              " 项，包含各 bin 当前未撤回声明指向的条目。",
          ),
      },
      textFailures: failureText,
      handler: archiveDeleteHandler,
    },
  );

  const archiveTimelineSuccess = {
    found: {
      description: "一页观察时间线",
      exitCode: 0,
      schema: archiveTimelinePageSchema,
    },
  } as const;
  const archiveTimelineHandler: Handler<
    "archiveTimeline",
    typeof archiveTimelineInputSchema,
    typeof archiveTimelineSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .archives.items[":itemId"].timeline.$get({
        param: { itemId: input.itemId },
        query: {
          ...(input.binId === undefined ? {} : { binId: input.binId }),
          ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        },
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409 ||
      response.status === 503
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的时间线读取状态。");
  };
  const archiveTimelineOutputs = businessOutputs(
    "archiveTimeline",
    archiveTimelineInputSchema,
    {
      structuredDescription: "Machine-readable observation timeline",
      textDescription: "Readable observation timeline",
      success: archiveTimelineSuccess,
      failures: failureSchemas,
      textSuccess: { found: (timeline) => outputText("观察时间线", timeline) },
      textFailures: failureText,
      handler: archiveTimelineHandler,
    },
  );

  const archiveRelationsSuccess = {
    found: {
      description: "一页入向或出向关系",
      exitCode: 0,
      schema: archiveRelationPageSchema,
    },
  } as const;
  const archiveRelationsHandler: Handler<
    "archiveRelations",
    typeof archiveRelationsInputSchema,
    typeof archiveRelationsSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .archives.items[":itemId"].relations.$get({
        param: { itemId: input.itemId },
        query: {
          binId: input.binId,
          direction: input.direction,
          ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        },
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的关系读取状态。");
  };
  const archiveRelationsOutputs = businessOutputs(
    "archiveRelations",
    archiveRelationsInputSchema,
    {
      structuredDescription: "Machine-readable object relations",
      textDescription: "Readable object relations",
      success: archiveRelationsSuccess,
      failures: failureSchemas,
      textSuccess: { found: (page) => outputText("对象关系", page) },
      textFailures: failureText,
      handler: archiveRelationsHandler,
    },
  );

  const archiveRevisionSuccess = {
    found: {
      description: "不可变内容版本",
      exitCode: 0,
      schema: archiveRevisionReadSchema,
    },
  } as const;
  const archiveRevisionHandler: Handler<
    "archiveRevision",
    typeof archiveRevisionInputSchema,
    typeof archiveRevisionSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .archives.revisions[":revisionId"].$get({
        param: { revisionId: input.revisionId },
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409 ||
      response.status === 503
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的归档版本读取状态。");
  };
  const archiveRevisionOutputs = businessOutputs(
    "archiveRevision",
    archiveRevisionInputSchema,
    {
      structuredDescription: "Machine-readable content revision",
      textDescription: "Readable content revision",
      success: archiveRevisionSuccess,
      failures: failureSchemas,
      textSuccess: { found: (revision) => outputText("内容版本", revision) },
      textFailures: failureText,
      handler: archiveRevisionHandler,
    },
  );

  const archiveRevisionDiffSuccess = {
    found: {
      description: "内容版本差异",
      exitCode: 0,
      schema: archiveRevisionDiffSchema,
    },
  } as const;
  const archiveRevisionDiffHandler: Handler<
    "archiveRevisionDiff",
    typeof archiveRevisionDiffInputSchema,
    typeof archiveRevisionDiffSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .archives.revisions[":firstRevisionId"].diff[":secondRevisionId"].$get({
        param: {
          firstRevisionId: input.firstRevisionId,
          secondRevisionId: input.secondRevisionId,
        },
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409 ||
      response.status === 503
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的归档版本比较状态。");
  };
  const archiveRevisionDiffOutputs = businessOutputs(
    "archiveRevisionDiff",
    archiveRevisionDiffInputSchema,
    {
      structuredDescription: "Machine-readable content revision diff",
      textDescription: "Readable content revision diff",
      success: archiveRevisionDiffSuccess,
      failures: failureSchemas,
      textSuccess: { found: (diff) => outputText("内容版本差异", diff) },
      textFailures: failureText,
      handler: archiveRevisionDiffHandler,
    },
  );

  const archiveCommitSuccess = {
    found: {
      description: "归档提交依据",
      exitCode: 0,
      schema: archiveCommitSchema,
    },
  } as const;
  const archiveCommitHandler: Handler<
    "archiveCommit",
    typeof archiveCommitInputSchema,
    typeof archiveCommitSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .archives.commits[":commitId"].$get({
        param: { commitId: input.commitId },
      });
    if (response.status === 200)
      return outcome.data.found(await response.json());
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409 ||
      response.status === 503
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的归档提交读取状态。");
  };
  const archiveCommitOutputs = businessOutputs(
    "archiveCommit",
    archiveCommitInputSchema,
    {
      structuredDescription: "Machine-readable archive commit",
      textDescription: "Readable archive commit",
      success: archiveCommitSuccess,
      failures: failureSchemas,
      textSuccess: { found: (commit) => outputText("归档提交", commit) },
      textFailures: failureText,
      handler: archiveCommitHandler,
    },
  );

  const archiveResourceSuccess = {
    downloaded: {
      description: "归档资源元信息与本地保存位置",
      exitCode: 0,
      schema: archiveResourceMetadataSchema.extend({
        savedTo: z.string(),
      }),
    },
  } as const;
  const archiveResourceHandler: Handler<
    "archiveResource",
    typeof archiveResourceInputSchema,
    typeof archiveResourceSuccess,
    typeof failureSchemas
  > = async ({ input, dependencies, outcome }) => {
    const response = await dependencies
      .createClient()
      .resources[":resourceId"].$get({
        param: { resourceId: input.resourceId },
      });
    if (response.status === 200) {
      const checkedMetadata = archiveResourceMetadataSchema.safeParse({
        resourceId:
          response.headers.get("x-binny-resource-id") ?? input.resourceId,
        sha256: response.headers.get("etag")?.replace(/^"|"$/gu, ""),
        mediaType: response.headers.get("content-type"),
        size: Number(response.headers.get("content-length")),
      });
      if (!checkedMetadata.success) {
        throw new Error("服务返回的归档资源元信息无效。");
      }
      await saveResourceBody(response, input.saveTo);
      return outcome.data.downloaded({
        ...checkedMetadata.data,
        savedTo: input.saveTo,
      });
    }
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 409 ||
      response.status === 503
    )
      return outcome.failure.apiError((await response.json()).error);
    throw new Error("服务返回了未声明的归档资源读取状态。");
  };
  const archiveResourceOutputs = businessOutputs(
    "archiveResource",
    archiveResourceInputSchema,
    {
      structuredDescription: "Machine-readable saved archive resource",
      textDescription: "Readable saved archive resource",
      success: archiveResourceSuccess,
      failures: failureSchemas,
      textSuccess: {
        downloaded: ({ savedTo, size }) =>
          text.line(`已保存归档资源至 ${savedTo}（${size} 字节）。`),
      },
      textFailures: failureText,
      handler: archiveResourceHandler,
    },
  );

  let getFullContract:
    | (() => {
        readonly grammar: unknown;
        readonly manifest: unknown;
      })
    | undefined;
  const cliContractSuccess = {
    exported: {
      description: "Complete installed CLI grammar and manifest",
      exitCode: 0,
      schema: z.object({ grammar: z.unknown(), manifest: z.unknown() }),
    },
  } as const;
  const cliContractOutputs = define.outputModes(
    "cliContract",
    emptyInputSchema,
    (mode) => ({
      default: "structured",
      modes: {
        structured: mode.atomic({
          description: "Complete installed CLI contract",
          format: "structured",
          success: { kind: "data", variants: cliContractSuccess },
          failures: {},
          handler: ({ outcome }) => {
            if (getFullContract === undefined)
              throw new Error("The CLI contract is not ready.");
            return outcome.data.exported(getFullContract());
          },
        }),
      },
    }),
  );

  const contract = define({
    root: "cli",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "用法",
        commands: "命令",
        arguments: "参数",
        options: "选项",
        schema: "Schema",
        examples: "Examples",
      },
      wording: {
        commandPlaceholder: "命令",
        choices: "候选：{choices}",
        default: "默认：{value}",
        countAtLeast: "Provide at least {min} of: {fields}",
        countExactly:
          "Choose exactly {count} from these input sources: {fields}",
      },
    }),
    version: versionCapability({
      value: text.line(identity.commandName + " " + identity.version),
      shortAlias: "-V",
    }),
    schema: schemaCapability({
      description: text.line("Query the installed CLI contract offline."),
    }),
    usageFailureExitCode: 2,
    commands: addApiUrlOption({
      cli: {
        kind: "rootGroup",
        name: identity.commandName,
        description: "配置和管理 Binny 垃圾桶。",
        helpSupplement: text.lines([
          "联网命令可在具体命令后添加 --url <服务地址>；未指定时读取 BINNY_API_URL，否则使用 http://localhost:3000。",
          "Use binny --schema to browse the offline command catalog, or --schema=<target> to read input, output, failure, and wire schemas; binny contract exports the complete contract.",
        ]),
      },
      bin: {
        kind: "commandGroup",
        parent: "cli",
        name: "bin",
        description: "Inspect and manage configured bins and declared actions.",
      },
      archive: {
        kind: "commandGroup",
        parent: "cli",
        name: "archive",
        description:
          "Search, batch read, and manage archived items, relationships, and observation history.",
      },
      service: {
        kind: "commandGroup",
        parent: "cli",
        name: "service",
        description: "发现服务版本、能力和公开查询契约。",
        helpSupplement: text.lines([
          "Examples:",
          `  ${identity.commandName} service info`,
          `  ${identity.commandName} service query-contract --operation search`,
          `  ${identity.commandName} service query-contract --operation batch-read --part response`,
        ]),
      },
      run: {
        kind: "commandGroup",
        parent: "cli",
        name: "run",
        description: "触发已声明的动作并查询运行结果。",
      },
      human: {
        kind: "commandGroup",
        parent: "cli",
        name: "human",
        description: "开启或关闭浏览器人工维护会话。",
      },
      schedule: {
        kind: "commandGroup",
        parent: "cli",
        name: "schedule",
        description: "管理运行计划。",
      },
      ...command("serviceInfo")({
        kind: "command",
        parent: "service",
        name: "info",
        description: "Read service version, capabilities, and contract links.",
        helpSupplement: text.lines([
          "Use service query-contract --operation search to read the current service's search rules, or --operation batch-read to read its exact-read rules.",
        ]),
        fields: {},
        input: emptyInputSchema,
        outputs: serviceInfoOutputs,
      }),
      ...command("serviceQueryContract")({
        kind: "command",
        parent: "service",
        name: "query-contract",
        description:
          "Read the connected service's search and batch-read query rules.",
        helpSupplement: text.lines([
          "Reads /meta/query from the selected service. The response carries the service version and the contract version returned by that service.",
          "Uses the same service selection as other online commands: --url, then BINNY_API_URL, then http://localhost:3000.",
          "Without --operation and --part, returns search and batch-read request and response schemas. Narrow the selection to avoid unrelated large schemas.",
          "This command never falls back to the installed CLI's local declarations. Offline --schema and binny contract describe only the installed CLI.",
          "Fails with a structured error when the service is unreachable, its contract is invalid, or the selected operation or part is not declared.",
        ]),
        fields: {
          operation: {
            kind: "valueOption",
            longOption: "--operation",
            description: "Limit discovery to search or batch-read",
          },
          part: {
            kind: "valueOption",
            longOption: "--part",
            description: "Limit discovery to the request or response schema",
          },
        },
        examples: [
          { input: { operation: "search" } },
          { input: { operation: "batch-read", part: "request" } },
          {
            input: { operation: "search", part: "response" },
            outputMode: "text",
          },
        ],
        input: serviceQueryContractInputSchema,
        outputs: serviceQueryContractOutputs,
      }),
      ...command("archiveSearch")({
        kind: "command",
        parent: "archive",
        name: "search",
        description:
          "Search archived items with literal text groups and optional bin, extension, time-window, and distribution filters.",
        helpSupplement: text.lines([
          "Provide exactly one request source: --query <json>, --query-file <path>, or --query-stdin.",
          "Examples validate the CLI input contract only; the service still validates the search request JSON.",
          "File and stdin examples expect a request prepared as described in the README; native examples do not carry file contents or stdin bytes.",
          "Text matching is case-insensitive and literal. Values in one group use OR; multiple groups use AND.",
          "Extension filters require an explicit bin and the sourceAdapterId declared by bin extension-fields <bin-id>. String, number, integer, and boolean fields use eq/in; scalar arrays use has/hasAny. All filters combine with AND; missing and null extension values do not match.",
          'A timeWindow uses inclusive from and exclusive until local dates in its required timeZone; set review to "undetermined" to inspect views whose stored time or zone cannot decide membership.',
          "Distribution groups can use bin, local date period, or a declared extension field. Date groups require a time zone and only count source-time intervals wholly contained in one local period; other source times appear in an undetermined group with their reason.",
          "Candidate pages and distribution groups have independent limits and cursors. Reuse snapshot.asOf and the previous top-level cursor or distribution.cursor.",
          "Set includeCandidates to false to return distribution groups only. Each group counts an item once, so group counts may exceed the distinct total. One distribution dimension is available per request.",
        ]),
        examples: [
          {
            input: {
              query: '{"text":{"in":"both","groups":[["model"],["release"]]}}',
            },
          },
          {
            input: {
              query: '{"text":{"in":"both","groups":[["model"],["release"]]}}',
            },
            outputMode: "text",
          },
          {
            input: {
              query:
                '{"includeCandidates":false,"distribution":{"by":"bin","limit":100}}',
            },
          },
          {
            input: {
              query:
                '{"timeWindow":{"field":"sourcePublishedAt","from":"2026-11-08","until":"2026-11-09","timeZone":"Asia/Shanghai"}}',
            },
          },
          { input: { queryFile: "./search.json" } },
          { input: { queryStdin: true } },
        ],
        fields: {
          query: {
            kind: "valueOption",
            longOption: "--query",
            description:
              "Fixed search request JSON. Time window dates and date distributions use local calendar boundaries in their required time zone. Reuse snapshot.asOf for a consistent cut; use top-level nextCursor for candidate pages or distribution.nextCursor for distribution pages.",
          },
          queryFile: {
            kind: "valueOption",
            longOption: "--query-file",
            description:
              "Read the fixed search request from a UTF-8 JSON file.",
          },
          queryStdin: {
            kind: "flag",
            longOption: "--query-stdin",
            description: "Read the fixed search request from standard input.",
          },
        },
        usageConstraints: [
          {
            kind: "count",
            fields: ["query", "queryFile", "queryStdin"],
            min: 1,
            max: 1,
          },
        ],
        input: archiveSearchCliInputSchema,
        outputs: archiveSearchOutputs,
      }),
      ...command("archiveBatchRead")({
        kind: "command",
        parent: "archive",
        name: "batch-read",
        description:
          "Read exact revisions selected from search results without resolving the current view.",
        helpSupplement: text.lines([
          "Run archive search first, then pass the result itemId with that result's match binId, revisionId, and archiveSeq in one JSON array with --references.",
          "A request accepts 1 to 50 references and returns every result in input order, including duplicates and unreadable references. Complete responses are limited to 16 MiB; split the request into smaller batches if it exceeds the limit.",
          "Stored body representations are returned in full. Missing media is reported per resource and does not prevent an available body from being read.",
        ]),
        fields: {
          references: {
            kind: "valueOption",
            longOption: "--references",
            description:
              "JSON array of exact references copied from archive search results.",
          },
        },
        input: archiveBatchReadCliInputSchema,
        outputs: archiveBatchReadOutputs,
      }),
      ...command("binList")({
        kind: "command",
        parent: "bin",
        name: "list",
        description: "列出已配置的 bin。",
        input: emptyInputSchema,
        fields: {},
        outputs: binListOutputs,
      }),
      ...command("binGet")({
        kind: "command",
        parent: "bin",
        name: "get",
        description: "Read a bin's saved configuration and concise status.",
        helpSupplement: text.lines([
          "The response includes configuration values and runtime status. Read the full configuration schema with bin config-schema <bin-id>.",
        ]),
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: binIdInputSchema,
        outputs: binGetOutputs,
      }),
      ...command("binActions")({
        kind: "command",
        parent: "bin",
        name: "actions",
        description: "List action names or inspect one action declaration.",
        helpSupplement: text.lines([
          "Discovery reads saved declarations only. Inspect an action description before running it; actions may access their source or write archived content.",
        ]),
        fields: {
          id: { kind: "positional", description: "Bin identifier" },
          action: {
            kind: "positional",
            description: "Optional declared action name",
          },
        },
        input: binActionsInputSchema,
        outputs: binActionsOutputs,
      }),
      ...command("binExtensionFields")({
        kind: "command",
        parent: "bin",
        name: "extension-fields",
        description: "Discover one bin adapter's declared extension fields.",
        helpSupplement: text.lines([
          "This reads the saved adapter declaration and does not contact the source.",
          "Use the returned top-level field names and operations in archive search with an explicit bin scope.",
        ]),
        fields: { id: { kind: "positional", description: "Bin identifier" } },
        input: binIdInputSchema,
        outputs: binExtensionFieldsOutputs,
      }),
      ...command("binConfigSchema")({
        kind: "command",
        parent: "bin",
        name: "config-schema",
        description: "Read the full configuration schema for one bin.",
        helpSupplement: text.lines([
          "This command reads the saved schema declaration only and does not contact the source.",
        ]),
        fields: { id: { kind: "positional", description: "Bin identifier" } },
        input: binIdInputSchema,
        outputs: binConfigSchemaOutputs,
      }),
      ...command("binUpdate")({
        kind: "command",
        parent: "bin",
        name: "update",
        description: "修改访问身份、配置或浏览器空闲策略。",
        fields: {
          id: { kind: "positional", description: "bin 标识" },
          identityId: {
            kind: "valueOption",
            longOption: "--identity",
            description: "访问身份标识",
          },
          config: {
            kind: "valueOption",
            longOption: "--config",
            description:
              "Persistent configuration JSON; see bin config-schema <bin-id> for its schema.",
          },
          browserIdleTimeoutSeconds: {
            kind: "valueOption",
            longOption: "--browser-idle-timeout-seconds",
            description:
              "浏览器闲置关闭秒数；0 表示立即关闭，disabled 表示禁用",
          },
        },
        usageConstraints: [
          {
            kind: "count",
            fields: ["identityId", "config", "browserIdleTimeoutSeconds"],
            min: 1,
          },
        ],
        input: binUpdateInputSchema,
        outputs: binUpdateOutputs,
      }),
      ...command("binDisable")({
        kind: "command",
        parent: "bin",
        name: "disable",
        description: "停用信源适配器配置，但保留已归档内容。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: binIdInputSchema,
        outputs: binDisableOutputs,
      }),
      ...command("binEnable")({
        kind: "command",
        parent: "bin",
        name: "enable",
        description: "重新启用信源适配器配置。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: binIdInputSchema,
        outputs: binEnableOutputs,
      }),
      ...command("binRemove")({
        kind: "command",
        parent: "bin",
        name: "remove",
        description: "移除配置，不删除已归档内容。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: binIdInputSchema,
        outputs: binRemoveOutputs,
      }),
      ...command("runTrigger")({
        kind: "command",
        parent: "run",
        name: "trigger",
        description: "Trigger one independent action run.",
        helpSupplement: text.lines([
          "The selected action may make network requests to its source and may write archived content. Inspect bin actions <bin-id> <action> before triggering it.",
        ]),
        fields: {
          binId: { kind: "positional", description: "Bin identifier" },
          action: {
            kind: "positional",
            description:
              "Declared action name; discover actions with bin actions <bin-id>",
          },
          params: {
            kind: "valueOption",
            longOption: "--params",
            description:
              "JSON parameters for this run; use bin actions <bin-id> <action> to inspect the declaration",
          },
        },
        input: runTriggerInputSchema,
        outputs: runTriggerOutputs,
      }),
      ...command("runList")({
        kind: "command",
        parent: "run",
        name: "list",
        description:
          "List action runs across all bins with optional action, status, and creation-time filters.",
        helpSupplement: text.lines([
          "The lower creation-time bound is inclusive; the upper bound is exclusive. Continue with the same filters and page size.",
        ]),
        examples: [
          { input: { status: "failed", limit: "10" } },
          { input: { createdFrom: "2026-11-01T00:00:00Z" } },
        ],
        fields: {
          binId: {
            kind: "valueOption",
            longOption: "--bin-id",
            description: "Limit results to one bin; defaults to all bins",
          },
          action: {
            kind: "valueOption",
            longOption: "--action",
            description: "Filter by action name",
          },
          status: {
            kind: "valueOption",
            longOption: "--status",
            description: "Filter by run status",
          },
          createdFrom: {
            kind: "valueOption",
            longOption: "--created-from",
            description: "Inclusive lower bound for run creation time",
          },
          createdBefore: {
            kind: "valueOption",
            longOption: "--created-before",
            description: "Exclusive upper bound for run creation time",
          },
          limit: {
            kind: "valueOption",
            longOption: "--limit",
            description: "Rows per page; default 20, maximum 100",
          },
          cursor: {
            kind: "valueOption",
            longOption: "--cursor",
            description: "Cursor returned by the previous page",
          },
        },
        input: manualRunListQuerySchema,
        outputs: runListOutputs,
      }),
      ...command("runGet")({
        kind: "command",
        parent: "run",
        name: "get",
        description: "Read one run's status and result.",
        fields: {
          binId: { kind: "positional", description: "Bin ID" },
          runId: { kind: "positional", description: "Run ID" },
        },
        input: runGetInputSchema,
        outputs: runGetOutputs,
      }),
      ...command("runCancel")({
        kind: "command",
        parent: "run",
        name: "cancel",
        description: "请求取消运行并查看停止确认状态。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          runId: { kind: "positional", description: "运行标识" },
        },
        input: runGetInputSchema,
        outputs: runCancelOutputs,
      }),
      ...command("humanOpen")({
        kind: "command",
        parent: "human",
        name: "open",
        description: "开启同一持久浏览器的临时维护入口。",
        fields: { binId: { kind: "positional", description: "bin 标识" } },
        input: humanOpenInputSchema,
        outputs: humanOpenOutputs,
      }),
      ...command("humanGet")({
        kind: "command",
        parent: "human",
        name: "get",
        description: "读取浏览器人工会话状态。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          sessionId: { kind: "positional", description: "人工会话标识" },
        },
        input: humanSessionInputSchema,
        outputs: humanGetOutputs,
      }),
      ...command("humanClose")({
        kind: "command",
        parent: "human",
        name: "close",
        description: "关闭人工入口并回收实际连接。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          sessionId: { kind: "positional", description: "人工会话标识" },
        },
        input: humanSessionInputSchema,
        outputs: humanCloseOutputs,
      }),
      ...command("scheduleCreate")({
        kind: "command",
        parent: "schedule",
        name: "create",
        description: "Create a run schedule in an IANA time zone.",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          expression: {
            kind: "valueOption",
            longOption: "--expression",
            description: "六字段 cron 表达式",
          },
          timeZone: {
            kind: "valueOption",
            longOption: "--time-zone",
            description: "IANA 时区名称，例如 Europe/London",
          },
          action: {
            kind: "valueOption",
            longOption: "--action",
            description:
              "Declared action name; discover actions with bin actions <bin-id>",
          },
          params: {
            kind: "valueOption",
            longOption: "--params",
            description:
              "JSON parameters for this action; use bin actions <bin-id> <action> to inspect the declaration",
          },
          overlapPolicy: {
            kind: "valueOption",
            longOption: "--overlap-policy",
            description: "同计划仍有未完成运行时排队或跳过本次触发，默认 queue",
          },
          disabled: {
            kind: "flag",
            longOption: "--disabled",
            description: "先停用计划",
          },
        },
        input: cliScheduleCreateInputSchema,
        helpSupplement: text.lines([
          "A scheduled action may make network requests to its source and may write archived content whenever it runs.",
        ]),
        outputs: scheduleCreateOutputs,
      }),
      ...command("scheduleList")({
        kind: "command",
        parent: "schedule",
        name: "list",
        description:
          "List schedules across all bins with optional action and enabled-state filters.",
        helpSupplement: text.lines([
          "Continue with the same filters and page size to read every matching schedule.",
        ]),
        examples: [{ input: { enabled: "true", limit: "10" } }],
        fields: {
          binId: {
            kind: "valueOption",
            longOption: "--bin-id",
            description: "Limit results to one bin; defaults to all bins",
          },
          action: {
            kind: "valueOption",
            longOption: "--action",
            description: "Filter by action name",
          },
          enabled: {
            kind: "valueOption",
            longOption: "--enabled",
            description: "Filter by enabled state using true or false",
          },
          limit: {
            kind: "valueOption",
            longOption: "--limit",
            description: "Rows per page; default 20, maximum 100",
          },
          cursor: {
            kind: "valueOption",
            longOption: "--cursor",
            description: "Cursor returned by the previous page",
          },
        },
        input: scheduleListQuerySchema,
        outputs: scheduleListOutputs,
      }),
      ...command("scheduleGet")({
        kind: "command",
        parent: "schedule",
        name: "get",
        description: "Read one schedule and its action parameters.",
        fields: {
          binId: { kind: "positional", description: "Bin ID" },
          scheduleId: { kind: "positional", description: "Schedule ID" },
        },
        input: scheduleIdInputSchema,
        outputs: scheduleGetOutputs,
      }),
      ...command("scheduleUpdate")({
        kind: "command",
        parent: "schedule",
        name: "update",
        description: "修改计划表达式、时区、动作、参数或重叠策略。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          scheduleId: { kind: "positional", description: "计划标识" },
          expression: {
            kind: "valueOption",
            longOption: "--expression",
            description: "六字段 cron 表达式",
          },
          timeZone: {
            kind: "valueOption",
            longOption: "--time-zone",
            description: "IANA 时区名称",
          },
          action: {
            kind: "valueOption",
            longOption: "--action",
            description:
              "已声明的信源适配器动作；可用动作见 bin actions <binId>",
          },
          params: {
            kind: "valueOption",
            longOption: "--params",
            description:
              "动作参数 JSON 字符串；结构见 bin actions <binId> 的对应动作声明",
          },
          overlapPolicy: {
            kind: "valueOption",
            longOption: "--overlap-policy",
            description: "同计划仍有未完成运行时排队或跳过本次触发",
          },
        },
        input: cliScheduleUpdateInputSchema,
        outputs: scheduleUpdateOutputs,
      }),
      ...command("scheduleDisable")({
        kind: "command",
        parent: "schedule",
        name: "disable",
        description: "停用计划并跳过停用期间的到期触发。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          scheduleId: { kind: "positional", description: "计划标识" },
        },
        input: scheduleIdInputSchema,
        outputs: scheduleDisableOutputs,
      }),
      ...command("scheduleEnable")({
        kind: "command",
        parent: "schedule",
        name: "enable",
        description: "重新启用计划，从下一个未来时间点开始触发。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          scheduleId: { kind: "positional", description: "计划标识" },
        },
        input: scheduleIdInputSchema,
        outputs: scheduleEnableOutputs,
      }),
      ...command("scheduleRemove")({
        kind: "command",
        parent: "schedule",
        name: "remove",
        description: "移除计划并保留它已创建的运行来源。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          scheduleId: { kind: "positional", description: "计划标识" },
        },
        input: scheduleIdInputSchema,
        outputs: scheduleRemoveOutputs,
      }),
      ...command("archiveItem")({
        kind: "command",
        parent: "archive",
        name: "item",
        description: "读取条目及各 bin 的归档视图。",
        fields: {
          itemId: { kind: "positional", description: "归档条目 ID" },
          binId: {
            kind: "valueOption",
            longOption: "--bin",
            description: "只读取这个 bin 的视图和历史",
          },
          asOf: {
            kind: "valueOption",
            longOption: "--as-of",
            description: "使用这个归档序号作为读取截点",
          },
        },
        input: archiveItemInputSchema,
        outputs: archiveItemOutputs,
      }),
      ...command("archiveDelete")({
        kind: "command",
        parent: "archive",
        name: "delete",
        description: "删除归档条目及当前有效级联声明指向的条目。",
        fields: {
          itemId: { kind: "positional", description: "归档条目 ID" },
        },
        input: archiveDeleteInputSchema,
        outputs: archiveDeleteOutputs,
      }),
      ...command("archiveTimeline")({
        kind: "command",
        parent: "archive",
        name: "timeline",
        description: "按归档顺序读取观察及其来源时间线。",
        fields: {
          itemId: { kind: "positional", description: "归档条目 ID" },
          binId: {
            kind: "valueOption",
            longOption: "--bin",
            description: "只读取这个 bin 的观察",
          },
          asOf: {
            kind: "valueOption",
            longOption: "--as-of",
            description: "固定归档截点，跨页继续使用同一截点",
          },
          limit: {
            kind: "valueOption",
            longOption: "--limit",
            description: "每页观察数量（1 到 100）",
          },
          cursor: {
            kind: "valueOption",
            longOption: "--cursor",
            description: "继续读取上一页返回的游标",
          },
        },
        input: archiveTimelineInputSchema,
        outputs: archiveTimelineOutputs,
      }),
      ...command("archiveRelations")({
        kind: "command",
        parent: "archive",
        name: "relations",
        description: "按方向、bin 和归档截点读取对象关系。",
        fields: {
          itemId: { kind: "positional", description: "归档条目 ID" },
          binId: {
            kind: "valueOption",
            longOption: "--bin",
            description: "读取这个 bin 所知的关系状态",
          },
          direction: {
            kind: "valueOption",
            longOption: "--direction",
            description: "关系方向：outgoing 或 incoming",
          },
          asOf: {
            kind: "valueOption",
            longOption: "--as-of",
            description: "固定关系与目标解析的归档截点",
          },
          limit: {
            kind: "valueOption",
            longOption: "--limit",
            description: "每页关系数量（1 到 100）",
          },
          cursor: {
            kind: "valueOption",
            longOption: "--cursor",
            description: "继续读取上一页返回的游标",
          },
        },
        input: archiveRelationsInputSchema,
        outputs: archiveRelationsOutputs,
      }),
      ...command("archiveRevision")({
        kind: "command",
        parent: "archive",
        name: "revision",
        description: "读取一个不可变内容版本。",
        fields: {
          revisionId: { kind: "positional", description: "内容版本 ID" },
        },
        input: archiveRevisionInputSchema,
        outputs: archiveRevisionOutputs,
      }),
      ...command("archiveRevisionDiff")({
        kind: "command",
        parent: "archive",
        name: "diff",
        description: "查看同一条目的两个不可变内容版本差异。",
        fields: {
          firstRevisionId: {
            kind: "positional",
            description: "第一个比较位置的内容版本 ID",
          },
          secondRevisionId: {
            kind: "positional",
            description: "第二个比较位置的内容版本 ID",
          },
        },
        input: archiveRevisionDiffInputSchema,
        outputs: archiveRevisionDiffOutputs,
      }),
      ...command("archiveCommit")({
        kind: "command",
        parent: "archive",
        name: "commit",
        description: "读取一批归档资料的来源、时间和版本依据。",
        fields: {
          commitId: { kind: "positional", description: "归档提交 ID" },
        },
        input: archiveCommitInputSchema,
        outputs: archiveCommitOutputs,
      }),
      ...command("archiveResource")({
        kind: "command",
        parent: "archive",
        name: "resource",
        description: "将归档资源保存到本地文件。",
        fields: {
          resourceId: { kind: "positional", description: "归档资源 ID" },
          saveTo: {
            kind: "valueOption",
            longOption: "--save-to",
            description: "Local file path for the resource bytes",
          },
        },
        input: archiveResourceInputSchema,
        outputs: archiveResourceOutputs,
      }),
      ...command("cliContract")({
        kind: "command",
        parent: "cli",
        name: "contract",
        description: "Export the complete local CLI contract offline.",
        helpSupplement: text.lines([
          "This explicit export includes the complete grammar, command manifests, wire schemas, and usage failure declarations.",
          "Use --schema for layered discovery; this command is the offline complete export.",
        ]),
        fields: {},
        input: emptyInputSchema,
        outputs: cliContractOutputs,
      }),
    } as const),
  });
  getFullContract = () => ({
    grammar: contract.grammar,
    manifest: contract.manifest,
  });
  return contract;
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime.identity);
    const invocation = parseCliInvocation(contract, runtime.argv.slice(2));
    const apiUrl =
      parsedApiUrl(invocation) ?? runtime.apiUrl ?? "http://localhost:3000";
    const createClient = () =>
      createApiClient(
        apiUrl,
        runtime.fetch === undefined ? {} : { fetch: runtime.fetch },
      );
    let serviceMetadataRequest: Promise<ServiceMetadataDocument> | undefined;
    const getServiceMetadata = (): Promise<ServiceMetadataDocument> => {
      serviceMetadataRequest ??= (async () => {
        try {
          const response = await createClient().meta.$get();
          if (response.status !== 200) {
            return {
              ok: false,
              error: {
                code: "service_metadata_unavailable",
                message: "服务未提供公开元信息。",
              },
            };
          }
          const metadata = serviceMetadataSchema.safeParse(
            await response.json(),
          );
          if (!metadata.success) {
            return {
              ok: false,
              error: {
                code: "service_metadata_unavailable",
                message: "服务公开的元信息格式无效。",
              },
            };
          }
          return { ok: true, metadata: metadata.data };
        } catch {
          return {
            ok: false,
            error: {
              code: "service_metadata_unavailable",
              message:
                "Cannot read service metadata; check that --url or BINNY_API_URL points to a running service.",
            },
          };
        }
      })();
      return serviceMetadataRequest;
    };
    const result = await executeCli(contract, {
      invocation,
      dependencies: {
        apiUrl,
        createClient,
        getServiceMetadata,
        ...(runtime.readStdin === undefined
          ? {}
          : { readStdin: runtime.readStdin }),
      },
      write: runtime.write,
    });
    return result.exitCode;
  } catch (error) {
    if (
      error instanceof CliWriteError &&
      error.destination === "stdout" &&
      isNodeBrokenPipe(error)
    )
      return 0;
    try {
      await runtime.write({
        destination: "stderr",
        chunk: "命令执行失败；请检查服务地址和运行环境。\n",
      });
    } catch {
      // 诊断通道故障不能改变原定退出类别。
    }
    return 70;
  }
}
