# 模拟器摇动底层实现与验收边界

Android Emulator 的 [sensor 控制台接口](https://developer.android.com/studio/run/emulator-console) 可以读取与设置三轴 acceleration。当前 `packages/android/src/emulator-sensors.ts` 提供内部摇动与恢复辅助函数，尚未导出到稳定 SDK 或接入 Flow/MCP 动作。

摇动先读取原始三轴值，再生成指定轴的正负交替偏移，保留另外两轴及原始重力分量。幅度限制 1–30，周期 1–20，采样间隔 50–1000 毫秒。仅接受 `emulator-N` 序列号；读取必须包含完整向量和 OK，写入必须确认 OK 并读回。数值比较容差为 0.0001，与控制台打印精度相容；这不是物理传感器精度保证。

第一条写入命令之前，以独占创建和 fsync 保存包含设备、原值和全部计划向量的恢复记录。正常结束、动作失败或取消均进入不受调用方取消信号影响的恢复：只有当前值等于原值或计划值之一时才恢复，随后读回确认。外部冲突、断连或无法确认恢复会抛错并保留记录；恢复完成另写绑定原记录摘要的回执，不覆盖原记录。调用方必须持有设备租约，并在恢复无法确认时保留租约。

`node scripts/verify-emulator-shake.mjs emulator-5554` 的 API 37 证据位于 `.appvanta/runs/emulator-shake-1790707979799/verification.json`：正常六次读回通过；取消场景先观察到加速度改变，再发取消，最后原值恢复。此脚本使用独立租约且在恢复无法确认时保留租约。

尚未完成：应用内 SensorEvent/摇动响应验证、Flow/MCP 动作及标准恢复入口接入、宿主强杀与设备断连恢复、外部冲突实测、多轴/多设备和真机/OEM。当前不得把控制台成功当作完整产品摇动能力已验收。
