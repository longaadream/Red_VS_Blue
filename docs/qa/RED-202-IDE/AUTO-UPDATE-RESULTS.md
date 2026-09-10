# 官方自动更新候选验证

日期：2026-09-10。代码候选：`codex/RED-202-inline-code-ide`。尚未发布客户端或替用户安装。

## 已实现

### 2026-09-10 人工验收反馈修复

- 更新入口不再复用全宽 `btn-ghost`：改为账号右侧 36×36 按钮、18px 下载图标；状态仅更新提示文字与圆点。原生 dialog 显式居中，按钮横排，使用菜单的纸张配色。
- 修复更新受到游戏全局 `no-proxy-server` 影响的问题：资源与二进制更新复用独立 `electron-updater` session，在首次请求前显式设置系统模式。可通过启动环境 `RVB_UPDATE_PROXY` 显式指定代理，不修改游戏 session、不硬编码发行代理地址。DNS/代理失败给出可读提示。
- 36 项网络/更新/菜单回归测试、客户端 TypeScript、定向 ESLint 和 main-baseline 通过。真实主题 Electron smoke 验证入口 36×36、弹窗居中、操作按钮同行。
- 真实 Electron 验证：默认 system 模式在本机系统代理关闭时解析为 DIRECT；显式使用已授权的 7890 时更新为 `PROXY 127.0.0.1:7890`，游戏仍为 DIRECT，真实 Release `0.0.1789039264048` 下载与哈希校验成功。未修改 Windows 系统代理，尚未验证系统代理开启时的自动继承；这不构成国内直连成功的证明。
- 独立审查未发现明确代码阻断，提示上述系统代理开启场景仍需补验。本机独立验收启动器显式使用 7890；真实资源应用继续等待用户操作。
- 证据：`auto-update-smoke/result.json`（系统模式）、`auto-update-smoke/result-network.json`（真实代理下载）、`auto-update-smoke/official-updates.png`（主题界面、模拟版本状态）。

- 主菜单「官方更新」分别显示测试资源与稳定客户端；可手动检查、关闭后续自动检查、请求重启安装。
- 固定公共 GitHub 仓库。资源标签/清单与客户端 stable/latest.yml 独立；请求不含账号令牌，限制 CDN 重定向、时间、大小并核对 GitHub digest 与清单 SHA-256。
- 匹配父 Profile 下载补丁，否则完整包；补丁下载失败回退同版本完整包。安装复用实际签名/发行者白名单与 ABI 验证，激活复用候选校验、renderer 握手和失败回滚。
- 从真实 Profile 补丁链取当前版本，进程重启也不会重复安装；手动候选不覆盖。
- 只在同一窗口仍处主菜单、没有在途导航、Next/PVE 无占用、Colyseus 无房间时应用。Colyseus 创建/恢复前同步登记，成功持久化释放时取消登记；父进程 IPC 在更新期间关闭新房间准入，替代进程继承暂停直至 renderer 确认。
- electron-updater 6.8.9 独立依赖、可复现 lockfile、打包为 CommonJS runtime。Windows NSIS 配置、官方 publish 源及安装包检查已加入构建脚本；构建默认禁止自动发布。普通退出不安装，用户确认重启才执行安装流程。

## 已执行

- `tests/electron/official-updates.test.ts`：21 项通过，包含混合版本、补丁/完整包、失败保持、主菜单等待、候选保留、并发单次执行、禁降级、旧坏 Release 隔离、只读 IPC 握手及二进制更新确认。
- `tests/electron/official-update-fetch.test.ts`：6 项通过，包含 204/205/304 空响应、非法 header、取消后迟到数据、手动重定向；错误不会逃逸成主进程未捕获异常。
- `tests/colyseus/product-room.test.ts`：6 项通过，新增真实服务器拒绝更新期间创建房间、已恢复房间阻断更新；其余房间回归通过。
- `tests/build/electron-client-package.test.ts`：12 项通过，涵盖新增运行模块/配置所需文件。
- `tests/content-pipeline/script-pack-release.test.ts`：1 项实际完整链集成通过。签名完整包安装后，用发布器生成的真实补丁自动安装/激活，读取改后攻击力；新建 updater 再检查不会重装；旧版回滚和坏签名拒绝继续通过。
- `tests/electron/resource-release.test.ts`：3 项通过；新发布清单/结果声明 `automaticClientDiscovery: true`，已发布的旧清单继续兼容。编辑器 TypeScript 检查通过。以上共 49 项独立测试。
- 客户端 TypeScript 编译、定向 ESLint、Colyseus bundle 构建、`git diff --check`、main-baseline 均通过。
- 隐藏 Electron smoke：真实加载打包的 NsisUpdater 与 sandbox preload，执行界面检查/开关/重启请求和 `packList()` renderer 握手。仅请求 mock 安装，没有执行安装程序。
- 最终 Electron 网络适配器经本机 7890 代理，只读下载官方真实 Release 的完整包并通过 SHA-256 校验，识别版本 `0.0.1789039264048`，停在「已下载，等待应用」，没有安装到玩家目录。该记录不是国内直连速度测量。
- 独立 AI 审查发现并修复：补丁基底版本误判、更新锁阻断自身握手、Colyseus 房间漏算、旧坏版本阻断、安装失败后的服务恢复、下载异步错误、导航竞争。最终复核无新阻断。

证据：[界面截图](auto-update-smoke/official-updates.png)、[隔离界面结果](auto-update-smoke/result.json)、[真实联网结果](auto-update-smoke/result-network.json)。截图中的 0.2.0 为 UI 模拟状态，不代表已发布客户端。

## 仍待人工发行验收

2026-09-10 补充：已同步最新 main，新增回归后共 68 项测试通过，实际 Next standalone 和独立开发客户端已构建并启动，资源更新等待用户手动操作。详见 [main 同步与人工验收准备](MAIN-SYNC-ACCEPTANCE.md)。下述内存不足及未构建 Next 为此前记录；NSIS 二进制升级仍未验收。

检测到本机仅约 1.1 GB 可用物理内存；为避免此前卡死重现，未执行完整 Next/NSIS 安装包构建，也没有安装/重启玩家客户端。因此不能把上述候选验证称为真实客户端二进制差量升级已验收。

1. 内存充足时在当前 worktree 执行 `npm run build:electron:client`；构建本身不发布。核对安装程序、对应 `.blockmap`、`latest.yml` 及包内容校验。
2. 由用户安装第一版新客户端，进入主菜单「官方更新」，确认发现已发资源、等待期间不更改当前对局；回到主菜单且关闭所有本机房间后应用，训练营人工检查数值。
3. 发布提高版本号的客户端稳定 Release，上传安装程序、blockmap、latest.yml；旧版点击检查，确认下载完成再重启。记录实际下载量，验证差量或有理由的完整回退。
4. 回滚资源后如需维持旧版，先关闭自动检查，否则下一次检查会再次提供较新官方资源。失败候选通过既有资源管理处理。

回退：关闭自动检查；资源管理切回 previousStable。没有改玩法引擎、密钥、玩家存档语义或自动发布 Release。
