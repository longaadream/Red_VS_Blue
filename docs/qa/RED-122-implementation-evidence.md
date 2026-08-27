# RED-122 实现验证证据

任务：实现零阶段启发式局面估价与双层潜力 AI 基线

角色：实现者（Codex），等待独立 QA 与人工验收

分支：`codex/RED-122-zero-stage-ai`

基线：`main@81c754f247b4f627741fbb953df820fdd82ffee2`

PR 前同步基线：`origin/main@e32b80c802dcf2da936be128d8635a8d23284c73`（个人分支已 rebase；期间进入主线的内容管线与 RED-120 角色文件均不与 RED-122 路径重叠）

## 实现范围

- 新增只读取公开 `AIObservation` 的静态估价 `F_p(S)`，包含终局、核心/普通存活、生命、资源、可行动性、威胁、斩杀、公开状态、阵型和地图控制分项。
- 新增 `aiPotentialEnvironmentV1`：只在隔离视图中补足动作所需 AP/充能，并用权威候选重新证明除费用外仍然合法。
- 新增 `planZeroStageAction()`：对每个严格合法外层动作计算后继 `F` 与最多三项费用放宽后续潜力 `G`，只返回一个可提交动作。
- 新增稳定 tie-break、节点预算、完整候选/费用/惩罚/拒绝诊断和 `zeroStageDecisionTraceHash()`。
- 新增版本化 `zero-stage-v1` profile、技术说明、ADR 和 RED-86 player-level 入口说明。

未修改规则、数值、随机、UI、网络、房间、存档、训练器或 RED-110 产物。

## 验收证据

| 合同项 | 证据 |
| --- | --- |
| 最终动作严格合法 | 24 个固定样本覆盖双方座位和 3–5 人阵容，正式候选包含所选 ID，正式隔离 transition 拒绝数为 0。 |
| 无动作/终局安全停止 | fixture 返回 `nextAction: undefined` 和明确 `terminal` / `no-legal-actions`。 |
| 显式玩家视角 F | 红蓝镜像分项符号一致；终局固定为 `+1,000,000/-1,000,000/0`。 |
| 隐藏信息隔离 | 修改对手私有手牌 ID、实例 ID、描述和 `visible:false` 状态后，公开评分完全不变。 |
| 费用放宽只突破费用 | AP=0 时正式环境不含 `basic-attack`；精确补贴 1 AP 后权威枚举出现，冷却中的同一技能仍不出现。 |
| 状态不污染/资源不为负 | 反事实模拟前后输入 `BattleState` hash 和 AP 不变；模拟后 AP/充能非负。 |
| G 的 0/1/2/3+ 项 | 独立测试覆盖 fallback、前缀权重归一化、前三项排序和第四项剔除。 |
| 胜负、斩杀与防守 | 正式 `basic-attack` 核心斩杀优先于移动/endTurn；公开核心处于立即受斩杀风险时选择解除风险的候选。 |
| 确定性 | 相同 state/player/rootSeed/profile 的候选顺序、决策 trace hash 和所选 transition hash 重复一致。 |
| 一次只返回一个动作 | `ZeroStageDecision` 只有唯一 `nextAction`；文档要求权威接受后在新状态重新调用。 |
| 节点预算 | 默认 `nodeBudget=10,000`；测试收紧为 2 时仍为每个外层合法动作保留节点，并将后续记录为 `node-budget`。 |
| 调试证据 | trace 包含外层 `F/G`、V1/V2/V3、真实成本、后续短缺、突破标志、λ、兼容性、拒绝/裁剪原因、节点和候选数。 |

## 性能与固定样本

命令：

```text
npm.cmd test -- tests/game/ai-zero-stage.test.ts --reporter=verbose
```

最终记录：

```text
[RED-122 performance] samples=24 seats=2 roster=3-5 illegal=0
nodes=640 candidates=640 p50Ms=116.90 p95Ms=198.47
```

该数据是当前开发机上的小型固定 fixture 基线，不代表所有地图和内容的线上延迟上限。默认节点预算未触发裁剪。

## 测试结果

通过：

- 修改前基线：AI environment/planner/isolation，3 files / 29 tests。
- 测试先行证据：新测试首次以缺少 `ai-zero-stage-evaluator` 失败。
- `npm.cmd test -- tests/game/ai-zero-stage.test.ts --reporter=verbose`：1 file / 12 tests。
- `npm.cmd test -- tests/game/ai-zero-stage.test.ts tests/game/ai-environment.test.ts tests/game/ai-planner.test.ts tests/game/ai-isolation.test.ts`：4 files / 41 tests。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run check:encoding`：通过，705 个文本文件。
- rebase 到最新 `origin/main` 后执行 `npm.cmd test`：105 files / 929 tests 全部通过。
- `git diff --check`：通过，仅报告仓库既有 CRLF 转换提示。
- `npm.cmd run check:main-baseline`：分支创建后通过；PR 前发现 main 前进 4 个提交，rebase 后重新执行合同测试和基线检查。

未通过：

- `npm.cmd run lint`：ESLint 在加载配置阶段失败，提示未注册插件 `import/no-anonymous-default-export`；未进入本次文件检查。依赖/ESLint 配置不在 `allowed_paths`，未越界修复。

首次 rebase 前曾有一次全量运行在范围外 `tests/game/battle-authority-async-sqlite.test.ts` 的 2000ms SQLite 锁恢复等待上失败；未通过重复运行掩盖。同步最新 main 后按合同重新运行的完整 105/105 files、929/929 tests 已通过。

Vitest 每次同时提示 Vite native config 的未来兼容警告；不影响当前测试结果，且配置路径不在本任务范围。

## 已知风险与人工验证

- v1 不搜索敌方回合，是双层己方潜力而非 minimax。
- 布尔 λ 不区分短缺量，但 trace 已保存 AP/充能短缺供后续校准。
- 高分支局面可能触及节点预算；所有裁剪均稳定、可见，但需用真实复杂地图继续测量。
- profile 尚未注册 self-play archive、在线 PVE 或 UI；合同明确排除这些路径，应另建接入任务。
- ADR-0012/0013 在仓库仍标为“提议中”，但对应接口已经由已完成 Linear 前置任务落地；RED-122 只消费现有接口，未修改其状态。
- Medium Risk 仍需另一 AI 或人工独立审查。建议人工查看立即斩杀、低血防守、AP 不足潜在动作和高分支局面的 trace 是否符合产品直觉。

## 回退

整体 revert RED-122 的 evaluator、agent、profile、费用适配、测试和文档；现有 simple/planner 不需要迁移，玩家存档、玩法数据、网络协议和 RNG 均未改变。失败 trace 和固定 seed 证据应保留供诊断。
