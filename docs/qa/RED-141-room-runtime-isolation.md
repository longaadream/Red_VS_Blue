# RED-141：每房间规则运行时隔离证据

- 角色：实现者
- 风险：High（已获人工方案批准）
- 基线：`main@4bca9fd3b4c903ee275eac5dfa6175f467dd53b0`
- 分支：`codex/red-141-room-rule-runtime`
- 允许范围：任务合同列出的 `lib/game/**` 目标文件、两份技术文档与本证据文件

## 修改前失败证据

在实现前先运行双房哨兵测试。两个房间共享进程级 `globalTriggerSystem`，room-b 的规则覆盖了
room-a 的规则，断言稳定失败为：`expected room-a, received room-b`。该失败证明问题来自共享规则
注册表，而非网络时序或重复点击。

## 实现与不变量

- 每个 roomId 只有一个 `RoomRuleRuntime`，持有独立 `TriggerSystem`、规则/技能/动态代码缓存和执行上下文。
- 新房间启动获得空运行时；已有旧房间首次恢复时只复制一次兼容规则快照，此后不再依赖全局可变状态。
- 玩家、pending、timer、bot 和 system 规则工作共用该房间 FIFO；同房串行、跨房并行。
- Runner、战斗初始化、回合和技能的深层调用均从显式同步上下文解析房间运行时。
- close 幂等清空规则与缓存、关闭 ingress；create/restore 不会隐式复活关闭实例。
- inspect 只读聚合现有运行时/FIFO 状态，不创建第二份真相。

## 验收矩阵

| 验收项 | 自动证据 | 结果 |
| --- | --- | --- |
| 不同阵容、规则与 seed 的两个房间各 100 次交错 Transition | 真实 authority-v2 dispatch/transition/receipt 与各自单房的最终 state hash、RNG cursor、pending、rule limits 和 authority version 全量比较 | 通过 |
| 异常或阻塞不跨房间传播 | room-a 在线规则 throw 保持 version 0，room-b 获得 applied ACK/version 1；room-a commit 阻塞时 room-b 继续 ACK | 通过 |
| pending、限制计数和编译缓存隔离 | 相同 selection/version、不同 effectCode 在两房各用私有 DynamicCodeRuntime 编译执行；检查 pending、rule uses、实例与 close 清理 | 通过 |
| 同房 FIFO、跨房并行和背压 | 真实规则工作阻塞 room-a 时 room-b 完成；room-a 次序与上限保持 | 通过 |
| 生命周期与只读检查 | create/restore 幂等；inspect 报告 active/pending/closed；重复 close 稳定且拒绝新提交/隐式复活 | 通过 |
| 在线链路不退回共享全局状态 | 架构守卫检查 actions/start 显式注入上下文，深层调用经上下文解析器选择实例 | 通过 |

## 已执行验证

- 修改前哨兵：`npm.cmd test -- tests/game/room-runtime-isolation.test.ts` — 失败（预期），证明共享实例污染。
- 聚焦隔离：`npm.cmd test -- tests/game/room-runtime-isolation.test.ts` — 6/6 通过；包含真实双房在线 dispatch/receipt 100-transition 与故障注入。
- 确定性运行时：`npm.cmd test -- tests/game/deterministic-runtime.test.ts` — 13/13 通过。
- 初次修正前的关键兼容回归：`npm.cmd test -- tests/game/turn.test.ts tests/game/turn-timer-room.test.ts tests/game/battle-authority-v2.test.ts tests/game/room-runtime-isolation.test.ts` — 当时 72/72 通过；最终覆盖以 130/130 结果为准。
- 异步权威性能：`npm.cmd test -- tests/game/battle-authority-async-dispatch.test.ts` — 1/1 通过。
- 最终受影响模块：11 个测试文件、130/130 测试通过。
- AI/Runner 隔离回归：`npm.cmd test -- tests/game/ai-environment.test.ts tests/game/room-runtime-isolation.test.ts tests/game/battle-runner-isolation.test.ts` — 实际匹配 2 个文件，22/22 通过。
- 最终游戏层全回归（排除需预生成 Android bundle 的冻结哈希文件）：91 个测试文件、782/782 通过。
- 全量测试首次运行：148/152 个文件、1526/1532 个测试通过。唯一 RED-141 相关失败是闭包直接改写源规则对象，已修复并由上述 AI/Runner 回归覆盖；4 个并行打包超时在单独重跑时 2 个文件、14/14 通过。
- 冻结跨端 hash 用例未能在隔离工作树执行：`android-client/www/js/game-engine.js` 是未跟踪预生成产物且当前不存在；为遵守 `allowed_paths`，未生成或复制该范围外文件。Node/桌面同文件中的其他 hash 断言未显示本次回归。
- 类型：`npm.cmd run typecheck` — 通过；命令生成的范围外 `next-env.d.ts` 差异已精确恢复。
- 编码：`npm.cmd run check:encoding` — 通过（812 个文本文件）。
- 主线基线：`npm.cmd run check:main-baseline` — 通过，仍基于最新 `origin/main@4bca9fd3b4c903ee275eac5dfa6175f467dd53b0`。
- 差异格式：`git diff --check` — 通过。
- 合同点名回归：deterministic、trigger ordering、turn、room queue、async dispatch 共 5 个文件、54/54 通过。
- Lint：`npm.cmd run lint` 在加载规则前失败。补齐 lockfile 已记录的 `eslint-plugin-import@2.32.0` 后结果不变；项目 flat config 在未注册 `plugins.import` 的独立配置对象中启用了 `import/no-anonymous-default-export`。`eslint.config.mjs` 不在 `allowed_paths`，故未越界修改，不能声明 lint 通过。

除上述 lint 安装环境和 Android 预生成 bundle 外，任务合同要求的可运行自动验证均已完成。

## 独立 AI 审查

独立验证者未参与实现，并按 `rvb-verify-linear-task` 从原始 Linear 合同、完整 diff 和原始命令输出重建
验收清单。首轮结论为“需修改”，指出 pending effect 仍走全局动态代码 cache、在线 dispatch/ACK 证据
不足，以及对 close 消费边界的疑问。修复前两项并读取下游 RED-143 合同后复审结论为“通过”：

- pending effect 已通过 `getRuleDynamicCodeRuntime()` 使用当前房间 context 的 cache；
- 新增真实 authority-v2 双房单跑/交错、throw 和 stalled-commit peer ACK 证据；
- RED-141 提供并验证幂等 close/no-revival 原语；terminal/delete ingress/queue/timer close 与竞态明确属于
  依赖 RED-141 的 RED-143，不在本任务越界实现；
- 独立复跑聚焦 6/6、合同/authority-v2 66/66、无生成 TypeScript、编码、baseline 和 diff 检查均通过。

上述独立 AI “通过”只表示实现满足代码合同；后续 High 风险人工候选验收结果记录在下一节。

## 人工候选验收（2026-08-31）

项目负责人在完成双房手工冒烟并查看自动化、独立审查证据后，批准以“少量人工冒烟 + 真实双房自动化”
替代同一台电脑持续运行四个前台客户端，并明确给出 RED-141 人工验收“通过”的结论。

- 人工冒烟：分别创建并进入两个独立房间，完成阵容准备并推进到战斗部署阶段；两个房间的玩家、阵容和
  部署状态保持独立。
- 核心合同：聚焦测试 6/6 覆盖两个房间各自单跑与交错执行 100 transitions，逐项比较 state hash、RNG
  cursor、pending、rule limits、authority version、真实 dispatch/receipt，以及故障隔离、同房 FIFO、跨房
  并发、背压、close/no-revival 和禁止在线全局 fallback。
- 相邻回归：最终受影响模块 130/130、游戏层 782/782、类型、编码、main baseline 与 diff 检查均已通过；
  独立 AI 复审的 RED-141 代码合同结论为“通过”。

四客户端尝试期间曾出现电脑卡死、部署倒计时停在 `00:00`，并记录到一次过期的 `deploymentLock`。该次
运行不计入通过或失败证据，原因是验收服务仅设置了临时 `DATABASE_URL`，未设置
`RVB_TURN_TIMER_ENABLED=1`，权威计时器按设计未启用；同时页面资源请求最长约 89 秒，玩家动作签名超过
60 秒有效期后在鉴权阶段被拒绝，尚未进入 RED-141 的房间队列或规则运行时。后续如需验证部署自动超时，
应从启用计时器的正式启动入口运行，或单独建立轻量多客户端验收工具；这不改变本次 RED-141 隔离合同的
人工通过结论，也不表示该无效运行中的计时器现象已经修复。

验收决定：**通过**。该决定仅批准 RED-141 的候选实现进入后续合并决策；PR 仍保持未合并，发布不在本次
授权范围内。

## 回退

整体 revert RED-141 提交，恢复在线链路对旧全局触发器/缓存的使用；不要只撤销深层上下文解析或只撤销
房间入口注入，否则会形成混合所有权。回退后保留本文件的双房哨兵用例，可再次稳定暴露共享污染。
