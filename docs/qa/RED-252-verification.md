# RED-252 验证记录

当前状态：继续补齐语义模块及编辑器；完整普通对局迁移仍未完成，RED-252 保持开发中、PR #240 保持草案。下方 v1 历史数据只证明兼容性。边界见 [统一玩法模块说明书](../technical/GAMEPLAY_MODULE_CONTRACT.md)。

## 2026-10-10：继续迁移与编辑器完善（进行中）

- 最新构建后审计到 87 个已验证语义入口，整体仍为 partial。在此前 64 个入口上增加 21 个结构化常量预览，以及双尾飞行使用/到期两个入口；没有把旧兼容图计入此数字。
- 独立审查捕获目标技能测试的选择槽格式错误：必须传 `targets: [{info: target, pos: null}]`。修正后真实复现火球提前取整，原暴怒日志 `10.5→21` 曾变为 `10→20`。因此早期本轮目标技能“通过”结果作废，不作为结算验证证据。
- 已在伤害模块增加显式 `inputPolicy: host`，经原 flow 入口把原始有限值交给权威伤害流程，保留触发后取整时机；默认 flow 行为不变，负伤害仍由宿主拒绝。目标测试现要求实际成功/效果发生，并覆盖暴怒触发、完整状态和日志。
- 迁移工具先校验并跳过已有语义入口，防止重跑覆盖作者图。修改选择范围后重跑不覆盖的失败回归已修复。
- 上述修复独立复核：目标技能、flow runtime、注册表共 **71/71** 通过。其他基础/守卫/常量测试 **58/58** 通过；这些不是本轮最终全套结果。
- 根据用户明确确认，双尾飞行分别传送，单个落点失效不取消另一方。说明书、ADR、技能描述及既有落点测试已同步，落点测试 **9/9** 通过。
- 编辑器增加展开工作区、明显保存入口、Escape 返回、焦点/滚动恢复、模块搜索分类及紧凑节点。真实 Electron 冒烟通过，首屏流程起点和窄布局均有断言；结构化记录/集合/续接控件仍在补齐。[展开截图](RED-252-gameplay-module/gameplay-module-editor-expanded.png)。

本节为阶段记录；复杂内容迁移、最终构建与候选验证尚在进行，下方旧候选结果不能替代本轮验证。

### Cluster 聚合与交互修订（继续实施）

- 用户否定原技术参数直出的界面，确认中文效果编辑、保留高级接口/类型/引用的方向；原编辑器冒烟通过不代表用户体验验收通过。
- 用户明确要求 Skill + StatusTag + Rule 聚合为 Cluster，同时覆盖主动、被动能力。新增聚合视图与依赖来源，不新增第二套执行状态，不擅自实现尚未约定的复制/偷取结算。
- 普通对局 174 个技能（含 53 个被动）和 45 个棋子能力组已写入可幂等迁移的 Cluster 作者信息，共 219 个定义；27 组被动规则关联明确记录 owned/shared 来源。Cluster 覆盖不等于内部代码已全部拆为语义节点，报告分别显示两者。
- 完整回归初次结果 `cluster-full-game.json` 为 2481 项、2423 通过、58 失败。新增问题包括作者信息参与冻结字段比较、运行时副本被作者身份校验拒绝，以及自定义测试技能继承火球图后改写代码。已将 Cluster 身份校验移到编辑器保存边界，冻结比较只排除作者信息，自定义测试不再携带不匹配的火球图；47 项对应回归通过。未修改冻结游戏行为基线，也未放宽生成代码一致性检查。此初次全量结果不能作为最终通过依据。
- 独立审查还发现跨文档状态编辑的草稿丢失、同名状态选错所有者和旧面板闭包污染风险；均已修复并通过真实 Electron 回归：同集合 A/B 面板替换、同名状态所有者、跨文档草稿保存/重载及无效 JSON 阻止编辑均有断言；独立复核未发现剩余实质性 UI 问题。
- 最新作者层定向测试 `cluster-authoring-final.json`：**160/160** 通过。根 TypeScript、编辑器 TypeScript、编辑器共享 bundle、浏览器/Android 游戏引擎构建通过。
- 影分身主动入口及三个关联 Rule 已用通用选择、空间查询、位移、声明式召唤、事件和结果模块表达；保留先选选项后选落点、原召唤声明与私密状态。独立审查修复阻挡传送成功标记、生命置零仅允许当前伤害受害者，以及重跑迁移保留作者图三个问题。新审计为 **91 个语义入口**，整体仍为 partial；不能将 360 个兼容图入口视为语义模块完成。
- 影分身定向测试及独立复跑 **9/9** 通过，含真实阻挡传送 AP/CD/日志对照、错误阶段及无关目标拒绝；注册表 **15/15** 通过。覆盖审计全套首跑 **11/12**，唯一失败为旧覆盖数量断言 `5`，同步为本次已验证的 `91` 并增加影分身入口存在断言后，该项独立重跑通过。未更新冻结游戏快照。
- [Cluster 界面](RED-252-gameplay-module/skill-cluster-editor.png)与[真实交互报告](RED-252-gameplay-module/skill-cluster-smoke.json)可复核。人工建议：打开一个主动技能与一个被动技能的能力总览，跳转关联 Rule；在棋子总览编辑某技能状态，再切换另一技能并返回，保存重开确认只改变正确文档。界面自动验证不代替人工体验验收。
- 本轮最终生产代码全量回归 `cluster-full-game-final.json`：**2490 项、2444 通过、46 失败**。与上一轮 41 项失败精确比较，38 项相同，两个既有超时场景本次通过，双尾飞行旧断言按用户确认修订后通过；新增 8 项均为同一召唤异常探针替换执行代码却继承新模块图，提前被生成代码一致性校验拒绝。仅移除该测试夹具的作者图后，召唤异常回滚与影分身两个文件 **33/33** 通过，费用/哈希/触发事务回滚断言未放宽。此夹具修复后未再次重跑全量，不能把定向结果改写为全套绿色。[精确比较与修复记录](RED-252-gameplay-module/cluster-full-game-comparison.json)。

本批工作仍在本地工作树；PR #240 保持草案。完整语义迁移、结构化复杂流程编辑以及全套既有失败尚未全部解决，不能标为 RED-252 整体完成。回退应将本批作者元数据、Cluster 编辑器、模块注册/生成代码和对应 bundle 成组回退，保留已有独立用户项目，不热切换运行中对局；不需要存档迁移。
- 已重新执行 `git fetch origin --prune` 与 `npm.cmd run check:main-baseline`：base `00df31f8bd35b34200d507fd83853bf5ac99ba94`，behind 0。合同已同步至 RED-252。
- 集成结构化记录/集合/续接和双尾飞行注册后，`module-structured`、`semantic-constants`、`gameplay-module-flight` 三文件 **22/22** 通过。
- `tests/skill-graph` 及目标效果、守卫、gameplay-modules、flight-landing-contact、flow-runtime 共 **19 文件、210/210** 通过。尚未替代完整游戏回归与新 Cluster UI 验证。

## 2026-10-10：语义模块引擎与首批生产迁移

实现 78 个注册原子模块、类型端口/入口权限校验、递归组合展开、条件/集合子流程及失效引用传播。普通效果不能绕过实体存在检查；存在性谓词仅通过可信注册项 `inspectReferences` 检查失效引用，内容节点不能自行声明该权限。模块生成字段在保存、技能/卡牌/规则加载时校验一致性，编辑器禁止解绑已持有的模块字段。

实际迁移 `skills/reap`、`skills/hidan-undying`、`cards/rafaam-curse-sample`、`cards/lucky-coin`、`rules/rule-reap`。共享成功消息组合跨入口复用；伤害折半公式通过组合模块展开，治疗仍提交原权威队列。保留冻结原文、日志及字段。双尾飞行、动态生成与 pending 等复杂流程还未完成语义迁移；覆盖报告明确为 `partial`，只有 5 个字段计入新模块，不能将原 360 个兼容图字段全部算入。

- 完整游戏回归 `semantic-full-game-final.json`：**2464 项，2423 通过、41 失败**；旧候选为 2452 项/39 失败，原 39 项失败名称保持一致。新增两项在 AI pending 枚举和双房间 100 次转换场景中超过既有 5 秒/20 秒限制（6207ms/23920ms）。为诊断单独执行这两个文件，**31/31 通过**，对应耗时 4489ms/17962ms，未修改代码或超时阈值；全量结果仍非绿色，性能波动根因尚未证实。不得把单独通过替代全量结果。[精确比较](RED-252-gameplay-module/full-game-comparison.json)。
- 最新定向集 `output/red-252/semantic-suite-final.json`：**1093/1093 通过**，覆盖编译器、注册表、生产字段保留、技能/卡牌/规则差分、生成内容、预览、存储和效果链。
- `node --test tests/content/content-graph-coverage.test.mjs`：**12/12 通过**。包含语义来源重新编译、篡改拒绝及拉法姆复制来源验证；报告重建后 unknown references 为 0。
- 根 TypeScript、编辑器 TypeScript、共享编辑器 bundle 和浏览器游戏引擎构建通过。
- 真实 Electron 新模块编辑器验证：结构化输入、前序输出引用、组合模块独立端口、进入/返回、组合调用、子流程复制、保存重开和窄面板布局通过。旧编辑器的 17 项兼容检查仍通过。[编辑器证据](RED-252-gameplay-module/smoke.json)、[截图](RED-252-gameplay-module/gameplay-module-editor.png)。
- 最新候选战斗 UI 冒烟于上海时间 00:48 完成，种子 594。实际载入的新模块幸运币代码/图/文案与磁盘匹配，真实手牌点击、AP/日志、动画结束及既有双尾飞行交互均通过。[候选报告](RED-252-gameplay-module/battle-smoke.json)。
- 独立审查最终无未解决实质性发现，另行运行 44/44 测试通过。审查不代表用户体验人工验收。

回退：将本批五个内容定义与模块编译器、运行时桥接、编辑器及生成 bundle 成组回退到 `a35c5194b6`；不改存档或正在进行的对局，不覆盖独立用户资源项目。人工可在独立项目中新建模块图，建立一个带输入/输出的组合模块并调用、保存重开，再使用幸运币及收割技能核对原文、日志与效果。

## 历史：模块标准修订

已核查当前编译器的字段读取/赋值、函数调用和源码生成入口，以及双尾飞行、塔尔斯护甲、拉法姆生成/复制、水门与图拉扬续接。它们目前仍依赖编程语义。新说明书规定作者层只能引用有类型端口和明确副作用契约的注册模块，组合模块须可递归展开，原子能力适配现有权威引擎。此轮未修改运行时或内容行为；新增覆盖报告范围声明，明确编译图通过不等于模块化完成。

本轮 `node --test tests/content/content-graph-coverage.test.mjs` 为 11/11，通过已包含范围声明的断言；覆盖报告已重建。定向 ESLint、编码及差异空白检查通过。独立审查未发现规格、兼容边界或状态声明的实质性问题；不代替后续模块实现的审查。本轮没有重新运行全量游戏/界面测试，下方均是旧候选证据。

## 历史：v1 候选验证

- 实际普通对局数据：276 个代码主入口、84 个预览入口已转为图。45 个棋子与 26 个原有声明式定义保留数据和引用，不伪称代码迁移。
- `npx.cmd vitest run tests/skill-graph tests/content/content-graph-production.test.ts tests/game/content-graph-corpus.test.ts tests/game/content-graph-card-rule-corpus.test.ts tests/game/content-graph-targeting.test.ts tests/game/content-graph-preview.test.ts tests/game/content-graph-generated-cards.test.ts tests/game/content-graph-migration.test.ts --maxWorkers=1 --reporter=json --outputFile=output/red-252/final-content-suite.json`：1013/1013 通过。
- Rafaam 生成诅咒和复制、Tails 六种护甲组合均有真实卡牌/技能宿主的执行对照；验证成功终态、来源失效 fallback、RNG、日志和表现事件。只对精确匹配的原始/编译子源码对进行规范化，不删除其它代码字符串或状态字段。
- Turalyon 与 Minato 的 12 项真实生产数据 BattleAction 续接场景通过，包括成功、取消、错误玩家、过期/重复输入、来源/目标失效、transaction JSON 恢复、旧 effectCode 状态恢复及伪造 hash 负控。子源码先精确匹配；仅当前 trace 的已核实输入 hash 作表示归一，历史、payload 和其它字段保持完整对照。
- 最终 `npm.cmd run build:game-engine` 成功，包括脚本已有的 practice/adventure 构建及桌面、Android 引擎生成。没有迁移冒险专属数据。
- `npx.cmd tsc --noEmit --pretty false`、`npx.cmd tsc -p electron-editor/tsconfig.json`、新增/受影响源码的 ESLint、`npm.cmd run check:encoding`、`git diff --check` 均通过。
- `node scripts/build-skill-graph.mjs` 后，`node tests/electron/content-graph-smoke.mjs` 的 17 项真实 Electron 检查通过。新增主图和预览的“无效草稿→修复→保存”回归；保存边界仍拒绝图/源码不一致。
- 独立审查修复了子源转义影响旧目标扫描器、pending 变量函数初始化顺序、生成卡 fallback 和编辑器无效草稿修复死锁。285 项保存/文档/生产数据/pending 迁移保护独立检查通过。最终覆盖门禁和 UI 脚本另经独立复核，无剩余实质性审查问题。
- `npm.cmd run test -- tests/game --maxWorkers=1 --reporter=json --outputFile=output/red-252/game-final-reviewed.json`：2452 项，2413 通过、39 失败。与同 SHA 冻结基线的 1782 项/40 失败比较，新增失败 0；唯一减少项为构建 Android bundle 后 Unicode state hash 跨平台检查通过。精确名称集合见 [baseline-comparison](RED-252-baseline-comparison.json)。这不是全套绿色，也不授权合并或发布。
- 前一轮 `game-final.json` 记录 44 失败：除既有失败外，2 项捕获了当时正在编写的旧 pending 测试中间态，2 项为静态审计尚未识别 `Reflect/globalThis/arguments`，1 项 AI 场景在并发工作时达到 5032ms 超过默认 5 秒。修复测试及审计后按同一命令重跑，AI 场景单独 3865ms 通过，最终全套也通过该项；未调高 timeout 或更新旧失败断言。
- `final-browser-artifact.json`：Node/浏览器差分、确定性运行/审计和文档保存边界 39/39 通过。原生 ambient 审计新增回归保留未知自由变量拒绝，静态审计脚本退出码 0，语法错误与 unsupportedUse 均为空；该旧测试文件另外两项清单/PVE 加载失败仍属于基线。
- `node --test tests/content/content-graph-coverage.test.mjs`：11/11 通过。最终审计主入口 276/276、含预览 360/360、生成家族 3/3、pending 字段 2/2（3 个子图）、动态引用 8/8，unknown 0、errors 为空。审查发现的“有子图即算覆盖”漏洞已改为冻结旧定义独立构图、整图与生成源精确匹配；旧证明用于篡改图的负控也被拒绝。
- 最终 UI 冒烟于 2026-10-09 22:30:47（上海时间）完成，种子 594。使用同一桌面战斗页面、实际资源载荷与真实 Electron/CDP 鼠标输入，验证可见技能选择、非法目标拒绝、再次点击取消、重试、三步目标提交、两个落点与状态、幸运币使用后手牌清空/AP=9/日志，以及动画自然结束。5 个复杂技能的载入图/代码/描述与磁盘精确匹配，防止 QA 服务器缓存旧资源。该项是候选页面冒烟，不是打包客户端验证或全界面逐帧等价验收；生成卡/pending 的执行由上方宿主测试覆盖，UI 本轮只校验其资源加载。
- 最终新增脚本 ESLint、编码检查（1546 文件）通过。提交前刷新远端与主线检查通过，base SHA 未变化。

### 可复现界面证据

先运行 `node scripts/qa/practice-server.mjs`（内容更新后需要重启），另一个终端运行 `node tests/ui/content-graph-candidate-smoke.mjs`。测试建立受控训练初始状态，后续游戏操作均走真实鼠标输入；独立临时 Electron profile 在退出时清理。它不修改生产 UI、地图或规则。

- [界面报告](RED-252-evidence/battle-smoke.json)、[目标选择](RED-252-evidence/battle-target.png)、[统一卡牌动画](RED-252-evidence/battle-animation.png)、[结算后棋盘](RED-252-evidence/battle-settlement.png)。报告中的绝对路径为运行时原始输出位置，本目录图片是对应保存副本。
- [编辑器报告](RED-252-evidence/editor-smoke.json)、[图编辑器](RED-252-evidence/editor.png)、[独立预览图](RED-252-evidence/preview.png)。

界面验证前几次失败属于测试驱动问题：3D 棋盘隐藏旧 HTML 节点、窗口焦点、首次说明弹窗、重复的隐藏按钮，以及动画结束后保留隐藏 DOM 文本。逐项改为实际 3D 投影、可见控件与渲染器真实隐藏状态；没有修改游戏代码消除测试失败。测试现在先删除旧成功报告并记录起止时间，不能将上次成功报告用于失败运行。

以下为阶段记录；阶段数量不能替代最新候选结果。

## 人工验收建议与回退

1. 在独立资源项目中打开技能、卡牌和规则的流程图，修改节点参数、连线并保存重开；修改一个错误引用后再修复，确认保存按钮恢复。
2. 检查 `ashbringer` 主入口与预览可分别编辑，描述保持原文；不要把自动生成代码当作第二个可编辑来源。
3. 在普通训练对局中使用目标型技能，依次检查非法目标提示、取消、重新选择、结算、日志和统一动画。另检查 Turalyon 多阶段选择、Minato 击杀后续接、Rafaam 诅咒及 Tails 护甲生成。
4. 比对冻结旧版相同种子与输入的结果。发现差异时保存种子、输入动作、回合、错误原因与截图，不更新冻结 fixture 来消除失败。

本 PR 为 High 风险跨模块迁移，合并与玩家体验验收仍由人工决定。回退应成组撤销图编译器、内容定义、入口适配及对应构建产物；不删除用户资源项目，不对正在运行的对局热切换内容，不宣称旧对局可无损切换。

## 基线

- SHA：`00df31f8bd35b34200d507fd83853bf5ac99ba94`
- 分支：`codex/RED-252-modular-content-graphs`
- `git fetch origin --prune`、分支创建后 `npm.cmd run check:main-baseline`：通过，ahead 0 / behind 0。
- 本工作区 `npm.cmd ci --foreground-scripts --no-audit --no-fund`：通过；未升级依赖。

## 修改生产代码前的针对性测试

命令：

```text
npm.cmd run test -- tests/electron/skill-graph.test.ts tests/game/skillcode-browser-differential.test.ts tests/game/targeting.test.ts tests/game/pending-presentation-contract.test.ts tests/game/battle-presentation-events.test.ts --maxWorkers=1
```

结果：退出码1，5文件中4通过、1失败；68项中67通过、1失败。

已存在失败：`tests/game/pending-presentation-contract.test.ts:56`，`pending selection live board > settles newly delivered animation only for the choosing viewer=true`，期望 `activeRootId` 为 `null`，实际 `a:0`。此时尚无生产代码或内容迁移，未修正该范围外行为，未改测试期望或快照。

## 后续证据

未执行项目不能标为通过；未迁移内容不能计入迁移完成。

- 冻结对照：`tests/game/fixtures/RED-252-legacy-content.json`，从合同 base SHA 的 Git 对象读取 347 个普通对局可达定义；不从迁移后数据反推旧实现。
- `node --test tests/content/content-graph-coverage.test.mjs`：8 项通过。字段级审计将主代码与预览分开；声明式内容不冒充可执行图。修正了将 `recall-skill-trigger` 错拆成 `skill-trigger` 的引用扫描问题；动态引用仍单独报告。
- `node tests/electron/content-graph-smoke.mjs`：真实 Electron 技能、卡牌、规则的创建、拖拽、连线、参数编辑、保存、重开及篡改拒绝通过；技能主入口与预览独立编辑，解除主图后预览提升、重开及再解除通过。报告在 `output/playwright/content-graph-smoke.json`。后续 compiler 扩展后需重建 bundle 并复跑。
- 第一批实际数据迁移：10 个技能（包含 `blink`）、`rule-reap`、`soul-fragment` 的主入口，以及 7 个技能的预览入口；其他字段原样保留。
- `npm.cmd run test -- tests/game/content-graph-migration.test.ts tests/game/content-graph-targeting.test.ts tests/skill-graph --maxWorkers=1`：4 文件、100 项通过（当前阶段）。覆盖实际伤害/治疗/阻挡/队列/卡牌与静态目标推断；不代表全量内容完成。
- 对照测试曾发现生成对象键引号影响旧目标推断器。编译器改为对合法标识符输出裸键，新增冻结内容语料目标推断一致性检查；仍需继续核验多步骤选择和复杂分支。
- 扩展 function/invoke 后，真实技能宿主、卡牌/规则宿主和目标推断三个 corpus 文件共 316 项通过。使用独立的规则运行上下文和种子 252；对比状态、队列、结果、随机运行状态及异常。输入包含无目标、敌军、友军、地格，规则另有三个触发上下文。相同的拒绝或空效果不计为成功路径验证。
- `tests/game/content-graph-preview.test.ts`：7 项通过，对照冻结原预览与实际生产图预览，覆盖多个攻击与冷却组合。
- 独立审查已发现并修复：治疗队列零/多参数入队、条件转换的 `Boolean` 名称遮蔽、循环继承非支配路径变量，以及公开技能预览泄露 graph metadata。闭包提升与内部名称冲突正在修复中，需复审。

## 全量 game 目录的基线对照

在独立只读基线 checkout（同一 base SHA，独立 `npm ci`）与实现 checkout 分别执行：

```text
npm.cmd run test -- tests/game --maxWorkers=1 --reporter=json --outputFile=output/red-252/game-baseline.json
```

实现 checkout 使用 `game-current.json` 输出文件。基线 1782 项、40 失败；当时实现版本 1907 项、41 失败。失败名称集合只有一项新增：`skill-preview.test.ts` 的公开技能预览对照，由新增图元数据未脱敏导致。已在 `redactSkill` 中随原代码字段删除图元数据，并增加不泄露 graph 的断言；该文件重跑 19/19 通过。

其余 40 项为同基线原有失败，包括未生成的 Android 引擎产物及既有规则/表现断言。未更新这些期望或快照。全量结果和比较文件保存在 `output/red-252/`；上述全量结果早于后续 compiler 扩展，不作为最终候选版本通过证据。

第二批迁移后（196 个主入口、53 个预览入口），再次运行完整 game 目录，输出 `output/red-252/game-current-batch-2.json`：2257 项、40 失败；与原始基线相比，新增失败 0、修复的原失败 0。精确失败集合比较见 `baseline-comparison-batch-2.json`。没有修改原失败期望。该结果属于第二批阶段验证，后续剩余迁移和编译器修改仍需候选验证。

本批还将 29 个 `kind: passive` 技能的图入口标为 `triggerSkill`，继续生成原 `executeSkill(context)` 函数形式，使用触发入口权限校验；描述、数据及调用宿主不变。新增 `recompile-content-graphs.ts` 显式重建编译字段，保留图和非生成字段，整批预检后写入，用于编译器调整后的产物刷新。

后续仍需：剩余主入口、预览及续接图、全量对应场景、独立审查、候选版本验证与 PR。当前不得报告完整任务完成。

## 第三批阶段验证

- 实际数据达到 272 个主入口、82 个预览入口。独立审查修复了成员方法在参数副作用之前读取、循环 var 声明提升、内部全局名称遮蔽，以及生成源码绑定替换和 JSON 原型键保真问题。
- 写入前真实技能/卡牌/规则宿主及目标推断：451/451 通过，报告 `output/red-252/batch-3-preflight.json`。
- 写入后组合验证首次 989 项中 10 失败：9 项要求首批数据等于最新导入器产物，1 项错误地重新导入已编译的 `shadow-step-teleport` 源。刷新首批图产物，并将导入器用例改为读取冻结原文；不修改游戏行为期望。相关重跑 329/329 通过，报告 `batch-3-refresh.json`。其他成功结果不替代最终候选版本复跑。
- 当前 Electron bundle 重建后，真实编辑器创建、保存、重开、连线、拖拽、主入口/预览入口独立编辑和拒绝篡改再次通过。有效图和篡改拒绝分别记录在 `output/playwright/content-graph-editor.png` 与 `content-graph-tamper-rejected.png`。
- `node scripts/build-game-engine.js --windows-only` 成功；Node/浏览器引擎差分与固定种子检查通过，结果在 `output/red-252/browser-seed-batch-3.json`。未构建 Android 产物。
- 审查发现 Rafaam 生成卡子图遗漏伤害来源 fallback，以及迁移工具覆写已有手工图、生成源对照不足的问题；该生成内容批次尚未写入生产数据，正在修复并扩展真实宿主验证。

## 2026-10-10 语义模块续补阶段记录

仍处于实现中，不能据此报告全量完成。本段替代旧阶段数字作为新增改动的说明，不替代最终候选验证。

- 事件捕获补齐已离场来源处理，修复反应卡进入结算前来源已在墓地时被错误拒绝的问题。
- 本次新增/整合：月神保护两条规则、飞段/带土死亡保护三条规则、初始手牌与月神赐福、艾德加/普里莫逐次连击、两条裂魂规则及寒冰坚忍反冻。
- 本次执行计数器使用局部句柄，不能跨执行复用，也不写对局状态；保留逐击触发、来源离场、累计治疗/伤害和原消息。
- `root-integrated.json`：52/52 通过（包含 flow、卡牌、保护、死亡保护、手牌生成、连击、裂魂）。新增反冻单项覆盖 55 组冻结差分场景，另有成功路径断言，见 `icebound.json`。
- `modules-integrated.json`：497 通过、6 失败。属于并行工作中的整合结果，失败涉及动量最后动作差异、位移批次测试隔离/目标 revision 和 Cluster 依赖；不得将其记成全绿。
- Cluster 已补充语义图状态/Rule 依赖追踪，重新生成 Cluster 元数据；`cluster-semantic-integrated.json` 的两套测试通过，包括拒绝编译源失配和忽略未使用记录。
- 覆盖审计保留真实迁移缺口。动态候选恢复 8/8 解析，三组生成家族和两组历史 pending source 均有独立来源证明；新增六模板证明及语义篡改测试，`audit-regressions.log` 两项通过。完整审计测试仍需在最终稳定数据上重跑。
- 尚需：剩余普通技能/Rule 迁移、持续更新相关预览、完整语义模块测试、独立代码审查、构建和真实编辑器候选验证。冻结 fixture 未为消除差异而更新。

### 2026-10-10 最新主分支同步前检查点

用户明确要求标准规则以基线为准。最新 origin/main 为 082166c6b803b2e838bce5f0f6824c5bbc714dd6，当前分支 behind 33。保存当前在研改动后同步主分支，再从该 Git SHA 提取冻结对照内容。新增 refresh-semantic-baseline.mjs 只从 Git blob 读取已有清单，报告各项前后哈希；不用当前实现更新预期。

本检查点不是候选交付：类型检查通过，counter/Cluster 定向 33/33 通过，位移批次 40/40 通过；pending 集成仍有 11 项失败，holy support 尚未完成接线，Cluster 跨组合记录引用仍有审查缺口。语义迁移和参考图界面仍未完成。冻结数据尚未更新；同步后所有受影响证据需要重验。

### 2026-10-10 最新主分支同步后续补

已合入 origin/main 082166c6b803b2e838bce5f0f6824c5bbc714dd6（合并提交 eb238ea7649cef83d16ec28f7fb3e9e497681244）。冻结对照由该提交的 Git blob 更新，18 项内容变化有逐项哈希记录；不使用迁移后的代码生成对照。先前基线结果只作历史记录。

- 本轮新增语义图：圣光汲取、神圣祝福、鲜血回响触发、献祭、霜之哀伤、灵魂汲取、恒星之火、超级形态、镜花水月。均由登记的查询、数值、伤害、资源、状态记录、分支等模块组成；没有加入整项技能执行器。
- `output/red-252/root-latest-skills-recheck.json`：前七项 47/47 差分通过，比较完整状态、结果消息和随机运行时。包含来源离场、护盾阻挡、最低生命同值顺序和斜向溅射。
- `output/red-252/super-form-kyoka.json`：后两项 28/28 差分通过，覆盖既有状态替换、缺失玩家、秘密目标、自选目标及等待选择。
- 修复整合中新引入的重复 `event.cancelled` 注册，复用既有模块。`output/red-252/skill-graph-current.json`：图框架 160/160 通过。
- 参考图界面已改为单侧栏与浅色主体，实际截图仍有按钮、参数弹层、试用入口待改进，不能报告界面验收通过。
- 仍在执行：复杂规则与多阶段选择迁移、独立审查、稳定数据上的覆盖审计、全量回归及候选验证。当前临时覆盖输出受并行编辑影响，不作为最终完成率。

独立审查补充：原 47/47 未覆盖神圣祝福的表现批次与既有增益关联规则。新增实际表现记录及既有状态测试先复现失败，再修复；迁移来源检查也改为冻结源独立重建，拒绝覆盖合法但已改行为的作者图。`holy-review-after.json` 对应 20/20 通过，包含通用批次结构测试；仍需独立复查。不得把较早差分通过解释为当时已完全等价。

### 2026-10-10 独立审查续补（仍未完成）

- 神圣祝福批次进一步禁止触发技能宿主使用表现队列，禁止直接或经组合模块嵌套批次；独立复查 22/22 通过，图框架与 holy 组合检查 170/170 通过。这些结果早于后续条件循环扩展。
- 无限刃语义图差分 21/21 通过，独立审查未发现新增 P1/P2。拉法姆诅咒守护仅迁移空效果成功标记，不能据此将关联规则计为完成。
- 守望者终极技能初版虽然 18 项普通场景通过，真实 `beforeCardAdded` 阻止首次生成时无法补满手牌；已撤回生产迁移，正在补有限预算的条件循环及真实触发器回归。
- Shishio/Velen/Colt 与动量批次原测试 12/12 通过，但独立审查发现 Velen 缺失创建回合字段漏强化、Colt 多目标伤害顺序改变、无效区域被额外删除，均在修正中，尚不能计为通过。
- movement 与 projectile 定向测试共 120 项通过，但独立审查真实宿主复现追踪攻击斜向条件反转、施法者格被错误加入落点候选；这些测试尚不足以证明全量行为等价，正在补充真实成功路径与回归。
- `constants-continuation.json`：9/9 通过。修正测试中不可能命中的类型比较，并通过已有常量迁移器补齐 shadow-step 固定预览入口；冻结期望不变。
- 当前覆盖审计仍受到旧编辑器编译包影响，新注册模块在适配器中被判为未知；待重建编译包并稳定生产图后重新统计，不使用本次中间计数作为完成率。
- 草稿试用入口正在接入现有隔离训练窗口；新增内存快照准备器尚待单测、IPC 接线和真实 Electron 验证。界面布局及静态卡牌预览通过不代表该入口已经完成。
- 致命视线补齐规则改写主目标可绕过最小距离的语义分支，生产入口已使用模块图。`target-effects-mirror.json` 64/64 通过（新增 9 个距离/改写组合，每个再对照致死及圣盾场景），记录完整对局状态、实际表现事件和种子 594 的随机运行时；定向 ESLint 通过。
- 本轮 `tsc --noEmit --pretty false` 通过，记录在 `output/red-252/typecheck-continuation.log`；后续仍有并行改动，须在候选稳定后重跑。
- pending 批次曾通过 12 项，但其新增投影将圣盾规则描述符折成 ID 并替换日志哈希，隐藏了真实存储差异。整合审查已要求撤销这类新规范化，由生产模块保留冻结基线的规则引用形状；在恢复原断言并重验之前不计作通过。

### 2026-10-10 审查问题关闭与继续迁移

以下是后续修复结果，保留上文失败记录；整个任务仍未完成。

- 分支刷新后 `check:main-baseline` 通过，HEAD `eb238ea7649cef83d16ec28f7fb3e9e497681244`，`origin/main` 仍为 `082166c6b803b2e838bce5f0f6824c5bbc714dd6`，behind 0。
- pending 原状态/日志/viewer 比较已恢复，生产使用通用 `rule.append-reference` 保留原 `{id}` 规则存储形状。独立复跑集成 12/12、模块 4/4 通过；不再通过规则归一化隐藏差异。
- while 表现组检查覆盖执行体、集合子流程和组合嵌套，保留条件中的局部返回。守望者安全预算设为 256；真实触发器同时阻止一次、移除一次时经过 12 次尝试补满，永久阻止在 256 次后失败并由行动事务完整回滚。独立复跑 59/59 通过，前轮两项 P2 关闭。
- 位移差分补实际成功、阻挡、改写斜向目标及施放者在移动中死亡，并捕获表现事件；本批 84/84 通过，后续新增位移内容仍需另验。
- 普里莫代伤规则已拆为存在性、生命、敌我、坐标、范围、状态及队列接受条件；原子仅提交现有伤害重定向队列。差分 16/16 通过，含跨玩家同队、对角邻接、队列拒绝、真实致死及完整状态/RNG/表现。独立审查及原 RED-213 联跑此前 22/22 通过，未发现 P1/P2。
- 草稿试用后端单测及实际 Electron 火球草稿验证已经运行；独立审查发现合成模板 ID 使模板绑定被动失效，已修成内存覆盖原 holder 并保留 ID，新增志志雄燃地真实规则回归。该修复后试用按钮接线、关联 Cluster 草稿和 Electron 重验仍在进行。
- 覆盖扫描修正了将 `cards.hand(playerId)` 的玩家 ID 误算为内容引用，以及 `rules.add(target, ruleId, scope)` 取错内容参数的问题。参数扫描回归 2/2 通过；最终覆盖数字待全部生产图及 bundle 稳定后重算。


### 2026-10-10 完整状态核对与试用接线

- 移除多组差分测试中将规则对象压成 ID 的投影。root 第一组 113/113 通过；第二组初跑 56/57，唯一失败为测试自身仍期待字符串规则，改为核对真实规则对象后 recovery 定向通过，未修改冻结快照。
- 影分身差分改为完整状态并注入固定 RuleRuntime（seed 594），保留真实实例 ID 与顺序；不再以时间戳替换掩盖随机/时钟差异。
- 双尾飞行完整状态对比发现默认 status 流程额外注入 sourceId/statusOrigins。生产图改用 host 状态输入，并按基线顺序显式安装规则。迁移器保留有效作者图，拒绝来源不明的旧脚本修改。
- 组合护甲、机械支援、诅咒复制差分改为完整 HostRun（state/result/RNG/presentation），移除时间戳正则替换及仅语义侧预装六张卡的 fixture。仅生成护甲卡的执行定义排除在状态等价之外，另验证图与编译代码一致；所有其他卡牌字段完整比较。
- flight/generated-content/followup-rules/recall/toxin/module-compiler 整合 59/59 通过，输出 `output/red-252/current-integration.log`。显式 previewSafe:false 不再被 pure:true 覆盖。
- follow-up rules 六条完成致死消息和来源死亡取消修复。编辑器试用按钮已接真实接口，当前 Cluster 的关联未保存草稿随请求发送；真实 Electron 草稿训练烟测通过，保持原 holder jaina 身份。句子编辑器烟测再次通过，成功提示改为训练场可见名称，避免显示 jaina/good 内部值。
- `tsc --noEmit --pretty false` 当前通过（`output/red-252/current-types-final.log`），后续并行新增代码仍须重验。
- 重建 `scripts/build-skill-graph.mjs` 后审计：普通对局可达执行入口 360，语义模块图校验通过 335，剩余 25。该数字为执行入口数（包含预览），不是技能数或行为验收完成率。`complete:false` 保持；结果 `output/red-252/rebuilt-coverage.json`。尚未完成整体独立复核和界面视觉验收。

- 扩大整合测试（63 文件）：867/868 通过；projectile 的因陀罗之矢未安装天照移动规则断言失败。记录 `output/red-252/full-module-integration.log`，待定位修复后重验，不计作全绿。

- 架构粒度复核：Recall 的 capture/restore 虽通过行为差分，仍把多个属性恢复封装进专用节点，不满足“子功能独立组合”要求。已退回拆分为通用读取、记录构造/存储、逐字段恢复。天照的范围筛选与批次登记、连锁位移的循环同样在收敛；登记图数量不代表这些架构验收已通过。
- 界面视觉核对另记 `docs/qa/RED-252-design-qa.md`，当前 `blocked`，仍有图标、区域间距和窄窗口复核项，未宣称 1:1 完成。

- 时空扭曲主动技能及归还规则补齐：主动效果完全复用既有选目标、属性运算、结构化状态及规则模块；归还新增封闭的玩家属性转移记录读取和战场/墓地非生命属性读写。筛选、循环、加减、下限及清理由图控制，没有整技能宿主函数。48/48 完整 state/result/presentation/RNG 差分通过，覆盖重复施放、负值、丢失目标/来源、墓地、同一来源目标、缺字段和空记录；定向 ESLint 通过，尚待独立复核。

## 2026-10-10 连续反弹边界复核

- 独立审查指出连续反弹将 while 安全预算用作业务上限：满十次仍有候选会抛错。改成独立次数计数及 `<10` 条件，保留安全预算；无合法落点也计算一次。
- 新增密集敌人和全部地格不可通行场景，覆盖直接技能执行及真实行动事务。测试进一步发现首次伤害错误读取投射物路径，已改成基线的位移路径敌人事实。
- movement-family 136/136 通过；独立审查复跑同样通过，生产 JSON 与图构造/生成代码一致，此 P2 关闭。
- generated-content 增加六种护甲卡实际生成和使用的完整状态对照，共 10/10 通过。仅排除两实现故意不同的生成执行定义，并验证新定义与其图编译结果一致；没有状态 ID/时间戳泛化。
- 本轮 movement 脚本、测试及 generated-content 测试 ESLint 通过。其他迁移与全任务验收仍进行中。

## 2026-10-10 混沌控制与后续集成

- 混沌控制展开为落点地形/占位检查、权威传送、范围敌人查询、逐棋子状态应用与已有定身刷新。新增的原子仅查询允许地形类型；没有整技能脚本包装。
- 19/19 完整基线对照通过，其中 6 项真实 charge 行动事务；覆盖正常/掩体/非法地形/不可行走/自身占位/他人占位/越界/死亡目标/无敌人/已有状态/待选择/阻挡/施法者中途死亡。
- 集成 Sage/Totsuka registry 并生成两份生产技能图。Amaterasu、Sage/Totsuka、Shishio FlameSpirit、Lament、ChaosControl 合计 5 文件 50/50 通过。
- 默认高并发整套测试出现 11 项 5 秒超时，以及开发中批次的 6 项真实差异；没有提高超时或删除断言。限制 maxWorkers=2 后旧模块超时消失，52 文件通过，剩 movement 的 7 项均属于当时新增的 Muzan/数量断言，交由该批次继续修复。
- 最新重建 bundle 后扫描：普通可达执行入口 360，模块图结构校验通过 352，剩余 8。此统计不是行为验收率。剩余：镜花改写、拉法姆诅咒两规则、幸运币赠予、恶魔契约、无惨魔躯、毒液两技能。
- 独立审查关闭 Recall/Lament 原迁移 P2；新增 Shishio 迁移来源与作者图保留 P2 已交回修复，任务仍未完成。

## 2026-10-10 后续集成：严格宿主对照修复

- 暴风雪选点范围改为图内读取全部棋盘地格、计算距离并归约最大值，保持基线的动态范围；没有写死范围常量。
- 暴风雪结算使用显式上下文玩家，保留地格表现清理、致死目标名称、墓地表现标记和原始消息。
- 尾巴装甲和远征令保留原选择协议中省略字段的行为；光铸行军空操作不增加空字符串消息。
- 对应 projectile / pending / generated-content 三个测试文件合计 91/91 通过；记录 `output/red-252/blizzard-integration-fixed.log`。
- 真数千手优先复用已有上下文目标，避免多调用一次选点改变宿主计数；严格卡牌语料测试通过，记录 `output/red-252/thousand-hands-context.log`。
- 本轮类型检查及上述根代理修改的 ESLint 通过。完整语料最近一次仍有 7 项差异，其中真数千手已修复，其余正在修复。不可将局部测试通过描述为全部验收通过。
- 实际 Electron 句式界面和高级编辑器冒烟通过；复杂技能句式投影仍需补齐，UI 整体验收状态保持未完成。

### 后续框架集成检查

- 本轮全部 `gameplay-module-*.test.ts`：53 文件中 52 通过，838 项通过、3 项失败；失败均在正在接入的 Rafaam curse 文件，错误为缺少真实宿主方法，已交由该模块实现者补齐。日志 `output/red-252/module-integration-current.log`。
- 框架/生成卡牌/pending 联合检查：220 通过、4 失败。生成卡牌迁移预检需要识别新语义文档；Cluster 检查遇到生成 JSON 尾部字符（随后修复）；图拉扬两阶段流程在联合负载下超时，单独运行同一测试在 3.34 秒通过、没有修改超时；最后一项为本文第 111 行已记录的迁移前动画队列失败。联合通过结论仍待稳定代码后复核。
- 新结构报告：普通可达 360 个代码字段，已验证 354 个，剩余 6 个；这是字段级结构统计，不是技能完成比例或行为验收结论。报告 `output/red-252/coverage-current-integration.json`。

### 规则选择协议与独立审查修复

- 独立审查确认 Amaterasu 的致死消息与数组删除跳项两项 P2 已关闭；投射/移动/生成内容独立检查 253/253，Amaterasu 12/12，Sage/Totsuka/Ichigo/Kyoka 主动技能 28/28。
- 审查发现 Venom 换位后源棋子死亡会中断后续效果，已改用执行内捕获对象读取归属；新增双方分别死亡场景，movement 170/170。等待复审确认。
- 修复 Colt、Grimmjow 与 Minato 选择协议：按基线省略未提供的字段，使用原规则重放。Minato 支持已有 targetX/targetY 的直接分支，并保留原地图候选顺序。Grimmjow 测试删除 pending 结果改写函数，首次提示改为完整原始结果差分。
- 修复 Kyoka rewrite 的同类 P2：删除新增的 effectCode/payload/range；按基线使用 selectedTargets 首项，取消、首项无效、多个选择、单目标标记和生命为零的原目标均做原始宿主差分。
- 当前 follow-up 测试 29/29，包括新增的 6 个 Minato 和 8 个 Kyoka 场景。日志 `output/red-252/kyoka-rule-protocol.log`。相关类型检查、ESLint 通过。仍待复审与最终集成，不视为全部验收通过。

### 最终差异收敛与结构覆盖（仍在验证）

- 再次刷新并直接查询远端 `refs/heads/main`，确认 `082166c6b803b2e838bce5f0f6824c5bbc714dd6`；基线检查 behind 0。记录 `output/red-252/baseline-final-integration.log`。
- 结构扫描已覆盖普通对局 360/360 个可达代码字段。动态生成家族的来源证明仍有诅咒守护关联缺口，整体 `complete:false` 保持；主入口数量不代表动态内容、行为和界面均已验收。
- 首项选择新增错误类型及混合选择回归，follow-up 35/35；独立审查确认 Colt、Grimmjow、Kyoka 的首项选择协议问题关闭。Venom 移动中死亡回归也已独立复核关闭。
- 严格三组语料对照本轮 288/289，通过之外的幸运币缺失玩家上下文差异交由修复；记录 `output/red-252/corpus-all-current.log`，不以棋子所属玩家代替缺失输入。
- 框架、Cluster、编辑文档与训练草稿检查 20 个文件共 182 项通过。生产内容字段检查另核对 Cluster 作者元数据的结构和 ID 后排除，原有游戏字段仍完整比较；双尾飞行仅允许用户已批准的完整文案修正，不修改冻结夹具。独立审查未发现该调整掩盖运行时字段。
- 并行修改期间的 `pending-runtime-final.log`、`types-final-round.log` 包含未完成的接口/生成产物错误，不能作为候选通过证据，待来源稳定后重验。编码扫描通过，记录 `encoding-final-round.log`。

### 2026-10-13 动态卡牌模板公开边界

- 新作者入口 `content.materialize-template@2` 接受类型化的 `ref.card-template@1` 模板引用，以及由记录/扩展表达式产生的结构化字段和扩展变量；卡牌标识、名称、说明和展示字段省略项都是可由表达式提供的输入，`fieldsType`/`extensionType` 只作为类型推导参数；它保留既有 v1 的受信模块图校验、内容大小上限和展示字段省略白名单。
- v2 返回值是非空字符串语义的 `card` 定义引用，可直接连接 `author.card.gain@1`；获得手牌入口沿用原有卡牌 ID 边界，不要求作者再写字符串转换或回退逻辑。
- 模板、字段或扩展校验失败发生在动态内容提交前，现有内容不会被写入。真实 host 回归覆盖 `tails-armor-assembly` 与 `rafaam-curse-ward` 模板引用到动态卡牌获得手牌的路径；中央 registry、句式目录和生产数据接线由集成任务负责。
