# 模拟器摇动与恢复

Android Emulator 的 [sensor 控制台接口](https://developer.android.com/studio/run/emulator-console) 可以读取与设置三轴 acceleration。`packages/android/src/emulator-sensors.ts` 提供内部摇动与恢复辅助函数；受管理的 Android Flow 已接入 `shake` 动作，可通过 CLI `run-flow` 和 MCP `run_flow` 执行。MCP `execute_action` 的摇动请求及 SDK `runAndroidAction(deviceId, action, signal?)` 使用单步骤受管理 Flow，返回 `success`、时间、运行状态、报告路径和 `cleanupFailed`。基础 `AdbDriver.execute` 未配置受管理恢复目录时仍拒绝摇动。

```json
{"name":"Emulator shake","steps":[{"description":"Shake and restore","action":{"kind":"shake","axis":"x","amplitude":12,"cycles":3,"intervalMs":150}}]}
```

Flow 动作参数均需明确填写，幅度、周期和间隔为整数。动作恢复记录保存在运行目录 `fixtures/emulator-sensors`，Flow 最终清理及标准 `recover-flow` 都校验并恢复该目录。恢复冲突会保留租约；动作报告恢复无法确认时，不再执行声明的业务重试或后续步骤。恢复只还原环境，不重放被中断的摇动或其他业务动作。目录中的未知文件、非普通文件及缺失原记录的回执会导致保守拒绝。

摇动先读取原始三轴值，再生成指定轴的正负交替偏移，保留另外两轴及原始重力分量。幅度限制 1–30，周期 1–20，采样间隔 50–1000 毫秒。仅接受 `emulator-N` 序列号；读取必须包含完整向量和 OK，写入必须确认 OK 并读回。数值比较容差为 0.0001，与控制台打印精度相容；这不是物理传感器精度保证。

重复恢复先验证原记录的计划向量与选项一致，再检查成功回执的版本、设备、原记录摘要、恢复值和时间。有效回执表示该记录已完成，重试不再读取或写入传感器，以免覆盖后续合法变化；无效或不完整回执拒绝恢复。新回执以独占创建和 fsync 保存，不能覆盖旧回执。它证明历史恢复完成，不证明当前传感器仍等于当时原值。此规则是后续接入统一恢复入口的前置约束。

第一条写入命令之前，以独占创建和 fsync 保存包含设备、原值和全部计划向量的恢复记录。正常结束、动作失败或取消均进入不受调用方取消信号影响的恢复：只有当前值等于原值或计划值之一时才恢复，随后读回确认。外部冲突、断连或无法确认恢复会抛错并保留记录；恢复完成另写绑定原记录摘要的回执，不覆盖原记录。调用方必须持有设备租约，并在恢复无法确认时保留租约。

`node scripts/verify-emulator-shake.mjs emulator-5554` 的 API 37 证据位于 `.appvanta/runs/emulator-shake-1790707979799/verification.json`：正常六次读回通过；取消场景先观察到加速度改变，再发取消，最后原值恢复。此脚本使用独立租约且在恢复无法确认时保留租约。

应用回调补充：独立测试 APK `dev.appvanta.sensorprobe` 注册加速度传感器，将带会话 ID 的事件写到应用私有文件，经 `adb run-as` 读取。API 37 初次报告 `.appvanta/runs/sensor-events-1790708531028/verification.json` 包含 113 条实际事件，X 轴约为 -12 到 +12，原值恢复。最终脚本先停止探针再读取日志，保留 APK 摘要和原始事件；API 35 托管任务已接入，结果需绑定实际提交。

尚未完成：任意应用摇动检测器响应、设备断连恢复、多设备和真机/OEM。当前不得把单一探针或单台模拟器成功当作完整产品摇动能力已验收。

外部冲突实测：API 37 报告 `emulator-shake-1790709228769/verification.json` 验证正常摇动、实际改变后的取消恢复，以及计划向量之外的 X=3 冲突。恢复函数拒绝覆盖该值，恢复记录字节不变且无成功回执；验证夹具在同一租约内清理自己注入的冲突并确认原值。此场景使用预置恢复记录，不代表已验证宿主强杀后的标准恢复准入。脚本也已接入 API 35 托管任务，结果需绑定后续运行。

最终脚本 API 37 复验：`sensor-events-1790708604781/verification.json`，105 条应用事件；40 项脚本测试通过。上述回调事件不依赖截图/OCR 或控制台读数推断，而来自测试应用的 `SensorEventListener`。

API 35 托管验收：公开快照 `7b65ebc`（本地 `06464fa`）的 [运行 36616671566](https://github.com/williamwue/appvanta/actions/runs/36616671566) 中 `Verify application accelerometer callbacks` 步骤通过，Android 任务及三个桌面系统任务均成功。当前已核验步骤结果，尚未下载独立核验该次原始事件归档；此结果仍不覆盖上述待办边界。

恢复回执修正验收：新增 5 项测试在修复前全部失败、修复后通过，覆盖重复恢复、完成后状态变化、损坏/摘要不匹配的回执及计划不一致；Android 全套 83 项通过。API 37 报告 `emulator-shake-1790709439252/verification.json` 同时确认完成记录重试保留后续变化、未完成记录拒绝外部冲突，以及夹具最终恢复原值。测试注入不等于宿主强杀验收。

受管理 Flow 验收：`node scripts/verify-shake-flow.mjs emulator-5554` 实际调用 CLI 与 MCP，并在观察到加速度改变后强杀独立 Flow 宿主，再以原租约 token 调用 `recover-flow`。API 37 首次证据 `shake-flow-1790709720793/verification.json` 证明原值恢复及租约释放。完整本地回归 core 108、Android 86、脚本 40 项通过。该脚本已加入 API 35 托管 CI，托管结果需绑定后续公开提交。

最终 API 37 复验 `shake-flow-1790709833038/verification.json` 还在宿主强杀后注入外部冲突：首次标准恢复失败、原租约不变、没有成功回执；夹具移除自己的冲突后，同 token 恢复成功并释放租约。前一修订 `efde367` 的托管运行 `36618250185` 已成功，但不包含本轮 Flow 接入，不据此宣称本轮托管验收通过。

独立动作补充：API 37 报告 `shake-flow-1790710031831/verification.json` 包含 X 轴 CLI/MCP Flow 及 Y/Z 轴 MCP `execute_action`，验证请求与持久记录一致、原值恢复、租约释放，同时复验宿主强杀及冲突恢复。`shake-action-cancel-1790710111508/verification.json` 在观察到 Z 轴改变后发送 MCP `notifications/cancelled`，确认运行记为 cancelled、原值恢复、租约释放、取消请求不返回结果且会话仍能响应 ping。四包构建和 234 项测试通过。这些属于单台 API 37 的控制台状态及协议验收，不替代应用传感器事件或多设备验收。

托管兼容性修正：运行 `36619125084` 的三系统任务通过，但 Android 网络采集恢复验收失败，因为新恢复入口给未使用传感器的运行添加了多余的通过条目。现在仅在传感器恢复目录存在时加入该步骤，并拒绝将普通文件或符号链接作为恢复目录。API 37 原网络采集恢复脚本 `network-capture-recovery-1790710402042/verification.json` 已复验通过；该失败不是传感器强杀恢复失败，也不是此前录屏拉取偶发失败。

传输边界纠正：初次实验 `shake-transport-1790710260245/failure.json` 的“清理失败”预期不成立。实际切断主机 ADB 客户端到服务端的 TCP 中继后，摇动仍执行完成、生成恢复回执并释放租约，后续截图命令因连接重置而失败。因此该断点没有切断传感器控制链路，不能计为传感器断连恢复。`verify-shake-transport.mjs` 现在分别断言动作已完成、原值已恢复、Flow 因截图失败而失败、ADB 断连探针失败及重连成功；真正的传感器控制链路丢失仍待验收。

上述传输边界在 API 37 的 `shake-transport-1790710456400/verification.json` 通过，已加入托管 CI；本轮四包构建及 core 108、Android 87、脚本 40 项共 235 项测试通过。托管修正结果需等待对应新提交，不能用本地结果替代。
