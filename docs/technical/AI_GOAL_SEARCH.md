# 通用目标路线搜索（RED-249）

状态：实现稿
协议：`GoalSearchResult` v1

`lib/game/ai-goal-search.ts` 提供一个只搜索当前玩家、当前回合的通用有界 BFS。它不认识卡牌、技能、费用或内容 ID。候选由 `AIEnvironment.listLegalActions()` 产生，状态由正式 `AIEnvironment.simulate()` 推进；默认环境是 `aiEnvironmentV1`，因此每一步都经过 `runBattleActionIsolated()`。

## 调用

```ts
const result = searchGoalRoute(state, 'player-red', {
  rootSeed: 0x8b0139,
  maxNodes: 256,
  maxDepth: 8,
  maxTimeMs: 2_000,
  goal: (nextState) => nextState.pieces.some(piece =>
    piece.templateId === 'kiljaedan'
    && piece.ownerPlayerId === 'player-red'
    && piece.currentHp > 0,
  ),
})
```

`goal` 是调用方提供的规则。可选 `progress` 返回有限数字，仅用于 `bestProgress` 前沿提示；它不会剪掉、排序掉或拒绝任何合法候选。BFS 按深度返回最短目标路线，候选以稳定候选 ID 和完整动作排序。所有去重都使用环境的完整 state key，不使用玩家投影 key。

目标搜索只沿着开始时的 `turn.turnNumber` 与 `turn.currentPlayerId` 展开。一个正式 pending option/target 只要仍属于该玩家并且回合没有改变，就可以作为下一步继续搜索；换玩家或换回合的 transition 会停止该分支。

## 结果与预算

结果的 `status` 是以下四种之一：

- `found`：返回 `route`、`firstAction`、最终 `state` 和最终 `stateKey`。
- `no-route`：在给定空间内完整耗尽，或开始状态没有该玩家回合/合法候选。它不表示搜索曾被预算截断。
- `budget-exhausted`：达到 `maxNodes`、`maxDepth` 或 `maxTimeMs`。被截断的搜索不能报告 `no-route`。
- `invalid-input`：状态、玩家、种子、边界、目标回调或环境执行契约无效。

`rootSeed`（或别名 `seed`）必须是 `0..2^32-1` 的安全整数。`maxNodes >= 1`、`maxDepth >= 0`、`maxTimeMs >= 0`。`maxNodes` 包含根节点，并同时限制 transition 调用次数，所以被接受的前沿状态不会超过节点预算；`simulationRejects` 与 `simulationErrors` 在统计中分开记录。权威拒绝会丢弃当前边并继续搜索，环境抛出的异常会保留在 `simulationErrorDetails`，最终以 `invalid-input` 返回，不能伪装成无解。

环境的动作枚举是同步调用。搜索可以在枚举调用前后检查墙钟，但不能中断已经开始的单次枚举；如果一次枚举跨过 `maxTimeMs`，结果是 `budget-exhausted`（`reason: "enumeration"`）。因此 Cloud 或 bot 调用方应给出足够预算，并保持每个离线状态的候选空间小而明确。

## 离线真实夹具与 CLI

`lib/ai-bot/offline-goal-fixture.ts` 的 `createOfflineDemonGoalFixture()` 通过官方地图、技能和卡牌仓库加载器构造一个小地图、己方安全锚点、公开敌方棋子、己方作用域的隐匿 Kiljaedan 和第一张恶魔卡。正式 runner 会依次发现并结算 `demon-summon-1..5`，费用为 `1+1+2+2+3=9`，总真实伤害为 `2+3+4+5+6=20`。夹具锚点初始生命为 30，最终应剩余 10，最后一步在唯一空地召唤 Kiljaedan。

离线命令不读取账号、密码、令牌、网络或 Cloud 环境：

```text
npm.cmd run ai:goal-search -- --help
npm.cmd run ai:goal-search -- --smoke --seed 9109817
npm.cmd run ai:goal-search -- --input battle-state.json --player player-red --seed 9109817 --goal kiljaedan
```

`--input` 必须是完整的离线 `BattleState` JSON。`--goal` 只是调用方的通用“仍存活的模板 ID”目标，搜索器本身不为任何真实卡牌加入特判。输出是单个 JSON 对象，包含种子、边界、结果、动作路线、首个动作、统计和可选的前沿提示；其中 `elapsedMs` 是本次运行的观测值，路线和状态 hash 在相同状态、种子与内容下应保持确定。

## 边界

隔离模拟返回的状态只供搜索读取，不能写回房间或权威存储。线上玩家提交仍需重新经过房间 authority/CAS。完整离线状态可能含离线测试授权的隐藏实例和种子；线上调用必须先经`createShadowState`白名单投影，不得提供对手隐藏手牌、真实服务器 RNG 或通用`extensions`。求解器不替代普通 AI 的默认策略，也不跨玩家回合规划。
