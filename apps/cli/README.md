# Binny CLI

Binny CLI 用于搜索 Binny 服务中已经归档的资料，不会抓取信源网站。需要 Node.js 26.13.0 或更高版本。

## 安装并连接服务

```sh
npm install --global @ykdz/binny
export BINNY_API_URL="http://localhost:3000"
binny service info
```

`BINNY_API_URL` 用于选择服务。命令上的 `--url` 会覆盖环境变量中的地址。

## 结构化输出与文本输出

默认输出结构化 JSON，终端与脚本得到相同的数据形状。命令信封将结果放在 `data` 字段中：

```sh
binny archive search --query '{"text":{"in":"title","groups":[["model"],["release"]]}}'
```

直接阅读结果时可显式选择 `text`：

```sh
binny archive search --query '{"text":{"in":"title","groups":[["model"],["release"]]}}' --output-format text
```

## 发现服务与查询字段

先查看精简的离线命令目录；需要时再读取某条命令的指定契约部分，或显式读取完整离线契约：

```sh
binny schema
binny schema archive search --part input
binny schema archive search --part output
binny schema archive search --part errors
binny schema archive search --part full
binny schema --part full
```

`binny service info` 会返回服务能力和公开契约链接。要使用信源专属筛选，先从搜索分布中选一个 bin，再查看该 bin 所用适配器声明的字段：

```sh
BIN_ID="替换为分布中的 bin 标识"
binny bin extension-fields "$BIN_ID"
```

发现结果会给出 `sourceAdapterId`、顶层字段、字段类型、已声明的允许值及支持的操作。扩展筛选要求所选 bin 使用同一个适配器。只能使用发现结果中声明的字段、操作和值；不要从归档 JSON 中猜测可用字段。

## 查看完整分布

搜索可以按 bin 分组返回完整匹配集合，而不返回候选条目：

```sh
binny archive search --query '{"includeCandidates":false,"distribution":{"by":"bin","limit":100}}' > bins.json
jq '.data.distribution' bins.json
```

响应包含 `data.snapshot.asOf`、`data.distribution.totalItems` 和当前页的 `groups`。`totalItems` 统计不同条目的数量。每个分组按匹配该 bin 的条目计数；同一条目可能出现在多个 bin 分组中，因此分组计数之和可能大于 `totalItems`。如果 `data.distribution.hasMore` 为 `true`，继续使用 `data.distribution.nextCursor`，并保持筛选条件和快照不变。分布游标与候选游标相互独立，分页大小也相互独立。

从 `data.distribution.groups` 中选一个 bin，并用 `binny bin extension-fields <bin-id>` 发现字段。如果分布结果保存在 `bins.json`，可复制它的快照：

```sh
AS_OF="$(jq -r '.data.snapshot.asOf' bins.json)"
```

## 筛选并保存候选搜索

下面的请求使用已声明的 `section` 字段、字面标题关键词组和本地日期时间窗口。示例假定所选适配器声明了 `section` 并允许 `model-news`；请将 bin、适配器、字段、值、关键词、日期及时区替换为服务实际声明和需要的范围。`from` 日期包含在窗口内，`until` 日期不包含在窗口内；两者都是 `timeZone` 中的本地午夜。

```sh
cat > search.json <<JSON
{
  "bins": ["$BIN_ID"],
  "extensions": {
    "sourceAdapterId": "替换为发现结果中的 sourceAdapterId",
    "filters": {
      "section": {"op": "eq", "value": "model-news"}
    }
  },
  "text": {"in": "title", "groups": [["Beijing"], ["window"]]},
  "timeWindow": {
    "field": "sourcePublishedAt",
    "from": "2026-11-08",
    "until": "2026-11-09",
    "timeZone": "Asia/Shanghai"
  },
  "asOf": "$AS_OF",
  "limit": 1
}
JSON
binny archive search --query-file ./search.json > first-page.json
```

文本匹配不区分大小写，并按字面内容匹配。一个组内的值采用 OR，多个组之间采用 AND；其他筛选条件也以 AND 组合。只能使用所选适配器实际声明的字段和操作。

默认情况下，时间窗口只返回来源时间确定落在窗口内的视图。`timeSummary` 会分别报告确定和无法判定的条目数量。若要检查时间、精度或时区不足以判断的视图，可在 `timeWindow` 中加入 `"review":"undetermined"` 重做搜索；这些视图不计入确定命中。

同一请求也可以通过内联 JSON 或标准输入提交：

```sh
binny archive search --query '{"text":{"in":"title","groups":[["model"],["release"]]}}'
binny archive search --query-stdin < ./search.json
```

输入来源必须且只能选择一个：`--query`、`--query-file` 或 `--query-stdin`。

## 在同一快照中继续分页

第一页返回 `data.snapshot.asOf`、`data.hasMore`，以及存在后续候选页时的 `data.nextCursor`。后续请求保持筛选条件不变，并同时传递快照和游标；可以调整每页条数：

```sh
jq \
  --arg asOf "$(jq -r '.data.snapshot.asOf' first-page.json)" \
  --arg cursor "$(jq -r '.data.nextCursor' first-page.json)" \
  '. + {asOf: $asOf, cursor: $cursor, limit: 10}' \
  search.json > next-page.json
binny archive search --query-file ./next-page.json > next-page-results.json
```

游标与查询和快照绑定，不与页大小绑定。续读时不要更改筛选条件。分布使用自己的 `distribution.cursor`，不会推进候选分页。

`data.results` 中的每个候选是一个不同的 `itemId`。候选的 `matches` 保留命中的 bin 视图及其精确内容版本。同一条目若出现在多个 bin 中，请选择要读取的那条 match。

## 读取选中的内容版本

从一个搜索结果及其某条 match 组成引用：`itemId` 取自结果，`binId`、`revisionId` 和 `archiveSeq` 取自该 match：

```sh
jq -c \
  '[.data.results[0] as $item | $item.matches[0] | {
    itemId: $item.itemId,
    binId: .binId,
    revisionId: .revisionId,
    archiveSeq: .archiveSeq
  }]' first-page.json > references.json
binny archive batch-read --references "$(cat references.json)" > selected.json
jq '.data.results[] | {status, revision: .revision.revisionId, body: .revision.state.body, resources}' selected.json
```

批量读取会解析引用指定的精确版本，不会改读最新版本。每条输入引用都会得到一条结果；不可读取时也会返回明确状态。存储的正文表示会完整返回；缺失媒体会按资源报告，不影响仍可读取的正文。每次请求接受 1–50 条引用，完整响应上限为 16 MiB；较大的读取应拆成多次请求。
