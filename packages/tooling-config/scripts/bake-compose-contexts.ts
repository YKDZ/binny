import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

export type BakeComposeContexts = {
  readonly BINNY_NODE_IMAGE_CONTEXT: string;
  readonly BINNY_PNPM_IMAGE_CONTEXT: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves base image contexts for Compose via `docker buildx bake --print`
 * so Compose builds and Watch reuse the exact versions from root `package.json`.
 */
export function resolveBakeComposeContexts(
  buildContextDirectory: string,
): BakeComposeContexts {
  const packageJsonPath = path.join(buildContextDirectory, "package.json");
  const bakeFilePath = path.join(buildContextDirectory, "docker-bake.hcl");
  const result = spawnSync(
    "docker",
    [
      "buildx",
      "bake",
      "--file",
      packageJsonPath,
      "--file",
      bakeFilePath,
      "--print",
      "server",
    ],
    {
      cwd: buildContextDirectory,
      encoding: "utf8",
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const details =
      result.error?.message ??
      (result.stderr.trim() || `exit code ${String(result.status)}`);
    throw new Error(
      `Failed to resolve Bake image contexts from ${buildContextDirectory}: ${details}`,
    );
  }
  const parsed: unknown = JSON.parse(result.stdout);
  const target = isRecord(parsed) ? parsed.target : undefined;
  const server = isRecord(target) ? target.server : undefined;
  const contexts = isRecord(server) ? server.contexts : undefined;
  const nodeContext = isRecord(contexts)
    ? contexts["node-bookworm-slim"]
    : undefined;
  const pnpmContext = isRecord(contexts) ? contexts["pnpm-release"] : undefined;
  assert.ok(
    typeof nodeContext === "string" && nodeContext.length > 0,
    "Bake server target must declare a non-empty node-bookworm-slim context.",
  );
  assert.ok(
    typeof pnpmContext === "string" && pnpmContext.length > 0,
    "Bake server target must declare a non-empty pnpm-release context.",
  );
  return {
    BINNY_NODE_IMAGE_CONTEXT: nodeContext,
    BINNY_PNPM_IMAGE_CONTEXT: pnpmContext,
  };
}
