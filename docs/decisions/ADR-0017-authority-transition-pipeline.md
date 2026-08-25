# ADR-0017：低延迟服务端权威 Transition 管线

- 状态：Proposed（等待 RED-109 候选构建与人工 LAN 验收）
- 日期：2026-08-25
- 任务：RED-109
- 风险：High
- 基线：`main@a7c1d57da7b025fb69c9c24a3a04d3c5797d6132`

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
2. 联网命令使用协议 v2 信封：`roomId`、精确 `clientActionId`、`playerId`、
   `expectedAuthorityVersion`、可选选择会话凭证和命令体。服务端返回与该 ID 对应的
   `applied | duplicate | rejected | resyncRequired` 回执。
3. `Room.version` 只保护大厅和房间元数据写入；`battleAuthorityVersion` 只由成功的权威战斗
   Transition 推进。重连、身份资料或房间元数据写入不得制造战斗版本空洞，也不得覆盖较新的战斗版本。
4. 服务端执行正式规则并生成完整合法候选。客户端只显示权威 `pendingOptionSelection` /
   `pendingTargetSelection` 中的候选并提交选择；候选只投影给 pending owner，对手和观者只接收等待会话的公开信封。联网路径不执行规则 dry-run。训练模式仍可在本地运行引擎。
5. 普通成功命令生成连续的 `fromVersion → toVersion` Transition、内部状态 patch、按接收者重新
   投影的公开 patch、前后 hash、精确 action hash 与连续 transition hash 链，并返回精确回执。客户端仅在前版本和前 hash 都匹配时应用 patch；任何
   断层或 hash 不一致都停止增量应用并单飞拉取完整恢复快照。
6. Transition、回执、可选检查点和 `battleAuthorityVersion + 1` 在一个数据库事务中提交。普通动作
   不再重写完整战斗 JSON；初始、固定间隔、换回合、终局和关闭边界保留检查点。版本 0 的第一条
   Transition 会原子补建基准检查点，支持迁移时已经进行中的对局。
7. 重启恢复从不晚于目标版本的最近检查点开始，先验证检查点的 state/public/transition hash，再按版本顺序应用内部 patch 并
   逐条验证 pre/post state/public hash、action hash、previous transition hash 和 transition hash。缺检查点、缺号、损坏或未到目标版本必须显式失败，不能静默使用部分状态。
8. 热状态只保留确定性随机游标、动作/回放序号和初始化事实；每步 Trace、命令和回放帧追加到
   Transition journal。终局检查点重新物化 ADR-0016 要求的完整 Trace v2，不降低回放事实完整性。
9. 规则 JSON 和动态代码在服务进程内缓存。普通开发/生产动作不再因为 `NODE_ENV=development`
   每次读取磁盘；内容工具通过显式失效函数刷新。`RVB_FORCE_RULE_RELOAD=1` 仅用于有意逐次重载，
   `RVB_BATTLE_DEBUG_LOGS=1` 才启用同步热路径调试日志。
10. Relay 只瞬时转发 Transition 和精确回执，不把 recipient-specific patch 保存为房间最新完整状态；
    Relay 重连仍从权威服务获取完整恢复快照。
11. 客户端 patch 应用后复用既有按键增量展示层：地图仅在地图身份或尺寸变化时重建，棋子按 `piece.id`、
    地格效果按坐标签名、候选高亮按坐标集合增删；普通 Transition 不重建 Three.js 场景。
12. 候选功能 fail closed：只有显式 `RVB_BATTLE_AUTHORITY_V2=1` 才启用 v2 Transition；只有显式
    `RVB_TURN_TIMER_ENABLED=1` 才安排部署/回合计时权威唤醒。未设置或设置为 `0` 时分别使用旧完整快照链路和无计时器模式。

## 性能合同

- 固定种子 100-transition 服务端候选基准必须证明持久化载荷中位数相对旧完整 Room JSON 至少减少 80%。
- 后 10 次处理时长中位数不得超过前 10 次的 2 倍。
- 本机 LAN 候选构建端到端目标：P50 ≤ 50 ms、P95 ≤ 100 ms、P99 ≤ 150 ms；正常动作 < 250 ms。
- 服务端基准不能代签端到端指标；人工验收必须使用 `window.__RVB_AUTHORITY_PERF__.summary()` 的
  精确回执样本，并分别覆盖部署、普通动作、回合开始目标与选项、计时器插队和断线恢复。

## 回退

1. 候选默认使用旧完整 Room CAS 与完整 `stateUpdate` 广播；仅显式设置 `RVB_BATTLE_AUTHORITY_V2=1` 才启用 v2，删除变量或设置为 `0` 即回退；
   客户端协议信封仍可被入口解析，但不依赖增量 Transition。
2. 完整代码回退应整体 revert RED-109，不得只撤销客户端 patch 或服务端 journal 其中一侧。
3. 迁移回退前必须先停止服务并确认不再有 v2 写入；保留/导出需要的 Trace 和对局证据，再删除新增
   Transition、Receipt、Checkpoint 表和 `battleAuthorityVersion` 列。不得在运行中直接降 schema。
4. RED-107 的 `start + pending` 计时器合法等待态修复不属于本 ADR 的回退范围。

## 验证

- 协调器：同房间 FIFO、跨房间并行、背压、失败后继续。
- 协议：精确回执、重复零写、旧版本 resync、patch 前后 hash、危险路径拒绝。
- 原子性：提交失败不暴露 applied；版本 0 基准检查点、检查点/Transition 连续恢复与损坏拒绝。
- 规则：部署、水门目标、观者选项、pending 超时、回合计时与机器人均走同一协调器。
- 传输：LAN WS、HTTP 后备、Relay 瞬时转发、功能开关完整快照回退。
- 发布：类型、编码、全量测试、生产 `next build`、主线基线检查和双客户端人工 LAN 验收。
