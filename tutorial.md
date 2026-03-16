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
19. [手牌卡牌系统](#手牌卡牌系统)
20. [玩家级别规则（Player-Level Rules）](#玩家级别规则player-level-rules)

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

### 法则二点五：AoE 伤害必须传入数组，禁止用 forEach 循环调用 dealDamage

对多个目标造成伤害时，必须将目标数组整体传给 `dealDamage` / `healDamage`。**禁止**在 forEach/for 循环里逐个调用，否则 `beforeDamageDealt` 触发器（含伤害加成 buff）会被消耗多次。

```javascript
// ✅ 正确：buff 只消耗一次，所有目标共享修改后的伤害值
const enemies = getAllEnemiesInRange(3)
const result = dealDamage(sourcePiece, enemies, 10, 'magical', context.battle, context.skill.id)
// result.totalDamage / result.results[i].damage / result.results[i].isKilled

// ❌ 错误 — 每次循环都会触发一次 beforeDamageDealt，buff 会被多次消耗
enemies.forEach(enemy => {
  dealDamage(sourcePiece, enemy, 10, 'magical', context.battle, context.skill.id)
})
```

> **注意**：单独调用仍然完全兼容旧逻辑，无需改写已有的单体技能。

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

### 法则六：游戏核心逻辑必须完全独立于所有棋子（禁止硬编码）

**这是最重要的法则。游戏核心逻辑（`lib/game/` 下的代码）必须完全独立于任何特定棋子，禁止任何形式的硬编码。**

#### 禁止的行为

```
❌ 错误：在 lib/game/turn.ts 等主进程文件中硬编码角色技能逻辑
❌ 错误：在 lib/game/battle-setup.ts 中根据 piece.id === 'liadrin' 特殊处理
❌ 错误：在 lib/game/skills.ts 中针对特定角色写死逻辑
❌ 错误：在任何游戏核心代码中通过 if (piece.id === 'xxx') 来判断角色
❌ 错误：在 BattleState 类型中硬编码角色特定的字段（如 recallData、stickyBombs）
```

#### 正确的做法

```
✅ 正确：在 data/skills/ 和 data/rules/ 中定义技能效果
✅ 正确：在 data/pieces/xxx.json 中通过 "rules" 字段绑定规则到棋子
✅ 正确：通过 addRuleById 动态绑定规则到棋子
✅ 正确：游戏核心只负责加载和执行规则，不关心规则属于哪个角色
✅ 正确：角色特定的数据存储在 battle.extensions 中，而不是硬编码在 BattleState 类型中
```

#### 角色特定数据的正确存储方式

**❌ 错误：在 BattleState 中硬编码字段**
```typescript
// lib/game/battle-types.ts
export interface BattleState {
  // ...其他字段
  recallData?: Array<...>  // ❌ 硬编码猎空的数据
  stickyBombs?: Array<...> // ❌ 硬编码猎空的数据
}
```

**✅ 正确：使用 extensions 字段存储角色特定数据**
```typescript
// lib/game/battle-types.ts
export interface BattleState {
  // ...其他字段
  extensions?: Record<string, any>  // ✅ 通用扩展字段
}

// 在角色技能代码中
function executeSkill(context) {
  // 初始化扩展数据
  if (!battle.extensions) battle.extensions = {};
  if (!battle.extensions.recallData) battle.extensions.recallData = [];
  
  // 使用扩展数据
  battle.extensions.recallData.push({...});
}
```

#### 为什么这很重要

1. **模块化**：角色应当是独立的模块，可以随时添加或删除，不影响游戏核心
2. **可维护性**：修改角色技能只需要改 JSON 文件，不需要改游戏代码
3. **扩展性**：添加新角色只需要添加新的 JSON 文件，不需要修改游戏逻辑
4. **避免 Bug**：硬编码会导致代码耦合，一个角色的修改可能影响其他角色
5. **类型安全**：使用 `extensions` 字段避免频繁修改核心类型定义

#### 违规示例

```typescript
// ❌ 错误！在 battle-setup.ts 中硬编码
if (piece.id === 'liadrin') {
  ruleIds.add('rule-blood-echo')
}

// ✅ 正确！在 liadrin.json 中定义 rules 字段
{
  "id": "liadrin",
  "rules": ["rule-blood-echo"]
}
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

**`target` 支持单个棋子或棋子数组。** 传入数组时，`beforeDamageDealt` 触发器（含 buff 消耗）**只触发一次**，所有目标共享同一次 buff 修改后的伤害值——这是 AoE 技能的正确写法。

```javascript
// 单体伤害
const result = dealDamage(
  sourcePiece,          // 攻击者棋子实例
  target,               // 单个目标棋子实例
  20,                   // 基础伤害值
  'physical',           // 伤害类型：'physical' / 'magical'（受防御减免）/ 'true'（无视防御）
  context.battle,
  context.skill.id
)
// result.success / result.damage / result.isKilled / result.targetHp / result.message

// 多体伤害（推荐：buff 只消耗一次）
const result = dealDamage(
  sourcePiece,
  enemies,              // PieceInstance[] 数组
  10,
  'magical',
  context.battle,
  context.skill.id
)
// result.success     - 是否成功
// result.totalDamage - 所有目标的伤害总和
// result.damages[]   - 每个目标实际受到的伤害
// result.results[]   - 每个目标的完整结果（.damage / .isKilled / .targetHp）
```

#### `healDamage(healer, target, baseHeal, battle, skillId)`

对目标进行治疗。自动处理禁疗状态、触发器。

**`target` 同样支持单个棋子或棋子数组。** 传入数组时，`beforeHealDealt` 触发器只触发一次。

```javascript
// 单体治疗
const result = healDamage(sourcePiece, target, 10, context.battle, context.skill.id)
// result.success / result.heal / result.targetHp / result.message

// 多体治疗（推荐：buff 只消耗一次）
const result = healDamage(sourcePiece, allies, 10, context.battle, context.skill.id)
// result.success    - 是否成功
// result.totalHeal  - 总治疗量
// result.heals[]    - 每个目标实际恢复的生命值
// result.results[]  - 每个目标的完整结果
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

// ✅ 推荐：传入数组，buff（如伤害加成）只消耗一次
const result = dealDamage(sourcePiece, enemies, 10, 'magical', context.battle, context.skill.id)
// result.totalDamage / result.results[]

// ❌ 旧写法（不推荐）：每次调用都会消耗一次 buff
// enemies.forEach(enemy => {
//   dealDamage(sourcePiece, enemy, 10, 'magical', context.battle, context.skill.id)
// })
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

#### `addPlayerRuleById(targetPlayerId, ruleId)`

为**玩家**（阵营级别）绑定一个规则，不挂在棋子上。即使施法棋子死亡，规则仍然生效。

```javascript
addPlayerRuleById(sourcePiece.ownerPlayerId, 'rule-faction-buff')
```

#### `removePlayerRuleById(targetPlayerId, ruleId)`

从玩家移除一个玩家级别规则。

```javascript
removePlayerRuleById(sourcePiece.ownerPlayerId, 'rule-faction-buff')
```

### 技能管理

#### `addSkillById(targetPieceId, skillId)`

在运行时为棋子添加一个技能。

#### `removeSkillById(targetPieceId, skillId)`

从棋子移除一个技能。

### 手牌管理

#### `addCardToHand(cardId, targetPlayerId?)`

将卡牌加入指定玩家手牌。`targetPlayerId` 省略则默认为施法者的玩家ID。手牌上限10张，超出自动弃置并记录日志。会触发 `beforeCardAdded`/`afterCardAdded` 触发器。

```javascript
// 向对手加一张牌
addCardToHand('curse-ward', battle.players.find(p => p.playerId !== sourcePiece.ownerPlayerId)?.playerId)
// 向自己加一张牌
addCardToHand('lucky-coin')
```

#### `discardCard(instanceId)`

按实例ID弃置手牌到弃牌堆。

```javascript
const hand = getHand(sourcePiece.ownerPlayerId)
if (hand.length > 0) discardCard(hand[0].instanceId)
```

#### `getHand(targetPlayerId?)`

获取指定玩家手牌列表（`CardInstance[]`）。省略参数返回施法者手牌。

```javascript
const hand = getHand(sourcePiece.ownerPlayerId)
console.log('手牌数：', hand.length)
```

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

## 召唤棋子函数（summonPiece）

`summonPiece` 函数用于将棋子召唤到棋盘上，同时触发相关的召唤事件。这是添加棋子到战场的标准方式。

### 函数签名

```typescript
function summonPiece(
  battle: BattleState,
  options: SummonPieceOptions,
  getPieceById: (id: string) => PieceTemplate,
  createPieceInstance: (template, ownerPlayerId, faction, x, y, index) => PieceInstance
): SummonPieceResult
```

### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `battle` | `BattleState` | 当前战斗状态 |
| `options` | `SummonPieceOptions` | 召唤配置选项 |
| `getPieceById` | `Function` | 获取棋子模板的函数 |
| `createPieceInstance` | `Function` | 创建棋子实例的函数 |

### SummonPieceOptions 配置

```typescript
interface SummonPieceOptions {
  templateId: string        // 棋子模板ID，如 "tyrande"
  faction: "red" | "blue"   // 阵营
  ownerPlayerId: string     // 所属玩家ID
  x: number                 // 召唤位置X坐标
  y: number                 // 召唤位置Y坐标
  index?: number            // 棋子索引（可选，默认1）
}
```

### 返回值

```typescript
interface SummonPieceResult {
  success: boolean          // 是否成功
  piece?: PieceInstance     // 召唤的棋子实例（成功时）
  message?: string          // 提示信息
  blocked?: boolean         // 是否被阻止
}
```

### 触发器

`summonPiece` 会自动触发以下两个触发器：

#### beforePieceSummon（棋子召唤前）

**触发时机**：棋子实例创建前

**上下文参数**：
- `playerId`: 召唤者玩家ID
- `targetPosition`: `{ x, y }` 召唤位置
- `pieceTemplateId`: 棋子模板ID
- `faction`: 阵营

**可 blocked**: ✅ 可以阻止召唤

#### afterPieceSummon（棋子召唤后）

**触发时机**：棋子已添加到棋盘后

**上下文参数**：
- `playerId`: 召唤者玩家ID
- `piece`: 被召唤的棋子实例
- `pieceTemplateId`: 棋子模板ID
- `faction`: 阵营

**可 blocked**: ❌ 不能阻止（已发生）

### 使用示例

```typescript
// 在训练模式中添加棋子
const result = summonPiece(
  battleState,
  {
    templateId: 'tyrande',
    faction: 'blue',
    ownerPlayerId: 'training-blue',
    x: 5,
    y: 3
  },
  getPieceById,
  createPieceInstance
)

if (result.success) {
  console.log(result.message)  // "泰兰德 被召唤到 (5, 3)"
} else {
  console.log(result.message)  // 错误信息
}
```

### 规则加载

`summonPiece` 会自动将棋子的规则加载到全局触发器系统：

1. 查找棋子模板的 `rules` 数组
2. 使用 `loadRuleById` 加载每个规则
3. 通过 `globalTriggerSystem.addRule` 添加到全局触发器

这意味着召唤的棋子会立即拥有其被动技能效果。

### 与 addPiece 的区别

| 方式 | 触发器 | 规则加载 | 使用场景 |
|------|--------|----------|----------|
| `summonPiece` | ✅ 触发 before/after | ✅ 自动加载 | 标准召唤流程 |
| 直接 `createPieceInstance` | ❌ 不触发 | ❌ 手动加载 | 特殊逻辑 |

**推荐**：始终使用 `summonPiece` 来添加棋子到战场。

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
  "code": "function executeSkill(context) { const caster = context.piece; const enemies = getAllEnemiesInRange(3); if (enemies.length === 0) { return { success: false, message: '范围内没有敌人' }; } const dmg = Math.round(caster.attack * context.skill.powerMultiplier); const result = dealDamage(caster, enemies, dmg, 'magical', context.battle, context.skill.id); return { success: true, message: caster.name + '释放烈焰爆发，对' + enemies.length + '个敌人共造成' + result.totalDamage + '点伤害' }; }"
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

### 规则执行优先级

当多个规则在同一个触发时机（如 `beforeDamageTaken`）被触发时，它们的**执行顺序非常重要**。系统按照以下顺序执行规则：

#### 执行顺序

1. **全局规则**（`globalTriggerSystem` 中的规则）
2. **棋子级别规则**（`piece.rules[]`）
3. **玩家级别规则**（`player.rules[]`）
4. **手牌中的 reactive 卡牌**

#### 同一级别内的执行顺序

在同一级别内，规则按照它们在数组中的**原始顺序**执行。后执行的规则可以覆盖先执行规则对 `context` 的修改。

#### 优先级设计模式

对于 `beforeDamageTaken` 等可以 `blocked` 的触发类型，通常需要设计优先级：

| 优先级 | 规则类型 | 示例 |
|--------|----------|------|
| 高优先级（先执行） | 伤害减免、护盾类 | 圣盾、防御姿态 |
| 低优先级（后执行） | 伤害免疫、特殊救援 | 艾露恩的守护 |

#### 实现优先级的方法

目前系统**不支持**在规则 JSON 中直接声明 `priority` 数值。优先级通过以下方式控制：

1. **全局规则 vs 棋子规则**：全局规则总是先于棋子规则执行
2. **规则绑定时机**：先绑定的规则先执行
3. **在技能代码中提前返回**：如果前置规则已经 `blocked`，后续规则不会执行

#### 示例：艾露恩的守护的优先级设计

**艾露恩的守护**（`rule-elune-protection.json`）是一个典型的低优先级规则：

```json
{
  "id": "rule-elune-protection",
  "name": "艾露恩的守护规则",
  "description": "当友方单位受到致命伤害且泰兰德在场时，触发艾露恩的守护。此规则应在所有beforeDamageTaken规则最后触发",
  "trigger": { "type": "beforeDamageTaken" },
  "skillCode": "const targetPiece = context.piece; const damage = context.damage; ..."
}
```

**实现逻辑**：

1. 检查是否为致命伤害（`targetPiece.currentHp <= damage`）
2. 检查泰兰德是否在场
3. 检查该友方单位本场战斗是否已触发过守护
4. 如果满足条件，添加已守护标记并恢复生命
5. 返回 `blocked: true` 阻止原始伤害

**为什么它应该是低优先级**：

- 如果先执行了艾露恩的守护，后续的伤害减免规则（如护盾）将没有机会生效
- 理想情况下，应该先执行护盾、防御姿态等伤害减免规则
- 如果伤害被减免到非致命，艾露恩的守护就不应该触发

**当前限制**：

目前系统没有内置的优先级排序机制。要实现严格的优先级控制，需要：
1. 将高优先级规则设计为全局规则或先绑定
2. 或者在技能代码中检查 `context.damage` 是否已被修改

#### 最佳实践

1. **伤害减免类规则**应该尽早执行，减少后续规则需要处理的伤害值
2. **伤害免疫/救援类规则**应该最后执行，作为最后的保险
3. **在技能代码中检查条件**：即使规则被触发，也要在 `skillCode` 中检查所有条件，确保逻辑正确
4. **使用 `blocked` 谨慎**：一旦一个规则返回 `blocked: true`，后续同类型规则仍然会被执行，但原始行动已被阻止

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
    // 传入数组：beforeDamageDealt 只触发一次，buff 只消耗一次
    const result = dealDamage(caster, enemies, dmg, 'physical', context.battle, context.skill.id)
    return { success: true, message: caster.name + '使用群体打击，攻击了' + enemies.length + '个目标，共造成' + result.totalDamage + '点伤害' }
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

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const checkPos = { x: targetPos.x + dx, y: targetPos.y + dy }
      const enemyAtPos = context.battle.pieces.find(p =>
        p.x === checkPos.x &&
        p.y === checkPos.y &&
        p.currentHp > 0 &&
        p.ownerPlayerId !== sourcePiece.ownerPlayerId
      )
      if (enemyAtPos) affectedEnemies.push(enemyAtPos)
    }
  }

  // 传入数组：beforeDamageDealt 只触发一次，buff（如伤害加成）只消耗一次
  if (affectedEnemies.length > 0) {
    const result = dealDamage(sourcePiece, affectedEnemies, damageValue, 'physical', context.battle, context.skill.id)
    return {
      message: sourcePiece.name + ' 从天而降，对 ' + affectedEnemies.map(e => e.name).join(', ') + ' 造成 ' + result.totalDamage + ' 点伤害',
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
  "code": "function executeSkill(context) { const sourcePiece = context.piece; if (!sourcePiece.statusTags || sourcePiece.statusTags.length === 0) { return { message: '没有状态标签', success: false }; } const blizzardStatus = sourcePiece.statusTags.find(effect => effect.type === 'blizzard'); if (!blizzardStatus) { return { message: '没有暴风雪状态', success: false }; } const centerX = blizzardStatus.value; const centerY = blizzardStatus.extraValue; const damageValue = blizzardStatus.damage; if (centerX === undefined || centerY === undefined || damageValue === undefined) { return { message: '暴风雪状态数据不完整', success: false }; } if (context.playerId === sourcePiece.ownerPlayerId) { return { message: '暴风雪只在对方回合结束时触发', success: false }; } const radius = 1; const enemiesInArea = context.battle.pieces.filter(piece => { if (piece.ownerPlayerId === sourcePiece.ownerPlayerId) return false; if (piece.currentHp <= 0) return false; return Math.abs(piece.x - centerX) <= radius && Math.abs(piece.y - centerY) <= radius; }); const dmgResult = dealDamage(sourcePiece, enemiesInArea, damageValue, 'magical', context.battle, 'blizzard'); enemiesInArea.forEach(function(enemy, i) { const r = dmgResult.results && dmgResult.results[i]; if (r && r.success) { const statusId = 'freeze-' + Date.now() + '-' + enemy.instanceId; addStatusEffectById(enemy.instanceId, { id: statusId, type: 'freeze', currentDuration: 1, intensity: 1 }); addRuleById(enemy.instanceId, 'rule-freeze-prevent-move'); addRuleById(enemy.instanceId, 'rule-freeze-prevent-skill'); addSkillById(enemy.instanceId, 'freeze-prevent'); enemy.showFreezeEffect = true; } }); const hitEnemies = enemiesInArea.filter(function(e, i) { return dmgResult.results && dmgResult.results[i] && dmgResult.results[i].success; }); if (!context.battle.effects) { context.battle.effects = []; } for (let x = centerX - radius; x <= centerX + radius; x++) { for (let y = centerY - radius; y <= centerY + radius; y++) { context.battle.effects.push({ type: 'blizzard', position: { x, y }, duration: 1, zIndex: 999, showOnUI: true }); } } removeStatusEffectById(sourcePiece.instanceId, blizzardStatus.id); removeRuleById(sourcePiece.instanceId, 'rule-blizzard-active'); removeSkillById(sourcePiece.instanceId, 'blizzard-damage'); let message = sourcePiece.name + '的暴风雪效果（中心坐标：(' + centerX + ',' + centerY + ')）'; if (hitEnemies.length > 0) { message += '对' + hitEnemies.map(function(e) { return e.name; }).join('、') + '造成了' + dmgResult.totalDamage + '点伤害并使其冰冻'; } else { message += '没有对任何敌人造成伤害'; } return { message: message, success: true, showUIEffects: true }; }",
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

| 触发类型 | context.piece | context.target | 说明 | 可 blocked |
|---------|--------------|---------------|------|-----------|
| `beforePieceSummon` | null | null | 棋子召唤前触发 | ✅ |
| `afterPieceSummon` | 被召唤的棋子 | 召唤者 | 棋子召唤后触发 | ❌ |
| `afterPieceKilled` | **击杀者** | 被击杀者 | 用于"我击杀时..."效果 | ❌ |
| `onPieceDied` | **死亡棋子自身** | 击杀者（攻击者） | 用于"我死亡时..."效果 | ❌ |
| `afterPieceSummoned` | 召唤者 | 被召唤者 | — | ❌ |

#### beforePieceSummon 详细说明

**触发时机**：棋子即将被召唤到棋盘前

**上下文参数**：
- `playerId`: 召唤者玩家ID
- `targetPosition`: `{ x, y }` 召唤位置
- `pieceTemplateId`: 棋子模板ID
- `faction`: 阵营

**用途**：
- 阻止召唤（如召唤位被封锁）
- 修改召唤位置
- 添加召唤前效果

**示例规则**：
```json
{
  "id": "rule-block-summon",
  "name": "召唤封锁",
  "description": "阻止敌方在特定区域召唤棋子",
  "trigger": { "type": "beforePieceSummon" },
  "skillCode": "if (context.faction !== context.rulePiece.faction && context.targetPosition.x < 5) { return { success: true, blocked: true, message: '该区域已被封锁，无法召唤' }; } return { success: false };"
}
```

#### afterPieceSummon 详细说明

**触发时机**：棋子已成功召唤到棋盘后

**上下文参数**：
- `playerId`: 召唤者玩家ID
- `piece`: 被召唤的棋子实例（完整棋子对象）
- `pieceTemplateId`: 棋子模板ID
- `faction`: 阵营

**用途**：
- 召唤后增益效果
- 召唤连携触发
- 记录召唤日志

**示例规则**：
```json
{
  "id": "rule-summon-buff",
  "name": "召唤增益",
  "description": "友方召唤棋子时，为其增加攻击力",
  "trigger": { "type": "afterPieceSummon" },
  "skillCode": "if (context.faction === context.rulePiece.faction && context.piece) { context.piece.attack += 2; return { success: true, message: context.piece.name + '获得召唤增益，攻击力+2' }; } return { success: false };"
}
```

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

### 卡牌类

| 触发类型 | context.piece | 额外字段 | 可 blocked | 说明 |
|---------|--------------|---------|-----------|------|
| `beforeCardPlay` | null | `playerId`, `cardId`, `cardInstanceId` | ✅ | 手牌使用前，可阻止 |
| `afterCardPlay` | null | `playerId`, `cardId`, `cardInstanceId` | ❌ | 手牌使用后 |
| `beforeCardAdded` | null | `playerId`, `cardId`, `sourcePiece` | ✅ | 手牌加入前，可阻止 |
| `afterCardAdded` | null | `playerId`, `cardId`, `cardInstanceId`, `sourcePiece` | ❌ | 手牌加入后 |

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

### ❌ 用 forEach 循环对多个目标调用 dealDamage

```javascript
// 禁止！每次调用都会触发一次 beforeDamageDealt，buff（如伤害加成）会被多次消耗
const enemies = getAllEnemiesInRange(3)
enemies.forEach(enemy => {
  dealDamage(sourcePiece, enemy, 10, 'physical', context.battle, context.skill.id)
})

// 必须改为：传入数组，buff 只消耗一次
const result = dealDamage(sourcePiece, enemies, 10, 'physical', context.battle, context.skill.id)
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
  "actionPointCost": 2,
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
| `actionPointCost` | number | 打出此卡消耗的行动点（默认 0）；系统自动检查并扣除，无需在代码里手动判断 |
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
| `dealDamage(attacker, target, amount, type, battle, cardId)` | 造成伤害（同技能中的 dealDamage，`target` 支持单棋子或数组） |
| `healDamage(healer, target, amount, battle, cardId)` | 治疗（同技能中的 healDamage，`target` 支持单棋子或数组） |

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
| `addCardToHand` | `(cardId, targetPlayerId?)` | 将卡牌加入手牌；`targetPlayerId` 省略则为当前持牌玩家；手牌超过10张时自动弃置并记录日志；会自动触发 `beforeCardAdded` 和 `afterCardAdded` 规则 |
| `discardCard` | `(instanceId)` | 按 `instanceId` 弃置指定手牌到弃牌堆 |
| `getHand` | `(targetPlayerId?)` | 获取指定玩家的手牌列表（`CardInstance[]`） |

```javascript
// 示例：向对方手牌加入一张卡
addCardToHand('lucky-coin', battle.players.find(
  p => p.playerId !== playerId
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

在卡牌定义中设置 `actionPointCost` 字段，系统会在 `playCard` 执行前自动检查并扣除，**无需在卡牌代码里手动判断或扣除**：

```json
{
  "id": "curse-ward",
  "name": "诅咒",
  "type": "active",
  "actionPointCost": 2,
  "code": "function executeCard(context) { ... }"
}
```

手牌实例上存储着 `actionPointCost` 的独立副本，可在运行时被效果修改（例如"诅咒增幅"将对手手牌中的诅咒消耗改为10）：

```javascript
// 在技能/规则的 skillCode 中修改对手手牌 AP 消耗
var opponentPlayer = battle.players.find(function(p) { return p.playerId !== caster.ownerPlayerId; });
for (var card of opponentPlayer.hand) {
  if (card.name && card.name.includes('诅咒')) {
    card.actionPointCost = 10;  // 直接修改手牌实例，下次打出时生效
  }
}
```

UI 中手牌按钮会自动显示 AP 消耗标签（黄色正常，红色表示 ≥10）。

### 卡牌相关触发器

卡牌系统支持以下触发器类型：

| 触发类型 | 触发时机 | 上下文参数 | 可 blocked | 说明 |
|---------|---------|-----------|-----------|------|
| `beforeCardPlay` | 手牌使用前 | `playerId`, `cardId`, `cardInstanceId` | ✅ | 可以阻止卡牌使用 |
| `afterCardPlay` | 手牌使用后 | `playerId`, `cardId`, `cardInstanceId` | ❌ | 触发连携效果 |
| `beforeCardAdded` | 手牌加入手里前 | `playerId`, `cardId`, `sourcePiece` | ✅ | 可以阻止添加手牌 |
| `afterCardAdded` | 手牌加入手里后 | `playerId`, `cardId`, `cardInstanceId`, `sourcePiece` | ❌ | 触发抽牌效果 |

#### beforeCardPlay（手牌使用前）

**触发时机**：玩家点击使用手牌后，卡牌效果执行前

**上下文参数**：
- `playerId`: 使用手牌的玩家ID
- `cardId`: 卡牌ID
- `cardInstanceId`: 卡牌实例ID

**用途**：
- 阻止卡牌使用（如沉默、封印效果）
- 修改卡牌效果（如强化、削弱）
- 记录日志

**示例规则**：
```json
{
  "id": "rule-silence-card",
  "name": "沉默封印",
  "description": "阻止敌方使用手牌",
  "trigger": { "type": "beforeCardPlay" },
  "skillCode": "if (context.playerId !== context.rulePiece.ownerPlayerId) { return { success: true, blocked: true, message: '敌方被沉默，无法使用手牌' }; } return { success: false };"
}
```

#### afterCardPlay（手牌使用后）

**触发时机**：手牌效果执行后，卡牌进入弃牌堆前

**上下文参数**：
- `playerId`: 使用手牌的玩家ID
- `cardId`: 卡牌ID
- `cardInstanceId`: 卡牌实例ID

**用途**：
- 触发连携效果（如"使用攻击牌后抽一张牌"）
- 记录使用次数
- 触发其他技能

**示例规则**：
```json
{
  "id": "rule-card-chain",
  "name": "卡牌连携",
  "description": "使用攻击牌后抽一张牌",
  "trigger": { "type": "afterCardPlay" },
  "skillCode": "if (context.cardId && context.cardId.startsWith('attack-')) { addCardToHand('basic-attack', context.playerId); return { success: true, message: '卡牌连携：抽一张攻击牌' }; } return { success: false };"
}
```

#### beforeCardAdded（手牌加入手里前）

**触发时机**：`addCardToHand()` 函数执行前

**上下文参数**：
- `playerId`: 目标玩家ID
- `cardId`: 要添加的卡牌ID
- `sourcePiece`: 来源棋子（可选，可能为 null）

**用途**：
- 阻止添加手牌（如"敌方不能抽牌"效果）
- 修改添加的卡牌（如"抽到的牌变成另一种牌"）
- 触发抽牌前的效果

**示例规则**：
```json
{
  "id": "rule-block-draw",
  "name": "封锁抽牌",
  "description": "阻止敌方抽牌",
  "trigger": { "type": "beforeCardAdded" },
  "skillCode": "if (context.playerId !== context.rulePiece.ownerPlayerId) { return { success: true, blocked: true, message: '敌方抽牌被封锁' }; } return { success: false };"
}
```

#### afterCardAdded（手牌加入手里后）

**触发时机**：`addCardToHand()` 函数执行后，卡牌已进入手牌

**上下文参数**：
- `playerId`: 目标玩家ID
- `cardId`: 卡牌ID
- `cardInstanceId`: 卡牌实例ID
- `sourcePiece`: 来源棋子（可选，可能为 null）

**用途**：
- 触发抽牌后的效果（如"抽牌时获得1点能量"）
- 记录手牌数量变化
- 触发连携效果

**示例规则**：
```json
{
  "id": "rule-draw-bonus",
  "name": "抽牌加成",
  "description": "每次抽牌后获得1点能量",
  "trigger": { "type": "afterCardAdded" },
  "skillCode": "const player = battle.players.find(p => p.playerId === context.playerId); if (player) { player.energy = (player.energy || 0) + 1; return { success: true, message: '抽牌加成：获得1点能量' }; } return { success: false };"
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

## 玩家状态标签（Player StatusTags）

### 概念

**玩家状态标签**（Player StatusTags）是挂在 `PlayerTurnMeta` 上的状态数组，与棋子状态标签（`piece.statusTags`）类似，但绑定在玩家身上。即使所有棋子死亡，玩家状态标签仍然存在。

### 适用场景

- **跨回合持续效果**：技能效果需要持续到玩家下一回合，即使施法棋子已死亡
- **玩家级别增益/减益**：影响玩家整体资源（行动点、手牌等）的效果
- **阵营级状态**：标记整个阵营的特殊状态

### 数据结构

```typescript
interface PlayerTurnMeta {
  playerId: string
  actionPoints: number
  maxActionPoints: number
  chargePoints: number
  hand: CardInstance[]
  discardPile: CardInstance[]
  rules: Rule[]           // 玩家级别规则
  statusTags?: StatusTag[] // 玩家状态标签数组（新增）
}

interface StatusTag {
  id: string              // 唯一标识
  type: string            // 状态类型（用于查找和识别）
  name: string            // 显示名称
  remainingDuration?: number // 剩余持续回合数
  intensity?: number      // 强度值
  stacks?: number         // 叠加层数
  // 其他自定义字段...
}
```

### 在技能代码中使用玩家状态标签

#### 添加状态标签

```javascript
function executeSkill(context) {
  var caster = context.piece
  var battle = context.battle
  
  // 获取施法者所属玩家
  var player = battle.players.find(function(p) {
    return p.playerId === caster.ownerPlayerId
  })
  
  // 初始化 statusTags 数组（如果不存在）
  if (!player.statusTags) player.statusTags = []
  
  // 添加状态标签
  player.statusTags.push({
    id: 'my-effect-' + Date.now(),  // 唯一ID
    type: 'my-effect',              // 状态类型
    name: '我的效果',                // 显示名称
    remainingDuration: 2            // 持续2回合
  })
  
  return { success: true, message: '效果已施加' }
}
```

#### 读取和检查状态标签

```javascript
function executeSkill(context) {
  var battle = context.battle
  var playerId = context.playerId  // 玩家规则中使用 context.playerId
  
  var player = battle.players.find(function(p) {
    return p.playerId === playerId
  })
  
  if (!player || !player.statusTags) {
    return { success: false, message: '没有状态标签' }
  }
  
  // 检查是否有特定类型的状态
  var hasEffect = player.statusTags.some(function(tag) {
    return tag.type === 'my-effect'
  })
  
  // 查找特定类型的状态
  var effectTag = player.statusTags.find(function(tag) {
    return tag.type === 'my-effect'
  })
  
  if (effectTag) {
    console.log('效果剩余回合：', effectTag.remainingDuration)
  }
  
  return { success: true, message: '' }
}
```

#### 移除状态标签

```javascript
function executeSkill(context) {
  var player = context.battle.players.find(function(p) {
    return p.playerId === context.playerId
  })
  
  if (!player || !player.statusTags) return { success: false }
  
  // 移除特定类型的状态标签
  player.statusTags = player.statusTags.filter(function(tag) {
    return tag.type !== 'my-effect'
  })
  
  return { success: true, message: '效果已移除' }
}
```

#### 减少持续时间并自动清理

```javascript
function executeSkill(context) {
  var player = context.battle.players.find(function(p) {
    return p.playerId === context.playerId
  })
  
  if (!player || !player.statusTags) return { success: false }
  
  // 遍历所有状态标签，减少持续时间
  player.statusTags = player.statusTags.filter(function(tag) {
    if (tag.remainingDuration !== undefined) {
      tag.remainingDuration--
      // 持续时间归零时移除
      return tag.remainingDuration > 0
    }
    return true  // 无持续时间限制的状态保留
  })
  
  return { success: true, message: '' }
}
```

---

## 完整示例：时空扭曲技能

以下是一个完整的玩家级别效果示例——"时空扭曲"技能。该技能：
1. 对自身造成4点伤害
2. 在敌方下一回合减少其1点行动点
3. 在自己的下一回合获得1点额外行动点
4. 效果绑定在玩家身上，即使施法棋子死亡仍然生效

### 文件1：主动技能（data/skills/rafaam-temporal-distortion.json）

```json
{
  "id": "rafaam-temporal-distortion",
  "name": "时空扭曲",
  "description": "对自身造成4点伤害，下一回合对方减少1点行动点，在自己的下一回合获得1个额外的行动点",
  "icon": "⏳",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 1,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 4,
  "code": "function executeSkill(context) { var caster = context.piece; var battle = context.battle; var damageResult = dealDamage(caster, caster, 4, 'magical', battle, context.skill.id); var casterOwnerId = caster.ownerPlayerId; var enemyPlayerId = battle.players.find(function(p) { return p.playerId !== casterOwnerId; })?.playerId; if (!enemyPlayerId) return { success: true, message: caster.name + '使用时空扭曲，对自身造成' + damageResult.damage + '点伤害' }; var selfPlayer = battle.players.find(function(p) { return p.playerId === casterOwnerId; }); var enemyPlayer = battle.players.find(function(p) { return p.playerId === enemyPlayerId; }); if (selfPlayer) { if (!selfPlayer.statusTags) selfPlayer.statusTags = []; selfPlayer.statusTags.push({ id: 'temporal-distortion-self-' + Date.now(), type: 'temporal-distortion-self', name: '时空扭曲-自身加AP', remainingDuration: 2 }); addPlayerRuleById(casterOwnerId, 'rule-rafaam-temporal-distortion'); } if (enemyPlayer) { if (!enemyPlayer.statusTags) enemyPlayer.statusTags = []; enemyPlayer.statusTags.push({ id: 'temporal-distortion-enemy-' + Date.now(), type: 'temporal-distortion-enemy', name: '时空扭曲-敌方减AP', remainingDuration: 2 }); addPlayerRuleById(enemyPlayerId, 'rule-rafaam-temporal-distortion'); } return { success: true, message: caster.name + '使用时空扭曲，对自身造成' + damageResult.damage + '点伤害，下回合敌方行动点-1，自己下回合行动点+1' }; }"
}
```

### 文件2：触发规则（data/rules/rule-rafaam-temporal-distortion.json）

```json
{
  "id": "rule-rafaam-temporal-distortion",
  "name": "时空扭曲规则",
  "description": "处理时空扭曲的效果：在玩家回合开始时检查并应用效果",
  "trigger": { "type": "beginTurn" },
  "effect": { "type": "triggerSkill", "skillId": "rafaam-temporal-distortion-trigger", "message": "" },
  "limits": { "maxUses": 2 }
}
```

### 文件3：被动触发技能（data/skills/rafaam-temporal-distortion-trigger.json）

```json
{
  "id": "rafaam-temporal-distortion-trigger",
  "name": "时空扭曲触发",
  "description": "处理时空扭曲的效果：在玩家回合开始时检查statusTags并应用效果",
  "icon": "⏳",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { try { var battle = context.battle; var currentPlayerId = battle.turn.currentPlayerId; var contextPlayerId = context.playerId; console.log('[rafaam-trigger] currentPlayerId:', currentPlayerId, 'contextPlayerId:', contextPlayerId); if (!contextPlayerId) return { success: false, message: 'No contextPlayerId' }; var player = battle.players.find(function(p) { return p.playerId === contextPlayerId; }); if (!player) return { success: false, message: 'Player not found' }; console.log('[rafaam-trigger] Player found, statusTags:', JSON.stringify(player.statusTags)); if (!player.statusTags) player.statusTags = []; var enemyEffect = player.statusTags.find(function(t) { return t.type === 'temporal-distortion-enemy'; }); var selfEffect = player.statusTags.find(function(t) { return t.type === 'temporal-distortion-self'; }); console.log('[rafaam-trigger] enemyEffect:', !!enemyEffect, 'selfEffect:', !!selfEffect); var message = ''; var effectTriggered = false; if (selfEffect && currentPlayerId === contextPlayerId) { player.actionPoints += 1; message += '时空扭曲使自身行动点+1'; effectTriggered = true; player.statusTags = player.statusTags.filter(function(t) { return t.type !== 'temporal-distortion-self'; }); console.log('[rafaam-trigger] Self effect applied, AP+1'); } if (enemyEffect && currentPlayerId === contextPlayerId) { if (player.actionPoints > 0) { player.actionPoints -= 1; message += '时空扭曲使行动点-1'; effectTriggered = true; } player.statusTags = player.statusTags.filter(function(t) { return t.type !== 'temporal-distortion-enemy'; }); console.log('[rafaam-trigger] Enemy effect applied, AP-1'); } console.log('[rafaam-trigger] effectTriggered:', effectTriggered, 'message:', message); if (effectTriggered) { return { success: true, message: message }; } return { success: false, message: 'No effect triggered' }; } catch (e) { console.error('[rafaam-trigger] Error:', e.message); return { success: false, message: 'Error: ' + e.message }; } }"
}
```

### 关键要点说明

1. **双方玩家都获得规则**：主动技能给双方都添加了 `rule-rafaam-temporal-distortion` 规则
2. **通过 statusTags 区分效果类型**：
   - `temporal-distortion-self`：表示"在自己的回合获得额外行动点"
   - `temporal-distortion-enemy`：表示"在自己的回合减少行动点"
3. **在被动技能中检查 currentPlayerId**：确保只在玩家自己的回合触发效果
4. **效果触发后立即移除 statusTag**：避免重复触发
5. **使用 context.playerId**：在玩家级别规则触发的技能中，这是获取当前玩家ID的唯一方式

---

## 技能上下文中的 playerId 字段

### 概念

在 `triggerSkill` 效果触发的被动技能中，`context` 对象包含 `playerId` 字段，用于标识触发该规则的玩家。

### 适用场景

- 玩家级别规则触发的技能（`player.rules[]` 中的规则）
- 需要知道"哪个玩家的回合"或"哪个玩家触发了规则"

### 数据结构

```javascript
// 在 triggerSkill 触发的被动技能中，context 包含：
context = {
  // ... 其他字段 ...
  
  playerId: "player1",  // 触发规则的玩家ID
  
  battle: { ... },
  skill: { ... }
}
```

### 使用示例

```javascript
function executeSkill(context) {
  // 获取触发规则的玩家ID
  var playerId = context.playerId
  
  if (!playerId) {
    return { success: false, message: 'No playerId in context' }
  }
  
  // 获取玩家对象
  var player = context.battle.players.find(function(p) {
    return p.playerId === playerId
  })
  
  // 检查是否是当前回合玩家
  var isCurrentPlayer = context.battle.turn.currentPlayerId === playerId
  
  if (isCurrentPlayer) {
    // 在当前玩家回合执行的逻辑
    player.actionPoints += 1
    return { success: true, message: '获得额外行动点' }
  }
  
  return { success: false, message: '不是当前玩家回合' }
}
```

### 与 piece.ownerPlayerId 的区别

| 字段 | 含义 | 使用场景 |
|------|------|---------|
| `context.playerId` | 触发规则的玩家ID | 玩家级别规则触发的技能 |
| `context.piece.ownerPlayerId` | 施法棋子所属玩家ID | 棋子级别规则触发的技能 |
| `context.battle.turn.currentPlayerId` | 当前回合玩家ID | 判断是否是某玩家的回合 |

### 注意事项

1. **玩家级别规则中 `context.piece` 为 null**：必须使用 `context.playerId`
2. **棋子级别规则中也有 `context.playerId`**：表示该棋子所属的玩家
3. **始终检查 `playerId` 是否存在**：某些旧代码可能未传递此字段

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

---

## 动态自定义手牌（battle.customCards）

当你需要创建一张运行时才能确定参数的卡牌（例如数值由技能触发时的伤害量决定），不能使用 `data/cards/*.json` 文件，因为文件内容是静态的。解决方案是写入 `battle.customCards`：

### 原理

`battle.customCards` 是一个普通对象 `{ [cardId: string]: CardDefinition }`，存储在战斗状态里。`addCardToHand` 会先查 `data/cards/`，找不到时再查 `battle.customCards`。`playCard` 同理。

### 用法示例（在 skillCode / skill code 中）

```javascript
// 创建一张伤害数值是动态的诅咒牌
var dynamicCardId = 'curse-ward-' + Date.now();
if (!battle.customCards) battle.customCards = {};
battle.customCards[dynamicCardId] = {
  id: dynamicCardId,
  name: '诅咒',
  description: '消耗2AP来打出。当此牌在手牌中时，每回合结束时对随机友方棋子造成' + blockedDamage + '点伤害',
  type: 'active',
  actionPointCost: 2,
  icon: '💀',
  damageAmount: blockedDamage,   // 可在卡牌代码中通过 battle.customCards[cardId].damageAmount 读取
  code: '...'
};
addCardToHand(dynamicCardId, opponentPlayerId);
```

### 注意事项

- `customCards` 里的 `code` 字段同样是 `function executeCard(context) { ... }` 格式
- 卡牌代码中可通过 `battle.customCards[context.cardId]` 读取自定义字段（如 `damageAmount`）
- `actionPointCost` 会自动复制到手牌实例，并由 `playCard` 系统检查/扣除

---

## 玩家级 endTurn 规则注意事项

玩家级规则（`player.rules[]`）的 `endTurn` 触发器会在**每一个玩家回合结束时**对所有玩家的规则全部扫描。如果效果只应在某位玩家自己的回合结束时触发，必须在 `skillCode` 或技能 `code` 中加守卫：

```javascript
// 在 skillCode / skill code 中
var playerId = context.playerId;

// 关键守卫：只有当前回合玩家才执行
if (battle.turn.currentPlayerId !== playerId) {
  return { success: false };
}

// ... 实际效果
```

**原因**：`checkTriggers` 会同时遍历红方和蓝方的 `player.rules`，双方各自的 `endTurn` 规则在任意回合结束时都会被尝试触发。没有守卫的话，持有诅咒的玩家在对方回合结束时也会触发诅咒伤害。

---

## 完整示例：拉法姆诅咒系统

本示例展示了以下功能的综合运用：
- `beforeDamageTaken` 伤害免疫 + 阻止时的自定义消息
- 动态自定义手牌（`battle.customCards`）
- 玩家级规则 + endTurn 守卫
- 运行时修改手牌 AP 消耗（诅咒增幅）

### 技能1：诅咒结界（data/skills/rafaam-curse-ward.json）

被动技能，挂在拉法姆棋子上。拦截对自身的伤害，并向伤害来源的对手塞入一张带有等值伤害的诅咒手牌，同时为对手注册 `rule-rafaam-curse-end-turn` 玩家规则。

```json
{
  "id": "rafaam-curse-ward",
  "name": "诅咒结界",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 0,
  "code": "function executeSkill(context) { ... }"
}
```

- 触发规则：`rule-rafaam-curse-ward.json`，`trigger: { type: 'beforeDamageTaken' }`
- `skillCode` 返回 `{ success: true, blocked: true, message: '诅咒结界触发...' }` 阻止伤害
- 同时调用 `addCardToHand(dynamicCardId, opponentPlayerId)` 并写入 `battle.customCards`
- 调用 `addPlayerRuleById(opponentPlayerId, 'rule-rafaam-curse-end-turn')` 注册回合结束伤害

### 技能2：诅咒增幅（data/skills/rafaam-curse-amplify.json）

充能主动技能（`type: "super"`），消耗2AP、2充能点。遍历对手手牌，将所有名称包含"诅咒"的手牌实例的 `actionPointCost` 改为 10。

```json
{
  "id": "rafaam-curse-amplify",
  "type": "super",
  "actionPointCost": 2,
  "chargeCost": 2,
  "cooldownTurns": 1
}
```

手牌实例上的 `actionPointCost` 是可修改的独立字段，修改后 `playCard` 系统会读取并强制执行新的 AP 消耗。

### 规则：诅咒回合伤害（data/rules/rule-rafaam-curse-end-turn.json）

玩家级规则，`trigger: { type: 'endTurn' }`，带 `currentPlayerId` 守卫。每回合结束时检查持有者手牌，对每张诅咒牌向随机友方棋子造成伤害。手牌中没有诅咒时自我移除。

```javascript
// skillCode 中的关键结构
var playerId = context.playerId;
if (battle.turn.currentPlayerId !== playerId) return { success: false };

var curseCards = player.hand.filter(function(c) { return c.name && c.name.indexOf('诅咒') >= 0; });
if (curseCards.length === 0) {
  player.rules = player.rules.filter(function(r) { return r.id !== 'rule-rafaam-curse-end-turn'; });
  return { success: false };
}
// 对每张诅咒牌造成伤害...
```

### 手牌系统 AP 消耗流程

```
playCard 被调用
  → 从手牌实例读取 cardInstance.actionPointCost（可能已被诅咒增幅改为10）
  → 检查 playerMeta.actionPoints >= cardApCost
  → 执行 executeCard()
  → playerMeta.actionPoints -= cardApCost
  → 弃置手牌
```
