# ADR-0019：受控四图目录与权威房间选图

> RED-138 取代说明：本文“确定性部署保持不变”一节中的初始 16 枚出生与重投条款只适用于 `legacy-reroll-v1` 和缺少 mode 的历史状态；受控地图目录、冻结 `Room.mapId` 与地图准入继续有效，新建对局默认部署算法见 [ADR-0024](./ADR-0024-progressive-reserve-deployment.md)。

- 状态：已接受
- 日期：2026-08-27
- 人工批准：2026-08-27
- 关联任务：RED-119
- 风险：High
- 部分取代：ADR-0007 的固定单图条款；ADR-0009 的 Relay 固定地图/忽略地图输入条款，以及其中将独立 `relay-server` 或 Relay 浏览器作为 host-authority 战斗执行、host 状态上传/恢复与签名转发方的条款。ADR-0009 的部署锁定、45 秒超时、公开投影、CAS 与随机合同继续适用于实际承担战斗权威的 Web/LAN/HTTP、桌面/Android 本机服务。

## 背景

Demo v0.1 原合同只允许 `large-hole-arena`，服务器、LAN、HTTP、Relay 与 Android 多处强制覆盖房间地图。RED-119 同时新增三张差异化地图并退役 `large-battlefield`，因此只修改大厅下拉框会造成“显示可选、实际仍被换回固定图”的分裂状态。

地图文件名不是权威状态 ID：大型洞穴的数据文件仍名为 `large-trap-arena.json`，其状态 ID 为 `large-hole-arena`。所有边界必须按状态 ID 校验，不得由文件名或普通默认值推断正式地图。

## 决策

### 受控地图目录

正式 Demo 可选地图按以下顺序冻结：

1. `large-hole-arena`（大型洞穴）
2. `open-expanse`（开阔原野）
3. `winding-pass`（回风曲径）
4. `narrow-corridors`（狭廊要道）

`large-battlefield` 从源数据、manifest、API、客户端包与正式默认引用中删除。四张正式地图均只使用普通地板、墙、掩体与洞穴，不引入熔岩、充能台、治愈泉或其数值/效果字段。

服务端共享选择模块拥有唯一 allowlist，并同时验证地图已加载且至少有 16 个普通可行走地板。缺失 ID、未知 ID、已退役 ID、大小写/空白变体、路径式输入和不可部署地图分别以稳定错误失败关闭；不做 trim、别名、模糊匹配或默认回退。

### 房间生命周期与传输

- 房主创建房间时必须提交一个 allowlist 状态 ID。成功创建后 `Room.mapId` 冻结；来宾、房间内操作和开战请求不能覆盖。
- Web/LAN、HTTP、桌面/Android 本机权威房间与独立 Relay 使用相同目录和校验语义。大厅和地图 API 只显示 allowlist。
- 持有房间的服务端在创建房间和正式开战前各验证一次。正式开战使用已持久化的 `Room.mapId`，且验证必须发生在 seed 生成、随机消费和房间/战斗写入之前。
- `BattleState.map.id` 必须等于 `Room.mapId`。任何非法或过期 ID 都不得被静默替换为存活地图。
- Next `/api/relay-battle-init` 与 Android `handleRelayBattleInit` 是当前没有 UI 调用方、也不持有 `Room` 的无状态兼容 bootstrap。它们只重新校验调用方已经冻结的 `mapId`，并在 seed 前用该 ID 初始化；不得读取或写入房间，也不能作为 `Room.mapId` 冻结的验收证据。
- 独立 Relay 新增可空 `mapId` 持久化字段以兼容旧行；新房间要求非空合法 ID。旧等待/就绪房间若没有合法 ID 或引用已退役地图则不能开战并要求重建。
- 独立 Relay 的 Prisma 历史从本次开始显式管理：先记录不含 `mapId` 的既有三表结构为 baseline，再用后一条迁移新增可空 `Room.mapId`。全新数据库依次部署两条迁移；由旧 `db push` 创建且没有迁移历史的数据库必须先备份并把 baseline 标记为已应用，再部署新增字段，禁止直接在生产库试跑或重新建表。
- 独立 Relay 的赛前传输使用现有 REST 接口：地图目录、房间列表/创建/读取、加入、阵营确认、选人、观战和删除都不得发送 LAN 的 `rooms.*` RPC，也不得连接虚构的 `__lobby` 房间。创建者已作为 host 入房，后续以 `claim-faction` 固化内容阵营；访客 `join` 同步固化内容阵营。赛前页面的 WebSocket 只订阅真实房间以接收更新。
- `waiting`/`selecting` 页面切换必须零状态写入，不能提前推进到 battle。现行架构禁止旧 host-authority 战斗模型；本任务不新增、恢复或验收 standalone Relay 的完整战斗状态执行/恢复，真实浏览器验收止于双方进入选人且 `mapId` 冻结。因此 ADR-0009 所述 Relay host/browser authority、host 状态写入与恢复不是当前独立 Relay 合同。
- 由已有权威战斗存储支持的运行面，其进行中旧战斗已在 `BattleState` 中保存完整地图，可以恢复并继续且不依赖已删除的源 JSON；此兼容性不扩展 standalone Relay 的验收范围。

随机选图、房间内换图、地图投票与目录外自定义地图均不在本次范围。

### 确定性部署保持不变

地图 ID 成为权威初始化输入，但不改变 ADR-0007 冻结的部署算法：

- 出生池仍只包含 `walkable === true && type === "floor"`，并按 `(y, x)` 排序。
- 两名玩家和阵容仍按既有稳定规则处理。
- `deployment` 流仍执行 16 步 partial Fisher–Yates，恰好消费 16 次且不重复。
- 重投仍使用 `deployment-reroll/<playerId>` 独立流；流名、派生公式、消费次数、锁定、45 秒超时与 CAS 不变。
- 相同 `mapId`、seed、玩家和阵容产生相同初始状态；不同地图允许产生不同坐标。

## 备选方案

- 保持单图，仅在图鉴展示新图：不采用；不能满足正式自由选择，并会造成 UI 与权威状态不一致。
- 接受任意仓库地图 ID：不采用；调试内容可能意外进入正式对局，也无法给客户端稳定目录。
- 非法或已删除地图自动回退大型洞穴：不采用；会掩盖旧房间/客户端错误并破坏可回放输入。
- 删除大型洞穴而保留大型战场：不采用；人工明确批准退役对象为 `large-battlefield`。

## 影响

- 规则合同由固定单图改为受控四图；这是跨大厅、房间、引擎与 Relay 的 High 风险边界变更。
- 训练、教程和开发工具如需默认地图，使用仍在目录中的显式 ID；正式建房路径不得使用默认值补齐缺失输入。
- 不修改存档版本、随机算法、经济、移动、弹道或地形结算。
- 候选版本必须逐图验证桌面与移动布局、建房、开战、16 个唯一普通地板出生点和权威 `mapId` 一致性。

## 验证方式

- 地图目录测试：文件/manifest/状态 ID 一致、恰好四图、禁止地形与数值字段、尺寸/连通性/部署地板和三类空间剖面。
- 选择边界测试：四图逐一通过；缺失、未知、路径式、大小写变体、`large-battlefield` 和不可部署地图失败且零写入。
- 正式开战传输测试：Web/LAN/HTTP 与桌面/Android 本机权威房间原样持久化所选 ID，且 `BattleState.map.id === Room.mapId`。两个无状态 `relay-battle-init` 兼容入口只验证调用方已冻结 ID 的 seed 前重新校验，不计作房间冻结证据。
- 独立 Relay 赛前协议测试：remote 模式只调用 REST、从不订阅 `__lobby`；host claim 与 guest join 持久化各自阵营；两人进入选人前地图不变；赛前主机断线或重连不得写 `waiting_host`、`battle` 或改变 `mapId`。
- RED-119 不测试也不声明独立 Relay 的战斗执行、host 接管或状态恢复。
- Prisma 校验：检查 schema、baseline SQL 与增量 SQL 的顺序和最终 diff；候选环境还必须在一次性 PostgreSQL 上分别验证全新部署与旧 `db push` 数据库的 baseline/deploy 流程，未提供该环境时必须明确记录为未执行，不能把静态 SQL 检查写成迁移通过。
- 固定 seed 测试：每张图恰好 16 次部署消费、16 个唯一普通地板且输入顺序不影响结果。
- 完整测试、类型检查、静态检查、browser game-engine/mobile 构建，以及桌面与 390×844 候选版人工验收。

## 回退方式

整体回退 RED-119：恢复 `large-battlefield.json`、固定单图入口和相应合同。代码回退可以停止读写独立 Relay 的可空 `mapId`；已经部署到数据库的可空列默认保留，避免破坏性降级迁移，只有经备份与单独人工批准才允许删除该列。回退不迁移或重写已进行中的 `BattleState`，不修改随机算法、流名、消费次数或存档版本。

## 相关资料

- [RED-119](https://linear.app/redvsblue/issue/RED-119)
- [Demo v0.1 核心对局合同](../product/DEMO_V0_1_CORE_MATCH_CONTRACT.md)
- [ADR-0007：固定全地图部署与玩家独立重投流](./ADR-0007-deterministic-deployment.md)
- [ADR-0009：部署选择锁定、权威超时与公开同步](./ADR-0009-authoritative-deployment-lock.md)
- `tests/game/map-selection.test.ts`
- `tests/game/deployment.test.ts`
- `tests/game/relay-deployment.test.ts`
