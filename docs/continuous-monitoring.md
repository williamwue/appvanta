# 持续设备监控

MCP `start_monitor` 启动一个有明确期限的后台观察任务，按固定间隔采集 Android 截图和 UI 树。任务记录位于 `.appvanta/monitors/<monitor-id>/`：

```text
monitor.json
observations.jsonl
artifacts/
```

`monitor.json` 保存 owner 进程、设备、间隔、期限、状态和样本数量。MCP 启动独立本地 Worker，原子转移所有权并在匹配的 `worker.ready.json` 可见后返回。`observations.jsonl` 只写相对路径，便于整体移动证据目录。每个样本单独获取跨进程设备锁，采集完成后立即释放，因此监控间隔内其他 Flow 可以使用设备。

## MCP 工具

- `start_monitor(deviceId, intervalMs, durationMs)`：间隔为 500–60000ms，持续时间至少一个间隔，最长一小时；立即返回持久 monitor 记录。
- `get_monitor(monitorId)`：读取状态、样本数量和最后采集时间。
- `list_monitors()`：列出当前项目保存的全部监控记录。
- `release_monitor(monitorId)`：写入跨进程 release 请求，独立 Worker 会中止正在进行的 ADB 采样并保存终态。

CLI 提供 `monitors`、`monitor <id>` 和 `release-monitor <id>`，可从 MCP 服务之外查询或释放任务。

## 状态和边界

状态依次为 `queued`、`running`，最终进入 `completed`、`released` 或 `failed`。显式释放过程中可看到 `releasing`。MCP 服务退出不终止 Worker；Worker 退出且记录尚未终止时，查询结果为 `interrupted`，已经写入的样本继续保留。

监控不会在 Worker 崩溃或宿主重启后自动续跑，也不会自动点击、恢复设备状态或判定业务流程通过。单次采样获取不到设备锁、ADB 失败或设备离线会使本次监控失败并保存原因。需要操作和检查点时应使用 Flow；需要观察一段时间内的界面变化时使用 monitor。

设备实测命令（需要在线 Android 设备）：

```text
node scripts/verify-monitor.mjs emulator-5554
node scripts/verify-independent-workers.mjs emulator-5554
```

API 37 模拟器已验证 MCP 启动进程退出后独立 Worker 完成 4 秒监控并保存 2 个样本，也验证新 MCP 发出 release 后 Worker 保存 `released` 终态：`.appvanta/runs/worker-restart-check-1790109477881/verification.json`。日志/性能指标采样、Worker 自身崩溃续跑和真机仍待完成。
