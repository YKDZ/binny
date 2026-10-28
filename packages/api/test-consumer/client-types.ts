import { createApiClient } from "@binny/api/client";

async function checkPublicBinContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");
  const created = await client.bins.$post({
    json: {
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
    },
  });

  if (created.status === 201) {
    const bin = await created.json();
    void bin.collector.actions.collect?.params.type;
    void bin.execution.status;
    // @ts-expect-error 执行器尚未连接，响应不会伪称在线。
    void bin.execution.isOnline;
  } else if (created.status === 400 || created.status === 409) {
    const failure = await created.json();
    void failure.error.code;
    void failure.error.message;
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
}

void checkPublicBinContract;

async function checkPublicArchiveContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");
  const submission = await client.archives.$post({
    json: {
      requestId: "rss:request-7",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "rss.example", key: "entry/7" },
          body: { text: "正文" },
          capture: {
            scope: { feed: "main" },
            completeness: "complete",
            missing: [],
          },
        },
      ],
    },
  });

  if (submission.status === 201) {
    const commit = await submission.json();
    void commit.archiveSeq;
    void commit.items[0]?.revisionId;
  } else if (
    submission.status === 400 ||
    submission.status === 404 ||
    submission.status === 409
  ) {
    const failure = await submission.json();
    void failure.error.code;
    void failure.error.path;
  }

  const item = await client.archives.items[":itemId"].$get({
    param: { itemId: "650e8400-e29b-41d4-a716-446655440000" },
  });
  if (item.status === 200) {
    void (await item.json()).views[0]?.state.body?.text;
  } else if (
    item.status === 400 ||
    item.status === 404 ||
    item.status === 409
  ) {
    void (await item.json()).error.code;
  }

  const revision = await client.archives.revisions[":revisionId"].$get({
    param: { revisionId: "750e8400-e29b-41d4-a716-446655440000" },
  });
  if (revision.status === 200) {
    void (await revision.json()).state.capture.completeness;
  } else if (
    revision.status === 400 ||
    revision.status === 404 ||
    revision.status === 409
  ) {
    void (await revision.json()).error.message;
  }

  // @ts-expect-error 未知归档路由不能由正式客户端调用。
  void client.archives.unknown.$get();
  // @ts-expect-error 归档提交只接受正式契约声明的请求字段。
  void client.archives.$post({ json: { requestId: 7 } });
  // @ts-expect-error itemId 是必填路径参数。
  void client.archives.items[":itemId"].$get({ param: {} });
  // @ts-expect-error revision 路由没有 POST 方法。
  void client.archives.revisions[":revisionId"].$post();
}

void checkPublicArchiveContract;
