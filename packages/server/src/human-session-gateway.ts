import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import type { HumanSessionStore } from "@binny/core";
import { WebSocket, WebSocketServer, type RawData } from "ws";

type HumanSessionGatewayOptions = {
  readonly sessions: HumanSessionStore;
  readonly viewerWaitMs: number;
  readonly onUnexpectedClose: (
    binId: string,
    sessionId: string,
  ) => Promise<void>;
};

type SessionConnections = {
  readonly sessionId: string;
  readonly candidates: Set<Socket>;
  readonly viewers: Set<WebSocket>;
  readonly tunnels: Set<WebSocket>;
  binId?: string;
  viewerReserved: boolean;
  tunnelReserved: boolean;
  closing: boolean;
  closePromise: Promise<void> | undefined;
  viewerTimer: NodeJS.Timeout | undefined;
  retryTimer: NodeJS.Timeout | undefined;
  notifyCoreOnClose: boolean;
};

function rejectUpgrade(socket: Socket, status: number, phrase: string): void {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function closeSocket(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.destroy();
  });
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.terminate();
  });
}

function sendWebSocket(
  socket: WebSocket | undefined,
  data: RawData,
  binary: boolean,
) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(data, { binary });
}

function keepWebSocketAlive(socket: WebSocket): () => void {
  let alive = true;
  const timer = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 5_000);
  timer.unref();
  socket.on("pong", () => {
    alive = true;
  });
  return () => clearInterval(timer);
}

function sessionPath(pathname: string, prefix: string, suffix: string) {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix))
    return undefined;
  const sessionId = pathname.slice(prefix.length, -suffix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    sessionId,
  )
    ? sessionId.toLowerCase()
    : undefined;
}

/** 让公开 noVNC 只通过一条受控 WebSocket 隧道到达 runner 的 loopback VNC。 */
export class HumanSessionGateway {
  private readonly sessions = new Map<string, SessionConnections>();
  private readonly viewers = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has("binary") ? "binary" : false,
  });
  private readonly tunnels = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  private readonly options: HumanSessionGatewayOptions;

  constructor(options: HumanSessionGatewayOptions) {
    this.options = options;
  }

  attach(server: Server): () => void {
    const handleUpgrade = (
      request: IncomingMessage,
      socket: Socket,
      head: Buffer,
    ) => {
      void this.handleUpgrade(request, socket, head).catch((error: unknown) => {
        process.stderr.write(
          `浏览器会话连接处理失败：${error instanceof Error ? error.message : String(error)}\n`,
        );
        rejectUpgrade(socket, 503, "Service Unavailable");
      });
    };
    server.on("upgrade", handleUpgrade);
    return () => server.off("upgrade", handleUpgrade);
  }

  async closeSession(sessionId: string): Promise<void> {
    const canonicalSessionId = sessionId.toLowerCase();
    const state = this.sessions.get(canonicalSessionId);
    if (state === undefined) {
      await this.options.sessions.markHumanGatewayClosed(canonicalSessionId);
      return;
    }
    state.closing = true;
    await this.finishClose(state);
  }

  async close(): Promise<void> {
    for (const state of this.sessions.values()) {
      if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
    try {
      await Promise.allSettled(
        [...this.sessions.keys()].map((sessionId) =>
          this.closeSession(sessionId),
        ),
      );
    } finally {
      for (const state of this.sessions.values()) {
        if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
        state.retryTimer = undefined;
      }
      this.viewers.close();
      this.tunnels.close();
    }
  }

  private connections(sessionId: string): SessionConnections {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        sessionId,
        candidates: new Set(),
        viewers: new Set(),
        tunnels: new Set(),
        viewerTimer: undefined,
        retryTimer: undefined,
        viewerReserved: false,
        tunnelReserved: false,
        closing: false,
        closePromise: undefined,
        notifyCoreOnClose: false,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const viewerSessionId = sessionPath(
      url.pathname,
      "/human-sessions/",
      "/ws",
    );
    const tunnelSessionId = sessionPath(
      url.pathname,
      "/__runtime/human-sessions/",
      "/tunnel",
    );
    if (viewerSessionId !== undefined) {
      await this.handleViewerUpgrade(
        viewerSessionId,
        url,
        request,
        socket,
        head,
      );
      return;
    }
    if (tunnelSessionId !== undefined) {
      await this.handleTunnelUpgrade(
        tunnelSessionId,
        url,
        request,
        socket,
        head,
      );
      return;
    }
    rejectUpgrade(socket, 404, "Not Found");
  }

  private async handleViewerUpgrade(
    sessionId: string,
    url: URL,
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const state = this.connections(sessionId);
    if (state.closing || state.viewerReserved) {
      rejectUpgrade(socket, 409, "Conflict");
      return;
    }
    state.viewerReserved = true;
    state.candidates.add(socket);
    socket.once("close", () => state.candidates.delete(socket));
    const token = url.searchParams.get("token");
    const authorized =
      token !== null &&
      token.length > 0 &&
      (await this.options.sessions.authorizeHumanViewer(sessionId, token));
    if (!authorized || state.closing || socket.destroyed) {
      state.candidates.delete(socket);
      if (!state.closing && !socket.destroyed) state.viewerReserved = false;
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (state.tunnels.size !== 1) {
      state.candidates.delete(socket);
      rejectUpgrade(socket, 503, "Service Unavailable");
      void this.closeUnexpected(state);
      return;
    }

    this.viewers.handleUpgrade(request, socket, head, (viewer) => {
      state.candidates.delete(socket);
      if (state.closing) {
        viewer.terminate();
        return;
      }
      state.viewers.add(viewer);
      const stopViewerHeartbeat = keepWebSocketAlive(viewer);
      this.clearViewerTimer(state);
      viewer.on("message", (data, isBinary) => {
        sendWebSocket(state.tunnels.values().next().value, data, isBinary);
      });
      viewer.once("close", () => {
        stopViewerHeartbeat();
        state.viewers.delete(viewer);
        if (!state.closing) void this.closeUnexpected(state);
      });
      const tunnel = state.tunnels.values().next().value;
      if (tunnel?.readyState === WebSocket.OPEN) tunnel.send("connect");
      else void this.closeUnexpected(state);
    });
  }

  private async handleTunnelUpgrade(
    sessionId: string,
    url: URL,
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const state = this.connections(sessionId);
    const binId = url.searchParams.get("binId");
    const runtimeId = url.searchParams.get("runtimeId");
    const ownerGeneration = url.searchParams.get("ownerGeneration");
    const token = url.searchParams.get("token");
    if (
      state.closing ||
      state.tunnelReserved ||
      binId === null ||
      runtimeId === null ||
      ownerGeneration === null ||
      token === null
    ) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    state.tunnelReserved = true;
    state.candidates.add(socket);
    socket.once("close", () => state.candidates.delete(socket));
    const authorized = await this.options.sessions.authorizeHumanTunnel(
      sessionId,
      binId,
      runtimeId,
      ownerGeneration,
      token,
    );
    if (!authorized || state.closing || socket.destroyed) {
      state.candidates.delete(socket);
      if (!state.closing && !socket.destroyed) state.tunnelReserved = false;
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    this.tunnels.handleUpgrade(request, socket, head, (tunnel) => {
      state.candidates.delete(socket);
      if (state.closing) {
        tunnel.terminate();
        return;
      }
      state.binId = binId;
      state.tunnels.add(tunnel);
      const stopTunnelHeartbeat = keepWebSocketAlive(tunnel);
      state.viewerTimer = setTimeout(() => {
        if (state.viewers.size === 0) void this.closeUnexpected(state);
      }, this.options.viewerWaitMs);
      state.viewerTimer.unref();
      tunnel.on("message", (data, isBinary) => {
        sendWebSocket(state.viewers.values().next().value, data, isBinary);
      });
      tunnel.once("close", () => {
        stopTunnelHeartbeat();
        state.tunnels.delete(tunnel);
        if (!state.closing) void this.closeUnexpected(state);
      });
    });
  }

  private clearViewerTimer(state: SessionConnections): void {
    if (state.viewerTimer === undefined) return;
    clearTimeout(state.viewerTimer);
    state.viewerTimer = undefined;
  }

  private closeConnections(state: SessionConnections): Promise<void> {
    this.clearViewerTimer(state);
    const candidates = [...state.candidates];
    const sockets = [...state.viewers, ...state.tunnels];
    return Promise.all([
      ...candidates.map(closeSocket),
      ...sockets.map(closeWebSocket),
    ]).then(() => undefined);
  }

  private async closeUnexpected(state: SessionConnections): Promise<void> {
    if (state.closing) return;
    state.closing = true;
    state.notifyCoreOnClose = true;
    try {
      await this.finishClose(state);
    } catch (error) {
      process.stderr.write(
        `浏览器会话通道回收尚未确认，将重试：session=${state.sessionId} ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private async finishClose(state: SessionConnections): Promise<void> {
    if (state.closePromise !== undefined) return await state.closePromise;
    state.closePromise = (async () => {
      this.clearViewerTimer(state);
      // 先物理断开两端，数据库不可用时也不能留下仍可操作的旧会话。
      await this.closeConnections(state);
      if (state.notifyCoreOnClose && state.binId !== undefined)
        await this.options.onUnexpectedClose(state.binId, state.sessionId);
      await this.options.sessions.markHumanGatewayClosed(state.sessionId);
      if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
      this.sessions.delete(state.sessionId);
    })();
    try {
      await state.closePromise;
    } catch (error) {
      this.scheduleCloseRetry(state);
      throw error;
    } finally {
      state.closePromise = undefined;
    }
  }

  private scheduleCloseRetry(state: SessionConnections): void {
    if (state.retryTimer !== undefined) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      void this.finishClose(state).catch((error: unknown) => {
        process.stderr.write(
          `浏览器会话关闭确认仍失败：session=${state.sessionId} ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }, 1_000);
    state.retryTimer.unref();
  }
}
