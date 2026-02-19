# 自定义技能和角色指南

## 目录
1. [技能系统](#技能系统)
2. [棋子系统](#棋子系统)
3. [文件位置](#文件位置)
4. [开始创建](#开始创建)
5. [核心类型定义](#核心类型定义)
6. [目标选择器系统](#目标选择器系统)
7. [直接属性修改](#直接属性修改)
8. [特殊效果函数](#特殊效果函数)
9. [编程规范](#编程规范)
10. [底层实现原理](#底层实现原理)

---

## 技能系统

### 技能类型
- **normal**：普通技能，可以无限次使用
- **super**：充能技能，需要消耗充能点数才能释放

### 技能函数编写

#### 基础结构
```typescript
function executeSkill(context) {
  // 技能逻辑
  
  return {
    message: "技能执行成功",
    success: true
  }
}
```

#### 示例：直接修改属性的攻击技能
```typescript
function executeSkill(context) {
  // 选择最近的敌人
  const targetEnemy = select.getNearestEnemy();
  if (!targetEnemy) {
    return { message: '没有可攻击的敌人', success: false };
  }
  
  // 直接修改敌人的生命值
  const damageValue = context.piece.attack * 1.5;
  targetEnemy.currentHp = Math.max(0, targetEnemy.currentHp - damageValue);
  
  return {
    message: `对敌人造成${damageValue}点伤害`,
    success: true
  };
}
```

#### 示例：直接修改属性的增益技能
```typescript
function executeSkill(context) {
  // 选择血量最低的盟友
  const targetAlly = select.getLowestHpAlly();
  if (!targetAlly) {
    return { message: '没有可增益的盟友', success: false };
  }
  
  // 直接修改盟友的攻击力
  const buffValue = 20;
  targetAlly.attack += buffValue;
  
  // 记录增益效果（可选）
  if (!targetAlly.buffs) {
    targetAlly.buffs = [];
  }
  targetAlly.buffs.push({
    type: 'attack',
    value: buffValue,
    duration: 2,
    source: 'skill'
  });
  
  return {
    message: `为盟友提升${buffValue}点攻击力`,
    success: true
  };
}
```

#### 示例：范围攻击技能
```typescript
function executeSkill(context) {
  // 获取3格内的所有敌人
  const enemies = select.getEnemiesInRange(3);
  if (enemies.length === 0) {
    return { message: '3格内没有可攻击的敌人', success: false };
  }
  
  // 对每个敌人造成伤害
  let totalDamage = 0;
  enemies.forEach(enemy => {
    const damageValue = context.piece.attack * 1.2;
    enemy.currentHp = Math.max(0, enemy.currentHp - damageValue);
    totalDamage += damageValue;
  });
  
  return {
    message: `攻击了${enemies.length}个敌人，共造成${totalDamage}点伤害`,
    success: true
  };
}
```

---

## 棋子系统

### 棋子类型

#### 1. 阵营
- **red**：红方棋子
- **blue**：蓝方棋子
- **neutral**：中立棋子

#### 2. 稀有度
- **common**：普通（灰色）
- **rare**：稀有（紫色）
- **epic**：史诗（黄色）
- **legendary**：传说（橙色）

### 棋子数据结构

#### 棋子模板
```typescript
interface PieceTemplate {
  id: PieceId
  name: string
  faction: Faction  // red | blue | neutral
  description?: string
  rarity: PieceRarity  // common | rare | epic | legendary
  image?: string  // 图片URL或emoji
  stats: PieceStats
  skills: PieceSkill[]
  isDefault?: boolean
}
```

#### 棋子属性
```typescript
interface PieceStats {
  maxHp: number      // 最大生命值
  attack: number     // 攻击力
  defense: number    // 防御力
  moveRange: number  // 移动范围
  speed?: number     // 速度
  criticalRate?: number  // 暴击率
}
```

#### 棋子技能
```typescript
interface PieceSkill {
  skillId: string
  level?: number
}
```

### 棋子图片

#### 图片来源
- **URL图片**：使用网络图片URL
  ```typescript
  image: "https://example.com/piece.png"
  ```
- **Emoji**：使用emoji作为棋子图标
  ```typescript
  image: "⚔"
  ```
- **默认图标**：不设置image字段时使用默认图标
  - 红方：⚔
  - 蓝方：🛡

#### 图片显示规则
- 如果image以"http"开头，显示为图片
- 如果image是emoji，直接显示
- 如果没有image，显示默认图标

### 棋子创建

#### 基础棋子
```typescript
{
  id: "my-warrior",
  name: "我的战士",
  faction: "red",
  description: "高生命值，近战攻击",
  rarity: "common",
  image: "⚔",
  stats: {
    maxHp: 120,
    attack: 20,
    defense: 5,
    moveRange: 3,
  },
  skills: [
    { skillId: "basic-attack", level: 1 },
    { skillId: "shield", level: 1 },
  ],
  isDefault: false
}
```

#### 高级棋子
```typescript
{
  id: "my-mage",
  name: "我的法师",
  faction: "blue",
  description: "高攻击力，低防御力",
  rarity: "rare",
  image: "🔥",
  stats: {
    maxHp: 80,
    attack: 30,
    defense: 3,
    moveRange: 2,
    speed: 5,
    criticalRate: 0.2,
  },
  skills: [
    { skillId: "fireball", level: 2 },
    { skillId: "teleport", level: 1 },
    { skillId: "buff-attack", level: 1 },
  ],
  isDefault: false
}
```

### 棋子设计原则

#### 1. 平衡性
- 确保不同稀有度的棋子有合理的属性差异
- 高稀有度应该有更强的属性
- 但不要过于强大，保持游戏平衡

#### 2. 特色性
- 每个棋子应该有独特的定位
- 战士：高生命值，近战
- 法师：高攻击力，范围技能
- 射手：远程攻击，高机动性
- 辅助：治疗和增益技能

#### 3. 技能搭配
- 棋子的技能应该与其属性匹配
- 高攻击力的棋子应该有伤害技能
- 高生命值的棋子应该有防御技能
- 高机动性的棋子应该有移动技能

#### 4. 阵营限制
- 红方棋子只能被红方玩家选择
- 蓝方棋子只能被蓝方玩家选择
- 中立棋子可以被任何阵营选择

### 棋子JSON文件

#### 文件格式
```json
{
  "id": "my-piece",
  "name": "我的棋子",
  "faction": "red",
  "description": "棋子描述",
  "rarity": "common",
  "image": "⚔",
  "stats": {
    "maxHp": 120,
    "attack": 20,
    "defense": 5,
    "moveRange": 3
  },
  "skills": [
    {
      "skillId": "basic-attack",
      "level": 1
    },
    {
      "skillId": "shield",
      "level": 1
    }
  ]
}
```

#### 导入导出
- 在棋子DIY页面中可以导入JSON文件
- 可以导出棋子配置为JSON文件
- 支持分享和备份自定义棋子

---

## 文件位置

### 技能相关
- **技能类型定义**：`lib/game/skills.ts`
- **技能配置**：`lib/game/battle-setup.ts`
- **技能应用**：`lib/game/turn.ts`

### 棋子相关
- **棋子类型定义**：`lib/game/piece.ts`
- **棋子仓库**：`lib/game/piece-repository.ts`
- **棋子选择界面**：`app/piece-selection/page.tsx`
- **棋子显示**：`components/game-board.tsx`

### 界面相关
- **游戏菜单**：`config/game-menu.ts`
- **技能DIY**：`app/skill-diy/page.tsx`
- **棋子DIY**：`app/skill-diy/page.tsx`（和技能DIY在同一页面）

---

## 开始创建

### 游戏流程
1. 进入游戏菜单
2. 点击"Piece Selection"选择棋子
3. 双方各选择1个棋子（红方选红方，蓝方选蓝方）
4. 点击"开始游戏"
5. 系统创建房间并初始化战斗
6. 跳转到对战页面
7. 红方先手开始游戏

### 创建步骤

#### 1. 创建技能
1. 访问技能DIY页面
2. 编写技能函数代码，使用直接属性修改的方式
3. 配置技能属性（类型、冷却、威力等）
4. 导出技能JSON文件

#### 2. 创建棋子
1. 访问技能DIY页面（棋子编辑器）
2. 配置棋子属性（HP、攻击、防御等）
3. 选择棋子图片（URL或emoji）
4. 绑定技能到棋子
5. 导出棋子JSON文件

#### 3. 导入使用
1. 在棋子选择界面导入JSON文件
2. 查看棋子属性和技能
3. 选择使用自定义棋子进行游戏

---

## 核心类型定义

### 技能相关类型

#### SkillId
```typescript
export type SkillId = string
```

#### SkillKind
```typescript
export type SkillKind = "active" | "passive"
```

#### SkillType
```typescript
export type SkillType = "normal" | "super"
```

#### SkillExecutionContext
```typescript
export interface SkillExecutionContext {
  piece: {
    instanceId: string
    templateId: string
    ownerPlayerId: string
    currentHp: number
    maxHp: number
    attack: number
    defense: number
    x: number
    y: number
    moveRange: number
  }
  target: {
    instanceId: string
    templateId: string
    ownerPlayerId: string
    currentHp: number
    maxHp: number
    attack: number
    defense: number
    x: number
    y: number
  } | null
  battle: {
    turn: number
    currentPlayerId: string
    phase: string
  }
  skill: {
    id: string
    name: string
    type: "normal" | "super"
    powerMultiplier: number
  }
}
```

#### SkillExecutionResult
```typescript
export interface SkillExecutionResult {
  message: string
  success: boolean
}
```

#### SkillDefinition
```typescript
export interface SkillDefinition {
  id: SkillId
  name: string
  description: string
  kind: SkillKind
  /** 技能类型：normal=普通技能, super=充能技能 */
  type: SkillType
  /** 冷却回合数（0 表示无冷却） */
  cooldownTurns: number
  /** 最大充能次数（例如 3 次用完就没了），0 表示不限次数，仅对super技能有效 */
  maxCharges: number
  /** 释放一次需要的充能点数，仅对super技能生效 */
  chargeCost?: number
  /** 技能基础威力系数，和攻击力等组合使用 */
  powerMultiplier: number
  /** 技能函数代码（字符串形式存储） */
  code: string
  /** 技能范围：single=单体, area=范围, self=自身 */
  range: "single" | "area" | "self"
  /** 范围大小（仅对area类型有效） */
  areaSize?: number
  /** 是否需要目标 */
  requiresTarget: boolean
  /** 技能图标 */
  icon?: string
}
```

#### SkillState
```typescript
export interface SkillState {
  skillId: SkillId
  /** 当前剩余冷却回合 */
  currentCooldown: number
  /** 当前剩余充能次数 */
  currentCharges: number
  /** 是否已解锁 / 学会 */
  unlocked: boolean
}
```

### 棋子相关类型

#### PieceId
```typescript
export type PieceId = string
```

#### Faction
```typescript
export type Faction = "red" | "blue" | "neutral"
```

#### PieceRarity
```typescript
export type PieceRarity = "common" | "rare" | "epic" | "legendary"
```

#### PieceStats
```typescript
export interface PieceStats {
  maxHp: number
  attack: number
  defense: number
  moveRange: number
  speed?: number
  criticalRate?: number
}
```

#### PieceSkill
```typescript
export interface PieceSkill {
  skillId: string
  level?: number
}
```

#### PieceTemplate
```typescript
export interface PieceTemplate {
  id: PieceId
  name: string
  faction: Faction
  description?: string
  rarity: PieceRarity
  image?: string
  stats: PieceStats
  skills: PieceSkill[]
  isDefault?: boolean
}
```

#### PieceInstance
```typescript
export interface PieceInstance {
  instanceId: string
  templateId: PieceId
  ownerPlayerId: string
  faction: Faction
  currentHp: number
  maxHp: number
  attack: number
  defense: number
  x: number | null
  y: number | null
  moveRange: number
  skills: PieceSkill[]
  buffs: PieceBuff[]
  debuffs: PieceDebuff[]
  shield?: number
}
```

#### PieceBuff
```typescript
export interface PieceBuff {
  type: string
  value: number
  duration: number
  source: string
}
```

#### PieceDebuff
```typescript
export interface PieceDebuff {
  type: string
  value: number
  duration: number
  source: string
}
```

---

## 目标选择器系统

### TargetSelectors 接口
```typescript
export interface TargetSelectors {
  // 获取所有敌人
  getAllEnemies: () => PieceInstance[];
  // 获取所有盟友
  getAllAllies: () => PieceInstance[];
  // 获取单个敌人（最近的）
  getNearestEnemy: () => PieceInstance | null;
  // 获取单个敌人（血量最低的）
  getLowestHpEnemy: () => PieceInstance | null;
  // 获取单个敌人（攻击力最高的）
  getHighestAttackEnemy: () => PieceInstance | null;
  // 获取单个敌人（防御力最低的）
  getLowestDefenseEnemy: () => PieceInstance | null;
  // 获取单个盟友（血量最低的）
  getLowestHpAlly: () => PieceInstance | null;
  // 获取单个盟友（攻击力最高的）
  getHighestAttackAlly: () => PieceInstance | null;
  // 根据位置获取棋子
  getPieceAt: (x: number, y: number) => PieceInstance | null;
  // 获取指定范围内的敌人
  getEnemiesInRange: (range: number) => PieceInstance[];
  // 获取指定范围内的盟友
  getAlliesInRange: (range: number) => PieceInstance[];
}
```

### 目标选择器使用示例

#### 1. 获取3格内的所有敌人
```typescript
const enemies = select.getEnemiesInRange(3);
enemies.forEach(enemy => {
  // 对每个敌人执行操作
  enemy.currentHp = Math.max(0, enemy.currentHp - 20);
});
```

#### 2. 选择最近的敌人
```typescript
const nearestEnemy = select.getNearestEnemy();
if (nearestEnemy) {
  // 对最近的敌人执行操作
  nearestEnemy.currentHp = Math.max(0, nearestEnemy.currentHp - 50);
}
```

#### 3. 选择血量最低的盟友
```typescript
const lowestHpAlly = select.getLowestHpAlly();
if (lowestHpAlly) {
  // 对血量最低的盟友执行操作
  lowestHpAlly.currentHp = Math.min(lowestHpAlly.maxHp, lowestHpAlly.currentHp + 30);
}
```

#### 4. 根据位置获取棋子
```typescript
const pieceAtPosition = select.getPieceAt(5, 5);
if (pieceAtPosition) {
  // 对该位置的棋子执行操作
  pieceAtPosition.attack += 10;
}
```

---

## 直接属性修改

### 攻击示例
```typescript
function executeSkill(context) {
  // 选择最近的敌人
  const targetEnemy = select.getNearestEnemy();
  if (!targetEnemy) {
    return { message: '没有可攻击的敌人', success: false };
  }
  
  // 计算伤害值
  const damageValue = context.piece.attack * 1.5;
  
  // 直接修改敌人的生命值
  targetEnemy.currentHp = Math.max(0, targetEnemy.currentHp - damageValue);
  
  return {
    message: `对敌人造成${damageValue}点伤害`,
    success: true
  };
}
```

### 治疗示例
```typescript
function executeSkill(context) {
  // 选择血量最低的盟友
  const targetAlly = select.getLowestHpAlly();
  if (!targetAlly) {
    return { message: '没有可治疗的盟友', success: false };
  }
  
  // 计算治疗值
  const healValue = 30;
  
  // 直接修改盟友的生命值
  targetAlly.currentHp = Math.min(targetAlly.maxHp, targetAlly.currentHp + healValue);
  
  return {
    message: `为盟友恢复${healValue}点生命值`,
    success: true
  };
}
```

### 增益示例
```typescript
function executeSkill(context) {
  // 选择攻击力最高的盟友
  const targetAlly = select.getHighestAttackAlly();
  if (!targetAlly) {
    return { message: '没有可增益的盟友', success: false };
  }
  
  // 计算增益值
  const buffValue = 20;
  
  // 直接修改盟友的攻击力
  targetAlly.attack += buffValue;
  
  // 记录增益效果（可选）
  if (!targetAlly.buffs) {
    targetAlly.buffs = [];
  }
  targetAlly.buffs.push({
    type: 'attack',
    value: buffValue,
    duration: 2,
    source: 'skill'
  });
  
  return {
    message: `为盟友提升${buffValue}点攻击力`,
    success: true
  };
}
```

### 减益示例
```typescript
function executeSkill(context) {
  // 选择防御力最低的敌人
  const targetEnemy = select.getLowestDefenseEnemy();
  if (!targetEnemy) {
    return { message: '没有可减益的敌人', success: false };
  }
  
  // 计算减益值
  const debuffValue = 8;
  
  // 直接修改敌人的防御力
  targetEnemy.defense = Math.max(0, targetEnemy.defense - debuffValue);
  
  // 记录减益效果（可选）
  if (!targetEnemy.debuffs) {
    targetEnemy.debuffs = [];
  }
  targetEnemy.debuffs.push({
    type: 'defense',
    value: debuffValue,
    duration: 3,
    source: 'skill'
  });
  
  return {
    message: `为敌人降低${debuffValue}点防御力`,
    success: true
  };
}
```

---

## 特殊效果函数

### teleport（传送）

#### 参数格式
- **坐标参数**：`teleport(x: number, y: number)`
- **对象参数**：`teleport({ x: number, y: number })`
- **光标选择**：当技能 `requiresTarget: true` 时，系统会自动将光标选择的位置作为目标

#### 示例
```typescript
// 坐标参数
teleport(5, 5); // 传送到(5, 5)位置

// 对象参数
teleport({ x: 5, y: 5 }); // 传送到(5, 5)位置

// 利用光标选择位置（自动处理）
function executeSkill(context) {
  // 系统会自动将光标选择的位置作为传送目标
  teleport();
  return { message: "传送到目标位置", success: true };
}
```

#### 光标选择位置的实现原理

当技能设置 `requiresTarget: true` 时，系统会：

1. **进入目标选择模式**：玩家点击技能后，鼠标光标变为选择模式
2. **捕获点击位置**：玩家点击地图上的位置时，系统记录该位置的坐标
3. **传递目标信息**：系统将选择的位置信息传递给技能执行函数
4. **自动处理参数**：`teleport()` 函数会自动使用传递的目标位置

#### 技能配置示例

要实现光标选择位置的传送，需要在技能配置中设置 `requiresTarget: true`：

```json
{
  "id": "targeted-teleport",
  "name": "定向传送",
  "description": "传送到光标选择的位置",
  "kind": "active",
  "type": "normal",
  "cooldownTurns": 3,
  "maxCharges": 0,
  "powerMultiplier": 1.0,
  "code": "function executeSkill(context) { teleport(); return { message: \"传送到目标位置\", success: true }; }",
  "range": "self",
  "requiresTarget": true,
  "icon": "✨"
}
```

---

## 编程规范

### 1. 技能函数编写规范

#### 基础结构
```typescript
function executeSkill(context) {
  // 技能逻辑
  
  return {
    message: "技能执行成功",
    success: true
  };
}
```

#### 命名规范
- 函数名：使用 `executeSkill`（固定名称）
- 变量名：使用驼峰命名法（如 `damageValue`、`targetEnemy`）
- 常量名：使用大写字母和下划线（如 `MAX_DAMAGE`）

#### 错误处理
- 检查目标是否存在
- 检查范围是否有效
- 提供清晰的错误消息
- 处理边界情况

#### 示例
```typescript
function executeSkill(context) {
  // 检查目标是否存在
  const target = select.getNearestEnemy();
  if (!target) {
    return { message: '没有可攻击的敌人', success: false };
  }
  
  // 检查距离
  const distance = calculateDistance(
    context.piece.x, context.piece.y,
    target.x, target.y
  );
  if (distance > 3) {
    return { message: '目标超出攻击范围', success: false };
  }
  
  // 执行技能
  const damageValue = context.piece.attack * 1.5;
  target.currentHp = Math.max(0, target.currentHp - damageValue);
  
  return {
    message: `对敌人造成${damageValue}点伤害`,
    success: true
  };
}
```

### 2. 代码风格

#### 缩进
- 使用 2 个空格进行缩进
- 保持代码块的清晰层次

#### 注释
- 为复杂逻辑添加注释
- 解释技能的设计意图
- 标注关键参数和返回值

#### 可读性
- 保持函数简洁（建议不超过 50 行）
- 使用空行分隔不同逻辑块
- 避免嵌套过深的代码

### 3. 性能优化

#### 避免重复计算
- 缓存计算结果
- 避免在循环中重复计算相同的值

#### 示例
```typescript
function executeSkill(context) {
  // 缓存攻击力值
  const attack = context.piece.attack;
  const multiplier = context.skill.powerMultiplier;
  const baseDamage = attack * multiplier;
  
  // 对多个目标造成伤害
  const enemies = select.getEnemiesInRange(3);
  enemies.forEach(enemy => {
    enemy.currentHp = Math.max(0, enemy.currentHp - baseDamage);
  });
  
  return {
    message: `攻击了${enemies.length}个敌人`,
    success: true
  };
}
```

---

## 底层实现原理

### 1. 技能执行流程

1. **技能触发**：玩家选择棋子并点击技能
2. **目标选择**：如果技能需要目标，系统进入目标选择模式
3. **技能执行**：玩家选择目标后，系统执行技能函数
4. **环境准备**：系统创建技能执行环境，包含所有辅助函数和目标选择器
5. **属性修改**：技能函数直接修改棋子属性
6. **状态更新**：系统更新棋子状态和游戏状态
7. **冷却处理**：技能进入冷却状态

### 2. 技能执行环境

#### 环境创建
```typescript
const skillEnvironment = {
  context,
  battle,
  getAllEnemiesInRange: (range: number) => getAllEnemiesInRange(context, range, battle),
  getAllAlliesInRange: (range: number) => getAllAlliesInRange(context, range, battle),
  calculateDistance,
  isTargetInRange: (target: any, range: number) => isTargetInRange(context, target, range),
  // 目标选择器
  select: effects.select,
  // 特殊效果函数
  teleport: effects.teleport
};
```

### 3. 目标选择器实现

#### 核心逻辑
```typescript
function createTargetSelectors(battle: BattleState, sourcePiece: PieceInstance): TargetSelectors {
  return {
    getAllEnemies: () => {
      return battle.pieces.filter(p => 
        p.ownerPlayerId !== sourcePiece.ownerPlayerId && p.currentHp > 0
      );
    },
    // 其他选择器函数...
  };
}
```

### 4. 特殊效果函数实现

#### teleport 函数实现
```typescript
teleport: (x: number, y?: number) => {
  let targetPos: { x: number, y: number } | undefined;
  
  if (typeof x === "object" && x !== null) {
    // 如果传入对象格式 {x, y}
    targetPos = x as { x: number, y: number };
  } else if (typeof x === "number" && typeof y === "number") {
    // 如果传入两个参数 x, y
    targetPos = { x, y };
  } else {
    // 使用默认目标位置
    targetPos = target;
  }
  
  if (targetPos) {
    // 验证目标位置是否在地图范围内
    const targetTile = battle.map.tiles.find(t => t.x === targetPos.x && t.y === targetPos.y);
    if (targetTile) {
      // 验证目标位置是否可行走
      if (targetTile.props.walkable) {
        // 验证目标位置是否被占用
        const isOccupied = battle.pieces.some(p => p.x === targetPos.x && p.y === targetPos.y && p.currentHp > 0);
        if (!isOccupied) {
          // 执行传送
          sourcePiece.x = targetPos.x;
          sourcePiece.y = targetPos.y;
          return { type: "teleport", target: targetPos, success: true };
        }
      }
    }
  } else {
    // 随机传送作为 fallback
    const walkableTiles = battle.map.tiles.filter(tile => tile.props.walkable);
    if (walkableTiles.length > 0) {
      // 过滤掉已被占用的位置
      const availableTiles = walkableTiles.filter(tile => {
        return !battle.pieces.some(p => p.x === tile.x && p.y === tile.y && p.currentHp > 0);
      });
      
      if (availableTiles.length > 0) {
        const randomTile = availableTiles[Math.floor(Math.random() * availableTiles.length)];
        sourcePiece.x = randomTile.x;
        sourcePiece.y = randomTile.y;
        return { type: "teleport", target: randomTile, success: true };
      }
    }
  }
  return { type: "teleport", success: false };
}
```

### 5. 技能执行函数

#### 核心逻辑
```typescript
export function executeSkillFunction(skillDef: SkillDefinition, context: SkillExecutionContext, battle: BattleState): SkillExecutionResult {
  try {
    // 找到源棋子
    const sourcePiece = battle.pieces.find(p => p.instanceId === context.piece.instanceId);
    if (!sourcePiece) {
      throw new Error('Source piece not found');
    }

    // 创建效果函数
    const effects = createEffectFunctions(battle, sourcePiece);

    // 创建技能执行环境
    const skillEnvironment = {
      // 环境变量...
    };

    // 构建技能执行函数
    const skillCode = `
      (function() {
        ${skillDef.code}
        return executeSkill(context);
      })()
    `;

    // 执行技能函数
    const result = eval(skillCode);
    return result;
  } catch (error) {
    console.error('Error executing skill:', error);
    return {
      message: '技能执行失败: ' + (error instanceof Error ? error.message : 'Unknown error'),
      success: false
    };
  }
}
```

---

## 最佳实践

### 1. 技能设计建议

#### 效果组合
- **传送 + 攻击**：出其不意的攻击
- **治疗 + 护盾**：生存能力提升
- **增益 + 范围伤害**：团队战斗
- **减益 + 控制**：战术压制

#### 平衡考虑
- 复合技能应该有更长的冷却时间
- 强大的组合应该消耗充能点数
- 效果数量应该与技能稀有度匹配

#### 用户体验
- 为复合技能添加动画效果
- 显示每个效果的执行过程
- 提供清晰的技能描述

### 2. 调试技巧

#### 日志输出
- 使用 `console.log()` 输出变量值
- 跟踪技能执行流程
- 检查目标选择结果

#### 示例
```typescript
function executeSkill(context) {
  console.log('技能执行开始');
  console.log('当前棋子:', context.piece);
  
  const enemies = select.getEnemiesInRange(3);
  console.log('3格内的敌人:', enemies);
  
  // 技能逻辑
  
  console.log('技能执行结束');
  
  return {
    message: "技能执行成功",
    success: true
  };
}
```

#### 边界测试
- 测试没有目标的情况
- 测试超出范围的情况
- 测试技能冷却的情况
- 测试充能不足的情况

### 3. 性能优化建议

#### 减少计算开销
- 缓存频繁使用的值
- 优化目标选择算法
- 减少不必要的循环

#### 内存管理
- 避免创建过多临时对象
- 合理使用数组方法
- 及时释放不需要的引用

#### 代码优化
- 使用函数式编程风格
- 避免重复代码
- 提取公共逻辑到辅助函数

---

## 常见问题

### Q1: 如何创建自定义技能？
A: 访问技能DIY页面，编写技能函数代码，配置技能属性，导出JSON文件。

### Q2: 如何创建自定义棋子？
A: 在棋子编辑器中配置棋子属性，选择图片，绑定技能，导出JSON文件。

### Q3: 如何导入自定义内容？
A: 在对应页面使用导入功能，选择JSON文件，系统会自动解析并加载。

### Q4: 棋子图片如何设置？
A: 可以使用URL链接网络图片，或使用emoji作为图标。不设置则使用默认图标。

### Q5: 如何确保游戏平衡？
A: 参考稀有度系统，合理设置属性值。高稀有度应该更强，但不要过于强大。

### Q6: 技能和棋子如何关联？
A: 在棋子配置的skills数组中添加技能ID，可以设置技能等级。

### Q7: 如何使用目标选择器？
A: 在技能函数中使用 `select.` 前缀调用目标选择器函数，如 `select.getNearestEnemy()`。

### Q8: 如何实现范围攻击？
A: 使用 `select.getEnemiesInRange(range)` 获取范围内的敌人，然后遍历修改它们的属性。

### Q9: 如何实现单体攻击？
A: 使用 `select.getNearestEnemy()`、`select.getLowestHpEnemy()` 等函数选择目标，然后修改其属性。

### Q10: 如何实现传送技能？
A: 使用 `teleport(x, y)` 函数传送到指定位置，或 `teleport()` 随机传送。

---

## 总结

这个指南涵盖了：
1. ✅ 技能系统设计和编写（直接属性修改）
2. ✅ 棋子系统设计和创建
3. ✅ 文件位置和结构说明
4. ✅ 游戏流程和创建步骤
5. ✅ 核心类型定义
6. ✅ 目标选择器系统
7. ✅ 直接属性修改方法
8. ✅ 特殊效果函数
9. ✅ 编程规范
10. ✅ 底层实现原理
11. ✅ 最佳实践和常见问题

**新特性亮点：**
- ✅ 直接修改目标属性，更加灵活强大
- ✅ 强大的目标选择器系统，支持多种目标选择策略
- ✅ 保留teleport等特殊效果函数
- ✅ 清晰的编程规范和最佳实践
- ✅ 详细的底层实现原理

现在你可以创建更加复杂和有趣的技能了！通过直接修改目标属性的方式，你可以实现几乎任何你能想象的技能效果，为游戏增添更多策略性和乐趣。