# 安装、升级与卸载

`npm run verify:release-packages` 在独立临时目录中安装四个 tarball、重复安装同一版本、运行 CLI help/doctor 和 MCP initialize/tools/list，再卸载四包。验证器检查卸载后的依赖目录与 package.json，并逐字节检查项目记录在安装、重装和卸载后保持不变。此项证明同版本重装与数据保留，不证明跨版本升级或记录模式迁移；后两项仍需使用明确的旧版本发行物与相应历史记录验收。

AppVanta 当前处于 0.x 开发阶段，workspace 包仍保持 `private: true`。正式 npm 发布前，使用源码 checkout 和锁文件安装：

```text
git checkout <exact-tag-or-commit>
npm ci
npm run build
node packages/cli/dist/index.js doctor
```

升级前保存 `.appvanta/runs/`、`.appvanta/tasks/`、`.appvanta/monitors/` 和项目级 MCP 配置。切换到明确版本后重新执行 `npm ci` 与构建，再运行 doctor 和一条非破坏性 smoke Flow。0.x 期间没有自动状态迁移；遇到未知 record version 时保留原目录并使用原版本读取，不能直接改写 JSON 版本号。

卸载源码版本时先取消或释放活跃 task/monitor，确认设备代理、输入法和夹具已恢复，再删除 checkout。设备上的 `dev.appvanta.input` helper 可用 `adb uninstall dev.appvanta.input` 删除；卸载会同时移除输入法、剪贴板桥、多点手势服务和故障测试 Activity。`.appvanta` 可能包含截图、日志、网络元数据和测试文件内容，需要按项目数据保留策略单独归档或删除。

`npm run release:prepare -- <new-output-directory>` 只在 tracked worktree 干净时运行构建、测试、发布包安装验证并生成四个 tarball、SHA-256 和 `release-manifest.json`。该命令不会发布 npm 包、创建 Git tag 或推送远程。
