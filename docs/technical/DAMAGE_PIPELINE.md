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
| 8 | after / DeathBatch | `afterDamage*` 完成后，致命目标进入一个内生 DeathBatch；全部候选先完成 lifecycle，再统一判定复活并提交墓地/充能 |
| 9 | follow-up | 当前阶段登记的 typed writer 按共享 enqueue sequence FIFO 处理，直至动作级 chain 清空 |

合法的 0 伤害不派发 after-damage。完整抵挡和完全吸收为 `blocked: true`、`damage: 0`，派发一次 `afterDamageBlocked`。

## 结果与日志

每个 `DamageResult` 包含：

- `batchId`、`chainId`、可选 `parentBatchId`；
- `sourceId`、`targetId`、`skillId`、`damageType`；
- `rawDamage`、`modifiedDamage`、`defense`、`shieldAbsorbed`、`damage`；
- `blocked`、`isKilled`、`targetHp`。

同样的字段写入 `battle.actions` 的 `type: "damage"` 日志，最终伤害字段名为 `finalDamage`，并额外记录 `killed`。这些日志属于权威状态和固定 seed hash 证据。

## 伤害连锁与错误

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

## 生命周期与充能

一次 DamageBatch 中，每个起始存活且 HP Commit 后为 0 的目标冻结进入同一个内生 DeathBatch。所有冻结候选在整个 `beforePieceKilled`、`afterPieceKilled`、`onPieceDied` 阶段都保留在 `battle.pieces`；全部 lifecycle 完成后才统一读取 HP。已恢复为正生命者不进墓地、不提供充能，但兼容保留本次 kill/death 事件。其余候选一次性从战场移除、按稳定顺序进入墓地并提交合法充能；`afterChargeGained` 因此观察到未复活死者已经离场。

玩家级 `mangekyoDeathCount` 是【万花筒】动态充能成本的权威累计值：`max(0, baseChargeCost - mangekyoDeathCount)`。强制移除不经过本管线，不派发死亡事件，也不写入墓地。

动作入口等整个 EffectChain 清空后由 `finalizeBattleTerminal()` 统一检查终局，因此可以同时观察双方核心全灭并判平局；pending 期间不序列化半个 Batch/queue，而是保留根动作 pre-state，并在回答后从根动作确定性重放。
