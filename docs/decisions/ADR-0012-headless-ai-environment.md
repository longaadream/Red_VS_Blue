# ADR-0012：版本化无头 AI 战斗环境

状态：提议中
日期：2026-08-20
关联任务：[RED-84](https://linear.app/redvsblue/issue/RED-84/前置建立供通用-ai-使用的无头确定性战斗环境接口)
风险：Medium

## 背景

旧 `lib/game/ai.ts` 只为当前机器人挑选少量动作，并包含“优先攻击、靠近最近敌人”等战术。它不是可供搜索、批量模拟或训练工具消费的环境接口，也不能表达完整 option/target 组合、隔离 transition、观察权限和稳定去重键。

规则真源已经分别存在于 `prepareAction()`、普通移动查询、`runBattleAction()`、Action Trace、确定性 `RuleRuntime` 和 `terminalResult`。新接口必须组合这些真源，不能另写技能范围、费用、随机结果或胜负公式。

## 决策

1. 提供 `AI_ENVIRONMENT_PROTOCOL_VERSION = 1` 与单一 `aiEnvironmentV1`，暴露 `observe`、`listLegalActions`、`simulate`、`isTerminal` 和 `stateKey`。
2. `observe` 返回显式投影，不返回 `BattleState`：对手手牌只有数量；隐藏 statusTag、Rule/effect 函数、`extensions`、Action Trace、私有部署选择和其他玩家 pending 内容均不暴露。
3. 主动技能和卡牌从草稿开始反复调用 `prepareAction()`，把每个 option/target 笛卡尔组合展开为可直接提交的完整命令。普通移动只消费 `getLegalNormalMoveTargetsForPlayer()`。
4. 候选按固定类别 rank，再按稳定 JSON 排序；候选 ID 是协议版本和完整动作的稳定 hash。输入数组顺序、文件系统遍历顺序或对象插入顺序不得成为 tie-breaker。
5. `simulate` 只调用正式 `runBattleAction()` 的同步隔离适配器。适配器在 `finally` 恢复模块级 TriggerSystem 注册表和事件序号；调用方输入状态、正式随机 checkpoint、规则 limits 和房间存储不发生提交。
6. transition 返回正式状态 hash、稳定 transition hash、Action Trace、动作日志增量和结构化状态 diff。非法动作返回稳定错误与空 diff，不伪装成成功 no-op。
7. `deploymentTimeout`、`grantChargePoints` 和 `surrender` 在 v1 中明确列为非战术候选：前两者属于权威/调试命令，投降属于比赛控制。它们仍可由正式规则入口处理，但环境候选枚举失败关闭。
8. Node 与浏览器 bundle 导出同一个环境实现。接口不读取网络、DOM、数据库、系统时间或房间存储；没有显式 root seed 或初始化 trace seed 时，模拟以 `AI_ENV_ROOT_SEED_REQUIRED` 拒绝。

## 备选方案

### 在 AI 中复制规则

不采用。费用、距离、目标、触发器和随机效果会与正式规则漂移，也无法覆盖数据驱动代码。

### 对每个格子执行 reducer dry-run 来找候选

不采用。查询会执行效果和触发器，扩大状态污染面；RED-59 已提供无副作用精确候选。

### 直接把完整 BattleState 作为 observation

不采用。它会泄露对手手牌、私有部署输入、运行时函数和调试 trace，并把内部状态格式误当成 AI 公共协议。

### 让 AI 环境保存房间或广播模拟结果

不采用。环境只负责观察和隔离计算；权威提交仍属于房间命令服务。

## 影响

- 通用 AI、搜索器和离线批量工具获得同一 browser-safe 规则入口。
- 候选数量可能因多阶段组合显著增加；v1 保存测量基线，不引入未经测量的缓存或截断。
- TriggerSystem 仍是进程级同步对象；隔离适配器只适用于同步规则执行。未来异步规则必须先建立请求级 runtime/trigger 上下文。
- v1 observation 是新增协议，不改变 `BattleState._v`、存档、玩法数据或网络协议。

## 验证方式

- 最小状态覆盖移动、基础/充能技能、零费用卡、阶段推进、endTurn、部署和 pending 恢复。
- 真实 `naruto-shadow-clone` 与 `illidan-metamorphosis` fixture 覆盖召唤、option/target 和变身。
- 固定 seed 重复模拟比较 transition hash、Action Trace、输入状态和 TriggerSystem 快照。
- 观察投影断言不含对手卡牌 ID、隐藏状态、Rule/effect、debug trace 或私有 pending。
- 生成 browser bundle 后在相同 fixture 比较候选顺序和 transition hash。
- 执行聚焦 Vitest、完整测试、TypeScript、ESLint、编码检查、`build:game-engine` 与 `git diff --check`。

## 回退方式

整体 revert RED-84 的接口、隔离适配器、测试、文档和浏览器生成物。没有存档、网络、玩法数据或随机算法迁移需要逆向转换。

## 相关资料

- [无头 AI 环境接口](../technical/AI_ENVIRONMENT.md)
- [ADR-0004：确定性规则运行时](./ADR-0004-deterministic-rule-runtime.md)
- [ADR-0005：权威目标选择](./ADR-0005-authoritative-target-selection.md)
- [游戏逻辑系统](../technical/GAME_LOGIC_SYSTEM.md)
