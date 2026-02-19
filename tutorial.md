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
  "cooldownTurns": 冷却回合数,
  "maxCharges": 0,
  "powerMultiplier": 1,
  "code": "function executeSkill(context) { return { message: '技能已激活', success: true } }",
  "range": "self",
  "requiresTarget": false
}
```

### 字段说明
- `id`：技能唯一标识符，使用小写字母和连字符
- `name`：技能显示名称
- `description`：技能描述，说明触发条件和效果
- `kind`：技能类型，被动技能使用 `passive`
- `type`：技能类型，普通技能使用 `normal`
- `cooldownTurns`：冷却回合数，0表示无冷却
- `code`：技能执行代码，被动技能可以使用简单的返回语句

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

### 效果类型

| 效果类型 | 描述 | 必要属性 |
|---------|------|----------|
| `modifyStats` | 修改属性 | `target`, `modifications`, `message` |
| `addChargePoints` | 增加充能点 | `amount`, `message` |
| `heal` | 治疗 | `amount`, `target`, `message` |
| `damage` | 伤害 | `amount`, `target`, `message` |
| `triggerSkill` | 触发技能 | `skillId`, `message` |

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

## 示例1：反击技能

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
  "code": "function executeSkill(context) { return { message: '反击被动技能已激活', success: true } }",
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
    "type": "damage",
    "target": "area",
    "range": 3,
    "amount": "source.attack",
    "message": "${source.templateId}发动反击，对3格内的目标造成${source.attack}点伤害"
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

## 示例2：生命汲取

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
  "code": "function executeSkill(context) { return { message: '生命汲取被动技能已激活', success: true } }",
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
    "type": "modifyStats",
    "target": "source",
    "modifications": [
      {
        "stat": "currentHp",
        "operation": "add",
        "value": "target.maxHp"
      }
    ],
    "message": "${source.templateId}汲取了${target.templateId}的生命，恢复了${target.maxHp}点生命值"
  },
  "limits": {
    "cooldownTurns": 0,
    "maxUses": 0
  }
}
```

## 示例3：战斗光环

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
  "code": "function executeSkill(context) { return { message: '战斗光环已激活', success: true } }",
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
    "type": "modifyStats",
    "target": "all",
    "modifications": [
      {
        "stat": "attack",
        "operation": "add",
        "value": 1
      }
    ],
    "message": "${source.templateId}的战斗光环生效，所有友方角色攻击力+1"
  },
  "limits": {
    "cooldownTurns": 1,
    "maxUses": 0
  }
}
```

## 示例4：触发技能代码

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

## 高级技巧

### 复杂条件

可以使用复合条件，例如：

```json
"trigger": {
  "type": "afterDamageDealt",
  "conditions": {
    "minDamage": 5,
    "pieceType": "warrior"
  }
}
```

### 多效果

一个规则可以包含多个效果，例如：

```json
"effect": {
  "type": "modifyStats",
  "target": "source",
  "modifications": [
    {
      "stat": "attack",
      "operation": "add",
      "value": 2
    },
    {
      "stat": "defense",
      "operation": "add",
      "value": 1
    }
  ],
  "message": "${source.templateId}获得了力量和防御增益"
}
```

### 范围效果

可以创建范围效果，例如：

```json
"effect": {
  "type": "heal",
  "target": "area",
  "range": 2,
  "amount": 3,
  "message": "${source.templateId}释放了治疗光环，为2格内的友方角色恢复了3点生命值"
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

## 总结

通过本教程，你应该已经学会了如何创建条件技能：

1. **创建技能文件**：定义技能的基本属性
2. **创建规则文件**：定义触发条件和效果
3. **装备技能**：将技能分配给角色

现在你可以尝试创建自己的条件技能了！例如：

- 当移动时，在脚下留下火焰
- 当受到致命伤害时，触发无敌效果
- 当使用技能时，召唤一个小兵

祝你游戏开发愉快！
