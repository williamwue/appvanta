# 运行中任务指令

异步 Flow 可以在运行期间接收结构化步骤。MCP `steer_task` 的 `instruction` 使用与 Flow step 相同的 Schema，支持动作、启动应用、HTTP(S) URL、断言、超时和有限恢复。自由文本不会直接进入 Driver，也不会被当作 shell 命令执行。

```json
{
  "taskId": "task-...",
  "instruction": {
    "description": "关闭临时弹窗并确认首页",
    "action": { "kind": "back" },
    "assertText": "首页",
    "timeoutMs": 5000
  }
}
```

指令保存在 `.appvanta/tasks/<task-id>/instructions/`。生命周期为：

- `queued`：已原子写入，等待任务 owner；
- `claimed`：owner 已在步骤边界领取；
- `applied`：动作和检查点通过，或声明的恢复后检查点通过；
- `failed`：动作、检查点或恢复失败。

任务在每个既定步骤之前检查队列，因此不会中断已经开始的 ADB 动作。领取后的步骤进入正常 Flow 证据链，保存操作日志、步骤结果、截图和 UI 树。`list_task_instructions` 可从其他 MCP 进程读取完整状态。

API 37 模拟器在线验收：`node scripts/verify-task-controls.mjs emulator-5554`。证据 `.appvanta/runs/task-controls-1790423029156/verification.json` 覆盖父 MCP 退出、新 MCP 暂停、暂停期间指令保持 queued、恢复后指令 applied 且进入步骤证据，以及取消优先于暂停且不执行排队指令。此前尝试遇到截图和进程查询超时；本次通过不代表长时间稳定性、所有中断位置或真机已验收。

终止、正在取消或已完成的任务拒绝新指令。owner 在领取后异常退出时，记录会停留在 `claimed`，任务查询会显示 `interrupted`；AppVanta 不自动重放这类可能已有副作用的指令。

MCP `pause_task` / `resume_task` 和 CLI 同名命令使用持久化 `pause.request`。暂停请求首先返回 `pausing`；owner 只在下一个步骤边界确认 `paused`，不会截断正在执行的 ADB 动作、检查点或恢复。恢复移除请求，owner 确认后回到 `running`。所有 pause/resume 请求保存在任务的 `controls/` 目录；暂停期间仍可排队结构化指令，恢复后在步骤边界领取。取消优先于暂停。当前仍不支持修改已经执行的步骤。
