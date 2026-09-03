# RED-122：rvb-ai-zimse-v1 对内置 PvE AI 三局评测

评测日期：2026-08-29

候选 AI：`rvb-ai-zimse-v1`

对手：`simple-v1`。该 archive 的 `kind` 为 `simple`，通过 `lib/game/ai-match-runner.ts` 调用游戏服务器同源的 `lib/game/ai.ts#generateBotActions()`，因此本报告中的对手是游戏内置 PvE 决策器，不是随机代理。

阵容：仓库 `red-alpha-v1` 与 `blue-alpha-v1` 固定 8v8 阵容。第 1、3 局零阶段 AI 位于红方，第 2 局位于蓝方。

> 历史证据：本报告使用 profile schema v2 的 2 节点单步版本，发生在 schema v3 全合法候选枚举之前，不代表当前版本的胜负或性能。

环境：Windows x64，Node.js `v24.19.0`，npm `11.17.0`。规则、内容、胜负条件和 40 回合上限均未修改。

## 复现命令

PowerShell：

```powershell
$env:RED122_RUN_PVE_3_GAME='1'
npm.cmd test -- tests/game/ai-zero-stage-pve-evaluation.test.ts -t "plays three fixed-seed games against the built-in PvE simple-v1 agent"
```

三局评测默认跳过，避免每次完整测试额外增加约 18 分钟；设置上述环境变量后才执行。测试调用正式 `aiEnvironmentV1`，零阶段 AI 每次最多隔离模拟 2 个候选，`simple-v1` 使用完整严格合法动作集合和正式内置决策顺序。

## 结果

总计：`rvb-ai-zimse-v1` 0 胜，`simple-v1` 0 胜，3 平；失败 0，非法/拒绝动作 0。三局均因 `round-limit` 在第 40 个完整回合结束。

| 局 | seed | 零阶段席位 | 结果 | 动作数 | 零阶段决策数 | 节点数 | 候选数 | 决策 P50 | P95 | 最大 |
| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1001 | 红方 | 40 回合平局 | 413 | 111 | 181 | 8,597 | 446.46ms | 1,175.66ms | 1,270.25ms |
| 2 | 1002 | 蓝方 | 40 回合平局 | 549 | 98 | 156 | 10,534 | 410.61ms | 1,883.12ms | 2,030.67ms |
| 3 | 1003 | 红方 | 40 回合平局 | 539 | 88 | 136 | 6,089 | 403.82ms | 1,256.10ms | 1,548.16ms |

零阶段 AI 的 AP 使用量分别为 47、22、8，充能使用量均为 0，每局正式执行 40 次 `endTurn`。测试总耗时 `1106.29s`。

确定性证据：

| 局 | action trace hash | final state hash |
| ---: | --- | --- |
| 1 | `b4170e653112d8a7ded4cb2e20825cd31db95298fe48bf5fe539fde6d598322d` | `e450f55df43c077a3522a05c6b47ea410ab65b61708c76dc5746ecae7cfcf838` |
| 2 | `cb7b175f544e459cffedc4fd5ae0785cf2967eea96e00bed47c939523a003c34` | `caab2dbb484e8508c5ac1c9c45a43ac33f73542b52962ab230c94c708cc4af52` |
| 3 | `530690c360f5c4ca8f064c12a513905e50592c289a295f114ada67034cdfa133` | `512f40e1668695fda770902a52458d6c921416a0ae69c115b83be77c012d5e82` |

## 结论与风险

合法性和实时预算满足合同：非法动作数为 0，单次节点不超过 2，三局最大决策耗时低于 3,000ms。但竞争结果未达到“消除平局”的产品目标：当前 profile 在镜像自战 seed `1001` 可于第 9 回合获胜，面对内置 `simple-v1` 的这三个样本却全部打满 40 回合。

三局中零阶段 AI 的充能使用均为 0，且第 3 局只使用 8 AP；这表明仅提高位置与攻击分项仍不足以保证候选准入能覆盖高价值进攻技能。后续如要继续消除平局，应单独分析三局候选 trace 中被 `candidate-budget` 裁剪的攻击/充能动作，以及普通移动在敌方核心周围的路径收束。三局样本不能代表全部阵容和 seed，也不能据此宣称该 AI 已达到稳定胜率目标。
