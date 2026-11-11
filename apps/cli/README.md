# Binny CLI

Binny CLI 用于搜索 Binny 服务中已经归档的资料，不会抓取信源网站。需要 Node.js 26.13.0 或更高的 26.x 版本。

## 安装并连接服务

```sh
npm install --global @ykdz/binny
export BINNY_API_URL="http://localhost:3000"
binny service info
```

`BINNY_API_URL` 用于选择服务。命令上的 `--url` 会覆盖环境变量中的地址，并且只对具体联网命令生效。

## 结构化输出与文本输出

默认输出结构化 JSON，终端与脚本得到相同的数据形状。命令信封使用版本 3，包含 `schemaVersion`、`command`、`outputMode` 和 `kind`，业务结果放在 `data` 字段中：

```sh
binny archive search --query '{"text":{"in":"title","groups":[["model"],["release"]]}}'
```

直接阅读结果时可在叶命令之后显式选择 `text`：

```sh
binny archive search --query '{"text":{"in":"title","groups":[["model"],["release"]]}}' --output text
```

两种方式执行同一业务处理并产生相同业务含义，切换输出不会增加请求次数。

## 原生示例与帮助

`binny archive search --schema` 返回的命令摘要包含原生 `examples`。每个示例同时给出机器可用的 `argv` 和帮助中展示的 POSIX `shell`，两者来自同一份声明：

```sh
binny archive search --schema
binny archive search --help
```

原生示例只承载单次叶命令调用，不包含文件内容、stdin 字节、管道、变量插值或跨调用结果引用。定义期只会验证 CLI 输入合法；查询 JSON 的业务正确性仍由实际服务和正式契约验证，不能把契约构建成功当成查询成功。下面按准备条件和前一步结果完成文件、stdin、分页与精确批量读取。

## 发现服务、命令与查询字段

先查看精简的离线命令目录；需要时按原生 `--schema` 逐层导航，或读取某条命令的指定契约部分：

```sh
binny --schema
binny archive --schema
binny archive search --schema
binny archive search --schema=input
binny archive search --schema=success:structured
binny archive search --schema=failures:structured
binny archive search --schema=wire:structured
```

原生发现直接输出库定义的 JSON 文档；目录只列直接子项，摘要不展开完整业务 schema。需要一份完整离线契约时，显式执行：

```sh
binny contract
```

完整导出直接复用已安装 CLI 的 grammar 与 manifest，包含用法失败等分部发现未覆盖的声明。人读帮助优先使用 `--help`，不需要解析这些 JSON。

`binny service info` 会返回服务能力和公开契约链接。服务信息中的契约地址代表当前连接的服务；本地 `--schema` 和 `binny contract` 始终代表已安装 CLI。

## 从分布取得 bin 和扩展字段

先用一次分布取得当前归档中的 bin 标识，并把结果保存下来：

```sh
binny archive search --query '{"includeCandidates":false,"distribution":{"by":"bin","limit":100}}' > bins.json
BIN_ID="$(jq -r '.data.distribution.groups[0].binId' bins.json)"
```

响应包含 `data.snapshot.asOf`、`data.distribution.totalItems` 和当前页的 `groups`。`totalItems` 统计不同条目的数量。每个分组按匹配该 bin 的条目计数；同一条目可能出现在多个 bin 分组中，因此分组计数之和可能大于 `totalItems`。如果 `data.distribution.hasMore` 为 `true`，继续使用 `data.distribution.nextCursor`，并保持筛选条件和快照不变。分布游标与候选游标相互独立，分页大小也相互独立。

取得 `BIN_ID` 后，读取该 bin 所用适配器声明的字段和值。`SOURCE_ADAPTER_ID` 直接取自这一步的发现结果：

```sh
binny bin extension-fields "$BIN_ID" > fields.json
SOURCE_ADAPTER_ID="$(jq -r '.data.sourceAdapterId' fields.json)"
```

发现结果会给出 `sourceAdapterId`、顶层字段、字段类型、已声明的允许值及支持的操作。扩展筛选要求所选 bin 使用同一个适配器。只能使用发现结果中声明的字段、操作和值；不要从归档 JSON 中猜测可用字段。

## 组合扩展筛选、时间窗口与文件输入

下面的请求使用已声明的 `section` 字段、字面标题关键词组和本地日期时间窗口。示例假定所选适配器声明了 `section` 并允许 `model-news`；请将字段、值、关键词、日期及时区替换为服务实际声明和需要的范围。`from` 日期包含在窗口内，`until` 日期不包含在窗口内；两者都是 `timeZone` 中的本地午夜。

用上一步取得的 bin 和适配器写出一份可复用的搜索文件，并先执行一次扩展筛选：

```sh
jq -n \
  --arg bin "$BIN_ID" \
  --arg adapter "$SOURCE_ADAPTER_ID" \
  '{
    bins: [$bin],
    extensions: {
      sourceAdapterId: $adapter,
      filters: {
        section: {op: "eq", value: "model-news"}
      }
    }
  }' > search.json

binny archive search --query-file ./search.json > extension-results.json

jq \
  --arg asOf "$(jq -r '.data.snapshot.asOf' bins.json)" \
  '. + {
    text: {in: "title", groups: [["Beijing"], ["window"]]},
    timeWindow: {
      field: "sourcePublishedAt",
      from: "2026-11-08",
      until: "2026-11-09",
      timeZone: "Asia/Shanghai"
    },
    asOf: $asOf,
    limit: 1
  }' search.json > window-search.json

binny archive search --query-file ./window-search.json > first-page.json
```

文本匹配不区分大小写，并按字面内容匹配。一个组内的值采用 OR，多个组之间采用 AND；其他筛选条件也以 AND 组合。只能使用所选适配器实际声明的字段和操作。

默认情况下，时间窗口只返回来源时间确定落在窗口内的视图。`timeSummary` 会分别报告确定和无法判定的条目数量。若要检查时间、精度或时区不足以判断的视图，可在 `timeWindow` 中加入 `"review":"undetermined"` 重做搜索；这些视图不计入确定命中。

同一请求也可以通过内联 JSON 或标准输入提交：

```sh
binny archive search --query '{"text":{"in":"title","groups":[["model"],["release"]]}}'
binny archive search --query-stdin < ./window-search.json > stdin-page.json
```

输入来源必须且只能选择一个：`--query`、`--query-file` 或 `--query-stdin`。`--query-file` 和 `--query-stdin` 的示例只说明 CLI 调用；文件内容或 stdin 字节需要按上面的步骤准备。

## 在同一快照中继续分页

第一页返回 `data.snapshot.asOf`、`data.hasMore`，以及存在后续候选页时的 `data.nextCursor`。后续请求保持筛选条件不变，并同时传递快照和游标；可以调整每页条数：

```sh
jq \
  --arg asOf "$(jq -r '.data.snapshot.asOf' first-page.json)" \
  --arg cursor "$(jq -r '.data.nextCursor' first-page.json)" \
  '. + {asOf: $asOf, cursor: $cursor, limit: 10}' \
  window-search.json > next-page.json
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
