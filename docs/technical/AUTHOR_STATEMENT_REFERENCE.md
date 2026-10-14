# 作者语句接口参考索引

更新：2026-10-12。本文是[作者语句使用手册](AUTHOR_STATEMENT_MANUAL.md)的覆盖索引。覆盖口径是[作者语句接口目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md)第 1–10 节中的表格数据行：共 **105/105** 条；表头（包括第 1 节的“类别”表头）、说明段落和后续历史讨论不另重复计数。每行都链接到手册中的独立 anchor，并链接目录原始分组与公共接口来源。

`设计-确认` 表示能力/该行契约已经明确，但不表示编辑器或引擎已实现；`设计-部分` 表示已有讨论但签名、返回值或边界仍缺；`设计-待定` 表示只保留讨论草案，不能当作现成模块；`组织建议` 表示编辑器分类建议。当前工作台实际模块注册、保存和运行支持请看手册开头的[工作台入口说明](AUTHOR_STATEMENT_MANUAL.md#workbench-start)。

## 覆盖与来源

| 目录分组 | 目录原文 | 交叉规格 |
| --- | --- | --- |
| 组织 | [第 1 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#1-积木组织建议) | [公共接口](SKILL_MODULE_INTERFACES.md) |
| 类型/变量 | [第 2 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) | [公共接口](SKILL_MODULE_INTERFACES.md)、[实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |
| 运算/容器/控制 | [第 3 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) | [公共接口](SKILL_MODULE_INTERFACES.md) |
| 查询/选择 | [第 4 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) | [公共接口](SKILL_MODULE_INTERFACES.md) |
| 战斗效果 | [第 5 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) | [公共接口](SKILL_MODULE_INTERFACES.md) |
| 空间/召唤/显示 | [第 6 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) | [公共接口](SKILL_MODULE_INTERFACES.md) |
| 手牌/Cluster | [第 7 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#7-手牌与-cluster) | [公共接口](SKILL_MODULE_INTERFACES.md)、[实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |
| 结果/上下文 | [第 8 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#8-结果结构与上下文) | [公共接口](SKILL_MODULE_INTERFACES.md) |
| 入口/Rule | [第 9 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#9-入口与-rule-声明) | [公共接口](SKILL_MODULE_INTERFACES.md) |
| 可写字段 | [第 10 节](AUTHOR_BLOCK_INTERFACE_CATALOG.md#10-可写字段与引擎责任) | [公共接口](SKILL_MODULE_INTERFACES.md)、[实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |

当前内容组合的例证来源包括[圣盾公共草案](PALADIN_SHIELD_AUTHORING_DRAFT.md)、[批次 06 公共模块示例](AUTHORING_BATCH_06.md)、[飞段血誓](HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md)、[共生拖行](VENOM_DRAG_AUTHORING_DRAFT.md)、[宿主转移](VENOM_HOST_TRANSFER_AUTHORING_DRAFT.md)、[恶魔仪式](DEMONIC_RITUAL_AUTHORING_DRAFT.md)、[维伦预言](VELEN_PROPHECY_AUTHORING_DRAFT.md)和[作者草案总索引](AUTHORING_DRAFT_INDEX.md)。这些文档中的“待运行验证/待实施”必须保留，不因本索引收录而升级为可用。

## 1. 组织积木（6 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 1 | 入口 | 组织建议 | [入口分类](AUTHOR_STATEMENT_MANUAL.md#stmt-org-entry) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#1-积木组织建议) / [接口](SKILL_MODULE_INTERFACES.md) |
| 2 | 执行语句 | 组织建议 | [执行分类](AUTHOR_STATEMENT_MANUAL.md#stmt-org-effect) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#1-积木组织建议) / [接口](SKILL_MODULE_INTERFACES.md) |
| 3 | 值表达式 | 组织建议 | [值分类](AUTHOR_STATEMENT_MANUAL.md#stmt-org-value) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#1-积木组织建议) / [接口](SKILL_MODULE_INTERFACES.md) |
| 4 | 布尔表达式 | 组织建议 | [布尔分类](AUTHOR_STATEMENT_MANUAL.md#stmt-org-bool) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#1-积木组织建议) / [接口](SKILL_MODULE_INTERFACES.md) |
| 5 | 控制结构 | 组织建议 | [控制分类](AUTHOR_STATEMENT_MANUAL.md#stmt-org-control) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#1-积木组织建议) / [接口](SKILL_MODULE_INTERFACES.md) |
| 6 | 定义与声明 | 组织建议 | [定义分类](AUTHOR_STATEMENT_MANUAL.md#stmt-org-definition) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#1-积木组织建议) / [接口](SKILL_MODULE_INTERFACES.md) |

## 2. 类型与变量（15 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 7 | 基础值 | 设计-确认 | [基础值](AUTHOR_STATEMENT_MANUAL.md#stmt-type-base) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 8 | 场上引用 | 设计-确认 | [场上引用](AUTHOR_STATEMENT_MANUAL.md#stmt-type-board) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 9 | 内容定义 | 设计-确认 | [内容定义](AUTHOR_STATEMENT_MANUAL.md#stmt-type-definition) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 10 | 运行实例 | 设计-部分 | [运行实例](AUTHOR_STATEMENT_MANUAL.md#stmt-type-instance) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |
| 11 | 几何值 | 设计-确认 | [几何值](AUTHOR_STATEMENT_MANUAL.md#stmt-type-geometry) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 12 | 结果结构 | 设计-部分 | [结果结构](AUTHOR_STATEMENT_MANUAL.md#stmt-type-result) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 13 | 泛型容器 | 设计-确认 | [泛型容器](AUTHOR_STATEMENT_MANUAL.md#stmt-type-container) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 14 | 自定义值 | 设计-部分 | [自定义值](AUTHOR_STATEMENT_MANUAL.md#stmt-type-custom) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 15 | `新建【T】变量【名称】 = 值` | 设计-确认 | [新建局部变量](AUTHOR_STATEMENT_MANUAL.md#stmt-var-local-new) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 16 | `变量 = 值` | 设计-确认 | [局部赋值](AUTHOR_STATEMENT_MANUAL.md#stmt-var-assign) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 17 | `在【对象.extension】中新建【T】变量【名称】 = 初值` | 设计-确认 | [声明 extension 字段](AUTHOR_STATEMENT_MANUAL.md#stmt-var-extension-declare) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 18 | `对象.extension.名称 = 值` | 设计-确认 | [写 extension 字段](AUTHOR_STATEMENT_MANUAL.md#stmt-var-extension-write) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 19 | `对象.字段` | 设计-确认 | [读取字段](AUTHOR_STATEMENT_MANUAL.md#stmt-field-read) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 20 | `对象.字段 = 值` | 设计-部分 | [字段写入总则](AUTHOR_STATEMENT_MANUAL.md#stmt-field-write) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [接口](SKILL_MODULE_INTERFACES.md) |
| 21 | 结构体构造 | 设计-确认 | [结构体构造](AUTHOR_STATEMENT_MANUAL.md#stmt-struct-constructor) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#2-类型与变量) / [实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |

## 3. 运算、容器与控制（25 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 22 | 算术、比较、逻辑 | 设计-部分 | [算术/比较/逻辑](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-arithmetic) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 23 | 条件取值 | 设计-确认 | [条件取值](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-conditional) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 24 | `距离(a,b)` | 设计-部分 | [距离](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-distance) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 25 | `筛选` | 设计-确认 | [筛选](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-filter) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 26 | `排序` | 设计-确认 | [排序（依据值）](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-sort-key) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 27 | `排序` 比较器重载 | 设计-部分 | [排序（比较器）](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-sort-comparator) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 28 | `随机排序` | 设计-部分 | [随机排序](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-random-sort) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 29 | `随机选择` | 设计-部分 | [随机选择](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-random-select) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 30 | `获取前若干项` | 设计-部分 | [获取前若干项](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-take) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 31 | `获取长度` | 设计-确认 | [获取长度](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-length) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 32 | `元组[n]` / `映射[键]` | 设计-确认 | [容器取项](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-index-map-read) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 33 | `加入集合` / `移除集合元素` | 设计-确认 | [Set 写入](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-set-mut) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 34 | `容器包含元素`（旧称集合包含元素） | 设计-确认 | [包含元素](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-contains) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 35 | `追加元组` | 设计-确认 | [追加元组](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-tuple-append) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 36 | 元组插入/删除 | 设计-部分 | [元组插入/删除](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-tuple-edit) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 37 | `映射[键] = 值` | 设计-确认 | [映射写入](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-map-write) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 38 | `映射包含键` / `删除映射项` | 设计-部分 | [映射管理](AUTHOR_STATEMENT_MANUAL.md#stmt-expr-map-management) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 39 | `如果…否则…` | 设计-确认 | [条件分支](AUTHOR_STATEMENT_MANUAL.md#stmt-control-if) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 40 | `遍历【容器】中的每一项【变量】` | 设计-部分 | [遍历](AUTHOR_STATEMENT_MANUAL.md#stmt-control-foreach) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 41 | `当【条件】成立时循环` | 设计-部分 | [while 循环](AUTHOR_STATEMENT_MANUAL.md#stmt-control-while) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 42 | 跳出/继续循环 | 设计-部分 | [循环控制](AUTHOR_STATEMENT_MANUAL.md#stmt-control-break-continue) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 43 | `结束` / 裸 `return` | 设计-确认 | [结束/裸 return](AUTHOR_STATEMENT_MANUAL.md#stmt-control-return) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 44 | `返回 使用失败(原因)` | 设计-确认 | [使用失败](AUTHOR_STATEMENT_MANUAL.md#stmt-control-fail) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 45 | `返回 使用成功` | 设计-确认 | [使用成功](AUTHOR_STATEMENT_MANUAL.md#stmt-control-success) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |
| 46 | `阻止当前事件` | 设计-确认 | [阻止当前事件](AUTHOR_STATEMENT_MANUAL.md#stmt-control-block) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#3-运算容器与控制) / [接口](SKILL_MODULE_INTERFACES.md) |

## 4. 查询与玩家选择（13 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 47 | 类型 | 设计-确认 | [选择器类型](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-type) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [最新 StatusTag 选择](AUTHOR_BLOCK_INTERFACE_CATALOG.md#选择实际状态实例用户已确认) / [接口](SKILL_MODULE_INTERFACES.md) |
| 48 | 筛选条件 | 设计-确认 | [筛选条件](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-filter) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 49 | 范围/中心 | 设计-部分 | [范围/中心](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-range) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 50 | 方式 | 设计-确认 | [选择方式](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-mode) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 51 | 候选集合 | 设计-确认 | [候选集合](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-candidates) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 52 | 可见玩家 | 设计-部分 | [可见玩家](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-visible) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 53 | 忽略占用棋子 | 设计-部分 | [忽略占用](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-ignore-occupant) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 54 | 允许取消 | 设计-确认 | [允许取消](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-cancel) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 55 | 选项选择器 | 设计-部分 | [选项选择器](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-option) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 56 | 获取状态 | 设计-确认 | [获取状态](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-status-list) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 57 | 获取状态强度 | 设计-部分 | [获取状态强度](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-status-strength) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 58 | 获取下一位玩家 | 设计-部分 | [获取下一位玩家](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-next-player) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |
| 59 | 查询路径 | 设计-部分 | [查询路径](AUTHOR_STATEMENT_MANUAL.md#stmt-selector-path) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#4-查询与玩家选择) / [接口](SKILL_MODULE_INTERFACES.md) |

## 5. 战斗效果（8 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 60 | 造成伤害 | 设计-确认 | [造成伤害](AUTHOR_STATEMENT_MANUAL.md#stmt-effect-damage) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) / [接口](SKILL_MODULE_INTERFACES.md) / [批次 06](AUTHORING_BATCH_06.md) |
| 61 | 消灭 | 设计-确认 | [消灭](AUTHOR_STATEMENT_MANUAL.md#stmt-effect-eliminate) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) / [接口](SKILL_MODULE_INTERFACES.md) / [血誓](HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md) |
| 62 | 恢复生命 | 设计-确认 | [恢复生命](AUTHOR_STATEMENT_MANUAL.md#stmt-effect-heal) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) / [接口](SKILL_MODULE_INTERFACES.md) |
| 63 | 调整资源 | 设计-部分 | [调整资源](AUTHOR_STATEMENT_MANUAL.md#stmt-effect-resource) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) / [接口](SKILL_MODULE_INTERFACES.md) |
| 64 | 附加状态 | 设计-部分 | [附加状态](AUTHOR_STATEMENT_MANUAL.md#stmt-effect-add-status) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) / [接口](SKILL_MODULE_INTERFACES.md) / [圣盾](PALADIN_SHIELD_AUTHORING_DRAFT.md) |
| 65 | 移除状态 | 设计-部分 | [移除状态](AUTHOR_STATEMENT_MANUAL.md#stmt-effect-remove-status) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) / [接口](SKILL_MODULE_INTERFACES.md) / [批次 06](AUTHORING_BATCH_06.md) |
| 66 | 附加规则 | 设计-确认 | [附加规则](AUTHOR_STATEMENT_MANUAL.md#stmt-effect-add-rule) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) / [实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |
| 67 | 移除规则 | 设计-部分 | [移除规则](AUTHOR_STATEMENT_MANUAL.md#stmt-effect-remove-rule) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#5-战斗效果) / [实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |

## 6. 空间、召唤与显示（12 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 68 | 普通移动 | 设计-部分 | [普通移动](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-move) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) / [共生拖行](VENOM_DRAG_AUTHORING_DRAFT.md) |
| 69 | 位移 | 设计-部分 | [位移](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-displace) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) / [宿主转移](VENOM_HOST_TRANSFER_AUTHORING_DRAFT.md) |
| 70 | 召唤：模板创建 | 设计-部分 | [模板召唤](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-summon-template) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) |
| 71 | 召唤：原实例入场 | 设计-部分 | [原实例入场](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-summon-existing) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) / [恶魔仪式](DEMONIC_RITUAL_AUTHORING_DRAFT.md) |
| 72 | 出局 | 设计-部分 | [出局](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-eliminate) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) |
| 73 | 设置棋子显示 | 设计-部分 | [棋子显示](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-piece-display) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) |
| 74 | 创建区域 | 设计-部分 | [创建区域](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-create-zone) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) |
| 75 | 移除区域 | 设计-部分 | [移除区域](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-remove-zone) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) |
| 76 | 设置区域显示 | 设计-确认 | [区域显示](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-zone-display) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) |
| 77 | 复制手牌到手牌区 | 设计-部分 | [复制手牌](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-copy-card) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) / [作者批次 05](AUTHORING_BATCH_05.md) |
| 78 | 复制实例 / 应用实例信息 | 设计-部分 | [复制/应用快照](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-copy-apply) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) / [回溯草案](RECALL_AUTHORING_DRAFT.md) |
| 79 | 设置上场顺序 | 设计-部分 | [设置上场顺序](AUTHOR_STATEMENT_MANUAL.md#stmt-spatial-order) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#6-空间召唤与显示) / [接口](SKILL_MODULE_INTERFACES.md) |

## 7. 手牌与 Cluster（5 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 80 | 获得手牌 | 设计-确认 | [获得手牌](AUTHOR_STATEMENT_MANUAL.md#stmt-card-gain) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#7-手牌与-cluster) / [接口](SKILL_MODULE_INTERFACES.md) / [作者批次 05](AUTHORING_BATCH_05.md) |
| 81 | 弃置手牌 | 设计-部分 | [弃置手牌](AUTHOR_STATEMENT_MANUAL.md#stmt-card-discard) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#7-手牌与-cluster) / [接口](SKILL_MODULE_INTERFACES.md) |
| 82 | 添加标签 / 移除标签 | 设计-部分 | [手牌标签](AUTHOR_STATEMENT_MANUAL.md#stmt-card-tags) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#7-手牌与-cluster) / [接口](SKILL_MODULE_INTERFACES.md) / [维伦预言](VELEN_PROPHECY_AUTHORING_DRAFT.md) |
| 83 | 获得技能 | 设计-部分 | [获得 Cluster](AUTHOR_STATEMENT_MANUAL.md#stmt-card-gain-cluster) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#7-手牌与-cluster) / [接口](SKILL_MODULE_INTERFACES.md) / [实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |
| 84 | 移除技能 | 设计-部分 | [移除 Cluster](AUTHOR_STATEMENT_MANUAL.md#stmt-card-remove-cluster) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#7-手牌与-cluster) / [接口](SKILL_MODULE_INTERFACES.md) / [实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |

## 8. 结果结构与上下文（7 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 85 | 伤害结果 | 设计-确认 | [伤害结果](AUTHOR_STATEMENT_MANUAL.md#stmt-result-damage) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#8-结果结构与上下文) / [接口](SKILL_MODULE_INTERFACES.md) |
| 86 | 治疗结果 | 设计-确认 | [治疗结果](AUTHOR_STATEMENT_MANUAL.md#stmt-result-heal) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#8-结果结构与上下文) / [接口](SKILL_MODULE_INTERFACES.md) |
| 87 | 位移结果 | 设计-确认 | [位移结果](AUTHOR_STATEMENT_MANUAL.md#stmt-result-displacement) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#8-结果结构与上下文) / [接口](SKILL_MODULE_INTERFACES.md) |
| 88 | 路径查询结果 | 设计-确认 | [路径查询结果](AUTHOR_STATEMENT_MANUAL.md#stmt-result-path) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#8-结果结构与上下文) / [接口](SKILL_MODULE_INTERFACES.md) |
| 89 | 当前回合 | 设计-确认 | [当前回合](AUTHOR_STATEMENT_MANUAL.md#stmt-context-turn) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#8-结果结构与上下文) / [接口](SKILL_MODULE_INTERFACES.md) |
| 90 | 当前事件 | 设计-部分 | [当前事件](AUTHOR_STATEMENT_MANUAL.md#stmt-context-event) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#8-结果结构与上下文) / [接口](SKILL_MODULE_INTERFACES.md) |
| 91 | 当前规则 | 设计-部分 | [当前规则](AUTHOR_STATEMENT_MANUAL.md#stmt-context-rule) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#8-结果结构与上下文) / [实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |

## 9. 入口与 Rule 声明（7 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 92 | 开局/回合 | 设计-部分 | [开局/回合](AUTHOR_STATEMENT_MANUAL.md#stmt-entry-turn) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#9-入口与-rule-声明) / [接口](SKILL_MODULE_INTERFACES.md) |
| 93 | 使用 | 设计-部分 | [使用入口](AUTHOR_STATEMENT_MANUAL.md#stmt-entry-use) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#9-入口与-rule-声明) / [接口](SKILL_MODULE_INTERFACES.md) |
| 94 | 目标指定 | 设计-部分 | [目标指定](AUTHOR_STATEMENT_MANUAL.md#stmt-entry-target) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#9-入口与-rule-声明) / [接口](SKILL_MODULE_INTERFACES.md) |
| 95 | 伤害 | 设计-部分 | [伤害入口](AUTHOR_STATEMENT_MANUAL.md#stmt-entry-damage) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#9-入口与-rule-声明) / [接口](SKILL_MODULE_INTERFACES.md) |
| 96 | 死亡/击杀/离场 | 设计-部分 | [死亡/击杀/离场](AUTHOR_STATEMENT_MANUAL.md#stmt-entry-death) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#9-入口与-rule-声明) / [接口](SKILL_MODULE_INTERFACES.md) |
| 97 | 空间/召唤 | 设计-部分 | [空间/召唤](AUTHOR_STATEMENT_MANUAL.md#stmt-entry-spatial) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#9-入口与-rule-声明) / [接口](SKILL_MODULE_INTERFACES.md) |
| 98 | 状态 | 设计-部分 | [状态入口](AUTHOR_STATEMENT_MANUAL.md#stmt-entry-status) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#9-入口与-rule-声明) / [接口](SKILL_MODULE_INTERFACES.md) |

## 10. 可写字段与引擎责任（7 条）

| # | 目录条目 | 状态 | 手册 | 来源 |
| ---: | --- | --- | --- | --- |
| 99 | `状态.强度 = 数值` | 设计-确认 | [状态强度写入](AUTHOR_STATEMENT_MANUAL.md#stmt-write-status-strength) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#10-可写字段与引擎责任) / [接口](SKILL_MODULE_INTERFACES.md) |
| 100 | `Skill实例.当前冷却 = 数值` | 设计-确认 | [Skill 冷却写入](AUTHOR_STATEMENT_MANUAL.md#stmt-write-skill-cooldown) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#10-可写字段与引擎责任) / [实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |
| 101 | `棋子.所属玩家 = 玩家` | 设计-部分 | [所属玩家写入](AUTHOR_STATEMENT_MANUAL.md#stmt-write-owner) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#10-可写字段与引擎责任) / [接口](SKILL_MODULE_INTERFACES.md) |
| 102 | `区域.地格 = 元组<地格>` | 设计-部分 | [区域地格写入](AUTHOR_STATEMENT_MANUAL.md#stmt-write-zone-cells) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#10-可写字段与引擎责任) / [接口](SKILL_MODULE_INTERFACES.md) |
| 103 | `地格.地形 = 地形定义` | 设计-部分 | [地形写入](AUTHOR_STATEMENT_MANUAL.md#stmt-write-terrain) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#10-可写字段与引擎责任) / [接口](SKILL_MODULE_INTERFACES.md) |
| 104 | `当前事件.局部变量.名称 = 值` | 设计-部分 | [事件局部变量写入](AUTHOR_STATEMENT_MANUAL.md#stmt-write-event-local) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#10-可写字段与引擎责任) / [接口](SKILL_MODULE_INTERFACES.md) |
| 105 | `当前事件.伤害量 = 数值` | 设计-部分 | [事件伤害量写入](AUTHOR_STATEMENT_MANUAL.md#stmt-write-event-damage) | [目录](AUTHOR_BLOCK_INTERFACE_CATALOG.md#10-可写字段与引擎责任) / [接口](SKILL_MODULE_INTERFACES.md) |

## 按作者任务查找

| 目标 | 先看 | 再核对 |
| --- | --- | --- |
| 新手从编辑器写一个效果 | [工作台入口](AUTHOR_STATEMENT_MANUAL.md#workbench-start)、[火球 walkthrough](AUTHOR_STATEMENT_MANUAL.md#walkthrough-fireball) | [公共接口](SKILL_MODULE_INTERFACES.md) |
| 伤害/治疗/消灭 | [战斗效果](AUTHOR_STATEMENT_MANUAL.md#section-effects) | [批次 06](AUTHORING_BATCH_06.md)、[血誓](HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md) |
| 状态、Rule、状态快照 | [状态入口](AUTHOR_STATEMENT_MANUAL.md#stmt-entry-status)、[状态 walkthrough](AUTHOR_STATEMENT_MANUAL.md#walkthrough-status) | [圣盾](PALADIN_SHIELD_AUTHORING_DRAFT.md)、[公共接口](SKILL_MODULE_INTERFACES.md) |
| 最新尾部决定 | [补充决定](AUTHOR_STATEMENT_MANUAL.md#latest-decisions) | [目录尾部](AUTHOR_BLOCK_INTERFACE_CATALOG.md#普通移动提交时用户已确认)、[公共接口最新决定](SKILL_MODULE_INTERFACES.md#状态剩余持续时间直接写入用户已确认) |
| 位移、召唤、回溯 | [空间接口](AUTHOR_STATEMENT_MANUAL.md#section-spatial) | [宿主转移](VENOM_HOST_TRANSFER_AUTHORING_DRAFT.md)、[恶魔仪式](DEMONIC_RITUAL_AUTHORING_DRAFT.md)、[回溯](RECALL_AUTHORING_DRAFT.md) |
| 手牌和 Cluster | [手牌/Cluster](AUTHOR_STATEMENT_MANUAL.md#section-cards) | [作者批次 05](AUTHORING_BATCH_05.md)、[实例类型](AUTHOR_INSTANCE_TYPES_DRAFT.md) |

### 当前风险与未决项

本索引不替代运行验收。选择器完整重载、状态多实例聚合/批量返回、批量位移竞争、召唤模板失败契约、Cluster 重复获得、复制深度、循环上限/超限处置、事件载荷和数值修正字段扩展仍有未决边界。遇到这些情况应在内容草案中标记“待定”，不要把历史写法直接升级为公共模块。
