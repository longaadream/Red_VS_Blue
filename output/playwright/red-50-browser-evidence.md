# RED-50 浏览器验收证据

日期：2026-08-16

入口：`http://127.0.0.1:4173/battle.html?mode=training`

浏览器：首次验收使用 Chrome 142 无界面模式（CDP）；合入 RED-49 后使用 `@playwright/cli` 重新回放。静态 QA 服务器复用客户端资源映射：页面来自 `data/pages`，规则数据来自 `data`，`images/*` 来自 `public`。

## 选中棋子与特殊状态栏

- 合入 RED-49 后的截图使用权威 fixture 的 0 状态场景，右侧栏只显示“特殊状态”、数量 `0` 和“无特殊状态”。
- 1 个与多个状态的名称、层数、剩余回合/次数、强度和公开说明由 `battle-ui-boundary.test.ts` 与 `battle-piece-status-summary.test.ts` 覆盖。
- 右侧栏 DOM 不包含棋子名称、头像、生命、基础属性或技能项；本次 ARIA 标签为“特殊状态，共 0 个”。
- RED-49 的棋盘棋子仍独立显示紧凑生命数字，并通过共享 `BattleStatusPresentation.boardSummary()` 限制为最多 2 个负面状态摘要。
- 桌面截图：[`red-50-desktop-1280x720-status.png`](./red-50-desktop-1280x720-status.png)
- 最低横屏截图：[`red-50-mobile-844x390-status.png`](./red-50-mobile-844x390-status.png)
- 推荐横屏截图：[`red-50-mobile-932x430-status.png`](./red-50-mobile-932x430-status.png)

## 右键详情与技能操作

- 调用既有右键棋子详情后，弹窗仍显示生命、攻击、防御、移动、状态名称与全部 3 个技能；RED-50 未重做该入口。
- 桌面与两个移动横屏尺寸中，现有技能操作栏均为 `display: flex`，各显示 3 个技能按钮。
- `844 × 390` 与 `932 × 430` 使用 58px 高紧凑技能栏，仍展示行动/充能消耗、技能名、类型和不可用原因。
- 技能可用性与目标选择继续由现有技能操作区进入；右侧特殊状态栏不绑定技能命令。

## 权威目标与单次提交

- 为固定验收几何关系，仅在训练 fixture 中把敌方棋子移动到施法者相邻格；未修改技能定义、规则、距离算法或候选集。
- 从现有技能操作栏点击“霜之哀伤”后，准备结果为 `candidates = [{ type: "piece", pieceId: "training-blue-1" }]`；UI 高亮集合精确为对应坐标，未出现额外目标。
- 目标提示同时显示技能名“霜之哀伤”、提示“选择一个敌方角色”和可访问的“取消目标选择”按钮。
- 在训练传输层增加 800ms 响应延迟并连续点击同一目标两次，等待态记录只有 1 条命令：`type=useBasicSkill`、`pieceId=training-red-1`、带同一权威 `selectionId`；取消按钮禁用并显示“目标指令已提交，正在等待权威确认”。
- 权威确认后仅结算一次：行动点 `10 → 8`，目标生命 `12 → 11`；`pendingSkill`、提交等待态和 `target-mode-active` 均清除，清理原因记录为 `authoritative-confirmation`。
- 桌面截图：[`red-50-desktop-1280x720-target.png`](./red-50-desktop-1280x720-target.png)
- 最低横屏截图：[`red-50-mobile-844x390-target.png`](./red-50-mobile-844x390-target.png)
- 推荐横屏截图：[`red-50-mobile-932x430-target.png`](./red-50-mobile-932x430-target.png)

## 取消、拒绝与状态切换

- 点击取消后：`pendingSkill=false`、提交等待态为 false、`target-mode-active` 清除，状态提示为“已取消目标选择”，清理原因记录为 `user-cancelled`。
- 把目标动作的 `selectionId` 改为过期值以模拟服务端拒绝，得到 `TARGET_SELECTION_ID_MISMATCH`；拒绝前后行动点、目标生命和 `targetingRevision` 均不变，目标/等待状态全部清除并显示明确错误。
- 在目标模式中应用权威回合切换快照后，模式由 `target` 回到 `inspect`，高亮、目标卡、等待态和 body class 全部清除，状态提示为“回合已切换，目标选择已清除”。
- 目标模式中，特殊状态栏、技能操作栏和训练栏均为 `display: none`，目标卡位于两侧 HUD 之间，状态提示固定在棋盘底部。

## 移动端横屏修订

- 人工验收否决 390×844 竖屏战斗布局后，移动端契约修订为：竖屏阻止操作并提示旋转；横屏最低 `844 × 390`，推荐 `932 × 430`。
- 390×844 中只显示“请旋转设备”，遮罩覆盖整个战斗界面并拦截交互；截图：[`red-50-mobile-390x844-rotate.png`](./red-50-mobile-390x844-rotate.png)。
- `844 × 390`：状态栏宽 `185.67px`，棋盘宽 `658.33px`，技能栏高 `58px`；状态栏/棋盘、状态栏/技能栏、棋盘/技能栏、状态栏/提示条重叠面积均为 `0`，水平溢出为 `0`。
- `932 × 430`：状态栏宽 `205.03px`，棋盘宽 `726.97px`，技能栏高 `58px`；同四组重叠面积均为 `0`，水平溢出为 `0`。
- 目标态继续隐藏状态栏与非必要操作区；权威候选、目标卡和单次提交证据沿用未改动的目标流程验收。

## RED-49 合并复验

- 合入基线：`origin/main@24f8946`（PR #55）。
- 三处文本冲突按职责合并：RED-49 负责棋盘生命/负面状态摘要与共享状态样式；RED-50 负责右侧纯特殊状态栏、技能操作区、目标反馈和移动横屏布局。
- 合并回放发现并修复技能选择入口仍读取已移除的 `selection.piece.skills`；现在技能栏渲染与点击统一使用 `resolveSkillAvailability()`，右侧展示模型仍不携带技能。
- 桌面 1280×720：左键选中后右栏为 0 状态空态，棋盘棋子显示生命数字；既有 `inspect-piece` 意图仍打开含生命、基础属性和 3 个技能的详情。
- 844×390 目标态：状态栏与技能栏均为 `display: none`，棋盘扩展到 `844 × 390`，取消按钮尺寸 `90 × 26`，提交前命令数为 `0`。
- 390×844：旋转层为 `display: grid`、`pointer-events: auto`、`z-index: 12000`，边界精确覆盖 `390 × 844`。
- 直接回归：4 个文件、42 项测试通过；TypeScript、相关 ESLint 和相关文件 `diff --check` 通过。
- 全量 Vitest 为 273/274；唯一失败是最新 main 已存在的 `data/pages/js/game-engine.js` 问号字符串编码门禁，RED-50 未修改范围外规则层/生成 bundle。

## Console

- 合并后重载并完成状态栏、技能目标、取消和三种尺寸切换后，Playwright Console error 数为 `0`；没有 `TypeError` 或 `ReferenceError`。
