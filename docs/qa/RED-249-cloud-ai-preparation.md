# RED-249：Cloud AI 准备验证

任务：[RED-249](https://linear.app/redvsblue/issue/RED-249/准备-codex-cloud-独立-ai-玩家目标路线搜索与运行环境)。

风险 High。项目负责人已在2026-10-09聊天批准独立 AI 进程可见信息隔离推演例外，见 [ADR-0038](../decisions/ADR-0038-cloud-ai-player.md)。实现者负责此变更；独立审查与人工验收分别记录，不能互相代替。

## 开发基线与范围

- base_branch: main
- base_sha: `00df31f8bd35b34200d507fd83853bf5ac99ba94`
- branch: `codex/RED-249-cloud-ai-player`
- 仅新增目标求解器、独立机器人模块/CLI/测试和相关说明，package.json仅新增三个脚本。
- 服务端、普通 UI、卡牌效果、随机算法、存档、依赖和默认人机均无变更。

## 已执行证据

| 检查 | 结果 |
| --- | --- |
| `npm.cmd run check:main-baseline` | 通过，HEAD与origin/main均为上述SHA，ahead0/behind0。 |
| `npm.cmd ci --ignore-scripts --no-audit --no-fund` | 按现有锁文件安装1054个包；未升级依赖。 |
| `npm.cmd run ai:cloud-preflight` | 通过；Windows，Node24.13.1，依赖和内容manifest齐全；网络与Cloud标记为未验证。 |
| `npm.cmd exec vitest run tests/game/ai-isolation.test.ts tests/game/ai-environment.test.ts --maxWorkers=1` | 2文件27项通过；npm将maxWorkers解释为CLI配置并警告，后续验证使用`npm.cmd exec -- vitest …`正确传参。 |
| `npm.cmd exec -- vitest run tests/game/ai-goal-search.test.ts tests/ai-bot --maxWorkers=1` | 最终11文件43项通过。包括真实SDK战斗协议、真实CLI卡住HTTP请求后退出、实际策略预算回退。 |
| `npm.cmd exec -- vitest run tests/ai-bot/cloud-process-lifecycle.test.ts --maxWorkers=1` | 修正该测试的Node类型后重跑：1项通过；真实子进程约2.20秒自行非零退出，令牌未泄漏、未输出成功结果，未靠cleanup中的kill通过。 |
| `npm.cmd run typecheck` | 最终通过：`next typegen && tsc --noEmit`。 |
| `npm.cmd exec -- eslint lib/ai-bot lib/game/ai-goal-search.ts scripts/ai/cloud-ai-preflight.mjs scripts/ai/run-cloud-bot.mjs scripts/ai/run-goal-search.mjs tests/ai-bot tests/game/ai-goal-search.test.ts --max-warnings 0` | 全部受影响源码与测试通过；后续仅修正生命周期测试类型，对该文件单独重跑也通过。 |
| `npm.cmd run ai:goal-search -- --smoke` | 通过：seed9109817，五动作目标路线，13次转移尝试、10接受/3规则拒绝、0执行错误、深度5；观测845.62ms，9 AP。 |
| `npm.cmd run ai:cloud-bot -- --help` 与 `--check-config <临时配置>` | 通过；临时配置直接取自环境说明的official示例，8棋子；不联网，不加载凭据。 |
| `npm.cmd run check:encoding` | 最终通过；1537个文本文件检查。 |

独立Astra只读审查与复审完成，没有剩余P1/P2；没有代替人工产品验收。

验证中发现并修复：目标配置未传到策略、正常预算耗尽后可能退出而非回退、断线重连前提前退出、原生snapshot缺roomId，以及SDK未完成握手/HTTP请求和leave可能保活进程。新增相应回归；独立CLI增加最终退出期限。初次静态检查的`any`与新测试Node类型错误均已修正并重新检查。原生非产品BattleRoom夹具不提供产品大厅RPC，因此明确使用跳过大厅的official传输模式和假令牌；它不验证官方账号认证。direct初始化错误现在会报告，不能吞错。

Vitest仍显示仓库原有configLoader/ESM兼容提示；本任务未修改依赖或测试配置。提交前主线基线检查再次通过；新文件首次stage后发现5处EOF空行，清理后`git diff --cached --check`通过。

## Cloud 与正式服验证边界

目前未创建/发布用户 Cloud 环境，未使用真实官方账号凭据，未连接生产服务器。任何本地替身/SDK测试只证明本地代码和传输行为，不证明Linux Cloud网络、真实官方账号、PostgreSQL耐久或实战胜率。五次召唤测试只证明同一回合9 AP完整离线状态中的目标路径；不是跨回合、隐藏信息和未知对手的完整最优策略。

## 验收项与证据位置

| 合同验收项 | 可重复证据 |
| --- | --- |
| 正式五次召唤路线，不因前期没有即时收益而剪枝 | `tests/game/ai-goal-search.test.ts` 与离线 `--smoke`：依次执行五张真实恶魔卡；9 AP耗尽，锚点HP30→10，Kiljaedan成功召唤。 |
| 搜索隔离、确定性与有界结果 | 同上：原始状态/全局仓库不被写回；节点/深度/时间耗尽与无路、执行错误分别返回；固定种子保持路线/状态一致。 |
| 线上只使用获准的信息 | `tests/ai-bot/shadow-state.test.ts`：对手手牌、extensions、真实随机与游标不进入影子状态；本地可信内容重载；原始投影不被修改。 |
| 独立入口、环境说明与离线验证 | 三个新增CLI、`offline-goal-cli.test.ts`、`cloud-bot-cli.test.ts`；[Cloud说明](../technical/CODEX_CLOUD_AI.md)列出实际命令、账号变量、网络限制及未验证项。 |
| 官方身份及赛前生命周期 | `official-session.test.ts`、`official-lobby.test.ts`：HTTPS要求、账号绑定先于排队、profile校验、公开禁图/自己的阵容revision、超时取消自己的队列；不自动认负。 |
| 每次只提交一步并恢复权威状态 | `transport.test.ts` 与 `local-colyseus.test.ts`：单在途命令、旧快照决策丢弃、拒绝重搜、原ID回执查询、真实SDK移动/endTurn/beginPhase和重新同步；`budget-fallback.test.ts`验证真实策略回退提交一步，`cloud-process-lifecycle.test.ts`验证真实CLI挂起请求退出。 |
| 架构批准、独立审查、回退 | 用户已批准ADR-0038；独立审查发现的问题必须修复并复审；停止入口/撤销PR即可回退。 |

## 人工验证与回退

1. 按 [环境说明](../technical/CODEX_CLOUD_AI.md) 创建绑定仓库的Cloud环境，先运行预检与离线smoke，核对五动作和终止原因。
2. 为已验证的独立AI游戏账号配置环境变量，提供可达的官方HTTPS/WebSocket入口，以受控对手进行短时有限动作验证。
3. 对照服务器回执检查每步是否接受、拒绝是否导致重搜、断线恢复是否先同步。核对整个输出不含密码、token、对手手牌、隐藏扩展或真实服务器种子。
4. 验证完成后人工决定产品强度是否符合期待；本PR不自动合并/发布。

回退：停止独立入口或撤销此PR；没有数据库、存档或协议迁移，不需要修改生产数据。
