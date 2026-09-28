# Android UI 树、定位和等待

每次观察保留截图、原始 UIAutomator XML，以及 `ui-<id>.json`。JSON 包含根节点、父/子路径、resource ID、文本、content description、class、package、bounds，以及 enabled、visible、clickable、longClickable、scrollable、focusable、focused、selected、checkable、checked、password 状态。

`explore` / `explore_ui` 返回结构化树及最多 100 个交互候选。候选包含可直接使用的 `target`：优先唯一 resource ID，再选 Accessibility 标签或文本；存在重名时使用当前快照中的 UI 路径消歧。此接口仍是探索输入，不等于自动探索闭环。

## 定位规则

文本和 Accessibility 标签默认精确匹配，需要包含匹配时显式设置 `match: "contains"`。旧流程如果依赖隐式子串匹配，需要补上该字段。resource ID 和 UI 路径只能精确匹配。

```json
{"kind":"text","value":"Save","match":"exact"}
{"kind":"text","value":"Save","match":"contains","occurrence":1}
{"kind":"resource-id","value":"app:id/save","within":"0/1"}
{"kind":"ui-path","value":"0/1/2"}
```

`occurrence` 是过滤后结果的零起始序号；`within` 限制为指定父路径的后代，不包含父节点自身。路径为按树结构生成的零起始子节点序列，不是 XPath，也不保证跨界面变化稳定。使用路径或序号前应重新观察。

动作匹配到多个节点且未明确消歧时返回错误。不可见节点不参与匹配；disabled 节点可被观察和检查，但拒绝点击/输入。空、反向裁剪边界按不可见处理，保留结构。可见性依据 UIAutomator 属性和非空边界，并非像素遮挡分析。XML 数值/字符实体被解码；不处理 DTD 或外部实体。

UI 树不可用时可显式使用 `image-template` Target；它基于截图精确像素匹配并保存模板证据，见 [PNG 模板视觉定位](visual-locators.md)。

`assertText` 和 `text-visible` 保持包含匹配的存在性检查，不要求唯一。`assertTarget` 可以使用精确匹配和上述消歧字段。

## 条件等待

`wait.condition` 支持：

- `text-visible` / `text-absent`：包含指定文本的可见节点出现/消失。
- `target-visible` / `target-absent`：符合 target 的可见节点出现/消失。
- `app-running`：指定包名的进程存在。
- `ui-changed`：从等待开始采集的基线 UI 树发生结构、文字、状态或边界变化。不是纯截图像素变化检测。
- `screen-stable`：连续截图的 PNG 内容完全一致达到 `stableMs`（100ms–1h），适合等待动画或 WebView 画面停止变化；`stableMs` 不能超过动作的 `timeoutMs`。

当前稳定等待已改用解码后的 RGBA 像素比较，默认 channelThreshold=0、maxMismatchRatio=0；可显式设置这两个阈值及 ignoreRegions 矩形遮罩。每次与当前稳定窗口的首张图比较，超出阈值才重置窗口，避免逐帧微变累计漂移；每次比较保留 stability-*.json 和差异 PNG。API 37 验证 `.appvanta/runs/screen-stability-1790425995681/verification.json` 覆盖顶部遮罩、通道容差、成功和超时路径。更早的整图哈希说明与无容差验收为历史记录。

API 37 在线验收：`node scripts/verify-screen-stability.mjs emulator-5554`，证据 `.appvanta/runs/screen-stability-1790425623085/verification.json`。Settings 静态截图连续匹配通过；5000ms 窗口与相同等待期限无法累计完整窗口，返回超时并保存失败截图，后续 Back 未执行。Flow 步骤总时长还包含前后观察和失败采证，本次超时步骤约 10083ms，不能将等待期限等同于整个步骤耗时。该模式按离散截图采样，不保证采样间无变化；系统时钟、动画等区域可能重置窗口。动态遮罩与像素容差待实现。

```json
{"kind":"wait","condition":{"kind":"target-absent","target":{"kind":"resource-id","value":"app:id/loading"}},"timeoutMs":10000}
{"kind":"wait","condition":{"kind":"screen-stable","stableMs":1000},"timeoutMs":10000}
```

等待期限同时传递给在途 ADB 操作，超时会中止等待命令。失败后 Flow 的重新观察及报告清理使用独立时间，因此整个失败报告的总耗时可以超过 `timeoutMs`。UI 抓取失败会返回错误，不会当成元素已经消失。取消会打断等待并走统一清理流程。

验证命令：

```text
npm run build
npm test
node scripts/verify-markor.mjs emulator-5554
node scripts/verify-ui-wait.mjs emulator-5554
```

2026-09-16：`ui-wait-1789531085645/verification.json` 已通过动态文本出现/消失、UI 树变化、候选回查、超时和失败证据检查；250ms 等待实测 255ms。CLI/MCP 结构化探索结果见 `ui-surfaces-1789531150888079000/verification.json`。Markor 实际输入/保存/预览回归报告：`2026-09-16T03-52-19-482Z-emulator-5554-913a9f76/report.md`。
