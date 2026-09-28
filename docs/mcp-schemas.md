# MCP 参数契约

Android Action 的长按、硬件按钮与方向锁定枚举见 [Android 结构化动作](android-actions.md)；它们与 Flow 使用相同 `$defs.action`，不会绕过运行时解析。

工具 tools/list 中的 inputSchema 与服务端执行前校验共用同一份定义，由 Ajv 编译后复用。实现位于 packages/mcp/src/schemas.ts。共享 $defs 包含定位器、条件、动作、Flow、步骤、网络配置和恢复规则。

未知字段被拒绝；字符串不会转换成数字；缺失值不会被验证器补默认。时长使用有上下限的整数；语义断言不接受坐标；恢复必须具备原检查点。完整 flow 和旧版 steps 二选一，禁止同时传入。旧 steps 可省略 description，由运行适配器补充；完整 Flow 必须提供描述。

openUrl 使用 http-url 格式验证（HTTP/HTTPS 且可被 URL 解析），与核心解析器语义一致。客户端若自行编译 Schema，需要注册此格式，或仅将格式作为注解并由服务器执行最终验证。

先校验工具 Schema，再用核心 parseAction/parseFlow 校验，最后才获取设备锁和运行工具。非法参数/未知工具返回 JSON-RPC -32602；此前执行前校验错误统一使用 -32603，现在已区分参数错误。设备运行错误返回工具结果 isError=true；初始化及协议错误分类见 [MCP 协议](mcp-protocol.md)。完整兼容性及客户端产品验收仍待完成。

## 验证范围

npm test 的 MCP 子进程测试在 PATH 为空的环境发送 12 类非法调用，验证 -32602 且设备锁目录保持为空。另编译 tools/list 返回的 Schema，验证合法/非法 Flow、恢复、URL 和旧版 steps，与核心解析器结果对照。

node scripts/verify-flow.mjs emulator-5554 --recovery 用真实模拟器验证正常工具调用、检查点、恢复、异步及取消。本地协议验证不替代 Codex、Claude Code 和 Cursor 产品内接入验收。

校验器参考：[Ajv 官方使用说明](https://ajv.js.org/guide/getting-started)。新增依赖锁定在 package-lock.json。

API 37 模拟器七场景回归通过：`.appvanta/runs/flow-integration-1789533669380/verification.json`。构建和 25 项自动测试通过。
