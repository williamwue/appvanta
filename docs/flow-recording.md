# Flow 执行录制与回放

Flow 执行器为 CLI、MCP 同步/异步及批次运行保存 `actions.jsonl`。每次应用启动、打开 URL、Driver 动作调用之前写入 started，返回后写入 finished 和结果，包含原步骤号、顺序、时间及完整参数。有限恢复操作也进入同一日志。

运行结束时，`run.json` 保存 `actions.jsonl`、`flow.json` 和 `steps.jsonl` 的 SHA-256。它用于检测文件损坏和不完整归档，不是防篡改签名。

```powershell
node packages/cli/dist/index.js run-flow emulator-5554 flow.json
node packages/cli/dist/index.js record-flow .appvanta/runs/<run-id> recorded.json
node packages/cli/dist/index.js run-flow emulator-5554 recorded.json
```

MCP `record_flow` 接受 `{ "runDirectory": "..." }`，返回同一结构化 Flow；再交给 `run_flow` 或 `start_flow` 执行。CLI 拒绝覆盖已有输出文件。

## 录制结果

- 以实际已确认的操作顺序生成步骤，保留语义定位器、匹配方式、输入文本、等待条件等参数。
- 在原步骤操作之后保留原检查点和超时设置；检查点独立成步骤，因此回放步骤数可能增加。
- 实际发生的恢复动作被展开为普通步骤，不复制未执行的恢复规则。这是本次运行路径的回放，不是原计划的所有分支。
- 保留网络会话配置，但路径、CA 和本机依赖仍须在回放环境满足。
- 只接受完整通过的运行，且所有动作必须有成功确认；即使最后检查点恢复成功，存在未确认/失败操作仍拒绝导出。
- 老版本没有动作日志的运行无法推导实际操作，会明确失败；不再生成只有描述的空草稿。

输入文本会原样保存在证据和回放文件中，分享前应检查敏感内容。回放会再次执行操作，包括输入和 URL；数据及应用初始状态需要自行准备。坐标和 UI 路径依赖当时界面，优先使用稳定的资源 ID。

## 覆盖边界

Flow 执行录制仍只覆盖 AppVanta 实际调用。外部人工操作由独立的 Accessibility 录制会话捕获并编译为 Flow，见 [手动交互录制](manual-interaction-recording.md)。它不捕获独立 MCP `execute_action` 会话、系统外部事件或应用内部行为。Accessibility 没有上报的 Canvas/游戏触摸、多点手势和硬件键仍是边界。录制不等于屏幕录像；屏幕录像集成仍为独立任务。

## 验证

`npm test` 覆盖实际操作顺序、参数、恢复路径、检查点回放、截断记录、取消及不确定操作拒绝。`node scripts/verify-recording.mjs emulator-5554` 在 Markor 上验证 CLI 运行、CLI/MCP 录制一致、拒绝覆盖、MCP 回放及证据读取。

本地 API 37 / Markor 已通过：`.appvanta/runs/recording-check-1789532481491/verification.json`。原 3 步生成 6 步回放，MCP 回放全部通过。
