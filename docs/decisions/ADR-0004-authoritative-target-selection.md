# ADR-0004：权威合法目标查询与版本化选择协议

状态：提议中
日期：2026-08-15
关联任务：RED-59

## 背景

旧战场 UI 为每个地格克隆完整状态并调用 reducer 试探技能是否合法，AI 又独立实现距离与敌我过滤。查询因此可能执行效果、触发器、随机数或日志，并且 UI、AI、HTTP 与 WebSocket 会产生不同候选集。待选目标也没有稳定会话 ID 和状态修订号，重复、过期或其他玩家的提交缺少统一拒绝语义。

## 决策

- `lib/game/targeting.ts::prepareAction(state, draft)` 是技能、卡牌和选项/目标步骤的唯一权威准备入口。
- 查询只读取状态和声明式选择合同；不得执行 reducer、触发器、效果代码或 RNG。
- 目标引用统一为棋子 ID 或地格坐标；敌我仅按 `ownerPlayerId` 判断。
- `needTarget`/`needOption` 返回协议版本、`selectionId`、`stateRevision`、步骤、边界、取消能力和精确候选。
- 最终提交复用同一个目标验证器；成功动作将 `targetingRevision` 单调增加一次。
- 规则中断产生的 pending target 会话必须保存来源、所有者、步骤、精确候选和版本凭证。错误使用稳定代码经 HTTP/WS 透传。
- UI 和 AI 只消费权威准备结果；兼容 `skill-targeting.js` 只能做展示适配。
- 无法静态声明的动态选择要求失败关闭。Demo 的特殊距离、来源和选项顺序通过 `targeting` 元数据表达。

## 备选方案

- 保留逐格 reducer dry-run：会运行效果代码，成本随地图格数放大，且不能保证无副作用。
- 继续由 UI/AI 各自推导：实现简单但必然产生规则漂移。
- 只在提交时校验、不返回精确候选：无法支持可信高亮、空候选和 AI 共享。

## 影响

收益是查询纯度、稳定错误、跨消费者一致候选和可回放的选择会话。成本是 Demo 数据需要补充少量选择元数据，所有目标提交必须携带凭证，旧浏览器引擎生成物必须由源码重新构建。

## 验证方式

- `tests/game/targeting.test.ts` 固定覆盖 25 个棋子、79 个技能和 16 张卡牌，并锁定候选 fixture hash。
- 相同验证器覆盖候选枚举和最终提交；测试过期、错误 ID、错误玩家、死亡/越界/非法目标和重复提交。
- 20x16 地图记录旧逐格克隆下界与纯查询耗时，并断言 reducer 执行次数为 0。
- 训练、LAN/WS、HTTP、AI 和兼容适配器运行同一协议回归。

2026-08-15 本地证据：同一 20x16/320 格 fixture 中，旧循环仅做 320 次完整状态克隆（尚未计 reducer）耗时 93.88ms；权威查询耗时 0.52ms，扫描 320 个候选、执行 0 次 reducer。时间只作为同机对比，结构断言才是稳定门槛。

## 回退方式

按三层独立回退：先回退 UI/AI 消费适配，再回退 HTTP/WS 版本化 envelope，最后回退纯查询及 reducer 前置校验。不得只回退最终校验而保留客户端候选推导，否则会恢复规则漂移。

## 相关资料

- [RED-59](https://linear.app/redvsblue/issue/RED-59/建立权威合法目标查询与可版本化目标选择协议)
- [ADR-0002](./ADR-0002-match-identity-model.md)
- [游戏引擎核心](../technical/ENGINE_CORE.md)
- [模块接口](../technical/MODULE_INTERFACES.md)
