# Flow 动态文本值

`extract` 从当前观察的 UI 树读取一个语义控件，将字符串保存为具名值；`inputValue` 把该值传给正常输入动作。两者通过 CLI `run-flow`、MCP `run_flow` 和 SDK 的同一 Flow 执行路径运行。

```json
{
  "name": "Read and reuse",
  "steps": [
    {
      "description": "Read editor",
      "extract": {
        "name": "note",
        "target": { "kind": "resource-id", "value": "example:id/editor" },
        "attribute": "text"
      }
    },
    {
      "description": "Insert observed text",
      "inputValue": {
        "name": "note",
        "target": { "kind": "resource-id", "value": "example:id/destination" }
      }
    }
  ]
}
```

`attribute` 支持 `text` 和 `accessibility-label`。目标支持 resource-id、text、accessibility-label、ui-path，以及既有 within/occurrence 限定；不支持坐标或图片模板。Android 使用该步骤已经捕获的 UI 树，重复匹配要求显式消歧，缺失目标和密码控件会失败。空字符串是有效提取值。输入是插入当前选区，不会自动替换编辑器全文。

名称以字母开头，最多 64 个字母、数字、下划线或连字符。值最多 24000 UTF-8 字节，拒绝 NUL 和未配对代理字符。一个运行最多保存 100 个值，名称只能赋值一次。根级 `values` 可提供初始字符串，例如 `"values": {"note":"preset"}`；它不表示这些值来自当前设备。模板编译时的 `$var` 与运行时的具名值分开处理。

提取和引用各自占一个步骤，可带 `when` 或 `branch`，不能混合其他操作、业务检查点或自动恢复。跳过的提取不产生值；引用缺失值会失败，后续输入不会执行。提取值按原文处理，不执行表达式、字符串插值或 shell 命令。

每个已执行提取保存并同步 `value-N.json`，报告 `output` 保存字符串，步骤证据包含原始观察及值记录。完整进度记录绑定证据摘要。安全边界续跑从已验证的已完成步骤恢复值，并在后继 Flow 的 `values` 中固定它们，不重新读取设备。提取尚未完成时禁止通过“跳过”裁决继续；其他不确定动作仍走原有裁决门禁。录制回放保留真实输入的具体文本，提取步骤变成说明性 echo。

值及原始 UI 树会出现在本地证据、任务和回放中，不应使用此功能保存密钥；密码控件拒绝提取不等于所有敏感内容均会被识别或脱敏。

验证入口：`node scripts/verify-flow-values.mjs <device>`。它在独立 Markor 文件中分别通过 CLI、MCP 和真实宿主强杀后的 CLI 续跑执行，核对完整文件、实际输入记录、进度、输入法和 AppOps 恢复。真实设备/OEM、多用户、WebView 和其他编辑器仍需各自验收。当前只提供字符串提取及输入引用；数值转换、正则捕获、任意字段引用和循环尚未实现。

API 37 本地上述三条路径均通过，证据：`.appvanta/runs/flow-values-1790714385578/verification.json`；`crash-source.json` 保存中断来源及遗留租约。构建及完整 253 项回归通过（core 125、Android 88、脚本 40），之后补充的容量边界通过 core 值测试 4 项复验。托管 API 35 验收已接入，结果须以对应修订运行记录为准。
