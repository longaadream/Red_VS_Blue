# RED-122 实现验证证据

任务：实现零阶段单步贪心估价与位置潜力 AI 基线

角色：实现者（Codex），schema v3 全枚举修改等待独立 AI 复核和人工验收

分支：`codex/RED-122-zero-stage-ai`

基线：`origin/main@0a09899b8e269b9b8bdcbffbea7b2171782572d3`（2026-08-29 提交前刷新并 rebase）

## 实现范围

- 正式 agent/profile ID 与配置资产命名为 `rvb-ai-zimse-v1`。
- 除第 8 动作的回合护栏外，每次决策对全部严格合法候选各执行一次隔离模拟，不搜索第二层。
- `F_p(S)` 提高伤害、击杀、残血/核心威胁、攻击覆盖、中心控制、敌方目标压迫和未来接敌价值，并把纯保守安全降为底线约束。
- `resources` 将未使用费用视为当前回合机会成本；攻击、追敌移动、技能、结构动作与 `endTurn` 全部经过实际 transition 后再按估价比较。
- 第 8 个动作仍通过护栏强制结束，避免无界长回合。
- AI transition 对合法接收但公开观察完全不变的技能、移动或卡牌标记 `blocked=true`；零阶段记录但不估价、不选择，防止沉默或打坐动作重复触发。
- 未修改技能、卡牌、玩法数值、胜负、随机、UI、网络、存档或 PvE 奖励。

## 固定局面证据

`tests/game/ai-zero-stage.test.ts` 共 26 项，覆盖：

- profile ID/权重与可执行默认配置一致；
- 红蓝相对视角、终局绝对优先和隐藏信息隔离；
- 中心控制、敌方核心压迫、未来攻击、支援、机动、地形和低血暴露；
- AP/充能使用后的评分高于保留费用；
- 同分时费用动作胜过跳过回合，进攻位置胜过等费用撤退，等接敌距离时选择中心路线；
- 后期僵持时追敌移动估值高于等费用自益技能，增强位置权重后仍会及时锁定部署；
- 立即核心斩杀、明确威胁处理、每候选一次模拟、确定性 hash；
- 普通累计分超过一百万时仍优先立即胜利，profile 只允许 `all-legal` 候选模式，最终 tie-break 原因进入 trace；
- 修改隐藏手牌/隐藏状态不改变完整决策和 trace hash，红蓝镜像追敌动作排序一致；
- 拥挤局面 21 个候选全部模拟、零费用无收益循环、第 8 动作护栏；
- `blocked=true` 技能和 authority rejected 候选都只淘汰自身；其后的全部后备候选仍各模拟一次，胜利动作仍可被选择。
- 两组不同生命、攻击和移动结构的 8v8 fixture 均覆盖红蓝双方席位。

结果：`26/26` 通过。未触发回合护栏的样本均满足 `nodesVisited === candidatesConsidered === legal.length`，普通候选没有 `candidate-budget` 裁剪。

AI 环境、RED-86 planner 与状态隔离相邻回归：`3 files / 29 tests` 全部通过。

## schema v3 全枚举性能验证

2026-08-29 运行固定 seed `1001` 镜像自对弈。首次便携式哈希运行和第二次安装正式 Node 权威使用的原生 SHA-256 后，均在持续占用 CPU、无异常输出的情况下超过 20 分钟仍未完成，达到测试合同的单局上限后人工终止，不能报告终局、胜者或回放 hash。这说明原生哈希不是主要瓶颈，完整 transition 的状态复制、规则执行、状态 diff、回放与候选后估价共同构成主要成本。

结论：完整候选枚举的行为合同与固定 fixture 已通过，但真实技能局面的实时性能未通过。与 schema v2 同 seed 的 101 次决策、12,007 个候选相比，旧版只模拟 180 个节点，而 v3 要求模拟全部候选；主要成本是上万次权威隔离 transition，不是静态估价或排序。为遵守“测试全部可能策略”的明确要求，本次没有用候选数量、动作类型、费用、目标或墙钟时间重新裁剪。

## 历史证据：schema v2 镜像自对弈

以下结果来自 2 节点候选版本，仅用于说明修改前基线，不代表 schema v3 的当前速度或胜负：

命令：

```text
npm.cmd test -- tests/game/ai-zero-stage-pve-evaluation.test.ts
```

双方：`rvb-ai-zimse-v1` vs `rvb-ai-zimse-v1`

固定 seed：`1001`

结果：蓝方席位在第 9 个完整回合后以 `core-eliminated` 获胜；蓝方剩余 7 枚棋子，红方存活棋子为 0；非法/拒绝动作 `0`，规则异常 `0`。

| 指标 | 红方 | 蓝方 | 合计 |
| --- | ---: | ---: | ---: |
| 正式决策 | 32 | 69 | 101 |
| 消耗 AP | 15 | 42 | 57 |
| 消耗充能 | 0 | 4 | 4 |
| 普通移动 | 4 | 5 | 9 |
| 普通技能 | 6 | 19 | 25 |
| 充能技能 | 0 | 3 | 3 |
| 结束回合 | 10 | 9 | 19 |

其他动作包括部署锁定、开始阶段、卡牌和 pending 交互。总正式动作 101。对比修改前同 seed 的 40 回合平局与 0 次普通移动，新策略执行 9 次追敌移动，并提前 31 个完整回合产生胜者。

性能：决策 P50 `125.56ms`，P95 `251.33ms`，最大 `389.56ms`；访问节点 `180`，候选总数 `12007`，每次决策节点不超过 2。

确定性证据：

- action trace hash：`cd6358ac039ec1c09d92a912af8b8d7354b3186a8f64a7b8dc93e975e355d9d0`
- final state hash：`938bc189e6dbb9263883579f0c6eb60da590173b3fc740af0744ae6434e1d459`
- 可导入回放：`docs/qa/RED-122-rvb-ai-zimse-v1-aggressive-self-play-seed-1001.trace.json`，`rvb-match-trace/v2`，101 帧，SHA-256 `48ABB5B97E5EF46E47C6DAD3C7EB5EEF0AF793EF2B3E4364C9422480E0026230`。

相同 seed 在单独自战与完整测试中重复得到相同动作与终态 hash，说明追敌排序、攻击权重和部署收束没有引入非确定性。

## 历史证据：schema v2 对游戏内置 PvE AI 的三局评测

使用服务器同源 `generateBotActions()` 的正式 `simple-v1`，固定 seed `1001`、`1002`、`1003`，零阶段 AI 按红、蓝、红席位交替对战。结果为 `rvb-ai-zimse-v1` 0 胜、`simple-v1` 0 胜、3 平；三局均在第 40 个完整回合以 `round-limit` 结束，非法/拒绝动作 0，单次节点仍不超过 2，最大决策耗时 `2,030.67ms`。

逐局动作、资源、性能与确定性 hash 见 `docs/qa/RED-122-rvb-ai-zimse-v1-vs-simple-v1-3-games.md`。该结果说明镜像自战的第 9 回合胜利不能外推为对内置 PvE 的稳定终局能力，消除跨策略平局仍是已知风险。

## schema v3 验证状态

通过：

- `npm.cmd test -- tests/game/ai-zero-stage.test.ts`：1 file / 26 tests。
- `npm.cmd test -- tests/game/ai-environment.test.ts tests/game/ai-planner.test.ts tests/game/ai-isolation.test.ts`：3 files / 29 tests。
- rebase 到 `origin/main@0a09899` 后运行零阶段与相邻 AI 回归；最新合计 4 files / 55 tests，全部通过。
- `npm.cmd run check:encoding`：通过，773 个文本文件。
- `git diff --check`：通过（仅换行转换提示）。
- 固定 seed `1001` 镜像自对弈：超过 20 分钟未完成，人工终止；真实对局性能未通过。

schema v3 已完成独立 AI 复核：审查确认全合法候选单层枚举、turn guard 唯一裁剪入口以及 blocked/rejected 只淘汰自身的源码行为。审查提出的 rejected 回归与第二组阵容 fixture 已补齐；固定 seed 完整自战仍因超过 20 分钟未完成而阻止进入人工验收。

未通过/环境阻塞：

- `npm.cmd run typecheck`：本任务新增代码无类型错误；当前 `origin/main` 在 `electron-client/main.ts` 与 `electron/main.ts` 有 `ws` 构造/隐式 any 共 8 处错误，内容签名模块另有 2 处缺失 `@noble/curves/ed25519.js` 的 `TS2307`。这些文件与依赖不在 RED-122 范围，未越界修改。
- `npm.cmd run lint`：ESLint 配置加载失败，规则 `import/no-anonymous-default-export` 未注册 `import` 插件；未进入源文件检查。配置与依赖不在 RED-122 allowed paths。

## 风险与人工验证

- schema v3 会测试低语义排名的严格合法策略，但固定 seed 真实自战超过 20 分钟仍未完成，当前不适合作为实时 PvE 默认对手。
- schema v2 对内置 `simple-v1` 的 3 个固定 seed 全部在 40 回合上限平局；schema v3 因单局性能未完成三局复测，不能宣称已解决平局。
- “公开观察完全不变”会把无公开收益的合法非结构动作也视为 blocked；对零阶段 AI 而言这是防循环策略，但新型零公开变化技能接入时需要补机制语义。
- Medium Risk 独立 AI 复核结论为“功能边界正确、真实性能验收未通过”；实现者与复核者均不代替最终人工体验验收。

建议人工复核沉默、鸣人打坐、攻击残血敌棋、向敌方核心逼近、费用即将溢出的回合，以及第 8 动作强制结束。

## 回退

整体 revert 零阶段 profile、估价器、选择器、AI transition blocked 标记、测试和文档。现有 simple/planner、玩家存档、玩法数据、网络协议和 RNG 无需迁移。
