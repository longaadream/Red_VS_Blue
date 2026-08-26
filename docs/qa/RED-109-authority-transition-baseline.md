# RED-109 权威迁移性能基线

## 旧链路基线

- `base_branch`: `main`
- `base_sha`: `a7c1d57da7b025fb69c9c24a3a04d3c5797d6132`
- 固定根种子：`0x52454431`（十进制 `1380271153`）
- 样本：同一房间、同一未锁定部署会话中的 100 个合法 `deploymentChoice` transition
- 运行命令：`npm.cmd test -- tests/game/battle-authority-performance.test.ts --reporter=verbose`
- 原始输出：`.tmp-red109/legacy-authority-benchmark.json`（测试时生成，汇总后删除，不提交）

旧实现的实际入口是 `dispatchRoomBattleAction()`：每条命令运行正式规则、把完整
`server-state` 重新序列化并执行房间 CAS，再为传输创建完整公开快照。测试中的内存
RoomStore 复现同一完整 JSON 序列化边界；它不包含真实 SQLite fsync、WebSocket 排队或
客户端渲染，因此是旧链路的保守下界，而不是产品端到端延迟。

| 指标 | P50 | P95 | P99 | 最大值 |
| --- | ---: | ---: | ---: | ---: |
| 正式规则 transition | 22.194 ms | 40.077 ms | 47.072 ms | 67.731 ms |
| 完整 dispatch（内存存储） | 58.922 ms | 102.072 ms | 120.144 ms | 132.590 ms |
| DB JSON 序列化 | 7.124 ms | 15.008 ms | 17.083 ms | 20.691 ms |
| 公开状态 hash | 0.489 ms | 1.199 ms | 2.307 ms | 2.613 ms |
| 广播 JSON 序列化 | 0.066 ms | 0.202 ms | 0.241 ms | 0.744 ms |

## 载荷与长度增长

- 第 1 次完整 DB 载荷：30,355 bytes。
- 第 100 次完整 DB 载荷：854,731 bytes，增长约 28.2 倍。
- 第 1 次公开快照：10,273 bytes。
- 第 100 次公开快照：10,281 bytes。
- 前 10 次完整 dispatch 中位数：20.989 ms。
- 后 10 次完整 dispatch 中位数：100.256 ms，约为前 10 次的 4.78 倍。
- 旧链路没有增量 diff 阶段；该阶段记为 `not-present-in-legacy-path`。

进行中公开投影会删除完整 Trace，因此快照体积在这个 fixture 中基本稳定；真正持续增长的
热路径是每步写回数据库的内部 `server-state`。其中 Trace v2 的历史帧与 Action Trace 都被
重复包含在后续完整房间 JSON 中。RED-109 的候选实现必须用 append-only transition/receipt
替代每步完整状态写回，并用有界检查点恢复；Trace v2 的终局事实仍须保留。

## 候选版本对照门槛

- 同一固定种子与 100-transition fixture。
- transition/receipt 的持久化载荷中位数相对旧 DB 载荷至少减少 80%。
- 后 10 次处理时长中位数不得超过前 10 次的 2 倍。
- 本机 LAN 双客户端端到端目标：P50 ≤ 50 ms、P95 ≤ 100 ms、P99 ≤ 150 ms；正常动作不得超过 250 ms。
- 上述端到端数字必须由候选构建真实客户端记录，不能用本服务端基准代签。
## 候选实现结果

同一固定种子、同一 100-transition fixture 在最终候选代码上运行：

| 指标 | P50 | P95 | P99 | 最大值 |
| --- | ---: | ---: | ---: | ---: |
| v2 完整 dispatch（内存 journal） | 13.509 ms | 16.889 ms | 18.039 ms | 22.890 ms |
| v2 持久化模拟 | 0.149 ms | 0.446 ms | 0.640 ms | 0.642 ms |
| v2 持久化载荷 | 10,290 B | 10,462 B | 32,175 B | 32,175 B |
| 接收者公开 patch | 288 B | 288 B | 292 B | 322 B |

- 相对旧完整 DB JSON 的 438,334 B 中位数，v2 持久化载荷中位数减少约 97.7%，超过 80% 门槛。
- 前 10 次与后 10 次 dispatch 中位数的倍率断言继续低于 2，没有随历史长度显著增长。
- 首条 v2 Transition 的载荷包含版本 0 迁移基准检查点；换回合、固定间隔和终局检查点解释了 P99 的 32,175 B，普通动作仍约 10 KB。
- 规则文件缓存与同步日志门控后的旧完整快照后备路径，在同一次最终运行中 dispatch 为 P50 41.998 ms、P95 64.961 ms、P99 69.074 ms；它是未设置或 `RVB_BATTLE_AUTHORITY_V2=0` 时的默认回退，不是候选正常链路。
- 混合架构回归 `battle-authority-async-dispatch.test.ts` 在 Prisma transaction 故意保持未完成时连续提交
  20 个完整部署动作；预热后的 `rules + diff/hash + memory commit + receipt` P95、墙钟 P95 和
  `persistenceMs` P95 都强制 < 100 ms，同时后台只启动第一笔数据库事务，证明同房 FIFO 不再等待写锁。
- `battle-authority-async-persistence.test.ts` 证明第一笔 DB 尚未 durable 时，同房内存版本可从 0 连续
  推进到 2，receipt/history/RoomStore 热读不访问 Prisma；排空后 durable 水位按 1、2 顺序追上。
- 候选构建必须同时显式设置 `RVB_BATTLE_AUTHORITY_V2=1` 与
  `RVB_BATTLE_ASYNC_JOURNAL=1`；只设置前者仍使用 ACK 前原子 Prisma 提交。计时器人工场景还须显式
  设置 `RVB_TURN_TIMER_ENABLED=1`。三个开关默认关闭，不能把回退链路误记为异步候选验收。
- `battle-authority-async-journal.test.ts` 直接断言 `enqueue()` 返回时 durable writer 尚未调用；writer 在
  下一事件循环才开始 Prisma 与序列化，确保 checkpoint JSON 不会偷跑进 ACK 当前调用栈。
  cooperative 写在 2 秒安全线 abort 后进入 degraded 并继续后续房间；不响应取消的 adapter 在真正结束前
  不会启动下一笔，防止 Promise timeout 制造物理并发。生产 Prisma 写另有更短的 SQLite 500 ms
  `busy_timeout`、250 ms `maxWait` 与 1250 ms transaction timeout。
- `battle-authority-async-sqlite.test.ts` 使用隔离的真实 SQLite schema 连续提交并排空 20 条 Δ，核对
  20 条 Transition、20 条 receipt 与 2 个有界 checkpoint；清空进程内 Room Actor 后，从数据库恢复到
  同一版本、state hash 与 transition hash 链头；另用第二个真实 Prisma client 持有 SQLite 写锁，验证
  A 房在原生期限内 degraded、B 房随后 durable，且不会因 safety timeout 与 A 的旧写重叠。
- `BattleAuthorityCheckpoint.seed` 只在 Prisma `Int` 边界使用有符号 32 位二进制编码；规则状态、
  `stateJson`、协议与随机运行时始终保留原始 uint32 seed。兼容迁移会把候选版本曾写入的
  `2147483648..4294967295` 规范化为相同 32 位比特的负数，恢复时再还原并与 `stateJson.seed`
  交叉校验，避免高位 seed 触发 Prisma P2023，且不改变对局随机结果。
- `battle-authority-async-persistence.test.ts` 在 ACK 前篡改链头、pre state/action hash 或 Δ 后的 post state
  均会 fail closed；不得让后台 Prisma CAS 代替内存提交不变量。
- `battle-authority-shutdown.test.ts` 验证 IPC 的“关闭 ingress→停止 WS→排空”顺序、失败回执、整体超时，
  并锁定两个 Electron 启动器都使用 IPC 后再进入 force-kill 兜底。
- `room-delete-transports.test.ts` 和 `ws-server.test.ts` 验证 journal 排空拒绝时，主 HTTP、管理员批量清理与 WS 都不会报告删除成功。
- `battle-authority-v2.test.ts` 验证初始检查点失败回滚，以及 version 0 in-progress 房间再次进入启动入口时
  必须补建检查点。
- 这些数字不包含真实 SQLite fsync、WebSocket、Electron 和 Three.js/DOM 应用。P95 ≤ 100 ms 的端到端目标仍必须由候选构建双客户端人工样本验收。
- 候选明确不承诺断电前 `battleAuthorityVersion - durableAuthorityVersion` 区间零丢失；优雅关闭、终局
  和房间删除应先排空日志，恢复只重放到数据库已持久化的版本与 hash 链头。
- 真实 Electron 人工验收还须覆盖：有 pending 动作时正常关闭/重启服务端，确认日志出现 durable drain
  成功且恢复版本等于关闭前版本；再用受控故障令 journal degraded，确认关闭明确失败而不是伪成功。

最终原始输出由测试写入 `.tmp-red109/legacy-authority-benchmark.json` 与
`.tmp-red109/candidate-authority-benchmark.json`；临时原始文件不提交，PR 保留本表与可重复测试。
