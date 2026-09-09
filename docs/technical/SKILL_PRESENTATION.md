# SkillCode 表现与选择接口（RED-202）

## 范围与状态

新增 `flow.presentation` 运行时接口、按观看者投影、战斗页消费者，以及编辑器对应节点。这是现有技能迁移的基础，不表示所有 269 份技能／规则／卡牌代码已经改成类型化流程图。没有修改游戏 Electron 主进程、角色数值或现有技能资源。

界面绑定和规则状态独立。例如分身实际生命为 1，显示来源生命为 7，伤害与死亡仍按 1 结算。旧鸣人技能继续使用已有镜像字段，本次没有自动迁移或改变其行为。

## 作者接口

共享定义：`lib/game/skill-presentation.ts`；入口由 `flow-runtime.ts` 接入。SkillCode 与规则代码可使用已有 `flow` 对象。

| 接口 | 用途 | 编辑器节点 |
| --- | --- | --- |
| `flow.presentation.bind(spec)` | 绑定显示来源 | 绑定显示来源 |
| `flow.presentation.indicator(spec)` | 数值或进度条 | 显示数值与进度 |
| `flow.presentation.mark(spec)` | 地格上的说明与图标 | 显示地格标记 |
| `flow.presentation.emit(spec)` | 一次性文字、高亮或预设提示音 | 播放表现提示 |
| `flow.presentation.remove(id)` | 删除本作用域的声明 | 移除显示效果 |
| `flow.presentation.cleanup()` | 清理过期或持有者离场的记录 | 写入时自动清理；代码可显式调用 |

所有声明必须有 `id` 和 `audience`。作用域是所有者玩家 + 技能持有棋子 + 技能／规则命名空间；相同 id 更新原声明。移除一个技能的声明不会误删别的技能。绑定、指示器和标记写入返回稳定显示 ID。

声明只接受有界的普通 JSON，拒绝函数、getter、原型属性、循环引用、未知字段和无穷数。每项最多 32 KiB、文本 120 字、标记 64 个有效地格、总记录 512。不能使用任意 HTML、网络地址或可执行 UI 代码。达到预算会显式报错，作者应复用稳定 id 或清理效果。

```js
flow.presentation.bind({
  id: 'clone-display', targetId: clone.instanceId, sourceId: context.piece.instanceId,
  fields: ['name', 'templateId', 'health', 'statuses'],
  mode: 'live', onSourceMissing: 'snapshot', audience: 'public', lifetime: 'battle'
});
flow.presentation.indicator({
  id: 'chakra', targetId: context.piece.instanceId,
  label: '查克拉', value: 3, max: 6, audience: 'owner'
});
flow.presentation.mark({
  id: 'anchor', cells: [{x: 2, y: 1}], label: '传送锚点', icon: '⚡', audience: 'allies'
});
flow.presentation.emit({
  id: 'activation-unique-id', kind: 'float', targetId: clone.instanceId,
  text: '分身出现', audience: 'public', lifetime: 'battle'
});
```

### 显示来源

`fields` 可选 name、templateId（头像模板）、health（当前／最大生命）、attack、defense、moveRange、skills、statuses。状态只输出明确允许的可见字段；技能只输出 ID 和冷却。

- `mode: live` 每次权威投影读取来源的实际数据；`snapshot` 保存绑定创建／更新时的数据。
- `onSourceMissing: snapshot` 回退到创建时快照；`self` 显示目标自身；`remove` 不再显示此绑定。
- 来源读取不递归追踪其他显示绑定，互相绑定不会产生递归。
- 多个可见绑定涉及同字段时，后写入的绑定覆盖先写入的绑定。显示目标离场后不输出绑定。
- 指示器可提供 `source: {pieceId, field}` 实时读取 currentHp、maxHp、attack、defense、moveRange；来源离场则使用 `value`。任意业务变量由技能／规则更新固定 value，无任意路径求值。
- 地格标记仅是表现，不改变占位、可走性、传送合法性。图标预设为 ◆、⚡、✦；文字在技能信息栏显示。

### 生命周期与播放

`lifetime` 默认跟随技能持有棋子存活（while-alive），无棋子持有者默认 battle。也可明确设 battle。`expiresTurn` 为排他的结束回合号：当前回合达到该值就不再投影。数据保存在权威 extensions 中，普通 JSON 存取保留绑定和生命周期。

cue 的 kind 为 float、flash、sound。音效只允许 notice、success、warning 三种本地合成提示音；没有网络音频。浏览器禁止自动播放或音频设备挂起时不补播旧音效。高亮持续约 650ms，已有战斗演出高亮优先。提示坐标在发出时固定，不随目标后续移动漂移。

同作用域、同 id 的 cue 在保留窗口内只发一次。每个所有者与 audience 域保留最近 96 条，域之间不互相推进序号或驱逐历史。作者每次新施放应使用不同 id；生成节点使用回合号 + targetingRevision。客户端按房间／观看者和可见域水位去重；首次打开、同页断线恢复、换视角和新房间的首快照只建立水位，不补播历史。旧 id 超出保留窗口后不能作为永久幂等键。

## 权限与回放边界

| audience | 所有者 | 队友 | 敌方玩家 | 匿名／观战者 |
| --- | --- | --- | --- | --- |
| public | 是 | 是 | 是 | 是 |
| owner | 是 | 否 | 否 | 否 |
| allies | 是 | 是 | 否 | 否 |
| enemies | 否 | 否 | 是 | 否 |
| spectators | 否 | 否 | 否 | 是 |

由 `toPublicBattleState` 在服务端过滤，客户端不获取未授权声明。表现 payload 不含作者 id、来源引用、快照或私有序列。空观看者按观战者处理这组新接口。

**显示替换不是身份保密接口。** 老协议中的真实棋子字段、masterPieceId、带 `naruto-clone-` 前缀的实例 ID 和既有日志仍可能暴露分身身份；本次不承诺抵抗检查网络数据的身份推断。若将来做隐藏本体／真身玩法，需要另立权限与命令 ID 方案，不能靠此处改头像实现。

终局回放是共享的显示检查点，不是可执行存档。创建检查点时排除整组表现声明，再计算检查点哈希；权威状态／哈希保留声明。旧回放若夹带此组原始声明，出站时不提供该回放，避免泄露或悄悄改坏哈希。当前共享回放不重现这组新提示；实时对局与存档恢复支持它们。

## 选择接口

继续使用 `flow.choice.option`、`flow.choice.target` 与 `flow.choice.deferTarget` 及既有权威选择协议。deferTarget 新增 single/multi、minSelections/maxSelections，拒绝不存在的目标、重复候选和无效数量。棋子和地格都支持多选后确认。返回待选择描述，由既有战斗流程安装并恢复；单独调用不会提前写入 pending 状态。

编辑器增加“选择模式或选项”及“判断选中的模式”。名称用 `|` 分隔，1–8 个不同选项，指定最少／最多数量。选中项内部使用稳定 option-N ID；判断节点可检查多选结果是否包含指定项。主动技能服务端重新校验凭证、状态版本、候选、数量和重复项；取消尚未提交的主动选择不会消耗资源。

当前类型化图允许一组选项（可多选），可以和多个棋子／地格选择组合；所有选择在效果和分支之前。中途暂停、多轮不同玩家选择、触发器和召唤实体图仍保留代码接口，不能声称已支持全技能可视化。现有源代码流程视图仍可查看旧技能，但不等于原子图迁移。

## 发布兼容与回退

先更新规则运行时、战斗页和编辑器，再发布引用新接口的内容。图格式保留 v1；旧图生成结果不变，新节点使用前检查客户端是否支持 flow.presentation。此检查不是完整的资源包最低引擎版本协商，发布流程仍需确认玩家已升级。不要把新技能包推给旧引擎。

回退时先撤回引用新节点的内容，再回退此代码 PR；不要对含新声明的进行中权威存档做格式降级。保留原始内容包和存档备份。本次没有发布资源包或迁移全部旧技能。
