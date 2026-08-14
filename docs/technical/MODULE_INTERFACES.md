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
- 调用：技能、触发器、地图/棋子和附加效果逻辑。
- 状态变化：回合、阶段、单位、资源、卡牌和 pending selection。
- 错误：`BattleRuleError`、版本错误、效果执行异常。
- 日志：`turn.ts` 的本地日志函数及 `game.log`。
- 测试：`tests/game/turn.test.ts`。
- 已知问题：文件职责过大；与 `battle-types.ts`/`training-types.ts` 类型重复。
- 最小调试：使用固定 `_v` 的状态调用 `applyBattleAction(state, action)`，比较输入和输出 hash。

## 2. 战斗 Runner 与回放

- 入口：`lib/game/battle-runner.ts::runBattleAction()`、`replayBattle()`。
- 职责：动作 ID、运行时技能补全、hash、幂等和回放。
- 输入：状态/动作，或初始状态/seed/动作序列。
- 输出：状态、`stateHash`、`actionHash`、`duplicate`，或回放结果。
- 调用方：WS、房间 HTTP API、训练/调试 API、测试。
- 调用：`applyBattleAction()`、稳定 JSON/hash、RNG。
- 状态变化：会写入 `state.extensions.debugBattle`；返回下一状态。
- 错误：规则错误直接向上抛；上层转换方式不统一。
- 日志：主要依赖调用方；调试元数据保存在状态扩展中。
- 测试：`tests/game/debug-battle.test.ts`。
- 已知问题：输入状态存在隐式写入；回放后不恢复原自定义 RNG。
- 最小调试：保存初始状态、seed、动作序列，调用 `replayBattle()` 并核对最终 hash。

## 3. 战斗初始化

- 入口：`lib/game/battle-setup.ts::createInitialBattleForPlayers()`。
- 职责：根据玩家、选人和地图生成初始状态。
- 输入：玩家 ID、阵营模板、选择、地图 ID、先手选项。
- 输出：`Promise<BattleState | null>`。
- 调用方：房间开战、训练/PVE/调试场景。
- 调用：地图、技能、规则、棋子和全局触发器。
- 状态变化：创建状态并修改全局触发器注册。
- 错误：玩家数错误返回 `null`；数据加载/效果错误可能抛出。
- 日志：`battle-setup.ts` 本地日志。
- 测试：缺少独立初始化和多房间隔离测试。
- 已知问题：全局触发器；seed 不保证在初始化前注入。
- 最小调试：显式传入 `firstPlayer`，固定 RNG，输出初始状态 hash 和棋子列表。

### 身份模型（RED-27）

对局座位 `seat: red | blue`、内容阵营 `alignment: light | dark`、棋子 `ownerPlayerId` 与先手 `firstPlayerId` 是独立字段。敌我只能按 `ownerPlayerId` 判断；`room-store` 中的 `faction: red | blue` 仅用于读取旧房间数据的座位兼容。详见 [ADR-0002](../decisions/ADR-0002-match-identity-model.md)。

### Demo 阵容合同（RED-26）

- `lib/game/roster-contract.ts` 是 HTTP 与 WebSocket 的共享服务端校验边界；客户端筛选仅用于即时提示。
- 服务端按 `demo-v0.1` 读取 `data/pieces/manifest.json`，要求玩家从自己的 `alignment` 中提交正好 8 个不同、已准入且存在的 `templateId`。
- 成功确认会写入 `rosterLocked` 与 `rosterManifestVersion`。同一组模板的重排提交返回幂等成功；锁定后的不同阵容或阵营修改返回 `ROSTER_LOCKED`。
- 错误响应包含稳定的 `code`、`message` 与 `context`；HTTP 与 WebSocket 复用同一错误载荷。
- `lib/game/room-battle-start.ts` 在启动前重新检查双方阵容，并通过房间版本号原子提交战斗状态；只有双方合法锁定时才可通过当前战斗初始化入口。

## 4. 技能、卡牌与规则数据

- 入口：`lib/game/skills.ts` 的 `loadCardById()`、`loadRuleById()`、`executeCardFunction()`、`executeSkillFunction()`。
- 职责：加载并执行数据驱动规则。
- 输入：ID、状态、使用者、目标和效果上下文。
- 输出：定义或执行后的状态/结果。
- 调用方：`turn.ts`、触发器、战斗初始化。
- 调用：卡牌/规则数据、伤害、治疗、附加效果和触发器。
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
- 调用：`runBattleAction()`、`RoomStore.setRoom()`、WS 广播。
- 状态变化：房间战斗状态和数据库修订号。
- 错误：无效 JSON、房间不存在、规则/数据库错误。
- 日志：API 控制台输出。
- 测试：没有确认到 API 集成测试。
- 已知问题：与 WS 的验证、错误形状和并发策略可能不一致。
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
- 已知问题：主要链路通常用 `setRoom()` 而非 `setRoomIfVersion()`；外层无格式版本；部分字段读取时重置。
- 最小调试：用新格式 fixture 执行读取—写回—再读取，比较关键字段、动作链和状态 hash，而不是只比较 JSON 文本。

## 9. 浏览器战斗 UI

- 入口：`data/pages/battle.html::doAction()`、`applyServerState()`、`checkClientGameOver()`。
- 职责：显示状态、收集输入、发送动作和接收服务端状态。
- 输入：玩家交互、WS/Relay 消息、完整战斗状态。
- 输出：动作消息、页面渲染、客户端胜负状态。
- 调用方：Electron 客户端和 Android WebView。
- 调用：`RvBWs`、浏览器 `GameEngine`、localStorage 和 UI 函数。
- 状态变化：全局 `G`、DOM、localStorage；Relay 模式还会执行规则。
- 错误：网络失败、引擎异常或状态不兼容；部分异常只显示提示或被忽略。
- 日志：浏览器 console；生产 mobile 构建会削弱部分 console 输出。
- 测试：没有确认到真实浏览器 E2E。
- 已知问题：大文件跨层；复制胜负/目标逻辑；不同模式承担不同权威职责。
- 最小调试：捕获连接模式、roomId、seed、最后 action、服务端/客户端 state hash 和截图。

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
- 输出：`android-client/www` 等生成物，最终进入安装包。
- 调用方：Android 打包命令。
- 错误：缺失依赖、构建顺序或覆盖错误会生成与源码不一致的安装包。
- 测试：没有确认到生成物 hash/来源验证。
- 已知问题：当前正式发布物与预期唯一源码关系不清。
- 最小调试：清空临时构建目录后从源码生成，记录命令、commit、文件 hash，再安装冒烟验证。删除正式目录前必须另行审批。

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
