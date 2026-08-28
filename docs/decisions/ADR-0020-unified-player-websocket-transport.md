# ADR-0020：玩家联机业务统一使用 WebSocket

状态：已接受
日期：2026-08-28
关联任务：RED-127

## 背景

Windows 客户端过去把大厅、房间、地图与选将放在 HTTP，把房间推送和战斗动作放在 WebSocket。LAN、Radmin 和 Relay 因而维护两套连接状态、错误协议和恢复路径；任一侧地址、证书、房间版本或数据库状态不同步，玩家就会看到“能列出房间但不能准备”“双方人数不同”或“进入战斗后没有权威状态”。

Electron 候选还曾依赖 Next standalone 自动追踪运行时模块，导致打包后缺少 `ws`，只能在源码目录旁运行。

## 决策

Windows/Electron 玩家业务统一使用同源 WebSocket：

- `system.health` 负责连接探测；
- `catalog.identity/maps/pieces/skills/card` 负责玩家所需内容目录；
- `rooms.list/create/get/join/action/delete` 负责大厅、房间、准备和选将；
- 战斗命令、权威回执、状态 patch、完整快照与重连恢复继续使用同一房间 WebSocket；
- Relay 与 LAN 使用相同的房间与准备语义，客户端不再因模式禁用准备；
- RPC 以 `requestId` 关联响应；同一连接内相同请求重放同一结果，不重复执行；相同 ID 配不同 payload 返回 `RPC_REQUEST_ID_CONFLICT`；
- 战斗写操作继续用规则层 `clientActionId` 保证权威幂等。

“禁用 HTTP”专指玩家业务 REST。页面静态资源、Electron 管理接口以及 WebSocket 的 HTTP Upgrade 握手仍保留。旧 `/api/ping`、`/api/lobby`、`/api/maps`、`/api/pieces`、`/api/skills`、`/api/cards/**` 和 `/api/rooms/**` 玩家入口在实际运行时统一返回 HTTP 410 与 `PLAYER_REST_DISABLED`，不得作为后备通道。管理接口 `/api/admin/**` 不在本决策范围。

Electron 内置服务器绑定 `0.0.0.0`，Radmin 的 `26.0.0.0/8` 地址按 LAN 处理。客户端候选 staging 显式复制 `ws`、`@prisma/client` 与 `.prisma/client`，候选校验器同时检查这些依赖、同端口预加载器、`adm-zip` 和独立 Node。

## 备选方案

- 保留 HTTP 与 WS 双通道：兼容成本低，但继续存在状态、错误与重连语义分叉，不采用。
- 只让战斗走 WS：不能解决地图、准备和选将的双方差异，不采用。
- 把管理和静态资源也迁移到自定义 WS：会扩大 Electron 管理面和资源分发改造，不属于玩家业务统一所需，不采用。

## 影响

收益是单一连接状态、统一错误信封、Relay/LAN 行为一致，以及更直接的重连恢复。代价是旧玩家 REST 调用方会收到 410，Android 遗留入口需要在后续迁移任务中适配同一合同。

本决策不改变角色、技能、卡牌或地图数值规则。RED-127 只修正客户端显示/可用性读取手牌实例的实际 AP 费用，权威费用仍由规则层裁决。

## 验证方式

- 契约测试禁止玩家页面引用旧业务 API，并验证 410 边界不会拦截 `/api/admin/**`、普通页面请求或 WebSocket Upgrade。
- WS 测试覆盖目录、房间列表、结构化错误和重复 `requestId`。
- Electron 测试覆盖 `0.0.0.0`、Radmin 地址、权威/计时开关、数据库初始化及候选依赖清单。
- Windows 候选必须从仓库外隔离目录启动，完成两台客户端建房、地图选择、加入、双方准备、选将、进入战斗、回合倒计时与重连恢复。

## 回退方式

回退 RED-127 的提交即可恢复旧客户端调用与旧代理行为。不得只恢复页面中的 HTTP fallback 而保留 410 边界；传输回退必须整体进行。候选包与本地测试数据库都不承诺兼容，回退验证可使用全新数据库。

## 相关资料

- [RED-127](https://linear.app/redvsblue/issue/RED-127/bug-windows-双人联机候选版统一-websocket-房间协议并修复主机地图权威与倒计时)
- [Windows 构建基线](../technical/BUILD_AND_RUN.md)
- [RED-127 人工验收](../qa/RED-127-windows-ws-multiplayer.md)
