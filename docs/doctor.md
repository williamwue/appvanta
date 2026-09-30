# 环境诊断

`appvanta doctor` 在执行设备动作前检查本机基础环境，并返回版本化 JSON：

```powershell
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js doctor --fix
node packages/cli/dist/index.js list-avds
node packages/cli/dist/index.js start-avd AppVanta_Verification_API37 5554 120000
```

`verdict` 有三种状态：

- `ready`：必需项和建议项均可用，并且至少有一台在线 Android 设备。
- `degraded`：核心命令可以运行，但当前无在线设备，或 SDK、Python、Java 等可选能力不完整。
- `blocked`：Node.js 版本、ADB 或工作目录等必需项失败，CLI 以非零状态退出。

检查项包含 Node.js 20+、ADB 1.0.41+、在线/离线设备、Android SDK 环境变量、Python 3.10+、JDK 17+ 和项目目录访问。每个失败或警告都带有可执行的修复提示。完整依赖范围见 [系统要求](system-requirements.md)。Python 用于网络和 Perfetto 辅助脚本，Java 用于 Android 项目构建；两者缺失不会阻止仅使用 ADB 的基础操作。

新增 AVD 清单检查，CLI `list-avds` 与 MCP `list_avds` 共用实现。模拟器命令按 APPVANTA_EMULATOR_PATH、ANDROID_SDK_ROOT/ANDROID_HOME 下 emulator 目录、PATH 的顺序确定；使用独立参数调用，不拼接 shell。输出已配置的 AVD 名称，不代表这些 AVD 已启动或可运行。无模拟器组件或无 AVD 只产生警告，不阻止物理设备使用。doctor 的 ADB 检查、启动与枚举尊重 ADB_PATH。

2026-09-26 本机查询返回 AppVanta_Verification_API37 和 Kitta_Pixel_9_API_37 两个 AVD，doctor 同时报告一台在线设备、8 项通过及 ready。环境快照不替代其他主机或 AVD 启动验收。自动测试覆盖显式命令路径、SDK 路径、PATH、空列表、重复名称、异常输出与组件缺失。

`--fix` 只执行本地且可逆或幂等的安全修复：创建 `.appvanta/runs`、`.appvanta/tasks`、`.appvanta/cli-artifacts`，并启动 ADB server。它不会安装软件、创建或启动 AVD、修改系统环境变量、接受设备授权或更改设备设置。

显式 CLI `start-avd <name> [even-port] [timeout-ms]` 与 MCP `start_avd` 启动已配置 AVD。默认端口 5554、期限 120000ms，按 AVD 名称和设备串号持锁，复用已运行同名实例；新实例 headless、无音频且不保存退出快照，不使用 wipe-data。启动命令、PID、日志与结果保存在 `.appvanta/emulators/<id>/`。ready 要求 AVD 身份一致且 sys.boot_completed=1，不等于目标应用已就绪。无法识别的离线模拟器或端口冲突会阻止新启动。

超时返回 boot-timeout，CLI 非零退出，保留进程和日志；应先查看 adb devices 及启动记录，不应盲目重试。SDK `startAndroidAvd(name, port, timeoutMs, gpu, signal)`、CLI 中断信号和 MCP 请求取消现可停止启动等待：中断 AVD 枚举/ADB 探测及轮询，在启动记录已建立时保存 `cancelled`，释放启动锁。取消不会终止已启动或复用的模拟器；需要停止设备时应先核对身份再显式操作。启动前取消不会创建实例。记录在启动进程退出后不会由后台监控持续更新。

Windows/API 37 `avd-cancellation-1790741502527` 已验证 SDK 复用正在运行的 AVD，在 `starting` 记录出现后取消，7 ms 返回；记录为 cancelled，两层锁释放、boot ID 未变、设备仍 ready，随后再次调用成功复用。后续真实 MCP stdio `avd-cancellation-1790741748202` 在同一窗口发送 `notifications/cancelled`，15 ms 确认取消及锁释放；被取消请求的响应被抑制，后续 `tools/list` 成功，设备身份与再次复用检查通过。同轮 SDK `1790741748876` 回归通过（8 ms）。自动夹具另覆盖新建进程、复用探测和轮询间隔取消。真实冷启动取消、CLI 控制台中断及 Linux/macOS 动态验证仍待完成，不能用夹具代替设备证明。托管 API 35 已接入 SDK/MCP 及 POSIX CLI SIGINT 复用取消脚本，结果待新 CI；Windows 控制台信号没有用进程终止模拟验收。

本机真实重启验收：`node scripts/verify-avd-start.mjs AppVanta_Verification_API37 5554`，证据 `.appvanta/runs/avd-start-1790426543011/verification.json`。启动约 29 秒后 ready，再次调用复用原实例；模拟器保持运行供后续验证。AVD 创建、SDK 安装、超时/取消故障验收及 Linux/macOS 启动仍待完成。
新实例取消补充：`verify-avd-cancellation.mjs <name> <serial> <sdk|mcp|cli> new <gpu>` 仅接受项目测试 AVD，先在 AVD/设备锁内核对身份并关闭旧实例，再调用产品启动入口；不清除数据。在 `booting` 记录与 PID 出现后取消，确认新进程存活、记录 cancelled、锁释放，随后等待同名设备 ready 并再次复用。Windows/API 37 SDK `avd-cancellation-1790741961095`（6 ms）及 MCP `1790742061850`（16 ms）通过，前后 boot ID 均不同；后者在 MCP 客户端关闭后再次确认设备 ready 与 boot ID 保持不变。它验证进程启动后的早期取消，不表示所有启动故障、快照配置或 Windows 控制台信号已覆盖。托管 API 35 新增 MCP 新实例路径，结果待确认。

新实例验收还会复制启动日志快照并记录字节数/SHA-256，随运行证据归档。SDK `avd-cancellation-1790742136000` 通过包含日志快照及客户端收尾后的设备检查；运行中的模拟器仍可能继续写原日志，快照摘要只描述保存的字节。

托管 Linux/API 35 验收：公开 `280e921` 的 [CI 36668578061](https://github.com/williamwue/appvanta/actions/runs/36668578061) 七项全部通过；下载后的 3475 个设备文件均通过大小与 SHA-256 校验。复用取消 SDK `avd-cancellation-1790742280482`（5 ms）、MCP `1790742283909`（44 ms）和真实 CLI SIGINT `1790742285257`（42 ms，退出码 1）均保存 cancelled、释放两层启动锁，boot ID 不变，随后可再次复用。MCP 新实例 `1790742331202` 在 booting 后 6 ms 确认取消，新模拟器继续启动，boot ID 改变；取消响应被抑制，后续 tools/list 成功，客户端关闭后设备仍 ready。其 9097 字节启动日志快照摘要 `eac329819fe10e05f133dcdff200ec7b9b5ca0fcbdc167b4b67ded4ccb147e23` 已独立复核。本机归档位于集成工作区 `.appvanta/ci-36668578061/.appvanta/ci-evidence/`，完整性回执为 `.appvanta/ci-36668578061-integrity.json`。这些结果补足上文 Linux 动态验证，不代表 macOS AVD、Windows AVD 控制台信号、全部启动故障或真机/OEM 已验收。

# 模拟器图形后端

Windows / API 37 已实测 `swiftshader` 启动，日志确认 GLES/Vulkan 使用 Google SwiftShader；启动证据 `.appvanta/emulators/1790429857178-d16c55d3-69bd-4c0d-aa34-1b3296382d1b/startup.json`。同一实例运行长录屏仍发生退出，因此该参数是显式配置能力，不作为已修复模拟器稳定性的声明。

`start-avd <name> [even-port] [timeout-ms] [gpu-mode]` 与 MCP `start_avd` 的可选 `gpu` 参数支持 auto、host、software、lavapipe、swiftshader、swangle。本机 Emulator `-help-gpu` 可查看其版本支持情况。不指定时保留模拟器默认选择；指定值作为显式 `-gpu` 参数写入 startup.json。若 AVD 已运行则拒绝指定 gpu，避免将实例复用误报为参数已生效；需先明确停止目标测试实例再启动，不会自动关闭设备或清除数据。
