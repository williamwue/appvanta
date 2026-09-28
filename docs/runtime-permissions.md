# Android 运行时权限夹具

Flow 可以在动作开始前设置应用运行时权限，并在成功、失败或取消后恢复原授权状态和权限标志：

```json
{
  "name": "Camera denial scenario",
  "permissions": [
    { "packageName": "com.example.app", "permission": "android.permission.CAMERA", "state": "deny" }
  ],
  "steps": [{ "description": "Launch without camera access", "launchPackage": "com.example.app" }]
}
```

每个 Flow 最多声明 20 个不重复的包名/权限组合。准备前记录当前 Android 用户、同一份 `dumpsys package` 快照中按包名、用户及 runtime permissions 区段隔离的授权状态和标志，先原子写入 `fixtures/permissions.json`，再执行 `pm grant` 或 `pm revoke` 并读回核验。恢复时按相反顺序处理；当前用户变化、设备不匹配或权限状态被外部修改都会令恢复失败，不会覆盖未知外部状态。恢复结果同时写入夹具记录和 `audit.jsonl`。

运行环境证据在修改前保存声明权限的原始状态，因此两次运行比较可以发现用户、授权或标志变化。回放会保留权限配置。权限夹具只处理应用已声明、系统允许动态变更的运行时权限；设备策略、特殊权限、角色、通知设置和 AppOps 使用各自的系统机制。

AppOps 控制底层操作模式，运行时权限控制包在指定 Android 用户下的授权。两者可以同时声明，清理时先恢复 AppOps，再恢复运行时权限。

离线测试覆盖 Schema、输出解析、Flow 清理失败传播与恢复记录校验。连接设备后运行：

```powershell
npm run build
node scripts/verify-permission-fixture.mjs emulator-5554
node scripts/verify-permission-recovery.mjs emulator-5554
```

验证脚本构建并安装 AppVanta 测试 APK。第一项覆盖 Flow 成功、失败和取消，并检查动作期间状态、完整原值恢复及环境证据；第二项强制终止夹具宿主进程，检查外部改值保护、重试、幂等恢复、错误设备拒绝和设备锁释放。API 37 模拟器已通过三条 Flow 路径（`.appvanta/runs/permission-fixture-check-1790422683562/verification.json`）和强杀、外部冲突拒绝、重试、幂等恢复（`.appvanta/runs/permission-recovery-1790422735746/verification.json`）。恢复只修改有差异的标志，避免改写未变化的系统管理标志；仍校验完整原值。真机、其他 Android 版本及多用户在线验收待完成。
