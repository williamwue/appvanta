# Flow 变量与参数化子流程

`compileFlowTemplate(template)` 把 JSON 模板编译为现有 `FlowDefinition`。CLI 提供相同编译入口：

```powershell
appvanta compile-flow docs/templates/markor.json compiled.json
appvanta run-flow emulator-5554 compiled.json
```

输出文件必须尚不存在；编译不执行设备动作。编译后的具体 Flow 可以通过现有 CLI、MCP 或 SDK 执行。运行记录保存展开后的动作和值，恢复时不重新读取模板。模板源文件仍需调用方自行保留；编译结果和证据可能包含输入文本，不应放入密钥。

根级 `variables` 声明字符串、有限数值、布尔值或 null。`{"$var":"name"}` 是整值引用，保留其类型；字符串 `${name}` 保持原样，不插值、不求值。最终字段类型由原 Flow 解析器检查，例如字符串 `"1000"` 不能替代数值超时。

根级 `fragments` 定义具名子流程，每个包含 `parameters` 数组和非空 `steps`。`{"use":"fragmentName","with":{"parameter":"value"}}` 展开调用；参数必须完整匹配。参数值可以引用调用者作用域中的变量。子流程内部只看见全局变量及本次显式参数，参数同名时覆盖全局变量，不隐式继承调用者的其他局部参数。片段可调用其他片段，但不允许递归。

编译限制为 100 个全局变量、100 个片段、每片段 100 个参数、32 层调用嵌套、1000 个展开步骤和 100000 个遍历节点；变量对象和数组不作为绑定值。未知变量、未知片段、循环引用或不合法的最终 Flow 都会拒绝编译。

当前是显式离线编译，输入文件为 JSON。运行时条件分支、动态提取值、外部文件导入、循环及 MCP 直接编译工具尚未实现；现有等待条件不等于分支控制。`node scripts/verify-flow-template.mjs [device]` 验证真实 CLI 编译、拒绝覆盖及可选设备执行与持久 Flow 一致性。

本地 API 37 证据：`.appvanta/runs/flow-template-1790706845503/verification.json`。四包构建及完整测试通过；模板专项覆盖类型保留、嵌套片段、输入不变、作用域隔离、递归和超限拒绝。三系统编译及托管 API 35 执行已接入 CI，需以包含此实现的提交结果确认。
