# RED-170：Colyseus 双人单局闭环验收

- 风险：High
- 基线：`main@55037468e07dbeff9729d3cff790806cef5c7c35`
- 分支：`codex/red-170-colyseus-single-match`
- 状态：实现验证中，等待独立审查与人工双机验收

## 可复现的原故障

1. 两名玩家进入渐进部署回合，其中一方断线或权威直接 receipt 丢失。
2. 旧客户端每秒 `joinById` 建立替代 Room，旧 session 与新 session 的消息/席位生命周期重叠。
3. BattleRoom 没有用 Room clock 安排权威 deadline；回执恢复也没有按原 actionId 查询结果。
4. UI 进入“正在等待权威确认”后没有可证明的 applied/rejected/unknown 终点，按钮同时被 250 ms
   轮询反复重建，表现为卡死、延迟和需要多次点击。

## 验收矩阵

| 场景 | 期望 |
| --- | --- |
| 正常双人单局 | 两个真实 SDK 客户端从建房进入战斗并得到唯一权威终局 |
| 每回合渐进部署 | 自己每回合预备区非空时使用当前 revision 的 offer；一次部署至多提交一次 |
| 100 次瞬时断线 | 恢复同一 session，状态不回退，不出现第二席位 |
| 部署中断线 | version/hash、offer/revision/合法位置和 deadline 与断线前一致 |
| receipt 丢失 | 按同一 clientActionId 得到 applied/rejected/unknown；客户端 pending 有界结束 |
| 回合超时 | Room clock 只唤醒同一 FIFO；无重复自动部署、重复换回合或重复版本 |
| PostgreSQL idle error | 记录错误上下文，Node 不因未监听 Pool error 退出 |
| Colyseus 进程退出 | 当前局明确中止；Electron 至多一次有界重启并返回连接页 |

## 自动验证

2026-09-02 实际结果：

| 命令 | 结果 |
| --- | --- |
| `npm.cmd run test:colyseus` | 8 文件、17 项通过；包含 100 局双 SDK 客户端 soak、100 次断线及部署中恢复 |
| RED-170 受影响 game/electron 测试集合 | 11 文件、187 项通过 |
| `tests/game/ai-environment.test.ts` | 23 项通过，确认 30 秒回合外 pending 投影 |
| `npm.cmd run typecheck` | 通过 |
| 变更文件 ESLint | 通过，0 warning/error |
| `npm.cmd run build` | Next standalone 构建通过 |
| `npm.cmd run build:electron:client` | Windows 客户端候选、Colyseus 与 PostgreSQL 16.15-2 打包校验通过 |
| `npm.cmd run smoke:electron:windows -- client` | 通过；本机 authority/Profile/PostgreSQL、建房、页面资源及进程退出均通过 |
| `npm.cmd run test:postgres` | 2 项因未提供外部 `TEST_POSTGRES_URL` 跳过；未描述为通过 |

全仓 `npm.cmd test` 首次运行结果为 1984 通过、10 失败、2 跳过。与 RED-170 相关的 AI 计时期望已
更新并隔离复跑通过；100 局 soak 已改为等价但更轻的真实 Room fixture，隔离及 Colyseus 整组复跑通过；
RED-160 延迟用例在全仓并发下仅以 100.147 ms 越过 100 ms 门槛，隔离复跑通过。其余失败来自当前
checkout 缺 Android 生成 bundle、打包测试 fixture 未创建 runtime 文件、既有 status icon/AI manifest
审计，与本任务修改路径无关。

完整四入口 Windows smoke 的产品断言运行后，在清理临时 Profile PostgreSQL 目录时以 `EPERM` 失败；
遗留临时进程已按精确临时路径停止。RED-170 直接相关的 `client` 候选随后独立复跑通过且报告
Electron、Node、PostgreSQL 进程退出计数均为 0。

关键测试位于：

- `tests/colyseus/reconnection-receipt.test.ts`
- `tests/colyseus/product-room.test.ts`
- `tests/colyseus/single-match-soak.test.ts`
- `tests/colyseus/postgres-pool-lifecycle.test.ts`
- `tests/game/turn-timer-room.test.ts`
- `tests/game/ws-client-reconnect.test.ts`
- `tests/game/battle-page-contract.test.ts`
- `tests/electron/colyseus-player-path.test.ts`

## 人工候选验证

1. 两台客户端连接同一本机 Host & Play authority，完成建房、选人和至少三个双方回合。
2. 确认每个自己的回合只要预备区非空就先部署，不是仅开局部署。
3. 分别在部署选择、普通行动、pending 响应时断网 1–5 秒，恢复后只需继续操作一次。
4. 在日志中核对 roomId、sessionId、clientActionId、authorityVersion 与 deadline；不得出现永久 pending。
5. 测试中止 Colyseus 子进程，确认客户端明确结束当前局、返回连接页且只自动重启一次。

## 已知边界

RED-170 不实现跨进程 live migration。权威进程真正退出时，内存中的当前局不能靠 SDK session 原地续活；
已耐久记录仍可用于后续恢复能力，但本基础版选择明确中止，不把不完整恢复伪装成继续游戏。
