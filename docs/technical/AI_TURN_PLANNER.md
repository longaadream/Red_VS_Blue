# 阵容无关多操作回合规划器（RED-86）

协议版本：`AiPlannerConfig.version = 1`

## 边界

`lib/game/ai-planner.ts` 是 player-level 的只读搜索消费者。它统一规划当前玩家的棋子、手牌和共享资源，只从 `aiEnvironmentV1.listLegalActions()` 接收权威合法候选，并只用 `aiEnvironmentV1.simulate()` 在隔离状态上推进节点。它不实现移动距离、目标、费用、技能、卡牌、胜负或随机规则。

`planAiTurn()` 返回内部搜索序列 `actions` 和唯一可提交的 `nextAction`。调用者只能提交 `nextAction`；动作被权威接受后，必须把新状态、相同 root seed 和上一份完整 `AiTurnPlan` 交给 `planNextAiAction()`。计划内的 versioned `continuation` 同时保存目标、已提交动作数和访问过的权威 state key；传旧动作队列、只传目标或在拒绝后推进 continuation 都是不合法调用。`nextAction === undefined` 表示终局或没有权威候选，应安全停止，不能发明动作。

## 回合目标

目标只使用公开、阵容无关字段，并按稳定 ID 打破平局：

- `eliminate`：公开数值上可击杀或最低生命敌人；
- `protect`：生命比例低于阈值的高价值友军；
- `control`：公开攻击最高的显著威胁；
- `reposition`：接近远距离优先目标；
- `conserve`：没有存活敌人时保存资源。

旧目标仍合法时保持不变。目标死亡或阵营/存在性不再匹配时才切换；动作本身始终基于最新权威状态重新枚举，所以目标位移、召唤、触发器和 pending 选择不会复用旧动作。

## 搜索、安全与确定性

规划器执行固定节点预算的 Utility + Beam Search：

1. 对权威候选按机制兼容性、动作种类、目标生命、目标距离和保护目标安全距离进行稳定排名。
2. 只裁剪已经合法的候选；`candidateLimit` 的裁剪记录完整排名原因，不会创建新动作。
3. 每个入选候选调用正式隔离 transition；拒绝码写入 trace，不作为成功 no-op。
4. 使用完整 state key 和“该状态已知最高累计分”做支配去重。
5. 相同状态、无正收益动作和 RED-85 的 neutral-value 动作不继续展开；phase/pending/deployment 等结构动作例外。
6. 每个节点优先为显式 `endTurn` 保留预算；完成序列只在 endTurn、权威终局或玩家交接时成立。
7. `continuation` 把已提交动作数和权威 state key 带到下一次重规划；再次到达历史状态或到达本回合动作上限时，只允许必要结构动作和权威 `endTurn`。
8. 完整序列按累计分、较少动作、动作 stable JSON 依次打破平局。

因此单次搜索及“提交一次、重规划一次”的整个权威回合都受零消耗循环、重复状态、无正收益、节点和最大动作数护栏约束。搜索不使用墙钟时间。

## RED-85 语义降级

`ai-evaluator.ts` 读取版本化 `data/rules/ai-semantics.json`，不在规划器内建立第二份内容清单：

- `unsupported` 和 `metadata-required`：`fallback=skip-action`，不执行模拟，trace 明确记录内容 ID 和原因；
- 技能/卡牌 ID 必须存在于 RED-85 已锁定 hash 的正式 manifest；未登记 ID 一律视为 `unsupported`，并记录 `unknown-*-content`；
- `evaluator-required`：允许正式 transition，但按 `fallback=neutral-value` 计零分，默认不会胜过安全 endTurn；
- `automatic`：只从公开的玩家相对状态差异评分伤害、治疗、移除、状态、资源、位置、召唤和变身。

manifest 是内容准入来源而非规划器私有名单，其 hash 继续由 RED-85 审计测试校验。自动状态估值只把“敌方新增/己方移除”作为正向，把相反变化作为负向。含复杂正负状态、延迟、组合或扩展状态的内容必须由 RED-85 清单降级，不能依靠名称猜测。

## 版本化配置

`DEFAULT_AI_PLANNER_CONFIG` 是可保存、可覆盖的稳定接口：

| 字段 | v1 默认值 | 作用 |
| --- | ---: | --- |
| `nodeBudget` | 96 | 正式 transition 的最大节点数 |
| `beamWidth` | 6 | 每层保留节点数 |
| `maxActions` | 8 | 内部序列及同一权威回合累计提交动作数上限（含最终 endTurn） |
| `candidateLimit` | 20 | 每节点除 endTurn 外的候选上限 |
| `minActionScore` | 0 | 非结构动作继续展开的最低即时收益 |
| `weights` | 版本化对象 | 玩家相对 utility 分量权重 |

所有预算必须为正安全整数，阈值和权重必须为有限数；非法配置会立即拒绝。离线优化必须保存完整 resolved config 和 `configVersion`。

## 调试证据

`AiTurnPlan.trace` 对每个已考虑或裁剪的候选记录：深度、稳定排名、语义兼容级别、内容 ID、主要分数组成、拒绝码、裁剪原因和解释。计划还记录 `nodesVisited`、`candidatesConsidered`、`stateDuplicates`、`goalChanged`、`stopReason` 与 versioned `continuation`。`aiPlanTraceHash()` 覆盖这些字段，可用于相同 state/seed/config 的重放对账。

## 验证基线

`tests/game/ai-planner.test.ts` 固定覆盖：

- 正式环境中三个登记 `fireball` 的不同棋子经三次 `nextAction → simulate → planNextAiAction` 围绕同一目标集火，随后安全结束回合；
- 单动作权威提交后的重规划、目标保持、目标失效切换，以及跨重规划重复状态/累计动作上限；
- 支配去重、零进展、无正收益、终局和无动作；
- 已知及未知 unsupported、metadata-required、拒绝和候选裁剪证据；
- 200 个固定 seed、3–5 枚己方棋子的完整权威回合矩阵，其中 50 个样本含可执行移动；每步均只提交 `nextAction` 后重规划，节点受固定预算约束，非法动作数为 0；
- 正式环境中的击杀、治疗、撤离危险、移动后施法，公开状态差异中的解除控制/施加控制/召唤/变身评分，以及正式召唤/变身内容的 RED-85 安全降级；
- 24 个固定 seed、3–5 枚己方棋子的旧简单 AI 对照样本。

对照样本直接在同一 `aiEnvironmentV1` 上依次回放完整动作序列，不以生成动作视为合法或完成：

| 实现 | 合法性 | 完成率 | 决策节点基线 |
| --- | --- | --- | --- |
| 旧 `generateBotActions()` | 24/24 样本非法动作 0 | 24/24 完成 | 未暴露节点统计（记录为 `null`） |
| RED-86 planner | 24/24 样本非法动作 0 | 24/24 完成 | 每样本固定上限 8，总计范围 24–192 |

这个对照只记录合法性、回合完成和可观察节点，不推导或虚构胜率目标。旧 `generateBotActions()` 继续作为受控回归入口；新规划器没有替换权威提交，也没有第二套规则合法性实现。

## RED-122 零阶段选择器

`ai-planner.ts` 同时重新导出正式 ID 为 `rvb-ai-zimse-v1` 的 `planZeroStageAction()` 和 `zeroStageDecisionTraceHash()`。它们复用同一个 player-level 权威边界，但不改变本文件的 RED-86 Beam Search：零阶段选择器对全部严格合法动作做稳定语义排序，并对每个动作各执行一次隔离模拟，直接比较动作后 `F(S')`，只返回一个 `nextAction`，要求权威状态更新后重新调用。调用方同时回传本回合已提交动作数；默认第 8 个动作只允许权威 `endTurn`，防止单步正收益造成无界长回合。

位置价值与未来攻击、支援、机动和生存潜力直接属于静态估价；`resources` 将未使用费用视为当前回合的机会成本，同分优先费用更高的合法动作。攻击、追敌移动、技能和结束回合等全部严格合法策略都实际模拟后再比较；被沉默或打坐阻止的候选只淘汰自身，不会占据名额而阻止其他策略受测。零阶段不生成费用不足候选，也不枚举第二层动作。算法、权重、诊断和限制详见 [`AI_ZERO_STAGE.md`](./AI_ZERO_STAGE.md)。

## 回退

整体 revert planner、evaluator、profile、共享类型、AI environment 的只读 runtime-cache guard、测试和本文档。无需迁移存档、玩法数据、网络协议或随机状态；失败 trace 应保留在验证记录中。
