# SkillCode ABI v1 威胁模型

状态：已冻结（RED-151）

适用边界：未来 RED-153 受限 Runtime、其 Node/浏览器 adapter 及 ABI v1 调用者

不适用：当前仅限仓库受信内容的 [`dynamic-code-runtime.ts`](../../lib/game/dynamic-code-runtime.ts)

## 1. 资产、攻击者与信任区

需要保护的资产是宿主文件、网络凭据、进程与环境变量、游戏权威状态、其他玩家私有数据、随机流、真实时间、
运行线程/worker 可用性、Content/Profile 身份、trace 和诊断完整性。

攻击者可完全控制 SkillCode 源码、声明的 capability、结构化输入中的内容字段、返回值、异常、循环、递归、
内存与输出形状，并可重复、并发或在 pending 重放中提交请求。签名或来源只证明内容来源，不代表代码可信。

信任区：

1. Content Pipeline 在 ABI 外继续拒绝外部可执行字段；
2. sandbox 内代码默认不可信；
3. capability adapter 是窄宿主边界，只接受 plain-data 请求并产生候选命令；
4. schema/预算/事务验证器可信，验证成功前不触碰权威状态；
5. 当前 trusted runtime 与 sandbox 彼此隔离，sandbox 失败不能调用前者。

## 2. 安全不变量

- 不可信代码无法获得文件、网络、进程、环境变量、DOM、真实时间、宿主随机、模块加载或宿主引用。
- `globalThis`、`Function`、`eval`、动态 import、构造器链和原型链不能扩大权限。
- 输入、输出和能力参数只包含无原型、可序列化数据；函数与可变 `BattleState` 永不穿越边界。
- content hash/version 与 trace/seed/clock 由宿主产生并逐项匹配；攻击者自报身份不能取得授权。
- 同一 ABI/content/state/seed/input 得到相同输出、预算计数与 trace hash；七项预算来自沙箱外 meter。
- 所有代码同步、有限、可终止；返回后任务不能产生副作用。
- 任一失败保持输入、候选与权威状态不变，且不会回退到可信执行。
- 一次 invocation 的能力不能被另一次继承；终止恶意任务后 worker 能服务健康探针。

## 3. 威胁与控制

| 威胁 | 代表手法 | 必需控制 | 失败/证据 |
| --- | --- | --- | --- |
| 文件访问 | `fs`、路径、下载/写入 | 无模块加载；无文件 capability；进程级隔离 | capability/执行拒绝；宿主文件 hash 不变 |
| 网络访问 | `fetch`、XHR、WebSocket、DNS | 不注入网络；隔离环境禁网 | capability/执行拒绝；无出站连接 |
| 进程与环境 | `process`、`require`、env、spawn | 不暴露 Node 全局或模块；worker 最小权限 | 宿主引用/执行拒绝 |
| DOM/浏览器宿主 | `window`、`document`、storage | browser realm 无 DOM，adapter 仅结构化消息 | 宿主引用拒绝；Node/browser 一致 |
| 真实时间/宿主随机 | `Date.now`、`performance`、`Math.random` | 注入逻辑时钟和命名 PRNG；隐藏原对象 | 固定 seed/clock 差分一致 |
| 构造器逃逸 | `obj.constructor.constructor` | null-prototype 数据、冻结 intrinsics、禁 Function | 恶意 fixture fail closed |
| 原型污染 | `__proto__`、prototype 写入 | plain-data copy、禁止自定义原型、冻结 intrinsics | `SKILLCODE_HOST_REFERENCE_FORBIDDEN` |
| 动态代码/导入 | `eval`、`Function`、`import()` | parser/engine 禁止；无 loader | 编译/权限拒绝，无 trusted fallback |
| 异步与迟到副作用 | Promise、timer、microtask | 同步接口；拒绝 thenable/Promise/计时器；结束即销毁 realm | `SKILLCODE_ASYNC_FORBIDDEN`，延时探针无变化 |
| 死循环/CPU | `while(true)`、指数算法 | 100k/20k fuel；宿主强杀兜底 | fuel 错误；终止后健康探针成功 |
| 深递归 | 自递归/互递归 | 深度 64 | recursion 错误；上限与 +1 fixture |
| 内存耗尽 | 大数组、字符串、对象图 | 16/4 MiB 可归因内存；隔离 worker 限制 | memory 错误；进程保持健康 |
| 输出放大 | 巨型 JSON、命令洪泛 | 64/16 KiB UTF-8；256/0 commands | output/commands 错误 |
| 日志旁路/泄漏 | `console` 洪泛、打印宿主或私有数据 | v1 不提供 console；诊断计入结构化输出预算 | capability denied；无旁路日志 |
| 事件链放大 | helper 互相 fireEvent | 深度 32、稳定队列、事务候选 | event-chain 错误；状态 hash 不变 |
| pending 放大/重放 | 嵌套选择、stale/重复答案 | 深度 8、owner/cursor/revision/root trace/content/replay ID | pending-depth 或 conflict 拒绝；只结算一次 |
| capability 升级 | 声明未知 helper、跨 surface 复用、只申请 Math 却返回伤害 | surface 与本次请求双重白名单；逐 kind 参数/命令 schema | capability denied |
| 身份伪造 | 自报 sourceHash、seed、trace、revision | 宿主重算/生成身份并逐项匹配 | input/output schema 拒绝 |
| 预算伪报 | 省略/伪造 fuel、memory 或 chain 深度 | 沙箱外 meter 七项必填；与结果、实际 commands/bytes 对照 | schema 或对应 budget 错误 |
| 输出类型混淆 | 函数、Date、Map、宿主对象 | 递归 plain-data 校验和精确字段 | input/output schema 或 host-reference 错误 |
| 非原子失败 | helper 已改状态后抛错 | 只生成候选命令；全部验证后单点提交 | transaction rollback；前后 hash 相同 |

## 4. surface 特有风险

- `skillCode`：能力最多，必须逐 helper 转为命令/查询；`forceRemoveEnemyPieceById` 只能转成显式 force-remove
  命令并再次校验敌方/存活/owner；选择返回 pending 时立即停止。
- `cardCode`：不得假设 `sourcePiece`；支付、弃牌和 effect 同事务。
- `ruleSkillCode`：只允许 option pending；触发计数和剩余队列失败时恢复。
- `ruleTriggerSkill`：事件目标已给定，不允许选择或递归模拟 UI；不得把适配 context 变成宿主引用。
- `pendingEffectCode`：无闭包、无 mutation helper、无嵌套 pending；payload 仅 ID/数值/枚举。
- `previewCode`：非权威、0 command；`Math` 只提供确定性数值运算而不暴露宿主随机；即使输出看似合法，也不能决定正式伤害、成本或合法性。

## 5. 可信模式边界

ABI v1 没有“管理员完全信任”“本地文件自动信任”“签名即信任”或“失败后用旧 eval”模式。当前仓库内置代码仍
在独立 trusted runtime 运行，只是迁移前的现役事实，不是 sandbox 模式。外部内容、社区服务器响应、编辑器
草稿、Profile 或存档中的代码不能进入该路径。

如未来确需可信模式，必须新建 High Risk 合同，定义显著 UI、来源、审计、独立进程、权限、撤销与存档影响；
不能作为 ABI v1 的隐藏 flag。

## 6. 验证清单

RED-153/154 至少要提供：

- 文件、网络、进程、env、DOM、真实时间、宿主随机、globalThis、构造器、原型、eval、Function、动态 import；
- Promise、timer、microtask 和返回后副作用；
- 死循环、深递归、内存、输出、commands、事件链和 pending 的“上限/上限+1”；
- 六类正常请求、未知版本/helper/命令/字段及宿主对象；
- 固定 content/state/seed/input 的 Node/browser 输出、预算和 trace hash 差分；
- 每个失败前后输入、候选和权威状态 hash 相同；
- 恶意任务被终止后同一服务进程的健康请求成功；
- 审计确认错误路径不引用 `dynamic-code-runtime.ts`。

## 7. 残余风险与审查门

RED-151 只冻结合同；没有 sandbox 实现，因此不构成外部代码准入依据。fuel 与内存口径必须由所选隔离技术证明
可确定测量；若实现只能提供 wall-clock 或进程总 RSS，必须回到 RED-151 重新审批，不能静默改口径。

在 RED-153 安全实现、RED-154 Node/browser 验证、独立安全审查和 Candidate 验证完成前，Content Pipeline
必须继续拒绝外部 SkillCode。任何新 helper、命令、预算变化或可信回退都需要重新审查。
