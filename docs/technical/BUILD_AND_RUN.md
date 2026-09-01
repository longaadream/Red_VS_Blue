# Windows 构建与运行

更新：2026-09-01（RED-158 Phase F）

## 环境

- Windows 10/11 x64
- Node.js 与 npm 版本遵循仓库 `package.json` / lockfile
- Git
- 完整依赖通过 `npm.cmd ci` 安装

不要手工复制另一个 worktree 的 `node_modules`、构建目录或数据库目录。任务分支每天首次继续、提交 PR
和请求验收前都运行 `npm.cmd run check:main-baseline`。

## 安装与基础验证

```powershell
npm.cmd ci
npm.cmd run check:main-baseline
npm.cmd run check:windows-cutover
npm.cmd run typecheck
npm.cmd test
```

`check:windows-cutover` 是 Windows 迁移的静态门禁：它核对已退役路径不存在、包清单没有被禁用的直接
依赖、玩家生产源码只包含当前 Colyseus/PostgreSQL 接线。

## Colyseus 开发服务

为开发 authority 配置 PostgreSQL：

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
npm.cmd run dev:electron:client
```

开发入口会：

1. 检查 worktree 环境；
2. 构建 Colyseus authority bundle；
3. 准备应用私有的 PostgreSQL runtime；
4. 编译 Electron main process；
5. 启动 Client。

普通加入不会启动本机 authority。玩家选择本机开服时，Client 才在应用数据目录初始化 PostgreSQL，
随后启动 Colyseus，并把可连接 origin 提供给页面。

## Windows 打包

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
