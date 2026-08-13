
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

RED-11 基线当时为 3 个测试文件、29 个测试。RED-14 完成后实测退出码 0；5 个测试文件、44 个测试全部通过。入口由 `package.json#scripts.test` 指向 `vitest run`，配置见 `vitest.config.ts`，用例位于 `tests/**/*.test.ts`。

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

## 4. 数据库初始化

`lib/db.ts#prisma` 从 `DATABASE_URL` 创建 Prisma Client。`npm run dev`、`npm start` 和 Electron 服务端都会在启动 Next.js 之前完成以下步骤：

1. 取得系统临时目录中的跨进程服务锁；
2. 按名称顺序读取 `prisma/migrations/*/migration.sql`；
3. 在事务中应用尚未记录的 migration；
4. 初始化成功后才启动 HTTP/WebSocket 服务；
5. 服务退出时释放锁。

`prisma/migrations` 是唯一可执行的数据库结构变更历史。`scripts/init-db.js` 不维护第二份手写表结构；它只执行已提交的 migration，并按 Prisma 标准格式在 `_prisma_migrations` 中记录名称和 SHA-256。migration 一旦被应用后不得改写，否则校验会拒绝启动；未来 schema engine 恢复可用后，官方 `prisma migrate deploy` 也能继续识别这些记录。

空数据库首次启动后，`GET /api/rooms` 返回 200 和 `{"rooms":[]}`。空房间列表是正常业务结果；初始化、校验或 migration 失败时，服务不会进入运行状态。

为保留 RED-14 之前的开发数据，初始化器只接受两个已知旧结构：最初 Prisma migration 的结构，以及旧 `init-db.js` 建出的完整结构。它会先逐表逐列校验，再登记对应 migration；未知、残缺或损坏结构会明确失败，不会重建、清空或猜测迁移。

当前环境中 Prisma 5.22 的 `prisma migrate deploy` 和 `prisma db push` 会返回退出码 1 及空泛的 `Schema engine error`。因此启动入口通过 Prisma query engine 事务化执行已提交 SQL，不依赖 schema engine。

同一用户只能运行一个 RED vs BLUE 游戏服务。第二个 Electron、第二次 `npm run dev`，或 Electron 与 `npm run dev` 交叉启动时，后启动者会在数据库初始化前退出。`RVB_SERVER_LOCK_PATH` 仅用于自动测试覆盖，不是常规运行配置。

回退 RED-14 时应回滚代码提交，不执行数据逆迁移。RED-14 只补齐当前 `schema.prisma` 已有的表和列，不删除业务数据；类型规范化 migration 会在事务内重建 `User`/`Room` 表并复制全部已有行。回滚后新增列/表可以保留。若初始化失败，先复制数据库文件作为证据，不要删除原库或手工编辑 `_prisma_migrations`。

## 5. Next.js / WebSocket 开发模式

直接执行：

```powershell
$env:PORT = '3000'
$env:WS_PORT = '3001'
npm.cmd run dev
```

真实入口链：

1. `package.json#scripts.dev` 启动 `scripts/start-server.js dev`。
2. 启动脚本取得单服务锁并应用 SQLite migration。
3. 初始化成功后启动 `next dev`。
4. `instrumentation.ts#register()` 在 Node runtime 导入 `lib/ws-server.ts#startWsServer()`。
5. HTTP 默认监听 3000；`lib/ws-server.ts#getWsPort()` 默认返回 3001。

RED-14 验证：空临时数据库由启动入口自动初始化；`GET /api/ping` 为 200；`GET /api/rooms` 为 200 和空房间列表；WebSocket 3001 握手成功。

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
2. `startGameServer()` 先取得跨进程服务锁，再调用 migration runner；任何一步失败都不启动服务。
3. `startGameServer()` 通过 `findServerEntry()` 找到 `.next/standalone/server.js`。
4. `spawn(getNodeBin(), [serverEntry])` 启动系统 Node 子进程，并传入 `PORT=3000`、`DATABASE_URL`、`APP_ROOT_DIR`、`USER_DATA_DIR`。
5. `createDashboardWindow()` 加载 `electron/dashboard/index.html`。

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
| Vitest | 通过，5 文件 / 44 测试 |
| ESLint | 失败，缺少 ESLint；RED-13 |
| 根 TypeScript | 通过 |
| Electron 服务端 TypeScript | 通过 |
| Electron 客户端 TypeScript | 通过 |
| Next 生产构建 | 冷环境失败，阻塞于 Prisma Windows 引擎下载；显式使用同版本缓存引擎时生成产物并退出 0，但日志仍有 Prisma 初始化错误 |
| Next HTTP / WS | 通过 |
| Electron 服务端 HTTP / WS | 通过 |
| 空数据库业务接口 | RED-14 自动初始化后通过，`GET /api/rooms` 返回 200 |
| 依赖漏洞 | 待审计，33 项；RED-12 |
| Windows 服务端打包 | 未运行：没有确认的服务端打包脚本 |
| Android 双向联机 | 未运行，不属于 RED-11 |

这套基线证明当前代码可以在 Windows 上完成规则测试和类型检查；已有 Prisma 引擎缓存时可以生成 standalone，并通过 Next 和 Electron 的 HTTP/WebSocket 启动冒烟。全新环境的 `npm ci` 虽返回 0，但首次构建仍可能因 Prisma Windows 引擎下载失败而被阻塞。它尚未达到“全功能可公开测试”的完成定义。
