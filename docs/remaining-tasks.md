# AppVanta 当前状态与剩余任务

更新：2026-09-30。本文件汇总当前有界验收；阶段清单中的逐次记录作为带日期的历史证据，旧段落中的“待完成”应结合本文件及后续验收读取。最终目标仍是覆盖固定版本 Argent / ARTEMIS 的全部公开可验证功能，不因本轮收尾缩小范围。以下 39 项清单保持完整，3 项已完成、36 项仍待办。

最新托管证据：`36661266279` 已四项全绿，3342 个设备归档文件大小/SHA-256 核验通过。API 35 六次受控采样及 Linux SDK/MCP/CLI 加载期取消通过，CLI 使用真实 SIGINT；见 perfetto-analysis.md。该快照早于收尾竞态修正及设备端重连验收，不能代替后续提交的 CI，也不关闭历史拉取失败。下文该运行“仍运行”的记载属于较早检查时点。

最新诊断补充：CI `36659987371` 三系统通过，Android 在首条 Perfetto 采样的 `adb pull` 返回 1、输出为空，尚未进入性能比较。恢复验证和采样验证均已接入 ADB transport/boot ID/adbd 观测；API 37 设备端显式重连、断连恢复及六次受控采样通过，详情见 perfetto-analysis.md。CI `36661266279` 三系统已通过，Android 在本次查询仍运行；这些证据不关闭历史拉取失败或真机/OEM 门槛，计数保持 3/39。

历史回执补充：本地 `b2d38a7` 已发布为公开 `d69d853`，回执查询构建及 263 项测试通过。API 37 完整多附件验收 `share-helper-1790728702236/verification.json` 通过两种宿主强杀窗口、CLI/MCP 实际交付及三种回执状态的只读查询，测试文件已清理。新快照的 [CI 36651339703](https://github.com/williamwue/appvanta/actions/runs/36651339703) 尚未确认完成。较早公开 `ad5d8cc` 的 [运行 36650193630](https://github.com/williamwue/appvanta/actions/runs/36650193630) 中 Android、Linux、macOS 通过，但 Windows 监控转移的两个文件占用用例失败：持续占用用例等待持锁握手 10 秒超时，短暂占用用例在 18 秒宿主期限终止。现有日志不足以确定完整根因；后续补即时阶段及子进程终止诊断，本地两用例通过，未放宽产品重试或测试期限。此失败仍保留为未解释项。

当前补充：本地 `d1d50c8` 的正式上传客户端已发布为 `8f2c1e4`；本地 `6a0fb4c` 的采集失败对照诊断已发布为 `a9a132b`。上传快照的 CI `36658161216` 四个任务均已通过；诊断快照的 CI `36658617026` 三系统已通过，Android 尚在运行。成功运行的 3208 个设备归档文件已完成大小及摘要核验。先前 `36656573462` 的 Perfetto 拉取失败仍未解释，3020 个归档文件已核验。采集传输新增远端前后大小/SHA-256 与本地摘要比对，构建及 268 项测试、API 37 正常采集及两种断连恢复通过；该改动的托管结果仍待验证，见 network-capture.md。真机/OEM 不可用，39 项范围及 3 项验收计数不变。

历史验收纠正：`6697796` 的 running-task 测试保留了原租约，并未模拟真实崩溃后的转移租约，不能据此证明恢复成功。后续转移重试增加了独立当前 token、初始化日志、无绑定意图及来源证据校验，并已补实际进程强杀验收。真机/OEM 仍不可用；同版本重装不证明跨版本升级或数据迁移。

历史完整本地回归：`c4cb627` 的构建及 core 106、Android 78、脚本 40 项，共 224 项测试通过。后续 `06464fa` 的传感器探针构建、API 37 应用回调验收和脚本 40 项测试通过。后续嵌套恢复阶段诊断改动已通过 Android 78 项测试及 12 项聚焦复验，未放宽原有 15 秒子进程期限。测试数量绑定对应修订，不作为所有平台功能已验收的证明。

历史已确认全绿快照：公开 `7b65ebc` 对应本地 `06464fa`，[托管运行 36616671566](https://github.com/williamwue/appvanta/actions/runs/36616671566) 的 Windows/Linux/macOS 构建、测试、安装升级及 API 35 Android 任务均通过，包含 Flow 模板执行、应用进程判断、传感器应用回调、截图 SSIM 和录屏/Perfetto 拉取中断恢复。此次仅确认托管任务和步骤结果，尚未下载核验其证据归档。较早运行 `36611548538` 的 162 个归档文件已通过大小和摘要校验。运行 `36611226747` 的录屏拉取偶发失败，以及 `36616019027` 的 Windows 嵌套恢复子进程 15 秒超时，根因仍未确认；后续通过不抹除历史失败。

API 37 / Android 17 已验证裁决后步骤边界再次崩溃、只读等待执行中再次裁决、文件恢复与外部修改冲突、Markor ASCII/Unicode 实际写入后避免重放，以及连续三次租约转移后运行绑定前强杀并通过 MCP 显式重试。见 [裁决 CLI 与验收边界](adjudication-cli.md)。未覆盖任意写入动作、全部环境夹具、运行绑定进行中或 IME 内部强杀。API 35 的旧通用 nested 未决租约仍保留。

历史公开提交 `14f6854` 对应本地 `1b3ad37`，[托管 CI](https://github.com/williamwue/appvanta/actions/runs/36602005805) 四个任务均通过。该结果不代表后续提交；以下早期失败、工具数与测试数均属于历史记录。公开快照不包含本地历史提交及忽略的设备证据，正式版本发行、全部数据模式迁移和真机/OEM 验收仍未完成。

后续公开快照 `3957caf` 的 [CI](https://github.com/williamwue/appvanta/actions/runs/36604519328) 已通过 Linux/API 35 录屏和 Perfetto 拉取中断恢复，以及 Linux/macOS 构建测试；Windows 监控 Worker 转移记录时 EPERM，整次运行失败。本地已用真实 Windows 文件共享占用复现同类错误，为监控记录原子发布增加约 2 秒的有界重试。短暂占用后转移成功，持续占用仍失败且原所有权记录不变；四包构建、core 97、Android 74、脚本 38 项共 209 项测试通过。该修正的托管验收须以对应新提交结果为准。

本轮分支裁决修订：构建及完整回归 248 项通过（core 121、Android 87、脚本 40），包含测试 Driver 下首次分支动作执行中强杀后的证据固定、缺失拒绝及裁决准备的字节变更拒绝。日志位于集成工作区 `.appvanta/active-branch-build.log` 和 `.appvanta/active-branch-full-tests.log`；后续 API 37 Markor Unicode 输入的分支裁决已通过 CLI/MCP 预约及执行验证，详见 flow-templates.md；该场景不等于任意分支或应用均已验收。

历史已确认托管通过的公开快照 `d5a1bbd`（本地 `ae038d2`），[运行 36631565559](https://github.com/williamwue/appvanta/actions/runs/36631565559) 的三系统任务及 API 35 模拟器任务均成功，含动态值和单附件系统选择器验收。此次确认任务结果，未下载该成功运行的归档。此前动态值运行 `36628200065` 和 `36628674091` 也已通过。后续 URI 校验修订 `4f96055` 构建及完整 257 项回归通过；这些结果均不证明全部清单完成。运行 `36630143675` 的 Perfetto 拉取失败仍未解释，1842 个归档文件已校验，见 network-capture.md。

## 本轮已完成的范围

- Windows 监控转移回归改为显式持锁握手：真实 rename 首次返回 EPERM 后，临时占用夹具确认持锁进程退出，再把原始错误交回产品重试；持续占用仍须在 40 次失败后拒绝且原记录字节不变。关闭重试的对照实验失败，现有实现通过。产品重试策略未修改。运行 `36614743642` 的旧夹具失败缺少实际释放时刻，不能据此确定产品缺陷或证明其根因已解决；新夹具记录锁定、拒绝、释放和结果时间。

- 后续诊断快照 `48b2bf6` 的运行 `36612019910` 已四项通过，上文的运行中状态属于较早检查时点；这不证明运行 `36611226747` 的偶发拉取失败根因已解决。

- UI 观察针对 `UiTestAutomationBridge` 的明确空根节点响应最多尝试三次，间隔 250 毫秒且支持取消；每次保留独立截图、原始 XML 和尝试日志。其他解析错误仍直接失败。修复前回归用例失败，修复后完整测试及 API 37 Markor CLI 冒烟通过；故障注入验证重试分支，正常模拟器冒烟不证明已重现该偶发故障。公开快照 `fe1f20a` 的四项托管 CI 已通过，但该快照不含此次重试修复。

- 文本分享进入 Action/Flow/MCP，Markor 原文件验证中文、多行和特殊字符，目标不存在时阻止后续动作。
- 安全边界上的任务续跑、独立 Worker、启动取消、ready 运行绑定核验、租约转移后准备阶段恢复，以及转移前取消后的安全重新认领；不覆盖所有不确定动作。
- 网络宿主/Worker 同时强杀与录屏/Perfetto 显式恢复，恢复前保留残留采集文件和日志。
- 视频完整解码、截断拒绝、22 秒动态画面验收；分段录屏实现、四段动态短测及 Flow 成功/取消/预算耗尽验收。
- AVD 发现、启动/复用、显式 GPU 模式；API 35 SDK 镜像 r9 安装及 AVD boot 已通过。API 37 历史异常退出原因仍未知。
- 图像模板定位、截图容差/遮罩和稳定等待已有 API 37 验收；运行时权限与首次启动重置等补充证据见阶段清单。
- 录屏采集传输失败、取消及文件缺失/为空时已改为保守失败，并保留可用的设备端产物和控制信息以供恢复；这是已集成的传输边界修复，不代表所有断线组合已验收。
- 不确定步骤的裁决已有不可变准备记录的只读读取及原始字节摘要校验；准备记录仍不可运行，不授权真实设备续跑。
- 设备租约版本 2 的持久准入日志已集成：危险或不确定的清理保留租约，终结阶段拒绝迟到的嵌套操作准入；真实设备恢复及全部故障组合仍待验收。

关键证据（路径均相对项目根目录；下表前六项短名称位于 `.appvanta/runs/`，其余列出完整本机忽略路径，公开仓库当前不含这些文件）：

| 范围 | 证据 |
|---|---|
| 文本分享 | `text-share-1790427425340/verification.json` |
| 安全取消后重新认领 | `startup-cancel-1790428441053/verification.json` |
| 网络与采集同时强杀恢复 | `network-capture-recovery-1790428729832/verification.json` |
| 动态录屏时长 | `dynamic-recording-1790429080866/verification.json` |
| 短分段动态解码 | `segmented-recording-1790429687393/verification.json` |
| 分段生命周期 | `segmented-flow-1790429629050/verification.json` |
| API 35 r9 安装与 AVD boot | `.appvanta/programs/appvanta-completion-g1/pilot-report.md` |
| API 35 长时动态分段与解码 | `.appvanta/worktrees/recording-g4/.appvanta/runs/segmented-recording-1790589670607/verification.json`；`.appvanta/worktrees/recording-g4/.appvanta/runs/video-content-1790589875060/verification.json` |
| API 37 长时动态分段与解码 | `.appvanta/programs/appvanta-completion-g1/p0-01b-dynamic-report.md`；`.appvanta/worktrees/baseline-g3/.appvanta/runs/segmented-recording-1790591433876/verification.json`；`.appvanta/worktrees/baseline-g3/.appvanta/runs/video-content-1790591638420/verification.json` |
| 旧失败采集恢复及截断确认 | `.appvanta/programs/appvanta-completion-g1/p0-02b-reuse-report.md` |
| API 35 主机 GPU 时钟长测 | `.appvanta/programs/appvanta-completion-g1/api35-g19-clock-report.md`；运行 `.appvanta/worktrees/baseline-g3/.appvanta/runs/segmented-recording-1790604017676`；解码 `video-content-1790604222355`（同一 runs 目录） |
| API 37 主机 GPU 时钟长测 | `.appvanta/programs/appvanta-completion-g1/api37-g19-clock-report.md`；运行 `.appvanta/worktrees/baseline-g3/.appvanta/runs/segmented-recording-1790604433069`；解码 `video-content-1790604637404`（同一 runs 目录） |
| API 37 Markor CLI 单步冒烟 | `.appvanta/worktrees/baseline-g3/.appvanta/runs/2026-09-28T14-16-46-133Z-emulator-5554-840a368e/report.json` |
| API 37 录屏与 Perfetto 取消 | `.appvanta/worktrees/baseline-g3/.appvanta/runs/capture-cancel-1790605134178/verification.json` |

## 当前环境与交付状态

- 2026-09-26 的 190 秒尝试在 API 37 模拟器异常退出；默认后端与 SwiftShader 尝试均未通过，当时的失败不能抹去。其后 API 35 动态分段录屏 195.470956 秒、API 37 199.342833 秒通过严格完整解码。更新的主机 GPU 时钟夹具各请求 190 秒：API 35 四段严格完整解码合计 200.235412 秒，三个采样边界分别为 817/1283/700 毫秒；API 37 四段合计 200.036322 秒，边界为 1400/584/819 毫秒。这些数字只来自解码帧内的时钟采样；时钟量化的 ±1 毫秒界限不包括绘制、显示或采集延迟，不能证明精确编码/显示间隙或无缝录屏，也不证明真机稳定性。API 37 历史退出根因仍未知。
- 旧失败运行 `segmented-recording-1790429923211` 的残留采集已显式恢复，但 MP4 截断；更早 `segmented-recording-1790429282870` 的第三段也已显式恢复。截断产物不能计为有效长录屏。
- 2026-09-26 API 35 SDK 镜像首次安装曾因 `Error reading Zip content from a SeekableByteChannel` 失败；随后 r9 安装和 API 35 AVD boot 通过。先前失败是历史记录，不再是当前阻塞项。
- `8825da3` 的本地 `verify:release-packages` 四包检查退出 0，`doctor` 为 ready，MCP 列出 49 个工具；同修订的 API 37 Markor CLI 单步冒烟通过，`cleanupFailed: false`，事后 `inspectDeviceLock` 为 null。单次模拟器冒烟不等于托管 CI、跨平台或真机验收。
- `8825da3` 的 API 37 实际录屏及 Perfetto 取消验收通过：两类记录均为已取消且已清理；这仅覆盖该次模拟器取消路径，不覆盖 P0-04 的全部故障组合。
### 早期集成与首次公开发布记录

以下段落描述当时状态，不代表当前实现或最新 CI。

- 集成修订 `32f9d56` 的录屏传输修复已独立复核，全部包构建及 `npm test` 通过；集成修订 `de1541a` 的不可变准备读取/原始字节摘要边界通过全部包构建及完整 core 52 项测试。租约守卫 `f8d7492` 经独立复核未发现问题（42 项聚焦回归），已在 `8825da3` 集成并保留已复核的录屏实现；该集成修订的 `npm run build` 和 `npm test` 均通过。严格裁决租约快照修复 `908a74e` 经独立复核未发现问题，已在 `0b4cff7` 集成；该修订全部包构建及完整 core 74 项测试通过。它严格接受有效版本 1/2 租约及精确的可选 `processToken`、`cleanupRequired` 字段，记录/准备/读取测试覆盖真实子进程退出后遗留的版本 2 租约，并维持 `resumeAuthorized: false`。可运行的受保护检查点与后继任务续跑仍未完成。各次数量绑定其修订，不推算最新统一全套测试数。公开仓库 <https://github.com/williamwue/appvanta> 已发布实验性源码快照：`main` 的初始提交 [`93749a0`](https://github.com/williamwue/appvanta/commit/93749a0cb87937149376aaac16adf8d199660acb) 为无父提交，其树 `03a5fb1` 与本地集成修订 `fda6c8b` 的树完全一致；主页描述、topics 与私密漏洞报告入口已设置。本地历史提交编号和上述 `.appvanta/` 忽略的设备证据并未随快照公开，托管 CI 与真机/OEM 验收仍未完成。对应 [GitHub Actions 运行](https://github.com/williamwue/appvanta/actions/runs/36435782854) 已以失败结束：Windows/macOS 遇到路径别名运行时/测试问题，Ubuntu 的 release-package `doctor` 因 ADB 不可用报 `spawn adb ENOENT`，Android job 缺少 `sdkmanager`。修复仅在本地准备，托管重跑尚无结果，不能计为托管通过。2026-09-26 的 77 项（core 31、Android 28、脚本 18）和 `.appvanta/wrapup-build.log`、`.appvanta/wrapup-tests.log` 是当时的历史快照。

## P0：下一轮先处理

- [ ] P0-01：定位 API 37 历史异常退出根因；API 35 r9 安装及 AVD boot 已通过，不据此勾选整项。
- [ ] P0-02：实测片段之间的精确媒体时间间隙、设备拔插/超时失败路径；双 API 长时动态分段、严格解码及采样时钟边界已通过，传输失败/取消/空或缺失文件已保守失败并保留可用设备证据，但不据此勾选整项。
- [ ] P0-03：补更多环境夹具、运行绑定中断及 IME 内部强杀的恢复验收。CLI/MCP 裁决、再次崩溃、Markor ASCII/Unicode 实际写入后避免重放，以及连续三次未绑定转移已有 API 37 证据。准备记录本身仍不授权执行，缺少证据或通用 nested 未决租约不能自动释放。详见 adjudication-cli.md。
- [ ] P0-04：补设备端传输、USB 拔插及更多采集组合故障验收。API 37 已验证恢复期间取消、代理恢复的重复 TCP 断连与期限耗尽，以及录屏／Perfetto 文件拉取 DATA 帧中断后保留证据、同 token 重连恢复。TCP 验收针对主机 ADB 客户端到服务端链路，不代表设备端传输或 USB 拔插；危险或不确定清理仍保留租约。详见 network-capture.md。
- [ ] P0-05：整合本轮文档和功能提交后复核状态一致性；文档更新本身不使该项完成。

P0-04 补充：API 37 `network-capture-recovery-1790737390334` 已验证录屏/Perfetto 活跃进程期间从设备端重建 ADB 连接，随后宿主强杀，以原 token 恢复并核对文件摘要、清理、代理和租约。此项扩展超出此前主机中继场景，但设备端 DATA 帧中断、USB 与 OEM 仍未验收，P0-04 保持待办。

## P1：Android 能力与验收

- [ ] OCR 与外部 Agent 视觉判断接入，图像模板跨 DPI/主题验证。
- [ ] 探索式执行及快速/计划两种 Agent 工作流的端到端验收；Planner/Checker 继续由客户端 Agent 承担，不内置强制模型 API。
- [ ] 附件分享、系统选择器、更多跨应用组合和多语言界面。已有 content URI 的只读单附件及 `share-files` 多附件已接入 Action/Flow/MCP；多附件产品 helper、持久回执、准备中断和重复请求拒绝已有 API 37 验证，真实 CLI/MCP 双附件字节与权限验收通过。单附件系统选择器接收和取消已有 API 35/37 验收。多附件 API 37 英文选择器已补取消无交付与实际接收，修复 helper 提前结束导致转授权失败，证据 `share-helper-1790729412544`。托管上传原生 provider 已通过完整文件/空文件、摘要与大小校验、不可覆盖、实际分享和删除撤权，见 managed-uploads.md；正式 CLI/MCP/SDK 上传、查询、删除及两个宿主强杀窗口的租约恢复已通过 API 37；其他上传生命周期故障窗口、多附件完整选择器、多语言和更多 provider/应用仍待完成，见 file-sharing.md、multi-attachment-design.md。
- [ ] shake、更完整的设备状态控制及原状态恢复。模拟器摇动已接入 CLI/MCP Flow、MCP 独立动作及 SDK 单动作入口；三轴控制台恢复、MCP 取消、独立应用 SensorEvent 回调、宿主强杀，以及模拟器实际退出重启后的标准恢复已有 API 37 证据。任意应用响应、更多断连/重启冲突组合、多设备及真机仍待验收，见 emulator-sensors.md。
- [ ] 更多 Android 构建配置、项目结构及构建失败诊断。
- [ ] AVD 创建、依赖安装、设备授权引导及启动取消的产品化。
- [ ] 更多输入法、复杂编辑器、手势、权限、多用户、首次引导与数据重置场景。
- [ ] 网络 CA 信任、证书固定及不可采集边界；真机连通性和拔插恢复。
- [ ] Perfetto 受控多次采样、更多性能指标及可重复基线；分析进程取消管理。API 37 已完成独立固定工作量应用的两组各三次采样，每组两次预热，并核对校验和、PID/TID 与设备 trace 时钟窗口。采样协议通过，但第二组超过首组加 25% 的示例阈值，稳定基线尚未证明；SDK/MCP 已补 Windows 真实分析进程取消与回收，更多指标、场景、初始化/下载及跨系统取消仍待完成，见 perfetto-analysis.md。
- [ ] 完整 tombstone、系统 ANR 标签与 OEM 差异验收。
- [ ] Android 真机与至少一个 OEM 环境的完整闭环验收。

## P2：工程化与客户端接入

- [ ] Flow 变量、条件、子流程和组合复用。类型化变量、参数化子流程、逐步骤 when、单次判断的 branch、模板 then/else 与嵌套分支编译已有实现；判断证据、跳过步骤续跑、嵌套决定在续跑时固定及实际动作回放已补验证。首次未完成分支的裁决预览及准备已绑定决定内容、原始字节摘要和缺失状态，真实宿主强杀测试通过；API 37 Markor Unicode 输入后经 CLI/MCP 预约及执行已通过。两层分支实际输入中断及原条件由真变假后的 MCP 固定选择续跑也已通过；运行时具名字符串提取、输入引用和强杀后的值固定已有 API 37 CLI/MCP 证据，见 flow-values.md；其他祖先组合、更多值转换/引用及完整客户端验收仍待完成，见 flow-templates.md。
- [ ] 手动录制的复杂控件、Canvas、多点、硬件键与真机回放。
- [ ] 异步批次和监控 Worker 崩溃恢复、优先级、网络并发；监控日志/指标采样。
- [ ] 交互式计划修订；续跑 Webhook、自定义 hook 和持久通知投递。
- [ ] 环境比较补输入法、文件内容、AppOps；视觉回归补感知差异、自动对齐和多设备基线。环境扩展已通过 API 37 本地及托管 API 35 验收；截图比较已补有限平移对齐和可选 SSIM 门禁、CLI/MCP 合成图验证及 API 35/37 设置页面真实截图验证。广泛场景阈值校准、缩放/旋转、多设备基线及多用户/OEM 仍待完成，见 environment-comparison.md、visual-alignment.md。
- [ ] 证据时间线/覆盖层、跨电脑离线导出、通用脱敏与历史引用迁移。
- [ ] Codex、Claude Code、Cursor 产品内安装与真实调用验收，以及 MCP 断连边界。
- [ ] 稳定对外 SDK 与 Python SDK。
- [ ] 覆盖全部执行入口的权限前后状态、执行者与结果审计。

## P3：CI 与开源发布

- [x] 发布实验性源码快照并完成公开项目主页及安全发布准备；公开 `main` 初始提交 [`93749a0`](https://github.com/williamwue/appvanta/commit/93749a0cb87937149376aaac16adf8d199660acb) 的树与本地集成修订 `fda6c8b` 一致，[私密漏洞报告入口](https://github.com/williamwue/appvanta/security/advisories/new)已启用；这不等于完整产品验收或 npm 发布。
- [x] Windows/Linux/macOS 托管构建、测试、干净安装与子进程行为验收。
- [x] 托管 Android Emulator 验收及失败证据上传；CI/Jenkins 文档与实际执行对齐。
- [ ] 各系统从空目录安装 tarball，验证 CLI/doctor/MCP，复验升级、迁移、卸载。真实 `0.1.0 → 0.2.0-alpha.1` tarball 升级已在 Windows/Linux/macOS 托管 CI 通过：旧 v1 任务、批次、监控读取，失去所有者的待办不自动执行，未知记录及项目数据在卸载后保留。其他数据模式迁移与运行中升级仍需验收，见 release-checklist.md。
- [ ] 发布版本、tag、可复核构建记录、发行物第三方归属及发布报告。
- [ ] 对固定竞品基线重新逐项审计，补未盘点能力及证据；所有目标平台验收后才声明完整覆盖。

## 最后阶段：平台和部署形态

- [ ] iOS Simulator/真机、UIKit/native view、NSURLProtocol、Instruments。
- [ ] React Native 组件树、Hermes/JS 调试、Profiler 和联合分析。
- [ ] Electron/Chromium、DOM、Cookie、Storage、桌面/Web 操作。
- [ ] TV、遥控输入与焦点导航。
- [ ] HarmonyOS Driver。
- [ ] 远程设备、企业私有化、身份权限和集中审计。
- [ ] 云设备池、远端 Worker、并发和资源配额。
- [ ] 可选 Web 管理界面。

参考：[阶段历史与证据](phase-4-5-checklist.md)、[能力矩阵](competitor-coverage.md)、[发布门禁](release-checklist.md)、[路线图](roadmap.md)。
