# Android 项目与构建日志诊断

`inspect-project` 提供只读项目文件盘点，以及已有 Gradle 日志的错误分类。它不运行项目脚本、不安装依赖、不解析有效的 Gradle 配置，也不把静态文件存在视为构建成功。

```sh
appvanta inspect-project /path/to/android-project
appvanta inspect-project /path/to/android-project /path/to/build.log
```

MCP 工具 `inspect_android_project` 接受 `projectDirectory` 和可选 `buildLogPath`。SDK 导出 `inspectAndroidProject({ projectDirectory, buildLogPath?, signal? })`，返回版本 1 的 `AndroidProjectReport`；Python SDK 可以通过通用 `call` 调用同一工具。

报告包括 Groovy/Kotlin 的 settings/build 文件、默认版本目录、Gradle/本地属性文件、wrapper 文件及 AndroidManifest 的相对路径、大小和 SHA-256。文件内容不写入结果；wrapper 的 `filesPresent` 只代表四个标准文件可读取，不验证脚本、JAR、下载地址或校验和可信度。`android-gradle-candidate` 仅表示扫描范围同时存在 Gradle 声明和 Android manifest，不推断动态 include、模块映射、插件别名、实际变体或 SDK 版本。根目录的 wrapper 缺失与同位置两种 DSL 文件均提供明确的复核建议。

日志可识别 SDK 位置/许可、Java 位置/版本、插件解析、依赖解析、manifest 合并、资源链接、重复类与签名错误。每类记录首次匹配行号及固定建议，不复制日志内容；原日志摘要用于核对输入。`outcomeMarker` 是日志最后一个完整行开头的 `BUILD SUCCESSFUL` 或 `BUILD FAILED` 标记，没有标记为 unknown；它不证明当前代码已构建、日志完整或多次构建都成功。无法匹配的错误仍需读取原日志分析。

扫描最多访问 5000 个目录条目，最多进入 8 层子目录，单个已识别文件限 1 MiB，内容读取总量限 16 MiB；日志上限 2 MiB，超限明确报错。`.git`、`.gradle`、`.idea`、`.appvanta`、`node_modules`、`build`、`dist`、`.venv` 不扫描。符号链接/Windows junction 不遍历；无法读取、深度或数量截断记录在 `scan.skipped`，此时 `scan.complete=false`。complete 仅表示在上述排除规则下扫描完成。扫描不是文件系统快照，检查期间应避免修改项目。

实现依据：[Android 构建配置](https://developer.android.com/build)、[Gradle Wrapper 标准文件](https://docs.gradle.org/current/userguide/gradle_wrapper.html)。受控文件与日志夹具覆盖真实 CLI/MCP 往返、Groovy/Kotlin、文件内容保留、边界和取消。

2026-09-30 Windows 的 `gradle-project-1790748641660` 使用 Gradle 8.13、AGP 8.13.2、JDK 21.0.12.1、SDK/build-tools 35，实际构建 Kotlin DSL 应用与 Groovy DSL 库，生成 wrapper 和 debug APK，并用 aapt 检查包名/入口、jar 检查 DEX 和 manifest 条目。三个实际失败场景分别移除 SDK 环境变量、引入不存在的资源引用和请求离线缓存中不存在的依赖；退出码均非零，错误分类及失败标记通过，SDK/CLI/MCP 对实际日志的报告一致。日志、源码输入、APK 摘要与检查结果保存在该运行证据目录；APK 本体在 `.appvanta/gradle-projects` 的隔离构建目录。该验收没有安装或启动 APK。

初次离线运行 `gradle-project-1790748472075` 因本机缺少 library 插件标记而失败，保留原始日志；它促成独立的 plugin-resolution 分类，修复前新增测试失败、修复后通过。后续在线取得依赖的运行 `1790748510090` 通过，最终 `1790748641660` 使用已缓存依赖完成离线复验。三系统 CI 新增相同构建验证，托管结果待确认。

复验命令：设置 `JAVA_HOME`、`ANDROID_HOME`（含 platforms;android-35 和 build-tools;35.0.0），运行 `node scripts/verify-gradle-project.mjs <Gradle-8.13-home>`；也可通过 GRADLE_HOME 或 PATH 找到同版本。依赖已缓存时可以设置 `APPVANTA_GRADLE_OFFLINE=1`。版本组合参考 [AGP 8.13 官方兼容性表](https://developer.android.com/build/releases/agp-8-13-0-release-notes)。仍需实现产品化构建执行、有效配置/变体查询，以及更多真实工程与故障验收；此脚本只构建自身生成的验证工程。

托管首轮 `36677128333`：macOS/JDK 17 的 `gradle-project-1790748876428` 已通过实际构建、APK 内容检查和三个失败场景，macOS 归档 105 个文件校验通过。Windows/Linux 在 Gradle 类加载阶段失败，两边各 6 个归档文件校验通过，原始日志均为 GradleMain ClassNotFoundException；尚未执行 Android 构建。它们不构成三系统全绿。

Windows `gradle-project-1790749080206` 通过设置无有效启动 JAR 的 GRADLE_HOME、同时在 PATH 提供 8.13，复现相同异常。验证脚本现检查所选安装的固定版本启动 JAR，无效的自动环境候选继续查 PATH，显式错误参数则拒绝；记录选择来源、路径和 JAR 摘要，并先实际检查 Gradle 版本。相同环境下 `gradle-project-1790749081553` 完整通过，45 项脚本测试通过。首轮托管没有记录原 GRADLE_HOME，故这仍是已复现的选择缺陷和待托管验证的修正，不能反推其环境路径；新回执补记该值。

修正快照 `c6208fd` 的 CI `36677718660`：Linux `gradle-project-1790749295701` 与 macOS `gradle-project-1790749306277` 的真实构建、APK 检查及三种失败诊断通过，各 106 个归档文件核验通过。Linux 回执显示环境 GRADLE_HOME 为 `/usr/share/gradle-9.7.1`，实际从 PATH 选择 8.13；macOS 无环境覆盖，同样从 PATH 选择。两边启动 JAR SHA-256 均为 `ca68e720409e7bb345fb14d8b6ba57600028e399f4b2a7ca7633c26d4d38bd1c`。Windows 的 Gradle 步骤已通过，完整任务/归档在本次检查仍待后续确认。

验证脚本现在为每次 Gradle 调用先保存日志及 `.command.json` 回执，再分析和断言。超时、输出上限、启动失败也保存可获得的 stdout/stderr、摘要和退出原因；日志按 stdout 后 stderr 拼接，不宣称跨流时序。超时被独立标记，即使子进程处理终止信号后退出 0 也不能成为成功；超时一秒后仍未退出则升级终止该直接子进程。回执明确 `descendantCleanup=unverified`，此脚本尚不具备产品构建执行器所需的 Gradle daemon/后代进程恢复保证。Windows `gradle-project-1790749521060` 真实构建完整复验通过，脚本回归 48 通过、1 个 POSIX 信号用例跳过；后者仍待托管验证。
