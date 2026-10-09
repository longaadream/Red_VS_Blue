# RED-250 紧急交互与倍率修复

## 合同与基线

- Linear：[RED-250](https://linear.app/redvsblue/issue/RED-250)
- AI 角色：实现者；风险 Medium。
- `base_branch: main`
- `base_sha: 00df31f8bd35b34200d507fd83853bf5ac99ba94`
- 已执行 `git fetch origin --prune` 并显式刷新远端 main；独立分支 `codex/RED-250-urgent-fixes` 创建后 `npm.cmd run check:main-baseline` 通过。
- 用户确认虚闪为 0.5 倍；退出是关闭程序；黑色月牙问题是同一个方向或落点要重复点击，保留现有方向与落点两阶段。

## 虚闪

历史提交 `df3a91c74f` 修改描述和 `powerMultiplier` 为 0.5，但执行代码仍为 `Math.floor(caster.attack * 0.75)`。本次仅修正执行倍率，不改变射程、费用和其他技能。

`tests/game/red250-ulquiorra-cero.test.ts` 通过真实 `prepareAction → runBattleAction` 验证：攻击 4、目标生命 30 的固定状态，旧版生命为 27（失败），修复后为 28，伤害事件 `finalDamage: 2`。

## 显式取消

旧 `renderTargetOverlay()` 在当前技能卡可再次点击取消时隐藏公共取消按钮。现保留显式入口，仍遵守权威 `canCancel:false` 和提交等待限制。选项弹窗、手牌和规则选择原有入口保持；不将强制响应变成可跳过。直接测试验证凭证原样提交、等待时不重复发送、本地取消不发权威动作。

## 黑色月牙重复落点

公开预演会过滤对手隐藏规则，但旧提示 hash 使用所有消费者共用的 `consumerOrdinal`。固定一护场景中，隐藏对手规则使权威传送步骤全局序号为 1，公开预演为 0；首次落点答案的 hash 不匹配，权威保持 pending，迫使玩家再选一次。

修复为按 `(consumerKind, consumerId, sourceId, eventType)` 单独计数的 `consumerOccurrence`，提示 hash 带 `consumer-identity-v1` 域标记并严格匹配。原全局序号仍用于权威事务重放；旧内部事务缺少新字段时使用旧方案。没有下发事务、隐藏规则或增加客户端权限，没有更改一护两阶段手选规则。

测试覆盖公开投影到正式批量提交的真实链路，验证一次落点完成传送、AP 只扣 2、伤害只产生一次；不同发生次数、不同候选和旧序号域不可串答。独立审查指出的宽松序号别名已移除。

## 关闭程序

主菜单与战局设置提供“退出程序”。只允许可信 `game` 窗口通过 preload 请求既有 `requestApplicationExit()`，复用停服/持久化保护。共享 Promise 将异步停服失败传回 renderer，按钮恢复重试；原生关闭调用点接住已记录的失败。网页没有对应桥时隐藏入口。

## 图拉扬：圣铸进军卡住圣光手牌

用户追加复现：场上有图拉扬，本回合首次打出圣光牌，界面进入“选择一名友方角色”后反复点击无法继续。三种圣光牌自身均自动选目标，这一步实际来自 `afterCardPlay` 的圣铸进军。

根因有两层：卡牌 UI 将规则续选追加到原牌目标字段，并把公开预演的续选凭证写入原牌；公共批量续选 reducer 又只接受技能根动作。即使构造正确的卡牌 `skillChoices`，原实现仍拒绝。修复将手牌续选接入既有严格提示匹配与权威 pending 验证，友军、落点分别收集为有序答案。悬停预演采用相同分流，根目标凭证保留。

取消圣铸进军会提交匹配当前提示的 `cancelled:true`，复用权威取消规则：只跳过额外移动，原牌正常消耗并结算，且本回合圣铸次数正常记账。尚未完成原牌目标的取消仍仅清理本地草稿。没有改动圣铸移动范围、路径、费用、每回合次数或三张圣光牌数据。

游戏回归的最小初始状态：固定种子 250，图拉扬附着 canonical 圣铸规则、受伤友军、圣光手牌；经公开准备收集两步答案，再向真实 `runBattleAction` 提交。新增最初 3 项回归在修复前有 2 项失败（卡牌续选/取消预演返回 `unavailable`），修复后通过。

扩展后的游戏回归 10 项通过：治疗、惩击、充能分别核对真实效果、单次费用/消耗；两阶段取消、同回合下一张牌、错误提示保留权威 pending、非法候选/过期根凭证原子拒绝及合法重试。三个浏览器引擎已重新构建。扩大页面预演验证时发现 11 项 `bindBattlePlayerAvatars is not defined`；独立代理将相同 harness 的页面输入替换为 `git show origin/main:data/pages/battle.html`，得到相同 11 项失败，证明为已有测试隔离缺口。本次仅补相邻预演测试的依赖，不修改头像实现、断言期望或快照。

追加最终验证：以下 20 文件共 352 项通过；独立审查另运行其中 6 文件 84 项通过，无阻塞发现。测试覆盖页面真实函数与规则引擎，未执行本轮完整战局原生鼠标冒烟，悬停和权威分叉接管的最终体验仍待人工。

最终 `npm.cmd run typecheck`、受影响 TS 的 ESLint、HTML 内联脚本语法、编码（1520 文件）、`git diff --check`、`check:main-baseline` 均通过。新增 UI 测试的非可选属性删除类型错误已修正为测试数据字典类型，随后重新运行类型检查与该文件 5 项测试通过。

```powershell
npm.cmd test -- tests/game/red250-turalyon-holy-hand.test.ts tests/game/holy-hand-system.test.ts tests/game/holy-hand-performance.test.ts tests/game/red250-ulquiorra-cero.test.ts tests/game/red250-ichigo-choice.test.ts tests/game/red227-local-skill-sequence.test.ts tests/game/skill-preview-privacy.test.ts tests/game/pending-interaction.test.ts tests/game/effect-chain-transaction.test.ts tests/game/deterministic-runtime.test.ts tests/ui/red250-holy-card-continuation.test.ts tests/ui/red250-pending-cancel.test.ts tests/ui/target-overlay-controls.test.ts tests/ui/red227-local-skill-sequence.test.ts tests/ui/battle-skill-preview-page.test.ts tests/ui/battle-skill-preview.test.ts tests/electron/red250-exit.test.ts tests/electron/ipc-trust.test.ts tests/electron/client-startup.test.ts tests/electron/local-game-lifecycle.test.ts
```

## 验证记录

- 虚闪定向回归：修复前失败，修复后通过。
- 最终 `npm.cmd run typecheck`：通过。中间新增测试的类型错误已修复后重新验证。
- 相关 RED-163 套件有三项相邻失败：葛力姆乔描述及两项镜花水月伤害期望；暂未单独比较本次基线，不把该套件报告为全绿，不修改无关期望。
- 独立审查确认 `tests/electron/colyseus-player-path.test.ts` 的启动超时断言与基线不一致：HEAD 已是 900000ms，旧测试仍期望 240000ms。本次不修改该常量或无关断言。
- 最终直接及相邻回归：14 文件、257 项全部通过。中间两个启动测试失败来自退出接口改为 Promise 后的旧调用约定，现已更新真实拒绝断言及异步 mock，重新运行通过。
- 受影响 TypeScript/JavaScript/CJS 的 ESLint（`--max-warnings 0`）、Electron TypeScript 编译、`npm.cmd run check:encoding`（1518 文件）、`git diff --check` 通过。
- `node scripts/build-game-engine.js --windows-only`、`node scripts/build-practice-ai.mjs`、`node scripts/build-adventure.mjs` 从最终源码重建三个桌面浏览器引擎。
- 独立 AI 最终审查无阻塞发现；序号串答和退出失败重试两个发现已修复。审查者最后独立重跑启动/退出 22 项通过。
- `node tests/electron/red250-exit.smoke.cjs`：隔离 userData 启动真实 Electron，更新 dialog 打开时 `elementFromPoint` 命中右上退出按钮，CDP 鼠标点击后进程 `exitCode: 0`。截图见 [退出入口](RED250/exit-over-update-dialog.png)。
- 原生冒烟为源码开发入口，本地权威服务未构建，截图显示服务未就绪；仅验证此时仍能从真实窗口关闭，不代表完整客户端打包、联网双端或对局原生操作全部通过。一护和取消的状态/凭证验证来自真实规则链及 UI 回归，完整对局体验仍待人工。

最终回归命令：

```powershell
npm.cmd test -- tests/game/red250-ulquiorra-cero.test.ts tests/game/red250-ichigo-choice.test.ts tests/game/red227-local-skill-sequence.test.ts tests/game/skill-preview-privacy.test.ts tests/game/pending-interaction.test.ts tests/game/effect-chain-transaction.test.ts tests/game/deterministic-runtime.test.ts tests/ui/red250-pending-cancel.test.ts tests/ui/target-overlay-controls.test.ts tests/ui/red227-local-skill-sequence.test.ts tests/electron/red250-exit.test.ts tests/electron/ipc-trust.test.ts tests/electron/client-startup.test.ts tests/electron/local-game-lifecycle.test.ts
```

## 回退与人工验收

撤销本任务提交；若包含引擎源修改，使用项目构建脚本同步重新生成引擎。无存档、数据库、随机算法或依赖迁移。

人工验收：主菜单与战局关闭入口可见且能关闭客户端；可取消选择有显式入口且取消不误释放；黑色月牙每个阶段点击一次即可推进；虚闪实际伤害符合 0.5 倍。不得把自动测试视为人工体验验收、合并或发布授权。

图拉扬追加验收：分别使用圣光治疗、惩击、充能，首次圣铸进军选择友军和落点各点击一次；另开局分别在友军、落点阶段取消，确认原牌结算但没有额外移动；同回合再出一张圣光牌不重复触发进军。观察 AP、手牌及效果没有重复结算，悬停预演和真正点击保持一致。
