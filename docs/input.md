# Android 文本输入

普通可打印 ASCII 继续使用 ADB。中文、其他 Unicode、多行及字面 `%s` 自动使用 AppVanta 自己实现的测试输入法，无第三方 APK 或模型服务依赖。

先从本仓库源码构建并安装到测试设备：

```powershell
python scripts/build-input-ime.py --sdk G:\Dev\SDKs\Android
adb -s emulator-5554 install -r .appvanta/input-ime/appvanta-input.apk
$env:APPVANTA_COMPLEX_INPUT='1'
node scripts/verify-markor.mjs emulator-5554
Remove-Item Env:APPVANTA_COMPLEX_INPUT
```

构建需要 Python、JDK（java/javac/keytool）、Android SDK platform 35 和 build-tools 35.0.0；可通过 `--platform`、`--build-tools` 指定本地版本。APK 和本地测试签名密钥位于被 Git 忽略的 `.appvanta/input-ime/`。Driver 不自动下载或安装 APK。

多点手势还需要在 Android 的 Accessibility 设置中由设备用户显式启用 **AppVanta Gesture Service**。Driver 只检查服务状态，不会绕过用户设置自动开启。启用状态可用 `adb -s <device> shell settings get secure enabled_accessibility_services` 检查。

输入操作在设备锁内读取原输入法及 helper 启用状态，切换、定位输入框、等待输入连接就绪、提交 UTF-8 文本，最后恢复原输入法和 helper 启用状态。取消后的清理使用独立超时；清理失败会报告错误。COMMIT 不重试，避免丢失确认时重复输入。广播要求发送者拥有 Android DUMP 权限，并验证输入连接所属应用与当前前台包一致；普通应用不能直接发送输入指令。Helper 不含网络权限或模型调用；手动录制启用时只向应用专属外部目录写入白名单包的 Accessibility 事件，停止后由 ADB 拉回并删除，见 [手动交互录制](manual-interaction-recording.md)。

提交上限为 24000 UTF-8 字节，拒绝 NUL 和未配对代理字符。文本插入当前光标/选区，应用仍可能限制字符、长度或换行；`commitText` 返回成功不保证业务结果，必须设置检查点。Markor 验证器拉取原始保存文件后检查完整文本，避免 shell 输出换行转换造成误判。

尚未覆盖所有 Android/OEM 输入法、真机、密码框、WebView 编辑器、设备断线和强杀后的恢复。当前不把复杂输入整个验收项标记完成。

接口依据：[Android InputConnection](https://developer.android.com/reference/android/view/inputmethod/InputConnection)、[InputMethodService](https://developer.android.com/reference/android/inputmethodservice/InputMethodService)。代码为独立实现。

## 本地验证记录

- Markor 6 步通过：`.appvanta/runs/2026-09-16T04-10-35-391Z-emulator-5554-d69e8f78/report.md`。检查保存文件完整文本和预览标记。
- `node scripts/verify-input-cleanup.mjs emulator-5554`：定位失败及取消后原输入法/启用列表完全一致；非法 UTF-16、NUL 和超限输入被拒绝。证据：`.appvanta/runs/input-cleanup-1789531896310/verification.json`。

## Flow 输入法夹具

Flow 可显式设置 `"inputMethod": "dev.appvanta.input/.InputService"`，或其他已安装的输入法组件。工具不自动下载安装输入法。初始化保存默认项和已启用列表，再启用并选择指定组件；业务步骤之前确认选择生效。成功、失败、取消后恢复原默认项，只在目标原先未启用时禁用它，并核对完整启用列表。

`fixtures/input-method.json` 保存 before/prepared/after 与 restored 状态，报告提供链接。恢复使用不带取消信号的独立命令，失败使运行失败，但继续恢复文件夹具。组件字符串经过校验与 shell 参数引用。录制回放保留 inputMethod 配置，环境指纹包含指定输入法应用的 APK。

此配置固定 Flow 执行期间的输入法选择；复杂文本动作仍使用已有的自有输入桥，并在动作结束后恢复到 Flow 指定输入法。它不保证其他输入法或编辑器的输入兼容性，也不保证宿主强制终止、设备断线后的自动恢复。准备/恢复记录尚未并入统一权限审计事件格式。

验证命令：`node scripts/verify-ime-fixture.mjs emulator-5554`。API 37 / Gboard 与自有输入法切换实测：`.appvanta/runs/ime-fixture-check-1789537789059/verification.json`，覆盖成功、失败、取消、未安装输入法拒绝。
