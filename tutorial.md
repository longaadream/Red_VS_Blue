# 技能编写教程

## 技能系统概述

技能是游戏中棋子的核心能力，本教程将指导您如何编写自己的技能。

## 技能执行环境

当技能被执行时，会在一个特定的环境中运行，该环境提供了以下变量和函数：

### 可用变量

1. **context** - 技能执行上下文，包含以下信息：
   - `context.piece` - 执行技能的棋子信息（只读）
   - `context.target` - 技能目标信息（如果有）
   - `context.battle` - 战斗状态信息
   - `context.skill` - 技能本身的信息

2. **sourcePiece** - 源棋子的直接引用（可读写）
   - 用于直接修改棋子的属性，如攻击力、生命值等
   - 这是修改棋子状态的推荐方式

3. **battle** - 战斗状态的直接引用

### 目标选择器

4. **select** - 目标选择器对象，包含以下方法：
   - `select.getAllEnemies()` - 获取所有敌人
   - `select.getAllAllies()` - 获取所有盟友
   - `select.getNearestEnemy()` - 获取最近的敌人
   - `select.getLowestHpEnemy()` - 获取血量最低的敌人
   - `select.getHighestAttackEnemy()` - 获取攻击力最高的敌人
   - `select.getLowestDefenseEnemy()` - 获取防御力最低的敌人
   - `select.getLowestHpAlly()` - 获取血量最低的盟友
   - `select.getHighestAttackAlly()` - 获取攻击力最高的盟友
   - `select.getPieceAt(x, y)` - 根据位置获取棋子
   - `select.getEnemiesInRange(range)` - 获取指定范围内的敌人
   - `select.getAlliesInRange(range)` - 获取指定范围内的盟友

### 效果函数

5. **teleport(x, y)** - 传送效果
   - 将执行技能的棋子传送到指定位置
   - 可以接受 `{x, y}` 对象或两个单独的参数

### 辅助函数

6. **getAllEnemiesInRange(range)** - 获取范围内的所有敌人
7. **getAllAlliesInRange(range)** - 获取范围内的所有盟友
8. **calculateDistance(x1, y1, x2, y2)** - 计算两点之间的距离
9. **isTargetInRange(target, range)** - 检查目标是否在范围内

### 工具函数

10. **Math** - JavaScript Math 对象
11. **console** - 控制台对象（用于调试）

## 技能编写规范

### 函数签名

技能函数必须使用以下签名：

```javascript
function executeSkill(context) {
  // 技能逻辑
  return {
    message: "技能执行消息",
    success: true // 或 false
  };
}
```

### 最佳实践

1. **使用 executeSkill(context)** - 始终使用此函数签名来定义技能
2. **避免使用 context.piece 进行修改** - 不要直接修改 context.piece 的属性
3. **使用 sourcePiece 进行修改** - 当需要修改棋子属性时，使用 sourcePiece
4. **提供详细的消息** - 在返回的对象中提供清晰、详细的技能执行消息
5. **处理边界情况** - 检查目标是否存在等边界情况

## 技能示例

### 基础攻击技能

```javascript
function executeSkill(context) {
  // 选择最近的敌人
  const targetEnemy = select.getNearestEnemy();
  if (!targetEnemy) {
    return { message: '没有可攻击的敌人', success: false };
  }
  
  // 计算伤害值
  const damageValue = sourcePiece.attack * context.skill.powerMultiplier;
  
  // 直接修改敌人的生命值
  targetEnemy.currentHp = Math.max(0, targetEnemy.currentHp - damageValue);
  
  return {
    message: sourcePiece.templateId + ' 造成 ' + damageValue + ' 点伤害',
    success: true
  };
}
```

### 攻击强化技能

```javascript
function executeSkill(context) {
  // 直接修改自身的攻击力
  const buffValue = 1;
  sourcePiece.attack += buffValue;
  
  return {
    message: sourcePiece.templateId + ' 的攻击力提升 ' + buffValue + ' 点',
    success: true
  };
}
```

### 火球术技能

```javascript
function executeSkill(context) {
  // 计算伤害值
  const damageValue = sourcePiece.attack * context.skill.powerMultiplier;
  
  // 选择3格内的所有敌人
  const enemies = select.getEnemiesInRange(3);
  if (enemies.length === 0) {
    return { message: sourcePiece.templateId + ' 周围没有可攻击的敌人', success: false };
  }
  
  // 直接修改每个敌人的生命值
  enemies.forEach(enemy => {
    enemy.currentHp = Math.max(0, enemy.currentHp - damageValue);
  });
  
  return {
    message: sourcePiece.templateId + ' 对 ' + enemies.length + ' 个敌人造成 ' + damageValue + ' 点伤害',
    success: true
  };
}
```

## 技能预览

技能还可以包含一个预览函数，用于在技能选择界面显示技能效果的预览：

```javascript
function calculatePreview(piece, skillDef, currentCooldown) {
  // 计算预期伤害值
  const damageValue = Math.round(piece.attack * skillDef.powerMultiplier);
  
  return {
    description: "选择最近的敌人，造成" + damageValue + "点伤害（相当于攻击力100%）",
    expectedValues: {
      damage: damageValue
    }
  };
}
```

## 技能文件结构

技能文件是 JSON 格式，包含以下字段：

```json
{
  "id": "skill-id",
  "name": "技能名称",
  "description": "技能描述",
  "icon": "技能图标",
  "kind": "active", // 或 "passive"
  "type": "normal", // 或 "super"
  "cooldownTurns": 0, // 冷却回合数
  "maxCharges": 0, // 最大充能次数
  "chargeCost": 1, // 充能技能的充能点数消耗
  "powerMultiplier": 1.0, // 技能威力系数
  "code": "技能函数代码",
  "previewCode": "预览函数代码",
  "range": "single", // 或 "area", "self"
  "areaSize": 3, // 范围大小（仅对area类型有效）
  "requiresTarget": true // 是否需要目标
}
```

## 常见问题

### 技能不执行
- 检查函数签名是否正确（必须是 `function executeSkill(context)`）
- 检查是否正确返回了包含 `message` 和 `success` 字段的对象

### 技能效果不生效
- 确保使用 `sourcePiece` 而不是 `context.piece` 进行修改
- 检查目标是否正确选择

### 战斗日志信息不足
- 在返回的对象中提供详细的 `message`
- 包含棋子名称和具体效果

## 总结

- 使用 `executeSkill(context)` 函数签名
- 避免修改 `context.piece`
- 使用 `sourcePiece` 进行属性修改
- 提供详细的技能执行消息
- 处理边界情况

遵循这些指南，您可以创建强大、可靠的技能来增强游戏体验！