# AppVanta

让 AI 驱动每一次移动 App 开发、调试与验证。

AppVanta 是一个面向 AI Agent 的移动应用开发、调试和验证工具包，连接真实设备、模拟器和桌面/Web 运行环境，执行跨应用和端到端工作流，并结合 UI/组件树、截图、日志、网络请求、性能追踪与运行记录完成问题定位和结果验证。

## Status

Android 本地基础操作、CLI Flow、MCP 工具及请求级 HTTP/HTTPS 采集已有实现；阶段 4/5 正在开发，尚未完成整体验收。参见 [剩余任务与验收清单](docs/phase-4-5-checklist.md) 和 [开发路线](docs/roadmap.md)。

实验性 [Python SDK](python/README.md) 可通过本地 MCP 服务调用工具、读取设备观察和管理 Flow 任务；复用服务端租约与审计，不内置模型 API。它尚未作为稳定版或 PyPI 包发布。

本项目采用 Apache-2.0 许可证并坚持独立实现。参考产品固定版本、逐项差距及专有二进制排除规则见 [参考基线](docs/reference-baselines.md)、[竞品覆盖清单](docs/competitor-coverage.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。

```bash
npm ci
npm run build
npm test
```
