# 模块接口地图

状态：RED-9 代码核对稿

基线：`594977b`

本文件记录当前真实接口。标为“愿景”的内容尚未实现。

本文面向开发和调试，按模块查阅即可；人工审查入口统一放在 `MODULE_STATUS.md`。

## 1. 规则归约器

- 入口：`lib/game/turn.ts::applyBattleAction()`。
- 职责：校验动作并产生下一战斗状态。
- 输入：`BattleState`、`BattleAction`。
- 输出：`BattleState`。
- 调用方：`battle-runner.ts`、`engine-browser-entry.ts`、规则测试。
- 调用：技能、触发器、地图/棋子、Rule 和 statusTag 逻辑。
- 状态变化：回合、阶段、单位、资源、卡牌和 pending selection。
- 错误：`BattleRuleError`、版本错误、效果执行异常。
- 日志：`turn.ts` 的本地日志函数及 `game.log`。
- 测试：`tests/game/turn.test.ts`。
- 已知问题：文件职责过大；与 `battle-types.ts`/`training-types.ts` 类型重复。
- 最小调试：使用固定 `_v` 的状态调用 `applyBattleAction(state, action)`，比较输入和输出 hash。

### 1.1 共享空间规则（RED-30）

- 入口：`lib/game/spatial.ts`。
- 职责：提供曼哈顿距离/范围、方形范围、横纵直线格序列、存活棋子占位查询和普通移动合法集合。
- 输入：只读地图、棋子和坐标；不访问窗口、存储、时间或随机源。
- 输出：确定性的坐标/占位结果，或包含拒绝代码、位置与消息的普通移动失败结果。
- 调用方：`turn.ts` 的权威移动验证、`ai.ts` 的候选动作、`engine-browser-entry.ts` 导出的 UI 高亮接口，以及默认距离调用点。
- 普通移动边界：仅横向/纵向且不超过 `moveRange`；不可行走地形与路径上的任意存活棋子阻挡；死亡/墓地棋子不阻挡；掩体是否可进入由地图的 `walkable` 属性决定。
- 排除：技能位移、推拉、传送不会隐式调用普通移动验证器，必须由技能实现明确选择空间工具。

### 1.2 确定性弹道事实（RED-32）

- 入口：`lib/game/spatial.ts::traceProjectile()`；输入只读地图、棋子、起点、单位横纵方向和可选最大距离，输出按距离排序的 `cell → living piece → terrain` 事实以及首个边界事实，不访问时间或随机源，也不修改状态。
- 地形事实：显式 `bulletPassable`/旧 `bullet` 优先；没有显式值时墙和掩体阻挡、洞穴通过。占据掩体的存活棋子事实先于掩体阻挡事实；技能代码自行决定友军伤害、停止、穿透或忽略地形。
- 迁移清单：`sleep-dart`、`blackwidow-lethal-strike`、`hellfire-shotgun` 使用共享弹道事实；经人工批准，`death-blossom` 改为自身中心 3×3 的纯范围伤害并使用 `form: area`，不再参与弹道阻挡。
- 测试：`tests/game/spatial.test.ts`、`tests/game/projectile-trace.test.ts`、`tests/game/movement-contract.test.ts`、`tests/game/turn.test.ts`、`tests/game/ai-movement.test.ts`。

## 2. 战斗 Runner 与两类回放

- 入口：`lib/game/battle-runner.ts::runBattleAction()`、`replayBattle()`，以及 `lib/game/battle-trace.ts` 的回放归档函数。
- 职责：动作 ID、动作级确定性 runtime、运行时技能补全、权威 hash、幂等、脱敏规则命令 Action Trace；成功权威动作还追加 Trace v2 的记录状态帧。
- 输入：状态/动作/`rootSeed`，或初始状态/seed/动作序列。
- 输出：状态、`stateHash`、`actionHash`、`duplicate`、`trace`，或含逐动作 `stateHashes` 的规则重放结果。
- 调用方：WS、房间 HTTP API、训练/调试 API、测试。
- 调用：`applyBattleAction()`、稳定 JSON/hash、`RuleRuntime`。
- 状态变化：会写入 `state.extensions.debugBattle`；初始化记录脱敏初始检查点，成功命令记录命令后检查点、语义事件、随机流和 hash 链；返回下一状态。
- 错误：规则错误附加 seed、stream/cursor、turn、player、actionId 后向上抛；上层保留原选择中断字段。被拒绝动作和重复动作不能追加回放帧。
- 两类回放必须区分：
  - `replayBattle()` 是同版本开发/测试中的确定性规则重放，会执行当前规则。
  - `rvb-match-trace/v2` 回放器是面向已结束比赛的记录状态查看器，只读取事实检查点，不执行当前规则。
- 日志：主要依赖调用方；调试元数据保存在状态扩展中。
- 测试：`tests/game/debug-battle.test.ts`、`tests/game/deterministic-runtime.test.ts`、`tests/game/developer-tools-trace.test.ts`。
- 已知问题：runtime 是同步进程作用域，不能跨异步规则边界；旧训练/浏览器调用方尚可省略 seed；完整检查点会增加终局投影体积。
- 最小调试：同版本规则问题保存初始状态、seed、动作序列并调用 `replayBattle()`；线上已发生比赛优先导出 v2，在局外回放器核对记录状态和双 hash 链。

## 3. 战斗初始化

- 入口：`lib/game/battle-setup.ts::createInitialBattleForPlayers()`。
- 职责：根据玩家、选人和地图生成初始状态。
- 输入：玩家 ID、阵营模板、选择、地图 ID、先手选项和可选 `rootSeed`。
- 输出：`Promise<BattleState | null>`。
- 调用方：房间开战、训练/PVE/调试场景。
- 调用：地图、技能、规则、棋子和全局触发器。
- 状态变化：创建状态并修改全局触发器注册。
- 错误：玩家数错误返回 `null`；数据加载/效果错误可能抛出。
- 日志：`battle-setup.ts` 本地日志。
- 测试：`tests/game/deployment.test.ts`、`tests/game/deployment-room.test.ts`、`tests/roster-transports.test.ts`。
- 已知问题：全局触发器；所有新增权威入口都必须显式传入 root seed。
- 最小调试：显式传入 `firstPlayerId` 与 `rootSeed`，输出初始化 trace、状态 hash 和棋子列表。

### 确定性规则运行时（RED-28）

- 入口：`lib/game/rule-runtime.ts::RuleRuntime`、`withRuleRuntime()`、`withRuleRuntimeCheckpoint()`。
- 职责：根种子规范化、命名流派生与 cursor、规则时钟、实例 ID、动态规则 `Math`/`Date` 能力。
- 稳定流：`deployment`、`deployment-reroll`、`turn-order`、`skill/effect`；实例 ID 为 `instance-id/<namespace>`。
- 约束：规则执行保持同步；预检必须使用 checkpoint；视觉随机不得进入权威 seed、状态或 hash。
- 兼容：`rng()` 在 runtime 激活时路由至 `skill/effect`，未激活时保留旧适配器。
- 决策：[ADR-0004](../decisions/ADR-0004-deterministic-rule-runtime.md)。

### 身份模型（RED-27）

对局座位 `seat: red | blue`、内容阵营 `alignment: light | dark`、棋子 `ownerPlayerId` 与先手 `firstPlayerId` 是独立字段。敌我只能按 `ownerPlayerId` 判断；`room-store` 中的 `faction: red | blue` 仅用于读取旧房间数据的座位兼容。详见 [ADR-0002](../decisions/ADR-0002-match-identity-model.md)。

### Demo 阵容合同（RED-26）

- `lib/game/roster-contract.ts` 是 HTTP 与 WebSocket 的共享服务端校验边界；客户端筛选仅用于即时提示。
- 服务端按 `demo-v0.1` 读取 `data/pieces/manifest.json`，要求玩家从自己的 `alignment` 中提交正好 8 个不同、已准入且存在的 `templateId`。
- 成功确认会写入 `rosterLocked` 与 `rosterManifestVersion`。同一组模板的重排提交返回幂等成功；锁定后的不同阵容或阵营修改返回 `ROSTER_LOCKED`。
- 错误响应包含稳定的 `code`、`message` 与 `context`；HTTP 与 WebSocket 复用同一错误载荷。
- `lib/game/room-battle-start.ts` 在启动前重新检查双方阵容，并通过房间版本号原子提交战斗状态；只有双方合法锁定时才可通过当前战斗初始化入口。该入口忽略房间请求中的地图覆盖，强制使用并持久化 Demo 固定地图状态 ID `large-hole-arena`（数据文件仍为 `large-trap-arena.json`）。

### 部署房间协调器（RED-31）

- 入口：`lib/game/room-battle-actions.ts::dispatchRoomBattleAction()`、`scheduleRoomDeploymentTimeout()` 与 `createPublicBattleSnapshot()`。
- 职责：验证 viewer/动作玩家、在 45 秒期限前后选择实际命令、调用唯一规则 Runner、通过 `Room.version` CAS 提交并生成公开快照。
- 状态命令：`deploymentChoice` 可在锁定前替换/取消；`deploymentLock` 不可撤销；`deploymentTimeout` 仅允许权威服务端时钟发出。
- 并发：玩家同时锁定或玩家锁定与超时竞争时，失败的 CAS 重新读取最新房间；最终位置只提交一次，`authorityVersion` 单调递增。
- 公开边界：`lib/game/deployment.ts::toPublicBattleState()` 对玩家和观战者公开相同双方坐标与锁定状态，清除选择和 `appliedActionIds`，未完成前同时清除最终位置和完整 action trace；只有权威 `terminalResult` 已提交后才公开脱敏完整 trace。
- 传输：房间 HTTP、WebSocket 和 Relay 使用 `{ state, seed, stateHash, authorityVersion }`；`viewerPlayerId` 只做提交权限校验，不参与站位隐藏。
- 身份：玩家命令必须携带 Ed25519 签名信封，覆盖 room/player/完整 action/timestamp；HTTP 与 LAN WS 在服务端验证，Relay guest 动作由 host 验证。Relay 订阅另签名 `battle-subscribe` 信封，relay-server 验证派生 ID、有效期及房间登记公钥后才绑定 host/guest 角色。header/body/subscribe 中的同名字符串不能单独授权命令或 host 状态写入。
- 房间投影：`createPublicRoomSnapshot()` 覆盖普通 room GET、重复 start 与其他完整房间响应，不能绕过 battle API 读取 pending choice 或进行中对局的 debug trace；终局 trace 只经终局 battle snapshot 暴露。
- Relay：桌面与 Android 本机初始化入口固定地图并从 authority version 1 开始；host 保留完整权威状态，只把公开状态、签名命令和版本 envelope 经 relay-server 转发/恢复。
- 错误：非法、重复锁定、伪造身份和过期命令不得写状态/版本/cursor；错误上下文含 room、player、phase、action ID、seed 和 authority version。
- 决策：[ADR-0009](../decisions/ADR-0009-authoritative-deployment-lock.md)。

### PVP alignment lock (RED-56)

- Once a player marks ready in the lobby, the server-recorded `alignment` is immutable for piece selection. A forged cross-alignment `claim-faction` or `select-pieces` request returns `ROSTER_ALIGNMENT_LOCKED` and leaves the room unchanged.
- `select-pieces` validates against the stored player alignment, never the request alignment. Seat (`red`/`blue`) remains independent, so same-alignment matches remain valid.
- `piece-selection.html` renders the lobby alignment as read-only, disables both alignment controls, and filters the displayed templates to that locked alignment.

## 4. 技能、卡牌与规则数据

### 4.1 权威目标查询边界

- 入口：`lib/game/targeting.ts::prepareAction()`、`validateTargetRef()`。
- 输入：只读 `BattleState` 与行动草稿；选择提交还包含 `selectionId` 和 `stateRevision`。
- 输出：`ready`、稳定 `invalid.code`、声明式 `needOption`，或包含精确棋子/地格候选的 `needTarget`。
- 调用方：`turn.ts` 最终校验、`ai.ts`、`battle.html`、pending target 会话、HTTP/WS 错误 envelope。
- 纯度：不得调用 reducer、触发器、效果代码、时间或 RNG；候选枚举和最终提交必须复用同一验证器。
- 数据边界：动态选择必须补充 `targeting.steps`；无法声明时以 `TARGET_DECLARATION_MISSING` 失败关闭。
- 兼容边界：两份现存 `skill-targeting.js` 仅映射 `preparation.candidates` 到展示坐标，不再执行技能。

- 入口：`lib/game/skills.ts` 的 `loadCardById()`、`loadRuleById()`、`executeCardFunction()`、`executeSkillFunction()`。
- 职责：加载并执行数据驱动规则。
- 输入：ID、状态、使用者、目标和效果上下文。
- 输出：定义或执行后的状态/结果。
- 调用方：`turn.ts`、触发器、战斗初始化。
- 调用：卡牌/规则数据、伤害、治疗、Rule/statusTag 和触发器。
- 状态变化：单位 HP、资源、卡牌、规则和 pending target。
- 错误：定义缺失、动态代码失败、目标不合法。
- 日志：`skills.ts` 本地日志和 `game.log`。
- 测试：部分通过 `turn.test.ts` 和 `debug-battle.test.ts` 间接覆盖。
- 已知问题：模块级缓存、动态效果代码、调用关系难追踪。
- 最小调试：记录 card/skill ID、actor、target、seed、前后 state hash。

## 5. 触发器系统

- 入口：`lib/game/triggers.ts::TriggerSystem`、`globalTriggerSystem`。
- 职责：注册规则并在游戏事件上执行触发器。
- 输入：触发事件、战斗状态和上下文。
- 输出：触发结果/修改后的状态。
- 调用方：技能、战斗初始化、回合规则。
- 调用：具体规则和技能效果。
- 状态变化：可间接修改任意规则状态；注册表是进程级状态。
- 错误：触发器异常可能向上抛，也可能被调用层记录后忽略。
- 日志：`triggers.ts` 本地日志。
- 测试：`debug-battle.test.ts` 有部分所有权场景。
- 已知问题：跨房间隔离待确认。
- 最小调试：在单个触发事件前后导出注册规则 ID、房间 ID 和状态 hash。

## 6. WebSocket 服务

- 入口：`lib/ws-server.ts::startWsServer()`。
- 职责：房间连接、玩家消息、开始游戏、执行动作和广播状态。
- 输入：字符串 JSON 消息，如 `action`、房间/选择消息。
- 输出：`stateUpdate`、房间状态或错误消息。
- 调用方：`instrumentation.ts`；客户端 `RvBWs`。
- 调用：`RoomStore`、战斗初始化、`runBattleAction()`。
- 状态变化：内存连接表、房间、Prisma 状态和广播序列。
- 错误：解析、房间不存在、规则异常、数据库异常；错误 envelope 不统一。
- 日志：控制台和局部捕获。
- 测试：没有确认到 WS 集成测试。
- 已知问题：部分空 catch；协议无公共版本；种子生成与初始化顺序不统一。
- 最小调试：记录 roomId、connection/player、message type、action ID、seed、前后 hash。

## 7. 房间 HTTP 动作 API

- 入口：`app/api/rooms/[roomId]/battle/route.ts::POST`。
- 职责：WebSocket 之外执行房间动作并广播。
- 输入：URL roomId 和请求 JSON 动作。
- 输出：新状态或 HTTP 错误响应。
- 调用方：浏览器/客户端 HTTP 后备路径。
- 调用：`dispatchRoomBattleAction()`、`RoomStore.setRoomIfVersion()`、WS 广播。
- 状态变化：房间战斗状态和数据库修订号。
- 错误：无效 JSON、房间不存在、规则/数据库错误；持续 CAS 竞争返回 `ROOM_VERSION_CONFLICT`（409），终局后的竞争动作返回 `BATTLE_ALREADY_TERMINAL`（400）。
- 日志：API 控制台输出。
- 测试：`tests/roster-transports.test.ts` 覆盖 HTTP/WS 同状态与并发双投降；终局守卫另见 `tests/game/terminal-transport.test.ts`。
- 已知问题：HTTP 与 WS 的选择错误 envelope 仍不完全相同；真实 Prisma 多实例竞争尚无 E2E。
- 最小调试：使用同一房间快照分别走 WS/HTTP，比较状态 hash。

## 8. RoomStore 和战斗存储

- 入口：`lib/game/room-store.ts::RoomStore`、`setRoom()`、`setRoomIfVersion()`；`lib/game/battle-storage.ts::getBattleStorage()`。
- 职责：JSON 序列化、Prisma 读写、存储格式兼容。
- 输入：Room/存储 JSON/期望修订号。
- 输出：Room、兼容读取结果或并发失败。
- 调用方：WS、房间 API、调试接口。
- 调用：Prisma SQLite。
- 状态变化：数据库 Room；反序列化会重建运行时字段。
- 错误：JSON 损坏、数据库错误、版本竞争。
- 日志：主要由调用方记录。
- 测试：没有新格式存档 round-trip 测试；公开测试前旧格式不要求兼容。
- 已知问题：权威战斗动作已用 `setRoomIfVersion()`；其他房间写入仍混用 `setRoom()`，且外层无格式版本、部分字段读取时重置。
- 最小调试：用新格式 fixture 执行读取—写回—再读取，比较关键字段、动作链和状态 hash，而不是只比较 JSON 文本。

## 9. 浏览器战斗 UI

- 入口：`data/pages/battle.html::doAction()`、`applyServerState()`、`handleGameOver()`。
- 路由：`battle.html` 是真实对战、观战和训练营的唯一战斗页面；训练营通过 `mode=training` 启用 fixture 与调试控件。`training.html` 仅保留兼容跳转，不得实现棋盘、选中、目标高亮或动作提交。
- 职责：显示状态、收集输入、发送动作和接收服务端状态。
- 输入：玩家交互、WS/Relay 消息、完整战斗状态。
- 输出：动作消息、页面渲染、权威 `terminalResult` 的只读展示，以及终局后 `rvb-match-trace/v1` 的本地保存与下载。
- 调用方：Electron 客户端和 Android WebView。
- 调用：`RvBWs`、浏览器 `GameEngine`、localStorage 和 UI 函数。
- 状态变化：全局 `G`、DOM、localStorage；联网模式只用服务端 `stateUpdate` 替换 `G`。
- 错误：网络失败、引擎异常或状态不兼容；部分异常只显示提示或被忽略。
- 日志：浏览器 console；生产 mobile 构建会削弱部分 console 输出。
- 测试：`tests/game/movement-contract.test.ts` 会执行页面实际加载的 `data/pages/js/game-engine.js`，验证共享移动导出和固定状态目标候选；`tests/game/battle-ui-boundary.test.ts` 覆盖展示模型、规则适配器与生命周期合同。RED-48 使用 Playwright 在训练模式完成 1280×720、390×844 的投影命中、选择/取消、目标模式和重复挂载冒烟，证据见 `output/playwright/red-48-browser-evidence.md`。
- 已知问题：页面控制器仍跨越网络、训练规则预演与展示；移动规则适配器仍在克隆快照上验证共享移动候选，技能、卡牌和 pending 目标则只消费核心 `preparation` 的精确候选。终局不再在 UI 重算，旧 Relay host 权威消息被忽略。
- 最小调试：捕获连接模式、roomId、seed、最后 action、服务端/客户端 state hash 和截图。

### 9.1 战场表现边界（RED-48）

- 展示输入：`battle-ui/battle-view-model.js::create()` 把完整快照、已选对象和规则层返回的合法集合投影为最小模型；训练、LAN、relay 不进入投影字段。
- 合法集合：`battle-ui/battle-legal-actions.js` 只调用浏览器 `GameEngine` 的克隆/验证入口，不包含移动距离、技能范围、伤害或结算公式。
- 组合器：`battle-ui/battle-presentation.js` 将同一个模型对象传入 renderer 与 DOM，并统一输出 `select-piece`、`select-skill`、`activate-cell`、`inspect-piece` 和 `cancel-target` 意图。
- Three.js：`battle-renderer-3d.js` 的公共生命周期是 `init(options)`、`update(model)`、`resize()`、`resetView()`、`projectCell()`、`screenToCell()`、`dispose()`；只负责棋盘内表现。`resetView()` 只恢复镜头，不修改战局状态。
- DOM：`battle-ui/battle-dom-ui.js` 负责 HUD 与桌面选中棋子的只读特殊状态悬浮摘要；PR #55 的紧凑生命/负面状态摘要留在棋盘表现层，完整技能与状态继续由 `battle.html` 的详情 modal/sheet 展示。状态悬浮摘要只消费展示模型中的完整可见状态，不递减持续时间或复制规则；进入移动/目标态即隐藏。`battle-context-layout.js` 只计算棋子菜单锚点、HUD 上侧安全区和现有 `handCards` 容器的弧形变量，不创建第二份手牌或规则状态。
- 响应式布局（RED-51）：`battle-responsive.css` 负责共享/桌面重排，`battle-responsive-mobile.css` 隔离 760px 及以下规则，`battle-context-ui.css` 负责透明 HUD、棋子附近技能菜单、桌面状态悬浮摘要和单源弧形手牌；棋盘舞台绝对定位并铺满战场视口，现有 `handCards` 直接承载卡牌流，以底部透明浮层覆盖在棋盘上，不再分配独立布局高度，也不设置手牌面板、标题或空状态区域。手牌浮层空白区域不接收指针，只有真实卡牌接收点击，因此棋盘拖拽/缩放仍可从空白处开始。训练修改入口是棋盘内可展开/收起的锚定悬浮菜单。选中棋子先显示轻量菜单，进入移动或目标选择后立即收起，避免遮挡路线；菜单内显式 i 按钮打开完整技能与状态详情，桌面也可右键。900px 以下低高横屏与 760px 以下触屏隐藏桌面状态摘要，详情统一使用菜单 i 和底部 sheet。训练开局列表内部滚动以保持操作按钮可达；布局层不得复制行动合法性、目标或费用规则。
- 坐标与手势（RED-68）：`battle-tactical-geometry.js` 只定义固定单轴 45°、35° FOV 的弱透视镜头、低椭圆棋子尺寸、屏幕拖拽到地面坐标的换算与镜头目标夹取；不读取战局状态，也不包含合法性或结算规则。renderer 以 canvas 的 CSS 边界完成指针反投影，优先命中真实地砖几何并以扩展平面覆盖格缝；在 resize/DPR、平移、缩放、镜头复位或棋子移动后发出 `viewport-change`，页面据 `projectCell()` 重算菜单锚点。粗指针的初始缩放遍历透视边缘并保留 1 CSS px 余量，保证所有投影格子的最小轴至少 44 CSS px；10px 累计位移后才从点按切换为拖动。单指拖动使用屏幕射线与地面的交点差，双指缩放和 `resetView()` 都保留同一 `projectCell()` / `screenToCell()` 合同。
- 2.5D 与移动布局（RED-68）：棋盘材质、0.72 单位台面厚度、只在前沿可见的立面、棋子轮廓和红蓝阵营环集中在 `battle-tactical-table.css` 与 renderer 表现常量中；棋子最大平面占格约 72% × 56%，厚度 10%，地形仅以有限高度层级表达。战局顶端只保留无独立盒子的双方信息，棋盘舞台不再叠加 CSS 外框，按钮继续使用既有 battle UI，只由响应式层保证触摸尺寸与排布。760px 及以下竖屏直接保留可操作战局并使用安全区、44px 控件和底部 sheet；目标态隐藏手牌与非必要 HUD，但保留取消与权威目标高亮。该层不得复制游戏规则或引入新的全局状态。
- 动效与反馈（RED-69）：`battle-tactical-table.css` 与 `battle-renderer-3d.js` 共享 100/140/240/280ms 的 press/fast/action/result 节奏和同名缓动；renderer 以 `owner:property` 控制器保证同一属性只有一个可中断动效，并以权威状态哈希/序号派生的 `motionEventKey`（缺失时使用确定性展示签名）去重。页面只把单一待确认命令映射为 `BattleViewModel.interaction.pendingPieceId/pendingCommandId`，8 秒超时、断线、服务端拒绝、权威展示投影前进和页面卸载都显式清理；完全重复或仅诊断字段变化的快照不解除 single-flight。当前 `PublicBattleSnapshot` 不含 accepted `clientActionId`，因此投影前进仍是近似确认而非精确命令 ACK，公共接口修复由 RED-99 跟踪。合法性、伤害、治疗、状态和死亡仍完全来自前后权威快照。目标格同时进入且不因普通重绘重播，移动从当前可见位置重定向，所有 piece/status/highlight/floater/controller 都在移除或 `dispose()` 时释放。`prefers-reduced-motion` 取消位移、缩放和下沉，仅保留 100–140ms 静态轮廓/淡入淡出及结果文本。
- 待选拒绝恢复（RED-97 与 RED-69 合并语义）：服务端拒绝普通命令时，页面结束待确认反馈并清理临时目标交互；若被拒绝的是 pendingTargetSelect 或 pendingOptionSelect，且当前权威快照仍保留对应选择会话，则只结束待确认动效并解除本地提交锁，保留选择 UI 供玩家重试。选择 UI 仅在权威会话结束、回合切换、实体失效、断线或明确取消时清理。
- 规则权威：页面控制器把意图转换为现有 action；非法操作仍由规则层/服务端最终拒绝。
- 决策：见 `docs/decisions/ADR-0004-battle-presentation-boundary.md`。

### 9.2 真实联机棋子选择页资源来源

- 入口：`data/pages/piece-selection.html::loadPieces()`。
- 本地优先：先通过 `fetchPackJson()` 读取版本化 `data/pieces/manifest.json` 及其中每个棋子；
  没有 Electron bridge 时沿用页面相对资源。正常本地读取不会请求服务器棋子接口。
- 服务器回退：任一本地清单或棋子读取失败、格式非法或总加载超过 2 秒时，通过当前连接的
  `RvBUtils.serverFetch('/api/pieces')` 读取服务器棋子，包含响应正文解析在内的总请求预算为
  2.5 秒。两个来源都要求非重复 `id`、`good/evil` faction，且已确定阵营时至少有 8 枚候选。
- 表现边界：页面只按玩家 `light/good` 或 `dark/evil` 阵营提供即时筛选；8 枚数量、唯一性、
  Demo 清单和阵营仍由服务器最终校验，页面不复制规则。
- 错误：两个来源都失败时，棋子区域显示本地来源和服务器来源的具体原因，并记录带
  `[piece-selection]` 上下文的 console 错误；不得退化为永久加载或无原因空列表。
- 测试：`tests/electron/piece-selection-resource-fallback.test.ts` 覆盖本地成功、局部读取失败后
  回退、超时回退、双重失败、阵营刷新及 8 枚提交合同；开发态真实 Electron 冒烟入口为
  `tests/electron/piece-selection-smoke.mjs`，运行前先构建 Next standalone、同步页面并编译
  `electron-client`。

### 9.3 同阵营对局本地 UI 验收（RED-43）

- 入口：Next 开发服务的 `/qa/same-alignment`，可创建固定 seed 的 `light/light` 和 `dark/dark` 真实房间。
- 门禁：启动页、`create-ui-acceptance-room` API 和 `/qa/client/**` 资源只在非 production 且 loopback 请求下提供，production 或远端请求返回 404。
- 客户端：`/qa/client/battle.html` 不复制 `battle.html`；直达链接会在连接检查前从 URL 恢复服务器配置。
- 证据：服务端通过规则干运行产生目标集；页面 RED-43 面板显示 room/player/seed、按 `ownerPlayerId` 划分的敌我数量、客户端高亮集与服务端目标集的对比。
- 边界：入口与面板只组织验收并暴露证据，不改变动作协议、规则引擎、随机算法或 production 资源发布。
- 测试：`tests/qa/red43-ui-acceptance.test.ts`；可重复浏览器步骤与证据见 `docs/qa/RED-43-same-alignment-ui.md`。


### 9.4 公开局外开发者中心与 Trace v2 可视化回放（RED-94）

- 页面：`data/pages/developer-tools.html` 从主菜单进入，Trace 导入/最近记录是主功能，固定 seed 隔离场景是次级工具；`data/pages/replay.html` 是独立只读回放页。存在 `rvb_active_battle` 时两页 fail closed。
- 隔离 API：`app/api/developer-tools/scenario/route.ts::POST` 校验 uint32 seed、地图 ID 与双方内容阵营，只调用 `createDebugDuel()` 和正式 Runner，返回 `rvb-developer-scenario/v1`；不接受 roomId、不持久化、不发奖励、不写统计。
- 权威记录：`lib/game/battle-trace.ts` 初始化 `rvb-battle-replay/v2` 归档并抓取所用技能的最小展示定义；`runBattleAction()` 只在成功命令后追加可物化 postState、语义事件、随机流和权威/检查点 hash。当前帧的 preState 是上一检查点；地图不变时以 `inheritsMap` 继承，累计 actions 不重复进入检查点。
- 生命周期：进行中 `PublicBattleSnapshot` 删除 action trace、applied action IDs 和回放归档；只有权威 `terminalResult` 已提交的终局投影保留完整脱敏归档。
- Trace 导出：`data/pages/js/developer-tools/match-trace.js` 从终局归档生成紧凑 JSON `rvb-match-trace/v2`，包含展示内容快照、初始检查点、逐命令帧、终局、摘要和完整性元数据。它先物化帧状态再验证检查点 hash。最近有效记录以 IndexedDB 为主、localStorage 为受限环境回退。
- 导入合同：只接受 v2；v1 明确拒绝为旧诊断格式。导入器限制 32 MiB、深度/节点/数组/字符串预算，拒绝危险键、敏感字段、非法 URL 和不连续或被篡改的双 hash 链；失败不得覆盖最近有效 Trace。
- 展示边界：`replay-viewer.js` 复用 `battle-view-model.js`、`battle-renderer-3d.js`、`battle-status-presentation.js` 与 `battle-tactical-geometry.js`。棋盘覆盖整个视口；时间轴/播放控制与按命令、棋子、事件、变化、完整性分组的可折叠检查器作为浮窗。棋子页显示技能定义与当前冷却/次数/充能/解锁状态。它不复制规则，也不调用当前 Runner 重算历史。
- 向前降级：Trace 携带棋子/技能的最小展示快照（名称、描述、类型、基础冷却/充能/消耗，不含执行代码）；未知角色、技能和事件用稳定 ID 与通用文本显示。未来破坏性合同必须使用新格式版本，不能静默套用当前规则。
- 网络边界：开发者中心和回放页不加载 WebSocket、不读取真实房间、不发送动作，也不调用奖励或统计接口。
- 决策：`docs/decisions/ADR-0016-trace-v2-recorded-state-replay.md`；验收：`docs/qa/RED-94-developer-tools.md`。

## 10. Electron IPC

- 入口：各 `preload.ts` 暴露的 `electronAPI`/`editorAPI`，以及 `ipcMain` handler。
- 职责：窗口、进程、本地服务、文件和系统能力。
- 输入/输出：基于字符串 channel 的参数和结果。
- 调用方：Electron 渲染页面。
- 状态变化：进程、窗口、本地文件/设置。
- 信任边界：每个 handler 在读取参数前验证精确 `BrowserWindow.webContents`、主 frame、受信
  URL 和该窗口角色允许的 channel；server/editor 只接受各自单一窗口，client 区分
  game/admin/connect。所有子 frame 导航和所有新窗口请求都被拒绝。
- 错误：sender 不可信时 handler 抛出包含 channel 和拒绝原因的错误；业务启动、文件或
  窗口错误仍由各 handler 返回或抛出。
- 测试：`tests/electron/ipc-trust.test.ts` 覆盖错误窗口、iframe、错误 URL、空 frame 和销毁
  窗口；`security-boundary.test.ts` 检查所有注册都经过 sender 包装器。
- 已知问题：仍没有共享的跨进程协议版本和统一业务错误结果；三个编译根目录各自保留一份
  很小的 sender 判定模块，语义由同一测试矩阵锁定。
- 最小调试：记录 channel、请求 ID、参数摘要、结果类型和异常栈，禁止记录密钥。

### 10.1 Electron 资源包存储

- 入口：客户端 `pack-import-from-path`/`pack-import-data`，服务端 dashboard 资源包导入，
  以及 `lib/resource-pack.ts::syncResourcePack()`。
- 存储：`userData/resource-pack/versions/<sha256>/` 为不可变版本，`active.json` 是唯一活动
  指针；旧版固定 `resource-pack/data` 只在尚不存在指针时作为读取兼容回退。
- 激活类型：仅 `data/**/*.json` 与 `images/**/*.{jpg,jpeg,png,webp}`；内置 HTML/JS/CSS/SVG
  不接受热更新。
- 事务边界：ZIP 中央目录、预算、entry 类型、manifest 和内容全部验证成功后，staging 才
  重命名为版本目录并原子切换指针。失败不改变当前活动版本。
- 测试：`tests/electron/resource-pack-security.test.ts` 覆盖路径穿越、绝对/盘符/反斜杠路径、
  大小写冲突、符号链接、非法 JSON、预算、活动内容隔离、失败不切换和清除回退。
- 回退：优先把 `active.json.version` 切回 `previousVersion`；代码回退使用 RED-24 PR revert，
  不删除已有版本目录。

## 11. Android 资源构建

- 入口：`scripts/build-game-engine.js`、`sync-pages.js`、`sync-android-assets.js` 和根 `package.json` Android scripts。
- 职责：把 TS/JS、页面和 mobile server 转换成 Android 发布资源。
- 输入：`lib/game`、`data/pages`、`mobile-server`。
- 图片源：`public/tile-effects/**` 是地格效果 SVG 的唯一维护源；同步脚本递归保留子目录并派生到客户端 `images/tile-effects/**`，不得手工维护双份。
- 输出：页面实际加载并提交的 `data/pages/js/game-engine.js`，以及被忽略的 `android-client/www/js/game-engine.js` 派生副本。
- 调用方：Android 打包命令。
- 错误：缺失依赖、构建顺序或覆盖错误会生成与源码不一致的安装包。
- 测试：RED-28 候选验证会分别执行 `build:game-engine`、`build:mobile-server`，再加载两个生成 bundle，并核对 Android Relay 初始化 seed/trace 与 browser runner 固定 seed 重放 hash。
- 构建边界：两条 browser 构建通过显式 shim 解析相对 `app-paths` 与 `node:*`，不得把 Electron resource-pack 的 Node 能力带入 WebView bundle。
- 已知问题：当前正式发布物与预期唯一源码关系仍不清；RED-28 的生成物只用于候选验证，不提交。
- 测试：`tests/game/movement-contract.test.ts` 直接执行 canonical bundle 并检查 RED-30 共享空间导出；尚无完整 Android 安装包来源/hash 验证。
- 已知问题：完整 Android 发布物仍缺少端到端的来源/hash 验证。
- 最小调试：清空临时构建目录后从源码生成，记录命令、commit、文件 hash，再安装冒烟验证。删除正式目录前必须另行审批。

- 浏览器兼容：`build-game-engine.js` 将 `node:fs/path/crypto/zlib` 规范化为 runtime shim 已支持的普通 external 名称，并在浏览器 bundle 内联不执行文件操作的 `adm-zip` 占位模块；`movement-contract.test.ts` 禁止 canonical bundle 重新引入这些不受支持的动态 require。

## 12. 重复公共类型

相似 `BattleState`/`BattleAction` 位于：

- `lib/game/turn.ts`
- `lib/game/battle-types.ts`
- `lib/game/training-types.ts`

`battle-types.ts` 当前确认由 `lib/game/ai.ts` 导入 `BattleState`；它是否仍是有效公共接口目前待确认。处理原则：先核对 AI 入口是否仍在正式流程中，并建立类型/运行时兼容测试，再决定合并、适配或废弃；不得直接删除。

## 13. 目标 Server Core 接口

当前 Windows 和 Android 的服务端 API 分别实现。目标是共享纯 TypeScript 核心，平台只注入能力：

```ts
interface ServerCorePorts {
  storage: ServerStorage;
  clock: Clock;
  rng: RandomSource;
  signer: ServerTermSigner;
  broadcaster: StateBroadcaster;
}

interface ServerCore {
  createRoom(input: CreateRoomInput): Promise<RoomSnapshot>;
  dispatch(command: SignedPlayerCommand): Promise<SignedActionRecord>;
  restore(trace: EncryptedMatchTrace): Promise<RoomSnapshot>;
  evaluateResult(): SignedTerminalResult | null;
}
```

这是边界愿景，不是现有接口。Windows 适配 Prisma/Node 网络；Android 适配移动存储、Java LAN 网络和生命周期。

## 14. 目标规则包接口

服务器规则自治。目标规则包需要声明协议、hash、权限、数据和声明式 UI，并在沙箱中执行。客户端只在玩家确认、hash 验证和权限检查后安装。

禁止能力：玩家私钥、任意网络/文件、系统命令、动态模块和宿主对象。资源使用签名清单、内容 hash 和缓存配额；资源本身不得执行代码。

具体沙箱 ABI、签名格式和资源协议待独立 High Risk ADR。

## RED-31 2026-08-18 接口修订

本节取代本文中与“座位、先手完全独立”以及旧部署阶段命名冲突的说明。

### PVP 房间编排

- `room-store.assignNextSeat()`：空房首位使用可注入的等概率选择器分配 `red | blue`，已有一席时返回另一席；已持久化座位由调用方直接复用。
- Relay lobby/join 使用同一服务端权威规则分配并持久化座位；兼容 `claim-faction` 仅返回既有座位，不接受客户端覆盖。
- `room-battle-start.startBattleForRoom()`：要求阵容中恰有一名红方玩家，并将其 ID 显式传给规则层的 `firstPlayerId`。
- Relay 与移动端开局入口：要求恰有一红一蓝；红方先手，非法或重复座位直接拒绝。
- `turn-order` 随机流仍为兼容接口；Demo PVP 房间开局不再消费它来决定先手。

### 部署状态展示

- 权威阶段为 `deployment.status = awaiting-locks`。
- 客户端只依据服务端下发的 `deployment.deadlineAt` 计算剩余秒数，不自行延长或重置期限。
- 未锁定玩家的选择继续保持私有；公开快照只包含锁定状态和可公开结果。

### 单端口网络传输

- 客户端只配置并持久化一个规范化的 `serverUrl`；HTTP 与 WebSocket 始终使用该地址的同一协议主机和端口。
- HTTP 健康检查使用 `/api/ping`，WebSocket 地址由客户端直接派生为 `/ws/rooms/{roomId}`；不得保存、探测或猜测 `wsPort`、`wsBaseUrl`。
- 旧版 `rvb_ws_port` 及其 URL/来源缓存会被清除，且不能影响连接目标；不再兼容双端口客户端或配置。
- Next.js 开发与 standalone 服务在创建 HTTP(S) server 前加载 `scripts/ws-same-port-server.cjs`，把游戏 `/ws` Upgrade 交给 `noServer` WebSocket 服务，同时保留 Next HMR Upgrade。
- Electron 主机直接在一个公开端口运行 standalone，不再创建内部 HTTP/WS 端口或公开代理；Android 与 Relay 也在各自唯一的 HTTP 服务端口处理 WebSocket Upgrade。
- `/api/ws-info` 仅作为诊断接口返回 `{ transport: 'same-origin', path: '/ws/rooms/{roomId}' }`，不得暴露或参与选择内部端口。
- LAN/UDP/快速扫描只发现可通过 `/api/ping` 访问的完整 HTTP origin，加入后 WebSocket 必须连接该 origin，而不是第二个地址。
- 传输模式按服务器地址判定：本机与私网地址走 LAN 权威主机；公网地址走 Relay，显式 `relay=1` 仅用于本机 Relay 调试，二者都遵守同端口 URL 规则。

## RED-36 2026-08-20 接口修订

### 权威回合计时

- `lib/game/turn-timer.ts`：定义可注入 `AuthoritativeRuleClock`、成长时长、20 秒快速回合、最终 15 秒烧绳、当前输入所有者、活动回合玩家、同回合各输入 owner 的剩余预算/烧绳状态、玩家独立连续无操作次数和只读投影。
- `BattleState.turnTimer`：保存规则期限和 streak；`turnTimerSync | turnTimerBurn | turnTimeout` 是内部系统动作，客户端提交会以 `TURN_TIMER_SYSTEM_ACTION_FORBIDDEN` 拒绝且不写房间。
- `dispatchRoomBattleAction()`：进入异步读取前采样逻辑接收时间；每房间串行冻结逻辑时钟，完成规则、唯一 CAS、快照构造和发送入队后恢复。传输层只获得真实提交版本，CAS 冲突不发布 speculative 快照，且处理跨越 15 秒阈值不会造成烧绳投影反转。进程重启恢复不在 RED-36 范围内。
- 计时跟随当前输入所有者，并从 action 延续到 end，覆盖 pending 与“回合结束时”输入，直到下一回合真正开始；pending 返回活动玩家时恢复原剩余预算。主动结束回合产生的 pending 继续使用当前预算；action phase 超时若在强制 `endTurn` 时才产生 pending，则取消该输入并推进下一回合，不新增预算。end phase 输入超时也直接推进，不能重复执行 endTurn 触发。只有当前 owner 被接受的玩法动作才清零自己的 streak。
- `scheduleRoomBattleTimeout()`：按部署期限、烧绳阈值和回合期限安排下一次唤醒；系统事件仍通过 Runner 与房间版本 CAS，烧绳/超时各只提交一次；超时进入 bot action phase 时调用 bot-turn 回调。
- 第三次连续无操作超时复用 RED-34 `terminalResult(reason = timeout-surrender)`，房间与终局在同一次 CAS 中变为 `finished`。

### 客户端显示边界

- `PublicBattleSnapshot` 增加 `serverNow` 与 `turnTimer?`；后者包含当前输入 owner、活动回合玩家、完整轮次、时长、剩余量、期限及 `burning/fast` 状态。
- `battle.html` 和 `turn-timer-status.js` 只刷新 HUD。刷新、重连和 HTTP GET 不修改规则状态或期限，浏览器不持有超时授权。
- 决策：[ADR-0014](../decisions/ADR-0014-authoritative-growing-turn-timer.md)。
