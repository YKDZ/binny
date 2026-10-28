import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = process.argv[2];
if (outputDirectory === undefined)
  throw new Error("请提供隔离消费者的临时目录。");

const fixtureDirectory = fileURLToPath(
  new URL("../test-consumer/", import.meta.url),
);
const outputPath = path.resolve(outputDirectory);
await mkdir(outputPath, { recursive: true });
for (const filename of ["client-types.ts", "client-runtime.ts"]) {
  await copyFile(
    path.join(fixtureDirectory, filename),
    path.join(outputPath, filename),
  );
}
