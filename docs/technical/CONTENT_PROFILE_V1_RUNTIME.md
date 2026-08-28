# Content Profile v1 安装、激活与回退运行时

状态：RED-115 implementation contract

基线：`main@487711e017b5d43196b530f3dc1a2a3257d53c66`

上游合同：[Content Pipeline v1](./CONTENT_PIPELINE_V1_CONTRACT.md)、
[Core/Resolver](./CONTENT_PIPELINE_V1_CORE.md)、
[ADR-0018](../decisions/ADR-0018-content-pipeline-v1.md)

## 1. 责任边界

RED-115 只把 RED-114 已验证的完整 Resolved Profile 安装到本机，并协调 Client、内嵌 Server 和
standalone Server 的激活。Electron adapter 不解析 manifest、不验签、不解析 Patch，也不直接改活动
指针；这些动作统一通过 Next.js 的 `/api/content-profile/**` 边界进入 Content Pipeline core。

Profile 是一次激活的最小单位。任一文件失败都会让整个 candidate 失败；不存在“缺一个文件就从
Bundled Base 补一个”的逐文件 fallback。HTML、JS、CSS、SVG 和 native 内容不属于可激活 namespace。

## 2. 本机目录与指针

写入根为 `<userData>/resource-pack`：

```text
resource-pack/
  active.json
  activation.lock
  packages/<packageHash>/...
  profiles/<resolvedProfileHash>/
    .rvb/profile.json
    .rvb/resolution.json
    data/**/*.json
    images/**/*.{png,jpg,jpeg,webp}
```

- `packages/**` 保存通过验证的原始 v1 package，供 Patch parent 重建；相同 hash 的重复写入必须逐字节
  相同，否则失败关闭。
- `profiles/**` 是完整不可变 snapshot。目录名等于 `resolvedProfileHash`，每次使用前核对 Profile
  metadata、每个文件的 size 与 SHA-256；验证还遍历实际目录，拒绝 manifest 未声明的文件、空目录、
  symlink、不支持的节点类型与大小写碰撞，不能让 hash 之外的残留文件进入运行时视图。
- `active.json` 使用 `rvb-profile-state/v1`，同时记录 `stable`、`candidate`、`previousStable`、
  `activation`、`lastFailure` 和单调 `revision`。
- 指针写入使用同目录临时文件加 rename；进程内和跨请求 mutation 使用带唯一 `ownerToken` 的
  `activation.lock`。释放时只有 token 仍匹配的持有者可以删除；进程崩溃留下的 dead-PID v1 lock
  必须先原子 rename 为该回收者独占的 stale claim，再核对逐字节内容后回收，不能按旧观察直接删除
  当前 lock 路径。
- 旧 `{version: ...}` / `{activePackId: ...}` 指针不解释为 v1 Profile，只恢复到 Bundled Base。

## 3. 安装

安装输入是根级 `manifest.json`、可选 `signature.json` 与 manifest payload 的 v1 ZIP。外部包必须有
有效 Ed25519 签名；unsigned 只允许 Electron 明确设置的本地开发模式，打包版本不能开启。

运输边界先检查 32 MiB archive、2048 entries、16 MiB 单文件、128 MiB 解压总量，再拒绝 traversal、
absolute/drive/backslash/NUL、大小写碰撞、symlink、加密 entry 和不支持的 Unix 类型。随后只调用
RED-114 resolver。旧 `pack.json` ZIP 明确拒绝，不自动迁移。

安装成功只执行：

1. 持久化 immutable package 与完整 `profiles/<hash>`；
2. 将该 reference 写入 `candidate`；
3. 保持 `stable`、Server 环境与 renderer 根不变。

重复安装相同字节和 hash 是幂等操作。若已有激活事务，安装返回 `PROFILE_STORE_BUSY`。

## 4. 两阶段激活

Electron 主进程是生命周期协调器，但不拥有内容语义。正常顺序是：

1. `activation/plan`：先发布 planning fence，立即关闭普通 HTTP API、已连接 WebSocket 的新权威命令和
   游戏 WebSocket 新会话准入，只保留认证后的 `/api/content-profile/**` 控制面、`/api/ping` 和精确
   `/ws/rooms/__profile-health__` transport-only 探针；HTTP gate 位于 Next.js 16 的 Node `proxy.ts`，读取
   与 profile API 同一 Node 进程中的动态激活环境，而不是使用会冻结环境快照的旧 Edge middleware；
   candidate 进程从启动起也保持相同关闭状态；begin 等待 fence 前已接收的普通 HTTP request 和 WebSocket
   async handler 全部 finish/close，再重新检查 lease 与 fence ownership，避免已经入队的 `start-game` 等
   命令在 lease 查询后才提交；确认无 lease 后才建立 activation transaction、将 fence 换为 activation ID，
   并终止 plan 前已经建立的游戏 WebSocket，避免旧连接绕过 Upgrade gate；
2. `presentation-refresh`：当前规则进程显式 rebind candidate；
3. `authority-restart`：先确认没有活动对局 lease，再停止旧 Server，以 candidate 的完整 root、full hash、
   authority hash、ABI 和 activation ID 启动新 Server；
4. candidate Server 核对启动环境与磁盘 Profile 身份，strict parse 全部 JSON，检查菜单必需资源，运行
   固定种子 `0x01152026` 战斗 smoke，并报告 HTTP/WS 健康；
5. Electron 额外执行真实 WebSocket handshake，并在隔离 Chromium session 的隐藏 BrowserWindow 中通过
   candidate 固定的实际 `rvb-client://` protocol 加载完整 `index.html`，由 renderer 自身 fetch 并解析菜单
   Profile JSON、调用 candidate `/api/ping`，同时等待 load 成功且 renderer 未崩溃、未失去响应；主 renderer
   在此时仍使用旧 stable；
6. `activation/commit` 再次核对 lease、activation ID、full hash、authority hash、ABI 和全部健康项；
7. 只在全部匹配后原子写入 `stable=candidate`、`previousStable=old stable` 并绑定新 stable；Client
   commit 仍保持准入关闭，等待主 renderer 的真实 reload 完成，并通过受信 bridge 对账 renderer 所见
   stable hash、Server hash 与 Server 健康状态，再调用认证后的 `activation/release` 开放准入；
   standalone Server 因无游戏 renderer 可在 commit 时直接开放。reload/readiness/release 失败自动把
   `previous-stable` 重新作为 candidate 走完整健康检查与
   commit，不在两版之间递归反复切换；commit response 丢失或 post-commit 异常先只读观察 durable stable
   与 Server 身份，不猜测 commit 结果，必要时以新 stable 进程恢复后再次观察。

未知 ABI、未知 capability 或 `app-update-required` 不进入候选运行时。多个重复激活同一 target 返回同一
activation transaction；安装、回退与激活事务互斥。

## 5. 活动对局 lease

任何 `status === "in-progress"` 的权威房间（包括由同一 RoomStore 承载的 PVE active battle）都是
authority Profile lease。`authority-restart` 的 plan 和 commit 都重新查询 lease；只要存在 lease，就返回
稳定错误 `409 PROFILE_IN_USE`，不创建/提交新指针。等待室和已结束房间不持有 lease。

RED-115 不实现新的 PVE Runner，也不把旧浏览器 localStorage PVE 原型提升为 v1 权威 Run。后续 Runner
必须把 active battle 放入同一服务端 lease 边界，且固定 `authorityContentHash`。

## 6. 失败与崩溃恢复

Server 启动、环境身份、文件 hash、JSON parse、菜单资源、固定种子战斗、HTTP、WebSocket、renderer
资源或 commit 任一失败时：

- `stable` 不变；
- activation 清除，candidate 保留供诊断/重试；
- `lastFailure` 记录 code、stage、message、target/stable hash 和时间；
- authority candidate 进程停止，并按旧 stable 的完整环境重新启动 Server。

停止旧 Server 前必须获得持久化 journal drain ACK；未确认时返回
`PROFILE_DURABLE_DRAIN_FAILED`，保留旧进程与 stable 指针，不用强杀掩盖未落盘状态。由于该进程的
journal ingress 可能已经关闭，此失败路径保持 HTTP/WS 准入暂停并要求重启应用；只有新的 stable 进程
或其他已经证明健康的 stable 恢复路径才可清除暂停标记，不能把半关闭进程伪装成已恢复。

若 Electron/Server 在 begin 与 commit 间崩溃，下次应用只按 durable stable 启动，然后调用 recovery：
清除未提交 activation、记录 `ACTIVATION_INTERRUPTED`。candidate 从不因单独存在而成为活动内容。

所有正常启动、手动启动、重启与失败恢复都先以明确的 stable binding 启动，并在开放准入前执行 recovery
和 Profile/Server health 对账。若 durable stable 元数据损坏或缺失，首个进程只以显式 Bundled Base root
进入关闭状态；Store 恢复指针后，如进程身份或 module cache 可能已经绑定旧内容，Electron 必须替换为
新进程再验健康。child process 不继承宿主残留的 Profile hash、ABI 或 activation token。

commit 后的 renderer 失败及回退结果另写入 `resource-pack/audit/*.json` 原子审计证据。若 renderer 回退
自身失败、返回失败或抛错，协调器停止 Server 并保持准入关闭，明确要求重启应用，不能让 Server 与
renderer 以不同 Profile 继续运行。

## 7. 回退与状态权威

回退不是直接改指针。`previous-stable` 或 `bundled-base` 先成为 candidate，然后完整走同一 plan、健康
检查和 commit 流程。Base 是只读应用内容经同一 RED-114 core 构造出的真实 Resolved Profile。

当前仓库的旧 `data/pve/**` 浏览器原型没有 v1 schema，ADR-0018 明确不把它自动视为 v1 内容，因此
Bundled Base 暂时排除这些 pre-v1 文件。带 `rvb-pve-*/v1` schema 的后续文件会进入 core 闭包验证。
只有 `public/images/**` 映射到 pack 的 `images/**`；现有 root-level app art 仍是版本化应用资产。

`pack.html` 与 standalone dashboard 在 Electron 中只读取认证后的 profile API/state；安装、候选激活、
上一稳定版回退和 Bundled Base 回退都是分离的显式动作。Android/browser 也先读取 bridge/IndexedDB 的
实际文件状态。`rvb_pack_meta` localStorage 只能在真实内容存在时补充显示名称，不能决定当前生效内容。
两个 renderer 都在 FileReader/ArrayBuffer 分配前拒绝超过 32 MiB 的 ZIP；浏览器流式读取还同时核对
Content-Length 与实际累计字节，并在超限时取消 reader。

## 8. 观察性与人工候选验证

Profile 日志使用结构化 `event=content-profile`，记录阶段、full/authority hash、ABI、activation ID、固定
seed/state hash、活动 room IDs 与失败原因。不得记录 ZIP 内容、私钥或 per-process admin key。

Windows 候选验证至少执行：

1. 激活 A；
2. 安装 B，强制 candidate health 失败，确认 Server/renderer 仍是 A 且 `lastFailure` 可见；
3. 修复后重新激活 B，确认 Client/Server 的 full/authority hash 完全一致；
4. 选择 `previous-stable`，完整验证并回到 A；
5. 在 begin/commit 间终止应用，重启后确认只恢复 stable，candidate 未自动生效。

生产构建还必须运行 `node tests/electron/profile-admission-next-process.mjs`。该探针启动真实 standalone
Next 进程，核对构建清单中的 `/_middleware.runtime=nodejs`，再在同一进程内动态暂停/恢复 admission，
验证普通 API 依次表现为开放、503、重新开放，且暂停期间 `/api/ping` 仍可用。

同时运行 `node tests/electron/profile-startup-recovery-next-process.mjs`：先以损坏 installed stable
启动真实 standalone 进程，验证 recovery 要求替换进程并恢复 Bundled Base；再以缺失 metadata 和宿主
残留身份变量启动，验证显式 Base bootstrap 可以收敛且开放后的 Server/Profile hash 一致。

代码级回退优先 revert RED-115 PR。数据级回退可在旧版本运行前先通过当前版本选择 Bundled Base；
`packages/**` 与 `profiles/**` 是不可变缓存，可以保留。不得用手工编辑 `active.json` 代替产品回退流程。
