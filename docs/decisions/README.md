# 产品与技术决策记录

状态：有效  
负责人：项目负责人

本目录用于保存重要产品与技术决策，避免项目成员或 AI 重复讨论、推翻或遗忘已经确定的方向。

这里记录“为什么这样决定”，不用于代替详细设计文档。

## 何时需要记录决策

出现以下情况时，应建立一份 ADR：

- 修改核心游戏规则或胜负条件。
- 调整重要经济系统或数值原则。
- 改变游戏状态的主要数据结构。
- 改变模块边界或公共接口。
- 选择或替换关键依赖。
- 修改存档格式或迁移策略。
- 调整随机系统和可复现策略。
- 引入新的全局状态来源。
- 改变构建、发布或更新方式。
- 做出会影响多个模块的长期选择。

普通 Bug 修复、文字修改和局部 UI 调整通常不需要 ADR。

## 文件命名

使用连续编号和简短名称：

- `ADR-0001-game-state-source.md`
- `ADR-0002-seeded-random.md`
- `ADR-0003-save-versioning.md`

编号一旦使用，不得重新分配。

## ADR 模板

每份决策记录包含：

### 标题

用一句话说明决策主题。

### 状态

使用以下状态之一：

- 提议中。
- 已接受。
- 已取代。
- 已废弃。

### 日期

记录决定日期。

### 背景

说明遇到了什么问题、为什么必须作出决定，以及现有约束。

### 决策

明确写出最终采用的方案。

### 备选方案

列出认真考虑过的其他方案，以及没有采用的原因。

### 影响

记录该决定的收益、成本、风险和受影响模块。

### 验证方式

说明如何判断这项决定实施正确。

### 回退方式

说明出现问题时如何撤销或迁移。

### 相关资料

关联 Linear 任务、PR、产品文档、技术文档和测试记录。

## 管理规则

- AI 可以起草 ADR，但不能自行批准重大决策。
- ADR 必须与对应代码或方案通过 PR 审查。
- 已接受的 ADR 不应直接重写结论。
- 如果方向发生变化，应创建新的 ADR，并将旧 ADR 标记为“已取代”。
- 相关模块文档应链接到对应 ADR。
- Linear 高风险任务应引用相关决策记录。
- [`ADR-0020-unified-player-websocket-transport.md`](./ADR-0020-unified-player-websocket-transport.md)：Windows 玩家业务统一使用 WebSocket，旧玩家 REST 运行时返回 410（RED-127，已接受）。
- 无法确定的事项应保持“提议中”，不得描述为已经确认。

## 当前已确定的基础决策

- [`ADR-0001-deployment-visibility.md`](./ADR-0001-deployment-visibility.md)：legacy 部署重投阶段公开双方站位（新建对局由 ADR-0024 取代）。
- [`ADR-0002-match-identity-model.md`](./ADR-0002-match-identity-model.md)：分离对局座位、内容阵营、所有权与先后手。
- [`ADR-0003-electron-server-packaging.md`](./ADR-0003-electron-server-packaging.md)：保留 Electron Server 内部候选打包入口的历史边界（RED-23，已由 ADR-0021 取代）。
- [`ADR-0004-deterministic-rule-runtime.md`](./ADR-0004-deterministic-rule-runtime.md)：权威规则使用根种子、命名随机流、确定性实例 ID 与逻辑时钟（RED-28，已接受）。
- [`ADR-0004-battle-presentation-boundary.md`](./ADR-0004-battle-presentation-boundary.md)：定义战场 Three.js、DOM HUD、展示模型与用户意图的单向边界（RED-48，提议中）。
- [`ADR-0005-authoritative-target-selection.md`](./ADR-0005-authoritative-target-selection.md)：提议以纯查询、精确候选和版本凭证统一 UI、AI 与服务端目标语义（RED-59）。
- [`ADR-0006-combat-trigger-ordering.md`](./ADR-0006-combat-trigger-ordering.md)：统一战斗触发器的跨类别稳定排序（RED-61，已接受）。
- [`ADR-0007-deterministic-deployment.md`](./ADR-0007-deterministic-deployment.md)：legacy 固定全地图部署、核心身份与玩家独立重投流（RED-29，已接受；新建对局由 ADR-0024 取代）。
- [`ADR-0008-rule-status-authority.md`](./ADR-0008-rule-status-authority.md)：Rule + statusTag 是棋子效果唯一权威架构，移除 AttachedEffect（RED-80，已接受）。
- [`ADR-0009-venom-demo-admission.md`](./ADR-0009-venom-demo-admission.md)：将毒液准入 Demo v0.1 暗方候选池（RED-89，已接受）。
- [`ADR-0010-deterministic-damage-batches.md`](./ADR-0010-deterministic-damage-batches.md)：单体与多目标伤害统一使用确定性 batch 和动作内连锁（RED-33，已接受）。
- [`ADR-0028-hand-card-friendly-kill-charge.md`](./ADR-0028-hand-card-friendly-kill-charge.md)：手牌友军击杀使用显式出牌玩家归属提供充能，保留 `noKillCharge` 例外（RED-183，已接受）。
- [`ADR-0011-authoritative-terminal-settlement.md`](./ADR-0011-authoritative-terminal-settlement.md)：服务端在完整动作后一次性提交终局，客户端只显示结果（RED-34，已接受）。
- [`ADR-0012-ai-observation-semantics.md`](./ADR-0012-ai-observation-semantics.md)：版本化 AI 观察、机制语义与候选动作特征合同（RED-85，提议中）。
- [`ADR-0013-headless-ai-environment.md`](./ADR-0013-headless-ai-environment.md)：提议以版本化 observation、完整候选和隔离 transition 统一通用 AI 的规则消费边界（RED-84）。
- [`ADR-0014-authoritative-growing-turn-timer.md`](./ADR-0014-authoritative-growing-turn-timer.md)：服务端权威成长型回合计时、快速烧绳与连续超时投降（RED-36，提议中）。
- [`ADR-0015-authoritative-pending-interaction-lifecycle.md`](./ADR-0015-authoritative-pending-interaction-lifecycle.md)：统一 option/target 会话凭证、取消语义、规则队列续接与不支持调用点的失败关闭（RED-97，提议中）。
- [`ADR-0016-trace-v2-recorded-state-replay.md`](./ADR-0016-trace-v2-recorded-state-replay.md)：Trace v2 使用记录状态而非重跑当前规则（RED-94，已接受）。
- [`ADR-0017-offline-self-play-league.md`](./ADR-0017-offline-self-play-league.md)：离线成对自博弈使用不可变历史档案、seed 分层和合法性/终止性硬门禁（RED-87，提议中）。
- [`ADR-0018-content-pipeline-v1.md`](./ADR-0018-content-pipeline-v1.md)：已接受以统一开放包、确定性 Resolved Profile 与声明式 PVE 合同支撑第一方和社区内容管线（RED-111、RED-113）。
- [`ADR-0019-selectable-demo-maps.md`](./ADR-0019-selectable-demo-maps.md)：正式 Demo 使用受控四图目录、房间冻结选择并在所有传输边界失败关闭（RED-119，已接受）。
- [`ADR-0021-autonomous-server-operations.md`](./ADR-0021-autonomous-server-operations.md)：Windows 自治 Server 的公开发行、受信本地运维、备份更新与回退边界（RED-140，已接受；取代 ADR-0003）。
- [`ADR-0022-deterministic-effect-batch-queues.md`](./ADR-0022-deterministic-effect-batch-queues.md)：只允许 Damage、Heal、Summon、Death 使用确定性 Batch，并以动作级共享 FIFO 调度后续效果（RED-139，已接受）。
- [`ADR-0023-colyseus-postgresql-player-authority.md`](./ADR-0023-colyseus-postgresql-player-authority.md)：默认玩家房间与战斗权威迁移到 Colyseus，PostgreSQL 使用有界微批与关键边界耐久化（RED-160、RED-161，已接受并合入）。
- [`ADR-0024-progressive-reserve-deployment.md`](./ADR-0024-progressive-reserve-deployment.md)：新建对局默认使用 seeded 三选一预备区部署、安全落位与部署当回合首次普通移动免费（RED-138，已接受，等待实现验收）。
- [`ADR-0025-colyseus-postgresql-authority.md`](./ADR-0025-colyseus-postgresql-authority.md)：Colyseus 房间权威、PostgreSQL 有界微批耐久、SQLite 离线迁移与 Windows/K8s 双部署边界（RED-159，已接受；已按 RED-160/161 落地校准）。
- [`ADR-0026-dark-character-target-rules.md`](./ADR-0026-dark-character-target-rules.md)：以 statusTag/rule 表达【灵压】，并定义秘密状态、单体技能目标改写与 DeathBatch 复活结果（RED-163，已接受）。
- [`ADR-0027-colyseus-single-session-match-lifecycle.md`](./ADR-0027-colyseus-single-session-match-lifecycle.md)：Colyseus 原生单会话重连、Room clock、精确 receipt 查询和本机 authority 失败边界（RED-170，已接受）。

以下内容目前作为项目基础方向，后续可根据最新代码分别建立正式 ADR：

- GitHub 作为代码、PR、构建和发布记录的主要平台。
- Linear 作为需求、进度、风险和版本管理平台。
- 仓库内 Markdown 作为长期知识库。
- `main` 分支禁止直接推送。
- AI 可以分析、实现、测试和创建 PR，但不能自行合并或发布。
- 单人开发时，同一个人可以负责开发和人工验收。
- 核心规则应逐步与 UI 和 Electron 系统能力解耦。
- 游戏随机行为应逐步支持固定种子和重放。
- 存档格式应带版本号并具备迁移测试。
- 当前 Electron Server `win-unpacked` 仍只作为内部候选；面向服主的 Windows 公开发行方向已由 ADR-0021 批准，但须等待 RED-148 实现并验证 NSIS、update ZIP、signed runtime catalog、签名、更新与回退门禁，正式发布仍保留人工批准。
