import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:net";

import {
  collectorManifest,
  type CollectorDefinition,
} from "@binny/collector-sdk";

export type RuntimeEnvironmentKind = "lightweight" | "browser";

export interface RuntimeServerOptions {
  readonly collector: CollectorDefinition;
  readonly environment: RuntimeEnvironmentKind;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

export function assertCollectorEnvironment(
  collector: CollectorDefinition,
  environment: RuntimeEnvironmentKind,
): void {
  if (collector.environment.browser.required && environment !== "browser") {
    throw new Error(
      `采集器 ${collector.id} 声明需要浏览器，当前运行环境为 ${environment}`,
    );
  }
}

export function createRuntimeServer(options: RuntimeServerOptions): Server {
  assertCollectorEnvironment(options.collector, options.environment);
  const manifest = {
    protocolVersion: 1,
    collector: collectorManifest(options.collector),
  };

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/manifest") {
      sendJson(response, 200, manifest);
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { process: "ready" });
      return;
    }

    sendJson(response, 404, {
      code: "ROUTE_NOT_FOUND",
      message: "运行器没有该 HTTP 路由。",
    });
  });
}
