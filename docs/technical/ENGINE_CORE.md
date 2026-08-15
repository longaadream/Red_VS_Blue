# 游戏引擎核心

状态：RED-9 代码核对稿

基线：`594977b`

本文是规则实现参考，不要求项目负责人逐节审批。出现回合、技能、随机、存档或胜负问题时，再阅读对应章节。

## 1. 核心状态和命令

当前主要公共定义位于 `lib/game/turn.ts`：

- `BATTLE_STATE_VERSION = 1`
- `BattleState`：棋子、地图、回合、规则、卡牌、扩展调试信息等。
- `BattleAction`：玩家/系统可执行动作联合类型。
- `BattleRuleError`：规则拒绝或版本错误。
- `safeCloneBattleState(state)`：JSON 克隆并恢复运行时规则函数，写入 `_v`。
- `applyBattleAction(state, action)`：验证并归约动作，返回下一状态。

`applyBattleAction()` 的主要调用方：

- `lib/game/battle-runner.ts::runBattleAction()`：LAN、HTTP、训练和调试的包装入口。
- `lib/game/battle-runner.ts::replayBattle()`：命令回放。
- `lib/game/engine-browser-entry.ts`：浏览器/Android 引擎出口。
- 测试：`tests/game/turn.test.ts`、`tests/game/debug-battle.test.ts`。

输入：`BattleState`、`BattleAction`。

输出：新的 `BattleState`。

状态变化：回合、阶段、位置、生命、资源、卡牌、待选目标、投降等。
失败：版本不匹配、非法阶段、非法玩家、非法目标或资源不足时抛错。当前调用层没有统一的错误代码 envelope。

## 2. 战斗初始化

入口：`lib/game/battle-setup.ts::createInitialBattleForPlayers()`。

输入：

- 玩家 ID。
- 阵营模板和选择结果。
- 地图 ID。
- 可选先手玩家。
- 可选 `rootSeed`；权威入口必须在初始化前传入。

调用：地图加载、棋子创建、技能/规则加载、`globalTriggerSystem.clearRules()`、开局触发器。

输出：`Promise<BattleState | null>`；玩家数不是两个时返回 `null`。

状态变化：创建初始棋子、卡牌/资源/回合状态并注册规则。由于使用模块级触发器系统，该过程也会修改进程级状态。

待确认：同一 Node 进程并行初始化多个房间时，清理全局触发器是否会影响其他房间。

## 3. 动作执行和记录

入口：`lib/game/battle-runner.ts::runBattleAction()`。

执行顺序：

1. 从动作读取或稳定生成 action ID，并只读检查幂等信息。
2. 从既有 Action Trace 恢复命名随机流 cursor，创建动作级 `RuleRuntime`。
3. 克隆输入状态并补回运行时技能定义。
4. 在同步 runtime 作用域内调用 `applyBattleAction()`；预检使用 checkpoint，不提交随机、时钟或 ID 消耗。
5. 去除不适合序列化的技能函数，计算排除 `extensions.debugBattle` 的权威状态 hash。
6. 成功后记录根种子、动作 ID、随机流起止 cursor、回合/玩家及前后状态 hash。
7. 返回 `{ state, stateHash, actionHash, duplicate, trace }`。

失败动作不会写入调用方状态或 Action Trace；错误会附加 seed、stream/cursor、turn、player 和 actionId。重复 client action ID 返回原状态，不产生新 trace。

原子性边界：规则校验、规则函数恢复或运行时技能补全失败时，输入状态、AP、actions 和调试 Action Trace 保持不变。

幂等边界：重复 client action ID 可以被标记为 `duplicate`；没有确认所有 UI、Relay 和 mobile 消息都稳定提供该 ID。

## 4. 回合与阶段

`TurnState`、`TurnPhase` 和 `PlayerTurnMeta` 位于 `lib/game/turn.ts`。动作包括：

- `beginPhase`
- `move`
- `useBasicSkill`
- `useChargeSkill`
- `endTurn`
- `grantChargePoints`
- `surrender`
- `playCard`
- `pendingOptionSelect`
- `pendingTargetSelect`
- `cancel`

这些动作构成核心命令集合，但房间、选人、PVE、Relay 和 Electron IPC 使用各自字符串协议，并未纳入同一公共命令类型。

## 5. 卡牌、技能和资源

入口集中在 `lib/game/skills.ts`：

| 符号 | 输入 | 输出/状态变化 |
| --- | --- | --- |
| `loadCardById()` | card ID | 卡牌定义或失败 |
| `executeCardFunction()` | 状态、使用者、卡牌/目标上下文 | 执行卡牌效果并返回/修改状态 |
| `loadAllSkillsById()` | 技能 ID 集合 | 运行时技能表 |
| `loadRuleById()` | rule ID | 规则定义 |
| `dealDamage()` | 状态、来源、目标、伤害 | 改变 HP 并触发相关效果 |
| `healDamage()` | 状态、目标、治疗值 | 改变 HP |
| `executeSkillFunction()` | 技能与上下文 | 执行技能效果 |

卡牌和规则定义存在模块级缓存。部分效果使用动态函数或序列化的 `effectCode`；`turn.ts` 的待选目标流程会再次执行这段代码。

失败行为：数据缺失、动态代码异常、目标不合法或效果函数错误会抛错；部分上层调用会只写普通文本日志或吞掉异常。

## 6. 实体、地图和附加效果

- 棋子和实体：`lib/game/piece.ts`。
- 地图定义：`lib/game/map.ts` 及地图数据加载逻辑。
- 共享空间规则：`lib/game/spatial.ts`。默认距离使用曼哈顿距离；方形范围和直线格序列必须显式调用对应工具。
- 普通移动：`turn.ts`、AI 与浏览器高亮共同调用 `spatial.ts`；横向/纵向路径上的不可行走地形和任意存活棋子都会阻挡，技能位移不自动套用普通移动规则。
- 召唤入口：`lib/game/turn.ts::summonPiece()`。
- 附加效果：`lib/game/attached-effect.ts::applyEffectToPiece()` 等。
- 触发器：`lib/game/triggers.ts::TriggerSystem`。
- 全局实例：`lib/game/triggers.ts::globalTriggerSystem`。

触发器调用技能/效果，技能又依赖战斗状态和全局触发器，形成高度耦合的类型和运行时依赖图。当前不建议在 RED-9 内拆分，只需先建立隔离测试。

## 7. 胜负状态

当前核心 `BattleState` 没有确认到统一的 `GameResult` 归约入口。

`data/pages/battle.html::checkClientGameOver()` 会统计红蓝存活单位并设置客户端全局 `G.winner`、`G.gameOver`；`handleGameOver()` 负责后续显示或记录。`surrender` 则通过令己方棋子失效/归零，间接触发客户端判断。

结论：胜负规则至少部分位于 UI。目标是由每局权威服务端根据该服务器绑定的规则包计算并签署结果，Windows/Android 客户端只显示结果。同一服务器规则版本内必须一致，但不同服务器可以采用不同胜负规则。

去中心化账号系统不阻止在单个服务器规则版本内使用统一胜负入口。建议规则包提供类似纯接口：

```ts
type GameResult =
  | { status: 'ongoing' }
  | { status: 'finished'; winner: 'red' | 'blue' | null; reason: string };

function evaluateGameResult(state: BattleState): GameResult;
```

这只是愿景，RED-9 不实现该接口。

## 8. 随机和确定性

`lib/game/rule-runtime.ts` 定义根种子、稳定命名流、确定性规则时钟和实例 ID。命名流当前至少包括 `deployment`、`deployment-reroll`、`turn-order` 与 `skill/effect`；实例 ID 使用独立的 `instance-id/<namespace>` 流。流 seed 和 Mulberry32/cursor 算法由 [ADR-0004](../decisions/ADR-0004-deterministic-rule-runtime.md) 冻结。

WebSocket、房间开战、Battle API、Android mobile server 与 Relay 初始化等权威入口必须先生成根种子，再初始化状态，并在每次 `runBattleAction(..., { rootSeed })` 时沿用同一 seed。Relay 初始化响应同时返回 seed；Relay host 和 Android action-log 回放只调用 browser bundle 暴露的确定性 runner，缺失 seed 时拒绝执行。初始化的随机消耗记录为 `system-initialize` trace；动作 runner 从 trace 恢复 seed/cursor。`replayBattle()` 返回逐动作 `stateHashes`。

Action Trace 的稳定 JSON 与 SHA-256 位于 browser-safe 的 `lib/game/battle-trace.ts`，不依赖 Node `crypto`。数据驱动技能、规则、附加效果和 pending target 脚本在执行边界获得确定性的 `Math.random()` 与 `Date.now()`；规则定义缓存始终返回独立且规范化的 limits，避免 cache miss/hit 改变状态 hash。没有 runtime 的训练与非权威预检路径仍可经 `lib/game/rng.ts` 旧适配器运行，便于按模块回退。

跨端候选验证中，表现层水合的 `skillsById` 缓存不属于权威规则状态。`runBattleAction()` 计算动作前状态哈希时会排除该缓存；规则执行仍保留完整状态，以兼容以数据形式加载的技能。

Android mobile server 当前负责转发并记录 browser runner 生成的 action trace。它会将 trace 格式、根种子或前置哈希不一致记录为 `traceValidationError`，但不会因此拒绝动作，避免尚无重试协议的 WebSocket 客户端被冻结。候选验收要求该诊断字段为空；服务端完全权威地重放规则属于后续工作。

非规则豁免：房间 ID/邀请码、鉴权过期、连接和清理时间、日志、game record 时间及纯视觉随机。它们不得影响权威规则状态。

## 9. 存储和版本

- `BattleState._v` 是引擎状态版本。
- Prisma `Room.version` 是数据库房间修订号，不是存档格式版本。
- `lib/game/battle-storage.ts::getBattleStorage()` 兼容 `server-state`、旧 action-log 和裸状态。
- 外层 `{ type, seed, state }` 未发现正式格式版本或迁移注册表。

`lib/game/room-store.ts` 反序列化时会把 `currentTurnIndex` 设为 `0`、`actions` 设为空数组。含义是：保存前的这些值读取后不会恢复。

待确认：这两个字段是可丢弃缓存还是存档遗漏。公开测试前的旧存档不要求兼容，但新存档格式必须先定义字段语义并建立 round-trip 测试，不能继续隐式丢失。

## 10. 新动作链与存档愿景

公开测试前的旧存档不进入兼容范围。新格式至少需要：

- `protocolVersion`、算法标识、存档格式版本和引擎状态版本。
- server ID、server term、match ID、规则/数据 hash。
- 单调动作序号、上一条记录 hash、玩家签名命令。
- 服务端执行结果、状态 hash、服务端任期签名。
- 明确区分玩家命令与服务端产生的系统事件。

所有参与者保存完整加密记录。服务端掉线时暂停；恢复选择验证通过的最高完整序列。动作经服务端签名后立即正式，不要求所有客户端回执。

具体加密、签名、密钥封装和撤销算法待 High Risk ADR，不在本文定死。

## 11. 随机协议愿景

- 玩家分别提交随机贡献承诺，再将贡献加密揭示给当期权威服务端；拒绝揭示则开局失败。
- 服务端按固定顺序组合贡献生成 seed，并通过统一确定性 RNG 执行规则。
- 普通客户端在对局中不取得完整 seed，避免预测未来结果。
- 正常结束后向所有参与者发送签名审计包：贡献、seed、随机调用序号、关联动作、用途、范围、结果和最终状态 hash。
- Demo 先完成统一可注入 RNG 和固定 seed 回归；完整承诺协议后续实现。

## 12. 当前不变量和测试覆盖

现有 `tests/game/turn.test.ts` 覆盖普通移动、回合、版本、不可变性、目标和中断选择；`tests/game/spatial.test.ts` 与 `tests/game/movement-contract.test.ts` 覆盖空间工具属性、占位/地形阻挡及 UI/服务端合法集合契约；`tests/game/debug-battle.test.ts` 覆盖固定 seed、hash、回放和 action ID 幂等；`tests/game/deterministic-runtime.test.ts` 覆盖派生向量、流隔离、规则时钟/ID、预检回滚、墙上时间隔离、失败无污染和逐动作 hash；`tests/game/determinism-audit.test.ts` 锁定权威初始化 seed 注入、规则层直接随机/时间豁免和数据脚本执行边界。

尚缺：

- 权威胜负测试。
- 完整开局到结束的固定 seed 回归。
- 保存—读取状态等价测试。
- 多房间触发器/RNG 隔离测试。
- Electron 服务端与 Android 客户端协议测试。
- 多动作失败/重试及并发房间的端到端确定性测试。
