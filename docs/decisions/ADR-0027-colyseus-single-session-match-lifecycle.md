# ADR-0027：Colyseus 单会话对局生命周期

- 状态：已接受
- 日期：2026-09-02
- 人工批准：2026-09-02
- 关联任务：RED-170
- 风险：High
- 基线：`main@55037468e07dbeff9729d3cff790806cef5c7c35`

## 背景

RED-161 已把 Windows 玩家链路接入 Colyseus，但客户端仍保留自制 `joinById` 重建循环，
BattleRoom 没有接管掉线恢复和权威 deadline，客户端回执超时后也只能请求快照而不能查询原
`clientActionId` 的精确结果。这会同时产生重复会话、永久 pending 和“需要点多次”的假象。

本项目的渐进部署不是开局一次性阶段：每个玩家自己的每个回合，只要预备区非空，就必须先从该回合
权威 offer 部署一枚棋子。重连和计时器必须恢复同一个状态机，不能另建部署流程。

## 决策

1. 每个玩家席位只允许一个存活的 Colyseus session。瞬时断线使用 SDK 原生 `onDrop`、
   `allowReconnection`、`onReconnect` 恢复同一个 Room/session；客户端不得循环 `joinById` 创建替代连接。
2. 断线期间客户端关闭玩法输入。重连成功后由 Room 发送接收者专属的完整权威快照；部署 offer、
   revision、合法位置、状态 hash、随机游标和原 deadline 均来自同一 Room 状态，不重新抽取或续时。
3. 命令继续进入既有每房间 FIFO。Colyseus `Room.clock` 只负责唤醒；超时仍作为系统命令进入同一个
   reducer/FIFO，并在每次真实提交后清除旧任务、按最新 deadline 安排唯一下一次唤醒。
4. 每个 `clientActionId` 的 applied/rejected receipt 都由权威存储持有。客户端丢失直接回执时，使用
   Colyseus request/response 精确查询该 ID；服务端只返回 `applied | rejected | unknown` 和当前快照。
   `unknown` 必须显式解除本地 pending，禁止无限等待或盲目重发新 ID。
5. 大厅/房间 RPC 使用 Colyseus 原生 request/response。旧消息级 requestId 分支只保留已构建页面的
   短期兼容，不再是客户端默认协议；raw WebSocket 服务只可由 `ENABLE_LEGACY_PLAYER_WS=1` 显式开启。
6. 所有玩家思考窗口翻倍：正常回合为 90/120/150/180/210 秒，快速回合 40 秒，回合外 pending
   响应 30 秒。烧绳提示仍是 deadline 前最后 15 秒，不拥有规则时间。
7. 部署候选 DOM 只在权威 revision/offer/选择变化时重建。倒计时刷新不得销毁按钮或监听器。
8. PostgreSQL 仍是必要的耐久与恢复层，但不在普通动作 ACK 热路径中同步阻塞。连接池 idle error 必须
   被带上下文记录，不能因未监听 `error` 事件导致 Node 进程退出。
9. Windows 本机 authority 意外退出时，当前对局明确中止并返回连接页；Electron 只做一次有界自动重启，
   不伪装为跨进程续局，也不进入无限拉起循环。

## 备选方案

- 删除 PostgreSQL：不能解决重复 session、缺少 Room clock 或回执查询，同时会删除崩溃恢复和终局
  durable barrier，因此拒绝。
- 继续定时销毁按钮或循环重建房间：会扩大重复提交和幽灵连接窗口，因此拒绝。
- 只把前端等待时间从 8 秒继续加长：只能延迟暴露协议缺口，不能证明命令结果，因此拒绝。
- 客户端本地推进回合/部署：会形成第二权威，破坏隐藏信息、随机和版本一致性，因此拒绝。

## 影响

收益是 Room、session、命令、计时器和 receipt 都有唯一 owner，永久“等待权威确认”变成有界且可诊断
的三态结果。成本是旧 raw WS 默认入口被关闭，进程崩溃后的当前对局仍会明确结束；跨进程 live
migration 不在本任务承诺内。

## 验证方式

- 100 局真实双 SDK 客户端从建房到权威终局；
- 同一 session 连续 100 次瞬时断线恢复，无替代 session 或幽灵席位；
- 渐进部署中断线后对比 version/hash/deployment/deadline；
- 丢失直接 receipt 后按原 actionId 查询 applied/rejected/unknown；
- Room clock、计时增长、前端稳定 DOM、PostgreSQL pool error 和 Electron authority exit 回归测试；
- 类型检查和 Colyseus standalone 构建。

## 回退方式

回退 RED-170 提交可恢复 RED-161 行为，但会重新暴露已知永久 pending 和重复会话风险。数据库 schema、
存档格式、随机算法均未改变，不需要数据迁移。不得通过重新启用 raw WS 默认入口混合运行两套权威。

## 相关资料

- [ADR-0024 渐进预备区部署](./ADR-0024-progressive-reserve-deployment.md)
- [ADR-0025 Colyseus/PostgreSQL 权威](./ADR-0025-colyseus-postgresql-authority.md)
- [RED-170 验收记录](../qa/RED-170-colyseus-single-match.md)
