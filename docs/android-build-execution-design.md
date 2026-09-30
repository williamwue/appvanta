# Android 构建执行器的进程边界

这是待实现产品执行器的设计与原型证据，不是已提供的 build API。现有 `inspect-project` 继续只读，实际 Gradle 工程验证脚本仅构建其生成的工程。

## 实测依据

Windows/JDK 21、Gradle 8.13 的 `gradle-cancellation-1790750011334` 使用正式 Tooling API，配置独立 Gradle 用户目录并启动真实任务。任务首先记录执行阶段与 daemon PID，再等待 60 秒。父进程关闭 Java bridge 的 stdin 后，bridge 调用 CancellationTokenSource.cancel，246 ms 内收到 BuildCancelledException，写入 cancelled 回执并正常退出。

取消完成后 daemon PID 12412 仍然存活。仅针对该次隔离用户目录调用 Gradle `--stop`，命令 586 ms 内退出 0，随后外部确认 PID 消失。原型使用公共 Tooling API 和分发包已有依赖，不依赖内部 connector 方法。三系统 CI 已加入此原型，托管结果待验证。

这说明构建终态与进程清理状态是两个事实。该证据只涉及等待任务，不覆盖 JavaExec、编译 Worker、任意项目派生进程、强杀 bridge 或停止期间再次断连。

## 选定的产品结构

- `BuildRequest` 保存规范化项目目录、明确的 Gradle/JDK 安装、任务数组、超时和运行 ID。任务按参数传递，不拼接 shell。版本与启动文件摘要绑定运行记录。
- `BuildRun` 分别记录执行状态、取消请求、Gradle 返回结果及 cleanup 状态。`cancelled` 不能隐含 `cleanup=verified`；未知清理保留项目占用与诊断，不自动宣布可重新执行。
- 每个项目采用专属 Gradle 用户目录及有持久所有权的项目锁，复用该目录的构建串行执行。缓存复用与锁恢复需要单独验收；不得向用户共享的默认 Gradle 用户目录发全局 stop。
- Java bridge 使用 Tooling API 执行任务，Node 向拥有的 stdin 管道发送取消/关闭事件。bridge 必须在连接关闭并形成回执后退出。独立恢复路径读取项目所有权和进程证据，不能仅凭一个 PID 猜测所有权。
- 有效配置/变体查询通过同一受管理的 Gradle 执行路径获得，并标明会求值项目代码。静态文件扫描保持独立的数据结构，不把候选声明冒充有效模型。
- 运行输出持续保存并限制大小；超时或输出上限保存原因和已有日志。Gradle 取消、专属 daemon 停止和必要的后代清理各有独立确认，任一步无法确认都不能释放项目锁。

## 下一实现单元与验收门槛

由一个写入者负责 Android 包的执行器、Java runtime bridge 和共享报告类型；CLI/MCP 在 SDK 生命周期通过后接入，同一项目的状态文件修改串行进行。现有跨平台 CI 和设备验收可以独立运行，互不占用这套专属 Gradle 用户目录。

先补真实 JavaExec/Worker 取消、父 Node 退出、bridge 强杀、取消与正常完成竞争、专属 daemon 停止失败及重复恢复，再实现带占用保护的 SDK。验收必须证明无重复构建、未确认清理不释放占用、其他项目及用户默认 daemon 不被停止。随后提供 CLI/MCP 执行和取消，并将实际 Android 两模块 APK 构建从验证专用入口迁移到产品入口。

恢复与清理不能仅靠放宽超时。对无法控制的派生进程或不合作任务，执行器应返回明确的未恢复状态和证据；其完整支持仍属于原清单范围。当前原型不改变 39 项完成计数。
