# RED-238 水门飞雷神锚点目标

用户复现：使用苦无术式，选择友军后，看得到飞雷神地格图标，却无法选中锚点。

基线 main9d1b0c30801cd733ec4cede37ce1ef0889a2313a；依赖 RED237 独立公开预演接口。原教程/AI候选保留且停止推进。

最小状态：8×6地格，水门(1,1)、友军(2,1)，水门合法锚点(4,3)。prepareAction第二步返回该cell；preparePublicSkillAction同状态返回needs-input且candidates空。sanitizePreviewState删除minatoAnchors，而tileEffects仍可见，形成图标与合法候选不一致。

修复计划：预演保留minatoAnchors必要公开字段x/y/sourceId/ownerPlayerId，仍先经过toPublicBattleState的owner可见性过滤。任意额外载荷不复制，不把tileEffects改成合法目标来源；不改锚点创建规则、数值、随机或传送规则。

回归：9项中修复前五项失败（public/canonical候选一致、合法目标完整预演、owner过滤、旧锚点/选中友军占格、正常练习会话提交），四项非法锚点拒绝通过。覆盖其它水门锚点、墙格、占用格、没有锚点；查询不污染原状态。最终正式传送走原权威位移体系，不直接修改棋子坐标。

回退：仅revert本任务与对应生成bundle；无数据迁移。现有玩家对局不操作/刷新。

隔离验证：对相同预演源码的独立副本只加锚点白名单与字段拷贝，九项全通过（包含PracticeSession.human正式提交）。正式集成到RED237接口依赖提交0da1d67cf后，同样先复现五项失败，再修复并跑五个相关suite共59项全通过。普通练习session/worker两个suite11项通过。两个engine重建成功；practice bundle无实质变化。typecheck首次发现新测试缺少union narrowing，补充needs-input检查后通过；ESLint、编码、diff和main-baseline均通过。独立最终审查仍进行中；未宣称人工验收通过。
