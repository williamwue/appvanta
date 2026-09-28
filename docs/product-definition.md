# AppVanta 产品定义

## 一句话 Slogan

> AppVanta：让 AI 驱动每一次移动 App 开发、调试与验证。

## 产品描述

> AppVanta 是一个面向 AI Agent 的移动应用开发、调试和验证工具包。它让 Codex、Claude Code 等 AI Agent 能够通过自然语言构建、启动、操作和检查 Android、iOS 及其他受支持的应用，连接真实设备、模拟器和桌面/Web 运行环境，执行跨应用和端到端工作流，并结合 UI/组件树、截图、日志、网络请求、性能追踪与运行记录完成问题定位和结果验证。

## 产品目标

AppVanta 将移动 App 的以下环节连接为完整工作流：

```text
代码变更
→ 构建应用
→ 连接设备或模拟器
→ 安装并启动应用
→ 观察 UI 和运行状态
→ 执行交互操作
→ 验证结果
→ 诊断问题
→ 失败恢复
→ 生成运行报告
```

## 核心用户

- 使用 Codex、Claude Code 等 AI Agent 的开发者
- Android、iOS 和跨平台 App 开发者
- 移动端测试与质量工程师
- 需要自动复现和诊断问题的工程团队
- 需要本地部署、CI 或企业私有化的团队

## 核心能力

### AI Agent 接入

通过 MCP、CLI、SDK 和 HTTP API 接入 AI Agent。AppVanta 不绑定单一模型、Agent 或第三方 AI API。

### 应用构建与运行

- 识别项目结构和构建配置
- 执行构建命令并定位应用产物
- 安装、卸载和重装应用
- 启动、重启和停止应用
- 清理应用数据
- 检查应用进程和运行状态

### 设备与运行环境

- Android 模拟器
- Android 真实设备
- iOS 模拟器和真实设备
- React Native 等跨平台应用
- 桌面/Web 运行环境
- 多设备并行执行

### 应用交互

支持点击、滑动、长按、文本输入、返回、等待、截图、录屏、权限处理、应用切换和跨应用操作。

控件定位优先使用 Resource ID、Accessibility 标识、可见文本和 UI 树属性，坐标只作为兜底方案。

### UI 与运行状态观察

- UI 树和组件属性
- 当前页面、Activity 或路由
- 截图
- 应用进程状态
- 权限状态
- 系统弹窗
- 设备状态
- 网络连接状态

### 调试与诊断

- Logcat 和应用日志
- 崩溃与 ANR
- 网络请求和响应摘要
- CPU、内存、FPS 和启动耗时
- 性能 trace
- UI、日志、网络和性能数据关联分析

### 工作流与验证

```text
Plan
→ Observe
→ Act
→ Verify
→ Recover
→ Report
```

支持验证文本、控件、页面、操作、网络请求、日志异常、崩溃状态和性能阈值。

### 失败恢复

动作失败后重新观察 UI 和设备状态，检查页面变化、弹窗和权限请求，选择有限恢复策略并记录完整链路；超过重试限制后明确标记失败。

### 证据与报告

每次运行保存执行计划、步骤记录、设备和环境信息、应用版本及构建产物哈希、UI 树、截图、日志、网络记录、性能 trace、恢复过程，以及 Markdown 和 JSON 报告。

## 技术分层

```text
AI Agent
  ↓
MCP / CLI / SDK
  ↓
Workflow Engine
  ↓
Checkpoint & Evidence Layer
  ↓
Device Driver
  ↓
Android / iOS / Desktop / Web
```

AI Agent 负责理解目标和提出计划；Workflow Engine 负责流程编排；Checkpoint Layer 负责确定性验证；Device Driver 负责设备和应用操作；Evidence Layer 负责保存事实和证据。

## 实现原则

- 核心代码全部自行实现
- 不复制 ARTEMIS 或 Argent 的内部实现
- 不依赖 ARTEMIS 或 Argent 才能运行
- Driver 不调用模型
- 支持多个 AI Agent
- 优先支持语义定位
- 关键步骤必须有检查点
- 失败后必须重新观察
- 所有关键结论都应有证据
- 本地优先，后续支持 CI、企业私有化和云设备

## 第一阶段 MVP

1. 发现 ADB 设备和模拟器
2. 安装 APK
3. 启动和重启应用
4. 获取 UI 树和截图
5. 执行点击、滑动、输入和等待
6. 收集 Logcat
7. 执行基本检查点
8. 失败后重新观察并有限恢复
9. 保存结构化运行记录
10. 生成 Markdown 报告
11. 通过 CLI 和 MCP 使用

## 最终产品目标`r`n`r`nAppVanta 的最终目标是至少完整覆盖 Argent 和 ARTEMIS 已有的公开可验证功能，包括设备与模拟器控制、应用启动与交互、跨应用和端到端工作流、UI/组件树观察、日志采集、网络与性能诊断、后台任务、多设备执行以及 AI Agent 接入。`r`n`r`n在满足功能覆盖的基础上，AppVanta 再通过多 AI Agent 接入、可替换设备后端、自动恢复、完整运行证据、可复现报告以及 CLI/MCP/SDK/CI 集成形成增强。每项参考能力都必须进入能力矩阵，记录实现状态、适用平台、Driver 要求和验证证据。

