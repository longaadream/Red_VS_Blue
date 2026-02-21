# 游戏技能系统教程

## 目录

1. [基础概念](#基础概念)
2. [技能定义](#技能定义)
3. [技能执行上下文](#技能执行上下文)
4. [伤害处理函数](#伤害处理函数)
5. [触发规则](#触发规则)
6. [实现步骤](#实现步骤)
7. [示例技能](#示例技能)
8. [状态系统](#状态系统)
9. [目标选择器系统](#目标选择器系统)
10. [技能JSON文件标准格式](#技能json文件标准格式)
11. [故障排除](#故障排除)
12. [总结](#总结)

## 基础概念

### 什么是条件技能？
条件技能是指在满足特定条件时自动触发的技能，例如：
- 当受到伤害时，发动反击
- 当击杀敌人时，获得生命值
- 当回合开始时，增加攻击力

### 实现原理
条件技能通过两个部分实现：
1. **技能定义**：在 `data/skills/` 目录下创建技能JSON文件
2. **触发规则**：在 `data/rules/` 目录下创建规则JSON文件

## 技能定义

### 技能文件格式
在 `data/skills/` 目录下创建 `.json` 文件，格式如下：

```json
{
  "id": "技能ID",
  "name": "技能名称",
  "description": "技能描述",
  "kind": "passive", // 被动技能
  "type": "normal",
  "form": "melee", // 技能形态：melee=近战, ranged=远程, magic=魔法, projectile=飞行物, area=范围, self=自身
  "cooldownTurns": 冷却回合数,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { \n  // 技能执行逻辑\n  const piece = context.piece;\n  // 在这里实现具体的技能效果\n  return { message: '技能已激活', success: true };\n}",
  "range": "self",
  "actionPointCost": 1 // 行动点消耗
}
```

### 字段说明
- `id`：技能唯一标识符，使用小写字母和连字符
- `name`：技能显示名称
- `description`：技能描述，说明触发条件和效果
- `kind`：技能类型，被动技能使用 `passive`，主动技能使用 `active`
- `type`：技能类型，普通技能使用 `normal`，充能技能使用 `super`
- `form`：技能形态，可选值：`melee`（近战）、`ranged`（远程）、`magic`（魔法）、`projectile`（飞行物）、`area`（范围）、`self`（自身）
- `cooldownTurns`：冷却回合数，0表示无冷却
- `actionPointCost`：行动点消耗，使用技能时会扣除相应的行动点
- `code`：技能执行代码，**所有技能效果都必须通过代码实现**，包括主动技能和被动技能
- `range`：技能范围，`self`（自身）、`single`（单体）、`area`（范围）

## 技能执行上下文 (Context)

### Context 对象结构
当技能执行时，系统会传入一个 `context` 对象，包含以下信息：

```javascript
{
  piece: {
    instanceId: "棋子实例ID",
    templateId: "棋子模板ID",
    ownerPlayerId: "所有者玩家ID",
    currentHp: 当前生命值,
    maxHp: 最大生命值,
    attack: 攻击力,
    defense: 防御力,
    x: X坐标,
    y: Y坐标,
    moveRange: 移动范围
  },
  target: {
    // 目标棋子信息，格式同 piece
    // 仅在特定触发事件中存在，如 afterDamageDealt、afterDamageTaken
  },
  battle: {
    turn: 当前回合数,
    currentPlayerId: 当前玩家ID,
    phase: 当前回合阶段,
    pieces: [
      // 所有棋子信息，格式同 piece
    ]
  },
  skill: {
    id: "技能ID",
    name: "技能名称",
    type: "技能类型",
    powerMultiplier: 威力系数
  }
}
```

### 触发事件与 Context 信息
不同的触发事件会在 `context` 对象中传入不同的信息，技能代码可以通过这些信息获取触发事件的详细数据：

| 触发类型 | 传入的 Context 信息 | 技能代码中如何获取 |
|---------|-------------------|-------------------|
| `afterDamageDealt` | `piece`（攻击者）, `target`（被攻击者）, `damage`（伤害值） | `context.piece`（攻击者）, `context.target`（被攻击者）, `context.damage`（伤害值） |
| `afterDamageTaken` | `piece`（被攻击者）, `target`（攻击者）, `damage`（伤害值） | `context.piece`（被攻击者）, `context.target`（攻击者）, `context.damage`（伤害值） |
| `afterPieceKilled` | `piece`（击杀者）, `target`（被杀者） | `context.piece`（击杀者）, `context.target`（被杀者） |
| `beforePieceKilled` | `piece`（即将被杀者）, `target`（攻击者） | `context.piece`（即将被杀者）, `context.target`（攻击者） |
| `afterPieceSummoned` | `piece`（召唤者）, `target`（被召唤者） | `context.piece`（召唤者）, `context.target`（被召唤者） |
| `beforePieceSummoned` | `piece`（召唤者） | `context.piece`（召唤者） |
| `beginTurn` | `piece`（当前回合玩家的棋子）, `turnNumber`（回合数）, `playerId`（玩家ID） | `context.piece`（当前棋子）, `context.turnNumber`（回合数）, `context.playerId`（玩家ID） |
| `endTurn` | `piece`（当前回合玩家的棋子）, `turnNumber`（回合数）, `playerId`（玩家ID） | `context.piece`（当前棋子）, `context.turnNumber`（回合数）, `context.playerId`（玩家ID） |
| `afterMove` | `piece`（移动的棋子）, `playerId`（玩家ID） | `context.piece`（移动的棋子）, `context.playerId`（玩家ID） |
| `beforeMove` | `piece`（即将移动的棋子） | `context.piece`（即将移动的棋子） |
| `beforeSkillUse` | `piece`（即将释放技能的棋子）, `skillId`（技能ID） | `context.piece`（即将释放技能的棋子）, `context.skillId`（技能ID） |
| `beforeAttack` | `piece`（即将攻击的棋子） | `context.piece`（即将攻击的棋子） |
| `afterSkillUsed` | `piece`（使用技能的棋子）, `skillId`（技能ID）, `playerId`（玩家ID） | `context.piece`（使用技能的棋子）, `context.skillId`（技能ID）, `context.playerId`（玩家ID） |
| `whenever` | 根据触发时机不同，可能包含上述所有信息 | 根据具体情况获取相应信息 |

### 详细示例：如何在技能中获取死亡玩家信息
当使用 `afterPieceKilled` 触发器时，你需要在技能代码中通过 `context.battle.pieces` 来查找相关信息：

```javascript
function executeSkill(context) {
  // 获取击杀者信息
  const killer = context.piece;
  
  // 示例：根据击杀者的属性增加其能力
  const bonus = Math.floor(killer.maxHp * 0.1);
  killer.attack += bonus;
  killer.defense += bonus;
  
  return { 
    message: killer.templateId + '击杀了敌人，获得了' + bonus + '点攻击力和防御力', 
    success: true 
  };
}
```

## 伤害处理函数

为了简化伤害处理并确保所有伤害相关的触发器都能正确触发，我们提供了 `dealDamage` 函数。这个函数会处理伤害计算（包括防御力）、应用伤害、触发相关触发器等逻辑。

### 函数签名

```typescript
/**
 * 伤害类型
 */
type DamageType = "physical" | "magical" | "true"

/**
 * 处理伤害计算和应用的函数
 * @param attacker 攻击者棋子
 * @param target 目标棋子
 * @param baseDamage 基础伤害值
 * @param damageType 伤害类型
 * @param battle 战斗状态
 * @param skillId 技能ID（可选）
 * @returns 伤害结果
 */
dealDamage(attacker: PieceInstance, target: PieceInstance, baseDamage: number, damageType: DamageType, battle: BattleState, skillId?: string): {
  success: boolean;
  damage: number;
  isKilled: boolean;
  targetHp: number;
  message: string;
}
```

### 使用示例

在技能代码中，你可以通过 `dealDamage` 函数来处理伤害：

```javascript
function executeSkill(context) {
  // 选择最近的敌人
  const targetEnemy = select.getNearestEnemy();
  if (!targetEnemy) {
    return { message: '没有可攻击的敌人', success: false };
  }
  
  // 计算基础伤害
  const baseDamage = context.piece.attack * context.skill.powerMultiplier;
  
  // 使用dealDamage函数处理伤害 - 物理伤害
  const damageResult = dealDamage(context.piece, targetEnemy, baseDamage, 'physical', context.battle, 'basic-attack');
  
  return {
    message: damageResult.message,
    success: damageResult.success
  };
}
```

### 不同伤害类型的使用示例

```javascript
// 物理伤害（受到防御力影响）
dealDamage(context.piece, targetEnemy, baseDamage, 'physical', context.battle, 'basic-attack');

// 法术伤害（受到魔法抗性影响，暂时使用防御力代替）
dealDamage(context.piece, targetEnemy, baseDamage, 'magical', context.battle, 'fireball');

// 真实伤害（不受防御力影响）
dealDamage(context.piece, targetEnemy, baseDamage, 'true', context.battle, 'true-damage');
```

### 函数功能说明

1. **伤害计算**：
   - **物理伤害**：受到防御力影响，公式 `最终伤害 = 基础伤害 - 目标防御力`
   - **法术伤害**：受到魔法抗性影响（暂时使用防御力代替），公式 `最终伤害 = 基础伤害 - 目标防御力`
   - **真实伤害**：不受防御力影响，公式 `最终伤害 = 基础伤害`
   - 所有伤害类型至少造成1点伤害

2. **伤害应用**：更新目标的生命值，确保至少剩余0点
3. **触发器触发**：
   - 触发攻击者的 `afterDamageDealt` 触发器
   - 触发目标的 `afterDamageTaken` 触发器
   - 如果目标被击杀，触发 `afterPieceKilled` 触发器
4. **击杀奖励**：击杀敌人后，为攻击者的玩家增加1点充能点
5. **返回结果**：包含伤害值、是否击杀、目标剩余生命值等信息

## 触发规则

### 规则文件格式
在 `data/rules/` 目录下创建 `.json` 文件，格式如下：

```json
{
  "id": "规则ID",
  "name": "规则名称",
  "description": "规则描述",
  "trigger": {
    "type": "触发类型",
    "conditions": {
      "条件1": "值1",
      "条件2": "值2"
    }
  },
  "effect": {
    "type": "效果类型",
    "target": "目标类型",
    "属性1": "值1",
    "属性2": "值2",
    "message": "效果消息"
  },
  "limits": {
    "cooldownTurns": 冷却回合数,
    "maxUses": 最大使用次数
  }
}
```

### 触发类型

| 触发类型 | 描述 |
|---------|------|
| `afterSkillUsed` | 技能使用后 |
| `afterDamageDealt` | 造成伤害后 |
| `afterDamageTaken` | 受到伤害后 |
| `afterPieceKilled` | 击杀棋子后 |
| `afterPieceSummoned` | 召唤棋子后 |
| `beginTurn` | 回合开始时 |
| `endTurn` | 回合结束时 |
| `afterMove` | 移动后 |
| `whenever` | 每一步行动后检测，用于实现"每当……，……"的效果 |

### 目标类型

| 目标类型 | 描述 |
|---------|------|
| `source` | 源角色（触发规则的角色） |
| `target` | 目标角色 |
| `all` | 所有角色 |
| `area` | 范围内的角色（需要指定 `range` 属性） |

### 动态值

效果值可以使用动态值，例如：
- `source.attack`：源角色的攻击力
- `source.maxHp`：源角色的最大生命值
- `target.attack`：目标角色的攻击力
- `target.maxHp`：目标角色的最大生命值
- `damage`：造成的伤害值

### 消息模板

消息可以使用模板字符串，例如：
- `${source.templateId}`：源角色的模板ID
- `${target.templateId}`：目标角色的模板ID
- `${source.attack}`：源角色的攻击力
- `${target.maxHp}`：目标角色的最大生命值

## 实现步骤

### 步骤1：创建技能文件

1. 在 `data/skills/` 目录下创建技能JSON文件
2. 填写技能的基本信息
3. 设置为被动技能（`kind: "passive"`）

### 步骤2：创建规则文件

1. 在 `data/rules/` 目录下创建规则JSON文件
2. 填写规则的基本信息
3. 定义触发条件
4. 定义效果
5. 设置限制（如冷却）

### 步骤3：装备技能

将技能分配给角色，在角色的 `skills` 数组中添加技能：

```json
"skills": [
  {
    "skillId": "技能ID",
    "level": 1
  }
]
```

## 示例技能

### 示例1：主动技能 - 火球术

实现"对单个目标造成150%攻击力的伤害"的主动技能。

#### 步骤1：创建技能文件

创建 `data/skills/fireball.json`：

```json
{
  "id": "fireball",
  "name": "火球术",
  "description": "对单个目标造成150%攻击力的伤害",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 2,
  "maxCharges": 0,
  "powerMultiplier": 1.5,
  "code": "function executeSkill(context) { const sourcePiece = context.piece; const targetEnemy = selectTarget({ type: 'piece', range: 5, filter: 'enemy' }); if (!targetEnemy || targetEnemy.needsTargetSelection) { return targetEnemy; } const damageValue = sourcePiece.attack * context.skill.powerMultiplier; const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'magical', context.battle, context.skill.id); return { message: sourcePiece.templateId + '对' + targetEnemy.templateId + '造成' + damageResult.damage + '点伤害', success: true }; }",
  "range": "single"
}
```

### 步骤2：装备技能

将技能分配给角色，在角色的 `skills` 数组中添加技能：

```json
"skills": [
  {
    "skillId": "basic-attack",
    "level": 1
  },
  {
    "skillId": "fireball",
    "level": 1
  }
]
```

### 示例2：被动技能 - 反击

实现"当受到伤害时，选择一个3格内的目标，造成100%攻击力的伤害"的技能。

#### 步骤1：创建技能文件

创建 `data/skills/retaliation.json`：

```json
{
  "id": "retaliation",
  "name": "反击",
  "description": "当受到伤害时，选择一个3格内的目标，造成100%攻击力的伤害",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 1,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { const piece = context.piece; // 寻找3格内的敌人 const enemies = context.battle.pieces.filter(enemy => { if (enemy.ownerPlayerId === piece.ownerPlayerId || enemy.currentHp <= 0) return false; const distance = Math.abs(enemy.x - piece.x) + Math.abs(enemy.y - piece.y); return distance <= 3; }); if (enemies.length > 0) { // 选择第一个敌人并造成伤害 const target = enemies[0]; const damage = piece.attack; target.currentHp = Math.max(0, target.currentHp - damage); return { message: piece.templateId + '发动反击，对' + target.templateId + '造成' + damage + '点伤害', success: true }; } return { message: '没有敌人可以反击', success: false }; }",
  "range": "area",
  "areaSize": 3
}
```

#### 步骤2：创建规则文件

创建 `data/rules/retaliation.json`：

```json
{
  "id": "rule-4",
  "name": "反击",
  "description": "当受到伤害时，选择一个3格内的目标，造成100%攻击力的伤害",
  "trigger": {
    "type": "afterDamageTaken",
    "conditions": {
      "minDamage": 1
    }
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "retaliation",
    "message": "${source.templateId}触发了反击技能"
  },
  "limits": {
    "cooldownTurns": 1,
    "maxUses": 0
  }
}
```

### 步骤3：装备技能

在角色的JSON文件中添加技能：

```json
"skills": [
  {
    "skillId": "basic-attack",
    "level": 1
  },
  {
    "skillId": "retaliation",
    "level": 1
  }
]
```

## 状态系统

### 概述

状态系统允许你为棋子添加持续效果，如流血、中毒、燃烧等。状态效果可以通过JSON文件定义，并与rule系统联动来表示效果触发的时机。

### 状态定义文件格式

在 `data/status-effects/` 目录下创建 `.json` 文件，格式如下：

```json
{
  "id": "状态ID",
  "type": "状态类型",
  "name": "状态名称",
  "description": "状态描述",
  "intensity": 强度（用于计算效果数值）,
  "isDebuff": 是否为减益效果,
  "canStack": 是否可以叠加,
  "maxStacks": 最大叠加层数,
  "code": "// 状态效果代码\nfunction EffectTrigger(context) {\n  // 主要效果逻辑\n  return { success: true, message: '效果触发' };\n}\n"
}
```

### 代码编写规范

1. **主要效果函数**：
   - 必须使用 `EffectTrigger(context)` 函数来表示状态的主要效果
   - 该函数将在回合开始时被调用
   - 返回对象应包含 `success` 和 `message` 属性
   - 可以在函数中访问和修改状态的剩余持续时间

2. **与Rule系统联动**：
   - 状态系统会自动创建一个规则，在回合开始时触发
   - 规则会检查状态的剩余持续时间
   - 如果持续时间 > 0，执行 `EffectTrigger` 函数，然后减少持续时间
   - 如果持续时间 <= 0，自动移除状态效果和对应的规则

3. **状态标签管理**：
   - 状态系统会自动在棋子的 `statusTags` 数组中添加状态相关标签
   - 状态类型标签：如 "bleeding"、"poison" 等
   - 状态持续时间标签：如 "bleeding-duration-{effectId}" 等
   - 可以在代码中通过访问 `context.piece.statusTags` 来获取和管理状态标签

### 状态效果上下文

在 `EffectTrigger` 函数中，你可以使用 `context` 参数访问以下信息：

- `context.piece`：当前棋子实例（包含 `statusTags` 数组，存储状态相关标签）
- `context.battleState`：当前战斗状态
- `context.statusEffect`：当前状态效果（包含剩余持续时间、叠加层数等信息）
- `context.gameContext`：游戏上下文

### 访问和修改持续时间

在 `EffectTrigger` 函数中，你可以直接访问和修改状态效果的剩余持续时间：

```javascript
function EffectTrigger(context) {
  // 访问当前剩余持续时间
  console.log('剩余持续时间:', context.statusEffect.remainingDuration);
  
  // 修改持续时间（例如，延长1回合）
  context.statusEffect.remainingDuration += 1;
  
  // 执行状态效果
  const damage = context.statusEffect.intensity * context.statusEffect.currentStacks;
  context.piece.currentHp = Math.max(0, context.piece.currentHp - damage);
  
  return { success: true, message: context.piece.templateId + '受到伤害' };
}
```

### 示例：流血状态

**文件**：`data/status-effects/bleeding.json`

```json
{
  "id": "bleeding",
  "type": "bleeding",
  "name": "流血",
  "description": "每回合受到持续伤害",
  "intensity": 5,
  "isDebuff": true,
  "canStack": true,
  "maxStacks": 5,
  "code": "// 流血状态效果函数\nfunction EffectTrigger(context) {\n  const damage = context.statusEffect.intensity * context.statusEffect.currentStacks;\n  context.piece.currentHp = Math.max(0, context.piece.currentHp - damage);\n  console.log(context.piece.templateId + '受到流血伤害，失去' + damage + '点生命值');\n  return { success: true, message: context.piece.templateId + '受到流血伤害' };\n}\n"
}
```

### 在技能中使用状态效果

在技能代码中，你可以使用 `addStatusEffectById` 函数来添加状态效果。以下是一个完整的示例，展示如何创建一个技能来给目标施加流血效果：

#### 示例：出血之刃技能

**文件**：`data/skills/bleeding-blade.json`

```json
{
  "id": "bleeding-blade",
  "name": "出血之刃",
  "description": "对目标造成伤害并施加流血状态",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 2,
  "maxCharges": 0,
  "powerMultiplier": 1.2,
  "code": "function executeSkill(context) { const caster = context.piece; const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' }); if (!target || target.needsTargetSelection) { return target; } // 计算伤害 const damage = Math.round(caster.attack * context.skill.powerMultiplier); const damageResult = dealDamage(caster, target, damage, 'physical', context.battle, context.skill.id); if (damageResult.success) { addStatusEffectById(target.instanceId, 'bleeding'); } return { message: caster.templateId + '使用出血之刃，对' + target.templateId + '造成' + damage + '点伤害，并施加了流血状态', success: true }; }",
  "range": "single",
  "actionPointCost": 2
}
```

## 目标选择器系统

### 概述

目标选择器系统允许技能在执行时请求玩家选择一个目标，然后使用该目标执行技能效果。这个系统通过 `selectTarget` 函数实现，该函数可以在技能的 `code` 字段中使用。

### selectTarget 函数

#### 函数签名

```typescript
/**
 * 目标选择函数 - 用于在技能代码中唤起目标选择
 * @param options 目标选择选项
 * @returns 当需要选择目标时返回需要目标选择的结果，当已有目标时返回目标信息
 */
selectTarget(options?: {
  type: 'piece' | 'grid'; // 目标类型：piece=棋子, grid=格子
  range?: number; // 目标选择范围
  filter?: 'enemy' | 'ally' | 'all'; // 目标过滤：enemy=敌人, ally=盟友, all=所有
}): any
```

#### 函数参数

- `type`：目标类型，可选值：
  - `'piece'`：选择一个棋子
  - `'grid'`：选择一个格子
- `range`：目标选择范围，默认值为 5
- `filter`：目标过滤，可选值：
  - `'enemy'`：只显示敌人
  - `'ally'`：只显示盟友
  - `'all'`：显示所有棋子

#### 函数返回值

- 当需要选择目标时：返回一个包含 `needsTargetSelection: true` 的对象，触发前端的目标选择界面
- 当已有目标时：返回目标信息：
  - 选择棋子时：返回棋子实例
  - 选择格子时：返回格子的位置信息 `{ x: number, y: number }`

### 使用示例

#### 示例1：选择棋子作为目标

```javascript
function executeSkill(context) {
  // 获取施法者棋子
  const sourcePiece = context.piece;
  // 使用selectTarget函数获取目标棋子
  const targetEnemy = selectTarget({ type: 'piece', range: 5, filter: 'enemy' });
  
  // 检查是否成功获取目标
  if (!targetEnemy || targetEnemy.needsTargetSelection) {
    return targetEnemy;
  }
  
  // 执行技能效果
  const damageValue = sourcePiece.attack * context.skill.powerMultiplier;
  const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'magical', context.battle, context.skill.id);
  
  return {
    message: sourcePiece.templateId + '对' + targetEnemy.templateId + '造成' + damageResult.damage + '点伤害',
    success: true
  };
}
```

#### 示例2：选择格子作为目标

```javascript
function executeSkill(context) {
  // 获取施法者棋子
  const sourcePiece = context.piece;
  // 使用selectTarget函数获取目标格子
  const targetPos = selectTarget({ type: 'grid', range: 10, filter: 'all' });
  
  // 检查是否成功获取目标
  if (!targetPos || targetPos.needsTargetSelection) {
    return targetPos;
  }
  
  // 执行技能效果（例如传送）
  sourcePiece.x = targetPos.x;
  sourcePiece.y = targetPos.y;
  
  return {
    message: sourcePiece.templateId + '传送到了(' + targetPos.x + ',' + targetPos.y + ')',
    success: true
  };
}
```

### 实现原理

1. **技能执行**：当技能代码调用 `selectTarget` 函数时，函数会检查是否已经有目标信息
2. **目标选择请求**：如果没有目标信息，函数返回一个包含 `needsTargetSelection: true` 的对象，触发前端的目标选择界面
3. **前端目标选择**：玩家在前端界面中选择一个目标（棋子或格子）
4. **重新执行技能**：前端将选择的目标信息发送回服务器，服务器重新执行技能代码
5. **目标信息获取**：这次 `selectTarget` 函数会直接返回目标信息，技能代码继续执行并应用技能效果

### 注意事项

1. **移除 requiresTarget 标签**：使用 `selectTarget` 函数后，不需要在技能文件中添加 `requiresTarget: true` 标签，因为 `selectTarget` 函数会自动处理目标选择的需求

2. **JSON 文件格式**：技能文件必须是有效的 JSON 文件，不能包含实际的换行符，需要使用转义的 `\n` 表示换行

3. **错误处理**：在技能代码中，必须检查 `selectTarget` 函数的返回值，确保目标选择成功后再执行技能效果

4. **目标类型区分**：根据技能的需求，选择合适的目标类型：
   - 需要选择一个具体棋子时，使用 `type: 'piece'`
   - 需要选择一个位置时，使用 `type: 'grid'`

### 完整示例：冰霜箭技能

```json
{"id":"frostbolt","name":"冰霜箭","description":"对5格内一个敌人造成当前攻击力的伤害和1回合冰冻","icon":"❄️","kind":"active","type":"normal","cooldownTurns":1,"maxCharges":0,"powerMultiplier":1,"actionPointCost":2,"code":"function executeSkill(context) { const sourcePiece = context.piece; const targetEnemy = selectTarget({ type: 'piece', range: 5, filter: 'enemy' }); if (!targetEnemy || targetEnemy.needsTargetSelection) { return targetEnemy; } const damageValue = sourcePiece.attack * context.skill.powerMultiplier; const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'magical', context.battle, context.skill.id); if (typeof addStatusEffectById === 'function' && damageResult.success) { addStatusEffectById(targetEnemy.instanceId, 'freeze', 1); } return { message: sourcePiece.templateId + '对' + targetEnemy.templateId + '造成' + damageResult.damage + '点伤害并使其冰冻', success: true }; }","previewCode":"function calculatePreview(piece, skillDef) { const damageValue = Math.round(piece.attack * skillDef.powerMultiplier); return { description: '对5格内一个敌人造成' + damageValue + '点伤害（相当于攻击力100%）和1回合冰冻', expectedValues: { damage: damageValue } }; }","range":"single"}
```

## 故障排除

### 技能不触发的原因

1. **规则文件不存在**：确保在 `data/rules/` 目录下创建了对应的规则文件
2. **触发条件不匹配**：检查触发类型和条件是否正确
3. **冷却未就绪**：检查规则的冷却是否已结束
4. **目标不存在**：确保目标类型和范围设置正确
5. **技能未装备**：确保角色已装备该技能

### 常见错误

1. **JSON格式错误**：确保JSON文件格式正确，没有语法错误
2. **值类型错误**：确保动态值的格式正确，例如 `target.maxHp`
3. **字段缺失**：确保所有必要的字段都已填写
4. **路径错误**：确保文件保存在正确的目录中

## 技能JSON文件标准格式

### 概述

技能JSON文件是定义游戏技能的核心文件，必须按照以下标准格式编写，以确保技能能够正确执行和与游戏系统交互。

### 标准格式

```json
{
  "id": "技能ID",
  "name": "技能名称",
  "description": "技能描述",
  "kind": "active", // 技能类型：active=主动, passive=被动
  "type": "normal", // 技能类型：normal=普通, super=充能
  "cooldownTurns": 冷却回合数,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { \n  // 技能执行逻辑\n  return { message: '技能已激活', success: true };\n}",
  "range": "single", // 技能范围：self=自身, single=单体, area=范围
  "actionPointCost": 1 // 行动点消耗
}
```

### 关键字段说明

- **id**：技能唯一标识符，使用小写字母和连字符
- **name**：技能显示名称
- **description**：技能描述，说明技能效果
- **kind**：技能类型
  - `"active"`：主动技能，需要玩家手动释放
  - `"passive"`：被动技能，自动触发
- **type**：技能类型
  - `"normal"`：普通技能
  - `"super"`：充能技能
- **cooldownTurns**：冷却回合数，0表示无冷却
- **powerMultiplier**：威力系数，用于计算技能伤害
- **code**：技能执行代码，必须使用 `executeSkill(context)` 函数
- **range**：技能范围
- **actionPointCost**：行动点消耗

### 代码编写规范

1. **Context使用规范**：
   - **仅在特定触发事件中**可以使用 `context.target`，如 `afterDamageDealt`、`afterDamageTaken`
   - **禁止**使用 `context.targetPosition`
   - 除特定触发事件外，所有目标相关的信息必须通过函数调用获取

2. **目标选择**：
   - 使用 `selectTarget` 函数进行目标选择，不要使用 `requiresTarget` 属性
   - 正确处理目标选择的返回值，检查 `needsTargetSelection`
   - 根据技能需求选择合适的目标类型：`'piece'` 或 `'grid'`

3. **伤害处理**：
   - 使用 `dealDamage` 函数处理所有伤害，确保触发器正确触发
   - 正确设置伤害类型：`'physical'`、`'magical'` 或 `'true'`

4. **状态效果**：
   - 使用 `addStatusEffectById` 函数添加状态效果
   - 正确处理状态效果的参数
   - **所有状态效果必须通过rule和effect来处理**，在合适的时机触发

5. **效果处理**：
   - **所有效果都必须通过code标签执行**，禁止使用JSON硬编码
   - 灵活性优先：设计技能时应考虑扩展性，避免硬编码固定值

6. **JSON格式**：
   - 确保文件是有效的JSON格式
   - 使用转义的 `\n` 表示换行
   - 所有字符串使用双引号

### 示例：正确的技能JSON文件

```json
{
  "id": "fireball",
  "name": "火球术",
  "description": "对单个目标造成150%攻击力的伤害",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 2,
  "maxCharges": 0,
  "powerMultiplier": 1.5,
  "code": "function executeSkill(context) { const sourcePiece = context.piece; const targetEnemy = selectTarget({ type: 'piece', range: 5, filter: 'enemy' }); if (!targetEnemy || targetEnemy.needsTargetSelection) { return targetEnemy; } const damageValue = sourcePiece.attack * context.skill.powerMultiplier; const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'magical', context.battle, context.skill.id); return { message: sourcePiece.templateId + '对敌人造成' + damageResult.damage + '点伤害', success: true }; }",
  "range": "single",
  "actionPointCost": 2
}
```

## 总结

通过本教程，你应该已经学会了如何创建条件技能、使用状态系统以及实现目标选择：

1. **条件技能系统**：
   - 创建技能文件：定义技能的基本属性和执行逻辑
   - 创建规则文件：定义触发条件和效果
   - 装备技能：将技能分配给角色

2. **状态系统**：
   - 创建状态定义文件：在JSON文件中定义状态效果
   - 使用StatusTags：表示状态类型
   - 基于StatusTags的状态管理：通过状态类型和强度计算效果
   - 状态标签管理：系统自动在棋子的statusTags数组中添加和移除状态标签
   - 访问和修改持续时间：在EffectTrigger函数中通过context.statusEffect.remainingDuration访问和修改持续时间

3. **目标选择系统**：
   - 使用selectTarget函数：在技能代码中唤起目标选择
   - 支持不同类型的目标选择：选择棋子或选择格子
   - 自动处理目标选择流程：触发前端选择界面，获取目标信息
   - 移除requiresTarget标签：使用selectTarget函数后不需要该标签

4. **技能JSON文件标准**：
   - 按照标准格式编写技能JSON文件
   - 使用正确的字段和值类型
   - 遵循代码编写规范
   - 确保JSON格式有效
   - **仅在特定触发事件中**可以使用 `context.target`，如 `afterDamageDealt`、`afterDamageTaken`
   - **禁止**使用 `context.targetPosition`
   - **所有效果都必须通过code标签执行**，禁止使用JSON硬编码
   - **所有状态效果必须通过rule和effect来处理**，在合适的时机触发

现在你可以尝试创建自己的技能、规则、状态效果和目标选择系统了！例如：

- 设计需要选择多个目标的技能
- 创建需要选择特定位置的范围技能
- 实现基于目标位置的复杂技能效果
- 设计需要特定行动点消耗的技能组合
- 创建具有复杂触发条件的状态效果

祝你游戏开发愉快！