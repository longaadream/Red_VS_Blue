# skillCode 兼容矩阵（RED-45 / RED-75）

状态：RED-75 六类固定 seed Node/浏览器 trace bridge 差分 PASS；全量静态数据审计仍发现生产兼容 FAIL，等待独立 issue 建单授权。基线：`origin/main@b8201dd`。审计日期：2026-08-17。风险：Medium。

本矩阵区分两类证据：

- **运行时差分**：同一 fixture 分别由 Node 模块和实际 `data/pages/js/game-engine.js` 执行，比较有序轨迹、关键结果和最终权威状态 hash。
- **全量静态审计**：扫描所有数据代码字段，使用 TypeScript AST 验证语法和词法自由变量，再按生产注入面标记 `supported`、`ambient` 或 `unsupported`。

最小 fixture PASS 不等于每一条数据定义都可执行；下面的静态 FAIL 正是这种区别的证据。

## 数据覆盖

`scripts/audit-skillcode-compat.mjs` 保持兼容 `schemaVersion: 2`，使用 `analysisVersion: 3` 输出 AST 结果。当前生产加载冒烟覆盖：

| 数据组 | 带 `id` 的定义 | 含可执行代码字段 | 其他执行引用 |
| --- | ---: | ---: | ---: |
| skills | 113 | 110 个 `code` | 其余为无代码/元数据定义 |
| rules | 81 | 54 个 `skillCode` | 27 个 `effect.type=triggerSkill` |
| cards | 16 | 16 个 `code` | active/reactive 共用执行器 |
| effects | 47 | 47 个定义含 `filterCode/effectCode` | 每个 trigger 分别分析 |

所有 JSON 均能解析并由生产 loader 找到；所有执行字段均已归入六类 surface，没有 unclassified 字段。语法和 helper 兼容性另见 FAIL。

## 六类执行面

| Surface | 生产入口 / 签名 | Node/浏览器结果 | 语义差异与限制 |
| --- | --- | --- | --- |
| 规则 `skillCode` | `loadRuleById`；语句体获得 `battle`, `context` 和 helper | PASS：真实 `rule-watcher-rage-dealt` 修改同一 context，轨迹/hash 一致 | 内联规则环境；内部异常被规则 wrapper 转为 `success:false` |
| 规则 `triggerSkill` | `loadRuleById` → 被引用技能执行环境 | PASS：真实 `rule-divine-blessing` 修改伤害并消费状态，轨迹/hash 一致 | 不等价于 inline `skillCode`；会适配并修改原触发 context |
| 棋子技能 `code` | `executeSkillFunction`；`executeSkill(context)` | PASS：最小技能经真实 action reducer 执行，轨迹/hash 一致 | 支持技能选择与完整技能 helper；失败通常返回 `success:false` |
| active/reactive 卡牌 `code` | `executeCardFunction`；`executeCard(context)` | PASS：active 卡经真实支付/弃牌路径执行；响应卡顺序另有 fixture | 卡牌无保证的 `sourcePiece`；reactive 卡复用可修改触发 context |
| AttachedEffect `filterCode/effectCode` | `TriggerSystem.checkTriggers`；`(ctx,battle,self)` | PASS：最小 filter/effect 轨迹/hash 一致 | helper 子集少于技能；异常由 TriggerSystem 附加 consumer/event 后抛出 |
| pending target `effectCode` | `pendingTargetSelect`；序列化 `function(ctx)` | PASS：真实 selection ID/revision 恢复，轨迹/hash 一致 | 闭包不可序列化；只保留 `ctx` 和确定性 `Math`/`Date` |

运行时证据：`tests/game/skillcode-browser-differential.test.ts`，六个表驱动 fixture 全部 PASS。Node 最小执行面基线仍保留在 `tests/game/skillcode-runtime-matrix.test.ts`。

## RED-75 统一 trace bridge

`tests/helpers/skillcode-trace-bridge.ts` 将两端证据规范化为 `fixture`、`surface`、`seed`、`command`、有序 `trace`、`actionLog`、`outcome` 和由各自 runtime 计算的 `stateHash`。比较按字段顺序递归定位首个差异；失败信息包含 fixture、十六进制/十进制 seed、完整命令、首差异路径、两端值及可复制的构建/聚焦测试命令。诊断消息本身有独立回归测试。

| Fixture / surface | 固定 seed | 命令 / trace 摘要 | action log | 最终 hash |
| --- | ---: | --- | --- | --- |
| `rule-skill-code` / 规则 `skillCode` | `0x00750001` | `dispatchTrigger(beforeDamageDealt, damage=3)` → damage 6 | `[]` | `c92ec38086b617c933aea911d3c959a4a67032d8abd55e0a265613e7d631da9c` |
| `rule-trigger-skill` / 规则 `triggerSkill` | `0x00750002` | 同一事件 → damage 7、状态被消费 | `[]` | `f24b9b3865ec0f9e0c065da2c1faf086c36b6a624b5d8311bc9454b1ebc35255` |
| `piece-skill-code` / 棋子技能 `code` | `0x00750003` | `useBasicSkill(matrix-skill)` → `skillCode` trace | `useBasicSkill` | `0324fa769920e669c017bc52b02639f17bb709bd209b682971c30b33327acb23` |
| `active-card-code` / 卡牌 `code` | `0x00750004` | `playCard(matrix-card-instance)` → `cardCode` trace | `playCard` | `f4dbc6696eb93775044b6d09b9c98c4ab3b6d92f27c5eadddab0531adf790e71` |
| `attached-effect-filter-effect-code` | `0x00750005` | `dispatchTrigger(matrix-attached)` → event + effect trace | `[]` | `483a2b12844fd070c11ead7e69a3de599f20602f04bb382ed9e6a1e24da98757` |
| `pending-serialized-effect-code` | `0x00750006` | `pendingTargetSelect(2,1)` → pending effect trace | `triggerEffect` | `1f1f5a5cb80a85f90deb68222cc289efc675a7c1a16875794f0d5150e5502cf3` |

`dispatchTrigger` 是测试侧对真实 `TriggerSystem.checkTriggers` 调用的可序列化命令描述，不是新增生产动作；它不提交玩家动作，因此对应 `actionLog` 预期为空，但两端仍逐项比较该空日志。技能、卡牌和 pending fixture 通过真实 reducer 生成非空日志。所有 fixture 都在 Node 实现与由 `npm run build:game-engine` 生成的实际 IIFE bundle 中执行，不使用触发器 mock。

需要保留完整证据时，可启用受控报告模式；默认测试不输出这些 JSON：

```powershell
$env:RED75_TRACE_REPORT = '1'
npx.cmd --no-install vitest run tests/game/skillcode-browser-differential.test.ts --reporter=verbose --silent=false
Remove-Item Env:RED75_TRACE_REPORT
```

## 实际注入绑定

AST 报告在每个 `file#path` 下列出自由变量及结论；以下是生产面允许的绑定集合摘要。

### 规则 `skillCode`

支持：`battle`, `context`, `dealDamage`, `healDamage`, `addCardToHand`, `checkToxin`, `addStatusEffectById`, `removeStatusEffectById`, `addPlayerRuleById`, `removePlayerRuleById`, `addRuleById`, `removeRuleById`, `addPlayerStatusEffectById`, `removePlayerStatusEffectById`, `addPlayerSkillById`, `removePlayerSkillById`, `selectOption`, `applyEffect`, `removeEffect`, `getPieceEffect`, `fireEvent`, `Math`, `Date`。

### 技能 `code`

支持：`context`, `sourcePiece`, `battle`, `select`, `selectTarget`, `selectOption`, `teleport`, `dealDamage`, `healDamage`, `traceProjectile`, `addStatusEffectById`, `removeStatusEffectById`, `getAllEnemiesInRange`, `getAllAlliesInRange`, `calculateDistance`, `isTargetInRange`, `addRuleById`, `removeRuleById`,所有 player rule/skill/status 增删 helper、`addSkillById`, `removeSkillById`, `addCardToHand`, `discardCard`, `getHand`, `applyEffect`, `removeEffect`, `getPieceEffect`, `fireEvent`, `Math`, `Date`, `console`。

### 卡牌 `code`

支持：`context`, `battle`, `playerId`, `selectTarget`, `selectOption`, `dealDamage`, `healDamage`, `addCardToHand`, `discardCard`, `getHand`, `addStatusEffectById`, `removeStatusEffectById`, `addRuleById`, `removeRuleById`, `addPlayerRuleById`, `removePlayerRuleById`, `Math`, `Date`, `console`。

`context` 统一包含 card、playerId、battle、piece（可能为 null）、target、targetPosition、targets 和 selectedOption。多目标由 `targets`/`extraTargets` 保留顺序。

### AttachedEffect

参数：`ctx`, `battle`, `self`。注入 helper：`dealDamage`, `healDamage`, `removeStatusEffectById`, `addStatusEffectById`, `addRuleById`, `removeRuleById`, `applyEffect`, `removeEffect`, `getPieceEffect`, `fireEvent`, `addCardToHand`, `Math`, `Date`。

`self` 是附加效果实例视图并提供 `expire()` 等能力。它不是规则拥有者 context，也不自动拥有 skill/card 的全部 helper。

### pending `effectCode`

函数参数 `ctx` 包含 battle、pending、当前目标、完整 selectedTargets。运行时只额外注入确定性 `Math` 与 `Date`；任何外部闭包、模块变量或未序列化 helper 都不支持。

### JS ambient

`Array`, `Boolean`, `Error`, `Infinity`, `JSON`, `Map`, `NaN`, `Number`, `Object`, `Promise`, `RegExp`, `Set`, `String`, `Symbol`, `console`, `isFinite`, `isNaN`, `parseFloat`, `parseInt`, `setTimeout`, `undefined` 被标记为 `ambient`。它们不是 Red VS Blue helper；在未来 eval 沙箱化任务中必须重新审查，不在 RED-45 修改安全边界。

## RNG、时钟与实例 ID

RED-28 已提供命名随机流、规则时钟和确定性实例 ID。规则、技能、卡牌、AttachedEffect 和 pending wrapper 均使用注入的 `Math`/`Date`；固定 state/seed/action 的 Node/浏览器最终 hash 由差分测试验证。`addCardToHand` 等创建实例的 helper 在存在 active `RuleRuntime` 时使用确定性实例 ID 流。

本审计不宣称任意 JS ambient 都是确定性的；只有显式注入的规则 `Math`/`Date` 和生产 runtime trace 属于权威证据。

## 克隆、序列化与恢复

- `safeCloneBattleState` JSON 克隆状态，并由 loader 恢复规则/技能运行时函数；函数本身不进入权威状态 hash。
- pending `effectCode` 保存字符串并在恢复时重新编译；闭包不保留是已记录的语义差异。
- 规则和卡牌缓存必须返回独立、可恢复的运行时对象；并行房间/镜像测试证明本次 fixture 未串状态。
- 浏览器 bundle 通过相同 fixture 执行六面；测试不要求修改 `engine-browser-entry.ts` 或提交生成物。

## 静态兼容 FAIL

### S01：技能代码不是可调用入口

`data/skills/shishio-combustion-passive.json#code` 内容为顶层 `return { success: false, ... }`，不是生产执行器要求的 `function executeSkill(context) { ... }`。AST 报告两个语法诊断；若执行该定义，wrapper 最终找不到 `executeSkill`。本任务只保留复现，不改数据。

### S02：AttachedEffect 使用未注入 helper

| 未支持 helper | 数据引用 |
| --- | --- |
| `removePlayerSkillById` | `effect-blizzard#triggers.0.effectCode` |
| `removePlayerStatusEffectById` | `effect-blackwidow-toxin#triggers.0.effectCode`, `effect-blizzard#triggers.0.effectCode` |
| `selectOption` | `effect-shishio#triggers.3.effectCode`, `effect-watcher-form#triggers.0.effectCode` |

这些名字存在于其他执行面，但 AttachedEffect wrapper 没有注入；触发相应分支会产生 `ReferenceError`，并按 TriggerSystem 异常合同中止/回滚外层动作。不得把其他 surface 的 helper 存在误当作兼容。

### 建单状态

S01 与 S02 应分别建立 Medium Risk 修复 issue，并关联 RED-45/RED-35 及具体棋子。创建 payload 已准备，但 Linear 连接器要求用户明确授权将仓库缺陷与路径外发，因此当前为 BLOCKED；没有尝试绕过。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 六面 Node/浏览器 seed + command + trace + action log + hash | PASS | 六个 fixture 分别 1/1；矩阵 7/7（含差异诊断回归） |
| 四类 JSON 解析和生产 loader | PASS | 113 skills / 81 rules / 16 cards / 47 effects |
| 执行字段分类 | PASS | 0 unclassified；27 个 `triggerSkill` 引用均解析到现有技能 |
| 全量语法/helper 静态审计 | FAIL（预期审计发现） | S01、S02；CLI 退出码 1 |
| 浏览器引擎构建与相关套件 | PASS | `npm run build:game-engine`；3 个文件 / 16 项测试 |
| 定向 ESLint | PASS | RED-75 测试与 trace bridge helper 无错误 |
| 完整 Vitest | PASS | `npm test`：44 个文件 / 365 项测试 |
| 编码检查 | PASS | `npm run check:encoding`：552 个文本文件 |
| 根 TypeScript 检查 | FAIL（既有范围外） | `combat-complex-mechanisms.test.ts:29` 的既有 `PieceInstance` fixture 缺少 `name/buffs/debuffs/ruleTags`；RED-75 未修改该文件 |
| 独立 AI 审查 | PASS | 只读复验 build、6/6 fixture、相关 16/16、完整 365/365、编码、ESLint、allowed_paths；无 P1–P3 发现 |

## 回退

可独立 revert 本矩阵、AST 脚本和测试 fixture；不得删除 S01/S02 的最小复现和后续缺陷记录。任何 helper 扩展、数据修复或解释器变化必须进入独立 Medium/High Risk issue，并提供 Node/浏览器差分与回退方案。
