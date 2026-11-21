import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveBakeComposeContexts } from "../scripts/bake-compose-contexts.ts";

const minimalBakeFile = `variable "engines" {
  default = {}
}

variable "packageManager" {
  default = ""
}

function "node_version" {
  params = []
  result = engines.node
}

function "pnpm_version" {
  params = []
  result = split("+", trimprefix(packageManager, "pnpm@"))[0]
}

target "server" {
  contexts = {
    node-bookworm-slim = "docker-image://node:\${node_version()}-bookworm-slim"
    pnpm-release       = "docker-image://ghcr.io/pnpm/pnpm:\${pnpm_version()}"
  }
}
`;

void describe("resolveBakeComposeContexts", () => {
  void it("resolves node and pnpm image contexts from minimal package.json and docker-bake.hcl", async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), "binny-bake-contexts-unit-"),
    );
    try {
      await writeFile(
        path.join(tempDirectory, "package.json"),
        JSON.stringify(
          {
            name: "bake-contexts-fixture",
            private: true,
            engines: { node: "26.99.0" },
            packageManager: "pnpm@12.99.0+sha512.deadbeef",
          },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(tempDirectory, "docker-bake.hcl"),
        minimalBakeFile,
      );

      assert.deepEqual(resolveBakeComposeContexts(tempDirectory), {
        BINNY_NODE_IMAGE_CONTEXT: "docker-image://node:26.99.0-bookworm-slim",
        BINNY_PNPM_IMAGE_CONTEXT: "docker-image://ghcr.io/pnpm/pnpm:12.99.0",
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  void it("throws a descriptive error when docker-bake.hcl is missing", async () => {
    const emptyDirectory = await mkdtemp(
      path.join(tmpdir(), "binny-bake-missing-"),
    );
    try {
      assert.throws(
        () => resolveBakeComposeContexts(emptyDirectory),
        /Failed to resolve Bake image contexts/u,
      );
    } finally {
      await rm(emptyDirectory, { recursive: true, force: true });
    }
  });
});
