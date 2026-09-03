# RED-158 Phase F：Windows Colyseus/PostgreSQL 直接切换证据

- Linear：RED-158
- 风险：High
- base_branch：`main`
- base_sha：`efe712d08278592c548fce774a738b9a8207b0e5`
- latest_main_sync_sha：`de8b697150ade3de90b3c56a952a2d29306bdc44`
- 状态：实现与最新 main 同步完成；等待独立审查、空闲机器性能复测和两台 Windows 客户端人工验收
- 不在范围：Android、`relay-server/`、玩法数值、经济规则、随机算法

## 目标与最终决定

Windows 不兼容旧联机或旧 SQLite 数据。根产品只保留 Colyseus + PostgreSQL：删除 Prisma/SQLite、
raw WebSocket、自建同端口 Upgrade、旧 RoomStore、旧玩家 Next API、独立 Electron Server、旧战报 API、
localStorage 战绩和 authority feature flag。任何失败都显式失败，不回退旧路径。

## 问题复现

双人验收中可观察到：

1. 大厅调用 `rooms.get` 返回 `Unsupported Colyseus request: rooms.get`；
2. 创建一次出现两个同名、同地图、同人数的房间；
3. 加入先依赖房间列表预检，随后 `AbortSignal` 取消，用户只能看到 `signal is aborted without reason`；
4. 终局战报仍依赖旧 API、本地记录或旧数据库，无法证明 PostgreSQL DURABLE hash chain。

修改前回归测试 `tests/game/colyseus-lobby-client.test.ts` 的对应三项均失败。

## 实现证据

- `rooms.get` 走 Colyseus HTTP `GET /rooms/:roomId`；稳定返回单房间或 404。
- `rooms.action(join|rejoin)` 直接 `joinById`，成功后通过房间 RPC 读取快照，不以目录列表决定准入。
- 页面建房按钮和客户端请求双重单飞；每次创建携带 `creationKey`，服务端并发 claim 拒绝同一创建请求；
  `/rooms` 再按规范化 room ID 去重，避免目录重复展示。
- HTTP 超时/网络错误转换为 `COLYSEUS_HTTP_TIMEOUT` / `COLYSEUS_HTTP_UNAVAILABLE`，不再裸露浏览器
  `AbortSignal` 文本。
- 战斗命令始终要求 `clientActionId`、receipt、transition 和 authority persistence；删除
  `RVB_BATTLE_AUTHORITY_V2` 以及 metadata CAS 旧分支。
- `PostgresAuthorityRepository.readBattleReport()` 从 version-zero checkpoint 回放完整 transition，核对：
  protocol/build、连续版本、action hash、pre/post state/public hash、previous/transition hash、终局 checkpoint、
  receipt 和 terminal barrier。只有 online/durable 同版本且 terminal 才返回 verified report。
- 首页战绩和终局下载只调用 Colyseus HTTP battle report；不读取或写入本地旧战绩，不调用旧签名 API。
- `npm run check:windows-cutover` 对删除路径、直接依赖、raw WebSocket、Prisma、SQLite runtime、旧 authority
  开关和旧 RoomStore import 建立失败门禁。Colyseus 依赖树内部的传输依赖不等于项目自建 raw WS 入口。

## 自动验收结果

2026-09-01 在 `codex/RED-158-colyseus-windows-phase-f`、base
`efe712d08278592c548fce774a738b9a8207b0e5` 执行：

| 验证 | 结果 |
| --- | --- |
| `npm.cmd run check:main-baseline` | 通过；与 `origin/main` 同 SHA，ahead/behind 均为 0 |
| `npm.cmd run check:windows-cutover` | 通过；Windows player runtime 仅 Colyseus + PostgreSQL |
| `npm.cmd run typecheck` | 本次改动在合并前通过；合入最新 `origin/main` 后，被新引入的 `tests/game/sonic-roster.test.ts` 4 个类型错误阻塞 |
| RED-158/Windows 关键路径 ESLint | 通过；覆盖适配器、Colyseus room/server、PostgreSQL report、Electron main、打包冒烟和新增测试 |
| `npm.cmd run test:colyseus` | 5 文件、13 测试全部通过 |
| `npm.cmd run test:postgres` | 内置 PostgreSQL 集成 1 项通过；外部 `RVB_TEST_POSTGRES_URL` 1 项按环境跳过 |
| Windows/打包/embedded PostgreSQL 定向回归 | 7 文件、45 测试全部通过 |
| 页面、rejoin、Trace/targeting 定向回归 | 5 文件、55 测试全部通过 |
| `npm.cmd test -- --maxWorkers=1 --reporter=dot` | 159 文件通过、1 文件按环境跳过；1758 测试通过、1 测试跳过 |
| `npm.cmd run build:electron:client` | 通过；生产 Next、Colyseus bundle、PostgreSQL 16.15-2、Electron package 和资源验证均完成 |
| `node tests/electron/windows-smoke.mjs client` | 通过；见下方打包候选证据 |
| `npm.cmd ls prisma @prisma/client @prisma/engines --all` | 空；工作区无 Prisma 包 |

全仓 `npm.cmd run lint` 仍被仓库既有 suppressions/测试 lint 债务阻塞；任务关键路径单独 ESLint 已通过，
且构建生成目录已加入 lint ignore。没有把既有 `any` 债务批量改写或加入新 suppressions 来掩盖失败。

## 2026-09-03 最新 main 同步验证

刷新 `origin/main` 后，本分支从旧基线落后 66 个提交。为避免改写已经发布到 PR 的历史，将
`de8b697150ade3de90b3c56a952a2d29306bdc44` 合并进 RED-158 分支，并按最终切换合同解决冲突：保留
Colyseus 原生重连、PostgreSQL authority、建房 `creationKey` 单飞和最新 main 的战斗表现/UI；没有恢复
`instrumentation.ts`、raw WebSocket、Prisma/SQLite 或旧玩家 API。同步后的增量修复还删除了选将页残留的
`RvBWs.waitForConnection` 分支，并让页面合同测试兼容 Windows CRLF。

| 验证 | 结果 |
| --- | --- |
| `npm.cmd run check:windows-cutover` | 通过；删除路径、依赖、旧开关和玩家 raw WebSocket 门禁均通过 |
| `npm.cmd run typecheck` | RED-158 修改无新增错误；最新 `origin/main` 的 `tests/game/sonic-roster.test.ts` 仍有 4 个既存类型错误 |
| `npm.cmd run check:encoding` / `git diff --check` | 通过 |
| RED-158 关键路径 ESLint（空 suppressions） | 20 个客户端、Colyseus、PostgreSQL、门禁和回归测试文件通过 |
| RED-158/RED-170 定向回归 | 11 文件、115 测试全部通过；含大厅、建房去重、rejoin、100 次断线重连、receipt、页面与 pool 生命周期 |
| `npm.cmd run test:postgres -- --maxWorkers=1 --reporter=dot` | 内置 PostgreSQL 1 项通过；外部 URL 1 项按环境跳过 |
| `npm.cmd run build:colyseus` | 通过 |
| `npm.cmd run build:electron:client` | 通过；Next、Colyseus bundle、PostgreSQL 16.15-2、Electron package 与资源验证完成 |
| `node tests/electron/windows-smoke.mjs client` | 通过；真实启动候选并验证单飞建房、双 client 入房、旧 API 404、资源一致和零残留进程 |
| `npm.cmd ls prisma @prisma/client @prisma/engines --all` | 空；无 Prisma 包 |

全量测试本次执行结果为 174 文件中 167 通过、1 跳过、6 文件失败（1884 通过、1 跳过、7 失败）。逐项收敛后：

- RED-158 合并产生的页面顺序断言已修复，定向 3/3 通过；
- AI environment 的 5 秒超时在隔离重跑时 1/1 通过；
- 4 项内容/表现基线失败的测试与被测文件相对 `origin/main` 均为零 diff，属于当前 main 的既有基线漂移，
  本任务不修改这些范围；
- Colyseus 20+ action 延迟门槛在主机 CPU 100% 时重复失败：最近一次 server P95 115.123ms、P99
  164.899ms，client P95 158.267ms、P99 214.674ms。没有放宽门槛；候选请求 QA 前必须在空闲机器上重跑
  `npm.cmd run test:colyseus -- --maxWorkers=1 --reporter=dot` 并满足 P95/P99 合同。

因此，功能切换、持久化、打包和进程 smoke 证据已更新到最新 main；性能候选门禁仍明确标记为待复测，
不能用 2026-09-01 的旧基线结果替代。

## 打包候选双客户端证据

Windows smoke 从 `dist/client-build/win-unpacked` 复制隔离候选并真实启动 Electron、Node、内置 PostgreSQL 和
Colyseus：

- 相同 `creationKey` 的两个并发建房请求结果为 1 fulfilled、1 rejected；
- `GET /rooms` 中目标 room ID 恰好出现一次；
- 第二个 Colyseus client 通过 `joinById` 加入同一 room ID；房间详情包含 host/guest 两名玩家；
- 旧玩家 REST 返回 404；Profile/content hash 在本地服务与 authority 间一致；
- 退出后 Electron、Node、PostgreSQL 残留进程均为 0；
- 安装包资源中不存在 Prisma/SQLite runtime；Colyseus 官方 transport 作为框架内部实现保留。

外部 PostgreSQL URL 未提供，所以外部数据库用例明确记为 skipped；打包候选使用的内置 PostgreSQL
初始化、持久化、崩溃探测、journal recovery 和 terminal barrier 均已执行通过。

## 2026-09-03 人工验收反馈

- 动作历史原先只从当前 `model.pieces` 解析目标。死亡棋子从后续快照移除后，死亡事件仍有
  `targetPieceIds`，但目标名称与头像会被渲染为空。动作历史现在保留本局已经公开的棋子显示信息；收到
  `death` 事件后继续显示目标，并以灰度头像和“已死亡”标记明确状态。回归测试先稳定复现失败，修复后
  `tests/ui/battle-action-history.test.ts` 13/13 通过。
- 截图中的战绩加载状态不是 PostgreSQL 进程退出：实包 PostgreSQL、Colyseus 和 Next 进程均在运行，
  `/battle-reports` 直接探测返回 200 与空结果。5 秒进程采样时整机负载为 100%，PostgreSQL 约占总 CPU
  0.5%，主要负载来自其他 Chrome/Node 进程；因此本次可见掉帧不能归因于 PostgreSQL。
- 饱和主机上 `pg_isready` 实测为 0.55–2.42 秒，而当前健康探针超时为 1 秒，所以 authority 日志会出现
  `degraded` 后又恢复 `healthy` 的假阳性。进一步人工验收期间，`postgres.log` 与超时逐项对应地记录了
  `An existing connection was forcibly closed by the remote host`，并出现一次 Windows error 487 的共享内存
  分配失败；同一时段本机启动一个 Node 命令也延迟约 40 秒。运行期健康检查现改为读取应用私有 cluster 的
  `postmaster.pid` 并用 OS 进程存活检查，不再每秒拉起 `pg_isready.exe` 或创建探针连接；启动阶段仍保留
  `pg_isready`，真实 owner 消失仍在 2 秒 cadence 下失败关闭。
- 动作简介技能项宽 164px，而未展开 rail 的 CSS Grid 轨道会按内容扩为 164px，从右边界向窗口外延伸，
  造成只剩灰暗卡片左缘、图标与文案位于视口外。未展开列表现固定为 52px 轨道并保持 item end-aligned，
  Playwright 在 1584×990 下测得 item `left=1420`、`right=1584`、`width=164`，内容完整向左展开。
- 首页摘要和战绩弹窗会重复触发同一份 PostgreSQL verified report 全量回放。页面现在按
  `server origin + playerId` 对成功结果做本页缓存，并合并并发请求；摘要成功后打开弹窗不再重复执行昂贵
  校验，切换服务器或账号仍会读取独立数据。错误态新增 44px “重试”按钮并保留显式失败，不回退本地战绩。
  Playwright 行为验证：两次并发加一次后续读取只发出 1 次请求，切换玩家后总请求数变为 2。
- 简体中文 Windows 首次初始化还稳定复现了 `initdb` 无法为 `Chinese (Simplified)_China.936` 选择文本搜索
  配置。新建私有 cluster 现固定 `UTF8 + C locale`，并将只用于首次 `initdb` 的预算从 30 秒提高为 90 秒；
  已有 cluster 不重建、不迁移。真实 PostgreSQL 用例验证 `datctype=C`、loopback/SCRAM、重启持久化和崩溃
  探测全部通过。
- 提交 `90080b1` 的实包在 14:55 再次复现：PostgreSQL 14:55:09 已 ready，但 Colyseus 加载资源约 14 秒后，
  `initializeSchema()` 被连接池 2 秒预算中断；自动恢复随后每次只等待 5 秒，早于资源加载完成便杀死仍在启动
  的 authority，三次后进入 manual-required。修复后单次 PostgreSQL 连接预算为 30 秒，瞬时连接类错误最多
  进行 5 次指数退避重试，Electron 初始与恢复就绪 watchdog 统一为 240 秒；认证、schema 与完整性错误不重试。
  战绩错误态的“重试”在本机模式下会先通过受信任 IPC 重新激活 authority 恢复预算，ready 后再读取战报；
  远程模式不会启动本机服务。
- 提交 `c4e6ae4` 的实包在 16:01 验收时，内置 PostgreSQL 已于 16:01:19 ready，authority 也于 16:01:27
  成功监听；失败来自数据库内两局旧记录的 `public hash mismatch`。此前 `listBattleReports()` 用
  `Promise.all` 全量验证，一条旧坏记录会让整个列表失败，重复读取必然得到相同错误。列表现按单局隔离
  `BATTLE_REPORT_INTEGRITY_FAILED` / `BATTLE_REPORT_NOT_DURABLE`，保留原始数据库记录并写结构化错误日志，
  只返回验证通过的战报；直接读取损坏战报仍 fail closed，数据库运行故障仍向上抛出。桌面重试同时改为按
  实际目标 URL 判断是否为本机 authority，并在恢复后同步当前端口，不再依赖可能过期的 mode 标记。

浏览器证据：

- [动作简介右边界](../../output/playwright/red-158-action-history-edge.png)
- [战绩失败与重试状态](../../output/playwright/red-158-records-error-retry.png)

本轮修复后的自动验证：

| 验证 | 结果 |
| --- | --- |
| `tests/electron/embedded-postgres.test.ts` | 6/6 通过；含真实 Windows PostgreSQL 首次初始化、重启持久化和崩溃探测 |
| `tests/integration/postgres` | 内置 PostgreSQL 集成 1 项通过；外部 URL 1 项按环境跳过 |
| 启动恢复定向回归 | 3 文件、25/25 通过；覆盖瞬时 PostgreSQL 重试、永久错误立即失败、240 秒统一 watchdog 与 UI 恢复入口 |
| `tests/colyseus/product-room.test.ts` + PostgreSQL pool lifecycle | 2 文件、8/8 通过 |
| 动作历史与首页战绩 UI 回归 | 2 文件、18/18 通过 |
| `npm.cmd run typecheck` | 通过 |
| 关键路径 ESLint | 本次新增代码无新告警；仍有既存 `electron-client/main.ts:1966 openConnectWindow` 未使用错误，不在本次范围内 |
| `check:windows-cutover` / `check:encoding` / `git diff --check` | 通过 |
| `npm.cmd run build:electron:client` | 通过；PostgreSQL 16.15-2、79 个页面资源、333 个离线数据资源与 46 个离线图片资源校验通过 |
| `node tests/electron/windows-smoke.mjs client` | 通过；含私有 PostgreSQL、authority 三次有界自动恢复、显式手动恢复、双玩家房间与退出后进程清理 |
| 损坏战报隔离回归 | 修改前 PostgreSQL 集成与首页用例均稳定失败；修复后真实 PostgreSQL 1 项通过/外部 URL 1 项跳过，相关 Colyseus/UI 3 文件 14/14 通过 |

整机采样为 CPU 98.8%、约 2 GiB 可用内存时，完整 `test:colyseus` 的 22 项中有 9 项越过既存
5–60 秒测试等待门限；相同的 product-room 与 PostgreSQL lifecycle 测试隔离运行后 8/8 通过。这一结果
作为慢机器压力证据保留，不把完整套件记为通过，也不通过放宽游戏行为断言掩盖超时。

## 两台 Windows 人工验收（阻塞最终产品验收）

1. A 开服，A/B 同时进入大厅；连续刷新 10 次，房间目录无重复。
2. A 快速双击创建或在请求中重复点击，只产生一个房间；B 可见同一 room ID。
3. B 点击加入后正常入座，A/B 均进入选将；不得出现 `Unsupported ... rooms.get` 或 AbortSignal 文本。
4. 双方完成选将并执行至少 20 条命令；断开/重连一次，authority version/hash 连续。
5. 完成终局；页面显示 PostgreSQL authority report 已验证且 DURABLE，可下载
   `rvb-postgres-battle-report/v1`。
6. 人工抽查报告包含两名玩家、终局 checkpoint、完整 transitions/receipts、Trace/replay frames 和 64 位
   hash；修改任一 transition JSON 后测试读取必须 fail closed。
7. 关闭重启 Windows 客户端后，可从 PostgreSQL 查询终局战报；不得出现本地旧战绩回退。

## 回退

代码回退只允许整体 revert RED-158 Phase F 分支/PR，然后停止该候选。不得在同一候选中重新启用
Prisma/SQLite、raw WebSocket、旧 API、双写或兼容开关。PostgreSQL 数据删除或降级不属于本任务授权；
若候选失败，保留数据库和日志作为诊断证据。
