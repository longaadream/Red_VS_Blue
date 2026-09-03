# RED-166 v2 动作历史栏候选验证

## 实现合同

- 基线：`main` / `400a4169a911ef96aedd966de76cb571e14e8669`
- 分支：`codex/red-166-action-history-v2`
- 风险：High（玩家公开载荷与隐藏信息边界）
- 玩家只使用新版动作历史；旧文字战斗日志仅在 `debugBattleLog=1` 时可达。

## 已实现

- 权威进程从命令与前后战局状态生成“根动作 → 原子效果”事件链，并由 HTTP、WebSocket、Colyseus 共用的 `createPublicBattleTransitionUpdate()` 按查看者投影。
- 事件可见性默认 `public`；只有技能数据 `concealTargetInBattleLog: true` 或权威事件显式声明的结果为 `actorOnly`。UI 不根据动作类型或技能名猜测保密。
- 鸣人“影分身之术”、猎空“回溯”和蓝染“镜花水月”通过同一技能元数据接口声明隐藏结果。对手及观战者仅收到一个 `concealed` 子事件，不收到选项、目标种类、名称、数量、坐标或实体 ID。
- 训练模式不再由 `qa=RED-166` 注入演示数据；每次本地权威命令成功后都通过与主进程一致的事件生成与查看者投影接口写入真实动作，切换视角时重新投影已有事件链。
- 技能根动作直接显示权威技能名称，不使用技能图标。行动点与充能点分别显示并保留增减号；手牌三种变化使用不同 SVG。
- 对手手牌按当前 10 张手牌上限逐张生成卡背，并在固定宽度内压缩堆叠；同时用数字角标精确显示 0–10 张的数量。公共战局状态中的非本人手牌只保留稳定占位卡和数量。
- 收起态只渲染最近 5 个根动作；展开态可纵向滚动查看内存中最近 20 个根动作，滚轮事件不会传递给棋盘，超过 20 个才淘汰最旧记录。
- 动作栏展开为主语—谓语—宾语—补语结构；移动为“棋子—移动”的主谓结构，不显示文本宾语，起终格只保留作棋盘高亮数据。悬停、聚焦或点击把格坐标交给 renderer，由 Three.js 在与棋盘平行的世界坐标 XZ 平面绘制来源环、目标环和路径，不修改棋盘材质、布局、规则状态或 hash。
- 本机正式 QA 路由先从 `data/pages/images` 加载战斗页图标，再回退旧 `public` 图标；真实棋盘验收不再依赖脱离战场的纯 UI 夹具。

## 自动验证

```text
npm.cmd test -- tests/game/battle-presentation-events.test.ts tests/ui/battle-action-history.test.ts tests/ui/battle-renderer-3d-runtime.test.ts tests/game/battle-page-contract.test.ts
4 files passed; 66 tests passed

npm.cmd run typecheck
passed

npm.cmd run check:encoding
[check-encoding] OK

node --check data/pages/js/battle-ui/battle-action-history.js
node --check data/pages/js/battle-ui/battle-presentation.js
node --check data/pages/js/battle-renderer-3d.js
passed

npm.cmd run check:main-baseline
OK; origin/main 09e3e6c29a2c922bdc591cdb40bc26f6f56954dd; ahead 1, behind 0
```

隐私回归同时断言：普通选择没有 `actorOnly` 标记且公开显示；影分身的选项阶段和地格阶段只对行动玩家显示；镜花水月的行动玩家可见目标在对手/观战者投影中折叠为“结果保密”，其序列化载荷不包含目标 ID；实际传输边界和非本人手牌占位数据不泄漏原卡牌 ID。UI 集成测试还断言动作历史把格坐标委托给当前战场 renderer 的 `setHistoryHighlight()`；renderer 运行时测试确认点与路径属于 Three.js 场景对象，且路径两端具有相同世界 Y 值。

## 浏览器证据

- [真实棋盘默认态 1280×720](./evidence/RED-166-action-history-v2/board-collapsed-1280x720.png)：正式 `battle.html`、Three.js canvas、原地图与 5 条窄栏同时渲染；对手手牌显示卡背和数字角标。
- [真实棋盘展开态 1280×720](./evidence/RED-166-action-history-v2/board-expanded-1280x720.png)：展开后渲染 20 个根动作，滚动容器 `388 / 1151px`，滚动测试达到 `scrollTop=500`；面板与“结束回合”按钮保留 `10px` 间距。
- [真实棋盘高亮态 1280×720](./evidence/RED-166-action-history-v2/board-highlight-1280x720.png)：技能名称来自实际技能定义（示例“圣光盾”）；点击产生 2 个棋子点和 1 条路径，没有虚假的 `(0,0)` 地格；AP 与 hash 保持不变，图标无破图。
- [1280×720 展开状态](./evidence/RED-166-action-history-v2/desktop-expanded.png)：技能名称使用文字；影分身结果为“结果保密”；充能点变化显示 `+1`；左上展示 8 张对手手牌的逐张压缩卡背与数字角标 `8`。夹具不绘制或替换棋盘，实际战斗场景沿用现有地图样式。
- [844×390 横屏展开状态](./evidence/RED-166-action-history-v2/landscape-expanded.png)：动作栏仍可展开，内容内部滚动且没有页面横向溢出。

## 人工验收建议

1. 分别以行动玩家、对手和观战者完成普通公开选择，确认三方都能看到最终选项或公开目标。
2. 完成影分身的方式选择与地格选择，再分别触发一次回溯和镜花水月；行动玩家应看到自己的最终结果，对手和观战者只能看到根动作与“结果保密”。
3. 在训练局移动棋子，确认新动作立即写入且记录只显示“棋子—移动”；点击记录后拖动、缩放棋盘，确认来源环、目标环与虚线保持贴在棋盘平面上。
4. 连续产生 20 个根动作，展开/收起动作栏并滚动，确认棋盘外观不变，只有临时来源/目标高亮。
5. 在 1280×720、844×390、390×844 和 16 棋子局面下检查右侧浮层、技能菜单、状态详情和系统弹窗。
6. 以 `?debugBattleLog=1` 验证旧日志仅供调试；去掉参数后入口必须不可见且不可聚焦。

## 已知风险与回退

- 此候选仍需独立 AI 或人工代码审查，以及真实双客户端体验验收；本记录不代替人工验收。
- 回退本 PR 即可恢复旧实现；没有存档迁移，也没有改变数值、规则或随机算法。
