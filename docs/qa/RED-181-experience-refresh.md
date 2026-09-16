# RED-181 体验改进实施记录

base_branch: main
base_sha: 59aff06dcc5d296cd3a9f1f1ec8c53d773589d73

## 用户已确认的范围

目标：降低进入对局的步骤和学习门槛，并让游戏状态处理与动画播放解耦。
用户最新约定替代 onboarding-followup 文档中的强制更新要求：启动显示检查页面，但更新可跳过，检查中可切换源，主菜单提示可用更新；仅进入不兼容服务器时要求更新。

允许路径：data/pages、electron-client、与登录/更新/联机对应的 lib 和 android 模块、角色定位与预设构筑数据、tests、docs。风险：战斗交互 Medium，账号及更新 High。用户已批准方案；不更改战斗数值、随机规则、存档格式、签名和发布渠道，不自动发布。

## 验收标准

- 动画中可查看、悬停、拖动视角和发起下一次合法行动；输入使用已确认的最新状态，无“已排队”文案。服务端继续校验所有命令。
- pending 前的动画完成后才展示选择；等待期间不得提交其他改变局面的操作。右键或空格跳过动画，实际选择中的右键先处理取消。主动移动显示行动条幅。
- 合法目标棋子本身提高亮度，保留平行棋盘的候选标记。
- 教程位于主页；单人和 LAN 可离线；互联网按所选服务器登录，房间列表与 LAN 分开。冒险保留上下文并明确选择连接方式。
- 登录凭据按服务器隔离并恢复，临时断网不清除登录。排位名称不限定官方服务器。
- 更新检查可取消/换源，旧请求不得覆盖新结果，更新失败不妨碍兼容的离线内容。
- 根据当前技能补齐棋子定位和多套合法预设构筑，并提供开局、搭配和替换提示。

## 验证与回退

2026-09-16 主页账号补齐：删除旧助记词、导入和多本机账号管理界面，主页直接使用服务器登录接口及按服务器隔离的会话。注册/找回密码复用现有账号表单。离线/LAN 只展示游客昵称；内部旧标识保留用于存档及 LAN 协议兼容，本轮不移除底层签名或迁移存档。范围为 index.html、home-account.js、official.js 和测试；不发布。验收覆盖主页入口、登录持久化、服务器隔离、不安全地址拒绝及断网退出。撤销上述页面修改即可回退。

分批执行表现层/页面运行时回归、更新取消和登录隔离测试，再检查桌面与安卓横屏。候选构筑须经过现有规则合法性检查。最终需独立审查及客户端验证；已通过的旧版人工测试不算本轮验收。回退撤销对应功能改动，不覆盖玩家存档或资源历史。

## 当前进度

首批实现中：动画输入穿透、主动移动条幅、跳过快捷键、pending 延迟、候选棋子增亮。五份直接相关测试 107 项通过，ESLint 通过。独立审查发现并修复手牌/回执绕过延迟、增亮被刷新重置、右键取消、等待条幅隐藏的问题；过期回执以快照身份保护，断线/终局清除，相关 62 项再次通过。仍待真实窗口验证，不能视为整轮完成。

battle-ui-boundary 的一条旧源码断言要求 widthCoverageZoom，当前 HEAD 已不含该变量；本轮未修改缩放逻辑，也未改写该测试来掩盖失败。
更新检查已拆开“发现”和“下载/应用”：检查期间可立即切源，旧请求会被取消且不能覆盖新源结果；本机游戏服务就绪后可离线进入。相关单测、TypeScript、ESLint 与 Electron 更新冒烟测试通过。

主页第一轮信息架构已实现：LAN 与互联网入口分组，LAN 保留搜索和 IP 直连；冒险拆为单人、LAN 与服务器路径；本机离线身份改称“本机玩家资料”，与服务器账号分开。服务器令牌按规范化服务器地址持久化并隔离，兼容迁移旧的标签页会话；401 只清除对应服务器，普通网络失败不清登录。排位文案不再限定官方服务器。菜单和会话测试通过。

构筑页现显示简短战术定位，并为光暗双方各提供两套合法的八棋入门阵容。推荐项说明开局、角色搭配和替换方向，一键载入但不写入或覆盖玩家本机棋组。

PVE 网络操作延迟已定位到定时 AI 步骤和持久化共用串行队列：当一次数据库提交超过 250ms 时，旧实现会持续积压 tick，使后来的玩家操作排在历史 AI 工作之后。服务端现在合并重复 tick，队列中至多保留一个定时步骤；响应同时记录排队、服务端处理和客户端往返耗时，便于区分网络、规则和存储瓶颈。仍待服务器双端实测与安卓布局验证。

## 最终自动验收（2026-09-16）

- 表现层、更新、账号、教程、构筑、终局、PVE 调度与 Android 构建回归：最终 19 个测试文件、260 项通过。
- LAN／服务器／排位／PVE／Android SQLite 与 Windows 嵌入式 PostgreSQL 联机套件：首次并行运行受工作树 Junction 与数据库端口争用影响；在沙箱外串行复测对应 7 个文件、27 项全部通过，其余首轮 26 个文件、67 项通过。
- TypeScript 类型检查通过；本轮改动涉及的 TypeScript、JavaScript 与测试文件 ESLint 通过；`git diff --check` 通过。
- Windows 0.1.7 安装包已由最终源码重新构建，382 个页面资源、425 个离线数据资源、44 个图片资源及 PostgreSQL 16.15-2 打包校验通过。
- Android 旧记录中的 `assembleDebug` 只验证了旧 MainActivity 壳，不能作为现行客户端的构建或启动证据；已由下方的 UiAcceptance 构建记录替代。
- 完整资源包从 release-018 全量历史基底复制后覆盖当前资源生成，版本 1.0.4，authoring 渠道无签名验收包校验通过；内容管线标识为 `fd0061789ec10ab715b145cc94aa59345026908f294b9264bdf8fbeb115904de`，生成文件 SHA-256 为 `4d60e812b92593e73275e5ba752dc8c5e2ee17a27151af26e65eb296c760ea11`。正式发布前仍需使用官方密钥签名。

## 2026-09-16 安卓入口与 Windows 资源覆盖核对

- 黑白屏排查发现前次交付误用了旧 MainActivity 的 debug APK。默认 `build:android` / `build:android:apk` 现调用 UiAcceptance 构建脚本，包含当前页面、原生宿主和更新桥。验收 appId 为 com.redvsblue.client.uiqa，与正式包隔离。
- `npm.cmd run build:android` 成功；versionName 0.1.7-RED199-candidate，versionCode 26。保留更高版本号环境值，限制 Gradle 单 worker；APK 哈希输出采用 .NET，兼容当前 PowerShell。
- 交付 APK：dist/android-ui-acceptance/RedVsBlue-RED199-UI-Acceptance.apk；SHA256 577c4f4e35426f6a6ce9677aecc8c1cdf6ad049ef041de43690586111e3062f3。检查了 android-host.js、arm64-v8a/x86_64 原生宿主及夏特 5×5 数据。模拟器仅完成安装，用户要求关闭；未完成启动及真机体验验收，不宣称黑白屏已实机消失。
- Windows 当前运行 C:/Program Files/RED vs BLUE 的 0.1.7，内置夏特描述/效果已是 5×5；my-project/resource-pack/active.json 激活的仍是 1.0.2，profile ff99551a4fae97026d6d49931b243e2ffab33a4937a431cca671f6c001ef508d 中实际描述仍是 15×15。旧资源覆盖内置数据是本次直接原因。
- output/release-019-content/source/data 与当前同路径源码逐字节一致，保留之前整合历史。已用既有受信身份签名 content.rvbpack（1.0.4），CLI sign/validate (qa) PASS，packageHash 7aea6c72bbe0d2c60dc07bfb36d3c0aa708174177c5b8d5e82c5b8b5696d6a35。未修改私钥、信任配置、已安装不可变 Profile 或公开更新渠道。
- `npx.cmd vitest run tests/game/sonic-roster.test.ts --maxWorkers=1`：42/42 PASS；包内描述 5×5 且效果 Chebyshev 半径 2。仍需在客户端正常导入并激活此包，不能只重新安装 EXE。
- 补充：`local-dev` CLI 策略按设计拒绝可执行技能，即使已签名也不等于桌面安装策略。最终通过 `installProfileArchiveV1` + 与客户端相同的 external 受信发行者策略、`openInstalledProfileProvenanceV1` 在隔离目录安装成功；版本 1.0.4，profileHash 416921ebc3c515e5cffba21e807e30b755352d3aaab82c956abeedb19690593e，证据 output/release-019-content/import-check.json。未触碰正在运行的玩家实例。
