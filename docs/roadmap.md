# AppVanta 开发阶段路线图

## 最终目标

至少完整覆盖 Argent 和 ARTEMIS 已有的公开可验证功能，再在多 AI Agent 接入、可替换设备后端、自动恢复、证据链和工程集成方面形成增强。

## 阶段 0：能力盘点与工程基线

目标：把最终目标转化为可验收的能力矩阵。

产出：

- ARTEMIS 公开能力矩阵
- Argent 公开能力矩阵
- AppVanta 统一能力模型
- 平台与 Driver 支持矩阵
- 许可证和独立重写边界说明
- 本机 Node、Python、ADB、Android SDK、模拟器和 MCP 环境检查
- 仓库基础目录、开发规范和验证命令

完成标准：每项参考能力都有状态、平台、依赖、验收方式和证据要求。

## 阶段 1：核心协议与证据底座

目标：先建立不依赖 Android 实现的稳定领域模型。

范围：

- Device、AppArtifact、Observation、Action、Checkpoint
- CapabilityMatrix、EvidenceBundle、RunReport
- Driver 接口和错误模型
- Plan、Step、Run 状态模型
- `.appvanta/runs/<run-id>/` 运行目录
- JSONL 事件记录和 Markdown 报告基础
- CLI 配置和日志规范

完成标准：可以用模拟 Driver 生成完整、可回放的运行记录和报告。

## 阶段 2：Android ADB vertical slice

目标：不依赖 Argent，完成 Android 本地闭环。

范围：

- 设备发现和能力查询
- APK 安装、卸载、启动、重启和数据清理
- UI 树抓取
- 截图
- 点击、滑动、输入、返回和等待
- Resource ID、文本和 Accessibility 定位
- Logcat 收集
- 基本检查点
- CLI：`doctor`、`list-devices`、`install`、`observe`、`run`、`report`

完成标准：在真实设备或模拟器上完成一个端到端示例并生成证据报告。

## 阶段 3：Agent 接入与工作流执行

目标：让多个 AI Agent 使用同一套 AppVanta 能力。

范围：

- MCP Server
- Codex、Claude Code、Cursor 的接入文档
- Plan → Observe → Act → Verify → Recover → Report
- 自然语言任务到结构化动作的边界
- 后台异步任务
- 长任务状态查询、取消和恢复
- 失败后重新观察和有限恢复
- Agent 行为规则和安全边界

完成标准：同一流程可以通过 CLI 和 MCP 执行，并保留一致的证据结构。

## 阶段 4：参考产品能力对齐

目标：逐项补齐 ARTEMIS 和 Argent 的公开可验证能力。

范围：

- 跨应用自动化
- 多设备并行执行
- 探索式执行和运行前观察
- 组件树和更丰富的 UI 属性
- 网络请求观察
- 性能追踪
- 应用调试和崩溃诊断
- 录屏和运行现场保留

完成标准：能力矩阵中所有目标能力达到 `implemented` 或有明确的受支持范围和替代方案。

## 阶段 5：工程化与持续验证

目标：把本地工具变成可持续使用的工程系统。

范围：

- Flow 录制与回放
- 测试夹具和环境重置
- CI/Jenkins/GitHub Actions 集成
- 多设备任务调度
- 运行结果比较和回归检测
- 证据包导出
- 性能基线和阈值管理
- 更完整的权限和审计日志

完成标准：可以在 CI 中运行流程，并输出可供审查的失败证据。

当前进度与未完成验收以 [阶段 4/5 清单](phase-4-5-checklist.md) 为准。存在命令或基础实现不代表完整能力已经验收。

## 阶段 6：平台扩展与部署形态

目标：扩展到完整产品形态。

范围：

- iOS Simulator 和 XCTest/XCUIAutomation Driver
- iOS 真机支持
- React Native 组件树、构建与调试支持
- Electron/Chromium 桌面与 Web 运行环境适配
- TV 设备、遥控输入与焦点导航
- HarmonyOS HDC/Hypium/uitest Driver
- 企业私有化部署
- 远程设备执行
- 云设备池
- 并发和资源配额
- 可选 Web 管理界面

完成标准：新增平台不改变核心工作流、证据格式和 Agent 接口。

## 阶段闸门

每个阶段完成后必须确认：

1. 代码、配置和文档已提交；
2. 运行路径经过真实命令验证；
3. 关键产物可被重新读取；
4. 失败路径有明确结果；
5. 能力矩阵状态已更新；
6. 未覆盖边界已记录；
7. 没有把未运行的测试或未连接的平台标记为已支持。

## 当前启动点

当前执行阶段 4 和 5。Android 本地闭环与 CLI 请求级采集已有实现；统一 Flow、可靠输入验证、任务恢复及真实 CI 仍需完成。阶段 6 平台适配不作为当前 Android 阶段的完成条件。
