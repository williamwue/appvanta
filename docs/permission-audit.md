# 权限与 AppOps 审计

Flow 中的运行时权限和 AppOps 夹具将逐项准备、恢复及失败写入运行目录的 `audit.jsonl`。CLI `grant-permission` 和 MCP `set_permission` 是持久修改入口，它们写入项目级 `.appvanta/audit.jsonl`，并在同一设备锁内执行以下顺序：

1. 写入 `started` 事件及调用入口进程标识。
2. 读取修改前的包级 AppOps 状态。
3. 应用明确的 `allow` 或 `deny`。
4. 重新读取并验证目标状态。
5. 写入带 `before` / `after` 的 `passed`，或带原值和错误的 `failed`。

审计 actor 是本地进程入口（`appvanta-cli:<pid>`、`appvanta-mcp:<pid>` 或 Flow 进程），不是经过身份认证的个人用户。项目级日志采用追加 JSONL，不是防篡改审计存储。企业身份、签名、集中收集、保留策略和访问控制属于后续私有化阶段。

当前 `set_permission` / `grant-permission` 修改的是 Android AppOps 模式。Flow 的 `permissions` 字段才使用 `pm grant/revoke` 管理指定 Android 用户的运行时权限；两类状态不能混为一谈。
