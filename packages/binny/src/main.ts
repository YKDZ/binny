import { createApiClient } from "@binny/api/client";
import {
  archiveCommitSchema,
  archiveErrorSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveRevisionReadSchema,
  archiveSnapshotSequenceSchema,
  archiveTimelinePageSchema,
  binConfigurationSchema,
  binCreateInputSchema,
  binErrorSchema,
  binIdSchema,
  collectorManifestSchema,
  identityIdSchema,
  jsonObjectSchema,
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
};

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

const jsonObjectTextSchema = jsonTextSchema.pipe(jsonObjectSchema);
const collectorTextSchema = jsonTextSchema.pipe(collectorManifestSchema);
const targetsTextSchema = jsonTextSchema.pipe(z.array(z.unknown()));
const errorOutputSchema = z.union([
  binErrorSchema.shape.error,
  archiveErrorSchema.shape.error,
]);

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
      text: ({ message }: { readonly message: string }) =>
        text.line("操作未完成：" + message),
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
    commands: {
      cli: {
        kind: "rootGroup",
        name: identity.commandName,
        description: "配置和管理 Binny 垃圾桶。",
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
        description: "读取已归档资料和不可变内容版本。",
      },
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
              schema: z.object({ bins: z.array(binConfigurationSchema) }),
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
        description: "登记采集器、访问身份、配置和目标。",
        fields: {
          id: { kind: "positional", description: "稳定的 bin 标识" },
          collector: {
            kind: "valueOption",
            longOption: "--collector",
            description: "采集器清单 JSON",
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
          targets: {
            kind: "valueOption",
            longOption: "--targets",
            description: "采集目标列表 JSON",
          },
        },
        input: binCreateInputSchema
          .omit({
            id: true,
            collector: true,
            identityId: true,
            config: true,
            targets: true,
          })
          .extend({
            id: binIdSchema,
            collector: collectorTextSchema,
            identityId: identityIdSchema,
            config: jsonObjectTextSchema,
            targets: targetsTextSchema,
          }),
        success: {
          kind: "data",
          variants: {
            created: {
              description: "已登记的 bin",
              exitCode: 0,
              schema: binConfigurationSchema,
              text: (bin) => outputText("已登记 bin", bin),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const response = await dependencies
            .createClient()
            .bins.$post({ json: input });
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
              schema: binConfigurationSchema,
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
        description: "发现采集器声明的动作和环境能力。",
        fields: { id: { kind: "positional", description: "bin 标识" } },
        input: z.object({ id: binIdSchema }),
        success: {
          kind: "data",
          variants: {
            discovered: {
              description: "已声明动作",
              exitCode: 0,
              schema: z.object({
                actions: collectorManifestSchema.shape.actions,
                environment: collectorManifestSchema.shape.environment,
                execution: binConfigurationSchema.shape.execution,
              }),
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
        description: "修改访问身份、采集器版本、配置或目标。",
        fields: {
          id: { kind: "positional", description: "bin 标识" },
          collector: {
            kind: "valueOption",
            longOption: "--collector",
            description: "采集器清单 JSON",
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
          targets: {
            kind: "valueOption",
            longOption: "--targets",
            description: "采集目标列表 JSON",
          },
        },
        input: z
          .object({
            id: binIdSchema,
            collector: collectorTextSchema.optional(),
            identityId: identityIdSchema.optional(),
            config: jsonObjectTextSchema.optional(),
            targets: targetsTextSchema.optional(),
          })
          .refine(
            ({ collector, identityId, config, targets }) =>
              collector !== undefined ||
              identityId !== undefined ||
              config !== undefined ||
              targets !== undefined,
            { message: "至少提供一个需要修改的字段。" },
          ),
        success: {
          kind: "data",
          variants: {
            updated: {
              description: "已修改的 bin",
              exitCode: 0,
              schema: binConfigurationSchema,
              text: (bin) => outputText("已修改 bin", bin),
            },
          },
        },
        failures,
        async handler({ input, dependencies, outcome }) {
          const { id, ...patch } = input;
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
              schema: binConfigurationSchema,
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
              schema: binConfigurationSchema,
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
          if (response.status === 400 || response.status === 404)
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的移除状态。");
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
            response.status === 409
          )
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的归档条目读取状态。");
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
            response.status === 409
          )
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的时间线读取状态。");
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
            response.status === 409
          )
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的归档版本读取状态。");
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
            response.status === 409
          )
            return outcome.failure.apiError((await response.json()).error);
          throw new Error("服务返回了未声明的归档提交读取状态。");
        },
      }),
    },
  });
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime.identity);
    const result = await executeCli(contract, {
      invocation: parseCliInvocation(contract, runtime.argv.slice(2)),
      dependencies: {
        createClient: () =>
          createApiClient(
            runtime.apiUrl ?? "http://localhost:3000",
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
