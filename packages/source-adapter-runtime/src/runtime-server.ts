import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:net";

import { runtimeProtocolVersion } from "@binny/contracts";
import {
  sourceAdapterManifest,
  type SourceAdapterDefinition,
} from "@binny/source-adapter-sdk";

export type { RuntimeEnvironmentKind } from "@binny/contracts";

export interface RuntimeServerOptions {
  readonly sourceAdapter: SourceAdapterDefinition;
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

export function createRuntimeServer(options: RuntimeServerOptions): Server {
  const manifest = {
    protocolVersion: runtimeProtocolVersion,
    sourceAdapter: sourceAdapterManifest(options.sourceAdapter),
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
