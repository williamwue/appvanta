# Android 请求级采集

独立实现的 mitmproxy addon 通过公开的 response/error hooks 保存请求证据。
参考协议文档：https://docs.mitmproxy.org/stable/addons/examples/

## 安装和运行（Windows / Python 3.11）

```powershell
python -m venv .appvanta/proxy-venv
.appvanta/proxy-venv/Scripts/python.exe -m pip install -r scripts/network-requirements.txt
python scripts/capture-network.py --mitmdump .appvanta/proxy-venv/Scripts/mitmdump.exe --device emulator-5554 --output .appvanta/runs/network-example --seconds 30
```

脚本启动本地代理后配置模拟器全局代理，结束（包括异常）时恢复原值。
输出目录必须不存在，防止混合多次运行证据。默认设备访问宿主地址是
`10.0.2.2`；其他设备可用 `--device-host` 显式指定合适的地址与转发。

产物：`requests.jsonl`、`summary.json`、`proxy.log`。
请求证据包括方法、去掉查询参数的 URL、状态码、时长、响应字节数及错误；
不保存请求头、Cookie 或正文。代理诊断日志可能包含原始连接信息。
CA 私钥保存在独立的 `.appvanta/network-ca`，不要导出该目录。

## 验证

```powershell
python scripts/verify-network.py emulator-5554
```

验证器启动本地 HTTP 服务，通过 Android 浏览器、代理和显式本地 URL 映射
访问该服务，断言请求证据中的 HTTP 200，并检查原代理配置得到恢复。
浏览器应已完成首次启动引导。退出码非零代表验收失败。

## 当前边界

- 已实测模拟器 HTTP 请求与成功响应、连接失败记录、代理恢复。
- HTTPS 已在 API 37 模拟器 Chrome 上通过双向链路 TLS 实测；应用仍需自行信任用户 CA。
- 不支持绕过证书固定，不保证忽略系统代理的应用流量可见。
- CLI Flow、MCP 同步/异步 Flow 共用请求级会话；支持正常结束、断言失败及协作取消后的代理恢复。
- 这是请求观察，不是流量统计 `network` 命令的替代实现。

## HTTPS 测试 CA 与验证

使用已有代理环境准备公钥证书（不会复制私钥）：

```powershell
.appvanta/proxy-venv/Scripts/python.exe scripts/prepare-network-ca.py --device emulator-5554
```

API 37 实测安装路径：Settings → Security & privacy → More security & privacy →
Encryption & credentials → Install a certificate → CA certificate → Install anyway →
Downloads → appvanta-test-ca.crt。安装后在 Trusted credentials 的 User 页检查
mitmproxy，并通过下面的请求验证信任链。复制证书本身不代表已安装。

```powershell
.appvanta/proxy-venv/Scripts/python.exe scripts/verify-network.py emulator-5554 --https
.appvanta/proxy-venv/Scripts/python.exe scripts/verify-network.py emulator-5554 --https --reject-upstream
```

第一条启动本地 HTTPS 服务：浏览器通过代理建立 TLS，上游也使用 TLS 并验证
测试服务证书。断言 `statusCode=200`、`clientTls=true`、`serverTls=true`。
第二条故意不向代理提供上游测试 CA，要求出现 certificate verify failed，不能出现
200。两条均检查原代理配置恢复，成功后写出 `verification.json`。
测试使用 URL 映射，日志中的 URL 是映射后的本地服务地址；未证明任意 App 支持代理。

实测证据（2026-09-16）：

- `.appvanta/runs/network-1789524700332953800/`：HTTPS 200、客户端/服务端 TLS。
- `.appvanta/runs/network-1789524752729993200/`：拒绝未信任上游证书、恢复代理。
- 测试 CA SHA-256：`25ddce5f03cff3899409a617d1b12d91309ae8c2d9fd46efad2c602787072452`。

测试 CA 保留在此模拟器的用户凭据中；不需要时在 Trusted credentials → User →
mitmproxy 中删除这张证书。不要使用 Clear credentials 清空其他证书。
代理配置已恢复为采集前的值，CA 私钥仍仅存放在本机 `.appvanta/network-ca`。

## Flow 自动管理采集

在 Flow JSON 中加入 `network` 即可启用；没有该配置时不启动代理：

```json
{
  "name": "HTTPS page check",
  "network": {
    "python": ".appvanta/proxy-venv/Scripts/python.exe",
    "mitmdump": ".appvanta/proxy-venv/Scripts/mitmdump.exe"
  },
  "steps": [
    {"description": "Open test page", "openUrl": "https://example.com", "assertText": "Example Domain"}
  ]
}
```

运行 `node packages/cli/dist/index.js run-flow emulator-5554 flow.json`。
上述地址为用法示例，自动验证使用本地测试服务，避免依赖公网。
可选配置 `port` 指定代理端口，`mapRemote` 提供测试 URL 映射，
`upstreamCa` 为私有 TLS 服务提供受信任 CA；不会关闭证书校验。

会话就绪后执行动作，步骤结束或断言失败都会结束会话并验证代理恢复。
请求、代理日志和 summary 位于同一运行目录的 `network/`；截图/UI 位于
`artifacts/`。`report.md` 链接网络产物，`run.json`、`report.json` 记录最终状态。
断言允许最多约 5 秒的 UI 重新观察，单次 ADB 命令仍受自身超时限制。
流程失败、代理启动失败、代理恢复失败均返回非零退出码。

```powershell
.appvanta/proxy-venv/Scripts/python.exe scripts/verify-network.py emulator-5554 --https --flow
.appvanta/proxy-venv/Scripts/python.exe scripts/verify-network.py emulator-5554 --https --flow --fail-flow
.appvanta/proxy-venv/Scripts/python.exe scripts/verify-network.py emulator-5554 --flow --fail-network
```

三个验收分别验证成功、故意错误的 UI 断言、端口占用时禁止执行动作。
验证脚本返回通过表示符合预期；故意失败场景中的 Flow 本身必须返回失败。
当前请在同一设备上串行使用代理会话。CLI/MCP 网络 worker 独立启动，通过私有 stdin 管道检测宿主退出，恢复原代理并终止代理进程；采集日志直接写入文件，宿主退出后仍可检查。
设置代理前写入版本 2 `network/recovery.json`，记录设备、原值、会话值、进程 ID、输出目录、代理程序绝对路径和端口；清理结果写入 `network/summary.json`。
`recover-flow` 先写入停止请求并等待独立 worker 自行清理；worker 未能产生已验证 summary 时，才读取绑定记录接管。接管仅在当前代理仍为本会话值或原值时继续，并在终止本机进程前核对 PID 命令行包含预期脚本/代理路径、输出目录和端口。外部代理值、无法验证的 PID 或读取失败都会保留设备锁。自动测试已覆盖正常 summary 的幂等处理；整个进程树终止后的真实模拟器接管仍待验收。
设备锁不因宿主死亡自动解除，其他夹具及设备状态仍需检查。会话硬上限为一小时。

恢复代理时，worker 最多用 60 秒重试 ADB 连接/命令错误，每次结果写入 `network/restoration.jsonl`。当前值已是原值时直接完成；仍是本会话值时才写回原值；其他值视为冲突，停止恢复并返回失败，避免覆盖外部修改。恢复失败的 summary 包含 `restoreError`，后续仍需人工检查或持久恢复机制。

退出总结同时包含 `proxyStopped`、`forcedTermination` 和 `cleanupErrors`。代理停止超时后尝试强制结束；强制结束即使成功也标记本次采集失败，因为日志可能不完整。请求日志按行检查，损坏记录的行号写入总结，原始字节不修改；不能因最后一行写入中断而丢失代理恢复结果。磁盘不可写时无法保证总结落盘。

`python scripts/test_network_finalization.py` 覆盖日志损坏、缺失、停止超时、停止异常及正常退出。真实采集会话注入损坏 JSONL 后，CLI 调用返回错误、summary 为 failed、代理已恢复且进程已退出：`network-owner-exit-1789539495272/verification.json`，同次回归也覆盖正常停止、宿主终止及外部代理冲突。

`python scripts/test_proxy_recovery.py` 覆盖模拟断线重连、期限耗尽、外部值冲突和已恢复状态。真实模拟器的强制退出、正常停止、外部修改拒绝覆盖三路径通过：`network-owner-exit-1789539353836/verification.json`。冲突测试最后独立恢复测试前的代理。真实设备断线重连尚未验收，模拟测试不能替代它。

## 实际模拟器断线验收

```powershell
node scripts/verify-network-reconnect.mjs emulator-5554
```

该命令会重启指定模拟器，仅接受 `emulator-<port>` 序列号。先保存原代理，启动采集并确认代理生效，再重启模拟器并触发清理；要求至少一次真实 ADB 错误、重连后原值校验及代理进程退出，保存逐次尝试和最终结果。

2026-09-16 API 37 模拟器通过：`network-reconnect-1789539588722/verification.json`。前 12 次 ADB/系统服务不可用，第 13 次恢复成功；原代理为 `:0`，端口已释放。该项覆盖采集 worker 仍在运行、模拟器在 60 秒恢复窗口内重连的情况，不证明物理设备拔插、超过期限离线、主机重启或整个进程树被终止后的持久恢复。

```powershell
node scripts/verify-network-owner-exit.mjs emulator-5554
node scripts/verify-protocol-cancel.mjs emulator-5554
```

2026-09-16 Windows/API 37 模拟器验证：`network-owner-exit-1789539169298` 中强制终止宿主后状态为 `interrupted`，代理原值恢复，代理进程退出；随后复用同一端口启动并正常停止成功。MCP 协作取消回归 `protocol-cancel-1789539191662` 通过。该证据不代表设备断线、整个进程树终止或主机重启恢复完成；新增接管实现也不能替代这些待执行的真实验收。

MCP 同步 Flow 使用同一验收器，加 `--mcp`：

```powershell
.appvanta/proxy-venv/Scripts/python.exe scripts/verify-network.py emulator-5554 --https --flow --mcp
.appvanta/proxy-venv/Scripts/python.exe scripts/verify-network.py emulator-5554 --https --flow --mcp --fail-flow
.appvanta/proxy-venv/Scripts/python.exe scripts/verify-network.py emulator-5554 --flow --mcp --fail-network
```

2026-09-16 三项均通过，运行目录分别为 `2026-09-16T03-17-33-021Z-emulator-5554-6d93fb19`、`2026-09-16T03-18-12-772Z-emulator-5554-9c958e26`、`2026-09-16T03-18-32-203Z-emulator-5554-e2b01584`。均保存代理恢复结果。客户端收到 Flow `status=failed` 表示业务失败，MCP 服务进程本身正常退出不代表 Flow 成功。

2026-09-30 API 37 补充了恢复期间取消验收：设置 `APPVANTA_MITMDUMP` 为本机已有可执行文件后，运行
`node scripts/verify-network-capture-recovery.mjs emulator-5554 cancel-recovery`。
宿主与网络 Worker 强杀后，在接管清理开始 250 毫秒时触发取消；恢复仍完成录屏、Perfetto 和代理清理，之后返回取消错误。
验收确认后续操作没有启动、原租约 token 没有转移、代理与采集在返回前已恢复；随后用原 token 显式恢复并释放租约。
证据：`.appvanta/runs/network-capture-recovery-1790700941425/verification.json` 及同目录 `cancelled-recovery.json`。
这是 API 恢复路径上的真实模拟器验收，未模拟 USB 断线或主机重启。

代理重连期限现在在每条 ADB 命令之前检查。回归测试证明旧实现会在一次读取耗尽期限后继续写入并报告成功；修复后超时即拒绝发出后续写入。
另有重复断线测试覆盖首次读取失败、恢复写入后读回失败、重连发现原值已恢复的路径，确认只写入一次。
`python -m unittest test_proxy_recovery.py test_network_finalization.py` 共 8 项通过；这些时间与断线注入测试不替代真实设备拔插验收。

发行包恢复代码与真实设备设置的组合验收：`node scripts/verify-proxy-reconnect.mjs emulator-5554` 在 API 37 通过。
验收先保存真实代理值，临时写入本地测试代理，然后调用 `packages/android/dist/runtime/proxy_recovery.py`。
重复断线场景在首次读取及恢复写入后的读回处注入传输异常，第三次尝试确认原值已恢复，恢复写入总计一次。
期限场景持续注入不可用错误，1 秒期限后拒绝继续，真实设备仍保留测试代理且日志没有 restored；解除注入后重新恢复原值。
最终代理与原值相同，设备租约释放。证据：`.appvanta/runs/proxy-reconnect-1790701189151/verification.json`。
传输错误在 ADB 回调边界注入；成功命令实际访问模拟器，未断开真实 ADB 连接，不作为 USB 拔插或主机重启的验收。

同日增加 `node scripts/verify-proxy-reconnect.mjs emulator-5554 tcp` 并在 API 37 通过。
此模式使用独立随机端口的本机 TCP 转发器连接已有 ADB 服务端，按场景断开并恢复该转发链路；不停止共享 ADB 服务端，也不操作其他设备。
实际 `adb -H 127.0.0.1 -P <port>` 子进程返回退出码 1 和 `protocol fault ... connection reset`，未由 Python 回调直接伪造异常。
重复断连时第三次尝试成功且恢复写入仅一次；持续断连时 1 秒期限耗尽后停止，随后重新连通并恢复原代理。
证据：`.appvanta/runs/proxy-reconnect-1790701434793/verification.json`，包含实际命令参数、stderr、每次尝试及期限耗时。
这覆盖 ADB 客户端到服务端的 TCP 中断；设备端传输、USB 拔插、采集期间断线及主机重启仍需分别验收。

网络与采集组合的 TCP 中断验收（API 37）通过：
`node scripts/verify-network-capture-recovery.mjs emulator-5554 tcp-disconnect`，mitmdump 路径仍由 `APPVANTA_MITMDUMP` 指定。
录屏、Perfetto 与代理准备完成后强杀宿主及网络 Worker，再断开隔离 TCP 转发链路并调用真实恢复入口。
ADB 连接错误使恢复失败；验收通过独立正常连接确认原租约、会话代理、两份远端采集文件和 PID 控制文件均保留，记录没有标记 cleaned。
恢复同一 TCP 链路后，用原 token 再次清理成功，产物保存到本地并标注有效性未验证，远端文件移除、代理恢复、进程退出、租约释放。
证据：`.appvanta/runs/network-capture-recovery-1790701606247/verification.json` 及 `disconnected-recovery.json`。
此次断连发生在清理入口之前，不证明产物拉取中途断连、设备端传输或 USB 拔插；中断录像未作为完整有效录像验收。

随后增加两个实际拉取中断场景：`tcp-pull-disconnect` 和 `tcp-pull-trace-disconnect`。
隔离 TCP 转发器识别指定远端文件的 ADB sync 拉取请求，在 DATA 帧中只转发一个负载字节后结束连接，并拒绝后续连接。
API 37 上录屏场景通过：拉取错误写入 `recovery-pull`，远端采集文件和控制文件保留，原租约及会话代理不变；重连后同 token 恢复成功。
Perfetto 场景也通过：录屏已经恢复到本地并清理远端，trace 拉取失败时保留其远端文件和原租约；重连重试成功处理剩余采集与网络清理。
两种场景最终均确认本地非空产物、远端文件移除、代理还原、相关进程退出和租约释放，产物有效性仍标为未验证。
证据分别为 `.appvanta/runs/network-capture-recovery-1790702160056/verification.json` 和 `.appvanta/runs/network-capture-recovery-1790702245576/verification.json`。
最终脚本的录屏场景复跑也通过，证据为 `.appvanta/runs/network-capture-recovery-1790702298388/verification.json`；脚本测试 36 项通过。
首次尝试 `network-capture-recovery-1790701775686` 因验收脚本误读 `operation` 而非 `phase` 失败，记录保留；原 token 经正常恢复入口清理成功后才重跑。
这覆盖主机 ADB 客户端到服务端链路中断，不证明设备端传输、USB 拔插或主机重启。

托管补充：公开快照 `3957caf` 的 GitHub Actions 运行 `36604519328` 中，Linux / API 35 的 Android job 已通过上述录屏和 Perfetto 拉取中断恢复检查，并上传证据。
该运行的 Windows job 因独立监控 Worker 转移 `monitor.json` 时发生 EPERM 失败，因此整次 CI 不能计为通过；Linux/macOS 构建测试通过。

托管运行 `36606437185` 的录屏中断验收曾等待拉取 60 秒后失败，未观察到 DATA 截断；该失败保留。回归用例确认隔离转发器会扣留空文件的 DONE 响应，修正后透传非 DATA 响应，并保留分块 DATA 头识别。原运行实际收到的首个回复未被记录，不能断言其远端文件为空。
夹具现在先观察录屏远端文件至少有两个字节，再强杀宿主；写入 capture-ready.json 记录观测大小，避免将尚无数据的采集当作拉取中途断连。
最终脚本本地 API 37 录屏、Perfetto 场景分别通过：`network-capture-recovery-1790704032468`、`network-capture-recovery-1790704059009`，脚本测试 40 项通过。新的转发器与就绪检查仍需对应提交的托管复验。
