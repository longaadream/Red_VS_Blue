# RED-199：安卓玩家主机迁移方案

状态：用户已接受手机 SQLite 方向；运行时仍需验证，尚未通过 APK 验收。日期：2026-09-09。
用户强调当前以安卓布局为最高优先级，主机功能仍为最终交付要求。

## 已确认的产品要求

- 安卓本轮必须可以在手机上实际运行休闲对局权威，与电脑版互联。
- 保留直连与公网 relay；官方账号、匹配和 Elo 继续由官方服务器提供。
- 手机切到其他应用或锁屏时，短时继续对局，允许显示运行通知。
- 横屏优先，默认全图，支持双指缩放和平移，沿用正常渐进部署和现有美术。
- 不在本次加入新的 PVE 联机功能。

## 现状与需要批准的边界

旧 Android `MobileHttpServer` 加隐藏 WebView 运行的是旧 HTTP/action-log 协议。
它不能供当前 Colyseus SDK 加入。当前 `build:mobile-server` 还因 Node API shim 缺少
`randomUUID`、`randomInt`、`createHash`、`linkSync`、`renameSync` 而失败，不能以空实现绕过。

当前锁定的 `@colyseus/core@0.18.10` 要求 Node >=22。
[Node.js Mobile 正式发布页](https://github.com/nodejs-mobile/nodejs-mobile/releases)
核实到的版本是 18.20.4，Node 22/24 升级仍见未合并提案。后续候选改用下文锁定并验证的 Termux Android Node 24 运行时。
不降级全项目 Colyseus，不忽略引擎约束，不将第三方未验证二进制直接打入分发版。

[ADR-0025](ADR-0025-colyseus-postgresql-authority.md) 与
[ADR-0027](ADR-0027-colyseus-single-session-match-lifecycle.md) 要求 PostgreSQL 为唯一耐久数据库。
下面的**手机 SQLite 对局存储适配器**是对此的明确例外，用户于 2026-09-09 明确接受。
Windows 与官方服务器保持 PostgreSQL。

## 建议的最小迁移

1. **先验证运行时**：在独立 Android 测试宿主中验证 Node >=22 的可复现构建或可信来源、
   ABI、16KB 内存页兼容和许可证。用当前锁定 Colyseus 启动真实 HTTP/WS 房间，
   以两个现用 SDK 客户端验证加入、二进制消息、时钟、断线重连和关闭。
   未通过不进入主应用，不把手机主机标记为可用。
2. **复用权威逻辑**：复用当前 `createColyseusBattleServer`、`BattleRoom`、规则 runner、
   FIFO、命令/receipt、种子与 Profile 准入。复用 host tunnel 对接公网 relay。
   Java 只管理生命周期及平台能力，不再维护另一份房间或玩法状态。
3. **手机 SQLite 存储**：通过现有 `BattleServerRepository` 接口新增 Android 专用、带 schema 版本的
   SQLite 适配器，不把 PostgreSQL 打入 APK。以事务记录初始状态、Transition、receipt 与终局，
   保持写入失败可诊断、终局等待耐久完成的现有语义。明确限制容量和保留周期。
   对局计算保留在内存，数据库写入不得阻塞 UI 线程；通过满员对局与观战实测写入延迟和队列。
   系统强杀后不声称无缝续局；当前对局明确中断，保留已落盘记录用于诊断。
4. **后台服务**：用 Android 原生前台服务持有运行时和运行通知。开房期间按需持有唤醒锁，
   结束最后一个本机房间后释放；重新进入界面连接同一服务。停止、启动失败、系统销毁均清理资源。
   采用短时后台/锁屏验证窗口；系统强杀及网络切换另有明确断线提示，不许诺永久后台存活。
5. **本机桥与资源**：前端通过窄接口查询主机状态、启动/停止、发布/撤销 relay，
   游戏连接仍走现用 SDK。从当前 `data/pages` 和构建产物生成安卓页面及本机 Profile identity，
   清除旧脚本镜像作为源的做法。Android 同步不得写 Windows 分发目录。
6. **连接安全修复**：原生不再忽略 TLS 错误；本地资源拦截限制为本地源；
   停止旧日期字符串校验的任意 HTML/JS 资源包覆盖，后续使用正式 Profile 验证。
   保留明确的局域网 HTTP 连接场景。手机使用自身资源 identity 校验服务器，不能拿远端身份和自身比较。

## 实现范围

`android/**`、`android-client/**`、`mobile-server/**`；必要客户端页面/桥脚本；
`scripts/*android*`、构建入口及生成文件忽略规则；
`lib/server/colyseus/create-colyseus-server.ts` 的平台适配接口、独立 Android repository；
相关测试、锁定运行时的构建说明、文档。依赖或存储格式的最终版本应在首步验证后写明，
不触及官方积分规则、Windows 数据迁移、PVE 联机或生产账号。

## 候选验收与回退

- 真实 APK 构建、安装、启动；记录版本、ABI、模拟器/真机、WebView、屏幕尺寸和日志。
- 安卓主机加 Windows 客户端、Windows 主机加安卓客户端，各完成 1v1/2v2 渐进部署到终局；
  观战隐藏信息、重连和 relay 均由现用协议验证。
- 运行时前台/后台/锁屏短时行为、退出房间后资源释放、写入失败、损坏记录隔离和系统强杀路径。
- 安卓加入官方账号/排位完整流程；错误证书拒绝，正常 HTTPS/LAN HTTP 可达；旧 Profile 明确拒绝。
- 20×16/24×20 默认全图、缩放/平移、部署、手牌和弹窗实际触控；Windows 桌面回归。
- 独立审查通过后交付 APK 候选，用户验收后才合并或发布。

回退保留旧 APK 和用户数据，使用独立分支；新日志独立版本化目录，不转换或删除旧数据。
不在主机启动失败时自动切到旧协议或远端伪装手机权威。

## 2026-09-10 候选实现

- 运行时采用 Termux 官方包 Node 24.18.0-1，arm64-v8a / x86_64。
  `config/android-runtime.lock.json` 固定 HTTPS 源、包版本、归档及解压文件 SHA256。
  `scripts/prepare-android-runtime.py <aarch64|x86_64>` 只解压校验后的运行文件，不执行 deb 脚本。
  构建前须分别准备两个架构；下载器遵循环境 HTTPS_PROXY，不内置开发机代理。
- Node 可执行文件以 APK native library 安装到只读可执行目录，依赖库、CA 与授权说明随 APK 携带。
  ARM64 ELF PT_LOAD 均验证 16KB 对齐；x86_64 已在 API36.1 实际 APK 子进程运行。
  ARM64 真机执行与小米后台策略仍需实机验收，不能用模拟器通过替代。
- Android 构建仅将 `colyseus` 聚合入口映射到同一锁定版本 `@colyseus/core`，
  避免桌面 monitor 的 OS 探测拒绝 Android；未降级框架或另写游戏协议。
- 复用当前 authority、runner、Profile 准入和 relay；SQLite schema v1 使用独立 worker、WAL/FULL、
  事务、版本 CAS 和原始过渡 SHA256。会话最多32条对局记录，历史保留7天/100条，容量上限约256MiB。
  系统强杀后旧记录仅供诊断，不把旧对局重新发布成可恢复房间。
- Native 前台服务显示运行/停止通知，持有最长6小时唤醒锁；停止主机后释放。
  用户应在不再开房时主动停止服务；当前唤醒锁随主机服务，而非最后一个房间自动释放。
  停止、启动中取消、异常退出和系统销毁均先撤销旧实例权限，等待子进程退出及 Service 销毁后允许再启动。
- 每次启动重建专有 APK bundle 目录，避免升级删除 JSON 后旧文件污染 Profile。
  玩家数据、SQLite 和资源包目录保留。启用资源/安装 APK 与运行中主机互斥。
- 主菜单“我当主机”启动服务并显示局域网地址；好友手动输入地址，或经现有公网 relay 加入。
  未实现手机 UDP 自动广播；v18 使用原生网卡地址与 HTTP 健康扫描实现同子网发现，
  同时覆盖 Android 2567 / Windows 38621，全量扫描补充 Windows 动态端口。手动地址入口保留。
- 战场严格保留 Three.js 三维棋盘。创建 WebGL 失败仅以关闭抗锯齿重试，仍使用同一三维渲染器；
  两次失败显示可诊断错误与重试，不替换为二维棋盘。旧 WebView 缺少 ResizeObserver 使用窗口 resize。

构建：准备两个运行时后，在项目根运行 `./scripts/build-android-ui-acceptance.ps1`。
候选包名 `com.redvsblue.client.uiqa`，可覆盖同签名旧验收包；不是生产签名版本。

v18 LAN 传输仅对可信打包游戏页启用 mixed content；HTML CSP 限制远端代码和 frame，
原生导航只允许已知本地页面。证书校验保持开启，不通过关闭 webSecurity 支持 LAN。
Windows 和 Android 沿用各自默认监听端口，协议相同，客户端按房主完整 origin 连接。
回退为上一候选安装包会恢复旧 LAN 限制；本轮没有更改数据库或存档格式。
