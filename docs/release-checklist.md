# 开源发布检查清单

当前所有 workspace 包保持 `private: true`，避免在安装、命令入口和升级策略完成前误发布到 npm。源码仓库开源与 npm 发布是两个独立门禁。

## 当前升级候选

四包当前版本为 `0.2.0-alpha.1`；MCP initialize 从安装包的 package.json 读取实际版本，发行目录也从包版本生成。
`npm run verify:upgrade` 固定以公开初始提交 `93749a0cb87937149376aaac16adf8d199660acb` 的真实 `0.1.0` 源码构建旧 tarball，再在同一临时项目安装当前四包 tarball。
旧包实际创建两份 v1 任务记录：一份已完成、一份待办且所属进程已退出。升级后读取已完成任务，确认待办被标为 interrupted 而未重新执行；逐字节核对旧记录及未知格式文件，随后验证 CLI、doctor、MCP 实际版本与工具列表，最后卸载并再次核对数据保留。
旧任务没有 revision 字段；当前读取兼容该格式，不自动重写终结任务。该验收不证明全部数据模式迁移、运行中 Worker 升级或降级兼容。
本地 Windows 首次验收通过，证据 `.appvanta/upgrade-1790703392581.json`；后续结果位于 `.appvanta/runs/upgrade-*/verification.json`，记录源提交、源码是否有未提交修改和八个 tarball 摘要。
三系统托管 CI 已接入同一命令，验收结果应绑定实际运行。正式 tag、完整发布报告、其他迁移场景及真机/OEM 门禁仍待完成。

升级验收随后扩展到旧包实际生成的批次与监控记录：各一份终结记录和一份所有者已退出的待办记录。新包 SDK 读取终结记录保持内容一致，待办均标为 interrupted；通过已安装 MCP 的 `get_batch` 和 `get_monitor` 再核验待办状态。六份记录及未知格式文件在升级、查询、卸载之后均逐字节保留。Windows 本地证据为 `.appvanta/runs/upgrade-1790703644487/verification.json`；后续结果还包含合成旧记录、读取结果与记录摘要，便于复核。

公开提交 `b670274895758961f9cc6f6f1b31a671c796fe8f` 的 [托管运行 36606780001](https://github.com/williamwue/appvanta/actions/runs/36606780001) 四个任务全部通过。Windows/Linux/macOS 的升级报告均为 passed、sourceDirty false，覆盖六份旧记录和一份未知格式文件；三份下载证据归档均通过文件大小和摘要校验。该结果证明上述版本对及记录类型，尚不覆盖运行中 Worker 升级、降级或其他数据模式迁移。

## 源码仓库门禁

- [x] 选择 Apache-2.0 并加入完整许可证文本。
- [x] 加入贡献、安全和第三方边界文档。
- [x] 固定 ARTEMIS/Argent 审计基线。
- [x] 建立公开 GitHub 仓库 <https://github.com/williamwue/appvanta>，并启用[私密漏洞报告入口](https://github.com/williamwue/appvanta/security/advisories/new)；2026-09-28 已只读核验仓库公开且入口启用。`CODE_OF_CONDUCT.md` 已存在；项目专属的私密行为举报渠道暂不设置（未提供联系邮箱），GitHub [滥用举报表单](https://support.github.com/contact/report-abuse)已在仓库文档中说明，安全问题继续使用私密漏洞报告入口。
- [x] 发布实验性源码快照并完善公开项目主页；`main` 的无父初始提交 [`93749a0`](https://github.com/williamwue/appvanta/commit/93749a0cb87937149376aaac16adf8d199660acb) 树 `03a5fb1` 与本地集成修订 `fda6c8b` 的树完全一致，描述和 topics 已设置。本地历史提交及忽略的设备证据未随快照公开。
- [x] 在公开托管 CI 上通过 Linux 构建和测试；初始提交的 [GitHub Actions 运行](https://github.com/williamwue/appvanta/actions/runs/36435782854) 已以失败结束，Ubuntu 的 release-package `doctor` 因 ADB 不可用而报 `spawn adb ENOENT`，修复仅在本地准备，托管重跑待验。 Hosted run 36585720791 passed Linux.
- [x] 在 Windows 托管 CI 上通过构建和测试；上述运行因路径别名运行时/测试问题失败，修复仅在本地准备，托管重跑待验。 Hosted run 36585720791 passed Windows.
- [x] 在 macOS 托管 CI 上通过干净构建；上述运行因路径别名运行时/测试问题失败，修复仅在本地准备，托管重跑待验。 Hosted run 36585720791 passed macOS.
- [x] 执行 Android Emulator 托管验收并上传失败证据；上述运行因缺少 `sdkmanager` 失败，修复仅在本地准备，托管重跑待验。 Hosted run 36585720791 passed Android Emulator smoke with evidence upload.
- [x] 扫描提交历史中的密钥、CA、设备数据与第三方二进制。
  - `npm run check:history-policy` 枚举全部 refs 可达对象，拒绝历史 `.env`、密钥库、证书、APK/原生二进制、参考产品专有目录及高置信密钥标记；`release:prepare` 强制先运行该门禁。它不替代托管平台的持续 secret scanning。

## CLI/MCP 发布门禁

- [x] 确定发布包边界：core、android、CLI 和 MCP 四包；当前仍保持 `private: true`。
- [x] 定义 `bin`、`exports`、`files`、Node/Python/ADB 版本和系统依赖。
  - 已定义 Node 20+、ADB 1.0.41+、Python 3.10+、JDK 17+、Android SDK/Build Tools 35、core/android exports、四包 files 及 `appvanta` / `appvanta-mcp` bin；Android 构建会复制自研 Python 运行时资源，见 [系统要求](system-requirements.md)。
- [ ] 从空目录安装发布 tarball，并运行 `doctor`、CLI help 和 MCP initialize/tools/list。
  - 已加入 `npm run verify:release-packages`：构建四包、检查许可证与 Android Python 资源、在全新临时目录安装、运行 CLI help/doctor 及 MCP initialize/tools/list。需在 Windows/Linux/macOS 托管 CI 都产生通过证据后勾选。
  - 本地 `8825da3` 修订执行该命令退出 0，覆盖 core/android/CLI/MCP 四包，`doctor` 为 ready，MCP 列出 49 个工具；这不替代三平台托管 CI。
- [x] 验证 Windows、Linux 和 macOS 的路径与子进程行为。 Hosted run 36585720791 passed the cross-platform package/path/subprocess checks.
- [x] 提供升级、配置迁移和卸载说明。
- [x] 四个 tarball 均包含 Apache-2.0 LICENSE 和锁定依赖/参考边界 NOTICE；Python 可选环境的传递许可证仍需由自包含发行物单独收集。
- [ ] 使用语义化版本、变更日志和可复核构建记录。
  - 已加入 0.1.0 changelog 和 `release:prepare`，可生成 commit、工具版本、tarball SHA-256/integrity 清单。Windows 干净 tracked worktree 候选已生成：`.appvanta/releases/0.1.0-local-20260923015559/release-manifest.json`，绑定 commit `999dcba18b5c10c8e95c6e9c8714b3fbfa98aac1`；Linux/macOS 复验与正式 tag 尚未完成。

## 功能声明门禁

- [ ] [逐项覆盖清单](competitor-coverage.md) 中所有当前阶段项目达到 `verified`。
  - 版本 2 租约日志已在 `8825da3` 集成，该修订的构建和 `npm test` 通过；严格裁决快照修复 `908a74e` 经独立复核并于 `0b4cff7` 集成，全部包构建及完整 core 74 项测试通过。它接受有效版本 1/2 租约及精确可选字段，仍返回 `resumeAuthorized: false`；可运行的受保护检查点和后继任务续跑尚无验收证据。
- [ ] Android 真机与至少一个 OEM 环境通过验收；现有 API 35/37 长时分段及其他在线证据均来自模拟器。
- [ ] Codex、Claude Code 和 Cursor 内完成 MCP 安装与真实调用。
- [ ] 明确列出最后阶段的平台差距；在实现前不得宣称覆盖 Argent 的全部平台。
- [ ] 发布报告链接到命令、运行目录、设备信息和未覆盖边界。
