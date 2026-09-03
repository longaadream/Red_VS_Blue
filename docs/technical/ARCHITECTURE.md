# Red VS Blue 当前架构

更新：2026-09-03（RED-158 Phase F 主线同步）

## 1. 结论

Windows 玩家产品只有 Electron Client。它承载静态页面与 Profile HTTP 服务，并在启动时准备应用私有的
PostgreSQL 实例和 Colyseus authority；本机训练、PVE 与 Host & Play 复用这套进程。选择远端服务器时，
玩家对局只连接所选 authority origin，本机预热的 authority 不接管或镜像远端对局。

Windows 联机和战报没有第二套实现：

- Colyseus MatchMaker/BattleRoom 负责目录、建房、加入、选将、战斗命令、重连与公开状态。
- PostgreSQL 负责 Checkpoint、Transition、Receipt、Trace、Replay Frame 和 Terminal Barrier。
- `dispatchRoomBattleAction()` 与 Battle Runner 负责确定性规则、版本和 hash。
- 静态页面通过 `data/pages/js/colyseus-client.js` 使用 Colyseus SDK。
- 战报通过 authority origin 的只读 HTTP API 返回，且必须先完成 journal 验证。

Android 与独立 Relay 属于其他交付边界，不能作为 Windows 的运行回退。

## 2. 运行拓扑

```text
Electron Client
├─ Profile HTTP process
├─ packaged static pages
├─ embedded PostgreSQL
└─ Colyseus authority
   ├─ HTTP: health, room catalog, battle reports
   └─ BattleRoom: admission, commands, state, reconnect
```

客户端只持有一个规范化 authority origin。LAN 发现、手工地址和邀请加入都先验证同源
`GET /healthz` 的 `rvb-colyseus` 协议标识。

## 3. 模块边界

| 层 | 主要模块 | 职责 |
| --- | --- | --- |
| 规则层 | `lib/game/turn.ts`、`battle-runner.ts`、`skills.ts`、`triggers.ts` | 确定性规则、seed、动作与状态 hash |
| 房间协调层 | `room-battle-actions.ts`、`room-authority-queue.ts`、`room-rule-runtime.ts` | 单房 FIFO、运行时隔离、版本和 receipt |
| 联机层 | `lib/server/colyseus/**` | BattleRoom、准入、目录、状态投影、HTTP 只读资源 |
| 持久化层 | `lib/server/postgres/**` | PostgreSQL schema、事务 journal、恢复和战报验证 |
| 表现层 | `data/pages/**` | 收集意图、发送命令、渲染公开投影；不执行在线权威规则 |
| 桌面层 | `electron-client/**` | 窗口、安全协议、子进程、嵌入式 PostgreSQL 生命周期 |
| 内容层 | `data/**`、`lib/content-pipeline/**` | Profile、规则数据、签名内容和资源包 |

## 4. 命令与状态流

```text
player intent
  → Colyseus BattleRoom admission
  → per-room FIFO
  → deterministic Battle Runner
  → next state + receipt + transition + trace/hash evidence
  ├→ Colyseus APPLIED receipt and viewer-specific public state
  └→ bounded PostgreSQL journal → durable watermark
```

命令必须带 `clientActionId` 和期望 authority version。重复 ID 幂等返回；旧版本要求恢复；超前版本、
错误协议/build/Profile、未入座玩家或非法规则动作均失败关闭。失败不得推进版本或随机 cursor。

页面切换时，`RvBColyseus` 使用 sessionStorage 中的 Colyseus reconnection token 恢复原 session，不再次
`joinById` 占座。瞬时掉线通过原 Room 的 native reconnection 恢复；直接 receipt 丢失时按原
`clientActionId` 查询精确结果。所有等待均有界，失败后解除本地 pending 并显示稳定错误。

## 5. 耐久与恢复

对局从 version-zero Checkpoint 开始。普通 APPLIED 不等待 PostgreSQL；客户端通过
`authorityVersion - durableAuthorityVersion` 观察尚未耐久的尾部。PostgreSQL 保存连续版本前缀，周期性与终局 Checkpoint，终局 Trace
和 Terminal Barrier。恢复时验证协议/build、版本、action/state/public/transition hash 链、receipt 关联及
Checkpoint 重放一致性。存在缺口或篡改时房间不可恢复，战报也不可读取。

Windows 本机 authority 启动将 PostgreSQL 的瞬时连接超时、恢复中和资源压力视为可重试状态；认证、配置、
schema 或完整性错误仍立即失败。Electron 的就绪 watchdog 必须覆盖数据库连接重试窗口，不得用短于正常资源
加载时间的恢复窗口杀死仍在启动的 authority 进程。

## 6. 战报

`PostgresAuthorityRepository.readBattleReport()` 从初始 Checkpoint 重放完整 Transition，并核对终局 Trace、
Replay Frame 和 Terminal Barrier。只有 online version 与 durable version 相等、终局完整且所有 hash 验证通过
时才返回报告。页面不保存或生成另一份权威战报。

## 7. 安全与隐私

- Electron renderer 不暴露 Node、文件系统、进程或任意 IPC。
- PostgreSQL 只绑定 loopback，使用 SCRAM 凭据和应用私有数据目录。
- 连接 URL 在日志与错误中移除用户名、密码、query 和 fragment。
- Profile/content hash 用于准入一致性；Trace hash 用于完整性，不等于内容加密。
- 在线公开状态按 viewer 投影，私有部署候选和 pending 选择不得广播给对手或观战者。

## 8. 验证

- `npm.cmd run check:windows-cutover`
- `npm.cmd run typecheck`
- `npm.cmd run test:colyseus`
- `npm.cmd run test:postgres`（需要 `RVB_TEST_POSTGRES_URL`）
- `npm.cmd run build:electron:client`
- `node tests/electron/windows-smoke.mjs client`

具体接口见 [MODULE_INTERFACES.md](./MODULE_INTERFACES.md)，本次验收记录见
[RED-158 Windows cutover](../qa/RED-158-colyseus-postgresql-windows-cutover.md)。
