---
"@ykdz/binny": minor
---

将 CLI 迁移至 `@ykdz/cli-contract@0.5.0`。业务命令改用原生具名输出方式，保持 structured 默认并支持叶命令后的 `--output text`，删除 `--output-format` 兼容参数；结构化执行封套升级至版本 3，清单升级至版本 5。离线契约发现改为原生 `--schema` 分层查询，并新增 `binny contract` 显式完整导出。归档资源下载的本地文件选项改为 `--save-to`，避免与输出选择器冲突。最低 Node.js 版本提升至 26.13.0。
