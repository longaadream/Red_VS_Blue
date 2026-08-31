
# Red VS Blue：Windows 构建基线与 Electron 安全候选

状态：第 1–7 节为 RED-11 历史基线；第 8 节为 RED-19 当前候选，均等待人工确认

基线：远程 `main` 合并提交 `aa9c853d3e6597d151de8570d9a6f05ca2a1a687`

验证日期：RED-11 基线为 2026-08-13；RED-19 最新候选为 2026-08-14

平台：Windows 10 22H2（10.0.19045，x64）

本文只描述当前仓库能够复现的结果，不代表 Android 双向联机、Windows 安装包或公开测试发布已经验收通过。

第 1–7 节保留 RED-11 在 Electron 33.4.11 上取得的原始证据，不应解读为当前依赖版本；
RED-19 已将当前候选更新为 Electron 43.4.0，升级后的命令、边界与结果见第 8 节。

## 0. RED-93 推荐统一入口

状态：2026-08-18 已建立统一编排入口；底层历史命令与候选证据继续保留在后续章节。

安装锁定依赖后，日常开发与验收优先使用：

```powershell
npm.cmd run rvb -- doctor
npm.cmd run rvb -- dev
npm.cmd run rvb -- verify RED-123
```

| 目的 | 推荐命令 |
| --- | --- |
| 检查 Node、npm、Git、依赖和工作树 | `npm.cmd run rvb -- doctor` |
| 启动默认 Next 开发服务 | `npm.cmd run rvb -- dev` |
| 运行标准验收并留证 | `npm.cmd run rvb -- verify RED-123` |
| 运行快速回归 | `npm.cmd run rvb -- verify RED-123 --profile quick` |
| 预览步骤但不执行 | `npm.cmd run rvb -- verify RED-123 --profile standard --dry-run` |
| 运行内部候选检查 | `npm.cmd run rvb -- verify RED-123 --profile candidate` |
| 构建 Electron client 并留证 | `npm.cmd run rvb -- package RED-123` |
| 预览打包但不创建产物 | `npm.cmd run rvb -- package RED-123 --dry-run` |

任务编号必须使用真实的 `RED-<数字>`。默认 verify profile 为 `standard`。

### 0.1 验证等级

profile 由 `config/validation-profiles.json` 集中定义：

- `quick`：编码检查和 Vitest，适合开发中的快速回归。
- `standard`：编码、TypeScript、ESLint、Vitest 和 Next build，适合普通 PR 验收。
- `candidate`：标准静态与测试检查，加 Electron client 打包，适合内部候选版本。

TypeScript 检查遵循当前安装的 Next 16 指南，先运行 `next typegen` 刷新路由类型，再运行 `tsc --noEmit`。不要改回只读取现有 `.next` 缓存的裸 `tsc` 命令。

修改 profile 时应在同一个 PR 中说明原因。不要在 AI 提示词或临时文档中复制另一套命令清单。

### 0.2 验证证据

verify 与 package 会写入：

```text
output/validation/<RED-ID>/<run-id>/
├── manifest.json
├── report.md
└── logs/
```

报告包含 Git commit、分支、工作树状态、Node/npm 版本，以及每个步骤的实际命令、退出码、开始/结束时间和耗时。失败时流程停在第一个失败步骤，但仍写出报告和已执行步骤日志。

`--dry-run` 会生成 `DRY-RUN` 报告但不执行底层命令，不能作为测试通过证据。失败时先查看报告所指向的第一个失败日志；不要用反复重跑掩盖不稳定失败。范围外失败应保留报告并建立独立 Linear 任务。

### 0.3 边界与回退

原有 npm scripts 仍可用于定位单个底层步骤。后续章节中的直接命令是历史基线、专项诊断或候选验证记录，不是团队日常入口的替代清单。

PASS 报告不能代替 UI、核心流程、安装包、存档、局域网、Android 互通或发布判断。统一入口不得自动合并、自动发布或绕过 Medium/High 风险所需的独立审查和人工批准。

回退 RED-93 的提交即可删除统一入口；底层原有 scripts 仍然保留。

## 1. 已确认的工具链

| 项目 | 当前实测 | 来源或约束 |
| --- | --- | --- |
| 包管理器 | npm 11.17.0 | 根目录存在 `package-lock.json`（lockfileVersion 3），不存在 pnpm/yarn 锁文件 |
| Node.js | 24.19.0 | 当前环境；`next@16.1.6` 声明 Node `>=20.9.0` |
| Next.js | 16.1.6 | `package-lock.json` / 实际安装 |
| React | 19.2.4 | `package-lock.json` / 实际安装 |
| TypeScript | 5.7.3 | `package-lock.json` / 实际安装 |
| Electron | 33.4.11 | RED-11 当时的 `package-lock.json` / 实际安装；当前版本见第 8 节 |
| Prisma | 5.22.0 | `package-lock.json` / 实际安装 |
| Vitest | 4.1.5 | `package-lock.json` / 实际安装 |

待确认：仓库没有 `package.json#engines`、`packageManager`、`.nvmrc` 或等价版本文件，因此只能确认 Node 24.19.0 已通过本次基线，不能把它写成项目唯一官方版本。

PowerShell 可能因执行策略阻止 `npm.ps1`。本次没有修改系统执行策略，所有命令使用 Windows 自带的 `npm.cmd`。

## Browser game engine build and differential fixture

Run `npm.cmd run build:game-engine` from the repository root before the differential test. The build writes `data/pages/js/game-engine.js` and `android-client/www/js/game-engine.js`; these files are generated and must not be edited manually.

Run `npx.cmd vitest run tests/game/engine-browser-differential.test.ts` to execute the fixed fixture (`normal-move-with-blocker`, seed `0x5eed64`) against the Node module and the browser IIFE bundle. The test evaluates the bundle in a VM with the same `process`/`require` compatibility shims expected by the existing training runtime; it is not a full browser or Android smoke test.

## 2. 安装

在仓库根目录执行：

```powershell
npm.cmd ci
npm.cmd ls --depth=0
```

实测结果：

- 冷缓存首次安装需要从 GitHub 下载约 115 MB 的 Electron 33.4.11 ZIP；网络较慢时十分钟内可能仍没有 npm 前台输出，但临时 ZIP 持续增长。
- 2026-08-13 17:53，在没有 `node_modules` 的隔离 Git worktree 中运行 `npm.cmd ci --foreground-scripts --loglevel info`：npm 报告用时 57 秒、安装 799 个包，命令最终退出码 0。
- 该次安装日志同时包含访问 Prisma 引擎校验文件失败的信息；npm 仍把 `@prisma/client` postinstall 记为 code 0。随后检查确认 `node_modules/@prisma/engines` 没有 Windows 引擎二进制，因此“`npm ci` 退出码 0”不等于“首次构建所需的 Prisma 引擎完整”。
- `npm.cmd ls --depth=0` 退出码 0。
- 安装没有修改 `package.json` 或 `package-lock.json`。
- npm 报告 33 个漏洞：1 low、1 moderate、30 high、1 critical。RED-12 负责独立审计；不要在基线任务中运行 `npm audit fix` 或 `--force`。

隔离安装的关键输出：

```text
v24.19.0
11.17.0
added 799 packages in 57s
npm info run @prisma/client@5.22.0 postinstall { code: 0, signal: null }
Error: request to https://binaries.prisma.sh/.../windows/schema-engine.exe.gz.sha256 failed
```

若 Electron 下载看似停住，可检查下载文件是否仍增长，不要同时启动第二个 `npm ci`：

```powershell
Get-ChildItem "$env:TEMP\electron-download-*\electron-v33.4.11-win32-x64.zip" -File
```

### 2.1 隔离 worktree 初始化与 Electron 预检

每个 Git worktree 都是独立的项目根目录，必须在该 worktree 内安装自己的依赖。不要复用父仓库或其他 worktree 的 `node_modules`，也不要用目录联接、符号链接或扩大 `turbopack.root` 绕过隔离边界。

在准备运行 Electron 开发入口的 worktree 根目录执行：

```powershell
npm.cmd ci --foreground-scripts
npm.cmd ls --depth=0
```

不要在同一个 worktree 中并发运行 `npm ci`、Next.js 构建或 Electron；`npm ci` 会重建本地 `node_modules`，并发进程可能在包目录被替换时误用到父目录工具或读到不完整依赖。

三种 Electron 开发命令会在 TypeScript 编译和 Electron 启动前自动运行对应的只读预检，也可以单独执行：

```powershell
npm.cmd run preflight:electron:client
npm.cmd run preflight:electron:server
npm.cmd run preflight:electron:editor
```

预检会验证当前目录确实是脚本所属的 worktree 根目录，并只接受该 worktree 内的本地依赖。Client 与 Server 还需要 `.next\standalone\server.js`，Editor 不需要 Next.js standalone 构建。

- 提示缺少本地依赖时，在错误中显示的 worktree 根目录运行 `npm.cmd ci --foreground-scripts`。
- 仅提示缺少 `.next\standalone\server.js` 时，依赖已经就绪；在同一目录运行 `npm.cmd run build`。
- 预检不会安装依赖、创建链接或修改任何项目文件。

## 3. 测试、静态检查与构建

### 3.1 自动测试

```powershell
npm.cmd test
```

实测：退出码 0；3 个测试文件、29 个测试全部通过。入口由 `package.json#scripts.test` 指向 `vitest run`，配置见 `vitest.config.ts`，用例位于 `tests/**/*.test.ts`。

### 3.2 ESLint

```powershell
npm.cmd run lint
```

RED-13 已补齐 `eslint@9.39.5` 与匹配当前 Next.js 16.1.6 的
`eslint-config-next@16.1.6`，因此该命令现在能够启动 ESLint 并检查真实源码。

实测：ESLint 正常运行，退出码 1；当前仓库存在 1005 项既有问题（657 errors、348 warnings）。
这些问题属于后续 lint 治理范围，不得把当前结果写成 lint 通过，也不应在 RED-13 中批量修复。

### 3.3 TypeScript

不要使用可能联网下载包的裸 `npx`；直接调用锁文件安装的本地编译器：

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\tsc.cmd -p electron\tsconfig.json --noEmit
.\node_modules\.bin\tsc.cmd -p electron-client\tsconfig.json --noEmit
```

实测：三条命令退出码均为 0。

### 3.4 Next.js 生产构建

```powershell
npm.cmd run build
```

显式指向同版本 Prisma 5.22.0 已缓存 Windows 引擎的环境中，构建命令最终退出码 0，生成 `.next/standalone/server.js` 并复制静态资源；这只是用于继续验证 Electron 启动链的有条件结果，不是冷环境通过。构建日志包含以下限制：

- `next.config.ts#typescript.ignoreBuildErrors` 为 `true`，所以 Next 构建本身跳过类型校验；必须单独运行上一节的 `tsc`。
- Next 报告 `middleware` 文件约定已弃用，但本次不影响构建成功。
- Next 会改写受跟踪的 `next-env.d.ts` 类型引用；本次没有提交该生成器漂移。
- 静态页面收集阶段仍记录 `PrismaClientInitializationError: Unable to require(...)`；虽然命令最终返回 0 并生成产物，也不得描述为无错误的干净构建。后续 Electron 运行时能加载 Prisma 并稳定返回空库 `P2021`，但这不消除冷环境下载阻塞。

没有 `node_modules` 的隔离 worktree 中，`npm ci` 虽然退出码为 0，但紧接着第一次 `npm.cmd run build` 在 `prisma generate` 阶段退出码为 1，并且没有生成 `.next/standalone/server.js`：

```text
> prisma generate && node scripts/build-tailwind.mjs && next build ...
Error: request to https://binaries.prisma.sh/all_commits/605197351a3c8bdd595af2d2a9bc3025bca48ea2/windows/query_engine.dll.node.gz.sha256 failed
BUILD_EXIT=1
```

设置 Prisma 5.22 自带的 `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` 后，校验文件错误被跳过，但引擎主体仍无法下载，构建仍退出 1。因此当前冷环境的第一个稳定阻塞点是 Prisma Windows 引擎下载，而不是 Next 编译。不要从其他工作区手工复制二进制后把冷环境写成通过；应先恢复对 `binaries.prisma.sh` 的访问或提供经过项目批准的引擎缓存方案。

## 4. 数据库初始化现状

`lib/db.ts#prisma` 从 `DATABASE_URL` 创建 Prisma Client。`electron-client/main.ts#startLocalServer()`
在开发模式直接使用 `prisma/dev.db`；打包客户端则使用 Electron `userData/game.db`，并在每次启动
本机服务器前调用 `scripts/init-db.js`。

打包产物没有可独立加载的 `.prisma/client` 目录，因此初始化脚本使用客户端随包 Node 运行时的
`node:sqlite` 执行事务化幂等 DDL。Electron 不再因为缺少 Prisma 目录跳过初始化；脚本失败会阻止
本机服务器以坏数据库继续启动。脚本会建立当前 `prisma/schema.prisma` 所需的 User、Room、GameRecord 及三张
BattleAuthority 持久化表、索引和 hash/version 列。对于旧客户端直接创建但缺少这些字段的 SQLite，
脚本只补齐缺失列和结构，不吞掉其他 SQL 错误。它不写入 `_prisma_migrations`，也不能替代独立
Relay 或生产数据库的正式 migration 流程。

可用同一个脚本建立隔离调试数据库，不需要 Prisma CLI 或 moduleRoot：

```powershell
$taskDir = Join-Path $env:TEMP 'rvb-debug-db'
New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
$dbPath = (Join-Path $taskDir 'game.db').Replace('\', '/')
node scripts\init-db.js "file:$dbPath"
$env:DATABASE_URL = "file:$dbPath"
```

初始化回归测试会对全新库、重复初始化和旧版不完整 Room 表执行真实 SQLite 校验：

```powershell
npx.cmd vitest run tests/electron/client-database-init.test.ts
```

本机测试数据不需要保留时，应先完全退出客户端，再删除该客户端 Electron `userData` 目录中的
`game.db`；下次选择“使用本机服务器”会重新初始化。不要在客户端仍运行时替换或删除数据库文件。

## 5. Next.js / WebSocket 单端口开发模式

完成数据库初始化后，只指定一个公开端口：

```powershell
npm.cmd run dev -- --port 3000
```

不得再设置 `WS_PORT`，也不需要 `wsBaseUrl`。真实入口链为：

1. `package.json#scripts.dev` 先通过 Node `--require` 加载 `scripts/ws-same-port-server.cjs`，再启动 `next dev`。
2. 预加载器在 Next 创建 HTTP(S) server 时保留 `/ws`、`/ws/` 和 `/ws/rooms/**` Upgrade；Next 自己的 HMR Upgrade 不受影响。
3. `instrumentation.ts#register()` 在 Node runtime 调用 `lib/ws-server.ts#startWsServer()`，创建 `noServer` WebSocket 服务并注册 Upgrade handler。
4. 静态/Admin HTTP 与游戏 WebSocket 始终监听同一个公开端口；玩家业务只使用 WS，HMR 重载会串行替换 handler 与旧连接，不会重新绑定第二个 TCP 端口。

旧玩家 REST 禁用探测：

```powershell
Invoke-WebRequest http://127.0.0.1:3000/api/rooms -UseBasicParsing
```

预期返回 HTTP 410 与 `PLAYER_REST_DISABLED`；静态资源、`/api/admin/**` 和 WebSocket Upgrade 不受影响。

最小 WebSocket/RPC 探测（服务正在运行时）：

```powershell
node -e "const WebSocket=require('ws');const ws=new WebSocket('ws://127.0.0.1:3000/ws/rooms/__lobby');ws.on('open',()=>ws.send(JSON.stringify({type:'rpc',requestId:'probe',method:'rooms.list',data:{}})));ws.on('message',raw=>{const msg=JSON.parse(String(raw));if(msg.requestId==='probe'){console.log(msg);ws.close();process.exit(msg.ok?0:1)}});ws.on('error',e=>{console.error(e);process.exit(1)})"
```

客户端只保存 `serverUrl`，并把该 HTTP origin 同源转换成 WebSocket origin；连接探测使用 `system.health`，不得回退到玩家 HTTP API。Radmin `26.0.0.0/8` 地址按 LAN 处理，内置服务绑定 `0.0.0.0`。

## 6. Windows Electron 服务端

Electron 服务端入口是 `electron/main.ts`，编译产物为 `electron/dist/main.js`，`package.json#main` 指向该文件。

```powershell
npm.cmd run build
.\node_modules\.bin\tsc.cmd -p electron\tsconfig.json
.\node_modules\.bin\electron.cmd .
```

真实启动链：

1. `electron/main.ts` 调用 `app.whenReady()`。
2. `startGameServer()` 通过 `findServerEntry()` 找到 `.next/standalone/server.js`。
3. `spawn()` 使用 `--require ws-same-port-server.cjs` 启动系统 Node 子进程，并传入唯一公开端口 `PORT=3000`、`DATABASE_URL`、`APP_ROOT_DIR`、`USER_DATA_DIR`；预加载器缺失时启动直接失败。
4. `createDashboardWindow()` 加载 `electron/dashboard/index.html`。

本次 Windows 冒烟使用同版本 Prisma 5.22.0 已缓存引擎生成的 standalone 产物；它证明 Electron 启动链可运行，不代表上一节的冷环境引擎下载阻塞已经消失。

2026-08-13 18:02 的关键启动日志：

```text
[electron] Dev mode: using file:C:\Users\Administrator\AppData\Local\Temp\rvb-red11-isolated\prisma\dev.db
▲ Next.js 16.1.6
- Local: http://localhost:3000
- Network: http://0.0.0.0:3000
✓ Starting...
✓ Ready in 322ms
[WS] WebSocket server listening on port 3001
```

可观察状态和探测结果：

- Electron TypeScript 编译退出码 0；沙箱外 `electron.cmd --version` 输出 `v33.4.11`、退出码 0。
- Windows 窗口枚举返回唯一目标：窗口 ID `3606184`，标题 `RED vs BLUE Server`，进程路径指向隔离 RED-11 worktree 的 `node_modules/electron/dist/electron.exe`。
- 本机 Windows Graphics Capture 连续两次返回 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`，因此本次没有伪造或声称存在截图；窗口对象、标题和进程路径作为等价 GUI 状态证据。
- 2026-08-13 18:03:48 探测：`PING_STATUS=200`，响应体为 `{"name":"RED vs BLUE Server","version":"1.0",...}`；WebSocket 输出 `WS_OPEN`，探测进程退出码 0。
- 同一 Electron 日志稳定记录空库错误 `P2021` / `The table main.Room does not exist in the current database.`，没有把业务接口写成通过。
- `Alt+F4` 后目标窗口从 Windows 窗口列表消失，但应用按现有托盘设计继续驻留；测试执行单元人工终止后，仍需按已核对的隔离路径和 PID 清理进程树，不能把关闭窗口等同于服务退出。
- 本次核对的隔离测试树根 PID 为 31996；`taskkill.exe /PID 31996 /T /F` 返回所有子进程终止成功。2026-08-13 18:06:53 再探测得到 `PORT_3000_RELEASED=true`、`PORT_3001_RELEASED=true`、`PORT_CHECK_EXIT=0`。

Electron 命令由测试执行单元人工终止，没有自然退出码；本文明确记录为人工清理，不记作退出码 0。

注意：`startGameServer()` 当前只在子进程存在 2.5 秒后设置 `serverRunning=true`，没有主动探测 `/api/ping` 或 WebSocket；管理面板显示“运行中”不能单独作为服务健康证据。

待确认：本次没有验证 Electron 窗口内所有按钮、房间管理、局域网第二台设备或 Android 客户端；也没有验证 Windows 打包产物。`package.json#scripts.build:electron` 当前实际别名为 `build:electron:client`，不是 Electron 服务端打包入口。

## 7. 当前基线结论

| 检查 | 结果 |
| --- | --- |
| 锁文件安装 | 通过，最终 `npm ci` 退出码 0 |
| 依赖树 | 通过，`npm ls --depth=0` 退出码 0 |
| Vitest | 通过，3 文件 / 29 测试 |
| ESLint | 失败，缺少 ESLint；RED-13 |
| 根 TypeScript | 通过 |
| Electron 服务端 TypeScript | 通过 |
| Electron 客户端 TypeScript | 通过 |
| Next 生产构建 | 冷环境失败，阻塞于 Prisma Windows 引擎下载；显式使用同版本缓存引擎时生成产物并退出 0，但日志仍有 Prisma 初始化错误 |
| Next HTTP / WS | 通过 |
| Electron 服务端 HTTP / WS | 通过 |
| 空数据库业务接口 | 失败，`P2021`；RED-14 |
| 依赖漏洞 | 待审计，33 项；RED-12 |
| Windows 服务端打包 | 未运行：没有确认的服务端打包脚本 |
| Android 双向联机 | 未运行，不属于 RED-11 |

这套基线证明当前代码可以在 Windows 上完成规则测试和类型检查；已有 Prisma 引擎缓存时可以生成 standalone，并通过 Next 和 Electron 的 HTTP/WebSocket 启动冒烟。全新环境的 `npm ci` 虽返回 0，但首次构建仍可能因 Prisma Windows 引擎下载失败而被阻塞。它尚未达到“全功能可公开测试”的完成定义。
## 8. RED-19 Electron 43 安全候选

状态：RED-19 桌面运行时安全基线，基于以上 RED-11 可复现结果继续验证
适用平台：Windows x64
运行时：Node.js 22.12.0 以上、Electron 43.4.0

### 8.1 安装与通用检查

```powershell
npm.cmd ci
npx.cmd install-electron
npm.cmd audit
npm.cmd test
npm.cmd run lint
npx.cmd tsc --noEmit
```

Electron 43 的安装工具要求 Node.js 22.12.0 以上。PowerShell 禁止执行
`npm.ps1` 时使用 `npm.cmd`/`npx.cmd`。Electron 43 将运行时下载器暴露为独立的
`install-electron` 命令；若 `npm ci` 后直接启动提示二进制未安装，必须先运行上面的
安装命令。下载器会按包内 checksums 校验产物。

### 8.2 桌面入口

| 入口 | 开发启动 | Windows 打包 |
| --- | --- | --- |
| 服务端管理器 | `npm.cmd run dev:electron:server` | `npm.cmd run build:electron:server` |
| 玩家客户端 | `npm.cmd run dev:electron:client` | `npm.cmd run build:electron:client` |
| 数据编辑器 | `npm.cmd run dev:electron:editor` | `npm.cmd run build:electron:editor` |

服务端和客户端启动前都需要已有 Next standalone 输出；开发启动前先运行
`npm.cmd run build`。客户端和服务端打包会自行执行这一步。

Windows 输出目录：

- 服务端：`dist/server-build/win-unpacked/`
- 客户端：`dist/client-build/win-unpacked/`
- 编辑器：`dist/editor/`

服务端 `win-unpacked` 当前仅用于内部候选、打包态安全检查和生命周期烟测，不是公开
发行物；它不进入 `build:electron` 或 `build:all`，也没有安装器、签名或自动更新承诺。
普通 Windows 玩家开服仍由客户端内嵌本地服务承担。当前 internal-only 候选的历史边界见
[`ADR-0003`](../decisions/ADR-0003-electron-server-packaging.md)；取代后的公开发行方向见下节。

#### RED-140 设计边界：尚无公开 Server 产物

[RED-140](https://linear.app/redvsblue/issue/RED-140/冻结自治服务器发行边界运行状态与本地管理-api-v1)
已经在设计层接受由
[`ADR-0021`](../decisions/ADR-0021-autonomous-server-operations.md) 取代 ADR-0003 的
internal-only 产品方向。未来公开 Server 的支持矩阵为 Windows 10 22H2 x64 与
Windows 11 x64；对 Windows 10 的应用兼容支持不代表微软继续提供常规系统安全支持。

公开候选必须由 [RED-148](https://linear.app/redvsblue/issue/RED-148/实现-windows-自治服务器安装签名更新与二进制回退流水线)
实现并验证按用户 NSIS 安装器、update ZIP、Authenticode-signed runtime catalog、签名 release
manifest、受控更新、备份和
二进制回退门禁。在 RED-148 完成这些门禁前，现有 `build:electron:server`、
`win-unpacked`、包验证器和 smoke 仍只产生内部证据，不得作为公开下载、安装或更新证据。
公开构建、签名、安装、更新和回退的精确命令及候选记录也由 RED-148 在真实实现后补充；
本设计章节不预先虚构命令，也不表示公开产物已经存在。

`build:electron:server` 会在清理 staging 前自动运行 Server 产物验证器，逐 SHA-256
核对 Electron main、管理面板、Next standalone 与静态资源、`public`、`data`、
`prisma`、`init-db.js`、`adm-zip` 和独立 `node.exe`。electron-builder 需要通过一条
独立映射复制 `_client-stage/node_modules`；缺少该映射时，顶层 standalone 文件仍可能
存在，但 Next 运行依赖会被漏掉，验证器会拒绝该候选。

Client 构建同样必须把 `_client-stage/node_modules` 独立映射到
`resources/app/standalone/node_modules`。不能只依赖 `_client-stage` 的整体映射；
Electron Builder 会漏掉其中嵌套的 `node_modules`。客户端验证器至少要求成品包含
`next/package.json` 与 `ws/package.json`，否则即使 `standalone/server.js` 存在也会拒绝候选。

成功构建会在 `dist/server-build/server-candidate-manifest.json` 写入内部候选标记、
基线 commit、工具链版本、完整资源路径/大小/SHA-256，以及 Server EXE 和 Node 运行时
证据。`_client-stage` 与 `_client-node` 清理后，可独立重放验证：

```powershell
node scripts/verify-electron-server-package.js
node tests/electron/windows-smoke.mjs server
```

独立验证会按 manifest 重新计算全部资源、Server EXE 和 `node.exe` 的大小与 SHA-256，
拒绝缺失、增加或被修改的文件。manifest 和 `win-unpacked` 都是未跟踪的本机候选证据，
不得加入 Git 或上传到公开下载渠道。**内部候选 ≠ 公开发行物**。

Server Windows smoke 会在唯一公开入口 `ws://127.0.0.1:3000/ws/rooms/__lobby`
验证订阅与 `rooms.list` 返回 `ok: true`。这项探测用于防止 standalone staging 的 Upgrade
预加载器失效、导致玩家客户端只看到连接超时；仅有 `/api/ping` 成功不能代替该证据，
也不得再探测或暴露内部 WebSocket 端口。

### 8.3 桌面安全边界

三个入口的每个 `BrowserWindow` 都必须显式保持：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`
- 仅加载其受信任的本地页面根目录
- 拒绝超出本地根目录的导航与所有 `window.open` 请求

客户端不再使用 `webSecurity: false`，也不再全局忽略或接受无效 TLS
证书。游戏页面仍通过浏览器同源规则访问本地/LAN/HTTPS API；Next API
已经返回 CORS 响应头。连接自签名 HTTPS 服务会按 Chromium 默认行为失败，
这是预期安全边界，不能通过恢复全局证书绕过解决。

Preload 只暴露列出的 IPC 能力，不暴露原始 `ipcRenderer`。RED-24 起，所有 handler
还会绑定到预先登记的 `BrowserWindow.webContents`、该 WebContents 的主 frame 和受信
页面 URL；客户端会按 game/admin/connect 窗口角色限制 channel。子 frame 导航一律
拒绝，即使目标 URL 位于受信目录内；renderer 内的 iframe 也不能调用高权限 IPC。

Electron 客户端游戏页通过只读 `rvb-client://app/` 协议加载内置 HTML/JS/CSS。
资源包保存在 `userData/resource-pack/versions/<archive-sha256>/`，只有
`data/**/*.json` 和 `images/**/*.{jpg,jpeg,png,webp}` 可以覆盖同路径的内置资源；
HTML、JavaScript、CSS、SVG 和未知类型始终从内置包读取。导入完成全部校验和暂存后
才原子替换 `active.json`，清除资源包只把活动版本设为 `null`，不会删除保留版本。

### 8.4 Windows 最小烟测

对开发启动和每个打包产物分别执行：

1. 启动应用并确认窗口可见、标题正确。
2. 在 DevTools 控制台确认 `process`/`require` 对 renderer 不可用。
3. 服务端：管理面板出现，启动/停止按钮可用，退出后没有遗留服务进程。
4. 客户端：连接窗口出现；本地模式可进入游戏首页；HTTPS 证书错误不会被静默放行。
5. 编辑器：主界面出现，能列出数据文件；不执行写入操作即可完成本次烟测。
6. 关闭窗口/托盘应用，确认主进程退出（服务端按托盘“退出”）。

记录命令、退出码、窗口截图、致命控制台错误和产物路径。不要把仅完成编译写成
“启动烟测通过”。

打包产物生成后，可从管理员 PowerShell 运行可重复的自动烟测：

```powershell
npm.cmd run smoke:electron:windows
```

脚本只清理与上述产物绝对路径、启动 PID 进程树和专用调试端口相匹配的测试进程。
服务端会验证 3000 端口的启动/停止；客户端会先把完整 `win-unpacked` 复制到系统临时
目录中的隔离路径，再从仓库外启动并验证本机模式、数据库、真实 WebSocket 建房、无效
TLS 证书拒绝和退出清理。这样 Node 无法沿父目录借用源码 `node_modules`，可防止缺包候选
在工作树内假通过。编辑器会直接启动最终 portable EXE，在最长 300 秒内等待 renderer，
并记录实际启动耗时、正式构建中的数据文件列表和退出清理结果。

RED-54 的开发态 Electron 棋子选择页使用聚焦冒烟。它启动真实 Electron Client 和内嵌
本机服务器，创建两名真实 PVP 玩家，强制两个阵营的本地棋子读取失败，验证服务器回退在
5 秒内返回正确阵营；第一名玩家提交 8 枚后进入等待，第二名提交 8 枚后进入共用
`battle.html`。运行命令：

```powershell
npm.cmd run build
npm.cmd run sync:pages
npx.cmd tsc -p electron-client/tsconfig.json
node.exe tests/electron/piece-selection-smoke.mjs
```

脚本使用独立的临时 `userData` 和调试端口 `19254`，只终止自身启动的 PID 进程树并在退出
时清理该临时目录；端口已占用时直接失败，不清理未知进程。可通过
`RVB_RED54_DEBUG_PORT` 和 `RVB_ELECTRON_EXE` 覆盖调试端口或 Electron 可执行文件。

### 8.5 候选验证记录（2026-08-13；2026-08-14 根据人工反馈修订）

- 在最新 `origin/main` 合并基线上执行 `npm.cmd ci`：退出码 0，安装 1047 个包；
  `npx.cmd install-electron` 完成运行时校验，
  `electron --version` 为 `v43.4.0`。
- `npm.cmd audit`：不再包含 Electron 或旧 `extract-zip` 漏洞链；仍有 23 个范围外依赖
  漏洞（1 low、1 moderate、20 high、1 critical），不能描述为 audit 全绿。
- `npm.cmd test`：5 个测试文件、44 个测试通过；其中 Electron 安全边界 12/12。
- 根工程及 `electron`、`electron-client`、`electron-editor` TypeScript 检查通过；
  `npm.cmd run build` 通过。
- `npm.cmd run lint` 能正常启动 ESLint，退出码 1；排除本机未跟踪 worktree 后复现
  最新基线已记录的 1005 项既有问题（657 errors、348 warnings）。RED-19 修改未增加 lint
  问题；全仓 lint 债务不在本次依赖升级范围。
- 服务端 `dir`、客户端 `dir` 和编辑器 `portable` 正式构建均退出码 0。编辑器构建首次
  从 GitHub 下载 NSIS 超时，改用一次性 `ELECTRON_BUILDER_BINARIES_MIRROR` 环境变量后
  成功；镜像地址未写入仓库配置。
- 人工核验发现点击“停止服务器”后会把 `taskkill` 导致的退出码 1 误报成“端口 3000
  已被占用”。最新候选会区分主动停止与非预期退出，并隔离旧进程的异步回调，相关
  回归断言通过；修订后的服务端正式产物已重建，仍等待人工再次点击确认不再弹窗。
- `npm.cmd run smoke:electron:windows` 三入口分别退出码 0：renderer 中 `process` 与
  `require` 均为 `undefined`；服务端越界导航保持原 URL，停止后 3000 不可达；客户端
  无效 TLS 探针被拒绝，受版本控制的 HTML/JS/数据/图片资产均可读取，本机模式为
  ready，退出后网关不可达；编辑器列出 pieces 26、skills 114、cards 17、rules 82 个
  文件并正常退出。
- 初版烟测只确认 portable 文件存在并启动 `win-unpacked`，因此没有覆盖人工报告的
  “便携版没反应”。直接启动旧 portable 后复现约 4 分 44 秒的无反馈等待；原因是编辑器
  误打包整棵生产依赖。最新配置只保留资源包构建所需的 JSZip 依赖树，portable 从
  158.0 MB 降至 88.6 MB，解包内容从约 840 MB / 24,520 文件降至 351 MB / 592 文件。
  最终三入口组合烟测直接启动 portable，编辑器在 16,710 ms 内出现“数据编辑器”，数据
  断言与退出清理通过；打包内 JSZip 生成探针也通过。

已知但未在 RED-19 扩大的边界：构建仍未签名且沿用 `asar: false`。客户端资源包写入
受信任页面根目录和 IPC sender 校验由 RED-24 收紧；`adm-zip` 版本按已完成的 RED-19
合同保持不变，本任务不升级、替换或移除该依赖。

### 8.6 回退

RED-19 在独立分支中以本 PR 交付。若 Electron 43 候选构建出现阻断性回归，
回退本 PR 的最终合并提交即可恢复 Electron 33.4.11 的 `package.json`/`package-lock.json`
及旧窗口
配置；回退后必须明确记录旧 Electron 与 `extract-zip` 漏洞重新出现，旧构建不得
发布。

## 9. RED-24 IPC 与资源包信任边界

RED-24 是 High 风险安全变更。三个 Electron 入口统一执行以下不变量：

- IPC sender 必须是 channel 允许的精确窗口、精确 `webContents`、主 frame 和受信 URL；
- `will-frame-navigate` 拒绝所有子 frame 导航，`will-navigate` 拒绝越界主页面导航；
- 客户端资源包压缩体最大 32 MiB、声明解压总量最大 128 MiB、单文件最大 16 MiB、
  entry 最多 2048；
- 读取 entry 内容前先拒绝绝对路径、盘符路径、反斜杠、目录穿越、大小写冲突、重复项、
  符号链接、加密项和不支持的 Unix 文件类型；
- `pack.json` 必须是合法 JSON，`name`/`version`/`fileCount` 必须满足 schema，所有准备
  激活的 data JSON 也必须能解析；
- 导入失败只删除本次 staging，不切换 `active.json`；旧版本目录保留用于人工回退。

自动验证顺序：

```powershell
npx.cmd vitest run tests/electron/ipc-trust.test.ts tests/electron/resource-pack-security.test.ts tests/electron/security-boundary.test.ts
npx.cmd tsc --noEmit
npx.cmd tsc -p electron/tsconfig.json --noEmit
npx.cmd tsc -p electron-client/tsconfig.json --noEmit
npx.cmd tsc -p electron-editor/tsconfig.json --noEmit
npm.cmd test
npm.cmd run build:electron:server
npm.cmd run build:electron:client
npm.cmd run build:electron:editor
npm.cmd run smoke:electron:windows
```

### 9.1 候选验证记录（2026-08-14）

- RED-24 聚焦测试：3 个文件、46 个测试通过；全量 `npm.cmd test`：7 个文件、78 个测试通过。
- 根工程与 `electron`、`electron-client`、`electron-editor` 四组 TypeScript 检查均退出码 0。
- `build:electron:server`、`build:electron:client`、`build:electron:editor` 均退出码 0，分别生成
  server/client `win-unpacked` 与 editor portable 候选。构建仍报告既有的未签名、`asar: false`
  和动态文件 tracing 警告；这些不在 RED-24 修改范围。
- `smoke:electron:windows` 退出码 0：server 拒绝越界导航并释放 3000；client 从
  `rvb-client://app/index.html` 读取内置 HTML/JS/data/image，非法 TLS 被拒，本地网关 ready 且
  退出后释放；editor portable 在 28,086 ms 内出现窗口并列出 pieces 26、skills 114、cards 17、
  rules 82 个文件。三个 renderer 的 `process`/`require` 均为 `undefined`。
- 独立 `npm.cmd ci` 未改变 lockfile；audit 仍报告既有依赖问题。根据批准合同，本任务不升级、
  替换或移除 `adm-zip`，也不把 audit 清零作为验收项。

人工候选验证在隔离 profile 中通过：Pack A 只激活合法 JSON/PNG，包内 HTML/JS/SVG
未落盘且协议请求返回 404；非法 JSON、路径穿越、大小写碰撞和单文件超限均被拒绝，
活动指针、时间戳和版本目录保持不变。clear 后 `version: null` 且 `previousVersion` 保留
Pack A；随后激活 Pack B、重复激活 B，均保持 previous version 指向 A，没有 self-reference
或 staging 残留。game 窗口越权调用 connect-only IPC 被拒绝，新窗口和可信 iframe 导航
被阻止。正常关窗后 Electron 与内置 Node 进程均退出，38521/3001 无监听。

### 9.2 合入最新主线后的复验（2026-08-14）

- 合入包含 RED-18 的 `origin/main` 后，RED-24 与构建边界联合聚焦测试 5 个文件、61 个测试
  通过；全量 `npm.cmd test` 为 9 个文件、93 个测试通过；编码检查 491 个文本文件通过。
- 根工程与 `electron`、`electron-client`、`electron-editor` 四组 TypeScript 检查再次通过。
- Server、Client、Editor 三个正式构建均退出码 0；Client 验证器核对 27 个页面资源、305 个
  离线数据资源和 38 个离线图片，Editor 验证器核对 333 个数据资源、19 个脚本资源和
  165 个运行时资源。
- `smoke:electron:windows` 在普通 Windows 用户权限下退出码 0：三个 renderer 都不暴露
  `process`/`require`，server 拒绝越界导航并释放 3000，client 拒绝无效 TLS 且本地模式
  ready，editor portable 可读取预期数据，三个入口均干净退出。沙箱内首次运行因 AppData
  目录只有读权限而无法创建 Chromium 单实例锁；以候选实际运行权限复验后通过。
- 相对最新 `origin/main` 的差异仍只包含 RED-24 合同允许路径；`package.json`、
  `package-lock.json` 与主线一致，没有升级、替换或移除 `adm-zip`。

回退代码时还原 RED-24 提交；只回退运行时资源时，将 `active.json.version` 原子改回其中
记录的 `previousVersion`，不要删除版本目录。

## 10. RED-18：electron-builder 26.15.3、Editor ASAR 与双分发候选

本节记录 2026-08-14 在最新 `origin/main`（`b7a90c4`）合并后的最终候选证据。第 8 节是
RED-19 在旧候选上的历史记录，不代表 RED-18 的最终依赖树或产物。RED-18 继承主线的
Electron `43.4.0` 和 Server 构建入口；`electron-builder.server.json` 与主线逐字节一致，
Server 不属于 RED-18 的实现差异。

### 10.1 依赖与安全审计

- 从干净依赖安装执行 `npm.cmd ci`：退出码 0，安装 949 个包；随后
  `npx.cmd install-electron --no` 退出码 0，`npx.cmd electron --version` 输出 `v43.4.0`。
- `electron-builder`、`app-builder-lib`、`builder-util` 均为 `26.15.3`；构建链中的
  `@electron/rebuild` 为 `4.2.0`、`node-gyp` 为 `12.4.0`、`tar` 为 `7.5.22`、
  `tmp` 为 `0.2.7`、`form-data` 为 `4.0.6`。兼容范围内额外固定 `fast-uri` `3.1.5`
  与 `lodash` `4.18.1`，避免新 advisory 再次污染构建工具链。
- 相同最终 lockfile 的 `npm.cmd audit --json` 在当前 registry advisory 快照间出现漂移：
  实现者连续 5 次得到 5 项（1 moderate、4 high），独立审查者得到 21 项（17 moderate、
  4 high）；两者均为 0 critical。证据按最坏的 21 项记录：`@capacitor/cli`、6 个
  `@typescript-eslint` / `typescript-eslint` 包、`@vitest/coverage-v8`、`@vitest/mocker`、
  `adm-zip`、`brace-expansion`、`eslint-config-next`、`glob`、`minimatch`、`null-loader`、
  `rimraf`、`serialize-javascript`、`terser-webpack-plugin`、`vite`、`vitest`、`webpack`。
  两种快照都没有命中 `electron-builder` / `app-builder-lib` 目标构建链；`glob`/`rimraf`
  只命中 Capacitor 嵌套节点，顶层 `minimatch` 来自 ESLint/TypeScript 工具。因此只能
  描述为“RED-18 目标构建工具链漏洞清零”，不能描述为全仓 audit 全绿。

### 10.2 自动测试与构建验证

- `npm.cmd test`：7 个测试文件、59/59 通过；RED-18 三个重点测试文件为 27/27 通过。
- 根工程、`electron`、`electron-client`、`electron-editor` TypeScript 检查均通过；
  RED-18 脚本和直接相关测试的 ESLint 退出码 0；编码检查 489 个文本文件通过；
  `git diff --check` 通过。
- Client 正式构建退出码 0；验证器逐 SHA-256 核对 27 个页面资源、305 个离线数据资源
  和 38 张离线图片。`dist/client-build/win-unpacked/RED vs BLUE.exe` 为
  225,533,440 bytes，SHA-256
  `ACC1A09EEB8AF3DCDE9E6C7CE52ED4423A88148CA94453AA927D9D5C2C76194D`，未签名。
- Editor 正式构建同时生成 Portable 和 assisted NSIS（当前用户/当前机器可选安装目录），
  退出码 0；验证器核对 333 个数据资源、19 个脚本资源和 165 个运行时资源。
- Editor 的 `app.asar` 为 45,084 bytes，SHA-256
  `E7858424141EFFFBB59EA9979FD0AC3BA819E11CF1E4CFE5773E592DAB844F0F`；其中只有
  `package.json`、编译后的 main/preload 与 UI 共 7 个条目，没有 `node_modules`。
  JSZip 的最小运行时闭包作为 `extraResources` 保持在 ASAR 外部。
- 主线 Server 入口也在相同依赖树上重新构建并通过 smoke：renderer 不暴露
  `process`/`require`，越界导航被拒绝，停止后 3000 端口不可达。该项仅作为兼容性证据，
  Server 配置和实现没有 RED-18 差异。

### 10.3 Portable 与 NSIS 生命周期证据

- Portable：`RED vs BLUE Editor 0.1.0.exe` 为 90,171,912 bytes，SHA-256
  `D4C9E86C55D6A76BDC61D9C79F9D53100A44F7CA36DE1BF365F1B7C2353E2D66`，未签名。
  直接启动到“数据编辑器”renderer 用时 22,968 ms；renderer 中 `process`/`require` 均为
  `undefined`，可列出 pieces 26、skills 114、cards 17、rules 82 个文件，关窗后进程干净退出。
- NSIS：`RED vs BLUE Editor Setup 0.1.0.exe` 为 90,401,895 bytes，SHA-256
  `169E1E4FA389522D67EB2321D0D63ED51399CDE5321B180F562F6C6070D87F8F`，未签名。
  静默安装到隔离的当前用户目录退出码 0、耗时 23,381 ms；安装后启动到相同 renderer
  用时 3,143 ms，安全边界和数据 IPC 断言与 Portable 一致。
- 静默卸载退出码 0、耗时 8,178 ms；安装目录被删除，HKCU 卸载项从 1 变为 0，桌面与
  开始菜单快捷方式从 2 变为 0。验收专用用户目录也已删除。

当前候选的已知边界：Windows EXE 尚未配置发布证书；本轮 smoke 只读取正式包内数据，
没有执行会写出完整资源包的人工操作。回退 RED-18 的最终提交会保留主线 Electron 43.4
和 Server 入口，但会撤销 editor-builder 26.15.3、ASAR、NSIS 及资源验证器，并重新暴露
本任务所清理的构建工具链风险；回退后的旧构建不得发布。

## 11. RED-118：统一内容发布链与 Windows candidate

内容 Snapshot/Patch 现在统一走：

```text
build -> sign（非 Local Dev） -> validate -> resolve -> smoke -> report
```

推荐入口：

```powershell
npm.cmd run rvb -- build RED-118 snapshot --source <目录> --output <归档> --package-id <id> --version <SemVer> --display-name <名称> --publisher-id <publisher-id>
npm.cmd run rvb -- build RED-118 patch --source <目录> --output <补丁归档> --package-id <id> --version <SemVer> --display-name <名称> --publisher-id <publisher-id> --parent-profile-hash <父Profile哈希> --operations-file <operations.json>
npm.cmd run rvb -- validate RED-118 --archive <补丁归档> --base bundled --channel qa --trusted-key-id <publisher-key-id>
npm.cmd run rvb -- resolve RED-118 --base bundled --patch <签名补丁> --channel qa --trusted-key-id <publisher-key-id>
npm.cmd run rvb -- sign RED-118 --input <归档> --key-file <外部私钥> --output <签名归档> --channel qa
npm.cmd run rvb -- smoke RED-118 --base bundled --patch <签名补丁> --seed 118 --channel qa --trusted-key-id <publisher-key-id>
```

命令使用结构化 argv，返回稳定退出码，并在
`output/validation/RED-118/<run-id>/` 写 JSON 与 Markdown 报告。报告包含 package hash、
resolved Profile hash、authority content hash、engine/content ABI、capabilities、signature/key ID、seed、
失败 stage 及拒绝路径/content ID；
不包含私钥正文或私钥路径。`scripts/build-resource-pack.js` 只用于旧调用方兼容，运行时会输出
deprecated 警告并转发到同一 `rvb build` 实现。参数解析失败也以退出码 2 写标准报告；报告中的
command 只保留脱敏后的结构，不记录原始 argv 或 key path。Patch 不能脱离父 Profile 单独验证：
`validate` 必须通过 `--base` 和必要的重复 `--patch` 参数提供完整前置链。

channel 约束：

- `local-dev` 允许 unsigned/dev-only 输出。
- `qa` 与 `community` 必须使用仓库外部的签名私钥；validate/resolve/smoke 还必须显式传入
  `--trusted-key-id` allow-list，不能把“签名有效”等同于“publisher 受信”。
- `stable` 必须使用外部私钥并显式提供人工确认；RED-118 candidate 不生成、不保存也不使用
  真实 Stable 私钥。Stable 的人工确认与显式 publisher allow-list 任一缺失都必须 fail closed。

Editor 的可写源、归档、临时密钥和报告位于 Electron `userData/content-authoring/`。renderer 只能
通过封闭的 `content-operation` IPC 请求 build/validate/resolve/sign/smoke；main process 会校验
调用窗口、字段集合及所有路径都在 authoring workspace 内；内容操作和旧数据 list/read/write/open
IPC 的现存路径都做 realpath 校验并拒绝 symlink/junction 穿越，再交给已打包的
`content-pipeline-worker.cjs`。操作通过有界串行队列执行，
不会并发改写同一 authoring workspace。Portable/安装版 Editor 不调用系统 Node，也不依赖源码
checkout。

RED-118 内容候选可单独执行：

```powershell
npm.cmd run candidate:content-pipeline
```

完整 Windows candidate 由 `candidate` validation profile 编排内容候选、Server/Client/Editor
正式打包和 `smoke:electron:windows -- server client editor profile`。它通过 candidate pointer 把
同一 Base+图片 Patch+PVE 节点 Patch fixture 及其精确 hash 交给 CLI、打包 Editor、Client 和 Server；
候选 fixture 的 build/sign/validate/resolve/smoke、篡改和渠道拒绝均先经过真实 CLI argv 适配器，
再从逐操作落盘报告取得候选身份。Portable 与隔离安装后的 NSIS Editor 都在源码 checkout 外、无系统
Node 的 PATH 下实际执行 build/sign/validate/resolve/fixed-seed smoke 全链。候选还验证 QA/Community 临时密钥、
篡改拒绝、密钥轮换、Client/Server 激活/重启/回退，以及固定 seed PVE 的正式终局、奖励和
结束状态。临时私钥在系统临时目录创建并在候选退出前删除；正式发布、上传、合并和真实 Stable
签名仍需人工单独批准。

candidate 全量测试前只把受跟踪的 frozen desktop `game-engine.js` 逐字节复制为被忽略的 Android
测试镜像；它不运行会改写 frozen bundle 的生成器，也不把 Android 打包误写成 RED-118 验收范围。

该 candidate 使用 `npm.cmd run lint:content-pipeline` 对 RED-118 全部代码执行空 suppressions lint；
全量 Vitest 在候选中限制为两个 worker，降低 Windows 打包 fixture 与 Git fixture 的磁盘争用，测试集合
和单测超时合同不变。
`standard` profile 仍保留仓库全量 `npm.cmd run lint`。当前 `origin/main` 的全量 lint 会在
ESLint flat config 中因 `import/no-anonymous-default-export` 所属 plugin 未挂载而失败，该基础设施
问题不在 RED-118 允许路径内，不能通过本任务修改或隐藏。

回退时停止新的内容构建，保留证据和最近已验证版本，把 Client/Server 的 `active.json` 切回
`previousStable` 后回退 RED-118 提交。不得通过删除版本目录或绕过签名校验完成回退。
