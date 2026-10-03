# RED-232：教程提交耗时与 AI 空过诊断

风险 High。main 基线 `9d1b0c30801cd733ec4cede37ce1ef0889a2313a` 已刷新，独立分支 `codex/RED-232-tutorial-latency`，依赖 RED-230 起点 `912862c46ea98559c2c1fcc6bfea1b3b64b732b4`。首次 main baseline behind 0。2026-10-03 用户明确批准复用现有 Worker 方案，修改前授权已记录 Linear RED-232。

仅将教程自由对局搜索转入独立实例的现有练习 Worker，使用 `tutorial-plan` 消息；权威结算与预演保留原入口。资源仍通过现有 bootstrap 校验，结果须通过局面身份、拥有者和状态哈希检查，退出与重开取消旧请求。不静默回退到同步搜索。候选需验证搜索期间实际帧响应以及版本、取消、过期和错误处理。

## 问题与已确认执行路径

用户实际试玩反馈提交各类操作卡顿、后期 AI 直接结束回合。当前教程 `trainingApiFetch` 的 PUT 在页面本地运行 canonical `runBattleAction`，没有逐操作网络权威等待；同步规则执行和搜索会占用渲染线程。不能用换成 Electron 保证解决同一同步路径的问题。

页面先 `safeCloneBattleState`，权威 runner 再执行隔离复制。外层整状态复制包含增长的回放；是否可安全去除与具体收益需要同命令、随机游标、审计回放和输入不变性验证。

根候选选择首先纳入 end-turn。普通搜索决策预算 250ms，根模拟之间才检查时钟；首个停止候选或前置工作耗尽预算时，其他合法普通动作可能没有被评估。部署、搜索与权威提交耗时也累计入回合预算。必须区分主动估值结束、仅评估结束候选、零节点超时和回合预算已耗尽。

## 验证要求

固定 seed `18707`，正常模板生命、标准八棋子阵容，记录回合、公开输入拥有者、命令、节点/评估/拒绝数、stopReason 和实际提交耗时。性能对照串行；Node / VM 数字不能替代真实浏览器帧响应。

修复须保留结束回合比较、合法性、公开信息边界、节点/动作上限及可观察软时间超界；不强制无收益行动，不放宽已耗尽的继承预算，不删除完整审计/回放。

## 修复与候选证据

教程搜索复用练习 Worker 的独立实例，页面仅接收规划结果并通过原 runner 提交。局面对象、完整状态 token、输入拥有者改变时拒绝旧结果；退出、重开和初始化期间离开均终止旧客户端。Worker 验证资源版本、战局根种子和输入拥有者，异常暂停并显示原因。

教程本地提交去掉 runner 之外的重复整状态复制；普通玩家操作结束后，不再为等待玩家的 idle pump 重绘整盘。状态隔离、随机游标、完整审计和回放由正式 runner 保留。非教程训练提交保持原复制边界。

教程启用至多十二个根候选的基本比较，覆盖结束、技能、卡牌和移动；普通练习默认关闭。单次软预算允许明确报告超界，累计回合时间、节点和动作限额仍有效。继承预算已耗尽时结束回合仍是合法结果。

下面初测与最终候选是不同的状态/代码版本，不能混用绝对评分。

独立只读初测：真实 seed 18707 的 20 个权威操作，带页面外层复制路径 p50 约 12–28ms，额外复制由约 0.7ms 增到 2.5ms，回放约 77KB 增至 367–400KB。这是可消除的开销，但不足以解释多秒界面冻结，不把它描述为完整根因。Node 表现事件投影约 0.05–0.2ms，尚未包括 Chromium DOM/Three.js/历史模型。

后期真实状态证据：第 16 回合普通行动、蓝方 AP8、场上 16 棋子、预备区 0/0，有 276 合法候选（275 普通动作）。一次正常时钟搜索只评估 endTurn、basic-skill、card，三者分数同为 285100.5850246164；nodes3、342.66ms、time-budget，移动候选未评估。另在同状态继承 elapsedMs2500 的诊断中 nodes0/considered0/trace0 后合法结束回合；已耗尽继承预算的退出必须保留，不能借修复无限计算。

最终固定回放使用正常模板生命与双方八棋子阵容，经正式命令回放到 seed `18707` 第 16 回合（15 枚存活棋子、242 个合法候选）。其源命令序列保存在 `tests/game/tutorial-ai.test.ts`；本地完整快照为 `output/late-ai-diagnostic-18707-turn16-zero-state.json`，文件 SHA-256 `ee539d2d098cdc38f18d70da58390c7cfca09f20366bda6780686b020b577080`。协议报告的 canonical 状态 token 为 `61b0196106a3eebc8b32d8e7bdbbfd16feaeebea9b3816ff0f26e58e537d6737`，不是该 JSON 文件字节的 hash。

独立生成 Worker 协议验证评估 12 个候选、零拒绝，选择 `training-blue-3 / ulquiorra-cero`，正式 runner 接受。动作评分 `783657.8711480027` 高于结束回合 `767268.685267823`；输入 hash 与 RNG 保持不变，重复请求和直接规划选择一致。版本、拥有者、根种子不匹配均返回对应协议错误。协议验收与真实 Chromium 验收分别记录，不将 VM 耗时作为界面证据。

### 真实浏览器后期验收

仅显式 `RVB_QA_REPLAY_STATE` 启用本地 QA 快照端点；服务只监听 `127.0.0.1`，默认无端点。页面仅在 loopback、`tutorialPerf=1`、`qaReplay=1` 时恢复状态。恢复完整 profile、RNG 和回放后，仍通过正式教程开始按钮、Worker、UI 提交和 runner 执行。这是从第 16 回合权威回放状态恢复的 Chromium 测试，**不是人工从第一回合打到第十六回合**。原玩家三个页签未被重载或操作。

独立页 `http://127.0.0.1:38676/battle.html?mode=tutorial&lesson=tactical-intuition&practice=1&tutorialPerf=1&qaReplay=1`：

| 观察 | 实际结果 |
| --- | --- |
| 第 16 回合前三次普通搜索 | 各 12 节点；请求 664.6 / 607.5 / 598.5ms；搜索待决期间 110 / 99 / 99 个 RAF 帧 |
| AI 实际行为 | 虚闪三次正式接受；随后累计时间预算收束，结束回合 |
| 操作权交还 | 第 17 回合红方 AP9，结束回合按钮可用 |
| 玩家移动吉安娜一格 | 正式结算 28.8ms，表现投影 1.8ms，render 253.7ms，idle pump 3ms，之后 RAF 3.4ms |
| 玩家冰霜箭 | 进入合法射程后选高亮蓝染，HP9→5、冰冻、AP8→6、技能冷却2；正式结算29.8ms、render228.1ms、idle pump2.3ms、之后RAF3.2ms |
| 控制台 | 此轮 warn/error 为空 |

记录 `output/RED232-late-browser-metrics.json`；截图 `output/RED232-late-browser-turn17.jpg`、`output/RED232-frostbolt-accepted.jpg`。搜索期间帧统计只在请求待决区间计数，排除搜索前的教学等待。

源码冻结后在独立验收页重新恢复同一回放，AI再次完成三次虚闪并交还第17回合红方，结束回合按钮可用、控制台warn/error为空。最终烟测记录 `output/RED232-final-source-smoke.json`，截图 `output/RED232-final-source-turn17.jpg`。

**剩余性能限制：**这轮首个 AI 正式结算冷启动为476.5ms，后续为27.6/34.1ms；玩家选中棋子时整盘 render 约228–254ms，整个提交反馈约497–541ms。因此不能宣称所有操作已即时响应或所有卡顿已解决。搜索移出界面线程和避免重复重绘已验证；选中棋子的后期渲染仍需单独定位。

静态链路指出 `refreshBattleLegalActions → BattleLegalActions.queryMoveCells` 在选中己方棋子时查询每个移动候选，并复制状态、执行权威校验；AI 回合没有这项选中移动查询。它是剩余渲染开销的优先定位点，尚未通过分阶段 Chromium 计时证明其精确占比。本任务没有引入全局合法动作缓存或放宽验证，建议另建局部移动查询复用任务。

### 预览与释放边界

已确认 `renderBoard` 无条件清预览与 stationary target 去重组合可吞掉显示。修复保存最后请求的局面、版本、选中棋子、技能与目标上下文，在普通重绘后下一帧通过原控制器恢复；取消、离开、换技能、局面变化、退出和历史查看拒绝旧请求。不可预演提示也保留，不修改技能规则或隐私护栏。stationary redraw 回归修改前显示0次、期望1次；独立审查发现历史查看在排队RAF前激活仍可能覆盖历史，新增回归修改前失败，加入既有历史视图护栏后通过。

未发现固定的冰霜箭规则不支持；本轮真实浏览器合法目标释放成功。用户原先那次“按钮可选、目标高亮但不能释放”的具体状态没有稳定重现，不能把普通重绘缺陷当作该提交失败的已证实根因。持续悬停的真实浏览器预览未验收，按自动回归与人工步骤分别记录。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 独立审查：tutorial-worker / newperformance-submit / short-search / tutorial-ai | 4文件41项通过 |
| 独立审查：lesson-runtime / tactical-runtime | 2文件21项通过 |
| 冻结后独立审查：battle-skill-preview / battle-skill-preview-page | 2文件33项通过；历史覆盖风险已修复，无剩余阻塞发现 |
| 冻结后 root 合并定向回归 | 12文件146项通过，含上述95项及渐进预演/隐私/局部技能序列51项；`output/RED232-final-targeted.log` |
| 全教程套件（实现者运行） | 71通过/1既有失败，见下文 |
| 扩大 practice + tutorial-ai/browser + battle-page-runtime（root运行） | 75通过/9既有失败，见下文；不是全绿 |
| 最终 `npm.cmd run typecheck` / 定向 ESLint | exit0 |
| `npm.cmd run build:game-engine` | exit0，配套Worker一并重建；范围外 adventure 生成副产物已恢复 |
| `npm.cmd run check:encoding` / `git diff --check` | 通过 |
| main baseline | 已刷新origin/main，交付前重新检查通过，behind0 |

定向 ESLint 覆盖修改的 TypeScript、教程 JS、测试及 QA 服务脚本。提交隔离回归比较8条正式命令完整权威状态、RNG与回放，也验证非法指令不改变输入；首轮失败输出未另存文件，不虚构 pre-fix 日志路径。预览修改前失败输出由实现者现场运行记录，最终独立重跑33项通过。

网页与本地生成 Android game engine 字节 SHA-256 均为 `ac59bc7f2db8a155f9f27ea11aa77e43d776659321e467820eed0f2bb718d08f`；配套网页 Worker 为 `8ccf0cfe60af5e33a02123bf0cfff685ab19d83079f46a126c0ecb68d82df702`。Android 产物本仓库忽略，不 force-add；没有 Android 设备或 Electron 安装包验收，也没有发布。

### 既有失败对照

在干净依赖工作树 `tutorial-playable`、HEAD `912862c46ea98559c2c1fcc6bfea1b3b64b732b4` 独立重跑，原断言和当前分支一致：

- `tests/practice/session.test.ts` 2项：setup数量期望16、实际15。
- `tests/practice/movement.test.ts` 1项：no-moves 返回值期望true、实际false。
- `tests/electron/battle-page-runtime.test.ts` 6项：VM fixture 缺少 `flushPresentationBeforePendingSelection`、`G`、`clearSkillPreview`、`targetRejectionCanRetry` 绑定。
- `tests/tutorial/tutorial-replay.test.ts:201` 1项：赐福后 AP 期望2、实际3。

基线日志为 `output/RED232-dependency-baseline.log`（31通过/9失败）和 `output/RED232-tutorial-replay-baseline.log`（1失败）。没有修改这些旧断言或范围外逻辑；不能将其说成本任务通过项。

## 人工验收步骤

1. 保留当前正在玩的局，新开 `http://127.0.0.1:38675/battle.html?mode=tutorial&lesson=tactical-intuition&practice=1&tutorialPerf=1`；按正常渐进部署实战，确认玩家提交后操作恢复、后期AI按逐动作规划而非持续空过。
2. 吉安娜进入技能合法射程并有足够AP，点冰霜箭，悬停合法高亮敌人；确认伤害/冰冻公开预演出现，指针不移动时缩放或其他普通重绘后仍显示。点目标验证正式结算。再测火球术。
3. 取消、移开指针、换技能、结束回合、切历史、退出及重开后旧预演不能复活；不可预演/还需选择提示仍正常。
4. 若再次遇到高亮却无法释放，保留该局并记录回合、AP、技能冷却、目标、是否查看历史、操作方式及控制台错误；该偶发现象尚未有精确失败局面。

## 回退

撤销本任务局部提交和规划调度改动，保留 RED-230 教程、RED-228 AI、RED-231 预演；无存档迁移、合并或发布。
