# 确定性伤害管线（RED-33）

权威实现位于 `lib/game/skills.ts`。`dealDamage()` 保留数据脚本兼容签名：单目标返回 `DamageResult`，数组返回 `DamageBatchResult`，且数组 `results` 与调用方输入顺序对齐。内部结算和权威状态始终使用目标 `instanceId` 稳定顺序。

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
| 8 | after / lifecycle | `afterDamage*`、kill、died、复活检查、充能、墓地按稳定顺序执行 |
| 9 | follow-up | `damageQueue` FIFO 处理反射子 batch，直至 chain 清空 |

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

子 batch 只在父 batch 完整提交后执行。深度超过 20 抛 `RVB_DAMAGE_CHAIN_DEPTH`；累计超过 100 个 batch 抛 `RVB_DAMAGE_CHAIN_BUDGET`。伤害消费者中直接再次调用 `dealDamage()` 不会建立绕过预算的新 chain，而是抛 `RVB_DAMAGE_REENTRANT_CALL`；动态 rule skillCode 不得吞掉该错误。所有这类错误都包含 chain、parent batch、depth、turn 和 root seed。

权威 `runBattleAction()` 按 RED-72 回滚整个命令；低层 helper 的非法输入在任何触发器前失败。当前志志雄自燃自伤与所有反射规则均使用 `damageQueue`。

## 生命周期与充能

一次 batch 中，每个起始存活且最终为 0 的目标只进入一次生命周期。`onPieceDied` 执行后若目标恢复为正生命，不进墓地也不提供充能；否则敌方击杀者获得 1 充能，显式 `noKillCharge` 目标除外。目标随后按稳定顺序移入墓地。

动作入口等 damage chain 清空后由 `finalizeBattleTerminal()` 统一检查终局，因此可以同时观察双方核心全灭并判平局；pending 复活/选择未完成时继续延后。
