# RED-166 图标动作历史与横屏约束验收记录

## 任务合同

- Linear：RED-166
- 基线分支：`main`
- 开发基线：`62baf3c627605366f1f1f9d79f2cf9ff2d9dab82`
- 风险：Medium（战斗信息展示与交互流程）
- 范围：右侧图标动作历史、根/子事件折叠、来源与目标回看高亮、浮窗避让、横屏约束。
- 不在范围：规则结算、行动命令、完整文字日志、statusTag 图标资源、战斗音效或角色美术。

## 验收结果

1. 页面消费 RED-165 的权威 `presentationEvents`，按根动作折叠被动/伤害/状态等子事件，按 `eventId` 去重，内存最多保留 20 个根动作并以最新在上的顺序显示最近 5 个。
2. 桌面使用右侧 52px 图标栏，不持续显示角色名或句子；当前动作可在悬停/键盘聚焦时向左展开不超过 96 × 52px 的图形因果片段。未知动作使用 fallback 图标。
3. 点击动作只在既有 `floatLayer` 短时标记来源、目标与路径；再次点击或 2.6 秒后清除。该组件不产生战斗意图、不发送命令、不回滚或重新结算。
4. 目标/放置模式、同侧技能栏、状态摘要、详情/系统弹窗、窄宽和低高横屏会把动作栏收为 44px 历史按钮；弹窗层级高于动作栏，动作栏空白区域不拦截棋盘点击。
5. 所有竖屏尺寸都隐藏战斗界面，只显示模态旋转提示；旋转回横屏后浏览器按媒体查询自动恢复战斗界面，不允许竖屏游玩。
6. `prefers-reduced-motion` 下取消脉冲和展开过渡，仅保留静态高亮；鼠标、键盘和触控入口最小为 44px。
7. 原完整文字日志保持为二级入口，未被动作历史替换。

## 自动化验证

```text
npm.cmd test -- tests/ui/battle-action-history.test.ts tests/ui/battle-25d-mobile.test.ts tests/game/battle-ui-boundary.test.ts tests/game/battle-page-contract.test.ts tests/ui/battle-effect-icons.test.ts
5 files passed, 62 tests passed
```

覆盖 0/1/5/20/25 个根动作、同一快照 20 个动作的稳定顺序、父子折叠、重复快照、未知图标 fallback、高亮不修改战局、二次点击清除、浮窗折叠原因、44px 触控尺寸和竖屏阻断合同。

同时执行：

- `npm.cmd run typecheck`
- `npm.cmd run check:encoding`
- 定向 ESLint：动作历史、presentation 接入及相关测试
- 两个修改后 JavaScript 文件的 `node --check`
- `git diff --check`
- `npm.cmd run check:main-baseline`

## 真实浏览器证据

- 1280 × 720、16 棋子：显示 5 个根动作；最新动作包含两个子结果；无页面或棋盘溢出。
- 点击最新动作后出现来源/目标路径高亮；再次点击后高亮层与路径数量从 `1 / 2` 回到 `0 / 0`，行动点、当前行动方与阶段文本保持不变。
- 844 × 390：动作栏收为右侧 44px 历史按钮，未覆盖顶部控制区。
- 390 × 844：动作栏和全部战斗操作不可见，只显示 `role="dialog"`、`aria-modal="true"` 的旋转设备提示。
- 打开同侧技能菜单与地格详情：动作栏自动折叠，详情层保持在其上方，没有点击穿透。

截图：

- `docs/qa/evidence/RED-166-action-history-1280x720.png`
- `docs/qa/evidence/RED-166-action-history-844x390.png`
- `docs/qa/evidence/RED-166-orientation-guard-390x844.png`
- `docs/qa/evidence/RED-166-action-history-overlay-avoidance.png`

本地训练页仍会报告基线已有的 `data/skills/evil-explosion.json` 缺失 warning；RED-166 未修改该资源路径。`?qa=RED-166` 只在本地验收模式、且没有真实权威展示事件时注入确定性 20 动作样本，普通训练和真实对局不受影响。

## 建议人工验收

1. 在真实对局连续执行移动、技能及带状态/伤害子结果的动作，确认动作栏最新在上、没有重复，并与完整文字日志一致。
2. 用鼠标、键盘与触控点击动作，确认只出现回看高亮，不扣行动点、不改变回合和棋子状态。
3. 打开右侧技能栏、状态摘要、地格详情、战斗日志和系统弹窗，确认动作栏折叠且不会遮挡或穿透。
4. 在 1280 × 720 与 844 × 390 检查图标辨识度和触控命中；在任意竖屏尺寸确认无法操作战斗，旋转后自动恢复。
5. 开启“减少动态效果”，确认动作回看为静态高亮。

## 回退

回退本任务提交即可移除动作历史与竖屏阻断，恢复 RED-166 前的战斗页面布局。未修改规则层、协议、存档或数据格式，无需迁移。
