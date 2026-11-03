import { setTimeout as delay } from "node:timers/promises";

import type { CDPSession, Page } from "patchright-core";

export type ChallengeRecoverySummary = {
  rounds: number;
  elapsedMs: number;
  successes: number;
};

/** 一次动作的读取共享预算；调用方负责以原业务校验确认重读结果。 */
export class ChallengeRecovery {
  failureMessage: string | undefined;
  readonly summary: ChallengeRecoverySummary = {
    rounds: 0,
    elapsedMs: 0,
    successes: 0,
  };

  private readonly page: Page;
  private readonly signal: AbortSignal;

  constructor(page: Page, signal: AbortSignal) {
    this.page = page;
    this.signal = signal;
  }

  async recover<T>(
    url: URL,
    read: (remainingMs: number) => Promise<T>,
    valid: (value: T) => boolean,
    blocked: (value: T) => boolean,
  ): Promise<T | undefined> {
    this.signal.throwIfAborted();
    this.failureMessage = undefined;
    if (this.summary.rounds >= 3 || this.summary.elapsedMs >= 90_000) {
      this.failureMessage = `自动恢复的运行轮次或时间预算已耗尽（成功 ${String(this.summary.successes)} 轮）。`;
      return undefined;
    }
    this.summary.rounds += 1;
    const started = performance.now();
    const deadline =
      started + Math.min(30_000, 90_000 - this.summary.elapsedMs);
    const remaining = () =>
      Math.max(0, Math.ceil(deadline - performance.now()));
    const timeout = () => {
      this.signal.throwIfAborted();
      const milliseconds = remaining();
      // 浏览器 API 将 0 解释为无限等待，不能直接传入耗尽的预算。
      if (milliseconds === 0) {
        throw new DOMException("挑战恢复时间已耗尽。", "TimeoutError");
      }
      return milliseconds;
    };
    let expire: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      expire = setTimeout(
        () => reject(new DOMException("恢复预算耗尽。", "TimeoutError")),
        timeout(),
      );
      cancel = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", cancel, { once: true });
    });
    const within = async <V>(operation: () => Promise<V>): Promise<V> => {
      timeout();
      return await Promise.race([operation(), interrupted]);
    };
    let result: T | undefined;
    let clicks = 0;
    let probeAfter = started + 5_000;
    let navigation: CDPSession | undefined;
    let navigating = false;
    let finished = false;
    try {
      navigation = await within(async () => {
        const session = await this.page.context().newCDPSession(this.page);
        if (finished || remaining() === 0 || this.signal.aborted) {
          void session.detach().catch(() => undefined);
          timeout();
        }
        return session;
      });
      const session = navigation;
      // 普通读取使用 no-store；恢复导航同样不能展示此前缓存的 JSON。
      await within(() => session.send("Network.enable"));
      await within(() =>
        session.send("Network.setCacheDisabled", {
          cacheDisabled: true,
        }),
      );
      navigating = true;
      await within(() =>
        this.page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: timeout(),
        }),
      );
      navigating = false;
      while (remaining() > 0) {
        this.signal.throwIfAborted();
        let html: string;
        try {
          html = await within(() => this.page.content());
        } catch (error) {
          if (!isNavigationTransition(error)) throw error;
          await delay(Math.min(50, remaining()), undefined, {
            signal: this.signal,
          });
          continue;
        }
        const challengeVisible =
          /_cf_chl_opt|\/cdn-cgi\/challenge-platform\//u.test(html);
        if (clicks < 2 && challengeVisible) {
          for (const frame of this.page.frames()) {
            // 只操作当前挑战页及其 Cloudflare 组件，不点击其他嵌入内容。
            if (
              frame !== this.page.mainFrame() &&
              !isCloudflareFrame(frame.url())
            ) {
              continue;
            }
            const checkbox = frame.getByRole("checkbox").first();
            if (
              remaining() > 0 &&
              (await within(() => checkbox.isVisible())) &&
              (await within(() => checkbox.isEnabled())) &&
              !(await within(() => checkbox.isChecked({ timeout: timeout() })))
            ) {
              await within(() => checkbox.click({ timeout: timeout() }));
              clicks += 1;
              break;
            }
          }
        }
        if (remaining() <= 0) break;
        await delay(Math.min(500, remaining()), undefined, {
          signal: this.signal,
        });
        if (remaining() <= 0) break;
        // 脚本可能在验证完成后保留；低频探测兼顾这种页面，避免密集请求。
        if (challengeVisible && performance.now() < probeAfter) continue;
        probeAfter = performance.now() + 5_000;
        try {
          result = await within(() => read(timeout()));
        } catch (error) {
          if (!isNavigationTransition(error)) throw error;
          await delay(Math.min(50, remaining()), undefined, {
            signal: this.signal,
          });
          continue;
        }
        this.signal.throwIfAborted();
        if (valid(result)) {
          this.summary.successes += 1;
          return result;
        }
        // 验证结束后的权限、登录或格式错误交回原读取分类，不继续点击。
        if (!blocked(result)) return result;
      }
      this.failureMessage = "自动恢复的单轮时间预算已耗尽。";
      return result;
    } catch {
      this.signal.throwIfAborted();
      this.failureMessage =
        remaining() === 0
          ? "自动恢复的单轮时间预算已耗尽。"
          : "自动恢复失败，页面操作未完成。";
      return result;
    } finally {
      finished = true;
      this.summary.elapsedMs += Math.ceil(performance.now() - started);
      clearTimeout(expire);
      this.signal.removeEventListener("abort", cancel);
      // goto 超时不会停止底层加载；先停止，再释放协议会话，保留当前页面。
      const session = navigation;
      if (session !== undefined) {
        void (async () => {
          if (navigating)
            await session.send("Page.stopLoading").catch(() => undefined);
          await session.detach().catch(() => undefined);
        })();
      }
    }
  }
}

function isNavigationTransition(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Execution context was destroyed|Unable to retrieve content because the page is navigating|Cannot find context with specified id/u.test(
      error.message,
    )
  );
}

function isCloudflareFrame(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.hostname === "challenges.cloudflare.com"
    );
  } catch {
    return false;
  }
}
