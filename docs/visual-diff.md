# 截图视觉差异

AppVanta 可以比较两张同尺寸 PNG 截图，并生成可查看的差异图：

```powershell
appvanta visual-diff baseline.png current.png diff.png 16 0.001
```

MCP 工具为 `compare_screenshots`，参数是 `baselinePath`、`currentPath`、`diffPath`，以及可选的 `channelThreshold`（0–255）和 `maxMismatchRatio`（0–1）。

core API 与 MCP 另支持 `ignoreRegions`，最多 100 个 `{x,y,width,height}` 整数矩形，例如 `[{"x":0,"y":0,"width":1080,"height":80}]`。坐标按截图像素，右/下边界不包含；必须位于两张图内。重叠遮罩按像素去重，差异比例与平均通道差仅计算未屏蔽像素。结果保留遮罩及 ignoredPixels，差异图用半透明蓝色表示屏蔽区域。覆盖整张图会报错，不返回通过。

上述真实截图的无遮罩对照返回失败及非零退出码：40 个差异像素均落在顶部区域（x=230–233，y=8–17）。这验证了遮罩确实排除了已知变化；不代表所有动画、字体或设备环境都已验收。

CLI 和 screen-stable 现已接入同一套遮罩规则。CLI 用法为 `appvanta visual-diff baseline.png current.png diff.png 2 0 ignore-regions.json`，最后的 JSON 文件直接包含矩形数组。真实 API 37 的两张截图（`.appvanta/runs/2026-09-26T12-33-18-708Z-emulator-5554-7bf0b6a2/artifacts/screenshot-1790425998811.png` 与 `screenshot-1790426006884.png`）内容哈希不同，屏蔽顶部 320×80 区域后 CLI 比较通过，比较 179200 个像素、屏蔽 25600 个像素；差异图保存在 `.appvanta/runs/screen-stability-1790425995681/cli-diff.png`。

比较逐像素读取 RGBA。任一通道差值超过 `channelThreshold` 时，该像素计为差异；结果包含图片尺寸、比较像素数、差异像素数、差异比例、平均通道差值和最小差异边界框。差异 PNG 将变化像素标为红色，未变化部分以半透明灰度保留上下文。尺寸不同时直接失败，不生成伪造的缩放比较。

默认通道容差为 16，允许差异比例为 0，即严格门禁。CLI 在超过门禁时以非零状态退出。容差必须根据固定设备型号、系统、分辨率、字体、语言、主题和动画设置制定；当前算法没有自动对齐、抗锯齿感知、OCR 或感知哈希，不能把环境变化误判为业务回归。

核心自动测试覆盖单像素差异、边界框、容差通过、尺寸不匹配、非法阈值和 diff PNG 输出，新增遮罩重叠、范围校验、整图屏蔽拒绝及遮罩外差异比例。真实 Android 截图基线及 CI 失败证据仍待在线设备验收。
