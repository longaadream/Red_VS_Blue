# 自治服务器运行、管理与发行身份 v1 合同

- 状态：RED-140 Phase 0 已批准规范；不表示运行时已经实现
- 风险：High
- 日期：2026-08-31
- 设计基线：`main@f51a5eed2a37be6491841a19393b0725ad188554`
- 收尾同步基线：`main@6e6ae8dd88928dc285c0cbb7a5be7e3c121ae9a2`
- 规范：`rvb-server-operations/v1`、`rvb-release-identity/v1`
- 决策权威：[ADR-0021](../decisions/ADR-0021-autonomous-server-operations.md)

ADR-0021 取代 ADR-0003 的公开发行边界；ADR-0003 只保留历史内部 QA 候选记录。

## 1. 范围与非声明

本文冻结自治 Server v1 的运行状态、命令、管理传输、RoomRuntime 观察、备份恢复、应用更新与
发行身份，供后续 Dashboard、Supervisor、备份、更新和本服竞技实现共同消费。

本文只定义合同，不实现，也不能作为下列能力已经存在或通过候选验证的证据：管理 UI、Supervisor、
管理 listener、备份器、排名、下载器、安装器、迁移器、远程管理、Windows Service、开机自启、
静默更新、新玩家协议、新规则、DB migration、公开发行或旧数据兼容。

现有 `build:electron:server` / `win-unpacked` 仍是内部 QA 候选。只有满足 ADR-0021 与本文的
签名、安装、兼容、恢复和候选证据，并另获人工发布批准，才能成为公开发行物。

v1 支持 Windows 10 22H2 x64（build 19045）与 Windows 11 x64。Windows 10 22H2 已结束
[微软常规支持](https://learn.microsoft.com/windows/release-health/release-information)；本合同承诺
应用兼容验证，不延长 OS 安全支持。macOS、Linux、x86、ARM64、容器和 Windows Server 不在 v1。

## 2. 权威与精确复用

| 组件 | 唯一职责 | 明确禁止 |
| --- | --- | --- |
| Electron main / Supervisor | OS 文件、进程、端口、固定路径、operation ledger、备份、应用更新、全局生命周期、受信 IPC | 复制游戏规则、把 capability 暴露给 renderer |
| Next child adapter | room/PVE admission 与 accepted-ingress drain、Profile adapter、PVE authority reconciliation、RoomRuntime inspect/cleanup、健康报告 | 启停宿主、替换 binary、访问任意路径 |
| Room authority / persistence | 房间命令、FIFO、authority version、transition/checkpoint、SQLite journal/restore | 全局生命周期或发行更新 |
| PVE Run Store / authority reconciliation | RED-117 strict Run aggregate、revision CAS、活动战斗 Profile lease、archive/tombstone/evidence | 第二份 PVE 真源、与 DB/room cleanup 合并或重算 Run |
| Content Pipeline / Profile Store | Profile install/verify/lease/activation/rollback/recovery | binary update、release pointer |
| Dashboard renderer | 展示、人工意图、受信 preload 调用 | 文件、进程、capability、直接管理 HTTP |
| 玩家 WebSocket | 玩家目录、房间、战斗、回执、patch、snapshot、recovery | 运维、备份、Profile 管理、进程或更新 |

Electron main 是所有 management mutation 的唯一入口和 single-flight coordinator；委托 child 子步骤
也必须绑定 main 已 durable 接受的 operation。

- **RED-115**：原样复用 planning fence、HTTP/WS drain、Profile lease、`activationId`、原子
  stable pointer、failure evidence、startup recovery、`PROFILE_IN_USE` 与
  `PROFILE_DURABLE_DRAIN_FAILED`。这里只增加 outer `operationId -> activationId` durable mapping
  和状态聚合；不得另造 Profile pointer/lease 或直接编辑 `resource-pack/active.json`。
- **RED-116**：原样复用 `rvb-game-profile-identity/v1`。硬门禁仍是
  `engineAbi + runnerRevision + authorityContentHash`；`resolvedProfileHash` 只用于 provenance 与
  diagnostic。
- **RED-117**：原样复用 `rvb-pve-run-aggregate/v1`、revision CAS、active PVE battle Profile
  lease 以及 authority reconciliation 的 archive -> tombstone -> active Run removal 顺序。目标
  live root 归入 committed data generation；当前 `<userData>/pve-runs` 只作为一次性 migration
  input，不得与目标 root 同时写入或成为第二真源。
- **RED-127**：玩家同源 WS、玩家 `requestId` cache、规则 `clientActionId` 保持独立；管理面
  不复用玩家 socket、公开 `/api/*` 或静态 `admin-secret-key`。
- **RED-131**：原样复用每房间 FIFO、不同房间隔离、single writer、WAL、restore/drain 及
  `durable | pending | degraded`。SQLite busy 仍为 `busy_timeout=500ms`，单 job 最多 5 次或
  首错后 10 秒，先到者为准；只 degrade 对应房间，管理层不得再包无限重试。

Profile activation/rollback 与 app update 是两个状态机，只共享 coordinator、maintenance 和日志；
彼此不得写对方 pointer。

RED-115 继续独占 Profile Store、lock、plan、rebind、commit、release 与 recovery 行为；ADR-0021
只在自治 Server v1 adapter 完成迁移后，取代 RED-115 和旧模块地图中关于 standalone 管理 transport
与探针的句子。受信 preload IPC 经独立 loopback `/v1/profile/**` 直接调用同一个 RED-115 core，
不得转发到公开 `/api/content-profile/**`，不得增加第二 pointer、lease 或 static key。玩家 listener
不注册这些旧 Profile routes；旧玩家 REST 与 `/api/ping` 按 RED-127/ADR-0020 返回 410，尚依赖它们
的候选不合规。本文的 `player-http` health 是真实玩家 WS 路径的 HTTP Upgrade 得到 101；
`player-websocket` health 是 Upgrade 后完成 `system.health`，并校验 protocol/build/Profile。
同一迁移也取代 ADR-0020/RED-127 对 standalone `/api/admin/**` 的历史“不在范围”结论：
`/api/admin/rooms/cleanup` 不得注册到玩家 listener，也不是 v1 合规 fallback；room cleanup 只能由
trusted IPC 进入同一 main coordinator，再委托 capability-protected loopback
`POST /v1/rooms/cleanup`。静态资源仍可由玩家 HTTP origin 提供，但不能因此携带 management route。

## 3. Server、赛季与发行身份

- 首次初始化空 control root 时生成 UUIDv4 `serverId`；restart、app/Profile update、backup 和原机
  restore 不得改变它。
- 空 data root 可通过完整 verified backup 迁移并采用 backup 的 `serverId`；已有 identity 的 data
  root 只接受相同 ID。同一 data root 由本机 lock 保证一个 writer；unsigned backup 无法证明原主机
  已退役，因此跨主机迁移必须 native confirmation 原主机已停止，平行副本不受支持且 v1 不承诺
  跨主机 split-brain 防护。
- 复制数据创建新服属于 clone，必须显式重置 identity、operation tombstone 与赛季命名空间；旧服
  竞技历史只能作为只读证据，不得冒充新服排名。
- `serverId` 不是 secret、签名公钥或跨服证明。每服至多一个 active season；所有竞技
  response/export 必须携带 `{serverId, seasonId}` scope。
- restore 不得让 durable `rankingWatermark` 倒退，否则 `BACKUP_SEASON_CONFLICT`，v1 无 override。

```ts
interface ServerIdentityV1 {
  schemaVersion: 'rvb-server-identity/v1'
  serverId: string; createdAt: string
  origin:
    | { kind: 'generated' }
    | {
        kind: 'backup-migration'; backupId: string
        backupManifestSha256: `sha256:${string}`
      }
}
```

`control/server-identity.json` 是 write-once 唯一 identity 权威；state、backup、continuity 与
season/ranking 中的 serverId 都只是必须逐字匹配的 assertion。普通 update/backup/restore 永不重写
该文件。空 root 采用 backup identity 前先写绑定 operationId、backupId、manifest hash 与 target
serverId 的 durable bootstrap intent，再以同卷 `server-identity.json.partial` flush + atomic rename
完成唯一一次 identity commit，最后才能提交 deployment pointer。两者之间崩溃形成
`bootstrap-pending`：只允许继续同一 operation 与同一 verified backup，不能生成新 ID、改用另一
backup 或当作普通 existing root。

```ts
interface ReleaseArtifactBaseV1 {
  assetName: string
  download: {
    provider: 'github-releases'
    repository: 'longaadream/Red_VS_Blue'
    immutableUrl: string
    allowedRedirectHosts: string[]
  }
  byteLength: number
  sha256: `sha256:${string}`
}
interface InstallerArtifactV1 extends ReleaseArtifactBaseV1 {
  purpose: 'installer'
  kind: 'nsis-assisted-per-user-x64'
  mediaType: 'application/vnd.microsoft.portable-executable'
  authenticode: {
    requiredOnContainer: true; publisherPolicyId: string; timestamped: true
  }
}
interface UpdateBundleArtifactV1 extends ReleaseArtifactBaseV1 {
  purpose: 'update-bundle'
  kind: 'zip-release-tree-x64'
  mediaType: 'application/zip'
  authenticode: {
    requiredOnContainer: false; publisherPolicyId: null; timestamped: false
  }
}
interface RuntimeCatalogArtifactV1 extends ReleaseArtifactBaseV1 {
  purpose: 'runtime-catalog'
  kind: 'windows-authenticode-catalog-x64'
  mediaType: 'application/vnd.ms-pki.seccat'
  authenticode: {
    requiredOnContainer: true; publisherPolicyId: string; timestamped: true
  }
}
type ReleaseArtifactV1 =
  | InstallerArtifactV1 | UpdateBundleArtifactV1 | RuntimeCatalogArtifactV1

interface ReleaseIdentityV1 {
  schemaVersion: 'rvb-release-identity/v1'
  releaseId: `sha256:${string}`
  releaseSequence: number
  securityEpoch: number
  appSemVer: string
  publishedAt: string
  applicationId: 'com.redvsblue.server' | 'com.redvsblue.server.candidate'
  channel: 'stable' | 'candidate'
  commitSha: string
  sourceTreeSha: string
  runtimeTreeSha256: `sha256:${string}`
  runtimeFiles: Array<{
    path: string; byteLength: number; sha256: `sha256:${string}`
    authenticode:
      | { kind: 'project-pe'; publisherPolicyId: string }
      | {
          kind: 'third-party-pe'; subjectOrganization: string
          signerSpkiSha256: `sha256:${string}`
        }
      | { kind: 'not-pe' }
  }>
  supportedUpgradeFromReleaseIds: Array<`sha256:${string}`>
  previousRollbackTargetReleaseId: `sha256:${string}` | null
  artifacts: {
    installer: InstallerArtifactV1 | null
    updateBundle: UpdateBundleArtifactV1
    runtimeCatalog: RuntimeCatalogArtifactV1
  }
  platform: 'win32'
  arch: 'x64'
  battle: { protocolVersion: string; authorityBuildId: string }
  engine: { engineAbi: string; runnerRevision: string }
  bundledProfileIdentity: GameProfileIdentityV1
  database: {
    schemaVersion: string; migrationSetHash: `sha256:${string}`
    readableSchemaVersions: string[]; migratableFromSchemaVersions: string[]
    rollbackMode: 'binary-only' | 'restore-backup' | 'forbidden'
  }
  pve: {
    runAggregateSchemaVersion: 'rvb-pve-run-aggregate/v1'
    authorityTombstoneSchemaVersion: 'rvb-pve-authority-tombstone/v1'
    readableRunAggregateSchemaVersions: string[]
    migratableFromRunAggregateSchemaVersions: string[]
    readableAuthorityTombstoneSchemaVersions: string[]
    migratableFromAuthorityTombstoneSchemaVersions: string[]
    migrationSetHash: `sha256:${string}`
  }
  managementApiVersion: 'rvb-server-operations/v1'
  supportedPlatform: {
    os: 'windows'; productType: 'workstation'; arch: 'x64'
    windows10Build: { min: 19045; max: 19045 }
    windows11Build: { min: 22000; maxTestedBuild: number }
  }
  manifest: {
    manifestSha256: `sha256:${string}`; signatureAlgorithm: 'Ed25519'
    keysetVersion: number
    signatures: Array<{ keyId: string; signature: string }>
  }
}

interface ReleaseSignaturesV1 {
  schemaVersion: 'rvb-release-signatures/v1'
  releaseId: `sha256:${string}`; releaseSequence: number
  channel: 'stable' | 'candidate'
  manifestPayloadSha256: `sha256:${string}`
  signatureAlgorithm: 'Ed25519'
  signatures: Array<{ keyId: string; signature: string }>
}

interface ReleaseKeysetV1 {
  schemaVersion: 'rvb-release-keyset/v1'
  keysetVersion: number; issuedAt: string; expiresAt: string
  rootKeyId: string; signatureAlgorithm: 'Ed25519'
  channels: Array<{
    channel: 'stable' | 'candidate'
    minimumSecurityEpoch: number
    leafKeys: Array<{
      keyId: string; publicKeyBase64url: string
      notBefore: string; notAfter: string
      status: 'next' | 'active' | 'retired' | 'revoked'
      revokedAt: string | null
    }>
    authenticodePolicies: Array<{
      policyId: string; subjectOrganization: string
      acceptedSignerSpkiSha256: Array<`sha256:${string}`>
      notBefore: string; notAfter: string
      status: 'next' | 'active' | 'retired' | 'revoked'
      revokedAt: string | null
      fileDigest: 'sha256'; timestampDigest: 'sha256'; rfc3161Required: true
    }>
  }>
  rootSignature: {
    payloadSha256: `sha256:${string}`; signature: string
  }
}

interface ReleaseTrustHighWaterV1 {
  channel: 'stable' | 'candidate'
  keysetVersion: number
  keysetRecordSha256: `sha256:${string}`
  releaseSequence: number
  releaseRecordSha256: `sha256:${string}`
  securityEpoch: number
}
```

`pve.readableRunAggregateSchemaVersions` 与
`pve.readableAuthorityTombstoneSchemaVersions` 必须分别包含 current aggregate/tombstone version；
迁移只能从对应 `migratableFrom*SchemaVersions` 明列版本运行由同一 `migrationSetHash` 绑定的确定性
migration。active aggregate、archived evidence 与 tombstone 必须作为一个闭合集合通过兼容判断；未知
aggregate/tombstone schema 在任何 live/staging mutation 前返回
`PVE_SCHEMA_INCOMPATIBLE`，不得忽略 entry 或假定与 DB schema 同步。
四个 version list 都必须去重并按 UTF-8 bytes 排序；同一 source version 不得同时声明为 readable 与
migratable，避免不同实现选择“直接读”或“先迁移”的不同路径。

所有 `sha256:${string}` 值固定为 `sha256:` + 64 个 lowercase hex；UUID 使用 lowercase canonical
8-4-4-4-12；时间使用 UTC RFC 3339 `YYYY-MM-DDTHH:mm:ss[.sss]Z`。Ed25519 public key 是 RFC 4648
unpadded base64url 的 32 raw bytes，signature 是同编码的 64 raw bytes；其他长度或非 canonical
encoding 一律拒绝。Windows platform gate 必须同时证明 x64、`VER_NT_WORKSTATION`、build 19045
或 22000..`maxTestedBuild`；每个 release 的 maxTestedBuild 必须来自该候选 Windows 11 VM 证据，
Windows Server 即使 build 更高也拒绝。

canonical payload 是除 `releaseId`、`manifest.manifestSha256` 与 `manifest.signatures` 外全部字段
的 RFC 8785 JCS UTF-8 bytes。`releaseId` 与 `manifest.manifestSha256` 都必须等于该 payload 的
SHA-256；每个 Ed25519 signature 都签同一 payload。strict verifier 拒绝重复 keyId、未知 schema/enum、
非规范 hash、非安全整数和多余签名字段。普通 release 至少有一个当前 active channel leaf 的有效
签名；轮换 overlap release 必须同时验证 current 与 next 两个 leaf。`releaseRecordSha256` 是包含
releaseId、manifest hash 与 signatures 的完整 `ReleaseIdentityV1` RFC 8785 JCS bytes 的 SHA-256；
已发布 record immutable，同一 releaseSequence 不允许换 payload、artifact 或 signature set。

Keyset canonical payload 是除 `rootSignature` 外 `ReleaseKeysetV1` 的 RFC 8785 JCS UTF-8 bytes；
`rootSignature.payloadSha256` 必须等于其 SHA-256，signature 由 launcher 内置、与 `rootKeyId` 精确
匹配的 offline root public key 验证。`keysetRecordSha256` 是包含 `rootSignature` 的完整
`ReleaseKeysetV1` RFC 8785 JCS bytes 的 SHA-256。网络 keyset 不能增加/替换 root。每个 channel
恰有一个 entry；keyId、policyId 与 SPKI hash 必须非空且全局唯一，时间为规范 UTC，数组不得重复，
version 必须是安全整数。低于 durable keysetVersion 一律拒绝；等于 high-water 时只有完整 canonical
record（包括 rootSignature）与已记录 keysetRecordSha256 精确一致才是合法 replay，否则
`UPDATE_SIGNATURE_INVALID`；只有更高 version 才推进 high-water。过期 keyset 不能授权新
check/prepare，但不使当前已安装 bytes 自动停服。

Release signatures 只能使用同 channel keyset entry 中的 leaf。active/next 可授权新 release；
retired 只可验证 ledger 已记录、在 key 有效期内发布的 exact previous rollback target；revoked 永不
接受。Installer 和 ZIP 内所有项目自产 PE 的 Authenticode signer 必须同时通过 Windows chain/
RFC 3161 校验，并命中该 channel root-signed `publisherPolicyId` 的 subject organization 与 SPKI
allowlist；leaf-signed release manifest 不能扩大 publisher policy。Publisher active/next/retired/
revoked 的新发行与 exact previous 语义和 leaf 相同。第三方 PE 只接受 release inventory 固定的上游
签名身份与 hash，不套用项目 publisher。

Detached `ReleaseSignaturesV1` 只是不含 manifest payload 的发布传输副本，不是第二签名真源。
`releaseId` 与 `manifestPayloadSha256` 必须都等于 `ReleaseIdentityV1.releaseId`，
`releaseSequence/channel/signatureAlgorithm` 必须逐字匹配，且
`JCS(ReleaseSignaturesV1.signatures) === JCS(ReleaseIdentityV1.manifest.signatures)`（含数组顺序）。
main 必须 strict 解析两份 record 后才验证 leaf；任何 duplicate/unknown field、缺少/增加/重排/
替换 signature 或 payload hash drift 都返回 `UPDATE_SIGNATURE_INVALID`，零 trust/high-water/
artifact-set 写入。后续 ledger 和兼容判断仍只使用完整 immutable `ReleaseIdentityV1`。

Stable 必须同时发布 assisted per-user NSIS installer、ZIP update bundle 与 Windows Authenticode
catalog；candidate 至少发布隔离 update bundle + candidate catalog，候选 installer 可为空。三者都由
manifest 绑定 length/hash/runtime tree。installer 与 catalog container 必须通过 Windows
Authenticode SHA-256 publisher 与 RFC 3161 timestamp；catalog 必须逐项覆盖完整 runtimeFiles，
所以 Ed25519 leaf 泄漏不能独自授权被修改的 JS/asar/data。ZIP container 本身不执行也不要求
Authenticode，但 extract 必须与 catalog + manifest inventory 完全一致。项目自产 PE 再逐个验证项目
publisher/timestamp，第三方 PE 验证 manifest 固定的上游 subject/SPKI。platform、channel、API、DB
和当前 Profile gate 也必须通过。HTTPS 只是 transport。Candidate 使用独立 appId、data root、leaf
与 publisher policy；stable 永不信任 candidate。现有内部 `dir` 可作为生成 ZIP/tree inventory 前的
QA 输入，但不是 release artifact，也不得公开下载。

`channel=stable` 只接受 `applicationId=com.redvsblue.server`；
`channel=candidate` 只接受 `applicationId=com.redvsblue.server.candidate`，其他组合 fail closed。

首次安装消费 `artifacts.installer` 并用 `artifacts.runtimeCatalog` 验证 installed tree；in-app
update/rollback 只消费 `artifacts.updateBundle` + `artifacts.runtimeCatalog`，不得静默执行 NSIS。
update bundle 是 UTF-8 filename 的 ZIP，只允许普通
文件；拒绝 absolute/drive/UNC、`..`、backslash、NUL、ADS/colon、Windows reserved device name、
symlink/junction/reparse、duplicate 或 case-insensitive collision，并在解压前后执行 size/file-count
budget。固定上限为 archive 2 GiB、20,000 files、total uncompressed 4 GiB、单文件 1 GiB、
normalized relative path 1024 UTF-8 bytes、单 segment 255 UTF-16 code units；拒绝 encrypted、
multi-disk、central/local header mismatch 与 declared/actual size mismatch。v1 不使用 compression
ratio gate，以上 absolute budgets 同时检查 signed inventory、ZIP headers 与实际输出。runtime tree
hash 对按 UTF-8 byte 顺序排序的 normalized NFC relative path，逐项连接
`u32be(pathByteLength) || pathBytes || u64be(fileByteLength) || raw32(fileSha256)` 后做 SHA-256；
path separator 固定为 `/`。`runtimeFiles` 必须按该顺序、无 duplicate/case collision 且计算出同一
`runtimeTreeSha256`；catalog member set、installer clean-install inventory 与 ZIP extract inventory
必须逐路径/length/hash 精确等于 runtimeFiles，任何 missing/extra 都拒绝。

`download.immutableUrl` 与 redirect hosts 进入 signed payload。URL 与每次 redirect 必须是 HTTPS、
默认 443、无 userinfo/fragment，最多 5 跳；host 是 lowercase ASCII A-label、无 trailing dot、
wildcard 或 IP literal，并按 exact host 比较，不做 suffix/subdomain 匹配。内置 GitHub provider
allowlist 固定为 `github.com`、`api.github.com`、`objects.githubusercontent.com` 与
`release-assets.githubusercontent.com`；signed `allowedRedirectHosts` 必须是该集合的无重复子集，
实际每一跳也必须同时属于两者，manifest 不能扩大 launcher 信任。query 只能是 GitHub 签名 asset URL
原有 query，不得在 redirect 时由跨 origin 继承 credential/header。

公开 v1 不提供 MSI、Portable、per-machine、Service 或 silent unattended。update side-by-side 后只
原子切 deployment pointer，不覆盖 running EXE。卸载默认保留 user data/backups/logs；删除数据是
默认未勾选、展示解析后固定 data root 并二次确认的独立动作。

实例固定 channel。自动 downgrade 禁止；rollback 只到 ledger 记录的 exact previous release 并重验
全部 bytes/signatures。`binary-only` 只在旧 binary 可读写当前 schema 时允许；
`restore-backup` 必须 binary + verified old data 同时恢复；`forbidden` 拒绝。

## 4. 统一状态与生命周期

```ts
type LifecycleStateV1 =
  | 'stopped' | 'starting' | 'ready' | 'maintenance' | 'draining'
  | 'stopping' | 'degraded' | 'failed' | 'updating' | 'rollback-required'
type AdmissionModeV1 = 'open' | 'existing-only' | 'closed'
type StateReasonCodeV1 =
  | OperationErrorCodeV1
  | 'OPERATOR_REQUEST' | 'STARTUP_RECOVERY' | 'NORMAL_STOP'
  | 'MAINTENANCE_REQUEST' | 'APP_UPDATE' | 'BACKUP_RESTORE'
  | 'HEALTH_DEGRADED' | 'ROOM_WARNING'
type PveOperationsStateV1 =
  | {
      state: 'ready'; observedAt: string; reasonCode: null
      source: 'rvb-pve-run-aggregate/v1'
      totalRuns: number; activeBattleCount: number
      activeBattleRunIds: string[]; activeBattleIds: string[]
      aggregateSetSha256: `sha256:${string}`
    }
  | {
      state: 'unavailable' | 'migrating' | 'incompatible' | 'corrupt'
      observedAt: string; reasonCode: StateReasonCodeV1
      source: null; totalRuns: null; activeBattleCount: null
      activeBattleRunIds: null; activeBattleIds: null
      aggregateSetSha256: null
    }

interface ServerOperationsStateV1 {
  schemaVersion: 'rvb-server-operations/v1'
  stateRevision: number; observedAt: string; lastChangedAt: string
  staleAfterMs: 10000; stale: boolean; serverId: string
  lifecycle: {
    state: LifecycleStateV1; since: string
    reasonCode: StateReasonCodeV1 | null; ownerOperationId: string | null
  }
  admission: { mode: AdmissionModeV1; reasonCode: StateReasonCodeV1 | null; since: string }
  process: {
    state: 'absent' | 'spawning' | 'running' | 'exited' | 'unresponsive'
    childInstanceId: string | null; pid: number | null; startedAt: string | null
    lastHeartbeatAt: string | null; exitCode: number | null; signal: string | null
  }
  health: { overall: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; checks: HealthCheckV1[] }
  endpoints: {
    playerHttpOrigin: string | null; playerWsOrigin: string | null
    managementApiVersion: 'rvb-server-operations/v1'
  }
  deployment: {
    currentRelease: ReleaseIdentityV1; previousRelease: ReleaseIdentityV1 | null
    preparedRelease: ReleaseIdentityV1 | null
    currentArtifactSetSha256: `sha256:${string}`
    previousArtifactSetSha256: `sha256:${string}` | null
    preparedArtifactSetSha256: `sha256:${string}` | null
  }
  profile: {
    source: 'rvb-profile-state/v1'; stateRevision: number
    stable: GameProfileIdentityV1; previousStable: GameProfileIdentityV1 | null
  }
  database: {
    state: 'unknown' | 'ready' | 'migrating' | 'incompatible' | 'corrupt'
    schemaVersion: string | null; migrationSetHash: `sha256:${string}` | null
    journalMode: 'wal' | 'unknown'; lastIntegrityCheckAt: string | null
  }
  persistence: {
    ingress: 'accepting' | 'quiescing' | 'closed'; pendingJobs: number
    oldestPendingMs: number | null
    roomsByStatus: { durable: number; pending: number; degraded: number }
  }
  rooms: {
    total: number; listed: number; activeLeases: number
    cleanupEpoch: number; blockers: MaintenanceBlockerV1[]
  }
  pve: PveOperationsStateV1
  season: {
    seasonId: string | null; status: 'none' | 'preseason' | 'active' | 'closed'
    rankingWatermark: number
  }
  backup: {
    lastVerified: BackupRecordSummaryV1 | null
    activeOperationId: string | null
    availableCount: number
    retentionWarnings: string[]
  }
  update: {
    lastCheckedAt: string | null
    availableRelease: ReleaseIdentityV1 | null
    preparedRelease: ReleaseIdentityV1 | null
    preparedArtifactSetSha256: `sha256:${string}` | null
    activeOperationId: string | null
    phase:
      | OperationPhaseNameByKindV1[
          | 'app-update.check' | 'app-update.prepare'
          | 'app-update.apply' | 'app-update.rollback'
        ]
      | null
  }
  activeOperation: OperationSnapshotV1 | null; lastOperation: OperationSnapshotV1 | null
  lastFailure: OperationErrorV1 | null
}

interface HealthCheckV1 {
  name:
    | 'process' | 'management-http' | 'player-http' | 'player-websocket'
    | 'release-identity' | 'profile-identity' | 'database-schema'
    | 'database-integrity' | 'persistence-writer' | 'pve-run-store' | 'disk-space'
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  observedAt: string; code: OperationErrorCodeV1 | 'LOG_SINK_FAILED' | null
  message: string
}

interface MaintenanceBlockerDetailsV1 {
  authorityEpoch?: number; authorityVersion?: number
  durableAuthorityVersion?: number; pendingJobs?: number; leaseCount?: number
  runId?: string; battleId?: string; runRevision?: number
  deadlineAt?: string; requiredBytes?: number; availableBytes?: number
}
interface MaintenanceBlockerV1 {
  kind:
    | 'active-room' | 'accepted-ingress' | 'profile-lease' | 'persistence-pending'
    | 'active-pve-battle' | 'pve-ingress-pending' | 'pve-run-store-invalid'
    | 'room-degraded' | 'ranking-pending' | 'disk-space' | 'operation'
  blockerId: string; roomId: string | null; since: string
  code: OperationErrorCodeV1; retryable: boolean; details: MaintenanceBlockerDetailsV1
}

interface BackupRecordSummaryV1 {
  backupId: string; createdAt: string; verifiedAt: string
  serverId: string; releaseId: `sha256:${string}`; databaseSchemaVersion: string
  activeProfileIdentity: GameProfileIdentityV1
  seasonId: string | null; rankingWatermark: number
  pveAggregateSetSha256: `sha256:${string}`
  byteLength: number; manifestSha256: `sha256:${string}`
  kind: 'manual' | 'daily' | 'weekly' | 'pre-update' | 'pre-restore'
  pinnedReason: string | null
}
```

`state.profile` 只是一次 strict 读取 RED-115 `resource-pack/active.json` 的只读投影，不另行持久化；
`deployment` 不复制 Profile identity/revision。App update journal 可记录 observed Profile
revision/hash 作前置与证据，但 commit/reopen 前必须重新读取 RED-115 真源，不能把观察值当 pointer。
`deployment.*ArtifactSetSha256` 只投影 committed deployment pointer 与 verified marker；
`update.preparedRelease/preparedArtifactSetSha256` 只投影同一 prepared ledger/marker。两处 prepared
identity/hash 必须逐字相同，任何 drift 都是 `RELEASE_IDENTITY_MISMATCH`，不得另存第二份值。

`state.pve.state=ready` 的值只从 RED-117 `PveRunStoreV1` 的 strict active aggregate、immutable archived evidence
和 tombstone 计算；active battle/lease 只认 RED-117
`getPveActiveBattleLeaseReportV1()`，不得从 UI/room 数量推断。`state.pve` 不另行持久化，也不计入
`rooms.activeLeases`。实现对每个 active aggregate、archived evidence 和 tombstone 先生成
`canonicalBytes = RFC 8785 JCS UTF-8 bytes(complete strict-parsed record)`，不得省略 null/默认字段或
hash raw pretty-JSON bytes，再生成
`{recordKind,runId,recordSha256='sha256:'+lowerhex(SHA256(canonicalBytes))}`。Archived evidence
必须先通过 RED-117 `readArchivedEvidence(tombstone)`，即以其既有
``${JSON.stringify(record, null, 2)}\n`` serialization 验证 tombstone 中无前缀
`evidenceHash`，之后才对 strict-parsed complete record 做上述 JCS digest。records 按
recordKind + runId + recordSha256 的 UTF-8 bytes 排序，再以
`'sha256:'+lowerhex(SHA256(JCS(sorted records)))` 得到 `aggregateSetSha256`；
`activeBattleRunIds` 与 `activeBattleIds` 也按 UTF-8 bytes 排序。任何缺失、重复、hash 不匹配或
parse 失败都使 `pve-run-store` unhealthy 且 admission closed，禁止跳过损坏项后重算“健康”集合。
strict observation 失败时 read 仍返回 closed abnormal branch，所有 count/ID/hash 固定为 null，不得
回显 stale/last-known 集合冒充现场值。`unavailable` 只允许表示 integrity、唯一 writer 与 committed
generation 仍有 durable 证据的 transient timeout/unavailable，映射 lifecycle `degraded`/closed；
`migrating` 只允许 active update/restore operation，映射 `updating`/closed；`incompatible`、`corrupt`
以及无法证明唯一 writer/完整集合的 observation 固定映射 `failed`/closed。

Health check 名称固定为 process、management-http、player-http、player-websocket、release-identity、
profile-identity、database-schema、database-integrity、persistence-writer、pve-run-store、disk-space；每项含
status、observedAt、稳定 code 与脱敏 message。

`stateRevision` 是 durable monotonic safe integer；语义变化先 durable 再 broadcast，restart 后大于
旧值。child heartbeat 2 秒，10 秒未收即 stale/unresponsive。read 永远允许；除 stop、force-stop、
cancel、diagnostics 外，依赖 child 的 mutation 在 stale 时返回 `STATE_STALE`。state reader 可忽略
v1 新增可选字段；command strict 拒绝 unknown field/enum、duplicate JSON key 和不同 schemaVersion。

`ready` 必须同时满足 process、玩家 HTTP/WS、management adapter、DB、persistence、RoomRuntime、
PVE Run Store、Profile、release tuple 和 admission open；PID 或端口响应不能单独证明 ready。单房 degraded 只进入
房间 warning/aggregate，顶层可保持 ready。全局 DB/PVE Store 的 transient unavailable/timeout 只有在
integrity、唯一 writer ownership 与 committed generation 都仍可证明时才进入 `degraded`/closed；corrupt、
integrity failure、集合不完整、未知 schema、writer ownership 歧义或没有 trustworthy writer 一律进入
`failed`/closed。identity/process ownership 不确定同样是 `failed`，不能笼统归为 degraded。

Operator 触发的转换都要求 trusted IPC，并继承第 5 节 operation 幂等；内部 fault/recovery 转换只能由
表中 owner 根据 durable evidence 产生，renderer 不能直接 set state。

| State | Owner 与进入前置 | 接受的操作 / 合法下一状态 | Timeout / staleness 与可观察结果 | 失败状态与回退 |
| --- | --- | --- | --- | --- |
| `stopped` | Supervisor；无 child、port、writer，admission closed | start -> starting；maintenance.enter -> maintenance；backup.restore/app-update.apply/app-update.rollback -> updating，成功按 source intent 回 stopped；app-update.prepare 保持 stopped；只读；若 startup/heartbeat observation 才发现 residual tree，force-stop 成功仍 stopped | durable state 无自动 timeout；absence evidence 可见 | start fail -> failed；force-stop/deployment commit 不确定 -> rollback-required；data 不变 |
| `starting` | Supervisor；data lock 唯一、child spawning、closed；保存 source intent | stop -> stopping；force-stop；全部 gate 通过 -> ready，若 source intent 是 maintenance 则 -> maintenance | 20 秒 readiness；可见 childInstanceId/heartbeat/checks | timeout/exit/identity mismatch -> failed；force-stop 仅在 process absent 且 deployment unambiguous 时 -> stopped，否则 failed/rollback-required |
| `ready` | Supervisor；全部 global gate healthy、admission open | maintenance.enter -> maintenance；stop/restart -> maintenance/draining/stopping；profile.install 保持 ready；profile.activate/rollback 先 fence -> maintenance，成功 -> ready；app-update.prepare 保持 ready；app-update.apply -> updating -> ready；update-check/只读 | heartbeat staleAfter 10 秒；完整 ready tuple | 可证明 integrity/唯一 writer 的 transient global unavailable -> degraded/closed；corrupt、integrity failure、无可信/唯一 writer 或 process ownership 不确定 -> failed/closed；Profile drain fail 保持 maintenance/closed；force-stop 仅在 absence 与 deployment 确定时 -> stopped，否则 failed/rollback-required |
| `maintenance` | Electron main；durable room + PVE fence，admission existing-only/closed | child absent 时 start -> starting -> maintenance；restart 经 draining/stopping/starting -> maintenance；drain、backup.create、room.cleanup、profile.install 保持 maintenance；profile.activate/rollback 成功保持 maintenance；app-update.prepare 保持 maintenance；backup.restore/app-update.apply/rollback -> updating -> maintenance；exit -> ready；stop | fence 10 秒；blockers、room/PVE watermarks 与 drainRevision 可见 | blocker -> maintenance/existing-only；可证明 integrity/唯一 writer 的 transient durability fault -> degraded/closed；corrupt/集合不完整/无可信 writer -> failed/closed；Profile 失败保持 maintenance 或 degraded/closed；force-stop 仅在 absence 与 deployment 确定时 -> stopped，否则 failed/rollback-required |
| `draining` | RoomRuntime + persistence + PVE Run Store；maintenance 已建立 | 仅当前 drain/stop/restart/update orchestration、force-stop 与只读；barrier pass -> maintenance/stopping/updating | 默认 60 秒、可 1–600 秒；逐 room/PVE blocker、pending 与 watermark | active blocker -> maintenance；可证明 integrity/唯一 writer 的 transient durable fail -> degraded/closed；corrupt/集合不完整/无可信 writer -> failed/closed；force-stop 成功只有在 commit/deployment 确定时 -> stopped，否则 rollback-required；absence 失败 -> failed |
| `stopping` | Supervisor；正常路径已有 durable room + PVE drain | 当前 stop、force-stop 与只读；process tree/ports/writer absent -> stopped | final ACK 6.5 秒 + tree exit 5 秒；PID/port/writer absence 可见 | ACK 未证实不得自动 kill；force-stop 成功只有在 commit/deployment 确定时 -> stopped，否则 rollback-required；absence 失败 -> failed |
| `degraded` | Supervisor；进程可能存活但全局 gate 失败，admission closed | maintenance.enter、stop、restart、diagnostics；app-update.prepare 保持 degraded；app-update.apply -> updating -> maintenance；恢复只能经 maintenance.enter/exit，或 restart -> maintenance 后再 exit，不直接跳 ready | 每 heartbeat 重评但不自动开 admission；failure code/checks 可见 | 未恢复保持 degraded/closed；unknown write -> rollback-required；force-stop 仅在 absence 与 deployment 确定时 -> stopped，否则 failed/rollback-required |
| `failed` | Supervisor；无可信 writer 或启动/恢复不收敛 | server.stop 只有在证明 process tree、ports、writer absent 后 -> stopped；verified backup.restore -> updating；force-stop residual tree 后仅在 absence 已证明时 -> stopped；只读 | 无自动 timeout；admission 永远 closed；absence evidence 可见 | orphan/untrusted process 未收口则保持 failed；restore 不确定 -> rollback-required；保留原数据 |
| `updating` | Electron main；active update/restore operation 与 closed admission | 仅当前 operation、force-stop 与只读；成功按 source intent -> ready/maintenance/stopped | forward deadline 最多 45 分钟；postcommit safety recovery 另有 20 分钟；phase/commitBoundary 可见 | precommit 且旧 pointer 明确时 force-stop -> stopped；postcommit/commit 不确定时 force-stop -> rollback-required；app-update.apply/existing-root restore 的确定 postcommit fail 走 exact rollback，empty-root restore 或 app-update.rollback 的 postcommit fail -> rollback-required |
| `rollback-required` | Electron main；pointer/generation/commit 无法证明或 rollback 失败 | verified app-update.rollback/backup.restore -> updating；force-stop 可移除 process 但状态仍 rollback-required；diagnostics/read | 无自动离开；显示完整 evidence 与 closed admission | 任何恢复失败保持本状态、无 writer；不得猜版本、改成 stopped 或自动 reopen |

不改变 lifecycle 的通用操作也必须明确：`app-update.check` 可在除 rollback-required 外的任意 state
执行，`diagnostics.export` 和只读 query 可在全部 state 执行；它们不得改变 admission/service
intent。未列转换返回 `INVALID_STATE_TRANSITION` 且零副作用。app update、restore 与 Profile operation 都保存
source service intent：原 ready 且全部 gate 通过才 reopen；原 maintenance/stopped 返回原状态；原
degraded 固定映射为 maintenance/closed 等人工核对；failed/rollback-required 发起 restore 固定映射为
maintenance/closed，不自动 ready。该映射作为 accept record 的 `sourceServiceIntent` 在任何副作用前
durable，restart 必须逐字使用，不能根据当时 process/lifecycle 重新推断。

本文中的 `reconcile`、`reconcile-absence` 与 `commit-reconcile` 只表示 Supervisor 在 startup/
heartbeat 或一个已 durable 接受 operation 内按 ledger/pointer/process evidence 执行的内部 phase，
不是 `OperationKindV1`、不是 renderer/operator command，也不能绕过 single-flight/幂等。
degraded 不存在“人工 reconcile -> ready”旁路；failed 只能用现有 `server.stop` durable 提交 absence
后进入 stopped，再单独 start。

## 5. Operation、幂等与错误合同

```ts
type OperationKindV1 =
  | 'server.start' | 'server.stop' | 'server.force-stop' | 'server.restart'
  | 'maintenance.enter' | 'maintenance.drain' | 'maintenance.exit'
  | 'room.cleanup' | 'backup.create' | 'backup.restore'
  | 'profile.install' | 'profile.activate' | 'profile.rollback'
  | 'app-update.check' | 'app-update.prepare' | 'app-update.apply' | 'app-update.rollback'
  | 'diagnostics.export'

type NativeApprovalOperationKindV1 =
  | 'server.force-stop' | 'room.cleanup' | 'backup.restore'
  | 'profile.rollback' | 'app-update.apply' | 'app-update.rollback'
type ServiceIntentV1 = 'ready' | 'maintenance' | 'stopped'
type EmptyOperationArgumentsV1 = Record<string, never>

type BackupCreateArgumentsV1 =
  | { label?: string; cleanupPlanId?: never; cleanupPlanHash?: never }
  | { label?: string; cleanupPlanId: string; cleanupPlanHash: `sha256:${string}` }
type AppUpdateApplyArgumentsV1 =
  | {
      preparedReleaseId: `sha256:${string}`
      cleanupPlanId?: never; cleanupPlanHash?: never
    }
  | {
      preparedReleaseId: `sha256:${string}`; cleanupPlanId: string
      cleanupPlanHash: `sha256:${string}`
    }

interface OperationArgumentsByKindV1 {
  'server.start': EmptyOperationArgumentsV1
  'server.stop': { drainTimeoutMs?: number }
  'server.force-stop': { acknowledgeUndurableTailLoss: true }
  'server.restart': { drainTimeoutMs?: number }
  'maintenance.enter': { reason: string }
  'maintenance.drain': { timeoutMs?: number }
  'maintenance.exit': EmptyOperationArgumentsV1
  'room.cleanup': {
    planId: string; planHash: `sha256:${string}`; backupId: string
    acknowledgeIrreversible: true
  }
  'backup.create': BackupCreateArgumentsV1
  'backup.restore': { backupId: string }
  'profile.install': { importToken: string }
  'profile.activate': { targetResolvedProfileHash: Sha256HexV1 }
  'profile.rollback': { target: 'previous-stable' | 'bundled-base' }
  'app-update.check': EmptyOperationArgumentsV1
  'app-update.prepare': { releaseId: `sha256:${string}` }
  'app-update.apply': AppUpdateApplyArgumentsV1
  'app-update.rollback': { targetReleaseId: `sha256:${string}` }
  'diagnostics.export': { exportToken: string; includeRoomIds?: string[] }
}

interface OperationCommandBaseV1 {
  schemaVersion: 'rvb-server-operations/v1'
  requestId: string; operationId: string; expectedStateRevision: number
}

interface OperationApprovalV1 {
  challengeId: string; commandHash: `sha256:${string}`
}

type OperationCommandV1 = {
  [K in OperationKindV1]:
    & OperationCommandBaseV1
    & { kind: K; arguments: OperationArgumentsByKindV1[K] }
    & (
      K extends NativeApprovalOperationKindV1
        ? { approval: OperationApprovalV1 }
        : { approval?: never }
    )
}[OperationKindV1]
```

每个 command branch 都是 `additionalProperties:false`。stop/drain timeout 是 safe integer
1000..600000 ms，restart 是 1000..120000 ms；省略使用第 5 节 default。reason 最多 256、label
最多 128 个 Unicode scalar；token 最多 256 ASCII；ID/hash 使用本节 canonical scalar。
`includeRoomIds` 去重、最多 500。Native-approval kind 必须有 approval；其他 kind 出现 approval
一律 `INVALID_COMMAND`。requestId、operationId、challengeId、serverId 和 backupId 使用 canonical
UUIDv4；releaseId 使用 canonical SHA-256 identity。

`requestId` 每 transport attempt 唯一，只作 correlation；`operationId` 在首次提交前生成，是跨
response loss、IPC timeout、child/app restart 的 durable idempotency key。
`commandHash = SHA256(JCS({schemaVersion,kind,expectedStateRevision,arguments}))`；这里的输入是
具有这四个命名字段的 JSON object，不是字符串连接，排除 requestId、operationId 和 approval。

coordinator 必须先查 ledger 再做 CAS/precondition：相同 operationId + hash 返回同一 operation；同 ID
不同 hash 返回 `OPERATION_ID_REUSE`；新 ID 才比较 expected revision，错则
`STATE_REVISION_MISMATCH` 且零副作用。全局最多一个 mutation；Profile 也进入同一 coordinator。
read 可并行。force-stop/cancel 是唯一控制例外，但仍 durable revision/result。

terminal full record 至少保留 90 天或最近 1000 条，取更多者；compact tombstone
`{id,kind,hash,status,resultHash}` 随 serverId 永久保留。full result 已清理的 replay 返回
`OPERATION_RESULT_EXPIRED`，不得重执行。

```ts
interface RoomCleanupReceiptV1 {
  roomId: string; disposition: 'deleted' | 'already-absent'; committedAt: string
}

interface VerifiedArtifactResultV1 {
  assetName: string; byteLength: number; sha256: `sha256:${string}`; verifiedAt: string
}

interface OperationResultByKindV1 {
  'server.start': {
    childInstanceId: string; releaseId: `sha256:${string}`
    serviceIntent: ServiceIntentV1
  }
  'server.stop': {
    drainRevision: `sha256:${string}` | null; durable: true; processAbsent: true
    exitCode: number | null; stoppedAt: string
  }
  'server.force-stop': {
    terminatedChildInstanceId: string | null; processAbsent: true
    undurableTailLossPossible: true; interruptedOperationId: string | null
  }
  'server.restart': {
    oldChildInstanceId: string | null; newChildInstanceId: string
    drainRevision: `sha256:${string}` | null; durableAt: string
  }
  'maintenance.enter': {
    admissionMode: 'existing-only' | 'closed'
    fenceId: string | null; blockers: MaintenanceBlockerV1[]
  }
  'maintenance.drain': {
    drainRevision: `sha256:${string}`; rooms: RoomDrainReceiptV1[]
    pendingJobs: 0; pve: PveDrainReceiptV1; durableAt: string
  }
  'maintenance.exit': {
    releaseId: `sha256:${string}`; activeProfileIdentity: GameProfileIdentityV1
    pveAggregateSetSha256: `sha256:${string}`; admissionMode: 'open'
  }
  'room.cleanup': {
    deletedRoomIds: string[]; alreadyAbsentRoomIds: string[]
    receipts: RoomCleanupReceiptV1[]
  }
  'backup.create': {
    backupId: string; manifestSha256: `sha256:${string}`
    pveAggregateSetSha256: `sha256:${string}`
    byteLength: number; verifiedAt: string
    cleanupCoverage: {
      planId: string; planHash: `sha256:${string}`
      cleanupEpoch: number; roomSelectionFingerprint: `sha256:${string}`
    } | null
  }
  'backup.restore': {
    serverId: string; preRestoreBackupId: string | null
    dataGenerationId: string; activeProfileIdentity: GameProfileIdentityV1
    profileActivationId: string | null; serviceIntent: ServiceIntentV1
  }
  'profile.install': {
    candidateIdentity: GameProfileIdentityV1; stableIdentity: GameProfileIdentityV1
    profileStateRevision: number
  }
  'profile.activate': {
    activationId: string; stableIdentity: GameProfileIdentityV1
    previousStableIdentity: GameProfileIdentityV1
    profileStateRevision: number
    pveReconciliation: {
      aggregateSetSha256: `sha256:${string}`
      preservedRunIds: string[]; clearedRunIds: string[]; tombstoneCount: number
    }
  }
  'profile.rollback': {
    activationId: string; rollbackTarget: 'previous-stable' | 'bundled-base'
    stableIdentity: GameProfileIdentityV1
    previousStableIdentity: GameProfileIdentityV1
    profileStateRevision: number
    pveReconciliation: {
      aggregateSetSha256: `sha256:${string}`
      preservedRunIds: string[]; clearedRunIds: string[]; tombstoneCount: number
    }
  }
  'app-update.check': UpdateCheckResultV1
  'app-update.prepare': {
    preparedReleaseId: `sha256:${string}`
    updateBundle: VerifiedArtifactResultV1
    runtimeCatalog: VerifiedArtifactResultV1
    releaseRecordSha256: `sha256:${string}`
    signatureRecordSha256: `sha256:${string}`
    keysetRecordSha256: `sha256:${string}`
    artifactSetSha256: `sha256:${string}`
    verifiedMarkerSha256: `sha256:${string}`
  }
  'app-update.apply': {
    releaseId: `sha256:${string}`; previousReleaseId: `sha256:${string}`
    preUpdateBackupId: string
    previousArtifactSetSha256: `sha256:${string}`
    dataGenerationId: string; serviceIntent: ServiceIntentV1
  }
  'app-update.rollback': {
    releaseId: `sha256:${string}`; restoredBackupId: string | null
    dataGenerationId: string; activatedProfileIdentity: GameProfileIdentityV1
    serviceIntent: ServiceIntentV1
  }
  'diagnostics.export': {
    artifactId: string; displayName: string; byteLength: number
    sha256: `sha256:${string}`
  }
}

type OperationResultV1 = {
  [K in OperationKindV1]: { kind: K } & OperationResultByKindV1[K]
}[OperationKindV1]
type OperationResultForV1<K extends OperationKindV1> =
  Extract<OperationResultV1, { kind: K }>

interface OperationPhaseNameByKindV1 {
  'server.start':
    | 'accepted' | 'reconcile-absence' | 'acquire-data-root-lock'
    | 'spawn-child' | 'management-ready' | 'profile-recovery'
    | 'health-gates' | 'commit-state'
  'server.stop':
    | 'accepted' | 'enter-maintenance' | 'drain' | 'shutdown-ack'
    | 'wait-process-exit' | 'commit-state'
  'server.force-stop':
    | 'accepted' | 'terminate-process-tree' | 'verify-absence' | 'commit-state'
  'server.restart':
    | 'accepted' | 'enter-maintenance' | 'drain' | 'shutdown-ack'
    | 'wait-process-exit' | 'spawn-child' | 'profile-recovery'
    | 'health-gates' | 'commit-state'
  'maintenance.enter':
    | 'accepted' | 'set-existing-only' | 'drain-accepted-ingress'
    | 'drain-accepted-pve-ingress' | 'collect-blockers' | 'commit-state'
  'maintenance.drain':
    | 'accepted' | 'wait-room-leases' | 'wait-pve-battles' | 'set-closed'
    | 'drain-accepted-ingress' | 'drain-accepted-pve-ingress'
    | 'close-authority-ingress' | 'close-pve-ingress'
    | 'drain-journal' | 'verify-watermarks' | 'verify-pve-store' | 'commit-state'
  'maintenance.exit':
    | 'accepted' | 'validate-drain-revision' | 'health-gates'
    | 'durable-open-intent' | 'open-admission' | 'commit-state'
  'room.cleanup':
    | 'accepted' | 'revalidate-plan' | 'verify-backup'
    | 'delete-rooms' | 'verify-durable-receipts' | 'commit-result'
  'backup.create':
    | 'accepted' | 'preflight' | 'stop-writer' | 'sqlite-online-backup'
    | 'snapshot-pve-store' | 'write-partial' | 'verify' | 'verify-pve-store'
    | 'write-completed-marker'
    | 'commit-final' | 'retention'
  'backup.restore':
    | 'accepted' | 'enter-maintenance' | 'drain' | 'shutdown-ack'
    | 'verify-absence' | 'acquire-data-root-lock' | 'preflight'
    | 'create-pre-restore-backup' | 'bootstrap-identity' | 'bootstrap-profile'
    | 'stage-generation' | 'verify-continuity' | 'migrate'
    | 'install-profile-candidate' | 'profile-activation-plan'
    | 'candidate-health' | 'commit-intent' | 'atomic-commit'
    | 'profile-activation-commit' | 'committed-health'
    | 'reopen-or-hold' | 'automatic-rollback' | 'reconcile'
  'profile.install':
    | 'accepted' | 'resolve-import-token' | 'read-archive'
    | 'install-candidate' | 'verify-candidate' | 'commit-result'
  'profile.activate':
    | 'accepted' | 'activation-plan' | 'presentation-refresh'
    | 'authority-restart' | 'candidate-server-health'
    | 'candidate-websocket-health' | 'activation-commit' | 'pve-authority-reconcile'
    | 'renderer-reload' | 'activation-release'
    | 'commit-reconcile' | 'profile-rollback'
  'profile.rollback':
    | 'accepted' | 'select-rollback-candidate' | 'activation-plan'
    | 'presentation-refresh' | 'authority-restart'
    | 'candidate-server-health' | 'candidate-websocket-health'
    | 'activation-commit' | 'pve-authority-reconcile' | 'renderer-reload' | 'activation-release'
    | 'commit-reconcile' | 'profile-rollback'
  'app-update.check':
    | 'accepted' | 'resolve-keyset' | 'verify-keyset'
    | 'resolve-manifest' | 'verify-manifest'
    | 'commit-trust-high-water' | 'commit-result'
  'app-update.prepare':
    | 'accepted' | 'preflight' | 'download-bundle' | 'verify-bundle'
    | 'download-catalog' | 'verify-catalog' | 'stage-artifact-set'
    | 'verify-artifact-set' | 'commit-prepared'
  'app-update.apply':
    | 'accepted' | 'preflight' | 'maintenance' | 'drain' | 'backup'
    | 'cleanup' | 'stage-release' | 'stage-data' | 'migrate'
    | 'candidate-health' | 'commit-intent' | 'atomic-commit'
    | 'committed-health' | 'reopen-or-hold' | 'retain-rollback'
    | 'automatic-rollback' | 'reconcile'
  'app-update.rollback':
    | 'accepted' | 'preflight' | 'maintenance' | 'drain'
    | 'verify-rollback-set' | 'activate-retained-profile'
    | 'stage-release' | 'stage-data' | 'restore-backup'
    | 'candidate-health' | 'commit-intent' | 'atomic-commit'
    | 'committed-health' | 'reopen-or-hold' | 'reconcile'
  'diagnostics.export':
    | 'accepted' | 'resolve-export-token' | 'collect'
    | 'redact' | 'verify' | 'commit-artifact'
}

type OperationPhaseV1 = {
  [K in OperationKindV1]: {
    kind: K; name: OperationPhaseNameByKindV1[K]
  }
}[OperationKindV1]
type OperationPhaseForV1<K extends OperationKindV1> =
  Extract<OperationPhaseV1, { kind: K }>

interface OperationProgressV1 {
  completed: number; total: number | null
  unit: 'steps' | 'rooms' | 'bytes' | 'files' | 'checks'
}

type OperationErrorCodeV1 =
  | 'IPC_SENDER_UNTRUSTED' | 'MANAGEMENT_LOOPBACK_REQUIRED'
  | 'MANAGEMENT_UNAUTHORIZED' | 'MANAGEMENT_API_VERSION_UNSUPPORTED'
  | 'METHOD_NOT_ALLOWED' | 'MANAGEMENT_PAYLOAD_TOO_LARGE'
  | 'MANAGEMENT_MEDIA_TYPE_UNSUPPORTED' | 'CHILD_INSTANCE_MISMATCH'
  | 'INVALID_REQUEST' | 'INVALID_COMMAND' | 'OPERATION_ID_REUSE'
  | 'OPERATION_NOT_FOUND' | 'OPERATION_RESULT_EXPIRED'
  | 'OPERATION_IN_PROGRESS' | 'OPERATION_NOT_CANCELLABLE' | 'OPERATION_CANCELLED'
  | 'STATE_REVISION_MISMATCH' | 'STATE_STALE' | 'INVALID_STATE_TRANSITION'
  | 'APPROVAL_REQUIRED' | 'APPROVAL_EXPIRED' | 'APPROVAL_CANCELLED'
  | 'ROOM_CURSOR_STALE' | 'ROOM_NOT_FOUND'
  | 'PROCESS_NOT_RUNNING' | 'PROCESS_SPAWN_FAILED' | 'PROCESS_START_TIMEOUT'
  | 'PROCESS_EXIT_TIMEOUT' | 'HEALTH_CHECK_FAILED' | 'RELEASE_IDENTITY_MISMATCH'
  | 'PROCESS_TREE_NOT_ABSENT' | 'PORT_NOT_RELEASED' | 'WRITER_ALREADY_ACTIVE'
  | 'DATA_ROOT_LOCKED' | 'DB_SCHEMA_INCOMPATIBLE'
  | 'ENGINE_ABI_MISMATCH' | 'RUNNER_REVISION_MISMATCH' | 'ROLLBACK_REQUIRED'
  | 'ADMISSION_FENCE_TIMEOUT' | 'ACTIVE_ROOM_BLOCKERS' | 'DRAIN_TIMEOUT'
  | 'DURABLE_DRAIN_FAILED' | 'ROOM_PERSISTENCE_DEGRADED'
  | 'ACTIVE_PVE_BATTLE_BLOCKERS' | 'PVE_DURABLE_DRAIN_FAILED'
  | 'PVE_RUN_STORE_INVALID' | 'PVE_SCHEMA_INCOMPATIBLE'
  | 'ROOM_CLEANUP_PLAN_STALE' | 'ROOM_CLEANUP_NOT_DURABLE'
  | 'BACKUP_NOT_FOUND' | 'BACKUP_VERIFICATION_FAILED'
  | 'BACKUP_SERVER_ID_MISMATCH' | 'BACKUP_SEASON_CONFLICT'
  | 'BACKUP_SCHEMA_INCOMPATIBLE' | 'BACKUP_CONTROL_CONTINUITY_MISSING'
  | 'BACKUP_OPERATION_RECEIPT_CONFLICT' | 'BACKUP_TRUST_HIGH_WATER_INVALID'
  | 'RESTORE_FAILED' | 'RESTORE_COMMIT_UNCERTAIN'
  | 'UPDATE_NOT_AVAILABLE' | 'UPDATE_CHANNEL_MISMATCH'
  | 'UPDATE_MANIFEST_INVALID' | 'UPDATE_SIGNATURE_INVALID'
  | 'UPDATE_AUTHENTICODE_INVALID' | 'UPDATE_PLATFORM_UNSUPPORTED'
  | 'UPDATE_INCOMPATIBLE' | 'UPDATE_DOWNGRADE_FORBIDDEN'
  | 'UPDATE_DISK_SPACE_INSUFFICIENT' | 'UPDATE_STAGE_FAILED'
  | 'UPDATE_MIGRATION_FAILED' | 'UPDATE_HEALTH_FAILED'
  | 'UPDATE_COMMIT_UNCERTAIN' | 'UPDATE_ROLLBACK_FAILED'
  | 'APP_UPDATE_PROFILE_INCOMPATIBLE'
  | 'PROFILE_STORE_BUSY' | 'PROFILE_STATE_INVALID' | 'PROFILE_CANDIDATE_MISSING'
  | 'PROFILE_ACTIVATION_MISMATCH' | 'PROFILE_SNAPSHOT_INCOMPLETE'
  | 'PROFILE_HASH_MISMATCH' | 'PROFILE_ROLLBACK_UNAVAILABLE'
  | 'PROFILE_IN_USE' | 'PROFILE_DURABLE_DRAIN_FAILED'
  | 'PINNED_PROFILE_UNAVAILABLE' | 'PROFILE_REQUIRED' | 'PROFILE_INVALID'
  | 'INTERNAL_ERROR'

interface OperationErrorDetailsV1 {
  serverId?: string; roomId?: string; roomIds?: string[]
  runId?: string; runIds?: string[]; battleId?: string
  operationId?: string; releaseId?: `sha256:${string}`; backupId?: string
  expectedStateRevision?: number; actualStateRevision?: number
  expectedChildInstanceId?: string; actualChildInstanceId?: string
  expectedHash?: `sha256:${string}` | Sha256HexV1
  actualHash?: `sha256:${string}` | Sha256HexV1
  blockerCount?: number; blockers?: MaintenanceBlockerV1[]
  deadlineAt?: string; version?: string; count?: number; limit?: number
}

interface OperationSnapshotBaseV1 {
  schemaVersion: 'rvb-server-operations/v1'
  operationId: string; commandHash: `sha256:${string}`
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  phaseSequence: number
  acceptedAt: string; startedAt: string | null; updatedAt: string
  overallDeadlineAt: string; phaseStartedAt: string | null
  phaseDeadlineAt: string | null; progressStallDeadlineAt: string | null
  compensationDeadlineAt: string | null; heartbeatAt: string
  progress: OperationProgressV1 | null
  cancellable: boolean; commitBoundary: 'not-reached' | 'committed' | 'uncertain'
  sourceStateRevision: number; sourceServiceIntent: ServiceIntentV1
  rollback: {
    required: boolean; attempted: boolean; succeeded: boolean | null
    backupId: string | null; previousReleaseId: string | null
  }
}

interface OperationErrorV1<K extends OperationKindV1 = OperationKindV1> {
  code: OperationErrorCodeV1; message: string; status: number; retryable: boolean
  phase: OperationPhaseForV1<K> | null; correlationId: string
  details: OperationErrorDetailsV1
}

type OperationSnapshotV1 = {
  [K in OperationKindV1]:
    & OperationSnapshotBaseV1
    & {
      kind: K; phase: OperationPhaseForV1<K>
      result: OperationResultForV1<K> | null
      error: OperationErrorV1<K> | null
    }
}[OperationKindV1]

type OperationResponseV1 =
  | {
      schemaVersion: 'rvb-server-operations/v1'; ok: true
      requestId: string; stateRevision: number; operation: OperationSnapshotV1
    }
  | {
      schemaVersion: 'rvb-server-operations/v1'; ok: false
      requestId: string; stateRevision: number; operationId: string | null
      error: OperationErrorV1
    }

interface CancelOperationRequestV1 {
  schemaVersion: 'rvb-server-operations/v1'
  requestId: string; operationId: string; expectedStateRevision: number
}
```

`sourceServiceIntent` 对每个 accepted operation 都必填：source lifecycle ready/stopped 分别映射
ready/stopped，maintenance/degraded/failed/rollback-required 映射 maintenance；starting/draining/
stopping/updating 中接受的控制 operation 继承当前 active operation 已 durable 的值。lifecycle-neutral
operation 也记录但不消费该值。它与 `sourceStateRevision` 在 accept record 同次 durable 写入。

Arguments、result、phase、error details 与 nested branch 全部
`additionalProperties:false`；`result.kind`、`phase.kind` 和 `error.phase.kind` 必须与
snapshot.kind 一致。accepted/running 的 result 与 error 必须为 null；succeeded 必须有完整 result
且 error 为 null；failed/cancelled 必须有 error，除 room.cleanup 可用完整同-kind result 报告已经
durable 的部分 receipts 外 result 为 null。message 最多 512 Unicode scalar；details 中 roomIds
去重且最多 500，禁止用未列字段塞 raw object。

各 kind 的 phase 只按声明顺序前进；precondition 允许跳过的 phase（例如 empty-root 没有
pre-restore backup、无 cleanup plan）必须以 durable phaseSequence 跳号记录，不能发明新名称。只有
`automatic-rollback`、`reconcile` 或 `profile-rollback` 可进入对应恢复路径。phaseSequence 在该
phase 首个副作用前 durable 增加，不能回退或把同一 sequence 复用于不同 phase。

accept record 在副作用前 durable；phase intent 在进入 phase 前 durable；commit result 在 success
response 前 durable。restart 依据 ledger + deployment pointer + generation + PID + release identity
reconcile，不能猜。renderer acceptance timeout 为 10 秒，只表示 response unknown，不取消 operation；
必须用原 operationId query/retry。Cancel 仅在 cancellable 且 commitBoundary=not-reached 时允许；必须
等待底层 I/O/process 已停止，不能留下后台写入。

固定 timeout：IPC 10 秒；child RPC 30 秒；spawn + management-ready 20 秒；WS health 5 秒；
accepted-ingress fence 10 秒；room drain 默认 60 秒、可 1–600 秒；restart 内 drain 只可 1–120 秒；
final durable shutdown ACK 6.5 秒；ACK 后 process-tree exit 5 秒；room cleanup 5 分钟；backup 10 分钟；
restore forward 45 分钟；Profile install
5 分钟；activate/rollback 2 分钟；update prepare 30 分钟且 60 秒无 byte/heartbeat 为 stall；
verify/stage 5 分钟；migration 10 分钟；candidate health 90 秒；commit/reconcile 30 秒；rollback
20 分钟；explicit app rollback 30 分钟；diagnostics 5 分钟/单包 100 MiB。timeout 只由 owner adapter
判定，renderer timer 不取消。

`overallDeadlineAt` 在 accept record 时固定，phase/retry/heartbeat/restart 都不能延长；restart 从
ledger 恢复原值。每个 precommit phase 的 `phaseDeadlineAt =
min(overallDeadlineAt, phaseStartedAt + phase cap)`，overall 先到即安全停止且不得进入下一 mandatory
phase。Download heartbeat 只能推进 `progressStallDeadlineAt`，且不能越过 phase/overall deadline。
commitBoundary 一旦 committed，forward timeout 不能取消 recovery；coordinator 设置独立
`compensationDeadlineAt = recovery start + 20 minutes` 完成 exact rollback/reconcile，超时才进入
rollback-required。Restart 的 180 秒 overall 含最多 120 秒 drain、ACK/exit 与 20 秒 start；参数超限
strict reject。Restore/update apply 的 45 分钟 forward cap 包含其所有 mandatory phase，自动 rollback
的 20 分钟不计入 forward cap。

稳定错误码：

- trust：`IPC_SENDER_UNTRUSTED`、`MANAGEMENT_LOOPBACK_REQUIRED`、
  `MANAGEMENT_UNAUTHORIZED`、`MANAGEMENT_API_VERSION_UNSUPPORTED`、`METHOD_NOT_ALLOWED`、
  `MANAGEMENT_PAYLOAD_TOO_LARGE`、`MANAGEMENT_MEDIA_TYPE_UNSUPPORTED`、
  `CHILD_INSTANCE_MISMATCH`；
- envelope：`INVALID_REQUEST`、`INVALID_COMMAND`、`OPERATION_ID_REUSE`、
  `OPERATION_NOT_FOUND`、`OPERATION_RESULT_EXPIRED`、`OPERATION_IN_PROGRESS`、
  `OPERATION_NOT_CANCELLABLE`、`OPERATION_CANCELLED`；
- state：`STATE_REVISION_MISMATCH`、`STATE_STALE`、`INVALID_STATE_TRANSITION`、
  `APPROVAL_REQUIRED`、`APPROVAL_EXPIRED`、`APPROVAL_CANCELLED`、`ROOM_CURSOR_STALE`、
  `ROOM_NOT_FOUND`；
- process：`PROCESS_NOT_RUNNING`、`PROCESS_SPAWN_FAILED`、`PROCESS_START_TIMEOUT`、
  `PROCESS_EXIT_TIMEOUT`、`HEALTH_CHECK_FAILED`、`RELEASE_IDENTITY_MISMATCH`、
  `PROCESS_TREE_NOT_ABSENT`、`PORT_NOT_RELEASED`、`WRITER_ALREADY_ACTIVE`、
  `DATA_ROOT_LOCKED`、`DB_SCHEMA_INCOMPATIBLE`、`ROLLBACK_REQUIRED`；
- maintenance：`ADMISSION_FENCE_TIMEOUT`、`ACTIVE_ROOM_BLOCKERS`、`DRAIN_TIMEOUT`、
  `DURABLE_DRAIN_FAILED`、`ROOM_PERSISTENCE_DEGRADED`、`ROOM_CLEANUP_PLAN_STALE`、
  `ROOM_CLEANUP_NOT_DURABLE`、`ACTIVE_PVE_BATTLE_BLOCKERS`、
  `PVE_DURABLE_DRAIN_FAILED`、`PVE_RUN_STORE_INVALID`、`PVE_SCHEMA_INCOMPATIBLE`；
- backup：`BACKUP_NOT_FOUND`、`BACKUP_VERIFICATION_FAILED`、`BACKUP_SERVER_ID_MISMATCH`、
  `BACKUP_SEASON_CONFLICT`、`BACKUP_SCHEMA_INCOMPATIBLE`、
  `BACKUP_CONTROL_CONTINUITY_MISSING`、`BACKUP_OPERATION_RECEIPT_CONFLICT`、
  `BACKUP_TRUST_HIGH_WATER_INVALID`、`RESTORE_FAILED`、`RESTORE_COMMIT_UNCERTAIN`；
- update：`UPDATE_NOT_AVAILABLE`、`UPDATE_CHANNEL_MISMATCH`、`UPDATE_MANIFEST_INVALID`、
  `UPDATE_SIGNATURE_INVALID`、`UPDATE_AUTHENTICODE_INVALID`、`UPDATE_PLATFORM_UNSUPPORTED`、
  `UPDATE_INCOMPATIBLE`、`UPDATE_DOWNGRADE_FORBIDDEN`、`UPDATE_DISK_SPACE_INSUFFICIENT`、
  `UPDATE_STAGE_FAILED`、`UPDATE_MIGRATION_FAILED`、`UPDATE_HEALTH_FAILED`、
  `UPDATE_COMMIT_UNCERTAIN`、`UPDATE_ROLLBACK_FAILED`、`APP_UPDATE_PROFILE_INCOMPATIBLE`；
- exact reuse：RED-115/116 的 `ENGINE_ABI_MISMATCH`、`RUNNER_REVISION_MISMATCH`、
  `PROFILE_STORE_BUSY`、`PROFILE_STATE_INVALID`、
  `PROFILE_CANDIDATE_MISSING`、`PROFILE_ACTIVATION_MISMATCH`、`PROFILE_SNAPSHOT_INCOMPLETE`、
  `PROFILE_HASH_MISMATCH`、`PROFILE_ROLLBACK_UNAVAILABLE`、`PROFILE_IN_USE`、
  `PROFILE_DURABLE_DRAIN_FAILED`、`PINNED_PROFILE_UNAVAILABLE`、`PROFILE_REQUIRED` 与
  `PROFILE_INVALID`；fallback：`INTERNAL_ERROR`。

`ENGINE_ABI_MISMATCH` 与 `RUNNER_REVISION_MISMATCH` 必须逐字复用 RED-116，HTTP/IPC status
固定 409，且在任何 Profile、PVE、release、pointer、operation phase 或 data 写入前返回，保证零副作用；
不得折叠为 `UPDATE_INCOMPATIBLE`、`PROFILE_INVALID` 或 message-only 失败。

`LOG_SINK_FAILED` 是稳定 warning code，不把原业务错误改写为成功或替换其 error code。

message 不稳定；控制流只看 code。details 只能使用 `OperationErrorDetailsV1` 的命名字段，禁止
secret、raw path、URL credential、archive/DB 或 stack。HTTP adapter 使用
400/401/403/404/405/409/410/412/413/415/423/503/504/500；IPC 保留同一 status。

## 6. 全部 mutation command

所有命令先检查 trusted Dashboard main frame、strict schema、fresh revision、single-flight。标“native
approval”的 operation 由 Electron main native dialog 签发 one-use challenge，绑定 commandHash，
5 分钟过期；renderer checkbox 不算批准。各命令都使用第 5 节相同的 operation 幂等语义。

| Command | Owner / 授权 | 前置条件 | Timeout 与成功结果 | 失败状态与回退 |
| --- | --- | --- | --- | --- |
| `server.start {}` | Electron main / trusted IPC | stopped，或 child absent 的 maintenance；failed 必须先用 server.stop durable 证明 absence 并进入 stopped；必须证明完整 process tree、player/management ports 与 DB writer absent，并取得唯一 data-root lock；非 rollback-required | 20 秒；childInstanceId/releaseId/serviceIntent；stopped -> ready，maintenance -> starting -> maintenance 并保持 closed | 任一 absence/lock 证明失败零 spawn；清理失败 child；failed/maintenance；data/release 不变 |
| `server.stop {drainTimeoutMs?}` | main + persistence / trusted IPC | starting/ready/maintenance/degraded，或已证明 absence 的 failed；rollback-required/updating 与已有 drain/stop operation 不接受新 stop；active op 先合法 cancel | drain + 6.5 秒 ACK + 5 秒退出；durable/exitCode；stopped | drain/ACK 未确认不强杀，degraded/closed；残余 tree -> failed |
| `server.force-stop {acknowledgeUndurableTailLoss:true}` | main / native approval | process present；可中断 operation | 5 秒；processAbsent/undurableTailLossPossible；commit/deployment 确定且非 rollback-required 时 -> stopped；rollback-required 保持原状态 | 残余 tree -> failed；中断或 deployment commit 不确定 -> rollback-required；无 data rollback |
| `server.restart {drainTimeoutMs?:1000..120000}` | main / trusted IPC | ready/degraded/maintenance；非 rollback-required；failed 必须先用 server.stop 进入 stopped 后单独 start | 180 秒 overall；old/new child ID + durable receipt | durable stop 失败不启动；start 失败 -> failed；不切 release/Profile |
| `maintenance.enter {reason}` | main + child fence / trusted IPC | ready/degraded/stopped | 10 秒；admission/fenceId，room/PVE accepted ingress 与 blockers | fence write 失败零转换；任一 ingress timeout 保持 maintenance + blocker |
| `maintenance.drain {timeoutMs?}` | main + RoomRuntime/persistence/PVE Run Store / trusted IPC | maintenance | 默认 60 秒；drainRevision、room watermarks、PVE receipt、两类 pending=0 | room/PVE timeout -> maintenance/existing-only；可证明 integrity/唯一 writer 的 transient journal/PVE unavailable -> degraded/closed；corrupt/集合不完整/无可信 writer -> failed/closed |
| `maintenance.exit {}` | all health owners / trusted IPC | maintenance + running + valid room/PVE drainRevision + no blocker | 10 秒；release/Profile/PVE aggregate set；ready/open | 任 gate 失败保持 maintenance/closed，不部分开放 |
| `room.cleanup {planId,planHash,backupId,acknowledgeIrreversible:true}` | child 执行、main 协调 / native approval | maintenance + valid drain；cleanupEpoch/fingerprint 未变；verified backup manifest 覆盖 exact plan | 5 分钟；deleted/alreadyAbsent IDs + receipts | 已 commit 项保留，未提交不动；maintenance；只能 restore 回退 |
| `backup.create {label?,cleanupPlanId?,cleanupPlanHash?}` | main backup adapter / trusted IPC | maintenance + valid room/PVE drain；DB/Profile/PVE/season 可 strict 读；coverage 两字段同时出现并指向有效 plan | 10 分钟；backupId/manifestHash/bytes/verifiedAt/cleanupCoverage/PVE aggregate set | 删除 partial；live 与 lastVerified 不变 |
| `backup.restore {backupId}` | main restore / native approval | stopped/maintenance/failed/rollback-required；maintenance 源先在同 operation normal drain/stop；任何 restore stage/Profile/pointer mutation 前逐字证明 process tree、player/management ports、DB writer、PVE writer/ingress 全 absent/quiesced，并取得唯一 data-root lock；identity/season/DB/PVE schema compatible | 45 分钟 forward；preRestoreBackupId|null/generation/active Profile/serviceIntent | absence/lock 失败返回 `PROCESS_TREE_NOT_ABSENT`/`PORT_NOT_RELEASED`/`WRITER_ALREADY_ACTIVE`/`DATA_ROOT_LOCKED` 且零 stage/Profile/pointer mutation；existing-root postcommit 自动回切；empty-root postcommit -> rollback-required/closed；不确定保留 evidence |
| `profile.install {importToken}` | RED-115 core / trusted IPC | ready/maintenance；无 activation；native picker one-use token | 5 分钟；candidate identity；stable unchanged | 按 RED-115 原子失败；不改 app/DB pointer |
| `profile.activate {targetResolvedProfileHash}` | RED-115 core / trusted IPC | ready/maintenance；fence 后无 room 或 active PVE battle lease；candidate verified；RED-117 reconciliation 可执行 | 2 分钟；activationId/stable/previousStable/PVE reconciliation evidence | RED-115 recovery/rollback；durable room/PVE drain 或 reconciliation fail 保持 closed |
| `profile.rollback {target}` | RED-115 core / native approval | target 仅 previous-stable/bundled-base；其余同 activate | 2 分钟；activation receipt | 必须走 RED-115 candidate/health/commit，禁止手改 pointer |
| `app-update.check {}` | main release verifier + coordinator / trusted IPC | 任意非 rollback-required state；fixed channel；只在更新页打开或服主点击时提交 | 30 秒；verified metadata/no-update + continuity trust high-water/stateRevision | 签名/channel/replay 错误零 trust 写；不下载 artifact、不改 lifecycle/admission |
| `app-update.prepare {releaseId}` | main + provider / trusted IPC | 仅 stopped/ready/maintenance/degraded；无 active operation；fixed channel；不低于 current；签名/platform/API/Profile/DB/PVE schema 初始 gate | 30 分钟且 60 秒 stall；完整 verified artifact-set marker/hash/verifiedAt；lifecycle 不变 | 只删 incomplete cache；任一不完整则整个 set 不可 apply；不 maintenance、不执行 |
| `app-update.apply {preparedReleaseId,cleanupPlanId?,cleanupPlanHash?}` | main updater / native approval | ready/maintenance/degraded/stopped；非 rollback-required；完整 artifact-set/bytes reverify；disk budget；current Profile 与 DB/PVE schema 同时兼容 target 和 exact previous；cleanup 字段同时有/无，有则 maintenance + valid plan | 45 分钟 forward；release/previous artifact-set hash/backup/generation/serviceIntent | precommit 回原安全态；postcommit 20 分钟 exact rollback；不确定 -> rollback-required |
| `app-update.rollback {targetReleaseId}` | main updater / native approval | ledger exact previous；artifact-set hash/backup/generation/profileRequirement/DB/PVE schema reverify；maintenance/stopped/rollback-required | 30 分钟；release/restoredBackup/generation/activatedProfile | Profile 激活或 binary/data precommit 失败不切 deployment；atomic pointer 后 committed-health 失败明确进入 rollback-required/closed/no-writer，不猜测切回 rollback 前 source deployment；其他不确定同样保持 rollback-required；旧 binary 不开新 DB/PVE Store |
| `diagnostics.export {exportToken,includeRoomIds?}` | main diagnostics / trusted IPC | 任意状态；native save one-use token | 5 分钟/100 MiB；artifactId/displayName/bytes/hash | 删除 partial；不改 lifecycle；严格脱敏 |

正常 stop 不自动 fallback force-stop；tail-loss acknowledgement 不得由 config、CLI 或默认 key 代替。
Cleanup plan 是 exact room set/hash 的只读 query，30 分钟过期并绑定独立 cleanupEpoch 与
roomSelectionFingerprint，不以全局 stateRevision 作为后续有效性。只允许清理无 Profile lease、
journal durable、terminal/ranking 都 durable 的 room，或 never-started empty room；backup manifest
必须显式记录 exact plan coverage。app update 不激活 Profile；candidate 必须用 current stable
Profile 完成 health。ABI-breaking upgrade 必须先发 dual-compatible transitional app，不能一次
atomic commit 暗换 binary + Profile。

App apply 在 commit-intent 前从 RED-115 真源重读 current stable Profile，证明它同时兼容 target 与
exact previous，并把 immutable identity、Profile Store revision、payload/package closure 和
retentionUntil 固定进 previous rollback set；该引用至少 90 天或直到不再是 previous，期间禁止 GC。
后续任意 Profile 激活仍只切 RED-115 pointer，不改 deployment，也不要求新 Profile 兼容旧 app，因为
previous 所需 Profile 已被 pin。App rollback 若发现 current stable 不等于 profileRequirement，必须先在
closed maintenance 中通过 RED-115 candidate/health/commit pipeline 激活 retained Profile；不得直接改
`active.json`。Profile 激活失败时 deployment pointer 不切；之后 binary precommit 失败则用 RED-115
previousStable 恢复 rollback 前 Profile，恢复也失败时保持 maintenance/closed 并显式失败。

## 7. IPC 与 loopback management adapter

Preload 只暴露 `serverOperationsV1`：

```ts
interface ServerOperationsPreloadV1 {
getState(): Promise<ServerOperationsStateV1>
execute(command: OperationCommandV1): Promise<OperationResponseV1>
cancel(request: CancelOperationRequestV1): Promise<OperationResponseV1>
getOperation(operationId: string): Promise<OperationSnapshotV1>
listRooms(query: RoomListQueryV1): Promise<RoomListResultV1>
getRoom(query: RoomGetQueryV1): Promise<RoomRuntimeInspectionV1>
listBackups(): Promise<BackupRecordSummaryV1[]>
checkUpdates(
  command: Extract<OperationCommandV1, { kind: 'app-update.check' }>
): Promise<OperationResponseV1>
planCleanup(query: CleanupPlanQueryV1): Promise<CleanupPlanV1>
approve(challenge: ApprovalChallengeRequestV1): Promise<ApprovalChallengeV1>
subscribe(listener: (stateRevision: number) => void): () => void
}
```

查询、计划和批准对象固定为：

```ts
interface RoomListQueryV1 {
  expectedStateRevision: number; limit: number; cursor: string | null
  lifecycle?: RoomRuntimeInspectionV1['roomLifecycle']
  persistence?: 'durable' | 'pending' | 'degraded'
}
interface RoomGetQueryV1 {
  expectedStateRevision: number; roomId: string
}
interface RoomListResultV1 {
  schemaVersion: 'rvb-server-operations/v1'; stateRevision: number
  rooms: RoomRuntimeInspectionV1[]; nextCursor: string | null
}
interface UpdateCheckResultV1 {
  schemaVersion: 'rvb-server-operations/v1'; checkedAt: string
  channel: 'stable' | 'candidate'; currentReleaseId: `sha256:${string}`
  available: ReleaseIdentityV1 | null
  trustHighWater: ReleaseTrustHighWaterV1
}
interface CleanupPlanQueryV1 {
  expectedStateRevision: number
  include: Array<'never-started-empty' | 'durable-finished'>
}
interface CleanupPlanV1 {
  schemaVersion: 'rvb-server-operations/v1'; planId: string
  planHash: `sha256:${string}`; observedStateRevision: number; cleanupEpoch: number
  createdAt: string; expiresAt: string
  roomSelectionFingerprint: `sha256:${string}`
  rooms: Array<{
    roomId: string; reason: 'never-started-empty' | 'durable-finished'
    authorityEpoch: number; durableAuthorityVersion: number
    terminalSettlementKey: string | null
  }>
}
type ApprovalChallengeRequestV1 = {
  [K in NativeApprovalOperationKindV1]: {
    schemaVersion: 'rvb-server-operations/v1'; requestId: string
    command: {
      operationId: string; kind: K; expectedStateRevision: number
      arguments: OperationArgumentsByKindV1[K]
    }
  }
}[NativeApprovalOperationKindV1]
interface ApprovalChallengeV1 {
  schemaVersion: 'rvb-server-operations/v1'
  challengeId: string; operationId: string
  commandHash: `sha256:${string}`; expiresAt: string; consumed: boolean
}
```

`roomSelectionFingerprint = SHA256(JCS(rooms))`，其中 rooms 按 roomId UTF-8 bytes 排序且字段严格等于
`CleanupPlanV1.rooms`；`planHash = SHA256(JCS({schemaVersion,planId,observedStateRevision,
cleanupEpoch,createdAt,expiresAt,roomSelectionFingerprint,rooms}))`。cleanupEpoch 是 RoomRuntime durable
monotonic counter，只在房间集合/生命周期、lease、authority/durable/terminal/ranking watermark 或
cleanup eligibility 改变时递增。普通 operation ledger、backup 写入、lifecycle/stateRevision 和同一
app-update 自身 phase 变化不递增；执行 cleanup 前仍须重算 exact fingerprint，任一变化返回
`ROOM_CLEANUP_PLAN_STALE`。

Covered backup、room.cleanup 或带 plan 的 app-update.apply 必须在 `expiresAt` 前 durable accept；
accept record 把 exact planId/hash/epoch/fingerprint 固定到该 operation 的 overallDeadlineAt，之后原
wall-clock expiry 不会中途取消同一 operation，但 cleanup-relevant change 仍立即使它 stale。Standalone
backup 结束后并不续期 plan；后续 room.cleanup 仍须在原 expiresAt 前 accept，否则零删除并重新计划。

固定 IPC channel 前缀为 `rvb-server-operations:v1:`，后缀为 `get-state`、`execute`、`cancel`、
`get-operation`、`list-rooms`、`get-room`、`list-backups`、`check-updates`、`plan-cleanup`、
`approve`、`state-changed`。每个 handler 在解析参数前执行 ADR-0002 的 exact BrowserWindow、
main frame 与 trusted URL 检查。event 只携带 revision；丢失/跳过时重新 getState，renderer 不从
event patch 自建权威状态。preload 不暴露 raw `ipcRenderer`、capability、process、path 或 fetch。

只读与控制表面也不得自行发明行为：

| 调用 | Owner / 授权 | 前置与幂等 | Timeout / 可观察结果 | 失败行为 |
| --- | --- | --- | --- | --- |
| `getState` | Electron main / trusted IPC | 任意状态；纯读，可重复 | 10 秒；完整 state + revision/staleness | 返回 stable error；不改变状态 |
| `getOperation` | operation ledger / trusted IPC | 合法 operationId；纯读 | 10 秒；snapshot 或 expired/not-found | 不重放副作用 |
| `listRooms` / `getRoom` | child RoomRuntime adapter / trusted IPC + capability | child 可用；cursor 绑定 revision；纯读 | child RPC 30 秒；inspection/cursor | stale cursor 或 child stale 显式失败，不读 raw DB 替代 |
| `listBackups` | main backup registry / trusted IPC | 任意状态；只列 verified marker | 10 秒；脱敏 backup summaries | 损坏项隔离并报告，不把 partial 当 backup |
| `checkUpdates` | main coordinator / trusted IPC | 只是 `app-update.check` 的 typed wrapper；完整 operation/revision/idempotency；不下载 artifact | acceptance 10 秒，operation 30 秒；OperationResponse + durable high-water | 与 execute 同一 ledger/single-flight；无旁路写入 |
| `planCleanup` | RoomRuntime + backup registry / trusted IPC | maintenance + valid drain；query revision 只防陈旧读取；计划绑定 cleanupEpoch/fingerprint | 30 秒；30 分钟有效 planId/hash/exact room set | cleanup-relevant change；不删除 |
| `approve` | Electron main native dialog / trusted IPC | 完整 unsigned command strict 解析；main 自算 hash；不接受 renderer 提供的 hash；同 challenge 只能消费一次 | 5 分钟有效；显示 action-specific 参数/影响，返回 challengeId/hash/expiry | cancel/expire 返回稳定错误；不接受 operation、不执行目标 command |
| `cancel` | Electron main coordinator / trusted IPC | active operation、cancellable、commit 未到 | acceptance 10 秒；durable cancelled/failed snapshot | not-cancellable 显式拒绝；不凭 renderer timeout 杀后台 I/O |
| `subscribe` | Electron main / trusted IPC sender | trusted current window；订阅可重复解除 | event 仅 stateRevision | 跳号后调用 getState；event 不作权威 patch |

`approve` 的 native dialog 必须从 strict-parsed command 自己渲染 kind、目标 backup/release/room set、
数据损失窗口和不可逆影响，不显示 renderer 提供的自由文本。返回 challenge 同时绑定 operationId 与
main 计算的 commandHash；`execute` 必须精确匹配两者，并在 accept record 同一临界区一次性消费，
否则返回 approval stable error。仅创建/取消 challenge 没有业务副作用。

`checkUpdates` 不再是 pure read；它只把完整 `app-update.check` command 交给同一 coordinator，
没有第二条实现。验证完整 root-signed keyset 与 release manifest 后，operation 先创建新的 continuity
generation、提高对应 keysetVersion/releaseSequence/securityEpoch high-water 并原子提交
stateRevision，才返回 metadata。相同 operation replay 原结果；新的 check 看到低 keysetVersion
直接拒绝，看到相同 version 时只可复用 exact keysetRecordSha256，看到更高 version 才替换该 digest；
releaseSequence 同样是 lower reject、equal 只接受 exact releaseRecordSha256、higher 才替换 digest；
securityEpoch 可等于既有下限但不能降低。任何同-version/different-keyset、
same-sequence/different-release 或其他验证失败不得写 trust 状态。

每次 child start，main 生成 32 cryptographic random bytes 并编码为 unpadded base64url capability；只
留在当前 main/child 内存，不持久化、不发 renderer、不写日志。child 只 bind `127.0.0.1`、port 0
的独立 listener，禁止 `0.0.0.0`、`::` 或复用玩家端口。child 通过继承进程 IPC 报告
`management-ready` 的 childInstanceId、PID、port、releaseId；main 校验当前 child handle/PID/
identity 后才做 authenticated health。每次 restart 同时轮换 key 与 port，旧值失效。

每个 HTTP 请求先按真实 TCP peer 验证 `127.0.0.1`，再 constant-time 比较
`x-rvb-management-capability`。即使 key 正确，non-loopback 也返回
`MANAGEMENT_LOOPBACK_REQUIRED`；缺 key、长度错或 compare fail 统一 unauthorized，不泄露步骤。
listener 不实现 CORS preflight，不信任 Host、Origin、`X-Forwarded-For`，不接受 cookie、player
token、`x-admin-key`、`ROOM_ADMIN_KEY` 或静态 `admin-secret-key`。

固定 child adapter routes：

```text
GET  /v1/health
GET  /v1/state
POST /v1/admission
POST /v1/drain
GET  /v1/rooms
GET  /v1/rooms/{roomId}
POST /v1/rooms/cleanup
GET  /v1/profile
POST /v1/profile/install
POST /v1/profile/activate
POST /v1/profile/rollback
POST /v1/profile/recover
```

```ts
interface ChildReadResponseBaseV1 {
  schemaVersion: 'rvb-server-operations/v1'
  requestId: string; childInstanceId: string; observedAt: string
}
type ChildReadResponseV1<T> =
  | (ChildReadResponseBaseV1 & { ok: true; result: T })
  | (ChildReadResponseBaseV1 & { ok: false; error: OperationErrorV1 })

type ChildMutationEnvelopeV1<K extends OperationKindV1, A> = {
  [P in K]: {
    schemaVersion: 'rvb-server-operations/v1'
    requestId: string; operationId: string; operationKind: P
    commandHash: `sha256:${string}`
    phase: OperationPhaseForV1<P>; phaseSequence: number
    expectedStateRevision: number; expectedChildInstanceId: string
    arguments: A
  }
}[K]

type ChildMutationResponseV1<K extends OperationKindV1, T> = {
  [P in K]:
    | {
        schemaVersion: 'rvb-server-operations/v1'; ok: true
        disposition: 'completed'; requestId: string; operationId: string
        commandHash: `sha256:${string}`; childInstanceId: string
        phase: OperationPhaseForV1<P>; phaseSequence: number
        completedAt: string; result: T
      }
    | {
        schemaVersion: 'rvb-server-operations/v1'; ok: true
        disposition: 'running'; requestId: string; operationId: string
        commandHash: `sha256:${string}`; childInstanceId: string
        phase: OperationPhaseForV1<P>; phaseSequence: number
        retryAfterMs: number; progress: OperationProgressV1 | null
      }
    | {
        schemaVersion: 'rvb-server-operations/v1'; ok: false
        requestId: string; operationId: string; childInstanceId: string
        commandHash: `sha256:${string}`
        phase: OperationPhaseForV1<P>; phaseSequence: number
        error: OperationErrorV1<P>
      }
}[K]

interface ChildAdmissionStateV1 {
  mode: AdmissionModeV1; fenceId: string | null; reasonCode: StateReasonCodeV1 | null
  since: string; acceptedIngressPending: number; acceptedPveIngressPending: number
}
interface ChildHealthReportV1 {
  schemaVersion: 'rvb-server-operations/v1'
  childInstanceId: string; observedAt: string; releaseId: `sha256:${string}`
  profileIdentity: GameProfileIdentityV1
  overall: 'healthy' | 'degraded' | 'unhealthy'; checks: HealthCheckV1[]
}
interface ChildRuntimeObservationV1 {
  schemaVersion: 'rvb-server-operations/v1'
  childInstanceId: string; childRevision: number; observedAt: string
  releaseId: `sha256:${string}`; profileIdentity: GameProfileIdentityV1
  admission: ChildAdmissionStateV1
  persistence: {
    ingress: 'accepting' | 'quiescing' | 'closed'; pendingJobs: number
    roomsByStatus: { durable: number; pending: number; degraded: number }
  }
  rooms: {
    total: number; activeLeases: number; blockers: MaintenanceBlockerV1[]
  }
  pve: {
    source: 'rvb-pve-run-aggregate/v1'
    totalRuns: number; activeBattleCount: number
    activeBattleRunIds: string[]; activeBattleIds: string[]
    aggregateSetSha256: `sha256:${string}`
  }
  activeDelegation: {
    operationId: string; operationKind: OperationKindV1
    commandHash: `sha256:${string}`; phase: OperationPhaseV1
    phaseSequence: number; status: 'running' | 'completed' | 'failed'
    updatedAt: string
  } | null
}

interface ChildAdmissionArgumentsV1 {
  expected: { mode: AdmissionModeV1; fenceId: string | null }
  target: {
    mode: AdmissionModeV1; fenceId: string | null; reasonCode: StateReasonCodeV1
  }
  waitForAcceptedIngress: boolean
}
interface ChildAdmissionResultV1 {
  admission: ChildAdmissionStateV1
  activeProfileLeaseRoomIds: string[]; activeProfileLeasePveRunIds: string[]
}
interface RoomDrainReceiptV1 {
  roomId: string; authorityEpoch: number; authorityVersion: number
  durableAuthorityVersion: number; pendingJobs: 0
  terminalBarrierStatus:
    | 'not-terminal' | 'pending-durable' | 'durable' | 'degraded'
}
interface ChildDrainArgumentsV1 {
  expectedFenceId: string; deadlineAt: string
}
interface PveRunWatermarkV1 {
  runId: string; runRevision: number; authorityContentHash: Sha256HexV1
  activeBattleId: null; aggregateSha256: `sha256:${string}`
}
interface PveDrainReceiptV1 {
  source: 'rvb-pve-run-aggregate/v1'
  acceptedPveIngressPending: 0; activeBattleCount: 0
  runs: PveRunWatermarkV1[]; aggregateSetSha256: `sha256:${string}`
}
interface ChildDrainResultV1 {
  drainRevision: `sha256:${string}`; durableAt: string
  rooms: RoomDrainReceiptV1[]; pendingJobs: 0; pve: PveDrainReceiptV1
}
interface ChildRoomCleanupArgumentsV1 {
  drainRevision: `sha256:${string}`; planId: string; planHash: `sha256:${string}`
  backupId: string; roomIds: string[]; acknowledgeIrreversible: true
}

type ChildAdmissionOperationKindV1 =
  | 'server.start' | 'server.stop' | 'server.restart'
  | 'maintenance.enter' | 'maintenance.drain' | 'maintenance.exit'
  | 'backup.restore' | 'profile.activate' | 'profile.rollback'
  | 'app-update.apply' | 'app-update.rollback'
type ChildDrainOperationKindV1 =
  | 'maintenance.drain' | 'server.stop' | 'server.restart'
  | 'profile.activate' | 'profile.rollback'
  | 'app-update.apply' | 'app-update.rollback'
type ChildProfileRecoveryOperationKindV1 =
  | 'server.start' | 'server.restart' | 'profile.activate' | 'profile.rollback'
  | 'backup.restore' | 'app-update.apply' | 'app-update.rollback'
type ChildProfileInstallOperationKindV1 = 'profile.install' | 'backup.restore'
type ChildProfileActivateOperationKindV1 =
  | 'profile.activate' | 'profile.rollback' | 'backup.restore' | 'app-update.rollback'

type ChildProfileInstallBinaryMetadataV1 =
  | {
      source: 'native-import'; contentLength: number
      contentSha256: `sha256:${string}`; expectedIdentity?: never
    }
  | {
      source: 'verified-backup'; contentLength: number
      contentSha256: `sha256:${string}`; expectedIdentity: GameProfileIdentityV1
    }
interface ChildProfileInstallResultV1 {
  state: ProfileStateV1; candidate: ProfileReferenceV1
}
type ChildProfileActivateArgumentsV1 =
  | { action: 'plan'; targetResolvedProfileHash: Sha256HexV1 }
  | {
      action: 'rebind'; activationId: string
      targetResolvedProfileHash: Sha256HexV1
    }
  | {
      action: 'commit'; activationId: string
      targetResolvedProfileHash: Sha256HexV1
    }
  | {
      action: 'release'; activationId: string
      targetResolvedProfileHash: Sha256HexV1
    }
  | {
      action: 'record-failure'; activationId: string
      code: OperationErrorCodeV1
      stage:
        | OperationPhaseNameByKindV1['profile.activate']
        | OperationPhaseNameByKindV1['profile.rollback']
        | OperationPhaseNameByKindV1['backup.restore']
        | OperationPhaseNameByKindV1['app-update.rollback']
      message: string; keepAdmissionPaused: boolean
    }
type ChildProfileActivateResultV1 =
  | {
      action: 'plan'; activationId: string; reloadMode: ProfileReloadModeV1
      target: ProfileReferenceV1; stable: ProfileReferenceV1; profileRoot: string
    }
  | {
      action: 'rebind' | 'commit' | 'release' | 'record-failure'
      state: ProfileStateV1; server: ProfileServerReportV1 | null
    }
interface ChildProfileRollbackArgumentsV1 {
  target: 'previous-stable' | 'bundled-base'
}
interface ChildProfileRecoveryArgumentsV1 {
  keepAdmissionPaused: boolean
}
interface ChildProfileObservationV1 {
  state: ProfileStateV1; server: ProfileServerReportV1
}
```

`ChildRuntimeObservationV1.pve` 与 `activeProfileLeasePveRunIds` 必须在同一次 strict
`PveRunStoreV1` observation 中由 `getPveActiveBattleLeaseReportV1()` 产生，不能读取 state cache
或 UI 投影。`ChildDrainResultV1.rooms` 按 roomId、`pve.runs` 按 runId 的 UTF-8 bytes 排序并完整
覆盖 drain 时所有 room/active Run；count、watermark、aggregate hash 任一不匹配即
`PVE_DURABLE_DRAIN_FAILED`/对应 room drain error。外层 `maintenance.drain` operation result
必须原样包含这两份 receipt，不能只保留 count。
`PveRunWatermarkV1.authorityContentHash` 和全部
`targetResolvedProfileHash` 逐字复用 RED-115/116/117 Content Pipeline 的
`Sha256HexV1Schema` / `Sha256HexV1`：恰好 64 个 lowercase hex、无 `sha256:` 前缀。不得为了
运维 schema 转换格式；只有 RED-140 新计算的 release/artifact/operation/aggregate/file/manifest
digest 使用 prefixed `sha256:${string}`。

所有 child request/response branch 也是 `additionalProperties:false`。每个请求先要求
`x-rvb-management-capability`、`x-rvb-api-version: rvb-server-operations/v1`、
`x-rvb-request-id` 与 `x-rvb-child-instance-id`；header 与 body/query 中重复的值必须全等。
URL + query 最多 8 KiB；GET 不接受 body 或未列 query。JSON POST 固定
`Content-Type: application/json; charset=utf-8`，完整 body 就是对应 `ChildMutationEnvelopeV1`，
Content-Length 与实际 bytes 都不得超过 64 KiB；wrong method/media/version/size 分别返回
405/415/410/413 与稳定 code。

`POST /v1/profile/install` 是唯一 binary route：Content-Type 必须
`application/octet-stream`，Content-Length 1..32 MiB，拒绝 chunked；
`x-rvb-operation-envelope` 是最多 8 KiB 的 unpadded-base64url JCS
`ChildMutationEnvelopeV1<ChildProfileInstallOperationKindV1, ChildProfileInstallBinaryMetadataV1>`，body
length/hash 必须匹配。`profile.install` 只接受 `source=native-import`，importToken 只由 Electron main
解析为 native picker 选定的 bytes，绝不传给 child；`backup.restore` 只接受
`source=verified-backup`，其 expected identity 与 bytes 必须逐字匹配已重验 backup manifest。

Child phase 幂等 key 是 `(operationId, phaseSequence)`，phase payload hash 为
`SHA256(JCS({schemaVersion,operationId,operationKind,commandHash,phase,phaseSequence,
expectedStateRevision,expectedChildInstanceId,arguments}))`。同 key/同 hash replay 相同 running 或
durable completed result；同 key/不同 hash 返回 `OPERATION_ID_REUSE`。Transport retry 使用新
requestId，其余字段不变。Main 的全局 CAS 已在 accept 前完成；child 只核对 envelope 与 main 登记的
active delegation，不把 childRevision 当第二个全局 revision。

单次 child RPC 必须在 30 秒内返回。分钟级工作未完成时返回 HTTP 202 +
`disposition=running`（retryAfterMs safe integer 100..5000）；main 以上述同 phase payload 轮询，
不能创建新 child operation。完成返回 durable 200/201 result。所有 response 都是 JSON、
`Cache-Control: no-store`，不回显 capability；任何 error 使用同一个
`OperationErrorV1` envelope。

| Route | Strict request | Success | Route-specific error/status |
| --- | --- | --- | --- |
| `GET /v1/health` | 无 query/body | 200 `ChildReadResponseV1<ChildHealthReportV1>`；unhealthy 仍是 observation | 503 无法构造报告 |
| `GET /v1/state` | 无 query/body | 200 `ChildReadResponseV1<ChildRuntimeObservationV1>` | 503 child state 不可读 |
| `POST /v1/admission` | kind 属于 `ChildAdmissionOperationKindV1` + `ChildAdmissionArgumentsV1` | 200 completed / 202 running，`ChildAdmissionResultV1` | 409 transition；412 revision/fence stale；504 fence timeout |
| `POST /v1/drain` | kind 属于 `ChildDrainOperationKindV1` + `ChildDrainArgumentsV1` | 200 completed / 202 running，`ChildDrainResultV1` | 409/423 blocker/lease；503 degraded；504 durable timeout |
| `GET /v1/rooms` | exact `expectedStateRevision,limit,cursor,lifecycle?,persistence?` | 200 `ChildReadResponseV1<RoomListResultV1>` | 412 `ROOM_CURSOR_STALE`；503 stale |
| `GET /v1/rooms/{roomId}` | roomId 单次 percent-decode；exact `expectedStateRevision` | 200 `ChildReadResponseV1<RoomRuntimeInspectionV1>` | 404 `ROOM_NOT_FOUND`；503 stale |
| `POST /v1/rooms/cleanup` | kind 只能 room.cleanup + `ChildRoomCleanupArgumentsV1` | 200/202，`OperationResultForV1<'room.cleanup'>` | 409/412 stale plan；423 blocker；503 durability；504 timeout |
| `GET /v1/profile` | 无 query/body | 200 `ChildReadResponseV1<ChildProfileObservationV1>` | 503 report failed |
| `POST /v1/profile/install` | kind 属于 `ChildProfileInstallOperationKindV1` + 对应 source binary contract | 201/202，`ChildProfileInstallResultV1` | 400 invalid archive；413 size；415 media；423 busy；503/504 |
| `POST /v1/profile/activate` | kind 属于 `ChildProfileActivateOperationKindV1` + action union | 200/202，`ChildProfileActivateResultV1` | 404 candidate；409 lease；412 activation；423 busy；503/504 |
| `POST /v1/profile/rollback` | kind 只能 profile.rollback + `ChildProfileRollbackArgumentsV1` | 200/202，`ProfileReferenceV1` | 404 unavailable；409/423 |
| `POST /v1/profile/recover` | kind 属于 `ChildProfileRecoveryOperationKindV1` + `ChildProfileRecoveryArgumentsV1` | 200/202，`ProfileStartupRecoveryV1` | 409 conflicting activation；503/504 |

ProfileReferenceV1、ProfileStateV1、ProfileReloadModeV1、ProfileServerReportV1 与
ProfileStartupRecoveryV1 原样复用 RED-115。profileRoot 只允许出现在 child -> main 的内部 plan
result，禁止进入 preload、日志、error details 或 diagnostics。Room drain/cleanup 原样调用 RED-131
FIFO、journal、watermark 与 `RoomStore.removeRoom()`，不建立第二套 room persistence。
`RoomListResultV1.stateRevision` 只是 child 对 envelope 中 main expectedStateRevision 的回显；main
返回 preload 前重验当前 revision。childRevision 只用于内部 observation，二者不能互换。

这些 route 只存在于独立 loopback listener；玩家 API/WS 看不到。Mutation 必须携带 requestId、
operationId、expected revision，且只接受 main 已登记 active operation。child 不能发起 OS/process/
update/backup。Electron main 的 OS/backup/update 能力只可由受信 preload IPC 调用，不提供 HTTP
远程或“localhost 管理网页”入口。

同 OS 账户的恶意进程不在 capability 可完全抵御的范围；v1 信任本机账户与 signed app，但仍采用
随机轮换、loopback、trusted IPC 与最小 API。公网远程管理不在 v1。

## 8. Maintenance、RoomRuntime 与 durable terminal

`maintenance.enter` 固定顺序：

1. admission `open -> existing-only`；拒绝新 connection、room create/join/claim/ready/select/start
   与 PVE Run create/command；允许已 in-progress room/PVE battle 走到 terminal，也允许 leave；
2. 等 fence 前已 accepted room 与 PVE create/command handler 完成，使两类 pending 计数都可观察；
3. 从 RED-115/117 真源重读 room 与 active PVE battle 的 Profile lease、RoomRuntime、PVE
   `aggregateSetSha256` 与 stateRevision；
4. 发布 blockers，进入 maintenance。

`maintenance.drain` 固定顺序：

1. deadline 内等 in-progress room 与 active PVE battle 自然终局、waiting/ready occupants 释放；
   期间 existing-only；
2. room 与 active PVE battle Profile lease 都为零后 admission -> closed，拒绝全部新 gameplay
   mutation；
3. 等 fence 前 accepted room/player 与 PVE handler 完成，确认 `acceptedIngressPending=0` 和
   `acceptedPveIngressPending=0`；
4. close room-authority、persistence 与 PVE Run mutation ingress；
5. 等每房间 authority queue 与 RED-131 journal drain；
6. strict 重开 RED-117 Run Store，确认 `activeBattleCount=0`，为每个 active Run 记录
   revision/authority hash/aggregate hash，并重算包含 active aggregate、archived evidence 与
   tombstone 的 `aggregateSetSha256`；
7. 每 room 确认 pending=0 且 `durableAuthorityVersion >= authorityVersion`；
8. 输出绑定当前 stateRevision、fenceId、childInstanceId、排序后的 room watermarks 与完整
   `PveDrainReceiptV1` 的 drainRevision。

固定计算为
`drainRevision = SHA256(JCS({stateRevision,fenceId,childInstanceId,rooms,pve,profileStateRevision}))`；
`rooms` 按 roomId UTF-8 bytes 排序，`pve.runs` 按 runId 排序。任何 room/PVE mutation、child
restart、Profile/release/data generation 变化都会使旧 drainRevision 失效。timeout
不杀 room 或伪造终局，而是返回 blockers 并保持 maintenance/existing-only。journal degraded 使
admission closed 并进入 maintenance/degraded，要求 recover/restart，不忽略 undurable tail。

`room.cleanup`、普通 retention/GC 和 app cleanup 都不得删除 PVE Run、archived evidence 或
tombstone。只有 RED-117 authority reconciliation 在 admission closed、两类 accepted ingress 均为
零且 active PVE battle 为零时，才能按“先 immutable archive 完整 aggregate、再 durable tombstone、
最后删除 active Run”执行；任一步失败都保留原 active Run 并 fail closed。evidence/tombstone 进入
generation、backup 与 restore 完整性闭环，不得按 downloads/tmp 日志策略删除或重算。

```ts
interface RoomRuntimeInspectionV1 {
  schemaVersion: 'rvb-server-operations/v1'; roomId: string; observedAt: string
  roomLifecycle: 'waiting' | 'ready' | 'in-progress' | 'finished' | 'recovering' | 'quarantined'
  publicState: {
    visibility: 'listed' | 'hidden'; joinability: 'open' | 'closed'
    reasonCode: StateReasonCodeV1 | null
  }
  profileIdentity: GameProfileIdentityV1 | null
  authority: {
    protocolVersion: string | null; authorityBuildId: string | null
    authorityEpoch: number; authorityVersion: number
  }
  queue: {
    running: boolean; pending: number
    activeKind: 'player' | 'timer' | 'pending' | 'bot' | 'disconnect' | 'system' | null
    closedReason: string | null
  }
  persistence: {
    status: 'durable' | 'pending' | 'degraded'; durableAuthorityVersion: number
    pendingJobs: number; lastErrorCode: string | null; lastErrorAt: string | null
  }
  terminalBarrier: {
    status: 'not-terminal' | 'pending-durable' | 'durable' | 'degraded'
    terminalAuthorityVersion: number | null
    transitionHash: `sha256:${string}` | null
    settlementKey: string | null; durableAt: string | null
  }
  blockers: MaintenanceBlockerV1[]
}
```

`authorityEpoch` 每次从 durable room state 建新 memory authority instance 时递增并持久化，用于区分
restart 前后相同 authorityVersion。inspect 只聚合 RoomStore、现有 queue 与 RED-131 journal，不另存
mutable state。`listRooms` 默认 limit 100、范围 1–500；opaque cursor 绑定 stateRevision + filters，
revision 变化返回 `ROOM_CURSOR_STALE`。Management 可见 finished/recovering/quarantined；玩家公开
列表只含 live visible rooms，不得把未 restore raw DB row 或 dormant room 重新公开。

terminal transition commit 后立即把 room 标为 finished、public hidden/closed、barrier pending-durable，
clear timer；后续 gameplay 返回 `BATTLE_ALREADY_TERMINAL`。只有以下全部满足才变 durable：

1. terminal result 与 finished metadata 来自同一 authority transition；
2. terminal transition、checkpoint 与 hash audit 已 durable；
3. `durableAuthorityVersion >= terminalAuthorityVersion` 且 pendingJobs=0；
4. pinned RED-116 Profile、root seed 与 transition hash 仍验证。

无 rank-eligible season 时 settlementKey 为 null。否则
`settlementKey = SHA256(records(serverId, seasonId, roomId, authorityEpoch,
terminalAuthorityVersion, transitionHash))`；每条 record 是
`u32be(valueByteLength) || UTF8(value)`，数字使用无正号、无前导零的 canonical base-10 ASCII。
Ranking/report 只消费 durable terminal 并以 key 幂等；pending/degraded 不排名。terminal drain fail
必须 barrier degraded、保持 hidden 并报警。

startup 先 restore 全部 waiting/ready/in-progress/recovering 和 terminal pending/degraded，再决定 ready。
单 room chain/Profile pin/checkpoint 坏只 quarantine 该 room，其他可继续；全局 DB schema/integrity
不可读则 failed/closed。

## 9. 数据根、备份与恢复

正式路径不依赖可变 productName，也不使用 roaming `%APPDATA%`：

```text
%LOCALAPPDATA%/Programs/RedVsBlueServer/
  launcher/
  releases/<releaseId>/

%LOCALAPPDATA%/RedVsBlue/Server/       # <serverDataRoot>
  control/
    server-identity.json
    operation-ledger/
    continuity/generations/<continuityGenerationId>/
      manifest.json
      operation-receipts/<operationIdHash>.json
      COMPLETED
    deployment.json
    update-journal/
  data/generations/<generationId>/
    game.db
    game.db-wal                         # live generation transient companion
    game.db-shm                         # live generation transient companion
    config/
    pve-runs/                           # RED-117 PveRunStoreV1 唯一 live root
      runs/
      audit/evidence/
      audit/tombstones/
  resource-pack/                       # RED-115 Profile Store 真源
  backups/<backupId>/
  updates/downloads/<operationId>/
  updates/releases/<releaseId>/
    release.json
    release.signatures.json
    keyset.json
    update-bundle.zip
    runtime-catalog.cat
    VERIFIED.json
  diagnostics/
  logs/
  tmp/

# candidate 只能使用以下隔离根
%LOCALAPPDATA%/Programs/RedVsBlueServerCandidate/
%LOCALAPPDATA%/RedVsBlue/ServerCandidate/
```

路径只由 Electron main 从固定 install context 与 `app.getPath('userData')` 的受验证映射解析；
renderer/child command 不能给任意 absolute path。正式包拒绝 `--rvb-user-data-dir` 与
`RVB_ELECTRON_USER_DATA_DIR`；这些 override 只允许 appId、信任和 data 都与 stable 隔离的内部
候选。data root 使用当前 Windows 用户 ACL；v1 不声称抵御已控制该用户/管理员的本机攻击者。

`control/deployment.json` 是 app release + data generation + cumulative continuity generation 的
唯一原子 commit pointer，记录 releaseId、generationId、continuityGenerationId、config revision 与
exact previous tuple。它不记录或拥有 mutable active Profile revision，也不替代 RED-115 的
`resource-pack/active.json`。Launcher 只启动签名、hash、channel、schema 与 committed pointer 全
匹配的 release slot。

install root 的 `releases/<releaseId>` 只包含由 deployment pointer 选择、允许 Launcher 执行的
runnable release slot。`<serverDataRoot>/updates/releases/<releaseId>` 是永不执行的 immutable
verified rollback artifact-set：保存 exact signed release JSON、detached signatures、当时验证过的
root-signed keyset record、update ZIP、runtime catalog 与绑定全部 bytes/hash/verifiedAt 的
`VERIFIED.json`。两类 root 不得互当来源；数据 root 中的 set 只用于重新验证、重建 release slot 与
exact rollback。

control root（server identity、operation ledger、update journal）不随 restore 回卷，否则会重用 opId、
回退 serverId 或丢 uncertain evidence。现有 `game.db`/`resource-pack` 与 RED-117 当前
`<userData>/pve-runs` 都只是未来 migration 输入；导入器必须在 maintenance/closed 下 strict
验证并原样复制到一个新 generation，原子切换 pointer 后停用旧路径，不得同时写两个 root、merge
或从 checkpoint/receipt 重算 Run。本文不声称已经迁移。

| 数据类 | Backup | 保留/删除 |
| --- | --- | --- |
| launcher/release slots | 否，由签名 artifact 重建 | current、previous 至少 90 天；被引用继续保留；只删无引用 slot |
| control identity/ledger | migration continuity capsule 包含 identity、compact receipts 与 trust high-water；full ledger 不进 payload | existing root 只做 receipt union 与 high-water max，绝不回卷；identity 永久，receipt 永久 |
| config/DB/season/ranking/rooms | 是 | 通过 SQLite consistent snapshot；不把 live WAL/SHM 原样入包，不原地降级或 merge |
| `data/generations/*/pve-runs/**` | 是 | active aggregate、archived evidence 与 tombstone 成对完整入包并 exact-generation restore；generic GC/room.cleanup 不得删。只在 generation/backup/rollback 均无引用、至少保留 90 天并经 native irreversible approval 后，才可删除整个 retired generation；不得删单项或重算 |
| `resource-pack/**` immutable Profile package closure | 是 | 只包含 manifest `activeProfileIdentity` 对应、可由 RED-115 install route strict 重开的 package bytes；stable、previousStable、DB/backup 与 exact app rollback set 引用内容不得 GC |
| `resource-pack/active.json`、activation journal/lock | 不作为可恢复文件 | backup manifest 只把 active identity 当 assertion；restore 必须走 RED-115 plan/health/commit/recovery，禁止复制 pointer、journal 或 lock |
| logs | 否 | 14 天且总计 256 MiB，先删最旧完整轮转段 |
| backups | 不递归 | 7 daily、4 weekly、至少 2 个 pre-update 且不少于 90 天；manual 直到人工删除；不删最后一个 compatible verified backup |
| downloads/staging | 否 | 成功后删；失败候选最多 72 小时；不得含唯一数据 |
| `updates/releases/<releaseId>/**` verified artifact-set | 否 | current、prepared、previous pointer 引用 set 均保留；previous 至少 90 天且被 security/rollback 引用继续保留。只依据 durable reference graph 删除完全无引用 set，不走普通 download cleanup；set 内文件不可单删 |
| diagnostics | 否 | 单包 100 MiB，7 天且总计 512 MiB；默认无 DB/secret |
| tmp/locks | 否 | 确认 owner 不存活后按 token/operation ownership 清理，不用 glob |

```ts
interface ServerBackupManifestV1 {
  schemaVersion: 'rvb-server-backup/v1'; backupId: string; createdAt: string; serverId: string
  sourceRelease: ReleaseIdentityV1; activeProfileIdentity: GameProfileIdentityV1
  activeProfilePackage: {
    path: string; byteLength: number; sha256: `sha256:${string}`
    identity: GameProfileIdentityV1
  }
  databaseSchemaVersion: string; migrationSetHash: `sha256:${string}`
  seasonId: string | null; rankingWatermark: number
  controlContinuity: {
    schemaVersion: 'rvb-server-control-continuity/v1'
    operationReceiptCount: number
    operationReceiptSetSha256: `sha256:${string}`
    releaseTrustHighWater: ReleaseTrustHighWaterV1
  }
  roomDurableWatermarks: Array<{
    roomId: string; authorityEpoch: number; authorityVersion: number
    terminalSettlementKey: string | null
  }>
  pveRunStore: {
    source: 'rvb-pve-run-aggregate/v1'
    aggregateSetSha256: `sha256:${string}`
    activeBattleCount: 0; runWatermarks: PveRunWatermarkV1[]
    archivedEvidenceCount: number; tombstoneCount: number
  }
  cleanupCoverage: {
    planId: string; planHash: `sha256:${string}`
    cleanupEpoch: number; roomSelectionFingerprint: `sha256:${string}`
  } | null
  files: Array<{ path: string; byteLength: number; sha256: `sha256:${string}` }>
  fileSetSha256: `sha256:${string}`; verifiedAt: string
  manifestSha256: `sha256:${string}`
}

interface BackupCompletedMarkerV1 {
  schemaVersion: 'rvb-server-backup-completed/v1'
  backupId: string; completedAt: string
  manifestSha256: `sha256:${string}`; fileSetSha256: `sha256:${string}`
}

interface CompactOperationReceiptV1 {
  schemaVersion: 'rvb-server-operation-receipt/v1'
  operationId: string; kind: OperationKindV1
  commandHash: `sha256:${string}`
  terminalStatus: 'succeeded' | 'failed' | 'cancelled'
  resultHash: `sha256:${string}`; completedAt: string
}

interface ControlContinuityManifestV1 {
  schemaVersion: 'rvb-server-control-continuity/v1'
  continuityGenerationId: string; createdAt: string; serverId: string
  operationReceiptCount: number
  operationReceiptSetSha256: `sha256:${string}`
  releaseTrustHighWater: ReleaseTrustHighWaterV1
  payloadSha256: `sha256:${string}`
}

interface DeploymentPointerV1 {
  schemaVersion: 'rvb-server-deployment/v1'
  pointerRevision: number; writtenAt: string
  releaseId: `sha256:${string}`; dataGenerationId: string
  releaseArtifactSetSha256: `sha256:${string}`
  continuityGenerationId: string; continuityPayloadSha256: `sha256:${string}`
  configRevision: number
  previous: {
    releaseId: `sha256:${string}`; dataGenerationId: string; backupId: string
    releaseArtifactSetSha256: `sha256:${string}`
    retentionUntil: string
    profileRequirement: {
      identity: GameProfileIdentityV1; profileStoreRevisionAtCapture: number
    }
  } | null
}
```

`resultHash = SHA256(JCS({operationId,kind,commandHash,terminalStatus,result,error,rollback}))`。这里
result/rollback 使用 durable terminal snapshot 的 closed schema；error 只含 code/status/retryable/
phase/details，排除不稳定 message、correlationId 与时间。Succeeded 的 error 为 null；failed/cancelled
使用同一规则，room.cleanup 可包含已 durable partial result。Receipt 写入 continuity generation 并
提交 pointer 后，terminal response 才可返回。

manifest path 必须用 `/`、normalized/sorted，无 duplicate/case collision；拒 absolute、drive、`..`、
backslash、NUL、symlink、junction、reparse 和 non-regular file。

`files` 排除 manifest 本身与 `COMPLETED` marker，按 normalized path 的 UTF-8 bytes 排序。
`activeProfilePackage.path` 必须是 `files` 中恰好一项，其 length/hash/identity 必须逐字匹配
`activeProfileIdentity` 与 RED-115 strict reopen 结果；它是 immutable install package，不是
`resource-pack/active.json`、activation journal 或 lock 的副本。
`fileSetSha256 = SHA256(u32be(fileCount) || records)`，每条 record 为
`u32be(pathByteLength) || pathBytes || u64be(byteLength) || raw32(fileSha256)`。
`operationReceiptSetSha256` 对按 operationId UTF-8 bytes 排序的
`CompactOperationReceiptV1` JCS bytes 计算
`SHA256(u32be(receiptCount) || repeated(u32be(receiptByteLength) || receiptBytes))`；count 必须与
`operationReceiptCount` 相等。
`roomDurableWatermarks` 按 roomId、`pveRunStore.runWatermarks` 按 runId 的 UTF-8 bytes 排序，
并分别完整覆盖 snapshot 中所有 room 与 active PVE Run；PVE archived evidence/tombstone 必须一一
配对，两个 count 与 file inventory 相等。manifest 的 `aggregateSetSha256` 必须同时等于 drain
receipt 和从 backup bytes strict reopen 后的重算值，否则整个 backup 不得写 COMPLETED。

Full manifest payload 是 `ServerBackupManifestV1` 除 `manifestSha256` 外全部命名字段的 RFC 8785
JCS UTF-8 bytes；`manifestSha256 = SHA256(payload)`，因此 serverId、release/Profile、DB schema、
season/ranking watermarks、continuity high-water、room watermarks、PVE Run watermarks 与
aggregate set、file inventory、fileSetSha256 与 verifiedAt 全部进入完整性闭环。严格解析拒绝
unknown/duplicate fields、非 canonical scalar 与乱序/重复 collection。

Continuity generation 是 immutable cumulative snapshot，而不是可变 receipt 目录。其 canonical
payload 是
`JCS({schemaVersion,createdAt,serverId,operationReceiptCount,operationReceiptSetSha256,releaseTrustHighWater})`；
`payloadSha256` 必须等于 payload SHA-256，`continuityGenerationId` 固定为
`c-<payload SHA-256 lowercase hex>`。receipt filename 是
`SHA256(UTF8(operationId))` 的 lowercase hex，不直接使用不可信 ID。generation 必须先在同卷随机
staging 目录完整写入、flush、重开验证，把 `COMPLETED` 作为 staging 的最后一个 durable file，再
rename 为 immutable final directory；final directory 不再修改。

任何新增 terminal receipt 或提高 trust high-water 都先从当前 snapshot 生成 set union / component-wise
max 的新 continuity generation，再以更高 pointerRevision 原子替换 `deployment.json`；release/data
字段可以保持不变。Electron main 只能在同一 NTFS volume 写 temp pointer、FlushFileBuffers 后使用
Windows atomic replace/write-through primitive。这里不声称多个路径可原子写；原子可见点只有一个
pointer replacement。pointer 前失败留下未引用 staging/generation，按 hash/ref GC；pointer 后启动只
接受具有 `COMPLETED`、payload hash、serverId 与 pointer 全匹配的三类 generation，否则
rollback-required。Full operation ledger 与 update journal 不回卷；startup 用它们 reconcile
accepted/running operation 与新 pointer。

Verified backup 只在 maintenance、blocker=0、room + PVE durable drain/barrier 后执行。file set
包含当前 generation 的完整 `pve-runs/runs/**`、`audit/evidence/**`、`audit/tombstones/**`，并额外包含
`control-continuity/manifest.json`、`operation-receipts/*.json` 的当前 cumulative compact tombstones
与 release trust high-water；
不包含可执行 operation detail、capability 或 update download。continuity files 必须进入 inventory 与
payload hash。

带 cleanup plan 的 backup 在 snapshot 前后都重算 cleanupEpoch/fingerprint；完全匹配才写
`cleanupCoverage`，否则 backup operation 以 `ROOM_CLEANUP_PLAN_STALE` 失败且不产生 verified
backup。Standalone backup 的 coverage 为 null。App update 只有在可选 plan 有效时才把它交给内部
pre-update backup；没有 plan 时 cleanup phase 是 no-op，绝不自行选择房间。Cleanup 执行时要求
backup coverage、当前 epoch/fingerprint、planId/hash 四者全等。

1. 记录 identity、release tuple、Profile revision、DB schema、room/PVE durable watermarks、
   `aggregateSetSha256` 与 data-loss cutoff；
2. 保持 PVE mutation ingress closed 并停止唯一 DB writer，以 SQLite Online Backup API 产生自包含
   snapshot；不能活动 WAL 下只复制 DB；
3. 写 `<backupId>.partial`，包含 generation data（含完整 PVE active/audit tree）、与
   `activeProfileIdentity` 对应且由 RED-115 strict 导出的 immutable install package，以及 manifest
   input；不得复制 `resource-pack/active.json`、activation journal 或 lock 作为恢复权威；
4. 运行 `PRAGMA integrity_check`，strict 重开每个 PVE aggregate/evidence/tombstone，重算
   `aggregateSetSha256`，并经 RED-115 package verifier 复验 Profile identity 与逐文件 size/SHA-256；
5. 写 canonical manifest 后独立 reopen，重算 full manifest/file set；在 staging 内把 strict
   `BackupCompletedMarkerV1` 作为最后一个 durable file 写入并 flush，再同卷 rename 为 final
   immutable directory；
6. 全部通过才更新 lastVerifiedBackupId。

读取顺序固定为：final directory 与 `COMPLETED` 存在 -> strict marker -> strict manifest ->
marker/目录 backupId 与 manifestSha256/fileSetSha256 精确匹配 -> 重算 full manifest digest -> 重算
全部 files。任何 mismatch/partial 都隔离为非 backup；`BackupRecordSummaryV1.manifestSha256` 只能取
通过该流程的 full manifest digest。

默认 backup root 为 `<serverDataRoot>/backups`。native picker 可导出到本机或可移动 NTFS absolute
directory；renderer 只拿 one-use token。UNC/network share、云同步和同时写入目录不支持。backup
依赖 Windows ACL，不承诺应用层加密；外部介质保管由服主负责。

这些 hash、SQLite/Profile 检查只证明包内一致性并检测损坏、截断或误改，不提供 backup authenticity。
能重写整个 backup 并重算 manifest/hash 的当前 Windows 用户、管理员或介质攻击者不在 v1 防御范围；
v1 没有 backup signature/MAC。UI、文档和测试不得把 verified backup 称为“防篡改”。

Restore 固定流程：

1. 先 durable 保存 source service intent。maintenance 源在同一 operation 内完成 normal fence/drain/
   stop；所有来源在读取/写入 restore stage、Profile 或 pointer 前，都必须证明完整 process tree、
   player/management ports、DB writer、PVE writer/ingress absent/quiesced，并取得唯一 data-root lock。
   任一证明失败返回 `PROCESS_TREE_NOT_ABSENT`、`PORT_NOT_RELEASED`、`WRITER_ALREADY_ACTIVE` 或
   `DATA_ROOT_LOCKED`，零 stage/Profile/pointer mutation；
2. reverify path/marker/manifest/bytes/serverId/season watermark/DB/Profile/PVE schema、PVE
   aggregate set/release/space，以及 continuity receipt set/hash 与 keyset/sequence/epoch high-water；
3. 已有 committed generation 时必须先建 verified pre-restore backup，失败即停；真正空 root 必须
   证明无 identity、deployment、generation、receipt 后，在临时 bootstrap journal 写 durable
   `no-prior-generation` receipt，不能伪装成已有 backup；
4. 解到随机 generation staging，拒 path/node attack，不原地覆盖；
5. staging DB 与 PVE Run Store 只做 release identity 明确声明允许的 forward migration；PVE 必须从
   backup 的 active/audit tree exact-generation restore，不得与本机 Run merge、从 checkpoint/
   receipt 重算或丢弃 unknown/corrupt entry；随后 restore rooms；
6. 空 root 先只用 RED-115 既有 explicit Bundled Base bootstrap/recovery 在 closed 状态建立可验证
   stable；随后 strict 重验 `activeProfilePackage` 的 bytes/identity，经受 capability 保护且绑定本
   `backup.restore` operation 的 `/v1/profile/install` 写成 RED-115 candidate，再走同一 RED-115
   plan/rebind/candidate-health/commit/release/recovery；不得 raw 写或复制 `resource-pack/active.json`。
   若现有 stable 已逐字等于 manifest identity，可把 `profileActivationId` 记为 null 并只 strict
   reverify；否则 package 缺失、identity/hash drift 在 pointer mutation 前返回
   `PROFILE_REQUIRED`/`PROFILE_INVALID`；空 root 同样只能走这个 candidate 路径；
7. 计算 control continuity merge：已有同 serverId root 对 compact receipt 做 set union，同 operationId
   不同 commandHash/resultHash 返回 `BACKUP_OPERATION_RECEIPT_CONFLICT`；keysetVersion 取
   `max(local, backup, launcherEmbeddedMinimum, freshlyVerifiedKeyset)`，并携带提供该最大 version 的
   keysetRecordSha256；多个来源提供相同最大 version 时 digest 必须一致，否则
   `BACKUP_TRUST_HIGH_WATER_INVALID`。releaseSequence 也取各来源 max 并携带提供该最大 sequence 的
   releaseRecordSha256；相同最大 sequence 的 digest 不一致同样返回
   `BACKUP_TRUST_HIGH_WATER_INVALID`。securityEpoch 独立取 max。这些值只是独立验证下限，不是拼出
   的 release identity；后续每份 manifest 仍须作为完整 tuple 同时通过。空 root 采用 backup
   identity/capsule，把 no-prior receipt 加入集合，并在任何 update check/admission 前验证当前 signed
   keyset；backup 不能降低 launcher 或网络已验证的 security floor；
8. candidate 以 RED-115 activation plan 指定的 Profile、closed admission、ephemeral ports 做完整
   health，strict 验证同一 PVE Run Store 与 `aggregateSetSha256`；
9. 先完成 immutable continuity generation；commit intent 必须绑定 activationId/null、target Profile
   identity 与 previousStable assertion，再用唯一 deployment pointer replacement 一次选择新的
   release/data/continuity generation。pointer durable 后才允许 RED-115 activation commit；两次原子
   pointer 之间崩溃只能按同一 operation ledger 与 RED-115 recovery 完成或补偿，不声称跨文件事务；
10. 从 committed deployment + RED-115 stable pointer restart/rehealth；
11. 按 durable source intent 映射 reopen/hold。

precommit fail 删除 stage；若 RED-115 candidate plan 已建立则按其 recovery/release 保持旧 stable，旧
generation 不变。已有 root 的 postcommit health/Profile commit fail 必须同时切回同一个
pre-restore config+DB+PVE generation，并经 RED-115 recovery/rollback 恢复 pre-restore stable；两者
都 verified 后才恢复 source intent。真正空 root 没有可回切 generation，postcommit fail 的唯一结果是
rollback-required/closed/no-writer，保留已采用 identity、continuity、staged generation 与全部 evidence，
只允许再次 verified restore/recovery，不能伪造自动回切。pointer/generation/ledger/continuity 无法
证明唯一 committed version 时同样 rollback-required。existing root restore 永不删除本地新 receipts
或降低 trust high-water；空 root backup 缺 continuity capsule 时不得采用旧 serverId。
较新 DB 不交给旧 app；未知 schema、缺 Profile、不同 serverId、截断、hash/integrity mismatch 或
包内不一致一律 fail closed，不猜测 migration 或跨服 merge。

## 10. App update、签名与 rollback

```ts
interface VerifiedReleaseArtifactSetMarkerV1 {
  schemaVersion: 'rvb-release-artifact-set/v1'
  releaseId: `sha256:${string}`
  releaseRecord: VerifiedArtifactResultV1
  signatureRecord: VerifiedArtifactResultV1
  keysetRecord: VerifiedArtifactResultV1
  updateBundle: VerifiedArtifactResultV1
  runtimeCatalog: VerifiedArtifactResultV1
  artifactSetSha256: `sha256:${string}`; verifiedAt: string
}

interface AppUpdateProviderV1 {
  resolveKeyset(
    channel: 'stable' | 'candidate'
  ): Promise<Uint8Array>
  resolveRelease(
    channel: 'stable' | 'candidate',
    currentReleaseId: `sha256:${string}`
  ): Promise<{
    releaseRecord: Uint8Array
    signatureRecord: Uint8Array
  }>
  download(
    release: ReleaseIdentityV1,
    artifact: UpdateBundleArtifactV1 | RuntimeCatalogArtifactV1,
    destinationToken: string,
    signal: AbortSignal,
    onProgress: (bytes: number, total: number, heartbeatAt: string) => void
  ): Promise<{ byteLength: number; sha256: `sha256:${string}` }>
}
```

`artifactSetSha256 = SHA256(JCS({releaseId,releaseRecord,signatureRecord,keysetRecord,
updateBundle,runtimeCatalog}))`；上述六个字段使用 strict
`VerifiedReleaseArtifactSetMarkerV1` 值，排除 `artifactSetSha256` 与 `verifiedAt`，避免自引用。
main 必须先将五类已验证 bytes 写入同卷 staging，逐项 reopen/reverify，再把 strict `VERIFIED.json`
作为最后一个 durable file 写入并 rename 到 immutable set root。首次安装也必须先 seed 完整 set 并
把该 hash 写入 deployment pointer，不能只凭 runnable slot 建立 current/previous rollback 关系。

provider 的 resolveKeyset 只返回 raw root-signed keyset bytes；resolveRelease 返回 raw complete
release JSON 与 raw detached `ReleaseSignaturesV1` bytes；download 只返回不可信 bytes。provider
没有“已验证”权力。它只能写 main 签发的 destinationToken，不能选 path、execute、
切 pointer、删 backup 或开 admission。Keyset/release endpoint 与 redirect 都只允许第 3 节 fixed
GitHub host；artifact redirect destination 还必须在 signed manifest allowlist。Prepare 只 download +
verify 完整不可执行 artifact-set；apply 再逐 byte 验证 set hash、marker 与各文件，不信内存对象或
mtime，也不从 runnable slot 反向生成 set。

公开 assets 包括 setup EXE（candidate 可省略）、update ZIP、Windows runtime catalog、release JSON、
detached signatures、keyset JSON 与 keyset signature。
Manifest 使用第 3 节的 canonical unsigned payload；Ed25519 只覆盖该 payload，hash 和 detached
signatures 不递归进入自身 bytes。installer、uninstaller、
launcher 与项目自产 PE 必须用受信 CA Authenticode、SHA-256 digest、RFC 3161 SHA-256 timestamp；
CI 执行等价于 `signtool verify /pa /all /tw`，任何失败或 warning exit 都阻断候选。第三方 PE 保留
上游签名，并由 release manifest hash 绑定；项目不覆盖第三方 publisher。

密钥层级与轮换：

1. offline release root 私钥不进仓库、普通开发机或 CI；root public key 固定在 launcher，只签
   `rvb-release-keyset/v1`；
2. stable/candidate 使用不同 leaf；stable leaf 只在受保护 signing provider 可用；
3. keyset 含 channel、单调 version、key ID/public key、有效期、status、revokedAt、最低
   securityEpoch；客户端拒绝低于 durable high-water mark 的 keyset/sequence/epoch；
4. 正常轮换先发布更高 keyset，同时列 current/next；至少一个 stable release 且至少 90 天 manifest
   同时带 current/next 两个 detached signatures 后才 retire current，确保 N/N-1 都能验证；
5. leaf 泄漏时停 feed，由 root 撤销 leaf 并提高 securityEpoch；不能安全取得新 keyset 的旧安装
   只能通过新 Authenticode installer 恢复；
6. root 泄漏时停全部 in-app update；新 root 只能经人工批准的 Authenticode installer 带外安装，
   network keyset 不得替换内置 root。

App update 固定 phase：

1. `preflight`：release/current Profile/DB/PVE schema/platform/disk/approval，并重验 target 与
   exact previous artifact-set hash；
2. `maintenance`：room 与 PVE admission existing-only；
3. `drain`：无 room/active PVE battle lease 后 close 两类 ingress，queue/journal/PVE receipt
   durable；
4. `backup`：verified pre-update；
5. `cleanup`：只按绑定 cleanupPlanHash，不删唯一 rollback set；
6. `stage-release`：immutable side-by-side，重验 manifest/ZIP/catalog/逐文件 inventory/Authenticode；
7. `stage-data`：复制 live DB/config 与 PVE active/audit tree 到新 generation；
8. `migrate`：只改 staging DB/PVE Store，且仅运行 ReleaseIdentity 声明的 migration；再验
   integrity/Profile/room restore/PVE aggregate set；
9. `candidate-health`：isolated data view + ephemeral ports + closed admission，验证 process、
   management、玩家 HTTP 101 Upgrade、WS `system.health`、release/Profile/DB/PVE Run Store 与
   fixed-seed smoke；
10. `commit-intent`：durable target release/generation 与 previous
    `{releaseId,artifactSetSha256,generation,backup,Profile requirement}` rollback set；
11. `atomic-commit`：一次原子替换 deployment pointer，同时选择 release + generation；
12. `committed-health`：从 durable pointer restart，不复用 candidate module cache；
13. `reopen-or-hold`：保持 source service intent；
14. `retain-rollback`：保留 previous release/generation/verified backup。

precommit（pointer 未换）失败删除 stage 并按 durable mapping 恢复 source intent。`app-update.apply`
postcommit 失败先 exact previous 自动 rollback；必须恢复同一 previous config+DB+PVE Store generation，
并验证 previous release artifact-set hash、重建后的 runnable slot、backup 与经 RED-115 恢复的
Profile，全部 healthy 才算成功，否则 rollback-required。`app-update.rollback` 自身在 atomic pointer
后的 committed-health 失败不再猜测第二次补偿，固定进入 rollback-required/closed/no-writer。

| 当前 -> 目标 | 条件 | 决策 | Config/DB/PVE Store/Profile 行为 |
| --- | --- | --- | --- |
| N-1 -> N 或 N -> N+1 | stable manifest 的 supportedUpgradeFrom 列出；签名/epoch/OS 通过 | 允许 | 同一 staging generation 内复制 config、forward migrate DB/PVE Store；Profile 单独 health |
| N-2 或更旧 -> N | 未列 supportedUpgradeFrom | `UPDATE_INCOMPATIBLE` | 不改 config/DB/PVE Store/Profile；逐版升级或安装兼容版后 restore |
| N -> exact previous N-1 | 90 天内；previous verified artifact-set hash、pre-update backup/generation/Profile requirement 完整；未被 securityEpoch 撤销 | 显式 rollback | 从 set 重建并复验 binary，exact 恢复同一个 previous generation 的 config+DB+PVE Store；Profile 只经 RED-115 |
| N -> 任意更旧/非 previous | 即使签名有效 | `UPDATE_DOWNGRADE_FORBIDDEN` | 不改 pointer/data |
| stable <-> candidate | appId/data root/key 不同 | `UPDATE_CHANNEL_MISMATCH` | 独立安装，不共享 data |
| 相同版本、较低 sequence/epoch | replay/撤销 | `UPDATE_MANIFEST_INVALID` | 不停服、不写 live data |
| reopen 后已写入 -> previous | 服主确认 backup cutoff 与数据损失 | 允许完整 rollback | maintenance/drain 后 exact 恢复同一个 pre-update generation 的 config+DB+PVE Store；Profile 只走 RED-115 |
| previous artifact-set/backup/generation/Profile requirement 任一不完整或 hash 不匹配 | 无完整 tuple | rollback-required | closed，保留全部证据 |
| Profile A -> B -> A | app tuple 未变 | 不走 app update | 完全复用 RED-115 |

Stable N 获得当前支持；N-1 只作为 previous rollback target 保留 90 个自然日，不接收功能修复，也
不是长期运行版本。securityEpoch 撤销优先于 90 天窗口。

### 10.1 Power-loss / kill 矩阵

下表中的“恢复 source intent”是唯一 durable 映射：原 ready 保持 closed，完整 rehealth 后才 -> ready；
原 stopped -> stopped；原 maintenance -> maintenance/closed；原 degraded、failed 或 rollback-required
发起的恢复 -> maintenance/closed。restart 不得按当前 process、mtime 或猜测重算该映射。

| 故障点 | 唯一恢复处理 |
| --- | --- |
| manifest/download incomplete | 无 verified marker，删 partial，current 不变 |
| verified prepare、apply 未开始 | current 继续，可按原 operation/release 重试 |
| maintenance/drain | 无 commit intent；保持 closed、重算 blockers，按 durable mapping 恢复 source intent |
| backup/stage-release | 无 verified marker，删 incomplete；pointer/source generation 不变，按 durable mapping 恢复 source intent |
| stage-data/migration | pointer 仍 source，隔离/删 stage，绝不作为 live DB/PVE Store 打开；按 durable mapping 恢复 source intent |
| candidate-health | pointer source，终止可识别 candidate；按 durable mapping 恢复 source intent |
| commit-intent 已写、pointer source | precommit failure；按 durable mapping 恢复 source intent |
| empty-root restore 的 bootstrap-identity/bootstrap-profile/verify-continuity、deployment pointer 尚不存在 | 只在 bootstrap intent、已采用 identity、RED-115 Bundled Base bootstrap/activation evidence、continuity stage 与同一 operationId/backupId/manifest hash 唯一一致且 backup bytes 仍 verified 时续跑同一 restore；任何缺失/冲突 -> rollback-required/closed/no-writer，不能生成新 identity、手写 Profile pointer 或改用其他 backup |
| app-update.apply 或 existing-root restore 的 pointer 已选 target、success 未写 | committed-health；pass 补 terminal success 后按 source intent，fail 自动 exact 恢复同一 previous config+DB+PVE generation 与 RED-115 Profile；任一补偿不确定 -> rollback-required |
| empty-root restore 的 pointer 已选 target、success 未写 | committed-health；pass 补 terminal success 后按 durable `sourceServiceIntent`；fail -> rollback-required/closed/no-writer；没有 previous generation，禁止声称 exact rollback |
| app-update.rollback 的 pointer 已选 rollback target、success 未写 | committed-health；pass 补 terminal success 后按 source intent，fail -> rollback-required/closed/no-writer；不猜测二次切回 rollback 前 source deployment |
| pointer/ledger/generation/continuity/Profile activation 矛盾 | rollback-required，player admission 不启动 |
| committed-health 后、reopen 前 | closed；reverify 后按 source intent |
| rollback pointer 切换中 | 只选唯一完整一致 deployment；仍歧义则 rollback-required |
| success 后、cleanup 前 | candidate 继续，previous rollback set 保留 |

startup 不得按 mtime、最高 SemVer、最新 download 或 candidate existence 选 release；只认 atomic
pointer、ledger 和 byte verification。

## 11. 日志、diagnostics 与删除

JSONL 至少含 timestamp、level、event、correlationId、requestId/operationId、stateRevision、
lifecycleState、phase/phaseSequence、serverId、releaseId、Profile identity、roomId、authority/
durableAuthorityVersion、code、durationMs。每段不超过 20 MiB；总计不超过 256 MiB，最多 14 天。
active/rollback-required operation 的脱敏 evidence 在 terminal 后至少 90 天。log sink fail 不吞业务
error，产生 `LOG_SINK_FAILED` warning；disk safety reserve 时停 download/backup/update，但仍允许
stop/state/minimal error。

所有 log/state/error/diagnostics 禁止 capability、cookie/Auth、private/signing key、URL credential、
player password/PII、archive/DB raw、hidden card/full state、raw absolute path、含 env/user path/CLI
secret 的 unsanitized stack。路径只显示 `<serverDataRoot>`/`<installRoot>` + relative。

Diagnostics 单包 100 MiB，只含 redacted state/operation/health、release/backup manifest、config schema
+ redacted values、selected room inspect/transition metadata、rolled logs 与 hash inventory。默认无 DB、
Profile archive/image、Replay/player content。先 partial，复验 redaction/size/hash 后 atomic rename。

任何自动 GC 必须依据 durable reference graph 与 resolved absolute path，不用 glob、环境变量或旧
observation。卸载删数据与 room cleanup 各需 native approval 并写 exact receipt。不得自动删除最后
一个 compatible verified backup、active/previous release、active/previousStable Profile 或 uncertain
operation evidence。

## 12. 威胁与故障矩阵

| 威胁/故障 | 强制边界 | 必须验证的结果 |
| --- | --- | --- |
| remote 持正确 capability | 先验真实 loopback peer | 403；non-loopback + valid key test |
| key guess/replay | 256-bit、per-child rotate、never durable | restart 前后 cross-use 失败 |
| renderer/iframe/navigation IPC | parse 前 exact window/main frame/origin | untrusted sender matrix |
| 玩家 WS/公开 HTTP 尝试管理 | separate listener/no public route | zero operation；player/admin key 无效 |
| operation ACK loss | durable ID + hash | 原 ID query/retry 不重复副作用 |
| same opId/new payload | hash conflict | OPERATION_ID_REUSE、零副作用 |
| stale UI | revision CAS | two-dashboard concurrency |
| Profile/update 并发 | global single-flight | start/stop/Profile/update 组合 |
| SQLite busy | RED-131 5 次/10 秒、500ms busy | 仅 room A degraded，room B 可 durable |
| 单 room chain/Profile pin 坏 | quarantine only | hidden room；其他 ready；restart 多房 |
| global DB/PVE Store transient unavailable/timeout，但 integrity、唯一 writer 与 committed generation 仍可证明 | fail closed | degraded + stable error；不得自动 reopen |
| global DB/PVE Store corrupt、integrity failure、集合不完整、未知 schema 或无可信/唯一 writer | fail closed | failed + stable error；无 writer |
| terminal persist fail | durable terminal barrier | hidden/degraded/no ranking |
| drain hang | deadline/no implicit kill | blockers + maintenance/degraded |
| child crash/port occupied | child heartbeat + exact identity | failed closed |
| MITM/tamper | Ed25519 + hash + Authenticode | current unchanged；各层 tamper/redirect |
| channel leaf 泄漏 | root-signed keyset revoke/epoch + Authenticode catalog policy | 单独 leaf 不能授权修改 runtime tree；停 feed 后拒绝旧 leaf |
| wrong channel/platform | metadata + native workstation gate | candidate/x86/ARM64/低 build/Windows Server 拒绝 |
| downgrade/old installer | sequence/epoch/DB policy | downgrade forbidden；新 DB/缺 backup |
| update/restore 任 phase 断电 | journal + one pointer | 按 power-loss matrix 确定恢复 |
| disk full（precommit） | reserve + phase journal + bounded partial cleanup | pointer/source generation 不变；已 durable cleanup receipt 不回滚且必须有 verified backup；按 source intent 恢复 |
| disk full（postcommit） | protected rollback reserve + exact previous set | 有完整空间/bytes 时恢复同一 previous config+DB+PVE generation 与 Profile；写入或验证补偿不确定 -> rollback-required |
| traversal/symlink/reparse | bounded strict walker | drive/../case/junction/bomb 拒绝 |
| secrets in logs | central redactor + rescan | capability/env/path/URL/stack canary 不泄漏 |
| force-stop approval 缺失/过期/取消或 tail-loss=false | native approval + exact true literal | 零副作用拒绝；原 process tree 保持，不得报告 absent |
| approved force-stop 执行 | process-tree termination + absence proof | 只有 tree/ports/writers 全 absent 才成功；否则 failed/rollback-required |
| failed/maintenance restore 遇残余 process/port/DB/PVE writer | pre-stage absence gate + unique data-root lock | 稳定 absence/lock error；零 stage/Profile/pointer mutation |
| backup Profile pointer 注入 | immutable package + RED-115 install/activate/recovery | raw `active.json`/journal/lock 不入恢复路径；manifest identity mismatch fail closed |
| restore other server/old season | serverId + watermark | mismatch/conflict fail closed |
| 同一 backup 复制为两个活跃服 | local data-root lock only；不承诺跨主机 fencing | clone 必须重置 identity/season；测试与文档不得宣称 split-brain 防护 |

v1 不声称防御已控制当前 Windows 用户/管理员、可替换 launcher/root key、读进程内存，或可重写
整个 backup 并重算 unsigned manifest/hash 的攻击者；不提供远程管理、云控制、backup authenticity
或跨服信任。签名私钥仍不得在 Server 主机，备份/回退不得吞错继续写入。

## 13. 后续实现完成门禁

后续实现必须同时覆盖：

1. strict command/additive state fixtures、release JCS/hash/signature、全部 enum/error；
2. 全部合法/非法 state transition，非法转换 zero effects；
3. operation replay/conflict/revision/single-flight/cancel/result-expiry/restart recovery；
4. IPC sender/native approval/loopback/key rotation/public route isolation/secret canary；全部固定 child
   route 的 method/media/schema/status，分钟级工作 202 replay 不重复副作用；
5. RED-115 activation/rollback/uncertain commit/durable drain，经 outer operation；
6. RED-116 bare `Sha256HexV1` identity/pin/lease/app-update Profile compatibility 与 exact mismatch code；
7. RED-117 active battle lease、两类 ingress、Run/audit/tombstone aggregate-set JCS、backup/exact restore、
   authority reconciliation 与旧 `<userData>/pve-runs` 单次迁移；
8. RED-131 same-room serial/different-room isolation/5-or-10 busy/one-room degraded/restart restore；
9. maintenance existing-only/lease timeout/full room + PVE ingress fence/drainRevision invalidation；
10. terminal pending/durable/degraded/ranking settlement idempotency/public closure；
11. backup bytes/DB/Profile/PVE、identity adopt/match、season watermark、pre-restore rollback、path attacks；
12. update keyset/leaf revoke/detached signature strict binding/artifact-set/catalog/runtime inventory/channel/
    native workstation gate/installer/DB/PVE downgrade/全部 power phase/previous rollback set；
13. Windows 10 22H2 x64 与 Windows 11 x64 clean install/start/stop/restart/update/rollback/
    uninstall-preserve-data/residual process/port，Win10 evidence 明示 OS EOL；
14. log rotation/disk-full/diagnostics/capability/path/URL/player-data redaction；
15. 独立 AI review、人工 High Risk candidate approval、命令/exit code/artifact hash 证据。

这些测试扩展而不是替换既有 Electron IPC/security、Profile admission/lease、room queue、async
journal/SQLite 和 battle shutdown suites。

## 14. 本合同回退

本阶段只有文档。撤销 RED-140 时应 revert PR #126 最终 merge/squash commit 所带来的全部 7 个
allowed-path 文档净变更，包括 ADR-0003/ADR-0021/decisions README、ARCHITECTURE、
MODULE_INTERFACES、BUILD_AND_RUN 与本文，并恢复 ADR-0003 为当前 internal-only 边界；不能只 revert
源 feature commit `2f6565b2de9468b701dc6063c7b227a8d831fd11` 或当前含 main-sync 的 PR head。
不得删除 RED-115/116/117/127/131 已有 runtime、data、Profile、PVE evidence、journal 或 tests。

后续 runtime PR 必须分别提供 old release/data retention、verified backup、candidate validation、
power-loss evidence 与独立 rollback。实现若不能满足 fail-closed、single-flight、durable terminal、
signing 或 recovery，应停在 internal candidate，不得弱化合同或用 default key 发布。
