# ADR-0003：保留 Electron Server 内部候选打包入口，但不作为公开发行物

- 状态：已接受
- 日期：2026-08-14
- 人工批准：2026-08-14
- 关联任务：RED-23
- 后续实现合同：RED-44

## 背景

项目需要区分两个容易混淆的问题：

1. 是否保留一个可生成独立 Electron Server 目录产物的构建入口，用于验证打包后的
   服务端管理器、Next/WebSocket 子进程和桌面安全边界；
2. 是否把该产物作为面向玩家或专服管理员的独立安装包公开分发。

两者的目标用户、支持承诺和发布风险不同，不能仅根据仓库中是否存在
`electron-builder.server.json` 推断产品已经决定发行独立服务端。

### 删除历史

`ac9b3bf`（`last update before reconstruction`，2026-08-12）在一次涉及 234 个文件的
重构提交中同时完成了以下变化：

- 删除 `package.json#scripts.build:electron:server`；
- 删除 `electron-builder.server.json`；
- 删除 Server 专用的 staging/cleanup 构建链；
- 保留 `dev:electron:server`、`electron/` 主进程和服务端管理界面。

提交说明和相邻技术文档没有记录独立的产品、分发或安全理由。因此可审查结论只能是
“打包入口在重构提交中被移除”，不能把该提交解释为已经批准“永不提供独立服务端”。

删除前的旧配置面向 Windows Portable、macOS DMG 与 Linux AppImage/tar.gz，但没有当前
重构架构下的候选验证、签名、升级、安装器或支持责任证据，不能直接复制为当前方案。

### 当前主线

RED-23 的早期草案基于 `origin/main@6a2cb72`，当时主线仍只有 Server 开发启动入口。
随后 RED-19 的 `001e2ad` 恢复了新的 `build:electron:server`、
`electron-builder.server.json` 与 Windows Server 烟测，并随 RED-19 通过了自动检查、
独立 AI 复核和人工启动/停止验收。RED-18 在更新 electron-builder 后，又在最终主线依赖树
上复验了该入口，并明确保持 Server 配置相对当时主线无差异。

人工验收时 `origin/main@3249090` 的实际边界是：

- `build:electron:server` 为显式调用的独立命令；
- `build:electron` 与 `build:all` 仍只指向玩家客户端，不会默认生成 Server；
- `electron-builder.server.json` 的 Windows target 为 `dir`，只生成 `win-unpacked`；
- 仓库没有自动发布 Server 的 GitHub Actions 工作流；
- 当前产物没有 Server 安装器、代码签名、自动更新或公开下载承诺；
- 玩家客户端自身已能启动本地 Next/WebSocket 服务，承担普通玩家开服路径。

Server 产物携带 `electron/dist`、管理面板、Next standalone、`public`、`data`、`prisma`、
数据库初始化脚本、`adm-zip` 最小运行依赖与独立 Node 运行时。Server 和 Client 共用
`stage-client-resources.js` 生成的 Next standalone staging，避免恢复旧的第二套 staging
实现；两者仍分别维护 Electron 主进程、窗口、数据目录与服务生命周期。

## 决策

公开测试 Demo 保留当前 Electron Server 独立打包入口，但把它定义为**内部候选与 QA
验证工具**，不是公开发行物。

- 目标用户是项目开发者、QA 和桌面安全/打包审查者。
- 允许通过 `npm.cmd run build:electron:server` 生成本机内部候选，用于验证打包路径、
  管理面板、服务启动/停止、端口释放、资源边界和 Electron 安全设置。
- `build:electron` 与 `build:all` 继续只生成玩家客户端；Server 不进入默认 Demo 构建。
- 普通 Windows 玩家开服继续由 Electron Client 的内嵌本地服务能力承担。
- `electron/` 管理器保持独立，不合并进 Client，也不因本决策删除。
- 不新增 Portable/NSIS/MSI、代码签名、自动更新、开机自启或公开下载渠道。
- 不对独立 Server 产物承诺无人值守运行、版本升级兼容、公开支持周期或跨平台发行。

这项决策记录并约束当前已经进入主线的行为；RED-23 本身不修改构建脚本、builder 配置、
Electron 代码或运行时行为。

## 备选方案

| 方案 | 目标用户与分发 | 收益 | 成本与风险 | 结论 |
| --- | --- | --- | --- | --- |
| 恢复并公开分发独立服务端桌面包 | 专服管理员；通过正式下载渠道提供安装器或 Portable | 可脱离玩家客户端长期托管；管理生命周期独立 | 新增第三种公开产品、签名/安装器/升级与支持矩阵；数据目录、迁移、无人值守恢复和安全加固尚无合同 | 不采用 |
| 只保留开发启动入口，移除独立打包 | 开发者从源码运行 | 构建面最小；不会误解为可分发产品 | 无法验证 `app.isPackaged`、资源复制、独立 Node、数据库初始化和打包后窗口边界；会丢失已建立的 Server 候选烟测 | 不采用 |
| 只保留 Client 内嵌服务并合并/删除 Server 管理器 | 普通玩家；只分发 Client | 最终桌面入口数量最少 | 需要跨模块合并两套主进程与生命周期；删除独立诊断面，且不改善当前规则核心边界 | 不采用 |
| 保留独立内部候选，不公开分发 | 开发者与 QA；本机或受控内部构建 | 保留打包态和安全回归能力；复用 Client staging；不扩大公开产品面 | 仍需维护一份 builder 配置、主进程和烟测；必须防止把 `win-unpacked` 误称为发布包 | **采用** |

## 理由

1. 当前入口已经在 Electron 43 与 electron-builder 26.15.3 的主线组合上完成构建和真实
   启停烟测，保留它能持续覆盖开发启动无法触达的 `app.isPackaged` 分支。
2. Server 与 Client 已共用 Next standalone staging 和 Node 资源准备链，保留内部候选的
   增量维护成本低于恢复旧的 Server 专用 staging 链。
3. 当前没有已经确认的无人值守专服目标用户、公开下载方式或支持承诺，因此生成正式
   安装器、签名或多平台包没有足够产品依据。
4. Client 内嵌开服已覆盖 Demo 的普通玩家路径；内部 Server 候选的价值主要是诊断、
   生命周期隔离和安全回归，而不是新增玩家入口。

## 影响与风险

### 资源与维护边界

- 桌面/构建维护者负责 `build:electron:server`、Server builder 配置、资源清单和打包烟测。
- Electron Server 维护者负责 `electron/` 的窗口、托盘、IPC、子进程和退出清理。
- Next/WebSocket/Prisma 模块维护者负责 Server 与 Client 共用的服务资源及数据库行为。
- 发布负责人负责决定哪些候选可以进入下载渠道；内部 `win-unpacked` 不因构建成功自动
  获得发布资格。

### 已知风险

- Server 与 Client 共用 staging，任一方新增资源都可能导致另一方漂移。后续合同需用
  明确资源清单或哈希验证，而不是只检查 EXE 存在。
- 独立 Server 与 Client 内嵌服务仍有两套 Electron 生命周期，停止、重启和残留进程行为
  必须分别回归。
- 未签名的 unpacked 目录可能被误传为可发布包。文档、PR 与产物名称必须标注“内部候选”。
- 当前 `asar: false`，资源可见且可被本地修改；公开分发前必须重新评估完整性与签名边界。
- 独立长期托管涉及数据目录、备份、升级、崩溃恢复和开机自启，当前均不在支持范围。

## 与 RED-18、RED-19 的职责边界

- **RED-19** 负责 Electron 运行时升级、三个源码入口的窗口安全边界及打包态烟测；
  `001e2ad` 是当前 Server 构建入口重新进入主线的直接历史证据。RED-19 的验收不能代替
  “是否公开分发独立服务端”的产品决策。
- **RED-18** 负责 electron-builder 依赖链升级以及 Client/Editor 正式候选；它只在升级后
  复验主线已经存在的 Server 入口，且相对主线不修改 Server 配置。RED-18 不拥有 Server
  产品形态或分发范围。
- **RED-23** 负责解释历史、比较方案并确定维护/分发边界；本任务只修改文档和 Linear
  合同，不恢复、删除或调整构建行为。
- **RED-44** 负责把“内部候选”边界变成可重复验证的资源清单与候选证据；在该任务
  完成前，当前入口保持显式 opt-in，不扩大到默认构建或公开发行。

## 签名与安装器要求

当前内部 `dir` 候选不要求代码签名或安装器，但不得对外发布。若未来需要向专服管理员
分发，必须先用新 ADR 取代本记录，并创建 High Risk 发行合同，至少覆盖：

- 明确目标用户、支持平台、分发渠道和版本支持周期；
- Authenticode 证书保管、签名验证、时间戳与密钥轮换；
- Portable/NSIS/MSI 选择、安装范围、可选目录、快捷方式和完整卸载；
- 数据目录、备份、存档/数据库迁移、降级与损坏恢复；
- 自动更新或手动升级策略、供应链完整性和回滚；
- 开机自启、无人值守运行、崩溃重启、日志与端口/防火墙说明；
- 干净候选构建、安装/启动/停止/重启/卸载及残留进程验证。

## 验证方式

本 ADR 的历史与当前状态可重复核对：

```powershell
git show -s --format=fuller ac9b3bf
git diff ac9b3bf^ ac9b3bf -- package.json electron-builder.server.json `
  scripts/stage-server-resources.js scripts/cleanup-server-resources.js
git show --stat 001e2ad
git show 001e2ad -- package.json electron-builder.server.json `
  tests/electron/windows-smoke.mjs docs/technical/BUILD_AND_RUN.md
git grep -n "build:electron:server\|electron-builder.server" origin/main -- `
  package.json electron-builder.server.json docs/technical tests scripts
```

当前内部候选的实现验证入口为：

```powershell
npm.cmd run build:electron:server
node tests/electron/windows-smoke.mjs server
```

RED-23 只改变文档，不重新生成候选包。上述运行验证沿用 RED-19/RED-18 已记录的真实结果；
后续实现合同必须在当时最新主线重新执行并记录退出码、资源清单、产物路径和清理结果。

## 回退方式

- 若项目负责人撤销本次已接受决策，revert RED-23 的文档提交即可回到“尚未决定”的状态，
  不改变当前运行时或构建行为。
- 若项目负责人决定只保留开发入口，创建独立实现任务删除 Server build script、builder
  配置、打包烟测和相应文档；不得在 RED-23 中直接删除。
- 若未来需要公开独立服务端，创建新 ADR 取代本记录，并完成上文签名、安装器、数据迁移
  和候选发布合同后再扩大分发。
- 若内部候选构建阻断其他桌面产物，默认构建不受影响；可以暂时停止显式 Server 候选构建，
  并在独立修复任务中恢复，不回退 Client/Editor 已验收构建。

## 相关资料

- [RED-23](https://linear.app/redvsblue/issue/RED-23/评估是否恢复-electron-服务端独立打包入口)
- [RED-44](https://linear.app/redvsblue/issue/RED-44/固化-electron-server-内部候选打包与资源验证)
- [RED-18](https://linear.app/redvsblue/issue/RED-18/升级-electron-builder-26153-并清除构建工具链漏洞)
- [RED-19](https://linear.app/redvsblue/issue/RED-19/升级-electron-至受支持安全版本并复验桌面安全边界)
- [`BUILD_AND_RUN.md`](../technical/BUILD_AND_RUN.md)
- [`ARCHITECTURE.md`](../technical/ARCHITECTURE.md)
- 删除提交：`ac9b3bf`
- 恢复提交：`001e2ad`
