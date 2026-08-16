# ADR-0004：权威规则使用根种子、命名随机流与逻辑时钟

- 状态：已接受
- 日期：2026-08-14
- 人工批准：2026-08-14
- 关联任务：RED-28
- 风险：High

## 背景

旧引擎通过模块级 `rng()`、`Math.random()` 和 `Date.now()` 产生规则结果。正式开战入口还可能在初始状态生成后才创建 seed，因此同一对局无法仅凭初始状态、seed 和命令序列稳定复现。预检会执行规则代码，也可能提前消耗随机数；动态 JSON 规则脚本直接访问宿主的 `Math` 与 `Date`；实例 ID 混用系统时间。

RED-28 需要建立 Demo 阶段的确定性基础，但不改变随机概率、部署规则或存档版本，也不实现完整的玩家随机贡献承诺协议。

## 决策

### 根种子与算法

- 每场权威对局在状态初始化前取得一个 `uint32` 根种子。生产入口使用 Web Crypto `getRandomValues()`；测试和调试入口可显式注入 seed。
- 命名流 seed 固定为对字符串 `` `${rootSeed}:${streamName}` `` 执行当前 UTF-16 code-unit/FNV-1a 变体所得的 `uint32`。
- 每个流使用 Mulberry32 输出函数，并用 stream seed 与 cursor 直接计算第 N 个输出。已冻结向量：根种子 `0x12345678` 的 `deployment` 派生 seed 为 `1042218019`，前两个 `uint32` 输出为 `2989293187`、`2046591406`；`skill/effect` 派生 seed 为 `1945309363`。
- 当前稳定流至少包括 `deployment`、`deployment-reroll`、`turn-order`、`skill/effect`；实例 ID 使用 `instance-id/<namespace>` 独立流。
- 增加或调用一个命名流不会推进其他流。修改派生公式、输出算法或既有流用途属于新的 High Risk 兼容性决策。

### 规则时钟与实例 ID

- 规则时钟不读取墙上时间。动作 tick 由 Action Trace 序号决定；同一 tick 内第 N 次读取返回 `(tick + 1) * 1_000_000 + readCursor`。
- 规则实例 ID 由 namespace、根种子、namespace hash、该 namespace 的 cursor 和确定性随机 token 构成，不依赖系统时间。
- 数据驱动技能、规则、附加效果和待选目标脚本通过执行边界获得确定性的 `Math` 与 `Date`。数据文件无需为本任务改写。

### 动作执行与审计

- `runBattleAction(state, action, { rootSeed })` 是权威动作包装入口。它从既有 Action Trace 恢复各命名流 cursor，在同步规则归约期间激活运行时，并只在成功后提交下一状态和 trace。
- 预检在 runtime checkpoint 中运行；无论成功或失败，其随机、时钟和 ID cursor 都恢复。规则拒绝或异常不得修改调用方传入状态。
- Action Trace 记录根种子、action ID、动作 hash、tick、回合、玩家、动作前后权威状态 hash，以及每个随机流的起止 cursor。初始化也记录为 `system-initialize`，使开局消耗可续接。
- 权威状态 hash 排除 `extensions.debugBattle`，避免 trace 包含自身 hash 造成递归不稳定；完整状态仍保存 trace 供审计。
- 稳定 JSON/SHA-256 与初始化 trace 位于 browser-safe 模块，不静态依赖 Node `crypto`。browser GameEngine、Android mobile server 与 Node runner 使用同一实现。
- 随机相关错误附带 `seed`、`stream`、`cursor`、`turn`、`player` 和 `actionId` 上下文。

### 兼容与边界

- 保留 `setRng()`/`rng()` 旧适配器：没有显式 runtime 的训练、非权威预检和测试继续使用原行为；激活 runtime 时 `rng()` 路由到 `skill/effect`。Relay host 与 Android action-log 回放必须使用 `runBattleAction()`，缺失根 seed 时 fail-closed。
- 不增加新的顶层存档字段，不提升 `BattleState._v`。根种子继续使用既有 `{ type: 'server-state', seed, state }`；审计数据继续位于既有 `state.extensions.debugBattle`。
- 规则定义缓存只保存模板，每次装载都返回独立、规范化的运行实例，避免首次读取与缓存命中产生不同 limits 或共享冷却计数。
- 房间 ID、邀请码、鉴权过期、连接/清理时间、日志时间、game record 时间和纯视觉随机属于非规则域，可继续使用系统时间或宿主随机。它们不得写入权威规则结果或权威状态 hash。
- 当前 active runtime 是进程内同步作用域。规则归约不得在作用域内 `await`；如果未来规则允许异步能力，必须先改为请求级上下文隔离。

## 备选方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 继续替换全局 `Math.random` | 不采用 | 并发对局会互相污染，预检与失败路径难以回滚，也无法审计用途 |
| 单一顺序 RNG 流 | 不采用 | 部署增加一次随机调用会改变技能结果，无法满足子系统隔离 |
| 立即修改全部 JSON 规则数据 | 不采用 | 超出 `allowed_paths`，产生大范围内容 diff；执行边界注入可以覆盖同一问题 |
| 把 wall-clock/seed/cursor 增加为新存档字段 | 不采用 | RED-28 明确排除存档格式变化；既有 seed wrapper 与 debug trace 足够承载本阶段信息 |
| 使用加密 PRNG 与玩家贡献承诺 | 后续 | 属于完整防预测/可验证随机协议，不是本 Demo 基础任务范围 |

## 影响与风险

- 收益：同一初始状态、根种子和动作序列可逐动作复现 hash；不同规则子系统不会因调用数量变化互相漂移；失败命令不消耗随机序列。
- 成本：所有权威入口必须携带 seed；动态规则执行边界必须持续注入确定性 `Math`/`Date`；新增规则随机用途必须选择稳定 stream。
- 风险：改变算法、流名、cursor 语义或时钟公式会破坏回放兼容；遗漏的权威入口会退回旧适配器；同步全局作用域不能包裹异步规则。

## 验证方式

- 固定派生向量、流隔离、确定性 ID/时钟与预检 cursor 回滚单测。
- 同一 seed/动作在不同宿主 `Date.now()` 下得到相同规则状态和逐动作 hash。
- 失败命令后原状态、下次随机输出和 trace cursor 与控制组相同。
- 调试对战固定 seed 回归、核心规则测试和 TypeScript 静态检查。
- 构建 browser GameEngine 与 Android mobile server，验证 bundle 可加载、Relay 初始化返回的 seed 等于 trace seed，并以同一 bundle/seed/action 重复得到相同 hash。
- 审计 `lib/game/**`、权威入口及数据规则中的 `Math.random()`/`Date.now()`，逐项确认由运行时边界接管或列入非规则豁免。

## 回退方式

1. 按模块提交回退权威入口对 `rootSeed` 的注入、Action Trace 扩展和 `RuleRuntime` 作用域。
2. `rng()` 的旧适配器继续保留，因此旧训练/浏览器路径可恢复到任务前行为，不需要存档迁移。
3. 保持既有 `{ type, seed, state }` wrapper 和 `BattleState._v = 1`，不删除或转换用户存储。
4. 若仅某个规则脚本边界出错，可单独回退该边界的 `Math`/`Date` 注入，而不修改随机算法与数据内容。

## 相关资料

- [RED-28](https://linear.app/redvsblue/issue/RED-28)
- [游戏引擎核心](../technical/ENGINE_CORE.md)
- [模块接口地图](../technical/MODULE_INTERFACES.md)
- `tests/game/deterministic-runtime.test.ts`
- `tests/game/determinism-audit.test.ts`
- `tests/game/debug-battle.test.ts`
