import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export type VncCommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type VncCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<VncCommandResult>;

export type VncViewerHandle = {
  readonly id: string;
  readonly display: string;
  readonly windowId: string;
  readonly pid: number;
  isAlive(): Promise<boolean>;
  readLog(): Promise<string>;
  waitForExit(timeoutMs?: number): Promise<{
    readonly exited: boolean;
    readonly log: string;
  }>;
  navigateTo(url: string): Promise<void>;
  typeText(text: string, delayMs?: number): Promise<void>;
  pressKey(key: string): Promise<void>;
  closeGracefully(): Promise<void>;
  killForce(): Promise<void>;
};

export type VncViewerFixture = {
  connect(input: {
    readonly host: string;
    readonly port: number;
    readonly password: string;
    readonly shared?: boolean;
    readonly timeoutMs?: number;
  }): Promise<VncViewerHandle>;
  expectRejectedConnection(input: {
    readonly host: string;
    readonly port: number;
    readonly password: string;
    readonly shared?: boolean;
    readonly timeoutMs?: number;
  }): Promise<{ readonly log: string }>;
  close(): Promise<void>;
};

function formatVncTarget(host: string, port: number): string {
  const normalizedHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${normalizedHost}::${String(port)}`;
}

/**
 * Starts a detached acceptance container containing `Xvfb`, `xtigervncviewer`,
 * `tigervncpasswd`, and `xdotool` so tests can drive real native VNC sessions
 * over the host-mapped Docker ports from outside the runtime containers.
 */
export async function startVncViewerFixture(input: {
  readonly containerName: string;
  readonly image: string;
  readonly run: VncCommandRunner;
}): Promise<VncViewerFixture> {
  const launch = await input.run("docker", [
    "run",
    "--init",
    "--detach",
    "--name",
    input.containerName,
    "--network",
    "bridge",
    "--add-host=host.docker.internal:host-gateway",
    "--entrypoint",
    "node",
    input.image,
    "-e",
    "process.stdout.write('BINNY_VNC_VIEWER_FIXTURE_READY\\n'); setInterval(() => {}, 2147483647);",
  ]);
  assert.equal(
    launch.code,
    0,
    `Failed to start VNC viewer fixture container:\n${launch.stderr}`,
  );

  let nextDisplay = 100;
  let closed = false;

  async function execInFixture(
    script: string,
    args: readonly string[] = [],
  ): Promise<VncCommandResult> {
    return await input.run("docker", [
      "exec",
      input.containerName,
      "node",
      "--input-type=module",
      "-e",
      script,
      ...args,
    ]);
  }

  try {
    const deadline = Date.now() + 20_000;
    let logs = "";
    while (Date.now() < deadline) {
      const result = await input.run("docker", ["logs", input.containerName]);
      logs = result.stdout + result.stderr;
      if (logs.includes("BINNY_VNC_VIEWER_FIXTURE_READY")) break;
      await delay(100);
    }
    assert.ok(
      logs.includes("BINNY_VNC_VIEWER_FIXTURE_READY"),
      `Timed out waiting for VNC viewer fixture readiness:\n${logs}`,
    );
  } catch (error) {
    await input.run("docker", ["rm", "--force", input.containerName]);
    throw error;
  }

  async function startDisplay(display: string): Promise<number> {
    const started = await execInFixture(
      `import { spawn } from "node:child_process";
       import { access } from "node:fs/promises";
       import { setTimeout as delay } from "node:timers/promises";
       const display = process.argv[1];
       const socket = "/tmp/.X11-unix/X" + display.slice(1);
       const child = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
         detached: true,
         stdio: "ignore",
       });
       child.unref();
       const deadline = Date.now() + 10_000;
       while (Date.now() < deadline) {
         try {
           await access(socket);
           console.log(String(child.pid));
           process.exit(0);
         } catch {
           await delay(25);
         }
       }
       try { process.kill(child.pid, "SIGKILL"); } catch {}
       process.exit(1);`,
      [display],
    );
    assert.equal(
      started.code,
      0,
      `Failed to start Xvfb ${display}:\n${started.stdout}${started.stderr}`,
    );
    const pid = Number(started.stdout.trim());
    assert.ok(
      Number.isInteger(pid) && pid > 0,
      `Invalid Xvfb pid: ${started.stdout}`,
    );
    return pid;
  }

  async function stopViewerAndDisplay(
    sessionId: string,
    viewerPid: number,
    xvfbPid: number,
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<void> {
    await execInFixture(
      `import { rm } from "node:fs/promises";
       import { setTimeout as delay } from "node:timers/promises";
       const [sessionId, viewerPidText, xvfbPidText, signal] = process.argv.slice(1);
       const viewerPid = Number(viewerPidText);
       const xvfbPid = Number(xvfbPidText);
       const alive = (pid) => {
         try { process.kill(pid, 0); return true; } catch { return false; }
       };
       if (alive(viewerPid)) {
         try { process.kill(viewerPid, signal); } catch {}
         const deadline = Date.now() + 5_000;
         while (Date.now() < deadline && alive(viewerPid)) await delay(50);
         if (alive(viewerPid)) {
           try { process.kill(viewerPid, "SIGKILL"); } catch {}
         }
       }
       if (alive(xvfbPid)) {
         try { process.kill(xvfbPid, "SIGTERM"); } catch {}
       }
       await rm("/tmp/vnc-session-" + sessionId, { recursive: true, force: true });`,
      [sessionId, String(viewerPid), String(xvfbPid), signal],
    ).catch(() => undefined);
  }

  async function launchViewer(params: {
    readonly display: string;
    readonly target: string;
    readonly password: string;
    readonly shared: boolean;
  }): Promise<{ readonly sessionId: string; readonly viewerPid: number }> {
    const sessionId = randomUUID().slice(0, 8);
    const launched = await execInFixture(
      `import { spawn, spawnSync } from "node:child_process";
       import { openSync } from "node:fs";
       import { chmod, mkdir, writeFile } from "node:fs/promises";
       const [sessionId, display, target, password, sharedText] = process.argv.slice(1);
       const dir = "/tmp/vnc-session-" + sessionId;
       await mkdir(dir, { recursive: true });
       const passwdResult = spawnSync("tigervncpasswd", ["-f"], {
         input: password + "\\n",
       });
       if (passwdResult.status !== 0) {
         console.error(String(passwdResult.stderr ?? ""));
         process.exit(2);
       }
       const passwdFile = dir + "/session.passwd";
       await writeFile(passwdFile, passwdResult.stdout);
       await chmod(passwdFile, 0o600);
       const logFd = openSync(dir + "/viewer.log", "w");
       const args = [
         "-SecurityTypes", "VncAuth",
         "-passwd", passwdFile,
         "-RemoteResize=0",
         "-FullScreen=0",
         "-MenuKey=",
         "-ReconnectOnError=0",
         "-AlertOnFatalError=0",
         ...(sharedText === "true" ? ["-Shared=1"] : ["-Shared=0"]),
         target,
       ];
       const child = spawn("xtigervncviewer", args, {
         env: { ...process.env, DISPLAY: display },
         detached: true,
         stdio: ["ignore", logFd, logFd],
       });
       child.unref();
       console.log(String(child.pid));`,
      [
        sessionId,
        params.display,
        params.target,
        params.password,
        String(params.shared),
      ],
    );
    assert.equal(
      launched.code,
      0,
      `Failed to launch xtigervncviewer:\n${launched.stdout}${launched.stderr}`,
    );
    const viewerPid = Number(launched.stdout.trim());
    assert.ok(
      Number.isInteger(viewerPid) && viewerPid > 0,
      `Invalid xtigervncviewer pid: ${launched.stdout}`,
    );
    return { sessionId, viewerPid };
  }

  async function readSessionLog(sessionId: string): Promise<string> {
    const result = await execInFixture(
      `import { readFile } from "node:fs/promises";
       try {
         process.stdout.write(await readFile("/tmp/vnc-session-" + process.argv[1] + "/viewer.log", "utf8"));
       } catch {}`,
      [sessionId],
    );
    return result.stdout;
  }

  async function isPidAlive(pid: number): Promise<boolean> {
    const result = await execInFixture(
      `import { readFileSync } from "node:fs";
       const pid = Number(process.argv[1]);
       try {
         process.kill(pid, 0);
         const stat = readFileSync("/proc/" + String(pid) + "/stat", "utf8");
         const close = stat.lastIndexOf(")");
         const state = stat.slice(close + 2).trim().split(/\\s+/u)[0];
         console.log(state === "Z" ? "0" : "1");
       } catch {
         console.log("0");
       }`,
      [String(pid)],
    );
    return result.stdout.trim() === "1";
  }

  return {
    async connect(connectInput) {
      assert.ok(!closed, "VNC viewer fixture is already closed.");
      const display = `:${String(nextDisplay++)}`;
      const xvfbPid = await startDisplay(display);
      const target = formatVncTarget(connectInput.host, connectInput.port);
      const { sessionId, viewerPid } = await launchViewer({
        display,
        target,
        password: connectInput.password,
        shared: connectInput.shared ?? false,
      });

      const timeoutMs = connectInput.timeoutMs ?? 15_000;
      let windowId: string | undefined;
      try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const probe = await execInFixture(
            `import { spawnSync } from "node:child_process";
             import { readFileSync } from "node:fs";
             const [display, pidText] = process.argv.slice(1);
             let alive = true;
             try {
               process.kill(Number(pidText), 0);
               const stat = readFileSync("/proc/" + pidText + "/stat", "utf8");
               const close = stat.lastIndexOf(")");
               const procState = stat.slice(close + 2).trim().split(/\\s+/u)[0];
               if (procState === "Z") alive = false;
             } catch { alive = false; }
             const search = spawnSync("xdotool", ["search", "--onlyvisible", "--class", "TigerVNC"], {
               env: { ...process.env, DISPLAY: display },
               encoding: "utf8",
             });
             const ids = (search.stdout ?? "").trim().split(/\\s+/u).filter(Boolean);
             console.log(JSON.stringify({ alive, windowId: ids[0] ?? null }));`,
            [display, String(viewerPid)],
          );
          const state = JSON.parse(probe.stdout.trim()) as {
            readonly alive: boolean;
            readonly windowId: string | null;
          };
          if (state.windowId !== null) {
            windowId = state.windowId;
            break;
          }
          if (!state.alive) {
            const log = await readSessionLog(sessionId);
            throw new Error(
              `xtigervncviewer exited before mapping a VNC window (${target}):\n${log}`,
            );
          }
          await delay(100);
        }
        if (windowId === undefined) {
          const log = await readSessionLog(sessionId);
          throw new Error(
            `Timed out waiting for TigerVNC window (${target}):\n${log}`,
          );
        }
      } catch (error) {
        await stopViewerAndDisplay(sessionId, viewerPid, xvfbPid, "SIGKILL");
        throw error;
      }

      const activeWindowId = windowId;
      return {
        id: sessionId,
        display,
        windowId: activeWindowId,
        pid: viewerPid,
        async isAlive() {
          return await isPidAlive(viewerPid);
        },
        async readLog() {
          return await readSessionLog(sessionId);
        },
        async waitForExit(waitTimeoutMs = 15_000) {
          const deadline = Date.now() + waitTimeoutMs;
          while (Date.now() < deadline) {
            if (!(await isPidAlive(viewerPid))) {
              return { exited: true, log: await readSessionLog(sessionId) };
            }
            await delay(100);
          }
          return { exited: false, log: await readSessionLog(sessionId) };
        },
        async navigateTo(url) {
          const res = await execInFixture(
            `import { spawnSync } from "node:child_process";
             const [display, wid, url] = process.argv.slice(1);
             const env = { ...process.env, DISPLAY: display };
             const runTool = (args) => {
               const out = spawnSync("xdotool", args, { env, encoding: "utf8" });
               if (out.status !== 0) {
                 console.error(out.stderr);
                 process.exit(out.status ?? 1);
               }
             };
             runTool(["windowfocus", "--sync", wid]);
             runTool(["mousemove", "--window", wid, "640", "72", "click", "1"]);
             runTool(["key", "--clearmodifiers", "ctrl+l"]);
             runTool(["key", "--clearmodifiers", "ctrl+a"]);
             runTool(["type", "--delay", "15", url]);
             runTool(["key", "Return"]);`,
            [display, activeWindowId, url],
          );
          assert.equal(
            res.code,
            0,
            `VNC navigateTo(${url}) failed:\n${res.stdout}${res.stderr}`,
          );
        },
        async typeText(text, delayMs = 15) {
          const res = await execInFixture(
            `import { spawnSync } from "node:child_process";
             const [display, wid, delayMs, text] = process.argv.slice(1);
             const env = { ...process.env, DISPLAY: display };
             const runTool = (args) => {
               const out = spawnSync("xdotool", args, { env, encoding: "utf8" });
               if (out.status !== 0) {
                 console.error(out.stderr);
                 process.exit(out.status ?? 1);
               }
             };
             runTool(["windowfocus", "--sync", wid]);
             runTool(["type", "--delay", delayMs, text]);`,
            [display, activeWindowId, String(delayMs), text],
          );
          assert.equal(
            res.code,
            0,
            `VNC typeText failed:\n${res.stdout}${res.stderr}`,
          );
        },
        async pressKey(key) {
          const res = await execInFixture(
            `import { spawnSync } from "node:child_process";
             const [display, wid, key] = process.argv.slice(1);
             const env = { ...process.env, DISPLAY: display };
             const runTool = (args) => {
               const out = spawnSync("xdotool", args, { env, encoding: "utf8" });
               if (out.status !== 0) {
                 console.error(out.stderr);
                 process.exit(out.status ?? 1);
               }
             };
             runTool(["windowfocus", "--sync", wid]);
             runTool(["key", "--clearmodifiers", key]);`,
            [display, activeWindowId, key],
          );
          assert.equal(
            res.code,
            0,
            `VNC pressKey(${key}) failed:\n${res.stdout}${res.stderr}`,
          );
        },
        async closeGracefully() {
          await stopViewerAndDisplay(sessionId, viewerPid, xvfbPid, "SIGTERM");
        },
        async killForce() {
          await stopViewerAndDisplay(sessionId, viewerPid, xvfbPid, "SIGKILL");
        },
      };
    },

    async expectRejectedConnection(rejectInput) {
      assert.ok(!closed, "VNC viewer fixture is already closed.");
      const display = `:${String(nextDisplay++)}`;
      const xvfbPid = await startDisplay(display);
      const target = formatVncTarget(rejectInput.host, rejectInput.port);
      const { sessionId, viewerPid } = await launchViewer({
        display,
        target,
        password: rejectInput.password,
        shared: rejectInput.shared ?? false,
      });

      const timeoutMs = rejectInput.timeoutMs ?? 10_000;
      try {
        const deadline = Date.now() + timeoutMs;
        let exited = false;
        while (Date.now() < deadline) {
          const probe = await execInFixture(
            `import { spawnSync } from "node:child_process";
             import { readFileSync } from "node:fs";
             const [display, pidText] = process.argv.slice(1);
             let alive = true;
             try {
               process.kill(Number(pidText), 0);
               const stat = readFileSync("/proc/" + pidText + "/stat", "utf8");
               const close = stat.lastIndexOf(")");
               const procState = stat.slice(close + 2).trim().split(/\\s+/u)[0];
               if (procState === "Z") alive = false;
             } catch { alive = false; }
             const search = spawnSync("xdotool", ["search", "--onlyvisible", "--class", "TigerVNC"], {
               env: { ...process.env, DISPLAY: display },
               encoding: "utf8",
             });
             const ids = (search.stdout ?? "").trim().split(/\\s+/u).filter(Boolean);
             console.log(JSON.stringify({ alive, windowId: ids[0] ?? null }));`,
            [display, String(viewerPid)],
          );
          const state = JSON.parse(probe.stdout.trim()) as {
            readonly alive: boolean;
            readonly windowId: string | null;
          };
          assert.equal(
            state.windowId,
            null,
            `Rejected VNC connection unexpectedly opened a TigerVNC desktop window (${target}).`,
          );
          if (!state.alive) {
            exited = true;
            break;
          }
          await delay(100);
        }
        const log = await readSessionLog(sessionId);
        assert.ok(
          exited,
          `Rejected VNC connection did not exit within ${String(timeoutMs)}ms (${target}):\n${log}`,
        );
        return { log };
      } finally {
        await stopViewerAndDisplay(sessionId, viewerPid, xvfbPid, "SIGKILL");
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      await input
        .run("docker", ["rm", "--force", input.containerName])
        .catch(() => undefined);
    },
  };
}
