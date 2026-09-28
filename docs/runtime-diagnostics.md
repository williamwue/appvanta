# Android 运行诊断

CLI：`diagnose <device> <package> [since-epoch-seconds]`。MCP `diagnose_runtime` 接受对应 deviceId、packageName 和可选字符串 since。默认使用设备当前时间之前 5 分钟，不依赖宿主时钟。

读取 events 缓冲的 am_crash/am_anr 与 crash 缓冲，精确匹配包名及 `包名:子进程`，按事件计数并去重。保存原始日志和结构化 JSON；Java 堆栈通过进程号及事件前 5 秒到后 1 秒的窗口关联。API 37 实测事件 PID 字段与旧定义存在差异，若窗口内有唯一匹配应用名的 AndroidRuntime Process 头，以该头确认 PID。无可靠 Java 头时保留事件值，可能为 0。

进程已经退出不会导致整个诊断因 pidof 返回 1 而失败。diagnosticsPath 指向结构化事件，eventsPath/logPath 保留原文。malformedEvents 暴露无法解析的事件数量。

零事件仅表示保留日志中没有匹配项，不代表应用没有崩溃：缓冲可能轮转、被清理或不可见。已支持从可读的 data_app_anr DropBox 报告匹配 ANR 线程；已支持日志中的 Native 崩溃回溯；完整 tombstone、系统应用 ANR 标签及 OEM/真机兼容仍待完成。

## Flow 自动诊断

```json
{
  "name": "Markor health check",
  "diagnostics": { "packages": ["net.gsantner.markor"] },
  "steps": [{ "description": "Launch", "launchPackage": "net.gsantner.markor" }]
}
```

显式指定 1–20 个不重复包名。Flow 初始化时读取设备高精度 epoch 时间，收尾时按该起点收集指定应用的崩溃和 ANR。CLI/MCP 同步、异步及多设备入口共用此路径，录制回放保留诊断配置。每个应用独立收集，即使某一应用采集失败也继续其他应用。

`diagnostics/session.json` 保存起点和范围，`summary.json` 汇总结果并链接原始日志及结构化事件。发现崩溃、ANR、无法解析事件或采集失败，会将运行判定失败，即使业务步骤已经通过。取消时仍使用独立 Driver 收集诊断；采集无异常时保留取消状态。网络或录屏收尾失败不应跳过诊断。

诊断窗口包括资源初始化与收尾，范围依据设备时钟；设备时间被调整、日志被清理或轮转时仍有限制。目前是运行结束后的日志检查，不是持续日志流，也不能检测发生在收集结束后的崩溃。

## 验证

`npm test` 覆盖应用与时间过滤、重复事件、堆栈关联及非法事件计数。

`node scripts/verify-diagnostics.mjs emulator-5554` 使用本地构建的 input helper 中 FaultActivity 主动抛出 Java 异常，检查事件和堆栈、其他应用排除、时间过滤，最后启动 Markor。先运行 build-input-ime.py 并安装 APK。FaultActivity 要求 DUMP 权限，只由显式测试命令启动，输入 Driver 不调用它。

API 37 通过记录：`.appvanta/runs/diagnostics-check-1789533445732/verification.json`。此前 am crash 命令在本机触发 Native crash，只证明事件捕获，不作为 Java 堆栈通过证据。

参考：[Android logcat](https://developer.android.com/tools/logcat)、[AOSP 事件定义](https://android.googlesource.com/platform/frameworks/base/+/48acfb0f1d71/services/core/java/com/android/server/am/EventLogTags.logtags)。

Flow 自动诊断验证：`node scripts/verify-flow-diagnostics.mjs emulator-5554`。API 37 证据 `.appvanta/runs/flow-diagnostics-check-1789535735733/verification.json` 覆盖正常通过、业务通过但 Java 崩溃导致失败、旧事件排除和取消后收集。测试会停止并重新启动自有故障辅助应用，保证实际触发 onCreate；不会将仅切回旧任务当作一次新注入。

## ANR 注入与线程堆栈

自有辅助应用新增 DUMP 权限保护的 AnrActivity。显式点击 `Trigger AppVanta ANR` 后主线程阻塞 60 秒，验证器再发送输入以触发系统输入超时；不会由输入 Driver 自动启动。故障注入通过系统 am_anr 事件确认，而非仅凭脚本等待时间。

```powershell
python scripts/build-input-ime.py --sdk G:/Dev/SDKs/Android
adb -s emulator-5554 install -r .appvanta/input-ime/appvanta-input.apk
node scripts/verify-anr.mjs emulator-5554
```

验证器等待真实事件及可匹配的线程报告，检查主线程包含 `SystemClock.sleep` 与 `AnrActivity`，排除 Markor，并在 finally 停止辅助应用、恢复 Markor。API 37 证据：`.appvanta/runs/anr-check-1789536019379/verification.json`。

发现 ANR 后诊断器尝试读取 `dumpsys dropbox --print data_app_anr`，只保留与事件 PID、完整进程名和 ±10 秒窗口匹配的完整线程段。多个候选选择时间最接近者；结构化结果包含线程名、tid、状态及栈行，并链接匹配段原文。不会修改 /data/anr 权限或请求 root。

`anrStackStatus` 区分 matched、unavailable-or-incomplete、unavailable、not-requested；无权限、报告尚未写出、系统截断等不代表不存在 ANR。原始 ANR 事件仍保留，Flow 仍按事件失败。当前只查询 data_app_anr，不覆盖 system_app_anr/system_server_anr，Native 日志回溯见下节；完整 tombstone 尚未实现。

参考：[Android 输入分发 ANR](https://developer.android.com/topic/performance/vitals/anr)。

## Native 崩溃回溯

解析 crash 缓冲中 DEBUG 崩溃块，提取崩溃头部的 PID/TID、完整进程名、signal、可用的 abort message、回溯帧和原始消息行。日志写入进程可能是 crash_dump，不能直接当作崩溃 PID。

仅关联明确标记为 Native crash 的 am_crash 事件，要求进程名一致，块时间在事件前 5 秒到后 1 秒且晚于诊断起点。多个候选时不猜测，不关联相邻 Java 事件。`incidents[].nativeStack` 保存匹配结果；原始日志继续保留。它是日志中的回溯，不是完整 tombstone 或额外的离线符号化结果；缺少字段、日志轮转和 OEM 格式差异可能导致无法关联。

自有 NativeFaultActivity 受 DUMP 权限保护，显式启动后向自身发送 SIGABRT。`node scripts/verify-native-crash.mjs emulator-5554` 检查真实崩溃事件、信号、回溯、其他包排除和时间过滤，finally 停止辅助应用并恢复 Markor。API 37 验证：`.appvanta/runs/native-crash-check-1789536245389/verification.json`。

参考：[AOSP Native 崩溃诊断](https://source.android.com/docs/core/tests/debug/native-crash)。
