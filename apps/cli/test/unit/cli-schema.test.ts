import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicApiProtocolVersion } from "@binny/contracts";

import { runCli } from "../../src/main.ts";

async function run(
  args: readonly string[],
  fetchImplementation?: typeof globalThis.fetch,
) {
  let output = "";
  let requestCount = 0;
  const exitCode = await runCli({
    argv: ["node", "binny", ...args],
    identity: { commandName: "binny", version: "0.0.0" },
    fetch: async (input, init) => {
      requestCount += 1;
      if (fetchImplementation !== undefined)
        return fetchImplementation(input, init);
      throw new Error("Offline commands must not request the service.");
    },
    write: async ({ chunk }) => {
      output += chunk;
    },
  });
  return { exitCode, output, requestCount };
}

void describe("offline CLI command contract", () => {
  void it("projects bin update presence rules through resolvable schema references", async () => {
    const input = await run(["schema", "bin", "update", "--part", "input"]);

    assert.equal(input.exitCode, 0);
    assert.equal(input.requestCount, 0);
    const document = JSON.parse(input.output) as {
      readonly data: {
        readonly contract: {
          readonly input: {
            readonly schema: Readonly<Record<string, unknown>> & {
              readonly $defs?: Readonly<Record<string, unknown>>;
            };
          };
        };
      };
    };
    const schema = document.data.contract.input.schema;
    const definitions = schema.$defs;
    assert.ok(definitions !== undefined);
    assert.ok(Object.keys(definitions).length > 0);

    const references: string[] = [];
    const collectReferences = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) collectReferences(entry);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const reference = Reflect.get(value, "$ref");
      if (typeof reference === "string") references.push(reference);
      for (const entry of Object.values(value)) collectReferences(entry);
    };
    collectReferences(schema);
    assert.ok(references.length > 0);

    for (const reference of references) {
      assert.match(reference, /^#\//u);
      let resolved: unknown = schema;
      for (const token of reference
        .slice(2)
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (resolved === null || typeof resolved !== "object") {
          resolved = undefined;
          break;
        }
        resolved = Reflect.get(resolved, token);
      }
      assert.notEqual(resolved, undefined, `${reference} must resolve locally`);
    }

    const missingChanges = await run(["bin", "update", "rss-main"]);
    assert.equal(missingChanges.exitCode, 2);
    assert.equal(missingChanges.requestCount, 0);
    const onlyApiUrl = await run([
      "bin",
      "update",
      "rss-main",
      "--url",
      "http://selected.test",
    ]);
    assert.equal(onlyApiUrl.exitCode, 2);
    assert.equal(onlyApiUrl.requestCount, 0);

    const requests: Request[] = [];
    const validChange = await run(
      [
        "bin",
        "update",
        "rss-main",
        "--identity",
        "account-primary",
        "--config",
        JSON.stringify({ userAgent: "Binny E2E updated", key: "aaz" }),
        "--browser-idle-timeout-seconds",
        "0",
      ],
      async (inputRequest, init) => {
        const request = new Request(inputRequest, init);
        requests.push(request);
        if (new URL(request.url).pathname === "/meta") {
          return Response.json({
            product: { name: "Binny", version: "1.2.3" },
            protocols: { httpApi: publicApiProtocolVersion },
            capabilities: ["archives.search", "archive.query-contract"],
            contracts: { archiveQuery: { version: 2, path: "/meta/query" } },
          });
        }
        return Response.json({
          id: "rss-main",
          sourceAdapterId: "rss",
          identityId: "account-primary",
          config: { userAgent: "Binny E2E updated", key: "aaz" },
          browserIdleTimeoutSeconds: 0,
          status: "active",
          execution: { status: "offline", reason: "runtime_not_connected" },
          sourceStateSnapshot: { freshness: "unknown" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    );
    assert.equal(validChange.exitCode, 0);
    assert.equal(validChange.requestCount, 2);
    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      ["/meta", "/bins/rss-main"],
    );
    assert.deepEqual(await requests[1]?.clone().json(), {
      identityId: "account-primary",
      config: { userAgent: "Binny E2E updated", key: "aaz" },
      browserIdleTimeoutSeconds: 0,
    });
  });

  void it("lists command groups and commands by path without expanding their schemas", async () => {
    const directory = await run(["schema"]);

    assert.equal(directory.exitCode, 0);
    assert.equal(directory.requestCount, 0);
    const listed = JSON.parse(directory.output) as {
      readonly data: {
        readonly kind: string;
        readonly commands: readonly {
          readonly path: readonly string[];
          readonly kind: string;
          readonly description: string;
          readonly inputSchema?: unknown;
          readonly outputSchema?: unknown;
        }[];
      };
    };
    assert.equal(listed.data.kind, "directory");
    assert.ok(
      listed.data.commands.some(
        ({ path, kind }) => path.join(" ") === "bin" && kind === "group",
      ),
    );
    assert.ok(
      listed.data.commands.some(
        ({ path, kind }) => path.join(" ") === "bin get" && kind === "command",
      ),
    );
    assert.ok(
      listed.data.commands.every(
        ({ inputSchema, outputSchema }) =>
          inputSchema === undefined && outputSchema === undefined,
      ),
    );
    assert.doesNotMatch(
      directory.output,
      /inputSchema|outputSchema|usageFailure|wire/u,
    );
  });

  void it("shows a selected command summary with its syntax and field choices", async () => {
    const selected = await run(["schema", "schedule", "create"]);

    assert.equal(selected.exitCode, 0);
    assert.equal(selected.requestCount, 0);
    const summary = JSON.parse(selected.output) as {
      readonly data: {
        readonly kind: string;
        readonly path: readonly string[];
        readonly usage: string;
        readonly fields: readonly {
          readonly key: string;
          readonly kind: string;
          readonly default?: unknown;
          readonly choices?: readonly string[];
        }[];
        readonly parts: readonly string[];
        readonly fullAvailable: boolean;
      };
    };
    assert.equal(summary.data.kind, "command");
    assert.deepEqual(summary.data.path, ["schedule", "create"]);
    assert.match(summary.data.usage, /schedule create/u);
    assert.deepEqual(summary.data.parts, ["input", "output", "errors"]);
    assert.equal(summary.data.fullAvailable, true);
    assert.deepEqual(
      summary.data.fields.find(({ key }) => key === "overlapPolicy")?.choices,
      ["queue", "skip"],
    );
    assert.equal(
      summary.data.fields.find(({ key }) => key === "overlapPolicy")?.default,
      "queue",
    );
    assert.doesNotMatch(
      selected.output,
      /inputSchema|outputSchema|usageFailure|wire/u,
    );
  });

  void it("includes applicable global output controls in command summaries", async () => {
    const selected = await run(["schema", "bin", "get"]);

    assert.equal(selected.exitCode, 0);
    assert.equal(selected.requestCount, 0);
    const summary = JSON.parse(selected.output) as {
      readonly data: {
        readonly fields: readonly { readonly key: string }[];
        readonly controls: {
          readonly output: {
            readonly selector?: string;
            readonly defaultFormat: string;
            readonly formats: readonly string[];
          };
        };
      };
    };
    assert.deepEqual(
      summary.data.fields.map(({ key }) => key),
      ["id", "apiUrl"],
    );
    assert.equal(summary.data.controls.output.selector, "--output-format");
    assert.equal(summary.data.controls.output.defaultFormat, "structured");
    assert.deepEqual(summary.data.controls.output.formats, [
      "structured",
      "text",
    ]);
  });

  void it("reads only the requested contract part and keeps the full result explicit", async () => {
    const summary = await run(["schema", "archive", "search"]);
    const catalogFull = await run(["schema", "--part", "full"]);
    const input = await run(["schema", "archive", "search", "--part", "input"]);
    const output = await run([
      "schema",
      "archive",
      "search",
      "--part",
      "output",
    ]);
    const errors = await run([
      "schema",
      "archive",
      "search",
      "--part",
      "errors",
    ]);
    const full = await run(["schema", "archive", "search", "--part", "full"]);

    for (const result of [summary, catalogFull, input, output, errors, full]) {
      assert.equal(result.exitCode, 0);
      assert.equal(result.requestCount, 0);
    }
    assert.ok(summary.output.length < 10_000);
    assert.ok(catalogFull.output.length > 100_000);
    assert.ok(input.output.length < 10_000);
    assert.match(output.output, /nextCursor/u);
    assert.match(output.output, /hasMore/u);
    assert.match(output.output, /revisionId/u);
    assert.ok(full.output.length > output.output.length);

    const inputDocument = JSON.parse(input.output) as {
      readonly data: {
        readonly contract: {
          readonly input: {
            readonly schema: {
              readonly properties: Readonly<Record<string, unknown>>;
            };
          };
        };
      };
    };
    assert.deepEqual(Object.keys(inputDocument.data.contract), ["input"]);
    assert.deepEqual(
      Object.keys(inputDocument.data.contract.input.schema.properties),
      ["query", "apiUrl"],
    );

    const outputDocument = JSON.parse(output.output) as {
      readonly data: {
        readonly contract: {
          readonly output: {
            readonly kind: string;
            readonly variants: Readonly<
              Record<string, { readonly schema: unknown }>
            >;
          };
        };
      };
    };
    assert.deepEqual(Object.keys(outputDocument.data.contract), ["output"]);
    assert.equal(outputDocument.data.contract.output.kind, "data");
    assert.ok(output.output.includes("nextCursor"));
    assert.ok(output.output.includes("hasMore"));

    const errorDocument = JSON.parse(errors.output) as {
      readonly data: {
        readonly contract: {
          readonly errors: {
            readonly usage: {
              readonly exitCode: number;
              readonly schema: {
                readonly oneOf: readonly {
                  readonly properties: {
                    readonly command: { readonly const: string };
                  };
                }[];
              };
            };
            readonly variants: Readonly<
              Record<string, { readonly schema: unknown }>
            >;
          };
        };
      };
    };
    assert.deepEqual(Object.keys(errorDocument.data.contract), ["errors"]);
    assert.equal(errorDocument.data.contract.errors.usage.exitCode, 2);
    assert.deepEqual(
      errorDocument.data.contract.errors.usage.schema.oneOf.map(
        ({ properties }) => properties.command.const,
      ),
      ["archiveSearch"],
    );
    assert.ok("apiError" in errorDocument.data.contract.errors.variants);

    const fullDocument = JSON.parse(full.output) as {
      readonly data: {
        readonly contract: Readonly<Record<string, unknown>>;
      };
    };
    assert.deepEqual(Object.keys(fullDocument.data.contract), [
      "summary",
      "input",
      "output",
      "errors",
    ]);

    const catalogFullDocument = JSON.parse(catalogFull.output) as {
      readonly data: {
        readonly contract: {
          readonly grammar: { readonly nodes: readonly unknown[] };
          readonly manifest: {
            readonly commands: Readonly<Record<string, unknown>>;
            readonly wire: Readonly<Record<string, unknown>>;
          };
        };
      };
    };
    assert.deepEqual(Object.keys(catalogFullDocument.data.contract), [
      "grammar",
      "manifest",
    ]);
    assert.ok(
      "archiveSearch" in catalogFullDocument.data.contract.manifest.commands,
    );
    assert.ok(
      "archiveSearch" in catalogFullDocument.data.contract.manifest.wire,
    );
  });

  void it("points help to schema, action, configuration, and query discovery", async () => {
    const rootHelp = await run(["--help"]);
    assert.equal(rootHelp.exitCode, 0);
    assert.match(rootHelp.output, /binny schema/u);

    const configHelp = await run(["bin", "update", "--help"]);
    assert.equal(configHelp.exitCode, 0);
    assert.match(configHelp.output, /bin config-schema/u);
    assert.match(
      configHelp.output,
      /Provide at least 1 of: identityId, config, browserIdleTimeoutSeconds/u,
    );

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
    assert.match(archiveHelp.output, /literal keyword groups/u);
    assert.match(archiveHelp.output, /model/u);
    assert.match(archiveHelp.output, /extension-fields <bin-id>/u);
    assert.match(archiveHelp.output, /explicit bin scope/u);
    assert.match(archiveHelp.output, /hasAny/u);

    const extensionHelp = await run(["bin", "extension-fields", "--help"]);
    assert.equal(extensionHelp.exitCode, 0);
    assert.match(extensionHelp.output, /declared extension fields/u);
    assert.match(extensionHelp.output, /archive search/u);
  });

  void it("exposes schedule field choices in the selected input contract", async () => {
    const create = await run([
      "schema",
      "schedule",
      "create",
      "--part",
      "input",
    ]);
    const update = await run([
      "schema",
      "schedule",
      "update",
      "--part",
      "input",
    ]);

    assert.equal(create.exitCode, 0);
    assert.equal(update.exitCode, 0);
    const creation = JSON.parse(create.output) as {
      readonly data: {
        readonly contract: {
          readonly input: {
            readonly schema: {
              readonly properties: Readonly<
                Record<string, { readonly enum?: readonly string[] }>
              >;
            };
          };
        };
      };
    };
    assert.deepEqual(
      creation.data.contract.input.schema.properties.overlapPolicy?.enum,
      ["queue", "skip"],
    );
    const modification = JSON.parse(update.output) as typeof creation;
    assert.deepEqual(
      modification.data.contract.input.schema.properties.overlapPolicy?.enum,
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

  void it("supports argv paths, text summaries, and actionable command path errors", async () => {
    const commandHelp = await run(["schema", "--help"]);
    assert.equal(commandHelp.exitCode, 0);
    assert.doesNotMatch(commandHelp.output, /--url/u);
    assert.match(commandHelp.output, /command path as separate CLI tokens/u);
    assert.match(
      commandHelp.output,
      /binny schema archive search --part input/u,
    );
    assert.match(
      commandHelp.output,
      /binny schema archive search --part full/u,
    );
    assert.match(commandHelp.output, /binny schema --part full/u);
    assert.match(
      commandHelp.output,
      /Discover service capabilities with binny service info/u,
    );

    const directory = await run(["schema"]);
    assert.equal(directory.exitCode, 0);
    const textDirectory = await run(["schema", "--output-format", "text"]);
    assert.equal(textDirectory.exitCode, 0);
    assert.equal(textDirectory.requestCount, 0);
    assert.match(textDirectory.output, /Local CLI command catalog: binny/u);
    assert.match(textDirectory.output, /\[Command group\] bin/u);
    assert.match(textDirectory.output, /\[Command\] bin get/u);
    assert.doesNotMatch(
      textDirectory.output,
      /inputSchema|outputSchema|"grammar"/u,
    );

    const structured = await run(["schema", "archive", "search"]);
    assert.equal(structured.exitCode, 0);
    const structuredWire = JSON.parse(structured.output) as {
      readonly data: {
        readonly kind: string;
        readonly path: readonly string[];
        readonly fields: readonly { readonly key: string }[];
      };
    };
    assert.equal(structuredWire.data.kind, "command");
    assert.deepEqual(structuredWire.data.path, ["archive", "search"]);
    assert.ok(structuredWire.data.fields.some(({ key }) => key === "query"));

    const textOutput = await run([
      "schema",
      "archive",
      "search",
      "--output-format",
      "text",
    ]);
    assert.equal(textOutput.exitCode, 0);
    assert.match(textOutput.output, /Command: binny archive search/u);
    assert.match(textOutput.output, /Parameters and options:/u);
    assert.match(textOutput.output, /--query/u);
    assert.match(textOutput.output, /literal keyword groups/u);
    assert.match(textOutput.output, /previous response's nextCursor/u);
    assert.match(textOutput.output, /extension-fields/u);
    assert.match(textOutput.output, /explicit bin scope/u);
    assert.match(
      textOutput.output,
      /--output-format <structured\|text> — default structured/u,
    );
    assert.match(
      textOutput.output,
      /Available contract parts: input, output, errors/u,
    );
    assert.doesNotMatch(
      textOutput.output,
      /inputSchema|outputSchema|"grammar"/u,
    );

    const unknownPath = await run(["schema", "archive", "unknown"]);
    assert.equal(unknownPath.exitCode, 2);
    const failure = JSON.parse(unknownPath.output) as {
      readonly kind: string;
      readonly variant: string;
      readonly data: {
        readonly path: readonly string[];
        readonly message: string;
        readonly suggestion: string;
      };
    };
    assert.equal(failure.kind, "failure");
    assert.equal(failure.variant, "unknownPath");
    assert.deepEqual(failure.data.path, ["archive", "unknown"]);
    assert.match(failure.data.message, /does not exist/u);
    assert.match(failure.data.suggestion, /binny schema/u);

    const dottedPath = await run(["schema", "archive.search"]);
    assert.equal(dottedPath.exitCode, 2);
    const dottedFailure = JSON.parse(dottedPath.output) as {
      readonly data: {
        readonly path: readonly string[];
        readonly suggestion: string;
      };
    };
    assert.deepEqual(dottedFailure.data.path, ["archive.search"]);
    assert.match(dottedFailure.data.suggestion, /binny schema archive search/u);
  });
});
