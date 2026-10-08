# RED-245 发行候选回归核对

本次只修复候选引入、阻止合法操作生成或确定性门禁通过的最小问题，不扩展 AI 策略、PVE 或游戏规则。

## 任务补充合同

- 目标：旧 fallback AI 不得用回合初始行动点继续生成已经付不起的移动；预演的诊断耗时不读取规则层墙钟。
- 允许路径：`lib/game/ai.ts`、`lib/game/skill-preview.ts`、直接相关的 `tests/game` 回归测试及本文件。
- 风险：Medium；不修改移动成本、随机算法、权威状态、快照或存档格式；进行独立审查。
- 验收：先复现固定种子失败，生成动作经权威回放合法、保留零行动点时规则明确允许的免费移动、输入状态不变；预演及隐私测试通过，计时不可用时只报告零诊断耗时。
- 测试：现有 AI 24 种子基线及受影响样本、确定性静态门禁、相关预演与隐私回归。
- 回退：回退本次两处小范围源码修复；正式发行前必须重新构建全部产物。

Linear RED-245 的补充合同已在连接恢复后同步；本文件保留同一修改范围与候选失败记录。

## 修改前证据

- 当前候选 `c7003af49214909cadc5ee4aa955be1b2734e86d` 全 game：1738 通过 / 41 失败。
- 测试者针对失败文件对已刷新 main `9d1b0c30801cd733ec4cede37ce1ef0889a2313a` 作对照：37 失败 / 253 通过。
- 新增真实问题：旧 AI 本地 AP 已耗尽，空间候选仍读取原始 AP，第二个付费移动被权威拒绝；预演诊断的 `Date.now()` 新增未分类调用。
- 新增陈旧源码断言：dispose cleanup 相邻正则、disconnect recovery 的 150 字符窗口；实际调用仍在，单列记录，不把失败当作通过。
- AOE 音效次数、恢复 blocked 契约与其他旧断言在 main 同样失败；它们不是本次候选引入，但也未被豁免为全部通过。

## 修复与验证

- `lib/game/ai.ts` 现在用本地剩余 AP 构造浅层不可变预算视图，再调用 canonical `getLegalNormalMoveTargetsForPlayer`；不复制移动规则，也保留当前回合明确标记的免费移动。
- `lib/game/skill-preview.ts` 的诊断计时只读取 `performance.now()`；不支持该 API 时回退到 `0`，不读取规则层墙钟。预演快照与事件内容保持一致。
- 修改前 `tests/game/ai-planner.test.ts` 的 24 固定种子 legacy 对照为 `0/24` 完成、`24` 非法动作；修复后为 `24/24` 完成、`0` 非法动作。修复后新增 `tests/game/red245-legacy-bot-ap.test.ts` 覆盖单 AP 多棋子回放、最终 `endTurn`、输入哈希不变及 AP=0 免费移动。
- `node node_modules/vitest/vitest.mjs run tests/game/red245-legacy-bot-ap.test.ts tests/game/skill-preview.test.ts --maxWorkers=1`：21/21 通过。
- `node node_modules/vitest/vitest.mjs run tests/game/ai-planner.test.ts --maxWorkers=1`：16/16 通过（含 24 固定种子与 200 样本 bounded full-turn 对照）。
- `node node_modules/vitest/vitest.mjs run tests/game/skill-preview-privacy.test.ts tests/game/skill-preview-move.test.ts --maxWorkers=1`：55/55 通过；`node node_modules/vitest/vitest.mjs run tests/game/ai-environment.test.ts tests/game/ai-movement.test.ts --maxWorkers=1`：24/24 通过。
- `node node_modules/vitest/vitest.mjs run tests/game/skill-preview-benchmark.test.ts --maxWorkers=1`：1/1 通过。
- `node node_modules/vitest/vitest.mjs run tests/game/determinism-audit.test.ts --maxWorkers=1`：5/5 通过；`npm.cmd run typecheck`、受影响文件 ESLint、`git diff --check`、`npm.cmd run check:main-baseline` 通过。

原始候选全 game 的 `1738 通过 / 41 失败` 及刷新 main 对照 `37 失败 / 253 通过` 仍是候选记录；本次只报告上述受影响回归通过，不将其他旧失败改记为通过。原始日志保存在本地 `output/RED245`，不提交敏感配置。
