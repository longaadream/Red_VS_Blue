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
- **当前版本**：基础框架搭建完成
- **已实现功能**：
  - 房间创建和加入系统
  - 阵营领取机制（红方/蓝方）
  - 棋子选择系统
  - 游戏开始逻辑
  - 基础 API 接口
  - 角色和地图图鉴系统
- **待实现功能**：
  - 核心对战系统（棋子移动、攻击、技能使用）
  - 回合管理系统
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
    1. **开始阶段**：处理回合开始的效果，如buff/debuff的持续时间更新
    2. **行动阶段**：玩家执行操作的主要阶段
    3. **结束阶段**：处理回合结束的效果，如自动回复等
  - **行动规则**：在行动阶段，一个玩家可以：
    - 使一个友方棋子行动（和国际象棋中的车一样）
    - 使用一个友方棋子的普通技能
    - 使用一个友方棋子的充能技能（至多一次）
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
  type: "normal" | "super" // super 表示充能技能
  cooldownTurns: number
  maxCharges: number
  chargeCost?: number
  powerMultiplier: number
  code: string
  previewCode?: string
  range: "single" | "area" | "self"
  areaSize?: number
  requiresTarget: boolean
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
  3. **行动规则**：在行动阶段，玩家可以：
     - 使一个友方棋子行动（和国际象棋中的车一样）
     - 使用一个友方棋子的普通技能
     - 使用一个友方棋子的充能技能（至多一次）
  4. **充能系统**：击杀敌人会获得充能点，充能点足够了才可以使用充能技能
  5. **技能释放**：采用点选目标的交互方式
  6. **回合顺序**：固定顺序，玩家轮流行动

### 5. 图鉴系统
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
- **回合管理**：实现三阶段回合流程和行动规则
- **技能系统**：实现点选目标的技能释放和充能系统
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
2. 填写技能的基本信息，包括 id、name、description、cooldownTurns 等
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

## 总结

本项目已经完成了基础框架的搭建，包括房间管理、阵营领取、棋子选择、游戏开始逻辑和图鉴系统。核心功能已经实现，并且解决了几个关键问题。下一步需要重点开发核心对战系统和完善用户界面，同时逐步解决技术债务，为游戏的后续发展做好准备。

通过本文档，新的开发者可以快速了解项目的结构、功能和开发规范，从而立即接手开发工作，继续推进游戏的发展。