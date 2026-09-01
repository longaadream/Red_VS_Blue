# Colyseus / PostgreSQL 权威联机迁移合同

- 状态：有效
- 日期：2026-08-31
- 任务：RED-159
- 父路线：RED-158
- 风险：High
- 基线：main@52632636d16dce0a912cab428dc563c59eb4f605
- 收尾同步基线：main@a0d0ead93009553e32f3088622893443930fab7b
- 决策：[ADR-0025](../decisions/ADR-0025-colyseus-postgresql-authority.md)

## 1. 合同目的

本文把已批准的 Colyseus + PostgreSQL 方向拆成可以分别实现、测试和回退的窄边界。Phase 0 不修改
运行时；后续实现必须服从以下总原则：

1. Room 内存是在线权威，PostgreSQL 是唯一耐久真源；
2. 普通 action 在完整规则事务提交后立即 APPLIED，不等待数据库；
3. PostgreSQL 有界微批后推进 DURABLE 水位；
4. RED-139 的动作内 EffectChain/Queue 必须在 APPLIED 之前完整收敛；
5. Colyseus Schema 是公开 read model，不是私有状态、审计、Trace 或 receipt；
6. Redis 是 Presence/Driver/路由协调，不保存战斗事实；
7. 新候选没有 SQLite runtime、writer、provider、双写或同步 fallback；
8. 终局、结算、删除、备份和优雅关闭必须等待 durable barrier；
9. Windows 单实例和 Kubernetes 多 Pod 复用同一 BattleRoom/规则/存储端口；
10. 不在活动 Room 中热切 transport、database、process 或 build。

## 2. 现状到目标的模块映射

| 当前模块/事实 | 决定 | 目标边界 |
| --- | --- | --- |
| lib/game/battle-runner.ts 的确定性命令执行 | 保留 | BattleRoom 只调用公共命令端口，不复制规则 |
| lib/game/room-authority-queue.ts 的每房间有界 FIFO | 保留并适配 | 包住一个完整命令事务；Colyseus handler 不另造并发提交 |
| RED-139 EffectChain 与四类 typed Queue | 保留 | 位于单个 FIFO job 内；全链完成或整体回滚后才生成 Transition |
| lib/game/room-rule-runtime.ts 的每房间隔离 | 保留 | Room create/restore/dispose 显式绑定同一 runtime 生命周期 |
| lib/game/battle-transition.ts 协议 v3、receipt、hash chain | 保留并扩展 | transport-neutral domain envelope；增加 epoch/durability 水位但不降低 hash |
| lib/game/battle-public-patch.ts | 适配 | 小型 Schema/StateView + 精确语义 message；不把完整 BattleState 变成 Schema |
| lib/ws-server.ts 的 raw ws 房间/RPC 编排 | 重写 | Colyseus MatchMaker/BattleRoom/SDK；旧入口只在迁移窗口独立启动 |
| lib/server/battle-authority-async-journal.ts | 重写 | typed、按 Room 保序、有界的 PostgreSQL microbatch writer |
| lib/server/battle-authority-persistence.ts | 重写 | PostgreSQL transaction/checkpoint/recovery adapter |
| Prisma SQLite schema/WAL/busy_timeout | 退役 | PostgreSQL baseline/migration；SQLite 只由离线只读 exporter 使用 |
| Room 表内完整 battleState/旧恢复入口 | 重写 | battleId + epoch + checkpoint + continuous transition prefix |
| ADR-0016 Trace v2 recorded-state replay | 保留 | Trace 事实进入 Transition/terminal checkpoint，不用新规则重跑历史 |
| ADR-0020 单玩家 WS 通道 | 保留产品语义 | 同一 Colyseus connection 承载大厅/Room/战斗；静态资源仍 HTTP |
| RED-142 timer/epoch/recovery | 改写后消费 | Pod/进程崩溃以 durable deadline 和更高 epoch 恢复 |
| RED-143 durable terminal/cleanup/public projection | 改写后消费 | PostgreSQL terminal barrier + Schema/StateView |
| Windows Electron server lifecycle | 适配 | 单 Colyseus process + drain API + PostgreSQL health |
| Relay、随机 K8s Service 或 cookie sticky | 退役为权威路由 | reservation 后精确 publicAddress 到目标 process |

## 3. 三层 Queue，不得混用

### 3.1 Room command FIFO

输入是玩家、pending、timer、AI 和 system command。它只保证同 Room 的命令顺序和背压；不同 Room
可以并行。FIFO job 的原子单位是“一条完整权威命令”。

### 3.2 RED-139 EffectChain/Queue

一个 FIFO job 是一个外层动作事务，可以原子聚合 submitted action 与 synthetic turnTimerSync 等多个
内部 rule command。每次 runBattleAction invocation 都新建一个瞬态 EffectChain；Damage、Heal、
Summon、Death typed Queue 只做该 invocation 内的确定性调度与逻辑同时批次。它们不能直接发送网络
消息、写数据库或推进 authority version，BattleRoom 也不能创建、排空或恢复 EffectChain。

### 3.3 Durable microbatch queue

它接收已经 APPLIED 的完整 Transition/receipt/checkpoint job，按 Room 保序并跨 Room 公平 flush 到
PostgreSQL。它不重新执行规则，也不能改变 EffectChain 的顺序或结果。

### 3.4 三种 commit 术语

- Batch Commit：只在一次 runBattleAction 的私有 clone 内统一写 HP、实体、墓地等主状态，供后续
  lifecycle 观察；任何后续异常或 pending 都丢弃该次未完成根动作，不对 Room/网络/数据库可见。
- APPLIED / Transition Commit：一个外层 FIFO job 的 rule invocation（例如 submitted action 与
  synthetic turnTimerSync）分别用新 EffectChain 完整成功，或以已回滚 provisional effects 的合法
  pending 结束后，才一次 swap authorityState/version/transitionHash/receipt，并发布直接 message
  与公开 read model。
- DURABLE Commit：完整的外层 Transition/receipt/可选 checkpoint 进入 PostgreSQL 无缺口连续前缀并
  推进 watermark。EffectBatch、内部 Queue 或中间 clone 永不单独落库。

room-authority-queue.ts 是唯一跨命令 FIFO。若 BattleRoom 调用的共享 command port 已进入
dispatchRoomBattleAction，外层不得再 enqueue 第二次。room-rule-runtime.ts 的同步
RuleExecutionContext 每 Room 生命周期唯一；battle-runner.ts 在每次 invocation 内创建并以 try/finally
卸载瞬态 EffectChain。BattleRoom 不得 import createEffectChain/drain 或 effect handler，也不得在
runBattleAction/withEffectChain 的同步作用域里 await、I/O、发消息或入 journal。不同 Room 只能在
runner 返回后进入异步并行。

外层 Transition attempt 必须在第一次 invocation 前调用公开事务端口快照 per-room
TriggerSystem/RuleRuntime 状态。若后续 invocation、hash/build、journal capacity reserve、stale
CAS/commit 或内存 swap 失败，BattleState 私有 clone 和 trigger limits/event cursor 等运行时副作用
一起恢复。只有 APPLIED/Transition Commit 成功才保留。Colyseus 单 actor 即使不需要正常 CAS retry，
仍必须覆盖 multi-invocation 与提交前失败。

runner 的结果分为完整成功、合法 pending、失败。合法 pending 丢弃 provisional batch state 并卸载
chain，只提交 root pre-state 上的 pending session；pending answer 原样交回 runner，Room 不展开
rootAction。duplicate/resync 在 runner 前处理，batchId 不是网络幂等键。非 pending 成功返回前，RED-139
公共 runner 必须 fail closed 证明 chain idle、pendingCount=0、无 current batch 且已卸载；BattleRoom
不得读取内部 ledger 或静默丢弃残留工作。

权威路径禁止 detached effect helper；四类效果必须位于同步 RuleExecutionContext/EffectChain scope。
恢复只重放 PostgreSQL 中完整外层 Transition/checkpoint，不恢复、重放或推断 EffectChain ledger。

Damage 内生死亡检查点的 HP commit → Freeze → lifecycle → revival decision → Finalization →
afterCharge → 跨类型 FIFO 顺序由 RED-139 规则层保持；Room、Schema 和 journal 不插入中间步骤。

唯一合法时序为：

~~~text
Room FIFO dequeue
  -> begin command transaction
  -> run one or more rule commands; each gets a fresh RED-139 EffectChain
  -> every EffectChain fully settles, or legal pending rolls back partial effects
  -> legal pending stores root action/answers/RuleRuntime checkpoint, never the queue
  -> validate rollback/hash/version/trace invariants
  -> reserve durable queue capacity
  -> atomically commit private memory state + Transition + receipt
  -> send APPLIED receipt
  -> publish recipient StateView/message
  -> durable microbatch
  -> PostgreSQL commit
  -> publish monotonic DURABLE watermark
~~~

任何规则/trigger/batch 异常都在私有状态提交前完整回滚；不发送 APPLIED、不投影部分 Schema、不入 durable
queue。EffectChain 尚有未完成 lifecycle/follow-up 时发送 APPLIED 属于协议错误。EffectChain、
batch/parent/depth 和内部队列不进入 BattleState、pending、Transition、Trace 或网络协议；诊断只留在
helper 结果、TriggerContext 与测试 recorder。将来若要持久化必须另立 schema/协议合同。

## 4. 命令、投影和恢复时序

### 4.1 普通命令

1. SDK 发出带 requestId、clientActionId、battleId、epoch、expectedAuthorityVersion、build/Profile
   identity 和 canonical command 的消息。
2. BattleRoom 在进入规则前验证身份、seat、build、Profile、epoch 与 envelope。
3. 命令进入既有 Room FIFO；队列满在状态改变前返回稳定 backpressure 错误。
4. runner 执行一个或多个内部 rule command；每次 runBattleAction 创建新的瞬态 RED-139 EffectChain。
   全部成功后才生成聚合的私有 next state、公开 read model、Transition、receipt、既有 Trace 与 hash。
   合法 pending 回滚该次未完成效果，只保存根动作、答案序列和 RuleRuntime checkpoint。
5. 轻量独立不变量通过且 durable queue 已预留容量后，Room 原子替换私有状态并推进 version。
6. 直接向请求者发送精确 APPLIED receipt；不能等 Schema patchRate 或 PostgreSQL。
7. 公开 Schema/StateView 随框架 patch；语义 Transition、错误、隐藏候选和 durable watermark 用
   recipient-specific message。
8. 后台 writer 在 25ms 或 8 条任一先到时 flush；commit 后推进 durableAuthorityVersion。

### 4.2 公开状态

- this.authorityState 是普通私有 BattleState，永不直接同步。
- this.state 只含客户端渲染所需的稳定、低频公开字段。
- 公开棋盘可用小型 Schema collection；隐藏手牌、部署选择和 pending candidates 用 StateView 或
  定向 message。
- 精确 command receipt、resyncRequired、semantic Transition、错误和 terminal barrier 不依赖 Schema
  tick。
- 客户端只在 version/hash/epoch 连续时应用增量；断层单飞请求完整公开 snapshot。

### 4.3 崩溃恢复

若内存 authorityVersion=A、数据库 durableAuthorityVersion=D 且 A>D：

1. 新 worker 取得 battleId 的更高 fencing epoch；
2. 读取最大有效 checkpoint C，要求 C≤D；
3. 严格重放 C+1..D，逐条验证版本、action/state/transition hash、Profile 和 runner identity；
4. 只在 D 建立新 Room actor，恢复持久 deadline，而不是旧内存 timeout；
5. D+1..A 是已确认但未 durable 的丢失尾部，必须向客户端公开 resync；
6. 客户端以原 clientActionId 重交 outbox 中未获耐久证明的命令；
7. 已有同 ID/同 actionHash 返回原 receipt；同 ID/不同 actionHash 返回
   CLIENT_ACTION_ID_CONFLICT；过期 version/pending 返回 resyncRequired；
8. 发现缺号、watermark 超前、hash/epoch 冲突时 quarantine，禁止猜测恢复。

普通 reconnection token 只适用于原 Room 仍活着。进程死亡后重新 matchmaking，以 battleId/auth
取得新 runtime roomId、process/public address。

### 4.4 终局与关键边界

terminal action 仍先完整执行 RED-139 queue、死亡/复活/亡语和完整动作后终局判定。随后立即关闭本房
普通 ingress，flush 当前微批，并在同一 PostgreSQL 事务写入 terminal Transition、receipt、最终
checkpoint、room watermark 与 terminal barrier。只有 commit 成功后才发送 durable terminal receipt、
开放奖励/排名/账本消费、允许删除或报告 verified backup 成功。

PostgreSQL 超时/不可用时 UI 可以显示“胜负已判定，结算持久化中”，但不得把 pending/degraded 伪装成
最终结算成功。

## 5. PostgreSQL schema 草案

本节只冻结语义，不创建 migration。字段类型可在 D 任务中根据真实 payload 基准细化，但唯一键、
连续前缀和事务边界不得弱化。

~~~sql
CREATE TABLE battle_room_authority (
  battle_id              uuid PRIMARY KEY,
  authority_epoch        bigint NOT NULL,
  durable_version        bigint NOT NULL CHECK (durable_version >= 0),
  durable_chain_head     bytea NOT NULL,
  protocol_version       integer NOT NULL,
  authority_build_id     text NOT NULL,
  resolved_profile_hash  text NOT NULL,
  runner_revision        text NOT NULL,
  status                 text NOT NULL,
  finalization_status    text NOT NULL,
  lease_owner            text,
  lease_expires_at       timestamptz,
  updated_at             timestamptz NOT NULL
);

CREATE TABLE battle_transition (
  battle_id              uuid NOT NULL,
  to_version             bigint NOT NULL,
  from_version           bigint NOT NULL,
  authority_epoch        bigint NOT NULL,
  client_action_id       text NOT NULL,
  player_id              text NOT NULL,
  command                jsonb NOT NULL,
  receipt                jsonb NOT NULL,
  internal_patch         jsonb NOT NULL,
  public_patch_evidence  jsonb NOT NULL,
  pending_state          jsonb,
  trace_delta            jsonb NOT NULL,
  action_hash            bytea NOT NULL,
  pre_state_hash         bytea NOT NULL,
  post_state_hash        bytea NOT NULL,
  previous_transition_hash bytea NOT NULL,
  transition_hash        bytea NOT NULL,
  created_at             timestamptz NOT NULL,
  PRIMARY KEY (battle_id, to_version),
  UNIQUE (battle_id, client_action_id),
  CHECK (to_version = from_version + 1)
);

CREATE TABLE battle_receipt (
  battle_id              uuid NOT NULL,
  client_action_id       text NOT NULL,
  action_hash            bytea NOT NULL,
  authority_epoch        bigint NOT NULL,
  observed_authority_version bigint NOT NULL,
  committed_transition_version bigint,
  status                 text NOT NULL,
  error_code             text,
  payload                jsonb NOT NULL,
  durable_at             timestamptz NOT NULL,
  PRIMARY KEY (battle_id, client_action_id),
  FOREIGN KEY (battle_id, committed_transition_version)
    REFERENCES battle_transition (battle_id, to_version)
);

CREATE UNIQUE INDEX battle_receipt_applied_version_unique
  ON battle_receipt (battle_id, committed_transition_version)
  WHERE committed_transition_version IS NOT NULL;

CREATE TABLE battle_checkpoint (
  battle_id              uuid NOT NULL,
  authority_version      bigint NOT NULL,
  authority_epoch        bigint NOT NULL,
  private_state          jsonb NOT NULL,
  deterministic_runtime  jsonb NOT NULL,
  root_seed              bigint NOT NULL,
  state_hash             bytea NOT NULL,
  public_state_hash      bytea NOT NULL,
  transition_hash        bytea NOT NULL,
  reason                 text NOT NULL,
  created_at             timestamptz NOT NULL,
  PRIMARY KEY (battle_id, authority_version)
);

CREATE TABLE battle_terminal_barrier (
  battle_id              uuid PRIMARY KEY,
  settlement_key         text NOT NULL UNIQUE,
  terminal_version       bigint NOT NULL,
  terminal_state_hash    bytea NOT NULL,
  terminal_transition_hash bytea NOT NULL,
  status                 text NOT NULL,
  result_payload         jsonb NOT NULL,
  durable_at             timestamptz,
  CHECK (status IN ('pending', 'durable', 'degraded'))
);
~~~

### 5.1 必须维持的数据库不变量

- 一个 battle_id 只存在一个当前 epoch writer；租约/fencing 由 PostgreSQL CAS 或事务锁证明。
- Transition 的 to_version 连续；writer 只能从当前 durable_version+1 插入无缺口前缀。
- 同一 battle_id/client_action_id 只能对应一个 action_hash 和原始 outcome。
- 相同 ID/相同 hash 的重试返回原 receipt；相同 ID/不同 hash 是冲突，不做 upsert 覆盖。
- 只有产生 Transition 的 applied receipt 填 committed_transition_version；rejected/resync receipt 可以
  共享同一 observed authority version，因此不能对 observed version 建唯一约束。
- 插入 Transition、对应 receipt、可选 checkpoint、terminal barrier 和推进 room watermark 必须在
  同一事务内提交；不得先推进 watermark。
- checkpoint 只有在其 version 已 durable 且 state/transition hash 验证一致时有效。
- 旧 Transition 只有在更晚 checkpoint 已提交、重新读取并验证后才允许按 retention 裁剪。
- 不建立所有 Room 每 action 都争用的全局 mutable row；跨 Room 用连接池并行。
- jsonb 保存版本化领域 payload；高频查询、唯一性和水位使用强类型列和索引，不能只藏在 JSON。
- schema/migration 具有版本和 forward-only 发布合同；旧 binary 不打开新 schema。
- 发布 DURABLE watermark 的 authority 事务使用 PostgreSQL synchronous_commit=on；不得用关闭 WAL
  flush 冒充低延迟。同步副本/跨 AZ RPO 由部署合同另行量化。

### 5.2 微批事务

每个 Room 有自己的连续前缀 accumulator：第一条待写 job 入队时启动 25ms dwell timer，累计 8 条立即
flush；backlog 超过 8 条时按最多 8 条连续 drain，不重新等待。全局只提供有界公平 scheduler 与连接池，
不提供 SQLite 式单 writer。一个 PostgreSQL authority 事务只提交一个 battle_id 的连续前缀；不同 Room
用不同事务并行，某 Room 失败只回滚/重试该 Room 队首，不占住其他 Room 的顺序。

健康状态下 oldest job 到 transaction start 目标 ≤30ms；数据库事务时间单独度量。有限重试用稳定
错误分类和抖动退避；完整性、约束、hash、epoch 或 schema 错误立即 quarantine。长期不可用时有界队列
达到安全线后在内存提交前拒绝该 Room 新 action，不能无界堆积。

## 6. 客户端 outbox 和精确 receipt

客户端在发送命令前持久保存 canonical command、clientActionId、actionHash、expected version、epoch
和本地顺序。收到 APPLIED/pending 后仍保留；只有 durable watermark 覆盖该 receipt version 且 hash
匹配后才能删除。

超时、掉线或进程重启不得生成新 clientActionId。重连先取得 battle epoch、authority version/hash 和
durable watermark，再重交未 durable 项。服务端不承诺恢复两个客户端之间已经丢失的非耐久总顺序；
若基础 version 已过期就要求 resync，不强行制造旧结果。

outbox 本身不得变成第二个规则引擎。移动、目标或 option 选择仍由服务端以当前 pending/session 凭证
重新校验；旧候选不得自动执行。

## 7. 延迟预算与测量口径

口径是暖连接下“客户端发送 action 至收到精确 receipt/watermark”，同房 FIFO 初始为空，一个
LB/反代，不包含动画与渲染。下表是 PoC 估算，不是已验证 SLA：

| 网络 | 普通 APPLIED P50 / P95 | DURABLE watermark 或 terminal barrier P50 / P95 |
| --- | ---: | ---: |
| LAN | 15–30 / 20–50 ms | 35–75 / 60–155 ms |
| 同地域 | 28–65 / 55–130 ms | 45–110 / 95–235 ms |
| 跨地域 | 95–210 / 160–350 ms | 115–255 / 200–455 ms |

跨地域慢的主要成分是物理 RTT、运营商/公网绕路、TLS/代理队列和丢包重传；更换 SQLite/PostgreSQL
不能消除光速和路由距离。把普通 action 从数据库提交中解耦会消除服务端 fsync/锁抖动，但跨地域仍需
按玩家区域分配 Room。

Colyseus 默认 patchRate 50ms 只决定状态 patch 批次。若 UI 等 patch 才解除 pending，会额外增加约
25ms P50、47.5ms P95；所以 receipt 必须走直接 response/message。

### 7.1 PoC 观测点

- client send、receipt receive、patch applied、watermark receive；
- gateway enter/leave、decode complete；
- Room FIFO enqueue/start、queue depth；
- EffectChain/batch count/depth（仅运行诊断）、rules、hash/diff、memory commit；
- projection/Schema/receipt encode、socket enqueue；
- durable enqueue、batch dwell/size、DB acquire/begin/commit/retry；
- checkpoint build/verify/commit、watermark publish；
- authorityVersion-durableAuthorityVersion、oldest job age、event-loop lag、GC、CPU、bytes；
- client outbox retry/dedupe/conflict。

每个场景至少 500 个预热后样本，报告原始分布与 P50/P95/P99，不只报平均值。覆盖 1/10/100 个活动
Room、空队列/同房 burst、普通/周期 checkpoint/terminal、数据库正常/阻塞/中断，以及 LAN、同地域和
代表性跨地域网络。

### 7.2 候选门槛

- LAN 普通 action：P50 ≤50ms、P95 ≤100ms、P99 ≤150ms，正常样本 <250ms；
- 数据库事务阻塞时，20 个预热普通 action 的 dispatch→APPLIED P95 仍 <100ms；
- 无锁时 receipt→DURABLE P95 ≤125ms、P99 ≤250ms；
- LAN terminal durable barrier P95 ≤250ms；
- 第 8 条到达后至 flush 调度不超过一个 event-loop turn；
- 100-transition fixture 后 10 条中位数不超过前 10 条的 2 倍；
- 一个 Room 的长 EffectChain、DB retry 或 quarantine 不拖死其他 Room。

## 8. Windows 与 K8s 部署合同

### 8.1 Windows 单实例

- 一主机一 Node/Colyseus process，固定 ws(s) 地址；
- 默认 LocalPresence/LocalDriver；这只能证明单进程；
- 复用同一 BattleRoom、PostgreSQL adapter、health、drain 和 recovery；
- Supervisor 先调用受保护 drain，再停止 child；不只依赖 SIGTERM；
- RED-161 已批准 LAN 房主按需使用候选内置的原生 PostgreSQL 16；远程加入方不启动数据库；
- 内置 cluster 位于用户数据目录，只监听 `127.0.0.1` 动态端口，使用随机 SCRAM 凭据和 Electron
  安全存储；不得安装机器级服务、使用 `trust`、绑定 LAN 网卡或回落 SQLite/PGlite；
- 显式 `RVB_POSTGRES_URL`、官方 Server 与 K8s 使用外部 PostgreSQL，不启动内置实例；
- PostgreSQL major 升级、自动 `pg_upgrade`、公开更新渠道和旧 SQLite 数据导入仍需后续发行合同；
- 新候选包不得包含 SQLite authority provider/writer。

### 8.2 Kubernetes

- 稳定 matchmaker/API 入口负责 auth、matchmaking 和 seat reservation；
- game worker 一 Pod 一进程，每 Pod 持有若干完整 Room；
- Redis Presence 提供 IPC/pub-sub，Redis Driver 提供共享 Room 目录/查询；两者都不是持久化；
- PostgreSQL 保存 journal/checkpoint/receipt/epoch/terminal；
- reservation 后客户端使用唯一 publicAddress 直达目标 worker；
- 稳定 Pod 身份 + per-Pod Service/Gateway route 为默认方案；Traefik experimental 只作 staging 对照；
- route、Redis、DB、Profile 和 runtime 未全部 ready 时 worker 不进入 matchmaking。

### 8.3 Room-aware drain

1. 标记 draining、readiness=false，停止新 Room/seat；
2. 保持 liveness 和已有 WebSocket；
3. 活动 Room 在 deadline 内自然结束，或建立最后 durable checkpoint 后走恢复；
4. 等 FIFO 中正在运行的同步规则 invocation、journal 与 terminal barrier 收敛；
5. 注销 public route，等待传播；
6. 仅当 roomCount=0 和水位一致时退出。

Kubernetes terminationGracePeriodSeconds 必须覆盖 drain、checkpoint 和 route buffer。RollingUpdate
使用 maxUnavailable=0、maxSurge=1；PDB 不能防止节点崩溃。HPA 初期只自动 scale-up，scale-down
只能删除已排空的空 worker。

## 9. SQLite 离线迁移演练

### 9.1 准备

1. 记录旧 release、SQLite schema、authority build/Profile 和文件绝对路径；
2. 进入 maintenance，关闭 admission，排空旧 journal 并停止所有 writer；
3. 使用 SQLite Online Backup 或等价一致性方式创建不可变备份，不能只复制活动 WAL 下的主文件；
4. 记录 SHA-256、文件大小、表/行数、最大 version、checkpoint、terminal 和抽样 battle 清单；
5. 原始 live 文件和备份均设为只读迁移证据。

### 9.2 exporter / importer

- exporter 是单独 CLI，只读打开备份，不 import 新 BattleRoom/runtime；
- 输出版本化 manifest 和 canonical records，保留原主键、时间、hash bytes、JSON 与 source schema；
- importer 只写 PostgreSQL staging，按依赖顺序导入 room、checkpoint、transition、receipt、terminal
  以及用户/账本相关表；
- 冲突、未知 schema、缺号、同 ID 不同 hash、坏 JSON 或不可映射字段立即失败，不能跳过；
- 不提供运行时双写、SQLite fallback 或“迁移失败继续开服”模式。

### 9.3 校验与切流

- 比较逐表行数、主键/唯一键集合、版本范围、terminal/settlement key；
- 每个 battle 验证 checkpoint→durable watermark 连续性和 transition hash chain；
- 固定抽样重放 private/public state hash、Trace、seed/RNG cursor、turn/pending/deadline；
- 使用候选服务只读恢复，完成双客户端 smoke；
- 人工批准后停止旧 release、切换新配置并保留旧备份；
- 切流失败时整体回到旧 release + 原始备份，明确 PostgreSQL cutoff 后数据差异；
- 本路线不删除原 SQLite。任何删除需针对解析后的精确文件另行人工确认。

## 10. 故障注入矩阵

| 场景 | 必须观察的结果 |
| --- | --- |
| memory commit 前异常 | 无状态、Queue、receipt 或 journal 污染 |
| memory commit 后、receipt 前崩溃 | 以 durable watermark 恢复；客户端同 ID 重试 |
| receipt 后、flush 前崩溃 | 明确丢失非 durable 尾部；outbox/resync，不重复结算 |
| DB commit 成功、响应丢失 | 重试读取原 outcome，version 不再次推进 |
| watermark 发布前崩溃 | DB 仍为真；重连取得更高或相同 durable watermark |
| checkpoint/terminal 事务中断 | 整体回滚；不产生半终局/奖励/删除 |
| PostgreSQL 高延迟/短中断 | APPLIED 仍快，lag 可见；有限重试；队列满前背压 |
| PostgreSQL 长期不可用 | 目标 Room degraded/quarantine；有界内存；其他 Room 继续 |
| Redis 中断/故障转移 | 停止新匹配/跨进程调用；现有本地 Room 按明确降级合同运行 |
| SIGTERM | 停新 seat，Room-aware drain，期限内 durable 退出 |
| SIGKILL/节点断电 | 新 epoch 单主恢复；旧 epoch 写入拒绝 |
| 两个 worker 并发恢复 | 只有一个 fencing epoch 获得写权 |
| 错误 publicAddress/route 延迟 | 错误进程接受连接为 0；明确 retry，不能进入别的 Room |
| Pod IP/滚动升级/scale down | route+Redis+DB ready 后准入；有 Room 的 Pod 不被删除 |
| RED-139 Queue 异常/预算超限 | 整条命令回滚；不发送 APPLIED 或部分投影 |
| 第一 invocation 成功、第二 invocation 失败 | BattleState 与 TriggerSystem 快照均恢复，重试等于全新执行 |
| hash/journal reserve/stale commit 失败 | 无 version/receipt/job，trigger limits/event cursor 无残留 |
| 长回合 timer 跨重启 | 由 durable deadline 计算，不重置、不重复 timeout |
| Windows stop/强杀 | 分别覆盖正常 drain 与同 K8s 的恢复路径 |

## 11. 既有未完成 Issue 迁移矩阵

统计口径为 2026-08-31 的 30 个有效未完成 Issue，不含 RED-158/159、已完成、取消、重复或示例项。
分类结果为保留 20、改写 5、条件替换 4、替代 1；Phase 0 不批量修改它们的状态。

| Issue | 分类 | 决定 |
| --- | --- | --- |
| RED-118 Content Pipeline CLI/Editor 发布链与 Windows Candidate | 保留 | 内容构建、签名、Profile hash 和 PVE smoke 不依赖 Room 框架；用新候选复验 |
| RED-138 渐进部署与场上核心终局 | 保留 | 玩法/确定性状态/UI/AI 接口不变，只适配命令和公私投影 |
| RED-139 四类 EffectBatch/Queue | 保留 | 纯规则动作内顺序；BattleRoom 必须包住而不是复制 |
| RED-151 SkillCode ABI/预算/可信模式 | 保留 | 动态规则边界与网络框架无关 |
| RED-111 Content Pipeline v1 | 保留 | Profile/PVE/内容身份继续作为 Room 准入输入 |
| RED-133 Demo v0.2 路线 | 保留 | 玩法冻结不变；C/F 前不能称最终联网候选 |
| RED-95 Demo 新手教程 | 保留 | 教程行为和表现层不因服务框架失效 |
| RED-135 SkillCode Runtime/Editor 路线 | 保留 | 内容作者与安全执行独立 |
| RED-157 SkillCode/Editor 安全验收 | 保留 | 候选环境换成新服务 |
| RED-136 Roguelike PVE Runner/Editor | 保留 | PVE Flow 保留；多人合作不在本迁移范围 |
| RED-152 Content Editor v1 | 保留 | 编辑器 UX/诊断/确定性投影独立 |
| RED-150 Content Editor 工程合同 | 保留 | 作者工程与 pack 投影不变 |
| RED-156 SkillCode 接入 Pipeline | 保留 | Profile 安全门禁继续由 Room 消费 |
| RED-122 贪心估价与位置 AI | 保留 | 无头环境/算法不依赖传输 |
| RED-83 通用 AI/离线自博弈 | 保留 | 训练观察评估合同有效 |
| RED-110 可暂停 PvE AI 训练 | 保留 | 训练调度和档案独立 |
| RED-104 棋子图鉴纸偶工作台 | 保留 | 纯客户端 UI |
| RED-101 Electron 主菜单 | 保留 | 纯客户端 UI，后续适配连接状态 |
| RED-102 2.5D 战局视觉 | 保留 | 消费公开 read model，不进入 Room 规则 |
| RED-98 对手动作叙事 | 保留 | 消费语义 Transition/message，不从 Schema patch 猜动作 |
| RED-142 启动恢复/epoch/timer | 改写 | 改为 Colyseus Room/Pod + PostgreSQL durable watermark |
| RED-143 durable 终局/清理/投影 | 改写 | PostgreSQL barrier + Schema/StateView |
| RED-145 本服身份/竞技账本 | 改写 | PostgreSQL，只消费 durable terminal |
| RED-146 赛季/Elo/段位 | 改写 | 数据真源改 PG，查询走 Colyseus/受信管理 API |
| RED-149 10–30 人故障候选 | 改写 | 改测 Colyseus/PG/Redis/精确路由/Windows+K8s |
| RED-134 Windows 自治服路线 | 条件替换 | Windows 产品保留；托管/K8s runtime 由 RED-158 |
| RED-144 Supervisor/维护/日志/备份 | 条件替换 | Windows 内核保留；K8s 用 probe/drain/平台能力 |
| RED-147 Windows 控制台 | 条件替换 | 只服务 Windows，不给 K8s 复制 Dashboard |
| RED-148 Windows 安装/签名/回退 | 条件替换 | Windows 保留；K8s 用镜像/Gateway/rollout |
| RED-81 Android 权威宿主 | 替代 | 建 Android Colyseus 客户端/重连后继；离线手机宿主另立 High Risk 路线 |

已完成的 RED-99、109、116、127、131、141 提供 receipt、FIFO/Transition、Profile、单通道、重连和
Room runtime 隔离等验收不变量；只替换它们的 raw ws/SQLite 实现，不取消历史成果。

## 12. 后续 Phase B–F 实现合同

所有子任务均为 High Risk，实施当天重新 fetch origin/main、记录 base SHA、使用独立 RED 分支，并由
未参与实现的 AI 审查。禁止修改玩法、数值、随机算法、Profile 身份或 Trace 外部语义；禁止活动 Room
热切。B 与 D 是第一个可分发纵切的最高优先级，允许在冻结的 storage port 两侧并行，但不能同时修改
同一入口。Windows LAN 默认入口必须完成 B+C+D 与 E 的 Windows 生命周期子集；E 的 K8s/Redis 子集
不阻塞 Windows LAN 候选，但在多 Pod 托管入口启用前必须完成。

截至 2026-09-01 的落地状态：

| Phase | 实际状态 | RED-159 收口判断 |
| --- | --- | --- |
| B + D | RED-160 已合入 `main`；BattleRoom、PostgreSQL 双水位、25 ms / 8 条微批、version 0 与 terminal barrier 已落地 | 基础合同保持有效 |
| C | RED-161 已合入 `main`；默认 Electron/浏览器主链、公开投影、receipt、重连与 LAN 内置 PostgreSQL 16 已落地 | 实现证据归 RED-161 验收记录 |
| E | Windows 单实例部分由 RED-161 提前落地；K8s/Redis、精确 Pod 路由与 room-aware drain 尚未实现 | 合同继续作为后续实现门禁 |
| F | 尚未完成全量 Windows/K8s、SQLite 导入、100 Room、故障与退役验收 | 合同继续作为后续候选门禁 |

上述状态回填只记录实现进度，不把后续 Issue 的测试结果复制成 RED-159 的运行时验收，也不改变各
Phase 自己的 High Risk 审查、人工候选、合并和发布权限。

### Phase B：Colyseus BattleRoom 与规则适配

落地：RED-160 已合入 `main`；以下条目保留为回归与后续扩展门禁。

目标：

- 固定 Colyseus 0.18.x 服务端依赖，建立单进程 BattleRoom；
- 每 Room 一个私有 BattleState、一个 RoomRuleRuntime 和一个有界 Room FIFO；
- 把消息映射到现有 dispatch/runner 端口，不复制目标、timer、终局或 RED-139 Queue；
- 保留 clientActionId、expected version、Transition/hash 和精确 receipt；
- APPLIED 在所有内部 runBattleAction invocation 成功并完成一次内存提交后立即发送。

明确不包含：

- 不迁移浏览器客户端，不建立最终 Schema/StateView；
- 不改数据库 provider/migration，不删除 lib/ws-server.ts；
- 不做 K8s/Redis/Windows 打包或产品 matchmaking；
- 不把 BattleState 或 EffectChain 改成 Schema。

建议 allowed_paths：

- package.json、package-lock.json、可新增 colyseus.config.ts；
- 可新增 lib/server/colyseus/**；
- lib/game/room-authority-queue.ts、room-rule-runtime.ts、room-battle-actions.ts、
  room-battle-start.ts、battle-types.ts（只作 adapter 端口）；
- 可新增 tests/colyseus/** 和直接相关 room queue/runtime/command 测试；
- docs/qa/** 证据。

测试门：

- legacy adapter 与 BattleRoom 对同 seed/Profile/命令序列输出相同最终 state、version、Transition hash、
  Trace；
- 同 ID 提交 10 次只应用一次；
- 玩家/timer/pending/system 严格 FIFO，submitted action + synthetic timer 聚合仍只一次提交；
- 两 Room 交错 100 个 Transition 等于各自单房串行，无 runtime/RNG/RED-139 Queue 泄漏；
- 注入第二 invocation、hash、journal reserve 和 stale commit 失败，证明 BattleState 与
  TriggerSystem snapshot 一起回滚，重试等于干净执行；
- pending 不序列化 EffectChain，恢复从 root pre-state 重放；
- runner 非 pending 成功时显式证明 EffectChain settled/unloaded，遗漏 drain 必须 fail closed；
- Schema 不变化时 receipt 仍立即返回；
- D 未接入时生产/打包拒绝启用 Colyseus 候选。

依赖与回退：

- blocked by RED-159；与 D 通过 storage port 对接；
- 关闭显式启动选择器并整体回退新增入口/依赖；legacy 保持默认；不迁移活动 Room。

### Phase C：客户端 SDK、Schema/StateView 与重连

落地：RED-161 已合入 `main`；以下条目继续作为后续回归门禁。

目标：

- 建立小型、版本化的公开 read model；
- this.state 只承载公开字段，隐藏信息用 StateView/定向 message；
- receipt、语义 Transition、错误、resync 和 durable watermark 使用即时 message；
- 浏览器 SDK adapter 覆盖 health、目录、房间、选角、战斗、重连、完整 resync 与 outbox；
- epoch 变化清理旧 version/pending，显式选择 legacy 或 Colyseus，禁止静默 fallback。

明确不包含：

- 不在 UI/Schema 复制规则、合法目标或随机逻辑；
- 不把 patch 当 ACK、Trace 或恢复日志；
- 不改数据库、K8s、Windows UI，也不重设计 HUD/部署界面。

建议 allowed_paths：

- package.json、package-lock.json；
- lib/server/colyseus/battle-room.ts（只接 read model）及新增 schema/views；
- data/pages/js/ws-client.js、新 colyseus-client.js、对应 build script；
- lobby/room/piece-selection/maps/battle 等玩家页面；
- public state/projection/patch/reconnect/WS contract 测试；
- docs/qa/** 证据。

测试门：

- owner/对手/观者 fixture 证明手牌、部署、pending candidates 不泄漏；
- 默认 50ms patch 内连续变化收敛正确，但每个命令独立立即 receipt；
- 重复、乱序、旧 epoch 和同 epoch 低版本安全处理；
- 原 Room 活着时 reconnect，进程消失时完整重新匹配/恢复；
- resync 不自动执行移动、目标或 option；
- 客户端 outbox 只有在 durable watermark 覆盖后删除；
- legacy/Colyseus 对相同公开状态得到相同关键 HUD/棋盘/pending/终局。

依赖与回退：

- blocked by B；崩溃恢复依赖 D，多 Pod 依赖 E；
- 客户端与服务端按同一 build 整体切回 legacy，先停止新 Colyseus Room 并排空。

### Phase D：PostgreSQL 存储、恢复与 durable terminal

落地：RED-160 已合入最小纵切，RED-161 已用随包 PostgreSQL 16 补充真实集成和 Windows 生命周期；
SQLite 离线 exporter/importer 与完整生产恢复演练仍未完成。

目标：

- PostgreSQL 成为唯一新运行时真源，建立本文五类核心表和约束；
- typed、按 Room 保序、有界的 25ms/8 条 microbatch writer；
- 普通 APPLIED 不等待 flush，lag/watermark/retry/degraded 可观察；
- 每 16 Transition、换回合和终局 checkpoint；
- 恢复只到完整验证的 durable watermark；
- terminal/reward hook/delete/backup/shutdown 等待 barrier；
- 一次性 SQLite 只读 exporter/importer/validator，原文件不可变。

明确不包含：

- 不保留 SQLite runtime provider、busy_timeout、writer、同步 fallback 或双写；
- 不实现 Elo/赛季/完整账本，只定义 durable terminal 消费口；
- 不改客户端 Schema、K8s 或 Windows Dashboard；
- 不删除原 SQLite，不放宽 hash/缺号恢复。

建议 allowed_paths：

- package.json、package-lock.json；
- prisma/**（PostgreSQL schema/baseline；旧 SQLite 只作为迁移输入说明）；
- lib/db.ts、新增 lib/server/postgres/**；
- battle-authority-persistence、async-journal、shutdown、terminal、room-store/battle-storage 接线；
- 新增 scripts/migrate-authority/**、init-db、docker compose；
- 真实 PostgreSQL integration、journal/persistence/recovery/shutdown/terminal 测试；
- docs/qa/** 证据。

测试门：

- 真实临时 PostgreSQL 完成空库 migration、写、重启、恢复，不只 mock；
- 8 条/25ms、跨 Room 公平、每房顺序、队列上限有原始时序；
- DB 阻塞时普通 APPLIED 仍满足延迟门，durable lag 明确增长；
- 有限重试隔离单 Room，其他 Room 继续；
- receipt 后 flush 前强杀只恢复旧 watermark；commit 后恢复相同 hash；
- 重复写、响应丢失、恢复不重复 Transition/终局；
- 缺号、坏 hash/checkpoint/Profile/runner fail closed；
- terminal barrier 前无奖励/账本/删除/backup 成功；
- SQLite 导入逐表/键/hash/fixed-seed 抽样匹配；
- 新候选依赖图和配置中没有 SQLite runtime。

依赖与回退：

- blocked by RED-159；与 B 组成首个可运行纵切；
- 停新 Room、关闭 ingress、记录/导出 PG watermark，整版回旧 release + 原始 SQLite 备份；
- 禁止新 runtime 切数据库或活动 Room 降级。

### Phase E：K8s/Redis 精确路由、drain 与 Windows 单实例

落地：Windows LAN 单实例部分由 RED-161 提前实现；K8s/Redis 与多 Pod 路由/drain 仍待后续任务。

目标：

- K8s 多 Pod 配置 Redis Presence/Driver 和 PostgreSQL；
- 每 Pod 稳定身份和客户端可达 publicAddress，经 per-Pod Service/Gateway 精确路由；
- readiness 覆盖协议、Profile、PG、Redis、runtime、route 和 drain；
- SIGTERM/maintenance 顺序执行准入关闭、Room drain、journal barrier、route 撤销和退出；
- 自动 scale-up；scale-down 只选空且已 drain worker；
- Windows 复用同一 Room，以单实例 Colyseus + 获批 PostgreSQL 方案运行。

明确不包含：

- 不承诺活动 Room live migration；
- 不把 Redis 当 authority/Trace/terminal；
- 不把 experimental Traefik 当唯一生产路由；
- 不改规则、客户端协议、Schema 或 PG 数据模型；
- 不在 K8s 复制 Electron Dashboard，不做自动 scale-down/跨区容灾。

建议 allowed_paths：

- package/lock、docker-compose、Dockerfile/.dockerignore；
- 新增 deploy/k8s/** 或 deploy/helm/**，实施时二选一为 canonical；
- lib/server/colyseus/** 仅 bootstrap/Presence/route/health/drain；
- 新增 deployment config；
- Electron lifecycle/preload/dashboard 仅新 runtime 状态接线；
- server builder/staging/verifier；
- 新增 deployment 测试和 Windows package/security/smoke 测试；
- docs/qa/** 证据。

测试门：

- 至少两 worker + Redis + PostgreSQL 的真实环境完成匹配、精确路由和双客户端一局；
- 无 sticky cookie 仍到 reservation 指定 process，错误路由为 0；
- 活动 Room 缩容被阻止，空 Pod drain 后移除；
- SIGTERM 拒绝新 Room并按合同排空；SIGKILL 只从 watermark 以新 epoch 恢复；
- Redis 故障不污染本地 Room，新匹配按合同暂停；
- Windows/K8s 同 fixture 输出同 state/hash/Trace；
- Windows 包从仓库外启动，由两客户端完成一局；
- 镜像/Windows artifact 记录不可变 hash、version tuple 和回退目标。

依赖与回退：

- blocked by B/C/D；Windows 部分与 RED-134/144/147/148 对齐；
- 保留上一镜像、Gateway 配置和 Windows artifact；drain 后整体回滚进程/路由，PG 不自动降 schema。

### Phase F：候选、故障/性能验收与旧路径退役

目标：

- legacy 与 Colyseus 对同 seed/Profile/命令序列做差分候选；
- 分段采集客户端、Gateway、Room FIFO、EffectChain、rules/hash、receipt、Schema、journal、PG commit；
- 验证至少 100 个活动 Room 的隔离、背压、恢复和容量；
- 完成 Windows/K8s、SQLite 导入、进程/Pod/DB/Redis 故障与双客户端验收；
- 门禁通过且人工批准后才把 Colyseus 设默认、拒绝新 legacy Room；
- “候选验收”和“删除 raw ws/SQLite runtime”必须是两个可独立回退的提交。

明确不包含：

- 不降低延迟门槛，不修改玩法/规则/随机/Profile/Trace；
- 不自动 merge/publish/删除 SQLite 备份或真实数据；
- 不在线切活动 Room；
- 负载脚本不吞错误、不用无限重试掩盖失败、不只报平均值。

建议 allowed_paths：

- 候选阶段：新增 authority benchmark、fault injection、load/E2E；validation profile；Windows smoke；
  docs/qa；package 仅新增脚本；
- 人工批准后的退役阶段：lib/ws-server.ts、旧 same-port server/proxy、客户端 legacy adapter、
  Electron 正式入口、package/lock、直接相关 contract tests 和 legacy SQLite runtime 接线；
- 退役提交禁止修改规则、内容、AI、新 Schema、PG migration 或 BattleRoom。

测试门：

- 固定 seed 差分覆盖建房、选角、渐进部署、普通动作、多步 pending、timer、重连、投降和终局；
- 10/50/100 活动 Room 各至少三轮，保存原始 P50/P95/P99；
- 普通 APPLIED 达门槛，terminal durable 延迟单独报告；
- 长 EffectChain、队列溢出、PG retry exhaustion/quarantine 不拖其他 Room；
- 覆盖重复/乱序/旧 epoch/断线/Pod 强杀/Redis/PG/SIGTERM/坏 checkpoint；
- SQLite→PG 行数、唯一键、hash chain、抽样回放匹配；
- Windows/K8s 各至少三局真实双客户端；
- 全量测试、两类构建、依赖审计、High Risk 审查无未处理 High/Critical；
- 退役后生产包无 raw ws 服务入口、SQLite provider/writer 或静默 fallback；
- 默认切换、旧路径删除、合并和发布均需单独人工确认。

依赖与回退：

- blocked by B/C/D/E，且 RED-142/143/145/146/149 已按本合同改写；
- 保留最后 legacy release、前一 Colyseus 候选、原 SQLite 备份和 PG 导出；失败时 drain 后整版回退。

## 13. 执行优先级与当前进度

1. A：RED-159 合同、ADR、schema、故障和 Issue 迁移矩阵；
2. B + D：最小可运行 BattleRoom + PostgreSQL 垂直切片，先证明普通 APPLIED 不等 DB；
3. C：客户端 SDK、公开投影、精确 receipt、outbox、重连；
4. E：Windows 单实例、K8s/Redis/精确路由/drain；
5. F：双栈、故障、延迟、真实客户端验收；人工批准后退役旧路径。

当前已完成 B+C+D 的合入，E 仅完成 Windows LAN 子集，F 尚未开始完整验收。该进度
不会把未执行的 K8s/Redis、SQLite 导入、100 Room 或双平台候选写成通过。

B+D 纵切已达到可重复本机运行并合入；后续扩展仍不得降低延迟、幂等、恢复和可分发性门禁。
RED-139 已合入，其公共规则端口继续是 BattleRoom 唯一允许的 EffectChain 适配边界。

## 14. 相关依据

- [ADR-0025](../decisions/ADR-0025-colyseus-postgresql-authority.md)
- [RED-159 验收](../qa/RED-159-colyseus-postgresql-contract.md)
- [RED-160 纵切验收](../qa/RED-160-colyseus-postgresql-vertical-slice.md)
- [RED-109 延迟基线](../qa/RED-109-authority-transition-baseline.md)
- [ADR-0017 权威 Transition](../decisions/ADR-0017-authority-transition-pipeline.md)
- [ADR-0020 单一玩家 WebSocket](../decisions/ADR-0020-unified-player-websocket-transport.md)
- [ADR-0021 Windows 自治运维](../decisions/ADR-0021-autonomous-server-operations.md)
- [ADR-0016 Trace v2](../decisions/ADR-0016-trace-v2-recorded-state-replay.md)
- [Server Operations v1](./SERVER_OPERATIONS_V1.md)
- [模块接口](./MODULE_INTERFACES.md)
- [Colyseus 0.18 migration](https://docs.colyseus.io/migrating/0.18)
- [Colyseus database](https://docs.colyseus.io/database)
- [Colyseus room](https://docs.colyseus.io/room)
- [Colyseus scalability](https://docs.colyseus.io/scalability)
- [PostgreSQL MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html)
- [PostgreSQL WAL](https://www.postgresql.org/docs/current/wal-configuration.html)
