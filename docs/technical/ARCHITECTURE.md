# Red VS Blue 当前架构

状态：RED-9 代码核对稿

基线：`594977b`（2026-08-12）
首要公开测试模式：LAN Windows/Electron + Android；两端均可开服或加入

本文只描述当前代码、已确认方向和历史问题，不表示现有版本已经可以稳定运行。

人工审查只需先看第 1、7、8、9 节；其余内容是开发者和 AI 按需查询的代码地图。

## 1. 结论摘要

- 当前没有覆盖所有运行模式的统一服务端核心。Windows LAN 由 Next/WebSocket 服务端负责，Android 由 Java 网络层和隐藏 WebView 中的 mobile server 负责，Relay 则由主机客户端负责。
- 实际玩家战斗界面是 `data/pages/battle.html`，不是 React 页面。真实对战、观战和训练营共用这一个入口；`mode=training` 只切换 fixture 与调试能力，旧 `training.html` 只做兼容跳转。`battle.html` 同时承担渲染、网络、动作预演、Relay 规则执行和胜负判断。
- TypeScript 规则核心集中在 `lib/game/turn.ts`、`battle-setup.ts`、`skills.ts` 和 `triggers.ts`，但公共状态类型、随机、日志、存储格式和命令协议没有完全统一。
- Android 安装包是当前发布产物。项目负责人确认的目标是：以可维护的 JS/TS 源码为唯一真实源，Android 资源只能由构建生成，不能继续成为人工维护的第二份源码。
- 当前提交被指定为正式故障基线。`BUILD_AND_RUN.md` 为空，且最后一版存在尚未定位的重大运行问题，因此下一项工程工作应先恢复可重复运行基线。

## 2. 运行时边界

| 层          | 当前入口                                                            | 当前职责                                  | 已知边界问题                         |
| ---------- | --------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| 表现层        | `data/pages/battle.html`                                        | 战斗 UI、输入、网络消息、客户端状态和部分胜负判断            | 包含部分规则和权威状态处理                  |
| Next 服务层   | `app/`、`instrumentation.ts`                                     | HTTP API、状态页、训练/PVE/房间接口、启动 WebSocket | API 与 WS 共享规则，但错误协议不统一         |
| 游戏规则层      | `lib/game/`                                                     | 状态创建、动作执行、技能、触发器、地图和回放                | 类型重复、模块级缓存和全局触发器               |
| 房间/持久化层    | `lib/game/room-store.ts`、`lib/game/battle-storage.ts`、`prisma/` | 房间状态序列化、SQLite 存取、旧格式兼容               | 外层存档无正式格式版本和迁移链                |
| Electron 层 | `electron/`、`electron-client/`、`electron-editor/`               | 进程、窗口、本地服务器和 IPC                      | IPC 是字符串协议，没有共享类型              |
| Android 层  | `android-client/`、`android/`、`mobile-server/`                   | 客户端、Java LAN 服务和隐藏 WebView 规则服务       | 房间/API 外壳与 Windows 不同，生成物有多份副本 |
| Relay 层    | `relay-server/`                                                 | 房间与消息转发                               | 规则权威在主机客户端，不在 Relay 服务端        |

## 3. 首要发布链路

### 3.1 LAN Electron 服务端

1. 根 `package.json` 的 `dev:electron:server` 编译 `electron/` 后启动 Electron。
2. `electron/main.ts` 的 `app.whenReady()` 调用 `startGameServer()`。
3. `startGameServer()` 启动 Next standalone 服务；打包流程通过 `scripts/stage-client-resources.js` 注入同端口 WebSocket 代理。
4. Next 在 `instrumentation.ts` 的 `register()` 中调用 `lib/ws-server.ts::startWsServer()`。
5. `electron/main.ts` 加载服务管理界面。

失败行为：子进程、端口、standalone 资源或注入代理失败均可能导致应用不能进入可用状态。目前没有覆盖整条链的自动冒烟测试。

### 3.2 Electron/Android 玩家客户端

1. Electron 客户端从 `electron-client/main.ts::app.whenReady()` 启动；Android 由 WebView 加载打包资源。
2. 客户端进入 `data/pages/battle.html`。
3. `doAction(action)` 发送 `{ type: "action", action }`。
4. `lib/ws-server.ts` 接收消息并调用 `runBattleAction()`。
5. `runBattleAction()` 调用 `applyBattleAction()`，返回新状态及 hash。
6. `RoomStore.setRoom()` 保存房间并广播 `stateUpdate`。
7. 客户端 `applyServerState()` 替换本地状态并重新渲染。

HTTP 后备入口为 `app/api/rooms/[roomId]/battle/route.ts::POST`，同样调用 `runBattleAction()` 和 `RoomStore.setRoom()`。

### 3.3 Android 开服

Android 已存在开服实现，不是仅能加入的客户端：

1. `android/app/src/main/java/com/redvsblue/client/MobileHttpServer.java` 使用 `ServerSocket` 提供 LAN HTTP/WebSocket。
2. `GameEngineWebView.java` 在隐藏 WebView 中加载生成的 `mobile-server.js`。
3. `mobile-server/mobile-server-entry.ts::RvBMobileServer.processRequest()` 实现房间/API 路由，并导入共享的 `applyBattleAction()` 和 `createInitialBattleForPlayers()`。
4. `db-shim.ts` 说明当前 Android 服务使用内存状态，不等同于 Windows Prisma 持久化。

目标不是让 Android 原样运行 Next/Prisma，而是抽出共享 TypeScript Server Core；Windows 与 Android 只保留网络、存储和生命周期适配器。

## 4. 不同模式的状态权威

| 模式 | 当前权威 | 动作执行位置 | 持久化位置 |
| --- | --- | --- | --- |
| Windows 开服 | Next/WS 服务端中的房间状态 | `runBattleAction()` → `applyBattleAction()` | Prisma `Room.battleState` |
| Android 开服 | `mobile-server-entry.ts` 的房间状态 | 当前直接使用 `applyBattleAction()` | 内存；正式持久化待实现 |
| Relay | 主机客户端 | 浏览器 `GameEngine.applyBattleAction()` | Relay 仅保存/转发最新状态 |
| Training | `battle.html?mode=training` 的客户端内存状态 | 浏览器 `trainingApiFetch()` → `GameEngine.applyBattleAction()` | 仅页面内存 |
| Mobile embedded server | Android 进程内房间 Map | `mobile-server` 独立处理 | 进程内；持久化待确认 |

同一设备可以同时承担服务端和客户端角色，但两种职责必须保持独立；本机玩家也必须通过与远端玩家相同的命令协议操作权威服务端。公开测试的目标是 Windows 和 Android 功能对等，均可开服或加入。Relay 和 Training 不阻塞该基线。

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

1. `battle.html` 跨越表现、规则、网络和结果判断层。
2. LAN、Relay、Training 和 mobile server 的权威边界不同。
3. `lib/game/turn.ts`、`battle-types.ts`、`training-types.ts` 都定义了相似状态/动作类型。
4. `globalTriggerSystem`、规则缓存和 RNG 是模块级状态，并发隔离未验证。
5. 存档外层格式、IPC、WS 和 Relay 消息缺少共同版本。
6. Next 构建配置允许忽略 TypeScript 错误，运行故障可能直到打包或运行时才暴露。

## 7. 已确认的目标架构

- Windows/Electron 与 Android 均可开服或加入；服务端角色不绑定平台。
- JS/TS 源码是唯一真实源；Android 只消费生成产物。
- 每局只有一个当期权威服务端，负责状态、规则、胜负和存档确认；客户端发送命令并显示结果。
- 服务器规则自治，不存在全局唯一“官方规则”。服务器决定规则包、游戏数据和胜负判定。
- UI 只发送明确命令并显示结果，不复制规则。
- 相同初始状态、种子和命令序列可以重放到相同 hash。
- 不兼容公开测试前的旧存档；兼容承诺从新版本化存档格式开始。
- 先恢复稳定运行和可观察性，再做模块拆分。

## 8. 延期愿景索引

以下方向已经讨论，但不属于 RED-9，也不要求项目负责人现在完成设计。后续每次只选择一个模块建立独立任务和 ADR：

| 模块 | 已确认方向 | 当前处理 |
| --- | --- | --- |
| 存档与恢复 | 掉线暂停；参与者持有记录；不兼容公开测试前旧存档 | 延期，先恢复运行基线 |
| 身份与签名 | 玩家命令和服务端结果分别签名；服务器身份可备份、迁移和撤销 | High Risk，另建威胁模型 |
| 加密与随机 | 存档/传输加密；隐藏信息隔离；随机过程最终可审计 | High Risk，暂不选算法 |
| 服务器规则 | 服务器规则自治；规则/数据 hash 一致才开局；规则脚本需沙箱 | High Risk，先验证现有规则引擎 |
| 回放与账号 | 正常终局自动匿名回放；账号私钥可加密备份 | 长期产品模块 |

详细字段、密码算法、密钥生命周期、沙箱 ABI 和托管方式都不是当前承诺。需要处理某模块时，再从已确认方向开始做不超过 1～3 天的小任务。

## 9. Demo 边界

公开测试 Demo 优先实现：

1. Windows/Android 均能开服和加入。
2. 共享规则与房间核心，服务端权威状态和胜负。
3. 协议、规则和数据 hash 检查。
4. 新格式基础本地存档与签名动作链。
5. 当前重大运行故障的稳定复现和修复基线。

端到端加密、完整恢复协议、服务器迁移/撤销、规则下载沙箱、公开回放平台、社交账号恢复网站属于长期愿景，必须拆为独立 High Risk 任务，不能阻塞第一版 Demo。

## 10. 相关文档

- `ENGINE_CORE.md`：状态、命令和核心规则调用链。
- `MODULE_INTERFACES.md`：模块接口、调用方和错误行为。
- `DEBUGGING.md`：故障基线、日志、测试和复现流程。
- `MODULE_STATUS.md`：当前状态、风险和后续任务优先级。
