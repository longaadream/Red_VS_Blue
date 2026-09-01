# 零阶段单步估价与位置潜力 AI（RED-122）

## 定位

零阶段 AI 的正式 agent/profile ID 为 `rvb-ai-zimse-v1`。它是无需训练、确定且可解释的 player-level 基线，不替代 RED-86 Beam Search，也不注册在线入口或训练联赛，不修改规则、数值、随机、网络或存档。

每次调用先从 `aiEnvironmentV1.listLegalActions()` 读取全部严格合法动作，用 RED-86 的通用机制语义稳定排序，再对每个候选各调用一次 `simulate()`，计算动作后局面的静态估价 `F_p(S')`，最后只返回一个 `nextAction`。权威状态接受动作后，调用方必须在新状态重新规划，并通过 `actionsTakenThisTurn` 回传本回合已经提交的动作数。

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

生产调用必须在每次正式 action 被接受、状态版本变化后再次调用 `planZeroStageAction()`，不得缓存并连续提交旧候选。候选估价内部使用 `simulationMode: 'evaluation'`；最终选中的动作不携带该模式，仍由调用方走完整 AI transition 或服务器权威命令入口。

默认 profile 由 `DEFAULT_ZERO_STAGE_CONFIG` 提供，仓库快照位于 `config/ai/agents/rvb-ai-zimse-v1.json`。JSON 用于版本归档、审计和外部调度识别，`agentId` 必须保持 `rvb-ai-zimse-v1`；运行时覆盖通过 `options.config` 传入，并由 `resolveZeroStageConfig()` 校验。`candidateMode` 固定为 `all-legal`，不能配置候选数量、按类型裁剪或开启第二层搜索。

## 单步算法

```text
legal = listLegalActions(S, p)
ranked = StableSemanticRank(legal)
for a in ranked:
  S' = Simulate(S, a)
  if S' is blocked or rejected:
    record and exclude a
  else:
    score(a) = F_p(S')
a* = argmax score(a)
```

没有费用补贴、费用不足候选、top-3 聚合或第二层动作。除回合动作护栏外，全部严格合法候选都会各消耗一个节点并完整参与估价；稳定语义排序只固定 trace 和最终同分顺序，不承担候选裁剪。不会按候选数量、动作类型、费用、目标或墙钟时间提前停止。默认单回合最多提交 8 个动作；调用方传入的计数达到 7 且存在 `endTurn` 时，只模拟并选择 `endTurn`。

同分依次比较：

1. `F_p(S')` 总分降序；
2. `endTurn` 优先，避免为了消耗资源重复无收益动作；
3. 其余动作的正式 AP 与充能总费用升序，在等价局面下保留后续行动选择；
4. 稳定 action JSON；
5. 稳定 candidate ID。

终局分固定为 `+1,000,000 / -1,000,000 / 0`。候选比较先按 `胜利 > 非终局 > 平局 > 失败` 分层，再比较总分，因此普通分项即使累计超过一百万也不能覆盖立即胜利。

## 静态估价 F

所有分项只读取 `aiEnvironmentV1.observe()` 返回的公开观察，并以当前玩家为相对视角：

| 分项 | v6 权重 | 含义 |
| --- | ---: | --- |
| `coreSurvival` | 200,000 | 双方存活核心棋子差，使直接推进胜利条件明显高于清理召唤物 |
| `survival` | 10,000 | 双方存活棋子差 |
| `graveyard` | 10,000 | 双方墓地棋子差，保留击杀普通敌棋的价值但不盖过核心目标 |
| `health` | 80,000 | 核心使用 `6×sqrt(剩余生命比例)`，非核心使用 `0.25×剩余比例`；真实敌核掉血显著高于理论增益，并继续鼓励集火残血核心 |
| `combatPower` | 300 | 标准化攻防差 |
| `shield` | 30,000 | 按最大生命归一化并封顶的公开护盾差；破盾获得明确收益但仍低于同量核心生命伤害 |
| `resources` | 0 | 诊断占位；不再把 AP 或充能的消耗本身算作收益，价值由动作后的局面分项体现 |
| `actionability` | 150 | 双方存活可操作实体的通用数量差，不读取剩余 AP |
| `deploymentReadiness` | 500,000 | 仅在部署阶段生效；压过普通位置收益并优先锁定，避免无费用重复调位 |
| `turnProgress` | 0 | 诊断占位；不再仅因结束回合扣分，防止无收益动作拖到护栏 |
| `lethalOpportunity` | 5,000 | 下一次通用攻击可斩杀的目标价值差；每个目标最多计一次，只作接敌辅助，不能压过实际击杀 |
| `attackPressure` | 2,000 | 当前移动加一次攻击范围内的理论伤害压力差；每个敌方目标只取最强己方来源，显著低于已经造成的真实生命伤害 |
| `status` | 400 | 公开 Buff/Debuff 数量差，并按公开 `sourcePlayerId` 判断未归类状态标签的阵营收益；低于直接伤害和终局推进 |
| `positionSafety` | 2,500 | 己方低血棋子受敌方覆盖的负向暴露风险；不再把“敌人被我覆盖”重复算作安全收益 |
| `strategicPosition` | 5,000 | 低权重中心控制与敌方目标压迫；不得覆盖明确的逐格追敌方向 |
| `enemyProximity` | 80,000 | 常态按每个棋子的最近敌核追击；己方核心占优且敌核不超过 4 个时强化逐格接近、进入下一动作范围和均衡分派，避免远处残敌无人追击 |
| `futureAttackPotential` | 2,000 | 进入立即攻击覆盖和威胁残血/核心目标的低权重理论潜力；每个目标只取最强己方来源，不累计全部攻防组合 |
| `supportPotential` | 400 | 友军按距离、机动和缺血程度计算的汇合支援潜力差 |
| `mobilityPotential` | 500 | 考虑墙体和占位后，移动范围内可达空间比例差 |
| `terrainValue` | 700 | 当前格的治疗、充能、掩体收益与持续伤害风险差 |

位置分项不读取角色、技能或地图 ID。`strategicPosition` 使用地图宽高得到几何中心和目标压迫，但 v5 起把它降为辅助项。独立 `enemyProximity` 使用公开可行走格 BFS：常态取每个己方棋子的最近敌核距离；v6 在己方核心数多于敌方且敌核不超过 4 个时缩短距离归一化尺度，使每一步接近都足以压过无收益结束回合，并在进入 `moveRange + 1` 的下一动作范围时增加小额阶段奖励。敌方只剩一个核心时进一步集中追兵；敌方被至少二比一包围时，以 `ceil(己核数/敌核数)` 为容量做均衡全员分派，避免原一对一匹配只保证每个残敌有一个追兵。敌方没有存活核心时退化为普通敌棋。该增强严格要求己方核心占优，势均力敌时仍沿用保守的最近目标尺度，避免追击价值导致空打或无谓送兵；分项也不减去敌方镜像距离，因此主动推进信号不会抵消。未来攻击按每个目标选择最强己方来源，仅使用公开攻击、防御、生命、移动范围和几何距离；核心目标权重高于非核心实体。支援是通用汇合能力，不猜测某个角色是否具有治疗技能；移动空间通过公开可行走格与存活棋子占位做有界 BFS；地形只读取格子公开属性。

核心接敌最短路场按地图尺寸和公开可行走格键控，跨等价候选复用，最多保留 8 个最近使用的地图拓扑。缓存不包含棋子占位、手牌、玩家私有字段或候选结果；地图 walkable 变化时得到新的键。

清场匹配的动态规划只在己方核心数确实多于存活敌核时执行；开局、势均力敌、劣势及敌核已清空的终局直接返回最近目标结果。深度人数优势时使用带容量的均衡分派，其余优势局面保留一对一混合。该短路不删除或跳过任何合法动作，只避免计算最终权重为零的估价子项。

## 公开信息与规则边界

- 对手手牌内容在观察中被隐藏，只保留张数；修改私有手牌不改变评分。
- `visible:false` 的状态不会进入观察，因此不影响评分或决策。
- 候选合法性和 transition 只由权威 AI 环境提供；零阶段代码不复制目标、距离、冷却、阶段或胜负规则。
- 每个严格合法候选恰好隔离模拟一次，输入 `BattleState` 不被写回；只有回合动作护栏会把候选收束为 `endTurn`。
- 候选估价仍调用原有 `runBattleActionIsolated()`，但 AI 环境先构造不含历史 replay/action-log 载荷的浅层推演视图；它保留 gameplay state、已应用 action ID、root seed、action count、RNG runtime cursors 和紧凑初始化记录。终局时 AI 环境把结算动作索引修正为正式动作序号并重算对应 hash；正式状态、规则 runner、随机算法与最终正式 replay 均不改变。
- 每次规划为当前根状态构造一次 `BattleStateHashIndex`，全部候选模拟复用同一只读前态索引，避免逐候选重复扫描前态；每个候选仍各自隔离执行，索引不承担缓存结果或候选裁剪。
- evaluation transition 不生成完整 state diff，只保留估价所需的 accepted/rejected、blocked、后继状态与确定性最小 trace；重复 evaluation 仍产生稳定 transition hash。
- 技能、移动或卡牌被沉默、打坐等 before-action 规则阻止时，权威命令仍可能合法接收。AI 环境比较公开观察时忽略纯 `targetingRevision` 变化，把没有其他公开效果的动作规范化为 `trace.blocked=true`；零阶段记录该候选但不计算 `F`、不选择它，从而不会重复触发。
- RED-85 机制兼容性保留在 trace 中作为诊断，但不会触发第二层估值或生成非法动作。

## Trace 与复现

`ZeroStageDecision` 记录：

- 当前 `stateValue`、候选数、节点数、预算状态和停止原因；
- 每个候选的 action、正式费用、兼容性、完整 `F` 总分与分项；
- 被权威 transition 拒绝、阻止或被回合动作护栏裁剪的明确原因；
- 唯一 `nextAction`，以及稳定的 `selectionReason`（终局层级、静态分、费用、结束回合、action JSON 或 candidate ID）。

`zeroStageDecisionTraceHash()` 覆盖以上稳定字段。相同 state、player、root seed 和 profile 应产生相同动作、候选顺序与 hash。

## 性能与限制

固定 fixture 必须证明在未触发回合动作护栏时 `nodesVisited === candidatesConsidered === legal.length`，普通候选不得出现 `candidate-budget`。性能证据记录机器、样本、候选数、P50/P95/最大耗时和非法动作数，但不能为了满足延迟阈值裁剪合法策略。

在 `origin/main@7a6bf42`（PR #122 新内核）上，profile v4 使用固定 seed `1001` 做 8v8 镜像自战，完整枚举 31,847 个节点、33,468 个候选，在 21 回合、340 个正式动作后以核心全灭结束；P50 `1,161.10ms`、P95 `2,167.43ms`、最大 `8,792.26ms`，总运行 `462.57s`，非法动作 `0`。短程同状态对照显示根状态索引复用相对不复用把 P50/P95 降低约 `10.8%/7.4%`；进一步复用公开地图最短路场后，相同 2,912 个候选和相同 hash 的 5 回合夹具把 P50/P95 再降低约 `29.7%/27.2%`，墙钟从 `33.67s` 降至 `26.34s`。固定 seed `335607069` 的未缓存 20 回合夹具仍比旧内核慢约 `19.6%`；长程缓存复测受宿主暂停污染，不能用总墙钟作结论。当前主要瓶颈仍集中在每个候选的状态深克隆与 patch/diff 处理，后续内核优化不得以裁剪候选掩盖。

当前 profile 仍有明确限制：

- 不搜索敌方回合，也不预判未来随机结果；
- 支援潜力是通用位置启发式，不理解未进入公开机制语义的角色组合；
- 核心接敌使用公开可行走格最短路，其余通用攻击覆盖仍使用曼哈顿距离；复杂射线与具体技能范围以动作后的权威状态为准；
- 权重由人工设定，必须通过真实 PvE 对局和后续训练继续校准。
