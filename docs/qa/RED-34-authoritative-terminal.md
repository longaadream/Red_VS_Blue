# RED-34 服务端权威终局验收记录

## 状态

- 实现完成；原 RED-34 独立 AI 审查已通过，最新 main 冲突合并已完成自检，等待 CI 与人工验收。
- 风险等级：High。
- 不涉及存档格式迁移；回退方式为回退本任务单一提交。

## 实现范围

- 游戏规则层统一计算核心棋子全灭、双方同时全灭、投降和完成 40 轮后的终局结果。
- 终局结果只在公开动作完全结算后写入；待选择动作不会提前结算；终局事件只记录一次。
- HTTP 与 WebSocket 共用 `dispatchRoomBattleAction()` 及房间版本 CAS；Bot 使用同语义 CAS 持久化边界。并发命令只有一个提交并广播，重试后看到终局的命令以 `BATTLE_ALREADY_TERMINAL` 拒绝。
- 房间终局时同步 `status=finished`；客户端伪造的 `gameOver`、`winner` 与 `terminalResult` 字段会被拒绝。
- 桌面战斗页只展示服务端 `terminalResult`，Relay 主客双方只发送动作，不再本地结算或上传战斗状态。
- 按产品确认，移动端旧 action log 不在本任务中维护或迁移；移动端框架重塑另行处理。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| RED-34 / RED-31 聚焦测试 | 9 个文件、88 个测试通过 |
| 完整测试套件 | 60 个文件、495 个测试通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint:prune -- --ignore-pattern ".worktrees/**"` | 通过；只清理 1 个已失效 suppression |
| `npx next build --webpack` | 通过 |

隔离 worktree 使用指向仓库根依赖的临时 `node_modules` junction；Turbopack 因该链接指向项目根外而在应用编译前拒绝运行。相同源码用 Next 官方 `--webpack` 后端完成生产构建，仅报告仓库已有的 middleware 弃用与 Edge Runtime 警告；标准 Turbopack 构建由 PR CI 在普通依赖布局中复验。

## 关键行为证据

- HTTP 与真实 WebSocket 同时投降的竞争测试通过：两个命令读取同一版本时，仅一次 CAS 写入成功；失败方重读后收到 `BATTLE_ALREADY_TERMINAL`，房间最终为 `finished`，终局日志只有一条。
- 核心棋子单方全灭、双方同时全灭、投降、40 个完整轮次平局、待选择延迟结算、终局后动作拒绝与重复命令均有回归测试。
- Bot 终局持久化使用相同 CAS 约束，并同步房间完成状态。
- Playwright 冒烟验证：注入权威终局状态后，桌面页面显示 `WIN`、`胜利` 与“红方 获胜 · 核心棋子全灭 · 已完成 3 轮”。

## 独立审查

独立审查最终结论为通过。首轮指出的三个问题均已关闭：

1. HTTP/WebSocket 缺少原子并发保护。
2. Relay 主机仍可能作为规则权威。
3. Bot 路径没有同步房间完成状态。

## 建议人工验证与已知边界

1. 使用真实 Prisma 数据库和两个独立客户端重复“同版本同时投降”，确认跨进程部署下仍只有一个成功提交和一条终局事件。
2. 验证客户端在终局发生前断线、重连后能从房间状态恢复同一个 `terminalResult`。
3. 如仍需部署独立旧 Relay 服务，需要将其重建为服务端规则执行器；浏览器主机权威已经移除。
4. 移动端旧 action log 与移动端新框架不在 RED-34 的修改范围内。
