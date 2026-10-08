# Windows 构建与运行

更新：2026-10-09（RED-247 源码构建）

## 环境

- Windows 10/11 x64
- Node.js 24.13.1、npm 11.8.0 为当前验证环境；Colyseus 至少要求 Node.js 22。CI 固定 Node.js 24.13.1。
- Git
- 完整依赖通过 `npm.cmd ci` 安装。仓库 `.npmrc` 固化现有 lockfile 使用的 `legacy-peer-deps=true`，无需临时追加参数。当前 Colyseus 可选 Zod 4 peer 与项目 Zod 3 的兼容性欠账仍在；这不是依赖升级或兼容性修复，不要使用 `npm audit fix --force` 代替构建修复。

不要手工复制另一个 worktree 的 `node_modules`、构建目录或数据库目录。任务分支每天首次继续、提交 PR
和请求验收前都运行 `npm.cmd run check:main-baseline`。

## 从 GitHub 源码构建

在新的目录中执行（Windows PowerShell 使用 `npm.cmd`；其他终端可使用 `npm`）：

```powershell
git clone https://github.com/longaadream/Red_VS_Blue.git
cd Red_VS_Blue
npm.cmd ci
npm.cmd run build
npm.cmd start
```

默认访问 `http://localhost:3000`。这是 Next 服务/API 状态页；完整游戏客户端使用下文的
Electron 入口，`npm run build` 本身不生成安装包、Android APK、资源发行包或启动 PostgreSQL。
源码 Web 构建不需要数据库、签名密钥或个人 `.env`。

`build` 依次生成练习/PVE worker、编译 CSS、运行 Next 生产编译与 TypeScript 检查、
验证 standalone 入口并复制静态资源。任一步失败都会停止并返回非零退出码。
成功产物包含 `.next/standalone/server.js`、`.next/standalone/.next/static/` 和
`.next/standalone/public/`。构建根目录固定为当前仓库，不依赖父目录或其他工作区的依赖。

`npm start` 使用构建出的 standalone 服务，并提供源码数据根目录；保留整个源码检出用于此启动方式。
可设置 `HOSTNAME`、`PORT`、`APP_ROOT_DIR`、`USER_DATA_DIR` 覆盖默认值；后两个分别指向只读应用资源和
可写运行数据目录。默认运行数据位于当前仓库。不要将个人数据库或运行数据提交到 Git。
分发完整桌面产物仍使用专门的打包入口，而非直接复制源码 Web 构建目录。

```powershell
$env:HOSTNAME = '127.0.0.1'
$env:PORT = '3100'
npm.cmd start
```

自动验证实际产物（临时端口、临时运行数据目录，完成后关闭服务）：

```powershell
npm.cmd test -- tests/build/web-build.test.ts --maxWorkers=1
node scripts/smoke-web-build.mjs
```

冒烟检查主页、ping API、页面引用的 Next 静态资源、public 文件以及 pieces/maps/skills 数据 API。
GitHub Actions `Source build` 在 Windows 和 Linux 的全新检出上执行安装、回归测试、构建和该冒烟。

### 常见构建问题

- `ERESOLVE`：确认在包含 `.npmrc` 和 `package-lock.json` 的仓库根目录运行 `npm ci`。
  不要复制另一工作区的 `node_modules`，也不要删除 lockfile 重新选版本。
- 找不到 Next/esbuild：安装必须成功，并包含 devDependencies；不要使用 `npm ci --omit=dev` 构建。
- 找不到 standalone 入口：先执行 `npm run build`，查看首个失败步骤；不接受仅有旧 `.next` 目录作为构建成功证据。
- TypeScript 报错：构建现已执行类型检查，应修复报告的文件；不要启用 `ignoreBuildErrors`。
- `EADDRINUSE`：停止占用该端口的自有服务或设置其他 `PORT`。
- 内存不足：关闭其他构建进程；可设置已有的 `RVB_BUILD_LOW_MEMORY=1` 降低并发。
- 安装的弃用/peer 兼容风险不等同于构建失败；关注命令退出码与首个错误。依赖升级另立专项任务。

## 开发分支基础验证

```powershell
npm.cmd ci
npm.cmd run check:main-baseline
npm.cmd run check:windows-cutover
npm.cmd run typecheck
npm.cmd test
```

`check:main-baseline` 面向包含 RED 编号的开发分支，刚克隆的 `main` 无需运行此协作门禁才能构建。

`check:windows-cutover` 是 Windows 迁移的静态门禁：它核对已退役路径不存在、包清单没有被禁用的直接
依赖、玩家生产源码只包含当前 Colyseus/PostgreSQL 接线。

## Colyseus 开发服务

为开发 authority 配置 PostgreSQL：

仓库提供的本机开发数据库配置为 [`config/docker-compose.colyseus.yml`](../../config/docker-compose.colyseus.yml)。
使用 Docker 时运行 `docker compose --project-directory . -f config/docker-compose.colyseus.yml up -d postgres`，端口为 `127.0.0.1:5433`，
数据库名为 `rvb_colyseus`；按该配置设置下面的连接 URL。也可以连接自己准备的 PostgreSQL。
从仓库根目录运行，并保留 `--project-directory .`，使配置迁移后继续使用原 Compose 项目名和数据库卷。

```powershell
$env:RVB_POSTGRES_URL = 'postgresql://user:password@127.0.0.1:5432/rvb'
npm.cmd run dev:colyseus
```

默认监听地址由运行脚本输出。可用以下端点验证：

- `GET /healthz`：必须返回 `protocol: rvb-colyseus`。
- `GET /rooms`：房间目录。
- `GET /rooms/:roomId`：单房间目录项。
- `GET /battle-reports/:battleId`：经 journal 验证的完整战报。
- `GET /battle-reports?playerId=...`：玩家战报目录。

连接 URL 不得写入仓库或日志；错误信息必须移除凭据与 query。

## 专项测试

```powershell
npm.cmd run test:colyseus
npm.cmd run test:postgres
```

PostgreSQL 集成测试需要 `RVB_TEST_POSTGRES_URL` 指向可删除测试数据的独立数据库；未设置时测试会明确
跳过，不能记录为通过。不要指向生产或个人持久数据库。

## Windows Electron Client 开发

```powershell
npm.cmd run build
npm.cmd run dev:electron:client
```

首次运行前的 `build` 会生成开发入口预检所需的 `.next/standalone/server.js`；网页或静态资源修改后需重新构建。

开发入口会：

1. 检查 worktree 环境；
2. 构建 Colyseus authority bundle；
3. 准备应用私有的 PostgreSQL runtime；
4. 编译 Electron main process；
5. 启动 Client。

Client 启动时在应用数据目录初始化或复用 PostgreSQL，随后准备 Colyseus 并直接打开主菜单。本机
Host & Play、训练与 PVE 复用该 authority；选择远端服务器只改变玩家对局连接目标，不让本机 authority
接管远端房间。

本机 authority 意外退出时，每轮最多自动恢复三次；预算耗尽后进入 `manual-required`，必须由玩家显式
重试。普通断线由 Colyseus native reconnection 恢复同一 session，不创建替代房间或重复座位。

## 内容编辑器与静态贴图

`npm.cmd run dev:electron:editor` 启动独立内容编辑器；`npm.cmd run build:electron:editor` 生成候选。
编辑器支持 JSON-first 编辑、PVE JSON 树及 PNG/JPEG/WebP/SVG 贴图库。资源包中的 SVG 必须通过静态白名单，
拒绝脚本、事件、外链、CSS、foreignObject 和嵌入对象；这不授予外部 HTML、JavaScript 或 CSS 加载权限。
可运行 `node tests/electron/windows-smoke.mjs editor-portable` 验证 portable 编辑器候选。

## Windows Client 打包

```powershell
npm.cmd run build:electron:client
```

该命令顺序执行 Next standalone、Colyseus bundle、嵌入式 PostgreSQL、资源 staging、Electron TypeScript、
electron-builder、产物验证和临时资源清理。产物位于 `dist/client-build/`。

验证器要求最终包至少包含：

- Electron Client main process；
- Next standalone 和静态页面；
- `colyseus/colyseus-server.mjs`；
- PostgreSQL runtime/manifest；
- Profile/content 资源。

## Windows 冒烟

构建完成后运行：

```powershell
node tests/electron/windows-smoke.mjs client
```

冒烟在系统临时目录复制候选包，验证 renderer 边界、Profile、嵌入式 PostgreSQL、Colyseus 健康、建房、
第二客户端加入、命令/receipt/transition、退出排空和残留进程。失败证据目录不得在定位前删除。

## 双 Windows 人工验收

1. 主机启动 Client，创建本机房间，确认目录只出现一个房间。
2. 客机填写主机 authority origin，刷新目录并加入该唯一 roomId。
3. 双方完成阵营与阵容确认，进入战斗。
4. 双方各执行至少一个动作并观察一致 authority version。
5. 结束对局，读取战报，核对参与者、终局、Trace 和 hash 验证状态。
6. 主机退出，确认 PostgreSQL 与 Colyseus 子进程结束；重启后读取 durable 战报。

若出现重复房间、单房间读取不支持、加入超时、版本/hash 不一致或非 durable 战报，RED-158 不通过。

## 回退

代码回退以整版 Git/安装包回退为单位；不得让新 binary 打开不匹配的 authority 数据。PostgreSQL 数据
目录属于用户持久数据，回退或卸载不得自动删除。任何数据删除都需要解析并确认精确绝对路径与单独授权。
