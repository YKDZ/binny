import {
  createServer,
  request as createRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { connect as createConnection } from "node:net";

const runtimePort = readPort("BINNY_E2E_PROXY_PORT", 8082);
const controlPort = readPort("BINNY_E2E_PROXY_CONTROL_PORT", 8083);

let armed = false;
let heldAt: number | undefined;
let clientClosedAt: number | undefined;
let heldForHumanOpenResponse = false;
let heldForward: (() => Promise<void>) | undefined;
let armedForStoppedRunId: string | undefined;
let armedForBinId = "binny-runs-one";
let armedForIdleHeartbeat = false;
let armedForHumanOpenResponse = false;
let armedForRequestBody = false;
let heldForRequestBody = false;
let heldRequestBodyStatusCode: number | undefined;
let heldRequestBodyError: string | undefined;
let heldRuntimeId: string | undefined;
let heldOwnerGeneration: string | undefined;
let heldStoppedRunId: string | undefined;
let forwardedRuntimeId: string | undefined;
let forwardedOwnerGeneration: string | undefined;
let forwardedAt: number | undefined;
let forwardedStatusCode: number | undefined;
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

type ForwardedResponse = {
  readonly body: Buffer;
  readonly statusCode: number;
  readonly deliver: () => void;
};

function forward(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
  deferResponse = false,
): Promise<ForwardedResponse> {
  return new Promise((resolve) => {
    const responseChunks: Buffer[] = [];
    let statusCode = 502;
    let headers: OutgoingHttpHeaders = {
      "content-type": "application/json",
    };
    let delivered = false;
    let finished = false;
    let responseBody = Buffer.alloc(0);
    const deliver = (): void => {
      if (!deferResponse || delivered || response.destroyed) return;
      delivered = true;
      response.writeHead(statusCode, headers);
      response.end(responseBody);
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      responseBody = Buffer.concat(responseChunks);
      resolve({ body: responseBody, statusCode, deliver });
    };
    const upstream = createRequest(
      {
        hostname: "server",
        port: 3000,
        path: request.url ?? "/",
        method: request.method ?? "GET",
        headers: { ...request.headers, host: "server:3000" },
      },
      (upstreamResponse) => {
        statusCode = upstreamResponse.statusCode ?? 502;
        headers = upstreamResponse.headers;
        if (!deferResponse && !response.destroyed)
          response.writeHead(statusCode, headers);
        response.once("close", () => {
          if (!response.writableEnded) upstreamResponse.resume();
        });
        upstreamResponse.once("end", () => {
          if (!deferResponse && !response.destroyed) response.end();
          finish();
        });
        upstreamResponse.once("error", (error: unknown) => {
          statusCode = 502;
          headers = { "content-type": "application/json" };
          const errorBody = Buffer.from(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          responseChunks.push(errorBody);
          if (!deferResponse) sendFailure(response, error);
          finish();
        });
        upstreamResponse.on("data", (chunk: Buffer) => {
          responseChunks.push(chunk);
          if (!deferResponse && !response.destroyed) response.write(chunk);
        });
      },
    );
    upstream.once("error", (error: unknown) => {
      statusCode = 502;
      headers = { "content-type": "application/json" };
      const errorBody = Buffer.from(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      responseChunks.push(errorBody);
      if (!deferResponse) sendFailure(response, error);
      finish();
    });
    upstream.end(body);
  });
}

function forwardWithRequestBodyHeld(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
): Promise<() => Promise<void>> {
  return new Promise((resolveHold, rejectHold) => {
    const responseChunks: Buffer[] = [];
    let statusCode = 502;
    let headers: OutgoingHttpHeaders = {
      "content-type": "application/json",
    };
    let upstreamFailure: unknown;
    let bodyHeld = false;
    let released = false;
    let responseFinished = false;
    let resolveResponse: () => void = () => {};
    const responseComplete = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const upstream = createRequest({
      hostname: "server",
      port: 3000,
      path: request.url ?? "/",
      method: request.method ?? "POST",
      headers: {
        ...request.headers,
        expect: "100-continue",
        host: "server:3000",
      },
    });
    // The server's automatic 100 Continue confirms it accepted the request headers.
    const continueTimeout = setTimeout(() => {
      upstream.destroy(
        new Error("The API did not accept the partial heartbeat body."),
      );
    }, 10_000);
    continueTimeout.unref();
    upstream.once("continue", () => {
      if (bodyHeld) return;
      bodyHeld = true;
      const splitAt = Math.min(body.length - 1, Math.ceil(body.length / 2));
      upstream.write(body.subarray(0, splitAt), () => {
        clearTimeout(continueTimeout);
        heldAt = Date.now();
        heldForRequestBody = true;
        resolveHold(async () => {
          if (released) return;
          released = true;
          upstream.end(body.subarray(splitAt));
          await responseComplete;
          if (upstreamFailure !== undefined) {
            heldRequestBodyStatusCode = 502;
            heldRequestBodyError =
              upstreamFailure instanceof Error
                ? upstreamFailure.message
                : "Upstream request failed.";
            forwardedStatusCode = heldRequestBodyStatusCode;
            sendFailure(response, upstreamFailure);
            return;
          }
          heldRequestBodyStatusCode = statusCode;
          forwardedStatusCode = statusCode;
          response.writeHead(statusCode, headers);
          response.end(Buffer.concat(responseChunks));
        });
      });
    });
    upstream.once("response", (upstreamResponse) => {
      if (!bodyHeld) {
        clearTimeout(continueTimeout);
        rejectHold(
          new Error("The API responded before accepting the heartbeat body."),
        );
      }
      statusCode = upstreamResponse.statusCode ?? 502;
      headers = upstreamResponse.headers;
      upstreamResponse.on("data", (chunk: Buffer) => {
        responseChunks.push(chunk);
      });
      upstreamResponse.once("end", () => {
        responseFinished = true;
        resolveResponse();
      });
      upstreamResponse.once("error", (error: unknown) => {
        upstreamFailure = error;
        responseFinished = true;
        resolveResponse();
      });
    });
    upstream.once("error", (error: unknown) => {
      clearTimeout(continueTimeout);
      upstreamFailure = error;
      if (!bodyHeld) rejectHold(error);
      if (!responseFinished) {
        responseFinished = true;
        resolveResponse();
      }
    });
    upstream.flushHeaders();
  });
}

function holdsHumanOpenResponse(body: Buffer): boolean {
  try {
    const value = JSON.parse(body.toString("utf8")) as {
      readonly humanSession?: { readonly action?: unknown };
    };
    return value.humanSession?.action === "open";
  } catch {
    return false;
  }
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
  if (
    armed &&
    armedForRequestBody &&
    requestBinId === armedForBinId &&
    isIdleHeartbeat
  ) {
    armed = false;
    heldAt = undefined;
    clientClosedAt = undefined;
    heldForHumanOpenResponse = false;
    heldForRequestBody = false;
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "runtimeId" in decoded &&
      typeof decoded.runtimeId === "string"
    ) {
      heldRuntimeId = decoded.runtimeId;
      forwardedRuntimeId = decoded.runtimeId;
    }
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "ownerGeneration" in decoded &&
      typeof decoded.ownerGeneration === "string"
    ) {
      heldOwnerGeneration = decoded.ownerGeneration;
      forwardedOwnerGeneration = decoded.ownerGeneration;
    }
    heldForward = await forwardWithRequestBodyHeld(request, response, body);
    return;
  }
  const matchesStoppedRun =
    typeof decoded === "object" &&
    decoded !== null &&
    (armedForIdleHeartbeat ||
      !("stoppedRunId" in decoded) ||
      decoded.stoppedRunId === armedForStoppedRunId);
  if (
    armed &&
    !armedForHumanOpenResponse &&
    requestBinId === armedForBinId &&
    isIdleHeartbeat &&
    matchesStoppedRun
  ) {
    armed = false;
    heldAt = Date.now();
    clientClosedAt = undefined;
    heldForHumanOpenResponse = false;
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
      const forwarded = await forward(request, response, body);
      forwarded.deliver();
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
  const deferForHumanOpenResponse =
    armed && armedForHumanOpenResponse && requestBinId === armedForBinId;
  const forwarded = await forward(
    request,
    response,
    body,
    deferForHumanOpenResponse,
  );
  forwardedStatusCode = forwarded.statusCode;
  const holdHumanOpenResponse =
    armed &&
    armedForHumanOpenResponse &&
    requestBinId === armedForBinId &&
    holdsHumanOpenResponse(forwarded.body);
  if (holdHumanOpenResponse) {
    armed = false;
    heldAt = Date.now();
    clientClosedAt = undefined;
    heldForHumanOpenResponse = true;
    response.once("close", () => {
      if (!response.writableEnded) clientClosedAt = Date.now();
    });
    heldForward = async () => {
      forwarded.deliver();
    };
    return;
  }
  forwarded.deliver();
  if (requestBinId !== undefined && decoded !== undefined) {
    try {
      const forwardedBody = JSON.parse(
        forwarded.body.toString("utf8"),
      ) as unknown;
      if (
        typeof forwardedBody === "object" &&
        forwardedBody !== null &&
        "browserIdleTimeoutSeconds" in forwardedBody &&
        (typeof forwardedBody.browserIdleTimeoutSeconds === "number" ||
          forwardedBody.browserIdleTimeoutSeconds === null)
      ) {
        forwardedBrowserIdleTimeoutSeconds =
          forwardedBody.browserIdleTimeoutSeconds;
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
  // A runtime reset is expected I/O; tear down only this tunnel, never the proxy process.
  const closeTunnel = (): void => {
    client.destroy();
    upstream.destroy();
  };
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
  upstream.once("error", closeTunnel);
  client.once("error", closeTunnel);
  upstream.once("close", () => client.destroy());
  client.once("close", () => upstream.destroy());
});

const control = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/control/status") {
      request.resume();
      sendJson(response, 200, {
        armed,
        held: heldForward !== undefined,
        heldForHumanOpenResponse,
        heldForRequestBody,
        ...(heldRequestBodyStatusCode === undefined
          ? {}
          : { heldRequestBodyStatusCode }),
        ...(heldRequestBodyError === undefined ? {} : { heldRequestBodyError }),
        ...(heldAt === undefined ? {} : { heldAt }),
        ...(clientClosedAt === undefined ? {} : { clientClosedAt }),
        ...(heldRuntimeId === undefined ? {} : { heldRuntimeId }),
        ...(heldOwnerGeneration === undefined ? {} : { heldOwnerGeneration }),
        ...(heldStoppedRunId === undefined ? {} : { heldStoppedRunId }),
        ...(armed ? { armedForBinId, armedForHumanOpenResponse } : {}),
        ...(forwardedRuntimeId === undefined ? {} : { forwardedRuntimeId }),
        ...(forwardedOwnerGeneration === undefined
          ? {}
          : { forwardedOwnerGeneration }),
        ...(forwardedStatusCode === undefined ? {} : { forwardedStatusCode }),
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
      const humanOpenResponse =
        typeof value === "object" &&
        value !== null &&
        "humanOpenResponse" in value &&
        value.humanOpenResponse === true;
      const requestBody =
        typeof value === "object" &&
        value !== null &&
        "requestBody" in value &&
        value.requestBody === true;
      const binId =
        typeof value === "object" &&
        value !== null &&
        "binId" in value &&
        typeof value.binId === "string"
          ? value.binId
          : "binny-runs-one";
      const stoppedRunId =
        typeof value === "object" &&
        value !== null &&
        "stoppedRunId" in value &&
        typeof value.stoppedRunId === "string"
          ? value.stoppedRunId
          : undefined;
      if (
        binId.length === 0 ||
        (!idleHeartbeat &&
          !humanOpenResponse &&
          !requestBody &&
          stoppedRunId === undefined)
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
      armedForHumanOpenResponse = humanOpenResponse;
      armedForRequestBody = requestBody;
      armedForStoppedRunId = stoppedRunId;
      heldAt = undefined;
      clientClosedAt = undefined;
      heldForHumanOpenResponse = false;
      heldForRequestBody = false;
      heldRequestBodyStatusCode = undefined;
      heldRequestBodyError = undefined;
      heldRuntimeId = undefined;
      heldOwnerGeneration = undefined;
      heldStoppedRunId = undefined;
      forwardedStatusCode = undefined;
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
