# RED-159 Colyseus / PostgreSQL Phase 0 合同验收

- 状态：合同已对齐 RED-160/161，独立 High Risk 审查通过，等待 PR 合并
- 日期：2026-09-01
- 任务：[RED-159](https://linear.app/redvsblue/issue/RED-159/phase-0-合同-冻结-colyseuspostgresql-迁移边界耐久语义与双栈验收)
- 父路线：[RED-158](https://linear.app/redvsblue/issue/RED-158/路线-将权威联机迁移至-colyseus-postgresql并建立-k8swindows-双部署)
- 风险：High
- 分支：codex/red-159-colyseus-postgresql-contract
- base_branch：main
- base_sha：52632636d16dce0a912cab428dc563c59eb4f605
- 收尾同步 base_sha：a0d0ead93009553e32f3088622893443930fab7b
- 角色：实现者；人工体验验收、合并和发布不在本记录中

## 1. 范围证据

本任务只允许修改：

- docs/decisions/**
- docs/technical/**
- docs/qa/**

本任务不安装 Colyseus/PostgreSQL，不修改 package/lock、Prisma、lib、data、electron、部署脚本或玩家
协议，不删除 SQLite，也不更改玩法、数值、随机、Profile、Trace、经济或排名算法。

预期文档：

- [ADR-0025：Colyseus 房间权威与 PostgreSQL 有界异步耐久化](../decisions/ADR-0025-colyseus-postgresql-authority.md)
- [Colyseus / PostgreSQL 权威联机迁移合同](../technical/COLYSEUS_POSTGRESQL_MIGRATION.md)
- 本验收记录及三个目录索引。

RED-139 已占用 ADR-0022，RED-161 先合入 `main` 并占用 ADR-0023，RED-138 已占用 ADR-0024。
RED-159 因此在收尾同步中归档为 ADR-0025；这只是编号冲突消解，不改写已经批准且被 RED-160/161
采用的 D1–D5。

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
| 不复制规则到 Room/UI，不把 Schema/Redis 当真源 | ADR 第 2、5、6 节；独立审查 | 通过；无阻塞项 |

## 3. RED-160/161 落地对齐

本次收尾只把已经批准和已实现的事实回填到基础合同，不用后续 Issue 代签 RED-159，也不扩大生产范围：

- RED-160 已合入 `main`，实现 Colyseus BattleRoom、私有 BattleState、小型 Schema、每 Room
  PostgreSQL journal、25 ms / 8 条微批、APPLIED/DURABLE 双水位、version 0 与 terminal barrier；
- RED-139 已合入 `main`，实际保持 Room FIFO、动作内 EffectChain/Queue 与 durable queue 三层分离；
- RED-161 已合入 `main` 并完成默认 Electron/浏览器 Colyseus 主链、精确 receipt/重连、目标展示只读预检与
  LAN 房主内置原生 PostgreSQL 16，并记录真实 PostgreSQL integration、精确 Windows 单机冒烟；
- RED-161 的候选证据、人工批准和剩余风险归其自身合同与验收记录；RED-159 只确认它没有推翻
  D1–D5，不重复代签运行时验收；
- K8s/Redis 精确路由、SQLite exporter/importer、100 Room 和完整 Phase F 故障/容量验收尚未实现，
  但它们是后续实现任务，不是 RED-159 文档合同完成的前置条件。

## 4. RED-139 兼容验收

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

## 5. 文档阶段验证命令

任务合同要求且必须在提交 PR 前记录真实结果：

| 命令/检查 | 结果 | 说明 |
| --- | --- | --- |
| git fetch origin --prune | 已执行 | 2026-09-01；收尾基线见上 |
| npm.cmd run check:main-baseline | 通过 | `origin/main@a0d0ead`；Ahead 4，Behind 0 |
| npm.cmd run check:encoding | 通过 | 880 个文本文件 |
| git diff --check origin/main...HEAD | 通过 | 无空白错误 |
| Markdown 相对链接检查 | 通过 | 6 个改动 Markdown 的相对目标全部存在 |
| allowed_paths 审计 | 通过 | 6 个 PR 文件全部位于三个允许目录 |
| ADR 引用与脚本存在性检查 | 通过 | 16 个关键文件、2 个 npm script、1 个 RVB 环境变量存在；57 个 Linear 标识符均在 GAME team 中存在 |
| 独立 AI High Risk contract review | 通过 | 审查锚点 `origin/main@a0d0ead...9f19865`；无阻塞项，确认 D1–D5、RED-160/161 落地、ADR-0025、范围与后续门禁一致 |

本任务没有生产行为修改，因此不会把“未运行 runtime 测试”表述为 runtime 测试通过。package scripts
必须在执行前从当前 package.json 核对。

独立审查保留的非阻塞后续项：durable 客户端 outbox、K8s/Redis 精确路由、SQLite exporter/importer、
完整 fencing/恢复、100 Room 与 Phase F 故障矩阵仍须由后续任务实现和验收；本合同没有把它们误报为完成。

## 6. 后续候选验收总表

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

## 7. 预期独立审查重点

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

## 8. 回退

Phase 0 只新增/更新文档，可整体 revert RED-159 提交。不得因为回退文档而删除 SQLite、PostgreSQL、
Trace、对局或其他开发者文件。后续运行时回退必须停止 admission、排空/记录 durable watermark，
使用完整匹配的旧 release 与不可变 SQLite 备份；禁止活动 Room 和同一进程热切。
