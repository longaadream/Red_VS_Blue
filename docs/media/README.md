# 项目媒体素材

截图来自主线 `012e595fe2affb29725c45df0c2cd819704768a0` 的实际页面，拍摄于 2026-09-09（Asia/Shanghai）。

| 文件 | 用途与来源 |
| --- | --- |
| [hero.png](hero.png) | README 头图，以真实技能命中的棋盘局部为主体，小条幅辅助 |
| [feature.png](feature.png) | 同一次千鸟释放的「突进 → 命中」分镜 |
| [combat-path.png](combat-path.png) | 实際规则执行后的原生位移轨迹，隐藏周边 UI 导出 |
| [combat-impact.png](combat-impact.png) | 实际伤害阶段，原生伤害字放大并定格 |
| [combat-capture.json](combat-capture.json) | 本次技能的前后状态与规则引擎事件 |
| [battle.png](battle.png)、[menu.png](menu.png) | 未加工的完整训练场景与菜单原图 |
| [posters.html](posters.html) | 可编辑 HTML 排版，直接引用上述技能帧 |

游戏角色、棋盘及伤害字均来自实际页面，未交给 AI 重绘。最终采用粗线条、扁平色的简笔画处理：放大棋盘、裁切战斗局部、叠加少量漫画速度线。伤害字沿用游戏原生字体及爆炸形状，从 29px 放大到 52px 并暂停动画。条幅只介绍项目与技能，不遮挡战斗主体。最终图片未使用先前试制的 AI 背景。

## 捕获场景

使用已有 QA 训练摆位；通过游戏的目标选择准备接口取得合法选择凭证，再由实际规则引擎执行 `sasuke-chidori`。佐助从 (12,6) 突进至 (12,11)，鸣人从 12 生命降至 8，并获得「被千鸟贯穿」状态。位移帧与命中帧分开捕获，没有拼造伤害或连锁事件。

这是固定训练展示，不是一局线上比赛。速度线属于宣传加工；技能效果以游戏实际运行结果为准。

## 重新拍摄与导出

先安装仓库依赖。在两个 PowerShell 终端分别运行：

```powershell
npm.cmd run build:game-engine
$env:RVB_SKIN_PORT = '4197'
node docs/qa/RED-186/serve.cjs
```

```powershell
# 使用单独安装的 Playwright，不改变游戏依赖。
$env:PLAYWRIGHT_MODULE = '<Playwright 包的绝对路径>'
node docs/qa/capture-homepage.cjs
node docs/qa/capture-homepage-combat.cjs
node docs/qa/render-homepage-posters.cjs
```

脚本使用系统 Microsoft Edge；需先安装 Edge。完整截图视口为 1600 × 1000，战斗图层使用 2 倍像素比例。战斗脚本在页面加载前安装浏览器时钟，以实际动画阶段捕获；确认原生 `−4` 飘字存在后才输出命中图。中间帧写入被忽略的 `output/homepage-preview/`。排版脚本从本地 HTML 导出 1600 × 900 的两张 PNG，并验证所有引用图片加载成功。QA 服务仅用于本机。

完整原图 SHA-256：

```text
battle.png  41B3FBED0ED60D4D33B0271FD8B739CBFDC2DCC0C8BE6DCE2E5A939DE0059130
menu.png    AA95B24C1E5E06755CDB3A034824C6DAE44269601DCD5FED9FCCA6622F21D9C0
```
