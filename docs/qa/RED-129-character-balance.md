# RED-129 批量角色平衡验证证据

日期：2026-08-29
分支：`codex/red-129-character-balance`
基线：`origin/main@44d72960496a0da1068cd6d58b0eb0286188ca82`
初始实现提交：`bea48cc217240b106f69b3f8e99d1ddaa9a50986`
风险：Medium

## 范围与架构边界

- 更新合同列出的 28 名角色数值、技能、卡牌、规则、manifest、文档和源码权威测试。
- `lib/game/**` 只增加通用 pending 伤害入口、状态类型/移除上下文及触发上下文；新增行没有 RED-129 角色或技能 ID 分支。
- 保留最新 main 的通用 `targeting.availability` 数据化实现，没有恢复 Holy Blast、Kagutsuchi 旧 ID 硬编码。
- 删除 `rule-minato-anchor-begin-turn` 及 manifest/AI 语义入口；水门只挂载 end-turn 锚点与飞雷神触发规则。
- `data/pages/js/game-engine.js`、`android-client/www/js/game-engine.js` 未修改或重建；相对 main 的路径差分为空。
- 角色 JSON/SkillCode 在新战斗或内容重载时由源码权威加载，本任务不要求重新构建浏览器/Android engine bundle。
- SkillCode 的 `Math` / `Date` 参数由 `getRuleMath()` / `getRuleDate()` 注入并绑定 RuleRuntime，不直接使用宿主非确定性全局对象。

## 关键规则证据

### 水门

- 只有水门所属玩家的 `endTurn` 产生 mandatory anchor target pending；完成选择后才提交回合结束。
- 其他玩家回合结束不触发；锚点限定 7 格合法空格，最多 3 个，第 4 个清理最早锚点及地格表现。
- 指向型技能先产生 yes/no option pending；“否”或取消保留标记并继续原技能一次。
- “是”按固定种子从目标曼哈顿半径 1 的合法空格选择落点，释放螺旋丸后只移除成为原技能目标单位的标记。
- 无合法落点时不传送、不移除标记，原技能继续一次；普通技能 AP/CD 不在选择前提前结算。
- 固定种子：`129001`（yes/no/cancel 与重复回放落点）、`129010`（无合法落点）、`129011`（水门作为原技能释放者）。

### Pending、弹射物与确定性

- 志志雄无限刃首次 AP=1，二段沿同一 pending continuation 结算，不创建临时 recast 技能且不再次扣 AP；取消、目标死亡、志志雄死亡均有回归断言。
- 黑色月牙天冲命中路径全部敌人一次；首个命中后的落点为二阶段 pending，取消/失败不重复伤害。
- 地狱火霰弹枪经权威 projectile trace 只命中掩体或角色前第一个目标；斜向目标在 beforeSkillUse 前拒绝。
- 复杂技能使用 `rootSeed=1292`，规则交互使用 `rootSeed=129`。拉法姆诅咒在同状态、seed、命令序列下两次得到相同受伤友军和生命数组。
- 纳米激素增伤进入统一伤害上下文，覆盖物理、法术、真实和批量伤害。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `npm.cmd run check:main-baseline` | 通过；Ahead 1 / Behind 0，base `44d7296` |
| RED-129 复杂/数据/规则及冲突相关 10 文件 | 通过：10 files / 123 tests |
| SkillCode runtime、pending、AI、角色与 transport 10 文件 | 通过：10 files / 155 tests |
| 水门旧入口迁移定向测试 | 通过：3 files / 43 tests |
| pending + 方向弹射物源码冒烟 | 通过：3 files / 57 tests |
| 独立审查后加具土命层数上限回归 | 通过：5 files / 40 tests |
| 独立新候选复验 | 通过：1 file / 10 tests；最小重放 finalStacks=4 |
| `npm.cmd test` | 通过：134 files / 1387 tests |
| `npm.cmd run typecheck` | 通过；Next route types 与 `tsc --noEmit` 退出码 0 |
| `npm.cmd run check:encoding` | 通过：766 text files |
| `node scripts/audit-ai-semantics.mjs` | 通过：190 automatic / 59 metadata / 3 evaluator / 1 已知 unsupported / 0 errors |
| `git diff --check` | 通过 |
| changed-file JSON/冲突标记扫描 | 68 JSON 可解析；90 个变更文件无冲突标记 |
| `npm.cmd run lint` | 未通过：ESLint 在读取项目文件前因配置引用 `import/no-anonymous-default-export`、但未加载 `import` 插件而退出 |
| `npm.cmd run ai:self-play:smoke` | 按人工要求中止且不再运行；第 1 局完成 305 动作，第 2 局约 420 动作时中止，没有最终 hard-gate 结果，不记为通过 |

测试生成的 `next-env.d.ts` 改写已恢复；`.tmp-red109` 和 `output/ai-self-play` 临时目录已验证位于隔离工作树内后清理，不纳入提交。

## 范围与风险检查

- 规则与 QA 候选差分 104 个文件、3019 insertions / 769 deletions，全部位于 Linear allowed paths。
- 无依赖、package scripts、存档、经济、数据库、发布或生成 bundle 变更。
- 水门 begin-turn、提里奥 Holy Blast、猎空 Sticky Bomb 旧入口及相应 runtime/manifest 引用已清理；静态审计和全量测试无悬空引用。
- lint 配置问题不在 RED-129 allowed paths，未通过更新依赖或配置绕过。
- AI 自对弈最终 gate 缺失为人工明确豁免；不能据部分运行宣称通过。

## 独立审查与人工验收

- 独立 Medium-risk AI 初审发现加具土命已有层数可能超过 4；修复并新增回归后，新候选复验 Verdict 为通过、无 blocking findings。
- 人工建议重点验证：水门回合末 mandatory anchor UI、飞雷神“否/取消”继续原技能、志志雄二段不扣 AP，以及导入更新角色 JSON 后新建战斗即可生效。
- 本文不代替产品负责人验收、合并或发布。

## 回退

整体 revert RED-129 提交；无数据迁移、存档升级或 bundle 变更。若通用 pending/触发语义回归，优先 revert `lib/game/**` 通用上下文扩展，再按角色恢复数据与测试。
