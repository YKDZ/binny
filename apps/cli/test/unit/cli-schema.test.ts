import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveQueryContractVersion,
  publicApiProtocolVersion,
} from "@binny/contracts";

import { runCli } from "../../src/main.ts";

async function run(
  args: readonly string[],
  fetchImplementation?: typeof globalThis.fetch,
) {
  let stdout = "";
  let stderr = "";
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
    write: async ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { exitCode, stdout, stderr, requestCount };
}

type JsonSchema = Readonly<Record<string, unknown>>;

function collectReferences(value: unknown): readonly string[] {
  const references: string[] = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    const reference = Reflect.get(entry, "$ref");
    if (typeof reference === "string") references.push(reference);
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return references;
}

function assertLocalReferencesResolve(schema: JsonSchema): void {
  const references = collectReferences(schema);
  assert.ok(references.length > 0, "schema should contain local references");
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
}

void describe("native offline CLI contract discovery", () => {
  void it("resolves bin update presence rules through native input discovery", async () => {
    const input = await run(["bin", "update", "--schema=input"]);

    assert.equal(input.exitCode, 0, input.stderr);
    assert.equal(input.requestCount, 0);
    const document = JSON.parse(input.stdout) as {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly path: readonly string[];
      readonly input: { readonly inputSchema: JsonSchema };
    };
    assert.equal(document.kind, "input");
    assert.equal(document.schemaVersion, "5");
    assert.deepEqual(document.path, ["bin", "update"]);
    assertLocalReferencesResolve(document.input.inputSchema);

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
            contracts: {
              archiveQuery: {
                version: archiveQueryContractVersion,
                path: "/meta/query",
              },
            },
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
    assert.equal(validChange.exitCode, 0, validChange.stderr);
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

  void it("lists direct root children without expanding command schemas", async () => {
    const directory = await run(["--schema"]);

    assert.equal(directory.exitCode, 0, directory.stderr);
    assert.equal(directory.requestCount, 0);
    const listed = JSON.parse(directory.stdout) as {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly command: string;
      readonly name: string;
      readonly children: readonly {
        readonly path: readonly string[];
        readonly kind: string;
        readonly nextArgv: readonly string[];
      }[];
    };
    assert.equal(listed.kind, "directory");
    assert.equal(listed.schemaVersion, "5");
    assert.equal(listed.command, "cli");
    assert.equal(listed.name, "binny");
    assert.deepEqual(
      listed.children.map(({ path }) => path.join(" ")),
      ["bin", "archive", "service", "run", "human", "schedule", "contract"],
    );
    assert.ok(listed.children.every(({ path }) => path.length === 1));
    for (const child of listed.children) {
      assert.deepEqual(child.nextArgv, [...child.path, "--schema"]);
    }
    assert.doesNotMatch(
      directory.stdout,
      /inputSchema|outputSchema|usageFailure|"wire"/u,
    );
  });

  void it("shows a command summary with syntax, field choices, and output modes", async () => {
    const selected = await run(["schedule", "create", "--schema"]);

    assert.equal(selected.exitCode, 0, selected.stderr);
    assert.equal(selected.requestCount, 0);
    const summary = JSON.parse(selected.stdout) as {
      readonly kind: string;
      readonly path: readonly string[];
      readonly usage: { readonly synopsis: string };
      readonly fields: readonly {
        readonly key: string;
        readonly default?: unknown;
        readonly choices?: readonly string[];
      }[];
      readonly outputs: {
        readonly default: string;
        readonly modes: Readonly<
          Record<string, { readonly delivery: string; readonly format: string }>
        >;
      };
      readonly next: readonly {
        readonly target: string;
        readonly argv: readonly string[];
      }[];
    };
    assert.equal(summary.kind, "summary");
    assert.deepEqual(summary.path, ["schedule", "create"]);
    assert.match(summary.usage.synopsis, /schedule create/u);
    assert.deepEqual(
      summary.fields.find(({ key }) => key === "overlapPolicy")?.choices,
      ["queue", "skip"],
    );
    assert.equal(
      summary.fields.find(({ key }) => key === "overlapPolicy")?.default,
      "queue",
    );
    assert.equal(summary.outputs.default, "structured");
    assert.deepEqual(summary.outputs.modes.structured, {
      description: "Machine-readable schedule details",
      delivery: "atomic",
      format: "structured",
    });
    assert.deepEqual(summary.outputs.modes.text, {
      description: "Readable schedule details",
      delivery: "atomic",
      format: "text",
    });
    assert.ok(
      summary.next.some(({ target }) => target === "input") &&
        summary.next.some(({ target }) => target === "success:structured") &&
        summary.next.some(({ target }) => target === "failures:structured") &&
        summary.next.some(({ target }) => target === "wire:structured"),
    );
    assert.doesNotMatch(
      selected.stdout,
      /inputSchema|outputSchema|usageFailure|"wire"/u,
    );
  });

  void it("selects exact input, success, failure, and wire parts", async () => {
    const input = await run(["archive", "search", "--schema=input"]);
    const success = await run([
      "archive",
      "search",
      "--schema=success:structured",
    ]);
    const failures = await run([
      "archive",
      "search",
      "--schema=failures:structured",
    ]);
    const wire = await run(["archive", "search", "--schema=wire:structured"]);
    const records = await run([
      "archive",
      "search",
      "--schema=records:structured",
    ]);

    for (const result of [input, success, failures, wire]) {
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.requestCount, 0);
    }
    const inputDocument = JSON.parse(input.stdout) as {
      readonly kind: string;
      readonly input: {
        readonly inputSchema: {
          readonly properties: Readonly<Record<string, unknown>>;
        };
      };
    };
    assert.equal(inputDocument.kind, "input");
    assert.deepEqual(Object.keys(inputDocument.input.inputSchema.properties), [
      "query",
      "queryFile",
      "queryStdin",
      "apiUrl",
    ]);

    const successDocument = JSON.parse(success.stdout) as {
      readonly kind: string;
      readonly success: {
        readonly kind: string;
        readonly variants: Readonly<
          Record<string, { readonly outputSchema: unknown }>
        >;
      };
    };
    assert.equal(successDocument.kind, "success");
    assert.equal(successDocument.success.kind, "data");
    assert.ok("found" in successDocument.success.variants);
    assert.match(success.stdout, /nextCursor/u);
    assert.match(success.stdout, /hasMore/u);

    const failuresDocument = JSON.parse(failures.stdout) as {
      readonly kind: string;
      readonly failures: Readonly<Record<string, unknown>>;
    };
    assert.equal(failuresDocument.kind, "failures");
    assert.ok("apiError" in failuresDocument.failures);
    assert.ok(!("usageFailure" in failuresDocument));
    assert.match(failures.stdout, /"diagnostic"/u);
    assert.match(failures.stdout, /"allowedValues"/u);
    assert.match(failures.stdout, /"allowedItemValues"/u);
    assert.match(failures.stdout, /"allowedOperations"/u);
    assert.match(failures.stdout, /"protocolOperations"/u);

    const wireDocument = JSON.parse(wire.stdout) as {
      readonly kind: string;
      readonly wire: {
        readonly data?: Readonly<Record<string, unknown>>;
        readonly failure?: Readonly<Record<string, unknown>>;
        readonly stream?: unknown;
      };
    };
    assert.equal(wireDocument.kind, "wire");
    assert.ok(wireDocument.wire.data?.found !== undefined);
    assert.ok(wireDocument.wire.failure?.apiError !== undefined);
    assert.equal("usageFailure" in wireDocument.wire, false);
    assert.equal("stream" in wireDocument.wire, false);

    assert.equal(records.exitCode, 2);
    assert.equal(records.requestCount, 0);
    const recordsFailure = JSON.parse(records.stderr) as {
      readonly schemaVersion: string;
      readonly kind: string;
      readonly issues: readonly { readonly code: string }[];
    };
    assert.equal(recordsFailure.schemaVersion, "3");
    assert.equal(recordsFailure.kind, "usageFailure");
    assert.ok(
      recordsFailure.issues.some(({ code }) => code === "invalidSchemaQuery"),
    );
  });

  void it("exports the complete grammar and manifest offline with resolvable references", async () => {
    const directory = await run(["--schema"]);
    const exported = await run(["contract"]);

    assert.equal(exported.exitCode, 0, exported.stderr);
    assert.equal(exported.requestCount, 0);
    const envelope = JSON.parse(exported.stdout) as {
      readonly schemaVersion: string;
      readonly command: string;
      readonly outputMode: string;
      readonly kind: string;
      readonly variant: string;
      readonly data: {
        readonly grammar: {
          readonly root: { readonly name: string };
          readonly controls: { readonly schema?: unknown };
        };
        readonly manifest: {
          readonly schemaVersion: string;
          readonly commands: Readonly<Record<string, unknown>>;
          readonly wire: Readonly<Record<string, unknown>>;
          readonly usageFailure: {
            readonly exitCode: number;
            readonly wire: {
              readonly oneOf: readonly {
                readonly properties: {
                  readonly schemaVersion: { readonly const: string };
                };
              }[];
            };
          };
        };
      };
    };
    assert.equal(envelope.schemaVersion, "3");
    assert.equal(envelope.command, "cliContract");
    assert.equal(envelope.outputMode, "structured");
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "exported");
    assert.equal(envelope.data.manifest.schemaVersion, "5");
    assert.deepEqual(envelope.data.grammar.root.name, "binny");
    assert.ok(envelope.data.grammar.controls.schema !== undefined);
    assert.equal(envelope.data.manifest.usageFailure.exitCode, 2);
    assert.equal(
      envelope.data.manifest.usageFailure.wire.oneOf[0]?.properties
        .schemaVersion.const,
      "3",
    );
    for (const command of [
      "archiveSearch",
      "binUpdate",
      "scheduleCreate",
      "cliContract",
    ]) {
      assert.ok(command in envelope.data.manifest.commands);
      assert.ok(command in envelope.data.manifest.wire);
    }
    const binUpdate = envelope.data.manifest.commands.binUpdate as {
      readonly input: { readonly inputSchema: JsonSchema };
    };
    assertLocalReferencesResolve(binUpdate.input.inputSchema);
    assert.ok(exported.stdout.length > directory.stdout.length * 10);
  });

  void it("points help at native discovery and the explicit full export", async () => {
    const rootHelp = await run(["--help"]);
    assert.equal(rootHelp.exitCode, 0);
    assert.match(rootHelp.stdout, /--schema/u);
    assert.match(rootHelp.stdout, /binny contract/u);
    assert.doesNotMatch(rootHelp.stdout, /binny schema/u);

    const updateHelp = await run(["bin", "update", "--help"]);
    assert.equal(updateHelp.exitCode, 0);
    assert.match(updateHelp.stdout, /--output/u);
    assert.match(updateHelp.stdout, /bin config-schema/u);
    assert.match(
      updateHelp.stdout,
      /Provide at least 1 of: identityId, config, browserIdleTimeoutSeconds/u,
    );

    const contractHelp = await run(["contract", "--help"]);
    assert.equal(contractHelp.exitCode, 0);
    assert.match(contractHelp.stdout, /complete local CLI contract/u);
    assert.match(contractHelp.stdout, /offline/u);

    const binGroupHelp = await run(["bin", "--help"]);
    assert.equal(binGroupHelp.exitCode, 0);
    assert.match(binGroupHelp.stdout, /extension-fields/u);
    assert.match(binGroupHelp.stdout, /config-schema/u);
    assert.doesNotMatch(binGroupHelp.stdout, /binny bin get rss-main/u);
    assert.doesNotMatch(
      binGroupHelp.stdout,
      /binny bin actions rss-main collect/u,
    );

    const archiveHelp = await run(["archive", "search", "--help"]);
    assert.equal(archiveHelp.exitCode, 0);
    assert.match(archiveHelp.stdout, /literal text groups/u);
    assert.match(archiveHelp.stdout, /extension-fields <bin-id>/u);
    assert.match(archiveHelp.stdout, /explicit bin/u);
    assert.match(archiveHelp.stdout, /hasAny/u);
  });

  void it("publishes one native example source for machine argv and help", async () => {
    const summary = await run(["archive", "search", "--schema"]);
    assert.equal(summary.exitCode, 0, summary.stderr);
    const document = JSON.parse(summary.stdout) as {
      readonly examples: readonly {
        readonly argv: readonly string[];
        readonly shell: string;
        readonly outputMode?: string;
      }[];
    };
    assert.ok(document.examples.length > 0, "search examples should exist");
    for (const example of document.examples) {
      assert.ok(Array.isArray(example.argv));
      assert.match(example.shell, /binny/u);
      assert.match(example.shell, /archive/u);
      assert.match(example.shell, /search/u);
    }
    assert.ok(
      document.examples.some(({ outputMode }) => outputMode === "text"),
      "search should show explicit text output",
    );
    assert.ok(
      document.examples.some(({ argv }) =>
        argv.includes("--query-file=./search.json"),
      ),
      "search should show file input",
    );
    assert.ok(
      document.examples.some(({ argv }) => argv.includes("--query-stdin")),
      "search should show stdin input",
    );
    assert.ok(
      document.examples.some(({ shell }) => /distribution/u.test(shell)),
      "search should show a distribution example",
    );
    assert.ok(
      document.examples.some(({ shell }) => /timeWindow/u.test(shell)),
      "search should show a time window example",
    );

    const help = await run(["archive", "search", "--help"]);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /示例/u);
    for (const { shell } of document.examples)
      assert.ok(
        help.stdout.includes(shell),
        `help should render ${shell} from the same example`,
      );
    assert.doesNotMatch(help.stdout, /Example: binny archive search/u);
  });

  void it("publishes native examples for existing list commands", async () => {
    for (const args of [
      ["run", "list"],
      ["schedule", "list"],
    ] as const) {
      const summary = await run([...args, "--schema"]);
      assert.equal(summary.exitCode, 0, summary.stderr);
      const document = JSON.parse(summary.stdout) as {
        readonly examples: readonly {
          readonly argv: readonly string[];
          readonly shell: string;
        }[];
      };
      assert.ok(document.examples.length > 0, `${args.join(" ")} examples`);
      const help = await run([...args, "--help"]);
      assert.equal(help.exitCode, 0);
      for (const { shell } of document.examples)
        assert.ok(help.stdout.includes(shell), `help should render ${shell}`);
    }
  });
});
