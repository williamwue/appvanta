# 性能基线版本 2

`baseline <baseline.json> <measurement.json>` 支持带单位、采样条件的版本 2。通过返回 `passed: true` 和退出码 0；缺失值、格式错误、不兼容条件或超限返回失败及非零退出码。

下面是格式示例，数值不是实际设备性能结论：

```json
{
  "version": 2,
  "kind": "baseline",
  "context": {
    "platform": "android",
    "deviceModel": "test-model",
    "osVersion": "37",
    "appId": "net.gsantner.markor",
    "scenario": "open-note",
    "collector": "project-launch-timer",
    "collectorVersion": "1",
    "sampling": {
      "durationMs": 10000,
      "iterations": 3,
      "warmupIterations": 1,
      "aggregation": "median"
    }
  },
  "metrics": {
    "duration": { "unit": "ms", "max": 500 },
    "frameRate": { "unit": "fps", "min": 30 }
  }
}
```

测量文件使用相同 `version` 和 `context`，`kind` 为 `measurement`，指标条目改为 `{ "unit": "ms", "value": 450 }`。每个基线指标至少有 `min` 或 `max`，边界值包含在通过范围。额外的有效测量指标可以保留，不参与没有阈值的比较。

## 比较条件

- context 各字段必须存在，基线与当前值必须完全一致；不同设备、系统、业务场景和采集器版本不能直接比较。
- 采样时长、有效次数、预热次数和聚合方式必须一致。支持 mean、median、p95、max、single；single 要求次数为 1。
- durationMs 为计划采样窗口，瞬时单次测量可设为 0。iterations 不包含 warmupIterations。
- 支持 ms、ns、bytes、percent、count、fps；不自动换算。单位不一致直接失败，采集器应明确完成转换后输出。
- 指标值和阈值必须是有限非负数字，采样整数参数不得超过安全整数范围；未知字段或版本直接失败。

这里校验的是测量元数据与阈值，不负责采样或计算中位数/百分位。采集器必须实际满足声明的采样条件。`performance` 命令已额外生成版本 2 内存测量文件；原始 cpuinfo/meminfo 文本仍保留。Perfetto 解析、CPU 结构化指标和多次受控采样仍需完成。也没有验证温度、后台负载或功耗状态，因此一次门禁通过不等于性能稳定性结论。

## 兼容与验证

版本 1 `{ "version": 1, "values": { "durationMs": 100 } }` 仍接受旧数字测量对象，但返回明确 warning：没有单位/采样验证。缺少版本或不支持版本不会自动降级。新基线应使用版本 2。

`npm test` 包含核心字段/采样/单位不一致、上下限、边界值、非法数字、未知版本与 CLI 实际子进程退出码测试。托管 CI 的运行验收仍单独待办。

## Android 内存快照接入

```powershell
node packages/cli/dist/index.js performance emulator-5554 net.gsantner.markor markor-current-state
node packages/cli/dist/index.js baseline baseline.json <返回的metricsPath>
node scripts/verify-performance.mjs emulator-5554
```

MCP `collect_performance` 接受 deviceId、packageName 和可选 scenario，返回原始 `path`、版本 2 `metricsPath`、`summaryPath` 及时间。默认场景为 `uncontrolled-snapshot`；场景名只是标签，不会自动运行或准备场景。

采集器 `adb-meminfo-app-summary` 版本 1 输出 memory.pss、memory.rss、memory.swapPss（bytes）和 memory.processCount（count）。从各进程 App Summary 的 KB 数字乘以 1024，并按进程求和。拒绝缺失/重复汇总、错误包名、未知单位和整数溢出，避免将未知数据当成零。包名相同或 `包名:子进程` 的记录可合并；自定义全局进程名称暂不支持。

RSS 合计可能重复计算共享页面，PSS 是按比例分摊的内存；二者不能互换。语义依据：[Android dumpsys 文档](https://developer.android.com/tools/dumpsys)。每次采集是单次快照，durationMs=0、iterations=1、warmupIterations=0、aggregation=single。系统版本字段保存完整 build fingerprint，以防不同系统构建被当成同一环境。

原始证据与测量使用唯一文件名；汇总保存进程列表、采集起止时间、原始文件 SHA-256 和相对文件名。解析失败会保留原始文本与失败汇总，并使命令失败。CPU 仅保留原文，不能用这里的内存快照推导 CPU/帧率指标。

API 37 模拟器实测：`.appvanta/runs/performance-check-1789532958919/verification.json`。覆盖 CLI/MCP 采集一致的元数据、原文哈希校验、测量值边界通过、故意超限失败、未运行应用拒绝。阈值由该次测量生成以验证链路，不是推荐的产品性能阈值。
