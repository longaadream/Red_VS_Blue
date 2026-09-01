# 模块接口地图

更新：2026-09-01（RED-158 Phase F）

本文只描述 Windows 当前接口。玩家联机权威由 Colyseus 承载，耐久数据由 PostgreSQL 承载；
Android 与独立 Relay 不在本次 Windows 迁移合同内。

## 1. Windows 运行边界

| 边界 | 入口 | 合同 |
| --- | --- | --- |
| Windows 宿主 | `electron-client/main.ts` | Profile HTTP 服务随应用启动；创建本机房间时按需启动嵌入式 PostgreSQL 与 Colyseus |
| 页面联机适配 | `data/pages/js/colyseus-client.js` | 只使用 Colyseus SDK 和同源 HTTP；房间加入直接调用 `joinById` |
| 房间权威 | `lib/server/colyseus/battle-room.ts` | BattleRoom 是玩家命令、房间状态与重连恢复的唯一在线入口 |
| 房间目录 | `lib/server/colyseus/create-colyseus-server.ts` | `GET /rooms` 返回去重目录；`GET /rooms/:roomId` 精确读取单个房间 |
| 耐久权威 | `lib/server/postgres/postgres-authority-repository.ts` | 连续 Transition、Receipt、Checkpoint、Terminal Barrier 与 Trace 只写 PostgreSQL |
| 战报 | `GET /battle-reports/:battleId`、`GET /battle-reports?playerId=` | 只返回通过完整链验证的 durable 战报 |

客户端只保存一个规范化的 authority origin。`GET /healthz` 必须返回
`{ ok: true, protocol: "rvb-colyseus" }` 才可用于连接或 LAN 发现。目录、单房间查询和战报使用
该 origin 的 HTTP；房间加入和消息使用同一 Colyseus endpoint。客户端不得猜测第二端口，也不得在失败时
切换到其他房间协议。

建房必须带稳定 `creationKey`。页面和适配器都执行单飞；服务端在 claim TTL 内只允许同一 key 创建一个
房间。目录按规范化 roomId 去重，因此一次点击只能出现一个可加入房间。

## 2. 房间模型与生命周期

- 共享类型：`lib/game/room-model.ts`。
- Colyseus 候选状态：`lib/server/colyseus/candidate-battle-store.ts`。
- 产品持久化适配：`lib/server/colyseus/product-battle-store.ts`。
- 房间创建、座位、阵营、阵容锁定、地图冻结和开战都由 BattleRoom/候选存储协调。
- 房间状态使用独立的 `version`；战斗连续版本使用 `battleAuthorityVersion`。传输 patch 只能使用后者。
- 对局座位 `seat: red | blue`、内容阵营 `alignment: light | dark`、棋子
  `ownerPlayerId` 与先手 `firstPlayerId` 是独立字段；敌我只按 `ownerPlayerId` 判断。
- 终局后先完成 journal drain 与 Terminal Barrier，再允许返回 durable 战报。

PVP Demo 阵容由 `lib/game/roster-contract.ts` 校验：玩家必须从已锁定 alignment 中提交 8 个不同、
已准入且存在的模板。服务端写入 `rosterLocked` 与 `rosterManifestVersion`；不同内容的重复提交稳定拒绝。

## 3. Colyseus 命令协议

- 消息定义：`lib/server/colyseus/battle-room-protocol.ts`。
- 玩家命令统一使用当前 command envelope，包含 battleId、playerId、clientActionId、
  expectedAuthorityVersion、协议版本和 authority build。
- BattleRoom 拒绝未入座玩家、错误 Profile、错误 build、错误版本和非法动作；拒绝不得污染状态、hash、
  receipt 连续性或随机 cursor。
- 重复 clientActionId 返回同一 receipt，不重复结算。
- 版本落后返回 resync 所需信息；版本超前或链不连续时失败关闭。
- 公共状态、部署候选和 pending selection 按 viewer 投影；私有候选只发给当前输入 owner。

客户端收到 receipt/transition 后验证连续版本和公开 hash。失配时请求 Colyseus 完整状态恢复，不调用
HTTP 战斗命令或本地规则来补算在线状态。

## 4. 权威规则执行

- 归约入口：`lib/game/turn.ts::applyBattleAction()`。
- 命令协调：`lib/game/room-battle-actions.ts::dispatchRoomBattleAction()`。
- 房间 FIFO：`lib/game/room-authority-queue.ts`。
- 房间规则运行时：`lib/game/room-rule-runtime.ts`。
- 规则封装与 Trace：`lib/game/battle-runner.ts`、`lib/game/battle-trace.ts`。

同一房间的玩家动作、pending、计时器和机器人命令严格串行；不同房间互不共享队列或规则运行时。
成功动作必须在一个权威转换中产生下一状态、action hash、state hash、transition hash、receipt 和 Trace。
失败动作只产生拒绝 receipt，不能改变权威版本。

随机行为使用显式 root seed 和命名流。相同初态、seed、协议/build 与动作序列必须得到相同状态和 hash。
时间、随机和规则缓存通过房间运行时注入，在线路径不得使用页面时钟或视觉随机。

## 5. PostgreSQL Journal

- Journal：`lib/server/postgres/postgres-authority-journal.ts`。
- Repository：`lib/server/postgres/postgres-authority-repository.ts`。
- Schema/类型：`lib/server/postgres/authority-types.ts`。

初始 Checkpoint 是进入 `in-progress` 的前置条件。每次动作在 ACK 前进入有界 journal，并以 PostgreSQL
事务写入连续 Transition 与 Receipt；换回合、固定间隔和终局建立 Checkpoint。终局写入 Trace、Replay
Frames 与 Terminal Barrier，随后 drain 确认 durable 水位。

Repository 恢复时验证：

1. 协议版本和 authority build；
2. 版本连续性与 receipt/action 关联；
3. action、内部状态、公开状态和 transition 的 SHA-256 链；
4. Checkpoint 与重放所得状态一致；
5. 终局 Trace、Replay Frames 和 Terminal Barrier 完整。

任何缺口、篡改、重复版本、错误 hash 或不完整终局都失败关闭，不返回可用战报。

## 6. Trace、回放与战报

`rvb-match-trace/v2` 记录脱敏初始检查点、成功命令后的事实状态帧、语义事件、随机流和 hash 链。
Trace 与 PostgreSQL journal 使用同一权威状态/hash，不由 UI 重新生成。

`readBattleReport()` 从初始 Checkpoint 重放连续 Transition，并验证 receipt、Trace、Replay Frame 和终局
屏障；只有全部验证通过才返回报告。`listBattleReports(playerId)` 只列出该玩家参与且可验证的报告。

战报页面通过 Colyseus authority origin 的 HTTP 读取报告。浏览器不保存一份可冒充权威的本地战报，
也不在读取失败时展示未经验证的缓存记录。SHA-256 提供完整性与可回放证据，不提供内容加密。

## 7. 战斗 UI

- 入口：`data/pages/battle.html`。
- 联机状态由 `RvBColyseus` 维护；页面只发送声明式动作并渲染服务端公开投影。
- UI 不执行在线对局核心规则，不重算终局，不补造 receipt/transition/Trace。
- 版本或 hash 不匹配时停止提交并触发完整状态恢复。
- 训练模式可以使用浏览器规则引擎，但不得把训练状态写入在线权威或战报。

## 8. 渐进部署与回合计时

渐进部署由 `dispatchRoomBattleAction()` 协调。部署候选携带精确 revision；过期、缺失或非安全整数的
revision 在复制、随机和写状态前拒绝。候选与合法落点只投影给当前玩家，实际部署结果才进入公开状态。

`lib/game/turn-timer.ts` 定义可注入的权威时钟。计时器事件与玩家命令进入同一房间 FIFO；烧绳与超时
只能由服务端生成。客户端只显示 `serverNow` 与公开期限，刷新或重连不能延长期限。

## 9. Profile 与内容身份

Profile 服务只提供 HTTP 身份和内容端点。Colyseus 建房/加入会校验 resolvedProfileHash、
authorityContentHash、engine ABI 与 content ABI。身份不一致时拒绝准入，不创建降级房间。

Windows 本机 authority 的 PostgreSQL 数据目录、连接凭据和端口由 Electron 生命周期管理。凭据只通过
受控子进程环境传递，日志与诊断输出必须移除 URL 用户名、密码、query 和 fragment。

## 10. 验证入口

- 静态迁移门禁：`npm.cmd run check:windows-cutover`。
- Colyseus 回归：`npm.cmd run test:colyseus`。
- PostgreSQL 集成：设置 `RVB_TEST_POSTGRES_URL` 后运行 `npm.cmd run test:postgres`。
- Windows 客户端构建：`npm.cmd run build:electron:client`。
- Windows 冒烟：`node tests/electron/windows-smoke.mjs client`。

详细验收证据见 `docs/qa/RED-158-colyseus-postgresql-windows-cutover.md`。
