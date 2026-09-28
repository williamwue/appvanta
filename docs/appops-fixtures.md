# AppOps 模式夹具

Flow 可声明包级操作模式：

```json
{
  "name": "Storage denial scenario",
  "appOps": [{ "packageName": "net.gsantner.markor", "operation": "MANAGE_EXTERNAL_STORAGE", "mode": "ignore" }],
  "steps": [{ "description": "Launch after changing access", "launchPackage": "net.gsantner.markor" }]
}
```

最多 20 个不重复的包名/操作组合，支持 allow、ignore、deny、default。准备前读取原包级模式，先保存恢复记录再修改，随后读取核验。成功、失败、取消以及部分初始化失败后，逆序恢复原模式；恢复失败使 Flow 失败。变更权限可能导致 Android 终止应用，Flow 应在准备后显式启动应用。

`fixtures/appops.json` 保存原模式、请求模式和恢复结果；`audit.jsonl` 记录操作、目标、状态及本地进程标识。进程标识不是经认证的用户身份。回放保留配置，回归比较检查配置，APK 环境采集纳入相应应用。

AppOps 不是 `pm grant/revoke` 的运行时权限授权；后者见 [Android 运行时权限夹具](runtime-permissions.md)。应用未声明对应能力时，系统可能不应用请求模式；读回不一致即失败。UID 级覆盖、未知模式和未知操作会被拒绝，不把包级设置成功当作最终权限已生效。不使用全局 appops reset，不修改其他操作。

恢复 default 保证回到默认模式语义，不恢复历史访问/拒绝时间或抹除系统记录。运行时权限标志、UID 覆盖、多用户、企业策略和 OEM 差异尚未实现或验收。宿主强制终止/设备断线后的自动恢复仍待完成。

验证：`node scripts/verify-appops-fixture.mjs emulator-5554`。验证 allow/default 原值恢复、业务成功/失败/取消、未知操作导致的部分回滚及审计事件。单元测试覆盖 UID 覆盖、模糊输出和非法操作拒绝。

API 37 实测：`.appvanta/runs/appops-fixture-check-1789538126378/verification.json`。
