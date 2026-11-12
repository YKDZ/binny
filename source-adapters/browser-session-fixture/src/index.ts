import {
  sourceAdapterActionError,
  defineSourceAdapter,
  defineSourceAdapterAction,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { chromium, type Page } from "patchright-core";
import { z } from "zod";

const configSchema = z.object({ baseUrl: z.url() });
const extensionsSchema = z.object({}).strict();
const collectParamsSchema = z.object({
  gateId: z.string().uuid().optional(),
});
type BrowserConfig = z.output<typeof configSchema>;
const diagnosticOutputSchema = z.object({
  availability: z.enum(["available", "unavailable", "unknown"]),
  scope: z.array(z.string()),
  basis: z.string(),
  problems: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      impact: z.string(),
      suggestion: z.string(),
      requiresHuman: z.boolean(),
    }),
  ),
});
const collectOutputSchema = z.object({ completedScopes: z.array(z.string()) });

async function withSharedPage<T>(
  context: Pick<SourceAdapterContext, "browser">,
  callback: (page: Page) => Promise<T>,
  closePageOnReturn = true,
): Promise<T> {
  const connection = context.browser;
  if (connection === undefined || connection.protocol !== "playwright") {
    throw new Error("浏览器运行器没有提供 Playwright 连接。");
  }
  if (connection.playwrightVersion !== "1.64.2") {
    throw new Error("信源适配器与浏览器运行器的 Playwright 版本不一致。");
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

function baseUrlFrom(
  context: Pick<SourceAdapterContext<BrowserConfig>, "config">,
): URL {
  return new URL(context.config.baseUrl);
}

function isAuthenticated(page: Page): Promise<boolean> {
  return page
    .locator("#protected-content")
    .count()
    .then((count) => count > 0);
}

export const sourceAdapter = defineSourceAdapter({
  id: "binny-browser.browser-session-fixture",
  version: "1.0.0",
  description: "使用受控登录页验证浏览器人工会话与采集共享。",
  environment: {
    browser: { required: true, profileReuseAfterRestart: true },
  },
  configSchema,
  extensionsSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "检查持久浏览器是否能读取受控保护页面。",
      params: z.object({}),
      output: diagnosticOutputSchema,
      async execute(context) {
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
            availability: "available" as const,
            scope: ["受控保护页面"],
            basis: "持久浏览器已读取受控保护页面。",
            problems: [],
          };
        }
        return {
          availability: "unavailable" as const,
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
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "读取受控保护页面并通过正式 SDK 提交归档。",
      params: collectParamsSchema,
      output: collectOutputSchema,
      async execute(context, params) {
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
              throw sourceAdapterActionError({
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
                  (window as Window & { binnyBrowserGateReleased?: boolean })
                    .binnyBrowserGateReleased === true,
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
                namespace: "binny-browser.browser-session-fixture",
                key: `${context.binId}:${context.runId}`,
              },
              title: null,
              sourcePublishedAt: null,
              sourceModifiedAt: null,
              extensions: {},
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

export default sourceAdapter;
