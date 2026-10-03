# RED-228：教程自由对局 AI

关联：[Linear RED-228](https://linear.app/redvsblue/issue/RED-228/加强教程自由对局-ai复用短程搜索与逐动作重算)。风险 Medium；实现者报告，不代替人工体验验收。

## 目标与边界

教程进入自由实战后，复用既有短程搜索与公开状态评价，提交一个动作后重新观察。带做、观察演示、固定 first-session 脚本、玩家结构阶段推进、课程阵容与第六局关闭状态保持原有设计。

不改变角色数值、技能规则、随机算法、存档、房间机器人或发布机制。不能用代表性战术测试推断整体胜率，更不表示已验证新手留存。

## 最新验收候选（2026-10-03）

用户指出此前给出试玩步骤时未再次刷新基线。核对后确认分支相对最新 main 落后 8 个提交，依赖预演/UI 分支也已前进；此前 89 项证据只适用于首次候选。

- base_branch: main
- base_sha: `9d1b0c30801cd733ec4cede37ce1ef0889a2313a`
- 通过显式 fetch 刷新 main 后，以 merge 方式合入（提交 `66da3eb92`），保留已推送历史；该次树不变，但重新运行原 9 文件 89 项，全部通过。
- 同步现有 PR 基底 `codex/RED-225-skill-reading` 最新 `1ce51b0a77e6df7d1d312f2cd66e31d4cb450903`，包含 RED226/RED227 已提交候选，树与 RED226 最新 `558d9a6b85b7cd62a77258c3b88d9f7803a527e6` 一致。PR212 已合入依赖分支，并非 main；保留此分层 PR 基底，避免把依赖变化当作本任务修改。
- 唯一冲突是生成 `data/pages/js/game-engine.js`；从合并后的源代码运行 `node scripts/build-game-engine.js` 重建，保留教程 AI 导出与最新 `preparePublicSkillAction`。不选择任一旧 bundle 覆盖另一方。相对最新依赖仍仅本任务 11 个文件变化。
- 最终 15 文件 **172/172 通过**：原 AI/教程 9 文件及 RED227 多段选择、弹射物预演记录、技能内容、技能预演/隐私与 UI 本地选择 6 文件。执行时间 2026-10-03 11:11:27，21.37 秒。
- 最新生成引擎地形探针：seed18704、178 合法候选、6 评估节点、264.49ms、0 拒绝，选择 `hellfire-shotgun` 攻击 (12,7) 并接受结算。网页/Android SHA256 均为 `8A3EC33EC5A5C087C6E071E876AB26184894AA93ACE71FC7C894237B880DC607`。
- 完整类型检查、定向 ESLint、已暂存及工作区 diff 检查通过。旧 `tutorial-replay.test.ts:201` AP 断言最新候选仍失败（实际3/期待2），单独验证，没有修改规则或断言。
- 独立整合复审通过，无实质发现；审查者独立运行生成引擎、多段选择、预演隐私与 UI 本地选择 4 文件 46/46 通过。地形探针为 5 节点、292.50ms、0 拒绝，实际接受攻击；直接装载 bundle 验证 `preparePublicSkillAction`、`previewBattleAction`、`planTutorialAiAction` 同时可用。
- 同步后 `npm.cmd run check:main-baseline` 通过，远端 main 仍为上述 `9d1b0c308…`，behind=0。类型及静态检查已完成通过。

原始日志分别在本地 `ai-main-sync.log`、`ai-latest-sync-tests.log`、`ai-latest-typecheck.log`、`ai-latest-eslint.log`、`ai-latest-known-replay.log`；不提交大日志。未进行新的 Electron 人工体验或发布。

## 首次实现基线（历史记录）

- base_branch: main
- base_sha: bc76ce78e9014f50e5ef1ea445895de8979b0ea1
- 经本机系统代理刷新 main，独立分支 `codex/RED-228-tutorial-ai` 从该基线创建。
- 先快进 RED-220 候选 `1416b1209e95d2ae79867c9c8b61f41bb522ba47`，保留 RED-219 AI 修复；再快进 RED-225 候选 `e2f59194d56ea2b7ca26d96a14b874d1f7c196cc`，保留最新公共预演/UI。不修改任何依赖工作区。
- 本任务 PR 应以 `codex/RED-225-skill-reading` 为基底，单独审阅本次改动。

修改前验证（RED-220 候选）：

| 命令 | 结果 |
| --- | --- |
| `npm.cmd test -- tests/tutorial/tutorial-lesson-runtime.test.js --maxWorkers=1` | 10 项通过 |
| `npm.cmd test -- tests/tutorial tests/practice/short-search.test.ts tests/practice/red219-resource-use.test.ts tests/practice/red219-turn-budget.test.ts --maxWorkers=1` | 68 项通过，1 项既有失败 |
| `npm.cmd test -- tests/practice/short-search.test.ts tests/practice/red219-resource-use.test.ts tests/practice/red219-turn-budget.test.ts tests/tutorial/tutorial-controller.test.ts tests/tutorial/tutorial-replay.test.ts --maxWorkers=1` | 29 项通过，同一项既有失败 |
| `npm.cmd run check:main-baseline`（临时进程代理配置） | 通过；main behind=0 |

既有失败：`tests/tutorial/tutorial-replay.test.ts:201` 期待神圣祝福扣 1 AP，而当前真实结算扣 0，得到 AP=3、期待 AP=2。该失败在新增适配器之前复现；本任务不修改技能费用或强行更新旧断言。原始日志保存在工作区 `ai-baseline.log` 与 `ai-focused-baseline.log`（不提交原始大日志）。

## 验收证据

已完成的固定种子战术验证（`0x228a11`，真实技能与权威结算）：移动后攻击、比较两种技能寻找击杀、连续使用不同技能、零 AP 时用资源牌接技能；同时检查无收益资源保留、敌方手牌变化不影响公开评分、随机落点部署边界及累计预算。旧策略的移动后不接攻击、技能顺序导致错失击杀、零 AP 提前结束均有对照断言。节点验证使用固定时钟，不能代替默认墙钟预算验证。

| 命令 | 结果 |
| --- | --- |
| 教程运行时、带做、控制器、战术适配器、实际生成引擎、short-search、RED219 资源与预算、ai-environment 共 9 个定向测试文件 | 最终 89 项通过，2026-10-03 06:24:48，21.48 秒 |
| `npm.cmd run typecheck` | 通过 |
| 适配器、导出、运行时与本次测试定向 ESLint | 通过 |
| `node scripts/build-game-engine.js` | 成功生成网页及 Android 引擎，保留 RED225 预演导出 |
| 新增 stale 预算回归后的运行时测试 | 13 项通过；状态过期重算同样计入前置状态哈希与提交检查耗时，提示播放延时不计入 |
| `npm.cmd test -- tests/game/tutorial-ai-browser.test.ts --maxWorkers=1` | 实际生成引擎 2 项通过：小棋盘移动接技能、真实地形课程默认预算行动及权威结算 |

真实生成引擎探针：同一 VM 运行引擎、课程脚本、公开资源身份、地图与模板，创建 `terrain` 并推进至对手行动。根种子 18704，地图 `large-hole-arena`，合法动作 178 个；本机 2026-10-03 06:23:54 测得 6 个模拟节点、285.23ms、`time-budget` 停止，6 个评估成功、0 个拒绝。选择死神 `hellfire-shotgun` 攻击 (12,7)，实际权威结算接受；规划与结算均保持输入快照不变。250ms 是边界检查预算，完整单节点不能抢占，因此实际耗时允许超过边界。该结果不保证低性能机器上相同动作或耗时，也不表示每局都能搜索满 3 层。

初版烟测失败原因已定位并修正测试搭建：将 Node 创建的复杂规则状态传给另一 VM 中的引擎，模拟全部返回 `RVB_EFFECT_CHAIN_STATE_INVALID`，得到回退 `endTurn`；后续同 VM 初始化还需按实际 `battle.html` 传入公开资源身份，避免服务端身份回退扫描。未修改游戏规则或提高预算来掩盖这两项测试环境错误。保留 `ai-browser-final.log`、`ai-diagnostic-root.log`、`ai-browser-same-vm-root.log` 作为本地排查记录，不提交大日志。

网页与 Android 生成引擎 SHA256 相同：`BADF0736D9A0B2068CBF0EC3390A8674DFB7E8912764559759DCD040863DA898`。

最终 9 文件回归的同 VM 地形探针为 4 个评估节点、253.82ms、0 个拒绝，选择与前述相同技能/目标并通过结算。测试员另行运行适配器与实际生成引擎 9 项通过，类型与新烟测文件 ESLint 通过；该轮地形探针为 5 个节点、278.89ms。保留实测差异，不声称墙钟截断下节点数恒定。

独立审查通过，无实质发现：审查者独立运行战术与运行时 19 项、最终运行时与带做 28 项、实际生成引擎 2 项，均通过。最后同 VM 地形复验为 6 个评估节点、267.94ms、0 个拒绝，相同攻击通过权威结算与输入不变断言。技术验证不代替人工体验验收。未启动 Electron；固定局面与 VM 验证不能替代实际客户端的流畅度和难度判断。

## 人工验证与回退

进入前五局任意课程，完成带做并进入自由实战，结束回合观察对手的连续行动、提示停留和控制权交还。检查退出/重新开始不会提交旧动作，失败可重试当前课程。不要将关闭的第六局当成已开放功能。

回退时撤销 RED228 的适配器、运行时接入及其测试/文档，保留最新依赖的规则与预演源码，再重建匹配的生成引擎；不要为了移除教程 AI 撤销依赖同步或覆盖整个资源目录。无存档迁移，无线上部署。
