# 游戏逻辑系统接口与执行流程

更新：2026-09-03（RED-158 Phase F 主线同步）

## 1. 核心结论

1. `applyBattleAction()` 是规则归约入口；`runBattleAction()` 负责确定性、hash、幂等和 Trace。
2. 所有 Windows 在线命令进入 Colyseus BattleRoom，再进入 `dispatchRoomBattleAction()`。
3. 每个房间拥有独立 FIFO 和 Rule Runtime；不同房间可并行。
4. PostgreSQL 保存权威连续历史和终局证据。
5. 浏览器只发送意图、显示服务端投影，不执行在线共享规则。
6. 战报由 PostgreSQL journal 重放验证生成，不以客户端记录为真源。

Android 与独立 Relay 的当前实现不属于此 Windows 接口合同。

## 2. 执行流程

```text
UI action draft
  → RvBColyseus
  → Colyseus BattleRoom admission
  → room authority FIFO
  → dispatchRoomBattleAction
  → Battle Runner / Reducer / Trigger Runtime
  → receipt + transition + trace/hash evidence
  ├→ Colyseus public state and APPLIED receipt
  └→ PostgreSQL authority journal → DURABLE watermark
```

准入先验证 room/player、座位、Profile/content hash、协议、build 和 expected authority version。规则失败、
签名/身份失败或版本失败只产生拒绝，不得写 Transition 或改变房间状态。

## 3. Command/Receipt/Transition

Command envelope 包含：battleId、playerId、clientActionId、expectedAuthorityVersion、协议/build 和 action。
相同 clientActionId 幂等；不同动作复用同一 ID 稳定拒绝。

成功 receipt 绑定 action ID、authority version 和 transition。Transition 绑定 from/to version、动作 hash、
前后内部/公开 state hash、receipt 和上一条 transition hash。所有字段均使用 canonical JSON 计算。

客户端只接受连续版本。缺口或 hash 不一致时停止提交，并通过 Colyseus 房间状态恢复。

## 4. 状态投影

内部 `BattleState` 可包含私有部署候选、pending 选择、完整 Trace 和规则调试信息。发送给客户端前通过
`createPublicBattleSnapshot()` 按 viewer 投影：

- 当前输入 owner 可见自己的精确候选与合法落点；
- 对手和观战者只见公开等待状态与数量；
- debug Trace 不进入进行中对局公开状态；
- 终局 Trace 只通过 verified report/terminal evidence 暴露。

## 5. 渐进部署

Demo 开局为双方各一个确定性随机先锋，其余普通核心进入预备区。自己的成长回合开始时，若预备区非空，
服务端生成至多三枚候选和安全格。`deployReservePiece` 必须携带精确 deployment revision。

部署、after-summon 触发、终局检查、免费首移标记和回合推进在一个规则转换内完成。版本过期、候选外棋子、
非法格或错误玩家在随机消费和状态写入前拒绝。

## 6. 目标、选择和触发器

`prepareAction()` 返回声明式 option/target 候选；UI 不执行技能代码来猜候选。最终提交携带选择凭证，
归约器再次验证。

触发器按房间运行时执行并记录 event chain。异常、预算溢出、无效 EffectChain 或不可序列化结果导致整个
动作回滚，规则 limits/pending/cache 也恢复到动作前。

## 7. 计时器和机器人

权威时钟由服务端注入。正常回合时长按完整轮次为 90/120/150/180/210 秒，快速回合为 40 秒，
回合外 pending 响应窗口为 30 秒，最后 15 秒进入烧绳。计时同步、烧绳、超时和机器人命令与玩家动作进入同一房间 FIFO。玩家动作与
超时竞争时只有一个版本提交；失败的 speculative 结果不能广播。

客户端只显示公开 deadline/serverNow，不拥有超时授权，也不能通过刷新延长时间。

## 8. 表现事件边界

`battle-presentation-events.ts` 在成功权威命令后生成按查看者投影的动作事件；动作历史和小剧场只消费
这些投影。历史高亮、播放速度、弹道/范围演出和缺失资源兜底不进入 `BattleState`、hash、journal 或
规则判断，也不发送新的玩家意图。

## 9. 终局与战报

`finalizeBattleTerminal()` 生成唯一 `terminalResult`。终局转换必须进入 PostgreSQL，并在 journal drain 后写
Terminal Barrier。`readBattleReport()` 随后从初始 Checkpoint 重放全部转换，验证：

- 版本和 receipt 连续；
- action、state/public、transition hash；
- Checkpoint 与重放状态；
- Trace、Replay Frame、终局和 durable barrier。

任何一项失败都不返回报告。

## 10. 失败语义

| 层 | 失败处理 | 必要证据 |
| --- | --- | --- |
| Colyseus 准入 | 拒绝加入/命令 | room/player、Profile/build/protocol |
| Targeting/Reducer | 拒绝且不修改状态 | action、phase、turn、selection revision |
| Runner | 回滚 state/runtime/cursor | seed、stream/cursor、pre hash、actionId |
| FIFO/协调器 | 不发布 speculative 版本 | from/to version、queue depth、receipt |
| PostgreSQL | 房间不可标记 durable | transaction、battleId、version、hash |
| 战报 | 失败关闭 | 第一处断链/篡改/缺失 barrier |
| 浏览器 | 停止提交并显示稳定错误 | authority origin、roomId、最后版本 |

## 11. 源码索引

| 主题 | 入口 |
| --- | --- |
| 规则归约 | `lib/game/turn.ts` |
| Runner/Trace | `lib/game/battle-runner.ts`、`battle-trace.ts` |
| 房间协调 | `lib/game/room-battle-actions.ts` |
| FIFO/运行时 | `room-authority-queue.ts`、`room-rule-runtime.ts` |
| 目标/空间 | `targeting.ts`、`spatial.ts` |
| 终局/计时 | `terminal.ts`、`turn-timer.ts` |
| Colyseus 房间 | `lib/server/colyseus/battle-room.ts` |
| 目录/报告 HTTP | `lib/server/colyseus/create-colyseus-server.ts` |
| PostgreSQL | `lib/server/postgres/**` |
| 页面适配 | `data/pages/js/colyseus-client.js` |
| 战斗页面 | `data/pages/battle.html` |

## 12. 验证

最小回归依次运行 Colyseus client/room 测试、规则相关测试、PostgreSQL 集成、类型检查、Windows 打包与
双客户端人工验收。测试命令和完整步骤见 [BUILD_AND_RUN.md](./BUILD_AND_RUN.md)。
