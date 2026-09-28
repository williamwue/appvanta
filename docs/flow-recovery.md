# Flow 有限恢复

CLI `run-flow`、MCP `run_flow` 和 `start_flow` 共用恢复执行器。未声明 `recovery` 的 Flow 保持失败后重新观察并结束的行为。

```json
{
  "version": 1,
  "name": "Return to Markor",
  "steps": [{
    "description": "Ensure Markor navigation is visible",
    "assertTarget": {
      "kind": "resource-id",
      "value": "net.gsantner.markor:id/nav_quicknote"
    },
    "timeoutMs": 1000,
    "recovery": {
      "maxAttempts": 1,
      "rules": [{
        "description": "Open Markor if Settings is visible",
        "when": { "kind": "text-visible", "text": "Settings" },
        "launchPackage": "net.gsantner.markor"
      }]
    }
  }]
}
```

## 执行规则

- 必须有原步骤的 `assertText` 或 `assertTarget`，恢复最终仍须通过该检查点。
- `maxAttempts` 为 1–3，规则数量为 1–10；每次观察后按顺序选第一个匹配规则。
- 每条规则必须有说明和 `when`，并且只能包含一个 `action` 或 `launchPackage`。不接受缺少基准快照的 `ui-changed` 守卫。
- 原步骤动作、启动和 URL 不会自动重放。恢复操作是用户或 Agent 在 Flow 中显式声明的操作。
- 恢复前重新抓取界面，抓取或条件检查失败则停止；没有匹配规则则失败。
- 恢复操作失败或原检查点仍不通过时，在次数上限内重新观察，再决定下一次操作。重复操作可能产生副作用，应只给可安全重复的规则设置多次尝试。
- 取消立即停止选择后续操作，资源清理由原执行器负责；恢复失败不会跳过该步骤继续后续业务操作。

## 证据

`recovery.jsonl` 保存步骤号、尝试号、时间、守卫匹配、所选操作和结果。恢复前的截图/UI 树、首次失败和最终观察都纳入步骤证据。`ui/recovery-<step>-<attempt>.json` 保存观察索引。原始错误在报告诊断中保留，成功恢复的步骤显示 passed，并注明恢复次数与检查点通过。

这是预先声明规则的有限恢复，不是模型自动诊断，也不包含进程重启后续跑、断线恢复或设备锁接管。Driver 不调用模型；Agent 可以根据失败证据选择下一份计划。

## 验证

```powershell
npm run build
npm test
node scripts/verify-flow.mjs emulator-5554 --recovery
```

自动测试覆盖恢复成功、次数耗尽、无匹配、观察失败、取消、恢复动作失败，并检查原输入仅执行一次。模拟器验证器通过错误前台应用触发恢复，检查 CLI/MCP 同步成功与失败、MCP 异步失败，以及取消。

本地 API 37 模拟器七场景验收通过：`.appvanta/runs/flow-integration-1789532180402/verification.json`，包括 CLI/MCP 同步恢复成功/失败、MCP 异步恢复成功/失败和取消。完整构建与 18 项自动测试通过；不代表真机或三个 Agent 产品内接入完成。
