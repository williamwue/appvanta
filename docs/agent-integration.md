# Agent 接入说明

AppVanta 通过 MCP、CLI 和后续 SDK 接入 AI Agent。Codex、Claude Code、Cursor 等 Agent 使用同一组结构化工具，不需要在 Driver 中配置模型 API Key。

三款客户端的可复制配置与产品内验收步骤见 [Agent 客户端接入](agent-client-setup.md)。

## MCP

构建 MCP 包后启动：

```text
npm run build
node packages/mcp/dist/index.js
```

主要工具：

- `list_devices`
- `install_app`
- `start_app`
- `stop_app`
- `clear_app_data`
- `observe_app`
- `execute_action`
- `run_flow`
- `start_flow`
- `get_task`
- `cancel_task`
- `pause_task`
- `resume_task`
- `steer_task`
- `list_task_instructions`
- `start_monitor`
- `get_monitor`
- `list_monitors`
- `release_monitor`
- `start_flows`
- `get_batch`
- `list_batches`
- `cancel_batch`
- `start_interaction_recording`
- `stop_interaction_recording`
- `collect_logs`
- `diagnose_runtime`
- `generate_report`

## 行为边界

- Agent 先观察，再执行动作；
- 动作必须是结构化 payload；
- 语义定位优先于坐标；
- 关键步骤必须带断言；
- 失败后重新观察，再决定是否恢复；
- 安装、清理数据、卸载和权限修改必须出现在运行记录中；
- Agent 不直接调用任意 shell 命令；
- Driver 不调用模型，也不承担自然语言解释。

## 运行方式

- 短流程使用 `run_flow`；
- 长流程使用 `start_flow`，任务会转交独立本地 Worker，并通过 `get_task` 查询；
- 长流程需要调整时使用 `steer_task` 提交一个结构化步骤，任务会在下一个步骤边界领取；详情见 [运行中任务指令](task-steering.md)。
- 需要停止时使用 `cancel_task`；
- 结果通过截图、UI 树、Logcat 和报告路径追溯。
- 需要定时观察时使用 `start_monitor`，并通过 `release_monitor` 显式结束；详情见 [持续设备监控](continuous-monitoring.md)。
- 异步任务始终写入本地完成事件；显式配置 origin 白名单后可在 `start_flow` 使用 `completionWebhook`，详见 [任务完成通知](task-notifications.md)。

## 统一 Flow（版本 1）

CLI `run-flow`、MCP `run_flow` 和 `start_flow` 共用 core 执行器。MCP 传入 `deviceId` 与 `flow`；`flow` 的格式与 CLI JSON 文件相同：

```json
{
  "deviceId": "emulator-5554",
  "flow": {
    "version": 1,
    "name": "Markor checkpoint",
    "steps": [{
      "description": "Launch Markor",
      "launchPackage": "net.gsantner.markor",
      "assertTarget": {"kind": "resource-id", "value": "net.gsantner.markor:id/nav_quicknote"},
      "timeoutMs": 5000
    }]
  }
}
```

旧版省略 `version` 的 Flow 归一化为版本 1；MCP 旧 `steps` 参数仍支持并自动补充步骤描述。空流程、未知字段、非法动作和不支持的版本会在执行前被拒绝。无包名 `restart-app` 会明确失败；坐标不能作为可见性断言。`ui-path`、重名消歧与匹配模式见 [UI 定位](ui-locators.md)。

每次执行保存规范化 `flow.json`、`device.json`、`plan.md`、`steps.jsonl`、`audit.jsonl`、截图/UI、`run.json` 与 Markdown/JSON 报告。动作失败或断言失败后重新观察；不会自动重放可能产生重复副作用的动作。显式规则的有限恢复现已支持，见 [Flow 恢复](flow-recovery.md)；Flow 实际动作日志与 `record_flow` 回放生成已实现，见 [录制](flow-recording.md)；外部人工 Accessibility 操作可通过独立会话生成 Flow，见 [手动交互录制](manual-interaction-recording.md)。断点恢复仍待实现。

`wait` 支持文本/目标出现与消失、应用进程存在和 UI 树变化，并将等待期限传递给在途 ADB 命令。失败后的重新观察与报告另需时间，详见 [UI 定位与等待](ui-locators.md)。

异步取消先返回 `cancelling`，由独立 Worker 终止在途本地 ADB 命令并等待网络清理；通过 `get_task` 查询最终 `cancelled`。清理失败为 `failed`，不能掩盖为取消成功。已终止任务不会因再次取消而更改结果。MCP stdio 进程退出不会终止 Worker；Worker 自身退出时显示 `interrupted`，不自动重放。详情见 [任务持久化](task-persistence.md)。

网络配置通过 `flow.network` 传入，CLI 与 MCP 共用同一会话，详见 [网络采集](network-capture.md)。同一设备由进程间设备锁互斥，强制杀进程及断线恢复仍待完成。多设备使用 `run_flows`，详见 [调度说明](device-scheduling.md)。

实际验收命令：

```text
node scripts/verify-flow.mjs emulator-5554
node scripts/verify-flow.mjs emulator-5554 --network-cancel-only
```

前者验证 CLI/MCP 同步成功和失败、异步断言与取消；后者验证网络代理启用后的取消和恢复。这里使用本地 stdio 验证客户端，不能替代 Codex、Claude Code、Cursor 三个产品内的接入验收。

工具公开 Schema 与执行前参数校验已统一，未知字段及错误类型会在设备锁前被拒绝；完整 flow 与旧 steps 只能选择一个。详见 [MCP 参数契约](mcp-schemas.md)。
