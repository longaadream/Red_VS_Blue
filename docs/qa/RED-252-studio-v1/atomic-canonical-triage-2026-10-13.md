# RED-252 原子 canonical 行为分诊（2026-10-13）

本记录针对 `tests/atomic-vitest.config.ts` 的 canonical 配置。该配置会在测试调用 `applyGameplayModuleGraph` 时先经过 `migrateAtomicAuthorGraph`，因此结果代表当前原子迁移图和真实规则宿主的组合行为。

基线命令：

```text
npx.cmd vitest run --config tests/atomic-vitest.config.ts --maxWorkers=1 --reporter=json --outputFile=output/atomic-current-canonical-suite.json
```

基线结果为 **114 个 suite、906 个测试：853 通过、53 失败**。该结果记录的是 root 修复 missing-event 控制依赖之前的快照；按约定没有再次运行完整 canonical suite，也没有运行全量 game suite。

## 53 项分类

| 分类 | 数量 | 具体文件/现象 | 判断 |
| --- | ---: | --- | --- |
| 结构/生成图断言 | 9 | `gameplay-module-amaterasu.test.ts`；`gameplay-module-followup-status-rules.test.ts` 注册图；`gameplay-module-holy-support.test.ts`；`gameplay-module-kenshin.test.ts`；`gameplay-module-lament.test.ts` 自定义图保留；`gameplay-module-sage-totsuka.test.ts`；`gameplay-module-shishio-flame-spirit.test.ts`；`gameplay-module-shishio-velen-colt.test.ts`；`gameplay-module-velen-skills.test.ts` | raw builder 与 canonical 重写图/正式生成代码不同，首个行为差异之外的结构兼容问题；不是本报告的状态回归证据。 |
| remaining authoring 预检注册表 | 1 | `gameplay-module-remaining-authoring.test.ts:201`；7 个 code 入口报告 `registry descriptor does not match requested module (registry.attribute.text)` | 注册表描述符不匹配，需单独修预检，不应改测试期望。 |
| 缺失/离场引用、状态不变但返回形状不同 | 28 | follow-up rules 2（Grimmjow move/skill source-death）；follow-up-status 2（Ulquiorra/Illidan holder）；icebound 1（离场 attacker）；Lament 1（missing player）；Meteor 1（missing guard）；passive-setup 3（Lucky missing player、Demonic missing holder/owner）；player-protection 1（`rule-elune-protection` missing holder）；projectiles 1（Blizzard missing player）；recovery 3（Shishio subject、Hashirama holder、Tirion glory holder）；status-events 3（Naruto tick、Watcher shield、Arthas icebound）；Watcher Ultimate 9（owner=false，hand size -1/0/1/2/5/8/9/10/11）；`gameplay-modules.test.ts` Lucky Coin missing player 1 | 与“失效引用跳过当前/依赖语句、独立语句继续；自然成功可无 message”的批准语义相符，返回 `{success:false,message:''}` 与自然成功/无 message 的差异仍应由 root 逐项确认。 |
| 缺失 event subject 仍发生效果 | 10 | 见下表；新增 `tests/game/gameplay-module-atomic-missing-subject.test.ts` | 明确状态/队列/上下文副作用回归；不能按失效引用语义放宽。 |
| 正常输入状态回归 | 2 | Elune protection source lookup；Divine Shield reaction output | 真实合法输入产生状态或结果差异，需修 production/语义，不改预期。 |
| Rafaam 兼容差异 | 3 | `gameplay-module-rafaam-curse.test.ts:229,240,255` | end-turn 文本差异（旧结果含 `undefined`，canonical 不含）；ward/generated-card 另有生成 code 字段差异，state/RNG/presentation 主体已相同或测试已按 verified code 归一化；单列跟踪，不混入失效引用。 |

## 10 个缺失 subject 副作用回归

新测试直接加载冻结 rule fixture，生成当前 semantic graph，在 `rule.effect` 入口传入 `piece/sourcePiece: null`，只断言不产生权威效果；没有把 legacy 返回值形状作为唯一通过条件。

| 规则 | 真实输入 | 修复前证据 | 需要保持的结果 |
| --- | --- | --- | --- |
| `rule-grimmjow-resurreccion` | death event `piece=null, sourcePiece=null`，holder HP=0 | 返回 `summonAfterDeath` 豹王 profile | 不返回 summon profile，pieces/graveyard 不变 |
| `rule-arthas-lich-covenant` | 同上，holder 有 lich-covenant | 返回 `summonAfterDeath` 复活 profile | 不返回复活 profile，pieces/graveyard 不变 |
| `rule-el-primo-meteor-belt` | redirect event `piece=null`，有效 guard/status | queue 收到 `guard` | queue 保持空，状态不变 |
| `rule-elune-protection-player` | lethal damage、`piece=null`，player 有两份共享 protection | 消费两份 protection，目标未被正常恢复 | shared status 不消费，目标 HP 不变 |
| `rule-shelly-bandage` | afterDamageTaken、`piece=null`，holder HP=0.5、ability 未 spent | HP `0.5→4.5`，写入 spent 与 used status | HP、spent、status、damage/heal 均不变 |
| `rule-tirion-divine-shield-start` | start event、`piece=null` | 写入 divine-shield status（并尝试 rule） | status/rules 不变 |
| `rule-divine-shield` | damage event `sourcePiece/piece=null`，holder 有两层 shield | 移除首层 status 与自身 rule，返回 blocked | status/rules/damage 不变 |
| `rule-naruto-sage-immunity` | damage event `sourcePiece/piece=null`，holder 有两层 sage shield | 移除首层 status 与自身 rule，返回 blocked | status/rules/damage 不变 |
| `rule-watcher-rage-dealt` | `sourcePiece/piece=null`，damage=-2 | 上下文 damage `-2→-4` | damage 保持 -2 |
| `rule-watcher-rage-taken` | `sourcePiece/piece=null`，damage=-2 | 上下文 damage `-2→-4` | damage 保持 -2 |

这些案例的图形共性是 `ref.event-piece/ref.source → query.has-piece 或 piece.reference-present → 单个失败 return` 后，后续效果链仍在同一 sequence。以死亡召回为例，原图的节点路径为 `source-ref → source-exists → require-source`，随后 `source → same → require-same`，再进入 `dead/status/profile`；Meteor 在 `target` 检查后调用 `event.enqueue-damage-redirect`。只移除 defensive fallback 会让“缺失引用”不再成为后续链的控制依赖，导致无效值未阻止独立看似合法的效果输入。正确修复是保留失败分支，并把依赖该检查的 tail 放入正向分支；不应重新添加作者层 exists/alive fallback。

## 两个正常输入回归

| 场景 | 输入与旧行为 | canonical 行为 | 定位 |
| --- | --- | --- | --- |
| Elune protection | `gameplay-module-remaining-authoring.test.ts:307`：target `{ownerPlayerId:'player-red', faction:'red', HP 5/20}`；Tyrande `{templateId:'tyrande', ownerPlayerId:'player-blue', faction:'red', HP 10/20}`；damage=5。旧图找到 Tyrande，给 target 加 `elune-protection-used`、治疗 5 并记录 blocked/presentation。 | 返回 `{success:false,message:'泰兰德不在场'}`，target 仍 HP=5，无 status/heal/presentation。 | `buildProtectionGraph` 的 `tyrande-ref: query.living-template-faction(target)`（`scripts/migrate-semantic-remaining-authoring.ts:376`）变为 `collection.find`。谓词路径 `body/tyrande-ref.body/tyrande-ref--target-branch.then` 的 `--piece-faction` 与 `--target-faction` 都是 `piece.field(faction)`；当前 lower 经 `flow.query.pieceText → textField → getMatchFactionKey`，比较 owner/team key（`owner:player-blue` vs `owner:player-red`），没有比较 raw `piece.faction`（两者都为 red）。 |
| Divine Shield reaction | `gameplay-module-reaction-skills.test.ts:38`，status=`object`、damage=0.5、event=`beforeMove`；状态/rule 删除副作用与旧路径相同。 | 结果为 `undefined`；旧结果为 `{success:true,blocked:true,message:'事件主体的圣盾破裂，抵挡了来自未知敌人的伤害'}`，上下文 damage/status mutation 仍需保持一致。 | 这是正常输入的 result/output 形状差异，需确认 reaction host 对 event-specific output 的约定；不能用 missing-subject 规则掩盖。 |

## 验证记录

新增回归命令：

```text
npx.cmd vitest run --config tests/atomic-vitest.config.ts tests/game/gameplay-module-atomic-missing-subject.test.ts --maxWorkers=1 --reporter=verbose
```

首次在 root 控制依赖修复前执行为 **10 failed / 10**，失败输出分别显示 summon profile、redirect queue、status/rule consumption、HP/spent/status 和 damage `-2→-4`。root 接入 `repair-event-condition-gates.ts` 后再次执行为 **1 file、10 passed**（2026-10-13 01:25）；未修改生产文件或冻结预期。

类型检查：

```text
npx.cmd tsc --noEmit --pretty false
```

结果：通过。完整 canonical suite 尚未因本次 root 后续修复而重跑；结构 9 项、预检 1 项、Rafaam 3 项及上述两个正常输入仍需按各自根因继续跟进。
