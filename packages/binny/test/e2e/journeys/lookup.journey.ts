import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { cliCommandIdentity } from "../../../src/cli-command-identity.ts";
import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "lookup",
  modes: ["source", "packed"],
  async setup() {},
  commands() {
    return [
      { name: "查询记录", args: ["lookup", "ada"] },
      { name: "文本查询", args: ["lookup", "ada", "--output-format", "text"] },
      { name: "未找到记录", args: ["lookup", "missing"] },
      {
        name: "文本失败",
        args: ["lookup", "missing", "--output-format", "text"],
      },
      { name: "非法输入", args: ["lookup", "   ", "--output-format", "text"] },
      { name: "完整契约", args: ["schema"] },
      { name: "帮助", args: ["--help"] },
      { name: "版本", args: ["--version"] },
    ];
  },
  async assertions({ context, results }) {
    const identity = cliCommandIdentity(
      JSON.parse(
        await readFile(path.join(context.packageRoot, "package.json"), "utf8"),
      ),
    );
    assert.equal(results[0]?.exitCode, 0);
    assert.equal(results[0]?.stderr, "");
    assert.deepEqual(JSON.parse(results[0]?.stdout ?? ""), {
      schemaVersion: "2",
      command: "lookup",
      kind: "data",
      variant: "found",
      data: { name: "ada", title: "Ada Lovelace" },
    });
    assert.equal(results[1]?.exitCode, 0);
    assert.equal(results[1]?.stderr, "");
    assert.match(results[1]?.stdout ?? "", /找到记录：Ada Lovelace/u);
    for (const result of results.slice(2, 4)) {
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
    }
    assert.equal(JSON.parse(results[2]?.stderr ?? "").variant, "notFound");
    assert.match(results[3]?.stderr ?? "", /未找到记录：missing/u);
    assert.equal(results[4]?.exitCode, 2);
    assert.equal(results[4]?.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(results[4]?.stderr ?? ""), {
      schemaVersion: "2",
      kind: "usageFailure",
      helpArgv: [identity.commandName, "lookup", "--help"],
    });
    for (const result of results.slice(5)) {
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
    }
    const schema = JSON.parse(results[5]?.stdout ?? "");
    assert.equal(schema.command, "schema");
    assert.equal(schema.data.manifest.schemaVersion, "4");
    for (const fact of ["lookup", "schema", "found", "notFound"])
      assert.ok(JSON.stringify(schema.data.manifest).includes(fact));
    assert.match(results[6]?.stdout ?? "", /lookup/u);
    assert.ok(results[6]?.stdout.includes(identity.commandName));
    assert.equal(
      results[7]?.stdout,
      `${identity.commandName} ${identity.version}\n`,
    );
  },
};

export default journey;
