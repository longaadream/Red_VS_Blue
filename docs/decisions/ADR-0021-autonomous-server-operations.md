# ADR-0021：冻结 Windows 自治服务器运维、发行身份与本地管理 API v1

- 状态：已接受
- 日期：2026-08-31
- 人工批准：2026-08-31
- 关联任务：RED-140
- 父路线：RED-134
- 设计基线：`main@f51a5eed2a37be6491841a19393b0725ad188554`
- 收尾同步基线：`main@6e6ae8dd88928dc285c0cbb7a5be7e3c121ae9a2`
- 取代：[ADR-0003](./ADR-0003-electron-server-packaging.md)
- 规范合同：[Server Operations v1](../technical/SERVER_OPERATIONS_V1.md)

自本 ADR 接受之日起，ADR-0003 只保留为 Electron Server 内部候选阶段的历史记录；其“不得公开
发行、没有安装器/更新/备份支持”的产品方向被本 ADR 取代。在后续实现合同、候选验证和逐次人工
发布批准完成前，现有 `win-unpacked` 仍只是内部候选，不能因为本 ADR 已接受就公开。

## 背景

RED-134 要求普通服主能在 Windows 上安装、启动、维护、备份、升级和诊断自治 Server，并让每台
Server 拥有本服身份、赛季和竞技数据。现有主线已提供必须复用的边界：

- RED-115 的 Resolved Profile 安装、原子激活、stable/candidate/previousStable、健康与回退；
- RED-116 的 engineAbi + runnerRevision + authorityContentHash 房间硬门禁及 resolvedProfileHash
  诊断身份；
- RED-117 的 strict PVE Run aggregate、revision CAS、活动战斗 Profile lease 与 authority
  reconciliation archive/tombstone/evidence；
- RED-127 的 Windows standalone Server 和玩家 WebSocket-only 传输；
- RED-131 的 battle protocol/build 门禁、房间持久化有限重试、degraded 与 durable drain；
- ADR-0002 的 Electron trusted window、main-frame 与 preload IPC sender 边界。

这些能力尚未构成公开发行产品。当前 builder 只生成 internal-only `dir` 候选；没有公开 installer、
签名 release tuple、schema ledger、verified backup、恢复或 binary rollback 合同。因此本 ADR 冻结：

1. `rvb-server-operations/v1`：生命周期、状态、命令、权限、数据、备份和故障恢复；
2. `rvb-release-identity/v1`：公开 artifact、签名、channel、兼容和 downgrade identity。

本 ADR 与技术合同只定义 Phase 0，不实现 UI、Supervisor、管理 listener、备份、排名、安装器、
下载器、迁移器或发布。

## 决策

### 1. 支持平台和产品形态

自治 Server v1 面向一名使用本机交互式 Dashboard 的普通服主；一个 Windows 用户只运行一个正式
Server 实例。v1 不是 Windows Service，不提供开机自启、无界面守护、远程 Web 管理或多用户共享。

公开 v1 支持：

- Windows 10 22H2 x64；
- Windows 11 x64。

不支持 x86、Windows on ARM/ARM64、Windows Server、macOS 或 Linux。Windows 10 22H2 已结束
[微软常规支持](https://learn.microsoft.com/windows/release-health/release-information)。本项目只承诺
应用级构建、安装、启动、更新和回退兼容验证，不代表微软仍提供常规系统安全修复。Dashboard 与
发行说明必须建议优先使用仍受支持的 Windows 11。未来移除 Win10 支持必须由新的人工批准 ADR 和
签名 manifest 明示，不能静默改变 v1。

公开安装器固定为 electron-builder assisted per-user NSIS x64（`oneClick=false`、
`perMachine=false`），安装到当前用户 `%LOCALAPPDATA%/Programs/RedVsBlueServer`，不要求管理员
权限、不写 Windows Service、不自动创建机器级防火墙规则。首次向导只说明如何在受信专用/家庭
网络开放玩家端口。

公开不提供 Portable、MSI、Web Installer、per-machine 或 silent unattended。`dir/win-unpacked`
只作内部 QA 证据。卸载默认保留 Server data、backup 和 log；“同时删除数据”必须默认未勾选、展示
解析后的固定路径并二次确认，且先证明 Server 已停止。

### 2. Stable 与 candidate 隔离

| 维度 | `stable` 公开渠道 | `candidate` 隔离渠道 |
| --- | --- | --- |
| 用户 | 普通服主 | 开发、QA、候选验收 |
| Artifact | assisted per-user NSIS x64 + ZIP update bundle + signed runtime catalog | 隔离 ZIP update bundle + candidate catalog；installer 可选；internal `dir` 仅 QA 输入 |
| 来源 | 官方 GitHub Releases 的 immutable stable release | 官方 GitHub Releases 的 prerelease；stable feed 永不返回 |
| 信任 | stable Authenticode + stable manifest leaf | candidate/test leaf；stable 永不信任 |
| 发布 | protected environment 产 draft；负责人看证据后手动 publish | 不得自动提升 stable |
| 数据 | 固定 stable data root | 不同 appId、data root、key，不能开 stable data |
| 支持 | 当前 N；N-1 仅 previous rollback 90 天 | 无生产支持承诺 |

Stable Dashboard 只在打开更新页或服主点击“检查更新”时查询 stable feed。v1 不静默下载、安装或
重启；download、apply、previous rollback 分别需要本机意图/确认。stable 不能切 candidate。
Stable 固定 appId `com.redvsblue.server`；candidate 固定
`com.redvsblue.server.candidate`，并使用 `RedVsBlueServerCandidate` 安装根与
`%LOCALAPPDATA%/RedVsBlue/ServerCandidate` data root，不能打开 stable data。

Stable N 获得当前支持。N-1 只作 previous rollback 目标保留 90 个自然日，不继续收功能修复，也
不是长期运行版本。更旧或非 previous 版本拒绝 downgrade。安全 release 可提高 securityEpoch 并
撤销 N-1；安全下限优先于 90 天窗口。

### 3. 双层签名与发布身份

公开 installer、uninstaller、launcher 与项目自产 PE 必须有 Authenticode SHA-256 code-signing
signature 和 RFC 3161 SHA-256 timestamp。第三方 PE 保留并验证上游签名，另由 manifest hash 绑定。
可接受的项目 publisher subject 与 signer SPKI allowlist 只能来自 offline root 签名的 versioned keyset；
leaf-signed release manifest 只引用 policyId，不能自行扩大 publisher 信任。

每个 stable release 发布三个用途固定的 artifact：首次安装使用 signed assisted NSIS；in-app
update/rollback 使用逐 byte hash 的 ZIP release tree，不静默执行 installer；root-policy
Authenticode-signed Windows catalog 覆盖完整 runtime inventory。ZIP 中项目自产 PE 仍逐个验证
Authenticode，解压使用固定路径/预算规则；catalog、installer clean-install 与 ZIP extract 必须得到
相同 signed runtime tree。candidate 使用隔离 update bundle + candidate catalog，可选候选 installer；
现有 `dir/win-unpacked` 只是生成 tree inventory 前的 QA 输入，不是 release artifact。

此外使用独立 Ed25519 release manifest，冻结 app version、commit/tree、artifact bytes/hash、
platform/arch、battle protocol/build、engine ABI/runner、bundled Profile、DB 与 PVE Run Store
schema/migration、management API、channel、sequence、security epoch 与 signing identity。HTTPS
只是 transport。

密钥层级固定为：

1. offline release root 私钥不进仓库、开发机或 CI；内置 root public key 只验证 versioned keyset；
2. stable 与 candidate 使用不同 leaf；stable leaf 只在受保护 signing provider 可用；
3. keyset version、release sequence 与 securityEpoch 均有 durable high-water mark，拒绝 replay；
4. 正常轮换先由 root 签更高 keyset，current/next 至少一个 stable release 且 90 天 dual-sign 后
   才 retire current；
5. leaf 泄漏时停 feed、root 撤销并提高 securityEpoch；旧客户端无法安全更新时用新 Authenticode
   installer 带外恢复；
6. root 泄漏时停全部 in-app update；新 root 只能通过人工批准的新 Authenticode installer 带外安装。

完整 tuple、canonical bytes、verification 与 key rotation 以 Server Operations v1 为唯一 schema。

### 4. 唯一运维写权威和本地管理边界

Electron main 独占 OS、process、file、backup、restore、app update 和整体 lifecycle 写能力；renderer
只能经受信 preload IPC 读状态/提交命令；Next child 只提供 room/PVE admission 与 drain、Profile
adapter、delegated PVE authority reconciliation、RoomRuntime inspect/cleanup、PVE observation 与健康。

每个 child spawn 生成新的 256-bit random capability，仅在 main/child 内存。child 另开
`127.0.0.1:<ephemeral>` listener；先验证真实 TCP peer 是 loopback，再 constant-time 比较
capability。不得信任 Host、Origin、X-Forwarded-For，不得复用玩家 WS、公开 `/api/*`、CORS、
cookie/player token 或静态 admin key。renderer 不知道 listener URL/key，也不直接调用 HTTP。

因此“本地管理 API”分两层：受信 renderer 到 Electron main 的版本化 IPC 是唯一 operator mutation
入口；main 到 child 的 loopback HTTP 只是最小内部 adapter。它不是远程管理产品。

RED-115 的 Profile Store、lock、plan、rebind、commit、release 与 recovery 仍是唯一行为/状态真源。
自治 Server v1 adapter 迁移完成后，本 ADR 只取代 RED-115 与旧模块地图中的 standalone transport/
probe 句子：trusted IPC -> loopback `/v1/profile/**` 直接调用同一个 RED-115 core，不代理到公开
`/api/content-profile/**`，也不新增 static key。玩家 listener 不注册这些旧 routes；旧玩家 REST
和 `/api/ping` 继续按 RED-127/ADR-0020 返回 410。玩家 HTTP health 用真实 WS 路径的 101 Upgrade，
WS health 再用 `system.health` 校验 protocol/build/Profile；依赖旧 ping 的候选必须迁移后才合规。
ADR-0020/RED-127 曾把 standalone `/api/admin/**` 留在玩家传输任务范围外；自治 Server v1
明确取代这项历史留白：现有 `/api/admin/rooms/cleanup` 不得注册到玩家 listener，也不是兼容旁路。
cleanup 只能从 trusted IPC 进入同一 main coordinator，再委托独立 loopback
`POST /v1/rooms/cleanup`；静态资源继续使用 HTTP 不代表允许公开管理 route。

### 5. 状态、幂等与故障关闭

生命周期固定为：

```text
stopped | starting | ready | maintenance | draining | stopping |
degraded | failed | updating | rollback-required
```

`ready` 必须同时通过 process、玩家 HTTP/WS、management、DB、persistence、RoomRuntime、PVE Run
Store、Profile、release tuple 与 admission；PID 或端口响应不等于 ready。单房 degraded 只形成房间 warning，不自动
拖成全服 degraded；只有全局安全/准入条件受损才进入顶层 degraded。

所有 mutation 带 requestId、durable operationId、expectedStateRevision。coordinator 在副作用前写
accept record，并把 lifecycle 映射后的 sourceServiceIntent 同次 durable；全局 single-flight；相同 ID/
相同 canonical payload replay 原结果，不同 payload 拒绝；
旧 revision 零副作用。renderer timeout 不取消 operation。force-stop、room cleanup、restore、Profile
rollback、app apply/rollback 等破坏性或有数据损失风险的命令使用 Electron native one-use approval；
main 必须 strict 解析完整 unsigned command、自算 hash 并显示目标与数据损失，不能让用户批准
renderer 提供的不透明 hash。

每个 state、command、owner、授权、前置、timeout、结果、错误、rollback、合法转换和稳定 error code
以 Server Operations v1 为规范；实现不得在 UI、child 或 updater 另造第二套状态。

### 6. Maintenance、durable terminal 与竞技入口

maintenance 先 `existing-only`，同时 fence room 与 PVE create/command，等 fence 前两类 accepted
ingress，再检查 room 和 active PVE battle 的 Profile lease/blocker；drain 在两类 lease 为零后关
admission/authority/persistence/PVE ingress，等待每房间 FIFO、RED-131 journal 与 RED-117 Run Store。
只有 room pending=0、durableAuthorityVersion 达到 authorityVersion、PVE accepted pending=0、
active battle=0 且完整 aggregate/audit set strict 验证通过，才签发绑定两类 watermarks 的
drainRevision。timeout 不强杀或伪造终局。

terminal result 立即隐藏/关闭房间，但只有 terminal transition/checkpoint/hash 已落盘且
`durableAuthorityVersion >= terminalAuthorityVersion` 时，terminalBarrier 才为 durable。本服竞技
只消费 durable terminal，以 serverId + seasonId + settlementKey 幂等；pending/degraded 不排名。

单房持久化/chain/Profile pin 故障只 quarantine 该房，其他房间可继续。全局 DB/PVE Store 的
transient unavailable 只有在 integrity、唯一 writer 与 committed generation 仍可证明时才
degraded/closed；corrupt、integrity/schema/集合失败或无可信唯一 writer 必须 failed/closed。

### 7. 固定数据根、identity、backup 与 restore

正式 install/data root 固定为：

```text
%LOCALAPPDATA%/Programs/RedVsBlueServer/
%LOCALAPPDATA%/RedVsBlue/Server/
```

data root 分离 immutable runnable release、不可执行 verified rollback artifact-set、control
identity/operation/deployment、versioned data generation（其中 `pve-runs` 是 RED-117 唯一 live
root）、RED-115 Profile Store、backup、download/staging、diagnostics 与 log。正式包不接受任意 userData
override；renderer/child 不提供 raw path。atomic deployment pointer 同时选择 release + DB/config
PVE generation + immutable cumulative continuity generation，并以 artifact-set hash 绑定
current/previous release，但不替代 RED-115 的 Profile active pointer。RED-117 当前
`<userData>/pve-runs` 只作为一次性 migration input，不得与 generation root 双写。

首次建立空 control root 生成本机 UUIDv4 serverId。原机 restore、app/Profile update 和 backup
migration 保持它；空新主机可从 verified backup 采用它，已有 identity 只能 restore 同 ID。同一
data root 由本机 lock 保证一个 writer；backup 迁移要求服主确认原主机已停止，但 unsigned backup
不能证明跨主机退役，v1 不承诺 split-brain 防护。clone 必须重置 identity 与赛季命名空间；
serverId 不是密码学跨服证明。

Verified backup 只在 maintenance、room/PVE blocker=0、durable drain/barrier 后执行：停止唯一 DB
writer，以 SQLite Online Backup API 得一致 snapshot，包含 DB、config、与 active identity 对应且
能由 RED-115 strict 安装的 immutable Profile package、赛季/竞技 durable data 及完整 PVE active
aggregate、archived evidence、tombstone；`active.json`/activation journal/lock 不作为可恢复文件。
逐文件 hash、SQLite integrity、PVE aggregate set、Profile package/identity 全部独立二验，在 staging 内最后写
durable COMPLETED marker 后才 atomic rename 为 immutable backup。活动 WAL 下只复制 `game.db`
不合规。

迁移 capsule 还必须携带 server identity、永久 compact operation receipts 与 release trust high-water。
已有 root restore 对同一 identity 的 receipts 做 union、对各 high-water 维度取最大值，冲突即失败；
真正空 root 采用 backup capsule，并写 durable `no-prior-generation` receipt，不能伪造旧备份或降低
已知安全下限。Receipts/high-water 先写成完整 immutable continuity generation；唯一原子可见点是
deployment pointer 对 release/data/continuity 三个 generation 的一次替换，不声称 NTFS 能事务写多个
目录。

Restore 对 maintenance 源先 normal drain/stop；所有来源在 stage/Profile/pointer mutation 前必须证明
process tree、player/management ports、DB/PVE writer/ingress absent，并取得唯一 data-root lock，否则
零副作用失败。随后重验 marker/manifest/identity/season watermark/DB/PVE aggregate+tombstone
schema/Profile/bytes/path；已有 committed generation 时先创建 verified pre-restore backup，真正空
root 则走上述 no-prior receipt。在新 generation 上解包、只按 manifest 声明 forward migrate、exact
restore PVE active/audit tree；空 root 先复用 RED-115 explicit Bundled Base bootstrap/recovery，
Profile package 再只能进入 RED-115 candidate 并走 plan/health/commit/recovery，禁止复制
`active.json`。closed-admission health 成功才 atomic commit；不得 merge 或从
checkpoint/receipt 重算 Run。precommit 失败旧 generation/stable 不变；已有 root postcommit 失败必须
回切同一 pre-restore config+DB+PVE generation 并经 RED-115 恢复 pre-restore stable。真正空 root
没有 pre-restore generation，postcommit
失败只能 rollback-required/closed/no-writer，并保留已采用 identity/continuity 与 evidence，不能声称
自动回切。无法证明唯一 committed generation 时 rollback-required。未知 schema、错 serverId、排名
水位倒退、截断、hash/integrity mismatch 或包内不一致都 fail closed。

默认 retention：7 daily、4 weekly、至少 2 个 pre-update 且不少于 90 天；manual backup 直到人工
删除；永不自动删最后一个 compatible verified backup。backup 默认依赖当前用户 NTFS ACL，不承诺
应用层加密或 authenticity；外部介质保管由服主负责。hash/integrity 只检测损坏、截断或误改，不能
抵御能重写整包并重算 unsigned manifest/hash 的本机/介质攻击者。UNC/network share、云同步或同时
写入目录不是 v1 支持目标。

### 8. 事务式 app update 与 exact previous rollback

Profile update 与 app update 是两个状态机：Profile install/activate/previousStable/bundled-base 完全
复用 RED-115；app updater 管 signed binary、DB/config generation 和 release pointer，只能调用
Profile runtime 的 fence/health/rollback，不能直接改 Profile Store。

active Profile 只以 RED-115 `active.json` 为真源，运维 state 只是只读投影，deployment pointer 不
复制 mutable Profile revision。App apply 在 commit-intent 前把当时同时兼容 target/previous 的 exact
Profile identity、store revision 与 immutable payload/package closure 固定进 previous rollback set，
至少保留 90 天；后续 Profile 激活不改 deployment。App rollback 需要旧 Profile 时必须先走 RED-115
activation pipeline，不能手改 pointer。

App update 顺序固定为：

1. 隔离 check/download，验证 size/type/channel/root/keyset/signature/hash/sequence/epoch/OS/arch，
   最后形成不可执行 immutable verified artifact-set；
2. maintenance room + PVE fence；
3. RoomRuntime/PVE blocker + persistence/PVE durable drain；
4. verified pre-update backup；
5. 只按已批准且被 backup 覆盖的 cleanup plan 清理；
6. 从 verified artifact-set 建 immutable side-by-side release 与新 DB/PVE generation；
7. staging DB/PVE forward migration；
8. closed-admission candidate health，包含真实玩家 101 Upgrade、WS `system.health`、PVE Store 与
   fixed-seed smoke；
9. durable commit intent；
10. 一次 atomic pointer commit；
11. 从 committed pointer 启动唯一 writer 并完整 rehealth；
12. 按 source service intent reopen/hold，保留由 artifact-set hash 绑定的 previous
    manifest/signatures/keyset/bundle/catalog、data（含 PVE）、backup/Profile requirement。

apply commit 前失败按 durable source intent 回安全状态；apply commit 后失败自动 exact previous
config+DB+PVE generation rollback。旧 binary 不得打开新
schema，不做原地反向 SQL migration。若新版 reopen 后已有写入，rollback 前必须向服主展示 backup
cutoff 与会丢失的数据；不得称为“无损回退”。previous verified artifact-set、matching
backup/generation 或 retained Profile requirement 不完整，
或 pointer/ledger/generation 不确定时，进入 rollback-required、admission closed 并保留全部证据。
显式 `app-update.rollback` 自身在 pointer commit 后 health 失败同样进入 rollback-required，不猜测
再次切回 rollback 前 source deployment。

download、maintenance、backup、stage、migration、candidate health、commit、reopen 与 rollback 每个
phase 的 kill/power-loss 唯一恢复行为由 Server Operations v1 固定。startup 只认 atomic pointer、
operation ledger 和 byte verification，不按 mtime、SemVer 或“最新下载”猜版本。

### 9. 数据、日志和删除边界

- runnable release slot 与 verified artifact-set 不进 backup；current/prepared/previous set 按 durable
  reference graph 保留，previous 至少 90 天且被引用时继续保留；set 内文件不可单删；
- PVE active aggregate/audit evidence/tombstone 完整入 backup；generic GC/room cleanup 不得删，只有
  RED-117 reconciliation 可按 archive -> tombstone -> remove active Run 顺序处理；
- operation full record 保留 90 天或 1000 条（取更多），compact idempotency receipt 随 identity 永久；
- log 最多 14 天/256 MiB；diagnostics 单包 100 MiB、总计 512 MiB、最多 7 天；
- capability、cookie/Auth、private/signing key、URL credential、玩家秘密/PII、raw DB/archive、隐藏
  信息、绝对用户路径和未脱敏 stack 不得进入 state/log/error/diagnostics；
- GC 必须基于 durable reference graph 与 resolved absolute path，不使用 glob、环境变量或旧观察；
- room cleanup 与卸载删除 data 分别使用 native approval 和 exact receipt，不删唯一回退集。

完整路径 registry、backup manifest、retention、redaction 和删除不变量以 Server Operations v1 为准。

## 备选方案

### 公开 Portable、per-machine、Service 或自动防火墙

不采用。Portable 缺稳定安装根、卸载语义、launcher/data 分离和 side-by-side commit。per-machine、
Service 与自动防火墙需要 UAC、跨用户 ACL、服务身份、无人值守凭据和额外恢复矩阵；超出单交互式
服主 v1。后续需要时必须新建 High Risk ADR。

### 只用 Authenticode 或 HTTPS

不采用。Authenticode 证明 Windows 文件 publisher，HTTPS 保护运输；二者都不能独立冻结 channel、
release tuple、DB/API compatibility、sequence 和 downgrade。独立 Ed25519 manifest 提供这些语义。

### 单一在线 manifest key

不采用。在线 key 泄漏后无法可信撤销自己。Offline root + channel leaf + 单调 keyset/epoch 支持正常
轮换与受控恢复；root 泄漏仍必须通过新 Authenticode installer 带外恢复。

### Electron autoUpdater 原地覆盖

不采用。原地覆盖无法同时证明 previous binary、Profile、config、DB 与 PVE Store generation，也不能在
migration/health/commit 断电后确定唯一 writer。v1 使用 launcher、side-by-side slot 与原子 pointer。

### 静态 admin key、远程 Dashboard 或玩家 socket 管理

不采用。LAN gameplay listener 不能同时携带管理能力。真实 loopback peer + 每进程 capability +
trusted preload IPC 是固定边界。

### 原地反向 DB migration

不采用。previous rollback 总是恢复与 previous release 匹配的 verified pre-update backup；旧 binary
永不写新 schema，并明确 cutoff 后数据损失。

### DPAPI-only backup 加密

不采用。它会把恢复绑定到同一 Windows 凭据/机器，妨碍迁移到替代主机。v1 使用 NTFS ACL、
hash/integrity 验证和明确介质责任；未来应用层加密必须以独立 versioned backup schema 引入。

## 影响与风险

- 当前 internal-only builder、manifest、默认 userData、header-only Profile API、固定 DDL 初始化与
  `/api/ping` 都不是本 ADR 的合规实现；后续任务必须迁移，不能称为已支持。
- RED-141/144/145/148 可以消费同一 state、operation envelope、RoomRuntime barrier、data registry
  与 server/season scope，不再各自发明字段。
- 公开发行新增 Authenticode、offline root、受保护 leaf、protected release environment、Windows
  10/11 x64 VM 与人工 rollback rehearsal 的持续成本。
- Windows 10 应用兼容不能补偿 OS 已结束常规安全支持；警告必须持续保留。
- pre-update backup rollback 会丢 cutoff 后数据；UI、operation receipt 和 log 必须准确显示。
- backup 默认无应用层加密；诊断默认排除 DB 与 secret。
- 本 ADR 不授权自动 merge/publish、正式发布，也不修改 PvP 规则、随机、内容、经济或排名算法。

## 验证与发布门禁

本 ADR 文档变更只运行：

```powershell
npm.cmd run check:main-baseline
npm.cmd run check:encoding
git diff --check
```

并执行相对 Markdown link 检查及独立 AI contract review。文档检查不得描述成 runtime 测试通过。

后续实现候选至少需要：

1. Windows 10 22H2 x64 与 Windows 11 x64 干净 VM 的签名 NSIS install/start/stop/restart/update/
   rollback/uninstall-preserve-data；
2. signtool、canonical manifest、key rotation/revocation、wrong key/channel/replay/downgrade/tamper tests；
3. non-loopback + valid capability、malicious renderer/iframe IPC、capability redaction tests；
4. 所有 lifecycle/command 的合法/非法转换、single-flight、重复 ID 和 response loss；
5. room/PVE blocker、active PVE lease、两类 accepted ingress、DB busy/retry exhaustion、durable
   drain/terminal、PVE aggregate/audit corruption、backup hash mismatch 与 exact restore rollback；
   不得声称 unsigned backup 防篡改；
6. update/restore 每个 phase 强杀/断电，证明始终只有一个 writer；
7. Profile A -> B -> A 仍只走 RED-115；active PVE battle 阻断，authority reconciliation 证据完整，
   old/new engine ABI 或 runner revision mismatch 使用 RED-116 exact code 且在 mutation 前拒绝；
8. Stable N update、N-1 90 天 previous rollback、data cutoff 提示与 securityEpoch 撤销；
9. 进程/端口、artifact/manifest/backup hash、截图和脱敏 log 证据经人工验收后才手动 publish。

## 回退本决策

若本 ADR 在公开实现前撤销：

1. revert RED-140 文档提交；
2. 恢复 ADR-0003 internal-only 为当前有效边界；
3. 停止依赖 v1 contract 的后续实现与发布；
4. 候选只保留内部证据，不发布、不自动更新；
5. 不删除 Server data、Profile、backup、竞技历史或签名证据。

若已经公开发布，不能只 revert Git 文档；必须先发布签名的停止支持/恢复方案并保护用户数据。

## 相关资料

- [ADR-0002：Electron 资源包与 IPC sender 信任边界](./ADR-0002-electron-resource-pack-ipc-trust.md)
- [ADR-0003：Electron Server 内部候选历史边界](./ADR-0003-electron-server-packaging.md)
- [ADR-0018：Content Pipeline v1](./ADR-0018-content-pipeline-v1.md)
- [ADR-0020：统一玩家 WebSocket 传输](./ADR-0020-unified-player-websocket-transport.md)
- [Content Profile v1 运行时](../technical/CONTENT_PROFILE_V1_RUNTIME.md)
- [Resolved Profile 房间握手与固定](../technical/RESOLVED_PROFILE_ROOM_HANDSHAKE.md)
- [Electron Server 内部候选记录](../technical/RED_44_ELECTRON_SERVER_CANDIDATE.md)
- [模块接口](../technical/MODULE_INTERFACES.md)
- [构建与运行](../technical/BUILD_AND_RUN.md)
- [RED-140](https://linear.app/redvsblue/issue/RED-140/冻结自治服务器发行边界运行状态与本地管理-api-v1)
- [RED-134](https://linear.app/redvsblue/issue/RED-134/路线-建立自治服务器可视化运维与服务器内排位)
