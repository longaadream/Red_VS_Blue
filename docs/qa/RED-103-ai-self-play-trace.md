# RED-103：离线 AI 自博弈 Trace v2 导出验收

## 目标与边界

`ai:self-play:export` 从 RED-87 schema 1 报告中只选择一局，使用报告内嵌 manifest、agent/roster 档案、root seed 和实际动作在权威无头环境重放，并生成 RED-94 开发者中心可直接导入的 `rvb-match-trace/v2`。

本工具不重新让 AI 决策，不解释“为什么这样走”，不训练或修改 agent，不生成整套联赛的批量 Trace，也不修改回放页面、玩法、随机算法、存档、网络或数据库。

风险等级：Medium。主要风险是把不兼容代码重算出的另一局伪装成原对局；因此 schema、权威代码、rules/content hash、逐动作证据和终局证据全部失败关闭。

## 自动验证

```powershell
npm.cmd test -- tests/game/ai-self-play-replay.test.ts tests/game/ai-self-play.test.ts tests/game/developer-tools-trace.test.ts tests/electron/developer-tools-page.test.ts tests/electron/replay-page.test.ts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run check:encoding
git diff --check
```

重点断言：

- `--list` 输出 1-based index、matchId、swapIndex、双方 agent/roster、结果、完成回合和动作数。
- 重放只消费 `match.actions`；每步核对 accepted、actionHash、stateHash、transitionHash、traceHash 和权威 trace actor。
- 整局核对 actionTraceHash、stateTraceHash、finalStateHash、winner/loser/reason/completedRounds。
- schema、codeCommit、rulesHash、contentHash、任一逐步/整局 hash、agent config hash 不一致时拒绝。
- 未知 match、failed match、非终局动作序列、拒绝动作和已有输出文件拒绝。
- 生成的真实 AI Trace 通过现有 `parseTraceText()`、`assertTraceRecord()` 和 `materializeTraceState()`。
- 相同 report/match 重放得到相同初始状态、帧、事件、内容与完整性证据；只有 `exportedAt` 可以变化。
- `source` 元数据包含报告/suite/match/seed/seat/agent/roster/原始终局 hash，不包含输入路径或敏感字段。

## 真实 human-smoke 命令

先列出 RED-87 human-smoke 报告：

```powershell
npm.cmd run ai:self-play:export -- output/ai-self-play/<human-smoke-report>.json --list
```

预期两局：

- `pair-ac7a8331f2acbf2bedd5c51d-seat-0`：swap 0，14 个完成回合，181 个动作；
- `pair-ac7a8331f2acbf2bedd5c51d-seat-1`：swap 1，11 个完成回合，137 个动作。

按序号与 matchId 各导出一次：

```powershell
npm.cmd run ai:self-play:export -- output/ai-self-play/<human-smoke-report>.json --match 1 --output output/ai-self-play/red-103-human-smoke-181.trace.json
npm.cmd run ai:self-play:export -- output/ai-self-play/<human-smoke-report>.json --match pair-ac7a8331f2acbf2bedd5c51d-seat-1 --output output/ai-self-play/red-103-human-smoke-137.trace.json
```

预期：

- 两个命令退出码均为 0；格式为 `rvb-match-trace/v2`；帧数分别为 181、137。
- 181 步终局 hash 为 `32029a4531c6392dbe709154c66d1886582b9c73d174dc85e560813a0d88df2d`。
- 137 步终局 hash 为 `63e1216935d914accaee10a2dedf713c863bf4ad4422c0a55561eb1a87d16579`。
- 对同一输出路径再次执行时非零退出，原文件摘要不变。

## 开发者中心人工回放

1. 从主菜单打开局外“开发者中心”，确认当前没有活动对局门禁。
2. 把 181 或 137 步 Trace 拖到导入区域；摘要应显示对应命令数、seed 2001、终局结果和 final hash。
3. 打开现有可视化回放，初始棋盘应停在第 0 帧。
4. 使用上一步/下一步和时间轴跳到任意帧；棋盘、回合、阶段、执行者与帧摘要一致。
5. 切换播放/暂停及 0.5×、1×、2×、4×；到末帧自动停止。
6. 切换全知/红方/蓝方视角；只改变展示，不改变帧或 hash。
7. 检查棋子、事件、变化、随机流和完整性标签；末帧 winner/reason/final hash 与报告一致。
8. 浏览器网络面板不应出现房间 action、WebSocket、奖励或战绩请求。

## 回退

整体 revert RED-103 的导出 CLI、共享 setup/replay helper、Trace `source` 适配、测试和文档。没有数据库、存档、玩法数据或随机算法迁移；RED-87 原报告与 RED-94 原有玩家对局 Trace 继续有效。
