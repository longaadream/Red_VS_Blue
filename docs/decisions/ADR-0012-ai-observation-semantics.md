# ADR-0012：版本化 AI 观察与机制语义契约

状态：提议中
日期：2026-08-20
关联任务：RED-85

## 决策

AI 只读取 `public-state` 观察：己方、敌方、公开位置、生命和 `visible !== false` 的 statusTag。候选动作使用机制词表而非角色名；内容 ID 只能用于诊断。即时伤害、治疗、状态、召唤和资源变化由真实 state diff 自动提取。延迟、变身、召唤、随机和扩展状态必须在语义注册表中标记为 `metadata-required` 或 `evaluator-required`；无声明内容为 unsupported。

训练样本携带 `schemaVersion`、`rulesHash`、`contentHash` 与 `observationScope`。这些字段是数据兼容边界，不是玩法状态，且不会写入战斗状态或影响随机流。

## 验证与回退

`scripts/audit-ai-semantics.mjs` 锁定当前 manifest；新增准入内容必须先更新人工复核的语义注册表，否则审计失败。回退只移除 AI 模块、注册表、审计和文档；AI 必须把未描述内容报告为 unsupported，不能猜测其价值。
