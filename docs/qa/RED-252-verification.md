# RED-252 验证记录

当前状态：已实现语义模块引擎底座及首批五个生产入口；完整普通对局迁移仍未完成，RED-252 保持开发中、PR #240 保持草案。下方 v1 历史数据只证明兼容性。边界见 [统一玩法模块说明书](../technical/GAMEPLAY_MODULE_CONTRACT.md)。

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
