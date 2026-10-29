import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ConsumerOptions = {
  readonly repositoryRoot: string;
  readonly projectName: string;
};

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runChecked(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  const result = await run(command, args, cwd);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} 失败：\n${result.stdout}${result.stderr}`,
  );
  return result;
}

export async function verifyIsolatedApiConsumer({
  repositoryRoot,
  projectName,
}: ConsumerOptions): Promise<unknown> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "binny-configuration-isolated-consumer-"),
  );
  const deployedApiDirectory = path.join(temporaryRoot, "api-deploy");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  const apiPackageDirectory = path.join(
    consumerDirectory,
    "node_modules",
    "@binny",
    "api",
  );
  const image = `${projectName}-api-consumer:local`;
  let imageBuilt = false;

  try {
    await runChecked(
      "pnpm",
      [
        "--filter",
        "@binny/api",
        "deploy",
        "--prod",
        "--legacy",
        deployedApiDirectory,
      ],
      repositoryRoot,
    );

    await mkdir(path.dirname(apiPackageDirectory), { recursive: true });
    await cp(deployedApiDirectory, apiPackageDirectory, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await writeFile(
      path.join(consumerDirectory, "package.json"),
      JSON.stringify(
        {
          name: "binny-isolated-api-consumer",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: { "@binny/api": "0.0.0" },
        },
        null,
        2,
      ) + "\n",
    );
    await runChecked(
      "pnpm",
      [
        "--filter",
        "@binny/api",
        "run",
        "prepare:client-consumer",
        consumerDirectory,
      ],
      repositoryRoot,
    );
    await writeFile(
      path.join(consumerDirectory, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            customConditions: [],
            rootDir: ".",
            outDir: "dist-consumer",
            skipLibCheck: false,
            types: [],
          },
          include: ["client-types.ts", "client-runtime.ts"],
        },
        null,
        2,
      ) + "\n",
    );

    await runChecked(
      path.join(repositoryRoot, "node_modules/.bin/tsc"),
      ["-p", "tsconfig.json"],
      consumerDirectory,
    );
    const containerEntry =
      "const { exercisePublicApiClient } = await import(" +
      JSON.stringify("./dist-consumer/client-runtime.js") +
      "); const result = await exercisePublicApiClient(" +
      JSON.stringify("http://server:3000") +
      "); process.stdout.write(JSON.stringify(result));";
    await writeFile(
      path.join(consumerDirectory, "Dockerfile"),
      [
        "FROM node:24.21.0-bookworm-slim",
        "WORKDIR /consumer",
        "COPY . .",
        "CMD " +
          JSON.stringify(["node", "--input-type=module", "-e", containerEntry]),
        "",
      ].join("\n"),
    );
    await runChecked(
      "docker",
      ["build", "--tag", image, "--file", "Dockerfile", "."],
      consumerDirectory,
    );
    imageBuilt = true;

    const result = await runChecked(
      "docker",
      ["run", "--rm", "--network", `${projectName}_default`, image],
      repositoryRoot,
    );
    return JSON.parse(result.stdout) as unknown;
  } finally {
    if (imageBuilt)
      await runChecked(
        "docker",
        ["image", "rm", "--force", image],
        repositoryRoot,
      );
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
