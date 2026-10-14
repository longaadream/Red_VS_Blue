# RED-252：长句编辑与复杂表达式验收

日期：2026-10-12。范围为本轮中文长句、统一右栏、复杂表达式与作者配置 UI；不代表全量玩法迁移或人工产品验收。

工作分支为 `codex/RED-252-modular-content-graphs`，基线 `origin/main` 为 `082166c6b803b2e838bce5f0f6824c5bbc714dd6`。交付前刷新远端并执行 `npm.cmd run check:main-baseline`，结果 ahead 7 / behind 0。本轮改动仍在本地，尚未同步到已有草案 PR #240。

## 界面证据

参考图为用户选定的第 2 张配置稿，路径记录在 `docs/technical/WORKBENCH_FLAT_SENTENCE_IMPLEMENTATION_PROMPT.md`。桌面截图 viewport 和图片均为 1487×1058、倍率 1；参考与实际图在同一次图片查看中对照。

- [影分身：多选项记录](shadow-clone-options.png)：当前官方内容的两个选项，逐字段编辑，不把引擎限定为二选一。
- [回溯：实例和记录字段](recall-record-fields.png)：棋子引用、位置、计数和实例副本在同一右栏编辑。
- [飞雷神：规则与嵌套条件](guard-cleanup/flying-raijin-relations.png)：最新实际界面已移除作者层存活保护分支；原 `flying-raijin-rule.png` 保留为修正前证据。详见[存活边界修正](guard-cleanup/README.md)。
- [复杂表达式编辑](root-final/fireball-amount-inspector.png)：输入槽继续组合纯表达式，保存后重新打开。
- [受限宽度与折叠](root-final/shadow-clone-narrow-collapsed.png)：在测试中持续限制编辑流宽度为 380px，验证重建后的折叠、水平滚动与焦点；不是把整个窗口改为 380px。
- [窄窗口](root-final/fireball-narrow.png)：整个 viewport 为 760×900，确认保存入口和编辑右栏没有超出窗口。
- [资源包结果](shell/build-result.png)：实际生成本地资源包，未上传或发布。

前三张来自独立的官方内容副本；没有覆盖用户原先打开的项目或其草稿。参考图四条句子是概念示意，真实影分身包括选项、目标与两条执行分支，因此没有删去真实步骤来凑四行。

## 已执行验证

| 命令 | 结果及范围 |
| --- | --- |
| `node tests/electron/sentence-templates.test.mjs` | 11/11；槽位、类型、依赖与中文模板。 |
| `npx.cmd vitest run tests/game/atomic-author-samples.test.ts tests/game/atomic-author-integration.test.ts tests/game/atomic-natural-success.test.ts --maxWorkers=1` | 3 文件、23/23；四个作者样例、自然结束及新增 6 种失效棋子情形。 |
| `node tests/electron/studio-shell-smoke.mjs` | 通过；棋子、能力组、单参数、撤销重做、保存重开、状态图标、跨文档所属、资源包。环境变量 `RVB_STUDIO_SHELL_EVIDENCE_DIR=docs/qa/RED-252-flat-sentence/shell`。 |
| `node tests/electron/sentence-editor-smoke.mjs` | 通过，包含 extension 自定义访问、结构类型与保存重开；设置 `RVB_SENTENCE_EDITOR_SKIP_TRIAL=1`，未在此用例打开游戏训练窗口。截图在 `editor-full/`。 |
| `node tests/electron/sentence-flat-ui-smoke.mjs` | 实际 Electron 6/6，另含 760×900 窄窗口检查；嵌套表达式保存重开、分支引用父级表达式、影分身折叠与横向滚动、键盘返回、extension 声明和右栏滚动。机器结果在 `root-final/sentence-flat-ui-smoke.json`。 |
| `node tests/electron/sentence-authoring-completion.test.mjs` | 实际 Electron 通过；记录、集合、组合、续接、多入口无效草稿与修复后保存。结果复制到本目录 `sentence-authoring-completion.json`。 |
| `node --test tests/electron/sentence-lexical-scope.test.mjs` | 5/5；父级来源插入位置、组合和续接同名隔离、复杂算式括号摘要。此项是辅助逻辑回归，不代替真实 UI 操作。 |
| `npx.cmd eslint electron-editor/ui/sentence-editor.js electron-editor/ui/sentence-templates.js electron-editor/ui/studio-shell.js electron-editor/ui/skill-cluster-editor.js --max-warnings 0` | 通过。 |
| `npx.cmd tsc --noEmit -p electron-editor/tsconfig.json` | 通过。 |
| `npm.cmd run check:encoding` | 通过，1806 个文本文件。 |
| `git diff --check -- <本轮文件>` | 通过。 |

独立源码复核关闭了稳定表达式目标、记录字段显示、焦点返回、滚动保存、普通引用内联和词法作用域定位问题。独立图不会沿分支父链越界查找同名节点。最后的滚动修复和测试类型修正也通过独立有界审查；审查者未重复运行 Electron，窗口结果来自上述实际运行记录。

## 历史失败与适配

`shell/studio-shell-smoke.failure.json` 和 `shell/smoke-failure.png` 是修复前的历史失败，保留用于定位。最终结果为 `shell/studio-shell-smoke.json` 的 `passed: true`。修复的是测试夹具与导航：为文本关联测试补独立文本节点，显式打开状态成员，按实际资源包阶段操作；没有修改业务快照或删减业务断言。

旧 editor smoke 在新建条件后留下未保存草稿，随后切到 extension 文档触发原生丢弃确认框，造成 CDP 超时。改为切换前保存该有效草稿，包含 extension 的用例已通过。flat smoke 在断言失败后立即退出，避免未保存的失败夹具触发第二个确认框，原始错误与断言继续保留。

`scroll-before-fix.json` 保留右栏新增端口时滚动归零的失败证据。修复在宿主重建编辑容器之前捕获滚动、更新后恢复，最终验证保持 3902px。随后发现测试将 extension 读取类型改为记录，却让依赖写入仍要求数值；通过实际控件同步修改写入类型后保存成功，没有放宽类型检查。

## 边界与回退

- 未改变运行时选择的取消语义；“上一步”“跳过此步”“取消释放”仍需分别定义，不能互相代替。
- 纯显示内联不删除作者 AST，也不移动随机、选择或副作用语句。后续用户指出存活保护仍冗余，本轮已从作者图删除，并由引擎输入边界负责；真实玩法分支保留。
- 自定义字段和现有定义 ID 仍保留原名称；部分复杂旧作者图仍有较多中间语句。这些图使用统一编辑器，不代表其全部文案已达到示意稿的简洁程度。
- 没有运行全游戏测试，本轮证据不覆盖全部历史引擎问题，也不覆盖发布流程。
- 回退仅还原本轮 UI、文档与测试差异，保留 RED-252 此前工作；本轮初始 UI 副本在 `output/playwright/flat-sentence-baseline/`。

建议人工从影分身选项、回溯记录字段、飞雷神分支依次尝试：修改单个参数，进入子表达式后返回，保存并重开；最后检查资源包结果。相关任务：[RED-252](https://linear.app/redvsblue/issue/RED-252)，已有草案 [PR #240](https://github.com/longaadream/Red_VS_Blue/pull/240)。
