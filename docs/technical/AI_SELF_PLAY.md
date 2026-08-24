# 离线自博弈、历史对手联赛与评估基线（RED-87）

状态：实现稿
报告 schema：`1`

## 1. 边界

`lib/game/ai-match-runner.ts` 是纯离线比赛控制器。它只消费 `aiEnvironmentV1` 的权威候选与隔离 transition，不复制移动、技能、资源、终局或随机规则，不保存房间、不广播、不访问网络或数据库。正式客户端、房间、WebSocket、存档和玩法数据不依赖此模块。

比赛控制器支持三类版本化 agent 档案：

- `simple`：保留的简单 AI 只提供偏好顺序，实际提交必须匹配当前权威合法候选；
- `planner`：RED-86 通用规划器每次只提交 `nextAction`，成功后在新状态上重规划；
- `legal-random`：按 root seed、agent config hash、状态和决策序号稳定选择合法候选，仅用于测试。

部署锁定、唯一 phase advance 和唯一 pending 候选是比赛结构动作；控制器仍从环境取得这些候选，不自行构造命令。部署阶段按第一个尚未锁定的玩家执行，pending 阶段按会话 owner 执行，普通回合按 `turn.currentPlayerId` 执行。

“每回合动作预算”只统计 agent 选择的非结构动作。唯一 deployment lock、phase advance 或 pending continuation 不消耗此预算，但仍受每局动作、回合与重复状态门禁；Simple 和 legal-random 在最后一个策略动作槽位优先提交权威合法的 `endTurn`。

## 2. 版本化配置与历史档案

配置位于 `config/ai/`：

- `seeds.v1.json`：训练、公开验证与外部保密候选 seed 三层；
- `agents/*.json`：完整、自包含的 agent 版本与 resolved planner config；
- `rosters/*.json`：版本化固定阵容；
- `suites/*.json`：候选、历史/基准对手池、阵容组合和确定性预算。

报告会内嵌 agent 与 roster 快照，并记录每个 `agentConfigHash`。旧报告回放只依赖这些快照、代码 commit、rules/content hash、root seed 和同一权威环境；删除或修改“最新 agent”配置不会改变旧报告的档案。历史冠军必须显式标记 `historical: true`，套件没有历史对手时失败关闭。

## 3. Seed 隔离

训练和公开验证 seed 以互斥数组提交。保密候选 seed 不进入仓库配置；提交的配置只声明 `source: external`。候选评估必须通过私有 `--holdout-file` 同时提供 seed 和 commitment，runner 验证：

1. seed 是唯一的 uint32；
2. 不与训练或公开验证集合重叠；
3. `hashStable(seeds)` 等于私有 commitment。

优化流程不得传入 `--holdout-file`。保密报告本身包含最小复现 seed，必须存放在受限输出位置，不提交仓库。

## 4. 成对比赛与确定性

每个 `opponent × lineup × seed` 自动生成一个 pair：

1. 候选在 `player-red`，对手在 `player-blue`；
2. agent 与其阵容整体交换座位，root seed 和 lineup 不变。

固定基准使用显式 `firstPlayerId: player-red` 和确定性部署。交换座位因此同时交换 agent 的先后手/出生侧影响。每个动作记录 action hash、正式 transition hash、正式 state hash、结构化 trace hash、决策 trace hash、动作序号、回合、agent 版本和决策节点数。整局输出 action trace hash、state trace hash 与终局 hash；重复运行比较这些确定性字段，不比较墙钟耗时。

## 5. 硬门禁与汇总

以下任一情况使整套候选硬门禁失败并保存最小复现：

- 权威 transition 拒绝；
- 规则或 agent 异常；
- 已接受动作回到已访问的完整 state hash；
- 超过每局动作、每回合动作、回合或单次决策节点预算；
- 有合法对局状态但 agent 没有下一动作。

只有所有比赛合法并终止后，状态才是 `eligible-for-human-review`。这不是自动晋升。竞争证据至少同时包含胜负矩阵、座位/阵容/seed 拆分、最差对局、非法动作率、终止/预算统计和决策节点统计；不得只凭单一 Elo 宣布通过。

## 6. 逐局进程隔离、进度与恢复

当前 TriggerSystem、RuleRuntime 活跃作用域和动态代码缓存仍是模块级进程状态。RED-84 的同步 `runBattleActionIsolated()` 会在每次 transition 后恢复 TriggerSystem，编译缓存只复用不可变函数；测试证明连续成对比赛的 trace/终局 hash 一致，sentinel Rule 限制不变化，第二次运行不产生新的编译缓存身份。

CLI 不在同一个运行时中并发规则归约，而是把确定性 schedule 拆成“每个子进程只跑一局”：

- 默认 `--processes 1`，上一局子进程退出并释放模块缓存与动作状态后才启动下一局；
- `--processes N` 只并发 N 个相互隔离的子进程，每个子进程内部始终 `inProcessConcurrency=1`；
- 父进程按原 schedule 稳定排序汇总，不按子进程完成顺序改变报告；
- 每 20 个已接受动作输出局号、动作预算、回合、已用时间和 ETA；
- 每局完成后覆盖写入 `*.checkpoint.json`。中断后用 `--resume <checkpoint>` 只补未完成局；检查点必须匹配 commit、rules/content hash、seed 和档案 commitment，否则失败关闭。

并行数会近似线性增加峰值内存。16 GiB 开发机人工验收建议保持默认 `--processes 1`；`--processes 2` 仅用于有余量时缩短完整基线时间。

## 7. 命令与产物

人工快速验收（一个固定 opponent/lineup/seed，自动红蓝换边，共 2 局）：

```powershell
npm.cmd run ai:self-play:smoke
```

`human-smoke-v1` 的版本化 manifest 标记 `evaluationScope: smoke`；通过时机器报告状态是 `smoke-passed`。它只验收真实规则环境、逐局隔离、进度、检查点和成对报告链路，不能代替 12 局固定基线，也不能作为候选晋升证据。

运行 12 局固定公开基准：

```powershell
npm.cmd run ai:self-play
```

可选参数：

```powershell
npm.cmd run ai:self-play -- --suite config/ai/suites/fixed-baseline-v1.json --seeds 2001 --output output/ai-self-play/manual.json
npm.cmd run ai:self-play -- --processes 2
npm.cmd run ai:self-play -- --resume output/ai-self-play/manual.checkpoint.json
npm.cmd run ai:self-play:report -- output/ai-self-play/manual.json --output output/ai-self-play/manual.md
```

命令在无 UI、网络和数据库环境中动态打包 Node runner，写出：

- 完整版本化 JSON 报告；
- 每局一行的 `*.matches.ndjson` 原始记录；
- 只含矩阵、门禁和性能的 `*.summary.json`。
- 可中断恢复的 `*.checkpoint.json`，其中仅保存已经完整结束的局。

默认输出位于 `output/ai-self-play/`，文件以独占创建方式写入，不覆盖旧报告。大体积报告、私有 seed 和训练产物不得提交仓库。

## 8. 性能证据

报告记录 OS/架构、Node、CPU、内存、真实进程数、总耗时、transition/s、games/min、最慢 fixture 与观察到的瓶颈。不设未经实测确认的性能目标。首次固定基准的原始数值记录在 RED-87 PR 验证证据中，文档只描述口径，避免把某台机器的结果变成跨设备门槛。

## 9. 将指定对局导出为 Trace v2（RED-103）

查看报告内的对局：

```powershell
npm.cmd run ai:self-play:export -- output/ai-self-play/manual.json --list
```

按 1-based 序号或精确 `matchId` 导出一局：

```powershell
npm.cmd run ai:self-play:export -- output/ai-self-play/manual.json --match 1 --output output/ai-self-play/match-1.trace.json
npm.cmd run ai:self-play:export -- output/ai-self-play/manual.json --match pair-example-seat-1 --output output/ai-self-play/match-seat-1.trace.json
```

导出器只读取报告中已记录的动作，不调用当前 agent 重新选招。它使用与自博弈相同的 `createSelfPlayInitialState()` 和 `aiEnvironmentV1` 权威 transition，逐步核对 accepted、action/state/transition/trace hash，最后核对 action/state trace、final state 与终局信息。只有全部证据一致时，才调用 RED-94 的共享 `createTraceRecord()`/`assertTraceRecord()` 生成 `rvb-match-trace/v2`。

版本门禁失败关闭：报告 schema 必须是 1；rules/content tree hash 必须与当前工作树一致；报告 Git commit 必须在本仓库可解析，且当前 `lib/game/**` 权威实现相对该提交没有变化。`ai-self-play-replay.ts` 和 `ai-self-play-setup.ts` 是纯离线导出适配层，不计入旧报告的权威代码差异。Git 证据缺失、工作树存在其他未跟踪 game 代码或任一版本/hash 不匹配时不导出。

输出文件使用独占创建，不覆盖已有文件。Trace 的 `source` 只记录报告 hash、suite、matchId、seed、换座、agent/roster ID 与版本、agent config hash 和原始终局 hash；不写入报告路径、环境变量、令牌或其他敏感字段。相同报告和 match 重复导出时，`exportedAt` 可不同，初始状态、帧、事件、内容快照和完整性 hash 必须一致。

真实 human-smoke 验收应同时导出 181 步和 137 步两局，并至少把一局拖入开发者中心：

1. 导入后摘要命令数等于报告动作数；
2. 打开现有回放页，验证棋盘、上一/下一步、时间轴、0.5×/1×/2×/4× 和红/蓝/全知视角；
3. 跳到末帧，终局与原报告 winner/reason/finalStateHash 一致；
4. 再次导出到同一路径应非零退出且原文件保持不变。

## 10. 当前自我迭代边界

当前系统已经具备离线确定性自博弈、换座配对、历史对手档案、胜负矩阵、多维拆分、硬门禁、进度恢复和可视化复盘，因此有“自博弈联赛基础设施”的形态。它不会自动训练或修改 AI：不会自动选择并保存新冠军，不会自动调整 planner 权重，也不会在后台连续生成候选。`eligible-for-human-review` 只表示合法性与终止性门禁通过；历史冠军档案、候选配置和 suite 仍由开发者显式版本化并审核。CMA-ES、进化策略、MAP-Elites、PBT、PPO/MCTS 或其他优化循环属于后续任务。

## 11. 回退

整体 revert `ai-match-runner`、两个 CLI、`config/ai/**`、测试、ADR 和本文档。报告与失败 seed 保留在受控输出位置；没有玩家存档、玩法数据、随机算法、网络协议或客户端迁移需要逆向转换。
