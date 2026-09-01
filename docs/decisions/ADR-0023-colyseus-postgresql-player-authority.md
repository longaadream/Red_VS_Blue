# ADR-0023：默认玩家权威迁移到 Colyseus + PostgreSQL

状态：已接受
日期：2026-09-01
关联任务：RED-160、RED-161

## 背景

旧 Electron 玩家链路把房间命令、战斗权威和同步持久化集中在 Next 自定义 WebSocket 与
SQLite/Prisma 进程中。单 writer 争用和动作回执等待持久化放大了本地与跨地域延迟，也使普通动作、
恢复和终局的耐久性语义难以区分。RED-160 已验证 Colyseus Room 内存权威、PostgreSQL 有界微批和
终局 durable barrier 的纵切；RED-161 负责把默认玩家入口接到该权威。

## 决策

- 大厅、房间、准备、选将、战斗命令、回执和重连恢复统一由 Colyseus `battle` Room 提供。
- Room 内存状态是在线对局的实时权威；普通动作在规则提交后立即返回 APPLIED，不等待数据库。
- PostgreSQL journal 以 25 ms / 8 条为默认有界微批；版本 0、终局和显式关键边界强制 durable。
- Electron 打包并启动独立 Colyseus authority bundle；玩家页面通过兼容适配器保留现有 `RvBWs`
  页面接口，但底层不得创建 legacy `/ws/rooms/*` 连接。
- 目标型技能可以调用与服务端同版本的浏览器规则适配器做只读、非权威的展示预检，以便在第一次
  网络往返前呈现候选目标。预检不得写回状态、消费随机、读取未投影隐藏信息，或预测伤害、触发链、
  终局和持久化结果；最终 action 必须由 Colyseus 服务端完整校验，服务端 continuation/rejected 始终
  覆盖本地展示。该例外不批准通用客户端预测或 Web Worker。
- SQLite/Prisma 不再参与新 Colyseus 玩家房间或战斗动作路径。现有内容 Profile 管理进程暂时保留，
  其移除属于后续迁移，不得把它误写成玩家动作仍经过 SQLite。
- Trace 生成、RED-139 queue 内部实现和玩法数值不在本次切换范围。

## 备选方案

- 继续优化 SQLite writer：无法消除单 writer 架构和动作回执耦合，不采用。
- 只让战斗走 Colyseus、大厅继续走 legacy WS：会保留双连接状态与房间版本分叉，不采用。
- 普通动作同步写 PostgreSQL：耐久窗口更小，但直接重新引入数据库 RTT，不采用。

## 影响

玩家动作热路径不再等待 SQL；代价是普通 APPLIED 与 DURABLE 分离，服务器在微批落盘前异常退出时
允许短暂 RPO。正式本机主机或服务端必须提供 PostgreSQL；无数据库的 volatile QA 入口只能验证 UI
和 Room 行为，不能作为候选耐久性证据。

## 验证方式

- 两个真实 Colyseus SDK 客户端完成建房、入座、准备、各锁定 8 棋并建立 version 0 battle。
- 普通动作回执、重复 `clientActionId`、微批、降级隔离、重启恢复和终局 barrier 延续 RED-160 门禁。
- Electron/页面静态合同禁止 legacy `/ws/rooms/` 和 `new WebSocket()` 回到默认玩家适配器。
- 候选环境必须用真实 PostgreSQL 执行 integration，并完成人工双端流程；内存测试替身不得代签。

## 回退方式

整体回退 RED-161 的页面适配器、Electron authority 启动和 Colyseus product Room。不得只恢复客户端
legacy WS 而保留 Colyseus 房间，也不得让两个权威同时接受同一对局动作。PostgreSQL 表可保留，
回退不要求破坏性删除数据。

## 相关资料

- [RED-160 纵切验收](../qa/RED-160-colyseus-postgresql-vertical-slice.md)
- [RED-161 切换验收](../qa/RED-161-colyseus-electron-cutover.md)
- [ADR-0020（已由本决策取代）](./ADR-0020-unified-player-websocket-transport.md)
