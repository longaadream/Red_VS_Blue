# RED-43 同阵营对局客户端 UI 验收

验收日期：2026-08-15

风险：Medium

入口：`http://localhost:3000/qa/same-alignment`

## 目的与边界

该本地开发入口创建固定 seed 的真实房间，并用正式 `battle.html` 验证同内容阵营对局。敌我、选中和目标高亮仍由 `ownerPlayerId` 与现有客户端/服务端规则产生；QA 面板只展示证据，不实现第二套规则。

启动页、创建房间 API 和资源路由 `/qa/client/**` 只在非 production 且 loopback 主机上可用；production 或远端请求返回 404，不改变联机协议、存档、随机算法或游戏规则。

## 可重复验收步骤

1. 按开发环境既有方式配置 `DATABASE_URL`，然后运行 `npm run dev`。
2. 打开 `http://localhost:3000/qa/same-alignment`。
3. 分别点击“光 / 光镜像局”和“暗 / 暗镜像局”的“创建验收房间”。
4. 记录页面显示的 Room、Seed、State hash、Server targets 和 Alice/Bob `playerId`。
5. 打开 Alice 视角，确认 RED-43 面板显示“我方 8 / 对方 8”。
6. 点击“加载验收技能”，确认面板显示“UI 8 / 规则 8”且“UI / 规则：是”。
7. 打开 Bob 视角，确认 Bob 的 8 枚棋子变成我方，Alice 的 8 枚棋子变成对方。

## 2026-08-15 验收记录

| 场景 | Room | Seed | State hash 前 12 位 | Alice / Bob | 技能 | 期望 | 客户端 / 服务端 |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| light/light | `red43-light-msu57xw4` | 4301 | `a044c1ca3d16` | `3fd318ad` / `b0d2b7ab` | `kenshin-amakakeru` | enemy | 8 / 8，一致 |
| dark/dark | `red43-dark-msu5h4ic` | 4302 | `cfeba7a3990a` | `3fd318ad` / `b0d2b7ab` | `fel-blessing` | ally | 8 / 8，一致 |

光/光 Alice 视角的客户端日志记录 8 个高亮目标全部为 `ownerPlayerId=b0d2b7ab` 且 `relation=enemy`；Bob 视角中我方集合为 `b0d2b7ab-1..8`，对方集合为 `3fd318ad-1..8`。

暗/暗 Alice 视角的客户端日志记录 8 个高亮目标全部为 `ownerPlayerId=3fd318ad` 且 `relation=ally`。两局的 `window.__RVB_RED43__.snapshot()` 均返回 `consistent: true`。

- [光/光敌方目标高亮截图](evidence/red-43-light-light.png)
- [暗/暗友方目标高亮截图](evidence/red-43-dark-dark.png)

## 自动化与已知项

- `tests/qa/red43-ui-acceptance.test.ts` 用服务端实际预检对两个固定场景的 16 枚存活棋子逐一求值，并验证输入状态 hash 不变。
- 真实浏览器流程使用 Playwright CLI 执行；仓库当前没有统一的客户端 Playwright E2E 配置，因此本任务保留语义回归测试、可重复人工步骤、截图和页面 JSON 日志。
- 浏览器会对不存在的可选资源包指针/根清单产生非阻塞 404 探测，且现有技能清单中的 `evil-explosion.json` 缺失会产生警告。两者不影响房间连接或 RED-43 目标验收，也未在本任务范围内修改；建议单独建立资源整合任务。

## 回滚

回退 RED-43 PR 即可移除 QA 入口、本地资源路由、证据面板和固定场景。该操作不需要数据迁移或协议回退。
