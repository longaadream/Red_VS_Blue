# 无头确定性 AI 战斗环境接口

状态：RED-84 实现稿
协议版本：`1`

## 1. 边界

入口为 `lib/game/ai-environment.ts::aiEnvironmentV1`，类型位于 `lib/game/ai-types.ts`。同一实现从 `lib/game/engine-browser-entry.ts` 导出到 canonical browser bundle。

环境是规则核心的只读/隔离消费者：

- 不创建或保存房间；
- 不广播状态；
- 不读取网络、DOM、数据库或墙上时间；
- 不实现战术、评分、搜索、训练或难度；
- 不替代权威提交。调用方选择候选后，正式对局仍通过房间命令服务提交。

## 2. 公共接口

```ts
interface AIEnvironment {
  protocolVersion: 1
  capabilities: AIEnvironmentCapabilities
  observe(state: BattleState, playerId: string): AIObservation
  listLegalActions(state: BattleState, playerId: string): CandidateAction[]
  simulate(
    state: BattleState,
    action: CandidateAction | BattleAction,
    context?: { rootSeed?: number },
  ): TransitionResult
  isTerminal(state: BattleState): boolean
  stateKey(state: BattleState, scope: { kind: 'full' } | { kind: 'player'; playerId: string }): string
}
```

`CandidateAction.action` 是完整 `BattleAction`，可以直接交给正式 runner。`CandidateAction.id` 只用于稳定去重，不是网络 request ID、签名或幂等提交 ID。

## 3. Observation 权限

玩家 observation 包含公开地图、棋子公开属性、可见 statusTag、回合、公开资源、弃牌、手牌数量、自己的完整手牌和属于自己的 pending 选择。

明确移除：

- 对手卡牌 ID、实例 ID、描述和费用；
- `visible: false` 的 statusTag；
- 棋子/玩家 Rule、`effect` 函数和动态代码；
- `skillsById` 运行时定义缓存；
- `extensions` 与 `extensions.debugBattle`；
- 未完成部署的具体 choice；
- 其他玩家 pending option/target 的候选、续接代码、payload 和 trigger queue；
- 战斗动作日志。

`stateKey(..., { kind: 'player' })` 对该投影做稳定 hash；`kind: 'full'` 使用正式权威状态 hash。评分器不得从 player key 反推或读取完整状态。

## 4. 候选枚举

候选来源：

| 类别 | 权威来源 |
| --- | --- |
| 部署选择/锁定 | `BattleState.deployment` 的玩家、锁和存活核心棋子不变量 |
| 阶段推进 | 当前玩家与 `turn.phase` |
| 普通移动 | `getLegalNormalMoveTargetsForPlayer()` |
| 基础/充能技能 | 棋子技能实例、正式技能定义、`prepareAction()` |
| 卡牌 | 当前玩家手牌、正式卡牌定义、`prepareAction()` |
| pending option/target | 当前版本化 pending session；target 逐个调用正式 pending validator |
| endTurn | 当前行动玩家的正式命令 |

多阶段技能/卡牌不会返回半成品。环境递归消费 `needOption` / `needTarget`，在每一步携带相同的 `selectionId` 和 `stateRevision`，直到 `prepareAction()` 返回 `ready`。空候选不发明 fallback；超过 16 个选择步骤以 `AI_ENV_SELECTION_DEPTH_EXCEEDED` 失败关闭。

排序先使用固定类别 rank，再使用完整动作的 stable JSON。option 按 value 的 stable JSON 排序，target 按 `piece:<id>` 或 `cell:<x>,<y>` 排序。

v1 unsupported 清单：

- `deploymentTimeout`：权威规则时钟命令；
- `grantChargePoints`：管理员/调试命令；
- `surrender`：比赛控制命令，不进入战术搜索。

## 5. 隔离模拟与证据

`simulate()` 要求 `context.rootSeed` 或初始化 Action Trace 中已有 root seed。它调用 `runBattleActionIsolated()`；后者使用正式 `runBattleAction()`，并在同步 `finally` 中恢复 TriggerSystem 的规则注册表和事件 ID cursor。

成功结果：

- 新的隔离 `BattleState`；
- 正式 `stateHash`；
- 稳定 `transitionHash`；
- 正式 `BattleActionTrace`；
- 本动作新增的 `BattleActionLog`；
- 排除 `skillsById` 和 debug trace 后的逐路径状态 diff。

失败结果保留原状态引用与原 state hash，返回稳定 code/name/message、确定性上下文以及空状态 diff。失败不会推进调用方随机 checkpoint、TriggerSystem registry 或 Action Trace。

`transitionHash` 比较协议版本、接受/拒绝、完整动作、前后 hash、错误和结构化 trace。它用于重放/训练样本对账，不是安全签名。

## 6. 已知限制

- TriggerSystem 仍是进程级同步对象；环境不支持在规则执行中跨 `await`。
- v1 枚举完整多阶段组合，未设置候选上限或缓存。大地图/高分支性能只记录实测基线。
- 环境不枚举投降、超时和调试资源注入；上层比赛控制器仍可直接调用正式命令入口。
- v1 不定义 Utility、动作特征、机制语义向量或 observation tensor；这些属于 RED-85 及后续 AI 任务。

## 7. 最小调用示例

```ts
const observation = aiEnvironmentV1.observe(state, playerId)
const candidates = aiEnvironmentV1.listLegalActions(state, playerId)
const result = aiEnvironmentV1.simulate(state, candidates[0], { rootSeed })

if (result.accepted) {
  console.log(result.transitionHash, result.trace.stateChanges)
} else {
  console.error(result.error.code, result.trace)
}
```

不要把 `result.state` 写回房间；权威提交必须重新通过房间命令服务验证和 CAS 保存。
