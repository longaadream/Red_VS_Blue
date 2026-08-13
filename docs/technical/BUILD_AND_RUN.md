
# Red VS Blue：Windows 构建与运行基线

状态：已在 RED-11 中实测，等待人工确认

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
- 缓存命中后 `npm.cmd ci --foreground-scripts --loglevel info` 用时约 73.5 秒，退出码 0，安装 799 个包。
- `npm.cmd ls --depth=0` 退出码 0。
- 安装没有修改 `package.json` 或 `package-lock.json`。
- npm 报告 33 个漏洞：1 low、1 moderate、30 high、1 critical。RED-12 负责独立审计；不要在基线任务中运行 `npm audit fix` 或 `--force`。

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

实测：退出码 1，错误为：

```text
'eslint' is not recognized as an internal or external command
```

原因已确认：`package.json#scripts.lint` 定义为 `eslint .`，但 `package.json` 和 `package-lock.json` 均没有 ESLint。RED-13 负责补齐并单独处理随后暴露的 lint 结果。当前不得把 lint 写成通过。

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

实测：退出码 0，生成 `.next/standalone/server.js` 并复制静态资源。构建日志包含以下限制：

- `next.config.ts#typescript.ignoreBuildErrors` 为 `true`，所以 Next 构建本身跳过类型校验；必须单独运行上一节的 `tsc`。
- Next 报告 `middleware` 文件约定已弃用，但本次不影响构建成功。
- Next 会改写受跟踪的 `next-env.d.ts` 类型引用；本次没有提交该生成器漂移。

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

本次 Windows 冒烟结果：

- Electron TypeScript 编译退出码 0；
- Electron 主进程成功创建 Node 子进程；
- `GET /api/ping` 返回 200；
- WebSocket 3001 握手成功；
- 测试结束后已终止 Electron 进程树，3000/3001 端口均释放。

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
| Next 生产构建 | 通过 |
| Next HTTP / WS | 通过 |
| Electron 服务端 HTTP / WS | 通过 |
| 空数据库业务接口 | 失败，`P2021`；RED-14 |
| 依赖漏洞 | 待审计，33 项；RED-12 |
| Windows 服务端打包 | 未运行：没有确认的服务端打包脚本 |
| Android 双向联机 | 未运行，不属于 RED-11 |

这套基线证明当前代码可以在 Windows 上完成规则测试、类型检查、生产构建，并通过 Next 和 Electron 的 HTTP/WebSocket 启动冒烟；它尚未达到“全功能可公开测试”的完成定义。
