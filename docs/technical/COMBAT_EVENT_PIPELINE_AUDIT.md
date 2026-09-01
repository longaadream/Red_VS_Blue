# 战斗事件管线审计（RED-45 / RED-77 / RED-80 / RED-139）

状态：RED-80 已将消费者模型收敛为四个类别；RED-139 在不增加消费者类别的前提下，把 Damage、Heal、Summon、Death 的 trigger dispatch 纳入动作级 EffectChain、共享预算和原子回滚。审计更新：2026-08-31。RED-139 风险：High。

## 可执行阶段合同

权威动作的共同阶段为：

1. 预检输入、目标、资源和版本；失败不得派发事件、付费、推进 RNG 或污染输入状态。
2. 构造可修改的 `before*` context，并按已批准消费者顺序派发。
3. `blocked` 按所属动作/Batch 合同停止；`pending` 保持权威根动作 pre-state，并保存版本化会话与服务端 replay record；异常回滚整条命令及运行时快照并抛出带事件/EffectChain 上下文的错误。
4. 使用 `before*` 最终 context 执行核心效果和付费。
5. 成功核心动作恰好派发一次对应 `after*`；失败、blocked 或仍 pending 时不派发。
6. 动作入口按现有调用点派发 `whenever`，不能用它替代具体 before/after 阶段。

该合同引用 [ADR-0006](../decisions/ADR-0006-combat-trigger-ordering.md)、[ADR-0008](../decisions/ADR-0008-rule-status-authority.md)、[ADR-0022](../decisions/ADR-0022-deterministic-effect-batch-queues.md) 和 [RED-72/121/139 原子性合同](./COMBAT_TRIGGER_ATOMICITY_CONTRACT.md)。

## 事件目录

`scripts/audit-combat-events.mjs` schema 2 使用 TypeScript AST 解析 `checkTriggers`，解析局部 context 变量中的字面量 `type`，并扫描 skills、rules、cards 三类数据中的规则、响应卡消费者及字面量 `fireEvent()`。报告输出生产者、消费者、未声明事件、无生产者/消费者事件和动态调用。

RED-77 确认当前产品合同没有独立 attack 动作或 attack 分类，因此没有新增 `beforeAttack` 声明或生产者。遗留的 `rule-freeze-prevent-attack` 及其 manifest、吉安娜、寒冰坚忍引用已删除；冰冻仍由权威 `beforeMove` 与 `beforeSkillUse` 阻断。事件目录现无 undeclared、consumed-only 或 declared-without-producer 事件。

| 阶段 | 事件 | 主要生产者 | 关键语义 |
| --- | --- | --- | --- |
| 生命周期 | `gameStart`, `beginTurn`, `endTurn`, `whenever` | `battle-setup.ts`, `turn.ts` | 可嵌套 `fireEvent`；异常遵循 RED-72 |
| 移动 | `beforeMove`, `afterMove` | `turn.ts` | blocked 不扣 AP、不移动、不发 after |
| 技能 | `beforeSkillUse`, `afterSkillUsed` | `turn.ts`, `skills.ts` | pending 不重复 before；成功支付后发 after |
| 卡牌 | `beforeCardPlay`, `afterCardPlay` | `turn.ts` | blocked 不付费/弃牌 |
| 伤害/治疗 | 各 `before*` / `after*` / blocked 事件 | `skills.ts` | 同 Batch Prepare/Commit/Emit；after 观察到全批主状态已提交 |
| 死亡/召唤 | kill、died、summoned 事件 | `skills.ts`, `turn.ts`, `battle-setup.ts` | Summon 全批 Commit 后发 after；Death 全部 lifecycle 后统一复活判定与 finalization |
| 状态/充能 | status、charge 事件 | `skills.ts` | 仅在现有成功 helper 路径派发 |
| 自定义 | `fireEvent(eventName, childContext)` | 五类代码执行面 | 局部 depth 20 / root 100；活跃 EffectChain 时同时计入动作级 1000 dispatch |

### 事件目录结果

| ID | 结果 | 最小证据 |
| --- | --- | --- |
| F05 | PASS | RED-77 删除无定义的消费者及全部现役引用，未新增事件或生产行为；审计脚本退出码 0 |

## 消费者顺序、priority 与可见性

一次派发只处理四个类别：

1. 全局规则；
2. 棋子规则；
3. 玩家规则；
4. 响应卡。

Rule 类别内按 priority 降序，默认 `0`；同 priority 保留事件开始时的稳定数组快照顺序。响应卡使用手牌快照，所以本次弃牌不会跳过同一事件里尚未执行的卡。

`tests/game/combat-trigger-queue-visibility.test.ts` 证明：当前类别新增的规则只对下一事件可见；当前类别删除的规则仍完成本次快照，下一事件消失。跨类别变化在后续类别创建快照前可见。

## blocked、异常、嵌套与 pending

| 结果 | 提交/付费 | 后续消费者 | after 事件 | 随机/状态 |
| --- | --- | --- | --- | --- |
| success | 提交 before、核心效果、成本和批准日志 | 按快照继续 | 核心动作成功后一次 | 提交已使用 cursor |
| blocked | 提交已完成 before 效果和 limits；不付核心成本 | blocker 后停止 | 无 | 保留已完成 before 随机消耗 |
| pending | 权威 battle 保持根动作 pre-state；只提交会话/私有 replay record | 回答后从根动作重放并注入已验证答案 | 挂起时无；成功恢复后一次 | 恢复 runtime/TriggerSystem/EffectChain 快照；不序列化 queue |
| invalid | 不提交 | 不派发 | 无 | 不推进 cursor/hash |
| exception | 整条命令回滚并抛错 | 立即停止 | 无；after/Batch 异常也回滚核心 | 不提交 cursor、event ID、rule limit 或 EffectChain 计数 |

`pendingTargetSelection.effectCode` 是选择会话完成时的序列化续接函数，与 AttachedEffect 无关。连续 pending、取消、错误玩家、陈旧 revision/selection ID 和重复提交继续由权威选择协议处理。

RED-139 的 pending 不保存已处理一半的 EffectBatch 或 ledger。每次 replay attempt 创建新 chain，并从根动作、固定 seed/clock 和答案记录确定性重建 batch ID、enqueue sequence 与累计预算；取消或恢复异常不会留下 scope、日志或运行时游标。

## 可观察轨迹

`tests/helpers/event-trace.ts` 与 EffectChain 的进程外 `records` 都是纯测试探针，不写入 BattleState、存档、公共 patch 或网络协议。记录可包含事件链、四类消费者、batch/parent/depth、enqueue sequence、priority/tie-breaker、context diff、pending/exception、state hash、seed 和随机 cursor。

`tests/game/event-trace-probe.test.ts` 验证固定 state/context/seed 的记录稳定；SkillCode 与 game-engine browser differential 回归比较 Node/冻结 bundle 的结果、action log 和最终 hash。

## 八类复杂机制证据

`tests/game/combat-complex-mechanisms.test.ts` 保留八个引擎级场景：

1. 多目标使用同一最终伤害值；
2. 神威 blocked 并恰好反射一次；
3. 致命伤害触发巫妖誓约复活；
4. 召唤在插入实体前后各派发一次事件；
5. 须佐能乎变形并替换技能；
6. 血誓状态与规则在批准的 end-turn 时机一起过期；
7. 响应卡执行后从手牌进入弃牌堆；
8. 两步连续 pending 只在完成时执行一次续接函数。

## 基线发现与集成状态

| ID | 原发现 | 当前状态 |
| --- | --- | --- |
| F01 | summon 事件名与声明不一致 | RED-60 已修复 |
| F02 | 消费者 priority/tie-breaker 不稳定 | RED-61 + ADR-0006 已修复；RED-80 将类别数从五收敛为四 |
| F03 | 嵌套 `fireEvent` 无界 | RED-62 已修复 |
| F04 | 异常、原子性和 after 合同不明确 | RED-72 已实现 |
| F05 | `beforeAttack` 未声明且无生产者 | RED-77 已确认该语义无产品定义并删除遗留消费者；未新增事件 |
| F07 | AttachedEffect 数据使用未注入 helper | RED-80 通过删除不可达执行面和数据定义解决，不扩展旧 helper |
| F08 | 四类效果队列、预算和回滚彼此割裂 | RED-139 以封闭联合、单 FIFO ledger、20/100/1000 共享预算及四层事务快照解决；无通用 effectQueue |

## 验证结果

| 检查 | 当前结果 |
| --- | --- |
| RED-80 聚焦回归 | PASS：10 个文件 / 92 项（旧状态拒绝 fixture 已随兼容层删除；保留五面 Node/浏览器差分与 RED-76 真实被动回归） |
| RED-77 冰冻动作回归 | PASS：移动、基础技能、充能技能 3 项；blocked 后不付 AP/充能、不改冷却/次数/生命、不发成功 after |
| 事件目录 CLI | PASS：undeclared、consumed-only、declared-without-producer 均为空，退出码 0 |
| RED-77 完整验证 | PASS：62 个测试文件 / 502 项、全仓 ESLint、TypeScript、game-engine 构建、构建后 Node/浏览器差分 2 个文件 / 11 项 |
| skillCode 静态 CLI | PASS：0 个语法诊断；无 unsupported helper |
| 浏览器构建、五面差分、完整测试和静态检查 | PASS：完整 47 文件 / 375 项、TypeScript、剩余 7 文件定向 ESLint、510 文件编码检查、生产/测试/bundle 旧状态残留为 0，且真实训练局 Rule/statusTag 冒烟通过 |
| 全仓 ESLint | FAIL（既有基线）：`npm run lint` 为 639 errors / 334 warnings；RED-80 定向文件无新增问题 |

## 回退

RED-80 必须整体回退生产模块、数据、测试、文档和 bundle；不得单独恢复第五消费者阶段或效果 JSON。RED-45/RED-72 的事件与原子性测试继续作为回退后的验收基线。

RED-77 可独立恢复已删除规则文件及 manifest、吉安娜、寒冰坚忍三个引用点，但这会重新打开 F05。回退不得在没有 attack 产品合同的情况下单独新增 `beforeAttack` 生产者。
