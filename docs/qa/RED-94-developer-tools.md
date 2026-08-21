# RED-94：游戏内开发者工具 MVP 验收

## 目标与边界

RED-94 在公开客户端主菜单提供局外开发者中心，并在权威终局后提供整场比赛 Trace 下载。开发者中心和 trace 不得连接、读取或控制正在进行的真实对局。

本次包含：

- 固定 seed、正式 Runner、内存隔离的双人规则场景。
- 地图、回合/阶段、当前 actor、玩家、命令 trace、随机流和状态 hash 展示。
- 进行中真实对局隐藏完整 action trace。
- 权威终局后生成 `rvb-match-trace/v1`，立即下载并在开发者中心再次下载最近一场。
- 删除 `battle.html` 旧反引号局内修改器。

本次不包含回放码、Trace 导入、可视化回放、跨版本重演、真实房间调试、规则/数值/随机算法、存档或数据库变更。

## 自动验证

从仓库根目录执行：

```powershell
npm.cmd test -- tests/game/debug-battle.test.ts tests/game/developer-tools-trace.test.ts tests/game/developer-tools-api.test.ts tests/game/battle-page-contract.test.ts tests/electron/developer-tools-page.test.ts tests/electron/battle-page-runtime.test.ts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

重点断言：

- 成功动作 trace 含脱敏规则动作；非法动作不修改状态或 trace。
- 无 `deployment` 的进行中状态仍清空 `actionLog` 和 `appliedActionIds`。
- 终局投影保留完整脱敏 trace，且敏感字段不泄漏。
- Trace 记录器拒绝没有 `terminalResult` 的状态。
- 隔离 API 不返回 roomId，并声明不创建房间、不发奖励、不写统计。
- 开发者页面不加载 WebSocket、不请求真实战斗快照、不发送房间动作。
- 旧 AP/CP/生命/击杀/冷却修改器标识全部不存在。
- `battle.html` 所有内联脚本可解析，DOM ID 不重复。

## 人工验证

### 1. 局外入口和隔离场景

1. 从主菜单打开“开发者中心”。
2. 确认页面说明“仅限局外”，且没有 roomId 输入、加入房间或发送动作入口。
3. 使用默认 seed `20260821` 运行场景，记录状态 hash、命令数和 JSON。
4. 使用完全相同配置再次运行，预期状态 hash 和 action trace 相同。
5. 更换 seed，预期 seed 和通常的状态 hash 变化。
6. 确认响应中的 `isolation` 为 `in-memory`、`createsRoom=false`、`grantsRewards=false`、`writesStatistics=false`。

### 2. 进行中真实对局门禁

1. 进入一场真实对局，确认客户端已写入 `rvb_active_battle`。
2. 返回或另开开发者中心页面，预期显示进行中对局警告，场景表单不可操作。
3. 检查真实对局公开快照：`extensions.debugBattle.appliedActionIds` 与 `actionLog` 均为空。
4. 确认战斗页没有开发者入口；反引号不会出现修改器，页面中不存在 AP/CP/满血/击杀/重置 CD 控件。
5. 即使单独调用隔离场景 API，也只能得到新建的内存场景摘要，不能读取或控制正在进行的房间。

### 3. 赛后完整 Trace

1. 完成一场真实对局，等待权威 `terminalResult` 出现。
2. 终局覆盖层应出现“下载比赛 Trace”，点击后下载 JSON。
3. 检查文件：
   - `format = rvb-match-trace/v1`；
   - 包含 room、seed、authorityVersion、地图、回合、终局原因、最终状态 hash；
   - 每条 trace 含 action/actionId/actionHash、actor、turn、rootSeed、randomStreams、preStateHash、postStateHash；
   - 没有 authorization/auth/signature/token/accountId/publicKey/privateKey/mnemonic/password/cookie/session 等字段。
4. 返回主菜单再打开开发者中心，预期显示最近一场摘要并可再次下载相同记录。
5. 点击“清除本地 Trace”，预期摘要和下载按钮消失；这只删除 `rvb_last_completed_trace`。

## 已知限制

- Trace 是诊断 JSON，不是可导入存档或可重放协议。
- 仅保留最近一场完整 Trace；浏览器 localStorage 配额不足时，终局页仍可立即下载，但无法保证下次打开开发者中心仍存在。
- MVP 不承诺跨版本兼容；新角色或规则可以出现在后续 trace 的规则动作里，但旧客户端不保证理解新字段。

## 回退

本任务没有数据库、迁移、依赖、存档格式或随机算法变更。代码回退时撤销 RED-94 提交即可；已经保存在客户端的 `rvb_last_completed_trace` 是独立 JSON，可安全保留或由用户在开发者中心清除。
