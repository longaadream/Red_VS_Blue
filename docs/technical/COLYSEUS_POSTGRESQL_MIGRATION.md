# Windows Colyseus + PostgreSQL 直接切换

更新：2026-09-01（RED-158 Phase F）

## 决策

Windows 在公开测试前直接切换到 Colyseus + PostgreSQL，不导入旧对局数据，也不提供运行时兼容、
双写、探测或降级分支。Android 与独立 Relay 保持任务外现状，不能作为 Windows 回退。

## 当前唯一映射

| 能力 | 当前实现 |
| --- | --- |
| 玩家准入与房间 | Colyseus MatchMaker / BattleRoom |
| 玩家页面适配 | `data/pages/js/colyseus-client.js` + Colyseus SDK |
| 房间目录 | Colyseus authority 的 `/rooms` 与 `/rooms/:roomId` |
| 规则执行 | `dispatchRoomBattleAction()` + Battle Runner |
| 房间并发 | 每 roomId 独立 FIFO 和 Rule Runtime |
| 权威持久化 | PostgreSQL Authority Journal/Repository |
| 终局与战报 | Terminal Barrier + PostgreSQL verified battle report |
| Windows 本机开服 | Electron Client 按需启动私有 PostgreSQL 与 Colyseus |

## 迁移不变量

1. BattleRoom 是玩家写命令的唯一入口。
2. 同一 `creationKey` 只创建一个房间；目录按规范化 roomId 去重。
3. 加入已知房间直接使用 `joinById`，不依赖目录预检。
4. 初始 Checkpoint 成功后才能进入 `in-progress`。
5. authority version、Transition、Receipt 和 hash 链连续。
6. ACK 前 journal 接受并验证完整转换；失败不得发布 speculative 状态。
7. 终局必须完成 durable drain 与 Terminal Barrier。
8. 战报必须从初始 Checkpoint 完整重放并验证 Trace/Replay/hash。
9. Windows 包只发布 Electron Client；本机 PostgreSQL 只绑定 loopback。
10. 生产页面不保存或生成另一份权威房间/战报状态。

## PostgreSQL 边界

Repository 按 battleId 维护连续前缀。一个事务写入关联的 Transition、Receipt 和必要 Checkpoint；
不同房间可以由 PostgreSQL 连接池并行。恢复和战报读取均验证：

- 协议与 authority build；
- version/fromVersion/toVersion 连续性；
- clientActionId 与 receipt 唯一关联；
- action、内部状态、公开状态与 transition SHA-256 链；
- Checkpoint 与重放结果一致；
- 终局 Trace、Replay Frames、Terminal Barrier 完整。

损坏、缺号、hash 不一致或不完整终局均失败关闭。

## Windows 部署

Electron Client 包含已验证 manifest 的 PostgreSQL runtime。首次本机开服时在 Electron userData 下创建
应用私有 cluster、随机 SCRAM 凭据和数据库；PostgreSQL 只监听 loopback。随后启动打包的 Colyseus bundle，
通过 `RVB_POSTGRES_URL` 接收会话连接信息。退出时先关闭房间 ingress、排空 journal 和 Colyseus，再停止
PostgreSQL；超时只能作为显式失败记录，不能假装 durable。

## 验收门禁

```powershell
npm.cmd run check:windows-cutover
npm.cmd run typecheck
npm.cmd run test:colyseus
npm.cmd run test:postgres
npm.cmd run build:electron:client
node tests/electron/windows-smoke.mjs client
```

还需两台 Windows 完成建房唯一性、直接加入、双向动作、终局战报、退出与重启恢复验收。High Risk 任务
需要独立审查和人工批准；自动测试与打包成功不代替最终体验验收。

## 回退

只允许整版回退到已知候选；不得在同一运行中切换 authority 或数据库。PostgreSQL 数据目录不自动删除，
也不由旧 binary 打开。删除或迁移真实数据必须另行批准并验证精确路径。
