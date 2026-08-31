# ADR-0023：Colyseus 房间权威与 PostgreSQL 有界异步耐久化

- 状态：已接受
- 日期：2026-08-31
- 人工批准：2026-08-31
- 关联任务：RED-159
- 父路线：RED-158
- 风险：High
- 基线：`main@52632636d16dce0a912cab428dc563c59eb4f605`
- 收尾同步基线：`main@dc9bca46c06e2852621620180e8869a924e29bfa`
- 规范合同：[Colyseus/PostgreSQL 迁移合同](../technical/COLYSEUS_POSTGRESQL_MIGRATION.md)
- 验收记录：[RED-159 合同验收](../qa/RED-159-colyseus-postgresql-contract.md)

## 背景

现有权威管线已经证明“规则、版本、hash 和内存状态提交后先回执，数据库随后落盘”可以把本机服务端
`dispatch → receipt` 从旧管线的 P50 58.922 ms / P95 102.072 ms 降到 P50 12.196 ms /
P95 15.878 ms。但是当前运行时仍由自建 WebSocket 路由、Prisma 和 SQLite 组成；SQLite 即使启用
WAL 仍只有一个 writer，房间、恢复、部署和客户端路由也缺少一套可横向扩展的明确边界。

问题不是“游戏能否使用 SQL”。大量游戏把账号、库存、对局、赛季、排名和审计数据放在关系型数据库；
问题是普通动作是否被数据库提交阻塞。本项目需要把实时权威、可靠持久化和查询分析分层：

- 当前 HP、位置、AP、pending 和回合状态由单个房间 actor 在内存中权威持有；
- 可恢复的命令、Transition、receipt 和 checkpoint 进入 PostgreSQL；
- 终局、奖励、排名、删除、备份与优雅停服使用明确的 durable barrier；
- Redis 只承担多进程房间目录、Presence 和路由协调，不成为战斗状态真源。

RED-159 只冻结迁移边界、耐久语义、部署拓扑和后续任务拆分，不实现 Colyseus、PostgreSQL schema、
客户端 SDK、Kubernetes 资源或 Windows 候选。

## 决策

项目负责人于 2026-08-31 明确批准：

| 决策 | 冻结值 |
| --- | --- |
| D1 部署产品 | Windows 自治服单实例与开发者 K8s 多 Pod 同时保留，复用同一 BattleRoom 核心 |
| D2 ACK/耐久 | 普通 APPLIED 不等数据库；25ms/8 条 PoC 微批；关键边界等 DURABLE |
| D3 状态同步 | 私有普通 BattleState + 小型 Schema/StateView + 即时 receipt/语义 message |
| D4 K8s 路由 | 稳定 Pod 身份 + per-Pod Service/Gateway 精确路由；experimental Traefik 只作 PoC |
| D5 SQLite | PostgreSQL 是新运行时唯一真源；SQLite 只作离线只读导出和不可变回退证据 |

### 1. 产品和运行拓扑

采用 Colyseus 0.18.x 作为新的玩家联机房间框架，采用 PostgreSQL 作为新运行时唯一耐久数据库。
具体 patch 版本和 lockfile 在第一个可运行实现任务中固定；生产 Node.js 基线为 22 或更高。

同一套 `BattleRoom`、权威规则适配器、命令信封、Transition、receipt 和恢复协议必须同时支持：

1. Windows 单实例：一台主机一个 Node/Colyseus 进程，直接连接固定地址；可以使用
   `LocalPresence` / `LocalDriver`，但不能以此声称多进程已验证；
2. Kubernetes：一 Pod 一 Node/Colyseus worker 进程，Redis Presence + Redis Driver，
   PostgreSQL 耐久化，并使用 process-aware 精确路由；
3. 开发环境：可以使用本地依赖，但不得因为 Colyseus 示例默认 SQLite 而把 SQLite 带回候选运行时。

单个 Room 始终完整归属一个进程。扩容只增加可承载的 Room 数，不拆分单 Room、不提供 live migration。

### 2. 权威状态与传输边界

`BattleState` 是 Room 内私有权威状态，继续复用现有确定性规则、每房间 FIFO、版本、hash、
Transition 和独立规则运行时。Colyseus `Schema` 只是最小、按接收者过滤的 `StateView`，不能包含隐藏
信息，也不能作为恢复、审计或 Trace 真源。

普通命令路径固定为：

```text
client command
  -> BattleRoom auth/build/profile/epoch validation
  -> existing bounded per-room FIFO
  -> deterministic rules + version/hash/Transition
  -> in-memory authority commit
  -> exact receipt(APPLIED) directly to requester
  -> recipient-specific StateView/patch publication
  -> bounded PostgreSQL journal queue
```

异步 `onMessage` handler 不被当作天然串行保证；所有玩家、pending、计时器和机器人命令仍进入现有
每房间 FIFO。请求和回执保留 `requestId` 与 `clientActionId` 幂等边界。精确回执用直接消息发送，
不得等待默认 50 ms 的 Schema patch tick；Schema patch 只负责展示投影。

### 3. `APPLIED` 与 `DURABLE` 是两个不可混淆的水位

`APPLIED` 表示以下步骤已全部成功：

- 信封、身份、seat、build、Profile、epoch 和 expected version 已校验；
- 命令已从本房间 FIFO 串行执行；
- 规则、随机游标、候选、前后 hash、action hash 和 transition chain 已验证；
- 私有 `BattleState`、`authorityVersion`、精确 receipt 和待持久化记录已原子提交到当前 Room 内存；
- 后续同房间命令立即观察到该状态。

`APPLIED` 不表示 PostgreSQL 已提交。普通 action 的成功回执不得等待数据库、Redis、Schema patch
或分析流水线。内存状态提交前必须先证明 durable queue 有容量并接收完整 job；队列满时在污染状态前
拒绝，不能先回执再丢掉唯一持久化路径。

receipt 至少携带 `roomId`、`clientActionId`、`actionHash`、`authorityVersion`、
`stateHash`、`transitionHash`、`durableAuthorityVersion` 和
`durability: pending | durable`。

`DURABLE(N)` 表示 PostgreSQL 内已经提交并可独立验证从基准 checkpoint 到 N 的无缺口连续前缀：

- Transition、receipt、版本、前后 hash 和 chain head 一致；
- 同一 `clientActionId` 不会被重复结算；
- checkpoint 与后续 Transition 足以恢复并重算到 N；
- `battle_room_authority.durable_version >= N` 与同一事务写入的事实一致。

服务端通过单调 `durableAuthorityVersion`/durable watermark 通知客户端。客户端把尚未被 durable
watermark 覆盖的命令保存在有界 outbox；断线后只能按原 `clientActionId` 重交未获耐久证明的命令，
服务端依据 receipt/唯一约束去重。若 epoch 已变化或命令基于过期候选，服务端返回 resync/rejected，
不得盲目重演目标或选项选择。

### 4. 有界微批与同步耐久边界

每个房间产生有序 journal item、独立 accumulator 和连续前缀事务；跨房间由有界公平 scheduler 与
PostgreSQL 连接池并行，不保留 SQLite 式全局单 writer。首个可运行 PoC 的初始参数为：

- 最长聚合时间：25 ms；
- 单批最多 8 条 Transition；
- 每 16 个权威版本生成 checkpoint；
- 换回合、终局、维护/备份和优雅关闭额外生成 checkpoint；
- 队列、字节、年龄和连接并发均必须有上限，达到安全线时对该房间背压或 fail closed，禁止无界积压。

第一条 job 入队启动 dwell timer；最老 job 等满 25 ms 或累计 8 条时，以先发生者触发 flush。backlog
超过 8 条时连续 drain，不为每批重新等待。25 ms 只约束健康时聚合等待，不包含 PostgreSQL 事务时间。
这些参数是测量起点，不是永久数值。

一个 PostgreSQL authority 事务只提交一个 Room 的连续 Transition/receipt/checkpoint 前缀，并以 CAS
或行锁推进 room durable watermark；事务失败不得越过队首、制造版本空洞或把后续批次标为 durable。
不同房间使用不同事务并行，一个房间的故障不能回滚或阻塞其他房间。

下列边界必须等待 PostgreSQL durable commit：

- 初始 version 0 checkpoint 与进入可行动状态；
- 终局 Transition、最终 checkpoint 和 terminal barrier；
- 奖励、排名、赛季积分和具有外部经济影响的 settlement；
- 房间删除或归档；
- verified backup、部署切换、维护完成和优雅停服。

终局 UI 可以在内存规则裁决后立即展示“结算中”，但只有 terminal barrier durable 后才能产生奖励、
排名或可删除房间的最终成功结果。

### 5. RED-139 Queue 兼容边界

Colyseus 的 Room FIFO 与 RED-139 的 Effect Queue 是不同层级，禁止合并或互相绕过：

    Room command FIFO（跨命令串行）
      -> one authoritative command transaction
         -> one or more runBattleAction invocations
            -> fresh RED-139 EffectChain per invocation
               -> typed Damage/Heal/Summon/Death Batch/Queue
         -> command-level invariant/hash/Transition
      -> one APPLIED receipt

- Room FIFO 只决定玩家、pending、timer、AI 和 system command 的先后；不解释 Damage/Heal/Summon/
  Death，也不提供跨类型隐式优先级。
- 每次 runBattleAction invocation 恰好创建一个新的瞬态 EffectChain；一个外层 FIFO job 可以原子
  聚合 submitted action、synthetic turnTimerSync 等多个内部 rule command。所有 invocation 都成功后
  才能一次提交 BattleState、推进一次 authorityVersion 并生成一个外层 Transition/receipt。
- BattleRoom 不创建、安装、排空或恢复 EffectChain。APPLIED 绝不能在任一 invocation 仍有 batch、
  follow-up、after/lifecycle 或 Death finalization 未完成时发送。
- Effect Queue 不能直接发送 Colyseus message、修改 Schema、写 PostgreSQL 或推进 durable watermark；
  它只返回确定性的状态、轨迹、错误和 pending 结果给规则事务。
- Colyseus handler 不得捕获 RED-139 异常后继续，也不得把失败 batch 的部分状态投影给客户端。
- 一个 FIFO job 只产生一个外层 receipt；Transition 只保存聚合后的内部命令、最终 state/patch/hash
  和既有 action Trace/replay，不把每个 batch 伪装成网络命令、authority version 或新增持久化字段。
  batch 诊断默认只存在于 helper 结果、TriggerContext 和测试 recorder；未来若要持久化必须另立合同。
- 动作遇到合法 pending 时不得提交或序列化半个 Batch/Queue。只保存既有 pending transaction 的根动作、
  答案序列和 RuleRuntime checkpoint；部分效果回滚。回答/恢复作为新的外层命令，从 root pre-state
  新建 EffectChain 确定性重放，不能续跑旧进程中的 chain。
- RED-139 的 state hash、固定 seed、Node/浏览器 parity 和完整回滚验收继续有效；Colyseus 适配器只能
  调用公开命令端口，不能 import 内部 handler 另走一条“快速路径”。
- Batch Commit 只发生在 runBattleAction 私有 clone 内；APPLIED/Transition Commit 是外层 FIFO job
  唯一一次内存 swap；DURABLE Commit 才是完整外层记录进入 PostgreSQL。三者不得共用一个“已提交”
  布尔值，也不得把 EffectBatch 单独落库。
- room-authority-queue.ts 是唯一跨命令 FIFO。若共享 command port 已调用 dispatchRoomBattleAction，
  BattleRoom 不得再套第二个 queue；它也不得在 runBattleAction/EffectChain 同步作用域内 await、I/O、
  发消息或 import createEffectChain/drain/writer。
- 每次外层 Transition attempt 在第一个 rule invocation 前快照 RoomRuleRuntime/TriggerSystem 的事务
  状态。后续任一 invocation、hash/build、journal capacity reserve、stale commit/CAS 或内存 swap
  失败，都必须同时恢复 BattleState clone 与该规则运行时快照；只有 APPLIED/Transition Commit 成功
  才保留 trigger limits、event cursor 等副作用。单 actor 可以减少正常 CAS 争用，但不能省略此回滚。
- runner 的合法结果是“完整成功、合法 pending、失败”三类。合法 pending 丢弃 provisional batch 状态、
  卸载瞬态 chain，只提交基于 root pre-state 的 pending session，并可产生一次外层 APPLIED；pending
  answer 仍作为 pending action 交给 runner，BattleRoom 不展开 rootAction。
- duplicate/resync 必须在 runner 前处理，batchId 不能成为网络幂等键。非 pending 成功返回前 runner
  必须 fail closed 证明 EffectChain idle、pendingCount=0、无 current batch 且已卸载；该后置条件由
  RED-139 公共 runner 提供，BattleRoom 不读取内部 ledger 补查。
- 权威路径禁止 detached effect helper；所有四类效果必须存在于 runner 的同步 RuleExecutionContext/
  EffectChain scope。恢复只使用已持久化 checkpoint/Transition，不恢复或重放 EffectChain ledger。

因此 RED-139 可以独立合并。后续 BattleRoom 适配必须以它在合并时提供的规则命令入口和最终
BattleActionResult 为边界；若 RED-139 改变公共网络协议、BattleActionTrace 或 Transition schema，
应先暂停并更新两个 High Risk 合同，而不是在 Colyseus 任务中猜测兼容。

### 6. PostgreSQL 是唯一耐久真源

新运行时不包含 SQLite provider、SQLite writer、busy_timeout、WAL 初始化、SQLite/PG 双写或运行时
数据库切换开关。PostgreSQL 持有至少以下逻辑实体，字段和索引详见技术合同：

- battle_room_authority：battle 身份、epoch、状态、当前 durable version 与 chain head；
- battle_transition：连续命令、内部/公开差异、hash、Trace/恢复证据；
- battle_receipt：clientActionId 幂等结果；
- battle_checkpoint：版本化完整私有状态与确定性恢复信息；
- battle_terminal_barrier：终局与 settlement 的唯一耐久门禁。

不同 Room 不共享一行高频更新热点。房间内单写序列与数据库唯一约束共同保证幂等；PostgreSQL MVCC
和连接池只用于跨 Room 并发，不能替代 Room FIFO。

Redis 不是战斗状态、journal 或 checkpoint。Redis 故障时停止新匹配和跨进程定位；现有本地 Room
只能在不依赖 Redis 的已验证路径上继续，并继续向 PostgreSQL 落盘。该降级行为必须通过故障注入，
不能假设 Colyseus 自动保证。

### 7. SQLite 迁移和删除边界

现有 SQLite 数据不会被直接删除。迁移只允许一个独立、一次性、离线、只读 exporter：

1. 进入维护并停止旧运行时的所有 writer；
2. 创建不可变原始备份并记录文件 hash、schema、记录数和链水位；
3. exporter 只读打开备份，输出版本化、可校验的中间数据；
4. 导入 PostgreSQL staging，并验证主键、唯一键、计数、Transition 连续性、hash/Trace 和 terminal；
5. 用候选运行时只读恢复/回放，人工批准后切流；
6. 原始 SQLite 备份作为迁移证据保留，不在本路线中删除。

exporter 不是新服务依赖，不能被 BattleRoom import，也不能在运行时双写或 fallback。用户若未来要求
删除原始数据，需要针对精确备份路径单独确认。

### 8. Kubernetes 的精确路由、排空与恢复

普通 Kubernetes Service 轮询只适合初次 matchmaking，不能把已分配 Room 的 WebSocket 随机送到
任意 worker。seat reservation 必须返回持有 Room 的 process/public address；该地址从公网可解析、
TLS 可验证且唯一到达目标 worker。cookie/IP sticky 不能替代 process-aware routing。

生产首选是稳定 Pod 身份配合自动生成的 per-Pod Service/Gateway route，或等价的受控 worker
registry。官方 @colyseus/traefik 当前为 experimental，只能作为 staging PoC，不能成为唯一生产方案。

worker drain 顺序固定为：停止新 Room/seat → readiness=false → 保持 liveness → 等现有 Room 在期限内
结束，或建立 durable checkpoint 后进入恢复 → 注销 route → 核对 durable watermark → 退出。
terminationGracePeriodSeconds 必须覆盖 drain deadline、checkpoint timeout 和路由传播。HPA 初期只
自动 scale-up；scale-down 只能选择 roomCount=0 且已排空的 worker。

崩溃恢复使用稳定 battleId，不把运行时 roomId/processId 当永久身份。新 worker 通过 PostgreSQL 租约
或 fencing token 获取更高 epoch，恢复最近 checkpoint 并重放到 durable watermark；旧 epoch 写入
全部拒绝。原 Room 尚存活时可使用普通 reconnection；原进程死亡时必须重新 matchmaking，取得新的
room/process address，不能依赖旧 reconnection token 跨进程复活。

### 9. Windows 与 Kubernetes 复用同一核心

Windows 单实例和 Kubernetes worker 必须调用同一个 BattleRoom 与 PostgreSQL adapter，不能分别维护
游戏规则、Transition 或恢复实现。Windows 单实例可以不运行 Redis；一旦验证 Windows 多进程，必须
启用与生产相同的 Redis Presence/Driver 和精确路由，且每进程使用独立端口和 public address。

Windows 服务停止不能只依赖 POSIX signal；Supervisor/服务管理脚本应先调用受保护 drain 入口，等待
durable barrier 后再结束进程。PostgreSQL 在 Windows 上采用外部已支持服务还是随产品安装，由后续
发行任务单独批准；本 ADR 不授权静默安装数据库服务或修改机器级配置。

### 10. 与既有 ADR 的关系

本 ADR 有选择地取代实现细节，而不重开已验证的规则合同：

| 既有决策 | 保留 | 被本 ADR 取代 |
| --- | --- | --- |
| [ADR-0017 权威 Transition 管线](./ADR-0017-authority-transition-pipeline.md) | 每房间 FIFO、协议 v3、精确 receipt、私有/公开 patch、hash chain、Trace、恢复审计、房间运行时隔离 | raw WebSocket 编排、Prisma/SQLite/WAL/busy_timeout、单全局 SQLite writer、运行时 SQLite 同步 fallback |
| [ADR-0020 玩家 WebSocket](./ADR-0020-unified-player-websocket-transport.md) | 玩家业务单通道、requestId、clientActionId、重连与旧 REST 410 原则 | 自建 ws 服务端实现和由它维护的房间/进程路由 |
| [ADR-0021 自治服务器运维](./ADR-0021-autonomous-server-operations.md) | 生命周期、maintenance/drain、durable terminal、签名发布、verified backup 与整版回退原则 | SQLite Online Backup/WAL/provider、旧 DB schema 和 SQLite 专属恢复细节 |
| [RED-139 / ADR-0022 Effect Batch/Queue](https://linear.app/redvsblue/issue/RED-139/建立四类确定性-effectbatchqueue-并冻结同时语义白名单) | 动作内四类 Queue、稳定顺序、原子回滚、预算、轨迹与 hash 合同全部保留 | 无；Colyseus 只能包裹其命令边界 |
| [ADR-0016 Trace v2](./ADR-0016-trace-v2-recorded-state-replay.md) | 全部保留：回放记录事实，不用新规则重跑历史 | 无 |

ADR-0022 由并行 RED-139 交付；本 Phase 0 只依赖其已批准 Linear 合同，不 import 未合并文件或实现。
后续代码任务必须先同步已合并的 RED-139 公共端口。Colyseus 候选通过完整验收前，旧 release 仍可作为整版
回退目标单独启动；同一进程、同一战局和同一数据根不得同时运行两套 transport/database，也不得运行中
热切换。

## 备选方案

- 继续调优 SQLite：可以改善小规模写入，但不能消除单 writer、分布式进程目录和精确路由问题；不采用。
- 每条 action 等 PostgreSQL：RPO 简单，但把网络、锁、WAL flush 和故障切换抖动带回操作手感；只在
  明确 durable barrier 使用。
- 每若干 action 同步一次数据库但不暴露水位：平均更快，但客户端无法判断哪些已确认动作可能丢失；
  改为有界微批 + durable watermark。
- 把 Colyseus Schema 当完整真源：会泄露私有状态，并缺少审计/恢复所需命令与 hash；不采用。
- 把 Redis 当战斗持久层：适合 Presence/目录，不满足长期事实、关系约束和恢复证据；不采用。
- 立即引入 DynamoDB、Spanner 或事件平台：当前两人回合制负载不需要其成本和运维复杂度；不采用。
- 同时双写 SQLite 与 PostgreSQL：扩大故障矩阵且无法定义分叉时谁是真源；不采用。
- 在一个 PR 中替换服务、客户端、数据库和部署：不可审查、不可回退；按 Phase B–F 垂直切片推进。

## 影响与风险

- 普通动作手感不再受数据库 fsync 直接支配，但应用确认与耐久确认之间存在显式、受上限约束的窗口。
- 崩溃时最多只能恢复到 durable watermark；客户端 outbox、epoch、幂等 receipt 和用户可见 resync
  必须共同处理窗口内命令，不能谎称 RPO=0。
- PostgreSQL 消除 SQLite 单 writer 约束，但错误 schema（例如所有 Room 更新一行）仍会制造新热点。
- Colyseus 减少房间生命周期和 SDK 的自建代码，却不自动提供严格命令串行、动作内 Effect Queue、
  持久化、跨进程 Room 恢复或正确 K8s 路由；这些仍是项目责任。
- 新增 PostgreSQL、Redis 和 process-aware routing 的部署成本。Windows 单实例不强制 Redis。
- 迁移期间保留旧 release 和不可变 SQLite 备份会占用额外存储，但提供可审计回退证据。
- 本 ADR 不改变角色、卡牌、地图、AI、随机算法、经济或排位算法，也不授权公开发布或数据删除。

## 验证方式

RED-159 文档阶段执行基线、编码、Markdown link 和 diff 检查，并由未参与实现的 AI 独立审查。
后续候选至少必须验证：

1. 收集 receive/decode、FIFO wait、EffectChain、rules/hash、receipt enqueue/client receive、patch、
   journal enqueue、PostgreSQL commit 和 durable watermark 的分段时间；
2. 本机/LAN 普通 action 端到端 P50 ≤ 50 ms、P95 ≤ 100 ms、P99 ≤ 150 ms，且阻塞 PostgreSQL 时
   预热后 dispatch → APPLIED receipt P95 仍 < 100 ms；
3. 同房间 FIFO、RED-139 动作内原子 Queue、跨房间并行、25 ms/8 条微批、队列上限、重试、背压和
   watermark 无空洞；
4. terminal/reward/rank/delete/backup/shutdown 在 durable barrier 前绝不宣告完成；
5. SIGTERM、SIGKILL、Redis 故障、PostgreSQL 延迟/切换、错误 route、Pod IP 变化、并发恢复和
   Windows 强杀故障注入；
6. SQLite 只读导出前后记录数、键、版本链、hash、Trace 和固定种子恢复完全一致；
7. 两台真实客户端完成匹配、选将、战斗、pending、终局、普通重连和 worker 崩溃恢复。

完整矩阵见 [RED-159 合同验收](../qa/RED-159-colyseus-postgresql-contract.md)。

## 回退方式

本 Phase 0 只新增文档，可整体 revert RED-159 文档提交。可运行迁移阶段只允许整版回退：

1. 停止新房间 admission 并排空/终止 Colyseus 候选；
2. 保存 PostgreSQL 导出、日志、watermark、epoch 和失败证据；
3. 从迁移前不可变 SQLite 备份启动匹配的旧 release；
4. 明确告知 cutover 后只存在于 PostgreSQL 的对局不会出现在旧 release；
5. 不让旧 binary 打开 PostgreSQL 数据，不把 PostgreSQL 反向写入旧 live SQLite，不在运行中热切换。

若已经产生奖励、排名或外部经济事实，必须先完成专门的数据协调方案，不能用代码回退覆盖已结算事实。

## 相关资料

- [RED-158](https://linear.app/redvsblue/issue/RED-158/路线-将权威联机迁移至-colyseus-postgresql并建立-k8swindows-双部署)
- [RED-159](https://linear.app/redvsblue/issue/RED-159/phase-0-合同-冻结-colyseuspostgresql-迁移边界耐久语义与双栈验收)
- [RED-139](https://linear.app/redvsblue/issue/RED-139/建立四类确定性-effectbatchqueue-并冻结同时语义白名单)
- [Colyseus Rooms](https://docs.colyseus.io/room)
- [Colyseus State Synchronization](https://docs.colyseus.io/state)
- [Colyseus Driver](https://docs.colyseus.io/server/driver)
- [Colyseus Deployment](https://docs.colyseus.io/deployment)
- [Colyseus Scaling](https://docs.colyseus.io/scalability)
- [Colyseus Graceful Shutdown](https://docs.colyseus.io/server/graceful-shutdown)
- [Colyseus Traefik（experimental）](https://docs.colyseus.io/scalability/traefik)
- [PostgreSQL MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html)
- [PostgreSQL WAL 配置](https://www.postgresql.org/docs/current/wal-configuration.html)
- [SQLite WAL](https://sqlite.org/wal.html)
- [RED-109 性能基线](../qa/RED-109-authority-transition-baseline.md)
