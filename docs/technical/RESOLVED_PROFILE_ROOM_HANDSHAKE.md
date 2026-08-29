# Resolved Profile 房间握手与对局固定

状态：RED-116 implementation contract

基线：`main@59258423e4d4d1c8023caa124904276c878d2ebb`

上游合同：[Content Profile v1 运行时](./CONTENT_PROFILE_V1_RUNTIME.md)、
[Content Pipeline v1](./CONTENT_PIPELINE_V1_CONTRACT.md)、
[ADR-0018](../decisions/ADR-0018-content-pipeline-v1.md)

## 1. 身份与兼容门禁

房间与权威对局使用 `rvb-game-profile-identity/v1`：

- `engineAbi`
- `runnerRevision`
- `resolvedProfileHash`
- `authorityContentHash`

硬门禁只比较 `engineAbi + runnerRevision + authorityContentHash`。其中
`resolvedProfileHash` 是完整安装、来源与诊断信息，必须公开并写入存档、Trace 与 Replay；如果差异只来自
raster 或 provenance，而权威内容和执行器仍一致，则不阻止 join、ready、start、恢复或 Replay。

Server expected identity 只能来自活动 runtime immutable binding。客户端或房主不能指定 Server 使用哪个
Profile，也不能用 warning、确认框或 `packMd5` 绕过。

## 2. 房间入口与失败顺序

HTTP 房间列表/详情、WebSocket `catalog.identity`、`rooms.list` 与 `rooms.get` 都公开同一
Server identity。真人在 join、claim-faction、toggle-ready、select-pieces、显式 start 与自动 start
路径提交本地 stable identity。

校验必须发生在 player、ready、roster、Room version、BattleState 或 checkpoint 变化之前。失败使用
HTTP 409；WebSocket 使用相同 code、status 与公共 context：

- `PROFILE_REQUIRED`
- `PROFILE_INVALID`
- `ENGINE_ABI_MISMATCH`
- `RUNNER_REVISION_MISMATCH`
- `PROFILE_HASH_MISMATCH`
- `PINNED_PROFILE_UNAVAILABLE`

context 只包含 expected/actual 公共 identity，不包含 Profile 路径、签名材料、密钥或进程 token。

通过 join 的 Player 保存已确认 identity；Bot 总是继承 Server identity。Spectator 必须先通过
`rooms.spectate` 的同一守卫并保存 identity，之后才允许订阅 battle snapshot。离开房间是唯一不因
identity 缺失而阻塞的 best-effort 房间动作。

## 3. 对局存储、Trace 与 Replay

`ServerBattleState` 使用严格 envelope：

```ts
{
  type: 'server-state'
  storageSchemaVersion: 'rvb-server-battle-state/v1'
  profileIdentity: GameProfileIdentityV1
  rootSeed: number
  state: BattleState
}
```

BattleState 内另有 `rvb-battle-profile-pin/v1`，必须与 envelope 的 identity/rootSeed 精确相同。
初始化 Trace、后续 Trace、authority runtime header 与 Replay header 都固定同一 identity/rootSeed。

序列化、checkpoint、恢复和动作执行在 Runner 前依次验证：

1. envelope schema、精确字段集合与 root seed；
2. pinned Profile 在当前 authority runtime 可用；
3. state pin 与 envelope 精确一致；
4. Trace 和 Replay header 与 state pin 精确一致。

任何缺失或篡改都返回 `PINNED_PROFILE_UNAVAILABLE`。旧 `{ seed, state }`、无 pin 的 state 或
legacy Replay 不推断为当前 Profile，也不自动迁移。

## 4. Profile lease

只要 waiting/ready 房间仍有真人或 Bot 占位，就持有 Profile lease；in-progress 房间始终持有 lease。
玩家全部离开且房间没有占位后释放。这样可避免玩家在旧 Profile 下进入房间、准备期间 Server 又切到
新 Profile。finished 房间不持有活动 authority lease。

## 5. 验证与回退

自动验证至少覆盖：HTTP/WS 错误矩阵与拒绝无污染、Bot/Spectator、最终开局守卫、envelope round-trip、
wrong/missing/tampered pin、legacy 拒绝、固定 seed Trace/Replay 与 waiting/ready lease。

Windows candidate 验证：

1. A/A 客户端进入房间、准备、选人并开始最小对局；
2. B 客户端在 engine、runner 或 authority hash 任一不同时停留在 Lobby；
3. spectator 使用错误 Profile 无法订阅 battle；
4. 导出存档与 Trace，确认 schema、identity 与 rootSeed 一致；
5. 同 Profile 恢复成功，缺少 pinned authority 内容时在 Runner 前失败。

代码回退优先整体 revert RED-116 PR。回退前停止创建新对局并持久化活动对局；已经生成的 v1 pinned
存档、checkpoint 与 Replay 必须隔离保留，旧代码不得猜测、重写或删除这些内容。
