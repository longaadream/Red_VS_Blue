# RED-48 浏览器验收证据

日期：2026-08-15

入口：`http://127.0.0.1:4175/battle.html?mode=training`

浏览器：Playwright Chromium

## 1280×720

- Three.js 中 `training-red-1` 的格子 `(3, 14)` 投影为客户端坐标约 `(295, 572)`，反向命中仍为 `(3, 14)`。
- 点击棋子后展示模型进入 `move`，规则适配层返回 5 个合法移动格，DOM 同步显示“阿尔萨斯·梅涅希尔 / HP 12 / 12 / 无状态”。
- 点击“霜之哀伤”进入 `target`，规则引擎返回合法目标 0 个（敌方棋子不在技能范围）；取消后回到 `move`，目标高亮为 0。
- 连续三次 mount/update 后只有 1 个 canvas 和 1 个 HP overlay；公开 renderer API 精确为 `init`、`update`、`animateAction`、`spawnFloater`、`resize`、`projectCell`、`screenToCell`、`dispose`。
- 截图：[`red-48-desktop-1280x720.png`](./red-48-desktop-1280x720.png)

## 390×844

- 同一棋子 `(3, 14)` 投影到客户端坐标约 `(48, 422)`，反向命中仍为 `(3, 14)`。
- 在该投影坐标点击棋子后正确取消选择；展示模型回到 `inspect`，移动高亮为 0，DOM 显示“未选中棋子”。
- 重排后仍只有 1 个 canvas 和 1 个 HP overlay。
- 截图：[`red-48-mobile-390x844.png`](./red-48-mobile-390x844.png)

## Console

### 拆分前基线

- commit：`b3dfbce`（RED-47 合并结果）。
- 场景：使用最小静态服务器打开 `battle.html?mode=training`，调整至 1280×720 并点击“开始训练”。
- Console：49 条消息，其中 8 条 error、2 条 warning；没有 `TypeError` 或 `ReferenceError`。错误均为资源 404（`game-engine-runtime.js:49` 报告的资源读取、`favicon.ico`、`data/skills/evil-explosion.json`），warning 是对应的 pack-fetch 404 提示。

### RED-48 拆分后

- 场景：同一训练入口完成桌面/移动命中、选择/取消、目标模式和重复挂载流程。
- 首次载入并开始训练时 Console 为 51 条消息，其中 10 条 error、2 条 warning；没有 `TypeError`、`ReferenceError` 或 RED-48 生命周期错误。
- error 均为静态资源 404：可选资源包清单探测、`favicon.ico`、缺失的 `data/skills/evil-explosion.json` 和可选日志清单探测；warning 是相同资源包探测的 pack-fetch 提示。规则适配层验证候选目标时会再次读取缺失技能资源，因此该场景比拆分前基线多两条资源错误。
- 完成选择、目标模式、三次重复挂载、移动端缩放和反向命中后，再次筛选 Console 未发现脚本异常。
