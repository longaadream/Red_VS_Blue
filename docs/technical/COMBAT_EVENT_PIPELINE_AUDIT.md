# 战斗事件管线审计（RED-45）

状态：保留 RED-45 历史基线，并补充 RED-70、RED-72、RED-74 的集成证据；这不是一份已获批准的完整规则合同。基线日期：2026-08-15。集成日期：2026-08-16。风险：Medium。

## 证据

`scripts/audit-combat-events.mjs` 枚举直接调用 `checkTriggers` 的派发点，并与 `TriggerType` 对比。`tests/game/combat-event-audit.test.ts` 验证事件目录结果并执行独立触发器 fixture。

`tests/helpers/event-trace.ts` 提供确定性的测试侧轨迹记录：动作/事件 ID、父事件/深度、消费者身份、priority、稳定 context 快照、结果标记和状态 hash。它不会改变生产派发行为。

## RED-45 基线中观察到的顺序与结果

本节记录 RED-45 审计时、修复前分支的行为，并非 RED-70 候选版本的描述。`TriggerSystem.checkTriggers` 依次收集全局规则、棋子规则和玩家规则；全局/棋子规则按 priority 降序。响应卡在规则之后执行，AttachedEffect 再按触发器 priority 升序执行。同 priority 的顺序受原有数组或注册顺序影响。成功且 `blocked` 的结果会停止后续消费者；异常会记录后继续；pending 交互记录 ID，并在恢复时重新构建工作。

## 发现项（生产行为不在本审计修改范围）

| ID | 结果 | 证据 |
| --- | --- | --- |
| F01 | FAIL | `TriggerType` 声明 `beforePieceSummoned` / `afterPieceSummoned`，而召唤派发使用 `beforePieceSummon` / `afterPieceSummon`。 |
| F02 | FAIL | 消费者类别没有已批准的稳定跨类别 tie-breaker；AttachedEffect 的 priority 方向不同。 |
| F03 | FAIL | 嵌套 `fireEvent` 同步递归，缺少事件 ID、父 ID、循环预算和深度保护。 |
| F04 | FAIL | 已观察到异常、原子性和 after 事件行为，但尚无明确合同。 |

每个基线 FAIL 都应拆为关联 RED-45 的独立修复任务；审计本身不修改生产行为。

## RED-70 集成状态

| 基线发现 | 集成结果 | 证据 |
| --- | --- | --- |
| F01 召唤事件不一致 | RED-60 已修复 | `beforePieceSummoned` / `afterPieceSummoned` 生产者与 `TriggerType` 一致；AST 事件目录和审计测试通过。 |
| F02 类别/priority 顺序不稳定 | RED-61 已修复 | 已接受 ADR-0006、表驱动源码测试及浏览器 bundle 五类消费者/快照 fixture。 |
| F03 嵌套 `fireEvent` 无界 | RED-62 已修复 | 父子 ID、深度 20 和派发预算 100 的测试通过。 |
| F04 异常/原子性/after 事件合同不完整 | RED-72 已处理 | RED-72 已合入，提供触发失败原子性、pending 技能恢复和 blocked resume 回归测试；仍需独立验收确认产品语义。 |
| 浏览器构建/差分阻塞 | RED-64 已修复 | `npm run build:game-engine` 和固定 seed 的 Node/浏览器 fixture 通过。 |
| RED-28 集成后丢失 `turn.ts` 文本 | RED-66/RED-70 已修复 | 编码检查通过，生成浏览器 bundle 含已修复文本。 |

## 当前 RED-45 执行证据

以下检查在 RED-72 与 RED-74 合入后的 main 上执行。这是当前证据，不替代上方历史基线。

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 六类运行时执行面 | PASS（最小 fixture） | `tests/game/skillcode-runtime-matrix.test.ts` 覆盖规则 `skillCode`、规则 `triggerSkill`、技能代码、卡牌代码、AttachedEffect `filterCode/effectCode`；`tests/game/turn.test.ts` 覆盖序列化 pending `effectCode`。 |
| pending 恢复 | PASS | RED-72 测试覆盖 pending 技能恢复、blocked 恢复和 after 事件次数；RED-45 测试覆盖两步目标保留和最终效果只执行一次。 |
| 复杂机制 | PARTIAL | 现有聚焦套件覆盖多目标确定性动作、blocked/异常行为、召唤生产者、响应卡/AttachedEffect 顺序、嵌套事件深度/预算、pending 取消/陈旧提交、镜像座位和独立房间。此处不声明 25 枚棋子均已通过 RED-35 准入。 |
| Node/浏览器 | PARTIAL | 固定 seed 的移动差分和五类消费者浏览器 fixture 通过。每个运行时执行面的浏览器轨迹/hash 等价仍未完成。 |
| 完整测试 | PASS | `npm test`：36 个文件 / 293 项测试。 |
| 构建与编码 | PASS | `npm run build:game-engine`；`npm run check:encoding`：543 个文件。 |

### 剩余限制

矩阵证明每种执行面都有最小 Node 运行时 fixture，但**尚未**证明每种执行面都具有逐字一致的 Node/浏览器事件轨迹。该项必须作为明确后续任务，不能把现有浏览器差分 fixture 当作普适证明。

## 历史 RED-45 交接状态

| 检查 | 状态 | 证据 |
| --- | --- | --- |
| 静态事件目录 | PASS | 确定性发现 F01。 |
| 全局/棋子/玩家顺序、priority、blocked、异常 | PASS | `tests/game/combat-event-audit.test.ts`。 |
| 完整测试 | NOT RUN | 等待聚焦审计交接。 |
| 浏览器引擎构建 / Node-浏览器差分 | BLOCKED | 当时分支无法解析 `lib/game/engine-browser-entry.ts`。 |
| pending、响应卡、AttachedEffect 轨迹 fixture | NOT RUN | 当时没有测试侧轨迹适配器。 |

上表保留为原始 RED-45 交接快照。当前 RED-70 及后续证据记录在集成表和 PR 中，不能追溯性地把当时未执行的检查改为通过。

## 待批准的合同提案

为每个动作/事件分配确定性的 ID、父 ID、深度、序列号、seed 引用和前后状态 hash。按已批准的类别、priority、拥有者顺序和稳定实例 ID 对快照消费者队列排序。明确成功、blocked、pending、非法和异常时的提交、付费及 after 事件行为。pending 恢复时持久化剩余队列与 context 快照。
