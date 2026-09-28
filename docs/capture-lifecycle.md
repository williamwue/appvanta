# Android 采集进程回收

`record` / `perfetto` 与对应 MCP 工具使用同一设备端进程管理实现。每次采集有 UUID 输出路径、PID、退出状态及日志文件。启动操作不被调用方的取消信号打断，保证随后可以找到并回收自己创建的进程。

正常结束后检查进程退出码，拉取文件，清除远端文件和控制文件。取消或超时时，不复用已经取消的信号执行清理；先检查 `/proc/<pid>/cmdline` 包含本次唯一输出路径，再依次尝试 SIGINT、SIGTERM、SIGKILL，确认采集进程退出后清理文件。不会按进程名称批量终止其他采集。

本地 `<输出文件>.capture.json` 在启动设备进程前先保存版本 2 恢复记录，绑定设备、UUID 产物、远端路径和控制路径；随后更新运行结果、取消状态、清理是否成功以及独立的清理错误。清理失败会使调用失败，不会报告成功。取消不保证保留部分视频或 trace。

## 验证

```powershell
npm run build
node scripts/verify-capture-cancel.mjs emulator-5554
node scripts/verify-capture.mjs emulator-5554
node scripts/verify-flow-capture.mjs emulator-5554
```

取消验证在确认设备进程实际启动后取消 30 秒采集，检查进程和远端文件消失，以及本地清理记录。API 37 模拟器证据：`.appvanta/runs/capture-cancel-1789534936808/verification.json`。录屏回收约 752ms，Perfetto 约 544ms；这些是单次实测，不是时延保证。

正常验证分别请求 22 秒录屏和 trace，检查采集进程超出旧 20 秒限制后正常完成、产物非空、MP4 完成元数据及远端文件清理。本次正常路径证据：`.appvanta/runs/capture-1789534946193/verification.json`。这些检查不证明视频媒体时长达到 22 秒。

## Flow 分段录屏

API 37 短分段动态验收通过：20 秒操作产生 4 段，每段独立清理并通过完整解码，证据 `.appvanta/runs/segmented-recording-1790429687393/verification.json`。Flow 成功、取消和预算耗尽三个场景通过：`.appvanta/runs/segmented-flow-1790429629050/verification.json`。

190 秒运行未通过：`segmented-recording-1790429282870` 在两段完成后模拟器断线，清单标记 failed；模拟器日志包含 ColorBuffer 错误并退出。重启后遗留第三段已通过 recoverCaptures 显式恢复。取消首次验收的 ADB 查询超时也保留失败证据并完成显式恢复。因此短分段通过不代表超过 180 秒的连续使用已验收，稳定环境长录制、分段空隙测量和真机仍待完成。

Flow `capture.screenSeconds` 接受 1–3600 秒，超过 180 秒时自动分段；可选 `screenSegmentSeconds` 为 5–180 秒且必须同时指定 screenSeconds。例如 `{ "screenSeconds": 600, "screenSegmentSeconds": 120 }`。CLI/MCP Flow 共用此配置，独立 record 工具仍使用单段限制。

每段使用独立 UUID/PID/恢复记录。`captures/screen-segments.json` 原子更新段序号、准备/ready/完成时间及相对文件名，summary 指向这份清单。停止 Flow 会结束当前段并保留已完成段；总录屏预算耗尽但 Flow 尚未结束时采集失败，不标记全程覆盖。Perfetto 仍使用原有单段机制。

分段在上一段完成、拉取和清理后再启动下一段，存在采集空隙，清单明确 `seamless: false`。主机时间记录不能代替视频媒体时长，也不能推断空隙的精确设备时间。长流程验证用 `node scripts/verify-segmented-recording.mjs emulator-5554`，默认持续动态画面 190 秒；生命周期验证用 `node scripts/verify-segmented-flow.mjs emulator-5554`。

## 视频内容验证

动态画面复验：`node scripts/verify-dynamic-recording.mjs emulator-5554` 在设备锁内持续滚动 Settings，22 秒后主动结束采集，检查至少 30 帧、媒体时长不低于 20 秒、帧时间戳有序且最大间隔不超过 2 秒，并完整解码。API 37 结果为 32 次滑动、245 帧、22.391233 秒、最大间隔 0.565089 秒：`.appvanta/runs/dynamic-recording-1790429080866/verification.json`。不证明每次动作的像素对应关系，也不覆盖长录屏分段或真机。

完整解码使用源 `time_base` 与 passthrough 帧率模式，避免可变帧率输入被 null 输出端按平均帧率重新取整而产生重复 DTS。验证器仍拒绝解码错误和截断文件，不通过丢帧或忽略 stderr 消除错误。

`node scripts/verify-video-content.mjs <mp4> [更多mp4]` 使用本机 ffprobe 读取实际帧数、尺寸和媒体时长，再用 ffmpeg 严格完整解码到 null 输出；故意截断的 MP4 必须被拒绝。保存工具版本、源文件 SHA-256、原始媒体元数据与结论。不安装或分发 FFmpeg，可用 APPVANTA_FFPROBE / APPVANTA_FFMPEG 指定本机工具。

`.appvanta/runs/video-content-1790428881068/verification.json` 验证旧正常采集样本和强杀恢复样本均可解码。旧 `capture-1789527995590` 样本实际仅 2 帧、6.674644 秒；恢复样本为 2 帧、1.337733 秒。因此采集进程运行时间不能代替媒体时长或连续画面覆盖。完整解码也不证明画面内容正确；持续变化画面、录制时长覆盖和长录屏分段仍待验收。

强杀恢复 trace 已通过官方 Trace Processor 分析，SystemUI 调度数据窗口 2333ms，解析错误/丢失检查为空：`.appvanta/runs/perfetto-analysis-1790428882943-a7c0ba7f-4d70-4db5-82a5-ec5af6be56c8/analysis.json`。只证明该残留片段可分析，不证明原定 60 秒完整采集或步骤配对。

## Flow 自动采集

Flow 支持以下可选配置，CLI 和 MCP 同步/异步入口共用执行器：

```json
{
  "name": "Inspect Markor",
  "capture": { "screenSeconds": 60, "perfettoSeconds": 60 },
  "steps": [{ "description": "Launch Markor", "launchPackage": "net.gsantner.markor" }]
}
```

两个时长均为采集上限，不是运行后额外等待的时间。录屏允许 1–180 秒，Perfetto 允许 1–60 秒，至少选择一项。采集进程写出 PID 并创建输出文件后才开始 Flow 步骤；这不保证首帧已经编码或所有 Perfetto 数据源已就绪。Flow 结束、失败或取消后发送独立停止信号，等待采集器结束并保存文件。需要强制终止的采集不能作为成功证据。超过采集上限导致提前结束时，Flow 标记失败，避免将部分采集当作完整覆盖。

运行目录 `captures/summary.json` 列出相对产物路径及状态；报告链接到该清单，每个采集另有 `.capture.json` 清理记录。失败或取消的 Flow 也会尝试保存现场。回放文件保留采集配置。采集结束阶段失败不会阻止网络会话清理。

Flow 四路径实测证据：`.appvanta/runs/flow-capture-check-1789535241873/verification.json`。成功、断言/动作失败、取消均保存视频和 trace；采集提前结束使运行失败。

## 步骤关联

启用 Flow Perfetto 时，在每个实际执行步骤前后写入带 UUID 和步骤序号的设备 trace counter，另存 `captures/step-markers.json`。结束标记也覆盖失败、恢复和取消。标记位于观察之前和步骤记录之后，代表整个工具步骤的区间，不是 App 内部函数耗时。

`analyze-perfetto` 自动读取 trace 同目录的标记清单，从 counter 事件取 trace 时间，核对运行标识、数量、顺序和配对后输出步骤区间与应用调度 CPU 时间。没有 sidecar 的旧 trace 仍只输出整体指标；不能推断其步骤。参见 [分析说明](perfetto-analysis.md)。

## 未完成边界

- Flow Perfetto 步骤关联要求 shell 可写 `/sys/kernel/tracing/trace_marker`；当前只在 API 37 模拟器验收，权限不足时运行失败。
- `recover-flow` 核验 UUID 进程后结束采集，先拉取残留产物与日志到 `captures/recovered/`，记录相对路径和字节数，再删除远端文件。拉取失败则保留远端证据与租约，允许显式重试；产物标记 `artifactValidity: unverified`，不声称内容完整。完整记录已清理时幂等跳过，路径替换会被拒绝。
- API 37 Flow 宿主和网络 Worker 强杀、录屏/Perfetto 接管、产物保留、代理恢复与租约释放通过：`.appvanta/runs/network-capture-recovery-1790428729832/verification.json`，命令 `node scripts/verify-network-capture-recovery.mjs emulator-5554`。一次 ADB 查询失败保留租约后重试成功的审计在 `2026-09-26T13-17-35-815Z-emulator-5554-ae718f5b/recovery/`。
- 设备断线时明确记录清理失败；设备重新在线后可人工调用 `recover-flow`，尚无自动重连调度。
- ADB 拉取期间取消会等待当前有界拉取结束后再清理；不保证即时取消传输。
- 真机、其他 Android 版本及长录屏分段尚未验收。
