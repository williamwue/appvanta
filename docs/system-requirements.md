# 系统要求

Android 本地能力的发布基线：

| 依赖 | 最低版本 | 用途 | 缺失影响 |
|---|---:|---|---|
| Node.js | 20 | CLI、MCP、Flow 与报告 | 阻止 AppVanta 启动 |
| ADB | 1.0.41 | 设备发现、安装、控制与证据采集 | 阻止 Android 能力 |
| Python | 3.10 | 网络代理恢复与 Perfetto Python 分析 | 基础 ADB 可用，网络/分析能力降级 |
| JDK | 17 | 构建 AppVanta 测试输入/剪贴板辅助 APK及 Android 项目 | 已构建 APK 可使用，本地构建降级 |
| Android SDK Platform / Build Tools | 35 | 构建测试辅助 APK和 CI 模拟器 | 设备控制仍可用，本地辅助 APK 构建降级 |

网络采集还需要独立 Python 环境中的 `mitmproxy`，Perfetto SQL 分析需要 `perfetto` Python 包。AppVanta 不会由 `doctor --fix` 自动安装系统软件、Python 包、证书或 Android SDK 组件。

执行 `appvanta doctor` 获取逐项状态和修复建议。无在线设备、Python/JDK/SDK 不完整时返回 `degraded`；Node、ADB或工作目录不可用时返回 `blocked`。
