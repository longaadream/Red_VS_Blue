# PVE Flow v1

## 1. 权威边界

RED-117 的 PVE 由服务端声明式 Flow Runner、Run Store 和正式 Battle Adapter 组成。浏览器只提交当前公开视图列出的命令，不读取 `data/pve/**`，不计算条件、奖励、随机数或终局。

`PveRunV1` 只固定：

- `authorityContentHash`
- `campaignId`
- `rootSeed`
- 当前 Flow 状态、checkpoint 与 receipts

Run 不保存 `resolvedProfileHash`、campaign package hash 或 Profile 路径。每次创建、读取和执行命令前，服务都通过 `openRuntimeVerifiedSnapshotV1()` 重新打开 active Profile 的已验证 `ResolvedSnapshotViewV1`，然后要求其 `authorityContentHash` 与 Run 完全一致。不同 authority 下旧 Run 不允许继续；同 authority 的 Profile 切换保留 Run。

正式 BattleState 仍使用现有 `GameProfileIdentityV1` 固定 active Profile 身份。这是 Battle Runner 的恢复/trace 边界，不是新增到 PVE Run 的第二套固定字段。

## 2. Content 与注册表

`createPveContentSnapshotV1()` 只接受 verified Snapshot view。它严格解析 `rvb-pve-*/v1` 文档并验证：

- content manifest 登记与文件 kind、ID、path 一致；
- Campaign 节点完整、可达且没有 orphan；
- 节点跳转、chapter、encounter、enemy、event outcome、reward 和 relic 引用闭合；
- map、objective、roster、AI、effect、reward table 和 condition 必须存在于密封 runtime registry。

Prototype registry 是代码拥有的封闭集合。玩家与敌方 roster 分别从 active Profile 的 Demo manifest 解析 light/dark 各 8 个棋子；缺少、重复或阵营错误时 fail closed。当前登记 ID 只服务于 Prototype，不是通用 mod ABI。

## 3. Flow Runner

Runner 消费全部八类节点：

- `roster`
- `story`
- `event`
- `battle`
- `reward`
- `branch`
- `checkpoint`
- `end`

`branch` 和 `checkpoint` 是自动节点，单次稳定化最多 32 步；超限或任何 effect/condition/schema 错误都不会修改调用方 Run。其余节点只接受对应的 strict versioned command。

event、reward 和 battle settlement 写入有序 receipt。receipt 的 `commandId` 唯一，且自身严格从 `fromRevision` 推进到 `fromRevision + 1`。一次外部命令可以继续经过自动节点，因此 Run Store CAS 允许最终 revision 大于当前 revision，但必须以当前 revision 为比较基线。

客户端 battle command 递归拒绝 `winner`、`winnerPlayerId`、`result` 和 `terminalResult`。`battle-started`、`battle-updated` 与 `battle-settle` 仅供服务端 adapter 编排，API 不解析客户端为这些类型。

## 4. Battle Adapter

Prototype battle 使用 active Profile 登记的 8×8 roster、`large-hole-arena` 和固定 Run seed 派生的 battle seed。Adapter 调用现有 `createInitialBattleForPlayers()`，启用 deterministic deployment，并让两方通过正式 `deploymentLock` 动作锁定。

登记 roster 在 game-start 产生 mandatory option 时，Adapter 只在初始化阶段通过正式 pending protocol 选择第一个登记选项；mandatory target 不猜测并直接 fail closed。初始化完成后所有动作只经 `runBattleAction()`。

每个 client battle action 强制使用 PVE `commandId` 作为 formal `clientActionId`。重试先查询 Battle trace 的 applied action IDs，不重放规则或随机流。非终局动作通过 authority-only `battle-updated` 同步 `activeBattle.stateHash`；终局动作随后调用 `settlePveBattleV1()`，该函数只读取正式 `BattleState.terminalResult` 并映射 victory、defeat 或 draw。

## 5. 持久化与 Profile 生命周期

Run aggregate schema 为 `rvb-pve-run-aggregate/v1`，包含 strict Run 与可选 formal server BattleState。Memory Store 与 JSON Store 提供 create、read、list 和 revision CAS；JSON 写入使用同目录临时文件和原子替换。

每次读取或执行命令时，Runner 都会重新计算 checkpoint 的完整性：`receiptsHash` 必须覆盖 `receiptCount` 指定的精确 receipt 前缀，`stateHash` 必须匹配 checkpoint 自身状态投影以及 Run 的固定 Campaign/root seed。任一不匹配都在 effect、revision、receipt 或 Store mutation 之前 fail closed。

JSON 恢复使用 duplicate-key-safe strict parser；重复键、schema 偏差或损坏的 aggregate/tombstone/evidence 一律拒绝。恢复语义是重新加载并验证完整 aggregate，把 checkpoint 作为完整性锚点后按 `commandId` 幂等重试，而不是从 checkpoint 构造另一份隐式回滚存档。

Profile admission 关闭期间：

- 同 `authorityContentHash`：保留 Run、checkpoint 和 active battle；
- 不同 `authorityContentHash`：先归档完整 aggregate（包括 battle trace），再写最小 tombstone，最后清理 active Run；
- active PVE battle 与 room battle 一起计入 Profile lease；authority restart 在 lease 存在时拒绝；
- commit、release 和 startup recovery 都在重新开放 admission 前执行幂等 reconciliation；失败时保留 admission fence。

## 6. API 与 Prototype 页面

- `GET /api/pve`：active verified Snapshot 的 Campaign catalog。
- `POST /api/pve/runs`：只接受 `{ campaignId }`，服务端生成 Run ID 与 root seed。
- `GET /api/pve/runs/{runId}`：恢复公开 Run view。
- `POST /api/pve/runs/{runId}/commands`：执行 strict client command。

公开视图只包含 Run ID、Campaign、authority hash、revision、公开 node、battle descriptor 和 legal commands。Prototype 页面以 `?runId=` 恢复，只在 localStorage 保存 `rvb_pve_last_run_id`。旧 `rvb_pve_run` 只显示不兼容提示，不读取、迁移或删除。

固定 Prototype 主路径为：

`choose-roster → intro → campfire → ambush → spoils → safe-room → victory-ending`

战斗 defeat/draw 分别进入 `defeat-ending` 与 `draw-ending`。页面上的胜负演示按钮提交正式 surrender BattleAction；它们不提交终局对象。

## 7. 调试证据与回退

关键证据包括 authority hash、Run revision、command/transition hash、receipt、checkpoint hash、battle seed/state/action hash、formal terminal result 和归档 tombstone。相同 Snapshot、Run seed 与命令序列必须产生相同结果。

回退时可恢复 RED-117 之前的 PVE 页面/fixtures 并移除 `lib/pve` service/runner/store/adapter 与 `/api/pve/runs/**`。Profile pointer schema、PVE Run v1 schema、Battle Runner、随机算法和存档迁移均不需要回退或修改；已创建的 v1 临时 Run 可由 authority reconciliation 清理，审计 evidence 保留。
