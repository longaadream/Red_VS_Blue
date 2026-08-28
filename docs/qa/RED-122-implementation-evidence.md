# RED-122 实现验证证据

任务：实现零阶段单步贪心估价与位置潜力 AI 基线

角色：实现者（Codex），独立 AI 复核已通过，等待人工验收

分支：`codex/RED-122-zero-stage-ai`

基线：`origin/main@575f7aeb48bfc065c1dc5fd6b74d494b7db570c4`（2026-08-28 最终基线检查后再次 rebase）

## 实现范围

- 正式 agent/profile ID 与配置资产命名为 `rvb-ai-zimse-v1`。
- 每次决策只对至多 2 个严格合法候选各执行一次隔离模拟，不搜索第二层。
- `F_p(S)` 提高伤害、击杀、残血/核心威胁、攻击覆盖、中心控制、敌方目标压迫和未来接敌价值，并把纯保守安全降为底线约束。
- `resources` 将未使用费用视为当前回合机会成本；常规候选先准入明确指向敌棋/敌棋所在格的攻击，没有直接攻击时优先缩短敌方核心或最近敌棋距离的移动，再比较费用、动作种类和原语义名次。
- `endTurn` 始终保留一个候选名额，第 8 个动作仍强制结束，避免无界长回合。
- AI transition 对合法接收但公开观察完全不变的技能、移动或卡牌标记 `blocked=true`；零阶段记录但不估价、不选择，防止沉默或打坐动作重复触发。
- 未修改技能、卡牌、玩法数值、胜负、随机、UI、网络、存档或 PvE 奖励。

## 固定局面证据

`tests/game/ai-zero-stage.test.ts` 共 25 项，覆盖：

- profile ID/权重与可执行默认配置一致；
- 红蓝相对视角、终局绝对优先和隐藏信息隔离；
- 中心控制、敌方核心压迫、未来攻击、支援、机动、地形和低血暴露；
- AP/充能使用后的评分高于保留费用；
- 同分时费用动作胜过跳过回合，进攻位置胜过等费用撤退，等接敌距离时选择中心路线；
- 后期僵持时追敌移动准入优先于等费用自益技能，增强位置权重后仍会及时锁定部署；
- 立即核心斩杀、明确威胁处理、每候选一次模拟、确定性 hash；
- 普通累计分超过一百万时仍优先立即胜利，节点 override 不得突破 2，最终 tie-break 原因进入 trace；
- 修改隐藏手牌/隐藏状态不改变完整决策和 trace hash，红蓝镜像追敌动作排序一致；
- 结构动作和 `endTurn` 保留、零费用无收益循环、第 8 动作护栏；
- `blocked=true` 技能无估价且不会成为 `nextAction`。

结果：`25/25` 通过。8v8 纯移动 fixture 同轮记录 `illegal=0`，P95 小于 1,000ms。

AI 环境、RED-86 planner 与状态隔离相邻回归：`3 files / 29 tests` 全部通过。

## 最终镜像自对弈

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

## 对游戏内置 PvE AI 的三局补充评测

使用服务器同源 `generateBotActions()` 的正式 `simple-v1`，固定 seed `1001`、`1002`、`1003`，零阶段 AI 按红、蓝、红席位交替对战。结果为 `rvb-ai-zimse-v1` 0 胜、`simple-v1` 0 胜、3 平；三局均在第 40 个完整回合以 `round-limit` 结束，非法/拒绝动作 0，单次节点仍不超过 2，最大决策耗时 `2,030.67ms`。

逐局动作、资源、性能与确定性 hash 见 `docs/qa/RED-122-rvb-ai-zimse-v1-vs-simple-v1-3-games.md`。该结果说明镜像自战的第 9 回合胜利不能外推为对内置 PvE 的稳定终局能力，消除跨策略平局仍是已知风险。

## 验证状态

通过：

- `npm.cmd test -- tests/game/ai-zero-stage.test.ts`：1 file / 25 tests。
- `npm.cmd test -- tests/game/ai-environment.test.ts tests/game/ai-planner.test.ts tests/game/ai-isolation.test.ts`：3 files / 29 tests。
- 最终基线 `origin/main@575f7ae` 上重跑零阶段及相邻 AI 回归：4 files / 54 tests 全部通过。
- 固定 seed 镜像自对弈：1 file / 1 test，非法动作 0。
- 对内置 `simple-v1` 的 3 局固定 seed 评测：1 file / 1 opt-in test，3 局均完成，失败和非法动作 0，结果 3 平。
- `npm.cmd run check:encoding`：通过，747 个文本文件。
- `npm.cmd test`：115 files / 1122 tests 通过；4 个内容管线 suite 因缺失依赖在导入阶段失败，1 个 Electron package fixture 测试因缺少 staged `next/ws` package 文件失败。
- `git diff --check`：通过（仅 CRLF 转换提示）。
- `npm.cmd run check:main-baseline`：通过，Ahead 1 / Behind 0（工作树未提交警告符合当前实现阶段）。

独立 AI 复核：通过。首次审查提出的终局绝对优先、节点预算硬边界、最终选择原因进入 trace、决策级隐藏信息与镜像证据 4 项问题均已修复并完成二次复核；复核重跑零阶段测试 `25/25`，固定 seed `1001` 自战仍在第 9 个完整回合 `core-eliminated`，非法/拒绝动作 `0`，动作与终态 hash 保持不变。

未通过/环境阻塞：

- `npm.cmd run typecheck`：本任务新增代码无类型错误；当前 `origin/main` 的 `lib/content-pipeline/core/signature.ts` 与对应测试引用了尚未安装的 `@noble/curves/ed25519.js`，共 2 处 `TS2307`。依赖修改不在 RED-122 范围，未越界安装或更新 lockfile。
- `npm.cmd run lint`：ESLint 配置加载失败，规则 `import/no-anonymous-default-export` 未注册 `import` 插件；未进入源文件检查。配置与依赖不在 RED-122 allowed paths。

## 风险与人工验证

- 单个 seed 已从 40 回合平局变为第 9 回合获胜，但不代表所有阵容与 seed 都不会平局，仍需后续多 seed 平衡评测。
- 对内置 `simple-v1` 的 3 个固定 seed 全部在 40 回合上限平局；当前实现尚未达到跨策略“不要再平局”的产品目标。
- 常规候选只有一个模拟名额；直接敌方目标、追敌移动与其他技能的准入优先级可能错过较低排名但战术更优的动作，这是 2 节点实时预算的明确取舍。
- “公开观察完全不变”会把无公开收益的合法非结构动作也视为 blocked；对零阶段 AI 而言这是防循环策略，但新型零公开变化技能接入时需要补机制语义。
- Medium Risk 独立 AI 复核已通过；实现者与复核者均不代替最终人工体验验收。

建议人工复核沉默、鸣人打坐、攻击残血敌棋、向敌方核心逼近、费用即将溢出的回合，以及第 8 动作强制结束。

## 回退

整体 revert 零阶段 profile、估价器、选择器、AI transition blocked 标记、测试和文档。现有 simple/planner、玩家存档、玩法数据、网络协议和 RNG 无需迁移。
