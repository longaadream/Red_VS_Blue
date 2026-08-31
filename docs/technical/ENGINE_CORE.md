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
- `lib/game/engine-browser-entry.ts`：浏览器/Android 引擎出口；RED-64 以 `origin/main@17a3036daddefdb9a25cd7c167d4ca081070b786` 恢复入口（blob `e074b671d44b4b4336d988de5264bf895fbb57d0`），并通过 `tests/game/engine-browser-differential.test.ts` 的固定种子 Node/browser fixture 验证。
- 测试：`tests/game/turn.test.ts`、`tests/game/debug-battle.test.ts`。

输入：`BattleState`、`BattleAction`。

输出：新的 `BattleState`。

状态变化：回合、阶段、位置、生命、资源、卡牌、待选目标、投降等。
失败：版本不匹配、非法阶段、非法玩家、非法目标或资源不足时抛错。目标选择错误已使用稳定代码和统一 preparation envelope；其他规则错误仍未统一。

## 2. 战斗初始化

入口：`lib/game/battle-setup.ts::createInitialBattleForPlayers()`。

输入：

- 玩家 ID。
- 阵营模板和选择结果。
- 地图 ID。
- 可选先手玩家。
- 可选 `rootSeed`；权威入口必须在初始化前传入。
- Demo 房间对局传入 `deploymentEnabled: true`、权威 `deploymentStartedAt` 与已通过受控目录校验的 `Room.mapId`；正式入口不补默认地图。

调用：地图加载、棋子创建、技能/规则加载、`globalTriggerSystem.clearRules()`、开局触发器。

输出：`Promise<BattleState | null>`；玩家数不是两个时返回 `null`。

状态变化：创建稳定核心实例、卡牌/资源/回合状态并注册规则。新建 Demo 房间默认使用 `progressive-reserve-v1`：普通核心先进入各自预备区；具有 `progressiveDeployment.reserveInitializationSkillId` 的模板由内容技能执行预备区例外（当前基尔加丹按 owner 移入仪式扩展）；随后双方各通过独立 seeded 流随机抽取并随机召唤 1 枚先锋；其余核心在自己的回合进入 `awaiting-reserve-deploy`。旧的 16 枚全图出生与 `awaiting-locks` 仅保留给显式 `legacy-reroll-v1` 或缺少 mode 的历史状态。由于使用模块级触发器系统，该过程也会修改进程级状态。

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

新建 Demo 房间在每个自己的回合行动阶段前增加渐进部署门禁：

- 初始化先按稳定玩家顺序完成双方随机先锋的 `beforePieceSummoned`、入场与 `afterPieceSummoned`；两方都完成后设置 `openingVanguardsInitialized` 并在 `gameStart`、offer 与计时器前第一次判终局，先锋不获得免费首移 statusTag。`gameStart` 完整队列后再次判终局，仍未结束才生成首个 offer。
- 普通预备区非空时，`beginPhase` 生成至多 3 枚私有候选和权威合法落点，状态进入 `awaiting-reserve-deploy`；`deployReservePiece` 先精确校验必需 revision，过期输入不克隆、不消费随机也不改状态。
- 成功部署的 after-summon 队列后先判终局；未终局才为该枚新核心授予公开 `deployment-first-move-free` statusTag，并直接继续正常 `beginTurn`/action，不创建独立免费移动或 skip 阶段。该棋子在被放置的当前回合第一次成功普通移动由同一权威 reducer 以 0 AP 提交并消费标签，第二次恢复既有费用；非法或 before-move 阻止不消费，未使用标签在 `endTurn` 交接前清除。
- 没有距离大于 5 的安全格时，服务端从全部空可行走格确定性随机选择；连空格也没有时失败关闭，不移出预备棋子。召唤触发产生交互时，整条部署事务挂起到触发队列完成。
- 候选与合法落点只投影给当前输入玩家；对手和观战者只看预备区数量与公开阶段。棋子实际上场后，`visible=true` 的免费首移 statusTag 按普通棋子状态公开。Windows/Electron 权威房间的完整快照必须按接收者分别投影。
- 渐进部署使用当前成长回合期限；超时由服务端完成必要部署并直接继续既有回合流程。玩家命令与超时通过房间版本 CAS 串行化。
- 传输层在调用规则前验证 Ed25519 命令信封；签名覆盖 room/player/完整 action/timestamp，同名 header、body 或 WS subscribe 声明不能替代验证。
- 当前规则见 [`ADR-0022`](../decisions/ADR-0022-progressive-reserve-deployment.md)；旧 `deploymentChoice` / `deploymentLock` / 45 秒门禁只属于 [`ADR-0007`](../decisions/ADR-0007-deterministic-deployment.md) 与 [`ADR-0009`](../decisions/ADR-0009-authoritative-deployment-lock.md) 的 legacy 模式。

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

### 5.1 权威选择准备（RED-59）

- `targeting.ts::prepareAction()` 在 reducer、触发器、支付和效果执行前读取行动草稿。
- 返回 `ready`、`invalid`、`needOption` 或 `needTarget`；后两者包含协议版本、`selectionId`、`stateRevision`、步骤与精确候选。
- 默认距离是曼哈顿；方形范围、空地、直线、来源棋子和多段选择必须由静态声明或权威约束明确表达。
- 最终提交由同一验证器重新检查。成功动作仅增加一次 `targetingRevision`；pending target 保存来源、所有者、步骤列表、已选目标、候选和凭证，多步会话只在最后一步执行效果。
- 目标类型来自权威候选：即使格子上有棋子，`cell` 候选仍提交坐标，不能被 UI 改写成 `piece`；声明为 Chebyshev 的查询与效果执行使用相同距离。
- 未知运行时动作失败关闭，不得作为 no-op 推进 `targetingRevision`。
- 查询不得执行技能/卡牌效果、全局触发器、reducer 或 RNG。UI 与 AI 不得复制过滤规则。
- 卡牌首次点击的预览状态不是战斗命令；只有保留原始 `BattleAction.type` 和选择凭证的目标重试才允许进入传输层，`piece` pending 中点击空地只返回目标提示。

相关决策：[`ADR-0005`](../decisions/ADR-0005-authoritative-target-selection.md)。

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

## 6. 实体、地图、规则和状态标签

- 棋子和实体：`lib/game/piece.ts`。
- 地图定义：`lib/game/map.ts` 及地图数据加载逻辑。
- 共享空间规则：`lib/game/spatial.ts`。默认距离使用曼哈顿距离；方形范围和直线格序列必须显式调用对应工具。
- 普通移动：`turn.ts`、AI 与浏览器高亮共同调用 `spatial.ts`；横向/纵向路径上的不可行走地形和任意存活棋子都会阻挡，技能位移不自动套用普通移动规则。
- 弹道事实：`spatial.ts::traceProjectile()` 返回有序格子、存活棋子、地形和边界事件并继续追踪；技能脚本按普通循环自行停止、穿透或决定友军效果。权威候选查询复用同一 API，不能按技能 ID 维护弹道白名单。
- 召唤入口：`lib/game/turn.ts::summonPiece()`。
- 持续规则与显示状态：`PieceInstance.rules` 保存可执行 Rule，`PieceInstance.statusTags` 保存状态、持续时间、层数和可见标记；AttachedEffect 已由 ADR-0008 移除。
- 触发器：`lib/game/triggers.ts::TriggerSystem`。
- 全局实例：`lib/game/triggers.ts::globalTriggerSystem`。

触发器调用技能/效果，技能又依赖战斗状态和全局触发器，形成高度耦合的类型和运行时依赖图。当前不建议在 RED-9 内拆分，只需先建立隔离测试。

## 7. 胜负状态

`BattleState.terminalResult` 是唯一权威终局字段，由 `lib/game/terminal.ts::finalizeBattleTerminal()` 在公共动作归约出口，以及双先锋初始化、部署 after-summon 等必须阻止下一步推进的内部结算边界提交；普通移动完成后继续使用公共动作归约出口。结果包含 winner/loser playerId、稳定 reason，以及 action index、turn、phase、completed round 的结算位置。

普通动作必须先完成整条伤害、死亡、复活、触发与 batch；仍有 `pendingOptionSelection` / `pendingTargetSelection` 时不判终局。核心身份来自开局 `isCore: true`，召唤入口强制为 false，敌我按 `ownerPlayerId` 而不是内容阵营判断；渐进式核心还必须存活且具有数值 `x/y` 才算场上核心，预备区和仪式扩展都不计。双先锋全部完成前由 `deployment.openingVanguardsInitialized` 暂停检查。RED-124 的强制移除不进入墓地，`extensions.removedPieces` 只保存终局所需的最小身份摘要，终局仍以当前 `pieces` 中的存活核心为准。核心全灭优先于第 40 个完整轮次平局。

`surrender` 不再把己方棋子生命归零或触发 whenever，而是直接提交终局；`reason: "timeout"` 为 RED-36 预留相同权威入口。终局后 `applyBattleAction()` 与 `runBattleAction()` 都以 `BATTLE_ALREADY_TERMINAL` 拒绝命令。HTTP/WS 禁止客户端写 winner/gameOver，并通过 `Room.version` CAS 保证竞争中只提交一次；浏览器只渲染 `terminalResult`。

## 8. 随机和确定性

`lib/game/rule-runtime.ts` 定义根种子、稳定命名流、确定性规则时钟和实例 ID。命名流当前至少包括 legacy 的 `deployment`、`deployment-reroll`，渐进部署的 `progressive-deployment/opening-piece/<normalizedPlayerId>`、`progressive-deployment/opening-cell/<normalizedPlayerId>`、`progressive-deployment/offer/<normalizedPlayerId>`、`progressive-deployment/fallback/<normalizedPlayerId>`，以及 `turn-order` 与 `skill/effect`；四条渐进流都以规范化 playerId 为后缀，双方互不推进 cursor。实例 ID 使用独立的 `instance-id/<namespace>` 流。流 seed 和 Mulberry32/cursor 算法由 [ADR-0004](../decisions/ADR-0004-deterministic-rule-runtime.md) 冻结。

WebSocket 与房间开战等正式权威入口，以及内部直接调用的 Next Battle API 兼容/测试处理器，都必须先生成根种子，再初始化状态，并在每次 `runBattleAction(..., { rootSeed })` 时沿用同一 seed。正式玩家命令、完整快照和重连恢复只走房间 WebSocket；实际运行时的玩家 `/api/rooms/**` 返回 410，Next Battle API 不是 HTTP 后备。联网 Relay 浏览器不承担规则权威，只提交已认证的玩家命令并消费服务端 `{ state, seed, stateHash, authorityVersion }` 快照；移动端正在重塑框架，本任务不把旧 action-log 作为权威或兼容路径。初始化的随机消耗记录为 `system-initialize` trace；动作 runner 从 trace 恢复 seed/cursor。`replayBattle()` 返回逐动作 `stateHashes`。

Action Trace 的稳定 JSON 与 SHA-256 位于 browser-safe 的 `lib/game/battle-trace.ts`，不依赖 Node `crypto`。数据驱动技能、规则和 pending target 脚本在执行边界获得确定性的 `Math.random()` 与 `Date.now()`；规则定义缓存始终返回独立且规范化的 limits，避免 cache miss/hit 改变状态 hash。没有 runtime 的训练与非权威预检路径仍可经 `lib/game/rng.ts` 旧适配器运行，便于按模块回退。

跨端候选验证中，表现层水合的 `skillsById` 缓存不属于权威规则状态。`runBattleAction()` 计算动作前状态哈希时会排除该缓存；规则执行仍保留完整状态，以兼容以数据形式加载的技能。

Android mobile server 当前负责转发并记录 browser runner 生成的 action trace。它会将 trace 格式、根种子或前置哈希不一致记录为 `traceValidationError`，但不会因此拒绝动作，避免尚无重试协议的 WebSocket 客户端被冻结。候选验收要求该诊断字段为空；服务端完全权威地重放规则属于后续工作。

该 Android action-log 路径不验证 RED-138 所需的 viewer 私有投影，也不能把包含预备区与候选的 init 日志作为受支持的渐进部署快照。RED-81 完成前，Android 只保留 legacy 状态解释能力；`progressive-reserve-v1` 必须视为 unsupported，不能用于 RED-138 发布或隐私验收。

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

## 13. 无头 AI 环境（RED-84）

`lib/game/ai-environment.ts::aiEnvironmentV1` 提供版本化 `observe`、`listLegalActions`、`simulate`、`isTerminal` 和 `stateKey`。它只消费正式规则：移动来自 `spatial.ts`，技能/卡牌 option/target 来自 `prepareAction()`，模拟来自 `runBattleAction()` 的隔离适配器，终局来自 `terminalResult`。

Observation 不返回完整 BattleState；对手手牌、隐藏状态、Rule/effect、私有部署/pending 和 debug trace 被过滤。模拟不会写房间、广播或提交调用方状态，并要求 root seed。Node 与 browser bundle 共享同一导出和固定 seed 差分测试。接口与 unsupported 动作清单见 [`AI_ENVIRONMENT.md`](./AI_ENVIRONMENT.md)。
