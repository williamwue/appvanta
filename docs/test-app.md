# Android 测试应用

## 选定应用

- 应用：Markor
- 包名：`net.gsantner.markor`
- 版本：`2.16.1`
- 来源：[官方 GitHub 仓库](https://github.com/gsantner/markor) 和 GitHub Release
- 许可证：Apache-2.0（项目源码）；具体发布资产以仓库许可证和归属文件为准
- APK：`test-apps/net.gsantner.markor-v163-2.16.1-flavorDefault-release.apk`
- SHA-256：`E88CDCCED7AA3DCA25E6B9C7A9BDCFAD3E3988EE545BE951F42BF9441B5E46BF`

## 已验证

- APK 下载成功
- SHA-256 已计算
- APK 已安装到 `emulator-5554`
- 应用包名可启动
- UI 树包含 Markor 资源 ID、文本和 Accessibility 内容描述
- 当前首页存在 `net.gsantner.markor:id/next` / `NEXT` 控件，可用于语义定位验证

## 首个流程

```text
启动 Markor
→ 观察首页 UI 树和截图
→ 使用 resource ID 或 content-desc 点击 NEXT
→ 进入 Notebook 或编辑页面
→ 输入 Markdown 内容
→ 打开预览
→ 验证预览内容
→ 收集 Logcat
→ 生成运行报告
```

## 权限恢复验证

- Markor 首次运行触发系统“所有文件访问权限”页面；
- AppVanta 观察到前台包名从 `net.gsantner.markor` 切换到 `com.android.settings`；
- 测试环境通过 `adb shell appops set net.gsantner.markor MANAGE_EXTERNAL_STORAGE allow` 完成授权；
- 返回并重新启动 Markor 后，应用进入主文件浏览界面；
- 主界面已观察到 `Go to`、`Search`、`More`、`QuickNote` 等语义控件。

## QuickNote 编辑验证

- 通过 `content-desc=QuickNote` 进入 QuickNote；
- 发现编辑控件：`net.gsantner.markor:id/document__fragment__edit__highlighting_editor`；
- 通过 resource ID 语义定位编辑控件；
- 成功输入 `AppVanta smoke test`；
- 输入后成功重新采集截图和 UI 树。

当前已验证链路：

```text
启动 → 权限恢复 → QuickNote → Resource ID 定位编辑器 → 输入文本 → 重新观察
```

## 可重复验证脚本

```text
npm run build --workspace @appvanta/core
npm run build --workspace @appvanta/android
node scripts/verify-markor.mjs emulator-5554
```

脚本启动 Markor，进入 QuickNote，备份当前磁盘文件到证据目录，输入带 `#` 的唯一标记，打开 View Mode 并检查 UI 树中的实际渲染文本。随后切回 Files 触发保存，读取 QuickNote 文件断言包含精确标记，最后收集 Logcat、截图、UI 树并生成报告。仅切换预览不保证文件已经保存。

默认文件是 `/storage/emulated/0/Documents/markor/QuickNote.md`；自定义 QuickNote 路径可作为第三个参数传入。脚本要求设备完成首次引导和文件权限授权，持续在 QuickNote 中追加测试标记，不清除现有内容。输入前后文件是测试数据证据，导出时应确认适合共享。

2026-09-16 已通过文件内容与预览双重检查：`.appvanta/runs/2026-09-16T03-05-19-029Z-emulator-5554/report.md`。验证范围是此 API 37 模拟器的 ASCII 标记；不能据此宣称 Unicode 或任意输入法通过。

同一最终流程重复运行通过：`.appvanta/runs/2026-09-16T03-07-32-923Z-emulator-5554/report.md`，每次 6 个步骤。文件检查保存在 `artifacts/input-check.json`，输入前后内容保存在同目录的 `quicknote-before.md` / `quicknote-after.md`。
