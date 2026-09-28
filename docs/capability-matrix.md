# ARTEMIS / Argent 能力矩阵

状态定义：`target` 目标能力，`planned` 已排入路线，`verified` 已在 AppVanta 中实测，`out-of-scope` 暂不纳入。

本表是初步功能分类，不是竞品完整功能清单。`partial` 表示基础实现或局部验证，剩余验收见 [阶段 4/5 清单](phase-4-5-checklist.md)。

逐项差距、固定版本和许可证边界见 [竞品覆盖清单](competitor-coverage.md) 与 [参考产品固定基线](reference-baselines.md)。

| 能力 | 来源参考 | AppVanta 状态 | 首次验收阶段 | 验证证据 |
|---|---|---:|---:|---|
| Android 模拟器控制 | ARTEMIS / Argent | verified | 阶段 2 | Markor 模拟器端到端报告 |
| Android 真实设备控制 | ARTEMIS / Argent | target | 阶段 2 | ADB 设备信息、运行报告 |
| iOS 模拟器与设备 | Argent | planned | 阶段 6 | XCTest/XCUIAutomation 运行记录 |
| 应用构建、启动、安装和重启 | ARTEMIS / Argent | verified | 阶段 2 | CLI 生命周期命令与运行报告 |
| 点击、滑动、输入、等待 | ARTEMIS / Argent | partial | 阶段 2/4 | ASCII/Unicode/多行 Markor 文件验证及条件等待已实测；真机和其他输入法待验收 |
| UI 树和组件树观察 | ARTEMIS / Argent | partial | 阶段 2/4/6 | Android 层级、属性、定位消歧及结构化候选已实测；框架组件树留待阶段 6 |
| 语义定位与坐标兜底 | ARTEMIS / Argent | verified | 阶段 2 | locator 单元测试 |
| 跨应用端到端流程 | ARTEMIS | partial | 阶段 4 | 可启动其他应用；真实跨应用业务流程待验收 |
| 自然语言任务编排 | ARTEMIS / Argent | planned | 阶段 3 | MCP 调用和计划记录 |
| 后台异步任务 | ARTEMIS | partial | 阶段 3/5 | 任务状态持久化、跨进程查询/取消已实测；重启恢复与队列待完善 |
| 多设备并行执行 | ARTEMIS / Argent | partial | 阶段 4/5 | 双模拟器 CLI/MCP 完整 Flow、设备锁及独立证据实测；网络并行及持久队列待补齐 |
| 日志与崩溃诊断 | ARTEMIS / Argent | partial | 阶段 2/4 | 应用/时间过滤、Java 堆栈、故障注入与 Flow 自动诊断门禁已实测；ANR 注入和应用线程堆栈已实测；Native 日志回溯已实测；完整 tombstone、系统应用 ANR 和真机待完成 |
| 网络请求观察 | Argent | partial | 阶段 4 | CLI/MCP HTTP/HTTPS、设备互斥与协作取消已实测；断线与强制中断恢复待补齐 |
| 性能追踪与分析 | Argent | partial | 阶段 4 | 内存与 Perfetto 调度 CPU 指标、CLI/MCP 分析和基线门禁已实测；设备 trace 标记步骤关联已实测，受控采样和其他设备权限待验收 |
| 录屏和运行现场保留 | Argent | partial | 阶段 4 | 22 秒 MP4、取消回收、Flow 自动启停及成功/失败/取消/提前结束四路径已实测；长录屏分段与断线恢复待完成 |
| React Native 支持 | Argent | planned | 阶段 6 | 项目构建和运行记录 |
| TV 设备支持 | Argent | planned | 阶段 6 | TV Driver 能力记录 |
| Electron/Chromium 支持 | Argent | planned | 阶段 6 | 桌面/Web 运行记录 |
| 探索式执行后验证 | ARTEMIS | planned | 阶段 3/4 | 观察记录和检查点 |
| MCP 接入 | ARTEMIS / Argent | partial | 阶段 3/5 | 工具已有实现，协议及多客户端集成验收待补齐 |
| 可复现报告和证据包 | AppVanta 增强 | partial | 阶段 1/2/5 | Markdown、步骤比较、CI 筛选、离线 JSON/JSONL 查看页和完整性校验已有实现；本地迁移已实测，跨电脑验收待完成 |

## 阶段 0 结论

当前已有 Android 本地实现，执行阶段 4/5 清单。历史阶段 0 环境检查仅为当时快照；设备连接和工具可用性应在运行时重新检查。

## 参考实现规则

实现阶段可以阅读和运行 ARTEMIS、Argent 的公开源码与示例，提取接口形状、错误处理、设备适配、工作流组织和验证方法。AppVanta 代码应保持独立实现；引入第三方代码前必须核对许可证、保留归属和 NOTICE 要求，并记录来源。

