# 设备锁检查与恢复基础

```sh
node packages/cli/dist/index.js device-lock <device-id>
```

查询不接触设备、不删除锁。无锁返回 `null`；存在时返回租约和 `owner`：`alive`、`dead` 或 `unknown`。仅同一主机且操作系统明确返回进程不存在时标记 dead。外部主机、权限不足、PID 复用导致仍有存活进程等情形不会推断可以恢复；损坏租约报错。

Android Flow 在创建运行目录后、执行夹具或动作前，通过 `bindDeviceLockRun` 将其绝对路径写入租约的 `runDirectory`，并在运行目录保存相同 token 的 `device-lease.json`。绑定仅限当前持锁调用域，拒绝重复绑定。租约元数据用临时文件原子替换，不会先删除锁。进程终止后两端关联仍保留；正常完成释放锁，但保留运行内的历史租约副本。

该关联覆盖 CLI/MCP 同步、异步和批量调用的 Android Flow；旧运行及独立设备命令没有此关联。恢复处理器后续必须验证租约与运行内副本一致，不应把导出或复制的历史运行当成当前锁。绑定不代表设备状态已经恢复。

真实子进程强制终止后关联保留已通过自动测试。模拟器 MCP Flow 取消回归 `protocol-cancel-1789539915198` 通过，运行内已保存 `device-lease.json`，取消后设备锁释放。

core 的 `recoverDeviceLock(deviceId, expectedToken, cleanup, directory?)` 为恢复处理器提供互斥原语。它检查旧 token 和进程状态，排他创建恢复守卫，保留原设备锁，调用 cleanup，再检查旧 token/进程状态。仅 cleanup 成功后释放原锁；清理失败保留它。恢复期间普通设备操作、第二个恢复者均被拒绝。

cleanup 必须恢复并验证该运行需要回收的状态。这个函数自身不证明设备已清理，不能传入空回调来解锁实际遗留运行。CLI 协调器已接入录屏/Perfetto、网络、AppOps、输入法和文件状态；各处理器仍需对应的真实异常验收。

## CLI 环境恢复

```sh
node packages/cli/dist/index.js device-lock <device-id>
node packages/cli/dist/index.js recover-flow <device-id> <lease-token>
```

`recover-flow` 检查死进程、预期 token、规范化运行路径、运行内租约副本、设备 ID、在线状态、型号和系统版本，随后依次恢复采集、网络、AppOps、输入法和文件。采集按持久 UUID 与设备进程命令行核对所有权；网络优先让独立 worker 收尾，必要时按代理值和本机进程命令行接管。每次恢复写入 `recovery/<attempt>.json` 和审计；单项失败时继续尝试其他状态，最终保留锁供重试，全部通过才释放。缺失、旧版、冲突或无法验证的记录不会被当成已经清理。

结果 `recovered` 的 scope 是 `environment-cleanup`，仅代表声明的外部状态已清理，不代表业务通过、事务回滚或断点续跑。不会重放动作或改写原步骤/运行结果；应用内写入、启动的应用和非夹具业务状态仍可能保留。异步任务历史仍呈现 interrupted，不会变成 passed。

组合真实验证：`node scripts/verify-flow-recovery.mjs emulator-5554`，证据 `flow-recovery-check-1789540714846`。验证活进程拒绝、真实 Flow 终止、文件/AppOps/输入法夹具协调、外部文件冲突时保留内容与锁、重试释放以及原动作日志未改写。运行时权限也已接入协调器，但尚未纳入该在线组合证据。录屏/Perfetto 与网络接管已实现并有无设备自动测试，仍缺少在线模拟器强杀进程树验收；恢复守卫自身中断仍待补齐。

## MCP 恢复入口

`inspect_device_lock({deviceId})` 只读查询，不尝试获取普通设备锁，因此活跃/遗留锁都可以检查。`recover_flow({deviceId, leaseToken})` 使用和 CLI 相同的恢复协调器与独立恢复互斥；token 必须为 UUID 格式，非法参数在访问设备前拒绝。

恢复启动前响应已取消请求；一旦进入清理，清理不随请求取消而中断，结果保存在运行的 recovery 目录。协议取消可能抑制返回消息，调用方应随后查询设备锁和恢复证据。不要重复提交来代替状态检查。此策略不保证 MCP 进程被强制终止后的恢复守卫接管。

真实 stdio 验证 `node scripts/verify-flow-recovery.mjs emulator-5554 --mcp` 通过，证据 `flow-recovery-check-1789540866401`：活锁查询、活进程拒绝、冲突保锁、重新启动 MCP 进程重试成功以及原动作日志保持不变。此为协议层验收，尚不代表三个 Agent 产品内接入均已验收；新增网络/录屏/Perfetto 接管仍待在线设备复验。

Android 已提供 `recoverImeFixture(deviceId, runDirectory)` 恢复处理器，调用者必须持有恢复所有权并匹配运行租约。新输入法记录为版本 2，包含设备 ID，原子写入；版本 1 不用于跨进程恢复。它重新读取设备当前状态，仅接受原状态或夹具可产生的中间状态；外部选择/启用列表变化时拒绝覆盖。已恢复状态可以重试，不依赖旧进程内存。

`node scripts/verify-ime-recovery.mjs emulator-5554` 创建只包含输入法修改的测试进程并强制终止，再用新进程读取记录、验证租约并恢复。真实验证 `ime-recovery-1789540159086` 覆盖外部启用列表冲突拒绝、恢复重试、错误设备拒绝、原状态校验及释放锁。`--retry-cleanup` 仅处理该测试留下的 IME-only 运行；不能用于任意完整 Flow。正常夹具四路径回归 `ime-fixture-check-1789540093406` 通过。

AppOps 也提供 `recoverAppOps(deviceId, runDirectory)`，同样要求调用者持有恢复所有权。版本 2 记录原子写入并绑定设备，逐项验证包名、操作、模式和重复项后逆序恢复；当前模式必须是原值或尚未恢复夹具的请求值。恢复完成的项会重新读回验证，外部修改不覆盖。每项恢复保留开始、成功或失败审计；错误设备及旧版本记录拒绝执行。

文件夹具提供 `recoverFileFixtures(deviceId, runDirectory)`，使用绑定设备的版本 2 原子记录，验证共享存储路径、临时路径、备份文件名和哈希。跨进程恢复仅接受准备后的内容或原内容/原缺失状态；其他内容保留并报告冲突。备份损坏、越出证据目录的链接、设备目标链接等拒绝处理。成功恢复原始字节，删除原本不存在的新文件，并检查重复恢复。

运行时权限夹具提供 `recoverRuntimePermissions(deviceId, runDirectory)`。记录绑定设备与 Android 用户，保存授权状态和规范化权限标志；恢复仅接受原值或夹具实际读回的准备值。用户切换、外部改值、非法记录和错误设备均拒绝处理。验证入口与当前边界见 [Android 运行时权限夹具](runtime-permissions.md)。

这比同一 Flow 的正常清理更保守：Flow 正常清理仍可撤销测试对文件的修改；中断后无法区分测试写入和外部写入，所以非原值/准备值需要后续处理，不能自动覆盖。当前不恢复文件时间/权限元数据，也不终止仍持有文件的应用进程。

`node scripts/verify-file-recovery.mjs emulator-5554` 真实验证通过：`file-recovery-1789540473210`，覆盖进程终止、外部内容保留、恢复重试、二进制原内容、新文件删除、设备不匹配拒绝和释放锁。正常 Flow 四路径回归 `file-fixtures-check-1789540516697` 通过；验证脚本现在显式启动 Markor，不依赖先前运行状态。

`node scripts/verify-appops-recovery.mjs emulator-5554` 的真实结果为 `appops-recovery-1789540302950`：进程终止、外部值冲突、重试、审计、原权限值及设备锁释放均通过。`--retry-cleanup` 仅适用于此 AppOps-only 测试。正常成功/失败/取消/部分准备失败/default 原值恢复回归 `appops-fixture-check-1789540304790` 通过。UID 级 AppOps、多用户与运行时权限不在这个处理器的支持范围。

恢复守卫现在包含版本、恢复 token、PID、主机、原 lease token 和开始时间。后续恢复者只在同一主机、同一 lease token 且操作系统明确确认守卫 PID 已死亡时，通过原子重命名争抢并接管；活 PID、跨主机、PID 状态未知、损坏记录或 token 不匹配均拒绝。普通设备操作也检查守卫：活恢复期间拒绝；若上一个恢复者已完成清理并删除原 lease、随后在删除守卫前崩溃，普通操作可在确认守卫 PID 死亡后原子清除该守卫。

自动测试覆盖死守卫接管、活守卫拒绝、第二恢复者互斥、清理失败保留 lease 和成功后重新获取。尚未在真实设备恢复过程中强杀恢复者；该机制依赖本机文件系统，不支持多个主机共享目录争抢设备，也不按文件年龄推断死亡。

`npm run build` 与 `npm test` 已通过。`packages/core/test/lease-recovery.test.mjs` 使用真实子进程持有锁再强制终止，验证活进程拒绝、旧 token 拒绝、失败保锁、普通操作/重复恢复互斥、成功后重新获取、外部主机拒绝和损坏租约拒绝。该测试不代表真实设备副作用恢复完成。
