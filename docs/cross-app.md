# 跨应用流程

`node scripts/verify-cross-app.mjs emulator-5554` 验证 Settings → Markor 的信息收集流程：从 Settings UI 树读取网络分类文字，构造带唯一标记的文本，通过自研剪贴板桥写入系统剪贴板，切换 Markor 并粘贴到 QuickNote，退出编辑页保存，再用 ADB 拉取实际文件校验完整文本与唯一出现次数。

流程使用统一 Flow 执行器，包含源文字、应用导航、编辑器、粘贴结果和保存后导航的检查点。模板外的准备操作与原文件单独保存；QuickNote 尚不存在时明确记录 existed=false。已存在文件保留副本，测试会向笔记插入标记，不清空应用数据。脚本暂时设置 MANAGE_EXTERNAL_STORAGE AppOps，并在 finally 恢复原值。评分提示仅在观察到 NO THANKS 时显式关闭；其他未识别对话框导致失败。

API 37 / Markor 2.16.1 通过证据：`.appvanta/runs/cross-app-1790426853507/verification.json`；对应六步 Flow 为 `2026-09-26T12-47-59-629Z-emulator-5554-192dfbbb`。`quicknote-after.md` 包含源文本和唯一标记；`fixtures/appops.json` 及设备读回确认 allow 恢复为 default。

边界：要求 Markor 已完成引导，当前验证英文 Settings 和默认 QuickNote 路径。源文字由观察结果转为剪贴板写入，不是模拟原应用的复制菜单。其他应用组合、真机、多语言界面或云同步尚未验收；两个应用内的界面检查通过不等于任意跨应用任务完成。

## 原生文本分享

Flow 和 MCP execute_action 支持 `{ "kind": "share-text", "text": "中文内容", "packageName": "net.gsantner.markor" }`。通过 Android ACTION_SEND / text/plain 传递文本，可选 subject 与目标包；不指定包时由系统解析接收者。文本上限 8192 UTF-8 字节，标题上限 1024 字节，拒绝空白、NUL、未知字段和非法包名。远端 shell 参数单引号转义，启动错误使动作失败。启动成功只表示 Intent 已交给接收者，仍需检查点与业务结果验证。

`node scripts/verify-text-share.mjs emulator-5554` 已验证 Markor 接收中文、emoji、多行、单双引号、字面 shell 表达式及 `%s`，选择 QuickNote 后拉取文件校验原文与唯一出现次数；不存在的目标包导致 Flow 失败且后续步骤未执行。临时存储 AppOps 由 Flow 恢复，设备读回为 default。证据：`.appvanta/runs/text-share-1790427425340/verification.json`。

此脚本向现有 QuickNote 追加唯一测试文本，不删除原内容。当前未覆盖附件分享、系统选择器、标题接收语义、其他接收应用或真机。
