# 现有技能、规则流程与公共代码接口

RED-192 的现役内容现在可直接在编辑器「技能 / 规则 → 流程图」中查看，无需先覆盖原代码创建空图。[离线全清单](../qa/RED-192-graph-existing/flows.html)可搜索 144 个技能与 110 个规则文件；其中两个规则文件不在当前 manifest，仍作为已有文件展示，不代表已装配进对局。

## 图与执行的关系

技能主动使用、规则内联 `skillCode`、规则 `effect.type=triggerSkill` 都有入口。规则触发配置、关联技能和相关代码分开展示。挂在棋子模板上的规则也能沿链接打开，链接明确标为「同棋子装配」，不会把同模板的全部规则误画为某技能必然调用的子过程。

源码图通过现有 TypeScript 解析器静态生成，不执行作者代码。它展开语句级条件、循环、break/continue、switch 穿透和 return；函数、回调放在独立子流程。点击节点能改该段源码，语法检查通过后重新绘图，保存仍走原子写入和文件版本冲突检测。其他字段、描述和源码片段不自动改写。已由类型化图生成的内容必须在原图修改，或明确解除图关联。

可展示全部现有文件，不等于全部逻辑都已变为纯参数节点：表达式内的三元/短路保留源码；try 等未展开控制流标为代码块；嵌在字符串里的延迟回调可查看，其修改在父节点完成。未知代码不会被悄悄改写成成功。图是静态阅读/编辑视图，尚无真实战斗逐步播放。

## 公共 `flow` 接口

新增 `rvb-flow-runtime/v1` 可信运行时接口。主动技能、内联规则和规则触发技能都有词法变量 `flow`；序列化目标回调在 `ctx.flow` 访问。复用权威状态、原有伤害/状态/位移管线，不创建另一套引擎。原有裸函数仍兼容。

| 接口 | 用途 / 返回 |
| --- | --- |
| `refs.holder/source/target/player/eventPlayer()` | 分别取得持有棋子、事件来源棋子、目标棋子、所属玩家、原事件玩家的 ID；没有棋子时为 null，不伪造棋子 |
| `query.piece/player(id)` | 当前权威对象，供可信代码节点读取；写效果优先用下列公共接口 |
| `query.pieces({ownerId, relation, originId, range, includeDead})` | 按所属方、敌我和曼哈顿范围查棋子 ID；默认只含存活棋子 |
| `query.distance(a,b) / path(origin,direction,options)` | 距离 / 既有投射物路径查询 |
| `query.random(items)` | 使用既有规则随机流选一项；空集合返回 null |
| `event.read()` | 读取本次事件的类型、伤害、治疗等现有标量 |
| `event.modify(field,value)` | before 事件修改允许的数值字段，写回原上下文；不允许事后改伤害 |
| `event.block(message)` | 生成阻止事件的结果，需要从规则 return，由事件入口解释 |
| `event.emit(name,payload)` | 调用既有触发系统，结算规则连锁 |
| `choice.target(options) / option(options)` | 使用所在入口的选择协议；主动 target 使用 prepare/提交重放，规则可使用 option 或下项延迟目标 |
| `choice.deferTarget({playerId,targetType,candidates,effectCode,payload,canCancel})` | 生成规则应 return 的单选请求；候选使用 `{type:'piece',pieceId}` 或 `{type:'cell',x,y}`，回调必须自包含，数据放 payload |
| `effects.damage(source,targetId,amount,type,skillId?)` | 原有伤害结果；source 可为棋子 ID，或现有玩家/环境来源对象；包含防护与实际生命损失 |
| `effects.heal(source,targetId,amount,skillId?)` | 原有治疗结果 |
| `effects.move(changes,kind)` | 原子位置变更；teleport/dash 等按原有移动种类校验，非法落点/禁锢抛错；成功无返回值 |
| `status.add/remove(targetId,statusOrId,scope?)` | 棋子或玩家状态；add 先核查 relatedRules，再通过现役 helper 安装状态和规则 |
| `rules.add/remove(targetId,ruleId,scope?)` | 安装 / 移除已有规则定义；scope 默认 piece，可选 player |
| `resources.add(playerId,'actionPoints'或'chargePoints',amount)` | 资源增减，逐步向下取整，结果不得为负或非有限数 |
| `cards.hand/add/discard(...)` | 读取手牌、通过抽入触发链加卡、按实例 ID 弃牌 |
| `attributes.add / percent` | 攻击、防御、移动力的增量或当前值百分比计算；限时加成的到期仍应由状态规则负责 |
| `skills.add/remove/resetCooldown` | 增删已有技能、清技能冷却；不重置每局限用 |
| `lifecycle.summon(request)` | 向已声明的 summonCapability 队列提交请求，继续使用召唤模板协议 |
| `lifecycle.reviveAfterDeath(multiplier?,skillId?)` | 在持有者正式死亡回调生成应 return 的复活结果；清旧状态、恢复初始属性与限用记录由既有 DeathBatch 完成 |
| `lifecycle.removeEnemy(id)` | 主动技能中使用现有强制离场 helper，不触发死亡 |
| `state.get/set/remove/cleanup` | 下述有命名空间的跨事件数据 |

接口并非在所有入口都有相同权限。`flow.capabilities` 给出当前宿主实际委托的 helper；不提供的 helper 会明确报错，不返回假的成功。例如规则不能假装同步取到主动目标，需 return 延迟选择；pending 回调也不能继续引用序列化前的闭包。召唤必须有声明，正式复活不能在 beforeDamage 中返回。原有隔离 VM 的命令 ABI 不因可信 facade 自动放宽；外部可执行包仍走现有准入。

## Extension：进度、次数与跨回合关联

```js
// 主动技能中记录准备进度。
flow.state.set('piece', flow.refs.holder(), 'meditation', 'remaining', 6, 'while-alive');

// 同一棋子的 beginTurn 规则中读取、扣除；进度为零可通过公共资源接口奖励。
const id = flow.refs.holder();
const remaining = flow.state.get('piece', id, 'meditation', 'remaining');
if (typeof remaining === 'number') {
  const next = Math.max(0, remaining - 1);
  flow.state.set('piece', id, 'meditation', 'remaining', next, 'while-alive');
}
```

这只是公共接口示例，现有鸣人的分身加速、3 AP/1 CP 和开始阶段仍由现役规则执行，不被示例覆盖。计时不使用含糊的「几回合后」，在 beginTurn/endTurn 规则中操作进度。延迟位置、目标关系、命中次数等复杂效果也可存 JSON 数据，再由相应事件规则读取；具体伤害/移动仍调用公共效果接口。

记录位于已有 `battle.extensions.flowState`，每条 `schemaVersion:1`，包含 scope（piece/player/battle）、entityId、namespace、name、value、lifetime、所属玩家与显示权限。每项最多 64KB、嵌套 40 层、最多 4096 项，拒绝函数、getter、循环引用、非有限数字和未知版本。读写复制 JSON，不能把运行时闭包带入存档。

棋子/玩家记录默认仅对所属玩家投影；battle 记录是公共数据，不能放隐藏手牌。`while-alive` 仅用于棋子，正式死亡或强制离场会清理；`battle` 记录保留为本局历史。复活生成新实例，旧实例的数据不会自动绑定给复活体；需要跨形态保留的次数应明确放在玩家级命名空间，或使用已有每局限用机制。状态效果不要仅存 extension 冒充 statusTag，否则公共驱散/到期系统不会知道它。

## 影分身状态外观

已改为本体存活时动态读取其可见 statusTag；本体获得、移除或更新状态时，分身显示同步。分身的真实 statusTags、规则和数值不变，显示圣盾也不会替它挡伤害。隐藏标签不显示。本体消失后沿用现有召唤时外观快照，避免读取失效实体。

## 验证与回退

生成全清单：先运行 `node scripts/build-skill-graph.mjs`，再运行 `node scripts/export-content-flows.mjs`。测试覆盖全文件解析、模板被动链接、控制分支与回调、节点编辑/语法/过期 hash、真实规则的事件修改、扩展投影与死亡清理、目标回调恢复、鸣人显示镜像，以及真实 Electron 打开/关联跳转/节点保存。

本次可整体回退增量提交。新旧内容文件仍保留唯一原脚本；若用户已经编写使用 `flow` 的内容，回退运行时前必须备份并同步回退对应内容，旧引擎不会识别 `flow`。不降级进行中的对局，不替用户合并或发布。
