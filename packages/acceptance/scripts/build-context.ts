import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 复制已准备的临时制品，排除生成的依赖与构建产物。 */
export async function copyImageBuildContext(
  sourceRoot: string,
  buildContextDirectory: string,
): Promise<void> {
  const excludedDirectories = new Set([
    "node_modules",
    "dist",
    "fixture-dist",
    ".turbo",
  ]);
  await cp(sourceRoot, buildContextDirectory, {
    recursive: true,
    filter(sourcePath) {
      const relative = path.relative(sourceRoot, sourcePath);
      const segments = relative.split(path.sep);
      return !segments.some((segment) => excludedDirectories.has(segment));
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
