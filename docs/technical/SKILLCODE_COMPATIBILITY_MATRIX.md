# skillCode 兼容矩阵（RED-45 / RED-75 / RED-80）

状态：RED-80 已按批准方案移除不可达的 AttachedEffect 执行面；当前权威架构为 Rule + statusTag。RED-75 的 Node/浏览器差分矩阵由六类收敛为五类。审计日期：2026-08-17。风险：High（跨模块架构清理）。

本矩阵区分两类证据：

- **运行时差分**：同一 fixture 分别由 Node 模块和实际 `data/pages/js/game-engine.js` 执行，比较有序轨迹、关键结果和最终权威状态 hash。
- **全量静态审计**：扫描所有数据代码字段，使用 TypeScript AST 验证语法和词法自由变量，再按生产注入面标记 `supported`、`ambient` 或 `unsupported`。

最小 fixture PASS 不等于每一条数据定义都可执行；全量静态审计结论仍单独保留。

## 数据覆盖

`scripts/audit-skillcode-compat.mjs` 保持 `schemaVersion: 2`，以 `analysisVersion: 4` 输出 AST 结果。当前生产加载冒烟覆盖：

| 数据组 | 带 `id` 的定义 | 含可执行代码字段 | 其他执行引用 |
| --- | ---: | ---: | ---: |
| skills | 113 | 110 个 `code` | 其余为无代码/元数据定义 |
| rules | 81 | 54 个 `skillCode` | 27 个 `effect.type=triggerSkill` |
| cards | 16 | 16 个 `code` | active/reactive 共用执行器 |

所有 JSON 均能解析并由生产 loader 找到；所有执行字段均已归入五类 surface，没有 unclassified 字段。AttachedEffect 的 47 个定义和 manifest 已由 RED-80 删除，不再被审计或加载。

## 五类执行面

| Surface | 生产入口 / 签名 | Node/浏览器结果 | 语义差异与限制 |
| --- | --- | --- | --- |
| 规则 `skillCode` | `loadRuleById`；语句体获得 `battle`、`context` 和 helper | 真实 `rule-watcher-rage-dealt` 修改同一 context | 内联规则环境；内部异常被规则 wrapper 转为 `success:false` |
| 规则 `triggerSkill` | `loadRuleById` → 被引用技能执行环境 | 真实 `rule-divine-blessing` 修改伤害并消费状态 | 不等价于 inline `skillCode`；会适配并修改原触发 context |
| 棋子技能 `code` | `executeSkillFunction`；`executeSkill(context)` | 最小技能经真实 action reducer 执行 | 支持技能选择与完整技能 helper；失败通常返回 `success:false` |
| active/reactive 卡牌 `code` | `executeCardFunction`；`executeCard(context)` | active 卡经真实支付/弃牌路径执行 | 卡牌无保证的 `sourcePiece`；reactive 卡复用可修改触发 context |
| pending target `effectCode` | `pendingTargetSelect`；序列化 `function(ctx)` | 真实 selection ID/revision 恢复 | 闭包不可序列化；只保留 `ctx` 和确定性 `Math`/`Date` |

`pendingTargetSelection.effectCode` 中的 “effect” 只是“完成这次待选交互后执行的续接函数”的历史字段名，不是 AttachedEffect 实例，也不读取 `data/effects`。RED-80 明确保留 pending target/option 会话、选择 revision 和规则剩余队列。

运行时证据：`tests/game/skillcode-browser-differential.test.ts` 的五个表驱动 fixture，以及 `tests/game/skillcode-runtime-matrix.test.ts` 的 Node 最小执行面基线。

## RED-75 统一 trace bridge

`tests/helpers/skillcode-trace-bridge.ts` 将两端证据规范化为 `fixture`、`surface`、`seed`、`command`、有序 `trace`、`actionLog`、`outcome` 和由各自 runtime 计算的 `stateHash`。比较按字段顺序递归定位首个差异；失败信息包含 fixture、十六进制/十进制 seed、完整命令、首差异路径、两端值及可复制的构建/聚焦测试命令。

| Fixture / surface | 固定 seed | 命令 / trace 摘要 | action log | 最终 hash |
| --- | ---: | --- | --- | --- |
| `rule-skill-code` / 规则 `skillCode` | `0x00750001` | `dispatchTrigger(beforeDamageDealt, damage=3)` → damage 6 | `[]` | `c92ec38086b617c933aea911d3c959a4a67032d8abd55e0a265613e7d631da9c` |
| `rule-trigger-skill` / 规则 `triggerSkill` | `0x00750002` | 同一事件 → damage 7、状态被消费 | `[]` | `f24b9b3865ec0f9e0c065da2c1faf086c36b6a624b5d8311bc9454b1ebc35255` |
| `piece-skill-code` / 棋子技能 `code` | `0x00750003` | `useBasicSkill(matrix-skill)` → `skillCode` trace | `useBasicSkill` | `0324fa769920e669c017bc52b02639f17bb709bd209b682971c30b33327acb23` |
| `active-card-code` / 卡牌 `code` | `0x00750004` | `playCard(matrix-card-instance)` → `cardCode` trace | `playCard` | `f4dbc6696eb93775044b6d09b9c98c4ab3b6d92f27c5eadddab0531adf790e71` |
| `pending-serialized-effect-code` | `0x00750006` | `pendingTargetSelect(2,1)` → pending trace | `triggerEffect` | `1f1f5a5cb80a85f90deb68222cc289efc675a7c1a16875794f0d5150e5502cf3` |

`dispatchTrigger` 是测试侧对真实 `TriggerSystem.checkTriggers` 调用的可序列化命令描述，不是新增生产动作。所有 fixture 都在 Node 实现与由 `npm run build:game-engine` 生成的实际 IIFE bundle 中执行，不使用 reducer、触发器或 loader mock。

需要保留完整证据时，可启用受控报告模式：

```powershell
$env:RED75_TRACE_REPORT = '1'
npx.cmd --no-install vitest run tests/game/skillcode-browser-differential.test.ts --reporter=verbose --silent=false
Remove-Item Env:RED75_TRACE_REPORT
```

## Rule + statusTag 权威基线

`tests/game/attached-effect-removal.test.ts` 使用真实规则 loader 和 `TriggerSystem` 固定六个代表场景；RED-80 清理前后结果与 hash 必须一致：

| 场景 | 规则 | 最终 hash |
| --- | --- | --- |
| 沉默阻止技能 | `rule-silenced-block` | `b9100a73f0572db09ab117d6996acb0e7a138fc3eb4f63efdb9a8c2491b29d49` |
| 冰冻阻止移动 | `rule-freeze-prevent-move` | `d323adef5d280060b1421cda440baffa4af6dca232ef937d0b051ff6c392f03b` |
| 圣盾阻止伤害 | `rule-divine-shield` | `1235a749ff165ff000ef7ccd4c9da1c615a7d915cc7af42273b2dea53258c9cb` |
| 睡眠阻止移动 | `rule-sleep-prevent-move` | `b10bb61b0e19f0bd1a305763d31e4224b6d0b395bf517bd877a8a5f4344bb2fd` |
| 观察者狂怒增伤 | `rule-watcher-rage-dealt` | `0170d1b8e9ad9875536a5e2862ffcc0c71f5483d31f54f95fb41357d45219446` |
| 血誓回合结算 | `rule-blood-oath-tick` | `e07b203a91a4adb51cb157b50679476f09c7b2f90d7bc888e225e3ed59f47948` |

非空旧 `piece.attachedEffects` / `graveyard[].attachedEffects` 在动作入口抛出 `LEGACY_ATTACHED_EFFECT_UNSUPPORTED`；旧/custom 棋子模板的非空 `initialEffects` 在初始化时同样拒绝。守卫只识别并报错，不保留任何旧代码执行能力。

## 实际注入绑定

### 规则 `skillCode`

支持：`battle`、`context`、伤害/治疗、卡牌、Rule、statusTag、player rule/skill/status 增删 helper、`selectOption`、`fireEvent`、`Math`、`Date`。不再注入 `applyEffect`、`removeEffect`、`getPieceEffect`。

### 技能 `code`

支持完整技能选择/位移/伤害/治疗/Rule/statusTag/卡牌 helper、`fireEvent`、`Math`、`Date`、`console`。不再注入 AttachedEffect helper。

### 卡牌 `code`

支持 `context`、`battle`、`playerId`、选择、伤害/治疗、手牌、Rule/statusTag helper、`Math`、`Date`、`console`。

### pending `effectCode`

函数参数 `ctx` 包含 battle、pending、当前目标、完整 selectedTargets。运行时只额外注入确定性 `Math` 与 `Date`；任何外部闭包、模块变量或未序列化 helper 都不支持。

### JS ambient

`Array`、`Boolean`、`Error`、`JSON`、`Map`、`Object`、`Promise`、`Set`、`String`、`console` 等被标记为 `ambient`。它们不是 Red VS Blue helper；未来 eval 沙箱化时必须重新审查。

## RNG、克隆与恢复

RED-28 提供命名随机流、规则时钟和确定性实例 ID。规则、技能、卡牌和 pending wrapper 使用注入的 `Math`/`Date`；固定 state/seed/action 的 Node/浏览器最终 hash 由差分测试验证。

- `safeCloneBattleState` JSON 克隆状态，并由 loader 恢复规则/技能运行时函数；函数本身不进入权威状态 hash。
- pending `effectCode` 保存字符串并在恢复时重新编译；闭包不保留是已记录的语义差异。
- 规则和卡牌缓存必须返回独立、可恢复的运行时对象；并行房间/镜像测试负责防止串状态。

## 静态兼容结论

所有保留的执行字段均通过语法检查，且没有使用未注入 helper。原 AttachedEffect 使用缺失 helper 的问题已由 RED-80 删除整个不可达执行面和数据组解决，不再是运行时兼容项；RED-78 的缺失 helper 症状因此应由 RED-80 取代，而不是重新扩展旧系统。

### RED-76 志志雄被动回归

`data/skills/shishio-combustion-passive.json#code` 保持为生产执行器可调用的 `function executeSkill(context) { ... }`。入口仍为 `kind: passive`；错误主动调用会返回 `success:false`，外层动作以固定 seed `7601` 拒绝且输入状态不变。实际效果继续由 `beforeHealTaken`、`afterDamageDealt` 和 `beforeDamageDealt` 三个棋子 Rule 触发。

该真实数据回归由 `tests/game/shishio-combustion-passive.test.ts` 与 `tests/game/skillcode-browser-differential.test.ts` 保留。它属于棋子技能 `code` 的额外 fixture，不是新的执行面，也不会恢复 AttachedEffect。

## 验证结果

| 检查 | 当前结果 |
| --- | --- |
| RED-80 聚焦回归 | PASS：10 个文件 / 94 项（覆盖移除守卫、触发顺序、五面 Node/浏览器差分、RED-76 真实被动回归和核心动作） |
| 五面 Node/浏览器 trace + action log + hash | PASS：浏览器相关 3 个文件 / 15 项；五个 surface 保持固定 hash |
| 三类 JSON 解析和生产 loader | PASS：113 skills / 81 rules / 16 cards |
| 执行字段分类 | PASS：0 unclassified；27 个 `triggerSkill` 引用可解析 |
| 全量语法/helper 静态审计 | PASS：0 个语法诊断；`unsupportedUse={}` |
| 完整 Vitest / TypeScript / 编码 | PASS：47 个文件 / 377 项；`npx tsc --noEmit`；511 个文本文件 |
| ESLint | RED-80 新建/实质重写的 8 个文件定向 PASS；全仓 `npm run lint` 既有基线仍 FAIL（639 errors / 334 warnings） |
| 构建 / 真实浏览器冒烟 | PASS：bundle 构建；QA 训练局完成 Rule pending 选择与 statusTag 显示；0 个旧 API export |
| 独立审查 | 实现与真实浏览器证据无其他阻断；合同验收 BLOCKED：全仓 `npm run lint` 基线未通过，需人工 waiver 或另行清债 |

真实浏览器步骤：在本地 QA 路由启动“志志雄真实 vs 观者”训练局；结束先手回合后，`rule-watcher-form` 打开 pending 选项；选择“平静”使手牌 1→2，出牌后行动点 10→9、手牌 2→1。选中观者时详情栏显示“平静护盾（1层、永久、强度2）”和“平静姿态（1层、永久）”，权威状态含 `rule-watcher-shield`，两枚棋子均无 `attachedEffects` 字段。

QA 路由控制台仍记录资源包候选路径探测及既有缺失 `data/skills/evil-explosion.json` 的 404；训练局、Rule/pending/出牌/statusTag 流程均完成，未观察到规则执行异常。该资源缺口不在 RED-80 范围内。

## 回退

RED-80 可整体 revert 以恢复旧模块、数据、第五触发阶段、六面矩阵和 bundle。不得只恢复 `data/effects` 而不恢复 loader/执行器，也不得只恢复 helper 名称制造半迁移状态。回退后必须重跑六面差分与固定 seed 规则回放。
