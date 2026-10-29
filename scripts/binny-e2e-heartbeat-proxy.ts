import {
  createServer,
  request as createRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as createConnection } from "node:net";

const runtimePort = readPort("BINNY_E2E_PROXY_PORT", 8082);
const controlPort = readPort("BINNY_E2E_PROXY_CONTROL_PORT", 8083);

let armed = false;
let heldAt: number | undefined;
let clientClosedAt: number | undefined;
let heldForward: (() => Promise<void>) | undefined;
let armedForStoppedRunId: string | undefined;
let armedForBinId = "binny15-one";
let armedForIdleHeartbeat = false;
let heldRuntimeId: string | undefined;
let heldOwnerGeneration: string | undefined;
let heldStoppedRunId: string | undefined;
let forwardedRuntimeId: string | undefined;
let forwardedOwnerGeneration: string | undefined;
let forwardedAt: number | undefined;
let forwardedBrowserIdleTimeoutSeconds: number | null | undefined;

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
): Promise<Buffer> {
  return new Promise((resolve) => {
    const responseChunks: Buffer[] = [];
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
          resolve(Buffer.concat(responseChunks));
        });
        upstreamResponse.once("error", (error: unknown) => {
          sendFailure(response, error);
          resolve(Buffer.concat(responseChunks));
        });
        upstreamResponse.on("data", (chunk: Buffer) => {
          responseChunks.push(chunk);
          if (!response.destroyed) response.write(chunk);
        });
      },
    );
    upstream.once("error", (error: unknown) => {
      sendFailure(response, error);
      resolve(Buffer.concat(responseChunks));
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
  const requestBinId = /^\/bins\/([^/]+)\/runtime\/heartbeat(?:\?|$)/u.exec(
    request.url ?? "",
  )?.[1];
  if (requestBinId !== undefined && body.length > 0) {
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
    (armedForIdleHeartbeat ||
      !("stoppedRunId" in decoded) ||
      decoded.stoppedRunId === armedForStoppedRunId);
  if (
    armed &&
    requestBinId === armedForBinId &&
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
    heldForward = async () => {
      await forward(request, response, body);
    };
    return;
  }
  if (
    requestBinId !== undefined &&
    typeof decoded === "object" &&
    decoded !== null &&
    "runtimeId" in decoded &&
    typeof decoded.runtimeId === "string"
  ) {
    forwardedRuntimeId = decoded.runtimeId;
  }
  if (
    requestBinId !== undefined &&
    typeof decoded === "object" &&
    decoded !== null &&
    "ownerGeneration" in decoded &&
    typeof decoded.ownerGeneration === "string"
  ) {
    forwardedOwnerGeneration = decoded.ownerGeneration;
  }
  const forwardedBody = await forward(request, response, body);
  if (requestBinId !== undefined && decoded !== undefined) {
    try {
      const forwarded = JSON.parse(forwardedBody.toString("utf8")) as unknown;
      if (
        typeof forwarded === "object" &&
        forwarded !== null &&
        "browserIdleTimeoutSeconds" in forwarded &&
        (typeof forwarded.browserIdleTimeoutSeconds === "number" ||
          forwarded.browserIdleTimeoutSeconds === null)
      ) {
        forwardedBrowserIdleTimeoutSeconds =
          forwarded.browserIdleTimeoutSeconds;
        forwardedAt = Date.now();
      }
    } catch {}
  }
}

const runtimeProxy = createServer((request, response) => {
  void handleRuntimeRequest(request, response).catch((error: unknown) =>
    sendFailure(response, error),
  );
});

runtimeProxy.on("upgrade", (request, client, head) => {
  const upstream = createConnection(3000, "server");
  upstream.once("connect", () => {
    const headers = [...request.rawHeaders];
    let hasHost = false;
    for (let index = 0; index < headers.length; index += 2) {
      if (headers[index]?.toLowerCase() !== "host") continue;
      headers[index + 1] = "server:3000";
      hasHost = true;
    }
    if (!hasHost) headers.push("Host", "server:3000");
    const headerLines: string[] = [];
    for (let index = 0; index < headers.length; index += 2) {
      headerLines.push(`${headers[index]}: ${headers[index + 1]}`);
    }
    upstream.write(
      `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`,
    );
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.once("error", () => client.destroy());
  client.once("close", () => upstream.destroy());
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
        ...(armed ? { armedForBinId } : {}),
        ...(forwardedRuntimeId === undefined ? {} : { forwardedRuntimeId }),
        ...(forwardedOwnerGeneration === undefined
          ? {}
          : { forwardedOwnerGeneration }),
        ...(forwardedAt === undefined ? {} : { forwardedAt }),
        ...(forwardedBrowserIdleTimeoutSeconds === undefined
          ? {}
          : { forwardedBrowserIdleTimeoutSeconds }),
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
      const idleHeartbeat =
        typeof value === "object" &&
        value !== null &&
        "idleHeartbeat" in value &&
        value.idleHeartbeat === true;
      const binId =
        typeof value === "object" &&
        value !== null &&
        "binId" in value &&
        typeof value.binId === "string"
          ? value.binId
          : "binny15-one";
      const stoppedRunId =
        typeof value === "object" &&
        value !== null &&
        "stoppedRunId" in value &&
        typeof value.stoppedRunId === "string"
          ? value.stoppedRunId
          : undefined;
      if (
        binId.length === 0 ||
        (!idleHeartbeat && stoppedRunId === undefined)
      ) {
        sendJson(response, 400, {
          error: "必须指定 bin 以及 idle heartbeat 或待确认的 run。",
        });
        return;
      }
      if (armed || heldForward !== undefined) {
        sendJson(response, 409, { error: "已有心跳等待释放。" });
        return;
      }
      armed = true;
      armedForBinId = binId;
      armedForIdleHeartbeat = idleHeartbeat;
      armedForStoppedRunId = stoppedRunId;
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
