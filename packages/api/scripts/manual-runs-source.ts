import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as z from "zod";

export const sourceRequestSchema = z.object({
  runId: z.string().uuid(),
  binId: z.string().min(1),
  gateKey: z.string().min(1),
  sourceKey: z.string().min(1),
});
export const releaseInputSchema = z.object({
  gateKey: z.string().min(1),
  disposition: z.enum([
    "material",
    "manual",
    "empty",
    "partial",
    "slow",
    "available",
    "unavailable",
    "unknown",
    "execution-error",
  ]),
});
export const markerInputSchema = z.object({
  runId: z.string().uuid(),
  gateKey: z.string().min(1),
  marker: z.string().min(1),
});
export const sourceControlStatusSchema = z.object({
  arrivals: z.array(sourceRequestSchema),
  waiting: z.array(z.string()),
  markers: z.array(markerInputSchema),
});

type SourceRequest = z.infer<typeof sourceRequestSchema>;
export type SourceDisposition = z.infer<
  typeof releaseInputSchema
>["disposition"];
type SourceArrival = SourceRequest;
type PendingSourceRequest = {
  readonly request: SourceRequest;
  readonly operation: "collect" | "check";
  readonly response: ServerResponse;
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sourceMaterial(
  request: SourceRequest,
  disposition: Exclude<
    SourceDisposition,
    "available" | "unavailable" | "unknown" | "execution-error"
  >,
): unknown {
  return {
    disposition,
    sourceKey: request.sourceKey,
    title: "受控资料 " + request.gateKey,
    text: "受控正文 " + request.gateKey,
  };
}

function sourceCheck(
  request: SourceRequest,
  disposition: Extract<
    SourceDisposition,
    "available" | "unavailable" | "unknown"
  >,
): unknown {
  const problem =
    disposition === "available"
      ? []
      : [
          {
            code:
              disposition === "unavailable"
                ? "source_unavailable"
                : "source_state_unknown",
            message:
              disposition === "unavailable"
                ? "受控信源当前无法读取。"
                : "受控信源没有提供足够信息判断是否可读取。",
            impact: "当前范围 " + request.sourceKey + " 尚未确认可采集。",
            suggestion:
              disposition === "unavailable"
                ? "检查信源连接和访问身份后重新触发 check。"
                : "完成信源维护后重新触发 check 或 collect。",
            requiresHuman: true,
          },
        ];
  return {
    availability: disposition,
    scope: ["source/" + request.sourceKey],
    basis:
      disposition === "available"
        ? "受控信源确认当前范围可读取。"
        : disposition === "unavailable"
          ? "受控信源明确拒绝读取当前范围。"
          : "受控信源没有返回足够信息作出判断。",
    problems: problem,
  };
}

export async function startControlledSource(
  options: {
    readonly host?: string;
    readonly port?: number;
  } = {},
): Promise<{
  readonly port: number;
  readonly arrivals: () => readonly SourceArrival[];
  readonly close: () => Promise<void>;
}> {
  const sourceArrivals: SourceArrival[] = [];
  const released = new Map<string, SourceDisposition>();
  const pending = new Map<string, PendingSourceRequest>();
  const markers: z.infer<typeof markerInputSchema>[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/control/arrivals") {
        sendJson(response, 200, {
          arrivals: sourceArrivals,
          waiting: [...pending.keys()],
          markers,
        });
        return;
      }

      if (request.method === "POST" && request.url === "/control/mark") {
        const parsed = markerInputSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          sendJson(response, 400, { error: "marker 请求格式无效。" });
          return;
        }
        markers.push(parsed.data);
        sendJson(response, 200, { recorded: true });
        return;
      }

      if (request.method === "POST" && request.url === "/control/release") {
        const parsed = releaseInputSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          sendJson(response, 400, { error: "release 请求格式无效。" });
          return;
        }
        released.set(parsed.data.gateKey, parsed.data.disposition);
        const waiting = pending.get(parsed.data.gateKey);
        if (waiting !== undefined) {
          pending.delete(parsed.data.gateKey);
          if (parsed.data.disposition === "execution-error") {
            sendJson(waiting.response, 503, {
              error: "受控信源未能完成请求。",
            });
          } else if (waiting.operation === "check") {
            if (
              parsed.data.disposition === "available" ||
              parsed.data.disposition === "unavailable" ||
              parsed.data.disposition === "unknown"
            ) {
              sendJson(
                waiting.response,
                200,
                sourceCheck(waiting.request, parsed.data.disposition),
              );
            } else {
              sendJson(waiting.response, 400, { error: "检查结果类型无效。" });
            }
          } else if (
            parsed.data.disposition === "material" ||
            parsed.data.disposition === "manual" ||
            parsed.data.disposition === "empty" ||
            parsed.data.disposition === "partial" ||
            parsed.data.disposition === "slow"
          ) {
            sendJson(
              waiting.response,
              200,
              sourceMaterial(waiting.request, parsed.data.disposition),
            );
          } else {
            sendJson(waiting.response, 400, { error: "采集结果类型无效。" });
          }
        }
        sendJson(response, 200, { released: parsed.data.gateKey });
        return;
      }

      if (request.method === "POST" && request.url === "/source/collect") {
        const parsed = sourceRequestSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          sendJson(response, 400, { error: "信源请求格式无效。" });
          return;
        }
        const sourceRequest = parsed.data;
        sourceArrivals.push(sourceRequest);
        const disposition = released.get(sourceRequest.gateKey);
        if (
          disposition === "material" ||
          disposition === "manual" ||
          disposition === "empty" ||
          disposition === "partial" ||
          disposition === "slow"
        ) {
          sendJson(response, 200, sourceMaterial(sourceRequest, disposition));
          return;
        }
        if (disposition !== undefined) {
          sendJson(response, 400, { error: "采集结果类型无效。" });
          return;
        }
        if (pending.has(sourceRequest.gateKey)) {
          sendJson(response, 409, { error: "信源范围已有等待中的请求。" });
          return;
        }
        pending.set(sourceRequest.gateKey, {
          request: sourceRequest,
          operation: "collect",
          response,
        });
        response.once("close", () => {
          const current = pending.get(sourceRequest.gateKey);
          if (current?.response === response)
            pending.delete(sourceRequest.gateKey);
        });
        return;
      }

      if (request.method === "POST" && request.url === "/source/check") {
        const parsed = sourceRequestSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          sendJson(response, 400, { error: "检查请求格式无效。" });
          return;
        }
        const sourceRequest = parsed.data;
        sourceArrivals.push(sourceRequest);
        const disposition = released.get(sourceRequest.gateKey);
        if (
          disposition === "available" ||
          disposition === "unavailable" ||
          disposition === "unknown"
        ) {
          sendJson(response, 200, sourceCheck(sourceRequest, disposition));
          return;
        }
        if (disposition === "execution-error") {
          sendJson(response, 503, { error: "受控信源未能完成检查。" });
          return;
        }
        if (disposition !== undefined) {
          sendJson(response, 400, { error: "检查结果类型无效。" });
          return;
        }
        if (pending.has(sourceRequest.gateKey)) {
          sendJson(response, 409, { error: "信源范围已有等待中的请求。" });
          return;
        }
        pending.set(sourceRequest.gateKey, {
          request: sourceRequest,
          operation: "check",
          response,
        });
        response.once("close", () => {
          const current = pending.get(sourceRequest.gateKey);
          if (current?.response === response)
            pending.delete(sourceRequest.gateKey);
        });
        return;
      }

      sendJson(response, 404, { error: "没有找到信源路径。" });
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
      } else {
        sendJson(response, 500, { error: "受控信源处理失败。" });
      }
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("受控信源没有取得 TCP 端口。");
  }

  return {
    port: address.port,
    arrivals: () => sourceArrivals,
    close: async () => {
      for (const waiting of pending.values()) {
        sendJson(waiting.response, 503, { error: "受控信源已关闭。" });
      }
      pending.clear();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        );
      });
    },
  };
}

async function serveSource(): Promise<void> {
  const port = Number(process.env.BINNY_RUNS_SOURCE_PORT ?? "0");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("BINNY_RUNS_SOURCE_PORT 必须是 0 到 65535 的整数。");
  }
  const source = await startControlledSource({ port });
  process.stdout.write(`BINNY_RUNS_SOURCE_READY ${String(source.port)}\n`);
  let closing: Promise<void> | undefined;
  const close = (): void => {
    if (closing !== undefined) return;
    closing = source.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entry = process.argv[1];
if (
  process.argv[2] === "--serve" &&
  entry !== undefined &&
  import.meta.url === pathToFileURL(resolve(entry)).href
) {
  await serveSource();
}
