# Perfetto trace 分析

使用官方 Python Trace Processor 分析已经保存的 Android trace，不需要连接设备。AppVanta 仓库不包含第三方 Trace Processor 二进制。

## 安装与调用

宿主强杀失败与修正：公开 `0b29c0a` 的 CI `36670461231` 在 Linux owner-kill 验收失败，3440 个设备归档文件已完整性核验。`perfetto-cancellation-1790744925907/owner-death-observation.json` 记录 SDK PID 10812 被 SIGKILL 后，分析器 10823 和处理器 10826 继续到重复输入产生解析/data-loss 错误，6445 ms 后退出，`cancellation.requested=false`。这证明当时缺少宿主断连取消，不是永久泄漏；没有放宽 5 秒门槛。SDK 现传入 `--owner-stdin`，分析器以不持有 Python 缓冲流锁的读取线程监听宿主管道关闭，触发现有取消/处理器树清理，并记录 `ownerDisconnected`。独立 Python 调用默认不监听 stdin。12 项 Python 测试、四包构建、Windows 真实 trace 回归 `perfetto-cancellation-1790745385224` 通过；启动未就绪夹具 `perfetto-startup-1790745383870` 的管道 EOF 在 192 ms 内终止实际子进程。POSIX 宿主强杀验收还要求保留 ownerDisconnected 取消回执；Windows 若操作系统直接终止分析进程，则保留外部进程退出观测。Linux/macOS 新修正尚待托管验证，这些结果不证明直接强杀 Python 分析器本身时的全部清理行为。

Windows 控制台托管验收补充：公开 `bcd884d` 的 [CI 36669801949](https://github.com/williamwue/appvanta/actions/runs/36669801949) 七项全部通过。Windows 分析归档的 58 个文件已本机逐一核验大小/SHA-256；`perfetto-cancellation-1790744617819` SDK/MCP/CLI 取消分别为 38/55/79 ms，诊断均为 cancelled，解析器与处理器退出且 cleanupError 为 null，归档中均无成功指标或报告。CLI 回执确认独立隐藏控制台仅含 runner 1468 与 CLI 7124，发送真实 CTRL_C_EVENT 后 31 ms 以退出码 1 结束。原始 trace 的三项指标与设备端预期一致；取消夹具仍是重复扩展输入。归档位于集成工作区 `.appvanta/ci-36669801949-analysis-windows/`，完整性回执在同级 `ci-36669801949-analysis-windows-integrity.json`。本次只独立下载核验 Windows 分析归档，其他平台依 CI 任务状态；该快照不含后续宿主强杀、失败产物修正和 SQL 查询中断验证，也不证明所有 Windows 终端环境。

```powershell
python -m venv .appvanta/perfetto-venv
.appvanta/perfetto-venv/Scripts/python.exe -m pip install -r scripts/perfetto-requirements.txt
node packages/cli/dist/index.js analyze-perfetto <trace路径> <应用包名> .appvanta/perfetto-venv/Scripts/python.exe 20000
```

CLI 最后两个参数为可选的 Python 路径和分析窗口毫秒数；省略 Python 时使用 `APPVANTA_PERFETTO_PYTHON` 或 PATH 中的 `python`。MCP 工具 `analyze_perfetto` 接受 `trace`、`packageName`、可选 `python`、`scenario`、`windowMs`。

官方 SDK 首次运行可能下载 Trace Processor。离线环境可直接调用 Python 脚本，通过 `--processor <可执行文件>` 指定已有工具。`--scenario` 可标记实验场景，但不会自动创建受控工作负载。

工具解析/下载现放入独立受管进程，继续使用官方固定版本及 SHA-256 校验。Windows 必须先取得 Job Object 所有权，POSIX 使用独立进程组；完成握手后才允许开始解析。取消终止整个解析进程树（包括官方下载器启动的 curl），并在 `initialization.json` 记录 PID、退出状态与取消状态。可能遗留的官方随机 `.tmp` 下载文件不是可用缓存，不自动删除其他进程的缓存或临时文件。处理器启动服务器期间、宿主硬终止和所有系统的完整取消闭环仍待验证。

SQL 请求未返回时的控制器验收：`verify-perfetto-query.py` 加载已保留的实际 trace，在真实处理器执行十亿项递归求和夹具；确认请求持续至少 250 ms 未返回且处理器仍存活，再分别写取消文件、将控制器期限推进至当前时刻。要求请求在 5 秒内以错误退出，解析器与处理器均已退出、清理无错误。Windows `perfetto-cancellation-1790744534049/query-cancellation/` 两条路径分别在 16/15 ms 返回，查询线程均退出；同次正常指标、SDK/MCP 取消、真实 Ctrl+C 和 SDK 宿主强杀检查通过。此验收已接入托管真实 trace 分析入口，Linux/macOS 结果待新 CI；它验证未返回 SQL 的受控终止，不证明所有产品 SQL、完整 110 秒期限等待或查询结果正确性。长查询仅为故障夹具，不进入产品指标。

Windows `perfetto-initialization-1790738166778` 通过官方 downloader + 本地停滞 HTTP 夹具：取消后解析 PID 和实际 curl PID 均退出、没有完成的缓存二进制。该证据使用注入的下载地址，不是公网断网验收。`perfetto-cancellation-1790738167691` 通过正常真实 trace 分析及 SDK/MCP 加载期取消回归；构建、268 项测试和 4 项收尾回归通过。三系统 CI 已加入 `python scripts/verify-perfetto-initialization.py`，托管结果待确认。

同一验收脚本现扩展真实 SDK 路径：从 `analyzePerfetto` 发起分析，在 HTTP 下载已开始时触发 AbortSignal，核对 cancelled、解析进程退出、处理器尚未启动、无成功指标/报告，并独立检查分析 Python、解析进程和 curl PID 已停止。Windows `perfetto-initialization-1790738394038` 通过。输入仅用于经过初始化阶段，不作为可解析 trace 或性能证据；该场景尚未验证 MCP 下载期取消。较早的 Linux CI `36663758987` 已通过直接解析器下载取消，归档 `perfetto-initialization-1790738376530` 已核验，早期快照不包含本次 SDK 扩展。

官方接口说明：[Python API](https://perfetto.dev/docs/analysis/trace-processor-python)、[Trace Processor CLI](https://perfetto.dev/docs/reference/trace-processor-cli)。

## 指标与证据

每次分析使用独立目录，保存 `analysis.json`、`metrics.json`、`report.md`。分析记录包含源 trace 路径及 SHA-256、实际 SQL、工具版本、窗口、进程与线程明细。失败保留分析错误，不生成成功指标。

- `cpu.scheduledTime`：应用及以 `包名:` 开头的子进程在窗口内获得 CPU 调度的累计纳秒数。
- `cpu.singleCoreEquivalent`：累计调度时间除以窗口时间的百分比。多核并行时可以超过 100%。
- `cpu.observedRunnableTime`：应用线程已记录、完整结束的 `R/R+` 状态与分析窗口相交部分的累计纳秒数。它表示观察到的 CPU 等待，多线程相加可能超过窗口时长；不代表完整唤醒延迟。未结束区间不外推，数量保存在 `analysis.json` 的 `runnableEvidence.incomplete_slices`。没有应用线程状态时省略该指标，不伪造零值。缺少唤醒事件可能低估等待，参见 [Perfetto 调度采集说明](https://perfetto.dev/docs/data-sources/cpu-scheduling)。

新增等待指标后 collector 为 `appvanta-sched-v2`，旧 `appvanta-sched-v1` 基线因上下文不同而拒绝直接比较，须重新建立基线。Windows 本地 `perfetto-cancellation-1790741094249` 使用已校验 API 35 trace：独立读取 91 条原始线程状态，35 个完整等待区间累计 14,944,858 ns，与分析结果一致；SDK/MCP 加载期取消回归通过。该证据来自保留的 trace 重分析，不是新增真机采样。SQL 边界夹具覆盖窗口裁剪、子进程隔离、多线程、未结束区间及缺失与零值的区分。

窗口从 trace 起点开始；省略窗口时使用 trace 时长向下取整到毫秒。调度片段截断到窗口边界。缺少应用、调度数据、Android fingerprint，或发现解析错误、数据丢失时拒绝生成指标。

指标采用性能测量版本 2，可交给 `baseline` 命令。设备身份取 fingerprint 中的 product 字段，不能与 meminfo 采集的型号字段直接视为相同；采集器名称和版本也必须匹配。阈值应来自独立定义的受控实验，验证脚本中等于当前值的阈值仅用于测试门禁行为。

## 当前验证与边界

真实 trace 跨宿主验收已接入独立三系统 CI 任务，依赖同次 Android 任务成功。`verify-perfetto-cancellation.mjs <证据归档目录> <python> archive` 先核验整个 manifest、大小和摘要，只接受唯一完整成功的两组六次采样，选定 trace 后再与采样记录核对摘要；各宿主重算的指标必须与原始分析逐项一致，然后实际执行 SDK/MCP 加载期取消，Linux/macOS 另执行 CLI SIGINT。源归档证明保存在 `source-archive.json`，不会按归档中的绝对机器路径读取文件。

Windows `perfetto-cancellation-1790740241660` 使用已核验的 API 35 归档通过重算与取消；失败采样归档 `36662397215` 在分析前被拒绝。随后公开 `957e471` 的 CI `36667400217` 七项任务全部通过：设备归档 3468 个文件、Windows 分析归档 48 个文件、Linux/macOS 分析归档各 56 个文件均核验大小/SHA-256。该快照包含等待时间指标，早于后续 AVD 取消和 ADB rwx 诊断修订，不代替后续 CI。

三系统选择的实际 trace 摘要均为 `dcf4ff84d9690f1af777f2bf79827ae08e243e03af40fb33ef783f26a79847e4`，输出逐项与设备原分析一致：调度 18,018,119 ns、单核等效 0.30030198333333336%、观察到的等待 17,463,472 ns。三平台独立原始状态对照均包含 113 条状态、47 个完整等待区间。API 35 两组三次采样的调度中位数为 16,353,423 / 17,091,670 ns，等待中位数为 17,463,472 / 10,594,979 ns，本次示例阈值比较通过；相同输入的跨平台一致性及本次通过均不能证明工作负载基线长期稳定。

加载期取消证据：Windows `perfetto-cancellation-1790742640003` 的 SDK/MCP 为 58/76 ms；Linux `1790742612212` 为 42/63 ms，CLI SIGINT 为 46 ms；macOS `1790742626799` 为 59/80 ms，CLI SIGINT 为 60 ms。均确认 cancelled、处理器/解析器退出、无清理错误和成功指标残留。正常指标来自原始 trace；取消夹具将其数据包重复 256 次以延长真实处理器的加载窗口，对扩展输入不主张指标正确性，也不代表所有查询/解析故障窗口。Windows 控制台信号未验证。

当前取消验收矩阵（具体运行见下文；历史段落中的“待验收”只代表当时检查时点）：

| 取消阶段/入口 | Windows | Linux | macOS |
|---|---|---|---|
| SDK 下载期，本地停滞 HTTP + 官方 downloader | 已验证 | 已验证 | 已验证 |
| MCP 下载期，取消后继续处理请求 | 已验证 | 已验证 | 已验证 |
| SDK/MCP 真实处理器加载期（扩展输入夹具） | 已验证 | 已验证 | 已验证 |
| CLI 真实中断信号，加载期（同上） | 本地 CTRL_C_EVENT 已验证，托管待验收 | 已验证 SIGINT | 已验证 SIGINT |
| 处理器服务器启动期间 | 直接 Python、SDK/MCP 未就绪夹具通过 | 同左，已验证 | 同左，已验证 |
| SDK 宿主硬终止，加载期 | 本地外部存活检查通过，托管待验收 | 待验收 | 待验收 |

SDK 宿主强杀补充：Windows `perfetto-cancellation-1790743605814` 在 `loading-trace` 记录出现后只强杀独立 SDK 宿主 30092；9 ms 后外部检查确认分析 Python 28456、处理器 30244 均不存在，且没有成功指标/报告。`owner-death-observation.json` 明确记录 `analysis: null`，不把强杀后未落盘的状态伪称正常取消回执，也不据此确定退出机制。最初夹具错误地强制要求收尾 JSON，导致 `1790743279140` 和 `1790743393597` 报“Cancellation evidence missing”；后续确认两次相关进程均已退出，因此这些失败不能证明进程泄漏。试验性的管道监控改动已撤回，保留原产品实现。最终脚本还通过正常分析、SDK/MCP 取消与 Windows CLI 控制台事件，并将宿主强杀检查接入三系统 CI。其他阶段强杀、分析 Python 自身被杀、其他宿主环境仍未验证。仅在失败后的夹具收尾阶段才允许发送取消文件，单独记录该动作，不能将它计入产品通过证据。

MCP 下载期三系统归档：CI `36664809527` 的主机任务全部通过，每个平台各 30 个文件完成大小/SHA-256 核验。Windows `perfetto-initialization-1790739379590`、Linux `1790739225958`、macOS `1790739232354` 均确认取消后分析 Python/解析器/curl 停止、无成功报告、取消请求响应被抑制、后续 `tools/list` 成功。它们是受控本地 HTTP 夹具证据，不是公网断网或启动服务器阶段证据。

Windows CLI 补充：本地 `perfetto-cancellation-1790743026280` 通过真实 `CTRL_C_EVENT`。验证器以 `CREATE_NEW_CONSOLE` 和隐藏窗口创建 CLI，在已有 `loading-trace` 记录后附加到该独立控制台，核对成员 PID 并发送事件；`cli-console.request.json` 记录控制台成员仅为验证器 8716 与 CLI 24624。CLI 正常以 1 退出并报告取消，分析 Python 33588、处理器 31068 均停止，分析为 cancelled，解析器停止、清理无错误且无成功指标/报告。事件发送到 CLI 退出为 62 ms，包含后续检查的取消验收为 83 ms；SDK/MCP 同轮回归通过。使用的仍是重复扩展加载夹具，不代表查询期、下载期、任意终端宿主或 AVD 的信号行为。托管三系统脚本已在 Windows 加入此路径，结果待新 CI。[Microsoft 控制台事件定义](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent)说明 CTRL+C 无法限定到非零进程组，因此验证器使用独立控制台，不向原宿主控制台发送广播。验证器的 Job Object 仅用于该分析测试进程树的兜底回收，不能把这种兜底当作产品主动清理证明。

MCP 下载期取消：Windows `perfetto-initialization-1790739074311` 同时通过 SDK 与真实 MCP stdio 客户端。收到 `notifications/cancelled` 后，分析 Python、解析器和 curl 均停止，处理器未启动、无成功指标/报告；MCP 抑制被取消请求的响应，并继续处理 `tools/list`。客户端验证现独立于 Python HTTP 夹具，三系统 CI 自动运行 SDK/MCP 两种客户端。首次重构验证误将 `.cancel` 文件计作分析目录，修正为只检查目录后通过；它不是产品取消失败。此 MCP 场景仍待 Linux/macOS 托管结果，不替代服务器启动期间或硬终止验收。

SDK 下载期取消的三系统验收现已完成：CI `36664032094` 主机任务全部通过，每个平台各 26 个文件大小/SHA-256 核验通过。Windows `perfetto-initialization-1790738770620`、Linux `1790738602011`、macOS `1790738593691` 均从 SDK 发起真实分析，在官方 downloader 访问本地停滞 HTTP 夹具后触发 AbortSignal；确认分析 Python、解析器、curl 停止，分析 cancelled，处理器未启动且无成功指标/报告。归档位于 `.appvanta/ci-36664032094-{windows,ubuntu,macos}`。该证据覆盖 SDK 下载阶段，未覆盖 MCP 下载期、处理器服务器启动期或公网断网，整项 Perfetto 验收仍未完成。

下载取消跨系统证据：CI `36663758987` 的 Windows/Linux/macOS 三个主机任务通过，每个平台各 21 个归档文件已校验大小及 SHA-256。Windows `perfetto-initialization-1790738492512`、Linux `1790738376530`、macOS `1790738371982` 均验证官方 downloader 在本地 HTTP 停滞后取消，解析器及 curl 停止、无已完成缓存。该快照不包含后续 SDK 下载期取消扩展，不能据此扩大为全部初始化阶段或公网断网验收。

托管证据补充：公开 `6f08fd5` 的 CI `36661266279` 四项任务全部通过，设备归档 `.appvanta/ci-36661266279/.appvanta/ci-evidence` 的 3342 个文件已逐一核验大小和 SHA-256。Linux `perfetto-cancellation-1790737583825` 验证真实处理器加载期间 SDK、MCP、CLI 取消，观测耗时分别为 21/54/50 ms；CLI 使用真实 SIGINT、退出码 1，三者均确认 Python/处理器退出、无成功指标及报告，MCP 后续仍可列工具。该快照不含后续收尾竞态修正，不能替代其托管验证。Windows 控制台信号、macOS 和初始化/下载阶段仍待验收。

同一归档的 API 35 `perfetto-sampling-1790737522524` 完成六条独立 trace，两组 CPU 中位数为 18.432 ms 和 18.086 ms，示例基线比较通过。fingerprint 为 Android 15 / AE3A.240806.043；它不能与 API 37 的测量混用基线，也不证明广泛场景的性能稳定性。

`node scripts/verify-perfetto.mjs <trace> <python>` 验证 CLI/MCP 一致性、源文件哈希、线程汇总、报告、基线通过与失败，以及缺失应用、过长窗口和损坏文件的拒绝路径。

当前实测：API 37 模拟器保留的 22 秒 trace，分析前 20 秒，证据目录 `.appvanta/runs/perfetto-check-1789534742437/verification.json`。

采集协作取消后的远端进程回收已实测，见 [采集回收](capture-lifecycle.md)。

Flow 自动启动和结束采集已接入，成功、失败和取消路径均保存产物。

启动期三系统证据：CI `36666009878` 的三个主机任务均成功，每个平台各 61 个归档文件已核验大小/SHA-256。Windows `perfetto-startup-1790740330882`、Linux `1790740180877`、macOS `1790740206973` 的 SDK/MCP 分别于 120/142、36/56、34/65 ms 取消；直接 Python 路径也通过。均验证未就绪进程退出、无成功报告、MCP 后续可用。该夹具覆盖启动未就绪窗口，实际处理器正常启动和解析由独立 trace 回归覆盖，不能当作全部异常启动故障或宿主硬终止证明。

尚未完成：广泛场景的可重复基线、帧卡顿分析、其他查询/解析故障窗口、Windows 控制台信号的托管及其他终端环境、宿主硬终止及完整设备断连验收。SDK/MCP 下载期、启动未就绪及处理器加载期夹具已覆盖三系统，不能与这些未验收窗口混为一项。采集宿主强杀与 TCP 拉取中断恢复已有有限验收，见 network-capture.md。指标不表示墙钟耗时或频率加权工作量。

## 分析取消

SDK `analyzePerfetto` 接受 `signal`；CLI 的中断控制器和 MCP `notifications/cancelled` 接入同一路径。调用前已取消时不启动 Python。运行中向该次分析的唯一取消文件写入请求，Python 监视请求并通过 Perfetto 的关闭接口回收自身创建的处理器；关闭与正常退出串行化。源 trace 保留，取消分析删除本次输出目录中的指标和报告，`analysis.json` 保存 `cancelled`、处理器 PID 与退出证据。无法确认回收时记录 `cancellation-unverified`；SDK 错误仅表示请求取消，最终状态以记录为准。

Python 的协作期限为 110 秒，宿主执行期限为 120 秒。取消不会立刻强杀分析 Python；工具下载期间由它关闭受管解析进程树。下载完成后，AppVanta 直接持有处理器进程树，在服务器就绪前就能取消，并通过官方 `TraceProcessor(addr=...)` 接口加载和分析。启动等待上限沿用 30 秒，每次本地状态请求限 250 毫秒，保留 stdout/stderr 和 `processor.json` 的 `starting-server` / `loading-trace` 阶段。宿主硬终止及 Windows 控制台真实 Ctrl+C 仍需专项验收。调用方请求已完成后才送达的取消，也不改写已有正常完成结果。

启动期故障与修复证据：旧实现 `perfetto-startup-1790739629469` 在真实启动但不提供 HTTP 服务的夹具上，取消后超过 45 秒未返回，验证失败；终止分析后确认夹具 PID 已退出。持有启动进程后，`perfetto-startup-1790739807919` 直接 Python 路径在约 227 ms 内 cancelled，启动进程及夹具子进程退出，无成功报告；这是未就绪夹具，不是完整 SDK/MCP 启动验收。`perfetto-cancellation-1790739808705` 复验真实 trace 正常分析及 SDK/MCP 加载期取消通过，加载期验收明确等待 `loading-trace`；`perfetto-initialization-1790739835903` 的 SDK/MCP 下载取消回归通过。构建、268 项测试和 4 项收尾回归通过，三系统 CI 已加入启动夹具。

Windows 真实验证 `perfetto-cancellation-1790736192243/verification.json` 通过正常分析、预先取消，以及 SDK/MCP 在真实 Trace Processor 加载期间取消：取消前 Python 和处理器均存活，取消后两者均退出、无成功指标/报告，MCP 仍可列工具。使用重复 trace 包构造的较大输入仅用于延长真实解析窗口，不用于性能结论。早期验收脚本曾错误等待被取消 MCP 请求的响应；协议会抑制该响应，产品取消记录与退出证明保留在 `perfetto-cancellation-1790735857573`。修正后的首轮 `1790736038055` 和最终轮均通过。

复验：`node scripts/verify-perfetto-cancellation.mjs <受控夹具trace> <perfetto-python>`。Linux CI 另验证 CLI 的真实 SIGINT；Windows 跳过这项并明确记录 `cliSignalVerified: false`。构建、268 项测试及四包干净安装/重装/卸载检查通过，最新 Python 清理确认分支已复验；跨版本迁移不在本次重装检查范围内。

## 固定工作量多次采样

启动期客户端验收扩展：Windows `perfetto-startup-1790740002182` 通过直接 Python、SDK 与 MCP 三条未就绪夹具路径。SDK/MCP 分别约 117/166 ms 取消，核对 `starting-server` 阶段、处理器进程树和分析 Python 退出，无成功指标/报告；MCP 取消响应被抑制且后续 `tools/list` 正常。客户端测试注入的可执行程序只用于模拟服务器永不就绪，不是实际 Perfetto 数据分析；正常处理器分析由前述独立回归覆盖。`perfetto-initialization-1790740020174` 下载期 SDK/MCP 回归通过，三系统 CI 的启动验收入口自动包含新客户端，托管结果待确认。

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
