# 任务完成通知

每个异步 `start_flow` 结束后都会在 `.appvanta/tasks/<task-id>/notifications/completion.json` 保存 `task.completed` 事件。事件包含任务 ID、最终业务状态、完成时间和可用的运行目录；通知投递状态与 Flow 业务状态分别记录。

默认只落盘。本地 watcher、CI 或其他 Agent 可以把该文件作为自定义 hook 输入，不需要让 AppVanta 执行任意 shell 命令。

## 可选 Webhook

MCP 服务启动时使用逗号分隔的 origin 白名单：

```powershell
$env:APPVANTA_WEBHOOK_ALLOW_ORIGINS='https://hooks.example.com,http://127.0.0.1:8080'
$env:APPVANTA_WEBHOOK_SIGNING_SECRET='replace-with-at-least-32-random-bytes'
node packages/mcp/dist/index.js
```

随后在 `start_flow` 传入：

```json
{
  "deviceId": "emulator-5554",
  "flow": { "version": 1, "name": "smoke", "steps": [{ "description": "Back", "action": { "kind": "back" } }] },
  "completionWebhook": "https://hooks.example.com/appvanta"
}
```

只有 HTTP(S) 且 origin 与白名单完全一致的 URL 才会接受。URL 禁止 credentials、query 和 fragment，避免把令牌持久化到任务记录。投递使用 JSON POST、单次 10 秒期限并拒绝重定向。事件先以 `delivery: pending` 落盘，再执行最多三次投递；连接错误、408、425、429 和 5xx 使用 250ms、1000ms 的有界退避，其他 4xx 不重试。每次结果都更新 `attempts`，最终通知失败不会把已经通过的 Flow 改成失败。

每个请求包含稳定的 `X-AppVanta-Event-Id`，接收端应以它做幂等去重。设置 `APPVANTA_WEBHOOK_SIGNING_SECRET` 后还会发送 `X-AppVanta-Timestamp` 和 `X-AppVanta-Signature: sha256=<hex>`；签名内容是 `<timestamp>.<原始 JSON body>` 的 HMAC-SHA256。密钥要求 32–4096 UTF-8 字节，只从 MCP 进程环境读取，不写入任务或通知记录。接收端应使用常量时间比较并限制时间戳偏差。

本地完成文件仍是最终审计依据。跨服务持久队列和企业通知适配器留待后续阶段。
