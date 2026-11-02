import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ConsumerOptions = {
  readonly repositoryRoot: string;
};

export type CliRunOptions = {
  readonly apiUrl?: string;
  readonly environmentApiUrl?: string | null;
};

export type IsolatedCliConsumer = {
  readonly run: (
    args: readonly string[],
    options?: CliRunOptions,
  ) => Promise<ProcessResult>;
  readonly verifyRemoteUrlSelection: (apiUrl: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const env = { ...process.env, ...environment };
    const child = spawn(command, [...args], {
      cwd,
      env,
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
  environment?: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  const result = await run(command, args, cwd, environment);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} 失败：\n${result.stdout}${result.stderr}`,
  );
  return result;
}

async function packPackage(
  repositoryRoot: string,
  packageDirectory: string,
  artifactDirectory: string,
): Promise<string> {
  const before = new Set(await readdir(artifactDirectory));
  await runChecked(
    "pnpm",
    ["pack", "--pack-destination", artifactDirectory],
    path.join(repositoryRoot, packageDirectory),
  );
  const created = (await readdir(artifactDirectory)).filter(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );
  assert.equal(created.length, 1, `${packageDirectory} 应产生一个 tarball。`);
  return path.join(artifactDirectory, created[0]!);
}

async function packageVersion(packageDirectory: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error(`${packageDirectory} package.json 缺少版本。`);
  }
  return manifest.version;
}

function consumerEnvironment(apiUrl: string | null): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (apiUrl === null) delete environment.BINNY_API_URL;
  else environment.BINNY_API_URL = apiUrl;
  return environment;
}

export async function createIsolatedCliConsumer({
  repositoryRoot,
}: ConsumerOptions): Promise<IsolatedCliConsumer> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "binny-installed-cli-consumer-"),
  );
  const artifactDirectory = path.join(temporaryRoot, "artifacts");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  const binary = path.join(consumerDirectory, "node_modules", ".bin", "binny");
  let closed = false;

  try {
    await Promise.all([
      mkdir(artifactDirectory, { recursive: true }),
      mkdir(consumerDirectory, { recursive: true }),
    ]);
    const packageDirectories = {
      "@binny/binny": path.join(repositoryRoot, "packages/binny"),
      "@binny/api": path.join(repositoryRoot, "packages/api"),
      "@binny/contracts": path.join(repositoryRoot, "packages/contracts"),
    };
    const packageArtifacts = {} as Record<
      keyof typeof packageDirectories,
      string
    >;
    for (const [name, directory] of Object.entries(packageDirectories)) {
      packageArtifacts[name as keyof typeof packageDirectories] =
        await packPackage(
          repositoryRoot,
          path.relative(repositoryRoot, directory),
          artifactDirectory,
        );
    }
    const dependencies = Object.fromEntries(
      await Promise.all(
        Object.entries(packageArtifacts).map(async ([name, artifact]) => [
          name,
          `file:${path.relative(consumerDirectory, artifact)}`,
        ]),
      ),
    );
    await writeFile(
      path.join(consumerDirectory, "package.json"),
      JSON.stringify(
        {
          name: "binny-installed-cli-consumer",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies,
        },
        null,
        2,
      ) + "\n",
    );
    await runChecked(
      "npm",
      ["install", "--omit=dev", "--no-audit", "--no-fund"],
      consumerDirectory,
    );

    for (const [name, directory] of Object.entries(packageDirectories)) {
      const installedManifestPath = path.join(
        consumerDirectory,
        "node_modules",
        ...name.split("/"),
        "package.json",
      );
      const installedManifest = JSON.parse(
        await readFile(installedManifestPath, "utf8"),
      ) as {
        readonly version?: unknown;
        readonly bin?: Readonly<Record<string, string>>;
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly devDependencies?: Readonly<Record<string, string>>;
        readonly optionalDependencies?: Readonly<Record<string, string>>;
        readonly peerDependencies?: Readonly<Record<string, string>>;
      };
      const declaredDependencies = [
        ...Object.values(installedManifest.dependencies ?? {}),
        ...Object.values(installedManifest.devDependencies ?? {}),
        ...Object.values(installedManifest.optionalDependencies ?? {}),
        ...Object.values(installedManifest.peerDependencies ?? {}),
      ];
      for (const dependency of declaredDependencies) {
        assert.ok(
          !dependency.startsWith("workspace:") &&
            !dependency.startsWith("link:"),
          `${name} 打包后仍包含工作区依赖 ${dependency}。`,
        );
      }
      assert.equal(installedManifest.version, await packageVersion(directory));
      if (name === "@binny/binny") {
        assert.deepEqual(installedManifest.bin, { binny: "./dist/cli.js" });
      }
    }

    const offlineEnvironment = consumerEnvironment("http://127.0.0.1:1");
    const version = await runChecked(
      binary,
      ["--version"],
      consumerDirectory,
      offlineEnvironment,
    );
    assert.match(version.stdout, /binny 0\.0\.0/u);
    const help = await runChecked(
      binary,
      ["service", "info", "--help"],
      consumerDirectory,
      offlineEnvironment,
    );
    assert.match(help.stdout, /--url/u);

    const invoke = async (
      args: readonly string[],
      options: CliRunOptions = {},
    ): Promise<ProcessResult> => {
      assert.equal(closed, false, "CLI 消费者已经关闭。");
      const environmentApiUrl =
        options.environmentApiUrl === undefined
          ? "http://127.0.0.1:1"
          : options.environmentApiUrl;
      const invocation =
        options.apiUrl === undefined
          ? [...args]
          : [...args, "--url", options.apiUrl];
      return await run(
        binary,
        invocation,
        consumerDirectory,
        consumerEnvironment(environmentApiUrl),
      );
    };
    return {
      run: invoke,
      async verifyRemoteUrlSelection(apiUrl) {
        const explicit = await invoke(["service", "info"], {
          apiUrl,
          environmentApiUrl: "http://127.0.0.1:1",
        });
        assert.equal(
          explicit.code,
          0,
          `显式 --url 应覆盖错误环境地址：\n${explicit.stdout}${explicit.stderr}`,
        );
        assert.match(explicit.stdout, /archive\.query-contract/u);

        const environment = await invoke(["service", "info"], {
          environmentApiUrl: apiUrl,
        });
        assert.equal(
          environment.code,
          0,
          `仅设置 BINNY_API_URL 应连接服务：\n${environment.stdout}${environment.stderr}`,
        );
        assert.match(environment.stdout, /archive\.query-contract/u);

        const wrongExplicitUrl = await invoke(["service", "info"], {
          apiUrl: "http://127.0.0.1:1",
          environmentApiUrl: apiUrl,
        });
        assert.notEqual(
          wrongExplicitUrl.code,
          0,
          "错误显式地址不能回退到可用的 BINNY_API_URL。",
        );
      },
      async close() {
        if (closed) return;
        closed = true;
        await rm(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
