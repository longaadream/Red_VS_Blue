# ADR-0011：服务端权威终局结算

状态：已接受
日期：2026-08-18
关联：RED-34

## 背景

旧实现由 `battle.html` 统计所有存活单位、写入 `G.winner/G.gameOver` 并向服务端发送 `gameOver`。这会把召唤物误算为核心棋子，无法可靠处理同阵营对局、同时全灭和动作内复活，也允许客户端伪造赢家。RED-33 已保证一次伤害 batch 先提交全部生命变化，再处理死亡与复活，为统一终局出口提供了前置边界。

## 决策

1. `BattleState.terminalResult` 是单局唯一终局真源，包含 winner/loser playerId、稳定 reason 与可追踪结算位置。
2. 公共动作归约出口只在整条命令、伤害/死亡/复活/触发/batch 完成后检查；仍有 pending 选择时延后。
3. 核心身份只认 `isCore: true`，敌我只认 `ownerPlayerId`；召唤物不计核心，复活/变身保留核心身份。
4. 一方核心全灭则另一方胜；双方同时全灭为平局。第 40 个完整轮次的 end 结算先检查核心胜利，再检查轮次平局。
5. `surrender` 直接提交终局，不修改棋子生命或触发 whenever；`reason: "timeout"` 为 RED-36 预留明确原因。
6. 终局只提交一次并追加一个 `terminalResult` 日志。之后所有 gameplay 命令以 `BATTLE_ALREADY_TERMINAL` 拒绝，状态与 hash 不变。
7. HTTP 与 WebSocket 共用 `commitAuthoritativeBattleAction`，以房间 `version` 和 `setRoomIfVersion` 做 CAS。竞争命令只有一个可以提交和广播，其余以 `BATTLE_STATE_CONFLICT` 拒绝。Bot 状态也通过同一 CAS 持久化边界保存。
8. HTTP/WS 共用伪造输入守卫，拒绝客户端提交 `winner`、`gameOver` 或 `terminalResult`。房间只在权威 `terminalResult` 提交时同步为 `finished`。
9. 浏览器 LAN 与 Relay 都只提交动作并消费服务端 `stateUpdate`；Relay host 不再本地执行对手动作、上传 `stateUpdate` 或采用 `hostResume` 状态。
10. 移动端框架正在重塑；本任务不迁移或维护旧 action-log 入口，后续移动端只接入同一权威状态合同。

## 备选方案

- 继续由客户端统计存活单位：拒绝，因为客户端不掌握核心身份与完整结算边界，也可伪造结果。
- 在每次伤害或死亡时立即判定：拒绝，因为会把同批双方全灭误判为先后胜负，并阻断动作内复活。
- 投降通过把己方生命归零实现：拒绝，因为会制造额外伤害/触发语义并污染战斗状态。
- 仅靠进程内房间锁：拒绝，因为 HTTP、WebSocket 或多实例部署仍可能并发写入；数据库版本 CAS 才是提交真源。

## 影响

- 新增 additive 的 `terminalResult` 字段，不提升存档版本，不执行存档迁移。
- 房间在权威状态终局时同步为 `finished`；战报、排名、重连与回放持久化不在 RED-34 范围。
- 竞争失败不会广播，也不会覆盖已经提交的终局。
- 客户端不再发送或接受 legacy `gameOver` 作为真源；旧 Relay host 客户端权威路径被禁用。

## 验证方式

- 自动覆盖单边/同时全灭、pending 复活、召唤物、40 轮优先级、主动/超时投降、同阵营身份矩阵、终局只提交一次、终局后 hash 不变与固定 seed 回放。
- 真实 HTTP 与 WebSocket 对同一房间并发投降，验证只有一次 CAS 写入、一个终局事件，并由失败方收到稳定冲突码。
- Bot 终局持久化测试验证 `finished` 与房间版本在同一 CAS 写入中提交。
- 客户端契约测试禁止本地判胜、发送 `gameOver`、Relay host 本地执行和客户端上传 `stateUpdate`。
- 运行 TypeScript、ESLint、受影响 Vitest 与候选构建验证。

## 回退方式

在未产生公开存档迁移的前提下，整体撤销 RED-34 提交即可恢复旧行为；不得只恢复客户端上报而保留服务端部分终局，以免形成双真源。

## 相关资料

- Linear：RED-34
- 产品合同：[`DEMO_V0_1_CORE_MATCH_CONTRACT.md`](../product/DEMO_V0_1_CORE_MATCH_CONTRACT.md#10-终局)
- 伤害边界：[`ADR-0010-deterministic-damage-batches.md`](./ADR-0010-deterministic-damage-batches.md)
