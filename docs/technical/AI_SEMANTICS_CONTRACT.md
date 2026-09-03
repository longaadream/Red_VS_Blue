# AI 机制语义与候选动作特征合同

版本：1（RED-85 提议，待人工批准）

词表：`damage`、`heal`、`control`、`cleanse`、`protect`、`move`、`summon`、`transform`、`resource`、`delayed`、`status`、`combo`。它们描述机制，不编码角色、阵营或技能 ID。

`observeAiState()` 只生成公开观察，不读取 `visible:false` 的 statusTag 或任何视觉随机。`transitionFeatures()` 从 before/after state diff 提取通用变化；不会调用效果代码。`candidateActionFeatures()` 记录动作种类、目标数和兼容等级，ID 仅作诊断。

覆盖矩阵由 `npm test -- tests/game/ai-semantics.test.ts` 调用的 `scripts/audit-ai-semantics.mjs` 输出：automatic、metadata-required、evaluator-required、unsupported 及具体 ID。已移除的技能不得继续留在 manifest 或 unsupported 清单中；未知内容仍按 `skip-action` fail closed，绝不静默推断。

新增内容流程：先更新 manifest，再为复杂机制更新 `data/rules/ai-semantics.json`，运行审计；manifest hash 或复杂机制声明不一致即失败关闭。元数据完全不参与技能执行、状态序列化或 RNG，因此固定 seed action trace 与最终状态 hash 不应变化。
