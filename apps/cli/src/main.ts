import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { createApiClient } from "@binny/api/client";
import { validationFailure } from "@binny/api/validation";
import {
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
  readonly getServiceMetadata: () => Promise<ServiceMetadataDocument>;
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
const cliArchiveSearchInputSchema = withArchiveJsonSchemaProjection(
  z.object({ query: postgresTextSchema.min(1) }).strict(),
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

type CommandWithApiUrlByName<Name, Definition> = Name extends "cliSchema"
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

function addApiUrlOption<Commands extends Record<string, unknown>>(
  commands: Commands,
): {
  [Command in keyof Commands]: CommandWithApiUrlByName<
    Command,
    Commands[Command]
  >;
} {
  // 查询命令先校验专用契约；服务信息命令用于查看不兼容服务。
  const commandsWithoutAutomaticProtocolCheck = new Set([
    "serviceInfo",
    "archiveSearch",
  ]);
  const extendedCommands = Object.fromEntries(
    Object.entries(commands).map(([name, definition]) => {
      if (!isRecord(definition) || definition.kind !== "command") {
        return [name, definition];
      }
      if (name === "cliSchema") return [name, definition];
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
          handler: stripApiUrlFromHandlerInput(
            definition.handler,
            !commandsWithoutAutomaticProtocolCheck.has(name),
          ),
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
    [Command in keyof Commands]: CommandWithApiUrlByName<
      Command,
      Commands[Command]
    >;
  };
}

type CliSchemaField = z.infer<typeof cliSchemaFieldSchema>;
type CliSchemaControls = {
  readonly help: {
    readonly longOption: string;
    readonly shortAlias?: string;
  };
  readonly version?: {
    readonly longOption: string;
    readonly shortAlias?: string;
    readonly value: string;
  };
  readonly output: {
    readonly defaultFormat: "structured" | "text";
    readonly formats: readonly ("structured" | "text")[];
    readonly selector?: string;
    readonly compatibilityFlags?: Readonly<
      Record<string, "structured" | "text">
    >;
  };
};

type CliSchemaNode = {
  readonly kind: string;
  readonly id: string;
  readonly parent: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly helpSupplement?: readonly string[];
  readonly fields?: readonly CliSchemaField[];
  readonly usageConstraints?: readonly unknown[];
  readonly usage: { readonly synopsis: string };
};

type CliSchemaSource = {
  readonly grammar: {
    readonly root: {
      readonly id: string;
      readonly name: string;
      readonly kind: string;
    };
    readonly nodes: readonly CliSchemaNode[];
    readonly controls: CliSchemaControls;
  };
  readonly manifest: {
    readonly commands: Readonly<Record<string, unknown>>;
    readonly usageFailure: {
      readonly exitCode: number;
      readonly wire: unknown;
    };
    readonly wire: Readonly<Record<string, unknown>>;
  };
};

type CliSchemaPart = z.infer<typeof cliSchemaPartSchema>;
type CliSchemaDirectoryEntry = z.infer<typeof cliSchemaDirectoryEntrySchema>;
type CliSchemaOutput = z.infer<typeof cliSchemaOutputContractSchema>;

type CliSchemaCommandManifest = {
  readonly input: { readonly inputSchema: unknown };
  readonly success:
    | { readonly kind: "completion" }
    | {
        readonly kind: "data";
        readonly variants: Readonly<
          Record<
            string,
            { readonly description: string; readonly exitCode: number }
          >
        >;
      }
    | {
        readonly kind: "stream";
        readonly records: Readonly<
          Record<string, { readonly description: string }>
        >;
      };
  readonly failures: Readonly<
    Record<string, { readonly description: string; readonly exitCode: number }>
  >;
};

type CliSchemaCommandWire = {
  readonly completion?: unknown;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly failure?: Readonly<Record<string, unknown>>;
  readonly stream?: unknown;
};

type CliSchemaDocument = z.infer<typeof cliSchemaDocumentOutputSchema>;

type CliSchemaLookup =
  | { readonly ok: true; readonly document: CliSchemaDocument }
  | {
      readonly ok: false;
      readonly reason: "unknownPath" | "invalidSelection";
      readonly message: string;
      readonly suggestion: string;
    };

function cliSchemaDirectoryEntries(
  contract: CliSchemaSource,
): readonly CliSchemaDirectoryEntry[] {
  const nodesById = new Map(
    contract.grammar.nodes.map((node) => [node.id, node] as const),
  );
  const pathFor = (id: string): string[] => {
    const node = nodesById.get(id);
    if (node === undefined) return [];
    return [...pathFor(node.parent), node.name];
  };

  return contract.grammar.nodes.map((node) => ({
    path: pathFor(node.id),
    kind: node.kind === "command" ? "command" : "group",
    description: node.description,
    ...(node.aliases.length === 0 ? {} : { aliases: node.aliases }),
  }));
}

function cliSchemaOutput(
  command: CliSchemaCommandManifest,
  wire: CliSchemaCommandWire,
): CliSchemaOutput {
  if (command.success.kind === "completion") {
    if (wire.completion === undefined) {
      throw new Error("CLI completion command has no compiled wire contract.");
    }
    return { kind: "completion", schema: wire.completion };
  }
  if (command.success.kind === "stream") {
    if (wire.stream === undefined) {
      throw new Error("CLI stream command has no compiled wire contract.");
    }
    return { kind: "stream", schema: wire.stream };
  }

  const variants = Object.fromEntries(
    Object.entries(command.success.variants).map(([name, variant]) => {
      const schema = wire.data?.[name];
      if (schema === undefined) {
        throw new Error(
          `CLI command ${name} has no compiled success contract.`,
        );
      }
      return [
        name,
        {
          description: variant.description,
          exitCode: variant.exitCode,
          schema,
        },
      ];
    }),
  );
  return { kind: "data", variants };
}

function cliSchemaUsageFailure(
  usageFailure: { readonly exitCode: number; readonly wire: unknown },
  commandId: string,
): { readonly exitCode: number; readonly schema: unknown } {
  if (!isRecord(usageFailure.wire) || !Array.isArray(usageFailure.wire.oneOf)) {
    throw new Error("The CLI usage failure contract is invalid.");
  }
  const variants = usageFailure.wire.oneOf.filter((variant) => {
    if (!isRecord(variant) || !isRecord(variant.properties)) return false;
    const command = variant.properties.command;
    return isRecord(command) && command.const === commandId;
  });
  if (variants.length !== 1) {
    throw new Error(
      `The CLI usage failure contract for ${commandId} is invalid.`,
    );
  }
  return {
    exitCode: usageFailure.exitCode,
    schema: { ...usageFailure.wire, oneOf: variants },
  };
}

/**
 * Builds the offline `schema` command result from cli-contract's compiled declaration.
 * `commandPath` contains the same command tokens accepted after `schema`; an omitted
 * path returns a small directory, a group path returns its immediate children, and
 * an executable path returns its summary unless a contract part is requested. A
 * pathless `full` selection returns the complete declaration; a command-scoped `full`
 * selection remains limited to that command. Each
 * JSON Schema subtree is copied intact so its local `$defs` and `$ref` links remain
 * resolvable. The errors part includes the selected command's usage failures and
 * declared failure variants. Unknown paths and invalid part selections include a corrective hint.
 * This lookup only reads the in-process CLI declaration; it never contacts the service
 * or discovers deployment-specific adapter declarations.
 */
function cliSchemaDocument(
  contract: CliSchemaSource,
  commandPath: readonly string[],
  part?: CliSchemaPart,
): CliSchemaLookup {
  const directoryEntries = cliSchemaDirectoryEntries(contract);
  const rootName = contract.grammar.root.name;
  if (commandPath.length === 0) {
    if (part === undefined) {
      return {
        ok: true,
        document: {
          kind: "directory",
          root: rootName,
          commands: directoryEntries,
        },
      };
    }
    if (part === "full") {
      return {
        ok: true,
        document: {
          kind: "contract",
          root: rootName,
          path: [],
          part,
          contract: {
            grammar: contract.grammar,
            manifest: contract.manifest,
          },
        },
      };
    }
    return {
      ok: false,
      reason: "invalidSelection",
      message:
        "Select an executable command before requesting a contract part.",
      suggestion: `Run ${rootName} schema to browse commands, then select one, for example: ${rootName} schema archive search --part input.`,
    };
  }

  let parent = contract.grammar.root.id;
  const resolvedNodes: CliSchemaNode[] = [];
  let selectedNode: CliSchemaNode | undefined;
  for (const segment of commandPath) {
    selectedNode = contract.grammar.nodes.find(
      (node) =>
        node.parent === parent &&
        (node.name === segment || node.aliases.includes(segment)),
    );
    if (selectedNode === undefined) {
      const invalidSegment = commandPath[resolvedNodes.length] ?? segment;
      const dotSegments = invalidSegment.split(".");
      let correctedParent = parent;
      let correctionIsValid = dotSegments.length > 1;
      for (const dotSegment of dotSegments) {
        const correctedNode = contract.grammar.nodes.find(
          (node) =>
            node.parent === correctedParent &&
            (node.name === dotSegment || node.aliases.includes(dotSegment)),
        );
        if (correctedNode === undefined) {
          correctionIsValid = false;
          break;
        }
        correctedParent = correctedNode.id;
      }
      const suggestion = correctionIsValid
        ? `Use separate command tokens: ${rootName} schema ${[...commandPath.slice(0, resolvedNodes.length), ...dotSegments, ...commandPath.slice(resolvedNodes.length + 1)].join(" ")}.`
        : `Run ${rootName} schema to see valid command paths. Pass each command token as a separate argument.`;
      return {
        ok: false,
        reason: "unknownPath",
        message: `Command path "${commandPath.join(" ")}" does not exist.`,
        suggestion,
      };
    }
    resolvedNodes.push(selectedNode);
    parent = selectedNode.id;
  }

  selectedNode = resolvedNodes[resolvedNodes.length - 1];
  if (selectedNode === undefined) {
    return {
      ok: false,
      reason: "unknownPath",
      message: `Command path "${commandPath.join(" ")}" does not exist.`,
      suggestion: `Run ${rootName} schema to see valid command paths.`,
    };
  }
  const path = resolvedNodes.map(({ name }) => name);

  if (selectedNode.kind !== "command") {
    if (part !== undefined) {
      return {
        ok: false,
        reason: "invalidSelection",
        message: `Command group "${path.join(" ")}" has no contract parts.`,
        suggestion: `Select an executable command in this group, for example: ${rootName} schema ${path.join(" ")} <command> --part input.`,
      };
    }
    return {
      ok: true,
      document: {
        kind: "group",
        root: rootName,
        path,
        description: selectedNode.description,
        ...(selectedNode.helpSupplement === undefined
          ? {}
          : { helpSupplement: selectedNode.helpSupplement }),
        usage: selectedNode.usage.synopsis,
        commands: directoryEntries.filter(
          (entry) =>
            entry.path.length === path.length + 1 &&
            path.every((segment, index) => entry.path[index] === segment),
        ),
      },
    };
  }

  const summary = {
    root: rootName,
    path,
    description: selectedNode.description,
    ...(selectedNode.helpSupplement === undefined
      ? {}
      : { helpSupplement: selectedNode.helpSupplement }),
    usage: selectedNode.usage.synopsis,
    fields: selectedNode.fields ?? [],
    controls: contract.grammar.controls,
    ...(selectedNode.usageConstraints === undefined ||
    selectedNode.usageConstraints.length === 0
      ? {}
      : { usageConstraints: selectedNode.usageConstraints }),
    parts: ["input", "output", "errors"] as const,
    fullAvailable: true as const,
  };
  const commandSummary = { kind: "command" as const, ...summary };
  if (part === undefined) {
    return { ok: true, document: commandSummary };
  }

  const manifestCommand = contract.manifest.commands[
    selectedNode.id
  ] as CliSchemaCommandManifest;
  const commandWire = contract.manifest.wire[
    selectedNode.id
  ] as CliSchemaCommandWire;
  const input = { schema: manifestCommand.input.inputSchema };
  const output = cliSchemaOutput(manifestCommand, commandWire);
  const errors = {
    usage: cliSchemaUsageFailure(
      contract.manifest.usageFailure,
      selectedNode.id,
    ),
    variants: Object.fromEntries(
      Object.entries(manifestCommand.failures).map(([name, failure]) => {
        const schema = commandWire.failure?.[name];
        if (schema === undefined) {
          throw new Error(`CLI failure ${name} has no compiled wire contract.`);
        }
        return [
          name,
          {
            description: failure.description,
            exitCode: failure.exitCode,
            schema,
          },
        ];
      }),
    ),
  };
  const contractDocument =
    part === "full"
      ? { summary: commandSummary, input, output, errors }
      : {
          [part]:
            part === "input" ? input : part === "output" ? output : errors,
        };
  return {
    ok: true,
    document: {
      kind: "contract",
      root: rootName,
      path,
      part,
      contract: contractDocument,
    },
  };
}

const cliBinDetailsSchema = withPostgresJsonSchemaProjection(binDetailsSchema);
const cliBinListSchema = withPostgresJsonSchemaProjection(binListSchema);
const cliBinConfigSchemaDiscoverySchema = withPostgresJsonSchemaProjection(
  binConfigSchemaDiscoverySchema,
);

function cliSchemaCommandLine(root: string, path: readonly string[]): string {
  return [root, ...path].join(" ");
}

function cliSchemaFieldText(
  field: z.infer<typeof cliSchemaFieldSchema>,
): string {
  const spelling =
    field.longOption ??
    (field.kind === "positional" || field.kind === "variadicPositional"
      ? `<${field.key}>`
      : field.key);
  const aliases = field.shortAlias === undefined ? "" : `, ${field.shortAlias}`;
  const requirement = field.required ? "Required" : "Optional";
  const defaultValue =
    field.default === undefined
      ? ""
      : `; default ${JSON.stringify(field.default)}`;
  const choices =
    field.choices === undefined
      ? ""
      : `; allowed values ${field.choices.join(", ")}`;
  return `  ${spelling}${aliases} (${requirement}) — ${field.description}${defaultValue}${choices}`;
}

function renderCliSchemaText(
  document: CliSchemaDocument,
): ReturnType<typeof text.lines> {
  if (document.kind === "directory") {
    return text.lines([
      `Local CLI command catalog: ${document.root}`,
      ...document.commands.map(
        ({ path, kind, description }) =>
          `  [${kind === "group" ? "Command group" : "Command"}] ${path.join(" ")} — ${description}`,
      ),
    ]);
  }
  if (document.kind === "group") {
    return text.lines([
      `Command group: ${cliSchemaCommandLine(document.root, document.path)}`,
      `Description: ${document.description}`,
      `Usage: ${document.usage}`,
      "Commands:",
      ...document.commands.map(
        ({ path, kind, description }) =>
          `  [${kind === "group" ? "Command group" : "Command"}] ${path.join(" ")} — ${description}`,
      ),
      ...(document.helpSupplement ?? []),
    ]);
  }
  if (document.kind === "command") {
    return text.lines([
      `Command: ${cliSchemaCommandLine(document.root, document.path)}`,
      `Description: ${document.description}`,
      `Usage: ${document.usage}`,
      "Parameters and options:",
      ...document.fields.map(cliSchemaFieldText),
      "Global controls:",
      `  ${document.controls.help.longOption}${document.controls.help.shortAlias === undefined ? "" : `, ${document.controls.help.shortAlias}`} — show help`,
      ...(document.controls.version === undefined
        ? []
        : [
            `  ${document.controls.version.longOption}${document.controls.version.shortAlias === undefined ? "" : `, ${document.controls.version.shortAlias}`} — show version`,
          ]),
      ...(document.controls.output.selector === undefined
        ? []
        : [
            `  ${document.controls.output.selector} <${document.controls.output.formats.join("|")}> — default ${document.controls.output.defaultFormat}`,
          ]),
      ...(document.usageConstraints ?? []).map(
        (constraint) => `  Input constraint: ${JSON.stringify(constraint)}`,
      ),
      `Available contract parts: ${document.parts.join(", ")}; use --part full to read the complete contract.`,
      ...(document.helpSupplement ?? []),
    ]);
  }
  const prettyContract = JSON.stringify(document.contract, null, 2);
  return text.lines([
    `CLI contract: ${cliSchemaCommandLine(document.root, document.path)}`,
    `Contract part: ${document.part}`,
    ...prettyContract.split("\n"),
  ]);
}

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
const cliSchemaPartSchema = z.enum(["input", "output", "errors", "full"]);
const cliSchemaDirectoryEntrySchema = z
  .object({
    path: z.array(z.string()).readonly(),
    kind: z.enum(["group", "command"]),
    description: z.string(),
    aliases: z.array(z.string()).readonly().optional(),
  })
  .strict();
const cliSchemaFieldSchema = z
  .object({
    kind: z.enum([
      "flag",
      "positional",
      "repeatableOption",
      "variadicPositional",
      "valueOption",
    ]),
    key: z.string(),
    description: z.string(),
    required: z.boolean(),
    default: z.unknown().optional(),
    choices: z.array(z.string()).readonly().optional(),
    longOption: z.string().optional(),
    shortAlias: z.string().optional(),
    negatedLongOption: z.string().optional(),
  })
  .strict();
const cliSchemaControlsSchema = z
  .object({
    help: z
      .object({
        longOption: z.string(),
        shortAlias: z.string().optional(),
        headings: z.unknown().optional(),
        wording: z.unknown().optional(),
      })
      .strict(),
    version: z
      .object({
        longOption: z.string(),
        shortAlias: z.string().optional(),
        value: z.string(),
        description: z.string().optional(),
      })
      .strict()
      .optional(),
    output: z
      .object({
        defaultFormat: z.enum(["structured", "text"]),
        formats: z.array(z.enum(["structured", "text"])).readonly(),
        selector: z.string().optional(),
        compatibilityFlags: z
          .record(z.string(), z.enum(["structured", "text"]))
          .optional(),
      })
      .strict(),
  })
  .strict();
const cliSchemaCommandSummarySchema = z
  .object({
    kind: z.literal("command"),
    root: z.string(),
    path: z.array(z.string()).readonly(),
    description: z.string(),
    helpSupplement: z.array(z.string()).readonly().optional(),
    usage: z.string(),
    fields: z.array(cliSchemaFieldSchema).readonly(),
    controls: cliSchemaControlsSchema,
    usageConstraints: z.array(z.unknown()).readonly().optional(),
    parts: z.array(z.enum(["input", "output", "errors"])).readonly(),
    fullAvailable: z.literal(true),
  })
  .strict();
const cliSchemaOutputVariantSchema = z
  .object({
    description: z.string(),
    exitCode: z.number(),
    schema: z.unknown(),
  })
  .strict();
const cliSchemaOutputContractSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completion"), schema: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal("data"),
      variants: z.record(z.string(), cliSchemaOutputVariantSchema),
    })
    .strict(),
  z.object({ kind: z.literal("stream"), schema: z.unknown() }).strict(),
]);
const cliSchemaErrorsContractSchema = z
  .object({
    usage: z.object({ exitCode: z.number(), schema: z.unknown() }).strict(),
    variants: z.record(z.string(), cliSchemaOutputVariantSchema),
  })
  .strict();
/**
 * Structured response for offline command discovery. The directory and summaries
 * omit command data schemas; callers request input, output, or errors separately.
 * Each selected JSON Schema is returned as a complete subtree, including its local
 * definitions. A pathless `full` request returns the complete declaration; a
 * command-scoped `full` request returns that command's summary and all three parts.
 */
const cliSchemaDocumentOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("directory"),
      root: z.string(),
      commands: z.array(cliSchemaDirectoryEntrySchema).readonly(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("group"),
      root: z.string(),
      path: z.array(z.string()).readonly(),
      description: z.string(),
      helpSupplement: z.array(z.string()).readonly().optional(),
      usage: z.string(),
      commands: z.array(cliSchemaDirectoryEntrySchema).readonly(),
    })
    .strict(),
  cliSchemaCommandSummarySchema,
  z
    .object({
      kind: z.literal("contract"),
      root: z.string(),
      path: z.array(z.string()).readonly(),
      part: cliSchemaPartSchema,
      contract: z
        .object({
          grammar: z.unknown().optional(),
          manifest: z.unknown().optional(),
          summary: cliSchemaCommandSummarySchema.optional(),
          input: z.object({ schema: z.unknown() }).strict().optional(),
          output: cliSchemaOutputContractSchema.optional(),
          errors: cliSchemaErrorsContractSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);
/** Path errors preserve the exact command tokens and provide a runnable correction. */
const cliSchemaPathFailureSchema = z
  .object({
    message: z.string(),
    path: z.array(z.string()).readonly(),
    suggestion: z.string(),
  })
  .strict();
const cliSchemaSelectionFailureSchema = z
  .object({
    message: z.string(),
    path: z.array(z.string()).readonly(),
    part: cliSchemaPartSchema.optional(),
    suggestion: z.string(),
  })
  .strict();
type CliApiError = z.infer<typeof errorOutputSchema>;

type ServiceCompatibilityFailure = {
  readonly code:
    | "service_metadata_unavailable"
    | "incompatible_http_api_protocol"
    | "incompatible_archive_query_contract"
    | "service_capability_unavailable";
  readonly message: string;
};

type CliHandlerContext = {
  readonly input: Record<string, unknown>;
  readonly dependencies: CliDependencies;
  readonly outcome: {
    readonly failure: {
      readonly apiError: (failure: ServiceCompatibilityFailure) => unknown;
    };
  };
};

async function httpApiCompatibilityFailure(
  dependencies: CliDependencies,
): Promise<ServiceCompatibilityFailure | undefined> {
  const result = await dependencies.getServiceMetadata();
  if (!result.ok) return result.error;

  if (result.metadata.protocols.httpApi !== publicApiProtocolVersion) {
    return {
      code: "incompatible_http_api_protocol",
      message:
        "服务使用 HTTP API 协议 " +
        String(result.metadata.protocols.httpApi) +
        "；当前 CLI 支持协议 " +
        String(publicApiProtocolVersion) +
        "。",
    };
  }
  return undefined;
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

function createCliContract(identity: CliCommandIdentity) {
  const define = defineCli<CliDependencies>();
  const command = (id: string) => define.command(id);
  const outputText = (heading: string, payload: unknown) =>
    text.lines([heading, ...JSON.stringify(payload, null, 2).split("\n")]);
  const archiveSearchPageText = (
    page: z.infer<typeof archiveSearchPageSchema>,
  ) =>
    text.lines([
      `Snapshot: ${page.snapshot.asOf}`,
      `Matches on this page: ${page.results.length}`,
      ...(page.results.length === 0
        ? ["No archived items matched."]
        : page.results.flatMap((result) => [
            `- ${result.title ?? result.sourceKey.key}`,
            `  Source: ${result.sourceKey.namespace}:${result.sourceKey.key}`,
            `  Observed: ${result.observedAt}`,
            `  Views: ${result.matches.map(({ binId }) => binId).join(", ")}`,
          ])),
      ...(page.hasMore
        ? [
            `More results are available. Repeat with query.cursor set to ${page.nextCursor}.`,
          ]
        : ["End of results."]),
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
    ]);
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
            ]),
          ]),
      "Missing and null extension values do not match filters.",
    ]);
  };
  let getCliSchemaDocument: (
    commandPath: readonly string[],
    part?: CliSchemaPart,
  ) => CliSchemaLookup = () => ({
    ok: false,
    reason: "unknownPath",
    message: "The local CLI command contract is not ready.",
    suggestion: "Try again later.",
  });
  const failures = {
    apiError: {
      description: "请求未能完成",
      exitCode: 1,
      schema: errorOutputSchema,
      text: ({ message }: CliApiError) => text.line("操作未完成：" + message),
    },
  };
  const contract = define({
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
        countAtLeast: "Provide at least {min} of: {fields}",
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
          "使用 binny schema 查看离线命令目录，或在其后添加命令路径查看语法、输入输出与错误契约。",
        ]),
      },
      bin: {
        kind: "commandGroup",
        parent: "cli",
        name: "bin",
        description: "Inspect and manage configured bins and declared actions.",
        helpSupplement: text.lines([
          "Examples:",
          "  binny bin list",
          "  binny bin get rss-main",
          "  binny bin config-schema rss-main",
          "  binny bin actions rss-main",
          "  binny bin actions rss-main collect",
        ]),
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
      ...command("cliSchema")({
        kind: "command",
        parent: "cli",
        name: "schema",
        description: "Browse the local CLI command contract offline.",
        helpSupplement: text.lines([
          "Examples:",
          `  ${identity.commandName} schema`,
          `  ${identity.commandName} schema archive search`,
          `  ${identity.commandName} schema archive search --part input`,
          `  ${identity.commandName} schema archive search --part full`,
          `  ${identity.commandName} schema --part full`,
          "Omit the path to list commands. Select a command to see its usage summary, or use --part input, output, or errors; --part full returns every part.",
          `This is the local CLI contract. Discover service capabilities with ${identity.commandName} service info and deployed adapter actions with ${identity.commandName} bin actions <id>.`,
        ]),
        fields: {
          commandPath: {
            kind: "variadicPositional",
            description: "Optional command path as separate CLI tokens",
          },
          part: {
            kind: "valueOption",
            longOption: "--part",
            description:
              "Read one contract part; full explicitly includes every part",
          },
        },
        input: z.object({
          commandPath: z.array(z.string()).default([]),
          part: cliSchemaPartSchema.optional(),
        }),
        success: {
          kind: "data",
          variants: {
            document: {
              description:
                "Local command directory, summary, or selected contract parts",
              exitCode: 0,
              schema: cliSchemaDocumentOutputSchema,
              text: renderCliSchemaText,
            },
          },
        },
        failures: {
          unknownPath: {
            description: "Command path does not exist",
            exitCode: 2,
            schema: cliSchemaPathFailureSchema,
            text: ({ message, suggestion }) =>
              text.lines(["Invalid command path: " + message, suggestion]),
          },
          invalidSelection: {
            description: "Contract part does not apply to the selected path",
            exitCode: 2,
            schema: cliSchemaSelectionFailureSchema,
            text: ({ message, suggestion }) =>
              text.lines([
                "Invalid contract selection: " + message,
                suggestion,
              ]),
          },
        },
        async handler({ input, outcome }) {
          const result = getCliSchemaDocument(input.commandPath, input.part);
          if (!result.ok) {
            if (result.reason === "invalidSelection") {
              return outcome.failure.invalidSelection({
                message: result.message,
                path: input.commandPath,
                ...(input.part === undefined ? {} : { part: input.part }),
                suggestion: result.suggestion,
              });
            }
            return outcome.failure.unknownPath({
              message: result.message,
              path: input.commandPath,
              suggestion: result.suggestion,
            });
          }
          return outcome.data.document(result.document);
        },
      }),
      ...command("serviceInfo")({
        kind: "command",
        parent: "service",
        name: "info",
        description: "Read service version, capabilities, and contract links.",
        input: z.object({}),
        fields: {},
        success: {
          kind: "data",
          variants: {
            discovered: {
              description: "Service metadata and contract links",
              exitCode: 0,
              schema: serviceMetadataSchema,
              text: serviceMetadataText,
            },
          },
        },
        failures,
        async handler({ dependencies, outcome }) {
          const metadata = await dependencies.getServiceMetadata();
          if (!metadata.ok) return outcome.failure.apiError(metadata.error);
          return outcome.data.discovered(metadata.metadata);
        },
      }),
      ...command("archiveSearch")({
        kind: "command",
        parent: "archive",
        name: "search",
        description:
          'Search archived items with literal keyword groups and declared extension filters. Discover fields with binny bin extension-fields <bin-id>; extension filters require an explicit bin scope. Example: binny archive search --query \'{"bins":["forum"],"extensions":{"sourceAdapterId":"forum.example","filters":{"category":{"op":"eq","value":"post"},"tags":{"op":"hasAny","values":["release","model"]}}},"limit":20}\'. For another page, repeat the filters with cursor set to the previous response\'s nextCursor; reuse snapshot.asOf when continuing the same result set.',
        helpSupplement: text.lines([
          "Discover the selected adapter's top-level fields and allowed operations with bin extension-fields <bin-id>.",
          "String, number, integer, and boolean fields use eq/in; scalar arrays use has/hasAny. Fields are combined with AND, and each value list uses OR.",
          'Example: binny archive search --query \'{"bins":["forum"],"extensions":{"sourceAdapterId":"forum.example","filters":{"floor":{"op":"in","values":[8,9]}}}}\'.',
          "Every selected bin must use the declared adapter and schema. Missing and null extension values do not match.",
        ]),
        fields: {
          query: {
            kind: "valueOption",
            longOption: "--query",
            description:
              "Fixed search request JSON. Reuse snapshot.asOf for a consistent cut and use nextCursor as cursor when hasMore is true.",
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
              text: archiveSearchPageText,
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
              message: "Search request must be valid JSON.",
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
              text: binListText,
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
      ...command("binGet")({
        kind: "command",
        parent: "bin",
        name: "get",
        description: "Read a bin's saved configuration and concise status.",
        helpSupplement: text.lines([
          "The response includes configuration values and runtime status. Read the full configuration schema with bin config-schema <bin-id>.",
        ]),
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "Bin configuration and status",
              exitCode: 0,
              schema: cliBinDetailsSchema,
              text: binDetailsText,
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
        input: z.object({
          id: binIdSchema,
          action: sourceAdapterActionNameSchema.optional(),
        }),
        success: {
          kind: "data",
          variants: {
            discovered: {
              description: "Action names or one selected action declaration",
              exitCode: 0,
              schema: cliBinActionDiscoverySchema,
              text: actionDiscoveryText,
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
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
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            discovered: {
              description: "Declared extension fields and supported operations",
              exitCode: 0,
              schema: sourceAdapterExtensionFieldsDiscoverySchema,
              text: extensionFieldsText,
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
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
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            discovered: {
              description: "Configuration schema declaration",
              exitCode: 0,
              schema: cliBinConfigSchemaDiscoverySchema,
              text: (declaration) =>
                text.lines([
                  `Source adapter: ${declaration.sourceAdapterId}@${declaration.sourceAdapterVersion}`,
                  "Configuration schema:",
                  ...JSON.stringify(declaration.configSchema, null, 2).split(
                    "\n",
                  ),
                ]),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
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
        },
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
        input: withPostgresJsonSchemaProjection(
          z.object({
            id: binIdSchema,
            identityId: identityIdSchema.optional(),
            config: jsonObjectTextSchema.optional(),
            browserIdleTimeoutSeconds:
              browserIdleTimeoutOptionSchema.optional(),
          }),
        ),
        success: {
          kind: "data",
          variants: {
            updated: {
              description: "Updated bin configuration and status",
              exitCode: 0,
              schema: cliBinDetailsSchema,
              text: binDetailsText,
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
        description: "停用信源适配器配置，但保留已归档内容。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            disabled: {
              description: "Disabled bin configuration and status",
              exitCode: 0,
              schema: cliBinDetailsSchema,
              text: binDetailsText,
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
        description: "重新启用信源适配器配置。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            enabled: {
              description: "Enabled bin configuration and status",
              exitCode: 0,
              schema: cliBinDetailsSchema,
              text: binDetailsText,
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
      ...command("runList")({
        kind: "command",
        parent: "run",
        name: "list",
        description:
          "List action runs across all bins with optional action, status, and creation-time filters.",
        helpSupplement: text.lines([
          "Examples:",
          `  ${identity.commandName} run list --status failed --limit 10`,
          `  ${identity.commandName} run list --bin-id forum --created-from 2026-11-01T00:00:00Z`,
          `  ${identity.commandName} run get forum <runId>`,
          "The lower creation-time bound is inclusive; the upper bound is exclusive. Continue with the same filters and page size.",
        ]),
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
        success: {
          kind: "data",
          variants: {
            listed: {
              description: "Run summaries and next-page cursor",
              exitCode: 0,
              schema: manualRunListPageSchema,
              text: (page) =>
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
                ]),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .runs.$get({ query: input });
          if (response.status === 200)
            return outcome.data.listed(await response.json());
          if (response.status === 400)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("Service returned an undeclared run-list status.");
        },
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
        input: z.object({
          binId: binIdSchema,
          runId: z.string().uuid(),
        }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "Run status and result",
              exitCode: 0,
              schema: manualRunSchema,
              text: runDetailText,
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
          throw new Error("Service returned an undeclared run-detail status.");
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
        success: {
          kind: "data",
          variants: {
            created: {
              description: "已声明的运行计划",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("已创建运行计划", schedule),
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
        },
      }),
      ...command("scheduleList")({
        kind: "command",
        parent: "schedule",
        name: "list",
        description:
          "List schedules across all bins with optional action and enabled-state filters.",
        helpSupplement: text.lines([
          "Examples:",
          `  ${identity.commandName} schedule list`,
          `  ${identity.commandName} schedule list --bin-id forum --enabled false`,
          `  ${identity.commandName} schedule get forum <scheduleId>`,
          "Continue with the same filters and page size to read every matching schedule.",
        ]),
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
        success: {
          kind: "data",
          variants: {
            listed: {
              description: "Schedule summaries and next-page cursor",
              exitCode: 0,
              schema: scheduleListPageSchema,
              text: (page) =>
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
                ]),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .schedules.$get({ query: input });
          if (response.status === 200)
            return outcome.data.listed(await response.json());
          if (response.status === 400)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error(
            "Service returned an undeclared schedule-list status.",
          );
        },
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
        input: z.object({ binId: binIdSchema, scheduleId: z.string().uuid() }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "Schedule details and action parameters",
              exitCode: 0,
              schema: scheduleSchema,
              text: scheduleDetailText,
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
          throw new Error(
            "Service returned an undeclared schedule-detail status.",
          );
        },
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
        success: {
          kind: "data",
          variants: {
            updated: {
              description: "已修改的运行计划",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("已修改运行计划", schedule),
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
          throw new Error("服务返回了未声明的运行计划修改状态。");
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
              description: "已停用的运行计划",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("已停用运行计划", schedule),
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
          throw new Error("服务返回了未声明的运行计划停用状态。");
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
              description: "已启用的运行计划",
              exitCode: 0,
              schema: scheduleSchema,
              text: (schedule) => outputText("已启用运行计划", schedule),
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
          throw new Error("服务返回了未声明的运行计划启用状态。");
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
              description: "已移除的运行计划",
              exitCode: 0,
              schema: scheduleDeleteResultSchema,
              text: ({ scheduleId }) =>
                text.line("已移除运行计划：" + scheduleId),
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
          throw new Error("服务返回了未声明的运行计划移除状态。");
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
  getCliSchemaDocument = (commandPath, part) =>
    cliSchemaDocument(contract, commandPath, part);
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
        const metadata = serviceMetadataSchema.safeParse(await response.json());
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
      })();
      return serviceMetadataRequest;
    };
    const result = await executeCli(contract, {
      invocation,
      dependencies: {
        apiUrl,
        createClient,
        getServiceMetadata,
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
