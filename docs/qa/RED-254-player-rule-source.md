# RED-254 玩家规则伤害归属回归

风险 Medium；base_branch `main`，base_sha `00df31f8bd35b34200d507fd83853bf5ac99ba94`。范围仅三条规则、鼬天照来源记录、历史来源标题和直接测试/文档。不改变伤害、叠层、触发顺序、随机算法、存档格式、通用伤害管线或经济规则。

## 最小复现与根因

旧天照灼烧没有 sourcePieceId 时，取第一个存活同 owner 棋子；有来源 ID 时还会取墓地中的死来源。毒素陷阱在源死亡后也选任意友军，并可能回退受害者。鼬技能未记录来源，加剧了天照问题。

最小 fixture：当前玩家 player-blue，红方任意友军 red-ally，蓝方受害者 10 HP、天照一层，player-red 挂真实 rule-sasuke-amaterasu-damage。派发 endTurn，受害者损失 2 HP，但旧日志的 damageSource 为 red-ally/piece，应为 player-red/player。

`npm.cmd test -- tests/game/red254-player-rule-source.test.ts --maxWorkers=1` 修复前 1 项失败；原始报告 `output/RED254/before-rule-attribution.json`。历史响应标题用例先失败，修复后通过。

## 验证结果

- 新增真实规则/技能回归 10 项通过：两条天照规则的 live/dead/missing/legacy 来源、友军顺序和无友军、毒素 live/dead/missing 来源及精确消耗、无关友军被动不触发、玩家 CP 不额外增长且核心受害者正常产生结晶、鼬真实技能写来源后由棋子转为玩家、固定 seed 重复日志一致。
- 历史 UI 模块 21 项通过；使用原模块的 VM/轻量 DOM 夹具，不声称完整 Electron 实战。
- 扩展 8 文件 121 项：120 通过、1 既有失败。失败为 ichigo-itachi 数据合同中旧一护技能冷却期望；相关一护数据未修改。在基于同一 main 的 Naruto 工作树（只有独立 UI 修复）重复原用例得到同样失败，报告 `output/RED254/baseline-ichigo-contract.json`。未改无关数值或放宽该断言。
- 原始扩展报告 `output/RED254/targeted-results.json`。
- typecheck、定向 ESLint、编码和 whitespace 检查通过；基线检查从 freshly fetched main 创建后通过。
- 原计划的实现/审查代理调度遇线程上限；复用实现代理贡献失败 fixture 和四个内容脚本修改，root 在停止其写入后完成剩余测试、UI 与文档。由另一未参与实现的代理独立审查，不冒充原计划 Astra 角色。

## 人工验收

1. 用鼬或佐助释放天照，再结束受害者回合：释放者活着时归原棋子。
2. 杀死释放者，保留至少两枚友方棋子，再次触发灼烧：历史归玩家，不归任意友军；伤害数值/叠层按原规则。
3. 无存活友军或旧存档没有来源 ID 时，持续效果仍由所属玩家造成伤害。
4. 黑寡妇放毒素后死亡，再让敌人位移到陷阱：仍造成原伤害、消耗该陷阱，归玩家。
5. 展开历史中玩家规则的响应标题，确认玩家名称不为空，不展示其他棋子头像。

## 限制与回退

未验证完整客户端体验，不代替人工验收。未合并、发布资源包或部署到线上。多作者天照仍沿用已有全局 owner 结构；其他要求来源死亡后终止的技能行为不变。回退本任务提交即可，无数据迁移。

## 独立验收审查

未参与实现的代理按最新 RED-254 合同独立审查，结论通过、无阻断发现；独立重跑新增规则 10/10、历史 UI 21/21，以及来源/历史/伤害管线/结晶联合 63/63 通过，typecheck、定向 ESLint、diff whitespace 通过。仍待完整客户端人工体验，不授权合并、发布或部署。
