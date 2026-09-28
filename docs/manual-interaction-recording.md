# 手动交互录制

AppVanta 可以把测试人员在目标 Android 应用中的外部手动操作录制为版本 1 Flow。该能力使用仓库内独立实现的 Accessibility helper，不依赖 Argent、ARTEMIS、模型服务或第三方 APK。

先构建并安装 helper，再由设备用户在 Accessibility 设置中显式启用 **AppVanta Gesture Service**：

```powershell
python scripts/build-input-ime.py --sdk G:\Dev\SDKs\Android
adb -s emulator-5554 install -r .appvanta/input-ime/appvanta-input.apk
node packages/cli/dist/index.js record-interactions emulator-5554 net.gsantner.markor 30
```

CLI 在指定时间内持有 AppVanta 设备锁。MCP 使用两个工具，便于 Agent 决定结束时间：

1. `start_interaction_recording`：传入 `deviceId`、1–10 个 `packages`，以及可选的 `includeText`；
2. 用户在设备上执行操作；
3. `stop_interaction_recording`：传回开始结果中的 `recordingId`。

原始事件、会话状态和生成的 Flow 保存到 `.appvanta/manual-recordings/<recording-id>/`。开始状态在设备广播前落盘；helper 还把活动录制 ID、白名单、文本开关和序号原子保存在应用内部目录，Accessibility 服务被 Android 重建后会追加打开原 JSONL，因此 MCP 或服务重启后仍可使用 recording ID 停止会话。Helper 仅接收显式包名白名单内的 click、long-click、scroll 和可选 text-change 事件；文件写入应用专属外部目录，停止后由 ADB 拉回并删除设备副本。

定位器按 resource ID、Accessibility label、文本、坐标的顺序选择。滚动事件根据目标边界和系统报告的方向生成 swipe。Accessibility 不提供真实长按时长，因此当前使用 800ms。生成结果没有自动发明检查点，必须审查 Flow 并为关键步骤补充断言。

## 文本与安全边界

`includeText` 默认关闭。开启后，文本可能包含账号、消息或其他敏感数据，并会进入原始事件和 Flow。编译器只接受 `afterText` 以前一个 `beforeText` 为前缀的追加输入，并合并同一目标的连续字符；删除、替换、自动格式化和无法证明的编辑会保留原始证据并拒绝生成回放。密码框和应用主动隐藏的内容不会被强行读取。

Accessibility 事件不等于原始触摸流：Canvas、游戏、自绘控件、部分 WebView、多点手势、硬件键和没有 Accessibility 事件的移动可能无法录制。MCP 的开始和停止是两个独立请求，期间不会持续持有设备锁，因此不要同时运行其他 AppVanta Flow。

API 37 模拟器已验证 MCP 开始后退出、新 MCP 停止、Settings `resource-id` 点击事件拉取、Flow 编译和 MCP 回放，证据为 `.appvanta/runs/manual-recording-check-1790110374558/verification.json`。真机、复杂编辑器和上述非 Accessibility 控件边界仍待验收。复验命令：`node scripts/verify-manual-recording.mjs emulator-5554`。
