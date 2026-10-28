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
};

const records = [
  { name: "ada", title: "Ada Lovelace" },
  { name: "grace", title: "Grace Hopper" },
];

function createCliContract(identity: CliCommandIdentity) {
  const define = defineCli<{ getManifest(): Record<string, unknown> }>();
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
      value: text.line(`${identity.commandName} ${identity.version}`),
      shortAlias: "-V",
    }),
    output: outputCapability({ defaultFormat: "structured", text: true }),
    usageFailureExitCode: 2,
    commands: {
      cli: {
        kind: "rootGroup",
        name: identity.commandName,
        description: "查询示例记录。",
      },
      ...define.command("lookup")({
        kind: "command",
        parent: "cli",
        name: "lookup",
        description: "按名称查询内存记录。",
        fields: {
          name: { kind: "positional", description: "小写字母组成的记录名称" },
        },
        input: z.object({
          name: z.string().regex(/^[a-z]+$/, {
            error: "名称只能包含小写字母。",
          }),
        }),
        success: {
          kind: "data",
          variants: {
            found: {
              description: "找到记录",
              exitCode: 0,
              schema: z.object({ name: z.string(), title: z.string() }),
              text: ({ name, title }) =>
                text.line(`找到记录：${title}（${name}）`),
            },
          },
        },
        failures: {
          notFound: {
            description: "记录不存在",
            exitCode: 1,
            schema: z.object({ name: z.string() }),
            text: ({ name }) => text.line(`未找到记录：${name}。`),
          },
        },
        handler({ input, outcome }) {
          const record = records.find(({ name }) => name === input.name);
          return record === undefined
            ? outcome.failure.notFound({ name: input.name })
            : outcome.data.found(record);
        },
      }),
      ...define.command("schema")({
        kind: "command",
        parent: "cli",
        name: "schema",
        description: "导出完整 CLI 契约及输入/输出 Schema。",
        input: z.object({}),
        fields: {},
        success: {
          kind: "data",
          variants: {
            exported: {
              description: "完整 CLI 契约",
              exitCode: 0,
              schema: z.object({
                manifest: z.record(z.string(), z.unknown()),
              }),
              text: ({ manifest }) =>
                text.lines([
                  "CLI 契约",
                  ...JSON.stringify(manifest, null, 2).split("\n"),
                ]),
            },
          },
        },
        failures: {},
        handler: ({ dependencies, outcome }) =>
          outcome.data.exported({ manifest: dependencies.getManifest() }),
      }),
    },
  });
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime.identity);
    const result = await executeCli(contract, {
      invocation: parseCliInvocation(contract, runtime.argv.slice(2)),
      dependencies: { getManifest: () => ({ ...contract.manifest }) },
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
        chunk: "命令执行失败；请检查运行环境或报告此问题。\n",
      });
    } catch {
      // 诊断通道故障不能改变原定退出类别。
    }
    return 70;
  }
}
