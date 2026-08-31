# ADR-0022：四类确定性 EffectBatch / Queue 与“同时”语义白名单

## 状态

已接受。项目负责人于 2026-08-31 明确批准本技术方案；RED-139 生产实现必须遵守本 ADR、Linear 中更新后的兼容例外与收敛后的 `allowed_paths`。

## 日期

2026-08-31

## 任务基线

- Linear：RED-139。
- `base_branch`：`main`。
- 合同立项 `base_sha`：`6e6ae8dd88928dc285c0cbb7a5be7e3c121ae9a2`（RED-139 开始生产实现时记录）。
- 当前开发 `base_sha`：`b0a5c3fb99b68b2a7e174c03b2b0c0a4b30b6926`（2026-08-31 执行 `git fetch origin --prune`，并将实现分支 rebase 到当时最新 `origin/main` 后记录）。
- PostgreSQL + Colyseus 首次集成基线：`8902c0da94957fdb52d142363c2c45a2ebda7a7f`（包含已合入的 RED-160）。
- 继承决策：ADR-0004、ADR-0006、ADR-0008、ADR-0010、ADR-0011、ADR-0015、ADR-0016。

## 背景

ADR-0010 已为 Damage 建立稳定目标排序、统一 HP 提交和动作内 `damageQueue`，但当前实现仍不统一：

1. Damage 的 queue 是每次 helper 调用创建的局部 chain，无法与 Heal 等效果共享动作级预算。
2. 多目标 Heal 先发送一次 `beforeHealDealt`，再递归调用单体 Heal，实际发送 N+1 次；每目标立即写 HP 和发送 after，不是 Batch。
3. Summon 只有单体 helper，现役鸣人技能和恶魔召唤卡直接修改 `battle.pieces`。
4. Death 嵌在 Damage 循环中逐个移墓地，较晚目标的死亡事件会看到较早目标已离场。
5. 动态 card/skill surface 可能包装或吞掉规则错误；正常 `runBattleAction` 失败也未完整恢复全局 TriggerSystem 的事件 ID 与 rule limits。

RED-139 的产品语义已经批准：只有 Damage、Heal、Summon、Death 可以具有逻辑同时性，其他效果必须顺序结算。本 ADR 只决定技术阶段、兼容迁移和回滚边界。

实现期间，RED-160 已在 `main` 落地 PostgreSQL + Colyseus 最小权威纵切。RED-139 因此还必须与真实的 `BattleRoom → dispatchRoomBattleAction → runBattleAction → CandidateBattleStore/PostgresAuthorityJournal` 路径兼容，而不是只证明单进程 helper 可用。该兼容补充不授权 RED-139 修改数据库 schema、Colyseus 协议或 RED-160 的普通动作异步 durability 取舍。

## 决策

### 1. 白名单与术语

`Batch` 的“同时”固定表示：同批先验证并准备全部请求，在明确的统一 checkpoint 提交主状态，再按稳定顺序串行发送 after/lifecycle 事件并调度 follow-up。

`Queue` 只表示确定性串行调度，不表示线程并发，也不表示队列中的不同 Batch 同时发生。

类型系统使用封闭判别联合：

```ts
type EffectBatchKind = 'damage' | 'heal' | 'summon' | 'death'

type EffectRequest =
  | DamageRequest
  | HealRequest
  | SummonRequest
  | DeathRequest
```

- 不提供 `string` kind、`CustomEffect`、通用 callback 或无类型 `effectQueue`。
- dispatcher 使用穷举 `switch` 和 `assertNever`。
- 未知 kind 在任何状态或 RNG 修改前抛结构化规则错误。
- 位移、传送、状态、驱散、资源、手牌、技能替换、地格、投射物和强制移除继续顺序执行，不得借用四类 Batch。

### 2. 权威动作级 EffectChain 状态机

`BattleRunner` 在每次权威根动作尝试开始时安装唯一的瞬态 `EffectChain`，结束、失败或挂起时移除。chain 有 `idle` 与 `processing` 两种状态：

- `idle`：根 SkillCode/CardCode 可以顺序调用 `dealDamage`、`healDamage` 等兼容 facade。facade 同步 enqueue 并 drain 自己启动的 Batch 后返回结果。眼棱、圣光降临、穆鲁的挽歌等同一根动作中的多次合法 helper 调用因此继续工作，并共享同一组累计预算。
- `processing`：scheduler 正在执行某个 Batch 或事件消费者。此时直接调用 facade 是重入错误；消费者只能通过获准的 typed writer enqueue follow-up。
- 根 active skill/card 调用 `summonQueue.push` 这类无同步结果的 writer 后，在当前动态执行帧成功退出时 drain；handler 内 writer 则在该 handler 的明确阶段结束后 drain。
- queue drain 完成后 chain 回到 `idle`，但计数、ID 序列和 ledger sequence 直到根动作结束才销毁，不能由下一个 facade 重置。

没有 `BattleRunner` 上下文的低层兼容调用可以创建带 `detached=true` 的临时 chain。它只用于单 helper API 和单元测试，不得作为动作级预算、pending 或权威回滚证据。

pending/恢复的每次尝试都从根动作 pre-state 创建一个新 chain，计数从 0 确定性重建；被放弃尝试的计数不继承，但同一次重放尝试中不得重置。

### 3. Typed writer、能力矩阵与跨类型 FIFO

EffectChain 内部拥有四个 writer：`damageQueue`、`healQueue`、`summonQueue`、`deathQueue`。所有 writer 写入同一个带单调 `enqueueSequence` 的 ledger，不是四个独立 drain 的数组。

能力按执行 surface 冻结：

| 执行 surface | damageQueue | healQueue | summonQueue | deathQueue |
| --- | --- | --- | --- | --- |
| 根 active skill/card，chain 为 `idle` | 使用同步 `dealDamage` facade | 使用同步 `healDamage` facade | 仅 content-bound sealed recipe | 不公开 |
| Damage 生命周期事件（含 `afterDamageDealt`） | 可写 | 可写；Reap 使用此能力 | 仅显式 content capability | 不公开 |
| Heal 生命周期事件 | 可写 | 可写 | 仅显式 content capability | 不公开 |
| Summon / Death 生命周期事件 | 可写 | 可写 | 仅显式 content capability | 不公开 |
| 内部 handler | 可写 | 可写 | 可写 sealed request | 可写已为 HP 0 的候选 |

因此 Reap 所在 `afterDamageDealt` 明确拥有 `healQueue`。damage↔heal 循环可由 Damage/Heal 生命周期 writer 构造；summon↔death 循环使用内部 handler 测试入口或绑定具体 contentId 的 sealed summon capability，不为测试开放任意 Piece/callback。`deathQueue` 首版只供内生 handler 使用；没有具体作者合同前不公开主动处死能力。

其他 trigger/card/skill surface 不自动获得 writer，更不得获得整个 ledger 或通用 `effectQueue`。现役 `context.damageQueue.push(...)` 的调用形状保持兼容。

跨类型没有 Damage > Heal > Summon > Death 的隐式优先级。显式根代码顺序或 handler 阶段先决定何时进入 drain；进入 ledger 后严格按 push sequence FIFO。Damage 产生的 DeathBatch 是 Damage handler 的内生生命周期阶段，不是 DeathQueue 抢占。

### 4. 通用阶段、稳定键与结果对齐

Damage、Heal、Summon 依次执行：

1. **Validate**：验证来源、目标、重复项、数值和该类不变量，不提交权威状态。
2. **Prepare**：按稳定键排序，发送 before 事件，在事务草稿上计算结果与事件参数。
3. **Commit**：一次提交该类主状态。
4. **Emit**：所有请求均已看到 Commit 后状态，再按稳定顺序发送 blocked/after/lifecycle 事件。
5. **Enqueue/Drain**：follow-up 已带 parent、depth 和 sequence 写入 ledger，在当前固定阶段完成后 FIFO 消费。

Death 因现役“亡语可复活、复活者不入墓”的合同具有第 8 节明确列出的两 checkpoint 例外；该例外本身属于本次人工批准项。

`chainId`、`batchId` 和实例 ID 来自 ADR-0004 确定性 runtime 或第 7 节明确保留的 legacy deterministic adapter，不使用真实墙钟或进程随机数。批内权威排序使用 `instanceId` 或 sealed request 的规范键；返回结果映射回调用输入顺序。仅交换同一 Batch 的输入排列，不得改变 ID、规范化事件轨迹或最终权威 state hash。queue push 顺序本身是语义输入，不做排列归一化。

Prepare 中触发器造成的护盾、状态、日志、rule limit 或 RNG 变化都在根动作事务内；后续失败必须整体回滚。

### 5. DamageBatch 与 Reap checkpoint

Damage 保留 ADR-0010 的公开 helper、结果形状、伤害类型和 `damageQueue.push` ABI，并纳入动作级 chain：

1. 验证全部活着且唯一的目标，按 `instanceId` 排序。
2. `beforeDamageDealt` 每 Batch 一次；`beforeDamageTaken`、shield、`beforeDamageApplied` 每目标准备。
3. 全部目标 HP 一次 Commit。
4. 按稳定目标顺序发送 `afterDamageBlocked` 或 `afterDamageDealt` / `afterDamageTaken`。
5. 将本批 HP 由正数降至 0 的冻结集合交给一个内生 DeathBatch。
6. DeathBatch 完成后，按共享 FIFO drain 本 Batch 各阶段收集的 follow-up。
7. action/result 保留现有 batch/chain/parent 字段，结果映射回输入顺序。

这意味着 `rule-reap.json` 从 `afterDamageDealt` 直接同步治疗迁移为 `healQueue.push` 后，治疗的批准提案是：完成当前目标的 `afterDamageTaken`、整个 DamageBatch 的 after 与内生 DeathBatch 后，才按其较早的 enqueue sequence 执行；不为 Reap 增设 Heal 特权 checkpoint，也不提前 drain 其他类型。

queue push 不返回未来 `healResult`，也不接受结果 callback。Reap 的即时 trigger message 改为“某某触发了收割”，实际治疗量由 HealBatch 结果、HP 差和调试证据记录；不新增 `battle.actions` 类型或 payload 字段。这是有意的事件顺序与既有 triggerEffect 文本/hash 变化，必须由人工在批准本 ADR 时确认。

`rule-elune-protection-player.json` 在 `beforeDamageApplied` 中恢复生命属于 Damage Prepare 的致死拦截，不迁移到 HealBatch。

### 6. HealBatch

`healDamage` 单体签名继续工作；数组输入改为一个真正的 HealBatch：

1. 验证 healer、唯一且仍在场的活目标、有限非负基础治疗。
2. `beforeHealDealt` 每 Batch 一次；若 source-wide blocked，则整个 Batch 无 HP 提交并返回 blocked，不发送每目标 before/after。
3. 每目标恰好一次 `beforeHealTaken`，并读取该目标上下文最终修改后的 heal。per-target blocked 只阻止该目标，Prepare 仅记录结果，不立即发送 `afterHealBlocked`。
4. 每个未 blocked 目标基于同一批开始 HP 快照计算 `min(maxHp, hpBefore + floor(heal))`。
5. 所有未 blocked 目标 HP 一次 Commit。
6. Commit 后按稳定目标顺序：blocked 目标发送 `afterHealBlocked`；其余目标发送 `afterHealDealt`、`afterHealTaken`。
7. writer 产生的条目进入共享 FIFO；`processing` 状态直接嵌套 `healDamage` 失败关闭。

单体只是一个目标的 HealBatch，不保留第二套事件实现。结果包含 batch/chain/parent/depth 并映射回输入顺序。

### 7. SummonBatch 与封闭 recipe

`SummonRequest` 是无 callback、不可携带任意 `PieceInstance` 的封闭联合：

- `template`：只含 templateId、owner/faction、位置和现有 index 参数，由 repository/template pipeline 创建；仅内部 template writer 可创建。
- `declared-content`：技能或卡牌定义可携带版本化 `summonCapability` 声明；运行时只接受 `source-mirror` 与 `stored-or-declared-piece` 两种封闭 schema。鸣人影分身使用前者声明固定复制字段、三条 clone rule、冷却重置与插入/RNG 策略；恶魔召唤使用后者声明固定 extension key、模板、fallback 棋子和技能。

声明必须是普通对象，所有层级只接受列出的键和值域；解析后递归复制、深冻结，并由 `effect-batch` 模块私有 `WeakSet` 品牌认证。writer 同时通过私有 content-binding 映射绑定当前 contentId、已认证声明和允许的 predicate；调用方只能提交 `sourceId`、坐标和可选变体。contentId/声明/品牌/绑定不匹配或出现额外字段时，在修改权威状态前 fatal。不得把任意对象、任意 extension path、任意规则列表、`PieceInstance` 或函数从 writer 请求注入 handler。当前数据中只有两个批准迁移点声明该能力；新增声明属于新的合同审查，而不是内容作者自动获得的 surface。

Prepare 固定执行：

- 验证模板/recipe、owner/faction、规范请求键、地图边界、walkable、已有活单位占位、批内 reservation、重复请求与内容唯一性；
- 现役没有全局数字型“召唤容量”。本 ADR 的 capacity 定义为：所有请求必须各自拥有合法且互异的保留地格，并满足声明中的内容唯一性；`stored-or-declared-piece` 的现役能力固定 `maxSummons=1`，并按 owner/faction 兼容约束拒绝跨阵营恢复。新增全局数量上限必须另立规则/任务；
- 按规范键准备完整实例、全部 Rule/Status、运行时注册计划和数组插入计划；
- 按稳定顺序发送 `beforePieceSummoned`；若它修改位置，重新验证全部 reservation。

附着在权威 EffectChain 的 invalid 请求一律 fatal 并回滚，任何 facade 都不能把它转换成可忽略的失败结果。合法请求被 `beforePieceSummoned` blocked 时：

- queued writer 因作者无法同步观察结果，按 fatal queued-effect 处理并回滚根动作；
- chain 为 `idle` 的同步 `summonPiece` facade 可返回 `{success:false, blocked:true}`，但必须恢复本 Batch 的 Prepare 草稿与 queue，调用方按现有单体 API 决定根动作结果；
- 只有 `detached=true` 的低层兼容调用可把 invalid 转成旧式 `success:false`，不能作为权威行为。

首个稳定失败点之后不再发送剩余 before；失败批次不发送 after，技能/卡牌成本、传送、攻击加成、日志、extension 删除和 RNG 游标不留部分提交。

全部请求通过后，一次 Commit：把带完整 prepared Rules/Status 的所有实例加入 `battle.pieces`，并同时删除 `kiljaedanPiece` extension。Commit 后只允许注册不改变权威 PieceState 的运行时缓存；完成全批缓存注册后，才按稳定顺序发送任何 `afterPieceSummoned`。每个 after 因此能看到全批实例及其完整规则。返回结果对齐输入顺序。

鸣人 teleport 仍是根 SkillCode 中在 enqueue 前的显式顺序阶段；queued summon 若失败，根事务连同 teleport 回滚。其 clone ID 的逻辑 `Date.now` 调用、一次 `Math.random` 前/后选择、数组相对插入和 RNG 消耗保持现役算法。恶魔召唤保持“伤害 → 攻击 +1 → enqueue summon”，并保留仅在新建实例时的逻辑 `Date.now` 调用；extension 直到 Summon Commit 才删除。

### 8. DeathBatch 两 checkpoint 例外

DeathRequest 只接受仍在 `battle.pieces` 且 HP 已为 0 的唯一候选；主动把活目标降到 0 必须走 Damage。DeathBatch 通常由 Damage 的 lethal HP Commit 内生创建，首版 `deathQueue` 不公开给 SkillCode。

内生 DeathBatch 仍是完整 EffectBatch：分配自己的 batchId，计入四类共享的 100 Batch 预算；`parentBatchId` 等于产生它的 DamageBatch ID，`depth = parent.depth + 1`。Death lifecycle enqueue 的任何条目以 DeathBatch 为 parent，depth 再加 1。内生阶段没有 ledger enqueueSequence，诊断使用 `originStage='damage:death'`；普通 queued Batch 使用 enqueueSequence。示例：根 Damage D0(depth 0) → 内生 Death K1(parent D0, depth 1) → 亡语 Summon S2(parent K1, depth 2)。

Death 的明确例外阶段是：

1. **Freeze**：在生产者已统一提交 HP=0 后，按 `instanceId` 冻结 candidate membership、killer/source/skill/parent 元数据。这个“死亡可见 checkpoint”是 Death 的主状态输入。
2. **Lifecycle Emit**：所有候选先保持在 `battle.pieces`；按稳定顺序发送 `beforePieceKilled`、`afterPieceKilled`、`onPieceDied`，此阶段不移墓地。
3. **Revival decision**：所有 lifecycle 完成后统一读取每个候选 HP。HP>0 为复活，不进墓地、不授予 charge，结果 `isKilled=false`；为兼容既有单目标合同，复活者仍已发送 kill/death 事件。
4. **Finalization Commit**：对未复活者一次提交从 `battle.pieces` 移除、按稳定顺序加入 graveyard，并同时提交合法 charge。
5. **Post-finalization Emit**：按稳定顺序发送 `afterChargeGained`，随后继续共享 FIFO。

candidate membership 是 Freeze 时的事实：A 的生命周期若提前复活 B，B 仍会发送本批 lifecycle，但最终不入墓、不充能。现役逐目标实现会在轮到 B 前因 HP>0 跳过，因此这是为了同批语义而提出的明确兼容变化，必须有人批准并用固定 seed 测试锁定。

charge 归属继续使用 `killerPlayerId ?? attacker.ownerPlayerId`；死亡事件 source/target 保持现有合同。`afterChargeGained` 将观察到未复活死者已经统一入墓，这也不同于现役“充能时死者仍在场”，属于批准项。

Finalization 后必须再次检查死亡候选不变量：未复活者只能存在于 graveyard、复活者只能存在于 battlefield，二者不能同时出现；候选 ID、owner/source、HP/maxHp 等参与路由的数值必须有限且与 Freeze 记录兼容。生命周期消费者若在 Commit 后制造重复实体、非法 HP 或把已确认死者重新放回 battlefield，attached 权威 chain 必须 fatal 并回滚，不能把污染状态交给持久化层。

`kiljaedan-demonic-pact.json` 的强制移除继续写 `extensions.removedPieces`，不发送死亡事件、不入 graveyard、不迁移到 DeathQueue。

### 9. 共享预算、fatal error 与诊断

每次权威根动作尝试共享：

- 最大 Batch depth：20（根 Batch depth 0，任何 queued 或内生 child 为 parent + 1）；
- 最大处理 Batch：100，四类合计；每次进入 handler 均计 1，包含不经过 ledger 的内生 DeathBatch；
- 最大 effect/trigger dispatch：1000，四类 Batch 与触发器合计。

`fireEvent` 现有局部 depth 20 / dispatch 100 防线保留。处于权威 EffectChain 时，命中局部上限或动作级 1000 上限均抛 `EffectChainFatalError` 并回滚；detached/无 EffectChain 的旧调用仍保留现有 blocked `TriggerResult` 兼容。预算不因切换 kind、facade、事件 root 或同次 pending replay 的中间阶段重置。

`EffectChainFatalError` 是可识别的 `BattleRuleError` 子类/错误码族。所有 rule/card/skill dynamic runtime catch 必须原样重抛此错误和 pending 信号；不得包装成普通“执行失败”、返回失败结果或吞掉。EffectChain 锁存本次尝试遇到的首个 fatal 与 pending：即使作者代码用 `try/catch` 截获，root dynamic frame 退出前也会原样再次抛出。TriggerSystem 可以附加 event consumer 诊断，但保留原始 code/cause。

动态定义加载在 `chain && !chain.detached` 时是权威路径，不依赖当前是否正在处理 Batch。rule/skill/reactive card 的缺失、读取失败、JSON 解析失败、空引用或 RuleCode 编译失败都必须结构化 fail closed；合法 `battle.customCards` fallback 与已从手牌移除的 stale consumer 继续兼容。detached 或没有 chain 的旧 helper 仍保留 nullable/skip/soft-result 行为。这样可防止 PostgreSQL 恢复出的 JSON 状态在 profile 定义损坏时继续提交一条与其他房间不同的权威历史。

错误至少包含：

- `actionId`、`chainId`、`batchId`、`parentBatchId`；
- kind、depth，以及 enqueueSequence 或内生 `originStage`；
- processed/limit；
- turn、root seed；
- source/skill/target（适用时）。

### 10. 权威回滚与 pending

正常 `runBattleAction` 和 pending replay 在尝试开始时必须同时快照：

- 根 BattleState（继续在 clone 上执行）；
- RuleRuntime cursor/clock；
- TriggerSystem 的 next root event ID、rule limits 与本次可变内部状态；
- EffectChain ledger、计数与 ID 序列。

Validate、Prepare、Commit、Emit、queue drain、fatal budget 或动态 surface 任一步失败，均丢弃 clone 并恢复上述进程级状态；HP、实体、墓地、charge、手牌/资源、日志、rule limit 和随机流不留污染。低层 detached helper 本身不声称提供此权威保证。

挂起时不得提交或序列化半个 Batch/queue。pending 继续只保存现有 root action、答案序列和 RuleRuntime checkpoint；恢复从根 pre-state 重放，创建新 chain 并确定性重建相同 sequence/ID/计数。取消或恢复异常同样恢复 TriggerSystem 与 runtime 快照。

首个 pending 信号是本次执行尝试内的进程控制流，只存在于 EffectChain snapshot，不进入 BattleState 或 pending transaction。TriggerSystem 在 attached chain 中捕获到 pending 时立即向 chain 锁存；`runSuspendableActionTransaction` 在把结果视为成功前调用 chain health gate。成功转换成现有 pending state 后再确认并清除该信号。这样 SkillCode 或 RuleCode 即使 catch 了嵌套 `dealDamage` / `fireEvent` 的 pending，根动作仍回到 authority pre-state，并在 resume 时 exactly-once 重建 FIFO。

EffectChain 不加入 BattleState、存档、公共 patch 或网络协议。

### 11. PostgreSQL + Colyseus 适配边界

RED-139 的引擎层不直接依赖 `pg`、Colyseus Schema 或 Room API。正式适配边界冻结为：

1. `BattleState` 输入和成功输出保持普通 JSON 数据；runner 成功出口只剥离 hydrate 期间注入的 `rules[].effect` 函数，必须原样保留可序列化的同名 descriptor。EffectChain、sealed capability 品牌、pending/fatal Error 与 TriggerSystem runtime 都是进程内对象，不可序列化到 checkpoint、transition 或网络 patch。
2. 每个 Colyseus `BattleRoom` 通过 `restoreRoomRuleRuntime(roomId)` 持有独立 `RuleExecutionContext`。TriggerSystem、runtime cache、EffectChain 和预算不得跨房间共享；全局 fallback 只供 legacy/offline surface，不能作为 Room authority。
3. `dispatchRoomBattleAction` 只能在 `runBattleAction` 成功且 authority JSON clone/hash 检查通过后提交 `BattleState` 与 transition。fatal 时不推进 Room state/version、不写 transition、不广播 APPLIED；适配器可持久化不含 provisional state 的 rejected receipt。
4. 普通动作继续遵守 RED-160 已批准的 memory/journal commit 后 APPLIED、PostgreSQL 异步 durable 语义；终局继续等待 durable barrier。RED-139 不增加第二条 FIFO、同步数据库写或 EffectChain-aware journal。
5. pending 是一次成功的根动作结果，但持久化的是 authority pre-state 加现有 pending selection/transaction；任何 Batch ledger、已 Commit 一半的 HP/实体或进程内 Error 都不得进入存储。resume/timeout/cancel 继续作为新 Room command 从根 action 重放。
6. 从 PostgreSQL checkpoint 解析出的 JSON state，与同一进程内 state 或 `structuredClone` state 在相同 pinned profile、root seed、命令和独立 Room context 下必须得到相同结果、规范轨迹和后续动作状态；执行完成后所有输入/输出都不得残留 active EffectChain 或运行时函数，且连续第二个 action 仍须一致。stored-piece 规则水合时，代码及 `maxUses/cooldownTurns/duration` 等静态限制来自 pinned profile，只有 `uses/currentCooldown/remainingDuration` 三个已校验的运行时计数从持久化 descriptor 恢复；非法计数必须在 Commit 前 fatal。

本节不修改 RED-160 数据库 schema、网络 envelope、公共投影、authority/durable version 或拒绝 receipt 结构。如果未来需要把 Batch 诊断放入协议或数据库，必须另立合同和迁移。

边界限制必须明确：RED-160 的 terminal durable barrier 发生在规则与内存 authority commit 成功之后；其 PostgreSQL drain 若随后失败，不属于 EffectChain fatal，也不能由 RED-139 回滚为根 pre-state。当前 RED-160 还由 Room lifecycle 负责最终关闭 room runtime。首次失败响应/duplicate retry 与同进程 Room 重建的生命周期收敛若要改变，需修改 `lib/server/colyseus/**`，超出 RED-139 `allowed_paths`；本任务只保证规则 fatal 在 commit 前拒绝、pending 不携带半 Batch，并把该上游限制作为候选验证已知风险报告。

### 12. 可观察性、兼容例外、旧回放与 hash

不新增 BattleState、`battle.actions`、BattleActionTrace、存档或玩家网络协议字段。成功路径的 chain/batch/parent/depth 只通过：

- 现有/扩展后的 Damage、Heal、Summon、Death helper 结果；
- 对应 before/after TriggerContext；
- 测试进程外 recorder / fixture harness（不得写入 BattleState 的普通 `extensions.trace` 或其他参与 canonical hash 的字段）；

进行观察。fatal 路径通过结构化错误观察。`battle.actions` 现有 Damage payload 保持兼容；其他类型不为诊断新增 action type/payload。测试 recorder 不属于权威状态，也不参与 hash、存档或协议。

Linear 当前验收项 2 写作“单目标行为保持兼容”。批准本 ADR 同时表示批准如下限定：单目标公开 helper 的调用签名、基本结果和既有 Damage ABI 保持兼容，但第 5、8 节明确列出的 Reap timing/message、Death finalization 与 `afterChargeGained` 观察窗口属于获批例外。人工批准后必须先把这项限定同步回 RED-139 Linear 合同，再修改生产代码；若不批准，则 ADR 与 Linear 冲突，任务继续停在方案阶段。

旧 Trace v2 以记录状态播放，继续可查看，不用新运行时重新解释历史帧。旧 command-only replay 必须与生成它的引擎/profile 版本配对；不得宣称新引擎重跑受影响动作仍有旧 hash。

预期有意变化仅限：

- 多目标 Heal 的事件次数、顺序与状态；
- 同批 Death 的墓地/复活/charge 观察顺序，以及上段批准的单体 charge 观察例外；
- 三个迁移内容的 summon/death/follow-up 顺序、实例与日志；
- Reap triggerEffect 文本从“实际恢复 N”改为“触发收割”。

实现 PR 必须给这些固定 fixture 的旧/新轨迹和 state hash 对照，逐项解释差异。现有 `extensions.debugBattle` 仍按原合同排除在权威 state hash 外，但本任务不新增其 schema；不得关闭 hash、放宽比较或无证据更新快照。

### 13. 唯一数据迁移清单

RED-139 只申请迁移：

1. `data/rules/rule-reap.json`：同步 `healDamage` 改为 `context.healQueue.push`，接受第 5、11 节的 timing/message/hash 变化。
2. `data/skills/naruto-shadow-clone.json`：直接 splice/push 改为 content-bound `summonQueue` recipe，保留 teleport、逻辑时钟、随机前/后和三条固定规则。
3. `data/cards/demon-summon-5.json`：直接 push/delete extension 改为 content-bound `summonQueue` recipe，保留 damage → attack +1 → summon。

明确不迁移：

- `rule-hashirama-edo-regen.json` 是顺序型回合末恢复，未声明同时；统一治疗事件另建任务。
- `rule-elune-protection-player.json` 保持 Damage Prepare 致死拦截。
- `kiljaedan-demonic-pact.json` 保持强制移除。

若发现第四个必须迁移的生产调用点，先更新 Linear 与 ADR 并重新审批。

## 允许修改路径提案

批准本 ADR 表示批准以下最小生产范围：

- `lib/game/effect-batch.ts`（新建）；
- `lib/game/skills.ts`；
- `lib/game/triggers.ts`；
- `lib/game/turn.ts`；
- `lib/game/battle-runner.ts`；
- `lib/game/engine-browser-entry.ts`（仅 parity 导出）；
- 第 13 节三个 JSON；
- `tests/game/**` 中 RED-139 新增/直接相关回归；
- 本 ADR 与 `docs/decisions/README.md`；
- `docs/technical/DAMAGE_PIPELINE.md`；
- `docs/technical/COMBAT_EVENT_PIPELINE_AUDIT.md`；
- `docs/technical/COMBAT_TRIGGER_ATOMICITY_CONTRACT.md`；
- `docs/technical/SKILLCODE_AUTHORING_STANDARD.md`；
- `docs/technical/SKILLCODE_COMPATIBILITY_MATRIX.md`；
- 仅由 `npm.cmd run build:game-engine` 生成的 `data/pages/js/game-engine.js` 与 `android-client/www/js/game-engine.js`。

不修改依赖、battle state/save schema、BattleActionTrace、公共投影、网络协议、经济数值、随机算法或其他角色数据。若实现证明必须新增生产路径，先回到人工审批。

## 备选方案

### 通用 EffectQueue

拒绝。它允许任意宿主操作绕过四类白名单和专用 handler。

### 四个独立队列按类型优先级 drain

拒绝。它丢失真实 push 顺序并引入未批准的跨类型优先级。

### 每次 facade 新建 chain

拒绝。合法顺序调用可以工作，但 damage/heal 可分别重置预算，无法满足动作级上限。

### 所有 active chain 中的 facade 都 fail closed

拒绝。它会错杀眼棱、圣光降临、穆鲁的挽歌等根代码的合法顺序 helper；只有 `processing` 中直接调用才是重入。

### 为 Reap 增设提前 Heal checkpoint

拒绝。它会形成类型特权，或迫使现役 damageQueue 也提前执行。提案选择显式接受 Reap 在 Death 后按 FIFO 治疗。

### 把 queue 写入 pending/BattleState

拒绝。根动作重放足以重建；序列化会扩大存档和协议并产生新全局状态源。

## 影响与风险

收益：

- 四类“同时”语义可穷举、可测试；
- 合法根 helper 顺序与 handler 重入边界清晰；
- Heal、Summon、Death 获得统一提交和稳定观察点；
- 四类共享 FIFO、预算、诊断、pending 与权威回滚。

风险：

- Reap timing/message、Death 跨目标复活和 charge 观察状态是明确行为变化；
- 封闭 summon recipe 若遗漏现役字段、ID/RNG 消耗或 extension 所有权会改变 hash；
- TriggerSystem 状态若未纳入事务会在失败后漂移；
- fatal error 若被动态 surface 吞掉会留下半提交；
- Room runtime 若复用全局 TriggerSystem/cache，会造成跨房间顺序依赖；非 JSON 瞬态对象若泄漏到 BattleState，会破坏 PostgreSQL 恢复；
- bundle 未重建会造成 Node/browser ABI 漂移。

## 验证方式

实现 PR 至少提供：

1. 四类联合的编译穷举和未知 kind 失败测试；不存在通用 callback/`effectQueue`。
2. 同 Batch 输入换序的 ID、规范轨迹、结果对齐与 state hash；queue push 顺序 FIFO。
3. 眼棱、圣光降临、穆鲁的挽歌真实内容回归，证明多次根 facade 合法且共享预算。
4. HealBatch：source/per-target blocked、数值修改、过量治疗、统一 HP Commit、after 顺序、`healQueue`、重入和结果对齐。
5. Damage：现役 DamageBatch/`damageQueue` 全回归；Reap 的旧/新 timing、message、state hash 对照。
6. Summon：同格/现役占位/越界/不可走/唯一性、before 改位再验证、整批失败原子性、sealed recipe 能力拒绝、鸣人 ID/RNG/插入、恶魔 extension Commit。
7. Death：冻结候选、A 复活 B、单体复活、亡语、统一墓地/charge、`afterChargeGained` 观察状态和固定 seed。
8. damage↔heal、summon↔death 跨类循环共享 20/100/1000，上限错误含全部诊断。
9. rule/card/skill surface 原样重抛 fatal；attached batch 与 idle chain 的 rule/skill/reactive-card 缺失、解析和编译失败均 fail closed；detached nullable 兼容；失败后 state hash、TriggerSystem event ID/rule limits、runtime cursor、日志均恢复。
10. pending 挂起/恢复/取消/异常：不保存 queue；SkillCode catch `dealDamage` 和 RuleCode catch nested `fireEvent` 都不能吞掉 pending；resume 恰好结算一次，同一重放 attempt 不重置预算，轨迹/hash 不重复不丢失。
11. PostgreSQL/Colyseus 边界：两个独立 Room context 不共享 rules/cache/chain；direct、`structuredClone`、JSON round-trip 后相同 action/seed 的结果、轨迹和第二个连续动作一致；真实 `dispatchRoomBattleAction` 和实际 Colyseus `BattleRoom` 中 attached EffectChain fatal 只保存 rejected receipt，不推进 authority version、不提交 transition，随后正常 action 仍可提交；pending 不持久化 ledger。
12. 重建两个 `game-engine.js`，同 fixture 比较 Node/browser 轨迹、结果、错误和 hash。
13. 聚焦 Vitest、RED-160 authority/Colyseus 回归、受影响模块、完整 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run check:encoding`、`git diff --check`、`npm.cmd run check:main-baseline`。
14. 未参与实现的独立 AI/人工依据原始合同审查；必要的双玩家 Electron 候选版本人工验收。

### 实现证据（2026-08-31）

`tests/game/red-139-hash-evidence.test.ts` 在精确基线 `6e6ae8dd88928dc285c0cbb7a5be7e3c121ae9a2` 与当前实现上使用同一固定 seed `9109817`、同一 pre-state 和同一 action。四个场景的 authority/peer state、action 与 trace hash 在各自引擎内全部相等；不同引擎之间的 `preStateHash` 和 `actionHash` 也保持一致，因此下表差异来自本 ADR 批准的结算语义，而不是输入漂移。

| 场景 | 相同输入 | 基线 `stateHash` / `traceHash` | 当前 `stateHash` / `traceHash` | 有意变化 |
| --- | --- | --- | --- | --- |
| Reap lethal | pre `b155cf72ec5aa2682aef30026d983b5ac6b3c3f664f7506295f77e36786b9f96`；action `86b6621cc98591ba867d4dcc1369552cee3f6dd57a72382f90976f555f0aafd9` | `ff38c18f7e32e83e9bec611c7709efef5ca25788bb595faaaab691b7c751141f` / `e3f87df112121f626c274921199ddc2ca2413c3adb69aff90605f9bb96b36bd3` | `a6aacd9ee1bd2e2420c7b563519e05f2b075b2a27ae52900f4bfc79cce84893a` / `50cdde08b5f5fe8f38bc593e40fcabdbeac5e5b5e4bdfc5337d5a2907f667a44` | `beforeHealTaken → killed → died` 改为 `killed → died → queued Heal`；治疗窗口可见 victim 已入墓、charge 已提交；消息改为“触发了收割”。recorder hash：`6228f583…7ad0e` → `530515d5…aa278`。 |
| Naruto clone | pre `38bc773b9c6f99f4bc3d8359d649748631922f3d6545aabd51b433d286b59a97`；action `a1387b7c5d6904324b3e16006fafbec7eeafff7e6fb3ffbda6f749a27cb922cb` | `1e29a07a450ed647d1fc1284a333a6276bc8f97f430a19ee8a480866c19ce509` / `30322decda9e0aa1cae6812f8d850300013a52f39d42c8381b31c2913d432ad5` | `0fb2654310e49088653c271a8ab5ce3ec426c12bd3a848851e5d07e92e58dcf9` / `160c3da5b1de37072eda282d174b79f693dbb885c4c8defa9b43f326e129f210` | 新增 Summon before/after（Commit 前后 off-board/on-board）；clone ID、随机相对插入与 RNG cursor 保持；展示技能冷却从旧脚本复制出的 `3` 规范化为 `0`，relatedRules 去除重复。transition：`93bb07fb…8053` → `b9a3c5f8…6d7c`。 |
| Demon stored restore | pre `42d32c426d61e7a12fd89c81bf7646ff83ebb9a29f6548d75ad98c05d1597c34`；action `696762c7b3113fb7c65dce2b5711a92803223d2dd3fb12d54bbefed0cbfa5061` | `45e8c15e0618f0dd1304c98dd99a2ef60663356bc09f626182e4b39d648f8c15` / `f284f3462e2d7f393478ce8b1a7f71dfd4eade570b737c254056bf096bad3c58` | `3b801c4a1540501fdbe313866f9bfd626325290e782c80450f6573cf8fe5d047` / `aa70e28c131ca62a3c06dc33a59721c076ec515b5eca2f03b683c95d3b35652e` | 最终 KJ identity/HP/skills/status、anchor HP/attack、AP/hand/discard 不变；extension 在 before 仍存在，统一 Commit 删除，after 才能观察 on-board。 |
| Demon fallback create | pre `cf21fcd2b4db666812f04218ae615191899d9c961a528fb1345f5dfd457fb99c`；action `14a8b69077d6c13972431bbbe852ca72d180d430af0f4f3a2c0a1decdd91705f` | `b88e743b946f0b332cd0180bab2f590c67bc35d318606b9498fa16bc2cc65132` / `39192ec19b28605d8a7fc3f21618b10682223f94cdd04bf6584254c258116809` | `a23fb6e99fb52c52c53c67a87959afa83e6370ba7c227468e167dff8e332a2d1` / `06a7f0412391b3f9628524de56690a9cb4c417da0f6d516d8c1c9768706026ce` | 生成 ID `kiljaedan-player-red-1000000`、最终棋子投影和 damage → attack +1 → summon 顺序不变；新增 sealed Summon lifecycle 与 batch 元数据。 |

Reap 的 action-message hash 从 `477c3a2a5ec90c152c614985f3bc591d86fc0a6faa5d5ff1fe3ac6dbf343e16a` 变为 `365b5933c52697d60fc3e7395da1d5ef8261e97a3879b93ad0d594d76fca38df`；Naruto 与两个 Demon 场景的 action-message hash 不变。基于当前 RED-160 兼容实现重建的两个浏览器 bundle 字节相同，SHA-256 均为 `D843D84D400C044B0DED22AFC38DC68E8586EAFF2860182E34DEDAD0070A81CC`。

## 回退方式

实现按依赖分阶段提交，回退按以下顺序使用普通 revert：

1. 先回退 SkillCode facade、三个数据迁移和生成 bundle；
2. 再回退 Heal/Summon/Death handler；
3. 最后回退内部 scheduler、BattleRunner/TriggerSystem 事务接入；
4. 保留本 ADR、失败轨迹和旧/新 hash 证据；若方案放弃，将 ADR 状态改为“已废弃”。

不得删除存档、关闭 hash、吞异常、恢复不确定递归或使用破坏性 Git 操作。

## 人工批准记录

项目负责人于 2026-08-31 明确批准以下完整方案；批准后已先同步更新 RED-139 Linear 验收项 2、初始 `base_sha` 与 `allowed_paths`：

1. 只有 Damage、Heal、Summon、Death 可声明 Batch；
2. 接受第 12 节的单目标兼容限定，并授权批准后先同步更新 RED-139 Linear 验收项 2；
3. 根动作唯一 chain 的 `idle`/`processing` 重入边界和跨类型共享 FIFO；
4. Damage/Heal 生命周期同时拥有 damage/heal writer，以及 content-bound summon 能力矩阵；
5. Heal blocked/Commit/after 顺序；
6. Reap 改为 Damage after + Death 完成后治疗，以及 message/hash 变化；
7. Death 两 checkpoint、parent/depth/budget 和冻结候选；A 复活 B 后 B 仍发送 lifecycle；
8. Finalization 后才发 `afterChargeGained`；
9. content-bound 鸣人 clone / 基尔加丹 restore sealed recipe，禁止任意 piece/callback；
10. attached invalid 与 queued Summon blocked 导致根动作完整回滚；
11. 动作级 20 depth / 100 batches / 1000 dispatches 与 fatal error 穿透；
12. pending 重放、TriggerSystem 事务快照、进程外测试 recorder 与无协议字段变化；
13. 三个且仅三个数据迁移点、排除项、允许路径，以及旧回放/日志/state hash 证据方式；
14. 在 RED-139 当前任务内直接兼容 PostgreSQL + Colyseus：不另开任务、不引入引擎依赖、不改 DB schema/网络协议；采用每房间 `RuleExecutionContext`、普通 JSON BattleState、成功规则归约后才提交 authority transition，pending 从根 pre-state 重放且不序列化 EffectChain。该补充已同步 Linear；首次在 RED-160 集成基线 `8902c0da94957fdb52d142363c2c45a2ebda7a7f` 上完成，并在提交候选前继续 rebase 到 `b0a5c3fb99b68b2a7e174c03b2b0c0a4b30b6926`。

上述技术方案与 PostgreSQL + Colyseus 兼容补充均已获得明确批准并同步 Linear；实现完成后仍需独立审查与人工验收，不得自行合并或发布。

## 相关资料

- Linear：RED-139。
- `docs/decisions/ADR-0004-deterministic-rule-runtime.md`。
- `docs/decisions/ADR-0006-combat-trigger-ordering.md`。
- `docs/decisions/ADR-0008-rule-status-authority.md`。
- `docs/decisions/ADR-0010-deterministic-damage-batches.md`。
- `docs/decisions/ADR-0011-authoritative-terminal-settlement.md`。
- `docs/decisions/ADR-0015-authoritative-pending-interaction-lifecycle.md`。
- `docs/decisions/ADR-0016-trace-v2-recorded-state-replay.md`。
- `docs/qa/RED-160-colyseus-postgresql-vertical-slice.md`。
- `docs/technical/DAMAGE_PIPELINE.md`。
- `docs/technical/COMBAT_EVENT_PIPELINE_AUDIT.md`。
- `docs/technical/COMBAT_TRIGGER_ATOMICITY_CONTRACT.md`。
