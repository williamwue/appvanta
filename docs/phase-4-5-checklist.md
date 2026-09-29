# 阶段 4 / 5 验收清单

当前状态及去重后的 39 项待办见 [剩余任务清单](remaining-tasks.md)（更新于 2026-09-30）。以下保留逐次验收历史，较早段落的待办可能已被后续证据覆盖。最终目标保持覆盖 Argent / ARTEMIS 的公开可验证功能；本清单不宣称已完成竞品全部能力的逐项盘点。所有在线设备证据目前仅来自模拟器，没有 Android 真机或 OEM 验收。

2026-09-30 当前补充：分支裁决、动态字符串值及强杀续跑见 [Flow 模板](flow-templates.md)、[动态值](flow-values.md)、[裁决验收](adjudication-cli.md)；模拟器 shake 及恢复见 [传感器](emulator-sensors.md)，SSIM/有限平移见 [视觉对齐](visual-alignment.md)。这些链接说明已实现范围及未验收边界，下列早期条目保留其当时状态。

2026-09-28 更新：API 35 SDK r9 安装和 AVD boot 通过（本机忽略文件 `.appvanta/programs/appvanta-completion-g1/pilot-report.md`）；API 35 动态分段录屏媒体时长 195.470956 秒，API 37 为 199.342833 秒，严格解码通过（本机忽略文件 `.appvanta/worktrees/recording-g4/.appvanta/runs/segmented-recording-1790589670607/verification.json`、`.appvanta/worktrees/recording-g4/.appvanta/runs/video-content-1790589875060/verification.json`、`.appvanta/programs/appvanta-completion-g1/p0-01b-dynamic-report.md`、`.appvanta/worktrees/baseline-g3/.appvanta/runs/segmented-recording-1790591433876/verification.json`、`.appvanta/worktrees/baseline-g3/.appvanta/runs/video-content-1790591638420/verification.json`）。这些验证检查主机侧衔接与片段解码，不测量精确媒体间隙；2026-09-26 API 37 历史退出根因仍未知。旧失败运行 `segmented-recording-1790429923211` 已恢复残留采集，但旧 MP4 截断，证据为 `.appvanta/programs/appvanta-completion-g1/p0-02b-reuse-report.md`。

状态：待完善表示有部分代码；待验收表示缺少足够实测；通过仅针对列出的验证范围。

## 阶段 4：Android 能力

- [x] Markor：在当前 API 37 模拟器上验证 ASCII 唯一标记、保存文件和预览内容，连续两次通过。
  - 运行：`2026-09-16T03-05-19-029Z-emulator-5554`、`2026-09-16T03-07-32-923Z-emulator-5554`。初始系统 ANR 会令检查失败，不会跳过检查；Unicode 与环境自动准备是独立未完成项。
- [ ] 输入：Unicode、中文、多行、特殊字符与输入法差异。
  - 独立实现 AppVanta 测试输入法；当前 API 37 / Gboard 环境 Markor 中文、emoji、多行、字面 `%s` 和特殊字符保存原文件验证通过：`2026-09-16T04-10-35-391Z-emulator-5554-d69e8f78`。定位失败和取消后的输入法恢复通过：`input-cleanup-1789531896310/verification.json`。其他输入法、真机和特殊编辑器待验收，见 [输入](input.md)。
- [x] Android 条件等待：文本/目标出现与消失、UI 树变化、应用进程存在；等待期限传递到 ADB，失败后保存证据。
  - 动态文字出现/消失、UI 树变化和 250ms 超时（实测 255ms）通过：`ui-wait-1789531085645/verification.json`。`screen-stable` 已通过 API 37 静态 Settings 连续截图成功、稳定窗口不足时超时、失败截图与后续动作阻止：`screen-stability-1790425623085/verification.json`。像素容差、动态区域屏蔽及更多设备待完成；采样不证明两次截图之间完全无变化。
- [x] Android UI：结构化层级、节点属性、重名消歧、精确/包含匹配。
  - CLI/MCP 结构化候选实测：`ui-surfaces-1789531150888079000/verification.json`；Markor 文件及预览回归：`2026-09-16T03-52-19-482Z-emulator-5554-913a9f76`。路径基于当前 UI 快照，可见性不代表像素遮挡判断。见 [UI 定位](ui-locators.md)。
  - 新增 `image-template` Target，支持精确或逐通道容差 RGBA PNG 匹配、1–5 个显式缩放比例、occurrence 消歧并将模板哈希副本保存到 artifacts；纯算法与 MCP Schema 测试通过。API 37 同 DPI 模板点击、页面检查点、返回可见性、模板副本与缺失失败通过：`visual-locator-1790426158643/verification.json`。跨 DPI/主题、OCR 和 VLM 待完成，见 [视觉定位](visual-locators.md)。
- [ ] Android 扩展动作：长按、硬件按钮、方向与复杂手势。
  - 长按、四方向锁定、Home/Back/Power/音量/App Switch/Menu/Enter/D-pad、Unicode 剪贴板写入/语义目标粘贴，以及 pinch、双指旋转和 2–10 触点自定义轨迹已进入 core/MCP Schema 和 Android 实现。多点动作使用自建 Accessibility helper 的真正并发 Stroke；API 37 模拟器三类多点动作均记录同时 2 个触点：`gestures-1790109551260/verification.json`。方向、长按、硬件按钮、音量/Mute 和 Unicode 粘贴在线验证通过：`android-actions-1790111761966/verification.json`；真机仍待验收，见 [Android 动作](android-actions.md)。
- [ ] 探索：观察、选择动作、检查、失败重新观察与有限恢复。
- [x] 跨应用：Settings → Markor 信息收集、剪贴板粘贴与实际文件验证，含六步 UI 检查点。
  - 原生 share-text 已进入统一 Action/Flow/MCP；API 37 Markor 接收并保存中文、多行和特殊字符、目标包不存在时失败及后续动作阻止通过：`text-share-1790427425340/verification.json`。附件、选择器及其他接收应用仍待完成。
  - API 37 早期证据：`cross-app-1790426853507/verification.json`，唯一标记及源文字保存一次，临时存储权限恢复。该次通过范围仅此应用组合；后续原生文本分享已有上条证据，附件分享、系统选择器、更多组合/语言与真机待完成，见 [跨应用流程](cross-app.md)。
- [x] 网络：MCP 与 CLI 共用请求级会话。
  - MCP HTTPS 成功、断言失败、端口占用及异步取消后代理恢复已实测，见网络文档及 `flow-integration-1789528791892/verification.json`。
- [ ] 网络可靠性：同设备互斥、中断/断线恢复与代理原值校验。
  - 宿主及网络 Worker 均强杀后的显式接管已在 API 37 验证，代理原值、代理进程退出及设备租约释放通过：`network-capture-recovery-1790428729832/verification.json`。
  - CLI/MCP 已在同一设备锁内执行 Flow 和网络清理，跨进程冲突与网络取消恢复已回归；独立网络 worker 检测宿主管道关闭后恢复代理，强制终止宿主及同端口正常停止实测通过：`network-owner-exit-1789539169298`，MCP 取消回归 `protocol-cancel-1789539191662` 通过。此阶段 worker 同时终止和遗留锁恢复待验；后续 API 37 宿主与网络 Worker 均强杀后的显式接管、代理原值和租约释放已通过：`network-capture-recovery-1790428729832/verification.json`。真机断线及复杂故障组合仍待验收。
- [ ] 网络范围：应用 CA 信任、真机连通性与不可采集情形。
  - 网络恢复补充 60 秒 ADB 重试及逐次记录；模拟断线/期限测试通过，真实代理外部修改拒绝覆盖通过：`network-owner-exit-1789539353836`。实际模拟器重启断线恢复通过：`network-reconnect-1789539588722`，12 次错误后第 13 次恢复原值并退出代理；真机拔插和超过恢复期限仍待验收。
- [ ] Perfetto：解析 trace、指标、步骤关联与报告。
  - 官方 Trace Processor 已接入 CLI/MCP，输出调度 CPU 指标、线程明细、SQL/哈希和报告；真实 trace、失败拒绝及基线门禁通过：`perfetto-check-1789534742437/verification.json`。设备 trace 标记步骤关联、三类运行及标记异常拒绝通过：`trace-steps-check-1789535489098/verification.json`。受控采样和其他设备权限待验收，见 [Perfetto 分析](perfetto-analysis.md)。
- [ ] 录屏：Flow 生命周期、长时间采集、异常回收。
  - Flow/MCP 已支持最高 3600 秒预算和 5–180 秒分段，原子清单保存各段时间与相对路径，明确非无缝。API 37 四段动态视频完整解码通过：`segmented-recording-1790429687393/verification.json`；成功/取消/预算耗尽通过：`segmented-flow-1790429629050/verification.json`。2026-09-26 的 190 秒场景因模拟器退出失败；后续双 API 长时动态分段与严格解码已通过，精确媒体间隙、拔插和历史退出根因仍待验收，见本文件顶部更新。
  - API 37 持续滚动 Settings 的 22 秒主动结束录屏通过：实际 22.391233 秒/245 帧，最大帧间隔 0.565089 秒，完整解码通过：`dynamic-recording-1790429080866/verification.json`。这是短时历史验收；长录屏分段的后续证据见本文件顶部更新。
  - API 37 宿主强杀后录屏/Perfetto 接管、残留产物与日志保留通过：`network-capture-recovery-1790428729832/verification.json`。该恢复样本文件内容有效性未验证；后续长录屏已在双 API 模拟器通过，真实断线仍待完成。
  - 采集使用独立 PID、UUID 路径与退出状态；取消后独立清理、按进程归属回收已在模拟器验证：`capture-cancel-1789534936808/verification.json`。Flow 自动启停、成功/失败/取消后保存和提前结束检测已实测：`flow-capture-check-1789535241873/verification.json`；宿主强制终止后恢复已有上述有界实测，真实断线及复杂故障组合仍待完成，见 [采集回收](capture-lifecycle.md)。
  - 请求 22 秒录屏/Perfetto 的进程运行、拉取和清理已验证。完整视频解码补验发现旧 MP4 实际仅 2 帧、6.674644 秒；强杀恢复 MP4 可解码，截断文件被拒绝：`video-content-1790428881068/verification.json`。恢复 trace 的 2333ms 片段可分析，仍不证明连续画面覆盖或完整采集时长。
- [ ] 崩溃/ANR：应用和时间过滤、结构化堆栈、故障注入验收。
  - events 事件计数、包名/时间过滤、Java 堆栈关联与原文保留已实现；真实 Java 故障注入通过：`diagnostics-check-1789533445732/verification.json`。Flow 自动诊断、崩溃失败门禁、旧事件排除及取消后收集已实测：`flow-diagnostics-check-1789535735733/verification.json`；ANR 真实输入超时注入及 DropBox 主线程阻塞栈实测通过：`anr-check-1789536019379/verification.json`；Native SIGABRT 注入及日志回溯通过：`native-crash-check-1789536245389/verification.json`；完整 tombstone、系统应用 ANR 标签与真机待验收，见 [运行诊断](runtime-diagnostics.md)。
- [ ] Android 真机验收；现有模拟器证据不能替代真机。

请求级 HTTP/HTTPS 和 CLI Flow 成功/失败/端口占用的已有实测见 [网络文档](network-capture.md)。不等于上述网络完整范围完成。

## 阶段 5：工程化

- [x] 统一 Flow：CLI、MCP 同步/异步共享执行、检查点、显式有限恢复与证据。
  - 已共用 core 执行器、参数解析、检查点、重新观察与报告。有限恢复增加新鲜观察守卫、1–3 次上限、原检查点复验与 recovery.jsonl，不自动重放原动作。恢复实测与边界见 [Flow 恢复](flow-recovery.md)；断点续跑独立待办。
- [x] Schema：版本、运行时校验、动作/定位器参数和非法值处理。
  - 版本 1 运行时解析已统一，拒绝未知字段、空流程、非法数字/动作/目标；工具公开 JSON Schema 已包含动作、定位器、条件、Flow、恢复与网络配置，并用于设备锁前校验。代表性 Schema/核心解析一致性与非法调用子进程测试通过，详见 [MCP 参数契约](mcp-schemas.md)。
- [ ] 录制回放：实际动作、目标、参数、检查点，回放验收。
  - Flow 实际调用日志、完整性校验、CLI/MCP 回放文件生成已实现；Markor 原 3 步到 6 步 MCP 回放通过：`recording-check-1789532481491/verification.json`。外部手动操作录制实现与待验收边界见下一项及 [Flow 录制](flow-recording.md)。
  - 自研 Accessibility helper 已支持白名单包的外部人工点击、长按、滚动和显式开启的追加文本录制；CLI 定时会话、MCP 跨请求 start/stop、服务重建恢复、原始事件、会话状态和 Flow 编译已实现。API 37 模拟器已验证 MCP 开始后退出、新 MCP 停止、Settings 语义点击和回放：`manual-recording-check-1790110374558/verification.json`；真机和复杂控件待完成，见 [手动交互录制](manual-interaction-recording.md)。
  - CLI 已支持 JSON/YAML Flow，YAML 在锁前解析后进入相同 core Schema；`echo` 只写步骤输出，不执行 shell/ADB。格式等价、重复 key 和 Schema 一致性自动测试通过，变量/条件组合语言待办，见 [Flow 文件](flow-files.md)。
- [ ] 调度：多设备完整 Flow、设备锁、并发上限、独立证据、汇总。
  - 新增 CLI `run-flows` / MCP `run_flows`，双模拟器完整 Flow、混合离线失败、重复设备拒绝、CLI/MCP 互斥均实测。证据：`scheduler-check-1789529856398/verification.json`。网络批次暂限并发 1，异步批次/恢复仍待完善，见 [设备调度](device-scheduling.md)。
  - MCP `start_flows` 已把持久异步批次转交独立本地 Worker，原子转移所有权并校验 ready 证据；MCP 退出后继续执行，跨进程 get/list/cancel 和每设备独立结果保留，CLI 提供只读/取消入口。API 37 模拟器已验证父 MCP 退出后通过和新 MCP 取消：`worker-restart-check-1790109477881/verification.json`；Worker 崩溃后的安全续跑、优先级和远端 worker 队列待完成。
- [ ] 任务：实际取消子进程、状态持久化、安全恢复。
  - 租约转移前取消已支持安全重新认领：守卫内核对取消记录/原租约/旧 Worker 退出/无后继任务，归档旧认领后重新验证源进度。API 37 取消后重试、已完成动作不重放通过：`startup-cancel-1790428441053/verification.json`。后继任务创建后的重试仍不支持。
  - Android 续跑增加准备阶段标记；API 37 实际清理和租约转移后立即强杀、前任绑定核验、显式恢复释放通过：`startup-cancel-1790428142783/verification.json`。无标记/来源不符/损坏意图拒绝测试通过。历史未标记租约仍需人工核对；此阶段取消后的安全重新认领待验，后续 API 37 有界重认领已通过：`startup-cancel-1790428441053/verification.json`。后继任务创建后的重试仍待完成。
  - 续跑 ready 已推迟至运行绑定及 Flow 初始化后，MCP 核对 Worker/运行绑定；API 37 检查绑定、Flow/进度证据、跨进程取消及租约恢复通过：`task-continuation-1790427807882/verification.json`。此阶段转移到绑定之间的中断窗口待验；后续准备阶段标记下的转移后、绑定意图前强杀与显式恢复已通过：`startup-cancel-1790428142783/verification.json`。无标记历史租约仍不能自动释放。
  - API 37 认领后的启动取消已实测：清理后、租约转移前检查取消，保留原始绑定租约、不创建后继任务，显式恢复释放通过：`startup-cancel-1790427732889/verification.json`。此阶段转移后中断和取消后重新认领待验；后续准备阶段恢复与取消后有界重认领分别通过：`startup-cancel-1790428142783/verification.json`、`startup-cancel-1790428441053/verification.json`。后继任务创建后的重试仍待完成。
  - MCP 续跑启动取消已通过持久 cancel.requested 传递给独立 Worker，接管前及 ready 前检查，清理保持完整；预取消、运行中监听和真实子进程预取消测试通过。此阶段恢复途中设备验收、取消后认领处理待验；后续 API 37 清理后、租约转移前取消及有界重认领分别通过：`startup-cancel-1790427732889/verification.json`、`startup-cancel-1790428441053/verification.json`。带网络/采集夹具的恢复途中取消仍待完成。
  - 新增 Android 绑定意图持久化，统一恢复命令支持绑定失败且尚未执行 Flow 的遗留租约；真实子进程故障测试通过，出现执行证据或意图不匹配时保锁。此阶段无绑定意图的更早中断待验；后续带准备阶段标记的转移后、绑定意图前强杀与显式恢复通过：`startup-cancel-1790428142783/verification.json`。历史无标记租约仍需人工核对。
  - API 37 续跑 Worker 在检查点 executing 阶段再次强杀后，interrupted、无完成通知、拒绝不确定动作续跑与已绑定租约恢复通过：`task-continuation-1790425372574/verification.json`。此阶段未绑定租约恢复待验；后续带准备标记的转移后、绑定意图前强杀与显式恢复通过：`startup-cancel-1790428142783/verification.json`。不确定动作的人工裁决和安全续跑仍待完成。
  - 后台续跑在启动 MCP 退出后，通过独立 CLI 取消正在执行的检查点、保存 cancelled、本地完成通知及恢复遗留租约已通过：`task-continuation-1790425095555/verification.json`。此阶段恢复启动取消和 Worker 再次崩溃待验；后续 API 37 租约转移前启动取消及检查点 executing 阶段再次强杀的中断拒绝分别通过：`startup-cancel-1790427732889/verification.json`、`task-continuation-1790425372574/verification.json`。续跑 Webhook 与不确定动作裁决仍待完成。
  - `start_task_continuation` 独立 Worker 续跑已实现持久请求与归属核验；API 37 已验证启动 MCP 退出后正常完成和检查点失败阻止剩余动作：`task-continuation-1790424951486/verification.json`。此阶段后台取消、再次崩溃及通知待验；后续后台取消和 cancelled 通知通过 `task-continuation-1790425095555/verification.json`，passed/failed 通知通过 `task-continuation-1790425128249/verification.json`，检查点 executing 阶段再次强杀后拒绝不确定续跑通过 `task-continuation-1790425372574/verification.json`。不确定动作裁决仍待完成。
  - 显式 CLI `continue-task` 已接通原任务/设备租约核对、资源恢复、独占认领、新旧运行关联、恢复检查点及剩余步骤执行。API 37 强杀后正常续跑与检查点失败阻止后续动作、失败租约清理及重复请求拒绝通过：`task-continuation-1790424592858/verification.json`。此阶段 MCP/独立 Worker 和接管途中再次强杀待验；后续 MCP 与独立 Worker 有界续跑分别通过 `task-continuation-1790424780000/verification.json`、`task-continuation-1790424951486/verification.json`，执行中再次强杀的拒绝与准备阶段恢复分别通过 `task-continuation-1790425372574/verification.json`、`startup-cancel-1790428142783/verification.json`。业务文件状态、不确定动作裁决和完整断点恢复仍待验收。
  - 持续监控已转交独立本地 Worker，提供 MCP 后台定时截图/UI 树采样、持久状态、跨进程查询/显式释放、owner 退出检测和 CLI 管理入口；MCP 退出后继续运行，每次采样独立获取设备锁。API 37 模拟器已验证父 MCP 退出后完成和新 MCP 释放：`worker-restart-check-1790109477881/verification.json`；Worker 崩溃续跑、日志/指标采样和远端持久队列待办，见 [持续设备监控](continuous-monitoring.md)。
  - 运行中指令已提供 MCP `steer_task` / `list_task_instructions`，使用完整 Flow step Schema，跨进程持久化 queued/claimed/applied/failed 状态，并在步骤边界进入同一证据链。MCP/CLI `pause_task` / `resume_task` 使用持久请求，只在步骤边界确认暂停，控制历史可审计且取消优先；离线队列与执行器测试已覆盖。API 37 已验证跨 MCP 暂停、排队、恢复执行及暂停期间取消（`task-controls-1790423029156/verification.json`）；ADB 间歇超时、真机及 owner 中断后的人工处置待完善，见 [运行中任务指令](task-steering.md)。
  - 异步任务完成后始终保存本地 `task.completed` 事件；`start_flow` 可选 Webhook 只允许环境变量显式列出的 origin，禁止凭据/query/fragment并拒绝重定向。事件先落盘，再执行可审计的三次有界重试；稳定事件 ID、可选 HMAC-SHA256 签名及业务/投递状态隔离已有自动测试。跨服务持久队列和企业适配器待办，见 [任务完成通知](task-notifications.md)。
  - CLI/MCP `recover-flow` 已协调采集、网络和四类夹具，验证运行/租约/设备并保留逐次恢复审计；文件、AppOps、输入法三类真实 Flow 终止、冲突保锁与重试通过：`flow-recovery-check-1789540714846`；运行时权限后续 API 37 强杀、冲突拒绝与重试恢复通过：`permission-recovery-1790422735746`。采集在副作用前持久化 UUID/PID 控制坐标，网络持久化代理及进程归属，并在接管时拒绝外部修改或无法验证的 PID；无设备自动测试通过。此阶段网络/采集的宿主与 worker 同时强杀待验；后续 API 37 Flow 宿主与网络 Worker 强杀、录屏/Perfetto 接管、产物及日志保留、代理恢复和租约释放通过：`network-capture-recovery-1790428729832/verification.json`。真实断线和复杂故障组合仍待验收；恢复不重放动作或标记业务通过。
  - Android Flow 开始设备修改前绑定租约与运行目录，保存 `device-lease.json`；子进程终止后关联保留测试通过，MCP 取消回归 `protocol-cancel-1789539915198` 通过。这是早期绑定证据；后续统一恢复协调器已覆盖有界夹具及租约恢复，历史无意图/准备标记的未绑定租约仍须人工核对，见[任务持久化](task-persistence.md)。
  - 增加只读 `device-lock` 查询和 core 遗留锁恢复互斥原语；真实子进程终止测试覆盖 token/存活检查、失败保锁、成功释放和并发拒绝。恢复守卫已支持同主机/同 token/死 PID 的原子接管，并覆盖清理完成后仅遗留守卫的安全移除；真实设备恢复途中再次强杀仍待验收，见 [设备锁恢复](device-lock-recovery.md)。
  - MCP `start_flow` 已把执行转交独立本地 Worker，并在所有权原子转移和 `worker.ready.json` 后才返回；MCP 退出后 Worker 继续运行，跨进程查询/暂停/注入/取消仍通过持久文件协调。API 37 模拟器已验证父 MCP 退出后通过和新 MCP 取消：`worker-restart-check-1790109477881/verification.json`；暂停/指令已完成 API 37 单次在线验收；Worker 自身崩溃后的安全断点续跑和远端 Worker 待完成。见 [任务持久化](task-persistence.md)。
- [ ] 夹具：首次引导、权限、输入法、测试数据、清理。
  - `resetApplications` 已提供显式首次启动前置条件：环境采集后逐包验证安装、持久化不可恢复记录、执行 `pm clear` 并审计结果；不会在恢复阶段危险地重放清理。自动 Schema/Flow 测试通过；API 37 / Markor 2.16.1 已验证专属目录标记删除、引导页控件出现及审计（`2026-09-26T11-45-50-944Z-emulator-5554-1729e2b8/app-data-reset-verification.json`），真机及更多应用待验收，见 [首次启动与应用数据重置](first-launch-reset.md)。
  - 运行时权限夹具已进入 Flow/core/MCP，按 Android 用户保存授权与权限标志，支持成功、失败、取消和遗留运行恢复；恢复前检查设备、用户和外部改值，原始状态进入环境比较。API 37 已通过成功/失败/取消后的原值恢复（`permission-fixture-check-1790422683562`）及强杀、冲突拒绝、重试恢复（`permission-recovery-1790422735746`）。已修复不支持的权限查询命令及系统管理标志恢复问题；真机、其他系统及多用户验收待完成，见 [运行时权限夹具](runtime-permissions.md)。
  - 文件版本 2 记录支持跨进程恢复；二进制原内容、新文件删除、外部内容冲突与重复恢复实测通过：`file-recovery-1789540473210`，正常四路径回归 `file-fixtures-check-1789540516697` 通过。非原值/准备值的中断文件会保留待处理，已接入统一恢复协调器。
  - AppOps 版本 2 记录支持跨进程恢复及逐项审计；真实进程终止、外部改值拒绝、重试通过：`appops-recovery-1789540302950`，正常五路径回归 `appops-fixture-check-1789540304790` 通过，已接入统一恢复协调器。
  - 输入法版本 2 记录已支持跨进程恢复；真实终止、外部启用列表冲突拒绝、重试和错误设备拒绝通过：`ime-recovery-1789540159086`；正常四路径回归 `ime-fixture-check-1789540093406` 通过，已接入统一恢复协调器。
  - Flow 共享存储文本文件准备、原内容备份恢复、新文件删除及准备部分失败回滚已实测：`file-fixtures-check-1789536840591/verification.json`；覆盖成功/失败/取消。Flow 输入法选择及原默认项/启用列表恢复四路径通过：`ime-fixture-check-1789537789059/verification.json`；包级 AppOps allow/default 恢复、失败/取消/部分回滚及审计已实测：`appops-fixture-check-1789538126378/verification.json`；首次引导及断线恢复待完成，见 [文件夹具](file-fixtures.md)。
- [ ] 回归：完整运行及逐步骤比较，缺失/重排检测与失败 CI 门禁。
  - CLI 与 screen-stable 已接入矩形遮罩和通道/比例容差；稳定窗口固定基准避免累计漂移的测试通过，API 37 顶部遮罩与超时路径通过：`screen-stability-1790425995681/verification.json`。感知差异、自动对齐和更多设备仍待完成。
  - core/MCP 截图比较新增显式 ignoreRegions 矩形遮罩，保留遮罩证据并从统计分母排除，重叠去重、整图屏蔽拒绝及遮罩外变化测试通过。CLI/稳定等待接入和真实设备遮罩验收待完成。
  - 新增 CLI `visual-diff` / MCP `compare_screenshots`，输出逐像素 RGBA 指标、差异比例、边界框和红色 diff PNG，并按阈值失败；离线自动测试通过。真实设备截图基线、动态区域遮罩及字体/抗锯齿感知仍待完成，见 [截图视觉差异](visual-diff.md)。
  - 默认已检查运行状态/时间、设备型号/系统、Flow 定义、实际操作序列、证据哈希和报告一致性；旧步骤比较需显式选择。两次 Markor 实测及 CLI 失败门禁通过：`comparison-check-1789533144196/verification.json`。已纳入 base/split APK SHA-256、Node/ADB、实际执行 JS 指纹及声明的运行时权限原值；真实比较及环境差异拒绝通过：`comparison-check-1789536521857/verification.json`。输入法、文件内容和 AppOps 等环境状态仍待纳入，见 [运行比较](run-comparison.md)。
- [ ] 性能基线：指标单位、版本、采样条件及阈值。
  - 版本 2 已校验单位、设备/系统/场景、采集器版本、采样窗口/次数/预热/聚合方式及上下限；核心及 CLI 子进程测试通过。版本 1 显式提示缺少条件校验。Android 内存快照已生成版本 2 测量并完成 CLI/MCP 采集与门禁实测：`performance-check-1789532958919/verification.json`。Perfetto 调度 CPU 指标及基线门禁已实测；多次受控采样仍待完成，见 [性能基线](performance-baselines.md)。
- [ ] 可移植导出：相对引用、完整性清单、哈希，导出后独立打开。
  - 已生成无网络/服务依赖的 HTML 索引和 JSON/JSONL 相对引用查看页，原文件保持不变；新增 CLI `verify-export`。来源删除、迁移及篡改拒绝测试通过；真实导出迁移后哈希与 54 个链接通过：`portable-check-1789538723967/verification.json`。Windows Edge 离线首页已检查；跨电脑/宿主验收待完成，见 [可移植导出](portable-evidence.md)。
- [x] 归档：CI 与 CLI 统一筛选，排除 PEM 私钥/工具目录/外部链接。
  - 已共用 core 归档器并通过 CLI/CI 一致性、链接绕过拒绝及拒绝覆盖测试。Markor 75 个文件导出后逐个校验哈希：`export-check-1789531541854/verification.json`。通用脱敏及历史绝对引用迁移不在本项验收范围。
  - 本地实际归档 872 个文件，排除 9 项（含 3 个历史 CA 目录），见 `.appvanta/ci-evidence-20260916-review/manifest.json`。
- [ ] 权限审计：执行者、动作、权限前后状态、结果，覆盖所有入口。
  - Flow 运行时权限/AppOps 夹具和 CLI/MCP 直接 AppOps 修改均已记录入口进程、目标、前后状态与结果；直接修改会读回验证，失败也保留原值。当前 actor 仍是本地进程而非认证用户，企业级防篡改/集中审计及未来入口仍待完成，见 [权限审计](permission-audit.md)。
- [ ] MCP：协议错误、参数校验及 Codex/Claude Code/Cursor 客户端验收。
  - 进度检查 `inspect_task_progress` 和同步续跑 `continue_task` 已接入，严格检查点 Schema 与 API 37 成功/检查点失败路径通过：`task-continuation-1790424780000/verification.json`。此阶段独立 Worker 续跑和请求取消待验；后续 API 37 独立 Worker 完成/失败与后台取消通过：`task-continuation-1790424951486/verification.json`、`task-continuation-1790425095555/verification.json`，启动取消通过：`startup-cancel-1790427732889/verification.json`。三款 Agent 产品内验收仍待完成。
  - 已增加三款客户端的项目级 stdio 配置模板、绝对入口路径和 `APPVANTA_PROJECT_ROOT` 证据目录绑定；自动测试验证 server 从其他 cwd 启动时仍写入指定项目。产品内四步验收尚未执行，见 [Agent 客户端接入](agent-client-setup.md)。
  - 新增 `inspect_device_lock` 与 `recover_flow`，共享 CLI 夹具恢复逻辑；严格 token/参数校验及真实 MCP 进程重启后恢复实测通过：`flow-recovery-check-1789540866401`。仍不代表产品内接入验收完成。
  - 初始化握手、版本协商、ping、通知、请求 ID 与错误分类已实现并通过协议/stdio 测试；设备工具和跨进程任务回归通过。协议取消、长请求并发和代理恢复已实测（`protocol-cancel-1789534161885`）；断连策略及三个产品内接入待完成，见 [MCP 协议](mcp-protocol.md)。
- [ ] 模拟器 CI：自动启动、安装测试 App、Flow 验收、失败证据。
  - GitHub Actions 已配置独立 API 35 模拟器 job，固定下载 Markor 2.16.1 并校验 SHA-256，安装后运行不依赖首次引导状态的进程/UI 证据 Flow；公开空仓库已建立但源码尚未推送，没有托管执行结果，因此仍为待验收。
- [ ] 自动测试：Flow、MCP、调度、取消、恢复、网络清理异常。
  - 网络总结覆盖损坏/缺失日志、停止超时/异常并保存恢复结果；Python 故障测试和真实损坏日志注入通过：`network-owner-exit-1789539495272`。真实断线与整体恢复仍未完成。
  - 已有 core Flow、调度并发/取消/错误隔离、同进程/跨进程锁测试及模拟器 CLI/MCP 验证器；恢复覆盖仍缺失。
- [ ] 干净构建：无旧 dist 的安装、构建、测试；跨宿主环境验收。
  - Windows 独立目录无 dist/node_modules 的 `npm ci`、`npm run build`、`npm test` 已通过；GitHub Actions 已配置 Windows/Linux/macOS 矩阵及 Python 恢复测试，但尚无托管执行结果。
- [ ] 文档/帮助：README、能力矩阵、命令、CI 与真实状态一致。
  - AVD 启动增加显式 GPU 模式及 CLI/MCP 校验，拒绝向已运行实例静默应用新模式；API 37 SwiftShader 启动和实际 GLES/Vulkan 后端已核验。2026-09-26 该后端长录屏退出，API 35 镜像首次安装因 ZIP 读取错误失败；后续 API 35 r9 安装、AVD boot 及双 API 长时分段验证已通过，但历史 API 37 退出根因仍未知，见本文件顶部更新。
  - 显式 CLI start-avd / MCP start_avd 已支持命名 AVD 启动、实例复用、设备锁、启动日志和身份/boot_completed 检查；Windows API 37 真实重启与复用通过：`avd-start-1790426543011/verification.json`。创建/依赖安装、超时取消及跨系统仍待完成。
  - 新增 CLI list-avds / MCP list_avds 与 doctor AVD 清单检查，支持 SDK/显式 emulator 路径；早期本机发现两个配置且一台设备在线，自动路径/空列表/异常测试通过。命名 AVD 启动/复用随后实现并验证；产品化 AVD 创建、依赖安装仍待完成。
  - `doctor` 已提供版本化 `ready/degraded/blocked` 结论，检查 Node、ADB、设备、SDK、Python、Java 和工作目录；`--fix` 仅创建运行目录并启动 ADB server，自动测试覆盖三类结论。命名 AVD 启动另有独立 CLI/MCP 入口；AVD 创建、依赖安装及设备授权仍待完成，见 [环境诊断](doctor.md)。

## 最后阶段（阶段 6）

iOS Simulator/真机、React Native、Electron/Chromium、TV、HarmonyOS、远程设备、企业私有化、云设备池、并发配额、可选 Web 管理界面。

## 最终覆盖验收

固定参考产品版本/日期，逐项记录平台、依赖、支持边界、实现位置与测试证据。补齐未盘点的差异；完成许可证/第三方归属、安装升级与开源发布准备。基础功能通过不自动等于参考产品完整能力通过。
