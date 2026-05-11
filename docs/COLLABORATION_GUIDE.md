# 协作开发指南

本文档用于约定 PVP 与 PVE 并行开发时的边界、目录、接口和合并流程。目标是让两个模式可以独立推进，同时共享必要的资源与基础能力，避免互相改坏。

## 总体分工

### PVP / 总体框架

负责人：项目主维护者。

职责范围：

- PVP 模式修缮。
- 总体 UI、导航、大框架与客户端结构。
- 联机、账号、房间、WebSocket、局域网与远程服务器逻辑。
- 共享战斗核心的稳定性与兼容性。
- 最终合并、发布与资源包构建。

### PVE / 单人模式

负责人：PVE 开发者。

职责范围：

- 独立的 PVE 入口与页面。
- 单人 Roguelike / 关卡 / 事件 / 奖励 / 成长系统。
- PVE 专属棋子、技能、卡牌、地图、敌人编排与模式规则。
- PVE 内部 UI 与交互原型。
- 在不破坏 PVP 的前提下，复用部分共享棋子、技能与战斗能力。

PVE 第一阶段只做单人版本，不接入账号、联机、房间、WebSocket 或服务器匹配逻辑。

## 核心原则

1. PVE 是独立入口，不复用 PVP 大厅作为主流程。
2. PVE 可以复用部分棋子、技能、卡牌、地图与基础战斗能力。
3. PVE 引擎能力应在 PVP 基础上扩展，但不能直接修改 PVP 已有核心文件。
4. PVP 与 PVE 都可以独立完善，合并时通过清晰的数据结构和 adapter 接口对接。
5. 所有共享改动必须优先保证 PVP 不被破坏。

## 推荐目录边界

### 共享数据

这些目录属于共享资源，PVP 和 PVE 都可以读取：

```text
data/pieces/
data/skills/
data/cards/
data/maps/
data/effects/
data/skill-keywords.json
```

规则：

- 修改共享数据前，需要确认不会影响 PVP 现有表现。
- 如果某个资源只给 PVE 使用，优先放入 `data/pve/`，不要混入共享目录。
- 如果确实需要把 PVE 资源放进共享目录，需要在资源 JSON 中标记适用模式。

推荐字段：

```json
{
  "id": "example-piece",
  "name": "示例棋子",
  "modes": ["pve"]
}
```

### PVE 专属数据

PVE 新内容优先放在：

```text
data/pve/
```

建议子目录：

```text
data/pve/runs/
data/pve/chapters/
data/pve/encounters/
data/pve/events/
data/pve/rewards/
data/pve/relics/
data/pve/enemies/
data/pve/pieces/
data/pve/skills/
data/pve/cards/
data/pve/maps/
```

建议含义：

- `chapters/`：章节、路线、主题。
- `encounters/`：单场战斗配置，包括敌人、地图、胜负条件。
- `events/`：非战斗事件。
- `rewards/`：奖励池与奖励生成规则。
- `relics/`：遗物、被动成长、模式专属强化。
- `enemies/`：敌方队伍模板或 AI 配置。
- `pieces/`、`skills/`、`cards/`、`maps/`：PVE 专属资源。

### PVP 专属数据

如果未来需要区分 PVP 专属配置，放在：

```text
data/pvp/
```

当前可以先不建立，等 PVP 规则确实需要模式化配置时再加。

## 代码边界

### 不允许 PVE 直接修改的核心文件

PVE 开发者不要直接修改以下已有 PVP 核心文件：

```text
lib/game/battle-setup.ts
lib/game/battle-types.ts
lib/game/file-loader.ts
lib/game/map-repository.ts
lib/game/piece.ts
lib/game/piece-repository.ts
lib/game/room-store.ts
lib/game/rule-loader.ts
lib/game/skill-repository.ts
lib/game/skills.ts
lib/game/triggers.ts
lib/game/turn.ts
```

这些文件属于 PVP 兼容性核心。需要改动时，应先提出接口需求，由主维护者决定是否抽象成共享接口。

### PVE 可以新增的代码位置

PVE 可以新增文件：

```text
lib/game/pve-*.ts
lib/pve/
app/pve/
components/pve/
data/pve/
tests/pve/
```

推荐优先使用：

```text
lib/pve/
```

用于放置 PVE run、关卡、奖励、成长、AI、事件等逻辑。

### 推荐接口层

如果 PVE 需要调用战斗核心，不要直接在页面里拼装复杂战斗状态。建议通过 adapter：

```text
lib/pve/pve-engine-adapter.ts
```

职责：

- 把 PVE encounter 配置转换成战斗初始状态。
- 注入 PVE 专属胜负条件、奖励结算、敌方行为。
- 从战斗结果中提取 PVE run 进度。
- 屏蔽 PVP 房间、账号、联机相关逻辑。

## PVE 数据草案

当前已提供 PVE 开发入口：

```text
data/pages/pve.html
android-client/www/js/pve-api.js
data/pve/
app/api/pve/route.ts
```

协作者可以先通过 `pve.html` 开发单人流程，通过 `window.RvBPve` 读取 `data/pve/` 中的章节、遭遇、事件、奖励、遗物与敌人配置。服务端调试时也可以请求 `GET /api/pve` 查看聚合后的 PVE 数据。

### Encounter

```json
{
  "id": "pve-encounter-001",
  "name": "林间伏击",
  "mapId": "pve-forest-01",
  "playerSetup": {
    "maxPieces": 3,
    "allowedPiecePools": ["shared-starter", "pve-starter"]
  },
  "enemySetup": {
    "teamId": "bandit-team-01",
    "aiProfile": "aggressive"
  },
  "winCondition": {
    "type": "defeat-all-enemies"
  },
  "rewards": ["starter-card-reward", "minor-relic-reward"]
}
```

### Reward

```json
{
  "id": "minor-relic-reward",
  "type": "relic-choice",
  "count": 3,
  "pool": ["common-relics"]
}
```

### Relic

```json
{
  "id": "quick-preparation",
  "name": "快速整备",
  "description": "每场战斗开始时，抽 1 张牌。",
  "hooks": ["battle-start"]
}
```

这些格式只是第一版约定，可以随着 PVE 原型推进再调整。

## UI 边界

PVE 开发者负责：

- `app/pve/` 下的 PVE 页面。
- `components/pve/` 下的 PVE 专属组件。
- PVE 内部流程，如地图路线、事件选择、奖励选择、战斗前准备。

主维护者负责：

- 顶层导航入口。
- 全局视觉统一。
- PVP 与 PVE 共用组件的最终抽象。
- Electron / Android 客户端外壳与整体体验。

如果 PVE 页面需要全局布局能力，优先提出需求，不要直接重构全局 `app/layout.tsx`、`app/page.tsx` 或客户端主框架。

## 分支与提交流程

推荐分支：

```text
main
feature/pve
feature/pvp-framework
```

建议流程：

1. 主维护者在 `main` 或 `feature/pvp-framework` 上继续推进 PVP 与总体框架。
2. PVE 开发者从最新 `main` 创建 `feature/pve`。
3. PVE 开发者主要提交这些目录：

```text
data/pve/
lib/pve/
app/pve/
components/pve/
tests/pve/
```

4. 如果 PVE 需要共享接口，先通过文档或 issue 描述需求。
5. 主维护者提供或批准共享接口后，PVE 再接入。
6. 合并前检查 PVP 是否仍可正常启动、创建房间、进入战斗。

## 合并前检查清单

PVE 分支合并前至少确认：

- 没有直接修改 PVP 核心战斗文件，或所有修改已经得到主维护者确认。
- 没有改动账号、联机、房间、WebSocket、局域网/远程服务器逻辑。
- PVE 入口可以独立打开。
- PVE 数据都在 `data/pve/` 或明确标记了 `modes: ["pve"]`。
- 共享棋子、技能、卡牌的修改不会改变 PVP 预期表现。
- 新增 UI 没有破坏全局布局。
- 没有提交 `dist/`、`node_modules/`、`.next/`、日志、房间运行时数据或构建产物。

## 需要主维护者确认的事项

PVE 开发中遇到以下需求时，需要先同步：

- 想修改 `lib/game/*` 中已有核心文件。
- 想改变共享棋子、技能、卡牌的 PVP 表现。
- 想接入账号、存档云同步、联机或服务器。
- 想改动全局导航、客户端启动流程或 Electron / Android 外壳。
- 想新增会影响资源包结构的构建流程。

## 短期建议

第一阶段 PVE 不追求完整 Roguelike 体量，先做一个可玩的纵切版本：

1. 一个独立 PVE 入口。
2. 三场固定 encounter。
3. 一套简单奖励池。
4. 两三个遗物。
5. 一个 PVE 专属敌人或棋子。
6. 战斗胜利后能进入下一关。

这样可以尽早验证 PVE 是否真的能降低新玩家门槛，同时不会把系统复杂度一次拉爆。
