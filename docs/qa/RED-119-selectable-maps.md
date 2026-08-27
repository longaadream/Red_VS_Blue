# RED-119 多地图选择候选验收证据

## 结论与适用范围

- 人工产品验收：**通过（2026-08-27）**。
- 工程候选状态：**BLOCKED（不得宣称候选版本已经通过或可以合并）**。
- 基线：`base_branch: main`，`base_sha: 81c754f247b4f627741fbb953df820fdd82ffee2`。
- 已取得的证据覆盖：四图目录、创建房间选图、桌面与 `390x844` 浏览器布局、地图目录失败降级，以及四张地图逐图创建 PVE 房间并进入正式战斗。
- 尚未取得的候选证据：真实 Bun standalone Relay 浏览器流程、全新与既有真实 PostgreSQL 数据库迁移演练，以及可通过的 lint。上述缺口均为阻塞项，本文的浏览器和 SQLite 结果不能代签。

## 四图目录与浏览器 UI

正式可选地图严格为以下四张；已退役的 `large-battlefield`（“大型战场”）不在目录、选择器或 `/api/maps` 返回值中。

| 顺序 | mapId | 显示名 | 尺寸 | 可行走格 |
| ---: | --- | --- | --- | ---: |
| 1 | `large-hole-arena` | 大型洞穴 | 20 × 16 | 189 |
| 2 | `open-expanse` | 开阔原野 | 20 × 16 | 242 |
| 3 | `winding-pass` | 回风曲径 | 20 × 16 | 192 |
| 4 | `narrow-corridors` | 狭廊要道 | 20 × 16 | 160 |

`/api/maps` 实际返回上述顺序；每张地图都是 `20 × 16`、共 320 格，出现的格子类型仅为 `wall`、`floor`、`cover`、`hole`。没有熔岩、充能台或治愈泉。

浏览器使用 headed Microsoft Edge 验证：

- 地图目录在桌面 viewport 与 `390x844` viewport 均显示恰好四张地图；移动 viewport 的 `innerWidth` 与 `scrollWidth` 都是 390，没有横向溢出。
- 创建房间面板显示四个实际 `mapId`，默认值为 `large-hole-arena`；目录加载成功时地图选择器和创建按钮均可用。
- `390x844` 下地图选择器和创建按钮均完整位于 viewport 内。
- 将 `**/api/maps` 拦截为 HTTP 500 后，地图选择器与创建按钮同时禁用；选择器只显示“地图加载失败”，页面显示“地图加载失败：地图目录 HTTP 500”，且 `width` / `scrollWidth` 仍为 390。移除拦截后恢复正常目录。
- `open-expanse` 的移动端战斗页实际渲染“20 × 16 战术棋盘”、16 个具名棋子和部署确认状态；四张地图均取得桌面战斗页证据。

截图：

- [地图目录（桌面）](evidence/RED-119-map-catalog-desktop.png)
- [地图目录（390x844）](evidence/RED-119-map-catalog-390x844.png)
- [创建房间选图（桌面）](evidence/RED-119-lobby-select-desktop.png)
- [创建房间选图（390x844）](evidence/RED-119-lobby-select-390x844.png)
- [地图 API 失败时禁用创建（390x844）](evidence/RED-119-map-api-failure-disabled-390x844.png)
- [开阔原野战斗页（桌面）](evidence/RED-119-battle-open-expanse-desktop.png)
- [开阔原野战斗页（390x844）](evidence/RED-119-battle-open-expanse-390x844.png)
- [大型洞穴战斗页（桌面）](evidence/RED-119-battle-large-hole-arena-desktop.png)
- [回风曲径战斗页（桌面）](evidence/RED-119-battle-winding-pass-desktop.png)
- [狭廊要道战斗页（桌面）](evidence/RED-119-battle-narrow-corridors-desktop.png)

## 人工验收记录（2026-08-27）

- 产品负责人确认三张新地图的空旷、弯绕、狭窄视觉差异符合预期，并确认“大型战场”已从正式目录退役。
- 在隔离的本地候选服务中，负责人亲自完成账号设置、连接 localhost:3000、进入大厅、查看四图下拉、选择“回风曲径”、创建房间，并确认房间页仍显示“回风曲径”。本次临时房间 ID 为 1owwy，验收结束后已删除。
- 负责人明确表示无需再凑第二位玩家，接受由全量自动测试、HTTP/LAN 篡改冻结回归及下述四图逐图 PVE 开战证据替代双玩家手工流程。
- 结论仅表示产品视觉与本地选图流程人工验收通过；不等同于 High Risk 合并批准，也不覆盖 Bun standalone Relay、真实 PostgreSQL 迁移或 lint 环境阻塞。

## 四张地图逐图正式开战

浏览器通过正式 PVE 房间创建、8 张阵容选择和开始战斗入口逐图执行。服务端启用 `RVB_BATTLE_AUTHORITY_V2=1`，每个房间均返回 HTTP 200，并进入 `in-progress`。下表中的“一致”指持久化的 `Room.mapId`、正式 `BattleState.map.id` 和请求选中的 mapId 三者完全相同。

| 地图 | roomId | seed | map 一致 | core | 唯一坐标 | 均为普通 floor | 部署游标 |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| `large-hole-arena` | `pve-qa2-larg-mtbivbh7` | 1407474909 | 是 | 16 | 16 | 是 | 0 → 16 |
| `open-expanse` | `pve-qa2-open-mtbivdpr` | 3062850792 | 是 | 16 | 16 | 是 | 0 → 16 |
| `winding-pass` | `pve-qa2-wind-mtbive8v` | 2579177111 | 是 | 16 | 16 | 是 | 0 → 16 |
| `narrow-corridors` | `pve-qa2-narr-mtbiveop` | 3240308851 | 是 | 16 | 16 | 是 | 0 → 16 |

逐图初始坐标如下；每张地图的 16 个坐标互不重复，且对应地图格均是普通 `floor`：

- `large-hole-arena`
  - bot：`(15,9) (8,12) (9,6) (11,8) (9,14) (10,3) (7,9) (7,6)`
  - host：`(10,11) (1,8) (16,2) (1,4) (1,3) (9,12) (16,3) (12,8)`
- `open-expanse`
  - bot：`(10,4) (6,9) (15,7) (17,11) (8,10) (6,13) (18,11) (3,12)`
  - host：`(16,14) (17,8) (16,9) (6,14) (1,2) (12,5) (1,8) (9,2)`
- `winding-pass`
  - bot：`(14,9) (12,13) (5,2) (4,14) (12,5) (11,14) (10,12) (16,12)`
  - host：`(13,8) (8,3) (4,1) (4,6) (18,13) (4,12) (10,7) (14,13)`
- `narrow-corridors`
  - bot：`(12,14) (6,12) (12,5) (7,1) (17,4) (6,5) (10,10) (14,3)`
  - host：`(7,3) (9,14) (14,8) (2,5) (1,8) (4,5) (18,6) (17,3)`

该浏览器验收使用隔离的 `output/playwright/red119-qa.db`，没有读取或修改生产数据库。因工作树环境中的 Prisma `db push` schema engine 未给出可用诊断，测试先以 `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` 生成 SQL，再由 Node 内置 `node:sqlite` 仅应用到该隔离文件。这个方法足以支撑本地 UI/规则证据，但不等价于 PostgreSQL 迁移演练。

## 自动化与静态验证

| 检查 | 结果 |
| --- | --- |
| RED-119 定向 Vitest：`map-catalog`、`map-selection`、`deployment`、`lobby-map-selection`、`relay-deployment`、`relay-routes`、`relay-store`、`roster-transports` | 8 个文件、153 个测试通过 |
| 全量 Vitest | 105 个文件、909 个测试通过；约 93.95 秒 |
| 独立验证者定向回归 | 15 个文件、184 个测试通过 |
| 独立验证者全量回归 | 105 个文件、909 个测试通过 |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run build:game-engine` | 通过；Web 与 Android game-engine 产物已重建 |
| `npm.cmd run build:mobile-server` | 通过；Android mobile-server 产物已重建 |
| `npm.cmd run check:encoding` | 通过，检查 632 个文件 |
| `git diff --check` | 通过 |
| standalone Prisma schema `validate` 与从空库 schema diff | 通过；仅是 schema 静态证据 |
| `npm.cmd run lint` | **失败 / BLOCKED**：现有 ESLint 配置引用 `import/no-anonymous-default-export`，当前共享依赖环境没有加载 `import` 插件；本任务没有擅自更新依赖或规则来掩盖该基线问题 |

自动测试另覆盖：非法或已退役 mapId 在 seed/RNG/版本/房间写入之前被拒绝；进行中旧房间以嵌入的 `BattleState.map` 恢复时不被新的目录校验污染；同一固定输入与 seed 的部署结果稳定，反转输入顺序仍保持规定的确定性与不变量。

## 运行环境说明

普通 Turbopack dev 启动在该 Git worktree 中因 `node_modules` 符号链接指向工作树文件系统根之外而崩溃。浏览器验收因此使用 Next 官方 webpack 入口：

```text
node --require ./scripts/ws-same-port-server.cjs ./node_modules/next/dist/bin/next dev --webpack
```

这只记录本机 worktree 环境差异；它不是 RED-119 产品逻辑通过或失败的证据，也不应通过修改依赖布局纳入本任务范围。

## `relay-battle-init` 边界

房间感知的 Web、LAN、HTTP、desktop 和 mobile 正式开战都必须从已持久化的 `Room.mapId` 读取冻结地图，并在 seed/RNG 和状态写入之前重新验证。

Next `/api/relay-battle-init` 与 Android `handleRelayBattleInit` 是无 Room 上下文的 stateless 兼容 bootstrap；当前没有 UI 调用者。它们只能验证调用者已冻结并提交的 mapId，然后才可创建 seed，不能读取或写入 Room，也**不能**作为“Room 选图已冻结”的验收证据。standalone Relay 仍只提供选图前房间 REST/WS 协调，不伪造正式战斗权威。

## 阻塞项与后续候选验收

以下工程项目完成前，RED-119 不能标记候选环境通过或 merge-ready；产品视觉与本地选图流程的人工验收已按上述记录通过：

1. 本机没有 Bun，未能启动 standalone Relay 并完成真实浏览器的创建、加入、选图、房间 WS 更新和权威不可用边界验收。
2. 本机没有 PostgreSQL、Docker 或 `psql`，未执行：
   - 全新 PostgreSQL 数据库依次应用基线迁移和 `Room.mapId` ALTER；
   - 既有 `db push` 数据库备份、标记基线已应用、再部署 ALTER；
   - 两条路径的数据保留、回滚和重复部署核对。
3. lint 仍因现有 ESLint 插件配置缺失而失败，需要单独恢复共享 lint 环境或经批准修复依赖配置后重跑。
4. High Risk 合并仍需针对届时的精确 PR head 单独批准；本次人工产品验收不是合并授权。

建议下一轮在具备 Bun 与一次性 PostgreSQL 实例的候选环境复跑相同四图矩阵，并把原始终端输出、数据库前后 schema/data 摘要及 standalone 浏览器截图附回本文件。当前可报告的状态仅为：**代码级与本地浏览器证据已取得，候选验收仍 BLOCKED**。
