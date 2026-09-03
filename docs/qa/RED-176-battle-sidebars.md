# RED-176 战斗侧栏与动作记录验收记录

## 合同与基线

- Linear：RED-176
- 基线分支：`main`
- 开发基线：`59d79dddb1a301b8e2090b39b8b939ba39a463f3`
- 风险：Medium（战斗交互状态与隐藏信息展示边界）

## 实现结果

- 右侧只保留现有动作历史；删除选中棋子的常驻状态侧栏，完整技能与状态仍可通过右键或技能栏 `i` 按钮打开。
- 地格状态移动到左侧，默认只显示坐标、地形和效果数量；展开后显示完整效果列表，并保留关闭与 Escape 键入口。
- 技能栏按左侧地格栏和右侧展开动作历史预留安全区。1366×768 实测矩形为：地格栏 `14–262`、技能栏 `794–982`、动作历史 `998–1358`，相邻区域保留 16px 间距。
- 棋子详情新增“行动记录”键盘/鼠标入口；切换时先关闭模态层，再恢复并聚焦动作历史。
- 拖拽开始造成的临时技能栏收起标记不再穿过成功移动；权威移动完成后仍选中原棋子并重新显示合法技能。
- 已登记技能优先显示展示名称。元数据缺失时显示“未知技能”，并记录事件 ID 与技能 ID 的可定位错误，不向玩家显示内部 ID。
- “镜花水月”等隐藏目标继续沿用权威查看者投影；对手和观战序列化载荷中不含目标实体或坐标。

## 自动验证

失败先行阶段新增/调整的 4 个测试文件共出现 7 个预期失败，分别覆盖左侧地格栏、左右安全区、技能名安全降级、移动后重新打开技能栏和取消常驻状态侧栏。

实现后验证：

```text
npm.cmd test -- tests/ui/tile-status-panel.test.ts tests/game/battle-context-layout.test.ts tests/ui/battle-action-history.test.ts tests/game/battle-page-contract.test.ts tests/game/battle-ui-boundary.test.ts tests/electron/battle-page-runtime.test.ts tests/game/battle-presentation-events.test.ts
7 files passed; 108 tests passed

npm.cmd run typecheck
passed

node --check data/pages/js/battle-ui/battle-action-identity.js
node --check data/pages/js/battle-ui/battle-action-history.js
node --check data/pages/js/battle-ui/battle-context-layout.js
node --check data/pages/js/battle-ui/battle-dom-ui.js
passed
```

## 真实浏览器验证

在 Windows Codex 内置 Chromium 中打开正式 `battle.html?mode=training`，使用真实 Three.js 棋盘和训练权威 Runner 验证：

1. 1366×768：左侧地格栏默认紧凑、可展开/关闭；右侧动作历史入口与展开内容均可操作，技能栏不与两侧面板相交。
2. 1584×992：左侧展开地格栏、右侧展开动作历史和技能栏同时可见，棋盘仍可操作。
3. 选择阿尔萨斯并拖到相邻合法格后，行动点 10 → 9，动作历史新增“移动 / 行动点变化 -1”，阿尔萨斯仍保持选中，三个技能按钮继续显示且合法技能可点击。
4. 从技能栏 `i` 打开完整详情后，可用“行动记录”按钮返回动作历史；焦点回到动作历史按钮。
5. 控制台只有仓库基线已有的 `evil-explosion.json` 缺失与本地资源加载 warning，没有 RED-176 新增 error。

Windows 打包客户端的截图/录屏仍需在候选包上由人工验收补充；本地浏览器证据不替代最终打包体验判断。

## 回退

整体 revert RED-176 提交即可恢复旧侧栏布局与交互，不涉及规则数值、存档、随机算法或迁移。
