# ADR-0009：部署选择锁定、权威超时与公开同步

- 状态：部分被 ADR-0011 与 ADR-0019 取代。独立 `relay-server` 的 Relay host 验签/战斗角色、浏览器 host-authority、host 状态上传与恢复条款已由 ADR-0019 的赛前 REST 决策取代；HTTP/LAN 的签名边界以及部署锁定、超时、公开投影、房间 CAS 与随机合同继续有效。
- 日期：2026-08-17
- 关联任务：RED-31
- 风险：Medium

## 背景

ADR-0007 冻结了确定性初始部署和玩家独立重投随机流，但其临时协议把首次 `deploymentChoice` 当作不可撤销提交，且没有正式锁定命令、45 秒权威计时、房间版本并发边界和公开传输投影。RED-31 需要在不改变 RED-29 随机消费与最终位置算法的前提下完成部署闭环。

## 决策

### 选择与锁定

- 部署初始化进入 `deployment.status = "awaiting-locks"`，保存 `startedAt`、`deadlineAt = startedAt + 45_000`、双方 `locks` 与单调 `revision`。
- `deploymentChoice` 只允许玩家选择自己的一枚存活核心棋子；`pieceId: null` 取消当前选择并表示保留全部。玩家锁定前可替换或取消选择，选择命令不移动棋子、不消费重投流。
- `deploymentLock` 不可撤销。重复锁定、锁定后改选、敌方/未知/非核心棋子和部署阶段外命令都失败且不写状态、房间版本或随机 cursor。
- 第二名玩家锁定时，服务端按稳定玩家 ID 顺序一次解析双方最终选择，继续使用 ADR-0007 的 `deployment-reroll/<playerId>` 独立流，然后触发 `gameStart` 并进入首回合行动阶段。

### 45 秒权威超时

- 服务端注入 `DeploymentRuleClock`，初始化和测试不直接依赖客户端时间。
- 到达 `deadlineAt` 时，未锁定玩家的待选重投作废，按保留全部自动锁定，锁定原因记录为 `timeout`。
- 计时回调与玩家命令调用同一房间协调器；如果玩家命令与超时竞争，房间版本 CAS 只允许一个提交，失败方重新读取并按最新状态决定重复、过期或拒绝。
- 进程计时器只负责唤醒；任何迟到命令也会先检查权威时钟并补交超时，因此休眠、重启或计时器延迟不会延长部署窗口。

### 公开状态与传输

- `toPublicBattleState()` 是部署公开投影。部署期间两名玩家和观战者收到相同的 16 枚核心棋子坐标、锁定状态、期限和版本。
- 公开投影移除 `deployment.choices` 与内部 `debugBattle` 动作记录；未完成前还移除最终坐标，避免通过 HTTP、WebSocket、Relay、观战、动作 hash 或调试扩展提前泄露选择。完整 trace 只保存在服务端权威状态。
- `viewerPlayerId` 只用于验证谁可以提交玩家命令，不控制站位可见性。
- 玩家 HTTP/LAN WebSocket 与实际承担战斗权威的桌面/Android 本机服务命令携带 Ed25519 签名信封，签名覆盖房间 ID、玩家 ID、完整动作和 60 秒有效时间；权威服务校验公钥派生 ID、签名、动作和连接玩家一致后才进入协调器。仅声明 `x-player-id`、body player 或 WS subscribe player 不构成认证。
- 独立 `relay-server` 的战斗订阅、host/guest 战斗权威角色与 host 状态更新条款已被 ADR-0019 取代；RED-119 只保留赛前 REST 与真实房间 `roomUpdate`，不接受浏览器上传战斗状态。
- `createPublicRoomSnapshot()` 同样投影普通房间 GET、重复 start 和 rejoin/leave 等返回的嵌套 `battleState`，防止绕过 battle 快照入口读取选择或 trace。
- HTTP 与 LAN WebSocket 共用 `dispatchRoomBattleAction()`；成功快照统一返回 `{ state, seed, stateHash, authorityVersion }`。桌面/Android 本机权威入口只广播公开投影和单调 `authorityVersion`；浏览器不保留权威私有状态。
- 桌面 Next `/api/relay-battle-init` 与 Android mobile server `handleRelayBattleInit` 按 [ADR-0019](./ADR-0019-selectable-demo-maps.md) 在 seed 前重新校验调用方已经冻结的受控 `mapId`，返回版本 1 的 `{ state, seed, stateHash, authorityVersion }`。这两个兼容入口不持有或写入 `Room`、当前没有 UI 调用方，也不能作为房间地图冻结或独立 `relay-server` 开战、host 接管、状态恢复的证据。

### Trace、日志与版本

- 部署 trace 记录初始化位置、选择/锁定/超时命令、双方锁定状态、超时玩家、最终位置、部署 revision、随机流 cursor 和该命令提交后的房间 `authorityVersion`。
- 房间错误日志包含 room、动作玩家、viewer、阶段、action ID、seed 和权威版本；不得记录凭据或私钥。
- `extensions.debugBattle` 不参与权威状态 hash，因此补写 trace 的房间版本不改变既有确定性 hash 合同。

## 被取代的临时协议

本 ADR 仅取代 ADR-0007 中“初始化为 `awaiting-choices`、首次 `deploymentChoice` 不可改选、双方选择齐备即结算”的临时状态机。ADR-0007 的地图、出生池、16 次初始消费、独立重投流、候选池和稳定解析顺序继续有效。

## 影响

- Demo 开战入口必须提供权威部署开始时间，并在初始提交后注册超时唤醒。
- PVE 机器人通过同一 `deploymentLock` 命令保留全部；人类仍须锁定或等待超时。
- 客户端在部署阶段复用主操作按钮确认锁定，点击己方核心棋子选择/取消重投；不增加正式视觉动画范围。
- 房间战斗写入要求数字版本并使用 CAS；旧的直接覆盖式 HTTP/WS 写入不再用于部署命令。

## 验证方式

- 固定 seed 的选择替换、取消、双锁顺序、全保留、单方重投和锁后拒绝测试。
- 45 秒前拒绝、到点自动保留、迟到命令与超时竞争测试。
- Promise 并发锁定的单次最终提交、单调版本和单份最终位置 trace 测试。
- HTTP/WS 等价、玩家/观战者公开快照一致、Relay 初始化/投影和伪造身份无写入测试。
- TypeScript、lint、浏览器引擎构建和 battle 页面脚本/合同测试。

## 回退方式

回退 RED-31 的独立提交，恢复 ADR-0007 的临时选择协议和旧直连传输。回退不修改 ADR-0007 冻结的地图、出生算法、随机流、存档版本或选人合同。若只关闭新入口，可停止下发 `deploymentEnabled`，旧非部署战斗初始化仍保持兼容。

## 相关资料

- [RED-31](https://linear.app/redvsblue/issue/RED-31)
- [ADR-0001：部署阶段公开双方站位](./ADR-0001-deployment-visibility.md)
- [ADR-0007：固定全地图部署与玩家独立重投流](./ADR-0007-deterministic-deployment.md)
- [Demo v0.1 核心对局合同](../product/DEMO_V0_1_CORE_MATCH_CONTRACT.md)
- `tests/game/deployment.test.ts`
- `tests/game/deployment-room.test.ts`
- `tests/roster-transports.test.ts`
