# Android 构建执行器的进程边界

这是待实现产品执行器的设计与原型证据，不是已提供的 build API。现有 `inspect-project` 继续只读，实际 Gradle 工程验证脚本仅构建其生成的工程。

## 实测依据

Windows/JDK 21、Gradle 8.13 的 `gradle-cancellation-1790750011334` 使用正式 Tooling API，配置独立 Gradle 用户目录并启动真实任务。任务首先记录执行阶段与 daemon PID，再等待 60 秒。父进程关闭 Java bridge 的 stdin 后，bridge 调用 CancellationTokenSource.cancel，246 ms 内收到 BuildCancelledException，写入 cancelled 回执并正常退出。

取消完成后 daemon PID 12412 仍然存活。仅针对该次隔离用户目录调用 Gradle `--stop`，命令 586 ms 内退出 0，随后外部确认 PID 消失。原型使用公共 Tooling API 和分发包已有依赖，不依赖内部 connector 方法。三系统 CI 已加入此原型，托管结果待验证。

这说明构建终态与进程清理状态是两个事实。该证据只涉及等待任务，不覆盖 JavaExec、编译 Worker、任意项目派生进程、强杀 bridge 或停止期间再次断连。

后续 Windows 原型补充：`gradle-cancellation-1790750230665` 的 JavaExec 子 JVM 在实际写入 PID 7692 后才关闭 bridge 输入，251 ms 返回取消，子 JVM 在停止 daemon 前已退出；daemon 11700 随专属目录 stop 退出。Worker API `processIsolation` 的 `1790750323831` 同样先确认 daemon 32932 与 Worker 11684 均存活，再触发 EOF；296 ms 返回取消，Worker 此时已退出，daemon 仍活着，专属 stop 后确认两者均退出。这覆盖受 Gradle 管理的两个具体子进程场景，不覆盖任意项目自行启动的进程。

Worker 初次运行 `1790750295584` 在提交参数配置时失败，尚未启动 Worker；已保留日志和专属 stop 的退出 0 回执。修正 WorkQueue.submit 的参数 closure 后复验通过，不将夹具失败算作产品缺陷。`APPVANTA_GRADLE_CANCEL_TASK` 现支持 wait/javaexec/worker，三系统 CI 分别执行三种原型；新增两种的托管结果待确认。

Bridge 强制终止：Windows `gradle-cancellation-1790750594684` 在 Worker 28588 与 daemon 32516 已实际执行、并核对 Gradle 自报用户目录的真实路径后强杀拥有的 bridge。bridge 61 ms 退出，未生成回执；576 ms 观测时 Worker 已退出、daemon 仍存活。专属目录 stop 在 605 ms 退出 0，之后确认两者均已退出。`before-interruption.json` 与 `before-stop.json` 保留两个边界的原始快照。此结果是缺少执行回执时的定向进程清理证据，不把该次构建记为 passed/cancelled，不证明未知写入可以重放；原型总状态 passed 表示上述验收断言通过。

`APPVANTA_GRADLE_CANCEL_TRIGGER=bridge-kill` 用于该原型，默认 eof 仍要求实际 BuildCancelledException 回执；三系统 CI 新增 Worker 运行中 bridge 强杀场景，托管结果待确认。尚未验证父 Node 强杀、daemon 停止失败、其他项目不受影响及项目状态恢复。

## 选定的产品结构

父 Node 强杀的 Windows 原型：未独立启动 bridge 的 `gradle-cancellation-1790750900231` 中，Node 被强杀后 bridge 也退出，未留下 bridge.json；该失败和回退 stop 日志保留，尚不能仅据此确定 Windows 底层终止机制。将 bridge 以 `detached: true` 启动并继续持有 stdin 管道后，`1790751242337` 在真实 Worker 执行期间强杀 Node，312 ms 内观察到 bridge 退出及 BuildCancelledException 回执。Worker 已退出，daemon 仍存活；仅停止本次专属用户目录后确认 daemon 与 Worker 均已退出。所有权回执记录父子 PID 和 detached 设置。该外部观察不能获取已孤立 bridge 的退出码，不宣称其退出码为 0。

`APPVANTA_GRADLE_CANCEL_TRIGGER=owner-kill` 已加入三系统 CI，托管结果待验证。本机证据不覆盖独立 bridge 自身被强杀、任意项目派生进程或整个进程组被终止；执行状态仍需真实回执，缺失回执保持失败。

- `BuildRequest` 保存规范化项目目录、明确的 Gradle/JDK 安装、任务数组、超时和运行 ID。任务按参数传递，不拼接 shell。版本与启动文件摘要绑定运行记录。
- `BuildRun` 分别记录执行状态、取消请求、Gradle 返回结果及 cleanup 状态。`cancelled` 不能隐含 `cleanup=verified`；未知清理保留项目占用与诊断，不自动宣布可重新执行。
- 每个项目采用专属 Gradle 用户目录及有持久所有权的项目锁，复用该目录的构建串行执行。缓存复用与锁恢复需要单独验收；不得向用户共享的默认 Gradle 用户目录发全局 stop。
- Java bridge 使用 Tooling API 执行任务，Node 向拥有的 stdin 管道发送取消/关闭事件。bridge 必须在连接关闭并形成回执后退出。独立恢复路径读取项目所有权和进程证据，不能仅凭一个 PID 猜测所有权。
- 有效配置/变体查询通过同一受管理的 Gradle 执行路径获得，并标明会求值项目代码。静态文件扫描保持独立的数据结构，不把候选声明冒充有效模型。
- 运行输出持续保存并限制大小；超时或输出上限保存原因和已有日志。Gradle 取消、专属 daemon 停止和必要的后代清理各有独立确认，任一步无法确认都不能释放项目锁。

## 下一实现单元与验收门槛

包内 bridge 现在生成排他的受管理 init script，并在 Gradle 配置求值前写 `bridge.json.daemons/<pid>.json`。记录包含本次随机 invocation、PID、进程启动时间及 Gradle 实际用户目录；用户目录与请求的规范路径不符时拒绝继续。同一进程重复应用 init script 只能接受完全相同的身份记录，不覆盖旧记录。路径以 UTF-8/Base64 嵌入生成脚本，最终 bridge 回执携带同一 invocation。启动时间是恢复核验的输入，当前尚未实现据此判断 PID 复用或自动恢复的入口。

Windows `gradle-supervisor-1790753003368` 已用运行时身份记录代替测试任务自报 PID，通过实际执行后的取消和清理。`1790753065621` 在 settings.gradle 配置阶段主动抛出预期错误，确认任务体从未执行，却已记录 daemon 29336 及启动时间；BuildException 回执与身份 invocation 一致，专属 stop 后确认退出并释放占用。`gradle-cancellation-1790753072771` 成功回归及 `1790753100658` bridge 强杀回归通过；后者无最终回执但身份文件保留、占用不释放。四包打包/安装字节一致性验收通过；配置失败场景加入三系统 CI，托管结果待确认。

Node 监督的首个内部模块 `build-process.ts` 已实现：参数直接传给 spawn，独立进程持有 stdin；AbortSignal、期限或输出上限先关闭输入，宽限期后才强杀拥有的进程。输出按总字节上限写入排他日志并保存摘要，接收超限仍继续排空但不继续保留；退出后最多等待一秒排空管道，后代仍持有管道时返回 outputComplete=false。回执分开记录真实退出码、打断原因、强杀及日志状态，descendantCleanup 始终是 unverified。文件同步或回执保存失败仍会抛错，不能以成功结果释放占用。

Windows 七项真实子进程测试覆盖正常失败、超时后协作退出 0、超量输出、忽略 EOF 后强杀、预先/运行中取消、启动失败及后代持有管道。完整回归为 core 127、Android 119、脚本 48 项通过，1 项 POSIX 用例跳过。`gradle-supervisor-1790752708227` 用该模块编译并运行包内 bridge，确认 Gradle 任务实际执行后触发 AbortSignal，收到 cancelled 回执且未强杀；专属 stop 后外部确认 daemon 退出并归档释放占用。`gradle-cancellation-1790752619180` 也使用该模块执行 stop 与重复回执拒绝检查。三系统 CI 已加入监督器真实取消验证，结果待确认；公共请求/报告接口及恢复仍待实现。

Java 运行时首轮 CI `36682343696` 的 Windows 多任务参数回读得到 `space ?? ; & = literal`，Linux/macOS 主机任务通过。本地强制 windows-1252 默认编码的 `1790752772666` 复现同一失败，说明参数夹具用默认编码写文件丢失中文；改为 setText(..., 'UTF-8') 后同样强制编码的 `1790752794571` 通过。保留中文断言与失败日志，未据此认定托管修正已通过。

Java bridge 已从单任务测试夹具移入 Android 包运行时 `packages/android/runtime/GradleBuildBridge.java`。调用协议为安装目录、项目、专属用户目录、回执路径、任务数量、任务数组、Gradle 参数数组；任务与参数通过 Tooling API 传递，不拼接 shell。回执增加版本、bridge PID、任务数和耗时，并以排他文件创建和文件同步保存。已有回执在执行前拒绝；异常退出留下的部分回执仍应视为未知，不能据此重放构建。它是供执行器使用的内部运行时，尚无公共构建 API、自动恢复或任意派生进程清理承诺。

Windows 使用实际 dist/runtime 文件的验证：`gradle-cancellation-1790752162810` 执行两个任务，中文/空格/特殊字符参数原样往返，成功产物与回执匹配，再次使用回执被拒绝且内容不变；`1790752170829` 验证任务失败。`1790752186363` 父 Node 强杀、`1790752194995` bridge 强杀、`1790752226256` JavaExec EOF 均通过原有取消/清理/占用断言。运行记录绑定 Java 源码 SHA-256，原重复测试实现已移除。包验收检查 tarball 包含 Java 源码，并校验实际安装文件字节与源文件一致；这仍不是 npm/PyPI 正式发布。

占用模块首轮 CI `36681342452` 在 macOS/Windows 的测试断言失败：实际 owner 路径正确规范化成 `/private/var/...` 和 `runneradmin`，测试却分别期待 `/var/...` 和 `RUNNER~1`。本地显式 junction 复现相同错误；修正为比较 realpath 后六项测试通过，并让六个竞争进程交替使用真实路径与别名，仍要求唯一持有者。产品路径规范化未放宽；修正的托管结果待新快照验证。

托管原型结果：公开快照 `e42b38f` 的 CI `36680846741` 已核验 Linux/macOS 两份归档，共 362 个文件通过大小/SHA-256 校验。每个平台均通过等待任务、JavaExec、Worker EOF 取消，以及 bridge 强杀和父 Node 强杀五种场景。父 Node 强杀后分别在 554/1866 ms 得到 BuildCancelledException 回执，专属 stop 后 daemon/Worker 均退出。此快照早于项目占用模块；Windows 完整任务及 Android 仍按各自状态单独验收，不将两个主机平台成功写成整轮通过。

正常终态原型：Windows `gradle-cancellation-1790751843863` 通过执行握手释放真实任务，核对成功产物及 passed 回执；`1790751851885` 通过同一握手使任务抛出明确的预期异常，核对 failed/BuildException 及错误标记。二者均没有发起取消，确认专属 daemon 退出后，内部占用模块分别记录 succeeded/failed 并归档释放。Worker EOF 回归 `1790751867463` 同时通过。新增 success/failure 模式必须配合 complete 触发器，三系统 CI 已加入两条路径，结果待验证；此握手没有模拟完成与取消同时发生的竞争。

项目占用的首个内部实现位于 `packages/android/src/build-ownership.ts`，尚未作为公共 SDK 导出。以项目真实路径下 `.appvanta/android-build/active` 的排他目录创建获得占用；owner/outcome 回执使用排他写入并同步文件。已存在但内容不完整的目录同样拒绝新构建，不根据 PID 消失删除锁。终态明确且 supervisor 确认清理后，将整个 active 目录重命名到唯一 runs 目录；未知执行或清理未确认时保留 active。该实现依赖协作进程不自行替换状态目录，不提供恶意并发文件系统修改防护或断电持久性保证；显式恢复入口仍待实现。

吞吐与实现边界：同一项目只有一个写入者，不同项目目录独立。锁记录是共享可变状态；本单元由根执行者串行修改、构建和验证。托管结果不阻塞本地开发，产品构建 API 的开放仍取决于生命周期和恢复验收。六项测试覆盖六个独立 Node 进程竞争、持有进程退出、路径别名、状态目录链接、部分写入/记录损坏、终结竞争、回执写入失败及其他项目仍可运行。

真实 Gradle 验证已调用该内部模块：Windows `gradle-cancellation-1790751552566` 父 Node 强杀后收到 cancelled 回执，确认 daemon/Worker 退出，归档并释放项目占用；`1790751561616` bridge 强杀后执行未知，尽管专属 daemon 清理已确认，仍保留 active 并拒绝再次申请。归档 `project-outcome.json` 分别记录执行与清理结果。完整四包构建、127 项 core 测试、112 项 Android 测试及脚本 48 项通过，1 项 POSIX 信号测试在 Windows 跳过；新占用模块的三系统 CI 待验证。

由一个写入者负责 Android 包的执行器、Java runtime bridge 和共享报告类型；CLI/MCP 在 SDK 生命周期通过后接入，同一项目的状态文件修改串行进行。现有跨平台 CI 和设备验收可以独立运行，互不占用这套专属 Gradle 用户目录。

先完成 JavaExec/Worker 与 bridge 强杀的托管验收，并补父 Node 退出、取消与正常完成竞争、专属 daemon 停止失败及重复恢复，再实现带占用保护的 SDK。验收必须证明无重复构建、未确认清理不释放占用、其他项目及用户默认 daemon 不被停止。随后提供 CLI/MCP 执行和取消，并将实际 Android 两模块 APK 构建从验证专用入口迁移到产品入口。

恢复与清理不能仅靠放宽超时。对无法控制的派生进程或不合作任务，执行器应返回明确的未恢复状态和证据；其完整支持仍属于原清单范围。当前原型不改变 39 项完成计数。
