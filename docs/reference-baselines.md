# 参考产品固定基线

本文件固定 AppVanta 功能覆盖审计的输入。对齐结论必须引用这里的版本，不能用持续变化的默认分支替代。固定基线只用于阅读公开文档、接口和可观察行为；AppVanta 不导入参考项目源码或二进制。

## ARTEMIS

- 仓库：https://github.com/google/artemis
- 固定提交：`371aa6df56880643da57b30da936e9812fb0ec66`
- 提交时间：2026-09-11T19:59:56-07:00
- 核对日期：2026-09-22
- 许可证：Apache-2.0
- 版本选择：核对时仓库未提供可固定的 release tag，因此使用完整提交 SHA。
- 主要公开证据：根 README、`mcp_server/README.md`、`mcp_server/rules.md` 和公开 MCP 工具定义。

公开功能范围包括 Android 真机/模拟器、跨应用自然语言任务、元素/坐标/视觉定位、Flash 与 Pro 工作流、计划与检查点、失败恢复、异步任务、任务控制、设备观察、trace 检查、诊断与安全自修复、设备并发锁、CLI、MCP、Web 控制台和 Python SDK。

ARTEMIS README 声明包含 Minitap, Inc. 开发的源码。AppVanta 当前未采用 ARTEMIS 或该上游的源码；若未来提出代码引入，必须先单独追踪原始文件、许可证、NOTICE 和修改记录，不能仅凭 ARTEMIS 根许可证处理。

## Argent

- 仓库：https://github.com/software-mansion/argent
- 发行版：`@swmansion/argent@0.25.2`
- 固定提交：`37fe85a0cc1a88b80023fe5705312f66912cf431`
- 提交时间：2026-09-18T18:27:03+02:00
- 核对日期：2026-09-22
- 源码许可证：Apache-2.0
- 主要公开证据：版本化 README、`packages/docs/docs/reference/tools.mdx` 及版本化 feature 文档。

Argent 公开范围包括 iOS Simulator、Android 模拟器/设备、TV、Electron/Chromium，设备生命周期、手势/键盘/硬件按钮、UI/DOM/React/native 树、录屏、Flow 录制回放、视觉差异、网络、JavaScript 调试、React/Hermes 与原生性能分析。

Argent README 明确说明其 `simulator-server`、`ax-service` 和 `native-devtools-ios` 中的 `.dylib` 属专有二进制，禁止未经授权的反编译和再分发。AppVanta 不下载、提交、打包、调用或兼容性封装这些二进制；相应能力只能使用公开平台接口独立实现。

## 证据规则

1. `verified` 必须有与能力范围匹配的自动测试或设备运行证据。
2. `partial` 表示实现或验证只覆盖其中一部分。
3. `missing` 表示固定基线中存在，但 AppVanta 还没有对应实现。
4. `deferred` 表示已确认差距并放入最后阶段，不表示无需实现。
5. 竞品宣传数字、benchmark 或速度声明不作为 AppVanta 的验收证据。
6. 平台基础能力、协议和工作流思想可以参考；源码、提示词、资源和专有二进制不复制。
