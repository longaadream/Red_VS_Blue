# ADR-0020：AI Environment v2 结构化组合决策与公开动态地格

状态：已批准，RED-128
日期：2026-08-29
关联任务：[RED-128](https://linear.app/redvsblue/issue/RED-128/ai-environment-v2结构化组合-pending-与公开动态地格)
风险：Medium

## 背景

AI Environment v1 在 RED-84 时建立，早于 RED-120 的黑崎一护交互链、RED-121 的圣光手牌多选以及
统一 pending interaction 合同。v1 为 multi pending 返回所有单例和稳定前缀代表：10 个候选、选择
1–4 个时得到 13 个动作。该做法保持线性，但不能表达任意合法非前缀组合；若改成完整组合枚举则会
得到 385 个动作，并随候选数继续组合爆炸。

同时，宇智波鼬的天照等规则把公开动态地格保存在 `extensions.tileEffects`。v1 为防止 debug 与私有
状态泄漏而完全排除 `extensions`，因此 AI 看不到玩家 UI 已经展示的公开棋盘效果。

## 决策

1. 保留 `aiEnvironmentV1`、protocol 1、候选 ID、observation、模拟和 browser bundle 导出行为。
   v2 是加法式合同，不把既有调用方静默迁移。
2. 新增 `aiEnvironmentV2` 与 protocol 2。没有 pending 时，`decisionSpace()` 返回完整
   `CandidateActionV2`；有当前玩家 pending 时，返回结构化 option 或 target descriptor。
3. multi descriptor 只包含逐项 atom、selection mode、数量上下限、取消能力、`selectionId` 与
   `stateRevision`。不得预生成单例、前缀或任意组合；空间大小必须与正式候选数线性相关。
4. 调用方通过 `materialize()` 提交所选 atom 值或 target ref。适配器构造现有
   `pendingOptionSelect`、`pendingTargetSelect` 或 `cancelPendingSelection` `BattleAction`，并在
   返回候选前调用既有 option/target 提交或取消 validator。v2 不复制数量、去重、候选归属、
   session ID、revision 或玩家所有权规则。
5. target 物化继续使用现有主目标字段加 `extraTargets`，不引入新的权威动作形状。
6. v2 observation 新增 `boardEffects`。它只对白名单字段 `id`、`type`、`icon`、`x`、`y` 做投影，
   字段读取顺序与 UI 的 `id | instanceId | effectId`、`tileType | type` 一致，并排除
   `visible: false`。不暴露 `sourceId`、owner、样式、脚本、debug、payload 或其他 extension。
7. descriptor、atom、候选、玩家状态键和 transition hash 均包含 protocol 2 并使用稳定排序与
   `hashStable()`；相同状态、随机种子和选择必须得到相同结果。
8. v2 模拟仍调用 `runBattleActionIsolated()`，不写回房间、不绕过正式 runner，也不改变随机算法、
   pending 生命周期、targeting、回合、规则、数据、UI、网络或存储。
9. RED-128 不扩大 canonical browser bundle 的导出面；需要 browser v2 时必须另建合同并补 Node/
   browser differential 证据。

本 ADR 只取代 ADR-0015 中“AI 对多选仅生成线性数量的合法代表动作”的 AI 表示方式：v1 仍保留
代表动作，v2 改为线性 atom descriptor。ADR-0015 的无笛卡尔积、权威事务、凭证、取消、原子提交与
不污染保证继续有效。

## 备选方案

- 在 v1 中直接改变 multi 候选：会破坏协议 1 的候选数量、ID 和既有训练/回放消费者。
- 枚举所有组合：能表达完整空间，但 10 选 1–4 已有 385 个动作，违反 ADR-0015 的线性约束。
- 让 planner 直接构造 `BattleAction`：会重复 pending 形状知识，也容易跳过权威凭证与 validator。
- 暴露完整 `extensions`：实现简单，但会泄漏 debug、私有 payload、所有权和规则运行时数据。
- 修改权威 pending 或 targeting 接口：超出适配器升级范围，并增加对规则核心的回归风险。

## 影响

- v1 调用方无需修改；RED-122 等 AI 可显式选择 v2 并为 descriptor 增加组合选择策略。
- 10 张圣光手牌的 v2 decision space 为 10 个 atom，任意合法 1–4 张集合都可物化。
- 黑崎一护的真实 target→option 暂停链可以由 v2 descriptor 恢复并通过正式 runner 结算。
- 天照、飞雷神、暴风雪等 `tileType` 地格进入 v2 玩家 observation 和 state key，私有样式与 payload
  仍被排除。
- 类型、实现、测试和技术文档必须在同一 PR 中更新。

## 验证方式

- 固定 v1 能力与既有 11 个 Environment 回归，证明 protocol 1 行为未被替换。
- 10 option、min 1、max 4 时断言 v2 只有 10 个 atom；物化非前缀选择并由正式 validator 接受。
- option 和 target 分别覆盖数量不足/超限、重复、未知、过期 revision 与错误玩家，断言输入状态不变。
- 运行真实穆鲁的挽歌 10 张圣光手牌恢复，以及黑崎一护 target→option 恢复。
- 投影真实 `tileType: 'amaterasu'`，断言公开字段存在且 style/debug/private payload 不存在。
- 重复生成 descriptor、候选和模拟，比较 ID、state key、transition hash、trace、TriggerSystem 与缓存。
- 运行聚焦测试、受影响游戏测试、静态检查、全量测试、主分支基线检查与 `git diff --check`。

## 回退方式

整体 revert RED-128 的 protocol 2 类型、实现、测试与文档。因为 v1 未修改，回退不需要迁移既有
v1 消费者，也不得只保留类型而删除 validator 物化实现。

## 相关资料

- [ADR-0013：无头 AI Environment](./ADR-0013-headless-ai-environment.md)
- [ADR-0015：权威交互会话生命周期](./ADR-0015-authoritative-pending-interaction-lifecycle.md)
- [AI Environment 技术合同](../technical/AI_ENVIRONMENT.md)
