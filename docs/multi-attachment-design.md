# 多附件分享：原生权限转授验证

状态：验证夹具之外，已增加产品 share-helper、持久回执和 `share-files` Action/Flow/MCP 接入。以下早期夹具证据与后续产品验收分别记录，不把机制验证计为完整附件功能交付。产品使用方法见 file-sharing.md。

Android 多附件使用 `ACTION_SEND_MULTIPLE` 和 `ArrayList<Uri>` 类型的 `EXTRA_STREAM`；显式 `ClipData` 携带每个 URI，并只请求读取授权。参考 [Android 分享数据](https://developer.android.com/training/sharing/send)。当前 API 37 设备的 `am help` 提供单个 `--eu` 与字符串列表 `--esal`，没有 URI Parcelable 列表参数，因此不能将多个 URI 字符串直接当作多附件投递。

## 已验证的机制

`tools/share-relay-probe` 是独立、无网络权限、非 debuggable 的测试桥接应用。导出的 Activity 要求系统 `DUMP` 权限；只接受测试来源 authority、两个 URI 和固定测试接收者。它不安装到用户项目，也不是产品运行时依赖。

每个 URI 通过独立 Activity Intent 的 data 和只读 flag 转授给桥接 Activity。第一个 Intent 只准备；第二个必须匹配内存中的 operation 和顺序，才构建 URI 列表、两项 ClipData 并启动接收应用。桥接 Activity 随后结束。接收应用逐项验证两份不同内容的 4096 字节、URI 顺序、SHA-256、读取权限和写入拒绝。

API 37 证据：`.appvanta/runs/multi-share-probe-1790717202494/verification.json`。同时验证无读取授权时拒绝，以及第一项准备后强制停止桥接应用、再发送第二项时拒绝交付。最终删除两份来源测试文件，设备租约为空。

首次试验在准备第二个来源文件时强制停止来源应用，先前授予 shell 的 URI 权限随之丢失，Android 拒绝转授第一个文件。失败记录保留，两份残留文件已显式删除。来源夹具现通过同一 Activity 的新 Intent 准备多个文件，避免在准备阶段撤销先前授权。这一结果只证明该设备上此授权路径的行为。

## 产品接入仍需完成

- 产品 `share-files` 已定义 URI 列表、MIME 和可选接收者契约；完整客户端及更多调用入口仍待验收。
- 产品 helper 已使用一般 content URI，仍需验证更多 provider 可见性与授权。
- 具名操作与持久回执已实现，仍需补宿主、helper 与 Activity 的全部中断窗口；不能自动重放可能已经交付的附件。
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

后续恢复与复验：原 AppVanta_Verification_API37 AVD 重新启动后，核对系统指纹一致，按原 token 调用 recover-flow 返回 environment-cleanup；证据为原运行 recovery/b0e4d80a-3971-437e-8f7b-6dd4774eb503.json。仅删除旧运行具名测试文件，旧 progress.json 保持不变，未继续原业务流程。新运行 .appvanta/runs/file-share-1790726829703/verification.json 已通过 CLI、MCP、选择器取消不交付与再次选择交付，以及权限撤销、文件删除和租约释放，补齐共享夹具改动后的 API 37 单附件复验。

来源撤销补充：API 37 运行 .appvanta/runs/multi-share-probe-1790727033098/verification.json 通过。第一项准备后，来源撤销该 URI 的只读授权但保留文件；接着准备第二项时，桥接应用在最终 startActivity 受到 Android SecurityException 拒绝，接收端没有 received.json。来源重新授予 shell 读取权限后，新 operation 的两项交付、摘要与只读检查通过。夹具增加具名文件的 revoke/grant 控制，不改变产品授权策略。

产品验收：.appvanta/runs/share-helper-1790727695741/verification.json 在 API 37 通过 helper 持久回执、准备进程丢失后拒绝续接/重建、取消不交付，以及已交付 operation 重复请求拒绝；旧回执逐字节保持不变。同次真实 CLI run-flow 和 MCP run_flow 均用 share-files 完成双附件交付，接收应用核对两份不同内容的 4096 字节及摘要、URI 顺序和只读权限。源码构建和完整 261 项回归通过（core127、Android94、脚本40）。模拟发送响应丢失的宿主回归验证不重复 dispatch，不代表实际宿主在所有指令窗口强杀已验收。API 35 产品 helper 步骤已加入 CI，尚待对应修订结果。

实际分享进程强杀：.appvanta/runs/share-helper-1790728046188/verification.json 在 API 37 通过两个窗口。第一项准备回执已落盘、第二项尚未执行时，实际执行 shareFiles 的子进程被 SIGKILL，随后读取 prepared 回执并显式取消，接收端无交付。第二个窗口在 Android 已保存 dispatched、真实接收内容已形成，但 ADB 执行回调尚未返回给 shareFiles 时 SIGKILL；宿主只有 dispatch-intent、没有 dispatched/failure 文件，设备回执确认发送，重复 operation 被拒绝且回执未变化。同次 CLI/MCP 正常双附件流程仍通过。父验证进程持续持有设备锁，因此此证据不证明整个 Flow 租约所有者退出或所有宿主/Activity 崩溃窗口。

系统选择器修复与验收：API 37 英文环境的 `.appvanta/runs/share-helper-1790729412544/verification.json` 通过取消无交付、重新打开并选择接收应用、两项内容摘要及只读授权检查，连同 CLI/MCP、两种宿主强杀和三种只读回执查询均通过，测试文件已清理且租约为空。helper 现在在无显式目标包时等待 Activity result 再结束，避免系统选择器尚未完成转授就撤销临时授权。取消后回执仍为 `dispatched`，明确证明启动回执不等同实际交付。

修复前运行 `share-helper-1790728979917` 在点击 `Just once` 后未启动接收应用；logcat 明确记录 helper UID 无权转授来源 URI。修复后首次运行 `share-helper-1790729203283` 已实际收到正确内容，但测试将系统附加的 Activity 启动标志与直接启动完全比较而失败；改为逐位要求 READ 且禁止 WRITE、PERSISTABLE、PREFIX，保留完整原始标志。两次失败及具名文件清理记录保留，未当作通过。其他语言、多 provider、数量上限、接收 Activity 未返回前再次分享及 OEM 仍待验收。
