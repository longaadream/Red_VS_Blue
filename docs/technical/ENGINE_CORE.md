# 游戏规则核心

更新：2026-09-01

## 1. 权威入口

- `lib/game/turn.ts::applyBattleAction()`：纯规则归约入口。
- `lib/game/battle-runner.ts::runBattleAction()`：在线权威包装，负责 seed、幂等、hash 与 Trace。
- `lib/game/room-battle-actions.ts::dispatchRoomBattleAction()`：房间协调入口，负责 actor、版本、FIFO、
  receipt、transition 和持久化适配。

UI、Colyseus 和 PostgreSQL 不复制规则。Colyseus 负责准入与消息，PostgreSQL 负责耐久证据。

## 2. BattleState

`BattleState` 包含地图、棋子/墓地、玩家资源、回合、渐进部署、pending interaction、终局结果、
权威计时和调试 Trace 扩展。核心不变量：

- 非法动作不修改输入状态；
- 资源不能在规则未允许时为负；
- 已死亡/不存在实体不能行动；
- 同一 clientActionId 不能重复结算；
- 相同初态、seed 和命令序列得到相同状态/hash；
- `terminalResult` 一旦生成即不可逆。

## 3. 动作与阶段

玩家动作包含移动、攻击、技能、卡牌、渐进部署、选择继续/取消、结束回合和投降。服务端系统动作包含
阶段推进、计时同步/烧绳/超时和机器人动作。客户端提交系统动作会被拒绝。

回合使用 `start → action → end`。若当前玩家预备区非空，`start` 会先进入渐进部署，部署成功后直接进入
正常行动。部署核心的第一次合法普通移动可消费本回合免费首移标记；换手前未使用标记被清除。

## 4. 目标与 pending interaction

`lib/game/targeting.ts::prepareAction()` 是纯查询合同，返回 `ready`、`needOption`、`needTarget` 或稳定错误。
候选枚举与最终提交复用同一验证器。动态选择带 `selectionId` 和 state revision；过期、错误玩家或候选外
目标在执行效果前拒绝。

pending interaction 激活时只允许匹配的继续或合法取消命令。错误不得消费资源、改变触发器限制或推进
随机 cursor。

## 5. 空间与战斗事实

`lib/game/spatial.ts` 提供曼哈顿距离、方形范围、直线事实、占位与普通移动校验。
`traceProjectile()` 只返回按顺序排列的棋子/地形事实，技能自行决定伤害、穿透和停止语义。

普通移动只能横纵、不超过 moveRange、不能穿过活棋子或不可行走地形。技能位移、推拉和传送必须显式
使用相应规则，不能偷用普通移动结果。

## 6. 技能、卡牌和触发器

`lib/game/skills.ts` 加载并执行数据驱动技能/卡牌；`lib/game/triggers.ts` 管理事件消费者。
在线房间使用 `RoomRuleRuntimeRegistry` 隔离 TriggerSystem、规则限制、编译缓存、pending 和随机运行时。
单房间失败不得污染其他房间。

效果链在同步边界执行。任何非有限数、不可序列化状态、预算溢出或触发器异常都向权威边界抛出，
协调器回滚该动作。

## 7. 终局

`lib/game/terminal.ts::finalizeBattleTerminal()` 在完整动作/触发链边界归约终局。场上存活核心决定普通胜负；
召唤物和未部署核心不冒充场上核心。投降、超时投降和轮次平局使用明确 reason。

终局动作、房间状态、最终 Trace/Replay Frame 和 Terminal Barrier 必须属于同一连续权威历史。客户端只
展示 `terminalResult`，不重新计算赢家。

## 8. 随机、时间与 hash

`RuleRuntime` 从 root seed 派生命名随机流、逻辑时钟和实例 ID。初始化先固定 seed，后续动作沿用同一
runtime cursor。视觉随机、网络时间和日志时间不得进入权威状态。

Action Trace 使用稳定 JSON 与 SHA-256。动作产生 action hash、内部/公开 state hash 和 transition hash；
数组状态采用稳定分块索引。hash 用于确定性和完整性验证，不用于保密。

## 9. 版本与恢复

- `BattleState._v`：引擎状态版本。
- 房间 `version`：房间元数据版本。
- `battleAuthorityVersion`：战斗连续版本，receipt/transition/patch 只使用此版本。
- authority protocol/build：命令与存档算法身份。

恢复从 PostgreSQL version-zero Checkpoint 开始，按连续 Transition 重放并核对每个 hash 与 receipt。
存在版本缺口、build 不匹配或 Checkpoint 偏差时失败关闭。

## 10. 测试重点

- `tests/game/turn.test.ts`：归约、阶段、资源和动作原子性。
- `tests/game/deterministic-runtime.test.ts`：seed、命名流、逻辑时间和回放。
- `tests/game/targeting.test.ts`：候选、凭证、pending 和纯查询。
- `tests/game/spatial.test.ts`、`projectile-trace.test.ts`：空间事实。
- `tests/game/room-runtime-isolation.test.ts`：双房 FIFO/运行时隔离。
- `tests/colyseus/battle-room.test.ts`：真实 BattleRoom 命令与状态。
- `tests/integration/postgres/postgres-authority.integration.test.ts`：耐久恢复、战报与篡改拒绝。
