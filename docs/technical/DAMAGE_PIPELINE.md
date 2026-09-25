# 确定性伤害管线（RED-33 / RED-139）

权威 Damage handler 位于 `lib/game/skills.ts`，动作级调度器位于 `lib/game/effect-batch.ts`。`dealDamage()` 保留数据脚本兼容签名：单目标返回 `DamageResult`，数组返回 `DamageBatchResult`，且数组 `results` 与调用方输入顺序对齐。内部结算和权威状态始终使用目标 `instanceId` 稳定顺序；同一权威根动作中的 Damage、Heal、Summon、Death 共享一个瞬态 `EffectChain`。

## 阶段

| 顺序 | 阶段 | 可观察结果 |
| --- | --- | --- |
| 1 | 预检 | 来源有稳定 ID；目标存活且属于战斗；目标不重复；数值有限非负；类型合法 |
| 2 | `beforeDamageDealt` | 每 batch 一次，来源效果修改或阻止基础伤害 |
| 3 | `beforeDamageTaken` | 每目标一次，免疫、完整抵挡、目标侧修改和反射登记 |
| 4 | defense / minimum | physical、magical 减 defense；true、toxin 忽略；正数有效伤害最低 1 |
| 5 | `beforeDamageShield` | 数值护盾吸收 defense 后伤害；`PieceInstance.shield` 是保留的数值兼容字段 |
| 6 | `beforeDamageApplied` | 使用最终候选伤害判断致命拦截，不重复计算 defense |
| 7 | HP commit | 同批所有目标先统一扣 HP |
| 8 | after / DeathBatch | `afterDamage*` 完成后，致命目标进入一个内生 DeathBatch；全部候选先完成 lifecycle，再统一判定复活并提交墓地/合法充能结晶 |
| 9 | follow-up | 当前阶段登记的 typed writer 按共享 enqueue sequence FIFO 处理，直至动作级 chain 清空 |

合法的 0 伤害不派发 after-damage。完整抵挡和完全吸收为 `blocked: true`、`damage: 0`，派发一次 `afterDamageBlocked`。

## 结果与日志

每个 `DamageResult` 包含：

- `batchId`、`chainId`、可选 `parentBatchId`；
- `sourceId`、`targetId`、`skillId`、`damageType`；
- `rawDamage`、`modifiedDamage`、`defense`、`shieldAbsorbed`、`resolvedDamage`、`damage`；
- `damageSource`：棋子、玩家或环境来源的类型、来源ID与玩家归属；
- `blocked`、`isKilled`、`targetHp`。

同样的字段写入 `battle.actions` 的 `type: "damage"` 日志，最终伤害字段名为 `finalDamage`，并额外记录 `killed`。这些日志属于权威状态和固定 seed hash 证据。

RED-192：`resolvedDamage` 是防御、减伤和护盾结算后的伤害，`damage` / `finalDamage` 是实际生命损失，上限为目标扣血前的生命值；吸血和伤害后触发使用后者。所有数值计算逐步向下取整，真实伤害仅绕过防御。`DamageSource` 的玩家和环境来源不伪造 `sourcePiece`，寒冰坚忍只反冻造成实际生命损失的敌方棋子。

巫妖誓约通过 `summonAfterDeath.revive` 在正式死亡后复活。初始能力模板用于清除死前增益、恢复初始属性；之后再计算复活加攻，保留核心身份、独立每局限用和被动已触发记录。规则版本及统一状态/回合阶段见 [RULE_LIFECYCLE.md](RULE_LIFECYCLE.md)。

## 伤害连锁与错误

RED-215 保持现有 SkillCode 的 `dealDamage` 调用方式。同一权威动作内，某个目标已由引擎正式完成死亡结算，后续伤害仍传入该原对象时，返回成功的零伤害结果：不抵挡、不再次击杀、不发送伤害或死亡事件。数组调用保留该结果的位置，其余存活目标继续按原规则结算。每段仍独立执行，不合并多段伤害，也不推迟第一段死亡。

跳过结果增加可选 `skipped: 'target-already-dead'`，`success: true`、`damage: 0`、`blocked: false`、`isKilled: false`、`targetHp: 0`；保留本次请求的来源、目标、技能、batch/chain 标识和 `rawDamage`。现有脚本不必读取新字段。它不生成新的 `damage` 日志，因此不会冒充一次命中或再次触发击杀收益。

该同步调用兼容只基于瞬态 EffectChain 的正式死亡记录，不凭目标 ID 或墓地中存在同名对象放行。同步调用中的未知对象、其他动作的死亡对象、非法伤害参数及非法重入仍然拒绝；真实异常仍使整个权威动作回滚。原始目标的生命、位置和墓地归属不会因跳过而改变。已有 `depth > 0` 队列对失效目标的过滤规则保持不变，不属于此次新增的放行范围；但同链已登记死亡对象的 HP／墓地归属被破坏时仍报错。脚本不需要新增生命检查，但任意脚本自身的其他逻辑错误不在此兼容范围内。

当前正式反射和 after-damage follow-up 规则通过 trigger context 的 `damageQueue` 登记：

```js
context.damageQueue.push({
  attacker: reflector,
  target: attacker,
  damage: context.damage,
  damageType: 'true',
  skillId: 'reflect-skill-id'
})
```

子 batch 只在父 batch 的固定阶段完整提交后执行。每个权威根动作共享最大 depth 20、四类合计 100 Batch、effect/trigger 合计 1000 dispatch；超限分别抛 `RVB_EFFECT_CHAIN_DEPTH_LIMIT`、`RVB_EFFECT_CHAIN_BATCH_LIMIT` 或 `RVB_EFFECT_CHAIN_DISPATCH_LIMIT`。伤害消费者中直接再次调用 `dealDamage()` 继续抛 `RVB_DAMAGE_REENTRANT_CALL`；其他非法 scheduler 重入抛 `RVB_EFFECT_CHAIN_REENTRANT`。动态 rule/card/skill surface 必须保留原错误 code、context 与 cause。

权威 `runBattleAction()` 在失败时回滚 BattleState、RuleRuntime、TriggerSystem 和 EffectChain 快照；低层 detached helper 不声称具备动作级原子性。当前志志雄自燃自伤与所有反射规则使用 `damageQueue`；收割在 `afterDamageDealt` 登记 `healQueue`，等 Damage after 与内生 DeathBatch 完成后再按共享 FIFO 治疗。

## 代伤（RED-213）

原始攻击在 `beforeDamageTaken` 之前派发 `beforeDamageRedirect`，提供一次性的 `context.damageRedirectQueue.push({ target: protector })`，成功返回 `true`。规则负责存活、阵营、范围和状态资格；接口验证保护者仍为战场中的存活实例且不是原目标。登记成功后跳过原目标的 `beforeDamageTaken`，不扣血、不消耗防御/护盾、不触发 `afterDamageBlocked`，返回成功结果并在日志记录 `redirectedTo`。独立阶段保证该顺序不受棋子数组排列影响。

代伤仍使用现有 FIFO：绑定原攻击来源、类型、技能、选项及源方增益后的伤害，保护者从目标侧阶段开始结算，不再次执行 `beforeDamageDealt`。保留原始 `rawDamage`，以源方处理后的数值进入防御、护盾、伤害后事件及死亡流程。代伤子批次不暴露该接口，防止两个保护者循环转移。普通 `damageQueue` 不接受内部代伤字段。

父范围伤害或较早的队列伤害可能先杀死保护者；此时该次代伤回退给原目标（同样不重复源增益、不再转移）。两者均已失效则跳过。每个队列伤害分别提交，避免同一保护者在一个范围批次中重复使用 HP 快照而覆盖伤害。代伤绑定、队列和标记均属于瞬态动作结算，不新增存档状态。

该接口需要更新权威引擎；只更新资源包不能让旧服务器获得代伤能力。

## 生命周期与可争夺充能结晶

一次 DamageBatch 中，每个起始存活且 HP Commit 后为 0 的目标冻结进入同一个内生 DeathBatch。所有冻结候选在整个 `beforePieceKilled`、`afterPieceKilled`、`onPieceDied` 阶段都保留在 `battle.pieces`；这些阶段不允许恢复其 HP 或改变死亡归类。全部 lifecycle 完成后，候选一次性从战场移除并按稳定顺序进入墓地；其中 `isCore=true` 且未声明 `noKillCharge` 的正式棋子在冻结的死亡坐标生成 `charge-crystal` 公共地格效果。DeathBatch 不再授予通用即时 CP，也不派发 `afterChargeGained`；需要“死后回场”的效果在死亡完整提交后创建新棋子并走召唤流程。

结晶保存在 `battle.extensions.tileEffects`，进入公开快照、状态 hash、回放、AI v2 `boardEffects` 及 2D/3D 棋盘展示。整批墓地与结晶提交后按稳定顺序派发 `afterChargeCrystalDropped`，每次派发后继续执行 DeathBatch 完整性检查。权威普通 `move`、渐进式预备区部署、模板 SummonBatch 及死亡完整提交后的原地重新召唤，都在成功提交后按新棋子最终落点收集：同格全部结晶原子移除，棋子所属队伍每枚获得 1 CP，并以合计数量派发一次 `afterChargeGained`。原地站立、传送、变身和强制位移不调用收集阶段。霜之哀伤的立即 +1 CP 是内容脚本特例，不替代正式受害者的结晶。

结晶生成不再依赖敌我或 `killerPlayerId`：敌对击杀、手牌牺牲友军与其他完整死亡都统一只看受害棋子的 `isCore` / `noKillCharge` 资格。资源归属取决于之后实际拾取结晶的队伍；ADR-0028 的手牌友军击杀即时充能决策已被 RED-185 取代。

玩家级 `mangekyoDeathCount` 是【万花筒】动态充能成本的权威累计值：`max(0, baseChargeCost - mangekyoDeathCount)`。强制移除不经过本管线，不派发死亡事件，也不写入墓地。

动作入口等整个 EffectChain 清空后由 `finalizeBattleTerminal()` 统一检查终局，因此可以同时观察双方核心全灭并判平局；pending 期间不序列化半个 Batch/queue，而是保留根动作 pre-state，并在回答后从根动作确定性重放。
