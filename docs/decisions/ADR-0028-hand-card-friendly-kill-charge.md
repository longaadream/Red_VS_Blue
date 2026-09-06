# ADR-0028：手牌友军击杀使用出牌玩家的充能归属

- 状态：已被 RED-185 取代
- 日期：2026-09-04
- 关联：RED-183
- 曾取代：ADR-0010 第 9 条中“击杀归属玩家与目标敌对”的单一充能条件
- 后续决策：[`ADR-0028-contested-charge-crystals.md`](./ADR-0028-contested-charge-crystals.md)

## 背景

ADR-0010 将充能限定为敌对击杀。RED-183 当时要求：玩家通过手牌将己方棋子的生命降至 0 并完成死亡结算时，出牌玩家也获得 1 点击杀充能。此即时充能模型已被 RED-185 的可争夺充能结晶取代。

## 原决策（历史）

1. 手牌伤害 facade 必须将出牌玩家 ID 写入 `killerPlayerId`。
2. DeathBatch 在目标与击杀归属玩家敌对时继续正常充能。
3. DeathBatch 在目标与击杀归属玩家同阵营时，仅当请求显式携带同一 `killerPlayerId` 时充能；这是手牌入口的权威标记。
4. `noKillCharge: true` 始终优先，无论敌我都不提供充能。
5. 复活、强制移除、重复死亡和其他 ADR-0010/0022 生命周期语义不变。

## 取代后的现行行为

手牌伤害仍可保留 `killerPlayerId` 作为来源归属，但 DeathBatch 不再据此立即增加 CP。只要受害者是 `isCore=true` 且未声明 `noKillCharge`，无论敌我与击杀来源都生成公共结晶；最终获得 CP 的是之后拾取结晶的队伍。
