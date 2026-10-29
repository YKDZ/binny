import {
  collectorActionError,
  defineCollector,
  defineCollectorAction,
  defineCollectorCheckAction,
  type CollectorCheckContext,
  type CollectorContext,
} from "@binny/collector-sdk";
import { chromium, type Page } from "playwright-core";
import { z } from "zod";

const configSchema = z.object({ baseUrl: z.url() });
const collectParamsSchema = z.object({
  gateId: z.string().uuid().optional(),
});

async function withSharedPage<T>(
  context: Pick<CollectorContext, "browser">,
  callback: (page: Page) => Promise<T>,
  closePageOnReturn = true,
): Promise<T> {
  const connection = context.browser;
  if (connection === undefined || connection.protocol !== "playwright") {
    throw new Error("浏览器运行器没有提供 Playwright 连接。");
  }
  if (connection.playwrightVersion !== "1.64.1") {
    throw new Error("采集器与浏览器运行器的 Playwright 版本不一致。");
  }

  const connectedBrowser = await chromium.connect(connection.endpoint);
  try {
    const persistentContext = connectedBrowser.contexts()[0];
    if (persistentContext === undefined) {
      throw new Error("共享浏览器没有暴露持久 context。");
    }
    const page = await persistentContext.newPage();
    try {
      return await callback(page);
    } finally {
      if (closePageOnReturn) await page.close({ runBeforeUnload: false });
    }
  } finally {
    await connectedBrowser.close();
  }
}

function baseUrlFrom(context: Pick<CollectorContext, "config">): URL {
  const { baseUrl } = configSchema.parse(context.config);
  return new URL(baseUrl);
}

function isAuthenticated(page: Page): Promise<boolean> {
  return page
    .locator("#protected-content")
    .count()
    .then((count) => count > 0);
}

export const collector = defineCollector({
  id: "binny19.browser-session-fixture",
  version: "1.0.0",
  description: "使用受控登录页验证浏览器人工会话与采集共享。",
  environment: {
    browser: { required: true, profileReuseAfterRestart: true },
  },
  configSchema,
  actions: {
    check: defineCollectorCheckAction({
      description: "检查持久浏览器是否能读取受控保护页面。",
      params: z.object({}),
      async execute(context: CollectorCheckContext) {
        const pageResult = await withSharedPage(context, async (page) => {
          const response = await page.goto(
            new URL("protected", baseUrlFrom(context)).href,
            { waitUntil: "domcontentloaded" },
          );
          return {
            authenticated: await isAuthenticated(page),
            status: response?.status() ?? 0,
          };
        });
        if (pageResult.authenticated) {
          return {
            availability: "available",
            scope: ["受控保护页面"],
            basis: "持久浏览器已读取受控保护页面。",
            problems: [],
          };
        }
        return {
          availability: "unavailable",
          scope: ["受控保护页面"],
          basis: `受控登录页返回 HTTP ${String(pageResult.status)}。`,
          problems: [
            {
              code: "login_required",
              message: "受控站点需要登录。",
              impact: "无法读取受控保护页面。",
              suggestion: "使用 human open 完成登录后重新运行 check。",
              requiresHuman: true,
            },
          ],
        };
      },
    }),
    collect: defineCollectorAction({
      description: "读取受控保护页面并通过正式 SDK 提交归档。",
      params: collectParamsSchema,
      async execute(context: CollectorContext, params) {
        const baseUrl = baseUrlFrom(context);
        const result = await withSharedPage(
          context,
          async (page) => {
            const url = new URL("protected", baseUrl);
            if (params.gateId !== undefined)
              url.searchParams.set("gate", params.gateId);
            const response = await page.goto(url.href, {
              waitUntil: "domcontentloaded",
            });
            if (!(await isAuthenticated(page))) {
              throw collectorActionError({
                code: "login_required",
                message: "受控站点需要重新登录。",
                impact: "本次采集没有读取受控资料。",
                suggestion: "使用 human open 完成登录后启动新的采集运行。",
                requiresHuman: true,
              });
            }
            if (params.gateId !== undefined) {
              await page.waitForFunction(
                () =>
                  (window as Window & { binny19GateReleased?: boolean })
                    .binny19GateReleased === true,
                undefined,
                { timeout: 120_000 },
              );
            }
            return {
              content: await page.locator("#protected-content").innerText(),
              status: response?.status() ?? 0,
              url: page.url(),
            };
          },
          params.gateId === undefined,
        );

        await context.archive.submit({
          items: [
            {
              sourceKey: {
                namespace: "binny19.browser-session-fixture",
                key: `${context.binId}:${context.runId}`,
              },
              body: { text: result.content, searchText: result.content },
              capture: {
                scope: { finalUrl: result.url, status: result.status },
                completeness: "complete",
                missing: [],
              },
            },
          ],
        });
        return { completedScopes: ["受控保护页面"] };
      },
    }),
  },
});

export default collector;
