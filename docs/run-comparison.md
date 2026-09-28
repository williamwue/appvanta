# 运行回归比较

```powershell
node packages/cli/dist/index.js compare baseline-run current-run
```

默认返回 `scope: "run"`，检查两个目录的以下内容：

- run.json 必须是完整 passed 运行，包含有效起止时间、运行 ID 和 Driver。
- device.json 必须包含平台、设备类型、型号和系统版本，比较时这些字段必须相同。Android 新 Flow 使用系统 build fingerprint。
- flow.json 的版本、动作、定位器、输入参数、检查点、恢复规则与网络、采集、诊断、应用声明配置必须相同。
- actions.jsonl、flow.json、steps.jsonl 必须通过运行结束时保存的 SHA-256 校验；实际执行动作和恢复路径必须相同。
- steps.jsonl 的步骤数量、顺序、描述和状态必须一致且全部通过。
- environment.json 必须通过哈希校验，包含声明应用的 base/split APK SHA-256，以及 Node/ADB 版本、宿主平台/架构、core/android 实际执行 JS 指纹。应用与工具信息必须相同。
- report.json 的 metadata/steps 必须与 run.json/steps.jsonl 一致。

不同运行的 ID、时间戳和证据文件路径不会作为运行间差异；对象字段排列顺序不影响比较。设备 serial 可以不同，但记录的型号、系统和设备类型须相同。缺失信息会失败，不以未知环境当成相同环境。

## 旧记录迁移

只有旧版步骤记录时，可显式使用：

```powershell
node packages/cli/dist/index.js compare baseline-run current-run --steps-only
```

输出 `scope: "steps-only"`，不检查运行最终状态、设备环境或实际动作。默认命令不自动降级；旧记录缺少系统版本、动作日志或 environment.json 时，建议重新运行生成完整证据。

这项比较没有执行截图像素对比、业务数据库检查或性能阈值比较；性能使用独立 `baseline` 命令。应用 APK 哈希、Node/ADB/runtime 指纹及 Flow 声明的运行时权限原值已纳入，但输入法、文件数据、AppOps、网络服务、第三方 Python 依赖和完整环境夹具仍未全部纳入；当前结果不等于所有环境条件完全一致。完全相同的错误断言仍可能共同通过，业务检查点需要自行定义。

## 验证

`npm test` 覆盖相同步骤名但输入变化、执行序列变化、设备/系统变化、失败运行、非法时间、证据截断和兼容模式。`node scripts/verify-comparison.mjs emulator-5554` 验证两次 Markor 运行通过、复制证据最终状态变化被拒绝，并确认 CLI 退出码及显式比较范围。

API 37 实测：`.appvanta/runs/comparison-check-1789533144196/verification.json`，包含报告一致性检查的复验。

## 应用范围与工具指纹

自动纳入 Flow 的 launchPackage、app-running 条件、恢复动作及 diagnostics 包名。仅点击/输入或跨应用跳转流程应额外声明 `"applications": ["net.gsantner.markor", "other.app"]`；最多 20 个不重复包名。运行会记录声明但未安装的应用。没有可识别应用时仍可执行 Flow，但默认完整比较会因应用环境缺失而失败。

APK 在运行开始前由设备端 sha256sum 计算，涵盖 pm path 返回的 base 与 split 文件，不下载 APK。安装路径中的随机目录不参与比较。宿主代码指纹来自执行中的 core/android dist JS 内容，不以 Git 提交号替代本地改动。它不覆盖 CLI/MCP 协议实现或外部 Python 工具版本。

环境快照不检测运行过程中发生的安装变化，也不会自动枚举跳转到的所有应用；调用者应显式声明业务涉及的应用。设备固件身份仍由 device.json 单独记录。基线必须在相同代码和工具版本下重新生成，不能通过修改环境文件绕过差异。

APK/工具环境实测：`.appvanta/runs/comparison-check-1789536521857/verification.json`，包含两次 Markor 运行、有效哈希下 APK/Node 差异及应用身份缺失拒绝。
