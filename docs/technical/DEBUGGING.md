# 调试指南

更新：2026-09-01（RED-158 Phase F）

## 最小证据

联机或规则问题至少记录：

- roomId、battleId、playerId 和 seat；
- Profile/content hash、协议版本和 authority build；
- 当前 phase、turn、authority version 和 durable version；
- clientActionId、动作类型和期望版本；
- root seed、相关随机流/cursor；
- 前后内部/公开 state hash、action hash 和 transition hash；
- receipt 状态、拒绝 code、服务端调用位置和时间；
- 双方截图或终局战报 ID。

不得吞掉异常、重发成新的 actionId 来掩盖错误，或仅靠重复点击判断修复。

## 连接失败

1. 对配置的唯一 authority origin 请求 `GET /healthz`。
2. 确认响应为 `ok: true` 且 `protocol: rvb-colyseus`。
3. 请求 `GET /rooms/:roomId`，确认房间存在且 ID 与邀请一致。
4. 使用 Colyseus `joinById(roomId)`；不要先用目录结果决定房间是否可加入。
5. 检查 Profile/build/协议/座位拒绝码，以及 Electron/Colyseus stderr。

日志里的连接 URL 必须移除用户名、密码、query 和 fragment。

## 重复房间

记录一次点击产生的所有请求和 `creationKey`：

- 页面按钮应在 Promise 完成前保持禁用；
- `RvBColyseus.createRoom()` 应对并发调用单飞；
- 服务端相同 `creationKey` 在 claim TTL 内应返回同一房间；
- `/rooms` 应按规范化 roomId 去重。

如果两个卡片只是同一 roomId 的重复目录项，先检查服务端目录去重；如果 roomId 不同，检查创建 key 是否
被重新生成或 UI 是否重复绑定事件。

## 动作或状态不一致

对照 receipt 与 transition：

- duplicate：相同 clientActionId 必须返回同一结果；
- stale：客户端停止提交并从 Colyseus 完整状态恢复；
- future/gap：服务端失败关闭并记录链上下文；
- hash mismatch：保存前态、动作、seed、Transition 和 Checkpoint，不继续运行该房间。

使用固定初态、seed 和动作序列调用规则重放，比较每一步 state hash。在线已发生比赛优先使用 durable
Trace/Replay Frame，不用当前页面重新演算历史事实。

## PostgreSQL durable 故障

先比较 online authority version 与 durable version，再检查 journal/repository 错误：

- 连接或事务失败：房间不得把未 durable 的终局暴露为战报；
- version 冲突：检查 battleId 是否出现并发 writer 或重复 toVersion；
- hash/Checkpoint 失败：保存相关行和重放证据，按数据损坏处理；
- drain 超时：保持显式失败，退出清理不得报告成功。

集成测试必须使用独立 `RVB_TEST_POSTGRES_URL`。不要对真实数据库执行清空、schema 试验或测试 teardown。

## 战报不可读

`readBattleReport()` 会验证初始 Checkpoint、连续 Transition/Receipt、全部 hash、终局 Trace/Replay Frame
和 Terminal Barrier。错误码应指出第一处失败证据。不要回退到浏览器缓存或构造缺失字段。

## Windows 子进程

Electron Client 会转发 Profile、Colyseus 与 PostgreSQL 子进程的 stdout/stderr，并附带 runtime 上下文。
退出问题记录进程 PID、监听端口、journal drain 结果和残留 executable 路径。

构建候选后可运行：

```powershell
node tests/electron/windows-smoke.mjs client
```

冒烟在系统临时目录运行隔离包；失败时保留的证据目录应先检查再手工清理。

## 标准回归

```powershell
npm.cmd run check:windows-cutover
npm.cmd run typecheck
npm.cmd run test:colyseus
npm.cmd run test:postgres
npm.cmd test
```

若全量测试只在高并发下出现性能阈值超时，应单独运行受影响 gate 并记录两者结果；不能直接把并发失败
写成通过，也不能放宽阈值掩盖资源争用。
