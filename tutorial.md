# 游戏技能系统教程

## 目录

1. [黄金法则（必读）](#黄金法则必读)
2. [文件结构一览](#文件结构一览)
3. [技能JSON完整格式](#技能json完整格式)
4. [技能执行上下文（Context）](#技能执行上下文context)
5. [可用函数完整参考](#可用函数完整参考)
6. [主动技能编写指南](#主动技能编写指南)
7. [被动技能编写指南](#被动技能编写指南)
8. [目标选择器（selectTarget）](#目标选择器selecttarget)
9. [选项选择器（selectOption）](#选项选择器selectoption)
10. [状态系统](#状态系统)
11. [阻止行动（blocked）](#阻止行动blocked)
12. [触发类型完整参考](#触发类型完整参考)
13. [禁止做法（反模式）](#禁止做法反模式)
14. [完整角色创建示例](#完整角色创建示例)
15. [故障排除](#故障排除)
16. [游戏系统常量](#游戏系统常量)
17. [训练营使用教程](#训练营使用教程)
18. [地图设计教程](#地图设计教程)
19. [玩家级别规则（Player-Level Rules）](#玩家级别规则player-level-rules)

---

## 黄金法则（必读）

**在编写任何技能前，必须牢记以下五条规则。违反任何一条将导致技能无法正常工作。**

### 法则一：所有效果必须在 `code` 字段中实现

技能 JSON 文件的 `code` 字段包含一段 JavaScript，这是技能效果的唯一来源。**不存在任何通过 JSON 字段自动执行的效果**。

```
✅ 正确：在 code 里写 dealDamage(...) 造成伤害
❌ 错误：在 JSON 里写 "damage": 10 期望自动造成伤害
```

### 法则二：伤害和治疗必须通过函数调用实现

**禁止**直接修改 `currentHp`。必须使用 `dealDamage` 和 `healDamage` 函数，以确保触发器、护盾、防御力减免等系统正常工作。

```javascript
// ✅ 正确
dealDamage(sourcePiece, target, 10, 'physical', context.battle, context.skill.id)

// ❌ 错误 — 绕过了所有防御和触发器逻辑
target.currentHp -= 10
```

### 法则三：所有条件判断必须用 `if` 在 `code` 里实现

规则文件（rules）只定义**触发时机**，不定义任何条件。所有"当HP低于50%时"、"当距离小于3格时"等条件，全部用 `if` 语句在技能代码中实现。

```
✅ 正确：规则只写 "trigger": { "type": "afterDamageTaken" }
❌ 错误：规则里写 "conditions": [{ "field": "hp", "operator": "<", "value": 0.5 }]
```

### 法则四：调用 selectTarget / selectOption 后必须立即检查返回值

这两个函数在玩家未选择时会返回一个特殊对象，技能必须立即将其返回，否则会执行错误逻辑。

```javascript
// ✅ 正确
const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' })
if (!target || target.needsTargetSelection) return target

// ❌ 错误 — 没有检查，target 可能是 { needsTargetSelection: true }，接下来的代码会崩溃
dealDamage(sourcePiece, target, 10, 'physical', context.battle, context.skill.id)
```

### 法则五：被动技能需要"规则+技能"两个文件配对

被动技能（`kind: "passive"`）不能单独工作。需要：
1. 一个**技能文件**（`data/skills/xxx.json`）：实现效果逻辑
2. 一个**规则文件**（`data/rules/rule-xxx.json`）：定义触发时机，并调用技能
3. 在角色的**初始化技能**或**施加状态时**，通过 `addRuleById` 将规则绑定到棋子

#### 规则文件的正确写法

```json
{
  "id": "rule-my-passive",
  "name": "我的被动规则",
  "description": "触发时机的描述",
  "trigger": { "type": "afterSkillUsed" },
  "effect": { "type": "triggerSkill", "skillId": "my-passive-effect", "message": "" }
}
```

#### 规则文件的错误写法（禁止）

```json
// ❌ 错误！禁止在规则文件中直接写 skillCode
{
  "id": "rule-my-passive",
  "trigger": { "type": "afterSkillUsed" },
  "skillCode": "function executeSkill(context) { ... }"
}
```

所有效果逻辑必须写在技能文件中，规则文件只定义触发时机。

### 法则六：角色技能必须独立于游戏主进程

所有角色的技能效果都必须通过 `data/skills/` 和 `data/rules/` 目录下的 JSON 文件定义。**禁止**在 `lib/game/` 下的主进程代码中硬编码任何特定角色的技能逻辑。角色应当是独立的模块，可以随时添加或删除，与游戏核心逻辑解耦。

```
✅ 正确：在 data/skills/ 和 data/rules/ 中定义技能效果
✅ 正确：通过 addRuleById 动态绑定规则到棋子
❌ 错误：在 lib/game/turn.ts 等主进程文件中硬编码角色技能逻辑
```

### 法则七：Context 必须是真实引用（引擎开发者必读）

**所有传递给触发器的 Context 对象必须是真实引用，禁止创建新对象拷贝。**

这是整个触发器系统的核心机制。触发器通过修改 Context 对象的字段来影响原始事件（如修改伤害值、治疗量、移动目标等）。如果创建了新对象，触发器的修改将无法反映到原始事件上。

```javascript
// ✅ 正确：直接传递对象字面量（引用）
const damageContext = {
  type: "beforeDamageDealt",
  damage: baseDamage,
  piece: attacker,
  target: target
};
globalTriggerSystem.checkTriggers(battle, damageContext);
// 触发器修改 damageContext.damage 后，这里读取到的是修改后的值
const finalDamage = damageContext.damage;

// ❌ 错误：创建新对象拷贝
const skillContext = {
  damage: context.damage,  // 值复制，不是引用
  piece: context.sourcePiece
};
// 触发器修改 skillContext.damage，但原始的 context.damage 不变
```

**关键检查点：**
- `dealDamage` / `healDamage` 函数中创建的 `damageContext` / `healContext`
- `loadRuleById` 中构建的技能执行上下文
- `executeCardFunction` 中构建的卡牌执行上下文
- `turn.ts` 中 `beforeMove` / `beforeSkillUse` 等创建的上下文

**所有触发器调用必须遵循：**
1. 使用对象字面量直接创建 context
2. 如需基于现有 context 扩展，直接修改原对象（`context.newField = value`）
3. 禁止解构赋值后创建新对象（`{ ...context }`）
4. 禁止通过函数参数重新赋值创建新引用

---

## Context 引用传递机制（重要）

### 核心概念

在触发器系统中，**Context 对象通过引用传递**，这意味着触发器（规则）可以直接修改 Context 中的字段，从而影响原始事件的执行。

### 可修改的 Context 字段

| 字段 | 适用触发类型 | 说明 |
|------|-------------|------|
| `context.damage` | `beforeDamageDealt`, `beforeDamageTaken` | 修改即将造成的伤害值 |
| `context.heal` | `beforeHealDealt`, `beforeHealTaken` | 修改即将造成的治疗量 |
| `context.targetX` / `context.targetY` | `beforeMove`, `beforePieceSummoned` | 修改移动/召唤的目标位置 |
| `context.skillId` | `beforeSkillUse` | 修改即将使用的技能 |
| `context.targetPiece` | 多种触发类型 | 修改或替换目标棋子 |
| `context.damageType` | `beforeDamageDealt` | 修改伤害类型（physical/magical/true/toxin） |
| `context.amount` | `afterChargeGained` 等 | 修改数值类事件的数值 |

### 只读 Context 字段

| 字段 | 说明 |
|------|------|
| `context.piece` | 触发事件的棋子（攻击者/被攻击者/治疗者等，取决于触发类型） |
| `context.target` | 事件目标的棋子（被攻击者/攻击者/被治疗者等） |
| `context.rulePiece` | **当前执行规则的棋子**（规则绑定者），用于区分事件源和规则拥有者 |
| `context.type` | 触发类型 |
| `context.battle` | 当前战斗状态 |
| `context.skill` | 当前技能信息（技能相关触发） |

### 使用示例：伤害加成

```javascript
// 在 beforeDamageDealt 触发器中增加伤害
function executeSkill(context) {
  // 直接修改 context.damage，不需要返回
  context.damage = context.damage + 5
  return { success: true, message: '伤害增加5点' }
}
```

### 使用示例：改变移动目标

```javascript
// 在 beforeMove 触发器中改变移动目的地
function executeSkill(context) {
  // 将目标位置改为 (5, 5)
  context.targetX = 5
  context.targetY = 5
  return { success: true, message: '移动目标被改变' }
}
```

### 使用示例：技能替换

```javascript
// 在 beforeSkillUse 触发器中替换技能
function executeSkill(context) {
  // 将原本要使用的技能替换为另一个技能
  if (context.skillId === 'fireball') {
    context.skillId = 'frostbolt'
    return { success: true, message: '火球术被替换为寒冰箭' }
  }
  return { success: false }
}
```

### 工作原理

1. **创建 Context 对象**：在 `dealDamage`、`healDamage`、移动、使用技能等操作前，系统创建一个 Context 对象
2. **传递引用**：Context 对象作为引用传递给 `checkTriggers` 函数
3. **触发器修改**：各个触发器（规则）可以直接修改 Context 对象的字段
4. **使用修改后的值**：系统使用 Context 对象中可能被修改过的字段执行原始操作

```typescript
// 以 dealDamage 为例的工作流程：
const damageContext = {
  type: "beforeDamageDealt",
  sourcePiece: attacker,
  targetPiece: target,
  damage: baseDamage,  // 原始伤害值
  skillId
}

// 触发器可以修改 damageContext.damage
checkTriggers(battle, damageContext)

// 使用可能被修改过的伤害值
const finalDamage = damageContext.damage  // 可能是触发器修改后的值
```

### 注意事项

1. **不是所有字段都可以修改**：只有上面表格中列出的字段支持被触发器修改
2. **修改是立即生效的**：触发器对 Context 的修改会立即影响后续逻辑
3. **多个触发器的叠加**：如果有多个触发器修改同一个字段，后面的修改会覆盖前面的
4. **类型安全**：修改字段时请保持类型一致（如 `damage` 必须是 number）

---

## 文件结构一览

```
data/
├── skills/          ← 技能定义文件（*.json）
├── rules/           ← 触发规则文件（*.json）
├── status-effects/  ← 状态效果定义文件（*.json）
├── pieces/          ← 角色（棋子）定义文件（*.json）
└── maps/            ← 地图文件（*.json）
```

| 文件类型 | 目录 | 用途 |
|---------|------|------|
| 技能（Skill） | `data/skills/` | 定义技能效果代码，所有逻辑在 `code` 字段 |
| 规则（Rule） | `data/rules/` | 定义被动技能的触发时机，调用对应技能 |
| 状态（Status） | `data/status-effects/` | 定义可视化的状态标签（不含逻辑） |
| 角色（Piece） | `data/pieces/` | 定义角色属性和初始技能列表 |

---

## 技能JSON完整格式

### 完整字段说明

```json
{
  "id": "my-skill",
  "name": "我的技能",
  "description": "技能的静态描述文字，显示在技能提示框中",
  "icon": "⚔️",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 2,
  "maxCharges": 0,
  "powerMultiplier": 1.5,
  "actionPointCost": 1,
  "code": "function executeSkill(context) { ... return { success: true, message: '...' }; }",
  "previewCode": "function calculatePreview(piece, skillDef) { return { description: '...', expectedValues: {} }; }"
}
```

### 每个字段详解

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一ID，小写字母+连字符，如 `"flame-strike"` |
| `name` | string | ✅ | 玩家看到的技能名称 |
| `description` | string | ✅ | 技能描述，用于 UI 显示 |
| `icon` | string | 否 | emoji 图标，如 `"🔥"` |
| `kind` | `"active"` \| `"passive"` | ✅ | `active`=玩家手动释放；`passive`=由规则触发 |
| `type` | `"normal"` \| `"super"` \| `"ultimate"` | ✅ | `normal`=普通技能；`super`=充能技能；`ultimate`=限定技（只能用一次） |
| `cooldownTurns` | number | ✅ | 冷却回合数，0=无冷却 |
| `maxCharges` | number | ✅ | 最大充能层数，普通技能填 0 |
| `powerMultiplier` | number | ✅ | 威力系数，用于伤害计算，如 `1.5` 代表 150% |
| `actionPointCost` | number | ✅ | 消耗的行动点，被动技能填 0 |
| `code` | string | ✅ | **技能效果代码**，必须定义 `executeSkill(context)` 函数 |
| `previewCode` | string | 否 | 技能预览代码，定义 `calculatePreview(piece, skillDef)` 函数 |

### 关于 `kind` 字段

- **`"active"`**（主动技能）：玩家在战斗界面点击按钮释放。技能代码在释放时执行。
- **`"passive"`**（被动技能）：不显示在操作按钮中。由规则系统在特定时机调用。被动技能的效果完全通过规则触发。

### 关于 JSON 中的换行

JSON 字符串中不能有真实换行符。技能 `code` 字段里的换行必须用 `\n` 表示，或者写在一行。推荐的写法是将所有代码**写在一行**，不使用实际换行。

---

## 技能执行上下文（Context）

当技能的 `executeSkill(context)` 函数被调用时，`context` 包含以下信息：

```javascript
context = {
  // 施法棋子（当前使用技能的棋子）
  piece: {
    instanceId: "piece-unique-id",     // 棋子实例唯一ID（用于 addRuleById、addStatusEffectById 等函数）
    templateId: "warrior",             // 棋子模板ID
    name: "战士",                      // 棋子显示名称
    ownerPlayerId: "player1",          // 所属玩家ID
    currentHp: 25,                     // 当前生命值
    maxHp: 30,                         // 最大生命值
    attack: 8,                         // 攻击力
    defense: 3,                        // 防御力
    x: 2,                              // X坐标
    y: 4,                              // Y坐标
    moveRange: 3,                      // 移动范围
    statusTags: [...]                  // 当前持有的状态标签数组（见状态系统章节）
  },

  // 目标棋子（仅在特定触发事件中存在，主动技能中为 null）
  // 存在于：afterDamageDealt、afterDamageTaken、onPieceDied、afterPieceKilled 等
  target: {
    instanceId: "...",
    name: "...",
    ownerPlayerId: "...",
    currentHp: 10,
    maxHp: 20,
    attack: 5,
    defense: 2,
    x: 3,
    y: 4
  } | null,

  // 目标格子（主动技能中调用 selectTarget({type:'grid'}) 并选择后才有值）
  targetPosition: { x: 3, y: 5 } | null,

  // 用户通过 selectOption() 选择的值
  // 第一次调用时为 undefined，选择后为对应的 value
  selectedOption: any | undefined,

  // 触发事件中的额外数据（因触发类型不同而不同）
  damage: number,       // 伤害值（afterDamageDealt/afterDamageTaken 中）
  heal: number,         // 治疗值（afterHealDealt/afterHealTaken 中）
  statusId: string,     // 状态ID（afterStatusApplied/afterStatusRemoved 中）

  // 当前战斗状态（完整引用，包含 pieces 数组等所有信息）
  battle: {
    turn: { turnNumber: 3, currentPlayerId: "player1", phase: "action" },
    pieces: [...],                     // 所有棋子数组，可直接访问和修改
    actions: [...],                    // 战斗日志
    // ... 其他战斗状态字段
  },

  // 正在使用的技能信息
  skill: {
    id: "flame-strike",
    name: "烈焰打击",
    type: "normal",
    powerMultiplier: 1.5
  }
}
```

### 重要说明

- **`context.piece` 是 `battle.pieces` 中的实际引用**。修改 `context.piece.x`、`context.piece.attack` 等属性会立即反映到战斗状态中。
- **`sourcePiece` 变量与 `context.piece` 指向同一个棋子实例**，两者可互换使用。
- `context.target` 在主动技能中始终为 `null`。需要目标时，使用 `selectTarget()` 函数获取。
- `context.targetPosition` 在主动技能中始终为 `null`。需要格子位置时，使用 `selectTarget({type: 'grid', ...})` 获取。
- **禁止**在主动技能中直接使用 `context.target` 或 `context.targetPosition`。
- **`context.battle` 是完整的战斗状态引用**，包含 `pieces` 数组、`turn` 对象等所有信息。可以通过 `context.battle.pieces` 访问所有棋子。

---

## 可用函数完整参考

在技能的 `code` 字段中，可以使用以下所有函数，无需 `import`，系统自动注入。

### 伤害与治疗

#### `dealDamage(attacker, target, baseDamage, damageType, battle, skillId)`

对目标造成伤害。自动处理防御力减免、触发器、护盾、击杀奖励。

```javascript
const result = dealDamage(
  sourcePiece,          // 攻击者棋子实例（来自 battle.pieces，或 selectTarget 返回值）
  target,               // 目标棋子实例（同上）
  20,                   // 基础伤害值（数字）
  'physical',           // 伤害类型：'physical'（受防御减免）/ 'magical'（受防御减免）/ 'true'（无视防御）
  context.battle,       // 当前战斗状态（完整引用，固定传 context.battle）
  context.skill.id      // 技能ID（用于日志，传 context.skill.id 即可）
)

// result 的结构：
// result.success  - 是否成功
// result.damage   - 实际造成的伤害值（扣除防御后）
// result.isKilled - 是否击杀了目标
// result.targetHp - 目标剩余HP
// result.message  - 日志消息
```

#### `healDamage(healer, target, baseHeal, battle, skillId)`

对目标进行治疗。自动处理禁疗状态、触发器。

```javascript
const result = healDamage(
  sourcePiece,          // 治疗者棋子
  target,               // 被治疗棋子
  10,                   // 基础治疗量
  context.battle,
  context.skill.id
)

// result.success / result.heal / result.targetHp / result.message
```

### 目标获取

#### `selectTarget(options)`

弹出目标选择 UI，让玩家点击棋子或格子。详见 [目标选择器](#目标选择器selecttarget)。

#### `selectOption(config)`

弹出选项列表 UI，让玩家选择一个选项。详见 [选项选择器](#选项选择器selectoption)。

#### `getAllEnemiesInRange(range)`

获取施法者一定范围内的所有存活敌方棋子数组。

```javascript
const enemies = getAllEnemiesInRange(3) // 3格内所有敌人
enemies.forEach(enemy => {
  dealDamage(sourcePiece, enemy, 10, 'magical', context.battle, context.skill.id)
})
```

#### `getAllAlliesInRange(range)`

获取施法者一定范围内的所有存活友方棋子数组（不含自身）。

```javascript
const allies = getAllAlliesInRange(5) // 5格内所有友军
```

#### `calculateDistance(a, b)`

计算两个棋子之间的曼哈顿距离。

```javascript
const dist = calculateDistance(context.piece, target) // 返回数字
```

#### `isTargetInRange(target, range)`

判断目标是否在施法者的攻击范围内。

```javascript
if (!isTargetInRange(target, 5)) {
  return { success: false, message: '目标超出范围' }
}
```

### 状态管理

#### `addStatusEffectById(targetPieceId, statusObject)`

为棋子添加状态标签（在 `statusTags` 中显示）。

```javascript
addStatusEffectById(target.instanceId, {
  id: 'bleeding',            // 状态的显示ID（用于 removeStatusEffectById）
  type: 'bleeding',          // 状态类型（用于代码中检查）
  currentDuration: 3,        // 持续回合数，-1 = 永久
  currentUses: -1,           // 最大触发次数，-1 = 无限
  intensity: 5,              // 状态强度（可在触发时读取）
  stacks: 1,                 // 叠加层数
  relatedRules: ['rule-bleeding-tick']  // 关联的规则ID数组（重要：用于API传输后恢复规则）
})
```

> **重要**：如果状态需要配合规则（被动技能）工作，必须在 `relatedRules` 字段中声明关联的规则ID。这样在API传输后，`restorePieceRules` 函数可以根据状态标签自动重新加载规则。

#### `removeStatusEffectById(targetPieceId, statusId)`

移除棋子的指定状态标签。

```javascript
removeStatusEffectById(target.instanceId, 'bleeding')
```

### 规则管理

#### `addRuleById(targetPieceId, ruleId)`

为棋子绑定一个规则（被动触发器）。通常在施加状态时同时绑定对应规则。

```javascript
addRuleById(target.instanceId, 'rule-bleeding-tick')
```

#### `removeRuleById(targetPieceId, ruleId)`

从棋子移除一个规则。通常在状态消失时同时移除。

```javascript
removeRuleById(target.instanceId, 'rule-bleeding-tick')
```

### 技能管理

#### `addSkillById(targetPieceId, skillId)`

在运行时为棋子添加一个技能。

#### `removeSkillById(targetPieceId, skillId)`

从棋子移除一个技能。

### 工具

- `Math` — 标准 JavaScript Math 对象（`Math.floor`, `Math.abs`, `Math.max`, `Math.min`, `Math.round`...）
- `console` — 用于调试（`console.log`, `console.error`）

### `sourcePiece` 变量

在技能代码中，除了 `context.piece`，还有一个 `sourcePiece` 变量可用。**两者都指向 `battle.pieces` 中的同一个实际棋子实例**，修改任意一个都会立即反映到战斗状态中。

```javascript
// 这三种写法等价，都会立即修改棋子的位置
sourcePiece.x = 5
context.piece.x = 5
// 或者通过 battle.pieces 查找后修改
const piece = context.battle.pieces.find(p => p.instanceId === context.piece.instanceId);
piece.x = 5
```

**推荐使用 `sourcePiece`**，因为它更简洁，且明确表示这是技能的施法者。

---

## 主动技能编写指南

主动技能（`kind: "active"`）由玩家点击按钮释放。

### 标准结构模板

```javascript
function executeSkill(context) {
  // 1. 获取施法者
  const caster = context.piece  // 或者用 sourcePiece

  // 2. 如果需要目标，使用 selectTarget（必须立即检查返回值）
  const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' })
  if (!target || target.needsTargetSelection) return target

  // 3. 如果需要玩家选择，使用 selectOption（必须立即检查返回值）
  // const mode = selectOption({ title: '选择', options: [{label:'A', value:'a'}] })
  // if (!mode || mode.needsOptionSelection) return mode

  // 4. 执行效果
  const dmg = caster.attack * context.skill.powerMultiplier
  const result = dealDamage(caster, target, dmg, 'physical', context.battle, context.skill.id)

  // 5. 返回结果（必须包含 success 和 message）
  return {
    success: true,
    message: caster.name + '对' + target.name + '造成了' + result.damage + '点伤害'
  }
}
```

### 必须返回的对象

`executeSkill` 函数**必须**返回一个包含以下字段的对象：

```javascript
return {
  success: true,     // boolean，技能是否成功执行
  message: '...'     // string，显示在战斗日志中的描述
}
```

如果返回 `{ success: false, message: '...' }`，技能不消耗行动点和冷却（视为未执行）。

### 示例：基础攻击技能

```json
{
  "id": "basic-attack",
  "name": "基础攻击",
  "description": "对1格内的敌人造成100%攻击力的物理伤害",
  "icon": "⚔️",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 1,
  "code": "function executeSkill(context) { const caster = context.piece; const target = selectTarget({ type: 'piece', range: 1, filter: 'enemy' }); if (!target || target.needsTargetSelection) return target; const dmg = Math.round(caster.attack * context.skill.powerMultiplier); const result = dealDamage(caster, target, dmg, 'physical', context.battle, context.skill.id); return { success: true, message: caster.name + '攻击了' + target.name + '，造成' + result.damage + '点物理伤害' }; }",
  "previewCode": "function calculatePreview(piece, skillDef) { return { description: '对1格内的敌人造成' + Math.round(piece.attack * skillDef.powerMultiplier) + '点物理伤害', expectedValues: { damage: Math.round(piece.attack * skillDef.powerMultiplier) } }; }"
}
```

### 示例：范围伤害技能

```json
{
  "id": "aoe-strike",
  "name": "烈焰爆发",
  "description": "对3格内所有敌人造成150%攻击力的魔法伤害",
  "icon": "🔥",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 3,
  "maxCharges": 0,
  "powerMultiplier": 1.5,
  "actionPointCost": 2,
  "code": "function executeSkill(context) { const caster = context.piece; const enemies = getAllEnemiesInRange(3); if (enemies.length === 0) { return { success: false, message: '范围内没有敌人' }; } const dmg = Math.round(caster.attack * context.skill.powerMultiplier); let totalDmg = 0; enemies.forEach(function(enemy) { const r = dealDamage(caster, enemy, dmg, 'magical', context.battle, context.skill.id); totalDmg += r.damage; }); return { success: true, message: caster.name + '释放烈焰爆发，对' + enemies.length + '个敌人共造成' + totalDmg + '点伤害' }; }"
}
```

### 示例：自身增益技能

```json
{
  "id": "power-up",
  "name": "力量强化",
  "description": "提升自身攻击力3点",
  "icon": "💪",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 4,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 1,
  "code": "function executeSkill(context) { sourcePiece.attack += 3; return { success: true, message: sourcePiece.name + '的攻击力提升至' + sourcePiece.attack + '点' }; }"
}
```

### 示例：治疗技能

```json
{
  "id": "holy-light",
  "name": "圣光术",
  "description": "为5格内友军回复10点生命值",
  "icon": "✨",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 2,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 2,
  "code": "function executeSkill(context) { const caster = context.piece; const target = selectTarget({ type: 'piece', range: 5, filter: 'ally' }); if (!target || target.needsTargetSelection) return target; const result = healDamage(caster, target, 10, context.battle, context.skill.id); return { success: true, message: caster.name + '为' + target.name + '回复了' + result.heal + '点生命值' }; }"
}
```

---

## 被动技能编写指南

被动技能需要三个部分配合：

```
角色初始化/施加状态时
    └── addRuleById(pieceId, 'rule-xxx')  ← 绑定规则到棋子
            │
            ▼
    规则文件（data/rules/rule-xxx.json）
    - 定义触发时机（trigger.type）
    - 调用技能（effect.skillId）
            │
            ▼
    技能文件（data/skills/xxx.json，kind: "passive"）
    - 在 code 里检查条件并执行效果
```

### 被动技能的规则文件格式

```json
{
  "id": "rule-counter-attack",
  "name": "反击规则",
  "description": "受到伤害时触发反击",
  "trigger": {
    "type": "afterDamageTaken"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "counter-attack",
    "message": ""
  }
}
```

> **规则文件只定义触发时机（trigger.type）**，不写任何条件逻辑。所有条件在技能代码里判断。

### 被动技能的技能文件格式

```json
{
  "id": "counter-attack",
  "name": "反击",
  "description": "受到伤害时自动反击",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { ... }"
}
```

### 如何为角色绑定内置被动技能

**方案A：在角色初始化的主动技能中绑定（推荐）**

创建一个 `kind: "active"` 的"初始化"技能，在角色装备后手动释放一次来注册规则。但更推荐的做法是：

**方案B：在角色的被动技能中通过 `beginTurn` 自动注册**

使用 `beginTurn` 触发器，在第一回合开始时检查并添加规则：

```json
// data/rules/rule-init-counter.json
{
  "id": "rule-init-counter",
  "trigger": { "type": "beginTurn" },
  "effect": { "type": "triggerSkill", "skillId": "init-counter", "message": "" }
}
```

```json
// data/skills/init-counter.json
{
  "id": "init-counter",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { const piece = context.piece; const alreadyHasRule = piece.rules && piece.rules.some(function(r) { return r.id === 'rule-counter-attack'; }); if (!alreadyHasRule) { addRuleById(piece.instanceId, 'rule-counter-attack'); } return { success: true, message: '' }; }"
}
```

**方案C：在角色文件中声明规则列表**

```json
// data/pieces/warrior.json 的 rules 字段
{
  "id": "warrior",
  "rules": ["rule-init-counter"]
}
```

### 示例：反击被动技能

创建"受到伤害时发动反击"效果。

**文件1：`data/rules/rule-counter-attack.json`**

```json
{
  "id": "rule-counter-attack",
  "name": "反击规则",
  "description": "受到伤害后触发反击",
  "trigger": { "type": "afterDamageTaken" },
  "effect": { "type": "triggerSkill", "skillId": "counter-attack", "message": "" }
}
```

**文件2：`data/skills/counter-attack.json`**

```json
{
  "id": "counter-attack",
  "name": "反击",
  "description": "受到伤害后对攻击者发动反击，造成100%攻击力的物理伤害",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 2,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { const defender = context.piece; const attacker = context.target; if (!attacker || attacker.currentHp <= 0) { return { success: false, message: '' }; } if (!context.damage || context.damage <= 0) { return { success: false, message: '' }; } const dmg = Math.round(defender.attack * context.skill.powerMultiplier); const result = dealDamage(defender, attacker, dmg, 'physical', context.battle, context.skill.id); return { success: true, message: defender.name + '发动反击，对' + attacker.name + '造成' + result.damage + '点伤害' }; }"
}
```

### 示例：每回合开始时触发的被动

**文件1：`data/rules/rule-regen.json`**

```json
{
  "id": "rule-regen",
  "name": "生命再生",
  "description": "每回合开始时回复HP",
  "trigger": { "type": "beginTurn" },
  "effect": { "type": "triggerSkill", "skillId": "regen-tick", "message": "" }
}
```

**文件2：`data/skills/regen-tick.json`**

```json
{
  "id": "regen-tick",
  "name": "生命再生",
  "description": "每回合回复3点生命值",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { const piece = context.piece; if (piece.currentHp >= piece.maxHp) { return { success: false, message: '' }; } const result = healDamage(piece, piece, 3, context.battle, context.skill.id); return { success: true, message: piece.name + '生命再生，回复了' + result.heal + '点生命值' }; }"
}
```

### 示例：敌人释放技能前触发（脉冲手枪）

创建"敌人释放技能前触发反击"效果。注意：`beforeSkillUse` 是**全场扫描**的，需要在技能代码里判断是否是正确的敌人。

**文件1：`data/rules/rule-pulse-pistol.json`**

```json
{
  "id": "rule-pulse-pistol",
  "name": "脉冲手枪规则",
  "description": "敌人释放技能前，对范围内随机敌人造成伤害",
  "trigger": { "type": "beforeSkillUse" },
  "effect": { "type": "triggerSkill", "skillId": "pulse-pistol", "message": "" }
}
```

**文件2：`data/skills/pulse-pistol.json`**

```json
{
  "id": "pulse-pistol",
  "name": "脉冲手枪",
  "description": "敌人释放技能时，对5×5范围内随机一个敌人造成等同于自身攻击力的伤害",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { const caster = context.piece; const enemy = context.sourcePiece; if (!enemy) { return { success: false, message: '' }; } if (enemy.ownerPlayerId === caster.ownerPlayerId) { return { success: false, message: '' }; } const dx = Math.abs(enemy.x - caster.x); const dy = Math.abs(enemy.y - caster.y); if (Math.max(dx, dy) > 2) { return { success: false, message: '' }; } const enemies = context.battle.pieces.filter(function(p) { return p.ownerPlayerId !== caster.ownerPlayerId && p.currentHp > 0 && Math.abs(p.x - caster.x) <= 2 && Math.abs(p.y - caster.y) <= 2; }); if (enemies.length === 0) { return { success: false, message: '' }; } const target = enemies[Math.floor(Math.random() * enemies.length)]; const result = dealDamage(caster, target, caster.attack, 'physical', context.battle, context.skill.id); return { success: true, message: caster.name + '的脉冲手枪触发，对' + target.name + '造成' + result.damage + '点伤害' }; }"
}
```

**要点说明**：
- 使用 `beforeSkillUse` 触发器，在敌人释放技能**前**触发
- 通过 `context.sourcePiece` 获取释放技能的敌人
- 需要在代码里判断敌人是否是敌方（`enemy.ownerPlayerId !== caster.ownerPlayerId`）
- 需要判断敌人在5×5范围内（Chebyshev距离 ≤ 2）
- 返回 `blocked: true` 可以阻止敌人释放技能
```

---

## 目标选择器（selectTarget）

`selectTarget` 函数暂停技能执行，让玩家在棋盘上选择一个目标，然后返回目标信息继续执行。

### 函数签名

```javascript
selectTarget(options?: {
  type: 'piece' | 'grid',    // 'piece'=选棋子，'grid'=选格子
  range?: number,            // 选择范围（默认5）
  filter?: 'enemy' | 'ally' | 'all'  // 棋子过滤（默认'enemy'）
})
```

### 返回值

- **未选择时**：返回 `{ needsTargetSelection: true, ... }`，技能暂停
- **选择棋子后**：返回棋子实例（`PieceInstance`），有 `instanceId`、`currentHp`、`attack` 等字段
- **选择格子后**：返回格子坐标 `{ x: number, y: number }`

### 使用规则（必读）

调用后**必须立即**检查返回值：

```javascript
const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' })
if (!target || target.needsTargetSelection) return target
// ✅ 以下代码才能安全使用 target
```

### 示例：选择棋子目标

```javascript
function executeSkill(context) {
  const caster = context.piece
  const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' })
  if (!target || target.needsTargetSelection) return target

  const dmg = Math.round(caster.attack * context.skill.powerMultiplier)
  const result = dealDamage(caster, target, dmg, 'magical', context.battle, context.skill.id)
  return { success: true, message: caster.name + '攻击了' + target.name + '，造成' + result.damage + '点魔法伤害' }
}
```

### 示例：选择格子目标（传送）

```javascript
function executeSkill(context) {
  const pos = selectTarget({ type: 'grid', range: 6, filter: 'all' })
  if (!pos || pos.needsTargetSelection) return pos

  // 检查目标格子是否已有棋子
  const pieceAtPos = context.battle.pieces.find(p => 
    p.x === pos.x && p.y === pos.y && p.currentHp > 0
  )
  if (pieceAtPos) {
    return { success: false, message: '该位置已有棋子' }
  }

  // 使用 sourcePiece 修改位置（与 context.piece 等价）
  sourcePiece.x = pos.x
  sourcePiece.y = pos.y
  return { success: true, message: sourcePiece.name + '传送到了(' + pos.x + ',' + pos.y + ')' }
}
```

### 示例：选择友方目标

```javascript
function executeSkill(context) {
  const caster = context.piece
  const ally = selectTarget({ type: 'piece', range: 7, filter: 'ally' })
  if (!ally || ally.needsTargetSelection) return ally

  const result = healDamage(caster, ally, 15, context.battle, context.skill.id)
  return { success: true, message: caster.name + '治疗了' + ally.name + '，回复' + result.heal + '点生命值' }
}
```

---

## 选项选择器（selectOption）

`selectOption` 函数在战斗操作框弹出若干选项，玩家选择后继续执行技能。内置"取消释放"按钮。

### 函数签名

```javascript
selectOption(config: {
  title?: string,                      // 弹窗标题，默认"请选择"
  options: Array<{
    label: string,                     // 选项显示名称（必填）
    value: any,                        // 选中后返回的值（必填，推荐用字符串）
    description?: string               // 选项旁的补充说明（可选）
  }>
})
```

### 返回值

- **未选择时**：返回 `{ needsOptionSelection: true, ... }`
- **选择后**：直接返回选中的 `value` 值
- **取消时**：技能完全取消，不消耗行动点和冷却

### 使用规则（必读）

```javascript
const chosen = selectOption({ title: '...', options: [...] })
if (!chosen || chosen.needsOptionSelection) return chosen
// ✅ 以下代码才能安全使用 chosen
```

### 示例：双模式攻击

```javascript
function executeSkill(context) {
  const caster = context.piece

  const mode = selectOption({
    title: '选择攻击模式',
    options: [
      { label: '单体重击', value: 'single', description: '对单体造成200%攻击力伤害' },
      { label: '群体打击', value: 'aoe',    description: '对3格内所有敌人造成80%攻击力伤害' }
    ]
  })
  if (!mode || mode.needsOptionSelection) return mode

  if (mode === 'single') {
    const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' })
    if (!target || target.needsTargetSelection) return target
    const dmg = Math.round(caster.attack * 2)
    const result = dealDamage(caster, target, dmg, 'physical', context.battle, context.skill.id)
    return { success: true, message: caster.name + '使用单体重击，造成' + result.damage + '点伤害' }
  }

  if (mode === 'aoe') {
    const enemies = getAllEnemiesInRange(3)
    const dmg = Math.round(caster.attack * 0.8)
    enemies.forEach(function(e) { dealDamage(caster, e, dmg, 'physical', context.battle, context.skill.id) })
    return { success: true, message: caster.name + '使用群体打击，攻击了' + enemies.length + '个目标' }
  }

  return { success: false, message: '未知选项' }
}
```

### 示例：范围伤害+传送（毁天灭地）

```javascript
function executeSkill(context) {
  // 选择降落位置
  const targetPos = selectTarget({ type: 'grid', range: 10, filter: 'all' })
  if (!targetPos || targetPos.needsTargetSelection) return targetPos

  // 检查目标位置是否已有棋子
  const pieceAtPos = context.battle.pieces.find(p => 
    p.x === targetPos.x && p.y === targetPos.y && p.currentHp > 0
  )
  if (pieceAtPos) {
    return { message: '该位置已有棋子', success: false }
  }

  // 传送到目标位置
  sourcePiece.x = targetPos.x
  sourcePiece.y = targetPos.y

  // 对3x3范围内的敌人造成伤害
  const damageValue = sourcePiece.attack * context.skill.powerMultiplier
  const affectedEnemies = []
  let totalDamage = 0

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const checkPos = { x: targetPos.x + dx, y: targetPos.y + dy }
      const enemyAtPos = context.battle.pieces.find(p => 
        p.x === checkPos.x && 
        p.y === checkPos.y && 
        p.currentHp > 0 && 
        p.ownerPlayerId !== sourcePiece.ownerPlayerId
      )
      if (enemyAtPos) {
        affectedEnemies.push(enemyAtPos.name)
        const damageResult = dealDamage(
          sourcePiece, 
          enemyAtPos, 
          damageValue, 
          'physical', 
          context.battle, 
          context.skill.id
        )
        totalDamage += damageResult.damage
      }
    }
  }

  if (affectedEnemies.length > 0) {
    return { 
      message: sourcePiece.name + ' 从天而降，对 ' + affectedEnemies.join(', ') + ' 造成 ' + totalDamage + ' 点伤害', 
      success: true 
    }
  }
  return { message: sourcePiece.name + ' 从天而降', success: true }
}
```

---

## 状态系统

状态是附加在棋子上的标签，用于显示持续效果（如流血、冻结、增益等）。

### 状态由两部分组成

1. **状态标签**（StatusTag）：`piece.statusTags[]` 数组里的对象，控制 UI 显示和持续逻辑
2. **触发逻辑**：通过"规则+技能"系统实现状态的实际效果

### addStatusEffectById 参数详解

```javascript
addStatusEffectById(targetPieceId, {
  id: 'bleeding',         // 显示用ID，也是 removeStatusEffectById 的参数
  type: 'bleeding',       // 状态类型（用于在 statusTags 中查找：tag.type === 'bleeding'）
  currentDuration: 3,     // 持续回合数（-1 = 永久）
  currentUses: -1,        // 最大触发次数（-1 = 无限次）
  intensity: 5,           // 强度值（可在触发技能中读取：tag.intensity）
  stacks: 1,              // 叠加层数（可在触发技能中读取：tag.stacks）
  relatedRules: ['rule-bleeding-tick']  // 关联的规则ID数组（重要：用于API传输后恢复规则）
})
```

> **重要规范**：如果状态需要配合规则（被动技能）工作，必须在 `relatedRules` 字段中声明关联的规则ID。这样在API传输后，`restorePieceRules` 函数可以根据状态标签自动重新加载规则，无需硬编码映射。

### 读取棋子的状态

```javascript
// 检查棋子是否有某种状态
const isFrozen = piece.statusTags && piece.statusTags.some(function(tag) { return tag.type === 'freeze' })

// 读取状态的强度值
const bleedTag = piece.statusTags && piece.statusTags.find(function(tag) { return tag.type === 'bleeding' })
if (bleedTag) {
  const dmgPerTick = bleedTag.intensity * (bleedTag.stacks || 1)
}
```

### 完整示例：流血状态

**步骤1：施加流血的技能**

```json
{
  "id": "slash",
  "name": "划伤",
  "description": "对目标造成伤害并施加流血，每回合受到5点真实伤害，持续3回合",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 2,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 1,
  "code": "function executeSkill(context) { const caster = context.piece; const target = selectTarget({ type: 'piece', range: 4, filter: 'enemy' }); if (!target || target.needsTargetSelection) return target; const dmg = Math.round(caster.attack * context.skill.powerMultiplier); const result = dealDamage(caster, target, dmg, 'physical', context.battle, context.skill.id); if (result.success) { addStatusEffectById(target.instanceId, { id: 'bleeding', type: 'bleeding', currentDuration: 3, currentUses: 3, intensity: 5, stacks: 1, relatedRules: ['rule-bleeding-tick'] }); addRuleById(target.instanceId, 'rule-bleeding-tick'); } return { success: true, message: caster.name + '划伤了' + target.name + '，造成' + result.damage + '点伤害并使其流血' }; }"
}
```

**步骤2：流血每回合触发的规则**

```json
{
  "id": "rule-bleeding-tick",
  "name": "流血触发",
  "description": "每回合开始时触发流血伤害",
  "trigger": { "type": "beginTurn" },
  "effect": { "type": "triggerSkill", "skillId": "bleeding-tick", "message": "" }
}
```

**步骤3：流血效果技能**

```json
{
  "id": "bleeding-tick",
  "name": "流血伤害",
  "description": "流血持续伤害效果",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { const piece = context.piece; const bleedTag = piece.statusTags && piece.statusTags.find(function(tag) { return tag.type === 'bleeding'; }); if (!bleedTag) { removeRuleById(piece.instanceId, 'rule-bleeding-tick'); return { success: false, message: '' }; } const dmg = (bleedTag.intensity || 5) * (bleedTag.stacks || 1); dealDamage(piece, piece, dmg, 'true', context.battle, context.skill.id); bleedTag.currentDuration = (bleedTag.currentDuration || 0) - 1; if (bleedTag.currentDuration <= 0) { removeStatusEffectById(piece.instanceId, 'bleeding'); removeRuleById(piece.instanceId, 'rule-bleeding-tick'); } return { success: true, message: piece.name + '受到流血伤害，失去' + dmg + '点生命值' }; }"
}
```

### 暴风雪完整示例（使用 relatedRules 的最佳实践）

暴风雪是一个复杂的区域控制技能，展示了如何使用 `relatedRules` 来关联状态和规则。

**技能效果**：选择全局任意格子，创造3×3暴风雪区域，对方回合结束时对区域内敌人造成伤害和冰冻。

**文件1：`data/skills/blizzard.json`（主动技能）**

```json
{
  "id": "blizzard",
  "name": "暴风雪",
  "description": "选择全局任意一个格子，以该格子为中心创造3*3格的暴风雪区域，对方的回合结束时对其中所有敌人造成当前攻击力1.5倍的伤害和1回合冰冻",
  "icon": "🌪️",
  "kind": "active",
  "type": "super",
  "cooldownTurns": 3,
  "maxCharges": 3,
  "chargeCost": 2,
  "powerMultiplier": 1.5,
  "actionPointCost": 2,
  "range": "area",
  "areaSize": 3,
  "code": "function executeSkill(context) { const sourcePiece = context.piece; const damageValue = sourcePiece.attack * context.skill.powerMultiplier; const targetPosition = selectTarget({ type: 'grid', range: 10, filter: 'all' }); if (!targetPosition || targetPosition.needsTargetSelection) { return targetPosition; } if (typeof addStatusEffectById === 'function') { const statusId = 'blizzard-' + Date.now(); addStatusEffectById(sourcePiece.instanceId, { id: statusId, type: 'blizzard', currentDuration: 2, intensity: 1, value: targetPosition.x, extraValue: targetPosition.y, damage: damageValue, relatedRules: ['rule-blizzard-active'] }); } if (typeof addRuleById === 'function') { addRuleById(sourcePiece.instanceId, 'rule-blizzard-active'); } if (typeof addSkillById === 'function') { addSkillById(sourcePiece.instanceId, 'blizzard-damage'); } return { message: sourcePiece.name + '使用了暴风雪，在(' + targetPosition.x + ',' + targetPosition.y + ')创造了暴风雪区域，将在对方回合结束时对3x3格范围内的敌人造成' + damageValue + '点伤害并使其冰冻', success: true }; }",
  "previewCode": "function calculatePreview(piece, skillDef) { const damageValue = Math.round(piece.attack * skillDef.powerMultiplier); return { description: '选择全局任意位置，创造3*3格的暴风雪区域，对方回合结束时对其中所有敌人造成' + damageValue + '点伤害（相当于攻击力150%）和1回合冰冻', expectedValues: { damage: damageValue } }; }"
}
```

**要点说明**：
- `currentDuration: 2` - 持续2回合（在对方回合结束时触发后还剩1回合）
- `value` 和 `extraValue` - 存储暴风雪中心坐标
- `damage` - 存储计算好的伤害值
- **`relatedRules: ['rule-blizzard-active']`** - 关键！声明此状态关联的规则，API传输后可自动恢复

**文件2：`data/rules/rule-blizzard-active.json`（触发规则）**

```json
{
  "id": "rule-blizzard-active",
  "name": "暴风雪激活",
  "description": "在对方回合结束时，触发暴风雪效果对区域内敌人造成伤害和冰冻",
  "trigger": {
    "type": "endTurn"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "blizzard-damage",
    "message": "暴风雪效果触发"
  }
}
```

**文件3：`data/skills/blizzard-damage.json`（被动效果技能）**

```json
{
  "id": "blizzard-damage",
  "name": "暴风雪伤害",
  "description": "对暴风雪区域内的所有敌人造成伤害和冰冻",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { const sourcePiece = context.piece; if (!sourcePiece.statusTags || sourcePiece.statusTags.length === 0) { return { message: '没有状态标签', success: false }; } const blizzardStatus = sourcePiece.statusTags.find(effect => effect.type === 'blizzard'); if (!blizzardStatus) { return { message: '没有暴风雪状态', success: false }; } const centerX = blizzardStatus.value; const centerY = blizzardStatus.extraValue; const damageValue = blizzardStatus.damage; if (centerX === undefined || centerY === undefined || damageValue === undefined) { return { message: '暴风雪状态数据不完整', success: false }; } if (context.playerId === sourcePiece.ownerPlayerId) { return { message: '暴风雪只在对方回合结束时触发', success: false }; } const radius = 1; let totalDamage = 0; let totalEnemies = 0; let enemyNames = []; const enemiesInArea = context.battle.pieces.filter(piece => { if (piece.ownerPlayerId === sourcePiece.ownerPlayerId) return false; if (piece.currentHp <= 0) return false; const distanceX = Math.abs(piece.x - centerX); const distanceY = Math.abs(piece.y - centerY); return distanceX <= radius && distanceY <= radius; }); enemiesInArea.forEach(enemy => { const damageResult = dealDamage(sourcePiece, enemy, damageValue, 'magical', context.battle, 'blizzard'); if (damageResult.success) { if (typeof addStatusEffectById === 'function') { const statusId = 'freeze-' + Date.now() + '-' + enemy.instanceId; addStatusEffectById(enemy.instanceId, { id: statusId, type: 'freeze', currentDuration: 1, intensity: 1, relatedRules: ['rule-freeze-prevent-move', 'rule-freeze-prevent-skill'] }); } if (typeof addRuleById === 'function') { addRuleById(enemy.instanceId, 'rule-freeze-prevent-move'); addRuleById(enemy.instanceId, 'rule-freeze-prevent-skill'); } if (typeof addSkillById === 'function') { addSkillById(enemy.instanceId, 'freeze-prevent'); } enemy.showFreezeEffect = true; totalDamage += damageResult.damage; totalEnemies++; enemyNames.push(enemy.name); } }); if (!context.battle.effects) { context.battle.effects = []; } for (let x = centerX - radius; x <= centerX + radius; x++) { for (let y = centerY - radius; y <= centerY + radius; y++) { context.battle.effects.push({ type: 'blizzard', position: { x, y }, duration: 1, zIndex: 999, showOnUI: true }); } } if (typeof removeStatusEffectById === 'function') { removeStatusEffectById(sourcePiece.instanceId, blizzardStatus.id); } if (typeof removeRuleById === 'function') { removeRuleById(sourcePiece.instanceId, 'rule-blizzard-active'); } if (typeof removeSkillById === 'function') { removeSkillById(sourcePiece.instanceId, 'blizzard-damage'); } let message = sourcePiece.name + '的暴风雪效果'; message += '（中心坐标：(' + centerX + ',' + centerY + ')）'; if (totalEnemies > 0) { message += '对' + enemyNames.join('、') + '造成了' + totalDamage + '点伤害并使其冰冻'; } else { message += '没有对任何敌人造成伤害'; } return { message: message, success: true, showUIEffects: true }; }",
  "showInUI": false
}
```

**要点说明**：
- 检查 `context.playerId !== sourcePiece.ownerPlayerId` 确保只在对方回合触发
- 从 `statusTags` 中读取暴风雪状态的中心坐标和伤害值
- 对3×3范围内的敌人造成伤害并施加冰冻状态
- 触发后清理自身的状态、规则和技能

---

### 圣盾完整示例

**步骤1：施加圣盾的技能**

```json
{
  "id": "divine-shield-cast",
  "name": "圣盾",
  "description": "为友军施加圣盾，抵挡一次伤害",
  "icon": "🛡️",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 3,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 2,
  "code": "function executeSkill(context) { const caster = context.piece; const target = selectTarget({ type: 'piece', range: 7, filter: 'ally' }); if (!target || target.needsTargetSelection) return target; addStatusEffectById(target.instanceId, { id: 'divine-shield', type: 'divine-shield', currentDuration: -1, currentUses: 1, intensity: 1, stacks: 1, relatedRules: ['rule-divine-shield'] }); addRuleById(target.instanceId, 'rule-divine-shield'); return { success: true, message: caster.name + '为' + target.name + '施加了圣盾' }; }"
}
```

**步骤2：圣盾触发规则**

```json
{
  "id": "rule-divine-shield",
  "name": "圣盾效果",
  "description": "受到伤害时触发圣盾",
  "trigger": { "type": "beforeDamageTaken" },
  "effect": { "type": "triggerSkill", "skillId": "divine-shield-block", "message": "" }
}
```

**步骤3：圣盾防御技能**

```json
{
  "id": "divine-shield-block",
  "name": "圣盾抵挡",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { const piece = context.piece; const hasShield = piece.statusTags && piece.statusTags.some(function(tag) { return tag.type === 'divine-shield'; }); if (!hasShield) { removeRuleById(piece.instanceId, 'rule-divine-shield'); return { success: true, blocked: false, message: '' }; } if (!context.damage || context.damage <= 0) { return { success: true, blocked: false, message: '' }; } removeStatusEffectById(piece.instanceId, 'divine-shield'); removeRuleById(piece.instanceId, 'rule-divine-shield'); const attackerName = context.target ? context.target.name : '未知'; return { success: true, blocked: true, message: piece.name + '的圣盾破裂，抵挡了来自' + attackerName + '的伤害' }; }"
}
```

---

## 阻止行动（blocked）

通过在技能返回值中加入 `blocked: true`，可以阻止当前触发的行动（如移动、受伤）。

### 使用场景

| 在哪个触发类型的技能中使用 | 阻止的行动 |
|--------------------------|-----------|
| `beforeMove` | 移动行动 |
| `beforeSkillUse` | 技能使用 |
| `beforeDamageDealt` | 造成伤害 |
| `beforeDamageTaken` | 受到伤害（如圣盾）|
| `beforeHealDealt` | 造成治疗 |
| `beforeHealTaken` | 受到治疗（如禁疗）|

### 返回格式

```javascript
// 阻止行动
return { success: true, blocked: true, message: '行动被阻止了' }

// 不阻止行动（允许通过）
return { success: true, blocked: false, message: '' }
```

### 示例：冰冻阻止移动

**文件1：`data/rules/rule-freeze-block-move.json`**

```json
{
  "id": "rule-freeze-block-move",
  "trigger": { "type": "beforeMove" },
  "effect": { "type": "triggerSkill", "skillId": "freeze-check-move", "message": "" }
}
```

**文件2：`data/skills/freeze-check-move.json`**

```json
{
  "id": "freeze-check-move",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { const piece = context.piece; const isFrozen = piece.statusTags && piece.statusTags.some(function(tag) { return tag.type === 'freeze'; }); if (isFrozen) { return { success: true, blocked: true, message: piece.name + '被冰冻，无法移动' }; } return { success: true, blocked: false, message: '' }; }"
}
```

---

## 触发类型完整参考

> **重要：全场扫描机制**
>
> 每次触发事件发生时，系统会遍历场上**所有棋子**的规则，而不只检查事件发起者的规则。
>
> 这意味着：
> - 棋子 A 移动后，棋子 B 身上的 `afterMove` 规则也会被检查
> - 棋子 A 释放技能后，棋子 C 身上的 `afterSkillUsed` 规则也会被检查
>
> 在规则代码中，通过 `context.sourcePiece`（或 `context.piece`）可以判断是谁触发了本次事件，从而决定是否生效：
> ```javascript
> // 示例：只在队友释放技能后才给自己回血
> if (context.sourcePiece.ownerPlayerId !== sourcePiece.ownerPlayerId) return { success: false }
> if (context.sourcePiece.instanceId === sourcePiece.instanceId) return { success: false } // 自己不触发
> healDamage(sourcePiece, sourcePiece, 3, context.battle, context.skillId)
> return { success: true, message: sourcePiece.name + '因队友施法获得回血' }
> ```

### 伤害类

| 触发类型                 | 触发时机     | context.piece | context.target | context.damage | 可 blocked |
| -------------------- | -------- | ------------- | -------------- | -------------- | --------- |
| `beforeDamageDealt`  | 即将造成伤害前  | 攻击者           | 被攻击者           | 伤害值            | ✅         |
| `afterDamageDealt`   | 造成伤害后    | 攻击者           | 被攻击者           | 实际伤害值          | ❌         |
| `beforeDamageTaken`  | 即将受到伤害前  | 被攻击者          | 攻击者            | 伤害值            | ✅         |
| `afterDamageTaken`   | 受到伤害后    | 被攻击者          | 攻击者            | 实际伤害值          | ❌         |
| `afterDamageBlocked` | 伤害被护盾抵挡后 | 被攻击者          | 攻击者            | 被抵挡的伤害值        | ❌         |

### 治疗类

| 触发类型 | context.piece | context.target | context.heal | 可 blocked |
|---------|--------------|---------------|-------------|-----------|
| `beforeHealDealt` | 治疗者 | 被治疗者 | 治疗量 | ✅ |
| `afterHealDealt` | 治疗者 | 被治疗者 | 实际治疗量 | ❌ |
| `beforeHealTaken` | 被治疗者 | 治疗者 | 治疗量 | ✅ |
| `afterHealTaken` | 被治疗者 | 治疗者 | 实际治疗量 | ❌ |
| `afterHealBlocked` | 被治疗者 | 治疗者 | 被阻止的治疗量 | ❌ |

### 棋子类

| 触发类型 | context.piece | context.target | 说明 |
|---------|--------------|---------------|------|
| `afterPieceKilled` | **击杀者** | 被击杀者 | 用于"我击杀时..."效果 |
| `onPieceDied` | **死亡棋子自身** | 击杀者（攻击者） | 用于"我死亡时..."效果 |
| `afterPieceSummoned` | 召唤者 | 被召唤者 | — |

### 技能类

| 触发类型 | context.piece | context.skillId | 可 blocked | 备注 |
|---------|--------------|----------------|-----------|------|
| `beforeSkillUse` | 即将使用技能的棋子 | 技能ID | ✅ | 全场扫描 |
| `afterSkillUsed` | 使用技能后的棋子 | 技能ID | ❌ | 全场扫描 |

### 移动类

| 触发类型 | context.piece | 可 blocked | 备注 |
|---------|--------------|-----------|------|
| `beforeMove` | 即将移动的棋子 | ✅ | 全场扫描 |
| `afterMove` | 已移动的棋子 | ❌ | 全场扫描 |

### 回合类

| 触发类型 | context.piece | 说明 |
|---------|--------------|------|
| `beginTurn` | 当前回合玩家的棋子 | 每个玩家回合开始时触发 |
| `endTurn` | 当前回合玩家的棋子 | 每个玩家回合结束时触发 |

### 状态与充能类

| 触发类型 | context.piece | 额外字段 |
|---------|--------------|---------|
| `afterStatusApplied` | 被施加状态的棋子 | `context.statusId`（状态ID） |
| `afterStatusRemoved` | 被移除状态的棋子 | `context.statusId`（状态ID） |
| `afterChargeGained` | 获得充能的棋子 | `context.amount`（获得量）, `context.playerId` |

### 通用

| 触发类型 | 说明 |
|---------|------|
| `whenever` | 每一步行动后检测，用于"每当...时..."的效果 |

---

## 禁止做法（反模式）

以下做法**会导致技能异常、触发器不触发、战斗日志丢失，或逻辑错误**，严禁使用。

### ❌ 直接修改 HP

```javascript
// 禁止！绕过了防御力、护盾、触发器
target.currentHp -= 20
context.piece.currentHp = 0

// 必须改为：
dealDamage(sourcePiece, target, 20, 'true', context.battle, context.skill.id)
```

### ❌ 在规则文件中写条件

```json
// 禁止！conditions 字段不被处理，逻辑无效
{
  "trigger": {
    "type": "afterDamageTaken",
    "conditions": [{ "field": "currentHp", "lt": 10 }]
  }
}

// 必须改为：在技能代码里用 if 判断
```

### ❌ 通过 JSON 字段传递效果

```json
// 禁止！以下字段不会产生任何游戏效果
{
  "damage": 10,
  "effect": "freeze",
  "buff": { "attack": 2 }
}

// 必须改为：在 code 字段里调用 dealDamage / addStatusEffectById 等函数
```

### ❌ 不检查 selectTarget / selectOption 的返回值

```javascript
// 禁止！target 在等待选择时是 { needsTargetSelection: true }，不是真正的棋子
const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' })
dealDamage(sourcePiece, target, 10, 'physical', context.battle, context.skill.id)  // 会崩溃！

// 必须改为：
const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' })
if (!target || target.needsTargetSelection) return target
dealDamage(sourcePiece, target, 10, 'physical', context.battle, context.skill.id)
```

### ❌ 在主动技能中使用 context.target

```javascript
// 禁止！主动技能的 context.target 始终为 null
function executeSkill(context) {
  const target = context.target  // null！
  dealDamage(context.piece, target, ...)  // 崩溃！
}

// 必须改为：使用 selectTarget
const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' })
```

### ❌ 使用 requiresTarget 属性

```json
// 禁止！此字段已废弃，不起任何作用
{ "requiresTarget": true }

// 必须改为：在 code 里调用 selectTarget()
```

### ❌ 被动技能不绑定规则

```javascript
// 错误：技能文件写了 kind: "passive"，但没有对应的规则文件
// → 技能永远不会触发

// 必须：创建规则文件，并用 addRuleById 绑定到棋子
```

### ❌ 忘记在状态消失时清理规则

```javascript
// 错误：移除状态后不清理规则，规则会继续触发产生无效调用
removeStatusEffectById(piece.instanceId, 'bleeding')
// 没有 removeRuleById！

// 必须：
removeStatusEffectById(piece.instanceId, 'bleeding')
removeRuleById(piece.instanceId, 'rule-bleeding-tick')
```

---

## 完整角色创建示例

以下是从零创建一个新角色"暗影刺客"的完整流程。该角色有三个技能：
- **普通攻击**：对1格内敌人造成物理伤害
- **暗影步**：传送到一个格子
- **嗜血**（被动）：击杀敌人时回复HP

### 第一步：创建角色文件

**文件：`data/pieces/shadow-assassin.json`**

```json
{
  "id": "shadow-assassin",
  "name": "暗影刺客",
  "faction": "neutral",
  "description": "擅长位移和击杀奖励的刺客",
  "rarity": "rare",
  "image": "🗡️",
  "stats": {
    "maxHp": 20,
    "attack": 10,
    "defense": 1,
    "moveRange": 4
  },
  "skills": [
    { "skillId": "assassin-basic-attack", "initialCharges": 0 },
    { "skillId": "shadow-step-simple", "initialCharges": 0 },
    { "skillId": "bloodthirst-passive", "initialCharges": 0 }
  ],
  "rules": ["rule-bloodthirst-init"]
}
```

> `rules` 字段里的规则会在角色创建时自动绑定到棋子，用于初始化被动技能。

### 第二步：创建普通攻击技能

**文件：`data/skills/assassin-basic-attack.json`**

```json
{
  "id": "assassin-basic-attack",
  "name": "刺击",
  "description": "对1格内的敌人造成120%攻击力的物理伤害",
  "icon": "🗡️",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1.2,
  "actionPointCost": 1,
  "code": "function executeSkill(context) { var caster = context.piece; var target = selectTarget({ type: 'piece', range: 1, filter: 'enemy' }); if (!target || target.needsTargetSelection) return target; var dmg = Math.round(caster.attack * context.skill.powerMultiplier); var result = dealDamage(caster, target, dmg, 'physical', context.battle, context.skill.id); return { success: true, message: caster.name + '刺击了' + target.name + '，造成' + result.damage + '点物理伤害' }; }",
  "previewCode": "function calculatePreview(piece, skillDef) { return { description: '对1格内敌人造成' + Math.round(piece.attack * skillDef.powerMultiplier) + '点物理伤害', expectedValues: { damage: Math.round(piece.attack * skillDef.powerMultiplier) } }; }"
}
```

### 第三步：创建暗影步技能（位移）

**文件：`data/skills/shadow-step-simple.json`**

```json
{
  "id": "shadow-step-simple",
  "name": "暗影步",
  "description": "传送到6格内任意空格",
  "icon": "👥",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 3,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 1,
  "code": "function executeSkill(context) { var caster = context.piece; var pos = selectTarget({ type: 'grid', range: 6, filter: 'all' }); if (!pos || pos.needsTargetSelection) return pos; caster.x = pos.x; caster.y = pos.y; return { success: true, message: caster.name + '使用暗影步，传送到了(' + pos.x + ',' + pos.y + ')' }; }"
}
```

### 第四步：创建嗜血被动技能

**文件1：`data/rules/rule-bloodthirst-init.json`**
（此规则在角色创建时触发，绑定嗜血的实际触发规则）

```json
{
  "id": "rule-bloodthirst-init",
  "name": "嗜血初始化",
  "description": "初始化嗜血被动",
  "trigger": { "type": "beginTurn" },
  "effect": { "type": "triggerSkill", "skillId": "bloodthirst-init", "message": "" }
}
```

**文件2：`data/skills/bloodthirst-init.json`**
（检测是否已注册嗜血规则，避免重复注册）

```json
{
  "id": "bloodthirst-init",
  "name": "嗜血初始化",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { var piece = context.piece; var hasRule = piece.rules && piece.rules.some(function(r) { return r.id === 'rule-bloodthirst'; }); if (!hasRule) { addRuleById(piece.instanceId, 'rule-bloodthirst'); } return { success: true, message: '' }; }"
}
```

**文件3：`data/rules/rule-bloodthirst.json`**
（击杀时触发的规则）

```json
{
  "id": "rule-bloodthirst",
  "name": "嗜血触发",
  "description": "击杀敌人时触发嗜血效果",
  "trigger": { "type": "afterPieceKilled" },
  "effect": { "type": "triggerSkill", "skillId": "bloodthirst-passive", "message": "" }
}
```

**文件4：`data/skills/bloodthirst-passive.json`**
（实际效果：回复HP）

```json
{
  "id": "bloodthirst-passive",
  "name": "嗜血",
  "description": "击杀敌人时回复5点生命值",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { var killer = context.piece; var victim = context.target; if (!victim) { return { success: false, message: '' }; } var result = healDamage(killer, killer, 5, context.battle, context.skill.id); return { success: true, message: killer.name + '击杀了' + victim.name + '，嗜血回复了' + result.heal + '点生命值' }; }"
}
```

### 总结：暗影刺客的文件清单

```
data/pieces/shadow-assassin.json          ← 角色定义
data/skills/assassin-basic-attack.json   ← 主动：刺击
data/skills/shadow-step-simple.json      ← 主动：暗影步
data/rules/rule-bloodthirst-init.json    ← 被动初始化规则
data/skills/bloodthirst-init.json        ← 被动初始化检查
data/rules/rule-bloodthirst.json         ← 嗜血触发规则
data/skills/bloodthirst-passive.json     ← 嗜血效果
```

---

## 故障排除

### 技能点击后没有任何效果

1. 检查技能 JSON 的 `code` 字段是否是有效的 JavaScript（注意 JSON 中用 `\"` 转义引号）
2. 检查 `executeSkill` 函数是否返回了 `{ success: true, message: '...' }` 对象
3. 打开浏览器控制台（F12），查看是否有 JavaScript 报错

### 被动技能从不触发

1. 检查对应的规则文件是否存在于 `data/rules/` 目录
2. 检查规则的 `effect.skillId` 与技能文件的 `id` 是否完全一致（区分大小写）
3. 检查棋子是否通过 `addRuleById` 绑定了该规则（查看游戏状态或日志）
4. 检查规则的 `trigger.type` 是否拼写正确（参见触发类型参考表）

### selectTarget 后报错

确保在 `selectTarget` 调用后立即检查：
```javascript
if (!target || target.needsTargetSelection) return target
```

### 伤害/治疗数值为0或NaN

- 确认传入 `dealDamage` 的伤害值是数字，可用 `Math.round(...)` 或 `Number(...)` 确保
- 确认 `context.piece.attack` 存在且为正数

### 状态效果施加后不显示

- 检查 `addStatusEffectById` 的第一个参数是否是棋子的 `instanceId`（不是 `templateId`）
- 使用 `target.instanceId`，而不是 `target.id` 或 `target.templateId`

### 规则文件加载失败

- 检查 JSON 格式是否合法（可用在线 JSON 验证器）
- 文件名和 JSON 中的 `id` 字段可以不同，但建议保持一致
- 检查文件是否保存在 `data/rules/` 目录（不是 `data/skills/`）

---

## 游戏系统常量

`lib/game/turn.ts` 顶部的 `BATTLE_DEFAULTS` 集中定义了行动点相关的参数：

```typescript
const BATTLE_DEFAULTS = {
  initialMaxActionPoints: 1,       // 第1回合最大行动点
  actionPointsGrowthPerTurn: 1,    // 每过一个自己回合，最大行动点增加量
  maxActionPointsLimit: 10,        // 最大行动点上限
  moveActionCost: 1,               // 移动消耗的行动点
}
```

编写技能时不需要修改这些常量，了解含义即可。

---

# 训练营使用教程

## 概述

训练营是一个用于测试棋子、技能和战斗系统的独立环境。你可以自由控制双方棋子，无需等待对手，非常适合学习和调试游戏机制。

## 功能特性

### 1. 双方控制
- 点击"红方"或"蓝方"按钮切换当前控制方
- 可以随时切换控制任意一方的棋子
- 双方共享同一个视角，但只能操作当前控制方的棋子

### 2. 添加棋子
- 点击"添加棋子"按钮打开添加对话框
- 选择阵营（红方/蓝方）
- 选择棋子模板（战士、法师、射手等）
- 设置初始位置（X、Y坐标）
- 点击"添加"将棋子放入战场

### 3. 修改资源
- 点击"修改资源"按钮打开资源修改对话框
- 选择要修改的玩家（红方/蓝方）
- 调整行动点（0-20）
- 调整充能点（0-20）
- 点击"更新"应用修改

### 4. 重置冷却
- 点击"重置冷却"按钮
- 所有棋子的所有技能冷却时间立即归零
- 可以立即再次使用任何技能

### 5. 切换地图
- 点击"切换地图"按钮
- 选择不同的地图配置
- 战场会立即切换到新地图

## 操作流程

### 基本操作

1. **选择棋子**：点击棋子图标或战场上的棋子，选中的棋子会高亮显示
2. **移动棋子**：选中己方棋子后，点击蓝色高亮的可移动格子，消耗1点行动点
3. **使用技能**：选中棋子后点击右侧技能按钮，根据提示选择目标
4. **结束回合**：完成所有操作后，点击"结束回合"按钮

## 注意事项

1. **资源管理**：每个回合开始时行动点会恢复；充能点不会自动恢复，需要使用特定技能或手动修改
2. **技能冷却**：技能使用后进入冷却，使用"重置冷却"可立即清除
3. **棋子位置**：棋子不能移动到墙壁或已有其他棋子的位置
4. **战斗逻辑**：训练营使用与正式战斗相同的逻辑，适合测试和验证战斗机制

---

# 地图设计教程

## 概述

地图以 ASCII 字符画的形式定义，保存为 `data/maps/` 目录下的 `.json` 文件。游戏启动时会自动扫描并加载该目录下的所有地图，无需手动注册。

---

## 文件结构

```json
{
  "id": "my-map",
  "name": "我的地图",
  "layout": [
    "########",
    "#S....S#",
    "#......#",
    "########"
  ],
  "legend": [
    { "char": "#", "type": "wall",  "walkable": false, "bulletPassable": false },
    { "char": ".", "type": "floor", "walkable": true,  "bulletPassable": true  },
    { "char": "S", "type": "spawn", "walkable": true,  "bulletPassable": true  }
  ],
  "rules": []
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 地图唯一 ID，需与文件名一致 |
| `name` | string | 显示给玩家的地图名称 |
| `layout` | string[] | ASCII 字符画，每行长度必须相同 |
| `legend` | 数组 | 字符到格子属性的映射，每个字符必须在此定义 |
| `rules` | string[] | 地图级别触发规则 ID 列表，目前可留空 `[]` |

**重要**：`layout` 中出现的每个字符都必须在 `legend` 中有对应条目。

---

## 格子类型（TileType）

### 基础类型

| 类型 | 推荐字符 | `walkable` | `bulletPassable` | 说明 |
|------|---------|-----------|-----------------|------|
| `floor` | `.` | `true` | `true` | 普通地板，可自由行走 |
| `wall` | `#` | `false` | `false` | 墙壁，完全阻挡 |
| `spawn` | `S` | `true` | `true` | 出生点，仅影响初始摆放 |
| `cover` | `C` | `true` | `false` | 掩体，可行走但阻挡子弹/投射物 |
| `hole` | `H` | `false` | `true` | 洞口，不可行走但子弹可穿过 |

### 特殊效果类型

以下三种类型会在**每个玩家回合开始时**（start → action 阶段）对站在该格子上的棋子自动触发效果。

#### 熔岩（lava）

```json
{ "char": "L", "type": "lava", "walkable": true, "bulletPassable": true, "damagePerTurn": 1 }
```

- **颜色**：橙红色
- **效果**：每回合开始时对站在上面的棋子造成 `damagePerTurn` 点**真实伤害**（无视防御，可致死；推荐值 1–5）
- **策略意义**：形成危险区域，迫使玩家快速通过或绕行

#### 治愈泉（spring）

```json
{ "char": "W", "type": "spring", "walkable": true, "bulletPassable": true, "healPerTurn": 2 }
```

- **颜色**：青绿色
- **效果**：每回合开始时为站在上面的棋子恢复 `healPerTurn` 点HP（不超过最大HP；推荐值 1–5）
- **策略意义**：争夺治愈泉成为核心战术目标

#### 充能台（chargepad）

```json
{ "char": "E", "type": "chargepad", "walkable": true, "bulletPassable": true, "chargePerTurn": 1 }
```

- **颜色**：紫色
- **效果**：每回合开始时为棋子所属玩家提供 `chargePerTurn` 点充能点（推荐值 1）
- **策略意义**：加速充能技能的积累，鼓励前压式打法

---

## 特殊格子效果的实现

特殊地形效果在 `lib/game/turn.ts` 的 `beginPhase` 处理器中实现，通过调用 `dealDamage` / `healDamage` 函数完整联动护盾、触发器等所有效果。编写地图时无需修改此代码，只需在 `legend` 中填写正确的 `type` 和效果参数即可。

```typescript
// 地形效果触发时机：每个玩家回合的 start → action 阶段
// 实现原理（供参考，不需要修改）：
if (tile.props.damagePerTurn > 0) {
  dealDamage(piece, piece, tile.props.damagePerTurn, "true", next, "lava-terrain")
}
if (tile.props.healPerTurn > 0 && piece.currentHp > 0) {
  healDamage(piece, piece, tile.props.healPerTurn, next, "spring-terrain")
}
if (tile.props.chargePerTurn > 0 && piece.currentHp > 0) {
  playerMeta.chargePoints += tile.props.chargePerTurn
}
```

---

## 手牌卡牌系统

### 概述

卡牌定义存储在 `data/cards/*.json`，玩家在对局中持有手牌（最多10张）。
卡牌只能通过 `addCardToHand()` 函数加入手牌，不会自动获得。

### CardDefinition JSON 格式

```json
{
  "id": "card-id",
  "name": "卡牌名称",
  "description": "卡牌说明文字",
  "type": "active",
  "icon": "Heart",
  "code": "function executeCard(context) { ... }"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 与文件名一致 |
| `name` | string | 显示名称 |
| `description` | string | 说明文字 |
| `type` | `"active"` \| `"reactive"` | 主动/被动 |
| `trigger` | `{ type: TriggerType }` | 仅 reactive 需要，触发时机 |
| `code` | string | JS代码，入口为 `executeCard(context)` |
| `icon` | string | lucide-react 图标名（可选） |

### 卡牌类型

- **active（主动牌）**：玩家在行动阶段点击使用，使用后弃置。没有 `sourcePiece`，通过 `playerId` 识别阵营。
- **reactive（被动牌）**：监听指定触发时机，条件满足时自动触发并弃置。双方手牌都会被扫描。

### 代码入口

```javascript
function executeCard(context) {
  // context 为触发上下文（reactive）或空对象（active）
  // playerId 变量可直接使用（当前持牌玩家ID）
  // battle 变量可直接使用
  return { success: true, message: "效果描述" }
}
```

### 卡牌可用函数

卡牌代码里可以直接使用以下所有函数（无需 `import`，系统自动注入）：

#### 伤害 / 治疗

| 函数 | 说明 |
|------|------|
| `dealDamage(attacker, target, amount, type, battle, cardId)` | 造成伤害（同技能中的 dealDamage） |
| `healDamage(healer, target, amount, battle, cardId)` | 治疗（同技能中的 healDamage） |

#### 目标 / 选项

| 函数 | 说明 |
|------|------|
| `selectTarget(opts)` | 弹出目标选择，同技能中用法相同；必须检查 `needsTargetSelection` |
| `selectOption(config)` | 弹出选项列表，同技能中用法相同；必须检查 `needsOptionSelection` |

#### 状态管理

| 函数 | 说明 |
|------|------|
| `addStatusEffectById(pieceId, statusObj)` | 为棋子施加状态标签 |
| `removeStatusEffectById(pieceId, statusId)` | 移除棋子状态标签 |

#### 棋子规则管理

| 函数 | 说明 |
|------|------|
| `addRuleById(pieceId, ruleId)` | 为**棋子**附加一个被动规则 |
| `removeRuleById(pieceId, ruleId)` | 从**棋子**移除一个被动规则 |

#### 玩家规则管理（新）

| 函数 | 说明 |
|------|------|
| `addPlayerRuleById(playerId, ruleId)` | 为**玩家**附加一个玩家级别规则（不挂在棋子上） |
| `removePlayerRuleById(playerId, ruleId)` | 从**玩家**移除一个玩家级别规则 |

#### 手牌操作

| 函数 | 签名 | 说明 |
|------|------|------|
| `addCardToHand` | `(cardId, targetPlayerId?)` | 将卡牌加入手牌；`targetPlayerId` 省略则为当前持牌玩家；手牌超过10张时自动弃置并记录日志 |
| `discardCard` | `(instanceId)` | 按 `instanceId` 弃置指定手牌到弃牌堆 |
| `getHand` | `(targetPlayerId?)` | 获取指定玩家的手牌列表（`CardInstance[]`） |

```javascript
// 示例：向对方手牌加入一张卡
addCardToHand('lucky-coin', context.battle.players.find(
  p => p.ownerPlayerId !== playerId
)?.playerId)

// 示例：检查己方手牌数量
const hand = getHand(playerId)  // CardInstance[]
console.log('当前手牌数：', hand.length)

// 示例：弃置手牌中的第一张
const hand = getHand(playerId)
if (hand.length > 0) discardCard(hand[0].instanceId)
```

#### 工具

| 函数 | 说明 |
|------|------|
| `Math` | 标准 JavaScript Math |
| `console` | `console.log` / `console.error` 用于调试 |

### AP 消耗

无专用字段，在代码中用 `if` 语句判断：

```javascript
function executeCard(context) {
  const player = battle.players.find(p => p.playerId === playerId)
  if (!player || player.actionPoints < 1) {
    return { success: false, message: "行动点不足" }
  }
  player.actionPoints -= 1
  // ... 执行效果
}
```

### gameStart 触发器

`gameStart` 在战斗开始时触发一次（`turnNumber === 1`，`beginPhase` 时），**只触发一次**（由 `gameStartFired` 标志保护）。

常见用途：开局发手牌、初始化玩家级别规则等。写法与普通规则完全一致，使用 `triggerSkill`：

```json
// data/rules/rule-deal-opening-card.json
{
  "id": "rule-deal-opening-card",
  "name": "开局发牌",
  "description": "战斗开始时向指定玩家发一张手牌",
  "trigger": { "type": "gameStart" },
  "effect": { "type": "triggerSkill", "skillId": "deal-opening-card", "message": "" },
  "limits": { "maxUses": 1 }
}
```

```json
// data/skills/deal-opening-card.json
{
  "id": "deal-opening-card",
  "kind": "passive",
  "type": "normal",
  "form": "self",
  "range": 0,
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { addCardToHand('lucky-coin', context.playerId); return { success: true, message: '开局获得幸运币' }; }"
}
```

> **注意**：`gameStart` 规则写在**玩家的 `rules` 数组**里（玩家级别规则，详见下一章），而不是棋子身上。

### 示例：主动牌

```json
{
  "id": "first-aid-kit",
  "name": "急救包",
  "description": "消耗1AP，为友方棋子回复15生命",
  "type": "active",
  "code": "function executeCard(context) {\n  const player = battle.players.find(p => p.playerId === playerId);\n  if (!player || player.actionPoints < 1) return { success: false, message: 'AP不足' };\n  const target = selectTarget({ filter: 'ally', range: 99 });\n  if (!target) return { success: false, message: '请选择目标' };\n  player.actionPoints -= 1;\n  const r = healDamage(target, target, 15, battle, 'first-aid-kit');\n  return { success: true, message: '急救包：回复' + r.heal + '点生命' };\n}"
}
```

### 示例：被动牌

```json
{
  "id": "counter-will",
  "name": "反击意志",
  "description": "友方受伤时自动触发：对攻击者造成5点真实伤害",
  "type": "reactive",
  "trigger": { "type": "afterDamageTaken" },
  "code": "function executeCard(context) {\n  if (!context.targetPiece || context.targetPiece.ownerPlayerId !== playerId) return { success: false };\n  const r = dealDamage(context.targetPiece, context.sourcePiece, 5, 'true', battle, 'counter-will');\n  return { success: true, message: '反击意志：造成5点真实伤害' };\n}"
}
```

---

## 完整地图示例

```json
{
  "id": "volcanic-arena",
  "name": "火山竞技场",
  "layout": [
    "##########",
    "#S..LL..S#",
    "#.CC..CC.#",
    "#.C.WW.C.#",
    "#.CC..CC.#",
    "#S..EE..S#",
    "##########"
  ],
  "legend": [
    { "char": "#", "type": "wall",     "walkable": false, "bulletPassable": false },
    { "char": ".", "type": "floor",    "walkable": true,  "bulletPassable": true  },
    { "char": "S", "type": "spawn",    "walkable": true,  "bulletPassable": true  },
    { "char": "C", "type": "cover",    "walkable": true,  "bulletPassable": false },
    { "char": "L", "type": "lava",     "walkable": true,  "bulletPassable": true, "damagePerTurn": 2 },
    { "char": "W", "type": "spring",   "walkable": true,  "bulletPassable": true, "healPerTurn": 3   },
    { "char": "E", "type": "chargepad","walkable": true,  "bulletPassable": true, "chargePerTurn": 1 }
  ],
  "rules": []
}
```

---

# 玩家级别规则（Player-Level Rules）

## 概念

**玩家级别规则**（player rule）是挂在玩家本身上的被动触发器，而不是某个具体棋子上。适合用于：

- 开局发手牌（`gameStart`）
- 每回合开始时给整个阵营加行动力
- "己方任意棋子死亡时"触发全局效果
- 棋子技能将某个规则"授权"给阵营而非绑在自己身上

与棋子规则的区别：

| 维度 | 棋子规则 `piece.rules[]` | 玩家规则 `player.rules[]` |
|------|--------------------------|--------------------------|
| 挂载位置 | 单个棋子实例 | 玩家（PlayerTurnMeta） |
| 棋子死亡后 | 规则随棋子消失 | 规则保持不变 |
| 代码中的 context | `context.piece` = 棋子 | `context.piece` = null，用 `context.playerId` 识别阵营 |
| 典型用途 | 反击、流血、圣盾等棋子本身的被动 | 开局发牌、阵营级增益、全局监听 |

---

## 文件结构

与棋子规则完全一样，都在 `data/rules/*.json`，格式不变。唯一区别是这个规则会被加到 `PlayerTurnMeta.rules[]` 而不是 `PieceInstance.rules[]`。

---

## 创建玩家级别规则

### 步骤一：创建规则文件

```json
// data/rules/rule-lucky-coin-start.json
{
  "id": "rule-lucky-coin-start",
  "name": "幸运币规则",
  "description": "战斗开始时，该玩家获得一张幸运币手牌",
  "trigger": { "type": "gameStart" },
  "effect": { "type": "triggerSkill", "skillId": "grant-lucky-coin", "message": "" },
  "limits": { "maxUses": 1 }
}
```

> `limits.maxUses: 1` 确保 `gameStart` 规则只触发一次。

### 步骤二：创建技能文件

技能里通过 `context.playerId` 获取阵营，而不是 `context.piece`：

```json
// data/skills/grant-lucky-coin.json
{
  "id": "grant-lucky-coin",
  "name": "发放幸运币",
  "description": "战斗开始时，该阵营玩家获得一张幸运币手牌",
  "kind": "passive",
  "type": "normal",
  "form": "self",
  "range": 0,
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { var player = context.battle.players.find(function(p) { return p.playerId === context.playerId; }); if (!player) return { success: false, message: '' }; addCardToHand('lucky-coin', player.playerId); return { success: true, message: (player.name || player.playerId) + ' 获得了幸运币' }; }"
}
```

### 步骤三：在战斗初始化时为玩家挂载规则

在 `battle-setup.ts` 的 `players` 数组里，为目标玩家加上规则：

```typescript
// lib/game/battle-setup.ts（节选）
import { loadRuleById } from "./skills"

players: [
  { playerId: p1, ..., hand: [], discardPile: [], rules: [] },
  {
    playerId: p2, ..., hand: [], discardPile: [],
    rules: [loadRuleById('rule-lucky-coin-start')].filter(Boolean),
  },
]
```

---

## 在技能代码中动态绑定玩家规则

棋子技能也可以在运行时给整个阵营玩家授予规则，使用 `addPlayerRuleById`：

```javascript
// 某主动技能的 code：给己方玩家授予一个被动规则
function executeSkill(context) {
  const caster = context.piece
  addPlayerRuleById(caster.ownerPlayerId, 'rule-faction-buff')
  return { success: true, message: caster.name + '为己方阵营施加了增益' }
}
```

反向操作——移除玩家规则：

```javascript
removePlayerRuleById(caster.ownerPlayerId, 'rule-faction-buff')
```

---

## 玩家规则的技能代码写法要点

玩家规则触发的技能（`kind: "passive"`）里，**`context.piece` 为 null**。必须用 `context.playerId` 来识别阵营：

```javascript
function executeSkill(context) {
  // ✅ 正确：用 context.playerId 获取玩家
  var player = context.battle.players.find(function(p) {
    return p.playerId === context.playerId
  })
  if (!player) return { success: false, message: '' }

  // ✅ 可以访问该阵营的所有棋子
  var myPieces = context.battle.pieces.filter(function(p) {
    return p.ownerPlayerId === context.playerId && p.currentHp > 0
  })

  // ✅ 可以修改玩家资源
  player.actionPoints += 1

  // ✅ 可以向玩家手牌加卡
  addCardToHand('lucky-coin', context.playerId)

  // ❌ 禁止：context.piece 为 null，不能用
  // dealDamage(context.piece, ...)  // 会崩溃！
}
```

---

## 可用触发类型

玩家规则支持所有触发类型，但以下几种最适合玩家级别：

| 触发类型 | 说明 | 典型用途 |
|---------|------|---------|
| `gameStart` | 战斗开始时触发一次 | 开局发手牌、初始化状态 |
| `beginTurn` | 每个回合开始时 | 每回合给阵营加资源 |
| `endTurn` | 每个回合结束时 | 结算阵营级持续效果 |
| `afterPieceKilled` | 任意棋子被击杀后 | "我方击杀时" 阵营奖励 |
| `onPieceDied` | 任意棋子死亡后 | "我方棋子死亡时" 触发 |
| `afterDamageDealt` | 任意伤害造成后 | 阵营级吸血、计数器等 |
| `whenever` | 每一步行动后 | 实时条件检测 |

---

## 完整示例：蓝方开局幸运币

本示例已集成到项目中，可作为参考模板：

```
data/cards/lucky-coin.json            ← 卡牌定义（无消耗，+1行动力）
data/rules/rule-lucky-coin-start.json ← 规则文件（gameStart 触发，maxUses: 1）
data/skills/grant-lucky-coin.json     ← 技能文件（addCardToHand 给蓝方）
lib/game/battle-setup.ts              ← 蓝方玩家 rules: [loadRuleById('rule-lucky-coin-start')]
app/api/training/route.ts             ← 训练营同上
```

触发流程：
```
战斗开始（beginPhase turn 1）
  → checkTriggers("gameStart")
  → 遍历 state.players[].rules
  → 蓝方有 rule-lucky-coin-start
  → 调用 grant-lucky-coin 技能
  → addCardToHand('lucky-coin', 'training-blue')
  → 蓝方手牌里出现幸运币
```
