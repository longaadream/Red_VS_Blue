# SkillCode ABI v1 合同

状态：已冻结（RED-151）

版本：`rvb-skillcode/v1`

基线：`main` / `8902c0da94957fdb52d142363c2c45a2ebda7a7f`

风险：High

批准日期：2026-08-31

本合同冻结未来受限 SkillCode Runtime 的宿主边界。机器可读权威定义位于
[`lib/game/skillcode-runtime/abi-v1.ts`](../../lib/game/skillcode-runtime/abi-v1.ts)。本任务不实现沙箱、不接入现役执行器，也不允许外部
SkillCode 进入 Content Pipeline。当前 `dynamic-code-runtime.ts` 仍只执行仓库内受信内容，且不是安全
沙箱。

## 1. 版本协商与可信边界

每次调用和返回都必须包含精确字符串 `abiVersion: "rvb-skillcode/v1"`。缺失版本返回
`SKILLCODE_ABI_MISSING`；任何其他值返回 `SKILLCODE_ABI_UNSUPPORTED`。不存在 v0、best-effort、旧
`eval`/`new Function` 或完全信任回退。

边界只接受 JSON 可表达的 plain object、数组、有限数值、字符串、布尔值和 `null`。函数、Promise、
Symbol、BigInt、循环引用、自定义原型、Date、Map、Set、宿主对象及可变 `BattleState` 都不得穿越边界。
输入是版本化快照和 ID/handle；输出是 schema 验证后的命令、pending 请求、显示值与诊断。

一次调用的身份由 `content.{id,version,sourceHash}` 和
`trace.{id,seed,logicalTime}` 组成。宿主必须从实际源码重算 source hash，并生成/保存 content version、trace
ID、seed 与 logicalTime；解析器将调用字段与这份宿主身份逐项比对，调用者自报值不可信。随机数只能来自 seed
对应的注入流；时间只能来自非负整数逻辑时钟。

## 2. 通用调用与返回 schema

调用对象只允许这些顶层字段：

```ts
{
  abiVersion: 'rvb-skillcode/v1'
  surface: SkillCodeAbiV1Surface
  content: { id: string; version: string; sourceHash: string }
  trace: { id: string; seed: string; logicalTime: number }
  requestedCapabilities: string[]
  input: Record<string, JsonValue>
}
```

返回对象只允许：`abiVersion`、`surface`、`traceId`、`status`、`value`、`commands`、
`pending`、`diagnostics`、`budgetUsed`。`status` 为 `ok | pending | rejected`。`budgetUsed` 七项均为必填，且必须
逐项等于沙箱外可信 meter；`surface`/`traceId` 必须等于已验证调用。命令由 `{ kind, payload }` 构成，每个
kind 的 capability 和精确 payload schema 由 `SKILLCODE_ABI_V1_COMMAND_SCHEMAS` 冻结。未知/缺失字段、命令
或诊断码全部 fail closed。

pending 还必须携带 `ownerHandle`、`authorityRevision`、`rootTraceId`、`replayId`、`replayDepth` 和完整 content
身份。宿主将它们与权威 owner/revision、根调用和可信 replay ID 对比；target/option payload 分别使用精确的
候选 handle/option ID 与 min/max schema。调用者不能靠自报 cursor 或 revision 绕过 stale/重复/串线检查。

## 3. 六类作者入口

这六类入口不是可互换的“通用脚本 API”。下表是摘要；完整白名单、input/output 字段、证据路径和不支持项
由 `SKILLCODE_ABI_V1_SURFACES` 提供。

| Surface | 函数形式 | 输入重点 | 能力/输出 | pending 与失败 |
| --- | --- | --- | --- | --- |
| `skillCode` | `function executeSkill(context)` | context、施法者 handle、战斗快照、答案 | 完整技能白名单；结构化权威命令 | 目标/选项均可；pending 立即停止，根动作重放；失败不提交 |
| `cardCode` | `function executeCard(context)` | context、玩家 handle、战斗快照、答案 | 卡牌白名单；无保证的 sourcePiece | 目标/选项均可；支付和弃牌随事务回滚 |
| `ruleSkillCode` | Rule wrapper 中的语句体 | 事件 context、rule handle、快照、答案 | Rule 白名单；只允许 option pending | 触发队列由权威根恢复；触发次数随失败恢复 |
| `ruleTriggerSkill` | 适配 trigger 后的 `executeSkill(context)` | trigger 快照、rule/source handles | 已知事件目标上的同步命令 | v1 不允许 pending；失败回滚整个事件候选 |
| `pendingEffectCode` | `function(ctx)` | pending 快照、handles、序列化 payload | 仅 `Math`、`Date`；无权威命令 | 不允许嵌套 pending；闭包和 `ctx.dealDamage` 不存在 |
| `previewCode` | `calculatePreview(piece, skillDef, currentCooldown)` | 单位/技能显示快照、冷却 | 仅显示值、`calculateDistance` 与不含宿主随机的确定性 `Math` | 非权威、无命令、无 pending；失败只产生诊断 |

## 4. capability/helper 白名单

白名单以 `SKILLCODE_ABI_V1_SURFACES[surface].capabilities` 为唯一机器可读来源。它逐项追溯到
`SKILLCODE_AUTHORING_STANDARD.md`、`SKILLCODE_COMPATIBILITY_MATRIX.md`、
[`scripts/audit-skillcode-compat.mjs`](../../scripts/audit-skillcode-compat.mjs) 和表中 `runtimeEvidence`。
`runtimeEvidence` 使用 `{ file, symbol? }`；`file` 始终是从仓库根开始、真实存在的路径，符号名不再拼入路径。

调用者必须显式声明 `requestedCapabilities`。重复、未知或不属于该 surface 的 capability 分别按 schema 或
`SKILLCODE_CAPABILITY_DENIED` 拒绝。每个输出命令还必须对应本次实际请求的 capability，仅属于 surface 不足以
授权。仅列入 whitelist 不表示可以传递宿主函数；沙箱 adapter 必须把 helper 调用转换成验证后的命令或
确定性查询结果。

允许的命令 kind 为机器常量 `SKILLCODE_ABI_V1_COMMAND_KINDS`。`previewCode` 与
`pendingEffectCode` 的命令集合为空；这避免用虚构通用 API 掩盖现役差异。RED-139 尚未冻结的同时语义不在
v1 命令合同内。现役技能环境的 `context.forceRemoveEnemyPieceById` 被显式冻结为同名 capability 与
`piece.force-remove` 命令，仅 `skillCode` 可请求；它仍须经过敌方/存活/owner 等宿主合法性校验。现役注入的
`console` 在 v1 明确禁止，避免日志绕过输出预算或泄漏宿主信息；诊断只能走受 64/16 KiB 输出预算约束的
结构化 `diagnostics`。

## 5. 确定性与事务语义

- 所有入口同步完成；返回 Promise、定时器、后台任务或迟到副作用均以 `SKILLCODE_ASYNC_FORBIDDEN` 拒绝。
- `Math` 使用 trace seed 的命名随机流；`Date` 使用 trace logicalTime。禁止真实时间和宿主随机。
- trace ID 在编译、入口、权限、预算、执行、输出验证及事务回滚诊断中保持不变。
- 权威调用在隔离候选上生成命令。只有 ABI、能力、预算、schema 和执行全部成功后，宿主才能原子提交。
- 任一失败丢弃全部候选命令并保留输入/权威状态原 hash，最终规范化为稳定错误码及
  `SKILLCODE_TRANSACTION_ROLLED_BACK` 事务事实。
- pending 不是挂起 JavaScript 栈。宿主保存根快照与结构化答案，随后使用同一内容、seed、逻辑时钟和调用
  顺序重放。stale revision、错误 owner、重复答案或深度超限均拒绝。
- `previewCode` 永不影响成本、冷却、伤害或权威合法性；预览失败也不得改用可信执行。

## 6. 批准的资源预算

测量口径是“单次 sandbox invocation”，不是整个回合。七项计量由沙箱外宿主 meter 完整提供，并与返回
`budgetUsed` 逐项相等；缺项、不一致、命令数与实际数组长度不一致、outputBytes 与实际 UTF-8 JSON 长度不一致
均按 schema 拒绝。fuel 是沙箱插桩/引擎报告的确定性指令单位；内存是
该 invocation 可归因的线性内存/堆增量；输出是 UTF-8 JSON 字节数；command count 是顶层命令数；递归、
事件链和 pending 均按进入深度计数，根为 0。达到上限允许，`上限 + 1` 使用对应稳定错误码拒绝。

| 预算 | 五类权威执行面 | `previewCode` | 错误码 |
| --- | ---: | ---: | --- |
| fuel | 100,000 | 20,000 | `SKILLCODE_BUDGET_FUEL_EXCEEDED` |
| 内存 | 16 MiB | 4 MiB | `SKILLCODE_BUDGET_MEMORY_EXCEEDED` |
| UTF-8 输出 | 64 KiB | 16 KiB | `SKILLCODE_BUDGET_OUTPUT_EXCEEDED` |
| commands | 256 | 0 | `SKILLCODE_BUDGET_COMMANDS_EXCEEDED` |
| 调用/递归深度 | 64 | 64 | `SKILLCODE_BUDGET_RECURSION_EXCEEDED` |
| 事件链深度 | 32 | 32（不能发事件） | `SKILLCODE_BUDGET_EVENT_CHAIN_EXCEEDED` |
| pending 重放深度 | 8 | 8（不能建 pending） | `SKILLCODE_BUDGET_PENDING_REPLAY_EXCEEDED` |

CPU wall-clock 仅作宿主健康兜底，不是确定性 ABI 计数，不能代替 fuel。宿主必须在强制终止后清理 invocation，
且下一健康探针不能继承其内存、任务或能力。

## 7. 稳定错误与诊断

机器错误全集由 `SKILLCODE_ABI_V1_ERROR_CODES` 冻结，覆盖版本、surface、capability、输入、输出、宿主引用、
异步、七类预算、执行与回滚。诊断至少携带 `code`、路径及外层可关联的 content/profile/runtime/trace 身份；
message 仅供人读，不得作为逻辑分支依据。

`rejected` 必须至少携带一个主错误和 `SKILLCODE_TRANSACTION_ROLLED_BACK`；`ok`/`pending` 不得携带回滚事实。
未知 ABI、权限、预算或执行错误都不得转入 `dynamic-code-runtime.ts`。调用解析顺序为：版本 → surface →
顶层/输入与宿主身份 → capability；结果验证顺序为：版本 → surface/根 trace → plain-data 与逐命令/pending/
诊断/status 不变量 → 可信预算 → 原子提交。执行器在进入结果验证前已把异常规范化为稳定执行错误。

## 8. 兼容策略

v1 只兼容精确版本和精确字段。新增可选字段、helper、命令或错误语义也必须经过合同审查；破坏性变化使用
新 ABI。现役受信代码继续按作者标准运行，不自动声称符合 v1 沙箱边界。外部内容仍由 Content Pipeline
拒绝，直到 RED-153、RED-154 与 Profile 准入任务全部完成。

## 9. fixtures 与回退

[`tests/fixtures/skillcode/v1/valid`](../../tests/fixtures/skillcode/v1/valid) 覆盖六类输入、权威命令与 pending；
[`invalid`](../../tests/fixtures/skillcode/v1/invalid) 覆盖缺失/未知版本、未知 capability 和未知字段。
[`tests/game/skillcode-abi-v1.test.ts`](../../tests/game/skillcode-abi-v1.test.ts) 另用运行时对象验证函数、Promise/thenable、自定义
原型、循环、伪造身份/计量、capability-command 绕过、逐 kind payload、pending replay 身份、回滚诊断、预算
边界加一、命令与输出放大。

回退方式是整体撤销本文、威胁模型、`abi-v1.ts`、fixtures、测试及索引引用。由于本任务没有接入生产执行
路径，无数据、存档或 runtime 迁移；不得以启用旧可信 eval 作为失败回退。

## 10. 独立安全审查记录

2026-08-31 的只读独立 AI 审查在初稿发现并阻断：命令未绑定本次 capability、预算可自报/省略、pending 缺
replay 身份、force-remove helper 漏列、Rule 交互文档冲突、拒绝结果缺回滚事实、错误优先级冲突、console
输出旁路、身份无可信来源以及 thenable 错误码不稳定。冻结稿已分别通过命令 schema 与 capability 绑定、宿主
身份/完整 meter、pending owner/revision/root/replay 字段、helper 显式支持/禁止、文档修正、拒绝诊断不变量、
版本优先解析、禁用 console 和 thenable 检测修复，并新增对应负例。沙箱隔离与强制终止仍是 RED-153/154 的
后续门禁，不属于本合同实现。
