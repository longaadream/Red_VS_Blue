# RED-252 手牌区选择交互恢复

日期：2026-10-11。风险：Medium。实现已修改，等待人工界面验收和独立审查；未发布。

基线：`main`，已执行 `git fetch origin --prune`，`origin/main` 为 `082166c6b803b2e838bce5f0f6824c5bbc714dd6`；`npm.cmd run check:main-baseline` 通过。

## 原因与修改

技能本地预选流程把所有 `needOption` 都交给文字 picker，遗漏了已有的 `presentation: 'hand'`。引擎的单选、多选和具体手牌实例候选信息仍然存在。

`data/pages/battle.html` 统一读取权威 pending 或本地技能预选中的手牌展示信息，复用手牌候选高亮、点选、确认和取消控件。本地确认继续使用本地技能选择流程；权威 pending 仍提交原有带凭证命令。恢复草稿和重绘保留选择。普通选项仍使用原有 picker。

`data/pages/js/battle-ui/mobile-battle-controls.js` 同步识别本地手牌选择，展开手牌区并把点选交给选择处理器。

不改技能数值、费用、规则结算、手牌实例定义或来源死亡后的行为。本次只修复选择交互。

## 验证

- 修改前新增的本地单选、多选牌面展示回归均失败，原因是文字 picker 被调用。
- 执行六个相关文件：`battle-card-metadata-runtime`、`mobile-battle-controls`、`battle-skill-selection-switch`、`selection-session-retry`、`gameplay-module-velen-skills`、`holy-hand-system`，86 项通过、1 项失败。
- 唯一失败为既有 `marks the page disposed before clearing in-flight card metadata requests`，断言要求两条清理语句直接相邻。`git show HEAD:data/pages/battle.html` 同样不符合该正则，属于本次修改前存在的问题，未修改断言或范围外清理逻辑。
- 单独执行新加入的本地手牌展示与交互用例，6 项全部通过：单选替换、同名实例隔离、多选上限、取消勾选、重绘同步、非候选拒绝、空提交拒绝、取消无权威命令、观战/非当前玩家不获得本地选择。
- 两个修改的测试文件 ESLint 通过；`npm.cmd run typecheck` 通过；页面内联 JavaScript 与移动端控件语法解析通过；本次修改文件 `git diff --check` 通过。

尚未完成真实窗口的视觉验收，不把 VM/DOM 回归测试作为真实浏览器截图证据。

## 人工验收

1. 维伦持有至少两张同名圣光牌，发动圣光预言：手牌区候选高亮，不弹文字列表；点击第二张只选中第二张，确认后只修改该实例。
2. 发动万千未来：可勾选 1–3 张、点击已选牌可取消勾选，第四张不能加入；确认后仍执行原有技能效果。
3. 取消选择：不消耗费用、不修改牌；再次发动仍能选择。
4. 移动端：发动以上技能后手牌区自动展开，点击牌面用于选择，不误出牌。
5. 其他普通选项选择继续显示原有文字 picker。

回退：只撤回上述两个表现层文件中的手牌选择适配及对应新增测试；保留此前模块化开发的其他未提交修改。
