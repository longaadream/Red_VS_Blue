# RED-221：非法目标保留选择与轻提示音

- 用户授权：2026-10-02，优先修复非法选择退出和不合法提示音；角色代码零改动。
- Linear：[RED-221](https://linear.app/redvsblue/issue/RED-221)。AI 角色：实现者；风险 Medium。
- base_branch: main
- base_sha: bc76ce78e9014f50e5ef1ea445895de8979b0ea1（本轮显式 fetch）。
- 独立分支：codex/RED-221-selection-retry；从刷新 main 创建后快进整合已验证 RED-220 候选 1416b1209e95d2ae79867c9c8b61f41bb522ba47，基线检查通过。RED-220 原工作区不修改。

## 范围与验收

公共战场选择、提交回执与拒绝反馈，以及公共音效。非法棋子/地格输入不切换施法者或清空技能/卡牌；提交被拒后释放等待锁，保留可重试选择；成功结算或真实权威会话变化按既有规则结束/刷新；显式取消继续遵守 canCancel。不得自动重放、重复扣费或提交陈旧凭证。

不修改任何角色、技能、卡牌、规则数据或 SkillCode 规范，不改变数值、随机算法、存档、秘密信息规则，不增加个性化动画、音乐、台词，不合并、发布或部署。

选择源仍然有效时，非法操作不能被当作退出。终局、来源离场、回合/所有者改变、不可继续的权威会话失效仍需结束/刷新并解释原因，不能维持无效可提交状态。

遵守八大原则：保持同一选择流程、保留点击/触摸入口、明确错误原因、成功后结束选择、防止重复提交、显式取消、保留玩家控制、保留当前技能与已选步骤。

## 修改前证据

1. 实际 onCellClick 遇到技能候选之外的存活棋子时调用 selectPiece，把非法目标当成切换棋子；VM 回放中 caster 变为 friendly-invalid，pendingSkill 变为 null。
2. 公共 rejectPendingActionFeedback 默认清空目标状态；VM 回放中普通技能遭 server-rejected 后 pendingSkill 变为 null。技能/卡牌目标点击也会在发送前提前清空草稿。
3. showDmFeedback 调用系统 speechSynthesis，未读公共音量。VM 回放中游戏音量 0 仍调用 speak("这个目标不符合技能要求。")。

原基线：battle-page-contract、battle-audio、pending-presentation 三文件 59 项通过、1 项失败；既有 pending-presentation 选择者 viewer=true 的 activeRootId 为 a:0，预期 null，发生在任何修改之前。独立音效排查另跑 battle-audio、battle-motion-feedback、button-audio 三文件 23 项通过。既有失败不混入本修复，不更新快照。

补充基线：在干净的 RED-220 工作区（HEAD 1416b1209e95d2ae79867c9c8b61f41bb522ba47）单独执行 `npx.cmd vitest run tests/game/skill-presentation-ui.test.ts --maxWorkers=1`，10 项通过、1 项失败。`plays one sound for each real queue AOE batch while preserving separate hit batches` 在第 103 行期望 2 次 damage 音效调用、实际 4 次。已在未包含 RED-221 修改的代码中直接复现，属于既有 AOE 音效批次问题，本任务不修改。

现有 `tests/electron/battle-page-runtime.test.ts` 在同一干净基线为 23 项通过、4 项失败：两项缺少 `flushPresentationBeforePendingSelection`、两项缺少 `G` 的隔离测试上下文。本次新增 helper 曾让另两项合法友军地格回放报缺少 `rememberTargetInteraction`；已更新这两项回放加载实际草稿 helper，并断言保留原 selectionId，聚焦回放 2/2 通过。四项既有上下文失败不修改。该测试路径的澄清已同步 Linear。

## 计划验证

直接行为回归先失败再通过；覆盖普通技能、卡牌、公共 pending、多段选择、非法输入→合法重试、服务端拒绝与旧回执、等待单飞、显式取消/不可取消、权威失效；提示音遵守静音、后台、解锁、频率、销毁；实际页面桌面与移动尺寸回放；类型/静态检查；独立审查；角色数据相对 RED-220 零差异。

## 回退与交付边界

撤销本次公共 UI/音效提交即可。纯 UI 修改无需改变角色资源包或服务端规则；客户端页面需重新分发才会生效。保留 RED-220 原发布候选，尚未制作新的安装程序或发布。

## 实现与当前验证结果

- 公共目标草稿随单次提交保留，匹配的可重试拒绝恢复草稿；旧回执不影响新提交。权威快照仍核对离场、回合和选择修订，真实失效不恢复陈旧步骤。
- 额外复现“旧拒绝迟到、新草稿已打开但未提交”的竞态：真实 actionError 分支先清空新草稿而失败，补充无在途提交时的旧拒绝过滤后 4 项会话边界回归通过；权威 needsTarget/needsOption 仍正常进入后续步骤。
- 非法目标不再切换棋子；棋子选择入口在目标模式中也保留施法者，包括重复点击施法者。
- 训练、PVP 练习和冒险复用拒绝恢复，新的权威目标/选项步骤替换旧步骤。
- 自动系统朗读改为公共轻提示音；保留错误文字和规范化文本去重，提示音遵守公共音量/后台/用户手势解锁/销毁。
- 修改前新增行为回归 2 项失败，修复后通过。
- 根代理最终聚焦命令：`npx.cmd vitest run tests/ui/selection-retry.test.ts tests/ui/selection-session-retry.test.ts tests/ui/battle-audio.test.ts tests/ui/battle-motion-feedback.test.ts tests/ui/opponent-pending-input.test.ts tests/game/battle-page-contract.test.ts tests/practice/controller.test.ts --maxWorkers=1`：7 文件 92 项通过。
- 友军地格提交回放：`npx.cmd vitest run tests/electron/battle-page-runtime.test.ts -t "clicking an allied skill landing cell" --maxWorkers=1`：2 项通过，25 项未运行；不能当作整个文件通过。
- 实现代理补充公共练习/移动输入检查：`npm.cmd run test -- tests/practice/controller.test.ts tests/ui/selection-retry.test.ts tests/ui/selection-session-retry.test.ts tests/ui/mobile-battle-controls.test.ts tests/ui/selected-piece-move.test.ts`：5 文件 21 项通过。与上面的聚焦检查有重叠，数量不累加。
- `npm.cmd run lint`、`npx.cmd tsc --noEmit --incremental false`、`git diff --check` 均通过。
- `npm.cmd run check:main-baseline` 通过，origin/main 为合同基线，ahead 14 / behind 0；工作区未提交提示属预期，不执行覆盖同步。
- `git diff --name-only 1416b1209e95d2ae79867c9c8b61f41bb522ba47 -- data/pieces data/skills data/rules data/cards lib/game` 输出为空：角色、技能、规则、卡牌和规则引擎零差异。

## 实际页面与独立审查

`node tests/electron/red221-selection-smoke.cjs` 在最后的回执/发送修补后再次运行，退出 0，`output/RED-221/browser/final/results.json` 的 `ok: true`。

- 使用生产 battle.html 与现有毒液技能；训练设置与确定局面通过夹具注入，实际选择/取消通过鼠标和 CDP 触摸事件输入。
- 桌面 1280×720、移动尺寸 844×390：非法棋子和空地保留施法者与技能；合法重试只提交一次，目标生命 15→11、行动点 10→9；等待中重复输入未增加命令。
- 公共待选拒绝保留草稿，桌面和移动的主动取消均退出选择。
- 旧 RED-220 真实页面回放在非法棋子步骤失败：施法者变为 training-red-1、技能清空、未发命令。旧截图含加载层，不作可用视觉证据；JSON 状态证据有效。
- 截图：`output/RED-221/browser/final/desktop-1280x720-target-retry.png`、`output/RED-221/browser/final/mobile-844x390-target-retry.png`。

独立只读审查提出的回执恢复、练习/冒险选项拒绝后重建、未发送恢复、发送结果未知保护已修补。新增回归覆盖同步早退、重复拒绝、认证失败、发送后异常、旧拒绝竞态与未知回执。未参与生产实现的审查代理复核新增路径后无实际阻断，验证代理也确认当前选择流程无新阻断。新 Astra 审查代理创建遇线程上限，复用独立只读代理完成审查，未宣称使用了不可用代理。

保持现有主动取消与 canCancel 规则；取消被权威拒绝而会话仍有效时，重建公共待选。真正失效的回执请求权威恢复，不能重用旧凭证。确定未发送的目标可重试；发送结果未知保持单飞并查询权威结果，不自动重放。

限制：真实手机硬件、提示音主观听感仍需人工体验；不可取消和 live authority race 主要为 VM/静态覆盖，并非完整联网双客户端验收。既有测试失败保留在上文，不宣称全仓测试通过。实现与自检完成，等待人工体验验收。未创建 PR、未构建安装包、未部署或发布。
