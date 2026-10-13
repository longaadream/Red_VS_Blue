# RED-252 工作台首版验收记录

日期：2026-10-12。范围为已批准的浅色工作台首版与作者语句说明书；不是全量新版引擎迁移完成报告。当前改动保留在本地 `codex/RED-252-modular-content-graphs`，尚未提交本批改动、合并或发布。

## 本批结果

- 默认棋子入口，棋子属性、能力列表、技能句式编辑、原位表达式与右侧预览采用统一白蓝界面。技能不新增或显示美术图标。
- 状态目录投影已有源定义，图标选择写回真正所属文档；不引入第二份状态数据库。状态图标编辑可保存、重新打开，保留扩展字段。
- 顶部保存、撤销、重做连接真实文档草稿。高级代码/图编辑入口保留，首版并不代表所有复杂作者语句均可无代码编辑。
- 资源包入口调用当前项目已有生成管线，包含已保存的 JSON 和图片；未保存草稿会阻止打包。生成本地资源包不等于发布。
- [作者语句手册](../../technical/AUTHOR_STATEMENT_MANUAL.md)逐项讲解用途、参数、结果、边界与示例；[参考索引](../../technical/AUTHOR_STATEMENT_REFERENCE.md)提供分类与来源。设计确认与实际运行支持分开说明。

## 验证

- `git fetch origin --prune`、`npm.cmd run check:main-baseline`：通过，origin/main 为 `082166c6b803b2e838bce5f0f6824c5bbc714dd6`，behind 0；工作树包含此前未提交工作，本批未覆盖它们。
- `npx.cmd tsc -p electron-editor/tsconfig.json`：通过。
- 本批三个界面 JS 与图标构建脚本的 targeted ESLint、内联脚本语法检查及 `git diff --check`：通过。
- `tests/electron/sentence-editor-smoke.mjs`：按已批准的无技能插画界面修订可见文本断言后，真实 Electron 验证通过；倍率、保存、试用断言保留，截图在 [simple](simple/)。
- 说明书本地链接、显式/标题锚点与代码块配对检查通过，见 [文档检查](manual-validation.json)。
- `npx.cmd vitest run tests/skill-graph/module-cluster.test.ts tests/electron/editor-workspace.test.ts --maxWorkers=1`：23/23 通过。
- 连同 `tests/electron/editor-content-pipeline.test.ts` 的一轮检查：32 通过、2 失败。两项失败为旧源码字符串断言；对应字符串在本轮修改前的工作区备份也已不存在。见 [对照证据](preexisting-source-assertions.json)。这不是干净 main 全套基线测试，不宣称全测试通过，也未为通过而改断言。
- 真实 Electron 验证与截图由 `node tests/electron/studio-shell-smoke.mjs` 生成，详细结果见 [结果 JSON](studio-shell-smoke.json)。测试使用隔离临时内容项目；图片为确定性测试素材，不冒充正式美术资源。
- 最终补测规则所属状态的独立编辑器：修改立即显示、顶栏撤销/重做、保存、从状态目录重开均通过（`standaloneRuleStatusUndoRedoSaveReopen: true`）。生成包包含该规则文件及新图标。
- 独立代码审查发现的状态所属文件、常量输入、撤销后各编辑视图刷新及独立状态编辑器生命周期问题均已修复。文档另外核对状态选择器的取消边界。

## 视觉核对与限制

已将实际 1487×1058 截图与批准稿同时查看，修正重复标题、多层灰框、表达式按钮挤压及被旧样式隐藏的保存栏。保留白蓝色、导航/内容列表/编辑区/预览的层级；遵照后续要求去除技能插画，采用仓库真实品牌图。首版仍有与示意稿的细节差异，不宣称逐像素一致。

状态 `iconPath` 的保存与打包在本批范围内；所有对局表现端对自定义图标的最终渲染仍需单独回归。此前基于“已接受快照”的发布流程与当前保存项目打包是不同入口，本批未改发布语义。

用户追加的“语句有问题记录并跳过、游戏不得卡死”已经写入公共接口、目录、手册、实施提示词和任务合同，并列出故障注入验收场景。本批未修改全局运行调度器，尚未运行这些全引擎故障场景，不能将这条可靠性目标报告为已全面实现。

旧 `*-early.png` 和 `studio-shell-smoke.failure.json` 是定位问题时的中间证据；最终验收以成功结果 JSON 和不带 early 的最新截图为准。

## 人工体验步骤

1. 在本工作树执行 `npm.cmd run dev:electron:editor`，选择或导入一个测试资源项目。
2. 从棋子打开技能，点击蓝色范围/倍率参数，修改后撤销、重做、保存，再重新打开核对。
3. 从状态目录选中一个可编辑状态，设置素材图标，保存并重新打开；核对修改的是其来源文档。
4. 保存后点击“生成资源包”，检查名称、版本、输出位置和成功结果；不执行发布。
5. 按说明书选择一个简单效果组合，分别记录能否编辑、能否保存、训练结算是否符合规则，勿把三者混为已完成。

回退仅撤回本批界面、测试和新增说明书改动，保留用户内容项目、已有未提交引擎工作与原资源包管线。

关联：[RED-252](https://linear.app/redvsblue/issue/RED-252)；已有草案 [PR #240](https://github.com/longaadream/Red_VS_Blue/pull/240)，本批尚未推送。
