# RED-167 战场动作小剧场验收

## 合同与基线

- 风险：Medium
- 基线：`main` / `400a4169a911ef96aedd966de76cb571e14e8669`
- 最终同步基线：`origin/main` / `09e3e6c29a2c922bdc591cdb40bc26f6f56954dd`（ahead 1、behind 0 时完成主验证）
- 分支：`codex/red-167-action-vignette`
- 范围：权威展示提示、串行小剧场、略过/2×/减弱动态、召唤/复活与 pending 角色反馈；变身专属动画按产品决定延期。
- 不在范围：角色专属终极演出、护盾拦截动画、规则结算、伤害或命中算法。

## 浏览器复现

1. 启动页面 QA 服务。
2. 打开 `battle.html?mode=training&qa=RED-167` 并开始训练战斗。
3. 页面依次演示弹射物、指向技能、范围闪烁、位移和召唤；控制台执行 `window.__RVB_RED167_REPLAY__()` 可重播。
4. 弹射物阶段确认虚线瞄准格与实际终点可分离，图标抵达实际 `endPoint`；路径被挡或飞越点击格时仍使用结算轨迹。
5. 演出期间点按战场，确认当前动作在 100ms 内收束，并且该次点击不触发棋盘选择、移动或技能。
6. 切换右上角 1×/2×，确认顺序不变、耗时缩短；将系统设置为“减少动态效果”后刷新，确认只显示 100–140ms 静态结果帧。
7. 在窄高横屏复查状态条、44px 速度按钮与区域闪烁没有遮挡主要棋盘操作。

## 自动验证

- 权威事件与轨迹：`tests/game/battle-presentation-events.test.ts`
- 队列、略过、2×、减弱动态和 DOM 清理：`tests/ui/battle-action-vignette.test.ts`；其中固定 16 棋子、160 个根动作并推进 180 秒的压力场景确认队列归零、无残留计时器。
- renderer 召唤/复活与 pending 高亮：`tests/ui/battle-renderer-3d-runtime.test.ts`
- 页面/生命周期边界：`tests/game/battle-ui-boundary.test.ts`、`tests/game/battle-page-contract.test.ts`
- 最新主基线相关回归：8 个测试文件共 95 项通过；`npm.cmd run typecheck` 与 `npm.cmd run check:encoding` 通过。

## 浏览器证据（Playwright CLI）

- 1280×720 弹射物：`output/playwright/RED-167-projectile-text-skill.png`。实测 `selectedCell` 投影为 `left=968.624px`，权威 `endPoint` 为 `left=1056.26px`，移动标识终点变量为 `1057.04px`，没有回退到点击格；技能根动作的状态条和移动标识均显示“使用技能”，且移动标识不含占位图标。
- 1280×720 范围闪烁：`output/playwright/RED-167-area-flash.png`。演出层处于 `is-cue-area`，只渲染 3 个权威 `areaCells` 的闪烁轮廓；路径与动作移动标识数量均为 0。
- 844×390、`prefers-reduced-motion: reduce`：`output/playwright/RED-167-reduced-motion-mobile-landscape.png`。截图时演出阶段为可见的 `static`，速度按钮为 44×44px。
- 略过输入：真实页面派发可取消的 `pointerdown` 后 10.5ms 内同步进入 `settle`；`defaultPrevented=true`、派发返回 `false`、战场父节点收到的穿透事件数为 0。收尾计时目标为 60ms，低于 100ms 验收上限。
- 控制台仅出现静态 QA 服务基线缺失资源：`js/game-engine-runtime.js` 与 `data/skills/evil-explosion.json` 的 404；未发现 RED-167 运行时异常。

## Android 人工验证

在真实 Android 横屏 WebView 中重复浏览器步骤 2–7，额外确认触控略过不穿透、旋转恢复后小剧场位置正确、后台再返回没有残留动画或监听器。若当前环境没有连接设备，必须在 PR 中明确标记此项等待人工验收，不得写成已通过。
