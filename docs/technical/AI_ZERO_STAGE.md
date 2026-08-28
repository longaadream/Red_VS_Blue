# 零阶段单步估价与位置潜力 AI（RED-122）

## 定位

零阶段 AI 的正式 agent/profile ID 为 `rvb-ai-zimse-v1`。它是无需训练、确定且可解释的 player-level 基线，不替代 RED-86 Beam Search，也不注册在线入口或训练联赛，不修改规则、数值、随机、网络或存档。

每次调用先从 `aiEnvironmentV1.listLegalActions()` 读取全部严格合法动作，用 RED-86 的通用机制语义稳定排序，再对至多 2 个准入候选各调用一次 `simulate()`，计算动作后局面的静态估价 `F_p(S')`，最后只返回一个 `nextAction`。权威状态接受动作后，调用方必须在新状态重新规划，并通过 `actionsTakenThisTurn` 回传本回合已经提交的动作数。

## 接入与调用接口

正式入口是 `lib/game/ai-zero-stage-agent.ts` 导出的 `planZeroStageAction()`：

```ts
const decision = planZeroStageAction(state, playerId, rootSeed, {
  actionsTakenThisTurn,
  // environment: aiEnvironmentV1, // 可选；默认即为正式 AI 环境
  // config: { weights: { attackPressure: 12_000 } }, // 可选且会严格校验
})

if (decision.nextAction) {
  // 正式服务器/房间：只把 action 提交给现有权威命令入口。
  submitAuthoritativeAction(decision.nextAction.action)
}
```

参数与返回值：

- `state: BattleState`：当前权威战斗状态；函数只读，不会写回输入。
- `playerId: string`：本次决策玩家，估价和隐藏信息过滤均以此玩家视角计算。
- `rootSeed: number`：固定根种子；相同状态、玩家、种子和 profile 应产生相同决定。
- `actionsTakenThisTurn: number`：调用方维护的本回合已正式提交动作数；达到护栏前一位时强制收束到合法 `endTurn`。
- 返回 `ZeroStageDecision`。调用方只能提交 `nextAction.action`；`nextAction` 缺失表示终局或无合法动作，应安全停止。
- `trace`、`selectionReason`、`nodesVisited` 和 `stateValue` 用于诊断、回放与性能记录，不是第二批待执行动作。

生产调用必须在每次正式 action 被接受、状态版本变化后再次调用 `planZeroStageAction()`，不得缓存并连续提交旧候选。无头测试可用 `aiEnvironmentV1.simulate(state, decision.nextAction, { rootSeed })` 执行隔离 transition；生产环境仍应走现有服务器权威命令入口。

默认 profile 由 `DEFAULT_ZERO_STAGE_CONFIG` 提供，仓库快照位于 `config/ai/agents/rvb-ai-zimse-v1.json`。JSON 用于版本归档、审计和外部调度识别，`agentId` 必须保持 `rvb-ai-zimse-v1`；运行时覆盖通过 `options.config` 传入，并由 `resolveZeroStageConfig()` 校验。节点预算硬上限为 2，不能通过配置开启第二层搜索。

## 单步算法

```text
legal = listLegalActions(S, p)
ranked = StableSemanticRank(legal)
admitted = ReserveStructuralAndEndTurn(
  PreferCostEnemyTargetAndAttackKind(ranked),
  limit=2,
)
for a in admitted:
  S' = Simulate(S, a)
  score(a) = F_p(S')
a* = argmax score(a)
```

没有费用补贴、费用不足候选、top-3 聚合或第二层动作。默认且硬性最大候选/节点预算为 2（通常为 `endTurn` 加 1 个常规动作），大于 2 的配置直接拒绝；一个准入候选最多消耗一个节点。唯一结构动作优先保留，`endTurn` 始终保留一个名额。其余候选先保留明确以敌棋为目标的攻击；没有直接攻击时，严格缩短到敌方公开核心（无核心时最近敌棋）距离的移动优先，并以靠近地图中心作为等追击进度的次级排序；随后才按真实费用、攻击/技能种类和原语义名次排序。该排序只读公开几何，不执行额外 transition，也不使用墙钟时间。默认单回合最多提交 8 个动作；调用方传入的计数达到 7 且存在 `endTurn` 时，只模拟并选择 `endTurn`。

同分依次比较：

1. `F_p(S')` 总分降序；
2. 正式 AP 与充能总费用降序，使等价收益下优先把费用转化为行动；
3. 费用相同时 `endTurn` 优先，避免零收益、零费用动作循环；
4. 稳定 action JSON；
5. 稳定 candidate ID。

终局分固定为 `+1,000,000 / -1,000,000 / 0`。候选比较先按 `胜利 > 非终局 > 平局 > 失败` 分层，再比较总分，因此普通分项即使累计超过一百万也不能覆盖立即胜利。

## 静态估价 F

所有分项只读取 `aiEnvironmentV1.observe()` 返回的公开观察，并以当前玩家为相对视角：

| 分项 | v2 权重 | 含义 |
| --- | ---: | --- |
| `coreSurvival` | 50,000 | 双方存活核心棋子差 |
| `survival` | 22,000 | 双方存活棋子差 |
| `graveyard` | 20,000 | 双方墓地棋子差，提高击杀普通敌棋的价值 |
| `health` | 8,000 | 标准化剩余生命差，直接鼓励有效攻击 |
| `combatPower` | 300 | 标准化攻防差 |
| `shield` | 300 | 按最大生命归一化并封顶的公开护盾差，避免重复叠盾让估价无界增长 |
| `resources` | 800 | 已使用 AP 减未使用充能的相对节奏差；将未转化费用视为机会成本 |
| `actionability` | 150 | 当前行动窗口和可行动棋子；权重低于费用利用，避免保留 AP 盖过有效行动 |
| `deploymentReadiness` | 500,000 | 仅在部署阶段生效；压过普通位置收益并优先锁定，避免无费用重复调位 |
| `turnProgress` | -750 | 把控制权交给对手的节奏惩罚 |
| `lethalOpportunity` | 45,000 | 下一次通用攻击可斩杀价值差；核心目标按双倍机会计入 |
| `attackPressure` | 10,000 | 当前移动加一次攻击范围内的伤害压力差，并提高残血与核心目标优先级 |
| `status` | 400 | 公开 Buff/Debuff 数量差；低于直接伤害和终局推进 |
| `positionSafety` | 250 | 低血棋子受敌方覆盖的暴露风险差；只保留底线风险约束，不阻止合理接敌 |
| `strategicPosition` | 4,000 | 按地图尺寸归一化的中心控制与敌方公开核心目标压迫差；无核心时退化为最近敌棋 |
| `futureAttackPotential` | 9,000 | 逼近敌棋、进入立即攻击覆盖和威胁残血/核心目标的潜力差 |
| `supportPotential` | 400 | 友军按距离、机动和缺血程度计算的汇合支援潜力差 |
| `mobilityPotential` | 500 | 考虑墙体和占位后，移动范围内可达空间比例差 |
| `terrainValue` | 700 | 当前格的治疗、充能、掩体收益与持续伤害风险差 |

位置分项不读取角色、技能或地图 ID。`strategicPosition` 使用地图宽高得到几何中心，并把棋子到中心及敌方公开核心棋子的曼哈顿距离归一化；敌方没有存活核心时使用最近存活敌棋，因此偏远且不压迫目标的棋子价值更低。未来攻击仅使用公开攻击、防御、生命、移动范围和几何距离；支援是通用汇合能力，不猜测某个角色是否具有治疗技能；移动空间通过公开可行走格与存活棋子占位做有界 BFS；地形只读取格子公开属性。

## 公开信息与规则边界

- 对手手牌内容在观察中被隐藏，只保留张数；修改私有手牌不改变评分。
- `visible:false` 的状态不会进入观察，因此不影响评分或决策。
- 候选合法性和 transition 只由权威 AI 环境提供；零阶段代码不复制目标、距离、冷却、阶段或胜负规则。
- 每个准入合法候选最多隔离模拟一次；未准入候选记录 `candidate-budget`，输入 `BattleState` 不被写回。
- 技能、移动或卡牌被沉默、打坐等 before-action 规则阻止时，权威命令仍可能合法接收。AI 环境把“公开观察完全未变化”规范化为 `trace.blocked=true`；零阶段记录该候选但不计算 `F`、不选择它，从而不会重复触发。
- RED-85 机制兼容性保留在 trace 中作为诊断，但不会触发第二层估值或生成非法动作。

## Trace 与复现

`ZeroStageDecision` 记录：

- 当前 `stateValue`、候选数、节点数、预算状态和停止原因；
- 每个候选的 action、正式费用、兼容性、完整 `F` 总分与分项；
- 被权威 transition 拒绝或被节点预算裁剪的明确原因；
- 唯一 `nextAction`，以及稳定的 `selectionReason`（终局层级、静态分、费用、结束回合、action JSON 或 candidate ID）。

`zeroStageDecisionTraceHash()` 覆盖以上稳定字段。相同 state、player、root seed 和 profile 应产生相同动作、候选顺序与 hash。

## 性能与限制

固定 8v8 纯移动 fixture 要求 P95 小于 1,000ms；真实技能对局要求 P95 小于 3,000ms、单次小于 5,000ms。节点数必须同时不超过 2 和严格合法候选数。性能证据记录机器、样本、候选数、P50/P95/最大耗时和非法动作数。

当前 profile 仍有明确限制：

- 不搜索敌方回合，也不预判未来随机结果；
- 支援潜力是通用位置启发式，不理解未进入公开机制语义的角色组合；
- 曼哈顿距离用于远期攻击接近度，复杂射线与具体技能范围仍以动作后的权威状态为准；
- 权重由人工设定，必须通过真实 PvE 对局和后续训练继续校准。
