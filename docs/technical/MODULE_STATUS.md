# 模块状态与验收入口

更新：2026-09-01（RED-158 Phase F）

## Windows 当前状态

| 模块 | 状态 | 当前入口 | 剩余验收 |
| --- | --- | --- | --- |
| 核心归约/Runner | 已实现并有自动回归 | `turn.ts`、`battle-runner.ts` | 完整套件与候选环境复核 |
| 房间 FIFO/运行时隔离 | 已实现并有压力回归 | `room-authority-queue.ts`、`room-rule-runtime.ts` | 独立审查 |
| Colyseus 房间权威 | 已实现并有真实 SDK 测试 | `lib/server/colyseus/**` | 双 Windows 人工联机 |
| PostgreSQL journal/恢复 | 已实现 | `lib/server/postgres/**` | 外部测试库集成与故障演练 |
| 战报/Trace/hash | 已实现并有篡改回归 | Repository + report HTTP | 双 Windows 终局战报体验 |
| Electron Client | 已切换为唯一 Windows 产品 | `electron-client/main.ts` | 候选打包/安装/退出冒烟 |
| 嵌入式 PostgreSQL | 已实现 SCRAM、持久化和清理失败关闭 | `electron-client/embedded-postgres.ts` | 候选包真实运行 |
| 页面联机适配 | 已切换为 `RvBColyseus` | `data/pages/js/colyseus-client.js` | 双端交互和断线恢复 |
| Android | 本任务不修改 | Android 自身任务 | 后续独立合同 |
| 独立 Relay | 本任务不修改 | `relay-server/` | 后续独立合同 |

## RED-158 必验项目

1. 一次建房只产生一个 roomId 和一张目录卡片。
2. 第二台 Windows 通过该 roomId 直接加入，不出现目录预检超时。
3. 双方完成阵营/阵容确认并进入战斗。
4. 双方动作得到连续 receipt/transition 和一致公开 hash。
5. 终局完成 durable barrier，战报可读取且 Trace/hash 验证通过。
6. 主机退出后无 PostgreSQL/Colyseus 残留进程；重启后 durable 战报仍可读取。
7. 静态 cutover 门禁、类型检查、相关自动测试和 Windows 包验证通过。

## 已知风险

- 这是 High Risk 跨模块切换，需要独立代码审查和人工方案/候选批准。
- 没有 `RVB_TEST_POSTGRES_URL` 时真实外部 PostgreSQL 集成测试会跳过。
- 大型 Vitest 套件在高文件并发下可能触发性能 gate 的机器争用，需要同时记录全量结果和聚焦 gate。
- Android/Relay 与 Windows 当前权威不构成跨平台验收；不能把 Windows 通过扩展成 Android 已完成。

## 证据入口

- [RED-158 Windows cutover](../qa/RED-158-colyseus-postgresql-windows-cutover.md)
- [架构](./ARCHITECTURE.md)
- [接口地图](./MODULE_INTERFACES.md)
- [构建与运行](./BUILD_AND_RUN.md)
- [调试](./DEBUGGING.md)

AI 只能报告“实现完成并等待人工验收”，不能代替项目负责人确认最终产品体验、合并或发布。
