# RED-164 回合外 Pending 独立响应计时验证

风险：High

## 自动验证

- `tests/game/turn-timer.test.ts`：普通计时冻结、15 秒响应投影、恢复精确剩余时间、每个新会话刷新 15 秒、强制 option 预声明稳定默认值。
- `tests/game/turn-timer-room.test.ts`：迟到提交被替换为 `pendingTimeout`、只结算当前会话、响应超时不结束回合或累计无操作 streak、旧回调幂等、调度期间不触发普通烧绳、公开状态不泄漏默认答案、客户端不能伪造系统动作。
- `tests/game/turn-timer-status-ui.test.ts` 与 `tests/game/battle-page-contract.test.ts`：HUD 显示响应倒计时及冻结的普通剩余时间，并接收全量快照和增量更新中的 `pendingTimer`。
- `tests/game/ai-environment.test.ts`：AI 只获得通用响应计时元数据，不获得对手候选或服务端默认答案。

推荐命令：

```powershell
npm.cmd test -- tests/game/turn-timer.test.ts tests/game/turn-timer-room.test.ts tests/game/turn-timer-status-ui.test.ts tests/game/battle-page-contract.test.ts tests/game/ai-environment.test.ts
npm.cmd exec tsc -- --noEmit
```

## 双客户端人工验证

1. 活动玩家先等待普通计时下降，再触发由对手处理的 option 或 target pending。
2. 双端确认 HUD 改为 15 秒“响应计时”，并显示普通回合计时已冻结及冻结值；刷新任一端，响应计时不重置。
3. 对手在期限内完成或取消，确认活动玩家恢复到冻结值，服务端处理与传输耗时不扣除。
4. 连续产生两个 pending，确认第二个会话获得新的完整 15 秒，旧会话的超时回调不改变状态。
5. 让可取消会话超时，确认只取消当前会话且活动回合继续；让不可取消会话超时，确认使用预声明的稳定首个合法答案，固定 seed 重放结果一致。
6. 确认响应超时不新增 `turnTimeout`，不改变双方无操作 streak；随后普通回合超时仍按原规则结算。
7. 在当前回合玩家自己处理 pending 时，确认没有独立响应计时，普通回合时限继续下降。

## 回退验证

整体 revert RED-164 后运行 RED-36 计时回归，确认旧快照不再包含 `pendingTimer`。不得只回退 HUD 或系统动作的一侧。
