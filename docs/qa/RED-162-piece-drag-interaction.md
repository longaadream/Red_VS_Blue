# RED-162 棋子拖拽与边缘技能栏验收记录

## 任务合同

- Linear：RED-162
- 基线分支：`main`
- 开发开始基线：`aa1d91351d6852909166f9b2e75943105ded1255`
- PR 前同步基线：`bf0c7f68568f4fde5a3a04e6046054a0f527c19d`
- 风险：Medium（战斗交互流程）
- 范围：棋子选择、移动合法集展示、拖拽移动、棋子技能栏收起与布局。
- 不在范围：移动规则、行动点费用、技能规则、棋盘镜头规则、存档或资源包内容。

## 验收结果

1. 选择当前回合可行动的己方棋子后，页面立即查询权威合法移动集合并显示绿色可达格；技能栏中不再存在“移动”按钮。
2. 从已选棋子拖到高亮格时，renderer 只输出 `drop-piece` 意图；页面再次以现有合法集合校验落点后，发送一次既有 `move` action。非法、取消、第二指针和窗口失焦不会提交。
3. 点击技能栏外任意位置、在棋盘上滚轮缩放或开始棋子拖拽会收起技能栏；棋子选中态和移动高亮保留。
4. 技能栏不改变棋盘舞台尺寸或镜头。棋子位于右半区时停靠左边缘，位于左半区时停靠右边缘；中心线附近使用 5%（最小 28px、最大 64px）迟滞避免换边抖动。
5. 844 × 390 横屏下技能栏宽 148px，技能行高均为 44px，无水平溢出，且不覆盖被选棋子。

## 自动化验证

失败优先证据：

- 首轮合同测试在实现前出现 4 个预期失败：缺少拖拽移动 helper、仍存在“移动”按钮、`drop-piece` 未进入意图边界、选中棋子拖动仍平移镜头。
- 边缘停靠测试在布局实现前出现 2 个预期失败：缺少 `placeEdgeDock()`，CSS 仍使用棋子附近横向浮窗。

实现后通过：

```text
npm.cmd test -- tests/game/battle-context-layout.test.ts tests/game/battle-page-contract.test.ts tests/game/battle-ui-boundary.test.ts tests/ui/battle-renderer-3d-runtime.test.ts tests/electron/battle-page-runtime.test.ts tests/game/movement-contract.test.ts
6 files passed, 81 tests passed（同步最新 origin/main 后）
```

同时通过 `npm.cmd run typecheck`、两个修改后 JavaScript 文件的 `node --check`、`npm.cmd run check:encoding`（880 个文本文件）、`git diff --check` 与 `npm.cmd run check:main-baseline`。

同步最新 `origin/main` 后，全仓 `npm.cmd test` 结果为 174 个文件通过、2 个跳过、4 个失败（1930 项通过、2 项跳过、5 项失败）。失败均不经过 RED-162 修改路径：

- `battle-state-hash.test.ts` 所需的 `android-client/www/js/game-engine.js` 未生成，报 `ENOENT`。
- `battle-room.test.ts` 的客户端 P95 时序阈值要求低于 100ms，本机结果为 110.0505ms。
- `electron-client-package.test.ts` 缺少未构建的 Colyseus 与嵌入式 PostgreSQL 打包产物。
- `embedded-postgres.test.ts` 两项失败，原因是 `_client-postgres` 本地运行时不存在或 manifest 校验失败。

`npm.cmd run lint` 在扫描源文件前被仓库现有 ESLint flat config 阻塞：`import/no-anonymous-default-export` 被配置但对应 `import` plugin 未在该配置对象中声明。本任务未修改 ESLint 配置。

## 真实浏览器证据

在本地训练模式使用真实 Chromium 页面验证：

- 1280 × 720：技能栏在棋子对侧停靠；左右两侧棋子均验证了相反边缘；棋盘舞台选择前后均为 1280 × 720。
- 点击“复位棋盘镜头”后，技能栏关闭，绿色移动高亮仍保留。
- 将棋子拖到相邻高亮格后，棋子投影位置发生变化，行动点从 10 降为 9，未出现第二次提交。
- 棋盘滚轮手势会关闭技能栏。
- 844 × 390：菜单为 148 × 181px，三项技能均为 44px 高，无水平溢出，菜单与棋子矩形不相交。
- 390 × 844：无页面水平溢出；窄屏布局仍可滚动和操作。触控设备的竖屏旋转提示由现有 coarse-pointer 媒体规则负责。

截图：

- `docs/qa/evidence/red-162/red-162-edge-dock-desktop.png`
- `docs/qa/evidence/red-162/red-162-edge-dock-844x390.png`

控制台没有新增 error。训练资源加载仍有基线 warning：缺少 `data/skills/evil-explosion.json`，并报告既有本地数据加载失败；该资源问题不在 RED-162 范围内。

## 建议人工验收

1. 进入训练模式，选择当前回合己方棋子，确认立即出现可达格且没有“移动”按钮。
2. 分别把棋子置于棋盘左右两侧，确认技能栏总在相反边缘，跨越中心线时不会来回抖动。
3. 点击 HUD、棋盘空白处和滚轮缩放，确认技能栏收起但选择与高亮保留。
4. 将棋子拖到高亮格、非高亮格，并在拖动中触发第二指针或取消，确认只有合法释放会结算一次。
5. 在 844 × 390 触控横屏检查技能按钮可点性，并确认技能栏未遮住被选棋子。

## 回退

回退本任务 PR 的提交即可恢复原有“移动”按钮、棋子附近浮窗与棋盘平移优先的手势。未修改规则层、协议、存档或数据格式，无需数据迁移。
