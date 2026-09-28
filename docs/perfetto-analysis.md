# Perfetto trace 分析

使用官方 Python Trace Processor 分析已经保存的 Android trace，不需要连接设备。AppVanta 仓库不包含第三方 Trace Processor 二进制。

## 安装与调用

```powershell
python -m venv .appvanta/perfetto-venv
.appvanta/perfetto-venv/Scripts/python.exe -m pip install -r scripts/perfetto-requirements.txt
node packages/cli/dist/index.js analyze-perfetto <trace路径> <应用包名> .appvanta/perfetto-venv/Scripts/python.exe 20000
```

CLI 最后两个参数为可选的 Python 路径和分析窗口毫秒数；省略 Python 时使用 `APPVANTA_PERFETTO_PYTHON` 或 PATH 中的 `python`。MCP 工具 `analyze_perfetto` 接受 `trace`、`packageName`、可选 `python`、`scenario`、`windowMs`。

官方 SDK 首次运行可能下载 Trace Processor。离线环境可直接调用 Python 脚本，通过 `--processor <可执行文件>` 指定已有工具。`--scenario` 可标记实验场景，但不会自动创建受控工作负载。

官方接口说明：[Python API](https://perfetto.dev/docs/analysis/trace-processor-python)、[Trace Processor CLI](https://perfetto.dev/docs/reference/trace-processor-cli)。

## 指标与证据

每次分析使用独立目录，保存 `analysis.json`、`metrics.json`、`report.md`。分析记录包含源 trace 路径及 SHA-256、实际 SQL、工具版本、窗口、进程与线程明细。失败保留分析错误，不生成成功指标。

- `cpu.scheduledTime`：应用及以 `包名:` 开头的子进程在窗口内获得 CPU 调度的累计纳秒数。
- `cpu.singleCoreEquivalent`：累计调度时间除以窗口时间的百分比。多核并行时可以超过 100%。

窗口从 trace 起点开始；省略窗口时使用 trace 时长向下取整到毫秒。调度片段截断到窗口边界。缺少应用、调度数据、Android fingerprint，或发现解析错误、数据丢失时拒绝生成指标。

指标采用性能测量版本 2，可交给 `baseline` 命令。设备身份取 fingerprint 中的 product 字段，不能与 meminfo 采集的型号字段直接视为相同；采集器名称和版本也必须匹配。阈值应来自独立定义的受控实验，验证脚本中等于当前值的阈值仅用于测试门禁行为。

## 当前验证与边界

`node scripts/verify-perfetto.mjs <trace> <python>` 验证 CLI/MCP 一致性、源文件哈希、线程汇总、报告、基线通过与失败，以及缺失应用、过长窗口和损坏文件的拒绝路径。

当前实测：API 37 模拟器保留的 22 秒 trace，分析前 20 秒，证据目录 `.appvanta/runs/perfetto-check-1789534742437/verification.json`。

采集协作取消后的远端进程回收已实测，见 [采集回收](capture-lifecycle.md)。

Flow 自动启动和结束采集已接入，成功、失败和取消路径均保存产物。

尚未完成：受控多次采样、帧卡顿分析、宿主强制终止或设备断线后的恢复、分析子进程取消管理。指标不表示墙钟耗时或频率加权工作量。工具当前依赖仓库布局下的 Python 脚本；发布包分发仍需验收。

## Flow 步骤的设备时间关联

分析器自动读取 trace 同目录的 `step-markers.json`，用唯一运行 token 查找 counter 事件，并严格核对开始/结束配对。缺少、重复、错序或不匹配会失败，不会输出指标。没有 sidecar 的独立 trace 不声称具备步骤关联。

`analysis.json` 的 `steps` 保存每步起止纳秒、区间时长和应用调度 CPU 纳秒，Markdown 同时输出步骤表。步骤使用完整 trace 内的标记区间，不受整体 `windowMs` 截断；包含观察、检查、恢复、ADB 与记录开销，不能当作应用独立响应时间或受控基线。电脑时间只用于辅助记录，不用于对齐。

官方 counter 查询方式见 [Perfetto 查询示例](https://perfetto.dev/docs/getting-started/in-app-tracing)。AppVanta 使用设备 trace_marker 写入标记；不同设备权限尚待验收。

真实成功/失败/取消关联和缺失/错序/错运行拒绝验证：`.appvanta/runs/trace-steps-check-1789535489098/verification.json`。复验命令：

```powershell
node scripts/verify-trace-steps.mjs <Flow采集验证JSON> .appvanta/perfetto-venv/Scripts/python.exe
```
