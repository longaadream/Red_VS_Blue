# RED-161 Colyseus 默认玩家链路切换验收记录

- 风险：High
- 分支：`codex/red-161-colyseus-electron-cutover`
- 合同起始基线：`base_branch: main`，`base_sha: 8902c0da94957fdb52d142363c2c45a2ebda7a7f`
- 当前验证基线：`origin/main@aa1d91351d6852909166f9b2e75943105ded1255`，已包含最终 RED-138/139；
  RED-161 于 `ae7a28f` 合并该基线后重新验证
- 状态：LAN 内置 PostgreSQL 实现与精确 Windows 候选单机冒烟通过；独立代码复审无 P0/P1，仍等待
  双端人工候选与强制恢复门禁，不能合并或发布

## 已切换范围

- 五个默认玩家页面加载 Colyseus SDK，并通过 `RvBWs` 兼容层使用真实 Colyseus Room。
- Product Room 覆盖建房、双人入座、阵营、准备、8 棋阵容锁定、RED-138 渐进部署和战斗动作。
- Electron 的玩家 `localUrl` 指向 Colyseus 端口；内容 Profile 管理仍使用独立旧运行时端口。
- Profile 运行时显式设置 `DISABLE_WS=1` 并关闭 legacy battle authority/journal/timer；旧实现只保留为
  整版回退代码，不能在 Colyseus 候选中接收玩家 Room/action。
- Colyseus authority 作为 Electron 资源独立打包；新 authority 模块不 import SQLite/Prisma。
- 普通动作回执不等待数据库；version 0 与终局仍使用 RED-160 的 PostgreSQL durable 边界。
- Windows LAN 房主按需启动随客户端分发的 PostgreSQL 16.15-2；远程加入者不启动数据库。首次开服
  自动初始化 userData 下的 cluster、随机 SCRAM 密码和 `rvb_colyseus` 数据库，后续启动复用同一数据。
  内置 PostgreSQL 仅监听 loopback 动态端口；外部 `RVB_POSTGRES_URL` 优先且不会启动内置实例。

## 本机无 Docker UI 冒烟

以下入口使用内存测试替身，只用于 UI/Room 验收：

```powershell
$env:RVB_COLYSEUS_PORT = '38671'
npm.cmd run qa:colyseus
npm.cmd run qa:colyseus-pages
```

浏览器打开 `http://127.0.0.1:38672`，连接 `http://127.0.0.1:38671`。health 会明确报告
`runtime=colyseus-qa-volatile`、`database=memory-test-double`，不得记录为 PostgreSQL 通过。

2026-09-01 自动浏览器双端已完成：连接、建房、暗/光入座、双方准备、各选 8 棋和进入战斗。
过程中发现并修复：连接页只接受旧 `rvb-ws`；战斗页把大小写敏感的 Colyseus Room ID 转成小写。
Trace 按合同未验证。既有内容数据仍缺少 `evil-explosion.json`，毒液配置引用 `venom.png` 而资源为
`venom.jpg`；两项均不在 RED-161 范围。

后续人工验收发现目标准备被 Colyseus `battleReceipt` 压平成普通失败、QA 计时器被脚本关闭，以及
目标技能需要一次额外的准备往返。修复后：拒绝协议保留 target/option continuation；兼容层转入既有
`actionError` 交互；QA 与产品均启用计时器；技能目标可由本地规则适配器即时展示，最终带目标命令
仍由服务端权威校验。该预检只读、非权威，不写回状态、不消费随机、不预测伤害/触发/终局；服务端
continuation/rejected 始终覆盖本地展示。通用客户端预测与 Web Worker 不在本任务范围。Colyseus
启动也显式安装 Node 原生 SHA-256 provider。

阻塞 writer 的双 SDK 客户端样本会单独报告前 5 次冷路径，并以之后 100 次作为热路径门禁。本机复测：

| 度量 | 冷路径最大值 | 热路径 P50 | 热路径 P95 | 热路径 P99 |
| --- | ---: | ---: | ---: | ---: |
| 服务端 queue → rules → memory commit → receipt | 63.032 ms | 28.314 ms | 42.695 ms | 56.705 ms |
| 本机 SDK send → APPLIED | 73.384 ms | 36.429 ms | 52.558 ms | 85.744 ms |

热路径分解 P95：queue 0.042 ms、rules 25.940 ms、memory persistence 2.930 ms、其余投影/哈希
14.653 ms。数据库 writer 在采样期间保持阻塞，因此这些数字不包含 PostgreSQL 等待。测试使用 5 个
冷样本与 100 个热样本，P99 不再退化成小样本最大值；本机自动门禁为 P95 `< 100 ms`、P99
`< 150 ms`。这不能替代最终 LAN 候选实测。

## 自动验证

- 官方 `postgresql-16.15-2-windows-x64-binaries.zip` 固定 SHA-256
  `840b9d265f6ab6c0a971c1d8e9096de564950d38dc2a5ccd98c8820179ecf115`；裁剪后的 `bin/lib/share`、
  server license 与命令行工具第三方许可证为 1618 个 manifest 条目、96.0 MiB；候选内加 manifest
  后为 1619 个文件、约 96.2 MiB。StackBuilder 及其 wxWidgets/libcurl GUI 依赖均未打包。
  逐文件 hash 验证通过，未包含 pgAdmin/StackBuilder/include/doc。
- `npx.cmd tsc -p electron-client/tsconfig.json --noEmit`：内置 PostgreSQL 生命周期接入后通过。
- 当前 Codex 验证宿主进程为 Windows 高完整性管理员令牌；直接运行 `postgres.exe` 会被官方安全检查
  拒绝。生命周期已改用官方 `pg_ctl`，由其为数据库子进程移除管理员权限；同一宿主已验证真实实例
  可以监听 loopback、接受连接并正常 fast shutdown。
- `tests/electron/embedded-postgres.test.ts` 使用官方随包 runtime 完成首次 `initdb`、写入、fast stop、
  同一 cluster 重启读取，并在 4.5 秒健康监测窗口后仍保持正常；临时密码文件已删除。
- `tests/integration/postgres/embedded-postgres-runtime.integration.test.ts` 使用同一随包 runtime 通过
  version 0、journal 微批、重复命令、恢复与 terminal durable barrier 的真实 PostgreSQL 集成。
- `tests/colyseus/product-room.test.ts` 预置 durable room 后启动一套新的 Colyseus matchmaker，验证启动时
  从 PostgreSQL 清单重新注册房间、`/rooms` 可见，且玩家能使用原 roomId `joinById` 重连。
- 正常退出先关闭 journal admission、等待已进入的 reservation 完成，再 drain 后回 ACK；drain 失败时
  Electron 保留 Colyseus/PostgreSQL 并明确拒绝安全退出，不会发送假 durable ACK。

- 同步最终 RED-138/139 后，`npm.cmd run test:colyseus`：5 files / 11 tests，通过。
- RED-138 渐进部署、RED-139 hash 证据、Room 隔离及浏览器规则差异回归：5 files / 23 tests，通过。
- 迁移 legacy raw WebSocket/单端口合同并保留 Profile、日志、LAN 与 UI 不变量：9 files / 106 tests，通过；
  由此发现并修复大厅缺失缓存 Identity 时误用 Colyseus `localUrl`、而非独立 `profileRuntimeUrl` 的问题。
- Colyseus 双客户端阻塞 writer 延迟门包含在上述套件中：热路径 server/client P95 均强制
  `< 100 ms`，P99 均强制 `< 150 ms`，通过。
- RED-160 原始套件与相邻回归此前合计 42 tests 通过；本次新增 product action 后以以上 12 项为
  当前切换门禁。
- `npm.cmd run typecheck`：通过。
- `npx.cmd tsc -p electron-client/tsconfig.json`：通过。
- `node --check`：Colyseus product/QA/static/build 四个脚本通过。
- `npm.cmd run build:colyseus`：通过，生成 5.5 MB product authority bundle；构建门禁确认 bundle 不含
  Prisma、SQLite PRAGMA 或 legacy RoomStore，WebSocket transport 静态打包，避免运行时动态依赖遗漏。
- bundle 使用故意不可达的 PostgreSQL 端口启动时执行到数据库边界并明确 `ECONNREFUSED`；这只证明
  产物可加载和失败关闭，不是数据库集成通过。
- 在 RED-161 工作树内使用 `npm.cmd ci --legacy-peer-deps` 完成干净依赖安装；Colyseus 0.18 的可选
  Zod 4 peer 与项目现有 Zod 3 要求该兼容解析，锁文件本身未发生变化。
- `npm.cmd run build:electron:client` 的 Next 生产构建与 Colyseus bundle 通过。Electron 客户端的根
  `node_modules` 已从 `files` 排除，Next standalone 和 Node-targeted authority 作为独立资源打包，因此
  设置 `npmRebuild: false`，避免错误地把 Colyseus 可选原生加速模块重编译为 Electron ABI。随后
  Windows `dir` 候选构建通过，`verify-electron-client-package` 检查 48 个页面资源、287 个离线数据
  资源与 43 个图片资源，全部通过。解压候选总计 669.0 MiB，其中 PostgreSQL 96.3 MiB。
- `node tests/electron/windows-smoke.mjs client` 对解压后的精确候选通过：自动启动 embedded PostgreSQL，
  真实 Colyseus SDK 建房，HTTP `/rooms` 可见该房间；关闭最后窗口后 Electron、内置 Node 与
  `postgres.exe` 的精确路径进程计数均为 0。冒烟同时确认 legacy `/api/rooms` 返回 404。
- Profile-only Next 进程会显式声明不期待 legacy WebSocket；健康报告只在旧 WS 确实未启动时通过，
  避免既关闭旧权威又被旧健康检查误判为不可用。
- `npm.cmd run check:main-baseline`：通过；HEAD 不落后上述 `origin/main`。
- `npm.cmd run check:encoding` 与 `git diff --check`：通过。
- `npm.cmd run test:postgres`：随包 PostgreSQL wrapper 启动真实实例并驱动原有 integration，通过；原有
  外部数据库入口在未配置 URL 时仍明确 skip，不将其误算为第二份证据。
- 仓库全量 `npm.cmd test`：175 files / 1914 tests 通过、PostgreSQL 1 file / 1 test 跳过；另有 1 个范围外
  Electron Editor 归档测试在全仓并行时读到临时零字节 JSON 而失败，随后单独复跑 1 file / 9 tests
  全部通过。该波动不修改 Editor 生产路径，不能替代 RED-161 自身候选门禁。

## 待完成门禁

- 从已构建 Electron 候选包完成双端动作、重连、普通 APPLIED 与终局 DURABLE 验收。
- 使用同一精确候选完成第二次复用、强制终止后的旧 roomId 恢复，以及外部 `RVB_POSTGRES_URL` 不启动
  embedded PostgreSQL 的候选回归。
- 更新 Draft PR 并确认最终 head 的 CI。

## 回退

整体回退 RED-161 分支。不要同时开放 legacy 与 Colyseus 两套玩家权威；PostgreSQL 数据可保留，
不需要破坏性删除。
