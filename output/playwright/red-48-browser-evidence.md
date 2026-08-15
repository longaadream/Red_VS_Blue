# RED-48 浏览器验收证据

日期：2026-08-15

入口：`http://127.0.0.1:4173/battle.html?mode=training`

浏览器：Playwright Chromium

## 1280×720

- Three.js 中 `training-red-1` 的格子 `(8, 9)` 投影为客户端坐标 `(485, 382)`，反向命中仍为 `(8, 9)`。
- 点击棋子后展示模型进入 `move`，合法移动格为 8 个，DOM 同步显示“阿尔萨斯·梅涅希尔 / HP 12 / 12 / 无状态”。
- 再次点击同一棋子后，展示模型回到 `inspect`，移动高亮为 0，DOM 显示“未选中棋子”。
- 点击“霜之哀伤”进入 `target`，规则引擎返回合法目标 0 个（敌方棋子不在技能范围）；取消后回到 `move`，目标高亮为 0。
- 连续两次 mount/update 后只有 1 个 canvas 和 1 个 HP overlay；公开 renderer API 为 `init`、`update`、`animateAction`、`spawnFloater`、`resize`、`projectCell`、`screenToCell`、`dispose`。
- 截图：[`red-48-desktop-1280x720.png`](./red-48-desktop-1280x720.png)

## 390×844

- 同一棋子的投影坐标反向命中仍为 `(8, 9)`。
- 在客户端坐标 `(106, 364)` 点击棋子后正确取消选择；展示模型回到 `inspect`，移动高亮为 0，DOM 显示“未选中棋子”。
- 重排后仍只有 1 个 canvas 和 1 个 HP overlay。
- 截图：[`red-48-mobile-390x844.png`](./red-48-mobile-390x844.png)

## Console

### 拆分前基线

- commit：`b3dfbce`（RED-47 合并结果）。
- 场景：使用最小静态服务器打开 `battle.html?mode=training`，调整至 1280×720 并点击“开始训练”。
- Console：49 条消息，其中 8 条 error、2 条 warning；没有 `TypeError` 或 `ReferenceError`。错误均为资源 404（`game-engine-runtime.js:49` 报告的资源读取、`favicon.ico`、`data/skills/evil-explosion.json`），warning 是对应的 pack-fetch 404 提示。

### RED-48 拆分后

- 场景：同一训练入口完成桌面/移动命中、选择/取消、目标模式和重复挂载流程。
- Console：没有 `TypeError`、`ReferenceError` 或 RED-48 生命周期错误。首次验收服务器未把 `/images` 映射到仓库 `public/`，因此记录到 `images/arthas.jpg` 与 `images/minato.jpg` 的 4 条 harness 404；这不是页面脚本错误。
