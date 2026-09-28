# Flow 文件数据夹具

```json
{
  "name": "Reproducible input",
  "applications": ["net.gsantner.markor"],
  "files": [
    { "path": "/storage/emulated/0/Download/appvanta-note.txt", "content": "测试内容\n第二行" }
  ],
  "steps": [{ "description": "Launch Markor", "launchPackage": "net.gsantner.markor" }]
}
```

`files` 可声明 1–20 个 UTF-8 文本输入，每项最多 1000000 个字符，路径不能重复。当前路径仅支持 `/storage/emulated/0/` 下的英文、数字、空格、下划线、连字符及扩展名；禁止父目录跳转、符号链接和目录目标，父目录必须存在。

共享执行器在业务步骤前准备文件，成功、失败和取消后统一恢复。原文件以二进制备份并校验 SHA-256；新内容先写同目录临时文件再替换。准备中途失败时回滚已登记文件。原来不存在的文件在收尾时删除。恢复操作独立于取消信号，恢复失败使运行失败并保留备份。

运行目录 `fixtures/summary.json` 在第一次设备写入前保存恢复信息，包括原始哈希、准备哈希、临时路径和恢复状态。目录保留原始二进制备份和准备文本；这些可能包含测试数据。报告提供恢复记录链接，录制回放保留 files 配置，完整比较检查其内容。

业务步骤对声明文件的修改也会在结束时被原内容替换；需要长期保留的业务输出应使用不同路径或在步骤中先收集证据。仅保证文件内容恢复，不保证原时间戳、所有权、打开文件句柄或应用内缓存状态。不是应用私有数据库快照。

尚未完成：宿主强制终止/断线后的自动恢复、权限/首次引导夹具（输入法夹具见 input.md）、测试数据通用脱敏及备份包迁移。不要把原始备份可在本地读取等同于可移植导出完整。

## 验证

`node scripts/verify-file-fixtures.mjs emulator-5554` 使用独立测试文件，验证 Unicode/多行准备内容、原二进制内容恢复、新文件清除，以及成功、业务失败、取消和准备部分失败后的回滚。测试结束移除其自建文件。

API 37 实测证据：`.appvanta/runs/file-fixtures-check-1789536840591/verification.json`。
