# 更新日志

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
