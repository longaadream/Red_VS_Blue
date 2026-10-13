# RED-252：移除作者层存活保护分支

日期：2026-10-12。用户指出“读取棋子存活”仍是多余 fallback；此前把它归入必要玩法条件的判断不正确。本轮修正作者图与引擎输入边界，未把检查换成隐藏的作者语句。

## 修改

- 飞雷神作者图删除 `minato-alive`、`marked-alive`、`source-alive` 三处读取及关联布尔组合；敌我关系直接使用标准关系查询。
- 可信模块描述符声明哪些棋子输入需要存活。引擎在执行模块前检查引用仍在场且生命大于零，失效结果沿依赖传播；条件失效时两个分支都跳过，后续无关语句继续。
- `query.same-relation@2` 使用此边界；旧版 `@1` 保留历史信息查询语义，省略版本仍解析旧版。没有全局改变死亡事件、状态来源或历史位置读取。
- 编辑器新增模块时完整保留选择的版本；旧节点按存储版本重开。修复了目录显示标准 v2、实际新增却取到兼容 v1 的问题。
- 生产规则 JSON 只重生成该规则的模块图与派生代码，校验其他字段不变。没有覆盖用户项目或旧资源包。

## 行为证据

最小场景使用真实 `createFlowRuntime` 和种子 594，分别使持有者、标记者、友方分支中的事件来源生命归零但留在场上，或从场上移除，共 6 种情形。均不弹选择、不移动、不增加攻击、不推进技能随机流；图末尾无关的玩家 extension 写入仍完成。

同时保留并验证：标记者为敌方时，无关的事件来源已死亡仍可触发。真实玩法条件（阵营、标记来源、事件排除、落点候选和传送成功后攻击）未删除。

| 验证 | 结果 |
| --- | --- |
| `npx.cmd vitest run tests/skill-graph --maxWorkers=1` | 引擎实现代理执行，23 文件、208 项通过。 |
| `npx.cmd vitest run tests/game/atomic-author-samples.test.ts tests/game/atomic-author-integration.test.ts tests/game/atomic-natural-success.test.ts --maxWorkers=1` | 集成者执行，3 文件、23 项通过。 |
| 编译器、注册表、作者样例、运行时集成独立复核 | 审查代理独立执行 4 文件、52 项通过；修复编辑器丢版本后另复核 1 项版本回归，代码审查通过。真实 UI 证据另记。 |
| `node --test tests/electron/sentence-module-version.test.mjs tests/electron/sentence-lexical-scope.test.mjs` | 6 项通过；版本选择、旧版本读取、作用域及复杂表达式摘要。 |
| `node tests/electron/sentence-flat-ui-smoke.mjs` | 实际 Electron 7/7；目录选中 v2、新增、IPC 保存、重开仍 v2，同一文档中的旧 v1 保持不变；另覆盖既有复杂表达式与扁平编辑流程。证据目录环境变量为 `RVB_FLAT_SENTENCE_UI_EVIDENCE_DIR=docs/qa/RED-252-flat-sentence/guard-cleanup/editor`。 |
| `npx.cmd tsc --noEmit` | 通过。 |
| `npx.cmd tsc --noEmit -p electron-editor/tsconfig.json` | 通过。 |
| 相关引擎、迁移脚本、回归测试 ESLint | 通过。 |
| `node scripts/build-skill-graph.mjs` 与 `npm.cmd run build:content-pipeline:editor-bundle` | 通过，生成浏览器及 Node 使用的同一模块实现。 |
| `npm.cmd run check:main-baseline` / `npm.cmd run check:encoding` / `git diff --check` | 通过；基线 ahead 7 / behind 0，编码检查 1807 个文本文件。 |

[实际工作台首屏](flying-raijin.png)、[关系分支](flying-raijin-relations.png)：独立临时项目加载生产规则；检查全部规则正文无存活读取，随后截取实际 Electron 页面。此次 viewport/PNG 为 1440×1024，非旧版截图的 1487×1058。没有使用截图证明运行时行为，运行时由上述测试验证。

新增版本用例首次保存被校验拒绝：测试副本修改了技能 ID，却沿用火球的 Cluster ID。修正夹具自身的 Cluster ID 后，原保存、重开、旧版本和未知字段断言全部通过；没有删除断言或放宽生产校验。最终 [机器报告](editor/sentence-flat-ui-smoke.json) 为 `ok: true`、`failureCount: 0`。

## 范围与回退

这不代表全仓库作者图均已清理。四类原子样例（火球、影分身、回溯、飞雷神）禁止重新引入纯存在性和存活保护节点；其他历史图尚不在本轮范围。现有飞雷神状态层数的缺省值仍沿用基线语义，没有趁此变更游戏数值。

高风险来自共享编译器和版本解析；以显式版本隔离旧内容，并提供失效传播、宿主缺失、版本默认值和保存兼容回归。回退须撤回本轮存活元数据、v2 查询、作者图及编辑器版本选择的配套变更，恢复原规则图；不能只回退引擎而留下 v2 作者图，也不能整文件覆盖 RED-252 先前改动。

本轮仍是本地改动，未推送到 [PR #240](https://github.com/longaadream/Red_VS_Blue/pull/240)，未发布。任务：[RED-252](https://linear.app/redvsblue/issue/RED-252)。
