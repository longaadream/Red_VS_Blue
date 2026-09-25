# RED-215：多段伤害首段击杀兼容

- 合同：[RED-215](https://linear.app/redvsblue/issue/RED-215)。风险：Medium。
- `base_branch`: `main`。
- `base_sha`: `bc76ce78e9014f50e5ef1ea445895de8979b0ea1`（2026-09-25 显式刷新 `origin/main`）。
- 候选依赖：RED-214 `ad69510461100106716861a878108eb7f0c11dd9`。分支从上述 main 创建后整合候选依赖；不覆盖已冻结的 0.1.12 安装包。

## 原始问题

阿方与一个 2 HP、0 防御且无护盾的敌人相邻，使用现有「龙骧虎步」。脚本先造成 2 点伤害，随后仍向同一个目标引用造成追加伤害。第一次伤害正常完成死亡流程，第二次顶层 `dealDamage` 却抛出 `RVB_DAMAGE_TARGET_UNAVAILABLE`。权威动作的预演校验因此拒绝整次技能。

这影响保留目标引用并继续伤害该目标的多段代码；重新检查存活状态或重新选择目标的技能不一定受影响。

## 批准范围

仅调整引擎对同一动作中已正式死亡目标的后续伤害处理，不修改 SkillCode JSON 或要求作者使用新接口。保留每段伤害的独立结算、护盾、触发器和死亡时序。

同步调用仅对本动作已经正式完成死亡结算的原目标引用允许后续伤害跳过。返回完整的零伤害结果，不重复受伤、死亡或击杀收益。同步调用中的旧动作尸体、伪造引用，以及非法参数和非法重入仍报错；真正失败仍回滚整个动作。已有队列的失效目标过滤保留，避免附带改变连锁伤害行为。死亡记录仅属于瞬态效果链，不写入存档或网络协议。

## 人工复验

1. 使用包含本次引擎修改的客户端／服务器，资源仍使用现有阿方技能。
2. 阿方与 2 HP、0 防御、无护盾敌人相邻，使用龙骧虎步：技能成功，敌人只死亡一次，行动点和冷却只结算一次。
3. 换为足够生命的相邻敌人：两段伤害都正常执行。
4. 换为非相邻目标：仍只有第一段伤害；再检查带护盾的目标仍按每段结算。

## 自动验证（2026-09-25）

- 修复前最小回归失败：`npx.cmd vitest run tests/game/red215-multihit.test.ts --maxWorkers=1`，seed `215`。底层 `RVB_DAMAGE_TARGET_UNAVAILABLE`，权威包装为 `RVB_EFFECT_CHAIN_STATE_INVALID`。
- 修复后 13 个文件、265 项通过：RED-215 两个测试文件，`damage-pipeline`、`effect-chain-transaction`、`summon-death-batch`、`effect-batch-core`、`effect-batch-trigger-context`、`effect-batch-content-migrations`、`alfonso-roster`、`venom-skills`、`red213-meteor-belt`、`red213-meteor-content`、`battle-room-effect-chain`（均位于 `tests/game`，命令 `npx.cmd vitest run <这些 .test.ts 文件> --maxWorkers=1`）。包含真实 Colyseus 房间的拒绝／状态提交边界。
- 审查后另补正式巫妖誓约复活组合回归：旧引用追加伤害跳过，新实体 HP 保持 40；边界文件重新运行 20/20 通过。共覆盖 266 个通过的用例。
- 阿方原始 SkillCode 通过真实 `runBattleAction`，验证 AP/CD 各一次、墓地单条、实际伤害日志一次；同 seed 重放 state hash 一致。后续 NaN 伤害仍导致整次动作失败，原状态 hash、HP、墓地、AP 不变。
- `npm.cmd run typecheck`、受影响 TypeScript 文件 ESLint、`npm.cmd run check:main-baseline` 通过。GitHub 直连曾失败，使用系统已配置的代理后成功刷新并验证 main。
- `npm.cmd run build:game-engine` 和 `npm.cmd run build:colyseus` 通过。三个受跟踪浏览器引擎 bundle 同步更新；Android 镜像与本地 Colyseus bundle 也已生成。
- 独立 Astra 审查无阻断发现，独立运行 5 文件 102/102 通过；其提出的正式复活组合测试已补充通过。
- 与依赖提交相比 `data/skills`、`data/pieces`、`data/rules` 无差异。没有新增 SkillCode 规范、存档字段或依赖。
- 本地原始测试及构建日志保留在 `dist/RED-215/`。本次没有重新打包或人工验收 Electron 安装包，也没有部署服务器。

## 交付与回退

只更新资源包不能让旧引擎获得本修复。现有 0.1.12 验收安装包未被本源码修改自动更新；需要重新构建客户端及权威服务器后验收。回退本任务代码提交及对应生成引擎，资源内容无需回退。

## 用户验收发现的入口遗漏（第二轮）

用户使用首轮 `9a860f38d` 客户端在训练营再次复现：`alfonso-kick` 对 `training-red-2` 首段击杀后，第二段报 `Damage target training-red-2 is not an active living piece`，上下文 `rootSeed: null`。首轮测试和教学模式启动冒烟不足以证明训练营技能执行正确。

训练营的 `trainingApiFetch('PUT')` 使用 `applyBattleAction`；教学指定课程与服务器使用 `runBattleAction`。此前只有后者建立动作级 EffectChain，直接归约时每次伤害各自使用短生命周期 detached chain，第二段无法看到第一段正式死亡记录。这是同一问题的遗漏入口，而非资源脚本需要再增加判断。

第二轮要求保留原始技能 JSON，覆盖直接归约、独立目标预检、链清理及后续非法伤害回滚，并用实际打包客户端的训练营路径复验首段击杀与非致命两段。新候选产物另存 `output/RED-215-r2`，首轮产物保留用于对照和回退；构建不等于人工验收或服务器部署。

第二轮源代码验证：

- 新增直接 `applyBattleAction` 回归先失败：原始阿方 JSON，2 HP 相邻目标，错误包含 `rootSeed: null` 和 `not an active living piece`，与用户截图相同。修复前证据：`dist/RED-215-r2/direct-apply-before-fix.log`。
- 公共入口在没有链时建立临时 detached chain，沿用既有内容查找与错误语义；已有权威链复用。临时链用 `withEffectChain` 清理所有克隆绑定。独立预检当前仅做结构和目标检查，原本即通过，不改变该接口语义。
- 扩大运行 `npx.cmd vitest run tests/game --maxWorkers=1`：135 文件，1470 项通过、38 项失败。另建只读基线检出 `9a860f38d`，重跑全部 19 个失败文件，得到相同 38 项失败（238 项通过）；逐项失败标题一致。失败涉及已有内容清单、界面约定、角色旧断言等，未修改快照或放宽断言。本轮不得描述为全库测试通过。
- 独立审查指出 direct reducer 使用活动 RuleRuntime 时，事务会切换 replay runtime，因此 batch ID 回调必须在执行时读取活动 runtime，不能捕获外层 runtime；已纳入修复及连续动作回归。
- 最终相关 14 文件、300 项通过，包含多段伤害、原技能、伤害/死亡管线、权威房间、pending 交互和回滚。连续两次直接动作在同一个 RuleRuntime 中生成 4 个不同伤害 batch ID，游标推进至 4。独立审查确认 callback 修正后无其他阻断；TypeScript、ESLint 检查通过，浏览器引擎重新生成。
- 第二轮原始日志保存于 `dist/RED-215-r2/`。正式线上服务器是否已升级需以部署产物为准，本任务没有执行远程部署。
