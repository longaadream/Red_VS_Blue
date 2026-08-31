# RED-159 Colyseus / PostgreSQL Phase 0 合同验收

- 状态：合同实现与收尾同步完成，等待 PR
- 日期：2026-08-31
- 任务：[RED-159](https://linear.app/redvsblue/issue/RED-159/phase-0-合同-冻结-colyseuspostgresql-迁移边界耐久语义与双栈验收)
- 父路线：[RED-158](https://linear.app/redvsblue/issue/RED-158/路线-将权威联机迁移至-colyseus-postgresql并建立-k8swindows-双部署)
- 风险：High
- 分支：codex/red-159-colyseus-postgresql-contract
- base_branch：main
- base_sha：52632636d16dce0a912cab428dc563c59eb4f605
- 收尾同步 base_sha：dc9bca46c06e2852621620180e8869a924e29bfa
- 角色：实现者；人工体验验收、合并和发布不在本记录中

## 1. 范围证据

本任务只允许修改：

- docs/decisions/**
- docs/technical/**
- docs/qa/**

本任务不安装 Colyseus/PostgreSQL，不修改 package/lock、Prisma、lib、data、electron、部署脚本或玩家
协议，不删除 SQLite，也不更改玩法、数值、随机、Profile、Trace、经济或排名算法。

预期文档：

- [ADR-0023：Colyseus 房间权威与 PostgreSQL 有界异步耐久化](../decisions/ADR-0023-colyseus-postgresql-authority.md)
- [Colyseus / PostgreSQL 权威联机迁移合同](../technical/COLYSEUS_POSTGRESQL_MIGRATION.md)
- 本验收记录及三个目录索引。

RED-139 已占用 ADR-0022；本任务使用 ADR-0023，避免并发合同编号冲突。

## 2. 验收标准映射

| RED-159 验收项 | 证据 | 状态 |
| --- | --- | --- |
| ADR 冻结 D1–D5 与替代方案 | ADR 第 1–10 节及“备选方案” | 已覆盖 |
| 现状→目标模块保留/适配/重写/退役 | 技术合同第 2 节 | 已覆盖 |
| 命令、公开状态、持久化、恢复、终局、drain 时序 | 技术合同第 3、4、8 节 | 已覆盖 |
| PG schema 含 room/version、receipt、transition、checkpoint、terminal | 技术合同第 5 节 | 已覆盖，未创建 migration |
| 普通动作与 durable barrier 语义分离 | ADR 第 3–4 节；技术合同第 4、7 节 | 已覆盖 |
| K8s 精确路由、Redis、drain、崩溃恢复 | ADR 第 8–9 节；技术合同第 8、10 节 | 已覆盖 |
| SQLite 导出/导入/校验/回退 | ADR 第 7 节；技术合同第 9 节 | 已覆盖 |
| 30 个有效未完成 Issue 分类 | 技术合同第 11 节 | 已覆盖；不改状态 |
| B–F 有窄 scope/allowed_paths/tests/rollback/dependencies | 技术合同第 12–13 节 | 已覆盖 |
| 不复制规则到 Room/UI，不把 Schema/Redis 当真源 | ADR 第 2、5、6 节；独立审查 | 待独立审查 |

## 3. RED-139 兼容验收

以下是后续 BattleRoom 的硬门禁：

- Room FIFO 只串行外层 command；RED-139 Queue 只处理一次 runBattleAction invocation 内的四类效果；
- 一个外层 FIFO job 可以聚合多个内部 rule command，但只提交一次 authority version/Transition/receipt；
- 每次 runBattleAction 新建瞬态 EffectChain；BattleRoom 不创建、排空、恢复或序列化它；
- 合法 pending 回滚未完成效果，只保存根动作、答案序列和 RuleRuntime checkpoint，再从 root pre-state
  确定性重放；
- batch/queue/parent/depth 不进入 BattleState、Transition、Trace、Schema 或网络协议；
- 所有内部 invocation 成功、RED-139 lifecycle/follow-up 完成后才允许 APPLIED；
- 规则异常完整回滚，不能被 Colyseus handler 吞掉或投影成部分状态；
- B 任务只依赖 RED-139 合并后的公开 runBattleAction/BattleActionResult，不 import 并行分支内部 handler。
- Batch Commit、外层 APPLIED/Transition Commit、PostgreSQL DURABLE Commit 是三个不同水位；
- dispatchRoomBattleAction 已使用 room-authority-queue 时，BattleRoom 不再套第二个 FIFO；
- runBattleAction/withEffectChain 同步作用域禁止 await、I/O、消息发送或 journal enqueue。
- 外层 attempt 在首个 invocation 前快照 per-room RuleRuntime/TriggerSystem；第二个 invocation、
  hash、journal reserve、stale commit 或 swap 失败必须与 BattleState 一起恢复。
- runner 非 pending 成功返回前必须证明 EffectChain settled/unloaded；BattleRoom 不补查内部 ledger。

## 4. 文档阶段验证命令

任务合同要求且必须在提交 PR 前记录真实结果：

| 命令/检查 | 结果 | 说明 |
| --- | --- | --- |
| git fetch origin --prune | 已执行 | 2026-08-31；合同基线见上 |
| npm.cmd run check:main-baseline | 通过 | origin/main dc9bca4；Ahead 1，Behind 0 |
| npm.cmd run check:encoding | 通过 | 同步后 821 个文本文件 |
| git diff --check | 通过 | 暂存 diff 无空白错误 |
| Markdown 相对链接检查 | 通过 | 6 个改动文档的相对目标均存在 |
| allowed_paths 审计 | 通过 | 6 个文件全部位于 docs/decisions、technical、qa |
| 独立 AI High Risk contract review | 通过（整改后） | RED-139 兼容审查发现 5 个阻断项并已全部修正；K8s、耐久和 Issue 矩阵分别独立审计 |

本任务没有生产行为修改，因此不会把“未运行 runtime 测试”表述为 runtime 测试通过。package scripts
必须在执行前从当前 package.json 核对。

## 5. 后续候选验收总表

Phase B–F 必须逐项形成自动化或可重复人工证据：

1. legacy/BattleRoom 固定 seed/Profile/命令差分 state/hash/Trace；
2. RED-139 多 invocation、pending 重放、Queue 异常回滚与 Room 隔离；特别覆盖第一 invocation 成功、
   第二 invocation/提交前步骤失败时 TriggerSystem 无残留；
3. APPLIED P50/P95/P99 与 DB 阻塞解耦；
4. 25ms/8 条微批、队列上限、公平、重试、watermark 无缺口；
5. terminal/reward/rank/delete/backup/shutdown durable barrier；
6. PostgreSQL restart、response loss、坏 hash/checkpoint、epoch split-brain；
7. owner/对手/观者隐藏信息隔离，Schema patch 不代替 receipt；
8. outbox、普通 reconnect、Pod 死亡后的重新 matchmaking/resync；
9. Redis/PG/route/SIGTERM/SIGKILL/Pod IP/HPA/Windows stop 故障注入；
10. SQLite→PG 行数、键、hash chain、Trace、fixed-seed 回放校验；
11. Windows 与 K8s 双客户端候选和不可变 artifact/rollback；
12. 人工批准后才切默认、删除 legacy runtime、合并或发布。

## 6. 预期独立审查重点

- 是否把 Colyseus 当成自动串行、自动持久化或跨进程 Room 恢复；
- 是否在 receipt 前遗漏 RED-139 EffectChain 完整收敛；
- 是否错误序列化半个 Effect Queue 或新增 batch 级网络/Trace schema；
- PostgreSQL watermark 是否可能先于完整连续 records；
- schema 是否制造全局热点或重复终局；
- Schema/StateView 是否泄露隐藏信息；
- Redis/Ingress 是否被误作 authority；
- SQLite 是否通过 dev default、fallback 或 exporter import 回到 runtime；
- 故障恢复是否错误声称普通 APPLIED 的 RPO=0；
- 整版回退是否覆盖了 cutover 后数据损失和外部 settlement。

## 7. 回退

Phase 0 只新增/更新文档，可整体 revert RED-159 提交。不得因为回退文档而删除 SQLite、PostgreSQL、
Trace、对局或其他开发者文件。后续运行时回退必须停止 admission、排空/记录 durable watermark，
使用完整匹配的旧 release 与不可变 SQLite 备份；禁止活动 Room 和同一进程热切。
