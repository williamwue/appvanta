# Android 结构化动作

CLI Flow 与 MCP `execute_action` / `run_flow` 使用同一套版本化 Action Schema。所有枚举在获取设备锁和执行 ADB 前校验，未知按钮、方向、字段或越界时长会被拒绝。

## 新增动作

长按优先使用语义目标，坐标仍可作为兜底：

```json
{ "kind": "long-press", "target": { "kind": "resource-id", "value": "app:id/item" }, "durationMs": 800 }
```

硬件按钮：

```json
{ "kind": "button", "button": "home" }
```

支持 `home`、`back`、`power`、`volume-up`、`volume-down`、`mute`、`app-switch`、`enter`、`menu` 和五个 D-pad 方向/确认按钮。Android Driver 将它们映射到固定 KeyEvent；不会接收任意数字或 shell 文本。

方向锁定：

```json
{ "kind": "rotate", "orientation": "landscape-left" }
```

支持 `portrait`、`landscape-left`、`portrait-upside-down` 和 `landscape-right`，通过 Android window service 锁定方向。方向是显式设备动作，Flow 结束后不会自动恢复先前方向；需要恢复时应在 Flow 中加入对应动作。

剪贴板写入与粘贴：

```json
{ "kind": "set-clipboard", "text": "中文\nemoji 🙂" }
{ "kind": "paste", "target": { "kind": "resource-id", "value": "app:id/editor" } }
```

`set-clipboard` 使用 AppVanta 自行构建的测试辅助 APK，通过仅允许 ADB shell 调用的显式 BroadcastReceiver 写入 Unicode 文本，不切换输入法，也不使用网络。辅助 APK 必须预先按 [输入说明](input.md) 构建和安装；工具不会自动下载或安装二进制。文本限制为 24000 UTF-8 字节且禁止 NUL。`paste` 先按语义目标聚焦，再由用户显式启用的 AppVanta Accessibility 服务对聚焦输入节点执行 Android `ACTION_PASTE`；服务拒绝或找不到输入焦点时动作失败。剪贴板内容会保留在设备上，并作为 Flow/action 证据保存，不能用于生产凭据或其他秘密。

真正的并发多点手势：

```json
{ "kind": "pinch", "center": { "x": 540, "y": 1000 }, "startSpan": 500, "endSpan": 180, "durationMs": 600 }
{ "kind": "rotate-gesture", "center": { "x": 540, "y": 1000 }, "radius": 220, "degrees": 90, "durationMs": 800 }
{ "kind": "multi-touch", "durationMs": 500, "strokes": [
  { "points": [{ "x": 300, "y": 700 }, { "x": 300, "y": 1100 }] },
  { "points": [{ "x": 700, "y": 700 }, { "x": 700, "y": 1100 }] }
] }
```

`pinch` 和 `rotate-gesture` 会编译为两条同时开始的轨迹；`multi-touch` 接受 2–10 条轨迹，每条 2–50 个点。Android Driver 通过 AppVanta 自建 helper 的 Accessibility `dispatchGesture` 执行，不把串行 swipe 当成多点触控。用户必须先安装 helper，并在测试设备的 Accessibility 设置中显式启用 **AppVanta Gesture Service**。广播入口要求调用方拥有系统 `DUMP` 权限，普通应用不能借此注入手势。

## 验证边界

核心解析、MCP JSON Schema、Android KeyEvent/rotation 映射、多点轨迹编译、辅助 APK 构建和录制回放契约已纳入自动测试。API 37 模拟器已运行 `node scripts/verify-gestures.mjs emulator-5554`，pinch、rotate 和自定义 multi-touch 均在 helper 测试页记录到同时 2 个触点，证据为 `.appvanta/runs/gestures-1790109551260/verification.json`。同一模拟器上的方向、长按、Home/Back/Power、音量/Mute、App Switch/Menu/Enter/D-pad 和 Unicode 剪贴板粘贴由 `npm run verify:android-actions -- emulator-5554` 验证，证据为 `.appvanta/runs/android-actions-1790111761966/verification.json`；验证器会恢复原屏幕方向、媒体音量和唤醒状态。真机仍待验收；不同应用可能忽略部分方向、菜单键、D-pad、paste 或 Accessibility 手势，`power` 会改变屏幕状态，必须配合明确检查点使用。
