# 截图平移对齐

`comparePngScreenshots` 和 MCP `compare_screenshots` 接受 `maxAlignmentShift`，整数范围 0–16 像素，默认 0 表示不对齐。显式启用后，在指定范围内搜索二维平移；同分时优先位移较小的候选。图像尺寸必须一致，且搜索范围不能覆盖整个图像内部。

CLI 示例（`-` 表示不提供遮罩文件）：

```powershell
appvanta visual-diff baseline.png current.png diff.png 16 0.02 - 3
```

搜索使用所有候选都有效的内部区域，最多采样 4096 个像素。最终结果仍对全部未遮罩基线像素进行比较。遮罩坐标以基线为准。

`alignment.dx/dy` 表示基线坐标加上偏移后对应当前图像的坐标。结果还包含 `maxShift`、`sampledPixels` 和 `unmatchedPixels`；差异图保持基线坐标系。移出当前图像的基线像素作为最大差异计入统计，并显示为红色，不会静默裁掉。因此即使内部完全匹配，严格零容差仍会拒绝存在边缘损失的平移。

这是一种有界、显式启用的平移估计；重复纹理或采样未覆盖的细节可能影响偏移选择，最终全像素检查仍决定通过与否。它不进行缩放、旋转、透视纠正或感知差异分析，也不自动放宽误差比例。

回归测试覆盖偏移恢复、边缘计数、额外内容变化、零容差失败、无位移及无效参数。`node scripts/verify-visual-alignment.mjs` 使用可复核的合成 PNG，通过真实 CLI 和 MCP 验证相同输出；本地证据为 `.appvanta/runs/visual-alignment-1790704833457/verification.json`。这不等同于真实设备、多 DPI/主题或多设备视觉基线验收。三系统 CI 已接入该客户端验证命令。
