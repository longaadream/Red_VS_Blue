# RED-237：公开预演与战斗 UI 候选

## 范围与基线

- 风险：Medium；涉及公开预演接口、战斗表现层和页面级 UI 资源，不改变规则数值、随机种子、存档格式或 AI 决策策略。
- `base_branch: main`
- `base_sha: 9d1b0c30801cd733ec4cede37ce1ef0889a2313a`（刷新后的 `origin/main`）。
- 实现分支：`codex/RED-237-ui-only`。
- 本地提交：`0da1d67cf`（预演基础）、`6d6de5c38`（状态与亮度反馈）、`337423116`（页面 motion 接入）。

## 交付内容

### 公开预演

- 公开规则源、技能选择序列、随机克隆和渐进部署后的可预演状态已经接入普通对局路径。
- 棋盘重绘会保留当前预演上下文并在重绘后恢复；过期或历史查看状态不会重新污染当前选择。
- 普通对局使用已生成的 `game-engine.js` 与 `practice/engine.js`，两者来自同一份规则源；没有修改教程 AI 搜索、Worker 或规划器。

### 状态反馈

- 可见状态使用中文名称；例如 `divine-shield` 显示为“圣盾”，`freeze` 显示为“冰冻”。原生、明确且不是 JSON id 的自定义名称会继续保留。
- 详情面板、棋子卡片、棋盘状态标记和结果浮字都使用同一个状态解析器。
- 每个可见状态语义都有对应 SVG 图标；内部 bookkeeping 状态仍然隐藏。
- 黄色行动提示和非法操作反馈居中到可用棋盘区域，字号提升到响应式 `24–36px`，目标选择模式仍保留原有目标提示。

### 亮度与页面 motion

- 移除全屏遮光蒙版和范围地格的发光强度脉冲；范围边框与斜线仍然保留。
- 共享 cursor、触控、减少动态效果和 teardown 运行时已接入 UI 合同覆盖的页面。

## 自动验证

以下命令均在本候选工作树运行，使用仓库现有的 Vitest 入口：

```text
node node_modules/vitest/vitest.mjs run tests/game/skill-preview.test.ts tests/game/skill-preview-privacy.test.ts tests/game/skill-preview-benchmark.test.ts tests/game/skill-preview-progressive.test.ts tests/game/red227-local-skill-sequence.test.ts tests/game/red227-projectile-preview-recording.test.ts tests/ui/battle-skill-preview-page.test.ts tests/ui/target-overlay-controls.test.ts --maxWorkers=1
8 files / 89 tests passed

node node_modules/vitest/vitest.mjs run tests/ui/battle-effect-icons.test.ts tests/ui/battle-action-history.test.ts tests/ui/tabletop-battle-bundle.test.ts tests/game/battle-piece-status-summary.test.ts --maxWorkers=1
4 files / 37 tests passed

node node_modules/vitest/vitest.mjs run tests/ui/battle-action-vignette.test.ts tests/ui/battle-renderer-3d-runtime.test.ts --maxWorkers=1
2 files / 88 tests passed

node node_modules/vitest/vitest.mjs run tests/ui/ui-motion-pages.test.ts --maxWorkers=1
1 file / 24 tests passed

npm.cmd run typecheck
passed

git diff --cached --check
passed before each local commit
```

`npm.cmd run check:main-baseline` 已在刷新 `origin/main` 后运行通过；最终合入前由负责人在其集成树再次运行。图标测试同时检查每个可见状态的 SVG 路径存在，并验证 raw JSON id 不会覆盖中文标签。

## 人工验收

请使用新的本地端口打开候选页面，不刷新已有玩家对局：

1. 在练习或普通对局中让棋子获得“圣盾”“冰冻”和一个带层数/持续时间的状态，确认棋盘标记、棋子卡片和详情面板都显示中文名称及图标。
2. 触发一次非法操作或等待状态提示，确认黄色文字在棋盘中部水平居中、字号可读，并且目标选择模式的目标提示没有被覆盖。
3. 触发带多个目标的增益或范围技能，确认战场底色不再连续变亮/变暗，地格边框与斜线仍可见，逐目标浮字仍出现。
4. 点击技能并移动鼠标到目标，确认预演可见；发生普通棋盘重绘后，预演与当前目标选择仍保留。切换到历史查看后，确认历史视图不会恢复旧预演。
5. 在任意页面确认共享 cursor；开启系统“减少动态效果”后刷新页面，确认 motion runtime 不抛异常并停止过渡动画。

## 已知边界与回退

- 本候选不包含教程 AI 搜索优化、Worker 调度、Minato 飞雷神锚点规则或 Blizzard 全图目标数据；这些改动由其他任务独立处理。
- 自动测试使用 DOM/Three.js 模拟环境，不能替代真实 WebGL 下的亮度和字号视觉验收。
- 回退顺序为移除 `337423116`、`6d6de5c38`、`0da1d67cf`；无需数据迁移。
