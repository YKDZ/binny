import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { BrowserPower } from "@binny/contracts";
import type { SourceAdapterBrowserConnection } from "@binny/source-adapter-sdk";
import { chromium, type Browser, type BrowserContext } from "patchright-core";
import WebSocket from "ws";

type BrowserOptions = {
  readonly apiUrl: string;
  readonly binId: string;
  readonly runtimeId: string;
  readonly ownerGeneration: string | (() => string);
  readonly profileDirectory: string;
  readonly display?: string;
  readonly onPowerChange: (
    power: BrowserPower,
    reservationId: string | undefined,
    event?: BrowserPowerEvent,
  ) => Promise<BrowserPowerChangeResult>;
};

export type BrowserPowerEvent =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "unknown"
  | "not_started";

export type BrowserPowerChangeResult = "accepted" | "rejected" | "unavailable";

type HumanSessionEnd = {
  readonly failure?: { readonly code: string; readonly message: string };
};

type HumanConnection = {
  readonly sessionId: string;
  readonly process: ChildProcess;
  readonly tunnel: WebSocket;
  readonly ended: Promise<HumanSessionEnd>;
  resolveEnded(result: HumanSessionEnd): void;
  heartbeat: NodeJS.Timeout | undefined;
  vncSocket: Socket | undefined;
  stopPromise: Promise<void> | undefined;
  stopping: boolean;
};

function childExited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await childExited(child);
    return;
  }
  const exited = childExited(child);
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(1_500).then(() => false),
  ]);
  if (!graceful) child.kill("SIGKILL");
  await exited;
}

function websocketUrl(apiUrl: string, path: string): URL {
  const endpoint = new URL(apiUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  endpoint.pathname = path;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function openTcpConnection(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

async function waitForTcpListener(
  port: number,
  child: ChildProcess,
): Promise<void> {
  const exited = childExited(child);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await exited;
      throw new Error("浏览器画面进程在启动期间退出。");
    }
    try {
      const socket = await openTcpConnection(port);
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.destroy();
      });
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error("浏览器画面服务没有在期限内就绪。");
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.off("error", onError);
      socket.off("close", onClose);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      socket.off("close", onClose);
      reject(error);
    };
    const onClose = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      reject(new Error("浏览器人工通道在连接完成前关闭。"));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/** 持有唯一 persistent context，并在 run 与人工会话之间复用它。 */
export class BrowserLifecycle {
  private readonly display: string;
  private context: BrowserContext | undefined;
  private browser: Browser | undefined;
  private workerEndpoint: string | undefined;
  private displayProcess: ChildProcess | undefined;
  private human: HumanConnection | undefined;
  private opening: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private power: BrowserPower = { status: "stopped" };
  private reservationId: string | undefined;
  private startedReservationId: string | undefined;
  private readonly options: BrowserOptions;

  constructor(options: BrowserOptions) {
    this.options = options;
    this.display = options.display ?? ":99";
  }

  /** 返回由实际 persistent context 与显示进程生命周期得出的当前状态。 */
  get currentPower(): BrowserPower {
    return this.power;
  }

  async ensureReady(reservationId: string): Promise<void> {
    this.adoptReservation(reservationId);
    if (this.opening !== undefined) return this.opening;
    if (this.stopping !== undefined) {
      const stopped = this.stopping;
      const opening = stopped.then(() => this.startReady(reservationId));
      this.opening = opening;
      try {
        await opening;
      } finally {
        if (this.opening === opening) this.opening = undefined;
      }
      return;
    }
    if (this.context !== undefined && this.browser?.isConnected()) {
      if (this.power.status !== "ready") {
        await this.setPower({ status: "ready" });
        await this.reportPower("ready", reservationId);
      }
      return;
    }
    const opening = this.startReady(reservationId);
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  /** 仅在调用方已释放自动与人工使用权后关闭浏览器和显示进程。 */
  async closeWhenIdle(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    if (this.opening !== undefined)
      throw new Error("浏览器仍在启动，暂时不能进入空闲关闭。");
    if (this.human !== undefined)
      throw new Error("人工操作仍持有浏览器，暂时不能进入空闲关闭。");

    const stopping = (async () => {
      const reservationId = this.reservationId;
      const stoppingAck =
        reservationId === undefined
          ? Promise.resolve<BrowserPowerChangeResult>("accepted")
          : this.reportPower("stopping", reservationId);
      await this.setPower({ status: "stopping" });
      try {
        await this.closeBrowserLoad();
        await this.setPower({ status: "stopped" });
        await stoppingAck;
        if (reservationId !== undefined)
          await this.reportPower("stopped", reservationId);
      } catch (error) {
        await this.setPower({
          status: "unknown",
          error: {
            code: "browser_stop_failed",
            message: "浏览器或显示进程没有确认退出，当前状态未知。",
          },
        });
        if (reservationId !== undefined)
          await this.reportPower("unknown", reservationId);
        throw error;
      }
    })();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  async bindWorkerEndpoint(
    runId: string,
    reservationId: string,
  ): Promise<SourceAdapterBrowserConnection> {
    await this.ensureReady(reservationId);
    if (this.browser === undefined) throw new Error("浏览器尚未就绪。");
    if (this.workerEndpoint !== undefined)
      throw new Error("浏览器仍绑定着上一次的自动控制入口。");
    const bound = await this.browser.bind(
      `binny-${this.options.binId}-${runId}`,
      {
        host: "127.0.0.1",
        port: 0,
        workspaceDir: this.options.profileDirectory,
      },
    );
    this.workerEndpoint = bound.endpoint;
    return {
      protocol: "playwright",
      endpoint: bound.endpoint,
      playwrightVersion: "1.64.2",
    };
  }

  async unbindWorkerEndpoint(): Promise<void> {
    if (this.workerEndpoint === undefined) return;
    if (this.browser?.isConnected()) await this.browser.unbind();
    this.workerEndpoint = undefined;
  }

  async cleanAutomaticPages(): Promise<void> {
    const context = this.context;
    if (context === undefined) return;
    try {
      const pages = context.pages();
      // 持久 Chromium 在关闭最后一个窗口后会退出；空闲复用期间留一个空白页。
      const keeper = pages[0] ?? (await context.newPage());
      while (context.pages().length > 1) {
        await Promise.all(
          context
            .pages()
            .filter((page) => page !== keeper)
            .map((page) => page.close({ runBeforeUnload: false })),
        );
      }
      await keeper.goto("about:blank");
    } catch {
      // 已退出 worker 仍留下不能关闭的页面时，重启整个 context 才能确认交接。
      await this.closeContext();
    }
  }

  async openHumanSession(
    sessionId: string,
    tunnelToken: string,
    reservationId: string,
  ): Promise<{ readonly ended: Promise<HumanSessionEnd> }> {
    await this.ensureReady(reservationId);
    if (this.human !== undefined)
      throw new Error("另一个浏览器人工通道仍在清理。");
    await this.cleanAutomaticPages();
    await this.ensureReady(reservationId);
    const context = this.context;
    if (context === undefined) throw new Error("浏览器尚未就绪。");
    const page = await context.newPage();
    await page.bringToFront();

    const child = spawn(
      "x11vnc",
      [
        "-norc",
        "-display",
        this.display,
        "-localhost",
        "-nopw",
        "-forever",
        "-rfbport",
        "5900",
        "-nolookup",
        "-noxdamage",
      ],
      { stdio: "ignore" },
    );
    try {
      await waitForTcpListener(5900, child);
    } catch (error) {
      await terminateChild(child);
      throw error;
    }
    const tunnelEndpoint = websocketUrl(
      this.options.apiUrl,
      `/__runtime/human-sessions/${sessionId}/tunnel`,
    );
    tunnelEndpoint.searchParams.set("binId", this.options.binId);
    tunnelEndpoint.searchParams.set("runtimeId", this.options.runtimeId);
    tunnelEndpoint.searchParams.set(
      "ownerGeneration",
      typeof this.options.ownerGeneration === "function"
        ? this.options.ownerGeneration()
        : this.options.ownerGeneration,
    );
    tunnelEndpoint.searchParams.set("token", tunnelToken);
    const tunnel = new WebSocket(tunnelEndpoint, {
      handshakeTimeout: 10_000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    });
    tunnel.binaryType = "nodebuffer";
    let resolveEnded!: (result: HumanSessionEnd) => void;
    const ended = new Promise<HumanSessionEnd>((resolve) => {
      resolveEnded = resolve;
    });
    const human: HumanConnection = {
      sessionId,
      process: child,
      tunnel,
      ended,
      resolveEnded,
      heartbeat: undefined,
      vncSocket: undefined,
      stopPromise: undefined,
      stopping: false,
    };
    this.human = human;
    child.once("error", () => {
      void this.stopHuman(human, {
        failure: {
          code: "browser_vnc_failed",
          message: "浏览器画面没有正常启动。",
        },
      });
    });
    child.once("close", (code, signal) => {
      if (!human.stopping) {
        void this.stopHuman(human, {
          failure: {
            code: "browser_vnc_exited",
            message: `浏览器画面意外退出（${String(code ?? signal ?? "unknown")}）。`,
          },
        });
      }
    });
    tunnel.on("message", (data, isBinary) => {
      const payload = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (!isBinary) {
        if (payload.toString("utf8") === "connect") void this.connectVnc(human);
        return;
      }
      if (human.vncSocket?.writable === true) human.vncSocket.write(payload);
    });
    tunnel.once("close", () => {
      void this.stopHuman(human);
    });
    let tunnelAlive = true;
    tunnel.on("pong", () => {
      tunnelAlive = true;
    });
    human.heartbeat = setInterval(() => {
      if (!tunnelAlive) {
        tunnel.terminate();
        return;
      }
      tunnelAlive = false;
      tunnel.ping();
    }, 5_000);
    human.heartbeat.unref();
    try {
      await waitForWebSocketOpen(tunnel);
    } catch (error) {
      await this.stopHuman(human);
      throw error;
    }
    return { ended };
  }

  async closeHumanSession(sessionId: string): Promise<void> {
    const human = this.human;
    if (human === undefined || human.sessionId !== sessionId) return;
    await this.stopHuman(human);
  }

  async close(): Promise<void> {
    if (this.human !== undefined) await this.stopHuman(this.human);
    if (this.stopping !== undefined) await this.stopping;
    if (this.opening !== undefined) await this.opening;
    if (
      this.context === undefined &&
      this.browser === undefined &&
      this.displayProcess === undefined
    ) {
      if (this.power.status === "unknown") return;
      await this.setPower({ status: "stopped" });
      if (this.reservationId !== undefined) {
        if (this.startedReservationId === this.reservationId)
          await this.confirmStopped(this.reservationId);
        else await this.confirmNotStarted(this.reservationId);
      }
      return;
    }
    const reservationId = this.reservationId;
    const stoppingAck =
      reservationId === undefined
        ? Promise.resolve<BrowserPowerChangeResult>("accepted")
        : this.reportPower("stopping", reservationId);
    await this.setPower({ status: "stopping" });
    try {
      await this.closeBrowserLoad();
      await this.setPower({ status: "stopped" });
      await stoppingAck.catch(() => "unavailable" as const);
      if (reservationId !== undefined) await this.confirmStopped(reservationId);
    } catch (error) {
      await this.setPower({
        status: "unknown",
        error: {
          code: "browser_stop_failed",
          message: "浏览器或显示进程没有确认退出，当前状态未知。",
        },
      });
      if (reservationId !== undefined)
        await this.reportPower("unknown", reservationId);
      throw error;
    }
  }

  async confirmNotStarted(
    reservationId: string,
  ): Promise<BrowserPowerChangeResult> {
    if (this.startedReservationId === reservationId) {
      if (
        this.power.status === "stopped" &&
        this.context === undefined &&
        this.browser === undefined &&
        this.displayProcess === undefined
      )
        return await this.confirmStopped(reservationId);
      return "accepted";
    }
    const result = await this.options.onPowerChange(
      { status: "stopped" },
      reservationId,
      "not_started",
    );
    if (result === "accepted" && this.reservationId === reservationId)
      this.reservationId = undefined;
    return result;
  }

  private async setPower(
    power: BrowserPower,
    event?: BrowserPowerEvent,
    reservationId = this.reservationId,
  ): Promise<BrowserPowerChangeResult> {
    this.power = power;
    return await this.options.onPowerChange(power, reservationId, event);
  }

  private async reportPower(
    event: BrowserPowerEvent,
    reservationId: string,
  ): Promise<BrowserPowerChangeResult> {
    return await this.options.onPowerChange(this.power, reservationId, event);
  }

  private async confirmStopped(
    reservationId: string,
  ): Promise<BrowserPowerChangeResult> {
    const stopping = await this.reportPower("stopping", reservationId);
    if (stopping !== "accepted") return stopping;
    const stopped = await this.reportPower("stopped", reservationId);
    if (stopped === "accepted" && this.startedReservationId === reservationId)
      this.startedReservationId = undefined;
    return stopped;
  }

  private adoptReservation(reservationId: string): void {
    if (this.reservationId === reservationId) return;
    if (
      this.reservationId !== undefined &&
      this.context === undefined &&
      this.browser === undefined &&
      this.displayProcess === undefined &&
      this.power.status === "stopped"
    ) {
      this.reservationId = reservationId;
      this.startedReservationId = undefined;
      return;
    }
    if (this.reservationId === undefined) {
      this.reservationId = reservationId;
      return;
    }
    throw new Error("当前浏览器仍绑定着其他容量预约，拒绝跨尝试复用。");
  }

  private async startReady(reservationId: string): Promise<void> {
    if (this.stopping !== undefined) await this.stopping;
    if (this.context !== undefined && this.browser?.isConnected()) {
      if (this.power.status !== "ready") {
        await this.setPower({ status: "ready" });
        await this.reportPower("ready", reservationId);
      }
      return;
    }
    if (
      this.power.status === "unknown" &&
      this.context === undefined &&
      this.browser === undefined
    ) {
      throw new Error(
        this.power.error?.message ?? "浏览器当前状态未知，暂时不能启动新实例。",
      );
    }

    const starting = await this.options.onPowerChange(
      this.power,
      reservationId,
      "starting",
    );
    if (starting !== "accepted") {
      await this.options.onPowerChange(
        { status: "stopped" },
        reservationId,
        "not_started",
      );
      throw new Error("核心没有确认浏览器预约；拒绝发出启动动作。");
    }
    this.startedReservationId = reservationId;
    await this.setPower({ status: "starting" });
    try {
      if (this.context !== undefined || this.browser !== undefined)
        await this.closeContext();
      await this.launch();
      if (this.browser?.isConnected() !== true)
        throw new Error("持久浏览器在启动确认前已经断开连接。");
      await this.setPower({ status: "ready" });
      await this.reportPower("ready", reservationId);
    } catch (error) {
      await this.setPower({
        status: "unknown",
        error: {
          code: "browser_start_failed",
          message: "浏览器或显示进程没有确认启动，当前状态未知。",
        },
      });
      await this.reportPower("unknown", reservationId);
      throw error;
    }
  }

  private async closeBrowserLoad(): Promise<void> {
    await this.unbindWorkerEndpoint();
    await this.closeContext();
    const display = this.displayProcess;
    if (display !== undefined) {
      await terminateChild(display);
      if (this.displayProcess === display) this.displayProcess = undefined;
    }
  }

  private async launch(): Promise<void> {
    await mkdir(this.options.profileDirectory, {
      recursive: true,
      mode: 0o700,
    });
    // 独占 owner flock 已排除其他运行器；容器强退后清理 Chromium 留下的 profile 锁。
    for (const lockFile of [
      "SingletonLock",
      "SingletonCookie",
      "SingletonSocket",
    ]) {
      try {
        await unlink(path.join(this.options.profileDirectory, lockFile));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
    }
    await this.startDisplay();
    process.env.DISPLAY = this.display;
    try {
      const context = await chromium.launchPersistentContext(
        this.options.profileDirectory,
        {
          channel: "chrome",
          args: [
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            // Xvfb 镜像不含窗口管理器，直接指定窗口尺寸以匹配画面。
            "--window-size=1280,800",
            "--no-sandbox",
          ],
          headless: false,
          viewport: null,
        },
      );
      const browser = context.browser();
      if (browser === null) {
        await context.close();
        throw new Error("持久浏览器没有关联浏览器控制实例。");
      }
      this.context = context;
      this.browser = browser;
      browser.once("disconnected", () => {
        if (this.context !== context || this.power.status !== "ready") return;
        void this.setPower({
          status: "unknown",
          error: {
            code: "browser_interrupted",
            message: "浏览器连接意外中断，当前进程状态未知。",
          },
        }).catch((error: unknown) => {
          process.stderr.write(
            `浏览器中断状态没有回报：${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      });
    } catch (error) {
      const display = this.displayProcess;
      this.displayProcess = undefined;
      if (display !== undefined) await terminateChild(display);
      throw error;
    }
  }

  private async startDisplay(): Promise<void> {
    if (this.displayProcess !== undefined) return;
    const displayNumber = this.display.replace(/^:/u, "");
    const displaySocket = `/tmp/.X11-unix/X${displayNumber}`;
    const child = spawn(
      "Xvfb",
      [this.display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
      { stdio: "ignore" },
    );
    this.displayProcess = child;
    const exited = childExited(child);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        throw new Error("虚拟显示器在启动期间退出。");
      }
      try {
        await access(displaySocket);
        return;
      } catch {
        await delay(25);
      }
    }
    await terminateChild(child);
    this.displayProcess = undefined;
    throw new Error("虚拟显示器没有在期限内就绪。");
  }

  private async connectVnc(human: HumanConnection): Promise<void> {
    if (
      human.stopping ||
      human.vncSocket !== undefined ||
      human.tunnel.readyState !== WebSocket.OPEN
    )
      return;
    try {
      const socket = await openTcpConnection(5900);
      if (human.stopping) {
        socket.destroy();
        return;
      }
      human.vncSocket = socket;
      socket.on("data", (data) => {
        if (human.tunnel.readyState === WebSocket.OPEN)
          human.tunnel.send(data, { binary: true });
      });
      socket.once("error", () => {
        if (!human.stopping) {
          void this.stopHuman(human, {
            failure: {
              code: "browser_vnc_connection_failed",
              message: "浏览器画面连接已意外中断。",
            },
          });
        }
      });
      socket.once("close", () => {
        if (!human.stopping) void this.stopHuman(human);
      });
    } catch {
      await this.stopHuman(human, {
        failure: {
          code: "browser_vnc_unavailable",
          message: "浏览器画面连接没有就绪。",
        },
      });
    }
  }

  private stopHuman(
    human: HumanConnection,
    result: HumanSessionEnd = {},
  ): Promise<void> {
    if (human.stopPromise !== undefined) return human.stopPromise;
    human.stopping = true;
    const stopPromise = (async () => {
      if (human.heartbeat !== undefined) clearInterval(human.heartbeat);
      human.heartbeat = undefined;
      if (human.vncSocket !== undefined) {
        const socket = human.vncSocket;
        human.vncSocket = undefined;
        if (!socket.destroyed) {
          await new Promise<void>((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
          });
        }
      }
      if (human.tunnel.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          human.tunnel.once("close", () => resolve());
          human.tunnel.terminate();
        });
      }
      await terminateChild(human.process);
      await this.cleanAutomaticPages();
      this.human = this.human === human ? undefined : this.human;
      human.resolveEnded(result);
    })();
    human.stopPromise = stopPromise;
    return stopPromise.catch((error: unknown) => {
      if (human.stopPromise === stopPromise) human.stopPromise = undefined;
      throw error;
    });
  }

  private async closeContext(): Promise<void> {
    const context = this.context;
    if (context !== undefined) await context.close();
    if (this.context === context) {
      this.context = undefined;
      this.browser = undefined;
      this.workerEndpoint = undefined;
    }
  }
}
