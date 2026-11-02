import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:net";

import {
  runtimeActionParametersValidationInputSchema,
  runtimeActionParametersValidationPath,
  runtimeConfigurationValidationInputSchema,
  runtimeConfigurationValidationPath,
  runtimeProtocolVersion,
} from "@binny/contracts";
import {
  parseSourceAdapterInput,
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function pathParts(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((part) => (typeof part === "symbol" ? String(part) : part));
}

export function createRuntimeServer(options: RuntimeServerOptions): Server {
  const manifest = {
    protocolVersion: runtimeProtocolVersion,
    sourceAdapter: sourceAdapterManifest(options.sourceAdapter),
  };

  return createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method === "GET" && request.url === "/manifest") {
        sendJson(response, 200, manifest);
        return;
      }

      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { process: "ready" });
        return;
      }

      if (
        request.method === "POST" &&
        new URL(request.url ?? "/", "http://runtime.internal").pathname ===
          runtimeConfigurationValidationPath
      ) {
        let body: unknown;
        try {
          body = await readJson(request);
        } catch {
          sendJson(response, 400, {
            error: {
              code: "invalid_input",
              message: "请求正文必须是有效 JSON。",
            },
          });
          return;
        }

        const checked =
          runtimeConfigurationValidationInputSchema.safeParse(body);
        if (!checked.success) {
          const issue = checked.error.issues[0];
          sendJson(response, 400, {
            error: {
              code: "invalid_input",
              message: issue?.message ?? "配置验证请求格式无效。",
              ...(issue === undefined ? {} : { path: pathParts(issue.path) }),
            },
          });
          return;
        }

        if (
          checked.data.sourceAdapterId !== manifest.sourceAdapter.id ||
          checked.data.sourceAdapterVersion !== manifest.sourceAdapter.version
        ) {
          sendJson(response, 409, {
            valid: false,
            error: {
              code: "source_adapter_version_mismatch",
              message: "配置验证请求与当前运行器的信源适配器版本不一致。",
            },
          });
          return;
        }

        const parsed = await parseSourceAdapterInput(
          options.sourceAdapter.configSchema,
          checked.data.config,
        );
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          sendJson(response, 422, {
            valid: false,
            error: {
              code: "invalid_configuration",
              message: issue?.message ?? "长期配置不符合信源适配器声明。",
              ...(issue === undefined ? {} : { path: pathParts(issue.path) }),
            },
          });
          return;
        }

        sendJson(response, 200, { valid: true });
        return;
      }

      if (
        request.method === "POST" &&
        new URL(request.url ?? "/", "http://runtime.internal").pathname ===
          runtimeActionParametersValidationPath
      ) {
        let body: unknown;
        try {
          body = await readJson(request);
        } catch {
          sendJson(response, 400, {
            error: {
              code: "invalid_input",
              message: "请求正文必须是有效 JSON。",
            },
          });
          return;
        }

        const checked =
          runtimeActionParametersValidationInputSchema.safeParse(body);
        if (!checked.success) {
          const issue = checked.error.issues[0];
          sendJson(response, 400, {
            error: {
              code: "invalid_input",
              message: issue?.message ?? "动作参数验证请求格式无效。",
              ...(issue === undefined ? {} : { path: pathParts(issue.path) }),
            },
          });
          return;
        }

        if (
          checked.data.sourceAdapterId !== manifest.sourceAdapter.id ||
          checked.data.sourceAdapterVersion !== manifest.sourceAdapter.version
        ) {
          sendJson(response, 409, {
            valid: false,
            error: {
              code: "source_adapter_version_mismatch",
              message: "动作参数验证请求与当前运行器的信源适配器版本不一致。",
            },
          });
          return;
        }

        const action = options.sourceAdapter.actions[checked.data.action];
        if (action === undefined) {
          sendJson(response, 422, {
            valid: false,
            error: {
              code: "action_not_found",
              message: "当前运行器没有请求的动作。",
              path: ["action"],
            },
          });
          return;
        }

        const parsed = await parseSourceAdapterInput(
          action.params,
          checked.data.params,
        );
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          sendJson(response, 422, {
            valid: false,
            error: {
              code: "invalid_action_parameters",
              message: issue?.message ?? "动作参数不符合信源适配器声明。",
              ...(issue === undefined ? {} : { path: pathParts(issue.path) }),
            },
          });
          return;
        }

        sendJson(response, 200, { valid: true });
        return;
      }

      sendJson(response, 404, {
        code: "ROUTE_NOT_FOUND",
        message: "运行器没有该 HTTP 路由。",
      });
    },
  );
}
