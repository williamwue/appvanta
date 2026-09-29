# 人工裁决后的 CLI 续跑

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
