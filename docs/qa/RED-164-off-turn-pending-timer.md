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

## 2026-09-01 验证记录

- `npm.cmd run check:main-baseline`：通过；`origin/main` 为 `bf0c7f68568f4fde5a3a04e6046054a0f527c19d`，分支 behind 为 0。
- 定向规则、投影、AI 与页面合同：6 个文件、101 条测试通过。
- Electron 战斗页运行时：2 个文件、22 条测试通过。
- `npm.cmd exec tsc -- --noEmit` 与 `npm.cmd run build:game-engine`：通过。
- 完整 `npm.cmd test`：176 个文件、1938 条测试通过，2 个文件中的 3 条测试因本机缺少候选版内嵌 PostgreSQL 与 Colyseus 打包产物失败；失败路径均不在 RED-164 修改范围。
- `npm.cmd run lint`：被仓库 ESLint 配置阻挡；配置启用了 `import/no-anonymous-default-export`，但没有注册 `import` 插件。
- 正式 `battle.html` 客户端运行时冒烟：桌面与 390 × 844 窄屏均显示“回合冻结 00:34”和独立“响应 00:15”；截图已附加到 Linear RED-164。真实房间入口因本机未配置 `DATABASE_URL` 无法创建房间。

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
