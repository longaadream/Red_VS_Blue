# RED-110 实现验证证据

日期：2026-08-27

分支：`codex/RED-110-linear-greedy-training`

基线：`81c754f247b4f627741fbb953df820fdd82ffee2`

## 自动验证

- v1 AI 聚焦回归：7 个文件、64 项通过（linear agent/training/GitHub、environment、planner、self-play、self-play replay）。
- v2 AI 聚焦回归：7 个文件、66 项通过；覆盖 96 局 schedule、单 seed 轮换、启发式中心、`sigma=0.08`、6 进程配置、40 玩家回合裁决、`drawScore=-0.25`、其他硬失败不放行和归档字段。
- v2 类型检查：`next typegen && tsc --noEmit` 通过。
- v2 编码检查：638 个文本文件通过。
- v2 受影响文件定向 ESLint：通过。
- v1 类型检查：`next typegen && tsc --noEmit` 通过。
- v1 编码检查：636 个文本文件通过。
- v1 受影响文件定向 ESLint：通过。
- 全仓库 ESLint：被现有配置阻塞；`import/no-anonymous-default-export` 引用了未注册的 `import` 插件，未产生本次文件诊断。
- main baseline：分支 HEAD 与刷新后的 `origin/main` 均为上述 base SHA，ahead/behind 为 0（提交前）。

## v1 真实规则、3 进程与安全暂停

运行一次 1 对镜像候选、1 seed、1 对手、换边的 4 局 smoke，并使用 3 个独立子进程。训练期间通过独立 `pause` 命令写入持久化暂停请求：

- 主进程在 5 秒轮询内识别请求并停止派发；
- 已派发的 3 局自然结束后逐局写入 checkpoint；
- 第 4 局没有派发；
- 最终状态 `paused`，`completedGeneration=0`；
- `activeGeneration.matches=3`，3 局均保存最小复现；
- 中心权重相对 seed agent 的差异数为 0；
- `optimizerState` 未前进一步。

三局都在 480 动作上触发 `action-budget` 硬门禁。这验证了预算失败不会更新权重，同时说明当前一阶初始权重可能无法在正式预算内终局。最终实现会把该代停在 `paused`，人工处理后 `resume` 只重跑失败局。

本次 smoke 的三局并行墙钟约 15.5 分钟；单局约 9–15.5 分钟。按 v1 的 192 局、3 进程外推，一代保守估计约 10–18 小时。该数字只代表当前开发机和初始候选。

## v1 正式运行中断证据

旧运行目录 `output/ai-training/red-110-linear-greedy-v1` 保留为本地证据，不会恢复或混入 v2：

- schedule 为 192 局，完成 14 局；W/D/L 为 1/4/0，另有 9 个 `action-budget` 硬失败；
- `completedGeneration=0`，没有 archive，中心权重与 Adam step 没有更新；
- 最后 checkpoint 为 2026-08-27 14:48:24（Asia/Shanghai），最后 pause request 为 14:56:15；
- 原训练父进程与 worker 已不再运行。磁盘上的 `running` 和 3 个 active worker 是最后一次快照，不代表仍有活进程；
- v1 的 code/config/schedule hash 与 v2 不同，v2 使用全新的 runId 与目录，兼容性门禁也会拒绝直接续跑。

## v2 加速方案

- 24 候选、1 个按代轮换的 training seed、1 阵容、2 对手、换边，固定 96 局；
- 默认 6 个独立子进程，进程内并发仍为 1；
- 双方累计超过 40 个玩家行动回合时，只有 `turn-budget` 转换为训练裁决平局并计 `-0.25`；其他失败继续阻止更新；
- 初始中心采用方向明确的启发式权重，首代 `sigma` 从 0.15 降为 0.08；
- 局数减半、回合预算减半、进程数加倍，理想墙钟约为 v1 的四分之一；保守预计 2.5–5 小时，正式运行首批结果将提供动态 ETA。

## v2 真实规则 smoke

在临时目录运行 1 对镜像候选、1 seed、1 对手、换边的 4 局 smoke，使用 3 个独立子进程：

- 4/4 均以 `turn-budget` 结束，并被明确记录为 `turn-limit-draw`；W/D/L 为 0/4/0，裁决平 4，硬失败 0；
- 归档 `drawScore=-0.25`，两个候选 fitness 均为 -0.25；
- `totalMatches=4`、`completedGeneration=1`、Adam step=1，完成后状态为 `awaiting-user`，没有自动开始下一代；
- 四局累计 CPU 对局耗时 1,342,143 ms，3 进程墙钟约 7 分 50 秒；其中首批三局约 7 分 11–16 秒，第四局约 39 秒；
- smoke 证据目录：`C:\Users\zimse\AppData\Local\Temp\rvb-linear-smoke-1787814898418`（临时本地证据，不提交 GitHub）。

## CLI 初始化与快照

最终实现使用临时目录执行 `init` 和 `status`：

- 初始状态是 `awaiting-user`、generation 0；
- `progress.json` 包含 W/D/L、hard-gate failures、active workers、elapsed/ETA 所需累计耗时、GitHub sync 和 checkpoint 路径/完成局数/保存时间；
- config、seed agent、对手和 roster 均进入 `trainingConfigHash`；活动代恢复时重算 schedule commitment。

## 尚需独立验收

风险等级为 Medium。实现者未作为独立验证者批准自己的修改。PR 需要另一 AI 或人工按 RED-110 合同审查；真实 v2 第 1 代可在 smoke 后人工启动，不要求本实现任务等待完整 96 局结束。人工审查应特别检查单 seed 方差、负平局分是否诱导冒险，以及训练裁决没有进入正式游戏规则层。
