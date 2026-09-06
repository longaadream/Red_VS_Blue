# RED-189 验证记录

任务：https://linear.app/redvsblue/issue/RED-189/重做鸣人带土古尔丹与末日铁拳以适配渐进部署

分支：codex/RED-189-progressive-roster；基线 main e7d47cd1b3598237e04752cc77306264babf1deb。

## 自动验证

- `npm.cmd test -- --no-file-parallelism tests/game/red-189-roster.test.ts tests/game/progressive-deployment.test.ts tests/game/red-129-data-contract.test.ts tests/game/red-129-complex-skills.test.ts tests/game/mangekyo.test.ts tests/game/red-174-skill-landings.test.ts`：6 个文件、77 项通过。覆盖镜像鸣人先锋、相同种子、通用优先模板、玩家裂魂预备区/上场/死亡、整批死亡与强制移除、传送候选与非法提交、取消前不消费、旧位移以及铁拳倍率。
- 初次并行扩展测试出现 Windows `resource-pack/active.json` 初始化 rename EPERM；多测试文件同时写共享资源配置。串行运行隔离该已定位的文件争用，未删除断言或重试掩盖失败。
- `npm.cmd run typecheck`：通过。
- `node scripts/audit-skillcode-compat.mjs`：无语法错误、无未分类脚本字段。
- `npm.cmd run check:encoding`：通过。
- `npm.cmd run check:main-baseline`：通过，Ahead 0 / Behind 0，本地修改尚未提交。

## 已知限制

完整 lint 仍为 1517 errors / 2 warnings，与同一基线独立工作树此前复现结果相同。AI semantics 审计仍有 8 项既有问题：三个 manifest hash 不一致，以及 shadow-ride-sweep、tails-twin-flight、tails-armor-assembly、rule-tails-flight-resolve、rule-tails-flight-reservation-block 缺少声明。本次为新增传送记录 metadata-required，未批量准入这些无关内容。

独立 AI 审查发现传送预留格在候选与执行不一致，已增加通用地格效果排除声明，补齐 pending 会话字段传播，并覆盖普通与 pending 候选及提交回归断言。未运行 Electron 人工冒烟，未提交、合并或发布。

日志目录：`logs/red189/`（本地忽略文件）。

## 用户文案审核修订

率先出阵改为“当阵容中有鸣人时，鸣人首先上场。”；裂魂改为“游戏开始时，在本局游戏中每当一个棋子死亡，获得一张灵魂残片。”。神威保留原描述开头“万花筒。”。通用优先池已支持多个优先角色仅抽取一个，新增 8 个固定种子、双方阵容、同种子重现及其余优先角色留在预备区的回归。`npm.cmd test -- --no-file-parallelism tests/game/red-189-roster.test.ts`：17 项通过。

## 鸣人打坐追加简化

用户批准移除一次免伤，保留奖励。naruto-sage-mode 不再授予仙人之盾或挂载免伤规则；描述、预览、日志同步，奖励明确为3 AP和1 CP。原打坐限制、倒计时、分身加速与旧局兼容规则保留。新增真实执行回归验证首次受伤扣血、打坐结束移除状态、奖励数量保持；RED-189专项18项通过。

## PR 提交前验证

2026-09-07：最终六文件77项测试及编码检查通过；最终实现typecheck通过，独立审查无未解决意见。交付前主线刷新两次失败（连接重置与GitHub 443连接失败），此前已通过的基线为e7d47cd1b3598237e04752cc77306264babf1deb，不能用此前结果声称当前远端无更新。

网络恢复后通过用户指定的本机7890代理重新执行main-baseline：通过，origin/main仍为e7d47cd1b3598237e04752cc77306264babf1deb，Behind 0。上述网络失败为历史记录，当前基线刷新阻塞已解除。
