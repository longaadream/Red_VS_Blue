# RED-160 Colyseus + PostgreSQL 最小纵切验收记录

- 任务：RED-160
- 风险：High
- 基线：`origin/main@dc9bca46c06e2852621620180e8869a924e29bfa`
- 分支：`codex/red-160-colyseus-postgresql-vertical-slice`
- 状态：候选纵切代码已实现；真实 PostgreSQL 门与独立审查尚未完成，不满足合并/发布条件

## 实现边界

- 新入口：`npm run dev:colyseus`，旧 `dev` / `start` 和 Electron 默认入口保持不变。
- `BattleRoom` 只通过现有 `dispatchRoomBattleAction()` 公共命令端口执行规则；没有第二条 Room FIFO，
  没有读取 RED-139 EffectChain 内部 ledger。
- 完整 `BattleState` 只保存在 Room 内；Colyseus Schema 只同步 battleId、authority/durable version、
  state/transition hash、phase、turn 和 terminal 摘要。
- 普通动作在 journal 容量预留、规则完成和内存权威提交后直接发送 APPLIED；不等待 PostgreSQL、
  Schema patch 或默认 patch tick。
- PostgreSQL journal 每房间独立聚合，参数固定为 25 ms / 8 条；不同房间通过同一个连接池并行事务，
  不存在 SQLite 式全局单 writer。
- version 0 checkpoint 在 Room 可加入前同步持久化；terminal checkpoint、transition、receipt、
  watermark 和 terminal barrier 在同一 PostgreSQL 事务提交，终局 action 等待 DURABLE。
- 候选路径 `lib/server/colyseus/**`、`lib/server/postgres/**` 没有 Prisma、SQLite、
  legacy async journal 或同步 fallback import。

## 本机启动

先启动 PostgreSQL：

```powershell
docker compose -f docker-compose.colyseus.yml up -d postgres
$env:RVB_BATTLE_AUTHORITY_V2 = '1'
$env:RVB_POSTGRES_URL = 'postgresql://rvb:rvb@127.0.0.1:5433/rvb_colyseus'
npm run dev:colyseus
```

默认监听 `127.0.0.1:2567`，health 为 `GET /healthz`。可以用
`RVB_COLYSEUS_HOST`、`RVB_COLYSEUS_PORT` 和 `RVB_POSTGRES_POOL_MAX` 覆盖。

## 已执行验证

### 基线与静态检查

- `npm run check:main-baseline`：通过，ahead 0 / behind 0。
- `npm run typecheck`：通过。
- 聚焦 ESLint（Colyseus、PostgreSQL、对应测试、配置和启动脚本）：通过。
- `node --check scripts/run-colyseus-server.mjs`：通过。
- `git diff --check`：通过。
- 候选路径 SQLite/Prisma 静态检索：0 命中。
- `npm audit`：RED-160 新增的 Express/path-to-regexp High 已修复；剩余 1 个 High 是仓库既有
  `adm-zip@0.5.16`，不在本任务 allowed_paths/范围内；Critical 为 0。

仓库级检查的既有阻塞（未计作通过）：

- `npm run lint` 在扫描源码前即因 ESLint 配置引用了未注册的 `import/no-anonymous-default-export`
  规则失败；RED-160 聚焦 ESLint 已通过。本任务不允许修改仓库 ESLint 配置。
- 完整 `npm test` 结果为 156 个测试文件通过、1 个跳过、1 个失败；1553 个测试通过、1 个跳过。
  唯一失败是 `tests/game/battle-state-hash.test.ts` 缺少 Android 生成 bundle。执行
  `npm run build:game-engine` 后，该测试继续暴露既有 VM 环境 `TextEncoder is not defined`；
  生成文件已恢复/清理，本任务未修改 Android bundle 或该测试。

### 自动化行为

- `npm run test:colyseus`：3 files / 6 tests 全部通过。
- 权威/FIFO/运行时/恢复组合回归：
  8 files / 39 tests 全部通过。
- 覆盖：
  - 两个真实 `@colyseus/sdk@0.18.2` 客户端加入同一 BattleRoom；
  - health 和最小 Schema 初始同步；
  - PostgreSQL writer 永久阻塞期间连续 20 个真实规则动作仍收到 APPLIED；
  - 同一 `clientActionId` 再提交 10 次全部为 duplicate，规则只结算一次；
  - 8 条立即 flush、25 ms dwell、容量预留 fail closed；
  - 一个房间 PG 失败后 degraded，另一个房间继续 durable；
  - journal 预留失败恢复 TriggerSystem limits/cache，BattleState/authority version 不推进；
  - terminal action 在 writer barrier 释放前不返回，DURABLE 后才显示 finished。

独立双客户端阻塞 writer 样本（20 actions）：

| 度量 | P50 | P95 |
| --- | ---: | ---: |
| 服务端 queue → rules → memory commit → receipt | 15.809 ms | 22.711 ms |
| 本机 SDK send → receipt | 19.963 ms | 34.480 ms |

## 真实 PostgreSQL 门

`tests/integration/postgres/postgres-authority.integration.test.ts` 使用真实 `pg` 连接，验证：

- schema version、PK/unique、version 0 checkpoint；
- 20 条连续 Transition/receipt 与 8 条微批；
- checkpoint + replay 重启恢复和 state hash；
- duplicate 不重复写；
- terminal barrier、terminal checkpoint 和 durable watermark 同步到 version 21。

运行：

```powershell
$env:RVB_TEST_POSTGRES_URL = 'postgresql://rvb:rvb@127.0.0.1:5433/rvb_colyseus'
npm run test:postgres
```

当前 Codex 主机没有 Docker/Podman/本机 PostgreSQL。曾在临时目录成功完成 PostgreSQL 18
`initdb`，但官方 Windows PostgreSQL 拒绝在 Administrator 账户下启动 server；测试因此未执行，
临时集群和二进制已经删除。不得把无环境时的 skip 或这次启动失败记录为通过。

High 风险要求的独立 AI/人工代码审查也尚未执行；在真实 PostgreSQL 门和独立审查完成前，
该分支只能作为候选纵切或 Draft PR，不能合并、切换默认入口或发布。

## 回退

关闭 `dev:colyseus` 候选进程并回退本分支即可。旧 WebSocket、Prisma/SQLite 入口和原数据没有修改、
删除、双写或热切换；默认产品入口仍是 legacy runtime。
