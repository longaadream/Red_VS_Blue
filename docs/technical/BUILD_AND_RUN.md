
# Red VS Blue：Windows 构建与运行基线

状态：已在 RED-11 中实测，等待独立复核与人工确认

基线：远程 `main` 合并提交 `aa9c853d3e6597d151de8570d9a6f05ca2a1a687`

验证日期：2026-08-13

平台：Windows 10 22H2（10.0.19045，x64）

本文只描述当前仓库能够复现的结果，不代表 Android 双向联机、Windows 安装包或公开测试发布已经验收通过。

## 1. 已确认的工具链

| 项目 | 当前实测 | 来源或约束 |
| --- | --- | --- |
| 包管理器 | npm 11.17.0 | 根目录存在 `package-lock.json`（lockfileVersion 3），不存在 pnpm/yarn 锁文件 |
| Node.js | 24.19.0 | 当前环境；`next@16.1.6` 声明 Node `>=20.9.0` |
| Next.js | 16.1.6 | `package-lock.json` / 实际安装 |
| React | 19.2.4 | `package-lock.json` / 实际安装 |
| TypeScript | 5.7.3 | `package-lock.json` / 实际安装 |
| Electron | 33.4.11 | `package-lock.json` / 实际安装 |
| Prisma | 5.22.0 | `package-lock.json` / 实际安装 |
| Vitest | 4.1.5 | `package-lock.json` / 实际安装 |

待确认：仓库没有 `package.json#engines`、`packageManager`、`.nvmrc` 或等价版本文件，因此只能确认 Node 24.19.0 已通过本次基线，不能把它写成项目唯一官方版本。

PowerShell 可能因执行策略阻止 `npm.ps1`。本次没有修改系统执行策略，所有命令使用 Windows 自带的 `npm.cmd`。

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

RED-13 已补齐 `eslint@9.39.5` 与匹配当前 Next.js 16.3.0 的
`eslint-config-next@16.3.0`，因此该命令现在能够启动 ESLint 并检查真实源码。

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

`lib/db.ts#prisma` 从 `DATABASE_URL` 创建 Prisma Client。`electron/main.ts#startGameServer()` 在开发模式直接使用 `prisma/dev.db`，但只有打包模式会调用 `electron/main.ts#initDatabase()`。

空环境直接运行服务时：

- `GET /api/ping`：200；
- WebSocket 3001：可以握手；
- `GET /api/rooms`：500；
- 原始 Prisma 错误：`P2021`，`The table main.Room does not exist in the current database.`

RED-14 负责修复开发模式首次启动没有建表的问题。在修复前，可用仓库现有 `scripts/init-db.js` 建立临时调试数据库。该脚本的第二个参数必须是绝对路径：

```powershell
$taskDir = Join-Path $env:TEMP 'rvb-debug-db'
New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
$dbPath = (Join-Path $taskDir 'game.db').Replace('\', '/')
$moduleRoot = (Resolve-Path '.next\standalone\node_modules').Path
node scripts\init-db.js "file:$dbPath" $moduleRoot
$env:DATABASE_URL = "file:$dbPath"
```

实测：`scripts/init-db.js` 退出码 0，生成 32 KB SQLite 文件；随后 Prisma `Room` 查询成功，`GET /api/rooms` 返回 200 和 `{"rooms":[]}`。

当前环境中 Prisma 5.22 的 `prisma db push` 对绝对 URL、正斜杠 URL和临时目录相对 URL都返回退出码 1及空泛的 `Schema engine error`，所以本文不把它列为可靠初始化步骤。

## 5. Next.js / WebSocket 开发模式

先完成生产构建和上一节的临时数据库初始化，再执行：

```powershell
$env:PORT = '3000'
$env:WS_PORT = '3001'
npm.cmd run dev
```

真实入口链：

1. `package.json#scripts.dev` 启动 `next dev`。
2. `instrumentation.ts#register()` 在 Node runtime 导入 `lib/ws-server.ts#startWsServer()`。
3. HTTP 默认监听 3000；`lib/ws-server.ts#getWsPort()` 默认返回 3001。

实测：Next 约 1 秒进入 Ready；`GET /api/ping` 为 200；`GET /api/rooms` 在初始化临时数据库后为 200；WebSocket 3001 握手成功。

2026-08-13 17:49 的可审计冒烟输出：

```text
> my-project@0.1.0 dev
> next dev
▲ Next.js 16.1.6 (Turbopack)
- Local: http://localhost:3000
✓ Starting...
[WS] WebSocket server listening on port 3001
✓ Ready in 1482ms
GET /api/ping 200 in 304ms
PING_STATUS=200
WS_OPEN
WS_EXIT=0
```

该开发服务由测试执行单元人工终止，不把人工终止记作自然退出码 0。2026-08-13 17:50:27 的清理探测为 `PORT_3000_RELEASED=true`、`PORT_3001_RELEASED=true`、`PORT_CHECK_EXIT=0`。

最小 HTTP 探测：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/ping
Invoke-WebRequest http://127.0.0.1:3000/api/rooms -UseBasicParsing
```

最小 WebSocket 探测（服务正在运行时）：

```powershell
node -e "const WebSocket=require('ws');const ws=new WebSocket('ws://127.0.0.1:3001');ws.on('open',()=>{console.log('WS_OPEN');ws.close()});ws.on('error',e=>{console.error(e);process.exit(1)})"
```

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
3. `spawn(getNodeBin(), [serverEntry])` 启动系统 Node 子进程，并传入 `PORT=3000`、`DATABASE_URL`、`APP_ROOT_DIR`、`USER_DATA_DIR`。
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

## 8. RED-18：electron-builder 26.15.3 候选验证

验证日期：2026-08-13

验证环境：Windows 10.0.19045、Node.js 24.19.0、npm 11.17.0

验证分支：`codex/red-18-electron-builder-upgrade`

### 依赖安装与审计

```powershell
npm.cmd ci
npm.cmd audit --json
npm.cmd ls electron-builder app-builder-lib builder-util node-gyp tar tmp form-data --all
```

- `npm ci`：在合并 RED-13、RED-15、RED-16 后的最终锁文件上退出码 0，安装 998 个包。
- 升级前 audit：32 项（1 critical、29 high、1 moderate、1 low）。
- RED-18 首次升级后 audit：17 项（1 critical、15 high、1 moderate）。
- 合并最新主线后的最终 audit：12 项（1 critical、10 high、1 moderate）。
- 升级后不再报告 `electron-builder`、`app-builder-lib`、`builder-util`、`builder-util-runtime`、`@electron/rebuild`、`node-gyp`、`tmp` 或 `form-data` 漏洞。
- 仍报告的 `tar@6.2.1` 位于 `@capacitor/cli@6.2.1` 下，修复建议指向 `@capacitor/cli@8.5.0`；它不在 electron-builder 依赖链中，属于 RED-18 明确排除的 Android/Capacitor 升级范围。其余报告来自既有 Electron 33、Capacitor 以及前端/测试依赖，不是 builder 26 工具链回归。

升级后的关键构建依赖为：

- `electron-builder@26.15.3`
- `app-builder-lib@26.15.3`
- `builder-util@26.15.3`
- `builder-util-runtime@9.7.0`
- `@electron/rebuild@4.2.0`
- `node-gyp@12.4.0`，其内部使用 `tar@7.5.22`
- `tmp@0.2.7`
- `form-data@4.0.6`

RED-18 最初锁文件节点由 917 个变为 845 个；合并 RED-13、RED-15、RED-16 的 ESLint、Next.js 与 ws 更新后，最终锁文件包含 1129 个节点。最终直接依赖同时保留主线的 `next@16.3.0`、`ws@^8.21.0`、`eslint@9.39.5`、`eslint-config-next@16.3.0`，以及 RED-18 的精确 `electron-builder@26.15.3`。

### Electron 客户端

```powershell
npm.cmd run build:electron:client
```

初始结果：退出码 0，耗时 88.9 秒。`electron-builder 26.15.3` 生成 Windows x64 unpacked 目录。第一次人工验收随后发现，点击“使用本机服务器”会白屏；根因是干净 worktree 中被忽略的 `android-client/www/*.html` 等生成资源不存在，而构建命令没有先从受跟踪的 `data/pages` 同步页面。旧候选的 `resources/app/www` 只有 `js/` 和 `sw.js`，缺少运行时加载的 `index.html`。第二次人工验收发现页面虽能打开，但“棋子图鉴”为空；根因是页面通过 `./data/pieces/manifest.json` 等相对路径读取静态游戏数据，而候选的 `resources/app/www/data` 不存在。第三次人工验收发现图鉴卡片已经出现，但人物贴图全部回退成阵营占位内容；根因是页面从 `./images/*.jpg` 读取头像，而候选只在服务端的 `resources/app/public` 中包含这些图片，没有复制到离线页面的 `resources/app/www/images`。

修复后，Client 构建会先执行现有 `sync:pages`，再运行 `scripts/verify-electron-client-package.js`。`electron-builder.client.json` 将页面实际使用的卡牌、效果、地图、棋子、PVE、规则、技能、状态、地块和 `skill-keywords.json` 白名单复制到 `resources/app/www/data`，并将 `public` 顶层 JPG 与 `public/card-art` 白名单复制到 `resources/app/www/images`；本地账号数据库 `data/users.json` 与页面源码副本不会进入该前端目录。校验器既检查关键运行文件，也逐一比较 `data/pages` 中 27 个页面源资源、305 个白名单离线数据资源和 38 个离线图片资源与最终产物；三个旧候选分别会稳定报告缺少页面、离线数据或离线图片资源。

2026-08-13 完整重建先在 electron-builder 下载 Electron 时两次连接 GitHub 超时（`ETIMEDOUT`），没有生成可验收的新候选。随后通过 electron-builder 26 正式支持的临时 `electronDist=node_modules/electron/dist` 验证路径，使用本机相同版本 Electron 33.4.11 完成打包。合并最新主线并重新执行 Next.js 16.3.0 production build 后，最终 builder 退出码 0、产物校验退出码 0，打包与校验步骤耗时 35.7 秒。该临时参数没有写入项目构建配置。

最终 Windows x64 unpacked 目录：

- `dist/client-build/win-unpacked/RED vs BLUE.exe`
- EXE SHA-256：`615af01fe4445068ee344f21a7f8186445949f17e45b0cb5e1132e4cf849f644`

已验证以下资源仍存在：

- `resources/app/electron-client/dist/main.js`
- `resources/app/standalone/server.js`
- `resources/app/public`
- `resources/app/data`
- `resources/app/prisma`
- `resources/app/www/index.html`
- `resources/app/www/lobby.html`
- `resources/app/www/js/server-utils.js`
- `resources/app/www/js/game-engine.js`
- `resources/app/www/images/terrain/floor.webp`
- `resources/app/www/images/ana.jpg`
- `resources/app/www/images/card-art/holy-charge.jpg`
- `resources/app/www/data/pieces/manifest.json`（25 个棋子 ID）
- `resources/app/www/data/pieces/*.json`（含 manifest 共 26 个文件）
- `resources/app/init-db.js`
- `resources/node.exe`

GUI 回归验证：最终候选从“连接服务器”真实点击“使用本机服务器”后，渲染 URL 切换至最终产物中的 `resources/app/www/index.html`；再真实点击“棋子图鉴”，页面切换至 `resources/app/www/pieces.html`，显示“25 个棋子”，DOM 中实际有 25 张 `.piece-card` 和 25 张 `<img>`。25 张图片均为 `complete` 且 `naturalWidth > 0`，损坏图片数为 0；没有捕获脚本异常或控制台错误。验收机另有旧 Server Electron 进程使用相同的 `my-project` 用户目录和单实例锁，因此本次候选使用隔离的临时 `--user-data-dir` 启动；现有桌面应用身份冲突不属于 RED-18 的 builder 升级、白屏或图鉴数据修复范围。源数据 `data/pieces/blue-minato.json` 的名称和描述本身是字面量问号，候选如实显示该既有内容问题，修复棋子文案不在 RED-18 范围。

产物结构与 `electron-builder.client.json` 一致：继续使用 `asar: false` 和 Windows `dir` 目标，没有生成安装器。由于本次只修复旁载的 `resources/app/www`，启动器 EXE SHA-256 保持不变；候选内容变化由逐文件页面、离线数据及离线图片资源校验和 GUI 回归证明。

### Electron 编辑器

```powershell
npm.cmd run build:electron:editor
```

首次结果：退出码 1。TypeScript 编译、Windows x64 unpacked 打包成功，随后下载 portable 辅助资源时连接 GitHub 超时（`ETIMEDOUT`）。

单次网络重试：退出码 1。NSIS 与 7zip 辅助资源下载成功，之后连接被重置（`ECONNRESET`），未生成最终 `dist/editor/RED vs BLUE Editor 0.1.0.exe`。

2026-08-13 在辅助资源已缓存后再次执行：退出码 0，耗时 533.6 秒，首次 portable EXE 生成成功。人工验收随后发现，双击该候选只短暂显示忙碌光标，没有编辑器窗口；重复点击实际产生了 4 个并行的无窗口解压进程。清理后对单个进程计时，180 秒仍未创建窗口。该候选使用 `asar: false`，每次启动需要把 137,680,764 bytes 的 portable 展开为 736,964,306 bytes、23,595 个散装文件。相同候选的 `win-unpacked` EXE 约 1 秒完成页面加载，证明编辑器本体正常，问题位于 portable 自解压布局。

经项目负责人批准，2026-08-14 将 Editor 切换为 ASAR。第一次中间候选虽然把散装文件收进归档，但仍把根 Next.js 项目的 25,915 个 `node_modules` 条目收入 287,602,908 bytes 的 `app.asar`；portable 在 47.34 秒后才创建窗口，因此没有作为最终候选。最终配置通过 `beforeBuild` 正式接口声明由项目自行处理 Editor 运行依赖，ASAR 只保留 7 个应用条目；资源包脚本需要的 JSZip 最小依赖闭包作为 165 个外部运行文件复制。最终完整构建退出码 0，耗时 153.6 秒；`scripts/verify-electron-editor-package.js` 自动验证 333 个数据资源、19 个脚本资源和 165 个运行资源的缺失/陈旧状态，并确认归档中不存在 `node_modules`。

最终产物：

- `dist/editor/RED vs BLUE Editor 0.1.0.exe`
- 文件大小：72,991,281 bytes
- SHA-256：`de10de3ea27ed05b975dc87839febd4feb980727e50dd3e114fcbc5a569c3849`

已验证的 unpacked 产物与资源：

- `dist/editor/win-unpacked/RED vs BLUE Editor.exe`
- EXE SHA-256：`cc20c2f6b38ea9d6945e468d2983515497f4706ca10b922e5a2408f3cc324ab8`
- `resources/app.asar`：44,058 bytes，SHA-256 `70d4bc9649df4d5338fe7972881e68dd708e3fd8cd5fc86b8bb4b75637ad94b3`
- `resources/app/data`：333 个资源与源码逐文件一致
- `resources/app/scripts`：19 个资源与源码逐文件一致
- `resources/app/node_modules`：165 个 JSZip 最小运行资源与源码逐文件一致
- `resources/app/electron-editor/dist/main.js` 不存在；应用入口只位于 `app.asar`

最终 portable 从单进程启动到页面调试目标出现耗时 14.69 秒；页面状态为 `complete`，棋子列表包含 26 个 JSON 文件，`ana.json` 可读取。通过真实 IPC 创建并读回临时 JSON 成功，测试文件随后精确删除；portable 临时目录在程序关闭后自动清理。外部资源包脚本可从最终临时解压目录解析并加载 JSZip，运行时异常和控制台错误均为 0。

配置使用 `asar: true` 和 Windows `portable` 目标。`data`、`scripts` 与 JSZip 运行闭包继续作为真实外部文件；根 Next.js/Prisma 等生产依赖不进入 Editor。首次构建机仍需要访问 GitHub 下载 Electron、NSIS、7zip、NSIS resources 和 winCodeSign 辅助资源。Editor UI 中“构建资源包”的完整写出流程没有在 RED-18 中执行，因为它会修改 Android/资源包输出；该流程应在独立任务中验证，不把本次 JSZip 解析检查描述为完整资源包构建通过。

### Electron 服务端

```powershell
npm.cmd run build:electron:server
```

结果：退出码 1，npm 报告 `Missing script: "build:electron:server"`。当前重构基线只保留 `dev:electron:server`；`build:electron:server` 与 `electron-builder.server.json` 已在基线提交 `ac9b3bf` 中移除。

经项目负责人批准，RED-18 只验收当前存在的 client/editor 打包入口，不恢复服务端入口。是否恢复独立服务端桌面包由 Linear `RED-23` 单独评估；该任务只做架构决策，不在 RED-18 顺带实现。

### 签名与回退

两个现有 builder 配置都没有证书、发布或安装器签名配置。本次修改 `electron-builder.client.json` 的静态资源白名单，并修改 `electron-builder.editor.json` 的 ASAR、外部运行依赖和产物校验边界；没有新增证书或发布配置。日志中的 `signing with signtool.exe` 是 electron-builder 对 Windows 可执行文件的处理步骤；PowerShell `Get-AuthenticodeSignature` 对最终 portable 和 unpacked editor EXE 均返回 `NotSigned`，确认没有配置发行证书。

### 其他检查

- `npm.cmd run test`：验证时曾因沙箱禁止写入 `logs/game.log` 而有 7 个 `EPERM` 失败；允许正常写入该目录后重跑，退出码 0。Client 产物包含 6 个回归测试，Editor ASAR/外置资源包含 8 个回归测试；最终 6 个测试文件、46 个测试全部通过。
- `npm.cmd run check:encoding`：退出码 0，487 个文本文件通过。
- 根 TypeScript、Electron Client TypeScript 与 Electron Editor TypeScript：退出码均为 0。
- `node scripts/verify-electron-client-package.js`：退出码 0，27 个页面源资源、305 个白名单离线数据资源和 38 个离线图片资源与最终候选一致；`resources/app/www/data/users.json` 不存在。
- `node scripts/verify-electron-editor-package.js`：退出码 0，ASAR 入口、333 个数据资源、19 个脚本资源和 165 个外部运行资源与最终候选一致；归档中没有 `node_modules`，外部 JSZip 可以解析。
- `npm.cmd run lint`：ESLint 正常运行，退出码 1；结果为主线既有的 1005 项（657 errors、348 warnings）。RED-18 新增的 CommonJS 产物校验脚本使用局部规则豁免，没有增加 lint 问题。

回退时还原 RED-18 的独立提交，即可同时恢复 `package.json` 中旧版 builder 声明、对应 `package-lock.json` 构建依赖树与 Editor 的旧散装文件布局。构建产物不提交到仓库。
