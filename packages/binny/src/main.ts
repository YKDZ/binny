import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { createApiClient } from "@binny/api/client";
import { validationFailure } from "@binny/api/validation";
import {
  archiveAggregationInputSchema,
  archiveAggregationResultSchema,
  archiveCommitSchema,
  archiveErrorSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveItemDeletionResultSchema,
  archiveRelationPageSchema,
  archiveResourceMetadataSchema,
  archiveRevisionDiffSchema,
  archiveRevisionReadSchema,
  archiveSearchInputSchema,
  archiveSearchPageSchema,
  archiveSnapshotSequenceSchema,
  archiveQueryContractPath,
  archiveQueryContractVersion,
  publicApiProtocolVersion,
  serviceCapabilities,
  serviceMetadataSchema,
  archiveTimelinePageSchema,
  binConfigurationSchema,
  binCreateInputSchema,
  binErrorSchema,
  binIdSchema,
  browserIdleTimeoutSecondsSchema,
  sourceAdapterActionNameSchema,
  sourceAdapterManifestSchema,
  identityIdSchema,
  humanSessionCreatedSchema,
  humanSessionErrorSchema,
  humanSessionSchema,
  jsonObjectSchema,
  manualRunErrorSchema,
  manualRunSchema,
  postgresTextSchema,
  scheduleCreateInputSchema,
  scheduleDeleteResultSchema,
  scheduleErrorSchema,
  scheduleSchema,
  scheduleUpdateInputSchema,
  withArchiveJsonSchemaProjection,
  withPostgresJsonSchemaProjection,
} from "@binny/contracts";
import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  outputCapability,
  parseCliInvocation,
  text,
  versionCapability,
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
};

type CliDependencies = {
  readonly createClient: () => ReturnType<typeof createApiClient>;
  readonly apiUrl: string;
};

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
const cliArchiveSearchInputSchema = withArchiveJsonSchemaProjection(
  z.object({ query: postgresTextSchema.min(1) }).strict(),
);
const cliArchiveAggregationInputSchema = withArchiveJsonSchemaProjection(
  z.object({ query: postgresTextSchema.min(1) }).strict(),
);
const sourceAdapterTextSchema = withPostgresJsonSchemaProjection(
  jsonTextSchema.pipe(sourceAdapterManifestSchema),
);
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

function addApiUrlOption<Commands extends Record<string, unknown>>(
  commands: Commands,
): { [Command in keyof Commands]: CommandWithApiUrl<Commands[Command]> } {
  const extendedCommands = Object.fromEntries(
    Object.entries(commands).map(([name, definition]) => {
      if (!isRecord(definition) || definition.kind !== "command") {
        return [name, definition];
      }
      if (!(definition.input instanceof z.ZodObject)) {
        throw new Error(`CLI 命令 ${name} 的输入必须是对象 schema。`);
      }
      return [
        name,
        {
          ...definition,
          fields: {
            ...(isRecord(definition.fields) ? definition.fields : {}),
            apiUrl: apiUrlOptionField,
          },
          // safeExtend 会创建新对象；重新绑定投影以保留归档自定义 JSON 节点。
          input: withPostgresJsonSchemaProjection(
            definition.input.safeExtend({
              apiUrl: z.string().url().optional(),
            }),
          ),
        },
      ];
    }),
  );
  // 每条命令的解析字段与输入 schema 同步扩展，避免另写 argv 解析器。
  return extendedCommands as {
    [Command in keyof Commands]: CommandWithApiUrl<Commands[Command]>;
  };
}

const cliBinConfigurationSchema = withPostgresJsonSchemaProjection(
  binConfigurationSchema,
);
const cliBinListSchema = withPostgresJsonSchemaProjection(
  z.object({ bins: z.array(cliBinConfigurationSchema) }),
);
const cliScheduleListSchema = withPostgresJsonSchemaProjection(
  z.object({ schedules: z.array(scheduleSchema).readonly() }),
);
const cliScheduleCreateInputSchema = withPostgresJsonSchemaProjection(
  z
    .object({
      binId: binIdSchema,
      expression: postgresTextSchema.min(1).max(256),
      timeZone: postgresTextSchema.min(1).max(128),
      action: sourceAdapterActionNameSchema,
      params: jsonObjectTextSchema.optional(),
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
    })
    .strict()
    .refine(
      ({ expression, timeZone, action, params }) =>
        expression !== undefined ||
        timeZone !== undefined ||
        action !== undefined ||
        params !== undefined,
      { message: "至少提供一个需要修改的字段。" },
    ),
);
const errorOutputSchema = z.union([
  binErrorSchema.shape.error,
  archiveErrorSchema.shape.error,
  manualRunErrorSchema.shape.error,
  humanSessionErrorSchema.shape.error,
  scheduleErrorSchema.shape.error,
  z
    .object({
      code: z.enum([
        "service_metadata_unavailable",
        "incompatible_http_api_protocol",
        "incompatible_archive_query_contract",
        "service_capability_unavailable",
      ]),
      message: z.string(),
    })
    .strict(),
]);
type CliApiError = z.infer<typeof errorOutputSchema>;

type QueryCompatibilityFailure = {
  readonly code:
    | "service_metadata_unavailable"
    | "incompatible_http_api_protocol"
    | "incompatible_archive_query_contract"
    | "service_capability_unavailable";
  readonly message: string;
};

async function queryCompatibilityFailure(
  dependencies: CliDependencies,
  capability: string,
): Promise<QueryCompatibilityFailure | undefined> {
  const response = await dependencies.createClient().meta.$get();
  if (response.status !== 200) {
    return {
      code: "service_metadata_unavailable",
      message: "服务未提供公开元信息，无法确认查询契约兼容性。",
    };
  }

  const metadata = serviceMetadataSchema.safeParse(await response.json());
  if (!metadata.success) {
    return {
      code: "service_metadata_unavailable",
      message: "服务公开的元信息格式无效，无法确认查询契约兼容性。",
    };
  }
  if (metadata.data.protocols.httpApi !== publicApiProtocolVersion) {
    return {
      code: "incompatible_http_api_protocol",
      message:
        "服务使用 HTTP API 协议 " +
        String(metadata.data.protocols.httpApi) +
        "；当前 CLI 支持协议 " +
        String(publicApiProtocolVersion) +
        "。",
    };
  }
  if (
    metadata.data.contracts.archiveQuery.version !==
      archiveQueryContractVersion ||
    metadata.data.contracts.archiveQuery.path !== archiveQueryContractPath
  ) {
    return {
      code: "incompatible_archive_query_contract",
      message:
        "服务的归档查询契约版本或入口与当前 CLI 不兼容。服务版本为 " +
        String(metadata.data.contracts.archiveQuery.version) +
        "，当前 CLI 支持版本 " +
        String(archiveQueryContractVersion) +
        "。",
    };
  }
  if (!metadata.data.capabilities.includes(capability)) {
    return {
      code: "service_capability_unavailable",
      message: "服务未公开当前查询所需的能力：" + capability + "。",
    };
  }
  return undefined;
}

function createCliContract(identity: CliCommandIdentity) {
  const define = defineCli<CliDependencies>();
  const command = (id: string) => define.command(id);
  const outputText = (heading: string, payload: unknown) =>
    text.lines([heading, ...JSON.stringify(payload, null, 2).split("\n")]);
  const failures = {
    apiError: {
      description: "请求未能完成",
      exitCode: 1,
      schema: errorOutputSchema,
      text: ({ message }: CliApiError) => text.line("操作未完成：" + message),
    },
  };
  return define({
    root: "cli",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "用法",
        commands: "命令",
        arguments: "参数",
        options: "选项",
      },
      wording: {
        commandPlaceholder: "命令",
        choices: "候选：{choices}",
        default: "默认：{value}",
      },
    }),
    version: versionCapability({
      value: text.line(identity.commandName + " " + identity.version),
      shortAlias: "-V",
    }),
    output: outputCapability({ defaultFormat: "structured", text: true }),
    usageFailureExitCode: 2,
    commands: addApiUrlOption({
      cli: {
        kind: "rootGroup",
        name: identity.commandName,
        description: "配置和管理 Binny 垃圾桶。",
        helpSupplement: text.lines([
          "联网命令可在具体命令后添加 --url <服务地址>；未指定时读取 BINNY_API_URL，否则使用 http://localhost:3000。",
        ]),
      },
      bin: {
        kind: "commandGroup",
        parent: "cli",
        name: "bin",
        description: "管理采集配置和已声明动作。",
      },
      archive: {
        kind: "commandGroup",
        parent: "cli",
        name: "archive",
        description: "读取和删除归档资料、对象关系及观察历史。",
      },
      service: {
        kind: "commandGroup",
        parent: "cli",
        name: "service",
        description: "发现服务版本、能力和公开查询契约。",
      },
      run: {
        kind: "commandGroup",
        parent: "cli",
        name: "run",
        description: "触发采集动作并查询运行结果。",
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
        description: "管理定时采集计划。",
      },
      ...command("serviceInfo")({
        kind: "command",
        parent: "service",
        name: "info",
        description: "读取服务元信息及搜索和聚合 JSON Schema。",
        input: z.object({}),
        fields: {},
        success: {
          kind: "data",
          variants: {
            discovered: {
              description: "服务元信息与归档查询契约",
              exitCode: 0,
              schema: z.unknown(),
              text: (result) => outputText("服务元信息与归档查询契约", result),
            },
          },
        },
        failures,
        async handler({ dependencies, outcome }) {
          const metadataResponse = await dependencies
            .createClient()
            .meta.$get();
          if (metadataResponse.status !== 200) {
            return outcome.failure.apiError({
              code: "service_metadata_unavailable",
              message: "服务未提供公开元信息。",
            });
          }
          const metadata = serviceMetadataSchema.safeParse(
            await metadataResponse.json(),
          );
          if (!metadata.success) {
            return outcome.failure.apiError({
              code: "service_metadata_unavailable",
              message: "服务公开的元信息格式无效。",
            });
          }
          const contractResponse = await dependencies
            .createClient()
            .meta.query.$get();
          if (contractResponse.status !== 200) {
            return outcome.failure.apiError({
              code: "service_metadata_unavailable",
              message: "服务没有提供元信息声明的归档查询契约。",
            });
          }
          return outcome.data.discovered({
            metadata: metadata.data,
            queryContract: await contractResponse.json(),
          });
        },
      }),
      ...command("archiveSearch")({
        kind: "command",
        parent: "archive",
        name: "search",
        description: "在服务端组合检索正文与归档字段条件。",
        fields: {
          query: {
            kind: "valueOption",
            longOption: "--query",
            description: "搜索请求 JSON（与 HTTP API 使用相同契约）",
          },
        },
        input: cliArchiveSearchInputSchema,
        success: {
          kind: "data",
          variants: {
            found: {
              description: "归档搜索结果页",
              exitCode: 0,
              schema: archiveSearchPageSchema,
              text: (page) => outputText("归档搜索结果", page),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          let request: unknown;
          try {
            request = JSON.parse(input.query) as unknown;
          } catch {
            const error = {
              code: "invalid_input" as const,
              message: "搜索请求必须是有效 JSON。",
              path: ["query"],
            };
            return outcome.failure.apiError(error);
          }
          const checked = archiveSearchInputSchema.safeParse(request);
          if (!checked.success) {
            return outcome.failure.apiError(
              validationFailure(checked.error.issues).error,
            );
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
        },
      }),
      ...command("archiveAggregate")({
        kind: "command",
        parent: "archive",
        name: "aggregate",
        description: "在完整匹配集合上计算分组与指标。",
        fields: {
          query: {
            kind: "valueOption",
            longOption: "--query",
            description: "聚合请求 JSON（与 HTTP API 使用相同契约）",
          },
        },
        input: cliArchiveAggregationInputSchema,
        success: {
          kind: "data",
          variants: {
            aggregated: {
              description: "归档聚合结果页",
              exitCode: 0,
              schema: archiveAggregationResultSchema,
              text: (result) => outputText("归档聚合结果", result),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          let request: unknown;
          try {
            request = JSON.parse(input.query) as unknown;
          } catch {
            const error = {
              code: "invalid_input" as const,
              message: "聚合请求必须是有效 JSON。",
              path: ["query"],
            };
            return outcome.failure.apiError(error);
          }
          const checked = archiveAggregationInputSchema.safeParse(request);
          if (!checked.success) {
            return outcome.failure.apiError(
              validationFailure(checked.error.issues).error,
            );
          }
          const compatibilityFailure = await queryCompatibilityFailure(
            dependencies,
            serviceCapabilities.archiveAggregation,
          );
          if (compatibilityFailure !== undefined) {
            return outcome.failure.apiError(compatibilityFailure);
          }
          const response = await dependencies
            .createClient()
            .archives.aggregate.$post({ json: checked.data });
          if (response.status === 200)
            return outcome.data.aggregated(await response.json());
          if (response.status === 400 || response.status === 422)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的归档聚合状态。");
        },
      }),
      ...command("binList")({
        kind: "command",
        parent: "bin",
        name: "list",
        description: "列出已配置的 bin。",
        input: z.object({}),
        fields: {},
        success: {
          kind: "data",
          variants: {
            listed: {
              description: "bin 列表",
              exitCode: 0,
              schema: cliBinListSchema,
              text: ({ bins }) => outputText("Bin 列表", bins),
            },
          },
        },
        failures,
        async handler({ dependencies, outcome }) {
          const response = await dependencies.createClient().bins.$get();
          const result = await response.json();
          return outcome.data.listed({ bins: [...result.bins] });
        },
      }),
      ...command("binCreate")({
        kind: "command",
        parent: "bin",
        name: "create",
        description: "登记信源适配器、访问身份、配置和目标。",
        fields: {
          id: { kind: "positional", description: "稳定的 bin 标识" },
          sourceAdapter: {
            kind: "valueOption",
            longOption: "--source-adapter",
            description: "信源适配器清单 JSON",
          },
          identityId: {
            kind: "valueOption",
            longOption: "--identity",
            description: "访问身份标识",
          },
          config: {
            kind: "valueOption",
            longOption: "--config",
            description: "长期配置 JSON",
          },
          browserIdleTimeoutSeconds: {
            kind: "valueOption",
            longOption: "--browser-idle-timeout-seconds",
            description:
              "浏览器闲置关闭秒数；0 表示立即关闭，disabled 表示禁用",
          },
        },
        input: withPostgresJsonSchemaProjection(
          binCreateInputSchema
            .omit({
              id: true,
              sourceAdapter: true,
              identityId: true,
              config: true,
              browserIdleTimeoutSeconds: true,
            })
            .extend({
              id: binIdSchema,
              sourceAdapter: sourceAdapterTextSchema,
              identityId: identityIdSchema,
              config: jsonObjectTextSchema,
              browserIdleTimeoutSeconds:
                browserIdleTimeoutOptionSchema.optional(),
            }),
        ),
        success: {
          kind: "data",
          variants: {
            created: {
              description: "已登记的 bin",
              exitCode: 0,
              schema: cliBinConfigurationSchema,
              text: (bin) => outputText("已登记 bin", bin),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const { browserIdleTimeoutSeconds, ...createInput } = input;
          const idleTimeout =
            browserIdleTimeoutSeconds === undefined
              ? undefined
              : parseBrowserIdleTimeoutOption(browserIdleTimeoutSeconds);
          if (idleTimeout !== undefined && "error" in idleTimeout)
            return outcome.failure.apiError(idleTimeout.error);
          const json =
            idleTimeout === undefined
              ? createInput
              : {
                  ...createInput,
                  browserIdleTimeoutSeconds: idleTimeout.value,
                };
          const response = await dependencies
            .createClient()
            .bins.$post({ json });
          if (response.status === 201) {
            return outcome.data.created(await response.json());
          }
          if (response.status === 400 || response.status === 409) {
            return outcome.failure.apiError((await response.json()).error);
          }
          throw new Error("服务返回了未声明的创建状态。");
        },
      }),
      ...command("binGet")({
        kind: "command",
        parent: "bin",
        name: "get",
        description: "读取一个 bin 的配置和状态。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "bin 配置",
              exitCode: 0,
              schema: cliBinConfigurationSchema,
              text: (bin) => outputText("Bin 配置", bin),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].$get({ param: { binId: input.id } });
          if (response.status === 200)
            return outcome.data.found(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的读取状态。");
        },
      }),
      ...command("binActions")({
        kind: "command",
        parent: "bin",
        name: "actions",
        description: "发现信源适配器声明的动作和环境能力。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            discovered: {
              description: "已声明动作",
              exitCode: 0,
              schema: withPostgresJsonSchemaProjection(
                z.object({
                  actions: sourceAdapterManifestSchema.shape.actions,
                  environment: sourceAdapterManifestSchema.shape.environment,
                  execution: binConfigurationSchema.shape.execution,
                }),
              ),
              text: (actions) => outputText("已声明动作", actions),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].actions.$get({ param: { binId: input.id } });
          if (response.status === 200)
            return outcome.data.discovered(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的动作查询状态。");
        },
      }),
      ...command("binUpdate")({
        kind: "command",
        parent: "bin",
        name: "update",
        description:
          "修改访问身份、信源适配器版本、配置、目标或浏览器空闲策略。",
        fields: {
          id: { kind: "positional", description: "bin 标识" },
          sourceAdapter: {
            kind: "valueOption",
            longOption: "--source-adapter",
            description: "信源适配器清单 JSON",
          },
          identityId: {
            kind: "valueOption",
            longOption: "--identity",
            description: "访问身份标识",
          },
          config: {
            kind: "valueOption",
            longOption: "--config",
            description: "长期配置 JSON",
          },
          browserIdleTimeoutSeconds: {
            kind: "valueOption",
            longOption: "--browser-idle-timeout-seconds",
            description:
              "浏览器闲置关闭秒数；0 表示立即关闭，disabled 表示禁用",
          },
        },
        input: withPostgresJsonSchemaProjection(
          z
            .object({
              id: binIdSchema,
              sourceAdapter: sourceAdapterTextSchema.optional(),
              identityId: identityIdSchema.optional(),
              config: jsonObjectTextSchema.optional(),
              browserIdleTimeoutSeconds:
                browserIdleTimeoutOptionSchema.optional(),
            })
            .refine(
              ({
                sourceAdapter,
                identityId,
                config,
                browserIdleTimeoutSeconds,
              }) =>
                sourceAdapter !== undefined ||
                identityId !== undefined ||
                config !== undefined ||
                browserIdleTimeoutSeconds !== undefined,
              { message: "至少提供一个需要修改的字段。" },
            ),
        ),
        success: {
          kind: "data",
          variants: {
            updated: {
              description: "已修改的 bin",
              exitCode: 0,
              schema: cliBinConfigurationSchema,
              text: (bin) => outputText("已修改 bin", bin),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
          const response = await dependencies
            .createClient()
            .bins[":binId"].$patch({
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
        },
      }),
      ...command("binDisable")({
        kind: "command",
        parent: "bin",
        name: "disable",
        description: "停用采集配置，但保留已归档内容。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            disabled: {
              description: "已停用的 bin",
              exitCode: 0,
              schema: cliBinConfigurationSchema,
              text: (bin) => outputText("已停用 bin", bin),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].disable.$post({ param: { binId: input.id } });
          if (response.status === 200)
            return outcome.data.disabled(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的停用状态。");
        },
      }),
      ...command("binEnable")({
        kind: "command",
        parent: "bin",
        name: "enable",
        description: "重新启用采集配置。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            enabled: {
              description: "已启用的 bin",
              exitCode: 0,
              schema: cliBinConfigurationSchema,
              text: (bin) => outputText("已启用 bin", bin),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].enable.$post({ param: { binId: input.id } });
          if (response.status === 200)
            return outcome.data.enabled(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的启用状态。");
        },
      }),
      ...command("binRemove")({
        kind: "command",
        parent: "bin",
        name: "remove",
        description: "移除配置，不删除已归档内容。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            removed: {
              description: "已移除的 bin 配置",
              exitCode: 0,
              schema: z.object({ removed: z.literal(true), id: binIdSchema }),
              text: ({ id }) => text.line("已移除 bin 配置：" + id),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
      }),
      ...command("runTrigger")({
        kind: "command",
        parent: "run",
        name: "trigger",
        description: "触发一次独立采集运行。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          action: { kind: "positional", description: "已声明的动作名称" },
          params: {
            kind: "valueOption",
            longOption: "--params",
            description: "本次运行参数 JSON",
          },
        },
        input: withPostgresJsonSchemaProjection(
          z.object({
            binId: binIdSchema,
            action: sourceAdapterActionNameSchema,
            params: jsonObjectTextSchema.optional(),
          }),
        ),
        success: {
          kind: "data",
          variants: {
            triggered: {
              description: "已排队的运行",
              exitCode: 0,
              schema: manualRunSchema,
              text: (run) => outputText("已触发运行", run),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
      }),
      ...command("runGet")({
        kind: "command",
        parent: "run",
        name: "get",
        description: "读取一次运行的状态和结果。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          runId: { kind: "positional", description: "运行标识" },
        },
        input: z.object({
          binId: binIdSchema,
          runId: z.string().uuid(),
        }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "运行状态和结果",
              exitCode: 0,
              schema: manualRunSchema,
              text: (run) => outputText("运行状态", run),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].runs[":runId"].$get({
              param: { binId: input.binId, runId: input.runId },
            });
          if (response.status === 200)
            return outcome.data.found(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的运行读取状态。");
        },
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
        input: z.object({
          binId: binIdSchema,
          runId: z.string().uuid(),
        }),
        success: {
          kind: "data",
          variants: {
            cancellation: {
              description: "取消请求及停止状态",
              exitCode: 0,
              schema: manualRunSchema,
              text: (run) => outputText("运行取消状态", run),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
      }),
      ...command("humanOpen")({
        kind: "command",
        parent: "human",
        name: "open",
        description: "开启同一持久浏览器的临时维护入口。",
        fields: { binId: { kind: "positional", description: "bin 标识" } },
        input: z.object({ binId: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            opened: {
              description: "人工会话状态和临时入口",
              exitCode: 0,
              schema: humanSessionCreatedSchema.extend({
                viewerUrl: z.url(),
              }),
              text: (session) => outputText("浏览器维护入口", session),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
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
        input: z.object({ binId: binIdSchema, sessionId: z.string().uuid() }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "人工会话状态",
              exitCode: 0,
              schema: humanSessionSchema,
              text: (session) => outputText("浏览器会话状态", session),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
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
        input: z.object({ binId: binIdSchema, sessionId: z.string().uuid() }),
        success: {
          kind: "data",
          variants: {
            closed: {
              description: "人工会话关闭状态",
              exitCode: 0,
              schema: humanSessionSchema,
              text: (session) => outputText("浏览器会话关闭状态", session),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
      }),
      ...command("scheduleCreate")({
        kind: "command",
        parent: "schedule",
        name: "create",
        description: "声明一个使用 IANA 时区的采集计划。",
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
            description: "已声明的信源适配器动作",
          },
          params: {
            kind: "valueOption",
            longOption: "--params",
            description: "动作参数 JSON",
          },
          disabled: {
            kind: "flag",
            longOption: "--disabled",
            description: "先停用计划",
          },
        },
        input: cliScheduleCreateInputSchema,
        success: {
          kind: "data",
          variants: {
            created: {
              description: "已声明的采集计划",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("已创建采集计划", schedule),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const json = scheduleCreateInputSchema.parse({
            expression: input.expression,
            timeZone: input.timeZone,
            action: input.action,
            params: input.params ?? {},
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
          throw new Error("服务返回了未声明的采集计划创建状态。");
        },
      }),
      ...command("scheduleList")({
        kind: "command",
        parent: "schedule",
        name: "list",
        description: "列出一个 bin 的采集计划。",
        fields: { binId: { kind: "positional", description: "bin 标识" } },
        input: z.object({ binId: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            listed: {
              description: "采集计划列表",
              exitCode: 0,
              schema: cliScheduleListSchema,
              text: (result) => outputText("采集计划", result),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].schedules.$get({ param: { binId: input.binId } });
          if (response.status === 200)
            return outcome.data.listed(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的采集计划列表状态。");
        },
      }),
      ...command("scheduleGet")({
        kind: "command",
        parent: "schedule",
        name: "get",
        description: "读取一个采集计划。",
        fields: {
          binId: { kind: "positional", description: "bin 标识" },
          scheduleId: { kind: "positional", description: "计划标识" },
        },
        input: z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "采集计划详情",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("采集计划", schedule),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].schedules[":scheduleId"].$get({
              param: input,
            });
          if (response.status === 200)
            return outcome.data.found(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的采集计划读取状态。");
        },
      }),
      ...command("scheduleUpdate")({
        kind: "command",
        parent: "schedule",
        name: "update",
        description: "修改计划表达式、时区、动作或参数。",
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
            description: "已声明的信源适配器动作",
          },
          params: {
            kind: "valueOption",
            longOption: "--params",
            description: "动作参数 JSON",
          },
        },
        input: cliScheduleUpdateInputSchema,
        success: {
          kind: "data",
          variants: {
            updated: {
              description: "已修改的采集计划",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("已修改采集计划", schedule),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
          throw new Error("服务返回了未声明的采集计划修改状态。");
        },
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
        input: z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        success: {
          kind: "data",
          variants: {
            disabled: {
              description: "已停用的采集计划",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("已停用采集计划", schedule),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].schedules[":scheduleId"].disable.$post({
              param: input,
            });
          if (response.status === 200)
            return outcome.data.disabled(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的采集计划停用状态。");
        },
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
        input: z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        success: {
          kind: "data",
          variants: {
            enabled: {
              description: "已启用的采集计划",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("已启用采集计划", schedule),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].schedules[":scheduleId"].enable.$post({
              param: input,
            });
          if (response.status === 200)
            return outcome.data.enabled(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的采集计划启用状态。");
        },
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
        input: z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        success: {
          kind: "data",
          variants: {
            removed: {
              description: "已移除的采集计划",
              exitCode: 0,
              schema: scheduleDeleteResultSchema,
              text: ({ scheduleId }) =>
                text.line("已移除采集计划：" + scheduleId),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins[":binId"].schedules[":scheduleId"].$delete({
              param: input,
            });
          if (response.status === 200)
            return outcome.data.removed(await response.json());
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的采集计划移除状态。");
        },
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
        input: z.object({
          itemId: archiveIdentifierSchema,
          binId: binIdSchema.optional(),
          asOf: archiveSnapshotSequenceSchema.optional(),
        }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "归档条目及观察历史",
              exitCode: 0,
              schema: archiveItemReadSchema,
              text: (item) => outputText("归档条目", item),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
      }),
      ...command("archiveDelete")({
        kind: "command",
        parent: "archive",
        name: "delete",
        description: "删除归档条目及当前有效级联声明指向的条目。",
        fields: {
          itemId: { kind: "positional", description: "归档条目 ID" },
        },
        input: z.object({ itemId: archiveIdentifierSchema }),
        success: {
          kind: "data",
          variants: {
            deleted: {
              description: "已删除的归档条目",
              exitCode: 0,
              schema: archiveItemDeletionResultSchema,
              text: ({ itemId, deletedItemIds }) =>
                text.line(
                  "已删除归档条目：" +
                    itemId +
                    "；本次共删除 " +
                    String(deletedItemIds.length) +
                    " 项，包含各 bin 当前未撤回声明指向的条目。",
                ),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
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
        input: z.object({
          itemId: archiveIdentifierSchema,
          binId: binIdSchema.optional(),
          asOf: archiveSnapshotSequenceSchema.optional(),
          limit: z
            .string()
            .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
            .optional(),
          cursor: z.string().min(1).max(4096).optional(),
        }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "一页观察时间线",
              exitCode: 0,
              schema: archiveTimelinePageSchema,
              text: (timeline) => outputText("观察时间线", timeline),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
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
        input: z.object({
          itemId: archiveIdentifierSchema,
          binId: binIdSchema,
          direction: z.enum(["outgoing", "incoming"]),
          asOf: archiveSnapshotSequenceSchema.optional(),
          limit: z
            .string()
            .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
            .optional(),
          cursor: z.string().min(1).max(4096).optional(),
        }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "一页入向或出向关系",
              exitCode: 0,
              schema: archiveRelationPageSchema,
              text: (page) => outputText("对象关系", page),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
      }),
      ...command("archiveRevision")({
        kind: "command",
        parent: "archive",
        name: "revision",
        description: "读取一个不可变内容版本。",
        fields: {
          revisionId: { kind: "positional", description: "内容版本 ID" },
        },
        input: z.object({ revisionId: archiveIdentifierSchema }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "不可变内容版本",
              exitCode: 0,
              schema: archiveRevisionReadSchema,
              text: (revision) => outputText("内容版本", revision),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
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
        input: z.object({
          firstRevisionId: archiveIdentifierSchema,
          secondRevisionId: archiveIdentifierSchema,
        }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "内容版本差异",
              exitCode: 0,
              schema: archiveRevisionDiffSchema,
              text: (diff) => outputText("内容版本差异", diff),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .archives.revisions[":firstRevisionId"].diff[
              ":secondRevisionId"
            ].$get({
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
        },
      }),
      ...command("archiveCommit")({
        kind: "command",
        parent: "archive",
        name: "commit",
        description: "读取一批归档资料的来源、时间和版本依据。",
        fields: {
          commitId: { kind: "positional", description: "归档提交 ID" },
        },
        input: z.object({ commitId: archiveIdentifierSchema }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "归档提交依据",
              exitCode: 0,
              schema: archiveCommitSchema,
              text: (commit) => outputText("归档提交", commit),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
      }),
      ...command("archiveResource")({
        kind: "command",
        parent: "archive",
        name: "resource",
        description: "将归档资源保存到本地文件。",
        fields: {
          resourceId: { kind: "positional", description: "归档资源 ID" },
          output: {
            kind: "valueOption",
            longOption: "--output",
            description: "本地输出文件路径",
          },
        },
        input: z.object({
          resourceId: archiveIdentifierSchema,
          output: z.string().min(1),
        }),
        success: {
          kind: "data",
          variants: {
            downloaded: {
              description: "归档资源元信息与本地保存位置",
              exitCode: 0,
              schema: archiveResourceMetadataSchema.extend({
                savedTo: z.string(),
              }),
              text: ({ savedTo, size }) =>
                text.line(`已保存归档资源至 ${savedTo}（${size} 字节）。`),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
            await saveResourceBody(response, input.output);
            return outcome.data.downloaded({
              ...checkedMetadata.data,
              savedTo: input.output,
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
        },
      }),
    } as const),
  });
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime.identity);
    const invocation = parseCliInvocation(contract, runtime.argv.slice(2));
    const apiUrl =
      parsedApiUrl(invocation) ?? runtime.apiUrl ?? "http://localhost:3000";
    const result = await executeCli(contract, {
      invocation,
      dependencies: {
        apiUrl,
        createClient: () =>
          createApiClient(
            apiUrl,
            runtime.fetch === undefined ? {} : { fetch: runtime.fetch },
          ),
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
