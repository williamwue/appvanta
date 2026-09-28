# CI 集成

AppVanta 可在 Jenkins、GitHub Actions 或任意 Node 环境执行。最小流水线：

仓库提供 `Jenkinsfile` 和 `.github/workflows/ci.yml`。GitHub Actions 配置包含 Windows、Linux、macOS 的 Node 22 干净安装/构建/测试和 Python 恢复测试，并单独启动 API 35 Google APIs 模拟器，下载固定 Markor 2.16.1 APK、校验 SHA-256、安装并执行 `docs/examples/markor-ci-flow.json`。所有任务通过 `scripts/stage-evidence.mjs` 筛选运行证据；归档排除 CA/私钥、工具目录和符号链接，包含文件哈希清单。

当前仓库没有 Git remote，因此这些 workflow 还没有托管运行结果。配置存在不等于三个宿主和模拟器已通过；首次推送后必须检查每个 job 的日志和上传证据，再更新验收状态。

```bash
npm ci
npm run build
npm test
node packages/cli/dist/index.js reset <device-serial> <package-name>
node packages/cli/dist/index.js run-flow <device-serial> docs/examples/markor-flow.json
node packages/cli/dist/index.js export .appvanta/runs/<run-id> artifacts/appvanta
```

多个 Android 设备可并行执行一次启动与采集：

```bash
node packages/cli/dist/index.js run-many emulator-5554,emulator-5556 net.gsantner.markor
```

每台设备独立返回 `passed` 或 `failed`，单台失败不会丢失其他设备的结果。

Flow 步骤可以通过 `launchPackage` 切换应用后继续执行动作和断言，适合跨应用流程：

```json
{"description":"Open settings app","launchPackage":"com.android.settings","assertText":"Settings"}
```

Android 基础运行指标也可作为证据采集：

```bash
node packages/cli/dist/index.js network <device-serial>
node packages/cli/dist/index.js performance <device-serial> <package-name>
node packages/cli/dist/index.js record <device-serial> 5
```

性能阈值可作为 CI 门禁：

```bash
node packages/cli/dist/index.js baseline ci/baseline.json ci/current.json
```

命令超限时返回非零退出码，流水线会失败并保留已有证据。

完整回归链路示例（`record-flow` 需要新版 Flow 动作日志且运行完全通过；详见 [录制](flow-recording.md)）：

```bash
node packages/cli/dist/index.js run-flow <device> flow.json
node packages/cli/dist/index.js record-flow .appvanta/runs/<run-id> artifacts/recorded.json
node packages/cli/dist/index.js export .appvanta/runs/<run-id> artifacts/appvanta
node packages/cli/dist/index.js compare artifacts/baseline/<run-id> artifacts/appvanta/<run-id>
node packages/cli/dist/index.js baseline ci/baseline.json ci/current.json
```

在执行动作前，可先获取交互候选节点：

```bash
node packages/cli/dist/index.js explore <device-serial>
```

设备由 CI 自己提供（Android 模拟器、USB 真机或设备农场）。失败时保留导出的运行目录作为构建 artifact；其中包含步骤、截图、UI 树、日志和报告。

## 回归比较

```bash
node packages/cli/dist/index.js compare artifacts/baseline/<run-id> artifacts/current/<run-id>
```

默认比较完整运行状态、设备型号/系统、Flow 定义、实际操作序列、证据完整性及逐步骤结果，报告必须与运行记录一致。旧记录可以显式选择 `--steps-only`，不会自动降级。截图、业务数据、应用构建标识仍未覆盖，详见 [运行比较](run-comparison.md)。

`baseline` 对缺失、非法、负数测量和超限返回失败；版本 2 已校验单位、版本、采样条件和上下限，格式见 [性能基线](performance-baselines.md)；版本 1 保留兼容并提示缺少这些校验。Android 内存快照已输出可直接比较的 metricsPath；Perfetto/CPU 和多次受控采样仍待接入。CLI `export` 与 CI 已复用 core 归档筛选器，排除证书/工具目录、链接、非证据类型及包含 PEM 私钥标记的文件，生成逐文件 SHA-256 和大小清单。日志中的令牌和业务数据未做通用脱敏，历史绝对引用也尚未迁移，完整可移植导出仍待完成。

导出保留 `<destination>/<run-id>` 形式，拒绝覆盖已有目录。CLI 缺失源时失败；CI 允许尚无运行证据，生成 `missingSource: true` 清单。清单仅在全部文件写入后生成，部分失败需选择新目标重试。共享 JavaScript 筛选器可从源码直接运行，不依赖构建成功。

实测 Markor 导出 75 个文件，重新读取后全部哈希匹配：`.appvanta/export-check-1789531541854/verification.json`。自动测试覆盖 CLI/CI 一致性、私钥及链接排除、目标路径绕过、拒绝覆盖、缺失源和再次归档。
