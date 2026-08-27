# 一阶线性贪心 PvE AI 训练（RED-110）

状态：实现稿

训练 run schema：`1`

特征 schema：`1`

## 1. 目标与边界

一阶 AI 将当前玩家可见的静态局面压缩为 17 维固定向量，以各维加权和评价局面。每次只通过 `aiEnvironmentV1` 取得合法动作和隔离模拟结果，选择一步后分数最高的动作；不复制规则，不读取对手手牌身份，不做多步搜索，也不学习特征之间的交互。

本任务只实现离线训练、检查点、进度和分代归档。它不接入在线房间，不修改核心玩法、随机算法、存档或经济系统，也不自动连续训练或自动晋升 AI。

## 2. 特征与决策

特征定义和固定顺序位于 `lib/game/ai-linear-features.ts`，包括核心存活/血量、存活单位、总血量、攻击、防御、护盾、增益/减益、技能就绪、行动点、蓄力点、手牌数量、交战距离、核心安全和行动方。除常数项外均归一化到 `[-1, 1]`。

候选动作按稳定 ID 打破同分。终局胜负优先级高于普通分数。单个局面合法候选过多时，保留结构动作和结束回合，再按动作类别稳定轮转抽取至 `maxCandidatesPerAction=16`；所有被裁掉的合法候选都写入决策 trace，原因是 `candidate-budget`。

## 3. 一代的固定样本

正式配置位于 `config/ai/linear-training-v1.json`。每代规模是：

```text
24 个候选（12 组正负镜像扰动）
× 2 个训练 root seed
× 1 个本代固定阵容
× 2 个固定对手
× 2 个座位（红蓝换边）
= 192 局
```

每局都在独立子进程和独立初始状态中运行。换边 pair 有意复用同一个 root seed，以抵消先后手和出生侧噪声；这不是共享运行时或共享随机游标。阵容按代在 alpha/beta 间轮换，seed 从训练分区按代轮换；训练过程不接触公开验证或外部 holdout seed。

候选以 `center ± sigma × epsilon` 成对生成。全部 192 局有效后，先按候选总成绩做带并列平均的 centered rank，再用镜像差估计梯度，最后执行一次确定性 Adam 更新。缺局、重复局或硬失败时禁止更新权重。

## 4. 预算与硬失败

非法/拒绝动作、规则或 agent 异常、状态循环、无动作，以及每局动作、每回合动作、回合和单动作节点预算失败都进入现有硬门禁并保存最小复现。含硬失败的一代停在 `paused`，中心权重和 Adam step 均不改变；修复原因或调整训练预算后执行 `resume`，只重跑失败局，已经通过的局不重复。

低阶 AI 可能在 480 动作或 80 回合内无法自然终局。当前合同不允许用局面分数替代真实胜负；若实测经常耗尽预算，应另建任务评审公开局面裁决或次级 fitness，不能在本训练器中静默把失败改成平局。

## 5. 人工逐代工作流

首次创建训练档案，不会自动开跑：

```powershell
npm.cmd run ai:train:linear:init
```

人工明确要求下一代时，只运行一代并退出：

```powershell
npm.cmd run ai:train:linear:next
```

训练中查看一次或持续查看进度：

```powershell
npm.cmd run ai:train:linear:status
npm.cmd run ai:train:linear:status -- --watch
```

请求安全暂停；主进程停止派发新局，最多等待当前 3 个在途子进程自然结束后留档：

```powershell
npm.cmd run ai:train:linear:pause
```

恢复同一代：

```powershell
npm.cmd run ai:train:linear:resume
```

快速验证真实规则和 4 局调度（使用正式预算，不能作为训练证据）：

```powershell
npm.cmd run ai:train:linear:smoke -- --no-github-sync
```

每局结束原子覆盖 `run.json`，每 5 秒覆盖 `progress.json`，事件追加到 `events.ndjson`，完整对局追加到 `generation-NNNN/matches.ndjson`。恢复必须匹配代码、规则、内容、特征 schema、训练配置和赛程 commitment；不允许拿不同实现静默续跑旧代。

`status` 和 `pause` 不受源码 hash 门禁阻止：即使训练期间工作树变化，仍可查看旧进程写出的快照并请求其安全停机。`resume`、`next` 和 `sync` 继续严格校验所有 hash。

## 6. GitHub 分代同步

正式配置默认启用同步，只允许分支 `codex/RED-110-linear-greedy-training`，禁止 main。完整原始对局保留本机；GitHub 只提交 `docs/qa/evidence/linear-ai/red-110-linear-greedy-v1/latest.json`，其中包含 hash、中心权重、优化器状态、代际承诺、样本、胜负、梯度和耗时汇总。

每代完成或安全暂停后自动提交并 push。同步失败会记录为 `pending`；在成功执行下列命令前，禁止开始下一代：

```powershell
npm.cmd run ai:train:linear:sync
```

## 7. 算力与时间

算法主要消耗 CPU；每个候选动作都要复制并模拟一个规则状态。3 个子进程近似占用 3 个 CPU 核心，并近似线性增加内存。2026-08-27 在当前开发机、16 候选上实测，三局并行、每局走满 480 动作约 15.5 分钟墙钟，单局约 9–15.5 分钟。因此 192 局的一代保守预计约 10–18 小时；真实终局比例、对手动作成本和 CPU 会显著影响结果。首批完整局落盘后，CLI 使用实际单局耗时和进程数刷新 ETA。

设备没有完整时间窗口时应使用安全暂停。突然断电或直接杀进程最多丢失尚未完成的 3 局；已落盘局和上一代权重不会丢失，也不会产生半代权重。

## 8. 人工验收与后续评估

每代结束后人工检查：192/192、硬失败为 0、两 seed/两对手/换边覆盖完整、Adam step 只增加 1、GitHub 状态为 synced。训练若连续多代几乎全是平局，应另建任务评审终局能力或次级 fitness；不得只增加算力掩盖无信号。

训练出的中心权重仍只是候选。至少还要在未参与优化的公开验证 seed 上运行固定基线，检查胜率、换边差、非法率、预算结束率和回放，再由人工决定是否更新正式 AI 档案。

## 9. 回退

停止训练进程并保留 `output/ai-training/` 作为诊断证据；revert RED-110 的线性 agent、训练器、脚本、配置、测试和文档。该功能不修改玩家存档、在线协议、玩法数据或随机算法，不需要数据迁移。
