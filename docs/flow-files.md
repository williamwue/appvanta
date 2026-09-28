# Flow 文件与 echo

CLI `run-flow` 和 `run-flows` 根据扩展名读取 `.json`、`.yaml` 或 `.yml`。两种格式都会立即进入同一个 core `parseFlow`，因此字段、动作、时长、URL 和恢复规则的执行边界完全相同。YAML 重复 key、语法错误、过量 alias 或 Schema 外字段会在获取设备锁和执行动作前失败。

```yaml
version: 1
name: YAML example
steps:
  - description: Record context
    echo: "Back is intentional"
  - description: Press Back
    action:
      kind: back
```

`echo` 是纯记录步骤：它不会执行 shell、ADB 或模型调用，文本只进入 `steps.jsonl`、JSON 报告和 Markdown 的 **Step output**。每项上限为 10000 UTF-8 字节。Flow 仍会在 echo 步骤保存观察证据，以保持时间线连续。

MCP 接收结构化 Flow 对象，因此不需要 YAML 文本入口；MCP 对象和 CLI 文件共用同一 Flow Schema。示例见 `docs/examples/echo-flow.yaml`。
