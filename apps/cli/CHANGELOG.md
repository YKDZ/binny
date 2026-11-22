# 更新日志

## 0.4.0

### Minor Changes

- 发布 0.4.0。

  - 公开 HTTP API 协议版本由 10 升至 14，`/meta/query` 归档查询契约版本由 4 升至 7。
  - 人工操作会话迁移至原生 VNC 直连：`human open` 改为流式输出（`delivery: "stream"`），等待期间输出 `waiting` 记录（包含 `runtime_sleeping`、`runtime_waking`、`bin_busy` 等排队原因及 `lastWakeError`），入口就绪后一次输出 `ready` 记录（提取自调用 API 地址的 `host`、Docker 实际映射的 `port` 与 8 位一次性 VNC `password`），移除旧 `viewerUrl` / `viewerPath`；`human get` 与 `human close` 仅返回纯会话状态。
  - 扩展归档搜索摘要展示与按需关联读取：`bin extension-fields` 新增适配器声明的 `summaryFields` 与 `searchRelations`；`archive search` 响应 `matches[]` 新增可选 `summaryExtensions`，请求新增可选 `related`（`{ sourceAdapterId, include }`），在同一次归档快照与命中垃圾桶视图下解析关联版本，逐项返回 `readable` / `unreadable` / `none` 并在顶层 `relatedRevisions` 同页去重共享正文与资源状态；`--output text` 同步展示视图摘要、关联状态与去重关联版本。
  - 全仓业务输出、错误与文本模式统一为中立、可组合的事实：移除 `suggestion` 字段与内嵌命令或操作教程（`service info`、`run list`、`schedule list`、扩展字段诊断及分页游标文本）；`run get` 补充输出 `sessionState` 与已知 `humanSession` 状态；`archive batch-read` 超出引用数或 16 MiB 响应上限时在 `error.diagnostic` 返回 `maxReferences`、`requestedReferences`、`maxResponseBytes`、`references` 及单条确证超限时的 `oversizedRevisionId`。

## 0.3.0

### Minor Changes

- 发布 0.3.0。

  - 公开 HTTP API 协议版本由 5 升至 10，`/meta/query` 归档查询契约版本由 3 升至 4。
  - 统一运行器容器休眠与按需唤醒模型：`bin create` 与 `bin update` 删除 `--browser-idle-timeout-seconds`，改为 `--idle-timeout-seconds`（`runtimeSleep.idleTimeoutSeconds`）；`bin list` 与 `bin get` 输出 `sleeping`、`waking` 状态、`runtimeSleep` 策略及拆分后的浏览器 `power` 状态；`run list`、`run get` 与 `human-session` 相关输出新增 `queueReason`（`runtime_sleeping` / `runtime_waking`）和 `lastWakeError`。
  - 增强运行记录检索与失败诊断：`run list` 新增 `triggerType` 与 `stopReasonCode`；`run get` 在有直接证据时输出失败或取消的 `stage`、`target` 与 `abortCause`。
  - 扩展归档搜索的时间窗口与分布排序：`timeWindow` 支持不带 `timeZone` 的 ISO 8601 偏移精确时刻左闭右开区间；`distribution` 新增 `order: "count" | "key"`，支持按去重条目数降序分页；单条版本超过 `archive batch-read` 的 16 MiB 上限时可回退使用 `archive revision` 完整读取。
  - 元数据与查询契约请求（`/meta`、`/meta/query`）新增瞬态失败指数退避重试，并在错误输出中返回 `reason`、`httpStatus` 与 `attempts`。

## 0.2.0

### Minor Changes

- 发布 0.2.0。

  - 最低 Node.js 版本提升至 26.13.0（26.x）。
  - 将 CLI 迁移至 `@ykdz/cli-contract@0.5.0`：业务命令改用原生具名输出方式，保持 structured 默认并支持叶命令后的 `--output text`；结构化执行封套升级至版本 3，清单升级至版本 5。删除 `--output-format` 及其兼容层。
  - 离线契约发现改为原生 `--schema` 分层查询，并新增 `binny contract` 显式完整导出。
  - 归档资源下载的本地文件选项改为 `--save-to`，避免与输出选择器冲突。
  - 新增 `binny service query-contract`，从当前连接的服务按操作和请求/响应部分读取 search、batch-read 的业务契约，并返回服务版本与该服务声明的契约版本。服务不可达、契约无效或所选操作/部分不存在时明确失败，不使用已安装 CLI 的本地声明回退。
  - 固定搜索与动态扩展筛选的错误可携带结构化 `diagnostic`，按适用情形提供 `allowedValues`、`allowedItemValues`、`allowedOperations`、`protocolOperations` 与 `discovery`；固定搜索在内联 JSON、文件、stdin 与直接 HTTP 中保持相同诊断语义，动态扩展筛选以服务端当次声明校验为准，text 错误显示路径与可用候选。由于错误响应新增可选字段会破坏旧版严格错误解析，公开 HTTP API 协议版本由 4 升至 5；`/meta/query` 的归档查询契约版本保持 3。

## 0.1.0

Binny 命令行首个公开版本，支持连接远程服务执行归档查询、条目与版本检视及垃圾桶运行管理。

- 提供 `service`、`schema`、`archive` 与 `bin` 命令族，覆盖离线命令契约自省、归档全文检索与统计聚合、条目时间线与版本差异比对、垃圾桶配置与运行管理。
- 内联打包公开 HTTP API 客户端与契约校验，仅保留最小运行时外部依赖。
