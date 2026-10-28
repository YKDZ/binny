// 公开客户端只依赖 API 路由类型和 Hono RPC，不导入 core 或 server。
import { hc } from "hono/client";

import type { ApiRoutes } from "./routes.ts";

export type ApiClientOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() =>
        | Readonly<Record<string, string>>
        | Promise<Readonly<Record<string, string>>>);
};

export function createApiClient(baseUrl: string, options?: ApiClientOptions) {
  return hc<ApiRoutes>(baseUrl, options);
}
