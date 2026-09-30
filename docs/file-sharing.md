# Content URI 附件分享

Flow、CLI `run-flow`、MCP `run_flow`/`execute_action` 和 Android Driver 支持：

```json
{
  "kind": "share-file",
  "uri": "content://example.files/document/report.pdf",
  "mimeType": "application/pdf",
  "packageName": "example.receiver"
}
```

调用方须提供设备上已存在、ADB shell 有权读取并转授的 URI。该动作使用 Android `ACTION_SEND`，同时设置 Intent data 和 `EXTRA_STREAM`，只添加 `FLAG_GRANT_READ_URI_PERMISSION`，不请求写入或持久授权。只把 URI 放入 `EXTRA_STREAM` 的最初实现，在 API 37 验收中未给接收应用读取权限；补 data 后读取成功。参数经远端 shell 引号转义，URI 内容不作为命令执行。

URI 必须是带 authority/path 的 `content://`，最多 4096 字符，不接受 file/http、用户信息、端口、fragment、空白和控制字符。MIME 必须是明确的 type/subtype，不接受通配符。`packageName` 可省略，此时由 Android 解析接收者；显式目标包及 API 37 英文系统选择器已有验收。发送失败会使 Flow 停止，不执行下一步。启动成功只表示 Intent 已投递，仍须由接收应用检查点和实际内容证明业务成功。

动作不上传本地文件、不创建文件 provider，也不删除 URI 所指文件。授权生命周期由 Android 与 URI 所属应用管理；若需要提前撤销，由来源应用执行。尚未实现 AppVanta 托管上传/回收、系统选择器完整验收、跨用户或真机/OEM 验收。

## 多附件

`share-files` 使用独立原生 helper，将已有 URI 逐项准备后，以 `ACTION_SEND_MULTIPLE`、URI 列表和 ClipData 发送。调用方须先显式构建并安装 helper，产品不会自动安装 APK：

```text
python scripts/build-segment-clock.py --fixture share-helper
adb -s emulator-5554 install -r .appvanta/share-helper/appvanta-share-helper.apk
```

```json
{
  "kind": "share-files",
  "uris": ["content://example.files/document/a.pdf", "content://example.files/document/b.pdf"],
  "mimeType": "application/pdf",
  "packageName": "example.receiver"
}
```

支持 2–16 个不同 URI，URI 与 MIME 校验沿用单附件规则；不指定包时由 Android 解析接收者。当前 helper 为非 debuggable、无网络权限的独立应用，Activity 和只读回执 provider 均要求 DUMP 权限。它不读取附件内容，也不持有文件上传功能。

每次调用生成独立 operation。helper 持久保存 `prepared`、`dispatching`、`dispatched`、`cancelled` 或 `rejected` 回执；准备状态只在原 Activity 实例内继续，实例丢失后不能重新创建同一 operation。发送前落盘 `dispatching`，成功返回后才记录 `dispatched`。后者只证明启动调用成功，不证明接收应用实际读取或用户最终选择。

宿主在运行的 artifacts 目录保存请求、观察到的回执、逐项准备回执及发送意图。请求与回执不匹配时停止；发送前失败会尝试取消准备。已尝试发送后响应丢失则保留不确定结果，不自动发送第二次。独立的新调用会生成新的 operation，因此再次手动执行仍可能重复交付，不能把这套记录视为跨调用的 exactly-once 保证。helper 回执保留在应用私有目录，可经 `adb exec-out content read --uri content://dev.appvanta.share.helper/operations/<operation>` 查询；尚无回执自动回收策略。

响应丢失后，可通过 CLI 查询已有 operation：

```text
node packages/cli/dist/index.js inspect-attachment-share emulator-5554 <operation-id>
```

MCP 对应 `inspect_attachment_share`，参数为 `{ "deviceId": "emulator-5554", "operation": "<operation-id>" }`；Android Driver 对应 `inspectAttachmentShare(deviceId, operation)`。查询校验 operation、状态、数量、URI、MIME 和目标包，返回回执及原始响应的 SHA-256、`scope: "read-only"` 和 `resumeAuthorized: false`。它不获取或释放设备租约，因此其他进程持锁时也可读取；不会重新发送附件或授权继续执行。`dispatched` 仍只表示 Android 启动调用返回，不能替代接收端内容验收。

API 37 上已通过真实 CLI/MCP 查询 `prepared`、`cancelled` 和 `dispatched` 回执，并确认查询前后回执及已有租约不变；证据为 `.appvanta/share-receipt-clients-verification.json`。对应构建及 263 项测试通过（core 127、Android 96、脚本 40）。持续验收入口 `scripts/verify-share-helper.mjs` 包含相同查询检查。

多附件选择器、多 provider、数量边界、跨用户、真机/OEM 和宿主/Activity 各中断窗口仍需扩展验收。详见 [多附件机制与边界](multi-attachment-design.md)。

平台依据：[Android 文件分享](https://developer.android.com/training/secure-file-sharing)、[URI 读取授权](https://developer.android.com/reference/androidx/core/content/FileProvider)、[provider 可见性声明](https://developer.android.com/training/package-visibility/declaring)。

MCP 公布的 JSON schema 与运行时解析器均拒绝 fragment，包括末尾空 `#`；query 和编码后的 `%23` 仍可使用。接口一致性回归覆盖这几类 URI，避免客户端依据 schema 构造运行时必然拒绝的附件动作。

## 验证

两个独立测试应用位于 `tools/share-source` 和 `tools/share-receiver`，不属于产品运行时依赖。来源只生成具名 4096 字节测试文件，私有 provider 只允许读取并显式授权 shell；接收应用读取完整字节、计算 SHA-256、尝试写入并记录拒绝。来源的准备/清理 Activity 要求 DUMP 权限。测试应用为 debuggable 且没有网络权限，供 `run-as` 提取测试报告；不用于承载用户文件。

```text
python scripts/build-segment-clock.py --fixture share-source
python scripts/build-segment-clock.py --fixture share-receiver
node scripts/verify-file-share.mjs emulator-5554
```

验收先确认无授权时读取失败且 URI 读取权限为拒绝，再分别经 CLI 和真实 MCP Flow 投递，核对 4096 字节、SHA-256、MIME、URI、只读标志和写入拒绝；不存在的目标包必须失败并阻止后续步骤。最后由来源撤销授权并删除测试文件，再确认接收应用的读取权限已拒绝，设备租约为空。该闭环不证明其他应用、文件大小或 MIME 类型都兼容。

API 37 通过证据：`.appvanta/runs/file-share-1790715382660/verification.json`，同目录 `without-grant.json` 与 `after-revocation.json` 保存授权前后读权限。构建与完整 257 项测试通过（core 127、Android 90、脚本 40）。托管 API 35 用例已加入 CI，尚待对应运行完成。前三次未通过的尝试分别涉及负例错误文字假设和 EXTRA_STREAM 未实际转授读取权限，失败记录保留，测试文件及授权已显式清理。

系统选择器补充证据：`.appvanta/runs/file-share-1790715649482/verification.json` 验证选择应用后点击 `Just once`；`.appvanta/runs/file-share-1790716138891/verification.json` 验证取消不交付附件、再次打开并接收相同字节，以及最终撤销和删除。系统记住最近一次选择后会显示 `Share with AppVanta Share Receiver` 标题而非独立名称选项；旧验证脚本因此失败，修订后同时验证这两种界面，且检查名称或标题属于 Android 系统包。测试没有选择 `Always` 或清除系统选择历史。该验证限于英文 API 37，不代表其他语言、系统版本或 OEM 选择器完整覆盖。
