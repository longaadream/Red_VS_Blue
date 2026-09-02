# RED-167 战场动作小剧场验收

## 合同与基线

- 风险：Medium
- 基线：`main` / `400a4169a911ef96aedd966de76cb571e14e8669`
- 最终同步基线：`origin/main` / `2c6242706cc0bac7f97e30542e5f49bbce802487`（合并 RED-166 v2 后完成主验证）
- 分支：`codex/red-167-action-vignette`
- 范围：权威展示提示、施法者头像与技能名、串行小剧场、略过/2×/减弱动态、召唤/复活与 pending 角色反馈；变身专属动画按产品决定延期。
- 不在范围：角色专属终极演出、护盾拦截动画、规则结算、伤害或命中算法。

## 浏览器复现

1. 启动页面 QA 服务。
2. 打开 `battle.html?mode=training&qa=RED-167` 并开始训练战斗。
3. 示例队列结束后，选中当前行动方棋子并实际释放一个技能；确认训练结算也把结构化展示事件送入同一小剧场，而不是只有 QA 示例能够播放。
4. 页面依次演示弹射物、指向技能、范围闪烁、位移和召唤；控制台执行 `window.__RVB_RED167_REPLAY__()` 可重播。
5. 弹射物阶段确认虚线瞄准格与实际终点可分离，轨迹延伸到实际 `endPoint`；路径被挡或飞越点击格时仍使用结算轨迹。轨迹和虚线必须位于真实棋盘世界平面，不得用平行于屏幕的 DOM 线模拟。
6. 演出期间点按战场，确认当前动作在 100ms 内收束，并且该次点击不触发棋盘选择、移动或技能。
7. 切换右上角 1×/2×，确认顺序不变、耗时缩短；将系统设置为“减少动态效果”后刷新，确认只显示 100–140ms 静态结果帧。
8. 释放任意真实技能，确认顶部状态条和最近动作均显示施法棋子头像与具体技能名。头像资源缺失时应显示棋子名首字，不出现破图。
9. 展开动作历史，确认移动、部署、伤害、行动点等语义 SVG 均正常加载；本地静态 QA 服务必须同时提供页面自带图标与 `public/images` 角色头像。
10. 在窄高横屏复查状态条、44px 速度按钮与区域闪烁没有遮挡主要棋盘操作；过长技能名应单行截断而不挤压速度按钮。

## 自动验证

- 权威事件与轨迹：`tests/game/battle-presentation-events.test.ts`
- 队列、略过、2×、减弱动态、头像/技能名与 DOM 清理：`tests/ui/battle-action-vignette.test.ts`、`tests/ui/battle-action-identity.test.ts`；其中固定 16 棋子、160 个根动作并推进 180 秒的压力场景确认队列归零、无残留计时器。
- renderer 召唤/复活与 pending 高亮：`tests/ui/battle-renderer-3d-runtime.test.ts`
- 页面/生命周期边界：`tests/game/battle-ui-boundary.test.ts`、`tests/game/battle-page-contract.test.ts`
- 最新主基线相关回归：9 个相关测试文件共 133 项通过；回合计时与部署补充回归 3 个文件共 51 项通过；`npm.cmd run typecheck`、定向 ESLint、浏览器脚本语法检查与 `npm.cmd run check:encoding` 通过。训练运行时测试实际执行投影器并确认事件在 render 时进入展示模型，同时验证提交 action 与前后状态不被投影修改；浏览器直接使用由 `build:game-engine` 生成的规范引擎包，避免独立投影包漂移。页面合同同时覆盖 Next QA 路由和静态 QA 服务对页面 SVG、公共角色头像的寻址。队列测试额外覆盖普通训练/联网己方回合中新提交技能仍会播放，以及控制权返回时先收束对手旧演出再播放同批新事件。
- 全量回归曾暴露并已修复“部分运行时状态缺少技能注册表时，表现事件投影导致计时/部署提交失败”的兼容问题。剩余两个非 RED-167 哈希/传输用例在本分支与纯 `origin/main@2c624270` 均失败（`battle-authority-v2` 的 version-zero public hash；`roster-transports` 的 HTTP/WebSocket 部署一致性或超时），记录为主基线现有问题，不在本任务内改写权威哈希或传输规则。

## 浏览器证据（Playwright CLI）

- 1280×720 弹射物：`output/playwright/RED-167-projectile-text-skill.png` 只作为轨迹几何证据；其顶部状态条为改版前样式，不用于验收头像和技能名。renderer 在固定棋盘平面高度创建 1 条指向权威 `endPoint` 的 3D ribbon 与 1 个 `selectedCell` 世界空间中心虚线；轨迹两端不读取高低地形高度，因此严格平行于棋盘格轴，高地只产生自然遮挡而不会把线段抬歪。DOM 棋盘图层的轨迹、文字和图标数量均为 0。
- 真实训练动作：`output/playwright/RED-167-skill-avatar-name.png`。训练模式调用共享 `projectBattlePresentationEvents()`，以提交动作及结算前后状态生成与联网链路同结构的 `presentationEvents`。手动释放“寒冰坚忍”后，顶部状态条显示阿尔萨斯头像与“寒冰坚忍 / 点按战场略过 / 1×”，且最近动作的 `aria-label`、标题、头像与展开技能名均来自同一展示身份解析；未解析中文日志，也未改变技能结算。
- 844×390 头像与名称：`output/playwright/RED-167-skill-avatar-name-844x390.png`。将同一真实动作保留的状态条切到静态结果帧后缩放视口，头像、技能名和 44px 速度按钮均可见，名称未挤压按钮或溢出视口。
- 1280×720 范围闪烁：`output/playwright/RED-167-area-flash.png`。演出层处于 `is-cue-area`，不创建任何 DOM 或额外 3D 覆盖面；renderer 临时克隆并点亮 3 块真实地砖的材质，几何、位置和缩放完全不变，收束时恢复原材质。因此方向、透视、厚度与遮挡直接继承棋盘本身，不存在额外边框角度；棋盘 DOM 的路径、文字和图标数量均为 0。
- 844×390、`prefers-reduced-motion: reduce`：`output/playwright/RED-167-reduced-motion-mobile-landscape.png`。截图时演出阶段为可见的 `static`，速度按钮为 44×44px。
- 略过输入：真实页面派发可取消的 `pointerdown` 后 10.5ms 内同步进入 `settle`；`defaultPrevented=true`、派发返回 `false`、战场父节点收到的穿透事件数为 0。收尾计时目标为 60ms，低于 100ms 验收上限。
- 资源复查：静态 QA 服务修复后，`images/effect-icons/verb-move.svg` 返回 `200 image/svg+xml`；展开动作历史后遍历页面图片，`complete && naturalWidth === 0` 的破图数量为 0。
- 普通训练复查：不带 `qa` 参数打开 `battle.html?mode=training`，己方回合真实释放阿尔萨斯“寒冰坚忍”后，状态条出现阿尔萨斯头像与“寒冰坚忍 / 点按战场略过”，行动点 10 → 9、技能进入 3 回合冷却。该链路未使用 `forcePlayback`。
- 控制台仅出现既有缺失资源 `data/skills/evil-explosion.json` 的 404；未发现 RED-167 运行时异常或展示事件投影错误。

## Android 人工验证

在真实 Android 横屏 WebView 中重复浏览器步骤 2–7，额外确认触控略过不穿透、旋转恢复后小剧场位置正确、后台再返回没有残留动画或监听器。若当前环境没有连接设备，必须在 PR 中明确标记此项等待人工验收，不得写成已通过。
