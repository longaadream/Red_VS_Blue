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
- 无法确定的事项应保持“提议中”，不得描述为已经确认。

## 当前已确定的基础决策

- [`ADR-0001-deployment-visibility.md`](./ADR-0001-deployment-visibility.md)：部署重投阶段公开双方站位。
- [`ADR-0002-match-identity-model.md`](./ADR-0002-match-identity-model.md)：分离对局座位、内容阵营、所有权与先后手。
- [`ADR-0003-electron-server-packaging.md`](./ADR-0003-electron-server-packaging.md)：保留 Electron Server 内部候选打包入口，但不作为公开发行物（RED-23，已接受）。
- [`ADR-0004-deterministic-rule-runtime.md`](./ADR-0004-deterministic-rule-runtime.md)：权威规则使用根种子、命名随机流、确定性实例 ID 与逻辑时钟（RED-28，已接受）。
- [`ADR-0004-battle-presentation-boundary.md`](./ADR-0004-battle-presentation-boundary.md)：定义战场 Three.js、DOM HUD、展示模型与用户意图的单向边界（RED-48，提议中）。
- [`ADR-0005-authoritative-target-selection.md`](./ADR-0005-authoritative-target-selection.md)：提议以纯查询、精确候选和版本凭证统一 UI、AI 与服务端目标语义（RED-59）。
- [`ADR-0006-combat-trigger-ordering.md`](./ADR-0006-combat-trigger-ordering.md)：统一战斗触发器的跨类别稳定排序（RED-61，已接受）。
- [`ADR-0007-deterministic-deployment.md`](./ADR-0007-deterministic-deployment.md)：固定全地图部署、核心身份与玩家独立重投流（RED-29，已接受）。
- [`ADR-0008-rule-status-authority.md`](./ADR-0008-rule-status-authority.md)：Rule + statusTag 是棋子效果唯一权威架构，移除 AttachedEffect（RED-80，已接受）。
- [`ADR-0009-venom-demo-admission.md`](./ADR-0009-venom-demo-admission.md)：将毒液准入 Demo v0.1 暗方候选池（RED-89，已接受）。
- [`ADR-0010-deterministic-damage-batches.md`](./ADR-0010-deterministic-damage-batches.md)：单体与多目标伤害统一使用确定性 batch 和动作内连锁（RED-33，已接受）。

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
- 当前发布目标是持续生成内部候选版本，正式对外发布保留人工批准。
