# ADR-0010：伤害统一使用确定性批次与动作内连锁

- 状态：已被 ADR-0028 的通用击杀资源条款取代（其余伤害批次决策仍有效）
- 日期：2026-08-17
- 人工批准：2026-08-17（RED-33 Codex 任务中回复“批准”）
- 关联任务：[RED-33](https://linear.app/redvsblue/issue/RED-33/重构伤害管线与多目标同时结算)
- 风险：High

## 背景

旧 `dealDamage()` 对数组目标依次递归调用单体结算。前一个目标会先扣血、触发死亡、获得充能并进入墓地，后一个目标才开始计算，因此范围效果不是同时结算，输入数组顺序也会改变状态和日志。旧实现还把原始 0 强制为 1，并让平静护盾在 defense 之前吸收。

RED-33 必须保持 [ADR-0004](./ADR-0004-deterministic-rule-runtime.md) 的确定性运行时、[ADR-0006](./ADR-0006-combat-trigger-ordering.md) 的四类消费者顺序、[RED-72 原子性合同](../technical/COMBAT_TRIGGER_ATOMICITY_CONTRACT.md) 及 [ADR-0008](./ADR-0008-rule-status-authority.md) 的 Rule + statusTag 单一权威架构。

## 决策

1. 单体伤害是一个目标的 `DamageBatch`；数组伤害进入同一共享管线。
2. 调用方结果仍按输入目标对齐，但内部目标按 `instanceId` 升序处理。重复目标、无效目标、非有限/负伤害和未知类型在任何触发器前拒绝。
3. 阶段固定为：来源 `beforeDamageDealt` 一次；每目标 `beforeDamageTaken`；physical/magical 扣 defense；正数最低 1；`beforeDamageShield` 数值盾；`beforeDamageApplied` 致命拦截；统一扣 HP；after-damage；死亡/复活、充能、墓地。
4. 原始或修改后为 0 的合法事件保持 0。完整抵挡和护盾完全吸收派发一次 `afterDamageBlocked`，不派发 after-damage。
5. 同批全部 HP 写入完成后，才允许 after-damage 和生命周期消费者观察状态。生命周期沿同一稳定目标顺序执行且每目标至多一次。
6. 反射规则把 follow-up damage 登记到 `damageQueue`。父 batch 完成 HP、after-damage 和生命周期后，按 FIFO 处理子 batch；子 batch 记录 `parentBatchId`。
7. 动作内 damage chain 最大深度 20、最多 100 个 batch。超限抛出带 chain/batch、seed、turn 上下文的 `DamagePipelineError`；权威动作由 RED-72 事务边界回滚。
8. `batchId` 在权威运行时使用 RED-28 的 `instance-id/damage-batch` 确定性实例 ID；无运行时的低层测试使用回合和既有 damage 日志数派生的局部序号。
9. 击杀充能只在目标首次确认死亡、击杀归属玩家与目标敌对时结算。召唤物默认 +1；显式 `noKillCharge` 不提供。充能没有本任务新增的上限或自然衰减。

## 兼容迁移

- `rule-watcher-shield` 迁到 `beforeDamageShield`，在 defense 后吸收。
- 巫妖誓约、不死神体和艾露恩守护迁到 `beforeDamageApplied`，直接读取管线最终候选伤害，不再重复 defense/minimum 公式。
- 寒冰坚忍迁到目标侧 `beforeDamageTaken`。
- 神威、血誓和濒死反射登记 follow-up damage，不在 before 消费者中递归立即扣血。
- 圣盾、仙人之盾和诅咒结界继续作为一次完整抵挡；Rule + statusTag 仍为权威状态。

## 影响与边界

范围伤害的日志、墓地顺序和触发顺序变为稳定、显式合同。没有修改棋子数值、伤害类型、独立魔抗、随机算法、存档版本、终局 UI 或计时。

damage trigger 中直接递归调用 `dealDamage()` 会以 `RVB_DAMAGE_REENTRANT_CALL` fail closed，错误携带当前 chain、parent batch 和 depth，并穿透动态规则执行器交给 RED-72 动作事务回滚。所有当前反射规则及志志雄「自燃·灵力消耗」均迁到 `damageQueue`；新增 follow-up damage 不得恢复顺序相关的立即递归。

## 验证

- 四类伤害、0/最低 1、数值盾、圣盾、免疫、反射、致命拦截。
- 目标顺序交换 hash 相同；双方最后核心在首个 after-damage 前均为 0。
- 死亡、墓地、充能、召唤物与 `noKillCharge` 恰好一次。
- 固定 seed 的 batch ID、结构化日志和反射 chain；深度错误包含确定性上下文。
- 核心测试、TypeScript、ESLint 零新增基线、browser engine 构建和独立审查。

## 回退

先回退规则兼容迁移，再回退共享 batch 管线；测试和本 ADR 可保留为失败证据。回退不得修改快照、数值、随机算法或存档格式来掩盖行为差异。
