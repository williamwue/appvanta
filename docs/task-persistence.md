# 异步任务持久化

MCP `start_flow` 先将设备、规范化 Flow 和 queued 状态写入 `.appvanta/tasks/<task-id>/task.json`，再启动独立本地 Worker，通过一次性 session 把任务所有权从 MCP 进程原子转移给 Worker。Worker 写入 `worker.ready.json` 后，`start_flow` 才返回任务 ID、状态和 Worker PID。随后运行状态、运行目录、结果和结束时间通过临时文件加重命名写入；只有记录中的 Worker PID/session 可以改写状态，其他进程只读或提交控制请求。

Worker 使用独立进程、隐藏窗口和断开的 stdio，不依赖启动它的 MCP stdio 会话继续存活。MCP `get_task`、`list_tasks` 和 CLI 从磁盘读取，因此 MCP 退出或重启后仍能查询、暂停、恢复、注入步骤和取消运行中的任务。必须在同一项目目录运行；不同项目的任务目录独立。

```text
node packages/cli/dist/index.js tasks
node packages/cli/dist/index.js task <task-id>
node packages/cli/dist/index.js pause-task <task-id>
node packages/cli/dist/index.js resume-task <task-id>
node packages/cli/dist/index.js cancel-task <task-id>
```

`cancel_task` / `cancel-task` 写入持久化 `cancel.request`。正在运行的 worker 每 200ms 检查请求并触发取消，等待 Flow 和网络清理。请求返回 `cancelling` 仅表示已请求；使用查询接口确认最终 `cancelled` 或清理失败的 `failed`。对终态再次请求取消不会改写历史。

`pause_task` / `pause-task` 写入 `pause.request` 并返回 `pausing`。owner 到达步骤边界后保存 `paused`，不会中断已经开始的动作。`resume_task` / `resume-task` 移除请求，owner 再保存 `running`；请求历史独立保存在 `controls/`。暂停不会释放 Flow 持有的设备锁或已经建立的网络/采集会话，因此适合短时间人工检查，不应用作长期资源停放。取消请求始终优先并会退出暂停等待。

## 中断与恢复边界

对于 queued/running/pausing/paused/cancelling 任务，查询检查本机 Worker PID。只有 OS 明确返回进程不存在时，才派生 `interrupted` 状态；不修改原始快照。访问被拒绝、远程主机或 PID 仍存在均不推断死亡。PID 复用可能使查询暂时保守地保留原状态。

`interrupted` 不等于可以继续执行：Worker 自身崩溃、宿主重启或强制终止后，旧代理、ADB 子进程和设备锁可能尚未恢复。当前不自动重放动作；应先使用统一恢复协调器处理环境和设备锁。显式断点续跑和不确定动作裁决已有下文及 [裁决验收](adjudication-cli.md) 所列模拟器证据；任意业务动作、宿主重启后的完整恢复及远程 Worker 仍待完成。

统一 Flow 执行器现在保存 `progress.json`：包含 Flow 哈希、设备 ID、递增 revision、已通过步骤及其原始索引、当前步骤和剩余队列；注入步骤保留 instruction ID。快照先写临时文件并同步文件内容，再原子重命名。阶段为 setup、boundary、executing、finalizing、finished。执行动作前保存 executing；仅在检查点和步骤采集结束标记通过后推进完成列表。完成报告后才写 finished。进度保存异常不会跳过既有资源清理。

真实 Node 子进程强杀测试覆盖第二步边界与第二步动作中断，确认第一步保留为已通过、第二步保留为 active、第三步仍在 pending。此证据只证明进程中断时的快照，不保证断电持久性。后续显式续跑入口已使用该快照并另行校验原 Flow 和证据、协调设备资源、复验应用检查点及已领取指令；不能直接根据 boundary 自动重放。

`node packages/cli/dist/index.js inspect-flow-progress <run-directory>` 提供只读一致性检查：核对 Flow 哈希、设备 ID、已完成记录与 `steps.jsonl`、原步骤顺序及完整性。非 boundary 阶段、步骤日志领先于快照、存在尚需指令存储核对的注入步骤均返回 `boundaryConsistent: false` 和非零退出码；损坏或缺失记录直接报错。即使边界一致也始终返回 `resumeAuthorized: false`，因为设备所有权、资源恢复与实时检查点仍须由执行入口检查；此诊断已校验已完成步骤引用的证据完整性。旧运行没有 progress.json 时不能推断可续跑。

已通过步骤现在记录所引用证据文件的 SHA-256 与字节数。检查器拒绝缺失、内容改变、相对路径越界或解析后越出运行目录的链接。只有 `recovery.jsonl` 允许后续追加：校验该步骤完成时的原长度前缀；修改或截断前缀仍失败。该校验覆盖已通过步骤的引用文件，不覆盖整包证据、任务指令存储，也不提供防恶意重写整个快照的签名保证。

`inspect-task-progress <task-id>` 在进度检查之上绑定任务的原 Flow、运行目录和设备，并核对持久指令：已完成步骤对应 applied，active/pending 对应 claimed，快照外只允许 queued。已领取但未进入快照、缺失指令、内容变化或状态冲突都会阻止边界通过。仍存活的任务、已终态任务和已有取消请求同样不能作为续跑候选。强杀测试验证 interrupted 判断和指令冲突检查；该命令仍为诊断入口，既不释放设备锁也不执行剩余步骤。只读结果是当时快照；后续执行入口必须在独占恢复权下重新校验。

内部 `continueRecoveredDevice` 在恢复守卫下完成清理并原子替换租约，随后在新租约范围执行回调；期间不删除旧锁再抢新锁。回调正常返回才释放新租约，抛错时保留新租约供检查。Android `continueAndroidFlow` 已复用原有设备身份核验和资源恢复流程，并把源运行目录交给回调。后续 CLI/MCP 显式续跑已接入该能力，并须在新租约下绑定运行、复验检查点及协调任务所有权。准备阶段崩溃已有下文限定恢复路径；无准备标记的历史未绑定租约仍须保守处理。

新租约保留 `recoveredFrom`（旧 token 和可用的源运行目录）。若接管已完成但旧恢复守卫未删除，只允许在守卫 token 与该前任记录匹配、守卫进程明确死亡时重新接管；错误 token 或存活守卫仍拒绝。测试覆盖这三种守卫状态。该来源信息用于追溯，不表示未绑定新运行时可以推断回调没有产生副作用；这类运行仍须保守处理。

MCP `start_flow`、`start_flows` 和 `start_monitor` 都使用独立本地 Worker。CLI 同步 Flow 仍绑定 CLI 进程。该机制覆盖 MCP 服务进程退出，不代表 Worker 自身崩溃、宿主断电后的自动续跑或完整灾难恢复。

## 验证

### 显式 CLI 续跑

Android 绑定现先同步保存租约旁的 `.binding-<token>.json` 意图，再写运行副本并原子更新租约。统一 recover-flow 对未绑定租约只接受匹配 token/owner/来源的 Android 意图、未变化的绝对运行路径、planned 元数据，且 flow/progress/steps 均不存在；写恢复审计后才释放租约。真实子进程测试通过绑定失败后强杀、恢复成功，以及执行证据/意图篡改拒绝。它不恢复旧版本无意图记录的租约，也不覆盖接管完成但尚未调用绑定的窗口；没有声称恢复业务动作或完成运行。意图记录保留以供审计。

Worker 再次强杀：`node scripts/verify-task-continuation.mjs emulator-5554 worker crash`，证据 `.appvanta/runs/task-continuation-1790425372574/verification.json`。新 Worker 在恢复检查点 executing 阶段被 SIGKILL 后，新任务派生 interrupted，没有完成步骤或完成通知；inspect-task-progress 返回 phase-executing，续跑拒绝，随后 recover-flow 清理已绑定租约。此结果证明不确定执行状态不会自动重放，不代表已实现该状态下的业务恢复。

2026-09-26 曾遇到 Windows 查询租约并发造成绑定 rename 的 EPERM；绑定时现对 EPERM/EACCES/EBUSY 做最多 20 次、间隔 25ms 的有界重试，仍使用原子替换，不删除锁。失败样本在副作用前停止：新运行仅有初始元数据、租约副本与空证据目录，源流程无夹具或采集。核对后通过恢复守卫释放，审计为 `.appvanta/runs/2026-09-26T12-21-17-830Z-emulator-5554-cd36228c/binding-recovery.json`。这次处理依赖人工证据核对；后续意图记录和准备标记覆盖特定未绑定窗口，但无标记的历史租约及并发压力验收仍待完成。

成功与失败完成事件在线回归：`.appvanta/runs/task-continuation-1790425128249/verification.json`，保存启动 MCP 与独立 Worker 的 PID，并验证本地通知 taskId/status 与新任务一致。结合下述取消场景，三种终态均已有 API 37 实测。

续跑任务现在与普通任务一样保存本地 `notifications/completion.json`，并将通知记录写入新任务终态；事件分别保留 passed/failed/cancelled，不把通知视为业务通过。当前不继承源任务的 Webhook，续跑 Webhook 配置仍待设计。后台取消在线证据：`.appvanta/runs/task-continuation-1790425095555/verification.json`。启动 MCP 退出后，另一个 CLI 进程在新检查点 executing 时请求取消，Worker 保存 cancelled 和一个取消步骤，没有执行剩余动作；通知状态一致，保留租约经 recover-flow 清理。

后台续跑入口 `start_task_continuation` 使用相同参数，由独立隐藏 Worker 完成认领、资源恢复和执行。请求保存在 `.appvanta/continuations/<request-id>/request.json`，ready 记录包含新任务与 Worker PID/session；MCP 验证其与任务所有权一致后才返回。启动超时不杀 Worker，需先检查请求目录的 ready/error/result，避免重复操作。API 37 验收 `node scripts/verify-task-continuation.mjs emulator-5554 worker` 已通过：启动 MCP 退出后 Worker 完成剩余流程，检查点失败仍阻止后续动作，失败租约恢复后释放。证据 `.appvanta/runs/task-continuation-1790424951486/verification.json`。后续后台取消、启动阶段取消、Worker 再次崩溃及完成通知的有界证据见下文；不确定动作人工裁决仍待完成。

MCP 现提供 `inspect_task_progress` 与同步 `continue_task`（taskId、leaseToken、checkpoint），复用同一 Android 续跑实现。公开 Schema 限定检查点类型，拒绝 UI 变化/屏幕稳定及非法 token，参数错误在设备操作前返回。此工具仍绑定 MCP 进程，不是独立后台 Worker。`node scripts/verify-task-continuation.mjs emulator-5554 mcp` 已通过 API 37 正常续跑、检查点失败阻止后续动作、重复拒绝和失败租约清理，证据为 `.appvanta/runs/task-continuation-1790424780000/verification.json`；不代表 MCP 退出后仍可续跑或三款 Agent 产品内验收。

`continue-task <task-id> <lease-token> <checkpoint.json>` 对已中断的单任务执行显式续跑。检查点文件是 Condition JSON，例如 `{"kind":"text-visible","text":"Ready"}`。恢复守卫内先核对任务与租约的源运行，再通过原子创建 `tasks/<id>/continuation/` 防止重复认领，并保存同步落盘的 `claim.json`。资源恢复和租约接管后创建新任务，`successor.json` 指向新任务；新运行的 `continuation.json` 保存源进度与步骤映射，原任务保持中断历史。

续跑首步验证检查点，在它通过前不领取新任务的注入指令。后续支持新任务的取消、暂停和步骤注入。源任务指令保持历史状态，其续跑执行结果通过来源映射和新运行步骤查阅。应用重置不会重放；文件及权限等夹具会重新准备，仍需检查点确认业务状态。此 CLI 入口绑定 CLI 生命周期，另有下文独立 Worker/MCP 入口。认领后出错保留预约目录；失败或取消保留设备租约，不自动再次从旧任务开始。安全重认领仅覆盖下文租约转移前取消情形，后继任务创建后的重试仍待完成。

API 37 模拟器验收：`node scripts/verify-task-continuation.mjs emulator-5554`，证据 `.appvanta/runs/task-continuation-1790424592858/verification.json`。真实 Android Flow 第一条 Home 动作完成、第二步边界强杀 owner；CLI 成功续跑保存检查点、Back 与最终记录三步，没有重放 Home，保留旧任务 interrupted 与新旧运行映射。缺失文字检查点场景仅执行一个失败步骤，后续动作没有执行；保留死 owner 的设备租约经 recover-flow 清理，重复请求被拒绝。该验收不覆盖动作执行中恢复、文件业务数据、应用重置在线续跑、注入指令在线顺序、MCP/Worker 或接管途中再次崩溃。

core 的 `prepareFlowContinuation` 从同一次读取并校验的快照生成剩余 Flow：跳过已完成动作，保留当前已选步骤，随后插入排队指令与剩余步骤；保存源运行、revision、Flow 哈希和步骤来源映射。新 Flow 首步必须是显式应用状态检查点，不接受仅 UI 变化或屏幕稳定作为恢复依据；删除 `resetApplications` 并列出被省略的重置包。其他资源配置保留，因此执行入口仍须协调资源恢复，并在重新准备夹具后复验检查点。强杀测试覆盖执行中拒绝、边界队列顺序与重置省略。对于不确定后继，core 的只读预览仍返回 `resumeAuthorized: false`；它不裁决业务动作，CLI/MCP 的有界续跑也不能据此自动重放不确定动作。

```text
npm run build
npm test
node scripts/verify-tasks.mjs emulator-5554
node scripts/verify-independent-workers.mjs emulator-5554
```

自动测试覆盖并发状态写入、终态保护、所有权原子转移、非法任务 ID、非所属 Worker 写入拒绝、Worker 退出后的中断判断，以及 MCP 进程退出后独立 Worker 保存终态和本地完成通知。早期 API 37 模拟器在线验收覆盖 Flow、批次和监控在启动 MCP 退出后继续完成，以及新 MCP 跨进程取消/释放：`.appvanta/runs/worker-restart-check-1790109477881/verification.json`。后续暂停/恢复/运行中指令及续跑 Worker 强杀已有各自有界证据；宿主重启后的安全续跑和真机仍待验收。
# 续跑启动取消补充

租约转移前的取消现在写入 `cancelled-before-transfer.json`，仅在环境恢复成功后记录。再次使用相同源任务与租约续跑时，设备恢复守卫内检查取消记录、claim ID、源任务、设备、租约 token、原 Worker 已退出及无 successor；满足后将旧目录原子归档到 `continuation.cancelled-<uuid>`，重新检查任务进度并建立新认领。原认领和取消证据不删除。无记录、Worker 存活或存在后继任务时不执行这条重试路径。

Android 续跑在清理成功、原子转移租约时记录 `preparationScope: android-flow`。此阶段允许运行准备，所有设备修改必须在后继运行绑定后开始。若 Worker 在转移后、绑定意图落盘前退出，`recover-flow` 核对死进程、准备标记、原运行目录和前任绑定 token，保存 `preparation-recovery-*.json` 后释放租约；不重放业务步骤。若存在绑定意图则必须走原有绑定恢复检查，损坏记录不降级为准备阶段恢复。

API 37 实际环境恢复、租约转移后强杀及显式释放通过：`.appvanta/runs/startup-cancel-1790428142783/verification.json`，复验命令 `node scripts/verify-continuation-startup-cancel.mjs emulator-5554 transfer-crash`。子进程测试同时覆盖标记缺失、前任 token 不符、损坏意图拒绝。没有该标记的历史未绑定租约仍不能据此自动释放；续跑认领的安全重试另行处理。

加入 MCP 返回前绑定核验后的 API 37 正常续跑与检查点失败回归均通过：`.appvanta/runs/task-continuation-1790427938613/verification.json`。成功只执行检查点及剩余两步；失败只执行检查点，后续动作被阻止，通知与显式租约恢复均通过。

续跑 Worker 的 ready 在后继 Flow 初始化完成、首个检查点执行前发布。此前已绑定 device-lease.json 并保存 flow.json、progress.json 和任务运行目录；MCP 返回前核对绑定的 Worker PID、设备和运行目录。API 37 已验证 ready 对应上述证据，原 MCP 退出后的检查点取消、完成通知及租约恢复通过：`.appvanta/runs/task-continuation-1790427807882/verification.json`。ready 不代表检查点或整个任务通过。

`start_task_continuation` 接收 MCP 请求取消信号。返回 ready 前取消会在请求目录写入持久 `cancel.requested`，Worker 启动前检查并每 50ms 轮询；创建后继任务的回调在发布 ready 前再次检查。取消不会强杀 Worker，也不会中断必须完成的环境清理。若恢复已开始，清理结束后在进入后继执行前响应取消；应读取 error/result、任务及设备锁状态确认最终结果，不能把请求返回视为清理完成。

返回 ready 后使用 `cancel_task` 管理后继任务，原 MCP 正常退出不取消独立 Worker。自动测试覆盖预取消不触及源任务、运行中持久取消检测和真实 Worker 子进程启动前取消。API 37 实测在续跑认领后取消，环境恢复结束后、租约转移前响应取消，原始绑定租约保留、无 ready/后继任务，显式 recover-flow 成功释放：`.appvanta/runs/startup-cancel-1790427732889/verification.json`。可用 `node scripts/verify-continuation-startup-cancel.mjs emulator-5554` 复验。

API 37 租约转移前取消后的重新认领通过：`.appvanta/runs/startup-cancel-1790428441053/verification.json`。命令 `node scripts/verify-continuation-startup-cancel.mjs emulator-5554 retry` 验证旧 Worker 退出、原认领归档、使用原租约续跑、检查点与唯一剩余动作执行，已完成 Home 不重放。原任务历史保留。此段为早期验收边界。后续已补连续未绑定转移重试、指定夹具恢复途中取消及 Markor 输入副作用裁决；证据和剩余限制分别见 [裁决验收](adjudication-cli.md) 与 [网络采集](network-capture.md)。不能据此推广到全部夹具或任意业务动作。

## 分支与动态值的持久性

已完成步骤包括 passed 和 skipped。分支决定、条件结果及提取值均与步骤和证据摘要核对。续跑固定已验证分支及字符串值，不因当前界面变化重新选择或重新提取；尚未完成的提取不能通过跳过裁决补造值。API 37 已验证提取后、输入前强杀的 CLI 续跑，CLI/MCP 正常读写也通过，见 [动态文本值](flow-values.md)。读取中和仅值文件落盘后的拒绝路径有真实宿主进程强杀测试，使用测试 Driver，尚无对应设备中断验收。
