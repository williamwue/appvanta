# MCP stdio 协议行为

当前实现的协议版本为 2024-11-05。客户端发送 initialize（protocolVersion、capabilities、clientInfo），接收服务端版本与 tools 能力后发送 notifications/initialized，再调用工具。请求其他版本时服务端返回自己支持的 2024-11-05，由客户端判断是否继续。重复初始化会被拒绝。

ping 在握手前后均可用。未完成握手的工具请求返回 -32002。tools/list 返回完整列表，不产生分页 cursor；传入 cursor 会被拒绝。

## 错误分类

- -32700：JSON 无法解析。
- -32600：请求结构不合法或重复初始化。
- -32601：未知请求方法。
- -32602：初始化或工具参数不合法、未知工具。
- -32603：协议处理内部错误。
- 合法工具调用中的设备/文件/执行错误：工具结果 isError=true，content 内保存 error 文本。

字符串或安全整数请求 ID 原样返回。MCP 不接受 null 请求 ID。合法通知不返回任何响应，未知通知忽略；把 tools/call 当作通知不会执行设备动作。损坏的 JSON 不会使后续请求处理停止。

Flow 本身检查点失败会返回结构化 status=failed 的运行报告，这与无法执行工具的 isError=true 不同。客户端应同时检查协议 error、工具 isError 和业务结果 status。

## 已验证与边界

本地构建与 27 项测试通过。测试覆盖握手顺序、版本协商、ping、非法 JSON/请求 ID、通知无响应、参数错误和工具执行错误，并以真实 stdio 子进程验证错误后仍能处理下一条请求。

API 37 实测性能工具初始化及调用：`.appvanta/runs/performance-check-1789533901473/verification.json`；持久任务查询/取消及重启后查询：`.appvanta/runs/task-persistence-1789533965261/verification.json`。

协议取消与同步请求并发已实现，见下文。仍未完成：断开连接后的任务清理策略、完整协议兼容性套件，以及 Codex/Claude Code/Cursor 产品内验收。本项不宣称完整 MCP 协议认证。

依据：[MCP 生命周期](https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle)、[工具结果](https://modelcontextprotocol.io/specification/2024-11-05/server/tools)、[JSON-RPC 2.0](https://www.jsonrpc.org/specification)。

## 同步请求取消

发送 `notifications/cancelled`，params 为 `{ "requestId": "原请求ID", "reason": "可选原因" }`。数字与字符串 ID 严格区分；未知、已结束或格式错误的取消通知忽略。初始化不接受取消。在途重复 ID 被拒绝。

同步请求不再阻塞后续消息。ping、取消和其他设备请求可以继续处理；同设备动作仍受设备锁互斥。每个直接工具调用使用自己的 Driver、AbortSignal 和证据目录；run_flow/run_flows 将信号传到执行器和本地 ADB 子进程。

已取消请求在完成清理后不再发送响应。Flow 的最终状态及报告保存在本地。取消是协作式的，已完成的动作不能撤销；文件读取等不支持中断的操作可能先完成，但响应仍抑制。设备远端长驻进程、断线和强杀清理仍需专项处理。

start_flow 返回 taskId 后，请使用 cancel_task 取消后台任务；原 RPC 请求已经结束，取消原请求 ID 不会取消后台任务。协议取消与持久任务取消不是同一接口。

实测：`node scripts/verify-protocol-cancel.mjs emulator-5554`，在代理已启用、同步等待动作已开始后发送 ping 和取消。ping 为 106ms，运行取消、代理原值恢复、设备锁释放和无取消响应均通过：`.appvanta/runs/protocol-cancel-1789534161885/verification.json`。并发改动后持久任务查询/取消复验：`.appvanta/runs/task-persistence-1789534188672/verification.json`。28 项自动测试通过。

取消语义依据：[MCP cancellation](https://modelcontextprotocol.io/specification/2024-11-05/basic/utilities/cancellation)。
