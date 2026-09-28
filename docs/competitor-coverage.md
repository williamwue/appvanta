# ARTEMIS / Argent 逐项覆盖清单

基线版本与证据规则见 [参考产品固定基线](reference-baselines.md)。本表用于确认差距，不以相似名称推断等价能力。2026-09-28：以下 Android 在线证据来自模拟器，没有真机/OEM 验收；当前 P0 状态以[剩余任务清单](remaining-tasks.md)为准。

| 公开能力 | 来源 | AppVanta 状态 | 当前证据或缺口 | 目标 |
|---|---|---|---|---|
| Android 真机与模拟器发现/控制 | 两者 | partial | 模拟器已实测；真机未验收 | 阶段 4 |
| 构建、安装、启动、停止、重启 | 两者 | partial | Android CLI 已实现；构建器和多项目适配仍有限 | 阶段 4/5 |
| 截图、UI/Accessibility 树 | 两者 | verified | 结构化 UI、截图、候选和消歧已有模拟器证据 | 阶段 4 |
| 资源 ID、文本、Accessibility 定位 | 两者 | verified | 精确/包含、作用域和重复项处理已有测试 | 阶段 4 |
| 坐标定位兜底 | 两者 | verified | Android Action 支持坐标 | 阶段 4 |
| OCR/纯视觉目标定位 | 两者 | partial | PNG 模板 Target、显式多尺度/逐通道容差、重复项消歧和证据快照已实现；API 37 同 DPI 模板点击、检查点与缺失失败通过，跨 DPI/主题、OCR 与 VLM 待完成 | 阶段 4 后续 |
| 点击、长按、滑动、文本输入、返回 | 两者 | partial | 长按已进入统一 Schema；基础动作模拟器已验证，新增动作及其他 IME/OEM/真机待验收 | 阶段 4 |
| pinch、rotate、自定义多点手势 | Argent | partial | 独立 Action Schema、轨迹编译和自建 Accessibility gesture helper 已实现；API 37 模拟器确认三类动作均产生两个同时触点，真机待验收 | 阶段 4 |
| Home/Power/音量/App Switch/D-pad 等硬件按钮 | Argent | partial | 严格枚举和 Android KeyEvent 映射已实现；API 37 已验证 Home/Back/Power、音量/Mute、App Switch/Menu/Enter/D-pad，真机待完成 | 阶段 4 |
| 剪贴板与 paste | Argent | partial | Unicode 剪贴板辅助桥、语义聚焦和 Accessibility `ACTION_PASTE` 已在 API 37 Settings 输入框读回验证；真机及不同编辑器待验收 | 阶段 4 |
| 旋转、shake 和设备状态控制 | Argent | partial | 四方向锁定已进入统一 Action；shake 和更完整状态控制缺失，设备验收待完成 | 阶段 4 后续 |
| 运行时权限准备、原值恢复与审计 | 两者 | partial | API 37 已通过权限准备、成功/失败/取消恢复与强杀后冲突保护、重试；真机及多用户待验收 | 阶段 5 |
| 首次启动状态与应用数据重置 | 两者 | partial | API 37 / Markor 已通过专属目录标记清除、引导页出现及审计；真机、更多应用与系统/云端状态边界待验证 | 阶段 5 |
| 元素等待和 UI 变化等待 | Argent | partial | 文本/目标/进程/UI 树变化及连续截图稳定等待已实现；screen-stable API 37 成功/超时及失败证据通过，容差/动态区域屏蔽已验收，更多设备待完成 | 阶段 4 |
| 跨应用端到端任务 | ARTEMIS | partial | API 37 Settings → Markor 剪贴板流程及原生文本分享、文件原文和权限恢复已验收；附件分享、系统选择器、更多组合与真机待完成 | 阶段 4 |
| Observe → Act → Verify 循环 | ARTEMIS | partial | Flow 每步观察和检查已实现；探索动作选择仍由外部 Agent 完成 | 阶段 4 |
| Flash 式快速反应执行 | ARTEMIS | partial | MCP 原子工具与 Flow 可供 Agent 调用；无等价内置模型循环 | 阶段 4/5 |
| Pro 式计划、检查点、Checker、恢复 | ARTEMIS | partial | 检查点、有限恢复、证据报告已有；Planner/Checker 由 MCP 客户端 Agent 承担 | 阶段 4/5 |
| 长时间/连续监控与显式释放 | ARTEMIS | partial | MCP 已有独立 Worker 定时截图/UI 树采样、跨进程查询和显式 release；模拟器已验证 MCP 退出后完成与新 MCP 释放，日志/指标监控、Worker 崩溃续跑和真机待完成 | 阶段 5 |
| 任务状态、取消和历史 | ARTEMIS | partial | Flow、批次和持续监控使用独立本地 Worker，所有权/ready 证据、持久查询、暂停、取消/释放、历史和 interrupted 已实现；模拟器已验证父 MCP 退出后的完成及跨进程取消，Worker 崩溃安全续跑和真机待完成 | 阶段 5 |
| 任务中途注入指令 | ARTEMIS | partial | MCP 已支持持久化结构化步骤队列、跨进程查询、步骤边界领取和结果状态；MCP/CLI pause/resume 在边界生效并保留控制审计。API 37 跨 MCP 暂停、注入、恢复和暂停期间取消已通过；间歇 ADB 超时、真机与交互式计划修订待完成 | 阶段 5 |
| 完成通知、Webhook、自定义 hook | ARTEMIS | partial | 本地完成事件、origin 白名单、稳定幂等 ID、落盘后有界重试和可选 HMAC-SHA256 签名已实现；跨服务持久队列和企业通知适配器待完成 | 阶段 5 |
| 多设备锁与并发执行 | 两者 | partial | 双模拟器 Flow、跨进程锁及独立 Worker 持久异步批次状态/取消已实现；模拟器已验证父 MCP 退出后完成与跨进程取消，Worker 崩溃续跑、远端 worker 和真机待完成 | 阶段 5 |
| 环境 doctor 和安全自修复 | ARTEMIS | partial | 已有分级 verdict、依赖/设备检查和安全 `--fix`；AVD 发现/启动/复用及 GPU 配置已实现；创建、依赖安装及授权处理待完善 | 阶段 5 |
| Logcat、Java Crash、Native Crash、ANR | 两者 | partial | 多类故障已在模拟器验证；完整 tombstone/OEM/真机待完成 | 阶段 4 |
| 请求级网络观察 | Argent | partial | HTTP/HTTPS、恢复和冲突保护已有；真机/证书固定边界待验收 | 阶段 4 |
| 录屏 | Argent | partial | 2026-09-26 的 190 秒 API 37 尝试失败；后续 API 35 195.470956 秒、API 37 199.342833 秒动态分段与严格解码通过（本机证据见[剩余任务清单](remaining-tasks.md)）。精确媒体间隙、拔插、历史退出根因及真机待验收 | 阶段 4 |
| Perfetto 捕获、分析和步骤关联 | Argent | partial | 调度 CPU 和步骤标记已实测；多次采样和更多指标待完成 | 阶段 4/5 |
| 截图视觉差异与基线 | Argent | partial | PNG 像素容差、差异比例门禁、边界框和 diff 图已实现；矩形遮罩已有 API 37 验收；真机基线及感知差异待完成 | 阶段 5 |
| 手动交互录制为 Flow | Argent | partial | 自研 Accessibility helper、包白名单、服务重建恢复、CLI/MCP 会话、原始事件和 Flow 编译已实现；模拟器已验证跨 MCP 停止、语义点击及回放，真机与 Canvas/多点/硬件键边界待验收 | 阶段 5 |
| Flow 脚本、echo 与 YAML | Argent | partial | JSON/YAML Flow 与纯记录 echo 已实现并共用严格 Schema；通用脚本执行刻意不开放，条件/变量/组合语法待设计 | 阶段 5 |
| 运行证据、trace 检查和回放 | 两者 | partial | 截图/UI/日志/视频/报告和离线导出已有；可视化时间线/覆盖层缺失 | 阶段 5 |
| CLI | 两者 | partial | Android 命令已实现；安装、帮助和兼容性仍需发布验收 | 阶段 5 |
| MCP | 两者 | partial | stdio 协议与工具已测试；Codex/Claude Code/Cursor 产品内验收待完成 | 阶段 5 |
| Web 控制台 | ARTEMIS | deferred | 当前明确不建设复杂 Web 管理后台 | 最后阶段 |
| Python SDK | ARTEMIS | missing | 当前是 TypeScript workspace，无稳定 SDK | 发布后续 |
| iOS Simulator/真机 | Argent | deferred | 尚无 Driver | 最后阶段 |
| React Native/Hermes/React DevTools | Argent | deferred | 尚无组件树、JS evaluate、Profiler | 最后阶段 |
| Electron/Chromium、DOM、Cookie、Storage | Argent | deferred | 尚无桌面/Web Driver | 最后阶段 |
| TV/D-pad/遥控器 | Argent | deferred | 尚无 TV Driver | 最后阶段 |
| UIKit/native view 与 NSURLProtocol 工具 | Argent | deferred | 依赖未来 iOS 独立实现 | 最后阶段 |
| Instruments 与 React/native 联合分析 | Argent | deferred | 依赖未来 iOS/RN Driver | 最后阶段 |

只有所有非 deferred 行达到 `verified`，并且 deferred 平台阶段完成后，才能对外声明覆盖固定基线的全部公开功能。
