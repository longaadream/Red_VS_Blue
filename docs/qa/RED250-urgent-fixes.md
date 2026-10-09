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

## 镜花水月：范围攻击被误判为单体

用户追加反馈替代目标似乎只能选择正方向敌人。依据 RED-163 与 ADR-0026，镜花水月仅响应单体技能，替代目标是蓝染曼哈顿距离三格内的存活敌人，可以斜向，也可以是原施法者。数据与页面候选均没有行列限制。

固定种子 250 的真实复现：蓝染 `(1,1)`、秘密友军 `(2,1)`、敌方施法者 `(5,1)`，替代敌人 `(2,2)` 或 `(3,2)`。王虚的闪光声明 `range: "area"`，但原 `isSinglePieceTargetAction()` 只统计一个棋子选择步骤，将其误判为单体；镜花 pending 包含斜向候选，提交后王虚自己的行列检查拒绝。相同局面用火球触发则可成功转移。原始选择一个路径端点不代表技能只影响一个单位。

修复仅在通用单体判定中排除明确声明 `range: "area"` 的技能，保留缺少范围声明的旧技能兼容。王虚按原路径伤害结算，不打开错误的镜花选择，也不消耗秘密标记；真正单体技能继续支持斜向和原施法者替代。没有修改蓝染范围、王虚路径校验或任一角色数据。

修改前的正确期望回归为 3 项中 2 项失败（两个范围攻击场景错误打开镜花 pending）；修改后扩展为 7 项并全部通过。

最终在前述 20 文件验证集上增加 `tests/game/red250-aizen-targets.test.ts`、`tests/game/targeting.test.ts`、`tests/game/targeting-range-overlay.test.ts`、`tests/game/grimmjow-destruction-history.test.ts`，合计 **24 文件、399 项通过**。typecheck、定向 ESLint、编码（1521 文件）、main-baseline 通过，三个浏览器引擎重建。独立审查无阻塞，另外验证声明 single / 缺 range / area 的判定分别为 true / true / false。

边界：用户现场触发技能尚未确认；本轮明确修复上述已复现缺陷，不声称已复现所有“只能正方向”的现场。未执行本轮完整原生战局鼠标验收。人工复核：王虚不触发镜花且正常路径伤害；火球对秘密友军施放后，可选择蓝染三格内非同行列敌人，原友军无伤、替代者受伤、成本一次；超出三格的候选仍不可选。回退本轮追加提交及对应引擎即可。

## 人工验收发现：黑虚闪无预演

用户在本轮源码测试客户端点击黑虚闪后，将鼠标移到合法敌人上，没有出现预演。最小复现：已归刃施法者攻击 4，敌人攻击 2、生命 30，相邻一格。目标准备正常返回敌人候选，但公开预演返回 `preview-unavailable`。

根因是 `publicSkillDefinition()` 与完成续选后的执行检查一律拒绝 `statusTag` 声明。黑虚闪的声明仅引用“灵压”目标校验（目标攻击必须低于施法者），并非添加状态或执行额外效果。修复范围限定于可信资源里的纯目标条件；不得删除灵压校验或放宽任意效果规则执行。人工验收期待：归刃后选择技能，悬停合法敌人显示公开伤害预演；离开或取消恢复真实棋盘；未归刃、同等/更高攻击与范围外目标仍不可用，悬停不扣费、不改变生命与冷却。

黑虚闪追加验证：修改前真实准备凭证下预演返回 unavailable，修复后普通选择与续选都返回 ready，预演伤害 8、敌人生命 30→22，与真实结算一致且悬停不改原状态。新增 9 项回归包含重建浏览器引擎 VM、灵压/归刃/范围拒绝和未知或带效果规则的拒绝。直接与相邻验证合计 **14 文件、196 项通过**；类型检查、定向 ESLint、编码（1523 文件）、diff 和 main-baseline 通过。三个引擎重新构建，Next webpack 与 Colyseus 构建通过。独立审查无阻塞，另独立运行 **5 文件、107 项通过**。尚待用户在重启后的候选训练局完成悬停体验验收。撤销本次预演源码提交并重建引擎可回退。

## 圣铸进军二次验收与响应说明

用户训练截图仍提示“选择被拒绝：没有合法地格；请重新选择”，见 [用户现场](RED250/turalyon-user-rejected-ground.png)。因此上一轮自动回归不能视为该项人工验收通过。现场提示来自页面对所有 `TARGET_*` 拒绝的统一替换，尚不能据此判定真实原因是空落点。

本轮范围：复现完整页面续选与提交；保留移动距离、路径阻挡及 RED-209 位置提交规则，原圣光牌费用/效果仍只结算一次；卡牌触发附加选择时保留公开准备标题并解释来源；对手获得输入权时使用持续等待提示，隐藏本方确认/取消控件且不读取对手规则标题、来源或候选。无更新机制、规则数值或会话协议变更。

确认并修复一个有条件的页面根动作问题：卡牌同时带旧 `baseAction` 与已完成续选的 `rootAction` 时，预演取旧 base，提交可能丢失新选择。现在优先取 root，与提交根动作语义一致；回归调用实际 `commitLocalCardAction` 验证旧 base 不覆盖已完成答案。这不是截图现场根因的确认。

圣光牌续选提示现在说明“圣光惩击触发了圣铸进军”，保留公开准备给出的友军/落点说明及可选取消语义；没有声称原牌已结算。自己的回合触发对手选择时，持续提示“你的行动触发了对方响应，请等待对方完成选择”，本方结束回合显示“等待对方响应”。等待文案只读取所有者关系，不读取对手标题、来源、候选或选项。拒绝提示保留具体原因，例如不可行走、占用、超出范围、凭证过期；诊断记录保留原始错误码和消息。

最终直接与相邻回归 **11 文件、120 项通过**；随后新增等待 class 恢复及最终移动坐标断言的两个文件 **9 项通过**。类型检查、6 个受影响测试文件的 ESLint、编码检查（1526 文件）、页面内联脚本语法、diff 与 main-baseline 通过。独立审查另运行 **8 文件、72 项通过**，无阻塞发现。

```powershell
npm.cmd test -- tests/ui/red250-march-integration.test.ts tests/ui/red250-target-rejection-message.test.ts tests/ui/red250-pending-guidance.test.ts tests/ui/red250-holy-card-continuation.test.ts tests/ui/opponent-pending-input.test.ts tests/ui/target-overlay-controls.test.ts tests/ui/red250-pending-cancel.test.ts tests/ui/battle-skill-preview-page.test.ts tests/game/red250-turalyon-holy-hand.test.ts tests/game/holy-hand-system.test.ts tests/game/battle-public-projection.test.ts
```

四个集成场景覆盖红/蓝双方、本地完成续选及权威 pending 接管：真实公开准备、页面收集答案、真实规则结算，验证落点、生命 30→25、AP 10→9、手牌消耗一次。原生测试窗口也执行了两方实际页面函数的完整手牌→友军→落点链，均成功。使用 canonical 训练状态和固定测试手牌；不是用户原现场状态，也不是人工鼠标验收。因此截图那次拒绝仍未复现，圣铸进军的现场验收仍未通过。

原生窗口在清缓存刷新后截取 1280×720 与 844×390 的两阶段提示及等待状态；对手等待使用明确标记的所有权 fixture，不代表联网双端验证。取消按钮高 48px、中心命中；窄屏等待提示位于 HUD 下方，确认/取消隐藏且禁用。证据：[友军选择](RED250/march-friendly-1280x720.png)、[落点选择](RED250/march-landing-1280x720.png)、[对手响应](RED250/march-waiting-1280x720.png)、[窄屏友军](RED250/march-friendly-844x390.png)、[窄屏落点](RED250/march-landing-844x390.png)、[窄屏等待](RED250/march-waiting-844x390.png)、[布局与 fixture 记录](RED250/march-guidance-geometry.json)。测试窗口已刷新至本轮页面并回到训练设置；没有修改引擎，因此无需重建引擎。

人工复测：新建训练局，首次使用圣光手牌，检查提示来源；友军与高亮落点各点击一次，检查牌和行动点只消耗一次。分别取消两个附加阶段，确认原牌正常结算；对手响应检查持续等待提示并完成响应，随后本方控件恢复。若再次拒绝，保留本轮显示的具体错误及当时选择阶段。可单独撤销本轮页面/CSS提交回退；没有规则、存档或依赖迁移。

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

### 追加：取消入口位置与资料内注销

用户确认取消按钮实际存在，但角落布局难以发现。原 `placeTargetOverlayHost()` 将技能选择操作移到可滚动技能行，卡牌/规则选择则使用左下角 `left:16px; bottom:84px`，与顶部提示分离。本轮将提示、确认、取消固定在同一组，不再受角色面板重绘和滚动影响；保留 `canCancel`、提交等待、Esc 和原命令分发。按钮至少 48px 高。

主菜单、社区和排位的已有注销流程注册到共享本人资料弹窗，旧外部注销按钮移除。本人资料读取失败仍可退出登录，他人资料不显示此操作；关闭资料或返回菜单不注销。主菜单与战局的“退出程序”保持关闭客户端语义。注销防重复提交，旧异步完成不关闭后来打开的资料；排位队列取消和注销固定原 token，防止等待期间换号后注销新会话。

本轮相关 UI/账号/退出及相邻预演回归 **15 文件 141 项通过**，主菜单新增入口约束单测 **1 项通过**，战局页面契约 **49 项通过**，合计 **191 项**。页面契约中的 live-region 断言随本轮语义更新：只有提示文本负责播报，按钮为独立 group。类型检查及编码检查通过。主菜单旧套件仍有两项基线失败：过期的本机资料 aria 文本和已移除的旧 overlay 断言；实现者与独立审查者均确认本轮基线页面同样缺失对应节点，本轮未修改旧期望。既有排位 `/official/me` 轮询的过期 401 会话清理风险独立记录，不属于本次注销回调修改，不声称已修复。

本轮人工复核：在技能、卡牌和圣铸续选时检查提示附近的取消入口；缩到 844×390 后滚动角色面板，确认操作组仍可见且可点；本人资料内退出登录，返回菜单不自动注销，查看他人资料没有注销入口；“退出程序”仍关闭应用。本轮无游戏规则、构建引擎或存档变化，可单独撤销本轮 UI 提交。

`node tests/electron/red250-ui-entry.smoke.cjs` 在隐藏 Electron 窗口、隔离 userData 中使用生产 HTML/CSS（保持级联顺序），移除游戏启动脚本并填入明确标记的演示手牌/技能。1280×720 与 844×390 下，角色面板打开且滚动后，确认与取消均为 48px 高，中心命中按钮；本人资料注销仅调用模拟宿主一次，他人资料无入口。该 fixture 验证 DOM 布局与资料操作，不执行真实认证、游戏规则或完整 3D 棋盘。

证据：[桌面选择入口](RED250/red250-battle-cancel-after-fix-1280x720.png)、[横屏选择入口](RED250/red250-battle-cancel-after-fix-844x390.png)、[本人资料注销](RED250/red250-profile-self-logout.png)、[他人资料](RED250/red250-profile-other-no-logout.png)、[命中与布局记录](RED250/red250-battle-cancel-after-fix-geometry.json)、[模拟账号记录](RED250/red250-account-results.json)。`RED250_UI_PHASE=before` 使用固定父提交 `e49d74a68807d0bbfb233f875a7ba52811f77e75` 重放旧布局，可比较角落位置。独立审查无阻塞发现，另独立执行 6 文件 49 项通过；定向 ESLint、页面内联语法、diff 与 main-baseline 通过。

撤销本任务提交；若包含引擎源修改，使用项目构建脚本同步重新生成引擎。无存档、数据库、随机算法或依赖迁移。

人工验收：主菜单与战局关闭入口可见且能关闭客户端；可取消选择有显式入口且取消不误释放；黑色月牙每个阶段点击一次即可推进；虚闪实际伤害符合 0.5 倍。不得把自动测试视为人工体验验收、合并或发布授权。

图拉扬追加验收：分别使用圣光治疗、惩击、充能，首次圣铸进军选择友军和落点各点击一次；另开局分别在友军、落点阶段取消，确认原牌结算但没有额外移动；同回合再出一张圣光牌不重复触发进军。观察 AP、手牌及效果没有重复结算，悬停预演和真正点击保持一致。
