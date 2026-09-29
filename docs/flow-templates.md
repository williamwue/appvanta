# Flow 变量、参数化子流程与分支

`compileFlowTemplate(template)` 把 JSON 模板编译为现有 `FlowDefinition`。CLI 提供相同编译入口：

```powershell
appvanta compile-flow docs/templates/markor.json compiled.json
appvanta run-flow emulator-5554 compiled.json
```

输出文件必须尚不存在；编译不执行设备动作。编译后的具体 Flow 可以通过现有 CLI、MCP 或 SDK 执行。运行记录保存展开后的动作和值，恢复时不重新读取模板。模板源文件仍需调用方自行保留；编译结果和证据可能包含输入文本，不应放入密钥。

根级 `variables` 声明字符串、有限数值、布尔值或 null。`{"$var":"name"}` 是整值引用，保留其类型；字符串 `${name}` 保持原样，不插值、不求值。最终字段类型由原 Flow 解析器检查，例如字符串 `"1000"` 不能替代数值超时。

根级 `fragments` 定义具名子流程，每个包含 `parameters` 数组和非空 `steps`。`{"use":"fragmentName","with":{"parameter":"value"}}` 展开调用；参数必须完整匹配。参数值可以引用调用者作用域中的变量。子流程内部只看见全局变量及本次显式参数，参数同名时覆盖全局变量，不隐式继承调用者的其他局部参数。片段可调用其他片段，但不允许递归。

编译限制为 100 个全局变量、100 个片段、每片段 100 个参数、32 层调用嵌套、1000 个展开步骤和 100000 个遍历节点；变量对象和数组不作为绑定值。未知变量、未知片段、循环引用或不合法的最终 Flow 都会拒绝编译。

当前是显式离线编译，输入文件为 JSON。动态提取值、外部文件导入、循环及 MCP 直接编译工具尚未实现。`node scripts/verify-flow-template.mjs [device]` 验证真实 CLI 编译、拒绝覆盖及可选设备 CLI/MCP 执行与持久 Flow 一致性。

## 模板 then/else

模板步骤支持 `{"if": condition, "then": [...], "else": [...]}`。`then` 必须为数组，`else` 可省略；允许其中一侧为空，但两侧不能同时为空。条件为文本/目标可见或不可见、应用进程运行等当前状态条件。编译时不查询设备，而是将两侧步骤展开为下面的持久分支选择器；运行时每个选择只查询一次。

分支中可以调用参数化片段或继续嵌套分支，片段中也可以包含分支。内层仅在所有外层均选中时查询；外层未选中时，不查询内层或步骤自身的 `when`。每次片段展开获得独立的编译器分支 key，避免两次片段调用意外复用决定。`template_branch_` 前缀保留给编译器，模板内显式原生选择器不能占用。最多允许 32 层分支，两个分支展开后的所有步骤合计计入 1000 步上限。

完整示例见 `docs/templates/branch.json`，可执行：

```powershell
appvanta compile-flow docs/templates/branch.json compiled-branch.json
appvanta run-flow emulator-5554 compiled-branch.json
```

## 运行时条件步骤

普通 Flow 步骤可提供 `when`，支持文本/目标可见或不可见、应用进程运行等当前状态条件；不接受需要时间窗口的 `screen-stable` 或 `ui-changed`。条件在该步骤任何启动应用、打开链接、动作和检查点之前判断一次。

条件为真时执行步骤；为假时记录 `skipped`，不执行动作、检查点、echo 或恢复规则。条件查询失败会使步骤失败，不当作假值；取消同样停止执行。资源夹具仍在步骤之前初始化，`when` 不控制整份 Flow 的资源初始化。全部步骤均通过或按条件跳过且清理成功时，Flow 结果为 passed，因此应检查具体步骤状态来确认动作是否执行。

`app-running` 在设备端输出 `pidof` 的状态标记，只把状态 1 且输出为空认作“无进程”；状态 0 必须包含有效正整数 PID。ADB 退出码 1 本身不能证明无进程：它也可能表示设备不可用。该传输错误、命令错误文本或不完整标记都会拒绝判断。专项回归在修复前证明旧实现吞掉设备离线错误，修复后通过。API 37 实际进程/缺失进程/未知设备序列号验收为 `.appvanta/runs/process-condition-1790707661502/verification.json`；未知序列号是实际 ADB 失败，但不等于真机拔插。修复后的 CLI/MCP 联合验收为 `flow-template-1790707661807/verification.json`，完整测试 222 项通过。

每次判断保存 `condition-N.json`、判断前的观察证据和 `conditionMatched` 报告字段；进度检查验证决定与原步骤、报告和证据摘要一致。已完成的跳过步骤不会进入边界续跑计划。判断/执行中崩溃仍是不确定步骤，需要现有显式裁决流程。录制回放只包含当次实际动作，将跳过步骤转为说明性 echo，不重新判断条件或补执行原动作。

`when` 仍是逐步骤条件执行。需要复用同一次选择时，使用模板 `if/then/else` 或下述原生 `branch`，不能用两个独立 `when` 代替一次分支选择。

## 持久分支决定

步骤可指定 `branch: { key, when, equals }`。相同 key 的条件只在首次到达时查询一次，并在任何动作前以独占创建和 fsync 写入 `branch-<key>.json`；后续步骤复用该决定。`equals: true` 表示选择真分支，`equals: false` 表示选择假分支。同 key 必须声明相同条件，key 只允许字母开头及字母、数字、下划线、连字符，最多 64 字符。

嵌套步骤的 `branch.parents` 按外到内列出 1–31 个祖先选择器。解析器拒绝重复 key 和同 key 不一致的祖先关系；执行器从外到内短路判断。决定文件仅为实际到达的条件生成，证据校验不会要求未访问分支的虚构文件。

```json
{"name":"One decision","steps":[
  {"description":"Then","branch":{"key":"running","when":{"kind":"app-running","packageName":"net.gsantner.markor"},"equals":true},"echo":"App was running at branch entry"},
  {"description":"Else","branch":{"key":"running","when":{"kind":"app-running","packageName":"net.gsantner.markor"},"equals":false},"echo":"App was absent at branch entry"}
]}
```

未选中步骤记录 `skipped` 和 `branchMatched: false`，不执行其 `when`、动作、检查点或业务恢复。选中步骤仍可使用自身的 `when`。分支查询错误不当作假值。报告引用共享决定和观察证据，进度校验和录制回放都会核验选择及证据；回放只保留已执行动作。

安全边界续跑从已完成步骤的已校验证据读取决定，将剩余同 key 选择器（含祖先）写为 `resolved`，不会因设备当前状态变化而重新选分支。回执标记 `source: resolved`，区别于现场查询的 `observed`。显式提交含 `resolved` 的 Flow 也会固定选择，不会查询设备；该字段不声称现场条件为真。未访问的内层不补造决定，仍受已固定外层约束。

首个分支步骤尚未完成时，裁决预览包含已落盘的可达分支决定、原始字节摘要，以及尚未生成的决定。裁决准备只能使用同一预览中的已验证决定，将剩余同 key 选择器固定；预览后创建或改写决定文件会使原裁决失效。可达选择缺失时仍拒绝准备。准备记录保持 `resumeAuthorized: false`，实际续跑仍需现有租约、资源恢复和现场检查点门禁。

本地回归覆盖首次分支动作执行中的真实宿主进程强杀、保留原决定、缺失证据拒绝，以及任务裁决记录对决定字节变化的拒绝。强杀测试使用测试 Driver；此新增分支裁决路径的 Android CLI/MCP 完整闭环仍待验收。

验证：core 专项使用变化的假设备状态证明只查询一次，并验证篡改拒绝、错误停止和真实宿主强杀后的决定固定。API 37 的 `flow-branch-1790711504339/verification.json` 验证 CLI/MCP 均产生 skipped/skipped/passed/passed 四步结果，未选中动作没有执行。四包构建及 core 111、Android 87、脚本 40 项共 238 项测试通过。设备验收已加入托管 CI，结果需绑定对应后续提交。

嵌套验收：四种真假组合、非法分支/祖先拒绝、外层真假两种真实宿主强杀续跑均通过。API 37 的 `flow-branch-1790712052784/verification.json` 验证真实 CLI 编译嵌套模板及 CLI/MCP 执行，输出 skipped/passed/passed/skipped，两个决定分别为真和假。完整构建及 core 117、Android 87、脚本 40 项共 244 项测试通过。基础分支公开 `f113b79` 的托管运行 `36622517753` 已全绿，但不包含本轮嵌套实现。

条件执行的本地 API 37 CLI/MCP 联合证据为 `.appvanta/runs/flow-template-1790707446034/verification.json`，两条入口均产生 passed/skipped/passed 三步结果且清理成功。四包构建及 221 项完整测试通过，专项还验证了跳过后的真实宿主强杀、边界续跑计划与条件证据篡改拒绝。此前不含条件的模板提交 `36f8749` 已在托管运行 `36613274689` 四项通过；条件实现需等待自己的托管验收。

本地 API 37 证据：`.appvanta/runs/flow-template-1790706845503/verification.json`。四包构建及完整测试通过；模板专项覆盖类型保留、嵌套片段、输入不变、作用域隔离、递归和超限拒绝。三系统编译及托管 API 35 执行已接入 CI，需以包含此实现的提交结果确认。
