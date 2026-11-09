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

void describe("offline CLI command contract", () => {
  void it("lists commands and projects their contracts by path", async () => {
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

  void it("help points to schema, action, configuration, and query discovery", async () => {
    const rootHelp = await run(["--help"]);
    assert.equal(rootHelp.exitCode, 0);
    assert.match(rootHelp.output, /binny schema/u);

    const configHelp = await run(["bin", "update", "--help"]);
    assert.equal(configHelp.exitCode, 0);
    assert.match(configHelp.output, /bin config-schema/u);

    const binGroupHelp = await run(["bin", "--help"]);
    assert.equal(binGroupHelp.exitCode, 0);
    assert.match(binGroupHelp.output, /binny bin list/u);
    assert.match(binGroupHelp.output, /binny bin get rss-main/u);
    assert.match(binGroupHelp.output, /binny bin config-schema rss-main/u);
    assert.match(binGroupHelp.output, /binny bin actions rss-main collect/u);

    const configSchemaHelp = await run(["bin", "config-schema", "--help"]);
    assert.equal(configSchemaHelp.exitCode, 0);
    assert.match(configSchemaHelp.output, /does not contact the source/u);

    const actionHelp = await run(["run", "trigger", "--help"]);
    assert.equal(actionHelp.exitCode, 0);
    assert.match(actionHelp.output, /bin actions/u);
    assert.match(actionHelp.output, /network requests/u);
    assert.match(actionHelp.output, /archived content/u);

    const actionsHelp = await run(["bin", "actions", "--help"]);
    assert.equal(actionsHelp.exitCode, 0);
    assert.match(actionsHelp.output, /bin actions <id> \[<action>\]/u);
    assert.match(actionsHelp.output, /saved declarations only/u);
    assert.match(actionsHelp.output, /may access their source/u);

    const runGroupHelp = await run(["run", "--help"]);
    assert.equal(runGroupHelp.exitCode, 0);
    assert.match(runGroupHelp.output, /触发已声明的动作并查询运行结果/u);

    const scheduleGroupHelp = await run(["schedule", "--help"]);
    assert.equal(scheduleGroupHelp.exitCode, 0);
    assert.match(scheduleGroupHelp.output, /管理运行计划/u);

    const scheduleHelp = await run(["schedule", "create", "--help"]);
    assert.equal(scheduleHelp.exitCode, 0);
    assert.match(
      scheduleHelp.output,
      /Declared action name; discover actions with bin actions/u,
    );

    const archiveHelp = await run(["archive", "search", "--help"]);
    assert.equal(archiveHelp.exitCode, 0);
    assert.match(archiveHelp.output, /service info/u);
    assert.match(archiveHelp.output, /JSON 字符串/u);
  });

  void it("schedule creation and updates expose the overlap policy option", async () => {
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

    const invalidPolicy = await run([
      "schedule",
      "create",
      "binny-runs-one",
      "--expression",
      "0 0 0 1 1 *",
      "--time-zone",
      "UTC",
      "--action",
      "collect",
      "--overlap-policy",
      "parallel",
    ]);
    assert.equal(invalidPolicy.exitCode, 2);
    assert.equal(invalidPolicy.requestCount, 0);
  });

  void it("schema uses argv strings, renders text, and rejects unknown paths", async () => {
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
