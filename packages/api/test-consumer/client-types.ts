import { createApiClient } from "@binny/api/client";

async function checkPublicBinContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");
  const binId = "rss-main";

  const listed = await client.bins.$get();
  if (listed.status === 200) {
    const entries = (await listed.json()).bins;
    const entry = entries[0];
    if (entry !== undefined) {
      void entry.id;
      void entry.sourceAdapterId;
      void entry.status;
      void entry.execution.status;
      // @ts-expect-error Bin summaries do not inline adapter schemas.
      void entry.sourceAdapter;
    }
  }

  // @ts-expect-error bin 只能由运行器首次心跳自注册。
  void client.bins.$post({ json: { id: binId } });

  const lookup = await client.bins[":binId"].$get({ param: { binId } });
  if (lookup.status === 200) {
    const bin = await lookup.json();
    void bin.sourceAdapterId;
    void bin.execution.status;
    void bin.sourceStateSnapshot.freshness;
    if (bin.execution.status === "online") {
      void bin.execution.environment.kind;
      void bin.execution.environment.browser.power.status;
    }
    // @ts-expect-error 执行器状态使用公开的判别联合。
    void bin.execution.isOnline;
    // @ts-expect-error bin detail does not inline the adapter declaration.
    void bin.sourceAdapter;
    // @ts-expect-error Bin detail does not inline the source-state payload.
    void bin.sourceStateSnapshot.sync;
    // @ts-expect-error bin 标识类型为字符串。
    const invalidBinId: number = bin.id;
    void invalidBinId;
  } else if (lookup.status === 404) {
    void (await lookup.json()).error.path;
  }

  const actionTable = await client.bins[":binId"].actions.$get({
    param: { binId },
    query: {},
  });
  if (actionTable.status === 200) {
    const actions = await actionTable.json();
    const collectAction = actions.actions.collect;
    if (collectAction !== undefined) {
      const description: string = collectAction.description;
      void description;
      // @ts-expect-error The action list does not inline action schemas.
      void collectAction.params;
    }
    // @ts-expect-error Action discovery does not return environment declarations.
    void actions.environment;
    // @ts-expect-error Action discovery does not return bin runtime status.
    void actions.execution;
  } else if (actionTable.status === 400 || actionTable.status === 404) {
    void (await actionTable.json()).error.code;
  }

  const selectedAction = await client.bins[":binId"].actions.$get({
    param: { binId },
    query: { action: "collect" },
  });
  if (selectedAction.status === 200) {
    const selected = await selectedAction.json();
    const collectAction = selected.actions.collect;
    if (
      collectAction !== undefined &&
      "params" in collectAction &&
      "output" in collectAction
    ) {
      void collectAction.params;
      void collectAction.output;
      if ("report" in collectAction) void collectAction.report;
    }
  } else if (selectedAction.status === 400 || selectedAction.status === 404) {
    void (await selectedAction.json()).error.code;
  }

  const configSchema = await client.bins[":binId"]["config-schema"].$get({
    param: { binId },
  });
  if (configSchema.status === 200) {
    const declaration = await configSchema.json();
    const adapterId: string = declaration.sourceAdapterId;
    const schemaType = declaration.configSchema.type;
    void adapterId;
    void schemaType;
  } else if (configSchema.status === 400 || configSchema.status === 404) {
    void (await configSchema.json()).error.code;
  }

  void client.bins[":binId"]["config-schema"].$get({
    // @ts-expect-error Config schema discovery requires the bin identifier.
    param: {},
  });

  void client.bins[":binId"].actions.$get({
    param: { binId },
    // @ts-expect-error 动作发现只接受声明的 action 查询字段。
    query: { action: "collect", invented: true },
  });

  const updated = await client.bins[":binId"].$patch({
    param: { binId },
    json: { config: { site: "https://example.test" } },
  });
  if (updated.status === 200) {
    void (await updated.json()).config.site;
  } else if (updated.status === 400 || updated.status === 409) {
    const failure = await updated.json();
    void failure.error.code;
    // @ts-expect-error 错误响应不包含未声明字段。
    void failure.error.detail;
  }

  void client.bins[":binId"].$patch({
    param: { binId },
    // @ts-expect-error 普通调用者不能替换运行器登记的适配器声明。
    json: { sourceAdapter: {} },
  });
  // @ts-expect-error 未知路由不能被客户端接受。
  void client.unknown.$get();
  // @ts-expect-error 此路由没有 DELETE 方法。
  void client.bins.$delete();
  // @ts-expect-error binId 是必填路径参数。
  void client.bins[":binId"].$get({ param: {} });
}

void checkPublicBinContract;

async function checkPublicManualRunContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");
  const binId = "rss-main";
  const runId = "750e8400-e29b-41d4-a716-446655440000";

  const triggered = await client.bins[":binId"].runs.$post({
    param: { binId },
    json: { action: "collect", params: { limit: 20 } },
  });
  if (triggered.status === 202) {
    const run = await triggered.json();
    const returnedRunId: string = run.runId;
    const status = run.status;
    if (status === "cancelling") void run.cancellationRequestedAt;
    if (status === "cancelled") void run.stopConfirmedAt;
    void returnedRunId;
    void status;
    const output: unknown = run.result?.output;
    void output;
    // @ts-expect-error 动态动作输出不能在通用运行类型中假定具体结构。
    void run.result?.output.availability;
    // @ts-expect-error 触发成功响应不包含错误封装。
    void run.error;
  } else if (
    triggered.status === 400 ||
    triggered.status === 404 ||
    triggered.status === 409
  ) {
    const failure = await triggered.json();
    void failure.error.code;
    // @ts-expect-error 错误响应不包含运行标识。
    void failure.runId;
  }

  const claimed = await client.bins[":binId"].runtime.runs.claim.$post({
    param: { binId },
    json: { runtimeId: "runtime-one" },
  });
  if (claimed.status === 200) {
    const result = await claimed.json();
    if (result.run !== null) {
      const claimedRunId: string = result.run.runId;
      const params: object = result.run.params;
      void claimedRunId;
      void params;
    }
  } else if (
    claimed.status === 400 ||
    claimed.status === 404 ||
    claimed.status === 409
  ) {
    const failure = await claimed.json();
    void failure.error.message;
  }

  void client.bins[":binId"].runtime.runs.claim.$post({
    param: { binId },
    // @ts-expect-error 其他字段合法时，领取请求仍必须提供 runtimeId。
    json: {},
  });
  void client.bins[":binId"].runs.$post({
    param: { binId },
    // @ts-expect-error 动作合法时，params 仍必须为 JSON 对象。
    json: { action: "collect", params: ["invalid"] },
  });
  void client.bins[":binId"].runs.$post({
    // @ts-expect-error 触发运行必须提供 binId 路径参数。
    param: {},
    json: { action: "collect", params: { limit: 20 } },
  });

  const completed = await client.bins[":binId"].runtime.runs[
    ":runId"
  ].complete.$post({
    param: { binId, runId },
    json: {
      runtimeId: "runtime-one",
      completion: {
        status: "completed",
        output: { completedScopes: ["main"] },
      },
    },
  });
  if (completed.status === 200) {
    const run = await completed.json();
    const completedRunId: string = run.runId;
    void completedRunId;
  } else if (
    completed.status === 400 ||
    completed.status === 404 ||
    completed.status === 409
  ) {
    void (await completed.json()).error.code;
  }
}

async function checkPublicManualRunCancellationContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");
  const response = await client.bins[":binId"].runs[":runId"].cancel.$post({
    param: {
      binId: "rss-main",
      runId: "750e8400-e29b-41d4-a716-446655440000",
    },
  });
  if (response.status === 200) {
    const run = await response.json();
    if (run.status === "cancelling") void run.cancellationRequestedAt;
    if (run.status === "cancelled") void run.stopConfirmedAt;
  } else if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 409
  ) {
    const error = await response.json();
    void error.error.code;
    // @ts-expect-error 取消失败响应不能读取运行数据。
    void error.runId;
  }
}

void checkPublicManualRunCancellationContract;

void checkPublicManualRunContract;

async function checkPublicScheduleContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");
  const binId = "rss-main";
  const scheduleId = "650e8400-e29b-41d4-a716-446655440000";
  const createInput = {
    expression: "0 */15 * * * *",
    timeZone: "Europe/London",
    action: "collect",
    params: { feedIds: ["rss-main"] },
  };

  const created = await client.bins[":binId"].schedules.$post({
    param: { binId },
    json: createInput,
  });
  if (created.status === 201) {
    const schedule = await created.json();
    const timezone: string = schedule.timeZone;
    const overlapPolicy: "queue" | "skip" = schedule.overlapPolicy;
    const nextDueAt: string = schedule.nextDueAt;
    void timezone;
    void overlapPolicy;
    void nextDueAt;
    // @ts-expect-error schedule output has no undeclared action alias.
    void schedule.operation;
  } else if (
    created.status === 400 ||
    created.status === 404 ||
    created.status === 409
  ) {
    const error = await created.json();
    void error.error.code;
    // @ts-expect-error schedule errors do not expose a created schedule.
    void error.scheduleId;
  }

  void client.bins[":binId"].schedules.$post({
    param: { binId },
    // @ts-expect-error schedule parameters must be a JSON object.
    json: { ...createInput, params: ["invalid"] },
  });

  void client.bins[":binId"].schedules.$post({
    param: { binId },
    // @ts-expect-error 重叠策略只接受 queue 或 skip。
    json: { ...createInput, overlapPolicy: "parallel" },
  });

  const listedRuns = await client.runs.$get({
    query: {
      binId,
      action: "collect",
      status: "failed",
      createdFrom: "2026-11-01T00:00:00Z",
      createdBefore: "2026-11-05T00:00:00Z",
      limit: "10",
    },
  });
  if (listedRuns.status === 200) {
    const run = (await listedRuns.json()).runs[0];
    void run?.binId;
    // @ts-expect-error summary rows omit saved parameters.
    void run?.params;
  } else if (listedRuns.status === 400) {
    void (await listedRuns.json()).error.code;
  }

  const listedSchedules = await client.schedules.$get({
    query: { binId, action: "collect", enabled: "false", limit: "10" },
  });
  if (listedSchedules.status === 200) {
    const schedule = (await listedSchedules.json()).schedules[0];
    void schedule?.binId;
    // @ts-expect-error summary rows omit saved action parameters.
    void schedule?.params;
  } else if (listedSchedules.status === 400) {
    void (await listedSchedules.json()).error.code;
  }

  const updated = await client.bins[":binId"].schedules[":scheduleId"].$patch({
    param: { binId, scheduleId },
    json: {
      expression: "0 30 2 * * *",
      timeZone: "Europe/London",
      overlapPolicy: "skip",
    },
  });
  if (updated.status === 200) {
    void (await updated.json()).nextDueAt;
  } else if (
    updated.status === 400 ||
    updated.status === 404 ||
    updated.status === 409
  ) {
    void (await updated.json()).error.message;
  }

  const disabled = await client.bins[":binId"].schedules[
    ":scheduleId"
  ].disable.$post({
    param: { binId, scheduleId },
  });
  if (disabled.status === 200) void (await disabled.json()).enabled;
  else if (disabled.status === 404) void (await disabled.json()).error.code;

  const removed = await client.bins[":binId"].schedules[":scheduleId"].$delete({
    param: { binId, scheduleId },
  });
  if (removed.status === 200) void (await removed.json()).scheduleId;
  else if (removed.status === 404) void (await removed.json()).error.code;
}

void checkPublicScheduleContract;

async function checkPublicArchiveContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");

  const batchRead = await client.archives["batch-read"].$post({
    json: {
      references: [
        {
          itemId: "650e8400-e29b-41d4-a716-446655440000",
          binId: "rss-main",
          revisionId: "750e8400-e29b-41d4-a716-446655440000",
          archiveSeq: "12",
        },
      ],
    },
  });
  if (batchRead.status === 200) {
    const result = (await batchRead.json()).results[0];
    if (result?.status === "readable") {
      const bodyText: string | undefined = result.revision.state.body?.text;
      void bodyText;
      void (result.resources[0]?.status satisfies
        | "available"
        | "missing"
        | undefined);
    } else if (result?.status === "unreadable") {
      void (result.reason satisfies
        | "deleted"
        | "not_found"
        | "reference_mismatch");
      // @ts-expect-error An unreadable result has no revision payload.
      void result.revision;
    }
  } else if (
    batchRead.status === 400 ||
    batchRead.status === 413 ||
    batchRead.status === 422 ||
    batchRead.status === 503
  ) {
    const failure = await batchRead.json();
    void (failure.error.code satisfies string);
    void failure.error.path;
  }

  void client.archives["batch-read"].$post({
    json: {
      references: [
        // @ts-expect-error Every exact reference requires its observation archive sequence.
        {
          itemId: "650e8400-e29b-41d4-a716-446655440000",
          binId: "rss-main",
          revisionId: "750e8400-e29b-41d4-a716-446655440000",
        },
      ],
    },
  });

  void client.archives["batch-read"].$post({
    json: {
      references: [
        {
          itemId: "650e8400-e29b-41d4-a716-446655440000",
          binId: "rss-main",
          revisionId: "750e8400-e29b-41d4-a716-446655440000",
          archiveSeq: "12",
        },
      ],
      // @ts-expect-error Request budgets are configured by the service.
      budgetMs: 1,
    },
  });

  const revisionDiffResponse = await client.archives.revisions[
    ":firstRevisionId"
  ].diff[":secondRevisionId"].$get({
    param: {
      firstRevisionId: "650e8400-e29b-41d4-a716-446655440000",
      secondRevisionId: "750e8400-e29b-41d4-a716-446655440000",
    },
  });
  if (revisionDiffResponse.status === 200) {
    const revisionDiff = await revisionDiffResponse.json();
    void (revisionDiff.fields.body.status satisfies "unchanged" | "changed");
    void (revisionDiff.fields.extensions.status satisfies
      | "unchanged"
      | "changed");
    void (revisionDiff.resources.added satisfies readonly string[]);
    void (revisionDiff.hasChanges satisfies boolean);
    // @ts-expect-error hasChanges 不能当作文本输出。
    void (revisionDiff.hasChanges satisfies string);
    // @ts-expect-error 差异响应不暴露任意 JSON Patch 操作。
    void revisionDiff.operations;
  } else if (
    revisionDiffResponse.status === 400 ||
    revisionDiffResponse.status === 404 ||
    revisionDiffResponse.status === 409
  ) {
    const revisionDiffError = await revisionDiffResponse.json();
    void (revisionDiffError.error.code satisfies string);
    // @ts-expect-error 错误代码不是任意类型或数字。
    void (revisionDiffError.error.code satisfies number);
    // @ts-expect-error 归档差异错误不包含成功响应的字段集合。
    void revisionDiffError.fields;
  }

  void client.archives.revisions[":firstRevisionId"].diff[
    ":secondRevisionId"
  ].$get({
    // @ts-expect-error 两个版本标识都是必填路径参数。
    param: { firstRevisionId: "650e8400-e29b-41d4-a716-446655440000" },
  });

  const submission = await client.archives.$post({
    json: {
      requestId: "rss:request-7",
      binId: "rss-main",
      items: [
        {
          sourceKey: { namespace: "rss.example", key: "entry/7" },
          title: "Entry 7",
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {},
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

  const deletion = await client.archives.items[":itemId"].$delete({
    param: { itemId: "650e8400-e29b-41d4-a716-446655440000" },
  });
  if (deletion.status === 200) {
    const deletionResult = await deletion.json();
    void (deletionResult.deletedItemIds satisfies readonly string[]);
    // @ts-expect-error 删除结果中的条目标识为字符串。
    void (deletionResult.deletedItemIds satisfies readonly number[]);
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
    // @ts-expect-error 时间线事件不提供状态哈希字段。
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

  const fixedSearch = await client.archives.search.$post({
    json: {
      bins: ["rss-main", "rss-backup"],
      text: {
        in: "both",
        groups: [["model", "release"], ["GPT"]],
      },
      asOf: "12",
      limit: 20,
    },
  });
  if (fixedSearch.status === 200) {
    const page = await fixedSearch.json();
    void page.snapshot.asOf;
    void page.hasMore;
    const result = page.results[0];
    if (result !== undefined) {
      void result.title;
      void result.sourceKey.namespace;
      void result.observedAt;
      const view = result.matches[0];
      if (view !== undefined) {
        void view.binId;
        void view.revisionId;
        void view.archiveSeq;
        // @ts-expect-error search summaries do not include the complete body.
        void view.body;
      }
      // @ts-expect-error Search results do not expose an implementation query hash.
      void result.queryHash;
    }
  } else if (fixedSearch.status === 400 || fixedSearch.status === 422) {
    void (await fixedSearch.json()).error.path;
  }

  void client.archives.search.$post({
    json: {
      bins: ["rss-main"],
      extensions: {
        sourceAdapterId: "rss-atom",
        filters: { category: { op: "eq", value: "post" } },
      },
    },
  });

  void client.archives.search.$post({
    // @ts-expect-error Extension filters require a non-empty explicit bin scope.
    json: {
      extensions: {
        sourceAdapterId: "rss-atom",
        filters: { category: { op: "eq", value: "post" } },
      },
    },
  });

  const timeWindowSearch = await client.archives.search.$post({
    json: {
      bins: ["rss-main"],
      timeWindow: {
        field: "sourcePublishedAt",
        from: "2026-11-08",
        until: "2026-11-09",
        timeZone: "Asia/Shanghai",
        review: "undetermined",
      },
    },
  });
  if (timeWindowSearch.status === 200) {
    const page = await timeWindowSearch.json();
    void page.timeSummary?.certainItems;
    void page.timeSummary?.undeterminedItems;
    const result = page.results[0];
    if (result !== undefined) {
      void result.timeStatus;
      const timeMatch = result.matches[0]?.timeMatch;
      if (timeMatch?.status === "undetermined") void timeMatch.reason;
    }
  } else if (
    timeWindowSearch.status === 400 ||
    timeWindowSearch.status === 422
  ) {
    void (await timeWindowSearch.json()).error.path;
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
    // @ts-expect-error 关系方向与页大小必须使用声明的查询字符串。
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
            // @ts-expect-error 端点必须为信源键或显式源引用。
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

async function checkPublicServiceDiscoveryContract(): Promise<void> {
  const client = createApiClient("http://127.0.0.1:3000");
  const metadataResponse = await client.meta.$get();
  if (metadataResponse.status === 200) {
    const metadata = await metadataResponse.json();
    const productVersion: string = metadata.product.version;
    const protocolVersion: number = metadata.protocols.httpApi;
    const queryContractPath: string = metadata.contracts.archiveQuery.path;
    const capabilities: readonly string[] = metadata.capabilities;
    void productVersion;
    void protocolVersion;
    void queryContractPath;
    void capabilities;
  }

  const queryContractResponse = await client.meta.query.$get();
  if (queryContractResponse.status === 200) {
    const queryContract = await queryContractResponse.json();
    const version: number = queryContract.version;
    const searchPath: string = queryContract.operations.search.path;
    const searchSchema: Record<string, unknown> =
      queryContract.operations.search.requestSchema;
    void version;
    void searchPath;
    void searchSchema;
  }

  // @ts-expect-error 未声明的服务发现路由不能由正式客户端调用。
  void client.meta.unknown.$get();
}

void checkPublicServiceDiscoveryContract;
