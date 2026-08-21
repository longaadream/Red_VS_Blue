# 阵容无关多操作回合规划器（RED-86）

`lib/game/ai-planner.ts` 是只读的 player-level 搜索消费者：它接收一个玩家的完整当前状态，使用 `aiEnvironmentV1.listLegalActions()` 和 `simulate()`，在隔离状态上进行固定节点预算的 beam search。它不实现移动、目标、技能、资源、随机或权威提交规则。

## 调用边界

`planAiTurn(state, playerId, rootSeed)` 返回一条内部评估的序列和 `nextAction`。调用者只能提交 `nextAction`；权威结果返回后，必须以新 state 调用 `planNextAiAction(newState, playerId, rootSeed, previousGoal)`。绝不能批量提交 `actions`，因此死亡、位移、召唤、触发器或 pending 状态都会在下一步重新规划。

## 安全与确定性

- `DEFAULT_AI_PLANNER_CONFIG`（v1）以节点数而非墙钟时间限制搜索，并固定 candidate、beam 与 tie-breaker 排序。
- 所有候选均来自 AI Environment 的正式合法候选；拒绝写入 trace，绝不作为成功处理。
- 搜索使用 `stateKey(full)` 去重，重复的非 endTurn 状态被裁剪；`maxActions`、`nodeBudget`、`candidateLimit` 与显式 endTurn 防止零消耗循环。
- `trace` 记录每个候选的得分组成、裁剪原因、拒绝码；`aiPlanTraceHash()` 可用于固定 seed 重放核对。
- `chooseAiTurnGoal()` 仅依据公开战局（当前最低生命敌人或受威胁友军），没有角色、阵容或技能 ID 分支。原目标仍有效时会保留；否则切换。

评分权重为版本化的 `AiPlannerConfig`，可由离线实验显式保存/覆盖；它们不是规则或玩法数据。复杂/unsupported 机制仍由 RED-85 语义合同失败关闭，planner 不猜测其效果。

旧的 `generateBotActions()` 保持为受控兼容入口；新 planner 不引入第二套合法性判断。
