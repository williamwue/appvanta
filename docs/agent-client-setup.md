# Codex、Claude Code 与 Cursor 接入

先在 AppVanta 仓库执行：

```powershell
npm ci
npm run build
node packages/cli/dist/index.js doctor
```

MCP server 使用 stdio，不需要额外的模型 API Key。配置必须使用 AppVanta MCP 入口的绝对路径；`APPVANTA_PROJECT_ROOT` 指向被测 Android 项目，运行记录、任务索引和设备锁都保存在该项目的 `.appvanta` 下。这样 Agent 从其他工作目录启动 server 时也不会把证据写错位置。

## Codex

将 [Codex 示例](../config/examples/codex-config.toml) 合并到用户级 `~/.codex/config.toml`，或受信任项目内的 `.codex/config.toml`。修改两个绝对路径后重启客户端，通过 `/mcp` 检查 `appvanta`。Codex 桌面、CLI 和 IDE 扩展共享该配置。格式依据 [OpenAI MCP 文档](https://developers.openai.com/zh-Hans/docs/extend/mcp)。

## Claude Code

可以复制 [Claude Code 示例](../config/examples/claude-code.mcp.json) 为项目根目录 `.mcp.json`，也可以让 CLI 写入项目配置：

```powershell
claude mcp add appvanta --scope project --env APPVANTA_PROJECT_ROOT=G:/Projects/your-android-project -- node G:/Projects/appvanta/packages/mcp/dist/index.js
claude mcp get appvanta
```

首次使用项目级 server 时按客户端提示确认信任。命令形式和 scope 语义依据 [Anthropic Claude Code MCP 文档](https://docs.anthropic.com/id/docs/claude-code/mcp)。

## Cursor

复制 [Cursor 示例](../config/examples/cursor.mcp.json) 为被测项目的 `.cursor/mcp.json`，重启或刷新 MCP server；可用 `cursor-agent mcp list` 和 `cursor-agent mcp list-tools appvanta` 检查连接。配置位置和 JSON 结构依据 [Cursor MCP 文档](https://docs.cursor.com/context/model-context-protocol)。

## 最小验收

每个客户端分别完成以下调用，并记录客户端版本、配置 scope、工具结果和 AppVanta 运行目录：

1. 调用 `list_devices`，确认工具已加载。
2. 调用 `observe_app`，确认截图和 UI 树路径存在。
3. 调用一个带检查点的 `run_flow`，确认报告与步骤证据完整。
4. 调用 `start_flow`，随后用 `get_task` 查询并用 `cancel_task` 验证清理。

仓库的 stdio 协议自动测试只能证明 server 行为，不等于三款产品内验收。完成上述记录前，覆盖矩阵继续保持 `partial`。
