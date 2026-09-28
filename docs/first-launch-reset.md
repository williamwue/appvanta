# 首次启动与应用数据重置

Flow 可显式声明在执行步骤前清除应用数据：

```json
{
  "name": "First launch flow",
  "resetApplications": ["com.example.app"],
  "steps": [
    {
      "description": "Launch from clean application state",
      "launchPackage": "com.example.app",
      "assertText": "Welcome"
    }
  ]
}
```

AppVanta 先采集应用 APK 身份和运行环境，再为每个包写入 `fixtures/app-data-reset.json`，随后确认应用已安装并执行 `adb shell pm clear`。只有输出精确为 `Success` 才进入业务步骤。每项开始、成功或失败同时写入 `audit.jsonl`，部分完成时保留逐包状态。

这是显式破坏性前置条件，不是可恢复夹具。Android 没有适用于任意第三方应用的通用私有数据备份/恢复接口；Flow 成功、失败、取消或宿主中断后都不会恢复原应用数据，`recover-flow` 也不会重新执行清理。需要保留数据时，应使用专用测试账号、应用自身导入导出能力、可重建测试数据库或设备快照。

清除应用数据通常可以触发应用自己的首次启动流程，但不保证清除服务端账号状态、系统角色、设备策略、外部共享存储、OEM 服务或云端恢复数据。业务步骤必须用 Welcome 页面、登录状态等检查点证明实际进入了预期状态。

在线验证入口：

```powershell
npm run build
node scripts/verify-app-data-reset.mjs emulator-5554 net.gsantner.markor
```

验证器在应用专属外部目录写入并读回唯一标记，启动应用后执行带 `resetApplications` 的 Flow，确认标记删除、清理记录、审计事件及 APK 身份证据。Markor 额外等待引导页 `net.gsantner.markor:id/next` 控件；其他应用参数仅验证进程存在。API 37 / Markor 2.16.1 已通过，证据为 `.appvanta/runs/2026-09-26T11-45-50-944Z-emulator-5554-1729e2b8/app-data-reset-verification.json`。不代表已验证所有私有文件、系统/云端状态或真机；不会完成引导或删除公共 Documents 中的笔记。
