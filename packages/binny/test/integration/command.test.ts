import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import { runCli, type CliRuntime } from "../../src/main.ts";

const identity = cliCommandIdentity(
  createRequire(import.meta.url)("../../package.json"),
);

function testRuntime(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const runtime: CliRuntime = {
    argv: ["node", identity.commandName, ...args],
    identity,
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  };
  return { runtime, stdout: () => stdout, stderr: () => stderr };
}

void describe("CLI 契约", () => {
  void it("查询成功默认返回结构化数据，也支持中文文本", async () => {
    const output = testRuntime(["lookup", "ada"]);
    assert.equal(await runCli(output.runtime), 0);
    assert.deepStrictEqual(JSON.parse(output.stdout()), {
      schemaVersion: "2",
      command: "lookup",
      kind: "data",
      variant: "found",
      data: { name: "ada", title: "Ada Lovelace" },
    });
    assert.equal(output.stderr(), "");
    const human = testRuntime(["lookup", "ada", "--output-format", "text"]);
    assert.equal(await runCli(human.runtime), 0);
    assert.ok(human.stdout().includes("找到记录"));
    assert.ok(human.stdout().includes("Ada Lovelace"));
  });

  void it("未找到记录是已声明失败，非法名称是用法错误", async () => {
    const missing = testRuntime(["lookup", "missing"]);
    assert.equal(await runCli(missing.runtime), 1);
    assert.equal(missing.stdout(), "");
    assert.partialDeepStrictEqual(JSON.parse(missing.stderr()), {
      kind: "failure",
      variant: "notFound",
      data: { name: "missing" },
    });
    for (const args of [["lookup"], ["lookup", "   "]]) {
      const invalid = testRuntime([...args, "--output-format", "text"]);
      assert.equal(await runCli(invalid.runtime), 2);
      assert.equal(invalid.stdout(), "");
      assert.partialDeepStrictEqual(JSON.parse(invalid.stderr()), {
        kind: "usageFailure",
      });
    }
    const rejected = testRuntime(["lookup", "Ada"]);
    assert.equal(await runCli(rejected.runtime), 2);
    assert.equal(rejected.stdout(), "");
    assert.partialDeepStrictEqual(JSON.parse(rejected.stderr()), {
      kind: "usageFailure",
      issues: [
        {
          code: "inputRejected",
          evidence: [{ message: "名称只能包含小写字母。", path: ["name"] }],
        },
      ],
    });
  });

  void it("帮助和版本使用 manifest 身份，schema 导出完整契约", async () => {
    const version = testRuntime(["--version"]);
    assert.equal(await runCli(version.runtime), 0);
    assert.equal(
      version.stdout(),
      `${identity.commandName} ${identity.version}\n`,
    );
    const help = testRuntime(["--help"]);
    assert.equal(await runCli(help.runtime), 0);
    assert.ok(help.stdout().includes(identity.commandName));
    assert.ok(help.stdout().includes("lookup"));
    assert.ok(help.stdout().includes("schema"));
    const schema = testRuntime(["schema"]);
    assert.equal(await runCli(schema.runtime), 0);
    const humanSchema = testRuntime(["schema", "--output-format", "text"]);
    assert.equal(await runCli(humanSchema.runtime), 0);
    assert.ok(humanSchema.stdout().includes("CLI 契约"));
    assert.ok(humanSchema.stdout().includes('"commands"'));
    const manifest = JSON.parse(schema.stdout()).data.manifest;
    assert.partialDeepStrictEqual(manifest, {
      schemaVersion: "4",
      commands: {
        lookup: {
          input: {
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: { name: { type: "string", pattern: "^[a-z]+$" } },
              required: ["name"],
            },
          },
          success: {
            variants: {
              found: {
                exitCode: 0,
                outputSchema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    title: { type: "string" },
                  },
                  required: ["name", "title"],
                },
              },
            },
          },
          failures: {
            notFound: {
              exitCode: 1,
              outputSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          },
        },
        schema: { success: { variants: { exported: { exitCode: 0 } } } },
      },
      controls: {
        output: {
          defaultFormat: "structured",
          formats: ["structured", "text"],
        },
      },
      usageFailure: { exitCode: 2 },
    });
  });

  void it("等待输出完成，仅 stdout EPIPE 安静成功", async () => {
    const output = testRuntime(["lookup", "ada"]);
    assert.equal(
      await runCli({
        ...output.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
      0,
    );
    assert.equal(
      await runCli({
        ...output.runtime,
        write: async () => {
          throw new Error("disk");
        },
      }),
      70,
    );
    const failure = testRuntime(["lookup", "missing"]);
    assert.equal(
      await runCli({
        ...failure.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
      70,
    );
    const argv = ["node", identity.commandName];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("内部细节");
      },
    });
    assert.equal(await runCli({ ...output.runtime, argv }), 70);
    assert.ok(output.stderr().includes("命令执行失败"));
    assert.ok(!output.stderr().includes("内部细节"));
  });
});
