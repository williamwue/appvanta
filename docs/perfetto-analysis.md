# Perfetto trace 分析

使用官方 Python Trace Processor 分析已经保存的 Android trace，不需要连接设备。AppVanta 仓库不包含第三方 Trace Processor 二进制。

## 安装与调用

```powershell
python -m venv .appvanta/perfetto-venv
.appvanta/perfetto-venv/Scripts/python.exe -m pip install -r scripts/perfetto-requirements.txt
node packages/cli/dist/index.js analyze-perfetto <trace路径> <应用包名> .appvanta/perfetto-venv/Scripts/python.exe 20000
```

CLI 最后两个参数为可选的 Python 路径和分析窗口毫秒数；省略 Python 时使用 `APPVANTA_PERFETTO_PYTHON` 或 PATH 中的 `python`。MCP 工具 `analyze_perfetto` 接受 `trace`、`packageName`、可选 `python`、`scenario`、`windowMs`。

官方 SDK 首次运行可能下载 Trace Processor。离线环境可直接调用 Python 脚本，通过 `--processor <可执行文件>` 指定已有工具。`--scenario` 可标记实验场景，但不会自动创建受控工作负载。

工具解析/下载现放入独立受管进程，继续使用官方固定版本及 SHA-256 校验。Windows 必须先取得 Job Object 所有权，POSIX 使用独立进程组；完成握手后才允许开始解析。取消终止整个解析进程树（包括官方下载器启动的 curl），并在 `initialization.json` 记录 PID、退出状态与取消状态。可能遗留的官方随机 `.tmp` 下载文件不是可用缓存，不自动删除其他进程的缓存或临时文件。处理器启动服务器期间、宿主硬终止和所有系统的完整取消闭环仍待验证。

Windows `perfetto-initialization-1790738166778` 通过官方 downloader + 本地停滞 HTTP 夹具：取消后解析 PID 和实际 curl PID 均退出、没有完成的缓存二进制。该证据使用注入的下载地址，不是公网断网验收。`perfetto-cancellation-1790738167691` 通过正常真实 trace 分析及 SDK/MCP 加载期取消回归；构建、268 项测试和 4 项收尾回归通过。三系统 CI 已加入 `python scripts/verify-perfetto-initialization.py`，托管结果待确认。

同一验收脚本现扩展真实 SDK 路径：从 `analyzePerfetto` 发起分析，在 HTTP 下载已开始时触发 AbortSignal，核对 cancelled、解析进程退出、处理器尚未启动、无成功指标/报告，并独立检查分析 Python、解析进程和 curl PID 已停止。Windows `perfetto-initialization-1790738394038` 通过。输入仅用于经过初始化阶段，不作为可解析 trace 或性能证据；该场景尚未验证 MCP 下载期取消。较早的 Linux CI `36663758987` 已通过直接解析器下载取消，归档 `perfetto-initialization-1790738376530` 已核验，早期快照不包含本次 SDK 扩展。

官方接口说明：[Python API](https://perfetto.dev/docs/analysis/trace-processor-python)、[Trace Processor CLI](https://perfetto.dev/docs/reference/trace-processor-cli)。

## 指标与证据

每次分析使用独立目录，保存 `analysis.json`、`metrics.json`、`report.md`。分析记录包含源 trace 路径及 SHA-256、实际 SQL、工具版本、窗口、进程与线程明细。失败保留分析错误，不生成成功指标。

- `cpu.scheduledTime`：应用及以 `包名:` 开头的子进程在窗口内获得 CPU 调度的累计纳秒数。
- `cpu.singleCoreEquivalent`：累计调度时间除以窗口时间的百分比。多核并行时可以超过 100%。

窗口从 trace 起点开始；省略窗口时使用 trace 时长向下取整到毫秒。调度片段截断到窗口边界。缺少应用、调度数据、Android fingerprint，或发现解析错误、数据丢失时拒绝生成指标。

指标采用性能测量版本 2，可交给 `baseline` 命令。设备身份取 fingerprint 中的 product 字段，不能与 meminfo 采集的型号字段直接视为相同；采集器名称和版本也必须匹配。阈值应来自独立定义的受控实验，验证脚本中等于当前值的阈值仅用于测试门禁行为。

## 当前验证与边界

MCP 下载期取消：Windows `perfetto-initialization-1790739074311` 同时通过 SDK 与真实 MCP stdio 客户端。收到 `notifications/cancelled` 后，分析 Python、解析器和 curl 均停止，处理器未启动、无成功指标/报告；MCP 抑制被取消请求的响应，并继续处理 `tools/list`。客户端验证现独立于 Python HTTP 夹具，三系统 CI 自动运行 SDK/MCP 两种客户端。首次重构验证误将 `.cancel` 文件计作分析目录，修正为只检查目录后通过；它不是产品取消失败。此 MCP 场景仍待 Linux/macOS 托管结果，不替代服务器启动期间或硬终止验收。

SDK 下载期取消的三系统验收现已完成：CI `36664032094` 主机任务全部通过，每个平台各 26 个文件大小/SHA-256 核验通过。Windows `perfetto-initialization-1790738770620`、Linux `1790738602011`、macOS `1790738593691` 均从 SDK 发起真实分析，在官方 downloader 访问本地停滞 HTTP 夹具后触发 AbortSignal；确认分析 Python、解析器、curl 停止，分析 cancelled，处理器未启动且无成功指标/报告。归档位于 `.appvanta/ci-36664032094-{windows,ubuntu,macos}`。该证据覆盖 SDK 下载阶段，未覆盖 MCP 下载期、处理器服务器启动期或公网断网，整项 Perfetto 验收仍未完成。

下载取消跨系统证据：CI `36663758987` 的 Windows/Linux/macOS 三个主机任务通过，每个平台各 21 个归档文件已校验大小及 SHA-256。Windows `perfetto-initialization-1790738492512`、Linux `1790738376530`、macOS `1790738371982` 均验证官方 downloader 在本地 HTTP 停滞后取消，解析器及 curl 停止、无已完成缓存。该快照不包含后续 SDK 下载期取消扩展，不能据此扩大为全部初始化阶段或公网断网验收。

托管证据补充：公开 `6f08fd5` 的 CI `36661266279` 四项任务全部通过，设备归档 `.appvanta/ci-36661266279/.appvanta/ci-evidence` 的 3342 个文件已逐一核验大小和 SHA-256。Linux `perfetto-cancellation-1790737583825` 验证真实处理器加载期间 SDK、MCP、CLI 取消，观测耗时分别为 21/54/50 ms；CLI 使用真实 SIGINT、退出码 1，三者均确认 Python/处理器退出、无成功指标及报告，MCP 后续仍可列工具。该快照不含后续收尾竞态修正，不能替代其托管验证。Windows 控制台信号、macOS 和初始化/下载阶段仍待验收。

同一归档的 API 35 `perfetto-sampling-1790737522524` 完成六条独立 trace，两组 CPU 中位数为 18.432 ms 和 18.086 ms，示例基线比较通过。fingerprint 为 Android 15 / AE3A.240806.043；它不能与 API 37 的测量混用基线，也不证明广泛场景的性能稳定性。

`node scripts/verify-perfetto.mjs <trace> <python>` 验证 CLI/MCP 一致性、源文件哈希、线程汇总、报告、基线通过与失败，以及缺失应用、过长窗口和损坏文件的拒绝路径。

当前实测：API 37 模拟器保留的 22 秒 trace，分析前 20 秒，证据目录 `.appvanta/runs/perfetto-check-1789534742437/verification.json`。

采集协作取消后的远端进程回收已实测，见 [采集回收](capture-lifecycle.md)。

Flow 自动启动和结束采集已接入，成功、失败和取消路径均保存产物。

尚未完成：广泛场景的可重复基线、帧卡顿分析、分析启动/下载阶段取消、跨系统取消及完整设备断连验收。采集宿主强杀与 TCP 拉取中断恢复已有有限验收，见 network-capture.md。指标不表示墙钟耗时或频率加权工作量。

## 分析取消

SDK `analyzePerfetto` 接受 `signal`；CLI 的中断控制器和 MCP `notifications/cancelled` 接入同一路径。调用前已取消时不启动 Python。运行中向该次分析的唯一取消文件写入请求，Python 监视请求并通过 Perfetto 的关闭接口回收自身创建的处理器；关闭与正常退出串行化。源 trace 保留，取消分析删除本次输出目录中的指标和报告，`analysis.json` 保存 `cancelled`、处理器 PID 与退出证据。无法确认回收时记录 `cancellation-unverified`；SDK 错误仅表示请求取消，最终状态以记录为准。

Python 的协作期限为 110 秒，宿主执行期限为 120 秒。取消不会立刻强杀 Python；处理器尚未初始化时需等待初始化返回或期限结束。首次工具下载、初始化挂起、宿主硬终止及 Windows 控制台真实 Ctrl+C 仍需专项验收，不能把已运行处理器的回收证据扩大到这些窗口。调用方请求已完成后才送达的取消，也不改写已有正常完成结果。

Windows 真实验证 `perfetto-cancellation-1790736192243/verification.json` 通过正常分析、预先取消，以及 SDK/MCP 在真实 Trace Processor 加载期间取消：取消前 Python 和处理器均存活，取消后两者均退出、无成功指标/报告，MCP 仍可列工具。使用重复 trace 包构造的较大输入仅用于延长真实解析窗口，不用于性能结论。早期验收脚本曾错误等待被取消 MCP 请求的响应；协议会抑制该响应，产品取消记录与退出证明保留在 `perfetto-cancellation-1790735857573`。修正后的首轮 `1790736038055` 和最终轮均通过。

复验：`node scripts/verify-perfetto-cancellation.mjs <受控夹具trace> <perfetto-python>`。Linux CI 另验证 CLI 的真实 SIGINT；Windows 跳过这项并明确记录 `cliSignalVerified: false`。构建、268 项测试及四包干净安装/重装/卸载检查通过，最新 Python 清理确认分支已复验；跨版本迁移不在本次重装检查范围内。

## 固定工作量多次采样

取消收尾竞态修正：收尾现在在处理器关闭后同步读取取消文件和期限，避免轮询线程尚未读取请求就把 `requested` 记录为 false。确定性回归在旧实现有两个失败用例，修正后四项通过，包含关闭期间取消和正常收尾。真实 trace/Trace Processor 的收尾注入 `perfetto-finalization-cancel-1790737634110` 先确认指标和报告已生成，再写入取消文件；最终 cancelled、两份成功产物移除、处理器退出且清理无错误。该注入验证收尾边界，不代表真实用户信号时序。Windows SDK/MCP 真实加载期取消复验 `perfetto-cancellation-1790737653266` 通过，构建及源码策略检查通过。

`performance-probe` 是本仓库独立编写的测试应用。每个请求在持久工作线程执行 500 万次固定种子的 xorshift32，并保存校验和、PID/TID、设备 elapsed-realtime 时间和线程 CPU 时间。主机独立计算校验和；原生回执与 trace 必须都包含同一工作线程。APK SHA-256 纳入场景身份，改变构建不会被误作同一基线。

```text
python scripts/build-segment-clock.py --fixture performance-probe
node scripts/verify-perfetto-sampling.mjs emulator-5554 <perfetto-python>
```

每组先重启测试应用、执行两次预热，再记录三个独立 8 秒 trace。分析窗口固定 6 秒，设备 trace_marker 开始/结束标记须完整包含在窗口内。两组分别取中位数，第一组加 25% 作为示例阈值，第二组独立比较；每次原始采样、SQL、线程明细、工作负载回执和摘要均保留。该阈值仅演示基线协议，不是通用性能要求；不因比较失败而自动放宽。

API 37 证据 `perfetto-sampling-1790735058035/verification.json`：6 条 trace 的采集与一致性检查通过，应用调度 CPU 中位数分别为 13.052 ms 和 17.475 ms，第二组超过示例阈值 16.315 ms，`comparison.passed=false`。当前证明固定协议可以重复执行，并保留实际波动，不能声称基线已经稳定。测量包括窗口内应用调度与渲染开销，未隔离频率、温度和宿主争用。

第一次夹具尝试未处理 `adb exec-out` 返回的缺失文件文本，第二次的短命线程未出现在调度明细；失败证据分别保留在 `perfetto-sampling-1790734927418`、`perfetto-sampling-1790734954565`。修正为显式文件存在检查、持久线程及设备时钟标记后通过采样验收。失败尝试的具名回执已归档并从测试应用删除，设备租约已释放。API 35 CI 已加入该协议，托管结果待核验。

## 采样传输诊断

托管运行 `36659987371` 的三系统任务通过，但 API 35 在第一条采样 trace 的 `adb pull` 返回 1，stdout/stderr 均为空，采样未完成，不能归因为基线比较失败。设备端产物按现有规则保留。采样验证现保存 `adb-transport.json`，包含有界 `track-devices -l` 事件、开始/结束的 boot ID、adbd PID 及结束日志，以定位连接变化；不自动重试失败采样或放宽比较条件。

API 37 的独立设备端重连验证 `adb-transport-observer-1790736748972` 已确认 transport ID 从 1 变为 2，同时 boot ID 和 adbd PID 保持不变，观测进程退出且租约释放。这证明连接身份变化本身不等于设备或 adbd 重启，尚不能解释托管拉取失败，也不代表 USB 或 OEM 验收。

接入观测后的 API 37 复验 `perfetto-sampling-1790737088705` 完成 6 条 trace，两组 CPU 中位数为 13.661 ms 和 13.674 ms，本轮比较通过；tracker 已退出，事件无丢弃。它与早先比较失败的运行共同保留，不能用单轮通过替代稳定性验收。

## Flow 步骤的设备时间关联

分析器自动读取 trace 同目录的 `step-markers.json`，用唯一运行 token 查找 counter 事件，并严格核对开始/结束配对。缺少、重复、错序或不匹配会失败，不会输出指标。没有 sidecar 的独立 trace 不声称具备步骤关联。

`analysis.json` 的 `steps` 保存每步起止纳秒、区间时长和应用调度 CPU 纳秒，Markdown 同时输出步骤表。步骤使用完整 trace 内的标记区间，不受整体 `windowMs` 截断；包含观察、检查、恢复、ADB 与记录开销，不能当作应用独立响应时间或受控基线。电脑时间只用于辅助记录，不用于对齐。

官方 counter 查询方式见 [Perfetto 查询示例](https://perfetto.dev/docs/getting-started/in-app-tracing)。AppVanta 使用设备 trace_marker 写入标记；不同设备权限尚待验收。

真实成功/失败/取消关联和缺失/错序/错运行拒绝验证：`.appvanta/runs/trace-steps-check-1789535489098/verification.json`。复验命令：

```powershell
node scripts/verify-trace-steps.mjs <Flow采集验证JSON> .appvanta/perfetto-venv/Scripts/python.exe
```
