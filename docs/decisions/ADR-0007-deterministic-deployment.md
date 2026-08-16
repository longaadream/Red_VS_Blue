# ADR-0007：固定全地图部署与玩家独立重投流

- 状态：已接受
- 日期：2026-08-16
- 人工批准：2026-08-16
- 关联任务：RED-29
- 风险：High

## 背景

Demo v0.1 要求在固定大型洞穴地图上为双方 16 枚核心棋子生成可回放的共享随机站位，并允许每方最多重投一枚自己的核心棋子。旧初始化按输入数组顺序反复抽格，地图状态 ID 还错误沿用了文件名 `large-trap-arena`；它既不能冻结消费次数，也没有部署阶段、核心身份或单棋子重投协议。

## 决策

### 地图、核心棋子与初始部署

- 权威入口固定请求地图状态 ID `large-hole-arena`；数据文件继续名为 `large-trap-arena.json`。部署入口找不到该 ID 时失败关闭，不回退到其他地图。
- 出生池只含 `walkable === true && type === "floor"` 的格子，并按 `(y, x)` 排序。
- 两名玩家按稳定 `playerId` 排序；每名玩家保留已验证阵容内部顺序。初始 16 枚标记 `isCore: true`，召唤入口强制写入 `isCore: false`。
- `deployment` 流执行 16 步 partial Fisher–Yates。第 `i` 步只消费一次随机值，在剩余池中交换并取出一个格子，因此固定消费 16 次且不重复。

### 状态机与重投

- 初始化状态为 `deployment.status = "awaiting-choices"`。完成前只接受 `deploymentChoice`，普通战斗动作全部拒绝；`gameStart` 延后到部署完成后的首个 `beginPhase`。
- 命令为 `{ type: "deploymentChoice", playerId, pieceId?, clientActionId? }`。空 `pieceId` 表示全部保留；提交后不可用新的 action ID改选。
- 第一份选择只写入状态，不移动棋子、不消费重投随机。双方选择齐备后按稳定玩家 ID 顺序一次解析。
- 每方使用 `deployment-reroll/<playerId>` 独立流。候选池排除该棋子的原位置和所有存活棋子的当前占位，排序后只消费一次随机值。规范化解析顺序使网络到达顺序不改变最终站位。
- 未知、敌方、非核心、死亡、未放置、重复或非部署阶段选择均失败且不提交状态或 cursor。

### Trace 与传输

- 初始化 trace 记录初始位置和 `deployment` cursor。
- 部署动作 trace 记录已提交选择；完成动作同时记录最终位置和两个玩家重投流的起止 cursor。
- HTTP 与 WebSocket 不实现单独规则，继续调用同一 `runBattleAction()` 权威入口。
- 客户端字段脱敏、正式锁定/计时与动画由后续任务负责。

## 备选方案

- 每份选择到达后立即移动：不采用；第二份选择会观察不同占位并让结果依赖网络顺序。
- 双方共用一个重投流：不采用；一方是否重投会改变另一方结果。
- 为每位玩家划分半场或出生区：不采用；违反共享全地图出生池合同。
- 修改 Mulberry32 或 RED-28 派生公式：不采用；会破坏已有回放兼容。

## 影响

- 新战斗在部署完成前不会进入行动阶段或触发开局规则。
- 地图状态 ID 从错误的文件名式值更正为 `large-hole-arena`；地图布局和文件名不变。
- 新增可序列化部署状态与核心身份，但保持 `BATTLE_STATE_VERSION = 1` 和既有 `{ seed, state }` 包装，不引入存档迁移。
- 修改已冻结的 16 次初始消费、流名或解析顺序属于新的 High Risk 兼容性决策。

## 验证方式

- 固定 seed/不同 seed、玩家数组交换、普通地板与唯一位置测试。
- 保留全部、单枚重投、提交顺序交换、原位置排除和独立流 cursor 测试。
- 非法命令状态不污染、核心/召唤身份、HTTP/WS 等价测试。
- TypeScript、核心规则测试、browser GameEngine 构建和固定 seed trace 证据。

## 回退方式

RED-29 作为独立提交/PR 回退，恢复旧的立即开战入口和旧地图 ID。回退不修改地图布局、棋子池、RED-28 随机算法、存档版本或 `{ seed, state }` 包装。

## 相关资料

- [RED-29](https://linear.app/redvsblue/issue/RED-29)
- [Demo v0.1 核心对局合同](../product/DEMO_V0_1_CORE_MATCH_CONTRACT.md)
- [ADR-0004：确定性规则运行时](./ADR-0004-deterministic-rule-runtime.md)
- `tests/game/deployment.test.ts`
- `tests/roster-transports.test.ts`
