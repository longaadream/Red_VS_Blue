# 作者原子模块接口

由 `scripts/generate-gameplay-module-api.ts` 从工作台实际注册目录生成。修改接口后重新生成，不在本文另行维护一套参数。

当前提供 **267** 个原子接口。此数量不包括旧资源内部适配器，不表示游戏内容、编辑器操作或运行行为已全部验收。

工作台只提供通用原子语句和流程结构。旧内容适配器仅供内部读取与诊断，不出现在新增语句或表达式目录中，包括高级选项。

extension 列表只建议当前上下文已声明的变量；也可以自定义指定对象、路径与类型。自定义访问不创建变量；字段缺失时该语句及其依赖语句无效，独立后续继续，无需编写 fallback。

在效果编辑区选择“添加效果”或表达式模块，再连接下表的输入；参数为编辑时确定的值，输入可以连接其他模块的输出。组合模块、记录、循环和续接属于结构语句，见[工作台说明](WORKBENCH_UI_GUIDE.md)与[语句手册](AUTHOR_STATEMENT_MANUAL.md)。

技能与卡牌的实例、棋子、玩家等引用必须来自前序模块或入口，不需要手填内部 ID。允许入口是实际编译器约束；例如预览中不能调用有战斗副作用的模块。

| 分类 | 已登记模块数 |
| --- | ---: |
| 查询与选择 | 18 |
| 战斗效果 | 8 |
| 状态与规则 | 27 |
| 变量与数据 | 82 |
| 流程控制 | 9 |
| 计算与容器 | 60 |
| 棋盘与召唤 | 35 |
| 卡牌与能力 | 28 |

## 查询与选择

### 选择选项值

接口：`author.choice.option@1`。

作者目录：原子语句。

按“显示文本→值”映射打开单选器并直接返回声明类型的选项值。显示文本只用于界面，业务分支使用返回值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `options` | 选项映射 | `record` | 是 |  |
| `cancelValue` | 取消后继续并返回 | `record` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 返回值类型 | `string` | 是 | 默认 string |
| `title` | 选择提示 | `string` | 否 |  |
| `canCancel` | 允许取消 | `boolean` | 是 | 默认 false |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 选中值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"cancelValue":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：写入 pending；可能等待玩家选择；事件 pendingOptionSelection。

### 选择棋子目标

接口：`author.choice.target-piece@1`。

作者目录：原子语句。

按一次声明的范围、阵营和取消约束选择一个棋子；目标失效时由权威目标引擎拒绝本次语句。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `range` | 范围（格） | `number` | 是 | 默认 5；最小 0 |
| `filter` | 阵营筛选 | `string` | 是 | 默认 enemy；enemy / ally / all |
| `title` | 选择提示 | `string` | 否 |  |
| `canCancel` | 允许取消 | `boolean` | 是 | 默认 false |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子目标 | `piece` | 是 |  |

执行声明：写入 pending；可能等待玩家选择；事件 pendingTargetSelection。

### 选择地格目标

接口：`author.choice.target-cell@1`。

作者目录：原子语句。

按一次声明的范围、筛选和取消约束选择一个地格；坐标和占用合法性由权威目标引擎校验。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `range` | 范围（格） | `number` | 是 | 默认 5；最小 0 |
| `filter` | 地格筛选 | `string` | 是 | 默认 all；enemy / ally / all |
| `requireWalkable` | 必须可行走 | `boolean` | 是 | 默认 true |
| `requireUnoccupied` | 必须为空地 | `boolean` | 是 | 默认 true |
| `title` | 选择提示 | `string` | 否 |  |
| `canCancel` | 允许取消 | `boolean` | 是 | 默认 false |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cell` | 地格目标 | `cell` | 是 |  |

执行声明：写入 pending；可能等待玩家选择；事件 pendingTargetSelection。

### 显示选项

接口：`choice.options@1`。

作者目录：原子语句。

将有序选项记录交给选择宿主；未提供的约束保持宿主默认值。选项数量不限于两个。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `options` | 选项 | `{"kind":"list","element":"record"}` | 是 |  |
| `title` | 提示 | `string` | 否 |  |
| `playerId` | 选择玩家 | `player`（可空） | 否 |  |
| `selectionMode` | 选择形式 | `string` | 否 |  |
| `minSelections` | 最少数量 | `number` | 否 |  |
| `maxSelections` | 最多数量 | `number` | 否 |  |
| `canCancel` | 允许中止 | `boolean` | 否 |  |
| `cancelValue` | 中止返回值 | `string` | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `choice` | 选择结果 | `choice` | 是 |  |

执行声明：写入 pending；可能等待玩家选择；事件 pendingOptionSelection。

### 选择选项值

接口：`author.choice.option@2`。

作者目录：原子语句。

从显示文本与值的映射选择，数量统一使用最少与最多；多选按点击顺序返回元组，允许不同选项具有相同值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `options` | 选项映射 | `record` | 是 |  |
| `player` | 选择玩家 | `player` | 否 |  |
| `minSelections` | 最少数量 | `number` | 否 |  |
| `maxSelections` | 最多数量 | `number` | 否 |  |
| `cancelValue` | 取消后继续并返回 | `record` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 返回值类型 | `string` | 是 | 默认 string |
| `selectionMode` | 返回形式 | `string` | 是 | 默认 single；single / multi |
| `title` | 选择提示 | `string` | 是 | 默认 请选择 |
| `canCancel` | 允许中止本次效果 | `boolean` | 是 | 默认 false |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 选中值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"cancelValue":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：写入 pending；可能等待玩家选择；事件 pendingOptionSelection。

### 选择选项值

接口：`author.choice.option@3`。

作者目录：原子语句。

从映射中选择：文本键作为显示文字，值作为返回结果。多选按点击顺序返回元组，数量由最少和最多共同限制。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `options` | 选项映射 | `record` | 是 |  |
| `player` | 选择玩家 | `player` | 否 |  |
| `minSelections` | 最少数量 | `number` | 否 |  |
| `maxSelections` | 最多数量 | `number` | 否 |  |
| `cancelValue` | 取消后继续并返回 | `record` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `optionsType` | 选项映射类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"string"} |
| `valueType` | 返回值类型 | `string` | 是 | 默认 string |
| `selectionMode` | 返回形式 | `string` | 是 | 默认 single；single / multi |
| `title` | 选择提示 | `string` | 是 | 默认 请选择 |
| `canCancel` | 允许中止本次效果 | `boolean` | 是 | 默认 false |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 选中值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"options":{"parameter":"optionsType"},"cancelValue":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：写入 pending；可能等待玩家选择；事件 pendingOptionSelection。

### 查询范围棋子

接口：`author.query.pieces@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `center` | 中心地格 | `cell` | 是 |  |
| `minimum` | 最小距离 | `number` | 否 |  |
| `maximum` | 最大距离 | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"piece"}` | 是 |  |

执行声明：纯计算；读取 pieces、map、tile-effects。

### 查询范围地格

接口：`author.query.cells@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `center` | 中心地格 | `cell` | 是 |  |
| `minimum` | 最小距离 | `number` | 否 |  |
| `maximum` | 最大距离 | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"cell"}` | 是 |  |

执行声明：纯计算；读取 pieces、map、tile-effects。

### 地格字段

接口：`cell.field@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cell` | 地格 | `cell` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | walkable / occupied / tileEffects / terrainType |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `walkable` | `boolean` |
| `occupied` | `boolean` |
| `tileEffects` | `{"kind":"list","element":"record"}` |
| `terrainType` | `{"kind":"nullable","value":"string"}` |

执行声明：纯计算；读取 pieces、map、tile-effects。

### 地格效果字段

接口：`tile.effect-field@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `effect` | 地格效果 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | tileType / sourceId / ownerPlayerId / x / y |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `tileType` | `string` |
| `sourceId` | `{"kind":"nullable","value":"string"}` |
| `ownerPlayerId` | `{"kind":"nullable","value":"player"}` |
| `x` | `number` |
| `y` | `number` |

执行声明：纯计算；读取 pieces、map、tile-effects。

### 状态强度

接口：`status.strength@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |
| `statusType` | 状态类型 | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；读取 statuses。

### 解析棋子及历史来源

接口：`piece.resolve-including-graveyard@1`。

作者目录：原子语句。

按稳定棋子标识从场上或墓地读取来源归属；保留未找到时的原始标识。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece`（可空） | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | id | `{"kind":"nullable","value":"string"}` | 是 |  |
| `ownerPlayerId` | ownerPlayerId | `{"kind":"nullable","value":"player"}` | 是 |  |

执行声明：纯计算；可预览；读取 pieces。

### 查询地格周围棋子

接口：`query.pieces-around-cell@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `center` | center | `cell` | 是 |  |
| `owner` | owner | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `relation` | relation | `string` | 是 | 默认 all；all / ally / enemy |
| `metric` | metric | `string` | 是 | 默认 manhattan；manhattan / chebyshev |
| `minimum` | minimum | `number` | 是 | 默认 0；最小 0 |
| `maximum` | maximum | `number` | 是 | 默认 1；最小 0 |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `pieces` | pieces | `{"kind":"list","element":"piece"}` | 是 |  |

执行声明：纯计算；读取 pieces、position、players。

### 按对局顺序查询玩家

接口：`query.players@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `players` | players | `{"kind":"list","element":"player"}` | 是 |  |

执行声明：纯计算；读取 players。

### 查询战场与墓地记录标识

接口：`query.all-pieces@1`。

作者目录：原子语句。

依次读取战场、墓地的棋子记录标识，保留各区顺序。标识用于历史状态清理；它不是可行动棋子引用，不能直接用于伤害、移动或复活。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `pieces` | 记录标识元组 | `{"kind":"list","element":"string"}` | 是 |  |

执行声明：纯计算；读取 pieces。

### 读取原始选择数组

接口：`choice.as-array@1`。

作者目录：原子语句。

将已完成的原始多选数组交给通用集合原语；非数组值按旧选择协议归一为空集合。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `choice` | choice | `choice`（可空） | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"choice"}` | 是 |  |

执行声明：纯计算；可预览；读取 choice。

### 查询棋子集合

接口：`query.pieces@1`。

作者目录：原子语句。

按所属玩家、敌我关系、来源范围和存活条件查询有序棋子 ID 集合。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `originId` | originId | `piece`（可空） | 否 |  |
| `ownerId` | ownerId | `player`（可空） | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `relation` | relation | `string` | 是 | 默认 all；ally / enemy / all |
| `range` | range | `number` | 否 | 最小 0 |
| `includeDead` | includeDead | `boolean` | 是 | 默认 false |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `pieces` | pieces | `{"kind":"list","element":"piece"}` | 是 |  |

执行声明：纯计算；可预览；读取 pieces、players、position。

### 棋子距离

接口：`query.distance@1`。

作者目录：原子语句。

读取两个棋子之间的曼哈顿距离。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `from` | from | `piece` | 是 |  |
| `to` | to | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `distance` | distance | `number` | 是 |  |

执行声明：纯计算；可预览；读取 pieces、position。

## 战斗效果

### 造成伤害

接口：`author.effect.damage@1`。

作者目录：原子语句。

通过权威伤害流程造成普通或真实伤害并返回本次结算结果；毒素及其他历史分类不属于新的作者接口。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `piece` | 是 |  |
| `target` | target | `piece` | 是 |  |
| `amount` | amount | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `damageType` | 伤害类型 | `string` | 是 | 默认 normal；normal / true |
| `skillId` | 技能标识 | `string` | 否 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | result | `record` | 是 |  |
| `success` | success | `boolean` | 是 |  |
| `damage` | damage | `number` | 是 |  |

执行声明：写入 damage、events；事件 beforeDamageDealt、afterDamageDealt。

### 造成伤害

接口：`author.effect.damage@2`。

作者目录：原子语句。

一个目标或元组共用此语句；一个数值统一应用，数值元组按序对应；返回值保留失败项的序号。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | 来源 | `piece` | 是 |  |
| `target` | 目标 | `piece` | 是 |  |
| `amount` | 伤害量 | `number` | 是 |  |
| `killerPlayer` | 击杀归属 | `player`（可空） | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `sourceType` | 来源类型 | `string` | 是 | 默认 piece；piece / player / card / record |
| `targetType` | 目标类型 | `string` | 是 | 默认 piece；piece / record / {"kind":"list","element":"piece"} |
| `amountType` | 数值类型 | `string` | 是 | 默认 number |
| `resultType` | 结果类型 | `string` | 是 | 默认 record |
| `damageType` | 伤害类型 | `string` | 是 | 默认 normal；normal / true |
| `legacyNormalSpelling` | 旧日志伤害名称 | `string` | 是 | 默认 physical；physical / magical |
| `attribution` | 归属方式 | `string` | 是 | 默认 current；current / unattributed |
| `skillId` | 技能标识 | `string` | 否 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | 结算结果 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"source":{"parameter":"sourceType"},"target":{"parameter":"targetType"},"amount":{"parameter":"amountType"}},"outputs":{"result":{"parameter":"resultType"}}}`。

执行声明：写入 damage、events；事件 beforeDamageDealt、afterDamageDealt。

### 恢复生命

接口：`author.effect.heal@2`。

作者目录：原子语句。

一个目标或元组共用此语句；一个数值统一应用，数值元组按序对应；返回值保留失败项的序号。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | 来源 | `piece` | 是 |  |
| `target` | 目标 | `piece` | 是 |  |
| `amount` | 恢复量 | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `sourceType` | 来源类型 | `string` | 是 | 默认 piece；piece / player / card / record |
| `targetType` | 目标类型 | `string` | 是 | 默认 piece；piece / {"kind":"list","element":"piece"} |
| `amountType` | 数值类型 | `string` | 是 | 默认 number |
| `resultType` | 结果类型 | `string` | 是 | 默认 record |
| `damageType` | 伤害类型 | `string` | 是 | 默认 normal；normal / true |
| `skillId` | 技能标识 | `string` | 否 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | 结算结果 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"source":{"parameter":"sourceType"},"target":{"parameter":"targetType"},"amount":{"parameter":"amountType"}},"outputs":{"result":{"parameter":"resultType"}}}`。

执行声明：写入 heal、events；事件 beforeHealDealt、afterHealDealt。

### 造成伤害（能力组归因）

接口：`author.effect.damage@3`。

作者目录：原子语句。

通过当前或指定能力组实例归因造成伤害；主动技能默认使用当前能力组，其他入口未填写能力组时不归因。支持单目标、目标元组与保留来源。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | 来源 | `piece` | 是 |  |
| `target` | 目标 | `piece` | 是 |  |
| `amount` | 伤害量 | `number` | 是 |  |
| `abilityGroup` | 能力组归因 | `record` | 否 |  |
| `killerPlayer` | 击杀归属 | `player`（可空） | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `sourceType` | 来源类型 | `string` | 是 | 默认 piece；piece / player / card / record |
| `targetType` | 目标类型 | `string` | 是 | 默认 piece；piece / record / {"kind":"list","element":"piece"} |
| `amountType` | 数值类型 | `string` | 是 | 默认 number |
| `resultType` | 结果类型 | `string` | 是 | 默认 record |
| `damageType` | 伤害类型 | `string` | 是 | 默认 normal；normal / true |
| `legacyNormalSpelling` | 旧日志伤害名称 | `string` | 是 | 默认 physical；physical / magical |
| `attribution` | 归属方式 | `string` | 是 | 默认 current；current / unattributed |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | 结算结果 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"source":{"parameter":"sourceType"},"target":{"parameter":"targetType"},"amount":{"parameter":"amountType"}},"outputs":{"result":{"parameter":"resultType"}}}`。

执行声明：写入 damage、events；事件 beforeDamageDealt、afterDamageDealt。

### 原子提交扩展和地格表现

接口：`extension.commit-root-with-tiles@1`。

作者目录：原子语句。

在校验扩展记录和地格表现记录后同时替换两个全局数组；候选必须先由图中的有效引用分支计算。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `root` | root | `{"kind":"list","element":"record"}` | 是 |  |
| `tiles` | tiles | `{"kind":"list","element":"record"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `storageKey` | storageKey | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：读取 extensions；写入 extensions、tile-effects。

### 原子提交扩展和地格表现

接口：`extension.commit-root-with-tiles@2`。

作者目录：原子语句。

校验后整体提交扩展记录与地格效果，保留地格增删的表现批次和发生顺序。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `root` | root | `{"kind":"list","element":"record"}` | 是 |  |
| `tiles` | tiles | `{"kind":"list","element":"record"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `storageKey` | storageKey | `string` | 是 |  |
| `presentationBatch` | presentationBatch | `string` | 是 | 默认 direct；direct / tileEffectRemoved / tileEffectAdded |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：读取 extensions；写入 extensions、tile-effects。

### 令棋子立即出局

接口：`effect.force-defeat@1`。

作者目录：原子语句。

把已验证目标生命置零，由当前宿主继续处理正式死亡结算。

允许入口：rule。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 health。

### 调整资源

接口：`resource.adjust@1`。

作者目录：原子语句。

通过资源边界校验调整行动点或充能点。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | player | `player` | 是 |  |
| `amount` | amount | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `resource` | resource | `string` | 是 | actionPoints / chargePoints |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：写入 resources；事件 resourceChanged。

## 状态与规则

### 查询状态实例

接口：`status.query-instances@1`。

作者目录：原子语句。

按状态类型查询目标棋子上的状态实例；可指定来源实例筛选。返回的元组保持状态顺序，空结果为零项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |
| `source` | 来源 | `piece` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `statusType` | 状态类型 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `statuses` | 状态实例元组 | `{"kind":"list","element":"status"}` | 是 |  |

执行声明：读取 statuses；写入 execution-context。

### 移除状态实例

接口：`status.remove-instance@1`。

作者目录：原子语句。

移除当前执行中选定的那个状态实例，不按名称或类型重新匹配，不触发移除事件；失效引用使语句无效。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | 状态实例 | `status` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `removed` | 已移除 | `boolean` | 是 |  |

执行声明：写入 statuses。

### 阻挡当前事件

接口：`event.block@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `message` | message | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |
| `blocked` | blocked | `boolean` | 是 |  |
| `message` | message | `string` | 是 |  |

执行声明：写入 event-result。

### 按状态实例生命周期移除

接口：`status.remove-instance-lifecycle@1`。

作者目录：原子语句。

按当前执行中保留的不透明状态句柄调用宿主生命周期移除；不按标识重新匹配。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | status | `status` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `removed` | removed | `boolean` | 是 |  |

执行声明：写入 statuses、rules、events；事件 afterStatusRemoved。

### 修改伤害承受者

接口：`event.enqueue-damage-redirect@1`。

作者目录：原子语句。

在伤害转移前事件中修改承受棋子，沿用权威转移队列。已转移、目标失效或当前阶段不可改写时返回未接受，不改变后事件事实。

允许入口：rule。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | 承受棋子 | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `accepted` | 已接受 | `boolean` | 是 |  |

执行声明：写入 damage-redirect-queue。

### 附加结构化棋子状态

接口：`status.apply-record@1`。

作者目录：原子语句。

将 graph-local typed record 交给现有 status lifecycle；不建立第二份状态存储。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `piece` | 是 |  |
| `record` | record | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `inputPolicy` | inputPolicy | `string` | 是 | 默认 flow；flow / host |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 status、rule、events；事件 afterStatusApplied。

### 附加结构化玩家状态

接口：`status.apply-player-record@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | player | `player` | 是 |  |
| `record` | record | `record` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 statuses、events。

### 查找状态实例引用

接口：`status.find-instance@1`。

作者目录：原子语句。

保留当前执行中选中的状态对象引用；不为无标识状态分配标识，也不会按类型重新匹配。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `statusType` | statusType | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | status | `status`（可空） | 是 |  |

执行声明：读取 statuses；写入 execution-context。

### 设定状态实例数值

接口：`status.set-number-instance@1`。

作者目录：原子语句。

修改当前执行保留的状态实例数值；不按标识或类型寻找其他状态。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | status | `status`（可空） | 是 |  |
| `value` | value | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | stacks / intensity / currentDuration / remainingDuration / currentUses / remainingUses / remainingTurns / grantedTurnNumber / createdTurnNumber / value |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：读取 execution-context；写入 statuses。

### 改写结算前事件数值

接口：`event.write-number@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | damage / heal / amount / targetX / targetY |
| `inputPolicy` | inputPolicy | `string` | 是 | 默认 floor；floor / host |

**输出**

无。

执行声明：写入 event。

### 生成状态标识

接口：`status.make-id@1`。

作者目录：原子语句。

让权威状态宿主生成一个可回放的唯一状态标识；作者图只提供稳定前缀。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `prefix` | prefix | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | id | `string` | 是 |  |

执行声明：写入 status；事件 statusIdAllocated。

### 移除记录中的规则

接口：`rule.remove-id-raw@1`。

作者目录：原子语句。

按记录标识清理战场或墓地棋子的指定规则记录，不使离场棋子获得行动资格；用于已离场来源的遗留记录清理。正常在场能力增删使用规则生命周期入口。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | 棋子记录标识 | `string` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `ruleId` | 规则 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 已移除 | `boolean` | 是 |  |

执行声明：读取 pieces；写入 rules。

### 移除记录中的规则

接口：`rule.remove-id-raw@2`。

作者目录：原子语句。

按目标类型移除规则：字符串沿用记录标识清理，执行记录直接使用本次执行认证来源；无匹配规则仍返回成功，失效执行记录由宿主诊断。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | 目标 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `targetType` | 目标类型 | `string` | 是 | 默认 string；string / record |
| `ruleId` | 规则 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 已移除 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"target":{"parameter":"targetType"}}}`。

执行声明：读取 pieces、execution-context；写入 rules。

### 读取事件目标地格

接口：`event.target-cell@1`。

作者目录：原子语句。

读取宿主已经验证或恢复的目标坐标；没有目标时返回空地格。

允许入口：rule、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cell` | cell | `cell`（可空） | 是 |  |

执行声明：纯计算；读取 event。

### 读取事件字段

接口：`event.field@1`。

作者目录：原子语句。

读取事件快照中的封闭历史字段；棋子离场不影响已记录事实。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | sourcePiece / targetPiece / piece / rulePiece / type / playerId / skillId / damage / actualDamage / heal / amount / targetX / targetY / turnNumber / movementKind / fromX / fromY / pathCells / contactCells |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `sourcePiece` | `{"kind":"nullable","value":"record"}` |
| `targetPiece` | `{"kind":"nullable","value":"record"}` |
| `piece` | `{"kind":"nullable","value":"record"}` |
| `rulePiece` | `{"kind":"nullable","value":"record"}` |
| `type` | `{"kind":"nullable","value":"string"}` |
| `playerId` | `{"kind":"nullable","value":"player"}` |
| `skillId` | `{"kind":"nullable","value":"string"}` |
| `damage` | `{"kind":"nullable","value":"number"}` |
| `actualDamage` | `{"kind":"nullable","value":"number"}` |
| `heal` | `{"kind":"nullable","value":"number"}` |
| `amount` | `{"kind":"nullable","value":"number"}` |
| `targetX` | `{"kind":"nullable","value":"number"}` |
| `targetY` | `{"kind":"nullable","value":"number"}` |
| `turnNumber` | `{"kind":"nullable","value":"number"}` |
| `movementKind` | `{"kind":"nullable","value":"string"}` |
| `fromX` | `{"kind":"nullable","value":"number"}` |
| `fromY` | `{"kind":"nullable","value":"number"}` |
| `pathCells` | `{"kind":"nullable","value":{"kind":"list","element":"record"}}` |
| `contactCells` | `{"kind":"nullable","value":{"kind":"list","element":"record"}}` |

执行声明：纯计算；读取 event。

### 读取状态字段

接口：`status.fields@1`。

作者目录：原子语句。

读取当前执行保留的状态记录快照；无效状态由宿主报告为无效依赖。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | status | `status`（可空） | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record` | 是 |  |

执行声明：纯计算；读取 execution-context、statuses。

### 读取全部状态实例

接口：`status.instances@1`。

作者目录：原子语句。

按棋子状态数组顺序返回当前执行期间有效的状态实例句柄；重复类型和无标识记录保持独立。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `statuses` | statuses | `{"kind":"list","element":"status"}` | 是 |  |
| `present` | present | `boolean` | 是 |  |

执行声明：读取 statuses；写入 execution-context。

### 读取全部状态实例

接口：`status.instances@2`。

作者目录：原子语句。

读取棋子或玩家的状态，保留每个实例的独立身份和排列顺序。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 所属对象 | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `ownerType` | 所属类型 | `string` | 是 | 默认 piece；piece / player |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `statuses` | statuses | `{"kind":"list","element":"status"}` | 是 |  |
| `present` | present | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"owner":{"parameter":"ownerType"}}}`。

执行声明：读取 statuses；写入 execution-context。

### 按标识读取全部状态实例

接口：`status.instances-by-id@1`。

作者目录：原子语句。

按不透明棋子标识读取战场或墓地中的状态实例；重复类型、无标识记录和已离场棋子保持独立。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `statuses` | statuses | `{"kind":"list","element":"status"}` | 是 |  |
| `present` | present | `boolean` | 是 |  |

执行声明：读取 statuses、pieces；写入 execution-context。

### 读取状态实例字段

接口：`status.instance-field@1`。

作者目录：原子语句。

从当前执行期间保留的状态实例句柄读取登记字段，不按标识重新匹配。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | status | `status` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | name / id / type / sourceId / flightId / remainingTurns / grantedTurnNumber / createdTurnNumber / turnNumber |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `name` | `{"kind":"nullable","value":"string"}` |
| `id` | `{"kind":"nullable","value":"string"}` |
| `type` | `{"kind":"nullable","value":"string"}` |
| `sourceId` | `{"kind":"nullable","value":"string"}` |
| `flightId` | `{"kind":"nullable","value":"string"}` |
| `remainingTurns` | `{"kind":"nullable","value":"number"}` |
| `grantedTurnNumber` | `{"kind":"nullable","value":"number"}` |
| `createdTurnNumber` | `{"kind":"nullable","value":"number"}` |
| `turnNumber` | `{"kind":"nullable","value":"number"}` |

执行声明：纯计算；读取 execution-context、statuses。

### 状态字段赋值

接口：`status.write-field@1`。

作者目录：原子语句。

修改已选状态实例的封闭可写字段；字段与值类型由受信登记表绑定，规则的安装与移除使用规则语句。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | 状态 | `status`（可空） | 是 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | relatedRules / type / sourceId / name / stacking / visible / expiresAfterTurn / currentDuration / remainingDuration / currentUses / remainingUses / lastDamageTurn / stacks / intensity / hitCount / readyCharges / remainingTurns / grantedTurnNumber / createdTurnNumber / turnNumber / value |
| `valueType` | 值类型 | `string` | 是 | 默认 {"kind":"list","element":"string"}；{"kind":"list","element":"string"} / string / boolean / {"kind":"nullable","value":"number"} / number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 execution-context；写入 statuses。

### 移除棋子状态

接口：`status.remove-piece@1`。

作者目录：原子语句。

通过现有 status lifecycle 移除棋子状态。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `statusId` | statusId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 status、rule、events；事件 afterStatusRemoved。

### 移除玩家状态

接口：`status.remove-player@1`。

作者目录：原子语句。

通过现有 status lifecycle 移除玩家状态。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `statusId` | statusId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 status、rule、events；事件 afterStatusRemoved。

### 附加棋子规则

接口：`rule.apply-piece@1`。

作者目录：原子语句。

通过规则宿主安装已登记规则定义。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `ruleId` | ruleId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 rule、events；事件 ruleAdded。

### 附加玩家规则

接口：`rule.apply-player@1`。

作者目录：原子语句。

通过规则宿主安装已登记玩家规则定义。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `ruleId` | ruleId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 rule、events；事件 ruleAdded。

### 移除棋子规则

接口：`rule.remove-piece@1`。

作者目录：原子语句。

通过规则宿主移除已登记棋子规则。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `ruleId` | ruleId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 rule、events；事件 ruleRemoved。

### 移除玩家规则

接口：`rule.remove-player@1`。

作者目录：原子语句。

通过规则宿主移除已登记玩家规则。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `ruleId` | ruleId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 rule、events；事件 ruleRemoved。

## 变量与数据

### 声明玩家扩展变量

接口：`extension.declare-player@1`。

作者目录：原子语句。

首次声明使用初始值；相同类型的已有变量保留原值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 对象 | `player` | 是 |  |
| `value` | 初始值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 读取玩家扩展变量

接口：`extension.read-player@1`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 对象 | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；读取 extensions。

### 写入玩家扩展变量

接口：`extension.write-player@1`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 对象 | `player` | 是 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 声明棋子扩展变量

接口：`extension.declare-piece@1`。

作者目录：原子语句。

首次声明使用初始值；相同类型的已有变量保留原值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 对象 | `piece` | 是 |  |
| `value` | 初始值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 读取棋子扩展变量

接口：`extension.read-piece@1`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 对象 | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；读取 extensions。

### 写入棋子扩展变量

接口：`extension.write-piece@1`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 对象 | `piece` | 是 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 声明全局扩展变量

接口：`extension.declare-battle@1`。

作者目录：原子语句。

首次声明使用初始值；相同类型的已有变量保留原值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 初始值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 读取全局扩展变量

接口：`extension.read-battle@1`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；读取 extensions。

### 写入全局扩展变量

接口：`extension.write-battle@1`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 声明玩家扩展映射

接口：`extension.map-declare@1`。

作者目录：原子语句。

首次创建空映射；再次声明相同类型保留已有数据。键字段可以保存棋子等实体引用。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 所属玩家 | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `schema` | 记录类型 | `string` | 是 |  |
| `keyField` | 映射键字段 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 记录元组 | `{"kind":"list","element":"record"}` | 是 |  |

记录类型由参数选择的结构声明确定：`{"outputs":{"items":{"parameter":"schema","list":true}}}`。

执行声明：读取 extensions；写入 extensions。

### 读取扩展映射记录

接口：`extension.map-items@1`。

作者目录：原子语句。

操作已经声明的玩家 extension 映射；同一键写入只替换对应记录，其他实例保持独立。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 所属玩家 | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `schema` | 记录类型 | `string` | 是 |  |
| `keyField` | 映射键字段 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 记录元组 | `{"kind":"list","element":"record"}` | 是 |  |

记录类型由参数选择的结构声明确定：`{"outputs":{"items":{"parameter":"schema","list":true}}}`。

执行声明：纯计算；读取 extensions。

### 写入扩展映射项

接口：`extension.map-put@1`。

作者目录：原子语句。

操作已经声明的玩家 extension 映射；同一键写入只替换对应记录，其他实例保持独立。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 所属玩家 | `player` | 是 |  |
| `item` | 记录 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `schema` | 记录类型 | `string` | 是 |  |
| `keyField` | 映射键字段 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 完成 | `boolean` | 是 |  |

记录类型由参数选择的结构声明确定：`{"inputs":{"item":{"parameter":"schema"}}}`。

执行声明：读取 extensions；写入 extensions。

### 删除扩展映射项

接口：`extension.map-remove@1`。

作者目录：原子语句。

操作已经声明的玩家 extension 映射；同一键写入只替换对应记录，其他实例保持独立。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 所属玩家 | `player` | 是 |  |
| `item` | 记录 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `schema` | 记录类型 | `string` | 是 |  |
| `keyField` | 映射键字段 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 完成 | `boolean` | 是 |  |

记录类型由参数选择的结构声明确定：`{"inputs":{"item":{"parameter":"schema"}}}`。

执行声明：读取 extensions；写入 extensions。

### 复制棋子实例

接口：`instance.copy-piece@1`。

作者目录：原子语句。

复制棋子可恢复信息，保留外部实体引用身份；副本可以存入 extension。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `snapshotType` | 副本类型 | `string` | 是 | 默认 author.piece-instance@1 |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `snapshot` | 实例副本 | `record` | 是 |  |

记录类型由参数选择的结构声明确定：`{"outputs":{"snapshot":{"parameter":"snapshotType"}}}`。

执行声明：纯计算；读取 pieces、extensions、rules。

### 应用棋子实例信息

接口：`instance.apply-piece@1`。

作者目录：原子语句。

恢复目标棋子信息，保留场上身份和位置；位置通过位移模块单独处理，不产生普通治疗或状态增删触发。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 目标棋子 | `piece` | 是 |  |
| `snapshot` | 实例副本 | `record` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 完成 | `boolean` | 是 |  |

执行声明：写入 pieces、extensions、rules。

### 声明全局扩展变量

接口：`extension.declare-battle@2`。

作者目录：原子语句。

首次声明使用初始值；相同类型的已有变量保留原值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 初始值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 读取全局扩展变量

接口：`extension.read-battle@2`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `path` | 字段路径 | `{"kind":"list","element":"string"}` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；读取 extensions。

### 写入全局扩展变量

接口：`extension.write-battle@2`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |
| `path` | 字段路径 | `{"kind":"list","element":"string"}` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 声明全局扩展变量

接口：`extension.declare-battle@3`。

作者目录：原子语句。

首次声明使用初始值；相同类型的已有变量保留原值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 初始值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |
| `success` | 完成 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 写入全局扩展变量

接口：`extension.write-battle@3`。

作者目录：原子语句。

可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |
| `path` | 字段路径 | `{"kind":"list","element":"string"}` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认 content |
| `name` | 变量名称 | `string` | 是 |  |
| `path` | 字段路径 | `string` | 否 | 默认  |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |
| `success` | 完成 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 extensions；写入 extensions。

### 删除全局扩展变量

接口：`extension.remove-battle@1`。

作者目录：原子语句。

删除一个已声明的扩展根字段；字段不存在时返回失败，不以空记录替代缺失字段。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `namespace` | 扩展分组 | `string` | 否 | 默认  |
| `name` | 变量名称 | `string` | 是 |  |
| `valueType` | 值类型 | `string` | 是 | 默认 record |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 完成 | `boolean` | 是 |  |

执行声明：写入 extensions。

### 当前事件棋子

接口：`ref.event-piece@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

执行声明：纯计算；读取 event。

### 增加棋子属性

接口：`attribute.adjust@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |
| `amount` | amount | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `attribute` | attribute | `string` | 是 | 默认 attack；attack / defense / moveRange |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：写入 attributes。

### 当前手牌

接口：`ref.current-card@1`。

作者目录：原子语句。

当前正在使用或响应事件的那一张手牌实例；同名卡牌各自独立。

允许入口：card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `card` | 手牌实例 | `record` | 是 |  |

执行声明：纯计算；读取 execution-context。

### 卡牌

接口：`ref.card-definition@1`。

作者目录：原子语句。

在内容库中选取一张卡牌，作为带类型的卡牌引用。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `cardId` | 卡牌 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `card` | 卡牌 | `card` | 是 |  |

执行声明：纯计算；可预览。

### 卡牌模板

接口：`ref.card-template@1`。

作者目录：原子语句。

从受信内容目录中选择一份卡牌模板；模板只能作为结构化模板引用传给创建卡牌语句。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `templateId` | 模板 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `template` | 卡牌模板 | `content` | 是 |  |

执行声明：纯计算；可预览；读取 content。

### 当前技能实例

接口：`ref.current-skill@1`。

作者目录：原子语句。

取得当前正在执行的实际技能实例；不存在有效实例时由运行时使语句失效。

允许入口：skill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | 技能实例 | `record` | 是 |  |

执行声明：纯计算；读取 execution-context、skills。

### 读取技能实例字段

接口：`author.skill-instance.field@1`。

作者目录：原子语句。

读取实际技能实例的登记字段；不把技能定义或任意记录当作实例。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | 技能实例 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | currentCooldown / usesRemaining / skillId / level / owner / powerMultiplier |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `currentCooldown` | `number` |
| `usesRemaining` | `number` |
| `skillId` | `string` |
| `level` | `number` |
| `owner` | `piece` |
| `powerMultiplier` | `number` |

执行声明：纯计算；读取 execution-context、skills。

### 当前能力组实例

接口：`ref.current-cluster@1`。

作者目录：原子语句。

取得当前执行的主动技能或规则所属的实际能力组实例；没有唯一有效归属时由运行时使语句失效。

允许入口：skill、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `group` | 能力组实例 | `record` | 是 |  |

执行声明：纯计算；读取 execution-context、pieces。

### 创建空记录

接口：`record.empty@1`。

作者目录：原子语句。

创建一个新的空记录，供通用字段构造原语逐项填充。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record` | 是 |  |

执行声明：纯计算；可预览。

### 设置记录字段

接口：`record.set-field@1`。

作者目录：原子语句。

复制记录并设置一个安全的直接字段；未知字段保持原样。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record` | 是 |  |
| `value` | value | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 |  |
| `valueType` | valueType | `string` | 是 | 默认 record |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 声明实体实例扩展变量

接口：`extension.declare-instance@1`。

作者目录：原子语句。

在具体技能、状态、规则、手牌、能力组或地格效果实例上声明扩展变量；旧实例首次声明时保留原值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `entity` | 实体实例 | `record` | 是 |  |
| `value` | 初始值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `entityKind` | entityKind | `string` | 是 | skill / status / rule / card / cluster / tile-effect |
| `namespace` | namespace | `string` | 否 | 默认 content |
| `name` | name | `string` | 是 |  |
| `valueType` | valueType | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 entity-extensions；写入 entity-extensions。

### 读取实体实例扩展变量

接口：`extension.read-instance@1`。

作者目录：原子语句。

读取具体实体实例上已声明的扩展字段；实例失效、字段缺失或声明类型变化会使语句失效。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `entity` | 实体实例 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `entityKind` | entityKind | `string` | 是 | skill / status / rule / card / cluster / tile-effect |
| `namespace` | namespace | `string` | 否 | 默认 content |
| `name` | name | `string` | 是 |  |
| `path` | path | `string` | 否 | 默认  |
| `valueType` | valueType | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；读取 entity-extensions。

### 写入实体实例扩展变量

接口：`extension.write-instance@1`。

作者目录：原子语句。

原子写入具体实体实例上已声明的扩展字段，保留实体对象身份和其他扩展字段。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `entity` | 实体实例 | `record` | 是 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `entityKind` | entityKind | `string` | 是 | skill / status / rule / card / cluster / tile-effect |
| `namespace` | namespace | `string` | 否 | 默认 content |
| `name` | name | `string` | 是 |  |
| `path` | path | `string` | 否 | 默认  |
| `valueType` | valueType | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：读取 entity-extensions；写入 entity-extensions。

### 当前规则实例

接口：`ref.current-rule@1`。

作者目录：原子语句。

取得当前正在执行的实际规则实例；不存在有效实例时由运行时使语句失效。

允许入口：rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | 规则实例 | `record` | 是 |  |

执行声明：纯计算；读取 execution-context、rules。

### 读取棋子登记阵营

接口：`piece.raw-faction@1`。

作者目录：原子语句。

读取棋子记录本身的 faction 字段；用于保留旧查询的字段不相等语义，不替换为玩家队伍映射。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `faction` | faction | `{"kind":"nullable","value":"string"}` | 是 |  |

执行声明：纯计算；读取 pieces。

### 当前规则持有棋子

接口：`ref.rule-piece@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：rule。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece`（可空） | 是 |  |

执行声明：纯计算；读取 event。

### 技能预览结果

接口：`preview.result@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `description` | description | `string` | 是 |  |
| `damage` | damage | `number` | 否 |  |
| `heal` | heal | `number` | 否 |  |
| `attackBonus` | attackBonus | `number` | 否 |  |
| `selfDamage` | selfDamage | `number` | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | result | `record` | 是 |  |

执行声明：纯计算；可预览。

### 设定棋子属性

接口：`attribute.set@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |
| `value` | value | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `attribute` | attribute | `string` | 是 | attack / defense / moveRange |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：写入 attributes。

### 本次执行时间

接口：`identity.host-time@1`。

作者目录：原子语句。

在正式规则执行绑定下读取确定性宿主时钟数值；只读，保持既有标识和回放语义，不直接访问全局真实时钟。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：读取 runtime-identity。

### 保留本次结算来源

接口：`source.capture@1`。

作者目录：原子语句。

仅为当前执行保留来源归属；来源离场后已开始的效果可继续结算，不允许来源重新行动。句柄不能跨执行使用。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `record` | 是 |  |

执行声明：读取 pieces；写入 execution-context。

### 保留当前事件棋子

接口：`source.capture-event-piece@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | sourcePiece / targetPiece / piece / rulePiece |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `record`（可空） | 是 |  |

执行声明：写入 execution-context。

### 读取在场或历史棋子字段

接口：`piece.stored-field@1`。

作者目录：原子语句。

按稳定棋子标识读取登记的标量字段；当前棋子和墓地均可读，缺失字段返回空值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | id | `string`（可空） | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | name / templateId / attack / defense / moveRange |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `exists` | exists | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `name` | `{"kind":"nullable","value":"string"}` |
| `templateId` | `{"kind":"nullable","value":"string"}` |
| `attack` | `{"kind":"nullable","value":"number"}` |
| `defense` | `{"kind":"nullable","value":"number"}` |
| `moveRange` | `{"kind":"nullable","value":"number"}` |

执行声明：纯计算；读取 pieces、graveyard。

### 读取棋子字段

接口：`piece.field@1`。

作者目录：原子语句。

读取已验证且仍在场棋子的封闭字段；HP 为零仍可读取身份、数值和历史结算所需事实。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | ownerPlayerId / instanceId / templateId / isCore / currentHp / maxHp / attack / defense / moveRange / momentum / x / y / name / faction / statusTags / rules / skills / spentPassives |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `ownerPlayerId` | `player` |
| `instanceId` | `string` |
| `templateId` | `string` |
| `isCore` | `boolean` |
| `currentHp` | `number` |
| `maxHp` | `number` |
| `attack` | `number` |
| `defense` | `number` |
| `moveRange` | `number` |
| `momentum` | `number` |
| `x` | `number` |
| `y` | `number` |
| `name` | `string` |
| `faction` | `string` |
| `statusTags` | `{"kind":"list","element":"record"}` |
| `rules` | `{"kind":"list","element":"record"}` |
| `skills` | `{"kind":"list","element":"record"}` |
| `spentPassives` | `{"kind":"list","element":"string"}` |

执行声明：纯计算；读取 pieces、players。

### 读取棋子字段

接口：`piece.field@2`。

作者目录：原子语句。

读取存活棋子的封闭字段；死亡事件的已保留数据通过事件记录读取。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | ownerPlayerId / instanceId / templateId / isCore / currentHp / maxHp / attack / defense / moveRange / momentum / x / y / name / faction / statusTags / rules / skills / spentPassives |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `ownerPlayerId` | `player` |
| `instanceId` | `string` |
| `templateId` | `string` |
| `isCore` | `boolean` |
| `currentHp` | `number` |
| `maxHp` | `number` |
| `attack` | `number` |
| `defense` | `number` |
| `moveRange` | `number` |
| `momentum` | `number` |
| `x` | `number` |
| `y` | `number` |
| `name` | `string` |
| `faction` | `string` |
| `statusTags` | `{"kind":"list","element":"record"}` |
| `rules` | `{"kind":"list","element":"record"}` |
| `skills` | `{"kind":"list","element":"record"}` |
| `spentPassives` | `{"kind":"list","element":"string"}` |

执行声明：纯计算；读取 pieces、players。

### 读取战斗字段

接口：`battle.field@1`。

作者目录：原子语句。

读取战斗上下文的封闭只读字段；集合返回不可变快照。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | tileEffects / turnNumber / currentPlayerId |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `tileEffects` | `{"kind":"list","element":"record"}` |
| `turnNumber` | `number` |
| `currentPlayerId` | `player` |

执行声明：纯计算；读取 turn、tile-effects、players。

### 棋子字段赋值

接口：`piece.write-field@1`。

作者目录：原子语句。

给棋子的可写记账字段赋值；动能写入委托权威属性边界，已用被动列表使用新元组。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | spentPassives / momentum / currentHp / maxHp |
| `valueType` | 值类型 | `string` | 是 | 默认 {"kind":"list","element":"string"}；{"kind":"list","element":"string"} / number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：写入 skills、attributes。

### 棋子字段赋值

接口：`piece.write-field@2`。

作者目录：原子语句。

用统一赋值句式写入封闭战斗属性；当前棋子走实时权威属性入口，已保存棋子记录走在场或墓地记录入口，其中 showFreezeEffect 为布尔表现标记；值类型由字段推断。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 当前棋子 | `piece` | 否 |  |
| `id` | 已保存棋子标识 | `string` | 否 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `scope` | 目标范围 | `string` | 是 | 默认 live；live / stored |
| `field` | 字段 | `string` | 是 | spentPassives / momentum / currentHp / maxHp / attack / defense / moveRange / showFreezeEffect |
| `valueType` | 值类型 | `string` | 是 | 默认 number；{"kind":"list","element":"string"} / number / boolean |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：写入 attributes、pieces、graveyard。

### 玩家字段赋值

接口：`player.write-field@1`。

作者目录：原子语句。

给玩家可写的状态记录字段赋值；状态添加和驱散事件由对应效果语句处理。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 玩家 | `player` | 是 |  |
| `value` | 值 | `{"kind":"list","element":"record"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | statusTags |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 statuses。

### 读取玩家字段

接口：`player.field@1`。

作者目录：原子语句。

读取玩家的封闭只读字段；阵营字段使用权威可比较阵营键。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | player | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | name / faction / actionPoints / chargePoints / maxActionPoints / statusTags |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |
| `exists` | 原字段已定义 | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `name` | `string` |
| `faction` | `string` |
| `actionPoints` | `number` |
| `chargePoints` | `number` |
| `maxActionPoints` | `number` |
| `statusTags` | `{"kind":"list","element":"record"}` |

执行声明：纯计算；读取 players。

### 读取记录字段

接口：`data.field@1`。

作者目录：原子语句。

读取受信记录视图的封闭字段；只返回不可变快照或不可变标量。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | attack / defense / moveRange / currentHp / maxHp / id / type / name / sourceId / sourcePieceId / ownerPlayerId / targetId / skillId / flightId / legacyText / lastDamageTurn / stacks / intensity / currentDuration / remainingDuration / currentUses / remainingUses / value / amount / damage / actualDamage / rawDamage / modifiedDamage / resolvedDamage / targetHp / x / y / heal / rawHeal / modifiedHeal / totalDamage / totalHeal / blocked / isKilled / success / noKillCharge / statusTags / rules / results / skillIds |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |
| `exists` | 原字段已定义 | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `attack` | `number` |
| `defense` | `number` |
| `moveRange` | `number` |
| `currentHp` | `number` |
| `maxHp` | `number` |
| `id` | `{"kind":"nullable","value":"string"}` |
| `type` | `{"kind":"nullable","value":"string"}` |
| `name` | `{"kind":"nullable","value":"string"}` |
| `sourceId` | `{"kind":"nullable","value":"string"}` |
| `sourcePieceId` | `{"kind":"nullable","value":"string"}` |
| `ownerPlayerId` | `{"kind":"nullable","value":"string"}` |
| `targetId` | `{"kind":"nullable","value":"string"}` |
| `skillId` | `{"kind":"nullable","value":"string"}` |
| `flightId` | `{"kind":"nullable","value":"string"}` |
| `legacyText` | `{"kind":"nullable","value":"string"}` |
| `lastDamageTurn` | `number` |
| `stacks` | `number` |
| `intensity` | `number` |
| `currentDuration` | `number` |
| `remainingDuration` | `number` |
| `currentUses` | `number` |
| `remainingUses` | `number` |
| `value` | `number` |
| `amount` | `number` |
| `damage` | `number` |
| `actualDamage` | `number` |
| `rawDamage` | `number` |
| `modifiedDamage` | `number` |
| `resolvedDamage` | `number` |
| `targetHp` | `number` |
| `x` | `number` |
| `y` | `number` |
| `heal` | `number` |
| `rawHeal` | `number` |
| `modifiedHeal` | `number` |
| `totalDamage` | `number` |
| `totalHeal` | `number` |
| `blocked` | `boolean` |
| `isKilled` | `boolean` |
| `success` | `boolean` |
| `noKillCharge` | `boolean` |
| `statusTags` | `{"kind":"list","element":"record"}` |
| `rules` | `{"kind":"list","element":"record"}` |
| `results` | `{"kind":"list","element":"record"}` |
| `skillIds` | `{"kind":"list","element":"string"}` |

执行声明：纯计算；读取 records。

### 读取已保留来源字段

接口：`source.fields@1`。

作者目录：原子语句。

读取执行期间保留的来源快照；来源离场后仍可读取历史身份事实。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `record` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record` | 是 |  |

执行声明：纯计算；读取 execution-context。

### 读取来源数值字段

接口：`source.field@1`。

作者目录：原子语句。

按封闭字段读取执行期间保留的来源数值；来源离场后仍使用同一认证来源句柄。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | 来源 | `{"kind":"nullable","value":"record"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | attack / defense / moveRange |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `attack` | `number` |
| `defense` | `number` |
| `moveRange` | `number` |

执行声明：纯计算；读取 execution-context、pieces。

### 来源字段赋值

接口：`source.write-field@1`。

作者目录：原子语句。

将封闭来源数值字段写回认证来源；不暴露来源对象路径或任意字段。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | 来源 | `{"kind":"nullable","value":"record"}` | 是 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | attack / defense / moveRange |
| `valueType` | 值类型 | `string` | 是 | 默认 number；number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |
| `value` | value | `number` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：写入 attributes。

### 读取记录字段

接口：`data.field@2`。

作者目录：原子语句。

读取封闭字段；实例标识保留文本，所属玩家保留玩家引用类型。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | attack / defense / moveRange / currentHp / maxHp / id / type / name / sourceId / sourcePieceId / ownerPlayerId / targetId / skillId / flightId / legacyText / lastDamageTurn / stacks / intensity / currentDuration / remainingDuration / currentUses / remainingUses / value / amount / damage / actualDamage / rawDamage / modifiedDamage / resolvedDamage / targetHp / x / y / heal / rawHeal / modifiedHeal / totalDamage / totalHeal / blocked / isKilled / success / noKillCharge / statusTags / rules / results / skillIds / instanceId |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |
| `exists` | 原字段已定义 | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `attack` | `number` |
| `defense` | `number` |
| `moveRange` | `number` |
| `currentHp` | `number` |
| `maxHp` | `number` |
| `id` | `{"kind":"nullable","value":"string"}` |
| `type` | `{"kind":"nullable","value":"string"}` |
| `name` | `{"kind":"nullable","value":"string"}` |
| `sourceId` | `{"kind":"nullable","value":"string"}` |
| `sourcePieceId` | `{"kind":"nullable","value":"string"}` |
| `ownerPlayerId` | `player` |
| `targetId` | `{"kind":"nullable","value":"string"}` |
| `skillId` | `{"kind":"nullable","value":"string"}` |
| `flightId` | `{"kind":"nullable","value":"string"}` |
| `legacyText` | `{"kind":"nullable","value":"string"}` |
| `lastDamageTurn` | `number` |
| `stacks` | `number` |
| `intensity` | `number` |
| `currentDuration` | `number` |
| `remainingDuration` | `number` |
| `currentUses` | `number` |
| `remainingUses` | `number` |
| `value` | `number` |
| `amount` | `number` |
| `damage` | `number` |
| `actualDamage` | `number` |
| `rawDamage` | `number` |
| `modifiedDamage` | `number` |
| `resolvedDamage` | `number` |
| `targetHp` | `number` |
| `x` | `number` |
| `y` | `number` |
| `heal` | `number` |
| `rawHeal` | `number` |
| `modifiedHeal` | `number` |
| `totalDamage` | `number` |
| `totalHeal` | `number` |
| `blocked` | `boolean` |
| `isKilled` | `boolean` |
| `success` | `boolean` |
| `noKillCharge` | `boolean` |
| `statusTags` | `{"kind":"list","element":"record"}` |
| `rules` | `{"kind":"list","element":"record"}` |
| `results` | `{"kind":"list","element":"record"}` |
| `skillIds` | `{"kind":"list","element":"string"}` |
| `instanceId` | `string` |

执行声明：纯计算；读取 records。

### 读取可空记录字段

接口：`data.optional-field@1`。

作者目录：原子语句。

从可空记录读取封闭字段；缺失或空值返回空，字段类型错误保持无效依赖。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record`（可空） | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | id / type / kind / name / templateId / instanceId / sourceId / targetId / skillId / ownerPlayerId / stacks / intensity / value / currentDuration / remainingDuration / currentUses / remainingUses / turnNumber / createdTurnNumber / lastDamageTurn / turns / extraValue / hitCount / readyCharges / dx / dy / centerX / centerY / damage / maxHp / attack / defense / moveRange / currentHp / momentum / left / right / statusTags / pathCells / skillIds / stats |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `id` | `{"kind":"nullable","value":"string"}` |
| `type` | `{"kind":"nullable","value":"string"}` |
| `kind` | `{"kind":"nullable","value":"string"}` |
| `name` | `{"kind":"nullable","value":"string"}` |
| `templateId` | `{"kind":"nullable","value":"string"}` |
| `instanceId` | `{"kind":"nullable","value":"string"}` |
| `sourceId` | `{"kind":"nullable","value":"string"}` |
| `targetId` | `{"kind":"nullable","value":"string"}` |
| `skillId` | `{"kind":"nullable","value":"string"}` |
| `ownerPlayerId` | `{"kind":"nullable","value":"player"}` |
| `stacks` | `{"kind":"nullable","value":"number"}` |
| `intensity` | `{"kind":"nullable","value":"number"}` |
| `value` | `{"kind":"nullable","value":"number"}` |
| `currentDuration` | `{"kind":"nullable","value":"number"}` |
| `remainingDuration` | `{"kind":"nullable","value":"number"}` |
| `currentUses` | `{"kind":"nullable","value":"number"}` |
| `remainingUses` | `{"kind":"nullable","value":"number"}` |
| `turnNumber` | `{"kind":"nullable","value":"number"}` |
| `createdTurnNumber` | `{"kind":"nullable","value":"number"}` |
| `lastDamageTurn` | `{"kind":"nullable","value":"number"}` |
| `turns` | `{"kind":"nullable","value":"number"}` |
| `extraValue` | `{"kind":"nullable","value":"number"}` |
| `hitCount` | `{"kind":"nullable","value":"number"}` |
| `readyCharges` | `{"kind":"nullable","value":"number"}` |
| `dx` | `{"kind":"nullable","value":"number"}` |
| `dy` | `{"kind":"nullable","value":"number"}` |
| `centerX` | `{"kind":"nullable","value":"number"}` |
| `centerY` | `{"kind":"nullable","value":"number"}` |
| `damage` | `{"kind":"nullable","value":"number"}` |
| `maxHp` | `{"kind":"nullable","value":"number"}` |
| `attack` | `{"kind":"nullable","value":"number"}` |
| `defense` | `{"kind":"nullable","value":"number"}` |
| `moveRange` | `{"kind":"nullable","value":"number"}` |
| `currentHp` | `{"kind":"nullable","value":"number"}` |
| `momentum` | `{"kind":"nullable","value":"number"}` |
| `left` | `{"kind":"nullable","value":"cell"}` |
| `right` | `{"kind":"nullable","value":"cell"}` |
| `statusTags` | `{"kind":"nullable","value":{"kind":"list","element":"record"}}` |
| `pathCells` | `{"kind":"nullable","value":{"kind":"list","element":"cell"}}` |
| `skillIds` | `{"kind":"nullable","value":{"kind":"list","element":"string"}}` |
| `stats` | `{"kind":"nullable","value":"record"}` |

执行声明：纯计算；可预览。

### 读取观察记录字段

接口：`observation.field@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `event` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | 默认 type；type / distance / blocksProjectile / piece / x / y |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `type` | `string` |
| `distance` | `number` |
| `blocksProjectile` | `boolean` |
| `piece` | `{"kind":"nullable","value":"piece"}` |
| `x` | `number` |
| `y` | `number` |

执行声明：纯计算；读取 event。

### 读取上下文字段

接口：`context.field@1`。

作者目录：原子语句。

读取宿主上下文中的封闭标量字段；空字段返回可空值并保留字段存在性。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | damage / actualDamage / heal / amount / targetX / targetY / turnNumber / fromX / fromY / skillId / playerId / cardId / statusId / statusType / cancelled |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `damage` | `{"kind":"nullable","value":"number"}` |
| `actualDamage` | `{"kind":"nullable","value":"number"}` |
| `heal` | `{"kind":"nullable","value":"number"}` |
| `amount` | `{"kind":"nullable","value":"number"}` |
| `targetX` | `{"kind":"nullable","value":"number"}` |
| `targetY` | `{"kind":"nullable","value":"number"}` |
| `turnNumber` | `{"kind":"nullable","value":"number"}` |
| `fromX` | `{"kind":"nullable","value":"number"}` |
| `fromY` | `{"kind":"nullable","value":"number"}` |
| `skillId` | `{"kind":"nullable","value":"string"}` |
| `playerId` | `{"kind":"nullable","value":"string"}` |
| `cardId` | `{"kind":"nullable","value":"string"}` |
| `statusId` | `{"kind":"nullable","value":"string"}` |
| `statusType` | `{"kind":"nullable","value":"string"}` |
| `cancelled` | `boolean` |

执行声明：纯计算；读取 event。

### 读取技能字段

接口：`skill.field@1`。

作者目录：原子语句。

读取技能上下文中的封闭不可变标量字段。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | powerMultiplier / actionPointCost / chargeCost / cooldown / name / description |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `powerMultiplier` | `number` |
| `actionPointCost` | `number` |
| `chargeCost` | `number` |
| `cooldown` | `number` |
| `name` | `string` |
| `description` | `string` |

执行声明：纯计算；读取 skill。

### 读取上下文字段

接口：`context.field@2`。

作者目录：原子语句。

读取宿主上下文中的封闭标量或选择集合；缺失集合按旧选择读取规则返回空集合。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | damage / actualDamage / heal / amount / targetX / targetY / turnNumber / fromX / fromY / skillId / playerId / cardId / statusId / statusType / cancelled / isSinglePieceTargetAction / reservedCells / selectedTargets / selectedOption |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `damage` | `{"kind":"nullable","value":"number"}` |
| `actualDamage` | `{"kind":"nullable","value":"number"}` |
| `heal` | `{"kind":"nullable","value":"number"}` |
| `amount` | `{"kind":"nullable","value":"number"}` |
| `targetX` | `{"kind":"nullable","value":"number"}` |
| `targetY` | `{"kind":"nullable","value":"number"}` |
| `turnNumber` | `{"kind":"nullable","value":"number"}` |
| `fromX` | `{"kind":"nullable","value":"number"}` |
| `fromY` | `{"kind":"nullable","value":"number"}` |
| `skillId` | `{"kind":"nullable","value":"string"}` |
| `playerId` | `{"kind":"nullable","value":"string"}` |
| `cardId` | `{"kind":"nullable","value":"string"}` |
| `statusId` | `{"kind":"nullable","value":"string"}` |
| `statusType` | `{"kind":"nullable","value":"string"}` |
| `cancelled` | `boolean` |
| `isSinglePieceTargetAction` | `boolean` |
| `reservedCells` | `{"kind":"list","element":"cell"}` |
| `selectedTargets` | `{"kind":"list","element":"choice"}` |
| `selectedOption` | `{"kind":"nullable","value":"string"}` |

执行声明：纯计算；读取 event。

### 读取事件字段

接口：`event.field@2`。

作者目录：原子语句。

读取事件快照的封闭历史字段并保留旧读取器的 undefined 缺失语义。

允许入口：rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | type / playerId / actualDamage / movementKind |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `type` | `{"kind":"nullable","value":"string"}` |
| `playerId` | `{"kind":"nullable","value":"player"}` |
| `actualDamage` | `{"kind":"nullable","value":"number"}` |
| `movementKind` | `{"kind":"nullable","value":"string"}` |

执行声明：纯计算；读取 event。

### 读取战斗字段

接口：`battle.field@3`。

作者目录：原子语句。

读取战斗回合封闭字段并保留旧回合读取器的原始缺失语义。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | turnNumber / currentPlayerId |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `turnNumber` | `number` |
| `currentPlayerId` | `player` |

执行声明：纯计算；读取 turn。

### 读取当前卡牌字段

接口：`context.field@3`。

作者目录：原子语句。

读取当前动态卡牌上下文中的标识或触发类型，并保留宿主的空文本回退。

允许入口：card。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | currentCardId / currentCardType |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `string` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `currentCardId` | `string` |
| `currentCardType` | `string` |

执行声明：纯计算；读取 context。

### 读取规则上下文字段

接口：`context.field@4`。

作者目录：原子语句。

读取规则来源玩家字段并保留玩家引用类型；可以保留字段缺失语义。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | ruleOwnerPlayerId / playerId / ruleRewrittenPrimaryTargetPieceId |
| `preserveMissing` | preserveMissing | `boolean` | 是 | 默认 false |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `ruleOwnerPlayerId` | `{"kind":"nullable","value":"player"}` |
| `playerId` | `{"kind":"nullable","value":"player"}` |
| `ruleRewrittenPrimaryTargetPieceId` | `{"kind":"nullable","value":"piece"}` |

执行声明：纯计算；读取 event。

### 读取预览棋子字段

接口：`preview.piece-field@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | attack / defense / moveRange / currentHp / maxHp / stats / statusTags |
| `missing` | missing | `string` | 是 | 默认 undefined；undefined / null |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `attack` | `number` |
| `defense` | `number` |
| `moveRange` | `number` |
| `currentHp` | `number` |
| `maxHp` | `number` |
| `stats` | `{"kind":"nullable","value":"record"}` |
| `statusTags` | `{"kind":"nullable","value":{"kind":"list","element":"record"}}` |

执行声明：纯计算；可预览；读取 preview-input。

### 读取预览技能字段

接口：`preview.skill-field@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `skill` | skill | `content` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | powerMultiplier / actionPointCost / chargeCost / cooldown / description |
| `missing` | missing | `string` | 是 | 默认 undefined；undefined / null |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `powerMultiplier` | `number` |
| `actionPointCost` | `number` |
| `chargeCost` | `number` |
| `cooldown` | `number` |
| `description` | `string` |

执行声明：纯计算；可预览；读取 preview-input。

### 读取预览记录字段

接口：`preview.record-field@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record`（可空） | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | type / intensity / maxHp |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `type` | `{"kind":"nullable","value":"string"}` |
| `intensity` | `{"kind":"nullable","value":"number"}` |
| `maxHp` | `{"kind":"nullable","value":"number"}` |

执行声明：纯计算；可预览；读取 preview-input。

### 读取战斗原始字段

接口：`battle.field@2`。

作者目录：原子语句。

读取战斗回合的封闭原始字段并保留字段存在性；转换由通用值原子完成。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | turnNumber |
| `missing` | missing | `string` | 是 | 默认 undefined；undefined / null |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `turnNumber` | `{"kind":"nullable","value":"number"}` |

执行声明：纯计算；读取 turn。

### 读取可空棋子字段

接口：`piece.optional-field@1`。

作者目录：原子语句。

从当前棋子读取可空直接字段；缺失和空值返回空，数值内容保留原始值供调用方自行判断。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 |  |
| `valueType` | valueType | `string` | 是 | 默认 number；string / number / boolean / piece / player / {"kind":"nullable","value":"string"} / {"kind":"nullable","value":"number"} / {"kind":"nullable","value":"boolean"} / {"kind":"nullable","value":"piece"} / {"kind":"nullable","value":"player"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `string` | `string` |
| `number` | `number` |
| `boolean` | `boolean` |
| `piece` | `piece` |
| `player` | `player` |
| `{"kind":"nullable","value":"string"}` | `{"kind":"nullable","value":"string"}` |
| `{"kind":"nullable","value":"number"}` | `{"kind":"nullable","value":"number"}` |
| `{"kind":"nullable","value":"boolean"}` | `{"kind":"nullable","value":"boolean"}` |
| `{"kind":"nullable","value":"piece"}` | `{"kind":"nullable","value":"piece"}` |
| `{"kind":"nullable","value":"player"}` | `{"kind":"nullable","value":"player"}` |

执行声明：纯计算；可预览；读取 pieces。

### 读取战斗扩展字段

接口：`battle.field@4`。

作者目录：原子语句。

从战斗扩展记录读取一个类型封闭的直接字段；缺失和空值返回空，错误类型保持无效依赖。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 |  |
| `valueType` | valueType | `string` | 是 | 默认 string；string / number / boolean / piece / player / {"kind":"nullable","value":"string"} / {"kind":"nullable","value":"number"} / {"kind":"nullable","value":"boolean"} / {"kind":"nullable","value":"piece"} / {"kind":"nullable","value":"player"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `string` | `string` |
| `number` | `number` |
| `boolean` | `boolean` |
| `piece` | `piece` |
| `player` | `player` |
| `{"kind":"nullable","value":"string"}` | `{"kind":"nullable","value":"string"}` |
| `{"kind":"nullable","value":"number"}` | `{"kind":"nullable","value":"number"}` |
| `{"kind":"nullable","value":"boolean"}` | `{"kind":"nullable","value":"boolean"}` |
| `{"kind":"nullable","value":"piece"}` | `{"kind":"nullable","value":"piece"}` |
| `{"kind":"nullable","value":"player"}` | `{"kind":"nullable","value":"player"}` |

执行声明：纯计算；可预览；读取 extensions。

### 读取战斗扩展记录

接口：`battle.extensions@1`。

作者目录：原子语句。

读取战斗状态中的只读扩展记录；扩展容器缺失时返回空值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record`（可空） | 是 |  |

执行声明：纯计算；可预览；读取 extensions。

### 按键读取可空记录字段

接口：`record.optional-field@1`。

作者目录：原子语句。

从可空记录读取一个类型封闭的直接字段；缺失和空值返回空，错误类型保持无效依赖。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record`（可空） | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 |  |
| `valueType` | valueType | `string` | 是 | 默认 string；string / number / boolean / piece / player / {"kind":"nullable","value":"string"} / {"kind":"nullable","value":"number"} / {"kind":"nullable","value":"boolean"} / {"kind":"nullable","value":"piece"} / {"kind":"nullable","value":"player"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `string` | `string` |
| `number` | `number` |
| `boolean` | `boolean` |
| `piece` | `piece` |
| `player` | `player` |
| `{"kind":"nullable","value":"string"}` | `{"kind":"nullable","value":"string"}` |
| `{"kind":"nullable","value":"number"}` | `{"kind":"nullable","value":"number"}` |
| `{"kind":"nullable","value":"boolean"}` | `{"kind":"nullable","value":"boolean"}` |
| `{"kind":"nullable","value":"piece"}` | `{"kind":"nullable","value":"piece"}` |
| `{"kind":"nullable","value":"player"}` | `{"kind":"nullable","value":"player"}` |

执行声明：纯计算；可预览；读取 records。

### 删除记录中的字段

接口：`data.omit-key@1`。

作者目录：原子语句。

返回删除指定字段后的记录副本；不修改原记录，键按完整文本处理。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | 记录 | `record` | 是 |  |
| `key` | 字段 | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 新记录 | `record` | 是 |  |

执行声明：纯计算；可预览。

### 按键设置记录字段

接口：`record.set-key@1`。

作者目录：原子语句。

复制记录并按运行时安全键写入值；不修改输入记录。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | 记录 | `record` | 是 |  |
| `key` | 字段 | `string` | 是 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | valueType | `string` | 是 | 默认 {"kind":"list","element":"record"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | 新记录 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 记录为空

接口：`record.is-empty@1`。

作者目录：原子语句。

判断一个普通记录是否没有自有字段。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | 记录 | `record` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 是否为空 | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 按键读取记录字段

接口：`data.read-key@1`。

作者目录：原子语句。

从记录读取一个安全的直接键，并按封闭值类型返回不可变快照；缺失返回可空值。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record`（可空） | 是 |  |
| `key` | 动态键 | `string` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `key` | key | `string` | 否 | 默认  |
| `valueType` | valueType | `string` | 是 | 默认 {"kind":"nullable","value":"string"}；string / number / boolean / piece / player / cell / choice / record / {"kind":"list","element":"string"} / {"kind":"list","element":"number"} / {"kind":"list","element":"boolean"} / {"kind":"list","element":"piece"} / {"kind":"list","element":"player"} / {"kind":"list","element":"cell"} / {"kind":"list","element":"choice"} / {"kind":"list","element":"record"} / {"kind":"nullable","value":"string"} / {"kind":"nullable","value":"number"} / {"kind":"nullable","value":"boolean"} / {"kind":"nullable","value":"piece"} / {"kind":"nullable","value":"player"} / {"kind":"nullable","value":"cell"} / {"kind":"nullable","value":"choice"} / {"kind":"nullable","value":"record"} / {"kind":"nullable","value":{"kind":"list","element":"string"}} / {"kind":"nullable","value":{"kind":"list","element":"number"}} / {"kind":"nullable","value":{"kind":"list","element":"boolean"}} / {"kind":"nullable","value":{"kind":"list","element":"piece"}} / {"kind":"nullable","value":{"kind":"list","element":"player"}} / {"kind":"nullable","value":{"kind":"list","element":"cell"}} / {"kind":"nullable","value":{"kind":"list","element":"choice"}} / {"kind":"nullable","value":{"kind":"list","element":"record"}} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `string` | `string` |
| `number` | `number` |
| `boolean` | `boolean` |
| `piece` | `piece` |
| `player` | `player` |
| `cell` | `cell` |
| `choice` | `choice` |
| `record` | `record` |
| `{"kind":"list","element":"string"}` | `{"kind":"list","element":"string"}` |
| `{"kind":"list","element":"number"}` | `{"kind":"list","element":"number"}` |
| `{"kind":"list","element":"boolean"}` | `{"kind":"list","element":"boolean"}` |
| `{"kind":"list","element":"piece"}` | `{"kind":"list","element":"piece"}` |
| `{"kind":"list","element":"player"}` | `{"kind":"list","element":"player"}` |
| `{"kind":"list","element":"cell"}` | `{"kind":"list","element":"cell"}` |
| `{"kind":"list","element":"choice"}` | `{"kind":"list","element":"choice"}` |
| `{"kind":"list","element":"record"}` | `{"kind":"list","element":"record"}` |
| `{"kind":"nullable","value":"string"}` | `{"kind":"nullable","value":"string"}` |
| `{"kind":"nullable","value":"number"}` | `{"kind":"nullable","value":"number"}` |
| `{"kind":"nullable","value":"boolean"}` | `{"kind":"nullable","value":"boolean"}` |
| `{"kind":"nullable","value":"piece"}` | `{"kind":"nullable","value":"piece"}` |
| `{"kind":"nullable","value":"player"}` | `{"kind":"nullable","value":"player"}` |
| `{"kind":"nullable","value":"cell"}` | `{"kind":"nullable","value":"cell"}` |
| `{"kind":"nullable","value":"choice"}` | `{"kind":"nullable","value":"choice"}` |
| `{"kind":"nullable","value":"record"}` | `{"kind":"nullable","value":"record"}` |
| `{"kind":"nullable","value":{"kind":"list","element":"string"}}` | `{"kind":"nullable","value":{"kind":"list","element":"string"}}` |
| `{"kind":"nullable","value":{"kind":"list","element":"number"}}` | `{"kind":"nullable","value":{"kind":"list","element":"number"}}` |
| `{"kind":"nullable","value":{"kind":"list","element":"boolean"}}` | `{"kind":"nullable","value":{"kind":"list","element":"boolean"}}` |
| `{"kind":"nullable","value":{"kind":"list","element":"piece"}}` | `{"kind":"nullable","value":{"kind":"list","element":"piece"}}` |
| `{"kind":"nullable","value":{"kind":"list","element":"player"}}` | `{"kind":"nullable","value":{"kind":"list","element":"player"}}` |
| `{"kind":"nullable","value":{"kind":"list","element":"cell"}}` | `{"kind":"nullable","value":{"kind":"list","element":"cell"}}` |
| `{"kind":"nullable","value":{"kind":"list","element":"choice"}}` | `{"kind":"nullable","value":{"kind":"list","element":"choice"}}` |
| `{"kind":"nullable","value":{"kind":"list","element":"record"}}` | `{"kind":"nullable","value":{"kind":"list","element":"record"}}` |

执行声明：纯计算；可预览；读取 records。

### 读取战斗字段

接口：`battle.field@5`。

作者目录：原子语句。

读取战斗上下文的封闭只读字段；集合返回不可变快照。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | tileEffects / turnNumber / currentPlayerId / actions / extensions |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `tileEffects` | `{"kind":"list","element":"record"}` |
| `turnNumber` | `number` |
| `currentPlayerId` | `player` |
| `actions` | `{"kind":"list","element":"record"}` |
| `extensions` | `{"kind":"nullable","value":"record"}` |

执行声明：纯计算；读取 turn、tile-effects、players、actions、extensions。

### 持有者

接口：`ref.holder@1`。

作者目录：原子语句。

读取当前技能或规则的持有棋子引用。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子引用 | `piece`（可空） | 是 |  |

执行声明：纯计算；可预览；读取 context。

### 来源棋子

接口：`ref.source@1`。

作者目录：原子语句。

读取当前事件或效果的来源棋子引用。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子引用 | `piece`（可空） | 是 |  |

执行声明：纯计算；可预览；读取 context。

### 当前目标

接口：`ref.target@1`。

作者目录：原子语句。

读取当前事件或选择流程的目标棋子引用。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子引用 | `piece`（可空） | 是 |  |

执行声明：纯计算；可预览；读取 context。

### 所属玩家

接口：`ref.player@1`。

作者目录：原子语句。

读取持有者或当前内容所属玩家的不可变玩家 ID。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 玩家引用 | `player`（可空） | 是 |  |

执行声明：纯计算；可预览；读取 context。

### 事件玩家

接口：`ref.event-player@1`。

作者目录：原子语句。

读取触发当前事件的玩家引用。

允许入口：rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 玩家引用 | `player`（可空） | 是 |  |

执行声明：纯计算；可预览；读取 event。

## 流程控制

### 构造行动结果

接口：`result.action@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |
| `message` | message | `string` | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | result | `record` | 是 |  |

执行声明：纯计算；可预览。

### 执行代码块

接口：`code-block.invoke@1`。

作者目录：原子语句。

绑定显式参数并执行一个结构化、数据定义的代码块。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `block` | 代码块 | `record` | 是 |  |
| `args` | 参数 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `blockType` | 代码块类型 | `string` | 是 | 默认 record |
| `argsType` | 参数类型 | `string` | 是 | 默认 record |
| `resultType` | 返回类型 | `string` | 是 | 默认 record |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | 返回值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"block":{"parameter":"blockType"},"args":{"parameter":"argsType"}},"outputs":{"result":{"parameter":"resultType"}}}`。

执行声明：写入 execution-context；可能等待玩家选择。

### 新建变量

接口：`local.declare@2`。

作者目录：原子语句。

新建指定类型的局部变量；表达式直接引用变量名，赋值后读取最新值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `initial` | 初始值 | `record` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 值类型 | `string` | 是 | 默认 number |
| `name` | 变量名 | `string` | 是 | 默认 value |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `handle` | 变量 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"initial":{"parameter":"valueType"}}}`。

执行声明：写入 execution-context。

### 声明本次执行局部变量

接口：`local.declare@1`。

作者目录：原子语句。

创建只属于当前图执行的类型化局部变量；句柄不能伪造、保存或跨执行复用。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `initial` | initial | `record` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `handle` | handle | `record` | 是 |  |
| `success` | success | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"initial":{"parameter":"valueType"}}}`。

执行声明：写入 execution-context。

### 读取本次执行局部变量

接口：`local.read@1`。

作者目录：原子语句。

按声明时的封闭类型读取当前执行局部变量，并返回实际读取成功标记。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `handle` | handle | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `record` | 是 |  |
| `success` | success | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；读取 execution-context。

### 写入本次执行局部变量

接口：`local.write@1`。

作者目录：原子语句。

按声明时的封闭类型更新当前执行局部变量；验证失败时保留旧值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `handle` | handle | `record` | 是 |  |
| `value` | value | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 值类型 | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：写入 execution-context。

### 记录规则触发消息

接口：`log.trigger-effect@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | player | `player` | 是 |  |
| `message` | message | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 actions。

### 追加结构化日志

接口：`followup.action.append@2`。

作者目录：原子语句。

在一句作者语句中填写日志类型与已声明记录载荷；宿主严格校验字段和类型，只能追加，不会覆盖权威伤害动作。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `type` | 日志类型 | `string` | 是 |  |
| `playerId` | 归属玩家 | `player` | 是 |  |
| `turn` | 回合 | `number` | 是 |  |
| `payload` | 类型化载荷 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `payloadSchema` | 载荷记录类型 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

记录类型由参数选择的结构声明确定：`{"inputs":{"payload":{"parameter":"payloadSchema"}}}`。

执行声明：写入 actions。

### 读取效果结果字段

接口：`result.field@1`。

作者目录：原子语句。

读取权威效果结果的封闭字段；结果数值缺失沿用旧结果读取的零值语义。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | success / queued / queueCount / blocked / isKilled / damage / heal / totalDamage / totalHeal / results / targetId |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `success` | `boolean` |
| `queued` | `boolean` |
| `queueCount` | `number` |
| `blocked` | `boolean` |
| `isKilled` | `boolean` |
| `damage` | `number` |
| `heal` | `number` |
| `totalDamage` | `number` |
| `totalHeal` | `number` |
| `results` | `{"kind":"list","element":"record"}` |
| `targetId` | `{"kind":"nullable","value":"piece"}` |

执行声明：纯计算；读取 damage、heal、event。

## 计算与容器

### 包含

接口：`collection.contains@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 容器 | `{"kind":"list","element":"number"}` | 是 |  |
| `value` | 查找值 | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 元素类型 | `string` | 是 |  |
| `itemsType` | 容器类型 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"},"items":{"parameter":"itemsType"}}}`。

执行声明：纯计算；可预览。

### 首项序号

接口：`collection.index-of@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 容器 | `{"kind":"list","element":"number"}` | 是 |  |
| `value` | 查找值 | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 元素类型 | `string` | 是 |  |
| `itemsType` | 容器类型 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"},"items":{"parameter":"itemsType"}}}`。

执行声明：纯计算；可预览。

### 截取元组

接口：`collection.slice@1`。

作者目录：原子语句。

从序号1开始，包含起始项，数量可省略；返回新元组。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 容器 | `{"kind":"list","element":"any"}` | 是 |  |
| `start` | 起始序号 | `number` | 是 |  |
| `count` | 数量 | `number` | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"any"}` | 是 |  |

输出类型推导：`{"items":{"input":"items","projection":"same"}}`。

执行声明：纯计算；可预览。

### 包含键

接口：`map.has-key@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `record` | 是 |  |
| `key` | 键 | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 键列表

接口：`map.keys@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `record` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"string"}` | 是 |  |

执行声明：纯计算；可预览。

### 值列表

接口：`map.values@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 值元组类型 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"any"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"outputs":{"items":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 创建映射

接口：`map.create@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `keys` | 键元组 | `{"kind":"list","element":"string"}` | 是 |  |
| `values` | 值元组 | `{"kind":"list","element":"number"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"number"} |
| `keyType` | 推导类型 | `string` | 是 | 默认 string |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `keysType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |
| `valuesType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"keys":{"parameter":"keysType"},"values":{"parameter":"valuesType"}},"outputs":{"value":{"parameter":"containerType"}}}`。

执行声明：纯计算。

### 包含键

接口：`map.has-key@2`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |
| `key` | 键 | `string` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"number"} |
| `keyType` | 推导类型 | `string` | 是 | 默认 string |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `keysType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |
| `valuesType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"map":{"parameter":"containerType"},"key":{"parameter":"keyType"}}}`。

执行声明：纯计算。

### 读取映射值

接口：`map.get@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |
| `key` | 键 | `string` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"number"} |
| `keyType` | 推导类型 | `string` | 是 | 默认 string |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `keysType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |
| `valuesType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `number` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"map":{"parameter":"containerType"},"key":{"parameter":"keyType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算。

### 更新映射

接口：`map.set@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |
| `key` | 键 | `string` | 是 |  |
| `value` | 值 | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"number"} |
| `keyType` | 推导类型 | `string` | 是 | 默认 string |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `keysType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |
| `valuesType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"map":{"parameter":"containerType"},"key":{"parameter":"keyType"},"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"containerType"}}}`。

执行声明：纯计算。

### 移除映射项

接口：`map.delete@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |
| `key` | 键 | `string` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"number"} |
| `keyType` | 推导类型 | `string` | 是 | 默认 string |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `keysType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |
| `valuesType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"map":{"parameter":"containerType"},"key":{"parameter":"keyType"}},"outputs":{"value":{"parameter":"containerType"}}}`。

执行声明：纯计算。

### 键元组

接口：`map.keys@2`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"number"} |
| `keyType` | 推导类型 | `string` | 是 | 默认 string |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `keysType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |
| `valuesType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"list","element":"string"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"map":{"parameter":"containerType"}},"outputs":{"value":{"parameter":"keysType"}}}`。

执行声明：纯计算。

### 值元组

接口：`map.values@2`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"number"} |
| `keyType` | 推导类型 | `string` | 是 | 默认 string |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `keysType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |
| `valuesType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"list","element":"number"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"map":{"parameter":"containerType"}},"outputs":{"value":{"parameter":"valuesType"}}}`。

执行声明：纯计算。

### 映射数量

接口：`map.count@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `map` | 映射 | `{"kind":"map","key":"string","value":"number"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"map","key":"string","value":"number"} |
| `keyType` | 推导类型 | `string` | 是 | 默认 string |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `keysType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |
| `valuesType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `number` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"map":{"parameter":"containerType"}}}`。

执行声明：纯计算。

### 创建集合

接口：`set.create@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 元组 | `{"kind":"list","element":"number"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"set","element":"number"} |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `itemsType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"set","element":"number"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"items":{"parameter":"itemsType"}},"outputs":{"value":{"parameter":"containerType"}}}`。

执行声明：纯计算。

### 集合包含

接口：`set.contains@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `set` | 集合 | `{"kind":"set","element":"number"}` | 是 |  |
| `value` | 值 | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"set","element":"number"} |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `itemsType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"set":{"parameter":"containerType"},"value":{"parameter":"valueType"}}}`。

执行声明：纯计算。

### 加入集合

接口：`set.add@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `set` | 集合 | `{"kind":"set","element":"number"}` | 是 |  |
| `value` | 值 | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"set","element":"number"} |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `itemsType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"set","element":"number"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"set":{"parameter":"containerType"},"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"containerType"}}}`。

执行声明：纯计算。

### 移出集合

接口：`set.delete@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `set` | 集合 | `{"kind":"set","element":"number"}` | 是 |  |
| `value` | 值 | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"set","element":"number"} |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `itemsType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"set","element":"number"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"set":{"parameter":"containerType"},"value":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"containerType"}}}`。

执行声明：纯计算。

### 集合转元组

接口：`set.items@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `set` | 集合 | `{"kind":"set","element":"number"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"set","element":"number"} |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `itemsType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `{"kind":"list","element":"number"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"set":{"parameter":"containerType"}},"outputs":{"value":{"parameter":"itemsType"}}}`。

执行声明：纯计算。

### 集合数量

接口：`set.count@1`。

作者目录：原子语句。

返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `set` | 集合 | `{"kind":"set","element":"number"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `containerType` | 推导类型 | `string` | 是 | 默认 {"kind":"set","element":"number"} |
| `valueType` | 推导类型 | `string` | 是 | 默认 number |
| `itemsType` | 推导类型 | `string` | 是 | 默认 {"kind":"list","element":"number"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `number` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"set":{"parameter":"containerType"}}}`。

执行声明：纯计算。

### 按权威随机源洗牌

接口：`collection.shuffle@1`。

作者目录：原子语句。

复制输入集合并执行 Fisher-Yates 洗牌；每个交换位置恰好消耗一次权威随机抽样。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"any"}` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"any"}` | 是 |  |

输出类型推导：`{"items":{"input":"items","projection":"same"}}`。

执行声明：纯计算；读取 random；使用种子随机流。

### 反转元组顺序

接口：`collection.reverse@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 元组 | `{"kind":"list","element":"any"}` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 倒序结果 | `{"kind":"list","element":"any"}` | 是 |  |

输出类型推导：`{"items":{"input":"items","projection":"same"}}`。

执行声明：纯计算；可预览。

### 拼接元组

接口：`collection.concat@1`。

作者目录：原子语句。

把两个同类型元组按顺序拼接为新元组，保留重复项，不改变原值。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | 前半部分 | `{"kind":"list","element":"any"}` | 是 |  |
| `right` | 后半部分 | `{"kind":"list","element":"any"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 元组类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 拼接结果 | `{"kind":"list","element":"any"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"left":{"parameter":"valueType"},"right":{"parameter":"valueType"}},"outputs":{"items":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 随机选取集合项

接口：`collection.random@1`。

作者目录：原子语句。

使用对局种子从集合选择一项；空集合返回空值且不消耗随机数。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 集合 | `{"kind":"list","element":"any"}` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 选中的项 | `any`（可空） | 是 |  |

输出类型推导：`{"value":{"input":"items","projection":"element"}}`。

执行声明：纯计算；读取 random；使用种子随机流。

### 排序集合

接口：`collection.sort@2`。

作者目录：原子语句。

按逐项排序依据返回新集合；支持数值、文本编码顺序和本地化文本顺序，同值保持原顺序。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 集合 | `{"kind":"list","element":"any"}` | 是 |  |
| `keys` | 每项的排序依据 | `{"kind":"list","element":"any"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `order` | 顺序 | `string` | 是 | 默认 ascending；ascending / descending |
| `comparison` | 比较方式 | `string` | 是 | 默认 numeric；numeric / text / locale |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 排序结果 | `{"kind":"list","element":"any"}` | 是 |  |

输出类型推导：`{"items":{"input":"items","projection":"same"}}`。

执行声明：纯计算；可预览。

### 获取集合长度

接口：`collection.length@1`。

作者目录：原子语句。

返回集合元素数量，空集合返回0，不改变输入集合。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 集合 | `{"kind":"list","element":"any"}` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 数量 | `number` | 是 |  |

执行声明：纯计算；可预览。

### 获取集合项

接口：`collection.at@1`。

作者目录：原子语句。

位置1为第一项；空集合或越界返回无效值，只跳过依赖该值的语句。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 集合 | `{"kind":"list","element":"any"}` | 是 |  |
| `position` | 位置（从1开始） | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 集合项 | `any` | 是 |  |

输出类型推导：`{"value":{"input":"items","projection":"element"}}`。

执行声明：纯计算；可预览。

### 排序集合

接口：`collection.sort@1`。

作者目录：原子语句。

依据逐项对应的数值排序键返回新集合，同值保留原顺序。排序键可由集合映射读取属性生成。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 集合 | `{"kind":"list","element":"any"}` | 是 |  |
| `keys` | 每项的排序依据 | `{"kind":"list","element":"number"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `order` | 顺序 | `string` | 是 | 默认 ascending；ascending / descending |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 排序结果 | `{"kind":"list","element":"any"}` | 是 |  |

输出类型推导：`{"items":{"input":"items","projection":"same"}}`。

执行声明：纯计算；可预览。

### 取较小值

接口：`math.min@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 取较大值

接口：`math.max@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 连接文本集合

接口：`text.join-list@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"string"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `separator` | separator | `string` | 是 | 默认  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | text | `string` | 是 |  |

执行声明：纯计算。

### 空值回退

接口：`value.coalesce@1`。

作者目录：原子语句。

在可空值和同类型默认值之间选择；仅空值触发回退，零和空文本保持原值。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 可空值 | `record`（可空） | 是 |  |
| `defaultValue` | 默认值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 值类型 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 结果 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType","nullable":true},"defaultValue":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 比较值

接口：`compare.values@1`。

作者目录：原子语句。

按封闭值类型对两个值执行严格相等或不相等比较；不允许跨类型比较。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | 左值 | `record` | 是 |  |
| `right` | 右值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 值类型 | `string` | 是 | 默认 string |
| `operator` | 运算符 | `string` | 是 | 默认 ==；== / != |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 比较结果 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"left":{"parameter":"valueType"},"right":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 文本前缀匹配

接口：`text.starts-with@1`。

作者目录：原子语句。

判断可空文本是否以给定文本开头；空值返回 false。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | 文本 | `string`（可空） | 是 |  |
| `value` | 前缀 | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 匹配结果 | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 文本包含匹配

接口：`text.contains@1`。

作者目录：原子语句。

判断可空文本是否包含给定文本；空值返回 false。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | 文本 | `string`（可空） | 是 |  |
| `value` | 查找文本 | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 匹配结果 | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 集合去重

接口：`collection.distinct@1`。

作者目录：原子语句。

按稳定的 SameValueZero 身份保留集合首次出现的值。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | 集合 | `{"kind":"list","element":"record"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 集合类型 | `string` | 是 | 默认 {"kind":"list","element":"string"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 去重集合 | `{"kind":"list","element":"record"}` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"items":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 去掉文本首尾空白

接口：`text.trim@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | text | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | text | `string` | 是 |  |

执行声明：纯计算；可预览。

### 文本转小写

接口：`text.lowercase@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | text | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | text | `string` | 是 |  |

执行声明：纯计算；可预览。

### 转为文本

接口：`text.from-value@1`。

作者目录：原子语句。

将标量或实例标识转为文本；读取身份不会要求该实例仍然在场。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | valueType | `string` | 是 | 默认 string；string / number / boolean / piece / player / {"kind":"nullable","value":"string"} / {"kind":"nullable","value":"number"} / {"kind":"nullable","value":"boolean"} / {"kind":"nullable","value":"piece"} / {"kind":"nullable","value":"player"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | text | `string` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 按条件选择值

接口：`logic.select@2`。

作者目录：原子语句。

在两个同类型值之间按布尔条件选择一个值；值类型由封闭类型描述参数确定。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `condition` | 条件 | `boolean` | 是 |  |
| `whenTrue` | 条件成立值 | `record` | 是 |  |
| `whenFalse` | 条件不成立值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 值类型 | `string` | 是 | 默认 string |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | 选择值 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"whenTrue":{"parameter":"valueType"},"whenFalse":{"parameter":"valueType"}},"outputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 转换为数值

接口：`value.to-number@1`。

作者目录：原子语句。

使用 JavaScript Number 语义转换可空标量。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number`（可空） | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 转换为布尔值

接口：`value.to-boolean@1`。

作者目录：原子语句。

将封闭类型的值转换为布尔值；空值、零、空文本为假，记录和元组为真。类型由通用类型编辑器确定。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `record`（可空） | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | valueType | `string` | 是 | 默认 number |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType","nullable":true}}}`。

执行声明：纯计算；可预览。

### 构造单项集合

接口：`collection.singleton@1`。

作者目录：原子语句。

把一个值放入新的单项元组，元素类型由该值决定。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `valueType` | 元素类型 | `string` | 是 | 默认 piece |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | items | `{"kind":"list","element":"any"}` | 是 |  |

输出类型推导：`{"items":{"input":"value","projection":"singleton"}}`。

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：纯计算；可预览。

### 截取文本

接口：`text.slice@1`。

作者目录：原子语句。

按起点和可选终点截取文本；不执行额外规范化。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | text | `string` | 是 |  |
| `start` | start | `number` | 是 |  |
| `end` | end | `number` | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `string` | 是 |  |

执行声明：纯计算；可预览。

### 加法

接口：`math.add@1`。

作者目录：原子语句。

按固定顺序执行 + 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 减法

接口：`math.subtract@1`。

作者目录：原子语句。

按固定顺序执行 - 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 乘法

接口：`math.multiply@1`。

作者目录：原子语句。

按固定顺序执行 * 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 除法

接口：`math.divide@1`。

作者目录：原子语句。

按固定顺序执行 / 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 取余

接口：`math.modulo@1`。

作者目录：原子语句。

按固定顺序执行 % 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 乘方

接口：`math.power@1`。

作者目录：原子语句。

按固定顺序执行 ** 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 小于

接口：`compare.less-than@1`。

作者目录：原子语句。

按固定顺序执行 < 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 小于等于

接口：`compare.less-or-equal@1`。

作者目录：原子语句。

按固定顺序执行 <= 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 大于

接口：`compare.greater-than@1`。

作者目录：原子语句。

按固定顺序执行 > 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 大于等于

接口：`compare.greater-or-equal@1`。

作者目录：原子语句。

按固定顺序执行 >= 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `number` | 是 |  |
| `right` | right | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 并且

接口：`logic.and@1`。

作者目录：原子语句。

按固定顺序执行 && 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `boolean` | 是 |  |
| `right` | right | `boolean` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 或者

接口：`logic.or@1`。

作者目录：原子语句。

按固定顺序执行 \|\| 运算。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `boolean` | 是 |  |
| `right` | right | `boolean` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 向下取整

接口：`math.floor@1`。

作者目录：原子语句。

向负无穷取整。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 绝对值

接口：`math.abs@1`。

作者目录：原子语句。

读取数值绝对值。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `number` | 是 |  |

执行声明：纯计算；可预览。

### 非

接口：`logic.not@1`。

作者目录：原子语句。

对布尔值取反。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean` | 是 |  |

执行声明：纯计算；可预览。

### 拼接文本

接口：`text.concat@1`。

作者目录：原子语句。

按输入顺序拼接两个文本值。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `left` | left | `string` | 是 |  |
| `right` | right | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | text | `string` | 是 |  |

执行声明：纯计算；可预览。

## 棋盘与召唤

### 相对地格范围

接口：`spatial.relative-cells@1`。

作者目录：原子语句。

将每个相对坐标加到中心坐标，按输入顺序返回地图内地格；地图外坐标不产生地格。

允许入口：skill、card、rule、triggerSkill、pending、preview。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `center` | 中心地格 | `cell` | 是 |  |
| `offsets` | 相对坐标 | `{"kind":"list","element":"cell"}` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cells` | cells | `{"kind":"list","element":"cell"}` | 是 |  |

执行声明：纯计算；可预览；读取 map。

### 召唤

接口：`author.effect.summon@1`。

作者目录：原子语句。

模板或原实例与落点逐项对应；单个模板应用于所有落点。显示配置在召唤事件前一次完成，省略字段保持原显示。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | 来源 | `piece` | 是 |  |
| `template` | 棋子 | `record` | 是 |  |
| `destination` | 落点 | `cell` | 是 |  |
| `display` | 显示选项 | `record` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `mode` | 召唤方式 | `string` | 是 | 默认 new-instance；new-instance / return-instance |
| `sourceType` | 来源类型 | `string` | 是 | 默认 piece；piece / record |
| `templateType` | 棋子类型 | `string` | 是 | 默认 {"kind":"record","schema":"author.piece-template@1"} |
| `destinationType` | 落点类型 | `string` | 是 | 默认 cell |
| `displayType` | 显示类型 | `string` | 是 | 默认 {"kind":"record","schema":"author.piece-display@1"} |
| `currentHp` | 回场生命值 | `number` | 否 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | 召唤结果 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"source":{"parameter":"sourceType"},"template":{"parameter":"templateType"},"destination":{"parameter":"destinationType"},"display":{"parameter":"displayType"}}}`。

执行声明：写入 summon；事件 beforePieceSummoned、afterPieceSummoned。

### 召唤

接口：`author.effect.summon@2`。

作者目录：原子语句。

统一召唤入口：可新建棋子、让原实例回场，或使用当前内容声明按已验证能力排队召唤。声明模式不填写模板和显示选项。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | 来源 | `piece` | 是 |  |
| `template` | 棋子 | `record` | 否 |  |
| `destination` | 落点 | `cell` | 是 |  |
| `display` | 显示选项 | `record` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `mode` | 召唤方式 | `string` | 是 | 默认 new-instance；new-instance / return-instance / declaration |
| `sourceType` | 来源类型 | `string` | 是 | 默认 piece；piece / record |
| `templateType` | 棋子类型 | `string` | 是 | 默认 {"kind":"record","schema":"author.piece-template@1"} |
| `destinationType` | 落点类型 | `string` | 是 | 默认 cell |
| `displayType` | 显示类型 | `string` | 是 | 默认 {"kind":"record","schema":"author.piece-display@1"} |
| `currentHp` | 回场生命值 | `number` | 否 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | 召唤结果 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"source":{"parameter":"sourceType"},"template":{"parameter":"templateType"},"destination":{"parameter":"destinationType"},"display":{"parameter":"displayType"}}}`。

执行声明：写入 summon；事件 beforePieceSummoned、afterPieceSummoned。

### 设置棋子显示

接口：`author.piece.display@1`。

作者目录：原子语句。

按同名字段更新显示快照；不改变真实规则或数值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | 棋子 | `piece` | 是 |  |
| `display` | 显示选项 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `displayType` | 显示类型 | `string` | 是 | 默认 {"kind":"record","schema":"author.piece-display@1"} |
| `audience` | 可见对象 | `string` | 是 | 默认 public；public / owner / allies / enemies / spectators |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `reference` | 显示引用 | `string` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"display":{"parameter":"displayType"}}}`。

执行声明：写入 presentation。

### 提交地格效果记录批次

接口：`tile.batch-records@1`。

作者目录：原子语句。

把图中已经构造并校验的地格效果记录交给权威批次提交器。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `records` | records | `{"kind":"list","element":"record"}` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 tile-effects；事件 tileEffectAdded。

### 提交地格效果记录批次

接口：`tile.batch-records@2`。

作者目录：原子语句。

提交已构造的地格效果记录，并保留指定的统一表现批次。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `records` | records | `{"kind":"list","element":"record"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `presentationBatch` | presentationBatch | `string` | 是 | 默认 direct；direct / queue |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 tile-effects；事件 tileEffectAdded。

### 替换地格效果记录

接口：`tile.replace-effects@1`。

作者目录：原子语句。

以整数组提交已经由图筛选出的地格效果；宿主负责校验、复制和移除表现事件。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `effects` | effects | `{"kind":"list","element":"record"}` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 tile-effects；事件 tileEffectRemoved。

### 读取弹道事件棋子标识

接口：`projectile.event-piece-id@1`。

作者目录：原子语句。

从标准弹道事件或移动追踪 encounter 读取棋子实例标识；不验证或制造棋子对象。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `event` | event | `event` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

执行声明：纯计算；读取 pieces。

### 读取可穿越弹道事件

接口：`projectile.trace-to-cell@1`。

作者目录：原子语句。

调用权威移动路径观察器的全穿越模式；图只负责投影其中的棋子事件。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `piece` | 是 |  |
| `target` | target | `cell` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `maxDistance` | maxDistance | `number` | 是 | 默认 6；最小 0；最大 128 |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `events` | events | `{"kind":"list","element":"event"}` | 是 |  |
| `dx` | dx | `number` | 是 |  |
| `dy` | dy | `number` | 是 |  |
| `valid` | valid | `boolean` | 是 |  |
| `sameCell` | sameCell | `boolean` | 是 |  |
| `distance` | distance | `number` | 是 |  |

执行声明：纯计算；读取 pieces、players、position。

### 读取地格射线事件

接口：`projectile.trace-from-cell@1`。

作者目录：原子语句。

调用权威弹道观察器读取从地格沿单位方向的事件序列；图只负责后续筛选和截断。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `origin` | origin | `cell` | 是 |  |
| `direction` | direction | `cell` | 是 |  |
| `maxDistance` | maxDistance | `number` | 是 |  |
| `excludePiece` | excludePiece | `piece`（可空） | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `events` | events | `{"kind":"list","element":"event"}` | 是 |  |

执行声明：纯计算；读取 pieces、position。

### 构造地格记录

接口：`spatial.cell@1`。

作者目录：原子语句。

由两个有限坐标构造不透明地格值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `x` | x | `number` | 是 |  |
| `y` | y | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cell` | cell | `cell` | 是 |  |

执行声明：纯计算。

### 读取地格坐标

接口：`spatial.cell-coordinates@1`。

作者目录：原子语句。

读取已验证地格的两个坐标事实。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cell` | cell | `cell` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `x` | x | `number` | 是 |  |
| `y` | y | `number` | 是 |  |

执行声明：纯计算。

### 合法落点

接口：`spatial.cell-landing-legal@1`。

作者目录：原子语句。

按既有落点约束重新验证地格、可行走地形和存活占位；可列出同次位移中将离开的棋子。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cell` | cell | `cell` | 是 |  |
| `ignoreA` | ignoreA | `piece`（可空） | 否 |  |
| `ignoreB` | ignoreB | `piece`（可空） | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `terrainPolicy` | terrainPolicy | `string` | 是 | floor-or-cover / walkable |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `legal` | legal | `boolean` | 是 |  |

执行声明：纯计算；读取 position、pieces。

### 读取棋子位置

接口：`spatial.piece-position@1`。

作者目录：原子语句。

读取经权威棋子查询验证后的当前位置快照；不暴露可写棋子对象。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cell` | cell | `cell` | 是 |  |

执行声明：纯计算；读取 pieces、position。

### 地格曼哈顿距离

接口：`spatial.cell-distance@1`。

作者目录：原子语句。

读取两个已验证地格之间的曼哈顿距离。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `from` | from | `cell` | 是 |  |
| `to` | to | `cell` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `distance` | distance | `number` | 是 |  |

执行声明：纯计算；读取 position。

### 消灭棋子

接口：`lifecycle.destroy@1`。

作者目录：原子语句。

直接消灭目标并进行正式死亡结算；不造成伤害，不经过护盾或伤害减免。目标已离场时跳过。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | 目标 | `piece` | 是 |  |
| `source` | 来源 | `piece` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `targetType` | 目标类型 | `string` | 是 | 默认 piece；piece / {"kind":"list","element":"piece"} |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 是否消灭 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"target":{"parameter":"targetType"}}}`。

执行声明：写入 pieces、health、graveyard；事件 onPieceDied。

### 批量位移

接口：`effect.displace-many@1`。

作者目录：原子语句。

把一组棋子按固定顺序提交给统一位移入口。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `pieces` | pieces | `{"kind":"list","element":"piece"}` | 是 |  |
| `destinations` | destinations | `{"kind":"list","element":"cell"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `kind` | kind | `string` | 是 | 默认 teleport；teleport / dash |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 position、events；事件 beforePiecePositionChange、afterPiecePositionChange、afterPiecePathContact。

### 记录正向弹道

接口：`projectile.trace@1`。

作者目录：原子语句。

沿正交方向调用现有弹道观察入口；事件中的棋子、地格和阻挡事实由后续模块读取。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `piece` | 是 |  |
| `target` | target | `cell` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `maxDistance` | maxDistance | `number` | 是 | 默认 99；最小 0；最大 128 |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `events` | events | `{"kind":"list","element":"event"}` | 是 |  |
| `dx` | dx | `number` | 是 |  |
| `dy` | dy | `number` | 是 |  |
| `valid` | valid | `boolean` | 是 |  |
| `sameCell` | sameCell | `boolean` | 是 |  |
| `distance` | distance | `number` | 是 |  |

执行声明：纯计算；读取 pieces、position。

### 破坏地格墙体

接口：`effect.destroy-walls@1`。

作者目录：原子语句。

经现有 flow.effects.destroyWalls 入口破坏给定地格中的墙和可选掩体，并返回实际变化数量。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cells` | cells | `{"kind":"list","element":"cell"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `includeCover` | includeCover | `boolean` | 是 | 默认 true |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | result | `record` | 是 |  |
| `changed` | changed | `number` | 是 |  |

执行声明：写入 terrain、events；事件 terrainChanged。

### 读取正交位移路径事实

接口：`movement.trace@1`。

作者目录：原子语句。

通过统一移动路径观察器读取逐格落点、阻挡、首个敌人和可落脚地格；只返回不透明集合及标量事实，位移提交仍由 effect.displace-policy 完成。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `piece` | 是 |  |
| `direction` | direction | `cell` | 是 |  |
| `maxDistance` | maxDistance | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `passAllies` | passAllies | `boolean` | 是 | 默认 true |
| `passEnemies` | passEnemies | `boolean` | 是 | 默认 true |
| `terrain` | terrain | `string` | 是 | 默认 walkable；walkable / projectile / any |
| `blockedTerrainTypes` | blockedTerrainTypes | `{"kind":"list","element":"string"}` | 是 | 默认 [] |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cells` | cells | `{"kind":"list","element":"cell"}` | 是 |  |
| `encounters` | encounters | `{"kind":"list","element":"record"}` | 是 |  |
| `lastLandable` | lastLandable | `cell`（可空） | 是 |  |
| `hasNewLandable` | hasNewLandable | `boolean` | 是 |  |
| `blocked` | blocked | `boolean` | 是 |  |
| `reachedTarget` | reachedTarget | `boolean` | 是 |  |
| `firstEnemy` | firstEnemy | `piece`（可空） | 是 |  |
| `enemyPieces` | enemyPieces | `{"kind":"list","element":"piece"}` | 是 |  |
| `beforeFirstEnemy` | beforeFirstEnemy | `cell` | 是 |  |
| `firstEnemyDistance` | firstEnemyDistance | `number` | 是 |  |

执行声明：纯计算；读取 pieces、players、position、map。

### 按实际位移路径查询敌人

接口：`movement.actual-path-enemies@1`。

作者目录：原子语句。

从权威位移结果的实际路径逐格读取敌方棋子并按首次接触去重；目标集合只读，后续伤害仍由图逐项提交。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `record` | 是 |  |
| `movement` | movement | `record` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `pieces` | pieces | `{"kind":"list","element":"piece"}` | 是 |  |

执行声明：纯计算；读取 execution-context、pieces、players、position。

### 按路径策略提交位移

接口：`effect.displace-policy@1`。

作者目录：原子语句。

调用统一 flow.effects.displace/flow.effects.move 路径提交器，并开放有限可穿越和地形策略；不直接写入坐标。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |
| `destination` | 目标地格 | `cell` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `kind` | 位移方式 | `string` | 是 | 传送（teleport）、冲刺（dash）或拉拽（pull）；图中保留稳定英文标识。；默认 dash；dash / teleport / pull |
| `passAllies` | 可穿越友方 | `boolean` | 是 | 默认 true |
| `passEnemies` | 可穿越敌方 | `boolean` | 是 | 默认 true |
| `terrain` | 地形策略 | `string` | 是 | 可通行（walkable）、弹道（projectile）或任意（any）；图中保留稳定英文标识。；默认 any；walkable / projectile / any |
| `blockedTerrainTypes` | 屏蔽地形类型 | `{"kind":"list","element":"string"}` | 是 | 填写需要阻挡路径的稳定地形标识列表。；默认 [] |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | result | `record` | 是 |  |
| `success` | success | `boolean` | 是 |  |
| `changed` | changed | `boolean` | 是 |  |
| `steps` | steps | `number` | 是 |  |

执行声明：写入 position、events；事件 beforePiecePositionChange、afterPiecePositionChange、afterPiecePathContact。

### 原子交换棋子位置

接口：`effect.swap-pieces@1`。

作者目录：原子语句。

在提交前读取双方当前位置快照，再以一次统一 swap 位移批次交换位置；触发器、阻挡和回滚全部由权威位移生命周期处理。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `first` | 第一枚棋子 | `piece` | 是 |  |
| `second` | 第二枚棋子 | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | result | `record` | 是 |  |
| `success` | success | `boolean` | 是 |  |
| `changed` | changed | `boolean` | 是 |  |

执行声明：写入 position、events；事件 beforePiecePositionChange、afterPiecePositionChange、afterPiecePathContact。

### 读取射线首个阻挡

接口：`movement.first-trace-obstruction@1`。

作者目录：原子语句。

按事件顺序读取射线上的首个地形或棋子阻挡，并在命中棋子时返回敌我事实；不修改棋盘。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `piece` | 是 |  |
| `events` | events | `{"kind":"list","element":"event"}` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece`（可空） | 是 |  |
| `enemy` | enemy | `boolean` | 是 |  |
| `ally` | ally | `boolean` | 是 |  |
| `distance` | distance | `number` | 是 |  |
| `cell` | cell | `cell`（可空） | 是 |  |
| `present` | present | `boolean` | 是 |  |
| `terrainBlocked` | terrainBlocked | `boolean` | 是 |  |

执行声明：纯计算；读取 event、pieces、players、position。

### 使目标敌方棋子出局

接口：`lifecycle.remove-enemy@1`。

作者目录：原子语句。

通过主动技能生命周期入口使当前仍存在的敌方目标出局；宿主校验当前敌方关系与技能入口，不直接编辑棋子集合。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `piece`（可空） | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 pieces、events。

### 读取正交射线地格

接口：`spatial.ray-cells@1`。

作者目录：原子语句。

从来源棋子沿已验证的正交方向读取存在于地图中的地格；不破坏地形、不查询目标。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | source | `piece` | 是 |  |
| `direction` | direction | `cell` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `maxDistance` | maxDistance | `number` | 是 | 默认 6 |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cells` | cells | `{"kind":"list","element":"cell"}` | 是 |  |

执行声明：纯计算；读取 pieces、position、map。

### 查询普通移动落点

接口：`query.normal-move-cells@1`。

作者目录：原子语句。

按宿主普通移动规则读取合法落点；移动范围、地形、阻挡和落脚校验均由权威宿主处理。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cells` | 合法落点 | `{"kind":"list","element":"cell"}` | 是 |  |

执行声明：纯计算；读取 pieces、position、map。

### 执行免费移动

接口：`effect.free-move@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |
| `destination` | destination | `cell` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | result | `record` | 是 |  |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 position、events；事件 beforePiecePositionChange、afterPiecePositionChange。

### 生成正交相邻地格

接口：`spatial.cardinal-cells@1`。

作者目录：原子语句。

按上、右、下、左的冻结顺序生成目标棋子的四个正交相邻地格；合法性由作者图逐格判断。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `target` | target | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cells` | cells | `{"kind":"list","element":"cell"}` | 是 |  |

执行声明：纯计算；读取 position。

### 添加来源地格效果

接口：`tile.add-source-effect@1`。

作者目录：原子语句。

向现有 tileEffects 列表追加固定字段的来源地格效果。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | id | `string` | 是 |  |
| `sourceId` | sourceId | `string` | 是 |  |
| `owner` | owner | `player` | 是 |  |
| `cell` | cell | `cell` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `tileType` | tileType | `string` | 是 | lethal-toxin |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 tile-effects。

### 清理来源地格效果

接口：`tile.remove-source-effects@1`。

作者目录：原子语句。

按固定效果类型和来源标识清理现有 tileEffects 列表。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `sourceId` | sourceId | `string`（可空） | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `tileType` | tileType | `string` | 是 | lethal-toxin |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 tile-effects。

### 统一单棋子位移

接口：`effect.displace-one@1`。

作者目录：原子语句。

通过现有 displace 提交器提交一名棋子的位移。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |
| `destination` | 目标地格 | `cell` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `kind` | 位移方式 | `string` | 是 | 传送（teleport）、冲刺（dash）、步行（walk）、推（push）、拉拽（pull）或交换（swap）；图中保留稳定英文标识。；默认 teleport；teleport / dash / walk / push / pull / swap |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | result | `record` | 是 |  |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 position、events；事件 beforePiecePositionChange、afterPiecePositionChange、afterPiecePathContact。

### 读取棋盘全部地格

接口：`spatial.map-cells@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cells` | cells | `{"kind":"list","element":"cell"}` | 是 |  |

执行声明：纯计算；读取 map。

### 生成正交相邻地格

接口：`spatial.adjacent-cells-ordered@1`。

作者目录：原子语句。

按右、左、下、上的冻结顺序生成一个地格的四个正交相邻地格；合法性由作者图逐格判断。

允许入口：skill、rule、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `center` | center | `cell`（可空） | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cells` | cells | `{"kind":"list","element":"cell"}` | 是 |  |

执行声明：纯计算；读取 position。

### 安全移除当前棋子

接口：`piece.detach-active@2`。

作者目录：原子语句。

按作者生命周期从当前棋盘移除棋子，并由宿主保留可验证的离场实例；不伪造死亡事件或额外表现。可选择清理或保留本次执行的棋子状态。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `flowStatePolicy` | 状态处理 | `string` | 是 | 默认 cleanup；cleanup / preserve |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 pieces。

## 卡牌与能力

### 手牌实例引用

接口：`card.instance-reference@1`。

作者目录：原子语句。

从获得手牌或手牌选择器的实例结果取得带类型的引用，不按卡牌名称匹配。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | 手牌实例 | `record` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `card` | 手牌实例 | `record` | 是 |  |

执行声明：纯计算；读取 hand、execution-context。

### 获得手牌

接口：`author.card.gain@1`。

作者目录：原子语句。

先创建独立手牌并初始化扩展变量，再派发获得事件；手牌已满时按规则进入弃牌堆。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 玩家 | `player` | 是 |  |
| `card` | 卡牌 | `card` | 是 |  |
| `extension` | 初始扩展变量 | `record` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `extensionType` | 扩展变量类型 | `string` | 是 | 默认 record |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | 新手牌实例 | `record`（可空） | 是 |  |
| `success` | 已进入手牌区 | `boolean` | 是 |  |
| `placement` | 去向 | `string` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"extension":{"parameter":"extensionType"}}}`。

执行声明：写入 hand、extensions；事件 beforeCardAdded、afterCardAdded。

### 写入技能实例字段

接口：`author.skill-instance.write@1`。

作者目录：原子语句。

写入实际技能实例允许修改的运行字段；冷却沿用现有宿主入口，不替换技能标识或定义引用。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | 技能实例 | `record` | 是 |  |
| `value` | 数值 | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | currentCooldown / usesRemaining / level |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 写入成功 | `boolean` | 是 |  |

执行声明：读取 execution-context；写入 skills。

### 获得能力组

接口：`author.cluster.acquire@1`。

作者目录：原子语句。

按结构化能力组定义为指定棋子获得一组主动技能与规则，并返回本次能力组实例。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |
| `definition` | 能力组定义 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `definitionType` | 定义类型 | `string` | 是 | 默认 record |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `group` | 能力组实例 | `record` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"definition":{"parameter":"definitionType"}}}`。

执行声明：读取 pieces、skills、rules；写入 pieces、skills、rules。

### 获取能力组

接口：`author.cluster.list@1`。

作者目录：原子语句。

按棋子当前能力组实例顺序返回其已获得的能力组。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | 棋子 | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `groups` | 能力组实例元组 | `{"kind":"list","element":"record"}` | 是 |  |

执行声明：纯计算；读取 pieces。

### 移除能力组

接口：`author.cluster.remove@1`。

作者目录：原子语句。

按能力组实例身份移除其带入的Skill与Rule；其他能力组或基础成员仍由权威运行时保留。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `group` | 能力组实例 | `record` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `removed` | 是否移除 | `boolean` | 是 |  |

执行声明：读取 pieces、skills、rules；写入 pieces、skills、rules。

### 获得技能

接口：`skill.add@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `skillId` | skillId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 skills。

### 移除技能

接口：`skill.remove@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `skillId` | skillId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 skills。

### 技能定义

接口：`ref.skill-definition@1`。

作者目录：原子语句。

从内容库选择技能定义；此引用不代表已持有的技能实例，不能修改实例冷却或次数。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `skillId` | 技能 | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `skill` | 技能定义 | `content` | 是 |  |

执行声明：纯计算；读取 skills。

### 获得技能

接口：`skill.add@2`。

作者目录：原子语句。

为棋子或玩家调整技能；使用内容库中的技能定义引用，由既有生命周期处理实例与去重。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 对象 | `piece` | 是 |  |
| `skill` | 技能 | `content` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `ownerType` | 对象类型 | `string` | 是 | 默认 piece；piece / player |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 成功 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"owner":{"parameter":"ownerType"}}}`。

执行声明：写入 skills。

### 移除技能

接口：`skill.remove@2`。

作者目录：原子语句。

为棋子或玩家调整技能；使用内容库中的技能定义引用，由既有生命周期处理实例与去重。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `owner` | 对象 | `piece` | 是 |  |
| `skill` | 技能 | `content` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `ownerType` | 对象类型 | `string` | 是 | 默认 piece；piece / player |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | 成功 | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"owner":{"parameter":"ownerType"}}}`。

执行声明：写入 skills。

### 调整技能冷却

接口：`skill.adjust-cooldown@1`。

作者目录：原子语句。

通过技能生命周期按增加或至少设为两种语义调整已持有技能的冷却。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |
| `skillId` | skillId | `string`（可空） | 是 |  |
| `amount` | amount | `number` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `mode` | mode | `string` | 是 | add / atLeast |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 skills；事件 skillCooldownChanged。

### 复制卡牌定义

接口：`content.copy-card@1`。

作者目录：原子语句。

按来源卡牌标识复制已存在的动态卡牌定义；静态卡牌或缺少动态定义时沿用来源标识。复制序号只用于生成稳定的新标识，卡牌字段和模块图由宿主深复制并保持原样。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `sourceId` | 来源卡牌标识 | `string` | 是 | 内容库中已有卡牌或动态卡牌定义的标识。 |
| `index` | 复制序号 | `number` | 是 | 当前复制操作的非负整数序号。 |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `idPrefix` | 新卡牌标识前缀 | `string` | 是 | 生成动态卡牌标识时使用的前缀。；默认 content-copy- |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cardId` | 新卡牌标识 | `string` | 是 | 复制成功时生成的卡牌标识；静态来源复制失败时返回来源标识。 |
| `copied` | 是否复制成功 | `boolean` | 是 | 来源存在动态定义并完成深复制时为真。 |

执行声明：写入 content、hand；事件 contentCardCopied。

### 按模板创建卡牌

接口：`content.materialize-template@2`。

作者目录：原子语句。

以受信卡牌模板引用、结构化字段和结构化扩展创建动态卡牌定义；返回可直接交给“获得手牌”的卡牌定义引用，不接受源码或原始 JSON 文本。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `template` | 卡牌模板 | `content` | 是 | 从模板引用句式取得的受信卡牌模板。 |
| `cardId` | 生成卡牌标识 | `string` | 是 | 可由文本、编号或其他表达式动态生成。 |
| `name` | 卡牌名称 | `string` | 是 | 可由文本表达式动态生成。 |
| `description` | 卡牌说明 | `string` | 否 | 可由文本表达式动态生成；省略时为空。 |
| `owner` | 归属玩家 | `player`（可空） | 否 |  |
| `fields` | 模板字段 | `record` | 否 |  |
| `extension` | 初始扩展变量 | `record` | 否 |  |
| `omitFields` | 省略的展示字段 | `{"kind":"list","element":"string"}` | 否 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `fieldsType` | 字段结构类型 | `string` | 是 | 默认 record |
| `extensionType` | 扩展结构类型 | `string` | 是 | 默认 record |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `card` | 动态卡牌定义 | `card` | 是 |  |
| `success` | success | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"fields":{"parameter":"fieldsType"},"extension":{"parameter":"extensionType"}}}`。

执行声明：写入 content；事件 contentCardMaterialized。

### 弃置手牌实例

接口：`card.discard-instance@1`。

作者目录：原子语句。

通过现有卡牌生命周期按稳定实例标识弃置手牌并写入弃牌堆。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `card` | card | `string` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 hand、events；事件 cardDiscarded。

### 查询玩家手牌实例

接口：`card.hand-instances@1`。

作者目录：原子语句。

按当前手牌顺序返回稳定实例标识；不把可变卡牌对象暴露给作者图。可选卡牌定义标识用于受限筛选。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | player | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `cardId` | cardId | `string` | 否 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cards` | cards | `{"kind":"list","element":"string"}` | 是 |  |

执行声明：纯计算；读取 hand、players。

### 读取技能实例

接口：`skill.instances@1`。

作者目录：原子语句。

按棋子技能运行时顺序返回执行期间有效的技能实例句柄；相同技能定义的不同实例保持独立。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `piece` | piece | `piece` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instances` | instances | `{"kind":"list","element":"record"}` | 是 |  |
| `present` | present | `boolean` | 是 |  |

执行声明：读取 skills；写入 execution-context。

### 读取技能实例字段

接口：`skill.instance-field@1`。

作者目录：原子语句。

从同一执行期间保留的技能实例句柄读取登记字段；不按技能定义标识重新寻找实例。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | instance | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | skillId / kind / currentCooldown / definitionExists |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `skillId` | `{"kind":"nullable","value":"string"}` |
| `kind` | `{"kind":"nullable","value":"string"}` |
| `currentCooldown` | `{"kind":"nullable","value":"number"}` |
| `definitionExists` | `boolean` |

执行声明：纯计算；读取 execution-context、skills。

### 设定技能实例冷却

接口：`skill.set-instance-cooldown@1`。

作者目录：原子语句。

通过技能宿主写入已选实例的冷却值；不会按技能定义标识更新其他同名实例。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | instance | `record` | 是 |  |
| `value` | value | `number` | 是 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：读取 execution-context；写入 skills。

### 读取内容字段

接口：`content.field@1`。

作者目录：原子语句。

读取受信动态内容容器中的封闭记录；当前仅开放动态卡牌定义表。

允许入口：rule、card。

**输入**

无。

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | customCards |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `record`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

执行声明：纯计算；读取 content。

### 读取技能定义字段

接口：`skill.definition-field@1`。

作者目录：原子语句。

按技能标识读取登记的封闭技能定义字段；缺失和空值返回可空值。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `skillId` | skillId | `{"kind":"nullable","value":"string"}` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | momentumGainOnUse |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `boolean`（可空） | 是 |  |

执行声明：纯计算；读取 skills。

### 移除手牌实例字段

接口：`card.remove-field@1`。

作者目录：原子语句。

通过下面声明的类型端口调用宿主能力。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 玩家 | `player` | 是 |  |
| `card` | 手牌实例标识 | `string` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | contentState / effectModifiers / presentation / boundPieceInstanceId |
| `subfield` | 记录字段 | `string` | 否 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 hand、content、presentation。

### 手牌实例字段赋值

接口：`card.write-field@1`。

作者目录：原子语句。

只修改指定玩家的一个手牌实例，同名的其他手牌保持独立。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | 玩家 | `player` | 是 |  |
| `card` | 手牌实例标识 | `string` | 是 |  |
| `value` | 值 | `record` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | 字段 | `string` | 是 | contentState / effectModifiers / presentation / boundPieceInstanceId |
| `subfield` | 记录字段 | `string` | 否 |  |
| `valueType` | 值类型 | `string` | 是 | 默认 record |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

值类型由类型选择器确定（表中的 record 是注册表占位类型）：`{"inputs":{"value":{"parameter":"valueType"}}}`。

执行声明：写入 hand、content、presentation。

### 读取手牌记录

接口：`card.hand-records@1`。

作者目录：原子语句。

按权威手牌顺序读取不可变卡牌记录，并显式报告手牌是否存在。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | player | `player`（可空） | 否 |  |

**参数**

无。

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `cards` | cards | `{"kind":"list","element":"record"}` | 是 |  |
| `hasHand` | hasHand | `boolean` | 是 |  |

执行声明：纯计算；读取 hand、players。

### 读取卡牌实例字段

接口：`card.instance-field@1`。

作者目录：原子语句。

从手牌实例记录读取封闭字段；字段类型由登记表决定，缺失通过 defined 端口保留。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `card` | card | `record`（可空） | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | cardId / instanceId / name / boundPieceInstanceId / contentState / extension |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |
| `defined` | defined | `boolean` | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `cardId` | `string` |
| `instanceId` | `string` |
| `name` | `{"kind":"nullable","value":"string"}` |
| `boundPieceInstanceId` | `{"kind":"nullable","value":"piece"}` |
| `contentState` | `{"kind":"nullable","value":"record"}` |
| `extension` | `{"kind":"nullable","value":"record"}` |

执行声明：纯计算；读取 hand、content。

### 读取卡牌定义字段

接口：`card.definition-field@1`。

作者目录：原子语句。

读取手牌实例对应的封闭卡牌定义标识或名称；不解析动态对象路径。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `card` | card | `record`（可空） | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | id / name |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `id` | `string` |
| `name` | `{"kind":"nullable","value":"string"}` |

执行声明：纯计算；读取 hand、content。

### 读取卡牌内容字段

接口：`card.content-field@1`。

作者目录：原子语句。

读取登记过的卡牌内容字段；结构化预言记录与布尔声明保持各自类型。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `record` | record | `record`（可空） | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `field` | field | `string` | 是 | velenHolyProphecy / velenHolyProphecyEnhanced / sourcePieceId / createdTurnNumber |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | value | `unknown`（可空） | 是 |  |

选择字段后，输出类型随之变化：

| 字段 | 输出类型 |
| --- | --- |
| `velenHolyProphecy` | `{"kind":"nullable","value":"record"}` |
| `velenHolyProphecyEnhanced` | `boolean` |
| `sourcePieceId` | `{"kind":"nullable","value":"string"}` |
| `createdTurnNumber` | `{"kind":"nullable","value":"number"}` |

执行声明：纯计算；读取 content。

### 加入手牌

接口：`card.hand-add@1`。

作者目录：原子语句。

沿用卡牌实例化、容量和事件处理加入指定玩家手牌。

允许入口：skill、card、rule、triggerSkill、pending。

**输入**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `player` | player | `player` | 是 |  |

**参数**

| 名称 | 含义 | 类型 | 必填 | 默认值 / 可选值 |
| --- | --- | --- | --- | --- |
| `cardId` | cardId | `string` | 是 |  |

**输出**

| 名称 | 含义 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `success` | success | `boolean` | 是 |  |

执行声明：写入 hand、events；事件 cardAdded。
