# RED-252：全工作台 UI 初版第二轮

日期：2026-10-12。任务：[RED-252](https://linear.app/redvsblue/issue/RED-252)，草案 PR [#240](https://github.com/longaadream/Red_VS_Blue/pull/240)。

后续普通内容迁移、复杂语句编辑和故障隔离的最新范围与测试见[兼容补全记录](authoring-completion.md)。本文保留 UI 初版验收边界，不作为最新引擎迁移进度。

## 范围与验收边界

用户要求重做棋子、技能、卡牌、规则、素材及打包流程。Skill 表示主动技能，技能目录的编辑单位是 Cluster；Rule 可构成独立被动能力。Cluster 可包含 Skill、Rule、StatusTag、Card 与所属对象的 extension。状态不设顶层目录，仍须能在能力组内编辑图标与定义。

这轮 UI 初版复用现有文档会话、版本检查、模块编译器和本地资源包生成管线；不改变战斗结算、数值、包格式或随机算法。不能据此宣称全部新版引擎接口、所有技能迁移、运行时复制/偷取能力均已完成。

基线：`base_branch: main`，`base_sha: 082166c6b803b2e838bce5f0f6824c5bbc714dd6`。本轮已刷新远端；基线检查通过，behind 0。保留工作树原有未提交成果。

## 必须核验的操作

1. 所有主目录可进入；列表、搜索、内容上下文、保存状态和返回操作一致。
2. 技能菜单能进入独立 Rule 被动 Cluster；没有为被动虚构主动 Skill。
3. 同一 Cluster 的不同类型成员能展开编辑；状态没有独立顶层导航。
4. 跨文档状态编辑修改实际所有者，保存重开后图标和未知 extension 字段保留。
5. 成员引用的共享关系不会因编辑器展示而重复注册或改变运行行为。
6. 嵌套纯表达式能通过 UI 构造、编辑和保存，类型和作用域校验仍由共享编译器负责。
7. 控制结构内部编辑保留顺序与作用域；不能以能显示循环作为能编辑循环的证据。
8. 卡牌与 Rule 的属性和效果可编辑保存，既有未知字段保留。
9. 素材列表与预览使用真实资源，导入/替换沿用现有校验。
10. 打包主流程从已保存内容生成真实 `.rvbpack`；任一脏草稿阻止静默打包旧内容。
11. 生成成功、失败诊断和输出位置可见；生成不等同于上传发布。
12. 1487×1058 和 1100×800 截图检查布局、文字、控件可见性及横向溢出。

## 验证记录

- 修改前相关基线：`npx.cmd vitest run tests/skill-graph/module-cluster.test.ts tests/electron/editor-workspace.test.ts --maxWorkers=1`，23/23 通过。
- Cluster、结构化模块、工作区和管线：`npx.cmd vitest run tests/skill-graph/module-cluster.test.ts tests/skill-graph/module-structured.test.ts tests/electron/editor-workspace.test.ts tests/electron/editor-content-pipeline.test.ts --maxWorkers=1`，60/60 通过。
- 内容项目素材回归：`npx.cmd vitest run tests/electron/content-project.test.ts --maxWorkers=1`，9/9 通过。新增的 public 根目录立绘用例修复前因缺少图片失败；修复后通过，同时验证 images 目录同名素材优先、无关 JSON 不被复制。
- 构建：`npm.cmd run build:content-pipeline:editor-bundle`、`node scripts/build-skill-graph.mjs`、`npx.cmd tsc -p electron-editor/tsconfig.json --pretty false` 通过。
- renderer JavaScript/HTML 内联脚本语法检查、相关 ESLint 和 `git diff --check` 通过；最新基线检查仍为 behind 0 / ahead 7。
- 桌面操作：`node tests/electron/studio-workbench-v2-smoke.mjs`。最新完整结果见 [机器记录](studio-workbench-v2-smoke.json)，截图和实际 `.rvbpack` 同目录保存。早期 `.failure.json` 只记录修复前的失败，不代表最终结果。
- 独立验证者没有修改实现源码；发现复制表达式仍保留旧 owner 元数据，已由实现者修复，并加入复制后保存重开的操作回归。独立审查者专用 agent 因并发线程数量上限未能启动，使用本轮未参与实现的验证 agent 完成审查。
- 真实内容另外载入独立官方副本，检查鸣人立绘与能力列表；见 [真实内容截图](v2-real-naruto.png)。内容副本只用于本机验收，未发布。
- 跨文档保存回归曾复现未打开成员缺少文件版本号的问题：能力组菜单项不能代替实际文件记录。已改为从原始文档列表读取版本号，版本冲突保护保持生效；同一操作的保存和重开检查通过。
- 长效果列表重建时保留滚动位置，展开输入编辑后滚动到当前参数。最新 [表达式截图](v2-expression-selected.png) 和机器记录中的边界坐标确认编辑器实际位于视口内；不是只检查 DOM 中存在。表达式树复制、单独表达式复制和新建被动操作均通过。
- 保存全部只显示汇总成功通知；通知去重且最多显示三条，避免批量操作遮住结果区域。失败信息仍显示在对应编辑器或打包结果中。
- 首次编辑没有 Cluster 元数据的根文档时，初始化空 `links`，修复保存校验失败。实际操作验证分组改名、保存和重开，同时确认根成员名称没有被更改；`clusterGroupMetadataVerified: true`。

## 已知边界

- 本文记录 UI 初版；后续普通内容语义迁移及完整兼容验证以[兼容补全记录](authoring-completion.md)为准。普通内容现有 373 个语义入口已迁移，不能据此推断冒险专用或未来设计接口也已实现。导入没有结构化图的外部旧代码仍明确提示边界。
- 历史被动仍有存储在 Skill 文档中的兼容内容，界面明确标记“被动入口（兼容）”；新建被动直接建立 Rule，不改写旧定义的存储类别或执行规则。真实 `naruto-vanguard` 已加入 Electron 标签回归。
- 复合、续接、结构记录、集合及多入口现已支持在效果编辑区编辑，验证见补全记录。表达式选择按注册接口、输入类型及当前作用域过滤；设计手册和当前实际注册接口目录仍分别记录。
- 训练场沿用单独窗口；工作台内嵌完整训练场尚未实现。
- 主流程检查了素材列表/预览、图标保存和包内真实图片；操作系统原生导入对话框未自动化验证。
- 自动操作记录中的 Electron sandbox preload 噪声单列保存，未当作业务错误隐藏；内容 IPC、保存和资源包生成均已实际执行。未发现 renderer 业务异常或协议日志错误。
- 本轮未合并、发布，也未把已有工作树的其他未提交修改混入提交。风险等级 Medium；等待人工体验验收。

作者操作见 [工作台说明](../../technical/WORKBENCH_UI_GUIDE.md)。设计对照记录见仓库根目录 `design-qa.md`。

## 回退

只撤回本轮作者 UI、Cluster 作者适配和相关测试/文档。保留原权威引擎、用户项目、原有未提交内容及既有包文件；不得以整目录覆盖回退。模块浏览器产物从对应源码重新构建。
