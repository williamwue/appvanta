# PNG 模板视觉定位

当 Canvas、游戏画面或 WebView 内容没有可用的 UI/Accessibility 节点时，可以使用精确 PNG 模板 Target：

```json
{
  "kind": "tap",
  "target": {
    "kind": "image-template",
    "path": "fixtures/save-icon.png",
    "occurrence": 0,
    "maxChannelDelta": 8,
    "scalePercents": [100, 125]
  }
}
```

Driver 先采集当前截图，再在解码后的 RGBA 像素中查找模板，并使用匹配矩形中心作为坐标。`maxChannelDelta` 是每个 RGBA 通道允许的最大整数差值，范围 0–255；`scalePercents` 可提供 1–5 个 50–200 的整数比例，使用确定性的双线性缩放。两项省略时保持 100% 尺寸的精确匹配。省略 `occurrence` 时必须唯一匹配；多处相同图标会明确失败。`target-visible`、`target-absent` 和 `assertTarget` 也支持同一 Target。

原始模板最大 512×512，缩放结果最大 1024×1024，文件必须是 PNG。执行动作时，模板内容按 SHA-256 复制到运行 artifacts，使报告不只依赖工作区外部文件。坐标仍是匹配结果，应用响应必须由检查点验证。较大的容差或多个尺寸会增加误匹配与计算成本，应使用最小必要范围。

当前可处理显式 DPI 比例和有限颜色/压缩偏差，但不处理自动尺度推断、颜色主题、透明通配区域、旋转或感知相似度；也没有 OCR/VLM 文本识别。优先使用 resource ID、Accessibility 和 UI 树；模板定位用于这些语义表面不可用的情况。

## 设备验收

`node scripts/verify-visual-locator.mjs emulator-5554` 已在 API 37 完成：从 Settings 网络入口截图提取模板，target-visible 等待、模板中心点击、目标页 Internet 文本检查、返回后 assertTarget 全部通过。运行副本按 SHA-256 校验与源模板一致；缺失模板返回 not found，保存失败截图并阻止后续动作。证据 `.appvanta/runs/visual-locator-1790426158643/verification.json`，含模板来源 UI 节点与截图、成功及失败运行路径。

此验收利用 UI 树生成可核对的模板，但执行点击通过像素定位。它证明同 DPI/主题下的完整执行路径，不代表 Canvas、跨 DPI、多尺度、多候选或主题切换已经完成设备验收；OCR/VLM 仍待实现。
