# 条件技能实现教程

本教程将教会你如何在游戏中实现"当……的时候，执行……效果"的条件技能。

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
  "requiresTarget": false,
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
- `requiresTarget`：是否需要目标，`true` 或 `false`

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
  targetPiece: {
    // 目标棋子信息，格式同 piece
    // 仅在有目标时存在
  },
  battle: {
    turn: 当前回合数,
    currentPlayerId: 当前玩家ID,
    phase: 当前回合阶段
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
| `afterDamageDealt` | `piece`（攻击者）, `targetPiece`（被攻击者）, `damage`（伤害值） | `context.piece`（攻击者）, `context.targetPiece`（被攻击者）, `context.damage`（伤害值） |
| `afterDamageTaken` | `piece`（被攻击者）, `targetPiece`（攻击者）, `damage`（伤害值） | `context.piece`（被攻击者）, `context.targetPiece`（攻击者）, `context.damage`（伤害值） |
| `afterPieceKilled` | `piece`（击杀者）, `targetPiece`（被杀者） | `context.piece`（击杀者）, `context.targetPiece`（被杀者） |
| `afterPieceSummoned` | `piece`（召唤者）, `targetPiece`（被召唤者） | `context.piece`（召唤者）, `context.targetPiece`（被召唤者） |
| `beginTurn` | `piece`（当前回合玩家的棋子）, `turnNumber`（回合数）, `playerId`（玩家ID） | `context.piece`（当前棋子）, `context.turnNumber`（回合数）, `context.playerId`（玩家ID） |
| `endTurn` | `piece`（当前回合玩家的棋子）, `turnNumber`（回合数）, `playerId`（玩家ID） | `context.piece`（当前棋子）, `context.turnNumber`（回合数）, `context.playerId`（玩家ID） |
| `afterMove` | `piece`（移动的棋子）, `playerId`（玩家ID） | `context.piece`（移动的棋子）, `context.playerId`（玩家ID） |
| `afterSkillUsed` | `piece`（使用技能的棋子）, `skillId`（技能ID）, `playerId`（玩家ID） | `context.piece`（使用技能的棋子）, `context.skillId`（技能ID）, `context.playerId`（玩家ID） |
| `whenever` | 根据触发时机不同，可能包含上述所有信息 | 根据具体情况获取相应信息 |

### 详细示例：如何在技能中获取死亡玩家信息
当使用 `afterPieceKilled` 触发器时，你可以在技能代码中通过 `context.targetPiece` 获取被杀者的信息：

```javascript
function executeSkill(context) {
  // 获取击杀者信息
  const killer = context.piece;
  // 获取被杀者信息
  const victim = context.targetPiece;
  
  if (victim) {
    // 可以获取被杀者的各种属性
    console.log('被杀者ID:', victim.instanceId);
    console.log('被杀者模板:', victim.templateId);
    console.log('被杀者最大生命值:', victim.maxHp);
    console.log('被杀者攻击力:', victim.attack);
    
    // 示例：根据被杀者的最大生命值增加击杀者的属性
    const bonus = Math.floor(victim.maxHp * 0.1);
    killer.attack += bonus;
    killer.defense += bonus;
    
    return { 
      message: killer.templateId + '击杀了' + victim.templateId + '，获得了' + bonus + '点攻击力和防御力', 
      success: true 
    };
  }
  
  return { message: '没有目标信息', success: false };
}
```

### 伤害处理函数 (dealDamage)

为了简化伤害处理并确保所有伤害相关的触发器都能正确触发，我们提供了 `dealDamage` 函数。这个函数会处理伤害计算（包括防御力）、应用伤害、触发相关触发器等逻辑。

#### 函数签名

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

#### 使用示例

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
  const damageResult = dealDamage(targetEnemy, baseDamage, 'physical', 'basic-attack');
  
  return {
    message: damageResult.message,
    success: damageResult.success
  };
}
```

#### 不同伤害类型的使用示例

```javascript
// 物理伤害（受到防御力影响）
dealDamage(targetEnemy, baseDamage, 'physical', 'basic-attack');

// 法术伤害（受到魔法抗性影响，暂时使用防御力代替）
dealDamage(targetEnemy, baseDamage, 'magical', 'fireball');

// 真实伤害（不受防御力影响）
dealDamage(targetEnemy, baseDamage, 'true', 'true-damage');
```

#### 函数功能说明

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

### 其他触发器的使用示例

#### 1. 伤害相关触发器
当使用 `afterDamageDealt` 或 `afterDamageTaken` 触发器时：

```javascript
function executeSkill(context) {
  const source = context.piece;
  const target = context.targetPiece;
  const damage = context.damage;
  
  if (source && target && damage) {
    // 可以使用伤害值进行计算
    const healAmount = Math.floor(damage * 0.5);
    source.currentHp = Math.min(source.currentHp + healAmount, source.maxHp);
    
    return { 
      message: source.templateId + '造成了' + damage + '点伤害，恢复了' + healAmount + '点生命值', 
      success: true 
    };
  }
  
  return { message: '缺少伤害信息', success: false };
}
```

#### 2. 技能使用相关触发器
当使用 `afterSkillUsed` 触发器时：

```javascript
function executeSkill(context) {
  const piece = context.piece;
  const skillId = context.skillId;
  
  if (piece && skillId) {
    // 根据使用的技能类型执行不同效果
    if (skillId === 'fireball') {
      // 火球术使用后效果
      piece.attack += 2;
      return { message: piece.templateId + '使用火球术后攻击力提升', success: true };
    } else if (skillId === 'heal') {
      // 治疗术使用后效果
      piece.defense += 2;
      return { message: piece.templateId + '使用治疗术后防御力提升', success: true };
    }
  }
  
  return { message: '缺少技能信息', success: false };
}
```

#### 3. 回合相关触发器
当使用 `beginTurn` 或 `endTurn` 触发器时：

```javascript
function executeSkill(context) {
  const piece = context.piece;
  const turnNumber = context.turnNumber;
  const playerId = context.playerId;
  
  if (piece && turnNumber) {
    // 根据回合数执行不同效果
    if (turnNumber % 2 === 0) {
      // 偶数回合效果
      piece.attack += 1;
      return { message: piece.templateId + '在第' + turnNumber + '回合攻击力提升', success: true };
    } else {
      // 奇数回合效果
      piece.defense += 1;
      return { message: piece.templateId + '在第' + turnNumber + '回合防御力提升', success: true };
    }
  }
  
  return { message: '缺少回合信息', success: false };
}
```

#### 4. 移动相关触发器
当使用 `afterMove` 触发器时：

```javascript
function executeSkill(context) {
  const piece = context.piece;
  
  if (piece) {
    // 移动后效果
    piece.currentHp = Math.min(piece.currentHp + 1, piece.maxHp);
    return { message: piece.templateId + '移动后恢复了1点生命值', success: true };
  }
  
  return { message: '缺少移动信息', success: false };
}
```

#### 5. 召唤相关触发器
当使用 `afterPieceSummoned` 触发器时：

```javascript
function executeSkill(context) {
  const summoner = context.piece;
  const summoned = context.targetPiece;
  
  if (summoner && summoned) {
    // 召唤后效果
    summoned.attack += summoner.attack * 0.2;
    summoned.defense += summoner.defense * 0.2;
    return { message: summoned.templateId + '获得了' + summoner.templateId + '的力量加成', success: true };
  }
  
  return { message: '缺少召唤信息', success: false };
}
```

### 重要说明
**所有技能效果都必须通过代码实现**，规则文件中的 `effect` 字段仅用于触发技能，不直接定义效果。技能的具体效果完全由 `code` 字段中的代码决定。

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

## 示例1：主动技能 - 火球术

实现"对单个目标造成150%攻击力的伤害"的主动技能。

### 步骤1：创建技能文件

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
  "code": "function executeSkill(context) { \n  const caster = context.piece;\n  const target = context.targetPiece;\n  if (target) {\n    const damage = Math.round(caster.attack * context.skill.powerMultiplier);\n    target.currentHp = Math.max(0, target.currentHp - damage);\n    return { message: caster.templateId + '释放火球术，对' + target.templateId + '造成' + damage + '点伤害', success: true };\n  }\n  return { message: '没有目标可以攻击', success: false };\n}",
  "range": "single",
  "requiresTarget": true
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

## 示例2：被动技能 - 反击

实现"当受到伤害时，选择一个3格内的目标，造成100%攻击力的伤害"的技能。

### 步骤1：创建技能文件

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
  "code": "function executeSkill(context) { \n  const piece = context.piece;\n  // 寻找3格内的敌人\n  const enemies = context.battle.pieces.filter(enemy => {\n    if (enemy.ownerPlayerId === piece.ownerPlayerId || enemy.currentHp <= 0) return false;\n    const distance = Math.abs(enemy.x - piece.x) + Math.abs(enemy.y - piece.y);\n    return distance <= 3;\n  });\n  \n  if (enemies.length > 0) {\n    // 选择第一个敌人并造成伤害\n    const target = enemies[0];\n    const damage = piece.attack;\n    target.currentHp = Math.max(0, target.currentHp - damage);\n    return { message: piece.templateId + '发动反击，对' + target.templateId + '造成' + damage + '点伤害', success: true };\n  }\n  return { message: '没有敌人可以反击', success: false };\n}",
  "range": "area",
  "areaSize": 3,
  "requiresTarget": false
}
```

### 步骤2：创建规则文件

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

## 示例3：被动技能 - 生命汲取

实现"当击杀敌人时，获得等同于其最大生命值的生命值"的技能。

### 步骤1：创建技能文件

创建 `data/skills/life-drain.json`：

```json
{
  "id": "life-drain",
  "name": "生命汲取",
  "description": "当击杀敌人时，获得等同于其最大生命值的生命值",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 0,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { \n  const piece = context.piece;\n  const target = context.targetPiece;\n  if (target) {\n    // 获得等同于目标最大生命值的生命值\n    const healAmount = target.maxHp;\n    piece.currentHp = Math.min(piece.currentHp + healAmount, piece.maxHp);\n    return { message: piece.templateId + '汲取了' + target.templateId + '的生命，恢复了' + healAmount + '点生命值', success: true };\n  }\n  return { message: '没有目标可以汲取生命', success: false };\n}",
  "range": "self",
  "requiresTarget": false
}
```

### 步骤2：创建规则文件

创建 `data/rules/life-drain.json`：

```json
{
  "id": "rule-5",
  "name": "生命汲取",
  "description": "当击杀敌人时，获得等同于其最大生命值的生命值",
  "trigger": {
    "type": "afterPieceKilled"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "life-drain",
    "message": "${source.templateId}触发了生命汲取技能"
  },
  "limits": {
    "cooldownTurns": 0,
    "maxUses": 0
  }
}
```

## 示例4：战斗光环

实现"当回合开始时，所有友方角色攻击力+1"的技能。

### 步骤1：创建技能文件

创建 `data/skills/battle-aura.json`：

```json
{
  "id": "battle-aura",
  "name": "战斗光环",
  "description": "当回合开始时，所有友方角色攻击力+1",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 1,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { \n  const piece = context.piece;\n  // 为所有友方角色增加攻击力\n  context.battle.pieces.forEach(friendly => {\n    if (friendly.ownerPlayerId === piece.ownerPlayerId && friendly.currentHp > 0) {\n      friendly.attack += 1;\n    }\n  });\n  return { message: piece.templateId + '的战斗光环生效，所有友方角色攻击力+1', success: true };\n}",
  "range": "area",
  "areaSize": 10,
  "requiresTarget": false
}
```

### 步骤2：创建规则文件

创建 `data/rules/battle-aura.json`：

```json
{
  "id": "rule-6",
  "name": "战斗光环",
  "description": "当回合开始时，所有友方角色攻击力+1",
  "trigger": {
    "type": "beginTurn"
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "battle-aura",
    "message": "${source.templateId}触发了战斗光环技能"
  },
  "limits": {
    "cooldownTurns": 1,
    "maxUses": 0
  }
}
```

## 示例5：触发技能代码

实现"当受到伤害时，触发反击技能"的效果，使用技能的code代码执行逻辑。

### 步骤1：创建技能文件

创建 `data/skills/counter-attack.json`：

```json
{
  "id": "counter-attack",
  "name": "反击",
  "description": "当受到伤害时，对攻击者造成伤害",
  "kind": "passive",
  "type": "normal",
  "cooldownTurns": 1,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) {\n  const attacker = context.targetPiece;\n  if (attacker) {\n    const damage = context.piece.attack;\n    attacker.currentHp = Math.max(0, attacker.currentHp - damage);\n    return { message: context.piece.templateId + '发动反击，对' + attacker.templateId + '造成' + damage + '点伤害', success: true };\n  }\n  return { message: '没有目标可以反击', success: false };\n}",
  "range": "self",
  "requiresTarget": false
}
```

### 步骤2：创建规则文件

创建 `data/rules/trigger-counter-attack.json`：

```json
{
  "id": "rule-7",
  "name": "触发反击",
  "description": "当受到伤害时，触发反击技能",
  "trigger": {
    "type": "afterDamageTaken",
    "conditions": {
      "minDamage": 1
    }
  },
  "effect": {
    "type": "triggerSkill",
    "skillId": "counter-attack",
    "message": "${source.templateId}触发了反击技能"
  },
  "limits": {
    "cooldownTurns": 1,
    "maxUses": 0
  }
}
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


## 状态系统（Status Effects）

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

### 示例：中毒状态

**文件**：`data/status-effects/poison.json`

```json
{
  "id": "poison",
  "type": "poison",
  "name": "中毒",
  "description": "每回合受到持续伤害",
  "intensity": 3,
  "isDebuff": true,
  "canStack": true,
  "maxStacks": 3,
  "code": "// 中毒状态效果函数\nfunction EffectTrigger(context) {\n  const damage = context.statusEffect.intensity * context.statusEffect.currentStacks;\n  context.piece.currentHp = Math.max(0, context.piece.currentHp - damage);\n  console.log(context.piece.templateId + '受到中毒伤害，失去' + damage + '点生命值');\n  return { success: true, message: context.piece.templateId + '受到中毒伤害' };\n}\n"
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
  "code": "function executeSkill(context) { \n  const caster = context.piece;\n  const target = context.targetPiece;\n  if (target) {\n    // 计算伤害\n    const damage = Math.round(caster.attack * context.skill.powerMultiplier);\n    target.currentHp = Math.max(0, target.currentHp - damage);\n    \n    // 施加流血状态\n    addStatusEffectById(target.instanceId, 'bleeding');\n    \n    return { message: caster.templateId + '使用出血之刃，对' + target.templateId + '造成' + damage + '点伤害，并施加了流血状态', success: true };\n  }\n  return { message: '没有目标可以攻击', success: false };\n}",
  "range": "single",
  "requiresTarget": true,
  "actionPointCost": 2
}
```

#### 示例：如何在技能中施加流血效果

```javascript
function executeSkill(context) {
  const caster = context.piece;
  const target = context.targetPiece;
  
  if (target) {
    // 计算伤害
    const damage = Math.round(caster.attack * context.skill.powerMultiplier);
    target.currentHp = Math.max(0, target.currentHp - damage);
    
    // 施加流血状态
    addStatusEffectById(target.instanceId, 'bleeding');
    
    return { message: caster.templateId + '使用出血之刃，对' + target.templateId + '造成' + damage + '点伤害，并施加了流血状态', success: true };
  }
  return { message: '没有目标可以攻击', success: false };
}
```

#### 示例：如何创建自定义状态效果

如果你想创建一个自定义的状态效果，只需在 `data/status-effects/` 目录下创建一个新的 JSON 文件即可。以下是一个示例：

**文件**：`data/status-effects/burn.json`

```json
{
  "id": "burn",
  "type": "burn",
  "name": "燃烧",
  "description": "每回合受到燃烧伤害",
  "intensity": 8,
  "isDebuff": true,
  "canStack": false,
  "maxStacks": 1,
  "code": "// 燃烧状态效果函数\nfunction EffectTrigger(context) {\n  const damage = context.statusEffect.intensity;\n  context.piece.currentHp = Math.max(0, context.piece.currentHp - damage);\n  console.log(context.piece.templateId + '受到燃烧伤害，失去' + damage + '点生命值');\n  return { success: true, message: context.piece.templateId + '受到燃烧伤害' };\n}\n"
}
```

然后为这个状态效果创建对应的规则文件：

**文件**：`data/rules/status-burn.json`

```json
{
  "id": "rule-status-burn",
  "name": "燃烧状态规则",
  "description": "处理燃烧状态的触发时机",
  "trigger": {
    "type": "beginTurn"
  },
  "effect": {
    "type": "triggerStatusEffect",
    "statusId": "burn",
    "message": "燃烧状态触发"
  },
  "limits": {
    "cooldownTurns": 0,
    "maxUses": 0
  }
}
```

### 工作原理

状态系统的工作原理如下：

1. **添加状态效果**：当你使用 `addStatusEffectById` 函数添加状态效果时，系统会：
   - 创建一个状态效果实例（默认持续时间为3回合）
   - 在棋子实例上存储状态数据（剩余持续时间、叠加层数等）
   - 在棋子的 `statusTags` 数组中添加状态相关标签
   - 为该状态创建一个规则，在回合开始时触发

2. **规则触发**：在每个回合开始时，状态对应的规则会：
   - 检查棋子是否存在以及状态数据是否有效
   - 检查状态的剩余持续时间
   - 如果持续时间 > 0，执行 `EffectTrigger` 函数
   - 减少状态的剩余持续时间
   - 如果持续时间 <= 0，移除状态效果和对应的规则

3. **叠加效果**：如果状态可以叠加（`canStack: true`），当再次添加相同类型的状态时：
   - 增加状态的叠加层数（不超过 `maxStacks`）
   - 重置状态的剩余持续时间

4. **状态标签管理**：
   - 状态系统会自动在棋子的 `statusTags` 数组中添加状态相关标签
   - 状态类型标签：如 "bleeding"、"poison" 等
   - 状态持续时间标签：如 "bleeding-duration-{effectId}" 等
   - 当状态效果结束时，会自动移除相应的标签

5. **自动清理**：当状态的持续时间结束时，系统会：
   - 从棋子实例上移除状态数据
   - 从棋子的 `statusTags` 数组中移除状态相关标签
   - 从状态效果列表中移除该状态
   - 移除对应的规则

6. **访问和修改持续时间**：
   - 在 `EffectTrigger` 函数中，你可以通过 `context.statusEffect.remainingDuration` 访问和修改状态的剩余持续时间
   - 例如，你可以延长或缩短状态的持续时间

这种设计使得状态效果的实现更加简洁和灵活，不需要为每个状态效果手动创建规则，系统会自动处理触发时机和持续时间管理。

## 总结

通过本教程，你应该已经学会了如何创建条件技能、使用状态系统以及了解了游戏的核心系统：

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

现在你可以尝试创建自己的技能、规则和状态效果了！例如：

- 当移动时，在脚下留下火焰
- 当受到致命伤害时，触发无敌效果
- 当使用技能时，召唤一个小兵
- 设计需要特定行动点消耗的技能组合
- 创建具有复杂触发条件的状态效果

祝你游戏开发愉快！
