import { pathToFileURL } from "node:url";

import type { CollectorDefinition } from "@binny/collector-sdk";

import {
  createRuntimeServer,
  type RuntimeEnvironmentKind,
} from "./runtime-server.ts";

const collectorPath =
  process.env.BINNY_COLLECTOR_ENTRY ?? "/app/collector/collector.js";
const binId = process.env.BINNY_BIN_ID;
const runtimePort = Number(process.env.BINNY_RUNTIME_PORT ?? "8080");
const environment = process.env.BINNY_RUNTIME_ENVIRONMENT ?? "lightweight";

if (binId === undefined || binId.trim() === "") {
  throw new Error("缺少 BINNY_BIN_ID，运行器无法标识已配置 bin。");
}

if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65_535) {
  throw new Error(`BINNY_RUNTIME_PORT 不是有效端口：${String(runtimePort)}`);
}

if (environment !== "lightweight" && environment !== "browser") {
  throw new Error(`未知运行环境：${environment}`);
}

const importedCollector = (await import(pathToFileURL(collectorPath).href)) as {
  readonly default?: CollectorDefinition;
  readonly collector?: CollectorDefinition;
};
const collector = importedCollector.default ?? importedCollector.collector;

if (collector === undefined) {
  throw new Error(
    `采集器模块 ${collectorPath} 必须导出 default 或 collector。`,
  );
}

const server = createRuntimeServer({
  collector,
  environment: environment as RuntimeEnvironmentKind,
});

server.listen(runtimePort, "0.0.0.0", () => {
  process.stdout.write(
    `运行器已启动：bin=${binId} collector=${collector.id} port=${runtimePort}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error !== undefined) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    });
  });
}
