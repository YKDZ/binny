---
"@ykdz/binny": minor
---

新增 `binny service query-contract`，从当前连接的服务按操作和请求/响应部分读取 search、batch-read 的业务契约，并返回服务版本与该服务声明的契约版本。服务不可达、契约无效或所选操作/部分不存在时明确失败，不使用已安装 CLI 的本地声明回退。
