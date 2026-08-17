# ADR-0008：Rule + statusTag 是棋子效果的唯一权威架构

状态：已接受
日期：2026-08-17
接受依据：项目负责人批准 RED-80 清理方案，并要求彻底删除旧状态兼容层
关联任务：[RED-80](https://linear.app/redvsblue/issue/RED-80/移除不可达的-attachedeffect-遗留架构统一为-rule-statustag)
风险：High

## 背景

仓库同时存在两套表达棋子持续行为的结构：

- 当前内容实际使用的 `piece.rules` + `piece.statusTags`；
- 未被内置棋子、技能、卡牌或规则入口使用的 `AttachedEffect`、`initialEffects`、`data/effects` 和三组 helper。

AttachedEffect 仍占据第五触发阶段、浏览器 bundle、静态审计和差分矩阵，造成“看起来可用、实际上没有生产调用”的错误架构信号。继续补齐 helper 会扩大第二套系统，并增加 Rule/statusTag 与 AttachedEffect 重复结算的风险。

## 决策

1. `piece.rules` 是棋子可执行持续规则的唯一权威集合；`piece.statusTags` 是状态、持续时间、层数和可见标记的权威集合。
2. 删除 AttachedEffect 类型、loader、执行器、`initialEffects`/`attachedEffects` 类型字段、SkillCode helper、第五触发阶段及 `data/effects` 数据组。
3. 触发消费者固定为四类：全局规则、棋子规则、玩家规则、响应卡。Rule 类别内 priority 降序；响应卡继续使用手牌快照。
4. 不保留旧状态兼容模块、错误码或字段识别路径。旧快照和旧自定义资源包不属于支持范围；未来若需兼容，必须另建版本化迁移任务。
5. `pendingTargetSelection`、`pendingOptionSelection`、规则剩余队列及 pending 字符串 `effectCode` 保留。pending 的字段名表示“选择完成后的续接函数”，不是 AttachedEffect 架构。
6. 不修改游戏数值、Rule 语义、statusTag 语义或随机算法，也不在本任务引入旧状态迁移。

本 ADR 取代 [ADR-0006](./ADR-0006-combat-trigger-ordering.md) 中关于 AttachedEffect 第五类别和其 priority 的条款；ADR-0006 的四个剩余类别顺序、Rule priority 和稳定快照原则继续有效。

## 备选方案

### 保留 AttachedEffect 并补齐 helper

未采用。内置内容没有调用入口，补齐只会巩固第二套权威系统并扩大兼容面。

### 将 Rule/statusTag 迁移回 AttachedEffect

未采用。现有内容、固定 seed 行为和调试工具已经围绕 Rule/statusTag 工作，迁移会改变大量规则和状态语义。

### 保留专用旧状态识别与拒绝

未采用。当前没有已知正式玩家存档或内置写入入口；继续识别旧字段会让已删除架构以“兼容层”名义长期残留。需要兼容时应单独设计版本化迁移。

## 影响

- 删除 47 个 dormant effect 定义和 manifest，以及对应生产模块。
- RED-75 Node/浏览器差分矩阵由六面变为五面。
- RED-61 触发顺序由五类别变为四类别。
- RED-78 描述的 AttachedEffect helper 缺失不再通过扩展旧系统修复，应由 RED-80 取代。
- 旧快照和旧自定义内容不再获得专用识别或错误诊断，必须按当前 Rule + statusTag 架构重新制作。

## 验证方式

- 固定六个代表 Rule + statusTag 场景的结果和最终 state hash。
- 静态扫描生产代码，确认旧状态兼容模块、错误码、字段识别和运行时测试 fixture 全部删除。
- 验证四类触发顺序、响应卡弃牌和 pending target/option 流程。
- 运行五面 Node/浏览器 trace bridge，比较 seed、command、trace、action log、outcome 和 hash。
- 运行数据/事件静态审计、浏览器 bundle 构建、完整测试、类型检查、ESLint、编码检查和浏览器冒烟。
- High Risk 候选必须经过独立 AI 或人工审查，并由人工决定是否合并。

## 回退方式

整体 revert RED-80 的生产模块、数据删除、测试、文档和生成 bundle。不得只恢复效果 JSON、第五触发阶段或 helper 中的一部分。回退后必须恢复六面差分矩阵并重跑相同固定 seed 证据。

## 相关资料

- [skillCode 兼容矩阵](../technical/SKILLCODE_COMPATIBILITY_MATRIX.md)
- [战斗事件管线审计](../technical/COMBAT_EVENT_PIPELINE_AUDIT.md)
- [RED-75](https://linear.app/redvsblue/issue/RED-75/建立-skillcode-六类执行面-node浏览器轨迹差分测试)
- [RED-78](https://linear.app/redvsblue/issue/RED-78/修复-attachedeffect-skillcode-helper-注入缺口)
