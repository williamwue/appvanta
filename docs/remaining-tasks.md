# AppVanta 当前状态与剩余任务

更新：2026-09-30。本文件汇总当前有界验收；阶段清单中的逐次记录作为带日期的历史证据，旧段落中的“待完成”应结合本文件及后续验收读取。最终目标仍是覆盖固定版本 Argent / ARTEMIS 的全部公开可验证功能，不因本轮收尾缩小范围。以下 39 项清单保持完整，3 项已完成、36 项仍待办。

历史验收纠正：`6697796` 的 running-task 测试保留了原租约，并未模拟真实崩溃后的转移租约，不能据此证明恢复成功。后续转移重试增加了独立当前 token、初始化日志、无绑定意图及来源证据校验，并已补实际进程强杀验收。真机/OEM 仍不可用；同版本重装不证明跨版本升级或数据迁移。

最新本地验收：`3f57c64` 的完整测试为 core 97、Android 74、脚本 36 项，共 207 项通过；四包安装/重装/卸载验证通过（doctor ready、55 个 MCP 工具、已有项目记录保留）。后续 `41ee015` 仅修改验收脚本及文档，脚本 36 项测试及 API 37 录屏／Perfetto 拉取中途 TCP 断连恢复通过，见 [网络与采集验收边界](network-capture.md)。

API 37 / Android 17 已验证裁决后步骤边界再次崩溃、只读等待执行中再次裁决、文件恢复与外部修改冲突、Markor ASCII/Unicode 实际写入后避免重放，以及连续三次租约转移后运行绑定前强杀并通过 MCP 显式重试。见 [裁决 CLI 与验收边界](adjudication-cli.md)。未覆盖任意写入动作、全部环境夹具、运行绑定进行中或 IME 内部强杀。API 35 的旧通用 nested 未决租约仍保留。

已核验的公开提交 `14f6854` 对应本地 `1b3ad37`，[托管 CI](https://github.com/williamwue/appvanta/actions/runs/36602005805) 四个任务均通过。该结果不代表后续提交；以下早期失败、工具数与测试数均属于历史记录。公开快照不包含本地历史提交及忽略的设备证据，正式版本发行、跨版本迁移和真机/OEM 验收仍未完成。

## 本轮已完成的范围

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
- 集成修订 `32f9d56` 的录屏传输修复已独立复核，全部包构建及 `npm test` 通过；集成修订 `de1541a` 的不可变准备读取/原始字节摘要边界通过全部包构建及完整 core 52 项测试。租约守卫 `f8d7492` 经独立复核未发现问题（42 项聚焦回归），已在 `8825da3` 集成并保留已复核的录屏实现；该集成修订的 `npm run build` 和 `npm test` 均通过。严格裁决租约快照修复 `908a74e` 经独立复核未发现问题，已在 `0b4cff7` 集成；该修订全部包构建及完整 core 74 项测试通过。它严格接受有效版本 1/2 租约及精确的可选 `processToken`、`cleanupRequired` 字段，记录/准备/读取测试覆盖真实子进程退出后遗留的版本 2 租约，并维持 `resumeAuthorized: false`。可运行的受保护检查点与后继任务续跑仍未完成。各次数量绑定其修订，不推算最新统一全套测试数。公开仓库 <https://github.com/williamwue/appvanta> 已发布实验性源码快照：`main` 的初始提交 [`93749a0`](https://github.com/williamwue/appvanta/commit/93749a0cb87937149376aaac16adf8d199660acb) 为无父提交，其树 `03a5fb1` 与本地集成修订 `fda6c8b` 的树完全一致；主页描述、topics 与私密漏洞报告入口已设置。本地历史提交编号和上述 `.appvanta/` 忽略的设备证据并未随快照公开，托管 CI 与真机/OEM 验收仍未完成。对应 [GitHub Actions 运行](https://github.com/williamwue/appvanta/actions/runs/36435782854) 已以失败结束：Windows/macOS 遇到路径别名运行时/测试问题，Ubuntu 的 release-package `doctor` 因 ADB 不可用报 `spawn adb ENOENT`，Android job 缺少 `sdkmanager`。修复仅在本地准备，托管重跑尚无结果，不能计为托管通过。2026-09-26 的 77 项（core 31、Android 28、脚本 18）和 `.appvanta/wrapup-build.log`、`.appvanta/wrapup-tests.log` 是当时的历史快照。

## P0：下一轮先处理

- [ ] P0-01：定位 API 37 历史异常退出根因；API 35 r9 安装及 AVD boot 已通过，不据此勾选整项。
- [ ] P0-02：实测片段之间的精确媒体时间间隙、设备拔插/超时失败路径；双 API 长时动态分段、严格解码及采样时钟边界已通过，传输失败/取消/空或缺失文件已保守失败并保留可用设备证据，但不据此勾选整项。
- [ ] P0-03：补更多环境夹具、运行绑定中断及 IME 内部强杀的恢复验收。CLI/MCP 裁决、再次崩溃、Markor ASCII/Unicode 实际写入后避免重放，以及连续三次未绑定转移已有 API 37 证据。准备记录本身仍不授权执行，缺少证据或通用 nested 未决租约不能自动释放。详见 adjudication-cli.md。
- [ ] P0-04：补设备端传输、USB 拔插及更多采集组合故障验收。API 37 已验证恢复期间取消、代理恢复的重复 TCP 断连与期限耗尽，以及录屏／Perfetto 文件拉取 DATA 帧中断后保留证据、同 token 重连恢复。TCP 验收针对主机 ADB 客户端到服务端链路，不代表设备端传输或 USB 拔插；危险或不确定清理仍保留租约。详见 network-capture.md。
- [ ] P0-05：整合本轮文档和功能提交后复核状态一致性；文档更新本身不使该项完成。

## P1：Android 能力与验收

- [ ] OCR 与外部 Agent 视觉判断接入，图像模板跨 DPI/主题验证。
- [ ] 探索式执行及快速/计划两种 Agent 工作流的端到端验收；Planner/Checker 继续由客户端 Agent 承担，不内置强制模型 API。
- [ ] 附件分享、系统选择器、更多跨应用组合和多语言界面。
- [ ] shake、更完整的设备状态控制及原状态恢复。
- [ ] 更多 Android 构建配置、项目结构及构建失败诊断。
- [ ] AVD 创建、依赖安装、设备授权引导及启动取消的产品化。
- [ ] 更多输入法、复杂编辑器、手势、权限、多用户、首次引导与数据重置场景。
- [ ] 网络 CA 信任、证书固定及不可采集边界；真机连通性和拔插恢复。
- [ ] Perfetto 受控多次采样、更多性能指标及可重复基线；分析进程取消管理。
- [ ] 完整 tombstone、系统 ANR 标签与 OEM 差异验收。
- [ ] Android 真机与至少一个 OEM 环境的完整闭环验收。

## P2：工程化与客户端接入

- [ ] Flow 变量、条件、子流程和组合复用。
- [ ] 手动录制的复杂控件、Canvas、多点、硬件键与真机回放。
- [ ] 异步批次和监控 Worker 崩溃恢复、优先级、网络并发；监控日志/指标采样。
- [ ] 交互式计划修订；续跑 Webhook、自定义 hook 和持久通知投递。
- [ ] 环境比较补输入法、文件内容、AppOps；视觉回归补感知差异、自动对齐和多设备基线。
- [ ] 证据时间线/覆盖层、跨电脑离线导出、通用脱敏与历史引用迁移。
- [ ] Codex、Claude Code、Cursor 产品内安装与真实调用验收，以及 MCP 断连边界。
- [ ] 稳定对外 SDK 与 Python SDK。
- [ ] 覆盖全部执行入口的权限前后状态、执行者与结果审计。

## P3：CI 与开源发布

- [x] 发布实验性源码快照并完成公开项目主页及安全发布准备；公开 `main` 初始提交 [`93749a0`](https://github.com/williamwue/appvanta/commit/93749a0cb87937149376aaac16adf8d199660acb) 的树与本地集成修订 `fda6c8b` 一致，[私密漏洞报告入口](https://github.com/williamwue/appvanta/security/advisories/new)已启用；这不等于完整产品验收或 npm 发布。
- [x] Windows/Linux/macOS 托管构建、测试、干净安装与子进程行为验收。
- [x] 托管 Android Emulator 验收及失败证据上传；CI/Jenkins 文档与实际执行对齐。
- [ ] 各系统从空目录安装 tarball，验证 CLI/doctor/MCP，复验升级、迁移、卸载。
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
