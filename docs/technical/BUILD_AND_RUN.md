
# Red VS Blue：Windows 构建基线与 Electron 安全候选

状态：第 1–7 节为 RED-11 历史基线；第 8 节为 RED-19 当前候选，均等待人工确认

基线：远程 `main` 合并提交 `aa9c853d3e6597d151de8570d9a6f05ca2a1a687`

验证日期：RED-11 基线为 2026-08-13；RED-19 最新候选为 2026-08-14

平台：Windows 10 22H2（10.0.19045，x64）

本文只描述当前仓库能够复现的结果，不代表 Android 双向联机、Windows 安装包或公开测试发布已经验收通过。

第 1–7 节保留 RED-11 在 Electron 33.4.11 上取得的原始证据，不应解读为当前依赖版本；
RED-19 已将当前候选更新为 Electron 43.4.0，升级后的命令、边界与结果见第 8 节。

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
服务端会验证 3000 端口的启动/停止；客户端会验证本机模式、无效 TLS 证书拒绝和退出
清理；编辑器会直接启动最终 portable EXE，在最长 300 秒内等待 renderer，并记录实际
启动耗时、正式构建中的数据文件列表和退出清理结果。

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
