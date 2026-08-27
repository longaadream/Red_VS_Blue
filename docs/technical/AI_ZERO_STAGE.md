# 零阶段启发式双层潜力 AI（RED-122）

协议版本：`ZeroStageConfig.version = 1`

## 目标与边界

零阶段 AI 是无需训练的确定性基线。它使用人工权重解释静态局面，并在每个权威合法动作之后考察最多三条高价值后续路线。它只返回一个可以正式提交的 `nextAction`；动作被权威层接受后，调用方必须在新状态上重新调用，不得执行旧的后续动作。

本实现不替代 RED-86 Beam Search，也不注册玩家入口、训练联赛或在线自学习。它不修改规则、数值、随机、网络或存档。评分只能读取 `aiEnvironmentV1.observe()` 返回的公开观察；候选和状态变化只能来自 AI 环境对正式规则的枚举与隔离模拟。

## 静态估价 F

`evaluateZeroStageState(observation)` 从显式玩家视角计算：

```text
F_p(S) = Σ feature_i(S, p) × C_i
```

所有普通分项都是己方值减敌方值。终局使用不可被普通分项覆盖的固定值：胜利 `+1,000,000`、失败 `-1,000,000`、平局 `0`。

| 分项 | v1 权重 | 含义 |
| --- | ---: | --- |
| `coreSurvival` | 50,000 | 双方存活核心数量差 |
| `survival` | 12,000 | 双方存活棋子数量差 |
| `graveyard` | 8,000 | 敌我墓地数量差 |
| `health` | 3,000 | 双方标准化生命比例总和差 |
| `combatPower` | 250 | 标准化公开攻防能力差 |
| `shield` | 400 | 公开护盾差 |
| `resources` | 250 | 公开行动点与充能差 |
| `actionability` | 500 | 当前行动窗口与可行动棋子/资源 |
| `lethalOpportunity` | 20,000 | 基于公开攻防、生命和移动范围的近似斩杀机会差 |
| `attackPressure` | 1,500 | 近似攻击覆盖中的有效伤害比例差 |
| `status` | 500 | 公开 Buff/Debuff 数量净值 |
| `formation` | 150 | 两格内友军配对形成的支援结构差 |
| `mapControl` | 100 | 标准化中心接近度差 |

`lethalOpportunity` 和 `attackPressure` 只是局面特征，不是合法性判断；最终候选仍完全来自权威环境。代码不按角色、技能、阵容或地图 ID 分支。

默认配置同时保存在 `DEFAULT_ZERO_STAGE_CONFIG` 和 `config/ai/agents/zero-stage-v1.json`，测试锁定二者一致。调整权重必须提升配置版本或明确记录配置快照，不能静默改变旧回放的决策含义。

v1 同时设置确定性 `nodeBudget = 10,000`。节点只统计正式外层或反事实后续 transition，不使用墙钟时间。预算收紧时优先为尚未检查的每个外层合法候选预留一个节点，再按稳定候选顺序裁剪后续并记录 `node-budget`；默认预算下固定基线没有发生裁剪。

## 费用放宽的反事实环境

`aiPotentialEnvironmentV1` 提供：

```ts
listPotentialActions(state, playerId)
simulatePotential(state, candidate, { rootSeed })
```

处理步骤：

1. 从当前棋子技能、手牌实例/定义和移动规则读取正式 AP/充能成本。
2. 在浅层隔离视图中补足发现候选所需的最大公开成本。
3. 对每个候选重新计算其精确成本和短缺。
4. 仅补足该候选的精确短缺，再次调用 `listLegalAIActions()`。
5. 只有稳定 candidate ID 和完整动作均再次出现时，才证明它除费用外仍然合法。
6. 模拟时重新执行以上校验，再在精确补贴副本上调用正式隔离 transition。

因此费用放宽不会绕过回合、阶段、阵营、存活、目标、距离、冷却、次数、沉默或其他准入条件。补贴不会写入输入或正式状态，模拟后的资源不为负。过期或不能证明只受费用阻挡的候选以 `AI_ENV_POTENTIAL_NOT_COST_ONLY` 失败关闭。

## 后续潜力 G

对外层动作后的局面 `X`，每个后续候选得到：

```text
H_p(X, a) = F_p(SimulatePotential(X, a)) - λ × I(costBreakthrough)
λ = 3,000
```

将 H 降序排列并取最多三项：

```text
G_p(X) = 0.6 × V1 + 0.3 × V2 + 0.1 × V3
```

只有一项或两项时，对实际存在的前缀权重重新归一化。没有后续候选、已经终局或行动玩家已经切换时，`G_p(X) = F_p(X)`。零阶段 AI 不搜索敌方回合。

最终动作只从外层权威合法集合选择：

```text
a* = argmax[a in A_legal(S)] G_p(Simulate(S, a))
```

同分依次比较 `G`、外层 `F`、较低真实资源成本、完整动作 stable JSON 和 candidate ID。终局胜利因为固定终局值天然优先。

## API 与诊断

入口：

```ts
planZeroStageAction(state, playerId, rootSeed, options?)
zeroStageDecisionTraceHash(decision)
```

`ai-planner.ts` 重新导出这两个入口，使其与现有 player-level 规划边界一致。返回值记录：

- 当前 `F`、唯一 `nextAction` 和停止原因；
- 所有外层合法候选的 `F`、`G`、真实成本与兼容等级；
- 每个后续候选的成本、短缺、补贴标志、`λ` 惩罚、静态值和 H；
- `V1/V2/V3`、拒绝码、RED-85 失败关闭原因、节点数和候选数；
- 是否触及确定性节点预算及每个被预算裁剪的后续候选；
- 覆盖完整决策证据的稳定 trace hash。

`unsupported`、`metadata-required` 和 `evaluator-required` 内容均不会由零阶段 AI 猜测估值或正式选择。无动作和终局返回 `nextAction: undefined`，不发明 fallback。

## 验证与已知限制

`tests/game/ai-zero-stage.test.ts` 覆盖玩家镜像视角、隐藏信息隔离、终局优先、0/1/2/3+ 后续聚合、费用精确补贴、冷却/所有权约束、正式核心击杀、合法外层动作、确定性 trace 和安全停止。

已知限制：

- v1 在默认节点预算内完整枚举外层和后续候选，主要成本是正式隔离 transition；只有显式收紧或异常高分支触及预算时才进行稳定失败可见的后续裁剪。
- 斩杀和压力分项是公开静态近似，不替代技能范围或伤害规则。
- 费用突破使用布尔惩罚，同时在 trace 中保留实际短缺；后续可用数据决定是否改为按短缺量惩罚。
- 不搜索敌方应对，因此它是双层己方潜力基线，不是 minimax。
- profile 尚未注册到 self-play archive、在线 PVE 或 UI；这些路径不在 RED-122 合同内，需要独立任务。

## 回退

移除零阶段 evaluator、agent、profile、AI 环境费用适配、测试和本文档即可恢复现有 simple/planner 行为。没有玩家存档、玩法数据、网络协议或随机状态需要迁移。
