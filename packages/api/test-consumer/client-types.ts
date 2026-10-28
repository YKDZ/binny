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
      relations: [],
    },
  });

  if (submission.status === 201) {
    const commit = await submission.json();
    void commit.archiveSeq;
    void commit.items[0]?.revisionId;
    void commit.relations[0]?.relationId;
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
    query: {},
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

  const historicalItem = await client.archives.items[":itemId"].$get({
    param: { itemId: "650e8400-e29b-41d4-a716-446655440000" },
    query: { binId: "rss-main", asOf: "12" },
  });
  if (historicalItem.status === 200) {
    const snapshotSequence: string = (await historicalItem.json()).snapshot
      .asOf;
    void snapshotSequence;
  }

  const timeline = await client.archives.items[":itemId"].timeline.$get({
    param: { itemId: "650e8400-e29b-41d4-a716-446655440000" },
    query: { binId: "rss-main", limit: "20" },
  });
  if (timeline.status === 200) {
    const page = await timeline.json();
    void page.nextCursor;
    const event = page.events[0];
    if (event?.kind === "item") void event.sourceModifiedAt;
    if (event?.kind === "relation" && event.status === "observed")
      void event.state.cascade;
    // @ts-expect-error Timeline events do not invent state hash fields.
    void event?.stateHash;
  } else if (
    timeline.status === 400 ||
    timeline.status === 404 ||
    timeline.status === 409
  ) {
    void (await timeline.json()).error.path;
  }

  const commitRead = await client.archives.commits[":commitId"].$get({
    param: { commitId: "750e8400-e29b-41d4-a716-446655440000" },
  });
  if (commitRead.status === 200) {
    const commit = await commitRead.json();
    void commit.recordedAt;
    void commit.items[0]?.revisionId;
    void commit.relations[0]?.status;
  } else if (
    commitRead.status === 400 ||
    commitRead.status === 404 ||
    commitRead.status === 409
  ) {
    void (await commitRead.json()).error.code;
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

  const relations = await client.archives.items[":itemId"].relations.$get({
    param: { itemId: "650e8400-e29b-41d4-a716-446655440000" },
    query: { direction: "outgoing", binId: "rss-main", limit: "20" },
  });
  if (relations.status === 200) {
    const page = await relations.json();
    void page.snapshot.asOf;
    const relation = page.relations[0];
    if (relation?.status === "observed") {
      void relation.state.name;
      void relation.observation.recordedAt;
    }
    if (relation?.status === "withdrawn") void relation.observation.commitId;
    if (relation?.status === "unknown") void relation.from.status;
    if (relation !== undefined && relation.status !== "deleted") {
      if (relation.to.kind === "sourceRef") void relation.to.sourceRef;
    }
  } else if (
    relations.status === 400 ||
    relations.status === 404 ||
    relations.status === 409
  ) {
    void (await relations.json()).error.code;
  }

  const relationOnly = await client.archives.$post({
    json: {
      requestId: "rss:relation-only",
      binId: "rss-main",
      items: [],
      relations: [
        {
          relationId: "rss:relation:entry-7-reply-8",
          value: {
            from: { namespace: "rss.example", key: "entry/7" },
            to: { sourceRef: "https://example.test/entry/8" },
            name: "reply",
            properties: { rank: 1 },
            cascade: false,
          },
        },
      ],
    },
  });
  if (relationOnly.status === 201) {
    const commit = await relationOnly.json();
    void commit.items.length;
    const relation = commit.relations[0];
    if (relation?.status === "observed") void relation.state.properties?.rank;
  }

  // @ts-expect-error 未知归档路由不能由正式客户端调用。
  void client.archives.unknown.$get();
  // @ts-expect-error 归档提交只接受正式契约声明的请求字段。
  void client.archives.$post({ json: { requestId: 7 } });
  // @ts-expect-error itemId 是必填路径参数。
  void client.archives.items[":itemId"].$get({ param: {} });
  // @ts-expect-error revision 路由没有 POST 方法。
  void client.archives.revisions[":revisionId"].$post();
  void client.archives.items[":itemId"].$get({
    param: { itemId: "650e8400-e29b-41d4-a716-446655440000" },
    // @ts-expect-error asOf 使用十进制文本，不能由 JavaScript number 传输。
    query: { asOf: 12 },
  });
  void client.archives.items[":itemId"].timeline.$get({
    param: { itemId: "650e8400-e29b-41d4-a716-446655440000" },
    // @ts-expect-error 页大小也是传输查询字符串。
    query: { limit: 20 },
  });
  void client.archives.items[":itemId"].relations.$get({
    param: { itemId: "650e8400-e29b-41d4-a716-446655440000" },
    // @ts-expect-error Relation direction and page size use declared query strings.
    query: { direction: "outgoing", binId: "rss-main", limit: 20 },
  });
  void client.archives.$post({
    json: {
      requestId: "rss:bad-relation-target",
      binId: "rss-main",
      items: [],
      relations: [
        {
          relationId: "rss:bad-relation",
          value: {
            from: { namespace: "rss.example", key: "entry/7" },
            // @ts-expect-error Endpoints must be a source key or explicit source reference.
            to: "entry/8",
            name: "reply",
            cascade: false,
          },
        },
      ],
    },
  });
  // @ts-expect-error commit 路由没有 POST 方法。
  void client.archives.commits[":commitId"].$post();
}

void checkPublicArchiveContract;
