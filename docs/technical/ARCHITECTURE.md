# Red VS Blue 当前架构

状态：RED-9 代码核对稿

基线：`594977b`（2026-08-12）
架构约定更新：2026-08-18（RED-34）
自治服务器约定更新：2026-08-31（RED-140，设计基线
`f51a5eed2a37be6491841a19393b0725ad188554`；收尾同步
`6e6ae8dd88928dc285c0cbb7a5be7e3c121ae9a2`）

首要公开测试模式：先完成 LAN Windows/Electron；Android 后续按 RED-81 迁移到同一权威状态标准

本文只描述当前代码、已确认方向和历史问题，不表示现有版本已经可以稳定运行。

人工审查只需先看第 1、7、8、9 节；其余内容是开发者和 AI 按需查询的代码地图。

## 1. 结论摘要

- Windows LAN 已采用“宿主 Runner 执行命令、CAS 保存完整 `server-state`、广播完整 `stateUpdate`”的权威路径，并作为唯一跨端标准。移动端框架正在重塑，不再把 action log 作为目标架构；RED-34 不修改旧移动端入口。浏览器 Relay host 权威已禁用，Relay 也必须连接同合同的权威服务。
- 实际玩家战斗界面是 `data/pages/battle.html`，不是 React 页面。真实对战、观战和训练营共用这一个入口；`mode=training` 只切换 fixture 与调试能力，旧 `training.html` 只做兼容跳转。RED-48 起，战场 Three.js 与 HUD DOM 共用 `battle-ui/battle-view-model.js` 的展示模型和 `battle-presentation.js` 的单向输入/意图输出边界；页面仍承担网络、训练 fixture 和动作预演等历史职责；联网结果只展示权威 `terminalResult`。
- TypeScript 规则核心集中在 `lib/game/turn.ts`、`battle-setup.ts`、`skills.ts` 和 `triggers.ts`，但公共状态类型、随机、日志、存储格式和命令协议没有完全统一。
- 先稳定 Windows/Electron 发布链；Android 后续仍要支持与 Windows 相同的客户端功能和权威规则语义，但允许用 Java/WebView 适配移动端生命周期、权限、网络和存储。JS/TS 源码保持唯一真实源，Android 资源只能由构建生成。
- 当前提交被指定为正式故障基线。`BUILD_AND_RUN.md` 为空，且最后一版存在尚未定位的重大运行问题，因此下一项工程工作应先恢复可重复运行基线。

## 2. 运行时边界

| 层          | 当前入口                                                            | 当前职责                                  | 已知边界问题                         |
| ---------- | --------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| 表现层        | `data/pages/battle.html`、`data/pages/js/battle-ui/**`、`battle-renderer-3d.js` | 页面控制器、统一展示模型、DOM HUD、Three.js 战场和用户意图 | 页面仍包含网络与训练预演；联网终局只展示服务端结果 |
| Colyseus 玩家权威层 | `lib/server/colyseus/`、`standalone/colyseus/` | 单 Room actor、玩家 session、命令 FIFO、receipt、接收者投影与 PostgreSQL journal | 默认 Windows 玩家链路；单进程退出会明确中止当前局 |
| Next 服务层   | `app/`、`instrumentation.ts`                                     | 静态/Admin HTTP、状态页、训练/PVE | raw 玩家 WS 仅可用 `ENABLE_LEGACY_PLAYER_WS=1` 显式兼容开启 |
| 游戏规则层      | `lib/game/`                                                     | 状态创建、动作执行、技能、触发器、地图和回放                | 类型重复、模块级缓存和全局触发器               |
| 房间/持久化层    | `lib/game/room-store.ts`、`lib/game/battle-storage.ts`、`prisma/` | 房间状态序列化、SQLite 存取、旧格式兼容               | 外层存档无正式格式版本和迁移链                |
| PVE Run 持久化层 | `lib/pve/run-store.ts`、`lib/pve/profile-lifecycle.ts` | strict Run aggregate、revision CAS、authority reconciliation evidence/tombstone | 当前 `<userData>/pve-runs` 尚未迁入 RED-140 committed generation |
| Electron 层 | `electron/`、`electron-client/`、`electron-editor/`               | 进程、窗口、本地服务器和 IPC                      | IPC 是字符串协议，没有共享类型              |
| Android 层  | `android-client/`、`android/`、`mobile-server/`                   | 移动端框架重塑中；后续目标为同一权威 Runner | RED-34 不维护旧 action-log 入口，移动端接入另行验收 |
| Relay 层    | `relay-server/`                                                 | 遗留房间与消息转发                             | host 客户端权威已禁用；旧 standalone Relay 需重建为权威服务后才可用于战斗 |

## 3. 首要发布链路

### 3.1 LAN Electron 服务端

1. 根 `package.json` 的 `dev:electron:server` 编译 `electron/` 后启动 Electron。
2. `electron/main.ts` 的 `app.whenReady()` 调用 `startGameServer()`。
3. `startGameServer()` 以 Node `--require` 显式加载同端口 Upgrade 预加载器后启动 Next standalone；打包流程同时把预加载器注入/复制到 staged 资源，不创建第二个监听端口。
4. Next 在 `instrumentation.ts` 的 `register()` 中调用 `lib/ws-server.ts::startWsServer()`。
5. `electron/main.ts` 加载服务管理界面。

失败行为：子进程、端口、standalone 资源或注入代理失败均可能导致应用不能进入可用状态。目前没有覆盖整条链的自动冒烟测试。

当前 `win-unpacked` 仍只是内部 QA 候选。RED-140 已接受把独立 Windows Server 扩展为公开自治
Server 的目标架构，但安装器、签名、监督器、备份、更新和候选验证尚未实现；在 RED-148 完成并经
人工发布批准前，不得把现有目录产物称为公开发行物。目标发行与运维边界见
[ADR-0021](../decisions/ADR-0021-autonomous-server-operations.md) 和
[Server Operations v1](./SERVER_OPERATIONS_V1.md)。

### 3.2 Windows/Electron 玩家客户端标准流程（RED-170）

1. Electron 客户端从 `electron-client/main.ts::app.whenReady()` 自动准备 Profile、内置 PostgreSQL 与随包 Colyseus authority，然后直接进入主菜单；Host & Play 与 Training/PVE 复用该本机栈，远程地址在主菜单内显式选择。
2. `ws-client.js` 使用 Colyseus SDK 创建/加入唯一 `BattleRoom`，大厅 RPC 走原生 request/response。
3. `battle.html` 发送带 `clientActionId` 和 expected authority version/revision 的明确命令。
4. `BattleRoom` 把玩家、计时器和系统命令送入同一房间 FIFO；规则提交后直接返回精确 receipt，并按接收者投影状态。
5. 瞬时断线由 `onDrop/allowReconnection/onReconnect` 恢复同一 session；断线期间输入关闭，恢复后接收完整快照。
6. 直接 receipt 丢失时，客户端按原 `clientActionId` 请求 `applied | rejected | unknown`，所有结果都在有界时间内解除本地 pending。
7. PostgreSQL journal 异步推进普通动作 durable 水位；version 0、终局和关闭仍遵守 durable barrier。
8. 启动恢复 durable rooms 时逐房间隔离失败；旧 Profile 无法满足的历史房间保留原始记录但不注册到当前 matchmaker，也不能拖垮健康 authority。
9. 本机 authority 进程故障使用三次自动恢复预算；耗尽后进入 `manual-required`，只接受玩家显式重试。
   主菜单和远程对局保持原 renderer，不因本机服务恢复而导航；本机活动局不承诺跨进程续局。

RED-127 起不再提供玩家 HTTP 后备入口。大厅、目录、房间、选将、战斗与恢复全部走同源 WebSocket；
旧玩家 REST 在实际服务边界返回 410，静态资源继续使用 HTTP。RED-127 中
`/api/admin/**` 只描述历史非自治边界；RED-140 自治发行不得把它或任何 management route 注册到
玩家 listener，唯一 operator 入口是 trusted IPC，child adapter 仅在独立 loopback `/v1/**`。
决策见 [ADR-0020](../decisions/ADR-0020-unified-player-websocket-transport.md) 与
[ADR-0021](../decisions/ADR-0021-autonomous-server-operations.md)。RED-170 后默认玩家实现由
[ADR-0027](../decisions/ADR-0027-colyseus-single-session-match-lifecycle.md) 约束；旧 raw WS 只保留显式兼容开关，
不允许与 Colyseus 同时作为同一对局的权威。

### 3.3 Android 开服：当前遗留与迁移目标

Android 已存在可接受 LAN 连接的开服外壳，但当前战斗权威语义与 Windows 不同：

1. `android/app/src/main/java/com/redvsblue/client/MobileHttpServer.java` 使用 `ServerSocket` 提供 LAN HTTP/WebSocket。
2. `GameEngineWebView.java` 在隐藏 WebView 中加载生成的 `mobile-server.js`。
3. `mobile-server-entry.ts` 初始化战斗后保存 `{ type: "action-log", seed, actions }`；普通动作只检查 trace 诊断并追加 `seq`。
4. 服务广播 `actionLog` / `battleSnapshot.actions`，由各客户端在 `battle.html` 中调用 browser Runner 重放，因此 Android 宿主没有像 Windows 一样保存每步完整权威状态。
5. `db-shim.ts` 说明当前 Android 服务只用内存状态，不等同于 Windows Prisma 持久化。

RED-81 的目标不是让 Android 原样运行 Next/Prisma，而是让隐藏 WebView 对每个命令调用与 Windows 同合同的 browser-safe Runner，保存版本化完整状态并广播同语义结果。Java 层只保留 Socket、前台服务/通知、权限、本地存储和恢复适配。生产路径中的 `action-log` / `actionLog`、`battleSnapshot.actions/seq` 与客户端日志回放将全部删除，不保留双模式。

## 4. 不同模式的状态权威

| 模式 | 当前权威 | 动作执行位置 | 持久化位置 |
| --- | --- | --- | --- |
| Windows 开服 | Next/WS 服务端中的房间状态 | `runBattleAction()` → `applyBattleAction()` | Prisma `Room.battleState` |
| Windows PVE（RED-117） | `PveRunStoreV1` strict aggregate | `PveServiceV1` → 正式 Battle Runner | 当前 JSON Run Store；RED-140 目标为 committed data generation 内唯一 `pve-runs` root |
| Android 开服（当前遗留） | `mobile-server-entry.ts` 的 action log | 客户端按 `seq` 调用浏览器 Runner 回放；宿主不裁决完整结果 | WebView 内存日志；RED-81 将删除 |
| Relay | 同合同的远端权威房间服务 | 浏览器只发送 action 并消费 `stateUpdate` | 旧 host 权威 Relay 被客户端拒绝，需重建服务后启用 |
| Training | `battle.html?mode=training` 的客户端内存状态 | 浏览器 `trainingApiFetch()` → `GameEngine.applyBattleAction()` | 仅页面内存 |
| Android 开服（迁移后目标） | Android 宿主中的完整 `server-state` | 隐藏 WebView 的同一 browser-safe Runner | Android 本地持久化适配器 |

同一设备可以同时承担服务端和客户端角色，但两种职责必须保持独立；本机玩家也必须通过与远端玩家相同的命令协议操作权威服务端。近期先以 Windows 完成并验证这条标准；Android 后续实现功能对等，效果和系统外壳可以不同。Relay 和 Training 不阻塞 Windows 基线。

## 5. 源码和发布产物

当前至少存在以下引擎/页面复制路径：

- 规则源码：`lib/game/*.ts`。
- 浏览器入口：`lib/game/engine-browser-entry.ts`。
- 页面中的引擎文件：`data/pages/js/game-engine.js`。
- Android 资源：`android-client/www/js/game-engine.js`。
- 构建脚本：`scripts/build-game-engine.js`、`scripts/sync-pages.js`、`scripts/sync-android-assets.js`。

已确认愿景：JS/TS 源码是唯一真实源，Android 包及其中的 JS 都是可删除后重新生成的发布产物。

待确认：现有构建脚本的正确执行顺序，以及哪一步会覆盖 `android-client/www/js/game-engine.js`。在建立 hash/来源校验之前，不应删除任何历史副本。

## 6. 当前架构风险

1. `battle.html` 的战场/DOM 表现已建立模块边界，但页面控制器仍跨越网络、训练规则预演和展示层。
2. Android action-log 与 Windows server-state 会产生版本、丢包、重连回放和客户端分叉风险；RED-81 必须删除旧框架并禁止生产双模式。
3. `lib/game/turn.ts`、`battle-types.ts`、`training-types.ts` 都定义了相似状态/动作类型。
4. `globalTriggerSystem`、规则缓存和 RNG 是模块级状态，并发隔离未验证。
5. 存档外层格式、IPC、WS 和 Relay 消息缺少共同版本。
6. Next 构建配置允许忽略 TypeScript 错误，运行故障可能直到打包或运行时才暴露。
7. JSON 技能/卡牌/Rule 代码由 8 个分散的直接 `eval` 调用点执行；重复 dry-run 和候选枚举可能重复编译，而且 direct eval 不是安全隔离边界。

## 7. 已确认的目标架构

- Windows/Electron 的完整权威状态架构是参考标准；先把 Windows 做稳定，再迁移 Android。
- Android 后续仍可开服或加入，并提供相同客户端功能；平台差异只留在网络、存储、权限、通知和生命周期适配。
- JS/TS 源码是唯一真实源；Android 只消费生成产物。
- 每局只有一个当期权威服务端，负责状态、规则、胜负和存档确认；客户端发送命令并显示结果。
- Android 不保留 action-log、按 seq 客户端回放或生产双模式；Action Trace 只作调试证据，不作共享状态来源。
- 服务器规则自治，不存在全局唯一“官方规则”。服务器决定规则包、游戏数据和胜负判定。
- UI 只发送明确命令并显示结果，不复制规则。
- 相同初始状态、种子和命令序列可以重放到相同 hash。
- 不兼容公开测试前的旧存档；兼容承诺从新版本化存档格式开始。
- 先恢复稳定运行和可观察性，再做模块拆分。
- 动态代码由一个受信任内容运行时集中编译并按 `{surface,id,version,codeHash}` 缓存、精准失效；编译函数只存内存。若未来运行不受信任脚本，必须另建独立隔离方案。
- 独立 Windows 自治 Server 的整体生命周期、进程、文件、备份和应用更新只有 Electron main 一个
  写权威；renderer 只通过受信 preload IPC 消费版本化状态，Next/RoomRuntime 只提供准入、健康、
  durable 水位和房间观察值。
- 自治 Server 的本地管理面与玩家 WebSocket 分离：只允许 loopback transport 加每进程随机
  capability，不信任 Host、Origin、X-Forwarded-For，也不复用静态 `admin-secret-key`。

## 8. 延期愿景索引

以下方向已经讨论，但不属于 RED-9，也不要求项目负责人现在完成设计。后续每次只选择一个模块建立独立任务和 ADR：

| 模块 | 已确认方向 | 当前处理 |
| --- | --- | --- |
| 存档与恢复 | 掉线暂停；参与者持有记录；不兼容公开测试前旧存档 | 延期，先恢复运行基线 |
| 身份与签名 | RED-140 已冻结本服 UUID、release manifest 签名与备份迁移；跨服证明、账号恢复和撤销网络仍延期 | 本服最小闭环见 ADR-0021；跨服能力仍需独立 High Risk 威胁模型 |
| 加密与随机 | 存档/传输加密；隐藏信息隔离；随机过程最终可审计 | High Risk，暂不选算法 |
| 服务器规则 | 服务器规则自治；规则/数据 hash 一致才开局；规则脚本需沙箱 | High Risk，先验证现有规则引擎 |
| 回放与账号 | 正常终局自动匿名回放；账号私钥可加密备份 | 长期产品模块 |

ADR-0021 已固定 Windows Server 发行清单的 Ed25519 签名、Authenticode、密钥轮换和本服 UUID；
它不批准玩家账号密钥、跨服信任、撤销网络、端到端加密或规则脚本沙箱。后者的详细字段、算法和
托管方式仍不是当前承诺，必须另建 High Risk 任务。

## 9. Demo 边界

公开测试 Demo 分阶段实现。当前优先：

1. Windows/Electron 能稳定开服和加入。
2. Windows 房间核心、服务端权威状态和胜负形成可验证基线。
3. 协议、规则和数据 hash 检查。
4. 新格式基础本地存档与签名动作链。
5. 当前重大运行故障的稳定复现和修复基线。
6. 后续由 RED-81 让 Android 达成功能对等并删除 action-log；不阻塞当前 Windows 交付。

端到端加密、完整恢复协议、服务器迁移/撤销、规则下载沙箱、公开回放平台、社交账号恢复网站属于长期愿景，必须拆为独立 High Risk 任务，不能阻塞第一版 Demo。

## 10. 相关文档

- `ENGINE_CORE.md`：状态、命令和核心规则调用链。
- `MODULE_INTERFACES.md`：模块接口、调用方和错误行为。
- `GAME_LOGIC_SYSTEM.md`：权威边界、接口、流程图、Android 迁移和动态代码执行说明。
- `DEBUGGING.md`：故障基线、日志、测试和复现流程。
- `MODULE_STATUS.md`：当前状态、风险和后续任务优先级。
- `SERVER_OPERATIONS_V1.md`：自治 Server 生命周期、管理 API、发行身份、备份和更新合同。
- `ADR-0021-autonomous-server-operations.md`：公开自治 Server 的产品、发行与安全决策。

## 11. RED-109 低延迟权威管线

RED-109 将 Windows LAN 普通动作从“完整 Room JSON CAS + 完整 stateUpdate”迁移为每房间 FIFO 中的
`command → authoritative rules → memory authority commit → receipt/recipient patch → async Δ journal`。大厅元数据继续使用
`Room.version`；战斗连续性使用独立 `battleAuthorityVersion`。完整快照只用于初始化、重连和 patch/hash
恢复，联网客户端不通过本地规则 dry-run 判断候选。

初始 checkpoint 建立后，在线裁决只读取每房间内存权威。Prisma/SQLite 在单一后台 writer 中按序保存
Transition Δ、receipt 和周期 checkpoint；其 `durableAuthorityVersion` 可以落后于在线版本，失败时显式
区分瞬时恢复和永久 degraded。SQLite 使用 WAL；锁/事务超时保留队首 job 并退避重试，但单个 job
最多 5 次或 10 秒，超过后只暂停该房间并继续其他房间。审计、hash、约束、损坏、I/O 或队列溢出
立即暂停对应房间。WAL 不是应用层持久化队列，因此仍不承诺强杀/断电前尚未
durable 的动作零丢失，但数据库写锁不再阻塞游戏 ACK。

内部和公开数组 patch 对尾部做逐项追加/逆序删除，避免累计 `actions` 每次整体复制。协议 v3 另为内部
和各接收者公开状态维护 32 项固定块的确定性哈希索引，普通动作只重算受影响块与根；客户端完整快照
仍只用于初始化、重连和 hash 恢复。checkpoint、换回合、每 20 个版本和终局会执行全量哈希审计。
v2 持久化链只允许完整恢复，不允许与 v3 继续混写；客户端订阅和动作必须匹配 v3 build。

规则/技能 JSON 默认按服务进程缓存；显式内容刷新会清缓存。每步 Trace 进入 append-only journal，热状态
只保留确定性游标和序号，终局再物化完整 Trace v2。具体协议、恢复、性能门槛和回退见
`docs/decisions/ADR-0017-authority-transition-pipeline.md`。

## 12. RED-140 Windows 自治 Server 合同

RED-140 只冻结跨模块合同，不改变当前运行时。获准的 v1 目标同时支持 Windows 10 22H2 x64 与
Windows 11 x64；Windows 10 的应用兼容承诺不表示微软仍为其提供常规系统安全支持。公开形态包含
per-user assisted NSIS、update ZIP 与 signed runtime catalog；`win-unpacked` 继续只供内部 QA，
不提供公开 Portable、Windows Service、开机自启或静默更新。

整体生命周期使用 `stopped | starting | ready | maintenance | draining | stopping | degraded |
failed | updating | rollback-required`。`ready` 不是“进程存在”，而是 process、真实玩家 WS 101/
`system.health`、DB schema、管理 API、持久化、RoomRuntime、PVE Run Store、Profile 与 release
tuple 全部通过；单个房间 durable 失败保持房间级 degraded，不应拖死其他房间或自动把全服改成
degraded。全局 DB/PVE Store transient unavailable 只有在 integrity、唯一 writer 与 committed
generation 仍可证明时才 degraded/closed；corrupt、集合不完整、未知 schema 或无可信唯一 writer
必须 failed/closed。

应用更新固定走 room + PVE maintenance、blocker/drain、verified backup、side-by-side
stage/migrate/health、原子 commit 和 reopen。Profile 激活仍由 RED-115 的独立状态机负责；活动 PVE
battle 复用其 lease，Run persistence/reconciliation 复用 RED-117，房间身份复用 RED-116，玩家协议
复用 RED-127，FIFO/WAL/有限重试和 durable 水位复用 RED-131。RED-117 当前
`<userData>/pve-runs` 只是迁移输入；目标 live Store 与 audit evidence/tombstone 必须在 deployment
pointer 选择的 data generation 内一起备份/恢复，不能双写、merge 或重算。backup 的 active Profile
只作为 verified immutable package + identity，restore 必须走 RED-115 candidate/health/commit/recovery，
不得复制 `active.json`。具体 schema、转换、错误、
超时、数据根、威胁与故障矩阵以 [Server Operations v1](./SERVER_OPERATIONS_V1.md) 为唯一合同。
