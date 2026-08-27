# RED-110 实现验证证据

日期：2026-08-27

分支：`codex/RED-110-linear-greedy-training`

基线：`81c754f247b4f627741fbb953df820fdd82ffee2`

## 自动验证

- AI 聚焦回归：7 个文件、64 项通过（linear agent/training/GitHub、environment、planner、self-play、self-play replay）。
- 类型检查：`next typegen && tsc --noEmit` 通过。
- 编码检查：636 个文本文件通过。
- 受影响文件定向 ESLint：通过。
- 全仓库 ESLint：被现有配置阻塞；`import/no-anonymous-default-export` 引用了未注册的 `import` 插件，未产生本次文件诊断。
- main baseline：分支 HEAD 与刷新后的 `origin/main` 均为上述 base SHA，ahead/behind 为 0（提交前）。

## 真实规则、3 进程与安全暂停

运行一次 1 对镜像候选、1 seed、1 对手、换边的 4 局 smoke，并使用 3 个独立子进程。训练期间通过独立 `pause` 命令写入持久化暂停请求：

- 主进程在 5 秒轮询内识别请求并停止派发；
- 已派发的 3 局自然结束后逐局写入 checkpoint；
- 第 4 局没有派发；
- 最终状态 `paused`，`completedGeneration=0`；
- `activeGeneration.matches=3`，3 局均保存最小复现；
- 中心权重相对 seed agent 的差异数为 0；
- `optimizerState` 未前进一步。

三局都在 480 动作上触发 `action-budget` 硬门禁。这验证了预算失败不会更新权重，同时说明当前一阶初始权重可能无法在正式预算内终局。最终实现会把该代停在 `paused`，人工处理后 `resume` 只重跑失败局。

本次 smoke 的三局并行墙钟约 15.5 分钟；单局约 9–15.5 分钟。按 192 局、3 进程外推，一代保守估计约 10–18 小时。该数字只代表当前开发机和初始候选，CLI 会在正式训练中按已完成局耗时刷新 ETA。

## CLI 初始化与快照

最终实现使用临时目录执行 `init` 和 `status`：

- 初始状态是 `awaiting-user`、generation 0；
- `progress.json` 包含 W/D/L、hard-gate failures、active workers、elapsed/ETA 所需累计耗时、GitHub sync 和 checkpoint 路径/完成局数/保存时间；
- config、seed agent、对手和 roster 均进入 `trainingConfigHash`；活动代恢复时重算 schedule commitment。

## 尚需独立验收

风险等级为 Medium。实现者未作为独立验证者批准自己的修改。PR 需要另一 AI 或人工按 RED-110 合同审查；真实第 1 代可在 smoke/PR 后人工启动，不要求本实现任务等待 192 局结束。
