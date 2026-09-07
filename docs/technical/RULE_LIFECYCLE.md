# RED-192 规则执行约定

产品含义见 [基础规则词典](../product/RULE_DICTIONARY.md)。

## 状态入口

`status-lifecycle.ts` 为棋子和玩家状态共用的添加、合并、移除、来源撤销、到期实现。技能、卡牌、ruleSkillCode、triggerSkill 的状态 facade 都调用这一实现。

`remainingDuration` 为规范计时值，同时维护旧 `currentDuration` 字段，便于现有显示端读取。新状态写入 `appliedTurn`、`expiresAfterTurn`、`ownerTurnCycle`；结束阶段用 `lastDurationTickTurn` 防止重复递减。实际到期时间用于比较，不用原始时长合并。

`statusOrigins` 保存合并贡献。按规范状态ID移除代表解除整个效果；非规范来源alias只撤销该贡献。`removePieceStatusSource` 用于撤销一个来源的贡献。共享规则只有在无人引用后才清理。

规则作者应先为新状态登记 `STATUS_DEFINITIONS`。未登记的自定义内容保留独立实例，不推断叠加行为。角色私有进度由对应规则维护；通用限时效果禁止另写倒计时。`expiresAtTurnEnd` 用于“本回合仅一次”等明确的内部回合标记，不能冒充“持续1回合”。零持续时间只允许显式 `lifetime: 'event'` 的事件临时载荷，由所属事件清理。

## 阶段与来源

`turn.refreshedAtTurn` 是回合刷新检查点，部署或互动恢复不能再次降低冷却。基础AP保留原有切换阶段的数值刷新方式，开始效果不会覆盖其后的额外AP。

伤害结果同时记录 `resolvedDamage` 和 `damage`；后者及伤害后事件使用实际生命损失。`DamageSource` 区分棋子与 `player` / `environment`，非棋子来源只携带归属，不作为 `sourcePiece` / `targetPiece` 传入反击规则。

`changePiecePositions` 提供批量落位校验与 `beforePiecePositionChange`，支持 `walk/dash/teleport/push/pull/swap`。离场与召唤使用原有生命周期。现存可信脚本仍有坐标直写，技能及权威行动出口继续按同一禁锢谓词检查；后续作者应使用公共入口，不能把直接修改坐标当作绕过限制的方式。

## 复活与兼容

棋子创建时保存 `initialDefinition`，复活以它恢复初始属性与能力。死亡批次冻结、事件、移入墓地及结晶事件全部完成后，才提交新的复活实例。`revive` 保留正式核心归属；普通死亡后召唤继续使用原有非核心行为。限定技能消耗另存于 `limitedSkillUses`，清状态和重置冷却不会恢复次数。

`usesPerBattle` 可为普通或充能技能声明每局次数，卍解使用此声明。飞段的不死已触发记录放在 `spentPassives`，与复活时清除的状态分开。展示回放帧不重复保存初始能力模板；可执行权威状态和其hash仍包含该模板。

主技能与pending回调通过 `context.changePositions` 使用公共位移入口，普通走格也经过该入口；落点统一拒绝地形、占用和预留格。现有双尾预留及后续 `blocksLanding` 地格效果遵循相同限制。

执行版本提升为 `rvb-battle-runner/v2`，存储envelope仍使用原有格式。旧pin明确拒绝执行，包括空动作回放；不读取旧状态后偷偷补新计时字段。撤销本任务提交可恢复旧引擎，但不能无损转换已按新规则运行的对局。
