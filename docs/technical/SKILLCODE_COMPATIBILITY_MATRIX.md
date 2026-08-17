# skillCode 兼容矩阵（RED-45）

状态：六类执行面 Node/浏览器差分 PASS；S01 已由 RED-76 修复，静态审计仅剩 S02 生产兼容 FAIL。基线：`origin/main@b8201dd` + RED-76。更新日期：2026-08-17。风险：Medium。

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
| 棋子技能 `code` | `executeSkillFunction`；`executeSkill(context)` | PASS：最小技能和真实 `shishio-combustion-passive` 的轨迹/hash 一致 | 支持技能选择与完整技能 helper；passive 的主动调用返回 `success:false` 并保持输入状态不变 |
| active/reactive 卡牌 `code` | `executeCardFunction`；`executeCard(context)` | PASS：active 卡经真实支付/弃牌路径执行；响应卡顺序另有 fixture | 卡牌无保证的 `sourcePiece`；reactive 卡复用可修改触发 context |
| AttachedEffect `filterCode/effectCode` | `TriggerSystem.checkTriggers`；`(ctx,battle,self)` | PASS：最小 filter/effect 轨迹/hash 一致 | helper 子集少于技能；异常由 TriggerSystem 附加 consumer/event 后抛出 |
| pending target `effectCode` | `pendingTargetSelect`；序列化 `function(ctx)` | PASS：真实 selection ID/revision 恢复，轨迹/hash 一致 | 闭包不可序列化；只保留 `ctx` 和确定性 `Math`/`Date` |

运行时证据：`tests/game/skillcode-browser-differential.test.ts`，六个通用 surface fixture 与一个真实 Shishio passive 固定 seed fixture 全部 PASS。Node 最小执行面基线仍保留在 `tests/game/skillcode-runtime-matrix.test.ts`。

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

## 静态兼容状态

### S01：技能代码不是可调用入口（RED-76 已修复）

`data/skills/shishio-combustion-passive.json#code` 已改为生产执行器可调用的 `function executeSkill(context) { ... }`。入口保持 `kind: passive`，被错误主动调用时只返回 `success:false` 且不修改状态；实际效果继续由 `beforeHealTaken`、`afterDamageDealt` 和 `beforeDamageDealt` 三个既有棋子规则触发。AST 语法诊断为 0。

#### RED-35 受影响准入行

| RED-35 候选棋子 | 修复任务 | 直接证据 | 结论 |
| --- | --- | --- | --- |
| `red-shishio` / 志志雄真实 | [RED-76](https://linear.app/redvsblue/issue/RED-76) | `tests/game/shishio-combustion-passive.test.ts`、`tests/game/skillcode-static-audit.test.ts`、固定 seed `7601` | F06 的 skillCode 准入阻塞已解除；完整 25 枚准入结论仍由 RED-35 汇总 |

### S02：AttachedEffect 使用未注入 helper

| 未支持 helper | 数据引用 |
| --- | --- |
| `removePlayerSkillById` | `effect-blizzard#triggers.0.effectCode` |
| `removePlayerStatusEffectById` | `effect-blackwidow-toxin#triggers.0.effectCode`, `effect-blizzard#triggers.0.effectCode` |
| `selectOption` | `effect-shishio#triggers.3.effectCode`, `effect-watcher-form#triggers.0.effectCode` |

这些名字存在于其他执行面，但 AttachedEffect wrapper 没有注入；触发相应分支会产生 `ReferenceError`，并按 TriggerSystem 异常合同中止/回滚外层动作。不得把其他 surface 的 helper 存在误当作兼容。

### 跟踪状态

S01 由 Medium Risk 任务 [RED-76](https://linear.app/redvsblue/issue/RED-76) 修复；S02 由独立任务 [RED-78](https://linear.app/redvsblue/issue/RED-78) 跟踪。两项均关联 RED-45，S01 另作为 RED-35 的 `red-shishio` 准入证据。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 六面 Node/浏览器轨迹 + hash | PASS | 6 个通用 surface fixture + 1 个真实 Shishio passive 固定 seed fixture |
| 四类 JSON 解析和生产 loader | PASS | 113 skills / 81 rules / 16 cards / 47 effects |
| 执行字段分类 | PASS | 0 unclassified；27 个 `triggerSkill` 引用均解析到现有技能 |
| 全量语法/helper 静态审计 | FAIL（仅剩既知 S02） | 语法诊断 0；AttachedEffect unsupported helper 仍令 CLI 退出码为 1 |
| RED-76 聚焦回归 | PASS | 3 个文件 / 14 项测试；seed `7601` 的主动调用拒绝、触发时机与 Node/浏览器最终 hash 一致 |
| 完整 Vitest | PASS | `npm test`：45 个文件 / 368 项测试 |
| 浏览器引擎构建与受影响套件 | PASS | `npm run build:game-engine`；随后 6 个文件 / 45 项测试通过 |
| RED-76 修改测试文件 ESLint | PASS | 3 个测试文件定向 ESLint，退出码 0 |
| 完整 ESLint | FAIL（既存基线；原始命令环境受限） | 原始 `npm run lint` 因递归扫描 `.worktrees` 超过 6 分钟、约 2.6 GB 后中止；排除 `.worktrees` 后完成并复现既存 1040 项（692 errors / 348 warnings） |

## 回退

RED-76 的数据修复可独立 revert；回退时保留静态审计、Shishio 固定 seed fixture 与任务记录，使 S01 重新显式失败。S02 证据继续保留并由 RED-78 处理；不得用删除候选棋子或放宽审计掩盖失败。
