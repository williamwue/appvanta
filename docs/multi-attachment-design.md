# 多附件分享：原生权限转授验证

状态：验证夹具已实现，产品 Action/Flow/MCP 多附件入口尚未实现。此文不把夹具成功计为完整附件功能交付。

Android 多附件使用 `ACTION_SEND_MULTIPLE` 和 `ArrayList<Uri>` 类型的 `EXTRA_STREAM`；显式 `ClipData` 携带每个 URI，并只请求读取授权。参考 [Android 分享数据](https://developer.android.com/training/sharing/send)。当前 API 37 设备的 `am help` 提供单个 `--eu` 与字符串列表 `--esal`，没有 URI Parcelable 列表参数，因此不能将多个 URI 字符串直接当作多附件投递。

## 已验证的机制

`tools/share-relay-probe` 是独立、无网络权限、非 debuggable 的测试桥接应用。导出的 Activity 要求系统 `DUMP` 权限；只接受测试来源 authority、两个 URI 和固定测试接收者。它不安装到用户项目，也不是产品运行时依赖。

每个 URI 通过独立 Activity Intent 的 data 和只读 flag 转授给桥接 Activity。第一个 Intent 只准备；第二个必须匹配内存中的 operation 和顺序，才构建 URI 列表、两项 ClipData 并启动接收应用。桥接 Activity 随后结束。接收应用逐项验证两份不同内容的 4096 字节、URI 顺序、SHA-256、读取权限和写入拒绝。

API 37 证据：`.appvanta/runs/multi-share-probe-1790717202494/verification.json`。同时验证无读取授权时拒绝，以及第一项准备后强制停止桥接应用、再发送第二项时拒绝交付。最终删除两份来源测试文件，设备租约为空。

首次试验在准备第二个来源文件时强制停止来源应用，先前授予 shell 的 URI 权限随之丢失，Android 拒绝转授第一个文件。失败记录保留，两份残留文件已显式删除。来源夹具现通过同一 Activity 的新 Intent 准备多个文件，避免在准备阶段撤销先前授权。这一结果只证明该设备上此授权路径的行为。

## 产品接入仍需完成

- 明确多附件 Action 的 URI 列表、MIME 和接收者契约，与 CLI、Flow、SDK、MCP 同步验证。
- 将固定测试桥接器替换为可安装、可诊断版本的产品 helper；验证一般 provider 可见性与授权，不放宽来源访问权限。
- 用具名操作和可验证回执绑定准备、交付与拒绝；宿主、helper 或 Activity 中断后，不能自动重放可能已经交付的附件。
- 取消和失败时释放本次准备的授权；验证来源提前撤销、接收者缺失、重复或乱序请求，以及选择器取消。
- 验证数量上限、多种 MIME、不同来源 provider、API 35、其他语言和 OEM。真机仍待设备可用。
- 本地文件上传、托管 provider 与回收另需实现，当前只处理已有 content URI。

## 复验

```text
python scripts/build-segment-clock.py --fixture share-source
python scripts/build-segment-clock.py --fixture share-receiver
python scripts/build-segment-clock.py --fixture share-relay-probe
node scripts/verify-multi-share-probe.mjs emulator-5554
```

该机制验证以单写入者在隔离工作区完成；设备操作串行执行。API 35 托管步骤已配置，结果必须以对应 CI 记录为准。

提交前复核：修改共享夹具后的单附件完整复验 file-share-1790717276569 被中断，进程已退出且设备不在线；运行 2026-09-29T21-28-57-881Z-emulator-5554-f5353b8d 停在打开系统选择器的 executing 状态。租约与证据保留，不能计为本版单附件回归通过，恢复设备后须显式处理。双附件上述通过证据仍有效。
