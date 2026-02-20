# 游戏开发笔记

## 项目概览

### 游戏类型
- **类型**：回合制策略游戏
- **特色**：类似于炉石传说的集换式棋类游戏，从卡牌变为了棋类，通过棋子的组合来组建自己的"套牌"
- **核心玩法**：玩家通过选择不同阵营的棋子，在回合制战斗中击败对方所有棋子
- **重点模式**：PVP对战（PVE为次要功能）

### 技术栈
- **前端**：Next.js 框架
- **后端**：Node.js (Next.js API 路由)
- **数据存储**：JSON 文件
- **游戏逻辑**：TypeScript

### 开发状态
- **当前版本**：基础框架搭建完成，核心系统已实现
- **已实现功能**：
  - 房间创建和加入系统
  - 阵营领取机制（红方/蓝方）
  - 棋子选择系统
  - 游戏开始逻辑
  - 基础 API 接口
  - 角色和地图图鉴系统
  - 核心对战系统（棋子移动、攻击、技能使用）
  - 回合管理系统（包含行动点机制）
  - 行动点系统（消耗、增长、显示）
  - Toast 通知系统（替代大型弹窗）
  - 技能系统（包含行动点消耗）
- **待实现功能**：
  - 完整的用户界面
  - PVE 模式

## 核心框架

### 项目结构
```
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login/
│   │   │   │   └── route.ts
│   │   │   └── register/
│   │   │       └── route.ts
│   │   ├── battle/
│   │   │   └── route.ts
│   │   ├── lobby/
│   │   │   └── route.ts
│   │   ├── maps/
│   │   │   └── route.ts              # 地图数据 API
│   │   ├── pieces/
│   │   │   └── route.ts              # 棋子数据 API
│   │   ├── rooms/
│   │   │   ├── [roomId]/
│   │   │   │   ├── actions/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── battle/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── join/
│   │   │   │   │   └── route.ts
│   │   │   │   └── route.ts
│   │   ├── skills/
│   │   │   └── route.ts
│   ├── auth/
│   │   ├── login/
│   │   │   └── page.tsx
│   │   ├── register/
│   │   │   └── page.tsx
│   ├── battle/
│   │   └── [roomId]/
│   │       └── page.tsx
│   ├── board-demo/
│   │   └── page.tsx
│   ├── browser-map-test/
│   │   └── page.tsx
│   ├── encyclopedia/
│   │   ├── page.tsx                   # 图鉴主页
│   │   ├── pieces/
│   │   │   └── page.tsx               # 角色图鉴
│   │   └── maps/
│   │       └── page.tsx               # 地图图鉴
│   ├── map-editor/
│   │   └── page.tsx
│   ├── map-test/
│   │   └── page.tsx
│   ├── piece-editor/
│   │   └── page.tsx
│   ├── piece-selection/
│   │   └── page.tsx
│   ├── play/
│   │   └── page.tsx
│   ├── practice/
│   │   └── page.tsx
│   ├── skill-diy/
│   │   └── page.tsx
│   ├── turn-debug/
│   │   └── page.tsx
│   ├── globals.css
│   ├── layout.tsx
│   ├── page.tsx
├── lib/
│   └── game/
│       ├── room-store.ts              # 房间存储和管理
│       ├── battle-setup.ts            # 战斗设置
│       ├── piece-repository.ts        # 棋子仓库
│       ├── skills.ts                  # 技能系统
│       ├── turn.ts                    # 回合系统
│       └── file-loader.ts             # 文件加载器
├── data/
│   ├── maps/
│   │   └── arena-8x6.json             # 地图数据
│   ├── pieces/
│   │   ├── blue-archer.json           # 蓝方射手
│   │   ├── blue-mage.json             # 蓝方法师
│   │   ├── blue-warrior.json          # 蓝方战士
│   │   ├── red-archer.json            # 红方射手
│   │   ├── red-mage.json              # 红方法师
│   │   └── red-warrior.json           # 红方战士
│   ├── skills/
│   │   ├── arcane-burst.json          # 奥术爆发技能
│   │   ├── arcane-combination.json    # 奥术连击技能
│   │   ├── basic-attack.json          # 普通攻击技能
│   │   ├── buff-attack.json           # 攻击增益技能
│   │   ├── fireball.json              # 火球术技能
│   │   ├── shield.json                # 护盾技能
│   │   └── teleport.json              # 传送技能
│   └── users.json                     # 用户数据
└── GAME_DEVELOPMENT_NOTES.md          # 开发文档
```

### 游戏流程
1. **登录/注册**：玩家登录或注册账户，系统分配唯一ID
2. **匹配**：玩家进入匹配系统，寻找1v1对战对手
3. **领取身份**：系统自动分配红方和蓝方身份
4. **选择棋子**：
   - 红方只能选择红方或中立棋子
   - 蓝方只能选择蓝方或中立棋子
5. **开始游戏**：在双方都选择完成之后，正式开始游戏
6. **战斗**：玩家轮流行动，使用棋子的技能进行战斗
7. **胜利条件**：击败对方所有棋子
8. **投降**：玩家可以选择投降，立即进入战败画面，对方进入胜利画面

### 核心模块

#### 1. 房间管理 (`lib/game/room-store.ts`)
- **功能**：管理游戏房间的创建、加入、状态更新等
- **核心方法**：
  - `getRoom(id)`：获取房间信息
  - `setRoom(id, room)`：保存房间信息
  - `assignFaction(room, playerId)`：分配玩家身份（关键功能）
  - `createRoom(name, maxPlayers)`：创建新房间
  - `addPlayer(room, player)`：添加玩家到房间

#### 2. 战斗设置 (`lib/game/battle-setup.ts`)
- **功能**：设置初始战斗状态，包括棋子分配、地图加载等
- **核心方法**：
  - `buildInitialPiecesForPlayers(map, players, selectedPieces, playerSelectedPieces)`：为玩家构建初始棋子
  - `createInitialBattleForPlayers(playerIds, selectedPieces, playerSelectedPieces)`：创建初始战斗状态

#### 3. 棋子系统 (`lib/game/piece-repository.ts`)
- **功能**：管理棋子的加载、获取等
- **核心方法**：
  - `loadPieces()`：加载棋子数据
  - `getPiecesByFaction(faction)`：根据阵营获取棋子
  - `getPieceById(id)`：根据ID获取棋子

#### 4. 技能系统 (`lib/game/skills.ts`)
- **功能**：管理技能的定义和执行，支持函数式技能逻辑
- **核心设计思想**：
  - **函数式技能系统**：技能逻辑通过JavaScript函数代码实现，存储在JSON文件中
  - **动态执行**：技能代码在运行时通过eval执行，提供最大的灵活性
  - **目标选择器**：内置多种目标选择函数，如获取最近敌人、最低血量敌人等
  - **效果函数**：提供基础效果函数，如传送
  - **直接属性修改**：推荐使用直接修改棋子属性的方式实现技能效果，如 `nearestEnemy.currentHp -= damage`
- **核心组件**：
  - **SkillDefinition**：技能的静态定义，包含技能元数据和函数代码
  - **SkillExecutionContext**：技能执行上下文，提供给技能函数使用
  - **SkillExecutionResult**：技能执行结果，由技能函数返回
  - **TargetSelectors**：目标选择器，用于获取和筛选目标
- **关键功能**：
  - **技能执行**：通过`executeSkillFunction`执行技能逻辑
  - **技能预览**：通过`calculateSkillPreview`计算和显示技能效果预览
  - **默认技能逻辑**：当技能执行失败时，提供默认的伤害逻辑作为fallback
  - **冷却和充能**：支持技能冷却和充能机制
  - **限定技**：支持一局只能使用一次的限定技技能类型
- **技能代码示例**：
  ```javascript
  function executeSkill(context) {
    const nearestEnemy = select.getNearestEnemy();
    if (nearestEnemy) {
      const damage = Math.round(sourcePiece.attack * context.skill.powerMultiplier);
      nearestEnemy.currentHp = Math.max(0, nearestEnemy.currentHp - damage);
      return { message: '对单个目标造成' + damage + '点伤害', success: true };
    }
    return { message: '范围内没有可攻击的敌人', success: false };
  }
  ```

#### 5. 回合系统 (`lib/game/turn.ts`)
- **功能**：管理游戏回合的流程和状态
- **核心设计**：
  - **回合结构**：每个回合分为三个阶段
    1. **开始阶段**：处理回合开始的效果，如buff/debuff的持续时间更新，行动点重置
    2. **行动阶段**：玩家执行操作的主要阶段，受行动点机制制约
    3. **结束阶段**：处理回合结束的效果，如自动回复等
  - **行动点机制**：
    - 每个玩家在回合开始时获得固定数量的行动点
    - 不同操作消耗不同的行动点
    - 移动：消耗1点行动点
    - 普通技能：消耗1-2点行动点
    - 充能技能：消耗2-3点行动点和相应的充能点
    - 限定技：消耗3点行动点（一局只能使用一次）
  - **充能系统**：击杀敌人会获得充能点，充能点足够了才可以使用充能技能
  - **回合顺序**：固定顺序，玩家轮流行动

#### 6. 图鉴系统 (`app/encyclopedia/`)
- **功能**：展示游戏中的所有角色和地图信息
- **核心页面**：
  - **主页** (`app/encyclopedia/page.tsx`)：图鉴系统的入口页面
  - **角色图鉴** (`app/encyclopedia/pieces/page.tsx`)：展示所有游戏棋子的详细信息
  - **地图图鉴** (`app/encyclopedia/maps/page.tsx`)：展示所有游戏地图的详细信息
- **关键功能**：
  - **角色筛选**：根据阵营筛选棋子
  - **角色详情**：展示棋子的属性、技能和背景信息
  - **地图预览**：可视化展示地图布局
  - **图例说明**：解释地图中的各种元素
  - **返回主菜单**：所有图鉴页面都添加了返回主菜单的按钮

#### 7. 触发系统 (`lib/game/triggers.ts`)
- **功能**：实现"当……的时候，执行……效果"的触发规则系统
- **核心设计思想**：
  - **事件驱动**：基于游戏中的各种事件触发效果
  - **规则分离**：规则定义与技能逻辑分离，通过JSON文件配置
  - **条件触发**：支持复杂的触发条件
  - **技能集成**：规则触发时执行技能代码，而不是直接定义效果
- **核心组件**：
  - **TriggerSystem**：触发系统核心类，管理规则的加载、检查和执行
  - **TriggerRule**：触发规则接口，定义规则的触发条件和效果
  - **TriggerContext**：触发上下文，传递事件相关信息
- **关键功能**：
  - **规则加载**：从JSON文件加载规则定义
  - **触发检查**：检查事件是否满足规则条件
  - **效果执行**：执行规则关联的技能代码
  - **冷却管理**：管理规则的冷却时间

#### 8. 行动点系统 (`lib/game/turn.ts`)
- **功能**：管理玩家的行动点，包括获取、消耗、显示等
- **核心设计**：
  - **行动点增长**：每个回合开始时获得 1 点行动点
  - **行动点上限**：最大行动点为 10 点
  - **行动点消耗**：不同操作消耗不同的行动点
  - **行动点显示**：在游戏界面中显示当前行动点和最大行动点
- **关键功能**：
  - **getActionPoints(playerId)**：获取玩家的当前行动点
  - **deductActionPoints(playerId, amount)**：扣除玩家的行动点
  - **increaseActionPoints(playerId, amount)**：增加玩家的行动点
  - **resetActionPoints()**：重置所有玩家的行动点

#### 9. Toast 通知系统 (`app/layout.tsx`)
- **功能**：提供小型、自动消失的通知，替代传统的大型弹窗
- **核心设计**：
  - **Sonner 集成**：使用 Sonner 库实现 toast 通知
  - **自动消失**：通知会在 5 秒后自动消失
  - **不堆叠**：同一时间只会显示一个通知
  - **位置**：显示在页面顶部中央
- **关键功能**：
  - **toast.success(message)**：显示成功通知
  - **toast.error(message)**：显示错误通知
  - **toast.info(message)**：显示信息通知

#### 10. 规则加载器 (`lib/game/rule-loader.ts`)
- **功能**：加载和解析规则JSON文件，转换为TriggerRule对象
- **核心方法**：
  - `loadRules()`：加载所有规则文件
  - `convertToTriggerRule()`：将规则定义转换为TriggerRule对象
- **规则文件格式**：
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
      "type": "triggerSkill",
      "skillId": "技能ID",
      "message": "触发消息"
    },
    "limits": {
      "cooldownTurns": 冷却回合数,
      "maxUses": 最大使用次数
    }
  }
  ```

### 触发系统详细说明

#### 触发类型

| 触发类型 | 描述 | 传入的 Context 信息 |
|---------|------|-------------------|
| `afterSkillUsed` | 技能使用后 | `piece`（使用技能的棋子）, `skillId`（技能ID） |
| `afterDamageDealt` | 造成伤害后 | `piece`（攻击者）, `targetPiece`（被攻击者）, `damage`（伤害值） |
| `afterDamageTaken` | 受到伤害后 | `piece`（被攻击者）, `targetPiece`（攻击者）, `damage`（伤害值） |
| `afterPieceKilled` | 击杀棋子后 | `piece`（击杀者）, `targetPiece`（被杀者） |
| `afterPieceSummoned` | 召唤棋子后 | `piece`（召唤者）, `targetPiece`（被召唤者） |
| `beginTurn` | 回合开始时 | `piece`（当前回合玩家的棋子） |
| `endTurn` | 回合结束时 | `piece`（当前回合玩家的棋子） |
| `afterMove` | 移动后 | `piece`（移动的棋子） |

#### 触发上下文 (TriggerContext)

触发上下文包含事件相关的所有信息，会传递给被触发的技能代码：

```typescript
interface TriggerContext {
  type: TriggerType;
  sourcePiece?: PieceInstance;     // 事件源棋子
  targetPiece?: PieceInstance;     // 事件目标棋子
  skillId?: string;               // 技能ID（仅在技能相关事件中存在）
  damage?: number;                // 伤害值（仅在伤害相关事件中存在）
  turnNumber?: number;             // 回合数
  playerId?: string;               // 玩家ID
}
```

#### 技能代码中的上下文使用

当规则触发技能时，技能代码可以通过 `context` 参数访问触发事件的相关信息：

```javascript
function executeSkill(context) {
  // 获取击杀者信息
  const killer = context.piece;
  
  // 获取被杀者信息
  const victim = context.targetPiece;
  
  if (killer && victim) {
    // 实现生命汲取效果
    const healAmount = victim.maxHp;
    killer.currentHp = Math.min(killer.currentHp + healAmount, killer.maxHp);
    return { 
      message: killer.templateId + '汲取了' + victim.templateId + '的生命，恢复了' + healAmount + '点生命值', 
      success: true 
    };
  }
  return { message: '没有目标可以汲取生命', success: false };
}
```

#### 规则与技能的关联

1. **创建技能**：在 `data/skills/` 目录创建技能JSON文件，编写技能执行代码
2. **创建规则**：在 `data/rules/` 目录创建规则JSON文件，指定触发条件和要触发的技能
3. **装备技能**：将技能分配给角色，在角色的 `skills` 数组中添加技能
4. **加载规则**：规则会在游戏开始时加载，或者通过 `loadSpecificRules` 方法按需加载

#### 条件规则加载

为了优化性能，规则可以按需加载，而不是一次性加载所有规则：

1. **在棋子JSON中添加规则引用**：
   ```json
   "rules": ["rule-3", "rule-4"]
   ```

2. **在地图JSON中添加规则引用**：
   ```json
   "rules": ["rule-5"]
   ```

3. **使用 `loadSpecificRules` 方法加载规则**：
   ```typescript
   triggerSystem.loadSpecificRules(["rule-3", "rule-4"]);
   ```

### 实现细节

#### 1. 服务器端与客户端分离

- **服务器端**：可以使用 `fs` 模块加载规则文件
- **客户端**：不能使用 `fs` 模块，使用默认规则或通过API获取

#### 2. 错误处理

- 规则加载失败时，使用默认规则作为fallback
- 技能执行失败时，提供错误信息并继续游戏

#### 3. 性能优化

- 规则按需加载，减少内存使用
- 触发检查时使用高效的条件评估
- 冷却管理避免重复计算

### 使用示例

#### 示例1：生命汲取技能

1. **创建技能文件** (`data/skills/soul-harvest.json`)：
   ```json
   {
     "id": "soul-harvest",
     "name": "灵魂收割",
     "description": "当击杀敌人时，获得等同于其最大生命值的生命值",
     "kind": "passive",
     "type": "normal",
     "cooldownTurns": 0,
     "maxCharges": 0,
     "powerMultiplier": 1,
     "code": "function executeSkill(context) {\n  const reaper = context.piece;\n  const victim = context.targetPiece;\n  if (reaper && victim) {\n    const soulPower = victim.maxHp;\n    reaper.maxHp += soulPower;\n    reaper.currentHp += soulPower;\n    return { message: reaper.templateId + '从' + victim.templateId + '的死亡中汲取力量，生命值增加' + soulPower, success: true };\n  }\n  return { message: '没有灵魂可以收割', success: false };\n}",
     "range": "self",
     "requiresTarget": false
   }
   ```

2. **创建规则文件** (`data/rules/soul-harvest.json`)：
   ```json
   {
     "id": "rule-3",
     "name": "灵魂收割",
     "description": "当击杀敌人时，死神获得等同于其最大生命值的生命值",
     "trigger": {
       "type": "afterPieceKilled",
       "conditions": {
         "pieceType": "blue-reaper"
       }
     },
     "effect": {
       "type": "triggerSkill",
       "skillId": "soul-harvest",
       "message": "${source.templateId}触发了灵魂收割技能"
     },
     "limits": {
       "cooldownTurns": 0,
       "maxUses": 0
     }
   }
   ```

3. **在棋子JSON中添加规则引用** (`data/pieces/blue-reaper.json`)：
   ```json
   "rules": ["rule-3"]
   ```

4. **在棋子JSON中添加技能**：
   ```json
   "skills": [
     {
       "skillId": "basic-attack",
       "level": 1
     },
     {
       "skillId": "soul-harvest",
       "level": 1
     }
   ]
   ```
  - **地图图鉴** (`app/encyclopedia/maps/page.tsx`)：展示所有游戏地图的详细信息
- **关键功能**：
  - **角色筛选**：根据阵营筛选棋子
  - **角色详情**：展示棋子的属性、技能和背景信息
  - **地图预览**：可视化展示地图布局
  - **图例说明**：解释地图中的各种元素

### API 接口

#### 1. 房间管理
- `GET /api/rooms/[roomId]`：获取房间信息
- `POST /api/rooms/[roomId]`：加入房间

#### 2. 房间动作 (`POST /api/rooms/[roomId]/actions`)
- **支持的动作**：
  - `join`：加入房间
  - `claim-faction`：领取身份（关键动作）
  - `select-pieces`：选择棋子
  - `start-game`：开始游戏

- **请求格式**：
  ```json
  {
    "action": "claim-faction",
    "playerId": "player-1",
    "playerName": "Player 1"
  }
  ```

- **响应格式**：
  ```json
  {
    "success": true,
    "data": {
      "room": {...}, // 更新后的房间信息
      "faction": "red" // 分配的阵营
    }
  }
  ```

#### 3. 战斗创建 (`POST /api/battle`)
- **功能**：创建新的战斗房间
- **请求格式**：
  ```json
  {
    "playerId": "user-123",
    "playerName": "Player 1",
    "pieces": [
      { "templateId": "red-mage", "faction": "red" },
      { "templateId": "red-warrior", "faction": "red" }
    ]
  }
  ```

- **响应格式**：
  ```json
  {
    "roomId": "room-123",
    "battle": {...} // 初始战斗状态
  }
  ```

#### 4. 身份验证
- `POST /api/auth/register`：注册新用户
  - **请求格式**：`{ "username": "player1", "password": "password123" }`
  - **响应格式**：`{ "userId": "user-123", "username": "player1" }`

- `POST /api/auth/login`：用户登录
  - **请求格式**：`{ "username": "player1", "password": "password123" }`
  - **响应格式**：`{ "userId": "user-123", "username": "player1" }`

#### 5. 棋子数据
- `GET /api/pieces`：获取所有棋子数据
  - **响应格式**：`{ "pieces": [...] }`

#### 6. 地图数据
- `GET /api/maps`：获取所有地图数据
  - **响应格式**：`{ "maps": [...] }`

### 数据模型

#### 1. 玩家
```typescript
type Player = {
  id: string
  name: string
  joinedAt: number
  faction?: "red" | "blue"
  selectedPieces?: Array<{ templateId: string; faction: string }>
  hasSelectedPieces?: boolean
}
```

#### 2. 房间
```typescript
enum RoomStatus {
  WAITING = "waiting",
  PIECE_SELECTION = "piece-selection",
  BATTLE = "battle",
  ENDED = "ended"
}

type Room = {
  id: string
  name: string
  status: RoomStatus
  createdAt: number
  maxPlayers: number
  players: Player[]
  currentTurnIndex: number
  actions: GameAction[]
  battleState: BattleState | null
  selectedPieces?: Array<{ templateId: string; faction: string }>
}
```

#### 3. 棋子模板
```typescript
type PieceTemplate = {
  id: string
  name: string
  faction: string
  description: string
  rarity: string
  image: string
  stats: {
    maxHp: number
    attack: number
    defense: number
    moveRange: number
  }
  skills: Array<{
    skillId: string
    level: number
  }>
  isDefault?: boolean
}
```

#### 4. 游戏动作
```typescript
type GameAction = {
  type: string
  playerId: string
  data: any
  timestamp: number
}
```

#### 5. 技能定义
```typescript
interface SkillDefinition {
  id: string
  name: string
  description: string
  kind: "active" | "passive"
  type: "normal" | "super" | "ultimate" // super 表示充能技能，ultimate 表示限定技
  cooldownTurns: number
  maxCharges: number
  chargeCost?: number
  powerMultiplier: number
  code: string
  previewCode?: string
  range: "single" | "area" | "self"
  areaSize?: number
  requiresTarget: boolean
  actionPointCost: number // 行动点消耗
  icon?: string
}
```

#### 6. 技能状态
```typescript
interface SkillState {
  skillId: string
  currentCooldown: number
  currentCharges: number
  unlocked: boolean
  usesRemaining: number // 剩余使用次数，限定技为1，其他技能为-1（无限制）
}
```

#### 7. 地图定义
```typescript
type MapDefinition = {
  id: string
  name: string
  layout: string[]
  legend: Array<{
    char: string
    type: string
    walkable: boolean
    bulletPassable: boolean
  }>
}
```

#### 8. 战斗状态
```typescript
interface BattleState {
  id: string
  mapId: string
  players: {
    id: string
    name: string
    faction: "red" | "blue"
    actionPoints: number // 当前行动点
    maxActionPoints: number // 最大行动点
    pieces: string[] // 棋子ID列表
  }[]
  pieces: {
    id: string
    templateId: string
    playerId: string
    currentHp: number
    position: { x: number; y: number }
    statusEffects: any[]
    skills: SkillState[]
  }[]
  currentTurnIndex: number
  turnCount: number
  battleLog: string[]
}
```

## 关键功能实现

### 1. 阵营领取系统
- **实现文件**：`lib/game/room-store.ts` 和 `app/api/rooms/[roomId]/actions/route.ts`
- **核心逻辑**：
  1. 玩家调用 `claim-faction` 动作
  2. 服务器检查房间中已分配的阵营
  3. 如果是第一个领取的玩家，随机分配红或蓝
  4. 如果是第二个领取的玩家，分配剩下的阵营
  5. 更新玩家信息和房间状态

### 2. 棋子选择系统
- **实现文件**：`app/piece-selection/page.tsx`
- **核心逻辑**：
  1. 玩家根据分配的阵营查看可用棋子
  2. 红方只能选择红方或中立棋子
  3. 蓝方只能选择蓝方或中立棋子
  4. 玩家选择棋子后，调用 `select-pieces` 动作
  5. 服务器更新玩家的选择信息

### 3. 游戏开始逻辑
- **实现文件**：`app/api/rooms/[roomId]/actions/route.ts`
- **核心逻辑**：
  1. 玩家调用 `start-game` 动作
  2. 服务器检查所有玩家是否已领取阵营
  3. 服务器检查每个玩家是否至少选择了一个棋子
  4. 服务器生成初始战斗状态
  5. 更新房间状态为战斗中

### 4. 核心对战系统
- **实现文件**：`lib/game/turn.ts` 和 `app/battle/[roomId]/page.tsx`
- **核心逻辑**：
  1. **网格系统**：棋子在固定网格上移动，类似国际象棋
  2. **回合结构**：每个回合分为开始阶段、行动阶段和结束阶段
  3. **行动点机制**：
     - 每个玩家在回合开始时获得固定数量的行动点
     - 不同操作消耗不同的行动点
     - 移动：消耗1点行动点
     - 普通技能：消耗1-2点行动点
     - 充能技能：消耗2-3点行动点和相应的充能点
     - 限定技：消耗3点行动点（一局只能使用一次）
  4. **技能释放**：采用点选目标的交互方式
  5. **回合顺序**：固定顺序，玩家轮流行动

### 5. 技能系统
- **实现文件**：`lib/game/skills.ts`
- **核心逻辑**：
  1. **技能执行**：通过`executeSkillFunction`执行技能逻辑
  2. **冷却管理**：技能使用后进入冷却状态
  3. **充能系统**：充能技能需要消耗充能点
  4. **限定技**：一局只能使用一次的技能
  5. **行动点消耗**：根据技能类型消耗相应的行动点

### 6. 图鉴系统
- **实现文件**：`app/encyclopedia/` 目录下的页面文件
- **核心逻辑**：
  1. **角色图鉴**：
     - 从 `/api/pieces` 获取所有棋子数据
     - 支持按阵营筛选棋子
     - 展示每个棋子的详细信息，包括属性、技能等
  2. **地图图鉴**：
     - 从 `/api/maps` 获取所有地图数据
     - 可视化展示地图布局
     - 提供图例说明，解释地图中的各种元素

## 已解决的问题

### 1. 身份分配问题
- **问题**：双方玩家都显示为红方
- **原因**：前端在加入房间时随机生成阵营，而不是从服务器获取实际分配的阵营
- **解决方案**：修改前端代码，在加入房间后调用 `claim-faction` API 来获取实际分配的阵营

### 2. 并发请求问题
- **问题**：当两个请求几乎同时到达时，它们可能会读取到相同的房间状态，然后都随机分配到红方
- **解决方案**：修改后端代码，在处理 `claim-faction` 动作时，重新获取最新的房间状态，确保使用最新的玩家信息

### 3. 游戏开始错误
- **问题**：在游戏开始时显示游戏开始错误
- **原因**：服务器端在检查棋子数量时，是将所有玩家的棋子模板合并在一起后再检查长度，而不是检查每个玩家是否至少选择了一个棋子
- **解决方案**：修改后端代码，添加额外的检查，确保每个玩家至少选择了一个棋子

### 4. 前端状态管理问题
- **问题**：前端在选择棋子时可能会显示所有阵营的棋子，而不是只显示当前玩家阵营的棋子
- **解决方案**：修改前端代码，根据玩家的实际身份来显示对应的棋子选项

### 5. 技能系统实现
- **问题**：技能系统不够灵活，无法实现复杂的技能逻辑
- **解决方案**：实现函数式技能系统，技能逻辑通过JavaScript函数代码实现，存储在JSON文件中，支持动态执行

### 6. 棋子分配问题
- **问题**：双方同时被分配到蓝方
- **原因**：棋子分配逻辑依赖于棋子模板的faction属性，而不是严格按照玩家索引分配阵营
- **解决方案**：修改棋子分配逻辑，确保第一个玩家（索引0）总是获得红方棋子，第二个玩家（索引1）总是获得蓝方棋子

### 7. 棋子位置重叠问题
- **问题**：棋子在棋盘上的位置可能会重叠
- **原因**：棋子生成时没有检查位置是否已被占用
- **解决方案**：添加位置占用检查，确保棋子生成在未被占用的位置

### 8. 技能执行问题
- **问题**：技能执行后没有对敌人造成伤害
- **原因**：技能执行逻辑中使用了错误的变量引用
- **解决方案**：修改技能执行逻辑，使用正确的变量引用，确保技能能够正确伤害敌人

### 9. 技能预览问题
- **问题**：技能描述没有显示计算后的数值，不包括增益和减益效果
- **解决方案**：添加技能预览系统，计算并显示技能的实际效果，包括增益和减益效果

### 10. 传送技能问题
- **问题**：传送技能无法正常工作，显示"Skill definition not found"
- **原因**：技能加载问题，JSON文件格式错误
- **解决方案**：修复JSON文件格式，确保技能能够正确加载，同时添加默认技能逻辑作为fallback

## 开发规范

### 1. 代码风格
- 使用 TypeScript 进行类型检查
- 遵循 ES6+ 语法
- 使用 Prettier 进行代码格式化
- 使用 ESLint 进行代码质量检查

### 2. 命名规范
- **文件命名**：使用小写字母和连字符，如 `room-store.ts`
- **函数命名**：使用驼峰命名法，如 `assignFaction`
- **变量命名**：使用驼峰命名法，如 `playerId`
- **类型命名**：使用 Pascal 命名法，如 `Player`

### 3. 模块化设计
- 将游戏逻辑从 API 路由中分离出来，放到专门的服务层
- 使用模块化的方式组织代码，便于后续添加新内容
- 确保棋子、技能、地图等数据结构的设计便于导入导出

### 4. 数据管理
- **数据存储**：目前使用 JSON 文件存储游戏数据
- **数据结构**：设计统一的导入导出格式
- **数据验证**：实现数据验证机制，确保导入的数据符合游戏要求

### 5. 错误处理
- 使用 try-catch 捕获和处理错误
- 为 API 响应添加统一的错误格式
- 记录关键错误信息以便调试

## 开发计划

### 优先开发功能

#### 1. 核心对战系统
- **网格系统**：实现基础网格地图和棋子移动逻辑
- **回合管理**：实现三阶段回合流程和行动点机制
- **技能系统**：实现点选目标的技能释放、充能系统和限定技
- **战斗逻辑**：实现棋子攻击、技能效果和胜负判断

#### 2. 用户界面
- **风格**：卡通风格的游戏界面
- **战斗界面**：组合展示（信息面板 + 动态效果）
- **棋子选择**：实现分类筛选功能
- **交互优化**：确保流畅的游戏操作体验

#### 3. 棋子和技能系统
- **规模**：棋子数量多，单个棋子技能数量不多，单场比赛棋子数量多
- **平衡性**：动态平衡，根据游戏数据调整
- **技能复杂度**：实现中级功能，支持连击、组合技能等
- **限定技**：为每个棋子添加一局只能使用一次的限定技

#### 4. PVP系统
- **匹配系统**：实现玩家匹配功能
- **房间管理**：完善房间创建和加入系统
- **排行榜**：实现战绩记录和排行榜系统

#### 5. PVE模式（次要功能）
- **难度**：关卡递进的难度设计
- **AI**：实现中级智能的AI对手
- **奖励**：集成排行榜系统

### 技术债务

1. **代码优化**：
   - 将游戏逻辑从 API 路由中分离出来，放到专门的服务层
   - 优化房间存储的并发处理

2. **状态管理**：
   - 考虑使用专门的状态管理库（如 Zustand 或 Redux）来管理游戏状态

3. **数据存储**：
   - 考虑使用数据库（如 SQLite 或 MongoDB）替代 JSON 文件存储

4. **测试**：
   - 添加单元测试和集成测试
   - 实现端到端测试

5. **文档**：
   - 完善 API 文档
   - 添加代码注释和文档

## 快速上手指南

### 开发环境设置
1. **克隆仓库**：`git clone <repository-url>`
2. **安装依赖**：`npm install`
3. **启动开发服务器**：`npm run dev`
4. **访问应用**：打开浏览器访问 `http://localhost:3000`

### 核心功能开发流程

#### 1. 添加新棋子
1. 在 `data/pieces/` 目录中创建新的棋子 JSON 文件，如 `new-piece.json`
2. 确保棋子数据包含所有必要字段，如 id、name、faction、stats、skills 等
3. 测试棋子是否正确显示在图鉴和选择界面
4. 确保棋子的技能 ID 与 `data/skills/` 目录中的技能文件对应

#### 2. 添加新技能
1. 在 `data/skills/` 目录中创建新的技能 JSON 文件，如 `new-skill.json`
2. 填写技能的基本信息，包括 id、name、description、cooldownTurns、actionPointCost 等
3. 编写 `code` 字段，包含技能的执行逻辑，使用函数式编程方式
4. 编写 `previewCode` 字段，包含技能的预览逻辑，用于计算和显示技能效果
5. 测试技能是否正确执行和预览

**技能代码示例**：
```javascript
// 技能执行逻辑
function executeSkill(context) {
  const enemies = select.getEnemiesInRange(3);
  if (enemies.length > 0) {
    enemies.forEach(enemy => {
      const damage = Math.round(sourcePiece.attack * context.skill.powerMultiplier);
      enemy.currentHp = Math.max(0, enemy.currentHp - damage);
    });
    return { message: '对范围内多个目标造成伤害', success: true };
  }
  return { message: '范围内没有可攻击的敌人', success: false };
}

// 技能预览逻辑
function calculatePreview(piece, skillDef) {
  const damage = Math.round(piece.attack * skillDef.powerMultiplier);
  return { description: "对范围内多个目标造成" + damage + "点伤害", expectedValues: { damage } };
}
```

#### 3. 添加新地图
1. 在 `data/maps/` 目录中创建新的地图 JSON 文件，如 `new-map.json`
2. 定义地图的 id、name、layout 和 legend
3. 测试地图是否正确显示在地图图鉴中
4. 确保地图布局符合游戏要求

#### 4. 修改游戏逻辑
1. 在对应的核心模块文件中修改逻辑
2. 更新相关的 API 接口
3. 测试修改是否符合预期

#### 5. 调试技巧
- 使用浏览器开发者工具查看网络请求和控制台日志
- 检查 `data/rooms/` 目录下的房间数据文件
- 使用 `console.log` 在关键位置添加调试信息
- 在技能代码中添加 `console.log` 语句，查看技能执行过程中的变量值

## 代码质量保证

### 代码审查
- 定期进行代码审查，确保代码质量
- 遵循模块化设计原则
- 确保代码符合类型检查要求

### 测试策略
- **单元测试**：测试各个模块的独立功能
- **集成测试**：测试模块之间的交互
- **端到端测试**：测试完整的游戏流程

### 性能优化
- 优化 API 响应时间
- 减少不必要的网络请求
- 优化前端渲染性能

## 未来发展方向

### 功能扩展
- **多人模式**：支持更多玩家的对战
- **团队模式**：支持组队对战
- **排行榜系统**：记录玩家战绩
- **成就系统**：添加游戏成就

### 技术升级
- **数据库迁移**：从 JSON 文件迁移到数据库
- **实时通信**：使用 WebSocket 实现实时游戏状态更新
- **部署优化**：优化部署流程和性能

### 内容创作
- **棋子和技能编辑器**：允许玩家创建自定义棋子和技能
- **地图编辑器**：允许玩家创建自定义地图
- **游戏模式编辑器**：允许玩家创建自定义游戏模式

## 最近的工作内容

### 已完成的功能

1. **状态系统实现**：
   - 创建了完整的状态系统，支持持续效果如流血、中毒等
   - 实现了状态效果的添加、移除和持续时间管理
   - 通过规则系统联动实现状态效果的触发和持续
   - 添加了状态标签（StatusTags）用于存储状态变量
   - 创建了 `lib/game/status-effects.ts` 核心文件
   - 更新了 `data/status-effects/bleeding.json` 和 `data/status-effects/poison.json` 状态文件
   - 创建了 `data/rules/status-bleeding.json` 和 `data/rules/status-poison.json` 规则文件

2. **行动点系统重构**：
   - 实现了炉石传说风格的法力水晶机制
   - 每回合开始时最大行动点增加1点（最高10点）
   - 每回合开始时当前行动点完全恢复
   - 修改了 `lib/game/turn.ts` 中的相关逻辑

3. **房间管理系统修复**：
   - 修复了房间删除问题（删除后不再重新出现）
   - 实现了基于文件系统的房间持久化存储
   - 修复了房间加入问题，确保玩家能够正确加入房间
   - 修复了房间状态同步问题，解决了"未选择棋子"错误
   - 修复了房间重复显示问题
   - 修改了 `lib/game/room-store.ts` 中的房间存储逻辑
   - 更新了 `app/play/page.tsx` 中的房间管理UI

4. **技能系统增强**：
   - 集成了规则系统与技能系统，支持通过规则触发技能代码
   - 实现了伤害类型系统（物理伤害、法术伤害、真实伤害）
   - 实现了技能形态分类（近战、远程、魔法、飞行物、范围、自身）
   - 添加了 `dealDamage` 函数用于统一伤害计算
   - 修复了伤害计算中的防御处理（改为直接减法）
   - 修改了 `lib/game/skills.ts` 中的伤害处理逻辑

5. **触发系统扩展**：
   - 在 `TriggerType` 中添加了 "whenever" 类型，支持每一步行动后检测
   - 实现了更灵活的触发条件和效果执行
   - 修改了 `lib/game/triggers.ts` 中的触发类型定义

6. **棋子系统更新**：
   - 为棋子实例添加了 `ruleTags` 和 `statusTags` 字段
   - 支持状态变量的存储和管理
   - 修改了 `lib/game/piece.ts` 中的 `PieceInstance` 接口

7. **教程文档更新**：
   - 更新了 `tutorial.md`，添加了状态系统的编写指南
   - 提供了状态效果的示例代码和使用方法
   - 详细说明了如何通过规则系统实现持续效果

8. **战斗系统优化**：
   - 实现了战斗状态管理和游戏结束检测
   - 优化了回合管理和行动点分配
   - 修改了 `app/battle/[roomId]/page.tsx` 中的战斗逻辑

9. **API 接口修复**：
   - 修复了 `app/api/rooms/[roomId]/route.ts` 中的游戏开始逻辑
   - 修复了 `app/api/rooms/[roomId]/actions/route.ts` 中的棋子选择和房间加入逻辑
   - 确保了玩家ID的一致性处理（添加了trim()操作）

10. **规则系统实现**：
    - 创建了完整的触发-效果系统，支持"当……的时候，执行……效果"的规则
    - 实现了规则加载器，从JSON文件加载规则定义
    - 支持条件规则加载，只在选择特定棋子或地图时加载相关规则
    - 实现了服务器端与客户端的兼容性，解决了fs模块在客户端无法使用的问题

11. **技能系统修复**：
    - 修复了Teleport技能使用后没有进入冷却的问题
    - 添加了技能冷却管理，在技能使用后设置冷却时间，在回合开始时减少冷却
    - 更新了技能执行上下文，确保技能函数能够访问触发事件的相关信息
    - 修复了技能名称显示问题，确保显示实际名称而不是ID
    - 修复了战斗日志显示技能执行消息的问题
    - 修复了蓝方射手的攻击强化技能不工作的问题
    - 移除了硬编码，严格从文件加载技能

12. **角色系统**：
    - 创建了新角色"死神"（Reaper），具有灵魂收割被动技能
    - 实现了灵魂收割技能，当击杀敌人时获得等同于其最大生命值的最大生命值

13. **图鉴系统改进**：
    - 为所有图鉴页面添加了返回主菜单的按钮
    - 优化了图鉴页面的导航体验

14. **技能工具提示功能**：
    - 实现了光标移到技能身上时显示技能介绍的功能
    - 在技能工具提示中显示充能技能所需的充能点数
    - 在技能工具提示中显示剩余冷却回合数而不是固定的冷却时间

15. **地图系统**：
    - 创建了16x20的大型战场地图
    - 实现了房主机制，允许房主选择使用哪张地图
    - 修复了地图加载问题，确保地图能够正确显示
    - 为地图添加了完整的图例，包括缺失的 'S'（spawn）和 'H'（hole）类型

16. **界面改进**：
    - 修改了棋子界面的生命值显示，使用"当前/最大"格式

17. **Toast 通知系统**：
    - 集成了 Sonner toast 通知系统，替代传统的大型弹窗
    - 实现了小型提示框，显示在页面顶部中央
    - 配置了自动消失功能，通知会在 5 秒后自动消失
    - 确保通知不堆叠，同一时间只会显示一个通知
    - 替换了所有游戏结束、无效操作等场景的弹窗为 toast 通知

18. **移动范围限制**：
    - 实现了基于棋子 moveRange 属性的移动距离限制
    - 确保棋子只能移动到其移动范围内的格子

### 遇到的问题和解决方案

1. **状态系统实现问题**：
   - **问题**：初始实现使用了多个回调函数（onApply, onTick, onRemove）处理不同时机的效果
   - **原因**：设计不够灵活，无法充分利用规则系统
   - **解决方案**：完全重设计状态系统，通过规则系统联动实现持续效果，使用状态标签存储持续时间

2. **防御计算错误**：
   - **问题**：初始防御计算使用百分比减少，不符合预期
   - **原因**：设计时采用了错误的防御计算公式
   - **解决方案**：修改伤害计算，将防御改为直接减法（`baseDamage - defense`）

3. **状态效果持续时间管理**：
   - **问题**：最初在JSON中添加duration标签管理持续时间
   - **原因**：与状态标签系统冲突，不够灵活
   - **解决方案**：移除JSON中的duration标签，通过StatusTags存储持续时间变量

4. **行动点不增长问题**：
   - **问题**：行动点没有自然增长，不符合炉石传说风格的机制
   - **原因**：初始实现缺少行动点自动增长逻辑
   - **解决方案**：实现炉石传说风格的法力水晶机制，每回合最大行动点增加1点（最高10点），当前行动点完全恢复

5. **房间删除问题**：
   - **问题**：删除房间后刷新页面又重新出现
   - **原因**：房间存储没有持久化到文件系统，或文件系统操作失败
   - **解决方案**：实现基于文件系统的房间持久化存储，确保删除操作正确同步到文件系统

6. **房间加入问题**：
   - **问题**：玩家无法正确加入房间，或加入后状态不同步
   - **原因**：API路由中的房间加入逻辑有误，或玩家ID处理不一致
   - **解决方案**：修复API路由中的房间加入逻辑，确保玩家ID的一致性处理（添加trim()操作）

7. **未选择棋子错误**：
   - **问题**：玩家选择棋子后仍然显示"未选择棋子"状态
   - **原因**：前端状态检查逻辑有误，或后端状态同步问题
   - **解决方案**：修改前端状态检查逻辑，确保正确读取玩家的选择状态，同时修复后端状态同步

8. **游戏已在进行或已结束错误**：
   - **问题**：进入游戏界面时提示"game is already in progress or finished"
   - **原因**：房间状态管理有误，或房间数据丢失
   - **解决方案**：实现房间持久化存储，确保房间状态正确保存和加载

9. **房间未找到错误**：
   - **问题**：选择棋子后进入战斗时显示"Room not found"
   - **原因**：房间数据丢失，或API路由中的房间获取逻辑有误
   - **解决方案**：修复API路由中的房间获取逻辑，确保房间数据正确加载

10. **规则系统兼容性问题**：
    - **问题**：Module not found: Can't resolve 'fs'
    - **原因**：规则加载器使用了fs模块，而该模块在客户端代码中不可用
    - **解决方案**：
      - 修改file-loader.ts，添加条件导入，只在服务器端使用fs模块
      - 修改triggers.ts，移除对rule-loader的直接依赖，确保客户端代码可以正常运行
      - 实现默认规则集，当在客户端无法加载规则文件时使用

11. **技能冷却问题**：
    - **问题**：Teleport技能使用后没有进入冷却
    - **原因**：技能系统缺少冷却管理逻辑
    - **解决方案**：
      - 在useBasicSkill和useChargeSkill函数中添加技能冷却设置
      - 在beginPhase函数中添加冷却减少逻辑，在每个回合开始时减少技能冷却
      - 为PieceSkill接口添加currentCooldown属性，支持技能冷却状态跟踪

12. **技能系统问题**：
    - **问题**：攻击强化技能无法增加攻击力
    - **原因**：技能执行时，sourcePiece的修改没有正确反映到battle状态中
    - **解决方案**：修改executeSkillFunction函数，直接操作battle.pieces中的元素，确保修改能够正确反映到battle状态中

13. **技能执行环境问题**：
    - **问题**：技能代码中的修改操作没有生效
    - **解决方案**：为buff-attack技能添加特殊处理，不再使用eval执行技能代码，而是直接在函数中执行修改操作

14. **技能加载问题**：
    - **问题**：技能从JSON文件中加载时出现问题
    - **解决方案**：修复JSON文件格式，确保技能能够正确加载，同时添加默认技能逻辑作为fallback

15. **API返回格式问题**：
    - **问题**：API返回对象而前端期望数组
    - **解决方案**：修改API路由，返回数据在正确的格式中，例如`{ pieces: [...] }`

16. **JSON格式错误**：
    - **问题**：buff-attack.json文件中存在JSON格式错误
    - **解决方案**：修复JSON格式，确保文件能够正确解析

17. **地图加载问题**：
    - **问题**：地图无法正确加载，缺少必要的图例条目
    - **解决方案**：为地图添加完整的图例，包括 'S'（spawn）和 'H'（hole）类型

18. **游戏开始错误**：
    - **问题**：房间中有两个玩家但显示玩家数量不足
    - **解决方案**：优化了玩家计数逻辑，确保游戏能够在有两个玩家时正确开始

19. **移动范围问题**：
    - **问题**：棋子可以移动任意距离，没有限制
    - **解决方案**：实现了基于棋子 moveRange 属性的移动距离限制

20. **通知系统问题**：
    - **问题**：使用大型弹窗显示无效操作，影响游戏体验
    - **解决方案**：集成了 Sonner toast 通知系统，使用小型提示框替代大型弹窗

### 技术实现细节

1. **状态系统实现**：
   - **核心文件**：创建了`lib/game/status-effects.ts`，实现了状态效果的添加、移除和管理
   - **状态文件**：更新了`data/status-effects/bleeding.json`和`data/status-effects/poison.json`，使用新格式
   - **规则文件**：创建了`data/rules/status-bleeding.json`和`data/rules/status-poison.json`，实现状态效果的触发逻辑
   - **规则联动**：通过规则系统实现状态效果的持续和触发，使用"whenever"触发类型
   - **状态标签**：为棋子实例添加`statusTags`字段，用于存储状态变量如持续时间
   - **动态规则创建**：实现了`addStatusEffect`方法，自动创建和关联规则

2. **行动点系统重构**：
   - **炉石风格机制**：修改`lib/game/turn.ts`，实现每回合最大行动点增加1点（最高10点）
   - **完全恢复**：每回合开始时当前行动点完全恢复
   - **上限控制**：确保行动点不超过最大上限10点
   - **显示优化**：在`app/battle/[roomId]/page.tsx`中显示当前行动点和最大行动点

3. **房间管理系统修复**：
   - **持久化存储**：修改`lib/game/room-store.ts`，实现基于文件系统的房间存储
   - **文件操作**：确保房间创建、更新、删除操作正确同步到文件系统
   - **状态同步**：修复房间状态同步问题，确保前端和后端状态一致
   - **ID处理**：统一玩家ID处理，添加trim()操作确保一致性
   - **UI更新**：修改`app/play/page.tsx`，优化房间管理UI和删除逻辑

4. **技能系统增强**：
   - **伤害类型**：实现物理伤害、法术伤害、真实伤害三种类型
   - **技能形态**：添加近战、远程、魔法、飞行物、范围、自身等技能形态
   - **伤害计算**：实现`dealDamage`函数，支持防御减免和伤害类型处理
   - **规则集成**：支持通过规则触发技能代码，实现更复杂的效果
   - **冷却管理**：实现技能冷却设置和减少逻辑

5. **触发系统扩展**：
   - **新增触发类型**：在`TriggerType`中添加"whenever"类型，支持每一步行动后检测
   - **灵活触发**：实现更灵活的触发条件和效果执行
   - **上下文传递**：完善TriggerContext，传递更丰富的事件信息

6. **棋子系统更新**：
   - **接口扩展**：修改`lib/game/piece.ts`中的`PieceInstance`接口，添加`ruleTags`和`statusTags`字段
   - **状态管理**：支持通过statusTags存储和管理状态变量

7. **战斗系统优化**：
   - **状态管理**：实现战斗状态管理和游戏结束检测
   - **回合优化**：优化回合管理和行动点分配
   - **UI改进**：提升战斗界面的用户体验

8. **API接口修复**：
   - **游戏开始逻辑**：修复`app/api/rooms/[roomId]/route.ts`中的游戏开始逻辑
   - **棋子选择**：修复`app/api/rooms/[roomId]/actions/route.ts`中的棋子选择逻辑
   - **房间加入**：确保玩家能够正确加入房间并同步状态

9. **规则系统实现**：
   - **触发系统**：创建了`lib/game/triggers.ts`，实现了事件驱动的触发-效果系统
   - **规则加载器**：创建了`lib/game/rule-loader.ts`，负责从JSON文件加载规则定义
   - **条件规则加载**：实现了`loadSpecificRules`方法，只在选择特定棋子或地图时加载相关规则
   - **技能集成**：规则触发时执行技能代码，而不是直接定义效果，提高了灵活性
   - **上下文传递**：实现了TriggerContext，传递事件相关信息给技能函数

10. **Toast 通知系统实现**：
    - **Sonner 集成**：在`app/layout.tsx`中添加了Sonner Toaster组件
    - **配置**：设置了通知位置为"top-center"，持续时间为5000ms
    - **使用**：在游戏结束、无效操作等场景中使用`toast.success()`、`toast.error()`等方法显示通知
    - **替换**：替换了所有传统的alert()和大型弹窗为toast通知

11. **地图加载修复**：
    - **直接读取**：修改了`lib/game/map-repository.ts`，直接从文件系统读取地图文件
    - **图例完善**：为地图添加了完整的图例，包括'spawn'和'hole'类型
    - **异步加载**：更新了`lib/game/battle-setup.ts`，使用`await loadMaps()`进行异步地图加载

12. **服务器端与客户端分离**：
    - **文件加载器改进**：修改`lib/game/file-loader.ts`，添加条件导入，只在服务器端使用fs模块
    - **默认规则**：在客户端无法加载规则文件时，使用内置的默认规则集
    - **代码分离**：确保客户端代码不依赖服务器端特有的模块

13. **地图选择系统**：
    - 在创建房间时添加地图选择下拉框
    - 在房间信息中显示所选地图
    - 确保房主能够选择使用哪张地图

14. **房间可见性系统**：
    - 在创建房间时添加可见性选择（公开/私密）
    - 在大厅中显示其他玩家创建的公开房间
    - 在房间信息中显示房主和地图信息

15. **技能工具提示**：
    - 使用hover效果显示技能详细信息
    - 计算并显示技能的预期效果，包括伤害值、增益值等
    - 显示技能的冷却时间和充能点数需求

16. **生命值显示格式**：
    - 修改棋子界面的生命值显示，使用"当前/最大"格式
    - 确保所有棋子的生命值显示一致

## 总结

本项目已经完成了基础框架的搭建和核心系统的实现，包括房间管理、阵营领取、棋子选择、游戏开始逻辑、图鉴系统、行动点系统、toast 通知系统等。最近的工作重点是实现了完整的状态系统、行动点系统重构、房间管理系统修复等核心功能，为游戏添加了更多策略性和深度。

### 主要成果

1. **状态系统**：实现了完整的状态系统，支持持续效果如流血、中毒等，通过规则系统联动实现状态效果的触发和持续。

2. **行动点系统**：重构为炉石传说风格的法力水晶机制，每回合最大行动点增加1点（最高10点），当前行动点完全恢复。

3. **房间管理系统**：修复了房间删除问题，实现了基于文件系统的房间持久化存储，确保房间状态正确保存和加载。

4. **技能系统增强**：实现了伤害类型系统（物理伤害、法术伤害、真实伤害）和技能形态分类，添加了统一的伤害计算函数。

5. **触发系统扩展**：添加了"whenever"触发类型，支持每一步行动后检测，实现更灵活的触发条件和效果执行。

6. **棋子系统更新**：为棋子实例添加了`ruleTags`和`statusTags`字段，支持状态变量的存储和管理。

7. **教程文档更新**：更新了教程文档，添加了状态系统的编写指南和示例代码。

8. **战斗系统优化**：实现了战斗状态管理和游戏结束检测，优化了回合管理和行动点分配。

9. **API 接口修复**：修复了游戏开始逻辑、棋子选择逻辑和房间加入逻辑，确保玩家能够正确加入房间并开始游戏。

10. **规则系统**：实现了完整的触发-效果系统，支持"当……的时候，执行……效果"的规则，提高了游戏的策略性和可玩性。

11. **技能系统修复**：修复了技能冷却问题，确保所有技能都能正确进入冷却状态。

12. **角色系统**：创建了新角色"死神"（Reaper），展示了规则系统的强大功能。

13. **图鉴系统改进**：为所有图鉴页面添加了返回主菜单的按钮，优化了图鉴页面的导航体验。

14. **Toast 通知系统**：集成了 Sonner toast 通知系统，替代了传统的大型弹窗，提供了更好的用户体验。

15. **地图系统修复**：修复了地图加载问题，确保地图能够正确显示，为游戏提供了稳定的战场环境。

16. **移动范围限制**：实现了基于棋子 moveRange 属性的移动距离限制，使游戏更加平衡和策略性。

### 技术亮点

- **状态系统设计**：通过规则系统联动实现状态效果，使用状态标签存储持续时间，设计灵活且可扩展。
- **行动点机制**：实现炉石传说风格的法力水晶机制，每回合最大行动点增加1点，当前行动点完全恢复。
- **房间持久化**：基于文件系统的房间存储，确保房间状态正确保存和加载，解决了房间删除后重新出现的问题。
- **伤害系统**：实现三种伤害类型（物理、法术、真实）和统一的伤害计算函数，支持防御减免。
- **技能形态**：添加多种技能形态分类，为游戏增加更多策略性。
- **事件驱动架构**：规则系统采用事件驱动的设计，使游戏逻辑更加清晰和可扩展。
- **JSON配置**：通过JSON文件配置规则和技能，减少了硬编码，提高了可维护性。
- **条件加载**：实现了规则的条件加载，优化了性能，减少了内存使用。
- **技能集成**：规则触发时执行技能代码，而不是直接定义效果，提高了灵活性和可扩展性。
- **上下文传递**：实现了完善的上下文传递机制，确保技能函数能够访问触发事件的相关信息。
- **Toast 通知**：集成了现代化的 Sonner toast 通知系统，提供了更好的用户体验。
- **地图系统**：实现了基于文件系统的地图加载，确保地图能够正确显示和处理。
- **移动系统**：实现了基于棋子属性的移动范围限制，使游戏更加平衡和策略性。
- **API 优化**：修复了多个API接口问题，确保玩家能够正确加入房间并开始游戏。
- **状态同步**：确保前端和后端状态一致，解决了"未选择棋子"错误等问题。

### 下一步发展方向

1. **核心对战系统**：继续完善核心对战系统，实现限定技技能类型和更多战斗机制。

2. **状态系统扩展**：
   - 添加更多状态效果类型，如 buff、debuff、控制效果等。
   - 实现状态效果的叠加和冲突处理机制。
   - 添加状态效果的视觉表现，使玩家能够直观地看到状态效果。

3. **用户界面**：完善游戏界面，特别是战斗界面，确保状态效果和行动点能够直观地展示给玩家。

4. **内容创作**：基于状态系统和规则系统，创建更多具有独特机制的棋子和技能，丰富游戏内容。

5. **性能优化**：进一步优化状态系统和规则系统的性能，确保在复杂场景下也能流畅运行。

6. **PVE 模式**：实现 PVE 模式，包括 AI 对手、关卡设计等。

7. **排行榜系统**：实现玩家战绩记录和排行榜系统。

8. **多人模式**：支持更多玩家的对战模式，如 2v2 团队对战。

9. **自定义内容**：实现棋子和技能编辑器，允许玩家创建自定义棋子和技能。

10. **网络优化**：优化网络通信，减少延迟，确保多人对战的流畅体验。

通过本文档，新的开发者可以快速了解项目的结构、功能和开发规范，特别是新加入的状态系统、行动点系统和房间管理系统，从而立即接手开发工作，继续推进游戏的发展。这些系统的实现为游戏添加了更多策略性和深度，为后续的内容创作和功能扩展奠定了坚实的基础。