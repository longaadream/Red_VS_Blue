游戏技能系统教程

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


## 技能执行上下文 (Context)

### Context 对象结构
当技能执行时，系统会传入一个 `context` 对象，包含以下信息：

```javascript
{
  piece: {
    instanceId: "棋子实例ID",
    templateId: "棋子模板ID",
    name: "棋子名称",
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
| `beforeDamageDealt` | `piece`（攻击者）, `target`（被攻击者）, `damage`（伤害值） | `context.piece`（攻击者）, `context.target`（被攻击者）, `context.damage`（伤害值） |
| `beforeDamageTaken` | `piece`（被攻击者）, `target`（攻击者）, `damage`（伤害值） | `context.piece`（被攻击者）, `context.target`（攻击者）, `context.damage`（伤害值） |
| `afterPieceKilled` | `piece`（击杀者）, `target`（被杀者） | `context.piece`（击杀者）, `context.target`（被杀者） |
| `beforePieceKilled` | `piece`（即将被杀者）, `target`（攻击者） | `context.piece`（即将被杀者）, `context.target`（攻击者） |
| `afterPieceSummoned` | `piece`（召唤者）, `target`（被召唤者） | `context.piece`（召唤者）, `context.target`（被召唤者） |
| `beforePieceSummoned` | `piece`（召唤者） | `context.piece`（召唤者） |
| `beginTurn` | `piece`（当前回合玩家的棋子）, `turnNumber`（回合数）, `playerId`（玩家ID） | `context.piece`（当前棋子）, `context.turnNumber`（回合数）, `context.playerId`（玩家ID） |
| `endTurn` | `piece`（当前回合玩家的棋子）, `turnNumber`（回合数）, `playerId`（玩家ID） | `context.piece`（当前棋子）, `context.turnNumber`（回合数）, `context.playerId`（玩家ID） |
| `afterMove` | `piece`（移动的棋子）, `playerId`（玩家ID） | `context.piece`（移动的棋子）, `context.playerId`（玩家ID） |
| `beforeMove` | `piece`（即将移动的棋子） | `context.piece`（即将移动的棋子） |
| `beforeSkillUse` | `piece`（即将释放技能的棋子）, `skillId`（技能ID） | `context.piece`（即将释放技能的棋子）, `context.skillId`（技能ID） |
| `afterSkillUsed` | `piece`（使用技能的棋子）, `skillId`（技能ID）, `playerId`（玩家ID） | `context.piece`（使用技能的棋子）, `context.skillId`（技能ID）, `context.playerId`（玩家ID） |
| `afterHealDealt` | `piece`（治疗者）, `target`（被治疗者）, `heal`（治疗值） | `context.piece`（治疗者）, `context.target`（被治疗者）, `context.heal`（治疗值） |
| `afterHealTaken` | `piece`（被治疗者）, `target`（治疗者）, `heal`（治疗值） | `context.piece`（被治疗者）, `context.target`（治疗者）, `context.heal`（治疗值） |
| `beforeHealDealt` | `piece`（治疗者）, `target`（被治疗者）, `heal`（治疗值） | `context.piece`（治疗者）, `context.target`（被治疗者）, `context.heal`（治疗值） |
| `beforeHealTaken` | `piece`（被治疗者）, `target`（治疗者）, `heal`（治疗值） | `context.piece`（被治疗者）, `context.target`（治疗者）, `context.heal`（治疗值） |
| `onPieceDied` | `piece`（死亡棋子本身）, `target`（造成致命一击的攻击者）, `damage`（致命伤害值） | `context.piece`（死亡棋子）, `context.target`（攻击者）, `context.damage`（伤害值）— 用于"我死亡时做X"效果 |
| `afterDamageBlocked` | `piece`（被格挡伤害的防御方）, `target`（攻击者）, `damage`（被格挡的伤害值） | `context.piece`（防御方）, `context.target`（攻击者）, `context.damage`（格挡的伤害值）— 圣盾等规则触发格挡后调用 |
| `afterHealBlocked` | `piece`（被阻止治疗的棋子）, `target`（治疗者）, `heal`（被阻止的治疗值） | `context.piece`（受治疗棋子）, `context.target`（治疗者）, `context.heal`（治疗值） |
| `afterStatusApplied` | `piece`（被施加状态的棋子）, `statusId`（状态ID）, `amount`（叠加层数） | `context.piece`（目标棋子）, `context.statusId`（状态ID）, `context.amount`（层数） |
| `afterStatusRemoved` | `piece`（被移除状态的棋子）, `statusId`（状态ID） | `context.piece`（目标棋子）, `context.statusId`（状态ID） |
| `afterChargeGained` | `piece`（获得充能的棋子）, `playerId`（玩家ID）, `amount`（充能获得量） | `context.piece`（棋子）, `context.playerId`（玩家ID）, `context.amount`（充能量） |
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
    message: killer.name + '击杀了敌人，获得了' + bonus + '点攻击力和防御力', 
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

## 治疗处理函数

为了简化治疗处理并确保所有治疗相关的触发器都能正确触发，我们提供了 `healDamage` 函数。这个函数会处理治疗计算、应用治疗、触发相关触发器等逻辑。

### 函数签名

```typescript
/**
 * 处理治疗计算和应用的函数
 * @param healer 治疗者棋子
 * @param target 目标棋子
 * @param baseHeal 基础治疗值
 * @param battle 战斗状态
 * @param skillId 技能ID（可选）
 * @returns 治疗结果
 */
healDamage(healer: PieceInstance, target: PieceInstance, baseHeal: number, battle: BattleState, skillId?: string): {
  success: boolean;
  heal: number;
  targetHp: number;
  message: string;
}
```

### 使用示例

#### 处理伤害

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

#### 处理治疗

在技能代码中，你可以通过 `healDamage` 函数来处理治疗：

```javascript
function executeSkill(context) {
  // 选择最近的盟友
  const targetAlly = select.getLowestHpAlly();
  if (!targetAlly) {
    return { message: '没有可治疗的盟友', success: false };
  }
  
  // 计算基础治疗值
  const baseHeal = 5;
  
  // 使用healDamage函数处理治疗
  const healResult = healDamage(context.piece, targetAlly, baseHeal, context.battle, 'heal-skill');
  
  return {
    message: healResult.message,
    success: healResult.success
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
   - 触发攻击者的 `beforeDamageDealt` 触发器（可阻止）
   - 触发目标的 `beforeDamageTaken` 触发器（可阻止）
   - 若伤害被规则格挡（如圣盾），触发 `afterDamageBlocked` 触发器并返回
   - 若伤害未被格挡，触发攻击者的 `afterDamageDealt` 触发器
   - 若伤害未被格挡，触发目标的 `afterDamageTaken` 触发器
   - 如果目标被击杀，触发 `afterPieceKilled` 触发器（攻击者视角）和 `onPieceDied` 触发器（死亡棋子自身视角）
4. **击杀奖励**：击杀敌人后，为攻击者的玩家增加1点充能点，并触发 `afterChargeGained` 触发器
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
    "type": "触发类型"
  },
  "effect": {
    "type": "效果类型",
    "target": "目标类型",
    "属性1": "值1",
    "属性2": "值2",
    "message": "效果消息"
  }
}
```

### 规则与棋子实例绑定

**重要更新**：根据新的实现，规则现在与棋子实例绑定，而不是全局加载。这意味着：

- 规则只在需要时为特定棋子加载
- 游戏进行时可以动态添加和移除规则
- 规则与棋子生命周期绑定，棋子离场时规则也会被清理
- 减少了内存占用，提高了系统性能

### 规则管理函数

在技能代码中，可以使用以下函数来管理规则：

1. **添加规则**：`addRuleById(targetPieceId, ruleId)`
   - `targetPieceId`：目标棋子的实例ID
   - `ruleId`：要添加的规则ID
   - 用于为棋子实例添加规则

2. **移除规则**：`removeRuleById(targetPieceId, ruleId)`
   - `targetPieceId`：目标棋子的实例ID
   - `ruleId`：要移除的规则ID
   - 用于从棋子实例移除规则

### 条件判断规范

**重要更新**：根据新的标准，所有的除了时机以外的判断都应该在技能代码里面用if语句实现，而不是在规则的trigger.conditions中定义。

**原因**：
- 提高代码的灵活性和可读性
- 便于实现复杂的条件逻辑
- 统一条件判断的处理方式
- 减少规则文件的复杂度

**正确的做法**：
1. 在规则文件中只定义触发时机（trigger.type）
2. 在技能代码中使用if语句实现所有条件判断
3. 如果条件不满足，返回success: false

**示例**：

#### 规则文件（只定义时机）
```json
{
  "id": "rule-counter-attack",
  "name": "反击规则",
  "description": "当受到伤害时，发动反击",
  "trigger": {
    "type": "afterDamageTaken"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "counter-attack",
    "message": "${source.name}触发了反击技能"
  }
}
```

#### 技能文件（在代码中实现条件判断）
```javascript
function executeSkill(context) {
  // 获取被攻击者信息
  const defender = context.piece;
  // 获取攻击者信息
  const attacker = context.target;
  // 获取伤害值
  const damage = context.damage;
  
  // 条件判断：只有当伤害大于0且攻击者存在时才发动反击
  if (damage <= 0 || !attacker || attacker.currentHp <= 0) {
    return { message: '反击条件不满足', success: false };
  }
  
  // 计算反击伤害
  const counterDamage = Math.floor(defender.attack * 0.8);
  
  // 应用反击伤害
  attacker.currentHp = Math.max(0, attacker.currentHp - counterDamage);
  
  return { 
    message: defender.name + '发动反击，对' + attacker.name + '造成' + counterDamage + '点伤害', 
    success: true 
  };
}
```

### 示例：为棋子添加圣盾规则

#### 技能文件（添加圣盾状态和规则）
```javascript
function executeSkill(context) {
  const sourcePiece = context.piece;
  const targetAlly = selectTarget({ type: 'piece', range: 7, filter: 'ally' });
  
  if (!targetAlly || targetAlly.needsTargetSelection) {
    return targetAlly;
  }
  
  // 添加圣盾状态
  if (typeof addStatusEffectById === 'function') {
    addStatusEffectById(targetAlly.instanceId, {
      id: 'divine-shield',
      type: 'divine-shield',
      currentDuration: -1,
      currentUses: -1,
      intensity: 1,
      stacks: 1
    });
  }
  
  // 添加对应的规则
  if (typeof addRuleById === 'function') {
    addRuleById(targetAlly.instanceId, 'rule-divine-shield');
  }
  
  return {
    message: sourcePiece.name + '为' + targetAlly.name + '施加了圣盾',
    success: true
  };
}
```

#### 技能文件（圣盾防御效果）
```javascript
function executeSkill(context) {
  const piece = context.piece;
  const damage = context.damage;
  
  let hasDivineShield = false;
  if (piece.statusTags) {
    hasDivineShield = piece.statusTags.some(tag => tag.type === 'divine-shield');
  }
  
  if (!hasDivineShield) {
    if (typeof removeSkillById === 'function') {
      removeSkillById(piece.instanceId, 'divine-shield-defense');
    }
    return { success: true, blocked: false, message: '' };
  }
  
  if (!damage || damage <= 0) {
    return { success: true, blocked: false, message: '没有伤害需要抵挡' };
  }
  
  // 移除圣盾状态
  if (typeof removeStatusEffectById === 'function') {
    removeStatusEffectById(piece.instanceId, 'divine-shield');
  }
  
  // 移除对应的规则，防止内存占用过大
  if (typeof removeRuleById === 'function') {
    removeRuleById(piece.instanceId, 'rule-divine-shield');
  }
  
  const attacker = context.target ? context.target.name : '未知敌人';
  return {
    success: true,
    blocked: true,
    message: piece.name + '的圣盾破裂，抵挡了来自于' + attacker + '的伤害'
  };
}
```

## 阻止行动的规则

### 概述

规则系统现在支持通过返回 `blocked: true` 来阻止特定的游戏行动，如移动、技能使用、伤害和治疗。这提供了一种灵活的方式来实现各种限制效果，如冰冻、沉默等状态。

### 如何使用

在规则的技能代码中，通过在返回对象中添加 `blocked: true` 来阻止行动：

```javascript
function executeSkill(context) {
  // 检查条件
  if (context.piece.statusTags.includes('frozen')) {
    // 阻止行动
    return {
      message: context.piece.name + '被冰冻，无法行动',
      success: true,
      blocked: true
    };
  }
  return {
    message: '行动允许',
    success: true
  };
}
```

### 可阻止的行动类型

| 触发类型 | 可阻止的行动 |
|---------|------------|
| `beforeMove` | 移动行动 |
| `beforeSkillUse` | 技能使用行动 |
| `beforeDamageDealt` | 造成伤害行动 |
| `beforeDamageTaken` | 受到伤害行动 |
| `beforeHealDealt` | 造成治疗行动 |
| `beforeHealTaken` | 受到治疗行动 |

### 示例：冰冻状态阻止行动

#### 步骤1：创建技能文件

创建 `data/skills/freeze-prevent.json`：

```json
{
  "id": "freeze-prevent",
  "name": "冰冻阻止",
  "description": "被冰冻时无法行动",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { if (context.piece.statusTags && context.piece.statusTags.some(tag => tag.type === 'frozen')) { return { message: context.piece.name + '被冰冻，无法行动', success: true, blocked: true }; } return { message: '行动允许', success: true }; }",
  "actionPointCost": 0
}
```

#### 步骤2：创建规则文件

创建 `data/rules/freeze-prevent-move.json`：

```json
{
  "id": "rule-freeze-prevent-move",
  "name": "冰冻阻止移动",
  "description": "被冰冻时无法移动",
  "trigger": {
    "type": "beforeMove"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "freeze-prevent",
    "message": "${source.name}被冰冻，无法移动"
  }
}
```

创建 `data/rules/freeze-prevent-skill.json`：

```json
{
  "id": "rule-freeze-prevent-skill",
  "name": "冰冻阻止技能",
  "description": "被冰冻时无法使用技能",
  "trigger": {
    "type": "beforeSkillUse"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "freeze-prevent",
    "message": "${source.name}被冰冻，无法使用技能"
  }
}
```

#### 步骤3：在技能中添加冰冻状态和规则

```javascript
function executeSkill(context) {
  const sourcePiece = context.piece;
  const targetEnemy = selectTarget({ type: 'piece', range: 5, filter: 'enemy' });
  
  if (!targetEnemy || targetEnemy.needsTargetSelection) {
    return targetEnemy;
  }
  
  // 计算伤害
  const damageValue = sourcePiece.attack * context.skill.powerMultiplier;
  const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'magical', context.battle, context.skill.id);
  
  // 添加冰冻状态
  if (typeof addStatusEffectById === 'function' && damageResult.success) {
    addStatusEffectById(targetEnemy.instanceId, {
      id: 'freeze',
      type: 'freeze',
      currentDuration: 1,
      currentUses: -1,
      intensity: 1,
      stacks: 1
    });
  }
  
  // 添加对应的规则
  if (typeof addRuleById === 'function' && damageResult.success) {
    addRuleById(targetEnemy.instanceId, 'rule-freeze-prevent-move');
    addRuleById(targetEnemy.instanceId, 'rule-freeze-prevent-skill');
  }
  
  return {
    message: sourcePiece.name + '对' + targetEnemy.name + '造成' + damageResult.damage + '点伤害并使其冰冻',
    success: damageResult.success
  };
}
```

### 触发类型

#### 伤害类

| 触发类型 | 描述 | 可阻止 |
|---------|------|--------|
| `beforeDamageDealt` | 即将造成伤害前（攻击者视角） | 是 |
| `afterDamageDealt` | 造成伤害后（攻击者视角） | 否 |
| `beforeDamageTaken` | 即将受到伤害前（防御者视角） | 是 |
| `afterDamageTaken` | 受到伤害后（防御者视角） | 否 |
| `afterDamageBlocked` | 伤害被规则/护盾格挡后（如圣盾触发时） | 否 |

#### 治疗类

| 触发类型 | 描述 | 可阻止 |
|---------|------|--------|
| `beforeHealDealt` | 即将造成治疗前 | 是 |
| `afterHealDealt` | 造成治疗后 | 否 |
| `beforeHealTaken` | 即将受到治疗前 | 是 |
| `afterHealTaken` | 受到治疗后 | 否 |
| `afterHealBlocked` | 治疗被规则格挡后 | 否 |

#### 棋子类

| 触发类型 | 描述 | 可阻止 |
|---------|------|--------|
| `afterPieceKilled` | 击杀棋子后（击杀者视角） | 否 |
| `beforePieceKilled` | 即将击杀棋子前 | 否 |
| `onPieceDied` | 棋子死亡时（**死亡棋子自身**视角，用于"我死亡时做X"效果） | 否 |
| `afterPieceSummoned` | 召唤棋子后 | 否 |
| `beforePieceSummoned` | 即将召唤棋子前 | 否 |

#### 技能类

| 触发类型 | 描述 | 可阻止 |
|---------|------|--------|
| `beforeSkillUse` | 即将使用技能前 | 是 |
| `afterSkillUsed` | 技能使用后 | 否 |

#### 移动类

| 触发类型 | 描述 | 可阻止 |
|---------|------|--------|
| `beforeMove` | 即将移动前 | 是 |
| `afterMove` | 移动后 | 否 |

#### 回合类

| 触发类型 | 描述 | 可阻止 |
|---------|------|--------|
| `beginTurn` | 回合开始时 | 否 |
| `endTurn` | 回合结束时 | 否 |

#### 状态与充能类

| 触发类型 | 描述 | Context 附加字段 |
|---------|------|-----------------|
| `afterStatusApplied` | 状态效果被施加到棋子后 | `statusId`（状态ID）, `amount`（层数） |
| `afterStatusRemoved` | 状态效果从棋子移除后 | `statusId`（状态ID） |
| `afterChargeGained` | 充能点获得后 | `amount`（获得量）, `playerId`（玩家ID） |

#### 通用

| 触发类型 | 描述 |
|---------|------|
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
- `${source.name}`：源角色的名称
- `${target.name}`：目标角色的名称
- `${source.attack}`：源角色的攻击力
- `${target.maxHp}`：目标角色的最大生命值

## 实现步骤

### 步骤1：创建技能文件

1. 在 `data/skills/` 目录下创建技能JSON文件
2. 填写技能的基本信息
3. 设置为被动技能（`kind: "passive"`）
4. 在 `code` 字段中实现所有条件判断和技能效果

### 步骤2：创建规则文件

1. 在 `data/rules/` 目录下创建规则JSON文件
2. 填写规则的基本信息
3. 只定义触发时机（`trigger.type`）
4. 定义效果
5. **移除所有 limits 标签**，所有条件判断都在技能代码中用if语句实现

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
  "code": "function executeSkill(context) { const sourcePiece = context.piece; const targetEnemy = selectTarget({ type: 'piece', range: 5, filter: 'enemy' }); if (!targetEnemy || targetEnemy.needsTargetSelection) { return targetEnemy; } const damageValue = sourcePiece.attack * context.skill.powerMultiplier; const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'magical', context.battle, context.skill.id); return { message: sourcePiece.name + '对' + targetEnemy.name + '造成' + damageResult.damage + '点伤害', success: true }; }"
}
```

### 示例2：主动技能 - 圣光术

实现"为7格内一个友军施加圣盾，抵挡一次伤害"的主动技能。

#### 步骤1：创建技能文件

创建 `data/skills/shield-of-light.json`：

```json
{
  "id": "shield-of-light",
  "name": "圣光术",
  "description": "为7格内一个友军施加圣盾，抵挡一次伤害",
  "icon": "✨",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 2,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "actionPointCost": 2,
  "code": "function executeSkill(context) { const sourcePiece = context.piece; const targetAlly = selectTarget({ type: 'piece', range: 7, filter: 'ally' }); if (!targetAlly || targetAlly.needsTargetSelection) { return targetAlly; } if (typeof addStatusEffectById === 'function') { addStatusEffectById(targetAlly.instanceId, { id: 'divine-shield', type: 'divine-shield', currentDuration: -1, currentUses: -1, intensity: 1, stacks: 1 }); } if (typeof addRuleById === 'function') { addRuleById(targetAlly.instanceId, 'rule-divine-shield'); } return { message: sourcePiece.name + '为' + targetAlly.name + '施加了圣盾', success: true }; }",
  "previewCode": "function calculatePreview(piece, skillDef) { return { description: '为7格内一个友军施加圣盾，抵挡一次伤害', expectedValues: {} }; }"
}
```

### 步骤2：创建圣盾状态效果文件

创建 `data/status-effects/divine-shield.json`：

```json
{
  "id": "divine-shield",
  "type": "divine-shield",
  "name": "圣盾",
  "description": "抵挡一次伤害",
  "intensity": 1,
  "isDebuff": false,
  "canStack": false,
  "maxStacks": 1,
  "code": "function EffectTrigger(context) { const piece = context.piece; const damage = context.damage; if (!damage || damage <= 0) { return { success: true, blocked: false, message: '没有伤害需要抵挡' }; } if (typeof removeStatusEffectById === 'function') { removeStatusEffectById(piece.instanceId, 'divine-shield'); } const attacker = context.target ? context.target.name : '未知敌人'; return { success: true, blocked: true, message: piece.name + '的圣盾破裂，抵挡了来自于' + attacker + '的伤害' }; }"
}
```

### 步骤3：创建圣盾规则文件

创建 `data/rules/divine-shield-effect.json`：

```json
{
  "id": "rule-divine-shield",
  "name": "圣盾效果",
  "description": "当受到伤害时触发圣盾效果",
  "trigger": {
    "type": "beforeDamageTaken"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "divine-shield-defense",
    "message": ""
  }
}
```

### 步骤4：创建圣盾防御技能文件

创建 `data/skills/divine-shield-defense.json`：

```json
{
  "id": "divine-shield-defense",
  "name": "圣盾防御",
  "description": "圣盾抵挡伤害的效果",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { const piece = context.piece; let hasDivineShield = false; if (piece.statusTags) { hasDivineShield = piece.statusTags.some(tag => tag.type === 'divine-shield'); } if (!hasDivineShield) { if (typeof removeRuleById === 'function') { removeRuleById(piece.instanceId, 'rule-divine-shield'); } return { success: true, blocked: false, message: '' }; } const damage = context.damage; if (!damage || damage <= 0) { return { success: true, blocked: false, message: '没有伤害需要抵挡' }; } if (typeof removeStatusEffectById === 'function') { removeStatusEffectById(piece.instanceId, 'divine-shield'); } if (typeof removeRuleById === 'function') { removeRuleById(piece.instanceId, 'rule-divine-shield'); } const attacker = context.target ? context.target.name : '未知敌人'; return { success: true, blocked: true, message: piece.name + '的圣盾破裂，抵挡了来自于' + attacker + '的伤害' }; }",
  "actionPointCost": 0
}
```

### 步骤5：装备技能

将技能分配给角色，在角色的 `skills` 数组中添加技能：

```json
"skills": [
  {
    "skillId": "basic-attack",
    "level": 1
  },
  {
    "skillId": "shield-of-light",
    "level": 1
  }
]
```

### 示例3：被动技能 - 反击

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
  "code": "function executeSkill(context) { const piece = context.piece; // 条件判断：只有当受到伤害时才发动反击 if (!context.damage || context.damage <= 0) { return { message: '反击条件不满足', success: false }; } // 寻找3格内的敌人 const enemies = context.battle.pieces.filter(enemy => { if (enemy.ownerPlayerId === piece.ownerPlayerId || enemy.currentHp <= 0) return false; const distance = Math.abs(enemy.x - piece.x) + Math.abs(enemy.y - piece.y); return distance <= 3; }); if (enemies.length > 0) { // 选择第一个敌人并造成伤害 const target = enemies[0]; const damage = piece.attack; target.currentHp = Math.max(0, target.currentHp - damage); return { message: piece.name + '发动反击，对' + target.name + '造成' + damage + '点伤害', success: true }; } return { message: '没有敌人可以反击', success: false }; }"
}
```

#### 步骤2：创建规则文件

创建 `data/rules/retaliation.json`：

```json
{
  "id": "rule-retaliation",
  "name": "反击",
  "description": "当受到伤害时，选择一个3格内的目标，造成100%攻击力的伤害",
  "trigger": {
    "type": "afterDamageTaken"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "retaliation",
    "message": "${source.name}触发了反击技能"
  }
}
```

#### 步骤3：为角色添加规则

对于被动技能，规则通常在角色创建时通过技能系统自动添加。但如果需要手动为角色添加规则，可以使用以下方式：

```javascript
// 在角色创建或技能学习时
if (typeof addRuleById === 'function') {
  addRuleById(piece.instanceId, 'rule-retaliation');
}

// 在角色死亡或技能移除时
if (typeof removeRuleById === 'function') {
  removeRuleById(piece.instanceId, 'rule-retaliation');
}
```

### 步骤4：装备技能

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

### 无限持续时间和无限触发次数的编写标准

为了支持永久效果，我们引入了以下标准：

- **无限持续时间**：使用 `-1` 表示无限持续时间
- **无限触发次数**：使用 `-1` 表示无限触发次数

当使用这些值时，状态效果将：
- 不会因持续时间耗尽而自动移除
- 不会因触发次数耗尽而自动移除
- 仍然可以通过代码手动移除

### 状态标签格式

状态系统会在棋子的 `statusTags` 数组中添加状态对象，每个对象包含唯一的id和状态参数：

#### 状态对象格式

```json
[
  {
    "id": "bleeding-123",       // 状态唯一ID
    "type": "bleeding",        // 状态类型
    "remainingDuration": 3,      // 剩余持续时间
    "name": "bleeding",          // 状态类型名称
    "remainingUses": 3,          // 剩余触发次数
    "stacks": 2,                 // 叠加层数
    "intensity": 5               // 强度
  }
]
```

#### 访问状态对象

在代码中，你可以通过id直接访问特定的状态对象：

```javascript
// 通过id查找状态对象
const statusTag = piece.statusTags.find(tag => tag.id === 'bleeding-123');

if (statusTag) {
  // 访问状态参数
  console.log('剩余持续时间:', statusTag.remainingDuration);
  console.log('剩余触发次数:', statusTag.remainingUses);
  console.log('叠加层数:', statusTag.stacks);
  console.log('强度:', statusTag.intensity);
}
```

### 代码编写规范

1. **主要效果函数**：
   - 必须使用 `EffectTrigger(context)` 函数来表示状态的主要效果
   - 该函数将在对应触发时机被调用（根据规则定义的trigger.type）
   - 返回对象应包含 `success` 和 `message` 属性
   - 可以包含 `blocked` 属性来阻止特定行动（如伤害、移动等）
   - 可以在函数中访问状态的剩余持续时间和剩余触发次数

2. **与Rule系统联动**：
   - 状态效果通常需要通过手动创建规则来触发
   - 规则定义了状态效果的触发时机（如受到伤害时、回合开始时等）
   - 当规则触发时，会执行对应的技能，进而执行状态效果
   - 状态效果可以通过代码手动移除，或由系统根据持续时间和触发次数自动移除

3. **状态标签管理**：
   - 状态系统会在棋子的 `statusTags` 数组中添加状态对象
   - 每个状态对象包含完整的状态信息：id、type、currentDuration、currentUses、intensity、stacks 等
   - 可以在代码中通过访问 `context.piece.statusTags` 来获取和管理状态标签
   - 可以使用 `removeStatusEffectById` 函数手动移除状态效果

### 状态效果上下文

在 `EffectTrigger` 函数中，你可以使用 `context` 参数访问以下信息：

- `context.piece`：当前棋子实例（包含 `statusTags` 数组，存储状态相关标签）
- `context.battleState`：当前战斗状态
- `context.gameContext`：游戏上下文

### 通过 statusTags 访问状态参数

所有状态效果的参数都存储在棋子的 `statusTags` 数组中，你可以通过id直接访问任何状态效果的参数，包括当前状态和其他状态的参数。

#### 访问当前状态的参数

在 `EffectTrigger` 函数中，你可以通过id直接访问当前状态的参数：

```javascript
function EffectTrigger(context) {
  const piece = context.piece;
  
  // 查找当前状态的对象（通过状态ID）
  // 注意：在实际使用中，你需要知道状态的唯一ID
  const statusTag = piece.statusTags.find(tag => tag.id === 'bleeding-123');
  let remainingDuration = 0;
  let remainingUses = 0;
  let currentStacks = 1;
  let intensity = 1;
  
  if (statusTag) {
    // 直接访问状态参数
    remainingDuration = statusTag.remainingDuration || 0;
    remainingUses = statusTag.remainingUses || 0;
    currentStacks = statusTag.stacks || 1;
    intensity = statusTag.intensity || 1;
  }
  
  // 执行状态效果
  const damage = intensity * currentStacks;
  piece.currentHp = Math.max(0, piece.currentHp - damage);
  
  console.log('剩余持续时间:', remainingDuration);
  console.log('剩余触发次数:', remainingUses);
  
  return { success: true, message: piece.name + '受到流血伤害' };
}
```

#### 访问其他状态的参数

你也可以通过id直接访问其他状态效果的参数：

```javascript
function EffectTrigger(context) {
  const piece = context.piece;
  
  // 访问当前状态的参数（流血）
  // 通过状态ID查找
  const bleedingTag = piece.statusTags.find(tag => tag.id === 'bleeding-123');
  let bleedingDuration = 0;
  
  if (bleedingTag) {
    // 直接访问状态参数
    bleedingDuration = bleedingTag.remainingDuration || 0;
  }
  
  // 访问其他状态的参数（中毒）
  // 通过状态ID查找
  const poisonTag = piece.statusTags.find(tag => tag.id === 'poison-456');
  let poisonDuration = 0;
  let poisonIntensity = 1;
  
  if (poisonTag) {
    // 直接访问状态参数
    poisonDuration = poisonTag.remainingDuration || 0;
    poisonIntensity = poisonTag.intensity || 1;
  }
  
  // 基于其他状态的参数执行效果
  const bonusDamage = poisonDuration > 0 ? poisonIntensity : 0;
  const totalDamage = 5 + bonusDamage;
  piece.currentHp = Math.max(0, piece.currentHp - totalDamage);
  
  return { success: true, message: piece.name + '受到伤害，其中包含中毒效果的额外伤害' };
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
  "code": "// 流血状态效果代码\nfunction EffectTrigger(context) {\n  const piece = context.piece;\n  \n  // 查找流血状态的对象\n  // 注意：在实际使用中，你需要知道状态的唯一ID\n  // 这里为了示例，我们遍历所有状态对象，查找流血状态\n  let intensity = 5;\n  let currentStacks = 1;\n  \n  for (const tag of piece.statusTags) {\n    // 检查标签是否是流血状态标签\n    if (tag.type === 'bleeding') {\n      intensity = tag.intensity || 5;\n      currentStacks = tag.stacks || 1;\n      break;\n    }\n  }\n  \n  // 计算伤害\n  const damage = intensity * currentStacks;\n  piece.currentHp = Math.max(0, piece.currentHp - damage);\n  \n  console.log(piece.name + '受到流血伤害，失去' + damage + '点生命值');\n  return { success: true, message: piece.name + '受到流血伤害' };\n}\n"
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
  "code": "function executeSkill(context) { const caster = context.piece; const target = selectTarget({ type: 'piece', range: 5, filter: 'enemy' }); if (!target || target.needsTargetSelection) { return target; } // 计算伤害 const damage = Math.round(caster.attack * context.skill.powerMultiplier); const damageResult = dealDamage(caster, target, damage, 'physical', context.battle, context.skill.id); if (damageResult.success) { addStatusEffectById(target.instanceId, { id: 'bleeding', type: 'bleeding', currentDuration: 3, currentUses: 3, intensity: 1, stacks: 1 }); } return { message: caster.name + '使用出血之刃，对' + target.name + '造成' + damage + '点伤害，并施加了流血状态', success: true }; }",
  "actionPointCost": 2
}
```

#### 示例：永久增益技能

**文件**：`data/skills/permanent-buff.json`

```json
{
  "id": "permanent-buff",
  "name": "永久增益",
  "description": "为目标施加永久的攻击力增益",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { const caster = context.piece; const target = selectTarget({ type: 'piece', range: 5, filter: 'ally' }); if (!target || target.needsTargetSelection) { return target; } // 施加永久增益状态 addStatusEffectById(target.instanceId, { id: 'buff-attack', type: 'buff-attack', currentDuration: -1, currentUses: -1, intensity: 1, stacks: 1 }); return { message: caster.name + '为' + target.name + '施加了永久攻击力增益', success: true }; }",
  "actionPointCost": 3
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
    message: sourcePiece.name + '对' + targetEnemy.name + '造成' + damageResult.damage + '点伤害',
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
    message: sourcePiece.name + '传送到了(' + targetPos.x + ',' + targetPos.y + ')',
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
{"id":"frostbolt","name":"冰霜箭","description":"对5格内一个敌人造成当前攻击力的伤害和1回合冰冻","icon":"❄️","kind":"active","type":"normal","cooldownTurns":1,"maxCharges":0,"powerMultiplier":1,"actionPointCost":2,"code":"function executeSkill(context) { const sourcePiece = context.piece; const targetEnemy = selectTarget({ type: 'piece', range: 5, filter: 'enemy' }); if (!targetEnemy || targetEnemy.needsTargetSelection) { return targetEnemy; } const damageValue = sourcePiece.attack * context.skill.powerMultiplier; const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'magical', context.battle, context.skill.id); if (typeof addStatusEffectById === 'function' && damageResult.success) { addStatusEffectById(targetEnemy.instanceId, { id: 'freeze', type: 'freeze', currentDuration: 1, currentUses: -1, intensity: 1, stacks: 1 }); } return { message: sourcePiece.name + '对' + targetEnemy.name + '造成' + damageResult.damage + '点伤害并使其冰冻', success: true }; }","previewCode":"function calculatePreview(piece, skillDef) { const damageValue = Math.round(piece.attack * skillDef.powerMultiplier); return { description: '对5格内一个敌人造成' + damageValue + '点伤害和1回合冰冻', expectedValues: { damage: damageValue } }; }"}
```

## 故障排除

### 技能不触发的原因

1. **规则文件不存在**：确保在 `data/rules/` 目录下创建了对应的规则文件
2. **触发时机不正确**：检查触发类型是否正确
3. **冷却未就绪**：检查规则的冷却是否已结束
4. **目标不存在**：确保目标类型和范围设置正确
5. **技能未装备**：确保角色已装备该技能
6. **条件判断不满足**：检查技能代码中的if语句条件是否正确

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
- **actionPointCost**：行动点消耗

### 代码编写规范

1. **Context使用规范**：
   - **仅在特定触发事件中**可以使用 `context.target`，如 `afterDamageDealt`、`afterDamageTaken`、`onPieceDied`（此时 target 是攻击者）
   - **禁止**使用 `context.targetPosition`
   - 除特定触发事件外，所有目标相关的信息必须通过函数调用获取

2. **目标选择**：
   - 使用 `selectTarget` 函数进行目标选择，不要使用 `requiresTarget` 属性
   - 正确处理目标选择的返回值，检查 `needsTargetSelection`
   - 根据技能需求选择合适的目标类型：`'piece'` 或 `'grid'`

3. **伤害处理**：
   - 使用 `dealDamage` 函数处理所有伤害，确保触发器正确触发
   - 正确设置伤害类型：`'physical'`、`'magical'` 或 `'true'`

4.3. **状态标签管理**：
   - 使用 `addStatusEffectById` 函数添加状态效果，参数为：`addStatusEffectById(pieceId, statusObject)`
   - `statusObject`：状态对象，包含以下属性：
     - `id`：状态ID
     - `type`：状态类型
     - `currentDuration`：当前持续时间，-1表示无限
     - `currentUses`：当前触发次数，-1表示无限
     - `intensity`：强度
     - `stacks`：叠加层数
   - **所有状态效果必须通过rule和effect来处理**，在合适的时机触发

4. **规则管理**：
   - 使用 `addRuleById` 函数添加规则，参数为：`addRuleById(targetPieceId, ruleId)`
   - `targetPieceId`：目标棋子的实例ID
   - `ruleId`：要添加的规则ID
   - 用于为棋子实例添加规则，使规则与棋子绑定
   - 使用 `removeRuleById` 函数移除规则，参数为：`removeRuleById(targetPieceId, ruleId)`
   - `targetPieceId`：目标棋子的实例ID
   - `ruleId`：要移除的规则ID
   - 用于在状态效果生效后清理对应的规则，防止内存占用过大

5. **效果处理**：
   - **所有效果都必须通过code标签执行**，禁止使用JSON硬编码
   - **所有条件判断都必须在code标签中使用if语句实现**，禁止在规则文件中使用conditions字段
   - 灵活性优先：设计技能时应考虑扩展性，避免硬编码固定值

6. **治疗处理**：
   - 使用 `healDamage` 函数处理治疗效果
   - 正确设置治疗值和技能ID
   - 治疗效果会触发相应的触发器

7. **JSON格式**：
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
  "code": "function executeSkill(context) { const sourcePiece = context.piece; const targetEnemy = selectTarget({ type: 'piece', range: 5, filter: 'enemy' }); if (!targetEnemy || targetEnemy.needsTargetSelection) { return targetEnemy; } const damageValue = sourcePiece.attack * context.skill.powerMultiplier; const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'magical', context.battle, context.skill.id); return { message: sourcePiece.name + '对敌人造成' + damageResult.damage + '点伤害', success: true }; }",
  "range": "single",
  "actionPointCost": 2
}
```

## 战斗日志标准

### 概述

战斗日志是游戏中记录战斗过程的重要组成部分，它可以帮助玩家了解战斗的详细情况，包括技能释放、伤害计算、状态效果等信息。为了提供更清晰、更详细的战斗记录，我们制定了以下战斗日志标准。

### 日志格式

战斗日志采用以下格式：

```
[回合数] 棋子模板ID: 详细的战斗事件描述
```

### 日志内容标准

#### 1. 技能释放日志

当棋子释放技能时，日志应包含以下信息：
- 释放技能的棋子名称
- 技能名称
- 目标信息（如果有）
- 技能类型（如充能技能）
- 技能消耗（如充能点消耗）

**示例**：
```
[7] 尼拉塞克: 尼拉塞克使用了基础攻击，目标是安度因，造成2点物理伤害
[7] 安度因: 安度因使用了圣光闪耀（充能技能，消耗1点充能），目标是蓝方战士，为蓝方战士回复5点生命值
```

#### 2. 伤害日志

当造成伤害时，日志应包含以下信息：
- 攻击者名称
- 目标名称
- 伤害值
- 伤害类型（物理、魔法、真实）
- 击杀信息（如果有）

**示例**：
```
[7] 尼拉塞克: 尼拉塞克对安度因造成2点物理伤害
[7] 安度因: 安度因对尼拉塞克造成3点魔法伤害，击杀敌人获得1点充能
```

#### 3. 治疗日志

当进行治疗时，日志应包含以下信息：
- 治疗者名称
- 目标名称
- 治疗值

**示例**：
```
[7] 安度因: 安度因为蓝方战士回复5点生命值
```

#### 4. 状态效果日志

当状态效果触发时，日志应包含以下信息：
- 状态效果名称
- 目标名称
- 效果描述

**示例**：
```
[7] 尼拉塞克: 尼拉塞克受到流血伤害，失去2点生命值
[7] 安度因: 安度因触发了反击技能，对尼拉塞克造成1点物理伤害
```

### 实现要求

1. **技能代码中的消息格式**：
   - 技能代码中应返回详细的消息，包含技能释放、伤害、治疗等信息
   - 伤害消息应包含伤害类型
   - 技能释放消息应包含目标信息

2. **dealDamage函数**：
   - 应返回包含伤害类型的详细消息
   - 应在消息中包含击杀信息

3. **turn.ts中的日志处理**：
   - 应构建详细的技能释放消息，包含技能名称、目标信息等
   - 应将技能执行结果消息添加到技能释放消息中

### 示例实现

#### 1. dealDamage函数返回消息格式

```javascript
// 正确的消息格式
return {
  success: true,
  damage: finalDamage,
  isKilled,
  targetHp: target.currentHp,
  message: `${attacker.name}对${target.name}造成${finalDamage}点${damageType === 'physical' ? '物理' : damageType === 'magical' ? '魔法' : '真实'}伤害${isKilled ? '，击杀敌人获得1点充能' : ''}`
};
```

#### 2. 技能代码中的消息格式

```javascript
// 正确的消息格式
function executeSkill(context) {
  const sourcePiece = context.piece;
  const targetEnemy = selectTarget({ type: 'piece', range: 1, filter: 'enemy' });
  if (!targetEnemy || targetEnemy.needsTargetSelection) {
    return targetEnemy;
  }
  const attack = Number(sourcePiece.attack) || 0;
  const powerMultiplier = Number(context.skill.powerMultiplier) || 1;
  const damageValue = attack * powerMultiplier;
  const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'physical', context.battle, context.skill.id);
  return { 
    message: `${sourcePiece.name}使用了${context.skill.name}，目标是${targetEnemy.name}，${damageResult.message}`, 
    success: true 
  };
}
```

### 总结

通过遵循以上战斗日志标准，可以为玩家提供更清晰、更详细的战斗记录，增强游戏的可玩性和透明度。同时，统一的日志格式也便于开发人员调试和排查问题。

## 游戏系统常量（BATTLE_DEFAULTS）

为了便于后续调整游戏平衡，所有"回合/行动点"相关的魔法数字都集中定义在 `lib/game/turn.ts` 顶部的 `BATTLE_DEFAULTS` 常量对象中。**编写技能/规则时无需修改这些常量**，但了解它们的含义有助于理解行动点机制。

```typescript
const BATTLE_DEFAULTS = {
  initialMaxActionPoints: 1,       // 每局开始时玩家的初始最大行动点
  actionPointsGrowthPerTurn: 1,    // 每回合最大行动点增长量（炉石传说风格）
  maxActionPointsLimit: 10,        // 最大行动点上限
  moveActionCost: 1,               // 移动操作消耗的行动点
} as const
```

**各常量说明：**
- `initialMaxActionPoints`：第1回合时玩家拥有的最大行动点数（默认1点）
- `actionPointsGrowthPerTurn`：每过一个自己的回合，最大行动点增加多少（默认1点）
- `maxActionPointsLimit`：最大行动点的天花板，永远不会超过此值（默认10点）
- `moveActionCost`：棋子移动一次消耗的行动点（默认1点）

如需调整游戏节奏（如起始行动点、每回合成长速度），只需修改此对象中的对应数值，无需在代码各处搜索魔法数字。

## 状态克隆机制（safeCloneBattleState）

### 概述

在 `lib/game/turn.ts` 中，我们使用 `safeCloneBattleState` 函数来安全地克隆战斗状态。这是因为 JavaScript 的 `structuredClone` 无法克隆函数类型的数据，而战斗状态中的棋子规则（rules）包含 `effect` 函数。

### 实现原理

`safeCloneBattleState` 函数的工作流程：

1. **提取函数**：遍历所有棋子的规则，将 `effect` 函数提取并存储到 `Map` 中
2. **删除函数**：从原始状态中删除 `effect` 属性，使 `structuredClone` 可以正常工作
3. **克隆状态**：使用 `structuredClone` 克隆状态
4. **恢复函数**：将存储的函数恢复到原始状态和克隆后的状态中

```typescript
function safeCloneBattleState(state: BattleState): BattleState {
  // 临时存储所有棋子的规则函数
  const pieceRulesFunctions: Map<number, any[]> = new Map()

  // 提取函数
  state.pieces.forEach((piece, index) => {
    if (piece.rules && piece.rules.length > 0) {
      pieceRulesFunctions.set(index, piece.rules.map(rule => rule.effect))
      // 移除函数以便克隆
      piece.rules.forEach((rule: any) => {
        delete rule.effect
      })
    }
  })

  // 克隆状态
  const cloned = structuredClone(state) as BattleState

  // 恢复函数
  state.pieces.forEach((piece, index) => {
    if (piece.rules && piece.rules.length > 0) {
      const functions = pieceRulesFunctions.get(index)
      if (functions) {
        piece.rules.forEach((rule: any, ruleIndex: number) => {
          rule.effect = functions[ruleIndex]
        })
        // 同时恢复克隆对象中的函数
        if (cloned.pieces[index].rules) {
          cloned.pieces[index].rules.forEach((rule: any, ruleIndex: number) => {
            rule.effect = functions[ruleIndex]
          })
        }
      }
    }
  })

  return cloned
}
```

### 使用场景

在 `turn.ts` 中，所有的战斗动作处理都使用 `safeCloneBattleState` 替代 `structuredClone`：

- `beginPhase` 动作
- `grantChargePoints` 动作  
- `move` 动作
- `basicSkill` 动作
- `chargeSkill` 动作
- `endTurn` 动作
- `surrender` 动作

### 注意事项

1. **不要直接使用 `structuredClone`**：当战斗状态包含函数时，直接使用 `structuredClone` 会抛出错误：`could not be cloned`
2. **确保函数恢复**：在克隆完成后，必须将函数恢复到原始状态和克隆后的状态，否则后续代码无法访问规则效果
3. **处理空规则**：函数会正确处理没有规则的棋子，不会报错

---

## 总结

通过本教程，你应该已经学会了如何创建条件技能、使用状态系统以及实现目标选择：

1. **条件技能系统**：
   - 创建技能文件：定义技能的基本属性和执行逻辑
   - 创建规则文件：只定义触发时机，不定义条件
   - 在技能代码中使用if语句实现所有条件判断
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
   - **仅在特定触发事件中**可以使用 `context.target`，如 `afterDamageDealt`、`afterDamageTaken`、`onPieceDied`（此时 target 是攻击者）
   - **禁止**使用 `context.targetPosition`
   - **所有效果都必须通过code标签执行**，禁止使用JSON硬编码
   - **所有条件判断都必须在code标签中使用if语句实现**，禁止在规则文件中使用conditions字段

5. **战斗日志标准**：
   - 使用统一的日志格式
   - 包含详细的战斗事件描述
   - 区分不同类型的战斗事件
   - 提供清晰、准确的战斗信息

现在你可以尝试创建自己的技能、规则、状态效果和目标选择系统了！例如：

- 设计需要选择多个目标的技能
- 创建需要选择特定位置的范围技能
- 实现基于目标位置的复杂技能效果
- 设计需要特定行动点消耗的技能组合
- 创建具有复杂触发条件的状态效果

祝你游戏开发愉快！