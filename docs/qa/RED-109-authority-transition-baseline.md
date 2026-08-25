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
| 正式规则 transition | 54.308 ms | 73.276 ms | 88.407 ms | 100.436 ms |
| 完整 dispatch（内存存储） | 71.976 ms | 106.730 ms | 114.293 ms | 123.776 ms |
| DB JSON 序列化 | 6.973 ms | 13.972 ms | 18.515 ms | 21.235 ms |
| 公开状态 hash | 0.589 ms | 1.229 ms | 1.560 ms | 2.205 ms |
| 广播 JSON 序列化 | 0.073 ms | 0.188 ms | 0.215 ms | 0.259 ms |

## 载荷与长度增长

- 第 1 次完整 DB 载荷：30,120 bytes。
- 第 100 次完整 DB 载荷：854,492 bytes，增长约 28.4 倍。
- 第 1 次公开快照：10,164 bytes。
- 第 100 次公开快照：10,170 bytes。
- 前 10 次完整 dispatch 中位数：55.095 ms。
- 后 10 次完整 dispatch 中位数：88.597 ms，约为前 10 次的 1.61 倍。
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
| v2 完整 dispatch（内存 journal） | 10.325 ms | 12.988 ms | 14.450 ms | 14.570 ms |
| v2 持久化模拟 | 0.163 ms | 0.454 ms | 0.658 ms | 0.782 ms |
| v2 持久化载荷 | 10,034 B | 10,206 B | 31,835 B | 31,835 B |
| 接收者公开 patch | 288 B | 288 B | 292 B | 322 B |

- 相对旧完整 DB JSON 的 438,235 B 中位数，v2 持久化载荷中位数减少约 97.7%，超过 80% 门槛。
- 前 10 次 dispatch 中位数为 10.526 ms，后 10 次为 10.390 ms，没有随历史长度增长。
- 首条 v2 Transition 的载荷包含版本 0 迁移基准检查点；换回合、固定间隔和终局检查点解释了 P99 的 31,835 B，普通动作仍约 10 KB。
- 规则文件缓存与同步日志门控后的旧完整快照后备路径，在同一次最终运行中 dispatch 为 P50 37.109 ms、P95 63.418 ms、P99 69.618 ms；它只作为 `RVB_BATTLE_AUTHORITY_V2=0` 回退，不是候选正常链路。
- 这些数字不包含真实 SQLite fsync、WebSocket、Electron 和 Three.js/DOM 应用。P95 ≤ 100 ms 的端到端目标仍必须由候选构建双客户端人工样本验收。

最终原始输出由测试写入 `.tmp-red109/legacy-authority-benchmark.json` 与
`.tmp-red109/candidate-authority-benchmark.json`；临时原始文件不提交，PR 保留本表与可重复测试。
