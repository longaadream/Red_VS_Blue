# RED-122 实现验证证据

任务：实现零阶段单步贪心估价与位置潜力 AI 基线

角色：实现者（Codex）。历史 schema v3 曾通过独立 AI 复核；本轮 v7/PvE 新增接入尚待独立审查与人工验收。

分支：`codex/RED-122-zero-stage-ai`

当前上传基线：`origin/main@60b775db2e6440208e68c912eb3b0b28e2e16ddf`（2026-09-03 提交前刷新并 merge）。下方标明旧 SHA 的性能数据保留为历史证据，不冒充当前基线结果。

## 实现范围

- 正式 agent/profile ID 与配置资产命名为 `rvb-ai-zimse-v1`。
- 除第 8 动作的回合护栏外，每次决策对全部严格合法候选各执行一次隔离模拟，不搜索第二层。
- `F_p(S)` 提高伤害、击杀、残血/核心威胁、攻击覆盖、中心控制、敌方目标压迫和未来接敌价值，并把纯保守安全降为底线约束。
- `resources` 将未使用费用视为当前回合机会成本；攻击、追敌移动、技能、结构动作与 `endTurn` 全部经过实际 transition 后再按估价比较。
- 第 8 个动作仍通过护栏强制结束，避免无界长回合。
- AI transition 对合法接收但公开观察完全不变的技能、移动或卡牌标记 `blocked=true`；零阶段记录但不估价、不选择，防止沉默或打坐动作重复触发。
- 候选估价使用不含历史 replay/action-log 载荷和完整 state diff 的 evaluation transition；仅保留与权威 `actionCount` 等长的轻量日志占位，从而维持终局 action index。它仍调用原 `runBattleActionIsolated()`，完整保留 gameplay state 与 RNG authority。最终正式动作继续走完整 transition。
- 未修改技能、卡牌、玩法数值、胜负、随机、存档或 PvE 奖励；经用户追加批准，当前版本接通 UI、HTTP/旧 WS 与实际 Colyseus PvE 入口。

## 2026-09-03 PvE 上线接入与渐进部署 v7

- 主菜单提供“简单 · sample-v1”和“普通 · zimse-v1”；旧请求省略难度时仍为简单。
- 客户端只发送 `easy`/`normal`，服务器固定映射为 `simple-v1`/`rvb-ai-zimse-v1`，不接收任意 agent 或权重配置。
- Colyseus PvE 房间由服务器占用蓝方 Bot 座位并锁定默认阵容；真人不能加入 `bot` 座位。Bot 的部署、pending 与行动都走原权威 dispatch；普通难度每次权威变更后重新完整枚举，房间调度只保存回合动作计数 continuation。
- profile v7 把渐进部署继续视为单步策略。公开的首次免费移动范围只按 50% 折算为追敌潜力，真实移动到位后的评分严格高于未兑现潜力，没有增加第二层动作。
- 实际 SDK 回归使用固定 root seed `1001`，简单和普通均完成自动部署与完整 Bot 回合并把控制权交还真人；3 个 Colyseus 文件共 9 项通过，耗时 `80.47s`。零阶段/PvE/权威旧 WS 核心回归 5 文件 92 项通过；planner 16 项通过；Colyseus 构建通过。
- 2026-09-03 三个随机 seed `3304753545`、`4071025389`、`2101381254` 的评测中，仅第一局形成有效终局（第 18 回合胜，墙钟约 780.81 秒）；另两局分别因 simple 端动作护栏和拒绝移动中止。因此仍不能宣称满足“高概率 20 回合、除极低概率外 40 回合、每局约 10 分钟”。
- 当前同步后的 `typecheck` 仍被 main 的 `tests/game/sonic-roster.test.ts` 4 个类型错误阻断；Lint 仍在配置加载期缺少 `import` 插件；相关最小回归、编码检查、baseline、diff 检查均通过。

### 2026-09-04 上传前完整验证

代码提交：`c90bf7257fbc4d5dfaab9353d73f97a92237bf8a`；随后仅补正文档。完整命令：

```text
npm.cmd test -- --maxWorkers=1 --silent=true --reporter=json --outputFile=output/validation/red122-upload-full-suite.json
```

结果：200 文件，189 通过 / 11 失败；2193 项，2176 通过 / 14 失败 / 3 跳过，退出码 1。AI zero-stage、PvE、Colyseus 当前接入测试均通过。失败清单（不擅自修改范围外模块，也未更新快照）：

- roster-transports：spectator 与玩家私有手牌投影不应相同，旧全对象相等断言失败（1）。
- content-core-boundary：未改动的 `battle-presentation-events.ts` 中 11 个内容 ID/核心耦合审计项（1）。
- electron-client-package：测试 fixture 缺少 Colyseus bundle 和 PostgreSQL runtime/license 资源（1）。
- battle-page-runtime：`TUTORIAL_MODE` 未定义与 receipt 状态断言（2）。
- embedded-postgres：测试运行时清单/临时凭据清理场景（2）。
- ai-semantics：当前内容 manifest 审计（1）。
- battle-state-hash：缺失 Android `www/js/game-engine.js` 生成 bundle（1）。
- skillcode-static-audit：清单计数由 21/134 变为 19/141（2）。
- targeting：当前内容的 preparation hash 与旧期望不符（1）。
- battle-action-identity：技能名称 fallback 断言（1）。
- battle-effect-icons：新状态类型覆盖断言（1）。

同次完整运行中的渐进部署镜像自战：root seed `1001`，蓝方在第 9 完整回合以 `core-eliminated` 获胜，剩余 3 枚棋子。共 152 动作，非法/拒绝动作 0，失败 0，总时长 `504.94s`（8 分 25 秒）。共 9820 候选、9482 模拟节点，差额来自既有回合动作护栏；决策 P50 `1882.90ms`、P95 `10208.31ms`、最大 `18096.43ms`。该单个镜像样本不能外推为对 sample 的总体胜率或整局时间承诺。

环境：Windows x64、Node `v24.19.0`、16 个逻辑处理器，CPU 标识 `AMD64 Family 25 Model 117 Stepping 2, AuthenticAMD`；Vitest 单 worker。

- action trace hash：`bf8f3d05d3cb11967d061c7d4d0258c8d6d6f1d006b3a3f11d08d284004ef7a2`
- final state hash：`b1ee4107262f2655d0a85e1b6ca77e9c2fd4ecc27bc0abfc39ff8cbe0d24e32d`
- 红/蓝实际 AP 使用：56/49；充能使用：6/5；总移动 38 次。

原始完整报告留在上述本地 `output/validation` 路径，不上传生成产物。以上压缩结果随 PR 上传。仍需人工/独立审查后决定是否合并；本轮不自行合并或发布。

## 固定局面证据

`tests/game/ai-zero-stage.test.ts` 共 26 项，覆盖：

- profile ID/权重与可执行默认配置一致；
- 红蓝相对视角、终局绝对优先和隐藏信息隔离；
- 中心控制、敌方核心压迫、未来攻击、支援、机动、地形和低血暴露；
- AP/充能使用后的评分高于保留费用；
- 同分时费用动作胜过跳过回合，进攻位置胜过等费用撤退，等接敌距离时选择中心路线；
- 后期僵持时追敌移动估值高于等费用自益技能，增强位置权重后仍会及时锁定部署；
- 立即核心斩杀、明确威胁处理、每候选一次模拟、确定性 hash；
- 普通累计分超过一百万时仍优先立即胜利，profile 只允许 `all-legal` 候选模式，最终 tie-break 原因进入 trace；
- 修改隐藏手牌/隐藏状态不改变完整决策和 trace hash，红蓝镜像追敌动作排序一致；
- 拥挤局面 21 个候选全部模拟、零费用无收益循环、第 8 动作护栏；
- `blocked=true` 技能和 authority rejected 候选都只淘汰自身；其后的全部后备候选仍各模拟一次，胜利动作仍可被选择。
- 两组不同生命、攻击和移动结构的 8v8 fixture 均覆盖红蓝双方席位。

结果：`26/26` 通过。未触发回合护栏的样本均满足 `nodesVisited === candidatesConsidered === legal.length`，普通候选没有 `candidate-budget` 裁剪。

AI 环境（含合并后的 RED-128 v2 合同）、RED-86 planner、状态隔离与零阶决策回归：`4 files / 64 tests` 全部通过。新增对照证明完整/轻量 transition 的 accepted、blocked、rejected、公开观察、`F`、gameplay state hash 和 RNG authority 一致，evaluation 重复 hash 稳定，输入 replay 不被污染；另覆盖“已有历史后立即终局”，验证 `settledAt.actionIndex` 与完整 gameplay state hash 一致。

## schema v3 全枚举性能验证

2026-08-29 运行固定 seed `1001` 镜像自对弈。优化前便携式哈希与原生 SHA-256 两次均超过 20 分钟未完成。压缩候选推演的历史 replay/action log 后，旧基线第一轮在 `518.84s` 完成；进一步省略 evaluation state diff 和重复 pre-state hash 后，在加入终局 action-index 等长占位修正的旧基线最终轮于 `365.08s` 完成，且各优化轮 action/final hash 完全一致。合并最新 `origin/main@44d7296` 后重新运行，因上游内容与 AI environment v2 变更，候选与 hash 按预期变化；新基线在 `398.90s` 完成，胜负、回合数、正式动作数和动作类型分布保持一致。

结果：红方在第 25 个完整回合以 `core-eliminated` 获胜，红方剩余 3 枚棋子；正式动作 `371`，非法/拒绝动作 `0`，失败 `0`。全局候选 `33,068`、实际模拟节点 `32,112`；差额来自第 8 动作护栏，普通候选没有预算裁剪。

| 指标 | 结果 |
| --- | ---: |
| 决策数 | 371 |
| P50 | 335.59ms |
| P95 | 2,843.66ms |
| 最大 | 8,687.96ms |
| 红方 AP / 充能 | 188 / 6 |
| 蓝方 AP / 充能 | 128 / 1 |

新基线确定性证据：action trace hash `15d674f66158bcc757798266a15c5ecd647219e0e78d3013c6893d87638fa3b7`；final state hash `b8f9ab10d4097fd5980cc3ef04584453d782448286fcc5a05af1e75dbb813267`。

结论：完整枚举现已能完成真实 8v8 自战，并把中位决策时间降到约三分之一秒；P95 约 2.8 秒、峰值约 8.7 秒仍是明确体验风险。为遵守“测试全部可能策略”，没有使用候选数量、动作类型、费用、目标或墙钟时间裁剪。

## 历史证据：schema v2 镜像自对弈

以下结果来自 2 节点候选版本，仅用于说明修改前基线，不代表 schema v3 的当前速度或胜负：

命令：

```text
npm.cmd test -- tests/game/ai-zero-stage-pve-evaluation.test.ts
```

双方：`rvb-ai-zimse-v1` vs `rvb-ai-zimse-v1`

固定 seed：`1001`

结果：蓝方席位在第 9 个完整回合后以 `core-eliminated` 获胜；蓝方剩余 7 枚棋子，红方存活棋子为 0；非法/拒绝动作 `0`，规则异常 `0`。

| 指标 | 红方 | 蓝方 | 合计 |
| --- | ---: | ---: | ---: |
| 正式决策 | 32 | 69 | 101 |
| 消耗 AP | 15 | 42 | 57 |
| 消耗充能 | 0 | 4 | 4 |
| 普通移动 | 4 | 5 | 9 |
| 普通技能 | 6 | 19 | 25 |
| 充能技能 | 0 | 3 | 3 |
| 结束回合 | 10 | 9 | 19 |

其他动作包括部署锁定、开始阶段、卡牌和 pending 交互。总正式动作 101。对比修改前同 seed 的 40 回合平局与 0 次普通移动，新策略执行 9 次追敌移动，并提前 31 个完整回合产生胜者。

性能：决策 P50 `125.56ms`，P95 `251.33ms`，最大 `389.56ms`；访问节点 `180`，候选总数 `12007`，每次决策节点不超过 2。

确定性证据：

- action trace hash：`cd6358ac039ec1c09d92a912af8b8d7354b3186a8f64a7b8dc93e975e355d9d0`
- final state hash：`938bc189e6dbb9263883579f0c6eb60da590173b3fc740af0744ae6434e1d459`
- 可导入回放：`docs/qa/RED-122-rvb-ai-zimse-v1-aggressive-self-play-seed-1001.trace.json`，`rvb-match-trace/v2`，101 帧，SHA-256 `48ABB5B97E5EF46E47C6DAD3C7EB5EEF0AF793EF2B3E4364C9422480E0026230`。

相同 seed 在单独自战与完整测试中重复得到相同动作与终态 hash，说明追敌排序、攻击权重和部署收束没有引入非确定性。

## 历史证据：schema v2 对游戏内置 PvE AI 的三局评测

使用服务器同源 `generateBotActions()` 的正式 `simple-v1`，固定 seed `1001`、`1002`、`1003`，零阶段 AI 按红、蓝、红席位交替对战。结果为 `rvb-ai-zimse-v1` 0 胜、`simple-v1` 0 胜、3 平；三局均在第 40 个完整回合以 `round-limit` 结束，非法/拒绝动作 0，单次节点仍不超过 2，最大决策耗时 `2,030.67ms`。

逐局动作、资源、性能与确定性 hash 见 `docs/qa/RED-122-rvb-ai-zimse-v1-vs-simple-v1-3-games.md`。该结果说明镜像自战的第 9 回合胜利不能外推为对内置 PvE 的稳定终局能力，消除跨策略平局仍是已知风险。

## schema v3 验证状态

通过：

- `npm.cmd test -- tests/game/ai-zero-stage.test.ts`：1 file / 26 tests。
- 合并 `origin/main@44d7296` 后运行零阶段、AI environment v2、planner 与状态隔离回归；最新合计 4 files / 64 tests，全部通过。
- `npm.cmd run typecheck`：同步 lockfile 已声明的依赖后通过。
- `npm.cmd run check:encoding`：通过，776 个文本文件。
- `npm.cmd run check:main-baseline`：通过，Ahead 5 / Behind 0。
- `git diff --check`：通过（仅换行转换提示）。
- 固定 seed `1001` 镜像自对弈：1 file / 1 test，通过；25 回合正常终局，非法动作 0；在最新 main 上重复运行的动作与终态 hash 一致。
- `npm.cmd test -- --maxWorkers=1`：同步 lockfile 已声明的依赖后，133 files / 1,386 tests 通过，1 test 按环境开关跳过；完整 suite 退出码 0。首次运行暴露的 11 个 `@noble/curves` 导入失败在依赖同步后消失。

schema v3 全枚举边界曾完成独立 AI 复核；本次 evaluation transition 性能优化已完成新的独立 AI 复核。复核首次发现压缩 action log 会改变立即终局的 `settledAt.actionIndex`；修正为等长轻量占位并增加终局回归测试后，复核结论为通过，无剩余阻塞项。

未通过/环境阻塞：

- `npm.cmd run lint`：ESLint 配置加载失败，规则 `import/no-anonymous-default-export` 未注册 `import` 插件；未进入源文件检查。配置与依赖不在 RED-122 allowed paths。

## 风险与人工验证

- schema v3 已能完成固定 seed 真实自战，但 P95 `2.84s`、最大 `8.69s`；高候选局面仍可能让玩家明显等待。
- schema v2 对内置 `simple-v1` 的 3 个固定 seed 全部在 40 回合上限平局；schema v3 尚未重跑三局评测，不能宣称已解决跨策略平局。
- “公开观察完全不变”会把无公开收益的合法非结构动作也视为 blocked；对零阶段 AI 而言这是防循环策略，但新型零公开变化技能接入时需要补机制语义。
- Medium Risk 的 evaluation transition 优化已通过独立 AI 复核；实现者与复核者均不代替最终人工体验验收。

建议人工复核沉默、鸣人打坐、攻击残血敌棋、向敌方核心逼近、费用即将溢出的回合，以及第 8 动作强制结束。

## 回退

整体 revert 零阶段 profile、估价器、选择器、AI transition blocked 标记、测试和文档。现有 simple/planner、玩家存档、玩法数据、网络协议和 RNG 无需迁移。
