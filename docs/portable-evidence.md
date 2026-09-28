# 可移植证据导出

构建项目后执行：

```sh
node packages/cli/dist/index.js export .appvanta/runs/<run-id> <new-export-directory>
node packages/cli/dist/index.js verify-export <new-export-directory>
```

目标目录必须不存在，且位于来源目录之外。CLI 与 CI 使用同一个归档实现。

复制整个导出目录后，直接用浏览器打开 `index.html`，无需服务、网络或 JavaScript。JSON/JSONL 查看页位于 `.appvanta-view/`，通过相对链接连接归档内的截图、UI 树、日志及其他证据。旧绝对路径仅在归档内能唯一匹配时转为链接；歧义、外部或被排除的引用保留为文本。损坏的 JSON/JSONL 行以转义文本显示。

原始文件字节保持不变，因此已有运行哈希仍可检查。查看页是独立展示层，不会重写原始 Markdown、JSON 或 JSONL 中的绝对路径。Markdown、XML、日志和视频等由浏览器打开原文件，具体显示或下载行为取决于浏览器支持。

`manifest.json` 包含原始证据和生成页面的大小与 SHA-256。`verify-export` 检查路径、重复条目、文件类型、符号链接、缺失文件、哈希及未登记文件；失败返回非零退出码。该清单提供内容一致性检查，不是来源签名，不能证明清单与文件没有被一起修改。

归档继续排除工具/证书目录、链接和检测到的 PEM 私钥；不是通用敏感数据脱敏器。二进制文件夹具备份 `.bin` 不包含在导出内，导出包不能替代设备状态恢复备份。

## 验证范围

- 自动测试：原始来源删除后读取迁移包，Windows 历史绝对路径解析，JSONL 多行及损坏行，脚本内容转义，页面篡改拒绝，CLI/CI 一致性与再次导出。
- 真实运行导出：`portable-check-1789538723967/verification.json`，迁移目录后完整性通过，54 个相对链接均可访问。
- Windows Edge 离线首页截图：`portable-check-1789538405913/viewer.png`，已检查显示。
- 尚未完成另一台电脑及 Linux/macOS 浏览器验收；上述目录迁移不能替代跨电脑实测。
