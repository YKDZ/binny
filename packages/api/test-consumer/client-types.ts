import { createApiClient } from "@binny/api/client";

async function checkPublicBinContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");
  const createInput = {
    id: "rss-main",
    collector: {
      id: "rss",
      version: "1.0.0",
      configSchema: { type: "object", properties: {} },
      actions: {
        collect: {
          description: "轮询订阅源",
          params: { type: "object", properties: {} },
        },
      },
      environment: {
        browser: {
          required: false,
          profileReuseAfterRestart: false,
        },
      },
    },
    identityId: "personal-account",
    config: {},
    targets: [{ url: "https://example.test/feed.xml" }],
  };
  const created = await client.bins.$post({
    json: createInput,
  });

  if (created.status === 201) {
    const bin = await created.json();
    void bin.collector.actions.collect?.params.type;
    void bin.execution.status;
    // @ts-expect-error 执行器尚未连接，响应不会伪称在线。
    void bin.execution.isOnline;
    // @ts-expect-error 标识响应字段的类型是字符串。
    const invalidBinId: number = bin.id;
    void invalidBinId;
  } else if (created.status === 400 || created.status === 409) {
    const failure = await created.json();
    void failure.error.code;
    void failure.error.message;
    // @ts-expect-error 错误响应不包含未声明字段。
    void failure.error.detail;
    // @ts-expect-error 错误代码使用字符串字面量，不是数字。
    const invalidErrorCode: number = failure.error.code;
    void invalidErrorCode;
  }

  const lookup = await client.bins[":binId"].$get({
    param: { binId: "rss-main" },
  });
  if (lookup.status === 200) {
    void (await lookup.json()).targets;
  } else if (lookup.status === 404) {
    void (await lookup.json()).error.path;
  }

  // @ts-expect-error 未知路由不能被客户端接受。
  void client.unknown.$get();
  // @ts-expect-error 此路由没有 DELETE 方法。
  void client.bins.$delete();
  // @ts-expect-error binId 是必填路径参数。
  void client.bins[":binId"].$get({ param: {} });
  // @ts-expect-error 请求字段必须符合公开创建契约。
  void client.bins.$post({ json: { id: 42 } });
  // @ts-expect-error 已声明字段类型错误，即使其他字段都合法也不能通过。
  void client.bins.$post({ json: { ...createInput, id: 42 } });
}

void checkPublicBinContract;
