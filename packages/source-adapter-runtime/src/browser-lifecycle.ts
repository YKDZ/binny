import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, rm, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  vncPasswordSchema,
  type BrowserPower,
  type RuntimeActiveHumanSession,
} from "@binny/contracts";
import type { SourceAdapterBrowserConnection } from "@binny/source-adapter-sdk";
import { chromium, type Browser, type BrowserContext } from "patchright-core";

type BrowserOptions = {
  readonly apiUrl?: string;
  readonly binId: string;
  readonly runtimeId?: string;
  readonly ownerGeneration?: string | (() => string);
  readonly profileDirectory: string;
  readonly display?: string;
  readonly onPowerChange: (power: BrowserPower) => Promise<void> | void;
};

type HumanSessionEnd = {
  readonly reason: "closed" | "expired" | "failed";
  readonly failure?: { readonly code: string; readonly message: string };
};

type HumanConnection = {
  readonly sessionId: string;
  readonly process: ChildProcess;
  readonly passwdFile: string;
  readonly socketPath: string;
  readonly eventServer: Server;
  readonly ended: Promise<HumanSessionEnd>;
  resolveEnded(result: HumanSessionEnd): void;
  phase: "opening" | "ready";
  clientConnected: boolean;
  acceptedClientId: string | undefined;
  firstConnectTimer: NodeJS.Timeout | undefined;
  stopPromise: Promise<void> | undefined;
  stopping: boolean;
};

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildVncHookCommand(
  socketPath: string,
  kind: "accepted" | "gone",
): string {
  const script = [
    'const net = require("node:net");',
    `const sock = net.connect(${JSON.stringify(socketPath)});`,
    'sock.on("error", () => {});',
    `sock.on("connect", () => sock.end(${JSON.stringify(`${kind}:`)} + (process.env.RFB_CLIENT_ID ?? "") + "\\n"));`,
  ].join("");
  return `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(script)}`;
}

async function createVncPasswordFile(
  password: string,
  passwdFile: string,
): Promise<void> {
  await rm(passwdFile, { force: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("x11vnc", ["-storepasswd", password, passwdFile], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `x11vnc -storepasswd failed (${String(code ?? signal ?? "unknown")}): ${stderr.trim()}`,
        ),
      );
    });
  });
  await chmod(passwdFile, 0o600);
}

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
      throw new Error("x11vnc process exited before listening on port 5900.");
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
  throw new Error("x11vnc listener on port 5900 did not become ready.");
}

/** 持有唯一 persistent context，并在 run 与人工会话之间复用它。 */
export class BrowserLifecycle {
  private readonly display: string;
  private context: BrowserContext | undefined;
  private browser: Browser | undefined;
  private workerEndpoint: string | undefined;
  private displayProcess: ChildProcess | undefined;
  private lockProcess: ChildProcess | undefined;
  private lockAcquiring: Promise<void> | undefined;
  private human: HumanConnection | undefined;
  private opening: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private power: BrowserPower = { status: "stopped" };
  private readonly options: BrowserOptions;

  constructor(options: BrowserOptions) {
    this.options = options;
    this.display = options.display ?? ":99";
  }

  /** 返回由实际 persistent context 与显示进程生命周期得出的当前状态。 */
  get currentPower(): BrowserPower {
    return this.power;
  }

  get isReady(): boolean {
    return (
      this.power.status === "ready" &&
      this.context !== undefined &&
      this.browser?.isConnected() === true
    );
  }

  /** Acquires the exclusive `.binny-runtime-owner.lock` on the shared profile volume. */
  async acquireOwnerLock(): Promise<void> {
    if (
      this.lockProcess !== undefined &&
      this.lockProcess.exitCode === null &&
      this.lockProcess.signalCode === null
    ) {
      return;
    }
    if (this.lockAcquiring !== undefined) return this.lockAcquiring;
    const task = (async () => {
      await mkdir(this.options.profileDirectory, {
        recursive: true,
        mode: 0o700,
      });
      const lockPath = path.join(
        this.options.profileDirectory,
        ".binny-runtime-owner.lock",
      );
      const child = spawn(
        "flock",
        [
          "--exclusive",
          "--nonblock",
          lockPath,
          "sh",
          "-c",
          "printf 'ready\\n'; exec cat",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const onData = (chunk: Buffer | string) => {
          stdout += String(chunk);
          if (!settled && stdout.includes("ready\n")) {
            settled = true;
            cleanup();
            resolve();
          }
        };
        const onErrData = (chunk: Buffer | string) => {
          stderr += String(chunk);
        };
        const onError = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onClose = (code: number | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          const detail = stderr.trim();
          const error = Object.assign(
            new Error(
              detail.length > 0
                ? `Unable to acquire exclusive browser profile lock ${lockPath} (exit=${String(code)}): ${detail}`
                : `Unable to acquire exclusive browser profile lock ${lockPath}: held by another runtime instance.`,
            ),
            { code: "browser_owner_lock_conflict" as const },
          );
          reject(error);
        };
        const cleanup = () => {
          child.stdout.off("data", onData);
          child.stderr.off("data", onErrData);
          child.off("error", onError);
          child.off("close", onClose);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onErrData);
        child.once("error", onError);
        child.once("close", onClose);
      });
      this.lockProcess = child;
    })();
    this.lockAcquiring = task;
    try {
      await task;
    } finally {
      if (this.lockAcquiring === task) this.lockAcquiring = undefined;
    }
  }

  async ensureReady(): Promise<void> {
    if (this.opening !== undefined) return this.opening;
    if (this.stopping !== undefined) {
      const stopped = this.stopping;
      const opening = stopped.then(() => this.startReady());
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
      }
      return;
    }
    const opening = this.startReady();
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  async bindWorkerEndpoint(
    runId: string,
  ): Promise<SourceAdapterBrowserConnection> {
    await this.ensureReady();
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
      // Persistent Chromium exits if the last window closes; keep one blank tab
      // and close every non-blank human or worker page so unload handlers fire.
      const keeper =
        pages.find((page) => page.url() === "about:blank") ??
        (await context.newPage());
      while (context.pages().length > 1) {
        await Promise.all(
          context
            .pages()
            .filter((page) => page !== keeper)
            .map((page) => page.close({ runBeforeUnload: false })),
        );
      }
      if (keeper.url() !== "about:blank") {
        await keeper.goto("about:blank");
      }
    } catch {
      // Restart the entire context if an exited worker left unclosable pages.
      await this.closeContext();
    }
  }

  getActiveHumanSessionSnapshot(): RuntimeActiveHumanSession | null {
    const human = this.human;
    if (human === undefined || human.stopping) return null;
    return {
      sessionId: human.sessionId,
      phase: human.phase,
      clientConnected: human.clientConnected,
    };
  }

  async openHumanSession(input: {
    readonly sessionId: string;
    readonly password: string;
    readonly connectTimeoutMs: number;
  }): Promise<{ readonly ended: Promise<HumanSessionEnd> }> {
    const password = vncPasswordSchema.parse(input.password);
    if (
      !Number.isSafeInteger(input.connectTimeoutMs) ||
      input.connectTimeoutMs < 1
    ) {
      throw new Error(
        "Human session connectTimeoutMs must be a positive integer.",
      );
    }
    await this.ensureReady();
    if (this.human !== undefined)
      throw new Error("Another human browser session is still cleaning up.");
    await this.cleanAutomaticPages();
    await this.ensureReady();
    const context = this.context;
    if (context === undefined) throw new Error("Browser is not ready.");
    const page = await context.newPage();
    await page.bringToFront();

    const passwdFile = path.join("/tmp", `binny-vnc-${input.sessionId}.passwd`);
    const socketPath = path.join("/tmp", `binny-vnc-${input.sessionId}.sock`);
    await createVncPasswordFile(password, passwdFile);
    await rm(socketPath, { force: true });

    let resolveEnded!: (result: HumanSessionEnd) => void;
    const ended = new Promise<HumanSessionEnd>((resolve) => {
      resolveEnded = resolve;
    });

    let human!: HumanConnection;
    const eventServer = createServer((connection) => {
      let buffer = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("accepted:")) {
            const clientId = line.slice("accepted:".length).trim();
            if (
              !human.stopping &&
              human.acceptedClientId === undefined &&
              clientId.length > 0
            ) {
              human.acceptedClientId = clientId;
              human.clientConnected = true;
              if (human.firstConnectTimer !== undefined) {
                clearTimeout(human.firstConnectTimer);
                human.firstConnectTimer = undefined;
              }
            }
          } else if (line.startsWith("gone:")) {
            const clientId = line.slice("gone:".length).trim();
            // Only tear down when the first authenticated client disconnects;
            // rejected second clients and bad-password probes do not match.
            if (
              !human.stopping &&
              human.acceptedClientId !== undefined &&
              clientId === human.acceptedClientId
            ) {
              void this.stopHuman(human, { reason: "closed" });
            }
          }
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        eventServer.once("error", reject);
        eventServer.listen(socketPath, () => {
          eventServer.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      await rm(passwdFile, { force: true });
      await rm(socketPath, { force: true });
      await this.cleanAutomaticPages();
      throw error;
    }

    const child = spawn(
      "x11vnc",
      [
        "-norc",
        "-display",
        this.display,
        "-rfbport",
        "5900",
        "-rfbauth",
        passwdFile,
        "-forever",
        "-nevershared",
        "-dontdisconnect",
        "-nolookup",
        "-noxdamage",
        "-afteraccept",
        buildVncHookCommand(socketPath, "accepted"),
        "-gone",
        buildVncHookCommand(socketPath, "gone"),
      ],
      { stdio: "ignore" },
    );

    human = {
      sessionId: input.sessionId,
      process: child,
      passwdFile,
      socketPath,
      eventServer,
      ended,
      resolveEnded,
      phase: "opening",
      clientConnected: false,
      acceptedClientId: undefined,
      firstConnectTimer: undefined,
      stopPromise: undefined,
      stopping: false,
    };
    this.human = human;

    child.once("error", () => {
      void this.stopHuman(human, {
        reason: "failed",
        failure: {
          code: "browser_vnc_failed",
          message: "Failed to start x11vnc process.",
        },
      });
    });
    child.once("close", (code, signal) => {
      if (!human.stopping) {
        void this.stopHuman(human, {
          reason: "failed",
          failure: {
            code: "browser_vnc_exited",
            message: `x11vnc exited unexpectedly (${String(code ?? signal ?? "unknown")}).`,
          },
        });
      }
    });

    try {
      await waitForTcpListener(5900, child);
    } catch (error) {
      await this.stopHuman(human, {
        reason: "failed",
        failure: {
          code: "browser_vnc_unavailable",
          message:
            error instanceof Error
              ? error.message
              : "x11vnc listener did not become ready.",
        },
      });
      throw error;
    }

    if (!human.stopping) {
      human.phase = "ready";
      if (human.acceptedClientId === undefined) {
        human.firstConnectTimer = setTimeout(() => {
          human.firstConnectTimer = undefined;
          if (!human.stopping && human.acceptedClientId === undefined) {
            void this.stopHuman(human, { reason: "expired" });
          }
        }, input.connectTimeoutMs);
        human.firstConnectTimer.unref();
      }
    }
    return { ended };
  }

  async closeHumanSession(sessionId: string): Promise<void> {
    const human = this.human;
    if (human === undefined || human.sessionId !== sessionId) return;
    await this.stopHuman(human);
  }

  async close(): Promise<void> {
    try {
      if (this.human !== undefined) await this.stopHuman(this.human);
      if (this.stopping !== undefined) await this.stopping;
      if (this.opening !== undefined) await this.opening;
      if (
        this.context === undefined &&
        this.browser === undefined &&
        this.displayProcess === undefined
      ) {
        if (this.power.status !== "unknown") {
          await this.setPower({ status: "stopped" });
        }
        return;
      }
      await this.setPower({ status: "stopping" });
      try {
        await this.closeBrowserLoad();
        await this.setPower({ status: "stopped" });
      } catch (error) {
        await this.setPower({
          status: "unknown",
          error: {
            code: "browser_stop_failed",
            message: "浏览器或显示进程没有确认退出，当前状态未知。",
          },
        });
        throw error;
      }
    } finally {
      await this.releaseOwnerLock();
    }
  }

  private async releaseOwnerLock(): Promise<void> {
    const lock = this.lockProcess;
    if (lock === undefined) return;
    if (this.lockProcess === lock) this.lockProcess = undefined;
    lock.stdin?.end();
    await terminateChild(lock);
  }

  private async setPower(power: BrowserPower): Promise<void> {
    this.power = power;
    await this.options.onPowerChange(power);
  }

  private async startReady(): Promise<void> {
    if (this.stopping !== undefined) await this.stopping;
    if (this.context !== undefined && this.browser?.isConnected()) {
      if (this.power.status !== "ready") {
        await this.setPower({ status: "ready" });
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

    await this.acquireOwnerLock();
    await this.setPower({ status: "starting" });
    try {
      if (this.context !== undefined || this.browser !== undefined)
        await this.closeContext();
      await this.launch();
      if (this.browser?.isConnected() !== true)
        throw new Error("持久浏览器在启动确认前已经断开连接。");
      await this.setPower({ status: "ready" });
    } catch (error) {
      await this.setPower({
        status: "unknown",
        error: {
          code: "browser_start_failed",
          message: "浏览器或显示进程没有确认启动，当前状态未知。",
        },
      });
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
          // entry.ts owns SIGINT/SIGTERM/SIGHUP shutdown; leaving Playwright's
          // handlers enabled triggers a concurrent gracefullyClose() that
          // force-kills Chromium before cookies flush to the persistent profile.
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
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

  private stopHuman(
    human: HumanConnection,
    result: HumanSessionEnd = { reason: "closed" },
  ): Promise<void> {
    if (human.stopPromise !== undefined) return human.stopPromise;
    human.stopping = true;
    const stopPromise = (async () => {
      if (human.firstConnectTimer !== undefined) {
        clearTimeout(human.firstConnectTimer);
        human.firstConnectTimer = undefined;
      }
      await terminateChild(human.process);
      await new Promise<void>((resolve) => {
        if (!human.eventServer.listening) {
          resolve();
          return;
        }
        human.eventServer.close(() => resolve());
      });
      await rm(human.passwdFile, { force: true });
      await rm(human.socketPath, { force: true });
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
