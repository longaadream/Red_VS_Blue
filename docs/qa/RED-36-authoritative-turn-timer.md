# RED-36 权威成长型回合计时验证

## 自动验证

以下用例全部使用伪时钟，不包含真实 `sleep`：

- `tests/game/turn-timer.test.ts`：完整轮次边界、正常/烧绳投影、20 秒快速回合。
- `tests/game/turn-timer-room.test.ts`：规则/唯一 CAS/结果准备期间推进假时钟、CAS 冲突重试不发布 speculative 版本、处理跨 15 秒阈值时投影不反转、pending 输入归属与返回活动玩家时恢复原预算、end phase/“回合结束时”输入继续计时且超时不重复结算、action phase 超时强制 `endTurn` 才产生 pending 时不补发预算、合法/非法动作、玩家独立 streak、第三次超时终局、烧绳幂等、刷新不重置、客户端伪造系统动作，以及玩家超时后 bot 回合接管。
- `tests/game/turn-timer-status-ui.test.ts`：服务器期限显示、最后 15 秒和快速回合样式状态。
- 相邻回归：部署、RED-34 终局、终局传输和 battle UI 边界测试。

推荐命令：

```powershell
node node_modules/vitest/vitest.mjs run tests/game/turn-timer.test.ts tests/game/turn-timer-room.test.ts tests/game/turn-timer-status-ui.test.ts tests/game/deployment-room.test.ts tests/game/terminal.test.ts tests/game/terminal-transport.test.ts tests/game/battle-ui-boundary.test.ts tests/game/deployment-status-ui.test.ts
npm run typecheck
```

## 双客户端人工验证

1. 用两个浏览器会话加入同一房间，完成阵容和 45 秒部署锁定。
2. 双端确认相同回合剩余时间；刷新任一端，剩余时间继续下降且不回到初始值。
3. 等到最后 15 秒，确认两端进入烧绳状态且服务端动作日志只有一个 `turnTimerBurn`。
4. 当前玩家不操作直到超时，确认自动进入对方回合；该玩家下次自己的回合显示 20 秒快速计时，对方时限不受影响。
5. 快速回合中执行一个合法动作，再轮转回来，确认恢复对应完整轮次的成长时限。
6. 活动玩家先消耗部分时限，再触发 pending 或“回合结束时”选择；确认计时归属切给实际响应者，响应完成后活动玩家只恢复原剩余预算且烧绳阶段不重复。响应超时结束活动回合，但不会把它计作响应者“自己的回合”无操作 streak，也不会记到活动回合玩家名下；若倒计时先归零、随后强制 `endTurn` 才产生选择，应直接进入下一回合而不是出现新倒计时。
7. PVE 中让人类玩家超时，确认进入 bot action phase 后 bot 自动行动，不等待 bot 自己超时。
8. 重复三次无操作超时，确认第三次只生成一个 `timeout-surrender`，房间进入 `finished`，之后玩法命令被拒绝。

## 预期证据

- 两端同一 `authorityVersion` 的 `serverNow`、`deadlineAt`、`remainingSeconds` 和 `burning/fast` 投影一致。
- 房间写入只发生在接受的玩法动作、烧绳阶段切换和超时；GET/刷新不写状态。
- 终局结果沿用 RED-34 的 `terminalResult`，客户端不上传 winner 或 timeout。

## 2026-08-21 本地双客户端记录

- 环境：隔离 SQLite 数据库、`next dev --webpack`、Playwright Chromium，房间 `red43-light-mt1wnqcy`，Alice `3fd318ad`，Bob `b0d2b7ab`。
- 同一 45 秒权威期限内，Alice 客户端先显示 `00:23`，Bob 客户端随后显示 `00:21`；两端均显示第 1 回合行动阶段，行动方为 Alice。
- 刷新 Alice 后没有回到 `00:45`；因验证工具与页面加载耗时，刷新完成时显示 `烧绳阶段，剩余 0 秒`，证明页面继续使用原服务端 `deadlineAt`。
- 本次浏览器记录覆盖双端投影、烧绳文案与刷新不重置；合法动作、快速回合、pending 输入归属、PVE 接管和三次超时投降由上述伪时钟自动测试覆盖。
- QA 入口使用只读调试身份，浏览器控制台包含该入口既有的身份/HMR 调试噪声；正式动作权限路径未通过该入口绕过。
