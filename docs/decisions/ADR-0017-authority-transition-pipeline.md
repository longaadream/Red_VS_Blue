# ADR-0017：低延迟服务端权威 Transition 管线

- 状态：Proposed（等待 RED-109 候选构建与人工 LAN 验收）
- 日期：2026-08-25
- 任务：RED-109
- 扩展任务：RED-131、RED-141
- 风险：High
- 基线：`main@a7c1d57da7b025fb69c9c24a3a04d3c5797d6132`
- RED-131 扩展基线：`main@5752f36f78254cc3d9b284bd295943e4ed796f5e`
- RED-141 扩展基线：`main@4bca9fd3b4c903ee275eac5dfa6175f467dd53b0`

## 背景

旧 LAN 权威链路在每条命令中同步重载规则文件、生成不断增长的完整 Trace、序列化并 CAS
保存整个 `Room.battleState`，随后广播完整公开快照。加入部署与回合计时器后，玩家命令、pending
响应、机器人和超时还会竞争同一个房间版本。实际体验出现 2–5 秒确认等待、旧命令重复提交、
目标候选到达过晚和完整快照重渲染。

RED-99 的精确 `clientActionId` 回执只解决“哪个命令得到确认”，不能减少规则、存储和渲染成本，
也不能在版本断层时构造缺失的状态变化。RED-109 因此替换 RED-108 的候选实现，且明确禁止联网
客户端通过本地规则 dry-run 裁决合法目标或选项。

## 决策

1. 每个房间只有一个有界 FIFO 权威队列。玩家、pending、计时器与机器人命令都进入同一串行提交
   边界；不同房间可以并行。队列等待、规则执行、持久化和总耗时分别记录。
2. 联网命令使用协议 v3 信封：`protocolVersion=3`、固定 `authorityBuildId`、`roomId`、精确
   `clientActionId`、`playerId`、`expectedAuthorityVersion`、可选选择会话凭证和命令体。WS 订阅、
   WS 动作和 HTTP 后备入口必须同时校验协议与 build；不兼容客户端在登记订阅或运行规则前拒绝。
   服务端返回与该 ID 对应的 `applied | duplicate | rejected | resyncRequired` 回执。数据库中完整的
   v2 链仍可恢复，但恢复后不得向同一链追加 v3 Transition；新对局只写 v3。
3. `Room.version` 只保护大厅和房间元数据写入；`battleAuthorityVersion` 只由成功的权威战斗
   Transition 推进。重连、身份资料或房间元数据写入不得制造战斗版本空洞，也不得覆盖较新的战斗版本。
4. 服务端执行正式规则并生成完整合法候选。客户端只显示权威 `pendingOptionSelection` /
   `pendingTargetSelection` 中的候选并提交选择；候选只投影给 pending owner，对手和观者只接收等待会话的公开信封。联网路径不执行规则 dry-run。训练模式仍可在本地运行引擎。
5. 普通成功命令生成连续的 `fromVersion → toVersion` Transition、内部状态 patch、按接收者重新
   投影的公开 patch、前后 hash、精确 action hash 与连续 transition hash 链，并返回精确回执。客户端仅在前版本和前 hash 都匹配时应用 patch；任何
   断层或 hash 不一致都停止增量应用并单飞拉取完整恢复快照。
6. 显式 `RVB_BATTLE_ASYNC_JOURNAL=1` 时，每房间 FIFO 内的内存 Room Actor 是在线权威提交点：
   规则、diff/hash、版本、receipt 与内存状态提交完成后立即生成 ACK/patch，不等待 Prisma/SQLite。
   ACK 前使用每房间缓存的分块状态哈希索引校验提交边界；完整内部/公开 Δ 回放由同一个串行 journal
   writer 在落库前审计一次，不能回到在线 ACK 热路径。
   Transition journal 只保存命令、receipt、内部/公开 Δ 与 hash 证据；一个有界后台 writer 按原顺序
   把这些记录写入现有原子数据库事务，避免多个后台写者自行制造 SQLite 写锁竞争。数组 Δ 对共同前缀
   逐项比较、对尾部逐项追加或逆序删除，不能因为 `actions` 增加一条就替换整段历史。
7. 持久化公开 `durableAuthorityVersion` 和 `durable | pending | degraded` 状态。SQLite 首次权威写前切换为
   WAL；每笔 Prisma 写仍设置 500 ms `busy_timeout`，interactive transaction 的 `maxWait=250 ms` 与
   `timeout=1250 ms` 均早于 journal 的 2 秒安全线。`SQLITE_BUSY/LOCKED`、Prisma 等待/事务超时和
   journal safety timeout 属于瞬时故障：当前 job 保留在队首，状态保持 pending 并携带 `lastError`，按
   `25/100/250 ms` 后以 250 ms 封顶退避，但每个 job 最多尝试 5 次且从首次失败起最多等待 10 秒；任一
   上限到达即只把该房间标为 degraded，丢弃其后续 durable job，writer 继续处理其他房间。同一 writer
   在旧 adapter 确认物理结束前绝不开始重试或下一房间，避免 `Promise.race` 制造重叠写；不响应取消的
   adapter 仍必须先物理结束。确定性审计/hash/版本错误、约束/损坏/I/O 等不可恢复错误和队列上限
   溢出同样立即进入 degraded 并拒绝该房间新动作。
   队列有每房间上限；房间删除前必须排空，排空失败必须拒绝删除并向调用方返回错误。终局尝试
   排空并记录失败。
8. 初始检查点仍同步建立，且与从 waiting/ready 切换到 in-progress 共同构成启动不变量：检查点失败时
   以 Room CAS 回滚到原房间；已经处于 version 0 的 in-progress 房间再次进入启动入口时，必须先补齐
   检查点并 hydrate 内存 actor，不能直接广播一个不可行动的半启动房间。固定间隔、换回合、终局与
   关闭检查点随 Transition 在后台生成和写入。
   重启恢复只承诺恢复到数据库中已持久化的权威水位：从最近检查点开始应用内部 Δ，逐条验证
   pre/post state/public hash、action hash、previous transition hash 和 transition hash。缺检查点、缺号、
   损坏或未到持久化目标版本必须显式失败，不能静默使用部分状态。SQLite WAL 只改善已进入 SQLite
   事务后的读写并发和崩溃恢复，不是应用层 durable ingress；候选阶段仍不承诺进程被强杀或断电前尚未
   durable 的内存动作零丢失。
9. 热状态只保留确定性随机游标、动作/回放序号和初始化事实；每步 Trace、命令和回放帧追加到
   Transition journal。终局在构造 Transition 前重新物化 ADR-0016 要求的完整 Trace v2，使在线 patch/hash、checkpoint 与重启恢复共享同一终局状态，不降低回放事实完整性。
10. 协议 v3 的内部状态和每个接收者公开状态使用确定性分块哈希：顶层字段组成根；顶层数组按固定
   32 项切块；根同时绑定算法版本、字段名、数组长度、chunk size 和各块 hash。普通动作根据 Δ 只重算
   受影响字段/块及根；数组尾部追加不随已有 `actions` 长度线性重哈希。完整重算仍在初始化/恢复、
   checkpoint、换回合、每 20 个权威版本和终局执行，并与增量根不一致时 fail closed。哈希固定向量
   必须在 Node、桌面 bundle 和 Android bundle 完全一致；算法或稳定序列化发生不兼容变化必须提升
   `protocolVersion` 或 `authorityBuildId`，禁止同链混写。
11. 规则 JSON 和动态代码在服务进程内缓存。普通开发/生产动作不再因为 `NODE_ENV=development`
   每次读取磁盘；内容工具通过显式失效函数刷新。`RVB_FORCE_RULE_RELOAD=1` 仅用于有意逐次重载，
   `RVB_BATTLE_DEBUG_LOGS=1` 才启用同步热路径调试日志。Node 服务端的 `hashStable()` 可以安装原生
   SHA-256 provider，以完全相同的稳定 JSON 字节和 digest 替代纯 JavaScript SHA；安装时必须先与
   纯 JavaScript 实现做固定向量自检，运行时返回非法 digest 必须 fail closed。浏览器和
   `sha256Hex()` 公共原语仍使用纯 JavaScript 实现；`RVB_BATTLE_NATIVE_SHA=0` 可显式关闭服务端 provider。
12. Relay 只瞬时转发 Transition 和精确回执，不把 recipient-specific patch 保存为房间最新完整状态；
    Relay 重连仍从权威服务获取完整恢复快照。
13. 客户端 patch 应用后复用既有按键增量展示层：地图仅在地图身份或尺寸变化时重建，棋子按 `piece.id`、
    地格效果按坐标签名、候选高亮按坐标集合增删；普通 Transition 不重建 Three.js 场景。
14. 候选功能 fail closed：只有同时显式 `RVB_BATTLE_AUTHORITY_V2=1` 与
    `RVB_BATTLE_ASYNC_JOURNAL=1` 才启用内存先确认；只开启 v2 仍走旧的数据库原子提交，作为快速回退。
    `RVB_BATTLE_AUTHORITY_V2` 是保留的历史功能开关名称，不表示传输仍是 v2。只有显式
    `RVB_TURN_TIMER_ENABLED=1` 才启用 deadline、安排部署/回合计时权威唤醒并显示计时投影。未设置或设置为 `0` 时，晚到玩家动作也不会结算 timeout。

15. 内存 ACK 前必须验证轻量但独立的提交不变量，不能只比较版本：缓存版本和链头等于 Transition
    前版本/前链，receipt 与命令/版本相连，action hash 与 transition hash 重算一致，持久化前态 hash
    与缓存一致，并且 Runner 独立产出的 canonical pre/post hash 与 trace 证据一致。任一不一致都在
    ACK 前 fail closed。完整内部/公开 Δ 回放、pre/post hash 复核和 `nextStorage` 等价比较由 journal
    writer 在 Prisma 写入前严格串行审计一次；审计失败将房间标为 degraded、丢弃该 durable job 并
    拒绝后续异步提交，绝不落库或静默继续。恢复、候选验证和 CI 仍执行完整回放审计。
16. 优雅关闭按固定顺序执行：先关闭 journal ingress，拒绝新的内存提交；再停止 WS 接入；随后排空
    全局 writer，并逐房间验证 `durableAuthorityVersion == authorityVersion`。Next 服务同时监听
    `SIGINT/SIGTERM` 和父 Electron 的 IPC 请求。Electron server/client 子进程使用 IPC 等待明确成功回执，
    总等待上限 6 秒，随后才允许进程退出；排空失败或超时必须记录“可能不耐久”并以失败回执/退出码
    暴露，不能伪装成成功。强制杀进程只保留为有界兜底。
17. 在线规则执行上下文归每个房间所有，并与该房间 FIFO 生命周期绑定。`room-rule-runtime.ts` 为每个
    roomId 只创建一个 `TriggerSystem`、规则/技能/动态代码缓存和不透明执行上下文；房间启动使用空的
    新运行时，已有房间首次恢复时只把历史全局规则快照复制一次，后续规则注册、限制计数、pending、
    缓存与异常均不得回读或写入其他房间。Runner、初始化、回合和技能深层调用必须在显式同步上下文中
    解析该房间实例；`globalTriggerSystem` 只保留给离线/浏览器兼容调用。重复 create/restore 返回同一实例；
    close 幂等地清空规则与缓存、关闭 ingress，并拒绝隐式复活。inspect 只聚合运行时和现有 FIFO 状态，
    不创建第二份可变真相，并映射到 RED-140 冻结的 `queue.running/pending/activeKind/closedReason`。

## 性能合同

- 固定种子 100-transition 服务端候选基准必须证明持久化载荷中位数相对旧完整 Room JSON 至少减少 80%。
- 后 10 次处理时长中位数不得超过前 10 次的 2 倍。
- 本机 LAN 候选构建端到端目标：P50 ≤ 50 ms、P95 ≤ 100 ms、P99 ≤ 150 ms；正常动作 < 250 ms。
- 阻塞后台数据库事务时，预热后的完整 `dispatch → receipt` P95 仍必须 < 100 ms；后台 durable 水位
  可以滞后，但不能阻塞同房间下一条规则命令。
- 100 条以上 `actions` 增加一条记录时，公开/内部 patch 只携带新增索引和值，载荷不得随既有日志总量
  线性增长；桌面与 Android 浏览器引擎必须从同一源码生成并支持该追加操作。
- 服务端基准不能代签端到端指标；人工验收必须使用 `window.__RVB_AUTHORITY_PERF__.summary()` 的
  精确回执样本，并分别覆盖部署、普通动作、回合开始目标与选项、计时器插队和断线恢复。

## 回退

1. 先删除 `RVB_BATTLE_ASYNC_JOURNAL` 或设为 `0`，即可保留 v3 协议并恢复 ACK 前数据库原子提交；
   再删除 `RVB_BATTLE_AUTHORITY_V2` 或设为 `0`，回退完整 Room CAS 与 `stateUpdate`。客户端协议信封仍可被入口解析，但不依赖增量 Transition。
2. 只回退房间规则隔离时应整体 revert RED-141；只回退异步权威扩展时应整体 revert RED-131；若连基础
   权威管线一并回退，则再整体 revert RED-109。
   两种情况都不得只撤销客户端 patch 或服务端 journal 其中一侧，服务端源码与桌面、Android 两个
   客户端 bundle 必须保持同一协议版本。
3. 迁移回退前必须先停止服务并确认不再有 v3 写入；保留/导出需要的 Trace 和对局证据，再删除新增
   Transition、Receipt、Checkpoint 表和 `battleAuthorityVersion` 列。不得在运行中直接降 schema。
4. RED-107 的 `start + pending` 计时器合法等待态修复不属于本 ADR 的回退范围。

## 验证

- 协调器：同房间 FIFO、跨房间并行、背压、失败后继续。
- 协议：精确回执、重复零写、旧版本 resync、patch 前后 hash、危险路径拒绝。
- 内存/耐久边界：阻塞或失败的 SQLite 不阻塞 applied receipt；durable 水位按序推进；数据库原生锁等待/
  事务期限早于 journal 安全线，瞬时失败保留并按序恢复，超时 adapter 未真正结束前不得启动下一写；
  版本 0 基准检查点、启动失败回滚、检查点/Transition 连续恢复与损坏拒绝。
- ACK/audit 边界：篡改版本、链头、action/transition hash 或 Runner pre/post 证据必须在 ACK 前拒绝；
  篡改但重新封装过的内部 Δ 必须在 journal 完整回放审计中 degraded，且不得进入 Prisma。
- Hash provider：Node 原生 provider 与纯 JavaScript 实现在固定向量、随机 Unicode 和真实状态上 digest
  完全相同；`RVB_BATTLE_NATIVE_SHA=0` 回退后协议、hash chain 与恢复结果不变。
- 分块 hash：覆盖嵌套修改、数组尾增/尾删、跨块修改、根替换、100/500/1000 条日志追加、运行时函数
  过滤、全量审计不一致诊断，以及 Node/桌面/Android 固定 Unicode 向量。
- 兼容：完整 v2 checkpoint + Transition 可恢复；v2/v3 混链、错误 build、旧 WS 订阅和动作在运行规则
  或写数据库前显式拒绝。
- 关闭/删除：关闭 ingress 后新提交失败；SIGTERM 与 Electron IPC 都按“停止接入→排空→逐房间水位核对”
  执行；排空失败的房间删除在 WS/HTTP 明确失败。
- 规则：部署、水门目标、观者选项、pending 超时、回合计时与机器人均走同一协调器。
- 房间运行时：两个不同阵容/规则/seed 的房间各执行 100 次交错 Transition，最终 hash、随机游标、
  pending 与规则限制必须分别等于各自单房串行结果；异常、缓存、close 和背压不得跨房间泄漏。
- 传输：LAN WS、HTTP 后备、Relay 瞬时转发、功能开关完整快照回退。
- 发布：类型、编码、全量测试、生产 `next build`、主线基线检查和双客户端人工 LAN 验收。
