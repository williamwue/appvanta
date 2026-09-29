# 截图平移对齐

## Android 实际截图验收

`node scripts/verify-device-visual.mjs <device>` 在设备租约内打开系统设置首页，间隔采集两次，再打开显示设置采集第三张原始 PNG。它不修改设置值，但会把显示设置留在前台。顶部和底部各 5% 为显式遮罩，截图、UI 树、SHA-256、设备 API/型号/密度及测量结果保存在运行目录。

该夹具预先指定 `minSsim: 0.99`，用 `maxMismatchRatio: 1` 单独检查 SSIM 门禁；这不是生产像素容差建议。API 37 本地证据 `.appvanta/runs/device-visual-1790706060569/verification.json` 中，同页重复截图得分约 1，通过；首页与显示设置得分约 0.679765，被拒绝。托管 API 35 已加入此命令，结果应以对应提交的 CI 为准。此验收不覆盖细微缺陷、人类感知校准、缩放旋转、多 DPI/主题或多设备基线。

`comparePngScreenshots` 和 MCP `compare_screenshots` 接受 `maxAlignmentShift`，整数范围 0–16 像素，默认 0 表示不对齐。显式启用后，在指定范围内搜索二维平移；同分时优先位移较小的候选。图像尺寸必须一致，且搜索范围不能覆盖整个图像内部。

CLI 示例（`-` 表示不提供遮罩文件）：

```powershell
appvanta visual-diff baseline.png current.png diff.png 16 0.02 - 3
```

搜索使用所有候选都有效的内部区域，最多采样 4096 个像素。最终结果仍对全部未遮罩基线像素进行比较。遮罩坐标以基线为准。

`alignment.dx/dy` 表示基线坐标加上偏移后对应当前图像的坐标。结果还包含 `maxShift`、`sampledPixels` 和 `unmatchedPixels`；差异图保持基线坐标系。移出当前图像的基线像素作为最大差异计入统计，并显示为红色，不会静默裁掉。因此即使内部完全匹配，严格零容差仍会拒绝存在边缘损失的平移。

这是一种有界、显式启用的平移估计；重复纹理或采样未覆盖的细节可能影响偏移选择，最终全像素检查仍决定通过与否。它不进行缩放、旋转、透视纠正或感知差异分析，也不自动放宽误差比例。

## 可选 SSIM 门禁

SDK/MCP 可设置 `minSsim`（0–1），CLI 在 `max-alignment-shift` 后追加该值：

```powershell
appvanta visual-diff baseline.png current.png diff.png 16 0.02 - 3 0.99
```

实现独立采用 [Wang 等人的 SSIM 论文](https://www.cns.nyu.edu/pub/eero/wang03-reprint.pdf) 中的局部均值、方差与协方差公式：11×11 归一化高斯窗口、σ=1.5、K1=0.01、K2=0.03、动态范围 255。用可分离滤波和 11 行环形缓冲计算每个有效窗口，最后对窗口分数取平均；不降采样。RGB 以 0.299/0.587/0.114 转为亮度，透明像素先在白底上合成。分数范围为 -1 到 1，较大表示结构更相似；亮度指标不充分反映色相差异。

只计算完全落在图像内、对齐后有效且不包含遮罩像素的窗口。结果明确记录 `windows`、`excludedWindows`、`method`、`alphaBackground`、`score` 和 `minimum`。不足 11×11 或全部窗口被排除时拒绝计算。未进入 SSIM 窗口的边缘仍由像素门禁检查。

启用 SSIM 后，像素误差比例与 SSIM 阈值必须同时满足；SSIM 不覆盖像素比较失败，也不自动放宽容差。未提供 `minSsim` 时保持原行为。阈值需要按实际界面建立基线，不代表人的主观质量保证。

本地回归覆盖常量图解析分数、相同图、反相结构、遮罩窗口计数、小图和无效阈值；真实 CLI/MCP 联合平移及 SSIM 验证证据为 `.appvanta/runs/visual-alignment-1790705181329/verification.json`。完整测试 213 项通过，尚需对应提交的跨平台验收和真实多设备截图基线。

回归测试覆盖偏移恢复、边缘计数、额外内容变化、零容差失败、无位移及无效参数。`node scripts/verify-visual-alignment.mjs` 使用可复核的合成 PNG，通过真实 CLI 和 MCP 验证相同输出；本地证据为 `.appvanta/runs/visual-alignment-1790704833457/verification.json`。这不等同于真实设备、多 DPI/主题或多设备视觉基线验收。三系统 CI 已接入该客户端验证命令。
