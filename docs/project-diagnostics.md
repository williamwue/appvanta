# Android 项目与构建日志诊断

`inspect-project` 提供只读项目文件盘点，以及已有 Gradle 日志的错误分类。它不运行项目脚本、不安装依赖、不解析有效的 Gradle 配置，也不把静态文件存在视为构建成功。

```sh
appvanta inspect-project /path/to/android-project
appvanta inspect-project /path/to/android-project /path/to/build.log
```

MCP 工具 `inspect_android_project` 接受 `projectDirectory` 和可选 `buildLogPath`。SDK 导出 `inspectAndroidProject({ projectDirectory, buildLogPath?, signal? })`，返回版本 1 的 `AndroidProjectReport`；Python SDK 可以通过通用 `call` 调用同一工具。

报告包括 Groovy/Kotlin 的 settings/build 文件、默认版本目录、Gradle/本地属性文件、wrapper 文件及 AndroidManifest 的相对路径、大小和 SHA-256。文件内容不写入结果；wrapper 的 `filesPresent` 只代表四个标准文件可读取，不验证脚本、JAR、下载地址或校验和可信度。`android-gradle-candidate` 仅表示扫描范围同时存在 Gradle 声明和 Android manifest，不推断动态 include、模块映射、插件别名、实际变体或 SDK 版本。根目录的 wrapper 缺失与同位置两种 DSL 文件均提供明确的复核建议。

日志可识别 SDK 位置/许可、Java 位置/版本、依赖解析、manifest 合并、资源链接、重复类与签名错误。每类记录首次匹配行号及固定建议，不复制日志内容；原日志摘要用于核对输入。`outcomeMarker` 是日志最后一个完整行开头的 `BUILD SUCCESSFUL` 或 `BUILD FAILED` 标记，没有标记为 unknown；它不证明当前代码已构建、日志完整或多次构建都成功。无法匹配的错误仍需读取原日志分析。

扫描最多访问 5000 个目录条目，最多进入 8 层子目录，单个已识别文件限 1 MiB，内容读取总量限 16 MiB；日志上限 2 MiB，超限明确报错。`.git`、`.gradle`、`.idea`、`.appvanta`、`node_modules`、`build`、`dist`、`.venv` 不扫描。符号链接/Windows junction 不遍历；无法读取、深度或数量截断记录在 `scan.skipped`，此时 `scan.complete=false`。complete 仅表示在上述排除规则下扫描完成。扫描不是文件系统快照，检查期间应避免修改项目。

实现依据：[Android 构建配置](https://developer.android.com/build)、[Gradle Wrapper 标准文件](https://docs.gradle.org/current/userguide/gradle_wrapper.html)。当前验证使用受控文件与日志夹具，包含真实 CLI/MCP 往返、Groovy/Kotlin、文件内容保留、边界和取消；仍需补真实多模块工程、构建执行、动态配置及更多实际失败日志验收。
