import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { copyImageBuildContext } from "./binny-image-update-context.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const context = await mkdtemp(
  path.join(tmpdir(), "binny-integration-artifacts-"),
);

async function run(
  args: readonly string[],
  cwd: string,
  env = process.env,
): Promise<void> {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("pnpm", [...args], { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  assert.equal(code, 0, `集成验收步骤失败：pnpm ${args.join(" ")}`);
}

try {
  // 根目录只准备正式构建输入；执行包只访问这份可丢弃制品。
  await copyImageBuildContext(repositoryRoot, context);
  await run(["install", "--offline", "--frozen-lockfile"], context);
  await run(["--filter", "@binny/binny...", "build"], context);
  await run(
    [
      "--filter",
      "@binny/acceptance",
      "exec",
      "node",
      "--conditions=source",
      "scripts/e2e.ts",
    ],
    repositoryRoot,
    {
      ...process.env,
      BINNY_ACCEPTANCE_BUILD_CONTEXT: context,
      BINNY_ACCEPTANCE_COMMIT: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim(),
      BINNY_ACCEPTANCE_TREE: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim(),
    },
  );
} finally {
  await rm(context, { recursive: true, force: true });
}
