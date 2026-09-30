# 托管附件上传：原生 provider

当前已实现 helper 的原生存储及分享接入，正式 CLI/MCP/SDK 上传入口、宿主崩溃后的临时文件恢复及完整生命周期编排仍待实现。现有 `share-file`、`share-files` 接受上传完成的 URI；此阶段不把本地文件托管整项计为完成。

`dev.appvanta.share.uploads` provider 随 share-helper 安装，管理操作要求 Android DUMP 权限。读取同样要求 DUMP 或单个 URI 的读取授权；接收应用获得 READ，不获得写入或管理权限。每个文件使用不可复用的 UUID，保存在 helper 私有目录，未开启备份或网络权限。

原生协议：

1. 向 `content://dev.appvanta.share.uploads/files` 插入 `id`、`mimeType`、`displayName`、`size`、`sha256`。大小为 0–64 MiB，名称不含路径分隔符或控制字符，MIME 必须明确，摘要为小写 SHA-256。
2. 通过返回的 `/files/<id>` URI 写入一次。状态由 `prepared` 转为 `writing`。provider 通过 pipe 接收数据，在声明大小内写入临时文件并计算摘要。
3. EOF 后大小和摘要匹配，才同步数据并保存 `ready` 元数据；否则保存 `rejected`。只有 `ready` 可打开为只读文件。写入不能重试，重复创建 ID 也会拒绝。
4. 查询支持 `_display_name`、`_size`、`state`、`sha256`、`mimeType`；可单独查询 `error` 获取拒绝诊断。将 ready URI 交给现有分享动作，仍须验证接收端内容。
5. 显式删除撤销授权并删除上传字节，保留 `deleted` 墓碑，防止旧 ID 被重新用于不同内容。存在活跃写入线程时拒绝删除，调用方须先结束写入。进程重启后遗留的 writing 文件不可直接读取或续写，可显式删除。

目前没有自动回收或总存储配额。删除不能收回接收应用已复制的内容，也不等同于关闭接收应用已经打开的文件描述符。活跃写入取消、进程强杀、磁盘耗尽、持久化故障及多用户尚需专项验收。

Windows 验证发现，直接向本机 ADB 的标准输入写入含 `0x1A` 的二进制数据，设备只收到此前的 26 字节；其摘要与原始数据前 26 字节完全一致，provider 正确拒绝。验证脚本改为 `adb push` 到 `/data/local/tmp/appvanta-upload-<id>` 下的具名私有目录，再由设备端将文件重定向给 `content write`，结束后删除临时文件及目录。宿主在这段流程中被强杀后的恢复仍待产品层接入，不能把脚本 finally 当作崩溃恢复。

API 37 证据：`.appvanta/runs/upload-provider-1790731722449/verification.json`。覆盖 4096 字节全范围二进制、空文件、截断及错误摘要拒绝、未完成文件不可读、ID 不可覆盖、通过实际 `share-files` 接收到完整及空文件、只读授权与写入拒绝、显式删除后读取权限拒绝。失败试验保留独立记录及具名清理证明。复验：

```text
python scripts/build-segment-clock.py --fixture share-helper
python scripts/build-segment-clock.py --fixture share-receiver
node scripts/verify-upload-provider.mjs emulator-5554
```

API 35 同一用例已加入 CI，结果以对应快照运行记录为准；尚无真机/OEM 证据。

最终补验 `.appvanta/runs/upload-provider-1790732070768/verification.json` 还验证 ready/rejected 文件均拒绝再次写入，原状态不变；完成实际分享、删除和撤权检查。共享 helper 修改后的外部 URI 完整回归 `share-helper-1790731862714` 通过 CLI/MCP、选择器取消和连续接收、旧回执不变、两种宿主强杀及只读查询，来源文件已清理。
