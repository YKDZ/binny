import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCli } from "../../src/main.ts";

async function run(args: readonly string[]) {
  let output = "";
  let requestCount = 0;
  const exitCode = await runCli({
    argv: ["node", "binny", ...args],
    identity: { commandName: "binny", version: "0.0.0" },
    fetch: async () => {
      requestCount += 1;
      throw new Error("离线命令不应请求服务。");
    },
    write: async ({ chunk }) => {
      output += chunk;
    },
  });
  return { exitCode, output, requestCount };
}

void describe("离线 CLI 命令契约", () => {
  void it("列出原生命令目录并按命令路径投影语法与数据契约", async () => {
    const directory = await run(["schema"]);

    assert.equal(directory.exitCode, 0);
    assert.equal(directory.requestCount, 0);
    const listed = JSON.parse(directory.output) as {
      readonly data: {
        readonly grammar: {
          readonly nodes: readonly { readonly id: string }[];
        };
        readonly manifest: {
          readonly commands: Readonly<Record<string, unknown>>;
          readonly wire: Readonly<Record<string, unknown>>;
        };
      };
    };
    assert.ok(listed.data.grammar.nodes.some(({ id }) => id === "cliSchema"));
    assert.ok("archiveSearch" in listed.data.manifest.commands);
    assert.ok("archiveSearch" in listed.data.manifest.wire);

    const selected = await run(["schema", "archive", "search"]);

    assert.equal(selected.exitCode, 0);
    assert.equal(selected.requestCount, 0);
    const detail = JSON.parse(selected.output) as {
      readonly data: {
        readonly grammar: {
          readonly nodes: readonly {
            readonly id: string;
            readonly fields?: readonly {
              readonly key: string;
              readonly kind: string;
            }[];
          }[];
        };
        readonly manifest: {
          readonly commands: Readonly<Record<string, unknown>>;
          readonly wire: Readonly<Record<string, unknown>>;
        };
      };
    };
    assert.deepEqual(
      detail.data.grammar.nodes.map(({ id }) => id),
      ["archive", "archiveSearch"],
    );
    assert.deepEqual(Object.keys(detail.data.manifest.commands), [
      "archive",
      "archiveSearch",
    ]);
    assert.deepEqual(Object.keys(detail.data.manifest.wire), ["archiveSearch"]);
    const command = detail.data.manifest.commands.archiveSearch as {
      readonly input: {
        readonly inputSchema: {
          readonly properties: Readonly<
            Record<string, { readonly type?: string }>
          >;
        };
      };
    };
    assert.equal(command.input.inputSchema.properties.query?.type, "string");
  });

  void it("普通帮助指向 schema、动作、配置和归档查询契约入口", async () => {
    const rootHelp = await run(["--help"]);
    assert.equal(rootHelp.exitCode, 0);
    assert.match(rootHelp.output, /binny schema/u);

    const configHelp = await run(["bin", "update", "--help"]);
    assert.equal(configHelp.exitCode, 0);
    assert.match(configHelp.output, /bin get/u);

    const actionHelp = await run(["run", "trigger", "--help"]);
    assert.equal(actionHelp.exitCode, 0);
    assert.match(actionHelp.output, /bin actions/u);

    const scheduleHelp = await run(["schedule", "create", "--help"]);
    assert.equal(scheduleHelp.exitCode, 0);
    assert.match(
      scheduleHelp.output,
      /已声明的信源适配器动作；可用动作见 bin actions/u,
    );

    const archiveHelp = await run(["archive", "search", "--help"]);
    assert.equal(archiveHelp.exitCode, 0);
    assert.match(archiveHelp.output, /service info/u);
    assert.match(archiveHelp.output, /JSON 字符串/u);
  });

  void it("计划创建和修改契约公开重叠策略选项", async () => {
    const create = await run(["schema", "schedule", "create"]);
    const update = await run(["schema", "schedule", "update"]);

    assert.equal(create.exitCode, 0);
    assert.equal(update.exitCode, 0);
    const creation = JSON.parse(create.output) as {
      readonly data: {
        readonly grammar: {
          readonly nodes: readonly {
            readonly id: string;
            readonly fields?: readonly {
              readonly key: string;
              readonly longOption?: string;
            }[];
          }[];
        };
        readonly manifest: {
          readonly commands: Readonly<
            Record<
              string,
              {
                readonly input: {
                  readonly inputSchema: {
                    readonly properties: Readonly<
                      Record<
                        string,
                        {
                          readonly enum?: readonly string[];
                        }
                      >
                    >;
                  };
                };
              }
            >
          >;
        };
      };
    };
    const creationCommand = creation.data.manifest.commands.scheduleCreate;
    assert.ok(creationCommand);
    assert.deepEqual(
      creationCommand.input.inputSchema.properties.overlapPolicy?.enum,
      ["queue", "skip"],
    );
    assert.ok(
      creation.data.grammar.nodes
        .find(({ id }) => id === "scheduleCreate")
        ?.fields?.some(
          ({ key, longOption }) =>
            key === "overlapPolicy" && longOption === "--overlap-policy",
        ),
    );
    const modification = JSON.parse(update.output) as typeof creation;
    const modificationCommand =
      modification.data.manifest.commands.scheduleUpdate;
    assert.ok(modificationCommand);
    assert.deepEqual(
      modificationCommand.input.inputSchema.properties.overlapPolicy?.enum,
      ["queue", "skip"],
    );
  });

  void it("schema 使用 argv 字符串契约，提供同一数据的文本展示并拒绝未知路径", async () => {
    const commandHelp = await run(["schema", "--help"]);
    assert.equal(commandHelp.exitCode, 0);
    assert.doesNotMatch(commandHelp.output, /--url/u);
    assert.match(commandHelp.output, /命令路径/u);

    const directory = await run(["schema"]);
    assert.equal(directory.exitCode, 0);
    const directoryWire = JSON.parse(directory.output) as {
      readonly data: {
        readonly manifest: {
          readonly commands: Readonly<{
            readonly cliSchema?: {
              readonly input: {
                readonly inputSchema: {
                  readonly properties: Readonly<
                    Record<
                      string,
                      {
                        readonly type?: string;
                        readonly items?: { readonly type?: string };
                      }
                    >
                  >;
                };
              };
            };
          }>;
        };
      };
    };
    const pathSchema =
      directoryWire.data.manifest.commands.cliSchema?.input.inputSchema
        .properties.commandPath;
    assert.equal(pathSchema?.type, "array");
    assert.equal(pathSchema?.items?.type, "string");
    assert.equal(
      Object.hasOwn(
        directoryWire.data.manifest.commands.cliSchema?.input.inputSchema
          .properties ?? {},
        "apiUrl",
      ),
      false,
    );

    const structured = await run(["schema", "archive", "search"]);
    assert.equal(structured.exitCode, 0);
    const structuredWire = JSON.parse(structured.output) as {
      readonly data: {
        readonly manifest: {
          readonly commands: Readonly<{
            readonly archiveSearch?: unknown;
          }>;
        };
      };
    };
    assert.ok(structuredWire.data.manifest.commands.archiveSearch);

    const textOutput = await run([
      "schema",
      "archive",
      "search",
      "--output-format",
      "text",
    ]);
    assert.equal(textOutput.exitCode, 0);
    const textDocument = JSON.parse(
      textOutput.output.slice("CLI 命令契约\n".length),
    );
    assert.deepEqual(
      textDocument,
      (JSON.parse(structured.output) as { readonly data: unknown }).data,
    );

    const unknownPath = await run(["schema", "archive", "unknown"]);
    assert.equal(unknownPath.exitCode, 2);
    const failure = JSON.parse(unknownPath.output) as {
      readonly kind: string;
      readonly variant: string;
      readonly data: {
        readonly path: readonly string[];
        readonly message: string;
      };
    };
    assert.equal(failure.kind, "failure");
    assert.equal(failure.variant, "unknownPath");
    assert.deepEqual(failure.data.path, ["archive", "unknown"]);
    assert.match(failure.data.message, /不存在/u);
  });
});
