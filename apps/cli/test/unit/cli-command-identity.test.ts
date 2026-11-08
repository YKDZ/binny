import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";

void describe("CLI 命令身份", () => {
  void it("从清单读取命令名，无版本时标记为 unpublished", () => {
    assert.deepStrictEqual(
      cliCommandIdentity({ bin: { release: "./dist/cli.js" } }),
      { commandName: "release", version: "unpublished" },
    );
    assert.deepStrictEqual(
      cliCommandIdentity({ bin: { ship: "./dist/cli.js" }, version: "2.3.4" }),
      { commandName: "ship", version: "2.3.4" },
    );
  });

  void it("没有唯一命令时拒绝选择运行身份", () => {
    assert.throws(() => cliCommandIdentity({ bin: {} }), /唯一命令/u);
    assert.throws(
      () =>
        cliCommandIdentity({
          bin: { release: "./dist/cli.js", ship: "./dist/cli.js" },
        }),
      /唯一命令/u,
    );
  });
});
