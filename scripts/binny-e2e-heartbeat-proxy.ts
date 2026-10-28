import {
  createServer,
  request as createRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

const runtimePort = readPort("BINNY_E2E_PROXY_PORT", 8082);
const controlPort = readPort("BINNY_E2E_PROXY_CONTROL_PORT", 8083);

let armed = false;
let heldAt: number | undefined;
let clientClosedAt: number | undefined;
let heldForward: (() => Promise<void>) | undefined;
let armedForStoppedRunId: string | undefined;
let heldRuntimeId: string | undefined;
let heldOwnerGeneration: string | undefined;
let heldStoppedRunId: string | undefined;
let forwardedRuntimeId: string | undefined;
let forwardedOwnerGeneration: string | undefined;

function readPort(name: string, fallback: number): number {
  const port = Number(process.env[name] ?? String(fallback));
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${name} 必须是 1–65535 之间的整数。`);
  return port;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return;
  sendJson(response, 502, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function forward(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
): Promise<void> {
  return new Promise((resolve) => {
    const upstream = createRequest(
      {
        hostname: "server",
        port: 3000,
        path: request.url ?? "/",
        method: request.method ?? "GET",
        headers: { ...request.headers, host: "server:3000" },
      },
      (upstreamResponse) => {
        if (!response.destroyed)
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
        response.once("close", () => {
          if (!response.writableEnded) upstreamResponse.resume();
        });
        upstreamResponse.once("end", () => {
          if (!response.destroyed) response.end();
          resolve();
        });
        upstreamResponse.once("error", (error: unknown) => {
          sendFailure(response, error);
          resolve();
        });
        upstreamResponse.on("data", (chunk: Buffer) => {
          if (!response.destroyed) response.write(chunk);
        });
      },
    );
    upstream.once("error", (error: unknown) => {
      sendFailure(response, error);
      resolve();
    });
    upstream.end(body);
  });
}

async function handleRuntimeRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  let decoded: unknown;
  if (
    request.url?.startsWith("/bins/binny15-one/runtime/heartbeat") &&
    body.length > 0
  ) {
    try {
      decoded = JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      decoded = undefined;
    }
  }
  const isIdleHeartbeat =
    typeof decoded === "object" &&
    decoded !== null &&
    "activeRunId" in decoded &&
    decoded.activeRunId === null &&
    "claimInFlight" in decoded &&
    decoded.claimInFlight === false;
  const matchesStoppedRun =
    typeof decoded === "object" &&
    decoded !== null &&
    (!("stoppedRunId" in decoded) ||
      decoded.stoppedRunId === armedForStoppedRunId);
  if (
    armed &&
    request.url?.startsWith("/bins/binny15-one/runtime/heartbeat") &&
    isIdleHeartbeat &&
    matchesStoppedRun
  ) {
    armed = false;
    heldAt = Date.now();
    clientClosedAt = undefined;
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "runtimeId" in decoded &&
      typeof decoded.runtimeId === "string"
    ) {
      heldRuntimeId = decoded.runtimeId;
    }
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "stoppedRunId" in decoded &&
      typeof decoded.stoppedRunId === "string"
    ) {
      heldStoppedRunId = decoded.stoppedRunId;
    }
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "ownerGeneration" in decoded &&
      typeof decoded.ownerGeneration === "string"
    ) {
      heldOwnerGeneration = decoded.ownerGeneration;
    }
    response.once("close", () => {
      if (!response.writableEnded) clientClosedAt = Date.now();
    });
    heldForward = async () => await forward(request, response, body);
    return;
  }
  if (
    request.url?.startsWith("/bins/binny15-one/runtime/heartbeat") &&
    typeof decoded === "object" &&
    decoded !== null &&
    "runtimeId" in decoded &&
    typeof decoded.runtimeId === "string"
  ) {
    forwardedRuntimeId = decoded.runtimeId;
  }
  if (
    request.url?.startsWith("/bins/binny15-one/runtime/heartbeat") &&
    typeof decoded === "object" &&
    decoded !== null &&
    "ownerGeneration" in decoded &&
    typeof decoded.ownerGeneration === "string"
  ) {
    forwardedOwnerGeneration = decoded.ownerGeneration;
  }
  await forward(request, response, body);
}

const runtimeProxy = createServer((request, response) => {
  void handleRuntimeRequest(request, response).catch((error: unknown) =>
    sendFailure(response, error),
  );
});

const control = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/control/status") {
      request.resume();
      sendJson(response, 200, {
        armed,
        held: heldForward !== undefined,
        ...(heldAt === undefined ? {} : { heldAt }),
        ...(clientClosedAt === undefined ? {} : { clientClosedAt }),
        ...(heldRuntimeId === undefined ? {} : { heldRuntimeId }),
        ...(heldOwnerGeneration === undefined ? {} : { heldOwnerGeneration }),
        ...(heldStoppedRunId === undefined ? {} : { heldStoppedRunId }),
        ...(forwardedRuntimeId === undefined ? {} : { forwardedRuntimeId }),
        ...(forwardedOwnerGeneration === undefined
          ? {}
          : { forwardedOwnerGeneration }),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/control/arm") {
      const body = await readBody(request);
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        value = undefined;
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("stoppedRunId" in value) ||
        typeof value.stoppedRunId !== "string"
      ) {
        sendJson(response, 400, { error: "必须指定要延迟确认的 run。" });
        return;
      }
      if (armed || heldForward !== undefined) {
        sendJson(response, 409, { error: "已有心跳等待释放。" });
        return;
      }
      armed = true;
      armedForStoppedRunId = value.stoppedRunId;
      heldAt = undefined;
      clientClosedAt = undefined;
      heldRuntimeId = undefined;
      heldOwnerGeneration = undefined;
      heldStoppedRunId = undefined;
      sendJson(response, 200, { armed });
      return;
    }
    if (request.method === "POST" && request.url === "/control/release") {
      request.resume();
      const releaseHeldHeartbeat = heldForward;
      if (releaseHeldHeartbeat === undefined) {
        sendJson(response, 409, { error: "当前没有等待释放的心跳。" });
        return;
      }
      heldForward = undefined;
      await releaseHeldHeartbeat();
      sendJson(response, 200, { released: true });
      return;
    }
    sendJson(response, 404, { error: "没有找到代理控制路由。" });
  })().catch((error: unknown) => sendFailure(response, error));
});

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
}

await Promise.all([
  listen(runtimeProxy, runtimePort),
  listen(control, controlPort),
]);
process.stdout.write(
  `heartbeat proxy ready: runtime=${String(runtimePort)} control=${String(controlPort)}\n`,
);
