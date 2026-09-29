# 人工裁决后的 CLI 续跑

MCP 同样提供 `preview_uncertain_task`、`adjudicate_task`、`prepare_adjudicated_task`、`reserve_adjudicated_task` 和 `continue_adjudicated_task`。
每个工具使用 `taskId`；其余输入分别放在 `decision`、`expectation` 或 `receipt` 对象中，字段与下述 JSON 文件一致。
执行同步绑定 MCP 进程，取消使用预约返回的后继任务 ID；准备与预约不执行设备动作。
2026-09-29 API 37 模拟器通过 `node scripts/verify-task-continuation.mjs emulator-5554 worker crash mcp-adjudicate` 验证了真实 Worker 强杀后的五工具完整调用，最终任务 passed 且租约释放。该验收仍仅覆盖只读等待中断，不包含 Codex/Claude Code/Cursor 产品内安装验收。

在任务所属项目根目录执行命令，任务保存在 `.appvanta/tasks`。
所有命令输出 JSON；失败返回非零退出码。先保留原运行证据与设备租约。

1. `appvanta preview-uncertain-task <task-id>`：读取不确定步骤预览，保留 `previewDigestSha256`。
2. 人工检查应用实际状态。创建 `decision.json`，包含 `expectedPreviewDigestSha256`、`expectedLeaseToken`、`operator`、`reason`、`verdict`。只有确认后置条件已满足时，才选择 `postcondition-verified-skip` 并提供描述应用状态的 `postconditionCheckpoint`；未确认使用 `unresolved`。
3. `appvanta adjudicate-task <task-id> decision.json`：持久化裁决，保留返回的裁决 `id`。
4. 创建 `expectation.json`，包含 `decisionId`、`previewDigestSha256`、`leaseToken`；执行 `appvanta prepare-adjudicated-task <task-id> expectation.json`。
5. 创建独立保存的 `receipt.json`：保留上述三个字段，加上返回的 `claim.id` 作为 `preparationId`，以及 `preparationDigestSha256`。执行 `appvanta reserve-adjudicated-task <task-id> receipt.json`，记录返回的后继任务 ID。
6. `appvanta continue-adjudicated-task <task-id> receipt.json`：使用同一个被裁决任务 ID 与回执，恢复环境、转移精确匹配的已失效租约，并在设备上先验证后置条件，再执行剩余步骤。

准备和预约不会执行设备动作。执行命令同步等待完成，可用 Ctrl+C 或另一终端的 `appvanta cancel-task <后继任务-id>` 请求取消。失败保留租约以供检查。

不要修改回执或手动删除租约来绕过拒绝。租约转移后再次崩溃的自动恢复尚未完成；旧回执不能直接用于新的租约。当前 CLI 验证覆盖输入拒绝，核心和 Android 模拟执行测试覆盖裁决及取消逻辑，完整设备路径仍待模拟器验收。

2026-09-29 API 35 / Android 15 模拟器实测：运行
`node scripts/verify-task-continuation.mjs emulator-5556 worker crash adjudicate`，
真实 Worker 被强杀后，预览、裁决、准备和预约均通过，但执行被未决租约日志拒绝。
日志中的 `run-created-callback` 已完成，包裹后继 Flow 的 `nested` 操作仍为 pending。
因此人工裁决尚不能完成这条实际崩溃恢复路径；不得把该场景标为通过，也不得删除日志绕过检查。
本地失败证据：`.appvanta/runs/task-continuation-1790696189505/verification.json`。
该目录被 Git 忽略，未随源码发布。后续验证脚本会在失败时保存当前租约和错误。

同日修复后的 API 37 / Android 17 实测通过：
`node scripts/verify-task-continuation.mjs emulator-5554 worker crash adjudicate`。
新 Flow 的租约日志使用 `android-flow` 类型，并在设备动作前同步写入操作 ID、租约 token、设备和规范运行路径的绑定。
恢复仅接受一个具有匹配绑定的未决 Flow，拒绝其他未决操作和未完成的日志写入；环境清理后重新核对日志摘要并记录审计。
本次真实 Worker 强杀发生在只读等待中，CLI 全链路随后完成，已完成的 Home 未重放，剩余 Back 通过，最终租约释放。
本地证据：`.appvanta/runs/task-continuation-1790696574750/verification.json`。
这不覆盖任意动作、所有环境夹具、真机或裁决续跑再次崩溃。API 35 的旧通用 `nested` 记录仍保留，不据此升级为可自动恢复。

文件夹具补充验收（API 37，2026-09-29）：
`node scripts/verify-task-continuation.mjs emulator-5554 worker crash mcp-adjudicate file-fixture` 通过。
验收先创建包含中文和换行的原始文件，源 Flow 与后继 Flow 应用临时内容；后继被强杀时确认设备仍为临时内容。
MCP 裁决续跑完成后，源运行、中断后继和最终后继的三份夹具记录均标记已恢复，原始 SHA-256 一致，设备文件与原始字节匹配，租约释放。
通过后仅删除本次唯一命名的测试文件。证据位于 `.appvanta/runs/task-continuation-1790697088108/verification.json`。
这不覆盖外部修改冲突、权限/输入法/代理等其他环境夹具，或真机存储差异。

外部修改冲突补充验收（API 37，同日）：
`node scripts/verify-task-continuation.mjs emulator-5554 worker crash mcp-adjudicate file-conflict` 通过。
Worker 崩溃后注入不同文件内容，首次执行拒绝恢复且保留这些字节、原租约和预约任务文件；没有创建新的运行目录。
仅在确认注入内容未再次变化后，验收器撤销自身的修改，再用同一回执完成 MCP 重试，最终恢复原文件并释放租约。
证据：`.appvanta/runs/task-continuation-1790697305917/verification.json`，其中保留首次拒绝时的夹具错误记录。
首次验收脚本曾误把已退出预约进程对应的 `TaskStore.get()` 投影状态当成磁盘状态，已改为核对任务文件原始字节。
该次失败记录 `task-continuation-1790697205172/verification.json` 保留，后续同回执 CLI 恢复记录在同目录的 `manual-test-retry.json`。
产品仍不会自动撤销外部修改；其他环境夹具和再次崩溃恢复仍待验收。

新的裁决执行记录同步持久化 `preparationReceipt` 和 `reservationDigestSha256`。
`readAdjudicatedExecution(store, predecessorTaskId, successorTaskId, independentlyRetainedReceipt)`
只读核对回执、预约、任务 Flow、实际运行 Flow 与运行链路，返回 `resumeAuthorized: false`。
旧的缺少回执记录不能自动通过该校验。该校验是再次崩溃恢复的证据基础，不是重启入口。
API 37 的 MCP 裁决实测及实际产物读取通过，证据：`.appvanta/runs/task-continuation-1790697508566/verification.json`。

2026-09-30：裁决任务在明确步骤边界再次崩溃时，可使用：

```text
appvanta restart-adjudicated-task <原被裁决任务-id> <已崩溃裁决后继-id> <原receipt.json> <当前lease-token> <新checkpoint.json>
```

入口先检查独立保留的原回执及执行链路，在恢复保护范围内与环境清理后再次校验链路，再沿用步骤边界续跑检查。
它创建新的后继，不复用旧租约 token，不重放已完成步骤；`executing` 等不确定状态仍拒绝，需要后续裁决能力。
API 37 实测命令 `node scripts/verify-task-continuation.mjs emulator-5554 worker crash mcp-adjudicate file-fixture restart-boundary` 通过：
真实裁决进程在首个检查点完成后的第二步骤边界被强杀，新 CLI 入口恢复成功，四次运行的文件夹具均恢复原内容，最终租约释放。
证据：`.appvanta/runs/task-continuation-1790697687652/verification.json`。第二次崩溃由 API 包装器的步骤前钩子精确触发，重启通过 CLI；未验证产品内 MCP 客户端或第二次动作执行中的崩溃。

MCP 入口 `restart_adjudicated_task` 接受 `predecessorTaskId`、`successorTaskId`、`receipt`、当前 `leaseToken` 和新 `checkpoint`。
它同步等待恢复完成，遵循相同链路校验和步骤边界约束。
2026-09-30 API 37 实测 `node scripts/verify-task-continuation.mjs emulator-5554 worker crash mcp-adjudicate file-fixture restart-boundary-mcp` 通过，四次运行的文件夹具恢复，最终租约释放。
证据：`.appvanta/runs/task-continuation-1790697858829/verification.json`；此处使用真实 MCP 子进程，未替代 Codex/Claude Code/Cursor 产品内安装验收。

再次不确定中断的代码路径已接通：`preview_uncertain_task` 现在识别具有完整执行回执的裁决后继，使用其直接前驱的裁决准备与预约重建 Flow，并对当前不确定步骤产生新的预览摘要。
后续继续使用原有裁决、准备、预约和执行入口，目标 ID 改为本次中断的裁决后继；必须使用新的预览摘要、当前租约和新观察的后置条件。
普通链路与裁决链路同时出现、缺失、摘要不匹配或源进度不一致均拒绝。
当前新增证据为模拟第二次 executing 崩溃后的全链路测试，包含第二次执行及其记录校验；真实模拟器再次 executing 崩溃尚待验收，不能据此勾选 P0-03。

2026-09-30 API 37 的再次 executing 崩溃验收已通过：
`node scripts/verify-task-continuation.mjs emulator-5554 worker crash mcp-adjudicate file-fixture repeat-adjudication`。
第一次裁决任务完成检查点及 Back 后，在一个新的只读等待步骤执行中被真实强杀。
普通边界重启因 `phase-executing` 拒绝；MCP 使用新的预览、当前租约及新观察的后置条件完成第二次裁决。
最终运行既没有重复 Home/Back，也没有重放被裁决的等待步骤；四次运行的文件夹具恢复原内容，最终租约释放。
两代裁决执行链路均通过读取校验。证据：`.appvanta/runs/task-continuation-1790698359389/verification.json`。
此证据覆盖只读等待的不确定状态和文件夹具，不证明任意写入动作、所有其他夹具或租约转移后尚未绑定运行时的崩溃恢复。

租约转移顺序补强（2026-09-30）：新租约发布前先创建并同步其 admission 日志，然后同步临时租约文件，最后原子替换原租约。
日志初始化写入或同步失败时，原租约与 token 保留，后继执行不启动；使用同一原 token 重试的故障注入测试通过。
该顺序消除了“新租约已可见但其日志尚未创建”的正常发布窗口；不等于转移后、运行绑定前的完整任务重试已完成，也不追溯修复旧缺失日志。

2026-09-30：Android API 的 `continueAdjudicatedAndroidTask` 增加可选 `transferRetryToken`。
它仅接受原裁决租约的直接转移后继：持有进程已退出，版本 2 日志只有初始化记录，没有运行绑定意图或清理标记，来源运行的原租约副本精确匹配。
重试仍校验原准备回执和预约任务，并在恢复前复核；使用当前转移 token 恢复，沿用原预约任务和执行回执。
离线测试覆盖成功重试，以及活跃持有者、错误 token、清理标记、绑定意图、来源副本篡改、未决操作和已完成操作的拒绝。
此处的成功执行使用注入的恢复与运行函数，尚未证明实际 Android 恢复；CLI/MCP 参数和模拟器转移后强杀验收仍待接入。
该入口不支持连续多次未绑定转移的链路，也不自动修复历史缺失日志。P0-03 保持未完成。

同日 CLI/MCP 已接入上述重试：

```text
appvanta continue-adjudicated-task <task-id> <receipt.json> [transfer-retry-token]
```

MCP `continue_adjudicated_task` 对应可选 `transferRetryToken`，仍使用原始 `receipt`。
API 37 的 `worker crash mcp-adjudicate file-fixture transfer-before-bind` 与
`worker crash adjudicate file-fixture transfer-before-bind` 两个验收均通过。
验收在真实环境恢复和租约转移完成、预约任务认领后，用 API 运行钩子暂停于新 Flow 准入前，随后强杀该进程。
确认没有后继运行目录；不提供新 token 的旧回执被拒绝，提供当前 token 后同一预约任务完成，三个运行的文件夹具恢复、最终租约释放。
MCP 证据：`.appvanta/runs/task-continuation-1790699188718/verification.json`；
CLI 证据：`.appvanta/runs/task-continuation-1790699244988/verification.json`。
各目录的 `unstarted-transfer.json` 保留被强杀进程的租约及重试前后相同的任务 ID。
这覆盖单次转移后尚未准入的崩溃，不覆盖运行绑定进行中、连续多次未绑定转移或真机/OEM。

写入副作用验收尝试（2026-09-30，未通过）：新增 `scripts/verify-adjudicated-volume.mjs`，
在真实音量按键驱动返回、步骤完成记录落盘前暂停并强杀，独立读取音量后才允许裁决。
API 37 的音量加请求虽出现在 AudioService 日志中，读取的音乐音量仍为 5，未满足增加一次的前提，因此没有进入裁决，不能作为避免重复写入的成功证据。
失败记录保留于 `.appvanta/runs/adjudicated-volume-1790699773104/verification.json`。
该中断运行随后通过 `recover-flow` 显式清理；此前夹具未规范化 Flow 的失败运行也已通过该入口清理。
更早的准备试验使用 `media_session --set` 后发现读写路由不一致（speaker 读回 5，usb_headset 记录 3），缺少该路由修改前快照，不能声明全部音频设备状态已恢复。
当前验收脚本已移除该准备写入，只读取原值，并在成功情况下用反向按键恢复读回值。
该模拟器上的音量副作用尚未确认，后续需要可独立核对内容的输入场景；P0-03 保持未完成。

Markor 输入副作用验收（2026-09-30，API 37）已通过：
`node scripts/verify-adjudicated-input.mjs emulator-5554`。
验收创建独立文件，临时 AppOps 授权记录原状态；先在输入前的步骤边界中断，再启动后继。
后继实际执行 ASCII 文本输入，驱动返回后、Flow 完成记录写入前由验收钩子暂停并强杀。
此时进度为 executing；独立读取编辑器全文，确认标记仅出现一次，移除标记后的文本与原文精确相等。
裁决使用新的预览摘要及当前租约，检查点要求该标记在界面可见；文件名与标记不同，避免标题误匹配。
CLI 续跑跳过输入，仅完成新的检查点、剩余保存及最终证据步骤；设备文件与中断时编辑器全文相等，没有重复标记。
最终停止 Markor，核对文件未被外部修改后仅删除本次文件，恢复 AppOps，设备租约为空。
证据：`.appvanta/runs/adjudicated-input-1790700200422/verification.json` 和同目录 `fixtures/appops.json`。
先前验收器直接在存活父进程中预约导致子 CLI 被正确拒绝的记录 `adjudicated-input-1790700100818` 保留；父进程退出后，同回执完成恢复，见其 `manual-retry-verification.json`。
这证明单次 Markor ASCII 输入中断后的避免重放与保存，不覆盖其他编辑器、Unicode 输入、并发外部编辑或所有环境夹具；P0-03 仍未完成。

同日 Unicode 补充验收通过：`node scripts/verify-adjudicated-input.mjs emulator-5554 unicode`。
载荷包含中文、café、换行、单双引号、`& < > %s ; $()`；验收通过 UI 树解析器还原 XML 转义，比较完整输入和原文，而非只查找标记。
输入经 AppVanta IME 桥接实际提交；真实进程强杀点位于驱动返回之后、Flow 步骤完成记录之前。
驱动返回时及裁决续跑后，默认输入法和启用列表均与验收前一致，原本未启用的 AppVanta 输入法没有残留启用。
剩余保存步骤完成，最终文件与观察文本精确匹配，测试文件删除、AppOps 恢复，设备租约为空。
证据：`.appvanta/runs/adjudicated-input-1790700376759/verification.json`。
这不覆盖 IME COMMIT 尚未返回或输入法清理过程中强杀，不证明其他编辑器或任意 Unicode 字符均通过。

连续未绑定转移恢复（2026-09-30）：每次转移在新租约发布前以独占创建方式同步保存前驱租约快照。
显式重试读取当前 token 对应的前驱链，逐段验证设备、来源路径、仅初始化的日志、无绑定意图和无清理标记；缺失快照、token 不匹配、循环、中间已准入操作均拒绝。
读取上限为 1024 段，超过上限拒绝自动恢复；未改变原回执及预约任务身份。
Android 准备阶段清理也使用该链证明，从而支持多次转移后仍未绑定运行的情况。
写入/同步前驱快照失败时原租约保持不变，后继执行不启动；对应故障注入测试通过。
完整测试 core 95、Android 74、脚本 36 项通过后，新增两个快照故障场景的 core lease-recovery 31 项聚焦测试通过。
API 37 实测 `node scripts/verify-task-continuation.mjs emulator-5554 worker crash mcp-adjudicate file-fixture repeat-transfer-before-bind` 通过。
验收连续强杀三个已转移且已认领同一预约任务、尚未准入 Flow 的进程，再用原回执和最新 token 经 MCP 完成执行；文件恢复且租约释放。
证据：`.appvanta/runs/task-continuation-1790700678778/verification.json`；同目录 `unstarted-transfer.json` 保存三份被强杀租约及重试任务 ID。
以上补充取代早期“不支持连续未绑定转移”的实现边界；历史缺失快照的多段链仍拒绝，运行绑定进行中或 IME 内部未决操作不在此次验收范围。
