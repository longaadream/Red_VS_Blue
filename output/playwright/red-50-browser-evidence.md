# RED-50 浏览器验收证据

日期：2026-08-15

入口：`http://127.0.0.1:4179/battle.html?mode=training`

浏览器：Playwright Chromium。静态 QA 服务器沿用 `app/qa/client/[...path]/route.ts` 的资源映射：页面来自 `data/pages`，规则数据来自 `data`，`images/*` 来自 `public`。

## 选中棋子与详情

- 通过 Three.js 投影坐标点击我方棋子后，详情页显示阿尔萨斯头像、生命 `12 / 12`、攻击 `3`、防御 `1`、移动 `3`、可见状态 `0` 和全部 3 个技能。
- 技能详情显示名称、描述、行动点、充能点、当前/最大冷却；充能不足时显示“充能点不足（需要 2，当前 0）”，冷却后显示“冷却中（剩余 1 回合）”。
- 点击敌方安度因后仍可读取头像、生命、基础属性、0 状态和 3 个公开技能，但技能按钮全部禁用并显示“敌方棋子仅可查看”。
- 桌面截图：[`red-50-desktop-1280x720-detail.png`](./red-50-desktop-1280x720-detail.png)
- 移动截图：[`red-50-mobile-390x844-detail.png`](./red-50-mobile-390x844-detail.png)

## 权威目标与单次提交

- 为固定验收几何关系，仅在训练 fixture 中把敌方棋子移动到施法者相邻格；未修改技能定义、规则、距离算法或候选集。
- 从详情页点击“霜之哀伤”后，准备结果为 `candidates = [{ type: "piece", pieceId: "training-blue-1" }]`；UI 高亮集合精确为对应坐标，未出现额外目标。
- 目标提示同时显示技能名“霜之哀伤”、提示“选择一个敌方角色”和可访问的“取消目标选择”按钮。
- 在训练传输层增加 800ms 响应延迟并连续点击同一目标两次，等待态记录只有 1 条命令：`type=useBasicSkill`、`pieceId=training-red-1`、带同一权威 `selectionId`；取消按钮禁用并显示“目标指令已提交，正在等待权威确认”。
- 权威确认后仅结算一次：行动点 `10 → 8`，目标生命 `12 → 11`；`pendingSkill`、提交等待态和 `target-mode-active` 均清除，清理原因记录为 `authoritative-confirmation`。
- 桌面截图：[`red-50-desktop-1280x720-target.png`](./red-50-desktop-1280x720-target.png)
- 移动截图：[`red-50-mobile-390x844-target.png`](./red-50-mobile-390x844-target.png)

## 取消、拒绝与状态切换

- 点击取消后：`pendingSkill=false`、提交等待态为 false、`target-mode-active` 清除，状态提示为“已取消目标选择”，清理原因记录为 `user-cancelled`。
- 把目标动作的 `selectionId` 改为过期值以模拟服务端拒绝，得到 `TARGET_SELECTION_ID_MISMATCH`；拒绝前后行动点、目标生命和 `targetingRevision` 均不变，目标/等待状态全部清除并显示明确错误。
- 在目标模式中应用权威回合切换快照后，模式由 `target` 回到 `inspect`，高亮、目标卡、等待态和 body class 全部清除，状态提示为“回合已切换，目标选择已清除”。
- 390×844 目标模式中，详情抽屉和技能条的计算样式均为 `display: none`，目标卡位于顶部 HUD 下方，状态提示位于底部工具栏上方。

## Console

- 最终布局流程没有 `TypeError`、`ReferenceError` 或 RED-50 交互异常。
- Console error 仅为既有静态训练环境缺失资源：可选规则资源探测经 `game-engine-runtime.js` 报告的 404，以及缺失的 `data/skills/evil-explosion.json`。头像资源已正常加载，不再出现 `arthas.jpg` 或 `anduin.jpg` 404。
