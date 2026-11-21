import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBakeComposeContexts } from "@binny/tooling-config/bake-compose-contexts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const expectedTargets = [
  "server",
  "runtime-lightweight",
  "runtime-browser",
  "runtime-protocol-fixture",
  "runtime-configuration-fixture",
  "runtime-manual-runs-fixture",
  "runtime-schema-fixture",
  "runtime-vnc-viewer-fixture",
  "adapter-lightweight-resource-fixture",
  "adapter-browser-session-fixture",
  "adapter-rss",
  "adapter-openai",
  "adapter-anthropic",
  "adapter-google",
  "adapter-huggingface",
  "adapter-mistral",
  "adapter-deepseek",
  "adapter-qwen",
  "adapter-kimi",
  "adapter-minimax",
  "adapter-qoder",
  "adapter-linuxdo",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void describe("Buildx Bake base image contexts", () => {
  void it("resolves server contexts from root package.json", async () => {
    const rootPackage: unknown = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    );
    assert.ok(isRecord(rootPackage));
    assert.ok(isRecord(rootPackage.engines));
    const nodeVersion = rootPackage.engines.node;
    const packageManager = rootPackage.packageManager;
    if (typeof nodeVersion !== "string" || typeof packageManager !== "string") {
      assert.fail(
        "Root package.json must declare engines.node and packageManager.",
      );
    }
    const expectedPnpmVersion = packageManager
      .replace(/^pnpm@/u, "")
      .split("+")[0];

    const contexts = resolveBakeComposeContexts(repositoryRoot);
    assert.deepEqual(contexts, {
      BINNY_NODE_IMAGE_CONTEXT: `docker-image://node:${nodeVersion}-bookworm-slim`,
      BINNY_PNPM_IMAGE_CONTEXT: `docker-image://ghcr.io/pnpm/pnpm:${expectedPnpmVersion}`,
    });
  });

  void it("propagates updated root package.json versions to all 22 Bake targets", async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), "binny-bake-contexts-"),
    );
    try {
      const rootPackage: unknown = JSON.parse(
        await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      );
      assert.ok(isRecord(rootPackage));
      await writeFile(
        path.join(tempDirectory, "package.json"),
        JSON.stringify(
          {
            ...rootPackage,
            engines: { node: "26.99.0" },
            packageManager: "pnpm@12.99.0+sha512.deadbeef",
          },
          null,
          2,
        ),
      );
      await cp(
        path.join(repositoryRoot, "docker-bake.hcl"),
        path.join(tempDirectory, "docker-bake.hcl"),
      );

      assert.deepEqual(resolveBakeComposeContexts(tempDirectory), {
        BINNY_NODE_IMAGE_CONTEXT: "docker-image://node:26.99.0-bookworm-slim",
        BINNY_PNPM_IMAGE_CONTEXT: "docker-image://ghcr.io/pnpm/pnpm:12.99.0",
      });

      const printResult = spawnSync(
        "docker",
        [
          "buildx",
          "bake",
          "--file",
          path.join(tempDirectory, "package.json"),
          "--file",
          path.join(tempDirectory, "docker-bake.hcl"),
          "--print",
        ],
        { cwd: tempDirectory, encoding: "utf8" },
      );
      assert.equal(
        printResult.status,
        0,
        `docker buildx bake --print failed: ${printResult.stderr}`,
      );

      const printed: unknown = JSON.parse(printResult.stdout);
      assert.ok(isRecord(printed));
      const targets = printed.target;
      assert.ok(isRecord(targets));
      assert.deepEqual(
        Object.keys(targets).toSorted(),
        [...expectedTargets].toSorted(),
      );

      for (const targetName of expectedTargets) {
        const target: unknown = targets[targetName];
        assert.ok(isRecord(target));
        assert.deepEqual(
          target.contexts,
          {
            "node-bookworm-slim": "docker-image://node:26.99.0-bookworm-slim",
            "pnpm-release": "docker-image://ghcr.io/pnpm/pnpm:12.99.0",
          },
          `Target ${targetName} must inherit the updated base image contexts.`,
        );
      }

      for (const amd64Target of [
        "runtime-browser",
        "adapter-browser-session-fixture",
        "adapter-linuxdo",
      ]) {
        const target: unknown = targets[amd64Target];
        assert.ok(isRecord(target));
        assert.deepEqual(target.platforms, ["linux/amd64"]);
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  void it("validates compose.acceptance.yaml only when Bake contexts are injected", () => {
    const composeFile = path.join(repositoryRoot, "compose.acceptance.yaml");
    const envWithoutContexts = { ...process.env };
    delete envWithoutContexts.BINNY_NODE_IMAGE_CONTEXT;
    delete envWithoutContexts.BINNY_PNPM_IMAGE_CONTEXT;

    const missingResult = spawnSync(
      "docker",
      ["compose", "--file", composeFile, "config", "--quiet"],
      {
        cwd: repositoryRoot,
        env: envWithoutContexts,
        encoding: "utf8",
      },
    );
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /BINNY_NODE_IMAGE_CONTEXT/u);

    const contexts = resolveBakeComposeContexts(repositoryRoot);
    const validResult = spawnSync(
      "docker",
      ["compose", "--file", composeFile, "config", "--quiet"],
      {
        cwd: repositoryRoot,
        env: { ...envWithoutContexts, ...contexts },
        encoding: "utf8",
      },
    );
    assert.equal(
      validResult.status,
      0,
      `docker compose config failed: ${validResult.stderr}`,
    );
  });
});
