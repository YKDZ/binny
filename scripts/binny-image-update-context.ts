import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 复制正式 Docker 构建上下文，排除本地代理资料和已生成依赖。 */
export async function copyImageBuildContext(
  sourceRoot: string,
  buildContextDirectory: string,
): Promise<void> {
  const excludedDirectories = new Set([
    ".agents",
    ".changeset",
    ".codex",
    ".git",
    ".github",
    ".scratch",
    ".turbo",
    ".vscode",
    "coverage",
    "dist",
    "docs",
    "fixture-dist",
    "node_modules",
  ]);
  await cp(sourceRoot, buildContextDirectory, {
    recursive: true,
    filter(sourcePath) {
      const relative = path.relative(sourceRoot, sourcePath);
      const segments = relative.split(path.sep);
      return !segments.some(
        (segment) =>
          excludedDirectories.has(segment) ||
          segment === ".env" ||
          segment.startsWith(".env."),
      );
    },
  });
}

/** 只改临时构建上下文中的信源适配器版本，用正式 CLI 做镜像 A/B。 */
export async function setBuildContextSourceAdapterVersion(
  buildContextDirectory: string,
  sourceFile: string,
  sourceAdapterId: string,
  version: string,
): Promise<void> {
  assert.ok(sourceAdapterId.length > 0);
  assert.ok(version.length > 0);
  const sourcePath = path.join(buildContextDirectory, sourceFile);
  const source = await readFile(sourcePath, "utf8");
  const escapedId = sourceAdapterId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const versionPattern = new RegExp(
    `(id: "${escapedId}",\\n  version: ")[^"]+("[,])`,
    "u",
  );
  assert.match(source, versionPattern, "构建上下文应包含目标信源适配器清单。");
  const updated = source.replace(versionPattern, `$1${version}$2`);
  assert.notEqual(updated, source, "临时信源适配器清单版本应发生变化。");
  await writeFile(sourcePath, updated);
}
