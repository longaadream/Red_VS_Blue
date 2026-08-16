# 战斗事件管线审计（RED-45）

状态：审计实现完成，等待独立审查与 Linear 缺陷建单授权。基线：`origin/main@a6544ba`。审计日期：2026-08-17。风险：Medium。

本任务只修改测试、审计脚本与文档，不把现有生产行为直接冻结为产品语义，也不修复审计发现的生产缺陷。

## 可执行阶段合同

权威动作的共同阶段为：

1. 预检输入、目标、资源和版本；失败不得派发事件、付费、推进 RNG 或污染输入状态。
2. 构造可修改的 `before*` context，并按已批准消费者顺序派发。
3. `blocked` 停止剩余消费者和核心动作；`pending` 保存当前 context、来源与剩余队列；异常回滚整条命令并抛出带事件上下文的错误。
4. 使用 `before*` 最终 context 执行核心效果和付费。
5. 成功核心动作恰好派发一次对应 `after*`；失败、blocked 或仍 pending 时不派发。
6. 动作入口按现有调用点派发 `whenever`，不能用它替代具体 before/after 阶段。

该合同引用已接受的 [ADR-0006](../decisions/ADR-0006-combat-trigger-ordering.md) 和 [RED-72 原子性合同](./COMBAT_TRIGGER_ATOMICITY_CONTRACT.md)。产品仍需人工确认未覆盖的事件语义；审计测试只记录当前可执行行为。

## 事件目录

`scripts/audit-combat-events.mjs` schema 2 使用 TypeScript AST 解析 `checkTriggers`，解析局部 context 变量中的字面量 `type`，并扫描四类数据中的规则、响应卡、AttachedEffect 消费者及字面量 `fireEvent()`。报告为每个事件列出生产者和消费者，并单独输出：

- `emittedOnly`：有生产者但未声明；
- `consumedOnly`：有消费者但无生产者；
- `declaredWithoutProducers`；
- `declaredWithoutConsumers`；
- `undeclaredEvents`；
- 仍需运行时追踪的动态调用。

当前结果：30 个已声明事件，31 个生产者/消费者联合事件名，5 个真正动态的派发点；所有已声明事件都有生产者。14 个已声明事件当前没有数据消费者，它们是可观察的空槽位，不自动视为缺陷。唯一未声明且无生产者的消费者是 `beforeAttack`。

| 阶段 | 事件 | 主要生产者 | 关键 context / 可修改字段 | 阻断、付费、日志与后续事件 |
| --- | --- | --- | --- | --- |
| 生命周期 | `gameStart`, `beginTurn`, `endTurn`, `whenever` | `battle-setup.ts`, `turn.ts` | `playerId`、回合/阶段；规则可修改战局状态 | 不对应单一动作付费；异常遵循 RED-72；可嵌套 `fireEvent` |
| 移动 | `beforeMove`, `afterMove` | `turn.ts` | `sourcePiece`, `playerId`, `targetX/Y`；before 可改最终坐标 | blocked 不扣 AP、不移动、不发 after；成功移动后 after 恰好一次 |
| 技能 | `beforeSkillUse`, `afterSkillUsed` | `turn.ts`, `skills.ts` | `sourcePiece`, `targetPiece`, `targetX/Y`, `skillId`, `selectedOption` | 预检先于 before；pending 不重复 before；成功后支付并发 after |
| 卡牌 | `beforeCardPlay`, `afterCardPlay` | `turn.ts` | `playerId`, `cardId`, `cardInstanceId`、目标 | blocked 不付费/弃牌；成功支付、弃牌、记录动作并发 after |
| 手牌 | `beforeCardAdded`, `afterCardAdded` | `skills.ts` | 玩家、卡牌与来源 | before 可阻断加入；after 仅在成功加入后派发 |
| 伤害 | `beforeDamageDealt`, `beforeDamageTaken`, `afterDamageDealt`, `afterDamageTaken`, `afterDamageBlocked` | `skills.ts` | 来源/目标、`damage`, `damageType`, `skillId`；before 可改伤害或 blocked | 多目标共享一次 dealt-before 最终值；死亡/击杀事件由结算结果继续派发 |
| 治疗 | `beforeHealDealt`, `beforeHealTaken`, `afterHealDealt`, `afterHealTaken`, `afterHealBlocked` | `skills.ts` | 来源/目标、`heal`, `skillId`；before 可改治疗或 blocked | blocked 不改 HP；成功后发 after |
| 死亡 | `beforePieceKilled`, `afterPieceKilled`, `onPieceDied` | `skills.ts` | killer/source/target、`damage`, `skillId` | 复活/免死可在 before 阻断；成功死亡继续 after/onPieceDied |
| 召唤 | `beforePieceSummoned`, `afterPieceSummoned` | `turn.ts`, `battle-setup.ts` | 模板、阵营、拥有者、目标坐标；before 可 blocked | blocked 不插入实体；成功插入一次并发 after |
| 状态 | `afterStatusApplied`, `afterStatusRemoved` | `skills.ts` | `sourcePiece`, `statusId`, `playerId` | 只在生产 helper 的现有成功路径派发 |
| 充能 | `afterChargeGained` | `skills.ts` | 来源、玩家、充能变化 | 记录成功后的变化；当前无数据消费者 |
| 自定义 | 动态 `fireEvent(eventName, childContext)` | 六类代码执行面 | 继承 root/parent/depth，child context 覆盖事件字段 | 同步嵌套；深度 20、每 root 100 次派发预算 |

### 事件目录 FAIL

| ID | 结果 | 最小证据 | 后续 |
| --- | --- | --- | --- |
| F05 | FAIL | `beforeAttack` 未在 `TriggerType` 声明、无生产者，却被 `rule-freeze-prevent-attack` 和 `effect-freeze` 消费；审计脚本退出码 1 | 独立修复 issue 的 payload 已准备；Linear 连接器要求用户明确授权外发，当前 BLOCKED |

## 消费者顺序、priority 与可见性

一次派发按以下顺序执行：全局规则、棋子规则、玩家规则、响应卡、AttachedEffect。类别 rank 升序；类别内 priority 降序，默认 `0`；同 priority 保留事件开始时该类别的稳定数组快照顺序。响应卡使用手牌快照，AttachedEffect 也按 priority 降序。

`tests/game/combat-trigger-queue-visibility.test.ts` 表驱动证明：当前类别执行中新增的规则只对下一事件可见；当前类别执行中删除的规则仍完成本次快照，下一事件消失。跨类别变化在后续类别创建快照前可见。

## blocked、异常、嵌套与 pending

| 结果 | 提交/付费 | 后续消费者 | after 事件 | 随机/状态 |
| --- | --- | --- | --- | --- |
| success | 提交 before、核心效果、成本和批准日志 | 按快照继续 | 核心动作成功后一次 | 提交已使用 cursor |
| blocked | 提交已完成 before 效果和其 limits；不付核心成本 | blocker 后停止 | 无 | 保留已完成 before 的随机消耗 |
| pending | 提交已完成消费者和选择会话；不付核心成本 | 保存来源与剩余队列 | 挂起时无；成功恢复后一次 | 不重放已完成消费者 |
| invalid | 不提交 | 不派发 | 无 | 不推进 cursor/hash |
| exception | 整条命令回滚并抛错 | 立即停止 | 无；after 异常也回滚核心 | 不提交 cursor；错误含事件/消费者链 |

嵌套 `fireEvent` 记录 root、parent、event ID 和 depth；超过深度 20 或预算 100 时返回结构化错误及完整事件链。连续 pending 保留已选目标和步骤顺序；取消、错误玩家、陈旧 revision/selection ID 和重复提交均由权威选择协议拒绝。

## 可观察轨迹

`tests/helpers/event-trace.ts` 是纯测试探针，不修改生产派发。每条记录可包含：

- action/event/root-parent 信息、sequence、depth、回合和阶段；
- 五类消费者、consumer ID、owner/source、priority 与稳定 tie-breaker；
- context 前后快照和字段差异；
- success/blocked/pending/exception；
- 前后状态 hash、seed 与命名随机流 cursor。

`tests/game/event-trace-probe.test.ts` 对同一固定 state/context/seed 重复构造完整记录并断言字节级结构相等。`tests/game/skillcode-browser-differential.test.ts` 对六类执行面比较有序轨迹、关键结果和最终权威状态 hash。

## 八类复杂机制证据

`tests/game/combat-complex-mechanisms.test.ts` 的 8 个引擎级场景全部 PASS：

1. 多目标使用同一最终伤害值；
2. 神威 blocked 并恰好反射一次；
3. 致命伤害触发巫妖誓约复活；
4. 召唤在插入实体前后各派发一次事件；
5. 须佐能乎变形并替换技能；
6. 血誓状态与规则在批准的 end-turn 时机一起过期；
7. 响应卡先于 AttachedEffect 执行并弃牌；
8. 两步连续 pending 只在完成时执行一次效果。

此外，`debug-battle.test.ts` 证明镜像阵营和并行房间状态隔离；`fireevent-chain.test.ts` 与 `combat-event-audit.test.ts` 覆盖嵌套保护、blocked、异常和 pending 队列；`targeting.test.ts` 覆盖取消、陈旧和重复恢复。

## 基线发现与集成状态

| ID | 原发现 | 当前状态 |
| --- | --- | --- |
| F01 | summon 事件名与声明不一致 | RED-60 已修复；目录和召唤场景 PASS |
| F02 | 五类消费者 priority/tie-breaker 不稳定 | RED-61 + ADR-0006 已修复；Node/浏览器顺序 fixture PASS |
| F03 | 嵌套 `fireEvent` 无界 | RED-62 已修复；depth/budget/父子链 PASS |
| F04 | 异常、原子性和 after 合同不明确 | RED-72 已实现；相关回归 PASS，仍等待独立产品验收 |
| F05 | `beforeAttack` 未声明且无生产者 | OPEN；本任务只保留复现，不修生产逻辑 |
| F06 | `shishio-combustion-passive.code` 不是 `executeSkill` 函数 | OPEN；见 skillCode 矩阵 |
| F07 | AttachedEffect 数据使用未注入 helper | OPEN；见 skillCode 矩阵 |

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| RED-45 聚焦 Vitest | PASS | 事件目录、轨迹、六面差分、8 场景、动态队列和数据加载套件 |
| 完整 Vitest | PASS | `npm test`：44 个文件 / 364 项测试 |
| 事件目录 CLI | FAIL（预期审计发现） | 退出码 1，仅 `beforeAttack` 为 undeclared + consumed-only |
| skillCode 静态 CLI | FAIL（预期审计发现） | 退出码 1；F06/F07 |
| 本轮新增或重写文件定向 ESLint | PASS | 2 个审计脚本、`event-trace` helper 与 6 个新增测试无错误 |
| 全仓 lint | FAIL（既存基线） | `npm run lint`：1045 个问题（697 errors / 348 warnings）；未在 RED-45 扩大范围修复 |
| 浏览器构建 / 编码 | PASS | `npm run build:game-engine`；`npm run check:encoding`（551 个文本文件） |

## 回退

文档、测试探针、fixture 和脚本均可按 RED-45 独立提交 revert；不得因回退测试代码删除 F05-F07 的复现证据。任何生产修复必须在独立 Medium Risk issue 中按自己的合同与回退方案实施。
