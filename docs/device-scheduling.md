# 设备互斥与完整 Flow 批量执行

CLI：

```text
node packages/cli/dist/index.js run-flows emulator-5554,emulator-5556 flow.json 2
```

MCP 同步调用使用 `run_flows`，参数为 `deviceIds` 字符串数组、`flow` 对象及可选 `concurrency`。异步调用使用 `start_flows`，并通过 `get_batch`、`list_batches`、`cancel_batch` 管理。CLI 可用 `batches`、`batch <id>`、`cancel-batch <id>` 跨进程读取或请求取消。

每台设备执行完整 Flow，包括动作、检查点、失败后观察与独立运行报告。默认并发为 2，可设 1–32。设备列表必须非空且不重复。离线设备、设备忙或某设备断言失败都不会丢失其他设备的结果。CLI 只在所有设备通过时返回 0；失败或取消返回非零。

批次在 `.appvanta/runs/batch-<id>/` 保存 `flow.json`、`summary.json`、`report.md`、`devices/<index>.json`。各成功启动的 Flow 有自己的运行目录；无法启动的设备将错误保存在批次结果中。CLI `run-many` 保留旧包名参数，内部使用同一批量执行器进行启动与进程存在检查。

异步索引保存在 `.appvanta/batches/batch-task-<uuid>/batch.json`，记录设备集合、Flow、并发、owner、最终汇总目录和结果。MCP 先启动独立本地 Worker，再原子转移批次所有权；只有与 owner 完全匹配的 `worker.ready.json` 可见后 `start_flows` 才返回。取消请求持久化后会中断正在执行的 ADB 命令、停止派发待运行设备，并等待各 Flow 清理。MCP 退出不终止 Worker；Worker 自身退出时查询显示 `interrupted`，已生成的每设备运行证据继续保留，系统不会自动重放可能已有副作用的 Flow。

## 互斥边界

本地 CLI/MCP 的设备操作和 Flow 使用用户目录下 `.appvanta/device-locks/` 的独占文件。不同进程、不同工作目录操作同一 serial 时，后来的调用返回 `Device busy`；不同设备可以并行。Flow 持有锁直至网络清理及报告结束。相同操作中的嵌套调用可以复用锁。

锁包含设备、PID、主机、随机所有者标记和开始时间，正常结束或异常退出执行路径会释放。强制杀死进程可能留下锁；不会凭超时抢占，以免在未恢复的设备或代理状态上继续操作。崩溃后的检查和恢复命令仍待实现。

测试可用 `APPVANTA_LOCK_DIRECTORY` 指定隔离目录；参与互斥的进程必须使用相同目录。直接使用 ADB、独立 Python 抓包脚本或直接调用低层 Driver 不受 CLI/MCP 锁控制，库调用者可用 core 的 `withDeviceLock` 包装自己的完整操作。

## 当前限制

- 网络批次目前要求并发为 1，代理端口自动分配及每设备连接路由待完成。
- CLI 同步批次接收 SIGINT/SIGTERM；MCP 异步批次由独立本地 Worker 执行并支持持久取消、查询和历史。Worker 崩溃后的安全续跑、优先级、公平调度和远端 worker 队列待完成。
- 批次结果在任务结束时汇总；owner 强制终止时只标记 interrupted，不推断未完成设备状态。
- 报告链接指向兄弟 Flow 目录，单独复制批次目录不能代替完整可移植导出。

验证：`npm test` 覆盖并发上限、返回失败、异常隔离、待派发取消、重复设备拒绝、同进程/跨进程互斥、嵌套操作和失败释放。真实设备验收脚本为：

```text
node scripts/verify-scheduler.mjs emulator-5554 emulator-5556
```

该脚本运行两步骤 Settings Flow，再加入不存在的设备验证混合结果；还检查 CLI/MCP 直接操作无法越过另一个进程持有的设备锁。

2026-09-16 实测通过：`scheduler-check-1789529856398/verification.json`，设备 `emulator-5554` / `emulator-5556`。CLI 全通过、CLI 混合失败和 MCP 批次均完成，返回码与汇总状态一致。网络取消回归：`flow-integration-1789529885365/verification.json`，代理恢复通过。

独立批次 Worker 已在 API 37 模拟器复验：启动 MCP 退出后批次仍为 `passed`，新 MCP 提交持久取消后另一批次保存 `cancelled`，证据为 `.appvanta/runs/worker-restart-check-1790109477881/verification.json`。

实测还发现 Monkey 可选择非 Launcher Activity；Driver 已改为解析 MAIN/LAUNCHER 后显式启动，并检查启动错误，避免把未启动当成成功。

第二台使用本地已有 API 37 镜像新建 `AppVanta_Verification_API37` AVD（`G:/Dev/Android/avd/AppVanta_Verification_API37.avd`），测试后关闭该实例，保留 AVD 供后续 CI 夹具开发。首次 ADB 授权需要处理系统弹窗，不应仅把 adb 设备出现视为已就绪。
