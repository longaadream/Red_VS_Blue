# RED-252 最终候选证据

基线：`origin/main`，`082166c6b803b2e838bce5f0f6824c5bbc714dd6`。普通对局闭包为范围；冒险排除。下列结果来自实际进程退出及报告，未合并、未对外发布。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 全部 skill-graph、普通技能/卡牌/规则 corpus、captured damage、summon batch、flow、三个 effect-batch 文件 | 1062/1062，退出 0 | completion-final-parser-integration.json |
| 完整资源包：导入、接受五项作者修改、生成、安装、真实加载运行、补丁、重启、回退、篡改拒绝 | 1/1，251.535 秒，退出 0 | completion-author-pack-latest.json |
| Windows 包/配置目录有限重命名重试 | 31/31 | completion-final-installer-tests.json |
| 句式、作用域、模块版本、类型和移动标签 | 42/42，退出 0 | completion-final-sentence-unit.log |
| 生成目录与源码目录一致 | 2/2，退出 0 | completion-final-catalog-parity.log |
| 完整 typecheck | 退出 0 | completion-final-typecheck-after-fixture.log |
| 本批接口与声明 ESLint | 两组均退出 0 | completion-final-integration-lint.log / completion-final-declaration-lint.log |
| editor worker bundle、editor tsc、game engine build | 均退出 0 | completion-final-editor-bundle.log / completion-final-editor-tsc.log / completion-final-engine-build.log |
| 主线基线 | ahead 8、behind 0（最终实现提交前） | completion-final-main-baseline.log |
| CI 后续模块/表达式回归 | 92/92，退出 0 | completion-ci-cleanup-core-tests.json |
| CI 后续测试类型清理回归 | 36/36，退出 0 | completion-ci-cleanup-test-fixtures.json |
| CI 后续目录一致性与完整类型检查 | 2/2；typecheck 退出 0 | completion-ci-cleanup-parity.log / completion-ci-cleanup-typecheck.log |
| CI 后续全目录 lint | 退出 0，仅命令行排除两份原有未跟踪临时文件 | completion-ci-cleanup-pr-lint.log |

核心整合命令：

首次候选 CI 的 56 项 ESLint 失败原日志为 `completion-ci-eslint-failure.log`。修正只删除未用定义、标注纯派生计算并补齐测试类型；独立核对公开导出及 774 项目录完全一致。首次本地 `npm.cmd run lint` 还扫描到原有未跟踪临时文件，结果保留为 `completion-ci-cleanup-full-lint.log`，不算通过。最终全目录命令是 `npm.cmd run lint -- --ignore-pattern temp-flying-effect.js --ignore-pattern temp-flying-graph.js`；没有改动文件或 ESLint 配置，线上继续原始命令。最终 CI 结果见 PR #240。

```powershell
node node_modules/vitest/vitest.mjs run tests/skill-graph tests/game/content-graph-corpus.test.ts tests/game/content-graph-card-rule-corpus.test.ts tests/game/author-captured-damage.test.ts tests/game/author-summon-batch.test.ts tests/game/flow-runtime.test.ts tests/game/effect-batch-core.test.ts tests/game/effect-batch-trigger-context.test.ts tests/game/effect-batch-content-migrations.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run tests/content-pipeline/script-pack-release.test.ts --maxWorkers=1
node tests/electron/sentence-authoring-completion.test.mjs
node tests/electron/sentence-flat-ui-smoke.mjs
npm.cmd run typecheck
```

真实工作台使用隔离临时项目。13/13 扁平场景见 `../../RED-252-flat-sentence/sentence-flat-ui-smoke.json`；空白编写、召唤声明错误保存拒绝及修复后重开见 `../../RED-252-studio-v2/sentence-authoring-completion.json`。没有访问用户被拒绝的浏览器页面。影分身范围 5→6 的图、选区、说明保存重开已核验；资源包测试从安装目录真实加载该技能并验证 6 格候选。

独立审查：目标绑定 11 项通过；捕获伤害/实例清理 44 项通过；召唤模块/迁移 8 项通过；共享声明解析与文档 9 项通过。曾发现的实例错认、目标同步误拦无关修改、UI 写回遗漏及无效声明仍可保存均经修复和复审关闭。纯声明解析不授予运行权限，认证仍由权威宿主完成。

验证边界：普通结构闭包 45 棋子、347 内容节点、276 代码文档/360 入口；结构审计保留不可达目录和冻结基线例外，不宣称 `overallComplete`。55 条兼容组合路线有 10 个语义族的 17 个 suite/250 个通过断言作为代表证据，未逐路线全量差分；16 条具体组合的 128 个小状态中 119 个精确一致，9 个为已批准的无效依赖/空选择/认证边界。各报告测试有重叠，不合并计数。

最近完整 game 为 3742 项、3691 通过、51 失败：40 项有准确基线复现，另 11 项已有修复/批准契约更正和定向通过。完整报告仍不称全绿，见 completion-remaining-failure-classification.json 和 completion-remaining-failure-field-proof.json。不通过放宽超时、替换失败快照或修改随机算法获得通过。
